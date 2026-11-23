// Generic two-legged animal driver (birds, penguins; a starting point for
// primates): planted-foot stepping with leg IK, body waddle / bob, head bob,
// wing / flipper motion, pecking (eat / drink), sitting down to sleep,
// swimming (body horizontal, low in the water) and a head-up call.

import * as THREE from 'three';
import { Pose, rotLocal, rotParent } from '../rig/rig';
import type { AnimCtx, AnimDriver } from '../types';
import { LegRT, placeLeg, plantLeg, reachMuzzle, neckHead } from './quadruped';
import { TAU, clamp, damp, fract, glance, smooth } from './util';

export interface BipedParams {
  /** Side-to-side body roll when walking (rad); penguins ≈ 0.14. */
  waddle: number;
  /** Forward head bob when walking (rad); pigeons / flamingos ≈ 0.06. */
  headBob: number;
  /** Foot lift as a fraction of leg length. */
  legLift: number;
  /** Stride length as a multiple of hip height at walk speed. */
  stride: number;
  duty: number;
  /** Hip height when sitting / sleeping as a fraction of rest. */
  sitDrop: number;
  /** How far the model sinks when swimming (fraction of hip height). */
  swimSink: number;
}

export class BipedState {
  phase = 0;
  speed = 0;
  amp = 0;
  stride = 0;
  hipsY = 1;
  legLen = 1;
  readonly legs: LegRT[] = [];
  constructor(readonly p: BipedParams) {}
}

const _C = new THREE.Vector3();
const _A = new THREE.Vector3();

function legsStep(ctx: AnimCtx, st: BipedState, pose: Pose): void {
  const rig = ctx.rig;
  const duty = st.p.duty;
  for (const leg of st.legs) {
    const lp = fract(st.phase + (leg.side > 0 ? 0 : 0.5));
    const L = st.stride * duty * st.amp;
    let dz: number, dy: number;
    if (lp < duty) {
      dz = L * (0.5 - lp / duty);
      dy = 0;
    } else {
      const w = (lp - duty) / (1 - duty);
      dz = L * (-0.5 + (0.5 - 0.5 * Math.cos(Math.PI * w)));
      dy = st.p.legLift * st.legLen * st.amp * Math.sin(Math.PI * w);
    }
    _C.copy(leg.r.contact);
    _C.z += dz;
    _C.y += dy;
    rig.fkBone(pose, leg.r.upper);
    plantLeg(ctx, null, pose, leg, _C, 0, 0);
  }
}

function bodyMotion(ctx: AnimCtx, st: BipedState, pose: Pose): void {
  const R = ctx.roles;
  const ph = st.phase * TAU;
  pose.p[R.root].y += -0.02 * st.legLen * st.amp * Math.cos(ph * 2);
  rotParent(pose, R.root, 'z', st.p.waddle * st.amp * Math.sin(ph) + 0.02 * Math.sin(ctx.time * 0.7));
  pose.p[R.root].x += 0.02 * st.legLen * st.amp * Math.sin(ph);
  if (R.chest >= 0) rotLocal(pose, R.chest, 'x', 0.015 * Math.sin(ctx.time * TAU * 0.4));
}

function wings(ctx: AnimCtx, pose: Pose, spread: number, flap: number): void {
  for (const s of ['L', 'R'] as const) {
    const a = ctx.roles.arms[s];
    if (!a) continue;
    const sx = s === 'L' ? 1 : -1;
    rotLocal(pose, a.upper, 'z', sx * (spread + flap));
  }
}

function look(ctx: AnimCtx, st: BipedState, pose: Pose, amount: number): void {
  const bob = st.p.headBob * st.amp * Math.sin(st.phase * TAU * 2);
  neckHead(ctx, pose, bob, amount * 0.5 * glance(ctx.time, 3.1, ctx.seed + 1), -bob * 0.5 + 0.1 * amount * glance(ctx.time, 4.3, ctx.seed + 2), amount * 0.4 * glance(ctx.time, 3.1, ctx.seed + 1));
}

function actWalk(ctx: AnimCtx, st: BipedState, pose: Pose): void {
  bodyMotion(ctx, st, pose);
  ctx.rig.fk(pose);
  legsStep(ctx, st, pose);
  wings(ctx, pose, 0.08 * st.amp, 0.05 * Math.sin(st.phase * TAU));
  look(ctx, st, pose, 1 - st.amp * 0.5);
}

function actEat(ctx: AnimCtx, st: BipedState, pose: Pose): void {
  bodyMotion(ctx, st, pose);
  const R = ctx.roles;
  rotParent(pose, R.root, 'x', 0.35);
  ctx.rig.fk(pose);
  legsStep(ctx, st, pose);
  const peck = Math.max(0, Math.sin(ctx.time * TAU * 0.9));
  reachMuzzle(ctx, pose, 0.02 + 0.08 * st.legLen * (1 - peck), 0.2);
}

function actSleep(ctx: AnimCtx, st: BipedState, pose: Pose): void {
  const R = ctx.roles;
  const rig = ctx.rig;
  pose.p[R.root].y -= st.hipsY * (1 - st.p.sitDrop);
  rig.fk(pose);
  for (const leg of st.legs) {
    rig.fkBone(pose, leg.r.upper);
    const H = rig.wp[leg.r.upper];
    _A.set(H.x, 0.02 * st.legLen, H.z + 0.05 * st.legLen);
    placeLeg(ctx, null, pose, leg, _A, 0, 0);
  }
  neckHead(ctx, pose, 0.6, 0.3 * Math.sin(ctx.seed), 0.4, 0);
  wings(ctx, pose, 0, 0);
}

function actSit(ctx: AnimCtx, st: BipedState, pose: Pose): void {
  actSleep(ctx, st, pose);
  neckHead(ctx, pose, -0.5, 0, -0.3, 0);
  look(ctx, st, pose, 0.6);
}

function actSwim(ctx: AnimCtx, st: BipedState, pose: Pose): void {
  const R = ctx.roles;
  pose.p[R.root].y -= st.hipsY * st.p.swimSink;
  rotParent(pose, R.root, 'x', 1.0);
  ctx.rig.fk(pose);
  const t = ctx.time;
  wings(ctx, pose, 0.3, 0.35 * Math.sin(t * TAU * (0.8 + st.speed)));
  neckHead(ctx, pose, -0.9, 0.2 * Math.sin(t * 0.7), -0.2, 0);
}

function actCall(ctx: AnimCtx, st: BipedState, pose: Pose): void {
  actWalk(ctx, st, pose);
  const k = smooth(0, 0.5, ctx.actionTime) * (1 - smooth(2.0, 2.6, ctx.actionTime));
  neckHead(ctx, pose, -0.5 * k, 0, -0.4 * k, 0);
  wings(ctx, pose, 0.5 * k, 0.2 * k * Math.sin(ctx.actionTime * TAU * 3));
}

function actPlay(ctx: AnimCtx, st: BipedState, pose: Pose): void {
  actWalk(ctx, st, pose);
  wings(ctx, pose, 0.3, 0.4 * Math.max(0, Math.sin(ctx.time * TAU * 1.5)));
}

export function bipedDriver(p: Partial<BipedParams> = {}): AnimDriver<BipedState> {
  const params: BipedParams = { waddle: 0.04, headBob: 0.03, legLift: 0.1, stride: 1.2, duty: 0.6, sitDrop: 0.25, swimSink: 0.9, ...p };
  return {
    init(ctx) {
      const st = new BipedState(params);
      (['HL', 'HR'] as const).forEach((id, i) => {
        const r = ctx.roles.legs[id];
        if (r) st.legs.push(new LegRT(ctx.rig, id, i, r));
      });
      st.hipsY = ctx.def.rest[ctx.roles.root * 3 + 1];
      st.legLen = st.legs.length ? st.legs[0].legLen : st.hipsY;
      st.phase = ctx.rand;
      return st;
    },
    pre(ctx, st) {
      st.speed += (ctx.speed - st.speed) * damp(0.15, ctx.dt);
      st.amp = smooth(0.01, 0.15, st.speed);
      st.stride = st.legLen * clamp(params.stride * (0.4 + st.speed / Math.max(0.2, st.legLen)), 0.2, 3);
      st.phase = fract(st.phase + (st.speed > 1e-3 ? st.speed / st.stride : 0) * ctx.dt);
    },
    actions: { idle: actWalk, walk: actWalk, eat: actEat, drink: actEat, sleep: actSleep, sit: actSit, swim: actSwim, call: actCall, play: actPlay, social: actWalk },
    aliases: { run: 'walk' },
    fade: 0.35,
    fades: { sleep: 0.9, sit: 0.8 },
    transitions: { 'sleep>*': 1.0, 'sit>*': 0.8 },
  };
}
