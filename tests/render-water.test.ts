// Water surface at night (render/water.ts): a moonlit pond keeps a sheen of
// sky and a faintly lit body, like the lifted moonlit ground, instead of
// reading as a black hole; by day nothing changes.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import { Terrain } from '../src/core/types';
import { World } from '../src/core/world';
import { MOON_PATH, WAKES, WATER_NIGHT, WaterSurface, type Swimmer } from '../src/render/water';

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

  it('draws the moon’s glitter as separate glints averaged over the pixel footprint, by night only', () => {
    const { water, fs } = pondShader();
    // the day's sun glitter is unchanged; the night factor swaps in the moon's
    expect(fs).toContain('float glint = pow(nh, 900.0) * 3.0;');
    expect(fs).toContain('glint = mix(glint, moonGlint, uNight) * wNear * (1.0 - foam);');
    // a facet narrower than the pixel's spread of normals is spread out at the same average (no flicker)
    expect(fs).toContain('float spread = fwidth(nh);');
    expect(fs).toMatch(/\/ \([\d.]+ \+ spread\)/);
    // narrower and dimmer than the sun's glitter (pow 900 ≈ 1 − cos 0.0011 at half strength, × 3)
    expect(MOON_PATH.facet).toBeLessThan(0.002);
    expect(MOON_PATH.gain).toBeLessThan(3);
    water.dispose();
  });

  it('ripples around the swimmers nearest to the focus, with their velocity, and clears the other slots', () => {
    const { water, fs } = pondShader();
    expect(fs).toContain(`uniform vec4 uWakes[${WAKES.max}];`);
    expect(fs).toContain('sl += wWake.xy;');
    expect(fs).toContain('wWake = wakeAt(vWPos.xz, fn) * wNear;');
    const swimmers: Swimmer[] = Array.from({ length: WAKES.max + 3 }, (_, i) => ({ x: 60 + i * 4, z: 60, heading: Math.PI / 2, speed: 0.5 }));
    water.setWakes(swimmers, 100, 60); // the focus is nearest the last swimmers
    const slots = water.uniforms.uWakes.value;
    const xs = slots.map((v) => v.x).sort((a, b) => a - b);
    expect(xs[0]).toBe(60 + 3 * 4); // the three farthest from the focus got no slot
    // heading π/2 swims along +x (forward = (sin θ, cos θ))
    expect(slots[0].z).toBeCloseTo(0.5, 6);
    expect(slots[0].w).toBeCloseTo(0, 6);
    water.setWakes([], 100, 60);
    expect(slots.every((v) => v.x < -1e4 && v.z === 0 && v.w === 0)).toBe(true);
    water.dispose();
  });
});
