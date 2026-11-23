// Near-camera "screen-door" fade for vegetation. When the camera is close to
// the ground (follow mode, close zoom), tree canopies between the camera and
// what it looks at hide the view. Flagged materials get a vertex/fragment
// patch that dissolves
//   - whole instances whose origin (trunk) is within a few metres of the
//     camera horizontally (the camera stands in / next to that plant),
//   - any vertex touching the lens (small sphere), and
//   - geometry inside a cylinder around the camera → focus line, in front of
//     the focus (a see-through hole to the subject).
// Two flavours, chosen by material.userData (see registry.ts):
//   foliage = true   leaves, fronds, stems: all three terms;
//   fadeNear = true  solid parts (bark, cactus): the whole-instance term only,
//                    so the view hole never cuts a trunk into a stippled stump.
// Partly faded surfaces are kept rare and small, because without TAA any
// dither reads as noise: as the camera pulls out the hole shrinks (instead of
// everything in it turning half see-through) and its rim is narrow.
// Output: with MSAA (medium / high) the fade drives alpha-to-coverage, which
// resolves as real translucency; without MSAA a 4×4 ordered (Bayer) dither
// discards pixels — an even, fine screen rather than salt-and-pepper noise.
// No blending / sorting is needed and it works for BatchedMesh, InstancedMesh
// and plain meshes alike. Shadow / depth passes use their own depth materials
// and never fade, so shadows stay put.

import * as THREE from 'three';

/** Shared uniforms (one set, referenced by every patched program). */
export const fadeUniforms = {
  uFadeCam: { value: new THREE.Vector3(0, -1e4, 0) },
  /** Point the camera looks at (slightly above the ground). */
  uFadeFocus: { value: new THREE.Vector3(0, -1e4, 0) },
  /**
   * x: per-instance radius (horizontal camera distance to the instance origin / trunk),
   * y: line radius at the camera, z: line radius at the focus,
   * w: hole size 0..1 (scales every radius; 0 = nothing fades).
   */
  uFadeParams: { value: new THREE.Vector4(0, 0, 0, 0) },
  /**
   * x: distance before the focus where the line fade stops (keeps the subject's own surroundings),
   * y: small per-vertex sphere around the lens (leaves touching the camera).
   */
  uFadeMargin: { value: new THREE.Vector2(2.5, 1.5) },
};

const FADE_PARS_VERT = /* glsl */ `
uniform vec3 uFadeCam;
uniform vec3 uFadeFocus;
uniform vec4 uFadeParams;
uniform vec2 uFadeMargin;
varying float vPropFade;
// p = world vertex, o = world origin of its instance (trunk base / object origin)
float propFadeAt( vec3 p, vec3 o ) {
  float k = uFadeParams.w;
  // whole instance: the camera stands inside / right next to this plant (uniform
  // dissolve, so a canopy around the camera never shows a stippled ring)
  float ir = uFadeParams.x * k;
  float instF = ( 1.0 - smoothstep( ir * 0.85, ir, length( uFadeCam.xz - o.xz ) ) )
              * ( 1.0 - smoothstep( o.y + 12.0, o.y + 16.0, uFadeCam.y ) );
#ifdef PROP_FADE_SOLID
  return instF;
#else
  // per vertex: anything touching the lens
  vec3 ap = p - uFadeCam;
  float lr = uFadeMargin.y * k;
  float lensF = 1.0 - smoothstep( lr * 0.85, lr, length( ap ) );
  // per vertex: a cylinder around the view line, in front of the focus
  vec3 ab = uFadeFocus - uFadeCam;
  float len = max( length( ab ), 1e-3 );
  vec3 dir = ab / len;
  float t = dot( ap, dir );
  float r = length( ap - dir * t );
  float tEnd = len - uFadeMargin.x;
  float along = smoothstep( -0.5, 0.0, t ) * ( 1.0 - smoothstep( tEnd - 0.5, tEnd, t ) );
  float rad = mix( uFadeParams.y, uFadeParams.z, clamp( t / len, 0.0, 1.0 ) ) * k;
  float lineF = along * ( 1.0 - smoothstep( rad * 0.85, rad, r ) );
  return max( max( instF, lensF ), lineF );
#endif
}
`;

const FADE_VERT = /* glsl */ `
vPropFade = 0.0;
if ( uFadeParams.w > 0.0 ) {
  #if defined( USE_BATCHING )
    mat4 fdM = modelMatrix * batchingMatrix;
  #elif defined( USE_INSTANCING )
    mat4 fdM = modelMatrix * instanceMatrix;
  #else
    mat4 fdM = modelMatrix;
  #endif
  vPropFade = propFadeAt( ( fdM * vec4( transformed, 1.0 ) ).xyz, fdM[ 3 ].xyz );
}
`;

const FADE_PARS_FRAG = /* glsl */ `
varying float vPropFade;
#ifndef ALPHA_TO_COVERAGE
const float FD_BAYER[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
#endif
`;

// no MSAA: ordered dither, decided before any shading work. The interpolated
// fade is sharpened first: a leaf card straddling the hole's rim gets a narrow
// dithered edge instead of a halftone screen across the whole card.
const FADE_DISCARD = /* glsl */ `
#ifndef ALPHA_TO_COVERAGE
float fdF = smoothstep( 0.3, 0.7, vPropFade );
if ( fdF > 0.0 ) {
  ivec2 fdP = ivec2( gl_FragCoord.xy ) & 3;
  if ( fdF * 16.0 > FD_BAYER[ fdP.x + fdP.y * 4 ] + 0.5 ) discard;
}
#endif
`;

// MSAA: coverage follows the fade (after the leaf alpha test turned alpha into coverage)
const FADE_COVERAGE = /* glsl */ `
#ifdef ALPHA_TO_COVERAGE
diffuseColor.a *= 1.0 - vPropFade;
#endif
`;

interface FadeData {
  prev: THREE.Material['onBeforeCompile'];
  prevKey: () => string;
}

const fadeData = new WeakMap<THREE.Material, FadeData>();

export type FadeMode = 'foliage' | 'solid';

/** How a material fades near the camera (null = never), from its userData flags. */
export function fadeModeOf(m: THREE.Material): FadeMode | null {
  const u = m.userData ?? {};
  if (u.foliage === true) return 'foliage';
  if (u.fadeNear === true) return 'solid';
  return null;
}

/**
 * Patch a material with the near-camera fade (idempotent). Apply after the
 * wind patch. Set `material.alphaToCoverage` (MSAA targets only) to get the
 * translucent version instead of the dither.
 */
export function applyFade(m: THREE.Material, mode: FadeMode): void {
  if (fadeData.has(m)) return;
  const prev = m.onBeforeCompile;
  const prevKeyFn = m.customProgramCacheKey;
  const data: FadeData = { prev, prevKey: prevKeyFn };
  fadeData.set(m, data);
  const solid = mode === 'solid' ? '#define PROP_FADE_SOLID\n' : '';
  m.onBeforeCompile = function (shader, renderer) {
    prev.call(this, shader, renderer);
    shader.uniforms.uFadeCam = fadeUniforms.uFadeCam;
    shader.uniforms.uFadeFocus = fadeUniforms.uFadeFocus;
    shader.uniforms.uFadeParams = fadeUniforms.uFadeParams;
    shader.uniforms.uFadeMargin = fadeUniforms.uFadeMargin;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${solid}${FADE_PARS_VERT}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${FADE_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FADE_PARS_FRAG}`)
      .replace('#include <clipping_planes_fragment>', `${FADE_DISCARD}\n#include <clipping_planes_fragment>`)
      .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>\n${FADE_COVERAGE}`);
  };
  // resolve the previous key now: the default key is the hook's source text,
  // which would otherwise read the wrapper below for every material
  const prevKey = prevKeyFn.call(m);
  m.customProgramCacheKey = () => `${prevKey}|propfade-${mode}`;
  m.needsUpdate = true;
}

/** The hooks a material had before the fade patch (null when not patched). */
export function preFadeHooks(m: THREE.Material): FadeData | null {
  return fadeData.get(m) ?? null;
}

// ---------------------------------------------------------------------------
// Per-frame driver

const _dir = new THREE.Vector3();

export interface FadeTuning {
  /** Camera → focus distance (m) above which nothing fades. */
  maxDist: number;
}

/**
 * Update the shared fade uniforms from the camera and the point it looks at.
 * `focus` is the ground point at the screen centre.
 */
export function updateFade(camPos: THREE.Vector3, focus: THREE.Vector3, enabled: boolean, tuning: FadeTuning = { maxDist: 42 }): void {
  const u = fadeUniforms;
  const d = camPos.distanceTo(focus);
  // hole size: full when close, shrinking to nothing by maxDist (smooth so nothing pops)
  const k = enabled ? 1 - THREE.MathUtils.smoothstep(d, tuning.maxDist * 0.7, tuning.maxDist) : 0;
  u.uFadeParams.value.w = k;
  if (k <= 0) return;
  u.uFadeCam.value.copy(camPos);
  // aim at the subject's body, not its feet
  _dir.copy(focus);
  _dir.y += 1.1;
  u.uFadeFocus.value.copy(_dir);
  u.uFadeParams.value.x = THREE.MathUtils.clamp(d * 0.3, 2.2, 5.5);
  u.uFadeMargin.value.y = THREE.MathUtils.clamp(d * 0.12, 1.0, 2.2);
  u.uFadeParams.value.y = THREE.MathUtils.clamp(d * 0.08, 1.0, 2.2);
  u.uFadeParams.value.z = THREE.MathUtils.clamp(d * 0.16, 1.8, 4.0);
  u.uFadeMargin.value.x = THREE.MathUtils.clamp(d * 0.06, 0.8, 2.5);
}
