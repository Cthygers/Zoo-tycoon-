// Water surface at night (render/water.ts): a moonlit pond keeps a sheen of
// sky and a faintly lit body, like the lifted moonlit ground, instead of
// reading as a black hole; by day nothing changes.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import { Terrain } from '../src/core/types';
import { World } from '../src/core/world';
import { MOON_PATH, WAKES, WATER_NIGHT, WaterSurface, wakeScale, type Swimmer } from '../src/render/water';

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
    const swimmers: Swimmer[] = Array.from({ length: WAKES.max + 3 }, (_, i) => ({ x: 60 + i * 4, z: 60, heading: Math.PI / 2, speed: 0.5, length: 0.4 }));
    water.setWakes(swimmers, 100, 60); // the focus is nearest the last swimmers
    const slots = water.uniforms.uWakes.value;
    const xs = slots.map((v) => v.x).sort((a, b) => a - b);
    expect(xs[0]).toBe(60 + 3 * 4); // the three farthest from the focus got no slot
    // heading π/2 swims along +x (forward = (sin θ, cos θ))
    expect(slots[0].z).toBeCloseTo(0.5, 6);
    expect(slots[0].w).toBeCloseTo(0, 6);
    water.setWakes([], 100, 60);
    expect(slots.every((v) => v.x < -1e4 && v.z === 0 && v.w === 0)).toBe(true);
    expect(water.uniforms.uWakeSize.value.every((v) => v.x === 0 && v.y === 1)).toBe(true);
    water.dispose();
  });

  it('scales the ripple pattern with the swimmer’s body, its V opening from the head', () => {
    const { water, fs } = pondShader();
    expect(fs).toContain(`uniform vec2 uWakeSize[${WAKES.max}];`);
    expect(fs).toContain('vec2 d = (p - uWakes[i].xy) * uWakeSize[i].y;');
    // a penguin's pattern is the reference; a hippo's or polar bear's is a few times larger, an elephant's capped
    expect(wakeScale(0.4)).toBe(1);
    expect(wakeScale(0.2)).toBe(1);
    expect(wakeScale(4)).toBeCloseTo(Math.sqrt(10), 6);
    expect(wakeScale(2.5)).toBeGreaterThan(2.4);
    expect(wakeScale(60)).toBe(WAKES.maxScale);
    const hippo = { x: 50, z: 50, heading: 0, speed: 0.6, length: 4 };
    const penguin = { x: 54, z: 50, heading: 0, speed: 0.6, length: 0.4 };
    water.setWakes([hippo, penguin], 50, 50);
    const [h, p] = water.uniforms.uWakeSize.value;
    // x: half the body in pattern units, y: metres → pattern units
    expect(h.x / h.y).toBeCloseTo(2, 6);
    expect(1 / h.y).toBeCloseTo(wakeScale(4), 6);
    expect(p.x).toBeCloseTo(0.2, 6);
    expect(p.y).toBe(1);
    // within reach of the pattern, a hippo's V reaches several metres past its 2 m half length
    expect(WAKES.radius / h.y - 0.5 * hippo.length).toBeGreaterThan(3);
    // the V opens from the head and only starts dying out behind the tail, so it shows beside and behind the body
    expect(fs).toContain('float aft = behind - bodyHalf;');
    expect(fs).toContain('* exp(-max(aft, 0.0) * 1.1) * fade * move;');
    water.dispose();
  });

  it('draws a narrow V behind a moving swimmer through the normal only, with faint rings only while idle', () => {
    const { water, fs } = pondShader();
    // the V's arms at the Kelvin angle (19.5°), from the head backwards only
    expect(Math.atan(WAKES.armTan) / (Math.PI / 180)).toBeCloseTo(19.5, 0);
    expect(fs).toContain('float fromHead = behind + bodyHalf;');
    expect(fs).toContain('if (move > 0.0 && fromHead > 0.0) {');
    expect(fs).toContain(`float off = abs(side) - ${WAKES.armTan.toFixed(3)} * fromHead;`);
    // rings fade out as the swimmer moves off, and stay far fainter than the V
    expect(fs).toContain('* fade * (1.0 - move);');
    expect(WAKES.ringSlope).toBeLessThanOrEqual(WAKES.slope / 3 + 1e-9);
    // no white water on the ripple crests: only broken, half-strength foam trailing the tail, within a metre
    expect(fs).not.toMatch(/pow\(max\(sin\(\w*[pP]hase\)/);
    expect(fs).toContain(`float churn = smoothstep(-0.1, 0.05, aft) * (1.0 - smoothstep(${(WAKES.churn * 0.5).toFixed(2)}, ${WAKES.churn.toFixed(2)}, aft))`);
    expect(fs).toContain('foam = max(foam, min(wWake.z, 1.0) * smoothstep(0.3, 0.7, fn2));');
    expect(WAKES.foam).toBeLessThanOrEqual(0.4);
    expect(WAKES.churn).toBeLessThanOrEqual(1);
    // from above the ripples show through the reflectance (bright / dark ridges), not as paint
    expect(fs).toContain(`F = clamp(F + (${WAKES.rough.toFixed(3)} * wWake.w - ${WAKES.sheen.toFixed(2)} * dot(wWake.xy, normalize(wV.xz + vec2(1e-4, 0.0)))) * wSheen, 0.0, 1.0);`);
    expect(WAKES.rough).toBeLessThan(0.1); // a sheen, not a white line
    water.dispose();
  });
});
