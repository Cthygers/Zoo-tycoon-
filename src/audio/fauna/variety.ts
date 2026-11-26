// Runtime variety of the animal voices: a syllable variant never comes back
// soon after sounding the same (same recording at nearly the same playbackRate),
// rates spread a little on every play and every play gets its own slight colour.

import type { Rng } from '../../core/rng';
import type { Individual } from './bout';

/** Two plays of one variant within this many s ... */
export const REPEAT_WINDOW = 10;
/** ... whose playbackRates differ by at most this fraction sound like the same recording. */
export const REPEAT_RATE = 0.03;
/** playbackRate spread of every syllable play (±), at least the species' own jitter. */
export const RATE_SPREAD = 0.04;
/** How far a rate may be nudged off its draw to avoid a repeat (±). */
const MAX_NUDGE = 0.1;
const NUDGE_STEP = 0.01;

/** Zoo-wide record of recent syllable plays (id → times and rates). */
export class RepeatGuard {
  private readonly recent = new Map<string, { t: number; rate: number }[]>();

  /** Whether `id` played within REPEAT_WINDOW s of `now` at a rate within REPEAT_RATE of `rate`. */
  clashes(id: string, rate: number, now: number): boolean {
    const list = this.recent.get(id);
    if (!list) return false;
    for (const r of list) if (now - r.t < REPEAT_WINDOW && Math.abs(rate / r.rate - 1) <= REPEAT_RATE) return true;
    return false;
  }

  /** The rate nearest `rate` (within ±10 % and ≤ `max`) that does not clash for `id`, or null. */
  freeRate(id: string, rate: number, now: number, max = Infinity): number | null {
    for (let k = 1; k * NUDGE_STEP <= MAX_NUDGE + 1e-9; k++)
      for (const x of [rate * (1 + k * NUDGE_STEP), rate * (1 - k * NUDGE_STEP)])
        if (x <= max && !this.clashes(id, x, now)) return x;
    return null;
  }

  note(id: string, rate: number, now: number): void {
    let list = this.recent.get(id);
    if (!list) this.recent.set(id, (list = []));
    while (list.length && now - list[0].t >= REPEAT_WINDOW) list.shift();
    list.push({ t: now, rate });
  }
}

/**
 * Per-play colour: the individual's peaking filter, moved into the 1–3 kHz
 * presence range a phone speaker reproduces, ±8 % in frequency and ±2 dB on
 * every play.
 */
export function playColor(ind: Individual, rng: Rng): { hz: number; db: number } {
  const hz = Math.min(3000, Math.max(1000, ind.color.hz)) * rng.range(0.92, 1.08);
  return { hz, db: ind.color.db + rng.range(-2, 2) };
}
