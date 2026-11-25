// Close-range body shape of people: hands with a thumb and fingers, shoes with a heel and a toe
// spring, a heavier build carried on the belly, and the extra close-up detail kept to the full
// mesh (the simplified LOD levels keep the body's triangle budget).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { QualitySettings } from '../src/core/contracts';
import { CreatureFactory } from '../src/models';
import type { HumanAsset } from '../src/models/humans/human';
import { jointMatrix, skinMatrices } from '../src/models/model';
import { hash1 } from '../src/models/anim/util';

const QUALITY: QualitySettings = { level: 'medium', pixelRatio: 1, antialias: false, shadows: false, shadowMapSize: 1024, grassDensity: 0, postFX: false, detailDistance: 40, creatureDetail: 1 };
const APP = { skin: 0xc89070, hair: 0x33241a, shirt: 0x335577, pants: 0x2c3e5c, shoes: 0x222222, height: 1.75, build: 1, child: false, female: false, hairStyle: 0 as const };

function asset(): HumanAsset {
  const h = new CreatureFactory(QUALITY).createHuman(APP, 'guest', 3);
  return (h as unknown as { asset: HumanAsset }).asset;
}

describe('human body at close range', () => {
  it('gives the hand a thumb set apart from the fingers, and fingers reaching past the palm', () => {
    const a = asset();
    const pos = a.geometry.getAttribute('position');
    const [wx, wy, wz] = a.human.marks.wristL;
    // hand frame (A-pose, design.ts): u down the hand, v (= z) toward the thumb
    const ha = new THREE.Vector2(Math.sin(0.4), -Math.cos(0.4));
    let thumbTip = -Infinity, fingerTip = 0, wideFingers = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x < wx - 0.04 || y > wy) continue;
      const u = (x - wx) * ha.x + (y - wy) * ha.y;
      const v = z - wz;
      thumbTip = Math.max(thumbTip, v);
      fingerTip = Math.max(fingerTip, u);
      // below the thumb's tip only the fingers go on, as wide as the palm (no mitten flaring past the thumb)
      if (u > 0.115 && v > 0.045) wideFingers++;
    }
    expect(thumbTip).toBeGreaterThan(0.055);
    expect(fingerTip).toBeGreaterThan(0.15);
    expect(wideFingers).toBe(0);
  });

  it('shapes the shoe with a toe springing off the ground and a heel on it', () => {
    const a = asset();
    const pos = a.geometry.getAttribute('position');
    const ax = a.human.marks.ankleL[0];
    let toe = Infinity, heel = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (Math.abs(x - ax) > 0.03 || y > 0.08) continue;
      if (z > 0.165) toe = Math.min(toe, y);
      if (z < -0.06) heel = Math.min(heel, y);
    }
    expect(heel).toBeLessThan(0.01);
    expect(toe).toBeGreaterThan(heel + 0.008);
  });

  it('puts a heavier build on the belly rather than an even coat', () => {
    const a = asset();
    const pos = a.geometry.getAttribute('position');
    const girth = a.geometry.getAttribute('girth');
    let front = 0, nf = 0, back = 0, nb = 0;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i), z = pos.getZ(i);
      if (Math.abs(pos.getX(i)) > 0.06 || Math.abs(y - 1.02) > 0.06) continue;
      if (z > 0.06) { front += girth.getX(i); nf++; }
      if (z < -0.06) { back += girth.getX(i); nb++; }
    }
    expect(nf).toBeGreaterThan(0);
    expect(nb).toBeGreaterThan(0);
    expect(front / nf).toBeGreaterThan(1.4 * (back / nb));
  });

  it('keeps the fine hands and shoes on the full mesh: the simplified levels keep the body budget', () => {
    const a = asset();
    const lod = a.lod!;
    lod.build(1);
    lod.build(2);
    // level 0 grew by the fine parts; levels 1-2 stay near half / a quarter of the body without them
    expect(lod.triangles[0]).toBeGreaterThan(3500);
    expect(lod.triangles[1]).toBeLessThan(0.42 * lod.triangles[0]);
    expect(lod.triangles[1]).toBeGreaterThan(0.25 * lod.triangles[0]);
    expect(lod.triangles[2]).toBeLessThan(0.6 * lod.triangles[1]);
    // every level keeps the attribute set of level 0 (one batch)
    for (const l of [1, 2]) expect(Object.keys(lod.levels[l]!.attributes).sort()).toEqual(Object.keys(a.geometry.attributes).sort());
  });

  it('rests folded forearms on a heavy belly, not in it', () => {
    // first seed whose resting arms are folded (anim/human.ts restArms row 1)
    let seed = 0;
    while (hash1(seed, 41) < 0.34 || hash1(seed, 41) >= 0.6) seed++;
    /** Deepest (m) a belly vertex of the posed, inflated body reaches into a forearm. */
    const sink = (build: number, female: boolean): number => {
      const m = new CreatureFactory(QUALITY).createHuman({ ...APP, build, female }, 'guest', seed) as unknown as {
        update(dt: number, a: unknown): void;
        dispose(): void;
        asset: HumanAsset;
        out: never;
      };
      const anim = { action: 'watch', speed: 0, swimming: false, actionTime: 0, holding: 'none' };
      for (let i = 0; i < 60; i++) m.update(1 / 30, anim);
      const a = m.asset;
      const skin = new Float32Array(a.rig.count * 12);
      skinMatrices(a.rig, m.out, null, skin, 0);
      const joint = (b: number) => new THREE.Vector3().setFromMatrixPosition(jointMatrix(b, new THREE.Matrix4()));
      const arms = (['L', 'R'] as const).map((k) => new THREE.Line3(joint(a.roles.arms[k]!.lower), joint(a.roles.arms[k]!.hand)));
      const g = a.geometry;
      const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
      const girth = g.getAttribute('girth'), zone = g.getAttribute('zone');
      const inflate = (build - 1) * 0.09;
      const p = new THREE.Vector3(), n = new THREE.Vector3(), q = new THREE.Vector3();
      let deepest = 0;
      for (let v = 0; v < pos.count; v++) {
        // the front of the trunk between the hips and the chest
        if (zone.getX(v) >= 0 || zone.getY(v) >= 0 || pos.getY(v) < 0.9 || pos.getY(v) > 1.35 || pos.getZ(v) < 0.02) continue;
        p.set(0, 0, 0);
        n.set(0, 0, 0);
        const [x, y, z] = [pos.getX(v), pos.getY(v), pos.getZ(v)];
        const [nx, ny, nz] = [nor.getX(v), nor.getY(v), nor.getZ(v)];
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(v, k);
          const o = si.getComponent(v, k) * 12;
          p.x += w * (skin[o] * x + skin[o + 1] * y + skin[o + 2] * z + skin[o + 3]);
          p.y += w * (skin[o + 4] * x + skin[o + 5] * y + skin[o + 6] * z + skin[o + 7]);
          p.z += w * (skin[o + 8] * x + skin[o + 9] * y + skin[o + 10] * z + skin[o + 11]);
          n.x += w * (skin[o] * nx + skin[o + 1] * ny + skin[o + 2] * nz);
          n.y += w * (skin[o + 4] * nx + skin[o + 5] * ny + skin[o + 6] * nz);
          n.z += w * (skin[o + 8] * nx + skin[o + 9] * ny + skin[o + 10] * nz);
        }
        p.addScaledVector(n.normalize(), inflate * girth.getX(v));
        for (const arm of arms) {
          const t = arm.closestPointToPointParameter(p, true);
          // forearm radius: 3.6 cm below the elbow to 2.6 cm at the wrist
          deepest = Math.max(deepest, 0.036 - 0.01 * t - arm.at(t, q).distanceTo(p));
        }
      }
      m.dispose();
      return deepest;
    };
    for (const female of [false, true]) {
      expect(sink(1, female)).toBeLessThanOrEqual(0);
      // a heavy build's belly may touch the back of the forearm, never cut through to its front
      expect(sink(1.2, female)).toBeLessThan(0.016);
    }
  });
});
