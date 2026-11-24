// Lion (Panthera leo) — reference implementation of a big cat (digitigrade
// paws, rolling shoulder blades, long tufted tail). Males get a shaggy mane
// made of noise-displaced SDF volumes; females are sleeker and maneless.

import { cone, ellipsoid, mirrorX, symmetric, roundBox, sphere, transformPoint, transformPrims, type Prim, type PrimOpts, type Vec3 } from '../sdf/prims';
import { CUB_PAWS, quadSkeleton, seat, surfacePoint, withRegion, type QuadJoints } from '../kit/quadruped';
import { actCall, quadParams, quadrupedDriver, type QuadState } from '../anim/quadruped';
import { driver } from '../anim/util';
import { blendHex, clamp01, fbm, smooth } from '../coat/coat';
import type { AnimCtx, BoneSpec, CoatSample, CreatureDesign, DesignContext, SpeciesModel } from '../types';
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
    ear: H([0.09, 1.15, 0.85]),
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
    muzzle: H([0, 0.885, 1.155]),
  };
}

/** Head point relative to the poll (authored at head scale 1). */
const hp = (dx: number, dy: number, dz: number): Vec3 => [POLL[0] + dx, POLL[1] + dy, POLL[2] + dz];
const HROT = 0.2; // head axis slightly below horizontal

function headPrims(male: boolean): Prim[] {
  const es = male ? 0.88 : 1;
  const ez = male ? 0.012 : 0;
  const P: Prim[] = [
    // braincase: long, low and broad, flat crown
    ellipsoid('head', hp(0, 0.03, 0.075), [0.118, 0.1, 0.135], { rot: [HROT, 0, 0], blend: 0.05, part: 'head' }),
    // wide zygomatic arches
    ellipsoid('head', hp(0, -0.012, 0.13), [0.14, 0.07, 0.08], { blend: 0.06, part: 'head' }),
    // broad, flat forehead plate carrying the forward-facing eyes
    ellipsoid('head', hp(0, 0.022, 0.163), [0.11, 0.064, 0.06], { blend: 0.05, part: 'head' }),
    // long, broad nasal bridge with the lion's slightly convex (Roman) profile
    cone('head', hp(0, 0.036, 0.158), hp(0, -0.008, 0.315), 0.056, 0.042, { blend: 0.045, part: 'head' }),
    ellipsoid('head', hp(0, 0.016, 0.24), [0.044, 0.03, 0.065], { blend: 0.03, part: 'head' }),
    // deep, square muzzle
    ellipsoid('head', hp(0, -0.054, 0.252), [0.07, 0.06, 0.088], { rot: [HROT, 0, 0], blend: 0.045, part: 'muzzle' }),
    // whisker pads: a broad 'W' under the nose, ending at the lip line
    ...symmetric([ellipsoid('head', hp(0.036, -0.08, 0.286), [0.04, 0.032, 0.047], { blend: 0.024, part: 'muzzle' })]),
    // broad nose leather overhanging the pads
    ellipsoid('head', hp(0, -0.022, 0.33), [0.035, 0.022, 0.02], { rot: [0.45, 0, 0], blend: 0.014, part: 'nose' }),
    // lower jaw and chin, kept below the lip line so the jaw bone owns this
    // surface and the roar really opens the mouth
    ellipsoid('jaw', hp(0, -0.128, 0.185), [0.064, 0.032, 0.105], { rot: [HROT, 0, 0], blend: 0.03, part: 'chin', skinWeight: 2.5, skin: 0.7 }),
    ellipsoid('jaw', hp(0, -0.131, 0.258), [0.04, 0.026, 0.032], { blend: 0.022, part: 'chin', skinWeight: 2.5, skin: 0.7 }),
    // brow ridges over slightly sunken eyes
    ...symmetric([ellipsoid('head', hp(0.06, 0.052, 0.17), [0.05, 0.032, 0.042], { blend: 0.035, part: 'head' })]),
    // full cheeks behind the whisker pads (lions have no cheek ruffs)
    ...symmetric([ellipsoid('head', hp(0.09, -0.05, 0.08), [0.04, 0.05, 0.06], { rot: [0.35, 0.2, -0.3], blend: 0.06, part: 'head' })]),
    // rounded ears facing forward; smaller and set back on males, where they
    // are half buried in the mane (big exposed round ears read as a bear). No
    // carved cup: carving the thin plate folds the surface into back-facing
    // slivers that show as holes; the coat paints the paler inner ear instead.
    ...symmetric([
      ellipsoid('ear.L', hp(0.11, 0.128, 0.04 - ez), [0.046 * es, 0.044 * es, 0.02], { rot: [-0.15, 0.5, -0.55], blend: 0.03, part: 'ear', region: 'ears' }),
    ]),
  ];
  return P;
}

/**
 * The male's mane: one continuous volume of a few large, softly blended
 * masses — a ruff framing the face (behind the cheeks, ears poking out above
 * it), a cap over the crown behind the ears, the thick neck mane rising above
 * the nape, the shoulder fringe and the long chest bib between the forelegs.
 * Vertically stretched noise breaks the outline into hanging locks — finer
 * and stronger on the outer masses, so the mane ends in ragged tufts instead
 * of a hard helmet line; strand detail comes from the coat (streaks) and the
 * fur micro-normal. A thin fringe continues the bib under the chest.
 */
function manePrims(): Prim[] {
  const hair = (seed: number, amp: number, freq = 8): PrimOpts['noise'] => ({ amp, freq, stretch: [1.4, 0.4, 1.2], octaves: 3, ridged: true, seed });
  const o = (blend: number, seed: number, amp: number, freq?: number): PrimOpts => ({ blend, part: 'mane', region: 'mane', noise: hair(seed, amp, freq) });
  return [
    // ruff: a thick disc behind the face, from the brow over the cheeks to the throat
    ellipsoid('mane_head', [0, 0.93, 0.73], [0.33, 0.29, 0.15], { rot: [-0.12, 0, 0], ...o(0.07, 31, 0.024, 11) }),
    // crown cap between and behind the ears
    ellipsoid('mane_head', [0, 1.11, 0.735], [0.16, 0.105, 0.15], o(0.09, 32, 0.014)),
    // neck mane, its crest rising above the nape
    ellipsoid('mane_neck', [0, 1.0, 0.565], [0.235, 0.265, 0.255], { rot: [-0.25, 0, 0], ...o(0.1, 33, 0.024, 11) }),
    // shoulder fringe fading into the withers
    ellipsoid('mane_chest', [0, 0.99, 0.37], [0.22, 0.2, 0.16], o(0.14, 34, 0.026, 12)),
    // throat and chest bib hanging between the forelegs
    ellipsoid('mane_neck', [0, 0.76, 0.63], [0.155, 0.2, 0.15], o(0.1, 35, 0.022, 12)),
    ellipsoid('mane_chest', [0, 0.64, 0.5], [0.12, 0.17, 0.12], o(0.09, 36, 0.024, 12)),
    // chest / belly fringe: a narrow band of longer hair under the chest, between the forelegs
    ellipsoid('mane_chest', [0, 0.52, 0.17], [0.07, 0.05, 0.21], o(0.08, 37, 0.02, 14)),
  ];
}

/**
 * Mane bones: the mane volumes hang on them so a young male's mane can grow
 * in (babyBones). Each sits inside the body part it covers (head, neck axis,
 * chest), so a shrunken mane draws in around that part rather than off it.
 */
const MANE_BONES: BoneSpec[] = [
  { name: 'mane_head', parent: 'head', pos: [0, 0.93, 0.76] },
  { name: 'mane_neck', parent: 'neck_1', pos: [0, 0.92, 0.565] },
  { name: 'mane_chest', parent: 'chest', pos: [0, 0.82, 0.42] },
];
/** Young males switch to the maned mesh at this growth, with the mane at ~2/3 size. */
const MANE_FROM = 0.55;
/** Newborn mane bone scale: eases (with growth 0.15 … 0.95) to ≈ 0.68 at MANE_FROM and 1 when adult. */
const MANE_BABY = 0.35;

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

const TAWNY_BACK = 0x7d5935;
const TAWNY = 0xa07843;
const CREAM = 0xc9ab82;
/** Belly and inner legs: paler than the cream of the face, so the underside reads from the side. */
const BELLY = 0xd8c39e;
/** Mane: tan rim at the face, deep brown at the rear and underside, black-brown locks. */
const MANE_RIM = 0xb4874c;
const MANE_MID = 0x6a4627;
const MANE_DARK = 0x5a3a20;
const MANE_LOCK = 0x2e1e12;
const NOSE = 0x8e5444;
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
    // countershading: a darker saddle along the spine, cream belly / inner legs
    const back = smooth(0.1, 0.85, c.ny) * smooth(0.66, 0.95, y);
    c.color.setHex(TAWNY);
    blendHex(c.color, TAWNY_BACK, clamp01(back * 0.9 + n * 0.2));
    // broad, soft tonal drift through the coat (no flat single-colour flanks)
    blendHex(c.color, TAWNY_BACK, smooth(0.0, 0.45, fbm(x * 2.4 + 5, y * 2.4, z * 2.4, 2, 6)) * 0.3);
    const hw = clamp01(c.pw('head') + c.pw('muzzle') + c.pw('chin') + c.pw('nose') + c.pw('ear'));
    // (not on the head: pale jaws and cheeks read as a bear's face)
    // the pale belly creeps up the lower flank, so it shows from the side
    const under = clamp01(smooth(0.1, -0.55, c.ny) * smooth(0.85, 0.7, y) + (Math.abs(x) < 0.1 && y < 0.75 ? 0.3 : 0)) * (1 - hw * 0.8);
    blendHex(c.color, BELLY, under * 0.8);
    // inner legs pale: limb surfaces below the body that face the other legs
    const leg = clamp01((c.pw('leg') + c.pw('paw')) * 1.5);
    const inner = smooth(0.2, -0.5, Math.sign(x) * c.nx) * smooth(0.8, 0.55, y) * (1 - hw);
    blendHex(c.color, BELLY, inner * (0.3 + 0.25 * leg));
    // muscle masses: a soft darker crease behind the shoulder (triceps) and in
    // front of the thigh (stifle fold), the masses a touch lighter on top, so
    // the flank reads as muscle under the coat rather than a smooth shell
    const side = smooth(0.25, 0.6, Math.abs(c.nx)) * (1 - hw);
    if (side > 0) {
      const sh = Math.hypot((z - 0.34) / 0.17, (y - 0.74) / 0.22);
      const hu = Math.hypot((z + 0.5) / 0.2, (y - 0.72) / 0.22);
      const crease = Math.exp(-(((sh - 1) / 0.2) ** 2)) * smooth(0.34, 0.22, z) + Math.exp(-(((hu - 1) / 0.2) ** 2)) * smooth(-0.5, -0.38, z);
      c.color.multiplyScalar(1 - 0.24 * clamp01(crease) * side);
      blendHex(c.color, 0xb48c58, (smooth(1, 0.4, sh) + smooth(1, 0.4, hu)) * smooth(-0.3, 0.4, c.ny) * side * 0.15);
    }
    if (hw > 0.1) {
      const mz = c.pw('muzzle') + c.pw('chin');
      // face a little darker / richer than the body, ochre on the nasal bridge
      blendHex(c.color, 0xa4783f, smooth(0.15, 0.5, c.pw('head') + c.pw('muzzle') * 0.6) * smooth(0.0, 0.6, c.ny + c.nz * 0.4) * 0.5);
      // cream whisker pads (lower half, beside the nose), paler lips and chin — not the whole muzzle
      blendHex(c.color, CREAM, smooth(0.3, 0.7, mz) * smooth(0.45, -0.3, c.ny) * smooth(0.1, 0.06, Math.abs(hx)) * 0.8);
      blendHex(c.color, CREAM, smooth(0.3, 0.7, c.pw('chin')) * smooth(0.2, -0.5, c.ny) * 0.6);
      // cheeks shade into a deeper tawny towards the mane
      blendHex(c.color, TAWNY_BACK, smooth(0.35, 0.85, Math.abs(c.nx)) * smooth(0.5, 0.9, c.pw('head')) * 0.35);
      // nose: rosy-brown leather with a dark rim
      const nx0 = hx / 0.038, ny0 = (hy + 0.022) / 0.025, nz0 = (hz - 0.33) / 0.026;
      const nd = Math.sqrt(nx0 * nx0 + ny0 * ny0 + nz0 * nz0);
      if (nd < 1.3 && c.nz > -0.2) {
        const k = smooth(1.3, 0.95, nd);
        blendHex(c.color, NOSE, k);
        blendHex(c.color, 0x2b1a15, k * smooth(0.8, 1.1, nd) * 0.8);
        c.gloss = 0.35 * k;
      }
      // black lips; the band between upper and lower lip is the mouth interior,
      // seen when the jaw opens
      const lipY = -0.11 + (hz - 0.28) * 0.22;
      const lipD = Math.abs(hy - lipY);
      if (mz > 0.25 && lipD < 0.014 && hz > 0.13) {
        blendHex(c.color, LIP, smooth(0.014, 0.007, lipD) * 0.92);
        blendHex(c.color, 0x4a1c1a, smooth(0.006, 0.002, lipD) * 0.85);
      }
      // whisker-spot rows on the pads
      if (c.pw('muzzle') > 0.4 && hy < -0.05 && hy > -0.1 && hz > 0.25) {
        const row = Math.abs(fract2((hy + 0.05) / 0.014) - 0.5);
        const col = Math.abs(fract2((hz - 0.25) / 0.016) - 0.5);
        if (row < 0.18 && col < 0.18) blendHex(c.color, 0x3a2a20, 0.65);
      }
      // eyes: black rim, pale patches above and below, a dark tear line
      const ex = Math.abs(x) - eye[0], ey = y - eye[1], ez = z - eye[2];
      const ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (ed < eyeR + 0.035) {
        blendHex(c.color, CREAM, smooth(eyeR + 0.03, eyeR + 0.012, ed) * (ey < 0 ? 0.6 : 0.25));
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
    // muscle modelling: the grooves around shoulder, elbow and haunch and the
    // flank under the ribs shade in, so the body doesn't read as smooth plastic
    if (c.pw('body') + c.pw('belly') + c.pw('neck') > 0.3) c.color.multiplyScalar(1 - 0.75 * c.ao(0.14));
    // paws: slightly darker, dusty
    blendHex(c.color, 0x8a6c46, smooth(0.12, 0.0, y) * 0.4);
    // mane: two-tone, so it never reads as the body colour — a tan rim in the
    // ruff framing the face, deep brown over the rear of the neck, the
    // shoulders, the underside and the chest bib, in vertical locks (streaks)
    // with a few paler, sun-bleached tips near the face
    if (male) {
      const m = c.pw('mane');
      if (m > 0.05) {
        const face = smooth(0.7, 0.86, z) * smooth(0.62, 0.8, y);
        const dark = clamp01(smooth(0.74, 0.45, z) + smooth(0.86, 0.62, y) + smooth(-0.2, -0.7, c.ny) * 0.6) * (1 - face);
        const streak = fbm(x * 34, y * 5, z * 30, 3, 17);
        const lock = fbm(x * 12, y * 3, z * 10, 2, 23);
        const mane = c.color.clone().setHex(MANE_MID);
        blendHex(mane, MANE_DARK, dark);
        blendHex(mane, MANE_LOCK, clamp01(dark * 0.35 + streak * 0.5 - lock * 0.25));
        blendHex(mane, MANE_RIM, clamp01(face * 0.9 - streak * 0.3));
        blendHex(mane, 0xc49a5c, smooth(0.25, 0.6, lock + streak * 0.5) * face * 0.3);
        const k = smooth(0.1, 0.55, m);
        c.color.lerp(mane, k);
        c.fur = 1 + 2.6 * k;
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
  const headScale = male ? 1.2 : 1.06;
  const J = joints(headScale);
  const sk = quadSkeleton(male ? { ...J, extra: MANE_BONES } : J);
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
  // forward-facing eyes close to the broad nasal bridge (wide-set eyes read as a bear)
  const hit = surfacePoint(head, transformPoint(hp(0.046 + 0.036, 0.024, 0.42), headT), eyeDir, 0.4);
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
    look: {
      skin: 'fur', pattern: 'none', roughness: 0.9, sheen: 0.4, grain: male ? 0.009 : 0.007, bump: 0.55, mottle: 0.12,
      // cubs: a woollier, greyer-tawny coat
      juvenile: { color: 0xa39071, amount: 0.4, until: 0.65, keep: 0.85 },
    },
    eyes: [
      { bone: 'head', pos: eye, radius: eyeR, color: 0x8a5a1c },
      { bone: 'head', pos: pupil, radius: eyeR * 0.5, color: 0x0c0806 },
    ],
    anim: driver({ ...base, actions: { ...base.actions, call: roar } }),
    babyScale: 0.3,
    babyHead: 1.35,
    // cubs have short, stubby legs
    babyLegs: 0.82,
    // cubs have big, clumsy paws (on top of the short legs); a young male's mane grows in
    babyBones: male ? { ...CUB_PAWS, mane_head: MANE_BABY, mane_neck: MANE_BABY, mane_chest: MANE_BABY } : CUB_PAWS,
    height: male ? 1.35 : 1.15,
    radius: 0.55,
  };
}

const lion: SpeciesModel = {
  id: 'lion',
  dimorphic: true,
  maturesAt: MANE_FROM,
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.04 : 0.9) * (0.97 + r * 0.06),
};
export default lion;
