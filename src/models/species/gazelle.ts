// Thomson's gazelle (Eudorcas thomsonii). A small, slender, very fast
// antelope: fine legs with black hooves and knee brushes, a deep narrow
// chest, tucked-up belly, long thin neck, small head with large dark eyes
// and long ears. Coat: cinnamon-fawn back, a bold black band along the lower
// flank, white belly, white rump patch edged by black buttock lines, black
// constantly flicking tail; face with white eye rings, a black cheek stripe
// from the eye to the mouth and a rufous nose blaze. Both sexes carry ringed
// lyre-shaped horns, the female's short and thin.
//
// The flank band, buttock lines, cheek stripes and horn rings are all crisp
// per-pixel stripes: each is its own phase field and the duty is zero
// between them, so the fields never visibly blend.
//
// Behaviour: brisk walk, bounding gallop, stotting (stiff-legged vertical
// bounds) when playing and at moderate running speeds, vigilant grazing,
// alarm call with a stamping forefoot and a snort.

import * as THREE from 'three';
import { cone, ellipsoid, mirrorX, roundBox, symmetric, type Prim, type Vec3 } from '../sdf/prims';
import { quadSkeleton, seat, surfacePoint, withRegion, type QuadJoints } from '../kit/quadruped';
import {
  actIdle,
  actWalk,
  ears,
  jaw,
  lie,
  lookAround,
  neckHead,
  placeLeg,
  quadParams,
  reachMuzzle,
  standingBase,
  standingLift,
  tail,
  type QuadParams,
} from '../anim/quadruped';
import { TAU, clamp, driver, pulses, smooth } from '../anim/util';
import { blendHex, clamp01, fbm } from '../coat/coat';
import { rotLocal, rotParent, type Pose } from '../rig/rig';
import type { AnimCtx, AnimDriver, CoatSample, CreatureDesign, DesignContext, SpeciesModel } from '../types';
import { PRState, ankleFor, crouch, distSym, initPR, polyProject, prePR, stott, type PolyHit, type Stott } from './species-predators-runners/shared';

// ---------------------------------------------------------------------------
// Skeleton

const POLL: Vec3 = [0, 0.955, 0.52];
const hp = (dx: number, dy: number, dz: number): Vec3 => [POLL[0] + dx, POLL[1] + dy, POLL[2] + dz];

const J: QuadJoints = {
  hips: [0, 0.62, -0.3],
  spine: [
    [0, 0.64, -0.1],
    [0, 0.65, 0.08],
  ],
  chest: [0, 0.635, 0.24],
  // the neck pivots low at the front of the chest (C7–T1), not at the withers
  neck: [
    [0, 0.6, 0.34],
    [0, 0.76, 0.41],
    [0, 0.875, 0.47],
  ],
  head: POLL,
  jaw: hp(0, -0.075, 0.045),
  ear: hp(0.03, 0.03, -0.012),
  tail: [
    [0, 0.645, -0.425],
    [0, 0.61, -0.46],
    [0, 0.56, -0.48],
  ],
  front: {
    scap: [0.065, 0.72, 0.25],
    upper: [0.075, 0.53, 0.33],
    lower: [0.077, 0.385, 0.27],
    foot: [0.072, 0.205, 0.29],
    toe: [0.072, 0.055, 0.287],
    contact: [0.072, 0, 0.31],
  },
  hind: {
    upper: [0.072, 0.6, -0.31],
    lower: [0.082, 0.43, -0.205],
    foot: [0.072, 0.27, -0.385],
    toe: [0.072, 0.058, -0.355],
    contact: [0.072, 0, -0.333],
  },
  muzzle: hp(0, -0.16, 0.17),
};

const HEAD_ROT = 0.78; // head axis ≈ 45° below horizontal

/** Horn centre line (left horn) for a horn length scale (1 = adult male, ≈ 0.31 m). */
function hornLine(k: number): Vec3[] {
  const b = hp(0.021, 0.028, 0.05);
  const pts: Vec3[] = [
    [0, 0, 0],
    [0.004, 0.06, -0.03],
    [0.01, 0.12, -0.075],
    [0.016, 0.175, -0.1],
    [0.016, 0.225, -0.09],
    [0.012, 0.26, -0.055],
  ];
  return pts.map((p) => [b[0] + p[0] * (0.6 + 0.4 * k), b[1] + p[1] * k, b[2] + p[2] * k] as Vec3);
}

function hornPrims(male: boolean): Prim[] {
  const k = male ? 1 : 0.42;
  const L = hornLine(k);
  const r0 = male ? 0.0125 : 0.0078;
  const radii = male ? [r0, r0 * 0.95, r0 * 0.8, r0 * 0.62, r0 * 0.46, r0 * 0.32] : [r0, r0 * 0.85, r0 * 0.7, r0 * 0.58, r0 * 0.5, r0 * 0.42];
  const n = male ? L.length : 4;
  const P: Prim[] = [];
  for (let i = 0; i < n - 1; i++) P.push(cone('horn.L', L[i], L[i + 1], radii[i], radii[i + 1], { blend: 0.006, part: 'horn', region: 'horns', skinWeight: 6, skin: 0.5 }));
  return symmetric(P);
}

function headPrims(): Prim[] {
  const P: Prim[] = [
    // small braincase
    ellipsoid('head', hp(0, -0.008, 0.028), [0.039, 0.04, 0.052], { rot: [HEAD_ROT * 0.5, 0, 0], blend: 0.02, part: 'head' }),
    // cheeks / jaw angle
    ellipsoid('head', hp(0, -0.058, 0.055), [0.036, 0.043, 0.05], { rot: [HEAD_ROT, 0, 0], blend: 0.02, part: 'head' }),
    // long tapering face
    cone('head', hp(0, -0.025, 0.06), hp(0, -0.135, 0.158), 0.031, 0.02, { blend: 0.02, part: 'head' }),
    // muzzle and soft lips
    ellipsoid('head', hp(0, -0.152, 0.168), [0.019, 0.022, 0.022], { rot: [HEAD_ROT, 0, 0], blend: 0.012, part: 'muzzle' }),
    // lower jaw
    ellipsoid('jaw', hp(0, -0.11, 0.098), [0.019, 0.017, 0.068], { rot: [HEAD_ROT, 0, 0], blend: 0.012, part: 'chin' }),
    // prominent eye sockets for the big eyes
    ...symmetric([ellipsoid('head', hp(0.03, -0.022, 0.07), [0.018, 0.019, 0.022], { blend: 0.014, part: 'head' })]),
    // nostrils
    ...symmetric([ellipsoid('head', hp(0.011, -0.15, 0.183), [0.004, 0.009, 0.005], { rot: [0.5, 0, -0.3], sub: true, blend: 0.004, part: 'muzzle' })]),
  ];
  return P;
}

function earPrims(): Prim[] {
  // long, narrow, pointed ears held out to the sides and back
  const base = hp(0.03, 0.03, -0.012);
  const rot: Vec3 = [-0.3, 0.4, -0.6];
  const tipDir: Vec3 = [Math.sin(0.6) * 0.95, Math.cos(0.6) * 0.95, -0.22];
  const mid: Vec3 = [base[0] + tipDir[0] * 0.058, base[1] + tipDir[1] * 0.058, base[2] + tipDir[2] * 0.058];
  const left: Prim[] = [
    ellipsoid('ear.L', mid, [0.018, 0.062, 0.0115], { rot, blend: 0.012, part: 'ear', region: 'ears' }),
    cone('ear.L', [base[0] - 0.008, base[1] - 0.012, base[2]], [base[0] + tipDir[0] * 0.02, base[1] + tipDir[1] * 0.02, base[2]], 0.012, 0.013, { blend: 0.012, part: 'ear', region: 'ears' }),
  ];
  return [...left, ...mirrorX(left)];
}

function neckPrims(): Prim[] {
  return [
    cone('neck_1', [0, 0.625, 0.29], [0, 0.785, 0.415], 0.062, 0.042, { blend: 0.035, part: 'neck' }),
    cone('neck_2', [0, 0.78, 0.41], [0, 0.9, 0.48], 0.042, 0.035, { blend: 0.025, part: 'neck' }),
    cone('neck_3', [0, 0.895, 0.478], hp(0, -0.01, 0.0), 0.035, 0.036, { blend: 0.022, part: 'neck' }),
    // throat
    ellipsoid('neck_1', [0, 0.66, 0.37], [0.04, 0.06, 0.05], { blend: 0.035, part: 'neck' }),
  ];
}

function bodyPrims(male: boolean): Prim[] {
  const g = male ? 1 : 0.95;
  return [
    // deep narrow chest
    ellipsoid('chest', [0, 0.535, 0.2], [0.095 * g, 0.145, 0.15], { blend: 0.04, part: 'body' }),
    ellipsoid('chest', [0, 0.655, 0.21], [0.05, 0.045, 0.12], { blend: 0.04, part: 'body' }),
    // barrel tapering to a tucked-up waist
    ellipsoid('spine_2', [0, 0.56, 0.0], [0.105 * g, 0.125, 0.2], { blend: 0.05, part: 'body' }),
    ellipsoid('spine_1', [0, 0.6, -0.17], [0.086 * g, 0.085, 0.16], { blend: 0.05, part: 'body' }),
    // rounded croup and rump
    ellipsoid('hips', [0, 0.605, -0.32], [0.088 * g, 0.1, 0.12], { blend: 0.04, part: 'rump' }),
    ...symmetric([
      ellipsoid('FL_scap', [0.064, 0.585, 0.255], [0.034, 0.1, 0.058], { rot: [-0.4, 0, 0], blend: 0.03, part: 'body' }),
      ellipsoid('HL_upper', [0.058, 0.52, -0.3], [0.048, 0.115, 0.085], { rot: [-0.15, 0, 0], blend: 0.035, part: 'rump' }),
      ellipsoid('HL_upper', [0.04, 0.54, -0.38], [0.04, 0.09, 0.045], { blend: 0.03, part: 'rump' }),
    ]),
  ];
}

function legPrimsLeft(): Prim[] {
  const f = J.front, h = J.hind;
  return [
    // front: upper arm in the body, slim forearm, knee (with brush), cannon, fetlock, pastern, hoof
    cone('FL_upper', f.upper, f.lower, 0.036, 0.03, { blend: 0.025, part: 'body' }),
    cone('FL_lower', [0.077, 0.395, 0.272], [0.072, 0.21, 0.29], 0.025, 0.0135, { blend: 0.012, part: 'leg', region: 'FL' }),
    ellipsoid('FL_lower', [0.076, 0.33, 0.276], [0.021, 0.055, 0.023], { blend: 0.012, part: 'leg', region: 'FL' }),
    ellipsoid('FL_foot', [0.072, 0.203, 0.292], [0.0135, 0.019, 0.016], { blend: 0.008, part: 'knee', region: 'FL' }),
    cone('FL_foot', [0.072, 0.195, 0.29], [0.072, 0.064, 0.287], 0.0105, 0.0095, { blend: 0.007, part: 'leg', region: 'FL' }),
    ellipsoid('FL_toe', [0.072, 0.055, 0.289], [0.0115, 0.013, 0.0125], { blend: 0.006, part: 'leg', region: 'FL' }),
    cone('FL_toe', [0.072, 0.05, 0.292], [0.072, 0.022, 0.305], 0.0095, 0.011, { blend: 0.006, part: 'leg', region: 'FL' }),
    cone('FL_toe', [0.072, 0.022, 0.305], [0.072, 0.006, 0.316], 0.012, 0.013, { blend: 0.005, part: 'hoof', region: 'FL' }),
    roundBox('FL_toe', [0.072, -0.03, 0.31], [0.04, 0.03, 0.05], 0.004, { sub: true, blend: 0.004, part: 'hoof', region: 'FL' }),
    // hind: thigh in the body, gaskin, hock, long cannon, fetlock, pastern, hoof
    cone('HL_upper', h.upper, h.lower, 0.045, 0.034, { blend: 0.035, part: 'rump' }),
    cone('HL_lower', [0.082, 0.44, -0.207], [0.072, 0.27, -0.385], 0.03, 0.013, { blend: 0.014, part: 'leg', region: 'HL' }),
    ellipsoid('HL_lower', [0.078, 0.39, -0.255], [0.022, 0.05, 0.03], { rot: [0.7, 0, 0], blend: 0.012, part: 'leg', region: 'HL' }),
    ellipsoid('HL_foot', [0.072, 0.272, -0.392], [0.012, 0.018, 0.017], { blend: 0.007, part: 'leg', region: 'HL' }),
    cone('HL_foot', [0.072, 0.265, -0.385], [0.072, 0.068, -0.357], 0.0105, 0.0095, { blend: 0.007, part: 'leg', region: 'HL' }),
    ellipsoid('HL_toe', [0.072, 0.058, -0.357], [0.0115, 0.013, 0.0125], { blend: 0.006, part: 'leg', region: 'HL' }),
    cone('HL_toe', [0.072, 0.052, -0.354], [0.072, 0.022, -0.343], 0.0095, 0.011, { blend: 0.006, part: 'leg', region: 'HL' }),
    cone('HL_toe', [0.072, 0.022, -0.343], [0.072, 0.006, -0.333], 0.012, 0.013, { blend: 0.005, part: 'hoof', region: 'HL' }),
    roundBox('HL_toe', [0.072, -0.03, -0.335], [0.04, 0.03, 0.05], 0.004, { sub: true, blend: 0.004, part: 'hoof', region: 'HL' }),
  ];
}

function tailPrims(): Prim[] {
  const t = J.tail;
  return [
    cone('tail_1', [0, 0.645, -0.405], t[1], 0.017, 0.013, { blend: 0.015, part: 'tail', region: 'tail' }),
    cone('tail_2', t[1], t[2], 0.013, 0.012, { blend: 0.008, part: 'tail', region: 'tail' }),
    ellipsoid('tail_3', [0, 0.535, -0.485], [0.016, 0.045, 0.014], {
      blend: 0.01,
      part: 'tail',
      region: 'tail',
      noise: { amp: 0.003, freq: 120, stretch: [1, 0.15, 1], ridged: true, octaves: 2, seed: 7 },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Coat

const FAWN = 0xac733f;
const FAWN_BACK = 0x94603a;
const FAWN_PALE = 0xc79a69;
const WHITE = 0xe6e0d4;
const BLACK = 0x17120f;
const RUFOUS = 0x7f4a28;
const HORN = 0x2e2924;
const HORN_RING = 0x1a1612;

/** Centre line of the black flank band (y as a function of z). */
const bandY = (z: number) => 0.5 - 0.022 * Math.cos(((z + 0.02) / 0.3) * 1.3);
const _hit: PolyHit = { s: 0, d: 0, i: 0 };

function gazelleCoat(male: boolean, eye: Vec3, eyeR: number) {
  const horn = hornLine(male ? 1 : 0.42);
  const mouth = hp(0.017, -0.14, 0.135);
  // stripe starts at the front corner of the eye
  const ex = eye[0] - 0.004, ey = eye[1] - 0.006, ez = eye[2] + 0.008;
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    const ax = Math.abs(x);
    const n1 = fbm(x * 5, y * 5, z * 5, 2, 61);
    c.color.setHex(FAWN);
    blendHex(c.color, FAWN_BACK, smooth(0.3, 0.95, c.ny) * 0.5 + n1 * 0.1);
    c.color2.setHex(BLACK);
    const legW = clamp01((c.pw('leg') + c.pw('hoof') + c.pw('knee')) * 1.4);
    const hw = clamp01(c.pw('head') + c.pw('muzzle') + c.pw('chin') + c.pw('ear'));
    const hornW = c.pw('horn');
    let s = 0;
    let w = 0;

    // --- trunk: pale band above the black flank band, white belly below it
    const by = bandY(z);
    const along = smooth(0.29, 0.22, z) * smooth(-0.27, -0.17, z); // band runs elbow → stifle
    const below = y < by;
    const bodyK = (1 - hw) * (1 - legW) * (1 - hornW);
    if (bodyK > 0.01) {
      // pale fawn stripe above the dark band
      blendHex(c.color, FAWN_PALE, smooth(0.05, 0.02, Math.abs(y - (by + 0.05))) * along * 0.6 * bodyK);
      // white underside: below the band, and the whole chest / belly floor
      const under = clamp01((below ? smooth(by + 0.004, by - 0.012, y) : 0) * along + smooth(-0.55, -0.85, c.ny));
      blendHex(c.color, WHITE, under * bodyK);
      // the band itself: crisp stripe (period 0.2 m, centred on bandY)
      s = (y - by) / 0.2;
      w = 0.27 * along * smooth(0.085, 0.06, Math.abs(y - by)) * bodyK;
      // white rump patch, edged by a black buttock line
      const rumpEdgeZ = -0.37 + (0.6 - y) * 0.25;
      const rearness = smooth(rumpEdgeZ + 0.03, rumpEdgeZ - 0.02, z) * smooth(0.4, 0.5, y) * smooth(0.7, 0.62, y);
      blendHex(c.color, WHITE, rearness * smooth(-0.6, 0.1, -c.nz) * bodyK);
      const sb = (z - rumpEdgeZ) / 0.18;
      const wb = 0.11 * smooth(0.025, 0.045, ax) * smooth(0.43, 0.5, y) * smooth(0.66, 0.6, y) * smooth(0.12, 0.04, Math.abs(z - rumpEdgeZ));
      if (z < -0.25) {
        const k = smooth(-0.25, -0.3, z);
        s = s * (1 - k) + sb * k;
        w = w * (1 - k) + wb * k;
      }
    }
    // --- legs: fawn, paler inside; dark knee brushes; black hooves
    if (legW > 0.05) {
      blendHex(c.color, FAWN_PALE, legW * smooth(-0.1, -0.7, Math.sign(x) * c.nx) * 0.6);
      blendHex(c.color, 0x2e221a, smooth(0.25, 0.6, c.pw('knee')) * smooth(-0.2, 0.5, c.nz) * 0.85);
      if (c.part === 'hoof') blendHex(c.color, 0x1d1915, smooth(0.03, 0.02, y));
      w *= 1 - legW;
    }
    // --- tail: black
    const tw = c.pw('tail');
    if (tw > 0.1) blendHex(c.color, BLACK, smooth(0.1, 0.45, tw));
    // --- head: white eye ring, white line above a black eye-to-mouth stripe, rufous blaze
    if (hw > 0.05) {
      const ed = distSym(x, y, z, eye);
      // fawn face with a rufous wash over the forehead / nose bridge
      blendHex(c.color, RUFOUS, smooth(0.03, 0.01, ax) * smooth(-0.2, 0.5, c.ny + c.nz) * 0.55 * hw);
      // white chin, lips and throat (true underside only)
      blendHex(c.color, WHITE, smooth(-0.45, -0.8, c.ny) * hw * 0.85);
      blendHex(c.color, WHITE, smooth(0.35, 0.7, c.pw('chin')) * 0.7);
      // white eye ring
      blendHex(c.color, WHITE, smooth(eyeR + 0.009, eyeR + 0.004, ed) * 0.9);
      // eye → mouth-corner segment
      const sx = ax - ex, sy = y - ey, sz = z - ez;
      const dx = mouth[0] - ex, dy = mouth[1] - ey, dz = mouth[2] - ez;
      const L2 = dx * dx + dy * dy + dz * dz;
      const tu = (sx * dx + sy * dy + sz * dz) / L2;
      const t = clamp(tu, 0, 1);
      const px = sx - dx * t, py = sy - dy * t, pz = sz - dz * t;
      const dist = Math.sqrt(px * px + py * py + pz * pz);
      // white line just above (toward the nose bridge) the black stripe
      const above = py * 0.7 + pz * 0.7 > 0 ? 1 : 0;
      blendHex(c.color, WHITE, smooth(0.007, 0.003, Math.abs(dist - 0.011)) * above * smooth(0.02, 0.15, t) * smooth(1, 0.75, t) * 0.85);
      // the black stripe: signed distance to the eye→mouth line in the side plane
      // (a linear field interpolates exactly → straight crisp edges), ≈ 1.3 cm wide
      const nl = Math.hypot(dy, dz);
      const sd = (sy * -dz + sz * dy) / nl;
      const sh = sd / 0.12;
      const wh = 0.11 * smooth(-0.02, 0.06, tu) * smooth(1.06, 0.92, tu) * (1 - 0.3 * t) * smooth(0.045, 0.03, Math.abs(sd)) * smooth(0.005, 0.015, ax);
      s = s * (1 - hw) + sh * hw;
      w = w * (1 - hw) + wh * hw;
      // dark nose leather
      if (c.pw('muzzle') > 0.3 && c.nz > 0.2 && y > POLL[1] - 0.17) blendHex(c.color, 0x2c2420, smooth(0.3, 0.7, c.pw('muzzle')) * smooth(0.2, 0.7, c.nz) * 0.7);
      // ears: fawn backs, white inner fur, dark tips and rims
      if (c.part === 'ear') {
        // inner (front / outward) face white-haired, dark rim toward the tip
        const inner = smooth(0.1, 0.6, c.nz * 0.8 + Math.sign(x) * c.nx * 0.4);
        blendHex(c.color, WHITE, inner * 0.65);
        blendHex(c.color, 0x2a2018, smooth(POLL[1] + 0.1, POLL[1] + 0.125, y) * 0.75);
        w = 0;
      }
    }
    // --- horns: blackish, with crisp raised rings except near the tips
    if (hornW > 0.05) {
      polyProject(ax, y, z, horn, _hit);
      const tLen = _hit.s;
      const k = smooth(0.2, 0.6, hornW);
      blendHex(c.color, HORN, k);
      c.color2.setHex(HORN_RING);
      const ringEnd = male ? 0.22 : 0.09;
      s = s * (1 - k) + (tLen / (male ? 0.012 : 0.01)) * k;
      w = w * (1 - k) + 0.32 * smooth(ringEnd, ringEnd - 0.03, tLen) * smooth(0.005, 0.015, tLen) * k;
      blendHex(c.color, 0x6b6157, smooth(ringEnd - 0.02, ringEnd + 0.05, tLen) * 0.4 * k);
      c.gloss = 0.15 * k;
    }
    c.s = s;
    c.w = w > 0.03 ? w : 0;
    c.fur = 1 + 0.6 * smooth(0.3, 0.7, c.pw('knee')) + 1.5 * smooth(0.3, 0.7, tw);
  };
}

// ---------------------------------------------------------------------------
// Animation

type Act = (ctx: AnimCtx, st: PRState, pose: Pose) => void;

const STOTT: Stott = { period: 0.62, height: 0.24, contact: 0.2, arch: 0.3 };
const _A = new THREE.Vector3();
const _C = new THREE.Vector3();

/** Stotting pose layer: stiff-legged bounds; `amount` 0..1, `forward` metres per bound. */
function stotting(ctx: AnimCtx, st: PRState, pose: Pose, amount: number, forward: number, phase: number): void {
  stott(ctx, st, pose, phase, STOTT, forward, amount);
  // head up, ears out, tail up and flared
  neckHead(ctx, pose, -0.2 * amount, 0, 0.12 * amount, 0);
  tail(ctx, st, pose, -0.9 * amount, 0.5);
  ears(ctx, st, pose, 0.25 * amount);
}

/** 0..1 weight of stotting at the current ground speed (between the trot and a full gallop). */
function stottWeight(st: PRState): number {
  const v = st.speed;
  return smooth(st.p.trotSpeed * 0.75, st.p.trotSpeed * 1.0, v) * (1 - smooth(st.p.gallop.refSpeed * 0.45, st.p.gallop.refSpeed * 0.6, v));
}

/** driver.pre: gait + variants, and the stott phase (one bound per period). */
function pre(ctx: AnimCtx, st: PRState): void {
  prePR(ctx, st);
  st.b = (st.b + ctx.dt / STOTT.period) % 1;
}

/** Run: gallop at speed; at moderate speeds the gazelle stotts instead. */
const walk: Act = (ctx, st, pose) => {
  const k = stottWeight(st);
  if (k < 0.98) actWalk(ctx, st, pose);
  if (k > 0.02) {
    // stotting alone stands on the (juvenile) legs without the walk's body
    if (k >= 0.98) standingLift(st, pose, ctx.roles.root);
    stotting(ctx, st, pose, k, st.speed * STOTT.period, st.b);
  }
};

/** Play: stotting in place, with pauses and quick turns of the head. */
const play: Act = (ctx, st, pose) => {
  const t = ctx.actionTime + ctx.rand * 5;
  const cyc = 4.2;
  const u = (t % cyc) / cyc;
  // three bounds, then a pause
  const on = u < 0.45 ? 1 : 0;
  const ph = on ? (t % STOTT.period) / STOTT.period : 0;
  if (on) {
    standingLift(st, pose, ctx.roles.root);
    stotting(ctx, st, pose, 1, 0, ph);
  } else {
    actIdle(ctx, st, pose);
    neckHead(ctx, pose, -0.15, 0.4 * Math.sin(t * 1.7), 0, 0.2);
    tail(ctx, st, pose, -0.6, 1.5);
  }
};

/** Alarm: head high and ears forward, a forefoot stamps, the head jerks with each snort. */
const call: Act = (ctx, st, pose) => {
  standingBase(ctx, st, pose);
  const at = ctx.actionTime;
  const env = smooth(0, 0.4, at) * (1 - smooth(st.p.callDuration - 0.4, st.p.callDuration, at));
  const stampT = (at % 0.9) / 0.9;
  const stamp = Math.sin(clamp(stampT / 0.5, 0, 1) * Math.PI) * env;
  const leg = st.legs[ctx.rand > 0.5 ? 0 : 1];
  _C.copy(leg.r.contact);
  _C.y += 0.07 * stamp;
  _C.z += 0.015 * stamp;
  ctx.rig.fkBone(pose, leg.r.upper);
  placeLeg(ctx, st, pose, leg, ankleFor(leg, _C, 0.9 * stamp, 0.8 * stamp, _A), 0.9 * stamp, 0.8 * stamp);
  const snort = pulses(at, 0.9, 5, 0.25, 1) * env;
  neckHead(ctx, pose, -0.3 * env, 0, -0.05 * env + 0.12 * snort, 0);
  jaw(ctx, pose, 0.04 * snort);
  tail(ctx, st, pose, -0.5 * env, 1.5);
  ears(ctx, st, pose, -0.15 * env);
};

/** Idle: alert look-around with quick ear flicks. */
const idle: Act = (ctx, st, pose) => {
  actIdle(ctx, st, pose);
};

/** Slope the neck base down first so the reach keeps the long neck straight (no swan curve). */
function slopeNeck(ctx: AnimCtx, pose: Pose, a: number): void {
  const N = ctx.roles.neck;
  if (N.length) rotLocal(pose, N[0], 'x', a);
  if (N.length > 1) rotLocal(pose, N[1], 'x', a * 0.3);
}

/** Grazing with frequent vigilance checks (head up, ears forward). */
const eat: Act = (ctx, st, pose) => {
  standingBase(ctx, st, pose);
  ctx.rig.fk(pose);
  slopeNeck(ctx, pose, 0.3);
  // every few seconds the head comes up to scan for predators, chewing
  const look = pulses(ctx.time, 4.5, ctx.seed + 70, 1.4, 0.55);
  const chew = Math.sin(ctx.time * TAU * 1.6);
  reachMuzzle(ctx, pose, 0.03 + look * 0.45, 0.2 + chew * 0.03, 0.12 * Math.sin(ctx.time * 0.5 + ctx.seed), 1.75);
  jaw(ctx, pose, 0.04 + 0.04 * Math.max(0, chew));
  tail(ctx, st, pose, 0, 1);
  ears(ctx, st, pose, -0.1 * look);
};

/** Drinking: forelegs splayed a little to bring the muzzle down, lapping. */
const drink: Act = (ctx, st, pose) => {
  crouch(ctx, st, pose, 0.05, 0.0, 0.06, 0);
  slopeNeck(ctx, pose, 0.3);
  const lap = Math.sin(ctx.time * TAU * 1.1);
  reachMuzzle(ctx, pose, 0.0 + lap * 0.008, 0.25, 0, 1.8);
  jaw(ctx, pose, 0.03 + 0.03 * Math.max(0, lap));
  tail(ctx, st, pose, 0, 0.6);
  ears(ctx, st, pose, 0.2);
};

/** Constant tail flicking (a Thomson's gazelle hallmark), on top of every action. */
function post(ctx: AnimCtx, st: PRState, pose: Pose): void {
  const T = ctx.roles.tail;
  if (!T.length || ctx.action === 'sleep') return;
  const burst = smooth(0.2, 0.6, Math.sin(ctx.time * 0.9 + ctx.seed) * 0.5 + 0.5);
  const wag = Math.sin(ctx.time * TAU * 3.4) * 0.35 * burst;
  for (let i = 0; i < T.length; i++) rotLocal(pose, T[i], 'y', wag * (0.5 + i * 0.4) * (1 - st.amp * 0.5));
}

function gazelleDriver(p: QuadParams): AnimDriver<PRState> {
  return {
    init: (ctx) => initPR(ctx, p),
    pre,
    actions: {
      idle,
      walk,
      eat,
      drink,
      sleep: (ctx, st, pose) => {
        lieTucked(ctx, st, pose, true);
      },
      rest: (ctx, st, pose) => {
        lieTucked(ctx, st, pose, false);
      },
      play,
      social: (ctx, st, pose) => {
        actIdle(ctx, st, pose);
        const side = ctx.rand > 0.5 ? 1 : -1;
        neckHead(ctx, pose, 0.3 + 0.08 * Math.sin(ctx.time * TAU * 0.4), side * 0.5, 0.2, side * 0.25);
      },
      call,
      swim: (ctx, st, pose) => {
        // gazelles avoid deep water; if forced, a frantic paddle with the head held high
        const R = ctx.roles;
        pose.p[R.root].y -= st.p.swimSink;
        rotParent(pose, R.root, 'x', -0.12);
        ctx.rig.fk(pose);
        standingSwim(ctx, st, pose);
        neckHead(ctx, pose, -0.55, 0, 0.3, 0);
      },
    },
    post,
    aliases: { run: 'walk', leave: 'walk', sit: 'rest' },
    fade: 0.3,
    fades: { sleep: 1.0, rest: 0.9, play: 0.25, call: 0.25 },
    transitions: { 'sleep>*': 1.0, 'rest>*': 0.9, 'sleep>rest': 0.8, 'rest>sleep': 0.8 },
  };
}

/** Sternal lying with the legs folded under; asleep the head rests turned back toward the flank. */
function lieTucked(ctx: AnimCtx, st: PRState, pose: Pose, asleep: boolean): void {
  lie(ctx, st, pose, asleep ? 'down' : 'up');
  if (!asleep) {
    lookAround(ctx, st, pose, 0.8);
    neckHead(ctx, pose, -0.25, 0, 0.1, 0);
  }
}

function standingSwim(ctx: AnimCtx, st: PRState, pose: Pose): void {
  const rig = ctx.rig;
  const cyc = ctx.time * 2.2;
  for (const leg of st.legs) {
    rig.fkBone(pose, leg.r.upper);
    const Hj = rig.wp[leg.r.upper];
    const ph = (cyc + st.p.trot.offsets[leg.idx]) * TAU;
    _A.set(Hj.x, Hj.y - leg.scaledLen * 0.6 + Math.sin(ph) * 0.04, Hj.z + Math.cos(ph) * 0.06);
    placeLeg(ctx, st, pose, leg, _A, (leg.front ? 0.8 : -0.5) + Math.sin(ph) * 0.4, 0.5);
  }
}

// ---------------------------------------------------------------------------

function design(ctx: DesignContext): CreatureDesign {
  const male = ctx.sex === 'M';
  // horn bones (children of the head, at the horn bases) so horns can grow with age
  const hb = hornLine(1)[0];
  const sk = quadSkeleton({
    ...J,
    extra: [
      { name: 'horn.L', parent: 'head', pos: hb },
      { name: 'horn.R', parent: 'head', pos: [-hb[0], hb[1], hb[2]] },
    ],
  });
  const head = withRegion(headPrims(), 'head');
  const prims: Prim[] = [
    ...bodyPrims(male),
    ...withRegion(neckPrims(), 'head'),
    ...head,
    ...earPrims(),
    ...hornPrims(male),
    ...legPrimsLeft(),
    ...mirrorX(legPrimsLeft()),
    ...tailPrims(),
  ];
  // big, slightly protruding eyes on the sides of the head
  const eyeDir: Vec3 = [-1, 0, -0.35];
  const hit = surfacePoint(head, hp(0.15, -0.022, 0.11), eyeDir, 0.2);
  const eyeR = 0.0135;
  const eye = seat(hit, eyeDir, 0.0085);
  const p = quadParams(ctx.def.height, ctx.def.walkSpeed, ctx.def.runSpeed, {
    walk: {
      stride: 0.78, refSpeed: ctx.def.walkSpeed, duty: 0.62, offsets: [0.25, 0.75, 0, 0.5], stepHeight: 0.06,
      bob: 0.005, bobFreq: 2, pitch: 0, roll: 0.015, headBob: 0.05, spineFlex: 0,
    },
    gallop: {
      stride: 2.6, refSpeed: ctx.def.runSpeed, duty: 0.28, offsets: [0.5, 0.58, 0, 0.1], stepHeight: 0.12,
      bob: 0.025, bobFreq: 1, pitch: 0.08, roll: 0.01, headBob: 0.06, spineFlex: 0.14,
    },
    look: 0.6,
    grazeReach: 0.12,
    headCarry: 0.12,
    tailSwish: 0.25,
    tailCarry: -0.5,
    earFlick: 0.75,
    callJaw: 0.1,
    callHead: -0.3,
    callDuration: 2.8,
    lie: { hipsY: 0.24, chestY: 0.25, front: 'tuck', hindSplay: 0.03, headRest: 0.06 },
    swimSink: 0.55,
  });
  return {
    bones: sk.bones,
    roles: sk.roles,
    prims,
    resolution: 0.75,
    regions: {
      head: { scale: 0.44 },
      ears: { scale: 0.2 },
      horns: { scale: male ? 0.2 : 0.13 },
      FL: { scale: 0.3, aniso: [1, 2.4, 1] },
      FR: { scale: 0.3, aniso: [1, 2.4, 1] },
      HL: { scale: 0.3, aniso: [1, 2.4, 1] },
      HR: { scale: 0.3, aniso: [1, 2.4, 1] },
      tail: { scale: 0.35, aniso: [1, 1.5, 1] },
    },
    coat: gazelleCoat(male, eye, eyeR),
    look: { skin: 'fur', pattern: 'stripes', roughness: 0.86, sheen: 0.32, grain: 0.0045, bump: 0.28, mottle: 0.06 },
    eyes: [{ bone: 'head', pos: eye, radius: eyeR, color: 0x120b07 }],
    anim: driver(gazelleDriver(p)),
    babyScale: 0.45,
    babyHead: 1.3,
    // fawns stand on long legs
    babyLegs: 1.3,
    // fawns are hornless: the horns grow in about their bases
    babyBones: { 'horn.L': 0.04, 'horn.R': 0.04 },
    height: male ? 0.95 : 0.85,
    radius: 0.4,
  };
}

const gazelle: SpeciesModel = {
  id: 'gazelle',
  dimorphic: true,
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.03 : 0.93) * (0.96 + r * 0.08),
};
export default gazelle;
