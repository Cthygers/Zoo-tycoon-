// Human factory: cached skinned meshes per body type (female, child, hair /
// hat) + per-instance clothing colours, cut, girth, height and held items.

import * as THREE from 'three';
import type { CreatureAnim, QualitySettings } from '../../core/contracts';
import type { HumanAppearance, StaffRole } from '../../core/types';
import { buildGeometry, type SampleImpl, type VertexBaker } from '../build/geometry';
import { resolveRoles } from '../rig/roles';
import { RiggedModel, type RigAsset } from '../model';
import { driver, hash1, unwrapDriver } from '../anim/util';
import { humanDriver } from '../anim/human';
import { humanDesign, type HairKind, type HumanBodyKey, type HumanDesign } from './design';
import { createHumanMaterial, type HumanColors, type HumanCut, type HumanMaterial } from './material';
import { itemGeometry, itemMaterial, stringGeometry, type ItemKind } from './items';
import type { CreatureDesign } from '../types';

/** Human mesh resolution: cells along the height for detail 0/1/2. */
const HUMAN_CELLS: readonly number[] = [22, 27, 36];

interface HumanAsset extends RigAsset {
  human: HumanDesign;
}

const GIRTH: Record<string, number> = { torso: 1, pelvis: 0.85, arm: 0.3, leg: 0.55, neck: 0.25, hand: 0, shoe: 0, head: 0.05, ear: 0, hair: 0.05, hat: 0 };

function humanBaker(d: HumanDesign): VertexBaker {
  const sh = d.marks.shoulderL;
  const hp = d.marks.hipL;
  const notHair = ['hair', 'hat'];
  const notHat = ['hat'];
  return {
    attributes: [
      { name: 'zone', size: 4 },
      { name: 'girth', size: 1 },
    ],
    bake(s: SampleImpl, out, v) {
      const side = s.x >= 0 ? 1 : -1;
      let armT = -1, legT = -1;
      if (s.part === 'arm' || s.part === 'hand') armT = Math.hypot(s.x - sh[0] * side, s.y - sh[1], s.z - sh[2]);
      if (s.part === 'leg' || s.part === 'shoe') legT = Math.hypot(s.x - hp[0] * side, s.y - hp[1], s.z - hp[2]);
      const dHair = s.pd('hair'), dHat = s.pd('hat');
      const hairD = dHair < 1e2 ? s.pdExcept(notHair) - dHair : -1;
      const hatD = dHat < 1e2 ? s.pdExcept(notHat) - dHat : -1;
      out[0][v * 4] = armT;
      out[0][v * 4 + 1] = legT;
      out[0][v * 4 + 2] = Math.max(-1, Math.min(1, hairD));
      out[0][v * 4 + 3] = Math.max(-1, Math.min(1, hatD));
      // girth: smooth over part weights
      let g = 0;
      for (const k in GIRTH) g += GIRTH[k] * s.pw(k);
      out[1][v] = g;
    },
  };
}

function buildHumanAsset(key: HumanBodyKey, detail: 0 | 1 | 2): HumanAsset {
  const hd = humanDesign(key);
  const built = buildGeometry(
    {
      bones: hd.bones,
      prims: hd.prims,
      cells: HUMAN_CELLS,
      baseAniso: [1, 1.4, 1],
      regions: {
        head: { scale: 0.52 },
        brim: { scale: 0.3, aniso: [2, 1, 2] },
        armL: { scale: 0.45, aniso: [1, 2, 1] },
        armR: { scale: 0.45, aniso: [1, 2, 1] },
        legL: { aniso: [1, 2.4, 1] },
        legR: { aniso: [1, 2.4, 1] },
      },
    },
    detail,
    humanBaker(hd),
  );
  const design: CreatureDesign = {
    bones: hd.bones,
    roles: hd.roles,
    prims: hd.prims,
    coat: () => undefined,
    look: { skin: 'smooth' },
    anim: driver(humanDriver()),
    babyScale: 1,
    babyHead: 1,
    height: hd.height,
    radius: 0.25,
  };
  const size = built.bounds.getSize(new THREE.Vector3());
  const center = built.bounds.getCenter(new THREE.Vector3());
  const dummy = new THREE.MeshBasicMaterial();
  return {
    key: `human:${key.female ? 'F' : 'M'}:${key.child ? 'c' : 'a'}:${key.hair}:${detail}`,
    geometry: built.geometry,
    rig: built.rig,
    roles: resolveRoles(built.rig, hd.roles),
    design,
    driver: unwrapDriver(design.anim),
    material: dummy,
    highlightMaterial: dummy,
    sphere: new THREE.Sphere(center, Math.max(size.y, size.x, size.z) * 0.6 + 0.2),
    height: hd.height,
    radius: 0.28 * (key.child ? 0.75 : 1),
    triangles: built.triangles,
    buildMs: built.ms,
    human: hd,
  };
}

const STAFF_COLORS: Record<StaffRole, Partial<HumanColors>> = {
  keeper: { shirt: 0xa39466, pants: 0x6d6446, hat: 0x958a5f, shoes: 0x4a3a2a },
  groundskeeper: { shirt: 0x34492f, pants: 0x2f432c, hat: 0x2b3b28, shoes: 0x2b2622 },
  vet: { shirt: 0xe6e6e2, pants: 0x3b4a5c, hat: 0xe6e6e2, shoes: 0x2a2a2e },
};

function hairKind(app: HumanAppearance, role: 'guest' | StaffRole): HairKind {
  if (role === 'keeper') return 'bushhat';
  if (role === 'groundskeeper') return 'cap';
  const k = (['short', 'long', 'bald', 'cap'] as const)[app.hairStyle] ?? 'short';
  if (role === 'vet' && k === 'cap') return 'short';
  if (app.child && k === 'bald') return 'short';
  return k;
}

export class HumanModel extends RiggedModel {
  private readonly material: HumanMaterial;
  private readonly hand: THREE.Bone | null;
  private item: THREE.Mesh | null = null;
  private itemKind = 'none';
  private balloonString: THREE.Mesh | null = null;
  private readonly balloonPos = new THREE.Vector3();
  private readonly itemSeed: number;
  private highlightedHuman = false;

  constructor(asset: HumanAsset, app: HumanAppearance, role: 'guest' | StaffRole, seed: number, detail: 0 | 1 | 2) {
    super(asset, seed, app.female ? 'F' : 'M', app.height / asset.height, role);
    const r = (k: number) => hash1(seed, k);
    const colors: HumanColors = {
      skin: app.skin,
      hair: app.hair,
      shirt: app.shirt,
      pants: app.pants,
      shoes: app.shoes,
      hat: r(1) < 0.5 ? app.shirt : app.pants,
    };
    let cut: HumanCut = {
      sleeve: r(2) < 0.55 ? 0.13 : 0.56,
      pants: r(3) < (app.child ? 0.5 : 0.25) ? 0.34 : 1.1,
      coat: -1,
      inflate: (app.build - 1) * 0.09,
    };
    if (role !== 'guest') {
      Object.assign(colors, STAFF_COLORS[role]);
      cut = { sleeve: role === 'vet' ? 0.56 : 0.15, pants: 1.1, coat: role === 'vet' ? 0.42 : -1, inflate: cut.inflate };
      if (role === 'groundskeeper') cut.sleeve = 0.56;
    }
    const m = asset.human.marks;
    this.material = createHumanMaterial(colors, cut, { collarY: m.collarY, waistY: m.waistY, shoeTop: m.shoeTop, eyeL: [...m.eyeL], mouth: [...m.mouth] }, detail);
    this.mesh.material = this.material;
    this.hand = this.bones[asset.roles.arms.R?.hand ?? -1] ?? null;
    this.itemSeed = Math.floor(r(5) * 1000);
  }

  setHighlighted(on: boolean): void {
    this.highlightedHuman = on;
    this.material.emissive.setRGB(1, 0.85, 0.35);
    this.material.emissiveIntensity = on ? 0.25 : 0;
  }

  update(dt: number, anim: CreatureAnim): void {
    super.update(dt, anim);
    let want = anim.holding ?? 'none';
    if (this.ctx.role === 'groundskeeper' && this.ctx.action === 'work' && want === 'none') want = 'broom';
    if (want !== this.itemKind) this.setItem(want);
    if (this.itemKind === 'balloon') this.updateBalloon(dt);
    if (this.highlightedHuman) this.material.emissiveIntensity = 0.18 + 0.14 * Math.sin(performance.now() * 0.006);
  }

  private setItem(kind: string): void {
    this.removeItem();
    this.itemKind = kind;
    if (kind === 'none' || !this.hand) return;
    const k = kind as ItemKind;
    const mesh = new THREE.Mesh(itemGeometry(k, this.itemSeed), itemMaterial());
    mesh.castShadow = true;
    if (k === 'balloon') {
      this.object.add(mesh);
      const str = new THREE.Mesh(stringGeometry(), itemMaterial());
      this.object.add(str);
      this.balloonString = str;
      this.balloonPos.set(NaN, 0, 0);
    } else {
      // items are authored upright; the carry pose pitches the hand ≈ 80° forward
      const hp = this.asset.rig.rest;
      const hi = this.asset.roles.arms.R!.hand;
      const palm = new THREE.Vector3(0, -0.055 * (hp[hi * 3 + 1] / 0.87), 0.0);
      if (k === 'gift' || k === 'broom') {
        mesh.position.copy(palm);
        if (k === 'broom') mesh.position.y += 0.35;
      } else {
        mesh.position.set(0, -0.06, 0.035);
        mesh.rotation.x = 1.5;
      }
      this.hand.add(mesh);
    }
    this.item = mesh;
  }

  private removeItem(): void {
    this.item?.removeFromParent();
    this.balloonString?.removeFromParent();
    this.item = null;
    this.balloonString = null;
  }

  private static _m = new THREE.Matrix4();
  private static _v = new THREE.Vector3();
  private static _q = new THREE.Quaternion();
  private static _up = new THREE.Vector3(0, 1, 0);

  private updateBalloon(dt: number): void {
    if (!this.item || !this.balloonString || !this.hand) return;
    // hand position in root space (matrices from the last render are fine)
    this.hand.updateWorldMatrix(true, false);
    const m = HumanModel._m.copy(this.object.matrixWorld).invert().multiply(this.hand.matrixWorld);
    const hand = HumanModel._v.setFromMatrixPosition(m);
    hand.y -= 0.05;
    const t = this.ctx.time;
    const target = this.item.position;
    const goalX = hand.x + 0.06 * Math.sin(t * 1.3 + this.itemSeed);
    const goalY = hand.y + 0.75 + 0.03 * Math.sin(t * 2.1);
    const goalZ = hand.z - 0.1 + 0.05 * Math.sin(t * 0.9);
    if (Number.isNaN(this.balloonPos.x)) this.balloonPos.set(goalX, goalY, goalZ);
    const k = 1 - Math.exp(-dt * 4);
    this.balloonPos.x += (goalX - this.balloonPos.x) * k;
    this.balloonPos.y += (goalY - this.balloonPos.y) * k;
    this.balloonPos.z += (goalZ - this.balloonPos.z) * k;
    target.copy(this.balloonPos);
    this.item.rotation.z = (this.balloonPos.x - hand.x) * 0.8;
    // string from the hand to the knot
    const s = this.balloonString;
    s.position.copy(hand);
    const dir = HumanModel._v.set(this.balloonPos.x - hand.x, this.balloonPos.y - 0.18 - hand.y, this.balloonPos.z - hand.z);
    const len = dir.length();
    s.scale.set(1, len, 1);
    s.quaternion.copy(HumanModel._q.setFromUnitVectors(HumanModel._up, dir.divideScalar(len || 1)));
  }

  dispose(): void {
    this.removeItem();
    this.material.dispose();
    super.dispose();
  }
}

export class HumanFactory {
  private readonly assets = new Map<string, HumanAsset>();
  constructor(readonly quality: QualitySettings) {}

  asset(key: HumanBodyKey): HumanAsset {
    const detail = this.quality.creatureDetail;
    const k = `${key.female ? 'F' : 'M'}:${key.child ? 'c' : 'a'}:${key.hair}:${detail}`;
    let a = this.assets.get(k);
    if (!a) {
      a = buildHumanAsset(key, detail);
      this.assets.set(k, a);
    }
    return a;
  }

  create(app: HumanAppearance, role: 'guest' | StaffRole, seed: number): HumanModel {
    const key: HumanBodyKey = { female: app.female, child: app.child, hair: hairKind(app, role) };
    return new HumanModel(this.asset(key), app, role, seed, this.quality.creatureDetail);
  }

  stats(): { key: string; triangles: number; ms: number }[] {
    return [...this.assets.values()].map((a) => ({ key: a.key, triangles: a.triangles, ms: a.buildMs }));
  }
}
