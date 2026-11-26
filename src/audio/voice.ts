// Animal voice source: a cycle-by-cycle glottal pulse train written into a
// buffer in plain JS (period jitter, amplitude shimmer, chaotic and
// period-doubled episodes, pulse-synchronous aspiration), played through a
// parallel bank of formant band-passes (the vocal tract). Unlike oscillators
// with EQ, this gives the irregular, nonlinear harmonic structure of real
// mammal and bird calls while keeping low harmonics resolved.

import type { Rng } from '../core/rng';
import type { Kit, Pt } from './kit';

/** A glottal pulse train. Offsets in contours are seconds; windows are fractions of `dur`. */
export interface PulseSpec {
  dur: number;
  /** Fundamental contour [offset s, Hz], exponential interpolation. */
  f0: readonly Pt[];
  /** Amplitude contour [offset s, 0..1], linear interpolation. */
  amp: readonly Pt[];
  /** Open quotient (fraction of the period the folds are open). Default 0.55. */
  oq?: number;
  /** Period SD as a fraction of the period. Default 0.008. */
  jitter?: number;
  /** Cycle amplitude SD. Default 0.06. */
  shimmer?: number;
  /** Irregular phonation windows [t0, t1, jitter] (fractions of dur); they also add 0.25 amplitude SD. */
  chaos?: readonly (readonly [number, number, number])[];
  /** Period-doubling windows [t0, t1, depth]: cycles alternate T·(1 ± depth/2), A·(1 ± depth). */
  pd?: readonly (readonly [number, number, number])[];
  /** Aspiration noise gated by the open-phase flow (high-passed at 1 kHz). Default 0.12. */
  aspiration?: number;
  /** One-pole low-pass coefficient 0..0.9 for breathy, soft sources. */
  tilt?: number;
  /** Second pulse train at ratio·f0 (biphonation), `db` below the first. */
  biphon?: { ratio: number; db: number };
}

const DEFAULT_OQ = 0.55;
const DEFAULT_JITTER = 0.008;
const DEFAULT_SHIMMER = 0.06;
const DEFAULT_ASPIRATION = 0.12;
/** Extra cycle-amplitude SD inside a chaos window. */
const CHAOS_SHIMMER = 0.25;
const PEAK = 0.9;

/** Contour value at time t: exponential (log-domain) or linear interpolation, held at the ends. */
function contourAt(pts: readonly Pt[], t: number, exp: boolean): number {
  if (!pts.length) return 0;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [t1, v1] = pts[i];
    if (t <= t1) {
      const [t0, v0] = pts[i - 1];
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      if (exp) {
        const a = Math.max(1e-3, v0);
        return a * Math.pow(Math.max(1e-3, v1) / a, u);
      }
      return v0 + (v1 - v0) * u;
    }
  }
  return pts[pts.length - 1][1];
}

/** Pulse-train samples written between the yields of glottalSteps: well under a millisecond on a desktop. */
const STEP_SAMPLES = 2048;

/** Per-sample state of a pulse train carried from one glottal cycle to the next. */
interface TrainState {
  /** Flow at the previous sample. */
  prevU: number;
  /** One-pole 1 kHz high-pass state of the aspiration noise. */
  nx1: number;
  ny: number;
}

/**
 * One glottal cycle [start, end) of a Rosenberg pulse train (radiated flow
 * derivative) added into `out`, with flow-gated aspiration.
 */
function addCycle(out: Float32Array, st: TrainState, start: number, end: number, Tp: number, Tn: number, A: number, asp: number, hpA: number, rng: Rng): void {
  // radiated derivative as the per-sample flow difference (a box-filtered
  // derivative: less aliasing from the abrupt closure), scaled so the
  // closing spike peaks near 1 whatever the period
  const scale = (2 * Tn) / Math.PI;
  const kOpen = Math.PI / Tp;
  const kClose = Math.PI / (2 * Tn);
  const closed = Tp + Tn;
  for (let j = Math.ceil(start); j < end; j++) {
    const tau = j - start;
    const u = tau < Tp ? 0.5 - 0.5 * Math.cos(kOpen * tau) : tau < closed ? Math.cos(kClose * (tau - Tp)) : 0;
    let v = (u - st.prevU) * scale * A;
    st.prevU = u;
    if (asp > 0) {
      const w = (rng.float() - 0.5) * 3.464; // unit-RMS white noise
      st.ny = hpA * (st.ny + w - st.nx1);
      st.nx1 = w;
      v += asp * st.ny * u * A;
    }
    out[j] += v;
  }
}

/**
 * Add one Rosenberg pulse train plus flow-gated aspiration to `out`, yielding
 * every STEP_SAMPLES samples. `ratio` scales f0 (biphonation), `gain` the level.
 */
function* addPulseTrain(out: Float32Array, s: PulseSpec, sr: number, rng: Rng, ratio: number, gain: number): Generator<void> {
  const n = out.length;
  const oq = Math.min(0.95, Math.max(0.1, s.oq ?? DEFAULT_OQ));
  const baseJit = s.jitter ?? DEFAULT_JITTER;
  const baseShim = s.shimmer ?? DEFAULT_SHIMMER;
  const asp = s.aspiration ?? DEFAULT_ASPIRATION;
  const chaos = s.chaos ?? [];
  const pd = s.pd ?? [];
  const dur = Math.max(1e-6, s.dur);
  const hpA = Math.exp((-2 * Math.PI * 1000) / sr);
  const st: TrainState = { prevU: 0, nx1: 0, ny: 0 };
  let start = 0; // cycle start, fractional samples
  let cycle = 0;
  let nextYield = STEP_SAMPLES;
  while (start < n) {
    const t = start / sr;
    const fr = t / dur;
    const f = Math.max(1, contourAt(s.f0, t, true) * ratio);
    let jit = baseJit;
    let shim = baseShim;
    for (const [c0, c1, cj] of chaos)
      if (fr >= c0 && fr < c1) {
        jit = Math.max(jit, cj);
        shim += CHAOS_SHIMMER;
      }
    let T = (1 / f) * (1 + rng.gauss() * jit);
    let A = contourAt(s.amp, t, false) * (1 + rng.gauss() * shim);
    for (const [p0, p1, depth] of pd)
      if (fr >= p0 && fr < p1) {
        const sign = cycle % 2 === 0 ? 1 : -1;
        T *= 1 + (sign * depth) / 2;
        A *= 1 + sign * depth;
      }
    const L = Math.max(2, T * sr);
    A = Math.max(0, A) * gain;
    // the open phase follows the smooth contour; jitter and period doubling
    // lengthen or shorten the closed phase (as in real phonation), so
    // successive closures are exactly one perturbed period apart
    const open = Math.min(oq * (sr / f), 0.95 * L);
    if (A === 0) st.prevU = 0;
    else addCycle(out, st, start, Math.min(n, start + L), 0.75 * open, 0.25 * open, A, asp, hpA, rng);
    start += L;
    cycle++;
    if (start >= nextYield) {
      nextYield = start + STEP_SAMPLES;
      yield;
    }
  }
}

/** Run a step generator to its end and return its result. */
function drain<T>(g: Generator<void, T>): T {
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

/**
 * Glottal source as a sample buffer (pure JS, deterministic for a given rng
 * state), built in steps: it yields every few thousand samples so a long call
 * is computed over several short main-thread slices. Length ceil(dur·sr), peak
 * normalised to 0.9, never NaN.
 */
export function* glottalSteps(s: PulseSpec, sr: number, rng: Rng): Generator<void, Float32Array> {
  const out = new Float32Array(Math.max(1, Math.ceil(s.dur * sr)));
  yield* addPulseTrain(out, s, sr, rng, 1, 1);
  if (s.biphon) yield* addPulseTrain(out, s, sr, rng, s.biphon.ratio, Math.pow(10, s.biphon.db / 20));
  const tilt = Math.min(0.9, Math.max(0, s.tilt ?? 0));
  if (tilt > 0) {
    let y = 0;
    for (let i = 0; i < out.length; i++) {
      y = (1 - tilt) * out[i] + tilt * y;
      out[i] = y;
    }
  }
  let pk = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]);
    if (a > pk) pk = a;
  }
  if (pk > 0 && Number.isFinite(pk)) {
    const g = PEAK / pk;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  } else out.fill(0);
  return out;
}

/** glottalSteps() in one go. */
export function glottalSource(s: PulseSpec, sr: number, rng: Rng): Float32Array {
  return drain(glottalSteps(s, sr, rng));
}

/** Play sample data from `t` (seconds) on the kit's graph. */
export function pcmSource(k: Kit, data: Float32Array, t: number): AudioBufferSourceNode {
  const buf = k.c.createBuffer(1, Math.max(1, data.length), k.sr);
  buf.getChannelData(0).set(data);
  const s = k.c.createBufferSource();
  s.buffer = buf;
  s.start(Math.max(0, t));
  s.stop(Math.min(k.length, Math.max(t, 0) + data.length / k.sr));
  return s;
}

/** Formant [centre Hz, bandwidth Hz, gain dB]. */
export type Formant3 = readonly [number, number, number];

/**
 * Vocal tract: parallel band-passes (Q = hz / bandwidth), each through its
 * own gain, summed. Parallel bands give 15–25 dB of contrast between formant
 * peaks and valleys. `move[i]` automates centre i (offsets from t, exponential).
 */
export function tract(k: Kit, input: AudioNode, f: readonly Formant3[], t: number, move?: readonly (readonly Pt[] | undefined)[]): AudioNode {
  const sum = k.gain(1);
  const top = k.nyquist * 0.95;
  f.forEach(([hz, bw, db], i) => {
    if (hz >= top) return;
    const b = k.bq('bandpass', hz, hz / Math.max(1, bw));
    const mv = move?.[i];
    if (mv) k.path(b.frequency, t, mv.map(([o, v]) => [o, Math.min(v, top)] as const), 'exp');
    input.connect(b);
    b.connect(k.gain(Math.pow(10, db / 20), sum));
  });
  return sum;
}

/**
 * Static tract in JS: the band-passes of tract() (Web Audio's biquad
 * formulas) over data[i0, i1), summed with their gains.
 */
function tractPcm(data: Float32Array, f: readonly Formant3[], sr: number, i0: number, i1: number): Float32Array {
  const n = Math.max(0, i1 - i0);
  const sum = new Float32Array(n);
  for (const [hz, bw, db] of f) {
    if (hz >= sr * 0.475) continue;
    const w0 = (2 * Math.PI * hz) / sr;
    const alpha = Math.sin(w0) / (2 * (hz / Math.max(1, bw)));
    const a0 = 1 + alpha;
    const b0 = alpha / a0;
    const a1 = (-2 * Math.cos(w0)) / a0;
    const a2 = (1 - alpha) / a0;
    const g = Math.pow(10, db / 20);
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0;
    for (let i = 0; i < n; i++) {
      const x = data[i0 + i];
      const y = b0 * (x - x2) - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      sum[i] += g * y;
    }
  }
  return sum;
}

function peakOf(x: Float32Array): number {
  let pk = 0;
  for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
  return pk;
}

/**
 * Peak of the static tract response around the loudest point of the amp
 * contour (±0.12 s). Used to scale the tract output to ≈ ±1 before the drive
 * shaper, so `drive` and turbulence levels mean the same for every voice.
 */
function tractPeak(data: Float32Array, f: readonly Formant3[], sr: number, amp: readonly Pt[]): number {
  let tMax = 0;
  let aMax = -1;
  for (const [t, a] of amp)
    if (a > aMax) {
      aMax = a;
      tMax = t;
    }
  return peakOf(tractPcm(data, f, sr, Math.max(0, Math.round((tMax - 0.12) * sr)), Math.min(data.length, Math.round((tMax + 0.12) * sr))));
}

/** A complete voiced call: pulse source → tract → drive → turbulence → filters → send. */
export interface VoiceSpec extends PulseSpec {
  t: number;
  formants: readonly Formant3[];
  fmove?: readonly (readonly Pt[] | undefined)[];
  /** tanh drive on the ±1-scaled tract output: 1–1.5 for mammals, 2.5–3 for blares and honks. */
  drive?: number;
  /** Offset added before the drive, following the amp contour: an asymmetric (brassy) blare. */
  bias?: number;
  /** Turbulence: white noise band-passed lo..hi following the amp contour; level re the voiced peak. */
  noise?: { level: number; lo: number; hi: number };
  lp?: number;
  hp?: number;
  level?: number;
  /** Reverb send relative to level. Default 0.05 (the engine adds distance reverb). */
  wet?: number;
  dest?: AudioNode;
}

/**
 * voice() in steps: the glottal source yields every few thousand samples and the
 * tract and graph get a step of their own, so a recipe that is a generator
 * (`yield* voiceSteps(...)`) spreads a long call over short main-thread slices.
 * Renders exactly as voice() does.
 */
export function* voiceSteps(k: Kit, s: VoiceSpec): Generator<void> {
  const data = yield* glottalSteps(s, k.sr, k.rng);
  yield;
  const pk = tractPeak(data, s.formants, k.sr, s.amp);
  yield;
  const src = pcmSource(k, data, s.t);
  let out: AudioNode = k.chain(tract(k, src, s.formants, s.t, s.fmove), k.gain(pk > 1e-6 ? Math.min(100, 1 / pk) : 1));
  if (s.drive) {
    const shaper = k.shaper(s.drive);
    out.connect(shaper);
    if (s.bias) {
      const dc = k.c.createConstantSource();
      dc.start(Math.max(0, s.t));
      dc.stop(Math.min(k.length, s.t + s.dur + 0.02));
      const env = k.gain(0, shaper);
      dc.connect(env);
      k.path(env.gain, s.t, s.amp, 'lin', s.bias);
    }
    out = shaper;
  }
  if (s.noise && s.noise.level > 0) {
    const { level, lo, hi } = s.noise;
    const mix = k.gain(1);
    out.connect(mix);
    const nz = k.noise('white', s.t, s.t + s.dur + 0.02);
    const top = Math.min(hi, k.nyquist * 0.9);
    // kit noise has RMS 0.25 over the full band: scale the band to unit RMS
    const norm = 1 / (0.25 * Math.sqrt(Math.max(0.01, (top - lo) / k.nyquist)));
    const env = k.gain(0);
    k.chain(nz, k.bq('highpass', lo), k.bq('lowpass', top), env, k.gain(level * norm, mix));
    k.path(env.gain, s.t, s.amp, 'lin');
    out = mix;
  }
  if (s.hp) out = k.chain(out, k.bq('highpass', s.hp));
  if (s.lp) out = k.chain(out, k.bq('lowpass', s.lp));
  k.send(out, s.level ?? 1, s.wet ?? 0.05, s.dest);
}

/** A complete voiced call scheduled in one go (see voiceSteps). */
export function voice(k: Kit, s: VoiceSpec): void {
  drain(voiceSteps(k, s));
}

/**
 * voice() rendered in plain JS and added into `out` at s.t: pulse source →
 * static tract → drive → turbulence → level. For dense layers (colony
 * murmurs), where tens of overlapping node graphs would make the offline
 * render slow. fmove, bias, hp, lp, wet and dest are not applied: the
 * caller's bus filters and sends the mix.
 */
export function voicePcm(s: VoiceSpec, sr: number, rng: Rng, out: Float32Array): void {
  const data = glottalSource(s, sr, rng);
  const y = tractPcm(data, s.formants, sr, 0, data.length);
  const pk = peakOf(y);
  const pre = pk > 1e-6 ? 1 / pk : 1;
  const drive = s.drive ?? 0;
  const dn = drive ? Math.tanh(drive) : 1;
  const level = s.level ?? 1;
  // turbulence: white noise through a band-pass lo..hi, scaled to unit RMS
  let nb0 = 0,
    na1 = 0,
    na2 = 0,
    ng = 0;
  if (s.noise && s.noise.level > 0) {
    const lo = s.noise.lo;
    const hi = Math.min(s.noise.hi, sr * 0.45);
    const fc = Math.sqrt(lo * hi);
    const w0 = (2 * Math.PI * fc) / sr;
    const alpha = Math.sin(w0) / (2 * (fc / Math.max(1, hi - lo)));
    nb0 = alpha / (1 + alpha);
    na1 = (-2 * Math.cos(w0)) / (1 + alpha);
    na2 = (1 - alpha) / (1 + alpha);
    // RMS of a band-pass over unit white noise ≈ sqrt(π·bw / sr)
    ng = s.noise.level / Math.sqrt((Math.PI * (hi - lo)) / sr);
  }
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  const at = Math.round(s.t * sr);
  const n = Math.min(y.length, out.length - at);
  for (let i = Math.max(0, -at); i < n; i++) {
    let v = y[i] * pre;
    if (drive) v = Math.tanh(drive * v) / dn;
    if (ng) {
      const w = (rng.float() - 0.5) * 3.464;
      const b = nb0 * (w - x2) - na1 * y1 - na2 * y2;
      x2 = x1;
      x1 = w;
      y2 = y1;
      y1 = b;
      v += ng * b * contourAt(s.amp, i / sr, false);
    }
    out[at + i] += v * level;
  }
}
