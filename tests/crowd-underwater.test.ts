// Batched animals below the pond surface get the lake bed's per-channel
// absorption: the shader hooks it relies on must keep matching.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { batchedAnimalMaterials } from '../src/models/crowd/materials';

function compile(material: THREE.Material): { vertexShader: string; fragmentShader: string } {
  const src = THREE.ShaderLib.standard;
  const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: THREE.UniformsUtils.clone(src.uniforms), defines: {} };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader;
}

describe('batched animals under water', () => {
  for (const skin of ['wrinkled', 'fur'] as const) {
    it(`absorbs submerged light before the colour is written (${skin})`, () => {
      const { vertexShader: vs, fragmentShader: fs } = compile(batchedAnimalMaterials({ skin }, 1).material);
      expect(vs).toMatch(/vCrWPos = \(modelMatrix \* batchingMatrix \* vec4\(transformed, 1\.0\)\)\.xyz;/);
      // the skinned position, not the bind pose
      expect(vs.indexOf('vCrWPos =')).toBeGreaterThan(vs.indexOf('transformed = vec3(dot(crR0'));
      const absorb = fs.indexOf('outgoingLight *= exp(');
      expect(absorb).toBeGreaterThan(0);
      expect(absorb).toBeLessThan(fs.lastIndexOf('#include <opaque_fragment>'));
      expect(fs).toContain('varying vec3 vCrWPos;');
    });
  }
});
