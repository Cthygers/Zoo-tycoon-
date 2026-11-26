// The follow cut takes an animal's shadow with it: an animal left out of the
// view while the camera follows another must not leave its shadow behind
// (elephant-leg blotches across a followed hippo, an elephant-shaped shadow on
// empty lawn). The shadow pass, which three runs first, decides the cut for the
// frame and the main pass reuses it, so the animal and its shadow go together.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FilteredBatch, setCreatureFollowCut } from '../src/models/crowd/batch';

/** Camera 5.25 m from a subject at the origin, looking at it from +z and a little above. */
const CAM = new THREE.Vector3(0, 3.1, 4.9);

interface Passes {
  onBeforeShadow(r: THREE.WebGLRenderer, o: THREE.Object3D, c: THREE.Camera, s: THREE.Camera, g: THREE.BufferGeometry, m: THREE.Material, grp: null): void;
  onAfterShadow(): void;
  onBeforeRender(r: THREE.WebGLRenderer, s: THREE.Scene, c: THREE.Camera, g: THREE.BufferGeometry, m: THREE.Material, grp: null): void;
  onAfterRender(): void;
}

describe('creature follow cut: shadows', () => {
  afterEach(() => setCreatureFollowCut(null));

  function setup() {
    const batch = new FilteredBatch('animal:test', new THREE.MeshBasicMaterial(), 4, 64, 192);
    const geo = new THREE.SphereGeometry(1.5, 6, 4);
    const g = batch.addGeometry(geo);
    const inFront = batch.addSlot(g);
    const subject = batch.addSlot(g);
    const aside = batch.addSlot(g);
    batch.setMatrixAt(inFront, new THREE.Matrix4().makeTranslation(0, 1.2, 2.5));
    batch.setMatrixAt(subject, new THREE.Matrix4().makeTranslation(0, 0.8, 0));
    batch.setMatrixAt(aside, new THREE.Matrix4().makeTranslation(8, 0.8, 0));
    batch.followCut = true;
    const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 200);
    camera.position.copy(CAM);
    camera.lookAt(0, 0.9, 0);
    camera.updateMatrixWorld();
    const sun = new THREE.OrthographicCamera(-30, 30, 30, -30, 0.1, 200);
    sun.position.set(20, 40, 10);
    sun.lookAt(0, 0, 0);
    sun.updateMatrixWorld();
    const renderer = { info: { render: { frame: 1 } } } as unknown as THREE.WebGLRenderer;
    const depth = new THREE.MeshDepthMaterial();
    const p = batch as unknown as Passes;
    const shadowPass = () => p.onBeforeShadow(renderer, batch, camera, sun, batch.geometry, depth, null);
    const mainPass = () => p.onBeforeRender(renderer, new THREE.Scene(), camera, batch.geometry, batch.material as THREE.Material, null);
    return { batch, inFront, subject, aside, camera, renderer, p, shadowPass, mainPass, dispose: () => (batch.dispose(), geo.dispose(), depth.dispose()) };
  }

  it('leaves a cut animal out of the shadow pass too, only while following, and shows it again afterwards', () => {
    const t = setup();
    setCreatureFollowCut({ x: 0, y: 0, z: 0 });
    t.shadowPass();
    expect(t.batch.getVisibleAt(t.inFront)).toBe(false);
    expect(t.batch.getVisibleAt(t.subject)).toBe(true);
    expect(t.batch.getVisibleAt(t.aside)).toBe(true);
    t.p.onAfterShadow();
    expect(t.batch.getVisibleAt(t.inFront)).toBe(true);
    // the main pass of the same frame leaves out the same animal
    t.mainPass();
    expect(t.batch.getVisibleAt(t.inFront)).toBe(false);
    t.p.onAfterRender();
    expect(t.batch.getVisibleAt(t.inFront)).toBe(true);
    // it still counts as a shadow caster: its shadow comes back with it
    expect(t.batch.castsShadowAt(t.inFront)).toBe(true);

    // free camera: everything casts
    setCreatureFollowCut(null);
    (t.renderer.info.render as { frame: number }).frame++;
    t.shadowPass();
    expect(t.batch.getVisibleAt(t.inFront)).toBe(true);
    t.p.onAfterShadow();
    t.dispose();
  });

  it('decides once per rendered frame: the main pass reuses the shadow pass decision', () => {
    const t = setup();
    setCreatureFollowCut({ x: 0, y: 0, z: 0 });
    t.shadowPass();
    t.p.onAfterShadow();
    // the animal walks off the line between the passes of one frame: the main pass keeps the frame's decision
    t.batch.setMatrixAt(t.inFront, new THREE.Matrix4().makeTranslation(9, 1.2, 2.5));
    t.mainPass();
    expect(t.batch.getVisibleAt(t.inFront)).toBe(false);
    t.p.onAfterRender();
    // next frame: decided anew, back in view with its shadow
    (t.renderer.info.render as { frame: number }).frame++;
    t.shadowPass();
    expect(t.batch.getVisibleAt(t.inFront)).toBe(true);
    t.p.onAfterShadow();
    t.mainPass();
    expect(t.batch.getVisibleAt(t.inFront)).toBe(true);
    t.p.onAfterRender();
    t.dispose();
  });
});
