// 'penguin' rig kind: upright spindle body on two short legs with flat
// webbed feet, flippers (3-bone paddles), a short flexible neck and a stiff
// tail. The driver waddles (body roll toward the stance foot, yaw with each
// step, flippers held out for balance), preens and looks around in jerky
// glances, pecks to eat / drink, lies on the belly to sleep, crouches on the
// tarsi to rest, does the braying "ecstatic" display to call, and swims
// belly-down at the surface — porpoising out of the water at speed.

import * as THREE from 'three';
import { Pose, rotLocal, rotParent } from '../../rig/rig';
import type { AnimCtx, AnimDriver } from '../../types';
import { LegRT, jaw, neckHead, placeLeg, plantLeg } from '../../anim/quadruped';
import { TAU, clamp, damp, fract, glance, pulses, smooth } from '../../anim/util';
import { envelope, moodSwitch, stepCycle, type StepOut } from './common';

export interface PenguinParams {
  /** Full stride (m, two steps) at walking speed `walkSpeed`. */
  stride: number;
  walkSpeed: number;
  /** Stance fraction of the step cycle. */
  duty: number;
  /** Foot lift (m). */
  lift: number;
  /** Body roll toward the stance foot (rad). */
  waddle: number;
  /** Root height (pelvis joint) when lying on the belly / crouching. */
  proneY: number;
  crouchY: number;
  /** Swimming: root depth below the surface (m) and the pitch that makes the body horizontal (rad). */
  swimDepth: number;
  swimPitch: number;
  /** Fore-aft shift of the root when horizontal (so the body centre stays on the origin). */
  swimShift: number;
}

export class PenguinState {
  phase = 0;
  speed = 0;
  amp = 0;
  run = 0;
  stride = 0;
  hipsY = 0;
  /** Porpoising leap phase (0..1) and whether a leap is in progress. */
  leap = 0;
  leaping = false;
  readonly legs: LegRT[] = [];
  /** Flipper chains (L, R): 3 bones each. */
  readonly flip: number[][] = [];
  constructor(readonly p: PenguinParams) {}
}

const S: StepOut = { dz: 0, lift: 0, swing: -1, stance: -1 };
const _C = new THREE.Vector3();
const _A = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _AY = new THREE.Vector3(0, 1, 0);
const _AZ = new THREE.Vector3(0, 0, 1);

function init(ctx: AnimCtx, p: PenguinParams): PenguinState {
  const st = new PenguinState(p);
  (['HL', 'HR'] as const).forEach((id, i) => {
    const r = ctx.roles.legs[id];
    if (r) st.legs.push(new LegRT(ctx.rig, id, i, r));
  });
  for (const s of ['L', 'R'] as const) {
    const a = ctx.roles.arms[s];
    if (a) st.flip.push([a.upper, a.lower, a.hand]);
  }
  st.hipsY = ctx.def.rest[ctx.roles.root * 3 + 1];
  st.phase = ctx.rand;
  return st;
}

function pre(ctx: AnimCtx, st: PenguinState): void {
  const p = st.p;
  st.speed += (ctx.speed - st.speed) * damp(0.12, ctx.dt);
  const v = st.speed;
  st.amp = smooth(0.01, 0.12, v);
  st.run = smooth(p.walkSpeed * 1.3, p.walkSpeed * 2.1, v);
  st.stride = p.stride * clamp(Math.sqrt(Math.max(v, 1e-3) / p.walkSpeed), 0.45, 1.5);
  st.phase = fract(st.phase + (v > 1e-3 ? v / st.stride : 0) * ctx.dt);
}

/**
 * Flipper pose: `out` abduction (rad, 0 = against the body), `fwd` swing
 * forward (+) / back (−) about the shoulder, `twist` (pitch of the blade),
 * `bend` curvature along the blade.
 */
function flippers(st: PenguinState, pose: Pose, out: number, fwd: number, twist: number, bend: number, asym = 0): void {
  for (let i = 0; i < st.flip.length; i++) {
    const f = st.flip[i];
    const s = i === 0 ? 1 : -1;
    // the mesh is modelled with the flippers ~0.12 rad away from the flanks
    const o = out - 0.12 + asym * s;
    rotLocal(pose, f[0], 'z', s * o);
    rotLocal(pose, f[0], 'x', -fwd);
    rotLocal(pose, f[0], 'y', s * twist);
    rotLocal(pose, f[1], 'z', s * bend * 0.5);
    rotLocal(pose, f[2], 'z', s * bend * 0.5);
  }
}

/** Tail: side sweep (+ = left) and lift (− = up). */
function tailPose(ctx: AnimCtx, pose: Pose, sweep: number, lift: number): void {
  const T = ctx.roles.tail;
  for (let i = 0; i < T.length; i++) {
    rotLocal(pose, T[i], 'y', sweep / T.length);
    rotLocal(pose, T[i], 'x', lift / T.length);
  }
}

/** Feet: walking cycle or planted. rig.fk must be current. */
function feet(ctx: AnimCtx, st: PenguinState, pose: Pose): void {
  const p = st.p;
  const rig = ctx.rig;
  for (const leg of st.legs) {
    const lp = fract(st.phase + (leg.side > 0 ? 0 : 0.5));
    stepCycle(lp, p.duty, st.stride * 0.5 * st.amp, S);
    _C.copy(leg.r.contact);
    _C.z += S.dz;
    _C.y += p.lift * st.amp * (1 + st.run * 0.5) * S.lift;
    // the feet turn out a little and swing in an arc (waddle)
    _C.x += leg.side * 0.012 * st.amp * S.lift;
    rig.fkBone(pose, leg.r.upper);
    // flat-footed: toes lift only a little in the swing
    plantLeg(ctx, null, pose, leg, _C, S.swing >= 0 ? -0.25 * st.amp * Math.sin(Math.PI * S.swing) : 0, 0);
  }
}

/** Waddling body: roll toward the stance foot, yaw with the step, small bob, forward lean. */
function waddleBody(ctx: AnimCtx, st: PenguinState, pose: Pose, lean: number): void {
  const R = ctx.roles;
  const p = st.p;
  const ph = st.phase * TAU;
  const a = st.amp;
  const root = R.root;
  pose.p[root].y += -0.008 * a * Math.cos(ph * 2);
  pose.p[root].x += 0.012 * a * Math.cos(ph);
  rotParent(pose, root, 'x', lean + 0.03 * a * Math.cos(ph * 2));
  rotParent(pose, root, 'z', -p.waddle * a * (1 - st.run * 0.3) * Math.cos(ph) + 0.012 * Math.sin(ctx.time * 0.6));
  rotParent(pose, root, 'y', 0.07 * a * Math.sin(ph));
  // breathing / settling
  if (R.chest >= 0) rotLocal(pose, R.chest, 'x', 0.012 * Math.sin(ctx.time * TAU * 0.35));
  if (R.spine.length) rotLocal(pose, R.spine[0], 'z', p.waddle * 0.3 * a * Math.cos(ph));
}

/** Jerky look-around (penguins move the head in quick saccades). */
function headLook(ctx: AnimCtx, st: PenguinState, pose: Pose, amount: number, pitch = 0): void {
  const yaw = 0.9 * amount * glance(ctx.time, 2.3, ctx.seed + 1, 0.08);
  const tilt = 0.2 * amount * glance(ctx.time, 3.1, ctx.seed + 2, 0.1);
  const bob = 0.05 * st.amp * Math.sin(st.phase * TAU * 2);
  neckHead(ctx, pose, pitch * 0.5 + bob, yaw * 0.6, pitch * 0.5 + tilt - bob, yaw * 0.4, 0.15 * amount * glance(ctx.time, 4.1, ctx.seed + 3, 0.1));
}

function actWalk(ctx: AnimCtx, st: PenguinState, pose: Pose): void {
  const ph = st.phase * TAU;
  waddleBody(ctx, st, pose, 0.06 * st.amp + 0.22 * st.run);
  ctx.rig.fk(pose);
  feet(ctx, st, pose);
  // flippers out for balance, swinging against the roll; wider when hurrying
  const out = 0.12 + 0.25 * st.amp + 0.35 * st.run;
  flippers(st, pose, out, -0.15 * st.amp - 0.3 * st.run, 0.1, 0.05, 0.12 * st.amp * Math.cos(ph));
  tailPose(ctx, pose, 0.25 * st.amp * Math.cos(ph), -0.1 * st.amp);
  headLook(ctx, st, pose, 1 - st.amp * 0.7, -0.05 * st.run);
}

/** Idle: stand, look around, preen now and then (head to the flank / under the flipper). */
function actIdle(ctx: AnimCtx, st: PenguinState, pose: Pose): void {
  const t = ctx.time;
  const preen = moodSwitch(t, 6, ctx.seed + 17, 0.45, 0.8);
  // preening side drifts smoothly (no pop if it changes mid-preen)
  const side = clamp(glance(t, 12, ctx.seed + 19, 0.3) * 3, -1, 1);
  waddleBody(ctx, st, pose, 0.03 + 0.1 * preen);
  rotParent(pose, ctx.roles.root, 'z', -0.06 * preen * side);
  ctx.rig.fk(pose);
  feet(ctx, st, pose);
  if (preen > 0.01) {
    // turn the head to the flank and rub the bill through the feathers
    const rub = Math.sin(t * TAU * 2.2) * 0.12;
    const yaw = side * (1.9 + rub * 0.5) * preen;
    neckHead(ctx, pose, 0.55 * preen, yaw * 0.6, (0.45 + rub) * preen, yaw * 0.4, side * 0.3 * preen);
    flippers(st, pose, 0.12 + 0.05 * preen, 0, 0.1, 0.05, 0.35 * preen * side);
    jaw(ctx, pose, 0.05 * preen * Math.max(0, Math.sin(t * TAU * 2.2)));
    // look-around fades out while preening
    headLook(ctx, st, pose, 1 - preen);
  } else {
    // occasional flipper stretch / shake
    const shake = pulses(t, 7, ctx.seed + 5, 0.9, 0.5);
    flippers(st, pose, 0.12 + 0.55 * shake, 0.1 * shake, 0.1, 0.05 + 0.1 * shake * Math.sin(t * TAU * 6));
    headLook(ctx, st, pose, 1);
  }
  tailPose(ctx, pose, 0.08 * Math.sin(t * 0.9 + ctx.seed), 0);
}

/** Pecking at food on the ground (fish, krill): lean, peck, head up to swallow. */
function actEat(ctx: AnimCtx, st: PenguinState, pose: Pose): void {
  const t = ctx.time;
  const cyc = (t * 0.45 + ctx.rand) % 1;
  const down = smooth(0.0, 0.18, cyc) * (1 - smooth(0.55, 0.7, cyc));
  const peck = down * Math.max(0, Math.sin(t * TAU * 2.4));
  const swallow = smooth(0.7, 0.8, cyc) * (1 - smooth(0.9, 1, cyc));
  waddleBody(ctx, st, pose, 0.12 + 0.55 * down);
  ctx.rig.fk(pose);
  feet(ctx, st, pose);
  neckHead(ctx, pose, 0.6 * down + 0.15 * peck - 0.5 * swallow, 0.15 * Math.sin(t * 0.8 + ctx.seed), 0.45 * down + 0.15 * peck - 0.6 * swallow, 0);
  jaw(ctx, pose, 0.18 * swallow + 0.1 * peck);
  flippers(st, pose, 0.18 + 0.15 * down, -0.1 * down, 0.1, 0.05);
  tailPose(ctx, pose, 0, -0.15 * down);
}

function actDrink(ctx: AnimCtx, st: PenguinState, pose: Pose): void {
  const t = ctx.time;
  const cyc = (t * 0.3 + ctx.rand) % 1;
  const down = smooth(0.0, 0.2, cyc) * (1 - smooth(0.5, 0.65, cyc));
  const up = smooth(0.65, 0.75, cyc) * (1 - smooth(0.9, 1, cyc));
  waddleBody(ctx, st, pose, 0.12 + 0.5 * down);
  ctx.rig.fk(pose);
  feet(ctx, st, pose);
  neckHead(ctx, pose, 0.6 * down - 0.6 * up, 0, 0.5 * down - 0.7 * up, 0);
  jaw(ctx, pose, 0.08 * down * Math.max(0, Math.sin(t * TAU * 1.5)));
  flippers(st, pose, 0.15, 0, 0.1, 0.05);
}

/** Lying on the belly, feet trailing, head resting forward. */
function actSleep(ctx: AnimCtx, st: PenguinState, pose: Pose): void {
  const p = st.p;
  const R = ctx.roles;
  const rig = ctx.rig;
  pose.p[R.root].y += p.proneY - st.hipsY;
  pose.p[R.root].z -= 0.12;
  rotParent(pose, R.root, 'x', 1.32);
  rotParent(pose, R.root, 'z', 0.06 * Math.sin(ctx.seed));
  if (R.chest >= 0) rotLocal(pose, R.chest, 'x', 0.02 * Math.sin(ctx.time * TAU * 0.2));
  rig.fk(pose);
  for (const leg of st.legs) {
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    _A.set(H.x * 1.2, 0.03, H.z - 0.09);
    placeLeg(ctx, null, pose, leg, _A, 2.4, 0);
  }
  // head: neck counters most of the body pitch, chin down on the ground
  neckHead(ctx, pose, -0.8, 0.3 * Math.sin(ctx.seed * 3), -0.45, 0.2 * Math.sin(ctx.seed * 3));
  flippers(st, pose, 0.05, 0.25, 0, 0);
  tailPose(ctx, pose, 0, -0.75);
}

/** Resting crouched on the tarsi (belly low, upright), dozing / looking around. */
function actSit(ctx: AnimCtx, st: PenguinState, pose: Pose): void {
  const p = st.p;
  const R = ctx.roles;
  const rig = ctx.rig;
  pose.p[R.root].y += p.crouchY - st.hipsY;
  pose.p[R.root].z -= 0.03;
  // settled back on the heels, belly feathers on the ground, toes lifted
  rotParent(pose, R.root, 'x', -0.06);
  if (R.chest >= 0) rotLocal(pose, R.chest, 'x', 0.015 * Math.sin(ctx.time * TAU * 0.25));
  rig.fk(pose);
  for (const leg of st.legs) {
    rig.fkBone(pose, leg.r.upper);
    _C.copy(leg.r.contact);
    _C.z += 0.01;
    _C.y += 0.012;
    plantLeg(ctx, null, pose, leg, _C, -0.45, 0);
  }
  const doze = moodSwitch(ctx.time, 7, ctx.seed + 4, 0.5, 1.2);
  // dozing: head sunk into the shoulders, bill slightly up
  neckHead(ctx, pose, 0.25 * doze, 0, -0.3 * doze, 0);
  headLook(ctx, st, pose, 1 - doze);
  flippers(st, pose, 0.1, 0, 0.1, 0.03);
}

/** Ecstatic display: bill to the sky, flippers back and pumping, chest heaving, braying. */
function actCall(ctx: AnimCtx, st: PenguinState, pose: Pose): void {
  const at = ctx.actionTime;
  const env = envelope(at, 2.6, 0.45, 0.5);
  const bray = Math.max(0, Math.sin(at * TAU * 3.2)) * smooth(0.5, 0.8, at) * (1 - smooth(2.0, 2.4, at));
  waddleBody(ctx, st, pose, -0.1 * env);
  ctx.rig.fk(pose);
  feet(ctx, st, pose);
  neckHead(ctx, pose, -0.75 * env, 0.08 * Math.sin(at * 3), -0.75 * env - 0.08 * bray, 0);
  jaw(ctx, pose, (0.3 + 0.12 * bray) * env);
  if (ctx.roles.chest >= 0) rotLocal(pose, ctx.roles.chest, 'x', -0.06 * bray);
  flippers(st, pose, 0.25 + 0.25 * env, -0.55 * env + 0.25 * bray, 0.2, 0.08);
  tailPose(ctx, pose, 0, -0.2 * env);
}

/** Social: bowing / head-swinging to a neighbour. */
function actSocial(ctx: AnimCtx, st: PenguinState, pose: Pose): void {
  const t = ctx.time;
  const bow = Math.max(0, Math.sin(t * TAU * 0.4));
  const side = ctx.rand > 0.5 ? 1 : -1;
  waddleBody(ctx, st, pose, 0.1 + 0.35 * bow);
  ctx.rig.fk(pose);
  feet(ctx, st, pose);
  neckHead(ctx, pose, 0.35 * bow, side * 0.5 * Math.sin(t * TAU * 0.6), 0.3 * bow, side * 0.3 * Math.sin(t * TAU * 0.6));
  jaw(ctx, pose, 0.1 * pulses(t, 1.6, ctx.seed, 0.4, 0.7));
  flippers(st, pose, 0.2 + 0.1 * bow, 0, 0.1, 0.05);
}

/** Play: hopping on the spot with flapping flippers. */
function actPlay(ctx: AnimCtx, st: PenguinState, pose: Pose): void {
  const t = ctx.time;
  const hopT = (t * 1.1 + ctx.rand) % 1;
  const hop = Math.sin(Math.PI * smooth(0.0, 0.45, hopT)) * (hopT < 0.45 ? 1 : 0);
  const R = ctx.roles;
  waddleBody(ctx, st, pose, 0.08);
  pose.p[R.root].y += 0.06 * hop;
  ctx.rig.fk(pose);
  // feet tucked a little during the hop
  for (const leg of st.legs) {
    ctx.rig.fkBone(pose, leg.r.upper);
    _C.copy(leg.r.contact);
    _C.y += 0.04 * hop;
    plantLeg(ctx, null, pose, leg, _C, -0.3 * hop, 0);
  }
  const flap = Math.sin(t * TAU * 3);
  flippers(st, pose, 0.6 + 0.35 * flap, -0.1, 0.2, 0.1 * flap);
  headLook(ctx, st, pose, 0.6, -0.15);
  tailPose(ctx, pose, 0.3 * Math.sin(t * 5), -0.2);
}

/** Swimming belly-down at the surface; porpoising leaps when fast. */
function actSwim(ctx: AnimCtx, st: PenguinState, pose: Pose): void {
  const p = st.p;
  const R = ctx.roles;
  const rig = ctx.rig;
  const t = ctx.time;
  const v = st.speed;
  const swimK = smooth(0.05, 0.4, v);
  const fast = smooth(p.walkSpeed * 1.6, p.walkSpeed * 2.2, v);
  // porpoising: an arc out of the water about every 1.6 s at speed
  const lt = (t / 1.6 + ctx.rand) % 1;
  const air = fast * (lt < 0.38 ? Math.sin((lt / 0.38) * Math.PI) : 0);
  const arcSlope = fast * (lt < 0.38 ? Math.cos((lt / 0.38) * Math.PI) : 0);
  const bob = 0.012 * Math.sin(t * TAU * 0.6) * (1 - swimK * 0.5);
  pose.p[R.root].y += -st.hipsY - p.swimDepth + bob + air * 0.32 - swimK * 0.012;
  pose.p[R.root].z += p.swimShift;
  // horizontal body when swimming; floating, the chest rides up out of the
  // water (the white front shows); follows the leap arc
  rotParent(pose, R.root, 'x', p.swimPitch - 0.32 * (1 - swimK) - 0.55 * arcSlope);
  rotParent(pose, R.root, 'z', 0.05 * Math.sin(t * 1.3) * (1 - swimK));
  rig.fk(pose);
  // flippers: underwater flight strokes when moving, sculling when floating.
  // Set in model space: blade out sideways (swept back, drooping a little),
  // flat face down, beating about the body's long axis.
  const freq = 1.2 + v * 1.6;
  const stroke = Math.sin(t * TAU * freq);
  const flapAmp = 0.12 + 0.45 * swimK;
  for (let i = 0; i < st.flip.length; i++) {
    const f = st.flip[i];
    const s = i === 0 ? 1 : -1;
    const sweep = 0.35 + 0.25 * (1 - swimK) + 0.6 * air;
    const droop = 0.42 - flapAmp * stroke * (1 - air * 0.7);
    _q1.setFromAxisAngle(_AY, -s * sweep);
    _q2.setFromAxisAngle(_AZ, s * (Math.PI / 2 - droop));
    _q1.multiply(_q2);
    _q2.setFromAxisAngle(_AY, s * 0.35 * Math.cos(t * TAU * freq));
    _q1.multiply(_q2);
    rig.setWorldRot(pose, f[0], _q1);
    rotLocal(pose, f[1], 'z', s * 0.12 * stroke);
    rig.fkBone(pose, f[1]);
    rig.fkBone(pose, f[2]);
  }
  // feet trail behind, paddling a little when slow
  for (const leg of st.legs) {
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    const pad = Math.sin(t * TAU * 1.1 + (leg.side > 0 ? 0 : Math.PI)) * (1 - swimK);
    _A.set(H.x * 1.05, H.y - 0.01 + 0.015 * pad, H.z - 0.1);
    placeLeg(ctx, null, pose, leg, _A, 1.55 + 0.25 * pad, 0);
  }
  // head up above the water, looking around while floating
  const look = (1 - swimK) * glance(t, 2.6, ctx.seed + 1, 0.12);
  neckHead(ctx, pose, -0.85 + 0.35 * swimK, look * 0.6, -0.55 + 0.2 * swimK + 0.25 * arcSlope, look * 0.4);
  tailPose(ctx, pose, 0.1 * Math.sin(t * 2), -0.9 + 0.2 * air);
}

export function penguinDriver(p: PenguinParams): AnimDriver<PenguinState> {
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
      swim: actSwim,
    },
    aliases: { run: 'walk', leave: 'walk', rest: 'sit' },
    fade: 0.3,
    fades: { sleep: 1.0, sit: 0.7, swim: 0.6 },
    transitions: { 'sleep>*': 1.0, 'sit>*': 0.7, 'swim>*': 0.6 },
  };
}

