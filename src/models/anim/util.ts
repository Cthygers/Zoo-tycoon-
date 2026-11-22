// Small allocation-free helpers for procedural animation.

import type { AnimDriver, AnyDriver } from '../types';

export const TAU = Math.PI * 2;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const fract = (v: number): number => v - Math.floor(v);

/** Hash of an integer + seed → [0,1). */
export function hash1(k: number, seed = 0): number {
  let h = Math.imul((k | 0) ^ Math.imul(seed | 0, 0x27d4eb2d), 0x2c1b3c6d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Smooth 1D value noise in [-1, 1]. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash1(i, seed), hash1(i + 1, seed), u) * 2 - 1;
}

/** Layered smooth noise in about [-1, 1]. */
export function wander(x: number, seed = 0): number {
  return noise1(x, seed) * 0.65 + noise1(x * 2.3 + 17.1, seed + 3) * 0.35;
}

/**
 * "Glance" signal: holds a random value in [-1,1] for most of each period,
 * then moves smoothly to the next one (look-around, ear positions).
 */
export function glance(t: number, period: number, seed: number, moveFrac = 0.22): number {
  const x = t / period;
  const k = Math.floor(x);
  const f = x - k;
  const a = hash1(k, seed) * 2 - 1;
  const b = hash1(k + 1, seed) * 2 - 1;
  return lerp(a, b, smooth(1 - moveFrac, 1, f));
}

/** Occasional short pulses (0..1..0) — ear flicks, tail flicks, blinks. */
export function pulses(t: number, period: number, seed: number, width = 0.25, prob = 0.6): number {
  const k = Math.floor(t / period);
  if (hash1(k, seed) > prob) return 0;
  const start = hash1(k, seed + 11) * (period - width);
  const local = t - k * period - start;
  if (local < 0 || local > width) return 0;
  return Math.sin((local / width) * Math.PI);
}

/** Exponential smoothing factor for a time constant. */
export const damp = (tau: number, dt: number): number => 1 - Math.exp(-dt / Math.max(1e-4, tau));

/** Wrap a typed driver so it can be stored in a CreatureDesign. */
export function driver<S>(d: AnimDriver<S>): AnyDriver {
  return d as unknown as AnyDriver;
}

/** Inverse of driver() (framework use). */
export function unwrapDriver(d: AnyDriver): AnimDriver<unknown> {
  return d as unknown as AnimDriver<unknown>;
}
