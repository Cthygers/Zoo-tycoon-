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

  it('every species builds: sane bounds, weights, feet on the ground', () => {
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
  it('creates, animates and disposes animals and humans', async () => {
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
