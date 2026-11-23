// Greater flamingo (Phoenicopterus roseus) — 'bird' rig (long-legged wader).
//
// A compact horizontal body on very long, thin pink legs whose visible
// "backward knee" is the ankle, a long neck held in a relaxed S, a small head
// and the thick bill that bends sharply down in the middle (pale base, black
// distal half). Plumage is pink, deeper coral-red on the wing coverts, with the
// black flight feathers showing along the folded wing and over the tail
// (crisp per-pixel 'field' pattern for the black parts).
// Animation (species-special-rigs/wader-rig.ts): high-stepping walk, resting
// on one leg with the head laid back, preening, upside-down filter feeding,
// sitting on folded legs, honking with head-flagging and a wing salute.

import { cone, ellipsoid, mirrorX, roundBox, sphere, symmetric, type Prim, type Vec3 } from '../sdf/prims';
import { seat, surfacePoint, withRegion } from '../kit/quadruped';
import { driver } from '../anim/util';
import { blendHex, clamp01, fbm, smooth } from '../coat/coat';
import { waderDriver } from './species-special-rigs/wader-rig';
import type { BoneSpec } from '../rig/rig';
import type { CoatSample, CreatureDesign, DesignContext, RigRoles, SpeciesModel } from '../types';
import * as THREE from 'three';

const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];

// Neck centre line in the relaxed S (base at the breast → head joint).
const NECK: Vec3[] = [
  v3(0, 0.955, 0.15),
  v3(0, 0.995, 0.24),
  v3(0, 1.055, 0.312),
  v3(0, 1.137, 0.338),
  v3(0, 1.215, 0.318),
  v3(0, 1.272, 0.268),
  v3(0, 1.312, 0.226),
  v3(0, 1.338, 0.214),
];
const NECK_R = [0.031, 0.022, 0.018, 0.0165, 0.016, 0.016, 0.0165, 0.018];
const NECK_BONES = NECK.slice(0, -1).map((_, i) => `neck_${i + 1}`);
const HEAD = NECK[NECK.length - 1];
const BILL_TIP: Vec3 = [0, 1.29, 0.346];

const BONES: BoneSpec[] = [
  { name: 'hips', parent: null, pos: v3(0, 0.92, -0.06) },
  { name: 'chest', parent: 'hips', pos: v3(0, 0.95, 0.08) },
  ...NECK_BONES.map((name, i): BoneSpec => ({ name, parent: i === 0 ? 'chest' : NECK_BONES[i - 1], pos: NECK[i] })),
  { name: 'head', parent: NECK_BONES[NECK_BONES.length - 1], pos: HEAD },
  { name: 'jaw', parent: 'head', pos: v3(0, 1.336, 0.262) },
  { name: 'tail_1', parent: 'hips', pos: v3(0, 0.935, -0.24) },
  ...(['L', 'R'] as const).flatMap((s): BoneSpec[] => {
    const k = s === 'L' ? 1 : -1;
    return [
      { name: `wing_1.${s}`, parent: 'chest', pos: v3(0.07 * k, 0.985, 0.1) },
      { name: `wing_2.${s}`, parent: `wing_1.${s}`, pos: v3(0.072 * k, 0.965, -0.1) },
      { name: `H${s}_upper`, parent: 'hips', pos: v3(0.052 * k, 0.84, -0.02) },
      { name: `H${s}_lower`, parent: `H${s}_upper`, pos: v3(0.05 * k, 0.445, -0.062) },
      { name: `H${s}_foot`, parent: `H${s}_lower`, pos: v3(0.05 * k, 0.034, -0.012) },
    ];
  }),
];

const ROLES: RigRoles = {
  root: 'hips',
  spine: [],
  chest: 'chest',
  neck: NECK_BONES,
  head: 'head',
  jaw: 'jaw',
  tail: ['tail_1'],
  legs: {
    HL: { upper: 'HL_upper', lower: 'HL_lower', foot: 'HL_foot', contact: v3(0.05, 0, 0.035) },
    HR: { upper: 'HR_upper', lower: 'HR_lower', foot: 'HR_foot', contact: v3(-0.05, 0, 0.035) },
  },
  arms: {
    L: { upper: 'wing_1.L', lower: 'wing_2.L', hand: 'wing_2.L' },
    R: { upper: 'wing_1.R', lower: 'wing_2.R', hand: 'wing_2.R' },
  },
  muzzle: BILL_TIP,
};

function bodyPrims(): Prim[] {
  return [
    // compact, slightly front-high body
    ellipsoid('hips', [0, 0.925, -0.06], [0.104, 0.098, 0.2], { rot: [-0.1, 0, 0], blend: 0.05, part: 'body' }),
    ellipsoid('chest', [0, 0.945, 0.08], [0.097, 0.1, 0.12], { blend: 0.06, part: 'body' }),
    // full breast where the neck rises
    ellipsoid('chest', [0, 0.935, 0.15], [0.068, 0.075, 0.06], { blend: 0.05, part: 'body' }),
    // short tail with the black primaries crossing over it
    ellipsoid('tail_1', [0, 0.935, -0.265], [0.052, 0.02, 0.07], { rot: [-0.12, 0, 0], blend: 0.03, part: 'tail' }),
    // folded wings: coverts (coral-red) over the side, flight feathers trailing to the tail
    ...symmetric([
      ellipsoid('wing_1.L', [0.068, 0.968, 0.0], [0.05, 0.068, 0.17], { rot: [-0.06, 0.06, 0.32], blend: 0.03, part: 'coverts' }),
      ellipsoid('wing_2.L', [0.056, 0.925, -0.2], [0.03, 0.036, 0.145], { rot: [-0.12, 0.12, 0.25], blend: 0.02, part: 'primaries' }),
    ]),
  ];
}

function neckPrims(): Prim[] {
  const P: Prim[] = [];
  for (let i = 0; i < NECK.length - 1; i++) {
    P.push(
      cone(NECK_BONES[i], NECK[i], NECK[i + 1], NECK_R[i] * (i === 0 ? 1.1 : 1), NECK_R[i + 1], {
        blend: i === 0 ? 0.04 : 0.004,
        skin: 3.5,
        part: 'neck',
        // neck and head share one fine grid: the coarse base grid must not
        // bridge the narrow gap between the jaw and the throat
        region: i === 0 ? undefined : 'neck',
      }),
    );
  }
  return P;
}

function headPrims(): Prim[] {
  return [
    // small rounded head
    ellipsoid('head', [0, 1.349, 0.238], [0.021, 0.024, 0.031], { blend: 0.012, part: 'head', skinWeight: 2 }),
    // bare face running into the bill base
    ellipsoid('head', [0, 1.343, 0.258], [0.016, 0.018, 0.018], { blend: 0.01, part: 'face', skinWeight: 2 }),
    // thick bill bending sharply down at the middle: thin upper "lid", deep lower mandible
    cone('head', [0, 1.348, 0.262], [0, 1.334, 0.316], 0.0105, 0.0085, { blend: 0.008, part: 'bill' }),
    cone('head', [0, 1.334, 0.316], [0, 1.293, 0.345], 0.0082, 0.0036, { blend: 0.006, part: 'bill' }),
    cone('jaw', [0, 1.336, 0.262], [0, 1.326, 0.314], 0.0125, 0.0105, { blend: 0.008, part: 'bill' }),
    cone('jaw', [0, 1.326, 0.314], [0, 1.29, 0.339], 0.009, 0.004, { blend: 0.006, part: 'bill' }),
  ];
}

function legPrimsLeft(): Prim[] {
  const P: Prim[] = [
    // feathered thigh under the belly
    cone('HL_upper', [0.05, 0.875, -0.015], [0.053, 0.775, -0.03], 0.024, 0.012, { blend: 0.03, part: 'body' }),
    // long bare tibiotarsus, knobby ankle, tarsometatarsus
    cone('HL_upper', [0.053, 0.795, -0.028], [0.05, 0.457, -0.06], 0.0108, 0.009, { blend: 0.01, part: 'leg', region: 'HL' }),
    ellipsoid('HL_lower', [0.05, 0.444, -0.064], [0.0118, 0.017, 0.0128], { blend: 0.008, part: 'ankle', region: 'HL' }),
    cone('HL_lower', [0.05, 0.432, -0.06], [0.05, 0.048, -0.014], 0.0092, 0.0082, { blend: 0.008, part: 'leg', region: 'HL' }),
    // webbed foot (three front toes)
    // MTP knob shares the leg's grid so the tarsus and the foot join without a seam
    sphere('HL_foot', [0.05, 0.03, -0.01], 0.0098, { blend: 0.008, part: 'foot', region: 'HL' }),
    ellipsoid('HL_foot', [0.05, 0.011, 0.04], [0.026, 0.0066, 0.038], { blend: 0.006, part: 'foot', region: 'foot.L' }),
  ];
  for (const [dx, len] of [
    [-0.028, 0.068],
    [0, 0.085],
    [0.028, 0.068],
  ] as const) {
    P.push(cone('HL_foot', [0.05, 0.022, 0.0], [0.05 + dx, 0.0078, len], 0.006, 0.0042, { blend: 0.006, part: 'foot', region: 'foot.L' }));
  }
  P.push(roundBox('HL_foot', [0.05, -0.05, 0.03], [0.06, 0.05, 0.08], 0.004, { sub: true, blend: 0.003, part: 'foot', region: 'foot.L' }));
  return P;
}

// ---------------------------------------------------------------------------
// Coat

const PINK = 0xe9a09d;
const PINK_PALE = 0xeeb6b0;
const PINK_NECK = 0xe99592;
const CORAL = 0xd8475a;
const BLACK = 0x141113;
const LEG = 0xdf7f8e;
const BILL_BASE = 0xeec5bd;

function flamingoCoat(eye: Vec3) {
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    const n = fbm(x * 14, y * 14, z * 14, 3, 71);
    c.color.setHex(PINK);
    // paler back and flanks, richer pink on the neck and underparts
    blendHex(c.color, PINK_PALE, clamp01(smooth(0.2, 0.9, c.ny) * 0.5 + n * 0.3));
    blendHex(c.color, PINK_NECK, clamp01(c.pw('neck') * 1.3 + c.pw('head')) * 0.8);
    c.color2.setHex(BLACK);
    c.s = -0.01;
    // wing coverts: deep coral-red on the upper / fore part of the folded wing
    // (feather rows: streaks along the wing)
    const rows = 0.5 + 0.5 * Math.sin(z * 160 + fbm(x * 30, y * 30, z * 30, 2, 73) * 3);
    const cov = smooth(0.012, -0.002, c.pd('coverts')) * smooth(-0.2, -0.02, z) * smooth(0.12, 0.04, z) * smooth(0.9, 0.95, y) * smooth(-0.3, 0.2, Math.sign(x) * c.nx);
    blendHex(c.color, CORAL, clamp01(cov * (0.45 + 0.35 * rows) + (n - 0.2) * 0.3 * cov));
    // flight feathers: black along the lower rear edge of the wing and over the tail
    const prd = c.pd('primaries');
    if (prd < 0.03) c.s = Math.min(0.007 - prd + 0.003 * n, (-0.1 - z) * 0.4, (0.962 - y) * 0.3);
    // legs and feet: pink, ankles a touch darker
    const lg = c.pw('leg') + c.pw('ankle') + c.pw('foot');
    if (lg > 0.15) {
      const k = smooth(0.15, 0.5, lg);
      blendHex(c.color, LEG, k);
      blendHex(c.color, 0xc8697a, c.pw('ankle') * 0.5 + c.pw('foot') * 0.3);
      c.gloss = 0.12 * k;
    }
    // face and bill: pale base, black distal half beyond the bend
    const fc = c.pw('face');
    if (fc > 0.4 && c.part === 'face') blendHex(c.color, BILL_BASE, smooth(0.4, 0.8, fc) * 0.7);
    const bl = c.pw('bill');
    if (bl > 0.35 && c.part === 'bill') {
      const k = smooth(0.35, 0.65, bl);
      blendHex(c.color, BILL_BASE, k);
      const bend = Math.max(z - 0.313, (1.33 - y) * 1.2);
      c.s = k > 0.5 ? bend : c.s;
      c.gloss = 0.3 * k;
    }
    // pale yellow eye ring of bare skin
    const ex = Math.abs(x) - eye[0], ey = y - eye[1], ez = z - eye[2];
    const ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (ed < 0.009) blendHex(c.color, 0xe9c9b9, smooth(0.009, 0.006, ed));
  };
}

function elevations(pts: readonly Vec3[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) out.push((Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]) * 180) / Math.PI);
  return out;
}

const RES = 0.86;

function design(ctx: DesignContext): CreatureDesign {
  const head = withRegion(headPrims(), 'neck');
  const prims: Prim[] = [...bodyPrims(), ...neckPrims(), ...head, ...legPrimsLeft(), ...mirrorX(legPrimsLeft())];
  const eyeDir: Vec3 = [-1, 0, -0.1];
  const hit = surfacePoint(head, [0.1, 1.354, 0.257], eyeDir, 0.2);
  const eye = seat(hit, eyeDir, 0.003);
  // dark pupil just in front of the pale yellow iris
  const pupil: Vec3 = [eye[0] + 0.0028, eye[1], eye[2] + 0.0003];
  const anim = waderDriver({
    restElev: elevations(NECK),
    up: { elev: [78, 84, 88, 91, 92, 92, 92], head: -0.1 },
    // feeding: with the body tipped ~43° the neck hangs nearly vertically, head upside down
    down: { elev: [-35, -44, -48, -52, -57, -66, -76], head: 2.15 },
    // resting: the neck folds back over the body, head laid on the back
    tuck: { elev: [62, 130, 175, 195, 200, 195, 190], head: 0.1 },
    stride: 0.72,
    walkSpeed: ctx.def.walkSpeed,
    runSpeed: ctx.def.runSpeed,
    lift: 0.14,
    tuckFoot: new THREE.Vector3(0.03, 0.87, 0.16),
    sitY: 0.105,
    feedPitch: 0.75,
    feedDrop: 0.1,
  });
  return {
    bones: BONES,
    roles: ROLES,
    prims,
    // flock species (up to 30 per habitat): a lean base grid, fine grids
    // sized in metres for the thin parts so they never break up on any tier
    resolution: RES,
    // (`cell` caps the fine cell in metres; `noBase` keeps the thin parts off the
    // coarse grid, which would otherwise bridge jaw and throat / blob the legs)
    regions: {
      neck: { scale: 1, cell: [0.012, 0.0105, 0.0085][ctx.detail], noBase: true },
      HL: { scale: 1, cell: [0.0095, 0.0085, 0.007][ctx.detail], aniso: [1, 4, 1], noBase: true },
      HR: { scale: 1, cell: [0.0095, 0.0085, 0.007][ctx.detail], aniso: [1, 4, 1], noBase: true },
      'foot.L': { scale: 1, cell: [0.0068, 0.006, 0.0045][ctx.detail] },
      'foot.R': { scale: 1, cell: [0.0068, 0.006, 0.0045][ctx.detail] },
    },
    coat: flamingoCoat(eye),
    look: {
      skin: 'feather',
      pattern: 'field',
      roughness: 0.82,
      sheen: 0.22,
      grain: 0.0042,
      bump: 0.38,
      mottle: 0.06,
      // chicks: grey-white down and grey legs; the pink comes with age
      juvenile: { color: 0xb3aea8, amount: 0.95, until: 0.8, keep: 0.3 },
    },
    eyes: [
      { bone: 'head', pos: eye, radius: 0.0044, color: 0xd8c25a },
      { bone: 'head', pos: pupil, radius: 0.0021, color: 0x0c0a08 },
    ],
    anim: driver(anim),
    babyScale: 0.35,
    babyHead: 1.3,
    height: 1.35,
    radius: 0.3,
  };
}

const flamingo: SpeciesModel = {
  id: 'flamingo',
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.04 : 0.95) * (0.96 + r * 0.08),
};
export default flamingo;
