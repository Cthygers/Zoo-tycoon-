// Lamp light on animals and people, on every tier and without real lights:
// the night light pools' 1 m light grid (nightlights.ts) doubles as a small
// texture over the whole map (one R8 texel per grid vertex). Creature and
// human materials fetch it once per vertex (applyLampField) and add warm lamp
// irradiance where they stand, so a guest under a lamp is lit like the paving
// around them instead of being a black cut-out. No extra draws.
//
// The same pixels are marked lamp-lit for the night grade (render/grade.ts),
// so they keep their colour instead of turning to rod vision: through
// `whLampLit` on tiers that tone-map in the material, through the HDR
// target's alpha on the post-FX tier.
//
// Standalone on purpose (three + core constants only): the creature
// materials import it without pulling in the props layer.

import * as THREE from 'three';
import { WORLD_H, WORLD_W } from '../../core/constants';

/** One texel per integer metre of the pool grid, 0 … WORLD_W / WORLD_H inclusive. */
const FIELD_W = WORLD_W + 1;
const FIELD_H = WORLD_H + 1;

const fieldData = new Uint8Array(FIELD_W * FIELD_H);
const fieldTexture = new THREE.DataTexture(fieldData, FIELD_W, FIELD_H, THREE.RedFormat, THREE.UnsignedByteType);
fieldTexture.name = 'props/lampField';
fieldTexture.magFilter = THREE.LinearFilter;
fieldTexture.minFilter = THREE.LinearFilter;
fieldTexture.generateMipmaps = false;
fieldTexture.needsUpdate = true;

/** Shared by every material patched with applyLampField. */
export const lampFieldUniforms = {
  uLampField: { value: fieldTexture },
  /** Lamp irradiance at full pool light (warm; black by day). */
  uLampLight: { value: new THREE.Color(0, 0, 0) },
  /** Strength of the lamp-lit mark for the night grade (0 by day). */
  uLampMark: { value: 0 },
};

/**
 * Write the pool grid's light into the field (grid vertices sit on integer
 * metres; see buildPoolGrid). Everything else goes dark.
 */
export function writeLampField(position: Float32Array, light: Float32Array): void {
  fieldData.fill(0);
  for (let i = 0; i < light.length; i++) {
    const x = Math.round(position[i * 3]);
    const z = Math.round(position[i * 3 + 2]);
    if (x < 0 || z < 0 || x >= FIELD_W || z >= FIELD_H) continue;
    fieldData[z * FIELD_W + x] = Math.round(Math.min(Math.max(light[i], 0), 1) * 255);
  }
  fieldTexture.needsUpdate = true;
}

/** Lamp light level read back from the field at a world point (tests / debugging). */
export function lampFieldAt(x: number, z: number): number {
  const ix = Math.round(x);
  const iz = Math.round(z);
  if (ix < 0 || iz < 0 || ix >= FIELD_W || iz >= FIELD_H) return 0;
  return fieldData[iz * FIELD_W + ix] / 255;
}

/** Lamp brightness and grade mark for the current night level. */
export function setLampLight(color: THREE.Color, night: number): void {
  lampFieldUniforms.uLampLight.value.copy(color).multiplyScalar(night);
  lampFieldUniforms.uLampMark.value = night;
}

/** Dark field and no lamp light (the props layer went away). */
export function resetLampField(): void {
  fieldData.fill(0);
  fieldTexture.needsUpdate = true;
  setLampLight(lampFieldUniforms.uLampLight.value, 0);
}

const VERTEX_PARS = /* glsl */ `
uniform sampler2D uLampField;
varying float vLampLight;`;

// after <project_vertex>: `transformed` is the final local position
const VERTEX = /* glsl */ `
{
  vec4 lfPos = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
  lfPos = batchingMatrix * lfPos;
  #endif
  #ifdef USE_INSTANCING
  lfPos = instanceMatrix * lfPos;
  #endif
  lfPos = modelMatrix * lfPos;
  vLampLight = textureLod(uLampField, (lfPos.xz + 0.5) / vec2(${FIELD_W.toFixed(1)}, ${FIELD_H.toFixed(1)}), 0.0).r;
}`;

const FRAGMENT_PARS = /* glsl */ `
uniform vec3 uLampLight;
uniform float uLampMark;
varying float vLampLight;`;

// before <aomap_fragment>: lamps shine from above, so tops catch the most.
// The light falls off like the pool the ground visibly shows: linear on the
// HDR target, where the pool scales linear light; on tiers that tone-map in
// the material the pool multiplies display values, ≈ light^1.5 in linear
// light, so a figure at the faint pool fringe is not lit brighter than the
// paving it stands on.
const FRAGMENT_LIGHT = /* glsl */ `
if (vLampLight > 0.0) {
  vec3 lfUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float lfFacing = 0.6 + 0.4 * dot(normal, lfUp);
  float lfPool = vLampLight;
  #ifdef TONE_MAPPING
  lfPool *= sqrt(vLampLight);
  #endif
  reflectedLight.indirectDiffuse += uLampLight * (lfPool * lfFacing) * BRDF_Lambert(diffuseColor.rgb);
}`;

// The grade's lamp-lit mark, the same as on the ground around the figure, so
// a figure at the pool fringe stays in the moonlit (rod) grade like the
// paving it stands on. Where the grade tone-maps in the material (whLampLit),
// only where the display-space pool visibly brightens the ground (the grade
// shows full colour from a mark of 0.4 on); on the HDR target the pool marks
// its light linearly in the alpha, and so does this.
const FRAGMENT_MARK_TONEMAP = /* glsl */ `
#ifdef WH_LAMP_LIT
whLampLit = smoothstep(0.15, 0.6, vLampLight) * uLampMark;
#endif`;

const FRAGMENT_MARK_ALPHA = /* glsl */ `
#ifndef TONE_MAPPING
gl_FragColor.a += vLampLight * uLampMark;
#endif`;

// The real point lights on the lamps nearest the camera (high tier,
// nightlights.ts) would light a figure a second time on top of the field.
const POINT_LOOP = '#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )';
const LIGHTS_NO_POINT = THREE.ShaderChunk.lights_fragment_begin.includes(POINT_LOOP)
  ? THREE.ShaderChunk.lights_fragment_begin.replace(POINT_LOOP, '#if 0 // lamp light comes from the field')
  : null;

/**
 * Patch a standard / physical material shader (in onBeforeCompile) so it
 * receives lamp light from the field instead of the point lights. Keeps every
 * hook it uses in place, so further patches can chain.
 */
export function applyLampField(shader: THREE.WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, lampFieldUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>${VERTEX_PARS}`)
    .replace('#include <project_vertex>', `#include <project_vertex>${VERTEX}`);
  if (LIGHTS_NO_POINT) shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', LIGHTS_NO_POINT);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>${FRAGMENT_PARS}`)
    .replace('#include <aomap_fragment>', `${FRAGMENT_LIGHT}\n#include <aomap_fragment>`)
    .replace('#include <tonemapping_fragment>', `${FRAGMENT_MARK_TONEMAP}\n#include <tonemapping_fragment>`)
    .replace('#include <opaque_fragment>', `#include <opaque_fragment>${FRAGMENT_MARK_ALPHA}`);
}
