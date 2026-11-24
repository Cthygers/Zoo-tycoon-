// Per-batch bounds: every crowd batch gets the bounding sphere of its own instances, so a
// batch whose creatures are all off screen is frustum-culled as a whole.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FilteredBatch } from '../src/models/crowd/batch';

describe('crowd batch bounds', () => {
  it('gives every batch its own bounding sphere (off-screen batches are culled)', () => {
    const mat = new THREE.MeshBasicMaterial();
    const a = new FilteredBatch('a', mat, 4, 64, 192);
    const b = new FilteredBatch('b', mat, 4, 64, 192);
    a.beginBounds();
    b.beginBounds();
    a.includeBounds(new THREE.Vector3(0, 0, 0), 2, false);
    b.includeBounds(new THREE.Vector3(100, 0, 0), 2, false);
    a.endBounds();
    b.endBounds();
    expect(a.boundingSphere!.radius).toBeCloseTo(2);
    expect(a.boundingSphere!.center.x).toBeCloseTo(0);
    expect(b.boundingSphere!.center.x).toBeCloseTo(100);
    expect(b.boundingSphere!.radius).toBeCloseTo(2);
    a.dispose();
    b.dispose();
  });
});
