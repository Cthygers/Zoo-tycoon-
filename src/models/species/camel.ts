// Dromedary camel (Camelus dromedarius). Single fatty hump, long S-curved
// neck (down from the withers, then up to the head), a long head with heavy
// brows, a split upper lip and a drooping lower lip, long slim legs with
// knobbly knees, hairless calluses (chest pad, elbows, knees, stifles) and
// broad padded two-toed feet. Sandy coat, woollier on the hump, shoulders and
// (bulls) the throat.
//
// Animation: pacing walk / rack (same-side legs together, with the typical
// side-to-side sway and neck nod), a rotary gallop, cud chewing with a lateral
// jaw, kushing — dropping onto the front knees first, then folding the hind
// legs and settling on the chest pad; getting up rear-first — for sleep / rest
// / sit, a grumbling bellow with lip flapping as the call.

import * as THREE from 'three';
import { cone, ellipsoid, mirrorX, roundBox, symmetric, type Prim, type Vec3 } from '../sdf/prims';
import { quadSkeleton, seat, surfacePoint, withRegion, type QuadJoints } from '../kit/quadruped';
import {
  actDrink,
  actEat,
  advanceGait,
  body,
  ears,
  initQuad,
  jaw,
  legs as legsBlock,
  lie,
  lookAround,
  neckHead,
  placeLeg,
  plantLeg,
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
import { Posture, blendInto, envelope, lerpV, riseOverlay, updatePosture } from './species-large-herbivores/common';

// ---------------------------------------------------------------------------
// Proportions (shoulder 1.9 m, hump top ≈ 2.2 m)

const N: Vec3[] = [
  [0, 1.62, 0.82],
  [0, 1.47, 1.18],
  [0, 1.56, 1.5],
  [0, 1.84, 1.71],
];
const POLL: Vec3 = [0, 2.1, 1.8];
const HA = 0.2;
const HD: Vec3 = [0, -Math.sin(HA), Math.cos(HA)];
const HUP: Vec3 = [0, Math.cos(HA), Math.sin(HA)];
const hp = (t: number, u = 0, x = 0): Vec3 => [x, POLL[1] + HD[1] * t + HUP[1] * u, POLL[2] + HD[2] * t + HUP[2] * u];

const J: QuadJoints = {
  hips: [0, 1.52, -0.74],
  spine: [
    [0, 1.62, -0.3],
    [0, 1.7, 0.12],
  ],
  chest: [0, 1.62, 0.52],
  neck: N,
  head: POLL,
  jaw: hp(0.14, -0.1),
  ear: [0.07, 2.17, 1.76],
  tail: [
    [0, 1.6, -1.04],
    [0, 1.4, -1.12],
    [0, 1.18, -1.15],
  ],
  front: {
    scap: [0.2, 1.75, 0.5],
    upper: [0.24, 1.38, 0.72],
    lower: [0.24, 1.08, 0.5],
    foot: [0.22, 0.58, 0.62],
    toe: [0.22, 0.15, 0.64],
    contact: [0.22, 0, 0.72],
  },
  hind: {
    upper: [0.22, 1.5, -0.72],
    lower: [0.26, 1.0, -0.42],
    foot: [0.21, 0.62, -0.85],
    toe: [0.21, 0.15, -0.8],
    contact: [0.21, 0, -0.74],
  },
  muzzle: hp(0.56, -0.08),
};

// ---------------------------------------------------------------------------
// Sculpt

function bodyPrims(male: boolean): Prim[] {
  const g = male ? 1 : 0.95;
  return [
    ellipsoid('chest', [0, 1.45, 0.52], [0.3 * g, 0.38, 0.36], { blend: 0.12, part: 'body' }),
    ellipsoid('chest', [0, 1.77, 0.45], [0.16 * g, 0.12, 0.28], { blend: 0.12, part: 'body' }),
    // sternal callus pad under the chest (rests on it when kushed)
    ellipsoid('chest', [0, 1.1, 0.6], [0.15, 0.07, 0.17], { blend: 0.1, part: 'callus' }),
    ellipsoid('spine_2', [0, 1.5, 0.05], [0.34 * g, 0.36, 0.48], { blend: 0.13, part: 'body' }),
    ellipsoid('spine_1', [0, 1.6, -0.45], [0.27 * g, 0.24, 0.38], { blend: 0.13, part: 'belly' }),
    ellipsoid('hips', [0, 1.6, -0.78], [0.26 * g, 0.24, 0.3], { blend: 0.12, part: 'body' }),
    // the hump: a single fatty dome over the middle of the back
    ellipsoid('spine_2', [0, 1.9, -0.03], [0.27 * g, 0.33, 0.44], { blend: 0.2, part: 'hump' }),
    ...symmetric([
      ellipsoid('FL_scap', [0.21, 1.5, 0.56], [0.1, 0.3, 0.18], { rot: [-0.3, 0, 0], blend: 0.1, part: 'body' }),
      ellipsoid('HL_upper', [0.19, 1.47, -0.7], [0.11, 0.24, 0.17], { blend: 0.1, part: 'body' }),
    ]),
  ];
}

function neckPrims(male: boolean): Prim[] {
  const g = male ? 1.06 : 0.96;
  const pts: Vec3[] = [[0, 1.66, 0.6], N[1], N[2], N[3], POLL];
  const bones = ['neck_1', 'neck_2', 'neck_3', 'neck_4'];
  const depth = [0.27, 0.17, 0.14, 0.12, 0.1];
  const width = [0.2, 0.12, 0.1, 0.09, 0.085];
  const P: Prim[] = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[i + 1];
    const ang = Math.atan2(b[1] - a[1], b[2] - a[2]);
    const len = Math.hypot(b[1] - a[1], b[2] - a[2]);
    P.push(
      ellipsoid(bones[i], lerpV(a, b, 0.5), [((width[i] + width[i + 1]) / 2) * g, ((depth[i] + depth[i + 1]) / 2) * g, len * 0.68], {
        rot: [-ang, 0, 0],
        blend: 0.1,
        part: 'neck',
      }),
    );
  }
  // woolly throat fringe on bulls
  if (male) {
    P.push(
      ellipsoid('neck_2', [0, 1.37, 1.3], [0.08, 0.06, 0.2], {
        rot: [-0.2, 0, 0],
        blend: 0.06,
        part: 'wool',
        region: 'wool',
        noise: { amp: 0.015, freq: 30, stretch: [1, 0.25, 1], ridged: true, octaves: 2, seed: 121 },
      }),
    );
  }
  return P;
}

function headPrims(): Prim[] {
  return [
    ellipsoid('head', hp(0.1, 0.02), [0.1, 0.1, 0.13], { rot: [HA, 0, 0], blend: 0.05, part: 'head' }),
    ellipsoid('head', hp(0.28, -0.01), [0.085, 0.09, 0.16], { rot: [HA, 0, 0], blend: 0.05, part: 'head' }),
    ellipsoid('head', hp(0.45, -0.035), [0.07, 0.083, 0.1], { rot: [HA, 0, 0], blend: 0.045, part: 'muzzle' }),
    // split upper lip
    ...symmetric([ellipsoid('head', hp(0.53, -0.07, 0.028), [0.042, 0.048, 0.05], { rot: [HA, 0, 0], blend: 0.03, part: 'muzzle' })]),
    // jaw + drooping lower lip
    ellipsoid('jaw', hp(0.3, -0.11), [0.065, 0.05, 0.18], { rot: [HA, 0, 0], blend: 0.04, part: 'head' }),
    ellipsoid('jaw', hp(0.49, -0.135), [0.048, 0.034, 0.07], { rot: [HA + 0.15, 0, 0], blend: 0.03, part: 'lip' }),
    // heavy brows
    ...symmetric([ellipsoid('head', hp(0.17, 0.065, 0.07), [0.045, 0.032, 0.05], { blend: 0.035, part: 'head' })]),
    // lip split, mouth line and slit nostrils
    ellipsoid('head', hp(0.56, -0.09), [0.006, 0.04, 0.03], { sub: true, blend: 0.006, part: 'muzzle' }),
    ellipsoid('head', hp(0.5, -0.115), [0.06, 0.006, 0.07], { rot: [HA, 0, 0], sub: true, blend: 0.008, part: 'muzzle' }),
    ...symmetric([ellipsoid('head', hp(0.5, 0.025, 0.035), [0.006, 0.012, 0.03], { rot: [HA, 0.5, 0], sub: true, blend: 0.006, part: 'muzzle' })]),
  ];
}

function earPrims(): Prim[] {
  const left: Prim[] = [
    ellipsoid('ear.L', [0.085, 2.21, 1.75], [0.03, 0.05, 0.018], { rot: [-0.3, 0.4, -0.35], blend: 0.02, part: 'ear', region: 'ears' }),
    ellipsoid('ear.L', [0.088, 2.215, 1.757], [0.019, 0.035, 0.01], { rot: [-0.3, 0.4, -0.35], sub: true, blend: 0.005, part: 'ear', region: 'ears' }),
  ];
  return [...left, ...mirrorX(left)];
}

function legPrimsLeft(): Prim[] {
  const f = J.front, h = J.hind;
  const foot = (bone: string, cx: number, cz: number, region: string): Prim[] => [
    ellipsoid(bone, [cx, 0.048, cz], [0.088, 0.05, 0.115], { blend: 0.04, part: 'pad', region }),
    ...[-1, 1].map((s) => ellipsoid(bone, [cx + s * 0.04, 0.045, cz + 0.085], [0.04, 0.036, 0.045], { blend: 0.03, part: 'pad', region })),
    ...[-1, 1].map((s) => ellipsoid(bone, [cx + s * 0.04, 0.042, cz + 0.125], [0.02, 0.017, 0.02], { blend: 0.012, part: 'nail', region })),
    roundBox(bone, [cx, -0.06, cz], [0.2, 0.06, 0.25], 0.01, { sub: true, blend: 0.012, part: 'pad', region }),
  ];
  return [
    // front: shoulder, free elbow with callus, long forearm, knobbly calloused knee, cannon, fetlock, pad
    cone('FL_upper', f.upper, f.lower, 0.11, 0.085, { blend: 0.08, part: 'body' }),
    ellipsoid('FL_upper', [0.245, 1.04, 0.46], [0.055, 0.05, 0.06], { blend: 0.04, part: 'callus' }),
    cone('FL_lower', [0.24, 1.08, 0.5], [0.22, 0.6, 0.62], 0.072, 0.05, { blend: 0.04, part: 'leg', region: 'FL' }),
    ellipsoid('FL_lower', [0.222, 0.585, 0.645], [0.055, 0.065, 0.058], { blend: 0.03, part: 'callus', region: 'FL' }),
    cone('FL_foot', [0.22, 0.56, 0.62], [0.22, 0.17, 0.645], 0.045, 0.038, { blend: 0.03, part: 'leg', region: 'FL' }),
    ellipsoid('FL_toe', [0.22, 0.14, 0.655], [0.048, 0.05, 0.055], { blend: 0.03, part: 'leg', region: 'FL' }),
    cone('FL_toe', [0.22, 0.13, 0.67], [0.22, 0.07, 0.72], 0.045, 0.06, { blend: 0.03, part: 'leg', region: 'FL' }),
    ...foot('FL_toe', 0.22, 0.75, 'FL'),
    // hind: long thigh, low stifle with callus, gaskin, hock, cannon, pad
    cone('HL_upper', h.upper, h.lower, 0.12, 0.085, { blend: 0.08, part: 'body' }),
    ellipsoid('HL_lower', [0.27, 0.98, -0.385], [0.05, 0.05, 0.05], { blend: 0.035, part: 'callus' }),
    cone('HL_lower', [0.26, 1.0, -0.43], [0.21, 0.63, -0.85], 0.075, 0.05, { blend: 0.04, part: 'leg', region: 'HL' }),
    ellipsoid('HL_foot', [0.21, 0.62, -0.875], [0.042, 0.06, 0.055], { blend: 0.03, part: 'leg', region: 'HL' }),
    cone('HL_foot', [0.21, 0.6, -0.85], [0.21, 0.17, -0.8], 0.045, 0.038, { blend: 0.03, part: 'leg', region: 'HL' }),
    ellipsoid('HL_toe', [0.21, 0.14, -0.795], [0.048, 0.05, 0.055], { blend: 0.03, part: 'leg', region: 'HL' }),
    cone('HL_toe', [0.21, 0.13, -0.78], [0.21, 0.07, -0.73], 0.045, 0.058, { blend: 0.03, part: 'leg', region: 'HL' }),
    ...foot('HL_toe', 0.21, -0.71, 'HL'),
  ];
}

function tailPrims(): Prim[] {
  const t = J.tail;
  return [
    cone('tail_1', [0, 1.6, -1.0], t[1], 0.045, 0.028, { blend: 0.05, part: 'tail' }),
    cone('tail_2', t[1], t[2], 0.028, 0.02, { blend: 0.02, part: 'tail', region: 'tail' }),
    cone('tail_3', t[2], [0, 1.02, -1.15], 0.02, 0.017, { blend: 0.02, part: 'tail', region: 'tail' }),
    ellipsoid('tail_3', [0, 0.95, -1.15], [0.03, 0.1, 0.025], {
      blend: 0.02,
      part: 'tuft',
      region: 'tail',
      noise: { amp: 0.01, freq: 45, stretch: [1, 0.15, 1], ridged: true, seed: 122 },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Coat

const SAND = 0x9e7a4f;
const BACK = 0x8b6842;
const PALE = 0xb79b74;
const WOOL = 0x7a5636;
const CALLUS = 0x5b4b3d;
const PAD = 0x4b3f35;

function camelCoat(eye: Vec3) {
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    const ax = Math.abs(x);
    const n = fbm(x * 2.5, y * 2.5, z * 2.5, 3, 123);
    c.color.setHex(SAND);
    blendHex(c.color, BACK, clamp01(smooth(0.3, 0.95, c.ny) * 0.55 + n * 0.25));
    blendHex(c.color, PALE, clamp01(smooth(-0.1, -0.8, c.ny) * 0.6 + clamp01((c.pw('leg') + c.pw('pad')) * 1.3) * smooth(1.0, 0.3, y) * 0.5));
    // woolly hump top, shoulders and (bulls) throat
    const wool = clamp01(c.pw('hump') * smooth(0.2, 0.8, c.ny) + smooth(1.72, 1.85, y) * smooth(0.25, 0.75, z) * smooth(0.0, 0.6, c.ny) + c.pw('wool'));
    if (wool > 0.05) {
      blendHex(c.color, WOOL, wool * 0.55);
      c.fur = 1 + 2.2 * wool;
    }
    // muzzle: greyish, darker lips
    const mz = c.pw('muzzle') + c.pw('lip');
    blendHex(c.color, 0x9c876d, smooth(0.3, 0.7, mz) * 0.6);
    if (mz > 0.4 && c.ny < -0.3) blendHex(c.color, 0x4a3b30, smooth(-0.3, -0.8, c.ny) * 0.5);
    // eye: dark lids and long lashes
    const ex = ax - eye[0], ey = y - eye[1], ez = z - eye[2];
    const ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (ed < 0.04) blendHex(c.color, 0x2c1f16, smooth(0.04, 0.024, ed) * 0.85);
    // ears: darker rims
    if (c.part === 'ear') blendHex(c.color, 0x6b5036, 0.4);
    // calluses, pads, nails
    const cal = c.pw('callus');
    if (cal > 0.25) {
      blendHex(c.color, CALLUS, smooth(0.25, 0.6, cal));
      c.fur = 0.3;
    }
    if (c.part === 'pad') {
      blendHex(c.color, 0x8f7454, 0.4);
      blendHex(c.color, PAD, smooth(0.07, 0.015, y) * 0.85);
    }
    if (c.part === 'nail') c.color.setHex(0x3a322b);
    // tail tuft
    if (c.pw('tuft') > 0.15) {
      blendHex(c.color, 0x3e2e20, smooth(0.15, 0.5, c.pw('tuft')));
      c.fur = 3;
    }
    // dusty feet
    blendHex(c.color, 0xa88c68, smooth(0.25, 0.0, y) * 0.3);
  };
}

// ---------------------------------------------------------------------------
// Animation

interface CamelExtra {
  ps: Posture;
  st2: Pose;
}
type CS = QuadState & CamelExtra;

const _A = new THREE.Vector3();
const _C = new THREE.Vector3();

function makeDriver(height: number, walkSpeed: number, runSpeed: number) {
  const p = quadParams(height, walkSpeed, runSpeed, {
    // pace: lateral pairs together → the camel's rolling side-to-side sway
    walk: {
      stride: 2.15, refSpeed: walkSpeed, duty: 0.63, offsets: [0.04, 0.54, 0, 0.5], stepHeight: 0.15,
      bob: 0.025, bobFreq: 2, pitch: 0.01, roll: 0.06, headBob: 0.07, spineFlex: 0,
    },
    trot: {
      stride: 3.1, refSpeed: walkSpeed * 2.2, duty: 0.45, offsets: [0.04, 0.54, 0, 0.5], stepHeight: 0.2,
      bob: 0.035, bobFreq: 2, pitch: 0.01, roll: 0.05, headBob: 0.06, spineFlex: 0,
    },
    gallop: {
      stride: 4.2, refSpeed: runSpeed, duty: 0.3, offsets: [0.55, 0.45, 0, 0.1], stepHeight: 0.26,
      bob: 0.06, bobFreq: 1, pitch: 0.07, roll: 0.01, headBob: 0.12, spineFlex: 0.03,
    },
    footFollow: 0.6,
    frontFlex: 1.3,
    hindFlex: -0.7,
    frontToeCurl: 0.5,
    hindToeCurl: 0.5,
    push: 0.4,
    scapSwing: 0.25,
    lie: { hipsY: 0.6, chestY: 0.72, front: 'tuck', hindSplay: 0.07, headRest: 0.12 },
    grazeReach: 0.3,
    headCarry: 0.15,
    look: 0.5,
    tailSwish: 0.45,
    tailCarry: -0.3,
    earFlick: 0.6,
    callJaw: 0.32,
    callHead: -0.35,
    callDuration: 2.8,
    breath: 0.01,
    swimSink: 1.5,
  });
  const base = quadrupedDriver(p);

  /** Rumination: lateral grinding jaw. */
  const ruminate = (ctx: AnimCtx, pose: Pose, k: number): void => {
    if (k <= 0) return;
    const t = ctx.time * TAU * 1.25;
    jaw(ctx, pose, k * (0.035 + 0.03 * Math.max(0, Math.sin(t))));
    rotLocal(pose, ctx.roles.jaw, 'y', k * 0.06 * Math.sin(t));
  };

  const idle = (ctx: AnimCtx, st: CS, pose: Pose): void => {
    body(ctx, st, pose);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    lookAround(ctx, st, pose, 1);
    // head held high and proud now and then
    const proud = pulses(ctx.time, 12, ctx.seed + 5, 3.5, 0.5);
    neckHead(ctx, pose, -0.15 * proud, 0, 0.05 * proud, 0);
    ruminate(ctx, pose, pulses(ctx.time, 9, ctx.seed + 6, 6, 0.65));
    tail(ctx, st, pose, 0, 1);
    ears(ctx, st, pose);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  const walk = (ctx: AnimCtx, st: CS, pose: Pose): void => {
    body(ctx, st, pose);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    lookAround(ctx, st, pose, 0.5);
    // neck nods with each step of the pace, stretches out at the gallop
    const nod = Math.sin(st.phase * TAU * 2 - 0.6) * st.amp * (1 - st.wg);
    neckHead(ctx, pose, 0.06 * nod + 0.2 * st.wg, 0, -0.05 * nod - 0.1 * st.wg, 0);
    tail(ctx, st, pose, 0, 0.7);
    ears(ctx, st, pose, 0.4 * st.wg);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  const eat = (ctx: AnimCtx, st: CS, pose: Pose): void => {
    actEat(ctx, st, pose);
    rotLocal(pose, ctx.roles.jaw, 'y', 0.05 * Math.sin(ctx.time * TAU * 1.3));
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  const drink = (ctx: AnimCtx, st: CS, pose: Pose): void => {
    actDrink(ctx, st, pose);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  // grumbling bellow: head up, mouth gaping, lips flapping
  const call = (ctx: AnimCtx, st: CS, pose: Pose): void => {
    body(ctx, st, pose, 0);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const at = ctx.actionTime;
    const env = envelope(at, 0, 0.45, p.callDuration - 0.6, p.callDuration);
    const gurgle = 0.5 + 0.5 * Math.sin(at * TAU * 4.2) * Math.sin(at * TAU * 0.9);
    neckHead(ctx, pose, -0.3 * env, 0.1 * Math.sin(at * 2.2) * env, -0.3 * env, 0);
    jaw(ctx, pose, p.callJaw * env * (0.6 + 0.4 * gurgle));
    rotLocal(pose, ctx.roles.jaw, 'y', 0.06 * env * Math.sin(at * TAU * 2.3));
    tail(ctx, st, pose, -0.5 * env, 1.2);
    ears(ctx, st, pose, 0.8 * env);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  const play = (ctx: AnimCtx, st: CS, pose: Pose): void => {
    const R = ctx.roles;
    const t = ctx.time;
    body(ctx, st, pose, 0);
    const buck = Math.max(0, Math.sin(t * TAU * 1.2));
    pose.p[R.root].y += 0.05 * buck;
    rotParent(pose, R.root, 'x', 0.06 * Math.sin(t * TAU * 1.2 + 1.0));
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const shake = Math.sin(t * TAU * 1.6);
    neckHead(ctx, pose, -0.1 + 0.15 * Math.sin(t * TAU * 0.6), 0.35 * shake, 0.1, 0.15 * shake, 0.12 * shake);
    tail(ctx, st, pose, -0.6, 1.5);
    ears(ctx, st, pose, 0.4);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  const social = (ctx: AnimCtx, st: CS, pose: Pose): void => {
    body(ctx, st, pose, 0);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const t = ctx.time;
    const side = ctx.rand > 0.5 ? 1 : -1;
    neckHead(ctx, pose, 0.25 + 0.06 * Math.sin(t * 1.4), side * 0.55, 0.1, side * 0.2, side * 0.1);
    ruminate(ctx, pose, 0.6);
    tail(ctx, st, pose, 0, 0.8);
    ears(ctx, st, pose);
    riseOverlay(ctx, st, st.ps, pose, lying);
  };

  /**
   * Kushing continuum: 0 standing → 0.45 kneeling on the front knees (rear
   * still up) → 1 couched on the chest pad with all legs folded under.
   * Getting up runs it backwards: rear first, then the front.
   */
  function lying(ctx: AnimCtx, st: CS, pose: Pose, down: number, rising: boolean): void {
    void rising;
    const R = ctx.roles;
    const rig = ctx.rig;
    const k1 = smooth(0.0, 0.45, down);
    const k2 = smooth(0.42, 1.0, down);
    pose.reset();
    const chestDrop = 0.62 * k1;
    rotParent(pose, R.root, 'x', Math.atan2(chestDrop, st.chestZ - st.hipsZ));
    body(ctx, st, pose, 0);
    rig.fk(pose);
    for (const leg of st.legs) {
      rig.fkBone(pose, leg.r.upper);
      const H = rig.wp[leg.r.upper];
      if (leg.front) {
        // knee goes down to the ground under the chest, cannon folds back
        _C.copy(leg.r.contact);
        _A.set(_C.x + (H.x - _C.x) * k1, 0.58 + (0.08 - 0.58) * k1, _C.z + (H.z + 0.08 - _C.z) * k1);
        placeLeg(ctx, st, pose, leg, _A, Math.PI * 0.52 * k1, Math.PI * 0.62 * k1);
      } else {
        _C.copy(leg.r.contact);
        _C.z += (H.z - _C.z) * 0.25 * k1;
        const slant = Math.atan2(H.z - _C.z, Math.max(0.05, H.y - _C.y));
        plantLeg(ctx, st, pose, leg, _C, slant * 0.6, 0);
      }
    }
    // neck swings up as the front drops (balance)
    neckHead(ctx, pose, -0.35 * k1 * (1 - k2), 0, 0.2 * k1 * (1 - k2), 0);
    tail(ctx, st, pose, 0.1, 0.4);
    if (k2 > 0) {
      const L = st.st2;
      L.reset();
      lie(ctx, st, L, 'up');
      L.q[R.head].identity();
      for (let i = 0; i < R.neck.length; i++) L.q[R.neck[i]].identity();
      neckHead(ctx, L, -0.15 + 0.05 * glance(ctx.time, 6, ctx.seed + 9), 0.3 * glance(ctx.time, 7, ctx.seed + 10), 0.12, 0);
      blendInto(pose, L, k2);
    }
  }

  const rest = (ctx: AnimCtx, st: CS, pose: Pose): void => {
    lying(ctx, st, pose, st.ps.down, false);
    ruminate(ctx, pose, smooth(0.9, 1.0, st.ps.down));
    ears(ctx, st, pose);
  };

  // sleep: couched, neck stretched forward with the chin on the ground
  const sleep = (ctx: AnimCtx, st: CS, pose: Pose): void => {
    lying(ctx, st, pose, st.ps.down, false);
    const k = smooth(0.85, 1.0, st.ps.down);
    if (k <= 0) return;
    const R = ctx.roles;
    const L = st.st2;
    L.copy(pose);
    ctx.rig.fk(L);
    reachMuzzle(ctx, L, 0.1, -0.15, 0.2 * Math.sin(ctx.seed), 2.4);
    rotLocal(L, R.chest, 'x', 0.012 * Math.sin(ctx.time * TAU * 0.16));
    blendInto(pose, L, k);
  };

  return {
    ...base,
    init: (ctx: AnimCtx): CS => {
      const st = initQuad(ctx, p) as CS;
      st.ps = new Posture(ctx.def.count);
      st.st2 = new Pose(ctx.def.count);
      return st;
    },
    pre: (ctx: AnimCtx, st: CS): void => {
      advanceGait(ctx, st);
      const a = ctx.action;
      updatePosture(ctx, st.ps, a === 'sleep' || a === 'rest' || a === 'sit', 3.0, 2.6);
    },
    actions: { ...base.actions, idle, walk, eat, drink, call, play, social, sleep, rest, sit: rest },
    fade: 0.45,
    fades: { sleep: 0.3, rest: 0.3, sit: 0.3 },
  };
}

// ---------------------------------------------------------------------------

function design(ctx: DesignContext): CreatureDesign {
  const male = ctx.sex === 'M';
  const sk = quadSkeleton(J);
  const head = withRegion(headPrims(), 'head');
  const prims: Prim[] = [
    ...bodyPrims(male),
    ...neckPrims(male),
    ...head,
    ...earPrims(),
    ...legPrimsLeft(),
    ...mirrorX(legPrimsLeft()),
    ...tailPrims(),
  ];
  const eyeDir: Vec3 = [-1, -0.1, -0.2];
  const e0 = hp(0.17, 0.02);
  const hit = surfacePoint(head, [0.4, e0[1], e0[2] + 0.04], eyeDir, 0.5);
  const eye = seat(hit, eyeDir, 0.01);
  return {
    bones: sk.bones,
    roles: sk.roles,
    prims,
    resolution: 1.1,
    regions: {
      head: { scale: 0.4 },
      ears: { scale: 0.14 },
      wool: { scale: 0.45 },
      FL: { scale: 0.42, aniso: [1, 2.0, 1] },
      FR: { scale: 0.42, aniso: [1, 2.0, 1] },
      HL: { scale: 0.42, aniso: [1, 2.0, 1] },
      HR: { scale: 0.42, aniso: [1, 2.0, 1] },
      tail: { scale: 0.25, aniso: [1, 2.2, 1] },
    },
    coat: camelCoat(eye),
    look: { skin: 'fur', pattern: 'none', roughness: 0.9, sheen: 0.35, grain: 0.008, bump: 0.32, mottle: 0.09 },
    eyes: [{ bone: 'head', pos: eye, radius: 0.022, color: 0x1e120a }],
    anim: driver(makeDriver(ctx.def.height, ctx.def.walkSpeed, ctx.def.runSpeed)),
    babyScale: 0.4,
    babyHead: 1.25,
    height: 2.25,
    radius: 0.75,
  };
}

const camel: SpeciesModel = {
  id: 'camel',
  dimorphic: true,
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.0 : 0.92) * (0.97 + r * 0.06),
};
export default camel;
