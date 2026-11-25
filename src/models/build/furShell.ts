// Fur shell: long hair (manes, shaggy bears, wool) gets a second, raised copy
// of its triangles on the full mesh (LOD 0) so it ends in locks that stand out
// past the silhouette instead of a smooth helmet edge. The animal material
// pushes shell vertices out along the normal (FUR_SHELL_LEN per unit of fur
// length past 2.5) and keeps only the lock tips of the shell, thinning them
// out with the pixel footprint until the shell is gone at mid range.
//
// Shell vertices are copies of the base vertices (same skinning and coat) with
// the gloss channel (pattern.z) set to SHELL_FLAG. They are appended after the
// base vertices and their triangles after the base triangles, so the base mesh
// is a prefix of the arrays: `withoutFurShell` views it without copying (the
// LOD simplifier must never see shell vertices).

import * as THREE from 'three';

/** pattern.z of shell vertices (gloss is 0 … 1 elsewhere). */
export const SHELL_FLAG = -1;
/**
 * Shell height per unit of fur length past fur 2.5 (m): it rises from ~0 at the
 * border of the long hair, so the shell has no step there (a lion mane at fur
 * 3.6 stands ≈ 2 cm out).
 */
export const FUR_SHELL_LEN = 0.02;
/** pattern.w (fur − 1) at which the shell's lift starts. */
export const FUR_SHELL_FROM = 1.5;
/** pattern.w from which hair gets a shell (just past FUR_SHELL_FROM: no zero-height sliver). */
const MIN_LONG_HAIR = 1.6;

interface ShellRange {
  vertices: number;
  indices: number;
}

/**
 * Append a shell over the triangles whose three vertices carry long hair.
 * Returns `geo` itself when it has none.
 */
export function addFurShell(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pat = geo.getAttribute('pattern');
  const index = geo.getIndex();
  if (!pat || !index) return geo;
  const n = pat.count;
  const long = (v: number) => pat.getW(v) >= MIN_LONG_HAIR && pat.getZ(v) < 0.5;
  const idx = index.array;
  const remap = new Int32Array(n).fill(-1);
  const shellTris: number[] = [];
  let ns = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (!long(a) || !long(b) || !long(c)) continue;
    for (const v of [a, b, c]) if (remap[v] < 0) remap[v] = n + ns++;
    shellTris.push(remap[a], remap[b], remap[c]);
  }
  if (!ns) return geo;
  const src = new Int32Array(ns);
  for (let v = 0; v < n; v++) if (remap[v] >= 0) src[remap[v] - n] = v;

  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes) as [string, THREE.BufferAttribute][]) {
    const k = attr.itemSize;
    const from = attr.array;
    const to = new (from.constructor as new (len: number) => typeof from)((n + ns) * k);
    to.set(from.subarray(0, n * k));
    for (let i = 0; i < ns; i++) for (let j = 0; j < k; j++) to[(n + i) * k + j] = from[src[i] * k + j];
    out.setAttribute(name, new THREE.BufferAttribute(to, k, attr.normalized));
  }
  const shellPat = out.getAttribute('pattern') as THREE.BufferAttribute;
  for (let i = n; i < n + ns; i++) shellPat.setZ(i, SHELL_FLAG);
  const total = idx.length + shellTris.length;
  const newIdx = n + ns < 65535 ? new Uint16Array(total) : new Uint32Array(total);
  newIdx.set(idx);
  newIdx.set(shellTris, idx.length);
  out.setIndex(new THREE.BufferAttribute(newIdx, 1));
  out.boundingBox = geo.boundingBox?.clone() ?? null;
  out.boundingSphere = geo.boundingSphere?.clone() ?? null;
  out.userData.furShell = { vertices: n, indices: idx.length } satisfies ShellRange;
  return out;
}

/** The base mesh of a geometry with a fur shell (views of its arrays, no copy), or the geometry itself. */
export function withoutFurShell(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const range = geo.userData.furShell as ShellRange | undefined;
  if (!range) return geo;
  const base = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes) as [string, THREE.BufferAttribute][]) {
    base.setAttribute(name, new THREE.BufferAttribute(attr.array.subarray(0, range.vertices * attr.itemSize), attr.itemSize, attr.normalized));
  }
  base.setIndex(new THREE.BufferAttribute(geo.getIndex()!.array.subarray(0, range.indices), 1));
  return base;
}
