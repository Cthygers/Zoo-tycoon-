// Ambient beds: long seamless loops pre-rendered once and cross-faded at
// runtime by time of day, camera height and what is near the camera focus.
// Beds are mono; the engine plays each through two decorrelated, half-loop
// offset sources panned left / right for a wide, non-repeating stereo field.

import { smoothNoise, type Kit, type Note, type Partial3 } from '../kit';
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

  // whistling songsters: each repeats its own motif with small variations; a real syrinx is never a
  // pure sine (S-10): an audible second harmonic and a fast random flutter give the notes some grain
  for (let ind = 0; ind < 4; ind++) {
    const m = motif(r, r.int(3, 5));
    const near = ind < 2;
    const grain = [r.range(80, 160), r.range(0.35, 0.55)] as const;
    let t = r.range(0, 4);
    while (t < end - 1.5) {
      k.phrase(shift(m, t, r.range(0.97, 1.03), r.range(0.8, 1)), { harm: 0.2, rough: grain, level: near ? 0.8 : 0.45, wet: 0.25, dest: near ? undefined : far });
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
    k.phrase(n, { harm: 0.15, rough: [110, 0.4], level: 0.35, wet: 0.3, dest: far });
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
  // insects share a bus with a −4 dB shelf at 5 kHz: the night must not be all 3–6 kHz chirps
  const ins = k.gain(1);
  k.send(k.chain(ins, k.bq('highshelf', 5000, 0.7071, -4)), 1, 0.38);
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
    k.send(g, c === 0 ? 0.6 : r.range(0.2, 0.42), 0, ins);
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
    k.send(g, 0.22, 0, ins);
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
    k.send(g, 0.5, 0, ins);
  }
  yield;
  // a soft night breeze under the insects, so the night is not all 3–6 kHz chirps
  const air = k.noise('pink', 0, D);
  const ga = k.gain(0);
  ga.gain.setValueCurveAtTime(mapc(smoothNoise(r, D, 0.2, 20), (v) => 0.9 + 0.45 * v), 0, D);
  k.chain(air, k.bq('bandpass', 650, 0.6), ga);
  k.send(ga, 1, 0);
}

// ------------------------------------------------------------------ crowd babble

/** Vowel formants F1, F2 (Hz) of an adult male voice. */
const VOWELS: readonly [number, number][] = [
  [730, 1090],
  [530, 1840],
  [300, 2200],
  [570, 840],
  [440, 1020],
  [660, 1720],
  [490, 1350],
];

/** Talker types: share of the crowd, f0 range (Hz) and formant scale. */
const TALKERS: readonly { p: number; f0: readonly [number, number]; fs: number }[] = [
  { p: 0.4, f0: [95, 140], fs: 1 }, // men
  { p: 0.45, f0: [180, 240], fs: 1.15 }, // women
  { p: 0.15, f0: [260, 380], fs: 1.3 }, // children
];

/**
 * Babble of 12–14 talkers: phrases of 3–9 syllables at 4–5 per second, f0
 * gliding with declination and accents, moving formants and consonant noise.
 * A floor with no salient events (no laughs or steps baked into the loop).
 */
function* crowd(k: Kit): Generator<void> {
  const D = k.length;
  const r = k.rng;
  const bus = k.gain(1);
  // the glottal wave falls 7 dB/oct; the shelf restores the 1–4 kHz share of real babble (LTASS)
  // F3 is shared on the bus (a filter per talker would add a fifth of the render time)
  const out = k.chain(bus, k.bq('highpass', 200), k.bq('peaking', 900, 0.8, 2), k.bq('peaking', 2800, 1.2, 5), k.bq('highshelf', 1100, 0.7071, 9), k.bq('lowpass', 4500, 0.5));
  k.send(out, 1, 0.45);
  const res = 400;
  const n = Math.ceil(D * res);
  // consonants: short fricative / plosive noise on about a third of the syllables, through
  // two shared noise chains (one per half of the talkers: a chain each would double the render)
  const cons = [0, 1].map(() => {
    const bp = k.bq('bandpass', 5000, 1.2);
    bp.frequency.automationRate = 'k-rate';
    const g = k.gain(0);
    k.chain(k.noise('white', 0, D), bp, g);
    return { bp, g, env: new Float32Array(n) };
  });
  /** One talker: phrases separated by `gap` s of silence, at `level`. */
  function* talker(i: number, level: number, gap: readonly [number, number]): Generator<void> {
    const u = r.float();
    const type = u < TALKERS[0].p ? TALKERS[0] : u < TALKERS[0].p + TALKERS[1].p ? TALKERS[1] : TALKERS[2];
    const f0 = r.range(type.f0[0], type.f0[1]);
    const fs = type.fs * r.range(0.96, 1.04);
    const o = k.osc('glottal', 0, D, f0);
    // slow pitch drift of ±35 cents on top of the prosody
    k.mod(k.signal(0, D, smoothNoise(r, D, 7, 60)), 35, o.detune);
    const q = () => r.range(4, 6);
    const f1 = k.bq('peaking', 500 * fs, q(), 8);
    const f2 = k.bq('peaking', 1500 * fs, q(), 8);
    // block-rate formant motion: a-rate automation recomputes the filters every sample
    f1.frequency.automationRate = 'k-rate';
    f2.frequency.automationRate = 'k-rate';
    const amp = k.gain(0);
    k.chain(o, f1, f2, amp);
    const c = cons[i % 2];
    const env = new Float32Array(n);
    let t = r.range(0, 1.5);
    let phrases = 0;
    o.frequency.setValueAtTime(f0, 0);
    while (t < D - 0.3) {
      const syl = r.int(3, 9);
      const ioi = 1 / r.range(4, 5);
      // 1–2 accented syllables per phrase, up or down 15 %
      const acc = new Set([r.int(0, syl - 1), r.chance(0.5) ? r.int(0, syl - 1) : -1]);
      const accDir = r.chance(0.7) ? 1.15 : 0.85;
      for (let s = 0; s < syl && t < D - 0.3; s++) {
        const dur = ioi * r.range(0.75, 1.05);
        const a = r.range(0.6, 1);
        const i0 = Math.floor(t * res);
        const w = Math.floor(dur * res);
        // syllables run into each other: the voice never drops fully inside a phrase
        for (let j = 0; j < w; j++) if (i0 + j < n) env[i0 + j] = Math.max(env[i0 + j], a * (0.25 + 0.75 * Math.sin((j / w) * Math.PI)));
        if (r.chance(0.35)) {
          const cw = Math.floor(r.range(0.03, 0.08) * res);
          const c0 = Math.max(0, i0 - Math.floor(cw / 2));
          for (let j = 0; j < cw; j++) if (c0 + j < n) c.env[c0 + j] = Math.max(c.env[c0 + j], level * a * Math.sin((j / cw) * Math.PI));
          c.bp.frequency.setValueAtTime(r.range(3000, 7000), c0 / res);
        }
        // pitch glides: declination over the phrase, accents and a little per-syllable scatter
        const decl = 1 - 0.1 * (s / Math.max(1, syl - 1));
        const fs0 = f0 * decl * (acc.has(s) ? accDir : 1) * (1 + 0.03 * r.gauss());
        o.frequency.linearRampToValueAtTime(fs0, t + dur * 0.45);
        o.frequency.linearRampToValueAtTime(fs0 * r.range(0.95, 1.0), t + dur);
        const v = VOWELS[r.int(0, VOWELS.length - 1)];
        f1.frequency.setTargetAtTime(v[0] * fs, t, 0.03);
        f2.frequency.setTargetAtTime(v[1] * fs, t, 0.03);
        t += ioi;
      }
      t += r.range(gap[0], gap[1]);
      o.frequency.linearRampToValueAtTime(f0, t);
      if (++phrases % 4 === 0) yield;
    }
    amp.gain.setValueCurveAtTime(env, 0, D);
    amp.connect(k.gain(level * 0.5, bus));
  }
  const talkers = r.int(12, 14);
  for (let i = 0; i < talkers; i++) {
    yield* talker(i, Math.pow(r.range(0.25, 1), 1.5), [0.25, 1.4]);
    yield;
  }
  // a nearer group now and then (S-3): one louder talker with a phrase every few seconds, never intelligible
  yield* talker(talkers, 1.6, [3.5, 8]);
  for (const c of cons) {
    c.g.gain.setValueCurveAtTime(c.env, 0, D);
    // bursts about 10 dB under the vowel (band-passed noise carries far less power than the voice)
    c.g.connect(bus);
  }
  // babble floor
  const fl = k.noise('pink', 0, D);
  k.chain(fl, k.bq('bandpass', 700, 0.8), k.gain(0.1, bus));
}

// ------------------------------------------------------------------ water lapping

function* water(k: Kit): Generator<void> {
  const D = k.length;
  const r = k.rng;
  const res = 100;
  const n = Math.ceil(D * res);
  const swell = new Float32Array(n);
  const slap = new Float32Array(n);
  // laps come irregularly, now and then after a calm spell, and each breaks as a small cluster of
  // slaps rather than one (S-14: a steady swell-and-plip reads as a machine)
  let t = r.range(0, 0.8);
  while (t < D) {
    const att = r.range(0.2, 0.5);
    const a = r.range(0.35, 1);
    bump(swell, res, t, att, r.range(0.6, 1.3), a);
    const slaps = r.int(2, 4);
    let ts = t + att * r.range(0.75, 1);
    for (let j = 0; j < slaps; j++) {
      bump(slap, res, ts, 0.02, r.range(0.06, 0.14), a * r.range(0.3, 1) * (1 - j * 0.2));
      ts += r.range(0.03, 0.11);
    }
    t += r.range(1.1, 3.2) + (r.chance(0.2) ? r.range(1.5, 3) : 0);
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
  // bubbles: sparse, uneven and a little rough (not a steady sine plip)
  for (let s = 0; s < 2; s++) {
    const notes: Note[] = [];
    let tt = r.range(0, 0.5);
    while (tt < D - 0.2) {
      const f = r.range(650, 1600);
      const d = r.range(0.03, 0.07);
      notes.push({ t: tt, d, f0: f, f1: f * r.range(1.5, 1.9), a: r.range(0.15, 0.5), att: 0.06 });
      tt += d + (r.chance(0.3) ? r.range(0.08, 0.2) : r.range(0.6, 2.2));
    }
    k.phrase(notes, { rough: [r.range(150, 260), 0.6], level: 0.1, wet: 0.35 });
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

// ------------------------------------------------------------------ biome beds
// Played by the engine where the scan around the camera finds dry grass and
// desert or tropical species (savanna), snow (arctic) or jungle and wetland
// species (humid). Rendered only once such a biome is near. Their rms targets
// are low: the engine plays them at levels like the main beds', and they
// should colour the place by about 1 dB of loudness, not raise it.

/** Raised-sine pulses of `width` s at `rate` Hz from t0 to t1 into `env` (max-combined), scaled by amp(0..1 through the run). */
function pulses(env: Float32Array, res: number, t0: number, t1: number, rate: number, width: number, amp: (u: number) => number): void {
  const w = Math.max(2, Math.floor(width * res));
  for (let t = t0; t < t1; t += 1 / rate) {
    const a = amp((t - t0) / (t1 - t0));
    const i0 = Math.floor(t * res);
    for (let j = 0; j < w && i0 + j < env.length; j++) env[i0 + j] = Math.max(env[i0 + j], a * Math.sin((j / w) * Math.PI));
  }
}

/** A sine (plus a faint 2nd harmonic) whose level follows `env`, sent at `level`. */
function pulsedTone(k: Kit, f: number, env: Float32Array, level: number, wet: number, dest?: AudioNode): void {
  const D = k.length;
  const g = k.gain(0);
  k.osc('sine', 0, D, f).connect(g);
  k.osc('sine', 0, D, f * 2.01).connect(k.gain(0.12, g));
  g.gain.setValueCurveAtTime(env, 0, D);
  k.send(g, level, wet, dest);
}

function* savanna(k: Kit): Generator<void> {
  const D = k.length;
  const r = k.rng;
  // dry grass: a bright rustle in slow gusts with a fast flutter
  const gust = k.gain(0);
  gust.gain.setValueCurveAtTime(mapc(smoothNoise(r, D, 0.25, 40), (v) => 0.2 + 0.4 * (v + 1)), 0, D);
  const flutter = k.gain(1);
  k.mod(k.signal(0, D, smoothNoise(r, D, 12, 120)), 0.3, flutter.gain);
  k.chain(k.noise('white', 0, D), k.bq('bandpass', 4800, 0.7), k.bq('highpass', 2500), gust, flutter);
  k.send(flutter, 0.7, 0.15);
  yield;
  // two cicadas / grasshoppers: pulsed noise in swelling phrases, one near and one far
  const res = 2000;
  const n = Math.ceil(D * res);
  for (const [level, far] of [
    [0.5, false],
    [0.25, true],
  ] as const) {
    const env = new Float32Array(n);
    const rate = r.range(30, 60);
    const width = Math.min(r.range(0.02, 0.04), 0.85 / rate);
    let t = r.range(0, 3);
    while (t < D - 1) {
      const t1 = Math.min(D, t + r.range(3, 10));
      pulses(env, res, t, t1, rate, width, (u) => 0.15 + 0.85 * u * u);
      t = t1 + r.range(1, 4);
    }
    const g = k.gain(0);
    k.chain(k.noise('white', 0, D), k.bq('bandpass', r.range(5000, 8000), 4), g);
    g.gain.setValueCurveAtTime(env, 0, D);
    k.send(far ? k.chain(g, k.bq('lowpass', 6000)) : g, level, far ? 0.3 : 0.1);
    yield;
  }
  // a distant dove or two
  for (let i = r.int(1, 2); i > 0; i--) {
    const f = r.range(450, 650);
    let t = r.range(0.5, D - 3);
    const notes: Note[] = [];
    for (const d of [0.3, 0.5, 0.28, 0.28]) {
      notes.push({ t, d, f0: f, f1: f * 0.93, fm: f * 1.06, a: d > 0.4 ? 1 : 0.7, att: 0.3 });
      t += d + 0.12;
    }
    k.phrase(notes, { level: 0.1, wet: 0.35, lp: 1500 });
  }
}

function* savannaNight(k: Kit): Generator<void> {
  const D = k.length;
  const r = k.rng;
  const res = 1200;
  const n = Math.ceil(D * res);
  // three sparse crickets, each with its own rhythm
  for (let c = 0; c < 3; c++) {
    const env = new Float32Array(n);
    const period = r.range(0.7, 1.6);
    const chirp = r.int(1, 3);
    const prate = r.range(18, 30);
    let t = r.range(0, period);
    while (t < D) {
      if (r.chance(0.8)) pulses(env, res, t, t + chirp / prate, prate, 0.6 / prate, () => 1);
      t += period * r.range(0.9, 1.1);
    }
    pulsedTone(k, r.range(2500, 3800), env, c === 0 ? 0.5 : r.range(0.2, 0.35), 0.35);
    yield;
  }
  // a nightjar-like churr: a 1.2–1.6 kHz tone pulsed at 30 Hz for 2–3 s
  const env = new Float32Array(n);
  const t0 = r.range(1, D - 4);
  pulses(env, res, t0, t0 + r.range(2, 3), 30, 0.02, (u) => Math.pow(Math.sin(Math.PI * u), 0.3));
  pulsedTone(k, r.range(1200, 1600), env, 0.3, 0.4);
  // night breeze in the grass: a low floor, so the insects are not the whole night
  k.send(k.chain(k.noise('pink', 0, D), k.bq('bandpass', 400, 0.6), k.gain(0.5)), 1, 0);
}

/** Ice: bar partials 1 : 2.76 : 5.4. */
const ICE: readonly Partial3[] = [
  [1, 1, 1],
  [2.76, 0.5, 0.6],
  [5.4, 0.25, 0.4],
];

function* arctic(k: Kit): Generator<void> {
  const D = k.length;
  const r = k.rng;
  // cold wind: pink noise through 2–3 narrow, drifting resonances, in slow gusts
  const wind = k.gain(0);
  wind.gain.setValueCurveAtTime(mapc(smoothNoise(r, D, 0.15, 30), (v) => 0.35 + 0.325 * (v + 1)), 0, D);
  const air = k.noise('pink', 0, D);
  for (let i = r.int(2, 3); i > 0; i--) {
    const fc = r.range(500, 1200);
    const bp = k.bq('bandpass', fc, r.range(8, 12));
    bp.frequency.automationRate = 'k-rate';
    bp.frequency.setValueCurveAtTime(mapc(smoothNoise(r, D, 1 / r.range(6, 10), 20), (v) => fc * (1 + 0.15 * v)), 0, D);
    k.chain(air, bp, k.gain(2.5, wind));
    yield;
  }
  k.send(wind, 1, 0.2);
  // low body
  k.send(k.chain(k.noise('brown', 0, D), k.bq('lowpass', 300), k.gain(0.5)), 1, 0);
  yield;
  // water lapping against ice: brown noise with a sharp slap every 1.5–3 s
  const lres = 100;
  const lap = new Float32Array(Math.ceil(D * lres)).fill(0.15);
  for (let t = r.range(0, 1); t < D; t += r.range(1.5, 3)) bump(lap, lres, t, 0.03, r.range(0.3, 0.6), r.range(0.5, 1));
  const gl = k.gain(0);
  k.chain(k.noise('brown', 0, D), k.bq('bandpass', 400, 0.9), gl);
  gl.gain.setValueCurveAtTime(lap, 0, D);
  k.send(gl, 1.2, 0.25);
  yield;
  // two ice creaks: accelerating stick-slip clicks ringing a low resonance
  const cres = 4000;
  const creak = new Float32Array(Math.ceil(D * cres));
  for (let c = 0; c < 2; c++) {
    const t0 = r.range(0.5, D - 1);
    const len = r.range(0.2, 0.6);
    const m = r.int(15, 40);
    for (let j = 0; j < m; j++) {
      // the gaps shrink towards the end of the creak
      const i0 = Math.floor((t0 + len * (1 - (1 - j / m) ** 2)) * cres);
      if (i0 + 1 < creak.length) creak[i0] = creak[i0 + 1] = 0.5 + 0.5 * (j / m);
    }
  }
  const gc = k.gain(0);
  k.chain(k.noise('white', 0, D), gc);
  gc.gain.setValueCurveAtTime(creak, 0, D);
  k.send(k.chain(gc, k.bq('bandpass', 180, 3)), 6, 0.3);
  // a brighter overtone so a phone speaker hears the creak too
  k.send(k.chain(gc, k.bq('bandpass', 430, 4)), 2.5, 0.3);
  // ice clinks
  for (let i = r.int(2, 3); i > 0; i--)
    k.bar(r.range(0.3, D - 0.5), r.range(1800, 3000), 1, { decay: 0.05, partials: ICE, click: 0.1, level: 0.1, wet: 0.3 });
}

function* humid(k: Kit): Generator<void> {
  const D = k.length;
  const r = k.rng;
  // insect drone: pulsed sines at 3–6 kHz, each swelling slowly
  const count = r.int(6, 10);
  for (let i = 0; i < count; i++) {
    const gate = k.gain(0.5);
    k.mod(k.osc('square', 0, D, r.range(25, 80)), 0.5, gate.gain);
    const swell = k.gain(0);
    k.signal(0, D, mapc(smoothNoise(r, D, r.range(0.1, 0.3), 20), (v) => 0.5 + 0.5 * v)).connect(swell.gain);
    k.chain(k.osc('sine', 0, D, r.range(3000, 6000)), gate, swell);
    k.send(swell, r.range(0.08, 0.18), 0.3);
    if (i % 3 === 2) yield;
  }
  // drips: short rising tones
  const drips: Note[] = [];
  const times = Array.from({ length: r.int(8, 14) }, () => r.range(0.2, D - 0.3)).sort((a, b) => a - b);
  for (const t of times) {
    const f = r.range(1000, 3000);
    drips.push({ t, d: r.range(0.03, 0.06), f0: f, f1: f * r.range(1.1, 1.3), a: r.range(0.4, 1), att: 0.05 });
  }
  k.phrase(drips, { level: 0.3, wet: 0.4 });
  yield;
  // two hollow bird whistles
  for (let b = 0; b < 2; b++) {
    const t = r.range(0.5, D - 1.5);
    const f = r.range(1000, 2500);
    k.phrase(
      [
        { t, d: r.range(0.15, 0.25), f0: f, f1: f * 1.15, a: 0.8, att: 0.3 },
        { t: t + 0.3, d: r.range(0.15, 0.3), f0: f * 1.1, f1: f * 0.9, a: 1, att: 0.3 },
      ],
      { level: 0.35, wet: 0.45, harm: 0.03 },
    );
  }
  // light leaf rustle
  const leaves = k.gain(0);
  leaves.gain.setValueCurveAtTime(mapc(smoothNoise(r, D, 0.4, 40), (v) => 0.1 + 0.125 * (v + 1)), 0, D);
  k.chain(k.noise('white', 0, D), k.bq('bandpass', 3000, 0.8), leaves);
  k.send(leaves, 0.35, 0.2);
}

function* humidNight(k: Kit): Generator<void> {
  const D = k.length;
  const r = k.rng;
  const res = 2000;
  const n = Math.ceil(D * res);
  // tree-frog chorus: raspy 'krek' notes, each caller at its own pitch and pace
  const callers = r.int(6, 12);
  for (let c = 0; c < callers; c++) {
    const env = new Float32Array(n);
    const rate = r.range(2, 4);
    const rasp = r.range(90, 140);
    let t = r.range(0, 0.5);
    while (t < D) {
      pulses(env, res, t, t + r.range(0.05, 0.1), rasp, 0.6 / rasp, (u) => Math.sin(Math.PI * u));
      t += (1 / rate) * r.range(0.7, 1.3);
    }
    pulsedTone(k, r.range(2000, 3000), env, r.range(0.15, 0.4), 0.35);
    yield;
  }
  // pond frogs: group croaks at 0.4–1.2 kHz
  for (let fr = 0; fr < 2; fr++) {
    const f = r.range(400, 650);
    let t = r.range(0.5, 4);
    while (t < D - 1.5) {
      for (let i = r.int(2, 4) - 1; i >= 0; i--) {
        const tt = t + i * 0.32;
        k.tone({ t: tt, dur: 0.2, wave: 'reed', f: [[0, f], [0.2, f * 0.9]], amp: [[0, 0], [0.02, 1], [0.14, 0.7], [0.2, 0]], rough: [70, 0.9], formants: [[f * 1.8, 6, 3]], lp: 2200, level: 0.2, wet: 0.5 });
      }
      t += r.range(3, 7);
      yield;
    }
  }
  // soft insects at 3–4 kHz
  for (let i = 0; i < 2; i++) {
    const env = new Float32Array(n);
    pulses(env, res, 0, D, r.range(25, 40), 0.012, () => 1);
    pulsedTone(k, r.range(3000, 4000), env, 0.05, 0.4);
  }
  // soft air
  k.send(k.chain(k.noise('pink', 0, D), k.bq('bandpass', 450, 0.6), k.gain(0.08)), 1, 0);
}

const CROWD = { loop: 1.5, rate: 16000, peak: 0.45, rms: 0.1, hp: 200, squash: 1.3, reverb: { decay: 0.4, length: 1.5, bright: 0.3 }, build: crowd } as const;

export const BED_RECIPES: Record<string, Recipe> = {
  'bed.wind': { dur: 16, loop: 2, rate: 22050, peak: 0.5, rms: 0.1, hp: 120, squash: 1.3, build: wind },
  'bed.birds': { dur: 24, loop: 1.5, rate: 22050, peak: 0.6, rms: 0.07, hp: 250, reverb: { decay: 0.45, length: 1.8, bright: 0.5 }, build: birds },
  // the breeze floor makes the night louder per phone-weighted rms: 0.05 keeps it near −21.5 LUFS
  'bed.night': { dur: 16, loop: 1.5, rate: 22050, peak: 0.55, rms: 0.05, hp: 150, reverb: { decay: 0.5, length: 1.8, bright: 0.35 }, build: night },
  // two crowd layers of incommensurate length (17 s left, 13 s right: 221 s before the pair repeats)
  'bed.crowd': { dur: 17, ...CROWD },
  'bed.crowd.b': { dur: 13, ...CROWD },
  'bed.water': { dur: 10, loop: 1.5, rate: 22050, peak: 0.5, rms: 0.1, hp: 160, squash: 1.4, reverb: { decay: 0.25, length: 1, bright: 0.5 }, build: water },
  'bed.fountain': { dur: 8, loop: 1.5, rate: 22050, peak: 0.5, rms: 0.1, hp: 150, reverb: { decay: 0.3, length: 1.2, bright: 0.6 }, build: fountain },
  'bed.savanna': { dur: 12, loop: 1.5, rate: 22050, peak: 0.5, rms: 0.04, hp: 150, reverb: { decay: 0.3, length: 1.2, bright: 0.5 }, build: savanna },
  'bed.savanna.night': { dur: 11, loop: 1.5, rate: 16000, peak: 0.5, rms: 0.035, hp: 150, reverb: { decay: 0.45, length: 1.6, bright: 0.35 }, build: savannaNight },
  'bed.arctic': { dur: 13, loop: 1.5, rate: 16000, peak: 0.5, rms: 0.05, hp: 80, reverb: { decay: 0.3, length: 1.2, bright: 0.5 }, build: arctic },
  'bed.humid': { dur: 12, loop: 1.5, rate: 16000, peak: 0.5, rms: 0.03, hp: 150, reverb: { decay: 0.45, length: 1.6, bright: 0.4 }, build: humid },
  'bed.humid.night': { dur: 11, loop: 1.5, rate: 16000, peak: 0.5, rms: 0.022, hp: 150, reverb: { decay: 0.45, length: 1.6, bright: 0.35 }, build: humidNight },
};

