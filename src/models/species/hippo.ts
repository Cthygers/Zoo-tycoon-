// Hippopotamus (Hippopotamus amphibius). Huge barrel on short stumpy legs,
// a massive head with a broad boxy muzzle, eyes on raised turrets, small
// ears and nostrils all on top (so only they break the surface when it
// floats), a real mouth: upper head and lower jaw separated by a slit whose
// inner faces are pink gums / tongue, with canines and incisors that sit
// hidden in the slit at rest and grow out (per-bone scale) as the jaw opens.
// Smooth grey-mauve to pinkish-brown skin with pink undertones on the face,
// belly and in the folds; dark and glossy only for a while after a swim.
//
// Animation: short-stepping walk and trot, ear-twitching idle with the
// occasional "propeller" tail wag, grazing, a huge yawn as the call, open-
// mouth sparring as play, lying flat, and a floating swim pose showing only
// eyes, ears and nostrils.

import { cone, ellipsoid, mirrorX, roundBox, symmetric, type Prim, type Vec3 } from '../sdf/prims';
import { quadSkeleton, seat, surfacePoint, withRegion, type QuadJoints } from '../kit/quadruped';
import {
  actEat,
  actDrink,
  actSwim,
  advanceGait,
  body,
  ears,
  initQuad,
  jaw,
  legs as legsBlock,
  lie,
  lookAround,
  neckHead,
  quadParams,
  quadrupedDriver,
  tail,
  type QuadState,
} from '../anim/quadruped';
import { driver, glance, pulses, TAU } from '../anim/util';
import { Pose, rotLocal, rotParent } from '../rig/rig';
import { blendHex, clamp01, fbm, smooth } from '../coat/coat';
import type { AnimCtx, BoneSpec, CoatSample, CreatureDesign, DesignContext, SpeciesModel } from '../types';
import { bilateralBones, envelope } from './species-large-herbivores/common';

// ---------------------------------------------------------------------------
// Proportions (bull, shoulder 1.5 m)

const MOUTH_Y = 0.81; // centre of the closed mouth slit
const GAP = 0.017; // half-height of the slit

const J: QuadJoints = {
  hips: [0, 1.22, -1.05],
  spine: [
    [0, 1.28, -0.5],
    [0, 1.32, 0.05],
  ],
  chest: [0, 1.3, 0.6],
  neck: [[0, 1.22, 1.0]],
  head: [0, 1.25, 1.3],
  jaw: [0, 0.98, 1.42],
  ear: [0.17, 1.38, 1.3],
  tail: [
    [0, 1.12, -1.62],
    [0, 0.97, -1.73],
    [0, 0.82, -1.76],
  ],
  front: {
    scap: [0.42, 1.25, 0.65],
    upper: [0.5, 0.85, 0.92],
    lower: [0.48, 0.52, 0.8],
    foot: [0.46, 0.22, 0.93],
    toe: [0.46, 0.08, 0.96],
    contact: [0.46, 0, 0.99],
  },
  hind: {
    upper: [0.45, 0.98, -1.05],
    lower: [0.5, 0.58, -0.85],
    foot: [0.46, 0.27, -1.15],
    toe: [0.46, 0.08, -1.1],
    contact: [0.46, 0, -1.05],
  },
  muzzle: [0, 0.74, 2.3],
};

// tooth bones (left; mirrored) — positioned at the tooth base inside the slit
const CANINE: Vec3 = [0.235, 0.752, 2.08];
const INCISOR: Vec3 = [0.07, MOUTH_Y - GAP + 0.006, 2.3];
const TOOTH_BONES: BoneSpec[] = bilateralBones([
  { name: 'canine.L', parent: 'jaw', pos: CANINE },
  { name: 'incisor.L', parent: 'jaw', pos: INCISOR },
]);

// ---------------------------------------------------------------------------
// Sculpt

function bodyPrims(male: boolean): Prim[] {
  const g = male ? 1 : 0.95;
  return [
    ellipsoid('chest', [0, 0.95, 0.62], [0.7 * g, 0.55, 0.6], { blend: 0.15, part: 'body' }),
    ellipsoid('chest', [0, 1.33, 0.5], [0.46 * g, 0.17, 0.45], { blend: 0.15, part: 'body' }),
    ellipsoid('spine_2', [0, 0.95, 0.0], [0.78 * g, 0.55, 0.75], { blend: 0.15, part: 'body' }),
    ellipsoid('spine_1', [0, 0.88, -0.5], [0.76 * g, 0.5, 0.62], { blend: 0.16, part: 'belly' }),
    ellipsoid('spine_1', [0, 1.3, -0.42], [0.5 * g, 0.18, 0.7], { blend: 0.15, part: 'body' }),
    ellipsoid('hips', [0, 1.0, -1.08], [0.66 * g, 0.5, 0.56], { blend: 0.15, part: 'body' }),
    ...symmetric([
      ellipsoid('FL_scap', [0.5, 0.95, 0.72], [0.22, 0.4, 0.3], { blend: 0.12, part: 'body' }),
      ellipsoid('HL_upper', [0.5, 0.82, -1.05], [0.25, 0.4, 0.35], { blend: 0.12, part: 'body' }),
    ]),
    // thick neck and jowls
    ellipsoid('neck_1', [0, 1.0, 1.04], [0.56 * g, 0.5, 0.36], { blend: 0.15, part: 'neck' }),
    ellipsoid('neck_1', [0, 0.74, 1.18], [0.44 * g, 0.24, 0.3], { blend: 0.12, part: 'neck' }),
  ];
}

function headPrims(male: boolean): Prim[] {
  const b = male ? 1 : 0.94;
  return [
    // --- upper head
    ellipsoid('head', [0, 1.13, 1.45], [0.34 * b, 0.25, 0.32], { blend: 0.08, part: 'head' }),
    ...symmetric([ellipsoid('head', [0.2, 1.3, 1.6], [0.085, 0.07, 0.095], { blend: 0.07, part: 'head' })]),
    ellipsoid('head', [0, 1.05, 1.86], [0.25 * b, 0.17, 0.3], { blend: 0.08, part: 'head' }),
    roundBox('head', [0, 0.97, 2.12], [0.31 * b, 0.14, 0.2], 0.12, { blend: 0.08, part: 'muzzle' }),
    ...symmetric([
      // fleshy upper lip pads
      ellipsoid('head', [0.2, 0.89, 2.1], [0.16 * b, 0.11, 0.21], { blend: 0.07, part: 'muzzle' }),
      // nostril mounds on top of the snout
      ellipsoid('head', [0.1, 1.07, 2.22], [0.065, 0.045, 0.055], { blend: 0.04, part: 'muzzle' }),
    ]),
    // big cheeks / jaw angle (on the jaw bone so they swing with it)
    ...symmetric([ellipsoid('jaw', [0.26, 0.8, 1.45], [0.17 * b, 0.22, 0.23], { blend: 0.1, part: 'head' })]),
    // --- lower jaw: deep, wide chin
    ellipsoid('jaw', [0, 0.66, 1.76], [0.3 * b, 0.15, 0.45], { blend: 0.08, part: 'head' }),
    ellipsoid('jaw', [0, 0.69, 2.14], [0.32 * b, 0.14, 0.18], { blend: 0.07, part: 'chin' }),
    // --- the mouth slit separating upper head and jaw (open at the front / sides)
    roundBox('head', [0, MOUTH_Y, 2.02], [0.29, GAP, 0.42], 0.012, { sub: true, blend: 0.008, part: 'mouth' }),
    // nostrils
    ...symmetric([ellipsoid('head', [0.1, 1.105, 2.245], [0.014, 0.02, 0.026], { rot: [0.3, 0.3, 0], sub: true, blend: 0.008, part: 'muzzle' })]),
  ];
}

/** Teeth: tiny at rest (inside the slit), scaled up by their bones as the jaw opens. */
function teethPrims(): Prim[] {
  const c = CANINE, i = INCISOR;
  return symmetric([
    cone('canine.L', [c[0], c[1] - 0.006, c[2]], [c[0] + 0.003, c[1] + 0.034, c[2] + 0.005], 0.011, 0.0032, { blend: 0.002, part: 'tooth', region: 'teeth', skin: 0.3 }),
    cone('incisor.L', [i[0], i[1] - 0.002, i[2] - 0.004], [i[0] + 0.001, i[1] + 0.006, i[2] + 0.018], 0.0036, 0.0022, { blend: 0.002, part: 'tooth', region: 'teeth', skin: 0.3 }),
  ]);
}

function earPrims(): Prim[] {
  const left: Prim[] = [
    // no carved cup: carving the thin plate folds it into back-facing slivers that show as holes;
    // the coat paints the inside instead
    ellipsoid('ear.L', [0.185, 1.43, 1.28], [0.045, 0.06, 0.03], { rot: [0, 0.5, -0.3], blend: 0.025, part: 'ear', region: 'ears' }),
  ];
  return [...left, ...mirrorX(left)];
}

function legPrimsLeft(): Prim[] {
  const f = J.front, h = J.hind;
  const toes = (bone: string, cx: number, cz: number, region: string): Prim[] =>
    [-0.9, -0.3, 0.3, 0.9].map((a) =>
      ellipsoid(bone, [cx + Math.sin(a) * 0.15, 0.04, cz + Math.cos(a) * 0.12], [0.05, 0.04, 0.045], { rot: [0, a, 0], blend: 0.025, part: 'nail', region }),
    );
  return [
    cone('FL_upper', f.upper, f.lower, 0.22, 0.19, { blend: 0.1, part: 'body' }),
    cone('FL_lower', [0.48, 0.55, 0.81], [0.46, 0.22, 0.93], 0.18, 0.15, { blend: 0.06, part: 'leg', region: 'FL' }),
    cone('FL_foot', [0.46, 0.24, 0.93], [0.46, 0.1, 0.97], 0.15, 0.165, { blend: 0.05, part: 'leg', region: 'FL' }),
    ellipsoid('FL_toe', [0.46, 0.07, 0.99], [0.17, 0.075, 0.15], { blend: 0.04, part: 'foot', region: 'FL' }),
    ...toes('FL_toe', 0.46, 1.0, 'FL'),
    roundBox('FL_toe', [0.46, -0.08, 0.99], [0.3, 0.08, 0.3], 0.01, { sub: true, blend: 0.015, part: 'foot', region: 'FL' }),
    cone('HL_upper', h.upper, h.lower, 0.25, 0.19, { blend: 0.1, part: 'body' }),
    cone('HL_lower', [0.5, 0.6, -0.86], [0.46, 0.27, -1.15], 0.18, 0.14, { blend: 0.06, part: 'leg', region: 'HL' }),
    cone('HL_foot', [0.46, 0.28, -1.15], [0.46, 0.1, -1.1], 0.14, 0.16, { blend: 0.05, part: 'leg', region: 'HL' }),
    ellipsoid('HL_toe', [0.46, 0.07, -1.07], [0.165, 0.075, 0.15], { blend: 0.04, part: 'foot', region: 'HL' }),
    ...toes('HL_toe', 0.46, -1.06, 'HL'),
    roundBox('HL_toe', [0.46, -0.08, -1.07], [0.3, 0.08, 0.3], 0.01, { sub: true, blend: 0.015, part: 'foot', region: 'HL' }),
  ];
}

function tailPrims(): Prim[] {
  const t = J.tail;
  return [
    cone('tail_1', [0, 1.12, -1.58], t[1], 0.065, 0.045, { blend: 0.06, part: 'tail' }),
    // flattened paddle
    ellipsoid('tail_2', [0, 0.92, -1.74], [0.055, 0.12, 0.028], { blend: 0.03, part: 'tail', region: 'tail' }),
    cone('tail_3', t[2], [0, 0.74, -1.76], 0.03, 0.02, { blend: 0.02, part: 'tail', region: 'tail' }),
    ellipsoid('tail_3', [0, 0.71, -1.76], [0.04, 0.045, 0.02], {
      blend: 0.02,
      part: 'tuft',
      region: 'tail',
      noise: { amp: 0.008, freq: 50, stretch: [1, 0.2, 1], ridged: true, seed: 101 },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Coat

// grey-mauve back over pinkish-brown flanks, pink underside and face: a
// readable, warm form at mid range instead of a charcoal shape
const TOP = 0x625753;
const SIDE = 0x76655f;
const PINK = 0xa97d70;
const BELLY = 0x9c786c;
const GUM = 0xc98583;
const TONGUE = 0xb56d6b;
const TOOTH = 0xe2d7bf;

/** Flank creases: z where they cross y = 0.8 and their lean (dz per metre of height). */
const FLANK_CREASES: [number, number][] = [
  [0.6, -0.25],
  [-0.72, 0.2],
];

function hippoCoat(eye: Vec3) {
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    const ax = Math.abs(x);
    const n = fbm(x * 1.6, y * 1.6, z * 1.6, 3, 102);
    c.color.setHex(SIDE);
    blendHex(c.color, TOP, clamp01(smooth(0.15, 0.85, c.ny) * 0.75 + n * 0.25));
    // pink underside, lower flanks and leg insides
    blendHex(c.color, BELLY, clamp01(smooth(0.0, -0.7, c.ny) * 0.85 + smooth(0.6, 0.3, y) * 0.2));
    // pink face: lips, cheeks, around eyes and ears
    const face = clamp01(c.pw('muzzle') + c.pw('chin')) * smooth(0.2, -0.6, c.ny - 0.2) + c.pw('head') * smooth(1.0, 0.75, y) * 0.6;
    blendHex(c.color, PINK, clamp01(face) * 0.75);
    // reddish "blood sweat" sheen
    blendHex(c.color, 0x7a4b3a, smooth(0.15, 0.45, fbm(x * 3, y * 3, z * 3, 2, 103)) * 0.14);
    // broad warmer, browner patches on the flanks (no flat grey)
    blendHex(c.color, 0x7f6559, smooth(-0.05, 0.3, fbm(x * 0.8, y * 0.8, z * 0.8, 2, 105)) * 0.45 * smooth(0.7, 0.1, c.ny));
    // dry skin is matte: it only darkens and shines for a while after a swim
    // (the instance's wetness, see animalMaterial). Creases and folds are a
    // darker, pinker brown.
    c.color2.copy(c.color).multiplyScalar(0.7);
    blendHex(c.color2, 0x6e4740, 0.45);
    c.w = 0;
    c.gloss = 0;
    // skin creases behind the elbows and in front of the thighs, where the barrel folds as the legs swing
    for (const [zc, lean] of FLANK_CREASES) {
      const d = z - zc - (y - 0.8) * lean;
      if (Math.abs(d) < 0.07 && ax > 0.3) {
        c.s = d / 0.1 + n * 0.1;
        c.w = 0.16 * smooth(0.07, 0.02, Math.abs(d)) * smooth(0.45, 0.6, y) * smooth(1.2, 1.0, y);
      }
    }
    // deep skin folds across the stubby legs and the neck; the barrel stays smooth
    c.fold = Math.max(0.2, clamp01((c.pw('leg') + c.pw('foot')) * 1.3), c.pw('neck') * smooth(0.6, 0.9, z));
    // neck folds
    if (c.part === 'neck' || (c.pw('neck') > 0.3 && z > 0.8)) {
      c.s = (z - 0.95) / 0.075 + n * 0.8;
      c.w = 0.15 * smooth(0.6, -0.2, c.ny) * smooth(0.75, 1.0, z);
      blendHex(c.color2, 0x6a4a44, 0.4);
    }
    // eye turrets: pink rims
    const ex = ax - eye[0], ey = y - eye[1], ez = z - eye[2];
    const ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (ed < 0.07) blendHex(c.color, 0x9a6a62, smooth(0.07, 0.035, ed) * 0.7);
    if (ed < 0.04) blendHex(c.color, 0x2e2220, smooth(0.04, 0.03, ed) * 0.6);
    // ears: pink inside
    if (c.part === 'ear') blendHex(c.color, 0xb0807a, smooth(-0.2, 0.5, c.nz) * 0.7);
    // whisker stubble on the lips
    if (c.pw('muzzle') > 0.5 && z > 2.0) {
      const h = fbm(x * 90, y * 90, z * 90, 1, 104);
      if (h > 0.55) blendHex(c.color, 0x3a2c28, 0.5);
    }
    // inside the mouth: gums on the palate, tongue on the jaw
    // (sub-primitives are not sampled for pd(), so find the slit faces by position / normal)
    const dm = Math.abs(y - MOUTH_Y) - GAP;
    if (dm < 0.02 && z > 1.6 && ax < 0.3 && Math.abs(c.ny) > 0.45) {
      const k = smooth(0.02, 0.003, dm) * smooth(0.45, 0.7, Math.abs(c.ny));
      // dark lip crease at the edge, pink gums / tongue further in
      const inner = smooth(0.2, 0.1, ax) * smooth(2.2, 2.04, z) * smooth(1.7, 1.85, z);
      blendHex(c.color, 0x4f3433, k * (1 - inner));
      blendHex(c.color, y > MOUTH_Y ? GUM : TONGUE, k * inner);
      c.gloss = 0.45 * k + c.gloss * (1 - k);
      c.w = 0;
    }
    if (c.part === 'tooth') {
      c.color.setHex(TOOTH);
      c.gloss = 0.55;
      c.w = 0;
    }
    if (c.part === 'nail') {
      c.color.setHex(0x55493f);
      c.w = 0;
    }
    if (c.part === 'tuft') blendHex(c.color, 0x2a201c, 0.7);
    // baked occlusion: neck folds, elbows and the gaps between legs and belly,
    // eye turrets, ear roots and the mouth line (the bulky relief stays
    // readable on every tier, also without micro detail)
    const occ = c.ao(0.22);
    c.color.multiplyScalar(1 - 0.55 * occ);
    c.color2.multiplyScalar(1 - 0.55 * occ);
  };
}

// ---------------------------------------------------------------------------
// Animation

function makeDriver(height: number, walkSpeed: number, runSpeed: number) {
  const p = quadParams(height, walkSpeed, runSpeed, {
    walk: {
      stride: 1.15, refSpeed: walkSpeed, duty: 0.66, offsets: [0.25, 0.75, 0, 0.5], stepHeight: 0.1,
      bob: 0.018, bobFreq: 2, pitch: 0.012, roll: 0.04, headBob: 0.05, spineFlex: 0,
    },
    trot: {
      stride: 1.8, refSpeed: walkSpeed * 2.3, duty: 0.46, offsets: [0.5, 1.0, 0, 0.5], stepHeight: 0.14,
      bob: 0.03, bobFreq: 2, pitch: 0.02, roll: 0.025, headBob: 0.05, spineFlex: 0,
    },
    // a fast, bounding trot rather than a true gallop
    gallop: {
      stride: 2.7, refSpeed: runSpeed, duty: 0.38, offsets: [0.5, 0.95, 0, 0.45], stepHeight: 0.17,
      bob: 0.04, bobFreq: 2, pitch: 0.03, roll: 0.02, headBob: 0.06, spineFlex: 0,
    },
    footFollow: 0.35,
    frontFlex: 0.9,
    hindFlex: -0.5,
    frontToeCurl: 0.3,
    hindToeCurl: 0.3,
    push: 0.25,
    scapSwing: 0.3,
    lie: { hipsY: 0.6, chestY: 0.64, front: 'tuck', hindSplay: 0.12, headRest: 0.3 },
    grazeReach: 0.1,
    headCarry: 0.05,
    look: 0.35,
    tailSwish: 0.3,
    tailCarry: -0.1,
    earFlick: 1.0,
    callJaw: 1.25,
    callHead: -0.5,
    callDuration: 3.4,
    breath: 0.012,
    swimSink: 1.4,
  });
  const base = quadrupedDriver(p);

  /** Fast ear wiggles (hippos flick water off their ears). */
  const wiggle = (ctx: AnimCtx, st: QuadState, pose: Pose, k = 1): void => {
    ears(ctx, st, pose);
    const E = ctx.roles.ears;
    const burst = pulses(ctx.time, 3.5, ctx.seed + 60, 0.8, 0.6) * k;
    for (let i = 0; i < E.length; i++) rotLocal(pose, E[i], 'y', (i ? -1 : 1) * 0.5 * burst * Math.sin(ctx.time * TAU * 9 + i));
  };

  /** Occasional rapid tail "propeller" wag. */
  const tailWag = (ctx: AnimCtx, pose: Pose): void => {
    const T = ctx.roles.tail;
    const w = pulses(ctx.time, 14, ctx.seed + 61, 1.6, 0.5);
    if (w <= 0) return;
    for (let i = 0; i < T.length; i++) rotLocal(pose, T[i], 'y', 0.5 * w * Math.sin(ctx.time * TAU * 7 - i));
    rotLocal(pose, T[0], 'x', -0.6 * w);
  };

  const idle = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    body(ctx, st, pose);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    lookAround(ctx, st, pose, 0.8);
    tail(ctx, st, pose, 0, 0.6);
    tailWag(ctx, pose);
    wiggle(ctx, st, pose);
  };

  const walk = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    body(ctx, st, pose);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    lookAround(ctx, st, pose, 0.5);
    neckHead(ctx, pose, 0.06, 0, 0.04, 0);
    tail(ctx, st, pose, 0, 0.6);
    wiggle(ctx, st, pose, 0.4);
  };

  const eat = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    actEat(ctx, st, pose);
    const crop = Math.sin(ctx.time * 0.9 + ctx.seed);
    neckHead(ctx, pose, 0, 0.15 * crop, 0, 0.08 * crop);
    wiggle(ctx, st, pose, 0.5);
  };

  const drink = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    actDrink(ctx, st, pose);
    wiggle(ctx, st, pose, 0.5);
  };

  // the big yawn: head back, jaw dropped ~70°, canines out
  const call = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    body(ctx, st, pose, 0);
    const R = ctx.roles;
    const at = ctx.actionTime;
    const D = p.callDuration;
    const env = envelope(at, 0, 0.7, D - 0.8, D);
    const open = envelope(at, 0.35, 1.1, D - 1.1, D - 0.35);
    rotParent(pose, R.root, 'x', -0.05 * env);
    pose.p[R.root].y += 0.02 * env;
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const shake = Math.sin(at * TAU * 1.7) * open;
    neckHead(ctx, pose, -0.28 * env, 0.06 * shake, -0.3 * env, 0.04 * shake);
    jaw(ctx, pose, p.callJaw * open);
    tail(ctx, st, pose, -0.2 * env, 0.4);
    ears(ctx, st, pose, 0.6 * env);
  };

  // play: open-mouthed sparring, head swinging
  const play = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    body(ctx, st, pose, 0);
    const R = ctx.roles;
    const t = ctx.time;
    const sw = Math.sin(t * TAU * 0.6);
    rotParent(pose, R.root, 'z', 0.03 * sw);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const open = 0.5 + 0.4 * Math.max(0, Math.sin(t * TAU * 0.35));
    neckHead(ctx, pose, -0.15 * open, 0.45 * sw, -0.2 * open, 0.2 * sw, 0.12 * sw);
    jaw(ctx, pose, 0.85 * open);
    tail(ctx, st, pose, 0, 1.2);
    wiggle(ctx, st, pose);
  };

  const social = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    body(ctx, st, pose, 0);
    ctx.rig.fk(pose);
    legsBlock(ctx, st, pose);
    const t = ctx.time;
    const side = ctx.rand > 0.5 ? 1 : -1;
    neckHead(ctx, pose, 0.08, side * 0.35, 0.05, side * 0.15 + 0.05 * Math.sin(t * 1.3), side * 0.06);
    jaw(ctx, pose, 0.08 * Math.max(0, Math.sin(t * TAU * 0.5)));
    tail(ctx, st, pose, 0, 0.8);
    wiggle(ctx, st, pose);
  };

  const sleep = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    lie(ctx, st, pose, 'down');
    rotParent(pose, ctx.roles.root, 'z', 0.05);
  };
  const rest = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    lie(ctx, st, pose, 'up');
    neckHead(ctx, pose, 0.12, 0, 0.05, 0);
    wiggle(ctx, st, pose, 0.6);
  };

  // floating: only eyes, ears and nostrils above the surface
  const swim = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    actSwim(ctx, st, pose);
    const R = ctx.roles;
    // undo the generic swim head pose; raise the head so the top of the face is level
    neckHead(ctx, pose, 0.35 - 0.17, 0.15 * glance(ctx.time, 6, ctx.seed + 3), 0.1 - 0.2, 0);
    rotParent(pose, R.root, 'x', 0.01);
    wiggle(ctx, st, pose, 1.4);
    // now and then submerge a little deeper and resurface
    const dip = pulses(ctx.time, 16, ctx.seed + 62, 4, 0.4);
    pose.p[R.root].y -= 0.12 * dip;
  };

  /** Teeth grow out of the slit in proportion to how far the jaw is open. */
  const post = (ctx: AnimCtx, st: QuadState, pose: Pose): void => {
    const R = ctx.roles;
    const q = pose.q[R.jaw];
    const ang = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    const k = smooth(0.12, 0.75, ang);
    const T = R.chains.teeth;
    for (let i = 0; i < T.length; i++) pose.s[T[i]] = 1 + k * (i % 2 === 0 ? 3.4 : 3.5);
    void st;
  };

  return {
    ...base,
    actions: { ...base.actions, idle, walk, eat, drink, call, play, social, sleep, rest, sit: rest, swim },
    post,
    fade: 0.45,
    fades: { sleep: 1.6, rest: 1.4, sit: 1.4, swim: 1.0 },
    transitions: { 'sleep>*': 1.7, 'rest>*': 1.5, 'sit>*': 1.5, 'swim>*': 1.0, 'sleep>rest': 1.2, 'rest>sleep': 1.2 },
    init: (ctx: AnimCtx): QuadState => initQuad(ctx, p),
    pre: advanceGait,
  };
}

// ---------------------------------------------------------------------------

function design(ctx: DesignContext): CreatureDesign {
  const male = ctx.sex === 'M';
  const sk = quadSkeleton({
    ...J,
    extra: TOOTH_BONES,
    chains: { teeth: ['canine.L', 'incisor.L', 'canine.R', 'incisor.R'] },
  });
  const head = withRegion(headPrims(male), 'head');
  const prims: Prim[] = [
    ...bodyPrims(male),
    ...head,
    ...teethPrims(),
    ...earPrims(),
    ...legPrimsLeft(),
    ...mirrorX(legPrimsLeft()),
    ...tailPrims(),
  ];
  const eyeDir: Vec3 = [-0.6, -0.8, -0.1];
  const hit = surfacePoint(head, [0.5, 1.75, 1.66], eyeDir, 0.8);
  const eye = seat(hit, eyeDir, 0.01);
  return {
    bones: sk.bones,
    roles: sk.roles,
    prims,
    resolution: 0.85,
    regions: {
      head: { scale: 0.6, aniso: [1, 0.27, 1] },
      teeth: { scale: 0.028 },
      ears: { scale: 0.18 },
      FL: { scale: 0.6, aniso: [1, 1.2, 1] },
      FR: { scale: 0.6, aniso: [1, 1.2, 1] },
      HL: { scale: 0.6, aniso: [1, 1.2, 1] },
      HR: { scale: 0.6, aniso: [1, 1.2, 1] },
      tail: { scale: 0.3, aniso: [1, 1.5, 1] },
    },
    coat: hippoCoat(eye),
    // dry and matte; wet (darker, glossy) only after a swim, drying from the top down
    // bump 0.3: the neck and leg folds and the fine creases shade in enough to read at mid range
    look: { skin: 'wrinkled', pattern: 'stripes', roughness: 0.9, sheen: 0.12, grain: 0.012, bump: 0.3, mottle: 0.1 },
    eyes: [{ bone: 'head', pos: eye, radius: 0.026, color: 0x2a1609 }],
    anim: driver(makeDriver(ctx.def.height, ctx.def.walkSpeed, ctx.def.runSpeed)),
    babyScale: 0.25,
    babyHead: 1.2,
    // calves are leggier than adults
    babyLegs: 1.12,
    height: 1.55,
    radius: 1.0,
  };
}

const hippo: SpeciesModel = {
  id: 'hippo',
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.04 : 0.93) * (0.97 + r * 0.06),
};
export default hippo;
