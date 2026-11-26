// Pure helpers of the fauna module for foley: per-species body data and
// family banks, the footstep phase, the start limiters and guest step
// cadence / surface.

import { PathType } from '../../core/types';
import type { FoleyBank } from '../recipes/foley';

export type Feet = 'pad' | 'hoofHard' | 'hoofSoft' | 'bird' | 'scuff';

export interface FoleySpecies {
  /** Metres per footfall. */
  stride: number;
  /** Footstep level, 0..1 (× −8 dB). */
  mass: number;
  feet: Feet;
  /** playbackRate of the foley (bigger animals lower). */
  rateScale: number;
  /** Close-up breathing level, 0 = no audible breath (birds: a feather rustle instead). */
  breath: number;
  /** Resting breath interval close up [min, max], s (absent: no breath). */
  breathEvery?: readonly [number, number];
  /** Pants after a run (big cats): a breath every 1–1.5 s for a few seconds. */
  pants?: boolean;
  /** Close-up step trim, dB: heavy pad-footed giants walk almost silently. */
  stepDb?: number;
  /** Close up, the typical silence (steps aside) before something of the awake animal is heard, s (default QUIET): drawn per gap within QUIET_SPAN. */
  quiet?: number;
  /** Close-up tail swishes. */
  tail?: boolean;
  /** Laps when drinking (cats, bears); others splash or lap by context. */
  laps?: boolean;
  /** Crops grass while eating. */
  grazer?: boolean;
  /** Chews the cud between meals (a close-up filler). */
  cud?: boolean;
}

/** Big herbivores breathe slowly and stand quietly: a longer typical silence between close-up sounds, s. */
const BIG_QUIET = 3.6;

export const FOLEY_SPECIES: Readonly<Record<string, FoleySpecies>> = {
  elephant: { stride: 2.0, mass: 1.0, feet: 'scuff', rateScale: 0.7, breath: 1, breathEvery: [9, 13], stepDb: -8, quiet: BIG_QUIET, tail: true, grazer: true },
  hippo: { stride: 1.0, mass: 0.9, feet: 'scuff', rateScale: 0.75, breath: 0.9, breathEvery: [6, 10], stepDb: -8, quiet: BIG_QUIET, grazer: true },
  rhino: { stride: 1.2, mass: 0.9, feet: 'scuff', rateScale: 0.75, breath: 0.9, breathEvery: [6, 10], stepDb: -8, quiet: BIG_QUIET, tail: true, grazer: true },
  giraffe: { stride: 2.2, mass: 0.6, feet: 'hoofHard', rateScale: 0.85, breath: 0.6, breathEvery: [6, 9], quiet: BIG_QUIET, tail: true, cud: true },
  camel: { stride: 1.6, mass: 0.6, feet: 'pad', rateScale: 0.85, breath: 0.6, breathEvery: [6, 9], quiet: BIG_QUIET, tail: true, grazer: true, cud: true },
  zebra: { stride: 1.1, mass: 0.45, feet: 'hoofHard', rateScale: 1, breath: 0.45, breathEvery: [4, 7], tail: true, grazer: true },
  gazelle: { stride: 0.8, mass: 0.3, feet: 'hoofHard', rateScale: 1.1, breath: 0.3, breathEvery: [4, 7], tail: true, grazer: true, cud: true },
  lion: { stride: 1.0, mass: 0.12, feet: 'pad', rateScale: 1, breath: 0.9, breathEvery: [4, 6], pants: true, tail: true, laps: true },
  tiger: { stride: 1.0, mass: 0.12, feet: 'pad', rateScale: 1, breath: 0.9, breathEvery: [4, 6], pants: true, tail: true, laps: true },
  grizzly: { stride: 1.0, mass: 0.5, feet: 'pad', rateScale: 0.9, breath: 0.6, breathEvery: [4, 6], laps: true },
  polarbear: { stride: 1.0, mass: 0.5, feet: 'pad', rateScale: 0.9, breath: 0.6, breathEvery: [4, 6], laps: true },
  gorilla: { stride: 0.7, mass: 0.35, feet: 'pad', rateScale: 1, breath: 0.4, breathEvery: [4, 5] },
  penguin: { stride: 0.15, mass: 0.2, feet: 'bird', rateScale: 1.2, breath: 0 },
  flamingo: { stride: 0.5, mass: 0.2, feet: 'bird', rateScale: 1.1, breath: 0 },
};

/** Close up, the typical silence (steps aside) of an awake animal without its own `quiet`, s ... */
export const QUIET = 3;
/** ... each gap drawn within these bounds, s (the looked-at animal is never silent much longer than 5 s). */
export const QUIET_SPAN: readonly [number, number] = [1.8, 4.6];
/** Panting after a run: interval [min, max] s, for this long after the run ends, s. */
export const PANT_EVERY: readonly [number, number] = [1, 1.5];
export const PANT_FOR = 8;
/** Birds do not breathe audibly: a soft feather rustle every [min, max] s close up ... */
export const RUSTLE_EVERY: readonly [number, number] = [8, 20];
/** ... and a sleeping bird is near-silent: a rustle every [min, max] s. */
export const SLEEP_RUSTLE: readonly [number, number] = [15, 40];
/** A sleeping animal breathes this much slower than its resting rhythm, and this many dB softer. */
export const SLEEP_BREATH = 1.4;
export const SLEEP_BREATH_DB = -3;
/** Chewing while eating, close up: one chew every [min, max] s. */
export const CHEW_EVERY: readonly [number, number] = [0.9, 1.6];

/** Shortest and longest resting breath interval over the body families, s. */
export const BREATH_RANGE: readonly [number, number] = (() => {
  const all = Object.values(FOLEY_SPECIES).flatMap((b) => b.breathEvery ?? []);
  return [Math.min(...all), Math.max(...all)] as const;
})();

export type FoleyKind = 'breath' | 'chew' | 'drink' | 'rustle';
export type FoleyFamily = 'cat' | 'pachyderm' | 'bear' | 'grazer' | 'equid' | 'primate' | 'bird';

/** Body family of each voice: it breathes, chews and drinks from `fx.<kind>.<family>` once that bank is registered. */
export const FOLEY_FAMILY: Readonly<Record<string, FoleyFamily>> = {
  lion: 'cat',
  tiger: 'cat',
  elephant: 'pachyderm',
  hippo: 'pachyderm',
  rhino: 'pachyderm',
  grizzly: 'bear',
  polarbear: 'bear',
  giraffe: 'grazer',
  gazelle: 'grazer',
  camel: 'grazer',
  zebra: 'equid',
  gorilla: 'primate',
  flamingo: 'bird',
  penguin: 'bird',
};

/** The shared banks every family uses until it has its own (a tail swish stands in for a bird's feather rustle). */
export const GENERIC_FOLEY: Readonly<Record<FoleyKind, FoleyBank>> = { breath: 'fx.breath.big', chew: 'fx.chew', drink: 'fx.lap', rustle: 'fx.tail' };

/** `fx.<kind>.<family>` when its first variant is registered, else the generic bank of that kind. */
export function foleyBankFor(kind: FoleyKind, voice: string, registered: (id: string) => boolean): string {
  const family = FOLEY_FAMILY[voice];
  const base = family ? `fx.${kind}.${family}` : '';
  return base && registered(`${base}#0`) ? base : GENERIC_FOLEY[kind];
}

/** Number of registered variants `${base}#0..k-1` (0 when only the bare id or nothing is registered). */
export function registeredVariants(base: string, registered: (id: string) => boolean): number {
  let k = 0;
  while (registered(`${base}#${k}`)) k++;
  return k;
}

export const FEET_BANK: Readonly<Record<Feet, FoleyBank>> = {
  pad: 'fx.step.pad',
  hoofHard: 'fx.step.hoofHard',
  hoofSoft: 'fx.step.hoofSoft',
  bird: 'fx.step.bird',
  // pad-footed giants: a soft, dull scuff
  scuff: 'fx.step.scuff',
};

/** Footstep level re a lion roar at its refDist: mass × −8 dB. */
export const STEP_DB = -8;
/** Steps of the animal the player looks at come forward (a close-up microphone), well under its voice. */
export const CLOSE_STEP_DB = 5;
/** Close-up steps are at least this heavy, so light animals (lion, penguin, flamingo, gazelle) are heard walking. */
export const CLOSE_STEP_MASS = 0.45;

/**
 * Advance a footstep phase by `dt` s and return the offsets (s from now) of the
 * footfalls in that window: one per integer crossing of speed·t / stride.
 */
export function stepCrossings(phase: number, speed: number, stride: number, dt: number, out: number[]): number {
  out.length = 0;
  const perS = speed / stride;
  const next = phase + perS * dt;
  for (let k = Math.floor(phase) + 1; k <= next; k++) out.push((k - phase) / perS);
  return next;
}

/**
 * Foley start limiter: at most `max` starts in any `window` s, and a minimum gap
 * per source. `reserve` of the `max` starts are kept for priority sources (the
 * animal the player looks at).
 */
export class FoleyLimiter {
  /** Recent start times (some lie slightly in the future: steps are scheduled ahead). */
  private readonly times: number[] = [];
  private readonly last = new Map<number, number>();

  constructor(
    private readonly max = 6,
    private readonly window = 1,
    private readonly perSourceGap = 0.15,
    private readonly reserve = 0,
  ) {}

  /** Record a start for source `key` at time `t` (s); false when over a limit. */
  take(key: number, t: number, priority = false): boolean {
    let recent = 0;
    for (const x of this.times) if (Math.abs(t - x) < this.window) recent++;
    if (recent >= (priority ? this.max : this.max - this.reserve)) return false;
    const prev = this.last.get(key);
    if (prev !== undefined && Math.abs(t - prev) < this.perSourceGap) return false;
    this.times.push(t);
    // keep every start that can still fall inside a window (insertion order is not time order)
    if (this.times.length > this.max * 2) this.times.splice(0, this.times.length, ...this.times.filter((x) => t - x < this.window * 2));
    this.last.set(key, t);
    // sources come and go (guests): drop entries that can no longer block
    if (this.last.size > 256) for (const [k, v] of this.last) if (t - v >= this.perSourceGap) this.last.delete(k);
    return true;
  }
}

/** Guest steps per second: one per 0.7 m, children 1.25× quicker. */
export function guestCadence(speed: number, child: boolean): number {
  return (speed / 0.7) * (child ? 1.25 : 1);
}

export function guestStepBank(path: PathType): FoleyBank | null {
  switch (path) {
    case PathType.Paved:
      return 'fx.gstep.paved';
    case PathType.Gravel:
      return 'fx.gstep.gravel';
    case PathType.Boardwalk:
      return 'fx.gstep.board';
    default:
      return null;
  }
}
