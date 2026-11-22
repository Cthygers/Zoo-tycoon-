// Giraffe (Giraffa camelopardalis reticulata). Sculpted SDF body with a
// sloping back, a two-metre neck on four bones with a short stiff mane,
// ossicones (thick bald knobs on bulls, tufted on cows, plus the bull's
// median lump), knobbly knees on very long legs and big dark hooves. Coat:
// liver-brown polygonal patches separated by a cream network (signed
// two-sublattice Voronoi field drawn as per-pixel lines), smaller patches on
// the neck, face and upper legs, pale lower legs and belly.
//
// Animation: pacing walk (same-side legs together) with neck pumping, a
// rocking gallop with big neck swings, browsing HIGH (neck up, head tilted
// back, chewing / stripping), drinking with the forelegs splayed wide, lying
// down front-first / getting up hind-first, sleeping with the neck curled
// back and the head resting on the rump, a snort / head toss call, neck
// swinging play and nuzzling.

import * as THREE from 'three';
import { cone, ellipsoid, mirrorX, roundBox, symmetric, type Prim, type Vec3 } from '../sdf/prims';
import { quadSkeleton, seat, surfacePoint, withRegion, type QuadJoints } from '../kit/quadruped';
import {
  advanceGait,
  body,
  ears,
  initQuad,
  jaw,
  legs as legsBlock,
  lie,
  lookAround,
  lookAroundStill,
  placeLeg,
  plantLeg,
  quadParams,
  quadrupedDriver,
  reachMuzzle,
  tail,
  type LegRT,
  type QuadState,
} from '../anim/quadruped';
import { driver, glance, pulses, TAU } from '../anim/util';
import { Pose, rotLocal, rotParent } from '../rig/rig';
import { blendHex, clamp01, fbm, smooth } from '../coat/coat';
import type { AnimCtx, CoatSample, CreatureDesign, DesignContext, SpeciesModel } from '../types';
import { Posture, blendInto, envelope, lerpV, reticulation, riseOverlay, updatePosture } from './species-large-herbivores/common';

// ---------------------------------------------------------------------------
// Proportions (bull: withers 3.25 m, ossicone tips ≈ 5.2 m)

const N: Vec3[] = [
  [0, 3.0, 0.85],
  [0, 3.5, 1.12],
  [0, 4.0, 1.38],
  [0, 4.48, 1.63],
];
const POLL: Vec3 = [0, 4.92, 1.86];
const HA = 0.7; // head axis: 40° below horizontal
const HD: Vec3 = [0, -Math.sin(HA), Math.cos(HA)];
const HUP: Vec3 = [0, Math.cos(HA), Math.sin(HA)];
/** Point on the head: `t` along the axis from the poll, `u` up (dorsal), `x` sideways. */
const hp = (t: number, u = 0, x = 0): Vec3 => [x, POLL[1] + HD[1] * t + HUP[1] * u, POLL[2] + HD[2] * t + HUP[2] * u];

const J: QuadJoints = {
  hips: [0, 2.55, -0.82],
  spine: [
    [0, 2.68, -0.35],
    [0, 2.85, 0.1],
  ],
  chest: [0, 2.95, 0.55],
  neck: N,
  head: POLL,
  jaw: hp(0.2, -0.1),
  ear: [0.085, 4.97, 1.84],
  tail: [
    [0, 2.62, -1.12],
    [0, 2.28, -1.22],
    [0, 1.9, -1.26],
    [0, 1.55, -1.27],
  ],
  front: {
    scap: [0.17, 3.0, 0.48],
    upper: [0.22, 2.38, 0.92],
    lower: [0.2, 1.86, 0.55],
    foot: [0.18, 1.0, 0.78],
    toe: [0.18, 0.28, 0.8],
    contact: [0.18, 0, 0.87],
  },
  hind: {
    upper: [0.2, 2.45, -0.85],
    lower: [0.24, 1.85, -0.58],
    foot: [0.19, 1.13, -0.98],
    toe: [0.18, 0.28, -0.94],
    contact: [0.18, 0, -0.89],
  },
  muzzle: hp(0.69, -0.04),
};

const NECK_ANG = Math.atan2(N[1][1] - N[0][1], N[1][2] - N[0][2]);
const NROT: Vec3 = [-NECK_ANG, 0, 0];
/** Dorsal direction perpendicular to the neck axis. */
const NUP: Vec3 = [0, Math.cos(NECK_ANG), -Math.sin(NECK_ANG)];

// ---------------------------------------------------------------------------
// Sculpt

function bodyPrims(male: boolean): Prim[] {
  const g = male ? 1 : 0.94;
  return [
    ellipsoid('chest', [0, 2.62, 0.58], [0.36 * g, 0.6, 0.5], { blend: 0.14, part: 'body' }),
    ellipsoid('chest', [0, 3.04, 0.45], [0.17 * g, 0.22, 0.42], { blend: 0.16, part: 'body' }),
    ellipsoid('chest', [0, 2.36, 0.96], [0.25 * g, 0.3, 0.22], { blend: 0.12, part: 'body' }),
    ellipsoid('spine_2', [0, 2.56, 0.05], [0.4 * g, 0.5, 0.55], { blend: 0.15, part: 'body' }),
    ellipsoid('spine_1', [0, 2.5, -0.45], [0.36 * g, 0.44, 0.45], { blend: 0.15, part: 'belly' }),
    ellipsoid('hips', [0, 2.48, -0.86], [0.31 * g, 0.38, 0.34], { blend: 0.14, part: 'body' }),
    ellipsoid('hips', [0, 2.7, -0.8], [0.22 * g, 0.14, 0.36], { blend: 0.14, part: 'body' }),
    ...symmetric([
      ellipsoid('FL_scap', [0.19, 2.68, 0.62], [0.12, 0.46, 0.24], { rot: [-0.35, 0, 0], blend: 0.1, part: 'body' }),
      ellipsoid('HL_upper', [0.2, 2.3, -0.8], [0.14, 0.42, 0.3], { blend: 0.12, part: 'body' }),
      ellipsoid('HL_upper', [0.13, 2.38, -1.03], [0.14, 0.35, 0.16], { blend: 0.12, part: 'body' }),
    ]),
  ];
}

function neckPrims(male: boolean): Prim[] {
  const g = male ? 1.06 : 0.95;
  const segs: [string, Vec3, Vec3, number, number][] = [
    ['neck_1', [0, 2.82, 0.76], N[1], 0.2, 0.33],
    ['neck_2', N[1], N[2], 0.16, 0.24],
    ['neck_3', N[2], N[3], 0.13, 0.172],
    ['neck_4', N[3], POLL, 0.11, 0.138],
  ];
  return segs.map(([bone, a, b, rw, rd]) => {
    const c = lerpV(a, b, 0.5);
    const len = Math.hypot(b[1] - a[1], b[2] - a[2]);
    return ellipsoid(bone, c, [rw * g, rd * g, len * 0.72], { rot: NROT, blend: 0.14, part: 'neck', region: bone === 'neck_1' ? undefined : 'neck' });
  });
}

/** Short, stiff, upright mane along the back of the neck. */
function manePrims(): Prim[] {
  const P: Prim[] = [];
  const pts: Vec3[] = [[0, 3.12, 0.62], N[1], N[2], N[3], POLL];
  const depth = [0.22, 0.21, 0.17, 0.135, 0.11];
  const bones = ['chest', 'neck_1', 'neck_2', 'neck_3'];
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[i + 1];
    const m = lerpV(a, b, 0.5);
    const d = (depth[i] + depth[i + 1]) / 2 + 0.035;
    const c: Vec3 = [0, m[1] + NUP[1] * d, m[2] + NUP[2] * d];
    const len = Math.hypot(b[1] - a[1], b[2] - a[2]);
    P.push(
      ellipsoid(bones[i], c, [0.022, 0.06, len * 0.62], {
        rot: NROT,
        blend: 0.05,
        part: 'mane',
        region: 'mane',
        noise: { amp: 0.009, freq: 55, stretch: [1, 0.12, 1], ridged: true, octaves: 2, seed: 61 },
      }),
    );
  }
  return P;
}

function headPrims(male: boolean): Prim[] {
  const P: Prim[] = [
    ellipsoid('head', hp(0.1, 0.03), [0.115, 0.12, 0.17], { rot: [HA, 0, 0], blend: 0.06, part: 'head' }),
    ellipsoid('head', hp(0.33, 0.0), [0.098, 0.1, 0.2], { rot: [HA, 0, 0], blend: 0.06, part: 'head' }),
    ellipsoid('head', hp(0.56, -0.015), [0.074, 0.088, 0.13], { rot: [HA, 0, 0], blend: 0.05, part: 'muzzle' }),
    // prehensile upper lip
    ellipsoid('head', hp(0.66, -0.06), [0.064, 0.055, 0.07], { rot: [HA, 0, 0], blend: 0.03, part: 'muzzle' }),
    // jaw + chin
    ellipsoid('jaw', hp(0.4, -0.085), [0.07, 0.05, 0.22], { rot: [HA, 0, 0], blend: 0.04, part: 'head' }),
    ellipsoid('jaw', hp(0.63, -0.1), [0.048, 0.035, 0.06], { blend: 0.025, part: 'muzzle' }),
    // brow ridges over the large eyes
    ...symmetric([ellipsoid('head', hp(0.16, 0.06, 0.085), [0.05, 0.045, 0.06], { blend: 0.04, part: 'head' })]),
    // ossicones: thick bald knobs (bull) / slim with hair tufts (cow)
    ...symmetric([
      cone('head', hp(0.03, 0.08, 0.055), hp(-0.06, 0.25, 0.075), male ? 0.042 : 0.03, male ? 0.036 : 0.024, { blend: 0.04, part: 'ossicone' }),
      ellipsoid('head', hp(-0.065, 0.265, 0.077), male ? [0.045, 0.04, 0.045] : [0.036, 0.04, 0.036], { blend: 0.02, part: male ? 'knob' : 'tuft' }),
    ]),
    // mouth line, nostrils
    ellipsoid('head', hp(0.66, -0.095), [0.065, 0.006, 0.05], { rot: [HA - 0.3, 0, 0], sub: true, blend: 0.008, part: 'muzzle' }),
    ...symmetric([ellipsoid('head', hp(0.6, 0.06, 0.03), [0.012, 0.03, 0.012], { rot: [HA, 0, -0.3], sub: true, blend: 0.008, part: 'muzzle' })]),
  ];
  if (male) P.push(ellipsoid('head', hp(0.22, 0.1), [0.042, 0.04, 0.055], { rot: [HA, 0, 0], blend: 0.05, part: 'head' }));
  return P;
}

function earPrims(): Prim[] {
  const base: Vec3 = [0.085, 4.97, 1.84];
  const tip: Vec3 = [0.31, 4.98, 1.76];
  const mid = lerpV(base, tip, 0.5);
  const rot: Vec3 = [0.2, 0.36, -0.05];
  const left: Prim[] = [
    ellipsoid('ear.L', mid, [0.125, 0.05, 0.024], { rot, blend: 0.02, part: 'ear', region: 'ears' }),
    ellipsoid('ear.L', [mid[0] + 0.008, mid[1] + 0.006, mid[2] + 0.02], [0.095, 0.034, 0.014], { rot, sub: true, blend: 0.006, part: 'ear', region: 'ears' }),
    cone('ear.L', [0.075, 4.97, 1.85], [0.13, 4.975, 1.83], 0.028, 0.03, { blend: 0.02, part: 'ear', region: 'ears' }),
  ];
  return [...left, ...mirrorX(left)];
}

function legPrimsLeft(): Prim[] {
  const f = J.front, h = J.hind;
  return [
    // front: upper arm in the body, muscular forearm, knobbly knee, slim cannon, fetlock, pastern, hoof
    cone('FL_upper', f.upper, f.lower, 0.14, 0.11, { blend: 0.1, part: 'body' }),
    cone('FL_lower', [0.2, 1.9, 0.57], [0.18, 1.03, 0.78], 0.095, 0.058, { blend: 0.05, part: 'leg', region: 'FL' }),
    ellipsoid('FL_lower', [0.182, 1.0, 0.79], [0.062, 0.078, 0.066], { blend: 0.04, part: 'leg', region: 'FL' }),
    cone('FL_foot', [0.18, 0.96, 0.79], [0.18, 0.31, 0.8], 0.05, 0.043, { blend: 0.035, part: 'leg', region: 'FL' }),
    ellipsoid('FL_toe', [0.18, 0.27, 0.805], [0.052, 0.062, 0.058], { blend: 0.03, part: 'leg', region: 'FL' }),
    cone('FL_toe', [0.18, 0.25, 0.81], [0.18, 0.1, 0.845], 0.044, 0.05, { blend: 0.02, part: 'leg', region: 'FL' }),
    cone('FL_toe', [0.18, 0.105, 0.85], [0.18, 0.025, 0.885], 0.055, 0.072, { blend: 0.015, part: 'hoof', region: 'FL' }),
    roundBox('FL_toe', [0.18, -0.08, 0.87], [0.15, 0.08, 0.15], 0.01, { sub: true, blend: 0.01, part: 'hoof', region: 'FL' }),
    // hind: thigh in the body, gaskin, prominent hock, long cannon
    cone('HL_upper', h.upper, h.lower, 0.15, 0.115, { blend: 0.12, part: 'body' }),
    cone('HL_lower', [0.24, 1.88, -0.6], [0.19, 1.15, -0.98], 0.1, 0.06, { blend: 0.05, part: 'leg', region: 'HL' }),
    ellipsoid('HL_foot', [0.19, 1.12, -1.0], [0.05, 0.075, 0.07], { blend: 0.035, part: 'leg', region: 'HL' }),
    cone('HL_foot', [0.19, 1.1, -0.98], [0.18, 0.31, -0.94], 0.05, 0.043, { blend: 0.035, part: 'leg', region: 'HL' }),
    ellipsoid('HL_toe', [0.18, 0.27, -0.935], [0.052, 0.062, 0.058], { blend: 0.03, part: 'leg', region: 'HL' }),
    cone('HL_toe', [0.18, 0.25, -0.93], [0.18, 0.1, -0.895], 0.044, 0.05, { blend: 0.02, part: 'leg', region: 'HL' }),
    cone('HL_toe', [0.18, 0.105, -0.89], [0.18, 0.025, -0.865], 0.055, 0.07, { blend: 0.015, part: 'hoof', region: 'HL' }),
    roundBox('HL_toe', [0.18, -0.08, -0.88], [0.15, 0.08, 0.15], 0.01, { sub: true, blend: 0.01, part: 'hoof', region: 'HL' }),
  ];
}

function tailPrims(): Prim[] {
  const t = J.tail;
  return [
    cone('tail_1', [0, 2.62, -1.08], t[1], 0.055, 0.03, { blend: 0.05, part: 'tail' }),
    cone('tail_2', t[1], t[2], 0.03, 0.022, { blend: 0.02, part: 'tail', region: 'tail' }),
    cone('tail_3', t[2], t[3], 0.022, 0.018, { blend: 0.02, part: 'tail', region: 'tail' }),
    cone('tail_4', t[3], [0, 1.32, -1.27], 0.018, 0.015, { blend: 0.02, part: 'tail', region: 'tail' }),
    ellipsoid('tail_4', [0, 1.12, -1.27], [0.045, 0.24, 0.04], {
      blend: 0.03,
      part: 'tuft',
      region: 'tail',
      noise: { amp: 0.012, freq: 40, stretch: [1, 0.12, 1], ridged: true, octaves: 2, seed: 62 },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Coat

const CREAM = 0xe2d3b0;
const PATCH = 0x6e3b1d;
const PATCH_BULL = 0x4f2914;
const TAN = 0xc49a62;
const HOOF = 0x2b2420;
const TUFT = 0x15100d;

function giraffeCoat(male: boolean, eye: Vec3) {
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    const ax = Math.abs(x);
    const n = fbm(x * 2.2, y * 2.2, z * 2.2, 3, 71);
    // smooth positional face mask (part membership changes too abruptly at the poll)
    const dHead = (y - POLL[1]) * HD[1] + (z - POLL[2]) * HD[2];
    const headK = smooth(-0.1, 0.1, dHead) * smooth(3.8, 4.3, y);
    const neckK = c.pw('neck');
    const legK = clamp01(c.pw('leg') + c.pw('hoof'));
    // patch size: big on the body, smaller on neck / legs / face
    let cell = 0.34;
    cell += (0.3 - cell) * neckK;
    cell += (0.2 - cell) * clamp01(legK * 1.4) * smooth(2.0, 1.2, y);
    cell += (0.16 - cell) * headK;
    const wx = fbm(x * 3.1, y * 3.1, z * 3.1, 2, 72) * 0.32;
    const wy = fbm(x * 3.1 + 11, y * 3.1, z * 3.1, 2, 73) * 0.32;
    const ic = 1 / cell;
    const R = (px: number, py: number, pz: number) => reticulation(px * ic + wx, py * ic + wy, pz * ic, 0.5, 9);
    const r = R(x, y, z);
    // tangential gradient (cell units per metre) → constant line width in metres
    const e = 0.008;
    let gx = (R(x + e, y, z) - r) / e, gy = (R(x, y + e, z) - r) / e, gz = (R(x, y, z + e) - r) / e;
    const gn = gx * c.nx + gy * c.ny + gz * c.nz;
    gx -= gn * c.nx;
    gy -= gn * c.ny;
    gz -= gn * c.nz;
    const gt = Math.sqrt(gx * gx + gy * gy + gz * gz);
    const S = 2.3;
    c.s = r / S;
    // line half-width ≈ 1.7 cm (a little wider, softer on the legs and belly)
    const hw = (0.017 + 0.008 * legK + 0.01 * smooth(0.0, -0.7, c.ny)) * (1 - 0.35 * headK);
    c.w = Math.min(0.45, (2 * hw * gt) / S);
    // patch colour (base) with gentle variation; bulls darken with age
    c.color.setHex(male ? PATCH_BULL : PATCH);
    blendHex(c.color, 0x8a4c22, clamp01(0.35 + n * 0.6));
    c.color2.setHex(CREAM);
    // pale belly, inner legs
    const under = smooth(-0.2, -0.85, c.ny) * smooth(2.4, 2.0, y);
    blendHex(c.color, TAN, under * 0.6);
    // legs: patches fade out below knees / hocks to plain cream
    const low = smooth(1.35, 0.85, y);
    blendHex(c.color, CREAM, low * 0.92);
    blendHex(c.color2, 0xd8c8a4, low);
    c.w *= 1 - low;
    // face: tan with small patches, pale muzzle, darker brow line
    if (headK > 0.2) {
      const fk = smooth(0.2, 0.6, headK);
      blendHex(c.color, TAN, fk * 0.4);
      blendHex(c.color2, 0xc9ad80, fk * 0.6);
      const mz = clamp01(c.pw('muzzle') * 1.4);
      blendHex(c.color, 0xb89d7a, smooth(0.25, 0.7, mz));
      c.w *= 1 - smooth(0.25, 0.6, mz);
      // dark lip edge / nostril area
      if (mz > 0.4 && c.ny < -0.2) blendHex(c.color, 0x3a2a20, smooth(-0.2, -0.7, c.ny) * 0.6);
    }
    // eye surround and long lashes (dark ring)
    const ex = ax - eye[0], ey = y - eye[1], ez = z - eye[2];
    const ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (ed < 0.05) {
      blendHex(c.color, 0x2a1a10, smooth(0.05, 0.032, ed) * 0.9);
      c.w *= smooth(0.032, 0.05, ed);
    }
    // ears: pale inside, tan outside with dark tip
    if (c.part === 'ear') {
      blendHex(c.color, 0xd9c7a2, 0.6);
      blendHex(c.color, 0x5a3a22, smooth(0.25, 0.29, ax) * 0.7);
      c.w = 0;
    }
    // ossicones: skin colour, knobs bald & dark (bull), black tufts (cow)
    if (c.pw('ossicone') + c.pw('knob') + c.pw('tuft') > 0.35) {
      c.color.setHex(0x6e4a2c);
      c.w = 0;
      const tk = c.pw('tuft');
      if (tk > 0.25) {
        c.color.setHex(TUFT);
        c.fur = 3.5;
      }
      if (c.pw('knob') > 0.3) blendHex(c.color, 0x3a2c22, 0.6);
    }
    // mane: chestnut with dark tips
    if (c.part === 'mane' || c.pw('mane') > 0.4) {
      c.color.setHex(0x6b4024);
      blendHex(c.color, 0x2e1c10, smooth(0.03, 0.07, c.pd('neck')));
      c.w = 0;
      c.fur = 2.5;
    }
    // hooves
    if (c.part === 'hoof') {
      const k = smooth(0.12, 0.08, y);
      blendHex(c.color, HOOF, k);
      c.w *= 1 - k;
    }
    // tail tuft
    if (y < 2.0 && c.pw('tuft') > 0.1) {
      blendHex(c.color, TUFT, smooth(0.1, 0.4, c.pw('tuft')));
      c.w = 0;
      c.fur = 3.5;
    }
  };
}

// ---------------------------------------------------------------------------
// Animation

interface GirExtra {
  ps: Posture;
  st2: Pose;
}
type GS = QuadState & GirExtra;

/** How neck pitch / yaw is spread over the four vertebrae (base-heavy pitch). */
const NECK_WP = [0.4, 0.25, 0.2, 0.15];
const NECK_WY = [0.2, 0.25, 0.28, 0.27];

const SLEEP_CURL: [number, number][] = [
  [-0.82, 0],
  [-0.13, 1.1],
  [1.07, 1.1],
  [0.32, 0.9],
];

const _A = new THREE.Vector3();
const _C = new THREE.Vector3();
const _D = new THREE.Vector3();
const _U = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Plant a leg with its lower column (cannon + pastern) along direction `dir`
 * (unit, pointing up from the hoof) — splayed forelegs when drinking.
 */
function plantAlong(ctx: AnimCtx, st: QuadState, pose: Pose, leg: LegRT, C: THREE.Vector3, dir: THREE.Vector3): void {
  const len = leg.footVec.length() + leg.toeVec.length();
  _A.copy(C).addScaledVector(dir, len);
  placeLeg(ctx, st, pose, leg, _A, 0, 0);
  _U.copy(leg.footVec).add(leg.toeVec).normalize();
  _q.setFromUnitVectors(_U, dir);
  ctx.rig.setWorldRot(pose, leg.r.foot, _q);
  if (leg.r.toe >= 0) ctx.rig.setWorldRot(pose, leg.r.toe, _q);
}

function makeDriver(height: number, walkSpeed: number, runSpeed: number) {
  const p = quadParams(height, walkSpeed, runSpeed, {
    // pace: same-side legs move (almost) together, hind slightly first
    walk: {
      stride: 2.5, refSpeed: walkSpeed, duty: 0.66, offsets: [0.06, 0.56, 0, 0.5], stepHeight: 0.2,
      bob: 0.03, bobFreq: 2, pitch: 0.01, roll: 0.035, headBob: 0.07, spineFlex: 0,
    },
    trot: {
      stride: 3.4, refSpeed: walkSpeed * 2, duty: 0.5, offsets: [0.06, 0.56, 0, 0.5], stepHeight: 0.26,
      bob: 0.04, bobFreq: 2, pitch: 0.015, roll: 0.03, headBob: 0.09, spineFlex: 0,
    },
    // rocking rotary gallop with big neck swings
    gallop: {
      stride: 5.2, refSpeed: runSpeed, duty: 0.32, offsets: [0.55, 0.45, 0, 0.12], stepHeight: 0.35,
      bob: 0.09, bobFreq: 1, pitch: 0.09, roll: 0.01, headBob: 0.2, spineFlex: 0.03,
    },
    footFollow: 0.7,
    frontFlex: 1.15,
    hindFlex: -0.7,
    frontToeCurl: 0.8,
    hindToeCurl: 0.8,
    push: 0.45,
    scapSwing: 0.22,
    lie: { hipsY: 0.92, chestY: 1.28, front: 'tuck', hindSplay: 0.1, headRest: 1.0 },
    grazeReach: 0.4,
    headCarry: -0.12,
    look: 0.42,
    tailSwish: 0.45,
    tailCarry: -0.35,
    earFlick: 0.55,
    callJaw: 0.12,
    callHead: -0.35,
    callDuration: 2.2,
    breath: 0.008,
    swimSink: 2.4,
  });
  const base = quadrupedDriver(p);

  /** Neck pitch (+ down) spread along the four vertebrae, base-heavy like the real neck. */
  const neck = (ctx: AnimCtx, pose: Pose, pitch: number, yaw: number, headPitch: number, headYaw = 0, roll = 0): void => {
    const R = ctx.roles;
    for (let i = 0; i < R.neck.length; i++) {
      rotLocal(pose, R.neck[i], 'y', yaw * NECK_WY[i]);
      rotLocal(pose, R.neck[i], 'x', pitch * NECK_WP[i]);
    }
    rotLocal(pose, R.head, 'y', headYaw);
    rotLocal(pose, R.head, 'x', headPitch);
    rotLocal(pose, R.head, 'z', roll);
  };

  const idle = (ctx: AnimCtx, st: GS, pose: Pose): void => {
    body(ctx, st, pose);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const t = ctx.time;
    // slow, wide neck looks; ruminating (lateral chewing)
    const yaw = 0.5 * glance(t, 5.5, ctx.seed + 1);
    const pitch = 0.15 * glance(t, 6.3, ctx.seed + 2);
    neck(ctx, pose, pitch, yaw, -pitch * 0.4 + 0.05 * glance(t, 3.1, ctx.seed + 3), yaw * 0.3);
    const chew = pulses(t, 8, ctx.seed + 4, 5, 0.6);
    jaw(ctx, pose, 0.035 * chew * Math.max(0, Math.sin(t * TAU * 1.3)));
    rotLocal(pose, ctx.roles.jaw, 'y', 0.03 * chew * Math.sin(t * TAU * 1.3));
    tail(ctx, st, pose, 0, 1);
    ears(ctx, st, pose);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  const walk = (ctx: AnimCtx, st: GS, pose: Pose): void => {
    body(ctx, st, pose);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    lookAround(ctx, st, pose, 0.5);
    // the neck pumps forward / back with the stride; big swings at the gallop
    const sw = Math.sin(st.phase * TAU * (st.wg > 0.5 ? 1 : 2) - 1.0) * st.amp;
    neck(ctx, pose, 0.1 * sw * (1 + st.wg * 2) + 0.25 * st.wg, 0, -0.08 * sw - 0.1 * st.wg);
    tail(ctx, st, pose, 0, 0.6);
    ears(ctx, st, pose, st.wg * 0.4);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  // browse HIGH: neck stretched up, head tilted back, stripping leaves
  const eat = (ctx: AnimCtx, st: GS, pose: Pose): void => {
    body(ctx, st, pose, 0);
    const R = ctx.roles;
    pose.p[R.root].y += 0.02;
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const t = ctx.time + ctx.rand * 10;
    const pause = pulses(t, 9, ctx.seed + 9, 2.6, 0.5); // lower the head to chew now and then
    const strip = Math.sin(t * TAU * 0.55);
    const side = 0.35 * Math.sin(t * 0.31 + ctx.seed);
    neck(ctx, pose, (-0.52 + 0.04 * strip) * (1 - pause) + 0.1 * pause, side * (1 - pause * 0.5), (-0.55 + 0.12 * strip) * (1 - pause), side * 0.4);
    const chew = Math.max(0, Math.sin(t * TAU * 1.4));
    jaw(ctx, pose, 0.06 * chew + 0.05 * (1 - pause) * Math.max(0, strip));
    tail(ctx, st, pose, 0, 0.9);
    ears(ctx, st, pose, 0.15);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  // drink: forelegs splayed wide, chest lowered, straight neck down to the water
  const drink = (ctx: AnimCtx, st: GS, pose: Pose): void => {
    const R = ctx.roles;
    const rig = ctx.rig;
    const t = ctx.time + ctx.rand * 6;
    // splay in over ~1.5 s, sometimes snap the head up to check for danger
    const sp = smooth(0.0, 1.6, ctx.actionTime);
    const up = pulses(t, 10, ctx.seed + 21, 2.2, 0.45);
    const lower = sp * (0.62 - 0.12 * up);
    pose.p[R.root].y -= lower * 0.22;
    rotParent(pose, R.root, 'x', lower * 0.32);
    body(ctx, st, pose, 0);
    rig.fk(pose);
    for (const leg of st.legs) {
      if (leg.front) {
        _C.copy(leg.r.contact);
        _C.x += leg.side * 0.78 * sp;
        _C.z += 0.12 * sp;
        rig.fkBone(pose, leg.r.upper);
        _D.copy(rig.wp[leg.r.upper]).sub(_C).normalize();
        _D.x *= 0.85;
        _D.normalize();
        plantAlong(ctx, st, pose, leg, _C, _D);
      } else {
        _C.copy(leg.r.contact);
        _C.x += leg.side * 0.12 * sp;
        _C.z -= 0.1 * sp;
        rig.fkBone(pose, leg.r.upper);
        const H = rig.wp[leg.r.upper];
        const slant = Math.atan2(H.z - _C.z, Math.max(0.05, H.y - _C.y));
        plantLeg(ctx, st, pose, leg, _C, slant * 0.7, slant * 0.2);
      }
    }
    rig.fk(pose);
    const lap = Math.sin(t * TAU * 1.0);
    const target = 0.03 + up * 2.6;
    reachMuzzle(ctx, pose, target, 0.2 - up * 0.3, 0, 2.6);
    jaw(ctx, pose, 0.03 + 0.03 * Math.max(0, lap) * (1 - up));
    tail(ctx, st, pose, 0, 0.5);
    ears(ctx, st, pose, 0.2 - up * 0.2);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  const call = (ctx: AnimCtx, st: GS, pose: Pose): void => {
    body(ctx, st, pose, 0);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const at = ctx.actionTime;
    const env = envelope(at, 0, 0.4, p.callDuration - 0.6, p.callDuration);
    const snort = Math.max(0, Math.sin(at * TAU * 1.5)) * envelope(at, 0.3, 0.5, p.callDuration - 0.8, p.callDuration - 0.4);
    neck(ctx, pose, -0.35 * env, 0, -0.3 * env - 0.12 * snort, 0);
    jaw(ctx, pose, 0.1 * snort);
    // stamp a forefoot
    const leg = st.legs[ctx.rand > 0.5 ? 0 : 1];
    if (leg) {
      const stamp = Math.max(0, Math.sin(at * TAU * 0.9)) * env;
      _C.copy(leg.r.contact);
      _C.y += 0.18 * stamp;
      _C.z += 0.06 * stamp;
      plantLeg(ctx, st, pose, leg, _C, 0.5 * stamp, 0.6 * stamp);
    }
    tail(ctx, st, pose, -0.4 * env, 1.5);
    ears(ctx, st, pose, 0.7 * env);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  // play: "necking" — big lateral swings of the neck, the head as a hammer
  const play = (ctx: AnimCtx, st: GS, pose: Pose): void => {
    body(ctx, st, pose, 0);
    const R = ctx.roles;
    const t = ctx.time;
    const sw = Math.sin(t * TAU * 0.45);
    rotParent(pose, R.root, 'z', 0.03 * sw);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    neck(ctx, pose, 0.25 + 0.15 * Math.abs(sw), 1.1 * sw, 0.2, 0.5 * sw, 0.25 * sw);
    tail(ctx, st, pose, -0.2, 1.4);
    ears(ctx, st, pose, 0.5);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  const social = (ctx: AnimCtx, st: GS, pose: Pose): void => {
    body(ctx, st, pose, 0);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const t = ctx.time;
    const side = ctx.rand > 0.5 ? 1 : -1;
    const nz = Math.sin(t * TAU * 0.3);
    neck(ctx, pose, 0.35 + 0.08 * nz, side * 0.6, 0.15, side * 0.3 + 0.1 * nz, side * 0.15);
    jaw(ctx, pose, 0.03 * Math.max(0, Math.sin(t * TAU * 1.2)));
    tail(ctx, st, pose, 0, 0.8);
    ears(ctx, st, pose);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  /** Lying continuum: 0 standing → 0.45 kneeling on the carpi → 1 sternal with legs folded. */
  function lying(ctx: AnimCtx, st: GS, pose: Pose, down: number, rising: boolean): void {
    void rising;
    const R = ctx.roles;
    const rig = ctx.rig;
    const k1 = smooth(0.0, 0.45, down);
    const k2 = smooth(0.42, 1.0, down);
    pose.reset();
    // kneel: chest drops onto the knees, hind legs still up; neck swings up for balance
    const chestDrop = 0.95 * k1;
    pose.p[R.root].y -= 0.1 * k1;
    rotParent(pose, R.root, 'x', Math.atan2(chestDrop - 0.1 * k1, st.chestZ - st.hipsZ));
    body(ctx, st, pose, 0);
    rig.fk(pose);
    for (const leg of st.legs) {
      if (leg.front) {
        rig.fkBone(pose, leg.r.upper);
        const H = rig.wp[leg.r.upper];
        // standing → knee on the ground, cannon folded back under the forearm
        _C.copy(leg.r.contact);
        const sx = H.x, sz = H.z + 0.05;
        _A.set(_C.x + (sx - _C.x) * k1, 1.0 + (0.1 - 1.0) * k1, _C.z + (sz + 0.02 - _C.z) * k1);
        placeLeg(ctx, st, pose, leg, _A, Math.PI * 0.5 * k1, Math.PI * 0.7 * k1);
      } else {
        rig.fkBone(pose, leg.r.upper);
        const H = rig.wp[leg.r.upper];
        _C.copy(leg.r.contact);
        _C.z += (H.z - _C.z) * 0.3 * k1;
        const slant = Math.atan2(H.z - _C.z, Math.max(0.05, H.y - _C.y));
        plantLeg(ctx, st, pose, leg, _C, slant * 0.7, 0);
      }
    }
    neck(ctx, pose, -0.55 * k1 * (1 - k2), 0, 0.25 * k1 * (1 - k2));
    tail(ctx, st, pose, 0.2, 0.4);
    if (k2 > 0) {
      const L = st.st2;
      L.reset();
      lie(ctx, st, L, 'up');
      // undo lie()'s generic head; giraffes keep the neck upright when lying
      L.q[R.head].identity();
      for (let i = 0; i < R.neck.length; i++) L.q[R.neck[i]].identity();
      neck(ctx, L, -0.5, 0.25 * glance(ctx.time, 7, ctx.seed + 31), 0.12);
      blendInto(pose, L, k2);
    }
  }

  // sleep: neck curled back, head resting on the rump / hind leg
  const sleep = (ctx: AnimCtx, st: GS, pose: Pose): void => {
    lying(ctx, st, pose, st.ps.down, false);
    const R = ctx.roles;
    const k = smooth(0.85, 1.0, st.ps.down);
    if (k <= 0) return;
    const L = st.st2;
    L.copy(pose);
    for (let i = 0; i < R.neck.length; i++) L.q[R.neck[i]].identity();
    L.q[R.head].identity();
    // [pitch, yaw] per vertebra: neck raised, then arched sideways and back so
    // the muzzle rests on the flank / rump (solved offline with planar FK)
    const side = ctx.rand > 0.5 ? 1 : -1;
    for (let i = 0; i < R.neck.length; i++) {
      rotLocal(L, R.neck[i], 'y', SLEEP_CURL[i][1] * side);
      rotLocal(L, R.neck[i], 'x', SLEEP_CURL[i][0]);
    }
    rotLocal(L, R.head, 'y', 0.38 * side);
    rotLocal(L, R.head, 'x', -1.0);
    rotLocal(L, R.head, 'z', 0.5 * side);
    const br = Math.sin(ctx.time * TAU * 0.18);
    rotLocal(L, R.chest, 'x', 0.01 * br);
    blendInto(pose, L, k);
  };

  // rest: lying, neck up, ruminating
  const rest = (ctx: AnimCtx, st: GS, pose: Pose): void => {
    lying(ctx, st, pose, st.ps.down, false);
    const t = ctx.time;
    const chew = Math.max(0, Math.sin(t * TAU * 1.2)) * smooth(0.9, 1.0, st.ps.down);
    jaw(ctx, pose, 0.03 * chew);
    lookAroundStill(ctx, pose, 0.3 * st.ps.down);
    ears(ctx, st, pose);
  };

  return {
    ...base,
    init: (ctx: AnimCtx): GS => {
      const st = initQuad(ctx, p) as GS;
      st.ps = new Posture(ctx.def.count);
      st.st2 = new Pose(ctx.def.count);
      return st;
    },
    pre: (ctx: AnimCtx, st: GS): void => {
      advanceGait(ctx, st);
      const a = ctx.action;
      updatePosture(ctx, st.ps, a === 'sleep' || a === 'rest' || a === 'sit', 3.2, 2.8);
    },
    actions: { ...base.actions, idle, walk, eat, drink, call, play, social, sleep, rest, sit: rest },
    fade: 0.5,
    fades: { sleep: 0.3, rest: 0.3, sit: 0.3, drink: 0.6, eat: 0.8 },
  };
}

// ---------------------------------------------------------------------------

function design(ctx: DesignContext): CreatureDesign {
  const male = ctx.sex === 'M';
  const sk = quadSkeleton(J);
  const head = withRegion(headPrims(male), 'head');
  const prims: Prim[] = [
    ...bodyPrims(male),
    ...neckPrims(male),
    ...manePrims(),
    ...head,
    ...earPrims(),
    ...legPrimsLeft(),
    ...mirrorX(legPrimsLeft()),
    ...tailPrims(),
  ];
  const eyeDir: Vec3 = [-1, -0.05, -0.25];
  const hit = surfacePoint(head, [0.4, hp(0.17, 0.035)[1], hp(0.17, 0.035)[2] + 0.06], eyeDir, 0.5);
  const eye = seat(hit, eyeDir, 0.012);
  return {
    bones: sk.bones,
    roles: sk.roles,
    prims,
    resolution: 1.15,
    regions: {
      head: { scale: 0.3 },
      ears: { scale: 0.17, aniso: [1.4, 1, 1] },
      neck: { scale: 0.58 },
      mane: { scale: 0.28, aniso: [1, 2, 2] },
      FL: { scale: 0.38, aniso: [1, 2.6, 1] },
      FR: { scale: 0.38, aniso: [1, 2.6, 1] },
      HL: { scale: 0.38, aniso: [1, 2.6, 1] },
      HR: { scale: 0.38, aniso: [1, 2.6, 1] },
      tail: { scale: 0.26, aniso: [1, 2.5, 1] },
    },
    coat: giraffeCoat(male, eye),
    look: { skin: 'fur', pattern: 'stripes', roughness: 0.86, sheen: 0.3, grain: 0.006, bump: 0.28, mottle: 0.08 },
    eyes: [{ bone: 'head', pos: eye, radius: 0.027, color: 0x1c1009 }],
    anim: driver(makeDriver(3.25, ctx.def.walkSpeed, ctx.def.runSpeed)),
    babyScale: 0.36,
    babyHead: 1.25,
    height: male ? 5.2 : 5.1,
    radius: 0.9,
  };
}


const giraffe: SpeciesModel = {
  id: 'giraffe',
  dimorphic: true,
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.0 : 0.87) * (0.97 + r * 0.06),
};
export default giraffe;
