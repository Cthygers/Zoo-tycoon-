// Follow cut of other animals: while the camera follows a subject up close, an
// animal between the camera and the subject is left out of the main pass (whole,
// never the subject itself), and comes back once it is clear of the view line.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FilteredBatch, FOLLOW_CUT_MAX_D, inFollowCut, setCreatureFollowCut } from '../src/models/crowd/batch';

/** Camera 5.25 m from a subject at the origin, looking at it from +z and a little above. */
const CAM = new THREE.Vector3(0, 3.1, 4.9);
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('creature follow cut', () => {
  afterEach(() => setCreatureFollowCut(null));

  it('cuts a body on the view line in front of the subject, not the subject or animals off the line', () => {
    setCreatureFollowCut({ x: 0, y: 0, z: 0 });
    // a camel-sized body halfway to the camera
    expect(inFollowCut(CAM, v(0, 1.2, 2.5), 1.2, false)).toBe(true);
    // the subject itself, and a neighbour right beside it
    expect(inFollowCut(CAM, v(0, 0.8, 0), 1.2, false)).toBe(false);
    expect(inFollowCut(CAM, v(1.0, 0.8, 0.4), 0.8, false)).toBe(false);
    // well to the side of the line, and behind the subject
    expect(inFollowCut(CAM, v(4, 1.0, 2.5), 1.0, false)).toBe(false);
    expect(inFollowCut(CAM, v(0, 1.0, -4), 1.0, false)).toBe(false);
  });

  it('needs a wider clearance to bring a cut animal back (no flicker at the edge)', () => {
    setCreatureFollowCut({ x: 0, y: 0, z: 0 });
    const edge = v(1.4, 1.0, 2.6);
    expect(inFollowCut(CAM, edge, 1.0, false)).toBe(false);
    expect(inFollowCut(CAM, edge, 1.0, true)).toBe(true);
  });

  it('hides cut instances for the main pass only while a subject is followed up close', () => {
    const batch = new FilteredBatch('animal:test', new THREE.MeshBasicMaterial(), 4, 64, 192);
    const geo = new THREE.SphereGeometry(1.5, 6, 4);
    const g = batch.addGeometry(geo);
    const inFront = batch.addSlot(g);
    const subject = batch.addSlot(g);
    batch.setMatrixAt(inFront, new THREE.Matrix4().makeTranslation(0, 1.2, 2.5));
    batch.setMatrixAt(subject, new THREE.Matrix4().makeTranslation(0, 0.8, 0));
    batch.followCut = true;
    const camera = new THREE.PerspectiveCamera();
    camera.position.copy(CAM);
    camera.updateMatrixWorld();
    const cut = (b: FilteredBatch) => (b as unknown as { applyFollowCut(c: THREE.Camera): void }).applyFollowCut(camera);

    setCreatureFollowCut({ x: 0, y: 0, z: 0 });
    cut(batch);
    expect(batch.getVisibleAt(inFront)).toBe(false);
    expect(batch.getVisibleAt(subject)).toBe(true);
    // the cut is for this pass: shown again afterwards (and the instance still casts its shadow)
    batch.onAfterRender();
    expect(batch.getVisibleAt(inFront)).toBe(true);
    expect(batch.castsShadowAt(inFront)).toBe(true);

    // free camera, or a subject too far away: nothing is cut
    setCreatureFollowCut(null);
    cut(batch);
    expect(batch.getVisibleAt(inFront)).toBe(true);
    camera.position.set(0, 3, FOLLOW_CUT_MAX_D + 2);
    camera.updateMatrixWorld();
    setCreatureFollowCut({ x: 0, y: 0, z: 0 });
    cut(batch);
    expect(batch.getVisibleAt(inFront)).toBe(true);
    batch.dispose();
  });
});
