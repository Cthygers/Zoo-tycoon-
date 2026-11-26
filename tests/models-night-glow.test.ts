// Figures' night look without glowing points: fur partings and clumps leave
// single pixels with a slightly negative albedo (black either way). The night
// look's hue (albedo / its luminance) divided by their near-zero luminance and
// lit them as bright points, with bloom halos on the post-FX tier (eyes, heads
// and hooves of zebras, gazelles, giraffes at night). The hue now comes from
// the albedo clamped at zero: unchanged for every real coat colour.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createAnimalMaterial } from '../src/models/material/animalMaterial';
import { FIGURE_NIGHT } from '../src/models/material/figureNight';

const LUMA = [0.2126, 0.7152, 0.0722];
const lum = (c: number[]) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];

/** The night look's diffuse light for albedo `d` under light `irr` (figureNight.ts fragmentLight at level 1), as the shader computes it. */
function nightDiffuse(d: number[], irr: number[]): number[] {
  const light = d.map((x, i) => (irr[i] * x) / Math.PI);
  const alb = d.map((x) => Math.max(x, 0));
  const hue = alb.map((x) => x / Math.max(lum(alb), 1e-4));
  const k = FIGURE_NIGHT.light;
  return light.map((x, i) => x + (lum(light) * hue[i] - x) * k);
}

describe('figure night look: no glowing points', () => {
  it('computes the hue from the albedo clamped at zero', () => {
    const fs = (() => {
      const src = THREE.ShaderLib.physical;
      const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: {}, defines: {} };
      createAnimalMaterial({ look: { skin: 'fur', pattern: 'stripes' }, detail: 2 }).onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
      return shader.fragmentShader;
    })();
    expect(fs).toContain('vec3 fnAlb = max(diffuseColor.rgb, 0.0);');
    expect(fs).toContain('vec3 fnHue = fnAlb / max(dot(fnAlb, vec3(0.2126, 0.7152, 0.0722)), 1e-4);');
  });

  it('keeps near-black specks with a slightly negative albedo dark (the old hue lit them hundreds of times over)', () => {
    // blue moonlight (sky fill) and a lamp-warm light
    for (const irr of [[0.35, 0.55, 1.2], [1.4, 1.0, 0.6]]) {
      for (const d of [[0.004, -0.0011, 0.0005], [-0.002, 0.0008, 0.003], [0.0024, 0.0024, 0.0024], [-0.01, -0.01, -0.01]]) {
        const out = nightDiffuse(d, irr);
        // within the light such a pixel would reflect at its largest albedo channel
        const bound = (Math.max(...irr) * Math.max(...d.map(Math.abs))) / Math.PI;
        for (const c of out) expect(Math.abs(c)).toBeLessThanOrEqual(bound * 1.0001 + 1e-9);
        // the old hue: the albedo over its own (near-zero, clamped) luminance
        const light = d.map((x, i) => (irr[i] * x) / Math.PI);
        const oldHue = d.map((x) => x / Math.max(lum(d), 1e-4));
        const old = light.map((x, i) => x + (lum(light) * oldHue[i] - x) * FIGURE_NIGHT.light);
        if (lum(d) < 1e-4) expect(Math.max(...old.map(Math.abs))).toBeGreaterThan(Math.max(...out.map(Math.abs)));
      }
    }
  });

  it('leaves every real (non-negative) coat colour as it was', () => {
    const irr = [0.35, 0.55, 1.2];
    for (const d of [[0.5, 0.05, 0.02], [0.03, 0.025, 0.02], [0.8, 0.8, 0.78]]) {
      const light = d.map((x, i) => (irr[i] * x) / Math.PI);
      const hue = d.map((x) => x / Math.max(lum(d), 1e-4));
      const before = light.map((x, i) => x + (lum(light) * hue[i] - x) * FIGURE_NIGHT.light);
      const after = nightDiffuse(d, irr);
      after.forEach((c, i) => expect(c).toBeCloseTo(before[i], 12));
    }
  });
});
