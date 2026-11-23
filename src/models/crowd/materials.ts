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

import * as THREE from 'three';
import type { LookSpec } from '../types';
import { createAnimalMaterial } from '../material/animalMaterial';
import { crowdUniforms, patchCrowdVertex, type CrowdUniforms } from './skinning';

/** Look texels per animal instance (see header). */
export const ANIMAL_LOOK_TEXELS = 1;

export const HIGHLIGHT_GLSL = 'vec3(1.0, 0.85, 0.35)';

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
      'flat varying vec4 vCrLook0;\nflat varying vec2 vCrYaw;',
      `vCrLook0 = crTexel(crBase);
{
  vec2 cy = batchingMatrix[0].xz;
  cy /= max(length(cy), 1e-6);
  vCrYaw = vec2(cy.x, -cy.y);
}`,
    );
    const fs = shader.fragmentShader;
    const hasNM = /uniform\s+mat3\s+normalMatrix\s*;/.test(fs);
    const pre = `flat varying vec4 vCrLook0;
flat varying vec2 vCrYaw;
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
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += ${HIGHLIGHT_GLSL} * vCrLook0.x;`);
  };
  mat.customProgramCacheKey = () => `${baseKey()}|crowd-v1`;
  return { material: mat, depth: crowdDepthMaterial(u), uniforms: [u] };
}
