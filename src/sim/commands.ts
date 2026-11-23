// Player commands: validate (via World helpers), price (from the data
// catalogues), charge, mutate and report. Every command supports dryRun for
// ghost previews: nothing changes and the result carries cost / validity.

import { ENTRANCE_PLAZA, ENTRANCE_TILE, MAP_H, MAP_W, TILE } from '../core/constants';
import type { TileRect } from '../core/events';
import { fmtMoney } from '../core/format';
import { PathType, Terrain, isWater, type AnimalState, type CommandResult, type Habitat, type PlacedObject, type SpeciesDef, type StaffRole } from '../core/types';
import type { EdgeRef, EnclosureProblem } from '../core/world';
import { FENCES_BY_ID, PATHS_BY_TYPE } from '../data/fences';
import { OBJECTS_BY_ID, rotatedSize } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import { evaluateSpecies, weakestFenceName } from './habitat';
import { STAFF_SALARY, STAFF_TITLE } from './names';

/** Price to repaint one tile with `terrain` (0 for unknown terrain). */
export function terrainCost(terrain: Terrain): number {
  return TERRAIN_COST[terrain] ?? 0;
}
/** Daily wage of a staff role (0 for an unknown role). */
export function staffWage(role: StaffRole): number {
  return STAFF_SALARY[role] ?? 0;
}
import type { Simulation } from './simulation';

/** Price per tile to repaint terrain (index = Terrain). Water is dug out, snow and rock are imported. */
export const TERRAIN_COST: readonly number[] = [
  4, // Grass
  4, // DryGrass
  3, // Dirt
  5, // Sand
  6, // Rock
  7, // Snow
  4, // Mud
  12, // Water
  18, // DeepWater
];
export const REFUND_FRACTION = 0.4;

/** Most important first: what keeps a fenced-off area from becoming a habitat. */
const PROBLEM_ORDER: readonly EnclosureProblem[] = ['path', 'mapEdge', 'tooBig'];
const NOT_A_HABITAT: Record<EnclosureProblem, string> = {
  path: 'Not a habitat yet: a path runs inside the fence (bulldoze it)',
  mapEdge: 'Not a habitat yet: the fence must close on every side (the map edge doesn’t count)',
  tooBig: 'Not a habitat yet: a habitat can cover at most half of the map',
};
/** Longest habitat name (characters). */
export const MAX_HABITAT_NAME = 32;
export const SELL_FRACTION = 0.5;


export class Commands {
  /** Wall-clock throttle for failure toasts while dragging tools. */
  private lastFail = new Map<string, number>();
  /** Scratch buffers for the path reachability check (bulldoze previews run it every frame of a drag). */
  private scratchSeen = new Uint8Array(MAP_W * MAP_H);
  private scratchGone = new Uint8Array(MAP_W * MAP_H);
  private scratchQueue = new Int32Array(MAP_W * MAP_H);

  constructor(private sim: Simulation) {}

  // ------------------------------------------------------------ helpers
  private result(
    ok: boolean,
    cost: number,
    reason: string | undefined,
    dryRun: boolean,
    at?: { x: number; z: number },
    warning?: string,
  ): CommandResult {
    cost ||= 0; // a zero refund is 0, not -0
    const r: CommandResult = reason ? { ok, cost, reason } : { ok, cost };
    if (ok && warning) r.warning = warning;
    if (!dryRun) {
      this.sim.events.emit('commandResult', at ? { ...r, x: at.x, z: at.z } : { ...r });
      if (!ok && reason) this.toastFail(reason, at);
      else if (ok && (reason || warning)) this.sim.notify(null, [reason, warning].filter(Boolean).join(' — '), 'warn', at);
      this.sim.flushMoney();
    }
    return r;
  }

  /** Refund for removing an object; the scenery the map started with was free. */
  private objectRefund(o: PlacedObject): number {
    if (o.id <= this.sim.starterObjectMaxId) return 0;
    return Math.round((OBJECTS_BY_ID[o.defId]?.cost ?? 0) * REFUND_FRACTION);
  }

  /** Refund for removing a path tile; the starter paths were free. */
  private pathRefund(x: number, z: number, p: PathType): number {
    if (this.sim.starterPath[this.sim.world.idx(x, z)]) return 0;
    return Math.round((PATHS_BY_TYPE[p]?.costPerTile ?? 0) * REFUND_FRACTION);
  }

  /** Unique number for an edge (h edges first, then v edges). */
  private edgeKey(e: EdgeRef): number {
    const w = this.sim.world;
    return e.dir === 'h' ? w.hIdx(e.x, e.z) : w.hFence.length + w.vIdx(e.x, e.z);
  }

  private toastFail(reason: string, at?: { x: number; z: number }) {
    const now = Date.now();
    const last = this.lastFail.get(reason) ?? 0;
    if (now - last < 2500) return;
    this.lastFail.set(reason, now);
    this.sim.notify(null, reason, 'warn', at);
  }

  private noMoney(cost: number): string {
    return this.sim.money < 0
      ? `Your zoo is in debt — earn money before building (needs ${fmtMoney(cost)})`
      : `Not enough money (needs ${fmtMoney(cost)}, you have ${fmtMoney(this.sim.money)})`;
  }

  private rectCentre(r: TileRect) {
    return { x: ((r.x0 + r.x1 + 1) / 2) * TILE, z: ((r.z0 + r.z1 + 1) / 2) * TILE };
  }

  /** Natural scenery that paths may clear (not buildings, not habitat furniture). */
  private isNatural(defId: string): boolean {
    const c = OBJECTS_BY_ID[defId]?.category;
    return c === 'tree' || c === 'plant' || c === 'rock';
  }

  /** Entrance plaza tiles are protected from removal so guests can always get in. */
  private isProtectedPath(x: number, z: number): boolean {
    const p = ENTRANCE_PLAZA;
    return x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1;
  }

  // ------------------------------------------------------------ terrain
  paintTerrain(rect: TileRect, terrain: Terrain, dryRun = false): CommandResult {
    const w = this.sim.world;
    if (!(terrain >= Terrain.Grass && terrain <= Terrain.DeepWater)) return this.result(false, 0, 'Unknown terrain', dryRun);
    const r = w.clampRect(rect);
    const at = this.rectCentre(r);
    const water = isWater(terrain);
    let count = 0;
    let blocked = 0;
    let blockReason = '';
    const allowed = (x: number, z: number): boolean => {
      const i = w.idx(x, z);
      if (w.terrain[i] === terrain) return false;
      if (water) {
        if (w.path[i]) {
          blockReason = 'Cannot flood path tiles';
          return false;
        }
        const o = w.objectAt(x, z);
        if (o && !(o.defId === 'reeds' && terrain === Terrain.Water)) {
          blockReason = 'Cannot flood under objects';
          return false;
        }
      }
      return true;
    };
    for (let z = r.z0; z <= r.z1; z++)
      for (let x = r.x0; x <= r.x1; x++) {
        if (allowed(x, z)) count++;
        else if (w.terrain[w.idx(x, z)] !== terrain) blocked++;
      }
    const cost = count * terrainCost(terrain);
    if (count === 0) return this.result(false, 0, blocked ? blockReason : 'Already that terrain', dryRun, at);
    if (!this.sim.canAfford(cost)) return this.result(false, cost, this.noMoney(cost), dryRun, at);
    if (dryRun) return this.result(true, cost, blocked ? `${blocked} tile(s) skipped: ${blockReason}` : undefined, true, at);
    w.setTerrainRect(r, terrain, allowed);
    this.sim.spend('construction', cost);
    return this.result(true, cost, undefined, false, at);
  }

  // -------------------------------------------------------------- paths
  placePaths(tiles: { x: number; z: number }[], type: PathType, dryRun = false): CommandResult {
    const w = this.sim.world;
    const def = PATHS_BY_TYPE[type];
    if (!def) return this.result(false, 0, 'Unknown path type', dryRun);
    const seen = new Set<number>();
    const todo: { x: number; z: number }[] = [];
    const clear = new Set<number>();
    let firstReason = '';
    for (const t of tiles) {
      if (!w.inBounds(t.x, t.z)) {
        firstReason ||= 'Out of bounds';
        continue;
      }
      const i = w.idx(t.x, t.z);
      if (seen.has(i)) continue;
      seen.add(i);
      if (w.path[i] === type) continue;
      let why = w.canPlacePath(t.x, t.z, type);
      if (why && !w.habitatOf[i]) {
        // wild trees, plants and rocks are cleared to make way for the path
        const o = w.objectAt(t.x, t.z);
        if (o && this.isNatural(o.defId)) {
          clear.add(o.id);
          why = null;
          if (isWater(w.terrain[i] as Terrain) && type !== PathType.Boardwalk) why = 'Only boardwalks can cross water';
        }
      }
      if (why) {
        firstReason ||= why;
        continue;
      }
      todo.push(t);
    }
    const at = tiles.length ? { x: (tiles[0].x + 0.5) * TILE, z: (tiles[0].z + 0.5) * TILE } : undefined;
    if (!todo.length) return this.result(false, 0, firstReason || 'Path already there', dryRun, at);
    const cost = todo.length * def.costPerTile;
    if (!this.sim.canAfford(cost)) return this.result(false, cost, this.noMoney(cost), dryRun, at);
    const note = clear.size ? `Clears ${clear.size} tree${clear.size > 1 ? 's' : ''}/plant${clear.size > 1 ? 's' : ''} in the way` : undefined;
    if (dryRun) return this.result(true, cost, note, true, at);
    for (const id of clear) w.removeObject(id);
    for (const t of todo) {
      w.setPath(t.x, t.z, type);
      this.sim.starterPath[w.idx(t.x, t.z)] = 0; // bought now
    }
    // viewing tiles next to habitats depend on paths
    w.refreshHabitatStats();
    this.sim.spend('construction', cost);
    return this.result(true, cost, undefined, false, at);
  }

  // ------------------------------------------------------------- fences
  private edgeTiles(e: EdgeRef): [number, number, number, number] {
    return e.dir === 'h' ? [e.x, e.z - 1, e.x, e.z] : [e.x - 1, e.z, e.x, e.z];
  }

  private fenceBlocked(e: EdgeRef): string | null {
    const w = this.sim.world;
    const [ax, az, bx, bz] = this.edgeTiles(e);
    const aIn = w.inBounds(ax, az),
      bIn = w.inBounds(bx, bz);
    if (aIn && bIn && w.isPath(ax, az) && w.isPath(bx, bz)) return 'Fences cannot cross paths';
    if (aIn && bIn) {
      const oa = w.objectGrid[w.idx(ax, az)];
      if (oa && oa === w.objectGrid[w.idx(bx, bz)]) return 'A fence would cut through an object';
    }
    return null;
  }

  placeFences(edges: EdgeRef[], fenceId: number, dryRun = false): CommandResult {
    const w = this.sim.world;
    const def = FENCES_BY_ID[fenceId];
    if (!def) return this.result(false, 0, 'Unknown fence type', dryRun);
    const seen = new Set<number>();
    const todo: EdgeRef[] = [];
    let price = 0;
    let refund = 0; // for the fences being replaced
    let firstReason = '';
    for (const e of edges) {
      if (!w.edgeInBounds(e)) continue;
      const k = this.edgeKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = w.getFence(e);
      if (cur === fenceId) continue;
      const why = this.fenceBlocked(e);
      if (why) {
        firstReason ||= why;
        continue;
      }
      price += def.costPerSegment;
      if (cur) refund += Math.round((FENCES_BY_ID[cur]?.costPerSegment ?? 0) * REFUND_FRACTION);
      todo.push(e);
    }
    const cost = price - refund;
    const at = edges.length ? this.edgeCentre(edges[Math.floor(edges.length / 2)]) : undefined;
    if (!todo.length) return this.result(false, 0, firstReason || 'Fence already there', dryRun, at);
    if (!this.sim.canAfford(cost)) return this.result(false, cost, this.noMoney(cost), dryRun, at);
    // an outline (e.g. a dragged rectangle) with segments that can't be built won't close
    const broken = !!firstReason && this.isClosedOutline(edges);
    if (dryRun) return this.result(true, cost, firstReason ? `Some segments skipped: ${firstReason}` : undefined, true, at, this.enclosureWarning(todo, todo, broken));
    for (const e of todo) w.setFence(e, fenceId, false);
    w.recomputeHabitats();
    this.sim.spend('construction', price);
    this.sim.earn('other', refund);
    this.sim.markPopulationDirty();
    return this.result(true, cost, undefined, false, at, this.enclosureWarning(todo, [], broken));
  }

  private edgeCentre(e: EdgeRef) {
    return e.dir === 'h' ? { x: (e.x + 0.5) * TILE, z: e.z * TILE } : { x: e.x * TILE, z: (e.z + 0.5) * TILE };
  }

  /** Do the edges form closed outlines by themselves (every fence post joins an even number of them)? */
  private isClosedOutline(edges: EdgeRef[]): boolean {
    const w = this.sim.world;
    const seen = new Set<number>();
    const posts = new Map<number, number>();
    const post = (cx: number, cz: number) => {
      const k = cz * (MAP_W + 1) + cx;
      posts.set(k, (posts.get(k) ?? 0) + 1);
    };
    for (const e of edges) {
      if (!w.edgeInBounds(e) || seen.has(this.edgeKey(e))) continue;
      seen.add(this.edgeKey(e));
      post(e.x, e.z);
      if (e.dir === 'h') post(e.x + 1, e.z);
      else post(e.x, e.z + 1);
    }
    if (seen.size < 4) return false;
    for (const n of posts.values()) if (n % 2) return false;
    return true;
  }

  /**
   * Warning when fences close off an area that still won't become a habitat (a path
   * inside, the map edge used as a side…), or when an outline can't be built whole
   * so the area stays open. `pending` = fences not built yet (dry run).
   */
  private enclosureWarning(placed: EdgeRef[], pending: EdgeRef[], brokenOutline: boolean): string | undefined {
    const problemAt = this.sim.world.enclosureProblems(pending);
    let worst = -1;
    for (const e of placed) {
      const [ax, az, bx, bz] = this.edgeTiles(e);
      for (const p of [problemAt(ax, az), problemAt(bx, bz)]) {
        const rank = p ? PROBLEM_ORDER.indexOf(p) : -1;
        if (rank >= 0 && (worst < 0 || rank < worst)) worst = rank;
      }
    }
    if (worst >= 0) return NOT_A_HABITAT[PROBLEM_ORDER[worst]];
    return brokenOutline ? 'Not a habitat yet: fences can’t cross a path, so this one won’t close' : undefined;
  }

  /**
   * Warning for removing fences: which habitats open up (their animals can wander
   * out through the gap) or are joined with a neighbour.
   */
  private openingWarning(removed: EdgeRef[]): string | undefined {
    const w = this.sim.world;
    const gone = new Set(removed.map((e) => this.edgeKey(e)));
    const touched = new Set<number>();
    for (const e of removed) {
      const [ax, az, bx, bz] = this.edgeTiles(e);
      if (w.inBounds(ax, az) && w.habitatOf[w.idx(ax, az)]) touched.add(w.habitatOf[w.idx(ax, az)]);
      if (w.inBounds(bx, bz) && w.habitatOf[w.idx(bx, bz)]) touched.add(w.habitatOf[w.idx(bx, bz)]);
    }
    const notes: string[] = [];
    const joined = new Set<number>();
    for (const id of touched) {
      const hab = w.habitats.get(id);
      if (!hab || joined.has(id)) continue;
      const { opens, joins } = this.floodWithout(hab, gone);
      if (opens) {
        let n = 0;
        for (const a of this.sim.animals.values()) if (!a.escaped && a.habitatId === id) n++;
        notes.push(n ? `Opens ${hab.name} — ${n} animal${n > 1 ? 's' : ''} can wander out` : `Opens ${hab.name} (it stops being a habitat)`);
      } else if (joins) {
        joined.add(joins);
        notes.push(`Joins ${hab.name} with ${w.habitats.get(joins)?.name ?? 'the next habitat'}`);
      }
    }
    return notes.length ? notes.join('; ') : undefined;
  }

  /** Flood out from a habitat as if the `gone` edges were removed: does it reach public ground, or another habitat? */
  private floodWithout(hab: Habitat, gone: Set<number>): { opens: boolean; joins: number } {
    const w = this.sim.world;
    const seen = new Uint8Array(MAP_W * MAP_H);
    const stack = [hab.tiles[0]];
    seen[stack[0]] = 1;
    let joins = 0;
    while (stack.length) {
      const i = stack.pop()!;
      const h = w.habitatOf[i];
      if (!h) return { opens: true, joins };
      if (h !== hab.id) joins ||= h;
      const x = i % MAP_W,
        z = (i / MAP_W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0),
          nz = z + (k === 2 ? 1 : k === 3 ? -1 : 0);
        const edge: EdgeRef = nx !== x ? { dir: 'v', x: Math.max(x, nx), z } : { dir: 'h', x, z: Math.max(z, nz) };
        if (w.getFence(edge) && !gone.has(this.edgeKey(edge))) continue;
        if (!w.inBounds(nx, nz)) return { opens: true, joins }; // through the map edge
        const ni = w.idx(nx, nz);
        if (seen[ni]) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
    return { opens: false, joins };
  }

  removeFences(edges: EdgeRef[], dryRun = false): CommandResult {
    const w = this.sim.world;
    const seen = new Set<number>();
    const todo: EdgeRef[] = [];
    let refund = 0;
    for (const e of edges) {
      if (!w.edgeInBounds(e)) continue;
      const k = this.edgeKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = w.getFence(e);
      if (!cur) continue;
      refund += Math.round((FENCES_BY_ID[cur]?.costPerSegment ?? 0) * REFUND_FRACTION);
      todo.push(e);
    }
    const at = edges.length ? this.edgeCentre(edges[0]) : undefined;
    if (!todo.length) return this.result(false, 0, 'No fence to remove', dryRun, at);
    const warning = this.openingWarning(todo);
    if (dryRun) return this.result(true, -refund, undefined, true, at, warning);
    for (const e of todo) w.setFence(e, 0, false);
    w.recomputeHabitats();
    this.sim.earn('other', refund);
    this.sim.markPopulationDirty();
    return this.result(true, -refund, undefined, false, at, warning);
  }

  // ------------------------------------------------------------ objects
  placeObject(defId: string, tx: number, tz: number, rot: number, dryRun = false): CommandResult {
    const w = this.sim.world;
    const def = OBJECTS_BY_ID[defId];
    const at = { x: (tx + 0.5) * TILE, z: (tz + 0.5) * TILE };
    if (!def) return this.result(false, 0, 'Unknown object', dryRun, at);
    if (def.notBuildable) return this.result(false, 0, `${def.name} cannot be built`, dryRun, at);
    const spot = this.objectSpot(defId, tx, tz, rot);
    if (spot.why) return this.result(false, def.cost, spot.why, dryRun, at);
    if (!this.sim.canAfford(def.cost)) return this.result(false, def.cost, this.noMoney(def.cost), dryRun, at);
    if (dryRun) return this.result(true, def.cost, undefined, true, at);
    const o = w.addObject(defId, tx, tz, spot.rot, this.sim.rng.int(0, 0x7fffffff));
    this.sim.spend('construction', def.cost);
    const c = w.objectCenter(o);
    return this.result(true, def.cost, undefined, false, { x: c.x, z: c.z });
  }

  /**
   * Can object `defId` stand at (tx, tz) turned `rot`? Returns why not (null = fine) and
   * the rotation it gets (shops and restrooms turn to open onto a path).
   */
  private objectSpot(defId: string, tx: number, tz: number, rot: number): { why: string | null; rot: number } {
    const w = this.sim.world;
    const def = OBJECTS_BY_ID[defId];
    let r = ((Math.round(rot) % 4) + 4) % 4;
    const why = w.canPlaceObject(def, tx, tz, r);
    if (why) return { why, rot: r };
    if (def.shop || def.restroom) r = this.faceThePath(defId, tx, tz, r);
    // keep animals from being buried under solid objects
    if (def.solid) {
      for (const t of w.footprint({ defId, tx, tz, rot: r })) {
        for (const a of this.sim.animals.values()) {
          if (Math.floor(a.x / TILE) === t.x && Math.floor(a.z / TILE) === t.z) return { why: 'An animal is standing there', rot: r };
        }
      }
    }
    return { why: null, rot: r };
  }

  /** Move and/or turn a placed object for free. It keeps its id, so selection, refund rules and save references stay valid. */
  moveObject(objectId: number, tx: number, tz: number, rot: number, dryRun = false): CommandResult {
    const sim = this.sim;
    const w = sim.world;
    const o = w.objects.get(objectId);
    const at = { x: (tx + 0.5) * TILE, z: (tz + 0.5) * TILE };
    if (!o) return this.result(false, 0, 'Nothing to move', dryRun, at);
    const def = OBJECTS_BY_ID[o.defId];
    if (!def || o.defId === 'entrance_gate') return this.result(false, 0, 'The entrance cannot be moved', dryRun, at);
    // judge the new spot as if the object were already lifted off its current one
    const own: number[] = [];
    for (const t of w.footprint(o)) {
      const i = w.idx(t.x, t.z);
      if (w.inBounds(t.x, t.z) && w.objectGrid[i] === o.id) {
        own.push(i);
        w.objectGrid[i] = 0;
      }
    }
    let spot: { why: string | null; rot: number };
    try {
      spot = this.objectSpot(o.defId, tx, tz, rot);
    } finally {
      for (const i of own) w.objectGrid[i] = o.id;
    }
    if (spot.why) return this.result(false, 0, spot.why, dryRun, at);
    if (tx === o.tx && tz === o.tz && spot.rot === o.rot) return this.result(false, 0, 'Drag it to a new spot, or turn it', dryRun, at);
    if (dryRun) return this.result(true, 0, undefined, true, at);
    // guests queueing at / sitting on / walking to it change their plans first
    sim.guestSys.releaseObject(objectId);
    w.moveObject(objectId, tx, tz, spot.rot);
    sim.markPopulationDirty();
    const c = w.objectCenter(o);
    return this.result(true, 0, undefined, false, { x: c.x, z: c.z });
  }

  /**
   * Shops and restrooms serve guests from their front (+Z of the model). If the
   * requested rotation leaves the front facing away from every path, turn the
   * building (same footprint) so its counter / doors open onto a path.
   */
  private faceThePath(defId: string, tx: number, tz: number, rot: number): number {
    const w = this.sim.world;
    const def = OBJECTS_BY_ID[defId];
    const opens = (r: number): boolean => {
      const [fw, fd] = rotatedSize(def, r);
      const [ow, od] = rotatedSize(def, rot);
      if (fw !== ow || fd !== od) return false; // footprint must stay the same
      // tiles just beyond the front edge, front = (sin θ, cos θ) with θ = r·π/2
      const fx = [0, 1, 0, -1][r],
        fz = [1, 0, -1, 0][r];
      for (let i = 0; i < (fx ? fd : fw); i++) {
        const x = fx > 0 ? tx + fw : fx < 0 ? tx - 1 : tx + i;
        const z = fz > 0 ? tz + fd : fz < 0 ? tz - 1 : tz + i;
        if (!w.inBounds(x, z) || !w.isPath(x, z) || w.habitatOf[w.idx(x, z)]) continue;
        const ax = Math.min(Math.max(x, tx), tx + fw - 1),
          az = Math.min(Math.max(z, tz), tz + fd - 1);
        if (!w.fenceBetween(ax, az, x, z)) return true;
      }
      return false;
    };
    if (opens(rot)) return rot;
    for (const d of [1, 3, 2]) {
      const r = (rot + d) % 4;
      if (opens(r)) return r;
    }
    return rot;
  }

  /** Remove one placed object (partial refund); fences, paths and litter stay. */
  removeObject(objectId: number, dryRun = false): CommandResult {
    const sim = this.sim;
    const w = sim.world;
    const o = w.objects.get(objectId);
    if (!o) return this.result(false, 0, 'Nothing to remove', dryRun);
    const c = w.objectCenter(o);
    const at = { x: c.x, z: c.z };
    if (o.defId === 'entrance_gate') return this.result(false, 0, 'The entrance cannot be removed', dryRun, at);
    const refund = this.objectRefund(o);
    if (dryRun) return this.result(true, -refund, undefined, true, at);
    // guests queueing at / sitting on / walking to it change their plans first
    sim.guestSys.releaseObject(objectId);
    w.removeObject(objectId); // emits objectRemoved + habitatsChanged (habitat stats refreshed)
    sim.earn('other', refund);
    sim.markPopulationDirty();
    return this.result(true, -refund, undefined, false, at);
  }

  /** Rename a habitat: control characters stripped, whitespace collapsed, max MAX_HABITAT_NAME chars. */
  renameHabitat(habitatId: number, name: string): CommandResult {
    const w = this.sim.world;
    const hab = w.habitats.get(habitatId);
    if (!hab) return this.result(false, 0, 'No such habitat', false);
    const at = { x: ((hab.minX + hab.maxX + 1) / 2) * TILE, z: ((hab.minZ + hab.maxZ + 1) / 2) * TILE };
    // eslint-disable-next-line no-control-regex
    const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return this.result(false, 0, 'Please enter a name', false, at);
    const chars = Array.from(clean); // keep surrogate pairs (emoji) intact
    const n = chars.length > MAX_HABITAT_NAME ? chars.slice(0, MAX_HABITAT_NAME).join('').trimEnd() : clean;
    if (n !== hab.name) w.renameHabitat(habitatId, n); // emits habitatsChanged
    return this.result(true, 0, undefined, false, at);
  }

  // ----------------------------------------------------------- bulldoze
  bulldoze(rect: TileRect, dryRun = false): CommandResult {
    const w = this.sim.world;
    const r = w.clampRect(rect);
    const at = this.rectCentre(r);
    let refund = 0;
    const objs = new Set<number>();
    let protectedHit = false;
    for (let z = r.z0; z <= r.z1; z++)
      for (let x = r.x0; x <= r.x1; x++) {
        const o = w.objectAt(x, z);
        if (!o || objs.has(o.id)) continue;
        if (o.defId === 'entrance_gate') {
          protectedHit = true;
          continue;
        }
        objs.add(o.id);
        refund += this.objectRefund(o);
      }
    const paths: { x: number; z: number }[] = [];
    for (let z = r.z0; z <= r.z1; z++)
      for (let x = r.x0; x <= r.x1; x++) {
        const p = w.getPath(x, z);
        if (!p) continue;
        if (this.isProtectedPath(x, z)) {
          protectedHit = true;
          continue;
        }
        paths.push({ x, z });
        refund += this.pathRefund(x, z, p);
      }
    const fences: EdgeRef[] = [];
    for (let z = r.z0; z <= r.z1 + 1; z++)
      for (let x = r.x0; x <= r.x1; x++) {
        const e: EdgeRef = { dir: 'h', x, z };
        const f = w.getFence(e);
        if (f) {
          fences.push(e);
          refund += Math.round((FENCES_BY_ID[f]?.costPerSegment ?? 0) * REFUND_FRACTION);
        }
      }
    for (let z = r.z0; z <= r.z1; z++)
      for (let x = r.x0; x <= r.x1 + 1; x++) {
        const e: EdgeRef = { dir: 'v', x, z };
        const f = w.getFence(e);
        if (f) {
          fences.push(e);
          refund += Math.round((FENCES_BY_ID[f]?.costPerSegment ?? 0) * REFUND_FRACTION);
        }
      }
    const trash: number[] = [];
    for (const l of this.sim.litter.values()) {
      const tx = Math.floor(l.x / TILE),
        tz = Math.floor(l.z / TILE);
      if (tx >= r.x0 && tx <= r.x1 && tz >= r.z0 && tz <= r.z1) trash.push(l.id);
    }
    if (!objs.size && !paths.length && !fences.length && !trash.length)
      return this.result(false, 0, protectedHit ? 'The entrance cannot be removed' : 'Nothing to remove here', dryRun, at);
    const cut = paths.length ? this.pathTilesCutOff(paths) : 0;
    const warnings = [
      fences.length ? this.openingWarning(fences) : undefined,
      cut ? `Cuts ${cut} path tile${cut > 1 ? 's' : ''} off from the entrance — guests can’t get there` : undefined,
    ].filter(Boolean);
    const warning = warnings.length ? warnings.join('; ') : undefined;
    if (dryRun) return this.result(true, -refund, undefined, true, at, warning);
    for (const id of objs) this.sim.guestSys.releaseObject(id);
    for (const id of objs) w.removeObject(id);
    for (const p of paths) {
      w.setPath(p.x, p.z, PathType.None);
      this.sim.starterPath[w.idx(p.x, p.z)] = 0;
    }
    for (const e of fences) w.setFence(e, 0, false);
    if (fences.length || paths.length) w.recomputeHabitats();
    for (const id of trash) this.sim.removeLitter(id);
    this.sim.earn('other', refund);
    this.sim.markPopulationDirty();
    return this.result(true, -refund, undefined, false, at, warning);
  }

  /**
   * How many path tiles that guests can walk to from the entrance today would be
   * stranded if the `removed` tiles went (the removed ones themselves not counted).
   */
  private pathTilesCutOff(removed: { x: number; z: number }[]): number {
    const w = this.sim.world;
    const gone = this.scratchGone;
    gone.fill(0);
    for (const t of removed) gone[w.idx(t.x, t.z)] = 1;
    const before = this.walkPaths(null);
    let goneReached = 0;
    for (const t of removed) if (this.scratchSeen[w.idx(t.x, t.z)]) goneReached++;
    return before - goneReached - this.walkPaths(gone);
  }

  /** Path tiles reachable from the entrance as guests walk (4-neighbours, no fence between), skipping `gone` tiles. */
  private walkPaths(gone: Uint8Array | null): number {
    const w = this.sim.world;
    const seen = this.scratchSeen;
    const queue = this.scratchQueue;
    seen.fill(0);
    const start = w.idx(ENTRANCE_TILE.x, ENTRANCE_TILE.z);
    if (!w.path[start] || gone?.[start]) return 0;
    let head = 0,
      tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % MAP_W,
        z = (i / MAP_W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0),
          nz = z + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (!w.inBounds(nx, nz)) continue;
        const ni = w.idx(nx, nz);
        if (seen[ni] || !w.path[ni] || gone?.[ni] || w.fenceBetween(x, z, nx, nz)) continue;
        seen[ni] = 1;
        queue[tail++] = ni;
      }
    }
    return tail;
  }

  // ------------------------------------------------------------ animals
  buyAnimal(speciesId: string, wx: number, wz: number, dryRun = false): CommandResult {
    const sim = this.sim;
    const w = sim.world;
    const sp = SPECIES_BY_ID[speciesId];
    const at = { x: wx, z: wz };
    if (!sp) return this.result(false, 0, 'Unknown species', dryRun, at);
    const spot = this.animalSpot(sp, wx, wz, null);
    if (spot.why) return this.result(false, sp.cost, spot.why, dryRun, at);
    if (!sim.canAfford(sp.cost)) return this.result(false, sp.cost, this.noMoney(sp.cost), dryRun, at);
    if (dryRun) return this.result(true, sp.cost, undefined, true, at, spot.warning);
    const a = sim.animalSys.create(speciesId, wx, wz, { adult: true });
    sim.spend('animalPurchases', sp.cost);
    sim.events.emit('animalAdded', { id: a.id });
    sim.markPopulationDirty();
    return this.result(true, sp.cost, undefined, false, at, spot.warning);
  }

  /**
   * Can an animal of `sp` be put down at (wx, wz)? `why` = it can't; `warning` = it can, but
   * the habitat is risky or poor for it. `mover` is the animal being moved (null = a new one).
   */
  private animalSpot(sp: SpeciesDef, wx: number, wz: number, mover: AnimalState | null): { why?: string; warning?: string } {
    const sim = this.sim;
    const w = sim.world;
    const t = w.tileOfWorld(wx, wz);
    if (!w.inBounds(t.x, t.z)) return { why: 'Out of bounds' };
    const hab = w.habitatAt(t.x, t.z);
    if (!hab) {
      // fenced in, but not a habitat: say why
      const problem = w.enclosureProblems()(t.x, t.z);
      return { why: problem ? NOT_A_HABITAT[problem] : 'Animals must be placed inside a fenced habitat' };
    }
    if (w.isTileSolid(t.x, t.z)) return { why: 'Something is in the way — pick an open spot' };
    if (w.getTerrain(t.x, t.z) === Terrain.DeepWater && !sp.swims) return { why: `${sp.name}s can’t swim — place it on land` };
    const warn: string[] = [];
    if (hab.minFenceStrength < sp.danger) warn.push(`the fence is too weak for a ${sp.name} (use ${weakestFenceName(sp.danger)})`);
    // an animal moved within its own habitat is already part of the population
    const adding = !mover || mover.habitatId !== hab.id;
    const ev = evaluateSpecies(w, hab, sp, sim.population(hab.id), sim.keeperCount(), adding);
    if (ev.compat < 0.5) warn.push(ev.issues.find((i) => i.includes('predators')) ?? 'it does not get along with the other animals here');
    else if (ev.score < 0.45) warn.push(`this habitat suits it poorly (${Math.round(ev.score * 100)}%): ${ev.issues[0] ?? ''}`);
    else if (adding && ev.space < 0.95) {
      const crowded = ev.issues.find((i) => i.startsWith('Too crowded'));
      warn.push(`it would be too crowded here${crowded ? ` ${crowded.slice('Too crowded '.length)}` : ''}`);
    }
    if (!warn.length) return {};
    const text = warn.join('; ');
    return { warning: text[0].toUpperCase() + text.slice(1) };
  }

  /** Carry an animal to a spot inside a habitat (its own or another one), free of charge. */
  moveAnimal(animalId: number, wx: number, wz: number, dryRun = false): CommandResult {
    const sim = this.sim;
    const a = sim.animals.get(animalId);
    const at = { x: wx, z: wz };
    if (!a) return this.result(false, 0, 'No such animal', dryRun, at);
    const sp = SPECIES_BY_ID[a.speciesId];
    if (!sp) return this.result(false, 0, 'Unknown species', dryRun, at);
    // catching escapees is the staff's (or the paid rescue team's) job
    if (a.escaped) return this.result(false, 0, `${a.name} is on the loose — a keeper or vet has to catch it first`, dryRun, at);
    const spot = this.animalSpot(sp, wx, wz, a);
    if (spot.why) return this.result(false, 0, spot.why, dryRun, at);
    if (dryRun) return this.result(true, 0, undefined, true, at, spot.warning);
    sim.animalSys.relocate(a, wx, wz);
    return this.result(true, 0, undefined, false, at, spot.warning);
  }

  /** What an animal fetches when rehomed: part of its price, more for grown, healthy animals. */
  private saleValue(a: AnimalState): number {
    const sp = SPECIES_BY_ID[a.speciesId];
    return Math.round((sp?.cost ?? 0) * SELL_FRACTION * (0.4 + 0.6 * a.growth) * (0.5 + 0.5 * a.health));
  }

  sellAnimal(animalId: number, dryRun = false): CommandResult {
    const sim = this.sim;
    const a = sim.animals.get(animalId);
    if (!a) return this.result(false, 0, 'No such animal', dryRun);
    const sp = SPECIES_BY_ID[a.speciesId];
    const value = this.saleValue(a);
    if (dryRun) return this.result(true, -value, undefined, true, { x: a.x, z: a.z });
    sim.animalSys.remove(animalId);
    sim.earn('other', value);
    sim.notify(null, `${a.name} the ${sp?.name ?? 'animal'} was sold to another zoo for ${fmtMoney(value)}.`, 'info', { x: a.x, z: a.z });
    return this.result(true, -value, undefined, false, { x: a.x, z: a.z });
  }

  // -------------------------------------------------------------- staff
  hireStaff(role: StaffRole, wx: number, wz: number, dryRun = false): CommandResult {
    const sim = this.sim;
    const w = sim.world;
    const at = { x: wx, z: wz };
    const salary = STAFF_SALARY[role];
    if (!salary) return this.result(false, 0, 'Unknown staff role', dryRun, at);
    const t = w.tileOfWorld(wx, wz);
    const tx = Math.max(0, Math.min(MAP_W - 1, t.x)),
      tz = Math.max(0, Math.min(MAP_H - 1, t.z));
    sim.nav.sync();
    const tile = sim.nav.nearestPathTile(tx, tz, 4);
    if (tile < 0) return this.result(false, salary, `${STAFF_TITLE[role]}s must be placed on a path`, dryRun, at);
    if (!sim.canAfford(salary)) return this.result(false, salary, this.noMoney(salary), dryRun, at);
    // nothing is charged now: wages are paid at day end, the first day only for the hours left
    if (dryRun) return this.result(true, 0, undefined, true, at);
    const s = sim.staffSys.create(role, tile);
    sim.events.emit('staffAdded', { id: s.id });
    sim.markPopulationDirty();
    sim.notify(null, `${s.name} joined as ${role === 'keeper' ? 'a keeper' : role === 'vet' ? 'a vet' : 'a groundskeeper'} (${fmtMoney(salary)}/day, paid at day end).`, 'good', { x: s.x, z: s.z });
    return this.result(true, 0, undefined, false, { x: s.x, z: s.z });
  }

  fireStaff(staffId: number): CommandResult {
    const sim = this.sim;
    const s = sim.staff.get(staffId);
    if (!s) return this.result(false, 0, 'No such staff member', false);
    sim.staff.delete(staffId);
    sim.events.emit('staffRemoved', { id: staffId });
    sim.markPopulationDirty();
    sim.notify(null, `${s.name} has left the zoo.`, 'info');
    return this.result(true, 0, undefined, false, { x: s.x, z: s.z });
  }
}
