// Procedurally painted foliage atlases. Each atlas is a set of sprites
// (twig clusters, fronds, grass tussocks, flowering plants) rasterised with
// the anti-aliased painter in tex.ts and packed with coverage-preserving
// alpha mips.
//
// Sprite convention: the sprite's root (where it attaches to a branch or the
// ground) is at v = 0 in the middle of its cell; it grows toward v = 1.
//
// Atlases are packed into two shared sheets so all trees (and all ground
// plants) draw with ONE foliage material each — the props layer batches per
// material, so this saves a draw call per species in the main and shadow
// passes:
//   trees  2048×1024: oak, acacia, baobab, pine, birch, bamboo, palm
//   ground 1024×1024: grass, reed, flowers, fern
// AtlasInfo carries the species' rect in its sheet; cellUV() maps into it.

import * as THREE from 'three';
import { mulberry32 } from '../../core/rng';
import { cachedTexture, foliageMaterial, type FoliageMaterial, hasCachedTexture, LEAF_PARAMS, texLow } from './mats';
import { albedoTexture, foliageTexture, Img, lin, mix, normalTexture, paintCurve, paintDisc, paintLeaf, paintStem, pfbm, sat, type RGB } from './tex';

type Rnd = () => number;

export type AtlasKind = 'oak' | 'acacia' | 'baobab' | 'pine' | 'birch' | 'bamboo' | 'palm' | 'fern' | 'grass' | 'reed' | 'flowers';

/** Atlas layout: grid of cells (cols × rows) inside `rect` [u0, v0, u1, v1] of the sheet texture. */
export interface AtlasInfo {
  tex: THREE.DataTexture;
  cols: number;
  rows: number;
  rect: [number, number, number, number];
  sheet: SheetKind;
}

export function cellUV(a: { cols: number; rows: number; rect?: [number, number, number, number] }, cell: number): [number, number, number, number] {
  const c = cell % a.cols;
  const r = Math.floor(cell / a.cols) % a.rows;
  const [u0, v0, u1, v1] = a.rect ?? [0, 0, 1, 1];
  const su = (u1 - u0) / a.cols;
  const sv = (v1 - v0) / a.rows;
  return [u0 + c * su, v0 + r * sv, u0 + (c + 1) * su, v0 + (r + 1) * sv];
}

// ---------------------------------------------------------------------------
// Leaf shapes: half-width profile w(t) in [0,1]

const PI = Math.PI;
export const SHAPES = {
  elliptic: (t: number): number => Math.pow(Math.sin(PI * t), 0.75),
  ovate: (t: number): number => Math.pow(Math.sin(PI * Math.pow(t, 0.72)), 0.85),
  obovate: (t: number): number => Math.pow(Math.sin(PI * Math.pow(t, 1.35)), 0.8),
  lanceolate: (t: number): number => Math.pow(Math.sin(PI * Math.pow(t, 0.55)), 1.2),
  linear: (t: number): number => (t < 0.8 ? 1 - t * 0.25 : ((1 - t) / 0.2) * 0.8),
  needle: (t: number): number => 1 - Math.pow(t, 6),
  oak: (t: number): number => {
    const base = Math.pow(Math.sin(PI * Math.pow(t, 0.8)), 0.7) * (0.5 + 0.5 * Math.min(1, t * 1.6));
    const lob = t > 0.1 && t < 0.93 ? 0.58 + 0.42 * Math.pow(Math.abs(Math.cos(PI * 4.5 * (t - 0.1))), 0.55) : 1;
    return base * lob;
  },
  birch: (t: number): number => {
    const base = t < 0.32 ? Math.pow(Math.sin((t / 0.32) * PI * 0.5), 0.6) : Math.pow(1 - (t - 0.32) / 0.68, 1.15);
    const f = t * 15 - Math.floor(t * 15);
    return base * (1 - 0.09 * f);
  },
};

type Shape = (t: number, side: number) => number;

interface PaintCtx {
  img: Img;
  rnd: Rnd;
}

function jitterColor(rnd: Rnd, a: RGB, b: RGB, bright = 0.12): RGB {
  const t = rnd();
  const l = 1 + (rnd() - 0.5) * 2 * bright;
  return [mix(a[0], b[0], t) * l, mix(a[1], b[1], t) * l, mix(a[2], b[2], t) * l];
}

// ---------------------------------------------------------------------------
// Twig skeletons

interface Attach {
  x: number;
  y: number;
  /** Direction of the twig at this point. */
  dir: number;
  /** 0..1 along its twig. */
  t: number;
  tip: boolean;
  side: number;
}

interface TwigOpts {
  /** Cell origin and size (px). */
  ox: number;
  oy: number;
  S: number;
  stem: RGB;
  stemW: number;
  /** Main stem reach (fraction of cell). */
  reach: number;
  /** Side twigs. */
  sides: number;
  sideLen: [number, number];
  sideAngle: [number, number];
  /** Spacing between attachment points along twigs (px). */
  every: number;
  /** Lateral wobble of the main stem. */
  wobble: number;
  /** Zig-zag amplitude (acacia). */
  zigzag?: number;
}

/** Paint a twig skeleton and return attachment points (leaf positions). */
function twig(ctx: PaintCtx, o: TwigOpts): Attach[] {
  const { img, rnd } = ctx;
  const out: Attach[] = [];
  const cx = o.ox + o.S * 0.5;
  const y0 = o.oy + 2;
  const segs = 8;
  const pts: [number, number][] = [];
  const bend = (rnd() - 0.5) * o.wobble * o.S;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const zz = o.zigzag ? (i % 2 ? 1 : -1) * o.zigzag * o.S * (i > 0 ? 1 : 0) : 0;
    pts.push([cx + bend * t * t + zz + (rnd() - 0.5) * 2, y0 + t * o.reach * o.S]);
  }
  const stemAng = (i: number): number => Math.atan2(pts[Math.min(segs, i + 1)][1] - pts[Math.max(0, i - 1)][1], pts[Math.min(segs, i + 1)][0] - pts[Math.max(0, i - 1)][0]);
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    paintStem(img, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], o.stemW * (1 - t0 * 0.7), o.stemW * (1 - t1 * 0.7), o.stem, 0.9, 0.5);
  }
  // attachments along the main stem
  const mainLen = o.reach * o.S;
  for (let d = o.every * 1.5; d < mainLen; d += o.every * (0.8 + rnd() * 0.4)) {
    const t = d / mainLen;
    const fi = t * segs;
    const i = Math.min(segs - 1, Math.floor(fi));
    const f = fi - i;
    out.push({ x: mix(pts[i][0], pts[i + 1][0], f), y: mix(pts[i][1], pts[i + 1][1], f), dir: stemAng(i), t, tip: false, side: out.length % 2 ? 1 : -1 });
  }
  out.push({ x: pts[segs][0], y: pts[segs][1], dir: stemAng(segs), t: 1, tip: true, side: 1 });
  // side twigs
  for (let k = 0; k < o.sides; k++) {
    const t = 0.2 + (k + rnd() * 0.6) / Math.max(1, o.sides) * 0.65;
    const fi = t * segs;
    const i = Math.min(segs - 1, Math.floor(fi));
    const f = fi - i;
    const sx = mix(pts[i][0], pts[i + 1][0], f);
    const sy = mix(pts[i][1], pts[i + 1][1], f);
    const side = k % 2 ? 1 : -1;
    const ang = stemAng(i) + side * mix(o.sideAngle[0], o.sideAngle[1], rnd());
    const len = mix(o.sideLen[0], o.sideLen[1], rnd()) * o.S * (1 - t * 0.4);
    const curve = (rnd() - 0.5) * 0.5 + side * -0.25;
    let px = sx;
    let py = sy;
    let a = ang;
    const n = 5;
    const sl = len / n;
    const sw = o.stemW * (1 - t * 0.7) * 0.7;
    for (let j = 1; j <= n; j++) {
      a += curve / n;
      const nx = px + Math.cos(a) * sl;
      const ny = py + Math.sin(a) * sl;
      paintStem(img, px, py, nx, ny, sw * (1 - (j - 1) / n * 0.6), sw * (1 - j / n * 0.6), o.stem, 0.85, 0.5);
      // attachments along the side twig
      const steps = Math.max(1, Math.round(sl / o.every));
      for (let q = 0; q < steps; q++) {
        const ft = (q + 0.5) / steps;
        out.push({ x: mix(px, nx, ft), y: mix(py, ny, ft), dir: a, t: (j - 1 + ft) / n, tip: false, side: (out.length % 2 ? 1 : -1) });
      }
      px = nx;
      py = ny;
    }
    out.push({ x: px, y: py, dir: a, t: 1, tip: true, side });
  }
  return out;
}

interface LeafJob {
  depth: number;
  paint: (shade: number) => void;
}

function flush(jobs: LeafJob[], minShade = 0.62): void {
  jobs.sort((a, b) => a.depth - b.depth);
  for (const j of jobs) j.paint(minShade + (1 - minShade) * j.depth);
}

// ---------------------------------------------------------------------------
// Broadleaf twig sprites

interface BroadleafOpts {
  shape: Shape;
  len: [number, number];
  aspect: number; // half-width / length
  colA: RGB;
  colB: RGB;
  petiole: number; // px
  /** Leaves in a terminal cluster at each tip. */
  cluster: number;
  /** Leaf angle off the twig (radians). */
  angle: [number, number];
  /** Probability of a leaf at a non-tip attachment. */
  density: number;
  veins: number;
  bend: number;
  stem: RGB;
}

function broadleafJobs(ctx: PaintCtx, att: Attach[], o: BroadleafOpts, jobs: LeafJob[]): void {
  const { img, rnd } = ctx;
  const leafAt = (x: number, y: number, dir: number) => {
    const len = mix(o.len[0], o.len[1], rnd());
    const col = jitterColor(rnd, o.colA, o.colB);
    const bend = (rnd() - 0.5) * o.bend;
    const pl = o.petiole * (0.7 + rnd() * 0.6);
    const bx = x + Math.cos(dir) * pl;
    const by = y + Math.sin(dir) * pl;
    jobs.push({
      depth: rnd(),
      paint: (shade) => {
        if (pl > 1) paintStem(img, x, y, bx, by, 0.9, 0.7, o.stem, shade * 0.9, 0.5);
        paintLeaf(img, { x: bx, y: by, angle: dir, len, halfW: len * o.aspect, shape: o.shape, color: col, shade, midrib: 0.18, veins: o.veins, veinCount: 7, bend });
      },
    });
  };
  for (const a of att) {
    if (a.tip) {
      for (let k = 0; k < o.cluster; k++) {
        const spread = ((k / Math.max(1, o.cluster - 1)) - 0.5) * 2.2 + (rnd() - 0.5) * 0.4;
        leafAt(a.x, a.y, a.dir + spread);
      }
    } else if (rnd() < o.density) {
      leafAt(a.x, a.y, a.dir + a.side * mix(o.angle[0], o.angle[1], rnd()));
    }
  }
}

function cellLoop(img: Img, cols: number, rows: number, seed: number, fn: (ctx: PaintCtx, ox: number, oy: number, S: number, cell: number) => void): void {
  const S = img.w / cols;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const cell = r * cols + c;
      fn({ img, rnd: mulberry32(seed + cell * 977) }, c * S, r * (img.ht / rows), S, cell);
    }
}

function genOak(): Img {
  const img = new Img(512, 512);
  const stem = lin(0x4a3c2e);
  cellLoop(img, 2, 2, 11, (ctx, ox, oy, S) => {
    const att = twig(ctx, { ox, oy, S, stem, stemW: 3.2, reach: 0.62, sides: 4, sideLen: [0.26, 0.4], sideAngle: [0.5, 0.95], every: 15, wobble: 0.25 });
    const jobs: LeafJob[] = [];
    broadleafJobs(ctx, att, { shape: SHAPES.oak, len: [30, 44], aspect: 0.33, colA: lin(0x3c5222), colB: lin(0x67783a), petiole: 3, cluster: 5, angle: [0.5, 1.1], density: 0.7, veins: 0.06, bend: 0.25, stem }, jobs);
    flush(jobs);
  });
  return img;
}

function genBirch(): Img {
  const img = new Img(512, 512);
  const stem = lin(0x3b2c24);
  cellLoop(img, 2, 2, 21, (ctx, ox, oy, S) => {
    const { rnd } = ctx;
    const jobs: LeafJob[] = [];
    // several thin pendulous whips from the root
    const whips = 3 + Math.floor(rnd() * 2);
    for (let w = 0; w < whips; w++) {
      const att = twig(ctx, { ox: ox + (w - (whips - 1) / 2) * S * 0.16, oy, S, stem, stemW: 1.3, reach: 0.78 + rnd() * 0.15, sides: 2, sideLen: [0.15, 0.28], sideAngle: [0.25, 0.5], every: 13, wobble: 0.5 });
      broadleafJobs(ctx, att, { shape: SHAPES.birch, len: [16, 23], aspect: 0.4, colA: lin(0x557428), colB: lin(0x86983a), petiole: 4, cluster: 2, angle: [0.6, 1.2], density: 0.85, veins: 0.05, bend: 0.2, stem }, jobs);
    }
    flush(jobs, 0.7);
  });
  return img;
}

function genBaobab(): Img {
  const img = new Img(512, 512);
  const stem = lin(0x6e6258);
  cellLoop(img, 2, 2, 31, (ctx, ox, oy, S) => {
    const { img: im, rnd } = ctx;
    const att = twig(ctx, { ox, oy, S, stem, stemW: 3.5, reach: 0.5, sides: 3, sideLen: [0.2, 0.32], sideAngle: [0.5, 1.0], every: 22, wobble: 0.3 });
    const jobs: LeafJob[] = [];
    const colA = lin(0x46622a);
    const colB = lin(0x6f8a3a);
    for (const a of att) {
      if (!a.tip && rnd() > 0.45) continue;
      // digitate leaf: petiole then 5–7 radiating leaflets
      const pl = 14 + rnd() * 10;
      const dir = a.dir + (a.tip ? 0 : a.side * (0.6 + rnd() * 0.5));
      const ex = a.x + Math.cos(dir) * pl;
      const ey = a.y + Math.sin(dir) * pl;
      const n = 5 + Math.floor(rnd() * 3);
      const col = jitterColor(rnd, colA, colB);
      const depth = rnd();
      jobs.push({
        depth,
        paint: (shade) => {
          paintStem(im, a.x, a.y, ex, ey, 1.1, 0.8, stem, shade, 0.5);
          for (let k = 0; k < n; k++) {
            const ang = dir + ((k / (n - 1)) - 0.5) * 2.6;
            const len = (24 + rnd() * 10) * (1 - Math.abs(k / (n - 1) - 0.5) * 0.6);
            paintLeaf(im, { x: ex, y: ey, angle: ang, len, halfW: len * 0.27, shape: SHAPES.obovate, color: col, shade: shade * (0.92 + rnd() * 0.16), midrib: 0.15, veins: 0.04, bend: (rnd() - 0.5) * 0.2 });
          }
        },
      });
    }
    flush(jobs);
  });
  return img;
}

function genAcacia(): Img {
  const img = new Img(512, 512);
  const stem = lin(0x3a2c22);
  const thorn = lin(0xd8d2c4);
  cellLoop(img, 2, 2, 41, (ctx, ox, oy, S, cell) => {
    const { img: im, rnd } = ctx;
    const att = twig(ctx, { ox, oy, S, stem, stemW: 2.2, reach: 0.82, sides: 4, sideLen: [0.25, 0.42], sideAngle: [0.6, 1.1], every: 9, wobble: 0.3, zigzag: 0.012 });
    const jobs: LeafJob[] = [];
    const colA = lin(0x4d5a2c);
    const colB = lin(0x77804a);
    const dense = cell === 3 ? 1.0 : 0.85;
    for (const a of att) {
      // paired white thorns at nodes
      if (!a.tip && rnd() < 0.3) {
        for (const s of [-1, 1]) {
          const ang = a.dir + s * (1.0 + rnd() * 0.3);
          const l = 7 + rnd() * 6;
          paintStem(im, a.x, a.y, a.x + Math.cos(ang) * l, a.y + Math.sin(ang) * l, 0.9, 0.3, thorn, 1, 0.6);
        }
      }
      if (rnd() > dense) continue;
      // bipinnate leaf: a short rachis with 3–5 pinna pairs of tiny leaflets
      const n = a.tip ? 3 : 1 + Math.floor(rnd() * 2);
      for (let q = 0; q < n; q++) {
        const dir = a.dir + (a.tip ? (q - (n - 1) / 2) * 0.7 : a.side * (0.5 + rnd() * 0.8)) + (rnd() - 0.5) * 0.3;
        const len = 16 + rnd() * 12;
        const col = jitterColor(rnd, colA, colB, 0.15);
        jobs.push({
          depth: rnd(),
          paint: (shade) => {
            const ex = a.x + Math.cos(dir) * len;
            const ey = a.y + Math.sin(dir) * len;
            paintStem(im, a.x, a.y, ex, ey, 0.55, 0.35, col, shade * 0.8, 0.6);
            const pairs = 4;
            for (let p = 1; p <= pairs; p++) {
              const t = p / (pairs + 0.6);
              const px = mix(a.x, ex, t);
              const py = mix(a.y, ey, t);
              for (const s of [-1, 1]) {
                const pa = dir + s * 1.15;
                const pl = 7 * (1 - t * 0.35);
                paintLeaf(im, { x: px, y: py, angle: pa, len: pl, halfW: 2.0, shape: SHAPES.linear, color: col, shade: shade * (0.9 + rnd() * 0.2), midrib: 0, veins: 0 });
              }
            }
          },
        });
      }
    }
    flush(jobs, 0.6);
  });
  return img;
}

function genPine(): Img {
  const img = new Img(512, 512);
  const stem = lin(0x6b4a32);
  const colA = lin(0x2f4e36);
  const colB = lin(0x587450);
  cellLoop(img, 2, 2, 51, (ctx, ox, oy, S) => {
    const { img: im, rnd } = ctx;
    const att = twig(ctx, { ox, oy, S, stem, stemW: 3, reach: 0.55, sides: 4, sideLen: [0.3, 0.42], sideAngle: [0.6, 1.0], every: 3.4, wobble: 0.2 });
    const jobs: LeafJob[] = [];
    for (const a of att) {
      const count = a.tip ? 16 : 2;
      for (let k = 0; k < count; k++) {
        const ang = a.tip ? a.dir + ((k / (count - 1)) - 0.5) * 2.6 + (rnd() - 0.5) * 0.2 : a.dir + (k ? 1 : -1) * (0.5 + rnd() * 0.6);
        const len = (a.tip ? 26 : 22 + a.t * 8) + rnd() * 10;
        const col = jitterColor(rnd, colA, colB, 0.18);
        jobs.push({
          depth: rnd(),
          paint: (shade) => paintLeaf(im, { x: a.x, y: a.y, angle: ang, len, halfW: 1.25, shape: SHAPES.needle, color: col, shade, midrib: 0, veins: 0, bend: (rnd() - 0.5) * 0.15 }),
        });
      }
    }
    flush(jobs, 0.55);
  });
  return img;
}

function genBamboo(): Img {
  const img = new Img(512, 512);
  const stem = lin(0x6f7a3a);
  cellLoop(img, 2, 2, 61, (ctx, ox, oy, S) => {
    const { img: im, rnd } = ctx;
    const jobs: LeafJob[] = [];
    // 2–3 thin twigs, each ending in a fan of drooping lanceolate leaves
    const twigs = 2 + Math.floor(rnd() * 2);
    for (let w = 0; w < twigs; w++) {
      const ang = PI / 2 + (w - (twigs - 1) / 2) * 0.45 + (rnd() - 0.5) * 0.2;
      const len = S * (0.25 + rnd() * 0.2);
      const x0 = ox + S / 2;
      const y0 = oy + 3;
      const ex = x0 + Math.cos(ang) * len;
      const ey = y0 + Math.sin(ang) * len;
      paintStem(im, x0, y0, ex, ey, 1.6, 1.0, stem, 0.9, 0.5);
      const leaves = 4 + Math.floor(rnd() * 4);
      for (let k = 0; k < leaves; k++) {
        const t = 0.35 + (k / leaves) * 0.65;
        const px = mix(x0, ex, t);
        const py = mix(y0, ey, t);
        const side = k % 2 ? 1 : -1;
        const la = ang + side * (0.35 + rnd() * 0.7);
        const ll = 70 + rnd() * 45;
        const col = jitterColor(rnd, lin(0x4f6e26), lin(0x88993f), 0.12);
        jobs.push({
          depth: rnd(),
          paint: (shade) => paintLeaf(im, { x: px, y: py, angle: la, len: ll, halfW: ll * 0.11, shape: SHAPES.lanceolate, color: col, shade, midrib: 0.12, veins: 0.03, veinCount: 3, bend: side * (0.18 + rnd() * 0.15) }),
        });
      }
    }
    flush(jobs, 0.65);
  });
  return img;
}

// ---------------------------------------------------------------------------
// Fronds (strip sprites: rachis along the cell's vertical centre line)

function genPalm(): Img {
  const img = new Img(256, 1024);
  const rach = [lin(0x9a9468), lin(0x8a6c48)];
  const green: [RGB, RGB] = [lin(0x56664a), lin(0x7c8a60)];
  const dry: [RGB, RGB] = [lin(0x7a5c3c), lin(0x9c8058)];
  for (let col = 0; col < 2; col++) {
    const rnd = mulberry32(71 + col);
    const cx = col * 128 + 64;
    const H = img.ht;
    const [ca, cb] = col === 0 ? green : dry;
    const jobs: LeafJob[] = [];
    // leaflets in irregular groups along the rachis, both sides
    for (let y = 30; y < H - 8; y += 5 + rnd() * 5) {
      const t = y / H;
      for (const s of [-1, 1]) {
        if (rnd() < 0.15) continue;
        const spine = t < 0.13;
        const maxL = spine ? 26 + t * 160 : 115 * Math.pow(Math.sin(PI * Math.min(1, (t - 0.05) / 0.98)), 0.6);
        const len = maxL * (0.85 + rnd() * 0.25);
        const fwd = (spine ? 0.5 : 0.62) + rnd() * 0.18; // angle forward from the rachis
        const ang = PI / 2 - s * (PI / 2 - fwd);
        const c = spine ? lin(0xa89a70) : jitterColor(rnd, ca, cb, 0.12);
        const yy = y;
        jobs.push({
          depth: rnd(),
          paint: (shade) =>
            paintLeaf(img, { x: cx + s * 1.5, y: yy, angle: ang, len, halfW: spine ? 1.3 : 3.6, shape: spine ? SHAPES.needle : SHAPES.linear, color: c, shade, midrib: 0.2, veins: 0, bend: -s * 0.05 }),
        });
      }
    }
    flush(jobs, 0.72);
    // rachis on top
    paintStem(img, cx, 0, cx, H * 0.995, 4.2, 1.2, rach[col], 1, 1);
  }
  return img;
}

function genFern(): Img {
  const img = new Img(256, 512);
  for (let col = 0; col < 2; col++) {
    const rnd = mulberry32(81 + col);
    const cx = col * 128 + 64;
    const H = img.ht;
    const ca = col === 0 ? lin(0x40661e) : lin(0x4a6a24);
    const cb = col === 0 ? lin(0x6a8f2c) : lin(0x7a9634);
    const jobs: LeafJob[] = [];
    const stipe = 0.14; // bare stalk fraction
    let k = 0;
    for (let y = H * stipe; y < H - 4; y += 10 + (1 - y / H) * 6, k++) {
      const t = (y - H * stipe) / (H * (1 - stipe));
      for (const s of [-1, 1]) {
        const off = s > 0 ? 4 : 0; // sub-opposite pinnae
        const len = 58 * Math.pow(Math.sin(PI * Math.min(1, 0.12 + t * 0.88)), 0.8) * (col === 0 ? 1 : 0.8) * (0.92 + rnd() * 0.12);
        if (len < 4) continue;
        const ang = PI / 2 - s * (PI / 2 - (0.28 + t * 0.35));
        const c = jitterColor(rnd, ca, cb, 0.1);
        const yy = y + off;
        jobs.push({
          depth: 0.5 + rnd() * 0.5,
          paint: (shade) => {
            // pinna: lanceolate with deep pinnule lobes
            const lobes = Math.max(4, Math.round(len / 6));
            const shape: Shape = (tt) => SHAPES.lanceolate(tt) * (0.55 + 0.45 * Math.pow(Math.abs(Math.cos(PI * lobes * tt)), 0.6));
            paintLeaf(img, { x: cx, y: yy, angle: ang, len, halfW: Math.min(9, len * 0.2), shape, color: c, shade, midrib: 0.25, veins: 0 });
          },
        });
      }
    }
    flush(jobs, 0.8);
    paintStem(img, cx, 0, cx, H * 0.99, 2.6, 0.7, lin(0x5a6a2a), 1, 1);
  }
  return img;
}

// ---------------------------------------------------------------------------
// Grasses / reeds (tussock sprites, root at v = 0 centre)

function genGrass(): Img {
  const img = new Img(512, 512);
  const palettes: [RGB, RGB, RGB][] = [
    [lin(0x6a6838), lin(0xb39a5e), lin(0xd2bc84)], // golden savanna
    [lin(0x3e5a22), lin(0x6c8838), lin(0x9aa65a)], // green meadow
  ];
  for (let col = 0; col < 2; col++) {
    const rnd = mulberry32(91 + col);
    const [base, mid, tip] = palettes[col];
    const ox = col * 256;
    const H = img.ht;
    const blades = 95;
    const order: { depth: number; f: (s: number) => void }[] = [];
    for (let b = 0; b < blades; b++) {
      const x0 = ox + 128 + (rnd() - 0.5) * 60;
      const lean = (rnd() - 0.5) * 2;
      const len = H * (0.5 + rnd() * 0.45);
      const x2 = x0 + lean * 105 + (rnd() - 0.5) * 30;
      const y2 = len * (0.88 - Math.abs(lean) * 0.25);
      const x1 = mix(x0, x2, 0.35) + lean * 22;
      const y1 = y2 * 0.75;
      const w = 1.6 + rnd() * 1.6;
      const t = rnd();
      const c: RGB = [mix(mid[0], tip[0], t), mix(mid[1], tip[1], t), mix(mid[2], tip[2], t)];
      order.push({
        depth: rnd(),
        f: (s) => {
          // dark base fading into the blade colour
          paintCurve(img, [x0, 0], [x1, y1], [x2, y2], w, 0.35, c, s, 10);
          paintCurve(img, [x0, 0], [mix(x0, x1, 0.4), y1 * 0.3], [mix(x0, x2, 0.25), y2 * 0.22], w * 1.05, w * 0.9, base, s * 0.85, 4);
        },
      });
    }
    // seed heads
    const heads = col === 0 ? 14 : 8;
    for (let h = 0; h < heads; h++) {
      const x0 = ox + 128 + (rnd() - 0.5) * 40;
      const lean = (rnd() - 0.5) * 1.2;
      const top = H * (0.82 + rnd() * 0.16);
      const x2 = x0 + lean * 70;
      order.push({
        depth: 0.4 + rnd() * 0.6,
        f: (s) => {
          paintCurve(img, [x0, 0], [mix(x0, x2, 0.4), top * 0.6], [x2, top], 1.0, 0.6, mid, s, 8);
          // panicle: spikelets along the top 25%
          for (let q = 0; q < 22; q++) {
            const tt = 0.72 + (q / 22) * 0.28;
            const px = mix(x0, x2, tt * tt) + (rnd() - 0.5) * 6;
            const py = top * tt;
            const ang = PI / 2 + lean * 0.4 + (rnd() - 0.5) * 1.4;
            paintLeaf(img, { x: px, y: py, angle: ang, len: 7 + rnd() * 6, halfW: 1.6, shape: SHAPES.elliptic, color: tip, shade: s * (0.9 + rnd() * 0.2), midrib: 0, veins: 0 });
          }
        },
      });
    }
    order.sort((a, b) => a.depth - b.depth);
    for (const o of order) o.f(0.6 + 0.4 * o.depth);
  }
  return img;
}

function genReed(): Img {
  const img = new Img(512, 512);
  for (let col = 0; col < 2; col++) {
    const rnd = mulberry32(101 + col);
    const ox = col * 256;
    const H = img.ht;
    const ca = lin(0x52652e);
    const cb = lin(0x7e8a48);
    const dead = lin(0xa08a5a);
    const order: { depth: number; f: (s: number) => void }[] = [];
    for (let b = 0; b < 34; b++) {
      const x0 = ox + 128 + (rnd() - 0.5) * 70;
      const lean = (rnd() - 0.5) * 0.9;
      const len = H * (0.65 + rnd() * 0.33);
      const flop = rnd() < 0.2;
      const x2 = x0 + lean * 90 + (flop ? (lean > 0 ? 50 : -50) : 0);
      const y2 = len * (flop ? 0.7 : 0.97);
      const x1 = mix(x0, x2, 0.2);
      const y1 = y2 * (flop ? 0.85 : 0.6);
      const w = 3.2 + rnd() * 2.2;
      const c = jitterColor(rnd, ca, cb, 0.1);
      const tipDead = rnd() < 0.5;
      order.push({
        depth: rnd(),
        f: (s) => {
          paintCurve(img, [x0, 0], [x1, y1], [x2, y2], w, 0.6, c, s, 12);
          if (tipDead) {
            // withered tip
            const t0 = 0.8;
            const a = (1 - t0) * (1 - t0);
            const bq = 2 * (1 - t0) * t0;
            const cq = t0 * t0;
            const sx = a * x0 + bq * x1 + cq * x2;
            const sy = bq * y1 + cq * y2;
            paintStem(img, sx, sy, x2, y2, w * 0.35, 0.5, dead, s, 0.8);
          }
        },
      });
    }
    order.sort((a, b) => a.depth - b.depth);
    for (const o of order) o.f(0.62 + 0.38 * o.depth);
  }
  return img;
}

// ---------------------------------------------------------------------------
// Flowering bedding plants (2 × 2 cells)

function genFlowers(): Img {
  const img = new Img(512, 512);
  const leafA = lin(0x31501e);
  const leafB = lin(0x56782c);
  cellLoop(img, 2, 2, 111, (ctx, ox, oy, S, cell) => {
    const { img: im, rnd } = ctx;
    const cx = ox + S / 2;
    const jobs: LeafJob[] = [];
    // foliage mound
    for (let k = 0; k < 26; k++) {
      const ang = PI / 2 + (rnd() - 0.5) * 2.6;
      const len = S * (cell === 1 ? 0.2 : 0.24) * (0.7 + rnd() * 0.5);
      const col = jitterColor(rnd, leafA, leafB);
      const shape = cell === 0 ? SHAPES.elliptic : cell === 2 ? SHAPES.lanceolate : SHAPES.ovate;
      const x0 = cx + (rnd() - 0.5) * S * 0.25;
      jobs.push({ depth: rnd() * 0.5, paint: (s) => paintLeaf(im, { x: x0, y: oy + 4, angle: ang, len, halfW: len * (cell === 2 ? 0.16 : 0.42), shape, color: col, shade: s, midrib: 0.15, veins: 0.05 }) });
    }
    flush(jobs, 0.55);
    jobs.length = 0;
    const flowers = cell === 2 ? 7 : 11;
    for (let k = 0; k < flowers; k++) {
      const fx = cx + (rnd() - 0.5) * S * 0.7;
      const fy = oy + S * (0.42 + rnd() * 0.45);
      const stemC = lin(0x48662a);
      const depth = rnd();
      jobs.push({
        depth,
        paint: (s) => {
          paintCurve(im, [cx + (fx - cx) * 0.3, oy + 4], [mix(cx, fx, 0.7), mix(oy, fy, 0.5)], [fx, fy], 1.4, 1.0, stemC, s, 5);
          if (cell === 0) {
            // geranium-like umbel of small scarlet flowers
            const red = jitterColor(rnd, lin(0xb3201c), lin(0xd8412e), 0.1);
            for (let q = 0; q < 9; q++) {
              const a = rnd() * PI * 2;
              const rr = rnd() * 11;
              const px = fx + Math.cos(a) * rr;
              const py = fy + Math.sin(a) * rr * 0.8;
              for (let p = 0; p < 5; p++) {
                const pa = (p / 5) * PI * 2 + rnd();
                paintLeaf(im, { x: px, y: py, angle: pa, len: 5.5, halfW: 2.6, shape: SHAPES.obovate, color: red, shade: s * (0.85 + rnd() * 0.25), midrib: 0, veins: 0 });
              }
            }
          } else if (cell === 1) {
            // marigold: ruffled orange-yellow double flower
            const c = rnd() < 0.5 ? lin(0xe0a018) : lin(0xd0701a);
            for (let ring = 0; ring < 3; ring++) {
              const n = 14 - ring * 3;
              for (let p = 0; p < n; p++) {
                const pa = (p / n) * PI * 2 + ring * 0.4;
                paintLeaf(im, { x: fx, y: fy, angle: pa, len: 14 - ring * 4, halfW: 4, shape: SHAPES.obovate, color: c, shade: s * (0.8 + ring * 0.12), midrib: 0, veins: 0 });
              }
            }
            paintDisc(im, fx, fy, 3, lin(0x8a4a10), s);
          } else if (cell === 2) {
            // salvia / lavender spike
            const c = rnd() < 0.5 ? lin(0x5a3c9c) : lin(0x6e4ab0);
            for (let q = 0; q < 16; q++) {
              const t = q / 16;
              const px = fx + (rnd() - 0.5) * 5;
              const py = fy + t * S * 0.22;
              paintDisc(im, px, py, 3.4 * (1 - t * 0.5), c, s * (0.8 + rnd() * 0.3));
            }
          } else {
            // daisy: white ray petals, yellow disc
            const n = 16;
            const w = lin(0xe8e6dc);
            for (let p = 0; p < n; p++) {
              const pa = (p / n) * PI * 2 + rnd() * 0.1;
              paintLeaf(im, { x: fx, y: fy, angle: pa, len: 14, halfW: 2.4, shape: SHAPES.linear, color: w, shade: s * (0.85 + rnd() * 0.2), midrib: 0, veins: 0 });
            }
            paintDisc(im, fx, fy, 4.5, lin(0xd8a820), s);
          }
        },
      });
    }
    flush(jobs, 0.75);
  });
  return img;
}

// ---------------------------------------------------------------------------
// Public

const GEN: Record<AtlasKind, { gen: () => Img; cols: number; rows: number }> = {
  oak: { gen: genOak, cols: 2, rows: 2 },
  acacia: { gen: genAcacia, cols: 2, rows: 2 },
  baobab: { gen: genBaobab, cols: 2, rows: 2 },
  pine: { gen: genPine, cols: 2, rows: 2 },
  birch: { gen: genBirch, cols: 2, rows: 2 },
  bamboo: { gen: genBamboo, cols: 2, rows: 2 },
  palm: { gen: genPalm, cols: 2, rows: 1 },
  fern: { gen: genFern, cols: 2, rows: 1 },
  grass: { gen: genGrass, cols: 2, rows: 1 },
  reed: { gen: genReed, cols: 2, rows: 1 },
  flowers: { gen: genFlowers, cols: 2, rows: 2 },
};

export type SheetKind = 'trees' | 'ground';

/** Sheet layouts: pixel offset of each atlas (sizes come from its generator). */
const SHEETS: Record<SheetKind, { w: number; h: number; slots: Partial<Record<AtlasKind, [number, number]>> }> = {
  trees: {
    w: 2048,
    h: 1024,
    slots: { oak: [0, 0], birch: [0, 512], acacia: [512, 0], bamboo: [512, 512], baobab: [1024, 0], pine: [1024, 512], palm: [1536, 0] },
  },
  ground: { w: 1024, h: 1024, slots: { grass: [0, 0], reed: [512, 0], flowers: [0, 512], fern: [512, 512] } },
};

const SHEET_OF: Record<AtlasKind, SheetKind> = {
  oak: 'trees',
  acacia: 'trees',
  baobab: 'trees',
  pine: 'trees',
  birch: 'trees',
  bamboo: 'trees',
  palm: 'trees',
  grass: 'ground',
  reed: 'ground',
  flowers: 'ground',
  fern: 'ground',
};

type Mip = { data: Uint8Array; width: number; height: number };

/** Paint one atlas: its coverage-preserving mip chain (pure; also run in a worker). */
export function paintAtlas(kind: AtlasKind): Mip[] {
  const t = foliageTexture(GEN[kind].gen(), 0.5, false);
  const m = t.mipmaps as Mip[];
  t.dispose();
  return m;
}

// Per-atlas mip chains awaiting composition into their sheet (painted ahead
// by paintAtlasesOffThread / the prewarm steps, or on first use).
const pendingMips = new Map<AtlasKind, Mip[]>();

function atlasMips(kind: AtlasKind): Mip[] {
  let m = pendingMips.get(kind);
  if (!m) {
    m = paintAtlas(kind);
    pendingMips.set(kind, m);
  }
  return m;
}

/**
 * Paint the atlases of every sheet not built yet in a web worker, so the
 * loading screen's main thread only composes the sheets (painting is ~0.2–0.4 s
 * per atlas on a desktop, several times that on a phone). Resolves once all
 * are back; without worker support (or on a worker error) it resolves early
 * and the rest are painted on the main thread when first needed.
 */
export function paintAtlasesOffThread(onProgress?: (fraction: number) => void): Promise<void> {
  const kinds: AtlasKind[] = [];
  for (const sk of Object.keys(SHEETS) as SheetKind[]) {
    if (hasCachedTexture(sheetKey(sk))) continue;
    for (const k of Object.keys(SHEETS[sk].slots) as AtlasKind[]) if (!pendingMips.has(k)) kinds.push(k);
  }
  if (kinds.length === 0 || typeof Worker === 'undefined') return Promise.resolve();
  let worker: Worker;
  try {
    worker = new Worker(new URL('./atlasworker.ts', import.meta.url), { type: 'module' });
  } catch {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let done = 0;
    const finish = () => {
      worker.terminate();
      resolve();
    };
    worker.onmessage = (e: MessageEvent<{ kind: AtlasKind; mips: Mip[] }>) => {
      if (!pendingMips.has(e.data.kind)) pendingMips.set(e.data.kind, e.data.mips);
      onProgress?.(++done / kinds.length);
      if (done === kinds.length) finish();
    };
    worker.onerror = (e) => {
      e.preventDefault();
      console.warn('[props] foliage worker failed; painting on the main thread', e.message);
      finish();
    };
    for (const k of kinds) worker.postMessage(k);
  });
}

/** Compose a sheet's mip chain from its atlases' chains (levels they lack are box-filtered). */
function composeSheet(sk: SheetKind): Mip[] {
  const sh = SHEETS[sk];
  const levels: Mip[] = [];
  for (let w = sh.w, h = sh.h; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    levels.push({ data: new Uint8Array(w * h * 4), width: w, height: h });
    if (w === 1 && h === 1) break;
  }
  const filled = new Array<boolean>(levels.length).fill(true);
  for (const k of Object.keys(sh.slots) as AtlasKind[]) {
    const [ox, oy] = sh.slots[k]!;
    const mips = atlasMips(k);
    const [aw, ah] = GEN_SIZE[k];
    for (let L = 0; L < levels.length; L++) {
      const m = mips[L];
      const dst = levels[L];
      const sx = ox >> L;
      const sy = oy >> L;
      // the atlas no longer maps to whole texels of the sheet at this level
      if (!m || aw >> L === 0 || ah >> L === 0) {
        filled[L] = false;
        continue;
      }
      for (let y = 0; y < m.height && sy + y < dst.height; y++) {
        const w = Math.min(m.width, dst.width - sx);
        dst.data.set(m.data.subarray(y * m.width * 4, (y * m.width + w) * 4), ((sy + y) * dst.width + sx) * 4);
      }
    }
    pendingMips.delete(k);
  }
  // coarsest levels some atlas could not supply: 2×2 box filter of the level above
  for (let L = 1; L < levels.length; L++) {
    if (filled[L]) continue;
    const a = levels[L - 1];
    const b = levels[L];
    for (let y = 0; y < b.height; y++)
      for (let x = 0; x < b.width; x++)
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) sum += a.data[(Math.min(a.height - 1, y * 2 + dy) * a.width + Math.min(a.width - 1, x * 2 + dx)) * 4 + c];
          b.data[(y * b.width + x) * 4 + c] = sum >> 2;
        }
  }
  return levels;
}

function mipTexture(mips: Mip[]): THREE.DataTexture {
  const t = new THREE.DataTexture(mips[0].data, mips[0].width, mips[0].height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4;
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.mipmaps = mips;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * A mip-chain texture whose pixels stay in JS memory only until three has
 * uploaded them (a sheet's chain is ≈ 11 MB). Should three need them again
 * (lost context restored, …) they are generated anew by `make`.
 */
function uploadOnceTexture(make: () => Mip[]): THREE.DataTexture {
  let chain: Mip[] | null = make();
  const level = (L: number): Uint8Array => (chain ??= make())[L].data;
  const mips = chain.map((m, L) => ({ width: m.width, height: m.height, get data() { return level(L); } }));
  const t = mipTexture(mips);
  t.image = { width: mips[0].width, height: mips[0].height, get data() { return level(0); } };
  t.onUpdate = () => {
    chain = null;
  };
  return t;
}

function sheetKey(sk: SheetKind): string {
  return texLow() ? `sheet-${sk}@lo` : `sheet-${sk}`;
}

function sheetTexture(sk: SheetKind): THREE.DataTexture {
  const low = texLow();
  return cachedTexture(sheetKey(sk), () =>
    uploadOnceTexture(() => {
      const mips = composeSheet(sk);
      // low tier: half resolution, same layout (the chain without its top level)
      return low ? mips.slice(1) : mips;
    }),
  );
}

/**
 * Loading-screen steps: paint each atlas of a sheet, then build the sheet
 * texture (run them at the tier that will use the sheets, see withQuality).
 */
export function atlasSteps(): (() => void)[] {
  const steps: (() => void)[] = [];
  for (const sk of Object.keys(SHEETS) as SheetKind[]) {
    for (const k of Object.keys(SHEETS[sk].slots) as AtlasKind[]) steps.push(() => void (hasCachedTexture(sheetKey(sk)) || atlasMips(k)));
    steps.push(() => void sheetTexture(sk));
  }
  return steps;
}

/** Atlas of a species: its sheet texture and its rect in the sheet. */
export function atlas(kind: AtlasKind): AtlasInfo {
  const g = GEN[kind];
  const sk = SHEET_OF[kind];
  const tex = sheetTexture(sk);
  const sh = SHEETS[sk];
  const [ox, oy] = sh.slots[kind]!;
  const [w, h] = GEN_SIZE[kind];
  return { tex, cols: g.cols, rows: g.rows, rect: [ox / sh.w, oy / sh.h, (ox + w) / sh.w, (oy + h) / sh.h], sheet: sk };
}

/** Shared foliage material of a sheet (all species on it batch together). */
export function leafMaterial(sk: SheetKind): FoliageMaterial {
  return foliageMaterial(`sheet-${sk}`, sheetTexture(sk), LEAF_PARAMS[sk]);
}

/** Generator image sizes (px), for rects before / without painting. */
const GEN_SIZE: Record<AtlasKind, [number, number]> = {
  oak: [512, 512],
  acacia: [512, 512],
  baobab: [512, 512],
  pine: [512, 512],
  birch: [512, 512],
  bamboo: [512, 512],
  palm: [256, 1024],
  fern: [256, 512],
  grass: [512, 512],
  reed: [512, 512],
  flowers: [512, 512],
};

// ---------------------------------------------------------------------------
// Tileable surfaces: clipped box hedge and bed soil

function genHedge(): Img {
  const S = 256;
  const img = new Img(S, S, 1);
  const deep = lin(0x18240f);
  for (let i = 0; i < S * S; i++) {
    const x = i % S;
    const y = (i / S) | 0;
    const n = pfbm(x / S, y / S, 6, 6, 3, 121);
    img.set(i, deep[0] * (1 + n * 0.3), deep[1] * (1 + n * 0.3), deep[2], 1);
    img.h[i] = 0;
  }
  const rnd = mulberry32(122);
  const a = lin(0x3b5a22);
  const b = lin(0x6e8a38);
  const N = 2600;
  const leaves: { d: number; x: number; y: number; ang: number; len: number; col: RGB }[] = [];
  for (let k = 0; k < N; k++) {
    leaves.push({ d: rnd(), x: rnd() * S, y: rnd() * S, ang: rnd() * PI * 2, len: 8 + rnd() * 5, col: jitterColor(rnd, a, b, 0.15) });
  }
  leaves.sort((p, q) => p.d - q.d);
  for (const L of leaves) {
    paintLeaf(img, { x: L.x, y: L.y, angle: L.ang, len: L.len, halfW: L.len * 0.36, shape: SHAPES.elliptic, color: L.col, shade: 0.55 + 0.5 * L.d, midrib: 0.12, veins: 0, height: 0.3 + 0.7 * L.d, wrap: true });
  }
  return img;
}

function genSoil(): Img {
  const S = 256;
  const img = new Img(S, S, 1);
  const soil = lin(0x3a2a1e);
  const dry = lin(0x5a4636);
  for (let i = 0; i < S * S; i++) {
    const u = (i % S) / S;
    const v = ((i / S) | 0) / S;
    const n = pfbm(u, v, 4, 4, 4, 131);
    const clod = sat(pfbm(u, v, 24, 24, 2, 132) * 1.4);
    const t = sat(0.35 + n * 0.6 + clod * 0.3);
    const l = 0.85 + clod * 0.3;
    img.set(i, mix(soil[0], dry[0], t) * l, mix(soil[1], dry[1], t) * l, mix(soil[2], dry[2], t) * l, 1);
    img.h[i] = 0.4 + clod * 0.4 + n * 0.1;
  }
  // bark-mulch chips and small pebbles
  const rnd = mulberry32(133);
  const chip = lin(0x6a4a30);
  const peb = lin(0x7a7268);
  for (let k = 0; k < 260; k++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const ang = rnd() * PI;
    const len = 4 + rnd() * 9;
    if (rnd() < 0.8) paintLeaf(img, { x, y, angle: ang, len, halfW: 1.5 + rnd() * 1.5, shape: SHAPES.elliptic, color: jitterColor(rnd, chip, chip, 0.3), shade: 0.8 + rnd() * 0.3, midrib: 0, veins: 0, height: 0.9, wrap: true });
    else paintDisc(img, x, y, 1.2 + rnd() * 1.5, peb, 0.9 + rnd() * 0.2, 1);
  }
  return img;
}

/** Hedge leaf mat (albedo + normal), tile 0.45 m. */
export function hedgeTextures(): { map: THREE.DataTexture; normal: THREE.DataTexture } {
  const map = cachedTexture('hedge-map', () => {
    const img = genHedge();
    cachedTexture('hedge-normal', () => normalTexture(img, 2.2));
    return albedoTexture(img);
  });
  const normal = cachedTexture('hedge-normal', () => normalTexture(genHedge(), 2.2));
  return { map, normal };
}

/** Bed soil (albedo + normal), tile 0.8 m. */
export function soilTextures(): { map: THREE.DataTexture; normal: THREE.DataTexture } {
  const map = cachedTexture('soil-map', () => {
    const img = genSoil();
    cachedTexture('soil-normal', () => normalTexture(img, 1.5));
    return albedoTexture(img);
  });
  const normal = cachedTexture('soil-normal', () => normalTexture(genSoil(), 1.5));
  return { map, normal };
}
