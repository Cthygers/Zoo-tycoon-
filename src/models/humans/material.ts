// Human material: one MeshStandardMaterial per instance (shared program).
// Clothing regions come from the baked `zone` attribute
//   x = distance from the shoulder joint along the arm (−1 off the arm)
//   y = distance from the hip joint along the leg (−1 off the leg)
//   z = hair signed distance (> 0 on hair), w = hat signed distance (> 0 on the hat)
// plus the rest-space height, and are coloured from per-instance uniforms.

import * as THREE from 'three';
import { NOISE_GLSL } from '../material/shaderChunks';

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
}

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
varying vec4 vZone;
varying vec3 vRestPos;
${NOISE_GLSL}
float hm_step(float edge, float v) { float a = max(fwidth(v), 1e-4); return smoothstep(edge - a, edge + a, v); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
vec3 hmCol = uSkin;
float hmRough = 0.55;
{
  float armT = vZone.x;
  float legT = vZone.y;
  float y = vRestPos.y;
  float onArm = hm_step(0.0, armT);
  float onLeg = hm_step(0.0, legT);
  float trunk = (1.0 - onArm) * (1.0 - onLeg);
  float neckCut = 1.0 - hm_step(uMarks.x, y);
  float upper = trunk * hm_step(uMarks.y, y) * neckCut;
  float lower = trunk * (1.0 - hm_step(uMarks.y, y));
  float sleeve = onArm * (1.0 - hm_step(uCut.x, armT));
  float pantsLeg = onLeg * (1.0 - hm_step(uCut.y, legT));
  float coatLeg = onLeg * (1.0 - hm_step(uCut.z, legT));
  float shirtM = clamp(upper + sleeve + coatLeg, 0.0, 1.0);
  float pantsM = clamp(lower + pantsLeg, 0.0, 1.0) * (1.0 - coatLeg);
  float fold = 0.0;
  if (uMicro > 0.5) fold = cr_vnoise(vRestPos * vec3(30.0, 9.0, 30.0)) - 0.5;
  hmCol = mix(hmCol, uPants * (1.0 + fold * 0.12), pantsM);
  hmCol = mix(hmCol, uShirt * (1.0 + fold * 0.1), shirtM);
  hmRough = mix(hmRough, 0.86, max(shirtM, pantsM));
  float shoe = onLeg * (1.0 - hm_step(uMarks.z, y));
  hmCol = mix(hmCol, uShoes, shoe);
  hmRough = mix(hmRough, 0.5, shoe);
  float hairM = hm_step(0.0, vZone.z);
  hmCol = mix(hmCol, uHair * (0.85 + 0.3 * cr_vnoise(vRestPos * vec3(160.0, 40.0, 160.0))), hairM);
  hmRough = mix(hmRough, 0.6, hairM);
  float hatM = hm_step(0.0, vZone.w);
  hmCol = mix(hmCol, uHat, hatM);
  hmRough = mix(hmRough, 0.85, hatM);
  // face: eyes, brows, lips (only on bare head skin)
  float face = (1.0 - hairM) * (1.0 - hatM) * hm_step(uMarks.x + 0.02, y);
  vec3 q = vec3(abs(vRestPos.x), vRestPos.y, vRestPos.z);
  vec3 de = (q - uEye) / vec3(0.0105, 0.0055, 0.012);
  float eye = 1.0 - smoothstep(0.7, 1.0, length(de));
  vec3 db = (q - uEye - vec3(0.002, 0.016, 0.0)) / vec3(0.016, 0.0035, 0.02);
  float brow = 1.0 - smoothstep(0.6, 1.0, length(db));
  vec3 dm = (vRestPos - uMouth) / vec3(0.021, 0.004, 0.02);
  float lip = 1.0 - smoothstep(0.6, 1.0, length(dm));
  hmCol = mix(hmCol, uHair * 0.8, brow * face * 0.85);
  hmCol = mix(hmCol, uSkin * vec3(0.72, 0.5, 0.48), lip * face * 0.7);
  hmCol = mix(hmCol, vec3(0.02, 0.015, 0.012), eye * face);
}
diffuseColor.rgb *= hmCol;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = hmRough;`,
      );
  };
  mat.customProgramCacheKey = () => 'creature-human-v1';
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
