// Shared skinned-model runtime used by animals and humans: runs the animation
// driver with crossfades and turns the pose into skin matrices.
//
// A model renders in one of two ways:
//   * batched (the normal case): its object lives in the scene the creature
//     factory renders into (the factory root's scene). `object` is then a plain
//     Group without meshes; the pose is written as bone matrices into the
//     instance block of a SkinnedBatch (see crowd/), and the crowd renderer
//     reads `object`'s world matrix / visibility every frame, picks the LOD
//     and decides shadow casting.
//   * standalone: when the object is used anywhere else (UI thumbnails, a
//     scene without the factory root) a classic THREE.SkinnedMesh with a bone
//     hierarchy is built lazily under `object`.
// The model switches automatically when its object is (re)parented.
//
// A model can change its mesh at runtime (setAsset): the factory re-picks the
// asset after a quality-tier change and when a young male of a dimorphic
// species grows into its adult (male) mesh.

import * as THREE from 'three';
import type { CreatureAnim, CreatureModel } from '../core/contracts';
import { Pose, RigDef, RigRuntime, blendPoses } from './rig/rig';
import type { AnimCtx, AnimDriver, CreatureDesign, ResolvedRoles } from './types';
import { clamp01, damp, lerp, smooth } from './anim/util';
import type { LodChain } from './lod/lod';
import type { SkinnedBatch } from './crowd/batch';

/** Everything shared between instances of one cached mesh variant. */
export interface RigAsset {
  key: string;
  geometry: THREE.BufferGeometry;
  rig: RigDef;
  roles: ResolvedRoles;
  design: CreatureDesign;
  driver: AnimDriver<unknown>;
  material: THREE.Material;
  highlightMaterial: THREE.Material;
  /** Bounding sphere (mesh space) generous enough for every pose. */
  sphere: THREE.Sphere;
  height: number;
  radius: number;
  triangles: number;
  buildMs: number;
  /** LOD levels (level 0 = geometry); created by the factory. */
  lod?: LodChain;
  /** Quality detail the asset was built for. */
  detail?: 0 | 1 | 2;
  /** Level 0 carries a fur shell (its materials compile the shell's lift and discard). */
  furShell?: boolean;
}

/**
 * What a model needs from the crowd renderer (implemented by
 * crowd/crowd.ts CrowdRenderer). Kept as an interface so models stay usable
 * without one (tests, standalone use).
 */
export interface CrowdHost {
  /** A model was created with this host (it stays registered until release). */
  register(model: RiggedModel): void;
  /** The model's object was added to / removed from a parent, or its asset changed. */
  parentChanged(model: RiggedModel): void;
  /** The model is about to change its asset: take it out of its batch (parentChanged follows). */
  unbatch(model: RiggedModel): void;
  /** The model is being disposed. */
  release(model: RiggedModel): void;
}

/** Picks a model's mesh for its growth under the current quality tier (owned by the factory). */
export type AssetPicker = (growth: number) => RigAsset;

interface Slot {
  action: string;
  w: number;
  pose: Pose;
  /** Crossfade time (s) of the transition into this slot. */
  fade: number;
}

const MAX_SLOTS = 3;
const _weights: number[] = [0, 0, 0];
const _poses: Pose[] = [];

/**
 * Crossfade time into `to` coming from `from`: driver.transitions
 * ('from>to', 'from>*', '*>to'), then driver.fades[to], then driver.fade.
 */
export function transitionFade(d: AnimDriver<unknown>, from: string, to: string): number {
  const t = d.transitions;
  if (t && from) {
    const v = t[from + '>' + to] ?? t[from + '>*'] ?? t['*>' + to];
    if (v !== undefined) return v;
  } else if (t && t['*>' + to] !== undefined) return t['*>' + to];
  return d.fades?.[to] ?? d.fade ?? 0.4;
}

// ---------------------------------------------------------------------------
// Skin matrices (allocation-free FK)

/** Model-space joint rotation (4), position (3) and scale (1) per bone after skinMatrices(). */
export const FK = {
  wq: new Float32Array(4 * 64),
  wp: new Float32Array(3 * 64),
  ws: new Float32Array(64),
};

function ensureFK(n: number): void {
  if (FK.ws.length >= n) return;
  FK.wq = new Float32Array(4 * n);
  FK.wp = new Float32Array(3 * n);
  FK.ws = new Float32Array(n);
}

/**
 * Forward kinematics + inverse bind for every bone: writes one affine 3×4
 * matrix (3 rows × vec4) per bone at `out[off + bone * 12]`, mapping rest-pose
 * model-space vertices to posed model space — exactly what THREE.SkinnedMesh
 * computes from a Bone hierarchy (bone.matrixWorld × inverse(rest translation)).
 * `boneScale` (optional, per bone) multiplies the pose scale — the juvenile
 * head and growing features (see RiggedModel.growthScales). Leaves the joint
 * transforms in FK.wq / wp / ws.
 */
export function skinMatrices(rig: RigDef, pose: Pose, boneScale: ArrayLike<number> | null, out: Float32Array, off: number): void {
  const n = rig.count;
  ensureFK(n);
  const wq = FK.wq, wp = FK.wp, ws = FK.ws;
  const offset = rig.offset, rest = rig.rest, parent = rig.parent;
  for (let i = 0; i < n; i++) {
    const q = pose.q[i];
    const pp = pose.p[i];
    const s = boneScale ? pose.s[i] * boneScale[i] : pose.s[i];
    const lx = offset[i * 3] + pp.x, ly = offset[i * 3 + 1] + pp.y, lz = offset[i * 3 + 2] + pp.z;
    const pi = parent[i];
    let qx: number, qy: number, qz: number, qw: number, px: number, py: number, pz: number, sc: number;
    if (pi < 0) {
      qx = q.x; qy = q.y; qz = q.z; qw = q.w;
      px = lx; py = ly; pz = lz;
      sc = s;
    } else {
      const ax = wq[pi * 4], ay = wq[pi * 4 + 1], az = wq[pi * 4 + 2], aw = wq[pi * 4 + 3];
      const ps = ws[pi];
      // rotate (lx,ly,lz) * ps by the parent quaternion
      const vx = lx * ps, vy = ly * ps, vz = lz * ps;
      const tx = 2 * (ay * vz - az * vy), ty = 2 * (az * vx - ax * vz), tz = 2 * (ax * vy - ay * vx);
      px = wp[pi * 3] + vx + aw * tx + (ay * tz - az * ty);
      py = wp[pi * 3 + 1] + vy + aw * ty + (az * tx - ax * tz);
      pz = wp[pi * 3 + 2] + vz + aw * tz + (ax * ty - ay * tx);
      // parent × local
      qx = aw * q.x + ax * q.w + ay * q.z - az * q.y;
      qy = aw * q.y - ax * q.z + ay * q.w + az * q.x;
      qz = aw * q.z + ax * q.y - ay * q.x + az * q.w;
      qw = aw * q.w - ax * q.x - ay * q.y - az * q.z;
      sc = ps * s;
    }
    wq[i * 4] = qx; wq[i * 4 + 1] = qy; wq[i * 4 + 2] = qz; wq[i * 4 + 3] = qw;
    wp[i * 3] = px; wp[i * 3 + 1] = py; wp[i * 3 + 2] = pz;
    ws[i] = sc;
    // rotation matrix × scale
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;
    const m00 = (1 - (yy + zz)) * sc, m01 = (xy - wz) * sc, m02 = (xz + wy) * sc;
    const m10 = (xy + wz) * sc, m11 = (1 - (xx + zz)) * sc, m12 = (yz - wx) * sc;
    const m20 = (xz - wy) * sc, m21 = (yz + wx) * sc, m22 = (1 - (xx + yy)) * sc;
    const rx = rest[i * 3], ry = rest[i * 3 + 1], rz = rest[i * 3 + 2];
    const o = off + i * 12;
    out[o] = m00; out[o + 1] = m01; out[o + 2] = m02; out[o + 3] = px - (m00 * rx + m01 * ry + m02 * rz);
    out[o + 4] = m10; out[o + 5] = m11; out[o + 6] = m12; out[o + 7] = py - (m10 * rx + m11 * ry + m12 * rz);
    out[o + 8] = m20; out[o + 9] = m21; out[o + 10] = m22; out[o + 11] = pz - (m20 * rx + m21 * ry + m22 * rz);
  }
}

/** Joint transform (model space, no inverse bind) of a bone after skinMatrices(), as a Matrix4. */
export function jointMatrix(bone: number, out: THREE.Matrix4): THREE.Matrix4 {
  const q = FK.wq, p = FK.wp;
  _q.set(q[bone * 4], q[bone * 4 + 1], q[bone * 4 + 2], q[bone * 4 + 3]);
  _p.set(p[bone * 3], p[bone * 3 + 1], p[bone * 3 + 2]);
  const s = FK.ws[bone];
  _s.set(s, s, s);
  return out.compose(_p, _q, _s);
}
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
let _skinScratch = new Float32Array(12 * 64);
function _scratch(bones: number): Float32Array {
  if (_skinScratch.length < bones * 12) _skinScratch = new Float32Array(bones * 12);
  return _skinScratch;
}

// ---------------------------------------------------------------------------

interface Standalone {
  mesh: THREE.SkinnedMesh;
  bones: THREE.Bone[];
  skeleton: THREE.Skeleton;
}

/** Same skeleton layout (bone count and rest offsets): poses and driver state carry over. */
function sameRig(a: RigDef, b: RigDef): boolean {
  if (a === b) return true;
  if (a.count !== b.count) return false;
  for (let i = 0; i < a.offset.length; i++) if (Math.abs(a.offset[i] - b.offset[i]) > 1e-6) return false;
  return true;
}

/** Growth (0..1) over which babyBones ease from their newborn scale to 1. */
/** Seconds a coat takes to dry after a swim (thick skins and swimming fur animals show it, see animalMaterial). */
export const DRY_SECONDS = 90;

/** Wetness 0..1 after `dt` seconds: soaked while swimming, drying linearly afterwards. */
export function nextWetness(wet: number, swimming: boolean, dt: number): number {
  return swimming ? 1 : Math.max(0, wet - dt / DRY_SECONDS);
}

const BABY_BONES_FROM = 0.15;
const BABY_BONES_TO = 0.95;
/** Hips + chest height (fraction of standing) at which an animal counts as fully lying / not lying at all. */
const LIE_FULL = 0.45;
const LIE_NONE = 0.75;

type MutableCtx = { -readonly [K in keyof AnimCtx]: AnimCtx[K] };

/**
 * Selection highlight amount: breathes between 0.16 and 0.32 (full rim from
 * ~0.31, see HIGHLIGHT_FN_GLSL) without fading out, so the rim reads at any moment.
 */
export function highlightPulse(): number {
  return 0.24 + 0.08 * Math.sin(performance.now() * 0.006);
}

export class RiggedModel implements CreatureModel {
  readonly object = new THREE.Group();
  private _asset!: RigAsset;
  protected rt!: RigRuntime;
  protected ctx!: MutableCtx;
  private state: unknown;
  private readonly slots: Slot[] = [];
  private readonly spare: Pose[] = [];
  protected out!: Pose;
  /** Bone indices and newborn scales of design.babyBones (resolved per asset). */
  private babyBones: { bone: number; scale: number }[] = [];
  protected baseScale = 1;
  protected growth = 1;
  /** 1 right after a swim, drying to 0 (look texel z of animals). */
  private wetness = 0;
  /** 0 standing … 1 lying, from how low hips and chest sit (look texel w; species with look.lieShade). */
  private lying = 0;
  private lastYaw = NaN;
  protected highlighted = false;
  protected readonly host: CrowdHost | null;
  private readonly picker: AssetPicker | null;
  private disposed = false;

  // ---- batched state (managed by the crowd renderer)
  batch: SkinnedBatch | null = null;
  slot = -1;
  /** Current LOD level (-1 = not chosen yet). */
  lod = -1;
  /** Casts a shadow this frame. */
  shadowOn = false;
  /** Batch geometry id per LOD level (-1 = not added yet), valid while batched. */
  readonly geoIds = new Int32Array(4).fill(-1);

  // ---- standalone state
  private sa: Standalone | null = null;

  /**
   * `picker` (optional) chooses the mesh for a growth under the current
   * quality tier; the model re-picks when its growth changes and on
   * refreshAsset(). Without one the model keeps `asset`.
   */
  constructor(asset: RigAsset, seed: number, sex: 'M' | 'F', baseScale: number, role = '', host: CrowdHost | null = null, picker: AssetPicker | null = null) {
    this.host = host;
    this.picker = picker;
    const rand = ((seed * 2654435761) >>> 0) / 4294967296;
    this.bind(asset, { time: rand * 100, seed: seed | 0, rand, sex, role });
    this.baseScale = baseScale;
    this.applyGrowth();
    if (host) {
      host.register(this);
      const onParent = () => {
        if (!this.disposed) host.parentChanged(this);
      };
      this.object.addEventListener('added', onParent);
      this.object.addEventListener('removed', onParent);
    }
  }

  /** The cached mesh variant this model currently draws (changes with setAsset). */
  get asset(): RigAsset {
    return this._asset;
  }

  /**
   * Point the model at an asset: rig runtime, animation context and driver
   * state. Between rigs of the same layout (another quality tier of the same
   * mesh) everything carries over; otherwise the driver restarts from its
   * current action, keeping the last pose when the bone count matches.
   */
  private bind(asset: RigAsset, init?: Pick<AnimCtx, 'time' | 'seed' | 'rand' | 'sex' | 'role'>): void {
    const prev = this._asset as RigAsset | undefined;
    this._asset = asset;
    this.object.name = asset.key;
    this.babyBones = Object.entries(asset.design.babyBones ?? {})
      .map(([name, scale]) => ({ bone: asset.rig.find(name), scale }))
      .filter((b) => b.bone >= 0);
    if (prev && sameRig(prev.rig, asset.rig)) {
      this.ctx.design = asset.design;
      return;
    }
    const lastPose = this.out;
    this.rt = new RigRuntime(asset.rig);
    this.out = new Pose(asset.rig.count);
    if (lastPose && lastPose.q.length === asset.rig.count) this.out.copy(lastPose);
    // instance identity and the animation inputs carry over from the previous context
    const c: Partial<AnimCtx> & Pick<AnimCtx, 'time' | 'seed' | 'rand' | 'sex' | 'role'> = this.ctx ?? init!;
    this.ctx = {
      rig: this.rt,
      def: asset.rig,
      roles: asset.roles,
      design: asset.design,
      time: c.time,
      dt: 0,
      speed: c.speed ?? 0,
      actionTime: c.actionTime ?? 0,
      swimming: c.swimming ?? false,
      holding: c.holding ?? 'none',
      turnRate: c.turnRate ?? 0,
      seed: c.seed,
      rand: c.rand,
      sex: c.sex,
      growth: this.growth,
      role: c.role,
      action: c.action ?? 'idle',
    };
    // crossfade slots hold poses of the old bone layout
    this.slots.length = 0;
    this.spare.length = 0;
    this.state = asset.driver.init(this.ctx);
  }

  /**
   * Draw another mesh variant from now on (quality tier change, a young male
   * growing into the adult mesh). Leaves its batch and re-enters the batch of
   * the new mesh (or rebuilds the standalone mesh).
   */
  setAsset(asset: RigAsset): void {
    if (asset === this._asset || this.disposed) return;
    this.host?.unbatch(this);
    const hadStandalone = this.sa !== null;
    this.disposeStandalone();
    this.bind(asset);
    this.applyGrowth();
    if (this.host) this.host.parentChanged(this);
    else if (hadStandalone) this.applyStandalone();
  }

  /** Re-pick the mesh for the current quality tier and growth (after a tier change). */
  refreshAsset(): void {
    if (this.picker) this.setAsset(this.picker(this.growth));
  }

  get height(): number {
    return this.asset.height * this.object.scale.y;
  }

  get radius(): number {
    return this.asset.radius * this.object.scale.y;
  }

  /** Normalising size for LOD distances (1 ≈ a 1.8 m person). */
  get sizeFactor(): number {
    return Math.max(0.6, Math.max(this.height, this.radius * 2) / 1.8);
  }

  /** World-space culling radius around the object origin. */
  get cullRadius(): number {
    const s = this.asset.sphere;
    return (s.radius + s.center.length()) * this.object.scale.y;
  }

  get isBatched(): boolean {
    return this.batch !== null;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  setGrowth(growth: number): void {
    this.growth = clamp01(growth);
    const want = this.picker?.(this.growth);
    if (want && want !== this._asset) this.setAsset(want);
    else this.applyGrowth();
  }

  /**
   * Per-bone juvenile scale (head, legs, growing tusks / horns …), from
   * design.babyHead / babyLegs / babyBones. Shared with the rig runtime so the
   * driver's IK works with the proportions that are drawn.
   */
  private get boneScale(): Float32Array {
    return this.rt.boneScale;
  }

  /** Root scale, juvenile bone scales and the batched look for the current growth. */
  private applyGrowth(): void {
    const d = this.asset.design;
    const roles = this.asset.roles;
    this.object.scale.setScalar(this.baseScale * lerp(d.babyScale ?? 0.4, 1, this.growth));
    this.ctx.growth = this.growth;
    const bs = this.boneScale;
    bs.fill(1);
    if (roles.head >= 0) bs[roles.head] = lerp(d.babyHead ?? 1.3, 1, this.growth);
    const legScale = lerp(d.babyLegs ?? 1, 1, this.growth);
    for (const leg of Object.values(roles.legs)) if (leg) bs[leg.lower] *= legScale;
    const k = smooth(BABY_BONES_FROM, BABY_BONES_TO, this.growth);
    for (const b of this.babyBones) bs[b.bone] *= lerp(b.scale, 1, k);
    if (this.batch) {
      this.writeLook();
      this.writeSkin();
    }
  }

  setHighlighted(on: boolean): void {
    this.highlighted = on;
    if (this.batch) this.writeLook();
    if (this.sa) this.applyStandaloneHighlight(this.sa.mesh, on);
  }

  /** Standalone highlight: animals swap to the asset's highlight material (humans override). */
  protected applyStandaloneHighlight(mesh: THREE.SkinnedMesh, on: boolean): void {
    mesh.material = on ? this.asset.highlightMaterial : this.asset.material;
  }

  get isHighlighted(): boolean {
    return this.highlighted;
  }

  private resolveAction(name: string): string {
    const d = this.asset.driver;
    for (let i = 0; i < 4 && !d.actions[name] && d.aliases?.[name] !== undefined; i++) name = d.aliases[name];
    if (!d.actions[name]) {
      name = d.fallback ?? 'idle';
      if (!d.actions[name]) name = Object.keys(d.actions)[0];
    }
    return name;
  }

  update(dt: number, anim: CreatureAnim): void {
    if (this.disposed) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    const ctx = this.ctx;
    const d = this.asset.driver;
    const scale = this.object.scale.y || 1;
    ctx.dt = dt;
    ctx.time += dt;
    ctx.speed = (anim.speed || 0) / scale;
    ctx.actionTime = anim.actionTime ?? 0;
    ctx.swimming = !!anim.swimming;
    ctx.holding = anim.holding ?? 'none';
    const wet = nextWetness(this.wetness, ctx.swimming, dt);
    if (wet !== this.wetness) {
      this.wetness = wet;
      this.writeLook();
    }
    // turn rate from the root's yaw
    const yaw = this.object.rotation.y;
    if (dt > 0 && !Number.isNaN(this.lastYaw)) {
      let dy = yaw - this.lastYaw;
      dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
      ctx.turnRate += (dy / dt - ctx.turnRate) * damp(0.15, dt);
    }
    this.lastYaw = yaw;

    const action = this.resolveAction(anim.swimming && d.actions.swim ? 'swim' : anim.action);
    ctx.action = action;
    // crossfade slots
    const top = this.slots[this.slots.length - 1];
    if (!top || top.action !== action) {
      if (this.slots.length >= MAX_SLOTS) {
        // drop the weakest
        let wi = 0;
        for (let i = 1; i < this.slots.length; i++) if (this.slots[i].w < this.slots[wi].w) wi = i;
        this.spare.push(this.slots[wi].pose);
        this.slots.splice(wi, 1);
      }
      const fade = transitionFade(d, top ? top.action : '', action);
      this.slots.push({ action, w: this.slots.length ? 0 : 1, pose: this.spare.pop() ?? new Pose(this.asset.rig.count), fade });
    }
    const step = dt / Math.max(0.05, this.slots[this.slots.length - 1].fade);
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const s = this.slots[i];
      if (i === this.slots.length - 1) s.w = Math.min(1, s.w + step);
      else {
        s.w -= step;
        if (s.w <= 0) {
          this.spare.push(s.pose);
          this.slots.splice(i, 1);
        }
      }
    }
    d.pre?.(ctx, this.state);
    let sum = 0;
    for (const s of this.slots) sum += s.w;
    _poses.length = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      s.pose.reset();
      d.actions[s.action](ctx, this.state, s.pose);
      _poses.push(s.pose);
      _weights[i] = sum > 0 ? s.w / sum : 1 / this.slots.length;
    }
    if (this.slots.length === 1) this.out.copy(this.slots[0].pose);
    else blendPoses(this.out, _poses, _weights, this.slots.length);
    d.post?.(ctx, this.state, this.out);
    if (this.batch) {
      this.writeSkin();
      if (this.asset.design.look.lieShade) this.updateLying();
    } else {
      this.applyStandalone();
      if (this.needsJoints) skinMatrices(this.asset.rig, this.out, this.boneScale, _scratch(this.asset.rig.count), 0);
    }
    this.afterPose(dt);
  }

  /** Subclasses that read joint transforms (FK.*) in afterPose set this. */
  protected needsJoints = false;

  /** Hook after the pose is final and FK.* holds the joints when `needsJoints` (humans: items). */
  protected afterPose(_dt: number): void {}

  /** Write the current pose into the batch (FK + inverse bind per bone). */
  protected writeSkin(): void {
    const b = this.batch;
    if (!b) return;
    skinMatrices(this.asset.rig, this.out, this.boneScale, b.data, b.boneOffset(this.slot));
    this.afterSkin();
  }

  /** Hook after skinMatrices into the batch (FK.* holds the joints). */
  protected afterSkin(): void {}

  /**
   * Lying amount from the pose just skinned (FK holds it): 1 once hips and
   * chest sit below LIE_FULL of their standing height, 0 above LIE_NONE, so it
   * follows the lie-down / get-up sequence rather than the action crossfade.
   */
  private updateLying(): void {
    const roles = this.asset.roles;
    const rest = this.asset.rig.rest;
    const hips = roles.root;
    const chest = roles.chest >= 0 ? roles.chest : hips;
    const ratio = (FK.wp[hips * 3 + 1] + FK.wp[chest * 3 + 1]) / Math.max(1e-3, rest[hips * 3 + 1] + rest[chest * 3 + 1]);
    const lying = 1 - smooth(LIE_FULL, LIE_NONE, ratio);
    if (Math.abs(lying - this.lying) < 0.02 && (lying === 0) === (this.lying === 0)) return;
    this.lying = lying;
    this.writeLook();
  }

  /** Write the per-instance look block (animals: highlight, growth, wetness, lying). */
  writeLook(): void {
    const b = this.batch;
    if (!b) return;
    const o = b.offset(this.slot);
    b.data[o] = this.highlighted ? 0.25 : 0;
    b.data[o + 1] = this.growth;
    b.data[o + 2] = this.wetness;
    b.data[o + 3] = this.lying;
  }

  /** Per-frame batched work after the crowd placed the instance (highlight pulse …). */
  syncFrame(_world: THREE.Matrix4, _visible: boolean): void {
    if (this.highlighted && this.batch) this.batch.data[this.batch.offset(this.slot)] = highlightPulse();
  }

  // ---------------------------------------------------------------- batching transitions
  /** Called by the crowd renderer after it allocated `slot` in `batch`. */
  enterBatch(batch: SkinnedBatch, slot: number): void {
    this.disposeStandalone();
    this.batch = batch;
    this.slot = slot;
    this.lod = -1;
    this.geoIds.fill(-1);
    this.writeLook();
    this.writeSkin();
  }

  /** Called by the crowd renderer after it freed the slot. */
  leaveBatch(): void {
    this.batch = null;
    this.slot = -1;
    this.lod = -1;
    this.geoIds.fill(-1);
  }

  // ---------------------------------------------------------------- standalone mesh
  protected createStandaloneMaterial(): THREE.Material {
    return this.highlighted ? this.asset.highlightMaterial : this.asset.material;
  }

  protected ensureStandalone(): Standalone {
    if (this.sa) return this.sa;
    const asset = this.asset;
    const rig = asset.rig;
    const bones = rig.names.map((n) => {
      const b = new THREE.Bone();
      b.name = n;
      return b;
    });
    const inverses: THREE.Matrix4[] = [];
    for (let i = 0; i < rig.count; i++) {
      const b = bones[i];
      b.position.set(rig.offset[i * 3], rig.offset[i * 3 + 1], rig.offset[i * 3 + 2]);
      const p = rig.parent[i];
      if (p >= 0) bones[p].add(b);
      inverses.push(new THREE.Matrix4().makeTranslation(-rig.rest[i * 3], -rig.rest[i * 3 + 1], -rig.rest[i * 3 + 2]));
    }
    const mesh = new THREE.SkinnedMesh(asset.geometry, this.createStandaloneMaterial());
    for (let i = 0; i < rig.count; i++) if (rig.parent[i] < 0) mesh.add(bones[i]);
    const skeleton = new THREE.Skeleton(bones, inverses);
    mesh.bind(skeleton, new THREE.Matrix4());
    mesh.boundingSphere = asset.sphere.clone();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.object.add(mesh);
    this.sa = { mesh, bones, skeleton };
    this.onStandaloneCreated(this.sa.mesh, bones);
    return this.sa;
  }

  /** Hook: standalone mesh created (humans attach items). */
  protected onStandaloneCreated(_mesh: THREE.SkinnedMesh, _bones: THREE.Bone[]): void {}
  /** Hook: standalone mesh about to be disposed. */
  protected onStandaloneDisposed(): void {}

  /** The standalone bone of a role index (null when batched). */
  protected standaloneBone(i: number): THREE.Bone | null {
    return this.sa?.bones[i] ?? null;
  }

  protected applyStandalone(): void {
    const sa = this.ensureStandalone();
    const rig = this.asset.rig;
    const out = this.out;
    const bs = this.boneScale;
    for (let i = 0; i < rig.count; i++) {
      const b = sa.bones[i];
      b.position.set(rig.offset[i * 3] + out.p[i].x, rig.offset[i * 3 + 1] + out.p[i].y, rig.offset[i * 3 + 2] + out.p[i].z);
      b.quaternion.copy(out.q[i]);
      const s = out.s[i] * bs[i];
      b.scale.set(s, s, s);
    }
    if (this.highlighted && sa.mesh.material === this.asset.highlightMaterial) {
      const u = this.asset.highlightMaterial.userData.creatureUniforms?.uHighlight as THREE.IUniform<number> | undefined;
      if (u) u.value = highlightPulse();
    }
  }

  /** Ensure something is drawn under `object` right now (standalone use before the first update). */
  ensureDrawable(): void {
    if (!this.batch && !this.sa) this.applyStandalone();
  }

  protected disposeStandalone(): void {
    const sa = this.sa;
    if (!sa) return;
    this.onStandaloneDisposed();
    sa.mesh.removeFromParent();
    sa.skeleton.dispose();
    this.sa = null;
  }

  get hasStandalone(): boolean {
    return this.sa !== null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    this.host?.release(this);
    this.disposeStandalone();
  }
}
