// 'bird' rig kind for long-legged waders (flamingo): a horizontal body on two
// long legs whose visible "backward knee" is the ankle, a long S-curved neck
// of many segments and folded wings. The neck is posed by blending target
// shapes (relaxed S, stretched up, reaching down with the head upside down,
// folded back over the body) expressed as per-segment elevations, so any mix
// of postures stays a smooth curve.
//
// Behaviour: high-stepping walk, resting on ONE leg with the head tucked on
// the back, preening, filter-feeding with the head upside-down sweeping side
// to side (and treading the mud), sitting with the legs folded under (ankles
// poking out behind), head-flagging honk with a wing salute, marching display.

import * as THREE from 'three';
import { Pose, rotLocal, rotParent } from '../../rig/rig';
import type { AnimCtx, AnimDriver } from '../../types';
import { LegRT, jaw, placeLeg } from '../../anim/quadruped';
import { TAU, clamp, damp, fract, glance, pulses, smooth } from '../../anim/util';
import { envelope, moodSwitch, reachLimb, stepCycle, type StepOut } from './common';

/** A neck posture: elevation (deg, body frame, 0 = forward, 90 = up) per neck segment + head pitch. */
export interface NeckShape {
  elev: number[];
  /** Head pitch relative to its rest orientation (rad, + = down). */
  head: number;
}

export interface WaderParams {
  /** Rest elevation (deg) of each neck segment (one per neck bone). */
  restElev: number[];
  up: NeckShape;
  down: NeckShape;
  tuck: NeckShape;
  /** Full stride (m) at walkSpeed. */
  stride: number;
  walkSpeed: number;
  runSpeed: number;
  /** Foot lift at walking speed (m) — high-stepping. */
  lift: number;
  /** Lifted foot (MTP joint) target relative to the hip side when standing on one leg (model space, left side). */
  tuckFoot: THREE.Vector3;
  /** Root height when sitting on the folded legs. */
  sitY: number;
  /** Body pitch when feeding (rad, + = head end down). */
  feedPitch: number;
  /** Root drop when feeding (m). */
  feedDrop: number;
}

export class WaderState {
  phase = 0;
  speed = 0;
  amp = 0;
  run = 0;
  stride = 0;
  hipsY = 0;
  readonly legs: LegRT[] = [];
  /** Wing chains (L, R): shoulder, wrist. */
  readonly wings: number[][] = [];
  /** Per-bone local pitch of each preset (neck bones…, head). */
  readonly up: Float32Array;
  readonly down: Float32Array;
  readonly tuck: Float32Array;
  /** Scratch: blended local pitches. */
  readonly mix: Float32Array;
  constructor(readonly p: WaderParams, n: number) {
    this.up = new Float32Array(n + 1);
    this.down = new Float32Array(n + 1);
    this.tuck = new Float32Array(n + 1);
    this.mix = new Float32Array(n + 1);
  }
}

const D2R = Math.PI / 180;
const S: StepOut = { dz: 0, lift: 0, swing: -1, stance: -1 };
const _C = new THREE.Vector3();
const _A = new THREE.Vector3();

/** Convert a neck shape to local per-bone pitches (relative to the rest pose). */
function bake(out: Float32Array, rest: number[], shape: NeckShape): void {
  let prev = 0;
  for (let i = 0; i < rest.length; i++) {
    const world = (rest[i] - shape.elev[i]) * D2R;
    out[i] = world - prev;
    prev = world;
  }
  out[rest.length] = shape.head - prev;
}

function init(ctx: AnimCtx, p: WaderParams): WaderState {
  const n = ctx.roles.neck.length;
  const st = new WaderState(p, n);
  (['HL', 'HR'] as const).forEach((id, i) => {
    const r = ctx.roles.legs[id];
    if (r) st.legs.push(new LegRT(ctx.rig, id, i, r));
  });
  for (const s of ['L', 'R'] as const) {
    const a = ctx.roles.arms[s];
    if (a) st.wings.push([a.upper, a.lower]);
  }
  bake(st.up, p.restElev, p.up);
  bake(st.down, p.restElev, p.down);
  bake(st.tuck, p.restElev, p.tuck);
  st.hipsY = ctx.def.rest[ctx.roles.root * 3 + 1];
  st.phase = ctx.rand;
  return st;
}

function pre(ctx: AnimCtx, st: WaderState): void {
  const p = st.p;
  st.speed += (ctx.speed - st.speed) * damp(0.15, ctx.dt);
  const v = st.speed;
  st.amp = smooth(0.01, 0.12, v);
  st.run = smooth(p.walkSpeed * 1.4, p.walkSpeed * 2.6, v);
  st.stride = p.stride * clamp(Math.sqrt(Math.max(v, 1e-3) / p.walkSpeed), 0.4, 2.2);
  st.phase = fract(st.phase + (v > 1e-3 ? v / st.stride : 0) * ctx.dt);
}

/**
 * Neck posture from preset weights (up / down / tuck; the remainder is the
 * relaxed S) plus a yaw spread along the neck, a head yaw / roll and a small
 * extra head pitch.
 */
function neck(ctx: AnimCtx, st: WaderState, pose: Pose, wUp: number, wDown: number, wTuck: number, yaw: number, headYaw: number, headPitch: number, headRoll = 0): void {
  const R = ctx.roles;
  const n = R.neck.length;
  const m = st.mix;
  for (let i = 0; i <= n; i++) m[i] = st.up[i] * wUp + st.down[i] * wDown + st.tuck[i] * wTuck;
  for (let i = 0; i < n; i++) {
    // yaw mostly in the lower / middle neck
    rotLocal(pose, R.neck[i], 'y', (yaw * (n - i)) / ((n * (n + 1)) / 2));
    rotLocal(pose, R.neck[i], 'x', m[i]);
  }
  if (R.head >= 0) {
    // pitch first: the head's world pitch is then the preset's, and yaw / roll
    // turn it about its own (pitched) axes — e.g. yaw ≈ π lays it back on the body
    rotLocal(pose, R.head, 'x', m[n] + headPitch);
    rotLocal(pose, R.head, 'y', headYaw);
    rotLocal(pose, R.head, 'z', headRoll);
  }
}

/** Wings: lift (abduct, rad) and spread (rotate the folded wing outward / back). */
function wings(st: WaderState, pose: Pose, lift: number, spread: number): void {
  for (let i = 0; i < st.wings.length; i++) {
    const w = st.wings[i];
    const s = i === 0 ? 1 : -1;
    rotLocal(pose, w[0], 'z', s * lift);
    rotLocal(pose, w[0], 'y', -s * spread * 0.4);
    rotLocal(pose, w[1], 'z', s * spread * 0.5);
  }
}

/** Body: bob, sway and the shift over the standing leg (`shift` m, + = toward the left foot). */
function bodyPose(ctx: AnimCtx, st: WaderState, pose: Pose, pitch: number, shift: number): void {
  const R = ctx.roles;
  const ph = st.phase * TAU;
  const a = st.amp;
  pose.p[R.root].y += -0.012 * a * Math.cos(ph * 2) - 0.004 * a;
  pose.p[R.root].x += shift + 0.008 * a * Math.sin(ph);
  rotParent(pose, R.root, 'x', pitch + 0.025 * a * Math.sin(ph * 2 + 0.5));
  rotParent(pose, R.root, 'z', 0.03 * a * Math.sin(ph) + 0.01 * Math.sin(ctx.time * 0.5));
  if (R.chest >= 0) rotLocal(pose, R.chest, 'x', 0.012 * Math.sin(ctx.time * TAU * 0.3));
}

/**
 * Legs: walking (high-stepping, toes folding as the foot lifts) blended with
 * standing on one leg (`oneLeg` 0..1 lifts leg `upSide` (+1 left / −1 right)
 * into the belly feathers). rig.fk must be current.
 */
function legsPose(ctx: AnimCtx, st: WaderState, pose: Pose, oneLeg: number, upSide: number, tread = 0): void {
  const p = st.p;
  const rig = ctx.rig;
  for (const leg of st.legs) {
    const lp = fract(st.phase + (leg.side > 0 ? 0 : 0.5));
    stepCycle(lp, 0.58, st.stride * 0.5 * st.amp, S);
    let lift = p.lift * (st.amp + st.run * 0.4) * S.lift;
    let curl = S.swing >= 0 ? 1.3 * Math.sin(Math.PI * Math.min(1, S.swing * 1.25)) * st.amp : 0;
    // treading the mud while feeding: slow alternate stamps in place
    if (tread > 0) {
      const tp = fract(ctx.time * 0.45 + (leg.side > 0 ? 0 : 0.5));
      const tl = tp < 0.3 ? Math.sin((tp / 0.3) * Math.PI) : 0;
      lift += 0.06 * tread * tl;
      curl += 0.9 * tread * tl;
    }
    _C.copy(leg.r.contact);
    _C.z += S.dz;
    _C.y += lift;
    // the standing foot moves under the body's midline
    const standing = leg.side !== upSide;
    if (standing) _C.x -= leg.side * 0.034 * oneLeg;
    // MTP joint above the contact
    _A.copy(leg.footVec).applyAxisAngle(_X, curl).add(_C);
    if (!standing && oneLeg > 0.001) {
      // lifted leg: the (hidden) femur draws the knee up and forward into the
      // belly, the ankle points back-down and the foot folds up under the body
      const k = smooth(0, 1, oneLeg);
      pose.p[leg.r.upper].y += 0.12 * k;
      pose.p[leg.r.upper].z += 0.05 * k;
      rig.fkBone(pose, leg.r.upper);
      _C.set(p.tuckFoot.x * leg.side, p.tuckFoot.y, p.tuckFoot.z);
      _A.lerp(_C, k);
      curl = curl * (1 - k) + 2.2 * k;
      _P.set(0, -1.2 * k, 0);
      reachLimb(ctx, pose, leg, _A, _P, _Q.setFromAxisAngle(_X, curl));
      continue;
    }
    rig.fkBone(pose, leg.r.upper);
    placeLeg(ctx, null, pose, leg, _A, curl, 0);
  }
}
const _X = new THREE.Vector3(1, 0, 0);
const _P = new THREE.Vector3();
const _Q = new THREE.Quaternion();

/** Idle rest posture weight: 0 alert on two legs … 1 on one leg with the head tucked. */
function restMood(ctx: AnimCtx): number {
  return moodSwitch(ctx.time, 11, ctx.seed + 13, 0.55, 1.6);
}

function actIdle(ctx: AnimCtx, st: WaderState, pose: Pose): void {
  const t = ctx.time;
  const rest = restMood(ctx) * (1 - st.amp);
  // each bird keeps its favourite resting leg (no swap while standing on it)
  const upSide = ctx.rand < 0.5 ? 1 : -1;
  bodyPose(ctx, st, pose, -0.02 * rest, upSide * -0.03 * rest);
  ctx.rig.fk(pose);
  legsPose(ctx, st, pose, rest, upSide);
  // alert: look around, sometimes preen (head back along the flank / into the wing)
  const preen = (1 - rest) * moodSwitch(t, 5, ctx.seed + 21, 0.3, 0.9);
  const pside = clamp(glance(t, 10, ctx.seed + 23, 0.3) * 3, -1, 1);
  const look = (1 - rest) * (1 - preen);
  const yaw = 0.7 * look * glance(t, 3.4, ctx.seed + 1, 0.15) + pside * 1.4 * preen;
  const nib = Math.sin(t * TAU * 2.4) * 0.15 * preen;
  const tk = 0.9 * rest;
  neck(ctx, st, pose, 0.05 * look, 0.25 * preen, tk + 0.35 * preen, yaw, pside * 0.9 * preen + 0.3 * look * glance(t, 2.9, ctx.seed + 2, 0.15) + upSide * 2.7 * tk, nib + 0.1 * look * glance(t, 4.4, ctx.seed + 3), pside * 0.4 * preen + upSide * 0.45 * tk);
  jaw(ctx, pose, 0.05 * preen * Math.max(0, Math.sin(t * TAU * 2.4)));
  wings(st, pose, 0.05 * preen * pside, 0);
}

function actWalk(ctx: AnimCtx, st: WaderState, pose: Pose): void {
  const ph = st.phase * TAU;
  bodyPose(ctx, st, pose, -0.03 * st.run, 0);
  ctx.rig.fk(pose);
  legsPose(ctx, st, pose, 0, 0);
  // the neck sways forward / back with each step (head bob); stretched when hurrying
  const bob = 0.12 * st.amp * Math.sin(ph * 2);
  const look = 0.35 * (1 - st.amp) * glance(ctx.time, 3.4, ctx.seed + 1, 0.15);
  neck(ctx, st, pose, 0.2 + 0.4 * st.run, 0.08 * st.amp, 0, look, 0, bob);
  // running: wings half open for balance
  wings(st, pose, 0.12 * st.run, 0.5 * st.run);
}

/** Filter feeding: body tipped forward, head upside-down at the water, sweeping side to side. */
function actEat(ctx: AnimCtx, st: WaderState, pose: Pose): void {
  const p = st.p;
  const t = ctx.time;
  const R = ctx.roles;
  pose.p[R.root].y -= p.feedDrop;
  bodyPose(ctx, st, pose, p.feedPitch, 0);
  ctx.rig.fk(pose);
  legsPose(ctx, st, pose, 0, 0, 0.6);
  const sweep = Math.sin(t * TAU * 0.35 + ctx.seed);
  const lift = pulses(t, 9, ctx.seed + 4, 1.8, 0.5);
  neck(ctx, st, pose, 0, 1 - lift * 0.5, 0, 0.45 * sweep, 0.25 * sweep, 0.08 * Math.sin(t * TAU * 1.7));
  // pumping the tongue / jaw while filtering
  jaw(ctx, pose, 0.06 + 0.05 * Math.max(0, Math.sin(t * TAU * 4)));
}

function actDrink(ctx: AnimCtx, st: WaderState, pose: Pose): void {
  const p = st.p;
  const t = ctx.time;
  const R = ctx.roles;
  pose.p[R.root].y -= p.feedDrop * 0.8;
  bodyPose(ctx, st, pose, p.feedPitch * 0.9, 0);
  ctx.rig.fk(pose);
  legsPose(ctx, st, pose, 0, 0);
  // dip, then raise the head a little to swallow
  const c = (t * 0.25 + ctx.rand) % 1;
  const up = smooth(0.55, 0.7, c) * (1 - smooth(0.85, 1, c));
  neck(ctx, st, pose, 0, 1 - 0.6 * up, 0, 0.1 * Math.sin(t * 0.5), 0, -0.7 * (1 - up) - 0.3 * up);
  jaw(ctx, pose, 0.05 * (1 - up) * Math.max(0, Math.sin(t * TAU * 2)));
}

/** Sleep: on one leg, head laid back on the body, barely moving. */
function actSleep(ctx: AnimCtx, st: WaderState, pose: Pose): void {
  const upSide = ctx.rand < 0.5 ? 1 : -1;
  bodyPose(ctx, st, pose, -0.03, -upSide * 0.03);
  ctx.rig.fk(pose);
  legsPose(ctx, st, pose, 1, upSide);
  neck(ctx, st, pose, 0, 0, 1, 0, upSide * 2.7, 0.02 * Math.sin(ctx.time * TAU * 0.2), upSide * 0.45);
}

/** Sitting on the folded legs (ankles stick out behind, feet in front). */
function actSit(ctx: AnimCtx, st: WaderState, pose: Pose): void {
  const p = st.p;
  const R = ctx.roles;
  const rig = ctx.rig;
  pose.p[R.root].y += p.sitY - st.hipsY;
  rotParent(pose, R.root, 'x', -0.06);
  if (R.chest >= 0) rotLocal(pose, R.chest, 'x', 0.012 * Math.sin(ctx.time * TAU * 0.25));
  rig.fk(pose);
  for (const leg of st.legs) {
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    _A.set(H.x * 1.1, 0.025, H.z + 0.06);
    placeLeg(ctx, null, pose, leg, _A, -0.1, 0);
  }
  const doze = moodSwitch(ctx.time, 9, ctx.seed + 8, 0.5, 2.0);
  const look = (1 - doze) * glance(ctx.time, 3.6, ctx.seed + 1, 0.15);
  const side = ctx.rand < 0.5 ? 1 : -1;
  neck(ctx, st, pose, 0, 0, 0.9 * doze, 0.6 * look, 0.2 * look + side * 2.6 * doze, 0, side * 0.4 * doze);
}

/** Honk with head-flagging and a wing salute (wings lifted to flash the red coverts / black flight feathers). */
function actCall(ctx: AnimCtx, st: WaderState, pose: Pose): void {
  const at = ctx.actionTime;
  const env = envelope(at, 2.6, 0.4, 0.5);
  bodyPose(ctx, st, pose, -0.08 * env, 0);
  ctx.rig.fk(pose);
  legsPose(ctx, st, pose, 0, 0);
  const flag = Math.sin(at * TAU * 1.6);
  const salute = smooth(0.6, 1.0, at) * (1 - smooth(1.6, 2.0, at));
  neck(ctx, st, pose, env, 0, 0, 0.25 * flag * env, 0.7 * flag * env, -0.15 * env);
  jaw(ctx, pose, 0.18 * env * Math.max(0, Math.sin(at * TAU * 2.2)));
  wings(st, pose, 0.38 * salute, 0.6 * salute);
}

/** Marching display: quick steps on the spot, neck up, head-flagging. */
function actPlay(ctx: AnimCtx, st: WaderState, pose: Pose): void {
  const t = ctx.time;
  bodyPose(ctx, st, pose, -0.05, 0);
  ctx.rig.fk(pose);
  // marching in place
  for (const leg of st.legs) {
    const tp = fract(t * 1.1 + (leg.side > 0 ? 0 : 0.5));
    const tl = tp < 0.45 ? Math.sin((tp / 0.45) * Math.PI) : 0;
    _C.copy(leg.r.contact);
    _C.y += 0.1 * tl;
    _C.z += 0.03 * tl;
    ctx.rig.fkBone(pose, leg.r.upper);
    const curl = 1.2 * tl;
    _A.copy(leg.footVec).applyAxisAngle(_X, curl).add(_C);
    placeLeg(ctx, null, pose, leg, _A, curl, 0);
  }
  const flag = Math.sin(t * TAU * 1.3);
  neck(ctx, st, pose, 0.9, 0, 0, 0.3 * flag, 0.6 * flag, -0.1);
  wings(st, pose, 0.1 * Math.max(0, Math.sin(t * TAU * 0.5)), 0);
}

/** Social: gentle head-flagging / bill-touching toward a neighbour. */
function actSocial(ctx: AnimCtx, st: WaderState, pose: Pose): void {
  const t = ctx.time;
  bodyPose(ctx, st, pose, 0, 0);
  ctx.rig.fk(pose);
  legsPose(ctx, st, pose, 0, 0);
  const side = ctx.rand > 0.5 ? 1 : -1;
  const nod = Math.sin(t * TAU * 0.5);
  neck(ctx, st, pose, 0.35 + 0.2 * nod, 0.1, 0, side * 0.6, side * 0.5 + 0.2 * Math.sin(t * TAU * 0.8), 0.15 * nod);
  jaw(ctx, pose, 0.06 * pulses(t, 2.2, ctx.seed, 0.4, 0.6));
}

export function waderDriver(p: WaderParams): AnimDriver<WaderState> {
  return {
    init: (ctx) => init(ctx, p),
    pre,
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
    fades: { sleep: 1.4, sit: 1.1, eat: 0.8, drink: 0.8 },
  };
}

