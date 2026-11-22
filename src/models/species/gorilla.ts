// Western lowland gorilla (Gorilla gorilla gorilla) — 'primate' rig.
//
// Sculpted in the knuckle-walking stance: massive shoulders and long arms
// resting on the curled fingers, short bowed legs on flat feet, a deep chest
// and big gut, a short neck sunk between the trapezius. Adult males are
// silverbacks: larger (separate mesh), a tall sagittal crest, a bare chest
// and a grey-silver saddle over the back and thighs. Faces, hands and feet are
// bare leathery skin; the coat is black with a brownish cast and a reddish
// crown. Animation (species-special-rigs/primate.ts): knuckle-walking, upright
// sitting (eating with hands to the mouth, grooming), bipedal chest-beating
// call, belly-down sleep, crouched drinking, bouncy play.

import { cone, ellipsoid, mirrorX, roundBox, sphere, symmetric, type Prim, type Vec3 } from '../sdf/prims';
import { quadSkeleton, seat, surfacePoint, withRegion, type QuadJoints } from '../kit/quadruped';
import { quadParams } from '../anim/quadruped';
import { driver } from '../anim/util';
import { blendHex, clamp01, fbm, smooth } from '../coat/coat';
import { apeDriver } from './species-special-rigs/primate';
import type { CoatSample, CreatureDesign, DesignContext, SpeciesModel } from '../types';
import * as THREE from 'three';

const J: QuadJoints = {
  hips: [0, 0.74, -0.24],
  spine: [
    [0, 0.82, -0.08],
    [0, 0.9, 0.07],
  ],
  chest: [0, 0.97, 0.21],
  neck: [[0, 1.02, 0.35]],
  head: [0, 1.04, 0.44],
  jaw: [0, 0.97, 0.5],
  ear: [0.1, 1.06, 0.45],
  tail: [],
  front: {
    scap: [0.12, 1.06, 0.22],
    upper: [0.25, 0.96, 0.3],
    lower: [0.29, 0.555, 0.235],
    foot: [0.28, 0.17, 0.335],
    toe: [0.28, 0.07, 0.36],
    contact: [0.28, 0, 0.37],
  },
  hind: {
    upper: [0.15, 0.71, -0.3],
    lower: [0.22, 0.38, -0.15],
    foot: [0.2, 0.095, -0.32],
    toe: [0.2, 0.03, -0.13],
    contact: [0.2, 0, -0.17],
  },
  muzzle: [0, 0.95, 0.61],
};

// long-hair noise for limbs (strands along the limb axis)
const hair = (seed: number, amp = 0.012) => ({ amp, freq: 26, stretch: [1.6, 0.35, 1.6] as Vec3, octaves: 2, ridged: true, seed });

function bodyPrims(male: boolean): Prim[] {
  const g = male ? 1 : 0.88;
  const P: Prim[] = [
    // deep barrel chest (trunk inclined ~30° in the knuckle-walking stance)
    ellipsoid('chest', [0, 0.84, 0.18], [0.275 * g, 0.255, 0.25], { rot: [-0.45, 0, 0], blend: 0.1, part: 'body' }),
    // upper back / shoulder girdle
    ellipsoid('chest', [0, 1.01, 0.16], [0.23 * g, 0.14, 0.22], { blend: 0.12, part: 'body' }),
    // mid back
    ellipsoid('spine_2', [0, 0.86, 0.03], [0.25 * g, 0.18, 0.2], { blend: 0.1, part: 'body' }),
    // big gut
    ellipsoid('spine_1', [0, 0.63, -0.04], [0.265 * g, 0.2, 0.23], { blend: 0.12, part: 'belly' }),
    // lower back
    ellipsoid('spine_1', [0, 0.8, -0.12], [0.22 * g, 0.12, 0.2], { blend: 0.1, part: 'body' }),
    // pelvis / rump
    ellipsoid('hips', [0, 0.69, -0.3], [0.205 * g, 0.16, 0.15], { blend: 0.1, part: 'body' }),
    // thick neck sunk between the shoulders
    cone('neck_1', [0, 0.97, 0.3], [0, 1.02, 0.44], 0.13 * g, 0.1 * g, { blend: 0.08, part: 'neck' }),
    // trapezius rising to the back of the skull
    ellipsoid('neck_1', [0, 1.09, 0.31], [0.14 * g, 0.085 * (male ? 1.1 : 0.85), 0.13], { rot: [-0.3, 0, 0], blend: 0.1, part: 'body' }),
    // shoulder blades and deltoids
    ...symmetric([
      ellipsoid('FL_scap', [0.15, 1.0, 0.19], [0.11 * g, 0.14, 0.14], { blend: 0.1, part: 'body' }),
      ellipsoid('FL_upper', [0.262, 0.91, 0.29], [0.125 * g, 0.14, 0.125 * g], { blend: 0.08, part: 'arm' }),
    ]),
  ];
  if (male) {
    // bare, broad pectoral plate of a silverback
    P.push(ellipsoid('chest', [0, 0.78, 0.33], [0.17, 0.12, 0.08], { rot: [-0.6, 0, 0], blend: 0.08, part: 'chestskin' }));
  }
  return P;
}

function armPrimsLeft(male: boolean): Prim[] {
  const g = male ? 1 : 0.86;
  const f = J.front;
  return [
    // upper arm: biceps / triceps mass
    cone('FL_upper', f.upper, f.lower, 0.115 * g, 0.088 * g, { blend: 0.07, part: 'arm' }),
    ellipsoid('FL_upper', [0.275, 0.76, 0.27], [0.105 * g, 0.17, 0.108 * g], { blend: 0.06, part: 'arm', noise: hair(51, 0.008) }),
    // forearm: heavy at the elbow, long hair, tapering to the wrist
    cone('FL_lower', f.lower, [0.281, 0.2, 0.33], 0.092 * g, 0.06, { blend: 0.05, part: 'arm' }),
    ellipsoid('FL_lower', [0.288, 0.45, 0.262], [0.092 * g, 0.14, 0.088 * g], { rot: [0.25, 0, 0], blend: 0.05, part: 'arm', noise: hair(52, 0.01) }),
    // hand: metacarpal block (back of the hand faces forward), curled fingers on the ground
    roundBox('FL_foot', [0.28, 0.125, 0.343], [0.056, 0.056, 0.038], 0.032, { rot: [0.12, 0, 0], blend: 0.035, part: 'hand', region: 'FL' }),
    roundBox('FL_toe', [0.28, 0.042, 0.368], [0.061, 0.04, 0.046], 0.034, { blend: 0.025, part: 'finger', region: 'FL' }),
    ...[-0.039, -0.013, 0.013, 0.039].map((dx) =>
      sphere('FL_toe', [0.28 + dx, 0.04 - Math.abs(dx) * 0.15, 0.404 - Math.abs(dx) * 0.25], 0.021, { blend: 0.012, part: 'finger', region: 'FL' }),
    ),
    // thumb on the inner side
    cone('FL_foot', [0.236, 0.12, 0.335], [0.232, 0.07, 0.365], 0.019, 0.015, { blend: 0.015, part: 'finger', region: 'FL' }),
    roundBox('FL_toe', [0.28, -0.05, 0.37], [0.12, 0.05, 0.12], 0.01, { sub: true, blend: 0.008, part: 'finger', region: 'FL' }),
  ];
}

function legPrimsLeft(male: boolean): Prim[] {
  const g = male ? 1 : 0.88;
  const h = J.hind;
  return [
    // thigh (bowed, knees out)
    cone('HL_upper', h.upper, h.lower, 0.135 * g, 0.095 * g, { blend: 0.09, part: 'leg' }),
    ellipsoid('HL_upper', [0.18, 0.57, -0.24], [0.12 * g, 0.16, 0.13 * g], { rot: [0.4, 0, 0], blend: 0.08, part: 'leg' }),
    // shank + calf
    cone('HL_lower', h.lower, [0.2, 0.12, -0.31], 0.088 * g, 0.056, { blend: 0.05, part: 'leg' }),
    ellipsoid('HL_lower', [0.213, 0.28, -0.235], [0.074 * g, 0.1, 0.078], { rot: [-0.5, 0, 0], blend: 0.05, part: 'leg' }),
    // plantigrade foot with a divergent big toe
    sphere('HL_foot', [0.2, 0.095, -0.315], 0.048, { blend: 0.04, part: 'foot', region: 'HL' }),
    ellipsoid('HL_foot', [0.2, 0.048, -0.25], [0.058, 0.044, 0.12], { blend: 0.035, part: 'foot', region: 'HL' }),
    sphere('HL_foot', [0.2, 0.045, -0.35], 0.043, { blend: 0.03, part: 'foot', region: 'HL' }),
    ellipsoid('HL_toe', [0.207, 0.027, -0.1], [0.06, 0.026, 0.045], { blend: 0.03, part: 'toes', region: 'HL' }),
    cone('HL_foot', [0.158, 0.04, -0.21], [0.127, 0.028, -0.125], 0.024, 0.017, { blend: 0.02, part: 'toes', region: 'HL' }),
    roundBox('HL_toe', [0.2, -0.05, -0.22], [0.14, 0.05, 0.22], 0.01, { sub: true, blend: 0.008, part: 'foot', region: 'HL' }),
  ];
}

function headPrims(male: boolean): Prim[] {
  const P: Prim[] = [
    // braincase
    ellipsoid('head', [0, 1.07, 0.47], [0.095, 0.09, 0.1], { blend: 0.05, part: 'head' }),
    // occiput sloping into the neck hump
    ellipsoid('head', [0, 1.09, 0.4], [0.085, 0.07, 0.07], { blend: 0.06, part: 'head' }),
    // massive cheeks / jowls
    ...symmetric([ellipsoid('head', [0.066, 0.985, 0.505], [0.046, 0.06, 0.06], { blend: 0.05, part: 'head' })]),
    // mid face and cheekbones
    ellipsoid('head', [0, 1.02, 0.55], [0.07, 0.058, 0.05], { blend: 0.04, part: 'face' }),
    ...symmetric([ellipsoid('head', [0.058, 1.018, 0.548], [0.036, 0.034, 0.04], { blend: 0.03, part: 'face' })]),
    // brow ridge (supraorbital torus): a heavy shelf arching over each eye
    ellipsoid('head', [0, 1.084, 0.566], [0.03, 0.026, 0.036], { blend: 0.025, part: 'face' }),
    ...symmetric([ellipsoid('head', [0.043, 1.076, 0.57], [0.05, 0.025, 0.038], { rot: [0, 0.2, -0.22], blend: 0.025, part: 'face' })]),
    // narrow nasal bridge, then the broad nose with big flared alae
    ellipsoid('head', [0, 1.038, 0.585], [0.017, 0.03, 0.018], { blend: 0.02, part: 'face' }),
    ellipsoid('head', [0, 1.0, 0.603], [0.03, 0.03, 0.022], { blend: 0.02, part: 'face' }),
    ...symmetric([sphere('head', [0.027, 0.994, 0.598], 0.024, { blend: 0.014, part: 'face' })]),
    // projecting muzzle / upper lip
    ellipsoid('head', [0, 0.958, 0.584], [0.07, 0.04, 0.046], { blend: 0.03, part: 'face' }),
    // mandible + chin
    ellipsoid('jaw', [0, 0.925, 0.548], [0.076, 0.042, 0.06], { blend: 0.035, part: 'face' }),
    ellipsoid('jaw', [0, 0.916, 0.58], [0.054, 0.027, 0.03], { blend: 0.02, part: 'face' }),
    // nostrils, mouth line, eye sockets under the brow
    ...symmetric([ellipsoid('head', [0.022, 0.986, 0.62], [0.012, 0.009, 0.012], { rot: [0.3, 0, -0.4], sub: true, blend: 0.006, part: 'face' })]),
    ellipsoid('head', [0, 0.94, 0.616], [0.05, 0.003, 0.026], { sub: true, blend: 0.005, part: 'face' }),
    ...symmetric([sphere('head', [0.038, 1.045, 0.594], 0.016, { sub: true, blend: 0.008, part: 'face' })]),
    // small ears close to the skull
    ...symmetric([ellipsoid('ear.L', [0.096, 1.056, 0.45], [0.013, 0.024, 0.018], { rot: [0, 0.35, 0], blend: 0.012, part: 'ear' })]),
  ];
  if (male) {
    // sagittal crest: a tall ridge of bone, muscle and fat — the conical silverback head
    P.push(cone('head', [0, 1.12, 0.52], [0, 1.21, 0.42], 0.062, 0.03, { blend: 0.07, part: 'crest' }));
    P.push(ellipsoid('head', [0, 1.15, 0.45], [0.06, 0.06, 0.09], { blend: 0.06, part: 'crest' }));
  } else {
    P.push(ellipsoid('head', [0, 1.13, 0.46], [0.07, 0.06, 0.08], { blend: 0.06, part: 'crest' }));
  }
  return P;
}

// ---------------------------------------------------------------------------
// Coat

const FUR = 0x221f1d;
const FUR_BROWN = 0x3b3029;
const CROWN = 0x4a3022;
const SILVER = 0x77746f;
const SKIN = 0x121110;
const CHESTSKIN = 0x232121;

function gorillaCoat(male: boolean, eye: Vec3) {
  return (c: CoatSample): void => {
    const { x, y, z } = c;
    const ax = Math.abs(x);
    const n = fbm(x * 7, y * 7, z * 7, 3, 41);
    const n2 = fbm(x * 23, y * 23, z * 23, 2, 43);
    c.color.setHex(FUR);
    // brownish cast in the long hair of the limbs and flanks
    blendHex(c.color, FUR_BROWN, clamp01(0.3 + n * 0.5 + n2 * 0.2));
    c.fur = 1.6;
    const limb = c.pw('arm') + c.pw('leg');
    c.fur += limb * 1.4;
    // reddish-brown crown
    const crown = clamp01(c.pw('crest') * 1.4) * smooth(1.06, 1.12, y);
    blendHex(c.color, CROWN, crown * (0.75 + n * 0.2));
    if (male) {
      // silver saddle: back from behind the shoulders to the rump, down onto the thighs
      const back = smooth(-0.1, 0.45, c.ny) * smooth(0.12, -0.04, z) * smooth(-0.46, -0.3, z) * smooth(0.62, 0.78, y);
      const thigh = c.pw('leg') * smooth(0.0, 0.5, c.ny + 0.4 * Math.sign(x) * c.nx) * smooth(0.45, 0.65, y) * smooth(-0.1, -0.2, z);
      // streaky: grey-tipped hairs mixed with black
      const streak = fbm(x * 40, y * 9, z * 40, 2, 47);
      const sd = clamp01(Math.max(back, thigh * 0.6) * (0.8 + streak * 0.5) + (n2 - 0.2) * 0.25);
      if (sd > 0) {
        blendHex(c.color, SILVER, sd * (0.8 + n * 0.2));
        c.fur = Math.max(1, c.fur - sd * 0.5);
      }
    }
    // bare leathery skin: face, fingers, palms, soles, toes
    const face = c.pw('face');
    const bare = clamp01(face * 1.6 + c.pw('finger') * 1.5 + c.pw('toes') * 1.6 + c.pw('hand') * smooth(0.12, 0.05, y) * 1.2 + c.pw('foot') * smooth(0.05, 0.0, c.ny) * 1.5);
    if (bare > 0.05) {
      const k = smooth(0.05, 0.6, bare);
      blendHex(c.color, SKIN, k);
      c.gloss = Math.max(c.gloss, 0.34 * k);
      c.fur = 1 + (c.fur - 1) * (1 - k);
      // slightly lighter, greyer lips and a darker nose
      if (face > 0.5 && y < 0.965 && z > 0.57) blendHex(c.color, 0x2b2726, 0.5);
    }
    if (c.part === 'ear') {
      blendHex(c.color, SKIN, 0.85);
      c.gloss = 0.1;
    }
    // male bare chest
    const cs = c.pw('chestskin');
    if (cs > 0.25 && c.nz > 0.0 && ax < 0.16) {
      const k = smooth(0.25, 0.6, cs) * smooth(0.0, 0.3, c.nz) * smooth(0.16, 0.1, ax);
      blendHex(c.color, CHESTSKIN, k);
      c.gloss = Math.max(c.gloss, 0.1 * k);
      c.fur = 1 + (c.fur - 1) * (1 - k);
    }
    // darker, wet-looking skin around the eyes
    const ex = ax - eye[0], ey = y - eye[1], ez = z - eye[2];
    const ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (ed < 0.03) {
      const k = smooth(0.03, 0.016, ed);
      blendHex(c.color, 0x0d0c0c, k);
      c.gloss = Math.max(c.gloss, 0.25 * k);
    }
  };
}

function design(ctx: DesignContext): CreatureDesign {
  const male = ctx.sex === 'M';
  const sk = quadSkeleton(J);
  const head = withRegion(headPrims(male), 'head');
  const prims: Prim[] = [...bodyPrims(male), ...head, ...armPrimsLeft(male), ...mirrorX(armPrimsLeft(male)), ...legPrimsLeft(male), ...mirrorX(legPrimsLeft(male))];
  // eyes sit deep under the brow ridge
  const eyeDir: Vec3 = [0, 0.05, -1];
  const hit = surfacePoint(head, [0.037, 1.04, 0.7], eyeDir, 0.3);
  const eye = seat(hit, eyeDir, 0.0045);
  const def = ctx.def;
  const quad = quadParams(0.95, def.walkSpeed, def.runSpeed, {
    walk: {
      stride: 1.05, refSpeed: def.walkSpeed, duty: 0.66, offsets: [0.25, 0.75, 0, 0.5], stepHeight: 0.07,
      bob: 0.012, bobFreq: 2, pitch: 0.02, roll: 0.045, headBob: 0.03, spineFlex: 0,
    },
    trot: {
      stride: 1.5, refSpeed: def.walkSpeed * 2, duty: 0.5, offsets: [0.4, 0.9, 0, 0.5], stepHeight: 0.09,
      bob: 0.02, bobFreq: 2, pitch: 0.03, roll: 0.04, headBob: 0.03, spineFlex: 0.02,
    },
    gallop: {
      stride: 2.4, refSpeed: def.runSpeed, duty: 0.34, offsets: [0.5, 0.6, 0, 0.12], stepHeight: 0.14,
      bob: 0.04, bobFreq: 1, pitch: 0.08, roll: 0.02, headBob: 0.05, spineFlex: 0.08,
    },
    look: 0.6,
    headCarry: 0.05,
    breath: 0.01,
  });
  const anim = apeDriver({
    quad,
    sitHipsY: 0.205,
    sitPitch: -1.02,
    standPitch: -1.06,
    standLift: -0.07,
    proneHipsY: 0.3,
    mouth: new THREE.Vector3(0, 0.945, 0.6),
    chestHit: new THREE.Vector3(0.1, 0.68, 0.36),
    chestNormal: new THREE.Vector3(0.3, -0.62, 0.72),
    callDuration: 2.8,
  });
  return {
    bones: sk.bones,
    roles: {
      ...sk.roles,
      arms: {
        L: { clavicle: 'FL_scap', upper: 'FL_upper', lower: 'FL_lower', hand: 'FL_foot' },
        R: { clavicle: 'FR_scap', upper: 'FR_upper', lower: 'FR_lower', hand: 'FR_foot' },
      },
    },
    prims,
    resolution: 0.77,
    regions: {
      head: { scale: 0.42 },
      FL: { scale: 0.45 },
      FR: { scale: 0.45 },
      HL: { scale: 0.45 },
      HR: { scale: 0.45 },
    },
    coat: gorillaCoat(male, eye),
    look: { skin: 'fur', pattern: 'none', roughness: 0.9, sheen: 0.4, grain: 0.008, bump: 0.45, mottle: 0.09 },
    eyes: [{ bone: 'head', pos: eye, radius: 0.0105, color: 0x2b170b }],
    anim: driver(anim),
    babyScale: 0.3,
    babyHead: 1.4,
    height: male ? 1.3 : 1.15,
    radius: 0.55,
  };
}

const gorilla: SpeciesModel = {
  id: 'gorilla',
  dimorphic: true,
  design,
  // silverbacks weigh about twice as much as females (≈ 0.8 linear)
  instanceScale: (sex, r) => (sex === 'M' ? 1.0 : 0.82) * (0.97 + r * 0.06),
};
export default gorilla;
