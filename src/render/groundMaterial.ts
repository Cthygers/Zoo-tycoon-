// Ground material shared by the playable terrain and the decorative outer
// landscape: MeshStandardMaterial extended with
//  - per-tile terrain types (index texture): the four surrounding tile types
//    are merged by bilinear weight, the two strongest layers are sampled and
//    blended across ~1 tile with a soft transition perturbed by multi-scale
//    noise and by the layers' own height maps (dry tufts poke through lawn,
//    lawn creeps into dirt) — organic edges at a fixed cost of ≤ 2 layer
//    samples per pixel;
//  - outside the map a continuous meadow mix (no tile lookups) that turns
//    into mud / lake bed near the water line;
//  - macro variation at 50 m / 11 m / 2.4 m: gentle brightness changes plus
//    lawn hue shifts (lusher, yellowing, sun-bleached patches); small dry /
//    dirt patches inside a lawn (tile lawn share) stay mostly turf, and the
//    wear goes where it belongs: trampled verges along paths and thinner,
//    patchy turf under tree crowns;
//  - path overlay (paved / gravel / boardwalk) with crisp irregular edges;
//  - noisy waterline (shared with water.ts) with a wet satin bank above it,
//    a lake bed that takes after its shore (gravel, sand, silt) and only
//    starts a few cm under the water (the shore's ground runs into the
//    shallows), per-channel underwater absorption, caustics and drifting
//    cloud shadows; a pond's mud ring in a lawn is a ragged, greyish soil
//    margin about a metre wide (the turf takes the upper bank back);
//  - low-sun "sheen" on grass (blades catch grazing light that a flat
//    ground normal would miss), respecting shadows.
//
// Texture fetches per pixel (typical lawn pixel, low tier): 13 tile texels
// (layers, path, verges, crown cover) + 4 noise + 2 layer (albedo, detail);
// transitions add 2, dry patches in a lawn 4 tile texels + 1 noise + 2, the
// upper bank of a pond's mud ring 2.

import * as THREE from 'three';
import { DECK_Y, MAP_H, MAP_W, TILE, WATER_ABSORPTION, WATER_LEVEL } from '../core/constants';
import { GROUND_LAYERS, LAYER_SIZE_M, type GroundTextureSet } from './textures';
import { SHORE_OFFSET_GLSL } from './water';

export interface GroundMaterialOptions {
  /** Second texture sample at another scale for anti-tiling (high quality). */
  antiTile: boolean;
  /** Moving cloud shadows on the ground. */
  cloudShadows: boolean;
  /** Animated caustics on lake beds. */
  caustics: boolean;
}

export interface GroundUniforms {
  [k: string]: THREE.IUniform;
  uAlbedoArr: THREE.IUniform<THREE.Texture>;
  uDetailArr: THREE.IUniform<THREE.Texture>;
  uNoise: THREE.IUniform<THREE.Texture>;
  uTypeTex: THREE.IUniform<THREE.Texture>;
  uLayerXf: THREE.IUniform<THREE.Vector4[]>;
  uTime: THREE.IUniform<number>;
  uSunDirW: THREE.IUniform<THREE.Vector3>;
  /** Direct light colour × intensity (sun or moon). */
  uSunCol: THREE.IUniform<THREE.Color>;
  uCloudOffset: THREE.IUniform<THREE.Vector2>;
  uCloudCover: THREE.IUniform<number>;
  uCloudShadow: THREE.IUniform<number>;
  /**
   * Night level of moonlit natural ground (sand, soil, straw, lawn, mud:
   * everything but paving-bright layers): 0 by day and through the blue
   * hour, 1 in deep night (see NIGHT_GROUND).
   */
  uNightLift: THREE.IUniform<number>;
}

/**
 * Moonlit natural ground at night level k (uNightLift; shared with the
 * grass tufts, grass.ts). Paths and snow are left out: the moon already
 * shows them pale.
 *  - lift: ACES's toe crushes the ground to near black next to paving and
 *    moonlit coats, so it gets this share more of its moonlit light (back to
 *    about its daylight share of the paving's brightness, not more: a brighter
 *    ground reads as frost or snow);
 *  - hue: blue moonlight and the grade's rod vision (grade.ts) turn sand and
 *    lawn blue-white. Their light is made neutral, so they show their own
 *    albedo's hue, and they are marked for the grade (as lamp light marks
 *    figures, props/lights/lampField.ts) so it keeps ≈ 20 % of that hue:
 *    sand reads as pale warm grey, lawn as grey-green, under the blue night.
 */
export const NIGHT_GROUND = { lift: 0.2, mark: 0.18 } as const;

/**
 * GLSL (after the lights, e.g. at <aomap_fragment>): the lift and the
 * neutral light for natural-ground share `nat` and albedo `alb` at night
 * level uNightLift; sets `mark` (declared by the caller) for nightGroundMark.
 */
export function nightGroundLight(nat: string, alb: string, mark: string): string {
  return `{
    float ngK = uNightLift * (${nat});
    vec3 ngHue = (${alb}) / max(dot(${alb}, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
    vec3 ngDir = reflectedLight.directDiffuse;
    vec3 ngInd = reflectedLight.indirectDiffuse;
    float ngLift = 1.0 + ${NIGHT_GROUND.lift.toFixed(2)} * ngK;
    reflectedLight.directDiffuse = mix(ngDir, dot(ngDir, vec3(0.2126, 0.7152, 0.0722)) * ngHue, ngK) * ngLift;
    reflectedLight.indirectDiffuse = mix(ngInd, dot(ngInd, vec3(0.2126, 0.7152, 0.0722)) * ngHue, ngK) * ngLift;
    ${mark} = ${NIGHT_GROUND.mark.toFixed(2)} * ngK;
  }`;
}

/**
 * GLSL (right after <opaque_fragment>): hand `mark` to the grade, through
 * whLampLit where the material tone-maps itself and through the HDR
 * target's alpha on the post-FX tier (grade.ts).
 */
export function nightGroundMark(mark: string): string {
  return `
  #ifdef TONE_MAPPING
    #ifdef WH_LAMP_LIT
    whLampLit = ${mark};
    #endif
  #else
    gl_FragColor.a += ${mark};
  #endif`;
}

const PARS = /* glsl */ `
uniform highp sampler2DArray uAlbedoArr;
uniform highp sampler2DArray uDetailArr;
uniform sampler2D uNoise;
uniform highp sampler2D uTypeTex;
uniform vec4 uLayerXf[${GROUND_LAYERS}];
uniform float uTime;
uniform vec3 uSunDirW;
uniform vec3 uSunCol;
uniform vec2 uCloudOffset;
uniform float uCloudCover;
uniform float uCloudShadow;
uniform float uNightLift;
varying vec3 vWPos;
varying vec3 vWNrm;

const int MAPW = ${MAP_W};
const int MAPH = ${MAP_H};
const float TILE_M = ${TILE.toFixed(1)};
const float WATER_Y = ${WATER_LEVEL.toFixed(3)};
const float DECK_Y = ${DECK_Y.toFixed(3)};
const float MAP_WM = ${(MAP_W * TILE).toFixed(1)};
const float MAP_HM = ${(MAP_H * TILE).toFixed(1)};

float gLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
bool inMap(ivec2 c) { return c.x >= 0 && c.y >= 0 && c.x < MAPW && c.y < MAPH; }

// Ground layer just outside the map: meadow, or mud / lake bed where the
// decorative ground dips to the water line (ponds that continue past the border).
float gOuterY;
int outerLayer() {
  if (gOuterY < WATER_Y - 0.02) return 7;
  if (gOuterY < WATER_Y + 0.12) return 6;
  return 0;
}
// Ground layer for a tile (terrain type → texture layer).
int layerAt(ivec2 c) {
  if (!inMap(c)) return outerLayer();
  int t = int(texelFetch(uTypeTex, c, 0).r * 255.0 + 0.5);
  return t >= 7 ? 7 : t;
}
int pathAt(ivec2 c) {
  if (!inMap(c)) return 0;
  return int(texelFetch(uTypeTex, c, 0).g * 255.0 + 0.5);
}
bool isPathAt(ivec2 c) { return pathAt(c) > 0; }
// tree crown cover of the ground around p (terrain.ts crownCover), bilinear between tile centres
float coverTile(ivec2 c) { return inMap(c) ? texelFetch(uTypeTex, c, 0).b : 0.0; }
float crownCoverAt(vec2 tp) {
  vec2 g = tp - 0.5;
  ivec2 i0 = ivec2(floor(g));
  vec2 f = g - floor(g);
  return mix(mix(coverTile(i0), coverTile(i0 + ivec2(1, 0)), f.x), mix(coverTile(i0 + ivec2(0, 1)), coverTile(i0 + ivec2(1, 1)), f.x), f.y);
}
// tile alpha (terrain.ts TileIndexTexture): lake bed look in bits 0–1, lawn share in bits 2–7
int tileExtra(ivec2 c) { return inMap(c) ? int(texelFetch(uTypeTex, c, 0).a * 255.0 + 0.5) : 0; }
// lake bed look of a tile (LakeBed) as (gravel, sand) weights
vec2 bedCode(ivec2 c) {
  int b = tileExtra(c) & 3;
  return vec2(b == 1 ? 1.0 : 0.0, b == 2 ? 1.0 : 0.0);
}
// how much a tile belongs to a lawn: 1 on lawn, the lawn share around a dry / dirt tile
float lawnAt(ivec2 c, int layer) { return layer == 0 ? 1.0 : float(tileExtra(c) >> 2) / 63.0; }
${SHORE_OFFSET_GLSL}
// Share of the lake bed allowed by the depth below the visible waterline: the
// shore's own ground runs down into the shallows and the (dark) silt starts a
// few cm deeper, so no strip of bare lake bed ever shows above the water.
float gBedShare;
const ivec2 SHORE_NB[9] = ivec2[9](ivec2(0, 0), ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1), ivec2(1, 1), ivec2(-1, 1), ivec2(1, -1), ivec2(-1, -1));
// first land layer at or around tile c (-1 inside a pond)
int shoreLand(ivec2 c) {
  for (int k = 0; k < 9; k++) {
    int l = layerAt(c + SHORE_NB[k]);
    if (l != 7) return l;
  }
  return -1;
}

vec2 slopeToWorld(int layer, vec2 g) {
  vec4 xf = uLayerXf[layer];
  return g * mat2(xf.y, xf.z, -xf.z, xf.y);
}

struct GSample { vec3 alb; vec2 slope; float rough; float ao; float h; };

// Screen-space derivatives of world xz, computed once in uniform control flow so
// texture fetches inside branches can use textureGrad (well-defined everywhere).
vec2 gDx;
vec2 gDy;

GSample sampleLayer(int layer, vec2 xz) {
  vec4 xf = uLayerXf[layer];
  mat2 R = mat2(xf.y, xf.z, -xf.z, xf.y) * xf.x;
  vec2 uv = R * xz;
  vec2 dx = R * gDx;
  vec2 dy = R * gDy;
  if (layer == 2) {
    // the dirt crust's cracks are a few texels wide: past ~15 m they would
    // shrink to a 1-px net (crazy paving, shimmer) before the mips average
    // them, so that layer blurs sooner
    float blur = 1.0 + 2.0 * smoothstep(0.016, 0.036, sqrt(length(gDx) * length(gDy)));
    dx *= blur;
    dy *= blur;
  }
  vec4 a = textureGrad(uAlbedoArr, vec3(uv, float(layer)), dx, dy);
  vec4 d = textureGrad(uDetailArr, vec3(uv, float(layer)), dx, dy);
#ifdef ANTI_TILE
  if (layer <= 7) {
    vec2 uv2 = vec2(-uv.y, uv.x) * 0.37 + 0.31;
    vec4 a2 = textureGrad(uAlbedoArr, vec3(uv2, float(layer)), vec2(-dx.y, dx.x) * 0.37, vec2(-dy.y, dy.x) * 0.37);
    float m = smoothstep(0.42, 0.58, textureGrad(uNoise, xz * 0.047, gDx * 0.047, gDy * 0.047).g);
    a = mix(a, a2, m * 0.6);
  }
#endif
  GSample s;
  s.alb = a.rgb * a.rgb;
  s.h = a.a;
  s.slope = slopeToWorld(layer, (d.xy - 0.5) * 4.0);
  s.rough = d.z;
  s.ao = d.w;
  return s;
}

GSample mixSample(GSample a, GSample b, float m) {
  GSample r;
  r.alb = mix(a.alb, b.alb, m);
  r.slope = mix(a.slope, b.slope, m);
  r.rough = mix(a.rough, b.rough, m);
  r.ao = mix(a.ao, b.ao, m);
  r.h = mix(a.h, b.h, m);
  return r;
}

// Share of the lawn / grassland layers in the final blend (for hue variation
// and sheen), of the dry-grass layer alone, of mud and of the lake bed; the
// bed's (gravel, sand) look blended over the four tiles.
float gGrassy;
float gDry;
float gMud;
float gBed;
vec2 gBedLook;
// share of a path (paving, gravel, boardwalk) over the terrain
float gPath = 0.0;
// height above the visible waterline (m)
float gWy;
// 1 where the mud is a pond's shore ring in a lawn (terrain.ts lawnShare)
float gShoreMud;
float mudLawnAt(ivec2 c, int layer) { return layer == 6 ? float(tileExtra(c) >> 2) / 63.0 : 0.0; }

GSample sampleTiles(vec3 wp, vec4 nzA, vec4 nzB, vec4 nzC, vec4 nzD) {
  gOuterY = wp.y;
  gShoreMud = 0.0;
  vec2 tp = wp.xz / TILE_M;
  ivec2 here = ivec2(floor(tp));
  float fine = nzC.b * 0.55 + nzD.g * 0.45; // ≈2.4 m + 0.6 m noise
  if (!inMap(here)) {
    // continuous meadow: sun-bleached patches fade in away from the border. Only
    // a partial blend toward the dry layer (the lawn's green and relief stay)
    // with edges broken up by fine noise and blade heights: straw-green turf,
    // not flat beige stains.
    vec2 o = max(max(-wp.xz, wp.xz - vec2(MAP_WM, MAP_HM)), 0.0);
    float dOut = length(o);
    int base = outerLayer();
    float v = nzA.r * 0.6 + nzB.r * 0.4 + (fine - 0.5) * 0.12;
    float dry = base == 0 ? smoothstep(0.52, 0.76, v) * smoothstep(6.0, 26.0, dOut) : 0.0;
    if (base == 7 && gBedShare < 0.5) base = 6;
    GSample a = sampleLayer(base, wp.xz);
    gGrassy = base == 0 ? 1.0 : 0.0;
    gDry = 0.0;
    gMud = base == 6 ? 1.0 : 0.0;
    gBed = base == 7 ? 1.0 : 0.0;
    gBedLook = vec2(0.0);
    if (dry < 0.01) return a;
    GSample b = sampleLayer(1, wp.xz);
    float m = 0.5 * smoothstep(0.2, 0.6, dry + (b.h - a.h) * 0.4 + (nzD.g - 0.5) * 0.35);
    gDry = m;
    return mixSample(a, b, m);
  }
  // small organic warp (≈0.7 tile) so borders never follow the tile grid
  vec2 warp = (nzB.rg - 0.5) * 0.9 + (nzC.rg - 0.5) * 0.45;
  vec2 g = tp + warp - 0.5;
  vec2 ci = floor(g);
  vec2 f = g - ci;
  ivec2 i0 = ivec2(ci);
  int L0 = layerAt(i0);
  int L1 = layerAt(i0 + ivec2(1, 0));
  int L2 = layerAt(i0 + ivec2(0, 1));
  int L3 = layerAt(i0 + ivec2(1, 1));
  gBedLook = vec2(0.0);
  if (L0 == 7 || L1 == 7 || L2 == 7 || L3 == 7)
    gBedLook = mix(mix(bedCode(i0), bedCode(i0 + ivec2(1, 0)), f.x), mix(bedCode(i0 + ivec2(0, 1)), bedCode(i0 + ivec2(1, 1)), f.x), f.y);
  if (L0 == 6 || L1 == 6 || L2 == 6 || L3 == 6) {
    float ml = max(max(mudLawnAt(i0, L0), mudLawnAt(i0 + ivec2(1, 0), L1)), max(mudLawnAt(i0 + ivec2(0, 1), L2), mudLawnAt(i0 + ivec2(1, 1), L3)));
    gShoreMud = smoothstep(0.15, 0.4, ml);
  }
  // dry-grass / dirt patches inside a lawn (lawn share): mostly turf again,
  // with streaky low-contrast wear instead of round beige stains
  bool dryOrDirt = L0 == 1 || L0 == 2 || L1 == 1 || L1 == 2 || L2 == 1 || L2 == 2 || L3 == 1 || L3 == 2;
  float lawn = 0.0;
  if (dryOrDirt) {
    lawn = mix(mix(lawnAt(i0, L0), lawnAt(i0 + ivec2(1, 0), L1), f.x), mix(lawnAt(i0 + ivec2(0, 1), L2), lawnAt(i0 + ivec2(1, 1), L3), f.x), f.y);
    lawn = smoothstep(0.3, 0.8, lawn);
    if (lawn > 0.0) {
      vec2 sp = mat2(0.87, 0.5, -0.5, 0.87) * wp.xz;
      float streak = textureGrad(uNoise, vec2(sp.x * 0.035, sp.y * 0.12), gDx * 0.12, gDy * 0.12).g;
      lawn *= 0.62 + 0.38 * smoothstep(0.35, 0.65, streak);
    }
  }
  if (L0 == L1 && L0 == L2 && L0 == L3) {
    gGrassy = L0 <= 1 ? 1.0 : 0.0;
    gDry = L0 == 1 ? 1.0 : 0.0;
    gMud = L0 == 6 ? 1.0 : 0.0;
    gBed = L0 == 7 ? 1.0 : 0.0;
    GSample u = sampleLayer(L0, wp.xz);
    if (L0 == 7 && gBedShare < 1.0) {
      int land = shoreLand(here);
      if (land < 0) return u;
      gBed = gBedShare;
      gGrassy = land <= 1 ? 1.0 - gBed : 0.0;
      gDry = land == 1 ? 1.0 - gBed : 0.0;
      gMud = land == 6 ? 1.0 - gBed : 0.0;
      return mixSample(sampleLayer(land, wp.xz), u, gBed);
    }
    if (lawn < 0.01) return u;
    gDry *= 1.0 - lawn;
    gGrassy = 1.0;
    return mixSample(u, sampleLayer(0, wp.xz), lawn);
  }
  // merge equal layers, keep the two strongest
  float W0 = (1.0 - f.x) * (1.0 - f.y), W1 = f.x * (1.0 - f.y), W2 = (1.0 - f.x) * f.y, W3 = f.x * f.y;
  if (L1 == L0) { W0 += W1; W1 = 0.0; }
  if (L2 == L0) { W0 += W2; W2 = 0.0; } else if (L2 == L1) { W1 += W2; W2 = 0.0; }
  if (L3 == L0) { W0 += W3; W3 = 0.0; } else if (L3 == L1) { W1 += W3; W3 = 0.0; } else if (L3 == L2) { W2 += W3; W3 = 0.0; }
  int A = L0; float wA = W0;
  if (W1 > wA) { A = L1; wA = W1; }
  if (W2 > wA) { A = L2; wA = W2; }
  if (W3 > wA) { A = L3; wA = W3; }
  int B = A; float wB = 0.0;
  if (L0 != A && W0 > wB) { B = L0; wB = W0; }
  if (L1 != A && W1 > wB) { B = L1; wB = W1; }
  if (L2 != A && W2 > wB) { B = L2; wB = W2; }
  if (L3 != A && W3 > wB) { B = L3; wB = W3; }
  GSample a = sampleLayer(A, wp.xz);
  GSample b = sampleLayer(B, wp.xz);
  float t = wB / max(wA + wB, 1e-4); // 0 at A's tile centre … 0.5 on the border
  // soft, ragged transition over ~1 tile each side. The noise term flips sign
  // with the layer order so both sides of a border agree (continuous), and it
  // vanishes at t = 0 so tile-centre lines never show; the taller material
  // (dry tufts, stones) wins near the border.
  float nn = (fine - 0.5) * 0.5 + (nzD.b - 0.5) * 0.16;
  float s = t + ((A < B ? nn : -nn) + (b.h - a.h) * 0.3) * smoothstep(0.0, 0.25, t);
  float m = smoothstep(0.06, 0.94, s);
  if (A == 7) m = mix(1.0, m, gBedShare);
  else if (B == 7) m *= gBedShare;
  gGrassy = mix(A <= 1 ? 1.0 : 0.0, B <= 1 ? 1.0 : 0.0, m);
  gDry = mix(A == 1 ? 1.0 : 0.0, B == 1 ? 1.0 : 0.0, m);
  gMud = mix(A == 6 ? 1.0 : 0.0, B == 6 ? 1.0 : 0.0, m);
  gBed = mix(A == 7 ? 1.0 : 0.0, B == 7 ? 1.0 : 0.0, m);
  GSample r = mixSample(a, b, m);
  // the dry / dirt part of the blend gives way to lawn (only next to lawn)
  float dd = mix(A == 1 || A == 2 ? 1.0 : 0.0, B == 1 || B == 2 ? 1.0 : 0.0, m) * lawn;
  if (dd < 0.01) return r;
  gDry *= 1.0 - lawn;
  gGrassy = min(1.0, gGrassy + dd);
  if (A == 0) return mixSample(r, a, dd);
  if (B == 0) return mixSample(r, b, dd);
  return mixSample(r, sampleLayer(0, wp.xz), dd);
}

GSample sampleGround(vec3 wp, vec4 nzA, vec4 nzB, vec4 nzC, vec4 nzD) {
  GSample r = sampleTiles(wp, nzA, nzB, nzC, nzD);
  // a pond's mud ring in a lawn: the turf takes the bank back above a ragged
  // line ~15–30 cm over the water, leaving a soil margin about a metre wide
  float back = gMud * gShoreMud;
  if (back < 0.01) return r;
  float up = gWy + (nzC.b * 0.55 + nzD.g * 0.45 - 0.5) * 0.35 + (nzD.r - 0.5) * 0.1;
  back *= smoothstep(0.15, 0.32, up);
  if (back < 0.01) return r;
  gMud -= back;
  gGrassy = min(1.0, gGrassy + back);
  return mixSample(r, sampleLayer(0, wp.xz), back);
}

// Rounded-rectangle distance (in tiles) from the open sides of a path tile.
float pathEdgeDist(vec2 f, bool oL, bool oR, bool oD, bool oU, float inset, float rad) {
  float BIG = 9.0;
  float a = oL ? f.x : BIG;
  float b = oR ? 1.0 - f.x : BIG;
  float c = oD ? f.y : BIG;
  float d = oU ? 1.0 - f.y : BIG;
  float dist = min(min(a, b), min(c, d)) - inset;
  float ir = inset + rad;
  if (oL && oD) dist = min(dist, rad - length(max(vec2(ir) - vec2(a, c), 0.0)));
  if (oR && oD) dist = min(dist, rad - length(max(vec2(ir) - vec2(b, c), 0.0)));
  if (oL && oU) dist = min(dist, rad - length(max(vec2(ir) - vec2(a, d), 0.0)));
  if (oR && oU) dist = min(dist, rad - length(max(vec2(ir) - vec2(b, d), 0.0)));
  return dist;
}

float cloudShadowAt(vec3 wp) {
  // project along the sun ray to a cloud deck ~1.2 km up; same field as the sky
  vec2 sxz = uSunDirW.xz / max(uSunDirW.y, 0.15);
  vec2 cp = (wp.xz + sxz * 1200.0) / 1000.0 + uCloudOffset;
  float n = texture2D(uNoise, cp * 0.23).r * 0.5 + texture2D(uNoise, cp * 0.61 + 0.37).g * 0.3 + 0.1;
  return 1.0 - uCloudShadow * smoothstep(uCloudCover - 0.02, uCloudCover + 0.16, n);
}
`;

const MAIN = /* glsl */ `
  gDx = dFdx(vWPos.xz);
  gDy = dFdy(vWPos.xz);
  vec4 nzA = texture2D(uNoise, vWPos.xz * 0.019);
  vec4 nzB = texture2D(uNoise, vWPos.xz * 0.087);
  vec4 nzC = texture2D(uNoise, vWPos.xz * 0.41);
  vec4 nzD = texture2D(uNoise, vWPos.xz * 1.7);
  float edgeNoise = (nzC.g - 0.5) * 0.05 + (nzD.b - 0.5) * 0.025;
  float tileAA = 0.7 * length(fwidth(vWPos.xz)) / TILE_M + 0.002;
#ifdef CAUSTICS
  // warped so the voronoi web reads as wavy light lines, not polygons
  vec2 cuv = vWPos.xz * 0.21 + (nzB.rg - 0.5) * 0.35;
  float caustA = texture2D(uNoise, cuv + vec2(uTime * 0.021, uTime * 0.013)).a;
  float caustB = texture2D(uNoise, cuv * 1.17 + vec2(-uTime * 0.017, uTime * 0.019) + 0.5).a;
#endif
  // height above the visible waterline (shoreOffset, shared with water.ts)
  float wy = vWPos.y - WATER_Y + shoreOffset(nzB, nzC);
  gBedShare = smoothstep(0.0, 0.08, -wy);
  gWy = wy;
  GSample gs = sampleGround(vWPos, nzA, nzB, nzC, nzD);
  vec3 gAlb = gs.alb;
  // the shore soil left by the turf: a greyer earth than wetland mud, wet and
  // dark at the water (wet bank below), drier and paler up the bank, instead
  // of a rust-brown outline
  float shoreSoil = gMud * gShoreMud;
  if (shoreSoil > 0.0) {
    float dryUp = smoothstep(0.0, 0.25, wy);
    vec3 earth = mix(vec3(gLuma(gAlb)), gAlb, 0.55) * mix(vec3(1.0), vec3(1.4, 1.38, 1.3), dryUp);
    gAlb = mix(gAlb, earth, shoreSoil * (0.4 + 0.6 * dryUp));
    gs.rough = mix(gs.rough, 0.92, shoreSoil * dryUp);
  }
  // macro variation: gentle brightness at three scales (breaks tiling)…
  float macro = (nzA.r - 0.5) * 0.5 + (nzB.b - 0.5) * 0.45 + (nzC.b - 0.5) * 0.3;
  gAlb *= 1.0 + 0.32 * macro;
  // …and lawn / meadow hue: lusher hollows, yellowing and sun-bleached patches
  {
    float yellow = smoothstep(0.5, 0.75, nzA.b * 0.6 + nzB.g * 0.4);
    float lush = smoothstep(0.55, 0.78, nzA.g * 0.5 + nzB.r * 0.5);
    vec3 tint = mix(vec3(1.0), vec3(1.1, 1.03, 0.76), yellow * 0.55);
    tint = mix(tint, vec3(0.86, 0.97, 0.9), lush * 0.6);
    tint = mix(tint, vec3(1.08, 1.06, 0.95), smoothstep(0.62, 0.8, nzC.r) * 0.35);
    gAlb *= mix(vec3(1.0), tint, gGrassy);
    // dry grass: still-living olive patches at ~10 m, so straw areas (and the
    // dry spots on a lawn) are never one flat beige
    float olive = smoothstep(0.45, 0.7, nzB.g * 0.6 + nzC.r * 0.4);
    gAlb *= mix(vec3(1.0), vec3(0.86, 0.97, 0.72), gDry * olive * 0.6);
  }
  // the lake bed takes after its shore: grey gravel by snow / rock, pale sand by sand
  if (gBed > 0.0) {
    float bl = gLuma(gAlb);
    vec3 bedT = mix(gAlb, vec3(bl) * vec3(2.0, 2.1, 2.2), gBedLook.x);
    bedT = mix(bedT, vec3(bl) * vec3(3.8, 3.3, 2.4), gBedLook.y);
    gAlb = mix(gAlb, bedT, gBed);
  }
  vec2 gSlope = gs.slope;
  float gRough = gs.rough;
  float gAO = gs.ao;

  // ---- paths
  ivec2 tc = ivec2(floor(vWPos.xz / TILE_M));
  int pth = pathAt(tc);
  if (pth > 0) {
    vec2 f = fract(vWPos.xz / TILE_M);
    bool oL = !isPathAt(tc + ivec2(-1, 0));
    bool oR = !isPathAt(tc + ivec2(1, 0));
    bool oD = !isPathAt(tc + ivec2(0, -1));
    bool oU = !isPathAt(tc + ivec2(0, 1));
    float en = edgeNoise;
    float inset = pth == 2 ? 0.06 : 0.05;
    if (pth == 2) en *= 1.8;
    if (pth == 1) en *= 0.35;
    float dist = pathEdgeDist(f, oL, oR, oD, oU, inset, 0.18) + en;
    float pm = smoothstep(-tileAA, tileAA, dist);
    // boardwalk planks stop where the bank drops under the deck (render/boardwalk.ts)
    if (pth == 3) pm *= smoothstep(DECK_Y - 0.06, DECK_Y - 0.01, vWPos.y);
    if (pm > 0.0) {
      int layer = pth == 1 ? 8 : (pth == 2 ? 9 : 10);
      vec2 pxz = vWPos.xz;
      bool alongX = (!oL || !oR) && oU && oD;
      bool swapXZ = pth == 3 && alongX;
      if (swapXZ) { pxz = pxz.yx; gDx = gDx.yx; gDy = gDy.yx; }
      GSample ps = sampleLayer(layer, pxz);
      if (swapXZ) { ps.slope = ps.slope.yx; gDx = gDx.yx; gDy = gDy.yx; }
      vec3 pAlb = ps.alb;
      if (pth == 1) {
        // kerb stones along open edges
        float kerb = 1.0 - smoothstep(0.055, 0.07, dist);
        pAlb = mix(pAlb, pAlb * vec3(0.78, 0.78, 0.8), kerb);
        pAlb *= 0.92 + 0.16 * nzB.b;
      } else if (pth == 2) {
        pAlb *= 0.88 + 0.24 * nzB.g;
        // compacted, darker wheel lines in the middle of the path
        pAlb *= 1.0 - 0.06 * smoothstep(0.25, 0.5, dist);
      } else {
        pAlb *= 0.9 + 0.2 * nzB.r;
      }
      // slight edge shadow on the ground side
      gAlb *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.05, -dist + 0.02)) * (1.0 - pm);
      gAlb = mix(gAlb, pAlb, pm);
      gSlope = mix(gSlope, ps.slope, pm);
      gRough = mix(gRough, ps.rough, pm);
      gAO = mix(gAO, ps.ao, pm);
      gGrassy *= 1.0 - pm;
      gPath = pm;
    }
  } else if (gGrassy > 0.0) {
    // trampled verges: lawn beside a path is worn thin and yellowing (guests
    // step off the paving), the natural place for wear instead of random stains
    vec2 f = fract(vWPos.xz / TILE_M);
    float dv = 9.0;
    if (isPathAt(tc + ivec2(-1, 0))) dv = min(dv, f.x);
    if (isPathAt(tc + ivec2(1, 0))) dv = min(dv, 1.0 - f.x);
    if (isPathAt(tc + ivec2(0, -1))) dv = min(dv, f.y);
    if (isPathAt(tc + ivec2(0, 1))) dv = min(dv, 1.0 - f.y);
    float verge = (1.0 - smoothstep(0.0, 0.18 + 0.14 * nzC.g, dv)) * gGrassy;
    gAlb = mix(gAlb, gAlb * vec3(1.1, 1.0, 0.7), verge * (0.25 + 0.25 * nzD.r));
    // under tree crowns the turf is thinner (shade, resting animals and
    // guests): patchy, browner wear with the soil showing through
    float under = crownCoverAt(vWPos.xz / TILE_M) * gGrassy;
    if (under > 0.0) {
      float worn = under * smoothstep(0.3, 0.7, nzC.g * 0.55 + nzD.r * 0.45 + 0.1 * under);
      gAlb = mix(gAlb, vec3(gLuma(gAlb)) * vec3(1.3, 1.02, 0.66), worn * 0.45);
    }
  }

  // ---- shore: the visible waterline wanders around the terrain's contour
  //      (wy above). A slightly darker, satin wet bank (≈0.3–0.6 m wide on a
  //      pond's slope) above it; below it the bed absorbed per channel (red
  //      goes first, then green → teal shallows, dark deep pools)
  float bank = 0.08 + 0.1 * nzC.b;
  float wet = 1.0 - smoothstep(bank * 0.45, bank, wy);
  float underwater = 1.0 - smoothstep(-0.02, 0.02, wy);
  // under the water surface itself (the visible waterline may lie up the bank,
  // where the strip above the plane is wet ground, see water.ts)
  float submerged = underwater * smoothstep(0.0, 0.02, WATER_Y - vWPos.y);
  // snow stays white down to the water (sand and soil darken when wet)
  wet *= 1.0 - smoothstep(0.55, 0.75, gLuma(gAlb));
  gAlb *= mix(1.0, 0.8, wet);
  // a satin film, not a mirror: a glossier bank caught the sky / moon as a pale rim
  gRough = mix(gRough, mix(0.68, 0.45, submerged), wet * 0.85);
  if (underwater > 0.0) {
    // light path down to the bed and back up to the eye (the down leg is
    // shorter than the view leg under a high sun)
    float wd = max(-wy, 0.0);
    float vy = max(normalize(cameraPosition - vWPos).y, 0.25);
    float path = wd / vy + wd * 0.4;
    gAlb *= mix(vec3(1.0), exp(-path * vec3(${WATER_ABSORPTION.join(', ')})), underwater);
  }
  diffuseColor.rgb = gAlb;
`;

export interface GroundMaterial {
  material: THREE.MeshStandardMaterial;
  uniforms: GroundUniforms;
  /** Switch shader features (quality change); recompiles only when they differ. */
  setOptions(opts: GroundMaterialOptions): void;
}

function definesFor(opts: GroundMaterialOptions): Record<string, number> {
  const defines: Record<string, number> = {};
  if (opts.antiTile) defines.ANTI_TILE = 1;
  if (opts.cloudShadows) defines.CLOUD_SHADOWS = 1;
  if (opts.caustics) defines.CAUSTICS = 1;
  return defines;
}

export function createGroundMaterial(textures: GroundTextureSet, typeTex: THREE.Texture, initial: GroundMaterialOptions): GroundMaterial {
  const opts = { ...initial };
  const layerXf: THREE.Vector4[] = [];
  for (let i = 0; i < GROUND_LAYERS; i++) {
    // natural layers get a unique rotation so their repeats never line up; paths stay tile aligned
    const ang = i <= 7 ? 0.35 + i * 1.13 : 0;
    layerXf.push(new THREE.Vector4(1 / LAYER_SIZE_M[i], Math.cos(ang), Math.sin(ang), 0));
  }
  const uniforms: GroundUniforms = {
    uAlbedoArr: { value: textures.albedo },
    uDetailArr: { value: textures.detail },
    uNoise: { value: textures.noise },
    uTypeTex: { value: typeTex },
    uLayerXf: { value: layerXf },
    uTime: { value: 0 },
    uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(1, 1, 1) },
    uCloudOffset: { value: new THREE.Vector2() },
    uCloudCover: { value: 0.56 },
    uCloudShadow: { value: 0.45 },
    uNightLift: { value: 0 },
  };
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  material.name = 'ground';
  material.envMapIntensity = 1;
  material.defines = definesFor(opts);
  material.customProgramCacheKey = () => `ground2:${opts.antiTile ? 1 : 0}${opts.cloudShadows ? 1 : 0}${opts.caustics ? 1 : 0}`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * objectNormal);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <map_fragment>', MAIN)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(gRough, 0.04, 1.0);')
      .replace(
        '#include <normal_fragment_maps>',
        `{
          vec3 nW = normalize(vWNrm);
          nW = normalize(nW - vec3(gSlope.x, 0.0, gSlope.y));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }`,
      )
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>${nightGroundMark('gNightMark')}`)
      .replace(
        '#include <aomap_fragment>',
        `float gNightMark = 0.0;
        {
          // grass sheen under a low sun: blades catch grazing light; scaled by
          // the shadow the direct term actually received (ratio to unshadowed)
          vec3 gN = normalize(vWNrm);
          float gNdl = max(dot(gN, uSunDirW), 0.0);
          float gExpect = gLuma(uSunCol * gAlb) * gNdl * RECIPROCAL_PI;
          float gLit = clamp(gLuma(reflectedLight.directDiffuse) / max(gExpect, 1e-6), 0.0, 1.0);
          float gLow = (1.0 - smoothstep(0.18, 0.62, uSunDirW.y)) * smoothstep(0.0, 0.06, uSunDirW.y);
          reflectedLight.directDiffuse += uSunCol * gAlb * RECIPROCAL_PI * (gGrassy * gLow * 0.22 * gLit);

          // soft: the layer AO is texture-scale crevice shading, and sky fill
          // still reaches most of it (strong AO crushed shade toward black)
          float occ = mix(1.0, gAO, 0.5);
          reflectedLight.indirectDiffuse *= occ;
          // turf: thin blades pass sky light through, and in sun they shade
          // each other a little, so a lawn's shade stays near the paving's
          // (~20 % of sunlit) instead of sinking to ~16 %
          float gTurf = max(gGrassy - gDry, 0.0);
          reflectedLight.indirectDiffuse *= 1.0 + 0.3 * gTurf;
          reflectedLight.directDiffuse *= 1.0 - 0.1 * gTurf;
          // bright ground (snow): light bouncing between it, nearby sunlit snow
          // and the haze adds a neutral fill the sky-only environment lacks, so
          // shade on snow is a soft grey-blue instead of saturated sky blue
          // light bounced from nearby sunlit snow fills everything in its shade,
          // not only the snow: rock / dirt patches in a snowfield get it too
          ivec2 gTc = ivec2(floor(vWPos.xz / TILE_M));
          float gSnowNear = 0.0;
          gSnowNear += layerAt(gTc) == 5 ? 0.2 : 0.0;
          gSnowNear += layerAt(gTc + ivec2(2, 0)) == 5 ? 0.2 : 0.0;
          gSnowNear += layerAt(gTc + ivec2(-2, 0)) == 5 ? 0.2 : 0.0;
          gSnowNear += layerAt(gTc + ivec2(0, 2)) == 5 ? 0.2 : 0.0;
          gSnowNear += layerAt(gTc + ivec2(0, -2)) == 5 ? 0.2 : 0.0;
          float gBright = max(smoothstep(0.38, 0.55, gLuma(gAlb)), smoothstep(0.35, 0.85, gSnowNear));
          vec3 gInd = reflectedLight.indirectDiffuse;
          reflectedLight.indirectDiffuse = mix(gInd, vec3(gLuma(gInd)), gBright * 0.45) * (1.0 + 0.8 * gBright);
          // moonlit natural ground (NIGHT_GROUND): lifted out of ACES's toe, in its own hue
          ${nightGroundLight('1.0 - max(gBright, gPath)', 'gAlb', 'gNightMark')}
          // under water there is no air/ground specular interface
          reflectedLight.indirectSpecular *= occ * occ * (1.0 - submerged);
          reflectedLight.directSpecular *= 1.0 - submerged;
          reflectedLight.directDiffuse *= mix(1.0, gAO, 0.35);
          #ifdef CLOUD_SHADOWS
            float cshadow = cloudShadowAt(vWPos);
            reflectedLight.directDiffuse *= cshadow;
            reflectedLight.directSpecular *= cshadow;
          #endif
          #ifdef CAUSTICS
          if (underwater > 0.0) {
            float depth = -wy;
            // two drifting line networks at different scales → shimmering caustic web
            float caust = caustA * 0.6 + caustB * 0.4;
            caust = caust * caust;
            float fade = smoothstep(0.12, 0.4, depth) * (1.0 - smoothstep(1.0, 2.2, depth));
            reflectedLight.directDiffuse *= mix(1.0, 0.84 + caust * 0.8, fade);
          }
          #endif
        }`,
      );
  };
  const setOptions = (next: GroundMaterialOptions) => {
    if (next.antiTile === opts.antiTile && next.cloudShadows === opts.cloudShadows && next.caustics === opts.caustics) return;
    Object.assign(opts, next);
    material.defines = definesFor(opts);
    material.needsUpdate = true;
  };
  return { material, uniforms, setOptions };
}
