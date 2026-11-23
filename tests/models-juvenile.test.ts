// Juvenile proportions: foals / calves stand on long legs, cubs on short ones
// (design.babyLegs). The bone scales reach the rig runtime, so the leg IK
// keeps the feet planted, the standing trunk is lifted or lowered to match,
// and lying / swimming heights stay those of the adult proportions.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CreatureFactory } from '../src/models';
import { SPECIES_MODELS } from '../src/models/species';
import { SPECIES_BY_ID } from '../src/data/species';
import { Pose, RigDef, RigRuntime, TwoBoneChain } from '../src/models/rig/rig';
import type { QualitySettings } from '../src/core/contracts';
import type { RiggedModel } from '../src/models/model';

const quality: QualitySettings = {
  level: 'low', pixelRatio: 1, antialias: false, shadows: false, shadowMapSize: 1024,
  grassDensity: 0, postFX: false, detailDistance: 40, creatureDetail: 0,
};

const LONG_LEGS = ['zebra', 'giraffe', 'gazelle', 'camel', 'elephant', 'rhino', 'hippo'];
const SHORT_LEGS = ['lion', 'tiger', 'grizzly', 'polarbear'];

function skinned(m: RiggedModel): THREE.SkinnedMesh {
  let mesh: THREE.SkinnedMesh | null = null;
  m.object.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
  });
  return mesh!;
}

/** Lowest skinned vertex (model space) among vertices whose dominant bone matches `bones`. */
function lowest(m: RiggedModel, bones: RegExp): number {
  m.object.updateMatrixWorld(true);
  const sm = skinned(m);
  const pos = sm.geometry.getAttribute('position');
  const si = sm.geometry.getAttribute('skinIndex');
  const sw = sm.geometry.getAttribute('skinWeight');
  const names = sm.skeleton.bones.map((b) => b.name);
  const v = new THREE.Vector3();
  let lo = Infinity;
  for (let i = 0; i < pos.count; i++) {
    let k = 0;
    for (let j = 1; j < 4; j++) if (sw.getComponent(i, j) > sw.getComponent(i, k)) k = j;
    if (!bones.test(names[si.getComponent(i, k)])) continue;
    sm.applyBoneTransform(i, v.fromBufferAttribute(pos, i));
    lo = Math.min(lo, v.y);
  }
  return lo;
}

/** Hip joint height in model space (world height / root scale). */
function hipsY(m: RiggedModel): number {
  m.object.updateMatrixWorld(true);
  const hips = skinned(m).skeleton.bones.find((b) => b.name === 'hips')!;
  return hips.getWorldPosition(new THREE.Vector3()).y / m.object.scale.y;
}

const FEET = /_(lower|foot|toe)$/;
const TRUNK = /^(hips|spine_\d|chest)$/;

describe('juvenile leg proportions', () => {
  it('two-bone IK uses the scaled segment lengths', () => {
    const def = new RigDef([
      { name: 'hip', parent: null, pos: [0, 1, 0] },
      { name: 'knee', parent: 'hip', pos: [0, 0.5, 0.05] },
      { name: 'ankle', parent: 'knee', pos: [0, 0.05, 0] },
    ]);
    const rt = new RigRuntime(def);
    rt.boneScale[1] = 1.3; // a long shank: reaches further than the rest chain
    const pose = new Pose(def.count);
    rt.fk(pose);
    const chain = new TwoBoneChain(def, 0, 1, 2, [0, 0, 1]);
    const target = new THREE.Vector3(0, -0.05, 0.1);
    chain.solve(rt, pose, target, chain.restPole);
    rt.fk(pose);
    expect(rt.wp[2].distanceTo(target)).toBeLessThan(1e-3);
  });

  it('scales the lower legs with growth', { timeout: 60_000 }, async () => {
    const f = new CreatureFactory(quality);
    await f.preload(['zebra', 'lion']);
    const legScale = (id: string, growth: number) => {
      const m = f.createAnimal(id, { seed: 1, sex: 'F', growth }) as unknown as RiggedModel;
      m.update(1 / 30, { action: 'idle', speed: 0 });
      const s = skinned(m).skeleton.bones.find((b) => b.name === 'FL_lower')!.scale.x;
      m.dispose();
      return s;
    };
    const babyLegs = (id: string) => SPECIES_MODELS[id].design({ def: SPECIES_BY_ID[id], sex: 'F', detail: 0 }).babyLegs!;
    expect(legScale('zebra', 0)).toBeCloseTo(babyLegs('zebra'), 5);
    expect(legScale('zebra', 0)).toBeGreaterThan(1.1);
    expect(legScale('lion', 0)).toBeLessThan(0.9);
    expect(legScale('zebra', 1)).toBeCloseTo(1, 5);
    f.dispose();
  });

  it("a young male lion's mane grows in after he switches to the maned mesh", { timeout: 60_000 }, async () => {
    const f = new CreatureFactory(quality);
    await f.preload(['lion']);
    const mane = (growth: number) => {
      const m = f.createAnimal('lion', { seed: 1, sex: 'M', growth }) as unknown as RiggedModel;
      m.update(1 / 30, { action: 'idle', speed: 0 });
      const bone = skinned(m).skeleton.bones.find((b) => b.name === 'mane_neck');
      const s = bone ? bone.scale.x : 0;
      m.dispose();
      return s;
    };
    expect(mane(0.5)).toBe(0); // still the maneless mesh
    const young = mane(0.6), older = mane(0.8);
    expect(young).toBeGreaterThan(0.6);
    expect(young).toBeLessThan(0.8);
    expect(older).toBeGreaterThan(young);
    expect(mane(1)).toBeCloseTo(1, 5);
    f.dispose();
  });

  it('keeps feet on the ground standing, and lying / swimming heights unchanged', { timeout: 120_000 }, async () => {
    const f = new CreatureFactory(quality);
    const ids = [...LONG_LEGS, ...SHORT_LEGS];
    await f.preload(ids);
    const run = (id: string, growth: number, action: string) => {
      const m = f.createAnimal(id, { seed: 2, sex: 'F', growth }) as unknown as RiggedModel;
      for (let i = 0; i < 150; i++) m.update(1 / 30, { action, speed: 0, actionTime: i / 30, swimming: action === 'swim' });
      return m;
    };
    for (const id of ids) {
      const adult = { idle: run(id, 1, 'idle'), sleep: run(id, 1, 'sleep'), swim: run(id, 1, 'swim') };
      const adultTrunk = lowest(adult.idle, TRUNK);
      for (const growth of [0.2, 0.5]) {
        const idle = run(id, growth, 'idle');
        // planted: neither floating nor sunk (model metres)
        expect(Math.abs(lowest(idle, FEET)), `${id} ${growth} feet`).toBeLessThan(0.012);
        // long legs lift the trunk, short legs lower it
        const trunk = lowest(idle, TRUNK);
        if (LONG_LEGS.includes(id)) expect(trunk, `${id} ${growth} trunk`).toBeGreaterThan(adultTrunk + 0.02);
        else expect(trunk, `${id} ${growth} trunk`).toBeLessThan(adultTrunk - 0.01);
        // lying: the belly rests where the adult's does (folded long legs may nudge it by ~1% of the height)
        const sleep = run(id, growth, 'sleep');
        const tol = 0.01 * SPECIES_BY_ID[id].height;
        expect(Math.abs(lowest(sleep, TRUNK) - lowest(adult.sleep, TRUNK)), `${id} ${growth} lying`).toBeLessThan(tol);
        // swimming: the body floats as deep as the adult's
        const swim = run(id, growth, 'swim');
        expect(hipsY(swim), `${id} ${growth} swim`).toBeCloseTo(hipsY(adult.swim), 3);
        for (const m of [idle, sleep, swim]) m.dispose();
      }
      for (const m of Object.values(adult)) m.dispose();
    }
    f.dispose();
  });
});
