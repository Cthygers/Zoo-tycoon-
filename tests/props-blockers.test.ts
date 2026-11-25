// Follow-camera helpers for things on the camera → subject line: large rocks
// the camera has to look around (lod/blockers.ts) and the fence posts the
// occluder cut keeps until every panel they join has gone (fences.ts).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import { World } from '../src/core/world';
import { clearBlockers, followBlockers, setBlocker, SUBJECT_TOP_UP, type BlockerHit } from '../src/props/lod/blockers';
import { fenceStyle, postMask } from '../src/props/fences';
import { outcropBody } from '../src/props/layer';
import { buildOutcrop } from '../src/props/nature/rocks';

describe('followBlockers', () => {
  const cam = { x: 0, y: 4, z: 0 };
  const subject = { x: 0, y: 1, z: 10 };

  it('reports the rocks the camera → subject segment passes through, nearest first, with their side', () => {
    clearBlockers();
    setBlocker(1, { x: 0.5, y: 1.5, z: 6, r: 2, ry: 1 }); // on the line, right of it
    setBlocker(2, { x: -0.4, y: 3, z: 2, r: 1.5, ry: 1.2 }); // near the camera, left
    setBlocker(3, { x: 6, y: 1, z: 5, r: 2, ry: 1 }); // well beside the line
    const out: BlockerHit[] = [];
    expect(followBlockers(cam, subject, out)).toBe(2);
    expect(out.map((h) => h.x)).toEqual([-0.4, 0.5]);
    expect(out[0].t).toBeLessThan(out[1].t);
    // looking along +z, screen right is −x
    expect(out[0].side).toBe(1);
    expect(out[1].side).toBe(-1);
    // the hit objects are reused, and the list shrinks
    const first = out[0];
    setBlocker(2, null);
    expect(followBlockers(cam, subject, out)).toBe(1);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(first);
    clearBlockers();
  });

  it('ignores a rock the line only passes over (a squat body) or the one the subject stands on', () => {
    clearBlockers();
    // a low outcrop: the line passes 1.9 m above its centre, over its 1 m vertical radius
    setBlocker(1, { x: 0, y: 0.6, z: 3.5, r: 2.5, ry: 1 });
    // the rock right at the subject (within the last 0.8 m of the segment)
    setBlocker(2, { x: 0, y: 0.5, z: 10.6, r: 0.9, ry: 0.6 });
    expect(followBlockers(cam, subject, [])).toBe(0);
    clearBlockers();
  });
});

describe('followBlockers: rocks hiding the body or the head', () => {
  it('also tests the segment to the subject top', () => {
    clearBlockers();
    const cam = { x: 0, y: 4, z: 0 };
    const body = { x: 0, y: 1, z: 10 };
    // a rock the body segment passes under but the segment to the head crosses
    setBlocker(1, { x: 0, y: 3.2, z: 5, r: 1, ry: 0.5 });
    expect(followBlockers(cam, body, [], body.y)).toBe(0);
    expect(followBlockers(cam, body, [])).toBe(1);
    expect(followBlockers(cam, body, [], body.y + SUBJECT_TOP_UP)).toBe(1);
    clearBlockers();
  });

  it('builds an outcrop body from the rock above the ground, tall enough for a low follow camera', () => {
    const g = buildOutcrop(1);
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    const radius = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
    const b = outcropBody(box, radius);
    const h = box.max.y;
    // centred on the visible part (the buried base does not sink it), reaching over the rock's top
    expect(box.min.y).toBeLessThan(0);
    expect(b.centre.y).toBeCloseTo(h / 2, 5);
    expect(b.centre.y + b.ry).toBeGreaterThan(h);
    expect(b.r).toBeLessThan(radius);
    // a 1.5 m outcrop: a camera 2.2 m up, 5 m from a lion 1.5 m behind it, sees rock; one 4 m up sees over it
    expect(h).toBeGreaterThan(1.4);
    clearBlockers();
    setBlocker(1, { x: 0, y: b.centre.y, z: 0, r: b.r, ry: b.ry });
    const lion = { x: b.r + 1.5, y: 0.6, z: 0 };
    expect(followBlockers({ x: lion.x - 5, y: 2.2, z: 0 }, lion, [])).toBe(1);
    expect(followBlockers({ x: lion.x - 5, y: 4.5, z: 0 }, lion, [])).toBe(0);
    clearBlockers();
  });
});

describe('fence pieces carry their height for the follow occluder cut', () => {
  it("every part of a style holds the style's top", () => {
    for (const id of [1, 2, 3, 4, 5]) {
      const s = fenceStyle(id, 1)!;
      const parts = [...s.posts, ...s.panel];
      const top = Math.max(...parts.map((p) => (p.geometry.computeBoundingBox(), p.geometry.boundingBox!.max.y)));
      expect(top).toBeGreaterThan(1);
      for (const p of parts) expect(p.geometry.getAttribute('aOcclTop').getX(0)).toBeCloseTo(top, 5);
    }
  });
});

describe('fence post masks', () => {
  it('lists the fenced edges meeting at a corner', () => {
    const world = new World(new EventBus(), 3);
    const x = 20;
    const z = 20;
    expect(postMask(world, x, z)).toBe(0);
    world.setFence({ dir: 'h', x: x - 1, z }, 1);
    expect(postMask(world, x, z)).toBe(1);
    world.setFence({ dir: 'h', x, z }, 1);
    expect(postMask(world, x, z)).toBe(3);
    world.setFence({ dir: 'v', x, z }, 1);
    expect(postMask(world, x, z)).toBe(11);
    world.setFence({ dir: 'v', x, z: z - 1 }, 1);
    expect(postMask(world, x, z)).toBe(15);
  });
});
