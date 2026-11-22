// Navigation for the simulation.
//
//  PathNav   — guests and staff walk ONLY on path tiles. Goals are reached by
//              following cached BFS distance fields (one per goal: a habitat's
//              viewing tiles, "nearest restroom", a single tile…). Fields are
//              rebuilt lazily after the path network / objects change.
//  TileSearch — bounded 8-connected BFS for animals inside a habitat (or loose
//              in public space), with a caller supplied passability test.

import { MAP_H, MAP_W } from '../core/constants';
import type { EventBus } from '../core/events';
import type { World } from '../core/world';
import { OBJECTS_BY_ID } from '../data/objects';
import type { PlacedObject } from '../core/types';
import { hash01 } from './rng';

export const N_TILES = MAP_W * MAP_H;
export const FAR = 0xffff;

const DX = [1, -1, 0, 0];
const DZ = [0, 0, 1, -1];
/** Bit for each of the 4 directions in the adjacency mask. */
const BIT = [1, 2, 4, 8];

const MAX_FIELDS = 160;

export class PathNav {
  /** Bit mask per tile of open path neighbours (+x, -x, +z, -z). 0 for non-path tiles. */
  readonly adj = new Uint8Array(N_TILES);
  private fields = new Map<string, Uint16Array>();
  private pool: Uint16Array[] = [];
  private dirty = true;
  private queue = new Int32Array(N_TILES);
  private sources: number[] = [];
  /** Count of fields computed (diagnostics / tests). */
  computed = 0;
  private offs: (() => void)[] = [];

  constructor(private world: World, events: EventBus) {
    const mark = () => (this.dirty = true);
    this.offs.push(
      events.on('pathChanged', mark),
      events.on('fenceChanged', mark),
      events.on('objectAdded', mark),
      events.on('objectRemoved', mark),
      events.on('habitatsChanged', mark),
      events.on('worldReset', mark),
    );
  }

  dispose() {
    this.offs.forEach((f) => f());
  }

  markDirty() {
    this.dirty = true;
  }

  private refresh() {
    if (!this.dirty) return;
    this.dirty = false;
    for (const f of this.fields.values()) this.pool.push(f);
    this.fields.clear();
    const w = this.world;
    const adj = this.adj;
    for (let z = 0; z < MAP_H; z++)
      for (let x = 0; x < MAP_W; x++) {
        const i = z * MAP_W + x;
        let m = 0;
        if (w.path[i]) {
          for (let d = 0; d < 4; d++) {
            const nx = x + DX[d],
              nz = z + DZ[d];
            if (nx < 0 || nz < 0 || nx >= MAP_W || nz >= MAP_H) continue;
            const ni = nz * MAP_W + nx;
            if (!w.path[ni]) continue;
            if (w.fenceBetween(x, z, nx, nz)) continue;
            m |= BIT[d];
          }
        }
        adj[i] = m;
      }
  }

  /** Make sure the adjacency mask is current (call before reading `adj`). */
  sync() {
    this.refresh();
  }

  isPath(i: number): boolean {
    return this.world.path[i] !== 0;
  }

  /**
   * Distance field (in tiles) towards the nearest of the sources produced by
   * `fill`. Cached under `key` until the world's paths/objects change.
   */
  field(key: string, fill: (out: number[]) => void): Uint16Array {
    this.refresh();
    let f = this.fields.get(key);
    if (f) return f;
    if (this.fields.size >= MAX_FIELDS) {
      // drop the oldest entry (Map keeps insertion order)
      const oldest = this.fields.keys().next().value as string;
      this.pool.push(this.fields.get(oldest)!);
      this.fields.delete(oldest);
    }
    f = this.pool.pop() ?? new Uint16Array(N_TILES);
    const src = this.sources;
    src.length = 0;
    fill(src);
    this.bfs(src, f);
    this.fields.set(key, f);
    this.computed++;
    return f;
  }

  /** Field cached under key if present (no compute). */
  peek(key: string): Uint16Array | undefined {
    this.refresh();
    return this.fields.get(key);
  }

  /** BFS from an arbitrary set of tiles into `out` (not cached). */
  bfs(sources: readonly number[], out: Uint16Array) {
    out.fill(FAR);
    const q = this.queue;
    let head = 0,
      tail = 0;
    for (const s of sources) {
      if (s < 0 || s >= N_TILES || !this.world.path[s] || out[s] === 0) continue;
      out[s] = 0;
      q[tail++] = s;
    }
    const adj = this.adj;
    while (head < tail) {
      const i = q[head++];
      const m = adj[i];
      if (!m) continue;
      const nd = out[i] + 1;
      if (m & 1 && out[i + 1] > nd) {
        out[i + 1] = nd;
        q[tail++] = i + 1;
      }
      if (m & 2 && out[i - 1] > nd) {
        out[i - 1] = nd;
        q[tail++] = i - 1;
      }
      if (m & 4 && out[i + MAP_W] > nd) {
        out[i + MAP_W] = nd;
        q[tail++] = i + MAP_W;
      }
      if (m & 8 && out[i - MAP_W] > nd) {
        out[i - MAP_W] = nd;
        q[tail++] = i - MAP_W;
      }
    }
  }

  /** Neighbour of `tile` one step closer along the field (-1 if none). Ties broken per walker. */
  downhill(f: Uint16Array, tile: number, salt: number): number {
    const d = f[tile];
    if (d === 0 || d === FAR) return -1;
    const m = this.adj[tile];
    let best = -1,
      bestScore = -1;
    for (let k = 0; k < 4; k++) {
      if (!(m & BIT[k])) continue;
      const n = tile + DX[k] + DZ[k] * MAP_W;
      if (f[n] >= d) continue;
      const s = hash01(salt + n, tile);
      if (s > bestScore) {
        bestScore = s;
        best = n;
      }
    }
    return best;
  }

  /** Random-walk step that prefers to keep going straight and avoids U-turns. */
  wanderStep(tile: number, prev: number, r: number): number {
    const m = this.adj[tile];
    if (!m) return -1;
    const straight = prev >= 0 ? tile + (tile - prev) : -1;
    let count = 0;
    let only = -1;
    for (let k = 0; k < 4; k++) {
      if (!(m & BIT[k])) continue;
      const n = tile + DX[k] + DZ[k] * MAP_W;
      if (n === prev) {
        only = n;
        continue;
      }
      count++;
    }
    if (count === 0) return only; // dead end → turn back
    if (straight >= 0 && straight !== prev && this.isNeighbour(tile, straight) && r < 0.6) return straight;
    let pick = Math.floor(((r * 1.618) % 1) * count);
    for (let k = 0; k < 4; k++) {
      if (!(m & BIT[k])) continue;
      const n = tile + DX[k] + DZ[k] * MAP_W;
      if (n === prev) continue;
      if (pick-- === 0) return n;
    }
    return only;
  }

  private isNeighbour(tile: number, n: number): boolean {
    const m = this.adj[tile];
    const d = n - tile;
    if (d === 1) return (m & 1) !== 0 && n % MAP_W !== 0;
    if (d === -1) return (m & 2) !== 0 && tile % MAP_W !== 0;
    if (d === MAP_W) return (m & 4) !== 0;
    if (d === -MAP_W) return (m & 8) !== 0;
    return false;
  }

  /** Nearest path tile to (tx, tz) within `radius` tiles (Chebyshev rings), or -1. */
  nearestPathTile(tx: number, tz: number, radius: number, allowHabitat = false): number {
    const w = this.world;
    for (let r = 0; r <= radius; r++) {
      let best = -1,
        bestD = Infinity;
      for (let z = tz - r; z <= tz + r; z++)
        for (let x = tx - r; x <= tx + r; x++) {
          if (Math.max(Math.abs(x - tx), Math.abs(z - tz)) !== r) continue;
          if (x < 0 || z < 0 || x >= MAP_W || z >= MAP_H) continue;
          const i = z * MAP_W + x;
          if (!w.path[i]) continue;
          if (!allowHabitat && w.habitatOf[i]) continue;
          const d = (x - tx) * (x - tx) + (z - tz) * (z - tz);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Path tiles orthogonally adjacent to an object's footprint (no fence in between). */
  accessTiles(o: PlacedObject, out: number[]) {
    const w = this.world;
    const def = OBJECTS_BY_ID[o.defId];
    if (!def) return;
    const fp = w.footprint(o);
    for (const t of fp) {
      for (let k = 0; k < 4; k++) {
        const nx = t.x + DX[k],
          nz = t.z + DZ[k];
        if (nx < 0 || nz < 0 || nx >= MAP_W || nz >= MAP_H) continue;
        const ni = nz * MAP_W + nx;
        if (w.objectGrid[ni] === o.id) continue;
        if (!w.path[ni]) continue;
        if (w.fenceBetween(t.x, t.z, nx, nz)) continue;
        if (!out.includes(ni)) out.push(ni);
      }
    }
  }
}

// ---------------------------------------------------------------------------

export type Passable = (fromTile: number, toTile: number) => boolean;

/** Octile distance heuristic from tile i to (gx, gz). */
function octile(i: number, gx: number, gz: number): number {
  const dx = Math.abs((i % MAP_W) - gx),
    dz = Math.abs(((i / MAP_W) | 0) - gz);
  return dx > dz ? dx + 0.4142 * dz : dz + 0.4142 * dx;
}

const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ8 = [0, 0, 1, -1, 1, -1, 1, -1];

/** Bounded searches over tiles for animals. Reuses typed arrays (no per-search allocation besides the result). */
export class TileSearch {
  private stamp = new Uint32Array(N_TILES);
  private closed = new Uint32Array(N_TILES);
  private prev = new Int32Array(N_TILES);
  private g = new Float32Array(N_TILES);
  private queue = new Int32Array(N_TILES);
  private heapN = new Int32Array(N_TILES * 4);
  private heapF = new Float32Array(N_TILES * 4);
  private heapLen = 0;
  private gen = 1;
  /** Nodes expanded by the last route() call (diagnostics). */
  lastExpanded = 0;

  private nextGen(): number {
    if (++this.gen >= 0xfffffff0) {
      this.stamp.fill(0);
      this.closed.fill(0);
      this.gen = 1;
    }
    return this.gen;
  }

  private push(n: number, f: number) {
    if (this.heapLen >= this.heapN.length) return;
    const hn = this.heapN,
      hf = this.heapF;
    let i = this.heapLen++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      hn[i] = hn[p];
      hf[i] = hf[p];
      i = p;
    }
    hn[i] = n;
    hf[i] = f;
  }

  private pop(): number {
    const hn = this.heapN,
      hf = this.heapF;
    const top = hn[0];
    const last = --this.heapLen;
    if (last > 0) {
      const n = hn[last],
        f = hf[last];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= last) break;
        if (c + 1 < last && hf[c + 1] < hf[c]) c++;
        if (hf[c] >= f) break;
        hn[i] = hn[c];
        hf[i] = hf[c];
        i = c;
      }
      hn[i] = n;
      hf[i] = f;
    }
    return top;
  }

  /**
   * Shortest 8-connected route (A*, octile metric) from `start` to `goal`.
   * Returns the tiles after `start` up to and including `goal`, or null when
   * unreachable within `maxNodes` expansions. Diagonal moves require both
   * orthogonal tiles to be passable too (no corner cutting).
   */
  route(start: number, goal: number, pass: Passable, maxNodes = 4000, out: number[] = []): number[] | null {
    out.length = 0;
    this.lastExpanded = 0;
    if (start === goal) return out;
    const gen = this.nextGen();
    const stamp = this.stamp,
      closed = this.closed,
      prev = this.prev,
      g = this.g;
    const gx = goal % MAP_W,
      gz = (goal / MAP_W) | 0;
    this.heapLen = 0;
    stamp[start] = gen;
    g[start] = 0;
    prev[start] = -1;
    this.push(start, octile(start, gx, gz));
    let found = false;
    let expanded = 0;
    while (this.heapLen > 0 && expanded < maxNodes) {
      const i = this.pop();
      if (closed[i] === gen) continue;
      closed[i] = gen;
      expanded++;
      if (i === goal) {
        found = true;
        break;
      }
      const x = i % MAP_W,
        z = (i / MAP_W) | 0;
      const gi = g[i];
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k],
          nz = z + DZ8[k];
        if (nx < 0 || nz < 0 || nx >= MAP_W || nz >= MAP_H) continue;
        const ni = nz * MAP_W + nx;
        if (closed[ni] === gen) continue;
        const cost = k >= 4 ? 1.4142 : 1;
        const ng = gi + cost;
        if (stamp[ni] === gen && ng >= g[ni]) continue;
        if (k >= 4) {
          const a = z * MAP_W + nx,
            b = nz * MAP_W + x;
          if (!pass(i, a) || !pass(i, b) || !pass(a, ni) || !pass(b, ni)) continue;
        } else if (!pass(i, ni)) continue;
        stamp[ni] = gen;
        g[ni] = ng;
        prev[ni] = i;
        this.push(ni, ng + octile(ni, gx, gz));
      }
    }
    this.lastExpanded = expanded;
    if (!found) return null;
    let c = goal;
    while (c !== start && c >= 0) {
      out.push(c);
      c = prev[c];
    }
    out.reverse();
    return out;
  }

  /**
   * BFS outward from `start`; returns the first tile accepted by `accept`
   * (nearest by steps) or -1.
   */
  nearest(start: number, pass: Passable, accept: (tile: number) => boolean, maxNodes = 4000): number {
    this.nextGen();
    const stamp = this.stamp,
      q = this.queue;
    let head = 0,
      tail = 0;
    stamp[start] = this.gen;
    q[tail++] = start;
    while (head < tail && head < maxNodes) {
      const i = q[head++];
      if (accept(i)) return i;
      const x = i % MAP_W,
        z = (i / MAP_W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX8[k],
          nz = z + DZ8[k];
        if (nx < 0 || nz < 0 || nx >= MAP_W || nz >= MAP_H) continue;
        const ni = nz * MAP_W + nx;
        if (stamp[ni] === this.gen) continue;
        if (!pass(i, ni)) continue;
        stamp[ni] = this.gen;
        q[tail++] = ni;
      }
    }
    return -1;
  }
}
