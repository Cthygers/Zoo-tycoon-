// Animal material: MeshStandardMaterial + vertex colours, with an
// onBeforeCompile extension that adds
//   * a per-pixel coat pattern (stripes / patches) driven by a baked scalar,
//   * object-space procedural micro-normals (fur strands, wrinkled / cracked hide),
//   * albedo mottling and a soft fur sheen / rim term,
//   * glossy patches (eyes, nose leather) from a baked gloss value.

import * as THREE from 'three';
import type { LookSpec } from '../types';
import { NOISE_GLSL } from './shaderChunks';

const SKIN_IDS: Record<LookSpec['skin'], number> = { fur: 0, hide: 1, smooth: 2, feather: 3 };
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
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: look.roughness ?? (look.skin === 'smooth' ? 0.55 : look.skin === 'hide' ? 0.8 : 0.88),
    metalness: 0,
  });
  if (o.highlight) {
    mat.emissive.setRGB(1.0, 0.85, 0.35);
    mat.emissiveIntensity = 0.25;
  }
  const uniforms = {
    uGrain: { value: look.grain ?? (look.skin === 'hide' ? 0.035 : 0.006) },
    uBump: { value: look.bump ?? 0.5 },
    uSheen: { value: look.sheen ?? (look.skin === 'fur' ? 0.3 : look.skin === 'feather' ? 0.2 : 0.05) },
    uMottle: { value: look.mottle ?? 0.12 },
  };
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
varying vec3 vRestNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vRestPos = position;
vRestNormal = normal;
vColor2 = color2;
vPattern = pattern;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
#define CR_SKIN ${skin}
#define CR_PATTERN ${pattern}
#define CR_MICRO ${micro}
uniform float uGrain;
uniform float uBump;
uniform float uSheen;
uniform float uMottle;
uniform mat3 normalMatrix;
varying vec3 vColor2;
varying vec4 vPattern;
varying vec3 vRestPos;
varying vec3 vRestNormal;
${NOISE_GLSL}`,
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
}`,
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
#endif`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
  float rim = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
  rim = rim * rim * rim * rim;
  outgoingLight += uSheen * (1.0 - vPattern.z) * rim * (totalDiffuse * 0.9 + diffuseColor.rgb * 0.04);
}
#include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => `creature-animal-${skin}-${pattern}-${micro}`;
  mat.userData.creatureUniforms = uniforms;
  return mat;
}
