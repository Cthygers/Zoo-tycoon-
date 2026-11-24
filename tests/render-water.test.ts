// Water surface at night (render/water.ts): a moonlit pond keeps a sheen of
// sky and a faintly lit body, like the lifted moonlit ground, instead of
// reading as a black hole; by day nothing changes.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import { Terrain } from '../src/core/types';
import { World } from '../src/core/world';
import { WATER_NIGHT, WaterSurface } from '../src/render/water';

function pondShader(): { water: WaterSurface; fs: string; uniforms: Record<string, THREE.IUniform> } {
  const w = new World(new EventBus(), 5);
  w.terrain.fill(Terrain.Grass);
  for (let z = 30; z <= 34; z++) for (let x = 30; x <= 34; x++) w.terrain[w.idx(x, z)] = Terrain.Water;
  const water = new WaterSurface(w, new THREE.Texture(), new THREE.Texture(), () => 0);
  const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} as Record<string, THREE.IUniform>, defines: {} };
  (water.mesh.material as THREE.Material).onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return { water, fs: shader.fragmentShader, uniforms: shader.uniforms };
}

describe('water at night', () => {
  it('lifts the sky reflection, the reflectance floor and the lit body by the night factor only', () => {
    const { water, fs, uniforms } = pondShader();
    // daytime look: the render context drives uNight (0 by day)
    expect(water.uniforms.uNight.value).toBe(0);
    expect(uniforms.uNight).toBe(water.uniforms.uNight);
    expect(fs).toContain(`reflectedLight.indirectSpecular *= 1.0 + ${WATER_NIGHT.sky.toFixed(2)} * uNight;`);
    expect(fs).toContain(`* (1.0 + ${WATER_NIGHT.body.toFixed(2)} * uNight);`);
    expect(fs).toContain(`+ ${WATER_NIGHT.sheen.toFixed(3)} * uNight) * wSheen;`);
    // the sky reflection roughly doubles or more, the body stays a dark murk (no milky pond)
    expect(WATER_NIGHT.sky).toBeGreaterThanOrEqual(1);
    expect(WATER_NIGHT.body).toBeLessThanOrEqual(3);
    // the moon still glints through the lighting loop's directional light (no extra lobe)
    expect(fs).toContain('wSpec += directLight.color * glint;');
    water.dispose();
  });
});
