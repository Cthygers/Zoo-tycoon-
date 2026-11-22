// Shared helpers for the special-rig species (gorilla / penguin / flamingo):
// allocation-free limb reaching, step cycles and small pose utilities. Only
// the species files in src/models/species use them.

import * as THREE from 'three';
import type { Pose } from '../../rig/rig';
import type { AnimCtx } from '../../types';
import type { LegRT } from '../../anim/quadruped';
import { smooth } from '../../anim/util';

const _pole = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);

/**
 * Two-bone reach of a limb's end joint (LegRT chain upper → lower → foot) to a
 * model-space target. `poleBias` (model space, may be null) is added to the
 * rest bend direction (carried by the parent) to steer the elbow / knee.
 * The end bone keeps its rest orientation relative to the lower bone unless
 * `endWorld` is given. Returns the reach ratio.
 */
export function reachLimb(
  ctx: AnimCtx,
  pose: Pose,
  leg: LegRT,
  target: THREE.Vector3,
  poleBias: THREE.Vector3 | null = null,
  endWorld: THREE.Quaternion | null = null,
): number {
  const rig = ctx.rig;
  const r = leg.r;
  const parent = ctx.def.parent[r.upper];
  _pole.copy(leg.chain.restPole);
  if (parent >= 0) _pole.applyQuaternion(rig.wq[parent]);
  if (poleBias) _pole.add(poleBias).normalize();
  const ratio = leg.chain.solve(rig, pose, target, _pole);
  if (endWorld) rig.setWorldRot(pose, r.foot, endWorld);
  else rig.fkBone(pose, r.foot);
  if (r.toe >= 0) rig.fkBone(pose, r.toe);
  return ratio;
}

/** World (model-space) quaternion from XYZ-ish axis angles applied in order Y, X, Z (yaw, pitch, roll). */
export function worldQuat(out: THREE.Quaternion, pitch: number, yaw: number, roll: number): THREE.Quaternion {
  out.setFromAxisAngle(_Y, yaw);
  if (pitch !== 0) out.multiply(_q.setFromAxisAngle(_X, pitch));
  if (roll !== 0) out.multiply(_q.setFromAxisAngle(_Z, roll));
  return out;
}

/** Stance / swing cycle of one foot: writes dz (fore-aft offset), lift (0..1) and swing progress. */
export interface StepOut {
  dz: number;
  lift: number;
  /** 0..1 progress through swing, or −1 in stance. */
  swing: number;
  /** 0..1 progress through stance, or −1 in swing. */
  stance: number;
}

export function stepCycle(lp: number, duty: number, len: number, out: StepOut): StepOut {
  if (lp < duty) {
    const u = lp / duty;
    out.dz = len * (0.5 - u);
    out.lift = 0;
    out.swing = -1;
    out.stance = u;
  } else {
    const w = (lp - duty) / (1 - duty);
    out.dz = len * (-0.5 + (0.5 - 0.5 * Math.cos(Math.PI * w)));
    out.lift = Math.sin(Math.PI * Math.min(1, w * 1.08));
    out.swing = w;
    out.stance = -1;
  }
  return out;
}

/** Smooth on/off envelope for a one-shot action of `dur` seconds (attack / release). */
export function envelope(t: number, dur: number, attack: number, release: number): number {
  return smooth(0, attack, t) * (1 - smooth(dur - release, dur, t));
}

/**
 * Slow "behaviour" switch for idles: returns 0..1 that holds 0 or 1 for random
 * stretches of `period` seconds with smooth `blend`-second transitions.
 */
export function moodSwitch(t: number, period: number, seed: number, prob: number, blend: number): number {
  const k = Math.floor(t / period);
  const f = t - k * period;
  const a = hashU(k, seed) < prob ? 1 : 0;
  const b = hashU(k + 1, seed) < prob ? 1 : 0;
  if (a === b) return a;
  return a + (b - a) * smooth(period - blend, period, f);
}

/** Hash of an integer + seed → [0,1). */
export function hashU(k: number, seed: number): number {
  let h = Math.imul((k | 0) ^ Math.imul(seed | 0, 0x27d4eb2d), 0x2c1b3c6d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

