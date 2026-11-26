// Ambient bed recipes (src/audio/recipes/beds.ts): the crowd pair, the biome
// beds and their memory and render-slicing contracts.
import { describe, expect, it } from 'vitest';
import { BED_RECIPES } from '../src/audio/recipes/beds';

const MB = 1024 * 1024;
/** Decoded size of a mono bed: the buffer is exactly `dur` long (the loop tail is folded into the head). */
const bytes = (id: string) => BED_RECIPES[id].dur * (BED_RECIPES[id].rate ?? 22050) * 4;
const BIOME = ['bed.savanna', 'bed.savanna.night', 'bed.arctic', 'bed.humid', 'bed.humid.night'];

describe('bed recipes', () => {
  it('render the crowd as two 16 kHz layers of incommensurate length within 2 MB', () => {
    const a = BED_RECIPES['bed.crowd'];
    const b = BED_RECIPES['bed.crowd.b'];
    expect([a.dur, b.dur]).toEqual([17, 13]);
    for (const r of [a, b]) expect(r).toMatchObject({ loop: 1.5, rate: 16000, peak: 0.45, rms: 0.1, hp: 200, squash: 1.3 });
    // whole seconds with no common factor: the pair only repeats after 17 × 13 = 221 s
    const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
    expect(gcd(a.dur, b.dur)).toBe(1);
    expect(bytes('bed.crowd') + bytes('bed.crowd.b')).toBeLessThanOrEqual(2 * MB);
  });

  it('has the five biome beds within 4.2 MB', () => {
    for (const id of BIOME) expect(BED_RECIPES[id], id).toBeDefined();
    expect(BIOME.reduce((s, id) => s + bytes(id), 0)).toBeLessThanOrEqual(4.2 * MB);
    expect(BED_RECIPES['bed.savanna'].rate).toBe(22050);
    for (const id of BIOME.slice(1)) expect(BED_RECIPES[id].rate, id).toBe(16000);
  });

  it('are seamless loops with sane caps, built in yielding slices', () => {
    for (const [id, r] of Object.entries(BED_RECIPES)) {
      expect(r.loop, id).toBeGreaterThan(0);
      expect(r.peak, id).toBeLessThanOrEqual(0.9);
      expect(r.rms, id).toBeLessThan(r.peak);
      // generator builds yield between parts so no render slice blocks the main thread for long
      expect(Object.prototype.toString.call(r.build), id).toBe('[object GeneratorFunction]');
    }
  });
});
