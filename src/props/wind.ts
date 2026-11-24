// Wind sway for foliage. Materials flagged with `material.userData.sway`
// (metres of sideways displacement per metre of height above the object's
// origin) get a vertex patch that bends them in a gusty, travelling wind.
//
// The displacement is computed in world space (so the wind blows the same
// way for every instance, whatever its rotation) and converted back to the
// object's local space before the standard pipeline runs. Shading, shadow
// receiving and shadow casting therefore all see the same displaced vertex.
// Works for plain Meshes, InstancedMesh (instanceMatrix) and BatchedMesh. For shadows the
// mesh needs `customDepthMaterial = windDepthMaterial(material)` — use
// `setupWindMesh(mesh)`. BatchedMesh (batchingMatrix) is supported too.

import * as THREE from 'three';
import { preFadeHooks } from './lod/fade';

/** Shared uniforms (one object, referenced by every patched program). */
export const windUniforms = {
  uWindTime: { value: 0 },
  /** Normalized XZ direction the wind blows toward. */
  uWindDir: { value: new THREE.Vector2(0.83, 0.56) },
  /** Global strength multiplier (0 = calm). */
  uWindStrength: { value: 1 },
};

/**
 * GLSL helpers. `windOffset(origin, vertex, h)` returns the world-space
 * displacement for a vertex at world position `vertex`, `h` metres above the
 * object origin `origin`, before multiplying by the material's sway.
 */
export const WIND_GLSL = /* glsl */ `
uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
vec3 windOffset( vec3 o, vec3 p, float h ) {
  float t = uWindTime;
  float rnd = fract( sin( dot( floor( o.xz * 2.0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  // gusts travel downwind across the zoo
  float ph = dot( o.xz, uWindDir ) * 0.045;
  float gust = 0.5 + 0.5 * sin( t * 0.31 - ph * 1.7 ) * sin( t * 0.117 - ph + 1.3 );
  gust = 0.35 + 0.65 * gust * gust;
  float osc = sin( t * ( 1.25 + rnd * 0.3 ) - ph * 3.0 + rnd * 6.2832 ) * 0.65
            + sin( t * 2.3 - ph * 2.1 + rnd * 3.1 ) * 0.35;
  float bend = gust * ( 0.55 + 0.45 * osc );
  vec2 perp = vec2( -uWindDir.y, uWindDir.x );
  float side = sin( t * 1.7 + rnd * 9.0 + ph ) * 0.22 * gust;
  vec2 d = ( uWindDir * bend + perp * side ) * h;
  // leaf flutter: small, fast, varies per vertex
  float fl = sin( t * 6.5 + dot( p, vec3( 2.3, 1.9, 2.9 ) ) + rnd * 6.0 ) * 0.07 * min( h, 4.0 ) * ( 0.4 + gust );
  return vec3( d.x + fl * 0.6, fl * 0.5, d.y - fl * 0.4 ) * uWindStrength;
}
`;

/** Vertex code run after `transformed` is defined (needs WIND_GLSL + `uniform float uSway`). */
export const WIND_VERTEX = /* glsl */ `
{
  #if defined( USE_BATCHING )
    mat4 wM = modelMatrix * batchingMatrix;
  #elif defined( USE_INSTANCING )
    mat4 wM = modelMatrix * instanceMatrix;
  #else
    mat4 wM = modelMatrix;
  #endif
  vec3 wO = wM[ 3 ].xyz;
  vec3 wP = ( wM * vec4( transformed, 1.0 ) ).xyz;
  float wH = max( wP.y - wO.y, 0.0 );
  vec3 wOff = windOffset( wO, wP, wH ) * uSway;
  mat3 wR = mat3( wM );
  transformed += ( transpose( wR ) * wOff ) / max( dot( wR[ 0 ], wR[ 0 ] ), 1e-6 );
}
`;

type ShaderLike = THREE.WebGLProgramParametersWithUniforms;

function patchShader(shader: ShaderLike, sway: { value: number }): void {
  shader.uniforms.uWindTime = windUniforms.uWindTime;
  shader.uniforms.uWindDir = windUniforms.uWindDir;
  shader.uniforms.uWindStrength = windUniforms.uWindStrength;
  shader.uniforms.uSway = sway;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${WIND_GLSL}\nuniform float uSway;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_VERTEX}`);
}

interface WindData {
  sway: { value: number };
  depth?: THREE.MeshDepthMaterial;
  /** The material's own hooks from before the wind patch (for cloning). */
  prev: THREE.Material['onBeforeCompile'];
  prevKey: () => string;
}

const windData = new WeakMap<THREE.Material, WindData>();

/** Does this material request wind sway? */
export function hasSway(material: THREE.Material): boolean {
  const s = material.userData?.sway;
  return typeof s === 'number' && s > 0;
}

/**
 * Patch a material for wind sway (idempotent). Amplitude defaults to
 * `material.userData.sway`. Returns false when the material has no sway.
 */
export function applyWind(material: THREE.Material, amplitude?: number): boolean {
  const amp = amplitude ?? (material.userData?.sway as number | undefined) ?? 0;
  if (!(amp > 0)) return false;
  const existing = windData.get(material);
  if (existing) {
    existing.sway.value = amp;
    return true;
  }
  const prev = material.onBeforeCompile;
  const prevKeyFn = material.customProgramCacheKey;
  const prevKey = prevKeyFn.call(material);
  const data: WindData = { sway: { value: amp }, prev, prevKey: prevKeyFn };
  windData.set(material, data);
  material.onBeforeCompile = function (shader, renderer) {
    prev.call(this, shader, renderer);
    patchShader(shader, data.sway);
  };
  material.customProgramCacheKey = () => `${prevKey}|wind`;
  material.needsUpdate = true;
  return true;
}

/**
 * Depth material (directional / spot shadow maps) that sways exactly like
 * `material`. Cached per material; three copies map / alphaTest / side onto
 * it at render time, so alpha-tested leaf cards keep their cut-outs.
 */
export function windDepthMaterial(material: THREE.Material): THREE.MeshDepthMaterial | null {
  if (!applyWind(material)) return null;
  const data = windData.get(material)!;
  if (!data.depth) {
    const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    d.onBeforeCompile = (shader) => patchShader(shader, data.sway);
    d.customProgramCacheKey = () => 'props-wind-depth';
    data.depth = d;
  }
  return data.depth;
}

/** Patch a mesh's swaying materials and give it a matching shadow depth material. */
export function setupWindMesh(mesh: THREE.Mesh): boolean {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  let depth: THREE.MeshDepthMaterial | null = null;
  for (const m of mats) {
    if (!hasSway(m)) continue;
    const d = windDepthMaterial(m);
    if (!depth) depth = d;
  }
  if (depth) mesh.customDepthMaterial = depth;
  return depth !== null;
}

/** Advance the shared wind clock. */
export function updateWind(dt: number, strength?: number): void {
  windUniforms.uWindTime.value = (windUniforms.uWindTime.value + dt) % 3600;
  if (strength !== undefined) windUniforms.uWindStrength.value = strength;
}

/**
 * Clone a prop material keeping its custom shader hooks (Material.clone()
 * drops onBeforeCompile). Wind is re-applied freshly on the clone, so it never
 * gets patched twice.
 */
export function cloneWithHooks<T extends THREE.Material>(material: T): T {
  const c = material.clone() as T;
  const w = windData.get(material);
  // the layer's near-camera fade is applied after the wind patch: strip it too
  const f = preFadeHooks(material);
  c.onBeforeCompile = w ? w.prev : f ? f.prev : material.onBeforeCompile;
  c.customProgramCacheKey = w ? w.prevKey : f ? f.prevKey : material.customProgramCacheKey;
  // the layer turns alpha-to-coverage on for faded vegetation only
  if (f) c.alphaToCoverage = false;
  if (hasSway(c)) applyWind(c);
  return c;
}

/** Release cached depth materials for a material (call when disposing it). */
export function disposeWind(material: THREE.Material): void {
  const d = windData.get(material);
  d?.depth?.dispose();
}
