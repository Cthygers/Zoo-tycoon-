// Offline pre-rendering of sound recipes into AudioBuffers.
//
// Every sound in the game (ambient beds, animal calls, UI cues) is described
// by a Recipe that schedules Web Audio nodes on a Kit. renderRecipe() builds
// that graph in an OfflineAudioContext (rendered off the main thread by the
// browser), then post-processes the result on the main thread in one cheap
// linear pass: seamless loop folding for beds, DC removal, trimming of silent
// tails and level normalisation to the recipe's peak / RMS targets.

import { Rng, mulberry32 } from '../core/rng';
import { Kit, noiseBufferGen, prepareNoise, releaseNoise, type NoiseColor, type RenderNoise } from './kit';

export interface Recipe {
  /** Loop length (beds) or nominal length (one-shots), seconds. */
  dur: number;
  /** Beds only: render `loop` extra seconds and cross-fade them into the head (seamless loop). */
  loop?: number;
  /** One-shots: extra seconds rendered for reverb tails. */
  tail?: number;
  /** Render sample rate (default 22050 — plenty for ambience and calls). */
  rate?: number;
  /** Baked outdoor reverb: decay time constant (s) and send level used by Kit.send. */
  reverb?: { decay: number; length?: number; bright?: number };
  /** Peak cap after normalisation. */
  peak: number;
  /**
   * Loudness target as phone-speaker weighted RMS (12 dB/oct high-pass at
   * 300 Hz, roughly what a phone speaker reproduces): whole loop for beds,
   * loudest 400 ms window for one-shots.
   */
  rms: number;
  /** Final high-pass (Hz); kills DC and rumble phone speakers cannot play. */
  hp?: number;
  /**
   * Soft saturation drive applied before normalisation (tanh). Lowers the crest
   * factor of growls / gusty noise so they read as loud on small speakers.
   */
  squash?: number;
  /**
   * Schedule the sound on the kit. May be a generator: it then `yield`s
   * between parts so the graph is built over several short main-thread slices.
   */
  build(k: Kit): void | Iterator<unknown>;
}

export interface SoundAsset {
  buffer: AudioBuffer;
  /** Loop end in seconds (beds); 0 for one-shots. */
  loopEnd: number;
  /** Audible length in seconds. */
  duration: number;
  /** Peak / RMS after normalisation (RMS as defined by Recipe.rms). */
  peak: number;
  rms: number;
  /** Normalisation gain that was applied. */
  norm: number;
  /** Wall-clock milliseconds spent (graph build + render + post). */
  ms: number;
  /** Main-thread milliseconds: graph construction and post-processing. */
  mainMs: number;
  /** Longest single main-thread slice (ms) while rendering. */
  sliceMs: number;
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

export function offlineCtor(): OfflineCtor | null {
  const g = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  return g.OfflineAudioContext ?? g.webkitOfflineAudioContext ?? null;
}

const irCache = new Map<string, AudioBuffer>();

/**
 * Synthetic outdoor impulse response: a few early ground / wall reflections and
 * a diffuse tail that darkens as it decays.
 */
function impulse(c: BaseAudioContext, decay: number, length: number, bright: number): AudioBuffer {
  const key = `${c.sampleRate}:${decay}:${length}:${bright}`;
  const hit = irCache.get(key);
  if (hit) return hit;
  const sr = c.sampleRate;
  const n = Math.max(64, Math.floor(length * sr));
  const buf = c.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const r = mulberry32(0x7a11 + Math.round(decay * 1000));
  let lp = 0;
  const pre = Math.floor(0.012 * sr);
  for (let i = pre; i < n; i++) {
    const t = (i - pre) / sr;
    const env = Math.exp(-t / decay) * Math.min(1, t / 0.02);
    // one-pole low-pass whose cutoff falls over time (air absorption)
    const a = bright * Math.exp(-t / (decay * 1.6)) + 0.04;
    lp += a * (r() * 2 - 1 - lp);
    d[i] = lp * env;
  }
  const taps = [
    [0.009, 0.5],
    [0.021, 0.32],
    [0.034, 0.22],
    [0.057, 0.16],
  ];
  for (const [tt, g] of taps) {
    const i = Math.floor(tt * sr);
    if (i < n) d[i] += g * (r() < 0.5 ? -1 : 1);
  }
  irCache.set(key, buf);
  return buf;
}

/** Early outdoor reflections (ground, nearby walls and trees): [delay s, gain]. */
const OUTDOOR_TAPS: readonly (readonly [number, number])[] = [
  [0.018, 0.5],
  [0.027, 0.36],
  [0.041, 0.26],
  [0.06, 0.18],
];

/**
 * Impulse response of the engine's shared outdoor reverb (built in idle
 * slices): four early
 * reflections and a diffuse tail (time constant 0.145 s, RT60 ≈ 1 s) through a
 * ~5 kHz one-pole low-pass, scaled to unit energy per channel (use with
 * ConvolverNode.normalize = false). Stereo channels use different noise seeds
 * and reflection signs, so the return is decorrelated left / right.
 */
export async function outdoorImpulse(c: BaseAudioContext, seconds: number, channels: 1 | 2): Promise<AudioBuffer> {
  const sr = c.sampleRate;
  const n = Math.max(64, Math.floor(seconds * sr));
  const buf = c.createBuffer(channels, n, sr);
  const a = 1 - Math.exp((-2 * Math.PI * 5000) / sr);
  const fadeIn = Math.floor(0.012 * sr);
  // per sample decay factor of the 0.145 s envelope
  const decay = Math.exp(-1 / (0.145 * sr));
  for (let ch = 0; ch < channels; ch++) {
    const d = buf.getChannelData(ch);
    const r = mulberry32(0x0ad5 + ch * 0x3c6ef35f);
    let lp = 0;
    let env = Math.exp(-fadeIn / sr / 0.145);
    // built a chunk per idle slice: this runs right after the context starts
    for (let i0 = fadeIn; i0 < n; i0 += CHUNK) {
      for (let i = i0, e = Math.min(n, i0 + CHUNK); i < e; i++) {
        lp += a * (r() * 2 - 1 - lp);
        d[i] = lp * env * Math.min(1, (i - fadeIn) / (0.03 * sr));
        env *= decay;
      }
      await yieldMain();
    }
    for (const [tt, g] of OUTDOOR_TAPS) {
      // a little per-channel spread keeps the reflections from imaging dead centre
      const i = Math.floor((tt + (ch ? 0.0013 : 0)) * sr);
      if (i < n) d[i] += g * (r() < 0.5 ? -1 : 1);
    }
    // unit energy at every sample rate (the convolver's own normalisation depends on the rate)
    let e = 0;
    for (let i = 0; i < n; i++) e += d[i] * d[i];
    const k = 1 / Math.sqrt(e || 1);
    for (let i = 0; i < n; i++) d[i] *= k;
  }
  return buf;
}

function startRendering(c: OfflineAudioContext): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    let done = false;
    c.oncomplete = (e) => {
      if (!done) {
        done = true;
        resolve(e.renderedBuffer);
      }
    };
    try {
      const p = c.startRendering() as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === 'function')
        p.then(
          (b) => {
            if (!done) {
              done = true;
              resolve(b);
            }
          },
          (err) => {
            if (!done) {
              done = true;
              reject(err);
            }
          },
        );
    } catch (err) {
      reject(err);
    }
  });
}

/** Default main-thread budget per slice (ms) when no idle deadline is known. */
const SLICE_MS = 3;
/**
 * Most of an idle period a slice may use (ms). A slice can overrun its budget
 * by one unit of work (a recipe build step or a chunk), so this stays well
 * under the 12 ms slice target.
 */
const IDLE_SLICE_MAX = 10;
/**
 * When the page never idles (frames that wait on the GPU, or use the whole frame
 * time) the idle callback only runs on its timeout: wait at most IDLE_TIMEOUT ms,
 * then work TIMEOUT_SLICE_MS. With frames that never leave idle time, 250 ms / 3 ms
 * (≈1 % of the main thread) took 10.6 s to the current-hour bed and 53 s to the
 * end of the warm-up; 50 ms / 6 ms takes 2.8 s and 12 s, slices still ≤ 10 ms.
 */
const IDLE_TIMEOUT = 50;
const TIMEOUT_SLICE_MS = 6;
const CHUNK = 8192;
let budgetOverride = 0;

/** Debug / test hook: force a fixed slice budget (ms); 0 restores idle-driven slicing. */
export function setRenderBudget(ms: number): void {
  budgetOverride = Math.max(0, ms);
}

interface IdleDeadlineLike {
  didTimeout: boolean;
  timeRemaining(): number;
}
type IdleWin = { requestIdleCallback?: (cb: (d: IdleDeadlineLike) => void, o?: { timeout: number }) => number };

/**
 * Wait for the main thread to be idle (requestIdleCallback, with a timeout so
 * progress never stalls); resolves with the milliseconds that may be used now.
 */
export function yieldMain(): Promise<number> {
  return new Promise<number>((res) => {
    const w = globalThis as unknown as IdleWin;
    if (typeof w.requestIdleCallback === 'function')
      w.requestIdleCallback((d) => res(budgetOverride || (d.didTimeout ? TIMEOUT_SLICE_MS : Math.max(2, Math.min(IDLE_SLICE_MAX, d.timeRemaining() - 1)))), { timeout: IDLE_TIMEOUT });
    else setTimeout(() => res(budgetOverride || SLICE_MS), 0);
  });
}

/** Time-slicer: call tick() inside loops; it yields when the slice budget is spent. */
class Slicer {
  private t = performance.now();
  private end = performance.now() + SLICE_MS;
  /** Accumulated main-thread milliseconds. */
  busy = 0;
  /** Longest uninterrupted main-thread slice (ms). */
  longest = 0;
  async tick(): Promise<void> {
    const now = performance.now();
    if (now < this.end) return;
    this.busy += now - this.t;
    this.longest = Math.max(this.longest, now - this.t);
    const ms = await yieldMain();
    this.t = performance.now();
    this.end = this.t + ms;
  }
  /** Run fn over [0, n) in chunks, yielding between slices. */
  async each(n: number, fn: (i0: number, i1: number) => void): Promise<void> {
    for (let i = 0; i < n; i += CHUNK) {
      fn(i, Math.min(n, i + CHUNK));
      await this.tick();
    }
  }
  pause(): void {
    const d = performance.now() - this.t;
    this.busy += d;
    this.longest = Math.max(this.longest, d);
  }
  restart(): void {
    this.t = performance.now();
    this.end = this.t + (budgetOverride || SLICE_MS);
  }
}

export interface RenderOptions {
  /** Upper bound on the render sample rate (lowSpec: 16 kHz for everything but cues). */
  maxRate?: number;
}

/** Per-colour seed offsets of the per-render loop noise. */
const LOOP_NOISE_SEED: Record<NoiseColor, number> = { white: 0x1f3d5b79, pink: 0x2c4e6a88, brown: 0x3b5f7d91 };

/** Length of the per-render noise of a loop recipe, s: the whole render plus a margin. */
export function loopNoiseSeconds(r: Recipe): number {
  return r.dur + (r.loop ?? 0) + 0.1;
}

/**
 * Render a recipe to a normalised buffer. The graph build (generator recipes
 * yield between parts) and the post-processing passes are time-sliced so a
 * render never blocks a frame for more than a few milliseconds.
 * Throws if the result is silent / invalid.
 */
export async function renderRecipe(r: Recipe, seed: number, opts: RenderOptions = {}): Promise<SoundAsset> {
  const Ctor = offlineCtor();
  if (!Ctor) throw new Error('OfflineAudioContext unavailable');
  const t0 = performance.now();
  const sl = new Slicer();
  const sr = Math.min(r.rate ?? 22050, opts.maxRate ?? Infinity);
  const fold = r.loop ?? 0;
  const total = r.dur + fold + (fold ? 0 : r.tail ?? 0.6);
  const len = Math.ceil(total * sr);
  const c = new Ctor(1, len, sr);
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = r.hp ?? 50;
  hp.Q.value = 0.6;
  hp.connect(c.destination);
  const dry = c.createGain();
  dry.connect(hp);
  let wet: AudioNode | null = null;
  if (r.reverb) {
    const conv = c.createConvolver();
    // short IRs: the convolver's FFT set-up runs on the main thread
    conv.buffer = impulse(c, r.reverb.decay, Math.min(r.reverb.length ?? 1, r.reverb.decay * 3, 1.1), r.reverb.bright ?? 0.5);
    const send = c.createGain();
    send.connect(conv);
    conv.connect(hp);
    wet = send;
  }
  await sl.tick();
  await prepareNoise(c, sl);
  // long noise in loops gets its own buffer as long as the render (no 3 s repeats inside the bed)
  const loopNoise: RenderNoise | undefined = fold ? { seconds: loopNoiseSeconds(r), sources: new Map() } : undefined;
  const kit = new Kit(c, dry, wet, new Rng(seed), total, loopNoise);
  const it = r.build(kit);
  if (it) while (!it.next().done) await sl.tick();
  if (loopNoise) await assignLoopNoise(c, loopNoise, seed, sl);
  sl.pause();
  const rendered = await startRendering(c);
  sl.restart();
  const asset = await postProcess(c, rendered, r, sl);
  sl.pause();
  asset.ms = performance.now() - t0;
  asset.mainMs = sl.busy;
  asset.sliceMs = sl.longest;
  return asset;
}

/** Generate a loop's per-render noise (one buffer per colour, sliced) and hand it to the waiting sources. */
async function assignLoopNoise(c: BaseAudioContext, noise: RenderNoise, seed: number, sl: Slicer): Promise<void> {
  for (const [color, srcs] of noise.sources) {
    const g = noiseBufferGen(c, color, noise.seconds, (seed ^ LOOP_NOISE_SEED[color]) >>> 0);
    let res = g.next();
    while (!res.done) {
      await sl.tick();
      res = g.next();
    }
    for (const src of srcs) src.buffer = res.value;
    await sl.tick();
  }
  noise.sources.clear();
}

async function postProcess(c: BaseAudioContext, buf: AudioBuffer, r: Recipe, sl: Slicer): Promise<SoundAsset> {
  const sr = buf.sampleRate;
  const d = buf.getChannelData(0);
  const fold = r.loop ?? 0;
  let n: number;
  let mean = 0;
  if (fold) {
    // Seamless loop: the rendered tail [L, L+X) continues the signal past the
    // loop point; cross-fade it (equal power) into the head [0, X) so that
    // sample L-1 → sample 0 is continuous.
    const L = Math.floor(r.dur * sr);
    n = L;
    const x = Math.min(Math.floor(fold * sr), d.length - L);
    await sl.each(x, (i0, i1) => {
      for (let i = i0; i < i1; i++) {
        const p = (i / x) * Math.PI * 0.5;
        d[i] = d[i] * Math.sin(p) + d[L + i] * Math.cos(p);
      }
    });
    await sl.each(n, (i0, i1) => {
      for (let i = i0; i < i1; i++) mean += d[i];
    });
    mean /= n;
  } else {
    // trim the silent tail (−66 dB of peak), keep 25 ms after it
    let pk = 0;
    await sl.each(d.length, (i0, i1) => {
      for (let i = i0; i < i1; i++) {
        const v = d[i] < 0 ? -d[i] : d[i];
        if (v > pk) pk = v;
      }
    });
    const floor = pk * 5e-4;
    let last = d.length - 1;
    while (last > 0) {
      const stop = Math.max(0, last - CHUNK);
      while (last > stop && Math.abs(d[last]) < floor) last--;
      if (last > stop) break;
      await sl.tick();
    }
    n = Math.min(d.length, last + Math.floor(0.025 * sr));
    // short fade-out so a truncated tail never clicks
    const fo = Math.min(n, Math.floor(0.02 * sr));
    for (let i = 0; i < fo; i++) d[n - 1 - i] *= i / fo;
    d.fill(0, n);
  }

  if (r.squash) {
    let pk = 0;
    const m0 = mean;
    await sl.each(n, (i0, i1) => {
      for (let i = i0; i < i1; i++) pk = Math.max(pk, Math.abs(d[i] - m0));
    });
    if (pk > 0) {
      const k = r.squash / pk;
      const g = 1 / Math.tanh(r.squash);
      // saturate, then a DC blocker (~15 Hz): tanh of an asymmetric wave adds offset
      const a = 1 - (2 * Math.PI * 15) / sr;
      let x1 = 0,
        y1 = 0;
      await sl.each(n, (i0, i1) => {
        for (let i = i0; i < i1; i++) {
          const x = Math.tanh((d[i] - m0) * k) * g;
          y1 = x - x1 + a * y1;
          x1 = x;
          d[i] = y1;
        }
      });
      mean = 0;
      if (fold) {
        await sl.each(n, (i0, i1) => {
          for (let i = i0; i < i1; i++) mean += d[i];
        });
        mean /= n;
      }
    }
  }
  let peak = 0;
  const m = mean;
  await sl.each(n, (i0, i1) => {
    for (let i = i0; i < i1; i++) {
      const v = d[i] - m;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
  });
  const rms = await weightedRmsSliced(d, n, sr, fold ? 0 : Math.floor(0.4 * sr), sl);
  if (!(peak > 1e-6) || !Number.isFinite(peak) || !(rms > 1e-7)) throw new Error('silent or invalid render');
  const norm = Math.min(r.peak / peak, r.rms / rms);
  await sl.each(n, (i0, i1) => {
    for (let i = i0; i < i1; i++) d[i] = (d[i] - m) * norm;
  });

  let out = buf;
  // exact-length buffer: loops wrap at the buffer end (no reliance on loopEnd),
  // one-shots drop their trailing silence to save memory
  if (fold || d.length - n > 0.15 * sr) {
    out = c.createBuffer(1, Math.max(1, n), sr);
    out.copyToChannel(d.subarray(0, n), 0);
  }
  return {
    buffer: out,
    loopEnd: fold ? n / sr : 0,
    duration: n / sr,
    peak: peak * norm,
    rms: rms * norm,
    norm,
    ms: 0,
    mainMs: 0,
    sliceMs: 0,
  };
}

async function weightedRmsSliced(d: Float32Array, n: number, sr: number, win: number, sl: Slicer): Promise<number> {
  // the filter is cheap; run it over chunks by re-entering with saved state
  const st = new WeightState(sr, n, win);
  await sl.each(n, (i0, i1) => st.feed(d, i0, i1));
  return st.result(sl);
}

/** Window-energy scratch, one per sample rate, reused by every render (grows as needed). */
const energyScratch = new Map<number, Float32Array>();
function scratchFor(sr: number, n: number): Float32Array {
  let a = energyScratch.get(sr);
  if (!a || a.length < n) {
    a = new Float32Array(Math.ceil(n * 1.25));
    energyScratch.set(sr, a);
  }
  return a;
}

/** Free the render caches (shared noise, reverb IRs, energy scratch); they are rebuilt on demand. */
export function releaseRenderCaches(): void {
  releaseNoise();
  irCache.clear();
  energyScratch.clear();
}

/** Streaming phone-speaker weighting (two one-pole high-passes at 300 Hz). */
class WeightState {
  private a: number;
  private x1 = 0;
  private y1 = 0;
  private y2 = 0;
  private z1 = 0;
  private total = 0;
  private sq: Float32Array | null;
  private w: number;
  constructor(
    sr: number,
    private n: number,
    win: number,
  ) {
    this.a = Math.exp((-2 * Math.PI * 300) / sr);
    this.w = win > 0 ? Math.max(1, Math.min(win, n)) : n;
    this.sq = win > 0 ? scratchFor(sr, n) : null;
  }
  feed(d: Float32Array, i0: number, i1: number): void {
    const a = this.a;
    let { x1, y1, y2, z1, total } = this;
    const sq = this.sq;
    for (let i = i0; i < i1; i++) {
      const x = d[i];
      y1 = a * (y1 + x - x1);
      x1 = x;
      const y = a * (y2 + y1 - z1);
      z1 = y1;
      y2 = y;
      const e = y * y;
      if (sq) sq[i] = e;
      total += e;
    }
    this.x1 = x1;
    this.y1 = y1;
    this.y2 = y2;
    this.z1 = z1;
    this.total = total;
  }
  async result(sl: Slicer): Promise<number> {
    const { sq, n, w } = this;
    if (!sq) return Math.sqrt(this.total / Math.max(1, n));
    let s = 0;
    for (let i = 0; i < w; i++) s += sq[i];
    let best = s;
    for (let i0 = w; i0 < n; i0 += CHUNK) {
      const i1 = Math.min(n, i0 + CHUNK);
      for (let i = i0; i < i1; i++) {
        s += sq[i] - sq[i - w];
        if (s > best) best = s;
      }
      await sl.tick();
    }
    return Math.sqrt(Math.max(0, best) / w);
  }
}

/**
 * Phone-speaker weighted RMS: two one-pole high-passes at 300 Hz, then the RMS
 * of the whole signal (win = 0) or of its loudest `win`-sample window.
 */
export function weightedRms(d: Float32Array, n: number, sr: number, win: number): number {
  const a = Math.exp((-2 * Math.PI * 300) / sr);
  let x1 = 0,
    y1 = 0,
    y2 = 0,
    z1 = 0;
  const w = win > 0 ? Math.max(1, Math.min(win, n)) : n;
  const sq = win > 0 ? new Float32Array(n) : null;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const x = d[i];
    y1 = a * (y1 + x - x1);
    x1 = x;
    const y = a * (y2 + y1 - z1);
    z1 = y1;
    y2 = y;
    const e = y * y;
    if (sq) sq[i] = e;
    total += e;
  }
  if (!sq) return Math.sqrt(total / Math.max(1, n));
  let s = 0;
  for (let i = 0; i < w; i++) s += sq[i];
  let best = s;
  for (let i = w; i < n; i++) {
    s += sq[i] - sq[i - w];
    if (s > best) best = s;
  }
  return Math.sqrt(Math.max(0, best) / w);
}

/** RMS of the loudest window (sliding sum of squares). */
export function loudestWindow(d: Float32Array, n: number, win: number): number {
  win = Math.max(1, Math.min(win, n));
  let s = 0;
  for (let i = 0; i < win; i++) s += d[i] * d[i];
  let best = s;
  for (let i = win; i < n; i++) {
    s += d[i] * d[i] - d[i - win] * d[i - win];
    if (s > best) best = s;
  }
  return Math.sqrt(Math.max(0, best) / win);
}
