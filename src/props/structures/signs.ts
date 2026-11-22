// Canvas-painted atlases for built props:
//  - SIGN atlas (1024²): entrance arch board "WILDHAVEN ZOO", kiosk fascia signs
//    (SNACKS / DRINKS / ICE CREAM / GIFTS / RESTROOMS / TICKETS), snack menu,
//    ice-cream flavour board, donation sign, three animal-facts info panels,
//    restroom door plates and the zoo roundel logo.
//  - INTERIOR atlas (512²): what is seen through windows / hatches (kiosk
//    kitchen, drinks fridge, gift-shop shelves, ticket booth, frosted glass).
//    Used as emissiveMap too, so it glows at night.
//
// Original branding only. Painted once, lazily (needs a DOM / OffscreenCanvas).

import * as THREE from 'three';
import { Rng } from '../../core/rng';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: Ctx } {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return { canvas: c, ctx: c.getContext('2d')! };
  }
  const c = new OffscreenCanvas(w, h);
  return { canvas: c, ctx: c.getContext('2d')! };
}

const SANS = '"Roboto Condensed", "Inter", "Roboto", "Helvetica Neue", "DejaVu Sans", Arial, sans-serif';
const SERIF = '"Noto Serif", "DejaVu Serif", Georgia, "Times New Roman", serif';

const GREEN = '#26392f';
const GREEN_D = '#1b2a22';
const CREAM = '#ece2c6';
const OCHRE = '#c08a3e';
const BROWN = '#4a3322';

export interface UVRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Atlas layout (pixels, y down)

const SIGN_SIZE = 1024;
const SIGN_REGIONS = {
  arch: { x: 0, y: 0, w: 1024, h: 176 },
  snacks: { x: 0, y: 176, w: 512, h: 128 },
  drinks: { x: 512, y: 176, w: 512, h: 128 },
  icecream: { x: 0, y: 304, w: 512, h: 128 },
  gifts: { x: 512, y: 304, w: 512, h: 128 },
  restrooms: { x: 0, y: 432, w: 512, h: 128 },
  tickets: { x: 512, y: 432, w: 512, h: 128 },
  info0: { x: 0, y: 560, w: 336, h: 224 },
  info1: { x: 336, y: 560, w: 336, h: 224 },
  info2: { x: 672, y: 560, w: 336, h: 224 },
  menu: { x: 0, y: 784, w: 240, h: 240 },
  flavours: { x: 240, y: 784, w: 240, h: 240 },
  donate: { x: 480, y: 784, w: 240, h: 240 },
  logo: { x: 720, y: 784, w: 240, h: 240 },
  men: { x: 960, y: 784, w: 64, h: 64 },
  women: { x: 960, y: 848, w: 64, h: 64 },
  note: { x: 960, y: 912, w: 64, h: 32 },
  swRed: { x: 992, y: 1008, w: 8, h: 8 },
  swYellow: { x: 1000, y: 1008, w: 8, h: 8 },
  swBlue: { x: 1008, y: 1008, w: 8, h: 8 },
  swWhite: { x: 1016, y: 1008, w: 8, h: 8 },
  swBrown: { x: 992, y: 1000, w: 8, h: 8 },
  swBeige: { x: 1000, y: 1000, w: 8, h: 8 },
  swGrey: { x: 1008, y: 1000, w: 8, h: 8 },
  open: { x: 960, y: 944, w: 64, h: 48 },
} satisfies Record<string, Region>;

export type SignKey = keyof typeof SIGN_REGIONS;

const INT_SIZE = 512;
const INT_REGIONS = {
  kitchen: { x: 0, y: 0, w: 256, h: 160 },
  fridge: { x: 256, y: 0, w: 128, h: 256 },
  booth: { x: 384, y: 0, w: 128, h: 128 },
  frosted: { x: 384, y: 128, w: 128, h: 128 },
  gift: { x: 0, y: 160, w: 256, h: 192 },
  door: { x: 256, y: 256, w: 128, h: 256 },
  dark: { x: 384, y: 256, w: 128, h: 128 },
  glow: { x: 384, y: 384, w: 64, h: 64 },
  swatch: { x: 448, y: 384, w: 64, h: 64 },
} satisfies Record<string, Region>;

export type InteriorKey = keyof typeof INT_REGIONS;

function uvOf(r: Region, size: number, inset = 1): UVRect {
  // canvas textures use flipY = true: v = 1 at the top row
  return {
    u0: (r.x + inset) / size,
    u1: (r.x + r.w - inset) / size,
    v0: 1 - (r.y + r.h - inset) / size,
    v1: 1 - (r.y + inset) / size,
  };
}

export function signUV(k: SignKey): UVRect {
  return uvOf(SIGN_REGIONS[k], SIGN_SIZE);
}
export function interiorUV(k: InteriorKey): UVRect {
  return uvOf(INT_REGIONS[k], INT_SIZE);
}
/** Pixel aspect (w / h) of a sign region. */
export function signAspect(k: SignKey): number {
  const r = SIGN_REGIONS[k];
  return r.w / r.h;
}

// ---------------------------------------------------------------------------
// Painting helpers

function roundRect(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

/** Subtle painted-surface noise / grain over a region. */
function grain(g: Ctx, r: Region, seed: number, alpha: number, lines = true): void {
  const rng = new Rng(seed);
  g.save();
  g.beginPath();
  g.rect(r.x, r.y, r.w, r.h);
  g.clip();
  const n = Math.floor((r.w * r.h) / 60);
  for (let i = 0; i < n; i++) {
    const v = rng.float();
    g.fillStyle = v > 0.5 ? `rgba(255,255,255,${alpha * rng.float()})` : `rgba(0,0,0,${alpha * rng.float()})`;
    g.fillRect(r.x + rng.float() * r.w, r.y + rng.float() * r.h, 1 + rng.float() * 2, 1);
  }
  if (lines) {
    for (let i = 0; i < r.h / 3; i++) {
      const y = r.y + rng.float() * r.h;
      g.strokeStyle = `rgba(0,0,0,${alpha * 0.8 * rng.float()})`;
      g.lineWidth = 0.5 + rng.float();
      g.beginPath();
      g.moveTo(r.x, y);
      g.bezierCurveTo(r.x + r.w * 0.3, y + rng.range(-2, 2), r.x + r.w * 0.7, y + rng.range(-2, 2), r.x + r.w, y + rng.range(-1.5, 1.5));
      g.stroke();
    }
  }
  g.restore();
}

function setLetterSpacing(g: Ctx, px: number): void {
  const anyG = g as unknown as { letterSpacing?: string };
  if ('letterSpacing' in anyG) anyG.letterSpacing = `${px}px`;
}

/** Draw text centred at (cx, cy), shrinking the font to fit maxW. */
function fitText(g: Ctx, text: string, cx: number, cy: number, maxW: number, px: number, font: string, weight = '700', spacing = 0): number {
  let size = px;
  setLetterSpacing(g, spacing * size);
  g.font = `${weight} ${size}px ${font}`;
  let w = g.measureText(text).width;
  while (w > maxW && size > 8) {
    size -= 1;
    setLetterSpacing(g, spacing * size);
    g.font = `${weight} ${size}px ${font}`;
    w = g.measureText(text).width;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, cx + (spacing * size) / 2, cy);
  setLetterSpacing(g, 0);
  return w;
}

/** Painted sign board: dark green field, cream pin-stripe border. */
function boardBase(g: Ctx, r: Region, seed: number, bg = GREEN): void {
  g.fillStyle = BROWN;
  g.fillRect(r.x, r.y, r.w, r.h);
  const p = Math.round(Math.min(r.w, r.h) * 0.06);
  g.fillStyle = bg;
  roundRect(g, r.x + p * 0.5, r.y + p * 0.5, r.w - p, r.h - p, p * 0.6);
  g.fill();
  grain(g, r, seed, 0.05);
  g.strokeStyle = CREAM;
  g.globalAlpha = 0.85;
  g.lineWidth = Math.max(1.5, p * 0.18);
  roundRect(g, r.x + p * 1.1, r.y + p * 1.1, r.w - p * 2.2, r.h - p * 2.2, p * 0.4);
  g.stroke();
  g.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Pictograms (drawn in the current fillStyle / strokeStyle)

function person(g: Ctx, cx: number, top: number, h: number, female: boolean): void {
  const s = h / 100;
  g.beginPath();
  g.arc(cx, top + 9 * s, 9 * s, 0, Math.PI * 2);
  g.fill();
  if (female) {
    g.beginPath();
    g.moveTo(cx - 8 * s, top + 22 * s);
    g.lineTo(cx + 8 * s, top + 22 * s);
    g.lineTo(cx + 19 * s, top + 64 * s);
    g.lineTo(cx - 19 * s, top + 64 * s);
    g.closePath();
    g.fill();
    g.fillRect(cx - 9 * s, top + 64 * s, 6 * s, 36 * s);
    g.fillRect(cx + 3 * s, top + 64 * s, 6 * s, 36 * s);
    // arms
    roundRect(g, cx - 22 * s, top + 24 * s, 6 * s, 30 * s, 3 * s);
    g.fill();
    roundRect(g, cx + 16 * s, top + 24 * s, 6 * s, 30 * s, 3 * s);
    g.fill();
  } else {
    roundRect(g, cx - 13 * s, top + 21 * s, 26 * s, 42 * s, 5 * s);
    g.fill();
    roundRect(g, cx - 12 * s, top + 55 * s, 10 * s, 45 * s, 3 * s);
    g.fill();
    roundRect(g, cx + 2 * s, top + 55 * s, 10 * s, 45 * s, 3 * s);
    g.fill();
    roundRect(g, cx - 21 * s, top + 22 * s, 7 * s, 34 * s, 3 * s);
    g.fill();
    roundRect(g, cx + 14 * s, top + 22 * s, 7 * s, 34 * s, 3 * s);
    g.fill();
  }
}

function iconCutlery(g: Ctx, cx: number, cy: number, s: number): void {
  g.lineCap = 'round';
  g.lineWidth = s * 0.09;
  // fork
  const fx = cx - s * 0.18;
  for (let i = -1; i <= 1; i++) {
    g.beginPath();
    g.moveTo(fx + i * s * 0.08, cy - s * 0.42);
    g.lineTo(fx + i * s * 0.08, cy - s * 0.15);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(fx - s * 0.08, cy - s * 0.15);
  g.quadraticCurveTo(fx, cy - s * 0.02, fx + s * 0.08, cy - s * 0.15);
  g.stroke();
  g.beginPath();
  g.moveTo(fx, cy - s * 0.08);
  g.lineTo(fx, cy + s * 0.42);
  g.stroke();
  // knife
  const kx = cx + s * 0.18;
  g.beginPath();
  g.moveTo(kx, cy + s * 0.42);
  g.lineTo(kx, cy - s * 0.42);
  g.quadraticCurveTo(kx + s * 0.16, cy - s * 0.25, kx + s * 0.02, cy - s * 0.02);
  g.stroke();
}

function iconCup(g: Ctx, cx: number, cy: number, s: number): void {
  g.beginPath();
  g.moveTo(cx - s * 0.24, cy - s * 0.25);
  g.lineTo(cx + s * 0.24, cy - s * 0.25);
  g.lineTo(cx + s * 0.17, cy + s * 0.42);
  g.lineTo(cx - s * 0.17, cy + s * 0.42);
  g.closePath();
  g.fill();
  g.fillRect(cx - s * 0.28, cy - s * 0.33, s * 0.56, s * 0.09);
  g.lineWidth = s * 0.06;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx + s * 0.04, cy - s * 0.33);
  g.lineTo(cx + s * 0.16, cy - s * 0.5);
  g.lineTo(cx + s * 0.3, cy - s * 0.5);
  g.stroke();
}

function iconCone(g: Ctx, cx: number, cy: number, s: number): void {
  g.beginPath();
  g.moveTo(cx - s * 0.2, cy - s * 0.05);
  g.lineTo(cx + s * 0.2, cy - s * 0.05);
  g.lineTo(cx, cy + s * 0.48);
  g.closePath();
  g.fill();
  g.beginPath();
  g.arc(cx - s * 0.08, cy - s * 0.15, s * 0.15, 0, Math.PI * 2);
  g.arc(cx + s * 0.1, cy - s * 0.17, s * 0.14, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(cx, cy - s * 0.32, s * 0.15, 0, Math.PI * 2);
  g.fill();
}

function iconGift(g: Ctx, cx: number, cy: number, s: number, bg: string): void {
  g.fillRect(cx - s * 0.32, cy - s * 0.1, s * 0.64, s * 0.5);
  g.fillRect(cx - s * 0.36, cy - s * 0.24, s * 0.72, s * 0.14);
  g.fillStyle = bg;
  g.fillRect(cx - s * 0.04, cy - s * 0.24, s * 0.08, s * 0.64);
  g.fillRect(cx - s * 0.32, cy - s * 0.1, s * 0.64, s * 0.04);
  g.fillStyle = CREAM;
  g.lineWidth = s * 0.06;
  g.beginPath();
  g.ellipse(cx - s * 0.12, cy - s * 0.33, s * 0.12, s * 0.07, -0.4, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.ellipse(cx + s * 0.12, cy - s * 0.33, s * 0.12, s * 0.07, 0.4, 0, Math.PI * 2);
  g.stroke();
}

function iconTicket(g: Ctx, cx: number, cy: number, s: number, bg: string): void {
  g.save();
  g.translate(cx, cy);
  g.rotate(-0.25);
  roundRect(g, -s * 0.42, -s * 0.22, s * 0.84, s * 0.44, s * 0.05);
  g.fill();
  g.fillStyle = bg;
  g.beginPath();
  g.arc(-s * 0.42, 0, s * 0.09, 0, Math.PI * 2);
  g.arc(s * 0.42, 0, s * 0.09, 0, Math.PI * 2);
  g.fill();
  for (let i = -2; i <= 2; i++) g.fillRect(s * 0.18, i * s * 0.07 - s * 0.02, s * 0.03, s * 0.04);
  g.restore();
}

/** Original zoo emblem: savanna sun, acacia and grass on a green roundel. */
function emblem(g: Ctx, cx: number, cy: number, r: number): void {
  g.save();
  g.fillStyle = CREAM;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = GREEN;
  g.beginPath();
  g.arc(cx, cy, r * 0.88, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(cx, cy, r * 0.88, 0, Math.PI * 2);
  g.clip();
  // sun
  g.fillStyle = OCHRE;
  g.beginPath();
  g.arc(cx + r * 0.22, cy + r * 0.12, r * 0.42, Math.PI, 0);
  g.fill();
  // ground
  g.fillStyle = CREAM;
  g.fillRect(cx - r, cy + r * 0.12, r * 2, r * 0.07);
  // acacia trunk + flat canopy
  g.fillStyle = CREAM;
  g.beginPath();
  g.moveTo(cx - r * 0.3, cy + r * 0.13);
  g.lineTo(cx - r * 0.24, cy - r * 0.18);
  g.lineTo(cx - r * 0.42, cy - r * 0.36);
  g.lineTo(cx - r * 0.36, cy - r * 0.38);
  g.lineTo(cx - r * 0.2, cy - r * 0.24);
  g.lineTo(cx - r * 0.06, cy - r * 0.4);
  g.lineTo(cx, cy - r * 0.37);
  g.lineTo(cx - r * 0.16, cy - r * 0.16);
  g.lineTo(cx - r * 0.19, cy + r * 0.13);
  g.closePath();
  g.fill();
  g.beginPath();
  g.ellipse(cx - r * 0.24, cy - r * 0.44, r * 0.42, r * 0.1, 0, 0, Math.PI * 2);
  g.fill();
  // grass tufts
  g.strokeStyle = CREAM;
  g.lineWidth = r * 0.03;
  for (let i = 0; i < 9; i++) {
    const x = cx - r * 0.8 + i * r * 0.2;
    g.beginPath();
    g.moveTo(x, cy + r * 0.13);
    g.lineTo(x - r * 0.04, cy + r * 0.02);
    g.moveTo(x, cy + r * 0.13);
    g.lineTo(x + r * 0.05, cy + r * 0.03);
    g.stroke();
  }
  // leaf below
  g.fillStyle = OCHRE;
  g.beginPath();
  g.moveTo(cx - r * 0.3, cy + r * 0.52);
  g.quadraticCurveTo(cx, cy + r * 0.28, cx + r * 0.3, cy + r * 0.52);
  g.quadraticCurveTo(cx, cy + r * 0.72, cx - r * 0.3, cy + r * 0.52);
  g.fill();
  g.restore();
}

// ---- animal silhouettes in a w × h box at (x, y), facing right

function elephant(g: Ctx, x: number, y: number, w: number, h: number): void {
  const X = (f: number) => x + f * w;
  const Y = (f: number) => y + f * h;
  g.beginPath();
  g.ellipse(X(0.42), Y(0.45), w * 0.27, h * 0.24, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(X(0.72), Y(0.36), w * 0.12, h * 0.17, 0.2, 0, Math.PI * 2);
  g.fill();
  // legs
  for (const lx of [0.22, 0.34, 0.52, 0.62]) {
    roundRect(g, X(lx - 0.045), Y(0.5), w * 0.09, h * 0.45, w * 0.02);
    g.fill();
  }
  // trunk
  g.lineCap = 'round';
  g.strokeStyle = g.fillStyle;
  g.lineWidth = w * 0.06;
  g.beginPath();
  g.moveTo(X(0.8), Y(0.4));
  g.quadraticCurveTo(X(0.9), Y(0.62), X(0.86), Y(0.86));
  g.stroke();
  g.lineWidth = w * 0.045;
  g.beginPath();
  g.moveTo(X(0.86), Y(0.84));
  g.lineTo(X(0.9), Y(0.9));
  g.stroke();
  // tail
  g.lineWidth = w * 0.012;
  g.beginPath();
  g.moveTo(X(0.16), Y(0.4));
  g.quadraticCurveTo(X(0.12), Y(0.55), X(0.13), Y(0.66));
  g.stroke();
  // ear (lighter edge)
  g.save();
  g.globalAlpha = 0.35;
  g.fillStyle = CREAM;
  g.beginPath();
  g.ellipse(X(0.66), Y(0.38), w * 0.08, h * 0.15, 0.1, 0, Math.PI * 2);
  g.fill();
  g.restore();
  // tusk
  g.save();
  g.strokeStyle = '#f2ead6';
  g.lineWidth = w * 0.018;
  g.beginPath();
  g.moveTo(X(0.79), Y(0.5));
  g.quadraticCurveTo(X(0.88), Y(0.58), X(0.93), Y(0.52));
  g.stroke();
  g.restore();
}

function giraffe(g: Ctx, x: number, y: number, w: number, h: number): void {
  const X = (f: number) => x + f * w;
  const Y = (f: number) => y + f * h;
  g.beginPath();
  g.ellipse(X(0.42), Y(0.56), w * 0.2, h * 0.11, -0.12, 0, Math.PI * 2);
  g.fill();
  for (const [lx, top] of [
    [0.27, 0.58],
    [0.34, 0.6],
    [0.52, 0.56],
    [0.58, 0.55],
  ] as const) {
    roundRect(g, X(lx - 0.02), Y(top), w * 0.04, h * (0.97 - top), w * 0.012);
    g.fill();
  }
  g.lineCap = 'round';
  g.strokeStyle = g.fillStyle;
  g.lineWidth = w * 0.075;
  g.beginPath();
  g.moveTo(X(0.55), Y(0.52));
  g.lineTo(X(0.7), Y(0.12));
  g.stroke();
  g.beginPath();
  g.ellipse(X(0.76), Y(0.1), w * 0.075, h * 0.04, 0.35, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = w * 0.015;
  g.beginPath();
  g.moveTo(X(0.7), Y(0.07));
  g.lineTo(X(0.69), Y(0.02));
  g.moveTo(X(0.73), Y(0.06));
  g.lineTo(X(0.73), Y(0.01));
  g.stroke();
  g.beginPath();
  g.moveTo(X(0.23), Y(0.52));
  g.quadraticCurveTo(X(0.2), Y(0.62), X(0.21), Y(0.72));
  g.stroke();
}

function penguin(g: Ctx, x: number, y: number, w: number, h: number): void {
  const X = (f: number) => x + f * w;
  const Y = (f: number) => y + f * h;
  g.beginPath();
  g.ellipse(X(0.5), Y(0.58), w * 0.2, h * 0.34, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(X(0.53), Y(0.2), w * 0.12, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(X(0.62), Y(0.18));
  g.lineTo(X(0.78), Y(0.22));
  g.lineTo(X(0.62), Y(0.25));
  g.fill();
  // flipper
  g.beginPath();
  g.ellipse(X(0.36), Y(0.55), w * 0.05, h * 0.2, 0.25, 0, Math.PI * 2);
  g.fill();
  // feet
  g.beginPath();
  g.ellipse(X(0.45), Y(0.93), w * 0.08, h * 0.03, 0, 0, Math.PI * 2);
  g.ellipse(X(0.6), Y(0.93), w * 0.08, h * 0.03, 0, 0, Math.PI * 2);
  g.fill();
  // white belly
  g.save();
  g.fillStyle = '#efe8d8';
  g.beginPath();
  g.ellipse(X(0.56), Y(0.62), w * 0.12, h * 0.26, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

// ---------------------------------------------------------------------------
// Sign atlas

function paintKiosk(g: Ctx, r: Region, text: string, icon: (cx: number, cy: number, s: number) => void, seed: number): void {
  boardBase(g, r, seed);
  const s = r.h * 0.62;
  const ix = r.x + r.h * 0.62;
  const cy = r.y + r.h / 2;
  g.fillStyle = OCHRE;
  g.beginPath();
  g.arc(ix, cy, s * 0.56, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = GREEN_D;
  g.strokeStyle = GREEN_D;
  icon(ix, cy, s * 0.8);
  g.fillStyle = CREAM;
  const left = ix + s * 0.7;
  const right = r.x + r.w - r.h * 0.3;
  fitText(g, text, (left + right) / 2, cy + r.h * 0.03, right - left, Math.round(r.h * 0.5), SANS, '700', 0.12);
}

function paintInfo(g: Ctx, r: Region, title: string, facts: string[], seed: number, draw: (x: number, y: number, w: number, h: number) => void): void {
  g.fillStyle = '#e6dcc2';
  g.fillRect(r.x, r.y, r.w, r.h);
  grain(g, r, seed, 0.04, false);
  const bar = Math.round(r.h * 0.2);
  g.fillStyle = GREEN;
  g.fillRect(r.x, r.y, r.w, bar);
  g.fillStyle = CREAM;
  g.textAlign = 'left';
  fitText(g, title, r.x + r.w * 0.5, r.y + bar * 0.54, r.w * 0.86, Math.round(bar * 0.6), SANS, '700', 0.08);
  // picture disc
  const pc = r.x + r.w * 0.24;
  const py = r.y + bar + (r.h - bar) * 0.47;
  const pr = (r.h - bar) * 0.38;
  g.fillStyle = '#cfa968';
  g.beginPath();
  g.arc(pc, py, pr, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#3a2a1d';
  draw(pc - pr * 0.85, py - pr * 0.8, pr * 1.7, pr * 1.55);
  // facts
  g.fillStyle = '#2b2a24';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  const fx = r.x + r.w * 0.47;
  let fy = r.y + bar + (r.h - bar) * 0.2;
  const step = (r.h - bar) * 0.25;
  for (const f of facts) {
    g.fillStyle = OCHRE;
    g.beginPath();
    g.arc(fx, fy, 3, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#2b2a24';
    const words = f.split(' ');
    let line = '';
    const lines: string[] = [];
    g.font = `500 ${Math.round(r.h * 0.07)}px ${SANS}`;
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (g.measureText(t).width > r.w * 0.47 && line) {
        lines.push(line);
        line = w;
      } else line = t;
    }
    lines.push(line);
    lines.forEach((l, k) => g.fillText(l, fx + 9, fy + k * r.h * 0.078));
    fy += step;
  }
  // footer
  g.fillStyle = GREEN;
  g.fillRect(r.x, r.y + r.h - 10, r.w, 10);
}

function paintSigns(g: Ctx): void {
  g.fillStyle = GREEN;
  g.fillRect(0, 0, SIGN_SIZE, SIGN_SIZE);

  // --- entrance arch board: carved cream letters on dark stained timber
  {
    const r = SIGN_REGIONS.arch;
    g.fillStyle = '#3b2819';
    g.fillRect(r.x, r.y, r.w, r.h);
    // planks
    const rng = new Rng(17);
    for (let i = 0; i < 4; i++) {
      const y = r.y + (i * r.h) / 4;
      g.fillStyle = `rgba(${90 + rng.int(-12, 12)},${62 + rng.int(-8, 8)},${40 + rng.int(-6, 6)},0.55)`;
      g.fillRect(r.x, y, r.w, r.h / 4);
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(r.x, y, r.w, 2);
    }
    grain(g, r, 18, 0.12);
    g.strokeStyle = '#c9b07a';
    g.lineWidth = 4;
    g.strokeRect(r.x + 10, r.y + 10, r.w - 20, r.h - 20);
    const cy = r.y + r.h * 0.53;
    const text = 'WILDHAVEN ZOO';
    // carved: dark offset shadow, light rim, then fill
    const tw = r.w - r.h * 2.5;
    g.fillStyle = 'rgba(0,0,0,0.6)';
    fitText(g, text, r.x + r.w / 2 + 3, cy + 4, tw, 100, SERIF, '700', 0.08);
    g.fillStyle = '#f6ecd0';
    fitText(g, text, r.x + r.w / 2 - 1, cy - 1, tw, 100, SERIF, '700', 0.08);
    g.fillStyle = '#e0c88e';
    fitText(g, text, r.x + r.w / 2, cy, tw, 100, SERIF, '700', 0.08);
    emblem(g, r.x + r.h * 0.62, r.y + r.h / 2, r.h * 0.38);
    emblem(g, r.x + r.w - r.h * 0.62, r.y + r.h / 2, r.h * 0.38);
  }

  paintKiosk(g, SIGN_REGIONS.snacks, 'SNACKS', (x, y, s) => iconCutlery(g, x, y, s), 21);
  paintKiosk(g, SIGN_REGIONS.drinks, 'DRINKS', (x, y, s) => iconCup(g, x, y, s), 22);
  paintKiosk(g, SIGN_REGIONS.icecream, 'ICE CREAM', (x, y, s) => iconCone(g, x, y, s), 23);
  paintKiosk(g, SIGN_REGIONS.gifts, 'GIFTS', (x, y, s) => iconGift(g, x, y, s, OCHRE), 24);
  paintKiosk(
    g,
    SIGN_REGIONS.restrooms,
    'RESTROOMS',
    (x, y, s) => {
      person(g, x - s * 0.2, y - s * 0.48, s * 0.95, false);
      person(g, x + s * 0.22, y - s * 0.48, s * 0.95, true);
    },
    25,
  );
  paintKiosk(g, SIGN_REGIONS.tickets, 'TICKETS', (x, y, s) => iconTicket(g, x, y, s, OCHRE), 26);

  paintInfo(g, SIGN_REGIONS.info0, 'AFRICAN ELEPHANT', ['Largest land animal: up to 6 tonnes', 'Eats about 150 kg of plants a day', 'Its trunk has over 40,000 muscles'], 31, (x, y, w, h) => elephant(g, x, y, w, h));
  paintInfo(g, SIGN_REGIONS.info1, 'GIRAFFE', ['Tallest animal: up to 5.5 m', 'Its tongue is about 45 cm long', 'Sleeps less than 2 hours a day'], 32, (x, y, w, h) => giraffe(g, x, y, w, h));
  paintInfo(g, SIGN_REGIONS.info2, 'PENGUIN', ['Swims at up to 25 km per hour', 'Dense feathers keep it warm and dry', 'Finds its mate by voice alone'], 33, (x, y, w, h) => penguin(g, x, y, w, h));

  // --- snack menu: chalkboard
  {
    const r = SIGN_REGIONS.menu;
    g.fillStyle = BROWN;
    g.fillRect(r.x, r.y, r.w, r.h);
    g.fillStyle = '#202422';
    g.fillRect(r.x + 10, r.y + 10, r.w - 20, r.h - 20);
    grain(g, { x: r.x + 10, y: r.y + 10, w: r.w - 20, h: r.h - 20 }, 41, 0.08, false);
    g.fillStyle = '#e9e4d6';
    fitText(g, 'MENU', r.x + r.w / 2, r.y + 36, r.w * 0.6, 30, SANS, '700', 0.15);
    const items: [string, string][] = [
      ['Hot dog', '6'],
      ['Fries', '4'],
      ['Pretzel', '3'],
      ['Popcorn', '3'],
      ['Nachos', '5'],
      ['Veggie wrap', '6'],
    ];
    g.font = `500 19px ${SANS}`;
    items.forEach(([n, p], k) => {
      const y = r.y + 72 + k * 26;
      g.fillStyle = '#ddd8c8';
      g.textAlign = 'left';
      g.fillText(n, r.x + 24, y);
      g.textAlign = 'right';
      g.fillStyle = '#e8c77e';
      g.fillText(p, r.x + r.w - 24, y);
      g.fillStyle = 'rgba(220,215,200,0.35)';
      g.fillRect(r.x + 24, y + 11, r.w - 48, 1);
    });
  }
  // --- ice-cream flavours
  {
    const r = SIGN_REGIONS.flavours;
    g.fillStyle = '#efe7d4';
    g.fillRect(r.x, r.y, r.w, r.h);
    grain(g, r, 42, 0.04, false);
    g.fillStyle = '#7a2e2a';
    fitText(g, 'FLAVOURS', r.x + r.w / 2, r.y + 34, r.w * 0.75, 28, SANS, '700', 0.12);
    const fl: [string, string][] = [
      ['Vanilla', '#efe1b3'],
      ['Chocolate', '#5a3622'],
      ['Strawberry', '#d98c8c'],
      ['Mint chip', '#a9d3b5'],
      ['Mango', '#e8a845'],
    ];
    fl.forEach(([n, c], k) => {
      const y = r.y + 72 + k * 32;
      g.fillStyle = c;
      g.beginPath();
      g.arc(r.x + 34, y, 11, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.3)';
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = '#3b2a22';
      g.textAlign = 'left';
      g.font = `600 20px ${SANS}`;
      g.textBaseline = 'middle';
      g.fillText(n, r.x + 56, y);
    });
  }
  // --- donation sign
  {
    const r = SIGN_REGIONS.donate;
    boardBase(g, r, 43);
    emblem(g, r.x + r.w / 2, r.y + 70, 42);
    g.fillStyle = CREAM;
    fitText(g, 'PLEASE DONATE', r.x + r.w / 2, r.y + 136, r.w * 0.8, 30, SANS, '700', 0.06);
    g.fillStyle = '#d9cfb4';
    fitText(g, 'Every coin helps us care', r.x + r.w / 2, r.y + 170, r.w * 0.8, 18, SANS, '500');
    fitText(g, 'for our animals', r.x + r.w / 2, r.y + 192, r.w * 0.8, 18, SANS, '500');
  }
  // --- logo roundel
  {
    const r = SIGN_REGIONS.logo;
    g.fillStyle = BROWN;
    g.fillRect(r.x, r.y, r.w, r.h);
    emblem(g, r.x + r.w / 2, r.y + r.h / 2, r.w * 0.47);
  }
  // --- restroom door plates
  for (const [key, fem] of [
    ['men', false],
    ['women', true],
  ] as const) {
    const r = SIGN_REGIONS[key];
    g.fillStyle = '#d8d4c8';
    g.fillRect(r.x, r.y, r.w, r.h);
    g.fillStyle = GREEN;
    roundRect(g, r.x + 3, r.y + 3, r.w - 6, r.h - 6, 6);
    g.fill();
    g.fillStyle = CREAM;
    person(g, r.x + r.w / 2, r.y + 10, r.h - 20, fem);
  }
  // --- bank note (donation box contents)
  {
    const r = SIGN_REGIONS.note;
    g.fillStyle = '#8fa27c';
    g.fillRect(r.x, r.y, r.w, r.h);
    g.strokeStyle = '#5d7050';
    g.lineWidth = 2;
    g.strokeRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6);
    g.fillStyle = '#5d7050';
    g.beginPath();
    g.arc(r.x + r.w * 0.7, r.y + r.h / 2, 8, 0, Math.PI * 2);
    g.fill();
    g.font = `700 12px ${SANS}`;
    g.textAlign = 'left';
    g.fillText('10', r.x + 8, r.y + r.h / 2 + 1);
  }
  // --- OPEN plate (hours)
  {
    const r = SIGN_REGIONS.open;
    g.fillStyle = CREAM;
    g.fillRect(r.x, r.y, r.w, r.h);
    g.fillStyle = GREEN;
    fitText(g, 'OPEN', r.x + r.w / 2, r.y + 14, r.w * 0.85, 14, SANS, '700', 0.05);
    g.font = `500 10px ${SANS}`;
    g.fillStyle = '#333';
    g.fillText('08:00-20:00', r.x + r.w / 2, r.y + 34);
  }
  // --- flat colour swatches (balloons etc.)
  for (const [key, c] of [
    ['swRed', '#9c3a30'],
    ['swYellow', '#c9a04a'],
    ['swBlue', '#3c6688'],
    ['swWhite', '#e9e4d8'],
    ['swBrown', '#6e4b33'],
    ['swBeige', '#b9a688'],
    ['swGrey', '#7a7570'],
  ] as const) {
    const r = SIGN_REGIONS[key];
    g.fillStyle = c;
    g.fillRect(r.x, r.y, r.w, r.h);
  }
}

// ---------------------------------------------------------------------------
// Interior atlas (shown through glazing; also the night emissive map)

function warmWash(g: Ctx, r: Region, strength: number): void {
  const grd = g.createRadialGradient(r.x + r.w / 2, r.y, 4, r.x + r.w / 2, r.y + r.h * 0.4, r.w * 0.8);
  grd.addColorStop(0, `rgba(255,226,170,${strength})`);
  grd.addColorStop(1, 'rgba(255,226,170,0)');
  g.fillStyle = grd;
  g.fillRect(r.x, r.y, r.w, r.h);
}

function paintInterior(g: Ctx): void {
  g.fillStyle = '#1a1714';
  g.fillRect(0, 0, INT_SIZE, INT_SIZE);
  const rng = new Rng(77);
  // --- kitchen behind a serving hatch
  {
    const r = INT_REGIONS.kitchen;
    // tiled back wall
    g.fillStyle = '#b9b3a3';
    g.fillRect(r.x, r.y, r.w, r.h);
    g.strokeStyle = 'rgba(80,75,65,0.35)';
    g.lineWidth = 1;
    for (let x = r.x; x < r.x + r.w; x += 12) {
      g.beginPath();
      g.moveTo(x, r.y);
      g.lineTo(x, r.y + r.h);
      g.stroke();
    }
    for (let y = r.y; y < r.y + r.h; y += 12) {
      g.beginPath();
      g.moveTo(r.x, y);
      g.lineTo(r.x + r.w, y);
      g.stroke();
    }
    // menu screens
    for (let i = 0; i < 3; i++) {
      const x = r.x + 20 + i * 76;
      g.fillStyle = '#121212';
      g.fillRect(x, r.y + 10, 64, 38);
      g.fillStyle = ['#d9a441', '#c45a3c', '#6f9a54'][i];
      g.fillRect(x + 4, r.y + 14, 56, 12);
      g.fillStyle = '#e8e0cc';
      for (let k = 0; k < 3; k++) g.fillRect(x + 6, r.y + 30 + k * 5, 30 + rng.int(0, 18), 2);
    }
    // shelf with jars / cups
    g.fillStyle = '#6b5a48';
    g.fillRect(r.x, r.y + 70, r.w, 5);
    for (let i = 0; i < 14; i++) {
      g.fillStyle = rng.pick(['#c9b28a', '#a33a2a', '#d8cbb0', '#7d8a5a', '#e0d6c0']);
      const w = 8 + rng.int(0, 6);
      const h = 10 + rng.int(0, 12);
      g.fillRect(r.x + 8 + i * 17, r.y + 70 - h, w, h);
    }
    // stainless equipment + counter
    g.fillStyle = '#8f9496';
    g.fillRect(r.x, r.y + 92, r.w, r.h - 92);
    g.fillStyle = '#a9aeb0';
    g.fillRect(r.x + 14, r.y + 84, 70, 30);
    g.fillRect(r.x + 150, r.y + 80, 86, 34);
    g.fillStyle = '#2b2b2b';
    g.fillRect(r.x + 160, r.y + 86, 66, 18);
    g.fillStyle = '#d9a040';
    g.fillRect(r.x + 164, r.y + 92, 58, 8);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(r.x, r.y + r.h - 22, r.w, 22);
    warmWash(g, r, 0.35);
  }
  // --- drinks fridge
  {
    const r = INT_REGIONS.fridge;
    g.fillStyle = '#202326';
    g.fillRect(r.x, r.y, r.w, r.h);
    g.fillStyle = '#e8f0ff';
    g.fillRect(r.x + 4, r.y + 4, 6, r.h - 8);
    g.fillRect(r.x + r.w - 10, r.y + 4, 6, r.h - 8);
    const cols = ['#b8362c', '#e0a83a', '#3f7f4a', '#2f5b8f', '#e6e2d6', '#7a3a6a', '#d1d65a'];
    for (let s = 0; s < 5; s++) {
      const sy = r.y + 14 + s * 48;
      g.fillStyle = '#9aa3a8';
      g.fillRect(r.x + 10, sy + 40, r.w - 20, 3);
      const c = cols[s % cols.length];
      for (let k = 0; k < 7; k++) {
        const bx = r.x + 14 + k * 15;
        g.fillStyle = k % 3 === 0 ? cols[(s + 3) % cols.length] : c;
        roundRect(g, bx, sy + 12, 10, 28, 3);
        g.fill();
        g.fillRect(bx + 3, sy + 6, 4, 8);
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(bx + 2, sy + 14, 2, 22);
      }
    }
    const grd = g.createLinearGradient(r.x, 0, r.x + r.w, 0);
    grd.addColorStop(0, 'rgba(220,235,255,0.3)');
    grd.addColorStop(0.5, 'rgba(220,235,255,0.05)');
    grd.addColorStop(1, 'rgba(220,235,255,0.3)');
    g.fillStyle = grd;
    g.fillRect(r.x, r.y, r.w, r.h);
  }
  // --- ticket booth interior
  {
    const r = INT_REGIONS.booth;
    g.fillStyle = '#8c7a63';
    g.fillRect(r.x, r.y, r.w, r.h);
    g.fillStyle = '#5b4a3a';
    g.fillRect(r.x, r.y + 84, r.w, r.h - 84);
    g.fillStyle = '#1b1d1f';
    g.fillRect(r.x + 64, r.y + 50, 40, 28);
    g.fillStyle = '#5c8fb3';
    g.fillRect(r.x + 67, r.y + 53, 34, 21);
    g.fillStyle = '#d8d2c2';
    g.fillRect(r.x + 16, r.y + 70, 34, 14);
    g.fillStyle = '#3b2c22';
    g.fillRect(r.x + 10, r.y + 16, 40, 28);
    g.fillStyle = '#e6dcc2';
    g.fillRect(r.x + 13, r.y + 19, 34, 22);
    warmWash(g, r, 0.45);
  }
  // --- frosted glass
  {
    const r = INT_REGIONS.frosted;
    const grd = g.createLinearGradient(0, r.y, 0, r.y + r.h);
    grd.addColorStop(0, '#d9dcd8');
    grd.addColorStop(1, '#b8bcb8');
    g.fillStyle = grd;
    g.fillRect(r.x, r.y, r.w, r.h);
    grain(g, r, 79, 0.06, false);
  }
  // --- gift shop shelves with plush toys, mugs, shirts
  {
    const r = INT_REGIONS.gift;
    g.fillStyle = '#7d6a55';
    g.fillRect(r.x, r.y, r.w, r.h);
    for (let s = 0; s < 3; s++) {
      const sy = r.y + 56 + s * 52;
      g.fillStyle = '#4e3b2b';
      g.fillRect(r.x, sy, r.w, 6);
      for (let k = 0; k < 9; k++) {
        const x = r.x + 10 + k * 27 + rng.range(-2, 2);
        const kind = rng.int(0, 3);
        if (kind <= 1) {
          // plush animal: body + head + ears
          const col = rng.pick(['#8a6a48', '#c9b79a', '#5d5852', '#d1a25a', '#ece7dc', '#6e4b33']);
          g.fillStyle = col;
          g.beginPath();
          g.ellipse(x + 10, sy - 12, 10, 12, 0, 0, Math.PI * 2);
          g.fill();
          g.beginPath();
          g.arc(x + 10, sy - 30, 8, 0, Math.PI * 2);
          g.fill();
          g.beginPath();
          g.arc(x + 4, sy - 37, 3.5, 0, Math.PI * 2);
          g.arc(x + 16, sy - 37, 3.5, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#1a1612';
          g.fillRect(x + 7, sy - 32, 2, 2);
          g.fillRect(x + 12, sy - 32, 2, 2);
        } else if (kind === 2) {
          g.fillStyle = rng.pick(['#e8e2d4', '#2f4a3a', '#a2492f', '#3d5a78']);
          roundRect(g, x + 2, sy - 18, 14, 18, 2);
          g.fill();
          g.strokeStyle = g.fillStyle;
          g.lineWidth = 2;
          g.beginPath();
          g.arc(x + 17, sy - 9, 4, -1.2, 1.2);
          g.stroke();
        } else {
          g.fillStyle = rng.pick(['#3a5a4a', '#c08a3e', '#e5dfd0', '#6b3b2e']);
          g.fillRect(x, sy - 34, 22, 34);
          g.fillStyle = 'rgba(255,255,255,0.25)';
          g.fillRect(x + 6, sy - 24, 10, 8);
        }
      }
    }
    warmWash(g, r, 0.4);
  }
  // --- glazed door view (shop floor)
  {
    const r = INT_REGIONS.door;
    g.fillStyle = '#6d5c49';
    g.fillRect(r.x, r.y, r.w, r.h);
    g.fillStyle = '#4b3c2e';
    g.fillRect(r.x, r.y + r.h * 0.7, r.w, r.h * 0.3);
    g.fillStyle = '#3a2d22';
    g.fillRect(r.x + 18, r.y + 120, 90, 60);
    for (let k = 0; k < 6; k++) {
      g.fillStyle = rng.pick(['#8a6a48', '#c9b79a', '#d1a25a', '#ece7dc', '#2f4a3a']);
      g.beginPath();
      g.arc(r.x + 28 + k * 14, r.y + 112, 7, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#c7bfa9';
    g.fillRect(r.x + 30, r.y + 20, 68, 40);
    warmWash(g, r, 0.4);
  }
  // --- dark (unlit interior / den)
  {
    const r = INT_REGIONS.dark;
    g.fillStyle = '#2b231c';
    g.fillRect(r.x, r.y, r.w, r.h);
  }
  // --- lantern glass (bright warm frosted glass)
  {
    const r = INT_REGIONS.glow;
    const grd = g.createRadialGradient(r.x + r.w / 2, r.y + r.h / 2, 2, r.x + r.w / 2, r.y + r.h / 2, r.w * 0.7);
    grd.addColorStop(0, '#fff6e2');
    grd.addColorStop(1, '#e8dcc2');
    g.fillStyle = grd;
    g.fillRect(r.x, r.y, r.w, r.h);
  }
}

// ---------------------------------------------------------------------------
// Textures (lazy, cached)

let signTex: THREE.CanvasTexture | null = null;
let intTex: THREE.CanvasTexture | null = null;

function toTexture(canvas: HTMLCanvasElement | OffscreenCanvas): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}

export function signTexture(): THREE.CanvasTexture {
  if (!signTex) {
    const { canvas, ctx } = makeCanvas(SIGN_SIZE, SIGN_SIZE);
    paintSigns(ctx);
    signTex = toTexture(canvas);
  }
  return signTex;
}

export function interiorTexture(): THREE.CanvasTexture {
  if (!intTex) {
    const { canvas, ctx } = makeCanvas(INT_SIZE, INT_SIZE);
    paintInterior(ctx);
    intTex = toTexture(canvas);
  }
  return intTex;
}

export function disposeSignTextures(): void {
  signTex?.dispose();
  intTex?.dispose();
}
