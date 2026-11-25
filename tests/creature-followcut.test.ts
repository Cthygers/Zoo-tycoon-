// Follow cut of other animals: while the camera follows a subject up close, an
// animal between the camera and the subject is left out of the main pass (whole,
// never the subject itself), and comes back once it is clear of the view line.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FilteredBatch, FOLLOW_CUT_MAX_D, inFollowCut, setCreatureFollowCut } from '../src/models/crowd/batch';

/** Camera 5.25 m from a subject at the origin, looking at it from +z and a little above. */
const CAM = new THREE.Vector3(0, 3.1, 4.9);
/** Rest-pose boxes (mesh space, facing +z) of a camel, a lion and an elephant (assets.ts, detail 0). */
const CAMEL = new THREE.Box3(new THREE.Vector3(-0.35, 0, -1.18), new THREE.Vector3(0.35, 2.25, 2.35));
const LION = new THREE.Box3(new THREE.Vector3(-0.33, 0, -1.34), new THREE.Vector3(0.34, 1.27, 1.25));
const ELEPHANT = new THREE.Box3(new THREE.Vector3(-1.69, 0, -2.07), new THREE.Vector3(1.71, 3.24, 3.59));
/** An instance standing at (x, z) on the ground, heading `yaw` (rad), scaled by `s`. */
const at = (x: number, z: number, yaw = Math.PI / 2, s = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(s, s, s));

describe('creature follow cut', () => {
  afterEach(() => setCreatureFollowCut(null));

  it('cuts a body on the view line in front of the subject, not the subject or animals off the line', () => {
    setCreatureFollowCut({ x: 0, y: 0, z: 0 });
    // a camel side-on halfway to the camera
    expect(inFollowCut(CAM, at(0, 2.5), CAMEL, false)).toBe(true);
    // the subject itself (even a big one), and a neighbour right beside it
    expect(inFollowCut(CAM, at(0, 0), ELEPHANT, false)).toBe(false);
    expect(inFollowCut(CAM, at(1.2, 0.4, 0), LION, false)).toBe(false);
    // well to the side of the line, and behind the subject
    expect(inFollowCut(CAM, at(4, 2.5, 0), CAMEL, false)).toBe(false);
    expect(inFollowCut(CAM, at(0, -4), CAMEL, false)).toBe(false);
  });

  it('cuts a big animal whose body reaches past the subject, and one around the camera', () => {
    setCreatureFollowCut({ x: 0, y: 0, z: 0 });
    // an elephant side-on 1.8, 3.2 and 4.2 m in front of a followed hippo (its centre in front, its rump or flank around the subject)
    for (const d of [1.8, 3.2, 4.2]) expect(inFollowCut(CAM, at(0, d), ELEPHANT, false)).toBe(true);
    // end-on, its flank (ears) 0.2 m beside the line covers half the frame; 1.5 m beside it, the frame's edge
    expect(inFollowCut(CAM, at(0.2 + 1.7, 3, 0), ELEPHANT, false)).toBe(true);
    expect(inFollowCut(CAM, at(1.5 + 1.7, 3, 0), ELEPHANT, false)).toBe(false);
    // the camera inside its body
    expect(inFollowCut(CAM, at(0, 5.2), ELEPHANT, false)).toBe(true);
    // a calf (half size) beside the line is clear of it
    expect(inFollowCut(CAM, at(2.2, 3, 0, 0.5), ELEPHANT, false)).toBe(false);
  });

  it('keeps a low animal the view passes over (it hides nothing of the subject), cuts it end-on', () => {
    setCreatureFollowCut({ x: 0, y: 0, z: 0 });
    // a lion side-on 2.5 m in front: the line passes ~0.7 m over its back, its silhouette ends below the subject's feet
    expect(inFollowCut(CAM, at(0, 2.5), LION, false)).toBe(false);
    // end-on its head reaches 1.2 m from the subject, under the subject's body
    expect(inFollowCut(CAM, at(0, 2.5, Math.PI), LION, false)).toBe(true);
  });

  it('needs a wider clearance to bring a cut animal back (no flicker at the edge)', () => {
    setCreatureFollowCut({ x: 0, y: 0, z: 0 });
    // an end-on camel whose flank is 0.6 m from the line
    const edge = at(0.35 + 0.6, 2.6, 0);
    expect(inFollowCut(CAM, edge, CAMEL, false)).toBe(false);
    expect(inFollowCut(CAM, edge, CAMEL, true)).toBe(true);
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
