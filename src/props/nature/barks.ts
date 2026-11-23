// Species bark (and other wrapped surface) textures: tileable albedo +
// normal maps. Bark tiles are 256 × 512 texels covering BARK_U × BARK_V
// metres (u around the stem, v along it).

import type * as THREE from 'three';
import { mulberry32 } from '../../core/rng';
import { albedoTexture, Img, lin, mix, normalTexture, paintDisc, paintStem, pfbm, pnoise, pridge, pworley, sat, sstep, type RGB } from './tex';
import { barkMaterial, cachedTexture, texLow, texTier } from './mats';

/** Metres covered by one bark tile around / along the stem. */
export const BARK_U = 0.6;
export const BARK_V = 1.2;

export type BarkKind = 'oak' | 'acacia' | 'baobab' | 'pine' | 'birch' | 'palm' | 'bamboo' | 'cactus' | 'endgrain';

interface BarkTex {
  map: THREE.DataTexture;
  normal: THREE.DataTexture;
}

/** Full-resolution bark tile size (px); the low tier uses half. */
const W = 256;
const H = 512;

function lerp3(a: RGB, b: RGB, t: number, out: number[]): void {
  out[0] = mix(a[0], b[0], t);
  out[1] = mix(a[1], b[1], t);
  out[2] = mix(a[2], b[2], t);
}

/**
 * Furrowed bark (oak / acacia): long interlacing ridges split by fissures of
 * varying depth, ridges that merge / fork (two warped frequencies blended by a
 * slow mask), plates broken across the grain by irregular checks, lichen.
 */
function genFurrowed(img: Img, o: { nx: number; ny: number; seed: number; ridge: RGB; plate: RGB; crevice: RGB; inner: RGB; lichen: number; fibre: number }): void {
  const wv = new Float32Array(5);
  const wv2 = new Float32Array(5);
  const c = [0, 0, 0];
  for (let y = 0; y < img.ht; y++)
    for (let x = 0; x < img.w; x++) {
      const u = x / img.w;
      const v = y / img.ht;
      const i = y * img.w + x;
      // interlacing ridges: anisotropic noise, strongly warped along the grain
      const warp = pfbm(u, v, 2, 3, 3, o.seed) * 0.5;
      const warp2 = pfbm(u, v, 3, 2, 2, o.seed + 9) * 0.3;
      const n1 = pnoise((u + warp * 0.14) * o.nx, v * o.ny, o.nx, o.ny, o.seed + 1);
      const n2 = pnoise((u - warp2 * 0.12) * o.nx * 2, v * o.ny * 1.5, o.nx * 2, Math.round(o.ny * 1.5), o.seed + 2);
      // where the slow mask is high the coarse ridges dominate (wide plates), elsewhere fine ones (forks)
      const mask = sstep(-0.35, 0.35, pfbm(u, v, 2, 2, 2, o.seed + 10));
      const ridge = 1 - Math.abs(n1 * (0.45 + 0.4 * mask) + n2 * (0.55 - 0.4 * mask));
      // fissure depth varies (shallow, smoother zones vs deep cracks)
      const depthVar = 0.75 + 0.25 * pfbm(u, v, 3, 2, 2, o.seed + 11);
      // plates broken across the grain by irregular checks (two scales)
      pworley(u + warp * 0.05, v, Math.round(o.nx * 0.8), Math.round(o.ny * 2.2), o.seed + 3, wv, 1);
      pworley(u, v + warp2 * 0.05, Math.round(o.nx * 1.3), Math.round(o.ny * 3.5), o.seed + 12, wv2, 1);
      const brkA = (1 - sstep(0.0, 0.05, wv[1] - wv[0])) * sstep(0.3, 0.6, wv[2]);
      const brkB = (1 - sstep(0.0, 0.035, wv2[1] - wv2[0])) * sstep(0.55, 0.8, wv2[2]);
      const brk = Math.max(brkA, brkB * 0.8);
      const thr = 0.33 + 0.08 * pfbm(u, v, 4, 3, 2, o.seed + 13);
      const plate = sstep(thr, thr + 0.27, ridge) * (1 - brk * 0.45 * sstep(0.45, 0.8, ridge));
      const fibre = pfbm(u, v, 48, 3, 2, o.seed + 4);
      const fine = pfbm(u, v, 24, 24, 3, o.seed + 5);
      const rough = pridge(u, v, 10, 6, 3, o.seed + 6);
      const h = plate * (0.55 + 0.35 * rough) * depthVar + (1 - depthVar) * 0.35 + fibre * o.fibre + fine * 0.05;
      img.h[i] = sat(h);
      const top = sat(plate * (0.45 + 0.7 * rough) + wv[2] * 0.15 - 0.05);
      lerp3(o.plate, o.ridge, top, c);
      const tint = 0.92 + fine * 0.12 + (wv[2] - 0.5) * 0.14 + pfbm(u, v, 3, 3, 2, o.seed + 14) * 0.08;
      let r = c[0] * tint;
      let g = c[1] * tint;
      let b = c[2] * tint;
      const deep = (1 - plate) * depthVar;
      const innerT = sstep(0.6, 1, deep) * sstep(0.1, 0.6, pfbm(u, v, 6, 4, 2, o.seed + 7) * 0.5 + 0.5);
      r = mix(r, mix(o.crevice[0], o.inner[0], innerT), deep * 0.92);
      g = mix(g, mix(o.crevice[1], o.inner[1], innerT), deep * 0.92);
      b = mix(b, mix(o.crevice[2], o.inner[2], innerT), deep * 0.92);
      // lichen: patchy crusts (large blotches + speckle), on the plates
      const ln = pfbm(u, v, 4, 3, 4, o.seed + 8) + pfbm(u, v, 16, 12, 2, o.seed + 15) * 0.25;
      const lichen = sstep(0.28, 0.48, ln) * plate * o.lichen;
      r = mix(r, 0.26, lichen * 0.6);
      g = mix(g, 0.28, lichen * 0.6);
      b = mix(b, 0.2, lichen * 0.6);
      img.set(i, r, g, b, 1);
    }
}

/**
 * Baobab: smooth, stretched grey-brown skin. Irregular horizontal creases
 * (folds from the swelling trunk), faint vertical stretch lines, soft patches
 * of shed (paler) bark and rain streaks. Large-scale colour variation comes from vertex tint.
 */
function genBaobab(img: Img): void {
  const grey = lin(0x776d65);
  const copper = lin(0x82685a);
  const pale = lin(0x928a80);
  const crease = lin(0x3a2f28);
  for (let y = 0; y < img.ht; y++)
    for (let x = 0; x < img.w; x++) {
      const u = x / img.w;
      const v = y / img.ht;
      const i = y * img.w + x;
      const big = pfbm(u, v, 2, 3, 4, 301);
      const warp = pfbm(u, v, 3, 2, 3, 302) * 0.06;
      // horizontal folds: zero-crossings of horizontally stretched noise
      const fn = pnoise((u + warp) * 3, (v + warp * 0.5) * 22, 3, 22, 303) + pnoise(u * 5, v * 40, 5, 40, 304) * 0.35;
      const fold = 1 - sstep(0.0, 0.09, Math.abs(fn));
      const foldMask = sstep(-0.25, 0.35, pfbm(u, v, 3, 4, 2, 305));
      const cr = fold * foldMask;
      // soft swelling between folds
      const swell = sstep(-0.6, 0.6, fn) * 0.5;
      // shed-bark patches: soft irregular blobs, paler / smoother
      const patch = sstep(0.12, 0.42, pfbm(u + warp, v, 3, 4, 3, 306)) * 0.8;
      const stretch = pfbm(u, v, 48, 3, 2, 307);
      const fine = pfbm(u, v, 40, 40, 2, 308);
      // vertical rain streaks
      const stain = sstep(0.15, 0.7, pfbm(u, v, 9, 1, 3, 309)) * 0.45;
      const tc = sat(0.5 + big * 0.9);
      let r = mix(grey[0], copper[0], tc * 0.6);
      let g = mix(grey[1], copper[1], tc * 0.6);
      let b = mix(grey[2], copper[2], tc * 0.6);
      r = mix(r, pale[0], patch * 0.55);
      g = mix(g, pale[1], patch * 0.55);
      b = mix(b, pale[2], patch * 0.55);
      const l = 0.92 + fine * 0.07 + stretch * 0.05 + swell * 0.1;
      r *= l;
      g *= l;
      b *= l;
      r = mix(r, crease[0], cr * 0.75 + stain * 0.35);
      g = mix(g, crease[1], cr * 0.75 + stain * 0.35);
      b = mix(b, crease[2], cr * 0.75 + stain * 0.35);
      img.set(i, r, g, b, 1);
      img.h[i] = sat(0.5 + big * 0.18 + swell * 0.25 - cr * 0.35 - patch * 0.04 + fine * 0.03 + stretch * 0.03);
    }
}

/** Scots pine: flaky plates in neutral beige (tinted orange / grey by vertex colour). */
function genPine(img: Img): void {
  const wv = new Float32Array(5);
  const plateC = lin(0xa48b78);
  const flakeC = lin(0xc7a48a);
  const crev = lin(0x2a1f19);
  for (let y = 0; y < img.ht; y++)
    for (let x = 0; x < img.w; x++) {
      const u = x / img.w;
      const v = y / img.ht;
      const i = y * img.w + x;
      const wu = pfbm(u, v, 3, 3, 3, 401) * 0.06;
      const wvv = pfbm(u, v, 3, 3, 3, 402) * 0.06;
      pworley(u + wu, v + wvv, 5, 4, 403, wv, 0.9);
      const edge = wv[1] - wv[0];
      const plate = sstep(0.015, 0.12, edge);
      // papery flakes: terraced contours inside each plate
      const f = pfbm(u + wv[2], v, 6, 6, 3, 404) * 2.2 + wv[2] * 3;
      const terr = f - Math.floor(f);
      const step = sstep(0.0, 0.08, terr) * (1 - sstep(0.85, 1, terr));
      const fine = pfbm(u, v, 40, 20, 2, 405);
      const t = sat(0.5 + (wv[2] - 0.5) * 0.8 + fine * 0.2);
      let r = mix(plateC[0], flakeC[0], t);
      let g = mix(plateC[1], flakeC[1], t);
      let b = mix(plateC[2], flakeC[2], t);
      const lit = 0.85 + step * 0.2;
      r = mix(crev[0], r * lit, plate);
      g = mix(crev[1], g * lit, plate);
      b = mix(crev[2], b * lit, plate);
      img.set(i, r, g, b, 1);
      img.h[i] = plate * (0.6 + terr * 0.25) + fine * 0.04;
    }
}

function genBirch(img: Img): void {
  const rnd = mulberry32(501);
  const W = img.w;
  const H = img.ht;
  const k = img.w / 256; // pixel sizes below are authored for 256 px
  const white = lin(0xd9d5cc);
  const cream = lin(0xcfc4b0);
  for (let y = 0; y < img.ht; y++)
    for (let x = 0; x < img.w; x++) {
      const u = x / img.w;
      const v = y / img.ht;
      const i = y * img.w + x;
      const band = pfbm(u, v, 2, 24, 3, 502); // horizontal banding
      const blot = pfbm(u, v, 3, 3, 3, 503);
      const t = sat(0.5 + band * 0.6);
      const l = 0.95 + blot * 0.06;
      img.set(i, mix(white[0], cream[0], t) * l, mix(white[1], cream[1], t) * l, mix(white[2], cream[2], t) * l, 1);
      img.h[i] = 0.5 + band * 0.08;
    }
  // lenticels: short horizontal dark dashes (wrapping)
  const dark: RGB = lin(0x2a2522);
  const brown: RGB = lin(0x5a4a3e);
  for (let k = 0; k < 170; k++) {
    const cx = rnd() * W;
    const cy = rnd() * H;
    const len = (6 + rnd() * rnd() * 46) * k;
    const th = Math.max(0.7, (0.8 + rnd() * 1.4) * k);
    const col = rnd() < 0.7 ? dark : brown;
    for (const ox of [-W, 0, W])
      for (const oy of [-H, 0, H]) {
        const x0 = cx + ox - len / 2;
        const x1 = cx + ox + len / 2;
        if (x1 < -4 || x0 > W + 4 || cy + oy < -4 || cy + oy > H + 4) continue;
        paintStem(img, x0, cy + oy, x1, cy + oy + (rnd() - 0.5) * 1.5 * k, th, th * 0.6, col, 1, 0.2);
      }
  }
  // dark rough patches (old branch scars, "chevrons") and peeling curls
  for (let k = 0; k < 7; k++) {
    const cx = rnd() * W;
    const cy = rnd() * H;
    const s = (6 + rnd() * 14) * k;
    for (const ox of [-W, 0, W])
      for (const oy of [-H, 0, H]) {
        const px = cx + ox;
        const py = cy + oy;
        if (px < -40 * k || px > W + 40 * k || py < -40 * k || py > H + 40 * k) continue;
        paintStem(img, px - s * 1.6, py + s, px, py - s * 0.2, s * 0.25, s * 0.45, dark, 0.9, 0.1);
        paintStem(img, px + s * 1.6, py + s, px, py - s * 0.2, s * 0.25, s * 0.45, dark, 0.9, 0.1);
        paintDisc(img, px, py - s * 0.1, s * 0.4, dark, 0.8, 0.1);
      }
  }
  const peel = lin(0xb8957a);
  for (let k = 0; k < 10; k++) {
    const cx = rnd() * W;
    const cy = rnd() * H;
    const len = (20 + rnd() * 40) * k;
    for (const ox of [-W, 0, W]) {
      if (cx + ox + len < 0 || cx + ox - len > W) continue;
      paintStem(img, cx + ox - len / 2, cy, cx + ox + len / 2, cy + (rnd() - 0.5) * 3 * k, Math.max(0.8, 1.6 * k), Math.max(0.6, 1.2 * k), peel, 1.05, 0.9);
    }
  }
}

/**
 * Date palm: spiral lattice of old leaf bases ("boots") with fibre mats. The
 * lattice is domain-warped and every boot varies in size, height, tone and
 * wear (some broken off flush), so the trunk does not read as a regular grid.
 */
function genPalm(img: Img): void {
  const base = lin(0x76624e);
  const dark = lin(0x2a2018);
  const fibreC = lin(0x958062);
  const grey = lin(0x8a8378);
  const N = 4;
  const M = 6;
  for (let y = 0; y < img.ht; y++)
    for (let x = 0; x < img.w; x++) {
      const u = x / img.w;
      const v = y / img.ht;
      const i = y * img.w + x;
      // warp the lattice (tileable: periodic noise)
      const wa = pfbm(u, v, 2, 3, 3, 604) * 0.22;
      const wb = pfbm(u, v, 3, 2, 3, 605) * 0.22;
      const a = u * N + v * M + wa;
      const b = u * N - v * M + wb;
      const fa = a - Math.floor(a);
      const fb = b - Math.floor(b);
      // per-boot random values, periodic over the tile: a u-repeat shifts the
      // cell indices by (N, N), a v-repeat by (M, −M), so hash on (ia+ib, ia−ib)
      const ia = Math.floor(a);
      const ib = Math.floor(b);
      const cx = (ia + ib) * 0.5 + 0.37;
      const cy = (ia - ib) * 0.5 + 0.21;
      const cell = pnoise(cx, cy, N, M, 601) * 0.5 + 0.5;
      const cell2 = pnoise(cx + 0.43, cy + 0.29, N, M, 606) * 0.5 + 0.5;
      // boot size varies per cell: thicker / thinner rims
      const rimW = 0.05 + cell2 * 0.08;
      const de = Math.min(fa, 1 - fa, fb, 1 - fb);
      const rim = sstep(0.0, rimW, de);
      // broken-off boots: flush, weathered grey stubs
      const broken = sstep(0.7, 0.8, cell2);
      const along = (fa + fb) * 0.5; // 0 bottom corner … 1 top corner
      const scale = (0.35 + 0.55 * (1 - along)) * (1 - broken * 0.6) * (0.75 + 0.5 * cell);
      const fib = pfbm(u, v, 64, 4, 2, 602);
      const h = rim * (scale + fib * 0.12) + pfbm(u, v, 16, 16, 2, 603) * 0.05;
      img.h[i] = sat(h);
      const t = sat(0.5 + fib * 0.8);
      const l = 0.78 + cell * 0.4;
      let r = mix(base[0], fibreC[0], t) * l;
      let g = mix(base[1], fibreC[1], t) * l;
      let bb = mix(base[2], fibreC[2], t) * l;
      r = mix(r, grey[0], broken * 0.6);
      g = mix(g, grey[1], broken * 0.6);
      bb = mix(bb, grey[2], broken * 0.6);
      const shadow = (1 - rim) * 0.8 + sstep(0.6, 1, along) * 0.25 * (1 - broken);
      r = mix(r, dark[0], shadow);
      g = mix(g, dark[1], shadow);
      bb = mix(bb, dark[2], shadow);
      img.set(i, r, g, bb, 1);
    }
}

/** Bamboo internode (v = 0 … 1 is one internode, node ring at v = 0). */
function genBamboo(img: Img): void {
  const green = lin(0x7f9a4a);
  const yellow = lin(0xb4a75e);
  const wax = lin(0xc9ceb4);
  const nodeC = lin(0x5a5a32);
  for (let y = 0; y < img.ht; y++)
    for (let x = 0; x < img.w; x++) {
      const u = x / img.w;
      const v = y / img.ht;
      const i = y * img.w + x;
      const streak = pfbm(u, v, 40, 1, 3, 701);
      const blot = pfbm(u, v, 4, 2, 3, 702);
      const t = sat(0.3 + blot * 0.5 + (1 - v) * 0.15);
      let r = mix(green[0], yellow[0], t) * (1 + streak * 0.06);
      let g = mix(green[1], yellow[1], t) * (1 + streak * 0.06);
      let b = mix(green[2], yellow[2], t) * (1 + streak * 0.06);
      // waxy white band just below the node above (v → 1)
      const w = sstep(0.86, 0.97, v) * (1 - sstep(0.985, 1, v));
      r = mix(r, wax[0], w * 0.55);
      g = mix(g, wax[1], w * 0.55);
      b = mix(b, wax[2], w * 0.55);
      // node ring (v ≈ 0 / 1): raised darker band
      const dn = Math.min(v, 1 - v);
      const node = 1 - sstep(0.004, 0.022, dn);
      r = mix(r, nodeC[0], node * 0.7);
      g = mix(g, nodeC[1], node * 0.7);
      b = mix(b, nodeC[2], node * 0.7);
      // occasional dark sooty mould spots
      const spot = sstep(0.55, 0.62, pfbm(u, v, 12, 6, 2, 703));
      r *= 1 - spot * 0.4;
      g *= 1 - spot * 0.4;
      b *= 1 - spot * 0.35;
      img.set(i, r, g, b, 1);
      img.h[i] = 0.5 + node * 0.4 + streak * 0.03;
    }
}

/** Cactus rib: u = 0..1 across one rib (crest at 0.5), v = one areole spacing. */
function genCactus(img: Img): void {
  const green = lin(0x5c7444);
  const pale = lin(0x7c8c5c);
  const felt = lin(0xcfc6b0);
  const spineC = lin(0xd8cdb4);
  const spineTip = lin(0x5d4633);
  for (let y = 0; y < img.ht; y++)
    for (let x = 0; x < img.w; x++) {
      const u = x / img.w;
      const v = y / img.ht;
      const i = y * img.w + x;
      const crest = 1 - Math.abs(u - 0.5) * 2; // 1 on the crest, 0 in the groove
      const streak = pfbm(u, v, 3, 12, 3, 801);
      const blot = pfbm(u, v, 2, 2, 3, 802);
      const t = sat(crest * 0.5 + blot * 0.4);
      const l = 0.9 + streak * 0.08 + crest * 0.12;
      img.set(i, mix(green[0], pale[0], t) * l, mix(green[1], pale[1], t) * l, mix(green[2], pale[2], t) * l, 1);
      img.h[i] = 0.5 + streak * 0.05;
    }
  // areole with felt and a cluster of radiating spines (texture-space)
  const rnd = mulberry32(803);
  const cx = img.w * 0.5;
  for (const cy of [img.ht * 0.5]) {
    const sp = 9;
    for (let k = 0; k < sp; k++) {
      const a = (k / sp) * Math.PI * 2 + rnd() * 0.3;
      const len = (0.22 + rnd() * 0.18) * img.w * (k === 0 ? 1.6 : 1);
      const ex = cx + Math.cos(a) * len;
      const ey = cy + Math.sin(a) * len * 1.2;
      paintStem(img, cx, cy, ex, ey, 1.6, 0.4, spineC, 1.1, 1);
      paintStem(img, mix(cx, ex, 0.8), mix(cy, ey, 0.8), ex, ey, 0.9, 0.3, spineTip, 1, 1);
    }
    paintDisc(img, cx, cy, img.w * 0.07, felt, 1, 0.9);
  }
}

/** Log end grain: rings, radial checks and bark rim (non-tiling, centred). */
function genEndGrain(img: Img): void {
  const wood = lin(0xb89a76);
  const late = lin(0x8a6a4c);
  const barkC = lin(0x3a2e24);
  const rot = lin(0x5e4a38);
  const N = img.w;
  for (let y = 0; y < img.ht; y++)
    for (let x = 0; x < img.w; x++) {
      const i = y * img.w + x;
      const dx = (x + 0.5) / N - 0.5;
      const dy = (y + 0.5) / img.ht - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2; // 0 centre … 1 rim
      const ang = Math.atan2(dy, dx);
      const warp = pnoise(Math.cos(ang) * 3 + 5, Math.sin(ang) * 3 + 5, 64, 64, 901) * 0.03;
      const rr = (r + warp) * 26;
      const ring = rr - Math.floor(rr);
      const lt = sstep(0.6, 0.85, ring) * (1 - sstep(0.9, 1, ring));
      // radial checks (drying cracks)
      const ck = Math.abs(Math.sin(ang * 5 + pnoise(r * 4, ang, 64, 64, 902) * 0.8));
      const crack = (1 - sstep(0.0, 0.05, ck)) * sstep(0.15, 0.5, r) * (1 - sstep(0.85, 0.92, r));
      const weather = sstep(0.4, 0.95, r) * 0.35 + pfbm((x / N), (y / N), 4, 4, 3, 903) * 0.12;
      let cr = mix(wood[0], late[0], lt);
      let cg = mix(wood[1], late[1], lt);
      let cb = mix(wood[2], late[2], lt);
      cr = mix(cr, rot[0], weather);
      cg = mix(cg, rot[1], weather);
      cb = mix(cb, rot[2], weather);
      const bark = sstep(0.9, 0.94, r);
      cr = mix(cr, barkC[0], bark);
      cg = mix(cg, barkC[1], bark);
      cb = mix(cb, barkC[2], bark);
      const k = 1 - crack * 0.85;
      img.set(i, cr * k, cg * k, cb * k, 1);
      img.h[i] = 0.6 - lt * 0.1 - crack * 0.5 + (bark > 0.5 ? 0.2 : 0);
    }
}

function generate(kind: BarkKind, half: boolean): { img: Img; relief: number; texel: number } {
  let img: Img;
  const d = half ? 2 : 1;
  const bw = W / d;
  const bh = H / d;
  const texel = BARK_U / bw;
  switch (kind) {
    case 'oak':
      img = new Img(bw, bh, 1);
      genFurrowed(img, { nx: 9, ny: 2, seed: 101, ridge: lin(0x857565), plate: lin(0x5a4a3c), crevice: lin(0x1f1711), inner: lin(0x3a2619), lichen: 0.7, fibre: 0.08 });
      return { img, relief: 0.022, texel };
    case 'acacia':
      img = new Img(bw, bh, 1);
      genFurrowed(img, { nx: 12, ny: 3, seed: 201, ridge: lin(0x5a5048), plate: lin(0x3c332c), crevice: lin(0x15100d), inner: lin(0x5a2a18), lichen: 0.25, fibre: 0.12 });
      return { img, relief: 0.018, texel };
    case 'baobab':
      img = new Img(bw, bh, 1);
      genBaobab(img);
      return { img, relief: 0.028, texel };
    case 'pine':
      img = new Img(bw, bh, 1);
      genPine(img);
      return { img, relief: 0.016, texel };
    case 'birch':
      img = new Img(bw, bh, 1);
      genBirch(img);
      return { img, relief: 0.004, texel };
    case 'palm':
      img = new Img(bw, bh, 1);
      genPalm(img);
      return { img, relief: 0.03, texel };
    case 'bamboo':
      img = new Img(128 / d, 256 / d, 1);
      genBamboo(img);
      return { img, relief: 0.004, texel: 0.03 * d };
    case 'cactus':
      img = new Img(64, 128, 1);
      genCactus(img);
      return { img, relief: 0.004, texel: 0.002 };
    case 'endgrain':
      img = new Img(256 / d, 256 / d, 1);
      genEndGrain(img);
      return { img, relief: 0.004, texel: 0.002 * d };
  }
}

/** Cached albedo + normal textures for a bark kind (half resolution on the low tier). */
export function barkTextures(kind: BarkKind): BarkTex {
  const key = `bark-${kind}${texTier()}`;
  const half = texLow();
  const tile = kind !== 'endgrain';
  const map = cachedTexture(`${key}-map`, () => {
    const g = generate(kind, half);
    // the normal map comes from the same height field; cache it alongside
    cachedTexture(`${key}-normal`, () => normalTexture(g.img, g.relief / (2 * g.texel), tile));
    return albedoTexture(g.img, tile);
  });
  const normal = cachedTexture(`${key}-normal`, () => {
    const g = generate(kind, half);
    return normalTexture(g.img, g.relief / (2 * g.texel), tile);
  });
  return { map, normal };
}

/**
 * Bark material per kind (cached). Trunk sway is slight. `fade` = dissolve
 * near the camera with the foliage (trunks, stems); off for ground-level wood.
 */
export function barkMat(kind: BarkKind, sway = 0, fade = true): THREE.MeshStandardMaterial {
  const t = barkTextures(kind);
  const opts: { sway?: number; roughness?: number; normalScale?: number; fade?: boolean } = { sway, fade };
  if (kind === 'birch') opts.roughness = 0.75;
  if (kind === 'bamboo') opts.roughness = 0.45;
  if (kind === 'cactus') opts.roughness = 0.6;
  if (kind === 'baobab') opts.roughness = 0.84;
  return barkMaterial(`${kind}:${sway}${fade ? '' : ':nofade'}`, t.map, t.normal, opts);
}
