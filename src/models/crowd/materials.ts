// Batched (instanced + texture-skinned) variants of the creature materials.
//
// Animals: the batched material IS the species material from
// material/animalMaterial.ts (createAnimalMaterial) with the crowd skinning
// patch chained after its own onBeforeCompile, so every uniform, define or
// varying the animal material declares automatically reaches batched and LOD
// meshes. Per-instance parameters arrive through the batch data texture:
//
//   look texel 0 = (highlight, growth 0..1, user0, user1)
//     → fragment: `flat varying vec4 vCrLook0` (x = highlight emissive,
//        y = growth — e.g. for a juvenile tint, z/w free for extensions)
//     → fragment: `flat varying vec2 vCrYaw` (cos, sin of the instance yaw);
//        `normalMatrix` is redefined as normalMatrix × instance rotation so
//        object-space micro-normals stay correct for every instance.
//
// To add a per-instance value: bump ANIMAL_LOOK_TEXELS, write it in
// RiggedModel.writeLook(), read it with `crTexel(crBase + k)` in the vertex
// shader (see `afterBase` below) and pass it on as a flat varying.
//
// Below the pond surface the animal's light is absorbed per channel exactly
// like the lake bed's albedo in render/groundMaterial.ts (red first, then
// green), so wading legs and swimming bodies sink into the water colour at
// their depth instead of showing their dry, sky-lit colour through the veil.

import * as THREE from 'three';
import { WATER_LEVEL } from '../../core/constants';
import type { LookSpec } from '../types';
import { createAnimalMaterial } from '../material/animalMaterial';
import { crowdUniforms, patchCrowdVertex, type CrowdUniforms } from './skinning';

/** Look texels per animal instance (see header). */
export const ANIMAL_LOOK_TEXELS = 1;

export const HIGHLIGHT_GLSL = 'vec3(1.0, 0.85, 0.35)';

/** Fragment code applying the underwater absorption to `outgoingLight` (see header). */
const UNDERWATER_GLSL = /* glsl */ `{
  float crWd = ${WATER_LEVEL.toFixed(3)} - vCrWPos.y;
  if (crWd > 0.0) {
    // view leg up to the eye plus the shorter leg of the light down to this
    // point; murky pond water also scatters light away, so deeper parts fade
    // into the water colour the surface veil lays over them
    float crVy = max(normalize(cameraPosition - vCrWPos).y, 0.25);
    outgoingLight *= exp(-(crWd / crVy + crWd * 0.4) * vec3(0.5, 0.19, 0.14) - crWd * 1.6);
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
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += ${HIGHLIGHT_GLSL} * vCrLook0.x;`)
      .replace('#include <opaque_fragment>', `${UNDERWATER_GLSL}\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `${baseKey()}|crowd-v1`;
  return { material: mat, depth: crowdDepthMaterial(u), uniforms: [u] };
}
