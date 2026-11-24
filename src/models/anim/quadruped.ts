// Procedural quadruped animation: gait-driven leg IK (walk / trot / gallop),
// body bob/sway, look-around, ear flicks, tail swish, grazing, drinking,
// lying down, sitting, swimming, play, social and call.
//
// Species get a driver with `quadrupedDriver(params)` and may override any
// action; the building blocks (body, legs, reachMuzzle, lie, tail …) are
// exported for reuse by species-specific actions.

import * as THREE from 'three';
import { Pose, RigRuntime, TwoBoneChain, rotLocal, rotParent } from '../rig/rig';
import type { AnimCtx, AnimDriver, LegId, ResolvedLeg } from '../types';
import { TAU, clamp, clamp01, damp, fract, glance, lerp, pulses, smooth, wander } from './util';

export interface GaitDef {
  /** Stride length (m, one full cycle) at refSpeed. */
  stride: number;
  refSpeed: number;
  /** Stance fraction of the cycle. */
  duty: number;
  /** Leg phase offsets [FL, FR, HL, HR] in cycles (stance starts at leg phase 0). */
  offsets: [number, number, number, number];
  /** Foot lift (m). */
  stepHeight: number;
  /** Vertical body bob amplitude (m) and bobs per cycle. */
  bob: number;
  bobFreq: number;
  /** Body pitch rocking (rad), roll (rad). */
  pitch: number;
  roll: number;
  /** Head / neck nod amplitude (rad). */
  headBob: number;
  /** Spine flexion amplitude (rad, bounding cats / gallop). */
  spineFlex: number;
}

export interface LieParams {
  /** Hip joint height when lying (m, model space). */
  hipsY: number;
  /** Chest (front) joint height when lying. */
  chestY: number;
  /** Front legs folded under (hoofed) or stretched forward (cats, bears). */
  front: 'tuck' | 'extend';
  /** Extra lateral offset of the hind feet when lying (m). */
  hindSplay: number;
  /**
   * Front 'tuck': where the folded carpus rests, in leg reaches ahead of the
   * shoulder joint. Default 0.42 (just in front of the chest); long-legged
   * species ≈ 0 fold the forearm under the chest with the cannon lying back
   * beneath it instead of sticking out in front.
   */
  carpusZ?: number;
  /**
   * Where the hock rests, in leg reaches ahead of the hip joint. Default −0.3
   * (behind the hip); long-legged species ≈ 0 fold the hind leg beside the
   * belly instead of trailing it behind the rump.
   */
  hockZ?: number;
  /** Muzzle height when the head rests (m). */
  headRest: number;
}

export interface QuadParams {
  walk: GaitDef;
  trot: GaitDef;
  gallop: GaitDef;
  /** Centre speeds (m/s, model scale) of the walk→trot and trot→gallop transitions. */
  trotSpeed: number;
  gallopSpeed: number;
  /** How much the lower foot chain follows the leg slant (0..1). */
  footFollow: number;
  /** Swing flexion of the foot segment (rad; + folds the bottom backwards). */
  frontFlex: number;
  hindFlex: number;
  /** Swing curl of the toe segment (rad). */
  frontToeCurl: number;
  hindToeCurl: number;
  /** Toe break-over at the end of stance (rad). */
  push: number;
  /** Scapula rotation per radian of leg swing (cats/bears ≈ 0.5, hoofed ≈ 0.25). */
  scapSwing: number;
  lie: LieParams;
  /** 'cat': sits on haunches; 'none': `sit` lies down with the head up. */
  sitStyle: 'cat' | 'none';
  /** Where grazing puts the muzzle: z ahead of the front contacts (m). */
  grazeReach: number;
  /** Extra neck lowering (rad) at gallop. */
  headCarry: number;
  /** Look-around amplitude (rad). */
  look: number;
  tailSwish: number;
  /** Tail lift when running (rad, negative = up). */
  tailCarry: number;
  earFlick: number;
  /** Mouth opening during call (rad) and head raise (rad, negative = up). */
  callJaw: number;
  callHead: number;
  callDuration: number;
  breath: number;
  /** How far the model sinks when swimming (m; model origin = water surface). */
  swimSink: number;
}

const G = (o: Partial<GaitDef> & Pick<GaitDef, 'stride' | 'refSpeed' | 'duty' | 'offsets'>): GaitDef => ({
  stepHeight: 0.1,
  bob: 0.01,
  bobFreq: 2,
  pitch: 0,
  roll: 0.01,
  headBob: 0.03,
  spineFlex: 0,
  ...o,
});

/** Sensible defaults from a shoulder height (m) and walk / run speeds. Override what you need. */
export function quadParams(height: number, walkSpeed: number, runSpeed: number, o: Partial<QuadParams> = {}): QuadParams {
  const h = height;
  const trotSpeed = Math.max(walkSpeed * 1.55, Math.min(runSpeed * 0.42, walkSpeed * 2.6));
  return {
    walk: G({ stride: 1.05 * h, refSpeed: walkSpeed, duty: 0.64, offsets: [0.25, 0.75, 0, 0.5], stepHeight: 0.09 * h, bob: 0.008 * h, roll: 0.025, headBob: 0.05 }),
    trot: G({ stride: 1.7 * h, refSpeed: trotSpeed, duty: 0.42, offsets: [0.5, 1.0, 0, 0.5], stepHeight: 0.14 * h, bob: 0.022 * h, roll: 0.015, headBob: 0.025 }),
    gallop: G({ stride: 2.9 * h, refSpeed: runSpeed, duty: 0.3, offsets: [0.48, 0.58, 0, 0.1], stepHeight: 0.18 * h, bob: 0.03 * h, bobFreq: 1, pitch: 0.07, roll: 0.01, headBob: 0.07, spineFlex: 0.06 }),
    trotSpeed,
    gallopSpeed: Math.max(trotSpeed * 1.5, runSpeed * 0.68),
    footFollow: 0.55,
    frontFlex: 1.3,
    hindFlex: -0.5,
    frontToeCurl: 0.9,
    hindToeCurl: 0.9,
    push: 0.6,
    scapSwing: 0.25,
    lie: { hipsY: h * 0.42, chestY: h * 0.4, front: 'tuck', hindSplay: 0.04 * h, headRest: 0.06 * h },
    sitStyle: 'none',
    grazeReach: 0.25 * h,
    headCarry: 0.15,
    look: 0.45,
    tailSwish: 0.35,
    tailCarry: -0.2,
    earFlick: 0.5,
    callJaw: 0.35,
    callHead: -0.45,
    callDuration: 2.6,
    breath: 0.012,
    swimSink: h * 0.82,
    ...o,
  };
}

const LEG_IDS: LegId[] = ['FL', 'FR', 'HL', 'HR'];

/** Per-leg runtime data. */
export class LegRT {
  readonly id: LegId;
  readonly idx: number;
  readonly front: boolean;
  readonly side: number;
  readonly r: ResolvedLeg;
  readonly chain: TwoBoneChain;
  /** rest vectors */
  readonly toeVec = new THREE.Vector3(); // toe joint − contact
  readonly footVec = new THREE.Vector3(); // ankle − toe joint (or − contact)
  readonly legLen: number;
  readonly hipRest = new THREE.Vector3();
  /** Rest heights of the segments hip→knee, knee→ankle, ankle→toe joint, toe joint→contact. */
  private readonly segY: [number, number, number, number];
  /** Model-space scale of the foot and toe bones (juvenile legs / paws, see syncScale). */
  kFoot = 1;
  kToe = 1;
  /** How much higher the hip joint stands than at rest because of the bone scales (m). */
  lift = 0;
  /** Effective (scaled) length of the IK chain, hip → ankle. */
  reach: number;

  constructor(rig: RigRuntime, id: LegId, idx: number, r: ResolvedLeg) {
    this.id = id;
    this.idx = idx;
    this.front = id[0] === 'F';
    this.side = id[1] === 'L' ? 1 : -1;
    this.r = r;
    const d = rig.def;
    this.chain = new TwoBoneChain(d, r.upper, r.lower, r.foot, this.front ? [0, 0, -1] : [0, 0, 1]);
    const foot = d.restVec(r.foot, new THREE.Vector3());
    if (r.toe >= 0) {
      const toe = d.restVec(r.toe, new THREE.Vector3());
      this.toeVec.copy(toe).sub(r.contact);
      this.footVec.copy(foot).sub(toe);
    } else {
      this.footVec.copy(foot).sub(r.contact);
    }
    d.restVec(r.upper, this.hipRest);
    this.legLen = this.hipRest.y - r.contact.y;
    const y = (b: number) => d.rest[b * 3 + 1];
    const toeY = r.toe >= 0 ? y(r.toe) : r.contact.y;
    this.segY = [this.hipRest.y - y(r.lower), y(r.lower) - y(r.foot), y(r.foot) - toeY, toeY - r.contact.y];
    this.reach = this.chain.a + this.chain.b;
  }

  /**
   * Pick up the per-instance bone scales (juvenile legs and paws) from the
   * rig: foot / toe scales for planting, the extra standing height, the reach.
   * The leg's parent bone is assumed unscaled.
   */
  syncScale(rig: RigRuntime): void {
    const bs = rig.boneScale;
    const r = this.r;
    const kU = bs[r.upper];
    const kL = kU * bs[r.lower];
    this.kFoot = kL * bs[r.foot];
    this.kToe = r.toe >= 0 ? this.kFoot * bs[r.toe] : this.kFoot;
    const g = this.segY;
    this.lift = (kU - 1) * g[0] + (kL - 1) * g[1] + (this.kFoot - 1) * g[2] + (this.kToe - 1) * g[3];
    this.reach = this.chain.a * kU + this.chain.b * kL;
  }

  /** Hip joint height above the contact as drawn (rest leg length + juvenile lift). */
  get scaledLen(): number {
    return this.legLen + this.lift;
  }
}

export class QuadState {
  phase = 0;
  speed = 0;
  freq = 0;
  stride = 0;
  amp = 0;
  wt = 0;
  wg = 0;
  turn = 0;
  readonly g: GaitDef = G({ stride: 1, refSpeed: 1, duty: 0.6, offsets: [0, 0, 0, 0] });
  readonly legs: LegRT[] = [];
  readonly p: QuadParams;
  /** Rest heights of hips / chest joints. */
  hipsY = 1;
  chestY = 1;
  chestZ = 0;
  hipsZ = 0;
  /**
   * Extra standing height of the hind / front legs from juvenile proportions
   * (m, + = longer legs). body() raises the standing trunk by it; lying and
   * swimming poses ignore it.
   */
  liftH = 0;
  liftF = 0;
  /** Mean leg length as drawn / rest leg length: short-legged cubs take shorter, quicker steps. */
  legK = 1;
  constructor(p: QuadParams) {
    this.p = p;
  }
}

// scratch
const _C = new THREE.Vector3();
const _A = new THREE.Vector3();
const _T = new THREE.Vector3();
const _V = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);
const _M = new THREE.Vector3();

function blendGait(out: GaitDef, a: GaitDef, b: GaitDef, t: number): void {
  out.stride = lerp(a.stride, b.stride, t);
  out.refSpeed = lerp(a.refSpeed, b.refSpeed, t);
  out.duty = lerp(a.duty, b.duty, t);
  for (let i = 0; i < 4; i++) out.offsets[i] = lerp(a.offsets[i], b.offsets[i], t);
  out.stepHeight = lerp(a.stepHeight, b.stepHeight, t);
  out.bob = lerp(a.bob, b.bob, t);
  out.bobFreq = t < 0.5 ? a.bobFreq : b.bobFreq;
  out.pitch = lerp(a.pitch, b.pitch, t);
  out.roll = lerp(a.roll, b.roll, t);
  out.headBob = lerp(a.headBob, b.headBob, t);
  out.spineFlex = lerp(a.spineFlex, b.spineFlex, t);
}

// ---------------------------------------------------------------------------
// building blocks

/** Create the per-instance state (driver.init). */
export function initQuad(ctx: AnimCtx, p: QuadParams): QuadState {
  const st = new QuadState(p);
  const roles = ctx.roles;
  LEG_IDS.forEach((id, i) => {
    const r = roles.legs[id];
    if (r) st.legs.push(new LegRT(ctx.rig, id, i, r));
  });
  const d = ctx.def;
  st.hipsY = d.rest[roles.root * 3 + 1];
  st.hipsZ = d.rest[roles.root * 3 + 2];
  const ch = roles.chest >= 0 ? roles.chest : roles.root;
  st.chestY = d.rest[ch * 3 + 1];
  st.chestZ = d.rest[ch * 3 + 2];
  st.phase = ctx.rand;
  return st;
}

/** Advance gait phase from speed and pick up the juvenile leg proportions (driver.pre). */
export function advanceGait(ctx: AnimCtx, st: QuadState): void {
  syncLegScales(ctx, st);
  const p = st.p;
  st.speed += (ctx.speed - st.speed) * damp(0.18, ctx.dt);
  const v = st.speed;
  st.wt = smooth(p.trotSpeed * 0.82, p.trotSpeed * 1.12, v);
  st.wg = smooth(p.gallopSpeed * 0.85, p.gallopSpeed * 1.12, v);
  blendGait(st.g, p.walk, p.trot, st.wt);
  if (st.wg > 0) blendGait(st.g, st.g, p.gallop, st.wg);
  const g = st.g;
  st.amp = smooth(0.015, 0.22, v);
  st.stride = g.stride * st.legK * clamp(Math.sqrt(Math.max(v, 1e-4) / g.refSpeed), 0.3, 1.45);
  st.freq = v > 1e-3 ? v / st.stride : 0;
  st.phase = fract(st.phase + st.freq * ctx.dt);
  const targetTurn = clamp(ctx.turnRate * 0.22, -0.4, 0.4);
  st.turn += (targetTurn - st.turn) * damp(0.3, ctx.dt);
}

/** Leg bone scales → per-leg planting data and the standing lift of the trunk (front / hind). */
function syncLegScales(ctx: AnimCtx, st: QuadState): void {
  let f = 0, nf = 0, h = 0, nh = 0, len = 0, scaled = 0;
  for (const leg of st.legs) {
    leg.syncScale(ctx.rig);
    len += leg.legLen;
    scaled += leg.scaledLen;
    if (leg.front) {
      f += leg.lift;
      nf++;
    } else {
      h += leg.lift;
      nh++;
    }
  }
  // a rig with only one pair of legs (bipeds) lifts evenly
  st.liftF = nf ? f / nf : nh ? h / nh : 0;
  st.liftH = nh ? h / nh : st.liftF;
  st.legK = len > 0 ? scaled / len : 1;
}

/**
 * Raise the standing trunk by the juvenile leg lift (hips by liftH, pitched
 * so the chest rises by liftF): long-legged foals stand taller, short-legged
 * cubs lower, and the planted feet stay on the ground.
 */
export function standingLift(st: QuadState, pose: Pose, root: number): void {
  if (st.liftH === 0 && st.liftF === 0) return;
  pose.p[root].y += st.liftH;
  rotParent(pose, root, 'x', -Math.atan2(st.liftF - st.liftH, Math.max(0.1, st.chestZ - st.hipsZ)));
}

/** Body motion for locomotion + breathing + turning bend. `still` scales locomotion bob (0 = none). */
export function body(ctx: AnimCtx, st: QuadState, pose: Pose, loco = 1): void {
  const R = ctx.roles;
  const g = st.g;
  const a = st.amp * loco;
  const ph = st.phase * TAU;
  const hips = R.root;
  standingLift(st, pose, hips);
  // vertical bob, roll, pitch
  pose.p[hips].y += -g.bob * a * (0.5 + 0.5 * Math.cos(ph * g.bobFreq));
  rotParent(pose, hips, 'z', g.roll * a * Math.sin(ph));
  rotParent(pose, hips, 'x', g.pitch * a * Math.sin(ph - 0.6));
  // spine flexion (gallop) and turning bend
  const sp = R.spine;
  const n = sp.length + 1;
  for (let i = 0; i < sp.length; i++) {
    rotLocal(pose, sp[i], 'x', -g.spineFlex * a * Math.sin(ph + 0.4));
    rotLocal(pose, sp[i], 'y', st.turn / n);
  }
  if (R.chest >= 0) {
    rotLocal(pose, R.chest, 'y', st.turn / n);
    // breathing
    rotLocal(pose, R.chest, 'x', st.p.breath * Math.sin(ctx.time * TAU * 0.28));
    rotLocal(pose, R.chest, 'x', g.pitch * a * 0.5 * Math.sin(ph + 1.2));
  }
  // idle weight shift
  const still = 1 - st.amp;
  pose.p[hips].x += 0.006 * still * wander(ctx.time * 0.13, ctx.seed);
}

/**
 * Place a leg so that its ankle (foot bone joint) reaches A, with the foot
 * and toe rotated by `footPitch` / `toePitch` (model X axis).
 */
export function placeLeg(ctx: AnimCtx, st: unknown, pose: Pose, leg: LegRT, A: THREE.Vector3, footPitch: number, toePitch: number): number {
  const rig = ctx.rig;
  const r = leg.r;
  const parent = ctx.def.parent[r.upper];
  _pole.copy(leg.chain.restPole);
  if (parent >= 0) _pole.applyQuaternion(rig.wq[parent]);
  const ratio = leg.chain.solve(rig, pose, A, _pole);
  _q.setFromAxisAngle(_X, footPitch);
  rig.setWorldRot(pose, r.foot, _q);
  if (r.toe >= 0) {
    _q.setFromAxisAngle(_X, toePitch);
    rig.setWorldRot(pose, r.toe, _q);
  }
  return ratio;
}

/** Plant a leg with its contact point at C. */
export function plantLeg(ctx: AnimCtx, st: unknown, pose: Pose, leg: LegRT, C: THREE.Vector3, footPitch: number, toePitch: number): number {
  _T.copy(C);
  if (leg.r.toe >= 0) {
    _V.copy(leg.toeVec).multiplyScalar(leg.kToe).applyAxisAngle(_X, toePitch);
    _T.add(_V);
  }
  _A.copy(leg.footVec).multiplyScalar(leg.kFoot).applyAxisAngle(_X, footPitch).add(_T);
  return placeLeg(ctx, st, pose, leg, _A, footPitch, toePitch);
}

/** Locomotion legs (planted standing when speed ≈ 0). `spread` moves front feet forward (grazing). rig.fk must be current. */
export function legs(ctx: AnimCtx, st: QuadState, pose: Pose, frontReach = 0): void {
  const p = st.p;
  const g = st.g;
  const rig = ctx.rig;
  for (const leg of st.legs) {
    const lp = fract(st.phase + g.offsets[leg.idx]);
    const L = st.stride * g.duty * st.amp;
    let dz: number, dy: number, flex: number, toe: number;
    const push = p.push * st.amp;
    if (lp < g.duty) {
      const u = lp / g.duty;
      dz = L * (0.5 - u);
      dy = 0;
      flex = 0;
      toe = push * smooth(0.72, 1, u);
    } else {
      const v = (lp - g.duty) / (1 - g.duty);
      const e = 0.5 - 0.5 * Math.cos(Math.PI * v);
      dz = L * (-0.5 + e);
      const lift = Math.sin(Math.PI * Math.min(1, v * 1.1));
      dy = g.stepHeight * st.amp * Math.max(0, lift) * (leg.front ? 1 : 0.85);
      const s = Math.sin(Math.PI * v) * st.amp;
      flex = (leg.front ? p.frontFlex : p.hindFlex) * s;
      toe = push * (1 - smooth(0, 0.45, v)) + (leg.front ? p.frontToeCurl : p.hindToeCurl) * s;
    }
    _C.copy(leg.r.contact);
    _C.z += dz + (leg.front ? frontReach * (leg.side > 0 ? 1 : 0.35) : 0);
    _C.y += dy;
    // scapula follows the swing
    if (leg.r.scap >= 0) {
      const sw = Math.atan2(dz, leg.legLen);
      rotLocal(pose, leg.r.scap, 'x', -sw * p.scapSwing * 2);
      rig.fkBone(pose, leg.r.scap);
    }
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    const slant = Math.atan2(H.z - _C.z, Math.max(0.05, H.y - _C.y));
    plantLeg(ctx, st, pose, leg, _C, slant * p.footFollow + flex, toe + slant * p.footFollow * 0.3);
  }
}

/** Distribute a pitch / yaw over the neck chain and head. */
export function neckHead(ctx: AnimCtx, pose: Pose, pitch: number, yaw: number, headPitch = 0, headYaw = 0, roll = 0): void {
  const R = ctx.roles;
  const n = R.neck.length;
  for (let i = 0; i < n; i++) {
    const w = n > 1 ? (i === 0 ? 0.45 : 0.55 / (n - 1)) * 1 : 1;
    rotLocal(pose, R.neck[i], 'y', yaw / Math.max(1, n));
    rotLocal(pose, R.neck[i], 'x', pitch * w);
  }
  if (R.head >= 0) {
    rotLocal(pose, R.head, 'y', headYaw);
    rotLocal(pose, R.head, 'x', headPitch);
    rotLocal(pose, R.head, 'z', roll);
  }
}

/** Idle look-around / locomotion head nod. */
export function lookAround(ctx: AnimCtx, st: QuadState, pose: Pose, amount = 1): void {
  const p = st.p;
  const still = 1 - st.amp;
  const yaw = p.look * amount * still * glance(ctx.time, 4.2, ctx.seed + 1);
  const pitch = 0.18 * amount * still * glance(ctx.time, 5.1, ctx.seed + 2);
  const nod = st.g.headBob * st.amp * Math.sin(st.phase * TAU * 2 + 0.8);
  const carry = p.headCarry * st.wg;
  neckHead(ctx, pose, pitch * 0.6 + nod + carry - st.turn * 0, yaw * 0.6 + st.turn * 0.6, pitch * 0.4 - nod * 0.5, yaw * 0.4, 0);
}

/** Tail: hang + swish. lift < 0 raises it. */
export function tail(ctx: AnimCtx, st: QuadState, pose: Pose, lift = 0, swish = 1): void {
  const T = ctx.roles.tail;
  if (!T.length) return;
  const p = st.p;
  const t = ctx.time;
  const burst = 0.35 + 0.65 * clamp01(glance(t, 3.3, ctx.seed + 7) * 0.5 + 0.5);
  const run = st.amp;
  for (let i = 0; i < T.length; i++) {
    const k = (i + 1) / T.length;
    const sw = p.tailSwish * swish * burst * Math.sin(t * 2.3 - i * 0.7) * (0.4 + k * 0.6) * (1 - run * 0.6);
    rotLocal(pose, T[i], 'y', sw / T.length * 2);
    rotLocal(pose, T[i], 'x', (lift + p.tailCarry * run) / T.length + 0.04 * run * Math.sin(st.phase * TAU * 2 - i));
  }
}

/** Ears: occasional flicks and slow swivel. */
export function ears(ctx: AnimCtx, st: QuadState, pose: Pose, back = 0): void {
  const E = ctx.roles.ears;
  const p = st.p;
  for (let i = 0; i < E.length; i++) {
    const s = i === 0 ? 1 : -1;
    const swivel = 0.35 * glance(ctx.time, 3.7, ctx.seed + 20 + i);
    const flick = pulses(ctx.time, 2.6, ctx.seed + 30 + i, 0.22, 0.5) * p.earFlick;
    rotLocal(pose, E[i], 'y', s * (swivel * 0.6) + s * flick * 0.5);
    rotLocal(pose, E[i], 'z', -s * (flick * 0.4 + back * 0.6));
    rotLocal(pose, E[i], 'x', back * 0.5);
  }
}

/** Jaw open angle. */
export function jaw(ctx: AnimCtx, pose: Pose, open: number): void {
  if (ctx.roles.jaw >= 0) rotLocal(pose, ctx.roles.jaw, 'x', open);
}

/**
 * Bend the neck (and head) down so the muzzle reaches height `y` (model space).
 * rig.fk must be current for the chest. Returns the pitch used.
 *
 * The pitch range is scanned coarsely for the first pitch that reaches `y`,
 * then refined by bisection inside that bracket — robust when the muzzle
 * height is not monotonic in the pitch (past some angle a short neck curls
 * the head back under the chest). When `y` is out of reach the pitch of the
 * lowest muzzle position is used (best reach), never the curled extreme.
 */
export function reachMuzzle(ctx: AnimCtx, pose: Pose, y: number, headExtra = 0, yaw = 0, maxPitch = 2.2): number {
  const R = ctx.roles;
  if (!R.muzzle || R.head < 0) return 0;
  const n = R.neck.length;
  for (let i = 0; i < n; i++) _saved[i].copy(pose.q[R.neck[i]]);
  _saved[n].copy(pose.q[R.head]);
  const lo0 = -0.6;
  const STEPS = 10;
  let prev = lo0;
  let prevY = reachApply(ctx, pose, lo0, headExtra, yaw);
  if (prevY <= y) return lo0;
  let best = lo0, bestY = prevY;
  let hit = -1;
  for (let k = 1; k <= STEPS; k++) {
    const th = lo0 + ((maxPitch - lo0) * k) / STEPS;
    const my = reachApply(ctx, pose, th, headExtra, yaw);
    if (my <= y) {
      hit = th;
      break;
    }
    if (my < bestY) {
      bestY = my;
      best = th;
    }
    prev = th;
    prevY = my;
  }
  if (hit < 0) {
    // out of reach: refine around the lowest sample (golden-section style shrink)
    const step = (maxPitch - lo0) / STEPS;
    let a = Math.max(lo0, best - step), b = Math.min(maxPitch, best + step);
    for (let it = 0; it < 6; it++) {
      const m1 = a + (b - a) * 0.382, m2 = a + (b - a) * 0.618;
      if (reachApply(ctx, pose, m1, headExtra, yaw) < reachApply(ctx, pose, m2, headExtra, yaw)) b = m2;
      else a = m1;
    }
    const th = (a + b) * 0.5;
    reachApply(ctx, pose, th, headExtra, yaw);
    return th;
  }
  let lo = prev, hi = hit;
  void prevY;
  for (let it = 0; it < 9; it++) {
    const mid = (lo + hi) * 0.5;
    if (reachApply(ctx, pose, mid, headExtra, yaw) > y) lo = mid;
    else hi = mid;
  }
  reachApply(ctx, pose, hi, headExtra, yaw);
  return hi;
}

function reachApply(ctx: AnimCtx, pose: Pose, th: number, headExtra: number, yaw: number): number {
  const R = ctx.roles;
  const rig = ctx.rig;
  const n = R.neck.length;
  for (let i = 0; i < n; i++) {
    pose.q[R.neck[i]].copy(_saved[i]);
    rotLocal(pose, R.neck[i], 'y', yaw / Math.max(1, n));
    rotLocal(pose, R.neck[i], 'x', th * (i === 0 ? 0.62 : 0.38 / Math.max(1, n - 1)));
    rig.fkBone(pose, R.neck[i]);
  }
  // the head counter-rotates so it ends up roughly vertical, not tucked
  pose.q[R.head].copy(_saved[n]);
  rotLocal(pose, R.head, 'x', -th * 0.5 + headExtra);
  rig.fkBone(pose, R.head);
  return rig.pointOn(R.head, R.muzzle!, _M).y;
}
const _saved = Array.from({ length: 12 }, () => new THREE.Quaternion());

/** Lie down (sternal). headMode: 'up' resting awake, 'down' asleep. */
export function lie(ctx: AnimCtx, st: QuadState, pose: Pose, headMode: 'up' | 'down'): void {
  const p = st.p;
  const L = p.lie;
  const R = ctx.roles;
  const rig = ctx.rig;
  const hips = R.root;
  const dropH = st.hipsY - L.hipsY;
  pose.p[hips].y -= dropH;
  // pitch the body so the chest ends at chestY
  const dz = Math.max(0.1, st.chestZ - st.hipsZ);
  const pitch = Math.atan2(st.chestY - L.chestY - dropH, dz);
  rotParent(pose, hips, 'x', pitch);
  // slow deep breathing
  const br = Math.sin(ctx.time * TAU * 0.2);
  if (R.chest >= 0) rotLocal(pose, R.chest, 'x', p.breath * 1.5 * br);
  rig.fk(pose);
  for (const leg of st.legs) {
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    const reach = leg.reach;
    if (leg.front) {
      if (L.front === 'tuck') {
        _A.set(H.x * 1.05, Math.max(0.04, leg.footVec.length() * 0.18), H.z + reach * (L.carpusZ ?? 0.42));
        placeLeg(ctx, st, pose, leg, _A, Math.PI * 0.52, Math.PI * 0.75);
      } else {
        _A.set(H.x * 0.95, Math.max(0.03, leg.footVec.length() * 0.25), H.z + reach * 0.62);
        placeLeg(ctx, st, pose, leg, _A, -Math.PI * 0.5, -Math.PI * 0.42);
      }
    } else {
      _A.set(H.x + leg.side * L.hindSplay, Math.max(0.04, leg.footVec.length() * 0.14), H.z + reach * (L.hockZ ?? -0.3));
      placeLeg(ctx, st, pose, leg, _A, -Math.PI * 0.47, -Math.PI * 0.4);
    }
  }
  rig.fk(pose);
  if (headMode === 'down') {
    reachMuzzle(ctx, pose, L.headRest, 0.25, 0.25 * Math.sin(ctx.seed));
  } else {
    lookAroundStill(ctx, pose, 0.7);
    neckHead(ctx, pose, 0.12, 0, 0.05, 0);
  }
  tail(ctx, st, pose, 0.25, 0.4);
  ears(ctx, st, pose, headMode === 'down' ? 0.4 : 0);
}

/** Look-around for poses without locomotion. */
export function lookAroundStill(ctx: AnimCtx, pose: Pose, amount: number): void {
  const yaw = 0.45 * amount * glance(ctx.time, 4.6, ctx.seed + 1);
  const pitch = 0.12 * amount * glance(ctx.time, 5.3, ctx.seed + 2);
  neckHead(ctx, pose, pitch * 0.6, yaw * 0.6, pitch * 0.4, yaw * 0.4);
}

// ---------------------------------------------------------------------------
// default actions

export function standingBase(ctx: AnimCtx, st: QuadState, pose: Pose, frontReach = 0): void {
  body(ctx, st, pose);
  ctx.rig.fk(pose);
  legs(ctx, st, pose, frontReach);
}

export function actIdle(ctx: AnimCtx, st: QuadState, pose: Pose): void {
  standingBase(ctx, st, pose);
  lookAround(ctx, st, pose, 1);
  tail(ctx, st, pose, 0, 1);
  ears(ctx, st, pose);
}

export function actWalk(ctx: AnimCtx, st: QuadState, pose: Pose): void {
  standingBase(ctx, st, pose);
  lookAround(ctx, st, pose, 0.6);
  tail(ctx, st, pose, 0, 0.7);
  ears(ctx, st, pose, st.wg * 0.5);
}

export function actEat(ctx: AnimCtx, st: QuadState, pose: Pose): void {
  const p = st.p;
  standingBase(ctx, st, pose, p.grazeReach * 0.25 * (1 - st.amp));
  ctx.rig.fk(pose);
  // every ~7 s lift the head a little to look around while chewing
  const up = pulses(ctx.time, 7, ctx.seed + 40, 2.2, 0.55);
  const chew = Math.sin(ctx.time * TAU * 1.4);
  const y = 0.03 + up * 0.25 * (ctx.roles.muzzle ? ctx.roles.muzzle.y : 1);
  reachMuzzle(ctx, pose, y, 0.15 + chew * 0.03, 0.15 * Math.sin(ctx.time * 0.4 + ctx.seed));
  jaw(ctx, pose, 0.05 + 0.05 * Math.max(0, chew));
  tail(ctx, st, pose, 0, 1);
  ears(ctx, st, pose);
}

export function actDrink(ctx: AnimCtx, st: QuadState, pose: Pose): void {
  standingBase(ctx, st, pose, st.p.grazeReach * 0.35);
  ctx.rig.fk(pose);
  const lap = Math.sin(ctx.time * TAU * 1.1);
  reachMuzzle(ctx, pose, 0.0 + lap * 0.01, 0.25);
  jaw(ctx, pose, 0.04 + 0.04 * Math.max(0, lap));
  tail(ctx, st, pose, 0, 0.6);
  ears(ctx, st, pose, 0.2);
}

export function actSleep(ctx: AnimCtx, st: QuadState, pose: Pose): void {
  lie(ctx, st, pose, 'down');
}

export function actRest(ctx: AnimCtx, st: QuadState, pose: Pose): void {
  lie(ctx, st, pose, 'up');
}

/** Cat-style sit: hind legs folded, front legs straight, body pitched up. */
export function actSit(ctx: AnimCtx, st: QuadState, pose: Pose): void {
  const p = st.p;
  const R = ctx.roles;
  const rig = ctx.rig;
  const dropH = st.hipsY - p.lie.hipsY * 0.9;
  pose.p[R.root].y -= dropH;
  pose.p[R.root].z += dropH * 0.25;
  const dz = Math.max(0.1, st.chestZ - st.hipsZ);
  // the chest stays on the straight forelegs (raised by their juvenile lift)
  const pitch = -Math.asin(clamp((dropH - (st.chestY - st.chestY * 0.98) + st.liftF) / dz, -0.95, 0.95));
  rotParent(pose, R.root, 'x', pitch * 0.92);
  if (R.chest >= 0) rotLocal(pose, R.chest, 'x', -pitch * 0.25 + p.breath * Math.sin(ctx.time * TAU * 0.25));
  rig.fk(pose);
  for (const leg of st.legs) {
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    if (leg.front) {
      _C.copy(leg.r.contact);
      _C.z = H.z - 0.02;
      const slant = Math.atan2(H.z - _C.z, Math.max(0.05, H.y - _C.y));
      plantLeg(ctx, st, pose, leg, _C, slant * 0.5, 0);
    } else {
      const reach = leg.reach;
      _A.set(H.x + leg.side * p.lie.hindSplay * 1.4, Math.max(0.04, leg.footVec.length() * 0.14), H.z - reach * 0.18);
      placeLeg(ctx, st, pose, leg, _A, -Math.PI * 0.47, -Math.PI * 0.42);
    }
  }
  // keep the head level-ish: counter the body pitch
  neckHead(ctx, pose, -pitch * 0.55, 0, -pitch * 0.35, 0);
  lookAroundStill(ctx, pose, 0.8);
  tail(ctx, st, pose, 0.3, 0.6);
  ears(ctx, st, pose);
}

export function actPlay(ctx: AnimCtx, st: QuadState, pose: Pose): void {
  const t = ctx.time;
  const R = ctx.roles;
  standingBase(ctx, st, pose);
  // frisky: little bounces / bucks and head tosses
  const hop = Math.max(0, Math.sin(t * TAU * 1.3));
  pose.p[R.root].y += hop * 0.04 * st.hipsY * (1 - st.amp * 0.5);
  rotParent(pose, R.root, 'x', -0.08 * Math.sin(t * TAU * 1.3 + 0.8));
  ctx.rig.fk(pose);
  legs(ctx, st, pose);
  const toss = Math.sin(t * TAU * 0.9);
  neckHead(ctx, pose, -0.25 * toss, 0.4 * Math.sin(t * 1.7), 0.2 * toss, 0.2 * Math.sin(t * 2.3));
  tail(ctx, st, pose, -0.6, 1.4);
  ears(ctx, st, pose, 0.3 * hop);
}

export function actSocial(ctx: AnimCtx, st: QuadState, pose: Pose): void {
  standingBase(ctx, st, pose);
  const t = ctx.time;
  const side = ctx.rand > 0.5 ? 1 : -1;
  const nuzzle = Math.sin(t * TAU * 0.35);
  neckHead(ctx, pose, 0.35 + 0.1 * nuzzle, side * 0.55, 0.2, side * 0.3 + 0.1 * nuzzle);
  jaw(ctx, pose, 0.04 * Math.max(0, Math.sin(t * TAU * 1.6)));
  tail(ctx, st, pose, 0, 0.8);
  ears(ctx, st, pose);
}

export function actCall(ctx: AnimCtx, st: QuadState, pose: Pose): void {
  const p = st.p;
  standingBase(ctx, st, pose);
  const at = ctx.actionTime;
  const env = smooth(0, 0.6, at) * (1 - smooth(p.callDuration - 0.6, p.callDuration, at));
  const open = smooth(0.4, 0.8, at) * (1 - smooth(p.callDuration - 0.8, p.callDuration - 0.3, at));
  const pulse = 0.85 + 0.15 * Math.sin(at * TAU * 3);
  neckHead(ctx, pose, p.callHead * env * 0.7, 0, p.callHead * env * 0.3 - open * 0.1, 0);
  jaw(ctx, pose, p.callJaw * open * pulse);
  tail(ctx, st, pose, -0.2 * env, 0.5);
  ears(ctx, st, pose, 0.6 * env);
}

export function actSwim(ctx: AnimCtx, st: QuadState, pose: Pose): void {
  const p = st.p;
  const R = ctx.roles;
  const rig = ctx.rig;
  const t = ctx.time;
  pose.p[R.root].y -= p.swimSink + 0.015 * Math.sin(t * TAU * 0.5);
  rotParent(pose, R.root, 'x', -0.08);
  rig.fk(pose);
  // paddling: circular foot paths relative to the hips, trot timing
  const cyc = t * (0.9 + st.speed * 0.4);
  for (const leg of st.legs) {
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    const ph = (cyc + p.trot.offsets[leg.idx]) * TAU;
    const len = leg.scaledLen;
    const rad = len * 0.16;
    _A.set(H.x, H.y - len * 0.62 + Math.sin(ph) * rad * 0.6, H.z + Math.cos(ph) * rad + (leg.front ? len * 0.1 : -len * 0.15));
    placeLeg(ctx, st, pose, leg, _A, (leg.front ? 0.6 : -0.4) + Math.sin(ph) * 0.4, 0.5);
  }
  neckHead(ctx, pose, -0.35, 0.2 * Math.sin(t * 0.5 + ctx.seed), -0.1, 0);
  tail(ctx, st, pose, -0.3, 0.6);
  ears(ctx, st, pose, 0.3);
}

/** The standard quadruped driver. Spread it and override actions per species. */
export function quadrupedDriver(p: QuadParams): AnimDriver<QuadState> {
  return {
    init: (ctx) => initQuad(ctx, p),
    pre: advanceGait,
    actions: {
      idle: actIdle,
      walk: actWalk,
      eat: actEat,
      drink: actDrink,
      sleep: actSleep,
      rest: actRest,
      sit: p.sitStyle === 'cat' ? actSit : actRest,
      play: actPlay,
      social: actSocial,
      call: actCall,
      swim: actSwim,
    },
    aliases: { run: 'walk', leave: 'walk' },
    fade: 0.4,
    fades: { sleep: 1.1, rest: 1.0, sit: 0.8 },
    // getting up is slower than the default 0.4 s so the folded legs never
    // sweep through the ground while the body rises
    transitions: { 'sleep>*': 1.3, 'rest>*': 1.1, 'sit>*': 0.8, 'sleep>rest': 0.9, 'rest>sleep': 0.9 },
  };
}
