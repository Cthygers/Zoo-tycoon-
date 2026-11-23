import { describe, expect, it } from 'vitest';
import { buildPoolGrid, poolLight, type WorldEmitter } from '../src/props/lights/nightlights';

function lamp(x: number, z: number, y = 3.2): WorldEmitter {
  return { x, y, z, kind: 'lamp', px: x, pz: z, radius: 6.7, intensity: 1 };
}

/** Light of the grid vertex at integer (x, z). */
function lightAt(grid: ReturnType<typeof buildPoolGrid>, x: number, z: number): number {
  for (let i = 0; i < grid.light.length; i++) if (grid.position[i * 3] === x && grid.position[i * 3 + 2] === z) return grid.light[i];
  return NaN;
}

/** Cells (by lower corner) covered by the index, with how often each is covered. */
function cellCounts(grid: ReturnType<typeof buildPoolGrid>): Map<string, number> {
  const counts = new Map<string, number>();
  for (let t = 0; t < grid.index.length; t += 3) {
    let x = Infinity;
    let z = Infinity;
    for (let k = 0; k < 3; k++) {
      const v = grid.index[t + k];
      x = Math.min(x, grid.position[v * 3]);
      z = Math.min(z, grid.position[v * 3 + 2]);
    }
    const key = `${x},${z}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe('night light pools', () => {
  const flat = () => 0;

  it('saturates summed light below 1 and keeps it monotonic', () => {
    expect(poolLight(0)).toBe(0);
    expect(poolLight(1)).toBeGreaterThan(0.6);
    expect(poolLight(2)).toBeGreaterThan(poolLight(1));
    expect(poolLight(50)).toBeLessThanOrEqual(1);
  });

  it('covers each ground cell once where pools overlap (double lamp heads)', () => {
    const single = buildPoolGrid([lamp(10.3, 10.3)], flat);
    const double = buildPoolGrid([lamp(10.3, 10.3), lamp(10.6, 10.3)], flat);
    for (const n of cellCounts(double).values()) expect(n).toBe(2); // two triangles per cell
    expect(double.index.length).toBeLessThan(single.index.length * 1.2);
    // overlapping light adds up and saturates instead of compounding
    const one = lightAt(single, 10, 10);
    const two = lightAt(double, 10, 10);
    expect(two).toBeGreaterThan(one);
    expect(two).toBeLessThan(1);
    for (const l of double.light) expect(l).toBeLessThanOrEqual(1);
  });

  it('fades to nothing at the pool edge and skips unlit cells', () => {
    const grid = buildPoolGrid([lamp(20, 20)], flat);
    expect(lightAt(grid, 20, 20)).toBeCloseTo(poolLight(1), 5);
    expect(lightAt(grid, 27, 20)).toBe(0);
    const cells = cellCounts(grid);
    expect(cells.has('20,20')).toBe(true);
    expect(cells.has('27,20')).toBe(false);
  });

  it('drapes the grid on the given surface', () => {
    const grid = buildPoolGrid([lamp(5, 5)], (x, z) => 0.1 * x + 0.02 * z);
    for (let i = 0; i < grid.light.length; i++) {
      const [x, y, z] = [grid.position[i * 3], grid.position[i * 3 + 1], grid.position[i * 3 + 2]];
      expect(y).toBeCloseTo(0.1 * x + 0.02 * z, 5);
    }
  });
});
