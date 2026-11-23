// Shared bear kit (grizzly + polar bear): plantigrade legs with broad paws
// and claws, a stub tail, the bear animation driver (rolling plantigrade
// walk, foraging with a raking forepaw, sitting on the rump, lying with the
// head on the paws or flat on the side, dog-paddle swimming, rearing up on
// the hind legs) and a species-specific call. Species files supply the
// joints, trunk / head primitives and coat.

import * as THREE from 'three';
import { cone, ellipsoid, mirrorX, roundBox, sphere, type Prim, type Vec3 } from '../../sdf/prims';
import { CUB_PAWS, quadSkeleton, type QuadJoints } from '../../kit/quadruped';
import {
  actCall,
  actIdle,
  actSocial,
  actWalk,
  ears,
  jaw,
  lie,
  lookAroundStill,
  neckHead,
  placeLeg,
  quadParams,
  reachMuzzle,
  type QuadParams,
} from '../../anim/quadruped';
import { TAU, driver, glance, pulses, smooth } from '../../anim/util';
import { rotLocal, rotParent, type Pose } from '../../rig/rig';
import type { AnimCtx, AnimDriver, CoatFn, CreatureDesign, DesignContext, EyeSpec, LookSpec, RegionOpts } from '../../types';
import { PRState, ankleFor, crouch, initPR, lieSide, placeLegPole, prePR, rearUp, rumpSit, variant, type RearUp, type RumpSit, type SideLie } from './shared';

// ---------------------------------------------------------------------------
// Legs and paws

export interface BearLegSpec {
  /** Upper arm radius (start, end), forearm radius (start, end). */
  arm: [number, number, number, number];
  /** Thigh radius (start, end), shin radius (start, end). */
  thigh: [number, number, number, number];
  /** Front paw half-width / half-length / pad height. */
  frontPaw: Vec3;
  /** Hind paw (sole) half-width / half-length / height. */
  hindPaw: Vec3;
  /** Front claw length (m) and base radius. */
  claw: [number, number];
  /** Toe turn-in of the front paws (rad, pigeon-toed). */
  turnIn: number;
}

const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Left legs (front + hind) with paws; mirror for the right side. */
export function bearLegsLeft(J: QuadJoints, o: BearLegSpec): Prim[] {
  const f = J.front, h = J.hind;
  const fToe = f.toe!, hToe = h.toe!;
  const P: Prim[] = [];
  // --- front: heavy upper arm, straight columnar forearm, wrist, broad paw
  P.push(cone('FL_upper', f.upper, f.lower, o.arm[0], o.arm[1], { blend: 0.08, part: 'body' }));
  P.push(cone('FL_lower', lerp3(f.lower, f.foot, -0.06), f.foot, o.arm[2], o.arm[3], { blend: 0.05, part: 'leg', region: 'FL' }));
  P.push(ellipsoid('FL_lower', lerp3(f.lower, f.foot, 0.3), [o.arm[2] * 1.02, 0.15, o.arm[2] * 1.05], { blend: 0.05, part: 'leg', region: 'FL' }));
  P.push(ellipsoid('FL_foot', [f.foot[0], f.foot[1] - 0.01, f.foot[2]], [o.arm[3] * 1.05, o.arm[3] * 0.95, o.arm[3] * 1.1], { blend: 0.04, part: 'leg', region: 'FL' }));
  const fw = o.frontPaw;
  const pc: Vec3 = [fToe[0], fw[2], (f.foot[2] + f.contact[2]) * 0.5 + 0.01];
  P.push(ellipsoid('FL_foot', pc, [fw[0], fw[2], fw[1]], { rot: [0, -o.turnIn, 0], blend: 0.04, part: 'paw', region: 'FL' }));
  // toes in an arc at the front of the paw (turned in)
  const ci = Math.cos(o.turnIn), si = Math.sin(o.turnIn);
  for (let i = 0; i < 5; i++) {
    const a = (i - 2) / 2; // -1..1 across the paw
    const lx = a * fw[0] * 0.78;
    const lz = fw[1] * 0.78 - a * a * fw[1] * 0.22;
    const tx = pc[0] + lx * ci - lz * si;
    const tz = pc[2] + lz * ci + lx * si;
    P.push(sphere('FL_toe', [tx, fw[2] * 0.72, tz], fw[0] * 0.27, { blend: 0.025, part: 'paw', region: 'FL' }));
    // claws: long, curved down in front of the toes
    const cl = o.claw[0] * (1 - Math.abs(a) * 0.25);
    const dx = -si, dz = ci;
    P.push(
      cone('FL_toe', [tx + dx * fw[0] * 0.18, fw[2] * 0.75, tz + dz * fw[0] * 0.18], [tx + dx * (fw[0] * 0.18 + cl), 0.008, tz + dz * (fw[0] * 0.18 + cl)], o.claw[1], o.claw[1] * 0.35, {
        blend: 0.008,
        part: 'claw',
        region: 'clawsF_L',
      }),
    );
  }
  P.push(roundBox('FL_toe', [f.contact[0], -0.05, pc[2]], [fw[0] * 1.6, 0.05, fw[1] * 1.6], 0.01, { sub: true, blend: 0.012, part: 'paw', region: 'FL' }));
  // --- hind: thick thigh, shin, heel, long flat sole (plantigrade)
  P.push(cone('HL_upper', h.upper, h.lower, o.thigh[0], o.thigh[1], { blend: 0.09, part: 'body' }));
  P.push(cone('HL_lower', lerp3(h.lower, h.foot, -0.05), h.foot, o.thigh[2], o.thigh[3], { blend: 0.05, part: 'leg', region: 'HL' }));
  P.push(ellipsoid('HL_lower', lerp3(h.lower, h.foot, 0.3), [o.thigh[2] * 1.05, 0.13, o.thigh[2] * 1.1], { rot: [0.5, 0, 0], blend: 0.05, part: 'leg', region: 'HL' }));
  const hw = o.hindPaw;
  const sc: Vec3 = [hToe[0], hw[2], (h.foot[2] + h.contact[2]) * 0.5 - 0.01];
  P.push(ellipsoid('HL_foot', [h.foot[0], h.foot[1] * 0.75, h.foot[2] - 0.015], [o.thigh[3] * 0.95, o.thigh[3] * 0.95, o.thigh[3]], { blend: 0.04, part: 'leg', region: 'HL' }));
  P.push(ellipsoid('HL_foot', sc, [hw[0], hw[2], hw[1]], { blend: 0.04, part: 'paw', region: 'HL' }));
  for (let i = 0; i < 5; i++) {
    const a = (i - 2) / 2;
    P.push(sphere('HL_toe', [sc[0] + a * hw[0] * 0.75, hw[2] * 0.72, sc[2] + hw[1] * 0.8 - a * a * hw[1] * 0.2], hw[0] * 0.26, { blend: 0.022, part: 'paw', region: 'HL' }));
  }
  P.push(roundBox('HL_toe', [h.contact[0], -0.05, sc[2]], [hw[0] * 1.6, 0.05, hw[1] * 1.6], 0.01, { sub: true, blend: 0.012, part: 'paw', region: 'HL' }));
  return P;
}

export function bearLegs(J: QuadJoints, o: BearLegSpec): Prim[] {
  const L = bearLegsLeft(J, o);
  return [...L, ...mirrorX(L)];
}

/** Small furry tail stub. */
export function bearTail(J: QuadJoints, r: number): Prim[] {
  const t = J.tail;
  return [ellipsoid('tail_1', [0, t[0][1] - 0.01, t[0][2] - 0.02], [r * 0.85, r, r * 1.2], { rot: [0.5, 0, 0], blend: 0.06, part: 'tail' })];
}

// ---------------------------------------------------------------------------
// Animation

export interface BearAnim {
  rear: RearUp;
  sit: RumpSit;
  side: SideLie;
  /** 'rear': stand up on the hind legs; 'roar': lowered head, open jaw, paw stomp. */
  call: 'rear' | 'roar';
  /** Head swing when walking (rad). */
  headSwing: number;
  /** Reaching the ground: front crouch (m), extra head pitch, max neck pitch. */
  reach: { front: number; head: number; maxPitch: number; neckLift: number };
  /** Muzzle height when the chin rests on the paws (m). */
  lieHead: number;
}

type Act = (ctx: AnimCtx, st: PRState, pose: Pose) => void;

const _A = new THREE.Vector3();
const _C = new THREE.Vector3();
const _P = new THREE.Vector3();

function bearDriver(p: QuadParams, b: BearAnim): AnimDriver<PRState> {
  /** Heavy, rolling plantigrade walk with a low swinging head. */
  const walk: Act = (ctx, st, pose) => {
    actWalk(ctx, st, pose);
    const k = st.amp * (1 - st.wg);
    const ph = st.phase * TAU;
    // head carried low, swinging side to side with the shoulders
    neckHead(ctx, pose, 0.12 * k, b.headSwing * k * Math.sin(ph), -0.05 * k, b.headSwing * 0.5 * k * Math.sin(ph - 0.5));
    // shoulders roll over the planted forelegs
    if (ctx.roles.chest >= 0) rotLocal(pose, ctx.roles.chest, 'z', 0.05 * k * Math.sin(ph + 0.3));
  };

  /** Idle: weight shifts, slow head swings, sniffing the air now and then. */
  const idle: Act = (ctx, st, pose) => {
    actIdle(ctx, st, pose);
    const sniff = pulses(ctx.time, 6.5, ctx.seed + 51, 2.2, 0.6);
    neckHead(ctx, pose, -0.25 * sniff, 0, -0.2 * sniff + 0.04 * sniff * Math.sin(ctx.time * TAU * 3.5), 0);
    jaw(ctx, pose, 0.03 * sniff);
  };

  /** Foraging: head down, sniffing and biting, a forepaw rakes the ground. */
  const eat: Act = (ctx, st, pose) => {
    crouch(ctx, st, pose, b.reach.front, 0.03, 0.06, 0);
    const t = ctx.time;
    const T = 1.6;
    const rake = pulses(t, 7, ctx.seed + 60, 3.2, 0.75);
    if (rake > 0) {
      // the left (or right) forepaw drags back toward the chest, lifts and reaches out again
      const leg = st.legs[(ctx.seed & 1) === 0 ? 0 : 1];
      const u = (t % T) / T;
      const back = u < 0.6 ? u / 0.6 : 1 - (u - 0.6) / 0.4;
      const lift = u < 0.6 ? 0 : Math.sin(((u - 0.6) / 0.4) * Math.PI);
      _C.copy(leg.r.contact);
      _C.z += (0.12 - back * 0.22) * rake;
      _C.y += (0.1 * lift + 0.015) * rake;
      _C.x += leg.side * 0.03 * rake;
      // paw pitched down a little so the claws dig
      const fp = 0.35 * rake, tp = 0.5 * rake;
      placeLeg(ctx, st, pose, leg, ankleFor(leg, _C, fp, tp, _A), fp, tp);
    }
    const chew = Math.sin(t * TAU * 1.5);
    const up = pulses(t, 8, ctx.seed + 61, 1.8, 0.5);
    // stretch the neck forward first so the muzzle lands in front of the paws
    if (ctx.roles.neck.length) rotLocal(pose, ctx.roles.neck[0], 'x', -b.reach.neckLift);
    reachMuzzle(ctx, pose, 0.04 + up * 0.25, b.reach.head + chew * 0.04, 0.25 * Math.sin(t * 0.5 + ctx.seed), b.reach.maxPitch);
    jaw(ctx, pose, 0.04 + 0.08 * Math.max(0, chew));
    ears(ctx, st, pose);
  };

  /** Drinking: a slight crouch over the forelegs, head down, lapping. */
  const drink: Act = (ctx, st, pose) => {
    crouch(ctx, st, pose, b.reach.front * 1.1, 0.05, 0.08, 0);
    const lap = Math.sin(ctx.time * TAU * 1.4);
    if (ctx.roles.neck.length) rotLocal(pose, ctx.roles.neck[0], 'x', -b.reach.neckLift);
    reachMuzzle(ctx, pose, 0.01 + lap * 0.01, b.reach.head + 0.1, 0, b.reach.maxPitch);
    jaw(ctx, pose, 0.05 + 0.06 * Math.max(0, lap));
    ears(ctx, st, pose, 0.1);
  };

  /** Lying on the belly, forearms flat on the ground in front, paws flat. */
  const lieBear = (ctx: AnimCtx, st: PRState, pose: Pose, headUp: boolean): void => {
    lie(ctx, st, pose, headUp ? 'up' : 'down');
    const rig = ctx.rig;
    for (const leg of st.legs) {
      if (leg.r.scap >= 0) rig.fkBone(pose, leg.r.scap);
      rig.fkBone(pose, leg.r.upper);
      const Hj = rig.wp[leg.r.upper];
      const reach = leg.reach;
      if (!leg.front) {
        // hind legs stretched out behind, soles turned up ("frog" lying)
        const dy = Math.max(0, Hj.y - 0.1);
        const back = Math.sqrt(Math.max(0, (reach * 0.9) ** 2 - dy * dy));
        _A.set(Hj.x + leg.side * 0.05, 0.1, Hj.z - back);
        _P.set(0, -1, 0.15).normalize();
        placeLegPole(ctx, pose, leg, _A, _P, -2.75, -2.95);
        continue;
      }
      // forearms flat along the ground, elbows tucked down and back (not winged out)
      const dy = Math.max(0, Hj.y - 0.08);
      const fwd = Math.sqrt(Math.max(0, (reach * 0.93) ** 2 - dy * dy));
      _A.set(Hj.x * 0.95, 0.08, Hj.z + fwd);
      _P.set(0, -0.7, -1).normalize();
      placeLegPole(ctx, pose, leg, _A, _P, -0.5, -0.05);
    }
    if (headUp) {
      neckHead(ctx, pose, -0.35, 0, -0.1, 0);
      const turn = 0.35 * glance(ctx.time, 6, ctx.seed + 9);
      neckHead(ctx, pose, 0, turn * 0.5, 0, turn * 0.3);
    } else {
      // chin resting on the forepaws
      rig.fk(pose);
      reachMuzzle(ctx, pose, b.lieHead, 0.15, 0.15 * Math.sin(ctx.seed), 1.6);
    }
  };

  /** Sleep: on the belly with the head on the paws, or sprawled on the side. */
  const sleep: Act = (ctx, st, pose) => {
    const v = variant(st, 'sleep', ctx.rand);
    if (v < 0.55) {
      lieBear(ctx, st, pose, false);
      return;
    }
    lieSide(ctx, st, pose, (ctx.seed & 1) === 0 ? 1 : -1, b.side, 0.02 * Math.sin(ctx.time * TAU * 0.16));
    ears(ctx, st, pose, 0.3);
  };

  /** Rest: sitting on the rump like a person, or lying with the head up. */
  const rest: Act = (ctx, st, pose) => {
    const v = variant(st, 'sit', ctx.rand);
    if (v < 0.45) {
      const k = smooth(0, 1.2, ctx.actionTime + 1.2);
      rumpSit(ctx, st, pose, k, b.sit, 0.015 * Math.sin(ctx.time * TAU * 0.25));
      lookAroundStill(ctx, pose, 0.7);
      ears(ctx, st, pose);
      return;
    }
    lieBear(ctx, st, pose, true);
  };

  /** Play: sitting up and batting with alternate forepaws, rolling the head. */
  const play: Act = (ctx, st, pose) => {
    const t = ctx.actionTime + ctx.rand * 3;
    rumpSit(ctx, st, pose, 1, b.sit, 0);
    const rig = ctx.rig;
    rig.fk(pose);
    const T = 1.4;
    const u = (t % (T * 2)) / (T * 2);
    const which = u < 0.5 ? 0 : 1;
    const local = (u % 0.5) * 2;
    const swat = Math.sin(Math.min(1, local / 0.7) * Math.PI);
    const leg = st.legs[which];
    if (leg.r.scap >= 0) rig.fkBone(pose, leg.r.scap);
    rig.fkBone(pose, leg.r.upper);
    const Hj = rig.wp[leg.r.upper];
    _A.set(Hj.x * 0.9, Hj.y - leg.scaledLen * (0.62 - 0.35 * swat), Hj.z + leg.scaledLen * (0.25 + 0.35 * swat));
    placeLeg(ctx, st, pose, leg, _A, 0.6 - 0.9 * swat, 0.8 - 0.6 * swat);
    neckHead(ctx, pose, 0.1 * swat, (which ? -0.25 : 0.25) * swat, 0.1, 0, (which ? 0.15 : -0.15) * swat);
    jaw(ctx, pose, 0.15 * swat);
    ears(ctx, st, pose, 0.2);
  };

  /** Call: rear up on the hind legs (grizzly) or a low-headed roar with a stomp (polar). */
  const call: Act = (ctx, st, pose) => {
    const at = ctx.actionTime;
    if (b.call === 'rear') {
      // rise 0–0.75 s, look around / sniff, drop back down 1.8–2.4 s
      const k = smooth(0.05, 0.75, at) * (1 - smooth(1.8, 2.4, at));
      const sway = Math.sin(at * TAU * 0.6) * k;
      rearUp(ctx, st, pose, k, b.rear, sway);
      const sniff = Math.sin(at * TAU * 2.2) * k;
      neckHead(ctx, pose, -0.1 * k, 0.35 * sway, -0.12 * k + 0.03 * sniff, 0.15 * sway);
      jaw(ctx, pose, 0.1 * smooth(0.9, 1.2, at) * (1 - smooth(1.5, 1.8, at)));
      ears(ctx, st, pose, -0.2 * k);
      // after landing: huff with the head low
      const huff = smooth(2.3, 2.6, at);
      if (huff > 0) {
        neckHead(ctx, pose, 0.25 * huff, 0, 0.1 * huff, 0);
        jaw(ctx, pose, 0.2 * huff * Math.max(0, Math.sin(at * TAU * 1.6)));
      }
      return;
    }
    actCall(ctx, st, pose);
    const env = smooth(0.2, 0.7, at) * (1 - smooth(st.p.callDuration - 0.5, st.p.callDuration, at));
    // head low and thrust forward, a forepaw stomps once
    neckHead(ctx, pose, 0.3 * env, 0.12 * Math.sin(at * 2.1) * env, -0.25 * env, 0);
    const stomp = pulses(at, 2.2, 3, 0.5, 1);
    if (stomp > 0) {
      const leg = st.legs[0];
      const rig = ctx.rig;
      rig.fkBone(pose, leg.r.upper);
      _C.copy(leg.r.contact);
      _C.y += 0.14 * stomp;
      _C.z += 0.06 * stomp;
      placeLeg(ctx, st, pose, leg, ankleFor(leg, _C, 0.4 * stomp, 0.3 * stomp, _A), 0.4 * stomp, 0.3 * stomp);
    }
    ears(ctx, st, pose, 0.8 * env);
  };

  /** Swimming: dog-paddle with the forelegs, hind legs trailing, head held up. */
  const swim: Act = (ctx, st, pose) => {
    const R = ctx.roles;
    const rig = ctx.rig;
    const t = ctx.time;
    pose.p[R.root].y -= st.p.swimSink + 0.015 * Math.sin(t * TAU * 0.5);
    rotParent(pose, R.root, 'x', -0.06);
    rig.fk(pose);
    const cyc = t * (0.7 + st.speed * 0.35);
    for (const leg of st.legs) {
      if (leg.r.scap >= 0) rig.fkBone(pose, leg.r.scap);
      rig.fkBone(pose, leg.r.upper);
      const Hj = rig.wp[leg.r.upper];
      if (leg.front) {
        // big paddling strokes, alternating
        const ph = (cyc + (leg.side > 0 ? 0 : 0.5)) * TAU;
        const rad = leg.scaledLen * 0.24;
        _A.set(Hj.x, Hj.y - leg.scaledLen * 0.55 + Math.sin(ph) * rad * 0.55, Hj.z + leg.scaledLen * 0.18 + Math.cos(ph) * rad);
        placeLeg(ctx, st, pose, leg, _A, 0.5 + Math.sin(ph) * 0.5, 0.3);
      } else {
        // hind legs stretched back as rudders, gently kicking
        const ph = (cyc * 0.5 + (leg.side > 0 ? 0.25 : 0.75)) * TAU;
        _A.set(Hj.x, Hj.y - leg.scaledLen * 0.45 + Math.sin(ph) * 0.03, Hj.z - leg.scaledLen * 0.45);
        placeLeg(ctx, st, pose, leg, _A, -1.1, -0.6);
      }
    }
    neckHead(ctx, pose, -0.4, 0.15 * Math.sin(t * 0.45 + ctx.seed), 0.25, 0);
    ears(ctx, st, pose, 0.2);
  };

  return {
    init: (ctx) => initPR(ctx, p),
    pre: prePR,
    actions: { idle, walk, eat, drink, sleep, rest, sit: rest, play, social: actSocial, call, swim },
    aliases: { run: 'walk', leave: 'walk' },
    fade: 0.45,
    fades: { sleep: 1.3, rest: 1.1, sit: 1.1, play: 0.8, call: 0.35, drink: 0.7 },
    transitions: { 'sleep>*': 1.5, 'rest>*': 1.2, 'sit>*': 1.1, 'sleep>rest': 1.0, 'rest>sleep': 1.0 },
  };
}

// ---------------------------------------------------------------------------
// Design assembly

export interface BearDesignSpec {
  joints: QuadJoints;
  /** Trunk, neck, head (with region 'head'), ears (region 'ears'). */
  prims: Prim[];
  legs: BearLegSpec;
  tailR: number;
  coat: CoatFn;
  look: LookSpec;
  eyes: EyeSpec[];
  regions?: Record<string, RegionOpts>;
  resolution?: number;
  quad: Partial<QuadParams>;
  anim: BearAnim;
  height: number;
  radius: number;
  babyScale?: number;
}

export function bearDesign(ctx: DesignContext, s: BearDesignSpec): CreatureDesign {
  const sk = quadSkeleton(s.joints);
  const p = quadParams(ctx.def.height, ctx.def.walkSpeed, ctx.def.runSpeed, s.quad);
  return {
    bones: sk.bones,
    roles: sk.roles,
    prims: [...s.prims, ...bearLegs(s.joints, s.legs), ...bearTail(s.joints, s.tailR)],
    regions: {
      head: { scale: 0.42 },
      ears: { scale: 0.2, aniso: [1.3, 1.3, 1] },
      FL: { scale: 0.4, aniso: [1, 1.6, 1] },
      FR: { scale: 0.4, aniso: [1, 1.6, 1] },
      HL: { scale: 0.4, aniso: [1, 1.6, 1] },
      HR: { scale: 0.4, aniso: [1, 1.6, 1] },
      clawsF_L: { scale: 0.2 },
      clawsF_R: { scale: 0.2 },
      ...s.regions,
    },
    resolution: s.resolution,
    coat: s.coat,
    look: s.look,
    eyes: s.eyes,
    anim: driver(bearDriver(p, s.anim)),
    babyScale: s.babyScale ?? 0.25,
    babyHead: 1.4,
    // cubs have short, stubby legs
    babyLegs: 0.85,
    babyBones: CUB_PAWS,
    height: s.height,
    radius: s.radius,
  };
}

/** Bear gait / pose defaults for a shoulder height (overridable per species). */
export function bearQuad(h: number, walkSpeed: number, runSpeed: number, o: Partial<QuadParams> = {}): Partial<QuadParams> {
  return {
    walk: {
      stride: 1.15 * h, refSpeed: walkSpeed, duty: 0.66, offsets: [0.18, 0.68, 0, 0.5], stepHeight: 0.07 * h,
      bob: 0.012 * h, bobFreq: 2, pitch: 0.01, roll: 0.05, headBob: 0.05, spineFlex: 0,
    },
    gallop: {
      stride: 2.6 * h, refSpeed: runSpeed, duty: 0.34, offsets: [0.5, 0.6, 0, 0.12], stepHeight: 0.16 * h,
      bob: 0.04 * h, bobFreq: 1, pitch: 0.08, roll: 0.02, headBob: 0.06, spineFlex: 0.12,
    },
    footFollow: 0.25,
    frontFlex: 1.5,
    hindFlex: -0.45,
    frontToeCurl: 0.5,
    hindToeCurl: 0.5,
    push: 0.45,
    scapSwing: 0.55,
    sitStyle: 'none',
    grazeReach: 0.12 * h,
    headCarry: 0.1,
    look: 0.5,
    tailSwish: 0,
    tailCarry: 0,
    earFlick: 0.3,
    callJaw: 0.55,
    callHead: 0.2,
    callDuration: 3.0,
    breath: 0.015,
    ...o,
  };
}

