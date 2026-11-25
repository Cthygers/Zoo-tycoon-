// Procedural human animation: walking with planted feet (leg IK) and arm
// swing, idle weight shifts, watching with point / photo gestures, sitting on
// a bench, eating / drinking (hand to mouth), and staff work (keeper scatters
// feed, groundskeeper sweeps, vet crouches to examine).

import * as THREE from 'three';
import { Pose, rotLocal, rotParent } from '../rig/rig';
import type { AnimCtx, AnimDriver } from '../types';
import { LegRT, placeLeg, plantLeg } from './quadruped';
import { TAU, clamp, damp, fract, glance, hash1, smooth, wander } from './util';

export class HumanState {
  phase = 0;
  speed = 0;
  amp = 0;
  stride = 0;
  legLen = 0.9;
  hipsY = 0.95;
  readonly legs: LegRT[] = [];
}

const _C = new THREE.Vector3();
const _A = new THREE.Vector3();

function init(ctx: AnimCtx): HumanState {
  const st = new HumanState();
  const R = ctx.roles;
  (['HL', 'HR'] as const).forEach((id, i) => {
    const r = R.legs[id];
    if (r) st.legs.push(new LegRT(ctx.rig, id, i, r));
  });
  st.hipsY = ctx.def.rest[R.root * 3 + 1];
  st.legLen = st.legs.length ? st.legs[0].legLen : st.hipsY;
  st.phase = ctx.rand;
  return st;
}

/** Step length cap: 0.42 × body height (body height ≈ 1.85 × the pelvis height). */
const MAX_STRIDE_PER_HIP = 2 * 0.42 * 1.85;

function pre(ctx: AnimCtx, st: HumanState): void {
  st.speed += (ctx.speed - st.speed) * damp(0.15, ctx.dt);
  const v = st.speed;
  st.amp = smooth(0.02, 0.3, v);
  // faster walking lengthens the step up to the cap, then quickens the cadence
  st.stride = Math.min(st.legLen * clamp(0.7 + 0.68 * v / Math.sqrt(st.legLen / 0.9), 0.35, 2.6), MAX_STRIDE_PER_HIP * st.hipsY);
  const f = v > 1e-3 ? v / st.stride : 0;
  st.phase = fract(st.phase + f * ctx.dt);
}

// ---------------------------------------------------------------------------
// building blocks

// Gait (fractions of the cycle; the left heel strikes at phase 0).
const DUTY = 0.6;
/** Toes-up pitch at heel strike and heel-up pitch at toe-off (rad). */
const HEEL_STRIKE_PITCH = 0.25;
const TOE_OFF_PITCH = 0.6;
/** Ball of the foot → heel, as a fraction of the leg length (the shoe is ≈ 0.25 m for a 0.9 m leg). */
const HEEL_PER_LEG = 0.19;
/** Swing foot lift (× leg length): peaks early, behind the body, so the knee folds ≈ 55–60°. */
const SWING_LIFT = 0.12;
/**
 * Share of the standing foot spacing (hip width) given up while walking: feet
 * land close to the line of travel (≈ 11 cm between the feet for a man,
 * against ≈ 19 cm standing), not on two wide rails.
 */
const WALK_NARROW = 0.4;

/**
 * Legs: walking cycle (stance / swing) or planted standing. The planted foot
 * rolls heel → flat → ball (heel strike with the toes up, pivoting on the
 * heel; heel-off pivoting on the ball), the swing foot rises behind the body
 * on a high arc and reaches forward with the toes up.
 */
function legs(ctx: AnimCtx, st: HumanState, pose: Pose): void {
  const rig = ctx.rig;
  const a = st.amp;
  const L = st.stride * DUTY * a;
  for (const leg of st.legs) {
    const lp = fract(st.phase + (leg.side > 0 ? 0 : 0.5));
    let dz: number, dy: number, pitch: number;
    if (lp < DUTY) {
      const u = lp / DUTY;
      // centred a little behind the hip: the heel-off lifts the ankle for the rear reach
      dz = L * (0.45 - u);
      dy = 0;
      pitch = -HEEL_STRIKE_PITCH * (1 - smooth(0, 0.15, u)) + TOE_OFF_PITCH * smooth(0.55, 1, u);
    } else {
      const w = (lp - DUTY) / (1 - DUTY);
      dz = L * (-0.55 + w * w * (3 - 2 * w));
      dy = SWING_LIFT * st.legLen * Math.sin(Math.PI * w ** 0.65);
      pitch = TOE_OFF_PITCH * (1 - smooth(0, 0.45, w)) - HEEL_STRIKE_PITCH * smooth(0.55, 1, w);
    }
    pitch *= a;
    _C.copy(leg.r.contact);
    _C.x *= 1 - WALK_NARROW * a;
    _C.z += dz;
    _C.y += dy * a;
    if (pitch < 0) {
      // toes up: pivot on the heel, not on the ball
      const heel = HEEL_PER_LEG * st.legLen;
      _C.y += heel * Math.sin(-pitch);
      _C.z -= heel * (1 - Math.cos(pitch));
    }
    rig.fkBone(pose, leg.r.upper);
    plantLeg(ctx, null, pose, leg, _C, pitch, 0);
  }
}

function body(ctx: AnimCtx, st: HumanState, pose: Pose): void {
  const R = ctx.roles;
  const a = st.amp;
  const ph = st.phase * TAU;
  const hips = R.root;
  const still = 1 - a;
  // pelvis: 3.6 cm bob (lowest at heel strike, slightly lowered while walking),
  // sway over the stance leg, hip of the leading leg forward (yaw against the
  // arms), drop on the swing side; the thorax turns the other way
  pose.p[hips].y += -0.018 * a * Math.cos(ph * 2) - 0.012 * a;
  pose.p[hips].x += 0.016 * a * Math.sin(ph) + 0.022 * still * glance(ctx.time, 6.5, ctx.seed + 3);
  rotParent(pose, hips, 'y', -0.09 * a * Math.cos(ph));
  rotParent(pose, hips, 'z', 0.035 * a * Math.sin(ph) - 0.03 * still * glance(ctx.time, 6.5, ctx.seed + 3));
  rotLocal(pose, R.spine[0], 'y', 0.05 * a * Math.cos(ph));
  if (R.chest >= 0) {
    rotLocal(pose, R.chest, 'y', 0.07 * a * Math.cos(ph));
    rotLocal(pose, R.chest, 'x', 0.012 * Math.sin(ctx.time * TAU * 0.25) + 0.03 * a);
  }
}

function head(ctx: AnimCtx, st: HumanState, pose: Pose, look: number, pitch = 0): void {
  const R = ctx.roles;
  const yaw = look * glance(ctx.time, 4.3, ctx.seed + 9);
  const tilt = 0.12 * look * glance(ctx.time, 5.7, ctx.seed + 4);
  rotLocal(pose, R.neck[0], 'y', yaw * 0.4);
  rotLocal(pose, R.head, 'y', yaw * 0.6);
  rotLocal(pose, R.head, 'x', pitch + tilt - 0.02 * st.amp * Math.cos(st.phase * TAU * 2));
}

type Side = 'L' | 'R';

/** The mesh is modelled in an A-pose with the arms this far out (rad). */
export const ARM_REST_OUT = 0.4;
/** Abduction (rad) of free arms hanging or swinging at the sides: the hands just clear the hips, beside the thighs rather than in them. */
const ARM_HANG_OUT = 0.03;

/** Arm pose in "anatomical" terms: raise forward (rad), abduct (rad, 0 = hanging), elbow flex (rad). */
function arm(ctx: AnimCtx, pose: Pose, side: Side, forward: number, out: number, elbow: number, twist = 0): void {
  const a = ctx.roles.arms[side];
  if (!a) return;
  const s = side === 'L' ? 1 : -1;
  rotLocal(pose, a.upper, 'z', s * (out - ARM_REST_OUT));
  rotLocal(pose, a.upper, 'x', -forward);
  rotLocal(pose, a.upper, 'y', s * twist);
  rotLocal(pose, a.lower, 'x', -elbow);
}

/** Arm pose parameters of `arm`: forward, out, elbow, twist (rad). */
type ArmPose = readonly [number, number, number, number];

/**
 * How people hold their free arms while standing (per side; null = hanging):
 * arms folded across the belly, hands clasped behind the back, a hand on the
 * hip. A third of them just let their arms hang. Fitted to elbow / wrist
 * targets on the adult body (folded: wrists crossing ≈ 18 cm in front of the
 * lower chest, the forearms resting on a heavy build's belly rather than in
 * it; clasped: wrists together ≈ 15 cm behind the waist; akimbo: wrist at the
 * side of the waist, elbow out 36 cm).
 */
const REST_ARMS: readonly (readonly [ArmPose | null, ArmPose | null])[] = [
  [null, null],
  [
    [0.02, 0.21, 1.29, -1.61],
    [0.07, 0.26, 1.53, -1.6],
  ],
  [
    [-0.72, 0.5, 0.82, -1.76],
    [-0.75, 0.45, 0.8, -1.68],
  ],
  [null, [-0.55, 0.9, 1.37, -1.53]],
];

/** This person's standing arm pose (REST_ARMS row; 0 = hanging). */
function restArms(ctx: AnimCtx): number {
  const h = hash1(ctx.seed, 41);
  return h < 0.34 ? 0 : h < 0.6 ? 1 : h < 0.8 ? 2 : 3;
}

/** `arm` with its (untwisted) walking pose eased toward the resting pose `rest` by k. */
function armToward(ctx: AnimCtx, pose: Pose, side: Side, forward: number, out: number, elbow: number, rest: ArmPose | null, k: number): void {
  if (!rest) return arm(ctx, pose, side, forward, out, elbow);
  arm(ctx, pose, side, forward + (rest[0] - forward) * k, out + (rest[1] - out) * k, elbow + (rest[2] - elbow) * k, rest[3] * k);
}

/**
 * Arms for walking / standing, respecting held items. People swing their arms
 * differently (0.75–1.25 × the mean swing, a straighter or more bent elbow),
 * the shoulder blades follow each arm forward and back, and standing still
 * their free arms settle into their own resting pose (REST_ARMS), so a crowd
 * is not one marching clockwork.
 */
function arms(ctx: AnimCtx, st: HumanState, pose: Pose): void {
  const ph = st.phase * TAU;
  const swing = 0.38 * st.amp * (0.75 + 0.5 * hash1(ctx.seed, 31));
  const bend = 0.14 + 0.16 * hash1(ctx.seed, 32);
  const sway = 0.03 * Math.sin(ctx.time * 0.9 + ctx.seed);
  const hold = ctx.holding;
  const carry = hold === 'food' || hold === 'drink' || hold === 'icecream';
  const [restL, restR] = REST_ARMS[hold === 'none' ? restArms(ctx) : 0];
  const still = smooth(0.15, 0, st.amp);
  // each arm is furthest forward as the opposite heel strikes
  const fwd = Math.cos(ph);
  armToward(ctx, pose, 'L', -swing * fwd + sway, ARM_HANG_OUT, bend + 0.25 * st.amp * Math.max(0, -fwd), restL, still);
  shoulder(ctx, pose, 'L', -fwd * st.amp);
  if (carry) arm(ctx, pose, 'R', 0.18 + 0.05 * fwd * st.amp, -0.12, 1.35, 0.25);
  else if (hold === 'balloon') arm(ctx, pose, 'R', 0.35, 0.05, 0.6);
  else {
    armToward(ctx, pose, 'R', swing * fwd * (hold === 'gift' ? 0.4 : 1) - sway, ARM_HANG_OUT, bend + 0.25 * st.amp * Math.max(0, fwd), restR, still);
    shoulder(ctx, pose, 'R', fwd * st.amp);
  }
}

/** Shoulder blade carried forward (k = 1) or back (k = −1) with its arm's swing. */
function shoulder(ctx: AnimCtx, pose: Pose, side: Side, k: number): void {
  const c = ctx.roles.arms[side]?.clavicle ?? -1;
  if (c < 0) return;
  rotLocal(pose, c, 'y', (side === 'L' ? -1 : 1) * 0.07 * k);
}

// ---------------------------------------------------------------------------
// actions

function actWalk(ctx: AnimCtx, st: HumanState, pose: Pose): void {
  body(ctx, st, pose);
  ctx.rig.fk(pose);
  legs(ctx, st, pose);
  arms(ctx, st, pose);
  head(ctx, st, pose, 0.35 * (1 - st.amp * 0.6));
}

function actIdle(ctx: AnimCtx, st: HumanState, pose: Pose): void {
  actWalk(ctx, st, pose);
}

const _g = { k: 0, kind: 0, t: 0 };
/** Occasional gesture window (reuses one result object: no per-frame allocation). */
function gesture(ctx: AnimCtx, period: number, len: number, salt: number): { k: number; kind: number; t: number } {
  const t = ctx.time;
  const slot = Math.floor(t / period);
  const local = t - slot * period;
  const start = hash1(slot, ctx.seed + salt) * (period - len);
  const g = local - start;
  _g.k = 0;
  _g.kind = 0;
  _g.t = 0;
  if (hash1(slot, ctx.seed + salt + 1) > 0.65 || g < 0 || g > len) return _g;
  _g.k = smooth(0, 0.5, g) * (1 - smooth(len - 0.5, len, g));
  _g.kind = hash1(slot, ctx.seed + salt + 2) < 0.5 ? 0 : 1;
  _g.t = g;
  return _g;
}

function actWatch(ctx: AnimCtx, st: HumanState, pose: Pose): void {
  body(ctx, st, pose);
  ctx.rig.fk(pose);
  legs(ctx, st, pose);
  const g = gesture(ctx, 8, 3, 50);
  // people with folded or clasped arms keep them so (no pop into a gesture)
  if (g.k > 0 && ctx.holding === 'none' && restArms(ctx) === 0) {
    if (g.kind === 0) {
      // point at an animal
      arm(ctx, pose, 'R', 1.35 * g.k, -0.15 * g.k, 0.1);
      arm(ctx, pose, 'L', 0.03, -0.07, 0.25);
    } else {
      // take a photo: both hands up in front of the face
      arm(ctx, pose, 'R', 1.15 * g.k, -0.42 * g.k, 1.75 * g.k + 0.2, 0.3 * g.k);
      arm(ctx, pose, 'L', 1.15 * g.k, -0.42 * g.k, 1.75 * g.k + 0.2, 0.3 * g.k);
    }
  } else arms(ctx, st, pose);
  head(ctx, st, pose, 0.15, -0.05);
}

function actSit(ctx: AnimCtx, st: HumanState, pose: Pose): void {
  const R = ctx.roles;
  const rig = ctx.rig;
  const seat = st.legLen * 0.5;
  pose.p[R.root].y += seat + 0.06 * st.legLen - st.hipsY;
  pose.p[R.root].z -= 0.06 * st.legLen;
  rotParent(pose, R.root, 'x', -0.06);
  if (R.chest >= 0) rotLocal(pose, R.chest, 'x', 0.08 + 0.012 * Math.sin(ctx.time * TAU * 0.22));
  rig.fk(pose);
  for (const leg of st.legs) {
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    _C.set(leg.r.contact.x * 1.25, 0, H.z + st.legLen * 0.5);
    plantLeg(ctx, null, pose, leg, _C, 0, 0);
  }
  const hold = ctx.holding;
  arm(ctx, pose, 'L', 0.55, -0.05, 0.75);
  if (hold === 'food' || hold === 'drink' || hold === 'icecream') handToMouth(ctx, pose, 'R');
  else arm(ctx, pose, 'R', 0.55, -0.05, 0.75);
  head(ctx, st, pose, 0.4, 0.05);
}

function handToMouth(ctx: AnimCtx, pose: Pose, side: Side): void {
  const period = 4.5;
  const t = (ctx.time + ctx.rand * period) % period;
  const k = smooth(0, 0.6, t) * (1 - smooth(1.6, 2.2, t));
  arm(ctx, pose, side, 0.2 + 0.45 * k, -0.12 - 0.28 * k, 1.35 + 0.95 * k, 0.25 + 0.2 * k);
}

function actEat(ctx: AnimCtx, st: HumanState, pose: Pose): void {
  body(ctx, st, pose);
  ctx.rig.fk(pose);
  legs(ctx, st, pose);
  arm(ctx, pose, 'L', 0.05, -0.07, 0.3);
  handToMouth(ctx, pose, 'R');
  head(ctx, st, pose, 0.2, 0.05);
}

function actWork(ctx: AnimCtx, st: HumanState, pose: Pose): void {
  if (st.amp > 0.3) return actWalk(ctx, st, pose);
  const R = ctx.roles;
  const rig = ctx.rig;
  const t = ctx.time;
  if (ctx.role === 'groundskeeper') {
    // sweeping: bent forward, both hands on the broom, side-to-side strokes
    const s = Math.sin(t * TAU * 0.8);
    rotParent(pose, R.root, 'x', 0.18);
    rotParent(pose, R.root, 'y', 0.25 * s);
    rotLocal(pose, R.spine[0], 'x', 0.12);
    rig.fk(pose);
    legs(ctx, st, pose);
    arm(ctx, pose, 'R', 0.55 + 0.15 * s, -0.25, 0.5, 0.2);
    arm(ctx, pose, 'L', 0.85 + 0.1 * s, -0.35, 0.9, 0.3);
    head(ctx, st, pose, 0.05, 0.25);
  } else if (ctx.role === 'vet') {
    // crouch and examine: knees bent, reaching forward
    const reach = 0.5 + 0.5 * Math.sin(t * TAU * 0.25);
    pose.p[R.root].y -= st.hipsY * 0.38;
    pose.p[R.root].z -= st.hipsY * 0.12;
    rotParent(pose, R.root, 'x', 0.45);
    rotLocal(pose, R.chest, 'x', 0.15);
    rig.fk(pose);
    for (const leg of st.legs) {
      rig.fkBone(pose, leg.r.upper);
      _A.set(leg.r.contact.x * 1.4, st.legLen * 0.1, leg.r.contact.z - 0.02);
      placeLeg(ctx, null, pose, leg, _A, 0.25, 0);
    }
    arm(ctx, pose, 'R', 1.0 + 0.2 * reach, -0.1, 0.5 + 0.3 * reach);
    arm(ctx, pose, 'L', 0.9, -0.15, 0.7);
    head(ctx, st, pose, 0.1, 0.35);
  } else if (ctx.role === 'keeper') {
    // scattering feed: dip into a bucket at the hip, throw forward
    const c = (t * 0.7 + ctx.rand) % 1;
    const throwK = smooth(0.45, 0.7, c) * (1 - smooth(0.75, 1, c));
    rotParent(pose, R.root, 'x', 0.1 + 0.1 * throwK);
    rotParent(pose, R.root, 'y', -0.2 * throwK);
    rig.fk(pose);
    legs(ctx, st, pose);
    arm(ctx, pose, 'R', -0.2 + 1.5 * throwK, -0.05, 0.6 - 0.4 * throwK);
    arm(ctx, pose, 'L', 0.35, -0.2, 1.4, 0.3);
    head(ctx, st, pose, 0.1, 0.15);
  } else actIdle(ctx, st, pose);
}

export function humanDriver(): AnimDriver<HumanState> {
  return {
    init,
    pre,
    actions: {
      idle: actIdle,
      walk: actWalk,
      watch: actWatch,
      sit: actSit,
      eat: actEat,
      drink: actEat,
      work: actWork,
    },
    aliases: { leave: 'walk', run: 'walk', shop: 'idle', restroom: 'idle' },
    fade: 0.35,
    fades: { sit: 0.7, work: 0.5 },
  };
}

export { wander };
