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
//    lawn hue shifts (lusher, yellowing, sun-bleached patches);
//  - path overlay (paved / gravel / boardwalk) with crisp irregular edges;
//  - wet shore band, per-channel underwater absorption of the lake bed,
//    caustics and drifting cloud shadows;
//  - low-sun "sheen" on grass (blades catch grazing light that a flat
//    ground normal would miss), respecting shadows.
//
// Texture fetches per pixel (typical lawn pixel, low tier): 4 tile texels +
// 4 noise + 2 layer (albedo, detail); transitions add 2.

import * as THREE from 'three';
import { MAP_H, MAP_W, TILE, WATER_LEVEL } from '../core/constants';
import { GROUND_LAYERS, LAYER_SIZE_M, type GroundTextureSet } from './textures';

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
varying vec3 vWPos;
varying vec3 vWNrm;

const int MAPW = ${MAP_W};
const int MAPH = ${MAP_H};
const float TILE_M = ${TILE.toFixed(1)};
const float WATER_Y = ${WATER_LEVEL.toFixed(3)};
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
// and sheen), and of the dry-grass layer alone.
float gGrassy;
float gDry;

GSample sampleGround(vec3 wp, vec4 nzA, vec4 nzB, vec4 nzC, vec4 nzD) {
  gOuterY = wp.y;
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
    GSample a = sampleLayer(base, wp.xz);
    gGrassy = base == 0 ? 1.0 : 0.0;
    gDry = 0.0;
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
  if (L0 == L1 && L0 == L2 && L0 == L3) {
    gGrassy = L0 <= 1 ? 1.0 : 0.0;
    gDry = L0 == 1 ? 1.0 : 0.0;
    return sampleLayer(L0, wp.xz);
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
  gGrassy = mix(A <= 1 ? 1.0 : 0.0, B <= 1 ? 1.0 : 0.0, m);
  gDry = mix(A == 1 ? 1.0 : 0.0, B == 1 ? 1.0 : 0.0, m);
  return mixSample(a, b, m);
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
  GSample gs = sampleGround(vWPos, nzA, nzB, nzC, nzD);
  vec3 gAlb = gs.alb;
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
    }
  }

  // ---- wet shore band, underwater absorption of the bed (per channel:
  //      red goes first, then green → teal shallows, dark deep pools)
  float wy = vWPos.y - WATER_Y;
  float wet = 1.0 - smoothstep(0.0, 0.16, wy);
  float underwater = 1.0 - smoothstep(-0.02, 0.02, wy);
  gAlb *= mix(1.0, mix(0.62, 0.82, underwater), wet);
  gRough = mix(gRough, 0.45, wet * 0.8);
  if (underwater > 0.0) {
    // light path down to the bed and back up to the eye (the down leg is
    // shorter than the view leg under a high sun)
    float wd = max(-wy, 0.0);
    float vy = max(normalize(cameraPosition - vWPos).y, 0.25);
    float path = wd / vy + wd * 0.4;
    gAlb *= mix(vec3(1.0), exp(-path * vec3(0.5, 0.19, 0.14)), underwater);
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
      .replace(
        '#include <aomap_fragment>',
        `{
          // grass sheen under a low sun: blades catch grazing light; scaled by
          // the shadow the direct term actually received (ratio to unshadowed)
          vec3 gN = normalize(vWNrm);
          float gNdl = max(dot(gN, uSunDirW), 0.0);
          float gExpect = gLuma(uSunCol * gAlb) * gNdl * RECIPROCAL_PI;
          float gLit = clamp(gLuma(reflectedLight.directDiffuse) / max(gExpect, 1e-6), 0.0, 1.0);
          float gLow = (1.0 - smoothstep(0.18, 0.62, uSunDirW.y)) * smoothstep(0.0, 0.06, uSunDirW.y);
          reflectedLight.directDiffuse += uSunCol * gAlb * RECIPROCAL_PI * (gGrassy * gLow * 0.22 * gLit);

          float occ = mix(1.0, gAO, 0.85);
          reflectedLight.indirectDiffuse *= occ;
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
          // under water there is no air/ground specular interface
          reflectedLight.indirectSpecular *= occ * occ * (1.0 - underwater);
          reflectedLight.directSpecular *= 1.0 - underwater;
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
