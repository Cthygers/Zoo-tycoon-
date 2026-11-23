// Ambient beds: long seamless loops pre-rendered once and cross-faded at
// runtime by time of day, camera height and what is near the camera focus.
// Beds are mono; the engine plays each through two decorrelated, half-loop
// offset sources panned left / right for a wide, non-repeating stereo field.

import { smoothNoise, type Kit, type Note } from '../kit';
import type { Recipe } from '../render';
import type { Rng } from '../../core/rng';

/** Map a curve in place. */
function mapc(src: Float32Array, fn: (v: number, i: number) => number): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = fn(src[i], i);
  return out;
}

/** Add a raised-cosine bump into an envelope (res = points per second). */
function bump(env: Float32Array, res: number, t: number, att: number, dec: number, a: number): void {
  const i0 = Math.floor(t * res);
  const ia = Math.max(1, Math.floor(att * res));
  const id = Math.max(1, Math.floor(dec * res));
  for (let i = 0; i < ia + id; i++) {
    const j = i0 + i;
    if (j < 0 || j >= env.length) continue;
    const v = i < ia ? 0.5 - 0.5 * Math.cos((i / ia) * Math.PI) : Math.exp((-(i - ia) / id) * 3.2);
    env[j] += a * v;
  }
}

// ------------------------------------------------------------------ wind in leaves

function* wind(k: Kit): Generator<void> {
  const D = k.length;
  const g = mapc(smoothNoise(k.rng, D, 0.22, 40), (v) => Math.pow((v + 1) * 0.5, 1.4));
  // body: pink noise whose low-pass opens with each gust
  const body = k.noise('pink', 0, D);
  const lp = k.bq('lowpass', 500, 0.5);
  lp.frequency.setValueCurveAtTime(mapc(g, (v) => 420 + 1100 * v), 0, D);
  const gb = k.gain(0);
  gb.gain.setValueCurveAtTime(mapc(g, (v) => 0.3 + 0.7 * v), 0, D);
  k.chain(body, k.bq('highpass', 170), lp, gb);
  k.send(gb, 1, 0);
  yield;
  // leaves: two rustling layers with their own flutter
  const bands: [number, number, number][] = [
    [3800, 15, 0.55],
    [2300, 9, 0.45],
  ];
  for (const [f, rate, lvl] of bands) {
    const n = k.noise('white', 0, D);
    const gl = k.gain(0);
    gl.gain.setValueCurveAtTime(mapc(g, (v) => 0.04 + 0.8 * v * v), 0, D);
    const fl = k.gain(0.55);
    const sig = k.signal(0, D, smoothNoise(k.rng, D, rate, 160));
    k.mod(sig, 0.45, fl.gain);
    k.chain(n, k.bq('highpass', 1200, 0.6), k.bq('peaking', f, 0.9, 5), k.bq('lowpass', 7500), gl, fl);
    k.send(fl, lvl, 0);
    yield;
  }
  // distant low roar
  const lo = k.noise('brown', 0, D);
  const gl = k.gain(0.22);
  k.chain(lo, k.bq('lowpass', 260), gl);
  k.send(gl, 1, 0);
}

// ------------------------------------------------------------------ daytime birds

function motif(r: Rng, notes: number): Note[] {
  const out: Note[] = [];
  let t = 0;
  for (let i = 0; i < notes; i++) {
    const kind = r.float();
    const base = r.range(2100, 3900);
    if (kind < 0.25) {
      // short trill burst
      const m = r.int(3, 6);
      const hi = r.range(3800, 5200);
      for (let j = 0; j < m; j++) {
        out.push({ t, d: 0.032, f0: hi, f1: hi * 0.75, a: 0.7, att: 0.1 });
        t += 0.05;
      }
    } else if (kind < 0.6) {
      out.push({ t, d: r.range(0.1, 0.22), f0: base, f1: base * r.range(0.85, 1.25), a: r.range(0.7, 1) });
      t += out[out.length - 1].d;
    } else {
      out.push({ t, d: r.range(0.12, 0.25), f0: base, f1: base * r.range(0.9, 1.05), fm: base * r.range(1.15, 1.35), a: r.range(0.7, 1) });
      t += out[out.length - 1].d;
    }
    t += r.range(0.04, 0.12);
  }
  return out;
}

function shift(notes: readonly Note[], t: number, s: number, a: number): Note[] {
  return notes.map((n) => ({ ...n, t: n.t + t, f0: n.f0 * s, f1: n.f1 * s, fm: n.fm ? n.fm * s : undefined, a: n.a * a }));
}

function* birds(k: Kit): Generator<void> {
  const D = k.length;
  const r = k.rng;
  const end = D - 0.4;
  // distant birds go through a darker, wetter bus
  const far = k.gain(1);
  const farLp = k.bq('lowpass', 3000);
  far.connect(farLp);
  k.send(farLp, 1, 0.5);

  // whistling songsters: each repeats its own motif with small variations
  for (let ind = 0; ind < 4; ind++) {
    const m = motif(r, r.int(3, 5));
    const near = ind < 2;
    let t = r.range(0, 4);
    while (t < end - 1.5) {
      k.phrase(shift(m, t, r.range(0.97, 1.03), r.range(0.8, 1)), { harm: 0.06, level: near ? 0.8 : 0.45, wet: 0.25, dest: near ? undefined : far });
      t += r.range(4, 8);
      yield;
    }
  }
  // trilling warbler
  for (let ind = 0; ind < 2; ind++) {
    let t = r.range(1, 6);
    const f = r.range(4300, 5400);
    while (t < end - 1.5) {
      const n: Note[] = [];
      const cnt = r.int(9, 15);
      for (let j = 0; j < cnt; j++) {
        const sw = 1 - j * 0.012;
        n.push({ t: t + j * 0.062, d: 0.04, f0: f * sw, f1: f * sw * 0.72, a: 0.4 + 0.6 * Math.sin((j / cnt) * Math.PI), att: 0.12 });
      }
      k.phrase(n, { level: ind ? 0.3 : 0.5, wet: 0.3, buzz: [r.range(35, 60), 60], dest: ind ? far : undefined });
      t += r.range(7, 13);
      yield;
    }
  }
  // chips and call notes scattered everywhere
  let t = r.range(0, 0.6);
  while (t < end) {
    const f = r.range(3000, 5500);
    const dbl = r.chance(0.4);
    const n: Note[] = [{ t, d: 0.022, f0: f * 0.65, f1: f, a: 1, att: 0.15 }];
    if (dbl) n.push({ t: t + 0.09, d: 0.022, f0: f * 0.65, f1: f, a: 0.8, att: 0.15 });
    const nearish = r.chance(0.3);
    k.phrase(n, { level: nearish ? 0.32 : 0.22, wet: 0.3, dest: nearish ? undefined : far });
    t += r.range(0.3, 1.3);
    yield;
  }
  // two-note "tee-chu" caller in bouts
  t = r.range(2, 6);
  while (t < end - 2) {
    const n: Note[] = [];
    const reps = r.int(3, 4);
    for (let i = 0; i < reps; i++) {
      n.push({ t: t + i * 0.3, d: 0.08, f0: 5600, f1: 5300, a: 0.7 });
      n.push({ t: t + i * 0.3 + 0.12, d: 0.09, f0: 3300, f1: 3000, a: 0.8 });
    }
    k.phrase(n, { level: 0.35, wet: 0.3, dest: far });
    t += r.range(8, 14);
    yield;
  }
  // soft distant dove-like coos
  t = r.range(3, 8);
  while (t < end - 2.5) {
    const n: Note[] = [];
    const pat = [0.32, 0.55, 0.3, 0.3];
    let tt = t;
    for (let i = 0; i < pat.length; i++) {
      n.push({ t: tt, d: pat[i], f0: 560, f1: 520, fm: 600, a: i === 1 ? 1 : 0.7, att: 0.3 });
      tt += pat[i] + 0.12;
    }
    k.phrase(n, { level: 0.16, wet: 0.35, lp: 1500, dest: far });
    t += r.range(10, 16);
  }
  // far flock chatter
  for (let b = 0; b < 3; b++) {
    const tb = r.range(0, end - 1.5);
    const n: Note[] = [];
    let tc = tb;
    for (let i = 0; i < 12; i++) {
      const f = r.range(3500, 6000);
      n.push({ t: tc, d: 0.025, f0: f, f1: f * r.range(0.7, 1.3), a: r.range(0.3, 1), att: 0.2 });
      tc += r.range(0.04, 0.12);
    }
    k.phrase(n, { level: 0.18, wet: 0.4, dest: far });
    yield;
  }
}

// ------------------------------------------------------------------ night insects

function* night(k: Kit): Generator<void> {
  const D = k.length;
  const r = k.rng;
  const res = 1200;
  const n = Math.ceil(D * res);
  // chirping crickets
  for (let c = 0; c < 4; c++) {
    const f = r.range(3900, 5200);
    const period = r.range(0.45, 0.9);
    const pulses = r.int(2, 4);
    const prate = r.range(24, 38);
    const env = new Float32Array(n);
    let t = r.range(0, period);
    while (t < D) {
      if (r.chance(0.94)) {
        for (let p = 0; p < pulses; p++) {
          const s = Math.floor((t + p / prate) * res);
          const w = Math.floor((0.6 / prate) * res);
          for (let i = 0; i < w; i++) if (s + i < n) env[s + i] = 0.5 - 0.5 * Math.cos((i / w) * Math.PI * 2);
        }
      } else t += r.range(0.5, 1.5);
      t += period * r.range(0.95, 1.05);
    }
    const o = k.osc('sine', 0, D, f);
    const o2 = k.osc('sine', 0, D, f * 2.003);
    const g = k.gain(0);
    o.connect(g);
    o2.connect(k.gain(0.08, g));
    g.gain.setValueCurveAtTime(env, 0, D);
    k.send(g, c === 0 ? 0.6 : r.range(0.2, 0.42), 0.35);
    yield;
  }
  // trilling cricket: long buzzy trills with pauses
  {
    const env = new Float32Array(n);
    const prate = r.range(48, 58);
    let t = r.range(0, 2);
    while (t < D) {
      const len = r.range(1.5, 3.5);
      for (let p = 0; p < len * prate; p++) {
        const s = Math.floor((t + p / prate) * res);
        const w = Math.floor((0.55 / prate) * res);
        const fade = Math.min(1, p / 8, (len * prate - p) / 8);
        for (let i = 0; i < w; i++) if (s + i < n) env[s + i] = fade * (0.5 - 0.5 * Math.cos((i / w) * Math.PI * 2));
      }
      t += len + r.range(1, 3);
    }
    const o = k.osc('sine', 0, D, r.range(3300, 3700));
    const g = k.gain(0);
    o.connect(g);
    g.gain.setValueCurveAtTime(env, 0, D);
    k.send(g, 0.22, 0.4);
  }
  yield;
  // katydid rasps
  {
    const env = new Float32Array(n);
    let t = r.range(0, 1);
    while (t < D) {
      const cnt = r.int(2, 3);
      for (let i = 0; i < cnt; i++) {
        const s = Math.floor((t + i * 0.16) * res);
        const w = Math.floor(0.07 * res);
        for (let j = 0; j < w; j++) if (s + j < n) env[s + j] = Math.sin((j / w) * Math.PI) * (0.6 + 0.4 * Math.sin(j * 1.3));
      }
      t += r.range(1.0, 1.6);
    }
    const nz = k.noise('white', 0, D);
    const g = k.gain(0);
    k.chain(nz, k.bq('bandpass', 6800, 3), g);
    g.gain.setValueCurveAtTime(env, 0, D);
    k.send(g, 0.5, 0.4);
  }
  // distant frogs
  for (let fr = 0; fr < 2; fr++) {
    const f = r.range(300, 480);
    let t = r.range(0.5, 4);
    while (t < D - 1.5) {
      const cnt = r.int(2, 4);
      for (let i = 0; i < cnt; i++) {
        const tt = t + i * 0.32;
        k.tone({ t: tt, dur: 0.2, wave: 'reed', f: [[0, f], [0.2, f * 0.9]], amp: [[0, 0], [0.02, 1], [0.14, 0.7], [0.2, 0]], rough: [70, 0.9], formants: [[f * 2.3, 6, 3]], lp: 2200, level: 0.16, wet: 0.5 });
        yield;
      }
      t += r.range(3, 7);
    }
  }
  // soft night air
  const air = k.noise('pink', 0, D);
  const ga = k.gain(0.1);
  k.chain(air, k.bq('bandpass', 500, 0.6), ga);
  k.send(ga, 1, 0);
}

// ------------------------------------------------------------------ crowd murmur

const VOWELS: readonly [number, number][] = [
  [730, 1090],
  [530, 1840],
  [300, 2200],
  [570, 840],
  [440, 1020],
  [660, 1720],
  [490, 1350],
];

function* crowd(k: Kit): Generator<void> {
  const D = k.length;
  const r = k.rng;
  const bus = k.gain(1);
  const out = k.chain(bus, k.bq('highpass', 260), k.bq('peaking', 900, 0.8, 3), k.bq('lowpass', 2400));
  k.send(out, 1, 0.45);
  const res = 400;
  const n = Math.ceil(D * res);
  for (let i = 0; i < 16; i++) {
    const kind = r.float();
    const f0 = kind < 0.4 ? r.range(100, 140) : kind < 0.85 ? r.range(175, 240) : r.range(250, 320);
    const fs = kind < 0.4 ? 1 : kind < 0.85 ? 1.15 : 1.3;
    const level = Math.pow(r.range(0.25, 1), 1.5);
    const o = k.osc('glottal', 0, D, f0);
    k.mod(k.signal(0, D, smoothNoise(r, D, 7, 60)), 35, o.detune);
    const f1 = k.bq('peaking', 500 * fs, 4, 12);
    const f2 = k.bq('peaking', 1500 * fs, 6, 10);
    const amp = k.gain(0);
    k.chain(o, f1, f2, amp);
    const cons = k.noise('white', 0, D);
    const ca = k.gain(0);
    k.chain(cons, k.bq('bandpass', r.range(2500, 4000), 1.2), ca);
    const env = new Float32Array(n);
    const cenv = new Float32Array(n);
    let t = r.range(0, 1.5);
    while (t < D) {
      const syl = r.int(3, 9);
      for (let s = 0; s < syl && t < D; s++) {
        const dur = r.range(0.09, 0.24);
        const a = r.range(0.6, 1);
        const i0 = Math.floor(t * res);
        const w = Math.floor(dur * res);
        for (let j = 0; j < w; j++) if (i0 + j < n) env[i0 + j] = a * Math.sin((j / w) * Math.PI);
        if (r.chance(0.5)) {
          const cw = Math.floor(r.range(0.02, 0.045) * res);
          for (let j = 0; j < cw; j++) if (i0 - cw + j >= 0 && i0 - cw + j < n) cenv[i0 - cw + j] = 0.5 * Math.sin((j / cw) * Math.PI);
        }
        const decl = 1 - (s / syl) * 0.12;
        o.frequency.setTargetAtTime(f0 * decl * (1 + 0.08 * r.gauss()), t, 0.03);
        const v = VOWELS[r.int(0, VOWELS.length - 1)];
        f1.frequency.setTargetAtTime(v[0] * fs, t, 0.025);
        f2.frequency.setTargetAtTime(v[1] * fs, t, 0.025);
        t += dur + r.range(0.01, 0.06);
      }
      t += r.range(0.25, 1.4);
    }
    amp.gain.setValueCurveAtTime(env, 0, D);
    ca.gain.setValueCurveAtTime(cenv, 0, D);
    amp.connect(k.gain(level * 0.5, bus));
    ca.connect(k.gain(level * 0.35, bus));
    yield;
  }
  // children laughing now and then
  for (let l = 0; l < 2; l++) {
    let t = r.range(0.5, D - 2);
    const f = r.range(280, 340);
    const cnt = r.int(4, 6);
    for (let i = 0; i < cnt; i++) {
      k.tone({ t, dur: 0.11, wave: 'glottal', f: [[0, f * (1.05 - i * 0.03)], [0.11, f * (0.95 - i * 0.03)]], amp: [[0, 0], [0.015, 0.7], [0.11, 0]], breath: 0.5, breathBand: [1800, 0.8], formants: [[900, 10, 4], [1600, 8, 5]], level: 0.22, dest: bus, wet: 0 });
      yield;
      t += 0.15;
    }
  }
  // footsteps on gravel
  let t = r.range(0, 1);
  while (t < D - 0.2) {
    const steps = r.int(3, 7);
    const pace = r.range(0.48, 0.6);
    for (let i = 0; i < steps; i++) k.burst({ t: t + i * pace, dur: 0.05, color: 'pink', band: [[0, r.range(1200, 2200)]], q: 0.8, amp: [[0, 0], [0.004, 0.35], [0.05, 0]], level: 0.25, wet: 0.3 });
    t += steps * pace + r.range(0.3, 1.5);
    yield;
  }
  // babble floor
  const fl = k.noise('pink', 0, D);
  const gf = k.gain(0);
  gf.gain.setValueCurveAtTime(mapc(smoothNoise(r, D, 0.7, 40), (v) => 0.12 + 0.04 * v), 0, D);
  k.chain(fl, k.bq('bandpass', 700, 0.8), gf, bus);
}

// ------------------------------------------------------------------ water lapping

function* water(k: Kit): Generator<void> {
  const D = k.length;
  const r = k.rng;
  const res = 100;
  const n = Math.ceil(D * res);
  const swell = new Float32Array(n);
  const slap = new Float32Array(n);
  let t = r.range(0, 0.8);
  while (t < D) {
    const att = r.range(0.25, 0.45);
    const a = r.range(0.5, 1);
    bump(swell, res, t, att, r.range(0.7, 1.2), a);
    bump(slap, res, t + att * 0.9, 0.03, 0.12, a * r.range(0.4, 1));
    t += r.range(1.4, 2.8);
  }
  const lap = k.noise('brown', 0, D);
  const g1 = k.gain(0);
  k.chain(lap, k.bq('bandpass', 460, 0.9), g1);
  g1.gain.setValueCurveAtTime(mapc(swell, (v) => 0.12 + v), 0, D);
  k.send(g1, 1.4, 0.2);
  yield;
  const wash = k.noise('pink', 0, D);
  const g2 = k.gain(0);
  k.chain(wash, k.bq('bandpass', 900, 1.2), g2);
  g2.gain.setValueCurveAtTime(mapc(swell, (v) => 0.05 + v * v * 0.6), 0, D);
  k.send(g2, 0.8, 0.25);
  const sp = k.noise('white', 0, D);
  const g3 = k.gain(0);
  k.chain(sp, k.bq('bandpass', 1900, 0.8), g3);
  g3.gain.setValueCurveAtTime(slap, 0, D);
  k.send(g3, 0.25, 0.3);
  // bubbles and plips in two streams
  for (let s = 0; s < 2; s++) {
    const notes: Note[] = [];
    let tt = r.range(0, 0.5);
    while (tt < D - 0.2) {
      const f = r.range(650, 1600);
      const d = r.range(0.03, 0.07);
      notes.push({ t: tt, d, f0: f, f1: f * r.range(1.5, 1.9), a: r.range(0.2, 0.6), att: 0.06 });
      tt += d + r.range(0.2, 0.9);
    }
    k.phrase(notes, { level: 0.12, wet: 0.35 });
    yield;
  }
}

// ------------------------------------------------------------------ fountain

function* fountain(k: Kit): Generator<void> {
  const D = k.length;
  const r = k.rng;
  const sp = k.noise('white', 0, D);
  const g = k.gain(0.6);
  k.chain(sp, k.bq('highpass', 700), k.bq('peaking', 2600, 0.8, 5), k.bq('lowpass', 8000), g);
  const sig = k.signal(0, D, smoothNoise(r, D, 25, 200));
  k.mod(sig, 0.3, g.gain);
  k.send(g, 0.5, 0.25);
  const res = 2000;
  const n = Math.ceil(D * res);
  for (const f of [1100, 2300, 4200]) {
    const env = new Float32Array(n);
    let t = 0;
    while (t < D) {
      const i0 = Math.floor(t * res);
      const w = Math.floor(r.range(0.01, 0.025) * res);
      const a = r.range(0.2, 1);
      for (let j = 0; j < w * 3; j++) if (i0 + j < n) env[i0 + j] += a * Math.exp((-j / w) * 1.5) * Math.min(1, j / 4);
      t += r.range(0.02, 0.09);
    }
    const nz = k.noise('white', 0, D);
    const gg = k.gain(0);
    k.chain(nz, k.bq('bandpass', f, 3), gg);
    gg.gain.setValueCurveAtTime(env, 0, D);
    k.send(gg, 0.5, 0.3);
    yield;
  }
  for (let s = 0; s < 2; s++) {
    const notes: Note[] = [];
    let tt = r.range(0, 0.2);
    while (tt < D - 0.1) {
      const f = r.range(1400, 3000);
      const d = r.range(0.02, 0.045);
      notes.push({ t: tt, d, f0: f, f1: f * r.range(1.4, 1.8), a: r.range(0.2, 0.6), att: 0.06 });
      tt += d + r.range(0.05, 0.3);
    }
    k.phrase(notes, { level: 0.2, wet: 0.3 });
    yield;
  }
  const body = k.noise('pink', 0, D);
  const gb = k.gain(0);
  gb.gain.setValueCurveAtTime(mapc(smoothNoise(r, D, 1.5, 40), (v) => 0.35 + 0.12 * v), 0, D);
  k.chain(body, k.bq('bandpass', 420, 0.8), gb);
  k.send(gb, 1, 0.2);
}

export const BED_RECIPES: Record<string, Recipe> = {
  'bed.wind': { dur: 16, loop: 2, rate: 22050, peak: 0.5, rms: 0.1, hp: 120, squash: 1.3, build: wind },
  'bed.birds': { dur: 24, loop: 1.5, rate: 22050, peak: 0.6, rms: 0.07, hp: 250, reverb: { decay: 0.45, length: 1.8, bright: 0.5 }, build: birds },
  'bed.night': { dur: 16, loop: 1.5, rate: 22050, peak: 0.55, rms: 0.08, hp: 150, reverb: { decay: 0.5, length: 1.8, bright: 0.35 }, build: night },
  'bed.crowd': { dur: 12, loop: 1.5, rate: 22050, peak: 0.45, rms: 0.1, hp: 120, squash: 1.3, reverb: { decay: 0.4, length: 1.5, bright: 0.3 }, build: crowd },
  'bed.water': { dur: 10, loop: 1.5, rate: 22050, peak: 0.5, rms: 0.1, hp: 160, squash: 1.4, reverb: { decay: 0.25, length: 1, bright: 0.5 }, build: water },
  'bed.fountain': { dur: 8, loop: 1.5, rate: 22050, peak: 0.5, rms: 0.1, hp: 150, reverb: { decay: 0.3, length: 1.2, bright: 0.6 }, build: fountain },
};

