import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeCelestial } from '../src/render/celestial';
import { gradeToneMap, nightGroundLevel } from '../src/render/context';
import { NIGHT_GROUND, createGroundMaterial } from '../src/render/groundMaterial';
import { GrassField } from '../src/render/grass';
import type { GroundTextureSet } from '../src/render/textures';
import { EventBus } from '../src/core/events';
import { Terrain } from '../src/core/types';
import { World } from '../src/core/world';

const DEG = Math.PI / 180;
const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('moonlit ground', () => {
  const t = new THREE.DataArrayTexture();
  const set: GroundTextureSet = { albedo: t, detail: t, noise: t, waves: t, foliage: t };

  it('lifts natural ground at night only, not paths or snow, in its own hue', () => {
    const ground = createGroundMaterial(set, new THREE.Texture(), { antiTile: false, cloudShadows: false, caustics: false });
    // off by day
    expect(ground.uniforms.uNightLift.value).toBe(0);
    const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {}, defines: {} };
    ground.material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    const fs = shader.fragmentShader;
    expect(shader.uniforms).toHaveProperty('uNightLift');
    expect(fs).toContain('float ngK = uNightLift * (1.0 - max(gBright, gPath));');
    expect(fs).toContain('gPath = pm;');
    expect(fs).toContain('vec3 ngHue = (gAlb) /');
    // both the moon's beam and the night fill, after the bright-ground term is known
    const at = fs.indexOf('float ngK');
    expect(at).toBeGreaterThan(fs.indexOf('float gBright'));
    expect(fs.indexOf('reflectedLight.directDiffuse = mix(ngDir')).toBeGreaterThan(at);
    expect(fs.indexOf('reflectedLight.indirectDiffuse = mix(ngInd')).toBeGreaterThan(at);
    // the grade mark: whLampLit where the material tone-maps itself, the HDR alpha otherwise
    const mark = fs.indexOf('whLampLit = gNightMark;');
    expect(mark).toBeGreaterThan(fs.indexOf('#include <opaque_fragment>'));
    expect(mark).toBeLessThan(fs.indexOf('#include <tonemapping_fragment>'));
    expect(fs).toContain('gl_FragColor.a += gNightMark;');
    ground.material.dispose();
  });

  it('waits for the end of the blue hour, then takes the night look within ≈ 45 game minutes', () => {
    const sun = new THREE.Vector3();
    const moon = new THREE.Vector3();
    const level = (h: number, m: number) => nightGroundLevel(computeCelestial(h * 60 + m, 1, sun, moon).sunElev / DEG);
    expect(level(19, 30)).toBe(0);
    expect(level(20, 0)).toBe(0);
    expect(level(20, 30)).toBeLessThan(0.1);
    expect(level(21, 15)).toBeGreaterThan(0.95);
    expect(level(23, 0)).toBe(1);
    expect(level(4, 0)).toBe(1);
    expect(level(6, 30)).toBe(0);
  });

  it('keeps moonlit sand sand-hued through the rod-vision grade instead of frost blue', () => {
    // sand albedo (textures.ts) under blue moonlight, at the night exposure of the 23:00 views
    const sand = new THREE.Color(0.352, 0.262, 0.15);
    const moon = new THREE.Color(0.52, 0.68, 1.0);
    const exposure = 13.5;
    const light = 0.03 / exposure;
    const chroma = (c: THREE.Color) => (c.r - c.b) / lum(c);
    const before = gradeToneMap(sand.clone().multiply(moon).multiplyScalar(light), exposure, new THREE.Color());
    // the ground's night look at full level: neutral light, marked for the grade
    const neutral = sand.clone().multiplyScalar((light * lum(moon)) / 1);
    const after = gradeToneMap(neutral, exposure, new THREE.Color(), NIGHT_GROUND.mark);
    // blue-white before; after, a share of the albedo's warm chroma (≈ 20 %)
    expect(chroma(before)).toBeLessThan(-0.2);
    expect(chroma(after) / chroma(sand)).toBeGreaterThan(0.1);
    expect(chroma(after) / chroma(sand)).toBeLessThan(0.45);
  });
});

describe('moonlit grass tufts', () => {
  it('take the same night look as the ground under them', () => {
    const w = new World(new EventBus(), 5);
    w.terrain.fill(Terrain.Grass);
    const gf = new GrassField(w, new THREE.Texture(), 64, { blades: 6, segs: 2 });
    const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {}, defines: {} };
    (gf.mesh.material as THREE.Material).onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    const fs = shader.fragmentShader;
    expect(fs).toContain('float ngK = uNightLift * (1.0);');
    expect(fs).toContain('vec3 ngHue = (diffuseColor.rgb) /');
    expect(fs.indexOf('whLampLit = gNightMark;')).toBeGreaterThan(fs.indexOf('#include <opaque_fragment>'));
    expect(fs).toContain('gl_FragColor.a += gNightMark;');
    gf.dispose();
  });
});
