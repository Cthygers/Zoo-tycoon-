// Surface-nets mesher for SdfField over an axis-aligned region.
//
//  * The field is sampled on a (possibly anisotropic) grid; 8³-cell blocks
//    only evaluate primitives whose influence box overlaps the block, and
//    blocks with no primitive are skipped entirely.
//  * One vertex per sign-changing cell (average of edge crossings), then a
//    couple of Newton steps project it onto the true surface, so separately
//    meshed regions that overlap produce (nearly) coincident surfaces.
//  * Normals come from the SDF gradient (smooth shading).
//  * Cells whose centre lies inside an `exclude` box are skipped: a finer
//    detail region meshes that volume instead.

import type { Vec3 } from './prims';
import { FAR, type SdfField } from './field';

export interface Box3Like {
  min: Vec3;
  max: Vec3;
}

export interface MeshRegion extends Box3Like {
  /** Cell size per axis (metres). */
  cell: Vec3;
  exclude?: Box3Like[];
  /**
   * Optional ownership test for a sign-changing cell (centre x,y,z; `list` =
   * candidate primitive indices of its block). Return false to skip the cell.
   */
  keep?: (x: number, y: number, z: number, list: Int32Array) => boolean;
  /** Only sample blocks whose candidate list contains a primitive of this region index. */
  ownRegion?: number;
  /**
   * Primitives (by index, value 1) left out of this grid entirely, e.g. the
   * primitives of a `noBase` detail region on the coarse base grid.
   */
  skipPrims?: Uint8Array;
}

export interface RawMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Surface positions before any post-offset (used for baking attributes). */
  surface?: Float32Array;
}

const BLOCK = 8;

// Cube corner offsets: corner c = dx | dy<<1 | dz<<2
const EDGES: number[] = [];
for (let c = 0; c < 8; c++) {
  for (let b = 1; b < 8; b <<= 1) if ((c & b) === 0) EDGES.push(c, c | b);
}

class GrowF32 {
  a: Float32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Float32Array(cap);
  }
  push3(x: number, y: number, z: number): void {
    if (this.n + 3 > this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
    this.a[this.n++] = y;
    this.a[this.n++] = z;
  }
  view(): Float32Array {
    return this.a.slice(0, this.n);
  }
}

class GrowU32 {
  a: Uint32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Uint32Array(cap);
  }
  push3(x: number, y: number, z: number): void {
    if (this.n + 3 > this.a.length) {
      const b = new Uint32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
    this.a[this.n++] = y;
    this.a[this.n++] = z;
  }
  view(): Uint32Array {
    return this.a.slice(0, this.n);
  }
}

export function surfaceNets(field: SdfField, region: MeshRegion): RawMesh {
  const [hx, hy, hz] = region.cell;
  const ox = region.min[0], oy = region.min[1], oz = region.min[2];
  const nx = Math.max(2, Math.ceil((region.max[0] - ox) / hx) + 1);
  const ny = Math.max(2, Math.ceil((region.max[1] - oy) / hy) + 1);
  const nz = Math.max(2, Math.ceil((region.max[2] - oz) / hz) + 1);
  const sxy = nx * ny;
  const vals = new Float32Array(nx * ny * nz).fill(FAR);

  // ---- block culling + sampling
  const bnx = Math.ceil(nx / BLOCK), bny = Math.ceil(ny / BLOCK), bnz = Math.ceil(nz / BLOCK);
  const blockLists: Int32Array[] = new Array(bnx * bny * bnz);
  const pad = Math.max(hx, hy, hz) * 1.5;
  for (let bz = 0; bz < bnz; bz++) {
    for (let by = 0; by < bny; by++) {
      for (let bx = 0; bx < bnx; bx++) {
        const i0 = bx * BLOCK, j0 = by * BLOCK, k0 = bz * BLOCK;
        const i1 = Math.min(i0 + BLOCK, nx), j1 = Math.min(j0 + BLOCK, ny), k1 = Math.min(k0 + BLOCK, nz);
        let list = field.cull(
          ox + i0 * hx - pad, oy + j0 * hy - pad, oz + k0 * hz - pad,
          ox + (i1 - 1) * hx + pad, oy + (j1 - 1) * hy + pad, oz + (k1 - 1) * hz + pad,
        );
        if (region.skipPrims && list.length) list = filterList(field, list, region.skipPrims);
        blockLists[bx + bnx * (by + bny * bz)] = list;
        const n = list.length;
        if (n === 0) continue;
        if (region.ownRegion !== undefined) {
          let own = false;
          for (let q = 0; q < n && !own; q++) own = field.prims[list[q]].region === region.ownRegion;
          if (!own) continue;
        }
        for (let k = k0; k < k1; k++) {
          const z = oz + k * hz;
          for (let j = j0; j < j1; j++) {
            const y = oy + j * hy;
            let idx = i0 + nx * j + sxy * k;
            for (let i = i0; i < i1; i++, idx++) vals[idx] = field.evalList(ox + i * hx, y, z, list, n);
          }
        }
      }
    }
  }

  const excl = region.exclude ?? [];
  const cnx = nx - 1, cny = ny - 1, cnz = nz - 1;
  const cellVert = new Int32Array(cnx * cny * cnz).fill(-1);
  const pos = new GrowF32(4096 * 3);
  const nrm = new GrowF32(4096 * 3);
  const corner = new Float32Array(8);
  const gradOut = new Float32Array(4);

  const evalAt = (x: number, y: number, z: number, list: Int32Array): number => field.evalList(x, y, z, list, list.length);
  const gradAt = (x: number, y: number, z: number, list: Int32Array, e: number): void => {
    const n = list.length;
    const gx = field.evalList(x + e, y, z, list, n) - field.evalList(x - e, y, z, list, n);
    const gy = field.evalList(x, y + e, z, list, n) - field.evalList(x, y - e, z, list, n);
    const gz = field.evalList(x, y, z + e, list, n) - field.evalList(x, y, z - e, list, n);
    const len = Math.sqrt(gx * gx + gy * gy + gz * gz);
    gradOut[0] = gx / (len || 1);
    gradOut[1] = gy / (len || 1);
    gradOut[2] = gz / (len || 1);
    gradOut[3] = len / (2 * e);
  };
  const hmin = Math.min(hx, hy, hz);
  const ge = hmin * 0.2;

  for (let k = 0; k < cnz; k++) {
    for (let j = 0; j < cny; j++) {
      for (let i = 0; i < cnx; i++) {
        const base = i + nx * j + sxy * k;
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = vals[base + (c & 1) + ((c >> 1) & 1) * nx + ((c >> 2) & 1) * sxy];
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        const ccx = ox + (i + 0.5) * hx, ccy = oy + (j + 0.5) * hy, ccz = oz + (k + 0.5) * hz;
        let skip = false;
        for (let e = 0; e < excl.length; e++) {
          const b = excl[e];
          if (ccx > b.min[0] && ccx < b.max[0] && ccy > b.min[1] && ccy < b.max[1] && ccz > b.min[2] && ccz < b.max[2]) {
            skip = true;
            break;
          }
        }
        if (skip) continue;
        const list = blockLists[((i / BLOCK) | 0) + bnx * (((j / BLOCK) | 0) + bny * ((k / BLOCK) | 0))];
        if (region.keep && !region.keep(ccx, ccy, ccz, list)) continue;
        // average of edge crossings
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (let e = 0; e < 24; e += 2) {
          const c0 = EDGES[e], c1 = EDGES[e + 1];
          const v0 = corner[c0], v1 = corner[c1];
          if (v0 < 0 === v1 < 0) continue;
          const t = v0 / (v0 - v1);
          const x0 = c0 & 1, y0 = (c0 >> 1) & 1, z0 = (c0 >> 2) & 1;
          const x1 = c1 & 1, y1 = (c1 >> 1) & 1, z1 = (c1 >> 2) & 1;
          sx += x0 + (x1 - x0) * t;
          sy += y0 + (y1 - y0) * t;
          sz += z0 + (z1 - z0) * t;
          cnt++;
        }
        let px = ox + (i + sx / cnt) * hx;
        let py = oy + (j + sy / cnt) * hy;
        let pz = oz + (k + sz / cnt) * hz;
        // Newton projection onto the surface (forward-difference gradient)
        const qx = px, qy = py, qz = pz;
        const nl = list.length;
        for (let it = 0; it < 2; it++) {
          const f = field.evalList(px, py, pz, list, nl);
          if (Math.abs(f) < hmin * 0.004) break;
          const gx = field.evalList(px + ge, py, pz, list, nl) - f;
          const gy = field.evalList(px, py + ge, pz, list, nl) - f;
          const gz = field.evalList(px, py, pz + ge, list, nl) - f;
          const g2 = (gx * gx + gy * gy + gz * gz) / (ge * ge);
          if (g2 < 0.04) break;
          const step = f / g2 / ge;
          px -= gx * step;
          py -= gy * step;
          pz -= gz * step;
        }
        // keep within ~1 cell of the surface-nets estimate (avoid jumping across thin gaps)
        const dx = px - qx, dy = py - qy, dz = pz - qz;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dl > hmin) {
          const s = hmin / dl;
          px = qx + dx * s;
          py = qy + dy * s;
          pz = qz + dz * s;
        }
        gradAt(px, py, pz, list, ge);
        cellVert[i + cnx * (j + cny * k)] = pos.n / 3;
        pos.push3(px, py, pz);
        nrm.push3(gradOut[0], gradOut[1], gradOut[2]);
      }
    }
  }

  // ---- faces: one quad per sign-changing grid edge whose 4 surrounding cells have vertices
  const idx = new GrowU32(8192 * 3);
  const P = pos.a;
  const cellAt = (ci: number, cj: number, ck: number): number => {
    if (ci < 0 || cj < 0 || ck < 0 || ci >= cnx || cj >= cny || ck >= cnz) return -1;
    return cellVert[ci + cnx * (cj + cny * ck)];
  };
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) {
      const t = b;
      b = d;
      d = t;
    }
    // split along the shorter diagonal
    const d1 = dist2(P, a, c), d2 = dist2(P, b, d);
    if (d1 <= d2) {
      idx.push3(a, b, c);
      idx.push3(a, c, d);
    } else {
      idx.push3(a, b, d);
      idx.push3(b, c, d);
    }
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const p0 = i + nx * j + sxy * k;
        const v0 = vals[p0];
        const in0 = v0 < 0;
        // x edge
        if (i < cnx && j > 0 && k > 0) {
          const in1 = vals[p0 + 1] < 0;
          if (in0 !== in1) {
            // cells (i, j-1..j, k-1..k) in (y,z) plane
            quad(cellAt(i, j - 1, k - 1), cellAt(i, j, k - 1), cellAt(i, j, k), cellAt(i, j - 1, k), !in0);
          }
        }
        // y edge
        if (j < cny && i > 0 && k > 0) {
          const in1 = vals[p0 + nx] < 0;
          if (in0 !== in1) {
            // (z, x) plane
            quad(cellAt(i - 1, j, k - 1), cellAt(i - 1, j, k), cellAt(i, j, k), cellAt(i, j, k - 1), !in0);
          }
        }
        // z edge
        if (k < cnz && i > 0 && j > 0) {
          const in1 = vals[p0 + sxy] < 0;
          if (in0 !== in1) {
            // (x, y) plane
            quad(cellAt(i - 1, j - 1, k), cellAt(i, j - 1, k), cellAt(i, j, k), cellAt(i - 1, j, k), !in0);
          }
        }
      }
    }
  }

  return { positions: pos.view(), normals: nrm.view(), indices: idx.view() };
}

/** Drop skipped primitives from a block list (empty when only carving primitives remain). */
function filterList(field: SdfField, list: Int32Array, skip: Uint8Array): Int32Array {
  let n = 0, add = false;
  for (let q = 0; q < list.length; q++) if (!skip[list[q]]) n++;
  if (n === list.length) return list;
  const out = new Int32Array(n);
  n = 0;
  for (let q = 0; q < list.length; q++) {
    const i = list[q];
    if (skip[i]) continue;
    out[n++] = i;
    if (!field.prims[i].sub) add = true;
  }
  return add ? out : new Int32Array(0);
}

function dist2(P: Float32Array, a: number, b: number): number {
  const dx = P[a * 3] - P[b * 3], dy = P[a * 3 + 1] - P[b * 3 + 1], dz = P[a * 3 + 2] - P[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

/** Concatenate meshes into one. */
export function mergeRaw(meshes: RawMesh[]): RawMesh {
  let nv = 0, ni = 0;
  for (const m of meshes) {
    nv += m.positions.length;
    ni += m.indices.length;
  }
  const positions = new Float32Array(nv);
  const normals = new Float32Array(nv);
  const surface = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const m of meshes) {
    positions.set(m.positions, ov);
    normals.set(m.normals, ov);
    surface.set(m.surface ?? m.positions, ov);
    const base = ov / 3;
    for (let i = 0; i < m.indices.length; i++) indices[oi + i] = m.indices[i] + base;
    ov += m.positions.length;
    oi += m.indices.length;
  }
  return { positions, normals, indices, surface };
}
