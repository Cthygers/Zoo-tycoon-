// Synthesis kit and render pipeline pieces that run without Web Audio:
// noise generation, the noise offset picker and per-render loop noise length.
import { describe, expect, it } from 'vitest';
import { NOISE_SPACING, noiseData, pickNoiseOffset, type NoiseColor } from '../src/audio/kit';
import { RECIPES } from '../src/audio/recipes';
import { loopNoiseSeconds } from '../src/audio/render';
import { Rng } from '../src/core/rng';

function generate(sr: number, color: NoiseColor, seconds: number, seed: number): Float32Array {
  const g = noiseData(sr, color, seconds, seed);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

function circularGap(a: number, b: number, len: number): number {
  const d = Math.abs(a - b) % len;
  return Math.min(d, len - d);
}

describe('noise offsets', () => {
  it('keeps every pair of read offsets at least 0.25 s apart over 6 draws', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rng = new Rng(seed);
      const used: number[] = [];
      for (let k = 0; k < 6; k++) pickNoiseOffset(rng, used, 3, 2.9);
      for (let a = 0; a < used.length; a++)
        for (let b = a + 1; b < used.length; b++) expect(circularGap(used[a], used[b], 3)).toBeGreaterThanOrEqual(NOISE_SPACING);
    }
  });

  it('draws the first offset exactly like a plain rng.range', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    expect(pickNoiseOffset(a, [], 3, 2.9)).toBe(b.range(0, 2.9));
  });
});

describe('per-render loop noise', () => {
  it('is at least as long as every loop recipe render', () => {
    const loops = Object.entries(RECIPES).filter(([, r]) => r.loop);
    expect(loops.length).toBeGreaterThan(0);
    for (const [, r] of loops) {
      const s = loopNoiseSeconds(r);
      expect(s).toBeGreaterThanOrEqual(r.dur + r.loop!);
      const sr = r.rate ?? 22050;
      expect(generate(sr, 'pink', s, 7).length).toBeGreaterThanOrEqual(Math.ceil((r.dur + r.loop!) * sr));
    }
  });

  it('is deterministic per seed, different across seeds, and normalised', () => {
    const a = generate(8000, 'white', 2, 1);
    const b = generate(8000, 'white', 2, 1);
    const c = generate(8000, 'white', 2, 2);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    let ss = 0;
    for (const v of a) ss += v * v;
    expect(Math.sqrt(ss / a.length)).toBeCloseTo(0.25, 2);
  });

  it('does not repeat inside the buffer (no frozen 3 s cycle)', () => {
    const sr = 4000;
    const d = generate(sr, 'pink', 12, 3);
    const lag = 3 * sr;
    let num = 0,
      den = 0;
    for (let i = 0; i + lag < d.length; i++) {
      num += d[i] * d[i + lag];
      den += d[i] * d[i];
    }
    expect(Math.abs(num / den)).toBeLessThan(0.1);
  });
});
