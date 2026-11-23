// Procedural PBR surfaces for built props (generated once on the CPU, cached):
// timber cladding boards, thatch, clay pantiles, corrugated sheet, rendered
// wall, brick, dressed stone (ashlar), hay / straw, rope, cargo net, meat,
// water ripples and worn plastic. Each surface = sRGB albedo + tangent-space
// normal map + ORM (R = AO, G = roughness, B = metalness), authored in metres
// (`tile` metres per repeat). Linear albedo values below are reflectances.

import * as THREE from 'three';
import { hash3 } from '../../core/rng';
import { tileFbm, tileNoise } from '../materials';

export interface Surface {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  orm: THREE.DataTexture;
  /** Metres per repeat (U). */
  tile: number;
}

interface Buf {
  w: number;
  h: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
  ht: Float32Array;
  ao: Float32Array;
  rough: Float32Array;
  metal: Float32Array;
}

function buf(w: number, h = w): Buf {
  const n = w * h;
  return {
    w,
    h,
    r: new Float32Array(n),
    g: new Float32Array(n),
    b: new Float32Array(n),
    a: new Float32Array(n).fill(1),
    ht: new Float32Array(n),
    ao: new Float32Array(n).fill(1),
    rough: new Float32Array(n).fill(0.8),
    metal: new Float32Array(n),
  };
}

const hf = (a: number, b: number, c: number): number => hash3(a, b, c) / 4294967296;
const sm = (a: number, b: number, v: number): number => {
  const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
const fract = (v: number): number => v - Math.floor(v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function toSrgb8(c: number): number {
  const v = c <= 0 ? 0 : c >= 1 ? 1 : c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

export function dataTex(data: Uint8Array, w: number, h: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.flipY = false;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Pack buffers into textures; `relief` = metres per unit height (normal strength). */
function finish(B: Buf, tile: number, relief: number, tileV = tile): Surface {
  const { w, h } = B;
  const n = w * h;
  const col = new Uint8Array(n * 4);
  const nor = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const kx = relief / (2 * (tile / w));
  const ky = relief / (2 * (tileV / h));
  const H = B.ht;
  for (let y = 0; y < h; y++) {
    const yu = ((y + 1) % h) * w;
    const yd = ((y - 1 + h) % h) * w;
    const yr = y * w;
    for (let x = 0; x < w; x++) {
      const i = yr + x;
      const dx = (H[yr + ((x + 1) % w)] - H[yr + ((x - 1 + w) % w)]) * kx;
      const dy = (H[yu + x] - H[yd + x]) * ky;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = i * 4;
      nor[o] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      nor[o + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      nor[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      nor[o + 3] = 255;
      col[o] = toSrgb8(B.r[i]);
      col[o + 1] = toSrgb8(B.g[i]);
      col[o + 2] = toSrgb8(B.b[i]);
      col[o + 3] = Math.round(clamp01(B.a[i]) * 255);
      orm[o] = Math.round(clamp01(B.ao[i]) * 255);
      orm[o + 1] = Math.round(Math.min(Math.max(B.rough[i], 0.03), 1) * 255);
      orm[o + 2] = Math.round(clamp01(B.metal[i]) * 255);
      orm[o + 3] = 255;
    }
  }
  return { map: dataTex(col, w, h, true), normalMap: dataTex(nor, w, h, false), orm: dataTex(orm, w, h, false), tile };
}

// ---------------------------------------------------------------------------
// Generators

/**
 * Timber cladding / decking boards (light neutral stain — tint with
 * material.color). Boards run along U, 8 boards per 1.2 m repeat.
 */
function genBoards(): Surface {
  const S = 256;
  const B = buf(S);
  const NB = 8;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const bv = v * NB;
      const bi = Math.floor(bv);
      const bt = bv - bi; // across board 0..1
      const tone = hf(bi, 7, 1) - 0.5;
      const joint = hf(bi, 9, 2); // butt joint position along u
      const du = Math.abs(fract(u - joint + 0.5) - 0.5) * 1.2; // metres to joint
      const jointLine = 1 - sm(0.0, 0.0035, du);
      const warp = tileFbm(u, v, 2, 8, 2, 300 + bi) * 0.25;
      const grain = tileFbm(u, v + warp * 0.1, 3, 96, 3, 301);
      const ringsP = (v * NB * 5 + warp * 3 + hf(bi, 3, 3) * 9) % 1;
      const late = sm(0.6, 0.85, ringsP) * (1 - sm(0.9, 1, ringsP));
      const blot = tileFbm(u, v, 4, 4, 3, 302);
      // knots
      const kx = hf(bi, 11, 4);
      const kd = Math.hypot((fract(u - kx + 0.5) - 0.5) * 1.2 * 6, (bt - 0.5) * 1.6);
      const knot = hf(bi, 13, 5) > 0.55 ? 1 - sm(0.12, 0.3, kd) : 0;
      const edge = Math.min(bt, 1 - bt) * (1.2 / NB); // metres to board edge
      const groove = 1 - sm(0.0015, 0.004, edge);
      let l = 0.255 * (1 + tone * 0.32) * (1 - late * 0.18 + grain * 0.07 + blot * 0.06);
      l *= 1 - knot * 0.45;
      l *= 1 - groove * 0.7 - jointLine * 0.5;
      B.r[i] = l * 1.08;
      B.g[i] = l * 0.95;
      B.b[i] = l * 0.8;
      B.ht[i] = 0.6 - groove * 0.9 - jointLine * 0.6 + grain * 0.12 - late * 0.08 + sm(0, 0.012, edge) * 0.2;
      B.rough[i] = 0.72 + grain * 0.05 + groove * 0.1;
      B.ao[i] = 1 - groove * 0.65 - jointLine * 0.4 - knot * 0.1;
    }
  return finish(B, 1.2, 0.004);
}

/**
 * Planed hardwood (iroko / teak-like): fine straight grain along U, faint
 * ring figure, pores, occasional check. Tint with material.color. 1 m repeat.
 */
function genHardwood(): Surface {
  const S = 256;
  const B = buf(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const warp = tileFbm(u, v, 1, 6, 3, 1500) * 0.08;
      const fine = tileFbm(u, v + warp, 2, 160, 2, 1501);
      const mid = tileFbm(u, v + warp, 2, 40, 2, 1502);
      const ringP = fract((v + warp) * 26 + tileFbm(u, v, 2, 3, 2, 1503) * 0.6);
      const ring = sm(0.55, 0.85, ringP) * (1 - sm(0.88, 1, ringP));
      const blot = tileFbm(u, v, 3, 5, 3, 1504);
      const pore = sm(0.55, 0.8, tileNoise(u * 64, v * 256, 64, 256, 1505));
      const ck = tileNoise(u * 4, v * 60, 4, 60, 1506);
      const check = (1 - sm(0, 0.05, Math.abs(ck))) * sm(0.35, 0.6, tileFbm(u, v, 3, 2, 2, 1507));
      let l = 0.14 * (1 + fine * 0.1 + mid * 0.1 + blot * 0.12 - ring * 0.14);
      l *= 1 - pore * 0.12 - check * 0.45;
      B.r[i] = l * 1.32;
      B.g[i] = l * 0.86;
      B.b[i] = l * 0.52;
      B.ht[i] = fine * 0.3 + mid * 0.2 - ring * 0.15 - pore * 0.2 - check * 0.8;
      B.rough[i] = 0.62 + fine * 0.05 + pore * 0.1 + check * 0.1;
      B.ao[i] = 1 - check * 0.5 - pore * 0.08;
    }
  return finish(B, 1, 0.0012);
}

/**
 * Water-reed thatch: courses every 0.2 m up the slope (V), strands along V,
 * butt ends at each course's lower edge. U along the eave.
 */
function genThatch(): Surface {
  const S = 256;
  const B = buf(S);
  const NC = 3;
  const NS = 120; // strands per metre across (≈2 px each at 256 px/m)
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const cv = v * NC;
      const ci = Math.floor(cv);
      // irregular course edge
      const edgeJ = tileFbm(u, ci / NC, 10, 1, 2, 400 + ci) * 0.14;
      let t = cv - ci - edgeJ;
      let cc = ci;
      if (t < 0) {
        t += 1;
        cc = ci - 1;
      }
      // strands
      const wob = tileFbm(u, v, 6, 3, 2, 401 + cc) * 0.012;
      const su = (u + wob) * NS;
      const sid = Math.floor(su);
      const sf = su - sid;
      const sb = hf(sid, cc, 402); // strand brightness
      const across = Math.sin(sf * Math.PI); // round strand profile
      const fine = tileNoise(u * 256, v * 48, 256, 48, 403);
      const weather = tileFbm(u, v, 4, 4, 4, 404);
      const moss = sm(0.35, 0.65, tileFbm(u, v, 3, 3, 4, 405)) * 0.6;
      // butt ends: strands end at slightly varied lengths near the course bottom
      const endJ = hf(sid, cc, 406) * 0.12;
      const butt = 1 - sm(endJ, endJ + 0.05, t); // 1 right at the exposed edge
      const under = sm(0.72, 1.0, t); // shaded zone under the next course
      // weathering streaks running down the slope
      const streak = tileFbm(u, v, 22, 2, 3, 407);
      let l = (0.12 + sb * 0.1 + fine * 0.015) * (0.72 + 0.28 * across);
      l *= 1 + weather * 0.14 + streak * 0.12;
      l *= 1 - under * 0.1;
      let r = l * 1.2;
      let g = l * 0.97;
      let b = l * 0.62;
      // slightly paler cut ends at the course edge
      r += butt * 0.025;
      g += butt * 0.018;
      b += butt * 0.006;
      // greying + moss in the lower shaded areas
      const grey = sm(-0.1, 0.5, weather) * 0.4;
      const avg = (r + g + b) / 3;
      r += (avg - r) * grey;
      g += (avg - g) * grey;
      b += (avg - b) * grey;
      r += (0.06 - r) * moss * under;
      g += (0.07 - g) * moss * under;
      b += (0.03 - b) * moss * under;
      B.r[i] = r;
      B.g[i] = g;
      B.b[i] = b;
      B.ht[i] = (1 - t) * 0.09 + across * 0.2 + butt * 0.02 + sb * 0.1 + fine * 0.05 + streak * 0.12;
      B.rough[i] = 0.9 - butt * 0.04;
      B.ao[i] = 1 - under * 0.12 - (1 - across) * 0.18;
    }
  return finish(B, 1, 0.045);
}

/** Terracotta pantiles: 5 columns × 4 rows per metre. U along eave, V up slope. */
function genClayTiles(): Surface {
  const S = 256;
  const B = buf(S);
  const NCOL = 5;
  const NROW = 4;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const rv = v * NROW;
      const ri = Math.floor(rv);
      const t = rv - ri; // 0 = exposed lower edge, 1 = under next row
      const shift = (ri % 2) * 0.0; // pantiles align in columns
      const cu = u * NCOL + shift;
      const ci = Math.floor(cu);
      const cf = cu - ci;
      // S-shaped pantile profile: roll + pan
      const prof = 0.5 - 0.5 * Math.cos(cf * Math.PI * 2);
      const roll = Math.pow(prof, 0.8);
      const h0 = hf(ci, ri, 500);
      const h1 = hf(ci, ri, 501);
      const blot = tileFbm(u, v, 4, 4, 4, 502);
      const lichen = sm(0.45, 0.6, tileFbm(u, v, 8, 8, 4, 503)) * sm(0.0, 0.6, tileFbm(u, v, 2, 2, 2, 504));
      const grime = (1 - roll) * 0.25 + sm(0.6, 1, t) * 0.4;
      let r = 0.36 + h0 * 0.12 + blot * 0.03;
      let g = 0.135 + h0 * 0.05 + blot * 0.015;
      let b = 0.07 + h0 * 0.025;
      if (h1 > 0.85) {
        r *= 0.72;
        g *= 0.78;
        b *= 0.85;
      }
      r *= 1 - grime * 0.45;
      g *= 1 - grime * 0.42;
      b *= 1 - grime * 0.35;
      r += (0.28 - r) * lichen * 0.55;
      g += (0.27 - g) * lichen * 0.55;
      b += (0.2 - b) * lichen * 0.55;
      const fine = tileNoise(u * 200, v * 200, 200, 200, 505);
      B.r[i] = r * (1 + fine * 0.04);
      B.g[i] = g * (1 + fine * 0.04);
      B.b[i] = b * (1 + fine * 0.04);
      const lip = 1 - sm(0.0, 0.06, t);
      B.ht[i] = roll * 0.9 + (1 - t) * 0.5 + lip * 0.08 + fine * 0.02;
      B.rough[i] = 0.7 + lichen * 0.15 + grime * 0.1;
      B.ao[i] = 1 - sm(0.82, 1.0, t) * 0.6 - (1 - roll) * 0.18;
    }
  return finish(B, 1, 0.05);
}

/** Corrugated sheet (tint with material.color): 7 waves across U, streaks down V. */
function genCorrugated(): Surface {
  const S = 256;
  const B = buf(S);
  const W = 7;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const wave = Math.sin(u * W * Math.PI * 2);
      const streak = sm(0.2, 0.8, tileFbm(u, v, 24, 2, 3, 600));
      const blot = tileFbm(u, v, 3, 3, 4, 601);
      const rust = sm(0.45, 0.75, tileFbm(u, v, 5, 5, 4, 602)) * (0.5 + 0.5 * sm(0, 1, -wave));
      let l = 0.78 - streak * 0.1 + blot * 0.05;
      let r = l;
      let g = l;
      let b = l;
      r += (0.32 - r) * rust * 0.7;
      g += (0.16 - g) * rust * 0.7;
      b += (0.08 - b) * rust * 0.7;
      B.r[i] = r;
      B.g[i] = g;
      B.b[i] = b;
      B.ht[i] = wave * 0.5 + 0.5;
      B.rough[i] = 0.48 + streak * 0.15 + rust * 0.35;
      B.metal[i] = 0.35 * (1 - rust);
      B.ao[i] = 0.88 + wave * 0.12;
    }
  return finish(B, 0.54, 0.012);
}

/** Rendered / stuccoed wall (near-white: tint with material.color). 2 m repeat. */
function genRender(): Surface {
  const S = 256;
  const B = buf(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const blot = tileFbm(u, v, 3, 3, 5, 700);
      const fine = tileNoise(u * 180, v * 180, 180, 180, 701);
      const fine2 = tileNoise(u * 90, v * 90, 90, 90, 702);
      const streak = sm(0.3, 0.8, tileFbm(u, v, 20, 2, 3, 703)) * sm(0.0, 0.6, tileFbm(u, v, 2, 2, 2, 704));
      const l = 0.72 + blot * 0.035 + fine * 0.015 - streak * 0.06;
      B.r[i] = l;
      B.g[i] = l * 0.985;
      B.b[i] = l * 0.955;
      B.ht[i] = fine * 0.35 + fine2 * 0.3 + blot * 0.2;
      B.rough[i] = 0.9;
      B.ao[i] = 1 - Math.max(0, -fine) * 0.08;
    }
  return finish(B, 2, 0.0025);
}

/** Stretcher-bond brick: 12 courses × 4 bricks per 0.9 m. */
function genBrick(): Surface {
  const S = 256;
  const B = buf(S);
  const NC = 12;
  const NB = 4;
  const T = 0.9;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const cv = v * NC;
      const ci = Math.floor(cv);
      const ct = cv - ci;
      const bu = u * NB + (ci % 2) * 0.5;
      const bi = Math.floor(bu);
      const bt = bu - bi;
      // distance to mortar (metres)
      const dV = Math.min(ct, 1 - ct) * (T / NC);
      const dU = Math.min(bt, 1 - bt) * (T / NB);
      const d = Math.min(dU, dV);
      const mortar = 1 - sm(0.0035, 0.0055, d);
      const bh = hf(((bi % NB) + NB) % NB, ci, 800);
      const bh2 = hf(((bi % NB) + NB) % NB, ci, 801);
      const fine = tileNoise(u * 160, v * 160, 160, 160, 802);
      const blot = tileFbm(u, v, 3, 3, 4, 803);
      let r = 0.27 + bh * 0.1 + blot * 0.02;
      let g = 0.11 + bh * 0.04 + blot * 0.01;
      let b = 0.07 + bh * 0.03;
      if (bh2 > 0.8) {
        r *= 0.7;
        g *= 0.75;
        b *= 0.85;
      } else if (bh2 < 0.12) {
        r *= 1.15;
        g *= 1.2;
        b *= 1.15;
      }
      const pit = sm(0.6, 0.8, fine);
      r *= 1 - pit * 0.2;
      g *= 1 - pit * 0.2;
      b *= 1 - pit * 0.2;
      const mr = 0.36 + fine * 0.03;
      B.r[i] = r + (mr - r) * mortar;
      B.g[i] = g + (mr * 0.96 - g) * mortar;
      B.b[i] = b + (mr * 0.9 - b) * mortar;
      B.ht[i] = (1 - mortar) * (0.7 + sm(0.0, 0.01, d) * 0.3) - pit * 0.1 + fine * 0.04;
      B.rough[i] = 0.85 + mortar * 0.1;
      B.ao[i] = 1 - mortar * 0.45;
    }
  return finish(B, T, 0.01);
}

/** Dressed sandstone blocks (ashlar): 4 courses per 1.2 m, staggered block lengths. */
function genAshlar(): Surface {
  const S = 256;
  const B = buf(S);
  const NC = 4;
  const T = 1.2;
  // per course: block break positions (fractions of the tile)
  const breaks: number[][] = [];
  for (let c = 0; c < NC; c++) {
    const n = 2 + Math.floor(hf(c, 0, 900) * 2);
    const b: number[] = [];
    const o = hf(c, 1, 901);
    for (let k = 0; k < n; k++) b.push(fract(o + (k + (hf(c, k, 902) - 0.5) * 0.45) / n));
    b.sort((a, z) => a - z);
    breaks.push(b);
  }
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const cv = v * NC;
      const ci = Math.min(Math.floor(cv), NC - 1);
      const ct = cv - ci;
      const br = breaks[ci];
      let dU = 1;
      let blk = 0;
      for (let k = 0; k < br.length; k++) {
        const dd = Math.abs(fract(u - br[k] + 0.5) - 0.5);
        if (dd < dU) dU = dd;
        if (u >= br[k]) blk = k + 1;
      }
      if (blk >= br.length) blk = 0;
      const dm = Math.min(dU * T, Math.min(ct, 1 - ct) * (T / NC));
      const joint = 1 - sm(0.0025, 0.0045, dm);
      const chamfer = 1 - sm(0.004, 0.016, dm);
      const bh = hf(blk, ci, 903);
      const blot = tileFbm(u, v, 4, 4, 5, 904);
      const lam = tileFbm(u, v, 2, 40, 2, 905);
      const fine = tileNoise(u * 220, v * 220, 220, 220, 906);
      const dark = sm(0.2, 0.7, tileFbm(u, v, 3, 2, 3, 907));
      let l = 0.25 + bh * 0.07 + blot * 0.035 + lam * 0.02 + fine * 0.015;
      l *= 1 - dark * 0.22;
      l *= 1 - chamfer * 0.08;
      const jl = 0.17;
      const warmB = hf(blk, ci, 908);
      B.r[i] = (l * (1.1 + warmB * 0.06)) * (1 - joint) + jl * 1.02 * joint;
      B.g[i] = (l * 0.96) * (1 - joint) + jl * joint;
      B.b[i] = (l * (0.76 - warmB * 0.06)) * (1 - joint) + jl * 0.92 * joint;
      B.ht[i] = 0.8 - chamfer * 0.5 - joint * 0.4 + blot * 0.06 + fine * 0.03;
      B.rough[i] = 0.86 + joint * 0.08;
      B.ao[i] = 1 - joint * 0.6 - chamfer * 0.12;
    }
  return finish(B, T, 0.02);
}

/** Loose hay / straw: dense randomly oriented stems. 0.5 m repeat. */
function genHay(): Surface {
  const S = 256;
  const B = buf(S);
  const top = new Float32Array(S * S).fill(-1);
  const bright = new Float32Array(S * S);
  const hue = new Float32Array(S * S);
  let seed = 1;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const N = 2600;
  for (let k = 0; k < N; k++) {
    const layer = k / N;
    const x0 = rnd() * S;
    const y0 = rnd() * S;
    const ang = rnd() * Math.PI;
    const len = (0.04 + rnd() * 0.12) * (S / 0.5);
    const wid = 0.8 + rnd() * 1.1;
    const br = 0.55 + rnd() * 0.6;
    const hu = rnd();
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const steps = Math.ceil(len * 1.5);
    for (let s = 0; s <= steps; s++) {
      const px = x0 + (dx * len * s) / steps;
      const py = y0 + (dy * len * s) / steps;
      const r = Math.ceil(wid);
      for (let oy = -r; oy <= r; oy++)
        for (let ox = -r; ox <= r; ox++) {
          // distance from the stem axis
          const qx = Math.round(px) + ox;
          const qy = Math.round(py) + oy;
          const ddx = qx - px;
          const ddy = qy - py;
          const dist = Math.abs(ddx * dy - ddy * dx);
          if (dist > wid) continue;
          const ix = ((qx % S) + S) % S;
          const iy = ((qy % S) + S) % S;
          const j = iy * S + ix;
          const hgt = layer + (1 - dist / wid) * 0.02;
          if (hgt > top[j]) {
            top[j] = hgt;
            bright[j] = br * (0.8 + 0.2 * (1 - dist / wid));
            hue[j] = hu;
          }
        }
    }
  }
  for (let i = 0; i < S * S; i++) {
    const t = top[i];
    if (t < 0) {
      B.r[i] = 0.05;
      B.g[i] = 0.04;
      B.b[i] = 0.02;
      B.ht[i] = 0;
      B.ao[i] = 0.4;
      B.rough[i] = 0.95;
      continue;
    }
    const l = bright[i];
    const greenish = hue[i] < 0.18 ? 1 : 0;
    const dark = hue[i] > 0.9 ? 1 : 0;
    let r = 0.31 * l;
    let g = 0.25 * l;
    let b = 0.13 * l;
    if (greenish) {
      r = 0.22 * l;
      g = 0.225 * l;
      b = 0.11 * l;
    }
    if (dark) {
      r *= 0.6;
      g *= 0.58;
      b *= 0.55;
    }
    const depth = 0.55 + 0.45 * t;
    B.r[i] = r * depth;
    B.g[i] = g * depth;
    B.b[i] = b * depth;
    B.ht[i] = t;
    B.ao[i] = 0.55 + 0.45 * t;
    B.rough[i] = 0.82;
  }
  return finish(B, 0.5, 0.03);
}

/** 3-strand twisted manila rope. U along the rope (0.12 m), V around. */
function genRope(): Surface {
  const S = 128;
  const B = buf(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const ph = fract(u * 3 + v * 3);
      const strand = Math.sin(ph * Math.PI);
      const fib = tileNoise(u * 64 + v * 16, v * 96, 64, 96, 1000);
      const l = (0.27 + fib * 0.04) * (0.55 + 0.45 * strand);
      B.r[i] = l * 1.15;
      B.g[i] = l * 0.98;
      B.b[i] = l * 0.7;
      B.ht[i] = strand + fib * 0.1;
      B.rough[i] = 0.9;
      B.ao[i] = 0.6 + 0.4 * strand;
    }
  return finish(B, 0.12, 0.006);
}

/** Cargo net: rope grid with knots, alpha = rope. One 0.25 m mesh cell per repeat. */
function genNet(): Surface {
  const S = 128;
  const B = buf(S);
  const T = 0.25;
  const R = 0.011; // rope radius (m)
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const du = Math.min(u, 1 - u) * T;
      const dv = Math.min(v, 1 - v) * T;
      const knotD = Math.hypot(du, dv);
      const onU = dv < R; // rope running along U
      const onV = du < R;
      const knot = knotD < R * 2.0;
      const cover = onU || onV || knot;
      const prof = knot ? 1 - knotD / (R * 2) : onU ? 1 - dv / R : onV ? 1 - du / R : 0;
      const tw = Math.sin(fract((onU ? u : v) * 10 + (onU ? dv : du) * 40) * Math.PI);
      const l = (0.22 + tw * 0.05) * (0.6 + 0.4 * prof);
      B.r[i] = l * 1.12;
      B.g[i] = l * 0.98;
      B.b[i] = l * 0.72;
      B.a[i] = cover ? 1 : 0;
      B.ht[i] = cover ? prof * (knot ? 1.4 : 1) + tw * 0.1 : 0;
      B.rough[i] = 0.9;
      B.ao[i] = 0.7 + 0.3 * prof;
    }
  return finish(B, T, 0.01);
}

/** Water ripples (normal map only matters). */
function genWater(): Surface {
  const S = 256;
  const B = buf(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const h = tileFbm(u, v, 6, 6, 4, 1100, 0.55) + 0.4 * tileFbm(u + 0.3, v, 14, 5, 2, 1101);
      B.r[i] = 1;
      B.g[i] = 1;
      B.b[i] = 1;
      B.ht[i] = h;
      B.rough[i] = 0.04;
      B.ao[i] = 1;
    }
  return finish(B, 1.5, 0.02);
}

/** Falling-water sheet: streaky alpha along V (flow direction). */
function genFalls(): Surface {
  const S = 128;
  const B = buf(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const st = tileFbm(u, v, 24, 3, 3, 1150);
      const st2 = tileFbm(u, v, 48, 6, 2, 1151);
      const a = clamp01(0.35 + st * 0.5 + st2 * 0.25);
      B.r[i] = 0.75 + st2 * 0.1;
      B.g[i] = 0.82 + st2 * 0.1;
      B.b[i] = 0.85 + st2 * 0.1;
      B.a[i] = a;
      B.ht[i] = st * 0.6 + st2 * 0.4;
      B.rough[i] = 0.08;
      B.ao[i] = 1;
    }
  return finish(B, 0.5, 0.004);
}

/**
 * Aerated water / foam for fountain splash rings: white bubbly lace (alpha)
 * with streaks along V (the outward flow direction). 0.5 m repeat.
 */
function genFoam(): Surface {
  const S = 128;
  const B = buf(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const lace = tileFbm(u, v, 12, 12, 3, 1160);
      const fine = tileFbm(u, v, 32, 32, 2, 1161);
      const streak = tileFbm(u, v, 24, 4, 2, 1162);
      // thin bubbly filaments rather than blotches
      const fil = 1 - Math.abs(lace * 1.6);
      const a = clamp01((fil - 0.35) * 1.6 + fine * 0.35 + streak * 0.2);
      B.r[i] = 0.82 + fine * 0.05;
      B.g[i] = 0.86 + fine * 0.05;
      B.b[i] = 0.88 + fine * 0.05;
      B.a[i] = a;
      B.ht[i] = lace * 0.5 + fine * 0.5;
      B.rough[i] = 0.35;
      B.ao[i] = 1;
    }
  return finish(B, 0.5, 0.002);
}

/** Raw meat: dark red muscle fibres with fat marbling. 0.3 m repeat. */
function genMeat(): Surface {
  const S = 128;
  const B = buf(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const fib = tileFbm(u, v, 2, 40, 3, 1200);
      const marb = sm(0.35, 0.55, tileFbm(u, v, 4, 6, 4, 1201));
      const dry = sm(0.0, 0.6, tileFbm(u, v, 3, 3, 3, 1202));
      let r = 0.15 + fib * 0.03;
      let g = 0.018 + fib * 0.006;
      let b = 0.016;
      // drying surface turns brown
      r += (0.09 - r) * dry * 0.6;
      g += (0.03 - g) * dry * 0.6;
      b += (0.02 - b) * dry * 0.6;
      r += (0.42 - r) * marb * 0.8;
      g += (0.3 - g) * marb * 0.8;
      b += (0.22 - b) * marb * 0.8;
      B.r[i] = r;
      B.g[i] = g;
      B.b[i] = b;
      B.ht[i] = fib * 0.3 + marb * 0.3;
      B.rough[i] = 0.38 + dry * 0.3;
      B.ao[i] = 0.9 + fib * 0.1;
    }
  return finish(B, 0.3, 0.004);
}

/**
 * Worn hard-plastic enrichment ball, equirectangular (U around, V pole→pole
 * with V = 0 at the bottom). Scuffs, scratches and dirt rising from the base.
 */
function genBall(color: THREE.Color): Surface {
  const W = 256;
  const H = 128;
  const B = buf(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      const i = y * W + x;
      const scuff = sm(0.25, 0.65, tileFbm(u, v, 8, 4, 4, 1300));
      const scr = tileNoise(u * 128 + v * 30, v * 16, 128, 16, 1301);
      const scratch = 1 - sm(0.0, 0.06, Math.abs(scr)) * sm(0.2, 0.6, tileFbm(u, v, 6, 3, 2, 1302));
      const dirtN = tileFbm(u, v, 6, 3, 4, 1303);
      const dirt = clamp01(sm(0.42, 0.05, v + dirtN * 0.12)) * 0.9 + sm(0.5, 0.8, tileFbm(u, v, 5, 3, 3, 1304)) * 0.25;
      const fade = 1 + tileFbm(u, v, 2, 2, 3, 1305) * 0.08;
      let r = color.r * fade;
      let g = color.g * fade;
      let b = color.b * fade;
      // scuffs are paler/greyer, scratches whitish
      r += (0.22 - r) * scuff * 0.4 + (0.32 - r) * (1 - scratch) * 0.7;
      g += (0.22 - g) * scuff * 0.4 + (0.32 - g) * (1 - scratch) * 0.7;
      b += (0.22 - b) * scuff * 0.4 + (0.32 - b) * (1 - scratch) * 0.7;
      r += (0.09 - r) * dirt;
      g += (0.07 - g) * dirt;
      b += (0.045 - b) * dirt;
      B.r[i] = r;
      B.g[i] = g;
      B.b[i] = b;
      B.ht[i] = -scuff * 0.2 - (1 - scratch) * 0.6 + dirt * 0.1;
      B.rough[i] = 0.46 + scuff * 0.28 + (1 - scratch) * 0.2 + dirt * 0.3;
      B.ao[i] = 1;
    }
  return finish(B, 1, 0.0006, 1);
}

/**
 * Striped awning canvas: two stripes per repeat along U (colour a then b),
 * stitched seams, weave texture and soft soiling.
 */
function genFabric(a: THREE.Color, b: THREE.Color): Surface {
  const S = 128;
  const B = buf(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const first = u < 0.5;
      const du = Math.min(Math.abs(u - 0.5), u, 1 - u); // distance to a seam (tile units)
      const seam = 1 - sm(0.004, 0.012, du);
      const weave = ((x + (y >> 1)) & 1) * 0.5 + tileNoise(u * 64, v * 64, 64, 64, 1400) * 0.5;
      const soil = sm(0.2, 0.8, tileFbm(u, v, 3, 3, 3, 1401)) * 0.12;
      const c = first ? a : b;
      const k = (1 + weave * 0.05) * (1 - soil) * (1 - seam * 0.25);
      B.r[i] = c.r * k;
      B.g[i] = c.g * k;
      B.b[i] = c.b * k;
      B.ht[i] = weave * 0.3 - seam * 0.5;
      B.rough[i] = 0.82;
      B.ao[i] = 1 - seam * 0.2;
    }
  return finish(B, 0.5, 0.0015);
}

export function fabricSurface(a: number, b: number): Surface {
  const key = `fabric:${a}:${b}`;
  let s = cache.get(key);
  if (!s) {
    s = genFabric(new THREE.Color(a), new THREE.Color(b));
    cache.set(key, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Cache

export type StructSurface =
  | 'boards'
  | 'hardwood'
  | 'thatch'
  | 'clayTiles'
  | 'corrugated'
  | 'render'
  | 'brick'
  | 'ashlar'
  | 'hay'
  | 'rope'
  | 'net'
  | 'water'
  | 'falls'
  | 'foam'
  | 'meat';

const GEN: Record<StructSurface, () => Surface> = {
  boards: genBoards,
  hardwood: genHardwood,
  thatch: genThatch,
  clayTiles: genClayTiles,
  corrugated: genCorrugated,
  render: genRender,
  brick: genBrick,
  ashlar: genAshlar,
  hay: genHay,
  rope: genRope,
  net: genNet,
  water: genWater,
  falls: genFalls,
  foam: genFoam,
  meat: genMeat,
};

const cache = new Map<string, Surface>();

export function surface(kind: StructSurface): Surface {
  let s = cache.get(kind);
  if (!s) {
    s = GEN[kind]();
    cache.set(kind, s);
  }
  return s;
}

export function ballSurface(hex: number): Surface {
  const key = `ball:${hex}`;
  let s = cache.get(key);
  if (!s) {
    s = genBall(new THREE.Color(hex));
    cache.set(key, s);
  }
  return s;
}

/** Free GPU copies of all cached surfaces (they re-upload if used again). */
export function disposeSurfaces(): void {
  for (const s of cache.values()) {
    s.map.dispose();
    s.normalMap.dispose();
    s.orm.dispose();
  }
}
