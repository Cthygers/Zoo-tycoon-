// Procedural texture toolkit for nature props: tileable noise, float image
// buffers, a small anti-aliased vector painter (leaves, stems, discs) and
// packing into three.js DataTextures (sRGB albedo with coverage-preserving
// alpha mip chains for alpha-tested foliage, tangent-space normal maps).
//
// Everything runs once on the CPU when a prop species is first built.

import * as THREE from 'three';
import { hash3 } from '../../core/rng';

// ---------------------------------------------------------------------------
// Tileable noise

const hashF = (x: number, y: number, s: number): number => hash3(x, y, s) / 4294967296;

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

// Lattice tables (per period / seed) replace per-sample hashing: texture
// generation evaluates millions of samples, so this is the hot path. A small
// direct-mapped slot cache in front of the maps avoids per-sample key
// building.
const lattices = new Map<number, Float32Array>();
const worleyCells = new Map<number, Float32Array>();
const SLOTS = 256;
const latKey = new Float64Array(SLOTS).fill(-1);
const latTab: Float32Array[] = new Array<Float32Array>(SLOTS);
const worKey = new Float64Array(SLOTS).fill(-1);
const worTab: Float32Array[] = new Array<Float32Array>(SLOTS);

const tableKey = (px: number, py: number, seed: number): number => (px * 2053 + py) * 1048583 + seed;
const slotOf = (px: number, py: number, seed: number): number => (Math.imul(px, 73856093) ^ Math.imul(py, 19349663) ^ Math.imul(seed, 83492791)) & (SLOTS - 1);

function lattice(px: number, py: number, seed: number): Float32Array {
  const key = tableKey(px, py, seed);
  const slot = slotOf(px, py, seed);
  if (latKey[slot] === key) return latTab[slot];
  let t = lattices.get(key);
  if (!t) {
    t = new Float32Array(px * py);
    for (let y = 0; y < py; y++) for (let x = 0; x < px; x++) t[y * px + x] = hashF(x, y, seed);
    lattices.set(key, t);
  }
  latKey[slot] = key;
  latTab[slot] = t;
  return t;
}

function worleyTable(nx: number, ny: number, seed: number): Float32Array {
  const key = tableKey(nx, ny, seed);
  const slot = slotOf(nx, ny, seed);
  if (worKey[slot] === key) return worTab[slot];
  let cells = worleyCells.get(key);
  if (!cells) {
    cells = new Float32Array(nx * ny * 3);
    for (let cy = 0; cy < ny; cy++)
      for (let cx = 0; cx < nx; cx++) {
        const h = hash3(cx, cy, seed);
        const o = (cy * nx + cx) * 3;
        cells[o] = (h & 0xffff) / 65536 - 0.5;
        cells[o + 1] = (h >>> 16) / 65536 - 0.5;
        cells[o + 2] = hashF(cx, cy, seed + 9);
      }
    worleyCells.set(key, cells);
  }
  worKey[slot] = key;
  worTab[slot] = cells;
  return cells;
}

/** Drop the noise lattice caches (called after each texture is generated). */
export function clearNoiseCache(): void {
  lattices.clear();
  worleyCells.clear();
  latKey.fill(-1);
  worKey.fill(-1);
}

/** Periodic value noise in [-1, 1] with period px × py lattice cells. */
export function pnoise(x: number, y: number, px: number, py: number, seed: number): number {
  px = px | 0;
  py = py | 0;
  const L = lattice(px, py, seed);
  const xf = Math.floor(x);
  const yf = Math.floor(y);
  const fx = fade(x - xf);
  const fy = fade(y - yf);
  const x0 = ((xf % px) + px) % px;
  const y0 = ((yf % py) + py) % py;
  const x1 = x0 + 1 === px ? 0 : x0 + 1;
  const y1 = y0 + 1 === py ? 0 : y0 + 1;
  const a = L[y0 * px + x0];
  const b = L[y0 * px + x1];
  const c = L[y1 * px + x0];
  const d = L[y1 * px + x1];
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return (ab + (cd - ab) * fy) * 2 - 1;
}

/** Periodic fBm over the unit square: (u,v) in [0,1), fu × fv base cells (integers). ≈ [-1,1]. */
export function pfbm(u: number, v: number, fu: number, fv: number, octaves: number, seed: number, gain = 0.5): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let a = fu;
  let b = fv;
  for (let o = 0; o < octaves; o++) {
    sum += amp * pnoise(u * a, v * b, a, b, seed + o * 131);
    norm += amp;
    amp *= gain;
    a *= 2;
    b *= 2;
  }
  return sum / norm;
}

/** Ridged periodic fBm in [0,1] (1 on ridges). */
export function pridge(u: number, v: number, fu: number, fv: number, octaves: number, seed: number): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let a = fu;
  let b = fv;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(pnoise(u * a, v * b, a, b, seed + o * 71));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    a *= 2;
    b *= 2;
  }
  return sum / norm;
}

/**
 * Periodic Worley noise over the unit square with nx × ny cells.
 * Writes [F1, F2, cellId(0..1), dx, dy] (cell units) into `out`.
 */
export function pworley(u: number, v: number, nx: number, ny: number, seed: number, out: Float32Array, jitter = 1): void {
  nx = nx | 0;
  ny = ny | 0;
  const cells = worleyTable(nx, ny, seed);
  const x = u * nx;
  const y = v * ny;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 1e9;
  let f2 = 1e9;
  let id = 0;
  let bdx = 0;
  let bdy = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const wx = ((cx % nx) + nx) % nx;
      const wy = ((cy % ny) + ny) % ny;
      const o = (wy * nx + wx) * 3;
      const px = cx + 0.5 + cells[o] * jitter;
      const py = cy + 0.5 + cells[o + 1] * jitter;
      const ddx = px - x;
      const ddy = py - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = cells[o + 2];
        bdx = ddx;
        bdy = ddy;
      } else if (d < f2) f2 = d;
    }
  out[0] = f1;
  out[1] = f2;
  out[2] = id;
  out[3] = bdx;
  out[4] = bdy;
}

export const sat = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const sstep = (a: number, b: number, v: number): number => {
  const t = sat((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Float RGBA image (linear colour, straight alpha)

export class Img {
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly a: Float32Array;
  /** Optional height channel (0..1) for normal-map derivation. */
  readonly h: Float32Array;
  constructor(
    readonly w: number,
    readonly ht: number,
    alpha = 0,
  ) {
    const n = w * ht;
    this.r = new Float32Array(n);
    this.g = new Float32Array(n);
    this.b = new Float32Array(n);
    this.a = new Float32Array(n).fill(alpha);
    this.h = new Float32Array(n);
  }
  set(i: number, r: number, g: number, b: number, a = 1): void {
    this.r[i] = r;
    this.g[i] = g;
    this.b[i] = b;
    this.a[i] = a;
  }
}

export type RGB = readonly [number, number, number];

/** sRGB hex → linear RGB triple. */
export function lin(hex: number): [number, number, number] {
  const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
}

// ---------------------------------------------------------------------------
// Vector painter (premultiplied "over" with analytic coverage)

/** Composite one coverage sample (straight colour) over the image at index i. */
function over(img: Img, i: number, cov: number, r: number, g: number, b: number, hgt: number): void {
  if (cov <= 0) return;
  const k = 1 - cov;
  const a0 = img.a[i];
  const a1 = cov + a0 * k;
  // premultiplied blend then un-premultiply
  const inv = a1 > 0 ? 1 / a1 : 0;
  img.r[i] = (r * cov + img.r[i] * a0 * k) * inv;
  img.g[i] = (g * cov + img.g[i] * a0 * k) * inv;
  img.b[i] = (b * cov + img.b[i] * a0 * k) * inv;
  img.a[i] = a1;
  img.h[i] = hgt * cov + img.h[i] * k;
}

export interface LeafStroke {
  /** Base of the leaf blade (px). */
  x: number;
  y: number;
  /** Direction of the midrib (radians; 0 = +x, π/2 = +y). */
  angle: number;
  /** Blade length / max half-width (px). */
  len: number;
  halfW: number;
  /** Half-width profile f(t) in [0,1], t = 0 base … 1 tip. */
  shape: (t: number, side: number) => number;
  color: RGB;
  /** Brightness multiplier (depth shading). */
  shade?: number;
  /** Midrib lightening (0..0.5). */
  midrib?: number;
  /** Side-vein strength (0..0.3) and count. */
  veins?: number;
  veinCount?: number;
  /** Bend: lateral curvature of the midrib (px offset at tip as fraction of len). */
  bend?: number;
  /** Height value written into the height channel. */
  height?: number;
  /** Wrap painting around image edges (tileable textures). */
  wrap?: boolean;
}

/** Paint a leaf blade with anti-aliased edges, midrib, veins and cross shading. */
export function paintLeaf(img: Img, L: LeafStroke): void {
  const offs = L.wrap ? wrapOffsets(img, L.x, L.y, L.len + L.halfW) : ZERO_OFF;
  for (const [ox, oy] of offs) paintLeafAt(img, L, L.x + ox, L.y + oy);
}

const ZERO_OFF: [number, number][] = [[0, 0]];

function wrapOffsets(img: Img, x: number, y: number, rad: number): [number, number][] {
  const out: [number, number][] = [];
  const xs = [0];
  const ys = [0];
  if (x - rad < 0) xs.push(img.w);
  if (x + rad > img.w) xs.push(-img.w);
  if (y - rad < 0) ys.push(img.ht);
  if (y + rad > img.ht) ys.push(-img.ht);
  for (const a of xs) for (const b of ys) out.push([a, b]);
  return out;
}

function paintLeafAt(img: Img, L: LeafStroke, bx: number, by: number): void {
  const ca = Math.cos(L.angle);
  const sa = Math.sin(L.angle);
  const bend = (L.bend ?? 0) * L.len;
  const rad = L.len + L.halfW + Math.abs(bend) + 2;
  const x0 = Math.max(0, Math.floor(bx - rad));
  const x1 = Math.min(img.w - 1, Math.ceil(bx + rad));
  const y0 = Math.max(0, Math.floor(by - rad));
  const y1 = Math.min(img.ht - 1, Math.ceil(by + rad));
  const shade = L.shade ?? 1;
  const mid = L.midrib ?? 0.15;
  const veins = L.veins ?? 0;
  const vc = L.veinCount ?? 6;
  const hgt = L.height ?? 1;
  const [cr, cg, cb] = L.color;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - bx;
      const dy = y + 0.5 - by;
      // leaf-local: along (t·len), across (s)
      const al = dx * ca + dy * sa;
      const t = al / L.len;
      if (t < -0.02 || t > 1.02) continue;
      const tc = t < 0 ? 0 : t > 1 ? 1 : t;
      let ac = -dx * sa + dy * ca;
      ac -= bend * tc * tc; // curved midrib
      if (ac > L.halfW + 1 || ac < -L.halfW - 1) continue;
      const side = ac >= 0 ? 1 : -1;
      const hw = L.shape(tc, side) * L.halfW;
      const d = hw - Math.abs(ac);
      let cov = d + 0.5;
      // round the base / tip ends
      const endCov = Math.min((t + 0.02) * L.len + 0.5, (1.02 - t) * L.len + 0.5);
      if (endCov < cov) cov = endCov;
      if (cov <= 0) continue;
      if (cov > 1) cov = 1;
      const sn = hw > 0.01 ? Math.abs(ac) / hw : 1; // 0 at midrib → 1 at edge
      // curvature shading: edges slightly darker, one half lighter
      let lum = shade * (1.04 - 0.22 * sn * sn) * (side > 0 ? 1.06 : 0.92);
      lum *= 0.88 + 0.2 * tc; // tips catch more light
      // midrib
      const mr = Math.max(0, 1 - Math.abs(ac) / 1.1);
      // side veins
      let vn = 0;
      if (veins > 0 && hw > 2.5) {
        const ph = (tc - sn * 0.35) * vc;
        const f = ph - Math.floor(ph);
        vn = Math.max(0, 1 - Math.abs(f - 0.5) * 9) * veins * (1 - sn);
      }
      const light = 1 + mr * mid + vn;
      const i = y * img.w + x;
      over(img, i, cov, cr * lum * light, cg * lum * light, cb * lum * light * (1 + mr * mid * 0.4), hgt * (1 - sn * 0.5));
    }
}

/** Tapered stem / twig: capsule from (x0,y0) radius r0 to (x1,y1) radius r1. */
export function paintStem(img: Img, x0: number, y0: number, x1: number, y1: number, r0: number, r1: number, color: RGB, shade = 1, hgt = 0.8): void {
  const minX = Math.max(0, Math.floor(Math.min(x0 - r0, x1 - r1) - 1));
  const maxX = Math.min(img.w - 1, Math.ceil(Math.max(x0 + r0, x1 + r1) + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0 - r0, y1 - r1) - 1));
  const maxY = Math.min(img.ht - 1, Math.ceil(Math.max(y0 + r0, y1 + r1) + 1));
  const ex = x1 - x0;
  const ey = y1 - y0;
  const l2 = ex * ex + ey * ey || 1;
  const [cr, cg, cb] = color;
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5 - x0;
      const py = y + 0.5 - y0;
      const t = Math.max(0, Math.min(1, (px * ex + py * ey) / l2));
      const qx = px - ex * t;
      const qy = py - ey * t;
      const d = Math.sqrt(qx * qx + qy * qy);
      const r = r0 + (r1 - r0) * t;
      // thin lines keep a minimum footprint but fade in opacity
      const rr = Math.max(r, 0.6);
      const cov = Math.min(1, rr - d + 0.5) * Math.min(1, r / 0.6);
      if (cov <= 0) continue;
      const sn = Math.min(1, d / rr);
      const lum = shade * (1.1 - 0.4 * sn * sn);
      over(img, y * img.w + x, cov, cr * lum, cg * lum, cb * lum, hgt * (1 - sn * 0.4));
    }
}

/** Filled disc (flower centres, berries, lichen dots). */
export function paintDisc(img: Img, cx: number, cy: number, rad: number, color: RGB, shade = 1, hgt = 1, soft = 0): void {
  const x0 = Math.max(0, Math.floor(cx - rad - 1));
  const x1 = Math.min(img.w - 1, Math.ceil(cx + rad + 1));
  const y0 = Math.max(0, Math.floor(cy - rad - 1));
  const y1 = Math.min(img.ht - 1, Math.ceil(cy + rad + 1));
  const [cr, cg, cb] = color;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      let cov = rad - d + 0.5;
      if (soft > 0) cov = Math.min(cov, (rad - d) / soft);
      if (cov <= 0) continue;
      if (cov > 1) cov = 1;
      const sn = d / Math.max(rad, 0.5);
      const lum = shade * (1.08 - 0.3 * sn * sn);
      over(img, y * img.w + x, cov, cr * lum, cg * lum, cb * lum, hgt * (1 - sn * 0.5));
    }
}

/** Quadratic Bézier sampled into stem segments. */
export function paintCurve(
  img: Img,
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  r0: number,
  r1: number,
  color: RGB,
  shade = 1,
  steps = 8,
): void {
  let px = p0[0];
  let py = p0[1];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    const x = a * p0[0] + b * p1[0] + c * p2[0];
    const y = a * p0[1] + b * p1[1] + c * p2[1];
    const ra = r0 + (r1 - r0) * ((i - 1) / steps);
    const rb = r0 + (r1 - r0) * t;
    paintStem(img, px, py, x, y, ra, rb, color, shade);
    px = x;
    py = y;
  }
}

// ---------------------------------------------------------------------------
// Packing

const SRGB_LUT = (() => {
  const lut = new Uint8Array(4097);
  for (let i = 0; i <= 4096; i++) {
    const c = i / 4096;
    const v = c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    lut[i] = Math.round(Math.min(Math.max(v, 0), 1) * 255);
  }
  return lut;
})();

const toSrgb8 = (c: number): number => SRGB_LUT[c <= 0 ? 0 : c >= 1 ? 4096 : (c * 4096) | 0];
const to8 = (c: number): number => (c <= 0 ? 0 : c >= 1 ? 255 : Math.round(c * 255));

function baseTexture(data: Uint8Array, w: number, h: number, srgb: boolean, repeat: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  tex.flipY = false;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return tex;
}

/** Opaque / tiling albedo texture (GPU mipmaps). Alpha channel copied from img.a. */
export function albedoTexture(img: Img, repeat = true): THREE.DataTexture {
  const n = img.w * img.ht;
  const d = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    d[i * 4] = toSrgb8(img.r[i]);
    d[i * 4 + 1] = toSrgb8(img.g[i]);
    d[i * 4 + 2] = toSrgb8(img.b[i]);
    d[i * 4 + 3] = to8(img.a[i]);
  }
  const tex = baseTexture(d, img.w, img.ht, true, repeat);
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** RGBA texture where alpha carries linear data (height); RGB sRGB albedo. */
export function albedoHeightTexture(img: Img): THREE.DataTexture {
  const n = img.w * img.ht;
  const d = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    d[i * 4] = toSrgb8(img.r[i]);
    d[i * 4 + 1] = toSrgb8(img.g[i]);
    d[i * 4 + 2] = toSrgb8(img.b[i]);
    d[i * 4 + 3] = to8(img.h[i]);
  }
  const tex = baseTexture(d, img.w, img.ht, true, true);
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Tangent-space normal map from img.h (tileable central differences).
 * `strength` = normal tilt per unit height change per texel.
 */
export function normalTexture(img: Img, strength: number, repeat = true): THREE.DataTexture {
  const { w, ht: h } = img;
  const H = img.h;
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const yu = repeat ? (y + 1) % h : Math.min(y + 1, h - 1);
    const yd = repeat ? (y - 1 + h) % h : Math.max(y - 1, 0);
    for (let x = 0; x < w; x++) {
      const xr = repeat ? (x + 1) % w : Math.min(x + 1, w - 1);
      const xl = repeat ? (x - 1 + w) % w : Math.max(x - 1, 0);
      const dx = (H[y * w + xr] - H[y * w + xl]) * strength;
      const dy = (H[yu * w + x] - H[yd * w + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (y * w + x) * 4;
      d[o] = to8(-dx * inv * 0.5 + 0.5);
      d[o + 1] = to8(-dy * inv * 0.5 + 0.5);
      d[o + 2] = to8(inv * 0.5 + 0.5);
      d[o + 3] = 255;
    }
  }
  const tex = baseTexture(d, w, h, false, repeat);
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Cut-out foliage texture with a CPU mip chain: colour bleeds into transparent
 * texels (push-pull fill, so no dark fringes) and every level's alpha is
 * rescaled to keep the coverage at `cutoff` equal to level 0 — leaf cards
 * keep their density at distance instead of dissolving.
 */
export function foliageTexture(img: Img, cutoff = 0.5, repeat = false): THREE.DataTexture {
  interface Lvl {
    w: number;
    h: number;
    r: Float32Array;
    g: Float32Array;
    b: Float32Array;
    a: Float32Array;
  }
  // premultiplied pyramid
  const n0 = img.w * img.ht;
  const L0: Lvl = { w: img.w, h: img.ht, r: new Float32Array(n0), g: new Float32Array(n0), b: new Float32Array(n0), a: new Float32Array(img.a) };
  for (let i = 0; i < n0; i++) {
    const a = img.a[i];
    L0.r[i] = img.r[i] * a;
    L0.g[i] = img.g[i] * a;
    L0.b[i] = img.b[i] * a;
  }
  const levels: Lvl[] = [L0];
  let cur = L0;
  while (cur.w > 1 || cur.h > 1) {
    const w = Math.max(1, cur.w >> 1);
    const h = Math.max(1, cur.h >> 1);
    const n = w * h;
    const nx: Lvl = { w, h, r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n), a: new Float32Array(n) };
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let c = 0;
        for (let sy = 0; sy < 2; sy++)
          for (let sx = 0; sx < 2; sx++) {
            const X = Math.min(cur.w - 1, x * 2 + sx);
            const Y = Math.min(cur.h - 1, y * 2 + sy);
            const j = Y * cur.w + X;
            r += cur.r[j];
            g += cur.g[j];
            b += cur.b[j];
            a += cur.a[j];
            c++;
          }
        const i = y * w + x;
        nx.r[i] = r / c;
        nx.g[i] = g / c;
        nx.b[i] = b / c;
        nx.a[i] = a / c;
      }
    levels.push(nx);
    cur = nx;
  }
  // straight colour per level; empty texels pull colour from the coarser level
  const straight: { r: Float32Array; g: Float32Array; b: Float32Array }[] = levels.map((l) => ({
    r: new Float32Array(l.w * l.h),
    g: new Float32Array(l.w * l.h),
    b: new Float32Array(l.w * l.h),
  }));
  for (let k = levels.length - 1; k >= 0; k--) {
    const l = levels[k];
    const s = straight[k];
    const up = k + 1 < levels.length ? levels[k + 1] : null;
    const su = k + 1 < levels.length ? straight[k + 1] : null;
    for (let y = 0; y < l.h; y++)
      for (let x = 0; x < l.w; x++) {
        const i = y * l.w + x;
        const a = l.a[i];
        let r = 0;
        let g = 0;
        let b = 0;
        if (a > 1e-4) {
          r = l.r[i] / a;
          g = l.g[i] / a;
          b = l.b[i] / a;
        }
        if (up && su && a < 0.999) {
          const j = Math.min(up.h - 1, y >> 1) * up.w + Math.min(up.w - 1, x >> 1);
          const wgt = Math.min(1, a * 4);
          r = r * wgt + su.r[j] * (1 - wgt);
          g = g * wgt + su.g[j] * (1 - wgt);
          b = b * wgt + su.b[j] * (1 - wgt);
        }
        s.r[i] = r;
        s.g[i] = g;
        s.b[i] = b;
      }
  }
  // coverage preservation
  const coverage = (a: Float32Array, scale: number): number => {
    let c = 0;
    for (let i = 0; i < a.length; i++) if (a[i] * scale >= cutoff) c++;
    return c / a.length;
  };
  const target = coverage(L0.a, 1);
  const mips: { data: Uint8Array; width: number; height: number }[] = [];
  for (let k = 0; k < levels.length; k++) {
    const l = levels[k];
    let scale = 1;
    if (k > 0 && target > 0) {
      let lo = 0.25;
      let hi = 6;
      for (let it = 0; it < 14; it++) {
        const m = (lo + hi) * 0.5;
        if (coverage(l.a, m) < target) lo = m;
        else hi = m;
      }
      scale = (lo + hi) * 0.5;
    }
    const n = l.w * l.h;
    const d = new Uint8Array(n * 4);
    const s = straight[k];
    for (let i = 0; i < n; i++) {
      d[i * 4] = toSrgb8(s.r[i]);
      d[i * 4 + 1] = toSrgb8(s.g[i]);
      d[i * 4 + 2] = toSrgb8(s.b[i]);
      d[i * 4 + 3] = to8(l.a[i] * scale);
    }
    mips.push({ data: d, width: l.w, height: l.h });
  }
  const tex = baseTexture(mips[0].data, img.w, img.ht, true, repeat);
  tex.mipmaps = mips;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
