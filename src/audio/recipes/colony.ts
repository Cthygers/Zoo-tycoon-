// Colony murmur loops: 6 s of a whole flock (flamingo) or colony (penguin)
// calling over each other, made of the species' own syllables at random
// pitches and levels. The fauna module loops them under the individual calls
// at a level that follows the group size, so a big group never goes silent
// between calls. The ~50 grains are mixed in plain JS (voicePcm) and played
// as one buffer: as a node graph they would take seconds to render offline.

import type { Kit } from '../kit';
import type { Recipe } from '../render';
import { pcmSource, voicePcm } from '../voice';
import { flamingoGruntSpecs, flamingoHonkSpecs, penguinContactSpecs, penguinPairSpecs, type SpecGen } from './animals';

const LOOP_S = 6;
const FOLD_S = 1;
/** Mean grain rate (Poisson), grains per second. */
const GRAIN_RATE = 8;
/** Grain mix scale: ~3 overlapping grains of peak ≈ 1. */
const MIX = 0.35;
/** Half-width of the grain-free edges around the loop point, s. */
const SEAM_S = 0.12;
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
  /** 4–6 low grains under the chatter (feeding grunts, low brays). */
  low: Grain;
  lowPitch: readonly [number, number];
}

function* colony(k: Kit, s: ColonySpec): Generator<void> {
  const r = k.rng;
  // the mix covers the loop plus the fold, which render.ts cross-fades into the head
  const total = LOOP_S + FOLD_S;
  const mix = new Float32Array(Math.ceil(total * k.sr));
  // grains neither start nor end within SEAM_S of the loop point, so the
  // level either side of it stays even
  const add = (g: Grain, t: number, pitch: number, level: number) => {
    const d = r.range(g.d[0], g.d[1]);
    const near = (x: number) => Math.abs(x - LOOP_S) < SEAM_S;
    if (near(t) || near(t + d)) t = LOOP_S + SEAM_S;
    for (const v of g.specs(r, t, d, r.int(0, g.variants - 1), { pitch, level })) voicePcm(v, k.sr, r, mix);
  };
  let t = r.range(0, 0.1);
  // one grain per slice: each is a few ms of JS
  while (t < total - 0.05) {
    add(r.pick(s.grains), t, r.range(0.75, 1.25), Math.pow(10, -r.range(0, 12) / 20));
    yield;
    t += -Math.log(1 - r.float()) / GRAIN_RATE;
  }
  for (let i = r.int(4, 6); i > 0; i--) {
    add(s.low, r.range(0, total - 0.8), r.range(s.lowPitch[0], s.lowPitch[1]), Math.pow(10, -r.range(0, 6) / 20));
    yield;
  }
  yield* addBabble(mix, k.sr, r, FLOOR);
  const bus = k.gain(MIX);
  k.send(bus, 1, WET);
  pcmSource(k, mix, 0).connect(bus);
}

/**
 * Babble floor in JS (no render-length noise buffer needed): pink noise
 * (Kellet's economy filter) through a band-pass at 900 Hz, Q 0.8, at `rms`.
 */
function* addBabble(out: Float32Array, sr: number, r: Kit['rng'], rms: number): Generator<void> {
  const w0 = (2 * Math.PI * 900) / sr;
  const alpha = Math.sin(w0) / (2 * 0.8);
  const b0 = alpha / (1 + alpha);
  const a1 = (-2 * Math.cos(w0)) / (1 + alpha);
  const a2 = (1 - alpha) / (1 + alpha);
  const band = new Float32Array(out.length);
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
    const x = p0 + p1 + p2 + w * 0.1848;
    const y = b0 * (x - x2) - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    band[i] = y;
    ss += y * y;
    if ((i & 32767) === 32767) yield;
  }
  const g = rms / Math.sqrt(ss / Math.max(1, band.length) || 1);
  for (let i = 0; i < band.length; i++) out[i] += band[i] * g;
}

function loop(s: ColonySpec): Recipe {
  return {
    dur: LOOP_S,
    loop: FOLD_S,
    rate: 22050,
    reverb: { decay: 0.35, length: 1.2, bright: 0.5 },
    peak: 0.5,
    rms: 0.08,
    hp: 250,
    build: (k) => colony(k, s),
  };
}

export const COLONY_RECIPES: Record<string, Recipe> = {
  'loop.colony.flamingo': loop({
    grains: [{ specs: flamingoHonkSpecs, variants: 8, d: [0.1, 0.2] }],
    low: { specs: flamingoGruntSpecs, variants: 4, d: [0.07, 0.1] },
    lowPitch: [0.9, 1.1],
  }),
  'loop.colony.penguin': loop({
    grains: [
      { specs: penguinContactSpecs, variants: 3, d: [0.25, 0.55] },
      { specs: penguinPairSpecs, variants: 4, d: [0.3, 0.5] },
    ],
    low: { specs: penguinContactSpecs, variants: 3, d: [0.4, 0.7] },
    lowPitch: [0.55, 0.65],
  }),
};
