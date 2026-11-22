// 'primate' rig kind (gorilla): a quadSkeleton whose front legs are arms
// (shoulder → elbow → wrist → knuckles) and whose hind legs are short
// plantigrade legs. The driver knuckle-walks with the quadruped gait engine
// and adds the upright repertoire: sitting (eat with hands to the mouth,
// grooming), bipedal chest-beating display, belly-down sleeping, drinking
// crouched over the water and a bouncy play.

import * as THREE from 'three';
import { Pose, blendPoses, rotLocal, rotParent } from '../../rig/rig';
import type { AnimCtx, AnimDriver } from '../../types';
import {
  LegRT,
  QuadState,
  advanceGait,
  body,
  initQuad,
  jaw,
  lookAround,
  lookAroundStill,
  neckHead,
  plantLeg,
  reachMuzzle,
  type QuadParams,
} from '../../anim/quadruped';
import { TAU, fract, pulses, smooth, wander } from '../../anim/util';
import { envelope, moodSwitch, reachLimb, stepCycle, worldQuat, type StepOut } from './common';

export interface ApeParams {
  quad: QuadParams;
  /** Root (pelvis joint) height when sitting on the haunches (m). */
  sitHipsY: number;
  /** Root pitch when sitting (rad, negative = trunk up). */
  sitPitch: number;
  /** Root pitch when standing on two legs. */
  standPitch: number;
  /** Root lift when standing bipedally (m). */
  standLift: number;
  /** Root height when lying on the belly. */
  proneHipsY: number;
  /** Mouth (rest, model space) — hands are brought here when eating. */
  mouth: THREE.Vector3;
  /** Rest-space point on the chest where the cupped hands strike (left side). */
  chestHit: THREE.Vector3;
  /** Rest-space outward normal of the chest at that point. */
  chestNormal: THREE.Vector3;
  /** Seconds of the chest-beat display. */
  callDuration: number;
}

export class ApeState {
  readonly q: QuadState;
  readonly p: ApeParams;
  /** Arms (FL, FR) and legs (HL, HR) in that order. */
  readonly arms: LegRT[] = [];
  readonly legs: LegRT[] = [];
  readonly restHips = new THREE.Vector3();
  /** Scratch pose + blend lists for the idle stand ↔ sit mix (per instance, no per-frame allocation). */
  readonly scratch: Pose;
  readonly blendList: Pose[];
  readonly blendW: number[] = [0, 0];
  constructor(q: QuadState, p: ApeParams, bones: number) {
    this.q = q;
    this.p = p;
    this.scratch = new Pose(bones);
    this.blendList = [this.scratch, this.scratch];
  }
}

const S: StepOut = { dz: 0, lift: 0, swing: -1, stance: -1 };
const _C = new THREE.Vector3();
const _T = new THREE.Vector3();
const _N = new THREE.Vector3();
const _M = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _hq = new THREE.Quaternion();
const _hq2 = new THREE.Quaternion();
const _Zax = new THREE.Vector3(0, 0, 1);

function init(ctx: AnimCtx, p: ApeParams): ApeState {
  const st = new ApeState(initQuad(ctx, p.quad), p, ctx.def.count);
  for (const leg of st.q.legs) (leg.front ? st.arms : st.legs).push(leg);
  ctx.def.restVec(ctx.roles.root, st.restHips);
  return st;
}

// ---------------------------------------------------------------------------
// Knuckle-walking

/** Gait legs: knuckle-walking hands and plantigrade feet. rig.fk must be current. */
function gaitLimbs(ctx: AnimCtx, st: ApeState, pose: Pose, handsFwd = 0): void {
  const q = st.q;
  const g = q.g;
  const rig = ctx.rig;
  for (const leg of q.legs) {
    const lp = fract(q.phase + g.offsets[leg.idx]);
    stepCycle(lp, g.duty, q.stride * g.duty * q.amp, S);
    _C.copy(leg.r.contact);
    _C.z += S.dz + (leg.front ? handsFwd : 0);
    _C.y += g.stepHeight * q.amp * S.lift * (leg.front ? 1 : 0.75);
    if (leg.r.scap >= 0) {
      // shoulder roll: the scapula swings with the arm (rolling silverback gait)
      rotLocal(pose, leg.r.scap, 'x', -Math.atan2(S.dz, leg.legLen) * 0.6);
      rotLocal(pose, leg.r.scap, 'z', leg.side * 0.05 * q.amp * S.lift);
      rig.fkBone(pose, leg.r.scap);
    }
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    const slant = Math.atan2(H.z - _C.z, Math.max(0.05, H.y - _C.y));
    if (leg.front) {
      // the hand stays roughly in line with the forearm; in swing the wrist
      // flexes so the curled fingers trail, then reach forward to land
      const sw = S.swing >= 0 ? Math.sin(Math.PI * S.swing) * q.amp : 0;
      plantLeg(ctx, null, pose, leg, _C, slant * 0.55 + 0.75 * sw, slant * 0.25 + 1.1 * sw);
    } else {
      // plantigrade foot: flat in stance, heel peels off before the swing,
      // toes droop through the swing and come up for the heel strike
      let fp = 0;
      if (S.stance >= 0) fp = 0.6 * q.amp * smooth(0.55, 1, S.stance);
      else fp = 0.6 * q.amp * (1 - smooth(0, 0.4, S.swing)) - 0.18 * q.amp * smooth(0.55, 1, S.swing) * (1 - smooth(0.92, 1, S.swing));
      plantLeg(ctx, null, pose, leg, _C, fp, 0);
    }
  }
}

function quadBase(ctx: AnimCtx, st: ApeState, pose: Pose, handsFwd = 0): void {
  body(ctx, st.q, pose);
  // heavy, rolling shoulders: extra chest roll in step with the arms
  const R = ctx.roles;
  const ph = st.q.phase * TAU;
  if (R.chest >= 0) rotLocal(pose, R.chest, 'z', 0.045 * st.q.amp * Math.sin(ph + 0.8));
  ctx.rig.fk(pose);
  gaitLimbs(ctx, st, pose, handsFwd);
}

function standIdle(ctx: AnimCtx, st: ApeState, pose: Pose): void {
  quadBase(ctx, st, pose);
  lookAround(ctx, st.q, pose, 1);
  // now and then a slow lip / jaw movement
  jaw(ctx, pose, 0.04 * pulses(ctx.time, 5, ctx.seed + 3, 1.2, 0.5));
}

/** Idle: gorillas spend much of their idle time sitting up — alternate standing on all fours and sitting. */
function actIdle(ctx: AnimCtx, st: ApeState, pose: Pose): void {
  const sit = moodSwitch(ctx.time, 13, ctx.seed + 77, 0.5, 1.4) * (1 - st.q.amp);
  if (sit <= 0.001) return standIdle(ctx, st, pose);
  if (sit >= 0.999) return actSit(ctx, st, pose);
  standIdle(ctx, st, pose);
  const s = st.scratch.reset();
  actSit(ctx, st, s);
  st.blendList[0] = pose;
  st.blendW[0] = 1 - sit;
  st.blendW[1] = sit;
  blendPoses(pose, st.blendList, st.blendW, 2);
}

function actWalk(ctx: AnimCtx, st: ApeState, pose: Pose): void {
  quadBase(ctx, st, pose);
  lookAround(ctx, st.q, pose, 0.5);
}

// ---------------------------------------------------------------------------
// Upright postures

/**
 * Raise the trunk about the pelvis: `pitch` (negative = up), root height `y`.
 * Gives the spine a slight slouch and counter-rotates the head so it looks
 * ahead. rig.fk is current on return.
 */
function trunk(ctx: AnimCtx, st: ApeState, pose: Pose, y: number, pitch: number, slouch: number, dz = 0): void {
  const R = ctx.roles;
  pose.p[R.root].y += y - st.restHips.y;
  pose.p[R.root].z += dz;
  rotParent(pose, R.root, 'x', pitch);
  for (const b of R.spine) rotLocal(pose, b, 'x', slouch);
  if (R.chest >= 0) rotLocal(pose, R.chest, 'x', slouch * 0.6 + 0.012 * Math.sin(ctx.time * TAU * 0.25));
  ctx.rig.fk(pose);
}

/** Head counter-rotation so it faces forward after the trunk pitch (plus extra pitch). */
function headLevel(ctx: AnimCtx, pose: Pose, trunkPitch: number, extra: number, yaw = 0): void {
  const k = -trunkPitch;
  neckHead(ctx, pose, k * 0.55 + extra * 0.5, yaw * 0.5, k * 0.45 + extra * 0.5, yaw * 0.5);
}

/** Feet planted in front of the pelvis for sitting (knees up and out). */
function sitLegs(ctx: AnimCtx, st: ApeState, pose: Pose, fwd: number, spread: number): void {
  const rig = ctx.rig;
  const H = rig.wp[ctx.roles.root];
  for (const leg of st.legs) {
    _C.set(leg.r.contact.x * spread, 0, H.z + fwd);
    rig.fkBone(pose, leg.r.upper);
    _pole.set(leg.side * 0.6, 0.4, 0.2);
    reachLimbFoot(ctx, pose, leg, _C, _pole, -0.05);
  }
}

/** Plant a plantigrade foot flat at C, knee steered by `poleBias`. */
function reachLimbFoot(ctx: AnimCtx, pose: Pose, leg: LegRT, C: THREE.Vector3, poleBias: THREE.Vector3, pitch: number): void {
  // ankle = contact + rest (toe→contact) + (ankle→toe) vectors, pitched
  _T.copy(leg.toeVec).add(leg.footVec).applyAxisAngle(_X, pitch).add(C);
  worldQuat(_hq, pitch, 0, 0);
  reachLimb(ctx, pose, leg, _T, poleBias, _hq);
  if (leg.r.toe >= 0) ctx.rig.setWorldRot(pose, leg.r.toe, _hq2.identity());
}
const _X = new THREE.Vector3(1, 0, 0);

/** Arm reach with the wrist at `target`, hand orientation (model space) pitch / yaw / roll. */
function armTo(ctx: AnimCtx, pose: Pose, arm: LegRT, target: THREE.Vector3, pitch: number, yaw: number, roll: number, out: number, back = 0.3): void {
  _pole.set(arm.side * out, -0.2, -back);
  worldQuat(_hq, pitch, yaw * arm.side, roll * arm.side);
  ctx.rig.fkBone(pose, arm.r.upper);
  reachLimb(ctx, pose, arm, target, _pole, _hq);
}

function sitBase(ctx: AnimCtx, st: ApeState, pose: Pose, lean = 0): void {
  const p = st.p;
  const pitch = p.sitPitch + lean;
  trunk(ctx, st, pose, p.sitHipsY, pitch, 0.08, -0.06);
  sitLegs(ctx, st, pose, 0.42, 1.25);
}

function actSit(ctx: AnimCtx, st: ApeState, pose: Pose): void {
  const t = ctx.time;
  // slow sway / shifting while sitting
  const sway = 0.03 * wander(t * 0.2, ctx.seed + 5);
  sitBase(ctx, st, pose, 0.04 * wander(t * 0.13, ctx.seed + 9));
  rotParent(pose, ctx.roles.root, 'z', sway);
  ctx.rig.fk(pose);
  sitLegs(ctx, st, pose, 0.42, 1.25);
  // arms: one forearm resting on the knee, the other hand on the ground;
  // sometimes both hands in the lap
  const lap = moodSwitch(t, 9, ctx.seed + 31, 0.4, 1.5);
  const rig = ctx.rig;
  for (const arm of st.arms) {
    const knee = rig.wp[st.legs[arm.side > 0 ? 0 : 1].r.lower];
    const onKnee = arm.side > 0 ? 1 - lap : lap * 0.5;
    _C.copy(knee);
    _C.y += 0.05;
    _C.z += 0.06;
    _C.x -= arm.side * 0.02;
    _M.set(arm.side * 0.36, arm.footVec.length() + 0.04, rig.wp[ctx.roles.root].z + 0.3);
    _C.lerp(_M, 1 - onKnee);
    armTo(ctx, pose, arm, _C, 0.35 * onKnee, 0.3, 0, 0.3, 0.7);
  }
  headLevel(ctx, pose, st.p.sitPitch, 0.1);
  lookAroundStill(ctx, pose, 0.9);
}

/** Bring a hand to the mouth: k = 0 (lap) … 1 (at the lips). */
function handToMouth(ctx: AnimCtx, st: ApeState, pose: Pose, arm: LegRT, k: number): void {
  const rig = ctx.rig;
  const R = ctx.roles;
  // mouth position after fk
  rig.pointOn(R.head, st.p.mouth, _M);
  // wrist sits below / in front of the lips, the curled fingers hold the food at the mouth
  _T.set(_M.x + arm.side * 0.05, _M.y - 0.14, _M.z + 0.07);
  // lap position
  _C.set(arm.side * 0.12, st.p.sitHipsY + 0.12, rig.wp[R.root].z + 0.33);
  _C.lerp(_T, k);
  armTo(ctx, pose, arm, _C, 0.4 + 2.0 * k, 0.25 + 0.2 * k, 0, 0.9, 0.1);
}

function actEat(ctx: AnimCtx, st: ApeState, pose: Pose): void {
  const t = ctx.time;
  sitBase(ctx, st, pose, 0.1);
  // alternate hands: pick food from the lap / ground and bring it up
  const period = 3.2;
  const c = (t + ctx.rand * period) / period;
  const cyc = Math.floor(c);
  const f = c - cyc;
  const lift = smooth(0.1, 0.38, f) * (1 - smooth(0.62, 0.9, f));
  const active = cyc % 2 === 0 ? 0 : 1;
  // head first (the hand goes to where the mouth ends up): tips down to look
  // at the food, comes forward to meet the hand; chewing
  const chew = Math.max(0, Math.sin(t * TAU * 1.6));
  headLevel(ctx, pose, st.p.sitPitch + 0.1, 0.18 - lift * 0.15, 0.1 * wander(t * 0.3, ctx.seed));
  jaw(ctx, pose, 0.03 + 0.07 * chew * (0.4 + 0.6 * smooth(0.5, 0.8, f)));
  ctx.rig.fk(pose);
  for (let i = 0; i < st.arms.length; i++) {
    const arm = st.arms[i];
    if (i === active) handToMouth(ctx, st, pose, arm, lift);
    else {
      // the other hand rummages in the lap / on the ground in front
      const rummage = 0.03 * Math.sin(t * TAU * 1.3 + i);
      _C.set(arm.side * 0.2, 0.18 + rummage, ctx.rig.wp[ctx.roles.root].z + 0.48);
      armTo(ctx, pose, arm, _C, 0.35, 0.3, 0, 0.8);
    }
  }
}

function actSocial(ctx: AnimCtx, st: ApeState, pose: Pose): void {
  // grooming: sitting, one hand reaching forward and picking, head bent to look
  const t = ctx.time;
  sitBase(ctx, st, pose, 0.22);
  const rig = ctx.rig;
  const side = ctx.rand > 0.5 ? 0 : 1;
  const pick = Math.sin(t * TAU * 1.1);
  for (let i = 0; i < st.arms.length; i++) {
    const arm = st.arms[i];
    if (i === side) {
      _C.set(arm.side * 0.1 + 0.03 * Math.sin(t * 0.7), 0.52 + 0.04 * pick, rig.wp[ctx.roles.root].z + 0.62 + 0.03 * Math.sin(t * 1.3));
      armTo(ctx, pose, arm, _C, 1.6 + 0.25 * pick, 0.4, 0, 0.8, 0.1);
    } else {
      _C.set(arm.side * 0.18, 0.5, rig.wp[ctx.roles.root].z + 0.55);
      armTo(ctx, pose, arm, _C, 1.4, 0.5, 0.3, 0.8, 0.1);
    }
  }
  headLevel(ctx, pose, st.p.sitPitch + 0.22, 0.35, (side === 0 ? 0.15 : -0.15) + 0.1 * Math.sin(t * 0.5));
}

/** Bipedal chest-beat display. */
function actCall(ctx: AnimCtx, st: ApeState, pose: Pose): void {
  const p = st.p;
  const at = ctx.actionTime;
  const dur = p.callDuration;
  const up = envelope(at, dur, 0.55, 0.6);
  if (up <= 0.001) {
    // before / after the display: on all fours (the envelope ends there, no pop)
    standIdle(ctx, st, pose);
    return;
  }
  const R = ctx.roles;
  const rig = ctx.rig;
  // rise onto the legs (knees slightly bent), trunk upright, chest out
  trunk(ctx, st, pose, st.restHips.y + p.standLift * up, p.standPitch * up, -0.05 * up, -0.04 * up);
  rotParent(pose, R.root, 'z', 0.03 * Math.sin(at * TAU * 1.5) * up);
  rig.fk(pose);
  for (const leg of st.legs) {
    _C.copy(leg.r.contact);
    _C.x *= 1 + 0.15 * up;
    _C.z += 0.02 * up;
    rig.fkBone(pose, leg.r.upper);
    _pole.set(leg.side * 0.5, 0, 0.6);
    reachLimbFoot(ctx, pose, leg, _C, _pole, 0);
  }
  // beating: alternate cupped hands against the chest, ~5 slaps / s
  const beat = smooth(0.5, 0.75, at) * (1 - smooth(dur - 0.85, dur - 0.55, at));
  const rate = 2.6;
  for (const arm of st.arms) {
    const ph = at * TAU * rate + (arm.side > 0 ? 0 : Math.PI);
    const away = 0.5 + 0.5 * Math.cos(ph); // 0 = hit
    rig.pointOn(R.chest, _N.set(p.chestHit.x * arm.side, p.chestHit.y, p.chestHit.z), _M);
    _T.set(p.chestNormal.x * arm.side, p.chestNormal.y, p.chestNormal.z).applyQuaternion(rig.wq[R.chest]);
    // wrist sits below the striking palm
    _C.copy(_M).addScaledVector(_T, 0.03 + 0.16 * away * beat);
    _C.y -= 0.1;
    // before the beating starts the hands come up from the ground
    if (beat < 1) {
      _M.set(arm.side * 0.34, 0.45, rig.wp[R.root].z + 0.25);
      _C.lerp(_M, 1 - beat);
    }
    _pole.set(arm.side * 0.9, -0.3, -0.2);
    // palm toward the chest, fingers up and inward
    _hq.setFromAxisAngle(_Zax, -arm.side * (2.5 * beat));
    _hq2.setFromAxisAngle(_X, -0.25 * beat);
    _hq.multiply(_hq2);
    rig.fkBone(pose, arm.r.upper);
    reachLimb(ctx, pose, arm, _C, _pole, _hq);
  }
  // head up, mouth open in a hoot
  const hoot = smooth(0.35, 0.6, at) * (1 - smooth(dur - 0.8, dur - 0.4, at));
  headLevel(ctx, pose, p.standPitch * up, -0.25 * hoot, 0.12 * Math.sin(at * 2.3));
  jaw(ctx, pose, 0.22 * hoot * (0.8 + 0.2 * Math.sin(at * TAU * 4)));
}

/** Belly-down sleep: arms folded under the chin, legs tucked. */
function actSleep(ctx: AnimCtx, st: ApeState, pose: Pose): void {
  const p = st.p;
  const R = ctx.roles;
  const rig = ctx.rig;
  const t = ctx.time;
  const br = Math.sin(t * TAU * 0.18);
  pose.p[R.root].y += p.proneHipsY - st.restHips.y;
  pose.p[R.root].z -= 0.08;
  rotParent(pose, R.root, 'x', 0.5);
  rotParent(pose, R.root, 'z', 0.18);
  for (const b of R.spine) rotLocal(pose, b, 'x', -0.04);
  if (R.chest >= 0) rotLocal(pose, R.chest, 'x', 0.025 * br);
  rig.fk(pose);
  // arms folded under the head
  for (const arm of st.arms) {
    const H = rig.wp[arm.r.upper];
    _C.set(arm.side * 0.12, 0.08, H.z + 0.32);
    rig.fkBone(pose, arm.r.upper);
    _pole.set(arm.side * 1.0, 0.3, -0.2);
    worldQuat(_hq, -1.45, -arm.side * 1.2, arm.side * 0.2);
    reachLimb(ctx, pose, arm, _C, _pole, _hq);
  }
  // legs folded under, feet soles up
  for (const leg of st.legs) {
    const H = rig.wp[leg.r.upper];
    _C.set(H.x * 1.45, 0.1, H.z - 0.48);
    rig.fkBone(pose, leg.r.upper);
    _pole.set(leg.side * 0.7, -0.7, 0);
    worldQuat(_hq, 2.85, leg.side * 0.25, 0);
    reachLimb(ctx, pose, leg, _C, _pole, _hq);
  }
  // head resting on the forearms, turned slightly
  neckHead(ctx, pose, -0.35, 0.25 * Math.sin(ctx.seed), -0.25, 0.25, 0.15);
}

/** Crouched over the water, elbows out, lips to the surface. */
function actDrink(ctx: AnimCtx, st: ApeState, pose: Pose): void {
  const R = ctx.roles;
  const rig = ctx.rig;
  body(ctx, st.q, pose, 0);
  pose.p[R.root].y -= 0.16;
  pose.p[R.root].z -= 0.05;
  rotParent(pose, R.root, 'x', 0.45);
  rig.fk(pose);
  for (const leg of st.legs) {
    _C.copy(leg.r.contact);
    _C.z += 0.05;
    rig.fkBone(pose, leg.r.upper);
    _pole.set(leg.side * 0.4, 0, 1);
    reachLimbFoot(ctx, pose, leg, _C, _pole, 0);
  }
  for (const arm of st.arms) {
    _C.set(arm.side * 0.38, 0.03, arm.r.contact.z + 0.1);
    rig.fkBone(pose, arm.r.upper);
    _pole.set(arm.side * 1.2, 0.2, -0.3);
    worldQuat(_hq, 1.35, arm.side * 0.4, 0);
    reachLimb(ctx, pose, arm, _C, _pole, _hq);
  }
  const lap = Math.sin(ctx.time * TAU * 0.9);
  reachMuzzle(ctx, pose, 0.03 + 0.015 * lap, 0.1, 0, 1.4);
  jaw(ctx, pose, 0.05 + 0.04 * Math.max(0, lap));
}

/** Play: bouncing on all fours, slapping the ground, head tosses; now and then sits and rocks. */
function actPlay(ctx: AnimCtx, st: ApeState, pose: Pose): void {
  const t = ctx.time;
  const R = ctx.roles;
  const rig = ctx.rig;
  const hop = Math.max(0, Math.sin(t * TAU * 1.4));
  body(ctx, st.q, pose);
  pose.p[R.root].y += 0.06 * hop * (1 - st.q.amp * 0.5);
  rotParent(pose, R.root, 'x', -0.12 * hop);
  rotParent(pose, R.root, 'z', 0.08 * Math.sin(t * TAU * 0.7));
  rig.fk(pose);
  gaitLimbs(ctx, st, pose, 0.04);
  // a playful slap: one arm lifts high and comes down
  const slapSide = Math.floor(t / 1.8) % 2;
  const sl = Math.max(0, Math.sin(((t % 1.8) / 1.8) * Math.PI));
  const arm = st.arms[slapSide];
  if (arm && st.q.amp < 0.5) {
    rig.fkBone(pose, arm.r.upper);
    const H = rig.wp[arm.r.upper];
    _C.set(H.x + arm.side * 0.12, 0.17 + 0.55 * sl, H.z + 0.12 + 0.15 * sl);
    armTo(ctx, pose, arm, _C, 0.4 - 1.2 * sl, 0.2, 0, 0.8);
  }
  neckHead(ctx, pose, -0.25 * Math.sin(t * TAU * 0.9), 0.4 * Math.sin(t * 1.7), 0.15, 0.2 * Math.sin(t * 2.3));
  jaw(ctx, pose, 0.12 * hop);
}

export function apeDriver(p: ApeParams): AnimDriver<ApeState> {
  return {
    init: (ctx) => init(ctx, p),
    pre: (ctx, st) => advanceGait(ctx, st.q),
    actions: {
      idle: actIdle,
      walk: actWalk,
      eat: actEat,
      drink: actDrink,
      sleep: actSleep,
      sit: actSit,
      play: actPlay,
      social: actSocial,
      call: actCall,
    },
    aliases: { run: 'walk', leave: 'walk', rest: 'sit', swim: 'walk' },
    fade: 0.45,
    fades: { sleep: 1.3, sit: 0.9, eat: 0.9, social: 0.9, call: 0.35, drink: 0.8 },
  };
}

