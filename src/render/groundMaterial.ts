// Ground material shared by the playable terrain and the decorative outer
// landscape: MeshStandardMaterial extended with
//  - per-tile terrain types (index texture) blended between neighbouring tiles
//    with noise-warped, height-aware organic borders;
//  - procedural texture-array sampling with per-layer rotation/scale and macro
//    variation to hide tiling;
//  - path overlay (paved / gravel / boardwalk) with crisp irregular edges;
//  - wet shore band, underwater caustics and drifting cloud shadows.

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
uniform vec2 uCloudOffset;
uniform float uCloudCover;
uniform float uCloudShadow;
varying vec3 vWPos;
varying vec3 vWNrm;

const int MAPW = ${MAP_W};
const int MAPH = ${MAP_H};
const float TILE_M = ${TILE.toFixed(1)};
const float WATER_Y = ${WATER_LEVEL.toFixed(3)};

bool inMap(ivec2 c) { return c.x >= 0 && c.y >= 0 && c.x < MAPW && c.y < MAPH; }

// Ground layer for a tile (terrain type → texture layer). Outside the map:
// meadow, or lake bed / mud where the decorative ground dips to the water line
// (ponds that continue past the border).
float gOuterY;
int layerAt(ivec2 c) {
  if (inMap(c)) {
    int t = int(texelFetch(uTypeTex, c, 0).r * 255.0 + 0.5);
    return t >= 7 ? 7 : t;
  }
  if (gOuterY < WATER_Y - 0.02) return 7;
  if (gOuterY < WATER_Y + 0.12) return 6;
  vec4 n = textureLod(uNoise, vec2(c) * 0.021 + 0.13, 0.0);
  float v = n.r * 0.7 + n.b * 0.3;
  if (v > 0.6) return 1;
  if (v < 0.3 && n.g > 0.55) return 2;
  return 0;
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

GSample sampleGround(vec3 wp, vec4 nzA, vec4 nzB, vec4 nzC) {
  gOuterY = wp.y;
  vec2 tp = wp.xz / TILE_M;
  // organic warp at three scales (≈50 m, 11 m, 2.4 m)
  vec2 warp = (nzA.gb - 0.5) * 2.2 + (nzB.rg - 0.5) * 2.6 + (nzC.rg - 0.5) * 1.3;
  vec2 g = tp + warp - 0.5;
  vec2 ci = floor(g);
  vec2 f = g - ci;
  ivec2 i0 = ivec2(ci);
  int l00 = layerAt(i0);
  int l10 = layerAt(i0 + ivec2(1, 0));
  int l01 = layerAt(i0 + ivec2(0, 1));
  int l11 = layerAt(i0 + ivec2(1, 1));
  if (l00 == l10 && l00 == l01 && l00 == l11) return sampleLayer(l00, wp.xz);
  // plain bilinear weights give rounded iso-lines (no tile staircase)
  vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  GSample a = sampleLayer(l00, wp.xz);
  GSample b = sampleLayer(l10, wp.xz);
  GSample c = sampleLayer(l01, wp.xz);
  GSample d = sampleLayer(l11, wp.xz);
  // height-aware blend: the taller material (grass blades, stones) wins near the border
  vec4 hb = w * 1.5 + vec4(a.h, b.h, c.h, d.h) * 0.5;
  float m = max(max(hb.x, hb.y), max(hb.z, hb.w));
  vec4 wb = max(hb - (m - 0.32), 0.0);
  wb *= wb;
  wb /= max(dot(wb, vec4(1.0)), 1e-5);
  GSample r;
  r.alb = a.alb * wb.x + b.alb * wb.y + c.alb * wb.z + d.alb * wb.w;
  r.slope = a.slope * wb.x + b.slope * wb.y + c.slope * wb.z + d.slope * wb.w;
  r.rough = a.rough * wb.x + b.rough * wb.y + c.rough * wb.z + d.rough * wb.w;
  r.ao = a.ao * wb.x + b.ao * wb.y + c.ao * wb.z + d.ao * wb.w;
  r.h = a.h * wb.x + b.h * wb.y + c.h * wb.z + d.h * wb.w;
  return r;
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
  float edgeNoise = (nzC.g - 0.5) * 0.05 + (texture2D(uNoise, vWPos.xz * 1.7).b - 0.5) * 0.025;
  float tileAA = 0.7 * length(fwidth(vWPos.xz)) / TILE_M + 0.002;
#ifdef CAUSTICS
  vec2 cuv = vWPos.xz * 0.21;
  float caustA = texture2D(uNoise, cuv + vec2(uTime * 0.021, uTime * 0.013)).a;
  float caustB = texture2D(uNoise, cuv * 1.17 + vec2(-uTime * 0.017, uTime * 0.019) + 0.5).a;
#endif
  GSample gs = sampleGround(vWPos, nzA, nzB, nzC);
  vec3 gAlb = gs.alb;
  // macro variation (breaks tiling, natural patchiness)
  float macro = (nzA.r - 0.5) * 1.1 + (nzB.b - 0.5) * 0.8 + (nzC.b - 0.5) * 0.5;
  gAlb *= 1.0 + 0.55 * macro;
  float hueT = smoothstep(0.32, 0.68, nzA.b * 0.55 + nzB.g * 0.45);
  gAlb *= mix(vec3(0.9, 1.0, 1.04), vec3(1.14, 1.02, 0.7), hueT);
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
    }
  }

  // ---- wet shore / underwater darkening
  float wy = vWPos.y - WATER_Y;
  float wet = 1.0 - smoothstep(0.0, 0.16, wy);
  float underwater = 1.0 - smoothstep(-0.02, 0.02, wy);
  gAlb *= mix(1.0, mix(0.62, 0.8, underwater), wet);
  gRough = mix(gRough, 0.45, wet * 0.8);
  diffuseColor.rgb = gAlb;
`;

export function createGroundMaterial(textures: GroundTextureSet, typeTex: THREE.Texture, opts: GroundMaterialOptions): {
  material: THREE.MeshStandardMaterial;
  uniforms: GroundUniforms;
} {
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
    uCloudOffset: { value: new THREE.Vector2() },
    uCloudCover: { value: 0.56 },
    uCloudShadow: { value: 0.45 },
  };
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  material.name = 'ground';
  material.envMapIntensity = 1;
  const defines: Record<string, number> = {};
  if (opts.antiTile) defines.ANTI_TILE = 1;
  if (opts.cloudShadows) defines.CLOUD_SHADOWS = 1;
  if (opts.caustics) defines.CAUSTICS = 1;
  material.defines = defines;
  material.customProgramCacheKey = () => `ground:${opts.antiTile ? 1 : 0}${opts.cloudShadows ? 1 : 0}${opts.caustics ? 1 : 0}`;
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
          float occ = mix(1.0, gAO, 0.85);
          reflectedLight.indirectDiffuse *= occ;
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
            float fade = smoothstep(0.08, 0.35, depth) * (1.0 - smoothstep(1.2, 2.6, depth));
            reflectedLight.directDiffuse *= mix(1.0, 0.7 + caust * 1.6, fade);
          }
          #endif
        }`,
      );
  };
  return { material, uniforms };
}
