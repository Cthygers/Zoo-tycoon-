// White rhinoceros (Ceratotherium simum). Massive barrel body with the
// muscular nuchal hump, a long low-carried head with the broad square lip,
// two keratin horns (long front, short rear), small eyes set low behind the
// horns, tubular fringed ears that swivel independently, skin folds behind
// the shoulder, at the flank / thigh and around the legs (grooves + darker
// crease lines), stout three-toed legs and a short tail with a bristle tip.
//
// Animation: head-low walk with nodding, trot and a surprisingly fast
// gallop, lawnmower grazing (slow side sweeps), independently swivelling
// ears, a snort / bellow call, horn-tossing play and nose-to-nose greeting.

import { cone, ellipsoid, mirrorX, roundBox, symmetric, transformPoint, transformPrims, tube, type Prim, type Vec3 } from '../sdf/prims';
import { quadSkeleton, seat, surfacePoint, withRegion, type QuadJoints } from '../kit/quadruped';
import {
  actDrink,
  actEat,
  body,
  jaw,
  legs as legsBlock,
  lie,
  lookAround,
  neckHead,
  quadParams,
  quadrupedDriver,
  reachMuzzle,
  tail,
  type QuadState,
} from '../anim/quadruped';
import { driver, glance, pulses, TAU } from '../anim/util';
import { Pose, rotLocal, rotParent } from '../rig/rig';
import { blendHex, clamp01, fbm, smooth } from '../coat/coat';
import type { AnimCtx, CoatSample, CreatureDesign, DesignContext, SpeciesModel } from '../types';
import { envelope, segDist } from './species-large-herbivores/common';

// ---------------------------------------------------------------------------
// Proportions (bull, shoulder 1.8 m)

const POLL: Vec3 = [0, 1.42, 1.32];
const HA = 0.72; // head axis ≈ 41° below horizontal
const HD: Vec3 = [0, -Math.sin(HA), Math.cos(HA)];
const HUP: Vec3 = [0, Math.cos(HA), Math.sin(HA)];
const hp = (t: number, u = 0, x = 0): Vec3 => [x, POLL[1] + HD[1] * t + HUP[1] * u, POLL[2] + HD[2] * t + HUP[2] * u];
/** The head is authored compact and scaled up about the poll (white rhinos have huge heads). */
const HEAD_T = { scale: 1.17, about: POLL, offset: [0, 0.02, 0.02] as Vec3 };
const H = (v: Vec3): Vec3 => transformPoint(v, HEAD_T);

const J: QuadJoints = {
  hips: [0, 1.38, -0.82],
  spine: [
    [0, 1.42, -0.32],
    [0, 1.46, 0.18],
  ],
  chest: [0, 1.45, 0.62],
  neck: [[0, 1.42, 0.98]],
  head: POLL,
  jaw: H(hp(0.3, -0.18)),
  ear: H([0.14, 1.52, 1.28]),
  tail: [
    [0, 1.46, -1.3],
    [0, 1.26, -1.38],
    [0, 1.04, -1.41],
  ],
  front: {
    scap: [0.33, 1.55, 0.72],
    upper: [0.4, 1.15, 0.95],
    lower: [0.39, 0.72, 0.7],
    foot: [0.37, 0.32, 0.8],
    toe: [0.37, 0.11, 0.84],
    contact: [0.37, 0, 0.88],
  },
  hind: {
    upper: [0.36, 1.25, -0.85],
    lower: [0.42, 0.76, -0.62],
    foot: [0.37, 0.4, -1.0],
    toe: [0.37, 0.11, -0.95],
    contact: [0.37, 0, -0.9],
  },
  muzzle: H(hp(0.98, -0.1)),
};

// ---------------------------------------------------------------------------
// Sculpt

function bodyPrims(): Prim[] {
  return [
    // chest + shoulders
    ellipsoid('chest', [0, 1.18, 0.58], [0.56, 0.55, 0.5], { blend: 0.14, part: 'body' }),
    ellipsoid('chest', [0, 1.52, 0.6], [0.32, 0.16, 0.34], { blend: 0.15, part: 'body' }),
    ellipsoid('chest', [0, 0.95, 0.88], [0.36, 0.28, 0.24], { blend: 0.12, part: 'body' }),
    // barrel: very wide
    ellipsoid('spine_2', [0, 1.1, 0.1], [0.64, 0.5, 0.6], { blend: 0.15, part: 'body' }),
    ellipsoid('spine_1', [0, 1.06, -0.36], [0.62, 0.46, 0.5], { blend: 0.16, part: 'belly' }),
    ellipsoid('spine_1', [0, 1.5, -0.32], [0.38, 0.12, 0.45], { blend: 0.15, part: 'body' }),
    // hindquarters
    ellipsoid('hips', [0, 1.2, -0.85], [0.52, 0.48, 0.48], { blend: 0.14, part: 'body' }),
    ellipsoid('hips', [0, 1.58, -0.78], [0.3, 0.12, 0.36], { blend: 0.14, part: 'body' }),
    ...symmetric([
      ellipsoid('FL_scap', [0.38, 1.22, 0.74], [0.2, 0.4, 0.3], { rot: [-0.3, 0, 0], blend: 0.12, part: 'body' }),
      ellipsoid('HL_upper', [0.38, 1.08, -0.82], [0.22, 0.42, 0.36], { blend: 0.13, part: 'body' }),
      ellipsoid('HL_upper', [0.22, 1.15, -1.12], [0.24, 0.38, 0.22], { blend: 0.13, part: 'body' }),
    ]),
    // short thick neck and the muscular nuchal hump
    ellipsoid('neck_1', [0, 1.3, 1.0], [0.4, 0.45, 0.34], { blend: 0.15, part: 'neck' }),
    ellipsoid('neck_1', [0, 1.7, 0.97], [0.27, 0.2, 0.27], { blend: 0.12, part: 'neck' }),
    ellipsoid('neck_1', [0, 0.98, 1.12], [0.3, 0.22, 0.24], { blend: 0.12, part: 'neck' }),
  ];
}

/** Skin folds: grooves carved into the body (and their raised lips). */
function foldPrims(): Prim[] {
  return symmetric([
    // behind the shoulder: overlapping shield edge + groove
    cone('chest', [0.56, 1.4, 0.31], [0.66, 0.92, 0.35], 0.035, 0.035, { sub: true, blend: 0.08, part: 'fold' }),
    // flank fold in front of the thigh
    cone('HL_upper', [0.6, 1.26, -0.47], [0.59, 0.8, -0.45], 0.032, 0.03, { sub: true, blend: 0.08, part: 'fold' }),
  ]);
}

function headPrims(): Prim[] {
  return [
    // long skull: broad cranium, flat profile with a dip before the horn boss
    ellipsoid('head', hp(0.16, 0.0), [0.26, 0.24, 0.28], { rot: [HA, 0, 0], blend: 0.08, part: 'head' }),
    ellipsoid('head', hp(0.46, -0.02), [0.22, 0.2, 0.3], { rot: [HA, 0, 0], blend: 0.08, part: 'head' }),
    ellipsoid('head', hp(0.74, -0.04), [0.2, 0.17, 0.22], { rot: [HA, 0, 0], blend: 0.07, part: 'head' }),
    // massive jaw / cheeks
    ...symmetric([ellipsoid('jaw', hp(0.36, -0.2, 0.13), [0.14, 0.17, 0.27], { rot: [HA, 0, 0], blend: 0.08, part: 'head' })]),
    ellipsoid('jaw', hp(0.62, -0.2), [0.17, 0.12, 0.24], { rot: [HA, 0, 0], blend: 0.07, part: 'head' }),
    // broad square lip (grazer)
    roundBox('head', hp(0.95, -0.12), [0.2, 0.1, 0.09], 0.07, { rot: [HA - 0.25, 0, 0], blend: 0.07, part: 'lip' }),
    roundBox('jaw', hp(0.9, -0.23), [0.19, 0.06, 0.08], 0.05, { rot: [HA - 0.2, 0, 0], blend: 0.05, part: 'lip' }),
    // horn bosses
    ellipsoid('head', hp(0.82, 0.12), [0.12, 0.08, 0.13], { rot: [HA, 0, 0], blend: 0.06, part: 'head' }),
    ellipsoid('head', hp(0.5, 0.15), [0.1, 0.06, 0.1], { rot: [HA, 0, 0], blend: 0.05, part: 'head' }),
    // eye bulges
    ...symmetric([ellipsoid('head', hp(0.4, 0.02, 0.2), [0.07, 0.06, 0.08], { blend: 0.06, part: 'head' })]),
    // mouth line + nostrils
    ellipsoid('head', hp(0.94, -0.19), [0.22, 0.012, 0.12], { rot: [HA - 0.4, 0, 0], sub: true, blend: 0.015, part: 'mouth' }),
    ...symmetric([ellipsoid('head', hp(0.92, 0.0, 0.1), [0.03, 0.022, 0.045], { rot: [HA, 0.5, 0], sub: true, blend: 0.015, part: 'lip' })]),
  ];
}

function hornPrims(male: boolean): Prim[] {
  const g = male ? 1 : 0.86;
  // front horn: broad base on the nose, curving slightly forward then back
  const base = hp(0.84, 0.16);
  const fh: Vec3[] = [
    base,
    [0, base[1] + 0.17 * g, base[2] + 0.02],
    [0, base[1] + 0.34 * g, base[2] + 0.0],
    [0, base[1] + 0.5 * g, base[2] - 0.05],
    [0, base[1] + 0.62 * g, base[2] - 0.12],
  ];
  const rb = hp(0.52, 0.16);
  const rh: Vec3[] = [rb, [0, rb[1] + 0.12, rb[2] - 0.0], [0, rb[1] + 0.22, rb[2] - 0.04]];
  return [
    ...tube('head', fh, [0.115, 0.09, 0.062, 0.035, 0.01], { blend: 0.03, part: 'horn', region: 'horns' }),
    ...tube('head', rh, [0.085, 0.055, 0.012], { blend: 0.03, part: 'horn', region: 'horns' }),
  ];
}

function earPrims(): Prim[] {
  const left: Prim[] = [
    // tubular ear: rolled cone, open to the front / side
    cone('ear.L', [0.14, 1.5, 1.28], [0.2, 1.7, 1.24], 0.045, 0.06, { blend: 0.03, part: 'ear', region: 'ears' }),
    ellipsoid('ear.L', [0.205, 1.73, 1.24], [0.055, 0.045, 0.06], { blend: 0.02, part: 'ear', region: 'ears' }),
    cone('ear.L', [0.17, 1.58, 1.28], [0.215, 1.76, 1.27], 0.025, 0.04, { sub: true, blend: 0.01, part: 'ear', region: 'ears' }),
    // fringe of hair on the rim
    ellipsoid('ear.L', [0.21, 1.775, 1.24], [0.05, 0.02, 0.055], {
      blend: 0.015,
      part: 'fringe',
      region: 'ears',
      noise: { amp: 0.006, freq: 60, stretch: [1, 0.2, 1], ridged: true, seed: 81 },
    }),
  ];
  return [...left, ...mirrorX(left)];
}

function legPrimsLeft(): Prim[] {
  const f = J.front, h = J.hind;
  const nails = (bone: string, cx: number, cz: number, dir: number, region: string): Prim[] =>
    [-0.75, 0, 0.75].map((a) =>
      ellipsoid(bone, [cx + Math.sin(a) * 0.13, 0.045, cz + dir * Math.cos(a) * 0.13], [0.055, 0.045, 0.04], { rot: [0, a, 0], blend: 0.02, part: 'nail', region }),
    );
  return [
    cone('FL_upper', f.upper, f.lower, 0.22, 0.18, { blend: 0.12, part: 'body' }),
    cone('FL_lower', [0.39, 0.75, 0.71], [0.37, 0.32, 0.8], 0.17, 0.13, { blend: 0.06, part: 'leg', region: 'FL' }),
    // fold ring around the "knee"
    ellipsoid('FL_lower', [0.375, 0.42, 0.78], [0.15, 0.06, 0.14], { blend: 0.05, part: 'leg', region: 'FL' }),
    cone('FL_foot', [0.37, 0.34, 0.8], [0.37, 0.12, 0.84], 0.125, 0.14, { blend: 0.05, part: 'leg', region: 'FL' }),
    ellipsoid('FL_toe', [0.37, 0.08, 0.86], [0.15, 0.09, 0.15], { blend: 0.04, part: 'foot', region: 'FL' }),
    ...nails('FL_toe', 0.37, 0.87, 1, 'FL'),
    roundBox('FL_toe', [0.37, -0.08, 0.87], [0.3, 0.08, 0.3], 0.01, { sub: true, blend: 0.015, part: 'foot', region: 'FL' }),
    cone('HL_upper', h.upper, h.lower, 0.25, 0.18, { blend: 0.12, part: 'body' }),
    cone('HL_lower', [0.42, 0.78, -0.63], [0.37, 0.4, -1.0], 0.17, 0.12, { blend: 0.06, part: 'leg', region: 'HL' }),
    ellipsoid('HL_foot', [0.37, 0.4, -1.03], [0.1, 0.1, 0.1], { blend: 0.05, part: 'leg', region: 'HL' }),
    cone('HL_foot', [0.37, 0.38, -1.0], [0.37, 0.12, -0.95], 0.115, 0.135, { blend: 0.05, part: 'leg', region: 'HL' }),
    ellipsoid('HL_toe', [0.37, 0.08, -0.92], [0.14, 0.09, 0.15], { blend: 0.04, part: 'foot', region: 'HL' }),
    ...nails('HL_toe', 0.37, -0.91, 1, 'HL'),
    roundBox('HL_toe', [0.37, -0.08, -0.92], [0.3, 0.08, 0.3], 0.01, { sub: true, blend: 0.015, part: 'foot', region: 'HL' }),
  ];
}

function tailPrims(): Prim[] {
  const t = J.tail;
  return [
    cone('tail_1', [0, 1.44, -1.26], t[1], 0.06, 0.035, { blend: 0.06, part: 'tail' }),
    cone('tail_2', t[1], t[2], 0.035, 0.026, { blend: 0.02, part: 'tail', region: 'tail' }),
    cone('tail_3', t[2], [0, 0.86, -1.42], 0.026, 0.02, { blend: 0.02, part: 'tail', region: 'tail' }),
    ellipsoid('tail_3', [0, 0.8, -1.42], [0.022, 0.08, 0.05], {
      blend: 0.02,
      part: 'tuft',
      region: 'tail',
      noise: { amp: 0.01, freq: 45, stretch: [1, 0.15, 1], ridged: true, seed: 82 },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Coat: slate grey-brown hide, dusty / muddy below, darker crease lines on
// the folds, around the legs and on the neck; keratin horns.

const SKIN = 0x5f584f;
const TOP = 0x6f675b;
const MUD = 0x5f4f3e;
const HORN = 0x4b4238;
const HORN_TIP = 0x6f665a;

// fold lines (segments) for crease stripes: [a, b]
const FOLDS: [Vec3, Vec3][] = [
  [[0.54, 1.5, 0.32], [0.64, 0.86, 0.36]],
  [[0.56, 1.32, -0.47], [0.55, 0.74, -0.45]],
  [[0.3, 1.25, 1.12], [0.32, 0.85, 1.05]],
  [[0.22, 1.05, -1.2], [0.42, 0.75, -1.05]],
];

function rhinoCoat(eye: Vec3) {
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    const ax = Math.abs(x);
    const n = fbm(x * 1.8, y * 1.8, z * 1.8, 3, 91);
    c.color.setHex(SKIN);
    blendHex(c.color, TOP, clamp01(smooth(0.3, 0.95, c.ny) * 0.6 + n * 0.3));
    blendHex(c.color, MUD, clamp01(smooth(0.7 + n * 0.25, 0.15, y) * 0.55));
    blendHex(c.color, 0x544e47, smooth(-0.3, -0.9, c.ny) * 0.35);
    c.color2.copy(c.color).multiplyScalar(0.55);
    c.w = 0;
    // crease lines: nearest fold
    let best = 1e3;
    for (const [a, b] of FOLDS) {
      const d = segDist(ax, y, z, a, b).d;
      if (d < best) best = d;
    }
    const legK = clamp01((c.pw('leg') + c.pw('foot')) * 1.3);
    if (best < 0.07) {
      // a single soft crease line along each skin fold (no parallel echoes)
      c.s = best / 0.09 + n * 0.12;
      c.w = 0.13 * smooth(0.07, 0.025, best);
      c.color2.copy(c.color).multiplyScalar(0.68);
    } else if (legK > 0.3 && y < 0.75) {
      c.s = y / 0.09 + n * 0.9 + fbm(x * 7, y * 7, z * 7, 2, 92) * 0.4;
      c.w = 0.08 * smooth(0.3, 0.7, legK);
    } else if (c.part === 'neck' && y < 1.25 && z > 0.9) {
      c.s = (z - 0.9) / 0.08 + n;
      c.w = 0.14 * smooth(1.25, 1.0, y);
    }
    if (c.pw('fold') > 0.2) blendHex(c.color, 0x3e3933, 0.5);
    // horns: dark keratin, worn paler towards the tip
    if (c.part === 'horn') {
      c.color.setHex(HORN);
      blendHex(c.color, HORN_TIP, smooth(1.4, 1.9, y) * 0.6 + n * 0.15);
      c.w = 0;
      c.gloss = 0.5;
      return;
    }
    // lip: slightly paler, nostrils / mouth line dark
    if (c.pd('mouth') < 0.025) blendHex(c.color, 0x3b302b, smooth(0.025, 0.005, c.pd('mouth')) * 0.85);
    // big mud / dust patches
    const mudP = smooth(0.05, 0.35, fbm(x * 1.4 + 3, y * 1.4, z * 1.4, 2, 93));
    blendHex(c.color, MUD, mudP * 0.35);
    const lip = c.pw('lip');
    if (lip > 0.3) blendHex(c.color, 0x80786d, smooth(0.3, 0.7, lip) * 0.4);
    // eye: dark lid ring
    const ex = ax - eye[0], ey = y - eye[1], ez = z - eye[2];
    const ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (ed < 0.05) blendHex(c.color, 0x2f2a26, smooth(0.05, 0.026, ed) * 0.8);
    if (c.part === 'nail') {
      c.color.setHex(0x524a40);
      c.w = 0;
    }
    if (y < 0.025) blendHex(c.color, 0x36312c, 0.6);
    if (c.part === 'fringe' || c.part === 'tuft') {
      blendHex(c.color, 0x2a2420, 0.8);
      c.fur = 3;
      c.w = 0;
    }
  };
}

// ---------------------------------------------------------------------------
// Animation

function makeDriver(height: number, walkSpeed: number, runSpeed: number) {
  const p = quadParams(height, walkSpeed, runSpeed, {
    walk: {
      stride: 1.55, refSpeed: walkSpeed, duty: 0.64, offsets: [0.25, 0.75, 0, 0.5], stepHeight: 0.13,
      bob: 0.02, bobFreq: 2, pitch: 0.012, roll: 0.03, headBob: 0.06, spineFlex: 0,
    },
    trot: {
      stride: 2.3, refSpeed: walkSpeed * 2.4, duty: 0.44, offsets: [0.5, 1.0, 0, 0.5], stepHeight: 0.17,
      bob: 0.03, bobFreq: 2, pitch: 0.02, roll: 0.02, headBob: 0.05, spineFlex: 0,
    },
    gallop: {
      stride: 3.6, refSpeed: runSpeed, duty: 0.32, offsets: [0.48, 0.58, 0, 0.1], stepHeight: 0.22,
      bob: 0.05, bobFreq: 1, pitch: 0.07, roll: 0.01, headBob: 0.08, spineFlex: 0.04,
    },
    footFollow: 0.4,
    frontFlex: 1.1,
    hindFlex: -0.6,
    frontToeCurl: 0.4,
    hindToeCurl: 0.4,
    push: 0.3,
    scapSwing: 0.3,
    lie: { hipsY: 0.78, chestY: 0.82, front: 'tuck', hindSplay: 0.1, headRest: 0.16 },
    grazeReach: 0.12,
    headCarry: 0.1,
    look: 0.35,
    tailSwish: 0.4,
    tailCarry: -0.6,
    earFlick: 0.8,
    callJaw: 0.18,
    callHead: -0.3,
    callDuration: 2.4,
    breath: 0.01,
    swimSink: 1.45,
  });
  const base = quadrupedDriver(p);
  const HEAD_LOW = 0.12;

  /** Rhino ears swivel independently and often (sound scanning). */
  const swivel = (ctx: AnimCtx, pose: Pose, back = 0): void => {
    const E = ctx.roles.ears;
    for (let i = 0; i < E.length; i++) {
      const s = i === 0 ? 1 : -1;
      const yaw = 0.9 * glance(ctx.time, 2.2, ctx.seed + 40 + i * 7);
      const flick = pulses(ctx.time, 2.1, ctx.seed + 50 + i, 0.2, 0.55);
      rotLocal(pose, E[i], 'y', s * (yaw * 0.7 + 0.3) - s * back * 0.8);
      rotLocal(pose, E[i], 'x', -0.15 + back * 0.6 + flick * 0.3);
      rotLocal(pose, E[i], 'z', -s * flick * 0.25);
    }
  };

  const idle = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    body(ctx, st, pose);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    lookAround(ctx, st, pose, 0.7);
    // head mostly low; now and then lift to sniff
    const sniff = pulses(ctx.time, 11, ctx.seed + 7, 2.5, 0.5);
    neckHead(ctx, pose, HEAD_LOW - 0.2 * sniff, 0, 0.05 - 0.12 * sniff, 0);
    tail(ctx, st, pose, 0, 1);
    swivel(ctx, pose);
  };

  const walk = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    body(ctx, st, pose);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    lookAround(ctx, st, pose, 0.5);
    neckHead(ctx, pose, HEAD_LOW * (1 - st.wg) - 0.1 * st.wg, 0, 0.04, 0);
    tail(ctx, st, pose, 0, 0.7);
    swivel(ctx, pose, 0.5 * st.wg);
  };

  // lawnmower grazing: lip on the ground, slow side-to-side sweeps
  const eat = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    actEat(ctx, st, pose);
    const sweep = Math.sin(ctx.time * 0.7 + ctx.seed);
    neckHead(ctx, pose, 0, 0.25 * sweep, 0, 0.12 * sweep);
    swivel(ctx, pose);
  };

  const drink = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    actDrink(ctx, st, pose);
    swivel(ctx, pose, 0.2);
  };

  const call = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    body(ctx, st, pose, 0);
    const R = ctx.roles;
    const at = ctx.actionTime;
    const env = envelope(at, 0, 0.35, p.callDuration - 0.5, p.callDuration);
    const snort = Math.max(0, Math.sin(at * TAU * 1.8)) * env;
    pose.p[R.root].y -= 0.015 * snort;
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    neckHead(ctx, pose, -0.3 * env + 0.06 * snort, 0, -0.18 * env - 0.08 * snort, 0);
    jaw(ctx, pose, 0.14 * env + 0.06 * snort);
    tail(ctx, st, pose, -0.8 * env, 0.4);
    swivel(ctx, pose, 0.8 * env);
  };

  // play: tossing the horn up and sideways, little bucks
  const play = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    const R = ctx.roles;
    const t = ctx.time;
    body(ctx, st, pose, 0);
    const hop = Math.max(0, Math.sin(t * TAU * 1.1));
    pose.p[R.root].y += 0.035 * hop;
    rotParent(pose, R.root, 'x', -0.05 * Math.sin(t * TAU * 1.1 + 0.6));
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const toss = Math.sin(t * TAU * 0.8);
    neckHead(ctx, pose, 0.1 - 0.35 * Math.max(0, toss), 0.35 * Math.sin(t * 1.3), -0.2 * toss, 0.15 * Math.sin(t * 2.1));
    tail(ctx, st, pose, -0.9, 1.2);
    swivel(ctx, pose, 0.4 * hop);
  };

  // social: low head, nose-to-nose (horn touching) greeting
  const social = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    body(ctx, st, pose, 0);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const t = ctx.time;
    const side = ctx.rand > 0.5 ? 1 : -1;
    const nudge = Math.sin(t * TAU * 0.4);
    neckHead(ctx, pose, 0.2 + 0.08 * nudge, side * 0.3, -0.12 + 0.05 * nudge, side * 0.12, side * 0.08 * nudge);
    jaw(ctx, pose, 0.03 * Math.max(0, Math.sin(t * TAU * 1.5)));
    tail(ctx, st, pose, 0, 0.8);
    swivel(ctx, pose, 0.2);
  };

  // lying: sternal, legs tucked, chin on the ground when asleep
  const sleep = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    lie(ctx, st, pose, 'down');
    const R = ctx.roles;
    rotParent(pose, R.root, 'z', 0.06);
    ctx.rig.fk(pose);
    reachMuzzle(ctx, pose, 0.12, 0.1, 0.15 * Math.sin(ctx.seed));
    swivel(ctx, pose, 0.3);
  };
  // resting awake: head low but the chin clear of the ground and the nose
  // level, so the long front horn points forward instead of into the ground
  const rest = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    lie(ctx, st, pose, 'up');
    ctx.rig.fk(pose);
    reachMuzzle(ctx, pose, 0.3, -0.3, 0.12 * Math.sin(ctx.time * 0.21 + ctx.seed));
    swivel(ctx, pose);
  };

  // tail curls up when trotting / alarmed
  const run = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    walk(ctx, st, pose);
    const T = ctx.roles.tail;
    for (let i = 0; i < T.length; i++) rotLocal(pose, T[i], 'x', -0.5 * st.wt);
  };

  return {
    ...base,
    actions: { ...base.actions, idle, walk: run, eat, drink, call, play, social, sleep, rest, sit: rest },
    fade: 0.45,
    fades: { sleep: 1.6, rest: 1.4, sit: 1.4 },
    transitions: { 'sleep>*': 1.7, 'rest>*': 1.5, 'sit>*': 1.5, 'sleep>rest': 1.2, 'rest>sleep': 1.2 },
  };
}

// ---------------------------------------------------------------------------

function design(ctx: DesignContext): CreatureDesign {
  const male = ctx.sex === 'M';
  const sk = quadSkeleton(J);
  const head = withRegion(transformPrims(headPrims(), HEAD_T), 'head');
  const prims: Prim[] = [
    ...bodyPrims(),
    ...foldPrims(),
    ...head,
    ...transformPrims(hornPrims(male), HEAD_T),
    ...transformPrims(earPrims(), HEAD_T),
    ...legPrimsLeft(),
    ...mirrorX(legPrimsLeft()),
    ...tailPrims(),
  ];
  const eyeDir: Vec3 = [-1, 0.1, -0.2];
  const hit = surfacePoint(head, H(hp(0.42, 0.0, 0.6)), eyeDir, 0.8);
  const eye = seat(hit, eyeDir, 0.008);
  return {
    bones: sk.bones,
    roles: sk.roles,
    prims,
    resolution: 0.88,
    regions: {
      head: { scale: 0.52 },
      horns: { scale: 0.38, aniso: [1, 1.5, 1] },
      ears: { scale: 0.34 },
      FL: { scale: 0.68, aniso: [1, 1.4, 1] },
      FR: { scale: 0.68, aniso: [1, 1.4, 1] },
      HL: { scale: 0.68, aniso: [1, 1.4, 1] },
      HR: { scale: 0.68, aniso: [1, 1.4, 1] },
      tail: { scale: 0.34, aniso: [1, 2, 1] },
    },
    coat: rhinoCoat(eye),
    look: { skin: 'wrinkled', pattern: 'stripes', roughness: 0.9, sheen: 0.05, grain: 0.014, bump: 0.5, mottle: 0.18 },
    eyes: [{ bone: 'head', pos: eye, radius: 0.018, color: 0x1e140c }],
    anim: driver(makeDriver(ctx.def.height, ctx.def.walkSpeed, ctx.def.runSpeed)),
    babyScale: 0.3,
    babyHead: 1.2,
    height: 1.95,
    radius: 0.9,
  };
}

const rhino: SpeciesModel = {
  id: 'rhino',
  dimorphic: true,
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.03 : 0.93) * (0.97 + r * 0.06),
};
export default rhino;
