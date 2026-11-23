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

/** Head point relative to the poll (authored at head scale 1). */
const hp = (dx: number, dy: number, dz: number): Vec3 => [POLL[0] + dx, POLL[1] + dy, POLL[2] + dz];
const HROT = 0.2; // head axis slightly below horizontal

function headPrims(male: boolean): Prim[] {
  const P: Prim[] = [
    // braincase: long, low and broad, flat crown
    ellipsoid('head', hp(0, 0.03, 0.075), [0.118, 0.1, 0.135], { rot: [HROT, 0, 0], blend: 0.05, part: 'head' }),
    // wide zygomatic arches
    ellipsoid('head', hp(0, -0.035, 0.12), [0.146, 0.08, 0.085], { blend: 0.06, part: 'head' }),
    // broad, flat forehead plate carrying the forward-facing eyes
    ellipsoid('head', hp(0, 0.02, 0.163), [0.098, 0.062, 0.058], { blend: 0.05, part: 'head' }),
    // long nasal bridge with the lion's slightly convex (Roman) profile
    cone('head', hp(0, 0.034, 0.158), hp(0, -0.014, 0.298), 0.058, 0.043, { blend: 0.045, part: 'head' }),
    ellipsoid('head', hp(0, 0.012, 0.232), [0.046, 0.03, 0.058], { blend: 0.03, part: 'head' }),
    // deep, square muzzle
    ellipsoid('head', hp(0, -0.054, 0.238), [0.084, 0.062, 0.08], { rot: [HROT, 0, 0], blend: 0.045, part: 'muzzle' }),
    // whisker pads: a broad 'W' under the nose, ending at the lip line
    ...symmetric([ellipsoid('head', hp(0.042, -0.081, 0.268), [0.049, 0.036, 0.046], { blend: 0.024, part: 'muzzle' })]),
    // broad nose leather overhanging the pads
    ellipsoid('head', hp(0, -0.027, 0.314), [0.033, 0.022, 0.02], { rot: [0.45, 0, 0], blend: 0.014, part: 'nose' }),
    // lower jaw and chin, kept below the lip line so the jaw bone owns this
    // surface and the roar really opens the mouth
    ellipsoid('jaw', hp(0, -0.128, 0.178), [0.066, 0.033, 0.1], { rot: [HROT, 0, 0], blend: 0.03, part: 'chin', skinWeight: 2.5, skin: 0.7 }),
    ellipsoid('jaw', hp(0, -0.131, 0.248), [0.041, 0.026, 0.032], { blend: 0.022, part: 'chin', skinWeight: 2.5, skin: 0.7 }),
    // brow ridges over slightly sunken eyes
    ...symmetric([ellipsoid('head', hp(0.056, 0.05, 0.168), [0.045, 0.03, 0.04], { blend: 0.035, part: 'head' })]),
    // full cheeks behind the whisker pads (lions have no cheek ruffs)
    ...symmetric([ellipsoid('head', hp(0.1, -0.07, 0.085), [0.052, 0.07, 0.075], { rot: [0.35, 0.2, -0.3], blend: 0.06, part: 'head' })]),
    // rounded ears, cupped forward (half hidden in the mane of males)
    ...symmetric([
      ellipsoid('ear.L', hp(0.11, 0.128, 0.04), [0.046, 0.044, 0.02], { rot: [-0.15, 0.5, -0.55], blend: 0.03, part: 'ear', region: 'ears' }),
      ellipsoid('ear.L', hp(0.115, 0.134, 0.053), [0.031, 0.03, 0.01], { rot: [-0.15, 0.5, -0.55], sub: true, blend: 0.006, part: 'ear', region: 'ears' }),
    ]),
  ];
  void male;
  return P;
}

/** One lock of mane hair: a tapered cone with stringy ridged noise. */
function lock(bone: string, a: Vec3, b: Vec3, ra: number, rb: number, seed: number): Prim {
  return cone(bone, a, b, ra, rb, {
    blend: 0.045,
    part: 'mane',
    region: 'mane',
    noise: { amp: 0.009, freq: 14, stretch: [1.5, 0.5, 1.5], octaves: 2, seed },
  });
}

function manePrims(): Prim[] {
  // soft core volumes (low, rounded noise) carrying layered locks that break the
  // silhouette: a ruff of locks radiating around the face, long locks falling
  // over the shoulders from the crest of the neck, and a fringe under the throat
  const soft = (seed: number, amp: number) => ({ amp, freq: 7, stretch: [1.6, 0.45, 1.3] as Vec3, octaves: 2, seed });
  const P: Prim[] = [
    ellipsoid('neck_1', [0, 0.97, 0.53], [0.235, 0.27, 0.22], { blend: 0.08, part: 'mane', region: 'mane', noise: soft(31, 0.018) }),
    ellipsoid('neck_2', [0, 1.0, 0.76], [0.225, 0.25, 0.11], { blend: 0.08, part: 'mane', region: 'mane', noise: soft(32, 0.016) }),
    ellipsoid('head', [0, 1.13, 0.79], [0.14, 0.085, 0.12], { blend: 0.07, part: 'mane', region: 'mane', noise: soft(33, 0.012) }),
    ellipsoid('chest', [0, 0.97, 0.34], [0.175, 0.155, 0.18], { blend: 0.14, part: 'mane', region: 'mane', noise: soft(34, 0.014) }),
    ellipsoid('chest', [0, 0.66, 0.49], [0.125, 0.21, 0.12], { blend: 0.08, part: 'mane', region: 'mane', noise: soft(35, 0.016) }),
  ];
  // ruff: locks radiating outward around the face (not under the chin)
  const C: Vec3 = [0, 1.0, 0.79];
  const ruffAngles = [-128, -95, -62, -30, 0, 30, 62, 95, 128];
  ruffAngles.forEach((deg, i) => {
    const t = (deg * Math.PI) / 180;
    const sx = Math.sin(t), cy = Math.cos(t);
    const r0 = 0.15, r1 = 0.28 + 0.025 * Math.cos(i * 2.3);
    const a: Vec3 = [C[0] + sx * r0, C[1] + cy * r0 * 1.05, C[2] - 0.01];
    const b: Vec3 = [C[0] + sx * r1, C[1] + cy * r1 * 1.02 - 0.05, C[2] - 0.085];
    P.push(lock(Math.abs(deg) < 70 ? 'head' : 'neck_2', a, b, 0.075, 0.034, 40 + i));
  });
  // long locks falling over the shoulders from the crest of the neck
  for (const side of [1, -1]) {
    [
      [[0.08, 1.16, 0.62], [0.25, 0.86, 0.5]],
      [[0.1, 1.13, 0.48], [0.27, 0.8, 0.36]],
      [[0.07, 1.1, 0.36], [0.22, 0.86, 0.22]],
    ].forEach(([a, b], i) => {
      P.push(lock('neck_1', [a[0] * side, a[1], a[2]], [b[0] * side, b[1], b[2]], 0.07, 0.028, 60 + i + (side > 0 ? 0 : 5)));
    });
  }
  // fringe hanging under the throat onto the chest
  const fringe: [Vec3, Vec3][] = [
    [[0, 0.82, 0.68], [0, 0.6, 0.6]],
    [[0.07, 0.83, 0.64], [0.1, 0.58, 0.55]],
    [[-0.07, 0.83, 0.64], [-0.1, 0.58, 0.55]],
  ];
  fringe.forEach(([a, b], i) => P.push(lock('chest', a, b, 0.07, 0.03, 80 + i)));
  return P;
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

function lionCoat(male: boolean, hs: number, eye: Vec3, eyeR: number) {
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    // head-local coordinates (authored at head scale 1, relative to the poll)
    const hx = x / hs, hy = (y - POLL[1]) / hs, hz = (z - POLL[2]) / hs;
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
    const hw = clamp01(c.pw('head') + c.pw('muzzle') + c.pw('chin') + c.pw('nose') + c.pw('ear'));
    if (hw > 0.1) {
      const mz = c.pw('muzzle') + c.pw('chin');
      // face a little darker / richer than the body, ochre on the nasal bridge
      blendHex(c.color, 0xa4783f, smooth(0.15, 0.5, c.pw('head')) * smooth(0.0, 0.6, c.ny + c.nz * 0.4) * 0.45);
      // cream whisker pads (lower half), paler lips and chin — not the whole muzzle
      blendHex(c.color, CREAM, smooth(0.3, 0.7, mz) * smooth(0.45, -0.3, c.ny) * 0.8);
      blendHex(c.color, CREAM, smooth(0.3, 0.7, c.pw('chin')) * 0.75);
      // nose: rosy-brown leather with a dark rim
      const nx0 = hx / 0.036, ny0 = (hy + 0.027) / 0.025, nz0 = (hz - 0.314) / 0.026;
      const nd = Math.sqrt(nx0 * nx0 + ny0 * ny0 + nz0 * nz0);
      if (nd < 1.3 && c.nz > -0.2) {
        const k = smooth(1.3, 0.95, nd);
        blendHex(c.color, NOSE, k);
        blendHex(c.color, 0x2b1a15, k * smooth(0.7, 1.05, nd) * 0.85);
        c.gloss = 0.35 * k;
      }
      // black lips; the band between upper and lower lip is the mouth interior,
      // seen when the jaw opens
      const lipY = -0.11 + (hz - 0.27) * 0.22;
      const lipD = Math.abs(hy - lipY);
      if (mz > 0.25 && lipD < 0.022 && hz > 0.13) {
        blendHex(c.color, LIP, smooth(0.022, 0.011, lipD) * 0.92);
        blendHex(c.color, 0x4a1c1a, smooth(0.011, 0.004, lipD) * 0.85);
      }
      // whisker-spot rows on the pads
      if (c.pw('muzzle') > 0.4 && hy < -0.05 && hy > -0.1 && hz > 0.235) {
        const row = Math.abs(fract2((hy + 0.05) / 0.014) - 0.5);
        const col = Math.abs(fract2((hz - 0.235) / 0.016) - 0.5);
        if (row < 0.18 && col < 0.18) blendHex(c.color, 0x3a2a20, 0.65);
      }
      // eyes: black rim, pale patches above and below, a dark tear line
      const ex = Math.abs(x) - eye[0], ey = y - eye[1], ez = z - eye[2];
      const ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (ed < eyeR + 0.03) {
        blendHex(c.color, CREAM, smooth(eyeR + 0.024, eyeR + 0.01, ed) * (ey < 0 ? 0.6 : 0.3));
        blendHex(c.color, LIP, smooth(eyeR + 0.008, eyeR + 0.002, ed));
        if (ey < 0 && ex < 0.004 && Math.abs(ex + 0.004 + ey * 0.3) < 0.0045) blendHex(c.color, 0x3a2418, 0.7);
      }
    }
    // ear backs black, cream fur inside
    if (c.part === 'ear') {
      const backside = smooth(0.1, -0.4, c.nz);
      blendHex(c.color, EARBACK, backside * 0.85);
      blendHex(c.color, male ? 0x6b4a2c : CREAM, (1 - backside) * (male ? 0.6 : 0.3));
    }
    // tail tuft
    blendHex(c.color, TUFT, smooth(0.15, 0.5, c.pw('tuft')));
    // legs a touch darker than the flanks (they catch a lot of sky light)
    c.color.multiplyScalar(1 - 0.12 * clamp01((c.pw('leg') + c.pw('paw')) * 1.5));
    // paws: slightly darker, dusty
    blendHex(c.color, 0x8a6c46, smooth(0.12, 0.0, y) * 0.4);
    // mane: golden around the face, darkening to brown-black behind and below,
    // with paler lock tips and streaks along the locks
    if (male) {
      const m = c.pw('mane');
      if (m > 0.05) {
        const faceRing = smooth(0.62, 0.84, z) * smooth(1.32, 0.9, y);
        const outer = clamp01(smooth(0.52, 0.22, z) * 0.55 + smooth(0.86, 0.62, y) * 0.55);
        const streak = fbm(x * 34, y * 6, z * 28, 3, 17) * 0.5 + 0.5;
        const lockN = fbm(x * 11, y * 3.5, z * 9, 2, 23);
        // tips: the outermost surface of the locks is sun-bleached
        const tip = smooth(-0.2, 0.6, lockN);
        const mane = c.color.clone().setHex(0x8f6638);
        blendHex(mane, 0x3a271b, clamp01(outer * 0.7 + (streak - 0.5) * 0.8 - lockN * 0.3));
        blendHex(mane, 0xc8a066, clamp01(faceRing * 0.85 + tip * 0.25 - (streak - 0.5) * 0.4));
        const k = smooth(0.1, 0.55, m);
        c.color.lerp(mane, k);
        c.fur = 1 + 3.2 * k;
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
  const headScale = male ? 1.1 : 1.02;
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
  const hit = surfacePoint(head, transformPoint(hp(0.062 + 0.036, 0.022, 0.42), headT), eyeDir, 0.4);
  const eye = seat(hit, eyeDir, 0.0105 * headScale);
  const eyeR = 0.0175 * headScale;
  // round dark pupil in front of the amber iris
  const pupil: Vec3 = [eye[0] + 0.12 * eyeR * 0.62, eye[1], eye[2] + eyeR * 0.62];
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
      mane: { scale: 0.6 },
    },
    coat: lionCoat(male, headScale, eye, eyeR),
    look: { skin: 'fur', pattern: 'none', roughness: 0.9, sheen: 0.4, grain: male ? 0.009 : 0.007, bump: 0.35, mottle: 0.1 },
    eyes: [
      { bone: 'head', pos: eye, radius: eyeR, color: 0x8a5a1c },
      { bone: 'head', pos: pupil, radius: eyeR * 0.5, color: 0x0c0806 },
    ],
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
