// Resting poses read as resting animals, not collapsed ones: long-legged
// hoofed animals fold their legs under the body (front carpus under the
// chest with the cannon lying back, hock beside the belly instead of trailing
// behind the rump) and bears sleeping on the side bend their legs.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CreatureFactory } from '../src/models';
import type { QualitySettings } from '../src/core/contracts';
import type { RigRuntime, Pose } from '../src/models/rig/rig';
import type { ResolvedLeg } from '../src/models/types';

const LOW: QualitySettings = {
  level: 'low', pixelRatio: 1, antialias: false, shadows: false, shadowMapSize: 1024,
  grassDensity: 0, postFX: false, detailDistance: 40, creatureDetail: 0,
};

interface Rigged { rt: RigRuntime; out: Pose; asset: { roles: { legs: Partial<Record<string, ResolvedLeg>> } } }

/** Run an action until its posture has settled, then return model-space joint positions per leg. */
function settledLegs(f: CreatureFactory, species: string, action: string, seed: number, seconds = 10) {
  const m = f.createAnimal(species, { seed, sex: 'F', growth: 1 });
  for (let t = 0; t < seconds; t += 1 / 30) m.update(1 / 30, { action, speed: 0, actionTime: t });
  const r = m as unknown as Rigged;
  r.rt.fk(r.out);
  const at = (b: number) => r.rt.wp[b].clone();
  const legs: Record<string, { hip: THREE.Vector3; knee: THREE.Vector3; ankle: THREE.Vector3; toe: THREE.Vector3 | null; reach: number }> = {};
  for (const [id, leg] of Object.entries(r.asset.roles.legs)) {
    if (!leg) continue;
    const hip = at(leg.upper), knee = at(leg.lower), ankle = at(leg.foot);
    legs[id] = { hip, knee, ankle, toe: leg.toe >= 0 ? at(leg.toe) : null, reach: hip.distanceTo(knee) + knee.distanceTo(ankle) };
  }
  m.dispose();
  return legs;
}

describe('resting poses', () => {
  const f = new CreatureFactory(LOW);

  for (const species of ['giraffe', 'camel']) {
    it(`${species}: legs folded under the body when lying`, { timeout: 60_000 }, async () => {
      await f.preload([species]);
      const legs = settledLegs(f, species, 'rest', 3);
      for (const id of ['FL', 'FR']) {
        const l = legs[id];
        // carpus under the chest (not a forearm's length ahead of it), cannon lying back, fetlock off the far side
        expect(l.ankle.z - l.hip.z).toBeLessThan(0.1 * l.reach);
        expect(l.toe!.z).toBeLessThan(l.ankle.z);
        expect(l.ankle.y).toBeLessThan(0.25);
      }
      for (const id of ['HL', 'HR']) {
        const l = legs[id];
        // hock beside the belly, not trailing behind the rump
        expect(l.ankle.z - l.hip.z).toBeGreaterThan(-0.15 * l.reach);
        expect(l.ankle.y).toBeLessThan(0.25);
      }
    });
  }

  it('a polar bear asleep on its side bends its legs', { timeout: 60_000 }, async () => {
    await f.preload(['polarbear']);
    // this seed sleeps on the side (the other variant lies on the belly)
    const legs = settledLegs(f, 'polarbear', 'sleep', 6, 4);
    // stiffly stretched legs keep the ankle ≈ 0.63–0.71 reaches from the hip
    for (const l of Object.values(legs)) expect(l.hip.distanceTo(l.ankle)).toBeLessThan(0.6 * l.reach);
  });

  for (const species of ['grizzly', 'polarbear']) {
    it(`${species} lying on its belly folds its hind legs beside the body`, { timeout: 60_000 }, async () => {
      await f.preload([species]);
      // this seed rests lying on the belly (the other variant sits on the rump)
      const legs = settledLegs(f, species, 'sit', 6, 6);
      for (const id of ['HL', 'HR']) {
        const l = legs[id];
        // hind legs stretched out behind the rump (≈ 0.9 reach) read as a collapsed bear
        expect(l.hip.distanceTo(l.ankle)).toBeLessThan(0.5 * l.reach);
        expect(l.ankle.z - l.hip.z).toBeGreaterThan(-0.35 * l.reach);
        expect(l.knee.z).toBeGreaterThan(l.hip.z);
        expect(l.ankle.y).toBeLessThan(0.15);
      }
    });
  }
});
