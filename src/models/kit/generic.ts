// Parametric placeholder builders. `genericQuadruped` makes a plausible
// four-legged animal from a SpeciesDef + a few proportions; `genericUpright`
// makes a two-legged upright animal (bird / penguin). Specialists replace
// these per species with sculpted designs (see zebra.ts / lion.ts).

import * as THREE from 'three';
import { cone, ellipsoid, roundBox, symmetric, type Prim, type Vec3 } from '../sdf/prims';
import { quadSkeleton, seat, surfacePoint, withRegion, type QuadJoints } from './quadruped';
import { quadParams, quadrupedDriver, type QuadParams } from '../anim/quadruped';
import { bipedDriver, type BipedParams } from '../anim/biped';
import { driver } from '../anim/util';
import { blendHex, clamp01, fbm, smooth } from '../coat/coat';
import type { BoneSpec } from '../rig/rig';
import type { CoatFn, CoatSample, CreatureDesign, DesignContext, LookSpec } from '../types';

export interface Palette {
  back: number;
  side: number;
  belly: number;
  legs?: number;
  feet?: number;
  muzzle?: number;
  tail?: number;
}

/** Countershaded coat from a palette (dark back → side → pale belly, darker legs / feet). */
export function paletteCoat(pal: Palette, bellyY: number): CoatFn {
  return (c: CoatSample) => {
    const n = fbm(c.x * 3, c.y * 3, c.z * 3, 2, 5);
    c.color.setHex(pal.side);
    blendHex(c.color, pal.back, clamp01(smooth(0.2, 0.9, c.ny) * 0.8 + n * 0.2));
    blendHex(c.color, pal.belly, clamp01(smooth(0.0, -0.7, c.ny) * 0.8 + smooth(bellyY + 0.1, bellyY - 0.1, c.y) * 0.2));
    if (pal.legs !== undefined) blendHex(c.color, pal.legs, clamp01((c.pw('leg') + c.pw('foot')) * 1.4) * 0.8);
    if (pal.feet !== undefined) blendHex(c.color, pal.feet, smooth(0.35, 0.7, c.pw('foot')));
    if (pal.muzzle !== undefined) blendHex(c.color, pal.muzzle, smooth(0.3, 0.7, c.pw('muzzle')));
    if (pal.tail !== undefined) blendHex(c.color, pal.tail, smooth(0.3, 0.7, c.pw('tuft')));
    if (c.part === 'horn' || c.part === 'tusk') {
      c.color.setHex(c.part === 'horn' ? 0x5c5148 : 0xe0d6bf);
      c.gloss = 0.2;
    }
  };
}

export interface GenericQuadOpts {
  /** Shoulder height in metres (default SpeciesDef.height). */
  shoulder?: number;
  /** Elbow height / shoulder height (default 0.55). */
  leg?: number;
  /** Torso length / SpeciesDef.length (default 0.6). */
  bodyLen?: number;
  /** Torso half-width / height (default 0.19). */
  girth?: number;
  /** Chest depth / height (default 0.45). */
  depth?: number;
  neckLen?: number;
  /** Neck angle above horizontal (rad, default 0.75). */
  neckAngle?: number;
  neckR?: number;
  headLen?: number;
  /** Head angle below horizontal (rad, default 0.55). */
  headAngle?: number;
  headR?: number;
  tailLen?: number;
  tuft?: boolean;
  earLen?: number;
  legR?: number;
  footR?: number;
  paws?: boolean;
  hump?: number;
  trunk?: number;
  horn?: number;
  tusks?: number;
  palette: Palette;
  skin?: LookSpec['skin'];
  gait?: Partial<QuadParams>;
  coat?: CoatFn;
  /** Mesh resolution multiplier (bulky animals ≈ 0.7). */
  resolution?: number;
}

/** A plausible generic four-legged animal for a species definition. */
export function genericQuadruped(ctx: DesignContext, o: GenericQuadOpts): CreatureDesign {
  const def = ctx.def;
  const h = o.shoulder ?? def.height;
  const L = def.length;
  const yE = (o.leg ?? 0.55) * h;
  const D = (o.depth ?? 0.45) * h;
  const Lb = (o.bodyLen ?? 0.6) * L;
  const gw = (o.girth ?? 0.19) * h;
  const legR = (o.legR ?? 0.07) * h;
  const footR = (o.footR ?? 0.03) * h;
  const midY = h - D / 2;
  const xf = gw * 0.62;
  const zf = Lb / 2 - 0.14 * Lb;
  const zh = -Lb / 2 + 0.16 * Lb;
  const paws = !!o.paws;
  const yW = paws ? 0.11 * h : 0.32 * yE;
  const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
  // neck & head
  const na = o.neckAngle ?? 0.75;
  const nl = (o.neckLen ?? 0.42) * h;
  const N0 = v(0, h - D * 0.3, Lb / 2 - 0.06 * Lb);
  const N1 = v(0, N0[1] + Math.sin(na) * nl, N0[2] + Math.cos(na) * nl);
  const ha = o.headAngle ?? 0.55;
  const hl = (o.headLen ?? 0.38) * h;
  const hr = (o.headR ?? 0.09) * h;
  const hd: Vec3 = [0, -Math.sin(ha), Math.cos(ha)];
  const tip = v(0, N1[1] + hd[1] * hl, N1[2] + hd[2] * hl);
  const nr = (o.neckR ?? 0.11) * h;
  const tl = (o.tailLen ?? 0.45) * h;
  const T0 = v(0, h - D * 0.18, -Lb / 2 + 0.02 * Lb);
  const tailPts: Vec3[] = [0, 1, 2, 3].map((i) => v(0, T0[1] - (tl * (i / 4)) * 0.85, T0[2] - (tl * (i / 4)) * 0.35));
  const J: QuadJoints = {
    hips: v(0, midY + 0.05 * D, zh),
    spine: [v(0, midY + 0.06 * D, zh * 0.4), v(0, midY + 0.06 * D, zf * 0.3)],
    chest: v(0, midY + 0.05 * D, zf * 0.75),
    neck: [N0, v(0, (N0[1] + N1[1]) / 2, (N0[2] + N1[2]) / 2)],
    head: N1,
    jaw: v(0, N1[1] - hr * 0.6, N1[2] + hr * 0.3),
    ear: v(hr * 0.6, N1[1] + hr * 0.7, N1[2] - hr * 0.2),
    tail: tailPts,
    front: {
      upper: v(xf, h - D * 0.42, zf + 0.06 * h),
      lower: v(xf, yE, zf - 0.04 * h),
      foot: v(xf * 0.95, yW, zf),
      toe: v(xf * 0.95, paws ? 0.04 * h : 0.1 * yE, zf + (paws ? 0.05 * h : 0.0)),
      contact: v(xf * 0.95, 0, zf + (paws ? 0.08 * h : 0.03 * h)),
    },
    hind: {
      upper: v(xf, h - D * 0.35, zh + 0.02 * h),
      lower: v(xf * 1.15, yE + 0.04 * h, zh + 0.12 * h),
      foot: v(xf * 0.95, yW + (paws ? 0.12 : 0.1) * h, zh - 0.1 * h),
      toe: v(xf * 0.95, paws ? 0.04 * h : 0.1 * yE, zh - 0.06 * h + (paws ? 0.03 * h : 0)),
      contact: v(xf * 0.95, 0, zh - 0.04 * h + (paws ? 0.06 * h : 0)),
    },
    muzzle: tip,
  };
  const extra: BoneSpec[] = [];
  const chains: Record<string, string[]> = {};
  const trunkPrims: Prim[] = [];
  if (o.trunk) {
    const tlen = o.trunk * h;
    const names = ['trunk_1', 'trunk_2', 'trunk_3', 'trunk_4'];
    const pts: Vec3[] = [0, 1, 2, 3, 4].map((i) => v(0, tip[1] + hr * 0.2 - tlen * (i / 4) * 0.95, tip[2] + tlen * (i / 4) * 0.25 - hr * 0.3));
    names.forEach((n, i) => extra.push({ name: n, parent: i === 0 ? 'head' : names[i - 1], pos: pts[i] }));
    chains.trunk = names;
    for (let i = 0; i < 4; i++) trunkPrims.push(cone(names[i], pts[i], pts[i + 1], hr * (0.55 - i * 0.1), hr * (0.45 - i * 0.1), { blend: 0.04 * h, part: 'muzzle', region: 'trunk' }));
  }
  J.extra = extra;
  J.chains = chains;
  const sk = quadSkeleton(J);
  const tuftPrims: Prim[] = o.tuft ? [ellipsoid('tail_4', v(0, tailPts[3][1] - tl * 0.15, tailPts[3][2] - tl * 0.05), [0.025 * h, 0.08 * h, 0.025 * h], { blend: 0.02 * h, part: 'tuft', region: 'tail' })] : [];
  const head: Prim[] = withRegion(
    [
      ellipsoid('head', v(0, N1[1] + hd[1] * hl * 0.22, N1[2] + hd[2] * hl * 0.22), [hr * 1.05, hr * 1.1, hr * 1.3], { rot: [ha, 0, 0], blend: 0.05 * h, part: 'head' }),
      cone('head', v(0, N1[1] + hd[1] * hl * 0.3, N1[2] + hd[2] * hl * 0.3), v(0, tip[1] + hr * 0.15, tip[2] - hr * 0.3), hr * 0.85, hr * 0.6, { blend: 0.05 * h, part: 'muzzle' }),
      ellipsoid('jaw', v(0, N1[1] - hr * 0.55 + hd[1] * hl * 0.5, N1[2] + hd[2] * hl * 0.5), [hr * 0.6, hr * 0.4, hl * 0.3], { rot: [ha, 0, 0], blend: 0.04 * h, part: 'muzzle' }),
      ...(o.horn ? [cone('head', v(0, tip[1] + hr * 0.5, tip[2] - hr * 0.6), v(0, tip[1] + hr * 0.5 + o.horn * h, tip[2] - hr * 0.3), hr * 0.35, hr * 0.04, { blend: 0.02 * h, part: 'horn' })] : []),
      ...(o.tusks ? symmetric([cone('head', v(hr * 0.4, tip[1], tip[2] - hr * 0.8), v(hr * 0.5, tip[1] - o.tusks * h * 0.6, tip[2] + o.tusks * h * 0.5), hr * 0.12, hr * 0.06, { blend: 0.01 * h, part: 'tusk' })]) : []),
    ],
    'head',
  );
  const earL = (o.earLen ?? 0.1) * h;
  const ears: Prim[] = symmetric([
    ellipsoid('ear.L', v(hr * 0.75, N1[1] + hr * 0.75 + earL * 0.3, N1[2] - hr * 0.2), [earL * 0.45, earL * 0.55, earL * 0.12], { rot: [-0.3, 0.3, -0.4], blend: 0.02 * h, part: 'ear', region: 'ears' }),
  ]);
  const legL = (id: 'FL' | 'HL'): Prim[] => {
    const lj = id === 'FL' ? J.front : J.hind;
    const P: Prim[] = [
      cone(`${id}_upper`, lj.upper, lj.lower, legR * 1.25, legR, { blend: 0.06 * h, part: 'body' }),
      cone(`${id}_lower`, lj.lower, lj.foot, legR * 0.9, footR * 1.2, { blend: 0.03 * h, part: 'leg', region: id }),
      cone(`${id}_foot`, lj.foot, lj.toe!, footR * 1.15, footR, { blend: 0.02 * h, part: 'leg', region: id }),
    ];
    if (paws) P.push(ellipsoid(`${id}_toe`, v(lj.contact[0], 0.03 * h, lj.contact[2] - 0.01 * h), [footR * 1.4, 0.035 * h, footR * 1.8], { blend: 0.02 * h, part: 'foot', region: id }));
    else P.push(cone(`${id}_toe`, lj.toe!, v(lj.contact[0], footR * 0.9, lj.contact[2]), footR, footR * 1.25, { blend: 0.015 * h, part: 'foot', region: id }));
    P.push(roundBox(`${id}_toe`, v(lj.contact[0], -0.05 * h, lj.contact[2]), [0.1 * h, 0.05 * h, 0.12 * h], 0.005 * h, { sub: true, blend: 0.005 * h, part: 'foot', region: id }));
    return P;
  };
  const tailPrims: Prim[] = [];
  for (let i = 0; i < 3; i++) tailPrims.push(cone(`tail_${i + 1}`, tailPts[i], tailPts[i + 1], 0.035 * h * (1 - i * 0.22), 0.035 * h * (1 - (i + 1) * 0.22), { blend: 0.02 * h, part: 'tail', region: i ? 'tail' : undefined }));
  tailPrims.push(cone('tail_4', tailPts[3], v(0, tailPts[3][1] - tl * 0.2, tailPts[3][2] - tl * 0.08), 0.012 * h, 0.01 * h, { blend: 0.02 * h, part: 'tail', region: 'tail' }));
  const prims: Prim[] = [
    ellipsoid('chest', v(0, midY, Lb * 0.24), [gw, D / 2, Lb * 0.3], { blend: 0.08 * h, part: 'body' }),
    ellipsoid('spine_2', v(0, midY - 0.02 * h, 0), [gw * 1.05, D / 2 * 1.02, Lb * 0.33], { blend: 0.08 * h, part: 'body' }),
    ellipsoid('hips', v(0, midY + 0.02 * h, -Lb * 0.26), [gw * 0.95, D / 2 * 0.95, Lb * 0.26], { blend: 0.08 * h, part: 'body' }),
    cone('neck_1', N0, N1, nr, nr * 0.72, { blend: 0.07 * h, part: 'neck' }),
    ...(o.hump ? [ellipsoid('spine_2', v(0, h + o.hump * h * 0.3, -0.02 * L), [gw * 0.7, o.hump * h, Lb * 0.18], { blend: 0.1 * h, part: 'body' })] : []),
    ...head,
    ...ears,
    ...trunkPrims,
    ...symmetric(legL('FL')),
    ...symmetric(legL('HL')),
    ...tailPrims,
    ...tuftPrims,
  ];
  const eyeDir: Vec3 = [-1, 0, -0.3];
  const ep = v(hr * 3, N1[1] + hd[1] * hl * 0.3 + hr * 0.25, N1[2] + hd[2] * hl * 0.3 + hr * 0.9);
  const eye = seat(surfacePoint(head, ep, eyeDir, hr * 4), eyeDir, 0.012 * h);
  const params = quadParams(h, def.walkSpeed, def.runSpeed, {
    lie: { hipsY: D * 0.6, chestY: D * 0.62, front: paws ? 'extend' : 'tuck', hindSplay: 0.05 * h, headRest: hr },
    sitStyle: paws ? 'cat' : 'none',
    swimSink: h * 0.8,
    ...o.gait,
  });
  const base = quadrupedDriver(params);
  const trunk = chains.trunk;
  return {
    bones: sk.bones,
    roles: sk.roles,
    prims,
    resolution: o.resolution ?? 1,
    regions: {
      head: { scale: 0.6 },
      ears: {},
      FL: { aniso: [1, 1.8, 1] },
      FR: { aniso: [1, 1.8, 1] },
      HL: { aniso: [1, 1.8, 1] },
      HR: { aniso: [1, 1.8, 1] },
      tail: { scale: 0.35, aniso: [1, 1.6, 1] },
      trunk: { scale: 0.45 },
    },
    coat: o.coat ?? paletteCoat(o.palette, midY - D / 2),
    look: { skin: o.skin ?? 'fur', pattern: 'none' },
    eyes: [{ bone: 'head', pos: eye, radius: Math.max(0.008, 0.012 * h) }],
    anim: driver(
      trunk
        ? {
            ...base,
            post: (c, s, pose) => {
              // gentle trunk sway on top of every action
              const R = c.roles.chains.trunk;
              for (let i = 0; i < R.length; i++) {
                const q = pose.q[R[i]];
                const a = 0.12 * Math.sin(c.time * 0.9 - i * 0.6);
                q.multiply(_trunkQ.setFromAxisAngle(_X, a + 0.05 * i));
              }
              void s;
            },
          }
        : base,
    ),
    babyScale: 0.35,
    babyHead: 1.25,
  };
}

const _trunkQ = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);

// ---------------------------------------------------------------------------
// Upright (bird / penguin) placeholder

export interface UprightOpts {
  kind: 'bird' | 'penguin';
  palette: Palette;
  /** Leg length / height (hip height). */
  leg: number;
  /** Body half-width / height. */
  girth: number;
  /** Body length (front-back) / height. */
  bodyLen: number;
  /** Neck length / height. */
  neck: number;
  headR: number;
  /** Beak / bill length / height. */
  beak: number;
  beakColor: number;
  /** Body pitch (rad): 0 horizontal (flamingo), ~1.4 upright (penguin). */
  upright: number;
  coat?: CoatFn;
  gait?: Partial<BipedParams>;
}

/** Upright two-legged placeholder (bird / penguin) with flippers / folded wings. */
export function genericUpright(ctx: DesignContext, o: UprightOpts): CreatureDesign {
  const h = ctx.def.height;
  const legH = o.leg * h;
  const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
  const bl = o.bodyLen * h;
  const gw = o.girth * h;
  const up = o.upright;
  // body axis from tail (back-low) to chest (front-up)
  const ax: Vec3 = [0, Math.sin(up), Math.cos(up)];
  const bc = v(0, legH + (o.kind === 'penguin' ? bl * 0.45 : gw * 0.9), 0);
  const chestP = v(0, bc[1] + ax[1] * bl * 0.3, bc[2] + ax[2] * bl * 0.3);
  const neckBase = v(0, bc[1] + ax[1] * bl * 0.45, bc[2] + ax[2] * bl * 0.45);
  const nl = o.neck * h;
  const headP = o.kind === 'bird' ? v(0, neckBase[1] + nl * 0.95, neckBase[2] + nl * 0.15) : v(0, neckBase[1] + nl, neckBase[2] + 0.02 * h);
  const hr = o.headR * h;
  const beakTip = v(0, headP[1] - (o.kind === 'bird' ? o.beak * h * 0.35 : 0.0), headP[2] + o.beak * h + hr * 0.6);
  const hipX = gw * 0.45;
  const knee = v(hipX, legH * 0.5, o.kind === 'bird' ? -0.04 * h : 0.01 * h);
  const ankle = v(hipX, o.kind === 'bird' ? 0.035 * h : 0.03 * h, 0);
  const bones: BoneSpec[] = [
    { name: 'hips', parent: null, pos: v(0, bc[1] - ax[1] * bl * 0.1, bc[2] - ax[2] * bl * 0.1) },
    { name: 'chest', parent: 'hips', pos: chestP },
    { name: 'neck_1', parent: 'chest', pos: neckBase },
    { name: 'neck_2', parent: 'neck_1', pos: v(0, (neckBase[1] + headP[1]) / 2, (neckBase[2] + headP[2]) / 2 + (o.kind === 'bird' ? 0.06 * h : 0)) },
    { name: 'head', parent: 'neck_2', pos: headP },
    { name: 'tail_1', parent: 'hips', pos: v(0, bc[1] - ax[1] * bl * 0.4, bc[2] - ax[2] * bl * 0.4) },
    ...(['L', 'R'] as const).flatMap((s) => {
      const sx = s === 'L' ? 1 : -1;
      return [
        { name: `HL_upper`.replace('L', s), parent: 'hips', pos: v(hipX * sx, legH + 0.02 * h, 0) },
        { name: `HL_lower`.replace('L', s), parent: `H${s}_upper`, pos: v(knee[0] * sx, knee[1], knee[2]) },
        { name: `HL_foot`.replace('L', s), parent: `H${s}_lower`, pos: v(ankle[0] * sx, ankle[1], ankle[2]) },
        { name: `wing.${s}`, parent: 'chest', pos: v(gw * 0.85 * sx, chestP[1] + 0.02 * h, chestP[2]) },
      ] as BoneSpec[];
    }),
  ];
  const legPrims: Prim[] = [
    cone('HL_upper', v(hipX, legH + 0.02 * h, 0), knee, 0.022 * h * (o.kind === 'penguin' ? 2 : 1), 0.012 * h * (o.kind === 'penguin' ? 2 : 1), { blend: 0.02 * h, part: 'leg', region: 'HL' }),
    cone('HL_lower', knee, ankle, 0.012 * h * (o.kind === 'penguin' ? 2 : 1), 0.01 * h * (o.kind === 'penguin' ? 2 : 1), { blend: 0.01 * h, part: 'leg', region: 'HL' }),
    ellipsoid('HL_foot', v(hipX, 0.012 * h, 0.05 * h), [0.035 * h, 0.012 * h, 0.06 * h], { blend: 0.01 * h, part: 'foot', region: 'HL' }),
  ];
  const head: Prim[] = withRegion(
    [
      ellipsoid('head', headP, [hr * 0.85, hr, hr * 1.1], { blend: 0.02 * h, part: 'head' }),
      cone('head', v(0, headP[1] - hr * 0.1, headP[2] + hr * 0.7), beakTip, hr * 0.42, hr * 0.12, { blend: 0.015 * h, part: 'beak' }),
    ],
    'head',
  );
  const prims: Prim[] = [
    ellipsoid('chest', bc, [gw, gw * 1.05, bl * 0.5], { rot: [-up, 0, 0], blend: 0.05 * h, part: 'body' }),
    ellipsoid('tail_1', v(0, bc[1] - ax[1] * bl * 0.42, bc[2] - ax[2] * bl * 0.42), [gw * 0.5, gw * 0.25, bl * 0.18], { rot: [-up, 0, 0], blend: 0.04 * h, part: 'tail' }),
    cone('neck_1', neckBase, v(0, (neckBase[1] + headP[1]) / 2, (neckBase[2] + headP[2]) / 2 + (o.kind === 'bird' ? 0.06 * h : 0)), (o.kind === 'bird' ? 0.035 : 0.1) * h, (o.kind === 'bird' ? 0.025 : 0.08) * h, { blend: 0.03 * h, part: 'neck', region: o.kind === 'bird' ? 'neck' : undefined }),
    cone('neck_2', v(0, (neckBase[1] + headP[1]) / 2, (neckBase[2] + headP[2]) / 2 + (o.kind === 'bird' ? 0.06 * h : 0)), headP, (o.kind === 'bird' ? 0.025 : 0.08) * h, hr * 0.7, { blend: 0.03 * h, part: 'neck', region: o.kind === 'bird' ? 'neck' : undefined }),
    ...head,
    ...symmetric([ellipsoid('wing.L', v(gw * 0.85, bc[1] + ax[1] * 0.02 * h, bc[2]), [gw * 0.2, gw * (o.kind === 'penguin' ? 1.0 : 0.7), bl * (o.kind === 'penguin' ? 0.2 : 0.42)], { rot: [-up, 0, 0], blend: 0.03 * h, part: 'wing' })]),
    ...symmetric(legPrims),
  ];
  const eyeDir: Vec3 = [-1, 0, -0.2];
  const eye = seat(surfacePoint(head, v(hr * 3, headP[1] + hr * 0.2, headP[2] + hr * 0.5), eyeDir, hr * 4), eyeDir, 0.004 * h);
  return {
    bones,
    roles: {
      root: 'hips',
      chest: 'chest',
      neck: ['neck_1', 'neck_2'],
      head: 'head',
      tail: ['tail_1'],
      legs: {
        HL: { upper: 'HL_upper', lower: 'HL_lower', foot: 'HL_foot', contact: v(hipX, 0, 0.03 * h) },
        HR: { upper: 'HR_upper', lower: 'HR_lower', foot: 'HR_foot', contact: v(-hipX, 0, 0.03 * h) },
      },
      arms: {
        L: { upper: 'wing.L', lower: 'wing.L', hand: 'wing.L' },
        R: { upper: 'wing.R', lower: 'wing.R', hand: 'wing.R' },
      },
      muzzle: beakTip,
    },
    prims,
    regions: { head: { scale: 0.6 }, HL: { aniso: [1, 2, 1] }, HR: { aniso: [1, 2, 1] }, neck: { scale: 0.6 } },
    coat:
      o.coat ??
      ((c) => {
        paletteCoat(o.palette, bc[1])(c);
        if (c.part === 'beak' || c.pw('beak') > 0.5) c.color.setHex(o.beakColor);
        if (c.part === 'leg' || c.part === 'foot') c.color.setHex(o.palette.feet ?? o.beakColor);
      }),
    look: { skin: 'feather', pattern: 'none', sheen: 0.15 },
    eyes: [{ bone: 'head', pos: eye, radius: Math.max(0.006, 0.012 * h) }],
    anim: driver(bipedDriver({ waddle: o.kind === 'penguin' ? 0.14 : 0.03, headBob: o.kind === 'bird' ? 0.06 : 0.0, legLift: o.kind === 'penguin' ? 0.03 : 0.12, ...o.gait })),
    babyScale: 0.4,
    babyHead: 1.3,
  };
}
