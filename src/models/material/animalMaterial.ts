// Animal material: MeshStandardMaterial + vertex colours, with an
// onBeforeCompile extension that adds
//   * a per-pixel coat pattern (stripes / patches) driven by a baked scalar,
//   * object-space procedural micro-normals (fur strands, wrinkled / cracked hide),
//   * fur relief: strands right up close and clumps out to mid range, both
//     running along the hair flow and each faded out by its pixel footprint
//     before it could shimmer,
//   * albedo mottling (streaked along the hair flow on fur) and a clumpy
//     roughness spread,
//   * long hair (manes, shaggy bears) with darker partings between the locks
//     and a raised fur shell of lock tips (build/furShell.ts) that breaks up
//     the silhouette, up close only,
//   * a matte coat: fur, feathers and dry skin get a weak, coat-tinted Fresnel
//     instead of the white grazing reflection that makes them read as plastic,
//     plus a soft coat-tinted sheen along the silhouette (tight on short coats,
//     broad on long hair; light shining through the fringe when backlit),
//   * glossy patches (eyes, nose leather, wet skin) from a baked gloss value;
//     thick skins and swimming fur animals are also wet all over right after
//     a swim and dry from the top down (wetness from the instance's look
//     texel, see RiggedModel),
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
import { FUR_SHELL_FROM, FUR_SHELL_LEN } from '../build/furShell';

const SKIN_IDS: Record<LookSpec['skin'], number> = { fur: 0, hide: 1, smooth: 2, feather: 3, wrinkled: 4 };
/**
 * Fresnel reflectance at grazing angles (glossy parts always keep 1): fibres
 * and dust scatter the grazing reflection instead of mirroring the sky.
 */
const GRAZING_F90: Record<LookSpec['skin'], number> = { fur: 0.25, feather: 0.35, hide: 0.45, wrinkled: 0.4, smooth: 1 };
/** How much the sheen and the specular take on the coat's own hue (fur scatters light through coloured hair; dust stays neutral). */
const SHEEN_HUE: Record<LookSpec['skin'], number> = { fur: 0.55, feather: 0.35, hide: 0, wrinkled: 0, smooth: 0 };
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
  const wets = (look.wets ?? look.skin === 'wrinkled') ? 1 : 0;
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
#endif
#if ${wets} == 1
varying float vCrWet;
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#if ${skin} == 0
// fur shell (build/furShell.ts): raised along the normal by the fur length
if (pattern.z < -0.5) transformed += normal * (${FUR_SHELL_LEN} * (pattern.w - ${FUR_SHELL_FROM.toFixed(1)}));
#endif
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
#endif
#if ${wets} == 1
#ifdef USE_BATCHING
vCrWet = crTexel(crBase).z;
#else
vCrWet = 0.0;
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
#define CR_WETS ${wets}
#define CR_HIGHLIGHT ${hl}
uniform float uGrain;
uniform float uBump;
uniform float uSheen;
uniform float uMottle;
uniform mat3 normalMatrix;
#define CR_F90 ${GRAZING_F90[look.skin].toFixed(2)}
#define CR_SHEEN_HUE ${SHEEN_HUE[look.skin].toFixed(2)}
// albedo of the dust on dry skin (its sheen)
#define CR_DUST 0.3
varying vec3 vColor2;
varying vec4 vPattern;
varying vec3 vRestPos;
varying vec3 vRestNormal;
#if CR_WETS == 1
varying float vCrWet;
#endif
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
#if CR_SKIN == 0
// Fur clumps are CR_CLUMP × the strand scale across the hair flow.
#define CR_CLUMP 5.5
// Clump height at q (clump units): value noise squashed along the hair flow
// into locks 1 / (1 − squash) times longer than wide.
float cr_clump(vec3 q, vec3 flow, float squash) {
  q += 7.3;
  return cr_vnoise(q - flow * dot(q, flow) * squash);
}
// Fur relief (strand units): strands and clumps (lock length from squash, see
// cr_clump), weighted by their footprint fades. jit: the clumps wander by up
// to jit.w (clump units) along jit.xyz, varying over ~2 clumps.
float cr_fur(vec3 q, vec3 flow, float wS, float wC, float squash, vec4 jit) {
  vec3 qc = q * (1.0 / CR_CLUMP);
  if (jit.w > 0.001) qc += jit.xyz * ((cr_vnoise(qc * 0.5 + 3.7) - 0.5) * jit.w);
  float h = wC * 3.0 * cr_clump(qc, flow, squash);
  if (wS > 0.001) h += wS * cr_vnoise(q - flow * dot(q, flow) * 0.85);
  return h;
}
#endif
#if CR_SKIN == 4
// A groove along an iso-line of value noise: u = |noise − 0.5|, half-width w
// (noise units); 1 in the groove, 0 on the plates. Box-filtered over the
// pixel footprint fw (noise units): widened and made shallower in proportion
// once a pixel spans more than the groove, and faded to its mean (w) once it
// spans the noise cells, so sub-pixel grooves average out into the tone
// instead of aliasing into black pinholes.
float cr_groove(float u, float w, float fw) {
  float we = clamp(fw, w, 0.5);
  return mix((1.0 - smoothstep(0.0, we, u)) * (w / we), w, smoothstep(0.5, 1.0, fw));
}
// Crease network: grooves of three value-noise fields at different scales
// (wiggly grooves that cross into irregular, elongated plates; the coarse set
// runs mostly horizontally like the folds on legs and trunks). 1 on the
// plates, dipping toward 0 in the grooves. fq = pixel footprint in q units;
// each band's filter width is fq × its highest frequency × the noise slope.
// ws scales the groove widths (the network's mean darkening scales with it).
float cr_crease(vec3 q, float fq, float ws) {
  float a = abs(cr_vnoise(q * vec3(0.42, 1.25, 0.42)) - 0.5);
  float b = abs(cr_vnoise(q * vec3(0.95, 0.8, 0.95) + 11.7) - 0.5);
  float c = abs(cr_vnoise(q * 2.3 + 3.3) - 0.5);
  return 1.0 - cr_groove(a, 0.11 * ws, fq * 0.38) * 0.5 - cr_groove(b, 0.085 * ws, fq * 0.29) * 0.32 - cr_groove(c, 0.07 * ws, fq * 0.69) * 0.18;
}
/** Mean of 1 − cr_crease at ws = 1: what the network averages to once every band is filtered out. */
#define CR_CREASE_MEAN 0.0948
// Deep skin folds, CR_FOLD × the crease scale: long grooves running across
// the limbs and trunk (object-space Y is up the legs and the hanging trunk),
// a few centimetres apart, plus a fainter, finer cross set. They still read
// at mid range on a phone, where the fine creases are sub-pixel. A slow warp
// along Y varies their spacing by about ±30 %, so they never form even rings.
#define CR_FOLD 4.0
float cr_fold(vec3 q, float fq) {
  q.y += (cr_vnoise(q * vec3(0.35, 0.22, 0.35) + 5.1) - 0.5) * 2.6;
  float a = abs(cr_vnoise(q * vec3(0.3, 1.0, 0.3)) - 0.5);
  float b = abs(cr_vnoise(q * vec3(0.8, 0.6, 0.8) + 7.7) - 0.5);
  return 1.0 - cr_groove(a, 0.12, fq * 0.3) * 0.78 - cr_groove(b, 0.07, fq * 0.24) * 0.22;
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
// gloss: baked (eyes, nose leather, wet bands), plus the whole coat right
// after a swim, drying from the top down along a ragged line: thick skin goes
// dark and shiny, wet fur darker (water fills the gaps between the hairs) and
// slick but still a little matte
float crGloss = max(vPattern.z, 0.0); // (fur shell vertices carry a negative flag)
#if CR_WETS == 1
if (vCrWet > 0.0) {
  float wet = smoothstep(0.0, 0.08, vCrWet * vCrWet * 3.6 - 0.3 - vRestPos.y + (cr_vnoise(vRestPos * 7.0) - 0.5) * 0.16);
  #if CR_SKIN == 0
  diffuseColor.rgb *= 1.0 - 0.35 * wet;
  crGloss = max(crGloss, 0.3 * wet);
  #else
  diffuseColor.rgb *= 1.0 - 0.4 * wet;
  crGloss = max(crGloss, 0.5 * wet);
  #endif
}
#endif
#if CR_SKIN == 0
// hair flow in rest space: back along the body and down the flanks and legs
// (long hair hangs more steeply), in the surface plane
vec3 crN0 = normalize(vRestNormal);
vec3 crFl = mix(vec3(0.0, -0.45, -1.0), vec3(0.0, -1.0, -0.3), clamp((crFur - 1.0) * 0.5, 0.0, 1.0));
vec3 crFlow = normalize(crFl - crN0 * dot(crN0, crFl) + vec3(0.0, -0.001, 0.0));
// clumps fade out before their cells shrink under ~2 px (no shimmer)
float crWC = 1.0 - smoothstep(0.25, 0.7, crPix / (crGrain * CR_CLUMP));
{
  // long hair (manes, shaggy bears, ruffs, wool): darker partings between the
  // locks (value noise stretched along the hair flow, anchored in rest space),
  // and its fur shell (build/furShell.ts) keeps only the lock tips, so the
  // locks stand out past the silhouette instead of ending in a smooth helmet
  // edge. Both fade out before a lock is narrower than ~3 px (no crawling
  // edge at mid range); the shell thins out and is gone before the coarser
  // LODs, which have none. Paler coats get weaker partings (long bands turn
  // into contour lines on them).
  float lockW = crGrain * 1.8;
  float crNear = 1.0 - smoothstep(0.22, 0.4, crPix / lockW);
  float crLong = smoothstep(0.3, 1.3, vPattern.w) * crNear;
  bool crShell = vPattern.z < -0.5;
  if (crLong > 0.001 || crShell) {
    float lock = cr_clump(vRestPos / lockW, crFlow, 0.9);
    // shell: about half the lock tips stay; fewer toward its border on shorter hair
    if (crShell && lock < 1.02 - 0.55 * crNear * smoothstep(1.6, 2.1, vPattern.w)) discard;
    float pale = smoothstep(0.55, 0.85, sqrt(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))));
    diffuseColor.rgb *= 1.0 + crLong * mix(0.9, 0.35, pale) * (lock - 0.5);
  }
}
#endif
#if CR_PATTERN == 1
{
  float s = vPattern.x;
  float w = vPattern.y;
  #if CR_SKIN == 4
  // skin-fold rings (legs, trunk, neck): jitter their phase with a slow noise
  // so the spacing varies by about ±25–40 % instead of forming even rings
  s += (cr_vnoise(vRestPos * 8.0 + 2.9) - 0.5) * 1.1;
  #endif
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
// clumpy albedo variation on every tier: an 11 cm octave, and a 3 cm one
// (streaked along the hair flow on fur) that settles to its mean once a pixel
// spans half a cell, so it never crawls on a moving animal. Pale coats (polar
// bear, white bellies and stripes) keep only a quarter of the swing: on a
// bright, low-contrast coat slow albedo bands read as marble contours, so
// their texture comes from relief and sheen instead (crPale: 1 dark … 0.25 pale).
float crMo;
float crPale = mix(1.0, 0.25, smoothstep(0.55, 0.85, sqrt(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)))));
{
  float amp = crPale * (1.0 - crGloss);
  vec3 q = vRestPos * 31.0;
  #if CR_SKIN == 0
  q -= crFlow * dot(q, crFlow) * 0.75;
  #endif
  float fine = mix(cr_vnoise(q), 0.5, smoothstep(0.25, 0.6, crPix * 31.0));
  crMo = cr_vnoise(vRestPos * 9.0) * 0.6 + fine * 0.4;
  diffuseColor.rgb *= 1.0 + uMottle * (crMo - 0.5) * 2.0 * amp;
  #if CR_SKIN == 0
  // on every tier the clumps' tips catch a little more light than the
  // partings between them; short locks (about 2× longer than wide) so they
  // never chain into long contour lines
  if (crWC > 0.001) diffuseColor.rgb *= 1.0 + 0.36 * crWC * (cr_clump(vRestPos / (crGrain * CR_CLUMP), crFlow, 0.55) - 0.5) * amp;
  #endif
}
#if CR_SKIN == 4
// grooves are darker (dirt + occlusion), filtered to their average tone where
// they get thinner than a pixel; past crFq ≈ 3.5 every band of cr_crease is
// at its mean, so the noise is not evaluated
float crFq = crPix / crGrain;
// crease strength (crCw) and groove width (crWs) vary over the body: deep and
// wide where the coat sets folds (legs, trunk, throat, behind the ears),
// faint on the broad flanks and fainter still on the upper back, patchy at a
// ~40 cm scale, and about 30 % of the segments fade out (~5 cm cells, settling
// to their mean before they near a pixel) so the net breaks into irregular
// runs instead of an even mesh of polygons
float crWs;
float crCw;
{
  float region = smoothstep(0.3, 0.8, max(-vPattern.w, 0.0));
  float patchy = cr_vnoise(vRestPos * 2.6 + 4.1);
  float keep = mix(smoothstep(0.3, 0.44, cr_vnoise(vRestPos * 19.0 + 9.3)), 0.7, smoothstep(0.3, 0.8, crPix * 19.0));
  crWs = mix(0.75, 1.3, region) * mix(0.8, 1.2, patchy);
  crCw = mix(0.35, 1.05, region) * mix(0.55, 1.35, patchy) * mix(1.0, 0.65, smoothstep(0.45, 0.9, vRestNormal.y) * (1.0 - region)) * keep;
}
{
  float groove = (crFq < 3.5 ? 1.0 - cr_crease(vRestPos / crGrain, crFq, crWs) : CR_CREASE_MEAN * crWs) * crCw;
  float gd = clamp(uBump * 1.2, 0.12, 0.6);
  // folds (where the coat puts them): same treatment at their own, larger scale
  float ff = (1.0 - smoothstep(crGrain * CR_FOLD * 0.5, crGrain * CR_FOLD * 2.5, crPix)) * max(-vPattern.w, 0.0);
  float foldShade = 1.0 - gd * 0.06 * max(-vPattern.w, 0.0);
  if (ff > 0.001) {
    float fold = 1.0 - cr_fold(vRestPos / (crGrain * CR_FOLD), crFq / CR_FOLD);
    foldShade = mix(foldShade, 1.0 - gd * 0.45 * fold, ff);
  }
  float shade = (1.0 - gd * 1.1 * groove) * foldShade;
  diffuseColor.rgb *= shade * (1.0 - crGloss) + crGloss;
}
#endif
#if CR_JUV == 1
{
  // juvenile down / coat: tint toward the juvenile colour, keeping some of the adult light/dark pattern
  float k = uJuvAmount * (1.0 - smoothstep(0.0, uJuvUntil, vCrGrowth)) * (1.0 - crGloss);
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
// matte with a clumpy spread (never one uniform sheen); glossy parts smooth
roughnessFactor = clamp(roughnessFactor + (crMo - 0.5) * 0.12, 0.0, 0.97);
roughnessFactor = mix(roughnessFactor, 0.16, crGloss);`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
// the coat's hue at unit luminance: tints the sheen and the fibres' specular
vec3 crHue = mix(vec3(1.0), clamp(diffuseColor.rgb / max(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.01), 0.0, 3.0), CR_SHEEN_HUE);
material.specularF90 = mix(CR_F90, 1.0, crGloss);
material.specularColor = mix(vec3(0.04) * crHue, vec3(0.04), crGloss);
material.specularColorBlended = mix(material.specularColor, diffuseColor.rgb, metalnessFactor);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
#if CR_MICRO == 1
#if CR_SKIN == 0
{
  // fur relief: strands only right up close, clumps out to mid range; each
  // fades out before its cells shrink under ~2 px (no shimmer, no aliasing)
  float wS = 1.0 - smoothstep(0.25, 0.7, crPix / crGrain);
  if (crWC > 0.001 && crGloss < 0.5) {
    vec3 p = vRestPos / crGrain;
    float e = 0.35;
    // long locks (hair streaks) on darker coats; short ones on pale coats,
    // whose long relief bands would shade into contour lines. Pale coats also
    // get half the clump relief, and their locks wander ~2 cm across the flow
    // so the relief never lines up into concentric bands where the flow
    // curves (polar bear neck and shoulder).
    float sq = mix(0.55, 0.8, (crPale - 0.25) / 0.75);
    float pale = 1.0 - smoothstep(0.3, 0.5, crPale);
    float wC = crWC * (1.0 - 0.5 * pale);
    vec4 jit = vec4(normalize(cross(crN0, crFlow)), pale * 0.06 / (crGrain * CR_CLUMP));
    float h0 = cr_fur(p, crFlow, wS, wC, sq, jit);
    vec3 g = vec3(cr_fur(p + vec3(e, 0.0, 0.0), crFlow, wS, wC, sq, jit) - h0, cr_fur(p + vec3(0.0, e, 0.0), crFlow, wS, wC, sq, jit) - h0, cr_fur(p + vec3(0.0, 0.0, e), crFlow, wS, wC, sq, jit) - h0) / e;
    vec3 gv = normalMatrix * g;
    gv -= normal * dot(gv, normal);
    normal = normalize(normal - gv * uBump * 0.35 * sqrt(crFur));
  }
}
#else
if (crFade > 0.001 && crGloss < 0.5) {
  // height field h(p) in rest (object) space; gradient by central differences,
  // transformed to view space (smooth per pixel, no derivative blockiness)
  vec3 p = vRestPos / crGrain;
  vec3 g = vec3(0.0);
  float e = 0.35;
  #if CR_SKIN == 1
    #define CR_H(q) (smoothstep(0.0, 0.18, cr_cells((q) * 0.9)) * 0.7 + cr_vnoise((q) * 3.1) * 0.3)
  #elif CR_SKIN == 3
    #define CR_H(q) cr_vnoise((q) * vec3(1.0, 1.0, 0.3))
  #elif CR_SKIN == 4
    // filtered at least over the finite-difference step
    #define CR_H(q) ((cr_crease(q, max(crFq, e), crWs) - 1.0) * crCw + cr_vnoise((q) * 0.9) * 0.25)
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
#endif
#if CR_SKIN == 4
{
  // fold relief, faded at its own (larger) scale
  float ff = (1.0 - smoothstep(crGrain * CR_FOLD * 0.35, crGrain * CR_FOLD * 1.6, crPix)) * max(-vPattern.w, 0.0);
  if (ff > 0.001 && crGloss < 0.5) {
    vec3 p = vRestPos / (crGrain * CR_FOLD);
    float e = 0.3;
    float fq = max(crFq / CR_FOLD, e);
    float h0 = cr_fold(p, fq);
    vec3 g = vec3(cr_fold(p + vec3(e, 0.0, 0.0), fq) - h0, cr_fold(p + vec3(0.0, e, 0.0), fq) - h0, cr_fold(p + vec3(0.0, 0.0, e), fq) - h0) / e;
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
  // sheen: hairs (or dust) seen side-on near the silhouette scatter the light
  // that falls on the coat, so the edge gets a soft halo in the coat's hue
  // instead of a hard plastic line: a tight edge on short coats, a broad one
  // on long hair; when backlit, light shines through the fringe. It follows
  // the surface's own normal (micro-normals would speckle it).
  float crEdge = pow(1.0 - saturate(dot(nonPerturbedNormal, geometryViewDir)), mix(4.0, 2.0, smoothstep(0.006, 0.02, crGrain)));
  vec3 crHalo = totalDiffuse;
  #if NUM_DIR_LIGHTS > 0
  // (directLight still holds the key light with its shadow after the light loop)
  crHalo += directLight.color * BRDF_Lambert(diffuseColor.rgb) * 0.35 * pow2(saturate(dot(-geometryViewDir, directLight.direction)));
  #endif
  #if CR_SKIN == 1 || CR_SKIN == 4
  // dry skin: the dust on it catches the light in its own pale tone
  crHalo *= CR_DUST / max(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.02);
  #endif
  outgoingLight += uSheen * (1.0 - crGloss) * crEdge * crHalo * crHue;
}
#if CR_HIGHLIGHT == 1
outgoingLight = crHighlightFurOf(outgoingLight, uHighlight, vPattern.w);
#endif
#include <opaque_fragment>`,
      );
    applyLampField(shader);
  };
  mat.customProgramCacheKey = () => `creature-animal-${skin}-${pattern}-${micro}-${juv}-${wets}-${hl}`;
  mat.userData.creatureUniforms = uniforms;
  return mat;
}
