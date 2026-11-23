// Quadruped skeleton kit: joint positions (left side, x > 0) → bones + roles,
// and leg primitive helpers. Bone names:
//   hips, spine_1..n, chest, neck_1..n, head, jaw, ear.L/R, tail_1..n,
//   FL_scap, FL_upper, FL_lower, FL_foot, FL_toe (FR_, HL_, HR_ likewise).

import { CompiledPrim, cone, ellipsoid, mirrorX, roundBox, type Prim, type PrimOpts, type Vec3 } from '../sdf/prims';
import { SdfField } from '../sdf/field';
import type { BoneSpec } from '../rig/rig';
import type { LegSpec, RigRoles } from '../types';

export interface LegJoints {
  scap?: Vec3;
  upper: Vec3;
  lower: Vec3;
  foot: Vec3;
  toe?: Vec3;
  contact: Vec3;
}

export interface QuadJoints {
  hips: Vec3;
  spine: Vec3[];
  chest: Vec3;
  neck: Vec3[];
  head: Vec3;
  jaw?: Vec3;
  /** Left ear base (mirrored). */
  ear?: Vec3;
  tail: Vec3[];
  /** Left front / hind legs (mirrored to the right). */
  front: LegJoints;
  hind: LegJoints;
  /** Mouth / muzzle tip (rest, model space). */
  muzzle: Vec3;
  /** Extra bones (trunk, horns…) appended verbatim. */
  extra?: BoneSpec[];
  /** Extra chains for roles.chains. */
  chains?: Record<string, string[]>;
}

const mx = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];

export function quadSkeleton(j: QuadJoints): { bones: BoneSpec[]; roles: RigRoles } {
  const bones: BoneSpec[] = [{ name: 'hips', parent: null, pos: j.hips }];
  let prev = 'hips';
  const spine: string[] = [];
  j.spine.forEach((p, i) => {
    const n = `spine_${i + 1}`;
    bones.push({ name: n, parent: prev, pos: p });
    spine.push(n);
    prev = n;
  });
  bones.push({ name: 'chest', parent: prev, pos: j.chest });
  prev = 'chest';
  const neck: string[] = [];
  j.neck.forEach((p, i) => {
    const n = `neck_${i + 1}`;
    bones.push({ name: n, parent: prev, pos: p });
    neck.push(n);
    prev = n;
  });
  bones.push({ name: 'head', parent: prev, pos: j.head });
  if (j.jaw) bones.push({ name: 'jaw', parent: 'head', pos: j.jaw });
  const ears: string[] = [];
  if (j.ear) {
    bones.push({ name: 'ear.L', parent: 'head', pos: j.ear });
    bones.push({ name: 'ear.R', parent: 'head', pos: mx(j.ear) });
    ears.push('ear.L', 'ear.R');
  }
  const tail: string[] = [];
  prev = 'hips';
  j.tail.forEach((p, i) => {
    const n = `tail_${i + 1}`;
    bones.push({ name: n, parent: prev, pos: p });
    tail.push(n);
    prev = n;
  });
  const legs: RigRoles['legs'] = {};
  const addLeg = (id: 'FL' | 'FR' | 'HL' | 'HR', lj: LegJoints, parent: string, mirror: boolean) => {
    const P = (v: Vec3) => (mirror ? mx(v) : v);
    let par = parent;
    const spec: LegSpec = { upper: `${id}_upper`, lower: `${id}_lower`, foot: `${id}_foot`, contact: P(lj.contact) };
    if (lj.scap) {
      bones.push({ name: `${id}_scap`, parent: par, pos: P(lj.scap) });
      par = `${id}_scap`;
      spec.scap = `${id}_scap`;
    }
    bones.push({ name: `${id}_upper`, parent: par, pos: P(lj.upper) });
    bones.push({ name: `${id}_lower`, parent: `${id}_upper`, pos: P(lj.lower) });
    bones.push({ name: `${id}_foot`, parent: `${id}_lower`, pos: P(lj.foot) });
    if (lj.toe) {
      bones.push({ name: `${id}_toe`, parent: `${id}_foot`, pos: P(lj.toe) });
      spec.toe = `${id}_toe`;
    }
    legs[id] = spec;
  };
  addLeg('FL', j.front, 'chest', false);
  addLeg('FR', j.front, 'chest', true);
  addLeg('HL', j.hind, 'hips', false);
  addLeg('HR', j.hind, 'hips', true);
  if (j.extra) bones.push(...j.extra);
  return {
    bones,
    roles: {
      root: 'hips',
      spine,
      chest: 'chest',
      neck,
      head: 'head',
      jaw: j.jaw ? 'jaw' : undefined,
      tail,
      ears,
      legs,
      muzzle: j.muzzle,
      chains: j.chains,
    },
  };
}

export interface LegRadii {
  /** upper segment (shoulder→elbow / hip→stifle) start & end radius */
  upper: [number, number];
  lower: [number, number];
  foot: [number, number];
  toe?: [number, number];
}

/**
 * Generic tapered leg (left side) from joints; mirrored copy for the right
 * side is returned too. The lower part (lower, foot, toe) goes into a detail
 * region named `${id}` so thin legs stay round.
 */
export function legPrims(id: 'FL' | 'HL', lj: LegJoints, r: LegRadii, opts: PrimOpts = {}, regionFrom: 'lower' | 'foot' = 'lower'): Prim[] {
  const region = id;
  const prims: Prim[] = [];
  prims.push(cone(`${id}_upper`, lj.upper, lj.lower, r.upper[0], r.upper[1], { blend: 0.05, part: 'leg', ...opts }));
  const lowerOpts: PrimOpts = { blend: 0.025, part: 'leg', ...opts, region: regionFrom === 'lower' ? region : undefined };
  prims.push(cone(`${id}_lower`, lj.lower, lj.foot, r.lower[0], r.lower[1], lowerOpts));
  const end = lj.toe ?? lj.contact;
  prims.push(cone(`${id}_foot`, lj.foot, end, r.foot[0], r.foot[1], { blend: 0.02, part: 'leg', ...opts, region }));
  if (lj.toe && r.toe) prims.push(cone(`${id}_toe`, lj.toe, [lj.contact[0], r.toe[1], lj.contact[2]], r.toe[0], r.toe[1], { blend: 0.015, part: 'foot', ...opts, region }));
  return prims;
}

/** Mirror left-side primitives to the right and return both. */
export function bilateral(prims: Prim[]): Prim[] {
  return [...prims, ...mirrorX(prims)];
}

/** A flat-bottomed hoof (left) centred over the contact point. */
export function hoof(id: 'FL' | 'HL', contact: Vec3, w: number, h: number, len: number, region?: string): Prim {
  return roundBox(`${id}_toe`, [contact[0], h * 0.5, contact[2]], [w, h * 0.5, len], Math.min(w, h * 0.5) * 0.8, {
    blend: 0.012,
    part: 'hoof',
    region: region ?? id,
    rot: [0.12, 0, 0],
  });
}

export { ellipsoid, cone };


/**
 * March from `from` along `dir` until the surface of the (additive +
 * subtractive) primitives is hit; returns the hit point (or `from` if
 * nothing was hit within maxDist). Handy for seating eyes on a head.
 */
export function surfacePoint(prims: readonly Prim[], from: Vec3, dir: Vec3, maxDist = 1): Vec3 {
  const compiled = prims.map((p) => new CompiledPrim(p, 0, 0, -1));
  const f = new SdfField(compiled);
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const d: Vec3 = [dir[0] / l, dir[1] / l, dir[2] / l];
  let t = 0;
  let prev = f.evalAll(from[0], from[1], from[2]);
  const step = 0.002;
  while (t < maxDist) {
    t += step;
    const v = f.evalAll(from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t);
    if ((prev > 0) !== (v > 0)) {
      const tt = t - step * (v / (v - prev));
      return [from[0] + d[0] * tt, from[1] + d[1] * tt, from[2] + d[2] * tt];
    }
    prev = v;
  }
  return from;
}

/** Point a distance `inset` behind a surface point along the march direction. */
export function seat(p: Vec3, dir: Vec3, inset: number): Vec3 {
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  return [p[0] + (dir[0] / l) * inset, p[1] + (dir[1] / l) * inset, p[2] + (dir[2] / l) * inset];
}

/** Put primitives that have no region yet into `region` (e.g. a finer 'head' grid). */
export function withRegion(prims: readonly Prim[], region: string): Prim[] {
  return prims.map((p) => (p.region ? p : { ...p, region }));
}

/**
 * `babyBones` for cubs (big cats, bears): big, clumsy paws on their short
 * legs (the foot and toe scales multiply the design's `babyLegs`).
 */
export const CUB_PAWS: Readonly<Record<string, number>> = {
  FL_foot: 1.2, FR_foot: 1.2, FL_toe: 1.2, FR_toe: 1.2,
  HL_foot: 1.12, HR_foot: 1.12, HL_toe: 1.25, HR_toe: 1.25,
};
