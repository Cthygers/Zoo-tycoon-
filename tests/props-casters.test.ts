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
  });
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
