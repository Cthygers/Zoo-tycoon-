// Build tools. One-finger gestures (or left mouse) drive the active tool; the
// tool shows a live 3D preview (sim dry-run for cost / validity) and, when the
// gesture ends, a pending action that the player must confirm (✓ / ✗).

import * as THREE from 'three';
import { MAP_H, MAP_W, TILE } from '../core/constants';
import type { CreatureModel, ICreatureFactory, IPropsLayer, IRenderContext, ISimulation, SpeciesSuitability } from '../core/contracts';
import type { TileRect } from '../core/events';
import { PathType, Terrain, type CommandResult, type StaffRole, type Tool } from '../core/types';
import type { EdgeRef } from '../core/world';
import { FENCES_BY_ID, PATHS_BY_TYPE } from '../data/fences';
import { OBJECTS_BY_ID, rotatedSize } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import { STAFF_INFO, TERRAIN_INFO } from './catalog';
import { fmtMoney } from './dom';
import type { ToolInput } from './input';
import { COL, DrapedMesh, FenceGhosts, GridOverlay, Marker, disposeOwned, ghostify, surfaceY, tintGhost, type EdgeState, type RGBA } from './preview';

export interface PendingAction {
  title: string;
  verb: string;
  /** > 0 spend, < 0 refund. */
  cost: number;
  ok: boolean;
  note?: string;
  noteKind?: 'bad' | 'warn';
  commit(): CommandResult;
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

  readonly group = new THREE.Group();
  private fills: DrapedMesh;
  private habOutline: DrapedMesh;
  private grid: GridOverlay;
  private fences: FenceGhosts;
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
  private ghostTile: TP | null = null;
  private ghostLocked = false;
  private ghostOk = true;
  private prevGhostTile: TP | null = null;
  private prevGhostLocked = false;
  private moveOffset: TP = { x: 0, z: 0 };
  // animal / staff
  private point: TP | null = null;
  private prevPoint: TP | null = null;
  private animalModel: CreatureModel | null = null;
  private animalModelSpecies = '';

  private pending: PendingAction | null = null;
  private labelPos = new THREE.Vector3();
  private labelOn = false;
  private recheck = 0;
  private habOutlineId = 0;
  private habOutlineRev = -1;
  private tmpV = new THREE.Vector3();

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

  // ------------------------------------------------------------ tool selection
  setTool(tool: Tool): void {
    const sameKind = tool.kind === this.tool.kind;
    const prev = this.tool;
    this.tool = tool;
    const keepSel =
      sameKind &&
      ((tool.kind === 'fence') ||
        (tool.kind === 'path') ||
        (tool.kind === 'terrain' && prev.kind === 'terrain'));
    if (!keepSel) this.resetState();
    if (tool.kind !== 'object' && this.ghost) this.dropGhost();
    if (tool.kind === 'object' && this.ghostDef !== tool.defId) this.dropGhost();
    if (tool.kind !== 'animal') this.dropAnimalModel();
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

  private resetState(): void {
    this.gesture = false;
    this.sel = null;
    this.prevSel = null;
    this.point = null;
    this.prevPoint = null;
    this.ghostTile = null;
    this.ghostLocked = false;
    this.fills.clear();
    this.fences.clear();
    this.marker.hide();
    this.setPending(null);
    this.setLabel(null);
  }

  /** Cancel the pending action but keep the tool. */
  cancelPending(): void {
    this.resetState();
    if (this.ghost) this.ghost.visible = false;
    this.dropAnimalModel();
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

  confirm(): CommandResult | null {
    const p = this.pending;
    if (!p || !p.ok || this.gesture) return null;
    const r = p.commit();
    if (r.ok) {
      this.host.onCommitted(r);
      this.resetState();
      if (this.ghost) this.ghost.visible = false;
      this.dropAnimalModel();
      if (this.tool.kind === 'animal') this.host.onAnimalPreview({ speciesId: this.tool.speciesId, habitatId: null, suitability: null, result: null });
    } else this.refresh();
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
      case 'path':
      case 'terrain':
      case 'bulldoze': {
        const c = this.tileOf(p);
        this.prevSel = this.sel;
        this.sel = { a: c, b: { ...c } };
        break;
      }
      case 'object': {
        const tile = this.tileOf(p);
        this.prevGhostTile = this.ghostTile ? { ...this.ghostTile } : null;
        this.prevGhostLocked = this.ghostLocked;
        const def = OBJECTS_BY_ID[t.defId];
        const [w, d] = rotatedSize(def, t.rot);
        if (this.ghostLocked && this.ghostTile) {
          const g = this.ghostTile;
          const near = tile.x >= g.x - 2 && tile.x <= g.x + w + 1 && tile.z >= g.z - 2 && tile.z <= g.z + d + 1;
          if (near) {
            this.moveOffset = { x: g.x - tile.x, z: g.z - tile.z };
            break;
          }
        }
        this.moveOffset = { x: -Math.floor((w - 1) / 2), z: -Math.floor((d - 1) / 2) };
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

  up(ndcX: number, ndcY: number, _tap: boolean): void {
    if (!this.gesture) return;
    this.ptrNdc.x = ndcX;
    this.ptrNdc.y = ndcY;
    this.applyPointer();
    this.gesture = false;
    this.refresh();
  }

  cancel(): void {
    if (!this.gesture) return;
    this.gesture = false;
    this.ptrDirty = false;
    this.sel = this.prevSel;
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
      case 'path':
      case 'terrain':
      case 'bulldoze':
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
          const def = OBJECTS_BY_ID[this.tool.defId];
          const [w, d] = rotatedSize(def, this.tool.rot);
          const tile = this.tileOf(p);
          this.ghostTile = { x: tile.x - Math.floor((w - 1) / 2), z: tile.z - Math.floor((d - 1) / 2) };
          this.refresh();
        }
      }
    }
    this.marker.update(dt);
    if (this.animalModel) this.animalModel.update(dt, { action: 'idle', speed: 0 });
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

  /** Project the label anchor each frame (camera moves). */
  labelAnchor(): THREE.Vector3 | null {
    return this.labelOn ? this.labelPos : null;
  }

  // ------------------------------------------------------------ preview + pending
  private setPending(p: PendingAction | null): void {
    this.pending = p;
    this.host.onPending(this.gesture ? null : p);
  }

  private setLabel(pos: { x: number; z: number } | null, text = '', sub = '', ok = true): void {
    if (!pos) {
      this.labelOn = false;
      this.host.onLabel(null, '', '', true);
      return;
    }
    this.labelOn = true;
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
        return this.previewBulldoze();
      case 'object':
        return this.previewObject(this.tool.defId, this.tool.rot);
      case 'animal':
        return this.previewAnimal(this.tool.speciesId);
      case 'staff':
        return this.previewStaff(this.tool.role);
      default:
        this.fills.clear();
        this.fences.clear();
        this.marker.hide();
        this.setPending(null);
        this.setLabel(null);
    }
  }

  private note(r: CommandResult): { note?: string; noteKind?: 'bad' | 'warn' } {
    if (!r.reason) return {};
    return { note: r.reason, noteKind: r.ok ? 'warn' : 'bad' };
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
    // crisp draped line under the ghosts so the run reads clearly over any scenery
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const c = states[i] === 'blocked' ? COL.badLine : states[i] === 'same' ? FENCE_SAME : COL.okLine;
      if (e.dir === 'h') this.fills.line(e.x * TILE, e.z * TILE, (e.x + 1) * TILE, e.z * TILE, 0.22, c);
      else this.fills.line(e.x * TILE, e.z * TILE, e.x * TILE, (e.z + 1) * TILE, 0.22, c);
    }
    // faint fill of the area that will be enclosed (rect mode)
    const s = this.sel!;
    if (this.fenceMode === 'rect' && s.a.x !== s.b.x && s.a.z !== s.b.z) {
      const x0 = Math.min(s.a.x, s.b.x) * TILE,
        x1 = Math.max(s.a.x, s.b.x) * TILE,
        z0 = Math.min(s.a.z, s.b.z) * TILE,
        z1 = Math.max(s.a.z, s.b.z) * TILE;
      const sub = Math.min(24, Math.max(2, Math.round(Math.max(x1 - x0, z1 - z0) / 2)));
      this.fills.rect(x0, z0, x1, z1, COL.habitat, sub);
    }
    this.fills.end();
    const def = FENCES_BY_ID[fenceId];
    const r = sim.placeFences(edges, fenceId, true);
    const n = states.filter((x) => x === 'new').length;
    const metres = n * TILE;
    const area = this.fenceMode === 'rect' && s.a.x !== s.b.x && s.a.z !== s.b.z ? Math.abs(s.b.x - s.a.x) * Math.abs(s.b.z - s.a.z) : 0;
    this.setLabel({ x: s.b.x * TILE, z: s.b.z * TILE }, fmtMoney(r.cost), area ? `${metres} m · ${area} tiles` : `${metres} m`, r.ok);
    this.setPending({
      title: `${def?.name ?? 'Fence'} · ${metres} m`,
      verb: 'Build',
      cost: r.cost,
      ok: r.ok,
      ...this.note(r),
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
    this.setLabel({ x: (end.x + 0.5) * TILE, z: (end.z + 0.5) * TILE }, fmtMoney(r.cost), `${tiles.length} tile${tiles.length > 1 ? 's' : ''}`, r.ok);
    this.setPending({
      title: `${def?.name ?? 'Path'} · ${tiles.length} tile${tiles.length > 1 ? 's' : ''}`,
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
      verb: 'Paint',
      cost: res.cost,
      ok: res.ok,
      ...this.note(res),
      commit: () => sim.paintTerrain(rect, t),
    });
  }

  private previewBulldoze(): void {
    const sim = this.host.sim;
    const r = this.rectOfSel(1);
    this.fills.begin();
    let res: CommandResult | null = null;
    if (r) {
      const sub = Math.min(48, Math.max(2, (Math.max(r.x1 - r.x0, r.z1 - r.z0) + 1) * 2));
      this.fills.rect(r.x0 * TILE, r.z0 * TILE, (r.x1 + 1) * TILE, (r.z1 + 1) * TILE, COL.remove, sub);
      res = sim.bulldoze(r, true);
      this.fills.outline(r.x0, r.z0, r.x1, r.z1, 0.14, COL.removeLine);
      // mark objects that will be removed
      const w = sim.world;
      const seen = new Set<number>();
      for (let z = r.z0; z <= r.z1; z++)
        for (let x = r.x0; x <= r.x1; x++) {
          const o = w.objectAt(x, z);
          if (!o || seen.has(o.id) || o.defId === 'entrance_gate') continue;
          seen.add(o.id);
          for (const ft of w.footprint(o)) this.fills.tile(ft.x, ft.z, [1, 0.3, 0.2, 0.3], 0.18);
        }
    }
    this.fills.end();
    if (!r || !res) {
      this.setPending(null);
      this.setLabel(null);
      return;
    }
    const refund = -res.cost;
    this.setLabel({ x: (r.x1 + 1) * TILE, z: (r.z1 + 1) * TILE }, res.ok ? `+${fmtMoney(refund)}` : 'Nothing here', `${r.x1 - r.x0 + 1}×${r.z1 - r.z0 + 1}`, res.ok);
    const rect = { ...r };
    this.setPending({
      title: `Clear ${r.x1 - r.x0 + 1}×${r.z1 - r.z0 + 1} area`,
      verb: 'Remove',
      cost: res.cost,
      ok: res.ok,
      ...this.note(res),
      commit: () => sim.bulldoze(rect),
    });
  }

  // ---- objects
  private dropGhost(): void {
    if (this.ghost) {
      this.group.remove(this.ghost);
      disposeOwned(this.ghost);
    }
    this.ghost = null;
    this.ghostDef = '';
    this.ghostTile = null;
    this.ghostLocked = false;
  }

  private previewObject(defId: string, rot: number): void {
    const sim = this.host.sim;
    const def = OBJECTS_BY_ID[defId];
    if (!def) return;
    if (!this.ghost || this.ghostDef !== defId) {
      this.dropGhost();
      try {
        this.ghost = this.host.props.createObjectModel(defId, 1);
        ghostify(this.ghost);
        this.ghostDef = defId;
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
    const r = sim.placeObject(defId, t.x, t.z, rot, true);
    if (this.ghost) {
      this.ghost.visible = true;
      this.ghost.position.set(cx, sim.world.heightAt(cx, cz), cz);
      this.ghost.rotation.set(0, (rot * Math.PI) / 2, 0);
      if (r.ok !== this.ghostOk || !this.ghost.userData.tinted) {
        tintGhost(this.ghost, r.ok);
        this.ghost.userData.tinted = true;
        this.ghostOk = r.ok;
      }
    }
    for (let z = t.z; z < t.z + d; z++) for (let x = t.x; x < t.x + w; x++) this.fills.tile(x, z, r.ok ? COL.ok : COL.bad, 0.05);
    this.fills.outline(t.x, t.z, t.x + w - 1, t.z + d - 1, 0.1, r.ok ? COL.okLine : COL.badLine);
    this.fills.end();
    if (!this.ghostLocked) {
      // desktop hover preview: no pending until click
      this.setPending(null);
      this.setLabel(null);
      return;
    }
    this.setLabel({ x: cx, z: cz }, fmtMoney(def.cost), r.ok ? def.name : r.reason ?? '', r.ok);
    const tx = t.x,
      tz = t.z;
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
  private dropAnimalModel(): void {
    if (this.animalModel) {
      this.group.remove(this.animalModel.object);
      this.animalModel.dispose();
    }
    this.animalModel = null;
    this.animalModelSpecies = '';
  }

  private previewAnimal(speciesId: string): void {
    const sim = this.host.sim;
    const sp = SPECIES_BY_ID[speciesId];
    this.fills.clear();
    const p = this.point;
    if (!p || !sp) {
      this.marker.hide();
      this.dropAnimalModel();
      this.setPending(null);
      this.setLabel(null);
      this.host.onAnimalPreview({ speciesId, habitatId: null, suitability: null, result: null });
      return;
    }
    const w = sim.world;
    const tile = w.tileOfWorld(p.x, p.z);
    const hab = w.habitatAt(tile.x, tile.z);
    const r = sim.buyAnimal(speciesId, p.x, p.z, true);
    const y = surfaceY(w, p.x, p.z) - 0.05;
    this.marker.place(p.x, y, p.z, r.ok, Math.max(0.8, Math.min(2.6, sp.length * 0.45)));
    let suit: SpeciesSuitability | null = null;
    if (hab) {
      try {
        suit = sim.suitability(speciesId, hab.id);
      } catch {
        suit = null;
      }
    }
    // live model preview at the spot (hidden while the finger is dragging the marker)
    if (r.ok && !this.gesture) {
      if (!this.animalModel || this.animalModelSpecies !== speciesId) {
        this.dropAnimalModel();
        try {
          this.animalModel = this.host.creatures.createAnimal(speciesId, { seed: 4711, sex: 'F', growth: 1 });
          this.animalModelSpecies = speciesId;
          this.group.add(this.animalModel.object);
        } catch (err) {
          console.warn('[ui] animal preview failed', err);
        }
      }
      if (this.animalModel) {
        const o = this.animalModel.object;
        o.visible = true;
        o.position.set(p.x, w.heightAt(p.x, p.z), p.z);
        const cam = this.host.ctx.camera.position;
        o.rotation.set(0, Math.atan2(cam.x - p.x, cam.z - p.z) + 0.7, 0);
      }
    } else if (this.animalModel) this.animalModel.object.visible = false;
    this.host.onAnimalPreview({ speciesId, habitatId: hab?.id ?? null, suitability: suit, result: r });
    this.setLabel(null);
    const px = p.x,
      pz = p.z;
    this.setPending({
      title: `${sp.name}${hab ? ` · ${hab.name}` : ''}`,
      verb: 'Adopt',
      cost: r.cost,
      ok: r.ok,
      ...this.note(r),
      commit: () => sim.buyAnimal(speciesId, px, pz),
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
      cost: r.cost,
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
    this.dropGhost();
    this.dropAnimalModel();
    this.host.ctx.scene.remove(this.group);
    this.fills.dispose();
    this.habOutline.dispose();
    this.grid.dispose();
    this.fences.dispose();
    this.marker.dispose();
  }
}
