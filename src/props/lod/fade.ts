// Near-camera "screen-door" fade for vegetation (and any prop material that
// opts in). When the camera is close to the ground (follow mode, close zoom),
// tree canopies, trunks and big leaves between the camera and what it looks
// at hide the view. Flagged materials get a vertex/fragment patch that
// dissolves
//   - whole instances whose origin (trunk) is within a few metres of the
//     camera horizontally (the camera stands in / next to that plant),
//   - any vertex touching the lens (small sphere), and
//   - geometry inside a cylinder around the camera → focus line, in front of
//     the focus (a see-through hole to the subject).
// The dissolve is a stable per-pixel dither (interleaved gradient noise on
// gl_FragCoord), so no blending / sorting is needed and it works for
// BatchedMesh, InstancedMesh and plain meshes alike. Shadow / depth passes
// use their own depth materials and never fade, so shadows stay put.
//
// Opt-in (set by the builders): material.userData.foliage = true or
// material.userData.fadeNear = true. Materials with wind sway or the
// FoliageMaterial class are treated as foliage too.

import * as THREE from 'three';

/** Shared uniforms (one set, referenced by every patched program). */
export const fadeUniforms = {
  uFadeCam: { value: new THREE.Vector3(0, -1e4, 0) },
  /** Point the camera looks at (slightly above the ground). */
  uFadeFocus: { value: new THREE.Vector3(0, -1e4, 0) },
  /**
   * x: per-instance radius (horizontal camera distance to the instance origin / trunk),
   * y: line radius at the camera, z: line radius at the focus, w: strength 0..1.
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
  // whole instance: the camera stands inside / right next to this plant (uniform
  // dissolve, so a canopy around the camera never shows a stippled ring)
  float instF = ( 1.0 - smoothstep( uFadeParams.x * 0.85, uFadeParams.x, length( uFadeCam.xz - o.xz ) ) )
              * ( 1.0 - smoothstep( o.y + 12.0, o.y + 16.0, uFadeCam.y ) );
  // per vertex: anything touching the lens
  vec3 ap = p - uFadeCam;
  float lensF = 1.0 - smoothstep( uFadeMargin.y * 0.8, uFadeMargin.y, length( ap ) );
  // per vertex: a cylinder around the view line, in front of the focus
  vec3 ab = uFadeFocus - uFadeCam;
  float len = max( length( ab ), 1e-3 );
  vec3 dir = ab / len;
  float t = dot( ap, dir );
  float r = length( ap - dir * t );
  float tEnd = len - uFadeMargin.x;
  float along = smoothstep( -1.0, 0.5, t ) * ( 1.0 - smoothstep( tEnd - 1.0, tEnd, t ) );
  float rad = mix( uFadeParams.y, uFadeParams.z, clamp( t / len, 0.0, 1.0 ) );
  float lineF = along * ( 1.0 - smoothstep( rad * 0.75, rad, r ) );
  return max( max( instF, lensF ), lineF ) * uFadeParams.w;
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
`;

// interleaved gradient noise: a stable, fine, grid-free dither
const FADE_FRAG = /* glsl */ `
if ( vPropFade > 0.003 ) {
  float fdN = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  if ( fdN < vPropFade ) discard;
}
`;

interface FadeData {
  prev: THREE.Material['onBeforeCompile'];
  prevKey: () => string;
}

const fadeData = new WeakMap<THREE.Material, FadeData>();

/** Does this material want the near-camera fade? */
export function wantsFade(m: THREE.Material): boolean {
  const u = m.userData ?? {};
  if (u.fadeNear === false || u.foliage === false) return false;
  if (u.foliage === true || u.fadeNear === true) return true;
  if ((m as { isFoliageMaterial?: boolean }).isFoliageMaterial) return true;
  // fallback until every builder sets the flags: vegetation materials of the nature module
  if (/^nature\/(leaf|bark|stem)/.test(m.name) && !/endgrain|soil/.test(m.name)) return true;
  const s = u.sway;
  return typeof s === 'number' && s > 0;
}

/** Patch a material with the near-camera fade (idempotent). Apply after the wind patch. */
export function applyFade(m: THREE.Material): void {
  if (fadeData.has(m)) return;
  const prev = m.onBeforeCompile;
  const prevKeyFn = m.customProgramCacheKey;
  const data: FadeData = { prev, prevKey: prevKeyFn };
  fadeData.set(m, data);
  m.onBeforeCompile = function (shader, renderer) {
    prev.call(this, shader, renderer);
    shader.uniforms.uFadeCam = fadeUniforms.uFadeCam;
    shader.uniforms.uFadeFocus = fadeUniforms.uFadeFocus;
    shader.uniforms.uFadeParams = fadeUniforms.uFadeParams;
    shader.uniforms.uFadeMargin = fadeUniforms.uFadeMargin;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FADE_PARS_VERT}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${FADE_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FADE_PARS_FRAG}`)
      .replace('#include <clipping_planes_fragment>', `${FADE_FRAG}\n#include <clipping_planes_fragment>`);
  };
  // resolve the previous key now: the default key is the hook's source text,
  // which would otherwise read the wrapper below for every material
  const prevKey = prevKeyFn.call(m);
  m.customProgramCacheKey = () => `${prevKey}|propfade`;
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
  // strength: full when close, off beyond maxDist (smooth so nothing pops)
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
