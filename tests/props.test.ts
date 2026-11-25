import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import { World } from '../src/core/world';
import type { QualitySettings } from '../src/core/contracts';
import { followBlockers, PropsLayer, type BlockerHit } from '../src/props';
import { MultiBatch, frustumToArray, type CullView } from '../src/props/lod/batched';

const QUALITY: QualitySettings = { level: 'low', pixelRatio: 1, antialias: false, shadows: true, shadowMapSize: 1024, grassDensity: 0.25, postFX: false, detailDistance: 26, creatureDetail: 0 };

describe('MultiBatch draw-id textures', () => {
  function setup() {
    const parent = new THREE.Group();
    const batch = new MultiBatch(new THREE.MeshStandardMaterial(), true, parent);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 40; i++) batch.add(geo, m.makeTranslation(i * 2, 0, 0), { id: i, slot: { index: -1 } }, { cull: Infinity, shadow: 30, lodOn: true });
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    camera.position.set(40, 30, 40);
    camera.lookAt(40, 0, 0);
    camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const view: CullView = { camera, cam: camera.position.clone(), focus: new THREE.Vector3(40, 0, 0), planes: frustumToArray(frustum, new Float32Array(24)), shadows: true };
    batch.cull(view);
    const shadowCam = new THREE.OrthographicCamera(-60, 60, 60, -60, 0.1, 400);
    shadowCam.position.set(40, 100, 0);
    shadowCam.lookAt(40, 0, 0);
    shadowCam.updateMatrixWorld();
    const internal = batch.mesh as unknown as { _indirectTexture: THREE.DataTexture };
    return { batch, geo, camera, shadowCam, internal };
  }

  it('re-uploads a pass list only when it changes', () => {
    const { batch, geo, camera, shadowCam, internal } = setup();
    batch.writeMain(camera, geo);
    const main = internal._indirectTexture;
    const v0 = main.version;
    batch.writeShadow(shadowCam, geo);
    const shadow = internal._indirectTexture;
    expect(shadow).not.toBe(main);
    const s0 = shadow.version;
    // a still frame: same lists, nothing to upload
    batch.writeMain(camera, geo);
    batch.writeShadow(shadowCam, geo);
    expect(internal._indirectTexture).toBe(shadow);
    expect(main.version).toBe(v0);
    expect(shadow.version).toBe(s0);
  });

  it('uploads again after an instance is removed', () => {
    const { batch, geo, camera, internal } = setup();
    batch.writeMain(camera, geo);
    const main = internal._indirectTexture;
    const v0 = main.version;
    batch.remove(20); // in view (x = 40 m)
    batch.writeMain(camera, geo); // dirty: re-culled for this camera
    expect(main.version).toBe(v0 + 1);
  });
});

describe('PropsLayer loading', () => {
  it('builds templates only for the object types the world uses', async () => {
    const events = new EventBus();
    const world = new World(events, 3);
    for (const o of [...world.objects.values()]) world.removeObject(o.id);
    world.addObject('bench', 40, 40, 0, 1);
    world.addObject('bench', 44, 40, 0, 1);
    world.addObject('rock_small', 50, 50, 0, 2);
    const layer = new PropsLayer(world, events, new THREE.Scene(), QUALITY);
    // nothing is built while the layer is created (the loading bar keeps moving)
    expect(layer.debugInfo().templates).toBe(0);
    await layer.prewarm();
    expect(layer.debugInfo().templates).toBe(2);
    expect(layer.debugInfo().instances).toBeGreaterThan(0);
    layer.dispose();
  }, 60000);

  it('lets boulders take the follow occluder cut and registers outcrops for the follow camera', async () => {
    const events = new EventBus();
    const world = new World(events, 3);
    for (const o of [...world.objects.values()]) world.removeObject(o.id);
    world.addObject('rock_boulder', 40, 40, 0, 1);
    const outcrop = world.addObject('rock_outcrop', 50, 40, 0, 2);
    const scene = new THREE.Scene();
    const layer = new PropsLayer(world, events, scene, QUALITY);
    await layer.prewarm();
    const keys = new Set<string>();
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !Array.isArray(m) && m.name.startsWith('nature/rock:')) keys.add(`${m.name} ${m.customProgramCacheKey()}`);
    });
    expect([...keys].find((k) => k.startsWith('nature/rock:granite'))).toContain('|propoccl0.6');
    expect([...keys].find((k) => k.startsWith('nature/rock:sandstone'))).not.toContain('propoccl');
    // the outcrop is a blocker on a low camera → subject line across it, until it is removed
    const c = world.objectCenter(outcrop);
    const y = world.heightAt(c.x, c.z);
    const out: BlockerHit[] = [];
    const across = (dz: number) => followBlockers({ x: c.x - 6, y: y + 1.2, z: c.z + dz }, { x: c.x + 4, y: y + 0.8, z: c.z + dz }, out);
    expect(across(0)).toBe(1);
    expect(across(6)).toBe(0);
    world.removeObject(outcrop.id);
    expect(across(0)).toBe(0);
    layer.dispose();
  }, 60000);

  it('adds the world on the first frame when prewarm was skipped', () => {
    const events = new EventBus();
    const world = new World(events, 3);
    for (const o of [...world.objects.values()]) world.removeObject(o.id);
    world.addObject('bench', 40, 40, 0, 1);
    const layer = new PropsLayer(world, events, new THREE.Scene(), QUALITY);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(80, 20, 100);
    camera.lookAt(80, 0, 80);
    layer.update(0, 0, camera);
    expect(layer.debugInfo().instances).toBeGreaterThan(0);
    layer.dispose();
  });
});

describe('foliage sheets', () => {
  it('drop their pixels after the upload and paint them again when needed', async () => {
    const { atlas } = await import('../src/props/nature/atlases');
    const tex = atlas('oak').tex;
    const w = tex.image.width;
    expect(tex.mipmaps.length).toBeGreaterThan(5);
    tex.onUpdate?.(tex); // what three calls once the texture is on the GPU
    const level0 = (tex.mipmaps[0] as { data: Uint8Array }).data;
    expect(level0.length).toBe(w * tex.image.height * 4);
    expect(level0.some((v) => v > 0)).toBe(true);
  }, 60000);
});
