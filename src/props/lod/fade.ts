// Near-camera fade for vegetation. When the camera is close to the ground
// (follow mode, close zoom), tree canopies between the camera and what it
// looks at hide the view. Flagged materials get a vertex/fragment patch that
// removes
//   - whole instances whose origin (trunk) is within a few metres of the
//     camera horizontally (the camera stands in / next to that plant),
//   - in close views, whole trees that the view hole would touch (one
//     decision per tree, see below),
//   - any vertex touching the lens (small sphere), and
//   - geometry inside a cylinder around the camera → focus line, in front of
//     the focus (a see-through hole to the subject).
// Four flavours, chosen by material.userData (see registry.ts):
//   foliage + crownFade   tree foliage (leaf cards / fronds with crown data);
//   fadeNear + crownFade  a tree's bark (trunk, limbs, canes with crown data);
//                         both: the tree is ONE decision. When the camera →
//                         focus segment passes through its crown (grown by the
//                         hole radius, so whenever the hole would touch a leaf)
//                         or among its limbs (a cone around the trunk axis
//                         widening to the crown), and the tree stands clearly
//                         between the camera and the subject (not the tree the
//                         camera looks at: its trunk near the focus, or its
//                         crown centre near or beyond the subject), the crown first
//                         thins card by card (at most half its leaves, the
//                         bark stays whole) over a few metres of zoom, then
//                         leaves, limbs and trunk go together, so no bare
//                         trunk, cut limb or floating stub stays in front of
//                         the subject;
//   foliage               other leaves, fronds, stems: instance, lens and hole terms;
//   fadeNear              other solid parts (cactus): the whole-instance term, plus
//                         the view hole on limbs (above LIMB_Y and beyond the
//                         material's userData.trunkRadius from the trunk axis;
//                         the trunk stays).
// Nothing is ever half transparent: without TAA a partly faded leaf card
// reads as a flat translucent sheet (MSAA coverage) or a stipple (dither).
// Every card / limb has a dissolve rank shared by its vertices (nature/geo.ts
// addCrownFade); a piece is drawn while the fade stays below its rank, so a
// crown thins out card by card and a hole gets a ragged edge of whole leaves.
// Bark ranks follow the branching (outer limbs go first, the trunk last), so a
// half-dissolved tree never holds a limb whose parent is gone. Parts without
// ranks switch at 0.5. No blending / sorting is needed and it works for
// BatchedMesh, InstancedMesh and plain meshes alike. Shadow / depth passes use
// their own depth materials and never fade, so shadows stay put, except the
// shadow a tree casts through its swaying depth material (foliage, bamboo
// canes; wind.ts windDepthMaterial + fadeDepthPatch): a tree removed within
// ~12 m of the camera takes it along, so no crown-shaped shadow lies on empty
// ground in a close view. Still bark casts from the shared shadow-only
// batches (props/layer.ts), whose depth material (casterDepthMaterial) makes
// the same decision for every piece that carries crown data (the rest of
// those batches carries zero crown data and never fades).
//
// While the camera follows a subject (setFollowCut, driven from the view's
// follow state) two more cuts run, both off in free-camera play:
//   - crowns the camera → subject line crosses in its far 60 % go, tree by
//     tree as above (thinning, then whole), up to FOLLOW_CUT_D of zoom, with
//     their shadows: a followed animal is not lost behind a leaf wall;
//   - at the closest follow zooms, fence pieces and small structures standing
//     on that line near the camera (OCCLUDER_R, or the near OCCLUDER_SHARE of
//     the line) and at least a metre in front of the subject dissolve as
//     whole pieces (applyOccluderCut: an instance-wide decision, dithered over
//     a short band so a piece does not pop).

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
  /** Strength of the follow cut of crowns on the camera → subject line (0..1; 0 = free camera). */
  uFadeFollow: { value: 0 },
  /** Strength of the near-camera occluder cut (0..1; closest follow zooms only). */
  uFadeOccl: { value: 0 },
};

/** Height above the trunk base (m) from which the view hole cuts solid parts (limbs, not the trunk). */
export const LIMB_Y = 2.5;
/** Default distance from the trunk axis (m) inside which solid parts are trunk, never cut. */
export const TRUNK_R = 0.9;
/** Horizontal trunk → focus distance (m) within which a tree is the subject's own and never cut (fully cut 1 m farther). */
export const TREE_KEEP_R = 3;
/** Per-tree cut strength (0..1) at which a thinned tree goes as a whole. */
export const TREE_GONE = 0.6;
/** Horizontal camera → trunk distance (m) within which a removed tree's foliage shadow goes too (fully back 4 m farther). */
export const TREE_SHADOW_R = 12;
/** Camera → subject distance (m) up to which the follow cut removes crowns on the line (fully back 3 m farther). */
export const FOLLOW_CUT_D = 45;
/** Hole radius (m) the follow cut grows a crown by: only crowns the line really crosses go. */
const FOLLOW_GROW = 0.5;
/** Share of the camera → subject line, from the camera, where the follow cut leaves crowns alone (they are below the line). */
const FOLLOW_SKIP = 0.4;
/** Camera → subject distance (m) up to which occluders on the line are cut (fully back 3 m farther). */
export const OCCLUDER_D = 11;
/** Horizontal camera → piece distance (m) within which a fence piece or small structure on the line is cut… */
export const OCCLUDER_R = 4;
/** … or within this share of the horizontal camera → subject distance, if farther (a feeder in front of a giraffe followed from 8 m). */
export const OCCLUDER_SHARE = 0.65;
/** Horizontal distance (m) of a piece's origin from the camera → subject line within which it counts as on the line. */
export const OCCLUDER_SIDE = 1.4;

const FADE_PARS_VERT = /* glsl */ `
uniform vec3 uFadeCam;
uniform vec3 uFadeFocus;
uniform vec4 uFadeParams;
uniform vec2 uFadeMargin;
uniform float uFadeCrown;
uniform float uFadeFollow;
uniform float uFadeOccl;
varying float vPropFade;
varying float vPropRank;
#ifdef PROP_FADE_CROWN
// crown ellipsoid centre (model space, cm) + the piece's dissolve rank (0..255)
attribute vec4 aCrown;
// crown radii (cm): horizontal, vertical (0: no crown, never cut as a tree)
attribute vec2 aCrownR;
// 1 when the camera → line-end segment passes through this tree: through its
// crown grown by grow (the view hole's radius there), or among its limbs, a
// cone around the trunk axis (base → crown centre) that widens from a quarter
// of the crown radius to all of it. Built from instance data only, so every
// vertex of the instance gets the same value: the tree goes as a whole.
float propTreeF( mat4 M, vec3 lineEnd, float grow ) {
  mat3 R = mat3( M );
  float s2 = dot( R[ 0 ], R[ 0 ] ); // uniform instance scale²
  // both ends in model space (m)
  vec3 a = transpose( R ) * ( uFadeCam - M[ 3 ].xyz ) / s2;
  vec3 b = transpose( R ) * ( lineEnd - M[ 3 ].xyz ) / s2;
  vec3 c = aCrown.xyz * 0.01;
  vec2 cr = aCrownR * 0.01;
  float g = grow * inversesqrt( s2 );
  // crown, scaled to a unit sphere
  vec3 inv = 1.0 / ( vec3( cr.x, cr.y, cr.x ) + g );
  vec3 ea = ( a - c ) * inv;
  vec3 eab = ( b - a ) * inv;
  float t = clamp( -dot( ea, eab ) / max( dot( eab, eab ), 1e-6 ), 0.0, 1.0 );
  float crownD = length( ea + eab * t );
  // limbs: closest points of the segment a + ab·s and the axis c·u (s, u in 0..1)
  vec3 ab = b - a;
  float A = max( dot( ab, ab ), 1e-6 );
  float E = max( dot( c, c ), 1e-6 );
  float B = dot( ab, c );
  float s = clamp( ( B * dot( c, a ) - dot( ab, a ) * E ) / max( A * E - B * B, 1e-6 ), 0.0, 1.0 );
  float u = clamp( ( B * s + dot( c, a ) ) / E, 0.0, 1.0 );
  s = clamp( ( B * u - dot( ab, a ) ) / A, 0.0, 1.0 );
  float limbD = length( a + ab * s - c * u ) / ( cr.x * mix( 0.25, 1.0, u ) + g );
  return ( 1.0 - smoothstep( 0.8, 1.0, min( crownD, limbD ) ) ) * step( 1.0, aCrownR.y );
}
#endif
#ifdef PROP_FADE_CROWN
// per-tree cut strength → fade: the crown thins card by card over a wide band
// (≈2-3 m of zoom), at most by half while the bark stays whole, then the whole
// tree goes at once: further thinning would leave a bare trunk and main limbs
float propTreeFade( float tree ) {
#ifdef PROP_FADE_BARK
  return step( ${TREE_GONE.toFixed(2)}, tree );
#else
  return tree < ${TREE_GONE.toFixed(2)} ? 0.5 * smoothstep( 0.15, ${TREE_GONE.toFixed(2)}, tree ) : 1.0;
#endif
}
#endif
#ifdef PROP_FADE_OCCLUDER
// a fence piece or small structure (origin o) standing near the camera on the
// camera → subject line, in front of the subject; one value per instance
float propOccluderAt( vec3 o ) {
  vec2 co = o.xz - uFadeCam.xz;
  vec2 cs = uFadeFocus.xz - uFadeCam.xz;
  float len = max( length( cs ), 1e-3 );
  vec2 dir = cs / len;
  float t = dot( co, dir );
  float side = abs( co.x * dir.y - co.y * dir.x );
  // narrow bands: a piece is in or out; the dither only softens the switch
  float nearR = max( ${OCCLUDER_R.toFixed(2)}, ${OCCLUDER_SHARE.toFixed(2)} * len );
  float near = 1.0 - smoothstep( nearR - 0.25, nearR, length( co ) );
  float onLine = ( 1.0 - smoothstep( ${(OCCLUDER_SIDE - 0.15).toFixed(2)}, ${OCCLUDER_SIDE.toFixed(2)}, side ) )
               * smoothstep( -0.3, 0.0, t ) * ( 1.0 - smoothstep( len - 1.3, len - 1.0, t ) );
  return near * onLine * uFadeOccl;
}
#endif
// p = world vertex, M = instance matrix (origin = trunk base / object origin)
float propFadeAt( vec3 p, mat4 M ) {
  vec3 o = M[ 3 ].xyz;
#ifdef PROP_FADE_OCCLUDER
  return propOccluderAt( o );
#else
#ifdef PROP_FADE_TREES_ONLY
  // shared shadow casters: only pieces with crown data (tree bark) go
  if ( aCrownR.y < 1.0 ) return 0.0;
#endif
  float k = uFadeParams.w;
  // whole instance: the camera stands inside / right next to this plant
  float ir = max( uFadeParams.x * k, 1e-3 );
  float instF = ( 1.0 - smoothstep( ir * 0.85, ir, length( uFadeCam.xz - o.xz ) ) )
              * ( 1.0 - smoothstep( o.y + 12.0, o.y + 16.0, uFadeCam.y ) ) * step( 1e-4, k );
  // a cylinder around the view line, in front of the focus
  vec3 ab = uFadeFocus - uFadeCam;
  float len = max( length( ab ), 1e-3 );
  vec3 dir = ab / len;
  float tEnd = len - uFadeMargin.x;
#ifdef PROP_FADE_CROWN
  // a tree: one decision for the whole instance, with the hole's radius where
  // the line passes the crown
  float tc = dot( ( M * vec4( aCrown.xyz * 0.01, 1.0 ) ).xyz - uFadeCam, dir ) / len;
  float grow = mix( uFadeParams.y, uFadeParams.z, clamp( tc, 0.0, 1.0 ) ) * k;
  // the tree the camera looks at stays: its trunk stands within TREE_KEEP_R
  // of the focus, or its crown centre is not clearly between the camera and
  // the subject (within TREE_KEEP_R of the line's end). A fixed radius, not
  // one scaled by the crown: acacia and oak crowns spread 6-9 m, which would
  // also keep a tree standing well in front of the subject (a wall of limbs)
  float between = smoothstep( ${TREE_KEEP_R.toFixed(1)}, ${(TREE_KEEP_R + 1).toFixed(1)}, length( o.xz - uFadeFocus.xz ) )
                * ( 1.0 - smoothstep( -0.04, 0.04, tc - 1.0 + ${TREE_KEEP_R.toFixed(1)} / len ) );
  // beyond the close views the follow cut grows crowns by a small radius only
  float hit = propTreeF( M, uFadeCam + dir * max( tEnd, 0.0 ), mix( grow, ${FOLLOW_GROW.toFixed(2)}, uFadeFollow * ( 1.0 - uFadeCrown ) ) ) * between;
  float fade = propTreeFade( max( instF, hit * uFadeCrown ) );
#ifdef PROP_FADE_SHADOW
  // its shadow goes with it only near the camera (close views)
  fade *= 1.0 - smoothstep( ${TREE_SHADOW_R.toFixed(1)}, ${(TREE_SHADOW_R + 4).toFixed(1)}, length( uFadeCam.xz - o.xz ) );
#endif
  // following: crowns the line crosses beyond its first stretch (nearer ones
  // stand below the line), at any zoom up to FOLLOW_CUT_D, shadow included
  return max( fade, propTreeFade( hit * uFadeFollow * smoothstep( ${(FOLLOW_SKIP - 0.05).toFixed(2)}, ${(FOLLOW_SKIP + 0.05).toFixed(2)}, tc ) ) );
#else
  vec3 ap = p - uFadeCam;
  float t = dot( ap, dir );
  float r = length( ap - dir * t );
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
  return max( max( instF, lensF ), lineF );
#endif
#endif
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
if ( PROP_FADE_ON ) {
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

// occluders: an instance-wide value against a screen-space threshold
// (interleaved gradient noise), so a piece dissolves evenly as a whole; the
// threshold spans only the middle of the range, so a piece that is nearly in
// or out is whole or gone, never a sprinkle of specks
const OCCLUDER_DISCARD = /* glsl */ `
if ( vPropFade > 0.3 + 0.4 * fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) ) discard;
`;

interface FadeData {
  prev: THREE.Material['onBeforeCompile'];
  prevKey: () => string;
}

const fadeData = new WeakMap<THREE.Material, FadeData>();

export type FadeMode = 'crown' | 'foliage' | 'solid' | 'crownSolid';

/** How a material fades near the camera (null = never), from its userData flags. */
export function fadeModeOf(m: THREE.Material): FadeMode | null {
  const u = m.userData ?? {};
  if (u.foliage === true) return u.crownFade === true ? 'crown' : 'foliage';
  if (u.fadeNear === true) return u.crownFade === true ? 'crownSolid' : 'solid';
  return null;
}

/**
 * Patch a material with the near-camera fade (idempotent). Apply after the
 * wind patch. 'crown' and 'crownSolid' materials need the aCrown / aCrownR
 * attributes on every geometry they draw (nature/geo.ts addCrownFade).
 */
export function applyFade(m: THREE.Material, mode: FadeMode): void {
  if (fadeData.has(m)) return;
  const prev = m.onBeforeCompile;
  const prevKeyFn = m.customProgramCacheKey;
  const data: FadeData = { prev, prevKey: prevKeyFn };
  fadeData.set(m, data);
  const trunkR = typeof m.userData.trunkRadius === 'number' ? m.userData.trunkRadius : TRUNK_R;
  // a tree's leaves and bark share the per-tree decision; the trunk radius
  // only matters to other solid parts, which the hole cuts limb by limb
  const solid = mode === 'solid';
  const define =
    (solid ? `#define PROP_FADE_SOLID\n#define PROP_TRUNK_R ${trunkR.toFixed(2)}\n` : '') +
    (mode === 'crown' || mode === 'crownSolid' ? `#define PROP_FADE_CROWN\n${FOLLOW_ON}` : FREE_ON) +
    (mode === 'crownSolid' ? '#define PROP_FADE_BARK\n' : '');
  m.onBeforeCompile = function (shader, renderer) {
    prev.call(this, shader, renderer);
    patchFadeShader(shader, define);
  };
  // resolve the previous key now: the default key is the hook's source text,
  // which would otherwise read the wrapper below for every material
  const prevKey = prevKeyFn.call(m);
  m.customProgramCacheKey = () => `${prevKey}|propfade-${mode}${solid ? trunkR : ''}`;
  m.needsUpdate = true;
}

/** When a patched vertex runs the fade at all: trees also while the follow cut is on. */
const FREE_ON = '#define PROP_FADE_ON uFadeParams.w > 0.0\n';
const FOLLOW_ON = '#define PROP_FADE_ON ( uFadeParams.w > 0.0 || uFadeFollow > 0.0 )\n';

function patchFadeShader(shader: THREE.WebGLProgramParametersWithUniforms, define: string, discard = FADE_DISCARD): void {
  shader.uniforms.uFadeCam = fadeUniforms.uFadeCam;
  shader.uniforms.uFadeFocus = fadeUniforms.uFadeFocus;
  shader.uniforms.uFadeParams = fadeUniforms.uFadeParams;
  shader.uniforms.uFadeMargin = fadeUniforms.uFadeMargin;
  shader.uniforms.uFadeCrown = fadeUniforms.uFadeCrown;
  shader.uniforms.uFadeFollow = fadeUniforms.uFadeFollow;
  shader.uniforms.uFadeOccl = fadeUniforms.uFadeOccl;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${define}${FADE_PARS_VERT}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${FADE_VERT}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FADE_PARS_FRAG}`)
    .replace('#include <clipping_planes_fragment>', `${discard}\n#include <clipping_planes_fragment>`);
}

const occluderData = new WeakSet<THREE.Material>();

/**
 * Patch a fence or structure material with the near-camera occluder cut
 * (idempotent; see the header): while following at the closest zooms, a piece
 * near the camera on the camera → subject line dissolves as a whole. Apply
 * last. Its shadow stays (the piece is still there, only not drawn).
 */
export function applyOccluderCut(m: THREE.Material): void {
  if (occluderData.has(m) || fadeData.has(m)) return;
  occluderData.add(m);
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey.call(m);
  m.onBeforeCompile = function (shader, renderer) {
    prev.call(this, shader, renderer);
    patchFadeShader(shader, '#define PROP_FADE_OCCLUDER\n#define PROP_FADE_ON uFadeOccl > 0.0\n', OCCLUDER_DISCARD);
  };
  m.customProgramCacheKey = () => `${prevKey}|propoccl`;
  m.needsUpdate = true;
}

/**
 * Shadow (depth) shader patch for a tree's foliage, or bark that casts from
 * its own batch (swaying canes): the per-tree decision of the visible pass,
 * so a tree removed near the camera takes its shadow along (see the header).
 * Null for every other material, whose shadows never fade. Apply after the
 * depth material's wind patch; key the depth program by `fadeDepthKey`.
 */
export function fadeDepthPatch(m: THREE.Material): ((shader: THREE.WebGLProgramParametersWithUniforms) => void) | null {
  const mode = fadeModeOf(m);
  if (mode !== 'crown' && mode !== 'crownSolid') return null;
  const define = `#define PROP_FADE_CROWN\n#define PROP_FADE_SHADOW\n${FOLLOW_ON}${mode === 'crownSolid' ? '#define PROP_FADE_BARK\n' : ''}`;
  return (shader) => patchFadeShader(shader, define);
}

let casterDepth: THREE.MeshDepthMaterial | null = null;

/**
 * Depth material of the shared shadow-only batches (props/layer.ts), where
 * still bark casts with buildings, rocks and logs: pieces with crown data
 * (a tree's trunk and limbs) take the visible bark's per-tree decision, so a
 * tree removed near the camera leaves no trunk or limb shadow; pieces with
 * zero crown data never fade. Every geometry drawn with it needs aCrown /
 * aCrownR (zero-filled where there is no crown).
 */
export function casterDepthMaterial(): THREE.MeshDepthMaterial {
  if (!casterDepth) {
    const d = new THREE.MeshDepthMaterial();
    const define = `#define PROP_FADE_CROWN\n#define PROP_FADE_SHADOW\n#define PROP_FADE_BARK\n#define PROP_FADE_TREES_ONLY\n${FOLLOW_ON}`;
    d.onBeforeCompile = (shader) => patchFadeShader(shader, define);
    d.customProgramCacheKey = () => 'props-caster-depth|treeshadow';
    casterDepth = d;
  }
  return casterDepth;
}

/** Program cache key suffix matching `fadeDepthPatch` ('' when it does not apply). */
export function fadeDepthKey(m: THREE.Material): string {
  const mode = fadeModeOf(m);
  return mode === 'crown' || mode === 'crownSolid' ? `|treeshadow-${mode}` : '';
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

let following = false;
const followSubject = new THREE.Vector3();
/** Seconds over which the follow cuts hand crowns and occluders back after following ends (thinning, no pop). */
const FOLLOW_RELEASE_S = 0.6;
let followWeight = 0;

/**
 * Follow mode of the cuts (see the header): call every frame with the
 * followed subject's position (its feet, world space) while the camera
 * follows one, null otherwise (free-camera rules only). While following, the
 * cuts aim at the subject, not at the ground point at the screen centre,
 * which lies well beyond a subject framed below the centre. Pass the frame's
 * `dt` so the cuts hand back over FOLLOW_RELEASE_S after following ends;
 * without it null switches them off at once.
 */
export function setFollowCut(subject: { x: number; y: number; z: number } | null, dt = Infinity): void {
  if (subject) followSubject.set(subject.x, subject.y, subject.z);
  followWeight = subject ? 1 : Math.max(0, followWeight - dt / FOLLOW_RELEASE_S);
  following = followWeight > 0;
}

/**
 * Update the shared fade uniforms from the camera and the point it looks at.
 * `focus` is the ground point at the screen centre.
 */
export function updateFade(camPos: THREE.Vector3, focus: THREE.Vector3, enabled: boolean, tuning: FadeTuning = { maxDist: 42 }): void {
  const u = fadeUniforms;
  const follow = enabled && following;
  const aim = follow ? followSubject : focus;
  const d = camPos.distanceTo(aim);
  // hole size: full when close, shrinking to nothing by maxDist (smooth so nothing pops)
  const k = enabled ? 1 - THREE.MathUtils.smoothstep(d, tuning.maxDist * 0.7, tuning.maxDist) : 0;
  u.uFadeParams.value.w = k;
  // whole trees only in close views: from mid distance a tree on the view
  // line is part of the picture (and never half dissolved, see FADE_PARS_VERT)
  u.uFadeCrown.value = enabled ? 1 - THREE.MathUtils.smoothstep(d, tuning.maxDist * 0.55, tuning.maxDist * 0.75) : 0;
  u.uFadeFollow.value = follow ? followWeight * (1 - THREE.MathUtils.smoothstep(d, FOLLOW_CUT_D, FOLLOW_CUT_D + 3)) : 0;
  u.uFadeOccl.value = follow ? followWeight * (1 - THREE.MathUtils.smoothstep(d, OCCLUDER_D, OCCLUDER_D + 3)) : 0;
  if (k <= 0 && u.uFadeFollow.value <= 0) return;
  u.uFadeCam.value.copy(camPos);
  // aim at the subject's body, not its feet
  _dir.copy(aim);
  _dir.y += 1.1;
  u.uFadeFocus.value.copy(_dir);
  u.uFadeParams.value.x = THREE.MathUtils.clamp(d * 0.3, 2.2, 5.5);
  u.uFadeMargin.value.y = THREE.MathUtils.clamp(d * 0.12, 1.0, 2.2);
  u.uFadeParams.value.y = THREE.MathUtils.clamp(d * 0.08, 1.0, 2.2);
  u.uFadeParams.value.z = THREE.MathUtils.clamp(d * 0.16, 1.8, 4.0);
  u.uFadeMargin.value.x = THREE.MathUtils.clamp(d * 0.06, 0.8, 2.5);
}
