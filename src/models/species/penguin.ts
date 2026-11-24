// Gentoo penguin (Pygoscelis papua) — 'penguin' rig.
//
// An upright spindle body on short legs with flat, webbed orange feet, a
// small head with a slender orange-red bill (black culmen and tip), flat
// paddle flippers and the long stiff tail typical of gentoos. Plumage is a
// crisp per-pixel field ('field' pattern): sooty black back, head and throat,
// white belly, the white band that runs over the crown from eye to eye, a
// white eye-ring and white flipper undersides / trailing edges.
// Animation (species-special-rigs/penguin-rig.ts): waddle, preening idle,
// pecking, belly-down sleep, crouched rest, ecstatic display call, belly-down
// surface swimming with porpoising.

import { cone, ellipsoid, mirrorX, roundBox, sphere, symmetric, type Prim, type Vec3 } from '../sdf/prims';
import { seat, surfacePoint, withRegion } from '../kit/quadruped';
import { driver } from '../anim/util';
import { blendHex, clamp01, fbm, mixHex, smooth } from '../coat/coat';
import { penguinDriver } from './species-special-rigs/penguin-rig';
import type { BoneSpec } from '../rig/rig';
import type { CoatSample, CreatureDesign, DesignContext, RigRoles, SpeciesModel } from '../types';

const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];

/**
 * Skeleton. `fx` pushes the flipper blades further from the flanks (no longer
 * needed since the flipper regions opt out of the base grid; kept at 0).
 */
const bones = (fx: number): BoneSpec[] => [
  { name: 'hips', parent: null, pos: v3(0, 0.2, -0.015) },
  { name: 'spine_1', parent: 'hips', pos: v3(0, 0.32, -0.005) },
  { name: 'chest', parent: 'spine_1', pos: v3(0, 0.44, 0.008) },
  { name: 'neck_1', parent: 'chest', pos: v3(0, 0.535, 0.02) },
  { name: 'neck_2', parent: 'neck_1', pos: v3(0, 0.585, 0.028) },
  { name: 'head', parent: 'neck_2', pos: v3(0, 0.625, 0.035) },
  { name: 'jaw', parent: 'head', pos: v3(0, 0.624, 0.088) },
  { name: 'tail_1', parent: 'hips', pos: v3(0, 0.12, -0.095) },
  { name: 'tail_2', parent: 'tail_1', pos: v3(0, 0.08, -0.14) },
  ...(['L', 'R'] as const).flatMap((s): BoneSpec[] => {
    const k = s === 'L' ? 1 : -1;
    return [
      { name: `flip_1.${s}`, parent: 'chest', pos: v3(0.098 * k, 0.5, 0.0) },
      { name: `flip_2.${s}`, parent: `flip_1.${s}`, pos: v3((0.143 + fx * 0.6) * k, 0.384, -0.011) },
      { name: `flip_3.${s}`, parent: `flip_2.${s}`, pos: v3((0.168 + fx * 1.1) * k, 0.307, -0.02) },
      { name: `H${s}_upper`, parent: 'hips', pos: v3(0.052 * k, 0.13, 0.0) },
      { name: `H${s}_lower`, parent: `H${s}_upper`, pos: v3(0.058 * k, 0.056, -0.014) },
      { name: `H${s}_foot`, parent: `H${s}_lower`, pos: v3(0.06 * k, 0.02, 0.014) },
    ];
  }),
];

const BILL_TIP: Vec3 = [0, 0.625, 0.147];

const ROLES: RigRoles = {
  root: 'hips',
  spine: ['spine_1'],
  chest: 'chest',
  neck: ['neck_1', 'neck_2'],
  head: 'head',
  jaw: 'jaw',
  tail: ['tail_1', 'tail_2'],
  legs: {
    HL: { upper: 'HL_upper', lower: 'HL_lower', foot: 'HL_foot', contact: v3(0.062, 0, 0.045) },
    HR: { upper: 'HR_upper', lower: 'HR_lower', foot: 'HR_foot', contact: v3(-0.062, 0, 0.045) },
  },
  arms: {
    L: { upper: 'flip_1.L', lower: 'flip_2.L', hand: 'flip_3.L' },
    R: { upper: 'flip_1.R', lower: 'flip_2.R', hand: 'flip_3.R' },
  },
  muzzle: BILL_TIP,
};

function bodyPrims(): Prim[] {
  return [
    // lower body: widest just below the middle, belly feathers overhang the feet
    ellipsoid('hips', [0, 0.2, 0.004], [0.13, 0.15, 0.124], { blend: 0.06, part: 'body' }),
    ellipsoid('spine_1', [0, 0.32, 0.01], [0.124, 0.15, 0.119], { blend: 0.06, part: 'body' }),
    // chest / shoulders tapering into the neck
    ellipsoid('chest', [0, 0.44, 0.02], [0.098, 0.12, 0.095], { blend: 0.06, part: 'body' }),
    ellipsoid('neck_1', [0, 0.535, 0.03], [0.066, 0.07, 0.066], { blend: 0.05, part: 'neck' }),
    ellipsoid('neck_2', [0, 0.585, 0.035], [0.055, 0.05, 0.057], { blend: 0.04, part: 'neck', skin: 0.6 }),
  ];
}

function headPrims(): Prim[] {
  return [
    ellipsoid('head', [0, 0.632, 0.04], [0.051, 0.053, 0.061], { blend: 0.03, part: 'head', skinWeight: 2.5 }),
    // forehead sloping into the bill
    ellipsoid('head', [0, 0.635, 0.073], [0.03, 0.03, 0.03], { blend: 0.025, part: 'head', skinWeight: 2.5 }),
    // slender bill: upper mandible with a slight hook, lower mandible on the jaw
    cone('head', [0, 0.635, 0.086], [0, 0.627, 0.142], 0.0135, 0.0042, { blend: 0.012, part: 'bill' }),
    sphere('head', [0, 0.6245, 0.1415], 0.0045, { blend: 0.006, part: 'bill' }),
    cone('jaw', [0, 0.622, 0.086], [0, 0.6185, 0.137], 0.0105, 0.0034, { blend: 0.008, part: 'billLow' }),
  ];
}

function tailPrims(): Prim[] {
  return [
    ellipsoid('tail_1', [0, 0.115, -0.11], [0.042, 0.022, 0.05], { rot: [-0.65, 0, 0], blend: 0.035, part: 'tail' }),
    ellipsoid('tail_2', [0, 0.072, -0.162], [0.03, 0.011, 0.052], { rot: [-0.42, 0, 0], blend: 0.02, part: 'tail', region: 'tail' }),
  ];
}

/**
 * Left flipper: a flat paddle (thin across x, broad fore-aft) hanging from the
 * shoulder and angled away from the flank, so that the body under it is
 * meshed completely (it is uncovered when the flipper swings out); only the
 * root at the shoulder joins the body.
 */
function flipperPrimsLeft(fx: number): Prim[] {
  const o = { part: 'flipper', region: 'flip.L', skin: 0.5, skinWeight: 3 };
  const tilt = 0.317 + fx * 1.4;
  return [
    // root at the shoulder: weighted like the body so the flank does not tear when the flipper swings out
    ellipsoid('flip_1.L', [0.097, 0.492, 0.0], [0.016, 0.022, 0.028], { blend: 0.02, ...o, skin: 1, skinWeight: 1 }),
    ellipsoid('flip_1.L', [0.127 + fx * 0.3, 0.43, -0.006], [0.013, 0.062, 0.034], { rot: [0.06, 0, tilt], blend: 0.012, ...o }),
    ellipsoid('flip_2.L', [0.156 + fx * 0.8, 0.344, -0.016], [0.011, 0.06, 0.03], { rot: [0.1, 0, tilt], blend: 0.012, ...o }),
    ellipsoid('flip_3.L', [0.176 + fx * 1.2, 0.283, -0.024], [0.008, 0.04, 0.02], { rot: [0.16, 0, tilt - 0.017], blend: 0.01, ...o }),
  ];
}

function legPrimsLeft(): Prim[] {
  const P: Prim[] = [
    // feathered shank, mostly hidden under the belly
    cone('HL_upper', [0.05, 0.13, 0.0], [0.057, 0.065, -0.012], 0.03, 0.021, { blend: 0.03, part: 'thigh' }),
    // short bare tarsus and webbed foot (toes turned out a little)
    cone('HL_lower', [0.058, 0.062, -0.013], [0.06, 0.022, 0.012], 0.016, 0.013, { blend: 0.012, part: 'leg', region: 'HL' }),
    ellipsoid('HL_foot', [0.063, 0.011, 0.042], [0.033, 0.0105, 0.04], { rot: [0, 0.15, 0], blend: 0.012, part: 'foot', region: 'HL' }),
  ];
  for (const [dx, len] of [
    [-0.024, 0.058],
    [0.002, 0.07],
    [0.028, 0.058],
  ] as const) {
    const a: Vec3 = [0.06, 0.014, 0.02];
    const b: Vec3 = [0.062 + dx + 0.012, 0.008, 0.02 + len];
    P.push(cone('HL_foot', a, b, 0.0075, 0.0052, { blend: 0.008, part: 'foot', region: 'HL' }));
    P.push(sphere('HL_foot', [b[0] + 0.001, 0.007, b[2] + 0.006], 0.0045, { blend: 0.004, part: 'claw', region: 'HL' }));
  }
  P.push(roundBox('HL_foot', [0.06, -0.05, 0.05], [0.07, 0.05, 0.09], 0.005, { sub: true, blend: 0.004, part: 'foot', region: 'HL' }));
  return P;
}

// ---------------------------------------------------------------------------
// Coat

const BLACK = 0x1a1c21;
const BLACK_HEAD = 0x141519;
const WHITE = 0xeae9e3;
const BILL = 0xe04a1e;
const BILL_DARK = 0x1d1816;
const FEET = 0xe7773f;
const CLAW = 0x2b2420;

function penguinCoat(eye: Vec3, eyeR: number) {
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    const ax = Math.abs(x);
    const n = fbm(x * 20, y * 20, z * 20, 2, 61);
    c.color.setHex(BLACK);
    blendHex(c.color, BLACK_HEAD, smooth(0.5, 0.6, y));
    // slight brownish wear on the back plumage
    blendHex(c.color, 0x2a2622, clamp01(n * 0.6));
    c.color2.setHex(WHITE);
    blendHex(c.color2, 0xc9c6bd, smooth(0.12, 0.0, y) * 0.6 + clamp01(n) * 0.15);
    c.gloss = 0.05;
    // ---- body / neck field: white belly wrapping past the flanks, black throat
    const zc = 0.012 + 0.024 * smooth(0.3, 0.6, y);
    const dz = z - zc;
    const r = Math.hypot(ax, dz);
    const th = Math.atan2(ax, dz);
    // white wraps past the flank on the mid-body (seen from behind, a white
    // edge below the flippers), so a penguin at the surface shows a white
    // flank along its waterline
    const thB = 1.72 + 0.4 * smooth(0.26, 0.06, y) + 0.35 * smooth(0.12, 0.22, y) * smooth(0.4, 0.3, y) - 0.32 * smooth(0.36, 0.47, y);
    const yT = 0.505 - 0.035 * smooth(0.7, 1.6, th);
    let s = Math.min((thB - th) * Math.max(0.04, r), yT - y);
    // ---- head: white band over the crown from eye to eye, white eye-ring
    const hw = c.pw('head') + c.pw('neck');
    if (y > 0.6) {
      const d = 0.331 * (y - (eye[1] + 0.014)) + 0.944 * (z - (eye[2] - 0.012));
      const half = 0.0032 + 0.012 * smooth(0.016, 0.044, ax) * smooth(0.69, 0.655, y);
      let band = half - Math.abs(d);
      band = Math.min(band, y - (eye[1] + 0.006 - 0.012 * smooth(0.03, 0.05, ax)));
      s = Math.max(s, band);
      const ex = ax - eye[0], ey = y - eye[1], ez = z - eye[2];
      const ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
      s = Math.max(s, 0.0022 - Math.abs(ed - (eyeR + 0.0032)));
    }
    void hw;
    c.s = s;
    // ---- tail: black, stiff
    const tl = c.pw('tail');
    if (tl > 0.3) c.s = Math.min(c.s, -(tl - 0.3) * 0.05);
    // ---- flippers: black outer face with a white trailing edge, white underside
    const fl = c.pw('flipper');
    if (fl > 0.3) {
      const inner = -Math.sign(x) * c.nx;
      const zEdge = -0.006 - (0.43 - y) * 0.12 - 0.022;
      const sf = Math.min(Math.max(inner * 0.03 - 0.008, (zEdge - z) * 0.6), (0.445 - y) * 0.5);
      const k = smooth(0.3, 0.6, fl);
      c.s = c.s * (1 - k) + sf * k;
    }
    // ---- bill: orange-red with black culmen and tip
    const bl = c.pw('bill') + c.pw('billLow');
    if (bl > 0.15) {
      const k = smooth(0.15, 0.5, bl);
      mixHex(c.color, BLACK_HEAD, BILL, k);
      c.color2.setHex(BILL_DARK);
      // upper mandible: black ridge (culmen) and tip; lower mandible: dark tip only
      const upper = c.part === 'bill';
      const cul = upper ? Math.min(0.0035 - ax, (c.ny - 0.55) * 0.02) : -1;
      const tip = z - (upper ? 0.131 : 0.128);
      c.s = k > 0.5 ? Math.max(cul, tip) : -0.01;
      c.gloss = 0.35 * k;
    }
    // ---- legs / feet: orange-pink, dark claws
    const ft = c.pw('foot') + c.pw('leg') + c.pw('claw');
    if (ft > 0.2) {
      const k = smooth(0.2, 0.55, ft);
      blendHex(c.color, FEET, k);
      blendHex(c.color, 0xb85c35, smooth(0.0, 0.6, -c.ny) * 0.3 * k);
      c.s = c.s * (1 - k) - 0.01 * k;
      c.gloss = 0.12 * k;
      if (c.part === 'claw') blendHex(c.color, CLAW, 0.8);
    }
    if (c.part === 'thigh') c.s = Math.min(c.s, -0.004);
  };
}

function design(ctx: DesignContext): CreatureDesign {
  // flippers are meshed only on their own fine grids (noBase), so even the
  // coarse low tier never webs the narrow gap to the flank: no offset needed
  const fx = 0;
  const head = withRegion(headPrims(), 'head');
  const prims: Prim[] = [
    ...bodyPrims(),
    ...head,
    ...tailPrims(),
    ...flipperPrimsLeft(fx),
    ...mirrorX(flipperPrimsLeft(fx)),
    ...symmetric(legPrimsLeft()),
  ];
  const eyeDir: Vec3 = [-1, 0, -0.25];
  const hit = surfacePoint(head, [0.2, 0.648, 0.115], eyeDir, 0.3);
  const eye = seat(hit, eyeDir, 0.0032);
  const eyeR = 0.0054;
  const anim = penguinDriver({
    stride: 0.26,
    walkSpeed: ctx.def.walkSpeed,
    duty: 0.6,
    lift: 0.022,
    waddle: 0.15,
    proneY: 0.12,
    crouchY: 0.145,
    // float high, as resting and porpoising penguins do: back, head and the
    // top of the white flanks clear of the water
    swimDepth: -0.02,
    swimPitch: 1.45,
    swimShift: -0.13,
  });
  return {
    bones: bones(fx),
    roles: ROLES,
    prims,
    // flock species (up to two dozen per habitat): kept lean
    resolution: ctx.detail === 0 ? 0.74 : 0.66,
    regions: {
      head: { scale: 0.44 },
      'flip.L': { scale: 0.44, cell: 0.009, aniso: [1, 2.4, 1.5], noBase: true },
      'flip.R': { scale: 0.44, cell: 0.009, aniso: [1, 2.4, 1.5], noBase: true },
      HL: { scale: 0.44 },
      HR: { scale: 0.44 },
      tail: { scale: 0.55 },
    },
    coat: penguinCoat(eye, eyeR),
    look: {
      skin: 'feather',
      pattern: 'field',
      roughness: 0.62,
      sheen: 0.12,
      grain: 0.0035,
      bump: 0.22,
      mottle: 0.035,
      // chicks: fluffy grey down on the back, paler front, until about two-thirds grown
      juvenile: { color: 0x7d7b78, amount: 0.9, until: 0.7, keep: 0.45 },
    },
    eyes: [{ bone: 'head', pos: eye, radius: eyeR, color: 0x2a1610 }],
    anim: driver(anim),
    babyScale: 0.45,
    babyHead: 1.25,
    height: 0.72,
    radius: 0.2,
  };
}

const penguin: SpeciesModel = {
  id: 'penguin',
  design,
  instanceScale: (sex, r) => (sex === 'M' ? 1.03 : 0.97) * (0.96 + r * 0.08),
};
export default penguin;
