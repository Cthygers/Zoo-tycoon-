// Rare calls stay rare. A species' signature-type bouts (a lion's moan-and-grunt
// call, a zebra's bray, a tiger's main call, an elephant's trumpet, a gorilla's
// chest-beat display, a hippo's honk series, a penguin colony's ecstatic
// display) are budgeted zoo-wide per real minute; the rest of the time a
// species is heard by its contact and idle calls. A flamingo flock's honking
// burst is a few honks, not a dozen, and not twice in a row.

import type { Rng } from '../../core/rng';
import type { Bout } from '../recipes/speciesAudio';

/** Rare calls per real minute at most, zoo-wide (a penguin colony each). Their average is about 0.75 of this. */
export const RARE_PER_MIN: Readonly<Record<string, number>> = { lion: 1, zebra: 2, tiger: 1, elephant: 1.5, gorilla: 0.5, hippo: 1, penguin: 1.5 };
/** After a rare call the species waits 60 / RARE_PER_MIN × this (random within) before the next. */
const RARE_SPACING: readonly [number, number] = [1, 1.6];
/** Gorillas chest-beat by day only: from and until these hours. */
export const DISPLAY_HOURS: readonly [number, number] = [6, 20];

/** Whether a bout is one of its species' rare calls (a gorilla's display, else a 'call' of a budgeted species). */
export function isRare(voice: string, bout: Bout): boolean {
  if (!(voice in RARE_PER_MIN)) return false;
  return voice === 'gorilla' ? bout.kind === 'display' : bout.kind === 'call';
}

/** Whether a rare call of `voice` may sound at all at this hour (no chest-beating at night). */
export function rareHour(voice: string, hour: number): boolean {
  if (voice !== 'gorilla') return true;
  const h = ((hour % 24) + 24) % 24;
  return h >= DISPLAY_HOURS[0] && h < DISPLAY_HOURS[1];
}

/** The zoo-wide budget: per key (a voice, or a penguin colony), the earliest time of its next rare call. */
export class RareBudget {
  private readonly next = new Map<string, number>();

  /** Whether `key` may sound a rare call at real time t. */
  free(key: string, t: number): boolean {
    return t >= (this.next.get(key) ?? -Infinity);
  }

  /** A rare call of `voice` under `key` started at t. */
  take(key: string, voice: string, t: number, rng: Rng): void {
    this.next.set(key, t + (60 / (RARE_PER_MIN[voice] ?? 1)) * rng.range(RARE_SPACING[0], RARE_SPACING[1]));
  }
}

/** A flamingo flock's burst out of focus: this many honks [min, max], at most one per FLOCK_BURST_GAP s per flock. */
export const FLOCK_BURST: readonly [number, number] = [4, 6];
export const FLOCK_BURST_GAP = 20;
