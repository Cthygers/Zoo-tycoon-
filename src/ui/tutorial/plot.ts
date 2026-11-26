// Where the tutorial suggests building (tutorial.md §7): the yellow box for the first habitat,
// the yellow spots inside it, the yellow path tiles to the gate and the spots beside the path.
// Pure over the World and the simulation's dry-run commands (no DOM, no three.js), and
// covered by tests/tutorial-plot.test.ts on 25 seeds.

import { ENTRANCE_TILE, MAP_H, MAP_W, TILE } from '../../core/constants';
import type { TileRect } from '../../core/events';
import { PathType, Terrain } from '../../core/types';
import type { EdgeRef, World } from '../../core/world';
import type { ISimulation } from '../../core/contracts';

export interface TilePos {
  x: number;
  z: number;
}
export interface Spot {
  tx: number;
  tz: number;
  rot: number;
  /** Footprint size in tiles. */
  w: number;
  d: number;
}

/** The parts of the simulation the finders use (dry runs only). */
export type PlotSim = Pick<ISimulation, 'world' | 'placeFences' | 'placeObject' | 'buyAnimal' | 'hireStaff'>;

const DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function rectTiles(r: TileRect): TilePos[] {
  const out: TilePos[] = [];
  for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) out.push({ x, z });
  return out;
}

export function rectCentre(r: TileRect): { x: number; z: number } {
  return { x: ((r.x0 + r.x1 + 1) / 2) * TILE, z: ((r.z0 + r.z1 + 1) / 2) * TILE };
}

/** Path tiles the gate can reach: a flood over path tiles from the entrance. */
export function gatePaths(w: World): Uint8Array {
  const out = new Uint8Array(MAP_W * MAP_H);
  const start = w.idx(ENTRANCE_TILE.x, ENTRANCE_TILE.z);
  const q: number[] = [];
  // the entrance tile itself is part of the plaza; fall back to any plaza tile
  for (let dz = 0; dz >= -2 && !q.length; dz--)
    for (let dx = -2; dx <= 2 && !q.length; dx++) {
      const x = ENTRANCE_TILE.x + dx,
        z = ENTRANCE_TILE.z + dz;
      if (w.isPath(x, z)) q.push(w.idx(x, z));
    }
  if (!q.length && w.path[start]) q.push(start);
  for (const i of q) out[i] = 1;
  for (let k = 0; k < q.length; k++) {
    const i = q[k];
    const x = i % MAP_W,
      z = (i / MAP_W) | 0;
    for (const [dx, dz] of DIRS) {
      const nx = x + dx,
        nz = z + dz;
      if (!w.inBounds(nx, nz)) continue;
      const j = w.idx(nx, nz);
      if (out[j] || !w.path[j]) continue;
      out[j] = 1;
      q.push(j);
    }
  }
  return out;
}

/**
 * The straight-ish corridor of new path tiles that joins the area `inside` to a path the gate
 * can reach, ordered from the grey path's end to the fence. Empty when a reachable path already
 * runs along the fence; null when there is no way through (within 24 tiles).
 */
export function pathHintFor(w: World, inside: (x: number, z: number) => boolean, centre: TilePos): TilePos[] | null {
  const reach = gatePaths(w);
  const sources: { x: number; z: number; d: number }[] = [];
  const seen = new Set<number>();
  for (let z = 0; z < MAP_H; z++)
    for (let x = 0; x < MAP_W; x++) {
      if (!inside(x, z)) continue;
      for (const [dx, dz] of DIRS) {
        const nx = x + dx,
          nz = z + dz;
        if (!w.inBounds(nx, nz) || inside(nx, nz)) continue;
        const j = w.idx(nx, nz);
        if (seen.has(j)) continue;
        seen.add(j);
        if (reach[j]) return []; // already beside a path the gate reaches
        if (w.isPath(nx, nz) || w.canPlacePath(nx, nz, PathType.Paved) !== null) continue;
        // the middle of a side first, and of those the side facing the gate
        sources.push({ x: nx, z: nz, d: Math.round(Math.hypot(nx - centre.x, nz - centre.z) * 2) / 2 + Math.hypot(nx - ENTRANCE_TILE.x, nz - ENTRANCE_TILE.z) / 1000 });
      }
    }
  sources.sort((a, b) => a.d - b.d || a.z - b.z || a.x - b.x);
  const prev = new Int32Array(MAP_W * MAP_H).fill(-2);
  const dist = new Int32Array(MAP_W * MAP_H);
  const dirOf = new Int8Array(MAP_W * MAP_H).fill(-1);
  const q: number[] = [];
  for (const s of sources) {
    const i = w.idx(s.x, s.z);
    prev[i] = -1;
    q.push(i);
  }
  const nearReach = (x: number, z: number) => DIRS.some(([dx, dz]) => w.inBounds(x + dx, z + dz) && reach[w.idx(x + dx, z + dz)] === 1);
  for (let k = 0; k < q.length; k++) {
    const i = q[k];
    const x = i % MAP_W,
      z = (i / MAP_W) | 0;
    if (nearReach(x, z)) {
      const out: TilePos[] = [];
      for (let c = i; c >= 0; c = prev[c]) out.push({ x: c % MAP_W, z: (c / MAP_W) | 0 });
      return out; // from the grey path's end back to the fence
    }
    if (dist[i] >= 24) continue;
    // keep going straight first
    const order = dirOf[i] >= 0 ? [DIRS[dirOf[i]], ...DIRS.filter((_, n) => n !== dirOf[i])] : DIRS;
    for (const [dx, dz] of order) {
      const nx = x + dx,
        nz = z + dz;
      if (!w.inBounds(nx, nz) || inside(nx, nz)) continue;
      const j = w.idx(nx, nz);
      if (prev[j] !== -2) continue;
      if (w.isPath(nx, nz) || w.canPlacePath(nx, nz, PathType.Paved) !== null) continue;
      prev[j] = i;
      dist[j] = dist[i] + 1;
      dirOf[j] = DIRS.findIndex((d) => d[0] === dx && d[1] === dz);
      q.push(j);
    }
  }
  return null;
}

export function pathHintRect(w: World, r: TileRect): TilePos[] | null {
  return pathHintFor(w, (x, z) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1, { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 });
}

export function pathHintHabitat(w: World, habId: number): TilePos[] | null {
  const h = w.habitats.get(habId);
  if (!h) return null;
  return pathHintFor(w, (x, z) => w.inBounds(x, z) && w.habitatOf[w.idx(x, z)] === habId, { x: (h.minX + h.maxX) / 2, z: (h.minZ + h.maxZ) / 2 });
}

/** True when no path lies within 2 tiles straight out from the rect's edges (so it is not on view yet). */
function noPathNear(w: World, r: TileRect): boolean {
  for (let x = r.x0; x <= r.x1; x++)
    for (let k = 1; k <= 2; k++) if (w.isPath(x, r.z0 - k) || w.isPath(x, r.z1 + k)) return false;
  for (let z = r.z0; z <= r.z1; z++)
    for (let k = 1; k <= 2; k++) if (w.isPath(r.x0 - k, z) || w.isPath(r.x1 + k, z)) return false;
  return true;
}

/** The checks a suggested habitat plot must pass (tutorial.md §7). */
export function plotValid(sim: PlotSim, r: TileRect): boolean {
  const w = sim.world;
  if (r.x0 < 1 || r.z0 < 1 || r.x1 > MAP_W - 2 || r.z1 > MAP_H - 2) return false;
  for (const t of rectTiles(r)) {
    const i = w.idx(t.x, t.z);
    if (w.objectGrid[i] || w.path[i] || w.habitatOf[i]) return false;
    const ter = w.terrain[i] as Terrain;
    if (ter === Terrain.Water || ter === Terrain.DeepWater) return false;
  }
  if (!noPathNear(w, r)) return false;
  const edges = w.edgesAroundRect(r);
  if (edges.some((e) => w.getFence(e) !== 0)) return false;
  const problems = w.enclosureProblems(edges);
  if (problems(r.x0, r.z0) !== null) return false;
  const fr = sim.placeFences(edges, 1, true);
  if (!fr.ok || fr.warning) return false;
  const hint = pathHintRect(w, r);
  return !!hint && hint.length <= 4;
}

/** Plot candidates around the gate, in order (tutorial.md §7 A–D). */
export function plotCandidates(): TileRect[] {
  const ex = ENTRANCE_TILE.x,
    ez = ENTRANCE_TILE.z;
  return [
    { x0: ex + 3, z0: ez - 11, x1: ex + 10, z1: ez - 4 }, // A: east of the avenue
    { x0: ex - 10, z0: ez - 11, x1: ex - 3, z1: ez - 4 }, // B: west
    { x0: ex + 3, z0: ez - 11, x1: ex + 9, z1: ez - 4 }, // C: as A, 7 wide
    { x0: ex - 9, z0: ez - 11, x1: ex - 3, z1: ez - 4 }, // C': as B, 7 wide
    { x0: ex - 4, z0: ez - 25, x1: ex + 3, z1: ez - 18 }, // D: north of the cross path
  ];
}

/** The yellow box for the first habitat, or null when no candidate works. */
export function findPlot(sim: PlotSim): TileRect | null {
  for (const r of plotCandidates()) if (plotValid(sim, r)) return r;
  // E: scan 8×8 then 7×7 rects within 30 tiles of the gate, nearest first
  const ex = ENTRANCE_TILE.x,
    ez = ENTRANCE_TILE.z;
  for (const size of [8, 7]) {
    const cands: { r: TileRect; d: number }[] = [];
    for (let z0 = ez - 30; z0 <= ez - size; z0++)
      for (let x0 = ex - 30; x0 <= ex + 30 - size; x0++) {
        const r = { x0, z0, x1: x0 + size - 1, z1: z0 + size - 1 };
        if (r.x0 < 1 || r.z0 < 1 || r.x1 > MAP_W - 2 || r.z1 > MAP_H - 2) continue;
        cands.push({ r, d: Math.hypot((x0 + x0 + size) / 2 - ex, (z0 + z0 + size) / 2 - ez) });
      }
    cands.sort((a, b) => a.d - b.d);
    for (const c of cands) if (plotValid(sim, c.r)) return c.r;
  }
  return null;
}

// --------------------------------------------------------------------------- spots
/** Tiles of a habitat as positions. */
export function habitatTiles(w: World, habId: number): TilePos[] {
  const h = w.habitats.get(habId);
  if (!h) return [];
  return h.tiles.map((i) => ({ x: i % MAP_W, z: (i / MAP_W) | 0 }));
}

/** Distance (tiles) from a tile to the nearest path tile the gate reaches (searching up to 40). */
function distToReach(reach: Uint8Array, x: number, z: number): number {
  let best = Infinity;
  for (let dz = -40; dz <= 40; dz++)
    for (let dx = -40; dx <= 40; dx++) {
      const nx = x + dx,
        nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= MAP_W || nz >= MAP_H) continue;
      if (!reach[nz * MAP_W + nx]) continue;
      const d = Math.abs(dx) + Math.abs(dz);
      if (d < best) best = d;
    }
  return best;
}

function okSpot(sim: PlotSim, defId: string, tx: number, tz: number, rot: number): boolean {
  const r = sim.placeObject(defId, tx, tz, rot, true);
  return r.ok && !r.warning;
}

/**
 * A big footprint is placed from the tile the finger lands on: a spot is forgiving when a tap on
 * any of its tiles still gives a good placement (the footprint shifted by that tile).
 */
function forgiving(sim: PlotSim, defId: string, tx: number, tz: number, w: number, d: number): boolean {
  for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) if ((dx || dz) && !okSpot(sim, defId, tx + dx, tz + dz, 0)) return false;
  return true;
}

/** The tile a tap must land on to place a footprint at (tx, tz) (the object tool's centring). */
export function anchorTile(s: Spot): TilePos {
  return { x: s.tx + Math.floor((s.w - 1) / 2), z: s.tz + Math.floor((s.d - 1) / 2) };
}

function sizeOf(sim: PlotSim, defId: string, tx: number, tz: number, rot: number): { w: number; d: number } {
  const fp = sim.world.footprint({ defId, tx, tz, rot });
  let w = 0,
    d = 0;
  for (const t of fp) {
    w = Math.max(w, t.x - tx + 1);
    d = Math.max(d, t.z - tz + 1);
  }
  return { w: Math.max(1, w), d: Math.max(1, d) };
}

export type InsidePrefer = 'near-path' | 'far' | 'corner';

/**
 * A spot for `defId` inside habitat `habId` (water near the corner closest to the gate's
 * paths, the shelter in the far corner, a plant in a third corner), accepted only where the
 * dry run is ok with no warning.
 */
export function spotInside(sim: PlotSim, habId: number, defId: string, prefer: InsidePrefer): Spot | null {
  const w = sim.world;
  const h = w.habitats.get(habId);
  if (!h) return null;
  const reach = gatePaths(w);
  const corners: TilePos[] = [
    { x: h.minX, z: h.minZ },
    { x: h.maxX, z: h.minZ },
    { x: h.minX, z: h.maxZ },
    { x: h.maxX, z: h.maxZ },
  ];
  const ex = ENTRANCE_TILE.x,
    ez = ENTRANCE_TILE.z;
  corners.sort((a, b) => distToReach(reach, a.x, a.z) - distToReach(reach, b.x, b.z) || Math.hypot(a.x - ex, a.z - ez) - Math.hypot(b.x - ex, b.z - ez));
  const near = corners[0];
  const far = corners.find((c) => c.x !== near.x && c.z !== near.z) ?? corners[3];
  const third = corners.find((c) => c.x === near.x && c.z !== near.z) ?? corners[1];
  const goal = prefer === 'near-path' ? near : prefer === 'far' ? far : third;
  const tiles = habitatTiles(w, habId).sort((a, b) => Math.hypot(a.x - goal.x, a.z - goal.z) - Math.hypot(b.x - goal.x, b.z - goal.z) || a.z - b.z || a.x - b.x);
  for (const pass of [0, 1]) {
    for (const t of tiles) {
      // a 2×2 shelter grows from its min corner: anchor it so the footprint sits at the goal corner
      const s = sizeOf(sim, defId, t.x, t.z, 0);
      const tx = goal.x === h.maxX ? t.x - (s.w - 1) : t.x;
      const tz = goal.z === h.maxZ ? t.z - (s.d - 1) : t.z;
      if (okSpot(sim, defId, tx, tz, 0) && (pass === 1 || forgiving(sim, defId, tx, tz, s.w, s.d))) return { tx, tz, rot: 0, ...s };
    }
  }
  return null;
}

/** A spot for a guest building beside a path, spiralling out from `near`. */
export function spotBesidePath(sim: PlotSim, defId: string, near: TilePos, avoid: readonly TilePos[] = []): Spot | null {
  return spotBesidePathPass(sim, defId, near, avoid, true) ?? spotBesidePathPass(sim, defId, near, avoid, false);
}

function spotBesidePathPass(sim: PlotSim, defId: string, near: TilePos, avoid: readonly TilePos[], kind: boolean): Spot | null {
  const w = sim.world;
  const reach = gatePaths(w);
  const avoidSet = new Set(avoid.map((t) => w.idx(t.x, t.z)));
  for (let r = 0; r <= 12; r++) {
    const ring: TilePos[] = [];
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) ring.push({ x: near.x + dx, z: near.z + dz });
    ring.sort((a, b) => Math.hypot(a.x - near.x, a.z - near.z) - Math.hypot(b.x - near.x, b.z - near.z) || a.z - b.z || a.x - b.x);
    for (const t of ring) {
      if (!w.inBounds(t.x, t.z)) continue;
      const s = sizeOf(sim, defId, t.x, t.z, 0);
      const fp = w.footprint({ defId, tx: t.x, tz: t.z, rot: 0 });
      if (fp.some((p) => avoidSet.has(w.idx(p.x, p.z)))) continue;
      if (!okSpot(sim, defId, t.x, t.z, 0)) continue;
      // beside a path the gate reaches (not a stray one)
      const adj = fp.some((p) => DIRS.some(([dx, dz]) => w.inBounds(p.x + dx, p.z + dz) && reach[w.idx(p.x + dx, p.z + dz)] === 1));
      if (!adj) continue;
      if (kind && !forgiving(sim, defId, t.x, t.z, s.w, s.d)) continue;
      return { tx: t.x, tz: t.z, rot: 0, ...s };
    }
  }
  return null;
}

/** A path tile next to the habitat (the corridor's fence end first) for the keeper. */
export function keeperTile(sim: PlotSim, habId: number, corridor: readonly TilePos[] = []): TilePos | null {
  const w = sim.world;
  const h = w.habitats.get(habId);
  const ok = (t: TilePos) => w.isPath(t.x, t.z) && sim.hireStaff('keeper', (t.x + 0.5) * TILE, (t.z + 0.5) * TILE, true).ok;
  for (let i = corridor.length - 1; i >= 0; i--) if (ok(corridor[i])) return corridor[i];
  if (!h) return null;
  const cx = (h.minX + h.maxX) / 2,
    cz = (h.minZ + h.maxZ) / 2;
  let best: TilePos | null = null;
  let bestD = Infinity;
  for (let z = Math.max(0, h.minZ - 12); z <= Math.min(MAP_H - 1, h.maxZ + 12); z++)
    for (let x = Math.max(0, h.minX - 12); x <= Math.min(MAP_W - 1, h.maxX + 12); x++) {
      if (!w.isPath(x, z)) continue;
      const d = Math.hypot(x - cx, z - cz);
      if (d < bestD && ok({ x, z })) {
        bestD = d;
        best = { x, z };
      }
    }
  return best;
}

/** A tile near the habitat's middle where the adoption dry run is ok. */
export function adoptSpot(sim: PlotSim, habId: number, speciesId: string): TilePos | null {
  const w = sim.world;
  const h = w.habitats.get(habId);
  if (!h) return null;
  const cx = (h.minX + h.maxX) / 2,
    cz = (h.minZ + h.maxZ) / 2;
  const tiles = habitatTiles(w, habId).sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz) || a.z - b.z || a.x - b.x);
  for (const t of tiles) {
    if (w.isTileSolid(t.x, t.z)) continue;
    if (sim.buyAnimal(speciesId, (t.x + 0.5) * TILE, (t.z + 0.5) * TILE, true).ok) return t;
  }
  return null;
}

/** The unfenced edges around an opened enclosure's tiles (a fence gap) and the fence used around it. */
export function gapEdges(w: World, tiles: readonly number[]): { edges: EdgeRef[]; fenceId: number } {
  const set = new Set(tiles);
  const edges: EdgeRef[] = [];
  const count = new Map<number, number>();
  for (const i of tiles) {
    const x = i % MAP_W,
      z = (i / MAP_W) | 0;
    const sides: [number, number, EdgeRef][] = [
      [x + 1, z, { dir: 'v', x: x + 1, z }],
      [x - 1, z, { dir: 'v', x, z }],
      [x, z + 1, { dir: 'h', x, z: z + 1 }],
      [x, z - 1, { dir: 'h', x, z }],
    ];
    for (const [nx, nz, e] of sides) {
      if (w.inBounds(nx, nz) && set.has(w.idx(nx, nz))) continue;
      const f = w.getFence(e);
      if (f) count.set(f, (count.get(f) ?? 0) + 1);
      else if (w.edgeInBounds(e)) edges.push(e);
    }
  }
  let fenceId = 1;
  let n = -1;
  for (const [id, c] of count) if (c > n) (n = c), (fenceId = id);
  return { edges, fenceId };
}

/** Bounding tile rect of a habitat. */
export function habitatRect(w: World, habId: number): TileRect | null {
  const h = w.habitats.get(habId);
  return h ? { x0: h.minX, z0: h.minZ, x1: h.maxX, z1: h.maxZ } : null;
}

/** A rect shrunk by `n` tiles on every side (never inverted). */
export function inset(r: TileRect, n: number): TileRect {
  const x0 = Math.min(r.x0 + n, (r.x0 + r.x1) >> 1),
    z0 = Math.min(r.z0 + n, (r.z0 + r.z1) >> 1);
  return { x0, z0, x1: Math.max(x0, r.x1 - n), z1: Math.max(z0, r.z1 - n) };
}
