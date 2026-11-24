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
// a sheen in its own colour, no white grazing reflection), hair locks with
// their own roughness, and face marks that keep their darkness at a distance.

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
}

const FRAG_HELPERS = `${NOISE_GLSL}
float hm_step(float edge, float v) { float a = max(fwidth(v), 1e-4); return smoothstep(edge - a, edge + a, v); }`;

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
  float onArm = hm_step(0.0, armT);
  float onLeg = hm_step(0.0, legT);
  float trunk = (1.0 - onArm) * (1.0 - onLeg);
  float neckCut = 1.0 - hm_step(hmMarks.x, y);
  float upper = trunk * hm_step(hmMarks.y, y) * neckCut;
  float lower = trunk * (1.0 - hm_step(hmMarks.y, y));
  float sleeve = onArm * (1.0 - hm_step(hmCut.x, armT));
  float pantsLeg = onLeg * (1.0 - hm_step(hmCut.y, legT));
  float coatLeg = onLeg * (1.0 - hm_step(hmCut.z, legT));
  float shirtM = clamp(upper + sleeve + coatLeg, 0.0, 1.0);
  float pantsM = clamp(lower + pantsLeg, 0.0, 1.0) * (1.0 - coatLeg);
  // fabric: soft drape folds hanging down the garment (4.5 cm) and finer
  // wrinkles on medium / high (2.2 cm), in tone and in roughness (never one
  // smooth plastic tone)
  float drape = (cr_vnoise(vRestPos * vec3(22.0, 6.0, 22.0)) - 0.5) * (1.0 - smoothstep(0.016, 0.032, hmPix));
  if (uMicro > 0.5) drape += (cr_vnoise(vRestPos * vec3(45.0, 14.0, 45.0) + 7.3) - 0.5) * 0.6 * (1.0 - smoothstep(0.008, 0.016, hmPix));
  hmCol = mix(hmCol, ${e.pants} * (1.0 + drape * 0.26), pantsM);
  hmCol = mix(hmCol, ${e.shirt} * (1.0 + drape * 0.22), shirtM);
  // waistband under the hem of the top (not on a lab coat): separates top and bottom
  float belt = trunk * (1.0 - hm_step(hmMarks.y, y)) * hm_step(hmMarks.y - 0.03, y) * step(hmCut.z, 0.0);
  hmCol = mix(hmCol, ${e.pants} * 0.4, belt);
  float clothM = max(shirtM, pantsM);
  hmRough = mix(hmRough, 0.93 - drape * 0.1, clothM);
  float shoe = onLeg * (1.0 - hm_step(hmMarks.z, y));
  hmCol = mix(hmCol, ${e.shoes}, shoe);
  hmRough = mix(hmRough, 0.55, shoe);
  // hair: a soft hairline (skin shows through the first few mm), locks along
  // its fall with their own roughness, faded by footprint like the drape
  float hairM = max(hm_step(0.004, vZone.z), 0.6 * smoothstep(-0.003, 0.004, vZone.z));
  float locks = (cr_vnoise(vRestPos * vec3(45.0, 10.0, 45.0)) - 0.5) * (1.0 - smoothstep(0.008, 0.016, hmPix));
  hmCol = mix(hmCol, ${e.hair} * (1.0 + 0.5 * locks), hairM);
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
  vec3 hmEye = ${e.eye};
  vec3 q = vec3(abs(vRestPos.x), vRestPos.y, vRestPos.z);
  float fp = min(0.6 * hmPix, 0.007);
  vec3 ds = (q - hmEye - vec3(-0.002, 0.004, -0.004)) / vec3(0.021, 0.014, 0.015);
  float socket = 1.0 - smoothstep(0.3, 1.0, length(ds));
  vec3 dc = (q - hmEye - vec3(0.008, -0.03, -0.012)) / vec3(0.022, 0.018, 0.02);
  float cheek = 1.0 - smoothstep(0.2, 1.0, length(dc));
  hmCol *= mix(vec3(1.0), vec3(0.87, 0.84, 0.84), socket * face);
  hmCol *= mix(vec3(1.0), vec3(1.06, 0.93, 0.91), cheek * face);
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
  hmCol = mix(hmCol, vec3(0.03, 0.022, 0.018), eye * face);
}
diffuseColor.rgb *= hmCol;`;
}

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
uniform vec4 uCut;
varying vec4 vZone;
varying vec3 vRestPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vZone = zone;
vRestPos = position;
transformed += normal * (uCut.w * girth);`,
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
uniform float uHighlight;
varying vec4 vZone;
varying vec3 vRestPos;
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
        }),
      )
      .replace('#include <roughnessmap_fragment>', ROUGHNESS_GLSL)
      .replace('#include <lights_physical_fragment>', SPECULAR_GLSL)
      .replace('#include <opaque_fragment>', `${SKIN_CLOTH_LIGHT_GLSL}\noutgoingLight = crHighlightOf(outgoingLight, uHighlight);\n#include <opaque_fragment>`);
    applyLampField(shader);
  };
  mat.customProgramCacheKey = () => 'creature-human-v3';
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
 *   3 = (pants.rgb, inflate)  4 = (shoes.rgb, body id)  5 = (hat.rgb, highlight)
 * Colours are linear RGB. The body id (0..3 = female + 2 × child) selects the
 * face / collar landmarks from uniform arrays (they depend on the body only).
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
  put(4, colors.shoes, body);
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
varying vec4 vZone;
varying vec3 vRestPos;
flat varying vec4 vHm0;
flat varying vec4 vHm1;
flat varying vec4 vHm2;
flat varying vec4 vHm3;
flat varying vec4 vHm4;
flat varying vec4 vHm5;`,
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
transformed += normal * (vHm3.w * girth);`,
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
        `int hmBody = clamp(int(vHm4.w + 0.5), 0, ${n - 1});
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
})}`,
      )
      .replace('#include <roughnessmap_fragment>', ROUGHNESS_GLSL)
      .replace('#include <lights_physical_fragment>', SPECULAR_GLSL)
      .replace('#include <opaque_fragment>', `${SKIN_CLOTH_LIGHT_GLSL}\noutgoingLight = crHighlightOf(outgoingLight, vHm5.w);\n#include <opaque_fragment>`);
    applyLampField(shader);
  };
  mat.customProgramCacheKey = () => `creature-human-batch-v3-${n}`;
  return { material: mat, depth: crowdDepthMaterial(u), uniforms: [u] };
}
