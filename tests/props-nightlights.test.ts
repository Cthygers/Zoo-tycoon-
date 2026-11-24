import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { PathType, Terrain } from '../src/core/types';
import { World } from '../src/core/world';
import * as THREE from 'three';
import { buildPoolGrid, poolLight, surfaceBrightness, type WorldEmitter } from '../src/props/lights/nightlights';
import { applyLampField, lampFieldAt, lampFieldUniforms, resetLampField, writeLampField } from '../src/props/lights/lampField';

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

  it('carries the moonlit brightness of the surface under each vertex', () => {
    const world = new World(new EventBus(), 3);
    world.setTerrainRect({ x0: 8, z0: 8, x1: 12, z1: 12 }, Terrain.Grass);
    world.setPath(10, 10, PathType.Paved);
    world.setTerrainRect({ x0: 12, z0: 10, x1: 12, z1: 10 }, Terrain.Snow);
    const lawn = surfaceBrightness(world, 17, 21);
    const paved = surfaceBrightness(world, 21, 21); // centre of tile (10, 10)
    expect(paved).toBeGreaterThan(lawn);
    // a vertex on the path's edge takes the brighter side (never pushed past white)
    expect(surfaceBrightness(world, 20, 21)).toBe(paved);
    expect(surfaceBrightness(world, 19, 21)).toBe(lawn);
    expect(surfaceBrightness(world, 25, 21)).toBeGreaterThan(paved); // snow
    const grid = buildPoolGrid([lamp(21, 21)], () => 0, (x, z) => surfaceBrightness(world, x, z));
    for (let i = 0; i < grid.light.length; i++) expect(grid.bright[i]).toBeCloseTo(surfaceBrightness(world, grid.position[i * 3], grid.position[i * 3 + 2]), 6);
  });
});

describe('lamp light on creatures', () => {
  it('maps the pool grid onto the map-wide field', () => {
    const grid = buildPoolGrid([lamp(30.3, 40.2), lamp(-1, 2)], () => 0);
    writeLampField(grid.position, grid.light);
    expect(lampFieldAt(30, 40)).toBeCloseTo(lightAt(grid, 30, 40), 2);
    expect(lampFieldAt(33, 40)).toBeCloseTo(lightAt(grid, 33, 40), 2);
    expect(lampFieldAt(30, 48)).toBe(0);
    // a pool reaching past the map edge keeps its in-map part
    expect(lampFieldAt(0, 2)).toBeGreaterThan(0.3);
    resetLampField();
    expect(lampFieldAt(30, 40)).toBe(0);
    expect(lampFieldUniforms.uLampMark.value).toBe(0);
  });

  it('patches a standard material shader with one field fetch per vertex and keeps every hook for later patches', () => {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    applyLampField(shader);
    expect(shader.uniforms.uLampField).toBe(lampFieldUniforms.uLampField);
    expect(shader.uniforms.uLampLight).toBe(lampFieldUniforms.uLampLight);
    expect(shader.vertexShader.match(/textureLod\( uLampField|textureLod\(uLampField/g)?.length).toBe(1);
    expect(shader.fragmentShader).toContain('reflectedLight.indirectDiffuse += uLampLight');
    for (const hook of ['#include <common>', '#include <project_vertex>']) expect(shader.vertexShader).toContain(hook);
    for (const hook of ['#include <common>', '#include <aomap_fragment>', '#include <tonemapping_fragment>', '#include <opaque_fragment>'])
      expect(shader.fragmentShader).toContain(hook);
    // the lamp light lands before the lighting is summed up
    expect(shader.fragmentShader.indexOf('uLampLight * (')).toBeLessThan(shader.fragmentShader.indexOf('#include <aomap_fragment>'));
  });
});
