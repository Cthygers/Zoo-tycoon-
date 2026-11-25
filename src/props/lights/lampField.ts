// Lamp light on animals and people, on every tier and without real lights:
// the night light pools' 1 m light grid (nightlights.ts) doubles as a small
// texture over the whole map (one R8 texel per grid vertex). Creature and
// human materials fetch it per vertex (applyLampField) and add warm lamp
// irradiance where they stand, so a guest under a lamp is lit like the paving
// around them instead of being a black cut-out. No extra draws.
//
// A figure's surface reads the field a little way out along its normal,
// further the higher it is (LAMP_REACH): the side and the upper body facing a
// lamp catch its light beyond the pool's ground edge, the far side less, so a
// guest at a pool's fringe gets a gradual warm side instead of the whole
// figure flipping between lamp-lit and moonlit. Its colour (the grade's mark,
// not the light) reaches further still (LAMP_MARK_REACH), so that warm side
// keeps its hue and is seen from the camera's side too.
//
// The same pixels are marked lamp-lit for the night grade (render/grade.ts),
// so they keep their colour instead of turning to rod vision: through
// `whLampLit` on tiers that tone-map in the material, through the HDR
// target's alpha on the post-FX tier.
//
// Standalone on purpose (three, core constants and the grade's exposure
// uniform only): the creature materials import it without pulling in the
// props layer.

import * as THREE from 'three';
import { WORLD_H, WORLD_W } from '../../core/constants';
import { viewExposure } from '../../render/grade';

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
  /** The view's exposure, for the moonlit shoulder on the post-FX tier. */
  uViewExposure: viewExposure,
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

/**
 * Lamp light (field value) over which a figure moves from the moonlit grade
 * to colour, and the curve of its colour share (mark^MARK_GAMMA): wide and
 * gradual, so at a pool's fringe a guest is dim and only partly coloured
 * instead of flipping between a daylit figure and a grey statue a metre apart.
 */
const MARK_RAMP = [0.05, 0.8] as const;
const MARK_GAMMA = 0.7;
/** The grade shows full colour from this lamp-lit mark on (render/grade.ts: smoothstep from 0). */
const GRADE_MARK_FULL = 0.4;
/**
 * Moonlit highlight shoulder of figures (every tier): above ≈ MOON_KNEE
 * displayed, a figure's brightness grows only with its square root, so a
 * white coat under the moon sits ≈ 3× the moonlit ground like a pale wall
 * instead of glowing 15–20× it (ACES's toe crushes the ground, not the coat).
 * Guests' moonlit shirts stay below the knee.
 */
const MOON_KNEE = 0.08;
/**
 * Moonlit toe of figures: ACES's toe crushes dark coats and clothes under the
 * moon (giraffe patches, dark hair) into black holes next to the moonlit
 * ground; below ≈ MOON_TOE displayed they get up to 1 + MOON_TOE_LIFT times
 * their light, as the ground gets its night lift (render/groundMaterial.ts).
 */
const MOON_TOE = 0.03;
const MOON_TOE_LIFT = 1.0;
/**
 * Moonlit toe of dark skin (materials that define LF_SKIN as their dark-skin
 * mask 0…1, humans/material.ts): ACES's toe turns a dark face under the moon
 * into a black void above a moonlit shirt (1/15 of a white one). Up to
 * 1 + SKIN_TOE_LIFT times its light, easing off over ≈ SKIN_TOE displayed (an
 * exponential, so the curve stays monotonic and a face keeps its lit and
 * shaded side): a dark face keeps ≈ 1/6 of a white shirt. Pale and mid skins
 * are outside the mask, so they don't glow.
 */
const SKIN_TOE = 0.018;
const SKIN_TOE_LIFT = 6.5;
/**
 * How far out along a figure's normal (horizontally) its surface reads the
 * lamp field: LAMP_REACH[0] m at the feet plus LAMP_REACH[1] m per metre of
 * height (model space), ≈ 1 m at a guest's head.
 */
const LAMP_REACH = [0.2, 0.5] as const;
/**
 * The same for the lamp-lit mark alone (≈ 2 m out at a guest's chest): a
 * figure a step outside a pool keeps the colour of the light it faces (the
 * larger of the two readings), while its brightness still follows LAMP_REACH.
 */
const LAMP_MARK_REACH = [0.5, 1.1] as const;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Share of full colour the night grade gives a figure in lamp light `light` (0…1) at `night` (0…1). */
export function figureColourShare(light: number, night: number): number {
  return Math.pow(smooth(MARK_RAMP[0], MARK_RAMP[1], light) * night, MARK_GAMMA);
}

/** Factor the moonlit shoulder applies to a figure displayed at `display` (luminance × exposure). */
export function moonShoulder(display: number): number {
  const x = Math.min(display / MOON_KNEE, 12);
  return Math.pow(1 + x * x * x * x, -0.125);
}

/** Factor the moonlit toe applies to a figure displayed at `display` (luminance × exposure). */
export function moonToe(display: number): number {
  return 1 + MOON_TOE_LIFT * (1 - smooth(0, MOON_TOE, display));
}

/** Moonlit toe factor of skin with dark-skin mask `dark` (0…1) displayed at `display` (≥ moonToe). */
export function skinMoonToe(display: number, dark: number): number {
  return Math.max(moonToe(display), 1 + SKIN_TOE_LIFT * dark * Math.exp(-display / SKIN_TOE));
}

/** Horizontal distance (m) out along the normal at which a figure's surface `height` m up reads the lamp field. */
export function lampReach(height: number): number {
  return LAMP_REACH[0] + LAMP_REACH[1] * Math.max(height, 0);
}

/** The same distance for the lamp-lit colour mark (the shader marks with the larger of the two readings). */
export function lampMarkReach(height: number): number {
  return LAMP_MARK_REACH[0] + LAMP_MARK_REACH[1] * Math.max(height, 0);
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
varying float vLampLight;
varying float vLampMark;`;

// after <project_vertex>: `transformed` is the final local position (its y
// the height above the figure's feet), `transformedNormal` the view-space
// normal; the field is read LAMP_REACH out along the world normal
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
  vec3 lfN = normalize((vec4(transformedNormal, 0.0) * viewMatrix).xyz);
  vec2 lfAt = lfPos.xz + lfN.xz * (${LAMP_REACH[0].toFixed(2)} + ${LAMP_REACH[1].toFixed(2)} * max(transformed.y, 0.0));
  vLampLight = textureLod(uLampField, (lfAt + 0.5) / vec2(${FIELD_W.toFixed(1)}, ${FIELD_H.toFixed(1)}), 0.0).r;
  vec2 lfMarkAt = lfPos.xz + lfN.xz * (${LAMP_MARK_REACH[0].toFixed(2)} + ${LAMP_MARK_REACH[1].toFixed(2)} * max(transformed.y, 0.0));
  vLampMark = max(vLampLight, textureLod(uLampField, (lfMarkAt + 0.5) / vec2(${FIELD_W.toFixed(1)}, ${FIELD_H.toFixed(1)}), 0.0).r);
}`;

const FRAGMENT_PARS = /* glsl */ `
uniform vec3 uLampLight;
uniform float uLampMark;
uniform float uViewExposure;
varying float vLampLight;
varying float vLampMark;`;

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

// The grade's lamp-lit mark: the grade eases its colour share over
// whLampLit 0…GRADE_MARK_FULL (a smoothstep), so the mark is that curve's
// inverse of the share figureColourShare wants. It goes to whLampLit where
// the material tone-maps itself, and to the HDR target's alpha on the
// post-FX tier (the OutputPass reads alpha − 1 as whLampLit). The moonlit
// rest of the figure gets the highlight shoulder (MOON_KNEE) and the toe
// (MOON_TOE) on every tier, against the view's exposure; dark skin its own
// toe (SKIN_TOE, where the material defines LF_SKIN).
const FRAGMENT_MARK = /* glsl */ `
{
  float lfShare = pow(smoothstep(${MARK_RAMP[0].toFixed(2)}, ${MARK_RAMP[1].toFixed(2)}, vLampMark) * uLampMark, ${MARK_GAMMA.toFixed(2)});
  float lfMark = ${GRADE_MARK_FULL.toFixed(2)} * (0.5 - sin(asin(clamp(1.0 - 2.0 * lfShare, -1.0, 1.0)) / 3.0));
  #ifdef TONE_MAPPING
  float lfExposure = toneMappingExposure;
    #ifdef WH_LAMP_LIT
  whLampLit = lfMark;
    #endif
  #else
  float lfExposure = uViewExposure;
  gl_FragColor.a += lfMark;
  #endif
  float lfD = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * lfExposure;
  float lfX = min(lfD / ${MOON_KNEE.toFixed(3)}, 12.0);
  float lfX2 = lfX * lfX;
  float lfToe = 1.0 + ${MOON_TOE_LIFT.toFixed(2)} * (1.0 - smoothstep(0.0, ${MOON_TOE.toFixed(3)}, lfD));
  #ifdef LF_SKIN
  // the larger of two monotonic curves is monotonic too
  lfToe = max(lfToe, 1.0 + ${SKIN_TOE_LIFT.toFixed(2)} * (LF_SKIN) * exp(-lfD / ${SKIN_TOE.toFixed(3)}));
  #endif
  float lfTone = pow(1.0 + lfX2 * lfX2, -0.125) * lfToe;
  gl_FragColor.rgb *= mix(1.0, lfTone, uLampMark - lfShare * uLampMark);
}`;

// The real point lights on the lamps nearest the camera (high tier,
// nightlights.ts) would light a figure a second time on top of the field.
const POINT_LOOP = '#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )';
const LIGHTS_NO_POINT = THREE.ShaderChunk.lights_fragment_begin.includes(POINT_LOOP)
  ? THREE.ShaderChunk.lights_fragment_begin.replace(POINT_LOOP, '#if 0 // lamp light comes from the field')
  : null;

/**
 * Patch a standard / physical material shader (in onBeforeCompile) so it
 * receives lamp light from the field instead of the point lights. Keeps every
 * hook it uses in place, so further patches can chain. The vertex stage reads
 * `transformedNormal` (<defaultnormal_vertex>, before <project_vertex>).
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
    .replace('#include <tonemapping_fragment>', `${FRAGMENT_MARK}\n#include <tonemapping_fragment>`);
}
