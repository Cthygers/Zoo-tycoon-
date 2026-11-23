// Synthesis toolkit shared by every sound recipe. All sounds are built from
// Web Audio nodes (oscillators, filtered noise, gain envelopes, wave shapers)
// scheduled on a BaseAudioContext — in practice an OfflineAudioContext that
// pre-renders the sound into a buffer (see render.ts). Nothing here touches
// the live AudioContext or the DOM.

import { Rng, mulberry32 } from '../core/rng';

/** [time offset (s), value] point of an automation path. */
export type Pt = readonly [number, number];
export type Wave = OscillatorType | 'glottal' | 'nasal' | 'reed' | 'soft' | 'brass';
export type NoiseColor = 'white' | 'pink' | 'brown';
/** [centre Hz, gain dB, Q] of a peaking (formant) filter. */
export type Formant = readonly [number, number, number];

// ---------------------------------------------------------------- noise buffers

const noiseCache = new Map<string, AudioBuffer>();
const COLORS: readonly NoiseColor[] = ['white', 'pink', 'brown'];

/** Incremental generator of one seamlessly looping noise buffer (3 s, RMS ≈ 0.25). */
function* noiseGen(c: BaseAudioContext, color: NoiseColor): Generator<void, AudioBuffer> {
  const sr = c.sampleRate;
  const n = Math.floor(3 * sr);
  const x = Math.floor(0.05 * sr); // crossfade so the loop point is inaudible
  const tmp = new Float32Array(n + x);
  const r = mulberry32(color === 'white' ? 0x51ed : color === 'pink' ? 0x9e37 : 0x2f6b);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    last = 0;
  const STEP = 16384;
  for (let s = 0; s < tmp.length; s += STEP) {
    const e = Math.min(tmp.length, s + STEP);
    for (let i = s; i < e; i++) {
      const w = r() * 2 - 1;
      if (color === 'white') tmp[i] = w;
      else if (color === 'pink') {
        // Paul Kellet's economy pink filter (±0.5 dB above 40 Hz)
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        tmp[i] = b0 + b1 + b2 + w * 0.1848;
      } else {
        last = (last + 0.02 * w) / 1.02;
        tmp[i] = last;
      }
    }
    yield;
  }
  for (let i = 0; i < x; i++) {
    const a = Math.sin((i / x) * Math.PI * 0.5);
    const b = Math.cos((i / x) * Math.PI * 0.5);
    tmp[i] = tmp[i] * a + tmp[n + i] * b;
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += tmp[i];
  mean /= n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (tmp[i] - mean) * (tmp[i] - mean);
  yield;
  const k = 0.25 / Math.sqrt(ss / n || 1);
  const buf = c.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (tmp[i] - mean) * k;
  return buf;
}

/**
 * Seamlessly looping noise buffer shared by every render at this sample rate.
 * AudioBuffers are not bound to a context, so one copy serves all offline renders.
 */
export function noiseBuffer(c: BaseAudioContext, color: NoiseColor): AudioBuffer {
  const key = `${color}@${c.sampleRate}`;
  const hit = noiseCache.get(key);
  if (hit) return hit;
  const g = noiseGen(c, color);
  let res = g.next();
  while (!res.done) res = g.next();
  noiseCache.set(key, res.value);
  return res.value;
}

/** Generate the noise buffers for this sample rate ahead of a render, a slice at a time. */
export async function prepareNoise(c: BaseAudioContext, sl: { tick(): Promise<void> }): Promise<void> {
  for (const color of COLORS) {
    const key = `${color}@${c.sampleRate}`;
    if (noiseCache.has(key)) continue;
    const g = noiseGen(c, color);
    let res = g.next();
    while (!res.done) {
      await sl.tick();
      res = g.next();
    }
    noiseCache.set(key, res.value);
  }
}

// ---------------------------------------------------------------- control data

/**
 * Smooth random control signal in [-1, 1]: random targets at `rate` Hz with
 * cosine interpolation, sampled at `res` points per second.
 */
export function smoothNoise(rng: Rng, seconds: number, rate: number, res = 200): Float32Array {
  const n = Math.max(2, Math.ceil(seconds * res));
  const out = new Float32Array(n);
  const step = rate / res; // knots advanced per output point
  let pos = 0;
  let a = rng.range(-1, 1),
    b = rng.range(-1, 1);
  for (let i = 0; i < n; i++) {
    const f = pos - Math.floor(pos);
    const w = (1 - Math.cos(f * Math.PI)) * 0.5;
    out[i] = a + (b - a) * w;
    pos += step;
    if (Math.floor(pos) !== Math.floor(pos - step)) {
      a = b;
      b = rng.range(-1, 1);
    }
  }
  return out;
}

/** Raised-cosine pulse shape value for phase p in [0,1]. */
export function hann(p: number): number {
  return p <= 0 || p >= 1 ? 0 : 0.5 - 0.5 * Math.cos(p * Math.PI * 2);
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- specs

/** A pitched, voiced sound (animal vocalisation, hoot, honk...). Times relative to `t`. */
export interface ToneSpec {
  t: number;
  dur: number;
  /** Pitch contour [offset s, Hz]. */
  f: readonly Pt[];
  /** Amplitude contour [offset s, 0..1] (linear ramps). */
  amp: readonly Pt[];
  wave?: Wave;
  /** Pitch glide shape between contour points. */
  glide?: 'exp' | 'lin';
  /** Sub-harmonic (f/2) level — period doubling / growl. */
  sub?: number;
  /** Vibrato [rate Hz, depth cents]. */
  vib?: readonly [number, number];
  /** Slow random pitch drift depth (cents). */
  jitter?: number;
  /** Amplitude roughness [rate Hz, depth 0..1] from smooth noise. */
  rough?: readonly [number, number];
  /** Aspiration noise level (through the same envelope). */
  breath?: number;
  /** Aspiration band [centre Hz, Q]. */
  breathBand?: readonly [number, number];
  formants?: readonly Formant[];
  /** Formant centre movement: one entry per formant index (or undefined). */
  fmove?: readonly (readonly Pt[] | undefined)[];
  /** tanh drive (adds harmonics / grit). */
  drive?: number;
  lp?: number;
  hp?: number;
  level?: number;
  /** Reverb send relative to level. */
  wet?: number;
  dest?: AudioNode;
}

/** A filtered noise event (snort, huff, splash, footstep...). */
export interface BurstSpec {
  t: number;
  dur: number;
  color?: NoiseColor;
  /** Filter centre contour [offset s, Hz]. */
  band: readonly Pt[];
  q?: number;
  type?: BiquadFilterType;
  /** Second identical filter in series (steeper band). */
  steep?: boolean;
  amp: readonly Pt[];
  rough?: readonly [number, number];
  formants?: readonly Formant[];
  lp?: number;
  hp?: number;
  level?: number;
  wet?: number;
  dest?: AudioNode;
}

/** One note of a bird phrase (absolute times). */
export interface Note {
  t: number;
  d: number;
  f0: number;
  f1: number;
  a: number;
  /** Mid-note frequency (makes a rise-fall / fall-rise contour). */
  fm?: number;
  /** Attack fraction of the note (default 0.2). */
  att?: number;
}

export interface PhraseOpts {
  /** Level of the 2nd harmonic (0 = pure whistle). */
  harm?: number;
  /** Trill buzz [rate Hz, cents]. */
  buzz?: readonly [number, number];
  level?: number;
  wet?: number;
  lp?: number;
  dest?: AudioNode;
}

/** [frequency ratio, relative amplitude, decay multiplier]. */
export type Partial3 = readonly [number, number, number];

const MARIMBA: readonly Partial3[] = [
  [1, 1, 1],
  [3.93, 0.28, 0.32],
  [9.2, 0.07, 0.12],
];

// ---------------------------------------------------------------- kit

export class Kit {
  readonly sr: number;
  readonly nyquist: number;
  private waves = new Map<string, PeriodicWave>();
  private curves = new Map<number, Float32Array<ArrayBuffer>>();

  constructor(
    readonly c: BaseAudioContext,
    /** Dry mix bus. */
    readonly out: AudioNode,
    /** Reverb send bus (null when the recipe has no reverb). */
    readonly wet: AudioNode | null,
    readonly rng: Rng,
    /** Total render length in seconds. */
    readonly length: number,
  ) {
    this.sr = c.sampleRate;
    this.nyquist = c.sampleRate * 0.5;
  }

  // ------------------------------------------------------------ nodes
  gain(v = 1, dest?: AudioNode): GainNode {
    const g = this.c.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  }

  bq(type: BiquadFilterType, f: number, q = 0.7071, gainDb = 0): BiquadFilterNode {
    const b = this.c.createBiquadFilter();
    b.type = type;
    b.frequency.value = Math.min(f, this.nyquist * 0.95);
    b.Q.value = q;
    b.gain.value = gainDb;
    return b;
  }

  /** Connect nodes in series; returns the last. */
  chain(...nodes: AudioNode[]): AudioNode {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  periodic(kind: 'glottal' | 'nasal' | 'reed' | 'soft' | 'brass'): PeriodicWave {
    const hit = this.waves.get(kind);
    if (hit) return hit;
    const N = 40;
    const re = new Float32Array(N + 1);
    const im = new Float32Array(N + 1);
    for (let n = 1; n <= N; n++) {
      let a: number;
      switch (kind) {
        case 'glottal': // vocal-fold like: about -7 dB/oct with slightly weak evens
          a = Math.pow(n, -1.15) * (n % 2 === 0 ? 0.85 : 1);
          break;
        case 'nasal': // strong 2nd–6th harmonics, thin top
          a = (n <= 6 ? 1 / Math.sqrt(n) : 1.6 / n) * (n === 1 ? 0.55 : 1);
          break;
        case 'reed': // odd-heavy
          a = n % 2 === 1 ? 1 / n : 0.18 / n;
          break;
        case 'brass': // bright, many harmonics
          a = Math.pow(n, -0.85);
          break;
        default: // soft, almost a sine with a little body
          a = n === 1 ? 1 : n === 2 ? 0.22 : n === 3 ? 0.08 : 0.02 / n;
      }
      im[n] = a;
    }
    const w = this.c.createPeriodicWave(re, im);
    this.waves.set(kind, w);
    return w;
  }

  osc(wave: Wave, t0: number, t1: number, f = 440): OscillatorNode {
    const o = this.c.createOscillator();
    if (wave === 'sine' || wave === 'square' || wave === 'sawtooth' || wave === 'triangle') o.type = wave;
    else if (wave === 'custom') o.type = 'sine';
    else o.setPeriodicWave(this.periodic(wave));
    o.frequency.value = Math.min(f, this.nyquist * 0.95);
    o.start(Math.max(0, t0));
    o.stop(Math.min(this.length, Math.max(t0 + 0.01, t1)));
    return o;
  }

  noise(color: NoiseColor, t0: number, t1: number): AudioBufferSourceNode {
    const s = this.c.createBufferSource();
    s.buffer = noiseBuffer(this.c, color);
    s.loop = true;
    s.start(Math.max(0, t0), this.rng.range(0, 2.9));
    s.stop(Math.min(this.length, Math.max(t0 + 0.01, t1)));
    return s;
  }

  /** tanh wave shaper normalised so ±1 maps to ±1. */
  shaper(drive: number): WaveShaperNode {
    const key = Math.round(drive * 100);
    let curve = this.curves.get(key);
    if (!curve) {
      curve = new Float32Array(1024);
      const k = Math.tanh(drive);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(drive * x) / k;
      }
      this.curves.set(key, curve);
    }
    const s = this.c.createWaveShaper();
    s.curve = curve;
    return s;
  }

  /** Audio-rate control signal (ConstantSource whose offset follows `data`). */
  signal(t0: number, dur: number, data: Float32Array): AudioNode {
    const cs = this.c.createConstantSource();
    cs.offset.value = 0;
    cs.offset.setValueCurveAtTime(data, Math.max(0, t0), Math.max(0.01, dur));
    cs.start(Math.max(0, t0));
    cs.stop(Math.min(this.length, t0 + dur + 0.01));
    return cs;
  }

  /** Modulate a param: param += depth · src. */
  mod(src: AudioNode, depth: number, param: AudioParam): void {
    const g = this.gain(depth);
    src.connect(g);
    g.connect(param);
  }

  /** Automate a param through points (offsets relative to t0). */
  path(param: AudioParam, t0: number, pts: readonly Pt[], mode: 'lin' | 'exp' = 'lin', scale = 1): void {
    if (!pts.length) return;
    param.setValueAtTime(pts[0][1] * scale, Math.max(0, t0 + pts[0][0]));
    for (let i = 1; i < pts.length; i++) {
      const tt = Math.max(0, t0 + pts[i][0]);
      const v = pts[i][1] * scale;
      if (mode === 'exp') param.exponentialRampToValueAtTime(Math.max(1e-4, v), tt);
      else param.linearRampToValueAtTime(v, tt);
    }
  }

  /** Route a node to the dry bus (or `dest`) and the reverb send. */
  send(node: AudioNode, level = 1, wet = 0.2, dest?: AudioNode): void {
    node.connect(this.gain(level, dest ?? this.out));
    if (wet > 0 && this.wet) node.connect(this.gain(level * wet, this.wet));
  }

  /** Smooth noise control signal into a param: value = base + depth·noise. */
  private roughGain(t: number, dur: number, rate: number, depth: number): GainNode {
    const r = this.gain(1 - depth * 0.5);
    const sig = this.signal(t, dur, smoothNoise(this.rng, dur, rate, Math.max(100, rate * 6)));
    this.mod(sig, depth * 0.5, r.gain);
    return r;
  }

  // ------------------------------------------------------------ composites

  /** Voiced sound with pitch contour, formants, roughness and breath. */
  tone(s: ToneSpec): void {
    const t = s.t;
    const stop = t + s.dur + 0.05;
    const wave = s.wave ?? 'glottal';
    const glide = s.glide ?? 'exp';
    const o = this.osc(wave, t, stop, s.f[0][1]);
    this.path(o.frequency, t, s.f, glide);
    const src = this.gain(1);
    o.connect(src);
    let o2: OscillatorNode | null = null;
    if (s.sub) {
      o2 = this.osc(wave, t, stop, s.f[0][1] * 0.5);
      this.path(o2.frequency, t, s.f, glide, 0.5);
      o2.connect(this.gain(s.sub, src));
    }
    if (s.vib) {
      const l = this.osc('sine', t, stop, s.vib[0]);
      const g = this.gain(s.vib[1]);
      l.connect(g);
      g.connect(o.detune);
      if (o2) g.connect(o2.detune);
    }
    if (s.jitter) {
      const sig = this.signal(t, s.dur + 0.05, smoothNoise(this.rng, s.dur + 0.05, 9, 120));
      const g = this.gain(s.jitter);
      sig.connect(g);
      g.connect(o.detune);
      if (o2) g.connect(o2.detune);
    }
    let node: AudioNode = src;
    if (s.drive) node = this.chain(node, this.shaper(s.drive));
    let mid: AudioNode;
    if (s.rough) {
      mid = this.roughGain(t, s.dur + 0.05, s.rough[0], s.rough[1]);
      node.connect(mid);
    } else mid = node;
    const amp = this.gain(0);
    mid.connect(amp);
    if (s.breath) {
      const bb = s.breathBand ?? [1200, 0.8];
      const nz = this.noise('white', t, stop);
      const g = this.gain(s.breath * 2.2);
      this.chain(nz, this.bq('bandpass', bb[0], bb[1]), g);
      g.connect(s.rough ? mid : amp);
    }
    this.path(amp.gain, t, s.amp, 'lin');
    let out: AudioNode = amp;
    const fm = s.formants ?? [];
    for (let i = 0; i < fm.length; i++) {
      const p = this.bq('peaking', fm[i][0], fm[i][2], fm[i][1]);
      const mv = s.fmove?.[i];
      if (mv) this.path(p.frequency, t, mv, 'exp');
      out = this.chain(out, p);
    }
    if (s.hp) out = this.chain(out, this.bq('highpass', s.hp));
    if (s.lp) out = this.chain(out, this.bq('lowpass', s.lp));
    this.send(out, s.level ?? 1, s.wet ?? 0.2, s.dest);
  }

  /** Filtered noise event. */
  burst(s: BurstSpec): void {
    const t = s.t;
    const stop = t + s.dur + 0.05;
    const nz = this.noise(s.color ?? 'white', t, stop);
    const f = this.bq(s.type ?? 'bandpass', s.band[0][1], s.q ?? 1);
    this.path(f.frequency, t, s.band, 'exp');
    let node: AudioNode = this.chain(nz, f);
    if (s.steep) {
      const f2 = this.bq(s.type ?? 'bandpass', s.band[0][1], s.q ?? 1);
      this.path(f2.frequency, t, s.band, 'exp');
      node = this.chain(node, f2);
    }
    if (s.rough) {
      const r = this.roughGain(t, s.dur + 0.05, s.rough[0], s.rough[1]);
      node = this.chain(node, r);
    }
    const amp = this.gain(0);
    node = this.chain(node, amp);
    this.path(amp.gain, t, s.amp, 'lin');
    for (const fm of s.formants ?? []) node = this.chain(node, this.bq('peaking', fm[0], fm[2], fm[1]));
    if (s.hp) node = this.chain(node, this.bq('highpass', s.hp));
    if (s.lp) node = this.chain(node, this.bq('lowpass', s.lp));
    this.send(node, s.level ?? 1, s.wet ?? 0.2, s.dest);
  }

  /** A run of whistled notes on one oscillator (bird song). */
  phrase(notes: readonly Note[], o: PhraseOpts = {}): void {
    if (!notes.length) return;
    const t0 = notes[0].t;
    const last = notes[notes.length - 1];
    const t1 = last.t + last.d;
    const osc = this.osc('sine', t0, t1 + 0.02, notes[0].f0);
    const osc2 = o.harm ? this.osc('sine', t0, t1 + 0.02, notes[0].f0 * 2) : null;
    const g = this.gain(0);
    osc.connect(g);
    if (osc2) osc2.connect(this.gain(o.harm!, g));
    if (o.buzz) {
      const l = this.osc('sine', t0, t1 + 0.02, o.buzz[0]);
      const lg = this.gain(o.buzz[1]);
      l.connect(lg);
      lg.connect(osc.detune);
      if (osc2) lg.connect(osc2.detune);
    }
    let prevEnd = -1;
    for (const n of notes) {
      const s = Math.max(n.t, prevEnd + 0.002);
      const e = s + n.d;
      const top = Math.min(this.nyquist * 0.9, Math.max(n.f0, n.f1, n.fm ?? 0));
      const f0 = Math.min(top, n.f0);
      const f1 = Math.min(top, n.f1);
      for (const [os, k] of [
        [osc, 1],
        [osc2, 2],
      ] as const) {
        if (!os) continue;
        const fr = os.frequency;
        fr.setValueAtTime(Math.min(f0 * k, this.nyquist * 0.95), s);
        if (n.fm) fr.exponentialRampToValueAtTime(Math.min(n.fm * k, this.nyquist * 0.95), s + n.d * 0.5);
        fr.exponentialRampToValueAtTime(Math.min(f1 * k, this.nyquist * 0.95), e);
      }
      const att = n.d * (n.att ?? 0.2);
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(n.a, s + att);
      g.gain.linearRampToValueAtTime(n.a * 0.75, s + att + (n.d - att) * 0.6);
      g.gain.linearRampToValueAtTime(0, e);
      prevEnd = e;
    }
    let out: AudioNode = g;
    if (o.lp) out = this.chain(out, this.bq('lowpass', o.lp));
    this.send(out, o.level ?? 1, o.wet ?? 0.25, o.dest);
  }

  /** Mallet-struck bar / bell: decaying sine partials plus a soft click. */
  bar(
    t: number,
    f: number,
    vel: number,
    o: { decay?: number; partials?: readonly Partial3[]; click?: number; level?: number; wet?: number; dest?: AudioNode; lp?: number } = {},
  ): void {
    const decay = o.decay ?? 0.35;
    const sum = this.gain(1);
    for (const [ratio, a, dm] of o.partials ?? MARIMBA) {
      const fr = f * ratio;
      if (fr > this.nyquist * 0.9) continue;
      const tau = Math.max(0.006, decay * dm);
      const os = this.osc('sine', t, t + tau * 7 + 0.02, fr);
      const g = this.gain(0, sum);
      os.connect(g);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(a * vel, t + 0.0025);
      g.gain.setTargetAtTime(0, t + 0.0025, tau);
    }
    const click = o.click ?? 0.25;
    if (click > 0) {
      const nz = this.noise('white', t, t + 0.03);
      const g = this.gain(0);
      this.chain(nz, this.bq('bandpass', Math.min(f * 2.2, this.nyquist * 0.8), 1.2), g, sum);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(click * vel * 2.5, t + 0.001);
      g.gain.setTargetAtTime(0, t + 0.001, 0.004);
    }
    let out: AudioNode = sum;
    if (o.lp) out = this.chain(out, this.bq('lowpass', o.lp));
    this.send(out, o.level ?? 1, o.wet ?? 0.15, o.dest);
  }

  /** Low knock / thump: sine dropping in pitch with a fast decay. */
  thump(t: number, f0: number, f1: number, dur: number, a: number, o: { wet?: number; dest?: AudioNode; level?: number } = {}): void {
    const os = this.osc('sine', t, t + dur + 0.02, f0);
    os.frequency.setValueAtTime(f0, t);
    os.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.gain(0);
    os.connect(g);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(a, t + 0.003);
    g.gain.setTargetAtTime(0, t + 0.003, dur / 3.5);
    this.send(g, o.level ?? 1, o.wet ?? 0.15, o.dest);
  }
}
