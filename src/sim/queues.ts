// Service points and orderly queues.
//
// Every shop and restroom gets a ServicePoint: one or two counter / door spots
// in front of the building (models serve from their local +Z face), a queue
// line that starts on the path just outside the counter and runs along the
// path (turning with it when needed), and an exit point on the other side so
// served guests do not walk back through the line. Geometry is rebuilt when
// the world changes; occupancy (who is served, who waits in which place, who is
// inside) is kept here and mirrored on the guests (qObj / qPos) so it can be
// restored exactly after loading a save.

import { MAP_H, MAP_W, TILE } from '../core/constants';
import type { PlacedObject, ShopKind } from '../core/types';
import type { World } from '../core/world';
import { OBJECTS_BY_ID, rotatedSize } from '../data/objects';
import type { GuestSim } from './state';

/** qPos of a guest at counter / door spot k is QP_SERVE + k. */
export const QP_SERVE = 100;
/** qPos of a guest inside a building (restroom cubicle, browsing the gift shop). */
export const QP_INSIDE = 200;
/** Distance between people waiting in line (m). */
const GAP = 0.62;
/** People in line keep this far from a non-path tile edge (m). */
const EDGE = 0.32;
/** Line points of different service points keep this far apart (m). */
const CLEAR = 0.55;

export type ServiceKind = ShopKind | 'restroom';

interface Layout {
  /** 'counter': served while standing at a spot; 'enter': walk in through a door spot and stay hidden. */
  mode: 'counter' | 'enter';
  /** Spots in model space [x, z] (the model faces +Z). */
  spots: [number, number][];
  /** Guests served / inside at once ('enter' mode); counter mode serves one per spot. */
  capacity: number;
  /** Longest line before newcomers give up. */
  maxLine: number;
}

// Matches the procedural buildings in src/props/structures (serving hatch / doors on the +Z face).
const LAYOUTS: Record<string, Layout> = {
  shop_snack: { mode: 'counter', spots: [[-0.5, 1.62], [0.5, 1.62]], capacity: 2, maxLine: 9 },
  shop_drinks: { mode: 'counter', spots: [[0, 0.9]], capacity: 1, maxLine: 7 },
  shop_icecream: { mode: 'counter', spots: [[0, 0.78]], capacity: 1, maxLine: 7 },
  shop_gift: { mode: 'enter', spots: [[0.97, 1.5]], capacity: 4, maxLine: 6 },
  restroom: { mode: 'enter', spots: [[-0.95, 1.42], [0.95, 1.42]], capacity: 4, maxLine: 6 },
};

export class ServicePoint {
  readonly key: string;
  mode: 'counter' | 'enter' = 'counter';
  capacity = 1;
  maxLine = 6;
  /** Counter / door spots (world m) and the heading to face there. */
  sx: number[] = [];
  sz: number[] = [];
  sh: number[] = [];
  /** Line places (world m), place 0 nearest the counter, and the heading to face there. */
  lx: number[] = [];
  lz: number[] = [];
  lh: number[] = [];
  /** Tile under each line place. */
  lt: number[] = [];
  /** Where served guests step to before walking on. */
  ex = 0;
  ez = 0;
  exitTile = -1;
  /** Path tile guests navigate to (the tile under line place 0). */
  tile = -1;
  /** Outward normal of the serving side (from the building onto the path) and the line's direction. */
  nx = 0;
  nz = 1;
  dx = 1;
  dz = 0;
  /** Guests at each spot (counter: being served; enter: stepping through the door). */
  serving: (GuestSim | null)[] = [];
  line: GuestSim[] = [];
  inside: GuestSim[] = [];

  constructor(
    readonly obj: number,
    readonly service: ServiceKind,
  ) {
    this.key = `o:${obj}`;
  }

  /** Places available in the line. */
  get maxQueue(): number {
    return Math.min(this.maxLine, this.lx.length);
  }
  full(): boolean {
    return this.line.length >= this.maxQueue;
  }
  /** Guests being served / inside / stepping in. */
  busy(): number {
    let n = this.inside.length;
    for (const s of this.serving) if (s) n++;
    return n;
  }
}

/** Service kind of an object def (null if guests don't queue there). */
export function serviceOf(defId: string): ServiceKind | null {
  const d = OBJECTS_BY_ID[defId];
  if (!d) return null;
  if (d.restroom) return 'restroom';
  return d.shop ? d.shop.kind : null;
}

export class QueueSystem {
  readonly points = new Map<number, ServicePoint>();
  /**
   * Per path tile: which side passers-by should keep to so they don't walk
   * through a queue (0 = no queue, else 1 + index of the outward normal in
   * [+x, -x, +z, -z]).
   */
  readonly side = new Uint8Array(MAP_W * MAP_H);
  private rev = -1;
  private taken: number[] = [];
  private pts: number[] = [];

  constructor(private world: World) {}

  /** Forget all geometry and occupancy (after load / new game); rebuilt on the next sync. */
  reset() {
    this.points.clear();
    this.side.fill(0);
    this.rev = -1;
  }

  /**
   * Rebuild geometry when the world changed, keeping who waits where. Guests
   * whose place no longer exists (building gone, line shortened) are pushed to
   * `released` with their queue state cleared.
   */
  sync(released: GuestSim[]): void {
    if (this.rev === this.world.revision) return;
    this.rev = this.world.revision;
    const old = new Map(this.points);
    this.points.clear();
    this.taken.length = 0;
    // pass 1: counters / doors and line heads of every building, so no line runs across another's front
    const heads: { o: PlacedObject; service: ServiceKind; p: ServicePoint; hx: number; hz: number; tx: number; tz: number; nx: number; nz: number; max: number }[] = [];
    for (const o of this.world.objects.values()) {
      const service = serviceOf(o.defId);
      if (!service) continue;
      const h = this.front(o, service);
      if (!h) continue;
      heads.push(h);
      const t = this.taken;
      for (let k = 0; k < h.p.sx.length; k++) t.push(h.p.sx[k], h.p.sz[k]);
      t.push(h.hx, h.hz);
    }
    // pass 2: lines
    for (const h of heads) {
      const o = h.o;
      const p = this.lineFor(h);
      if (!p) continue;
      const prev = old.get(o.id);
      if (prev) {
        old.delete(o.id);
        for (let k = 0; k < prev.serving.length; k++) {
          const g = prev.serving[k];
          if (!g) continue;
          if (k < p.serving.length) p.serving[k] = g;
          else this.drop(g, released);
        }
        p.inside = prev.inside;
        for (let i = 0; i < prev.line.length; i++) {
          if (i < p.maxQueue) p.line.push(prev.line[i]);
          else this.drop(prev.line[i], released);
        }
      }
      this.points.set(o.id, p);
    }
    for (const p of old.values()) {
      for (const g of p.serving) if (g) this.drop(g, released);
      for (const g of p.line) this.drop(g, released);
      for (const g of p.inside) this.drop(g, released);
    }
    const side = this.side;
    side.fill(0);
    for (const p of this.points.values()) {
      const code = p.nx > 0.5 ? 1 : p.nx < -0.5 ? 2 : p.nz > 0.5 ? 3 : 4;
      for (let i = 0; i < p.lt.length; i++) side[p.lt[i]] = code;
      if (p.tile >= 0) side[p.tile] = code;
    }
  }

  private drop(g: GuestSim, released: GuestSim[]) {
    g.qObj = 0;
    g.qPos = -1;
    released.push(g);
  }

  /**
   * Rebuild occupancy from the guests' own qObj / qPos (after loading a save).
   * Guests whose service point is gone get their queue state cleared and are
   * returned in `released`.
   */
  rebuildFrom(guests: Iterable<GuestSim>, released: GuestSim[]) {
    for (const p of this.points.values()) {
      p.serving.fill(null);
      p.line.length = 0;
      p.inside.length = 0;
    }
    for (const g of guests) {
      if (!g.qObj || g.qPos < 0) continue;
      const p = this.points.get(g.qObj);
      if (!p) {
        this.drop(g, released);
        continue;
      }
      if (g.qPos === QP_INSIDE) p.inside.push(g);
      else if (g.qPos >= QP_SERVE) {
        const k = g.qPos - QP_SERVE;
        if (k < p.serving.length && !p.serving[k]) p.serving[k] = g;
        else {
          g.qPos = -1; // walk up to the line again
        }
      } else p.line.push(g);
    }
    for (const p of this.points.values()) {
      p.line.sort((a, b) => a.qPos - b.qPos || a.id - b.id);
      while (p.line.length > p.maxQueue) this.drop(p.line.pop()!, released);
      this.renumber(p);
    }
  }

  /** Add a guest to the end of the line. False when the line is full. */
  join(p: ServicePoint, g: GuestSim): boolean {
    if (p.full()) return false;
    p.line.push(g);
    g.qObj = p.obj;
    g.qPos = p.line.length - 1;
    g.qWait = 0;
    g.phase = 1;
    return true;
  }

  /** Remove a guest from whatever place it holds (line, spot, inside). */
  leave(g: GuestSim) {
    const p = this.points.get(g.qObj);
    if (p) {
      const i = p.line.indexOf(g);
      if (i >= 0) {
        p.line.splice(i, 1);
        this.renumber(p);
      }
      for (let k = 0; k < p.serving.length; k++) if (p.serving[k] === g) p.serving[k] = null;
      const j = p.inside.indexOf(g);
      if (j >= 0) p.inside.splice(j, 1);
    }
    g.qObj = 0;
    g.qPos = -1;
  }

  /** Move a guest from its door spot to the inside of the building. */
  enter(p: ServicePoint, g: GuestSim) {
    for (let k = 0; k < p.serving.length; k++) if (p.serving[k] === g) p.serving[k] = null;
    p.inside.push(g);
    g.qPos = QP_INSIDE;
  }

  /** Call the head of each line to a free counter / door. */
  advance() {
    for (const p of this.points.values()) {
      if (!p.line.length) continue;
      let room = p.mode === 'enter' ? p.capacity - p.busy() : Infinity;
      let moved = false;
      for (let k = 0; k < p.serving.length && p.line.length && room > 0; k++) {
        if (p.serving[k]) continue;
        const g = p.line.shift()!;
        p.serving[k] = g;
        g.qPos = QP_SERVE + k;
        g.phase = 1;
        room--;
        moved = true;
      }
      if (moved) this.renumber(p);
    }
  }

  private renumber(p: ServicePoint) {
    for (let i = 0; i < p.line.length; i++) {
      const g = p.line[i];
      if (g.qPos !== i) {
        g.qPos = i;
        g.phase = 1; // shuffle forward
      }
    }
  }

  // ------------------------------------------------------------ geometry
  private front(
    o: PlacedObject,
    service: ServiceKind,
  ): { o: PlacedObject; service: ServiceKind; p: ServicePoint; hx: number; hz: number; tx: number; tz: number; nx: number; nz: number; max: number } | null {
    const w = this.world;
    const def = OBJECTS_BY_ID[o.defId];
    const lay: Layout = LAYOUTS[o.defId] ?? {
      mode: service === 'restroom' ? 'enter' : 'counter',
      spots: [[0, 0]],
      capacity: service === 'restroom' ? 3 : 1,
      maxLine: 6,
    };
    const p = new ServicePoint(o.id, service);
    p.mode = lay.mode;
    p.capacity = lay.capacity;
    p.maxLine = lay.maxLine;
    const r = o.rot & 3;
    // front normal (model +Z) and local +X in world space
    const fx = [0, 1, 0, -1][r],
      fz = [1, 0, -1, 0][r];
    const rx = fz,
      rz = -fx;
    const [sw, sd] = rotatedSize(def, r);
    const cx = (o.tx + sw / 2) * TILE,
      cz = (o.tz + sd / 2) * TILE;
    const halfF = ((fx !== 0 ? sw : sd) * TILE) / 2;
    let lat = 0;
    for (const s of lay.spots) lat += s[0];
    lat /= lay.spots.length;
    // line place 0: on the path half a metre beyond the front edge, centred on the counter(s)
    let nX = fx,
      nZ = fz;
    let l0x = cx + rx * lat + fx * (halfF + 0.5),
      l0z = cz + rz * lat + fz * (halfF + 0.5);
    let tX = rx,
      tZ = rz;
    if (this.standable(l0x, l0z) && !this.fenceToFootprint(o, l0x, l0z)) {
      for (const s of lay.spots) {
        const lz = s[1] || halfF - 0.15;
        p.sx.push(cx + rx * s[0] + fx * lz);
        p.sz.push(cz + rz * s[0] + fz * lz);
        p.sh.push(Math.atan2(-fx, -fz));
      }
    } else {
      // The front does not open onto a path: serve from the best side that does.
      const side = this.bestSide(o, cx + fx * halfF, cz + fz * halfF);
      if (!side) return null;
      const [ax, az, nx, nz] = side; // access tile + outward normal
      nX = nx;
      nZ = nz;
      tX = -nz;
      tZ = nx;
      const ex = (ax + 0.5) * TILE - nx * (TILE / 2),
        ez = (az + 0.5) * TILE - nz * (TILE / 2);
      const n = lay.spots.length;
      for (let k = 0; k < n; k++) {
        const off = n > 1 ? (k - (n - 1) / 2) * 0.9 : 0;
        p.sx.push(ex + nx * 0.36 + tX * off);
        p.sz.push(ez + nz * 0.36 + tZ * off);
        p.sh.push(Math.atan2(-nx, -nz));
      }
      l0x = ex + nx * 1.0;
      l0z = ez + nz * 1.0;
    }
    p.serving = new Array(p.sx.length).fill(null);
    if (!this.standable(l0x, l0z)) return null;
    p.tile = this.tileOf(l0x, l0z);
    return { o, service, p, hx: l0x, hz: l0z, tx: tX, tz: tZ, nx: nX, nz: nZ, max: lay.maxLine };
  }

  private lineFor(h: { p: ServicePoint; hx: number; hz: number; tx: number; tz: number; nx: number; nz: number; max: number }): ServicePoint | null {
    const p = h.p;
    const l0x = h.hx,
      l0z = h.hz,
      tX = h.tx,
      tZ = h.tz,
      nX = h.nx,
      nZ = h.nz;
    // this point's own reservations must not block its line
    this.ownX = l0x;
    this.ownZ = l0z;
    this.ownP = p;
    // the line runs along the path; pick the side with more room
    const a = this.march(l0x, l0z, tX, tZ, nX, nZ, h.max);
    const aPts = this.pts;
    const b = this.march(l0x, l0z, -tX, -tZ, nX, nZ, h.max);
    let dirX = tX,
      dirZ = tZ;
    if (a >= b) this.pts = aPts;
    else {
      dirX = -tX;
      dirZ = -tZ;
    }
    p.nx = nX;
    p.nz = nZ;
    p.dx = dirX;
    p.dz = dirZ;
    const pts = this.pts;
    for (let i = 0; i < pts.length; i += 2) {
      p.lx.push(pts[i]);
      p.lz.push(pts[i + 1]);
      p.lt.push(this.tileOf(pts[i], pts[i + 1]));
      // face the place ahead (place 0 faces the counters)
      if (i === 0) {
        let mx = 0,
          mz = 0;
        for (let k = 0; k < p.sx.length; k++) {
          mx += p.sx[k];
          mz += p.sz[k];
        }
        p.lh.push(Math.atan2(mx / p.sx.length - pts[0], mz / p.sx.length - pts[1]));
      } else p.lh.push(Math.atan2(pts[i - 2] - pts[i], pts[i - 1] - pts[i + 1]));
    }
    // exit: the other side of place 0, or further out onto the path
    const cands = [
      [l0x - dirX * 1.15, l0z - dirZ * 1.15],
      [l0x + nX * 0.75 - dirX * 0.6, l0z + nZ * 0.75 - dirZ * 0.6],
      [l0x + nX * 0.7, l0z + nZ * 0.7],
    ];
    p.ex = l0x;
    p.ez = l0z;
    for (const [x, z] of cands) {
      if (this.standable(x, z) && this.clearOf(x, z, 0.4) && this.stepOk(this.tileOf(l0x, l0z), this.tileOf(x, z))) {
        p.ex = x;
        p.ez = z;
        break;
      }
    }
    p.exitTile = this.tileOf(p.ex, p.ez);
    // reserve this line and exit so neighbouring lines keep clear
    const t = this.taken;
    for (let i = 1; i < p.lx.length; i++) t.push(p.lx[i], p.lz[i]);
    t.push(p.ex, p.ez);
    this.ownP = null;
    return p;
  }

  /**
   * Walk a line out from (x, z) along (dx, dz); result in this.pts. Returns a
   * score: places, minus a penalty per turn and per place close to another
   * building's counter or line head (a straight line clear of others wins).
   */
  private march(x: number, z: number, dx: number, dz: number, nx: number, nz: number, max: number): number {
    const pts = (this.pts = [x, z]);
    if (!this.clearOf(x, z, CLEAR)) return 1;
    let penalty = 0;
    const t0x = dx,
      t0z = dz;
    let px = x,
      pz = z;
    for (let k = 1; k < max; k++) {
      let ok = false;
      // keep going, else turn away from the building, else turn along the path
      const tries = [dx, dz, nx, nz, -dz, dx, dz, -dx];
      for (let q = 0; q < 8 && !ok; q += 2) {
        const ax = tries[q],
          az = tries[q + 1];
        if (ax === -dx && az === -dz) continue; // never double back
        if (ax * nx + az * nz < -0.5) continue; // never towards the building
        if (ax * t0x + az * t0z < -0.5) continue; // never back along the start direction
        const qx = px + ax * GAP,
          qz = pz + az * GAP;
        if (!this.standable(qx, qz) || !this.stepOk(this.tileOf(px, pz), this.tileOf(qx, qz))) continue;
        // never queue across a junction (keep crossings free for passers-by)
        const qt = this.tileOf(qx, qz);
        if (qt !== this.tileOf(x, z) && this.junction(qt)) continue;
        if (!this.clearOf(qx, qz, CLEAR) || this.nearOwn(qx, qz, pts)) continue;
        if (ax !== dx || az !== dz) penalty += 2.5;
        if (!this.clearOf(qx, qz, 1.3)) penalty += 1;
        px = qx;
        pz = qz;
        dx = ax;
        dz = az;
        pts.push(qx, qz);
        ok = true;
      }
      if (!ok) break;
    }
    return pts.length / 2 - penalty;
  }

  private nearOwn(x: number, z: number, pts: number[]): boolean {
    for (let i = 0; i < pts.length - 2; i += 2) if ((pts[i] - x) ** 2 + (pts[i + 1] - z) ** 2 < 0.45 * 0.45) return true;
    return false;
  }

  private ownX = 0;
  private ownZ = 0;
  private ownP: ServicePoint | null = null;

  /** No other building's counter / line / exit within r (this point's own head and spots excepted). */
  private clearOf(x: number, z: number, r: number): boolean {
    const t = this.taken;
    const own = this.ownP;
    for (let i = 0; i < t.length; i += 2) {
      if ((t[i] - x) ** 2 + (t[i + 1] - z) ** 2 >= r * r) continue;
      if (own) {
        if (t[i] === this.ownX && t[i + 1] === this.ownZ) continue;
        let mine = false;
        for (let k = 0; k < own.sx.length; k++) if (t[i] === own.sx[k] && t[i + 1] === own.sz[k]) mine = true;
        if (mine) continue;
      }
      return false;
    }
    return true;
  }

  private tileOf(x: number, z: number): number {
    return Math.floor(z / TILE) * MAP_W + Math.floor(x / TILE);
  }

  private walkable(tx: number, tz: number): boolean {
    const w = this.world;
    if (tx < 0 || tz < 0 || tx >= MAP_W || tz >= MAP_H) return false;
    const i = tz * MAP_W + tx;
    return w.path[i] !== 0 && !w.habitatOf[i] && !w.isTileSolid(tx, tz);
  }

  /** On a walkable path tile and not pressed against a non-path edge. */
  private standable(x: number, z: number): boolean {
    const tx = Math.floor(x / TILE),
      tz = Math.floor(z / TILE);
    if (!this.walkable(tx, tz)) return false;
    const w = this.world;
    const fx = x - tx * TILE,
      fz = z - tz * TILE;
    if (fx < EDGE && (!this.walkable(tx - 1, tz) || w.fenceBetween(tx, tz, tx - 1, tz))) return false;
    if (fx > TILE - EDGE && (!this.walkable(tx + 1, tz) || w.fenceBetween(tx, tz, tx + 1, tz))) return false;
    if (fz < EDGE && (!this.walkable(tx, tz - 1) || w.fenceBetween(tx, tz, tx, tz - 1))) return false;
    if (fz > TILE - EDGE && (!this.walkable(tx, tz + 1) || w.fenceBetween(tx, tz, tx, tz + 1))) return false;
    return true;
  }

  /** A path tile where three or more paths meet. */
  private junction(t: number): boolean {
    const x = t % MAP_W,
      z = (t / MAP_W) | 0;
    let n = 0;
    if (this.walkable(x + 1, z) && !this.world.fenceBetween(x, z, x + 1, z)) n++;
    if (this.walkable(x - 1, z) && !this.world.fenceBetween(x, z, x - 1, z)) n++;
    if (this.walkable(x, z + 1) && !this.world.fenceBetween(x, z, x, z + 1)) n++;
    if (this.walkable(x, z - 1) && !this.world.fenceBetween(x, z, x, z - 1)) n++;
    return n >= 3;
  }

  private stepOk(a: number, b: number): boolean {
    if (a === b) return true;
    const ax = a % MAP_W,
      az = (a / MAP_W) | 0,
      bx = b % MAP_W,
      bz = (b / MAP_W) | 0;
    if (Math.abs(ax - bx) + Math.abs(az - bz) !== 1) return false;
    return !this.world.fenceBetween(ax, az, bx, bz);
  }

  /** A fence between the building and the path tile at (x, z)? */
  private fenceToFootprint(o: PlacedObject, x: number, z: number): boolean {
    const w = this.world;
    const tx = Math.floor(x / TILE),
      tz = Math.floor(z / TILE);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = tx + dx,
        nz = tz + dz;
      if (w.inBounds(nx, nz) && w.objectGrid[nz * MAP_W + nx] === o.id) return w.fenceBetween(tx, tz, nx, nz) !== 0;
    }
    return true;
  }

  /** Path tile next to the footprint nearest to (px, pz): [x, z, normalX, normalZ]. */
  private bestSide(o: PlacedObject, px: number, pz: number): [number, number, number, number] | null {
    const w = this.world;
    let best: [number, number, number, number] | null = null;
    let bd = Infinity;
    for (const t of w.footprint(o)) {
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = t.x + dx,
          nz = t.z + dz;
        if (!w.inBounds(nx, nz) || w.objectGrid[nz * MAP_W + nx] === o.id) continue;
        if (!this.walkable(nx, nz) || w.fenceBetween(t.x, t.z, nx, nz)) continue;
        const d = ((nx + 0.5) * TILE - px) ** 2 + ((nz + 0.5) * TILE - pz) ** 2;
        if (d < bd) {
          bd = d;
          best = [nx, nz, dx, dz];
        }
      }
    }
    return best;
  }
}
