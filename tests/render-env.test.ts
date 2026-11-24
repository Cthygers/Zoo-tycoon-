import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { useEnvMapIntensity } from '../src/render/envIntensity';
import { RenderContext } from '../src/render/context';

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

describe('useEnvMapIntensity', () => {
  it('scales the environment light by the live envMapIntensity', () => {
    const m = new THREE.MeshStandardMaterial({ envMapIntensity: 0.6 });
    useEnvMapIntensity(m);
    const sh = compile(m);
    expect(sh.fragmentShader).toContain('uniform float envMapScale;');
    expect(sh.fragmentShader).toContain('radiance *= envMapScale;');
    expect(sh.fragmentShader).toContain('iblIrradiance *= envMapScale;');
    const u = sh.uniforms.envMapScale as THREE.IUniform<number>;
    expect(u.value).toBe(0.6);
    m.envMapIntensity = 1.3;
    expect(u.value).toBe(1.3);
  });

  it('leaves materials with their own envMap to three.js', () => {
    const m = new THREE.MeshStandardMaterial({ envMapIntensity: 0.5 });
    useEnvMapIntensity(m);
    m.envMap = new THREE.Texture();
    expect((compile(m).uniforms.envMapScale as THREE.IUniform<number>).value).toBe(1);
  });

  it('chains existing hooks, is idempotent and keys programs by the original hook', () => {
    let calls = 0;
    const a = new THREE.MeshStandardMaterial();
    a.onBeforeCompile = (sh) => {
      calls++;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n// sway');
    };
    const b = new THREE.MeshStandardMaterial();
    b.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n// fade');
    };
    const plain1 = new THREE.MeshStandardMaterial();
    const plain2 = new THREE.MeshStandardMaterial();
    for (const m of [a, b, plain1, plain2, a]) useEnvMapIntensity(m);

    const sh = compile(a);
    expect(calls).toBe(1);
    expect(sh.fragmentShader).toContain('// sway');
    expect(sh.fragmentShader.split('uniform float envMapScale;').length).toBe(2);
    expect(a.customProgramCacheKey()).not.toBe(b.customProgramCacheKey());
    expect(plain1.customProgramCacheKey()).toBe(plain2.customProgramCacheKey());
    expect(plain1.customProgramCacheKey()).not.toBe(new THREE.MeshStandardMaterial().customProgramCacheKey());
  });

  it('keeps a custom cache key', () => {
    const m = new THREE.MeshStandardMaterial();
    m.customProgramCacheKey = () => 'custom-7';
    useEnvMapIntensity(m);
    expect(m.customProgramCacheKey()).toBe('custom-7|envMapScale');
  });
});

describe('RenderContext.holdEnvironment', () => {
  // the environment fields of a context, without a WebGL renderer
  type EnvState = { envHeld: boolean; envRT: object | null; sunDirection: THREE.Vector3; envSunElev: number; envDirty: boolean; envAge: number };
  const DEG = Math.PI / 180;
  const state = (sunElevDeg: number, capturedDeg: number): EnvState => ({
    envHeld: false,
    envRT: {},
    sunDirection: new THREE.Vector3(Math.cos(sunElevDeg * DEG), Math.sin(sunElevDeg * DEG), 0),
    envSunElev: capturedDeg * DEG,
    envDirty: true,
    envAge: 1e9,
  });
  const proto = RenderContext.prototype as unknown as {
    holdEnvironment(this: EnvState): () => void;
    updateEnvironment(this: EnvState): void;
  };

  it('skips re-capture while held and counts the map fresh when the sun is back', () => {
    const s = state(35, 35);
    const release = proto.holdEnvironment.call(s);
    // held: returns before touching the capture targets (this fake has none)
    expect(() => proto.updateEnvironment.call(s)).not.toThrow();
    release();
    expect(s.envHeld).toBe(false);
    expect(s.envDirty).toBe(false);
    expect(s.envAge).toBe(0);
  });

  it('leaves the map due for re-capture when released with the sun elsewhere', () => {
    const s = state(-20, 35);
    proto.holdEnvironment.call(s)();
    expect(s.envDirty).toBe(true);
    expect(s.envAge).toBe(1e9);
  });
});
