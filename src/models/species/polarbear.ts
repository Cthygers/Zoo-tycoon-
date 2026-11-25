// Polar bear (Ursus maritimus). The largest bear: long body, massive
// hindquarters standing higher than the shoulders (no hump), a long neck and
// a comparatively small, elongated head with a straight "Roman" profile,
// small ears, black nose / lips / eyes and enormous paws with black pads and
// short dark claws. Cream-white fur, faintly yellow over the back and rump,
// with long "trousers" on the legs. A strong swimmer: paddles with the
// forepaws, hind legs trailing, only the head and a strip of back showing.
// Calls with a low-headed roar and a stomp.

import { cone, ellipsoid, symmetric, type Prim, type Vec3 } from '../sdf/prims';
import { seat, surfacePoint, withRegion, type QuadJoints } from '../kit/quadruped';
import { blendHex, clamp01, fbm, smooth } from '../coat/coat';
import type { CoatSample, CreatureDesign, DesignContext, SpeciesModel } from '../types';
import { bearDesign, bearQuad, type BearLegSpec } from './species-predators-runners/bear';
import { distSym, ellDist } from './species-predators-runners/shared';

const NOSE_C: Vec3 = [0, 1.0 - 0.05, 1.16 + 0.405];

const POLL: Vec3 = [0, 1.0, 1.16];
const hp = (dx: number, dy: number, dz: number): Vec3 => [POLL[0] + dx, POLL[1] + dy, POLL[2] + dz];

const J: QuadJoints = {
  hips: [0, 1.1, -0.66],
  spine: [
    [0, 1.16, -0.34],
    [0, 1.17, -0.02],
  ],
  chest: [0, 1.13, 0.32],
  neck: [
    [0, 1.1, 0.58],
    [0, 1.07, 0.8],
    [0, 1.03, 1.0],
  ],
  head: POLL,
  jaw: hp(0, -0.09, 0.1),
  ear: hp(0.078, 0.075, 0.0),
  tail: [
    [0, 1.08, -0.98],
    [0, 1.0, -1.04],
  ],
  front: {
    scap: [0.17, 1.2, 0.4],
    upper: [0.22, 0.86, 0.48],
    lower: [0.22, 0.54, 0.38],
    foot: [0.21, 0.15, 0.46],
    toe: [0.21, 0.05, 0.6],
    contact: [0.21, 0, 0.66],
  },
  hind: {
    upper: [0.21, 1.02, -0.68],
    lower: [0.23, 0.61, -0.46],
    foot: [0.21, 0.16, -0.7],
    toe: [0.21, 0.05, -0.44],
    contact: [0.21, 0, -0.4],
  },
  muzzle: hp(0, -0.085, 0.4),
};

function trunkPrims(): Prim[] {
  return [
    // narrow-ish deep chest
    ellipsoid('chest', [0, 0.88, 0.28], [0.25, 0.34, 0.34], { blend: 0.1, part: 'body' }),
    ellipsoid('chest', [0, 1.13, 0.3], [0.16, 0.1, 0.24], { blend: 0.1, part: 'body' }),
    // long barrel
    ellipsoid('spine_2', [0, 0.9, -0.05], [0.29, 0.34, 0.42], { blend: 0.1, part: 'body' }),
    ellipsoid('spine_1', [0, 0.75, -0.34], [0.26, 0.24, 0.3], { blend: 0.12, part: 'belly' }),
    ellipsoid('spine_1', [0, 1.06, -0.36], [0.25, 0.2, 0.3], { blend: 0.1, part: 'body' }),
    // massive hindquarters, higher than the shoulders
    ellipsoid('hips', [0, 1.02, -0.68], [0.28, 0.27, 0.3], { blend: 0.1, part: 'body' }),
    ...symmetric([
      ellipsoid('FL_scap', [0.18, 0.96, 0.38], [0.11, 0.25, 0.16], { rot: [-0.3, 0, 0], blend: 0.09, part: 'body' }),
      ellipsoid('HL_upper', [0.19, 0.82, -0.62], [0.14, 0.27, 0.22], { rot: [-0.1, 0, 0], blend: 0.1, part: 'body' }),
    ]),
  ];
}

/** Long neck, small elongated head, small ears (all in the head region). */
function headPrims(): Prim[] {
  const P: Prim[] = [
    // the long, mobile neck
    cone('neck_1', [0, 1.0, 0.46], [0, 1.04, 0.8], 0.23, 0.165, { blend: 0.1, part: 'neck' }),
    cone('neck_2', [0, 1.04, 0.78], [0, 1.0, 1.06], 0.165, 0.125, { blend: 0.08, part: 'neck' }),
    ellipsoid('neck_2', [0, 0.92, 0.82], [0.14, 0.14, 0.14], { blend: 0.08, part: 'neck' }),
    // narrow braincase, flat forehead
    ellipsoid('head', hp(0, 0.015, 0.05), [0.104, 0.098, 0.14], { rot: [0.22, 0, 0], blend: 0.06, part: 'head' }),
    ellipsoid('head', hp(0, -0.045, 0.08), [0.118, 0.082, 0.11], { blend: 0.06, part: 'head' }),
    // long straight ("Roman") muzzle, no stop
    cone('head', hp(0, 0.01, 0.15), hp(0, -0.055, 0.385), 0.074, 0.048, { blend: 0.05, part: 'muzzle' }),
    ellipsoid('head', hp(0, -0.078, 0.27), [0.058, 0.044, 0.095], { blend: 0.04, part: 'muzzle' }),
    // black nose
    ellipsoid('head', hp(0, -0.05, 0.402), [0.033, 0.025, 0.02], { rot: [0.3, 0, 0], blend: 0.014, part: 'nose' }),
    // lower jaw
    ellipsoid('jaw', hp(0, -0.106, 0.22), [0.055, 0.034, 0.12], { rot: [0.12, 0, 0], blend: 0.035, part: 'chin' }),
    // small rounded ears; no carved cup: carving the thin plate folds it into back-facing slivers
    // that show as holes; the coat paints the inside instead
    ...symmetric([
      ellipsoid('ear.L', hp(0.086, 0.088, -0.005), [0.033, 0.031, 0.02], { rot: [-0.2, 0.4, -0.55], blend: 0.025, part: 'ear', region: 'ears' }),
    ]),
  ];
  return withRegion(P, 'head');
}

const LEGS: BearLegSpec = {
  arm: [0.15, 0.12, 0.112, 0.088],
  thigh: [0.17, 0.125, 0.108, 0.08],
  frontPaw: [0.1, 0.115, 0.05],
  hindPaw: [0.088, 0.16, 0.045],
  claw: [0.04, 0.013],
  turnIn: 0.18,
};

// ---------------------------------------------------------------------------
// Coat

const CREAM = 0xd8cba8;
const YELLOW = 0xc9b27e;
const SHADE = 0xc0b398;
const WHITE = 0xe3dccb;
const BLACK = 0x121010;

function polarCoat(eye: Vec3) {
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    const n1 = fbm(x * 2.6, y * 2.6, z * 2.6, 3, 51);
    c.color.setHex(CREAM);
    // faint yellow cast over the back and rump (sun-bleached guard hairs vary)
    const back = smooth(-0.1, 0.8, c.ny) * smooth(0.7, 1.15, y);
    blendHex(c.color, YELLOW, clamp01(back * 0.45 + smooth(-0.3, -0.9, z) * 0.35 + n1 * 0.25));
    // greyer underside and inner legs (dirt / shadowed guard hairs)
    const legW = clamp01((c.pw('leg') + c.pw('paw')) * 1.3);
    blendHex(c.color, SHADE, clamp01(smooth(-0.2, -0.85, c.ny) * 0.6 + legW * 0.25));
    // head: whiter, greyer muzzle
    const hw = clamp01(c.pw('head') + c.pw('muzzle') + c.pw('chin') + c.pw('ear'));
    if (hw > 0.05) {
      blendHex(c.color, WHITE, hw * 0.5);
      blendHex(c.color, 0xcdc4b2, smooth(0.3, 0.7, c.pw('muzzle')) * smooth(0.0, -0.6, c.ny) * 0.5);
      // black eye rims
      const ed = distSym(x, y, z, eye);
      blendHex(c.color, BLACK, smooth(0.019, 0.013, ed) * 0.9);
    }
    // black nose leather (painted from the nose ellipsoid) and lips
    const nd = ellDist(x, y, z, NOSE_C, [0.042, 0.034, 0.03]);
    if (nd < 1.3) {
      const k = smooth(1.3, 1.0, nd);
      blendHex(c.color, BLACK, k);
      c.gloss = 0.5 * k;
    }
    const lipY = POLL[1] - 0.095 + (z - (POLL[2] + 0.3)) * 0.2;
    if (c.pw('muzzle') + c.pw('chin') > 0.3 && Math.abs(y - lipY) < 0.012 && z > POLL[2] + 0.2) blendHex(c.color, BLACK, smooth(0.012, 0.004, Math.abs(y - lipY)) * 0.85);
    // ears: slightly greyer inside
    if (c.part === 'ear') blendHex(c.color, 0xb9b09e, smooth(0.2, 0.9, c.nz) * 0.4);
    // black foot pads, short dark claws
    if (c.ny < -0.55 && y < 0.05) blendHex(c.color, 0x181514, 0.9);
    const cw = c.pw('claw');
    if (cw > 0.2) {
      blendHex(c.color, 0x2a2420, smooth(0.2, 0.5, cw));
      c.gloss = 0.3 * smooth(0.3, 0.8, cw);
    }
    // long, dense fur; longest on the legs ("trousers")
    c.fur = 1 + clamp01(1 - hw * 1.5) * (1.4 + 1.4 * legW) * (1 - c.pw('paw') * 0.7);
  };
}

function design(ctx: DesignContext): CreatureDesign {
  const head = headPrims();
  const eyeDir: Vec3 = [-0.2, 0, -1];
  const hit = surfacePoint(head, hp(0.052 + 0.08, 0.025, 0.6), eyeDir, 0.6);
  const eye = seat(hit, eyeDir, 0.006);
  return bearDesign(ctx, {
    joints: J,
    prims: [...trunkPrims(), ...head],
    legs: LEGS,
    tailR: 0.055,
    coat: polarCoat(eye),
    // soft relief: on a bright, low-contrast coat the fur's clump relief along
    // the hair flow read as wavy wood-grain bands at the closest zoom
    look: { skin: 'fur', grain: 0.012, bump: 0.28, sheen: 0.5, roughness: 0.93, mottle: 0.07, wets: true },
    eyes: [{ bone: 'head', pos: eye, radius: 0.0125, color: 0x0e0a08 }],
    resolution: 0.95,
    regions: {
      head: { scale: 0.5 },
      FL: { scale: 0.48, aniso: [1, 1.5, 1] },
      FR: { scale: 0.48, aniso: [1, 1.5, 1] },
      HL: { scale: 0.48, aniso: [1, 1.5, 1] },
      HR: { scale: 0.48, aniso: [1, 1.5, 1] },
    },
    quad: bearQuad(ctx.def.height, ctx.def.walkSpeed, ctx.def.runSpeed, {
      lie: { hipsY: 0.46, chestY: 0.45, front: 'extend', hindSplay: 0.12, headRest: 0.12 },
      swimSink: 1.12,
      callJaw: 0.5,
    }),
    anim: {
      rear: { pitch: 1.2, hipsY: 1.0, hipsDZ: 0.2, neck: 0.85 },
      sit: { hipsY: 0.38, pitch: 0.95, hipsDZ: 0.15, legFwd: 0.6 },
      side: { hipsY: 0.36, roll: 1.35, curl: 0.45, reach: 0.62, neckDrop: 0.25, bend: 1 },
      call: 'roar',
      headSwing: 0.14,
      reach: { front: 0.08, head: 0.3, maxPitch: 2.0, neckLift: 0.5 },
      lieHead: 0.12,
    },
    height: 1.45,
    radius: 0.7,
  });
}

const polarbear: SpeciesModel = {
  id: 'polarbear',
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.05 : 0.82) * (0.96 + r * 0.08),
};
export default polarbear;
