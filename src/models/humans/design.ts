// Human body design: SDF primitives + skeleton for a body type. Geometry is
// cached per (female, child, hair) and scaled per instance to the requested
// height; girth is a per-instance shader inflation along the normal.

import { capsule, cone, ellipsoid, roundBox, symmetric, transformPrims, type Prim, type Vec3 } from '../sdf/prims';
import type { BoneSpec } from '../rig/rig';
import type { RigRoles } from '../types';

export type HairKind = 'short' | 'long' | 'bald' | 'cap' | 'bushhat';

export interface HumanBodyKey {
  female: boolean;
  child: boolean;
  hair: HairKind;
  /** Knee-length A-line skirt / dress over the thighs (coloured like the trousers). */
  skirt?: boolean;
}

export interface HumanDesign {
  bones: BoneSpec[];
  roles: RigRoles;
  prims: Prim[];
  /** Reference standing height of the mesh (m). */
  height: number;
  /** Landmarks (rest, model space) used by the material. */
  marks: {
    shoulderL: Vec3;
    hipL: Vec3;
    collarY: number;
    waistY: number;
    shoeTop: number;
    eyeL: Vec3;
    mouth: Vec3;
    /** Head ellipsoid centre and scale (adult male head = 1), for marks painted on the scalp. */
    headC: Vec3;
    headS: number;
    /** Left wrist and ankle joints (rest): the hands hang below and beyond the wrist, the shoes sit below the ankle. */
    wristL: Vec3;
    ankleL: Vec3;
    /** Body scale (adult man = 1). */
    bodyScale: number;
  };
}

/**
 * Signed distance (m, > 0 inside) to the horseshoe of close-cropped hair a
 * bald man keeps above the ears and round the back of the head, rising from
 * the sideburns to the back. Baked as thin hair on bald heads (human.ts), so
 * they have a hairline instead of a blank mannequin dome.
 */
export function fringeDistance(d: HumanDesign, y: number, z: number): number {
  const k = d.marks.headS;
  const u = (y - d.marks.headC[1]) / k;
  const w = (z - d.marks.headC[2]) / k;
  const back = Math.min(1, Math.max(0, -w / 0.094));
  const bottom = -0.035 - 0.035 * back;
  const top = 0.012 + 0.023 * back;
  return Math.min(0.03 - w, u - bottom, top - u) * k;
}

/**
 * Proportions are authored for a 1.75 m adult; children use a smaller body
 * with a relatively larger head (the whole design is then ~1.25 m tall).
 */
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function humanDesign(key: HumanBodyKey): HumanDesign {
  const f = key.female;
  const child = key.child;
  // body scale and head scale (about the neck)
  const bs = child ? 0.7 : f ? 0.95 : 1;
  const hs = child ? 0.9 / 0.7 : 1; // head relative to body scale
  const shW = f ? 0.88 : 1; // shoulder width factor
  const hipW = f ? 1.1 : 1;
  const S = (v: Vec3): Vec3 => [v[0] * bs, v[1] * bs, v[2] * bs];

  // ---- joints (adult male reference, metres)
  const J = {
    hips: [0, 0.95, 0] as Vec3,
    spine: [0, 1.1, 0] as Vec3,
    chest: [0, 1.3, -0.005] as Vec3,
    neck: [0, 1.48, -0.015] as Vec3,
    head: [0, 1.57, 0.0] as Vec3,
    clav: [0.035 * shW, 1.43, -0.01] as Vec3,
    shoulder: [0.185 * shW, 1.415, -0.015] as Vec3,
    // A-pose: arms ~23° out so the mesher never webs arm and hip together;
    // the animation lowers them (see ARM_REST_OUT in anim/human.ts)
    elbow: [0.185 * shW + 0.11, 1.148, -0.04] as Vec3,
    wrist: [0.185 * shW + 0.215, 0.906, -0.01] as Vec3,
    hip: [0.088 * hipW, 0.9, 0] as Vec3,
    knee: [0.092 * hipW, 0.5, 0.012] as Vec3,
    ankle: [0.095 * hipW, 0.085, -0.02] as Vec3,
    contact: [0.095 * hipW, 0, 0.09] as Vec3,
  };
  const bonesL = (side: 'L' | 'R', sx: number): BoneSpec[] => {
    const m = (v: Vec3): Vec3 => S([v[0] * sx, v[1], v[2]]);
    return [
      { name: `clav.${side}`, parent: 'chest', pos: m(J.clav) },
      { name: `upperArm.${side}`, parent: `clav.${side}`, pos: m(J.shoulder) },
      { name: `foreArm.${side}`, parent: `upperArm.${side}`, pos: m(J.elbow) },
      { name: `hand.${side}`, parent: `foreArm.${side}`, pos: m(J.wrist) },
      { name: `thigh.${side}`, parent: 'hips', pos: m(J.hip) },
      { name: `shin.${side}`, parent: `thigh.${side}`, pos: m(J.knee) },
      { name: `foot.${side}`, parent: `shin.${side}`, pos: m(J.ankle) },
    ];
  };
  // head joint is scaled about the neck for children
  const headPos = (v: Vec3): Vec3 => {
    const n = J.neck;
    return S([n[0] + (v[0] - n[0]) * hs, n[1] + (v[1] - n[1]) * hs, n[2] + (v[2] - n[2]) * hs]);
  };
  const bones: BoneSpec[] = [
    { name: 'hips', parent: null, pos: S(J.hips) },
    { name: 'spine', parent: 'hips', pos: S(J.spine) },
    { name: 'chest', parent: 'spine', pos: S(J.chest) },
    { name: 'neck', parent: 'chest', pos: S(J.neck) },
    { name: 'head', parent: 'neck', pos: headPos(J.head) },
    ...bonesL('L', 1),
    ...bonesL('R', -1),
  ];

  // ---- primitives (adult male reference, then scaled)
  const torso: Prim[] = [
    // ribcage / chest
    ellipsoid('chest', [0, 1.3, 0.0], [0.152 * shW, 0.17, 0.105], { blend: 0.06, part: 'torso' }),
    ellipsoid('chest', [0, 1.37, -0.01], [0.155 * shW, 0.075, 0.085], { blend: 0.07, part: 'torso' }),
    // waist / belly
    ellipsoid('spine', [0, 1.1, 0.005], [f ? 0.125 : 0.142, 0.14, 0.1], { blend: 0.07, part: 'torso' }),
    // pelvis / seat
    ellipsoid('hips', [0, 0.95, -0.01], [0.155 * hipW, 0.1, 0.105], { blend: 0.06, part: 'pelvis' }),
    ellipsoid('hips', [0, 0.92, -0.05], [0.13 * hipW, 0.09, 0.08], { blend: 0.05, part: 'pelvis' }),
    // shoulders: deltoids drawn down into the arm (not round caps that read
    // as puffed sleeves) under the point of the shoulder, which stays with
    // the shoulder blade when the arm is lowered, and a trapezius sloping from
    // the neck, so the shoulder line falls from the collar instead of a square shelf
    ...symmetric([ellipsoid('upperArm.L', [0.168 * shW, 1.382, -0.012], [0.044, 0.064, 0.048], { blend: 0.06, part: 'arm', region: 'armL' })], (n) => n.replace('.L', '.R').replace('armL', 'armR')),
    ...symmetric([ellipsoid('clav.L', [0.152 * shW, 1.428, -0.02], [0.05 * shW, 0.024, 0.045], { rot: [0, 0, -0.3], blend: 0.04, part: 'torso' })]),
    ...symmetric([ellipsoid('chest', [0.075 * shW, 1.442, -0.03], [0.085 * shW, 0.03, 0.05], { rot: [0, 0, -0.32], blend: 0.05, part: 'torso' })]),
    // shoulder blades: the back is not a smooth tube
    ...symmetric([ellipsoid('chest', [0.07 * shW, 1.33, -0.075], [0.055 * shW, 0.07, 0.03], { rot: [0, 0, 0.2], blend: 0.05, part: 'torso' })]),
    // neck
    cone('neck', [0, 1.44, -0.02], [0, 1.56, -0.005], 0.055, 0.047, { blend: 0.04, part: 'neck' }),
  ];
  if (f) {
    torso.push(...symmetric([ellipsoid('chest', [0.055, 1.27, 0.07], [0.058, 0.055, 0.045], { blend: 0.05, part: 'torso' })]));
  }
  // hand (A-pose: hanging along the forearm line, palm toward the thigh, thumb
  // forward), built in its own frame: u down the hand from the wrist, v across
  // it toward the thumb, t out of the back of the hand. A flat palm with the
  // ball of the thumb, four fingers side by side with a fillet between them
  // (grooves), relaxed into a slight curl at the knuckles, and a thumb set
  // apart from the index finger: a hand, not a mitten.
  const hx = 0.185 * shW + 0.215, hr = 0.4;
  const wrist: Vec3 = [hx, 0.906, -0.01];
  const ha: Vec3 = [Math.sin(hr), -Math.cos(hr), 0];
  const ht: Vec3 = [Math.cos(hr), Math.sin(hr), 0];
  const hf = (u: number, v: number, t: number): Vec3 => [wrist[0] + u * ha[0] + t * ht[0], wrist[1] + u * ha[1] + t * ht[1], wrist[2] + v];
  const hand = (p: Prim): Prim => ({ ...p, part: 'hand', region: 'handL' });
  const fingers: Prim[] = [];
  // [v across the knuckles, base radius, length, knuckle u]: index, middle, ring, little
  const FINGERS: readonly (readonly [number, number, number, number])[] = [
    [0.0275, 0.0088, 0.07, 0.088],
    [0.0092, 0.0092, 0.078, 0.09],
    [-0.0092, 0.0087, 0.073, 0.088],
    [-0.0262, 0.0076, 0.058, 0.082],
  ];
  for (const [v, r, len, u0] of FINGERS) {
    // the first half bent 0.25 rad toward the palm (−t), the rest 0.85 rad
    const ju = u0 + 0.5 * len * Math.cos(0.25), jt = -0.5 * len * Math.sin(0.25);
    const tip = hf(ju + 0.5 * len * Math.cos(0.85), v, jt - 0.5 * len * Math.sin(0.85));
    fingers.push(hand(cone('hand.L', hf(u0 - 0.008, v, 0), hf(ju, v, jt), r, r * 0.88, { blend: 0.004 })), hand(cone('hand.L', hf(ju, v, jt), tip, r * 0.88, r * 0.74, { blend: 0.003 })));
  }
  const armL: Prim[] = [
    // the upper arm starts a little down from the joint: a round end centred
    // on the pivot would stay put as the arm is lowered from the modelling
    // pose and stand out over it as a puffed sleeve
    cone('upperArm.L', lerp3(J.shoulder, J.elbow, 0.12), J.elbow, 0.047, 0.038, { blend: 0.03, part: 'arm', region: 'armL' }),
    cone('foreArm.L', J.elbow, J.wrist, 0.038, 0.027, { blend: 0.02, part: 'arm', region: 'armL' }),
    // the forearm's muscle belly below the elbow (no straight tube)
    ellipsoid('foreArm.L', [0.185 * shW + 0.135, 1.09, -0.035], [0.037, 0.065, 0.037], { rot: [0, 0, hr], blend: 0.03, part: 'arm', region: 'armL' }),
    hand(ellipsoid('hand.L', hf(0.047, 0.003, 0.001), [0.0155, 0.046, 0.041], { rot: [0, 0, hr], blend: 0.013 })),
    // ball of the thumb on the palm
    hand(ellipsoid('hand.L', hf(0.032, 0.024, -0.009), [0.012, 0.03, 0.017], { rot: [0, 0, hr], blend: 0.01 })),
    ...fingers,
    // thumb: metacarpal from the heel of the palm, then the phalanges reaching
    // down beside (not against) the index finger
    hand(cone('hand.L', hf(0.014, 0.026, -0.006), hf(0.052, 0.044, -0.016), 0.0118, 0.0105, { blend: 0.008 })),
    hand(cone('hand.L', hf(0.052, 0.044, -0.016), hf(0.086, 0.05, -0.021), 0.0105, 0.0082, { blend: 0.004 })),
  ];
  const ax = J.ankle[0];
  const legL: Prim[] = [
    // the thighs on the leg's own grid with a small blend: on the coarse body
    // grid the gap between them filled in, an apron hanging from the hips
    cone('thigh.L', [J.hip[0], 0.92, -0.005], J.knee, 0.085, 0.058, { blend: 0.028, part: 'leg', region: 'legL' }),
    cone('shin.L', J.knee, J.ankle, 0.056, 0.04, { blend: 0.025, part: 'leg', region: 'legL' }),
    // the calf's muscle high on the back of the shin and the kneecap in front
    ellipsoid('shin.L', [J.knee[0] + 0.003, 0.37, -0.008], [0.052, 0.1, 0.056], { blend: 0.04, part: 'leg', region: 'legL' }),
    ellipsoid('thigh.L', [J.knee[0], 0.51, 0.052], [0.03, 0.032, 0.02], { blend: 0.025, part: 'leg', region: 'legL' }),
    // shoe: a low upper on a sole a little wider than it, a squared heel and a
    // toe that springs up off the ground (no loaf)
    roundBox('foot.L', [ax, 0.047, 0.045], [0.041, 0.034, 0.1], 0.03, { blend: 0.02, part: 'shoe', region: 'footL' }),
    ellipsoid('foot.L', [ax + 0.003, 0.034, 0.125], [0.041, 0.028, 0.062], { rot: [-0.2, 0, 0], blend: 0.02, part: 'shoe', region: 'footL' }),
    roundBox('foot.L', [ax, 0.011, 0.03], [0.045, 0.011, 0.112], 0.009, { blend: 0.006, part: 'shoe', region: 'footL' }),
    roundBox('foot.L', [ax, 0.032, -0.052], [0.037, 0.032, 0.034], 0.018, { blend: 0.012, part: 'shoe', region: 'footL' }),
  ];
  const mirrorSide = (n: string) => n.replace('.L', '.R').replace('armL', 'armR').replace('legL', 'legR').replace('handL', 'handR').replace('footL', 'footR');
  // skirt / dress: an A-line from the hips to just above the knee — a wide,
  // flat hem disc smooth-unioned into the hips (the large blend fills the cone
  // between them), covering the thighs
  const skirt: Prim[] = key.skirt
    ? [
        ellipsoid('hips', [0, 0.8, -0.012], [0.158 * hipW, 0.13, 0.125], { blend: 0.05, part: 'skirt', skin: 1.3 }),
        // the hem rides on the thighs (left / right halves) so it follows the
        // legs when walking and lies over the lap when sitting
        // (shallow front to back: a deep hem reads as a bell)
        ...symmetric([ellipsoid('thigh.L', [0.07 * hipW, 0.62, -0.012], [0.11 * hipW, 0.075, 0.14], { blend: 0.12, part: 'skirt', skin: 1.6 })]),
      ]
    : [];
  const body: Prim[] = [...torso, ...skirt, ...symmetric(armL, mirrorSide), ...symmetric(legL, mirrorSide)];

  // ---- head (scaled about the neck for children)
  const head: Prim[] = [
    ellipsoid('head', [0, 1.645, 0.0], [0.074, 0.105, 0.094], { blend: 0.03, part: 'head' }),
    ellipsoid('head', [0, 1.575, 0.028], [0.058, 0.05, 0.062], { blend: 0.035, part: 'head' }),
    // face relief: brow ridge, nose (bridge + tip), cheekbones, lips, chin and
    // shallow eye sockets so the face reads in side light
    ellipsoid('head', [0, 1.668, 0.078], [0.052, 0.011, 0.016], { blend: 0.02, part: 'head' }),
    cone('head', [0, 1.652, 0.09], [0, 1.622, 0.105], 0.008, 0.0105, { blend: 0.012, part: 'head' }),
    ellipsoid('head', [0, 1.621, 0.099], [0.0125, 0.012, 0.012], { blend: 0.01, part: 'head' }),
    ...symmetric([ellipsoid('head', [0.042, 1.616, 0.061], [0.02, 0.016, 0.02], { blend: 0.025, part: 'head' })]),
    ellipsoid('head', [0, 1.586, 0.083], [0.019, 0.0075, 0.011], { blend: 0.012, part: 'head' }),
    ellipsoid('head', [0, 1.55, 0.07], [0.022, 0.017, 0.017], { blend: 0.02, part: 'head' }),
    ...symmetric([ellipsoid('head', [0.031, 1.651, 0.098], [0.017, 0.01, 0.011], { sub: true, blend: 0.012, part: 'head' })]),
    // ears stand a little off the head, on a grid fine enough to keep the
    // plate (long hair falls over them: they would poke through it)
    ...(key.hair === 'long' ? [] : symmetric([ellipsoid('head', [0.077, 1.632, -0.008], [0.011, 0.027, 0.018], { rot: [0, -0.35, 0], blend: 0.008, part: 'ear', region: 'ear.L' })])),
  ];
  const hair: Prim[] = [];
  switch (key.hair) {
    case 'short':
      hair.push(ellipsoid('head', [0, 1.672, -0.012], [0.079, 0.093, 0.099], { blend: 0.012, part: 'hair' }));
      break;
    case 'long':
      hair.push(
        ellipsoid('head', [0, 1.67, -0.012], [0.081, 0.095, 0.1], { blend: 0.012, part: 'hair' }),
        ellipsoid('head', [0, 1.53, -0.06], [0.082, 0.16, 0.055], { blend: 0.04, part: 'hair' }),
        ...symmetric([ellipsoid('head', [0.068, 1.58, -0.02], [0.022, 0.09, 0.055], { blend: 0.03, part: 'hair' })]),
      );
      break;
    case 'cap':
      hair.push(
        ellipsoid('head', [0, 1.655, -0.02], [0.078, 0.08, 0.095], { blend: 0.01, part: 'hair' }),
        ellipsoid('head', [0, 1.69, -0.006], [0.083, 0.072, 0.1], { blend: 0.008, part: 'hat' }),
        ellipsoid('head', [0, 1.668, 0.1], [0.072, 0.011, 0.068], { rot: [-0.12, 0, 0], blend: 0.012, part: 'hat', region: 'brim' }),
      );
      break;
    case 'bushhat':
      hair.push(
        ellipsoid('head', [0, 1.665, -0.015], [0.078, 0.085, 0.097], { blend: 0.01, part: 'hair' }),
        ellipsoid('head', [0, 1.725, -0.004], [0.084, 0.07, 0.095], { blend: 0.012, part: 'hat' }),
        ellipsoid('head', [0, 1.69, -0.004], [0.16, 0.011, 0.165], { blend: 0.02, part: 'hat', region: 'brim' }),
      );
      break;
    case 'bald':
      break;
  }
  const headT = { scale: hs, about: J.neck };
  const all = transformPrims([...body, ...transformPrims([...head, ...hair].map((p) => (p.region ? p : { ...p, region: 'head' })), headT)], { scale: bs });
  const H = (v: Vec3): Vec3 => headPos(v);
  return {
    bones,
    roles: {
      root: 'hips',
      spine: ['spine'],
      chest: 'chest',
      neck: ['neck'],
      head: 'head',
      legs: {
        HL: { upper: 'thigh.L', lower: 'shin.L', foot: 'foot.L', contact: S(J.contact) },
        HR: { upper: 'thigh.R', lower: 'shin.R', foot: 'foot.R', contact: S([-J.contact[0], J.contact[1], J.contact[2]]) },
      },
      arms: {
        L: { clavicle: 'clav.L', upper: 'upperArm.L', lower: 'foreArm.L', hand: 'hand.L' },
        R: { clavicle: 'clav.R', upper: 'upperArm.R', lower: 'foreArm.R', hand: 'hand.R' },
      },
      muzzle: H([0, 1.56, 0.08]),
    },
    prims: all,
    height: (child ? 0.7 * (1.48 + (1.75 - 1.48) * hs) : bs * 1.75) + (key.hair === 'bushhat' ? 0.02 : 0),
    marks: {
      shoulderL: S(J.shoulder),
      hipL: S(J.hip),
      collarY: S(J.neck)[1] - 0.025 * bs,
      waistY: 0.985 * bs,
      shoeTop: 0.1 * bs,
      eyeL: H([0.032, 1.655, 0.083]),
      mouth: H([0, 1.585, 0.084]),
      headC: H([0, 1.645, 0]),
      headS: bs * hs,
      wristL: S(J.wrist),
      ankleL: S(J.ankle),
      bodyScale: bs,
    },
  };
}

export { capsule };
