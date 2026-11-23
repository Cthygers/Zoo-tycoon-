// Cheap mesh decimation for creature LODs: normal-aware vertex clustering.
//
// Vertices are snapped into a grid of `cell` metres and additionally split by
// the dominant direction of their normal (6 buckets: the two faces of a thin
// ear, leg or tail never merge, so thin parts flatten instead of vanishing)
// and by a "class" (glossy eye vertices never merge with fur and use a finer
// grid). Every cluster keeps the ORIGINAL vertex closest to the cluster mean,
// with all of its attributes (skin weights, coat colours, clothing zones …),
// so the result is a skinnable mesh with exactly the attribute layout of the
// source. Triangles that collapse are dropped, duplicates removed.
//
// One clustering pass is O(n) with typed-array hash tables (≈ 0.3–1 ms for a
// 10k-triangle animal on desktop); the cell size for the requested triangle
// ratio is found by a short search. `SimplifyJob` runs the search one pass per
// step() so a LOD can be built over several frames without hitches.

import * as THREE from 'three';

export interface SimplifyStats {
  triangles: number;
  vertices: number;
  cell: number;
  ms: number;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function pow2(n: number): number {
  let p = 16;
  while (p < n) p *= 2;
  return p;
}

/** Per-vertex class: 1 for glossy (eye) vertices of animal coats, else 0. */
function vertexClasses(geo: THREE.BufferGeometry): Uint8Array {
  const n = geo.getAttribute('position').count;
  const cls = new Uint8Array(n);
  const pat = geo.getAttribute('pattern');
  if (pat && pat.itemSize >= 3) for (let i = 0; i < n; i++) cls[i] = pat.getZ(i) > 0.9 ? 1 : 0;
  return cls;
}

/** Incremental simplification of an indexed geometry to ≈ `ratio` of its triangles. */
export class SimplifyJob {
  result: THREE.BufferGeometry | null = null;
  readonly stats: SimplifyStats = { triangles: 0, vertices: 0, cell: 0, ms: 0 };
  private readonly geo: THREE.BufferGeometry;
  private readonly pos: ArrayLike<number>;
  private readonly nrm: ArrayLike<number>;
  private readonly idx: ArrayLike<number>;
  private readonly n: number;
  private readonly target: number;
  private readonly min: THREE.Vector3;
  private readonly cls: Uint8Array;
  // scratch
  private readonly cid: Int32Array;
  private readonly sum: Float64Array;
  private readonly cnt: Int32Array;
  private readonly rep: Int32Array;
  private readonly best: Float64Array;
  private readonly hKeys: Int32Array;
  private readonly hVal: Int32Array;
  private readonly tKeys: Int32Array;
  // search state
  private cell: number;
  private lo = 0;
  private hi = 0;
  private bestCell = 0;
  private bestErr = Infinity;
  private iter = 0;
  private searching = true;

  constructor(geo: THREE.BufferGeometry, ratio: number) {
    const posAttr = geo.getAttribute('position');
    const nrmAttr = geo.getAttribute('normal');
    const index = geo.getIndex();
    if (!index || !nrmAttr) throw new Error('simplify: indexed geometry with normals required');
    this.geo = geo;
    this.n = posAttr.count;
    this.pos = posAttr.array as ArrayLike<number>;
    this.nrm = nrmAttr.array as ArrayLike<number>;
    this.idx = index.array as ArrayLike<number>;
    const srcTris = this.idx.length / 3;
    this.target = Math.max(8, Math.round(srcTris * ratio));
    if (!geo.boundingBox) geo.computeBoundingBox();
    this.min = geo.boundingBox!.min.clone().subScalar(1e-4);
    this.cls = vertexClasses(geo);
    const n = this.n;
    this.cid = new Int32Array(n);
    this.sum = new Float64Array(n * 3);
    this.cnt = new Int32Array(n);
    this.rep = new Int32Array(n);
    this.best = new Float64Array(n);
    this.hKeys = new Int32Array(pow2(n * 2) * 4);
    this.hVal = new Int32Array(this.hKeys.length / 4);
    this.tKeys = new Int32Array(pow2(srcTris * 2) * 3);
    // initial guess from the mean edge length: triangle count scales with 1 / cell²
    const idx = this.idx, pos = this.pos;
    let edge = 0, samples = 0;
    const step = Math.max(1, Math.floor(srcTris / 400));
    for (let t = 0; t < srcTris; t += step) {
      const a = idx[t * 3], b = idx[t * 3 + 1];
      edge += Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
      samples++;
    }
    edge = samples ? edge / samples : 0.05;
    this.cell = Math.max(1e-4, edge / Math.sqrt(Math.max(ratio, 0.01)));
  }

  /** Cluster vertices with the current cell size; returns the cluster count. */
  private cluster(cell: number): number {
    const { pos, nrm, cls, n, min, cid, sum, cnt, rep, best, hKeys, hVal } = this;
    const mask = hVal.length - 1;
    hVal.fill(-1);
    let nc = 0;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      // glossy eye vertices use a finer grid so small eye spheres keep their shape
      const inv = cls[i] ? 2.5 / cell : 1 / cell;
      const ix = Math.floor((x - min.x) * inv), iy = Math.floor((y - min.y) * inv), iz = Math.floor((z - min.z) * inv);
      const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      const b = (ax >= ay && ax >= az ? (nx >= 0 ? 0 : 1) : ay >= az ? (ny >= 0 ? 2 : 3) : nz >= 0 ? 4 : 5) * 2 + cls[i];
      let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791) ^ Math.imul(b, 2654435761)) & mask;
      let c = -1;
      for (;;) {
        const v = hVal[h];
        if (v < 0) {
          c = nc++;
          hVal[h] = c;
          hKeys[h * 4] = ix;
          hKeys[h * 4 + 1] = iy;
          hKeys[h * 4 + 2] = iz;
          hKeys[h * 4 + 3] = b;
          sum[c * 3] = 0;
          sum[c * 3 + 1] = 0;
          sum[c * 3 + 2] = 0;
          cnt[c] = 0;
          best[c] = Infinity;
          rep[c] = i;
          break;
        }
        if (hKeys[h * 4] === ix && hKeys[h * 4 + 1] === iy && hKeys[h * 4 + 2] === iz && hKeys[h * 4 + 3] === b) {
          c = v;
          break;
        }
        h = (h + 1) & mask;
      }
      cid[i] = c;
      sum[c * 3] += x;
      sum[c * 3 + 1] += y;
      sum[c * 3 + 2] += z;
      cnt[c]++;
    }
    for (let i = 0; i < n; i++) {
      const c = cid[i];
      const k = 1 / cnt[c];
      const dx = pos[i * 3] - sum[c * 3] * k, dy = pos[i * 3 + 1] - sum[c * 3 + 1] * k, dz = pos[i * 3 + 2] - sum[c * 3 + 2] * k;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best[c]) {
        best[c] = d;
        rep[c] = i;
      }
    }
    return nc;
  }

  /** Surviving triangles (as cluster ids); writes them to `out` when given and returns the count. */
  private collapse(out: Int32Array | null): number {
    const { idx, cid, tKeys } = this;
    const slots = tKeys.length / 3;
    const mask = slots - 1;
    tKeys.fill(-1);
    let t = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const a = cid[idx[i]], b = cid[idx[i + 1]], c = cid[idx[i + 2]];
      if (a === b || b === c || a === c) continue;
      // order-independent key (sorted ids) to drop duplicates / back-to-back pairs of the same triangle
      const lo = a < b ? (a < c ? a : c) : b < c ? b : c;
      const hi = a > b ? (a > c ? a : c) : b > c ? b : c;
      const mid = a + b + c - lo - hi;
      let h = (Math.imul(lo, 73856093) ^ Math.imul(mid, 19349663) ^ Math.imul(hi, 83492791)) & mask;
      let dup = false;
      for (;;) {
        const k = tKeys[h * 3];
        if (k < 0) {
          tKeys[h * 3] = lo;
          tKeys[h * 3 + 1] = mid;
          tKeys[h * 3 + 2] = hi;
          break;
        }
        if (k === lo && tKeys[h * 3 + 1] === mid && tKeys[h * 3 + 2] === hi) {
          dup = true;
          break;
        }
        h = (h + 1) & mask;
      }
      if (dup) continue;
      if (out) {
        out[t * 3] = a;
        out[t * 3 + 1] = b;
        out[t * 3 + 2] = c;
      }
      t++;
    }
    return t;
  }

  /** One search pass (or the final build). Returns true when `result` is ready. */
  step(): boolean {
    if (this.result) return true;
    const t0 = now();
    if (this.searching) {
      const cell = this.cell;
      this.cluster(cell);
      const tris = this.collapse(null);
      const err = Math.abs(tris - this.target) / this.target;
      if (err < this.bestErr) {
        this.bestErr = err;
        this.bestCell = cell;
      }
      this.iter++;
      if (err < 0.06 || this.iter >= 10) this.searching = false;
      else {
        if (tris > this.target) this.lo = cell;
        else this.hi = cell;
        this.cell = this.lo && this.hi ? Math.sqrt(this.lo * this.hi) : this.lo ? this.lo * 1.6 : this.hi / 1.6;
      }
      this.stats.ms += now() - t0;
      return false;
    }
    this.result = this.finish(this.bestCell);
    this.stats.ms += now() - t0;
    return true;
  }

  /** Run to completion. */
  run(): THREE.BufferGeometry {
    while (!this.step());
    return this.result!;
  }

  private finish(cell: number): THREE.BufferGeometry {
    const geo = this.geo;
    const nc = this.cluster(cell);
    const triBuf = new Int32Array(this.idx.length);
    const tris = this.collapse(triBuf);
    // compact: cluster → new vertex index
    const remap = new Int32Array(nc).fill(-1);
    const order: number[] = [];
    for (let i = 0; i < tris * 3; i++) {
      const c = triBuf[i];
      if (remap[c] < 0) {
        remap[c] = order.length;
        order.push(this.rep[c]);
      }
    }
    const out = new THREE.BufferGeometry();
    for (const name of Object.keys(geo.attributes)) {
      const src = geo.getAttribute(name) as THREE.BufferAttribute;
      const size = src.itemSize;
      const Ctor = (src.array as unknown as { constructor: new (n: number) => THREE.TypedArray }).constructor;
      const arr = new Ctor(order.length * size);
      const sa = src.array;
      for (let v = 0; v < order.length; v++) {
        const o = order[v] * size;
        for (let k = 0; k < size; k++) arr[v * size + k] = sa[o + k];
      }
      out.setAttribute(name, new THREE.BufferAttribute(arr, size, src.normalized));
    }
    const nv = order.length;
    const ia = nv < 65535 ? new Uint16Array(tris * 3) : new Uint32Array(tris * 3);
    for (let i = 0; i < tris * 3; i++) ia[i] = remap[triBuf[i]];
    out.setIndex(new THREE.BufferAttribute(ia, 1));
    out.boundingBox = geo.boundingBox!.clone();
    if (geo.boundingSphere) out.boundingSphere = geo.boundingSphere.clone();
    else out.computeBoundingSphere();
    this.stats.triangles = tris;
    this.stats.vertices = nv;
    this.stats.cell = cell;
    return out;
  }
}

/** Simplify an indexed geometry to roughly `ratio` of its triangles (all at once). */
export function simplifyGeometry(geo: THREE.BufferGeometry, ratio: number, stats?: SimplifyStats): THREE.BufferGeometry {
  const job = new SimplifyJob(geo, ratio);
  const g = job.run();
  if (stats) Object.assign(stats, job.stats);
  return g;
}
