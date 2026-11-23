// Batched animals below the pond surface look like the pond around them
// (diffuse light only, fading along the view ray into the lit wet bed and
// absorbed per channel with the bed's coefficients), blended in over a few cm
// at the waterline: the shader hooks it relies on must keep matching.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LAKE_BED_WET_ALBEDO, WATER_ABSORPTION } from '../src/core/constants';
import { batchedAnimalMaterials } from '../src/models/crowd/materials';

function compile(material: THREE.Material): { vertexShader: string; fragmentShader: string } {
  const src = THREE.ShaderLib.standard;
  const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: THREE.UniformsUtils.clone(src.uniforms), defines: {} };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader;
}

/** The underwater block: from the depth below the surface to the final mix. */
function underwaterBlock(fs: string): string {
  const start = fs.indexOf('float crWd =');
  const end = fs.indexOf('outgoingLight = mix(outgoingLight, lit, crSub);');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return fs.slice(start, end);
}

describe('batched animals under water', () => {
  for (const skin of ['wrinkled', 'fur'] as const) {
    it(`shades submerged parts like the pond before the colour is written (${skin})`, () => {
      const { vertexShader: vs, fragmentShader: fs } = compile(batchedAnimalMaterials({ skin }, 1).material);
      expect(vs).toMatch(/vCrWPos = \(modelMatrix \* batchingMatrix \* vec4\(transformed, 1\.0\)\)\.xyz;/);
      // the skinned position, not the bind pose
      expect(vs.indexOf('vCrWPos =')).toBeGreaterThan(vs.indexOf('transformed = vec3(dot(crR0'));
      expect(fs).toContain('varying vec3 vCrWPos;');
      const block = underwaterBlock(fs);
      expect(fs.indexOf('outgoingLight = mix(outgoingLight, lit, crSub);')).toBeLessThan(fs.lastIndexOf('#include <opaque_fragment>'));
      // a soft waterline, not a hard cut at the surface
      expect(block).toMatch(/crSub = smoothstep\(-0\.\d+, 0\.\d+, crWd\)/);
      // built from diffuse light only: no sheen, specular or highlight rim under water
      expect(block).toContain('reflectedLight.directDiffuse');
      expect(block).toContain('reflectedLight.indirectDiffuse');
      expect(block).not.toMatch(/Specular|outgoingLight \+/);
      // the lake bed's per-channel absorption and wet albedo (shared constants)
      const vecs = [...block.matchAll(/vec3\(([-\d.]+), ([-\d.]+), ([-\d.]+)\)/g)].map((m) => [m[1], m[2], m[3]].map(Number));
      const has = (v: readonly number[]) => vecs.some((u) => u.every((x, i) => Math.abs(x - v[i]) < 1e-6));
      expect(has(WATER_ABSORPTION)).toBe(true);
      expect(has(LAKE_BED_WET_ALBEDO)).toBe(true);
      // the murk is lit by the sun where the view ray enters the water (its shadow sampled there)
      expect(block).toContain('directionalShadowMatrix[0] * vec4(vCrWPos + toEye');
      expect(fs).toMatch(/uniform highp mat4 directionalShadowMatrix\[ NUM_DIR_LIGHT_SHADOWS \];/);
    });
  }
});
