// Look and bone texels written while a crowd batch is culled must still reach
// the GPU: three uploads a data texture only when it draws a program that
// samples it, and calls Texture.onUpdate after each upload.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SkinnedBatch } from '../src/models/crowd/batch';
import { crowdUniforms } from '../src/models/crowd/skinning';

function batch(instances: number, bones = 2): SkinnedBatch {
  const b = new SkinnedBatch('t', new THREE.MeshBasicMaterial(), new THREE.MeshDepthMaterial(), [crowdUniforms()], {
    bones,
    look: 1,
    instances,
    vertices: 64,
    indices: 192,
  });
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.computeBoundingSphere();
  const geo = b.addKeyedGeometry('box', g);
  for (let i = 0; i < instances; i++) b.addSlot(geo);
  return b;
}

/** What the renderer does when it draws the batch: upload the queued spans (or all), clear them, call onUpdate. */
function upload(b: SkinnedBatch): { start: number; count: number }[] | 'whole' {
  const tex = b.texture;
  const sent = tex.updateRanges.length ? tex.updateRanges.map((r) => ({ ...r })) : 'whole';
  tex.clearUpdateRanges();
  tex.onUpdate?.(tex);
  return sent;
}

const lookSpan = (b: SkinnedBatch, id: number) => ({ start: id * b.stride * 4, count: b.look * 4 });

describe('crowd texels while culled', () => {
  it('keeps the spans of frames the batch was not drawn until an upload', () => {
    const b = batch(4);
    b.flush();
    expect(upload(b)).toBe('whole');
    // frame 1: a penguin grows up, its batch is off screen (not drawn)
    b.data[b.offset(0) + 1] = 1;
    b.flush();
    // frame 2: another instance's wetness changes, still culled
    b.data[b.offset(3) + 2] = 0.5;
    b.flush();
    // back in view: both spans go up
    expect(upload(b)).toEqual([lookSpan(b, 0), lookSpan(b, 3)]);
    // after the upload only new writes are queued
    b.data[b.offset(2)] = 1;
    b.flush();
    expect(upload(b)).toEqual([lookSpan(b, 2)]);
    b.dispose();
  });

  it('a new texture stays whole until it is first uploaded', () => {
    const b = batch(4);
    b.flush();
    const v = b.texture.version;
    // culled from the first frame: later partial writes must not replace the whole upload
    b.data[b.offset(1) + 1] = 1;
    b.flush();
    expect(b.texture.version).toBeGreaterThan(v);
    expect(upload(b)).toBe('whole');
    b.data[b.offset(1)] = 1;
    b.flush();
    expect(upload(b)).toEqual([lookSpan(b, 1)]);
    b.dispose();
  });

  it('a batch culled for a long time sends one whole upload instead of a pile of spans', () => {
    const b = batch(64, 20); // 64 × 61 texels: two texture rows
    b.flush();
    upload(b);
    for (let frame = 0; frame < 200; frame++) {
      b.data[b.offset(frame % 64)] = frame;
      b.data[b.boneOffset((frame * 7) % 64)] = frame;
      b.flush();
      expect(b.texture.updateRanges.length).toBeLessThanOrEqual(128);
    }
    expect(upload(b)).toBe('whole');
    b.dispose();
  });

  it('an upload of a replaced (grown) texture does not clear the new one', () => {
    const b = batch(2);
    const old = b.texture;
    b.flush();
    for (let i = 0; i < 4; i++) b.addSlot(b.geometryId('box'));
    expect(b.texture).not.toBe(old);
    old.onUpdate?.(old);
    b.data[b.offset(0)] = 1;
    b.flush();
    expect(upload(b)).toBe('whole');
    b.dispose();
  });
});
