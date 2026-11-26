// Animal and guest foley (fx.*): footsteps per foot type, splashes with
// Minnaert droplets, laps, trunk suck and pour, grass cropping, chewing,
// breathing, ear flaps, dust, surfacing, dives, tail swishes and guest steps
// per path surface. Registered by modules/fauna.ts with registerRecipes.
//
// Rates follow the content: 8 kHz for sounds below ~1.5 kHz (breath, chew,
// suck, ear flaps), 11.025 kHz for water and blows, 16 kHz for transients up
// to 6 kHz, 22.05 kHz only for gravel crunch. No baked reverb: the engine's
// shared outdoor reverb places them. Tails are short (no reverb to ring out).

import type { Rng } from '../../core/rng';
import type { Kit } from '../kit';
import type { Recipe } from '../render';
import { pcmSource } from '../voice';

const TAIL = 0.05;
const PEAK = 0.7;
const STEP = { peak: PEAK, rms: 0.09, tail: TAIL };
const SPLASH = { peak: PEAK, rms: 0.1, tail: TAIL };
const OTHER = { peak: PEAK, rms: 0.08, tail: TAIL };

/** Interval between tongue laps in a drinking bout (one fx.lap per lap), s. */
export const LAP_SPACING = 0.3;

/** Banks of fx.* ids: number of `#k` variants (0 = a single id without a suffix). */
export const FOLEY_BANKS = {
  'fx.step.pad': 3,
  'fx.step.hoofHard': 3,
  'fx.step.hoofSoft': 3,
  'fx.step.bird': 2,
  'fx.splash.small': 3,
  'fx.splash.big': 2,
  'fx.lap': 3,
  'fx.suck': 0,
  'fx.pour': 0,
  'fx.crop': 3,
  'fx.chew': 2,
  'fx.breath.big': 2,
  'fx.flap': 2,
  'fx.dust': 0,
  'fx.surface': 2,
  'fx.dive': 2,
  'fx.tail': 0,
  'fx.gstep.paved': 3,
  'fx.gstep.gravel': 3,
  'fx.gstep.board': 3,
} as const;
export type FoleyBank = keyof typeof FOLEY_BANKS;

// ------------------------------------------------------------------ helpers

/** Plain-JS signal into the recipe's dry bus (optionally through a node chain). */
function pcm(k: Kit, data: Float32Array, t: number, level: number, ...chain: AudioNode[]): void {
  const src = pcmSource(k, data, t);
  k.send(chain.length ? k.chain(src, ...chain) : src, level, 0);
}

/**
 * Minnaert droplets: x(t) = sin(2π∫f)·e^(−t/τ), f rising 10–30 % over the
 * plink, τ ≈ 5 ms · (1 kHz / f). `at` are onsets in s relative to the buffer.
 */
function droplets(sr: number, len: number, rng: Rng, at: readonly number[], f: readonly [number, number], amp = 1): Float32Array {
  const out = new Float32Array(Math.ceil(len * sr));
  for (const t0 of at) {
    const f0 = rng.range(f[0], f[1]);
    const rise = rng.range(0.1, 0.3);
    const tau = 0.005 * (1000 / f0);
    const a = amp * rng.range(0.4, 1);
    const n = Math.min(out.length - Math.floor(t0 * sr), Math.ceil(tau * 5 * sr));
    let ph = 0;
    for (let i = 0, j = Math.floor(t0 * sr); i < n; i++, j++) {
      const tt = i / sr;
      ph += (2 * Math.PI * f0 * (1 + (rise * tt) / (tau * 5))) / sr;
      out[j] += Math.sin(ph) * Math.exp(-tt / tau) * a;
    }
  }
  return out;
}

/** `n` onsets spread over [t0, t1] (sorted). */
function onsets(rng: Rng, n: number, t0: number, t1: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rng.range(t0, t1));
  return out.sort((a, b) => a - b);
}

/** White noise with sparse crackle (dense micro-bursts), shaped by a rise / fall envelope. */
function crackle(sr: number, len: number, rng: Rng, rate: number, att: number, dec: number): Float32Array {
  const out = new Float32Array(Math.ceil(len * sr));
  const decay = Math.exp(-1 / (0.0015 * sr));
  let e = 0;
  for (let i = 0; i < out.length; i++) {
    if (rng.float() < rate / sr) e = rng.range(0.4, 1);
    e *= decay;
    const t = i / sr;
    const env = t < att ? t / att : Math.exp(-(t - att) / dec);
    out[i] = (rng.float() * 2 - 1) * (0.15 + e) * env;
  }
  return out;
}

/** Damped modes [Hz, amplitude, decay s] excited at t0 (a wooden knock). */
function modes(sr: number, len: number, t0: number, m: readonly (readonly [number, number, number])[]): Float32Array {
  const out = new Float32Array(Math.ceil(len * sr));
  const s0 = Math.floor(t0 * sr);
  for (const [f, a, d] of m) for (let i = s0; i < out.length; i++) out[i] += a * Math.sin((2 * Math.PI * f * (i - s0)) / sr) * Math.exp(-(i - s0) / sr / d);
  return out;
}

/** Short noise transient through a band-pass: the click / crunch of a footfall. */
function tick(k: Kit, t: number, hz: number, q: number, dur: number, level: number): void {
  k.burst({
    t,
    dur,
    band: [[0, hz]],
    q,
    amp: [
      [0, 0],
      [0.002, 1],
      [dur, 0],
    ],
    level,
    wet: 0,
  });
}

// ------------------------------------------------------------------ animal steps

function padStep(k: Kit): void {
  const r = k.rng;
  // the felt weight; a phone speaker cannot play it, so it stays under the crunch
  k.thump(0.004, 80 * r.range(0.9, 1.1), 35, 0.09, 0.2, { wet: 0 });
  // the ground crunch carries the step on a phone speaker
  tick(k, 0.003, r.range(900, 1300), 0.8, 0.04, 1);
  tick(k, 0.012 + r.range(0, 0.01), r.range(1500, 2200), 1.2, 0.025, 0.5);
}

function hoofHard(k: Kit): void {
  const r = k.rng;
  tick(k, 0.002, r.range(1600, 2300), 1.3, 0.008, 1);
  // hollow clop of the hoof wall, then the body
  tick(k, 0.003, r.range(650, 900), 2, 0.03, 0.9);
  k.thump(0.003, 140 * r.range(0.92, 1.08), 100, 0.05, 0.1, { wet: 0 });
  if (r.chance(0.6)) tick(k, 0.02 + r.range(0, 0.015), r.range(2000, 2800), 1.5, 0.006, 0.4);
}

function hoofSoft(k: Kit): void {
  const r = k.rng;
  tick(k, 0.003, r.range(800, 1100), 1, 0.04, 1);
  tick(k, 0.006, r.range(500, 650), 2, 0.03, 0.5);
  k.thump(0.003, 100 * r.range(0.9, 1.1), 70, 0.06, 0.12, { wet: 0 });
}

function birdStep(k: Kit): void {
  const r = k.rng;
  tick(k, 0.002, r.range(1400, 2100), 0.9, 0.015, 1);
}

// ------------------------------------------------------------------ water

function splash(k: Kit, big: boolean): void {
  const r = k.rng;
  const len = big ? 0.4 : 0.15;
  k.burst({
    t: 0,
    dur: len * 0.7,
    band: [
      [0, big ? 1100 : 1500],
      [len * 0.7, big ? 800 : 1200],
    ],
    q: 0.6,
    amp: [
      [0, 0],
      [0.004, 1],
      [len * 0.25, 0.4],
      [len * 0.7, 0],
    ],
    rough: [60, 0.5],
    level: 0.7,
    wet: 0,
  });
  if (big) k.thump(0.005, 110, 55, 0.12, 0.6, { wet: 0 });
  const n = big ? r.int(10, 14) : r.int(6, 9);
  pcm(k, droplets(k.sr, len + TAIL, r, onsets(r, n, 0.01, len * 0.9), big ? [500, 1800] : [700, 2500]), 0, 0.5);
}

function lap(k: Kit): void {
  const r = k.rng;
  k.burst({
    t: 0,
    dur: 0.05,
    band: [[0, r.range(1100, 1500)]],
    q: 0.9,
    amp: [
      [0, 0],
      [0.006, 1],
      [0.05, 0],
    ],
    level: 0.6,
    wet: 0,
  });
  pcm(k, droplets(k.sr, 0.14 + TAIL, r, onsets(r, r.int(2, 4), 0.01, 0.1), [800, 2000]), 0, 0.45);
}

function suck(k: Kit): void {
  const r = k.rng;
  k.burst({
    t: 0,
    dur: 0.8,
    band: [
      [0, 300],
      [0.7, 900],
    ],
    q: 2,
    amp: [
      [0, 0],
      [0.15, 0.6],
      [0.6, 1],
      [0.8, 0],
    ],
    rough: [14, 0.6],
    level: 0.8,
    wet: 0,
  });
  // gurgle: low, slow bubbles in the trunk
  pcm(k, droplets(k.sr, 0.8 + TAIL, r, onsets(r, r.int(7, 10), 0.15, 0.75), [250, 600]), 0, 0.5);
}

function pour(k: Kit): void {
  const r = k.rng;
  k.burst({
    t: 0,
    dur: 1,
    band: [
      [0, 1400],
      [1, 1000],
    ],
    q: 0.5,
    amp: [
      [0, 0],
      [0.06, 1],
      [0.7, 0.8],
      [1, 0],
    ],
    rough: [25, 0.7],
    level: 0.7,
    wet: 0,
  });
  pcm(k, droplets(k.sr, 1 + TAIL, r, onsets(r, r.int(20, 28), 0.04, 0.95), [500, 2400]), 0, 0.45);
}

function surface(k: Kit): void {
  const r = k.rng;
  // blow: a forced exhale through water at the surface
  k.burst({
    t: 0,
    dur: 0.55,
    band: [
      [0, 650 * r.range(0.9, 1.1)],
      [0.5, 500],
    ],
    q: 0.8,
    amp: [
      [0, 0],
      [0.03, 1],
      [0.2, 0.6],
      [0.55, 0],
    ],
    rough: [30, 0.5],
    level: 0.9,
    wet: 0,
  });
  k.burst({
    t: 0.02,
    dur: 0.5,
    band: [[0, 3200]],
    q: 0.7,
    amp: [
      [0, 0],
      [0.02, 0.6],
      [0.5, 0],
    ],
    level: 0.35,
    wet: 0,
  });
  pcm(k, droplets(k.sr, 0.8 + TAIL, r, onsets(r, r.int(10, 14), 0.1, 0.75), [600, 2200]), 0, 0.4);
}

function dive(k: Kit): void {
  const r = k.rng;
  k.thump(0.01, 90 * r.range(0.9, 1.1), 45, 0.15, 1, { wet: 0 });
  k.burst({
    t: 0.005,
    dur: 0.25,
    band: [
      [0, 1300],
      [0.25, 900],
    ],
    q: 0.6,
    amp: [
      [0, 0],
      [0.004, 1],
      [0.25, 0],
    ],
    rough: [50, 0.5],
    level: 0.7,
    wet: 0,
  });
  pcm(k, droplets(k.sr, 0.4 + TAIL, r, onsets(r, r.int(8, 12), 0.03, 0.38), [500, 2000]), 0, 0.45);
}

// ------------------------------------------------------------------ eating, breathing, body

function crop(k: Kit): void {
  const r = k.rng;
  const len = r.range(0.1, 0.2);
  pcm(k, crackle(k.sr, len, r, 450, 0.01, len / 3), 0, 1, k.bq('bandpass', r.range(2200, 3000), 0.5));
}

function chew(k: Kit): void {
  const r = k.rng;
  // two muffled chews: ~1.3 per second when played back to back
  for (const t of [0.05, r.range(0.75, 0.9)]) {
    pcm(k, crackle(k.sr, 0.3, r, 220, 0.04, 0.08), t, 1, k.bq('bandpass', r.range(600, 850), 0.7), k.bq('lowpass', 1500));
    k.thump(t + 0.01, 130 * r.range(0.9, 1.1), 90, 0.06, 0.5, { wet: 0 });
  }
}

function breath(k: Kit): void {
  const r = k.rng;
  const d = r.range(0.9, 1.15);
  k.burst({
    t: 0,
    dur: d,
    color: 'pink',
    band: [[0, 900]],
    type: 'lowpass',
    q: 0.7,
    amp: [
      [0, 0],
      [0.15, 1],
      [d * 0.6, 0.7],
      [d, 0],
    ],
    rough: [9, 0.3],
    formants: [[500 * r.range(0.9, 1.1), 4, 1.5]],
    level: 1,
    wet: 0,
  });
  // chest body
  k.burst({
    t: 0,
    dur: d,
    band: [[0, 150 * r.range(0.9, 1.1)]],
    q: 1.5,
    amp: [
      [0, 0],
      [0.2, 1],
      [d, 0],
    ],
    level: 0.5,
    wet: 0,
  });
}

function flap(k: Kit): void {
  const r = k.rng;
  const n = r.int(2, 3);
  for (let i = 0; i < n; i++) {
    const t = 0.01 + i * r.range(0.08, 0.11);
    k.burst({
      t,
      dur: 0.06,
      band: [
        [0, 300],
        [0.06, 1000],
      ],
      q: 0.9,
      amp: [
        [0, 0],
        [0.02, 1],
        [0.06, 0],
      ],
      level: 1 - i * 0.2,
      wet: 0,
    });
  }
}

function dust(k: Kit): void {
  k.burst({
    t: 0,
    dur: 0.6,
    band: [
      [0, 1600],
      [0.6, 2600],
    ],
    q: 0.6,
    amp: [
      [0, 0],
      [0.05, 1],
      [0.3, 0.5],
      [0.6, 0],
    ],
    rough: [40, 0.6],
    level: 1,
    wet: 0,
  });
  k.burst({
    t: 0,
    dur: 0.3,
    band: [[0, 500]],
    q: 1,
    amp: [
      [0, 0],
      [0.03, 1],
      [0.3, 0],
    ],
    level: 0.4,
    wet: 0,
  });
}

function tailSwish(k: Kit): void {
  k.burst({
    t: 0,
    dur: 0.22,
    band: [
      [0, 2500],
      [0.22, 4500],
    ],
    q: 1,
    amp: [
      [0, 0],
      [0.09, 1],
      [0.22, 0],
    ],
    level: 1,
    wet: 0,
  });
}

// ------------------------------------------------------------------ guest steps

function pavedStep(k: Kit): void {
  const r = k.rng;
  tick(k, 0.002, r.range(2200, 3000), 1.2, 0.025, 1);
  k.thump(0.002, 300 * r.range(0.9, 1.1), 200, 0.03, 0.25, { wet: 0 });
}

function gravelStep(k: Kit): void {
  const r = k.rng;
  const len = r.range(0.06, 0.09);
  // 20–40 tiny stone impulses inside the footfall
  pcm(k, crackle(k.sr, len, r, r.range(20, 40) / len, 0.008, len / 2.5), 0, 1, k.bq('highpass', 2000), k.bq('peaking', 5000, 1, 4));
}

function boardStep(k: Kit): void {
  const r = k.rng;
  const s = r.range(0.95, 1.05);
  pcm(
    k,
    modes(k.sr, 0.12, 0.002, [
      [180 * s, 0.5, 0.06],
      [420 * s, 0.8, 0.04],
      [950 * s, 0.5, 0.025],
    ]),
    0,
    0.8,
  );
  tick(k, 0.002, 1800, 1, 0.01, 0.4);
}

// ------------------------------------------------------------------ registry

function bank(base: FoleyBank, n: number, r: Omit<Recipe, 'build'>, build: (k: Kit) => void): Record<string, Recipe> {
  const out: Record<string, Recipe> = {};
  const recipe: Recipe = { ...r, build };
  if (n === 0) out[base] = recipe;
  // one Recipe per id: the per-id seed makes each variant different
  for (let i = 0; i < n; i++) out[`${base}#${i}`] = { ...recipe };
  return out;
}

export const FOLEY_RECIPES: Record<string, Recipe> = {
  ...bank('fx.step.pad', 3, { dur: 0.12, rate: 16000, hp: 30, ...STEP }, padStep),
  ...bank('fx.step.hoofHard', 3, { dur: 0.08, rate: 16000, hp: 60, ...STEP }, hoofHard),
  ...bank('fx.step.hoofSoft', 3, { dur: 0.1, rate: 16000, hp: 50, ...STEP }, hoofSoft),
  ...bank('fx.step.bird', 2, { dur: 0.05, rate: 16000, hp: 200, ...STEP }, birdStep),
  ...bank('fx.splash.small', 3, { dur: 0.15, rate: 16000, hp: 150, ...SPLASH }, (k) => splash(k, false)),
  ...bank('fx.splash.big', 2, { dur: 0.4, rate: 16000, hp: 50, ...SPLASH }, (k) => splash(k, true)),
  ...bank('fx.lap', 3, { dur: 0.14, rate: 16000, hp: 300, ...SPLASH }, lap),
  ...bank('fx.suck', 0, { dur: 0.8, rate: 8000, hp: 150, ...OTHER }, suck),
  ...bank('fx.pour', 0, { dur: 1, rate: 11025, hp: 200, ...SPLASH }, pour),
  ...bank('fx.crop', 3, { dur: 0.2, rate: 16000, hp: 600, ...OTHER }, crop),
  ...bank('fx.chew', 2, { dur: 1.2, rate: 8000, hp: 100, ...OTHER }, chew),
  ...bank('fx.breath.big', 2, { dur: 1.15, rate: 8000, hp: 80, ...OTHER }, breath),
  ...bank('fx.flap', 2, { dur: 0.3, rate: 8000, hp: 120, ...OTHER }, flap),
  ...bank('fx.dust', 0, { dur: 0.6, rate: 11025, hp: 300, ...OTHER }, dust),
  ...bank('fx.surface', 2, { dur: 0.8, rate: 11025, hp: 120, ...SPLASH }, surface),
  ...bank('fx.dive', 2, { dur: 0.4, rate: 11025, hp: 40, ...SPLASH }, dive),
  ...bank('fx.tail', 0, { dur: 0.25, rate: 16000, hp: 1200, ...OTHER }, tailSwish),
  ...bank('fx.gstep.paved', 3, { dur: 0.05, rate: 16000, hp: 120, ...STEP }, pavedStep),
  ...bank('fx.gstep.gravel', 3, { dur: 0.09, rate: 22050, hp: 1500, ...STEP }, gravelStep),
  ...bank('fx.gstep.board', 3, { dur: 0.12, rate: 16000, hp: 100, ...STEP }, boardStep),
};
