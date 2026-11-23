// GLSL patches for GPU skinning of BatchedMesh instances.
//
// Each batch owns one RGBA32F DataTexture ("crData") holding a block of
// `crStride` texels per instance id:
//
//   [ look texels (crLook of them) | bone 0 row0,row1,row2 | bone 1 … ]
//
// A bone is an affine 3×4 matrix (model space skin matrix = joint transform ×
// inverse bind, rows stored as texels). The vertex shader finds its instance
// id through three's batching indirection (getIndirectIndex(gl_DrawID)),
// blends the 4 influencing bone matrices (linear blend skinning, same as
// THREE.SkinnedMesh) and then lets three apply the per-instance world matrix
// (batchingMatrix), so shading, fog and shadows work unchanged. The look
// texels are per-instance parameters (highlight, clothing colours, …) that
// materials read in the vertex shader and pass on as flat varyings.

import type * as THREE from 'three';

export interface CrowdUniforms {
  crData: { value: THREE.DataTexture | null };
  crStride: { value: number };
  crLook: { value: number };
}

export const CROWD_PARS_VERTEX = /* glsl */ `
attribute vec4 skinIndex;
attribute vec4 skinWeight;
uniform highp sampler2D crData;
uniform int crStride;
uniform int crLook;
vec4 crTexel(const in int i) {
  int w = textureSize(crData, 0).x;
  int y = i / w;
  return texelFetch(crData, ivec2(i - y * w, y), 0);
}
`;

/** Replaces <skinbase_vertex>: instance id, base offset and the blended bone rows. */
export const CROWD_SKINBASE_VERTEX = /* glsl */ `
int crInst = int(getIndirectIndex(gl_DrawID));
int crBase = crInst * crStride;
ivec4 crSI = ivec4(crBase + crLook) + ivec4(skinIndex + 0.5) * 3;
vec4 crR0 = crTexel(crSI.x) * skinWeight.x + crTexel(crSI.y) * skinWeight.y + crTexel(crSI.z) * skinWeight.z + crTexel(crSI.w) * skinWeight.w;
vec4 crR1 = crTexel(crSI.x + 1) * skinWeight.x + crTexel(crSI.y + 1) * skinWeight.y + crTexel(crSI.z + 1) * skinWeight.z + crTexel(crSI.w + 1) * skinWeight.w;
vec4 crR2 = crTexel(crSI.x + 2) * skinWeight.x + crTexel(crSI.y + 2) * skinWeight.y + crTexel(crSI.z + 2) * skinWeight.z + crTexel(crSI.w + 2) * skinWeight.w;
`;

export const CROWD_SKINNORMAL_VERTEX = /* glsl */ `
objectNormal = vec3(dot(crR0.xyz, objectNormal), dot(crR1.xyz, objectNormal), dot(crR2.xyz, objectNormal));
`;

export const CROWD_SKINNING_VERTEX = /* glsl */ `
{
  vec4 crP = vec4(transformed, 1.0);
  transformed = vec3(dot(crR0, crP), dot(crR1, crP), dot(crR2, crP));
}
`;

/**
 * Patch a three.js vertex shader (any built-in material that includes the
 * standard skinning chunks: standard, physical, depth, distance …) for
 * batched texture skinning. `extraPars` / `afterBase` let materials declare and
 * fill their own per-instance varyings (they may use crTexel(crBase + i)).
 */
export function patchCrowdVertex(vs: string, extraPars = '', afterBase = ''): string {
  for (const hook of HOOKS) {
    if (!vs.includes(hook) && !warned.has(hook)) {
      warned.add(hook);
      console.warn(`[models] crowd skinning: vertex shader lacks '${hook}' — batched creatures will not deform correctly`);
    }
  }
  return vs
    .replace('#include <common>', `#include <common>\n${CROWD_PARS_VERTEX}\n${extraPars}`)
    .replace('#include <skinbase_vertex>', `${CROWD_SKINBASE_VERTEX}\n${afterBase}`)
    .replace('#include <skinnormal_vertex>', CROWD_SKINNORMAL_VERTEX)
    .replace('#include <skinning_vertex>', CROWD_SKINNING_VERTEX);
}

const HOOKS = ['#include <common>', '#include <skinbase_vertex>', '#include <skinnormal_vertex>', '#include <skinning_vertex>'];
const warned = new Set<string>();

export function crowdUniforms(): CrowdUniforms {
  return { crData: { value: null }, crStride: { value: 0 }, crLook: { value: 0 } };
}
