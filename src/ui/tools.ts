// Build tools. One-finger gestures (or left mouse) drive the active tool; the
// tool shows a live 3D preview (sim dry-run for cost / validity) and, when the
// gesture ends, a pending action that the player must confirm (✓ / ✗).

import * as THREE from 'three';
import { ENTRANCE_PLAZA, MAP_H, MAP_W, TILE, WATER_LEVEL } from '../core/constants';
import type { ICreatureFactory, IPropsLayer, IRenderContext, ISimulation, SpeciesSuitability } from '../core/contracts';
import type { TileRect } from '../core/events';
import { PathType, Terrain, type CommandResult, type StaffRole, type Tool } from '../core/types';
import type { EdgeRef } from '../core/world';
import { FENCES_BY_ID, PATHS_BY_TYPE } from '../data/fences';
import { OBJECTS_BY_ID, rotatedSize } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import { STAFF_INFO, TERRAIN_INFO } from './catalog';
import { fmtMoney, type ScreenRect } from './dom';
import type { ToolInput } from './input';
import { AnimalGhost, COL, DrapedMesh, FenceGhosts, GridOverlay, Marker, disposeOwned, ghostify, surfaceY, tintGhost, type EdgeState, type RGBA } from './preview';
import { cue } from './sound';

export interface PendingAction {
  title: string;
  verb: string;
  /** > 0 spend, < 0 refund. */
  cost: number;
  ok: boolean;
  note?: string;
  noteKind?: 'bad' | 'warn';
  /** Allowed, but probably not what the player wants (the confirm button says so). */
  risky?: boolean;
  /** So serious (the sim's severity 'confirm') that a dialog asks before it goes ahead. */
  ask?: ConfirmQuestion | null;
  /** Removals: share of the price paid back (1 = full refund, just built). */
  refundFraction?: number;
  commit(): CommandResult;
}

/** A dialog asking the player before a serious outcome. */
export interface ConfirmQuestion {
  title: string;
  text: string;
  ok: string;
}

const sentence = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}`;

/**
 * The question to ask before a command whose dry run the sim flags with severity 'confirm'
 * (cutting the entrance off, packing a habitat far past what it holds), or null. `verb` is
 * the confirm bar's verb ("Remove", "Adopt", "Move").
 */
export function confirmQuestion(r: CommandResult, verb: string): ConfirmQuestion | null {
  if (!r.ok || r.severity !== 'confirm' || !r.warning) return null;
  const ok = `${verb} anyway`;
  if (r.cutsEntrance) {
    // the sim's warning names the cut first; anything after it (e.g. a habitat opened) still matters
    const rest = r.warning.split('; ').slice(1).map(sentence).join(' ');
    const text = `This cuts the entrance off from the whole zoo. Guests can’t get in until you reconnect it.${rest ? ` ${rest}` : ''}`;
    return { title: 'Cut off the entrance?', text, ok };
  }
  if (/crowded/i.test(r.warning)) return { title: 'Overcrowd this habitat?', text: sentence(r.warning), ok };
  return { title: 'Are you sure?', text: sentence(r.warning), ok };
}

/** Bulldoze tool: clear everything in a rectangle, or only fence runs. */
export type BulldozeMode = 'area' | 'fence';

/** An existing animal or object being moved with the matching placement tool. */
export interface MoveTarget {
  kind: 'animal' | 'object';
  id: number;
}

export interface AnimalPreviewInfo {
  speciesId: string;
  habitatId: number | null;
  suitability: SpeciesSuitability | null;
  result: CommandResult | null;
}

export interface ToolHost {
  sim: ISimulation;
  ctx: IRenderContext;
  props: IPropsLayer;
  creatures: ICreatureFactory;
  /** Pending action changed (null = none / hidden while dragging). */
  onPending(p: PendingAction | null): void;
  /** Live cost label anchored in the world (null hides). */
  onLabel(pos: THREE.Vector3 | null, text: string, sub: string, ok: boolean): void;
  /** Animal tool: tapped location analysed. */
  onAnimalPreview(info: AnimalPreviewInfo | null): void;
  /** A committed action succeeded. */
  onCommitted(r: CommandResult): void;
}

type TP = { x: number; z: number };

/** Height (m) a preview is taken to reach on screen: fences, ghosts, the animal ghost. */
const PREVIEW_H = 2;

/** Offset from the pointer's tile to the corner tile of a w×d footprint centred on it. */
function centring(w: number, d: number): TP {
  return { x: -Math.floor((w - 1) / 2), z: -Math.floor((d - 1) / 2) };
}

/** The paved plaza at the gate, which bulldozing leaves in place (mirrors the sim's protected entrance tiles). */
function isEntrancePlaza(x: number, z: number): boolean {
  const p = ENTRANCE_PLAZA;
  return x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1;
}

const removeStates: EdgeState[] = [];
/** A shared array of `n` 'remove' edge states (no per-preview allocation). */
function REMOVE_STATES(n: number): EdgeState[] {
  while (removeStates.length < n) removeStates.push('remove');
  return removeStates;
}

function hexToRgba(hex: string, a: number): RGBA {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

const TERRAIN_FILL: RGBA[] = TERRAIN_INFO.map((t) => hexToRgba(t.color, 0.62));
const FENCE_SAME: RGBA = [1, 1, 0.92, 0.35];
const PATH_FILL: Record<number, RGBA> = {
  [PathType.Paved]: [0.86, 0.83, 0.76, 0.62],
  [PathType.Gravel]: [0.78, 0.72, 0.62, 0.62],
  [PathType.Boardwalk]: [0.62, 0.46, 0.3, 0.66],
};

export class ToolManager implements ToolInput {
  tool: Tool = { kind: 'select' };
  fenceMode: 'rect' | 'line' = 'rect';
  pathStraight = false;
  bulldozeMode: BulldozeMode = 'area';
  /** Set while the object / animal tool moves something that exists instead of buying a new one. */
  moving: MoveTarget | null = null;

  readonly group = new THREE.Group();
  private fills: DrapedMesh;
  private habOutline: DrapedMesh;
  private grid: GridOverlay;
  private fences: FenceGhosts;
  /** Red overlays on existing fences that a removal would take away (one per fence type). */
  private removeGhosts = new Map<number, FenceGhosts>();
  private marker = new Marker();

  // gesture / selection state
  private gesture = false;
  private sel: { a: TP; b: TP } | null = null;
  private prevSel: { a: TP; b: TP } | null = null;
  private ptrNdc = { x: 0, y: 0 };
  private ptrDirty = false;
  private hoverNdc = { x: 0, y: 0 };
  private hoverDirty = false;
  private hovering = false;
  // object tool
  private ghost: THREE.Object3D | null = null;
  private ghostDef = '';
  /** Model seed of the ghost (a moved object's ghost looks exactly like the object). */
  private ghostSeed = 1;
  private ghostTile: TP | null = null;
  private ghostLocked = false;
  private ghostOk = true;
  private prevGhostTile: TP | null = null;
  private prevGhostLocked = false;
  private moveOffset: TP = { x: 0, z: 0 };
  /** The gesture started next to the ghost, not on it: a drag drags the ghost, a tap moves it there. */
  private besideGhost = false;
  // animal / staff
  private point: TP | null = null;
  private prevPoint: TP | null = null;
  private animalGhost: AnimalGhost | null = null;
  /** Species whose meshes are built (creating a ghost for them is cheap). */
  private readySpecies = new Set<string>();
  private loadingSpecies = new Set<string>();
  // bulldoze (fence mode): world point of the tap that started the gesture
  private tapPt: TP | null = null;
  private prevTapPt: TP | null = null;
  private removeEdges: EdgeRef[] = [];

  private pending: PendingAction | null = null;
  private disposed = false;
  private labelPos = new THREE.Vector3();
  private recheck = 0;
  private habOutlineId = 0;
  private habOutlineRev = -1;
  private tmpV = new THREE.Vector3();
  private projV = new THREE.Vector3();

  constructor(private host: ToolHost) {
    const world = host.sim.world;
    this.group.name = 'ui-tools';
    this.fills = new DrapedMesh(world, 2, 2048);
    this.habOutline = new DrapedMesh(world, 2, 512);
    this.grid = new GridOverlay(world);
    this.fences = new FenceGhosts(world, host.props);
    this.group.add(this.habOutline.mesh, this.fills.mesh, this.grid.lines, this.fences.group, this.marker.mesh);
    this.fills.clear();
    this.habOutline.clear();
    host.ctx.scene.add(this.group);
  }

  get active(): boolean {
    return this.tool.kind !== 'select';
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  /** The question to ask before the pending action goes ahead, if it is that serious. */
  get pendingQuestion(): ConfirmQuestion | null {
    return this.pending?.ask ?? null;
  }

  // ------------------------------------------------------------ tool selection
  setTool(tool: Tool): void {
    this.switchTool(tool, null);
  }

  private switchTool(tool: Tool, moving: MoveTarget | null): void {
    const sameKind = tool.kind === this.tool.kind;
    const prev = this.tool;
    this.tool = tool;
    // a tool change ends a move in progress (and the highlight on the object being moved)
    if (this.moving?.kind === 'object') this.host.props.setHighlight(null);
    this.moving = moving;
    const keepSel =
      sameKind &&
      ((tool.kind === 'fence') ||
        (tool.kind === 'path') ||
        (tool.kind === 'terrain' && prev.kind === 'terrain'));
    if (!keepSel) this.resetState();
    if (tool.kind !== 'object' && this.ghost) this.dropGhost();
    if (tool.kind === 'object' && this.ghostDef !== tool.defId) this.dropGhost();
    if (tool.kind !== 'animal') this.dropAnimalGhost();
    else this.warmSpecies(tool.speciesId);
    if (tool.kind === 'select') {
      this.grid.hide();
      this.host.onAnimalPreview(null);
    } else {
      // show the grid where the player is looking
      const p = this.host.ctx.pickGround(0, -0.1);
      if (p) this.showGridAt(p.x, p.z);
    }
    this.refresh();
  }

  /**
   * Pick up an existing animal or object: the animal / object tool then puts it down
   * somewhere else (for free) instead of buying a new one. Returns the tool, or null if
   * the thing is gone.
   */
  startMove(target: MoveTarget): Tool | null {
    const sim = this.host.sim;
    const o = target.kind === 'object' ? sim.world.objects.get(target.id) : undefined;
    const a = target.kind === 'animal' ? sim.animals.get(target.id) : undefined;
    const tool: Tool | null = o ? { kind: 'object', defId: o.defId, rot: o.rot } : a ? { kind: 'animal', speciesId: a.speciesId } : null;
    if (!tool) return null;
    this.switchTool(tool, target);
    if (o) {
      // the ghost starts on the object itself, ready to be dragged; the original stays highlighted
      this.ghostTile = { x: o.tx, z: o.tz };
      this.ghostLocked = true;
      this.host.props.setHighlight(o.id);
    }
    this.refresh();
    return tool;
  }

  private resetState(): void {
    this.gesture = false;
    this.sel = null;
    this.prevSel = null;
    this.point = null;
    this.prevPoint = null;
    this.ghostTile = null;
    this.ghostLocked = false;
    this.tapPt = null;
    this.prevTapPt = null;
    this.fills.clear();
    this.fences.clear();
    this.clearRemoveGhosts();
    this.marker.hide();
    if (this.animalGhost) this.animalGhost.visible = false;
    this.setPending(null);
    this.setLabel(null);
  }

  /** Cancel the pending action but keep the tool. */
  cancelPending(): void {
    if (this.pending) cue('close');
    this.resetState();
    if (this.ghost) this.ghost.visible = false;
    this.host.onAnimalPreview(this.tool.kind === 'animal' ? { speciesId: this.tool.speciesId, habitatId: null, suitability: null, result: null } : null);
  }

  rotate(): void {
    if (this.tool.kind !== 'object') return;
    this.tool = { ...this.tool, rot: (this.tool.rot + 1) % 4 };
    if (this.ghostTile && this.ghost) {
      // keep the footprint centred where it was
      this.refresh();
    }
  }

  setFenceMode(m: 'rect' | 'line'): void {
    this.fenceMode = m;
    this.refresh();
  }

  setPathStraight(on: boolean): void {
    this.pathStraight = on;
    this.refresh();
  }

  setBulldozeMode(m: BulldozeMode): void {
    if (m === this.bulldozeMode) return;
    this.bulldozeMode = m;
    if (this.tool.kind === 'bulldoze') this.resetState();
    this.refresh();
  }

  confirm(): CommandResult | null {
    const p = this.pending;
    if (!p || this.gesture) return null;
    if (!p.ok) {
      cue('error');
      return null;
    }
    const removal = p.cost < 0 || this.tool.kind === 'bulldoze';
    const r = p.commit();
    if (r.ok) {
      cue(removal ? 'bulldoze' : 'build');
      this.host.onCommitted(r);
      this.resetState();
      if (this.ghost) this.ghost.visible = false;
      if (this.tool.kind === 'animal') this.host.onAnimalPreview({ speciesId: this.tool.speciesId, habitatId: null, suitability: null, result: null });
    } else {
      cue('error');
      this.refresh();
    }
    return r;
  }

  // ------------------------------------------------------------ ToolInput
  private pick(ndcX: number, ndcY: number): THREE.Vector3 | null {
    const p = this.host.ctx.pickGround(ndcX, ndcY);
    if (!p) return null;
    this.tmpV.copy(p);
    return this.tmpV;
  }

  private tileOf(p: THREE.Vector3): TP {
    return { x: Math.min(MAP_W - 1, Math.max(0, Math.floor(p.x / TILE))), z: Math.min(MAP_H - 1, Math.max(0, Math.floor(p.z / TILE))) };
  }

  private cornerOf(p: THREE.Vector3): TP {
    return { x: Math.min(MAP_W, Math.max(0, Math.round(p.x / TILE))), z: Math.min(MAP_H, Math.max(0, Math.round(p.z / TILE))) };
  }

  down(ndcX: number, ndcY: number): void {
    const p = this.pick(ndcX, ndcY);
    if (!p) return;
    this.gesture = true;
    this.hovering = false;
    this.setPending(null);
    const t = this.tool;
    this.showGridAt(p.x, p.z);
    switch (t.kind) {
      case 'fence': {
        const c = this.cornerOf(p);
        this.prevSel = this.sel;
        this.sel = { a: c, b: { ...c } };
        break;
      }
      case 'bulldoze':
      case 'path':
      case 'terrain': {
        const fenceMode = t.kind === 'bulldoze' && this.bulldozeMode === 'fence';
        const c = fenceMode ? this.cornerOf(p) : this.tileOf(p);
        this.prevSel = this.sel;
        this.prevTapPt = this.tapPt;
        this.sel = { a: c, b: { ...c } };
        this.tapPt = { x: p.x, z: p.z };
        break;
      }
      case 'object': {
        const tile = this.tileOf(p);
        this.prevGhostTile = this.ghostTile ? { ...this.ghostTile } : null;
        this.prevGhostLocked = this.ghostLocked;
        const def = OBJECTS_BY_ID[t.defId];
        const [w, d] = rotatedSize(def, t.rot);
        this.besideGhost = false;
        if (this.ghostLocked && this.ghostTile) {
          // a drag that starts on the ghost or within 2 tiles of it (fingers are wide) grabs it
          const g = this.ghostTile;
          const near = tile.x >= g.x - 2 && tile.x <= g.x + w + 1 && tile.z >= g.z - 2 && tile.z <= g.z + d + 1;
          if (near) {
            this.besideGhost = !(tile.x >= g.x && tile.x < g.x + w && tile.z >= g.z && tile.z < g.z + d);
            this.moveOffset = { x: g.x - tile.x, z: g.z - tile.z };
            break;
          }
        }
        this.moveOffset = centring(w, d);
        this.ghostTile = { x: tile.x + this.moveOffset.x, z: tile.z + this.moveOffset.z };
        this.ghostLocked = true;
        break;
      }
      case 'animal':
      case 'staff':
        this.prevPoint = this.point;
        this.point = { x: p.x, z: p.z };
        break;
      default:
        break;
    }
    this.refresh();
  }

  move(ndcX: number, ndcY: number): void {
    this.ptrNdc.x = ndcX;
    this.ptrNdc.y = ndcY;
    this.ptrDirty = true;
  }

  up(ndcX: number, ndcY: number, tap: boolean): void {
    if (!this.gesture) return;
    this.ptrNdc.x = ndcX;
    this.ptrNdc.y = ndcY;
    if (tap && this.besideGhost && this.tool.kind === 'object') {
      // a tap next to the ghost (not on it) moves the ghost there, centred on the tapped tile
      this.moveOffset = centring(...rotatedSize(OBJECTS_BY_ID[this.tool.defId], this.tool.rot));
    }
    this.besideGhost = false;
    this.applyPointer();
    this.gesture = false;
    this.refresh();
    // a soft knock when the spot the player just picked cannot be used ('error' is for confirm attempts)
    if (this.pending && !this.pending.ok) cue('deny');
  }

  cancel(): void {
    if (!this.gesture) return;
    this.gesture = false;
    this.ptrDirty = false;
    this.besideGhost = false;
    this.sel = this.prevSel;
    this.tapPt = this.prevTapPt;
    this.ghostTile = this.prevGhostTile;
    this.ghostLocked = this.prevGhostLocked;
    this.point = this.prevPoint;
    this.refresh();
  }

  hover(ndcX: number, ndcY: number): void {
    this.hoverNdc.x = ndcX;
    this.hoverNdc.y = ndcY;
    this.hoverDirty = true;
    this.hovering = true;
  }

  leave(): void {
    this.hovering = false;
    if (this.tool.kind === 'object' && !this.ghostLocked && this.ghost) {
      this.ghost.visible = false;
      this.fills.clear();
    }
  }

  private applyPointer(): void {
    this.ptrDirty = false;
    const p = this.pick(this.ptrNdc.x, this.ptrNdc.y);
    if (!p) return;
    this.showGridAt(p.x, p.z);
    const t = this.tool;
    if (!this.sel && (t.kind === 'fence' || t.kind === 'path' || t.kind === 'terrain' || t.kind === 'bulldoze')) return;
    switch (t.kind) {
      case 'fence':
        this.sel!.b = this.cornerOf(p);
        break;
      case 'bulldoze':
        this.sel!.b = this.bulldozeMode === 'fence' ? this.cornerOf(p) : this.tileOf(p);
        break;
      case 'path':
      case 'terrain':
        this.sel!.b = this.tileOf(p);
        break;
      case 'object': {
        const tile = this.tileOf(p);
        this.ghostTile = { x: tile.x + this.moveOffset.x, z: tile.z + this.moveOffset.z };
        break;
      }
      case 'animal':
      case 'staff':
        this.point = { x: p.x, z: p.z };
        break;
      default:
        break;
    }
  }

  private showGridAt(x: number, z: number): void {
    if (this.tool.kind === 'select' || this.tool.kind === 'animal' || this.tool.kind === 'staff') {
      this.grid.hide();
      return;
    }
    this.grid.show(Math.floor(x / TILE), Math.floor(z / TILE));
  }

  // ------------------------------------------------------------ per frame
  update(dt: number): void {
    if (this.ptrDirty && this.gesture) {
      this.applyPointer();
      this.refresh();
    }
    if (this.hoverDirty && !this.gesture) {
      this.hoverDirty = false;
      const p = this.pick(this.hoverNdc.x, this.hoverNdc.y);
      if (p) {
        this.showGridAt(p.x, p.z);
        if (this.tool.kind === 'object' && !this.ghostLocked) {
          const off = centring(...rotatedSize(OBJECTS_BY_ID[this.tool.defId], this.tool.rot));
          const tile = this.tileOf(p);
          this.ghostTile = { x: tile.x + off.x, z: tile.z + off.z };
          this.refresh();
        }
      }
    }
    this.marker.update(dt);
    if (this.animalGhost?.visible) this.animalGhost.update(dt);
    // periodic re-validation (money, animals moving, world edits)
    if (this.pending) {
      this.recheck += dt;
      if (this.recheck > 0.6) {
        this.recheck = 0;
        this.refresh();
      }
    }
    if (this.tool.kind === 'select' && this.habOutlineId) {
      if (this.host.sim.world.revision !== this.habOutlineRev) this.showHabitatOutline(this.habOutlineId);
    }
  }

  /** Screen rect (px) of the current preview, for keeping hints off it; null when nothing is shown. */
  previewScreenRect(vw: number, vh: number): ScreenRect | null {
    const b = this.previewBounds();
    if (!b) return null;
    const w = this.host.sim.world;
    const cam = this.host.ctx.camera;
    const r = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const x of [b.x0, b.x1])
      for (const z of [b.z0, b.z1])
        for (const up of [0, PREVIEW_H]) {
          const v = this.projV.set(x, w.heightAt(x, z) + up, z).project(cam);
          // partly behind the camera: take it to fill the view
          if (v.z > 1) return { left: 0, top: 0, right: vw, bottom: vh };
          const sx = (v.x * 0.5 + 0.5) * vw;
          const sy = (0.5 - v.y * 0.5) * vh;
          r.left = Math.min(r.left, sx);
          r.right = Math.max(r.right, sx);
          r.top = Math.min(r.top, sy);
          r.bottom = Math.max(r.bottom, sy);
        }
    return r;
  }

  /**
   * Ground rectangle (world metres) the current preview covers: the dragged area, the object
   * ghost's footprint, or the tapped spot. Null when nothing is shown.
   */
  private previewBounds(): { x0: number; z0: number; x1: number; z1: number } | null {
    const t = this.tool;
    switch (t.kind) {
      case 'fence':
      case 'path':
      case 'bulldoze':
      case 'terrain': {
        const s = this.sel;
        const r =
          t.kind === 'terrain'
            ? this.rectOfSel(t.brush)
            : s && { x0: Math.min(s.a.x, s.b.x), z0: Math.min(s.a.z, s.b.z), x1: Math.max(s.a.x, s.b.x), z1: Math.max(s.a.z, s.b.z) };
        if (!r) return null;
        // fences (and fence removal) run along tile corners, the rest covers whole tiles
        const cornerSel = t.kind === 'fence' || (t.kind === 'bulldoze' && this.bulldozeMode === 'fence');
        const e = cornerSel ? 0 : 1;
        return { x0: r.x0 * TILE, z0: r.z0 * TILE, x1: (r.x1 + e) * TILE, z1: (r.z1 + e) * TILE };
      }
      case 'object': {
        const g = this.ghostTile;
        if (!g || !this.ghostLocked) return null;
        const [w, d] = rotatedSize(OBJECTS_BY_ID[t.defId], t.rot);
        return { x0: g.x * TILE, z0: g.z * TILE, x1: (g.x + w) * TILE, z1: (g.z + d) * TILE };
      }
      case 'animal':
      case 'staff': {
        const p = this.point;
        const r = t.kind === 'animal' ? Math.max(1, (SPECIES_BY_ID[t.speciesId]?.length ?? 2) * 0.6) : 1;
        return p ? { x0: p.x - r, z0: p.z - r, x1: p.x + r, z1: p.z + r } : null;
      }
      default:
        return null;
    }
  }

  // ------------------------------------------------------------ preview + pending
  private setPending(p: PendingAction | null): void {
    this.pending = p;
    this.host.onPending(this.gesture ? null : p);
  }

  private setLabel(pos: { x: number; z: number } | null, text = '', sub = '', ok = true): void {
    if (!pos) {
      this.host.onLabel(null, '', '', true);
      return;
    }
    this.labelPos.set(pos.x, surfaceY(this.host.sim.world, pos.x, pos.z) + 1.2, pos.z);
    this.host.onLabel(this.labelPos, text, sub, ok);
  }

  private refresh(): void {
    this.recheck = 0;
    switch (this.tool.kind) {
      case 'fence':
        return this.previewFence(this.tool.fenceId);
      case 'path':
        return this.previewPath(this.tool.pathType);
      case 'terrain':
        return this.previewTerrain(this.tool.terrain, this.tool.brush);
      case 'bulldoze':
        return this.bulldozeMode === 'fence' ? this.previewFenceRemoval() : this.previewBulldoze();
      case 'object':
        return this.previewObject(this.tool.defId, this.tool.rot);
      case 'animal':
        return this.previewAnimal(this.tool.speciesId);
      case 'staff':
        return this.previewStaff(this.tool.role);
      default:
        this.fills.clear();
        this.fences.clear();
        this.clearRemoveGhosts();
        this.marker.hide();
        this.setPending(null);
        this.setLabel(null);
    }
  }

  /**
   * Confirm-bar note: why it fails, else the sim's warning (outranks a plain remark), else its
   * remark. A warning the sim wants confirmed shows as `confirmKind`, in its short form when it has
   * one (the dialog then gives it in full), and marks the action risky (the button then says "… anyway").
   */
  private note(r: CommandResult, confirmKind: 'bad' | 'warn' = 'bad'): { note?: string; noteKind?: 'bad' | 'warn'; risky?: boolean } {
    if (r.ok && r.warning)
      return r.severity === 'confirm' ? { note: r.shortWarning ?? r.warning, noteKind: confirmKind, risky: true } : { note: r.warning, noteKind: 'warn' };
    if (!r.reason) return {};
    return { note: r.reason, noteKind: r.ok ? 'warn' : 'bad' };
  }

  /** The confirm bar's verb, with "anyway" when the sim asks to confirm the outcome. */
  private verb(base: string, r: CommandResult, risky = `${base} anyway`): string {
    return r.ok && r.severity === 'confirm' ? risky : base;
  }

  // ---- fences
  private fenceEdges(): EdgeRef[] {
    const s = this.sel;
    if (!s) return [];
    const w = this.host.sim.world;
    const { a, b } = s;
    if (a.x === b.x && a.z === b.z) return [];
    if (this.fenceMode === 'line' || a.x === b.x || a.z === b.z) return w.edgesBetweenCorners(a.x, a.z, b.x, b.z);
    return w.edgesAroundRect({ x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x) - 1, z1: Math.max(a.z, b.z) - 1 });
  }

  private edgeBlocked(e: EdgeRef): boolean {
    const w = this.host.sim.world;
    const [ax, az, bx, bz] = e.dir === 'h' ? [e.x, e.z - 1, e.x, e.z] : [e.x - 1, e.z, e.x, e.z];
    if (!w.inBounds(ax, az) || !w.inBounds(bx, bz)) return false;
    if (w.isPath(ax, az) && w.isPath(bx, bz)) return true;
    const oa = w.objectGrid[w.idx(ax, az)];
    return !!oa && oa === w.objectGrid[w.idx(bx, bz)];
  }

  private previewFence(fenceId: number): void {
    const sim = this.host.sim;
    const edges = this.fenceEdges();
    this.fills.begin();
    if (!edges.length) {
      this.fills.end();
      this.fences.clear();
      this.setPending(null);
      if (this.sel) {
        const c = this.sel.a;
        this.fills.begin();
        this.fills.rect(c.x * TILE - 0.25, c.z * TILE - 0.25, c.x * TILE + 0.25, c.z * TILE + 0.25, COL.okLine, 1);
        this.fills.end();
      }
      this.setLabel(null);
      return;
    }
    const states: EdgeState[] = edges.map((e) => (sim.world.getFence(e) === fenceId ? 'same' : this.edgeBlocked(e) ? 'blocked' : 'new'));
    this.fences.set(fenceId, edges, states);
    // the sim warns when the fence won't make a habitat (a path inside, a gap where it crosses a path…)
    const r = sim.placeFences(edges, fenceId, true);
    const warning = r.ok ? r.warning : undefined;
    // crisp draped line under the ghosts so the run reads clearly over any scenery
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const c = states[i] === 'blocked' ? COL.badLine : states[i] === 'same' ? FENCE_SAME : COL.okLine;
      if (e.dir === 'h') this.fills.line(e.x * TILE, e.z * TILE, (e.x + 1) * TILE, e.z * TILE, 0.22, c);
      else this.fills.line(e.x * TILE, e.z * TILE, e.x * TILE, (e.z + 1) * TILE, 0.22, c);
    }
    // faint fill of the area that will be enclosed (rect mode) — only if it really becomes a habitat
    const s = this.sel!;
    const isRect = this.fenceMode === 'rect' && s.a.x !== s.b.x && s.a.z !== s.b.z;
    if (isRect && !warning) {
      const x0 = Math.min(s.a.x, s.b.x) * TILE,
        x1 = Math.max(s.a.x, s.b.x) * TILE,
        z0 = Math.min(s.a.z, s.b.z) * TILE,
        z1 = Math.max(s.a.z, s.b.z) * TILE;
      const sub = Math.min(24, Math.max(2, Math.round(Math.max(x1 - x0, z1 - z0) / 2)));
      this.fills.rect(x0, z0, x1, z1, COL.habitat, sub);
    }
    this.fills.end();
    const def = FENCES_BY_ID[fenceId];
    const n = states.filter((x) => x === 'new').length;
    const metres = n * TILE;
    // the enclosed size the way the tour and the habitat advice count it: "8×8 = 64 tiles"
    const across = Math.abs(s.b.x - s.a.x),
      deep = Math.abs(s.b.z - s.a.z);
    const size = isRect ? `${metres} m · ${across}×${deep} = ${across * deep} tiles` : `${metres} m`;
    this.setLabel({ x: s.b.x * TILE, z: s.b.z * TILE }, fmtMoney(r.cost), size, r.ok && !warning);
    this.setPending({
      title: `${def?.name ?? 'Fence'} · ${metres} m`,
      // building a fence that won't enclose anything has to be a deliberate choice
      verb: warning ? 'Build anyway' : 'Build',
      cost: r.cost,
      ok: r.ok,
      ...(warning ? { note: warning, noteKind: 'bad' as const, risky: true } : this.note(r)),
      commit: () => sim.placeFences(edges, fenceId),
    });
  }

  // ---- paths
  private pathTiles(): TP[] {
    const s = this.sel;
    if (!s) return [];
    const { a, b } = s;
    const out: TP[] = [];
    const seen = new Set<number>();
    const run = (x0: number, z0: number, x1: number, z1: number) => {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
      const sx = Math.sign(x1 - x0),
        sz = Math.sign(z1 - z0);
      for (let i = 0; i <= n; i++) {
        const x = x0 + sx * i,
          z = z0 + sz * i;
        const k = z * MAP_W + x;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ x, z });
      }
    };
    const xFirst = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z);
    if (this.pathStraight) {
      if (xFirst) run(a.x, a.z, b.x, a.z);
      else run(a.x, a.z, a.x, b.z);
    } else if (xFirst) {
      run(a.x, a.z, b.x, a.z);
      run(b.x, a.z, b.x, b.z);
    } else {
      run(a.x, a.z, a.x, b.z);
      run(a.x, b.z, b.x, b.z);
    }
    return out;
  }

  private previewPath(type: PathType): void {
    const sim = this.host.sim;
    const w = sim.world;
    const tiles = this.pathTiles();
    this.fills.begin();
    const okFill = PATH_FILL[type] ?? COL.ok;
    for (const t of tiles) {
      let why = w.canPlacePath(t.x, t.z, type);
      if (why && !w.habitatOf[w.idx(t.x, t.z)]) {
        const o = w.objectAt(t.x, t.z);
        const cat = o ? OBJECTS_BY_ID[o.defId]?.category : undefined;
        if (cat === 'tree' || cat === 'plant' || cat === 'rock') why = null;
        const ter = w.getTerrain(t.x, t.z);
        if ((ter === Terrain.Water || ter === Terrain.DeepWater) && type !== PathType.Boardwalk) why = 'water';
      }
      const same = w.getPath(t.x, t.z) === type;
      this.fills.tile(t.x, t.z, why ? COL.bad : same ? [okFill[0], okFill[1], okFill[2], 0.25] : okFill, 0.06);
    }
    if (tiles.length) {
      // a thin edge line along the run so it reads clearly over grass
      for (const t of tiles) this.fills.outline(t.x, t.z, t.x, t.z, 0.06, [1, 1, 0.9, 0.35]);
    }
    this.fills.end();
    if (!tiles.length) {
      this.setPending(null);
      this.setLabel(null);
      return;
    }
    const r = sim.placePaths(tiles, type, true);
    const end = tiles[tiles.length - 1];
    const def = PATHS_BY_TYPE[type];
    const count = `${tiles.length} tile${tiles.length > 1 ? 's' : ''}`;
    // tiles of another path type are re-surfaced and paid for: say so, it is easy to miss
    const resurfaced = r.resurfaced ? ` · ${r.resurfaced.tiles} re-surfaced` : '';
    this.setLabel({ x: (end.x + 0.5) * TILE, z: (end.z + 0.5) * TILE }, fmtMoney(r.cost), count, r.ok);
    this.setPending({
      title: `${def?.name ?? 'Path'} · ${count}${resurfaced}`,
      verb: 'Build',
      cost: r.cost,
      ok: r.ok,
      ...this.note(r),
      commit: () => sim.placePaths(tiles, type),
    });
  }

  // ---- terrain / bulldoze rectangles
  private rectOfSel(brush: number): TileRect | null {
    const s = this.sel;
    if (!s) return null;
    if (s.a.x === s.b.x && s.a.z === s.b.z && brush > 1) {
      const h = Math.floor(brush / 2);
      return this.host.sim.world.clampRect({ x0: s.a.x - h, z0: s.a.z - h, x1: s.a.x + h, z1: s.a.z + h });
    }
    return this.host.sim.world.clampRect({ x0: s.a.x, z0: s.a.z, x1: s.b.x, z1: s.b.z });
  }

  private previewTerrain(t: Terrain, brush: number): void {
    const sim = this.host.sim;
    const r = this.rectOfSel(brush);
    this.fills.begin();
    if (r) {
      const fill = TERRAIN_FILL[t] ?? COL.ok;
      const sub = Math.min(48, Math.max(2, (Math.max(r.x1 - r.x0, r.z1 - r.z0) + 1) * 2));
      this.fills.rect(r.x0 * TILE, r.z0 * TILE, (r.x1 + 1) * TILE, (r.z1 + 1) * TILE, fill, sub);
    }
    let res: CommandResult | null = null;
    if (r) {
      res = sim.paintTerrain(r, t, true);
      this.fills.outline(r.x0, r.z0, r.x1, r.z1, 0.14, res.ok ? COL.okLine : COL.badLine);
    }
    this.fills.end();
    if (!r || !res) {
      this.setPending(null);
      this.setLabel(null);
      return;
    }
    const n = (r.x1 - r.x0 + 1) * (r.z1 - r.z0 + 1);
    const name = TERRAIN_INFO[t]?.name ?? 'Terrain';
    this.setLabel({ x: (r.x1 + 1) * TILE, z: (r.z1 + 1) * TILE }, fmtMoney(res.cost), `${r.x1 - r.x0 + 1}×${r.z1 - r.z0 + 1}`, res.ok);
    const rect = { ...r };
    this.setPending({
      title: `${name} · ${n} tile${n > 1 ? 's' : ''}`,
      // flooding the dry land of animals that can't swim: an amber warning and "Paint anyway"
      verb: this.verb('Paint', res),
      cost: res.cost,
      ok: res.ok,
      ...this.note(res, 'warn'),
      commit: () => sim.paintTerrain(rect, t),
    });
  }

  private previewBulldoze(): void {
    const sim = this.host.sim;
    const w = sim.world;
    const r = this.rectOfSel(1);
    this.fills.begin();
    let res: CommandResult | null = null;
    const edges = this.removeEdges;
    edges.length = 0;
    const seen = new Set<number>();
    let pathTiles = 0;
    if (r) {
      const sub = Math.min(48, Math.max(2, (Math.max(r.x1 - r.x0, r.z1 - r.z0) + 1) * 2));
      this.fills.rect(r.x0 * TILE, r.z0 * TILE, (r.x1 + 1) * TILE, (r.z1 + 1) * TILE, COL.remove, sub);
      res = sim.bulldoze(r, true);
      this.fills.outline(r.x0, r.z0, r.x1, r.z1, 0.14, COL.removeLine);
      // mark objects that will be removed, and count them and the path tiles for the confirm bar
      for (let z = r.z0; z <= r.z1; z++)
        for (let x = r.x0; x <= r.x1; x++) {
          if (w.isPath(x, z) && !isEntrancePlaza(x, z)) pathTiles++;
          const o = w.objectAt(x, z);
          if (!o || seen.has(o.id) || o.defId === 'entrance_gate') continue;
          seen.add(o.id);
          for (const ft of w.footprint(o)) this.fills.tile(ft.x, ft.z, [1, 0.3, 0.2, 0.3], 0.18);
        }
      // …and the fence segments on and inside the rectangle (the sim clears those too)
      for (let z = r.z0; z <= r.z1 + 1; z++)
        for (let x = r.x0; x <= r.x1; x++) if (w.getFence({ dir: 'h', x, z })) edges.push({ dir: 'h', x, z });
      for (let z = r.z0; z <= r.z1; z++)
        for (let x = r.x0; x <= r.x1 + 1; x++) if (w.getFence({ dir: 'v', x, z })) edges.push({ dir: 'v', x, z });
      for (const e of edges) this.edgeRibbon(e, 0.3, COL.removeLine);
    }
    this.fills.end();
    this.showRemoveGhosts(edges);
    if (!r || !res) {
      this.setPending(null);
      this.setLabel(null);
      return;
    }
    const refund = -res.cost;
    const size = `${r.x1 - r.x0 + 1}×${r.z1 - r.z0 + 1}`;
    this.setLabel({ x: (r.x1 + 1) * TILE, z: (r.z1 + 1) * TILE }, res.ok ? `+${fmtMoney(refund)}` : 'Nothing here', res.refundFraction === 1 ? `${size} · full refund` : size, res.ok);
    const rect = { ...r };
    // say what goes: "Picnic Table · 6 path tiles · 8 m fence" (the size is on the floating label)
    const parts: string[] = [];
    if (seen.size === 1) parts.push(OBJECTS_BY_ID[w.objects.get([...seen][0])!.defId]?.name ?? '1 object');
    else if (seen.size) parts.push(`${seen.size} objects`);
    if (pathTiles) parts.push(`${pathTiles} path tile${pathTiles > 1 ? 's' : ''}`);
    if (edges.length) parts.push(`${edges.length * TILE} m fence`);
    this.setPending({
      title: parts.length ? `Clear ${parts.join(' · ')}` : `Clear ${r.x1 - r.x0 + 1}×${r.z1 - r.z0 + 1} area`,
      verb: this.verb('Remove', res),
      cost: res.cost,
      ok: res.ok,
      refundFraction: res.refundFraction,
      ...this.note(res),
      ask: confirmQuestion(res, 'Remove'),
      commit: () => sim.bulldoze(rect),
    });
  }

  // ---- fence removal (bulldoze tool, "fences only")
  private edgeRibbon(e: EdgeRef, width: number, c: RGBA): void {
    if (e.dir === 'h') this.fills.line(e.x * TILE, e.z * TILE, (e.x + 1) * TILE, e.z * TILE, width, c);
    else this.fills.line(e.x * TILE, e.z * TILE, e.x * TILE, (e.z + 1) * TILE, width, c);
  }

  /** Nearest fenced edge to a world point (within ~1.3 m), or null. */
  private fenceEdgeNear(px: number, pz: number): EdgeRef | null {
    const w = this.host.sim.world;
    const tx = px / TILE,
      tz = pz / TILE;
    let best: EdgeRef | null = null;
    let bd = 0.65; // tiles
    const cx = Math.floor(tx),
      cz = Math.floor(tz);
    for (let z = cz - 1; z <= cz + 2; z++)
      for (let x = cx - 1; x <= cx + 2; x++) {
        // h(x, z): (x..x+1, z)
        if (w.getFence({ dir: 'h', x, z })) {
          const dx = Math.max(x - tx, 0, tx - (x + 1));
          const d = Math.hypot(dx, tz - z);
          if (d < bd) {
            bd = d;
            best = { dir: 'h', x, z };
          }
        }
        // v(x, z): (x, z..z+1)
        if (w.getFence({ dir: 'v', x, z })) {
          const dz = Math.max(z - tz, 0, tz - (z + 1));
          const d = Math.hypot(tx - x, dz);
          if (d < bd) {
            bd = d;
            best = { dir: 'v', x, z };
          }
        }
      }
    return best;
  }

  /** The straight run of same-type fence through an edge, ending at corners / junctions. */
  private fenceRun(start: EdgeRef): EdgeRef[] {
    const w = this.host.sim.world;
    const id = w.getFence(start);
    const out: EdgeRef[] = [start];
    // does a perpendicular fence meet the run at grid corner (cx, cz)?
    const branches = (cx: number, cz: number, dir: 'h' | 'v') =>
      dir === 'h'
        ? !!(w.getFence({ dir: 'v', x: cx, z: cz - 1 }) || w.getFence({ dir: 'v', x: cx, z: cz }))
        : !!(w.getFence({ dir: 'h', x: cx - 1, z: cz }) || w.getFence({ dir: 'h', x: cx, z: cz }));
    for (const step of [-1, 1]) {
      let cur = start;
      for (let guard = 0; guard < 200; guard++) {
        const next: EdgeRef = cur.dir === 'h' ? { dir: 'h', x: cur.x + step, z: cur.z } : { dir: 'v', x: cur.x, z: cur.z + step };
        // the corner shared by cur and next
        const cx = cur.dir === 'h' ? (step > 0 ? cur.x + 1 : cur.x) : cur.x;
        const cz = cur.dir === 'h' ? cur.z : step > 0 ? cur.z + 1 : cur.z;
        if (w.getFence(next) !== id || branches(cx, cz, cur.dir)) break;
        out.push(next);
        cur = next;
      }
    }
    return out;
  }

  private previewFenceRemoval(): void {
    const sim = this.host.sim;
    const w = sim.world;
    const edges = this.removeEdges;
    edges.length = 0;
    const s = this.sel;
    this.fills.begin();
    if (s) {
      if (s.a.x === s.b.x && s.a.z === s.b.z) {
        // tap: the whole straight run under the finger
        const t = this.tapPt;
        const e = t ? this.fenceEdgeNear(t.x, t.z) : null;
        if (e) for (const r of this.fenceRun(e)) edges.push(r);
      } else {
        // drag: fenced edges along the line between the two posts
        for (const e of w.edgesBetweenCorners(s.a.x, s.a.z, s.b.x, s.b.z)) {
          if (w.getFence(e)) edges.push(e);
          else this.edgeRibbon(e, 0.12, [1, 0.85, 0.75, 0.35]);
        }
      }
      for (const e of edges) this.edgeRibbon(e, 0.32, COL.removeLine);
    }
    this.fills.end();
    this.showRemoveGhosts(edges);
    if (!s) {
      this.setPending(null);
      this.setLabel(null);
      return;
    }
    const todo = edges.slice();
    const res = sim.removeFences(todo, true);
    const metres = todo.length * TILE;
    const end = todo.length ? todo[todo.length - 1] : null;
    const lp = end ? (end.dir === 'h' ? { x: (end.x + 1) * TILE, z: end.z * TILE } : { x: end.x * TILE, z: (end.z + 1) * TILE }) : { x: s.b.x * TILE, z: s.b.z * TILE };
    this.setLabel(lp, res.ok ? `+${fmtMoney(-res.cost)}` : 'No fence here', res.ok ? `${metres} m` : '', res.ok);
    const kinds = new Set(todo.map((e) => w.getFence(e)));
    const name = kinds.size === 1 ? FENCES_BY_ID[[...kinds][0]]?.name ?? 'Fence' : 'Fences';
    this.setPending({
      title: res.ok ? `Remove ${name.toLowerCase()} · ${metres} m` : 'Remove fence',
      verb: 'Remove',
      cost: res.cost,
      ok: res.ok,
      refundFraction: res.refundFraction,
      ...(res.ok ? this.note(res) : { note: 'Tap a fence, or drag along one', noteKind: 'bad' as const }),
      commit: () => sim.removeFences(todo),
    });
  }

  /** Red, slightly inflated overlays on the existing fence segments in `edges`. */
  private showRemoveGhosts(edges: EdgeRef[]): void {
    const w = this.host.sim.world;
    const byType = new Map<number, EdgeRef[]>();
    for (const e of edges) {
      const id = w.getFence(e);
      if (!id) continue;
      let l = byType.get(id);
      if (!l) byType.set(id, (l = []));
      l.push(e);
    }
    for (const [id, g] of this.removeGhosts) if (!byType.has(id)) g.clear();
    for (const [id, list] of byType) {
      let g = this.removeGhosts.get(id);
      if (!g) {
        g = new FenceGhosts(w, this.host.props, 'remove');
        this.removeGhosts.set(id, g);
        this.group.add(g.group);
      }
      g.set(id, list, REMOVE_STATES(list.length));
    }
  }

  private clearRemoveGhosts(): void {
    for (const g of this.removeGhosts.values()) g.clear();
  }

  // ---- objects
  private dropGhost(): void {
    if (this.ghost) {
      this.group.remove(this.ghost);
      disposeOwned(this.ghost);
    }
    this.ghost = null;
    this.ghostDef = '';
    this.ghostSeed = 1;
    this.ghostTile = null;
    this.ghostLocked = false;
  }

  private previewObject(defId: string, rot: number): void {
    const sim = this.host.sim;
    const def = OBJECTS_BY_ID[defId];
    if (!def) return;
    const mv = this.moving?.kind === 'object' ? sim.world.objects.get(this.moving.id) : undefined;
    const seed = mv ? mv.seed : 1;
    if (!this.ghost || this.ghostDef !== defId || this.ghostSeed !== seed) {
      this.dropGhost();
      try {
        this.ghost = this.host.props.createObjectModel(defId, seed);
        ghostify(this.ghost);
        this.ghostDef = defId;
        this.ghostSeed = seed;
        this.group.add(this.ghost);
      } catch (err) {
        console.warn('[ui] ghost model failed', err);
      }
    }
    const t = this.ghostTile;
    this.fills.begin();
    if (!t) {
      this.fills.end();
      if (this.ghost) this.ghost.visible = false;
      this.setPending(null);
      this.setLabel(null);
      return;
    }
    const [w, d] = rotatedSize(def, rot);
    const cx = (t.x + w / 2) * TILE,
      cz = (t.z + d / 2) * TILE;
    const r = mv ? sim.moveObject(mv.id, t.x, t.z, rot, true) : sim.placeObject(defId, t.x, t.z, rot, true);
    // a moved object's ghost still on its old spot: nothing to do yet, but nothing wrong either
    const home = !!mv && mv.tx === t.x && mv.tz === t.z && mv.rot === rot;
    const looksOk = r.ok || home;
    if (this.ghost) {
      this.ghost.visible = true;
      this.ghost.position.set(cx, sim.world.heightAt(cx, cz), cz);
      this.ghost.rotation.set(0, (rot * Math.PI) / 2, 0);
      if (looksOk !== this.ghostOk || !this.ghost.userData.tinted) {
        tintGhost(this.ghost, looksOk);
        this.ghost.userData.tinted = true;
        this.ghostOk = looksOk;
      }
    }
    for (let z = t.z; z < t.z + d; z++) for (let x = t.x; x < t.x + w; x++) this.fills.tile(x, z, looksOk ? COL.ok : COL.bad, 0.05);
    this.fills.outline(t.x, t.z, t.x + w - 1, t.z + d - 1, 0.1, looksOk ? COL.okLine : COL.badLine);
    this.fills.end();
    if (!this.ghostLocked) {
      // desktop hover preview: no pending until click
      this.setPending(null);
      this.setLabel(null);
      return;
    }
    const tx = t.x,
      tz = t.z;
    if (mv) {
      const id = mv.id;
      this.setLabel({ x: cx, z: cz }, 'Move', looksOk ? def.name : r.reason ?? '', looksOk);
      this.setPending({
        title: `Move ${def.name}`,
        verb: 'Move here',
        cost: 0,
        ok: r.ok,
        ...(home ? { note: 'Drag it to a new spot, or turn it' } : this.note(r)),
        commit: () => sim.moveObject(id, tx, tz, rot),
      });
      return;
    }
    this.setLabel({ x: cx, z: cz }, fmtMoney(def.cost), r.ok ? def.name : r.reason ?? '', r.ok);
    this.setPending({
      title: def.name,
      verb: 'Build',
      cost: r.cost,
      ok: r.ok,
      ...this.note(r),
      commit: () => sim.placeObject(defId, tx, tz, rot),
    });
  }

  // ---- animals
  /** Build a species' meshes in the background (yields to the browser) before its ghost is needed. */
  private warmSpecies(speciesId: string): void {
    if (this.readySpecies.has(speciesId) || this.loadingSpecies.has(speciesId)) return;
    this.loadingSpecies.add(speciesId);
    this.host.creatures
      .preload([speciesId])
      .catch(() => undefined)
      .then(() => {
        this.loadingSpecies.delete(speciesId);
        this.readySpecies.add(speciesId);
        if (!this.disposed && this.tool.kind === 'animal' && this.tool.speciesId === speciesId && this.point) this.refresh();
      });
  }

  private dropAnimalGhost(): void {
    if (this.animalGhost) {
      this.group.remove(this.animalGhost.root);
      this.animalGhost.dispose();
    }
    this.animalGhost = null;
  }

  private previewAnimal(speciesId: string): void {
    const sim = this.host.sim;
    const sp = SPECIES_BY_ID[speciesId];
    this.fills.clear();
    const p = this.point;
    if (!p || !sp) {
      this.marker.hide();
      if (this.animalGhost) this.animalGhost.visible = false;
      this.setPending(null);
      this.setLabel(null);
      this.host.onAnimalPreview({ speciesId, habitatId: null, suitability: null, result: null });
      return;
    }
    const w = sim.world;
    const tile = w.tileOfWorld(p.x, p.z);
    const hab = w.habitatAt(tile.x, tile.z);
    const mover = this.moving?.kind === 'animal' ? sim.animals.get(this.moving.id) : undefined;
    const r = mover ? sim.moveAnimal(mover.id, p.x, p.z, true) : sim.buyAnimal(speciesId, p.x, p.z, true);
    const y = surfaceY(w, p.x, p.z) - 0.05;
    this.marker.place(p.x, y, p.z, r.ok, Math.max(0.8, Math.min(2.6, sp.length * 0.45)));
    let suit: SpeciesSuitability | null = null;
    if (hab) {
      try {
        // a moved animal counts as a newcomer only when it comes from another habitat
        suit = sim.suitability(speciesId, hab.id, mover ? { animalId: mover.id } : undefined);
      } catch {
        suit = null;
      }
    }
    // translucent ghost of the animal at the spot (green = can adopt here, red = can't);
    // built only once the species' meshes exist so a tap never stalls on mesh generation
    if ((!this.animalGhost || this.animalGhost.speciesId !== speciesId) && this.readySpecies.has(speciesId)) {
      this.dropAnimalGhost();
      try {
        this.animalGhost = new AnimalGhost(this.host.creatures, speciesId);
        this.group.add(this.animalGhost.root);
      } catch (err) {
        console.warn('[ui] animal preview failed', err);
        this.animalGhost = null;
      }
    }
    if (this.animalGhost && this.animalGhost.speciesId === speciesId) {
      const g = this.animalGhost;
      const cam = this.host.ctx.camera.position;
      // swimmers float at the water line, everything else stands on the ground
      const gy = sp.swims && w.heightAt(p.x, p.z) < WATER_LEVEL - 0.3 ? WATER_LEVEL : w.heightAt(p.x, p.z);
      g.place(p.x, gy, p.z, Math.atan2(cam.x - p.x, cam.z - p.z) + 0.7);
      g.setOk(r.ok);
      g.visible = true;
    } else if (this.animalGhost) this.animalGhost.visible = false;
    this.host.onAnimalPreview({ speciesId, habitatId: hab?.id ?? null, suitability: suit, result: r });
    this.setLabel(null);
    const px = p.x,
      pz = p.z;
    const moverId = mover?.id ?? 0;
    this.setPending({
      title: `${mover ? `Move ${mover.name}` : sp.name}${hab ? ` · ${hab.name}` : ''}`,
      verb: mover ? this.verb('Move here', r, 'Move anyway') : this.verb('Adopt', r),
      cost: r.cost,
      ok: r.ok,
      ...this.note(r),
      ask: confirmQuestion(r, mover ? 'Move' : 'Adopt'),
      commit: () => (moverId ? sim.moveAnimal(moverId, px, pz) : sim.buyAnimal(speciesId, px, pz)),
    });
  }

  // ---- staff
  private nearestPath(tx: number, tz: number, radius: number): TP | null {
    const w = this.host.sim.world;
    let best: TP | null = null;
    let bd = Infinity;
    for (let z = tz - radius; z <= tz + radius; z++)
      for (let x = tx - radius; x <= tx + radius; x++) {
        if (!w.inBounds(x, z) || !w.isPath(x, z)) continue;
        const d = (x - tx) * (x - tx) + (z - tz) * (z - tz);
        if (d < bd) {
          bd = d;
          best = { x, z };
        }
      }
    return best;
  }

  private previewStaff(role: StaffRole): void {
    const sim = this.host.sim;
    this.fills.begin();
    const p = this.point;
    if (!p) {
      this.fills.end();
      this.marker.hide();
      this.setPending(null);
      this.setLabel(null);
      return;
    }
    const w = sim.world;
    const t = w.tileOfWorld(p.x, p.z);
    const snap = this.nearestPath(t.x, t.z, 4);
    const r = sim.hireStaff(role, p.x, p.z, true);
    if (snap) {
      const c = w.tileCenter(snap.x, snap.z);
      this.marker.place(c.x, surfaceY(w, c.x, c.z) - 0.04, c.z, r.ok, 0.9);
      this.fills.tile(snap.x, snap.z, r.ok ? COL.ok : COL.bad, 0.1);
    } else this.marker.place(p.x, surfaceY(w, p.x, p.z) - 0.04, p.z, false, 0.9);
    this.fills.end();
    this.setLabel(null);
    const px = p.x,
      pz = p.z;
    const info = STAFF_INFO[role];
    this.setPending({
      title: `Hire ${info.name.toLowerCase()}`,
      verb: 'Hire',
      // hiring itself is free; the button shows the daily wage
      cost: sim.staffWage(role),
      ok: r.ok,
      ...this.note(r),
      commit: () => sim.hireStaff(role, px, pz),
    });
  }

  // ------------------------------------------------------------ habitat highlight (select mode)
  showHabitatOutline(habitatId: number | null): void {
    const w = this.host.sim.world;
    this.habOutlineId = habitatId ?? 0;
    this.habOutlineRev = w.revision;
    this.habOutline.begin();
    const hab = habitatId ? w.habitats.get(habitatId) : undefined;
    if (hab) {
      for (const i of hab.tiles) {
        const x = i % MAP_W,
          z = (i / MAP_W) | 0;
        if (hab.tiles.length < 900) this.habOutline.tile(x, z, COL.habitat, 0);
        const inside = (nx: number, nz: number) => w.inBounds(nx, nz) && w.habitatOf[w.idx(nx, nz)] === hab.id;
        const x0 = x * TILE,
          z0 = z * TILE,
          x1 = x0 + TILE,
          z1 = z0 + TILE;
        const lw = 0.16;
        if (!inside(x, z - 1)) this.habOutline.line(x0, z0 + lw / 2, x1, z0 + lw / 2, lw, COL.habitatLine);
        if (!inside(x, z + 1)) this.habOutline.line(x0, z1 - lw / 2, x1, z1 - lw / 2, lw, COL.habitatLine);
        if (!inside(x - 1, z)) this.habOutline.line(x0 + lw / 2, z0, x0 + lw / 2, z1, lw, COL.habitatLine);
        if (!inside(x + 1, z)) this.habOutline.line(x1 - lw / 2, z0, x1 - lw / 2, z1, lw, COL.habitatLine);
      }
    }
    this.habOutline.end();
  }

  dispose(): void {
    this.disposed = true;
    this.dropGhost();
    this.dropAnimalGhost();
    this.host.ctx.scene.remove(this.group);
    this.fills.dispose();
    this.habOutline.dispose();
    this.grid.dispose();
    this.fences.dispose();
    for (const g of this.removeGhosts.values()) g.dispose();
    this.removeGhosts.clear();
    this.marker.dispose();
  }
}
