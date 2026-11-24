import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createGroundMaterial } from '../src/render/groundMaterial';
import type { GroundTextureSet } from '../src/render/textures';

describe('moonlit ground', () => {
  it('lifts natural ground at night only, not paths or snow', () => {
    const t = new THREE.DataArrayTexture();
    const set: GroundTextureSet = { albedo: t, detail: t, noise: t, waves: t, foliage: t };
    const ground = createGroundMaterial(set, new THREE.Texture(), { antiTile: false, cloudShadows: false, caustics: false });
    // off by day
    expect(ground.uniforms.uNightLift.value).toBe(0);
    const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {}, defines: {} };
    ground.material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    const fs = shader.fragmentShader;
    expect(shader.uniforms).toHaveProperty('uNightLift');
    expect(fs).toContain('float gNight = 1.0 + uNightLift * (1.0 - max(gBright, gPath));');
    expect(fs).toContain('gPath = pm;');
    // both the moon's beam and the night fill, after the bright-ground term is known
    const at = fs.indexOf('float gNight');
    expect(at).toBeGreaterThan(fs.indexOf('float gBright'));
    expect(fs.indexOf('reflectedLight.indirectDiffuse *= gNight;')).toBeGreaterThan(at);
    expect(fs.indexOf('reflectedLight.directDiffuse *= gNight;')).toBeGreaterThan(at);
    ground.material.dispose();
  });
});
