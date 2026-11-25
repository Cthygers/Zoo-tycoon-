// Close inspection zoom: only a followed animal or person may be approached
// closer than the free camera's minimum, and the view eases back out when
// following ends.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { World } from '../src/core/world';
import { CameraController, DEFAULT_LIMITS, followFraming } from '../src/ui/camera';
import { SPECIES_BY_ID } from '../src/data/species';

const ground = 2;
const world = { heightAt: () => ground } as unknown as World;

function rig() {
  const cam = new THREE.PerspectiveCamera(34, 915 / 412, 0.3, 2000);
  const c = new CameraController(cam, world, () => undefined);
  c.setView(70, 70, 20, 0.4, 25 * (Math.PI / 180));
  return { cam, c };
}

describe('CameraController inspect zoom', () => {
  it('keeps the free camera at its minimum distance', () => {
    const { c } = rig();
    c.setView(70, 70, 3);
    expect(c.distance).toBe(DEFAULT_LIMITS.minDistance);
    c.zoomRotateAround(0.2, 0, 0, 0, 0, 0);
    expect(c.distance).toBe(DEFAULT_LIMITS.minDistance);
  });

  it('lets a followed entity be approached to followMinDistance', () => {
    const { c } = rig();
    c.follow(() => ({ x: 70, z: 70 }));
    c.zoomRotateAround(0.1, 0, 0, 0, 0, 0);
    expect(c.distance).toBe(DEFAULT_LIMITS.followMinDistance);
    expect(DEFAULT_LIMITS.followMinDistance).toBeLessThan(DEFAULT_LIMITS.minDistance);
  });

  it('eases back out to the free minimum when following ends, without a jump', () => {
    const { c } = rig();
    c.follow(() => ({ x: 70, z: 70 }));
    c.setView(70, 70, DEFAULT_LIMITS.followMinDistance);
    c.update(1 / 30);
    c.stopFollow();
    let prev = c.distance;
    const ds: number[] = [];
    for (let i = 0; i < 90; i++) {
      c.update(1 / 30);
      expect(c.distance).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(c.distance - prev).toBeLessThan(0.6); // no snap in a single frame
      ds.push(c.distance);
      prev = c.distance;
    }
    expect(ds[0]).toBeLessThan(DEFAULT_LIMITS.minDistance - 1);
    expect(c.distance).toBe(DEFAULT_LIMITS.minDistance);
    // and the free camera cannot zoom in past it again
    c.zoomRotateAround(0.5, 0, 0, 0, 0, 0);
    expect(c.distance).toBe(DEFAULT_LIMITS.minDistance);
  });

  it('looks at the followed entity’s lookHeight close up, at the ground from afar', () => {
    const { cam, c } = rig();
    const fn = () => ({ x: 70, z: 70, lookHeight: 1.0 });
    c.follow(fn);
    c.setView(70, 70, DEFAULT_LIMITS.followMinDistance);
    for (let i = 0; i < 120; i++) c.update(1 / 30);
    const chest = new THREE.Vector3(70, ground + 1.0, 70).project(cam);
    expect(Math.abs(chest.y)).toBeLessThan(0.02);
    // a 1.7 m person fits in the frame: head and feet both inside, with margin
    expect(new THREE.Vector3(70, ground + 1.7, 70).project(cam).y).toBeLessThan(0.8);
    expect(new THREE.Vector3(70, ground, 70).project(cam).y).toBeGreaterThan(-0.8);
    c.setView(70, 70, 20);
    for (let i = 0; i < 120; i++) c.update(1 / 30);
    expect(Math.abs(new THREE.Vector3(70, ground, 70).project(cam).y)).toBeLessThan(0.02);
  });

  it('keeps a followed entity at followScreenX (beside an info sheet), with the render focus on it', () => {
    const cam = new THREE.PerspectiveCamera(34, 915 / 412, 0.3, 2000);
    const focus = { x: 0, z: 0 };
    const c = new CameraController(cam, world, (x, z) => Object.assign(focus, { x, z }));
    c.followScreenX = -0.4;
    c.follow(() => ({ x: 70, z: 70, lookHeight: 1.0 }));
    for (const d of [DEFAULT_LIMITS.followMinDistance, 20]) {
      c.setView(70, 70, d, 0.9, 25 * (Math.PI / 180));
      for (let i = 0; i < 150; i++) c.update(1 / 30);
      const p = new THREE.Vector3(70, ground, 70).project(cam);
      expect(p.x).toBeCloseTo(-0.4, 1);
      expect(Math.hypot(focus.x - 70, focus.z - 70)).toBeLessThan(0.05);
      expect(Math.hypot(c.target.x - 70, c.target.z - 70)).toBeGreaterThan(0.5);
    }
    // following ends: the focus glides back to the look point
    c.stopFollow();
    c.update(1 / 30);
    expect(Math.hypot(focus.x - 70, focus.z - 70)).toBeLessThan(1);
    for (let i = 0; i < 60; i++) c.update(1 / 30);
    expect(Math.hypot(focus.x - c.target.x, focus.z - c.target.z)).toBeLessThan(0.01);
  });

  it('a setView after following jumps straight to the free framing', () => {
    const { cam, c } = rig();
    c.follow(() => ({ x: 70, z: 70, lookHeight: 1.2 }));
    c.setView(70, 70, DEFAULT_LIMITS.followMinDistance);
    for (let i = 0; i < 60; i++) c.update(1 / 30);
    c.stopFollow();
    c.setView(40, 40, 3);
    c.update(1 / 30);
    expect(c.distance).toBe(DEFAULT_LIMITS.minDistance);
    expect(Math.abs(new THREE.Vector3(40, ground, 40).project(cam).y)).toBeLessThan(0.01);
  });

  it('frames tall subjects from farther, and small ones at followMinDistance', () => {
    const framing = (id: string) => followFraming(SPECIES_BY_ID[id].height, SPECIES_BY_ID[id].length);
    expect(framing('giraffe').minDistance).toBeCloseTo(11, 1);
    expect(framing('elephant').minDistance).toBeGreaterThan(6.2);
    expect(framing('elephant').minDistance).toBeLessThan(7.2);
    for (const id of ['zebra', 'lion', 'penguin', 'gazelle', 'gorilla', 'hippo', 'rhino', 'camel', 'flamingo'])
      expect(framing(id).minDistance).toBeLessThanOrEqual(DEFAULT_LIMITS.followMinDistance);
    // a giraffe is looked at just under its middle (it stands clear of the dock), a zebra at its chest
    expect(framing('giraffe').lookHeight / SPECIES_BY_ID.giraffe.height).toBeCloseTo(0.47, 2);
    expect(framing('zebra').lookHeight / SPECIES_BY_ID.zebra.height).toBeCloseTo(0.55, 2);
  });

  it('stops a pinch at a tall subject’s closest zoom, with its head and hooves in frame', () => {
    const { cam, c } = rig();
    const g = SPECIES_BY_ID.giraffe;
    const f = followFraming(g.height, g.length);
    c.follow(() => ({ x: 70, z: 70, ...f }));
    for (let i = 0; i < 30; i++) {
      c.zoomRotateAround(0.8, 0, 0, 0, 0, 0);
      c.update(1 / 30);
    }
    for (let i = 0; i < 120; i++) c.update(1 / 30);
    expect(c.distance).toBeCloseTo(f.minDistance, 5);
    const head = new THREE.Vector3(70, ground + g.height, 70).project(cam).y;
    const feet = new THREE.Vector3(70, ground, 70).project(cam).y;
    // on a 20:9 phone the top bar covers the top ~13 % of the height and the dock the bottom ~18 %:
    // the head stays below the one, the hooves above the other
    expect(head).toBeLessThan(0.7);
    expect(feet).toBeGreaterThan(-0.6);
    expect(head).toBeGreaterThan(0.55); // the head is not left far below the top of the frame
  });

  it('eases out to a taller subject’s closest zoom when switching from a person, without a jump', () => {
    const { c } = rig();
    c.follow(() => ({ x: 70, z: 70, lookHeight: 1 }));
    c.setView(70, 70, DEFAULT_LIMITS.followMinDistance);
    c.update(1 / 30);
    expect(c.distance).toBe(DEFAULT_LIMITS.followMinDistance);
    c.stopFollow();
    const f = followFraming(SPECIES_BY_ID.giraffe.height, SPECIES_BY_ID.giraffe.length);
    c.follow(() => ({ x: 72, z: 70, ...f }));
    let prev = c.distance;
    for (let i = 0; i < 90; i++) {
      c.update(1 / 30);
      expect(c.distance).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(c.distance / prev).toBeLessThan(1.15); // no snap: under 15 % a frame, easing out
      prev = c.distance;
    }
    expect(c.distance).toBeCloseTo(f.minDistance, 3);
    // and back to a person: the closer zoom is allowed again at once
    c.stopFollow();
    c.follow(() => ({ x: 70, z: 70, lookHeight: 1 }));
    c.zoomRotateAround(0.2, 0, 0, 0, 0, 0);
    expect(c.distance).toBe(DEFAULT_LIMITS.followMinDistance);
  });
});
