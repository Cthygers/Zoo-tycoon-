// Irregular intervals: every repeating idle, breath, rustle, filler and
// director turn of the fauna module is drawn around its median (log-normal),
// never the same twice in a row, so nothing an animal does ticks like a clock.

import type { Rng } from '../../core/rng';

/** Spread of a drawn interval (log-normal σ): a coefficient of variation of about 0.3. */
export const JITTER_SIGMA = 0.33;
/** A draw within this fraction of the previous interval is drawn again (never twice the same). */
export const JITTER_MIN_CHANGE = 0.08;
/** Draws are kept within [lo, hi] × the median. */
const JITTER_SPAN: readonly [number, number] = [0.45, 2.2];

/**
 * An interval around `median` s: log-normal (σ JITTER_SIGMA), clamped to
 * [lo, hi] s (default JITTER_SPAN × median), and at least JITTER_MIN_CHANGE
 * away from `prev` (the last interval drawn for the same clock, 0: none).
 */
export function jittered(median: number, rng: Rng, prev = 0, lo = median * JITTER_SPAN[0], hi = median * JITTER_SPAN[1]): number {
  let x = median;
  for (let i = 0; i < 4; i++) {
    x = Math.min(hi, Math.max(lo, median * Math.exp(JITTER_SIGMA * rng.gauss())));
    if (!prev || Math.abs(x / prev - 1) >= JITTER_MIN_CHANGE) return x;
  }
  // four close draws in a row (a narrow clamp): step away from the previous one, inside [lo, hi]
  const up = prev * (1 + JITTER_MIN_CHANGE);
  return up <= hi && (x >= prev || prev * (1 - JITTER_MIN_CHANGE) < lo) ? up : Math.max(lo, prev * (1 - JITTER_MIN_CHANGE));
}

/** jittered() around the middle of a [min, max] range (the ranges the module's tables give), within [0.6 × min, 1.5 × max]. */
export function jitteredIn(range: readonly [number, number], rng: Rng, prev = 0): number {
  return jittered((range[0] + range[1]) / 2, rng, prev, range[0] * 0.6, range[1] * 1.5);
}
