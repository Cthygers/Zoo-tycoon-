// Shared procedural PBR surfaces for props: timber, weathered timber,
// galvanised steel, painted steel, natural stone, concrete, dry-stone walling,
// chain-link mesh and glass.
//
// Every texture is generated once on the CPU (tileable value noise written
// into DataTextures, GPU-mipmapped) and cached for the lifetime of the app.
// Each surface comes as { map (sRGB albedo), normalMap, orm } where `orm`
// packs R = ambient occlusion, G = roughness, B = metalness, so a single
// texture feeds aoMap / roughnessMap / metalnessMap.
//
// UVs: textures are authored in metres — one repeat covers `tile` metres.
// Use `projectBoxUVs(geometry, tile, grainAxis)` to give any geometry
// world-scaled box-projected UVs (grain runs along `grainAxis`).
//
// Other prop modules may import these helpers freely. Materials returned by
// the getters are shared: clone them before changing per-object state.

import * as THREE from 'three';
import { hash3, mulberry32 } from '../core/rng';
import { STONE_NIGHT_GROUND, STRUCTURE_NIGHT_GROUND } from './nature/mats';

// ---------------------------------------------------------------------------
// Tileable noise

function lattice(ix: number, iy: number, seed: number): number {
  return hash3(ix, iy, seed) / 4294967296;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Periodic value noise in [-1, 1]; period px × py lattice cells. */
export function tileNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xf = Math.floor(x);
  const yf = Math.floor(y);
  const fx = fade(x - xf);
  const fy = fade(y - yf);
  const x0 = ((xf % px) + px) % px;
  const y0 = ((yf % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const a = lattice(x0, y0, seed);
  const b = lattice(x1, y0, seed);
  const c = lattice(x0, y1, seed);
  const d = lattice(x1, y1, seed);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return (ab + (cd - ab) * fy) * 2 - 1;
}

/**
 * Periodic fBm over the unit tile: (u, v) in [0,1), base frequency fu × fv
 * lattice cells per tile (integers keep it tileable). Result ≈ [-1, 1].
 */
export function tileFbm(u: number, v: number, fu: number, fv: number, octaves: number, seed: number, gain = 0.5): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let a = fu;
  let b = fv;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(u * a, v * b, a, b, seed + o * 101);
    norm += amp;
    amp *= gain;
    a *= 2;
    b *= 2;
  }
  return sum / norm;
}

/** Periodic cellular noise: returns F1 distance (cell units) and writes the nearest cell hash to out[0]. */
function tileVoronoi(u: number, v: number, n: number, seed: number, out: Float32Array): number {
  const x = u * n;
  const y = v * n;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 1e9;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const wx = ((cx % n) + n) % n;
      const wy = ((cy % n) + n) % n;
      const h = hash3(wx, wy, seed);
      const px = cx + (h & 0xffff) / 65536;
      const py = cy + (h >>> 16) / 65536;
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) {
        best = d;
        id = hash3(wx, wy, seed + 7) / 4294967296;
      }
    }
  out[0] = id;
  return Math.sqrt(best);
}

const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Texture assembly

/** Working buffers for one surface (all size², linear values). */
interface SurfaceBuffers {
  size: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
  height: Float32Array;
  ao: Float32Array;
  rough: Float32Array;
  metal: Float32Array;
}

function buffers(size: number): SurfaceBuffers {
  const n = size * size;
  return {
    size,
    r: new Float32Array(n),
    g: new Float32Array(n),
    b: new Float32Array(n),
    a: new Float32Array(n).fill(1),
    height: new Float32Array(n),
    ao: new Float32Array(n).fill(1),
    rough: new Float32Array(n).fill(0.8),
    metal: new Float32Array(n),
  };
}

function linearToSrgb8(c: number): number {
  const v = c <= 0 ? 0 : c >= 1 ? 1 : c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

function dataTexture(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.flipY = false;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export interface SurfaceTextures {
  /** sRGB albedo (alpha = coverage for cut-out surfaces). */
  map: THREE.DataTexture;
  /** Tangent-space normal map (OpenGL convention). */
  normalMap: THREE.DataTexture;
  /** R = AO, G = roughness, B = metalness. */
  orm: THREE.DataTexture;
  /** Metres covered by one texture repeat. */
  tile: number;
}

/**
 * Pack working buffers into textures. `relief` = metres represented by a
 * height delta of 1.0 (drives normal strength).
 */
function finish(buf: SurfaceBuffers, tile: number, relief: number): SurfaceTextures {
  const { size } = buf;
  const n = size * size;
  const col = new Uint8Array(n * 4);
  const nor = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const texel = tile / size;
  const k = relief / (2 * texel);
  const h = buf.height;
  for (let y = 0; y < size; y++) {
    const yu = ((y + 1) % size) * size;
    const yd = ((y - 1 + size) % size) * size;
    const yr = y * size;
    for (let x = 0; x < size; x++) {
      const i = yr + x;
      const xr = (x + 1) % size;
      const xl = (x - 1 + size) % size;
      const dx = (h[yr + xr] - h[yr + xl]) * k;
      const dy = (h[yu + x] - h[yd + x]) * k;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = i * 4;
      nor[o] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      nor[o + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      nor[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      nor[o + 3] = 255;
      col[o] = linearToSrgb8(buf.r[i]);
      col[o + 1] = linearToSrgb8(buf.g[i]);
      col[o + 2] = linearToSrgb8(buf.b[i]);
      col[o + 3] = Math.round(Math.min(Math.max(buf.a[i], 0), 1) * 255);
      orm[o] = Math.round(Math.min(Math.max(buf.ao[i], 0), 1) * 255);
      orm[o + 1] = Math.round(Math.min(Math.max(buf.rough[i], 0.02), 1) * 255);
      orm[o + 2] = Math.round(Math.min(Math.max(buf.metal[i], 0), 1) * 255);
      orm[o + 3] = 255;
    }
  }
  return { map: dataTexture(col, size, true), normalMap: dataTexture(nor, size, false), orm: dataTexture(orm, size, false), tile };
}

// ---------------------------------------------------------------------------
// Surface generators. Albedo values are linear reflectance.

/** Planed / sawn softwood (pine-like), grain along U. */
function genWood(): SurfaceTextures {
  const S = 256;
  const buf = buffers(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const warp = tileFbm(u, v, 2, 4, 3, 11) * 0.6;
      const ringPos = v * 9 + warp;
      const ring = ringPos - Math.floor(ringPos);
      const late = smooth(0.62, 0.8, ring) * (1 - smooth(0.9, 1, ring));
      const grain = tileFbm(u, v, 2, 48, 3, 12);
      const blot = tileFbm(u, v, 3, 3, 3, 13);
      const t = Math.min(Math.max(late * 0.75 + grain * 0.18 + 0.15 + blot * 0.1, 0), 1);
      const lum = 0.92 + blot * 0.08;
      buf.r[i] = (0.42 + (0.24 - 0.42) * t) * lum;
      buf.g[i] = (0.27 + (0.15 - 0.27) * t) * lum;
      buf.b[i] = (0.145 + (0.075 - 0.145) * t) * lum;
      buf.height[i] = late * 0.4 + grain * 0.25;
      buf.rough[i] = 0.62 + t * 0.12 + grain * 0.04;
      buf.ao[i] = 1 - late * 0.12;
    }
  return finish(buf, 1, 0.0012);
}

/** Grey, sun-bleached outdoor timber with raised grain, checks and lichen. */
function genWeatheredWood(): SurfaceTextures {
  const S = 256;
  const buf = buffers(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const warp = tileFbm(u, v, 2, 3, 3, 21) * 0.8;
      const ringPos = v * 11 + warp;
      const ring = ringPos - Math.floor(ringPos);
      const late = smooth(0.55, 0.78, ring) * (1 - smooth(0.88, 1, ring));
      const grain = tileFbm(u, v, 2, 64, 3, 22);
      // checks (drying cracks) run along the grain
      const ck = tileNoise(u * 3, v * 40, 3, 40, 23);
      const crackMask = smooth(0.25, 0.6, tileFbm(u, v, 4, 2, 2, 24));
      const crack = (1 - smooth(0.0, 0.07, Math.abs(ck))) * crackMask;
      const blot = tileFbm(u, v, 3, 4, 4, 25);
      const brown = smooth(-0.2, 0.5, blot); // less weathered, browner patches
      const lichenN = tileFbm(u, v, 6, 6, 4, 26);
      const lichen = smooth(0.42, 0.55, lichenN) * smooth(0.1, 0.5, tileFbm(u, v, 24, 24, 2, 27));
      let r = 0.17 + grain * 0.022 - late * 0.04;
      let g = 0.157 + grain * 0.02 - late * 0.038;
      let b = 0.136 + grain * 0.018 - late * 0.034;
      r += (0.19 - r) * brown * 0.55;
      g += (0.145 - g) * brown * 0.55;
      b += (0.1 - b) * brown * 0.55;
      r += (0.3 - r) * lichen * 0.7;
      g += (0.31 - g) * lichen * 0.7;
      b += (0.24 - b) * lichen * 0.7;
      const cr = 1 - crack * 0.75;
      buf.r[i] = r * cr;
      buf.g[i] = g * cr;
      buf.b[i] = b * cr;
      buf.height[i] = 0.5 - late * 0.45 + grain * 0.2 - crack * 0.9;
      buf.rough[i] = 0.86 + grain * 0.04 + crack * 0.08 - lichen * 0.04;
      buf.ao[i] = 1 - crack * 0.7 - late * 0.1;
    }
  return finish(buf, 1, 0.0035);
}

/** Hot-dip galvanised steel: spangle crystals, dull zinc, faint white rust. */
function genGalvanised(): SurfaceTextures {
  const S = 256;
  const buf = buffers(S);
  const cell = new Float32Array(1);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const d = tileVoronoi(u, v, 14, 31, cell);
      const sp = cell[0];
      const blot = tileFbm(u, v, 3, 3, 4, 32);
      const rust = smooth(0.3, 0.6, blot);
      const fine = tileFbm(u, v, 32, 32, 2, 33);
      const base = 0.4 + (sp - 0.5) * 0.07 + fine * 0.02;
      buf.r[i] = base + (0.44 - base) * rust * 0.6;
      buf.g[i] = base + 0.004 + (0.44 - base) * rust * 0.6;
      buf.b[i] = base + 0.01 + (0.42 - base) * rust * 0.6;
      buf.rough[i] = 0.46 + sp * 0.14 + rust * 0.25 + Math.max(0, 0.08 - d) * 0.4;
      buf.metal[i] = 0.85 - rust * 0.5;
      buf.height[i] = fine * 0.3 + sp * 0.2;
    }
  return finish(buf, 0.5, 0.0003);
}

/** Painted steel (tinted by material.color): orange-peel, small chips, grime. */
function genPaint(): SurfaceTextures {
  const S = 256;
  const buf = buffers(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const peel = tileFbm(u, v, 40, 40, 2, 41);
      const grime = tileFbm(u, v, 3, 5, 4, 42);
      const chipN = tileFbm(u, v, 10, 10, 4, 43);
      // sparse small chips: bare steel shows through (metallic, slightly darker)
      const chip = smooth(0.63, 0.66, chipN) * smooth(0.2, 0.5, tileFbm(u, v, 3, 3, 2, 44));
      const g = 0.9 + grime * 0.05 - smooth(0.25, 0.8, grime) * 0.08;
      const a = g * (1 - chip * 0.35);
      buf.r[i] = a;
      buf.g[i] = a;
      buf.b[i] = a;
      buf.rough[i] = 0.42 + peel * 0.05 + smooth(0.1, 0.7, grime) * 0.18 + chip * 0.15;
      buf.metal[i] = chip * 0.8;
      buf.height[i] = peel * 0.25 - chip * 0.5;
      buf.ao[i] = 1 - chip * 0.15;
    }
  return finish(buf, 1, 0.0008);
}

/** Natural weathered rock (grey granite / limestone mix). */
function genStone(): SurfaceTextures {
  const S = 256;
  const buf = buffers(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const big = tileFbm(u, v, 3, 3, 5, 51);
      const ridged = 1 - Math.abs(tileFbm(u, v, 6, 6, 4, 52));
      const speck = tileNoise(u * 128, v * 128, 128, 128, 53);
      const speck2 = tileNoise(u * 96, v * 96, 96, 96, 54);
      const lich = smooth(0.35, 0.5, tileFbm(u, v, 5, 5, 4, 55));
      let l = 0.2 + big * 0.04 + ridged * 0.03;
      l *= 1 - smooth(0.68, 0.85, speck) * 0.25;
      l *= 1 + smooth(0.75, 0.9, speck2) * 0.12;
      const warm = tileFbm(u, v, 2, 2, 3, 56) * 0.5 + 0.5;
      let r = l * (1.02 + warm * 0.08);
      let g = l * (1.0 + warm * 0.03);
      let b = l * (0.97 - warm * 0.05);
      r += (0.34 - r) * lich * 0.45;
      g += (0.33 - g) * lich * 0.45;
      b += (0.26 - b) * lich * 0.45;
      buf.r[i] = r;
      buf.g[i] = g;
      buf.b[i] = b;
      buf.height[i] = big * 0.5 + ridged * 0.4 + speck * 0.03;
      buf.rough[i] = 0.82 + ridged * 0.08;
      buf.ao[i] = 0.75 + ridged * 0.25;
    }
  return finish(buf, 1.5, 0.012);
}

/** Cast concrete: pale grey, pores, aggregate, water staining. */
function genConcrete(): SurfaceTextures {
  const S = 256;
  const buf = buffers(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const blot = tileFbm(u, v, 3, 3, 5, 61);
      const pore = tileNoise(u * 140, v * 140, 140, 140, 62);
      const agg = tileNoise(u * 90, v * 90, 90, 90, 63);
      const stain = smooth(0.1, 0.6, tileFbm(u, v, 6, 2, 4, 64));
      // rain streaks run down the face (high frequency across, low along V)
      const streak = smooth(0.15, 0.7, tileFbm(u, v, 24, 2, 3, 65)) * (0.5 + 0.5 * smooth(-0.3, 0.4, blot));
      let l = 0.21 + blot * 0.035 - stain * 0.045 - streak * 0.05;
      if (agg > 0.6) l += 0.025;
      const p = smooth(0.8, 0.92, pore);
      l *= 1 - p * 0.28;
      buf.r[i] = l * 1.01;
      buf.g[i] = l;
      buf.b[i] = l * 0.96;
      buf.height[i] = blot * 0.2 - p * 0.8 + (agg > 0.6 ? 0.1 : 0);
      buf.rough[i] = 0.86 + stain * 0.06;
      buf.ao[i] = 1 - p * 0.5;
    }
  return finish(buf, 2, 0.002);
}

/**
 * Dry-stone walling: irregular courses of flat, split field stones of varied
 * length with slanted joints, tight bedding and dark voids, weathered grey
 * with lichen crusts. One repeat = 2 m × 2 m (U along the wall).
 */
function genDrystone(): SurfaceTextures {
  const S = 512;
  const TILE_M = 2;
  const buf = buffers(S);
  const rnd = mulberry32(9001);
  interface Stone {
    /** joint position at the row centre (tile units) and its slant (du per dv) */
    b: number;
    slant: number;
    top: number; // inset from the row top (m)
    bot: number; // inset from the row bottom (m)
    end: number; // inset from the joints (m)
    rc: number; // corner radius (m)
    tone: number;
    warm: number;
    bulge: number;
  }
  interface Row {
    v0: number;
    v1: number;
    stones: Stone[];
  }
  const rows: Row[] = [];
  let vv = 0;
  while (vv < 0.999) {
    const h = (0.085 + rnd() * 0.075 + (rnd() < 0.18 ? 0.06 : 0)) / TILE_M;
    rows.push({ v0: vv, v1: vv + h, stones: [] });
    vv += h;
  }
  for (const r of rows) {
    r.v0 /= vv;
    r.v1 /= vv;
    const off = rnd();
    let uu = 0;
    const bs: number[] = [];
    while (uu < 0.999) {
      bs.push(uu);
      uu += (0.16 + rnd() * 0.3 + (rnd() < 0.2 ? 0.25 : 0)) / TILE_M;
    }
    for (const b0 of bs)
      r.stones.push({
        b: ((b0 / uu + off) % 1 + 1) % 1,
        slant: (rnd() - 0.5) * 0.7,
        top: rnd() * rnd() * 0.024,
        bot: rnd() * 0.003,
        end: rnd() * rnd() * 0.018,
        rc: 0.008 + rnd() * rnd() * 0.04,
        tone: rnd(),
        warm: rnd(),
        bulge: rnd(),
      });
    r.stones.sort((a, c) => a.b - c.b);
  }
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      // wavy bedding lines
      let vw = v + tileNoise(u * 6, 0.5, 6, 1, 71) * 0.008 + tileNoise(u * 22, 3.5, 22, 4, 72) * 0.002;
      vw -= Math.floor(vw);
      let ri = 0;
      while (ri < rows.length - 1 && vw >= rows[ri].v1) ri++;
      const row = rows[ri];
      const mid = (row.v0 + row.v1) / 2;
      const uw = u + tileNoise(v * 30, ri * 3.1, 30, 64, 73) * 0.003;
      // which stone: joints are slanted lines b + slant * (v - mid)
      const st = row.stones;
      const n = st.length;
      let k = n - 1;
      let left = 0;
      let right = 0;
      for (let j = 0; j < n; j++) {
        const bj = st[j].b + st[j].slant * (vw - mid);
        const bn = st[(j + 1) % n].b + st[(j + 1) % n].slant * (vw - mid) + (j + 1 === n ? 1 : 0);
        let q = uw;
        if (q < bj) q += 1;
        if (q >= bj && q < bn) {
          k = j;
          left = q - bj;
          right = bn - q;
          break;
        }
      }
      const s = st[k];
      const dx = Math.min(left, right) * TILE_M - s.end;
      const dyT = (row.v1 - vw) * TILE_M - s.top;
      const dyB = (vw - row.v0) * TILE_M - s.bot;
      const dy = Math.min(dyT, dyB);
      const rc = s.rc;
      let d: number;
      if (dx < rc && dy < rc) d = rc - Math.hypot(rc - Math.max(dx, -1), rc - Math.max(dy, -1));
      else d = Math.min(dx, dy);
      // ragged, split edges
      d += tileFbm(u, v, 20, 20, 3, 74) * 0.0055 + tileNoise(u * 96, v * 96, 96, 96, 75) * 0.002;
      const inStone = smooth(-0.002, 0.0015, d);
      const edge = smooth(0.0, 0.04, d);
      const fine = tileFbm(u, v, 48, 48, 3, 76);
      const face = tileFbm(u + s.tone * 0.37, v + s.warm * 0.21, 8, 8, 3, 77);
      // weathered grey sandstone / limestone mix
      const tone = 0.15 + s.tone * 0.11;
      const lum = tone * (0.92 + fine * 0.08 + face * 0.12) * (0.72 + 0.28 * edge);
      const wm = s.warm * s.warm;
      let r = lum * (0.97 + wm * 0.2);
      let g = lum * (0.96 + wm * 0.08);
      let b = lum * (0.95 - wm * 0.1);
      // lichen: pale grey-white crust, occasional ochre spots, more on upper faces of stones
      const lichN = tileFbm(u, v, 5, 5, 4, 78);
      const spots = smooth(0.1, 0.45, tileFbm(u, v, 36, 36, 2, 79));
      const lichen = smooth(0.18, 0.4, lichN) * spots * inStone * (0.6 + 0.4 * smooth(0.0, 0.05, dyB));
      const ochre = s.tone > 0.8;
      r += ((ochre ? 0.36 : 0.36) - r) * lichen * 0.7;
      g += ((ochre ? 0.28 : 0.36) - g) * lichen * 0.7;
      b += ((ochre ? 0.13 : 0.32) - b) * lichen * 0.7;
      // voids between stones: deep shadow with a little soil
      const soil = tileFbm(u, v, 12, 12, 2, 80) * 0.5 + 0.5;
      const vr = 0.025 + soil * 0.05;
      const vg = 0.021 + soil * 0.04;
      const vb = 0.017 + soil * 0.03;
      buf.r[i] = vr + (r - vr) * inStone;
      buf.g[i] = vg + (g - vg) * inStone;
      buf.b[i] = vb + (b - vb) * inStone;
      // split faces: flat with a slight per-stone tilt, sharp arris
      const arris = smooth(0.0, 0.012, d);
      const tilt = (s.bulge - 0.5) * (vw - mid) * TILE_M * 1.5;
      buf.height[i] = inStone * (0.35 + 0.35 * arris + tilt + fine * 0.05 + face * 0.1);
      buf.rough[i] = 0.86 + (1 - inStone) * 0.12 - lichen * 0.06;
      buf.ao[i] = 0.3 + 0.7 * edge;
    }
  return finish(buf, TILE_M, 0.07);
}

/**
 * Galvanised chain-link mesh: 50 mm diamonds, 3.5 mm wire. Alpha = wire
 * coverage (mipmaps average it into a faint veil at distance).
 */
function genChainLink(): SurfaceTextures {
  const S = 512;
  const TILE_M = 0.42;
  const N = 6; // diamonds per tile in each direction
  const buf = buffers(S);
  const unitM = TILE_M / N; // diamond diagonal (m)
  const w = 0.00175 / unitM / Math.SQRT1_2; // half wire width measured along the lattice coordinate
  const aa = (1 / S) * N * 0.9;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const px = ((x + 0.5) / S) * N;
      const py = ((y + 0.5) / S) * N;
      const s1 = px + py;
      const s2 = px - py;
      const d1 = Math.abs(s1 - Math.round(s1));
      const d2 = Math.abs(s2 - Math.round(s2));
      const c1 = smooth(w + aa, w - aa, d1);
      const c2 = smooth(w + aa, w - aa, d2);
      // which wire lies on top alternates per diamond row (woven look)
      const row = Math.floor(py * 2);
      const top1 = (row & 1) === 0;
      const h1 = Math.sqrt(Math.max(0, 1 - (d1 / w) * (d1 / w)));
      const h2 = Math.sqrt(Math.max(0, 1 - (d2 / w) * (d2 / w)));
      const h = top1 ? Math.max(h1 + 0.4 * c1, h2) : Math.max(h1, h2 + 0.4 * c2);
      const cov = Math.max(c1, c2);
      const zinc = 0.42 + tileNoise(((x + 0.5) / S) * 20, ((y + 0.5) / S) * 20, 20, 20, 81) * 0.05;
      // the lower wire at a crossing is in the upper one's shadow
      const under = top1 ? c1 * c2 * (h2 < h1 ? 0.35 : 0) : c1 * c2 * (h1 < h2 ? 0.35 : 0);
      buf.r[i] = zinc * (1 - under);
      buf.g[i] = (zinc + 0.006) * (1 - under);
      buf.b[i] = (zinc + 0.014) * (1 - under);
      buf.a[i] = cov;
      buf.height[i] = h;
      buf.rough[i] = 0.5 + zinc * 0.1;
      buf.metal[i] = 0.8;
      buf.ao[i] = 1 - under;
    }
  return finish(buf, TILE_M, 0.0016);
}

/** Faint smudges / dust on glass: alpha = dirt amount. */
function genGlassDirt(): THREE.DataTexture {
  const S = 128;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const o = (y * S + x) * 4;
      const n = tileFbm(u, v, 3, 3, 4, 91);
      const streak = tileFbm(u, v, 12, 1, 3, 92);
      const dust = smooth(0.0, 0.6, n) * 0.6 + smooth(0.2, 0.7, streak) * 0.3 + (1 - v) * 0.15;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(Math.min(dust, 1) * 255);
    }
  return dataTexture(data, S, false);
}

// ---------------------------------------------------------------------------
// Caches

export type SurfaceKind = 'wood' | 'weatheredWood' | 'galvanised' | 'paint' | 'stone' | 'concrete' | 'drystone' | 'chainlink';

const GENERATORS: Record<SurfaceKind, () => SurfaceTextures> = {
  wood: genWood,
  weatheredWood: genWeatheredWood,
  galvanised: genGalvanised,
  paint: genPaint,
  stone: genStone,
  concrete: genConcrete,
  drystone: genDrystone,
  chainlink: genChainLink,
};

const texCache = new Map<SurfaceKind, SurfaceTextures>();
const matCache = new Map<string, THREE.Material>();
let glassDirt: THREE.DataTexture | null = null;

/** Generated (cached) texture set for a surface kind. */
export function surfaceTextures(kind: SurfaceKind): SurfaceTextures {
  let t = texCache.get(kind);
  if (!t) {
    t = GENERATORS[kind]();
    texCache.set(kind, t);
  }
  return t;
}

function standard(kind: SurfaceKind, params: THREE.MeshStandardMaterialParameters, normalScale = 1): THREE.MeshStandardMaterial {
  const t = surfaceTextures(kind);
  const m = new THREE.MeshStandardMaterial({
    map: t.map,
    normalMap: t.normalMap,
    roughnessMap: t.orm,
    metalnessMap: t.orm,
    aoMap: t.orm,
    aoMapIntensity: 1,
    roughness: 1,
    metalness: 1,
    ...params,
  });
  m.normalScale.set(normalScale, normalScale);
  m.name = `props/${kind}`;
  return m;
}

function cached<T extends THREE.Material>(key: string, make: () => T): T {
  let m = matCache.get(key) as T | undefined;
  if (!m) {
    m = make();
    matCache.set(key, m);
  }
  return m;
}

/** Wood, paint and natural stone under the moon: `share` of the moonlit ground's look (nature/mats.ts applyNightLook, applied by the props layer and fences). */
export function withNightLook<T extends THREE.Material>(m: T, share = STRUCTURE_NIGHT_GROUND): T {
  m.userData.nightGround = share;
  return m;
}

/** Fresh sawn / planed timber (tile 1 m, grain along U). */
export function woodMaterial(): THREE.MeshStandardMaterial {
  return cached('wood', () => withNightLook(standard('wood', { metalness: 0 })));
}

/** Silver-grey weathered outdoor timber (tile 1 m, grain along U). */
export function weatheredWoodMaterial(): THREE.MeshStandardMaterial {
  return cached('weatheredWood', () => withNightLook(standard('weatheredWood', { metalness: 0 }, 1.2)));
}

/** Hot-dip galvanised steel (tile 0.5 m). */
export function galvanisedMaterial(): THREE.MeshStandardMaterial {
  return cached('galvanised', () => standard('galvanised', { metalness: 1, envMapIntensity: 1.1 }));
}

/** Painted steel in the given colour (tile 1 m). Cached per colour. */
export function paintedMetalMaterial(color: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
  const c = new THREE.Color(color);
  return cached(`paint:${c.getHexString()}`, () => withNightLook(standard('paint', { color: c, metalness: 1, envMapIntensity: 0.9 })));
}

/** Natural weathered rock (tile 1.5 m). */
export function stoneMaterial(): THREE.MeshStandardMaterial {
  return cached('stone', () => withNightLook(standard('stone', { metalness: 0 }), STONE_NIGHT_GROUND));
}

/** Cast concrete (tile 2 m). */
export function concreteMaterial(): THREE.MeshStandardMaterial {
  return cached('concrete', () => standard('concrete', { metalness: 0 }));
}

/** Dry-stone wall face: stacked field stones (tile 2 m × 2 m, courses along U). */
export function drystoneMaterial(): THREE.MeshStandardMaterial {
  return cached('drystone', () => withNightLook(standard('drystone', { metalness: 0 }, 1.3), STONE_NIGHT_GROUND));
}

/** Galvanised chain-link mesh, alpha-blended (tile 0.42 m). Double sided, casts no useful shadow. */
export function chainLinkMaterial(): THREE.MeshStandardMaterial {
  return cached('chainlink', () => {
    const m = standard('chainlink', {
      metalness: 1,
      transparent: true,
      alphaTest: 0.01,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    return m;
  });
}

export interface GlassOptions {
  /** Transmitted-light tint (multiplies a dark base; keep subtle). */
  tint?: THREE.ColorRepresentation;
  /** Opacity at normal incidence (0.04..0.3). */
  opacity?: number;
  /** Show the green tint of laminated glass edges near u = 0 / 1. */
  edgeTint?: boolean;
}

/**
 * Glass: physically-based reflections (scene.environment) added on top of
 * the background, which is attenuated by a Fresnel-weighted opacity. Cheap
 * (no transmission pass). Needs UVs (u across the pane) for edge tinting.
 */
export function glassMaterial(opts: GlassOptions = {}): THREE.MeshStandardMaterial {
  const tint = new THREE.Color(opts.tint ?? 0x0b1410);
  const opacity = opts.opacity ?? 0.07;
  const edge = opts.edgeTint ?? true;
  return cached(`glass:${tint.getHexString()}:${opacity}:${edge}`, () => {
    if (!glassDirt) glassDirt = genGlassDirt();
    const m = new THREE.MeshStandardMaterial({
      color: tint,
      roughness: 0.05,
      metalness: 0,
      envMapIntensity: 0.75,
      transparent: true,
      depthWrite: false,
      map: glassDirt,
    });
    m.name = 'props/glass';
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.OneFactor;
    m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    const uniforms = { uGlassAlpha: { value: opacity }, uGlassEdge: { value: edge ? 1 : 0 } };
    m.userData.glass = true;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uGlassAlpha = uniforms.uGlassAlpha;
      shader.uniforms.uGlassEdge = uniforms.uGlassEdge;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uGlassAlpha;\nuniform float uGlassEdge;')
        .replace(
          '#include <opaque_fragment>',
          /* glsl */ `
          {
            vec3 gV = normalize( vViewPosition );
            float gNdV = clamp( abs( dot( normal, gV ) ), 0.0, 1.0 );
            float gF = pow( 1.0 - gNdV, 5.0 );
            float gDirt = diffuseColor.a; // map alpha = dust
            float gEdgeU = min( vMapUv.x, 1.0 - vMapUv.x );
            float gEdge = uGlassEdge * ( 1.0 - smoothstep( 0.0, 0.012, gEdgeU ) );
            float gA = uGlassAlpha + gDirt * 0.08;
            gA = mix( gA, 1.0, gF * 0.9 );
            gA = mix( gA, 0.72, gEdge );
            vec3 gCol = outgoingLight;
            gCol += vec3( 0.006, 0.014, 0.011 ) * gEdge * ( 1.0 + gF );
            gl_FragColor = vec4( gCol, clamp( gA, 0.0, 1.0 ) );
          }`,
        )
        // dirt is carried in alpha only; keep the tint colour unmodulated
        .replace('#include <map_fragment>', '#ifdef USE_MAP\n\tdiffuseColor.a *= texture2D( map, vMapUv ).a;\n#endif');
    };
    m.customProgramCacheKey = () => 'props-glass';
    return m;
  });
}

/** Free GPU copies of every cached texture / material (they re-upload on next use). */
export function disposePropMaterials(): void {
  for (const m of matCache.values()) m.dispose();
  for (const t of texCache.values()) {
    t.map.dispose();
    t.normalMap.dispose();
    t.orm.dispose();
  }
  glassDirt?.dispose();
}

// ---------------------------------------------------------------------------
// UV helpers

const _n = new THREE.Vector3();

/**
 * Box-project world-scaled UVs (metres / tile) onto a geometry using its
 * object-space positions and normals. `grain` is the axis the texture's U
 * (grain / courses) should follow where it lies in the face plane.
 */
export function projectBoxUVs(geometry: THREE.BufferGeometry, tile: number, grain: 'x' | 'y' | 'z' = 'x', offset: [number, number, number] = [0, 0, 0]): void {
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  if (!pos || !nor) return;
  const uv = new Float32Array(pos.count * 2);
  const inv = 1 / tile;
  for (let i = 0; i < pos.count; i++) {
    _n.fromBufferAttribute(nor, i);
    const ax = Math.abs(_n.x);
    const ay = Math.abs(_n.y);
    const az = Math.abs(_n.z);
    const x = pos.getX(i) + offset[0];
    const y = pos.getY(i) + offset[1];
    const z = pos.getZ(i) + offset[2];
    let u: number;
    let v: number;
    if (ax >= ay && ax >= az) {
      // face plane: y, z
      if (grain === 'y') {
        u = y;
        v = z;
      } else {
        u = z;
        v = y;
      }
    } else if (ay >= az) {
      // face plane: x, z
      if (grain === 'z') {
        u = z;
        v = x;
      } else {
        u = x;
        v = z;
      }
    } else {
      // face plane: x, y
      if (grain === 'y') {
        u = y;
        v = x;
      } else {
        u = x;
        v = y;
      }
    }
    // decorrelate adjacent faces so details don't mirror across box edges
    const fo = ax >= ay && ax >= az ? (_n.x > 0 ? 0.31 : 0.83) : ay >= az ? (_n.y > 0 ? 0.57 : 0.11) : _n.z > 0 ? 0 : 0.46;
    uv[i * 2] = u * inv + fo;
    uv[i * 2 + 1] = v * inv + fo * 0.7;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
