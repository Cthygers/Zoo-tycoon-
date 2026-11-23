// Automatic distant version for vegetation templates whose PropSpec has no
// buildLod. Works on the built meshes, so it suits any builder:
//  - alpha-tested leaf cards / fronds (connected components of the leaf
//    mesh): keep a deterministic ~45 % and grow each kept card about its
//    centre so the crown keeps its coverage and silhouette;
//  - bark / stems: keep the biggest connected pieces (trunk, main limbs) and
//    drop twigs.
// Only kicks in for meshes heavy enough to be worth it.

import * as THREE from 'three';

export interface AutoLodOptions {
  /** Fraction of leaf cards kept. */
  cards: number;
  /** Fraction of bark vertices kept (biggest pieces first). */
  bark: number;
  /** Templates below this many triangles are left alone. */
  minTris: number;
}

const DEFAULTS: AutoLodOptions = { cards: 0.45, bark: 0.5, minTris: 700 };

function hash(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function triCount(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    n += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  return n;
}

/** Connected components of an indexed triangle mesh (union-find over vertices). */
function components(g: THREE.BufferGeometry): { comp: Int32Array; n: number } | null {
  const index = g.index;
  if (!index) return null;
  const vc = g.getAttribute('position').count;
  const parent = new Int32Array(vc);
  for (let i = 0; i < vc; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const idx = index.array;
  for (let i = 0; i < index.count; i += 3) {
    const a = find(idx[i]);
    const b = find(idx[i + 1]);
    const c = find(idx[i + 2]);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    if (a2 !== c) parent[c] = a2;
  }
  const comp = new Int32Array(vc).fill(-1);
  const remap = new Map<number, number>();
  for (let i = 0; i < vc; i++) {
    const r = find(i);
    let k = remap.get(r);
    if (k === undefined) {
      k = remap.size;
      remap.set(r, k);
    }
    comp[i] = k;
  }
  return { comp, n: remap.size };
}

/**
 * Copy the kept components into a new geometry. `scaleOf(c)` scales a kept
 * component about its centroid (1 = unchanged).
 */
function subset(g: THREE.BufferGeometry, comp: Int32Array, nComp: number, keep: Uint8Array, scaleOf: (c: number) => number): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const vc = pos.count;
  // centroids
  const cen = new Float64Array(nComp * 3);
  const cnt = new Int32Array(nComp);
  for (let i = 0; i < vc; i++) {
    const c = comp[i];
    cen[c * 3] += pos.getX(i);
    cen[c * 3 + 1] += pos.getY(i);
    cen[c * 3 + 2] += pos.getZ(i);
    cnt[c]++;
  }
  for (let c = 0; c < nComp; c++) {
    const k = cnt[c] || 1;
    cen[c * 3] /= k;
    cen[c * 3 + 1] /= k;
    cen[c * 3 + 2] /= k;
  }
  const map = new Int32Array(vc).fill(-1);
  let nv = 0;
  for (let i = 0; i < vc; i++) if (keep[comp[i]]) map[i] = nv++;
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(g.attributes)) {
    const a = g.getAttribute(name) as THREE.BufferAttribute;
    const Arr = a.array.constructor as new (n: number) => THREE.TypedArray;
    const arr = new Arr(nv * a.itemSize);
    for (let i = 0; i < vc; i++) {
      const j = map[i];
      if (j < 0) continue;
      for (let k = 0; k < a.itemSize; k++) arr[j * a.itemSize + k] = a.array[i * a.itemSize + k];
    }
    if (name === 'position') {
      for (let i = 0; i < vc; i++) {
        const j = map[i];
        if (j < 0) continue;
        const c = comp[i];
        const s = scaleOf(c);
        if (s === 1) continue;
        for (let k = 0; k < 3; k++) arr[j * 3 + k] = cen[c * 3 + k] + (arr[j * 3 + k] - cen[c * 3 + k]) * s;
      }
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
  }
  const src = g.index!.array;
  const idx: number[] = [];
  for (let i = 0; i < src.length; i += 3) {
    const a = map[src[i]];
    if (a < 0) continue;
    idx.push(a, map[src[i + 1]], map[src[i + 2]]);
  }
  out.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

function lodGeometry(g: THREE.BufferGeometry, material: THREE.Material, o: AutoLodOptions): THREE.BufferGeometry | null {
  const cc = components(g);
  if (!cc || cc.n < 4) return null;
  const { comp, n } = cc;
  const keep = new Uint8Array(n);
  const cards = material.alphaTest > 0 || (material.transparent && !!(material as THREE.MeshStandardMaterial).map);
  if (cards) {
    for (let c = 0; c < n; c++) keep[c] = hash(c * 7 + 3) < o.cards ? 1 : 0;
    const grow = Math.min(1.6, 0.92 / Math.sqrt(o.cards));
    return subset(g, comp, n, keep, (c) => (keep[c] ? grow : 1));
  }
  // bark: biggest pieces first until the vertex budget is used
  const size = new Int32Array(n);
  for (let i = 0; i < comp.length; i++) size[comp[i]]++;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => size[b] - size[a]);
  const budget = comp.length * o.bark;
  let used = 0;
  for (const c of order) {
    if (used > budget && used > 0) break;
    keep[c] = 1;
    used += size[c];
  }
  return subset(g, comp, n, keep, () => 1);
}

/**
 * Build a cheaper version of a built vegetation template, or null when it is
 * already light. The result shares materials with `root`; its geometries are
 * new (the caller owns them). Mesh transforms are baked from `root`'s world
 * matrices, so call `root.updateMatrixWorld(true)` first.
 */
export function autoLod(root: THREE.Object3D, opts: Partial<AutoLodOptions> = {}): THREE.Object3D | null {
  const o = { ...DEFAULTS, ...opts };
  if (triCount(root) < o.minTris) return null;
  const out = new THREE.Group();
  out.name = `${root.name || 'prop'}-autolod`;
  let saved = 0;
  let total = 0;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || Array.isArray(mesh.material)) return;
    const g = mesh.geometry;
    const tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    total += tris;
    let lg: THREE.BufferGeometry | null = null;
    if (tris >= 120) lg = lodGeometry(g, mesh.material, o);
    const m = new THREE.Mesh(lg ?? g, mesh.material);
    if (lg) {
      saved += tris - lg.index!.count / 3;
      m.userData.autoLodOwned = true;
    }
    m.userData.noShadow = mesh.userData.noShadow;
    m.matrixAutoUpdate = false;
    m.matrix.copy(mesh.matrixWorld);
    out.add(m);
  });
  if (saved < total * 0.25) {
    for (const c of out.children) if (c.userData.autoLodOwned) (c as THREE.Mesh).geometry.dispose();
    return null;
  }
  return out;
}
