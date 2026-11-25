// Standing guests rest their free arms in their own way (folded, clasped behind the back, a hand
// on the hip, or hanging) and swing them again as they walk off.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { QualitySettings } from '../src/core/contracts';
import { CreatureFactory } from '../src/models';
import { jointMatrix } from '../src/models/model';
import { hash1 } from '../src/models/anim/util';

const QUALITY: QualitySettings = { level: 'medium', pixelRatio: 1, antialias: false, shadows: false, shadowMapSize: 1024, grassDensity: 0, postFX: false, detailDistance: 40, creatureDetail: 1 };
const APP = { skin: 0xc89070, hair: 0x33241a, shirt: 0x335577, pants: 0x2c3e5c, shoes: 0x222222, height: 1.75, build: 1, child: false, female: false, hairStyle: 0 as const };

/** First seed whose resting arms are `row` (anim/human.ts restArms). */
function seedFor(row: number): number {
  for (let s = 0; ; s++) {
    const h = hash1(s, 41);
    if ((h < 0.34 ? 0 : h < 0.6 ? 1 : h < 0.8 ? 2 : 3) === row) return s;
  }
}

type Posed = { update(dt: number, a: unknown): void; dispose(): void; asset: { roles: { arms: Record<'L' | 'R', { hand: number; lower: number }> } } };

/** Elbow and wrist positions (model space) after settling into `action`. */
function joints(row: number, action: string, speed = 0, holding = 'none') {
  const m = new CreatureFactory(QUALITY).createHuman(APP, 'guest', seedFor(row)) as unknown as Posed;
  const anim = { action, speed, swimming: false, actionTime: 0, holding };
  for (let i = 0; i < 60; i++) m.update(1 / 30, anim);
  const at = (b: number) => new THREE.Vector3().setFromMatrixPosition(jointMatrix(b, new THREE.Matrix4()));
  const r = { L: { elbow: at(m.asset.roles.arms.L.lower), hand: at(m.asset.roles.arms.L.hand) }, R: { elbow: at(m.asset.roles.arms.R.lower), hand: at(m.asset.roles.arms.R.hand) } };
  m.dispose();
  return r;
}

describe('resting arms', () => {
  it('folds the arms across the belly, wrists crossing in front of the body', () => {
    const j = joints(1, 'watch');
    expect(j.L.hand.x).toBeLessThan(0);
    expect(j.R.hand.x).toBeGreaterThan(0);
    for (const s of [j.L, j.R]) {
      expect(s.hand.z).toBeGreaterThan(0.14);
      expect(s.hand.y).toBeGreaterThan(1.05);
      expect(s.hand.y).toBeLessThan(1.3);
    }
  });

  it('clasps the hands behind the back', () => {
    const j = joints(2, 'idle');
    for (const s of [j.L, j.R]) {
      expect(s.hand.z).toBeLessThan(-0.1);
      expect(Math.abs(s.hand.x)).toBeLessThan(0.08);
      expect(s.elbow.z).toBeLessThan(-0.05);
    }
  });

  it('puts a hand on the hip with the elbow out, the other arm hanging', () => {
    const j = joints(3, 'watch');
    expect(j.R.elbow.x).toBeLessThan(-0.3);
    expect(j.R.hand.x).toBeLessThan(-0.15);
    expect(j.R.hand.x).toBeGreaterThan(-0.25);
    expect(j.R.hand.y).toBeGreaterThan(0.9);
    expect(j.R.hand.y).toBeLessThan(1.1);
    expect(j.L.hand.y).toBeLessThan(0.95);
  });

  it('lets free arms hang beside the hips, the hands clear of the thighs', () => {
    const j = joints(0, 'idle');
    expect(j.L.hand.x).toBeGreaterThan(0.17);
    expect(j.R.hand.x).toBeLessThan(-0.17);
    // still hanging, not held out
    expect(j.L.hand.x).toBeLessThan(0.23);
    expect(j.L.hand.y).toBeLessThan(0.95);
  });

  it('swings the arms again when walking, and holds what is carried instead', () => {
    const walking = joints(1, 'walk', 1.3);
    for (const s of [walking.L, walking.R]) expect(s.hand.y).toBeLessThan(1.0);
    const carrying = joints(1, 'idle', 0, 'balloon');
    expect(carrying.L.hand.y).toBeLessThan(1.0);
  });
});
