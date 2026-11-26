// Colony murmur loops: 8.5 s of a whole flock (flamingo) or colony (penguin)
// calling over each other, made of the species' own syllables at random
// pitches and levels. The fauna module loops them under the individual calls
// at a level that follows the group size, so a big group never goes silent
// between calls. The grains are mixed in plain JS (voicePcm) and played as one
// buffer: as a node graph they would take seconds to render offline.
//
// The mix is circular: a grain that runs past the loop end continues at its
// head, so the loop has no seam and no grain-free stretch. Rendered at 16 kHz
// (the murmur has little above 5 kHz), which buys a longer loop in the colony
// memory budget; the engine also re-seeks each side to random points.

import type { Rng } from '../../core/rng';
import type { Kit } from '../kit';
import type { Recipe } from '../render';
import { pcmSource, voicePcm } from '../voice';
import { flamingoGruntSpecs, flamingoHonkSpecs, penguinContactSpecs, penguinPairSpecs, type SpecGen } from './animals';

export const LOOP_S = 8.5;
/** Rendered past the loop end; render.ts cross-fades it into the head. */
export const FOLD_S = 0.5;
const RATE = 16000;
/** Grain mix scale: ~3 overlapping grains of peak ≈ 1. */
const MIX = 0.35;
/** Longest grain, s: the overhang that wraps around onto the head. */
const MAX_GRAIN_S = 0.8;
/** Reverb send of the murmur. */
const WET = 0.15;
/** Babble floor RMS before MIX: about 24 dB under the grain mix. */
const FLOOR = 0.012;

interface Grain {
  specs: SpecGen;
  variants: number;
  d: readonly [number, number];
}

interface ColonySpec {
  grains: readonly Grain[];
  /** Mean grain rate, grains per second: short honks need more to stay continuous. */
  rate: number;
  /**
   * Whole-loop RMS (Recipe.rms) and peak cap: the levels the 6 s loops of round A1
   * reached, so the murmur sits where the fauna module's colony trim expects it.
   */
  rms: number;
  peak: number;
  /** 4–6 low grains under the chatter (feeding grunts, low brays). */
  low: Grain;
  lowPitch: readonly [number, number];
}

function* colony(k: Kit, s: ColonySpec): Generator<void> {
  const r = k.rng;
  const n = Math.floor(LOOP_S * k.sr);
  const mix = new Float32Array(n + Math.ceil(MAX_GRAIN_S * k.sr));
  const add = (g: Grain, t: number, pitch: number, level: number) => {
    const d = r.range(g.d[0], g.d[1]);
    for (const v of g.specs(r, t, d, r.int(0, g.variants - 1), { pitch, level })) voicePcm(v, k.sr, r, mix);
  };
  // jittered, not Poisson, onsets: no chance gaps where the flock falls silent.
  // One grain per slice: each is a few ms of JS
  for (let t = r.range(0, 0.1); t < LOOP_S; t += r.range(0.3, 1.7) / s.rate) {
    add(r.pick(s.grains), t, r.range(0.75, 1.25), Math.pow(10, -r.range(0, 8) / 20));
    yield;
  }
  for (let i = r.int(4, 6); i > 0; i--) {
    add(s.low, r.range(0, LOOP_S), r.range(s.lowPitch[0], s.lowPitch[1]), Math.pow(10, -r.range(0, 6) / 20));
    yield;
  }
  const loop = wrap(mix, n);
  yield* addBabble(loop, k.sr, r, FLOOR);
  const played = foldable(loop, Math.floor(FOLD_S * k.sr));
  yield;
  const bus = k.gain(MIX);
  k.send(bus, 1, WET);
  pcmSource(k, played, 0).connect(bus);
}

/** Fold everything past `n` back onto the head: the first n samples become a circular mix. */
export function wrap(mix: Float32Array, n: number): Float32Array {
  for (let i = n; i < mix.length; i++) mix[i % n] += mix[i];
  return mix.subarray(0, n);
}

/**
 * The circular `loop` played for its length plus `x` samples, windowed for
 * render.ts's loop fold, which cross-fades the rendered [n, n + x) into the
 * head at equal power (head × sin, overhang × cos). Both copies of the head
 * are identical, so the head here is pre-weighted by sin and the overhang by
 * cos: the fold then sums to sin² + cos² = 1, exactly the circular mix.
 */
export function foldable(loop: Float32Array, x: number): Float32Array {
  const n = loop.length;
  const out = new Float32Array(n + x);
  for (let i = 0; i < out.length; i++) out[i] = loop[i % n];
  for (let i = 0; i < x; i++) {
    const p = (i / x) * Math.PI * 0.5;
    out[i] *= Math.sin(p);
    out[n + i] *= Math.cos(p);
  }
  return out;
}

/**
 * Babble floor in JS (no render-length noise buffer needed): pink noise
 * (Kellet's economy filter) through a band-pass at 900 Hz, Q 0.8, at `rms`.
 * Generated a little past the loop end and cross-faded into the head, so the
 * floor is as seamless as the grains.
 */
function* addBabble(out: Float32Array, sr: number, r: Rng, rms: number): Generator<void> {
  const w0 = (2 * Math.PI * 900) / sr;
  const alpha = Math.sin(w0) / (2 * 0.8);
  const b0 = alpha / (1 + alpha);
  const a1 = (-2 * Math.cos(w0)) / (1 + alpha);
  const a2 = (1 - alpha) / (1 + alpha);
  const n = out.length;
  const x = Math.min(n, Math.floor(0.1 * sr));
  const band = new Float32Array(n + x);
  let p0 = 0,
    p1 = 0,
    p2 = 0,
    x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0,
    ss = 0;
  for (let i = 0; i < band.length; i++) {
    const w = r.float() * 2 - 1;
    p0 = 0.99765 * p0 + w * 0.099046;
    p1 = 0.963 * p1 + w * 0.2965164;
    p2 = 0.57 * p2 + w * 1.0526913;
    const v = p0 + p1 + p2 + w * 0.1848;
    const y = b0 * (v - x2) - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    band[i] = y;
    ss += y * y;
    if ((i & 16383) === 16383) yield;
  }
  // independent noise either side: equal power keeps the floor level through the join
  for (let i = 0; i < x; i++) {
    const p = (i / x) * Math.PI * 0.5;
    band[i] = band[i] * Math.sin(p) + band[n + i] * Math.cos(p);
  }
  yield;
  const g = rms / Math.sqrt(ss / Math.max(1, band.length) || 1);
  for (let i = 0; i < n; i++) out[i] += band[i] * g;
  yield;
}

function loop(s: ColonySpec): Recipe {
  return {
    dur: LOOP_S,
    loop: FOLD_S,
    rate: RATE,
    reverb: { decay: 0.35, length: 1.2, bright: 0.5 },
    peak: s.peak,
    rms: s.rms,
    hp: 250,
    build: (k) => colony(k, s),
  };
}

export const COLONY_RECIPES: Record<string, Recipe> = {
  'loop.colony.flamingo': loop({
    grains: [{ specs: flamingoHonkSpecs, variants: 8, d: [0.1, 0.2] }],
    rate: 12,
    rms: 0.057,
    peak: 0.5,
    low: { specs: flamingoGruntSpecs, variants: 4, d: [0.07, 0.1] },
    lowPitch: [0.9, 1.1],
  }),
  'loop.colony.penguin': loop({
    grains: [
      { specs: penguinContactSpecs, variants: 3, d: [0.25, 0.55] },
      { specs: penguinPairSpecs, variants: 4, d: [0.3, 0.5] },
    ],
    rate: 10,
    rms: 0.073,
    peak: 0.7,
    low: { specs: penguinContactSpecs, variants: 3, d: [0.4, 0.7] },
    lowPitch: [0.55, 0.65],
  }),
};
