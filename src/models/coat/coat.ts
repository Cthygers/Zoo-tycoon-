// Helpers for coat functions (CoatSample → colours / pattern).

import * as THREE from 'three';
import { Noise } from '../../core/rng';
import { clamp01, lerp, smooth } from '../anim/util';

export { clamp01, lerp, smooth };

const noises = new Map<number, Noise>();
/** Shared seeded simplex noise instance. */
export function noiseOf(seed: number): Noise {
  let n = noises.get(seed);
  if (!n) {
    n = new Noise(seed);
    noises.set(seed, n);
  }
  return n;
}

/** 3D fBm in about [-1, 1]. */
export function fbm(x: number, y: number, z: number, octaves = 3, seed = 3): number {
  return noiseOf(seed).fbm3(x, y, z, octaves);
}

/** sRGB hex → linear colour (cached objects are NOT returned; writes into out). */
export function setHex(out: THREE.Color, hex: number): THREE.Color {
  return out.setHex(hex);
}

const _a = new THREE.Color();
const _b = new THREE.Color();

/** out = mix(hexA, hexB, t) in linear space. */
export function mixHex(out: THREE.Color, a: number, b: number, t: number): THREE.Color {
  _a.setHex(a);
  _b.setHex(b);
  return out.copy(_a).lerp(_b, clamp01(t));
}

/** out = mix(out, hex, t). */
export function blendHex(out: THREE.Color, hex: number, t: number): THREE.Color {
  if (t <= 0) return out;
  _a.setHex(hex);
  return out.lerp(_a, clamp01(t));
}

/** Multiply brightness. */
export function shade(out: THREE.Color, k: number): THREE.Color {
  return out.multiplyScalar(k);
}

export interface VoronoiResult {
  /** Distance to the nearest feature point. */
  d1: number;
  /** F2 − F1: ~0 on cell borders, larger inside cells. */
  edge: number;
  /** Stable random id of the nearest cell in [0,1). */
  id: number;
}

function h3(x: number, y: number, z: number, s: number): number {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f) ^ Math.imul(s | 0, 0x165667b1);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** 3D Voronoi / Worley with cell size `cell` (m) — for giraffe patches, spots, rosettes. */
export function voronoi(x: number, y: number, z: number, cell: number, seed = 1, jitter = 0.9, out?: VoronoiResult): VoronoiResult {
  const r = out ?? { d1: 0, edge: 0, id: 0 };
  const px = x / cell, py = y / cell, pz = z / cell;
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let d1 = 1e9, d2 = 1e9, id = 0;
  for (let k = -1; k <= 1; k++)
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const cx = ix + i, cy = iy + j, cz = iz + k;
        const fx = cx + 0.5 + (h3(cx, cy, cz, seed) - 0.5) * jitter;
        const fy = cy + 0.5 + (h3(cx, cy, cz, seed + 1) - 0.5) * jitter;
        const fz = cz + 0.5 + (h3(cx, cy, cz, seed + 2) - 0.5) * jitter;
        const dx = fx - px, dy = fy - py, dz = fz - pz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          id = h3(cx, cy, cz, seed + 3);
        } else if (d < d2) d2 = d;
      }
  r.d1 = d1 * cell;
  r.edge = (d2 - d1) * cell;
  r.id = id;
  return r;
}

/**
 * Countershading factor: 0 on the back / top, 1 on the belly / underside,
 * from the surface normal (ny) and height.
 */
export function belly(ny: number, y: number, bellyY: number, soft = 0.15): number {
  return clamp01(smooth(0.1, -0.75, ny) * 0.75 + smooth(bellyY + soft, bellyY - soft, y) * 0.35);
}
