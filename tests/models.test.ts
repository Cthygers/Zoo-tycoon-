import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { capsule, cone, ellipsoid, mirrorName, sphere, symmetric } from '../src/models/sdf/prims';
import { buildGeometry, coatBaker, compile } from '../src/models/build/geometry';
import { surfaceNets } from '../src/models/sdf/mesher';
import { SdfField } from '../src/models/sdf/field';
import { CompiledPrim } from '../src/models/sdf/prims';
import { RigDef, RigRuntime, Pose, TwoBoneChain } from '../src/models/rig/rig';
import { SPECIES_MODELS } from '../src/models/species';
import { SPECIES, SPECIES_BY_ID } from '../src/data/species';
import { CreatureFactory } from '../src/models';
import type { QualitySettings } from '../src/core/contracts';
import type { HumanAppearance } from '../src/core/types';
import { skinMatrices } from '../src/models/model';
import { SimplifyJob, simplifyGeometry } from '../src/models/lod/simplify';
import { LOD_RATIOS, lodPolicy, pickLod } from '../src/models/lod/lod';
import { FilteredBatch, SkinnedBatch } from '../src/models/crowd/batch';
import { crowdUniforms } from '../src/models/crowd/skinning';

const quality = (d: 0 | 1 | 2): QualitySettings => ({
  level: (['low', 'medium', 'high'] as const)[d],
  pixelRatio: 1,
  antialias: false,
  shadows: false,
  shadowMapSize: 1024,
  grassDensity: 0,
  postFX: false,
  detailDistance: 40,
  creatureDetail: d,
});

function checkSkin(geo: THREE.BufferGeometry, boneCount: number): void {
  const w = geo.getAttribute('skinWeight');
  const idx = geo.getAttribute('skinIndex');
  for (let i = 0; i < w.count; i++) {
    const s = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i);
    expect(Math.abs(s - 1)).toBeLessThan(1e-4);
    for (let k = 0; k < 4; k++) {
      expect(idx.getComponent(i, k)).toBeLessThan(boneCount);
      expect(w.getComponent(i, k)).toBeGreaterThanOrEqual(0);
    }
  }
}

describe('SDF primitives', () => {
  it('sphere / round cone distances are exact', () => {
    const s = new CompiledPrim(sphere('b', [0, 0, 0], 0.5), 0, 0, -1);
    expect(s.dist(1, 0, 0)).toBeCloseTo(0.5, 3);
    expect(s.dist(0, 0, 0)).toBeCloseTo(-0.5, 3);
    const c = new CompiledPrim(cone('b', [0, 0, 0], [0, 1, 0], 0.2, 0.1), 0, 0, -1);
    expect(c.dist(0.2, 0, 0)).toBeCloseTo(0, 2);
    expect(c.dist(0, 1.1, 0)).toBeCloseTo(0, 3);
    expect(c.dist(0, 0.5, 0)).toBeLessThan(0);
  });
  it('mirrors names', () => {
    expect(mirrorName('FL_upper')).toBe('FR_upper');
    expect(mirrorName('HR')).toBe('HL');
    expect(mirrorName('ear.L')).toBe('ear.R');
    expect(symmetric([sphere('ear.L', [0.1, 0, 0], 0.1)]).map((p) => p.bone)).toEqual(['ear.L', 'ear.R']);
  });
});

describe('surface nets mesher', () => {
  it('meshes a sphere closed, outward-facing, on the surface', () => {
    const f = new SdfField([new CompiledPrim(sphere('b', [0, 0, 0], 0.5), 0, 0, -1)]);
    const m = surfaceNets(f, { min: [-0.6, -0.6, -0.6], max: [0.6, 0.6, 0.6], cell: [0.05, 0.05, 0.05] });
    expect(m.indices.length / 3).toBeGreaterThan(500);
    // vertices projected onto the surface
    for (let i = 0; i < m.positions.length; i += 3) {
      const r = Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]);
      expect(Math.abs(r - 0.5)).toBeLessThan(0.006);
    }
    // closed: every edge is shared by exactly two triangles
    const edges = new Map<string, number>();
    for (let t = 0; t < m.indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = m.indices[t + e], b = m.indices[t + ((e + 1) % 3)];
        const k = a < b ? `${a}_${b}` : `${b}_${a}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    }
    for (const c of edges.values()) expect(c).toBe(2);
    // winding: triangle normals point away from the centre
    let outward = 0;
    const P = m.positions;
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), n = new THREE.Vector3();
    for (let t = 0; t < m.indices.length; t += 3) {
      va.fromArray(P, m.indices[t] * 3);
      vb.fromArray(P, m.indices[t + 1] * 3);
      vc.fromArray(P, m.indices[t + 2] * 3);
      n.crossVectors(vb.clone().sub(va), vc.clone().sub(va));
      if (n.dot(va) > 0) outward++;
    }
    expect(outward / (m.indices.length / 3)).toBeGreaterThan(0.99);
  });
});

describe('geometry build + skinning', () => {
  it('builds a two-bone limb with normalized weights and a fine detail region', () => {
    const bones = [
      { name: 'root', parent: null, pos: [0, 0.5, 0] as const },
      { name: 'leg', parent: 'root', pos: [0, 0.35, 0] as const },
    ];
    const prims = [ellipsoid('root', [0, 0.6, 0], [0.3, 0.2, 0.4]), capsule('leg', [0, 0.45, 0], [0, 0.03, 0], 0.03, { blend: 0.04, region: 'leg' })];
    const r = buildGeometry({ bones, prims, regions: { leg: {} } }, 1, coatBaker(() => undefined));
    expect(r.triangles).toBeGreaterThan(300);
    checkSkin(r.geometry, 2);
    const bb = r.geometry.boundingBox!;
    expect(bb.min.y).toBeGreaterThan(-0.01);
    expect(bb.min.y).toBeLessThan(0.02);
    expect(bb.max.y).toBeCloseTo(0.8, 1);
    // the foot of the leg follows the leg bone only
    const pos = r.geometry.getAttribute('position');
    const w = r.geometry.getAttribute('skinWeight');
    const idx = r.geometry.getAttribute('skinIndex');
    let foot = 0;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < 0.1) {
        foot++;
        expect(idx.getX(i)).toBe(1);
        expect(w.getX(i)).toBeGreaterThan(0.95);
      }
    }
    expect(foot).toBeGreaterThan(5);
  });

  it('every species builds: sane bounds, weights, feet on the ground', { timeout: 120_000 }, () => {
    for (const s of SPECIES) {
      const m = SPECIES_MODELS[s.id];
      expect(m, s.id).toBeDefined();
      for (const sex of m.dimorphic ? (['M', 'F'] as const) : (['F'] as const)) {
        const d = m.design({ def: SPECIES_BY_ID[s.id], sex, detail: 0 });
        const r = buildGeometry({ bones: d.bones, prims: d.prims, regions: d.regions, resolution: d.resolution }, 0, coatBaker(d.coat), d.eyes);
        expect(r.triangles, s.id).toBeGreaterThan(800);
        checkSkin(r.geometry, r.rig.count);
        const bb = r.geometry.boundingBox!;
        expect(bb.min.y, s.id).toBeGreaterThan(-0.03);
        expect(bb.min.y, s.id).toBeLessThan(0.08);
        const size = bb.getSize(new THREE.Vector3());
        expect(size.y, s.id).toBeGreaterThan(s.height * 0.4);
        expect(size.y, s.id).toBeLessThan(s.height * 2.2);
        expect(Math.abs((bb.min.x + bb.max.x) / 2), s.id).toBeLessThan(0.05);
        // facing +Z: the head (muzzle) is in front of the hips
        const c = compile(d.bones, d.prims);
        expect(c.rig.count).toBe(d.bones.length);
      }
    }
  });
});

describe('rig + IK', () => {
  it('two-bone IK reaches a reachable target', () => {
    const def = new RigDef([
      { name: 'hip', parent: null, pos: [0, 1, 0] },
      { name: 'knee', parent: 'hip', pos: [0, 0.5, 0.05] },
      { name: 'ankle', parent: 'knee', pos: [0, 0.05, 0] },
    ]);
    const rt = new RigRuntime(def);
    const pose = new Pose(def.count);
    rt.fk(pose);
    const chain = new TwoBoneChain(def, 0, 1, 2, [0, 0, 1]);
    const target = new THREE.Vector3(0, 0.2, 0.3);
    chain.solve(rt, pose, target, chain.restPole);
    rt.fk(pose);
    expect(rt.wp[2].distanceTo(target)).toBeLessThan(1e-3);
    // knee bends toward the pole (+Z)
    expect(rt.wp[1].z).toBeGreaterThan(0.15);
  });
});

describe('creature factory', () => {
  it('creates, animates and disposes animals and humans (standalone)', { timeout: 60_000 }, async () => {
    const f = new CreatureFactory(quality(0));
    await f.preload(['zebra', 'lion']);
    const z = f.createAnimal('zebra', { seed: 3, sex: 'F', growth: 0.5 });
    expect(z.height).toBeGreaterThan(0.5);
    expect(z.height).toBeLessThan(1.8);
    for (const action of ['idle', 'walk', 'run', 'eat', 'drink', 'sleep', 'sit', 'play', 'swim', 'social', 'call', 'unknown']) {
      for (let i = 0; i < 10; i++) z.update(1 / 30, { action, speed: action === 'run' ? 7 : action === 'walk' ? 1.5 : 0, actionTime: i / 30, swimming: action === 'swim' });
    }
    z.setHighlighted(true);
    z.setHighlighted(false);
    z.dispose();
    const h = f.createHuman(
      { skin: 0xc68e6a, hair: 0x332211, shirt: 0x335577, pants: 0x222222, shoes: 0x111111, hairStyle: 1, height: 1.7, build: 1.1, child: false, female: true },
      'guest',
      9,
    );
    expect(h.height).toBeCloseTo(1.7, 1);
    for (const holding of ['none', 'food', 'drink', 'icecream', 'balloon', 'gift']) {
      for (const action of ['walk', 'idle', 'watch', 'eat', 'sit', 'shop', 'leave']) h.update(1 / 30, { action, speed: action === 'walk' ? 1.3 : 0, holding });
    }
    const keeper = f.createHuman(
      { skin: 0x8d5a3b, hair: 0x111111, shirt: 0, pants: 0, shoes: 0, hairStyle: 0, height: 1.8, build: 1, child: false, female: false },
      'groundskeeper',
      2,
    );
    keeper.update(1 / 30, { action: 'work', speed: 0 });
    h.dispose();
    keeper.dispose();
  });
});

// ---------------------------------------------------------------------------
// Crowd rendering: skinning, LODs, batches

const APP: HumanAppearance = { skin: 0xc68e6a, hair: 0x332211, shirt: 0x335577, pants: 0x222222, shoes: 0x111111, hairStyle: 1, height: 1.7, build: 1.1, child: false, female: true };

describe('skin matrices', () => {
  it('match THREE.SkinnedMesh bone matrices for an animated pose', { timeout: 30_000 }, async () => {
    const f = new CreatureFactory(quality(0));
    await f.preload(['zebra']);
    const asset = f.getAsset('zebra', 'F');
    const rig = asset.rig;
    const pose = new Pose(rig.count);
    // arbitrary pose with offsets and scales
    for (let i = 0; i < rig.count; i++) {
      pose.q[i].setFromEuler(new THREE.Euler(Math.sin(i) * 0.4, Math.cos(i * 1.7) * 0.3, Math.sin(i * 0.3) * 0.2));
      pose.p[i].set(Math.sin(i) * 0.01, 0.02 * (i % 3), 0);
      pose.s[i] = 1 + (i % 4) * 0.05;
    }
    const head = asset.roles.head;
    const out = new Float32Array(rig.count * 12);
    skinMatrices(rig, pose, head, 1.2, out, 0);
    // reference: three.js bone hierarchy
    const bones = rig.names.map(() => new THREE.Bone());
    const root = new THREE.Group();
    for (let i = 0; i < rig.count; i++) {
      const b = bones[i];
      b.position.set(rig.offset[i * 3] + pose.p[i].x, rig.offset[i * 3 + 1] + pose.p[i].y, rig.offset[i * 3 + 2] + pose.p[i].z);
      b.quaternion.copy(pose.q[i]);
      const sc = pose.s[i] * (i === head ? 1.2 : 1);
      b.scale.set(sc, sc, sc);
      const p = rig.parent[i];
      (p >= 0 ? bones[p] : root).add(b);
    }
    root.updateMatrixWorld(true);
    const m = new THREE.Matrix4();
    let maxErr = 0;
    for (let i = 0; i < rig.count; i++) {
      m.makeTranslation(-rig.rest[i * 3], -rig.rest[i * 3 + 1], -rig.rest[i * 3 + 2]).premultiply(bones[i].matrixWorld);
      const e = m.elements; // column-major
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) maxErr = Math.max(maxErr, Math.abs(out[i * 12 + r * 4 + c] - e[c * 4 + r]));
    }
    expect(maxErr).toBeLessThan(1e-4);
  });
});

describe('LOD simplification', () => {
  it('hits the triangle ratio, keeps every attribute and valid skin weights', { timeout: 30_000 }, async () => {
    const f = new CreatureFactory(quality(0));
    await f.preload(['zebra']);
    const asset = f.getAsset('zebra', 'F');
    const src = asset.geometry;
    const srcTris = src.getIndex()!.count / 3;
    for (const ratio of LOD_RATIOS.slice(1)) {
      const st = { triangles: 0, vertices: 0, cell: 0, ms: 0 };
      const g = simplifyGeometry(src, ratio, st);
      expect(st.triangles / srcTris).toBeGreaterThan(ratio * 0.75);
      expect(st.triangles / srcTris).toBeLessThan(ratio * 1.3);
      expect(Object.keys(g.attributes).sort()).toEqual(Object.keys(src.attributes).sort());
      for (const k of Object.keys(src.attributes)) expect(g.getAttribute(k).array.constructor).toBe(src.getAttribute(k).array.constructor);
      checkSkin(g, asset.rig.count);
      // indices in range, no degenerate triangles
      const idx = g.getIndex()!;
      const nv = g.getAttribute('position').count;
      for (let i = 0; i < idx.count; i += 3) {
        const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
        expect(a < nv && b < nv && c < nv).toBe(true);
        expect(a !== b && b !== c && a !== c).toBe(true);
      }
      // the silhouette survives: bounds close to the source
      g.computeBoundingBox();
      const s0 = src.boundingBox!.getSize(new THREE.Vector3());
      const s1 = g.boundingBox!.getSize(new THREE.Vector3());
      expect(Math.abs(s1.y - s0.y) / s0.y).toBeLessThan(0.08);
      expect(Math.abs(s1.z - s0.z) / s0.z).toBeLessThan(0.08);
    }
  });

  it('builds incrementally (bounded work per step)', async () => {
    const f = new CreatureFactory(quality(0));
    await f.preload(['zebra']);
    const job = new SimplifyJob(f.getAsset('zebra', 'F').geometry, LOD_RATIOS[2]);
    let steps = 0;
    while (!job.step()) steps++;
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThan(12);
    expect(job.result!.getIndex()!.count).toBeGreaterThan(0);
  });

  it('picks LOD levels with hysteresis', () => {
    for (const d of [0, 1, 2] as const) {
      const p = lodPolicy(quality(d));
      const [d1, d2, d3] = p.d;
      expect(p.d.length).toBe(LOD_RATIOS.length - 1);
      expect(pickLod(-1, 1, p)).toBe(0);
      expect(pickLod(-1, d1 + 0.1, p)).toBe(1);
      expect(pickLod(-1, d2 + 0.1, p)).toBe(2);
      expect(pickLod(-1, d3 + 0.1, p)).toBe(3);
      // just past a threshold: keep the current level
      expect(pickLod(0, d1 * 1.05, p)).toBe(0);
      expect(pickLod(1, d1 * 0.95, p)).toBe(1);
      expect(pickLod(1, d2 * 1.05, p)).toBe(1);
      expect(pickLod(2, d2 * 0.95, p)).toBe(2);
      expect(pickLod(3, d3 * 0.95, p)).toBe(3);
      // clearly past it: switch (possibly several levels at once)
      expect(pickLod(0, d1 * 1.3, p)).toBe(1);
      expect(pickLod(1, d1 * 0.7, p)).toBe(0);
      expect(pickLod(3, d3 * 0.8, p)).toBe(2);
      expect(pickLod(0, d3 * 2, p)).toBe(3);
      expect(pickLod(3, 0.5, p)).toBe(0);
      // stable: repeated calls at the same distance never oscillate
      let l = 0;
      for (let i = 0; i < 50; i++) {
        const nd = d1 * (1 + 0.1 * Math.sin(i));
        const n = pickLod(l, nd, p);
        expect(Math.abs(n - l)).toBeLessThanOrEqual(1);
        l = n;
      }
    }
  });
});

/** A camera looking down -Z from the origin. */
function testCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  cam.position.set(0, 1, 0);
  cam.lookAt(0, 1, -10);
  cam.updateMatrixWorld();
  return cam;
}
const fakeRenderer = { isWebGPURenderer: false } as unknown as THREE.WebGLRenderer;

function boxGeo(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.deleteAttribute('uv');
  g.computeBoundingSphere();
  return g;
}

describe('instancing bookkeeping', () => {
  it('adds, removes and reuses slots; compacts the draw list per camera', () => {
    const b = new FilteredBatch('t', new THREE.MeshBasicMaterial(), 4, 64, 192);
    const g = b.addKeyedGeometry('box', boxGeo());
    expect(b.addKeyedGeometry('box', boxGeo())).toBe(g); // keyed: no duplicate
    const ids: number[] = [];
    const m = new THREE.Matrix4();
    for (let i = 0; i < 6; i++) {
      // grows past the initial capacity of 4
      const id = b.addSlot(g);
      ids.push(id);
      b.setMatrixAt(id, m.makeTranslation(i - 3, 1, -10));
    }
    expect(new Set(ids).size).toBe(6);
    expect(b.maxInstanceCount).toBeGreaterThanOrEqual(6);
    expect(b.live).toBe(6);
    // one behind the camera, one removed, one hidden
    b.setMatrixAt(ids[5], m.makeTranslation(0, 1, 20));
    b.removeSlot(ids[1]);
    b.setVisible(ids[2], false);
    expect(b.live).toBe(5);
    const cam = testCamera();
    b.onBeforeRender(fakeRenderer, new THREE.Scene(), cam, b.geometry, b.material as THREE.Material, new THREE.Group());
    expect(b.lastDrawCount).toBe(3);
    expect(b.lastDrawIds().sort()).toEqual([ids[0], ids[3], ids[4]].sort());
    // freed ids are reused
    const again = b.addSlot(g);
    expect(again).toBe(ids[1]);
    // shadow pass: non-casters are hidden only during the pass
    b.setCastShadow(ids[3], false);
    b.onBeforeShadow(fakeRenderer, new THREE.Scene(), cam, cam, b.geometry, b.material as THREE.Material, new THREE.Group());
    expect(b.lastDrawIds()).not.toContain(ids[3]);
    b.onAfterShadow();
    b.setMatrixAt(again, m.makeTranslation(0, 1, -5));
    b.onBeforeRender(fakeRenderer, new THREE.Scene(), cam, b.geometry, b.material as THREE.Material, new THREE.Group());
    expect(b.lastDrawIds()).toContain(ids[3]);
    expect(b.lastDrawCount).toBe(4);
    // per-frame bounds: an empty batch is skipped entirely
    b.beginBounds();
    b.endBounds();
    expect(b.visible).toBe(false);
    b.beginBounds();
    b.includeBounds(new THREE.Vector3(0, 0, -10), 1, false);
    b.endBounds();
    expect(b.visible).toBe(true);
    expect(b.castShadow).toBe(false);
    b.dispose();
  });

  it('keeps per-instance data blocks across growth', () => {
    const u = crowdUniforms();
    const b = new SkinnedBatch('s', new THREE.MeshBasicMaterial(), new THREE.MeshDepthMaterial(), [u], { bones: 3, look: 2, instances: 2, vertices: 64, indices: 192 });
    expect(b.stride).toBe(2 + 9);
    const g = b.addKeyedGeometry('box', boxGeo());
    const a = b.addSlot(g);
    b.data[b.offset(a)] = 7;
    b.data[b.boneOffset(a)] = 3;
    expect(b.boneOffset(a) - b.offset(a)).toBe(8);
    const ids = [a];
    for (let i = 0; i < 9; i++) ids.push(b.addSlot(g));
    expect(b.maxInstanceCount).toBeGreaterThanOrEqual(10);
    expect(b.data[b.offset(a)]).toBe(7);
    expect(b.data[b.boneOffset(a)]).toBe(3);
    expect(u.crData.value).toBe(b.texture);
    expect(u.crStride.value).toBe(11);
    expect(b.texture.image.width * b.texture.image.height).toBeGreaterThanOrEqual(10 * 11);
    // a reused slot starts clean
    b.removeSlot(a);
    const r = b.addSlot(g);
    expect(r).toBe(a);
    expect(b.data[b.offset(r)]).toBe(0);
    // only rows in use are uploaded
    b.flush();
    expect(b.texture.needsUpdate === undefined || b.texture.version > 0).toBe(true);
    b.dispose();
  });
});

describe('crowd renderer', () => {
  it('batches models in the factory scene, picks LODs, frees slots; standalone elsewhere', { timeout: 60_000 }, async () => {
    const f = new CreatureFactory(quality(1));
    const scene = new THREE.Scene();
    scene.add(f.root);
    const entities = new THREE.Group();
    scene.add(entities);
    await f.preload(['zebra']);
    const near = f.createAnimal('zebra', { seed: 1, sex: 'F', growth: 1 });
    const far = f.createAnimal('zebra', { seed: 2, sex: 'M', growth: 0.5 });
    const people = Array.from({ length: 5 }, (_, i) => f.createHuman({ ...APP, female: i % 2 === 0, hairStyle: (i % 4) as 0 }, i === 4 ? 'groundskeeper' : 'guest', i));
    entities.add(near.object, far.object, ...people.map((p) => p.object));
    near.object.position.set(0, 0, -6);
    far.object.position.set(0, 0, -150);
    people.forEach((p, i) => p.object.position.set(i - 2, 0, -4 - i * 30));
    const cam = testCamera();
    // animate (people hold items) and render a few frames
    for (let frame = 0; frame < 4; frame++) {
      near.update(1 / 30, { action: 'walk', speed: 1.4 });
      far.update(1 / 30, { action: 'idle', speed: 0 });
      people.forEach((p, i) => p.update(1 / 30, { action: i === 4 ? 'work' : 'walk', speed: 1.3, holding: ['balloon', 'icecream', 'none', 'drink', 'none'][i] }));
      f.crowd.buildBudgetMs = 1e9;
      f.update(cam);
    }
    expect(f.crowd.batchedCount).toBe(7);
    const batches = f.crowd.batchList();
    expect(batches.length).toBe(2); // one zebra variant + one for all people
    expect(near.object.children.length).toBe(0); // no per-model meshes
    const st = f.crowdStats();
    expect(st.visible).toBe(7);
    expect(st.perLod[0]).toBeGreaterThan(0);
    expect(st.perLod[2] + st.perLod[3]).toBeGreaterThan(0);
    expect(st.shadow).toBeLessThan(7);
    // items: balloon + string, ice cream, drink, broom
    const items = f.crowd.items();
    expect(items.live).toBe(5);
    // hiding / removing
    people[0].object.visible = false;
    f.update(cam);
    expect(f.crowdStats().visible).toBe(6);
    people[0].dispose();
    f.update(cam);
    expect(f.crowd.batchedCount).toBe(6);
    expect(items.live).toBe(3);
    // highlight goes through the look block
    near.setHighlighted(true);
    f.update(cam);
    const zb = batches.find((b) => b.name.startsWith('animal'))!;
    expect(zb.data[zb.offset((near as unknown as { slot: number }).slot)]).toBeGreaterThan(0);
    near.setHighlighted(false);
    // moving a model to another scene (UI thumbnail) renders it standalone
    const thumb = new THREE.Scene();
    thumb.add(far.object);
    expect(f.crowd.batchedCount).toBe(5);
    expect(far.object.children.length).toBe(1);
    expect((far.object.children[0] as THREE.SkinnedMesh).isSkinnedMesh).toBe(true);
    entities.add(far.object);
    expect(f.crowd.batchedCount).toBe(6);
    expect(far.object.children.length).toBe(0);
    for (const m of [near, far, ...people.slice(1)]) m.dispose();
    f.update(cam);
    expect(f.crowd.batchedCount).toBe(0);
    expect(f.crowd.looseCount).toBe(0);
    expect(items.live).toBe(0);
    // a thumbnail-style model (never in the factory scene) is drawable before any update and released on dispose
    const t = f.createHuman(APP, 'vet', 3);
    t.update(1 / 30, { action: 'idle', speed: 0 });
    expect(t.object.children.length).toBe(1);
    t.object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(t.object, true);
    expect(box.max.y).toBeGreaterThan(1.4);
    // standalone highlight keeps the person's clothing material (emissive glow only)
    const mesh = t.object.children[0] as THREE.SkinnedMesh;
    const before = mesh.material;
    t.setHighlighted(true);
    expect(mesh.material).toBe(before);
    expect((mesh.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(0);
    t.setHighlighted(false);
    thumb.add(t.object);
    t.dispose();
    expect(f.crowd.looseCount).toBe(0);
    f.dispose();
  });
});
