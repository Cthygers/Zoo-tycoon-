import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { PathType, Terrain } from '../src/core/types';
import { World } from '../src/core/world';
import * as THREE from 'three';
import { buildPoolGrid, poolLight, surfaceBrightness, type WorldEmitter } from '../src/props/lights/nightlights';
import { applyLampField, figureColourShare, lampFieldAt, lampFieldUniforms, lampMarkReach, lampReach, moonShoulder, moonToe, resetLampField, skinMoonToe, writeLampField } from '../src/props/lights/lampField';
import { viewExposure } from '../src/render/grade';

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

  it('patches a standard material shader with two field fetches per vertex (light, colour mark) and keeps every hook for later patches', () => {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    applyLampField(shader);
    expect(shader.uniforms.uLampField).toBe(lampFieldUniforms.uLampField);
    expect(shader.uniforms.uLampLight).toBe(lampFieldUniforms.uLampLight);
    expect(shader.vertexShader.match(/textureLod\( uLampField|textureLod\(uLampField/g)?.length).toBe(2);
    expect(shader.fragmentShader).toContain('reflectedLight.indirectDiffuse += uLampLight');
    for (const hook of ['#include <common>', '#include <project_vertex>']) expect(shader.vertexShader).toContain(hook);
    for (const hook of ['#include <common>', '#include <aomap_fragment>', '#include <tonemapping_fragment>', '#include <opaque_fragment>'])
      expect(shader.fragmentShader).toContain(hook);
    // the lamp light lands before the lighting is summed up
    expect(shader.fragmentShader.indexOf('uLampLight * (')).toBeLessThan(shader.fragmentShader.indexOf('#include <aomap_fragment>'));
  });

  it('takes lamp light from the field only: the real point lights skip creatures, sun and moon still reach them', () => {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    applyLampField(shader);
    expect(shader.fragmentShader).not.toContain('#include <lights_fragment_begin>');
    expect(shader.fragmentShader).not.toContain('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )');
    expect(shader.fragmentShader).toContain('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
    expect(shader.fragmentShader).toContain('getHemisphereLightIrradiance');
  });

  it('marks only figures the pool visibly lights for the colour (lamp-lit) grade', () => {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    applyLampField(shader);
    const fs = shader.fragmentShader;
    expect(fs).toContain('pow(smoothstep(0.05, 0.80, vLampMark) * uLampMark, 0.70)');
    expect(fs).toContain('float lfMark = 0.40 * (0.5 - sin(asin(');
    expect(fs).toContain('whLampLit = lfMark;');
    // HDR target (post-FX tier): the same gradual mark through the alpha, and
    // the moonlit shoulder against the view's exposure (three leaves
    // toneMappingExposure out there)
    expect(fs).toContain('gl_FragColor.a += lfMark;');
    expect(fs).toContain('float lfExposure = uViewExposure;');
    expect(shader.uniforms.uViewExposure).toBe(viewExposure);
    // after the colour is final, before the tone map
    expect(fs.indexOf('float lfMark')).toBeGreaterThan(fs.indexOf('#include <opaque_fragment>'));
    expect(fs.indexOf('float lfMark')).toBeLessThan(fs.indexOf('#include <tonemapping_fragment>'));
  });

  it('colours figures gradually across a pool fringe instead of flipping one figure at a time', () => {
    expect(figureColourShare(0.6, 0)).toBe(0);
    expect(figureColourShare(0.03, 1)).toBe(0);
    expect(figureColourShare(0.9, 1)).toBe(1);
    // two guests a metre apart at the fringe (light 0.2 / 0.3) differ by a step, not a switch
    const a = figureColourShare(0.2, 1);
    const b = figureColourShare(0.3, 1);
    expect(a).toBeGreaterThan(0.1);
    expect(b).toBeLessThan(0.5);
    expect(b - a).toBeLessThan(0.25);
    for (let l = 0; l < 1; l += 0.05) expect(figureColourShare(l + 0.05, 1)).toBeGreaterThanOrEqual(figureColourShare(l, 1));
    // the shader's mark is the inverse of the grade's smoothstep (grade.ts) of that share
    const share = figureColourShare(0.35, 1);
    const mark = 0.4 * (0.5 - Math.sin(Math.asin(1 - 2 * share) / 3));
    const t = mark / 0.4;
    expect(t * t * (3 - 2 * t)).toBeCloseTo(share, 5);
  });

  it('keeps a moonlit white coat near a pale wall while guests outside the pools keep their level', () => {
    // displayed luminance (× exposure) of the round-8 night views, medium
    const coat = 0.24;
    const shirt = 0.078;
    expect(coat * moonShoulder(coat)).toBeGreaterThan(0.11);
    expect(coat * moonShoulder(coat)).toBeLessThan(0.15);
    expect(moonShoulder(shirt)).toBeGreaterThan(0.9);
    expect(moonShoulder(0.03)).toBeGreaterThan(0.995);
    // monotonic: brighter stays brighter
    for (let d = 0.02; d < 2; d *= 1.3) expect((d * 1.3) * moonShoulder(d * 1.3)).toBeGreaterThan(d * moonShoulder(d));
  });

  it('lifts moonlit dark coats out of the black, leaving mid tones and the shoulder alone', () => {
    // a giraffe's dark patch under the moon (≈ 0.006 displayed) against moonlit ground (≈ 0.04)
    expect(moonToe(0.006)).toBeGreaterThan(1.6);
    expect(moonToe(0.006)).toBeLessThan(2.01);
    expect(moonToe(0.03)).toBe(1);
    expect(moonToe(0.24)).toBe(1);
    // the whole moonlit curve stays monotonic
    const tone = (d: number) => d * moonShoulder(d) * moonToe(d);
    for (let d = 0.001; d < 2; d *= 1.1) expect(tone(d * 1.1)).toBeGreaterThan(tone(d));
  });

  it('reads the field out along the normal, further up the figure: a warm side facing the pool, not a whole-figure flip', () => {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    applyLampField(shader);
    const vs = shader.vertexShader;
    expect(vs).toContain('vec3 lfN = normalize((vec4(transformedNormal, 0.0) * viewMatrix).xyz);');
    expect(vs).toContain('vec2 lfAt = lfPos.xz + lfN.xz * (0.20 + 0.50 * max(transformed.y, 0.0));');
    // the normal exists before the field fetch
    expect(vs.indexOf('#include <defaultnormal_vertex>')).toBeLessThan(vs.indexOf('vec3 lfN'));
    expect(lampReach(0)).toBeCloseTo(0.2, 5);
    expect(lampReach(1.7)).toBeGreaterThan(0.9);
    expect(lampReach(1.7)).toBeLessThan(1.2);
    // a guest a metre outside a lamp-lit neighbour: the side facing the pool
    // reads the neighbour's light at chest height, the far side less than its own
    const field = (x: number) => Math.max(0, Math.min(1, 0.9 - 0.3 * x)); // pool light falling off to x = 3 m
    const at = 2.6;
    const toward = field(at - lampReach(1.3));
    expect(figureColourShare(field(at), 1)).toBeLessThan(0.15);
    expect(figureColourShare(toward, 1)).toBeGreaterThan(0.3);
    expect(field(at + lampReach(1.3))).toBeLessThanOrEqual(field(at));
  });

  it('colours the side of a fringe figure facing a pool from further out than it lights it', () => {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    applyLampField(shader);
    // the mark takes the larger of its own wider reading and the light's
    expect(shader.vertexShader).toContain('vec2 lfMarkAt = lfPos.xz + lfN.xz * (0.50 + 1.10 * max(transformed.y, 0.0));');
    expect(shader.vertexShader).toContain('vLampMark = max(vLampLight,');
    expect(shader.fragmentShader).toContain('vLampMark) * uLampMark');
    expect(lampMarkReach(1.3)).toBeGreaterThan(lampReach(1.3) + 0.8);
    // a guest 1.3 m outside the pool's faint edge: lit by little, but its pool side keeps colour
    const field = (x: number) => Math.max(0, Math.min(1, 0.9 - 0.3 * x));
    const at = 3.6;
    expect(field(at - lampReach(1.3))).toBeLessThan(0.1);
    expect(figureColourShare(field(at - lampMarkReach(1.3)), 1)).toBeGreaterThan(0.25);
  });

  it('keeps a dark face under the moon about a sixth of a white shirt, with pale skin untouched and every curve monotonic', () => {
    // displayed (× exposure) moonlit luminance: white shirt ≈ 0.072, a face of
    // albedo 0.054 (skin 5c3a25) beside it ≈ 0.005
    const aces = (d: number) => {
      const v = d / 0.6;
      return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
    };
    const shirt = 0.072, face = 0.005;
    expect(aces(face * moonToe(face)) / aces(shirt)).toBeLessThan(0.05); // the old void
    expect(aces(face * skinMoonToe(face, 1)) / aces(shirt)).toBeGreaterThan(1 / 7);
    // not past the albedo ratio of a mid-brown skin (0.19 / 0.79)
    expect(aces(face * skinMoonToe(face, 1)) / aces(shirt)).toBeLessThan(0.25);
    // outside the dark-skin mask it is the ordinary toe
    for (const d of [0.002, 0.01, 0.05]) expect(skinMoonToe(d, 0)).toBe(moonToe(d));
    // monotonic for every mask value: a face keeps its lit and shaded side
    for (const dark of [0.3, 0.7, 1]) {
      const tone = (d: number) => d * moonShoulder(d) * skinMoonToe(d, dark);
      for (let d = 0.0005; d < 1; d *= 1.08) expect(tone(d * 1.08)).toBeGreaterThan(tone(d));
    }
  });

  it('gives materials that define LF_SKIN the skin toe, and leaves the rest alone', () => {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    applyLampField(shader);
    const fs = shader.fragmentShader;
    expect(fs).toContain('#ifdef LF_SKIN');
    expect(fs).toContain('lfToe = max(lfToe, 1.0 + 6.50 * (LF_SKIN) * exp(-lfD / 0.018));');
    expect(fs).toContain('float lfTone = pow(1.0 + lfX2 * lfX2, -0.125) * lfToe;');
  });
});
