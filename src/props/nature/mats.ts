// Materials for nature props.
//
//  FoliageMaterial  alpha-tested, double-sided leaf cards. Back faces keep
//                   the (crown-bent) vertex normal instead of flipping it, so
//                   a crown shades as one soft volume, and every direct light
//                   adds a cheap translucency term (light through leaves seen
//                   against the sun + wrap lighting on the shadowed side; the
//                   light colour already includes its shadow).
//  RockMaterial     triplanar (object-space) albedo + derivative bump from a
//                   texture's alpha height, tinted by vertex colours; an
//                   optional per-vertex `aSurf` attribute (0..1) blends to a
//                   second roughness (snow on ice, wet moss, polished faces).
//  BarkMaterial     standard material with albedo + normal maps and
//                   vertex-colour tint / AO; at night it takes part of the
//                   moonlit ground's neutral light (no blue-lit trunks).
//
// Shader patches live in prototype methods so Material.clone() (used for
// ghost previews) keeps them; the constructors also make three honour
// envMapIntensity under scene.environment (useEnvMapIntensity), which clones
// get by running the constructor. Every material / texture created here is
// cached and released by disposeNatureResources().

import * as THREE from 'three';
import type { QualityLevel, QualitySettings } from '../../core/contracts';
import { useEnvMapIntensity } from '../../render/envIntensity';
import { nightGroundLight, nightGroundMark } from '../../render/groundMaterial';
import { clearNoiseCache } from './tex';

// ---------------------------------------------------------------------------
// Quality

/** Detail tier of the build in progress ('medium' outside withQuality). */
let quality: QualityLevel = 'medium';

/** Current detail tier. */
export function natureQuality(): QualityLevel {
  return quality;
}

/**
 * Run a builder at the tier of `q` ('medium' when q is undefined). Builders
 * read the tier through detail() / texLow().
 */
export function withQuality<T>(q: QualitySettings | QualityLevel | undefined, fn: () => T): T {
  const level = typeof q === 'string' ? q : q?.level;
  if (!level || level === quality) return fn();
  const prev = quality;
  quality = level;
  try {
    return fn();
  } finally {
    quality = prev;
  }
}

/** Multipliers for the current tier. */
export function detail(): { cards: number; seg: number } {
  return quality === 'low' ? { cards: 0.6, seg: 0.75 } : quality === 'high' ? { cards: 1.25, seg: 1.25 } : { cards: 1, seg: 1 };
}

/** Low tier: half-resolution bark / surface textures and atlases without their top mip. */
export function texLow(): boolean {
  return quality === 'low';
}

/** Cache-key suffix for tier-dependent textures. */
export function texTier(): string {
  return quality === 'low' ? '@lo' : '';
}

// ---------------------------------------------------------------------------
// Resource cache

const textures = new Map<string, THREE.Texture>();
const materials = new Map<string, THREE.Material>();

/** Cached texture by key (generated on first use). */
export function cachedTexture<T extends THREE.Texture>(key: string, make: () => T): T {
  let t = textures.get(key) as T | undefined;
  if (!t) {
    t = make();
    clearNoiseCache();
    t.name = `nature/${key}`;
    textures.set(key, t);
  }
  return t;
}

/** Is a texture with this key cached already? */
export function hasCachedTexture(key: string): boolean {
  return textures.has(key);
}

/** Cached material by key. */
export function cachedMaterial<T extends THREE.Material>(key: string, make: () => T): T {
  let m = materials.get(key) as T | undefined;
  if (!m) {
    m = make();
    m.name = `nature/${key}`;
    materials.set(key, m);
  }
  return m;
}

/** Free every cached nature texture and material (they are rebuilt on next use). */
export function disposeNatureResources(): void {
  for (const m of materials.values()) m.dispose();
  for (const t of textures.values()) t.dispose();
  materials.clear();
  textures.clear();
}

/** Debug: number of cached textures / materials. */
export function natureResourceStats(): { textures: number; materials: number } {
  return { textures: textures.size, materials: materials.size };
}

// ---------------------------------------------------------------------------
// Foliage

// Light seen through the leaves is filtered by them (deeper green-yellow than
// the leaf's reflected colour), and a low sun crosses a lot of crown before it
// reaches a leaf, so back-lighting fades at grazing sun instead of turning a
// sunrise canopy pale.
const LEAF_LIGHT = /* glsl */ `
uniform float uLeafTrans;
uniform float uLeafNight;
void RE_Direct_Leaf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float lfBack = pow( saturate( dot( -geometryViewDir, directLight.direction ) ), 4.0 );
  float lfWrap = saturate( 0.45 - 0.55 * dot( geometryNormal, directLight.direction ) );
  float lfElev = dot( directLight.direction, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) );
  lfBack *= mix( 0.3, 1.0, smoothstep( 0.05, 0.45, lfElev ) );
  vec3 lfAlb = material.diffuseContribution;
  vec3 lfThrough = lfAlb * clamp( lfAlb / max( dot( lfAlb, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-3 ), 0.0, 2.0 );
  reflectedLight.directDiffuse += directLight.color * RECIPROCAL_PI * ( lfThrough * lfBack * 1.6 + lfAlb * lfWrap * 0.5 ) * uLeafTrans * ( 1.0 - uLeafNight );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Leaf
`;

// Canopy multiple scattering: sky light reaching shaded leaves has passed
// through other leaves, so tint the ambient toward the leaf's own hue
// (keeps crown interiors green instead of sky-blue), and the crown's
// underside (crown-bent normals facing down) sees mostly the crown above and
// the ground, not the sky: up to a quarter less ambient there, so crowns get
// depth instead of a flat lit underside. Under the moon a crown is a dark
// mass: no light through the leaves (above), no silvery sheen off thousands
// of card faces, and less of the lifted night sky inside it.
const LEAF_AMBIENT = /* glsl */ `
{
  float lfLum = max( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-3 );
  vec3 lfHue = clamp( diffuseColor.rgb / lfLum, 0.0, 2.0 );
  float lfUp = dot( normal, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) );
  float lfUnder = mix( 0.75, 1.0, smoothstep( -0.4, 0.6, lfUp ) );
  reflectedLight.indirectDiffuse *= mix( vec3( 1.0 ), lfHue, 0.4 ) * lfUnder * ( 1.0 - 0.4 * uLeafNight );
  reflectedLight.directSpecular *= 1.0 - 0.8 * uLeafNight;
  reflectedLight.indirectSpecular *= lfUnder * ( 1.0 - 0.8 * uLeafNight );
}
`;

/** 0 by day … 1 at full night (shared by every foliage material). */
const leafNight = { value: 0 };

/** Tell the foliage materials how dark it is (props layer, each frame: its nightFactor). */
export function setNatureNight(night: number): void {
  leafNight.value = night;
}

/** Moonlit ground level (the ground's uNightLift, render/groundMaterial.ts), shared by every foliage material. */
const nightGround = { value: 0 };

/**
 * Tell ground plants (grass clumps, ferns, reeds, flowers, bushes) the
 * moonlit ground's night level, render/context.ts nightGroundLevel: under the
 * moon they take the ground's look (neutral light, lift and grade mark,
 * groundMaterial.ts nightGroundLight), so they read as the ground's plants,
 * not as blue-grey cut-outs on warm-grey sand. Tree crowns keep the sky's light.
 */
export function setNatureNightGround(level: number): void {
  nightGround.value = level;
}

/**
 * Follow-mode occluder cut of ground-plant clumps (props/lod/fade.ts): a
 * clump about a metre wide still covers a subject when its centre stands
 * just beside the camera → subject line, so it counts from about its half
 * width farther out, and only while it reaches up to the line (its
 * geometries carry their height, plants.ts withOcclTops).
 */
export const GROUND_PLANT_OCCLUDER = { occluderReach: 0.6, occluderTop: true } as const;

export interface FoliageParams extends THREE.MeshStandardMaterialParameters {
  /** Strength of light transmitted through the leaves (0..1). */
  translucency?: number;
}

/**
 * Moonlit floor of a ground plant's own shade (a bush's inner and shadowed
 * cards), as a share of the moonlit ground's brightness: skylight and the
 * moonlit sand around it reach in, so a bush reads as a dark shrub, not a
 * black hole, and stays darker than the ground. The ground's level is the
 * moon's light on open ground (+ the hemisphere fill, MOON_FILL) on sand-like
 * albedo; the floor keeps the plant's own hue.
 */
const LEAF_NIGHT_FLOOR = 0.3;
/** … a tree crown's (palm fronds too): less, a crown stays a dark mass above the bushes, but not a black hole. */
const CROWN_NIGHT_FLOOR = 0.17;
const MOONLIT_GROUND = 0.4 * 1.3;
/** The floor follows the card's baked occlusion (vertex colour) down to this share: inner cards stay deeper. */
const NIGHT_FLOOR_AO = 0.6;

// After nightGroundLight: lift a plant's diffuse light (after its shadow) to
// the moonlit floor, by its card's baked occlusion
const LEAF_NIGHT_FLOOR_GLSL = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
{
  // at night the one directional light is the moon (render/context.ts)
  float lfMoonH = dot( directionalLights[ 0 ].color, vec3( 0.2126, 0.7152, 0.0722 ) )
                * saturate( dot( directionalLights[ 0 ].direction, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) ) );
  vec3 lfAlb = material.diffuseContribution;
  vec3 lfHue = clamp( lfAlb / max( dot( lfAlb, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-3 ), 0.0, 2.0 );
  float lfAO = 1.0;
#ifdef USE_COLOR
  lfAO = mix( ${NIGHT_FLOOR_AO.toFixed(2)}, 1.0, saturate( dot( vColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ) );
#endif
  float lfShare = mix( ${CROWN_NIGHT_FLOOR.toFixed(2)}, ${LEAF_NIGHT_FLOOR.toFixed(2)}, vLfGround );
  vec3 lfFloor = ${MOONLIT_GROUND.toFixed(3)} * lfShare * lfAO * lfMoonH * RECIPROCAL_PI * lfHue;
  vec3 lfHave = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
  reflectedLight.indirectDiffuse += max( lfFloor - lfHave, 0.0 ) * uNightLift;
}
#endif
`;

// Ground-plant share of a card (vLfGround): 1 on the ground sheet; on the
// tree sheet, bushes (crown centre below ~1.8 m, from the near-camera fade's
// crown data when the material carries it) are ground plants, tree crowns not
const GROUND_PLANT_VERT = /* glsl */ `
#ifdef PROP_FADE_CROWN
vLfGround = max( uLfGround, 1.0 - smoothstep( 180.0, 320.0, aCrown.y ) );
#else
vLfGround = uLfGround;
#endif
`;

export class FoliageMaterial extends THREE.MeshStandardMaterial {
  readonly leafTrans = { value: 0.5 };
  readonly leafNight = leafNight;
  /** 1: a ground plant sheet (grass, ferns, reeds, flowers): moonlit like the ground. */
  readonly groundPlant = { value: 0 };
  readonly isFoliageMaterial = true;

  constructor(params: FoliageParams = {}) {
    const { translucency, ...rest } = params;
    super({
      side: THREE.DoubleSide,
      alphaTest: 0.5,
      vertexColors: true,
      roughness: 0.8,
      metalness: 0,
      // a crown sees little open sky: most of its ambient is leaf-filtered
      envMapIntensity: 0.6,
      ...rest,
    });
    if (translucency !== undefined) this.leafTrans.value = translucency;
    useEnvMapIntensity(this);
  }

  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms): void {
    shader.uniforms.uLeafTrans = this.leafTrans;
    shader.uniforms.uLeafNight = this.leafNight;
    shader.uniforms.uLfGround = this.groundPlant;
    shader.uniforms.uNightLift = nightGround;
    const nfb = THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uLfGround;\nvarying float vLfGround;')
      .replace('#include <project_vertex>', `#include <project_vertex>\n${GROUND_PLANT_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNightLift;\nvarying float vLfGround;')
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${LEAF_LIGHT}`)
      .replace('#include <normal_fragment_begin>', nfb)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${LEAF_AMBIENT}`)
      .replace('#include <aomap_fragment>', `float lfNightMark = 0.0;\n${nightGroundLight('vLfGround', 'diffuseColor.rgb', 'lfNightMark')}\n${LEAF_NIGHT_FLOOR_GLSL}\n#include <aomap_fragment>`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>${nightGroundMark('lfNightMark')}`);
  }

  override customProgramCacheKey(): string {
    return 'nature-foliage';
  }

  override copy(source: this): this {
    super.copy(source);
    if (source.leafTrans) this.leafTrans.value = source.leafTrans.value;
    if (source.groundPlant) this.groundPlant.value = source.groundPlant.value;
    return this;
  }
}

/** Foliage material for an atlas (cached by key). */
export function foliageMaterial(
  key: string,
  map: THREE.Texture,
  opts: { sway: number; translucency?: number; roughness?: number; color?: number; alphaTest?: number; crownFade?: boolean; groundPlant?: boolean },
): FoliageMaterial {
  return cachedMaterial(`leaf:${key}#${map.uuid.slice(0, 8)}`, () => {
    const m = new FoliageMaterial({
      map,
      translucency: opts.translucency ?? 0.5,
      roughness: opts.roughness ?? 0.8,
      color: opts.color ?? 0xffffff,
      alphaTest: opts.alphaTest ?? 0.5,
    });
    m.userData.sway = opts.sway;
    if (opts.groundPlant) {
      m.groundPlant.value = 1;
      Object.assign(m.userData, GROUND_PLANT_OCCLUDER);
    }
    // near-camera dissolve (props layer) for occluding leaves / fronds; whole
    // crowns too when every geometry carries its crown (geo.ts addCrownFade)
    m.userData.foliage = true;
    if (opts.crownFade) m.userData.crownFade = true;
    return m;
  });
}

/**
 * The two shared foliage materials (see atlases.ts sheets): every tree /
 * palm / bamboo / thorn-bush card uses `trees`, every fern / grass / reed /
 * flower card `ground`. One material each = one batch (draw call) each.
 */
export const LEAF_PARAMS = {
  trees: { sway: 0.011, translucency: 0.45, roughness: 0.78, crownFade: true },
  ground: { sway: 0.065, translucency: 0.55, roughness: 0.78, groundPlant: true },
} as const;

// ---------------------------------------------------------------------------
// Bark / solid textured surfaces

/**
 * Bark under the moon takes the ground's night look (nightGroundLight, the
 * full share: 0.6 left trunks at sRGB R/B ≈ 0.67 next to neutral ground) and
 * loses most of its sky reflection, so trunks read as moonlit grey-brown
 * wood, not cold blue.
 */
const BARK_NIGHT_GROUND = 1;
/** Share of bark's sky reflection (blue night sky) taken away at full night. */
const BARK_NIGHT_SHEEN = 0.8;

/** Bark, wood and soil: a standard material that takes part of the moonlit ground's look at night. */
export class BarkMaterial extends THREE.MeshStandardMaterial {
  readonly isBarkMaterial = true;

  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms): void {
    shader.uniforms.uNightLift = nightGround;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNightLift;')
      .replace(
        '#include <aomap_fragment>',
        `float bkNightMark = 0.0;\n${nightGroundLight(BARK_NIGHT_GROUND.toFixed(2), 'diffuseColor.rgb', 'bkNightMark')}\nreflectedLight.indirectSpecular *= 1.0 - ${BARK_NIGHT_SHEEN.toFixed(2)} * uNightLift;\n#include <aomap_fragment>`,
      )
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>${nightGroundMark('bkNightMark')}`);
  }

  override customProgramCacheKey(): string {
    return 'nature-bark';
  }
}

/**
 * Share of the moonlit ground's night look for wood and paint on structures
 * (fences, shelters, benches; material userData.nightGround, applyNightLook):
 * less than bark's, so they keep a little of their stain and paint, but no
 * longer read cold blue next to the neutral ground.
 */
export const STRUCTURE_NIGHT_GROUND = 0.6;

const nightLook = new WeakSet<THREE.Material>();

/**
 * Give a standard material flagged with userData.nightGround (a share,
 * 0..1) BarkMaterial's night look at that share: the moonlit ground's neutral
 * light in its own hue and less blue sky sheen. Chains onto the material's
 * hooks (idempotent; a program that already has the look, e.g. through a
 * copied hook, is left alone). Apply before the occluder cut.
 */
export function applyNightLook(m: THREE.Material): void {
  const share = m.userData.nightGround;
  if (typeof share !== 'number' || nightLook.has(m)) return;
  nightLook.add(m);
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey.call(m);
  m.onBeforeCompile = function (shader, renderer) {
    prev.call(this, shader, renderer);
    if (shader.fragmentShader.includes('uniform float uNightLift;')) return;
    shader.uniforms.uNightLift = nightGround;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNightLift;')
      .replace(
        '#include <aomap_fragment>',
        `float stNightMark = 0.0;\n${nightGroundLight(share.toFixed(2), 'diffuseColor.rgb', 'stNightMark')}\nreflectedLight.indirectSpecular *= 1.0 - ${(BARK_NIGHT_SHEEN * share).toFixed(2)} * uNightLift;\n#include <aomap_fragment>`,
      )
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>${nightGroundMark('stNightMark')}`);
  };
  m.customProgramCacheKey = () => `${prevKey}|nightlook${share}`;
  m.needsUpdate = true;
}

export function barkMaterial(
  key: string,
  map: THREE.Texture,
  normalMap: THREE.Texture,
  opts: { sway?: number; roughness?: number; normalScale?: number; color?: number; fade?: boolean } = {},
): THREE.MeshStandardMaterial {
  // the texture set (tier resolution) is part of the identity
  return cachedMaterial(`bark:${key}#${map.uuid.slice(0, 8)}`, () => {
    const m = new BarkMaterial({
      map,
      normalMap,
      vertexColors: true,
      roughness: opts.roughness ?? 0.92,
      metalness: 0,
      color: opts.color ?? 0xffffff,
    });
    const ns = opts.normalScale ?? 1;
    m.normalScale.set(ns, ns);
    if (opts.sway) m.userData.sway = opts.sway;
    // trunks dissolve (whole) while the camera stands inside the plant;
    // ground-level surfaces (soil, log ends) opt out
    m.userData.fadeNear = opts.fade ?? true;
    return m;
  });
}

// ---------------------------------------------------------------------------
// Rock (triplanar)

const ROCK_VERT_PARS = /* glsl */ `
varying vec3 vTriPos;
varying vec3 vTriNrm;
attribute float aSurf;
varying float vSurf;
`;
const ROCK_VERT = /* glsl */ `
vTriPos = position;
vTriNrm = normal;
vSurf = aSurf;
`;
const ROCK_FRAG_PARS = /* glsl */ `
uniform sampler2D uTriTex;
uniform float uTriScale;
uniform float uTriBump;
uniform float uSurfRough;
uniform vec3 uSurfTint;
varying vec3 vTriPos;
varying vec3 vTriNrm;
varying float vSurf;
vec3 rockPerturb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir ) {
  vec3 vSigmaX = dFdx( surf_pos );
  vec3 vSigmaY = dFdy( surf_pos );
  vec3 R1 = cross( vSigmaY, surf_norm );
  vec3 R2 = cross( surf_norm, vSigmaX );
  float fDet = dot( vSigmaX, R1 ) * faceDir;
  vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
  return normalize( abs( fDet ) * surf_norm - vGrad );
}
`;
const ROCK_MAP = /* glsl */ `
vec3 triW = pow( abs( normalize( vTriNrm ) ), vec3( 4.0 ) );
triW /= ( triW.x + triW.y + triW.z );
vec3 triP = vTriPos * uTriScale;
vec4 triX = texture2D( uTriTex, triP.zy );
vec4 triY = texture2D( uTriTex, triP.xz + 0.37 );
vec4 triZ = texture2D( uTriTex, triP.xy + 0.71 );
vec4 triS = triX * triW.x + triY * triW.y + triZ * triW.z;
diffuseColor.rgb *= mix( triS.rgb, uSurfTint * ( 0.82 + 0.18 * triS.a ), clamp( vSurf, 0.0, 1.0 ) );
float triH = triS.a;
`;
const ROCK_ROUGH = /* glsl */ `
float roughnessFactor = mix( roughness, uSurfRough, clamp( vSurf, 0.0, 1.0 ) ) * ( 0.9 + 0.2 * triH );
`;
const ROCK_NORMAL = /* glsl */ `
normal = rockPerturb( - vViewPosition, normal, vec2( dFdx( triH ), dFdy( triH ) ) * uTriBump * ( 1.0 - 0.7 * clamp( vSurf, 0.0, 1.0 ) ), faceDirection );
`;

export interface RockParams extends THREE.MeshStandardMaterialParameters {
  /** RGBA texture: sRGB albedo detail, alpha = height. */
  triTex: THREE.Texture;
  /** Metres per texture repeat. */
  tile: number;
  /** Bump height (metres for full alpha range). */
  bump: number;
  /** Roughness where aSurf = 1. */
  surfRoughness?: number;
  /** Texture tint where aSurf = 1 (desaturated detail × tint). */
  surfTint?: number;
}

export class RockMaterial extends THREE.MeshStandardMaterial {
  readonly triUniforms = {
    uTriTex: { value: null as THREE.Texture | null },
    uTriScale: { value: 1 },
    uTriBump: { value: 0.01 },
    uSurfRough: { value: 0.9 },
    uSurfTint: { value: new THREE.Color(1, 1, 1) },
  };
  readonly isRockMaterial = true;

  constructor(params?: RockParams) {
    super(RockMaterial.base(params));
    if (params) {
      this.triUniforms.uTriTex.value = params.triTex;
      this.triUniforms.uTriScale.value = 1 / params.tile;
      this.triUniforms.uTriBump.value = params.bump;
      this.triUniforms.uSurfRough.value = params.surfRoughness ?? 0.9;
      this.triUniforms.uSurfTint.value.set(params.surfTint ?? 0xffffff);
    }
    useEnvMapIntensity(this);
  }

  private static base(params?: RockParams): THREE.MeshStandardMaterialParameters | undefined {
    if (!params) return undefined;
    const { triTex: _t, tile: _s, bump: _b, surfRoughness: _r, surfTint: _c, ...rest } = params;
    return { vertexColors: true, roughness: 0.9, metalness: 0, ...rest };
  }

  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms): void {
    Object.assign(shader.uniforms, this.triUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROCK_VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${ROCK_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ROCK_FRAG_PARS}`)
      .replace('#include <map_fragment>', ROCK_MAP)
      .replace('#include <roughnessmap_fragment>', ROCK_ROUGH)
      .replace('#include <normal_fragment_maps>', ROCK_NORMAL);
  }

  override customProgramCacheKey(): string {
    return 'nature-rock';
  }

  override copy(source: this): this {
    super.copy(source);
    const s = source.triUniforms;
    if (s) {
      this.triUniforms.uTriTex.value = s.uTriTex.value;
      this.triUniforms.uTriScale.value = s.uTriScale.value;
      this.triUniforms.uTriBump.value = s.uTriBump.value;
      this.triUniforms.uSurfRough.value = s.uSurfRough.value;
      this.triUniforms.uSurfTint.value.copy(s.uSurfTint.value);
    }
    return this;
  }
}

/** Share of the moonlit ground's night look for rocks and stone walls (applyNightLook): ground-like stone, like bark, not slate-blue boulders. */
export const STONE_NIGHT_GROUND = 1;

export function rockMaterial(key: string, p: RockParams): RockMaterial {
  return cachedMaterial(`rock:${key}`, () => {
    const m = new RockMaterial(p);
    m.userData.nightGround = STONE_NIGHT_GROUND;
    return m;
  });
}
