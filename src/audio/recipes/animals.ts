// Animal vocalisations and ambient wildlife one-shots.
//
// Every species has a bank of syllable types ('roar', 'grunt', 'honk'...),
// each rendered in several variants (`syl.<voice>.<type>#k`); the fauna module
// strings them into bouts (speciesAudio.ts). Voiced syllables use the glottal
// pulse source and parallel vocal tract of ../voice.ts; breaths, snorts and
// clicks are shaped noise. Each variant id has its own seed, so k.rng gives
// every variant its own contour, timing and nonlinear episodes, and its
// duration is a fixed point spread across the syllable's range.
//
// `call.<voice>` / `idle.<voice>` are short composites of the same syllables
// for the engine's built-in animal path; `amb.*` are ambient wildlife one-shots.

import type { Formant, Kit, NoiseColor, Note, Pt } from '../kit';
import type { Recipe } from '../render';
import { voice, type Formant3 } from '../voice';

/** Baked room: short, because the engine adds distance-dependent outdoor reverb. */
const REV = { decay: 0.3, length: 1.3, bright: 0.45 };
/** Baked reverb send of every syllable. */
const WET = 0.05;
/** Render tail after a syllable (resonances and the short baked reverb). */
const TAIL = 0.15;

/** Per-call overrides used when syllables are layered as colony grains. */
export interface GrainOpts {
  /** Scales every frequency of the voiced parts. */
  pitch?: number;
  /** Linear output level. */
  level?: number;
  /** Dry destination instead of the kit's output bus. */
  dest?: AudioNode;
}

/**
 * Syllable generator: schedules one syllable of `d` seconds at `t`. `v` is the
 * variant index (contour family). Generators used for colony grains honour `o`.
 */
export type SylGen = (k: Kit, t: number, d: number, v: number, o?: GrainOpts) => void;

export interface SylDef {
  /** Variants, registered as #0..n−1. */
  n: number;
  /** Duration range, s: variant k gets a fixed point spread across it. */
  d: readonly [number, number];
  rate: 16000 | 22050;
  gen: SylGen;
  /** Idle-type syllable (normalised to RMS 0.12 instead of 0.14). */
  idle?: boolean;
  /** Final high-pass, Hz. */
  hp?: number;
}

/** Golden-ratio spread in [0, 1): variants 0, 1, 2... land far apart. */
function spread(v: number): number {
  return (0.5 + v * 0.618034) % 1;
}

export function variantDur(def: SylDef, v: number): number {
  return def.d[0] + (def.d[1] - def.d[0]) * spread(v);
}

/** Registry id of variant k of a syllable type. */
export function sylId(voiceId: string, syl: string, k: number): string {
  return `syl.${voiceId}.${syl}#${k}`;
}

// ------------------------------------------------------------------ helpers

/** Envelope: rise to 1 over `a` s, fall to `s` by d − r, then to 0 at d. */
function env(d: number, a: number, r: number, s = 0.8): Pt[] {
  const a1 = Math.min(a, d * 0.5);
  return [
    [0, 0],
    [a1, 1],
    [Math.max(a1, d - r), s],
    [d, 0],
  ];
}

/** Sharp-onset decaying envelope (snorts, huffs, clicks). */
function hit(d: number, att = 0.006, mid = 0.35): Pt[] {
  return [
    [0, 0],
    [Math.min(att, d * 0.3), 1],
    [d * mid, 0.55],
    [d, 0],
  ];
}

interface BandOpts {
  color?: NoiseColor;
  /** Variant index: scales the band and resonances by vshift(v). */
  v?: number;
  level?: number;
  /** Amplitude flutter [rate Hz, depth 0..1] (lips, nostrils). */
  am?: readonly [number, number];
  /** Series peaking resonances [Hz, gain dB, Q]. */
  peaks?: readonly Formant[];
}

/** Band-limited noise lo..hi Hz shaped by `amp` (offsets from t). */
function band(k: Kit, t: number, d: number, amp: readonly Pt[], lo: number, hi: number, o: BandOpts = {}): void {
  const r = k.rng;
  // every call gets its own band edges and resonances (variants must not be copies)
  const s = o.v === undefined ? 1 : vshift(o.v);
  lo *= s * r.range(0.9, 1.1);
  hi *= s * r.range(0.9, 1.1);
  const nz = k.noise(o.color ?? 'white', t, t + d + 0.02);
  let node: AudioNode = k.chain(nz, k.bq('highpass', lo), k.bq('lowpass', Math.min(hi, k.nyquist * 0.9)));
  if (o.am) {
    const g = k.gain(1 - o.am[1] / 2);
    k.mod(k.osc('sine', t, t + d + 0.02, o.am[0]), o.am[1] / 2, g.gain);
    node = k.chain(node, g);
  }
  const e = k.gain(0);
  node = k.chain(node, e);
  k.path(e.gain, t, amp);
  for (const [hz, db, q] of o.peaks ?? []) node = k.chain(node, k.bq('peaking', hz * s * r.range(0.9, 1.1), q, db));
  k.send(node, o.level ?? 1, WET);
}

/** Pitch contour with abrupt register breaks: base sampled finely, × 2^(semis/12) after each break. */
function withBreaks(base: readonly Pt[], d: number, breaks: readonly (readonly [number, number])[]): Pt[] {
  const times = new Set<number>();
  for (let i = 0; i <= 24; i++) times.add((d * i) / 24);
  for (const [tb] of breaks) {
    times.add(tb);
    times.add(tb + 0.004);
  }
  const sorted = [...times].filter((x) => x <= d).sort((a, b) => a - b);
  return sorted.map((x) => {
    let f = 1;
    for (const [tb, semis] of breaks) if (x >= tb + 0.004) f *= Math.pow(2, semis / 12);
    return [x, baseAt(base, x) * f] as const;
  });
}

function baseAt(pts: readonly Pt[], x: number): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++)
    if (x <= pts[i][0]) {
      const [a, va] = pts[i - 1];
      const [b, vb] = pts[i];
      return va * Math.pow(vb / va, (x - a) / Math.max(1e-6, b - a));
    }
  return pts[pts.length - 1][1];
}

/** Amplitude contour with a sinusoidal tremolo (bleats: AM, not FM). */
function tremolo(d: number, base: readonly Pt[], hz: number, depth: number): Pt[] {
  const n = Math.max(8, Math.ceil(d * hz * 6));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const x = (d * i) / n;
    let a = base[base.length - 1][1];
    for (let j = 1; j < base.length; j++)
      if (x <= base[j][0]) {
        const [t0, v0] = base[j - 1];
        a = v0 + (base[j][1] - v0) * ((x - t0) / Math.max(1e-6, base[j][0] - t0));
        break;
      }
    out.push([x, a * (1 - depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * hz * x)))]);
  }
  return out;
}

/**
 * Irregular fast f0 wander of big voices (±cents at ~14 random knots per
 * second): the unsteadiness real roars and moans have. Random, not a
 * periodic vibrato.
 */
function flutter(r: Kit['rng'], d: number, base: readonly Pt[], cents: number): Pt[] {
  return wobble(r, d, base, cents, Math.max(4, Math.round(d * 14)));
}

/** Pitch contour with random wander: `base` resampled at `knots` points, each moved by ±cents. */
function wobble(r: Kit['rng'], d: number, base: readonly Pt[], cents: number, knots: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= knots; i++) {
    const x = (d * i) / knots;
    out.push([x, baseAt(base, x) * Math.pow(2, r.range(-cents, cents) / 1200)]);
  }
  return out;
}

/**
 * Spectral scale of variant v (0.7–1.35, consecutive variants far apart): each
 * variant gets its own vocal tract / nostril size, so variants are not copies.
 */
function vshift(v: number): number {
  return 0.7 + 0.65 * spread(v + 4);
}

/**
 * Variant formants: scaled by vshift(v) (when given; `depth` < 1 narrows the
 * range for low voices that need their presence bands) and moved by a random ±7 %.
 */
function vary(k: Kit, v: number | undefined, f: readonly Formant3[], depth = 1): Formant3[] {
  const s = v === undefined ? 1 : 1 + (vshift(v) - 1) * depth;
  return f.map(([hz, bw, db]) => [hz * s * k.rng.range(0.93, 1.07), bw * s, db] as const);
}

/** Scale a formant set's centres (individual / juvenile pitch). */
function shift(f: readonly Formant3[], s: number): Formant3[] {
  return f.map(([hz, bw, db]) => [hz * s, bw * s, db] as const);
}

// ------------------------------------------------------------------ lion

const F_LION: Formant3[] = [
  [300, 110, 0],
  [850, 160, -2],
  [1550, 230, -6],
  [2400, 320, -10],
];

const lionMoan: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: flutter(r, d, [[0, r.range(56, 66)], [d * r.range(0.4, 0.6), r.range(100, 120)], [d, r.range(74, 86)]], 45),
    amp: env(d, d * 0.35, d * 0.3, 0.75),
    oq: 0.4,
    jitter: 0.03,
    pd: [[0, 0.2, 0.3]],
    aspiration: 0.25,
    formants: vary(k, v, [[300, 110, -3], [800, 160, 0], [1500, 230, -6], [2400, 320, -10]]),
    drive: 1.2,
    noise: { level: 0.12, lo: 500, hi: 1400 },
  });
};

const lionRoar: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const at = r.range(0.3, 0.4);
  const pk = r.range(170, 200);
  const f1 = 300 * r.range(0.94, 1.06);
  const f2 = 850 * r.range(0.94, 1.06);
  voice(k, {
    t,
    dur: d,
    f0: flutter(r, d, [[0, r.range(70, 80)], [d * at * 0.4, r.range(110, 125)], [d * at, pk], [d * (at + 0.2), pk * r.range(0.86, 0.94)], [d * 0.8, r.range(105, 125)], [d, r.range(55, 65)]], 35),
    amp: [[0, 0], [d * 0.08, 0.75], [d * at, 1], [d * 0.78, 0.85], [d, 0]],
    oq: 0.45,
    jitter: 0.025,
    chaos: [[0.45, 0.8, r.range(0.06, 0.09)]],
    pd: [[0.8, 0.95, 0.3]],
    aspiration: 0.45,
    formants: vary(k, v, [[f1, 110, 0], [f2, 160, -1], [1550, 230, -6], [2400, 320, -10]], 0.4),
    fmove: [[[0, f1], [d, f1 * 0.9]], [[0, f2], [d, f2 * 0.9]]],
    drive: 1.3,
    noise: { level: 0.1, lo: 600, hi: 1500 },
  });
};

const lionGrunt: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: flutter(r, d, [[0, 91 * vshift(v + 1)], [d * 0.3, 85 * vshift(v + 1)], [d, r.range(55, 65)]], 45),
    amp: [[0, 0], [0.025, 1], [d * r.range(0.3, 0.6), 0.7], [d, 0]],
    oq: 0.4,
    jitter: 0.045,
    aspiration: 0.35,
    formants: vary(k, v, F_LION, 0.5),
    drive: 1.3,
    noise: { level: 0.18, lo: 500, hi: 1300 },
  });
};

/** Breath in before a roar; odd variants catch halfway (a two-stage breath). */
const lionInhale: SylGen = (k, t, d, v) => {
  const amp: Pt[] = v % 2 ? [[0, 0], [d * 0.3, 0.7], [d * 0.42, 0.25], [d * 0.75, 1], [d, 0]] : env(d, d * 0.6, d * 0.3, 0.9);
  band(k, t, d, amp, 300, 1200, { v, color: 'pink', peaks: [[650, 4, 1.5]] });
};

const lionHuff: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: [[0, r.range(80, 90)], [d, r.range(68, 76)]],
    amp: hit(d, 0.012, 0.4),
    oq: 0.5,
    jitter: 0.03,
    aspiration: 0.4,
    formants: vary(k, v, F_LION, 0.5),
    drive: 1,
    noise: { level: 0.35, lo: r.range(250, 400), hi: r.range(1300, 2000) },
  });
};

const lionGrowl: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: wobble(r, d, [[0, r.range(55, 65)], [d * r.range(0.3, 0.6), r.range(70, 80)], [d, r.range(50, 56)]], 80, 8),
    amp: env(d, 0.08, d * 0.3, 0.8),
    oq: 0.4,
    jitter: 0.05,
    chaos: [[0, 1, 0.05]],
    aspiration: 0.3,
    formants: vary(k, v, F_LION, 0.5),
    drive: 1.3,
    noise: { level: 0.1, lo: 400, hi: 1200 },
  });
};

// ------------------------------------------------------------------ tiger

const F_TIGER: Formant3[] = [
  [350, 90, 0],
  [1000, 150, -3],
  [2200, 250, -8],
];

const tigerMain: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const pk = r.range(140, 160);
  voice(k, {
    t,
    dur: d,
    f0: flutter(r, d, [[0, r.range(85, 95)], [d * r.range(0.25, 0.35), pk], [d * 0.6, pk * 0.88], [d, r.range(76, 84)]], 40),
    amp: [[0, 0], [d * 0.1, 0.85], [d * 0.3, 1], [d * 0.75, 0.8], [d, 0]],
    oq: 0.45,
    jitter: 0.03,
    chaos: [[0, 0.25, 0.08]],
    pd: [[0.7, 0.9, 0.3]],
    aspiration: 0.35,
    formants: vary(k, v, F_TIGER, 0.5),
    fmove: [[[0, 350], [d * 0.4, 400], [d, 330]]],
    drive: 1.3,
    noise: { level: 0.08, lo: 700, hi: 1800 },
  });
};

/** Prusten: unvoiced nasal puffs with lip flutter, 10–12 per second; no tone at all. */
const tigerPrusten: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const step = 1 / r.range(10, 12);
  const n = Math.max(3, Math.min(6, Math.round(d / step)));
  for (let i = 0; i < n; i++) {
    const len = r.range(0.06, 0.09);
    const a = (i === 0 ? 0.8 : 1) * r.range(0.75, 1);
    band(k, t + i * step, len, hit(len, 0.008, 0.4), 250, 2500, { v, color: 'pink', am: [r.range(25, 40), 0.9], peaks: [[700, 4, 1.4]], level: a });
  }
};

const tigerGrowl: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: flutter(r, d, [[0, r.range(45, 55)], [d * 0.5, r.range(60, 70)], [d, r.range(40, 46)]], 60),
    amp: env(d, 0.1, d * 0.3, 0.8),
    oq: 0.4,
    jitter: 0.05,
    chaos: [[0, 1, 0.05]],
    aspiration: 0.35,
    formants: vary(k, v, F_TIGER, 0.5),
    drive: 1.3,
    noise: { level: 0.12, lo: 400, hi: 1200 },
  });
};

const tigerHiss: SylGen = (k, t, d, v) => band(k, t, d, env(d, 0.03, d * 0.4, 0.7), 1000, 6000, { v, am: [k.rng.range(14, 22), 0.3] });

// ------------------------------------------------------------------ elephant

/** Nasal rumble formants with presence bands, so the 15–20 Hz pulsing is heard on a phone. */
const F_RUMBLE: Formant3[] = [
  [40, 30, -18],
  [165, 50, -14],
  [330, 80, 2.5],
  [520, 110, 5],
  [800, 160, 0],
  [1250, 220, -8],
];

const elephantRumble: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const s = r.range(0.94, 1.06);
  voice(k, {
    t,
    dur: d,
    f0: [[0, 13 * s], [d * r.range(0.2, 0.35), 20 * s], [d * 0.7, 18 * s], [d, 14 * s]],
    amp: env(d, d * 0.25, d * 0.3, 0.9),
    oq: 0.45,
    jitter: 0.03,
    shimmer: 0.1,
    aspiration: 0.3,
    formants: vary(k, v, F_RUMBLE, 0.25),
    drive: 1.6,
  });
};

/** Trumpet: a brassy blare (biased tanh) with abrupt register breaks and chaotic stretches, no vibrato. */
const elephantTrumpet: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const nb = r.int(2, 3);
  const breaks: (readonly [number, number])[] = [];
  for (let i = 0; i < nb; i++) breaks.push([d * r.range(0.15 + i * 0.25, 0.3 + i * 0.25), (r.chance(0.5) ? 1 : -1) * r.range(3, 5)]);
  const c0 = r.range(0.1, 0.35);
  voice(k, {
    t,
    dur: d,
    f0: flutter(r, d, withBreaks([[0, r.range(280, 320)], [d * 0.2, r.range(520, 580)], [d * 0.6, r.range(480, 540)], [d, r.range(330, 370)]], d, breaks), 20),
    amp: [[0, 0], [0.04, 0.9], [d * 0.2, 1], [d * 0.8, 0.85], [d, 0]],
    oq: 0.4,
    jitter: 0.04,
    chaos: [[c0, c0 + r.range(0.3, 0.6), r.range(0.04, 0.07)]],
    aspiration: 0.15,
    formants: vary(k, v, [[600, 150, 0], [1400, 250, -3], [2600, 400, -6]]),
    drive: 3,
    bias: 0.15,
    noise: { level: 0.12, lo: 1000, hi: 4000 },
    hp: 250,
  });
};

/** Snort through the trunk: a pipe comb (70 Hz spacing, 210–490 Hz) plus a 1–3 kHz blast. */
const elephantSnort: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const nz = k.noise('pink', t, t + d + 0.02);
  const sum = k.gain(1);
  const pipe = 70 * r.range(0.93, 1.07);
  for (let h = 3; h <= 7; h++) {
    const b = k.bq('bandpass', pipe * h, 8);
    nz.connect(b);
    b.connect(k.gain(2.2, sum));
  }
  k.chain(nz, k.bq('highpass', 1000), k.bq('lowpass', 3000), k.gain(0.5, sum));
  const e = k.gain(0);
  sum.connect(e);
  k.path(e.gain, t, [[0, 0], [0.012, 1], [d * 0.3, 0.7], [d * 0.7, 0.35], [d, 0]]);
  k.send(e, 1, WET);
};

// ------------------------------------------------------------------ hippo

const hippoWheeze: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: [[0, r.range(300, 360)], [d * 0.3, r.range(480, 560)], [d * 0.5, r.range(420, 480)], [d * 0.75, r.range(600, 700)], [d, r.range(360, 420)]],
    amp: [[0, 0], [d * 0.3, 0.6], [d * 0.8, 1], [d, 0]],
    oq: 0.5,
    jitter: 0.03,
    chaos: [[0.1, 0.9, 0.06]],
    aspiration: 0.3,
    formants: vary(k, v, [[600, 150, 0], [1200, 250, -3], [2400, 350, -6]]),
    drive: 1.3,
    noise: { level: 0.12, lo: 1000, hi: 3000 },
  });
};

const F_HIPPO: Formant3[] = [
  [180, 60, -8],
  [260, 80, -4],
  [650, 120, 0],
  [950, 150, -1],
  [2000, 300, -8],
];

const hippoHonk: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const s = r.range(0.88, 1.12);
  voice(k, {
    t,
    dur: d,
    f0: [[0, 100 * s], [d * r.range(0.3, 0.45), 180 * s], [d, 120 * s]],
    amp: [[0, 0], [0.015, 1], [d * 0.5, 0.8], [d, 0]],
    oq: 0.4,
    jitter: 0.015,
    pd: [[0, 0.3, 0.3]],
    aspiration: 0.2,
    formants: vary(k, v, F_HIPPO, 0.5),
    drive: 2.5,
  });
};

const hippoGrunt: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: [[0, 92 * vshift(v + 1)], [d, r.range(60, 70)]],
    amp: hit(d, 0.02, 0.5),
    oq: 0.4,
    jitter: 0.05,
    chaos: [[0, 1, 0.07]],
    aspiration: 0.3,
    formants: vary(k, v, [[220, 70, -6], [450, 110, 0], [900, 160, -2], [1800, 260, -10]]),
    drive: 1.3,
    noise: { level: 0.1, lo: 400, hi: 1200 },
  });
};

// ------------------------------------------------------------------ gorilla

const gorillaHoot: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: [[0, r.range(130, 170)], [d * r.range(0.6, 0.9), r.range(240, 310)], [d, r.range(230, 300)]],
    amp: env(d, d * 0.3, d * 0.3, 0.9),
    oq: 0.65,
    jitter: 0.01,
    tilt: 0.6,
    aspiration: 0.5,
    formants: vary(k, v, [[300, 80, 0], [700, 120, -4]]),
    lp: 1500,
  });
};

/** One chest-beat bout: 8–20 cupped-hand beats at 9–11/s, hands alternating ±8 % in pitch. */
const gorillaBeat: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const rate = r.range(9, 11);
  const n = Math.max(8, Math.min(20, Math.round(d * rate)));
  const chest = r.range(300, 700);
  for (let i = 0; i < n; i++) {
    const tt = t + i / rate + r.range(-0.01, 0.01);
    const a = Math.pow(Math.sin((Math.PI * (i + 0.5)) / n), 0.6) * r.range(0.85, 1);
    const f = chest * (i % 2 ? 1.08 : 0.92);
    band(k, Math.max(0, tt), 0.006, [[0, 0], [0.0008, a], [0.006, 0]], 1000, 3000, { v, level: 2.5 });
    k.burst({ t: Math.max(0, tt), dur: 0.12, color: 'pink', band: [[0, f]], q: 5, amp: [[0, 0], [0.002, a], [0.04, a * 0.37], [0.12, 0]], wet: WET });
    k.thump(Math.max(0, tt), f, f * 0.85, 0.14, a * 0.6, { wet: WET });
  }
};

/** Belch vocalisation: a smooth two-part closed-mouth nasal grunt. */
const gorillaBelch: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const f = r.range(80, 140);
  const d1 = d * 0.42;
  const gap = d * 0.06;
  // nasal murmur with presence bands so the low belch carries on a phone
  const F = vary(k, v, [[300, 80, -4], [700, 120, 0], [1100, 160, -3], [2000, 250, -12]]);
  voice(k, { t, dur: d1, f0: flutter(r, d1, [[0, f], [d1, f * 1.15]], 35), amp: env(d1, 0.03, d1 * 0.4, 0.8), oq: 0.35, jitter: 0.02, aspiration: 0.1, formants: F, drive: 1.4, lp: 2500 });
  const d2 = d - d1 - gap;
  voice(k, { t: t + d1 + gap, dur: d2, f0: flutter(r, d2, [[0, f * 1.1], [d2, f * 0.82]], 35), amp: env(d2, 0.03, d2 * 0.5, 0.75), oq: 0.35, jitter: 0.02, aspiration: 0.1, formants: F, drive: 1.4, lp: 2500, level: 0.85 });
};

const gorillaPiggrunt: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: [[0, 122 * vshift(v + 1)], [d, r.range(90, 100)]],
    amp: hit(d, 0.008, 0.5),
    oq: 0.4,
    jitter: 0.08,
    chaos: [[0, 1, 0.08]],
    aspiration: 0.3,
    formants: vary(k, v, [[400, 120, 0], [900, 180, -4], [1800, 250, -10]]),
    drive: 1.5,
  });
};

// ------------------------------------------------------------------ zebra

const F_BARK: Formant3[] = [
  [900, 180, 0],
  [2000, 300, -4],
  [3000, 400, -10],
];

/** One bray cycle: a noisy inhaled squeal, then the exhaled bark. */
const zebraCycle: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const inh = r.range(0.07, 0.12);
  const fi = r.range(900, 1400);
  voice(k, {
    t,
    dur: inh,
    f0: [[0, fi], [inh, fi * r.range(1.05, 1.2)]],
    amp: env(inh, 0.02, inh * 0.4, 0.8),
    jitter: 0.02,
    aspiration: 0.5,
    formants: vary(k, v, [[1400, 250, 0], [2800, 400, -6]]),
    noise: { level: 0.3, lo: 2000, hi: 5000 },
    level: Math.pow(10, -r.range(3, 6) / 20),
  });
  const tb = Math.min(d - 0.15, r.range(0.12, 0.16));
  const bd = d - tb;
  const s = r.range(0.88, 1.12);
  voice(k, {
    t: t + tb,
    dur: bd,
    f0: [[0, 350 * s], [bd * 0.3, 550 * s], [bd, 300 * s]],
    amp: [[0, 0], [0.015, 1], [bd * 0.4, 0.8], [bd, 0]],
    oq: 0.45,
    jitter: 0.02,
    chaos: [[0.3, 0.8, 0.05]],
    aspiration: 0.2,
    formants: vary(k, v, F_BARK),
    drive: 1.5,
  });
};

const zebraFinal: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const pk = 540 * r.range(0.92, 1.08);
  voice(k, {
    t,
    dur: d,
    f0: [[0, pk * 0.7], [d * 0.2, pk], [d, pk * 0.85 * 0.65]],
    amp: [[0, 0], [0.015, 1], [d * 0.5, 0.75], [d, 0]],
    oq: 0.45,
    jitter: 0.02,
    chaos: [[0.25, 0.7, 0.06]],
    aspiration: 0.25,
    formants: vary(k, v, F_BARK),
    drive: 1.5,
  });
};

/** Nostril blow: unvoiced flutter, 20–40 Hz AM, 200–2000 Hz. */
const zebraBlow: SylGen = (k, t, d, v) => band(k, t, d, env(d, 0.02, d * 0.5, 0.7), 200, 2000, { v, color: 'pink', am: [k.rng.range(20, 40), 0.85], peaks: [[600, 4, 1.5]] });

/** Alarm snort; odd variants are a quick double snort. */
const zebraSnort: SylGen = (k, t, d, v) => {
  if (v % 2 === 0) return band(k, t, d, hit(d, 0.005, 0.3), 500, 4000, { v, peaks: [[1200, 5, 2]] });
  band(k, t, d * 0.4, hit(d * 0.4, 0.004, 0.3), 500, 4000, { v, peaks: [[1200, 5, 2]], level: 0.7 });
  band(k, t + d * 0.45, d * 0.55, hit(d * 0.55, 0.004, 0.3), 500, 4000, { v, peaks: [[1200, 5, 2]] });
};

// ------------------------------------------------------------------ penguin

const F_BRAY: Formant3[] = [
  [1000, 200, 0],
  [2400, 350, -4],
  [3400, 500, -12],
];

/** Individual bray pitch per variant, 400–700 Hz. */
function brayF0(v: number, pitch: number): number {
  return (400 + 300 * spread(v + 3)) * pitch;
}

/** Exhaled donkey-like bray. */
function bray(k: Kit, t: number, d: number, v: number, f: number, sag: number, o: GrainOpts): void {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: [[0, f * 0.85], [d * 0.25, f], [d * 0.6, f * 0.95], [d, f * sag]],
    amp: [[0, 0], [0.02, 1], [d * 0.6, 0.8], [d, 0]],
    oq: 0.45,
    jitter: 0.02,
    chaos: [[r.range(0.2, 0.35), r.range(0.6, 0.75), 0.06]],
    aspiration: 0.25,
    formants: vary(k, v, shift(F_BRAY, Math.sqrt(f / 550))),
    drive: 1.5,
    level: o.level,
    dest: o.dest,
  });
}

/** Display pair: an inhaled noisy whistle, then the exhaled bray. */
export const penguinPair: SylGen = (k, t, d, v, o = {}) => {
  const r = k.rng;
  const inh = r.range(0.08, 0.15);
  const fw = r.range(600, 1000) * (o.pitch ?? 1);
  voice(k, {
    t,
    dur: inh,
    f0: [[0, fw], [inh, fw * 1.1]],
    amp: env(inh, inh * 0.4, inh * 0.3, 0.8),
    tilt: 0.5,
    jitter: 0.02,
    aspiration: 0.6,
    formants: vary(k, v, [[900, 150, 0], [1800, 250, -6]]),
    noise: { level: 0.4, lo: 700, hi: 1500 },
    level: 0.55 * (o.level ?? 1),
    dest: o.dest,
  });
  const tb = inh + 0.03;
  bray(k, t + tb, Math.max(0.12, d - tb), v, brayF0(v, o.pitch ?? 1), 0.9, o);
};

const penguinFinal: SylGen = (k, t, d, v) => bray(k, t, d, v, brayF0(v + 1, 1) * 1.05, 0.8, {});

export const penguinContact: SylGen = (k, t, d, v, o = {}) => bray(k, t, d, v, brayF0(v + 2, o.pitch ?? 1), 0.88, o);

// ------------------------------------------------------------------ flamingo

/** Goose-like honk; contours by variant: 0–3 rise-fall, 4–5 flat, 6–7 two-note 'ka-ha'. */
export const flamingoHonk: SylGen = (k, t, d, v, o = {}) => {
  const r = k.rng;
  const f = (450 + 400 * spread(v)) * (o.pitch ?? 1);
  const fam = v % 8;
  let f0: Pt[];
  let amp: Pt[];
  if (fam < 4) {
    f0 = [[0, f * 0.9], [d * r.range(0.25, 0.45), f * 1.12], [d, f * 0.85]];
    amp = [[0, 0], [0.012, 1], [d * 0.6, 0.8], [d, 0]];
  } else if (fam < 6) {
    f0 = [[0, f], [d, f * 0.97]];
    amp = [[0, 0], [0.012, 1], [d * 0.7, 0.85], [d, 0]];
  } else {
    f0 = [[0, f * 1.1], [d * 0.44, f * 1.05], [d * 0.48, f * 0.8], [d, f * 0.75]];
    amp = [[0, 0], [0.01, 1], [d * 0.4, 0.8], [d * 0.47, 0.2], [d * 0.53, 0.9], [d, 0]];
  }
  voice(k, {
    t,
    dur: d,
    f0,
    amp,
    oq: 0.45,
    jitter: 0.02,
    chaos: [[0, 0.3, 0.03]],
    aspiration: 0.15,
    formants: vary(k, v, [[1300, 250, 0], [2700, 400, -4]]),
    drive: 1.3,
    level: o.level,
    dest: o.dest,
  });
};

/** Low feeding grunt, 150–250 Hz. */
export const flamingoGrunt: SylGen = (k, t, d, v, o = {}) => {
  const r = k.rng;
  const f = (150 + 100 * spread(v + 1)) * (o.pitch ?? 1);
  voice(k, {
    t,
    dur: d,
    f0: [[0, f], [d, f * r.range(0.75, 0.85)]],
    amp: hit(d, 0.008, 0.5),
    oq: 0.4,
    jitter: 0.08,
    chaos: [[0, 1, 0.08]],
    aspiration: 0.3,
    formants: vary(k, v, [[400, 120, 0], [1000, 200, -4], [2200, 300, -10]]),
    drive: 1.5,
    level: o.level,
    dest: o.dest,
  });
};

// ------------------------------------------------------------------ bears

const F_BEAR: Formant3[] = [
  [380, 100, 0],
  [900, 150, -2],
  [1800, 250, -8],
];

/** Huff: a sharp nasal exhalation with a chest thump. */
const bearHuff: SylGen = (k, t, d, v) => {
  band(k, t, d, hit(d, 0.006, 0.3), 200, 2000, { v, color: 'pink', peaks: [[700, 4, 1.2]] });
  k.thump(t, 150, 110, 0.06, 0.7, { wet: WET });
};

/** Jaw pop: a 1–6 kHz click over a small knock; polar variants add tooth clicks and a lip smack. */
function jawpop(polar: boolean): SylGen {
  return (k, t) => {
    const r = k.rng;
    const len = r.range(0.01, 0.02);
    band(k, t, len, [[0, 0], [0.0005, 1], [len * 0.3, 0.4], [len, 0]], 1000, 6000, { level: 5 });
    k.thump(t, r.range(150, 300), r.range(110, 140), 0.03, 0.18, { wet: WET });
    if (!polar) return;
    for (let i = r.int(1, 2); i > 0; i--) {
      const tc = t + r.range(0.005, 0.015) * i;
      band(k, tc, 0.006, [[0, 0], [0.0004, 1], [0.006, 0]], 2000, 7000, { level: 3 });
    }
    band(k, t + r.range(0.025, 0.035), 0.025, hit(0.025, 0.003, 0.4), 400, 2500, { color: 'pink', level: 1.2 });
  };
}

const bearMoan: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: [[0, r.range(80, 90)], [d * r.range(0.3, 0.5), r.range(120, 140)], [d, r.range(82, 95)]],
    amp: env(d, d * 0.3, d * 0.35, 0.8),
    oq: 0.5,
    jitter: 0.015,
    aspiration: 0.4,
    formants: vary(k, v, F_BEAR),
    drive: 1.1,
    noise: { level: 0.08, lo: 400, hi: 1500 },
  });
};

const bearGrowl: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: [[0, r.range(55, 65)], [d * 0.5, r.range(80, 90)], [d, r.range(50, 56)]],
    amp: env(d, 0.1, d * 0.3, 0.8),
    oq: 0.4,
    jitter: 0.08,
    chaos: [[0, 1, 0.09]],
    aspiration: 0.35,
    formants: vary(k, v, F_BEAR),
    drive: 1.3,
    noise: { level: 0.12, lo: 400, hi: 1200 },
  });
};

const bearRoar: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: [[0, r.range(85, 95)], [d * 0.3, r.range(150, 170)], [d * 0.7, r.range(130, 145)], [d, r.range(75, 85)]],
    amp: [[0, 0], [d * 0.1, 0.85], [d * 0.3, 1], [d * 0.8, 0.85], [d, 0]],
    oq: 0.45,
    chaos: [[0.2, 0.8, 0.08]],
    pd: [[0.8, 0.95, 0.3]],
    aspiration: 0.4,
    formants: vary(k, v, F_BEAR),
    drive: 1.4,
    noise: { level: 0.12, lo: 500, hi: 1500 },
  });
};

/** Sniffing: 4–6 quick inhales at about 5 per second. */
const bearSniff: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const n = Math.max(4, Math.min(6, Math.round(d * 5)));
  const step = d / n;
  for (let i = 0; i < n; i++) {
    const len = step * r.range(0.5, 0.7);
    band(k, t + i * step + r.range(0, 0.02), len, env(len, len * 0.4, len * 0.4, 0.8), 1000, 3000, { v, level: r.range(0.6, 1), peaks: [[1700, 4, 2]] });
  }
};

/** Polar bear chuff: 3–6 nasal breath pulses at 6–8 per second. */
const bearChuff: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const step = 1 / r.range(6, 8);
  const n = Math.max(3, Math.min(6, Math.round(d / step)));
  for (let i = 0; i < n; i++) {
    const len = step * r.range(0.55, 0.75);
    band(k, t + i * step, len, hit(len, 0.008, 0.4), 500, 4000, { v, color: 'pink', peaks: [[1100, 5, 2]], am: [r.range(30, 45), 0.4], level: r.range(0.7, 1) });
  }
};

const bearHiss: SylGen = (k, t, d, v) => band(k, t, d, env(d, 0.04, d * 0.4, 0.75), 1500, 6000, { v, am: [k.rng.range(12, 20), 0.3] });

// ------------------------------------------------------------------ rhino

const rhinoSnort: SylGen = (k, t, d, v) => band(k, t, d, hit(d, 0.006, 0.3), 300, 4000, { v, color: 'pink', am: [k.rng.range(18, 30), 0.5], peaks: [[500, 6, 2], [1500, 6, 2]] });

const rhinoPuff: SylGen = (k, t, d, v) => band(k, t, d, env(d, 0.01, d * 0.6, 0.6), 300, 2000, { v, color: 'pink', peaks: [[600, 4, 1.5]] });

/** Panting: 3–5 baked breath pairs at about 3 per second. */
const rhinoPant: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const n = Math.max(3, Math.round(d * 3));
  const step = d / n;
  for (let i = 0; i < n; i++) {
    const t0 = t + i * step;
    band(k, t0, step * 0.5, hit(step * 0.5, 0.015, 0.4), 300, 1800, { v, color: 'pink', peaks: [[550, 5, 1.5]], level: r.range(0.8, 1) });
    band(k, t0 + step * 0.55, step * 0.35, env(step * 0.35, step * 0.15, step * 0.1, 0.8), 600, 2500, { v, color: 'pink', level: r.range(0.35, 0.5) });
  }
};

const rhinoHic: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const f = r.range(150, 250);
  voice(k, {
    t,
    dur: d,
    f0: [[0, f], [d, f * 0.8]],
    amp: hit(d, 0.006, 0.5),
    oq: 0.4,
    jitter: 0.02,
    aspiration: 0.3,
    formants: vary(k, v, [[400, 100, 0], [900, 150, -3], [2000, 250, -10]]),
    drive: 1.3,
  });
};

const rhinoGrowl: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: [[0, r.range(65, 75)], [d * 0.5, r.range(80, 90)], [d, r.range(60, 66)]],
    amp: env(d, 0.08, d * 0.3, 0.8),
    oq: 0.4,
    jitter: 0.07,
    chaos: [[0, 1, 0.08]],
    aspiration: 0.35,
    formants: vary(k, v, [[380, 100, 0], [880, 150, -2], [1800, 250, -8]]),
    drive: 1.3,
    noise: { level: 0.12, lo: 400, hi: 1300 },
  });
};

// ------------------------------------------------------------------ giraffe

const giraffeSnort: SylGen = (k, t, d, v) => band(k, t, d, hit(d, 0.008, 0.35), 400, 3000, { v, color: 'pink', peaks: [[900, 4, 1.5]] });

/** Nocturnal hum: low pulses with jitter, sometimes period-doubled; no vibrato. */
const giraffeHum: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const f = r.range(87, 96);
  voice(k, {
    t,
    dur: d,
    f0: [[0, f * 0.97], [d * 0.5, f * 1.03], [d, f * 0.96]],
    amp: env(d, Math.min(0.15, d * 0.3), d * 0.35, 0.85),
    oq: 0.6,
    jitter: 0.015,
    shimmer: 0.08,
    pd: v % 2 === 1 ? [[0.4, 0.6, 0.25]] : undefined,
    aspiration: 0.2,
    formants: vary(k, v, [[250, 60, 0], [520, 90, -3], [900, 150, -8]]),
    drive: 1.1,
  });
};

// ------------------------------------------------------------------ camel

const camelGroan: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: [[0, r.range(75, 85)], [d * r.range(0.3, 0.4), r.range(180, 210)], [d * 0.65, r.range(150, 175)], [d, r.range(85, 95)]],
    amp: env(d, d * 0.2, d * 0.3, 0.8),
    oq: 0.45,
    jitter: 0.03,
    chaos: [[r.range(0.15, 0.3), r.range(0.7, 0.85), 0.08]],
    aspiration: 0.35,
    formants: vary(k, v, [[450, 120, 0], [900, 160, -3], [2400, 300, -10]]),
    fmove: [[[0, 450], [d * 0.4, 700], [d, 500]], [[0, 900], [d * 0.4, 1250], [d, 950]]],
    drive: 1.3,
    noise: { level: 0.3, lo: 500, hi: 2500 },
  });
};

const camelGrumble: SylGen = (k, t, d, v) => {
  const r = k.rng;
  voice(k, {
    t,
    dur: d,
    f0: [[0, r.range(90, 110)], [d * 0.4, r.range(95, 110)], [d, r.range(70, 78)]],
    amp: env(d, 0.05, d * 0.35, 0.8),
    oq: 0.4,
    jitter: 0.06,
    chaos: [[0, 1, 0.07]],
    aspiration: 0.3,
    formants: vary(k, v, [[400, 110, 0], [850, 150, -3], [2000, 250, -10]]),
    drive: 1.3,
  });
};

/** Dulla display: 15–30 bubbles per second, each a damped rising sine, through mouth cavities. */
const camelGurgle: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const rate = r.range(15, 30);
  const sum = k.gain(1);
  for (let tb = t; tb < t + d - 0.04; tb += r.range(0.5, 1.5) / rate) {
    const f = r.range(150, 700);
    const len = r.range(0.02, 0.04);
    const o = k.osc('sine', tb, tb + len + 0.02, f);
    o.frequency.setValueAtTime(f, tb);
    o.frequency.exponentialRampToValueAtTime(f * 1.3, tb + len);
    const g = k.gain(0, sum);
    o.connect(g);
    const a = r.range(0.4, 1) * Math.min(1, (tb - t) / 0.2 + 0.3);
    g.gain.setValueAtTime(0, tb);
    g.gain.linearRampToValueAtTime(a, tb + 0.002);
    g.gain.setTargetAtTime(0, tb + 0.002, len / 3);
  }
  const out = k.gain(0.5);
  sum.connect(out);
  for (const [hz, q] of [
    [300, 3],
    [900, 3],
  ] as const) {
    const b = k.bq('bandpass', hz, q);
    sum.connect(b);
    b.connect(k.gain(1.5, out));
  }
  k.send(out, 1, WET);
};

// ------------------------------------------------------------------ gazelle

const gazelleSnort: SylGen = (k, t, d, v) => band(k, t, d, hit(d, 0.003, 0.3), 1000, 5000, { v });

/** Bleat: amplitude-modulated (6–10 Hz), not vibrato. */
const gazelleBleat: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const f = r.range(350, 700);
  voice(k, {
    t,
    dur: d,
    f0: [[0, f * 0.95], [d * 0.3, f * 1.05], [d, f * 0.9]],
    amp: tremolo(d, env(d, 0.04, d * 0.3, 0.8), r.range(6, 10), 0.45),
    oq: 0.5,
    jitter: 0.02,
    aspiration: 0.25,
    formants: vary(k, v, [[700, 120, 0], [1800, 250, -4], [3000, 400, -12]]),
    drive: 1.2,
  });
};

// ------------------------------------------------------------------ juveniles (tonal, high, few nonlinear phenomena)

const lionCub: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const f = r.range(360, 420);
  voice(k, {
    t,
    dur: d,
    f0: [[0, f], [d * 0.3, f * 1.35], [d * 0.55, f * 1.25], [d, f * 0.9]],
    amp: env(d, 0.03, d * 0.35, 0.8),
    oq: 0.55,
    jitter: 0.012,
    aspiration: 0.25,
    formants: vary(k, v, [[900, 160, 0], [1500, 220, -3], [2600, 350, -10]]),
    fmove: [[[0, 900], [d, 560]], [[0, 1500], [d, 950]]],
    drive: 1.1,
  });
};

const elephantCalf: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const f = r.range(520, 600);
  voice(k, {
    t,
    dur: d,
    f0: [[0, f], [d * 0.3, f * r.range(1.45, 1.55)], [d, f * 1.05]],
    amp: env(d, 0.03, d * 0.3, 0.85),
    oq: 0.5,
    jitter: 0.015,
    aspiration: 0.2,
    formants: vary(k, v, [[800, 150, 0], [1600, 250, -4], [2600, 400, -10]]),
    drive: 1.2,
  });
};

const zebraFoal: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const f = r.range(720, 820);
  voice(k, {
    t,
    dur: d,
    f0: [[0, f], [d * 0.2, f * 1.35], [d * 0.7, f * 1.22], [d, f * 0.95]],
    amp: tremolo(d, env(d, 0.03, d * 0.35, 0.85), r.range(9, 12), 0.3),
    oq: 0.5,
    jitter: 0.015,
    aspiration: 0.2,
    formants: vary(k, v, [[1200, 200, 0], [2400, 350, -5], [3600, 500, -12]]),
    drive: 1.2,
  });
};

/** Chick begging: 3–5 peeps of 0.1 s at 2–3 kHz. */
const penguinChick: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const n = Math.max(3, Math.min(5, Math.round(d / 0.15)));
  const step = d / n;
  for (let i = 0; i < n; i++) {
    const len = Math.min(0.1, step * 0.8);
    const f = r.range(2000, 3000);
    voice(k, {
      t: t + i * step,
      dur: len,
      f0: [[0, f * 0.9], [len * 0.4, f * 1.05], [len, f * 0.85]],
      amp: env(len, 0.01, len * 0.4, 0.85),
      oq: 0.6,
      jitter: 0.01,
      tilt: 0.4,
      aspiration: 0.25,
      formants: vary(k, v, [[2500, 700, 0], [4800, 900, -10]]),
      level: r.range(0.75, 1),
    });
  }
};

const hippoCalf: SylGen = (k, t, d, v) => {
  const r = k.rng;
  const f = r.range(300, 360);
  voice(k, {
    t,
    dur: d,
    f0: [[0, f], [d * 0.4, f * r.range(1.6, 1.75)], [d, f * 1.2]],
    amp: env(d, 0.02, d * 0.35, 0.85),
    oq: 0.5,
    jitter: 0.012,
    aspiration: 0.2,
    formants: vary(k, v, [[500, 120, 0], [1000, 180, -3], [2200, 300, -10]]),
    drive: 1.2,
  });
};

// ------------------------------------------------------------------ syllable banks

const BEAR: Record<string, SylDef> = {
  huff: { n: 4, d: [0.15, 0.3], rate: 16000, gen: bearHuff, hp: 150 },
  jawpop: { n: 4, d: [0.03, 0.03], rate: 22050, gen: jawpop(false), hp: 200 },
  moan: { n: 2, d: [0.6, 1.1], rate: 16000, gen: bearMoan, hp: 150 },
  growl: { n: 2, d: [0.8, 1.2], rate: 16000, gen: bearGrowl, hp: 150 },
  roar: { n: 1, d: [1.3, 1.3], rate: 16000, gen: bearRoar, hp: 150 },
  sniff: { n: 2, d: [0.8, 1.1], rate: 22050, gen: bearSniff, idle: true, hp: 300 },
};

/** Syllable banks per voice id: the single source of variant counts, durations and rates. */
export const SYLLABLES: Readonly<Record<string, Readonly<Record<string, SylDef>>>> = {
  lion: {
    moan: { n: 2, d: [0.6, 0.9], rate: 16000, gen: lionMoan, hp: 180 },
    roar: { n: 3, d: [1.3, 1.7], rate: 16000, gen: lionRoar, hp: 220 },
    grunt: { n: 5, d: [0.3, 0.45], rate: 16000, gen: lionGrunt, hp: 180 },
    inhale: { n: 2, d: [0.22, 0.32], rate: 16000, gen: lionInhale, hp: 200 },
    huff: { n: 3, d: [0.25, 0.4], rate: 16000, gen: lionHuff, idle: true, hp: 150 },
    growl: { n: 2, d: [0.7, 1.0], rate: 16000, gen: lionGrowl, hp: 180 },
    juv: { n: 3, d: [0.4, 0.7], rate: 22050, gen: lionCub, hp: 250 },
  },
  tiger: {
    main: { n: 3, d: [1.1, 1.5], rate: 16000, gen: tigerMain, hp: 150 },
    prusten: { n: 3, d: [0.4, 0.7], rate: 16000, gen: tigerPrusten, idle: true, hp: 200 },
    growl: { n: 2, d: [0.9, 1.3], rate: 16000, gen: tigerGrowl, hp: 150 },
    hiss: { n: 1, d: [0.5, 0.5], rate: 16000, gen: tigerHiss, hp: 600 },
  },
  grizzly: BEAR,
  polarbear: {
    ...BEAR,
    jawpop: { n: 4, d: [0.06, 0.06], rate: 22050, gen: jawpop(true), hp: 200 },
    chuff: { n: 3, d: [0.4, 0.8], rate: 22050, gen: bearChuff, idle: true, hp: 300 },
    hiss: { n: 1, d: [0.6, 0.6], rate: 22050, gen: bearHiss, hp: 800 },
  },
  elephant: {
    rumble: { n: 3, d: [2.0, 2.8], rate: 16000, gen: elephantRumble, hp: 130 },
    trumpet: { n: 3, d: [0.6, 1.4], rate: 22050, gen: elephantTrumpet, hp: 250 },
    snort: { n: 2, d: [0.3, 0.6], rate: 22050, gen: elephantSnort, idle: true, hp: 150 },
    juv: { n: 3, d: [0.3, 0.7], rate: 22050, gen: elephantCalf, hp: 300 },
  },
  hippo: {
    wheeze: { n: 2, d: [0.8, 1.3], rate: 16000, gen: hippoWheeze, hp: 250 },
    honk: { n: 5, d: [0.18, 0.3], rate: 16000, gen: hippoHonk, hp: 150 },
    grunt: { n: 3, d: [0.3, 0.5], rate: 16000, gen: hippoGrunt, hp: 150 },
    juv: { n: 3, d: [0.2, 0.5], rate: 16000, gen: hippoCalf, hp: 250 },
  },
  rhino: {
    snort: { n: 3, d: [0.2, 0.5], rate: 22050, gen: rhinoSnort, hp: 250 },
    puff: { n: 2, d: [0.1, 0.2], rate: 16000, gen: rhinoPuff, idle: true, hp: 250 },
    pant: { n: 2, d: [1.0, 1.6], rate: 16000, gen: rhinoPant, hp: 250 },
    hic: { n: 2, d: [0.08, 0.12], rate: 16000, gen: rhinoHic, idle: true, hp: 150 },
    growl: { n: 1, d: [0.9, 0.9], rate: 16000, gen: rhinoGrowl, hp: 150 },
  },
  giraffe: {
    snort: { n: 2, d: [0.2, 0.4], rate: 22050, gen: giraffeSnort, idle: true, hp: 300 },
    hum: { n: 3, d: [0.4, 1.6], rate: 16000, gen: giraffeHum, idle: true, hp: 120 },
  },
  camel: {
    groan: { n: 3, d: [1.0, 2.0], rate: 16000, gen: camelGroan, hp: 150 },
    grumble: { n: 3, d: [0.4, 0.8], rate: 16000, gen: camelGrumble, idle: true, hp: 150 },
    gurgle: { n: 2, d: [1.0, 1.6], rate: 16000, gen: camelGurgle, hp: 120 },
  },
  zebra: {
    cycle: { n: 5, d: [0.39, 0.49], rate: 22050, gen: zebraCycle, hp: 250 },
    final: { n: 2, d: [0.3, 0.4], rate: 22050, gen: zebraFinal, hp: 250 },
    blow: { n: 3, d: [0.4, 0.7], rate: 22050, gen: zebraBlow, idle: true, hp: 180 },
    snort: { n: 2, d: [0.12, 0.18], rate: 22050, gen: zebraSnort, hp: 400 },
    juv: { n: 3, d: [0.3, 0.6], rate: 22050, gen: zebraFoal, hp: 400 },
  },
  gazelle: {
    snort: { n: 3, d: [0.08, 0.15], rate: 22050, gen: gazelleSnort, hp: 600 },
    bleat: { n: 3, d: [0.3, 0.6], rate: 22050, gen: gazelleBleat, idle: true, hp: 250 },
  },
  gorilla: {
    hoot: { n: 4, d: [0.1, 0.3], rate: 16000, gen: gorillaHoot, hp: 120 },
    beat: { n: 3, d: [0.8, 1.4], rate: 22050, gen: gorillaBeat, hp: 150 },
    belch: { n: 4, d: [0.3, 0.7], rate: 16000, gen: gorillaBelch, idle: true, hp: 150 },
    piggrunt: { n: 3, d: [0.07, 0.1], rate: 16000, gen: gorillaPiggrunt, hp: 150 },
  },
  penguin: {
    pair: { n: 4, d: [0.35, 0.6], rate: 22050, gen: penguinPair, hp: 300 },
    final: { n: 3, d: [0.6, 1.1], rate: 22050, gen: penguinFinal, hp: 300 },
    contact: { n: 3, d: [0.3, 0.7], rate: 22050, gen: penguinContact, idle: true, hp: 300 },
    juv: { n: 3, d: [0.45, 0.75], rate: 22050, gen: penguinChick, hp: 800 },
  },
  flamingo: {
    honk: { n: 8, d: [0.1, 0.2], rate: 22050, gen: flamingoHonk, hp: 300 },
    grunt: { n: 4, d: [0.07, 0.1], rate: 22050, gen: flamingoGrunt, idle: true, hp: 120 },
  },
};

function sylRecipes(): Record<string, Recipe> {
  const out: Record<string, Recipe> = {};
  for (const [voiceId, bank] of Object.entries(SYLLABLES))
    for (const [syl, def] of Object.entries(bank))
      for (let v = 0; v < def.n; v++) {
        const d = variantDur(def, v);
        out[sylId(voiceId, syl, v)] = {
          dur: d,
          tail: TAIL,
          rate: def.rate,
          reverb: REV,
          peak: 0.85,
          rms: def.idle ? 0.12 : 0.14,
          // a per-variant low cut: variants differ in body as well as in contour
          hp: def.hp && def.hp * (0.8 + 0.5 * spread(v + 2)),
          build: (k) => def.gen(k, 0, d, v),
        };
      }
  return out;
}

// ------------------------------------------------------------------ legacy composites (built-in engine path)

type Part = readonly [voiceId: string, syl: string, t: number, d?: number];

/** A short representative bout of one species, one syllable per build slice. */
function composite(parts: readonly Part[], idle: boolean, rate: 16000 | 22050): Recipe {
  let end = 0;
  for (const [vo, syl, t, d] of parts) end = Math.max(end, t + (d ?? variantDur(SYLLABLES[vo][syl], 0)));
  return {
    dur: end,
    tail: 0.4,
    rate,
    reverb: REV,
    peak: idle ? 0.8 : 0.85,
    rms: idle ? 0.12 : 0.14,
    hp: 120,
    *build(k: Kit) {
      for (const [vo, syl, t, d] of parts) {
        const def = SYLLABLES[vo][syl];
        const v = k.rng.int(0, def.n - 1);
        def.gen(k, t, d ?? variantDur(def, v), v);
        yield;
      }
    },
  };
}

/** Grunt train: n grunts from t, intervals growing ×1.05 and level falling. */
function grunts(vo: string, syl: string, t: number, n: number, ioi: number): Part[] {
  const out: Part[] = [];
  for (let i = 0; i < n; i++) {
    out.push([vo, syl, t]);
    t += ioi;
    ioi *= 1.05;
  }
  return out;
}

const COMPOSITES: Record<string, Recipe> = {
  'call.lion': composite([['lion', 'moan', 0, 0.7], ['lion', 'roar', 0.85, 1.5], ...grunts('lion', 'grunt', 2.65, 4, 0.42)], false, 16000),
  'idle.lion': composite([['lion', 'huff', 0, 0.3], ['lion', 'huff', 0.45, 0.3]], true, 16000),
  'call.tiger': composite([['tiger', 'main', 0, 1.3], ['tiger', 'main', 1.6, 1.15]], false, 16000),
  'idle.tiger': composite([['tiger', 'prusten', 0, 0.55]], true, 16000),
  'call.grizzly': composite([['grizzly', 'huff', 0, 0.22], ['grizzly', 'huff', 0.4, 0.22], ['grizzly', 'jawpop', 0.8], ['grizzly', 'jawpop', 1.05], ['grizzly', 'jawpop', 1.4], ['grizzly', 'moan', 1.7, 0.9]], false, 16000),
  'idle.grizzly': composite([['grizzly', 'sniff', 0, 0.9]], true, 22050),
  'call.polarbear': composite([['polarbear', 'hiss', 0, 0.5], ['polarbear', 'huff', 0.65, 0.22], ['polarbear', 'jawpop', 1.05], ['polarbear', 'jawpop', 1.3], ['polarbear', 'jawpop', 1.62], ['polarbear', 'growl', 1.95, 1.0]], false, 22050),
  'idle.polarbear': composite([['polarbear', 'chuff', 0, 0.6]], true, 22050),
  'call.elephant': composite([['elephant', 'trumpet', 0, 1.2], ['elephant', 'rumble', 1.4, 2.4]], false, 22050),
  'idle.elephant': composite([['elephant', 'rumble', 0, 2.0], ['elephant', 'snort', 1.9, 0.4]], true, 16000),
  'call.hippo': composite([['hippo', 'wheeze', 0, 0.9], ...grunts('hippo', 'honk', 1.0, 6, 0.3), ['hippo', 'grunt', 3.05, 0.4]], false, 16000),
  'idle.hippo': composite([['hippo', 'grunt', 0, 0.35], ['hippo', 'grunt', 0.6, 0.35]], true, 16000),
  'call.rhino': composite([['rhino', 'snort', 0, 0.35], ['rhino', 'snort', 0.5, 0.3], ['rhino', 'snort', 1.05, 0.3], ['rhino', 'pant', 1.6, 1.2]], false, 22050),
  'idle.rhino': composite([['rhino', 'puff', 0, 0.15], ['rhino', 'puff', 0.5, 0.15]], true, 16000),
  'call.giraffe': composite([['giraffe', 'hum', 0, 1.4], ['giraffe', 'snort', 1.6, 0.3]], false, 22050),
  'idle.giraffe': composite([['giraffe', 'snort', 0, 0.3]], true, 22050),
  'call.camel': composite([['camel', 'groan', 0, 1.8], ['camel', 'grumble', 2.0, 0.6]], false, 16000),
  'idle.camel': composite([['camel', 'grumble', 0, 0.6]], true, 16000),
  'call.zebra': composite([...grunts('zebra', 'cycle', 0, 5, 0.42), ['zebra', 'final', 2.45, 0.38]], false, 22050),
  'idle.zebra': composite([['zebra', 'blow', 0, 0.55]], true, 22050),
  'call.gazelle': composite([['gazelle', 'snort', 0, 0.12], ['gazelle', 'snort', 0.32, 0.12], ['gazelle', 'snort', 0.62, 0.12], ['gazelle', 'bleat', 1.0, 0.5]], false, 22050),
  'idle.gazelle': composite([['gazelle', 'bleat', 0, 0.45]], true, 22050),
  'call.gorilla': composite([['gorilla', 'hoot', 0, 0.22], ['gorilla', 'hoot', 0.42, 0.22], ['gorilla', 'hoot', 0.78, 0.2], ['gorilla', 'hoot', 1.08, 0.2], ['gorilla', 'hoot', 1.33, 0.2], ['gorilla', 'beat', 1.95, 1.2]], false, 22050),
  'idle.gorilla': composite([['gorilla', 'belch', 0, 0.55]], true, 16000),
  'call.penguin': composite([['penguin', 'pair', 0, 0.45], ['penguin', 'pair', 0.5, 0.47], ['penguin', 'pair', 1.02, 0.5], ['penguin', 'final', 1.6, 0.9]], false, 22050),
  'idle.penguin': composite([['penguin', 'contact', 0, 0.45]], true, 22050),
  'call.flamingo': composite([0, 0.17, 0.36, 0.52, 0.74, 0.9, 1.12, 1.3, 1.5].map((t) => ['flamingo', 'honk', t] as const), false, 22050),
  'idle.flamingo': composite([['flamingo', 'honk', 0], ['flamingo', 'honk', 0.22]], true, 22050),
};

// ------------------------------------------------------------------ ambient wildlife one-shots

/** Baked reverb send of the ambient one-shots (the engine's distance reverb supplies the space). */
const AMB_WET = 0.12;

function* owl(k: Kit): Generator<void> {
  const hoot = (t: number, d: number, f: number, a: number, vib = false) =>
    k.tone({
      t,
      dur: d,
      wave: 'soft',
      f: [[0, f * 0.97], [d * 0.3, f], [d, f * 0.93]],
      amp: [[0, 0], [d * 0.25, a], [d * 0.7, a * 0.85], [d, 0]],
      breath: 0.08,
      breathBand: [500, 1.5],
      formants: [[420, 4, 2]],
      vib: vib ? [6, 18] : undefined,
      lp: 1400,
      wet: AMB_WET,
    });
  hoot(0, 0.42, 395, 1);
  yield;
  hoot(0.85, 0.16, 382, 0.6);
  yield;
  hoot(1.08, 0.16, 380, 0.65);
  yield;
  hoot(1.4, 0.75, 372, 0.9, true);
  yield;
}

function* songA(k: Kit): Generator<void> {
  const n: Note[] = [];
  let t = 0;
  n.push({ t, d: 0.16, f0: 2900, f1: 3400, a: 0.8 });
  t += 0.22;
  n.push({ t, d: 0.12, f0: 3600, f1: 3000, a: 0.9 });
  t += 0.17;
  for (let i = 0; i < 7; i++) {
    n.push({ t, d: 0.035, f0: 4800 - i * 60, f1: 3600 - i * 40, a: 0.75, att: 0.1 });
    t += 0.055;
  }
  t += 0.06;
  n.push({ t, d: 0.25, f0: 2600, f1: 2500, fm: 3100, a: 0.85 });
  k.phrase(n, { harm: 0.08, wet: AMB_WET });
  yield;
}

function* songB(k: Kit): Generator<void> {
  const n: Note[] = [];
  let t = 0;
  for (let i = 0; i < 3; i++) {
    n.push({ t, d: 0.075, f0: 6100, f1: 5500, a: 0.7, att: 0.15 });
    t += 0.13;
  }
  t += 0.05;
  for (let i = 0; i < 4; i++) {
    n.push({ t, d: 0.06, f0: 3400, f1: 4100, fm: 2900, a: 0.9 });
    t += 0.09;
  }
  k.phrase(n, { harm: 0.05, wet: AMB_WET });
  yield;
}

function* woodpecker(k: Kit): Generator<void> {
  let t = 0;
  for (let i = 0; i < 19; i++) {
    const a = 1 - i / 24;
    k.burst({ t, dur: 0.02, color: 'white', band: [[0, 1300]], q: 4, amp: [[0, 0], [0.001, a], [0.02, 0]], wet: AMB_WET });
    yield;
    k.thump(t, 820, 640, 0.02, a * 0.6, { wet: AMB_WET });
    yield;
    t += 0.052 + i * 0.0012;
  }
}

function* crow(k: Kit): Generator<void> {
  for (const [t, a] of [
    [0, 1],
    [0.5, 0.85],
    [0.95, 0.7],
  ] as const) {
    k.tone({ t, dur: 0.32, wave: 'nasal', f: [[0, 560], [0.06, 620], [0.32, 500]], amp: [[0, 0], [0.03, a], [0.2, a * 0.8], [0.32, 0]], drive: 2.5, rough: [70, 0.55], breath: 0.3, breathBand: [1800, 0.8], formants: [[1200, 8, 3], [2100, 5, 3]], lp: 4000, wet: AMB_WET });
    yield;
  }
}

function amb(dur: number, build: Recipe['build'], reverb: Recipe['reverb'], rms: number, hp: number): Recipe {
  return { dur, tail: 0.9, rate: 22050, reverb, peak: 0.85, rms, hp, build };
}

// ------------------------------------------------------------------ registry

export const ANIMAL_RECIPES: Record<string, Recipe> = {
  ...sylRecipes(),
  ...COMPOSITES,
  'amb.owl': amb(2.15, owl, { decay: 0.55, length: 2, bright: 0.35 }, 0.12, 105),
  'amb.songA': amb(1.3, songA, { decay: 0.45, length: 1.6, bright: 0.5 }, 0.12, 300),
  'amb.songB': amb(0.8, songB, { decay: 0.45, length: 1.6, bright: 0.5 }, 0.11, 300),
  'amb.wood': amb(1.1, woodpecker, { decay: 0.5, length: 1.8, bright: 0.4 }, 0.12, 200),
  'amb.crow': amb(1.3, crow, { decay: 0.5, length: 1.8, bright: 0.4 }, 0.12, 200),
};

/** Mix data per species: loudness of call / idle and minimum seconds between calls. */
export interface SpeciesVoice {
  call: number;
  idle: number;
  /** Relative chance of idle vocalising (0 = never). */
  chatty: number;
}

export const SPECIES_VOICE: Record<string, SpeciesVoice> = {
  lion: { call: 1.0, idle: 0.55, chatty: 0.6 },
  tiger: { call: 0.95, idle: 0.5, chatty: 0.7 },
  grizzly: { call: 0.85, idle: 0.5, chatty: 0.5 },
  polarbear: { call: 0.85, idle: 0.45, chatty: 0.5 },
  elephant: { call: 1.0, idle: 0.6, chatty: 0.8 },
  hippo: { call: 0.95, idle: 0.6, chatty: 0.7 },
  rhino: { call: 0.8, idle: 0.55, chatty: 0.7 },
  giraffe: { call: 0.6, idle: 0.45, chatty: 0.5 },
  camel: { call: 0.85, idle: 0.5, chatty: 0.6 },
  zebra: { call: 0.85, idle: 0.5, chatty: 0.8 },
  gazelle: { call: 0.6, idle: 0.4, chatty: 0.6 },
  gorilla: { call: 0.9, idle: 0.5, chatty: 0.7 },
  penguin: { call: 0.75, idle: 0.5, chatty: 1.0 },
  flamingo: { call: 0.7, idle: 0.45, chatty: 1.0 },
};

/** Sound used for a species without its own recipe (new species added later). */
export function voiceIdFor(speciesId: string, diet: string | undefined): string {
  if (SPECIES_VOICE[speciesId]) return speciesId;
  if (diet === 'carnivore') return 'grizzly';
  if (diet === 'piscivore') return 'penguin';
  if (diet === 'omnivore') return 'gorilla';
  return 'rhino';
}
