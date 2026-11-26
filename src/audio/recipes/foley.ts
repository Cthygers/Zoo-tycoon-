// Animal and guest foley (fx.*): footsteps per foot type, splashes with
// Minnaert droplets, laps, trunk suck and pour, grass cropping, chewing,
// breathing, ear flaps, dust, surfacing, dives, tail swishes and guest steps
// per path surface. Registered by modules/fauna.ts with registerRecipes.
//
// Close up, an animal breathes, chews and drinks like its body family
// (`fx.<kind>.<family>#k`: a lion's rough nasal huff, an elephant's trunk
// blow, a penguin's beak dip); the generic fx.breath.big / fx.chew / fx.lap
// remain for voices without a family.
//
// Rates follow the content: 8 kHz for sounds below ~1.5 kHz (the generic
// breath and chew, suck, ear flaps), 11.025 kHz for water and blows, 16 kHz for transients up to 6 kHz
// and the family banks (their presence lies at 1–5 kHz), 22.05 kHz only for
// gravel crunch. No baked reverb: the engine's shared outdoor reverb places
// them. Tails are short (no reverb to ring out).

import type { Rng } from '../../core/rng';
import type { Formant, Kit, NoiseColor, Pt } from '../kit';
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
  'fx.breath.cat': 3,
  'fx.breath.pachyderm': 3,
  'fx.breath.bear': 3,
  'fx.breath.grazer': 3,
  'fx.breath.equid': 3,
  'fx.breath.primate': 3,
  'fx.breath.bird': 3,
  'fx.chew.cat': 3,
  'fx.chew.pachyderm': 3,
  'fx.chew.bear': 3,
  'fx.chew.grazer': 3,
  'fx.chew.equid': 3,
  'fx.chew.primate': 3,
  'fx.chew.bird': 3,
  'fx.drink.cat': 3,
  'fx.drink.pachyderm': 3,
  'fx.drink.bear': 3,
  'fx.drink.grazer': 3,
  'fx.drink.equid': 3,
  'fx.drink.primate': 3,
  'fx.drink.bird': 3,
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

/** One resonant bubble at t0: a sine at f Hz, rising by `rise`, decaying with time constant tau. */
function bubble(sr: number, len: number, t0: number, f: number, tau: number, rise: number): Float32Array {
  const out = new Float32Array(Math.ceil(len * sr));
  let ph = 0;
  for (let i = Math.floor(t0 * sr), j = 0; i < out.length; i++, j++) {
    const t = j / sr;
    ph += (2 * Math.PI * f * (1 + rise * Math.min(1, t / (3 * tau)))) / sr;
    out[i] = Math.sin(ph) * Math.exp(-t / tau);
  }
  return out;
}

function dive(k: Kit): void {
  const r = k.rng;
  // the body hitting the water: felt on headphones, lost on a phone speaker...
  k.thump(0.01, 90 * r.range(0.9, 1.1), 45, 0.15, 0.45, { wet: 0 });
  // ...so the plop of the closing air cavity carries the dive at 0.6–1.5 kHz
  pcm(k, bubble(k.sr, 0.4 + TAIL, r.range(0.02, 0.04), r.range(650, 1000), r.range(0.03, 0.045), r.range(0.2, 0.35)), 0, 0.6);
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

// ------------------------------------------------------------------ family close-ups (breath, chew, drink)

interface BlowOpts {
  color?: NoiseColor;
  /** Band centre contour [offset s, Hz] and Q. */
  band: readonly Pt[];
  q?: number;
  type?: BiquadFilterType;
  /** Periodic flutter [Hz, depth 0..1]: soft palate, nostrils, trunk tip. */
  flutter?: readonly [number, number];
  /** Series peaking resonances [Hz, gain dB, Q]. */
  peaks?: readonly Formant[];
  level?: number;
}

/** Shaped breath noise: band-passed, optionally fluttering (periodic AM), through resonances. */
function blow(k: Kit, t: number, d: number, amp: readonly Pt[], o: BlowOpts): void {
  const nz = k.noise(o.color ?? 'pink', t, t + d + 0.02);
  const f = k.bq(o.type ?? 'bandpass', o.band[0][1], o.q ?? 0.7);
  k.path(f.frequency, t, o.band, 'exp');
  let node: AudioNode = k.chain(nz, f);
  if (o.flutter) {
    const [hz, depth] = o.flutter;
    const g = k.gain(1 - depth / 2);
    k.mod(k.osc('sine', t, t + d + 0.02, hz), depth / 2, g.gain);
    node = k.chain(node, g);
  }
  const e = k.gain(0);
  node = k.chain(node, e);
  k.path(e.gain, t, amp);
  for (const [hz, db, q] of o.peaks ?? []) node = k.chain(node, k.bq('peaking', hz, q, db));
  k.send(node, o.level ?? 1, 0);
}

/** Exhale envelope: quick onset, a sustained blow, then the fall. */
function exhale(d: number, att: number): Pt[] {
  return [
    [0, 0],
    [att, 1],
    [d * 0.55, 0.75],
    [d, 0],
  ];
}

/** Inhale envelope: soft swell and cut-off. */
function inhale(d: number): Pt[] {
  return [
    [0, 0],
    [d * 0.65, 1],
    [d, 0],
  ];
}

/** A swallow: a wet click over a short falling 'glk' (kept low: a phone speaker drops it). */
function gulp(k: Kit, t: number, f: number, level: number): void {
  k.thump(t, f, f * 0.6, 0.05, level * 0.4, { wet: 0 });
  tick(k, t + 0.004, f * 4, 2, 0.015, level);
}

/** Jaw / chew crunch at t: crackle through a band, with a dull jaw knock. */
function crunch(k: Kit, t: number, len: number, rate: number, hz: number, q: number, knock: number, level = 1): void {
  const r = k.rng;
  pcm(k, crackle(k.sr, len, r, rate, Math.min(0.02, len * 0.2), len / 3), t, level, k.bq('bandpass', hz * r.range(0.9, 1.1), q));
  if (knock) k.thump(t + 0.005, knock * r.range(0.9, 1.1), knock * 0.7, 0.05, 0.35 * level, { wet: 0 });
}

/** One breath per family: `v` picks a pattern so the variants differ in shape, not only in noise. */
const BREATH: Readonly<Record<string, (k: Kit, v: number) => void>> = {
  // big cat: a rough nasal huff (soft palate flutter, nasal resonances up to 3.5 kHz), a soft inhale
  cat: (k, v) => {
    const r = k.rng;
    const d = r.range(0.75, 0.9);
    const pulses = v === 2 ? 2 : 1; // a chuffing double exhale
    for (let i = 0; i < pulses; i++) {
      const dd = d / pulses;
      blow(k, i * dd * 1.1, dd, exhale(dd, 0.025), {
        color: 'white',
        band: [[0, r.range(1300, 1600)], [dd, r.range(800, 950)]],
        q: 0.55,
        flutter: [r.range(22, 34), r.range(0.45, 0.6)],
        peaks: [[r.range(650, 750), 5, 1.4], [r.range(2000, 2400), 5, 2], [r.range(3200, 3700), 4, 2.5]],
      });
    }
    blow(k, 0, d, exhale(d, 0.04), { band: [[0, 220]], type: 'lowpass', q: 0.8, level: 0.4 });
    if (v !== 1) blow(k, d + r.range(0.1, 0.16), 0.24, inhale(0.24), { color: 'white', band: [[0, 2600]], q: 0.8, peaks: [[3400, 3, 2]], level: 0.45 });
  },
  // trunk / big nostril blow: a tube comb (harmonics of a ~1.8 m pipe) over a broad whoosh
  pachyderm: (k, v) => {
    const r = k.rng;
    const d = r.range(0.9, 1.05);
    const pipe = r.range(85, 105);
    const nz = k.noise('pink', 0, d + 0.02);
    const sum = k.gain(1);
    for (let h = 2; h <= 9; h++) {
      const b = k.bq('bandpass', pipe * h * r.range(0.98, 1.02), 7);
      nz.connect(b);
      b.connect(k.gain(1.6 / Math.sqrt(h), sum));
    }
    k.chain(nz, k.bq('bandpass', 1400, 0.5), k.gain(0.35, sum));
    let node: AudioNode = sum;
    if (v === 1) {
      // trunk-tip flutter
      const g = k.gain(0.7);
      k.mod(k.osc('sine', 0, d + 0.02, r.range(14, 20)), 0.3, g.gain);
      node = k.chain(node, g);
    }
    const e = k.gain(0);
    k.chain(node, e);
    k.path(e.gain, 0, exhale(d, 0.06));
    k.send(e, 1, 0);
    if (v === 2) blow(k, d + 0.12, 0.32, inhale(0.32), { band: [[0, 700], [0.32, 1100]], q: 1.2, level: 0.5 });
  },
  // bear: a deep, moist huffing breath with a short grunt of voice
  bear: (k, v) => {
    const r = k.rng;
    const d = r.range(0.85, 1.0);
    blow(k, 0, d, exhale(d, 0.03), {
      band: [[0, r.range(650, 800)], [d, 500]],
      q: 0.6,
      flutter: [r.range(32, 45), 0.35],
      peaks: [[r.range(380, 450), 5, 1.2], [r.range(1000, 1200), 4, 1.5], [2400, 2, 2]],
    });
    if (v !== 0) k.thump(0.01, r.range(110, 130), 85, 0.12, 0.35, { wet: 0 });
    blow(k, d + r.range(0.08, 0.14), 0.26, inhale(0.26), { color: 'white', band: [[0, 1800]], q: 0.9, level: 0.45 });
  },
  // grazer: a soft, airy nasal exhale; some variants flutter the nostrils
  grazer: (k, v) => {
    const r = k.rng;
    const d = r.range(0.85, 1.0);
    blow(k, 0, d, exhale(d, 0.07), {
      band: [[0, r.range(1100, 1400)], [d, 900]],
      q: 0.5,
      flutter: v === 1 ? [r.range(38, 50), 0.3] : undefined,
      peaks: [[r.range(850, 1000), 3, 1.5], [2600, 2, 2]],
    });
    blow(k, d + r.range(0.08, 0.15), 0.25, inhale(0.25), { color: 'white', band: [[0, 2200]], q: 0.8, level: 0.5 });
  },
  // equid: a horse's exhale through fluttering nostrils
  equid: (k, v) => {
    const r = k.rng;
    const d = r.range(0.8, 0.95);
    blow(k, 0, d, exhale(d, 0.04), {
      band: [[0, r.range(900, 1100)], [d, 700]],
      q: 0.55,
      flutter: [r.range(24, 34), v === 2 ? 0.75 : 0.55],
      peaks: [[r.range(550, 650), 4, 1.5], [r.range(1700, 1900), 3, 2]],
    });
    blow(k, d + r.range(0.08, 0.13), 0.22, inhale(0.22), { color: 'white', band: [[0, 2000]], q: 0.9, level: 0.45 });
  },
  // primate: a heavy, human-like breath through nose and mouth
  primate: (k, v) => {
    const r = k.rng;
    const d = r.range(0.75, 0.9);
    const mouth = v === 1;
    blow(k, 0, d, exhale(d, 0.05), {
      band: [[0, mouth ? 1300 : 1000]],
      q: 0.5,
      peaks: [[r.range(480, 560), 4, 1.5], [r.range(1400, 1600), 4, 2], [r.range(2500, 2800), 3, 2.5]],
    });
    blow(k, d + r.range(0.1, 0.16), 0.28, inhale(0.28), { color: 'white', band: [[0, 2100]], q: 0.7, peaks: [[3000, 3, 2]], level: 0.5 });
  },
  // bird: two quick, small breaths through the beak with a faint wheeze (a sleeping penguin or flamingo)
  bird: (k, v) => {
    const r = k.rng;
    let t = 0;
    for (let i = 0; i < 2; i++) {
      const d = r.range(0.14, 0.2);
      const a = i ? r.range(0.6, 0.8) : 1;
      blow(k, t, d, exhale(d, 0.02), { color: 'white', band: [[0, r.range(2400, 3200)]], q: 0.9, peaks: [[r.range(1700, 2100), 4, 2]], level: a });
      const f = r.range(1800, 2600) * (v === 1 ? 1.25 : 1);
      k.tone({ t: t + 0.02, dur: d * 0.8, wave: 'sine', f: [[0, f], [d * 0.8, f * 0.9]], amp: [[0, 0], [0.03, 0.18 * a], [d * 0.8, 0]], wet: 0 });
      blow(k, t + d + r.range(0.08, 0.14), 0.13, inhale(0.13), { color: 'white', band: [[0, 3500]], q: 1, level: 0.45 * a });
      t += d + r.range(0.25, 0.32);
    }
  },
};

/** One chewing gesture per family (0.45–0.6 s; the fauna module plays one every 1.2 s). */
const CHEW: Readonly<Record<string, (k: Kit, v: number) => void>> = {
  // carnivore: a wet tear, then crunching bone at 1–5 kHz
  cat: (k, v) => {
    const r = k.rng;
    const tear = r.range(0.12, 0.18);
    blow(k, 0, tear, [[0, 0], [0.01, 1], [tear * 0.6, 0.7], [tear, 0]], { color: 'white', band: [[0, 1300], [tear, 900]], q: 0.7, flutter: [r.range(60, 90), 0.8] });
    for (let i = 0; i < (v === 1 ? 1 : 2); i++) crunch(k, tear + 0.06 + i * r.range(0.14, 0.2), r.range(0.05, 0.08), 900, r.range(2600, 3800), 0.6, 140);
  },
  // pachyderm: big molars grinding grass, with a dry rustle as it is stuffed in
  pachyderm: (k, v) => {
    const r = k.rng;
    crunch(k, 0, r.range(0.3, 0.38), 350, r.range(650, 850), 0.6, 70);
    if (v !== 2) pcm(k, crackle(k.sr, 0.3, r, 700, 0.05, 0.1), r.range(0.05, 0.15), 0.25, k.bq('highpass', 2500));
  },
  // bear: a lip smack and a crunch
  bear: (k, v) => {
    const r = k.rng;
    tick(k, 0.005, r.range(1300, 1700), 1.5, 0.03, 0.8);
    crunch(k, r.range(0.08, 0.12), r.range(0.12, 0.18), 600, r.range(1600, 2200), 0.6, 110);
    if (v === 1) tick(k, 0.32, r.range(1200, 1500), 1.5, 0.025, 0.6);
  },
  // grazer: side-to-side molar grind, fibrous
  grazer: (k, v) => {
    const r = k.rng;
    const n = v === 2 ? 1 : 2;
    for (let i = 0; i < n; i++) crunch(k, i * r.range(0.22, 0.28), r.range(0.15, 0.2), 450, r.range(1300, 1700), 0.7, 105, 1 - i * 0.2);
  },
  // equid: crisp munching
  equid: (k, v) => {
    const r = k.rng;
    for (let i = 0; i < 2; i++) crunch(k, i * r.range(0.2, 0.26), r.range(0.07, 0.11), 1100, r.range(2400, 3200), 0.7, 125, i && v === 1 ? 0.7 : 1);
  },
  // primate: a stem snapping, then chewing with the lips smacking
  primate: (k, v) => {
    const r = k.rng;
    if (v !== 1) pcm(k, crackle(k.sr, 0.03, r, 4000, 0.002, 0.008), 0, 0.9, k.bq('bandpass', r.range(2800, 3600), 0.8));
    crunch(k, r.range(0.06, 0.1), r.range(0.14, 0.2), 500, r.range(1000, 1300), 0.7, 120, 0.8);
    tick(k, r.range(0.32, 0.38), r.range(1400, 1800), 1.4, 0.025, 0.5);
  },
  // bird: beak clacks on a fish or shrimp, and a swallow
  bird: (k, v) => {
    const r = k.rng;
    const n = v === 0 ? 3 : 2 + (v % 2) * 3;
    for (let i = 0; i < n; i++) pcm(k, modes(k.sr, 0.03, 0.001, [[r.range(2600, 3400), 0.6, 0.006], [r.range(4200, 5200), 0.4, 0.004]]), i * r.range(0.06, 0.09), 0.8);
    gulp(k, n * 0.08 + r.range(0.05, 0.1), r.range(500, 650), 0.6);
  },
};

/** One lap, sip or scoop per family (the fauna module plays one every LAP_SPACING s). */
const DRINK: Readonly<Record<string, (k: Kit, v: number) => void>> = {
  // cats lap: a tongue flick and a few droplets
  cat: (k) => {
    const r = k.rng;
    blow(k, 0, 0.05, [[0, 0], [0.006, 1], [0.05, 0]], { color: 'white', band: [[0, r.range(1100, 1500)]], q: 0.9, level: 0.6 });
    pcm(k, droplets(k.sr, 0.16, r, onsets(r, r.int(2, 4), 0.01, 0.1), [900, 2200]), 0, 0.45);
  },
  // pachyderm (hippo, rhino on land): a big wet slurp
  pachyderm: (k) => {
    const r = k.rng;
    blow(k, 0, 0.16, [[0, 0], [0.03, 1], [0.12, 0.6], [0.16, 0]], { color: 'white', band: [[0, 450], [0.16, 950]], q: 1.2, flutter: [r.range(20, 28), 0.5] });
    pcm(k, droplets(k.sr, 0.2, r, onsets(r, r.int(2, 3), 0.04, 0.15), [450, 1200]), 0, 0.4);
  },
  // bears: a heavier, sloppier lap
  bear: (k) => {
    const r = k.rng;
    blow(k, 0, 0.08, [[0, 0], [0.008, 1], [0.08, 0]], { color: 'white', band: [[0, r.range(850, 1100)]], q: 0.7, level: 0.7 });
    pcm(k, droplets(k.sr, 0.18, r, onsets(r, r.int(3, 5), 0.01, 0.12), [600, 1800]), 0, 0.5);
  },
  // grazers sip: a short suction and a swallow
  grazer: (k) => {
    const r = k.rng;
    blow(k, 0, 0.1, [[0, 0], [0.04, 1], [0.1, 0]], { color: 'white', band: [[0, 1200], [0.1, 1800]], q: 1.5 });
    gulp(k, r.range(0.11, 0.14), r.range(280, 340), 0.5);
  },
  // equids suck in a long draw, then gulp
  equid: (k) => {
    const r = k.rng;
    blow(k, 0, 0.13, [[0, 0], [0.03, 1], [0.13, 0]], { color: 'white', band: [[0, 650], [0.13, 1150]], q: 1.3, flutter: [r.range(18, 24), 0.5] });
    gulp(k, r.range(0.13, 0.16), r.range(320, 380), 0.6);
  },
  // primates slurp from a cupped hand
  primate: (k) => {
    const r = k.rng;
    blow(k, 0, 0.12, [[0, 0], [0.02, 1], [0.12, 0]], { color: 'white', band: [[0, 900], [0.12, 1450]], q: 1, level: 0.7 });
    pcm(k, droplets(k.sr, 0.16, r, onsets(r, r.int(1, 3), 0.02, 0.1), [1000, 2500]), 0, 0.4);
  },
  // birds dip the beak: a tiny scoop splash, bright droplets, a small swallow
  bird: (k) => {
    const r = k.rng;
    blow(k, 0, 0.04, [[0, 0], [0.004, 1], [0.04, 0]], { color: 'white', band: [[0, r.range(2300, 2900)]], q: 1, level: 0.6 });
    pcm(k, droplets(k.sr, 0.16, r, onsets(r, r.int(3, 5), 0.005, 0.09), [1500, 3500]), 0, 0.5);
    gulp(k, r.range(0.1, 0.13), r.range(550, 700), 0.35);
  },
};

// ------------------------------------------------------------------ registry

function bank(base: FoleyBank, n: number, r: Omit<Recipe, 'build'>, build: (k: Kit) => void): Record<string, Recipe> {
  const out: Record<string, Recipe> = {};
  const recipe: Recipe = { ...r, build };
  if (n === 0) out[base] = recipe;
  // one Recipe per id: the per-id seed makes each variant different
  for (let i = 0; i < n; i++) out[`${base}#${i}`] = { ...recipe };
  return out;
}

type FamilyGen = (k: Kit, v: number) => void;

/** `fx.<kind>.<family>#v` for every family of a kind; `v` reaches the generator so variants differ in shape. */
function familyBanks(kind: 'breath' | 'chew' | 'drink', gens: Readonly<Record<string, FamilyGen>>, r: Omit<Recipe, 'build' | 'dur'>, dur: Readonly<Record<string, number>>): Record<string, Recipe> {
  const out: Record<string, Recipe> = {};
  for (const [family, gen] of Object.entries(gens)) {
    const n = FOLEY_BANKS[`fx.${kind}.${family}` as FoleyBank];
    for (let v = 0; v < n; v++) out[`fx.${kind}.${family}#${v}`] = { ...r, dur: dur[family], build: (k) => gen(k, v) };
  }
  return out;
}

/** Longest content of each family's breath / chew / drink, s (silent ends are trimmed at render). */
const BREATH_S = { cat: 1.3, pachyderm: 1.5, bear: 1.4, grazer: 1.4, equid: 1.3, primate: 1.35, bird: 1.0 };
const CHEW_S = { cat: 0.6, pachyderm: 0.45, bear: 0.45, grazer: 0.55, equid: 0.45, primate: 0.45, bird: 0.6 };
const DRINK_S = { cat: 0.18, pachyderm: 0.22, bear: 0.2, grazer: 0.22, equid: 0.24, primate: 0.18, bird: 0.22 };

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
  ...familyBanks('breath', BREATH, { rate: 16000, hp: 60, ...OTHER }, BREATH_S),
  ...familyBanks('chew', CHEW, { rate: 16000, hp: 80, ...OTHER }, CHEW_S),
  ...familyBanks('drink', DRINK, { rate: 16000, hp: 150, ...SPLASH }, DRINK_S),
};
