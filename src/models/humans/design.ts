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
    // shoulders (deltoids)
    ...symmetric([ellipsoid('upperArm.L', [0.168 * shW, 1.405, -0.015], [0.05, 0.05, 0.052], { blend: 0.05, part: 'arm', region: 'armL' })], (n) => n.replace('.L', '.R').replace('armL', 'armR')),
    // neck
    cone('neck', [0, 1.44, -0.02], [0, 1.56, -0.005], 0.055, 0.047, { blend: 0.04, part: 'neck' }),
  ];
  if (f) {
    torso.push(...symmetric([ellipsoid('chest', [0.055, 1.27, 0.07], [0.058, 0.055, 0.045], { blend: 0.05, part: 'torso' })]));
  }
  // hand (A-pose: hanging along the forearm line, palm toward the thigh, thumb forward):
  // a palm, slightly cupped tapering fingers and a thumb, instead of a paddle
  const hx = 0.185 * shW + 0.215, hr = 0.4;
  const armL: Prim[] = [
    cone('upperArm.L', J.shoulder, J.elbow, 0.048, 0.038, { blend: 0.03, part: 'arm', region: 'armL' }),
    cone('foreArm.L', J.elbow, J.wrist, 0.038, 0.027, { blend: 0.02, part: 'arm', region: 'armL' }),
    ellipsoid('hand.L', [hx + 0.016, 0.868, -0.004], [0.019, 0.04, 0.04], { rot: [0, 0, hr], blend: 0.014, part: 'hand', region: 'handL' }),
    ellipsoid('hand.L', [hx + 0.031, 0.826, -0.002], [0.0135, 0.034, 0.034], { rot: [0.12, 0, hr + 0.08], blend: 0.012, part: 'hand', region: 'handL' }),
    cone('hand.L', [hx + 0.006, 0.884, 0.026], [hx + 0.022, 0.846, 0.047], 0.0105, 0.0075, { blend: 0.01, part: 'hand', region: 'handL' }),
  ];
  const legL: Prim[] = [
    cone('thigh.L', [J.hip[0], 0.92, -0.005], J.knee, 0.088, 0.058, { blend: 0.05, part: 'leg' }),
    cone('shin.L', J.knee, J.ankle, 0.056, 0.04, { blend: 0.025, part: 'leg', region: 'legL' }),
    // shoe
    roundBox('foot.L', [J.ankle[0], 0.045, 0.045], [0.045, 0.045, 0.125], 0.04, { blend: 0.025, part: 'shoe', region: 'legL' }),
  ];
  const mirrorSide = (n: string) => n.replace('.L', '.R').replace('armL', 'armR').replace('legL', 'legR').replace('handL', 'handR');
  // skirt / dress: an A-line from the hips to just above the knee — a wide,
  // flat hem disc smooth-unioned into the hips (the large blend fills the cone
  // between them), covering the thighs
  const skirt: Prim[] = key.skirt
    ? [
        ellipsoid('hips', [0, 0.8, -0.012], [0.158 * hipW, 0.13, 0.125], { blend: 0.05, part: 'skirt', skin: 1.3 }),
        // the hem rides on the thighs (left / right halves) so it follows the
        // legs when walking and lies over the lap when sitting
        ...symmetric([ellipsoid('thigh.L', [0.07 * hipW, 0.62, -0.012], [0.11 * hipW, 0.075, 0.155], { blend: 0.12, part: 'skirt', skin: 1.6 })]),
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
    ...symmetric([ellipsoid('head', [0.074, 1.632, -0.005], [0.012, 0.026, 0.017], { blend: 0.01, part: 'ear' })]),
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
    },
  };
}

export { capsule };
