import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FoliageMaterial, RockMaterial } from '../src/props/nature/mats';

/** Run a material's onBeforeCompile on a copy of the physical shader source. */
function compile(m: THREE.Material): THREE.WebGLProgramParametersWithUniforms {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  m.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe('nature materials honour envMapIntensity under scene.environment', () => {
  it('scales the environment light of foliage (and its clones) by envMapIntensity', () => {
    const m = new FoliageMaterial({ translucency: 0.4 });
    const sh = compile(m);
    expect(sh.fragmentShader).toContain('RE_Direct_Leaf');
    expect((sh.uniforms.envMapScale as THREE.IUniform<number>).value).toBeCloseTo(0.6);
    const c = m.clone();
    c.envMapIntensity = 0.5;
    expect((compile(c).uniforms.envMapScale as THREE.IUniform<number>).value).toBeCloseTo(0.5);
    // one program for all foliage materials
    expect(c.customProgramCacheKey()).toBe(m.customProgramCacheKey());
  });

  it('keeps the rock shader patches', () => {
    const m = new RockMaterial({ triTex: new THREE.Texture(), tile: 1, bump: 0.01, envMapIntensity: 1.1 });
    const sh = compile(m);
    expect(sh.fragmentShader).toContain('rockPerturb');
    expect((sh.uniforms.envMapScale as THREE.IUniform<number>).value).toBeCloseTo(1.1);
    expect(sh.uniforms.uTriTex).toBeDefined();
  });
});
