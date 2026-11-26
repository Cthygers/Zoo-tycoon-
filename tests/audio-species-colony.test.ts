// Colony murmur loops (recipes/colony.ts): the grain mix is circular and the
// rendered overhang folds back into exactly that mix, so the loop has no seam.
import { describe, expect, it } from 'vitest';
import { COLONY_RECIPES, FOLD_S, LOOP_S, foldable, wrap } from '../src/audio/recipes/colony';
import { foldLoop } from '../src/audio/render';

/** render.ts's own loop fold (foldLoop): the rendered [n, n + x) cross-faded into the head at equal power. */
function fold(d: Float32Array, n: number, x: number): Float32Array {
  const work = d.slice();
  foldLoop(work, n, x);
  return work.slice(0, n);
}

describe('colony loops', () => {
  it('wrap a grain that runs past the loop end onto the head', () => {
    const mix = new Float32Array(14);
    mix.fill(1, 8, 12); // a grain over samples 8..11 of a 10-sample loop
    const loop = wrap(mix, 10);
    expect(Array.from(loop)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 1, 1]);
  });

  it('fold back to exactly the circular mix (no level dip or bump at the seam)', () => {
    const n = 4000;
    const x = 800;
    const loop = new Float32Array(n);
    for (let i = 0; i < n; i++) loop[i] = Math.sin(i * 0.37) * (0.5 + 0.5 * Math.sin(i * 0.0031));
    const played = foldable(loop, x);
    expect(played.length).toBe(n + x);
    const out = fold(played, n, x);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(out[i] - loop[i]));
    expect(err).toBeLessThan(1e-5);
    // and the join out[n − 1] → out[0] continues the signal like any other pair of samples
    expect(Math.abs(out[0] - loop[0])).toBeLessThan(1e-5);
  });

  it('loop longer than the old 6 s within the 1.1 MB colony budget', () => {
    expect(LOOP_S).toBeGreaterThan(8);
    let bytes = 0;
    for (const [id, r] of Object.entries(COLONY_RECIPES)) {
      expect(r.dur, id).toBe(LOOP_S);
      expect(r.loop, id).toBe(FOLD_S);
      bytes += r.dur * (r.rate ?? 22050) * 4;
    }
    expect(bytes).toBeLessThanOrEqual(1.1e6);
  });
});
