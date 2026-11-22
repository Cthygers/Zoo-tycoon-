// Bengal tiger (Panthera tigris tigris). A long, low, heavily muscled big
// cat: massive forequarters and paws, a broad head framed by white cheek
// ruffs (fuller in males), rounded ears with white "eye spots" on the backs,
// a thick ringed tail. The coat is a per-pixel stripe field: irregular dark
// stripes, thickest on the flanks, arcing over the haunch, tapering out on
// the belly, banding the legs and ringing the tail; the face carries its own
// field (forehead arcs, cheek bars) with white eye patches, muzzle and chin.
// Behaviour: low-headed stalking walk, crouched drinking, eating lying down,
// sleeping flat on the side, swimming with only the head out, roaring,
// pouncing play.

import { cone, ellipsoid, mirrorX, roundBox, sphere, symmetric, transformPoint, transformPrims, type Prim, type Vec3 } from '../sdf/prims';
import { quadSkeleton, seat, surfacePoint, withRegion, type QuadJoints } from '../kit/quadruped';
import * as THREE from 'three';
import {
  actCall,
  actIdle,
  actSit,
  actWalk,
  ears,
  jaw,
  lie,
  lookAroundStill,
  neckHead,
  placeLeg,
  quadParams,
  reachMuzzle,
  tail,
  type QuadParams,
} from '../anim/quadruped';
import { TAU, driver, glance, pulses } from '../anim/util';
import { blendHex, clamp01, fbm, smooth } from '../coat/coat';
import type { AnimCtx, AnimDriver, CoatSample, CreatureDesign, DesignContext, SpeciesModel } from '../types';
import { rotLocal, rotParent, type Pose } from '../rig/rig';
import { PRState, crouch, distSym, initPR, lieSide, polyProject, prePR, variant, type PolyHit, type SideLie } from './species-predators-runners/shared';

// ---------------------------------------------------------------------------
// Skeleton

const POLL: Vec3 = [0, 0.985, 0.9];

const TAIL: Vec3[] = [
  [0, 0.9, -0.88],
  [0, 0.77, -1.03],
  [0, 0.585, -1.135],
  [0, 0.405, -1.225],
  [0, 0.285, -1.37],
];
const TAIL_TIP: Vec3 = [0, 0.265, -1.6];

function joints(hs: number): QuadJoints {
  const H = (v: Vec3): Vec3 => transformPoint(v, { scale: hs, about: POLL });
  return {
    hips: [0, 0.86, -0.62],
    spine: [
      [0, 0.91, -0.33],
      [0, 0.94, -0.03],
    ],
    chest: [0, 0.93, 0.3],
    neck: [
      [0, 0.9, 0.5],
      [0, 0.935, 0.7],
    ],
    head: POLL,
    jaw: H([0, 0.89, 0.95]),
    ear: H([0.1, 1.1, 0.875]),
    tail: TAIL,
    front: {
      scap: [0.125, 1.02, 0.37],
      upper: [0.16, 0.73, 0.46],
      lower: [0.165, 0.47, 0.33],
      foot: [0.155, 0.125, 0.4],
      toe: [0.155, 0.052, 0.46],
      contact: [0.155, 0, 0.5],
    },
    hind: {
      upper: [0.14, 0.83, -0.64],
      lower: [0.17, 0.54, -0.47],
      foot: [0.15, 0.265, -0.76],
      toe: [0.15, 0.052, -0.672],
      contact: [0.15, 0, -0.632],
    },
    muzzle: H([0, 0.885, 1.255]),
  };
}

/** Head point relative to the poll (authored at head scale 1). */
const hp = (dx: number, dy: number, dz: number): Vec3 => [POLL[0] + dx, POLL[1] + dy, POLL[2] + dz];
const HROT = 0.2;

function headPrims(male: boolean): Prim[] {
  const ruff = male ? 1 : 0.74;
  const fluff = (seed: number, amp: number) => ({ amp, freq: 22, stretch: [1.4, 0.5, 1.1] as Vec3, octaves: 2, seed });
  return [
    // braincase: long, low and broad; flat crown
    ellipsoid('head', hp(0, 0.03, 0.08), [0.122, 0.105, 0.14], { rot: [HROT, 0, 0], blend: 0.05, part: 'head' }),
    // zygomatic arches: very wide
    ellipsoid('head', hp(0, -0.032, 0.125), [0.152, 0.082, 0.086], { blend: 0.06, part: 'head' }),
    // flat, broad forehead plate carrying the eyes
    ellipsoid('head', hp(0, 0.022, 0.172), [0.1, 0.062, 0.058], { blend: 0.05, part: 'head' }),
    // nasal bridge: long, straight, narrowing to the nose
    cone('head', hp(0, 0.036, 0.165), hp(0, -0.01, 0.318), 0.06, 0.042, { blend: 0.045, part: 'head' }),
    // deep muzzle
    ellipsoid('head', hp(0, -0.05, 0.25), [0.074, 0.064, 0.084], { rot: [HROT, 0, 0], blend: 0.045, part: 'muzzle' }),
    // puffy whisker pads: a broad 'W' under the nose (ending at the lip line)
    ...symmetric([ellipsoid('head', hp(0.037, -0.079, 0.284), [0.045, 0.036, 0.046], { blend: 0.024, part: 'muzzle' })]),
    // broad nose leather, overhanging the pads slightly
    ellipsoid('head', hp(0, -0.022, 0.332), [0.033, 0.022, 0.02], { rot: [0.45, 0, 0], blend: 0.014, part: 'nose' }),
    // lower jaw and a small chin
    // (kept below the lip line so the jaw bone owns this surface and the mouth can open)
    ellipsoid('jaw', hp(0, -0.127, 0.19), [0.066, 0.033, 0.1], { rot: [HROT, 0, 0], blend: 0.03, part: 'chin', skinWeight: 2.5, skin: 0.7 }),
    ellipsoid('jaw', hp(0, -0.13, 0.262), [0.04, 0.026, 0.032], { blend: 0.022, part: 'chin', skinWeight: 2.5, skin: 0.7 }),
    // brow ridges over slightly sunken eyes
    ...symmetric([ellipsoid('head', hp(0.057, 0.052, 0.176), [0.045, 0.03, 0.04], { blend: 0.035, part: 'head' })]),
    // cheek ruffs: white side-whiskers flaring back and down from the jaw angle
    ...symmetric([
      ellipsoid('head', hp(0.122, -0.07, 0.07), [0.062 * ruff, 0.095 * ruff, 0.088 * ruff], {
        rot: [0.35, 0.2, -0.35],
        blend: 0.06,
        part: 'ruff',
        noise: fluff(41, 0.007 * ruff),
      }),
      ellipsoid('head', hp(0.092, -0.128, 0.05), [0.052 * ruff, 0.058 * ruff, 0.075 * ruff], {
        rot: [0.5, 0, -0.2],
        blend: 0.06,
        part: 'ruff',
        noise: fluff(42, 0.006 * ruff),
      }),
    ]),
    // rounded ears on the sides of the crown, cupped forward and outward
    ...symmetric([
      ellipsoid('ear.L', hp(0.116, 0.128, 0.035), [0.043, 0.042, 0.021], { rot: [-0.15, 0.55, -0.6], blend: 0.035, part: 'ear', region: 'ears' }),
      ellipsoid('ear.L', hp(0.121, 0.134, 0.049), [0.028, 0.027, 0.011], { rot: [-0.15, 0.55, -0.6], sub: true, blend: 0.008, part: 'ear', region: 'ears' }),
    ]),
  ];
}

/** Thick neck + nape, meshed with the head so the region seam sits on the shoulders. */
function neckPrims(male: boolean): Prim[] {
  const g = male ? 1 : 0.93;
  return [
    cone('neck_1', [0, 0.86, 0.42], [0, 0.945, 0.74], 0.172 * g, 0.148 * g, { blend: 0.08, part: 'neck' }),
    ellipsoid('neck_2', [0, 0.85, 0.66], [0.125 * g, 0.13, 0.11], { blend: 0.08, part: 'neck' }),
    // nape: fills the step between the braincase and the neck
    ellipsoid('neck_2', [0, 0.975, 0.76], [0.118 * g, 0.1, 0.12], { blend: 0.08, part: 'neck' }),
  ];
}

function bodyPrims(male: boolean): Prim[] {
  const g = male ? 1 : 0.93;
  return [
    // deep chest and heavy forequarters
    ellipsoid('chest', [0, 0.745, 0.27], [0.205 * g, 0.27, 0.3], { blend: 0.08, part: 'body' }),
    ellipsoid('chest', [0, 0.965, 0.29], [0.115 * g, 0.075, 0.19], { blend: 0.08, part: 'body' }),
    // long barrel
    ellipsoid('spine_2', [0, 0.775, -0.04], [0.19 * g, 0.235, 0.36], { blend: 0.09, part: 'body' }),
    // loins, slightly tucked waist
    ellipsoid('spine_1', [0, 0.82, -0.36], [0.158 * g, 0.165, 0.3], { blend: 0.1, part: 'body' }),
    // loose belly skin (primordial pouch) swinging under the loins
    ellipsoid('spine_1', [0, 0.635, -0.34], [0.118 * g, 0.075, 0.26], { blend: 0.12, part: 'belly' }),
    // hindquarters
    ellipsoid('hips', [0, 0.83, -0.63], [0.17 * g, 0.18, 0.22], { blend: 0.08, part: 'body' }),
    // shoulder blades (roll under the skin when walking)
    ...symmetric([ellipsoid('FL_scap', [0.128, 0.86, 0.38], [0.078, 0.205, 0.13], { rot: [-0.3, 0, 0], blend: 0.07, part: 'body' })]),
    // thighs and buttocks
    ...symmetric([
      ellipsoid('HL_upper', [0.12, 0.69, -0.62], [0.105, 0.225, 0.19], { rot: [-0.1, 0, 0], blend: 0.08, part: 'body' }),
      ellipsoid('HL_upper', [0.075, 0.74, -0.79], [0.08, 0.17, 0.09], { blend: 0.07, part: 'body' }),
    ]),
  ];
}

function legPrimsLeft(): Prim[] {
  return [
    // front: powerful upper arm and forearm, wide wrist, very large paw
    cone('FL_upper', [0.16, 0.73, 0.46], [0.165, 0.47, 0.33], 0.108, 0.09, { blend: 0.07, part: 'body' }),
    cone('FL_lower', [0.165, 0.49, 0.335], [0.155, 0.14, 0.4], 0.088, 0.06, { blend: 0.045, part: 'leg', region: 'FL' }),
    ellipsoid('FL_lower', [0.163, 0.39, 0.358], [0.083, 0.14, 0.083], { blend: 0.045, part: 'leg', region: 'FL' }),
    cone('FL_foot', [0.155, 0.13, 0.4], [0.155, 0.062, 0.448], 0.06, 0.058, { blend: 0.03, part: 'leg', region: 'FL' }),
    ellipsoid('FL_toe', [0.155, 0.048, 0.485], [0.075, 0.05, 0.085], { blend: 0.03, part: 'paw', region: 'FL' }),
    ...[-0.04, -0.0135, 0.0135, 0.04].map((dx) => sphere('FL_toe', [0.155 + dx, 0.037, 0.546 - Math.abs(dx) * 0.6], 0.029, { blend: 0.02, part: 'paw', region: 'FL' })),
    roundBox('FL_toe', [0.155, -0.05, 0.49], [0.11, 0.05, 0.13], 0.01, { sub: true, blend: 0.01, part: 'paw', region: 'FL' }),
    // hind: thigh, shin, hock, angled metatarsus, paw
    cone('HL_upper', [0.14, 0.83, -0.64], [0.17, 0.54, -0.47], 0.112, 0.082, { blend: 0.09, part: 'body' }),
    cone('HL_lower', [0.17, 0.55, -0.47], [0.15, 0.265, -0.76], 0.084, 0.049, { blend: 0.05, part: 'leg', region: 'HL' }),
    ellipsoid('HL_lower', [0.16, 0.45, -0.58], [0.068, 0.135, 0.084], { rot: [0.6, 0, 0], blend: 0.045, part: 'leg', region: 'HL' }),
    ellipsoid('HL_foot', [0.15, 0.27, -0.775], [0.043, 0.05, 0.048], { blend: 0.025, part: 'leg', region: 'HL' }),
    cone('HL_foot', [0.15, 0.255, -0.76], [0.15, 0.065, -0.68], 0.046, 0.052, { blend: 0.03, part: 'leg', region: 'HL' }),
    ellipsoid('HL_toe', [0.15, 0.045, -0.642], [0.066, 0.046, 0.078], { blend: 0.03, part: 'paw', region: 'HL' }),
    ...[-0.035, -0.012, 0.012, 0.035].map((dx) => sphere('HL_toe', [0.15 + dx, 0.034, -0.59 - Math.abs(dx) * 0.6], 0.025, { blend: 0.018, part: 'paw', region: 'HL' })),
    roundBox('HL_toe', [0.15, -0.05, -0.64], [0.1, 0.05, 0.12], 0.01, { sub: true, blend: 0.01, part: 'paw', region: 'HL' }),
  ];
}

function tailPrims(): Prim[] {
  const t = TAIL;
  return [
    cone('tail_1', [0, 0.88, -0.82], t[1], 0.056, 0.04, { blend: 0.05, part: 'tailbase' }),
    cone('tail_2', t[1], t[2], 0.04, 0.034, { blend: 0.02, part: 'tail', region: 'tail' }),
    cone('tail_3', t[2], t[3], 0.034, 0.031, { blend: 0.02, part: 'tail', region: 'tail' }),
    cone('tail_4', t[3], t[4], 0.031, 0.029, { blend: 0.02, part: 'tail', region: 'tail' }),
    cone('tail_5', t[4], TAIL_TIP, 0.029, 0.026, { blend: 0.02, part: 'tail', region: 'tail' }),
  ];
}

// ---------------------------------------------------------------------------
// Coat

const ORANGE = 0xab5c22;
const ORANGE_BACK = 0x8e4a1b;
const ORANGE_PALE = 0xc48b58;
const CREAM = 0xd6c4a6;
const WHITE = 0xe4dfd6;
const BLACK = 0x15100d;
const NOSE = 0x8a5247;
const LIP = 0x1b1410;

const P_BODY = 0.095; // flank stripe period (m)
const sBody = (y: number, z: number) => (z + 0.17 * (y - 0.85)) / P_BODY;
// haunch arcs centred low in front of the stifle, matched to the body field on the flank
const RC_Y = 0.42, RC_Z = -0.3, P_RUMP = 0.09;
const R_OFF = sBody(0.8, -0.36) - Math.hypot(0.8 - RC_Y, -0.36 - RC_Z) / P_RUMP;
const sRump = (y: number, z: number) => Math.hypot(y - RC_Y, z - RC_Z) / P_RUMP + R_OFF;

const TAIL_LINE: Vec3[] = [[0, 0.93, -0.8], ...TAIL, TAIL_TIP];
const _hit: PolyHit = { s: 0, d: 0, i: 0 };

/** Fade-out gate where two stripe fields cross-blend with weight k (0 in the mixed band). */
const mixGate = (k: number, lo: number, hi: number) => 1 - smooth(lo, lo + 0.12, k) * smooth(hi, hi - 0.12, k);

function tigerCoat(hs: number, eye: Vec3, eyeR: number) {
  const H = (v: Vec3): Vec3 => transformPoint(v, { scale: hs, about: POLL });
  const stop = H(hp(0, 0.03, 0.2)); // centre of the facial stripe field (between the eyes)
  const P_HEAD = 0.042 * hs;
  const browSpot: Vec3 = [eye[0] + 0.006 * hs, eye[1] + 0.036 * hs, eye[2] - 0.006 * hs];
  const earC = H(hp(0.116, 0.128, 0.035));
  const noseC = H(hp(0, -0.02, 0.348));
  // ear facing (left ear): forward and outward
  const efx = 0.5, efy = 0.15, efz = 0.85;
  const tailLen = polyProject(TAIL_TIP[0], TAIL_TIP[1], TAIL_TIP[2], TAIL_LINE, { s: 0, d: 0, i: 0 }).s;
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    const ax = Math.abs(x);
    const sx = x >= 0 ? 1 : -1;
    const n1 = fbm(x * 3, y * 3, z * 3, 3, 4);
    // --- base colour: rich orange, darker along the spine, paling low on the flanks
    c.color.setHex(ORANGE);
    const back = smooth(0.3, 0.95, c.ny) * smooth(0.75, 0.98, y);
    blendHex(c.color, ORANGE_BACK, back * 0.75 + n1 * 0.12);
    blendHex(c.color, ORANGE_PALE, smooth(0.05, -0.45, c.ny) * 0.55);
    // white belly with an irregular boundary
    const bellyEdge = smooth(-0.42, -0.72, c.ny + fbm(x * 5, y * 5, z * 5, 2, 9) * 0.16) * smooth(0.8, 0.62, y);
    const legW = clamp01((c.pw('leg') + c.pw('paw')) * 1.4);
    const innerFace = smooth(-0.15, -0.7, sx * c.nx);
    let white = Math.max(bellyEdge, legW * innerFace * 0.6);
    // throat & chest bib
    const throat = smooth(0.3, 0.55, z) * smooth(0.0, -0.75, c.ny) * (1 - legW);
    white = Math.max(white, throat);
    blendHex(c.color, CREAM, white * 0.6);
    blendHex(c.color, WHITE, white * smooth(0.45, 0.95, white) * 0.85);
    // paws: tawny, toes paler
    const pawW = c.pw('paw');
    if (pawW > 0.3) blendHex(c.color, 0xc39465, smooth(0.3, 0.8, pawW) * 0.35);

    // --- stripe fields
    c.color2.setHex(BLACK);
    // low-frequency warp only (the base mesh is ~8 cm; finer noise would kink the stripes)
    const warp = fbm(x * 1.5, y * 2.8, z * 2.1, 2, 21) * 0.95;
    const sB = sBody(y, z) + warp;
    const sR = sRump(y, z) + warp * 0.9;
    const wR = smooth(-0.32, -0.54, z) * smooth(0.95, 0.7, y + 0.1 * c.ny);
    let s = sB * (1 - wR) + sR * wR;
    // duty: thick high on the flank, a little thinner on the spine, tapering toward the belly
    const prof = smooth(-0.62, -0.02, c.ny) * (1 - 0.3 * smooth(0.6, 1, c.ny));
    let w = 0.52 * prof;
    // breaks, forks and short dashes: smooth noise gates the duty
    const br = fbm(x * 3.6, y * 4.6, z * 2.4, 2, 23) + 0.32 * smooth(0.35, -0.5, c.ny);
    w *= smooth(-0.3, 0.06, br);
    // stripe-to-stripe thickness variation (smooth along the phase)
    w *= 0.66 + 0.68 * (0.5 + 0.5 * fbm(s * 0.27, y * 1.3, sx * 3.1, 1, 24));
    // sparse stripes on the shoulder / upper arm
    const shoulder = Math.exp(-((z - 0.36) ** 2) / 0.02 - ((y - 0.68) ** 2) / 0.05) * smooth(0.05, 0.15, ax);
    w *= 1 - 0.8 * shoulder;
    w *= 1 - 0.9 * bellyEdge;
    w *= 1 - 0.75 * throat;
    // the body field runs horizontally across forward-facing surfaces: no stripes on the chest front
    w *= 1 - smooth(0.4, 0.75, c.nz) * smooth(0.22, 0.38, z) * smooth(0.95, 0.8, y);

    // legs: transverse bars, mostly on the inner / rear faces
    if (legW > 0.02) {
      const front = z > 0;
      const sL = y / 0.085 + warp * 0.5 + (front ? 0.3 : 0.7);
      const rearFace = smooth(0.2, -0.6, c.nz);
      let wl = front ? 0.3 * Math.max(rearFace * 0.7, innerFace) : 0.34 * Math.max(0.4, rearFace, innerFace);
      wl *= smooth(0.07, 0.2, y) * smooth(-0.3, 0.05, fbm(x * 6, y * 6, z * 6, 2, 25));
      s = s * (1 - legW) + sL * legW;
      w = (w * (1 - legW) + wl * legW) * mixGate(legW, 0.22, 0.85);
    }

    // tail: rings, wider toward the black tip
    const tw = c.pw('tail') + c.pw('tailbase');
    if (tw > 0.02) {
      polyProject(x, y, z, TAIL_LINE, _hit);
      const tt = clamp01(_hit.s / tailLen);
      const sT = _hit.s / 0.09 + warp * 0.12;
      const wt = 0.32 + 0.24 * tt;
      const k = smooth(0.15, 0.6, tw);
      s = s * (1 - k) + sT * k;
      w = (w * (1 - k) + wt * k) * mixGate(k, 0.1, 0.9);
      blendHex(c.color, ORANGE_PALE, k * smooth(0.3, 0.8, tt) * 0.45);
      blendHex(c.color, WHITE, k * smooth(-0.1, -0.7, c.ny) * 0.5);
      blendHex(c.color, BLACK, k * smooth(0.88, 0.93, tt));
    }

    // head: arcs around the brow (forehead bars, cheek bars)
    const hw = clamp01(c.pw('head') + c.pw('muzzle') + c.pw('chin') + c.pw('nose') + c.pw('ruff') + c.pw('ear'));
    const eyeD = distSym(x, y, z, eye);
    if (hw > 0.02) {
      const dx = x - stop[0], dy = y - stop[1], dz = z - stop[2];
      const r = Math.sqrt(dx * dx * 1.1 + dy * dy * 1.4 + dz * dz * 0.75);
      const sH = r / P_HEAD + fbm(x * 7, y * 7, z * 7, 2, 27) * 0.35;
      let wh = 0.36;
      wh *= 1 - smooth(0.25, 0.55, c.pw('muzzle') + c.pw('chin') + c.pw('nose'));
      wh *= smooth(0.045 * hs, 0.07 * hs, r);
      wh *= smooth(eyeR + 0.012, eyeR + 0.03, eyeD);
      wh *= 1 - c.pw('ear');
      wh *= smooth(-0.3, 0.05, fbm(x * 9, y * 9, z * 9, 2, 28));
      s = s * (1 - hw) + sH * hw;
      w = (w * (1 - hw) + wh * hw) * mixGate(hw, 0.18, 0.88);
    }
    // region seams (fine detail mesh over the coarse one): keep them stripe-free so
    // the two overlapping surfaces never show different stripes
    const dHead = Math.min(c.pd('neck'), c.pd('head'), c.pd('ruff'), c.pd('muzzle'), c.pd('chin'));
    const dBody = Math.min(c.pd('body'), c.pd('belly'));
    const dLeg = Math.min(c.pd('leg'), c.pd('paw'));
    w *= smooth(0.035, 0.07, Math.abs(dHead - dBody)) * smooth(0.03, 0.06, Math.abs(dLeg - dBody));
    w *= smooth(0.015, 0.035, Math.abs(c.pd('tail') - Math.min(c.pd('tailbase'), dBody)));
    c.s = s;
    c.w = w > 0.045 ? w : 0;

    // --- face paint
    if (hw > 0.1) {
      const mz = c.pw('muzzle') + c.pw('chin');
      // white whisker pads, lips and chin; the nasal bridge stays orange down to the nose
      blendHex(c.color, WHITE, smooth(0.25, 0.6, mz) * smooth(0.62, 0.2, c.ny) * 0.95);
      blendHex(c.color, WHITE, smooth(0.15, 0.5, c.pw('ruff')) * smooth(0.65, -0.2, c.ny + c.nz * 0.3) * 0.9);
      blendHex(c.color, CREAM, smooth(0.05, -0.5, c.ny) * hw * 0.5);
      // white eye spots above and below each eye
      const bs = distSym(x, y, z, browSpot);
      blendHex(c.color, WHITE, smooth(0.026 * hs, 0.012 * hs, bs) * 0.95);
      blendHex(c.color, WHITE, smooth(eyeR + 0.028, eyeR + 0.012, eyeD) * (y < eye[1] ? 0.85 : 0.35));
      // dark eye rim and a short tear line toward the nose
      blendHex(c.color, BLACK, smooth(eyeR + 0.009, eyeR + 0.003, eyeD));
      // nose: rosy leather with a darker rim (painted from the nose ellipsoid)
      const nx0 = x / (0.036 * hs), ny0 = (y - noseC[1]) / (0.026 * hs), nz0 = (z - noseC[2]) / (0.028 * hs);
      const nd = Math.sqrt(nx0 * nx0 + ny0 * ny0 + nz0 * nz0);
      if (nd < 1.25 && c.nz > -0.2) {
        const k = smooth(1.25, 0.95, nd);
        blendHex(c.color, NOSE, k);
        blendHex(c.color, 0x3a2420, k * smooth(0.75, 1.05, nd) * 0.8);
        c.gloss = 0.35 * k;
        c.w = 0;
      }
      // black lip line and whisker-spot rows on the pads
      // black lips; the band between them is the mouth interior, seen when the jaw opens
      const lipY = POLL[1] - 0.108 * hs + (z - (POLL[2] + 0.27 * hs)) * 0.22;
      const lipD = Math.abs(y - lipY);
      if (mz > 0.25 && lipD < 0.02 * hs && z > POLL[2] + 0.14 * hs) {
        blendHex(c.color, LIP, smooth(0.02 * hs, 0.01 * hs, lipD) * 0.92);
        blendHex(c.color, 0x4a1c1a, smooth(0.01 * hs, 0.004 * hs, lipD) * 0.8);
        c.w = 0;
      }
      if (c.pw('muzzle') > 0.4 && y < POLL[1] - 0.045 * hs && y > POLL[1] - 0.095 * hs && z > POLL[2] + 0.25 * hs) {
        const fr = (v: number) => v - Math.floor(v);
        const row = Math.abs(fr((y - POLL[1]) / (0.014 * hs)) - 0.5);
        const col = Math.abs(fr((z - POLL[2]) / (0.016 * hs)) - 0.5);
        if (row < 0.2 && col < 0.2) blendHex(c.color, 0x2e241e, 0.6);
      }
    }
    // ears: black backs with a white central spot; front orange with a pale centre
    if (c.part === 'ear') {
      const facing = (sx * c.nx * efx + c.ny * efy + c.nz * efz) / Math.hypot(efx, efy, efz);
      const backside = smooth(0.1, -0.3, facing);
      const ex = ax - earC[0], ey = y - earC[1], ez = z - earC[2];
      const along = (ex * efx + ey * efy + ez * efz) / Math.hypot(efx, efy, efz);
      const rr = Math.sqrt(Math.max(0, ex * ex + ey * ey + ez * ez - along * along));
      blendHex(c.color, BLACK, backside * 0.94);
      blendHex(c.color, WHITE, backside * smooth(0.022 * hs, 0.013 * hs, rr));
      const front = 1 - backside;
      blendHex(c.color, 0x2a1d16, front * smooth(0.028 * hs, 0.04 * hs, rr) * 0.8);
      blendHex(c.color, 0xdcd2c2, front * smooth(0.028 * hs, 0.012 * hs, rr) * 0.8);
      c.w = 0;
    }
    // legs catch less sun; dusty paws
    c.color.multiplyScalar(1 - 0.08 * legW);
    blendHex(c.color, 0x8a6c50, smooth(0.08, 0.0, y) * 0.3);
    // longer fur on the ruffs and belly fringe
    c.fur = 1 + 1.6 * smooth(0.2, 0.7, c.pw('ruff')) + 0.6 * bellyEdge;
  };
}

// ---------------------------------------------------------------------------
// Animation

const SIDE_LIE: SideLie = { hipsY: 0.24, roll: 1.38, curl: 0.35, reach: 0.72, neckDrop: 0.25 };

type Act = (ctx: AnimCtx, st: PRState, pose: Pose) => void;

const _A = new THREE.Vector3();
/** Place a leg's ankle at the scratch target _A with a pitched paw. */
function placeLegPitch(ctx: AnimCtx, st: PRState, pose: Pose, leg: PRState['legs'][number], pitch: number): void {
  placeLeg(ctx, st, pose, leg, _A, pitch, pitch * 0.6);
}

/** Low-headed stalking walk with rolling shoulder blades. */
const walk: Act = (ctx, st, pose) => {
  actWalk(ctx, st, pose);
  const walkK = st.amp * (1 - st.wg);
  // head carried at or below the back line, swinging gently with the shoulders
  neckHead(ctx, pose, 0.22 * walkK, 0.05 * walkK * Math.sin(st.phase * TAU), -0.12 * walkK, 0);
  tail(ctx, st, pose, 0.12 * walkK, 0);
};

/** Crouched with the forelegs bent, lapping water. */
const drink: Act = (ctx, st, pose) => {
  crouch(ctx, st, pose, 0.33, 0.2, 0.1, 0.02);
  const lap = Math.sin(ctx.time * TAU * 1.6);
  reachMuzzle(ctx, pose, 0.02 + lap * 0.008, 0.2);
  jaw(ctx, pose, 0.08 + 0.06 * Math.max(0, lap));
  tail(ctx, st, pose, 0.15, 0.4);
  ears(ctx, st, pose, 0.15);
};

/** Lying sphinx-like, head down at the food between the forepaws, tearing. */
const eat: Act = (ctx, st, pose) => {
  lie(ctx, st, pose, 'up');
  ctx.rig.fk(pose);
  const t = ctx.time;
  const tear = pulses(t, 2.4, ctx.seed + 3, 0.6, 0.8);
  const chew = Math.sin(t * TAU * 1.8);
  reachMuzzle(ctx, pose, 0.07 + tear * 0.07, 0.35 + chew * 0.04 - tear * 0.25, tear * 0.35 * Math.sin(t * 3.1));
  if (ctx.roles.head >= 0) rotLocal(pose, ctx.roles.head, 'z', tear * 0.3 * Math.sin(t * 7));
  jaw(ctx, pose, 0.1 + 0.12 * Math.max(0, chew) + tear * 0.15);
  ears(ctx, st, pose, 0.1);
};

/** Sleeping flat on one side, with slow breathing and the odd ear twitch. */
const sleep: Act = (ctx, st, pose) => {
  const v = variant(st, 'sleep', ctx.rand);
  if (v < 0.25) {
    // curled sternal sleep, head down on the paws
    lie(ctx, st, pose, 'down');
    return;
  }
  const side = (ctx.seed & 1) === 0 ? 1 : -1;
  const br = 0.025 * Math.sin(ctx.time * TAU * 0.18);
  lieSide(ctx, st, pose, side, SIDE_LIE, br);
  tail(ctx, st, pose, 0.1, 0.25);
  ears(ctx, st, pose, 0.4);
};

/** Rest: sphinx-like lying with the head up most of the time, sometimes sitting upright. */
const rest: Act = (ctx, st, pose) => {
  const v = variant(st, 'sit', ctx.rand);
  if (v < 0.3) {
    actSit(ctx, st, pose);
    return;
  }
  if (v < 0.5) {
    // lying on the side but awake: head raised
    lieSide(ctx, st, pose, ctx.rand > 0.5 ? 1 : -1, { ...SIDE_LIE, curl: 0.15, neckDrop: -0.35 }, 0.02 * Math.sin(ctx.time * TAU * 0.22));
    lookAroundStill(ctx, pose, 0.6);
    tail(ctx, st, pose, 0.1, 0.5);
    ears(ctx, st, pose);
    return;
  }
  lie(ctx, st, pose, 'up');
  // slow blinks of attention: occasional head turns toward sounds
  const turn = 0.4 * glance(ctx.time, 6, ctx.seed + 9);
  neckHead(ctx, pose, 0, turn * 0.5, 0, turn * 0.3);
};

/** Roar: head lowered and thrust forward, chest heaving with each call. */
const roar: Act = (ctx, st, pose) => {
  actCall(ctx, st, pose);
  const at = ctx.actionTime;
  const env = smooth(0.2, 0.8, at) * (1 - smooth(st.p.callDuration - 0.5, st.p.callDuration, at));
  const heave = Math.max(0, Math.sin(at * TAU * 1.3)) * env;
  pose.p[ctx.roles.root].y -= 0.025 * heave;
  neckHead(ctx, pose, 0.12 * env, 0, -0.1 * env * heave, 0);
};

/** Play: stalk-crouch with a wiggling rump, then pounce and pin; repeats. */
const play: Act = (ctx, st, pose) => {
  const T = 3.6;
  const t = ctx.actionTime + ctx.rand * T;
  const u = (t % T) / T;
  const R = ctx.roles;
  // crouch amount: down while stalking, extended during the leap
  const stalk = smooth(0.0, 0.15, u) * (1 - smooth(0.55, 0.6, u)) + smooth(0.82, 1.0, u);
  const leap = smooth(0.55, 0.64, u) * (1 - smooth(0.66, 0.78, u));
  const pin = smooth(0.66, 0.72, u) * (1 - smooth(0.8, 0.95, u));
  const wiggle = Math.sin(t * TAU * 3.2) * smooth(0.25, 0.4, u) * (1 - smooth(0.5, 0.55, u));
  pose.p[R.root].x += 0.03 * wiggle;
  rotParent(pose, R.root, 'y', 0.06 * wiggle);
  pose.p[R.root].z += 0.28 * leap + 0.12 * pin;
  pose.p[R.root].y += 0.16 * leap;
  crouch(ctx, st, pose, 0.3 * stalk + 0.25 * pin - 0.12 * leap, 0.24 * stalk - 0.05 * leap, 0.35 * leap + 0.28 * pin, -0.1 * leap);
  neckHead(ctx, pose, -0.25 * stalk + 0.35 * pin, 0.1 * Math.sin(t * 1.3), 0.15 * stalk - 0.2 * leap, 0);
  jaw(ctx, pose, 0.25 * leap + 0.15 * pin);
  // tail tip twitches while stalking
  tail(ctx, st, pose, -0.2 * leap, 1.2 + stalk);
  ears(ctx, st, pose, 0.3 * stalk);
};

/** Swimming: low in the water, head and a strip of back above the surface. */
const swim: Act = (ctx, st, pose) => {
  const R = ctx.roles;
  const rig = ctx.rig;
  const t = ctx.time;
  pose.p[R.root].y -= st.p.swimSink + 0.012 * Math.sin(t * TAU * 0.6);
  rotParent(pose, R.root, 'x', -0.04);
  rig.fk(pose);
  const cyc = t * (0.75 + st.speed * 0.35);
  for (const leg of st.legs) {
    if (leg.r.scap >= 0) rig.fkBone(pose, leg.r.scap);
    rig.fkBone(pose, leg.r.upper);
    const Hj = rig.wp[leg.r.upper];
    const ph = (cyc + st.p.trot.offsets[leg.idx]) * TAU;
    const rad = leg.legLen * 0.2;
    _A.set(Hj.x, Hj.y - leg.legLen * 0.6 + Math.sin(ph) * rad * 0.5, Hj.z + Math.cos(ph) * rad + (leg.front ? leg.legLen * 0.12 : -leg.legLen * 0.22));
    placeLegPitch(ctx, st, pose, leg, (leg.front ? 0.7 : -0.6) + Math.sin(ph) * 0.4);
  }
  // head held up and level above the water
  neckHead(ctx, pose, -0.55, 0.15 * Math.sin(t * 0.4 + ctx.seed), 0.38, 0);
  ears(ctx, st, pose, 0.2);
  // tail trails behind, floating
  const T = R.tail;
  for (let i = 0; i < T.length; i++) {
    rotLocal(pose, T[i], 'x', i === 0 ? -0.95 : -0.12);
    rotLocal(pose, T[i], 'y', 0.12 * Math.sin(t * 1.4 - i * 0.8));
  }
};

const idle: Act = (ctx, st, pose) => {
  actIdle(ctx, st, pose);
  // big cats hold the head a little low and watch steadily
  neckHead(ctx, pose, 0.08, 0, -0.04, 0);
};

/** Social: head rubbing / sniffing toward a partner, chuffing. */
const socialCat: Act = (ctx, st, pose) => {
  actIdle(ctx, st, pose);
  const t = ctx.time;
  const side = ctx.rand > 0.5 ? 1 : -1;
  const rub = Math.sin(t * TAU * 0.3);
  neckHead(ctx, pose, 0.15 + 0.08 * rub, side * 0.5, 0.05, side * (0.25 + 0.15 * rub), side * 0.2 * rub);
  jaw(ctx, pose, 0.05 * pulses(t, 1.8, ctx.seed + 4, 0.3, 0.7));
};

function tigerDriver(p: QuadParams): AnimDriver<PRState> {
  return {
    init: (ctx) => initPR(ctx, p),
    pre: prePR,
    actions: { idle, walk, eat, drink, sleep, rest, sit: rest, play, social: socialCat, call: roar, swim },
    aliases: { run: 'walk', leave: 'walk' },
    fade: 0.4,
    fades: { sleep: 1.2, rest: 1.0, sit: 1.0, eat: 0.9, drink: 0.7, play: 0.5 },
  };
}

// ---------------------------------------------------------------------------

function design(ctx: DesignContext): CreatureDesign {
  const male = ctx.sex === 'M';
  const hs = male ? 1.1 : 1.0;
  const J = joints(hs);
  const sk = quadSkeleton(J);
  const headT = { scale: hs, about: POLL };
  const head = withRegion(transformPrims(headPrims(male), headT), 'head');
  const prims: Prim[] = [...bodyPrims(male), ...withRegion(neckPrims(male), 'head'), ...head, ...legPrimsLeft(), ...mirrorX(legPrimsLeft()), ...tailPrims()];
  const eyeDir: Vec3 = [-0.12, 0, -1];
  const hit = surfacePoint(head, transformPoint(hp(0.062 + 0.036, 0.022, 0.42), headT), eyeDir, 0.4);
  const eye = seat(hit, eyeDir, 0.0105 * hs);
  const eyeR = 0.0175 * hs;
  const p = quadParams(ctx.def.height, ctx.def.walkSpeed, ctx.def.runSpeed, {
    walk: {
      stride: 1.3, refSpeed: ctx.def.walkSpeed, duty: 0.66, offsets: [0.25, 0.75, 0, 0.5], stepHeight: 0.085,
      bob: 0.008, bobFreq: 2, pitch: 0, roll: 0.035, headBob: 0.025, spineFlex: 0,
    },
    gallop: {
      stride: 3.8, refSpeed: ctx.def.runSpeed, duty: 0.3, offsets: [0.56, 0.46, 0, 0.1], stepHeight: 0.18,
      bob: 0.035, bobFreq: 1, pitch: 0.08, roll: 0.01, headBob: 0.05, spineFlex: 0.22,
    },
    footFollow: 0.6,
    frontFlex: 1.5,
    hindFlex: -0.7,
    frontToeCurl: 0.7,
    hindToeCurl: 0.6,
    push: 0.5,
    scapSwing: 0.75,
    sitStyle: 'cat',
    lie: { hipsY: 0.28, chestY: 0.31, front: 'extend', hindSplay: 0.05, headRest: 0.12 },
    grazeReach: 0.15,
    headCarry: 0.25,
    look: 0.5,
    tailSwish: 0.18,
    tailCarry: 0.05,
    earFlick: 0.35,
    callJaw: 0.6,
    callHead: 0.15,
    callDuration: 3.0,
    swimSink: 1.06,
  });
  return {
    bones: sk.bones,
    roles: sk.roles,
    prims,
    resolution: 1.3,
    regions: {
      head: { scale: 0.46 },
      FL: { scale: 0.42, aniso: [1, 1.7, 1] },
      FR: { scale: 0.42, aniso: [1, 1.7, 1] },
      HL: { scale: 0.42, aniso: [1, 1.7, 1] },
      HR: { scale: 0.42, aniso: [1, 1.7, 1] },
      tail: { scale: 0.38, aniso: [1, 1.6, 1.6] },
      ears: { scale: 0.2, aniso: [1.4, 1.4, 1] },
    },
    coat: tigerCoat(hs, eye, eyeR),
    look: { skin: 'fur', pattern: 'stripes', roughness: 0.9, sheen: 0.38, grain: 0.0075, bump: 0.35, mottle: 0.08 },
    eyes: [{ bone: 'head', pos: eye, radius: eyeR, color: 0x5e4216 }],
    anim: driver(tigerDriver(p)),
    babyScale: 0.28,
    babyHead: 1.35,
    height: 1.1,
    radius: 0.6,
  };
}

const tiger: SpeciesModel = {
  id: 'tiger',
  dimorphic: true,
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.03 : 0.86) * (0.97 + r * 0.06),
};
export default tiger;
