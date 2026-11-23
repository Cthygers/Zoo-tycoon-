// Grizzly bear (Ursus arctos horribilis). Heavy plantigrade omnivore: a
// prominent muscular shoulder hump (the highest point of the back), a big
// broad head with a dished (concave) face profile, rounded furry ears, small
// eyes, long pale foreclaws and short thick legs. Brown shaggy coat with
// grizzled silver-blond tips over the hump and back, darker legs and a
// lighter muzzle. Calls by rearing up on the hind legs.

import { cone, ellipsoid, symmetric, type Prim, type Vec3 } from '../sdf/prims';
import { seat, surfacePoint, withRegion, type QuadJoints } from '../kit/quadruped';
import { blendHex, clamp01, fbm, smooth } from '../coat/coat';
import type { CoatSample, CreatureDesign, DesignContext, SpeciesModel } from '../types';
import { bearDesign, bearQuad, type BearLegSpec } from './species-predators-runners/bear';
import { distSym, ellDist } from './species-predators-runners/shared';

const POLL: Vec3 = [0, 0.9, 0.83];
const hp = (dx: number, dy: number, dz: number): Vec3 => [POLL[0] + dx, POLL[1] + dy, POLL[2] + dz];
const NOSE_C = hp(0, -0.046, 0.395);

const J: QuadJoints = {
  hips: [0, 0.86, -0.5],
  spine: [
    [0, 0.93, -0.22],
    [0, 0.98, 0.05],
  ],
  chest: [0, 0.98, 0.3],
  neck: [
    [0, 0.93, 0.52],
    [0, 0.91, 0.68],
  ],
  head: POLL,
  jaw: hp(0, -0.1, 0.1),
  ear: hp(0.095, 0.1, 0.01),
  tail: [
    [0, 0.86, -0.76],
    [0, 0.8, -0.82],
  ],
  front: {
    scap: [0.15, 1.0, 0.36],
    upper: [0.19, 0.7, 0.42],
    lower: [0.19, 0.43, 0.33],
    foot: [0.185, 0.12, 0.39],
    toe: [0.185, 0.04, 0.5],
    contact: [0.185, 0, 0.54],
  },
  hind: {
    upper: [0.17, 0.8, -0.52],
    lower: [0.19, 0.47, -0.35],
    foot: [0.175, 0.13, -0.53],
    toe: [0.175, 0.04, -0.33],
    contact: [0.175, 0, -0.29],
  },
  muzzle: hp(0, -0.07, 0.39),
};

const shag = (seed: number, amp: number) => ({ amp, freq: 16, octaves: 2, stretch: [1, 0.5, 1] as Vec3, seed });

function trunkPrims(): Prim[] {
  return [
    // deep chest and forequarters
    ellipsoid('chest', [0, 0.7, 0.22], [0.26, 0.31, 0.31], { blend: 0.1, part: 'body' }),
    // the shoulder hump: a mass of digging muscle above the shoulder blades
    ellipsoid('chest', [0, 1.01, 0.28], [0.16, 0.175, 0.25], { blend: 0.12, part: 'hump' }),
    ellipsoid('chest', [0, 0.93, 0.4], [0.2, 0.15, 0.15], { blend: 0.1, part: 'hump' }),
    // barrel and a round belly
    ellipsoid('spine_2', [0, 0.72, -0.06], [0.27, 0.29, 0.34], { blend: 0.1, part: 'body' }),
    ellipsoid('spine_1', [0, 0.6, -0.26], [0.23, 0.22, 0.28], { blend: 0.12, part: 'belly' }),
    // loins dip behind the hump; rump lower than the hump
    ellipsoid('spine_1', [0, 0.77, -0.28], [0.2, 0.16, 0.26], { blend: 0.1, part: 'body' }),
    ellipsoid('hips', [0, 0.755, -0.55], [0.225, 0.21, 0.25], { blend: 0.1, part: 'body' }),
    // scapulae and thighs
    ...symmetric([
      ellipsoid('FL_scap', [0.16, 0.8, 0.33], [0.1, 0.22, 0.15], { rot: [-0.3, 0, 0], blend: 0.08, part: 'body' }),
      ellipsoid('HL_upper', [0.155, 0.64, -0.47], [0.12, 0.22, 0.19], { rot: [-0.1, 0, 0], blend: 0.09, part: 'body' }),
    ]),
  ];
}

/** Neck + head + ears (neck meshed with the head so the region seam sits on the shoulders). */
function headPrims(): Prim[] {
  const head: Prim[] = [
    // short thick neck carried low, with a shaggy ruff
    cone('neck_1', [0, 0.86, 0.42], [0, 0.86, 0.72], 0.225, 0.175, { blend: 0.1, part: 'neck' }),
    ellipsoid('neck_2', [0, 0.8, 0.66], [0.15, 0.15, 0.12], { blend: 0.09, part: 'neck' }),
    // broad domed braincase
    ellipsoid('head', hp(0, 0.02, 0.06), [0.13, 0.12, 0.15], { rot: [0.15, 0, 0], blend: 0.06, part: 'head' }),
    // wide furry cheeks
    ellipsoid('head', hp(0, -0.05, 0.085), [0.158, 0.1, 0.115], { blend: 0.07, part: 'head', noise: shag(7, 0.006) }),
    // forehead bulging above the muzzle: the concave 'dished' profile
    ellipsoid('head', hp(0, 0.045, 0.165), [0.092, 0.072, 0.07], { blend: 0.05, part: 'head' }),
    // muzzle: lower than the brow, tapering
    cone('head', hp(0, -0.032, 0.205), hp(0, -0.058, 0.365), 0.078, 0.052, { blend: 0.045, part: 'muzzle' }),
    ellipsoid('head', hp(0, -0.082, 0.27), [0.062, 0.045, 0.085], { blend: 0.04, part: 'muzzle' }),
    // nose leather
    ellipsoid('head', hp(0, -0.046, 0.392), [0.036, 0.028, 0.022], { rot: [0.3, 0, 0], blend: 0.014, part: 'nose' }),
    // lower jaw and chin
    ellipsoid('jaw', hp(0, -0.112, 0.22), [0.062, 0.038, 0.12], { rot: [0.12, 0, 0], blend: 0.035, part: 'chin' }),
    // small brow ridges
    ...symmetric([ellipsoid('head', hp(0.052, 0.04, 0.2), [0.035, 0.025, 0.035], { blend: 0.03, part: 'head' })]),
    // rounded, furry ears; no carved cup: carving the thin plate folds it into back-facing slivers
    // that show as holes; the coat paints the inside instead
    ...symmetric([
      ellipsoid('ear.L', hp(0.103, 0.125, 0.02), [0.046, 0.046, 0.026], { rot: [-0.2, 0.4, -0.5], blend: 0.03, part: 'ear', region: 'ears' }),
    ]),
  ];
  return withRegion(head, 'head');
}

const LEGS: BearLegSpec = {
  arm: [0.13, 0.105, 0.098, 0.075],
  thigh: [0.14, 0.105, 0.095, 0.07],
  frontPaw: [0.075, 0.085, 0.045],
  hindPaw: [0.068, 0.13, 0.04],
  claw: [0.07, 0.0135],
  turnIn: 0.16,
};

// ---------------------------------------------------------------------------
// Coat

const BROWN = 0x46301c;
const BROWN_DARK = 0x22170e;
const GRIZZLE = 0xa98a5c;
const MUZZLE = 0x8a6a48;
const NOSE = 0x141010;
const CLAW = 0xb9a888;

function grizzlyCoat(eye: Vec3) {
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    const n1 = fbm(x * 3.2, y * 3.2, z * 3.2, 3, 41);
    const n2 = fbm(x * 9, y * 9, z * 9, 2, 42);
    c.color.setHex(BROWN);
    // darker legs and belly
    const legW = clamp01((c.pw('leg') + c.pw('paw')) * 1.3);
    const under = smooth(-0.2, -0.8, c.ny);
    blendHex(c.color, BROWN_DARK, clamp01(legW * 0.85 + under * 0.45 + n1 * 0.15));
    // grizzled pale tips over the hump, back and flanks (patchy)
    const top = smooth(-0.1, 0.8, c.ny) * smooth(0.55, 0.95, y);
    const humpW = c.pw('hump');
    const shoulders = Math.exp(-((z - 0.3) ** 2) / 0.09);
    const griz = clamp01(top * (0.35 + 0.45 * shoulders) + humpW * 0.45 + n1 * 0.4 + n2 * 0.25 - 0.15) * (1 - legW * 0.9);
    blendHex(c.color, GRIZZLE, griz * 0.85);
    // head: lighter brown crown and cheeks, tan muzzle, dark eye patches
    const hw = clamp01(c.pw('head') + c.pw('muzzle') + c.pw('chin') + c.pw('ear'));
    if (hw > 0.05) {
      blendHex(c.color, 0x6e523a, hw * 0.5 * smooth(-0.3, 0.6, c.ny));
      const mz = c.pw('muzzle') + c.pw('chin') * 0.6;
      blendHex(c.color, MUZZLE, smooth(0.2, 0.6, mz) * 0.85);
      const ed = distSym(x, y, z, eye);
      blendHex(c.color, 0x2a1d14, smooth(0.05, 0.02, ed) * 0.6);
    }
    // nose leather and lips
    const nd = ellDist(x, y, z, NOSE_C, [0.044, 0.036, 0.03]);
    if (nd < 1.3) {
      const k = smooth(1.3, 1.0, nd);
      blendHex(c.color, NOSE, k);
      c.gloss = 0.45 * k;
    }
    if (c.pw('chin') > 0.3 && z > POLL[2] + 0.25 && c.ny > -0.2) blendHex(c.color, 0x2a1f18, smooth(0.3, 0.6, c.pw('chin')) * 0.5);
    // ears: dark brown, darkest in the opening (facing forward / outward)
    if (c.part === 'ear') blendHex(c.color, 0x34261a, 0.55 + 0.3 * smooth(0.2, 0.7, c.nz * 0.8 + Math.sign(x) * c.nx * 0.4));
    // claws: pale horn with darker bases
    const cw = c.pw('claw');
    if (cw > 0.2) {
      blendHex(c.color, CLAW, smooth(0.2, 0.55, cw));
      blendHex(c.color, 0x5a4c3c, smooth(0.55, 0.3, cw) * 0.5);
      c.gloss = 0.25 * smooth(0.3, 0.8, cw);
    }
    // footpads (soles) dark leathery
    if (c.ny < -0.6 && y < 0.05) blendHex(c.color, 0x1c1714, 0.8);
    // long, shaggy fur except on the face and paws
    c.fur = 1 + 2.2 * clamp01(1 - hw * 1.5) * (1 - c.pw('paw')) + 0.8 * humpW;
  };
}

function design(ctx: DesignContext): CreatureDesign {
  const head = headPrims();
  const eyeDir: Vec3 = [-0.18, 0, -1];
  const hit = surfacePoint(head, hp(0.058 + 0.072, 0.03, 0.6), eyeDir, 0.6);
  const eye = seat(hit, eyeDir, 0.006);
  return bearDesign(ctx, {
    joints: J,
    prims: [...trunkPrims(), ...head],
    legs: LEGS,
    tailR: 0.05,
    coat: grizzlyCoat(eye),
    look: { skin: 'fur', grain: 0.011, bump: 0.5, sheen: 0.45, roughness: 0.92, mottle: 0.22 },
    eyes: [{ bone: 'head', pos: eye, radius: 0.014, color: 0x1a0f08 }],
    resolution: 1.0,
    regions: { head: { scale: 0.52 }, FL: { scale: 0.5, aniso: [1, 1.5, 1] }, FR: { scale: 0.5, aniso: [1, 1.5, 1] }, HL: { scale: 0.5, aniso: [1, 1.5, 1] }, HR: { scale: 0.5, aniso: [1, 1.5, 1] } },
    quad: bearQuad(ctx.def.height, ctx.def.walkSpeed, ctx.def.runSpeed, {
      lie: { hipsY: 0.36, chestY: 0.37, front: 'extend', hindSplay: 0.1, headRest: 0.1 },
      swimSink: 0.88,
    }),
    anim: {
      rear: { pitch: 1.25, hipsY: 0.8, hipsDZ: 0.16, neck: 0.95 },
      sit: { hipsY: 0.3, pitch: 0.95, hipsDZ: 0.12, legFwd: 0.6 },
      side: { hipsY: 0.3, roll: 1.35, curl: 0.4, reach: 0.62, neckDrop: 0.3 },
      call: 'rear',
      headSwing: 0.1,
      reach: { front: 0.2, head: 0.35, maxPitch: 1.5, neckLift: 0.15 },
      lieHead: 0.12,
    },
    height: 1.15,
    radius: 0.6,
  });
}

const grizzly: SpeciesModel = {
  id: 'grizzly',
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.06 : 0.86) * (0.96 + r * 0.08),
};
export default grizzly;
