// Batched (instanced + texture-skinned) variants of the creature materials.
//
// Animals: the batched material IS the species material from
// material/animalMaterial.ts (createAnimalMaterial) with the crowd skinning
// patch chained after its own onBeforeCompile, so every uniform, define or
// varying the animal material declares automatically reaches batched and LOD
// meshes. Per-instance parameters arrive through the batch data texture:
//
//   look texel 0 = (highlight, growth 0..1, wetness 0..1, user1)
//     → fragment: `flat varying vec4 vCrLook0` (x = highlight amount,
//        y = growth — e.g. for a juvenile tint, z = wetness after a swim
//        (RiggedModel.writeLook; thick skins read it as vCrWet), w free for extensions)
//     → fragment: `flat varying vec2 vCrYaw` (cos, sin of the instance yaw);
//        `normalMatrix` is redefined as normalMatrix × instance rotation so
//        object-space micro-normals stay correct for every instance.
//
// To add a per-instance value: bump ANIMAL_LOOK_TEXELS, write it in
// RiggedModel.writeLook(), read it with `crTexel(crBase + k)` in the vertex
// shader (see `afterBase` below) and pass it on as a flat varying.
//
// Below the pond surface a fragment looks like the pond around it
// (UNDERWATER_GLSL): no sun, sheen or specular past the first few centimetres,
// dimmed sky light, and along the view ray the murk of its water column fading
// it into the lit lake bed the shallows show, all absorbed per channel like
// the bed (WATER_ABSORPTION, render/groundMaterial.ts); the water surface's
// veil (render/water.ts) then lies over legs and bed alike, and its murk layers
// hide whatever stands deeper than ~20 cm (legs fade out instead of showing as
// dark shapes). The waterline is
// blended over a few cm under a darker wet band.
//
// The selection highlight (look texel x) is a warm Fresnel rim scaled to the
// scene light plus a slight lift of the lit colour (HIGHLIGHT_FN_GLSL), so a
// selected animal stands out and keeps its coat readable day and night.

import * as THREE from 'three';
import { LAKE_BED_WET_ALBEDO, WATER_ABSORPTION, WATER_LEVEL } from '../../core/constants';
import type { LookSpec } from '../types';
import { createAnimalMaterial } from '../material/animalMaterial';
import { HIGHLIGHT_FN_GLSL } from '../material/shaderChunks';
import { crowdUniforms, patchCrowdVertex, type CrowdUniforms } from './skinning';

/** Look texels per animal instance (see header). */
export const ANIMAL_LOOK_TEXELS = 1;

const vec3 = (c: readonly number[]) => `vec3(${c.map((x) => x.toFixed(4)).join(', ')})`;

/** Turbidity of pond water seen through by submerged creatures (1/m of view path): a coat fades out within ~1 m. */
const MURK = 0.8;

/**
 * Fragment code making the submerged part of `outgoingLight` look like the
 * pond around it (see header). The water surface's veil uses the pond depth
 * where the view ray crosses it, far less than the leg's own water column
 * when a low camera looks across the shallows at a wading animal, and it can
 * only mirror the sky there: over a dark, shaded leg that read as a pale blue
 * sock. So the murk of the leg's column is added here: along the view ray the
 * coat gives way to what the shallows show around it, the wet lake bed lit by
 * the light entering the water where the ray crosses the surface (sun shadowed
 * there, not at the leg). Everything is absorbed per channel like the bed.
 */
const UNDERWATER_GLSL = /* glsl */ `{
  float crWd = ${WATER_LEVEL.toFixed(3)} - vCrWPos.y;
  float crSub = smoothstep(-0.015, 0.035, crWd);
  // wet skin just above the waterline
  outgoingLight *= 1.0 - 0.2 * smoothstep(-0.12, 0.0, crWd) * (1.0 - crSub);
  if (crSub > 0.0) {
    float d = max(crWd, 0.0);
    vec3 toEye = normalize(cameraPosition - vCrWPos);
    float vy = max(toEye.y, 0.25);
    // no sheen or specular under water and no sun past the first few cm
    // (murky water scatters it away); the sky light only through Snell's
    // window, mostly shaded by the body above wading legs
    vec3 lit = reflectedLight.directDiffuse * (1.0 - smoothstep(0.0, 0.05, d)) + reflectedLight.indirectDiffuse * 0.45;
    // light entering the water where the view ray crosses the surface
    vec3 up = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vec3 e = getAmbientLightIrradiance(ambientLightColor);
    #if NUM_HEMI_LIGHTS > 0
    for (int i = 0; i < NUM_HEMI_LIGHTS; i++) e += getHemisphereLightIrradiance(hemisphereLights[i], up);
    #endif
    #ifdef USE_ENVMAP
    e += getIBLIrradiance(up);
    #endif
    #if NUM_DIR_LIGHTS > 0
    float sunVis = 1.0;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    vec4 crossing = directionalShadowMatrix[0] * vec4(vCrWPos + toEye * (d / max(toEye.y, 0.05)), 1.0);
    sunVis = getShadow(directionalShadowMap[0], directionalLightShadows[0].shadowMapSize, directionalLightShadows[0].shadowIntensity, directionalLightShadows[0].shadowBias, directionalLightShadows[0].shadowRadius, crossing);
    #endif
    e += directionalLights[0].color * saturate(dot(up, directionalLights[0].direction)) * sunVis;
    #endif
    // murk along the view ray: the coat gives way to the lit lake bed
    float clear = exp(-d / vy * ${MURK.toFixed(2)});
    lit = lit * clear + BRDF_Lambert(${vec3(LAKE_BED_WET_ALBEDO)}) * e * (1.0 - clear);
    // absorbed per channel on the way down and back up, like the lake bed
    lit *= exp(-(d * 0.4 + d / vy) * ${vec3(WATER_ABSORPTION)});
    outgoingLight = mix(outgoingLight, lit, crSub);
  }
}`;

export interface BatchMaterials {
  material: THREE.Material;
  depth: THREE.Material;
  uniforms: CrowdUniforms[];
}

/** Depth material (shadow maps) with batched skinning. */
export function crowdDepthMaterial(u: CrowdUniforms): THREE.MeshDepthMaterial {
  const depth = new THREE.MeshDepthMaterial();
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = patchCrowdVertex(shader.vertexShader);
  };
  depth.customProgramCacheKey = () => 'crowd-depth-v1';
  return depth;
}

export function batchedAnimalMaterials(look: LookSpec, detail: 0 | 1 | 2): BatchMaterials {
  const u = crowdUniforms();
  const mat = createAnimalMaterial({ look, detail });
  const base = mat.onBeforeCompile.bind(mat);
  const baseKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    base(shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = patchCrowdVertex(
      shader.vertexShader,
      'flat varying vec4 vCrLook0;\nflat varying vec2 vCrYaw;\nvarying vec3 vCrWPos;',
      `vCrLook0 = crTexel(crBase);
{
  vec2 cy = batchingMatrix[0].xz;
  cy /= max(length(cy), 1e-6);
  vCrYaw = vec2(cy.x, -cy.y);
}`,
    ).replace('#include <project_vertex>', '#include <project_vertex>\nvCrWPos = (modelMatrix * batchingMatrix * vec4(transformed, 1.0)).xyz;');
    const fs = shader.fragmentShader;
    const hasNM = /uniform\s+mat3\s+normalMatrix\s*;/.test(fs);
    const pre = `flat varying vec4 vCrLook0;
flat varying vec2 vCrYaw;
varying vec3 vCrWPos;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
// (the vertex stage's uniform: the underwater murk samples the sun's shadow at the water surface)
uniform highp mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
#endif
${HIGHLIGHT_FN_GLSL}
${
  hasNM
    ? `mat3 crInstanceNormalMatrix() {
  float c = vCrYaw.x, s = vCrYaw.y;
  return normalMatrix * mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}
#define normalMatrix crInstanceNormalMatrix()`
    : ''
}
void main() {`;
    shader.fragmentShader = fs
      .replace('void main() {', pre)
      .replace('#include <opaque_fragment>', `outgoingLight = crHighlightFurOf(outgoingLight, vCrLook0.x, vPattern.w);\n${UNDERWATER_GLSL}\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `${baseKey()}|crowd-v2`;
  return { material: mat, depth: crowdDepthMaterial(u), uniforms: [u] };
}
