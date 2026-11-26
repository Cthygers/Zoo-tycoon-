// Pure helpers of the fauna module for foley: per-species body data, the
// footstep phase, the start limiter and guest step cadence / surface.

import { PathType } from '../../core/types';
import type { FoleyBank } from '../recipes/foley';

export type Feet = 'pad' | 'hoofHard' | 'hoofSoft' | 'bird';

export interface FoleySpecies {
  /** Metres per footfall. */
  stride: number;
  /** Footstep level, 0..1 (× −8 dB). */
  mass: number;
  feet: Feet;
  /** playbackRate of the foley (bigger animals lower). */
  rateScale: number;
  /** Close-up breathing level, 0 = none (big cats and bears breathe audibly too). */
  breath: number;
  /** Close-up tail swishes. */
  tail?: boolean;
  /** Laps when drinking (cats, bears); others splash or lap by context. */
  laps?: boolean;
  /** Crops grass while eating. */
  grazer?: boolean;
}

export const FOLEY_SPECIES: Readonly<Record<string, FoleySpecies>> = {
  elephant: { stride: 2.0, mass: 1.0, feet: 'pad', rateScale: 0.7, breath: 1, tail: true, grazer: true },
  hippo: { stride: 1.0, mass: 0.9, feet: 'pad', rateScale: 0.75, breath: 0.9, grazer: true },
  rhino: { stride: 1.2, mass: 0.9, feet: 'hoofSoft', rateScale: 0.75, breath: 0.9, tail: true, grazer: true },
  giraffe: { stride: 2.2, mass: 0.6, feet: 'hoofHard', rateScale: 0.85, breath: 0.6, tail: true },
  camel: { stride: 1.6, mass: 0.6, feet: 'pad', rateScale: 0.85, breath: 0.6, tail: true, grazer: true },
  zebra: { stride: 1.1, mass: 0.45, feet: 'hoofHard', rateScale: 1, breath: 0.45, tail: true, grazer: true },
  gazelle: { stride: 0.8, mass: 0.3, feet: 'hoofHard', rateScale: 1.1, breath: 0, tail: true, grazer: true },
  lion: { stride: 1.0, mass: 0.12, feet: 'pad', rateScale: 1, breath: 0.5, laps: true },
  tiger: { stride: 1.0, mass: 0.12, feet: 'pad', rateScale: 1, breath: 0.5, laps: true },
  grizzly: { stride: 1.0, mass: 0.5, feet: 'pad', rateScale: 0.9, breath: 0.6, laps: true },
  polarbear: { stride: 1.0, mass: 0.5, feet: 'pad', rateScale: 0.9, breath: 0.6, laps: true },
  gorilla: { stride: 0.7, mass: 0.35, feet: 'pad', rateScale: 1, breath: 0.4 },
  penguin: { stride: 0.15, mass: 0.2, feet: 'bird', rateScale: 1.2, breath: 0 },
  flamingo: { stride: 0.5, mass: 0.2, feet: 'bird', rateScale: 1.1, breath: 0 },
};

export const FEET_BANK: Readonly<Record<Feet, FoleyBank>> = {
  pad: 'fx.step.pad',
  hoofHard: 'fx.step.hoofHard',
  hoofSoft: 'fx.step.hoofSoft',
  bird: 'fx.step.bird',
};

/** Footstep level re a lion roar at its refDist: mass × −8 dB. */
export const STEP_DB = -8;
/** Steps of the animal the player looks at come forward (a close-up microphone). */
export const CLOSE_STEP_DB = 6;

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

/** Foley start limiter: at most `max` starts in any `window` s, and a minimum gap per source. */
export class FoleyLimiter {
  /** Recent start times (some lie slightly in the future: steps are scheduled ahead). */
  private readonly times: number[] = [];
  private readonly last = new Map<number, number>();

  constructor(
    private readonly max = 6,
    private readonly window = 1,
    private readonly perSourceGap = 0.15,
  ) {}

  /** Record a start for source `key` at time `t` (s); false when over a limit. */
  take(key: number, t: number): boolean {
    let recent = 0;
    for (const x of this.times) if (Math.abs(t - x) < this.window) recent++;
    if (recent >= this.max) return false;
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
