// Plains zebra (Equus quagga) — reference implementation of a hoofed
// quadruped: sculpted SDF body, erect striped mane, per-pixel stripes whose
// phase field follows the body (vertical on the barrel, arcing over the
// haunch, rings on the legs, chevrons on the face). Neighbouring phase fields
// are offset so they agree where they blend (no bull's-eyes).

import { cone, ellipsoid, mirrorX, symmetric, roundBox, transformPoint, transformPrims, type Prim, type Vec3 } from '../sdf/prims';
import { quadSkeleton, seat, surfacePoint, type QuadJoints } from '../kit/quadruped';
import { quadParams, quadrupedDriver } from '../anim/quadruped';
import { driver } from '../anim/util';
import { blendHex, clamp01, fbm, smooth } from '../coat/coat';
import { withRegion } from '../kit/quadruped';
import type { CoatSample, CreatureDesign, DesignContext, SpeciesModel } from '../types';

// Head & neck are authored around the old poll and moved/scaled into place.
const HEAD_T = { scale: 1.1, about: [0, 1.69, 0.95] as Vec3, offset: [0, 0.0, -0.065] as Vec3 };
const NECK_DZ = -0.06;
const nz = (v: Vec3): Vec3 => [v[0], v[1], v[2] + NECK_DZ];
const H = (v: Vec3): Vec3 => transformPoint(v, HEAD_T);

const J: QuadJoints = {
  hips: [0, 1.1, -0.4],
  spine: [
    [0, 1.13, -0.13],
    [0, 1.14, 0.13],
  ],
  chest: [0, 1.11, 0.37],
  neck: [nz([0, 1.19, 0.6]), nz([0, 1.37, 0.74]), nz([0, 1.55, 0.86])],
  head: H([0, 1.69, 0.95]),
  jaw: H([0, 1.5, 0.99]),
  ear: H([0.055, 1.75, 0.93]),
  tail: [
    [0, 1.25, -0.74],
    [0, 1.15, -0.805],
    [0, 1.0, -0.83],
    [0, 0.85, -0.835],
  ],
  front: {
    scap: [0.11, 1.25, 0.41],
    upper: [0.13, 0.96, 0.55],
    lower: [0.135, 0.73, 0.4],
    foot: [0.125, 0.41, 0.44],
    toe: [0.125, 0.13, 0.43],
    contact: [0.125, 0, 0.485],
  },
  hind: {
    upper: [0.13, 1.07, -0.42],
    lower: [0.16, 0.78, -0.27],
    foot: [0.125, 0.47, -0.56],
    toe: [0.125, 0.135, -0.54],
    contact: [0.125, 0, -0.485],
  },
  muzzle: H([0, 1.22, 1.33]),
};

const HEAD_ROT = 0.87; // head axis ≈ 50° below horizontal
const NECK_ROT = -0.93; // neck axis ≈ 53° above horizontal

function headPrims(): Prim[] {
  const P: Prim[] = [
    ellipsoid('head', [0, 1.635, 0.995], [0.085, 0.087, 0.11], { rot: [HEAD_ROT, 0, 0], blend: 0.04, part: 'head' }),
    // jowls / cheeks (deep, wide at the back of the head)
    ellipsoid('head', [0, 1.52, 0.975], [0.092, 0.125, 0.13], { rot: [HEAD_ROT, 0, 0], blend: 0.05, part: 'head' }),
    // nasal bridge (slightly convex profile)
    cone('head', [0, 1.585, 1.07], [0, 1.315, 1.285], 0.07, 0.054, { blend: 0.05, part: 'head' }),
    ellipsoid('head', [0, 1.5, 1.14], [0.06, 0.05, 0.12], { rot: [HEAD_ROT, 0, 0], blend: 0.05, part: 'head' }),
    // muzzle + upper lip
    ellipsoid('head', [0, 1.272, 1.285], [0.06, 0.068, 0.064], { rot: [HEAD_ROT, 0, 0], blend: 0.035, part: 'muzzle' }),
    ellipsoid('head', [0, 1.24, 1.305], [0.053, 0.037, 0.049], { blend: 0.02, part: 'muzzle' }),
    // lower jaw + chin
    ellipsoid('jaw', [0, 1.34, 1.165], [0.05, 0.042, 0.16], { rot: [HEAD_ROT, 0, 0], blend: 0.03, part: 'head' }),
    ellipsoid('jaw', [0, 1.212, 1.265], [0.043, 0.031, 0.045], { blend: 0.018, part: 'muzzle' }),
    // brow ridges
    ...symmetric([ellipsoid('head', [0.062, 1.645, 1.02], [0.03, 0.026, 0.04], { blend: 0.03, part: 'head' })]),
    // mouth line + nostrils
    ellipsoid('head', [0, 1.222, 1.262], [0.07, 0.006, 0.05], { sub: true, blend: 0.008, part: 'muzzle', rot: [0.35, 0, 0] }),
    ...symmetric([ellipsoid('head', [0.035, 1.272, 1.336], [0.011, 0.021, 0.012], { sub: true, blend: 0.01, part: 'muzzle', rot: [0.5, 0, -0.35] })]),
  ];
  return transformPrims(P, HEAD_T);
}

function earPrims(): Prim[] {
  const base: Vec3 = [0.055, 1.75, 0.93];
  const tip: Vec3 = [0.1, 1.94, 0.885];
  const mid: Vec3 = [(base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2, (base[2] + tip[2]) / 2];
  const rot: Vec3 = [-0.25, 0.3, -0.24];
  const left: Prim[] = [
    // opening facing forward / outward; no carved cup: carving the thin plate folds it into
    // back-facing slivers that show as holes; the coat paints the inside instead
    ellipsoid('ear.L', mid, [0.05, 0.1, 0.02], { rot, blend: 0.02, part: 'ear', region: 'ears' }),
    cone('ear.L', [0.048, 1.71, 0.94], [0.07, 1.79, 0.925], 0.032, 0.036, { blend: 0.03, part: 'ear', region: 'ears' }),
  ];
  return transformPrims([...left, ...mirrorX(left)], HEAD_T);
}

function neckPrims(): Prim[] {
  return [
    ellipsoid('neck_1', nz([0, 1.235, 0.6]), [0.135, 0.215, 0.2], { rot: [NECK_ROT, 0, 0], blend: 0.08, part: 'neck' }),
    ellipsoid('neck_2', nz([0, 1.415, 0.745]), [0.097, 0.158, 0.2], { rot: [NECK_ROT, 0, 0], blend: 0.06, part: 'neck' }),
    ellipsoid('neck_3', nz([0, 1.575, 0.86]), [0.078, 0.115, 0.14], { rot: [NECK_ROT, 0, 0], blend: 0.05, part: 'neck' }),
  ];
}

/** Erect, brush-like mane along the crest (bone-bound segments) plus a short forelock. */
function manePrims(): Prim[] {
  const crest: Vec3[] = [nz([0, 1.33, 0.46]), nz([0, 1.47, 0.6]), nz([0, 1.585, 0.73]), nz([0, 1.67, 0.84]), H([0, 1.735, 0.92])];
  const bones = ['chest', 'neck_1', 'neck_2', 'neck_3'];
  const P: Prim[] = [];
  for (let i = 0; i < 4; i++) {
    const a = crest[i], b = crest[i + 1];
    const dz = b[2] - a[2], dy = b[1] - a[1];
    const len = Math.hypot(dz, dy);
    const ang = -Math.atan2(dy, dz);
    const up: Vec3 = [0, dz / len, -dy / len];
    const hgt = i === 0 ? 0.055 : i === 3 ? 0.06 : 0.07;
    const c: Vec3 = [0, (a[1] + b[1]) / 2 + up[1] * hgt * 0.75, (a[2] + b[2]) / 2 + up[2] * hgt * 0.75];
    P.push(
      ellipsoid(bones[i], c, [0.021, hgt, len * 0.68], {
        rot: [ang, 0, 0],
        blend: 0.035,
        part: 'mane',
        region: 'mane',
        noise: { amp: 0.006, freq: 70, stretch: [1, 0.1, 1], octaves: 2, ridged: true, seed: 11 },
      }),
    );
  }
  P.push(
    ellipsoid('head', H([0, 1.75, 0.968]), [0.02, 0.045, 0.034], {
      rot: [0.5, 0, 0],
      blend: 0.02,
      part: 'mane',
      region: 'mane',
      noise: { amp: 0.005, freq: 70, stretch: [1, 0.12, 1], ridged: true, seed: 12 },
    }),
  );
  return P;
}

function bodyPrims(): Prim[] {
  return [
    // ribcage / barrel (deep, rounded)
    ellipsoid('spine_2', [0, 1.0, 0.07], [0.25, 0.31, 0.45], { blend: 0.08, part: 'body' }),
    // chest / breast
    ellipsoid('chest', [0, 1.0, 0.37], [0.205, 0.285, 0.24], { blend: 0.08, part: 'body' }),
    ellipsoid('chest', [0, 0.94, 0.52], [0.15, 0.18, 0.12], { blend: 0.07, part: 'body' }),
    // withers
    ellipsoid('chest', [0, 1.235, 0.33], [0.09, 0.1, 0.2], { blend: 0.08, part: 'body' }),
    // pot belly
    ellipsoid('spine_1', [0, 0.88, -0.05], [0.228, 0.19, 0.35], { blend: 0.12, part: 'belly' }),
    // loins + croup
    ellipsoid('spine_1', [0, 1.15, -0.17], [0.19, 0.14, 0.27], { blend: 0.1, part: 'body' }),
    ellipsoid('hips', [0, 1.075, -0.44], [0.22, 0.25, 0.3], { blend: 0.08, part: 'rump' }),
    ellipsoid('hips', [0, 1.18, -0.42], [0.165, 0.12, 0.25], { blend: 0.08, part: 'rump' }),
    // shoulder blades
    ...symmetric([ellipsoid('FL_scap', [0.13, 1.05, 0.43], [0.075, 0.22, 0.13], { rot: [-0.42, 0, 0], blend: 0.07, part: 'body' })]),
    // haunches & buttocks
    ...symmetric([
      ellipsoid('HL_upper', [0.125, 0.94, -0.46], [0.1, 0.24, 0.2], { rot: [-0.12, 0, 0], blend: 0.07, part: 'rump' }),
      ellipsoid('HL_upper', [0.072, 0.97, -0.63], [0.085, 0.2, 0.11], { blend: 0.07, part: 'rump' }),
    ]),
  ];
}

function legPrimsLeft(): Prim[] {
  const f = J.front, h = J.hind;
  return [
    // front: upper arm (in body), forearm, knee, cannon, fetlock, pastern, hoof
    cone('FL_upper', f.upper, f.lower, 0.09, 0.08, { blend: 0.06, part: 'body' }),
    cone('FL_lower', [0.135, 0.76, 0.4], [0.125, 0.43, 0.44], 0.068, 0.04, { blend: 0.035, part: 'leg', region: 'FL' }),
    ellipsoid('FL_lower', [0.132, 0.64, 0.418], [0.057, 0.12, 0.064], { blend: 0.03, part: 'leg', region: 'FL' }),
    ellipsoid('FL_foot', [0.125, 0.41, 0.443], [0.041, 0.048, 0.044], { blend: 0.02, part: 'leg', region: 'FL' }),
    cone('FL_foot', [0.125, 0.39, 0.44], [0.125, 0.155, 0.433], 0.033, 0.029, { blend: 0.02, part: 'leg', region: 'FL' }),
    ellipsoid('FL_toe', [0.125, 0.13, 0.428], [0.035, 0.04, 0.04], { blend: 0.02, part: 'leg', region: 'FL' }),
    cone('FL_toe', [0.125, 0.12, 0.435], [0.125, 0.058, 0.466], 0.029, 0.031, { blend: 0.015, part: 'leg', region: 'FL' }),
    cone('FL_toe', [0.125, 0.06, 0.469], [0.125, 0.02, 0.488], 0.032, 0.044, { blend: 0.012, part: 'hoof', region: 'FL' }),
    roundBox('FL_toe', [0.125, -0.06, 0.485], [0.1, 0.06, 0.12], 0.01, { sub: true, blend: 0.008, part: 'hoof', region: 'FL' }),
    // hind: thigh (in body), gaskin, hock, cannon, fetlock, pastern, hoof
    cone('HL_upper', h.upper, h.lower, 0.1, 0.085, { blend: 0.09, part: 'rump' }),
    // flank fold: fills between belly and stifle
    ellipsoid('HL_upper', [0.13, 0.86, -0.26], [0.085, 0.11, 0.12], { blend: 0.08, part: 'rump' }),
    cone('HL_lower', [0.155, 0.79, -0.27], [0.125, 0.47, -0.56], 0.075, 0.04, { blend: 0.04, part: 'leg', region: 'HL' }),
    ellipsoid('HL_lower', [0.142, 0.68, -0.39], [0.058, 0.13, 0.078], { rot: [0.55, 0, 0], blend: 0.035, part: 'leg', region: 'HL' }),
    ellipsoid('HL_foot', [0.125, 0.47, -0.572], [0.038, 0.052, 0.046], { blend: 0.02, part: 'leg', region: 'HL' }),
    ellipsoid('HL_foot', [0.125, 0.5, -0.608], [0.026, 0.038, 0.03], { blend: 0.02, part: 'leg', region: 'HL' }),
    cone('HL_foot', [0.125, 0.45, -0.56], [0.125, 0.16, -0.54], 0.034, 0.03, { blend: 0.02, part: 'leg', region: 'HL' }),
    ellipsoid('HL_toe', [0.125, 0.135, -0.545], [0.035, 0.04, 0.04], { blend: 0.02, part: 'leg', region: 'HL' }),
    cone('HL_toe', [0.125, 0.125, -0.54], [0.125, 0.058, -0.505], 0.029, 0.031, { blend: 0.015, part: 'leg', region: 'HL' }),
    cone('HL_toe', [0.125, 0.06, -0.502], [0.125, 0.02, -0.485], 0.032, 0.043, { blend: 0.012, part: 'hoof', region: 'HL' }),
    roundBox('HL_toe', [0.125, -0.06, -0.485], [0.1, 0.06, 0.12], 0.01, { sub: true, blend: 0.008, part: 'hoof', region: 'HL' }),
  ];
}

function tailPrims(): Prim[] {
  const t = J.tail;
  return [
    cone('tail_1', [0, 1.23, -0.7], t[1], 0.045, 0.03, { blend: 0.05, part: 'tail' }),
    cone('tail_2', t[1], t[2], 0.03, 0.024, { blend: 0.02, part: 'tail', region: 'tail' }),
    cone('tail_3', t[2], t[3], 0.024, 0.02, { blend: 0.02, part: 'tail', region: 'tail' }),
    cone('tail_4', t[3], [0, 0.72, -0.84], 0.02, 0.018, { blend: 0.02, part: 'tail', region: 'tail' }),
    ellipsoid('tail_4', [0, 0.64, -0.84], [0.03, 0.12, 0.028], {
      blend: 0.03,
      part: 'tuft',
      region: 'tail',
      noise: { amp: 0.01, freq: 45, stretch: [1, 0.15, 1], ridged: true, octaves: 2, seed: 5 },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Coat

const WHITE = 0xd9d2c3;
const BLACK = 0x141110;
const MUZZLE = 0x1b1714;
const HOOF = 0x2a2522;

const LB = 0.12; // body stripe period (m)
const sBody = (y: number, z: number) => (z + 0.15 * (y - 1.0)) / LB;
// haunch arcs centred low behind the flank, offset to match the body field at the flank
const RC_Y = 0.62, RC_Z = -0.42, LR = 0.13;
const R_OFF = sBody(1.0, -0.18) - Math.hypot(1.0 - RC_Y, -0.18 - RC_Z) / LR;
const sRump = (y: number, z: number) => Math.hypot(y - RC_Y, z - RC_Z) / LR + R_OFF;
// neck bands along the neck axis from its base, matched to the body there
const N0Y = 1.2, N0Z = 0.44, NDY = 0.8, NDZ = 0.6, LN = 0.105;
const sNeckAt = (y: number, z: number) => sBody(N0Y, N0Z) + ((y - N0Y) * NDY + (z - N0Z) * NDZ) / LN;
const POLL = J.head;
const S_POLL = sNeckAt(POLL[1], POLL[2]);

function stripes(c: CoatSample): { s: number; w: number } {
  const { x, y, z } = c;
  const ax = Math.abs(x);
  const warp = fbm(x * 2.0, y * 2.0, z * 2.0, 3, 21) * 0.32;
  const sB = sBody(y, z) + warp;
  const sR = sRump(y, z) + warp * 0.8;
  // breast: neck bands continue down the chest front as chevrons
  const legMem = clamp01((c.pw('leg') + c.pw('hoof')) * 1.6);
  const breast = smooth(0.3, 0.5, z) * smooth(0.05, 0.55, c.nz) * smooth(1.25, 1.05, y) * smooth(0.66, 0.8, y) * (1 - legMem);
  const sN = sNeckAt(y, z) + (breast * ax * 0.9) / LN + warp * 0.5;
  // face: thin chevrons across the head axis, arcing toward the cheeks
  const hd = -(y - POLL[1]) * 0.766 + (z - POLL[2]) * 0.643;
  const sH = S_POLL + hd / 0.034 + ax * ax * 24 + warp * 0.15;
  // legs: rings, continuing the field of the body / haunch at the leg top
  const front = z > 0;
  const topY = front ? 0.74 : 0.8;
  const legRef = front ? sBody(topY, 0.42) : sRump(topY, -0.3);
  const depth = Math.max(0, topY - y);
  const sL = legRef - (depth / 0.058) * (1 + depth * 0.35) + warp * 0.25;

  const wHead = clamp01((c.pw('head') + c.pw('muzzle') + c.pw('ear')) * 1.15);
  const neckAlong = (y - N0Y) * NDY + (z - N0Z) * NDZ;
  const wNeck = clamp01(Math.max(smooth(-0.06, 0.14, neckAlong) * smooth(0.12, 0.3, z), breast)) * (1 - wHead);
  const wLeg = clamp01(legMem * smooth(topY + 0.1, topY - 0.08, y)) * (1 - wHead - wNeck);
  const wRump = smooth(-0.1, -0.3, z) * clamp01(1 - wLeg - wHead - wNeck);
  const wBody = clamp01(1 - wHead - wNeck - wLeg - wRump);
  const s = sB * wBody + sR * wRump + sL * wLeg + sN * wNeck + sH * wHead;
  let w = 0.5 * wBody + 0.5 * wRump + 0.47 * wLeg + 0.48 * wNeck + 0.4 * wHead;
  // stripes taper out under the belly, with a dark mid-ventral line
  const under = smooth(-0.3, -0.85, c.ny) * smooth(0.95, 0.8, y) * (1 - wLeg);
  w *= 1 - under * 0.7;
  if (under > 0.4 && ax < 0.035) w = Math.max(w, 0.9 * smooth(0.035, 0.012, ax));
  return { s, w };
}

function zebraCoat(c: CoatSample): void {
  const { x, y, z } = c;
  c.color.setHex(WHITE);
  // savanna dust on the lower legs and belly
  const dust = clamp01(smooth(0.4, 0.0, y) * 0.5 + fbm(x * 4, y * 4, z * 4, 2, 9) * 0.12);
  blendHex(c.color, 0xae9c80, dust * 0.55);
  c.color2.setHex(BLACK);
  const st = stripes(c);
  c.s = st.s;
  c.w = st.w;
  // muzzle: dark, slightly moist at the nostrils
  const mz = c.pw('muzzle');
  if (mz > 0.2) {
    const k = smooth(0.2, 0.55, mz);
    blendHex(c.color, MUZZLE, k);
    c.w *= 1 - k;
    c.gloss = 0.2 * k;
  }
  // dark eye surround
  const ex = Math.abs(x) - EYE[0], ey = y - EYE[1], ez = z - EYE[2];
  const ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (ed < 0.045) {
    const k = smooth(0.045, 0.028, ed);
    blendHex(c.color, BLACK, k * 0.85);
    c.w *= 1 - k;
  }
  // hooves
  if (c.part === 'hoof') {
    const k = smooth(0.075, 0.055, y);
    blendHex(c.color, HOOF, k);
    blendHex(c.color2, HOOF, k);
  }
  // mane: tips black; stiff bristles toward the tips (long-hair locks break up
  // its silhouette up close instead of a smooth crest)
  if (c.part === 'mane') {
    const tip = smooth(0.035, 0.07, c.pd('neck'));
    blendHex(c.color, BLACK, tip * 0.9);
    c.fur = 1 + 2 * smooth(0.01, 0.05, c.pd('neck'));
  }
  // tail: tuft black
  const tf = c.pw('tuft');
  if (tf > 0.1) {
    const k = smooth(0.1, 0.45, tf);
    blendHex(c.color, BLACK, k);
  }
  // ears: dark tips; the opening (facing forward / outward) pale, unstriped
  // inside a dark rim
  if (c.part === 'ear') {
    const inner = smooth(0.25, 0.7, c.nz * 0.8 + Math.sign(c.x) * c.nx * 0.45) * smooth(1.76, 1.8, y) * smooth(1.9, 1.86, y);
    blendHex(c.color, 0xe6e0d4, inner * 0.85);
    c.w *= 1 - inner;
    const tipK = smooth(1.87, 1.93, y);
    blendHex(c.color, BLACK, tipK);
    c.w *= 1 - tipK;
  }
}

let EYE: Vec3 = [0.09, 1.6, 1.03];

function design(ctx: DesignContext): CreatureDesign {
  const sk = quadSkeleton(J);
  const head = withRegion(headPrims(), 'head');
  const prims: Prim[] = [
    ...bodyPrims(),
    ...neckPrims(),
    ...manePrims(),
    ...head,
    ...earPrims(),
    ...legPrimsLeft(),
    ...mirrorX(legPrimsLeft()),
    ...tailPrims(),
  ];
  // seat the eyes on the head surface
  const eyeDir: Vec3 = [-1, 0, -0.3];
  const hit = surfacePoint(head, H([0.25, 1.6, 1.09]), eyeDir, 0.3);
  EYE = seat(hit, eyeDir, 0.007);
  const p = quadParams(ctx.def.height, ctx.def.walkSpeed, ctx.def.runSpeed, {
    look: 0.5,
    grazeReach: 0.3,
    callJaw: 0.3,
    callHead: -0.5,
    lie: { hipsY: 0.5, chestY: 0.52, front: 'tuck', hindSplay: 0.06, headRest: 0.1 },
    swimSink: 1.05,
  });
  return {
    bones: sk.bones,
    roles: sk.roles,
    prims,
    regions: {
      head: { scale: 0.45 },
      FL: { aniso: [1, 1.9, 1] },
      FR: { aniso: [1, 1.9, 1] },
      HL: { aniso: [1, 1.9, 1] },
      HR: { aniso: [1, 1.9, 1] },
      tail: { scale: 0.28, aniso: [1, 2, 1] },
      mane: { scale: 0.27, aniso: [1, 2, 2] },
      ears: { scale: 0.24, aniso: [1.6, 1.8, 1] },
    },
    coat: zebraCoat,
    look: { skin: 'fur', pattern: 'stripes', roughness: 0.88, sheen: 0.3, grain: 0.007, bump: 0.3, mottle: 0.07 },
    eyes: [{ bone: 'head', pos: EYE, radius: 0.019 }],
    anim: driver(quadrupedDriver(p)),
    babyScale: 0.42,
    babyHead: 1.25,
    // foals stand on long legs
    babyLegs: 1.3,
    height: 1.75,
    radius: 0.6,
  };
}

const zebra: SpeciesModel = {
  id: 'zebra',
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.02 : 0.97) * (0.97 + r * 0.06),
};
export default zebra;
