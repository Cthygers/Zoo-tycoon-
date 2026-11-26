// Colony murmur loops: 6 s of a whole flock (flamingo) or colony (penguin)
// calling over each other, made of the species' own syllable generators at
// random pitches and levels. The fauna module loops them under the individual
// calls at a level that follows the group size, so a big group never goes
// silent between calls.

import type { Kit } from '../kit';
import type { Recipe } from '../render';
import { flamingoGrunt, flamingoHonk, penguinContact, penguinPair, type SylGen } from './animals';

const LOOP_S = 6;
const FOLD_S = 1;
/** Mean grain rate (Poisson), grains per second. */
const GRAIN_RATE = 8;
/** Extra reverb send on top of the 0.05 every syllable bakes in (0.15 in total). */
const EXTRA_WET = 0.1;

interface Grain {
  gen: SylGen;
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
  const bus = k.gain(1);
  k.send(bus, 1, EXTRA_WET);
  // grains cover the loop plus the fold, which render.ts cross-fades into the head
  const end = LOOP_S + FOLD_S - 0.05;
  let t = r.range(0, 0.1);
  let count = 0;
  while (t < end) {
    const g = r.pick(s.grains);
    g.gen(k, t, r.range(g.d[0], g.d[1]), r.int(0, g.variants - 1), { pitch: r.range(0.75, 1.25), level: Math.pow(10, -r.range(0, 12) / 20), dest: bus });
    if (++count % 8 === 0) yield;
    t += -Math.log(1 - r.float()) / GRAIN_RATE;
  }
  for (let i = r.int(4, 6); i > 0; i--) {
    const g = s.low;
    g.gen(k, r.range(0, end - 0.3), r.range(g.d[0], g.d[1]), r.int(0, g.variants - 1), { pitch: r.range(s.lowPitch[0], s.lowPitch[1]), level: Math.pow(10, -r.range(0, 6) / 20), dest: bus });
  }
  yield;
  // babble floor: pink noise, band-pass 900 Hz, Q 0.8, −24 dB
  const nz = k.noise('pink', 0, LOOP_S + FOLD_S);
  k.chain(nz, k.bq('bandpass', 900, 0.8), k.gain(0.6, bus));
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
    grains: [{ gen: flamingoHonk, variants: 8, d: [0.1, 0.2] }],
    low: { gen: flamingoGrunt, variants: 4, d: [0.08, 0.08] },
    lowPitch: [0.9, 1.1],
  }),
  'loop.colony.penguin': loop({
    grains: [
      { gen: penguinContact, variants: 3, d: [0.25, 0.55] },
      { gen: penguinPair, variants: 4, d: [0.3, 0.5] },
    ],
    low: { gen: penguinContact, variants: 3, d: [0.4, 0.7] },
    lowPitch: [0.55, 0.65],
  }),
};
