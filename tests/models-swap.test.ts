// Creature meshes that change at runtime: quality-tier changes move live
// models to the new tier's meshes (and free the old ones), young males of
// dimorphic species use the female mesh until they mature, and juvenile bone
// scales (tusks / horns growing in).

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CreatureFactory } from '../src/models';
import type { QualitySettings } from '../src/core/contracts';
import type { HumanAppearance } from '../src/core/types';
import type { RiggedModel } from '../src/models/model';

const quality = (d: 0 | 1 | 2): QualitySettings => ({
  level: (['low', 'medium', 'high'] as const)[d],
  pixelRatio: 1,
  antialias: false,
  shadows: false,
  shadowMapSize: 1024,
  grassDensity: 0,
  postFX: false,
  detailDistance: 40,
  creatureDetail: d,
});

const APP: HumanAppearance = { skin: 0xc68e6a, hair: 0x332211, shirt: 0x335577, pants: 0x222222, shoes: 0x111111, hairStyle: 0, height: 1.7, build: 1, child: false, female: false };

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  cam.position.set(0, 3, 8);
  cam.lookAt(0, 0, -10);
  return cam;
}

/** Standalone scale of a named bone after an update (the model must render standalone). */
function standaloneBoneScale(model: RiggedModel, name: string): number {
  let s = NaN;
  model.object.traverse((o) => {
    if ((o as THREE.Bone).isBone && o.name === name) s = o.scale.x;
  });
  return s;
}

describe('quality change re-applies creature detail', () => {
  it('moves live animals and people to the new tier and frees the old meshes and batches', { timeout: 120_000 }, async () => {
    const f = new CreatureFactory(quality(0));
    const scene = new THREE.Scene();
    scene.add(f.root);
    await f.preload(['zebra', 'lion']);
    const animals = [
      f.createAnimal('zebra', { seed: 1, sex: 'F', growth: 1 }),
      f.createAnimal('lion', { seed: 2, sex: 'M', growth: 1 }),
      f.createAnimal('lion', { seed: 3, sex: 'F', growth: 1 }),
    ];
    const people = [f.createHuman(APP, 'guest', 1), f.createHuman({ ...APP, female: true, hairStyle: 1 }, 'keeper', 2)];
    const models = [...animals, ...people];
    models.forEach((m, i) => {
      m.object.position.set(i - 2, 0, -5);
      scene.add(m.object);
    });
    // the zebra stands far away: its coarse LODs are requested on every tier
    animals[0].object.position.set(0, 0, -150);
    const cam = camera();
    const frame = () => {
      for (const m of models) m.update(1 / 30, { action: 'walk', speed: 1.2, holding: 'none' });
      f.update(cam);
    };
    frame();
    const keys = () => f.crowd.batchList().map((b) => b.name).sort();
    expect(keys().every((k) => k.endsWith(':0'))).toBe(true);

    f.setQuality(quality(1));
    for (let i = 0; i < 60 && f.stats().some((s) => !s.key.endsWith(':1')); i++) frame();
    frame();
    for (const m of models) expect((m as unknown as RiggedModel).asset.detail).toBe(1);
    // one batch per animal variant + one for all people, all on the new tier
    expect(keys()).toEqual(['animal:lion:F:1', 'animal:lion:M:1', 'animal:zebra:-:1', 'human:1']);
    expect(f.crowd.batchedCount).toBe(models.length);
    // previous tier's meshes are gone from the caches
    expect(f.stats().every((s) => s.key.endsWith(':1'))).toBe(true);
    // still animating and drawn through the batches
    expect(f.crowdStats().visible).toBe(models.length);
    expect(animals[1].object.children.length).toBe(0);
    // models created after the change use the new tier directly
    const late = f.createAnimal('zebra', { seed: 9, sex: 'M', growth: 1 }) as unknown as RiggedModel;
    expect(late.asset.detail).toBe(1);
    late.dispose();

    // and back: the rebuilt meshes (same cache keys as before) get their distance LODs again
    f.setQuality(quality(0));
    for (let i = 0; i < 60 && f.stats().some((s) => !s.key.endsWith(':0')); i++) frame();
    f.crowd.buildBudgetMs = 1e9;
    for (let i = 0; i < 3; i++) frame();
    expect(keys().every((k) => k.endsWith(':0'))).toBe(true);
    const zebraLods = f.lodStats().find((s) => s.key === 'zebra:-:0')!;
    expect(zebraLods.triangles[3]).toBeGreaterThan(0);
    expect(f.crowdStats().perLod[3]).toBe(1);
    for (const m of models) m.dispose();
    f.dispose();
  });

  it('re-picks the mesh of a standalone model (UI preview) too', { timeout: 60_000 }, async () => {
    const f = new CreatureFactory(quality(0));
    await f.preload(['zebra']);
    const preview = f.createAnimal('zebra', { seed: 4, sex: 'F', growth: 1 });
    const own = new THREE.Scene();
    own.add(preview.object);
    preview.update(1 / 30, { action: 'idle', speed: 0 });
    expect(preview.object.children.length).toBe(1);
    f.setQuality(quality(1));
    for (let i = 0; i < 20 && (preview as unknown as RiggedModel).asset.detail !== 1; i++) f.update(camera());
    preview.update(1 / 30, { action: 'idle', speed: 0 });
    expect((preview as unknown as RiggedModel).asset.detail).toBe(1);
    expect(preview.object.children.length).toBe(1);
    const mesh = preview.object.children[0] as THREE.SkinnedMesh;
    expect(mesh.geometry).toBe((preview as unknown as RiggedModel).asset.geometry);
    preview.dispose();
    f.dispose();
  });
});

describe('juvenile features', () => {
  it('young males of dimorphic species use the female mesh until they mature', { timeout: 60_000 }, async () => {
    const f = new CreatureFactory(quality(0));
    const scene = new THREE.Scene();
    scene.add(f.root);
    await f.preload(['lion']);
    const cub = f.createAnimal('lion', { seed: 5, sex: 'M', growth: 0.3 }) as unknown as RiggedModel;
    scene.add(cub.object);
    expect(cub.asset.key).toBe('lion:F:0');
    cub.update(1 / 30, { action: 'walk', speed: 1 });
    f.update(camera());
    expect(cub.batch?.name).toBe('animal:lion:F:0');
    const small = cub.object.scale.y;
    cub.setGrowth(0.85);
    expect(cub.asset.key).toBe('lion:M:0');
    expect(cub.batch?.name).toBe('animal:lion:M:0');
    expect(cub.object.scale.y).toBeGreaterThan(small);
    cub.update(1 / 30, { action: 'walk', speed: 1 });
    f.update(camera());
    expect(f.crowd.batchedCount).toBe(1);
    // the female keeps her mesh whatever her age
    const lioness = f.createAnimal('lion', { seed: 6, sex: 'F', growth: 0.3 }) as unknown as RiggedModel;
    expect(lioness.asset.key).toBe('lion:F:0');
    cub.dispose();
    lioness.dispose();
    f.dispose();
  });

  it('tusks and horns grow in with age (juvenile bone scale)', { timeout: 60_000 }, async () => {
    const f = new CreatureFactory(quality(0));
    await f.preload(['elephant', 'rhino']);
    const scaleAt = (id: string, bone: string, growth: number) => {
      const m = f.createAnimal(id, { seed: 1, sex: 'M', growth }) as unknown as RiggedModel;
      m.update(1 / 30, { action: 'idle', speed: 0 });
      const s = standaloneBoneScale(m, bone);
      m.dispose();
      return s;
    };
    expect(scaleAt('elephant', 'tusk.L', 0.3)).toBeLessThan(0.2);
    expect(scaleAt('elephant', 'tusk.L', 1)).toBeCloseTo(1, 5);
    expect(scaleAt('rhino', 'horn_1', 0.3)).toBeLessThan(0.2);
    expect(scaleAt('rhino', 'horn_1', 0.6)).toBeGreaterThan(0.3);
    expect(scaleAt('rhino', 'horn_1', 1)).toBeCloseTo(1, 5);
    f.dispose();
  });
});
