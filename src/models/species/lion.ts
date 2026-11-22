// Lion (Panthera leo) — reference implementation of a big cat (digitigrade
// paws, rolling shoulder blades, long tufted tail). Males get a shaggy mane
// made of noise-displaced SDF volumes; females are sleeker and maneless.

import { cone, ellipsoid, mirrorX, symmetric, roundBox, sphere, transformPoint, transformPrims, type Prim, type Vec3 } from '../sdf/prims';
import { quadSkeleton, seat, surfacePoint, withRegion, type QuadJoints } from '../kit/quadruped';
import { actCall, quadParams, quadrupedDriver, type QuadState } from '../anim/quadruped';
import { driver } from '../anim/util';
import { blendHex, clamp01, fbm, smooth } from '../coat/coat';
import type { AnimCtx, CoatSample, CreatureDesign, DesignContext, SpeciesModel } from '../types';
import type { Pose } from '../rig/rig';

const POLL: Vec3 = [0, 1.02, 0.82];

function joints(headScale: number): QuadJoints {
  const H = (v: Vec3): Vec3 => transformPoint(v, { scale: headScale, about: POLL });
  return {
    hips: [0, 0.88, -0.5],
    spine: [
      [0, 0.93, -0.22],
      [0, 0.96, 0.06],
    ],
    chest: [0, 0.95, 0.32],
    neck: [
      [0, 0.93, 0.5],
      [0, 0.97, 0.67],
    ],
    head: POLL,
    jaw: H([0, 0.925, 0.88]),
    ear: H([0.09, 1.15, 0.87]),
    tail: [
      [0, 0.93, -0.76],
      [0, 0.8, -0.9],
      [0, 0.61, -1.0],
      [0, 0.43, -1.07],
      [0, 0.3, -1.17],
    ],
    front: {
      scap: [0.12, 1.06, 0.38],
      upper: [0.15, 0.77, 0.47],
      lower: [0.15, 0.52, 0.35],
      foot: [0.14, 0.13, 0.41],
      toe: [0.14, 0.055, 0.465],
      contact: [0.14, 0, 0.5],
    },
    hind: {
      upper: [0.13, 0.85, -0.52],
      lower: [0.16, 0.57, -0.36],
      foot: [0.14, 0.27, -0.62],
      toe: [0.14, 0.055, -0.535],
      contact: [0.14, 0, -0.495],
    },
    muzzle: H([0, 0.885, 1.14]),
  };
}

const HROT = 0.23; // head axis slightly below horizontal

function headPrims(male: boolean): Prim[] {
  const P: Prim[] = [
    // round, domed skull and wide zygomatic arches
    ellipsoid('head', [0, 1.05, 0.905], [0.125, 0.12, 0.13], { rot: [HROT, 0, 0], blend: 0.05, part: 'head' }),
    ellipsoid('head', [0, 0.955, 0.95], [0.15, 0.085, 0.08], { blend: 0.06, part: 'head' }),
    // broad frontal plate carrying the forward-facing eyes
    ellipsoid('head', [0, 1.02, 1.0], [0.105, 0.07, 0.055], { blend: 0.05, part: 'head' }),
    // short, broad muzzle; nasal bridge with a stop below the brow
    ellipsoid('head', [0, 0.94, 1.075], [0.088, 0.077, 0.078], { rot: [HROT, 0, 0], blend: 0.05, part: 'muzzle' }),
    cone('head', [0, 1.05, 1.0], [0, 0.985, 1.12], 0.064, 0.05, { blend: 0.045, part: 'head' }),
    // puffy whisker pads
    ...symmetric([ellipsoid('head', [0.043, 0.918, 1.108], [0.05, 0.046, 0.05], { blend: 0.03, part: 'muzzle' })]),
    // broad nose leather
    ellipsoid('head', [0, 0.963, 1.158], [0.034, 0.023, 0.02], { rot: [0.5, 0, 0], blend: 0.014, part: 'nose' }),
    // lower jaw and a small recessed chin
    ellipsoid('jaw', [0, 0.878, 1.035], [0.068, 0.038, 0.08], { rot: [HROT, 0, 0], blend: 0.035, part: 'chin' }),
    ellipsoid('jaw', [0, 0.873, 1.085], [0.04, 0.028, 0.03], { blend: 0.025, part: 'chin' }),
    // brow ridges
    ...symmetric([ellipsoid('head', [0.058, 1.075, 1.0], [0.045, 0.033, 0.038], { blend: 0.035, part: 'head' })]),
    // ears (rounded, cupped forward)
    ...symmetric([
      ellipsoid('ear.L', [0.115, 1.17, 0.868], [0.046, 0.044, 0.019], { rot: [-0.15, 0.5, -0.55], blend: 0.03, part: 'ear', region: 'ears' }),
      ellipsoid('ear.L', [0.12, 1.176, 0.88], [0.032, 0.031, 0.01], { rot: [-0.15, 0.5, -0.55], sub: true, blend: 0.006, part: 'ear', region: 'ears' }),
    ]),
  ];
  return P;
}

function manePrims(): Prim[] {
  // locks: ridged noise stretched vertically (thin hanging tufts)
  const tuft = (seed: number, amp: number) => ({ amp: amp * 1.3, freq: 9, stretch: [1.8, 0.32, 1.4] as Vec3, octaves: 3, ridged: false, seed });
  return [
    // neck & shoulder mass
    ellipsoid('neck_1', [0, 0.96, 0.53], [0.26, 0.3, 0.24], { blend: 0.08, part: 'mane', region: 'mane', noise: tuft(31, 0.035) }),
    // ruff framing the face
    ellipsoid('neck_2', [0, 1.0, 0.77], [0.25, 0.28, 0.12], { blend: 0.08, part: 'mane', region: 'mane', noise: tuft(32, 0.03) }),
    // crown between the ears
    ellipsoid('head', [0, 1.13, 0.79], [0.15, 0.09, 0.13], { blend: 0.07, part: 'mane', region: 'mane', noise: tuft(33, 0.022) }),
    // over the withers
    ellipsoid('chest', [0, 0.96, 0.33], [0.19, 0.17, 0.19], { blend: 0.14, part: 'mane', region: 'mane', noise: tuft(34, 0.025) }),
    // chest bib between the forelegs
    ellipsoid('chest', [0, 0.63, 0.49], [0.14, 0.24, 0.13], { blend: 0.08, part: 'mane', region: 'mane', noise: tuft(35, 0.03) }),
  ];
}

function bodyPrims(male: boolean): Prim[] {
  const g = male ? 1 : 0.94;
  return [
    ellipsoid('chest', [0, 0.775, 0.27], [0.2 * g, 0.28, 0.28], { blend: 0.08, part: 'body' }),
    ellipsoid('spine_2', [0, 0.8, 0.02], [0.195 * g, 0.25, 0.32], { blend: 0.09, part: 'body' }),
    ellipsoid('chest', [0, 0.99, 0.3], [0.11, 0.08, 0.17], { blend: 0.08, part: 'body' }),
    // narrow waist with a loose belly flap
    ellipsoid('spine_1', [0, 0.84, -0.26], [0.158 * g, 0.17, 0.28], { blend: 0.1, part: 'body' }),
    ellipsoid('spine_1', [0, 0.67, -0.22], [0.12 * g, 0.075, 0.24], { blend: 0.12, part: 'belly' }),
    // hindquarters
    ellipsoid('hips', [0, 0.84, -0.52], [0.17 * g, 0.18, 0.22], { blend: 0.08, part: 'body' }),
    // neck
    cone('neck_1', [0, 0.88, 0.42], [0, 0.96, 0.7], 0.165 * g, 0.135 * g, { blend: 0.08, part: 'neck' }),
    // shoulder blades (roll under the skin when walking)
    ...symmetric([ellipsoid('FL_scap', [0.125, 0.87, 0.38], [0.07, 0.2, 0.12], { rot: [-0.3, 0, 0], blend: 0.07, part: 'body' })]),
    // thighs
    ...symmetric([
      ellipsoid('HL_upper', [0.115, 0.71, -0.5], [0.1, 0.22, 0.18], { rot: [-0.1, 0, 0], blend: 0.08, part: 'body' }),
      ellipsoid('HL_upper', [0.07, 0.76, -0.66], [0.075, 0.17, 0.09], { blend: 0.07, part: 'body' }),
    ]),
  ];
}

function legPrimsLeft(): Prim[] {
  return [
    // front: muscular upper arm, forearm, wrist, big paw
    cone('FL_upper', [0.15, 0.77, 0.47], [0.15, 0.52, 0.35], 0.1, 0.085, { blend: 0.07, part: 'body' }),
    cone('FL_lower', [0.15, 0.54, 0.355], [0.14, 0.14, 0.41], 0.083, 0.057, { blend: 0.045, part: 'leg', region: 'FL' }),
    ellipsoid('FL_lower', [0.148, 0.41, 0.378], [0.078, 0.14, 0.08], { blend: 0.045, part: 'leg', region: 'FL' }),
    cone('FL_foot', [0.14, 0.135, 0.41], [0.14, 0.065, 0.455], 0.056, 0.056, { blend: 0.03, part: 'leg', region: 'FL' }),
    ellipsoid('FL_toe', [0.14, 0.047, 0.49], [0.068, 0.048, 0.08], { blend: 0.03, part: 'paw', region: 'FL' }),
    ...[-0.036, -0.012, 0.012, 0.036].map((dx) => sphere('FL_toe', [0.14 + dx, 0.036, 0.545 - Math.abs(dx) * 0.6], 0.027, { blend: 0.02, part: 'paw', region: 'FL' })),
    roundBox('FL_toe', [0.14, -0.05, 0.49], [0.1, 0.05, 0.12], 0.01, { sub: true, blend: 0.01, part: 'paw', region: 'FL' }),
    // hind: thigh, shin, hock, angled metatarsus, paw
    cone('HL_upper', [0.13, 0.85, -0.52], [0.16, 0.57, -0.36], 0.11, 0.08, { blend: 0.09, part: 'body' }),
    cone('HL_lower', [0.16, 0.58, -0.36], [0.14, 0.27, -0.62], 0.082, 0.048, { blend: 0.05, part: 'leg', region: 'HL' }),
    ellipsoid('HL_lower', [0.15, 0.47, -0.468], [0.066, 0.13, 0.082], { rot: [0.6, 0, 0], blend: 0.045, part: 'leg', region: 'HL' }),
    ellipsoid('HL_foot', [0.14, 0.275, -0.635], [0.042, 0.05, 0.048], { blend: 0.025, part: 'leg', region: 'HL' }),
    cone('HL_foot', [0.14, 0.26, -0.62], [0.14, 0.07, -0.545], 0.045, 0.05, { blend: 0.03, part: 'leg', region: 'HL' }),
    ellipsoid('HL_toe', [0.14, 0.045, -0.505], [0.062, 0.045, 0.074], { blend: 0.03, part: 'paw', region: 'HL' }),
    ...[-0.032, -0.011, 0.011, 0.032].map((dx) => sphere('HL_toe', [0.14 + dx, 0.034, -0.455 - Math.abs(dx) * 0.6], 0.024, { blend: 0.018, part: 'paw', region: 'HL' })),
    roundBox('HL_toe', [0.14, -0.05, -0.5], [0.1, 0.05, 0.12], 0.01, { sub: true, blend: 0.01, part: 'paw', region: 'HL' }),
  ];
}

function tailPrims(t: Vec3[]): Prim[] {
  return [
    cone('tail_1', [0, 0.9, -0.7], t[1], 0.05, 0.034, { blend: 0.05, part: 'tail' }),
    cone('tail_2', t[1], t[2], 0.034, 0.028, { blend: 0.02, part: 'tail', region: 'tail' }),
    cone('tail_3', t[2], t[3], 0.028, 0.024, { blend: 0.02, part: 'tail', region: 'tail' }),
    cone('tail_4', t[3], t[4], 0.024, 0.021, { blend: 0.02, part: 'tail', region: 'tail' }),
    cone('tail_5', t[4], [0, 0.25, -1.26], 0.021, 0.02, { blend: 0.02, part: 'tail', region: 'tail' }),
    ellipsoid('tail_5', [0, 0.235, -1.29], [0.03, 0.04, 0.07], {
      rot: [0.6, 0, 0],
      blend: 0.03,
      part: 'tuft',
      region: 'tail',
      noise: { amp: 0.01, freq: 45, stretch: [1, 1, 0.3], ridged: true, octaves: 2, seed: 8 },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Coat

const TAWNY_BACK = 0x9c7646;
const TAWNY = 0xb48c58;
const CREAM = 0xcbb089;
const WHITE = 0xe3d9c8;
const NOSE = 0x6e3f33;
const LIP = 0x201814;
const EARBACK = 0x2a2019;
const TUFT = 0x1c1511;

const fract2 = (v: number) => v - Math.floor(v);

function lionCoat(male: boolean, eye: Vec3, eyeR: number) {
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    const n = fbm(x * 3, y * 3, z * 3, 3, 4);
    // countershading: darker along the spine, cream belly / inner legs
    const back = smooth(0.2, 0.9, c.ny) * smooth(0.7, 0.95, y);
    c.color.setHex(TAWNY);
    blendHex(c.color, TAWNY_BACK, back * 0.7 + n * 0.15);
    const under = clamp01(smooth(0.0, -0.7, c.ny) * 0.9 + (Math.abs(x) < 0.1 && y < 0.75 ? 0.3 : 0));
    blendHex(c.color, CREAM, under * 0.7);
    // inner legs paler
    const leg = clamp01((c.pw('leg') + c.pw('paw')) * 1.5);
    const inner = leg * smooth(0.2, -0.6, Math.sign(x) * c.nx);
    blendHex(c.color, CREAM, inner * 0.35);
    // muzzle / chin white, nose leather, black lips
    const mz = c.pw('muzzle') + c.pw('chin');
    blendHex(c.color, WHITE, smooth(0.3, 0.7, mz) * (0.35 + 0.55 * smooth(0.0, -0.6, c.ny)));
    const nose = c.pw('nose');
    if (nose > 0.25) {
      blendHex(c.color, NOSE, smooth(0.25, 0.6, nose));
      c.gloss = 0.35 * smooth(0.3, 0.7, nose);
    }
    // lip line
    const lipD = Math.abs(y - 0.888 - (z - 1.12) * 0.15);
    if (mz > 0.3 && lipD < 0.012 && z > 1.02) blendHex(c.color, LIP, smooth(0.012, 0.004, lipD) * 0.9);
    // eyes: black lid line, pale patches above and below
    const ex = Math.abs(x) - eye[0], ey = y - eye[1], ez = z - eye[2];
    const ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
    const er = eyeR;
    if (ed < er + 0.02) {
      const pale = smooth(er + 0.02, er + 0.008, ed) * (ey < 0 ? 0.6 : 0.35);
      blendHex(c.color, WHITE, pale);
      blendHex(c.color, LIP, smooth(er + 0.009, er + 0.003, ed));
      // tear line running down from the inner corner
      if (ey < 0 && ex < 0.0 && Math.abs(ex + 0.006 + ey * 0.25) < 0.004) blendHex(c.color, LIP, 0.7);
    }
    // whisker-spot rows on the pads
    if (c.pw('muzzle') > 0.4 && y < 0.95 && y > 0.895 && z > 1.06) {
      const row = Math.abs(fract2((y - 0.9) / 0.014) - 0.5);
      const col = Math.abs(fract2((z - 1.06) / 0.016) - 0.5);
      if (row < 0.18 && col < 0.18) blendHex(c.color, 0x4a3a2e, 0.6);
    }
    // ear backs black
    if (c.part === 'ear') {
      const backside = smooth(0.1, -0.4, c.nz);
      blendHex(c.color, EARBACK, backside * 0.85);
      blendHex(c.color, CREAM, (1 - backside) * 0.3);
    }
    // tail tuft
    blendHex(c.color, TUFT, smooth(0.15, 0.5, c.pw('tuft')));
    // legs a touch darker than the flanks (they catch a lot of sky light)
    c.color.multiplyScalar(1 - 0.12 * clamp01((c.pw('leg') + c.pw('paw')) * 1.5));
    // paws: slightly darker, dusty
    blendHex(c.color, 0x8a6c46, smooth(0.12, 0.0, y) * 0.4);
    // mane: dark brown outer locks, golden around the face
    if (male) {
      const m = c.pw('mane');
      if (m > 0.05) {
        const faceRing = smooth(0.6, 0.86, z) * smooth(1.3, 0.95, y);
        const outer = clamp01(smooth(0.5, 0.2, z) * 0.6 + smooth(0.85, 0.6, y) * 0.5);
        // streaks along the locks (vertical / radial strands)
        const streak = fbm(x * 38, y * 5, z * 30, 3, 17) * 0.5 + 0.5;
        const lock = fbm(x * 12, y * 3.2, z * 9, 2, 23);
        const mane = c.color.clone().setHex(0x75512e);
        blendHex(mane, 0x2e1f15, clamp01(outer * 0.75 + (streak - 0.5) * 1.1 - lock * 0.35));
        blendHex(mane, 0xc29a62, clamp01(faceRing * 0.8 + lock * 0.3 - (streak - 0.5) * 0.5));
        const k = smooth(0.08, 0.6, m);
        c.color.lerp(mane, k);
        c.fur = 1 + 3 * k;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Animation: lions carry the head low and roar with a lowered head and a
// heaving chest.

function roar(ctx: AnimCtx, st: QuadState, pose: Pose): void {
  actCall(ctx, st, pose);
  const at = ctx.actionTime;
  const env = smooth(0.2, 0.8, at) * (1 - smooth(st.p.callDuration - 0.5, st.p.callDuration, at));
  const R = ctx.roles;
  // chest heave with each grunt
  const heave = Math.max(0, Math.sin(at * Math.PI * 2 * 1.4)) * env;
  pose.p[R.root].y -= 0.02 * heave;
}

function design(ctx: DesignContext): CreatureDesign {
  const male = ctx.sex === 'M';
  const headScale = male ? 1.15 : 1.04;
  const J = joints(headScale);
  const sk = quadSkeleton(J);
  const headT = { scale: headScale, about: POLL };
  const head = withRegion(transformPrims(headPrims(male), headT), 'head');
  const prims: Prim[] = [
    ...bodyPrims(male),
    ...head,
    ...(male ? manePrims() : []),
    ...legPrimsLeft(),
    ...mirrorX(legPrimsLeft()),
    ...tailPrims(J.tail),
  ];
  const eyeDir: Vec3 = [-0.12, 0, -1];
  const hit = surfacePoint(head, transformPoint([0.06 + 0.036, 1.03, 1.3], headT), eyeDir, 0.4);
  const eye = seat(hit, eyeDir, 0.009);
  const p = quadParams(ctx.def.height, ctx.def.walkSpeed, ctx.def.runSpeed, {
    walk: {
      stride: 1.25, refSpeed: ctx.def.walkSpeed, duty: 0.66, offsets: [0.25, 0.75, 0, 0.5], stepHeight: 0.09,
      bob: 0.008, bobFreq: 2, pitch: 0, roll: 0.03, headBob: 0.03, spineFlex: 0,
    },
    gallop: {
      stride: 3.6, refSpeed: ctx.def.runSpeed, duty: 0.3, offsets: [0.56, 0.46, 0, 0.1], stepHeight: 0.18,
      bob: 0.035, bobFreq: 1, pitch: 0.08, roll: 0.01, headBob: 0.05, spineFlex: 0.2,
    },
    footFollow: 0.6,
    frontFlex: 1.5,
    hindFlex: -0.7,
    frontToeCurl: 0.7,
    hindToeCurl: 0.6,
    push: 0.5,
    scapSwing: 0.6,
    sitStyle: 'cat',
    lie: { hipsY: 0.3, chestY: 0.33, front: 'extend', hindSplay: 0.05, headRest: 0.13 },
    grazeReach: 0.15,
    headCarry: 0.2,
    look: 0.55,
    tailSwish: 0.22,
    tailCarry: 0.1,
    earFlick: 0.4,
    callJaw: 0.55,
    callHead: 0.12,
    callDuration: 3.2,
    swimSink: 0.85,
  });
  const base = quadrupedDriver(p);
  return {
    bones: sk.bones,
    roles: sk.roles,
    prims,
    regions: {
      head: { scale: 0.45 },
      FL: { aniso: [1, 1.8, 1] },
      FR: { aniso: [1, 1.8, 1] },
      HL: { aniso: [1, 1.8, 1] },
      HR: { aniso: [1, 1.8, 1] },
      tail: { scale: 0.3, aniso: [1, 1.6, 1.6] },
      ears: { scale: 0.15, aniso: [1.4, 1.4, 1] },
      mane: { scale: 0.62 },
    },
    coat: lionCoat(male, eye, 0.017 * headScale),
    look: { skin: 'fur', pattern: 'none', roughness: 0.9, sheen: 0.4, grain: male ? 0.009 : 0.007, bump: 0.35, mottle: 0.1 },
    eyes: [{ bone: 'head', pos: eye, radius: 0.017 * headScale, color: 0x2a1a0c }],
    anim: driver({ ...base, actions: { ...base.actions, call: roar } }),
    babyScale: 0.3,
    babyHead: 1.35,
    height: male ? 1.35 : 1.15,
    radius: 0.55,
  };
}

const lion: SpeciesModel = {
  id: 'lion',
  dimorphic: true,
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.04 : 0.9) * (0.97 + r * 0.06),
};
export default lion;
