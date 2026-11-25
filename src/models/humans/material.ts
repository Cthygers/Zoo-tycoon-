// Human materials. Clothing regions come from the baked `zone` attribute
//   x = distance from the shoulder joint along the arm (−1 off the arm)
//   y = distance from the hip joint along the leg (−1 off the leg)
//   z = hair signed distance (> 0 on hair), w = hat signed distance (> 0 on the hat)
// plus the rest-space height, and are coloured from per-person parameters.
//
// Two variants share the same shading code (humanColorGLSL):
//   * createHumanMaterial      — one material per person, parameters as uniforms
//                                (standalone models: UI thumbnails, other scenes)
//   * createHumanBatchMaterial — one material for the whole crowd; parameters
//                                are per-instance texels of the batch data
//                                texture (HUMAN_LOOK_TEXELS, see writeHumanLook)
//                                passed to the fragment shader as flat varyings.
// Both get warm light from the night lamps a person stands under
// (props/lights/lampField.ts, applied last in onBeforeCompile), and the same
// surface model: skin with a warm subsurface wrap, matte fabric (drape folds,
// a sheen in its own colour, no white grazing reflection), hair with volume
// (a lit crown, shaded under-layers, locks, a wavering hairline), the body's
// creases baked per vertex (between the fingers, the armpits), and a face
// painted where the coarse mesh cannot model it (eye sockets, the shade beside
// and under the nose, the mouth line, the chin's and the hair's shadows): marks
// that keep their darkness at a distance instead of sparkling.

import * as THREE from 'three';
import { HIGHLIGHT_FN_GLSL, NOISE_GLSL } from '../material/shaderChunks';
import { crowdDepthMaterial, type BatchMaterials } from '../crowd/materials';
import { crowdUniforms, patchCrowdVertex } from '../crowd/skinning';
import { applyLampField } from '../../props/lights/lampField';

export interface HumanColors {
  skin: number;
  hair: number;
  shirt: number;
  pants: number;
  shoes: number;
  hat: number;
}

export interface HumanCut {
  /** Sleeve length from the shoulder joint (m, rest units). */
  sleeve: number;
  /** Trouser length from the hip joint (m); short ≈ 0.3, full ≈ 1. */
  pants: number;
  /** Extra shirt colour down the legs (lab coat), m from the hip joint. */
  coat: number;
  /** Girth inflation (m) applied along the normal × per-vertex girth weight. */
  inflate: number;
  /** Garment print and small style choices (humanStyle bits; 0 = plain). */
  style?: number;
}

/** Prints of a top (humanStyle). Plain is the most common; staff wear plain. */
export const HUMAN_PRINTS = { plain: 0, stripes: 1, check: 2, ringer: 3, graphic: 4, marl: 5 } as const;

export interface HumanStyle {
  print: number;
  /** Pale rubber soles (trainers) instead of soles in the shoe's own dark tone. */
  lightSole: boolean;
  /** Close-cropped stubble on a bald scalp and the jaw (adult men). */
  stubble: boolean;
  neckline: Neckline;
}

/** Neckline of a top: a crew neck, or a V-neck, cut shallow (men's) or deeper (women's). */
export type Neckline = 'crew' | 'v' | 'deepV';

/** Pack a HumanStyle into one small integer (exact in a float texel): print in bits 0–2, then sole, stubble, V-neck, deep V. */
export function humanStyle(s: HumanStyle): number {
  return (s.print & 7) | (s.lightSole ? 8 : 0) | (s.stubble ? 16 : 0) | (s.neckline !== 'crew' ? 32 : 0) | (s.neckline === 'deepV' ? 64 : 0);
}

export interface HumanMarks {
  collarY: number;
  waistY: number;
  shoeTop: number;
  eyeL: [number, number, number];
  mouth: [number, number, number];
}

export type HumanMaterial = THREE.MeshStandardMaterial & { userData: { human: HumanUniforms } };

interface HumanUniforms {
  uSkin: { value: THREE.Color };
  uHair: { value: THREE.Color };
  uShirt: { value: THREE.Color };
  uPants: { value: THREE.Color };
  uShoes: { value: THREE.Color };
  uHat: { value: THREE.Color };
  uCut: { value: THREE.Vector4 };
  uMarks: { value: THREE.Vector3 };
  uEye: { value: THREE.Vector3 };
  uMouth: { value: THREE.Vector3 };
  uMicro: { value: number };
  /** humanStyle bits. */
  uStyle: { value: number };
  /** Selection highlight amount (0 = off; pulsed by HumanModel). */
  uHighlight: { value: number };
}

interface ColorExpr {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
  shoes: string;
  hat: string;
  /** vec4(sleeve, pants, coat, inflate) */
  cut: string;
  /** vec3(collarY, waistY, shoeTop) */
  marks: string;
  eye: string;
  mouth: string;
  /** humanStyle bits (float) */
  style: string;
}

const FRAG_HELPERS = `${NOISE_GLSL}
float hm_step(float edge, float v) { float a = max(fwidth(v), 1e-4); return smoothstep(edge - a, edge + a, v); }
// A soft ellipsoidal face mark of radii r about c, widened by the pixel
// footprint fp and weakened by the same area: far away it is a faint smudge of
// the same total darkness, never a sparkling dot.
float hm_mark(vec3 p, vec3 c, vec3 r, float fp) {
  vec3 rw = sqrt(r * r + fp * fp);
  return (1.0 - smoothstep(0.3, 1.0, length((p - c) / rw))) * (r.x * r.y) / (rw.x * rw.y);
}
// Stripes of period 1 (0 / 1 halves) box-filtered over w periods: exact
// coverage, so they settle to an even 0.5 tint instead of aliasing as they
// shrink toward the pixel size.
float hm_stripe(float x, float w) {
  w = max(w, 1e-4);
  vec2 a = vec2(x - 0.5 * w, x + 0.5 * w);
  vec2 i = floor(a) * 0.5 + max(fract(a) - 0.5, 0.0);
  return (i.y - i.x) / w;
}`;

// Detail that is not geometry (fabric drape, hair locks, face marks) is sized
// in rest-space metres and judged against the rest-space size of a pixel
// (hmPix = |fwidth(vRestPos)| ≈ 1.4 px): noise fades to its mean before its
// cells shrink under ~2.5 px (no shimmer on a phone), and face marks widen
// into soft smudges of the same total darkness instead of vanishing, so a face
// keeps its eyes and brows at 4–8 m.

/** Clothing / skin / face colouring (replaces <color_fragment>); sets hmCol, hmRough and the skin / fabric / hair masks. */
function humanColorGLSL(e: ColorExpr): string {
  return `#include <color_fragment>
vec3 hmCol = ${e.skin};
float hmRough = 0.6;
float hmSkin = 1.0;
float hmCloth = 0.0;
float hmHair = 0.0;
{
  vec4 hmCut = ${e.cut};
  vec3 hmMarks = ${e.marks};
  float hmPix = length(fwidth(vRestPos));
  float armT = vZone.x;
  float legT = vZone.y;
  float y = vRestPos.y;
  float hmBs = hmMarks.z * 10.0; // body scale (shoe top is 0.1 × body scale)
  float hmStyle = ${e.style};
  float hmPrint = floor(mod(hmStyle, 8.0) + 0.5);
  float onArm = hm_step(0.0, armT);
  float onLeg = hm_step(0.0, legT);
  float trunk = (1.0 - onArm) * (1.0 - onLeg);
  // the neckline dips at the front (a crew neck ≈ 2.5 cm, a V-neck to a point:
  // 4.5 cm on a man's tee, 6.5 cm on a woman's), not a painted ring round the
  // neck; beside the V it sits like a crew neck
  float front = smoothstep(-0.01, 0.06, vRestPos.z / hmBs);
  float vNeck = mod(floor(hmStyle / 32.0), 2.0);
  float vDepth = hmStyle >= 64.0 ? 0.065 : 0.045;
  float crewDip = 0.026 * (1.0 - smoothstep(0.0, 0.065, abs(vRestPos.x) / hmBs));
  float neckY = hmMarks.x - hmBs * front * mix(crewDip, max(crewDip, vDepth - 1.3 * abs(vRestPos.x) / hmBs), vNeck);
  // the collar rings the base of the neck (reaching forward over the dip):
  // beyond the ring the edge climbs the slope of the shoulders, so they stay
  // covered where they rise above the neckline (no bare boat neck from
  // shoulder to shoulder) and the collar curves round the neck; the neck and
  // head above the shoulders are bare all round
  float collarR = length(vec2(vRestPos.x, vRestPos.z + 0.012 * hmBs)) / hmBs - 0.06 * front;
  float collarY = neckY + hmBs * min(1.5 * max(collarR - 0.072, 0.0), 0.04);
  float neckCut = 1.0 - hm_step(collarY, y);
  float upper = trunk * hm_step(hmMarks.y, y) * neckCut;
  float lower = trunk * (1.0 - hm_step(hmMarks.y, y));
  // sleeve lengths are authored on the adult body: a child's tee ends as high
  // up its shorter arm (no puffed sleeve down to the elbow)
  float sleeveT = hmCut.x * hmBs;
  float sleeve = onArm * (1.0 - hm_step(sleeveT, armT));
  float pantsLeg = onLeg * (1.0 - hm_step(hmCut.y, legT));
  float coatLeg = onLeg * (1.0 - hm_step(hmCut.z, legT));
  float shirtM = clamp(upper + sleeve + coatLeg, 0.0, 1.0);
  float pantsM = clamp(lower + pantsLeg, 0.0, 1.0) * (1.0 - coatLeg);
  // fabric: soft drape folds hanging down the garment (4.5 cm) and finer
  // wrinkles on medium / high (2.2 cm), in tone and in roughness (never one
  // smooth plastic tone)
  float drape = (cr_vnoise(vRestPos * vec3(22.0, 6.0, 22.0)) - 0.5) * (1.0 - smoothstep(0.016, 0.032, hmPix));
  if (uMicro > 0.5) drape += (cr_vnoise(vRestPos * vec3(45.0, 14.0, 45.0) + 7.3) - 0.5) * 0.6 * (1.0 - smoothstep(0.008, 0.016, hmPix));
  // jeans (blue bottoms): worn pale on the thigh fronts and knees
  vec3 hmPantsCol = ${e.pants};
  float jeans = step(1.6 * hmPantsCol.r, hmPantsCol.b) * step(1.2 * hmPantsCol.g, hmPantsCol.b);
  float wear = onLeg * smoothstep(0.0, 0.08, vRestPos.z / hmBs + 0.02) * (0.6 + 0.8 * cr_vnoise(vRestPos * vec3(18.0, 5.0, 18.0)));
  hmPantsCol *= 1.0 + 0.35 * jeans * wear;
  // a skirt (the only garment on the trunk below the seat) hangs in soft
  // flutes that deepen toward the hem, not a smooth bell
  float skirtFold = trunk * (1.0 - smoothstep(0.72, 0.8, y / hmBs)) * (1.0 - smoothstep(0.62, 0.86, y / hmBs));
  float flutes = sin(atan(vRestPos.z, vRestPos.x) * 9.0 + 2.0 * cr_vnoise(vRestPos * 12.0));
  hmPantsCol *= 1.0 - 0.14 * skirtFold * (0.5 + 0.5 * flutes);
  hmCol = mix(hmCol, hmPantsCol * (1.0 + drape * 0.26), pantsM);
  // tops: prints in the top's own contrast colour (cream on dark tops, navy on
  // pale ones), each settling to its mean tint before its pattern reaches the
  // pixel size
  vec3 hmShirtCol = ${e.shirt};
  float shirtLum = dot(hmShirtCol, vec3(0.2126, 0.7152, 0.0722));
  vec3 hmContrast = shirtLum < 0.22 ? vec3(0.72, 0.7, 0.66) : vec3(0.035, 0.045, 0.08);
  if (hmPrint == 1.0) {
    float sp = 0.045 * hmBs;
    float st = hm_stripe(y / sp, hmPix / sp);
    hmShirtCol = mix(hmShirtCol, hmContrast, 0.75 * st);
  } else if (hmPrint == 2.0) {
    float cp = 0.06 * hmBs;
    float u = (vRestPos.x + vRestPos.z) * 0.7;
    float sy = hm_stripe(y / cp, hmPix / cp);
    float su = hm_stripe(u / cp + 0.25, hmPix / cp);
    hmShirtCol *= (1.0 - 0.32 * sy) * (1.0 - 0.32 * su) * (1.0 + 0.25 * sy * su * step(shirtLum, 0.22));
  } else if (hmPrint == 4.0) {
    // a slightly worn chest print
    vec2 gq = vec2(vRestPos.x, y - hmMarks.x + 0.17 * hmBs) / (hmBs * vec2(0.065, 0.045));
    float gw = hmPix / (0.05 * hmBs);
    float graphic = (1.0 - smoothstep(1.0 - gw, 1.0 + gw, max(abs(gq.x), abs(gq.y)))) * smoothstep(0.04, 0.07, vRestPos.z / hmBs);
    graphic *= 0.85 - 0.3 * cr_vnoise(vRestPos * 60.0) * (1.0 - smoothstep(0.008, 0.016, hmPix));
    hmShirtCol = mix(hmShirtCol, hmContrast, graphic * trunk);
  } else if (hmPrint == 5.0) {
    // heathered marl: flecks lighter and darker than the yarn's mean
    hmShirtCol *= 1.0 + 0.3 * (cr_vnoise(vRestPos * vec3(40.0, 18.0, 40.0) + 5.1) - 0.5) * (1.0 - smoothstep(0.016, 0.032, hmPix));
  }
  // hems: the rib round the neck, the doubled hem of each sleeve and of the
  // top (a ringer tee has them in its contrast colour), each a little darker
  // where the fabric folds over
  float rib = trunk * hm_step(neckY - 0.014 * hmBs + hmBs * min(1.5 * max(collarR - 0.086, 0.0), 0.04), y);
  float cuff = onArm * hm_step(sleeveT - 0.018 * hmBs, armT);
  float hem = trunk * (1.0 - hm_step(hmMarks.y + 0.025 * hmBs, y));
  float hems = max(max(rib, cuff), hem * step(hmCut.z, 0.0));
  hmShirtCol = hmPrint == 3.0 ? mix(hmShirtCol, hmContrast, max(rib, cuff)) : hmShirtCol * (1.0 - 0.12 * hems);
  hmCol = mix(hmCol, hmShirtCol * (1.0 + drape * 0.22), shirtM);
  // waistband under the hem of the top (not on a lab coat): separates top and bottom
  float belt = trunk * (1.0 - hm_step(hmMarks.y, y)) * hm_step(hmMarks.y - 0.03, y) * step(hmCut.z, 0.0);
  hmCol = mix(hmCol, ${e.pants} * 0.4, belt);
  // trouser hems: the break above the shoe, the turn-up of shorts
  float pantsHem = max(1.0 - hm_step(hmMarks.z + 0.03 * hmBs, y), onLeg * hm_step(hmCut.y - 0.02 * hmBs, legT));
  hmCol *= 1.0 - 0.16 * pantsHem * pantsM;
  // skin just past a sleeve or a short trouser leg sits in its opening's shade
  float openingShade = onArm * (1.0 - hm_step(sleeveT + 0.022 * hmBs, armT)) + onLeg * (1.0 - hm_step(hmCut.y + 0.022 * hmBs, legT));
  hmCol *= 1.0 - 0.18 * openingShade * (1.0 - max(shirtM, pantsM));
  float clothM = max(shirtM, pantsM);
  hmRough = mix(hmRough, 0.93 - drape * 0.1, clothM);
  float shoe = onLeg * (1.0 - hm_step(hmMarks.z, y));
  // a sole (pale rubber on trainers) under a darker welt line
  float sole = 1.0 - hm_step(0.022 * hmBs, y);
  float welt = (1.0 - hm_step(0.03 * hmBs, y)) * (1.0 - sole);
  vec3 soleCol = mod(floor(hmStyle / 8.0), 2.0) > 0.5 ? vec3(0.62, 0.6, 0.56) : ${e.shoes} * 0.55;
  hmCol = mix(hmCol, mix(${e.shoes} * (1.0 - 0.3 * welt), soleCol, sole), shoe);
  hmRough = mix(hmRough, mix(0.55, 0.85, sole), shoe);
  vec3 hmEye = ${e.eye};
  float hk = (hmEye.y - ${e.mouth}.y) / 0.07; // head scale (adult 1)
  vec3 fq = (vRestPos - vec3(0.0, hmEye.y, hmEye.z)) / hk; // face frame: eye line, eye depth
  // hair: a soft hairline (skin shows through the first few mm) that wavers by
  // about a centimetre, not a helmet's clean rim; volume, not a painted cap
  // (the crown catches the light, the under-layers and the ends below the
  // ears sit in their own shade); locks along its fall with their own
  // roughness and broader 4 cm clumps that still show at the closest zoom.
  // Each detail settles to its mean before its cells reach pixel size.
  float hairWave = (cr_vnoise(vRestPos * vec3(50.0, 32.0, 50.0) + 3.1) - 0.5) * (1.0 - smoothstep(0.012, 0.024, hmPix));
  // and in coarser tufts that still show at the closest zoom (they only pull
  // the edge back, so a bald man's stubble fringe keeps its cover)
  float hairTufts = cr_vnoise(vRestPos * vec3(22.0, 14.0, 22.0) + 8.3) * (1.0 - smoothstep(0.024, 0.048, hmPix));
  float hairM = max(hm_step(0.004 + 0.005 * hairWave + 0.006 * hairTufts, vZone.z), 0.6 * smoothstep(-0.003, 0.004, vZone.z));
  float locks = (cr_vnoise(vRestPos * vec3(45.0, 10.0, 45.0)) - 0.5) * (1.0 - smoothstep(0.008, 0.016, hmPix));
  float hairLift = mix(0.74, 1.06, smoothstep(-0.1, 0.07, fq.y));
  float clumps = (cr_vnoise(vRestPos * vec3(24.0, 6.0, 24.0) + 11.7) - 0.5) * (1.0 - smoothstep(0.016, 0.032, hmPix));
  hmCol = mix(hmCol, ${e.hair} * hairLift * (1.0 + 0.5 * locks + 0.35 * clumps), hairM);
  hmRough = mix(hmRough, 0.72 + 0.2 * locks, hairM);
  float hatM = hm_step(0.0, vZone.w);
  hmCol = mix(hmCol, ${e.hat} * (1.0 + drape * 0.2), hatM);
  hmRough = mix(hmRough, 0.9, hatM);
  hmSkin = (1.0 - clothM) * (1.0 - shoe) * (1.0 - hairM) * (1.0 - hatM);
  hmCloth = max(clothM * (1.0 - shoe) * (1.0 - hairM), hatM);
  hmHair = hairM * (1.0 - hatM);
  // face (only on bare head skin): eye sockets, eyes, brows, lips and a
  // flush on the cheeks. Eyes and brows widen with the pixel footprint (up to
  // 7 mm) and fade by the same area, keeping their total darkness, so a face
  // still has eyes and brows at 8 m instead of sparkling dots.
  float face = (1.0 - hairM) * (1.0 - hatM) * hm_step(hmMarks.x + 0.02, y);
  vec3 q = vec3(abs(vRestPos.x), vRestPos.y, vRestPos.z);
  float fp = min(0.6 * hmPix, 0.007);
  vec3 ds = (q - hmEye - vec3(-0.002, 0.004, -0.004)) / vec3(0.021, 0.014, 0.015);
  float socket = 1.0 - smoothstep(0.3, 1.0, length(ds));
  vec3 dc = (q - hmEye - vec3(0.008, -0.03, -0.012)) / vec3(0.022, 0.018, 0.02);
  float cheek = 1.0 - smoothstep(0.2, 1.0, length(dc));
  hmCol *= mix(vec3(1.0), vec3(0.79, 0.74, 0.74), socket * face);
  hmCol *= mix(vec3(1.0), vec3(1.06, 0.93, 0.91), cheek * face);
  // the planes the coarse head mesh cannot hold, painted as soft occlusion so
  // a face still reads at 20-30 px: down the sides of the nose and under its
  // tip, under the lower lip, the chin's shadow on the neck and the hair's (or
  // a brim's) on the forehead. Blood shows in the nose tip and the ears, and
  // a bald crown is a little ruddier than the face (no blank pale egg).
  float fpk = fp / hk;
  vec3 fx = vec3(abs(fq.x), fq.yz);
  float noseSide = hm_mark(fx, vec3(0.012, -0.022, 0.005), vec3(0.005, 0.016, 0.009), fpk);
  float underNose = hm_mark(fq, vec3(0.0, -0.049, 0.008), vec3(0.012, 0.0045, 0.012), fpk);
  float underLip = hm_mark(fq, vec3(0.0, -0.081, -0.001), vec3(0.014, 0.0045, 0.012), fpk);
  float noseTip = hm_mark(fq, vec3(0.0, -0.036, 0.024), vec3(0.011, 0.011, 0.012), fpk);
  float ear = hm_mark(fx, vec3(0.078, -0.023, -0.088), vec3(0.014, 0.028, 0.02), fpk);
  float chinShade = (1.0 - smoothstep(-0.132, -0.118, fq.y)) * smoothstep(-0.19, -0.15, fq.y) * smoothstep(-0.11, -0.07, fq.z);
  float hairShade = smoothstep(-0.016, 0.0, vZone.z) * step(-0.99, vZone.z);
  float brimShade = smoothstep(-0.035, 0.0, vZone.w);
  float crown = smoothstep(0.045, 0.075, fq.y);
  float occl = 1.0 - 0.4 * noseSide - 0.55 * underNose - 0.35 * underLip - 0.4 * chinShade - 0.2 * hairShade - 0.3 * brimShade;
  hmCol *= mix(1.0, occl, face);
  hmCol *= mix(vec3(1.0), vec3(1.05, 0.94, 0.92), noseTip * face);
  hmCol *= mix(vec3(1.0), vec3(0.92, 0.8, 0.78), ear * face);
  hmCol *= mix(vec3(1.0), vec3(0.97, 0.9, 0.86), crown * face);
  // stubble (style bit): a shaved scalp and a shadow of beard along the jaw
  // and chin in the hair's colour; a bare crown has skin's sheen, not chalk
  float stubble = mod(floor(hmStyle / 16.0), 2.0);
  float jaw = hm_mark(fx, vec3(0.03, -0.095, 0.0), vec3(0.04, 0.04, 0.06), fpk) + hm_mark(fq, vec3(0.0, -0.105, 0.012), vec3(0.03, 0.025, 0.03), fpk);
  vec3 stubbleCol = min(${e.hair}, ${e.skin} * 0.62);
  hmCol = mix(hmCol, stubbleCol, stubble * face * clamp(0.28 * crown + 0.3 * min(jaw, 1.0), 0.0, 0.3));
  hmRough = mix(hmRough, 0.45, crown * face);
  vec2 er = vec2(0.012, 0.0048);
  vec2 ew = sqrt(er * er + fp * fp);
  vec3 de = (q - hmEye) / vec3(ew, 0.01 + 0.5 * fp);
  float eye = (1.0 - smoothstep(0.6, 1.0, length(de))) * (er.x * er.y) / (ew.x * ew.y);
  vec2 br = vec2(0.017, 0.0048);
  vec2 bw = sqrt(br * br + fp * fp);
  vec3 db = (q - hmEye - vec3(0.002, 0.017, 0.0)) / vec3(bw, 0.012 + 0.5 * fp);
  float brow = (1.0 - smoothstep(0.55, 1.0, length(db))) * (br.x * br.y) / (bw.x * bw.y);
  vec3 dm = (vRestPos - ${e.mouth}) / vec3(0.021, 0.004 + 0.5 * fp, 0.02);
  float lip = 1.0 - smoothstep(0.6, 1.0, length(dm));
  // brows darker than the hair and well under the skin, so blond, grey and red hair still frame the eyes
  hmCol = mix(hmCol, min(${e.hair} * 0.7, ${e.skin} * 0.45), brow * face * 0.8);
  hmCol = mix(hmCol, ${e.skin} * vec3(0.72, 0.5, 0.48), lip * face * 0.7);
  // the line between the lips (widened and weakened by footprint like the eyes)
  float mouthLine = hm_mark(fq, vec3(0.0, -0.0705, 0.004), vec3(0.017, 0.0022, 0.012), fpk);
  hmCol = mix(hmCol, ${e.skin} * vec3(0.4, 0.27, 0.25), mouthLine * face * 0.85);
  hmCol = mix(hmCol, vec3(0.03, 0.022, 0.018), eye * face);
}
// dark skin, for the moonlit skin toe (props/lights/lampField.ts LF_SKIN)
float hmSkinDark = 1.0 - smoothstep(0.04, 0.2, dot(${e.skin}, vec3(0.2126, 0.7152, 0.0722)));
diffuseColor.rgb *= hmCol * (1.0 - 0.25 * vOccl);`;
}

/**
 * Tousled hair (after <begin_vertex>, rest space): the hair surface lifts and
 * dips by up to ≈ 1 cm in lumps a few cm wide, so its outline is uneven
 * instead of a helmet's; the hairline (first 2 mm) and hats stay put. The
 * shared noise chunk has no derivatives, so it is safe in the vertex stage
 * (tests/creature-shaders.test.ts guards both stages).
 */
const HAIR_TOUSLE_GLSL = `if (zone.z > 0.0 && zone.w <= 0.0) transformed += normal * (smoothstep(0.002, 0.012, zone.z) * (cr_vnoise(position * vec3(38.0, 16.0, 38.0)) - 0.4) * 0.016);`;

/**
 * Baked crease occlusion (the `occl` attribute: between the fingers, the
 * armpits, under the chin and the seat) dims the sky's and the lamps' light
 * there, and a little of the colour so it holds in sunlight: a hand reads as
 * fingers, the body as more than one smooth tube. Per vertex, so it never
 * shimmers. After <aomap_fragment> (applyLampField adds the lamp light before it).
 */
const OCCLUSION_GLSL = `#include <aomap_fragment>
reflectedLight.indirectDiffuse *= 1.0 - 0.7 * vOccl;`;

/** Dark bare skin gets the moonlit skin toe of applyLampField (hmSkin, hmSkinDark: set by humanColorGLSL). */
const SKIN_TOE_DEFINE = '#define LF_SKIN (hmSkin * hmSkinDark)';

const ROUGHNESS_GLSL = `#include <roughnessmap_fragment>
roughnessFactor = hmRough;`;

/**
 * Matte fabric and soft skin (after <lights_physical_fragment>): cloth gets no
 * white grazing reflection (the plastic tell), skin a low one with the
 * slightly weaker reflectance of skin (F0 0.028), hair keeps its own.
 */
const SPECULAR_GLSL = `#include <lights_physical_fragment>
material.specularF90 = mix(mix(0.6, 0.25, hmCloth), 0.8, hmHair);
material.specularColor = vec3(mix(0.04, 0.028, hmSkin));
material.specularColorBlended = material.specularColor;`;

/**
 * Before <opaque_fragment>: light scattered under the skin wraps a little
 * warm, reddened sunlight past the terminator and warms the shaded side (no
 * flat, grey mannequin paint); fabric fibres seen side-on catch a soft sheen
 * in the cloth's own colour. Both follow the surface's own normal and the key
 * light with its shadow (`directLight` still holds it after the light loop).
 */
const SKIN_CLOTH_LIGHT_GLSL = `{
  float hmEdge = pow(1.0 - saturate(dot(nonPerturbedNormal, geometryViewDir)), 3.0);
  outgoingLight += hmCloth * 0.18 * hmEdge * totalDiffuse;
  outgoingLight += hmSkin * reflectedLight.indirectDiffuse * vec3(0.05, 0.012, 0.0);
  #if NUM_DIR_LIGHTS > 0
  float hmWrap = saturate(dot(nonPerturbedNormal, directLight.direction) * 0.5 + 0.5);
  outgoingLight += hmSkin * directLight.color * BRDF_Lambert(diffuseColor.rgb) * (0.1 * hmWrap * hmWrap) * vec3(1.0, 0.42, 0.28);
  #endif
}`;

export function createHumanMaterial(colors: HumanColors, cut: HumanCut, marks: HumanMarks, detail: 0 | 1 | 2): HumanMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 }) as HumanMaterial;
  const u: HumanUniforms = {
    uSkin: { value: new THREE.Color(colors.skin) },
    uHair: { value: new THREE.Color(colors.hair) },
    uShirt: { value: new THREE.Color(colors.shirt) },
    uPants: { value: new THREE.Color(colors.pants) },
    uShoes: { value: new THREE.Color(colors.shoes) },
    uHat: { value: new THREE.Color(colors.hat) },
    uCut: { value: new THREE.Vector4(cut.sleeve, cut.pants, cut.coat, cut.inflate) },
    uMarks: { value: new THREE.Vector3(marks.collarY, marks.waistY, marks.shoeTop) },
    uEye: { value: new THREE.Vector3(...marks.eyeL) },
    uMouth: { value: new THREE.Vector3(...marks.mouth) },
    uMicro: { value: detail > 0 ? 1 : 0 },
    uStyle: { value: cut.style ?? 0 },
    uHighlight: { value: 0 },
  };
  mat.userData.human = u;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 zone;
attribute float girth;
attribute float occl;
uniform vec4 uCut;
varying vec4 vZone;
varying vec3 vRestPos;
varying float vOccl;
${NOISE_GLSL}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vZone = zone;
vRestPos = position;
vOccl = occl;
transformed += normal * (uCut.w * girth);
${HAIR_TOUSLE_GLSL}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uSkin, uHair, uShirt, uPants, uShoes, uHat;
uniform vec4 uCut;
uniform vec3 uMarks;
uniform vec3 uEye;
uniform vec3 uMouth;
uniform float uMicro;
uniform float uStyle;
uniform float uHighlight;
varying vec4 vZone;
varying vec3 vRestPos;
varying float vOccl;
${SKIN_TOE_DEFINE}
${FRAG_HELPERS}
${HIGHLIGHT_FN_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        humanColorGLSL({
          skin: 'uSkin',
          hair: 'uHair',
          shirt: 'uShirt',
          pants: 'uPants',
          shoes: 'uShoes',
          hat: 'uHat',
          cut: 'uCut',
          marks: 'uMarks',
          eye: 'uEye',
          mouth: 'uMouth',
          style: 'uStyle',
        }),
      )
      .replace('#include <roughnessmap_fragment>', ROUGHNESS_GLSL)
      .replace('#include <aomap_fragment>', OCCLUSION_GLSL)
      .replace('#include <lights_physical_fragment>', SPECULAR_GLSL)
      .replace('#include <opaque_fragment>', `${SKIN_CLOTH_LIGHT_GLSL}\noutgoingLight = crHighlightOf(outgoingLight, uHighlight);\n#include <opaque_fragment>`);
    applyLampField(shader);
  };
  mat.customProgramCacheKey = () => 'creature-human-v6';
  return mat;
}

export function setHumanColors(mat: HumanMaterial, c: HumanColors): void {
  const u = mat.userData.human;
  u.uSkin.value.setHex(c.skin);
  u.uHair.value.setHex(c.hair);
  u.uShirt.value.setHex(c.shirt);
  u.uPants.value.setHex(c.pants);
  u.uShoes.value.setHex(c.shoes);
  u.uHat.value.setHex(c.hat);
}

// ---------------------------------------------------------------------------
// Batched crowd material

/**
 * Per-instance look texels of a batched human:
 *   0 = (skin.rgb, sleeve)    1 = (hair.rgb, pants)     2 = (shirt.rgb, coat)
 *   3 = (pants.rgb, inflate)  4 = (shoes.rgb, body id + HUMAN_BODIES × style)
 *   5 = (hat.rgb, highlight)
 * Colours are linear RGB. The body id (0..3 = female + 2 × child) selects the
 * face / collar landmarks from uniform arrays (they depend on the body only);
 * style is the humanStyle bits (prints, soles, stubble, neckline).
 */
export const HUMAN_LOOK_TEXELS = 6;
/** Number of body types (female × child). */
export const HUMAN_BODIES = 4;

const _c = new THREE.Color();

/** Write a person's look block (HUMAN_LOOK_TEXELS × 4 floats at `o`). */
export function writeHumanLook(dst: Float32Array, o: number, colors: HumanColors, cut: HumanCut, body: number, highlight: number): void {
  const put = (k: number, hex: number, w: number) => {
    _c.setHex(hex);
    dst[o + k * 4] = _c.r;
    dst[o + k * 4 + 1] = _c.g;
    dst[o + k * 4 + 2] = _c.b;
    dst[o + k * 4 + 3] = w;
  };
  put(0, colors.skin, cut.sleeve);
  put(1, colors.hair, cut.pants);
  put(2, colors.shirt, cut.coat);
  put(3, colors.pants, cut.inflate);
  put(4, colors.shoes, body + HUMAN_BODIES * (cut.style ?? 0));
  put(5, colors.hat, highlight);
}

/** Highlight float offset inside a look block. */
export const HUMAN_HIGHLIGHT_INDEX = 5 * 4 + 3;

export function createHumanBatchMaterial(detail: 0 | 1 | 2, bodies: HumanMarks[]): BatchMaterials {
  const u = crowdUniforms();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
  const marks = bodies.map((m) => new THREE.Vector3(m.collarY, m.waistY, m.shoeTop));
  const eyes = bodies.map((m) => new THREE.Vector3(...m.eyeL));
  const mouths = bodies.map((m) => new THREE.Vector3(...m.mouth));
  const hu = {
    uHmMarks: { value: marks },
    uHmEye: { value: eyes },
    uHmMouth: { value: mouths },
    uMicro: { value: detail > 0 ? 1 : 0 },
  };
  const n = bodies.length;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, hu);
    shader.vertexShader = patchCrowdVertex(
      shader.vertexShader,
      `attribute vec4 zone;
attribute float girth;
attribute float occl;
varying vec4 vZone;
varying vec3 vRestPos;
varying float vOccl;
flat varying vec4 vHm0;
flat varying vec4 vHm1;
flat varying vec4 vHm2;
flat varying vec4 vHm3;
flat varying vec4 vHm4;
flat varying vec4 vHm5;
${NOISE_GLSL}`,
      `vHm0 = crTexel(crBase);
vHm1 = crTexel(crBase + 1);
vHm2 = crTexel(crBase + 2);
vHm3 = crTexel(crBase + 3);
vHm4 = crTexel(crBase + 4);
vHm5 = crTexel(crBase + 5);`,
    ).replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vZone = zone;
vRestPos = position;
vOccl = occl;
transformed += normal * (vHm3.w * girth);
${HAIR_TOUSLE_GLSL}`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uHmMarks[${n}];
uniform vec3 uHmEye[${n}];
uniform vec3 uHmMouth[${n}];
uniform float uMicro;
varying vec4 vZone;
varying vec3 vRestPos;
varying float vOccl;
${SKIN_TOE_DEFINE}
flat varying vec4 vHm0;
flat varying vec4 vHm1;
flat varying vec4 vHm2;
flat varying vec4 vHm3;
flat varying vec4 vHm4;
flat varying vec4 vHm5;
${FRAG_HELPERS}
${HIGHLIGHT_FN_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `float hmPacked = floor(vHm4.w + 0.5);
int hmBody = clamp(int(mod(hmPacked, ${HUMAN_BODIES.toFixed(1)})), 0, ${n - 1});
${humanColorGLSL({
  skin: 'vHm0.rgb',
  hair: 'vHm1.rgb',
  shirt: 'vHm2.rgb',
  pants: 'vHm3.rgb',
  shoes: 'vHm4.rgb',
  hat: 'vHm5.rgb',
  cut: 'vec4(vHm0.w, vHm1.w, vHm2.w, vHm3.w)',
  marks: 'uHmMarks[hmBody]',
  eye: 'uHmEye[hmBody]',
  mouth: 'uHmMouth[hmBody]',
  style: `floor(hmPacked / ${HUMAN_BODIES.toFixed(1)})`,
})}`,
      )
      .replace('#include <roughnessmap_fragment>', ROUGHNESS_GLSL)
      .replace('#include <aomap_fragment>', OCCLUSION_GLSL)
      .replace('#include <lights_physical_fragment>', SPECULAR_GLSL)
      .replace('#include <opaque_fragment>', `${SKIN_CLOTH_LIGHT_GLSL}\noutgoingLight = crHighlightOf(outgoingLight, vHm5.w);\n#include <opaque_fragment>`);
    applyLampField(shader);
  };
  mat.customProgramCacheKey = () => `creature-human-batch-v6-${n}`;
  return { material: mat, depth: crowdDepthMaterial(u), uniforms: [u] };
}
