// Human factory: cached skinned meshes per body type (female, child, hair /
// hat) + per-person clothing colours, cut, girth, height and held items.
//
// In the main scene every person is an instance of ONE crowd batch per
// quality tier (all body variants × LOD levels, one multi-draw call; clothing
// and highlight are per-instance texels, see material.ts HUMAN_LOOK_TEXELS),
// and held items are instances of the shared item batch. Elsewhere (UI
// thumbnails) a person renders standalone with its own material and meshes.

import * as THREE from 'three';
import type { QualitySettings } from '../../core/contracts';
import type { HumanAppearance, StaffRole } from '../../core/types';
import { buildGeometry, type SampleImpl, type VertexBaker } from '../build/geometry';
import { resolveRoles } from '../rig/roles';
import { RiggedModel, jointMatrix, type CrowdHost, type RigAsset } from '../model';
import { driver, hash1, unwrapDriver } from '../anim/util';
import { humanDriver } from '../anim/human';
import { humanDesign, type HairKind, type HumanBodyKey, type HumanDesign } from './design';
import {
  HUMAN_BODIES,
  HUMAN_HIGHLIGHT_INDEX,
  HUMAN_LOOK_TEXELS,
  createHumanBatchMaterial,
  createHumanMaterial,
  writeHumanLook,
  type HumanColors,
  type HumanCut,
  type HumanMarks,
  type HumanMaterial,
} from './material';
import { isItemKind, itemGeometry, itemMaterial, itemVariants, stringGeometry, type ItemKind } from './items';
import type { CreatureDesign } from '../types';
import type { BatchSpec, BatchedModel, CrowdRenderer } from '../crowd/crowd';
import { LodChain } from '../lod/lod';

/** Human mesh resolution: cells along the height for detail 0/1/2. */
const HUMAN_CELLS: readonly number[] = [22, 27, 36];

export interface HumanAsset extends RigAsset {
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
  const sphere = new THREE.Sphere(center, Math.max(size.y, size.x, size.z) * 0.6 + 0.2);
  const asset: HumanAsset = {
    key: `human:${key.female ? 'F' : 'M'}:${key.child ? 'c' : 'a'}:${key.hair}:${detail}`,
    geometry: built.geometry,
    rig: built.rig,
    roles: resolveRoles(built.rig, hd.roles),
    design,
    driver: unwrapDriver(design.anim),
    material: dummy,
    highlightMaterial: dummy,
    sphere,
    height: hd.height,
    radius: 0.28 * (key.child ? 0.75 : 1),
    triangles: built.triangles,
    buildMs: built.ms,
    human: hd,
    detail,
  };
  asset.lod = new LodChain(built.geometry, sphere, built.triangles);
  return asset;
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

function marksOf(d: HumanDesign): HumanMarks {
  const m = d.marks;
  return { collarY: m.collarY, waistY: m.waistY, shoeTop: m.shoeTop, eyeL: [...m.eyeL], mouth: [...m.mouth] };
}

/** Body id used by the batched material: female + 2 × child. */
function bodyIndex(female: boolean, child: boolean): number {
  return (female ? 1 : 0) + (child ? 2 : 0);
}

// scratch (allocation-free per frame)
const _hand = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

export class HumanModel extends RiggedModel implements BatchedModel {
  private readonly colors: HumanColors;
  private readonly cut: HumanCut;
  private readonly body: number;
  private readonly detail: 0 | 1 | 2;
  private readonly crowd: CrowdRenderer | null;
  private readonly handIdx: number;
  private readonly palmY: number;
  private readonly itemSeed: number;
  private itemKind = 'none';
  /** Hand joint transform in model space (valid after an update). */
  private readonly handM = new THREE.Matrix4();
  private readonly balloonPos = new THREE.Vector3(NaN, 0, 0);
  private balloonTilt = 0;
  private readonly stringPos = new THREE.Vector3();
  private readonly stringQuat = new THREE.Quaternion();
  private stringLen = 0.7;
  // batched items
  private itemSlot = -1;
  private itemGeo = -1;
  private stringSlot = -1;
  // standalone
  private material: HumanMaterial | null = null;
  private itemMesh: THREE.Mesh | null = null;
  private stringMesh: THREE.Mesh | null = null;

  constructor(asset: HumanAsset, app: HumanAppearance, role: 'guest' | StaffRole, seed: number, detail: 0 | 1 | 2, crowd: CrowdRenderer | null) {
    super(asset, seed, app.female ? 'F' : 'M', app.height / asset.height, role, crowd as CrowdHost | null);
    this.needsJoints = true;
    this.crowd = crowd;
    this.detail = detail;
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
    this.colors = colors;
    this.cut = cut;
    this.body = bodyIndex(app.female, app.child);
    this.handIdx = asset.roles.arms.R?.hand ?? -1;
    const hp = asset.rig.rest;
    this.palmY = this.handIdx >= 0 ? -0.055 * (hp[this.handIdx * 3 + 1] / 0.87) : -0.05;
    this.itemSeed = Math.floor(r(5) * 1000);
  }

  // ---------------------------------------------------------------- batching
  batchSpec(): BatchSpec {
    const detail = this.detail;
    return {
      key: `human:${detail}`,
      bones: this.asset.rig.count,
      look: HUMAN_LOOK_TEXELS,
      make: () => createHumanBatchMaterial(detail, HUMAN_BODY_MARKS()),
    };
  }

  writeLook(): void {
    const b = this.batch;
    if (!b) return;
    writeHumanLook(b.data, b.offset(this.slot), this.colors, this.cut, this.body, this.highlighted ? 0.25 : 0);
  }

  syncFrame(world: THREE.Matrix4, visible: boolean): void {
    const b = this.batch;
    if (!b) return;
    if (this.highlighted) b.data[b.offset(this.slot) + HUMAN_HIGHLIGHT_INDEX] = 0.18 + 0.14 * Math.sin(performance.now() * 0.006);
    const crowd = this.crowd;
    if (!crowd) return;
    const kind = this.itemKind;
    if (kind === 'none' || !isItemKind(kind) || this.handIdx < 0) {
      this.releaseExtras(crowd);
      return;
    }
    const items = crowd.items();
    // geometry for the item (+ string)
    if (this.itemGeo < 0) {
      const v = this.itemSeed % itemVariants(kind);
      this.itemGeo = items.addKeyedGeometry(`${kind}:${v}`, itemGeometry(kind, this.itemSeed));
    }
    if (this.itemSlot < 0) this.itemSlot = items.addSlot(this.itemGeo);
    else items.setGeometry(this.itemSlot, this.itemGeo);
    const balloon = kind === 'balloon';
    if (balloon && this.stringSlot < 0) this.stringSlot = items.addSlot(items.addKeyedGeometry('string', stringGeometry()));
    if (!balloon && this.stringSlot >= 0) {
      items.removeSlot(this.stringSlot);
      this.stringSlot = -1;
    }
    items.setVisible(this.itemSlot, visible);
    if (this.stringSlot >= 0) items.setVisible(this.stringSlot, visible);
    if (!visible) return;
    const shadow = this.shadowOn;
    items.setCastShadow(this.itemSlot, shadow);
    if (balloon) {
      _local.compose(this.balloonPos, _q.setFromEuler(_e.set(0, 0, this.balloonTilt)), _one);
      items.setMatrixAt(this.itemSlot, _m.multiplyMatrices(world, _local));
      _local.compose(this.stringPos, this.stringQuat, _v.set(1, this.stringLen, 1));
      items.setMatrixAt(this.stringSlot, _m.multiplyMatrices(world, _local));
      items.setCastShadow(this.stringSlot, shadow);
    } else {
      itemLocal(kind, this.palmY, _local);
      _hand.multiplyMatrices(this.handM, _local);
      items.setMatrixAt(this.itemSlot, _m.multiplyMatrices(world, _hand));
    }
    _v.setFromMatrixPosition(world);
    items.includeBounds(_v, balloon ? 3 : 2.2, shadow);
  }

  releaseExtras(crowd: CrowdRenderer): void {
    if (this.itemSlot < 0 && this.stringSlot < 0) return;
    const items = crowd.items();
    if (this.itemSlot >= 0) items.removeSlot(this.itemSlot);
    if (this.stringSlot >= 0) items.removeSlot(this.stringSlot);
    this.itemSlot = -1;
    this.stringSlot = -1;
    this.itemGeo = -1;
  }

  // ---------------------------------------------------------------- highlight
  /** Standalone: keep the person's own material, glow through its emissive term. */
  protected applyStandaloneHighlight(_mesh: THREE.SkinnedMesh, on: boolean): void {
    if (this.material) {
      this.material.emissive.setRGB(1, 0.85, 0.35);
      this.material.emissiveIntensity = on ? 0.25 : 0;
    }
  }

  // ---------------------------------------------------------------- animation hooks
  protected afterPose(dt: number): void {
    let want = this.ctx.holding ?? 'none';
    if (this.ctx.role === 'groundskeeper' && this.ctx.action === 'work' && want === 'none') want = 'broom';
    if (!isItemKind(want)) want = 'none';
    if (want !== this.itemKind) this.setItem(want);
    if (this.handIdx >= 0) jointMatrix(this.handIdx, this.handM);
    if (this.itemKind === 'balloon') this.updateBalloon(dt);
    if (this.highlighted && this.material) this.material.emissiveIntensity = 0.18 + 0.14 * Math.sin(performance.now() * 0.006);
  }

  private setItem(kind: string): void {
    this.itemKind = kind;
    this.itemGeo = -1;
    this.balloonPos.set(NaN, 0, 0);
    if (this.hasStandalone) this.attachStandaloneItem();
  }

  private updateBalloon(dt: number): void {
    // hand position in model space (current pose)
    const hand = _v.setFromMatrixPosition(this.handM);
    hand.y -= 0.05;
    const t = this.ctx.time;
    const goalX = hand.x + 0.06 * Math.sin(t * 1.3 + this.itemSeed);
    const goalY = hand.y + 0.75 + 0.03 * Math.sin(t * 2.1);
    const goalZ = hand.z - 0.1 + 0.05 * Math.sin(t * 0.9);
    const bp = this.balloonPos;
    if (Number.isNaN(bp.x)) bp.set(goalX, goalY, goalZ);
    const k = 1 - Math.exp(-dt * 4);
    bp.x += (goalX - bp.x) * k;
    bp.y += (goalY - bp.y) * k;
    bp.z += (goalZ - bp.z) * k;
    this.balloonTilt = (bp.x - hand.x) * 0.8;
    // string from the hand to the knot
    this.stringPos.copy(hand);
    const dx = bp.x - hand.x, dy = bp.y - 0.18 - hand.y, dz = bp.z - hand.z;
    const len = Math.hypot(dx, dy, dz) || 1e-3;
    this.stringLen = len;
    this.stringQuat.setFromUnitVectors(_up, _v.set(dx / len, dy / len, dz / len));
    if (this.itemMesh && this.stringMesh) {
      this.itemMesh.position.copy(bp);
      this.itemMesh.rotation.set(0, 0, this.balloonTilt);
      this.stringMesh.position.copy(this.stringPos);
      this.stringMesh.quaternion.copy(this.stringQuat);
      this.stringMesh.scale.set(1, len, 1);
    }
  }

  // ---------------------------------------------------------------- standalone
  protected createStandaloneMaterial(): THREE.Material {
    if (!this.material) {
      const a = this.asset as HumanAsset;
      this.material = createHumanMaterial(this.colors, this.cut, marksOf(a.human), this.detail);
      this.material.emissive.setRGB(1, 0.85, 0.35);
      this.material.emissiveIntensity = this.highlighted ? 0.25 : 0;
    }
    return this.material;
  }

  protected onStandaloneCreated(): void {
    this.attachStandaloneItem();
  }

  protected onStandaloneDisposed(): void {
    this.removeStandaloneItem();
    this.material?.dispose();
    this.material = null;
  }

  private attachStandaloneItem(): void {
    this.removeStandaloneItem();
    const kind = this.itemKind;
    const hand = this.standaloneBone(this.handIdx);
    if (!isItemKind(kind) || !hand) return;
    const mesh = new THREE.Mesh(itemGeometry(kind, this.itemSeed), itemMaterial());
    mesh.castShadow = true;
    if (kind === 'balloon') {
      this.object.add(mesh);
      const str = new THREE.Mesh(stringGeometry(), itemMaterial());
      this.object.add(str);
      this.stringMesh = str;
    } else {
      itemLocal(kind, this.palmY, _local);
      _local.decompose(mesh.position, mesh.quaternion, mesh.scale);
      hand.add(mesh);
    }
    this.itemMesh = mesh;
  }

  private removeStandaloneItem(): void {
    this.itemMesh?.removeFromParent();
    this.stringMesh?.removeFromParent();
    this.itemMesh = null;
    this.stringMesh = null;
  }

  dispose(): void {
    super.dispose();
  }
}

/** Item transform relative to the hand joint (items are authored upright; carrying pitches the hand ≈ 80°). */
function itemLocal(kind: ItemKind, palmY: number, out: THREE.Matrix4): THREE.Matrix4 {
  if (kind === 'gift' || kind === 'broom') return out.makeTranslation(0, palmY + (kind === 'broom' ? 0.35 : 0), 0);
  return out.makeRotationX(1.5).setPosition(0, -0.06, 0.035);
}

let bodyMarks: HumanMarks[] | null = null;
/** Face / collar landmarks of the 4 body types (index = female + 2 × child). */
function HUMAN_BODY_MARKS(): HumanMarks[] {
  if (!bodyMarks) {
    bodyMarks = [];
    for (let i = 0; i < HUMAN_BODIES; i++) bodyMarks.push(marksOf(humanDesign({ female: (i & 1) === 1, child: (i & 2) === 2, hair: 'bald' })));
  }
  return bodyMarks;
}

export class HumanFactory {
  private readonly assets = new Map<string, HumanAsset>();
  quality: QualitySettings;
  constructor(quality: QualitySettings, private readonly crowd: CrowdRenderer | null = null) {
    this.quality = quality;
  }

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
    return new HumanModel(this.asset(key), app, role, seed, this.quality.creatureDetail, this.crowd);
  }

  stats(): { key: string; triangles: number; ms: number }[] {
    return [...this.assets.values()].map((a) => ({ key: a.key, triangles: a.triangles, ms: a.buildMs }));
  }

  lodStats(): { key: string; triangles: number[] }[] {
    return [...this.assets.values()].map((a) => ({ key: a.key, triangles: a.lod?.triangles ?? [] }));
  }
}
