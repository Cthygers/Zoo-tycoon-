// Moonlit night look of figures (animals and people), matching the moonlit
// ground. At night the hemisphere fill (render/context.ts moonFill) lights
// everything from a blue sky, and the grade's rod vision (render/grade.ts)
// shifts dim colours further toward blue. Natural ground, grass, ground
// plants and bark take a neutral moonlit light in their own hue instead and
// keep a share of that hue through the grade (render/groundMaterial.ts
// nightGroundLight / NIGHT_GROUND). Figures without it read as slate-blue
// statues on the warm-grey sand (a lioness at sRGB R/B 0.71, an elephant at
// 0.56, dark faces blue-black).
//
// applyFigureNight gives a figure material the same treatment at night level
// k (the moonlit-ground level, setFigureNightGround):
//   * light: the diffuse light leans toward its own luminance in the albedo's
//     hue by FIGURE_NIGHT.light × k (the sky reflection toward neutral grey),
//     with no lift: luminance is kept, so figures stay darker than a white
//     shirt and white coats (zebra stripes) stay neutral;
//   * grade: the figure is marked for the night grade (FIGURE_NIGHT.mark × k,
//     as the ground is), so it keeps a share of its hue under rod vision. The
//     mark combines with the lamp field's (props/lights/lampField.ts) as the
//     larger of the two, whichever runs later: on tiers that tone-map in the
//     material it is applied as tone mapping runs, on the post-FX tier to the
//     HDR alpha after the lamp field has added its own.
// One shared uniform for every figure material: one value per frame, no draw
// calls, a few ALU per pixel.

import * as THREE from 'three';

/** Share of the night look figures take at night level 1 (see header). */
export const FIGURE_NIGHT = { light: 0.6, mark: 0.18 } as const;

const LUMA = 'vec3(0.2126, 0.7152, 0.0722)';

/** Shared by every material patched with applyFigureNight. */
export const figureNightUniforms = {
  /** Moonlit-ground night level: 0 by day and through the blue hour, 1 in deep night. */
  uFigureNight: { value: 0 },
};

/**
 * Set the night level of figures: the moonlit-ground level main.ts passes to
 * setNatureNightGround (render/context.ts nightGroundLevel). Call every frame.
 */
export function setFigureNightGround(level: number): void {
  figureNightUniforms.uFigureNight.value = level;
}

const FRAGMENT_PARS = /* glsl */ `
uniform float uFigureNight;
float figNightMark = 0.0;
#if defined( TONE_MAPPING ) && defined( WH_LAMP_LIT )
// the grade's mark is the larger of the night mark and the lamp field's
// (which writes whLampLit just before tone mapping)
vec3 figNightToneMapping( vec3 color ) {
  whLampLit = max( whLampLit, figNightMark );
  return toneMapping( color );
}
#define toneMapping figNightToneMapping
#endif`;

/** Before <aomap_fragment> (after the lights): neutral moonlit light in the albedo's hue, and the grade mark. */
function fragmentLight(share: string): string {
  return /* glsl */ `
if (uFigureNight > 0.0) {
  float fnK = uFigureNight * clamp(${share}, 0.0, 1.0);
  vec3 fnHue = diffuseColor.rgb / max(dot(diffuseColor.rgb, ${LUMA}), 1e-4);
  float fnL = ${FIGURE_NIGHT.light.toFixed(2)} * fnK;
  reflectedLight.directDiffuse = mix(reflectedLight.directDiffuse, dot(reflectedLight.directDiffuse, ${LUMA}) * fnHue, fnL);
  reflectedLight.indirectDiffuse = mix(reflectedLight.indirectDiffuse, dot(reflectedLight.indirectDiffuse, ${LUMA}) * fnHue, fnL);
  reflectedLight.indirectSpecular = mix(reflectedLight.indirectSpecular, vec3(dot(reflectedLight.indirectSpecular, ${LUMA})), fnL);
  figNightMark = ${FIGURE_NIGHT.mark.toFixed(2)} * fnK;
}`;
}

// after <tonemapping_fragment>: on the post-FX tier (no tone mapping in the
// material) the mark goes into the HDR alpha, which the lamp field has
// already raised by its own mark
const FRAGMENT_MARK_HDR = /* glsl */ `
#ifndef TONE_MAPPING
if (figNightMark > 0.0) gl_FragColor.a = max(gl_FragColor.a, 1.0 + figNightMark);
#endif`;

/**
 * Patch a standard / physical figure material (in onBeforeCompile, BEFORE
 * applyLampField, which must stay last) with the night look. `share`: a GLSL
 * float expression (0…1) scaling it per fragment, e.g. a mask. Keeps the hooks
 * <aomap_fragment> and <tonemapping_fragment> in place.
 */
export function applyFigureNight(shader: THREE.WebGLProgramParametersWithUniforms, share = '1.0'): void {
  Object.assign(shader.uniforms, figureNightUniforms);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>${FRAGMENT_PARS}`)
    .replace('#include <aomap_fragment>', `${fragmentLight(share)}\n#include <aomap_fragment>`)
    .replace('#include <tonemapping_fragment>', `#include <tonemapping_fragment>${FRAGMENT_MARK_HDR}`);
}
