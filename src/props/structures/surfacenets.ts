// Naive surface nets: meshes the zero level set of a signed distance field
// sampled on a regular grid (negative = inside). Produces a smooth, welded,
// indexed mesh with gradient normals — used for organic rockwork (den).

import * as THREE from 'three';

export interface SdfBounds {
  min: THREE.Vector3;
  max: THREE.Vector3;
  /** Cell size in metres. */
  cell: number;
}

/**
 * Build a mesh of sdf(x,y,z) = 0. Returns position + normal + index.
 * `normalSdf` (optional) is used for the shading normals only: a more
 * detailed field than the meshed one adds sub-cell relief to the lighting.
 */
export function surfaceNets(sdf: (x: number, y: number, z: number) => number, b: SdfBounds, normalSdf = sdf): THREE.BufferGeometry {
  const c = b.cell;
  const nx = Math.ceil((b.max.x - b.min.x) / c);
  const ny = Math.ceil((b.max.y - b.min.y) / c);
  const nz = Math.ceil((b.max.z - b.min.z) / c);
  const sx = nx + 1;
  const sy = ny + 1;
  const sz = nz + 1;
  const F = new Float32Array(sx * sy * sz);
  const id = (i: number, j: number, k: number) => (k * sy + j) * sx + i;
  for (let k = 0; k < sz; k++)
    for (let j = 0; j < sy; j++)
      for (let i = 0; i < sx; i++) F[id(i, j, k)] = sdf(b.min.x + i * c, b.min.y + j * c, b.min.z + k * c);

  // one vertex per sign-changing cell
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const cid = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const pos: number[] = [];
  const corner = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ];
  const edges = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const v = new Float32Array(8);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        for (let q = 0; q < 8; q++) {
          v[q] = F[id(i + corner[q][0], j + corner[q][1], k + corner[q][2])];
          if (v[q] < 0) mask |= 1 << q;
        }
        if (mask === 0 || mask === 255) continue;
        let ax = 0;
        let ay = 0;
        let az = 0;
        let n = 0;
        for (const [a, bq] of edges) {
          const va = v[a];
          const vb = v[bq];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          ax += corner[a][0] + (corner[bq][0] - corner[a][0]) * t;
          ay += corner[a][1] + (corner[bq][1] - corner[a][1]) * t;
          az += corner[a][2] + (corner[bq][2] - corner[a][2]) * t;
          n++;
        }
        cellVert[cid(i, j, k)] = pos.length / 3;
        pos.push(b.min.x + (i + ax / n) * c, b.min.y + (j + ay / n) * c, b.min.z + (k + az / n) * c);
      }

  // quads across sign-changing grid edges
  const idx: number[] = [];
  const quad = (a: number, b2: number, c2: number, d: number, flip: boolean) => {
    if (a < 0 || b2 < 0 || c2 < 0 || d < 0) return;
    if (flip) idx.push(a, d, c2, a, c2, b2);
    else idx.push(a, b2, c2, a, c2, d);
  };
  for (let k = 1; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        // x-edge from (i,j,k) to (i+1,j,k)
        const a = F[id(i, j, k)] < 0;
        const b2 = F[id(i + 1, j, k)] < 0;
        if (a === b2) continue;
        quad(cellVert[cid(i, j - 1, k - 1)], cellVert[cid(i, j, k - 1)], cellVert[cid(i, j, k)], cellVert[cid(i, j - 1, k)], b2);
      }
  for (let k = 1; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const a = F[id(i, j, k)] < 0;
        const b2 = F[id(i, j + 1, k)] < 0;
        if (a === b2) continue;
        quad(cellVert[cid(i - 1, j, k - 1)], cellVert[cid(i - 1, j, k)], cellVert[cid(i, j, k)], cellVert[cid(i, j, k - 1)], b2);
      }
  for (let k = 0; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const a = F[id(i, j, k)] < 0;
        const b2 = F[id(i, j, k + 1)] < 0;
        if (a === b2) continue;
        quad(cellVert[cid(i - 1, j - 1, k)], cellVert[cid(i, j - 1, k)], cellVert[cid(i, j, k)], cellVert[cid(i - 1, j, k)], b2);
      }

  // gradient normals
  const nor = new Float32Array(pos.length);
  const e = c * 0.2;
  const ns = normalSdf;
  for (let q = 0; q < pos.length; q += 3) {
    const x = pos[q];
    const y = pos[q + 1];
    const z = pos[q + 2];
    let gx = ns(x + e, y, z) - ns(x - e, y, z);
    let gy = ns(x, y + e, z) - ns(x, y - e, z);
    let gz = ns(x, y, z + e) - ns(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    gx /= l;
    gy /= l;
    gz /= l;
    nor[q] = gx;
    nor[q + 1] = gy;
    nor[q + 2] = gz;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}
