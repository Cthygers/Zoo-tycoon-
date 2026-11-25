// Follow camera around outcrops: when a large rock (kept by the props layer)
// hides the followed subject, the follow yaw swings smoothly away from it, by
// at most 40°, and never against the player's own turning.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { World } from '../src/core/world';
import { CameraController, DEFAULT_LIMITS } from '../src/ui/camera';
import { clearBlockers, followBlockers, setBlocker, type BlockerHit } from '../src/props/lod/blockers';

const DEG = Math.PI / 180;
const ground = 2;
const world = { heightAt: () => ground } as unknown as World;
const subject = { x: 70, z: 70, lookHeight: 0.8 };
const DT = 1 / 30;

/** Following the subject at the closest zoom, from +z (yaw 0), with the query wired as main.ts does. */
function rig() {
  const cam = new THREE.PerspectiveCamera(34, 915 / 412, 0.3, 2000);
  const c = new CameraController(cam, world, () => undefined);
  c.blockerQuery = followBlockers;
  c.follow(() => subject);
  c.setView(subject.x, subject.z, DEFAULT_LIMITS.followMinDistance, 0, 25 * DEG);
  return c;
}

/** An outcrop 2 m in front of the subject, its centre a little screen-right of the line (+x). */
function outcrop() {
  setBlocker(1, { x: 70.5, y: ground + 0.6, z: 72, r: 1.6, ry: 1.1 });
}

function blocked(c: CameraController): boolean {
  const s = new THREE.Vector3(subject.x, ground + subject.lookHeight, subject.z);
  return followBlockers(c.camera.position, s, [] as BlockerHit[]) > 0;
}

/** Run n frames; returns the yaw after each. */
function run(c: CameraController, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    c.update(DT);
    out.push(c.yaw);
  }
  return out;
}

afterEach(() => clearBlockers());

describe('CameraController follow swing around outcrops', () => {
  it('leaves the yaw alone when nothing is in the way', () => {
    const c = rig();
    run(c, 90);
    expect(c.yaw).toBe(0);
  });

  it('swings smoothly away from a rock that hides the subject, until the view clears', () => {
    const c = rig();
    outcrop();
    expect(blocked(c)).toBe(true);
    const yaws = [c.yaw, ...run(c, 60)];
    // the camera orbits screen-left, away from the rock's side, and the subject is in view again
    expect(c.yaw).toBeLessThan(-5 * DEG);
    expect(c.yaw).toBeGreaterThan(-42 * DEG);
    expect(blocked(c)).toBe(false);
    // no jumps: the rate is capped and eases in (no step change in rate between frames)
    let prevStep = 0;
    for (let i = 1; i < yaws.length; i++) {
      const step = yaws[i] - yaws[i - 1];
      expect(Math.abs(step)).toBeLessThanOrEqual(80 * DEG * DT + 1e-9);
      expect(Math.abs(step - prevStep)).toBeLessThan(0.3 * 80 * DEG * DT);
      prevStep = step;
    }
    // and it settles: no drift once the line is clear
    const settled = c.yaw;
    run(c, 60);
    expect(c.yaw).toBeCloseTo(settled, 6);
  });

  it('swings by at most 40° when the rock cannot be cleared', () => {
    const c = rig();
    setBlocker(1, { x: 70.2, y: ground, z: 72, r: 6, ry: 4 }); // far wider than any swing
    run(c, 120);
    expect(c.yaw).toBeLessThan(-35 * DEG);
    expect(c.yaw).toBeGreaterThan(-41 * DEG);
  });

  it('does not swing while the player touches the view, nor around a rock they turned behind', () => {
    const c = rig();
    c.setView(subject.x, subject.z, DEFAULT_LIMITS.followMinDistance, 60 * DEG, 25 * DEG);
    outcrop();
    run(c, 5);
    expect(c.yaw).toBe(60 * DEG);
    // the player twists the view round to look from behind the rock (yaw 0)
    c.beginInteraction('orbit');
    for (let i = 0; i < 20; i++) {
      c.rotateBy(-3 * DEG, 0);
      c.update(DT);
    }
    run(c, 20); // holds still before letting go: no fling
    expect(c.yaw).toBeCloseTo(0, 6);
    c.endInteraction();
    run(c, 60);
    expect(blocked(c)).toBe(true);
    expect(c.yaw).toBeCloseTo(0, 6);
  });

  it('swings after a pinch that zooms in behind a rock', () => {
    const c = rig();
    c.setView(subject.x, subject.z, 30, 0, 25 * DEG); // out of range, the rock under the line
    outcrop();
    run(c, 10);
    expect(c.yaw).toBe(0);
    c.beginInteraction('orbit');
    for (let i = 0; i < 20; i++) {
      c.zoomRotateAround(0.85, 0, 0, 0, 0, 0);
      c.update(DT);
    }
    expect(c.yaw).toBe(0); // fingers down: no swing yet
    c.endInteraction();
    run(c, 60);
    expect(c.yaw).toBeLessThan(-5 * DEG);
    expect(blocked(c)).toBe(false);
  });
});
