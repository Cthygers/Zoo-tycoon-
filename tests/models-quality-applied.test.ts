// CreatureFactory.whenQualityApplied(): resolves once a quality change has
// moved every live model to the new tier's meshes (for the UI's
// "Applying graphics settings…" indicator).

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CreatureFactory } from '../src/models';
import type { QualitySettings } from '../src/core/contracts';
import type { RiggedModel } from '../src/models/model';

const quality = (d: 0 | 1): QualitySettings => ({
  level: (['low', 'medium'] as const)[d],
  pixelRatio: 1,
  antialias: false,
  shadows: false,
  shadowMapSize: 1024,
  grassDensity: 0,
  postFX: false,
  detailDistance: 40,
  creatureDetail: d,
});

describe('whenQualityApplied', () => {
  it('resolves at once without a pending change, and after the migration otherwise', { timeout: 60_000 }, async () => {
    const f = new CreatureFactory(quality(0));
    const scene = new THREE.Scene();
    scene.add(f.root);
    await f.preload(['zebra']);
    const zebra = f.createAnimal('zebra', { seed: 1, sex: 'F', growth: 1 });
    scene.add(zebra.object);
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    cam.position.set(0, 3, 8);
    const frame = () => {
      zebra.update(1 / 30, { action: 'idle', speed: 0 });
      f.update(cam);
    };
    frame();

    let idle = false;
    await f.whenQualityApplied().then(() => (idle = true));
    expect(idle).toBe(true);

    f.setQuality(quality(1));
    let applied = false;
    const done = f.whenQualityApplied().then(() => (applied = true));
    await Promise.resolve();
    expect(applied).toBe(false);
    for (let i = 0; i < 20 && !applied; i++) {
      frame();
      await Promise.resolve();
    }
    await done;
    expect((zebra as unknown as RiggedModel).asset.detail).toBe(1);

    zebra.dispose();
    f.dispose();
  });
});
