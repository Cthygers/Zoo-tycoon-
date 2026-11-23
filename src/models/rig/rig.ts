// Skeleton definition, poses and a small FK / IK toolkit.
//
// Conventions: every bone's REST rotation is identity, i.e. a bone's local
// frame is parallel to model space at rest. A bone's rest local offset is
// (restPos - parentRestPos). Poses store a local rotation and an extra local
// translation per bone. FK produces model-space ("world" here) rotations and
// positions, which IK helpers use. Nothing here allocates per frame.

import * as THREE from 'three';
import type { Vec3 } from '../sdf/prims';

export interface BoneSpec {
  name: string;
  parent: string | null;
  /** Model-space rest position of the joint (metres). */
  pos: Vec3;
}

export class RigDef {
  readonly names: string[];
  readonly parent: Int16Array;
  /** Model-space rest positions, 3 per bone. */
  readonly rest: Float32Array;
  /** Rest offset from parent (root: its rest position), 3 per bone. */
  readonly offset: Float32Array;
  private readonly map = new Map<string, number>();

  constructor(specs: readonly BoneSpec[]) {
    // topological order: parents first, keeping author order otherwise
    const byName = new Map(specs.map((s) => [s.name, s]));
    const ordered: BoneSpec[] = [];
    const done = new Set<string>();
    const visit = (s: BoneSpec, depth: number) => {
      if (done.has(s.name)) return;
      if (depth > 64) throw new Error(`bone cycle at ${s.name}`);
      if (s.parent) {
        const p = byName.get(s.parent);
        if (!p) throw new Error(`bone ${s.name}: unknown parent ${s.parent}`);
        visit(p, depth + 1);
      }
      done.add(s.name);
      ordered.push(s);
    };
    for (const s of specs) visit(s, 0);
    const n = ordered.length;
    this.names = ordered.map((s) => s.name);
    this.parent = new Int16Array(n);
    this.rest = new Float32Array(n * 3);
    this.offset = new Float32Array(n * 3);
    ordered.forEach((s, i) => this.map.set(s.name, i));
    ordered.forEach((s, i) => {
      const pi = s.parent ? this.map.get(s.parent)! : -1;
      this.parent[i] = pi;
      this.rest.set(s.pos, i * 3);
      for (let k = 0; k < 3; k++) this.offset[i * 3 + k] = s.pos[k] - (pi >= 0 ? ordered[pi].pos[k] : 0);
    });
  }

  get count(): number {
    return this.names.length;
  }

  /** Bone index by name; throws if missing. */
  bone(name: string): number {
    const i = this.map.get(name);
    if (i === undefined) throw new Error(`unknown bone '${name}'`);
    return i;
  }

  /** Bone index by name or -1. */
  find(name: string | undefined | null): number {
    if (!name) return -1;
    return this.map.get(name) ?? -1;
  }

  restVec(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.rest[i * 3], this.rest[i * 3 + 1], this.rest[i * 3 + 2]);
  }

  /** Distance between two bones' rest positions. */
  restDist(a: number, b: number): number {
    const dx = this.rest[a * 3] - this.rest[b * 3];
    const dy = this.rest[a * 3 + 1] - this.rest[b * 3 + 1];
    const dz = this.rest[a * 3 + 2] - this.rest[b * 3 + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Is `a` an ancestor of (or equal to) `b`? */
  isAncestor(a: number, b: number): boolean {
    for (let i = b; i >= 0; i = this.parent[i]) if (i === a) return true;
    return false;
  }
}

/** Local rotations + translation offsets for every bone. */
export class Pose {
  readonly q: THREE.Quaternion[];
  readonly p: THREE.Vector3[];
  /** Optional per-bone uniform scale (1 = rest). */
  readonly s: Float32Array;

  constructor(n: number) {
    this.q = Array.from({ length: n }, () => new THREE.Quaternion());
    this.p = Array.from({ length: n }, () => new THREE.Vector3());
    this.s = new Float32Array(n).fill(1);
  }

  reset(): this {
    for (let i = 0; i < this.q.length; i++) {
      this.q[i].set(0, 0, 0, 1);
      this.p[i].set(0, 0, 0);
      this.s[i] = 1;
    }
    return this;
  }

  copy(o: Pose): this {
    for (let i = 0; i < this.q.length; i++) {
      this.q[i].copy(o.q[i]);
      this.p[i].copy(o.p[i]);
      this.s[i] = o.s[i];
    }
    return this;
  }
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _e = new THREE.Euler();
const AX = new THREE.Vector3(1, 0, 0);
const AY = new THREE.Vector3(0, 1, 0);
const AZ = new THREE.Vector3(0, 0, 1);

/** Multiply a bone's local rotation by a rotation about a LOCAL axis (post-multiply). */
export function rotLocal(pose: Pose, bone: number, axis: 'x' | 'y' | 'z', angle: number): void {
  if (bone < 0 || angle === 0) return;
  _q.setFromAxisAngle(axis === 'x' ? AX : axis === 'y' ? AY : AZ, angle);
  pose.q[bone].multiply(_q);
}

/** Pre-multiply (rotation about the PARENT-space axis). */
export function rotParent(pose: Pose, bone: number, axis: 'x' | 'y' | 'z', angle: number): void {
  if (bone < 0 || angle === 0) return;
  _q.setFromAxisAngle(axis === 'x' ? AX : axis === 'y' ? AY : AZ, angle);
  pose.q[bone].premultiply(_q);
}

/** Apply Euler XYZ (pitch x, yaw y, roll z) as a local post-rotation. */
export function rotEuler(pose: Pose, bone: number, x: number, y: number, z: number): void {
  if (bone < 0) return;
  _e.set(x, y, z, 'YXZ');
  _q.setFromEuler(_e);
  pose.q[bone].multiply(_q);
}

/**
 * Per-instance runtime: FK results and IK helpers bound to a RigDef.
 */
export class RigRuntime {
  readonly def: RigDef;
  /** Model-space rotation of each bone after fk(). */
  readonly wq: THREE.Quaternion[];
  /** Model-space joint position of each bone after fk(). */
  readonly wp: THREE.Vector3[];
  private readonly ws: Float32Array;
  /**
   * Per-instance bone scale on top of the pose scale (juvenile head, legs,
   * growing horns), so FK and IK see the proportions the mesh is drawn with.
   */
  readonly boneScale: Float32Array;

  constructor(def: RigDef) {
    this.def = def;
    this.wq = Array.from({ length: def.count }, () => new THREE.Quaternion());
    this.wp = Array.from({ length: def.count }, () => new THREE.Vector3());
    this.ws = new Float32Array(def.count).fill(1);
    this.boneScale = new Float32Array(def.count).fill(1);
  }

  /** Model-space scale of a bone after fk() (pose × instance scales down the chain). */
  scaleOf(bone: number): number {
    return this.ws[bone];
  }

  /** Full forward kinematics (model space). */
  fk(pose: Pose): void {
    const d = this.def;
    for (let i = 0; i < d.count; i++) this.fkBone(pose, i);
  }

  /** FK for one bone; its parent must already be up to date. */
  fkBone(pose: Pose, i: number): void {
    const d = this.def;
    const pi = d.parent[i];
    _v.set(d.offset[i * 3], d.offset[i * 3 + 1], d.offset[i * 3 + 2]).add(pose.p[i]);
    const s = pose.s[i] * this.boneScale[i];
    if (pi < 0) {
      this.wp[i].copy(_v);
      this.wq[i].copy(pose.q[i]);
      this.ws[i] = s;
    } else {
      _v.multiplyScalar(this.ws[pi]).applyQuaternion(this.wq[pi]);
      this.wp[i].copy(this.wp[pi]).add(_v);
      this.wq[i].copy(this.wq[pi]).multiply(pose.q[i]);
      this.ws[i] = this.ws[pi] * s;
    }
  }

  /** FK for a bone and all bones after it in topological order that descend from it. */
  fkFrom(pose: Pose, i: number): void {
    const d = this.def;
    this.fkBone(pose, i);
    for (let j = i + 1; j < d.count; j++) if (d.isAncestor(i, j)) this.fkBone(pose, j);
  }

  /** Model-space position of a point given in a bone's rest model coordinates (after fk). */
  pointOn(bone: number, restPoint: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const d = this.def;
    out.set(restPoint.x - d.rest[bone * 3], restPoint.y - d.rest[bone * 3 + 1], restPoint.z - d.rest[bone * 3 + 2]);
    out.multiplyScalar(this.ws[bone]).applyQuaternion(this.wq[bone]).add(this.wp[bone]);
    return out;
  }

  /** Set a bone's local rotation so that its model-space rotation equals `world` (parent fk must be current). */
  setWorldRot(pose: Pose, bone: number, world: THREE.Quaternion): void {
    const pi = this.def.parent[bone];
    if (pi < 0) pose.q[bone].copy(world);
    else pose.q[bone].copy(this.wq[pi]).invert().multiply(world);
    this.fkBone(pose, bone);
  }
}

// ---------------------------------------------------------------------------
// Two-bone IK

const _H = new THREE.Vector3();
const _D = new THREE.Vector3();
const _P = new THREE.Vector3();
const _M = new THREE.Vector3();
const _T = new THREE.Vector3();
const _u = new THREE.Vector3();
const _l = new THREE.Vector3();
const _n = new THREE.Vector3();
const _b = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _qw = new THREE.Quaternion();

/** Precomputed rest data for a two-bone chain (upper → lower → end). */
export class TwoBoneChain {
  readonly upper: number;
  readonly lower: number;
  readonly end: number;
  /** Rest lengths upper → lower and lower → end (solve() applies the bone scales). */
  readonly a: number;
  readonly b: number;
  /** Rest bend direction (unit, model space, perpendicular to the upper→end line). */
  readonly restPole = new THREE.Vector3();
  private readonly restBasisU = new THREE.Matrix4();
  private readonly restBasisL = new THREE.Matrix4();

  constructor(def: RigDef, upper: number, lower: number, end: number, fallbackPole: Vec3) {
    this.upper = upper;
    this.lower = lower;
    this.end = end;
    this.a = def.restDist(upper, lower);
    this.b = def.restDist(lower, end);
    const H = def.restVec(upper, new THREE.Vector3());
    const M = def.restVec(lower, new THREE.Vector3());
    const E = def.restVec(end, new THREE.Vector3());
    const dir = E.clone().sub(H).normalize();
    const pole = M.clone().sub(H);
    pole.addScaledVector(dir, -pole.dot(dir));
    if (pole.length() < 1e-3 * (this.a + this.b)) pole.set(fallbackPole[0], fallbackPole[1], fallbackPole[2]).addScaledVector(dir, -dir.dot(new THREE.Vector3(...fallbackPole)));
    this.restPole.copy(pole.normalize());
    const u = M.clone().sub(H).normalize();
    const l = E.clone().sub(M).normalize();
    const n = new THREE.Vector3().crossVectors(dir, this.restPole).normalize();
    this.restBasisU.makeBasis(u, n, new THREE.Vector3().crossVectors(u, n)).invert();
    this.restBasisL.makeBasis(l, n, new THREE.Vector3().crossVectors(l, n)).invert();
  }

  /**
   * Solve so that the end joint reaches `target` (model space). `pole` is the
   * desired bend direction in model space (usually restPole rotated with the
   * parent). Writes local rotations of upper & lower and updates their fk.
   * Returns the reach ratio (|target - hip| / (a+b)).
   */
  solve(rig: RigRuntime, pose: Pose, target: THREE.Vector3, pole: THREE.Vector3): number {
    rig.fkBone(pose, this.upper);
    rig.fkBone(pose, this.lower);
    _H.copy(rig.wp[this.upper]);
    // segment lengths as drawn (scaled juvenile legs)
    const a = this.a * rig.scaleOf(this.upper), b = this.b * rig.scaleOf(this.lower);
    _D.copy(target).sub(_H);
    const len = _D.length();
    const ratio = len / (a + b);
    const dist = Math.min(Math.max(len, Math.abs(a - b) + 1e-4), (a + b) * 0.9995);
    if (len > 1e-6) _D.divideScalar(len);
    else _D.set(0, -1, 0);
    // bend direction perpendicular to D
    _P.copy(pole).addScaledVector(_D, -pole.dot(_D));
    if (_P.lengthSq() < 1e-8) _P.set(0, 0, 1).addScaledVector(_D, -_D.z);
    _P.normalize();
    const cosA = (a * a + dist * dist - b * b) / (2 * a * dist);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    _M.copy(_H).addScaledVector(_D, a * cosA).addScaledVector(_P, a * sinA);
    _T.copy(_H).addScaledVector(_D, dist);
    _u.copy(_M).sub(_H).normalize();
    _l.copy(_T).sub(_M).normalize();
    _n.crossVectors(_D, _P).normalize();
    // upper
    _m1.makeBasis(_u, _n, _b.crossVectors(_u, _n));
    _m2.multiplyMatrices(_m1, this.restBasisU);
    _qw.setFromRotationMatrix(_m2);
    rig.setWorldRot(pose, this.upper, _qw);
    // lower
    rig.fkBone(pose, this.lower);
    _m1.makeBasis(_l, _n, _b.crossVectors(_l, _n));
    _m2.multiplyMatrices(_m1, this.restBasisL);
    _qw.setFromRotationMatrix(_m2);
    rig.setWorldRot(pose, this.lower, _qw);
    rig.fkBone(pose, this.end);
    return ratio;
  }
}

/** Blend several poses: out = Σ w_i pose_i (normalized quaternion average). */
export function blendPoses(out: Pose, poses: readonly Pose[], weights: readonly number[], count: number): void {
  const n = out.q.length;
  for (let b = 0; b < n; b++) {
    let x = 0, y = 0, z = 0, w = 0, px = 0, py = 0, pz = 0, s = 0;
    const ref = poses[0].q[b];
    for (let k = 0; k < count; k++) {
      const wk = weights[k];
      if (wk <= 0) continue;
      const q = poses[k].q[b];
      const sign = q.x * ref.x + q.y * ref.y + q.z * ref.z + q.w * ref.w < 0 ? -wk : wk;
      x += q.x * sign; y += q.y * sign; z += q.z * sign; w += q.w * sign;
      const p = poses[k].p[b];
      px += p.x * wk; py += p.y * wk; pz += p.z * wk;
      s += poses[k].s[b] * wk;
    }
    const l = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
    out.q[b].set(x / l, y / l, z / l, w / l);
    out.p[b].set(px, py, pz);
    out.s[b] = s;
  }
}


