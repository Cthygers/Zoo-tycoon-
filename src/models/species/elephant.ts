// African bush elephant (Loxodonta africana). Sculpted SDF body with a
// saddle back, domed head, a six-bone muscular trunk, fan ears on two bones
// each, ivory tusks (smooth, glossy, own colour ramp — micro detail off),
// pillar legs with round nailed feet and a thin tufted tail. Bulls and cows
// get separate meshes (tusk size, head bulk, temporal gland streak).
//
// Animation: lateral-sequence walk → amble (elephants never gallop), the
// trunk driven by solved per-bone curl profiles (reach the ground, bring
// food / water to the mouth, raise to trumpet, snorkel when swimming, throw
// dust over the back), ear flapping bouts, a standing doze with a cocked hind
// foot and lying down on the side to sleep (lie-down / get-up sequence).

import * as THREE from 'three';
import { cone, ellipsoid, mirrorX, roundBox, sphere, symmetric, tube, type Prim, type Vec3 } from '../sdf/prims';
import { quadSkeleton, seat, surfacePoint, withRegion, type QuadJoints } from '../kit/quadruped';
import {
  actIdle,
  actSwim,
  advanceGait,
  body,
  initQuad,
  lie,
  lookAround,
  neckHead,
  plantLeg,
  quadParams,
  quadrupedDriver,
  tail,
  legs as legsBlock,
  type QuadState,
} from '../anim/quadruped';
import { driver, glance, pulses, TAU, wander } from '../anim/util';
import { Pose, rotLocal, rotParent } from '../rig/rig';
import { blendHex, clamp01, fbm, smooth } from '../coat/coat';
import type { AnimCtx, CoatSample, CreatureDesign, DesignContext, SpeciesModel } from '../types';
import { Posture, applyAngles, bilateralBones, blendInto, envelope, polyArc, riseOverlay, updatePosture } from './species-large-herbivores/common';

// ---------------------------------------------------------------------------
// Proportions (bull, shoulder 3.2 m). Cows reuse them with a smaller instance
// scale and lighter features.

const HEAD_J: Vec3 = [0, 2.62, 1.95];
const NECK_J: Vec3 = [0, 2.62, 1.55];

const J: QuadJoints = {
  hips: [0, 2.55, -1.05],
  spine: [
    [0, 2.62, -0.45],
    [0, 2.68, 0.25],
  ],
  chest: [0, 2.62, 0.95],
  neck: [NECK_J],
  head: HEAD_J,
  jaw: [0, 2.12, 2.1],
  tail: [
    [0, 2.64, -1.8],
    [0, 2.25, -1.97],
    [0, 1.85, -2.02],
    [0, 1.45, -2.03],
  ],
  front: {
    scap: [0.4, 2.95, 0.95],
    upper: [0.5, 2.28, 1.33],
    lower: [0.52, 1.46, 0.98],
    foot: [0.5, 0.5, 1.1],
    toe: [0.5, 0.2, 1.13],
    contact: [0.5, 0, 1.16],
  },
  hind: {
    upper: [0.48, 2.42, -1.15],
    lower: [0.54, 1.38, -0.85],
    foot: [0.5, 0.52, -1.2],
    toe: [0.5, 0.2, -1.18],
    contact: [0.5, 0, -1.15],
  },
  muzzle: [0, 1.95, 2.5],
};

/** Trunk polyline: bone joints trunk_1..6 at T[0..5], tip at T[6]. */
const T: Vec3[] = [
  [0, 2.3, 2.64],
  [0, 1.95, 2.8],
  [0, 1.57, 2.88],
  [0, 1.2, 2.9],
  [0, 0.85, 2.88],
  [0, 0.52, 2.89],
  [0, 0.25, 2.97],
];
const TR = [0.25, 0.2, 0.162, 0.132, 0.108, 0.09, 0.074];

// Ears are sculpted SPREAD (flat in the XY plane, as when trumpeting): a
// grid-aligned plate meshes cheaply on a thin anisotropic grid. Every pose
// folds them back along the neck / shoulder about their hinge (post layer).
const EAR_A: Vec3 = [0.42, 2.6, 1.95];
const EAR_Z = EAR_A[2] - 0.03;
const earP = (u: number, v: number): Vec3 => [EAR_A[0] + u, EAR_A[1] + v, EAR_Z];
const EAR2: Vec3 = earP(0.6, 0);
/** Rotation (rad, about the hinge) that lays the ears back from the spread rest pose. */
const EAR_FOLD = 1.12;

// ---------------------------------------------------------------------------
// Sculpt

function bodyPrims(male: boolean): Prim[] {
  const g = male ? 1 : 0.96;
  return [
    // shoulders / chest
    ellipsoid('chest', [0, 2.32, 0.95], [0.7 * g, 0.85, 0.72], { blend: 0.2, part: 'body' }),
    ellipsoid('chest', [0, 2.9, 0.9], [0.4 * g, 0.3, 0.55], { blend: 0.25, part: 'body' }),
    ellipsoid('chest', [0, 1.92, 1.3], [0.46 * g, 0.42, 0.36], { blend: 0.18, part: 'body' }),
    // barrel
    ellipsoid('spine_2', [0, 2.22, 0.2], [0.82 * g, 0.88, 0.92], { blend: 0.22, part: 'body' }),
    ellipsoid('spine_1', [0, 2.0, -0.35], [0.8 * g, 0.66, 0.8], { blend: 0.25, part: 'belly' }),
    ellipsoid('spine_1', [0, 2.72, -0.38], [0.55 * g, 0.32, 0.7], { blend: 0.25, part: 'body' }),
    // hindquarters + sloping rump
    ellipsoid('hips', [0, 2.36, -1.1], [0.68 * g, 0.72, 0.74], { blend: 0.22, part: 'body' }),
    ellipsoid('hips', [0, 2.84, -1.0], [0.42 * g, 0.2, 0.55], { blend: 0.2, part: 'body' }),
    // shoulder blades / triceps, haunches & buttocks
    ...symmetric([
      ellipsoid('FL_scap', [0.5, 2.48, 1.0], [0.28, 0.62, 0.42], { rot: [-0.25, 0, 0], blend: 0.18, part: 'body' }),
      ellipsoid('HL_upper', [0.5, 2.05, -1.05], [0.3, 0.6, 0.45], { blend: 0.2, part: 'body' }),
      ellipsoid('HL_upper', [0.3, 2.3, -1.45], [0.38, 0.62, 0.35], { blend: 0.2, part: 'body' }),
    ]),
    // short thick neck + throat
    ellipsoid('neck_1', [0, 2.55, 1.6], [0.56 * g, 0.62, 0.42], { blend: 0.2, part: 'neck' }),
    ellipsoid('neck_1', [0, 2.05, 1.76], [0.38 * g, 0.32, 0.3], { blend: 0.16, part: 'neck' }),
  ];
}

function headPrims(male: boolean): Prim[] {
  const b = male ? 1 : 0.94;
  return [
    // domed cranium and broad, slightly sloping forehead
    ellipsoid('head', [0, 2.7, 2.12], [0.49 * b, 0.43, 0.48], { rot: [0.25, 0, 0], blend: 0.14, part: 'head' }),
    ellipsoid('head', [0, 2.53, 2.44], [0.42 * b, 0.5, 0.23], { rot: [0.42, 0, 0], blend: 0.12, part: 'head' }),
    // twin forehead bulges above the trunk base
    ...symmetric([ellipsoid('head', [0.17, 2.66, 2.5], [0.2 * b, 0.24, 0.16], { rot: [0.4, 0, 0], blend: 0.1, part: 'head' })]),
    // cheeks, tusk sheaths
    ...symmetric([
      ellipsoid('head', [0.27, 2.3, 2.22], [0.26 * b, 0.33, 0.34], { blend: 0.12, part: 'head' }),
      ellipsoid('head', [0.19, 2.04, 2.55], [0.13 * b, 0.2, 0.15], { rot: [0.5, 0, 0], blend: 0.1, part: 'head' }),
      // brow ridge over the small eye, temporal swelling behind it
      ellipsoid('head', [0.35, 2.58, 2.33], [0.1, 0.07, 0.12], { blend: 0.08, part: 'head' }),
      ellipsoid('head', [0.38, 2.5, 2.1], [0.1, 0.15, 0.13], { blend: 0.1, part: 'head' }),
    ]),
    // lower jaw + pointed lower lip
    ellipsoid('jaw', [0, 1.99, 2.22], [0.27 * b, 0.2, 0.33], { blend: 0.1, part: 'head' }),
    cone('jaw', [0, 1.97, 2.38], [0, 1.87, 2.55], 0.11, 0.05, { blend: 0.06, part: 'lip' }),
    // mouth corners
    ...symmetric([ellipsoid('head', [0.15, 2.02, 2.36], [0.09, 0.018, 0.12], { sub: true, blend: 0.02, part: 'lip' })]),
  ];
}

function trunkPrims(): Prim[] {
  const P: Prim[] = [];
  const bones = ['trunk_1', 'trunk_2', 'trunk_3', 'trunk_4', 'trunk_5', 'trunk_6'];
  // base flares into the face
  P.push(cone('trunk_1', [0, 2.42, 2.55], T[1], 0.25, TR[1], { blend: 0.12, part: 'trunk', region: 'trunk' }));
  P.push(...tube(bones, T.slice(1), TR.slice(1), { blend: 0.04, part: 'trunk', region: 'trunk' }));
  // tip: two "fingers" and the nostrils
  P.push(sphere('trunk_6', [0, 0.2, 3.03], 0.03, { blend: 0.02, part: 'trunkTip', region: 'trunk' }));
  P.push(sphere('trunk_6', [0, 0.19, 2.92], 0.028, { blend: 0.02, part: 'trunkTip', region: 'trunk' }));
  P.push(...symmetric([ellipsoid('trunk_6', [0.026, 0.17, 2.975], [0.018, 0.03, 0.022], { sub: true, blend: 0.01, part: 'trunkTip', region: 'trunk' })]));
  return P;
}

function tuskPts(male: boolean): { pts: Vec3[]; r: number[] } {
  return male
    ? {
        pts: [[0.19, 2.02, 2.58], [0.215, 1.83, 2.77], [0.245, 1.67, 2.99], [0.265, 1.59, 3.24], [0.27, 1.6, 3.47], [0.26, 1.67, 3.64]],
        r: [0.078, 0.074, 0.066, 0.054, 0.038, 0.012],
      }
    : {
        pts: [[0.17, 2.02, 2.58], [0.18, 1.86, 2.74], [0.195, 1.75, 2.91], [0.205, 1.71, 3.07], [0.205, 1.74, 3.2]],
        r: [0.048, 0.045, 0.037, 0.026, 0.008],
      };
}

function tuskPrims(male: boolean): Prim[] {
  const t = tuskPts(male);
  return symmetric(tube('head', t.pts, t.r, { blend: 0.012, part: 'tusk', region: 'tusks' }));
}

function earPrims(male: boolean): Prim[] {
  const s = male ? 1 : 0.92;
  const E = (bone: string, u: number, v: number, ru: number, rv: number, th: number, blend = 0.09): Prim =>
    ellipsoid(bone, earP(u * s, v * s), [ru * s, rv * s, th], { blend, part: 'ear', region: 'ears', skin: 0.6 });
  const left: Prim[] = [
    // thick root along the hinge
    cone('ear.L', earP(0.02, 0.22 * s), earP(0.04, -0.4 * s), 0.06, 0.045, { blend: 0.06, part: 'ear', region: 'ears', skin: 0.5 }),
    E('ear.L', 0.55, 0.06, 0.5, 0.44, 0.042),
    E('ear.L', 0.42, -0.4, 0.43, 0.47, 0.04),
    E('ear.L', 0.34, -0.8, 0.3, 0.34, 0.034, 0.14),
    E('ear2.L', 0.93, 0.0, 0.37, 0.45, 0.038),
    E('ear2.L', 0.8, -0.46, 0.31, 0.36, 0.034),
    // top edge rolled back
    cone('ear.L', earP(0.14 * s, 0.32 * s), earP(0.6 * s, 0.5 * s), 0.026, 0.034, { blend: 0.05, part: 'ear', region: 'ears', skin: 0.6 }),
    cone('ear2.L', earP(0.6 * s, 0.5 * s), earP(1.14 * s, 0.24 * s), 0.034, 0.026, { blend: 0.05, part: 'ear', region: 'ears', skin: 0.6 }),
  ];
  return symmetric(left);
}

function legPrimsLeft(): Prim[] {
  const f = J.front, h = J.hind;
  const nails = (bone: string, cx: number, cz: number, rad: number, angles: number[], region: string): Prim[] =>
    angles.map((a) =>
      ellipsoid(bone, [cx + Math.sin(a) * rad, 0.07, cz + Math.cos(a) * rad], [0.06, 0.05, 0.03], { rot: [0.25, a, 0], blend: 0.02, part: 'nail', region }),
    );
  return [
    // front: upper arm in the body, columnar forearm, flared round foot
    cone('FL_upper', f.upper, f.lower, 0.29, 0.26, { blend: 0.22, part: 'body' }),
    cone('FL_lower', [0.52, 1.5, 1.0], [0.5, 0.5, 1.1], 0.27, 0.215, { blend: 0.1, part: 'leg', region: 'FL' }),
    cone('FL_foot', [0.5, 0.55, 1.1], [0.5, 0.17, 1.15], 0.215, 0.25, { blend: 0.08, part: 'leg', region: 'FL' }),
    ellipsoid('FL_toe', [0.5, 0.11, 1.17], [0.255, 0.13, 0.268], { blend: 0.06, part: 'foot', region: 'FL' }),
    ...nails('FL_toe', 0.5, 1.17, 0.245, [-0.92, -0.32, 0.32, 0.92], 'FL'),
    roundBox('FL_toe', [0.5, -0.1, 1.16], [0.45, 0.1, 0.45], 0.02, { sub: true, blend: 0.025, part: 'foot', region: 'FL' }),
    // hind: thigh in the body, knee low and forward, oval foot
    cone('HL_upper', h.upper, h.lower, 0.36, 0.27, { blend: 0.16, part: 'body' }),
    ellipsoid('HL_lower', [0.55, 1.36, -0.8], [0.2, 0.2, 0.16], { blend: 0.12, part: 'body' }),
    cone('HL_lower', [0.54, 1.38, -0.87], [0.5, 0.52, -1.2], 0.27, 0.2, { blend: 0.1, part: 'leg', region: 'HL' }),
    cone('HL_foot', [0.5, 0.56, -1.2], [0.5, 0.17, -1.17], 0.2, 0.23, { blend: 0.08, part: 'leg', region: 'HL' }),
    ellipsoid('HL_toe', [0.5, 0.11, -1.13], [0.228, 0.13, 0.285], { blend: 0.06, part: 'foot', region: 'HL' }),
    ...nails('HL_toe', 0.5, -1.13, 0.255, [-0.6, 0, 0.6], 'HL'),
    roundBox('HL_toe', [0.5, -0.1, -1.15], [0.45, 0.1, 0.45], 0.02, { sub: true, blend: 0.025, part: 'foot', region: 'HL' }),
  ];
}

function tailPrims(): Prim[] {
  const t = J.tail;
  return [
    cone('tail_1', [0, 2.66, -1.76], t[1], 0.085, 0.052, { blend: 0.08, part: 'tail' }),
    cone('tail_2', t[1], t[2], 0.052, 0.04, { blend: 0.03, part: 'tail', region: 'tail' }),
    cone('tail_3', t[2], t[3], 0.04, 0.032, { blend: 0.03, part: 'tail', region: 'tail' }),
    cone('tail_4', t[3], [0, 1.12, -2.02], 0.032, 0.026, { blend: 0.03, part: 'tail', region: 'tail' }),
    ellipsoid('tail_4', [0, 1.0, -2.02], [0.065, 0.17, 0.026], {
      blend: 0.03,
      part: 'tuft',
      region: 'tail',
      noise: { amp: 0.014, freq: 30, stretch: [1, 0.12, 1], ridged: true, octaves: 2, seed: 41 },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Coat: grey hide with a sun-bleached, dusty back, rust-coloured mud on the
// legs and belly, ring wrinkles on the trunk and leg creases (per-pixel
// stripes in a darker crease colour), pinker vein-lined ear fronts, ivory
// tusks stained near the lip, pale nails, black tail bristles.

const SKIN = 0x5f5852;
const DUSTY = 0x7b7065;
const SHADOW = 0x4c4743;
const MUD = 0x6e5440;
const EAR_FRONT = 0x87726b;
const IVORY = 0xa8946f;
const IVORY_BASE = 0x6e5a40;
const NAIL = 0xb3a893;
const TUFT = 0x191614;
const EYE_RING = 0x34302c;

function elephantCoat(male: boolean, eye: Vec3, tusk: Vec3[]) {
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    const ax = Math.abs(x);
    const n = fbm(x * 1.3, y * 1.3, z * 1.3, 3, 31);
    const n2 = fbm(x * 5, y * 5, z * 5, 2, 32);
    c.color.setHex(SKIN);
    // sun-bleached dust on the back and head, darker underside
    blendHex(c.color, DUSTY, clamp01(smooth(0.25, 0.95, c.ny) * 0.65 + n * 0.35));
    blendHex(c.color, SHADOW, clamp01(smooth(-0.15, -0.85, c.ny) * 0.55));
    // mud stockings and belly splash with an irregular upper edge
    const mudTop = 1.05 + n * 0.35 + n2 * 0.12;
    blendHex(c.color, MUD, smooth(mudTop, mudTop - 0.7, y) * 0.48);
    blendHex(c.color, MUD, smooth(-0.3, -0.9, c.ny) * smooth(2.0, 1.4, y) * 0.35);
    c.color2.copy(c.color).multiplyScalar(0.62);
    c.w = 0;

    const legK = clamp01((c.pw('leg') + c.pw('foot')) * 1.3);
    if (legK > 0.05 && y < 1.9) {
      // horizontal creases, denser around the wrist / ankle
      const wrist = Math.exp(-Math.pow((y - 0.55) / 0.18, 2));
      c.s = y / (0.06 - wrist * 0.02) + n * 0.7 + n2 * 0.25;
      c.w = (0.1 + wrist * 0.1) * smooth(0.3, 0.7, legK) * smooth(1.35, 1.0, y);
    }
    // trunk rings (arc length along the trunk axis)
    const tk = c.pw('trunk') + c.pw('trunkTip');
    if (tk > 0.05) {
      const pa = polyArc(x, y, z, T);
      c.s = pa.s / (0.05 - pa.s * 0.008) + n * 0.6;
      c.w = Math.max(c.w, 0.28 * smooth(0.05, 0.4, tk) * smooth(0.0, 0.25, pa.s));
      // underside a touch paler, tip pinkish
      blendHex(c.color, 0x7c716a, smooth(0.0, -0.8, c.nz) * 0.3);
      blendHex(c.color, 0x8a6e66, smooth(1.75, 2.05, pa.s) * 0.45);
    }
    // throat folds
    if (c.part === 'neck' && y < 2.3) {
      c.s = (z - 1.5) / 0.07 + n * 1.2;
      c.w = Math.max(c.w, 0.14 * smooth(2.3, 1.9, y));
    }
    // ears: lateral side grey and creased, medial (front) side pinker with veins
    const ek = c.pw('ear');
    if (ek > 0.2) {
      // rest pose = spread: the outer (lateral) face looks along +Z, the
      // inner face (against the neck when folded) along −Z
      const front = smooth(0.1, -0.4, c.nz) * smooth(0.2, 0.6, ek);
      blendHex(c.color, EAR_FRONT, front * 0.75);
      const vein = fbm(ax * 3.2, y * 3.2, z * 3.2, 2, 33);
      c.s = vein * 5.0;
      c.w = Math.max(c.w * (1 - front), front * 0.07);
      c.color2.copy(c.color).multiplyScalar(front > 0.5 ? 0.72 : 0.55);
      // ragged darker rim
      blendHex(c.color, SHADOW, smooth(0.025, 0.0, c.pd('ear') + 0.03) * 0.0);
    }
    // eye: dark wrinkled surround, a long dark streak from the temporal gland in bulls
    const ex = ax - eye[0], ey = y - eye[1], ez = z - eye[2];
    const ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (ed < 0.11) blendHex(c.color, EYE_RING, smooth(0.11, 0.04, ed) * 0.85);
    if (male) {
      const gx = ax - 0.42, gz = z - 2.18;
      const streak = smooth(0.06, 0.02, Math.abs(gz + (y - 2.5) * 0.25)) * smooth(2.62, 2.5, y) * smooth(2.05, 2.25, y) * smooth(0.1, 0.0, Math.abs(gx));
      blendHex(c.color, 0x2e2a27, streak * 0.75);
    }
    // tusks: ivory, stained towards the lip; smooth and glossy (micro detail off)
    if (c.part === 'tusk' || c.pw('tusk') > 0.5) {
      const pa = polyArc(ax, y, z, tusk);
      c.color.setHex(IVORY);
      blendHex(c.color, IVORY_BASE, smooth(0.32, 0.05, pa.s) * 0.85);
      blendHex(c.color, 0xc8b893, clamp01(0.3 + n2 * 0.4) * smooth(0.35, 0.9, pa.s) * 0.35);
      c.w = 0;
      c.gloss = 0.32;
      return;
    }
    if (c.part === 'nail') {
      c.color.setHex(NAIL);
      blendHex(c.color, MUD, 0.25);
      c.w = 0;
      c.gloss = 0.12;
    }
    // sole edge
    if (y < 0.03) blendHex(c.color, 0x3e3833, 0.6);
    // tail bristles
    const tf = c.pw('tuft');
    if (tf > 0.1) {
      blendHex(c.color, TUFT, smooth(0.1, 0.45, tf));
      c.w *= 1 - tf;
      c.fur = 1 + 3 * tf;
    }
  };
}

// ---------------------------------------------------------------------------
// Trunk profiles: per-bone pitch (local X) for trunk_1..6. Negative swings the
// trunk forward / up, positive curls it back under the head. Ground / mouth
// profiles are solved once per design with a small planar FK search.

type Profile = number[];
const NT = 6;
const HANG: Profile = [-0.04, -0.02, 0.0, -0.04, -0.1, -0.22];
const SNIFF: Profile = [-0.75, -0.55, -0.3, -0.2, -0.15, -0.55];
const RAISED: Profile = [-0.95, -0.72, -0.55, -0.4, -0.05, 0.35];
const SNORKEL: Profile = [-0.85, -0.65, -0.55, -0.35, -0.15, 0.05];
const OVERHEAD: Profile = [-1.05, -0.85, -0.75, -0.65, -0.45, -0.3];
const LIMP: Profile = [0.02, 0.02, 0.05, 0.1, -0.35, -0.75];
const WA = [1, 0.8, 0.5, 0.3, 0.2, 0.1];
const WC = [0, 0.2, 0.6, 0.9, 1.0, 0.9];

const SEG_Y: number[] = [];
const SEG_Z: number[] = [];
for (let i = 0; i < NT; i++) {
  SEG_Y.push(T[i + 1][1] - T[i][1]);
  SEG_Z.push(T[i + 1][2] - T[i][2]);
}

/** Planar FK of the trunk in head-local rest coordinates. Returns tip [y, z] and final angle. */
function trunkTip(pitch: ArrayLike<number>, out: number[]): number[] {
  let y = T[0][1], z = T[0][2], th = 0, pen = 0;
  for (let i = 0; i < NT; i++) {
    th += pitch[i];
    const c = Math.cos(th), s = Math.sin(th);
    y += SEG_Y[i] * c - SEG_Z[i] * s;
    z += SEG_Y[i] * s + SEG_Z[i] * c;
    // keep the trunk out of the jaw / chin
    if (z < 2.6 && y > 1.6 && i < NT - 1) pen += (2.6 - z) * 4;
  }
  out[0] = y;
  out[1] = z;
  out[2] = th;
  out[3] = pen;
  return out;
}

/** Solve a two-parameter curl profile so the tip reaches (y, z) with end angle ≈ endAngle. */
function solveProfile(ty: number, tz: number, endAngle: number, endW: number): Profile {
  const tmp = [0, 0, 0, 0];
  const pitch = new Array<number>(NT).fill(0);
  let best = Infinity, ba = 0, bc = 0;
  const evalAC = (a: number, c: number): number => {
    for (let i = 0; i < NT; i++) pitch[i] = a * WA[i] + c * WC[i];
    trunkTip(pitch, tmp);
    const dy = tmp[0] - ty, dz = tmp[1] - tz;
    return dy * dy + dz * dz + endW * (tmp[2] - endAngle) ** 2 + 0.002 * (a * a + c * c) + tmp[3];
  };
  for (let a = -2.0; a <= 1.0; a += 0.05)
    for (let c = -1.0; c <= 2.8; c += 0.05) {
      const e = evalAC(a, c);
      if (e < best) {
        best = e;
        ba = a;
        bc = c;
      }
    }
  return WA.map((w, i) => ba * w + bc * WC[i]);
}

/** Model-space point → head-local rest coords for a neck / head pitch pose (planar). */
function toHeadLocal(gy: number, gz: number, neckPitch: number, headPitch: number): [number, number] {
  const rot = (y: number, z: number, cy: number, cz: number, th: number): [number, number] => {
    const c = Math.cos(th), s = Math.sin(th);
    const dy = y - cy, dz = z - cz;
    return [cy + dy * c - dz * s, cz + dy * s + dz * c];
  };
  // invert: undo neck about the neck joint, then the head about its rest joint
  const [y1, z1] = rot(gy, gz, NECK_J[1], NECK_J[2], -neckPitch);
  return rot(y1, z1, HEAD_J[1], HEAD_J[2], -headPitch);
}

const lerpProfile = (out: number[], a: Profile, b: Profile, t: number): number[] => {
  for (let i = 0; i < NT; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
};

// ---------------------------------------------------------------------------
// Animation

interface EleExtra {
  ps: Posture;
  st2: Pose;
  prof: number[];
  flap: number;
}
type ES = QuadState & EleExtra;

interface Prof {
  mouth: Profile;
  ground: Profile;
  water: Profile;
}

// head poses used by the eat / drink actions (rad, + = down)
const EAT_NECK = 0.1, EAT_HEAD = 0.12;
const DRINK_NECK = 0.06, DRINK_HEAD = 0.06;

function makeDriver(height: number, walkSpeed: number, run: number, P: Prof) {
  const p = quadParams(height, walkSpeed, run, {
    walk: {
      stride: 2.05, refSpeed: walkSpeed, duty: 0.63, offsets: [0.25, 0.75, 0, 0.5], stepHeight: 0.17,
      bob: 0.035, bobFreq: 2, pitch: 0.012, roll: 0.035, headBob: 0.035, spineFlex: 0,
    },
    // fast walk / amble: still a lateral-sequence singlefoot, no suspension
    trot: {
      stride: 2.9, refSpeed: walkSpeed * 2, duty: 0.52, offsets: [0.27, 0.77, 0, 0.5], stepHeight: 0.2,
      bob: 0.045, bobFreq: 2, pitch: 0.015, roll: 0.03, headBob: 0.04, spineFlex: 0,
    },
    gallop: {
      stride: 3.5, refSpeed: run, duty: 0.45, offsets: [0.3, 0.8, 0, 0.5], stepHeight: 0.24,
      bob: 0.05, bobFreq: 2, pitch: 0.02, roll: 0.025, headBob: 0.05, spineFlex: 0,
    },
    footFollow: 0.45,
    frontFlex: 1.0,
    hindFlex: -0.55,
    frontToeCurl: 0.25,
    hindToeCurl: 0.25,
    push: 0.18,
    scapSwing: 0.35,
    lie: { hipsY: 1.42, chestY: 1.5, front: 'tuck', hindSplay: 0.12, headRest: 0.9 },
    grazeReach: 0.3,
    headCarry: 0.05,
    look: 0.28,
    tailSwish: 0.3,
    tailCarry: -0.15,
    earFlick: 0,
    callJaw: 0.2,
    callHead: -0.3,
    callDuration: 3.2,
    breath: 0.007,
    swimSink: 2.62,
  });
  const base = quadrupedDriver(p);

  const trunk = (ctx: AnimCtx) => ctx.roles.chains.trunk;
  const setTrunk = (ctx: AnimCtx, pose: Pose, prof: ArrayLike<number>, side = 0, scale = 1): void => {
    const tb = trunk(ctx);
    applyAngles(pose, tb, 'x', prof, scale);
    if (side !== 0) for (let i = 0; i < tb.length; i++) rotLocal(pose, tb[i], 'z', side * (0.5 + i * 0.12));
  };
  /** Spread (+) / flatten (−) both ears about their attachment. */
  const earSpread = (ctx: AnimCtx, pose: Pose, a: number, outer = 0): void => {
    const ch = ctx.roles.chains;
    rotLocal(pose, ch.earL[0], 'y', -a);
    rotLocal(pose, ch.earR[0], 'y', a);
    if (outer) {
      rotLocal(pose, ch.earL[1], 'y', -outer);
      rotLocal(pose, ch.earR[1], 'y', outer);
    }
  };

  // --- standing doze with a cocked hind foot
  const rest = (ctx: AnimCtx, st: ES, pose: Pose): void => {
    body(ctx, st, pose, 0);
    const R = ctx.roles;
    const cock = ctx.rand > 0.5 ? 3 : 2; // HR or HL
    pose.p[R.root].y -= 0.025;
    rotParent(pose, R.root, 'z', (cock === 3 ? 1 : -1) * 0.025);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const leg = st.legs[cock];
    if (leg) {
      _C.copy(leg.r.contact);
      _C.y += 0.07;
      _C.z += 0.12;
      plantLeg(ctx, st, pose, leg, _C, 0.35, 0.55);
    }
    neckHead(ctx, pose, 0.1 + 0.02 * Math.sin(ctx.time * 0.3), 0.08 * wander(ctx.time * 0.05, ctx.seed), 0.08, 0);
    setTrunk(ctx, pose, LIMP);
    tail(ctx, st, pose, 0.05, 0.4);
    earSpread(ctx, pose, -0.06);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  // --- idle: trunk hangs and swings, sometimes sniffs the air or explores the ground
  const idle = (ctx: AnimCtx, st: ES, pose: Pose): void => {
    actIdle(ctx, st, pose);
    const t = ctx.time;
    const sniff = pulses(t, 13, ctx.seed + 3, 3.2, 0.55);
    const probe = pulses(t + 5, 11, ctx.seed + 4, 3.5, 0.5) * (1 - sniff);
    lerpProfile(st.prof, HANG, SNIFF, smooth(0, 0.7, sniff));
    if (probe > 0) lerpProfile(st.prof, st.prof, P.ground, smooth(0, 0.8, probe) * 0.85);
    setTrunk(ctx, pose, st.prof, 0.1 * glance(t, 6, ctx.seed + 5) + 0.12 * Math.sin(t * 0.7) * (1 - sniff));
    if (sniff > 0) neckHead(ctx, pose, -0.12 * sniff, 0, -0.06 * sniff, 0);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  // --- walk / amble: hips sink a little with speed so the pillar legs keep contact
  const walk = (ctx: AnimCtx, st: ES, pose: Pose): void => {
    const R = ctx.roles;
    body(ctx, st, pose);
    pose.p[R.root].y -= 0.05 * st.wt + 0.06 * st.wg;
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    lookAround(ctx, st, pose, 0.6);
    tail(ctx, st, pose, 0, 0.7);
    // trunk swings like a pendulum with the stride, curling forward at speed
    const sw = Math.sin(st.phase * TAU * 2 - 0.9) * st.amp;
    lerpProfile(st.prof, HANG, SNIFF, st.wg * 0.35);
    st.prof[2] += 0.08 * sw;
    st.prof[4] += 0.12 * sw;
    setTrunk(ctx, pose, st.prof, 0.06 * Math.sin(st.phase * TAU));
    earSpread(ctx, pose, 0.12 * st.wg);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  // --- eat: reach the ground, pluck, lift the bundle to the mouth, chew
  const eat = (ctx: AnimCtx, st: ES, pose: Pose): void => {
    body(ctx, st, pose, 0);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const t = ctx.time + ctx.rand * 9;
    const ph = (t / 5.2) % 1;
    const toG = smooth(0.0, 0.28, ph) * (1 - smooth(0.52, 0.78, ph));
    neckHead(ctx, pose, EAT_NECK, 0.08 * Math.sin(t * 0.37), EAT_HEAD - 0.08 * (1 - toG), 0);
    lerpProfile(st.prof, P.mouth, P.ground, toG);
    const pluck = envelope(ph, 0.26, 0.32, 0.46, 0.52);
    const sweep = Math.sin(t * 7) * pluck;
    st.prof[4] += 0.12 * sweep;
    st.prof[5] += 0.3 * pluck;
    setTrunk(ctx, pose, st.prof, 0.06 * sweep);
    const chew = Math.max(0, Math.sin(t * TAU * 1.2)) * (1 - toG);
    rotLocal(pose, ctx.roles.jaw, 'x', 0.05 * chew);
    tail(ctx, st, pose, 0, 0.8);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  // --- drink: suck water up, curl the trunk and squirt it into the mouth
  const drink = (ctx: AnimCtx, st: ES, pose: Pose): void => {
    body(ctx, st, pose, 0);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const t = ctx.time + ctx.rand * 7;
    const ph = (t / 6.5) % 1;
    const down = smooth(0.0, 0.18, ph) * (1 - smooth(0.5, 0.68, ph));
    const lift = 1 - down;
    neckHead(ctx, pose, DRINK_NECK * down - 0.12 * lift, 0, DRINK_HEAD * down - 0.14 * lift, 0);
    lerpProfile(st.prof, P.mouth, P.water, down);
    const suck = Math.sin(t * TAU * 1.6) * envelope(ph, 0.18, 0.22, 0.46, 0.5);
    st.prof[5] += 0.04 * suck;
    setTrunk(ctx, pose, st.prof);
    rotLocal(pose, ctx.roles.jaw, 'x', 0.12 * envelope(ph, 0.66, 0.72, 0.9, 0.97));
    tail(ctx, st, pose, 0, 0.6);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  // --- call: trumpet with raised head and trunk, ears spread wide
  const call = (ctx: AnimCtx, st: ES, pose: Pose): void => {
    body(ctx, st, pose, 0);
    const R = ctx.roles;
    const at = ctx.actionTime;
    const env = envelope(at, 0, 0.55, p.callDuration - 0.7, p.callDuration);
    pose.p[R.root].y += 0.04 * env;
    rotParent(pose, R.root, 'x', -0.04 * env);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const blare = envelope(at, 0.5, 0.8, p.callDuration - 1.0, p.callDuration - 0.5);
    const shake = Math.sin(at * TAU * 7) * blare;
    neckHead(ctx, pose, -0.22 * env, 0.04 * shake, -0.14 * env, 0);
    lerpProfile(st.prof, HANG, RAISED, env);
    st.prof[5] += 0.1 * shake;
    st.prof[3] += 0.04 * shake;
    setTrunk(ctx, pose, st.prof);
    rotLocal(pose, R.jaw, 'x', 0.2 * blare);
    earSpread(ctx, pose, 1.05 * env, 0.25 * env);
    tail(ctx, st, pose, -0.6 * env, 0.3);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  // --- play: dust bathing — scoop with the trunk, throw it over the back
  const play = (ctx: AnimCtx, st: ES, pose: Pose): void => {
    body(ctx, st, pose, 0);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const t = ctx.time + ctx.rand * 5;
    const ph = (t / 3.2) % 1;
    const up = smooth(0.45, 0.62, ph) * (1 - smooth(0.75, 0.98, ph));
    const scoop = 1 - smooth(0.25, 0.45, ph) * (1 - smooth(0.85, 1.0, ph));
    lerpProfile(st.prof, P.ground, HANG, 1 - scoop);
    lerpProfile(st.prof, st.prof, OVERHEAD, up);
    setTrunk(ctx, pose, st.prof, 0.25 * up * (ctx.rand > 0.5 ? 1 : -1));
    const toss = Math.sin(t * 2.1);
    neckHead(ctx, pose, -0.12 * up + 0.06, 0.12 * toss, -0.08 * up, 0.06 * toss, 0.05 * toss);
    earSpread(ctx, pose, 0.35 + 0.35 * Math.sin(t * 4.2), 0.15);
    tail(ctx, st, pose, -0.3, 1.4);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  // --- social: reach out with the trunk to greet / touch a herd mate
  const social = (ctx: AnimCtx, st: ES, pose: Pose): void => {
    body(ctx, st, pose, 0);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const t = ctx.time;
    const side = ctx.rand > 0.5 ? 1 : -1;
    const reach = 0.6 + 0.4 * Math.sin(t * 0.8);
    lerpProfile(st.prof, HANG, SNIFF, reach * 0.75);
    st.prof[5] += 0.25 * Math.sin(t * 1.9);
    setTrunk(ctx, pose, st.prof, side * 0.3 * reach);
    neckHead(ctx, pose, -0.05, side * 0.18, -0.03, side * 0.08);
    // rumble: slight jaw tremor, ears half out
    rotLocal(pose, ctx.roles.jaw, 'x', 0.03 * Math.max(0, Math.sin(t * TAU * 0.4)));
    earSpread(ctx, pose, 0.28);
    tail(ctx, st, pose, 0, 0.9);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  // --- swim: body under water, head high, trunk up as a snorkel
  const swim = (ctx: AnimCtx, st: ES, pose: Pose): void => {
    actSwim(ctx, st, pose);
    const R = ctx.roles;
    // undo the generic neck stretch, raise the head instead
    neckHead(ctx, pose, 0.25, 0, -0.32, 0);
    setTrunk(ctx, pose, SNORKEL);
    const tb = trunk(ctx);
    rotLocal(pose, tb[5], 'x', 0.15 * Math.sin(ctx.time * 1.3));
    rotLocal(pose, R.jaw, 'x', 0.02);
  };

  // --- sleep: lie down on the side (sequence driven by the posture value)
  const sleep = (ctx: AnimCtx, st: ES, pose: Pose): void => {
    lying(ctx, st, pose, st.ps.down, false);
  };

  /** Posture continuum: 0 standing → 0.5 sternal (folded legs) → 1 lying on the right side. */
  function lying(ctx: AnimCtx, st: ES, pose: Pose, down: number, rising: boolean): void {
    {
      const R = ctx.roles;
      const rig = ctx.rig;
      void rising;
      // standing reference
      pose.reset();
      body(ctx, st, pose, 0);
      rig.fk(pose);
      legsBlock(ctx, st, pose);
      setTrunk(ctx, pose, LIMP);
      const k1 = smooth(0.0, 0.5, down);
      const k2 = smooth(0.45, 1.0, down);
      if (k1 > 0) {
        // sternal crouch: framework lie() with legs folded under
        st.st2.reset();
        lie(ctx, st, st.st2, 'up');
        setTrunk(ctx, st.st2, LIMP, 0, 0.6);
        blendInto(pose, st.st2, k1);
      }
      if (k2 > 0) {
        const L = st.st2;
        L.reset();
        // roll onto the right side; the barrel rests on the ground
        rotParent(L, R.root, 'z', Math.PI / 2 - 0.06);
        L.p[R.root].y = 0.86 - st.hipsY;
        L.p[R.root].x = -0.25;
        const br = Math.sin(ctx.time * TAU * 0.12);
        rotLocal(L, R.chest, 'x', 0.01 * br);
        // legs stretched out, upper pair resting on the lower pair, gently bent
        for (const leg of st.legs) {
          const top = leg.side > 0;
          rotLocal(L, leg.r.upper, 'x', leg.front ? -0.28 : 0.25);
          rotLocal(L, leg.r.upper, 'z', top ? -0.18 : 0.05);
          rotLocal(L, leg.r.lower, 'x', leg.front ? 0.18 : -0.22);
          rotLocal(L, leg.r.foot, 'x', leg.front ? 0.12 : -0.1);
        }
        // head down onto the ground, trunk lying along it, ears flat
        rotLocal(L, R.neck[0], 'y', -0.3);
        rotLocal(L, R.head, 'y', -0.22);
        rotLocal(L, R.head, 'z', -0.12);
        const tb = trunk(ctx);
        for (let i = 0; i < tb.length; i++) {
          rotLocal(L, tb[i], 'z', -0.2);
          rotLocal(L, tb[i], 'x', i < 3 ? -0.18 : -0.28 - 0.05 * Math.sin(ctx.time * 0.4 + i));
        }
        const ch = ctx.roles.chains;
        rotLocal(L, ch.earL[0], 'y', 0.08);
        rotLocal(L, ch.earR[0], 'y', -0.35);
        for (let i = 0; i < R.tail.length; i++) rotLocal(L, R.tail[i], 'z', -0.3);
        blendInto(pose, L, k2);
      }
    }
  }

  // --- post: ear flapping bouts and a little trunk life on top of every action
  const post = (ctx: AnimCtx, st: ES, pose: Pose): void => {
    const t = ctx.time;
    const ch = ctx.roles.chains;
    const asleep = ctx.action === 'sleep' ? 1 : 0;
    const calm = ctx.action === 'call' ? 0.2 : 1;
    // cooling flaps: bouts of 0.7 Hz flapping
    const bout = clamp01(glance(t, 9, ctx.seed + 11) * 1.4 + 0.2 + (ctx.action === 'play' ? 0.6 : 0));
    st.flap += (bout - st.flap) * Math.min(1, ctx.dt * 0.8);
    const f = Math.max(0, Math.sin(t * TAU * 0.7)) * st.flap * calm * (1 - asleep * st.ps.down);
    const f2 = Math.max(0, Math.sin(t * TAU * 0.7 - 0.7)) * st.flap * calm * (1 - asleep * st.ps.down);
    rotLocal(pose, ch.earL[0], 'y', EAR_FOLD - 0.45 * f);
    rotLocal(pose, ch.earR[0], 'y', -EAR_FOLD + 0.45 * f);
    rotLocal(pose, ch.earL[1], 'y', 0.12 - 0.25 * f2);
    rotLocal(pose, ch.earR[1], 'y', -0.12 + 0.25 * f2);
    // trunk: slow living sway (less while it is busy)
    const busy = ctx.action === 'eat' || ctx.action === 'drink' || ctx.action === 'call' ? 0.3 : 1;
    const tb = ch.trunk;
    for (let i = 2; i < tb.length; i++) {
      const k = (i - 1) / tb.length;
      rotLocal(pose, tb[i], 'z', 0.035 * busy * k * Math.sin(t * 0.83 - i * 0.55 + ctx.seed));
      rotLocal(pose, tb[i], 'x', 0.03 * busy * k * Math.sin(t * 0.61 - i * 0.4));
    }
  };

  const d = {
    ...base,
    init: (ctx: AnimCtx): ES => {
      const st = initQuad(ctx, p) as ES;
      st.ps = new Posture(ctx.def.count);
      st.st2 = new Pose(ctx.def.count);
      st.prof = new Array<number>(NT).fill(0);
      st.flap = 0;
      return st;
    },
    pre: (ctx: AnimCtx, st: ES): void => {
      advanceGait(ctx, st);
      updatePosture(ctx, st.ps, ctx.action === 'sleep', 4.5, 3.2);
    },
    actions: {
      ...base.actions,
      idle,
      walk,
      eat,
      drink,
      rest,
      sit: rest,
      sleep,
      call,
      play,
      social,
      swim,
    },
    post,
    fade: 0.5,
    fades: { sleep: 0.35, rest: 1.2, sit: 1.2, call: 0.35, swim: 0.8 },
  };
  return d;
}

const _C = new THREE.Vector3();

// ---------------------------------------------------------------------------

function design(ctx: DesignContext): CreatureDesign {
  const male = ctx.sex === 'M';
  const tusk = tuskPts(male);
  const extra = [
    ...['trunk_1', 'trunk_2', 'trunk_3', 'trunk_4', 'trunk_5', 'trunk_6'].map((n, i) => ({ name: n, parent: i === 0 ? 'head' : `trunk_${i}`, pos: T[i] })),
    ...bilateralBones([
      { name: 'ear.L', parent: 'head', pos: EAR_A },
      { name: 'ear2.L', parent: 'ear.L', pos: EAR2 },
    ]),
  ];
  const sk = quadSkeleton({ ...J, extra, chains: { trunk: ['trunk_1', 'trunk_2', 'trunk_3', 'trunk_4', 'trunk_5', 'trunk_6'], earL: ['ear.L', 'ear2.L'], earR: ['ear.R', 'ear2.R'] } });
  const head = withRegion(headPrims(male), 'head');
  const prims: Prim[] = [
    ...bodyPrims(male),
    ...head,
    ...trunkPrims(),
    ...tuskPrims(male),
    ...earPrims(male),
    ...legPrimsLeft(),
    ...mirrorX(legPrimsLeft()),
    ...tailPrims(),
  ];
  // eye: small, low on the side of the face behind the trunk base
  const eyeDir: Vec3 = [-1, 0, -0.1];
  const hit = surfacePoint(head, [0.9, 2.46, 2.42], eyeDir, 0.8);
  const eye = seat(hit, eyeDir, 0.012);
  // eyelid ridge around the eye
  prims.push(
    ...symmetric([
      ellipsoid('head', [eye[0] + 0.005, eye[1] + 0.02, eye[2]], [0.035, 0.03, 0.05], { blend: 0.03, part: 'head', region: 'head' }),
    ]),
  );
  // solved trunk profiles
  const [my, mz] = [1.94, 2.68];
  const mouth = solveProfile(my, mz, 3.3, 0.02);
  const g = toHeadLocal(0.16, 3.2, EAT_NECK, EAT_HEAD);
  const ground = solveProfile(g[0], g[1], -0.35, 0.01);
  const w = toHeadLocal(0.02, 3.35, DRINK_NECK, DRINK_HEAD);
  const water = solveProfile(w[0], w[1], -0.1, 0.01);
  const d = makeDriver(ctx.def.height, ctx.def.walkSpeed, ctx.def.runSpeed, { mouth, ground, water });
  return {
    bones: sk.bones,
    roles: sk.roles,
    prims,
    resolution: 0.85,
    regions: {
      head: { scale: 0.54 },
      trunk: { scale: 0.36, aniso: [1, 1.6, 1] },
      tusks: { scale: 0.28, aniso: [1, 1, 1.7] },
      ears: { scale: 0.125, aniso: [5.6, 5.6, 1] },
      FL: { scale: 0.72, aniso: [1, 1.5, 1] },
      FR: { scale: 0.72, aniso: [1, 1.5, 1] },
      HL: { scale: 0.72, aniso: [1, 1.5, 1] },
      HR: { scale: 0.72, aniso: [1, 1.5, 1] },
      tail: { scale: 0.3, aniso: [1, 2.2, 1] },
    },
    coat: elephantCoat(male, eye, tusk.pts),
    look: { skin: 'hide', pattern: 'stripes', roughness: 0.9, sheen: 0.06, grain: 0.012, bump: 0.38, mottle: 0.14 },
    eyes: [{ bone: 'head', pos: eye, radius: 0.03, color: 0x24170d }],
    anim: driver(d),
    babyScale: 0.3,
    babyHead: 1.3,
    height: male ? 3.25 : 3.15,
    radius: 1.4,
  };
}

const elephant: SpeciesModel = {
  id: 'elephant',
  dimorphic: true,
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.0 : 0.84) * (0.97 + r * 0.06),
};
export default elephant;
