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
//  bark             plain MeshStandardMaterial with albedo + normal maps and
//                   vertex-colour tint / AO.
//
// Shader patches live in prototype methods so Material.clone() (used for
// ghost previews) keeps them. Every material / texture created here is cached
// and released by disposeNatureResources().

import * as THREE from 'three';
import type { QualityLevel } from '../../core/contracts';
import { clearNoiseCache } from './tex';

// ---------------------------------------------------------------------------
// Quality

let quality: QualityLevel = 'medium';

/**
 * Detail tier used by builders created after this call (leaf-card counts,
 * radial segments). Default 'medium'.
 */
export function setNatureQuality(level: QualityLevel): void {
  quality = level;
}

/** Multipliers for the current tier. */
export function detail(): { cards: number; seg: number } {
  return quality === 'low' ? { cards: 0.6, seg: 0.75 } : quality === 'high' ? { cards: 1.25, seg: 1.25 } : { cards: 1, seg: 1 };
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

const LEAF_LIGHT = /* glsl */ `
uniform float uLeafTrans;
void RE_Direct_Leaf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float lfBack = pow( saturate( dot( -geometryViewDir, directLight.direction ) ), 4.0 );
  float lfWrap = saturate( 0.45 - 0.55 * dot( geometryNormal, directLight.direction ) );
  reflectedLight.directDiffuse += directLight.color * BRDF_Lambert( material.diffuseContribution ) * ( lfBack * 1.6 + lfWrap * 0.5 ) * uLeafTrans;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Leaf
`;

// Canopy multiple scattering: sky light reaching shaded leaves has passed
// through other leaves, so tint the ambient toward the leaf's own hue
// (keeps crown interiors green instead of sky-blue).
const LEAF_AMBIENT = /* glsl */ `
{
  float lfLum = max( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-3 );
  vec3 lfHue = clamp( diffuseColor.rgb / lfLum, 0.0, 2.0 );
  reflectedLight.indirectDiffuse *= mix( vec3( 1.0 ), lfHue, 0.4 );
}
`;

export interface FoliageParams extends THREE.MeshStandardMaterialParameters {
  /** Strength of light transmitted through the leaves (0..1). */
  translucency?: number;
}

export class FoliageMaterial extends THREE.MeshStandardMaterial {
  readonly leafTrans = { value: 0.5 };
  readonly isFoliageMaterial = true;

  constructor(params: FoliageParams = {}) {
    const { translucency, ...rest } = params;
    super({
      side: THREE.DoubleSide,
      alphaTest: 0.5,
      vertexColors: true,
      roughness: 0.8,
      metalness: 0,
      envMapIntensity: 0.6,
      ...rest,
    });
    if (translucency !== undefined) this.leafTrans.value = translucency;
  }

  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms): void {
    shader.uniforms.uLeafTrans = this.leafTrans;
    const nfb = THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${LEAF_LIGHT}`)
      .replace('#include <normal_fragment_begin>', nfb)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${LEAF_AMBIENT}`);
  }

  override customProgramCacheKey(): string {
    return 'nature-foliage';
  }

  override copy(source: this): this {
    super.copy(source);
    if (source.leafTrans) this.leafTrans.value = source.leafTrans.value;
    return this;
  }
}

/** Foliage material for an atlas (cached by key). */
export function foliageMaterial(key: string, map: THREE.Texture, opts: { sway: number; translucency?: number; roughness?: number; color?: number; alphaTest?: number }): FoliageMaterial {
  return cachedMaterial(`leaf:${key}`, () => {
    const m = new FoliageMaterial({
      map,
      translucency: opts.translucency ?? 0.5,
      roughness: opts.roughness ?? 0.8,
      color: opts.color ?? 0xffffff,
      alphaTest: opts.alphaTest ?? 0.5,
    });
    m.userData.sway = opts.sway;
    return m;
  });
}

// ---------------------------------------------------------------------------
// Bark / solid textured surfaces

export function barkMaterial(key: string, map: THREE.Texture, normalMap: THREE.Texture, opts: { sway?: number; roughness?: number; normalScale?: number; color?: number } = {}): THREE.MeshStandardMaterial {
  return cachedMaterial(`bark:${key}`, () => {
    const m = new THREE.MeshStandardMaterial({
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

export function rockMaterial(key: string, p: RockParams): RockMaterial {
  return cachedMaterial(`rock:${key}`, () => new RockMaterial(p));
}
