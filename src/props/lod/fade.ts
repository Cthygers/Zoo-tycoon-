// Near-camera fade for vegetation. When the camera is close to the ground
// (follow mode, close zoom), tree canopies between the camera and what it
// looks at hide the view. Flagged materials get a vertex/fragment patch that
// removes
//   - whole instances whose origin (trunk) is within a few metres of the
//     camera horizontally (the camera stands in / next to that plant),
//   - whole tree crowns that the camera → focus segment passes through
//     (crown ellipsoid baked per vertex, see nature/geo.ts addCrownFade),
//   - any vertex touching the lens (small sphere), and
//   - geometry inside a cylinder around the camera → focus line, in front of
//     the focus (a see-through hole to the subject).
// Three flavours, chosen by material.userData (see registry.ts):
//   crownFade = true  tree foliage (leaf cards / fronds with crown data): all terms;
//   foliage = true    other leaves, fronds, stems: all but the crown term;
//   fadeNear = true   solid parts (bark, cactus): the whole-instance term, plus
//                     the view hole on limbs (above LIMB_Y and beyond the
//                     material's userData.trunkRadius from the trunk axis;
//                     the trunk stays).
// Nothing is ever half transparent: without TAA a partly faded leaf card
// reads as a flat translucent sheet (MSAA coverage) or a stipple (dither).
// Every card has a dissolve rank shared by its vertices; a card is drawn
// while the fade stays below its rank, so a crown thins out card by card and
// a hole gets a ragged edge of whole leaves. Parts without ranks switch at 0.5.
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
  /** Strength of the crown term (0..1): only close views remove whole crowns. */
  uFadeCrown: { value: 0 },
};

/** Height above the trunk base (m) from which the view hole cuts solid parts (limbs, not the trunk). */
export const LIMB_Y = 2.5;
/** Default distance from the trunk axis (m) inside which solid parts are trunk, never cut. */
export const TRUNK_R = 0.9;

const FADE_PARS_VERT = /* glsl */ `
uniform vec3 uFadeCam;
uniform vec3 uFadeFocus;
uniform vec4 uFadeParams;
uniform vec2 uFadeMargin;
uniform float uFadeCrown;
varying float vPropFade;
varying float vPropRank;
#ifdef PROP_FADE_CROWN
// crown ellipsoid centre (model space, cm) + the card's dissolve rank (0..255)
attribute vec4 aCrown;
// crown radii (cm): horizontal, vertical
attribute vec2 aCrownR;
// 1 when the camera → line-end segment passes through this instance's crown
// (same value on every vertex of the instance: the crown goes as a whole)
float propCrownF( mat4 M, vec3 lineEnd ) {
  mat3 R = mat3( M );
  float s2 = dot( R[ 0 ], R[ 0 ] ); // uniform instance scale²
  vec3 inv = 100.0 / vec3( aCrownR.x, aCrownR.y, aCrownR.x );
  vec3 c = aCrown.xyz * 0.01;
  // both ends in model space, scaled so the crown is a unit sphere
  vec3 a = ( transpose( R ) * ( uFadeCam - M[ 3 ].xyz ) / s2 - c ) * inv;
  vec3 b = ( transpose( R ) * ( lineEnd - M[ 3 ].xyz ) / s2 - c ) * inv;
  vec3 ab = b - a;
  float t = clamp( -dot( a, ab ) / max( dot( ab, ab ), 1e-6 ), 0.0, 1.0 );
  return ( 1.0 - smoothstep( 0.9, 1.0, length( a + ab * t ) ) ) * uFadeCrown;
}
#endif
// p = world vertex, M = instance matrix (origin = trunk base / object origin)
float propFadeAt( vec3 p, mat4 M ) {
  vec3 o = M[ 3 ].xyz;
  float k = uFadeParams.w;
  // whole instance: the camera stands inside / right next to this plant
  float ir = uFadeParams.x * k;
  float instF = ( 1.0 - smoothstep( ir * 0.85, ir, length( uFadeCam.xz - o.xz ) ) )
              * ( 1.0 - smoothstep( o.y + 12.0, o.y + 16.0, uFadeCam.y ) );
  // a cylinder around the view line, in front of the focus
  vec3 ap = p - uFadeCam;
  vec3 ab = uFadeFocus - uFadeCam;
  float len = max( length( ab ), 1e-3 );
  vec3 dir = ab / len;
  float t = dot( ap, dir );
  float r = length( ap - dir * t );
  float tEnd = len - uFadeMargin.x;
  float along = smoothstep( -0.5, 0.0, t ) * ( 1.0 - smoothstep( tEnd - 0.5, tEnd, t ) );
  float rad = mix( uFadeParams.y, uFadeParams.z, clamp( t / len, 0.0, 1.0 ) ) * k;
  float lineF = along * ( 1.0 - smoothstep( rad * 0.85, rad, r ) );
#ifdef PROP_FADE_SOLID
  // limbs only: the trunk (below LIMB_Y or near its axis) stays
  float limb = smoothstep( ${(LIMB_Y - 0.2).toFixed(2)}, ${(LIMB_Y + 0.2).toFixed(2)}, p.y - o.y ) * smoothstep( PROP_TRUNK_R, PROP_TRUNK_R + 0.3, length( p.xz - o.xz ) );
  return max( instF, lineF * limb );
#else
  // anything touching the lens
  float lr = uFadeMargin.y * k;
  float lensF = 1.0 - smoothstep( lr * 0.85, lr, length( ap ) );
  float f = max( max( instF, lensF ), lineF );
  #ifdef PROP_FADE_CROWN
  f = max( f, propCrownF( M, uFadeCam + dir * max( tEnd, 0.0 ) ) );
  #endif
  return f;
#endif
}
`;

const FADE_VERT = /* glsl */ `
vPropFade = 0.0;
#ifdef PROP_FADE_CROWN
vPropRank = ( aCrown.w + 0.5 ) / 256.0;
#else
vPropRank = 0.5;
#endif
if ( uFadeParams.w > 0.0 ) {
  #if defined( USE_BATCHING )
    mat4 fdM = modelMatrix * batchingMatrix;
  #elif defined( USE_INSTANCING )
    mat4 fdM = modelMatrix * instanceMatrix;
  #else
    mat4 fdM = modelMatrix;
  #endif
  vPropFade = propFadeAt( ( fdM * vec4( transformed, 1.0 ) ).xyz, fdM );
}
`;

const FADE_PARS_FRAG = /* glsl */ `
varying float vPropFade;
varying float vPropRank;
`;

// all or nothing per fragment, decided before any shading work: the rank is
// the same on a whole card, so instance-wide terms drop whole cards
const FADE_DISCARD = /* glsl */ `
if ( vPropFade > vPropRank ) discard;
`;

interface FadeData {
  prev: THREE.Material['onBeforeCompile'];
  prevKey: () => string;
}

const fadeData = new WeakMap<THREE.Material, FadeData>();

export type FadeMode = 'crown' | 'foliage' | 'solid';

/** How a material fades near the camera (null = never), from its userData flags. */
export function fadeModeOf(m: THREE.Material): FadeMode | null {
  const u = m.userData ?? {};
  if (u.foliage === true) return u.crownFade === true ? 'crown' : 'foliage';
  if (u.fadeNear === true) return 'solid';
  return null;
}

/**
 * Patch a material with the near-camera fade (idempotent). Apply after the
 * wind patch. 'crown' materials need the aCrown / aCrownR attributes on every
 * geometry they draw (nature/geo.ts addCrownFade).
 */
export function applyFade(m: THREE.Material, mode: FadeMode): void {
  if (fadeData.has(m)) return;
  const prev = m.onBeforeCompile;
  const prevKeyFn = m.customProgramCacheKey;
  const data: FadeData = { prev, prevKey: prevKeyFn };
  fadeData.set(m, data);
  const trunkR = typeof m.userData.trunkRadius === 'number' ? m.userData.trunkRadius : TRUNK_R;
  const define =
    mode === 'solid' ? `#define PROP_FADE_SOLID\n#define PROP_TRUNK_R ${trunkR.toFixed(2)}\n` : mode === 'crown' ? '#define PROP_FADE_CROWN\n' : '';
  m.onBeforeCompile = function (shader, renderer) {
    prev.call(this, shader, renderer);
    shader.uniforms.uFadeCam = fadeUniforms.uFadeCam;
    shader.uniforms.uFadeFocus = fadeUniforms.uFadeFocus;
    shader.uniforms.uFadeParams = fadeUniforms.uFadeParams;
    shader.uniforms.uFadeMargin = fadeUniforms.uFadeMargin;
    shader.uniforms.uFadeCrown = fadeUniforms.uFadeCrown;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${define}${FADE_PARS_VERT}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${FADE_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FADE_PARS_FRAG}`)
      .replace('#include <clipping_planes_fragment>', `${FADE_DISCARD}\n#include <clipping_planes_fragment>`);
  };
  // resolve the previous key now: the default key is the hook's source text,
  // which would otherwise read the wrapper below for every material
  const prevKey = prevKeyFn.call(m);
  m.customProgramCacheKey = () => `${prevKey}|propfade-${mode}${mode === 'solid' ? trunkR : ''}`;
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
  // whole crowns only in close views: from mid distance a crown on the view
  // line is part of the picture (the hole thins it instead)
  u.uFadeCrown.value = enabled ? 1 - THREE.MathUtils.smoothstep(d, tuning.maxDist * 0.55, tuning.maxDist * 0.75) : 0;
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
