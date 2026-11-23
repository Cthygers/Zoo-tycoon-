// The World: tile grid, terrain, paths, fences, placed objects and habitat
// (enclosure) detection. Pure data + validation; no money logic (that lives in
// the Simulation's command layer) and no three.js.
//
// Fence edges:
//  - Horizontal edge h(x, z), 0<=x<MAP_W, 0<=z<=MAP_H, lies along world line
//    Z = z*TILE from X = x*TILE to (x+1)*TILE. It separates tile (x, z-1)
//    (north / smaller z) from tile (x, z) (south).
//  - Vertical edge v(x, z), 0<=x<=MAP_W, 0<=z<MAP_H, lies along X = x*TILE
//    from Z = z*TILE to (z+1)*TILE. It separates tile (x-1, z) from (x, z).
//  - Corners (fence posts) are at integer grid points (cx, cz), 0..MAP_W/H,
//    world position (cx*TILE, cz*TILE).

import {
  DECK_Y,
  DEEP_DEPTH,
  ENTRANCE_TILE,
  MAP_H,
  MAP_W,
  SHALLOW_DEPTH,
  TILE,
} from './constants';
import { EventBus, type TileRect } from './events';
import { Noise, Rng, clamp } from './rng';
import { PathType, Terrain, TERRAIN_COUNT, isWater, type Habitat, type ObjectDef, type PlacedObject } from './types';
import { OBJECTS_BY_ID, rotatedSize } from '../data/objects';
import { FENCES_BY_ID } from '../data/fences';

export interface EdgeRef {
  dir: 'h' | 'v';
  x: number;
  z: number;
}

/**
 * Why a fenced-off region is not a habitat: a path runs inside it, it relies on the
 * unfenced map edge as a side, or it covers more than half of the map.
 */
export type EnclosureProblem = 'path' | 'mapEdge' | 'tooBig';
const ENCLOSURE_PROBLEMS: readonly EnclosureProblem[] = ['path', 'mapEdge', 'tooBig'];

export interface WorldSave {
  version: 1;
  seed: number;
  terrain: number[];
  path: number[];
  hFence: number[];
  vFence: number[];
  objects: PlacedObject[];
  nextObjectId: number;
  habitatNames: Record<string, string>;
  /** Run-length encoded habitatOf ([id, count, id, count, ...]) so habitat ids survive save/load. */
  habitatRle?: number[];
  /** Next fresh habitat id, so ids of deleted habitats are never handed out again after a load. */
  nextHabitatId?: number;
}

export class World {
  readonly w = MAP_W;
  readonly h = MAP_H;
  readonly events: EventBus;
  seed: number;

  terrain = new Uint8Array(MAP_W * MAP_H);
  path = new Uint8Array(MAP_W * MAP_H);
  hFence = new Uint8Array(MAP_W * (MAP_H + 1));
  vFence = new Uint8Array((MAP_W + 1) * MAP_H);
  /** Object id occupying each tile (0 = empty). */
  objectGrid = new Int32Array(MAP_W * MAP_H);
  objects = new Map<number, PlacedObject>();
  /** Habitat id for each tile (0 = public / not enclosed). */
  habitatOf = new Int32Array(MAP_W * MAP_H);
  habitats = new Map<number, Habitat>();
  /** Natural ground relief at tile corners (metres, >= 0). */
  relief = new Float32Array((MAP_W + 1) * (MAP_H + 1));
  /** Final ground height at tile corners, including water carving. */
  cornerH = new Float32Array((MAP_W + 1) * (MAP_H + 1));

  private nextObjectId = 1;
  private nextHabitatId = 1;
  private habitatNames = new Map<number, string>();
  /** Increments whenever anything structural changes; cheap cache key for consumers. */
  revision = 0;

  constructor(events: EventBus, seed = 12345) {
    this.events = events;
    this.seed = seed;
    this.buildRelief();
    this.terrain.fill(Terrain.Grass);
    this.recomputeHeights({ x0: 0, z0: 0, x1: MAP_W - 1, z1: MAP_H - 1 });
  }

  // ------------------------------------------------------------ indexing
  idx(x: number, z: number): number {
    return z * MAP_W + x;
  }
  inBounds(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < MAP_W && z < MAP_H;
  }
  tileOfWorld(wx: number, wz: number): { x: number; z: number } {
    return { x: Math.floor(wx / TILE), z: Math.floor(wz / TILE) };
  }
  tileCenter(x: number, z: number): { x: number; z: number } {
    return { x: (x + 0.5) * TILE, z: (z + 0.5) * TILE };
  }
  cornerIdx(cx: number, cz: number): number {
    return cz * (MAP_W + 1) + cx;
  }

  // ------------------------------------------------------------ terrain
  getTerrain(x: number, z: number): Terrain {
    if (!this.inBounds(x, z)) return Terrain.Grass;
    return this.terrain[this.idx(x, z)] as Terrain;
  }

  /** Raw terrain write (no validation / cost). Emits terrainChanged. */
  setTerrainRect(rect: TileRect, t: Terrain, filter?: (x: number, z: number) => boolean): number {
    let changed = 0;
    const r = this.clampRect(rect);
    for (let z = r.z0; z <= r.z1; z++)
      for (let x = r.x0; x <= r.x1; x++) {
        if (filter && !filter(x, z)) continue;
        const i = this.idx(x, z);
        if (this.terrain[i] !== t) {
          this.terrain[i] = t;
          changed++;
        }
      }
    if (changed) {
      const grown = this.clampRect({ x0: r.x0 - 1, z0: r.z0 - 1, x1: r.x1 + 1, z1: r.z1 + 1 });
      this.recomputeHeights(grown);
      this.revision++;
      this.events.emit('terrainChanged', grown);
      this.refreshHabitatStats();
    }
    return changed;
  }

  private buildRelief() {
    const n = new Noise(this.seed);
    for (let cz = 0; cz <= MAP_H; cz++)
      for (let cx = 0; cx <= MAP_W; cx++) {
        const v = n.fbm2(cx * 0.045, cz * 0.045, 3) * 0.5 + 0.5; // 0..1
        this.relief[this.cornerIdx(cx, cz)] = 0.05 + v * 0.45;
      }
  }

  recomputeHeights(rect: TileRect) {
    const x0 = clamp(rect.x0, 0, MAP_W);
    const z0 = clamp(rect.z0, 0, MAP_H);
    const x1 = clamp(rect.x1 + 1, 0, MAP_W);
    const z1 = clamp(rect.z1 + 1, 0, MAP_H);
    for (let cz = z0; cz <= z1; cz++)
      for (let cx = x0; cx <= x1; cx++) {
        let n = 0,
          water = 0,
          depth = 0;
        for (let dz = -1; dz <= 0; dz++)
          for (let dx = -1; dx <= 0; dx++) {
            const tx = cx + dx,
              tz = cz + dz;
            if (!this.inBounds(tx, tz)) continue;
            n++;
            const t = this.terrain[this.idx(tx, tz)];
            if (t === Terrain.Water) {
              water++;
              depth += SHALLOW_DEPTH;
            } else if (t === Terrain.DeepWater) {
              water++;
              depth += DEEP_DEPTH;
            }
          }
        const ci = this.cornerIdx(cx, cz);
        const relief = this.relief[ci];
        if (n === 0 || water === 0) {
          this.cornerH[ci] = relief;
        } else {
          const f = water / n;
          const avgDepth = depth / water;
          this.cornerH[ci] = relief * (1 - f) - f * avgDepth;
        }
      }
  }

  cornerHeight(cx: number, cz: number): number {
    cx = clamp(cx, 0, MAP_W);
    cz = clamp(cz, 0, MAP_H);
    return this.cornerH[this.cornerIdx(cx, cz)];
  }

  /** Ground height at a world position (bilinear over tile corners). Outside the map returns edge height. */
  /**
   * Height of the surface people walk on: the ground, or the deck of a
   * boardwalk built over water. Use this for guests / staff, heightAt for animals.
   */
  walkHeightAt(wx: number, wz: number): number {
    const g = this.heightAt(wx, wz);
    const tx = Math.floor(wx / TILE),
      tz = Math.floor(wz / TILE);
    if (this.inBounds(tx, tz) && this.path[this.idx(tx, tz)] === PathType.Boardwalk) return Math.max(g, DECK_Y);
    return g;
  }

  heightAt(wx: number, wz: number): number {
    const fx = clamp(wx / TILE, 0, MAP_W - 1e-4);
    const fz = clamp(wz / TILE, 0, MAP_H - 1e-4);
    const cx = Math.floor(fx),
      cz = Math.floor(fz);
    const tx = fx - cx,
      tz = fz - cz;
    const h00 = this.cornerH[this.cornerIdx(cx, cz)];
    const h10 = this.cornerH[this.cornerIdx(cx + 1, cz)];
    const h01 = this.cornerH[this.cornerIdx(cx, cz + 1)];
    const h11 = this.cornerH[this.cornerIdx(cx + 1, cz + 1)];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  // ------------------------------------------------------------ paths
  getPath(x: number, z: number): PathType {
    if (!this.inBounds(x, z)) return PathType.None;
    return this.path[this.idx(x, z)] as PathType;
  }
  isPath(x: number, z: number): boolean {
    return this.getPath(x, z) !== PathType.None;
  }
  /** Raw path write. Returns whether it changed. */
  setPath(x: number, z: number, p: PathType): boolean {
    if (!this.inBounds(x, z)) return false;
    const i = this.idx(x, z);
    if (this.path[i] === p) return false;
    this.path[i] = p;
    this.revision++;
    this.events.emit('pathChanged', { x0: x, z0: z, x1: x, z1: z });
    return true;
  }
  /** Why a path cannot go on this tile (null = ok). */
  canPlacePath(x: number, z: number, p: PathType): string | null {
    if (!this.inBounds(x, z)) return 'Out of bounds';
    const i = this.idx(x, z);
    if (this.habitatOf[i]) return 'Paths cannot go inside habitats';
    const oid = this.objectGrid[i];
    if (oid) {
      const o = this.objects.get(oid);
      if (o && o.defId !== 'entrance_gate') return 'Tile is occupied';
    }
    if (isWater(this.terrain[i] as Terrain) && p !== PathType.Boardwalk) return 'Only boardwalks can cross water';
    return null;
  }

  // ------------------------------------------------------------ fences
  hIdx(x: number, z: number) {
    return z * MAP_W + x;
  }
  vIdx(x: number, z: number) {
    return z * (MAP_W + 1) + x;
  }
  edgeInBounds(e: EdgeRef): boolean {
    return e.dir === 'h'
      ? e.x >= 0 && e.x < MAP_W && e.z >= 0 && e.z <= MAP_H
      : e.x >= 0 && e.x <= MAP_W && e.z >= 0 && e.z < MAP_H;
  }
  getFence(e: EdgeRef): number {
    if (!this.edgeInBounds(e)) return 0;
    return e.dir === 'h' ? this.hFence[this.hIdx(e.x, e.z)] : this.vFence[this.vIdx(e.x, e.z)];
  }
  /** Raw fence write (fenceId 0 removes). Habitats are recomputed. */
  setFence(e: EdgeRef, fenceId: number, recompute = true): boolean {
    if (!this.edgeInBounds(e)) return false;
    const arr = e.dir === 'h' ? this.hFence : this.vFence;
    const i = e.dir === 'h' ? this.hIdx(e.x, e.z) : this.vIdx(e.x, e.z);
    if (arr[i] === fenceId) return false;
    arr[i] = fenceId;
    this.revision++;
    const rect =
      e.dir === 'h'
        ? { x0: e.x, z0: Math.max(0, e.z - 1), x1: e.x, z1: Math.min(MAP_H - 1, e.z) }
        : { x0: Math.max(0, e.x - 1), z0: e.z, x1: Math.min(MAP_W - 1, e.x), z1: e.z };
    this.events.emit('fenceChanged', rect);
    if (recompute) this.recomputeHabitats();
    return true;
  }
  /** Edges along an axis-aligned line between two grid corners (diagonals are snapped to the dominant axis). */
  edgesBetweenCorners(ax: number, az: number, bx: number, bz: number): EdgeRef[] {
    const out: EdgeRef[] = [];
    if (Math.abs(bx - ax) >= Math.abs(bz - az)) {
      const z = az;
      const x0 = Math.min(ax, bx),
        x1 = Math.max(ax, bx);
      for (let x = x0; x < x1; x++) out.push({ dir: 'h', x, z });
    } else {
      const x = ax;
      const z0 = Math.min(az, bz),
        z1 = Math.max(az, bz);
      for (let z = z0; z < z1; z++) out.push({ dir: 'v', x, z });
    }
    return out.filter((e) => this.edgeInBounds(e));
  }
  /** Edges forming the outline of a rectangle of tiles (inclusive tile coords). */
  edgesAroundRect(r: TileRect): EdgeRef[] {
    const out: EdgeRef[] = [];
    const x0 = Math.min(r.x0, r.x1),
      x1 = Math.max(r.x0, r.x1),
      z0 = Math.min(r.z0, r.z1),
      z1 = Math.max(r.z0, r.z1);
    for (let x = x0; x <= x1; x++) {
      out.push({ dir: 'h', x, z: z0 });
      out.push({ dir: 'h', x, z: z1 + 1 });
    }
    for (let z = z0; z <= z1; z++) {
      out.push({ dir: 'v', x: x0, z });
      out.push({ dir: 'v', x: x1 + 1, z });
    }
    return out.filter((e) => this.edgeInBounds(e));
  }
  /** Fence id on the edge shared by two orthogonally adjacent tiles (0 = open). */
  fenceBetween(ax: number, az: number, bx: number, bz: number): number {
    if (bx === ax && bz === az + 1) return this.hFence[this.hIdx(ax, bz)] ?? 0;
    if (bx === ax && bz === az - 1) return this.hFence[this.hIdx(ax, az)] ?? 0;
    if (bz === az && bx === ax + 1) return this.vFence[this.vIdx(bx, az)] ?? 0;
    if (bz === az && bx === ax - 1) return this.vFence[this.vIdx(ax, az)] ?? 0;
    return 0;
  }
  /** Can something step from tile a to neighbouring tile b (incl. diagonals) without crossing a fence? */
  canStep(ax: number, az: number, bx: number, bz: number): boolean {
    if (!this.inBounds(bx, bz)) return false;
    const dx = bx - ax,
      dz = bz - az;
    if (Math.abs(dx) + Math.abs(dz) === 1) return this.fenceBetween(ax, az, bx, bz) === 0;
    if (Math.abs(dx) === 1 && Math.abs(dz) === 1) {
      // diagonal: both L-shaped routes must be open (no corner cutting through posts)
      return (
        this.fenceBetween(ax, az, ax + dx, az) === 0 &&
        this.fenceBetween(ax + dx, az, bx, bz) === 0 &&
        this.fenceBetween(ax, az, ax, az + dz) === 0 &&
        this.fenceBetween(ax, az + dz, bx, bz) === 0
      );
    }
    return false;
  }
  /** Does the segment between two world points cross any fence edge? (Used to keep animals inside.) */
  segmentCrossesFence(x0: number, z0: number, x1: number, z1: number): boolean {
    const a = this.tileOfWorld(x0, z0);
    const b = this.tileOfWorld(x1, z1);
    if (a.x === b.x && a.z === b.z) return false;
    // walk tiles along the segment (DDA)
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z)) * 2 + 2;
    let px = a.x,
      pz = a.z;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const c = this.tileOfWorld(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
      if (c.x !== px || c.z !== pz) {
        if (!this.canStep(px, pz, c.x, c.z)) return true;
        px = c.x;
        pz = c.z;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ objects
  objectAt(x: number, z: number): PlacedObject | undefined {
    if (!this.inBounds(x, z)) return undefined;
    const id = this.objectGrid[this.idx(x, z)];
    return id ? this.objects.get(id) : undefined;
  }
  footprint(o: { defId: string; tx: number; tz: number; rot: number }): { x: number; z: number }[] {
    const def = OBJECTS_BY_ID[o.defId];
    const [w, d] = rotatedSize(def, o.rot);
    const out: { x: number; z: number }[] = [];
    for (let z = o.tz; z < o.tz + d; z++) for (let x = o.tx; x < o.tx + w; x++) out.push({ x, z });
    return out;
  }
  /** World-space centre of an object's footprint (ground level). */
  objectCenter(o: PlacedObject): { x: number; y: number; z: number } {
    const def = OBJECTS_BY_ID[o.defId];
    const [w, d] = rotatedSize(def, o.rot);
    const x = (o.tx + w / 2) * TILE;
    const z = (o.tz + d / 2) * TILE;
    return { x, y: this.heightAt(x, z), z };
  }
  /** Why an object cannot be placed here (null = ok). */
  canPlaceObject(def: ObjectDef, tx: number, tz: number, rot: number): string | null {
    const fp = this.footprint({ defId: def.id, tx, tz, rot });
    let hab: number | null = null;
    for (const t of fp) {
      if (!this.inBounds(t.x, t.z)) return 'Out of bounds';
      const i = this.idx(t.x, t.z);
      if (this.objectGrid[i]) return 'Tile is occupied';
      if (this.path[i] && def.id !== 'entrance_gate') return 'Cannot build on a path';
      const ter = this.terrain[i] as Terrain;
      if (ter === Terrain.DeepWater) return 'Cannot build in deep water';
      if (ter === Terrain.Water && def.id !== 'reeds') return 'Cannot build in water';
      const h = this.habitatOf[i];
      if (hab === null) hab = h;
      else if (hab !== h) return 'Object straddles a fence';
    }
    // object must not straddle fences internally
    for (const t of fp) {
      for (const n of fp) {
        if (Math.abs(n.x - t.x) + Math.abs(n.z - t.z) === 1 && this.fenceBetween(t.x, t.z, n.x, n.z)) return 'Object straddles a fence';
      }
    }
    if (def.habitatOnly && !hab) return 'Must be placed inside a habitat';
    if (def.guestOnly && hab) return 'Cannot be placed inside a habitat';
    if (def.needsPathAccess && !this.adjacentPathTile(fp)) return 'Must be next to a path';
    return null;
  }
  /** A path tile orthogonally adjacent to the footprint and reachable without crossing a fence. */
  adjacentPathTile(fp: { x: number; z: number }[]): { x: number; z: number } | null {
    const inFp = new Set(fp.map((t) => this.idx(t.x, t.z)));
    for (const t of fp) {
      for (const [dx, dz] of [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ]) {
        const nx = t.x + dx,
          nz = t.z + dz;
        if (!this.inBounds(nx, nz) || inFp.has(this.idx(nx, nz))) continue;
        if (this.isPath(nx, nz) && this.fenceBetween(t.x, t.z, nx, nz) === 0) return { x: nx, z: nz };
      }
    }
    return null;
  }
  /** Raw add (no validation). */
  addObject(defId: string, tx: number, tz: number, rot: number, seed?: number): PlacedObject {
    const o: PlacedObject = { id: this.nextObjectId++, defId, tx, tz, rot: ((rot % 4) + 4) % 4, seed: seed ?? Math.floor(Math.random() * 1e9) };
    this.objects.set(o.id, o);
    for (const t of this.footprint(o)) if (this.inBounds(t.x, t.z)) this.objectGrid[this.idx(t.x, t.z)] = o.id;
    this.revision++;
    this.events.emit('objectAdded', { id: o.id });
    this.refreshHabitatStats();
    return o;
  }
  removeObject(id: number): PlacedObject | undefined {
    const o = this.objects.get(id);
    if (!o) return undefined;
    for (const t of this.footprint(o)) if (this.inBounds(t.x, t.z) && this.objectGrid[this.idx(t.x, t.z)] === id) this.objectGrid[this.idx(t.x, t.z)] = 0;
    this.objects.delete(id);
    this.revision++;
    this.events.emit('objectRemoved', { id });
    this.refreshHabitatStats();
    return o;
  }
  /** Tile is free for an animal / guest to stand on (no solid object). */
  isTileSolid(x: number, z: number): boolean {
    const o = this.objectAt(x, z);
    return !!o && OBJECTS_BY_ID[o.defId].solid;
  }

  // ------------------------------------------------------------ habitats
  /** Flood-fill enclosures. Regions that touch the map border or contain paths are public space. */
  recomputeHabitats() {
    const prevOf = this.habitatOf.slice();
    const prev = this.habitats;
    const region = new Int32Array(MAP_W * MAP_H).fill(-1);
    const regions: number[][] = [];
    const stack: number[] = [];
    for (let start = 0; start < MAP_W * MAP_H; start++) {
      if (region[start] !== -1) continue;
      const rid = regions.length;
      const tiles: number[] = [];
      region[start] = rid;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop()!;
        tiles.push(i);
        const x = i % MAP_W,
          z = (i / MAP_W) | 0;
        const nbs: [number, number][] = [
          [x + 1, z],
          [x - 1, z],
          [x, z + 1],
          [x, z - 1],
        ];
        for (const [nx, nz] of nbs) {
          if (!this.inBounds(nx, nz)) continue;
          const ni = this.idx(nx, nz);
          if (region[ni] !== -1) continue;
          if (this.fenceBetween(x, z, nx, nz)) continue;
          region[ni] = rid;
          stack.push(ni);
        }
      }
      regions.push(tiles);
    }

    this.habitatOf.fill(0);
    const next = new Map<number, Habitat>();
    const usedIds = new Set<number>();
    for (const tiles of regions) {
      if (tiles.length > MAP_W * MAP_H * 0.5) continue;
      let touchesBorder = false,
        hasPath = false;
      for (const i of tiles) {
        const x = i % MAP_W,
          z = (i / MAP_W) | 0;
        if (x === 0 || z === 0 || x === MAP_W - 1 || z === MAP_H - 1) {
          // border tiles only count as enclosed if the border edge itself is fenced
          if (x === 0 && !this.vFence[this.vIdx(0, z)]) touchesBorder = true;
          if (x === MAP_W - 1 && !this.vFence[this.vIdx(MAP_W, z)]) touchesBorder = true;
          if (z === 0 && !this.hFence[this.hIdx(x, 0)]) touchesBorder = true;
          if (z === MAP_H - 1 && !this.hFence[this.hIdx(x, MAP_H)]) touchesBorder = true;
        }
        if (this.path[i]) hasPath = true;
        if (touchesBorder || hasPath) break;
      }
      if (touchesBorder || hasPath) continue;
      // keep the id of the previous habitat with the largest overlap
      const votes = new Map<number, number>();
      for (const i of tiles) {
        const p = prevOf[i];
        if (p) votes.set(p, (votes.get(p) ?? 0) + 1);
      }
      let id = 0,
        best = 0;
      for (const [pid, c] of votes) if (c > best && !usedIds.has(pid)) {
        best = c;
        id = pid;
      }
      if (!id) id = this.nextHabitatId++;
      usedIds.add(id);
      for (const i of tiles) this.habitatOf[i] = id;
      const name = this.habitatNames.get(id) ?? prev.get(id)?.name ?? `Habitat ${id}`;
      this.habitatNames.set(id, name);
      next.set(id, this.emptyHabitat(id, tiles, name));
    }
    this.habitats = next;
    this.refreshHabitatStats(false);
    this.revision++;
    this.events.emit('habitatsChanged', {});
  }

  private emptyHabitat(id: number, tiles: number[], name: string): Habitat {
    return {
      id,
      tiles,
      terrainCounts: new Array(TERRAIN_COUNT).fill(0),
      objects: [],
      minFenceStrength: 4,
      viewTiles: [],
      minX: MAP_W,
      minZ: MAP_H,
      maxX: 0,
      maxZ: 0,
      name,
    };
  }

  /** Recompute per-habitat terrain/object/fence statistics (cheap). */
  refreshHabitatStats(emit = true) {
    for (const hab of this.habitats.values()) {
      hab.terrainCounts.fill(0);
      hab.objects = [];
      hab.minFenceStrength = 4;
      hab.minX = MAP_W;
      hab.minZ = MAP_H;
      hab.maxX = 0;
      hab.maxZ = 0;
      const view = new Set<number>();
      const objs = new Set<number>();
      for (const i of hab.tiles) {
        const x = i % MAP_W,
          z = (i / MAP_W) | 0;
        hab.terrainCounts[this.terrain[i]]++;
        if (this.objectGrid[i]) objs.add(this.objectGrid[i]);
        hab.minX = Math.min(hab.minX, x);
        hab.maxX = Math.max(hab.maxX, x);
        hab.minZ = Math.min(hab.minZ, z);
        hab.maxZ = Math.max(hab.maxZ, z);
        for (const [nx, nz] of [
          [x + 1, z],
          [x - 1, z],
          [x, z + 1],
          [x, z - 1],
        ] as [number, number][]) {
          const f = this.inBounds(nx, nz)
            ? this.fenceBetween(x, z, nx, nz)
            : this.getFence(
                nx < 0 ? { dir: 'v', x: 0, z } : nx >= MAP_W ? { dir: 'v', x: MAP_W, z } : nz < 0 ? { dir: 'h', x, z: 0 } : { dir: 'h', x, z: MAP_H },
              );
          if (!f) continue;
          const def = FENCES_BY_ID[f];
          if (def) hab.minFenceStrength = Math.min(hab.minFenceStrength, def.strength);
          if (this.inBounds(nx, nz) && this.habitatOf[this.idx(nx, nz)] !== hab.id) {
            // view tiles: path tiles within 2 tiles outward of the fence
            for (let k = 0; k < 2; k++) {
              const vx = nx + (nx - x) * k,
                vz = nz + (nz - z) * k;
              if (this.inBounds(vx, vz) && this.path[this.idx(vx, vz)] && !this.habitatOf[this.idx(vx, vz)]) {
                view.add(this.idx(vx, vz));
                break;
              }
            }
          }
        }
      }
      hab.objects = Array.from(objs);
      hab.viewTiles = Array.from(view);
    }
    if (emit) this.events.emit('habitatsChanged', {});
  }

  /**
   * Read-only preview of habitat detection (the rules of recomputeHabitats), with the
   * `extra` edges treated as fenced so fences can be checked before they are built.
   * Returns a lookup giving, for a tile, why its fenced-off region is NOT a habitat,
   * or null when it is (or would be) one or is the public space around the entrance.
   * One flood fill of the map per call; the lookup is cheap.
   */
  enclosureProblems(extra: readonly EdgeRef[] = []): (x: number, z: number) => EnclosureProblem | null {
    const W = MAP_W,
      H = MAP_H,
      n = W * H;
    const hFence = this.hFence.slice();
    const vFence = this.vFence.slice();
    for (const e of extra) {
      if (!this.edgeInBounds(e)) continue;
      if (e.dir === 'h') hFence[this.hIdx(e.x, e.z)] = 1;
      else vFence[this.vIdx(e.x, e.z)] = 1;
    }
    // per tile: 0 habitat / public, else 1 + index into ENCLOSURE_PROBLEMS
    const code = new Uint8Array(n);
    const seen = new Uint8Array(n);
    const region = new Int32Array(n); // tiles of the region being flooded
    const entrance = this.idx(ENTRANCE_TILE.x, ENTRANCE_TILE.z);
    const VW = W + 1; // row stride of vFence
    const paths = this.path;
    for (let start = 0; start < n; start++) {
      if (seen[start]) continue;
      let len = 0;
      region[len++] = start;
      seen[start] = 1;
      let hasPath = false,
        mapEdge = false,
        isPublic = false;
      for (let k = 0; k < len; k++) {
        const i = region[k];
        const x = i % W,
          z = (i - x) / W;
        if (i === entrance) isPublic = true;
        if (paths[i]) hasPath = true;
        // the four sides: an open edge leads to a neighbour, or off the map
        if (!vFence[z * VW + x + 1]) {
          if (x + 1 >= W) mapEdge = true;
          else if (!seen[i + 1]) (seen[i + 1] = 1), (region[len++] = i + 1);
        }
        if (!vFence[z * VW + x]) {
          if (x === 0) mapEdge = true;
          else if (!seen[i - 1]) (seen[i - 1] = 1), (region[len++] = i - 1);
        }
        if (!hFence[(z + 1) * W + x]) {
          if (z + 1 >= H) mapEdge = true;
          else if (!seen[i + W]) (seen[i + W] = 1), (region[len++] = i + W);
        }
        if (!hFence[z * W + x]) {
          if (z === 0) mapEdge = true;
          else if (!seen[i - W]) (seen[i - W] = 1), (region[len++] = i - W);
        }
      }
      const problem: EnclosureProblem | null = isPublic ? null : hasPath ? 'path' : mapEdge ? 'mapEdge' : len > n * 0.5 ? 'tooBig' : null;
      if (problem) {
        const c = 1 + ENCLOSURE_PROBLEMS.indexOf(problem);
        for (let k = 0; k < len; k++) code[region[k]] = c;
      }
    }
    return (x, z) => (this.inBounds(x, z) && code[this.idx(x, z)] ? ENCLOSURE_PROBLEMS[code[this.idx(x, z)] - 1] : null);
  }

  habitatAt(x: number, z: number): Habitat | undefined {
    if (!this.inBounds(x, z)) return undefined;
    const id = this.habitatOf[this.idx(x, z)];
    return id ? this.habitats.get(id) : undefined;
  }
  renameHabitat(id: number, name: string) {
    this.habitatNames.set(id, name);
    const h = this.habitats.get(id);
    if (h) h.name = name;
    this.events.emit('habitatsChanged', {});
  }

  // ------------------------------------------------------------ helpers
  clampRect(r: TileRect): TileRect {
    return {
      x0: clamp(Math.min(r.x0, r.x1), 0, MAP_W - 1),
      z0: clamp(Math.min(r.z0, r.z1), 0, MAP_H - 1),
      x1: clamp(Math.max(r.x0, r.x1), 0, MAP_W - 1),
      z1: clamp(Math.max(r.z0, r.z1), 0, MAP_H - 1),
    };
  }

  // ------------------------------------------------------------ new game
  /** Lay out a fresh zoo: entrance plaza, starter path, a pond and some wild trees. */
  generateStarterMap() {
    const rng = new Rng(this.seed);
    const ex = ENTRANCE_TILE.x,
      ez = ENTRANCE_TILE.z;
    this.terrain.fill(Terrain.Grass);
    // gentle natural terrain variety
    const n = new Noise(this.seed + 7);
    for (let z = 0; z < MAP_H; z++)
      for (let x = 0; x < MAP_W; x++) {
        const v = n.fbm2(x * 0.08, z * 0.08, 3);
        if (v > 0.38) this.terrain[this.idx(x, z)] = Terrain.DryGrass;
        else if (v < -0.45) this.terrain[this.idx(x, z)] = Terrain.Dirt;
      }
    // a natural pond in the north-west
    const pcx = 14 + rng.int(0, 4),
      pcz = 14 + rng.int(0, 4);
    for (let z = pcz - 5; z <= pcz + 5; z++)
      for (let x = pcx - 6; x <= pcx + 6; x++) {
        if (!this.inBounds(x, z)) continue;
        const d = Math.hypot((x - pcx) / 6, (z - pcz) / 4.5) + n.noise2(x * 0.3, z * 0.3) * 0.18;
        if (d < 0.55) this.terrain[this.idx(x, z)] = Terrain.DeepWater;
        else if (d < 0.9) this.terrain[this.idx(x, z)] = Terrain.Water;
        else if (d < 1.1) this.terrain[this.idx(x, z)] = Terrain.Mud;
      }
    this.recomputeHeights({ x0: 0, z0: 0, x1: MAP_W - 1, z1: MAP_H - 1 });

    // entrance gate + plaza + main avenue
    for (let z = ez - 2; z <= ez; z++) for (let x = ex - 2; x <= ex + 2; x++) this.path[this.idx(x, z)] = PathType.Paved;
    for (let z = ez - 14; z < ez - 2; z++) this.path[this.idx(ex, z)] = PathType.Paved;
    for (let x = ex - 8; x <= ex + 8; x++) this.path[this.idx(x, ez - 14)] = PathType.Paved;
    this.addObject('entrance_gate', ex - 1, ez, 0, 1);
    this.addObject('lamp', ex - 3, ez - 2, 0, 2);
    this.addObject('lamp', ex + 3, ez - 2, 0, 3);
    this.addObject('bin', ex + 1, ez - 5, 0, 4);
    this.addObject('bench', ex - 1, ez - 8, 1, 5);
    this.addObject('flower_bed', ex - 3, ez - 1, 0, 6);
    this.addObject('flower_bed', ex + 3, ez - 1, 0, 7);

    // wild trees scattered away from the avenue
    const kinds = ['tree_oak', 'tree_oak', 'tree_birch', 'tree_pine', 'bush_fern', 'rock_boulder'];
    for (let k = 0; k < 70; k++) {
      const x = rng.int(1, MAP_W - 2),
        z = rng.int(1, MAP_H - 2);
      if (Math.abs(x - ex) < 10 && z > ez - 18) continue;
      const def = OBJECTS_BY_ID[rng.pick(kinds)];
      if (this.canPlaceObject(def, x, z, 0) === null) this.addObject(def.id, x, z, rng.int(0, 3), rng.int(0, 1e9));
    }
    this.recomputeHabitats();
    this.revision++;
    this.events.emit('worldReset', {});
  }

  // ------------------------------------------------------------ save / load
  serialize(): WorldSave {
    return {
      version: 1,
      seed: this.seed,
      terrain: Array.from(this.terrain),
      path: Array.from(this.path),
      hFence: Array.from(this.hFence),
      vFence: Array.from(this.vFence),
      objects: Array.from(this.objects.values()),
      nextObjectId: this.nextObjectId,
      habitatNames: Object.fromEntries(
        Array.from(this.habitatNames).filter(([id]) => this.habitats.has(id)),
      ),
      habitatRle: rleEncode(this.habitatOf),
      nextHabitatId: this.nextHabitatId,
    };
  }

  load(s: WorldSave) {
    this.seed = s.seed;
    this.buildRelief();
    this.terrain.set(s.terrain);
    this.path.set(s.path);
    this.hFence.set(s.hFence);
    this.vFence.set(s.vFence);
    this.objects.clear();
    this.objectGrid.fill(0);
    for (const o of s.objects) {
      this.objects.set(o.id, { ...o });
      for (const t of this.footprint(o)) if (this.inBounds(t.x, t.z)) this.objectGrid[this.idx(t.x, t.z)] = o.id;
    }
    this.nextObjectId = s.nextObjectId;
    this.habitatNames = new Map(Object.entries(s.habitatNames ?? {}).map(([k, v]) => [Number(k), v]));
    this.recomputeHeights({ x0: 0, z0: 0, x1: MAP_W - 1, z1: MAP_H - 1 });
    this.habitatOf.fill(0);
    // Seed the previous labelling so recomputeHabitats' overlap vote keeps the saved ids.
    if (s.habitatRle) rleDecode(s.habitatRle, this.habitatOf);
    let maxId = 0;
    for (const k of this.habitatNames.keys()) maxId = Math.max(maxId, k);
    for (let i = 0; i < this.habitatOf.length; i++) maxId = Math.max(maxId, this.habitatOf[i]);
    this.nextHabitatId = Math.max(s.nextHabitatId ?? 0, maxId + 1);
    this.habitats = new Map();
    this.recomputeHabitats();
    this.revision++;
    this.events.emit('worldReset', {});
  }
}

function rleEncode(a: Int32Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < a.length) {
    const v = a[i];
    let n = 1;
    while (i + n < a.length && a[i + n] === v) n++;
    out.push(v, n);
    i += n;
  }
  return out;
}

function rleDecode(rle: number[], out: Int32Array): void {
  let p = 0;
  for (let k = 0; k + 1 < rle.length; k += 2) {
    const v = rle[k] | 0,
      n = rle[k + 1] | 0;
    for (let j = 0; j < n && p < out.length; j++) out[p++] = v;
  }
}
