// Shared building blocks for the tiger, bears and gazelle: an extended
// quadruped state (per-occurrence pose variants, posture memory), extra
// poses the stock driver lacks (lateral lying, crouching, rearing up on the
// hind legs, sitting on the rump, stotting) and small coat utilities.
// Everything here is allocation-free per frame (module scratch objects).

import * as THREE from 'three';
import { Pose, rotLocal, rotParent } from '../../rig/rig';
import { LegRT, QuadState, advanceGait, initQuad, plantLeg, placeLeg, type QuadParams } from '../../anim/quadruped';
import { TAU, clamp, clamp01, hash1, lerp, smooth } from '../../anim/util';
import type { AnimCtx, Vec3 } from '../../types';

// ---------------------------------------------------------------------------
// State

/** Quadruped state + bookkeeping for action variants. */
export class PRState extends QuadState {
  /** Action seen last frame (resolved name). */
  lastAction = '';
  lastActionTime = 0;
  /** Random in [0,1) re-rolled each time an action starts (keyed by action). */
  readonly variants = new Map<string, number>();
  /** Counter of action starts (mixes into variant rolls). */
  starts = 0;
  /** Smoothed 0..1 helpers species may use (e.g. crouch amount). */
  a = 0;
  b = 0;
}

export function initPR(ctx: AnimCtx, p: QuadParams): PRState {
  const base = initQuad(ctx, p);
  const st = new PRState(p);
  // copy the leg runtime + rest data computed by initQuad
  st.legs.push(...base.legs);
  st.hipsY = base.hipsY;
  st.hipsZ = base.hipsZ;
  st.chestY = base.chestY;
  st.chestZ = base.chestZ;
  st.phase = base.phase;
  return st;
}

/** driver.pre: gait + action-start detection (variant rolls). */
export function prePR(ctx: AnimCtx, st: PRState): void {
  advanceGait(ctx, st);
  const restarted = ctx.actionTime + 1e-3 < st.lastActionTime;
  if (ctx.action !== st.lastAction || restarted) {
    st.starts++;
    st.variants.set(ctx.action, hash1(st.starts * 7919 + (ctx.seed | 0), 31));
    st.lastAction = ctx.action;
  }
  st.lastActionTime = ctx.actionTime;
}

/** Per-occurrence random in [0,1) of an action (stable while it lasts). */
export function variant(st: PRState, action: string, fallback: number): number {
  return st.variants.get(action) ?? fallback;
}

// ---------------------------------------------------------------------------
// scratch

const _A = new THREE.Vector3();
const _B = new THREE.Vector3();
const _C = new THREE.Vector3();
const _V = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);
const _Z = new THREE.Vector3(0, 0, 1);

/**
 * Two-bone IK to an ankle target with arbitrary model-space foot / toe
 * rotations (placeLeg only supports pure pitch).
 */
export function placeLegQ(ctx: AnimCtx, pose: Pose, leg: LegRT, A: THREE.Vector3, qFoot: THREE.Quaternion, qToe: THREE.Quaternion): void {
  const rig = ctx.rig;
  const r = leg.r;
  const parent = ctx.def.parent[r.upper];
  _pole.copy(leg.chain.restPole);
  if (parent >= 0) _pole.applyQuaternion(rig.wq[parent]);
  leg.chain.solve(rig, pose, A, _pole);
  rig.setWorldRot(pose, r.foot, qFoot);
  if (r.toe >= 0) rig.setWorldRot(pose, r.toe, qToe);
}

/** Two-bone IK with an explicit model-space knee / elbow direction (e.g. standing upright). */
export function placeLegPole(ctx: AnimCtx, pose: Pose, leg: LegRT, A: THREE.Vector3, pole: THREE.Vector3, footPitch: number, toePitch: number): void {
  const rig = ctx.rig;
  const r = leg.r;
  leg.chain.solve(rig, pose, A, pole);
  _q.setFromAxisAngle(_X, footPitch);
  rig.setWorldRot(pose, r.foot, _q);
  if (r.toe >= 0) {
    _q.setFromAxisAngle(_X, toePitch);
    rig.setWorldRot(pose, r.toe, _q);
  }
}

/** Ankle position that puts the contact at C with the given foot / toe pitch (as plantLeg). */
export function ankleFor(leg: LegRT, C: THREE.Vector3, footPitch: number, toePitch: number, out: THREE.Vector3): THREE.Vector3 {
  out.copy(C);
  if (leg.r.toe >= 0) out.add(_V.copy(leg.toeVec).applyAxisAngle(_X, toePitch));
  return out.add(_V.copy(leg.footVec).applyAxisAngle(_X, footPitch));
}

// ---------------------------------------------------------------------------
// Crouch: lower the chest / hips with planted feet (drinking cats, stalking)

/**
 * Lowers the front by `front` m and the hips by `hind` m (pitching the body),
 * keeps every foot planted at its contact (+ frontReach for the forefeet).
 * Leaves rig.fk current for the trunk.
 */
export function crouch(ctx: AnimCtx, st: QuadState, pose: Pose, front: number, hind: number, frontReach = 0, hindBack = 0): void {
  const R = ctx.roles;
  const rig = ctx.rig;
  const root = R.root;
  pose.p[root].y -= hind;
  const dz = Math.max(0.1, st.chestZ - st.hipsZ);
  rotParent(pose, root, 'x', Math.atan2(front - hind, dz));
  rig.fk(pose);
  for (const leg of st.legs) {
    _C.copy(leg.r.contact);
    if (leg.front) _C.z += frontReach;
    else _C.z -= hindBack;
    if (leg.r.scap >= 0) rig.fkBone(pose, leg.r.scap);
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    const slant = Math.atan2(H.z - _C.z, Math.max(0.05, H.y - _C.y));
    plantLeg(ctx, st, pose, leg, _C, slant * st.p.footFollow, slant * st.p.footFollow * 0.3);
  }
}

// ---------------------------------------------------------------------------
// Lateral recumbency (big cats and bears sleeping flat on their side)

export interface SideLie {
  /** Hip joint height when lying on the side (≈ half the hip width). */
  hipsY: number;
  /** Roll angle (rad, ≈ 1.35). */
  roll: number;
  /** Spine curl (rad, + curls the head toward the legs). */
  curl: number;
  /** Fraction of leg reach the feet stretch out sideways. */
  reach: number;
  /** Lower the neck / head to rest on the ground (rad about the neck's local x). */
  neckDrop: number;
}

/**
 * Lie flat on one side (`side` +1: on the right flank, legs toward +X).
 * The tail and head are left to the caller (call tail()/ears() after).
 */
export function lieSide(ctx: AnimCtx, st: QuadState, pose: Pose, side: number, k: SideLie, breath: number): void {
  const R = ctx.roles;
  const rig = ctx.rig;
  const root = R.root;
  pose.p[root].y -= st.hipsY - k.hipsY;
  rotParent(pose, root, 'z', side * k.roll);
  // curl the trunk: after the roll, local pitch bends the body in the ground plane
  const n = R.spine.length + 1;
  for (let i = 0; i < R.spine.length; i++) rotLocal(pose, R.spine[i], 'x', (k.curl / n) * 0.8);
  if (R.chest >= 0) {
    rotLocal(pose, R.chest, 'x', (k.curl / n) * 0.8);
    rotLocal(pose, R.chest, 'z', breath);
  }
  for (let i = 0; i < R.neck.length; i++) {
    rotLocal(pose, R.neck[i], 'x', k.curl * 0.25 / R.neck.length);
    // the neck droops toward the ground: after the roll the neck's local y axis is horizontal
    rotLocal(pose, R.neck[i], 'y', (-side * k.neckDrop) / R.neck.length);
  }
  rig.fk(pose);
  // foot orientation: rolled with the body, paws relaxed (pitched down a little)
  _q2.setFromAxisAngle(_Z, side * k.roll);
  for (const leg of st.legs) {
    if (leg.r.scap >= 0) rig.fkBone(pose, leg.r.scap);
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    const reach = (leg.chain.a + leg.chain.b) * k.reach;
    const upper = leg.side === side; // the legs on the upper flank
    // stretch outward along the ground, upper legs a little forward / back of the lower ones
    _A.set(H.x + side * reach, 0, H.z + (leg.front ? 0.18 : -0.12) * reach + (upper ? (leg.front ? 0.12 : -0.1) * reach : 0));
    _A.y = upper ? Math.max(0.1, k.hipsY * 0.75) : 0.07;
    _q.setFromAxisAngle(_X, leg.front ? 0.5 : -0.35).premultiply(_q2);
    const qt = _q;
    placeLegQ(ctx, pose, leg, _A, qt, qt);
  }
}

// ---------------------------------------------------------------------------
// Rearing up on the hind legs (bears)

export interface RearUp {
  /** Trunk pitch when fully up (rad, positive value = nose up). */
  pitch: number;
  /** Hip joint height when up. */
  hipsY: number;
  /** Forward shift of the hips (m) so they sit over the hind feet. */
  hipsDZ: number;
  /** Neck counter-pitch (rad) so the head looks forward. */
  neck: number;
}

/**
 * Stand up on the hind legs; `k` 0 = on all fours … 1 = upright. The front
 * legs hang in front of the chest. rig.fk is current afterwards.
 */
export function rearUp(ctx: AnimCtx, st: QuadState, pose: Pose, k: number, o: RearUp, armSwing = 0): void {
  const R = ctx.roles;
  const rig = ctx.rig;
  const root = R.root;
  pose.p[root].y += (o.hipsY - st.hipsY) * k;
  pose.p[root].z += o.hipsDZ * k;
  rotParent(pose, root, 'x', -o.pitch * k);
  // slight lordosis
  for (let i = 0; i < R.spine.length; i++) rotLocal(pose, R.spine[i], 'x', -0.08 * k);
  rig.fk(pose);
  const kf = smooth(0.05, 0.45, k);
  for (const leg of st.legs) {
    if (leg.r.scap >= 0) {
      rotLocal(pose, leg.r.scap, 'x', 0.25 * kf);
      rig.fkBone(pose, leg.r.scap);
    }
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    if (!leg.front) {
      // knees keep pointing forward (the rest pole would turn up with the pitched hips)
      _pole.set(0, -0.15, 1).normalize();
      placeLegPole(ctx, pose, leg, ankleFor(leg, leg.r.contact, 0, 0, _A), _pole, 0, 0);
      continue;
    }
    // planted ankle (on all fours) → dangling ankle (hanging in front of the chest)
    ankleFor(leg, leg.r.contact, 0, 0, _A);
    const L = leg.legLen;
    const sw = armSwing * (leg.side > 0 ? 1 : -1);
    _B.set(H.x * 0.92, H.y - L * 0.5 + sw * 0.04, H.z + L * 0.34 + sw * 0.05);
    _A.lerp(_B, kf);
    placeLeg(ctx, st, pose, leg, _A, lerp(0, 1.0, kf), lerp(0, 1.3, kf));
  }
  // keep the head looking forward
  const n = R.neck.length;
  for (let i = 0; i < n; i++) rotLocal(pose, R.neck[i], 'x', (o.neck * k) / n);
  if (R.head >= 0) rotLocal(pose, R.head, 'x', o.pitch * 0.18 * k);
}

// ---------------------------------------------------------------------------
// Sitting on the rump (bears): hind legs stretched forward, soles showing

export interface RumpSit {
  /** Hip joint height (m) when sitting. */
  hipsY: number;
  /** Trunk pitch (rad, positive = nose up). */
  pitch: number;
  /** Forward shift of the hips. */
  hipsDZ: number;
  /** How far forward the hind feet go (fraction of leg reach). */
  legFwd: number;
}

export function rumpSit(ctx: AnimCtx, st: QuadState, pose: Pose, k: number, o: RumpSit, breath: number): void {
  const R = ctx.roles;
  const rig = ctx.rig;
  const root = R.root;
  pose.p[root].y += (o.hipsY - st.hipsY) * k;
  pose.p[root].z += o.hipsDZ * k;
  rotParent(pose, root, 'x', -o.pitch * k);
  if (R.chest >= 0) rotLocal(pose, R.chest, 'x', breath);
  rig.fk(pose);
  for (const leg of st.legs) {
    if (leg.r.scap >= 0) rig.fkBone(pose, leg.r.scap);
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    if (leg.front) {
      // front paws planted between / just in front of the hind feet
      _C.copy(leg.r.contact);
      _C.x *= lerp(1, 0.85, k);
      _C.z = lerp(_C.z, H.z + 0.04, k);
      plantLeg(ctx, st, pose, leg, _C, 0, 0);
    } else {
      const reach = (leg.chain.a + leg.chain.b) * o.legFwd;
      _A.set(H.x + leg.side * 0.06, Math.max(0.06, leg.footVec.length() * 0.3), H.z + reach);
      ankleFor(leg, leg.r.contact, 0, 0, _B);
      _A.lerp(_B, 1 - k);
      placeLeg(ctx, st, pose, leg, _A, -1.35 * k, -1.45 * k);
    }
  }
  const n = R.neck.length;
  for (let i = 0; i < n; i++) rotLocal(pose, R.neck[i], 'x', (o.pitch * 0.75 * k) / n);
}

// ---------------------------------------------------------------------------
// Stotting / pronking (gazelle): stiff-legged vertical bounds

export interface Stott {
  /** Hop period (s). */
  period: number;
  /** Peak height of the hips (m). */
  height: number;
  /** Ground contact fraction of the cycle. */
  contact: number;
  /** Back arch (rad). */
  arch: number;
}

/**
 * Stott at phase `u` (0..1, contact first). Feet move with the body while
 * airborne (stiff legs, hooves bunched under the body); `forward` = metres
 * covered per hop (0 when stationary). Returns the current lift (m).
 */
export function stott(ctx: AnimCtx, st: QuadState, pose: Pose, u: number, o: Stott, forward: number, amount: number): number {
  const R = ctx.roles;
  const rig = ctx.rig;
  const root = R.root;
  let y = 0;
  let squash = 0;
  if (u < o.contact) {
    squash = Math.sin((u / o.contact) * Math.PI);
    y = -0.05 * squash * st.hipsY;
  } else {
    const v = (u - o.contact) / (1 - o.contact);
    y = o.height * 4 * v * (1 - v);
  }
  y *= amount;
  pose.p[root].y += y;
  // pitch: nose slightly down on take-off, up on landing
  const fl = u < o.contact ? 0 : (u - o.contact) / (1 - o.contact);
  rotParent(pose, root, 'x', amount * 0.08 * Math.sin(fl * TAU));
  // arched back while airborne
  const arch = o.arch * amount * smooth(o.contact, o.contact + 0.15, u) * (1 - smooth(0.85, 1, u));
  for (let i = 0; i < R.spine.length; i++) rotLocal(pose, R.spine[i], 'x', -arch / R.spine.length);
  if (R.chest >= 0) rotLocal(pose, R.chest, 'x', arch * 0.6);
  rig.fk(pose);
  const air = u < o.contact ? 0 : smooth(o.contact, o.contact + 0.12, u) * (1 - smooth(0.88, 1, u));
  for (const leg of st.legs) {
    if (leg.r.scap >= 0) rig.fkBone(pose, leg.r.scap);
    rig.fkBone(pose, leg.r.upper);
    _C.copy(leg.r.contact);
    // feet travel with the hop; bunched slightly toward the body centre in the air
    const slide = forward * (u < o.contact ? 0.5 - u / o.contact : -0.5 + fl);
    _C.z += (leg.front ? -0.05 : 0.05) * air * amount + slide * amount;
    _C.y += Math.max(0, y - 0.015 * air * amount);
    const H = rig.wp[leg.r.upper];
    const slant = Math.atan2(H.z - _C.z, Math.max(0.05, H.y - _C.y));
    plantLeg(ctx, st, pose, leg, _C, slant * 0.6 + 0.35 * air * amount * (leg.front ? 1 : -0.6), 0.5 * air * amount);
  }
  return y;
}

// ---------------------------------------------------------------------------
// Coat utilities

/** Projection of a point on a polyline: arc length (m) along it and distance to it. */
export interface PolyHit {
  s: number;
  d: number;
  /** Segment index. */
  i: number;
}

export function polyProject(px: number, py: number, pz: number, pts: readonly Vec3[], out: PolyHit): PolyHit {
  let acc = 0;
  let best = 1e9;
  out.s = 0;
  out.d = 1e9;
  out.i = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
    const L2 = ex * ex + ey * ey + ez * ez;
    const L = Math.sqrt(L2);
    let t = ((px - a[0]) * ex + (py - a[1]) * ey + (pz - a[2]) * ez) / Math.max(L2, 1e-9);
    t = clamp(t, i === 0 ? -0.5 : 0, i === pts.length - 2 ? 1.5 : 1);
    const qx = a[0] + ex * t - px, qy = a[1] + ey * t - py, qz = a[2] + ez * t - pz;
    const d = qx * qx + qy * qy + qz * qz;
    if (d < best) {
      best = d;
      out.s = acc + t * L;
      out.d = Math.sqrt(d);
      out.i = i;
    }
    acc += L;
  }
  return out;
}

/** Total length of a polyline. */
export function polyLength(pts: readonly Vec3[]): number {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) acc += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]);
  return acc;
}

/** Distance from a point to the left/right mirrored point `c` (|x| symmetric). */
export function distSym(x: number, y: number, z: number, c: Vec3): number {
  const dx = Math.abs(x) - c[0], dy = y - c[1], dz = z - c[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Normalised ellipsoid distance (1 on the surface) of a point from an axis-aligned ellipsoid (|x| symmetric). */
export function ellDist(x: number, y: number, z: number, c: Vec3, r: Vec3): number {
  const dx = (Math.abs(x) - c[0]) / r[0], dy = (y - c[1]) / r[1], dz = (z - c[2]) / r[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export { clamp01, smooth, lerp };
