// Animal material: MeshStandardMaterial + vertex colours, with an
// onBeforeCompile extension that adds
//   * a per-pixel coat pattern (stripes / patches) driven by a baked scalar,
//   * object-space procedural micro-normals (fur strands, wrinkled / cracked hide),
//   * albedo mottling and a soft fur sheen / rim term,
//   * glossy patches (eyes, nose leather) from a baked gloss value,
//   * 'wrinkled' skin: a network of fine creases (grooves darkened in the
//     albedo) for elephants, rhinos and hippos instead of the cell plates of
//     'hide', which read as reptile scales up close, plus deep folds across
//     legs and trunks where the coat sets `fold` (baked as −pattern.w),
//   * an optional growth-dependent juvenile tint (chick down). Growth comes
//     from the instance's look texel in the batched renderer (`USE_BATCHING`)
//     and is 1 (adult) for standalone meshes,
//   * for the standalone highlight material, the selection rim (crHighlight),
//   * warm light from the night lamps it stands under (props/lights/lampField.ts).

import * as THREE from 'three';
import type { LookSpec } from '../types';
import { applyLampField } from '../../props/lights/lampField';
import { HIGHLIGHT_FN_GLSL, NOISE_GLSL } from './shaderChunks';

const SKIN_IDS: Record<LookSpec['skin'], number> = { fur: 0, hide: 1, smooth: 2, feather: 3, wrinkled: 4 };
const PATTERN_IDS = { none: 0, stripes: 1, field: 2 } as const;

export interface AnimalMaterialOptions {
  look: LookSpec;
  /** 0 low, 1 medium, 2 high (micro detail disabled on low). */
  detail: 0 | 1 | 2;
  highlight?: boolean;
}

export function createAnimalMaterial(o: AnimalMaterialOptions): THREE.MeshStandardMaterial {
  const look = o.look;
  const skin = SKIN_IDS[look.skin];
  const pattern = PATTERN_IDS[look.pattern ?? 'none'];
  const micro = o.detail > 0 ? 1 : 0;
  const juv = look.juvenile ? 1 : 0;
  const thick = look.skin === 'hide' || look.skin === 'wrinkled';
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: look.roughness ?? (look.skin === 'smooth' ? 0.55 : thick ? 0.8 : 0.88),
    metalness: 0,
  });
  const uniforms = {
    uGrain: { value: look.grain ?? (look.skin === 'hide' ? 0.035 : look.skin === 'wrinkled' ? 0.014 : 0.006) },
    uBump: { value: look.bump ?? 0.5 },
    uSheen: { value: look.sheen ?? (look.skin === 'fur' ? 0.3 : look.skin === 'feather' ? 0.2 : 0.05) },
    uMottle: { value: look.mottle ?? 0.12 },
    uJuvColor: { value: new THREE.Color(look.juvenile?.color ?? 0x808080) },
    uJuvAmount: { value: look.juvenile?.amount ?? 0.85 },
    uJuvUntil: { value: Math.max(0.05, look.juvenile?.until ?? 0.65) },
    uJuvKeep: { value: look.juvenile?.keep ?? 0.35 },
    /** Selection highlight amount of a standalone highlight material (pulsed by RiggedModel). */
    uHighlight: { value: 0.25 },
  };
  const hl = o.highlight ? 1 : 0;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 color2;
attribute vec4 pattern;
varying vec3 vColor2;
varying vec4 vPattern;
varying vec3 vRestPos;
varying vec3 vRestNormal;
#if ${juv} == 1
varying float vCrGrowth;
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vRestPos = position;
vRestNormal = normal;
vColor2 = color2;
vPattern = pattern;
#if ${juv} == 1
#ifdef USE_BATCHING
vCrGrowth = crTexel(crBase).y;
#else
vCrGrowth = 1.0;
#endif
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
#define CR_SKIN ${skin}
#define CR_PATTERN ${pattern}
#define CR_MICRO ${micro}
#define CR_JUV ${juv}
#define CR_HIGHLIGHT ${hl}
uniform float uGrain;
uniform float uBump;
uniform float uSheen;
uniform float uMottle;
uniform mat3 normalMatrix;
varying vec3 vColor2;
varying vec4 vPattern;
varying vec3 vRestPos;
varying vec3 vRestNormal;
#if CR_JUV == 1
uniform vec3 uJuvColor;
uniform float uJuvAmount;
uniform float uJuvUntil;
uniform float uJuvKeep;
varying float vCrGrowth;
#endif
#if CR_HIGHLIGHT == 1
uniform float uHighlight;
${HIGHLIGHT_FN_GLSL}
#endif
${NOISE_GLSL}
#if CR_SKIN == 4
// Crease network: iso-lines of three value-noise fields at different scales
// (wiggly grooves that cross into irregular, elongated plates; the coarse set
// runs mostly horizontally like the folds on legs and trunks). 1 on the
// plates, dipping to 0 in the grooves.
float cr_crease(vec3 q) {
  float a = abs(cr_vnoise(q * vec3(0.42, 1.25, 0.42)) - 0.5);
  float b = abs(cr_vnoise(q * vec3(0.95, 0.8, 0.95) + 11.7) - 0.5);
  float c = abs(cr_vnoise(q * 2.3 + 3.3) - 0.5);
  return smoothstep(0.0, 0.11, a) * 0.5 + smoothstep(0.0, 0.085, b) * 0.32 + smoothstep(0.0, 0.07, c) * 0.18;
}
// Deep skin folds, CR_FOLD × the crease scale: long grooves running across
// the limbs and trunk (object-space Y is up the legs and the hanging trunk),
// a few centimetres apart, plus a fainter, finer cross set. They still read
// at mid range on a phone, where the fine creases are sub-pixel.
#define CR_FOLD 4.0
float cr_fold(vec3 q) {
  float a = abs(cr_vnoise(q * vec3(0.3, 1.0, 0.3)) - 0.5);
  float b = abs(cr_vnoise(q * vec3(0.8, 0.6, 0.8) + 7.7) - 0.5);
  return smoothstep(0.0, 0.12, a) * 0.78 + smoothstep(0.0, 0.07, b) * 0.22;
}
#endif`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float crFur = 1.0 + max(vPattern.w, 0.0);
float crGrain = uGrain * crFur;
float crPix = length(fwidth(vRestPos));
float crFade = 1.0 - smoothstep(crGrain * 0.35, crGrain * 1.6, crPix);
#if CR_PATTERN == 1
{
  float s = vPattern.x;
  float w = vPattern.y;
  float d = abs(fract(s) - 0.5) * 2.0;
  #if CR_MICRO == 1
  d += (cr_vnoise(vRestPos * (0.9 / uGrain)) - 0.5) * 0.07 * crFade;
  #endif
  float aa = max(fwidth(s) * 1.6, 0.035);
  float m = smoothstep(1.0 - w - aa, 1.0 - w + aa, d) * step(0.002, w);
  diffuseColor.rgb = mix(diffuseColor.rgb, vColor2, m);
}
#elif CR_PATTERN == 2
{
  float aa = max(fwidth(vPattern.x) * 1.2, 0.004);
  float m = smoothstep(-aa, aa, vPattern.x);
  diffuseColor.rgb = mix(diffuseColor.rgb, vColor2, m);
}
#endif
{
  // clumpy albedo variation (independent of the micro fade so distance views keep texture)
  float mo = cr_vnoise(vRestPos * 9.0) * 0.6 + cr_vnoise(vRestPos * 31.0) * 0.4;
  diffuseColor.rgb *= 1.0 + uMottle * (mo - 0.5) * 2.0 * (1.0 - vPattern.z);
}
#if CR_SKIN == 4
// grooves are darker (dirt + occlusion); fades to the average a bit beyond the micro-normal range
float crCreaseH = 1.0;
{
  float fa = 1.0 - smoothstep(crGrain * 0.6, crGrain * 3.2, crPix);
  if (fa > 0.001) crCreaseH = cr_crease(vRestPos / crGrain);
  float groove = 1.0 - crCreaseH;
  float gd = clamp(uBump * 1.2, 0.12, 0.6);
  // folds (where the coat puts them): same treatment at their own, larger scale
  float ff = (1.0 - smoothstep(crGrain * CR_FOLD * 0.5, crGrain * CR_FOLD * 2.5, crPix)) * max(-vPattern.w, 0.0);
  float foldShade = 1.0 - gd * 0.06 * max(-vPattern.w, 0.0);
  if (ff > 0.001) {
    float fold = 1.0 - cr_fold(vRestPos / (crGrain * CR_FOLD));
    foldShade = mix(foldShade, 1.0 - gd * 0.45 * fold * fold, ff);
  }
  float shade = mix(1.0 - gd * 0.14, 1.0 - gd * groove * groove, fa) * foldShade;
  diffuseColor.rgb *= shade * (1.0 - vPattern.z) + vPattern.z;
}
#endif
#if CR_JUV == 1
{
  // juvenile down / coat: tint toward the juvenile colour, keeping some of the adult light/dark pattern
  float k = uJuvAmount * (1.0 - smoothstep(0.0, uJuvUntil, vCrGrowth)) * (1.0 - vPattern.z);
  float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float lj = max(dot(uJuvColor, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
  vec3 juv = uJuvColor * mix(1.0, clamp(l / lj, 0.3, 2.5), uJuvKeep);
  diffuseColor.rgb = mix(diffuseColor.rgb, juv, k);
}
#endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.16, vPattern.z);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
#if CR_MICRO == 1
if (crFade > 0.001 && vPattern.z < 0.5) {
  // height field h(p) in rest (object) space; gradient by central differences,
  // transformed to view space (smooth per pixel, no derivative blockiness)
  vec3 p = vRestPos / crGrain;
  vec3 g = vec3(0.0);
  float e = 0.35;
  #if CR_SKIN == 0
    vec3 n0 = normalize(vRestNormal);
    vec3 fl = mix(vec3(0.0, -0.45, -1.0), vec3(0.0, -1.0, -0.3), clamp((crFur - 1.0) * 0.5, 0.0, 1.0));
    vec3 flow = normalize(fl - n0 * dot(n0, fl) + vec3(0.0, -0.001, 0.0));
    // squash coordinates along the hair flow → elongated strands
    #define CR_H(q) cr_vnoise((q) - flow * dot((q), flow) * 0.85)
  #elif CR_SKIN == 1
    #define CR_H(q) (smoothstep(0.0, 0.18, cr_cells((q) * 0.9)) * 0.7 + cr_vnoise((q) * 3.1) * 0.3)
  #elif CR_SKIN == 3
    #define CR_H(q) cr_vnoise((q) * vec3(1.0, 1.0, 0.3))
  #elif CR_SKIN == 4
    #define CR_H(q) (cr_crease(q) + cr_vnoise((q) * 0.9) * 0.25)
  #else
    #define CR_H(q) (cr_vnoise((q) * 0.5) * 0.3)
  #endif
  float h0 = CR_H(p);
  g.x = CR_H(p + vec3(e, 0.0, 0.0)) - h0;
  g.y = CR_H(p + vec3(0.0, e, 0.0)) - h0;
  g.z = CR_H(p + vec3(0.0, 0.0, e)) - h0;
  g /= e;
  vec3 gv = normalMatrix * g;
  gv -= normal * dot(gv, normal);
  normal = normalize(normal - gv * uBump * 0.35 * crFade * sqrt(crFur));
}
#if CR_SKIN == 4
{
  // fold relief, faded at its own (larger) scale
  float ff = (1.0 - smoothstep(crGrain * CR_FOLD * 0.35, crGrain * CR_FOLD * 1.6, crPix)) * max(-vPattern.w, 0.0);
  if (ff > 0.001 && vPattern.z < 0.5) {
    vec3 p = vRestPos / (crGrain * CR_FOLD);
    float e = 0.3;
    float h0 = cr_fold(p);
    vec3 g = vec3(cr_fold(p + vec3(e, 0.0, 0.0)) - h0, cr_fold(p + vec3(0.0, e, 0.0)) - h0, cr_fold(p + vec3(0.0, 0.0, e)) - h0) / e;
    vec3 gv = normalMatrix * g;
    gv -= normal * dot(gv, normal);
    normal = normalize(normal - gv * uBump * 0.2 * ff);
  }
}
#endif
#endif`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
  float rim = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
  rim = rim * rim * rim * rim;
  outgoingLight += uSheen * (1.0 - vPattern.z) * rim * (totalDiffuse * 0.9 + diffuseColor.rgb * 0.04);
}
#if CR_HIGHLIGHT == 1
outgoingLight = crHighlightFurOf(outgoingLight, uHighlight, vPattern.w);
#endif
#include <opaque_fragment>`,
      );
    applyLampField(shader);
  };
  mat.customProgramCacheKey = () => `creature-animal-${skin}-${pattern}-${micro}-${juv}-${hl}`;
  mat.userData.creatureUniforms = uniforms;
  return mat;
}
