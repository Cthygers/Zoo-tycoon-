// Shared skinned-model runtime used by animals and humans: builds the bone
// hierarchy for an instance, runs the animation driver with crossfades and
// applies the pose. Geometry / materials are shared through a RigAsset.

import * as THREE from 'three';
import type { CreatureAnim, CreatureModel } from '../core/contracts';
import { Pose, RigDef, RigRuntime, blendPoses } from './rig/rig';
import type { AnimCtx, AnimDriver, CreatureDesign, ResolvedRoles } from './types';
import { clamp01, damp, lerp } from './anim/util';

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
}

interface Slot {
  action: string;
  w: number;
  pose: Pose;
}

const MAX_SLOTS = 3;
const _weights: number[] = [0, 0, 0];
const _poses: Pose[] = [];

export class RiggedModel implements CreatureModel {
  readonly object = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  protected readonly asset: RigAsset;
  protected readonly bones: THREE.Bone[];
  protected readonly rt: RigRuntime;
  protected readonly ctx: AnimCtx;
  private readonly state: unknown;
  private readonly slots: Slot[] = [];
  private readonly spare: Pose[] = [];
  private readonly out: Pose;
  private readonly skeleton: THREE.Skeleton;
  protected baseScale = 1;
  protected growth = 1;
  private lastYaw = NaN;
  private highlighted = false;
  private static clock = 0;

  constructor(asset: RigAsset, seed: number, sex: 'M' | 'F', baseScale: number, role = '') {
    this.asset = asset;
    const rig = asset.rig;
    this.object.name = asset.key;
    this.bones = rig.names.map((n) => {
      const b = new THREE.Bone();
      b.name = n;
      return b;
    });
    const inverses: THREE.Matrix4[] = [];
    for (let i = 0; i < rig.count; i++) {
      const b = this.bones[i];
      b.position.set(rig.offset[i * 3], rig.offset[i * 3 + 1], rig.offset[i * 3 + 2]);
      const p = rig.parent[i];
      if (p >= 0) this.bones[p].add(b);
      inverses.push(new THREE.Matrix4().makeTranslation(-rig.rest[i * 3], -rig.rest[i * 3 + 1], -rig.rest[i * 3 + 2]));
    }
    this.mesh = new THREE.SkinnedMesh(asset.geometry, asset.material);
    for (let i = 0; i < rig.count; i++) if (rig.parent[i] < 0) this.mesh.add(this.bones[i]);
    this.skeleton = new THREE.Skeleton(this.bones, inverses);
    this.mesh.bind(this.skeleton, new THREE.Matrix4());
    this.mesh.boundingSphere = asset.sphere.clone();
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.object.add(this.mesh);

    this.rt = new RigRuntime(rig);
    this.out = new Pose(rig.count);
    const rand = ((seed * 2654435761) >>> 0) / 4294967296;
    this.ctx = {
      rig: this.rt,
      def: rig,
      roles: asset.roles,
      design: asset.design,
      time: rand * 100,
      dt: 0,
      speed: 0,
      actionTime: 0,
      swimming: false,
      holding: 'none',
      turnRate: 0,
      seed: seed | 0,
      rand,
      sex,
      growth: 1,
      role,
      action: 'idle',
    };
    this.state = asset.driver.init(this.ctx);
    this.baseScale = baseScale;
    this.setGrowth(1);
  }

  get height(): number {
    return this.asset.height * this.object.scale.y;
  }

  get radius(): number {
    return this.asset.radius * this.object.scale.y;
  }

  setGrowth(growth: number): void {
    this.growth = clamp01(growth);
    const d = this.asset.design;
    const s = this.baseScale * lerp(d.babyScale ?? 0.4, 1, this.growth);
    this.object.scale.setScalar(s);
    this.ctx.growth = this.growth;
  }

  setHighlighted(on: boolean): void {
    this.highlighted = on;
    this.mesh.material = on ? this.asset.highlightMaterial : this.asset.material;
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
      this.slots.push({ action, w: this.slots.length ? 0 : 1, pose: this.spare.pop() ?? new Pose(this.asset.rig.count) });
    }
    const fade = d.fades?.[action] ?? d.fade ?? 0.4;
    const step = dt / Math.max(0.05, fade);
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
    this.applyPose();
    if (this.highlighted) {
      RiggedModel.clock += dt;
      const m = this.asset.highlightMaterial as THREE.MeshStandardMaterial;
      if (m.emissiveIntensity !== undefined) m.emissiveIntensity = 0.18 + 0.14 * Math.sin(performance.now() * 0.006);
    }
  }

  protected applyPose(): void {
    const rig = this.asset.rig;
    const out = this.out;
    const headIdx = this.asset.roles.head;
    const babyHead = lerp(this.asset.design.babyHead ?? 1.3, 1, this.growth);
    for (let i = 0; i < rig.count; i++) {
      const b = this.bones[i];
      b.position.set(rig.offset[i * 3] + out.p[i].x, rig.offset[i * 3 + 1] + out.p[i].y, rig.offset[i * 3 + 2] + out.p[i].z);
      b.quaternion.copy(out.q[i]);
      const s = out.s[i] * (i === headIdx ? babyHead : 1);
      b.scale.set(s, s, s);
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.skeleton.dispose();
  }
}
