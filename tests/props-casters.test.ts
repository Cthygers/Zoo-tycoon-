// Low-tier shadow casters: every caster material is one more shadow-pass draw.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SHADOW_ONLY_LAYER } from '../src/core/constants';
import { EventBus } from '../src/core/events';
import { World } from '../src/core/world';
import type { QualitySettings } from '../src/core/contracts';
import { PropsLayer } from '../src/props';

const QUALITY: QualitySettings = { level: 'low', pixelRatio: 1, antialias: false, shadows: true, shadowMapSize: 1024, grassDensity: 0.25, postFX: false, detailDistance: 26, creatureDetail: 0 };

describe('shadow casters on the low tier', () => {
  /** Does any placed-object batch cast after one frame with the camera over (x, z)? */
  function casts(defId: string, x: number, z: number): boolean {
    const events = new EventBus();
    const world = new World(events, 3);
    for (const o of [...world.objects.values()]) world.removeObject(o.id);
    world.addObject(defId, x, z, 0, 1);
    const scene = new THREE.Scene();
    const layer = new PropsLayer(world, events, scene, QUALITY);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(x * 2, 25, z * 2 + 20);
    camera.lookAt(x * 2, 0, z * 2);
    layer.update(0, 0, camera);
    let any = false;
    scene.getObjectByName('objects')!.traverse((o) => (any ||= (o as THREE.Mesh).isMesh && o.castShadow));
    layer.dispose();
    return any;
  }

  it('shelters and trees cast; shrubs and thin lamp posts do not (each caster material costs a shadow-pass draw)', () => {
    expect(casts('shelter_wood', 40, 40)).toBe(true);
    expect(casts('tree_pine', 40, 40)).toBe(true);
    expect(casts('bush_savanna', 40, 40)).toBe(false);
    expect(casts('lamp', 40, 40)).toBe(false);
  }, 20000); // four props layers: ~3 s alone, far more while the full suite runs
});

describe('shadow-only caster batch (batched back-end)', () => {
  it('opaque parts of all materials cast from one batch; removing the object removes its shadow', () => {
    const events = new EventBus();
    const world = new World(events, 3);
    for (const o of [...world.objects.values()]) world.removeObject(o.id);
    const shelter = world.addObject('shelter_wood', 40, 40, 0, 1)!;
    const scene = new THREE.Scene();
    const layer = new PropsLayer(world, events, scene, QUALITY, { backend: 'batched' });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(80, 25, 100);
    camera.lookAt(80, 0, 80);
    layer.update(0, 0, camera);
    const meshes = (name: string) => {
      const out: THREE.Mesh[] = [];
      scene.getObjectByName('objects')!.traverse((o) => o.name === name && out.push(o as THREE.Mesh));
      return out;
    };
    const casters = meshes('prop-shadow-casters');
    expect(casters.length).toBe(1);
    expect(casters[0].castShadow).toBe(true);
    // only the sun's shadow camera sees it (render/context.ts enables the layer there)
    const main = new THREE.Layers();
    const sunShadow = new THREE.Layers();
    sunShadow.enable(SHADOW_ONLY_LAYER);
    expect(casters[0].layers.test(main)).toBe(false);
    expect(casters[0].layers.test(sunShadow)).toBe(true);
    expect(meshes('prop-multibatch').every((m) => m.layers.test(main))).toBe(true);
    expect(meshes('prop-multibatch').length).toBeGreaterThan(1); // several materials …
    expect(meshes('prop-multibatch').some((m) => m.castShadow)).toBe(false); // … one shadow draw
    world.removeObject(shelter.id);
    layer.update(0, 0, camera);
    expect(casters[0].castShadow).toBe(false);
    layer.dispose();
  });
});

describe('fence shadow-only caster batch (batched back-end)', () => {
  it('opaque fence parts of every material cast from one shadow-only batch', () => {
    const events = new EventBus();
    const world = new World(events, 3);
    for (const o of [...world.objects.values()]) world.removeObject(o.id);
    // a pen with four fence styles (wood, chain-link, stone, glass) around tiles 40..43
    const ids = [1, 2, 3, 4];
    for (let i = 0; i < 4; i++) {
      world.setFence({ dir: 'h', x: 40 + i, z: 40 }, ids[i]);
      world.setFence({ dir: 'h', x: 40 + i, z: 44 }, ids[i]);
      world.setFence({ dir: 'v', x: 40, z: 40 + i }, ids[i]);
      world.setFence({ dir: 'v', x: 44, z: 40 + i }, ids[i]);
    }
    const scene = new THREE.Scene();
    const layer = new PropsLayer(world, events, scene, QUALITY, { backend: 'batched' });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(84, 25, 104);
    camera.lookAt(84, 0, 84);
    layer.update(0, 0, camera);
    const fences = scene.getObjectByName('fences')!;
    const meshes = (name: string) => fences.children.filter((o) => o.name === name) as THREE.Mesh[];
    const casters = meshes('fence-shadow-casters');
    const drawn = meshes('fence-multibatch');
    expect(drawn.length).toBeGreaterThan(3);
    expect(casters.length).toBeGreaterThan(0);
    expect(casters.length).toBeLessThanOrEqual(2); // one per shadow side
    expect(casters.every((m) => m.castShadow)).toBe(true);
    expect(drawn.some((m) => m.castShadow)).toBe(false);
    const main = new THREE.Layers();
    expect(casters.some((m) => m.layers.test(main))).toBe(false);
    layer.dispose();
  });
});
