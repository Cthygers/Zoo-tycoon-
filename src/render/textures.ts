// One-time GPU generation of all procedural ground textures:
//  - a texture array with one layer per ground material (terrain types, lake
//    bed and path surfaces): layer A = sqrt(albedo).rgb + height, layer B =
//    encoded height slope (xy) + roughness + cavity AO;
//  - a tileable 4-channel noise texture (macro variation, clouds, caustics);
//  - a tileable water wave normal map.
// Everything is rendered with full-screen passes into render targets: no CPU
// time, but the ground shaders are heavy, so on slow GPUs the passes take long
// enough to stall the main thread at its next GPU sync. While loading,
// `generateAsync()` compiles the programs in parallel and submits the work in
// small passes, waiting for the GPU between batches. Render targets are lost
// with the GL context, so `generate()` must be called again after a restore.

import * as THREE from 'three';
import { GLSL_COLOR, GLSL_HASH, GLSL_PNOISE } from './glsl';

/** Texture-array layer per ground material. */
export const GroundLayer = {
  Grass: 0,
  DryGrass: 1,
  Dirt: 2,
  Sand: 3,
  Rock: 4,
  Snow: 5,
  Mud: 6,
  LakeBed: 7,
  Paved: 8,
  Gravel: 9,
  Boardwalk: 10,
} as const;
export const GROUND_LAYERS = 11;
/** World-space size (metres) covered by one repeat of each layer. */
export const LAYER_SIZE_M = [3, 3.5, 3, 4, 4, 4, 3, 4, 2, 2, 2];
/** Height range (metres) represented by the 0..1 height channel (drives normal strength). */
export const LAYER_RELIEF_M = [0.008, 0.008, 0.007, 0.004, 0.04, 0.03, 0.007, 0.008, 0.005, 0.01, 0.005];

const VERT = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const GROUND_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 outColor;
uniform int uLayer;
uniform float uRes;
#ifdef DETAIL_PASS
uniform sampler2DArray uHeightArr;
uniform float uSlopeScale; // relief metres / texel metres
#endif
${GLSL_HASH}
${GLSL_PNOISE}
${GLSL_COLOR}

struct Surf { vec3 alb; float h; float rough; float ao; };

// Scatter of tapered blades seen from above (one per cell).
// Returns: x = coverage, y = blade top height, z = blade hash, w = position along blade.
vec4 blades(vec2 uv, float n, float len, float wid, float seed) {
  vec2 p = uv * n;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec4 best = vec4(0.0, -1.0, 0.0, 0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 c = mod(i + o, vec2(n));
      vec3 h = hash32(c + seed);
      vec2 root = o + h.xy;
      float ang = h.z * 6.2831853;
      vec2 dir = vec2(cos(ang), sin(ang));
      float L = len * (0.55 + 0.9 * hash12(c * 1.37 + seed + 5.1));
      vec2 pa = f - root;
      float t = clamp(dot(pa, dir) / L, 0.0, 1.0);
      float d = length(pa - dir * (L * t));
      float w = wid * (1.0 - 0.75 * t);
      float m = 1.0 - smoothstep(w * 0.45, w, d);
      float top = hash12(c + seed * 2.3 + 9.7) * 0.7 + 0.3 * t;
      if (m > 0.02 && top > best.y) best = vec4(m, top, hash12(c * 0.71 + seed + 1.9), t);
    }
  if (best.y < 0.0) best.y = 0.0;
  return best;
}

vec3 grassBladeColor(float r, float t, bool dry) {
  vec3 c;
  if (!dry) {
    // fresh lawn: olive → spring green, a few blue-green and yellowed / dead blades
    vec3 g1 = srgb(82.0, 104.0, 50.0), g2 = srgb(110.0, 134.0, 64.0), g3 = srgb(142.0, 154.0, 84.0);
    c = mix(g1, g2, smoothstep(0.0, 0.7, r));
    c = mix(c, g3, smoothstep(0.78, 1.0, r));
    float k = fract(r * 13.7);
    if (k > 0.93) c = srgb(168.0, 156.0, 104.0);
    else if (k < 0.08) c = srgb(86.0, 116.0, 78.0);
  } else {
    // straw → pale straw, some grey-weathered and olive (still living) blades
    vec3 s1 = srgb(152.0, 134.0, 93.0), s2 = srgb(180.0, 163.0, 118.0), s3 = srgb(136.0, 130.0, 106.0);
    c = mix(s1, s2, smoothstep(0.0, 0.8, r));
    if (fract(r * 7.31) > 0.8) c = mix(c, s3, 0.7);
    if (fract(r * 17.3) > 0.86) c = srgb(124.0, 126.0, 76.0);
  }
  return c * (dry ? 0.88 + 0.18 * t : 0.8 + 0.3 * t);
}

Surf grassLike(vec2 uv, bool dry) {
  Surf s;
  float macro = pfbm(uv, 3.0, 4, dry ? 3.0 : 1.0);
  // thatch / soil between the blades (seldom visible, never black)
  // (dry thatch close to the blades in value: bright blades on dark soil read as speckle)
  vec3 soil = dry ? srgb(128.0, 114.0, 82.0) : srgb(74.0, 74.0, 46.0);
  soil *= 0.85 + 0.3 * (0.5 + 0.5 * pfbm(uv, 24.0, 3, 4.0));
  s.alb = soil;
  s.h = 0.1 + 0.1 * pfbm(uv, 12.0, 3, 2.0);
  float n0 = dry ? 44.0 : 52.0;
  // sparse areas show more thatch
  float thin = smoothstep(0.25, 0.6, pfbm(uv, 6.0, 3, dry ? 8.0 : 9.0));
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float n = n0 * (1.0 + fk * 0.6);
    vec4 b = blades(uv, floor(n), dry ? 1.25 : 1.15, dry ? 0.18 : 0.2, 13.0 * fk + (dry ? 50.0 : 0.0));
    if (dry && k == 2 && hash12(vec2(b.z, 3.0)) > 0.6) continue;
    if (k == 2 && hash12(vec2(b.z, 5.0)) < thin * 0.7) continue;
    float hh = 0.25 + 0.75 * b.y - fk * 0.04;
    if (b.x > 0.0 && hh > s.h) {
      vec3 bc = grassBladeColor(fract(b.z + macro * 0.3), b.w, dry);
      s.alb = mix(s.alb, bc, b.x);
      s.h = mix(s.h, hh, b.x);
    }
  }
  if (!dry) {
    // clover patches: round trifoliate leaves, flatter and bluer than the grass
    float clover = smoothstep(0.18, 0.42, pfbm(uv, 5.0, 3, 17.0));
    vec4 v = pvoronoi(uv, 46.0, 0.9, 18.0);
    float leaf = (1.0 - smoothstep(0.26, 0.36, v.x)) * step(0.35, v.z) * clover;
    vec3 lc = mix(srgb(78.0, 112.0, 62.0), srgb(96.0, 128.0, 70.0), fract(v.z * 7.0));
    s.alb = mix(s.alb, lc * (0.86 + 0.2 * sqrt(max(0.0, 1.0 - v.x / 0.36))), leaf);
    s.h = mix(s.h, 0.55, leaf * 0.8);
    // the odd daisy
    vec4 fl = pvoronoi(uv, 30.0, 0.8, 19.0);
    float daisy = (1.0 - smoothstep(0.08, 0.12, fl.x)) * step(0.965, fl.z);
    s.alb = mix(s.alb, fl.x < 0.04 ? srgb(220.0, 180.0, 60.0) : srgb(232.0, 230.0, 220.0), daisy);
    s.h = max(s.h, 0.9 * daisy);
  }
  s.alb *= 0.94 + 0.12 * macro;
  s.rough = dry ? 0.92 : 0.86;
  s.ao = mix(0.68, 1.0, smoothstep(0.1, 0.6, s.h));
  return s;
}

// Crack network of a dried crust: x = F2 − F1 (≈ twice the distance to the
// crack, cell units), y = hash of the crack segment (the same for both cells
// it separates), z = cell hash. n cells across, periodic.
vec3 crackNet(vec2 uv, float n, float jitter, float seed) {
  vec2 p = uv * n;
  vec2 i = floor(p);
  vec2 f = p - i;
  float f1 = 8.0, f2 = 8.0;
  vec2 c1 = vec2(0.0), c2 = vec2(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 c = mod(i + o, vec2(n));
      vec2 r = o + 0.5 + (hash22(c + seed * 7.31) - 0.5) * jitter - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; c2 = c1; f1 = d; c1 = c; }
      else if (d < f2) { f2 = d; c2 = c; }
    }
  float h1 = hash12(c1 + seed * 3.17 + 11.0);
  float h2 = hash12(c2 + seed * 3.17 + 11.0);
  return vec3(sqrt(f2) - sqrt(f1), hash12(vec2(min(h1, h2), max(h1, h2)) * 91.7 + seed), h1);
}

Surf dirt(vec2 uv) {
  Surf s;
  float n1 = pfbm(uv, 4.0, 5, 21.0);
  float n2 = pfbm(uv, 32.0, 3, 22.0);
  s.alb = mix(srgb(96.0, 82.0, 62.0), srgb(126.0, 110.0, 84.0), 0.5 + 0.5 * n1);
  s.alb *= 0.9 + 0.2 * (0.5 + 0.5 * n2);
  s.h = 0.35 + 0.15 * n1 + 0.08 * n2;
  // dried crust, mostly in the drier patches: cracks whose width and depth
  // wander with low-frequency noise, about a third of the segments missing
  // (cells merge into bigger, irregular plates), plate edges curled up (a
  // lighter lifted lip, then a darker cupped rim) and fine grain, so it reads
  // as a dried wallow rather than crazy paving
  float dry = smoothstep(-0.25, 0.35, n1);
  vec2 cuv = uv + 0.01 * vec2(pfbm(uv, 11.0, 2, 26.0), pfbm(uv, 11.0, 2, 27.0));
  vec3 cn = crackNet(cuv, 7.0, 0.9, 23.0);
  float wv = 0.5 + 0.5 * pfbm(uv, 5.0, 3, 28.0);
  float open = smoothstep(0.32, 0.42, cn.y) * dry;
  float w = mix(0.012, 0.07, wv * wv) * open;
  float e = cn.x;
  float crack = (1.0 - smoothstep(w * 0.4, w + 0.004, e)) * open;
  float lip = smoothstep(w, w + 0.025, e) * (1.0 - smoothstep(w + 0.05, w + 0.12, e)) * open;
  float rim = smoothstep(w + 0.07, w + 0.13, e) * (1.0 - smoothstep(w + 0.16, w + 0.34, e)) * open;
  s.alb *= (1.0 - crack * mix(0.2, 0.55, wv)) * (1.0 + 0.08 * lip - 0.06 * rim);
  s.alb *= 1.0 + 0.08 * (hash12(floor(uv * uRes) + 5.3) - 0.5);
  s.h += 0.06 * lip - 0.03 * rim - 0.22 * crack;
  // a few pebbles, close to the soil in value (small bright flecks read as noise)
  vec4 v = pvoronoi(uv, 20.0, 0.9, 24.0);
  float r = 0.16 + 0.18 * fract(v.z * 7.0);
  if (v.z > 0.84) {
    float m = 1.0 - smoothstep(r * 0.7, r, v.x);
    vec3 pc = mix(s.alb * vec3(1.2, 1.18, 1.16), srgb(104.0, 96.0, 86.0), 0.35 + 0.4 * fract(v.z * 13.0));
    s.alb = mix(s.alb, pc, m);
    s.h = max(s.h, mix(s.h, 0.55 + 0.35 * sqrt(max(0.0, 1.0 - (v.x * v.x) / (r * r))), m));
  }
  // a little dull straw
  vec4 b = blades(uv, 22.0, 1.1, 0.08, 25.0);
  if (fract(b.z * 5.3) > 0.7) {
    s.alb = mix(s.alb, srgb(128.0, 112.0, 78.0) * (0.85 + 0.2 * b.w), b.x * 0.7);
    s.h = mix(s.h, 0.65, b.x * 0.7);
  }
  s.rough = 0.95;
  s.ao = mix(0.6, 1.0, smoothstep(0.1, 0.5, s.h));
  return s;
}

Surf sand(vec2 uv) {
  Surf s;
  float warp = pfbm(uv, 3.0, 3, 31.0) * 1.4 + pfbm(uv, 7.0, 2, 32.0) * 0.35;
  float ph = dot(uv, vec2(5.0, 38.0)) + warp;
  float f = fract(ph);
  float prof = f < 0.72 ? smoothstep(0.0, 0.72, f) : 1.0 - smoothstep(0.72, 1.0, f);
  float amp = 0.45 + 0.55 * smoothstep(-0.4, 0.5, pfbm(uv, 2.0, 3, 33.0));
  s.h = 0.4 + 0.45 * prof * amp + 0.05 * pfbm(uv, 64.0, 2, 34.0);
  float grain = hash12(floor(uv * uRes * 1.0)) - 0.5;
  s.alb = srgb(168.0, 150.0, 116.0) * (0.95 + 0.12 * grain);
  s.alb *= 0.92 + 0.1 * prof;
  s.alb = mix(s.alb, srgb(150.0, 128.0, 96.0), 0.4 * (0.5 + 0.5 * pfbm(uv, 4.0, 4, 35.0)));
  float spk = hash12(floor(uv * uRes) + 7.7);
  if (spk > 0.985) s.alb *= 0.55;
  s.rough = 0.95;
  s.ao = mix(0.8, 1.0, prof);
  return s;
}

// Periodic voronoi that also returns the offset to the nearest feature point:
// xy = feature − p (cell units), z = F2 − F1 (≈ twice the distance to the
// cell border, so insets give angular polygons), w = cell hash.
vec4 pvorEdge(vec2 uv, float n, float seed) {
  vec2 p = uv * n;
  vec2 i = floor(p);
  vec2 f = p - i;
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  vec2 o1 = vec2(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 c = mod(i + o, vec2(n));
      vec2 r = o + hash22(c + seed * 7.31) - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; o1 = r; id = hash12(c + seed * 3.17 + 11.0); }
      else if (d < f2) { f2 = d; }
    }
  return vec4(o1, sqrt(f2) - sqrt(f1), id);
}

// Rocky ground: gritty soil and fine gravel, a few large weathered bedrock
// slabs split by cracks, and sparse angular scree of very different sizes.
// Stones and soil are close in value (dark grout lines read as paving).
Surf rock(vec2 uv) {
  Surf s;
  float big = pfbm(uv, 2.0, 3, 41.0);
  float fine = pfbm(uv, 40.0, 3, 42.0);
  s.alb = mix(srgb(94.0, 88.0, 78.0), srgb(118.0, 110.0, 97.0), 0.5 + 0.5 * fine);
  s.alb *= 0.92 + 0.12 * big;
  s.h = 0.14 + 0.05 * fine;
  vec4 g = pvoronoi(uv, 64.0, 1.0, 43.0);
  float gm = (1.0 - smoothstep(0.2, 0.4, g.x)) * step(0.4, g.z);
  s.alb = mix(s.alb, mix(srgb(126.0, 120.0, 110.0), srgb(98.0, 94.0, 86.0), fract(g.z * 7.0)), gm * 0.6);
  s.h = max(s.h, 0.17 + 0.08 * gm);

  // exposed bedrock: irregular, partly buried patches (crisp edges from a
  // thresholded noise field, rounded rims) split by a polygonal crack network
  vec2 w = 0.06 * vec2(pfbm(uv, 5.0, 2, 44.0), pfbm(uv, 5.0, 2, 45.0));
  float bed = pfbm(uv + w, 2.0, 5, 46.0);
  float slab = smoothstep(0.1, 0.14, bed);
  if (slab > 0.0) {
    float surf = pfbm(uv, 12.0, 4, 47.0);
    vec4 ic = pvoronoi(uv + w, 7.0, 1.0, 48.0);
    float crack = 1.0 - smoothstep(0.0, 0.04, ic.y - ic.x);
    vec3 sc = mix(srgb(114.0, 110.0, 102.0), srgb(130.0, 122.0, 106.0), fract(ic.z * 13.0));
    sc *= 0.88 + 0.18 * (0.5 + 0.5 * surf);
    float lichen = smoothstep(0.35, 0.6, pfbm(uv, 16.0, 3, 49.0)) * step(0.4, fract(ic.z * 3.7));
    sc = mix(sc, srgb(132.0, 134.0, 96.0), lichen * 0.45);
    sc *= 1.0 - 0.3 * crack;
    float hh = 0.42 + 0.22 * smoothstep(0.12, 0.32, bed) + 0.06 * surf - 0.18 * crack;
    s.alb = mix(s.alb, sc, slab);
    s.h = mix(s.h, hh, slab);
  }

  // scree: angular stones (inset voronoi polygons), tilted flat tops
  for (int k = 0; k < 2; k++) {
    float n = k == 0 ? 9.0 : 19.0;
    vec4 v = pvorEdge(uv + w * 0.5, n, 50.0 + float(k) * 3.0);
    if (fract(v.w * 3.1) < (k == 0 ? 0.6 : 0.75)) continue;
    float inset = 0.18 + 0.45 * fract(v.w * 7.3);
    float m = smoothstep(inset, inset + 0.06, v.z);
    if (m <= 0.0) continue;
    vec2 tilt = vec2(fract(v.w * 17.0), fract(v.w * 23.0)) - 0.5;
    float top = 0.42 + 0.22 * smoothstep(inset, inset + 0.25, v.z) + dot(v.xy, tilt) * 0.3 - float(k) * 0.08;
    if (top < s.h) continue;
    float t = fract(v.w * 11.0);
    vec3 sc = t < 0.4 ? srgb(120.0, 115.0, 107.0) : (t < 0.7 ? srgb(104.0, 100.0, 93.0) : (t < 0.9 ? srgb(128.0, 118.0, 101.0) : srgb(96.0, 95.0, 92.0)));
    sc *= 0.86 + 0.2 * (0.5 + 0.5 * pfbm(uv, n * 4.0, 2, 51.0 + float(k)));
    sc *= 0.88 + 0.12 * smoothstep(inset, inset + 0.2, v.z);
    s.alb = mix(s.alb, sc, m);
    s.h = mix(s.h, top, m);
  }
  s.rough = 0.86;
  s.ao = mix(0.72, 1.0, smoothstep(0.1, 0.5, s.h));
  return s;
}

Surf snow(vec2 uv) {
  Surf s;
  float n1 = pfbm(uv, 3.0, 5, 51.0);
  float n2 = pfbm(uv, 20.0, 3, 52.0);
  s.h = 0.5 + 0.35 * n1 + 0.1 * n2;
  s.alb = mix(srgb(186.0, 194.0, 208.0), srgb(214.0, 218.0, 224.0), smoothstep(-0.4, 0.6, n1 + n2 * 0.3));
  float spk = hash12(floor(uv * uRes) + 3.1);
  s.rough = 0.62 + 0.15 * n2 - (spk > 0.97 ? 0.4 : 0.0);
  s.ao = mix(0.8, 1.0, smoothstep(0.2, 0.7, s.h));
  return s;
}

Surf mud(vec2 uv) {
  Surf s;
  float n1 = pfbm(uv, 3.0, 5, 61.0);
  float n2 = pfbm(uv, 24.0, 3, 62.0);
  s.h = 0.45 + 0.3 * n1 + 0.08 * n2;
  s.alb = mix(srgb(70.0, 54.0, 40.0), srgb(100.0, 80.0, 58.0), 0.5 + 0.5 * n2);
  s.rough = 0.75 - 0.2 * smoothstep(0.0, -0.3, n1);
  // hoof prints
  vec4 v = pvoronoi(uv, 9.0, 0.9, 63.0);
  if (v.z > 0.72) {
    float r = 0.16 + 0.06 * fract(v.z * 7.0);
    float m = 1.0 - smoothstep(r * 0.7, r, v.x);
    s.h -= 0.15 * m;
    s.rough -= 0.12 * m;
    s.alb *= 1.0 - 0.12 * m;
  }
  // puddles
  float pud = smoothstep(-0.3, -0.42, n1);
  s.alb = mix(s.alb, srgb(42.0, 34.0, 27.0), pud);
  s.h = mix(s.h, 0.12, pud);
  s.rough = mix(s.rough, 0.25, pud);
  // straw bits
  vec4 b = blades(uv, 18.0, 1.0, 0.07, 64.0);
  if (fract(b.z * 3.3) > 0.7 && pud < 0.5) {
    s.alb = mix(s.alb, srgb(120.0, 100.0, 66.0) * (0.8 + 0.3 * b.w), b.x * 0.7);
    s.h = mix(s.h, 0.75, b.x * 0.6);
  }
  s.ao = mix(0.6, 1.0, smoothstep(0.0, 0.5, s.h));
  return s;
}

Surf lakeBed(vec2 uv) {
  Surf s;
  float n1 = pfbm(uv, 3.0, 4, 71.0);
  float n2 = pfbm(uv, 28.0, 3, 72.0);
  // silt with algae-stained patches
  s.alb = mix(srgb(88.0, 80.0, 60.0), srgb(62.0, 70.0, 42.0), smoothstep(-0.2, 0.5, n1));
  s.alb *= 0.88 + 0.24 * (0.5 + 0.5 * n2);
  s.h = 0.35 + 0.2 * n1 + 0.06 * n2;
  // sparse, irregular pebbles in clusters
  float cluster = smoothstep(0.05, 0.45, pfbm(uv, 5.0, 3, 74.0));
  for (int k = 0; k < 2; k++) {
    float n = k == 0 ? 18.0 : 34.0;
    vec4 v = pvoronoi(uv, n, 1.0, 73.0 + float(k) * 4.0);
    if (v.z > cluster * 0.75) continue;
    float r = 0.16 + 0.22 * fract(v.z * 5.0);
    float d = v.x + 0.07 * pnoise(uv * n * 3.0 + v.z * 7.0, vec2(n * 3.0));
    float m = 1.0 - smoothstep(r * 0.7, r, d);
    vec3 pc = mix(srgb(112.0, 106.0, 94.0), srgb(84.0, 80.0, 72.0), fract(v.z * 17.0));
    s.alb = mix(s.alb, pc, m * 0.85);
    s.h = mix(s.h, 0.5 + 0.35 * sqrt(max(0.0, 1.0 - d * d / (r * r))), m);
  }
  s.rough = 0.6;
  s.ao = mix(0.6, 1.0, smoothstep(0.2, 0.6, s.h));
  return s;
}

bool paveBoundary(float row, float k) {
  k = mod(k, 8.0);
  if (mod(k, 2.0) > 0.5) return false;
  if (k == mod(row * 6.0, 8.0)) return true;
  return hash12(vec2(row * 3.1 + 1.0, k + 0.5)) > 0.4;
}

Surf paved(vec2 uv) {
  Surf s;
  vec2 p = uv * 2.0;
  float row = floor(p.y / 0.5);
  float rowW = mod(row, 4.0);
  float x = p.x + mod(row, 2.0) * 0.25;
  float k = floor(x / 0.25);
  float a = k;
  for (int i = 0; i < 8; i++) { if (paveBoundary(rowW, a)) break; a -= 1.0; }
  float b = k + 1.0;
  for (int i = 0; i < 8; i++) { if (paveBoundary(rowW, b)) break; b += 1.0; }
  float lx = x - a * 0.25;
  float w = (b - a) * 0.25;
  float ly = p.y - row * 0.5;
  float edge = min(min(lx, w - lx), min(ly, 0.5 - ly));
  float id = hash12(vec2(rowW, mod(a, 8.0)) + 9.1);
  float grain = pfbm(uv, 160.0, 2, 81.0);
  float spk = hash12(floor(uv * uRes) + 2.3);
  vec3 stone = srgb(160.0, 154.0, 143.0);
  stone = mix(stone, srgb(166.0, 152.0, 130.0), step(0.6, id) * 0.6);
  stone = mix(stone, srgb(140.0, 142.0, 140.0), step(id, 0.25) * 0.6);
  stone *= 0.92 + 0.16 * fract(id * 7.7);
  stone *= 0.93 + 0.1 * grain;
  if (spk > 0.9) stone *= 0.82;
  else if (spk < 0.06) stone *= 1.1;
  // wear and grime near joints, faint stains
  float stain = smoothstep(0.2, 0.7, pfbm(uv, 3.0, 4, 82.0));
  stone *= 1.0 - 0.12 * stain;
  stone *= 1.0 - 0.14 * (1.0 - smoothstep(0.0, 0.05, edge));
  vec3 grout = srgb(86.0, 80.0, 70.0) * (0.85 + 0.2 * grain);
  float gm = smoothstep(0.004, 0.008, edge);
  s.alb = mix(grout, stone, gm);
  float bevel = smoothstep(0.004, 0.022, edge);
  s.h = 0.15 + 0.7 * bevel + 0.08 * grain * gm;
  // occasional hairline crack
  if (fract(id * 31.0) > 0.85) {
    float c = abs(dot(vec2(lx, ly) - vec2(w * 0.5, 0.25), normalize(vec2(fract(id * 5.0) - 0.5, 0.7))) + 0.01 * pfbm(uv, 40.0, 2, 83.0));
    float cm = 1.0 - smoothstep(0.0, 0.0035, c);
    s.alb *= 1.0 - 0.45 * cm * gm;
    s.h -= 0.2 * cm * gm;
  }
  s.rough = mix(0.9, 0.72 + 0.1 * grain, gm);
  s.ao = mix(0.45, 1.0, bevel);
  return s;
}

Surf gravel(vec2 uv) {
  Surf s;
  float n = pfbm(uv, 64.0, 3, 91.0);
  s.alb = srgb(104.0, 96.0, 82.0) * (0.82 + 0.3 * (0.5 + 0.5 * n));
  s.h = 0.2 + 0.08 * n;
  for (int k = 0; k < 3; k++) {
    float cells = k == 0 ? 52.0 : (k == 1 ? 84.0 : 130.0);
    vec4 v = pvoronoi(uv, cells, 0.9, 92.0 + float(k) * 3.0);
    if (v.z < 0.25) continue;
    float r = 0.3 + 0.16 * fract(v.z * 7.0);
    float m = 1.0 - smoothstep(r * 0.72, r, v.x);
    float dome = sqrt(max(0.0, 1.0 - v.x * v.x / (r * r)));
    float hh = 0.35 + 0.55 * dome - float(k) * 0.1;
    float t = fract(v.z * 13.0);
    vec3 sc = t < 0.3 ? srgb(150.0, 143.0, 130.0) : (t < 0.55 ? srgb(112.0, 106.0, 98.0) : (t < 0.8 ? srgb(138.0, 120.0, 96.0) : srgb(88.0, 84.0, 80.0)));
    sc *= 0.72 + 0.4 * dome;
    if (hh > s.h) {
      s.alb = mix(s.alb, sc, m);
      s.h = mix(s.h, hh, m);
    }
  }
  s.rough = 0.86;
  s.ao = mix(0.5, 1.0, smoothstep(0.15, 0.6, s.h));
  return s;
}

Surf boardwalk(vec2 uv) {
  Surf s;
  float boards = 13.0;
  float bi = floor(uv.y * boards);
  float lv = fract(uv.y * boards);
  float id = hash12(vec2(bi, 4.2));
  // joints at u=0.5 for some boards
  float jointU = 0.5;
  float seg = (id > 0.5 && uv.x > jointU) ? 1.0 : 0.0;
  float sid = hash12(vec2(bi, seg + 7.0));
  float grain = pnoise(vec2(uv.x * 3.0, uv.y * boards * 10.0) + sid * 13.0, vec2(3.0, boards * 10.0));
  float fine = pnoise(vec2(uv.x * 12.0, uv.y * boards * 40.0), vec2(12.0, boards * 40.0));
  float rings = sin((lv * 2.5 + grain * 1.2 + sid * 10.0) * 6.2831853 * 1.5);
  vec3 wood = mix(srgb(126.0, 96.0, 68.0), srgb(146.0, 138.0, 124.0), smoothstep(0.3, 0.9, sid));
  wood *= 0.9 + 0.08 * rings + 0.06 * fine;
  wood *= 0.9 + 0.2 * fract(sid * 9.1);
  float gap = smoothstep(0.03, 0.07, lv) * (1.0 - smoothstep(0.93, 0.97, lv));
  float edgeRound = smoothstep(0.03, 0.2, lv) * (1.0 - smoothstep(0.8, 0.97, lv));
  // board-end joint line
  float jl = id > 0.5 ? 1.0 - smoothstep(0.0, 0.003, abs(uv.x - jointU)) : 0.0;
  // nails over joists every 0.5 m
  float nx = fract(uv.x * 4.0 + 0.5) - 0.5;
  float nail = 0.0;
  nail = max(nail, 1.0 - smoothstep(0.004, 0.007, length(vec2(nx * 0.5, (lv - 0.27) / boards * 2.0))));
  nail = max(nail, 1.0 - smoothstep(0.004, 0.007, length(vec2(nx * 0.5, (lv - 0.73) / boards * 2.0))));
  vec3 gapC = srgb(28.0, 24.0, 20.0);
  s.alb = mix(gapC, wood, gap);
  s.alb *= 1.0 - 0.6 * jl;
  s.alb = mix(s.alb, srgb(60.0, 56.0, 52.0), nail);
  s.h = gap * (0.55 + 0.35 * edgeRound + 0.04 * grain) - 0.3 * jl;
  s.rough = mix(0.95, 0.74 + 0.08 * fine, gap);
  s.ao = mix(0.35, 1.0, gap);
  return s;
}

Surf groundSurf(int layer, vec2 uv) {
  if (layer == 0) return grassLike(uv, false);
  if (layer == 1) return grassLike(uv, true);
  if (layer == 2) return dirt(uv);
  if (layer == 3) return sand(uv);
  if (layer == 4) return rock(uv);
  if (layer == 5) return snow(uv);
  if (layer == 6) return mud(uv);
  if (layer == 7) return lakeBed(uv);
  if (layer == 8) return paved(uv);
  if (layer == 9) return gravel(uv);
  return boardwalk(uv);
}

void main() {
  vec2 uv = (floor(vUv * uRes) + 0.5) / uRes;
#ifndef DETAIL_PASS
  Surf s = groundSurf(uLayer, uv);
  outColor = vec4(sqrt(clamp(s.alb, 0.0, 1.0)), clamp(s.h, 0.0, 1.0));
#else
  {
    ivec2 c = ivec2(floor(vUv * uRes));
    int r = int(uRes);
    float hl = texelFetch(uHeightArr, ivec3((c.x + r - 1) % r, c.y, uLayer), 0).a;
    float hr = texelFetch(uHeightArr, ivec3((c.x + 1) % r, c.y, uLayer), 0).a;
    float hd = texelFetch(uHeightArr, ivec3(c.x, (c.y + r - 1) % r, uLayer), 0).a;
    float hu = texelFetch(uHeightArr, ivec3(c.x, (c.y + 1) % r, uLayer), 0).a;
    vec2 slope = vec2(hr - hl, hu - hd) * 0.5 * uSlopeScale;
    Surf s = groundSurf(uLayer, uv);
    outColor = vec4(clamp(0.5 + slope * 0.25, 0.0, 1.0), clamp(s.rough, 0.02, 1.0), clamp(s.ao, 0.0, 1.0));
  }
#endif
}
`;

const NOISE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform float uRes;
${GLSL_HASH}
${GLSL_PNOISE}
void main() {
  vec2 uv = (floor(vUv * uRes) + 0.5) / uRes;
  float a = pfbm(uv, 4.0, 6, 1.0);
  float b = pfbm(uv, 8.0, 5, 2.0);
  float c = pfbm(uv, 16.0, 4, 3.0);
  // caustic-like web: smooth voronoi edge distance
  vec4 v = pvoronoi(uv + 0.03 * vec2(pfbm(uv, 4.0, 2, 5.0), pfbm(uv, 4.0, 2, 6.0)), 10.0, 0.85, 4.0);
  float web = 1.0 - smoothstep(0.0, 0.16, v.y - v.x);
  outColor = vec4(0.5 + 0.5 * a, 0.5 + 0.5 * b, 0.5 + 0.5 * c, web);
}
`;

const WAVE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform float uRes;
${GLSL_HASH}
${GLSL_PNOISE}
float waves(vec2 uv) {
  float h = 0.0, amp = 1.0, n = 4.0;
  for (int o = 0; o < 5; o++) {
    float v = pnoise(uv * n + float(o) * 7.3, vec2(n));
    h += amp * (1.0 - abs(v)) ;
    amp *= 0.5;
    n *= 2.0;
  }
  return h;
}
void main() {
  vec2 uv = vUv;
  float e = 1.0 / uRes;
  float h = waves(uv);
  float hx = waves(uv + vec2(e, 0.0)) - waves(uv - vec2(e, 0.0));
  float hy = waves(uv + vec2(0.0, e)) - waves(uv - vec2(0.0, e));
  vec2 slope = vec2(hx, hy) * 0.5 / e * 0.012;
  outColor = vec4(clamp(0.5 + slope * 0.5, 0.0, 1.0), h * 0.5, 1.0);
}
`;

const FOLIAGE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform float uRes;
${GLSL_HASH}
${GLSL_PNOISE}

// Nearest jittered feature point: xy = offset from the point to p (cell units),
// z = distance, w = cell hash.
vec4 vor(vec2 p, float seed) {
  vec2 i = floor(p);
  vec2 f = p - i;
  float best = 9.0;
  vec2 bo = vec2(0.0);
  float id = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 r = o + 0.15 + 0.7 * hash22(i + o + seed * 13.1) - f;
      float d = dot(r, r);
      if (d < best) { best = d; bo = r; id = hash12(i + o + seed * 7.7); }
    }
  return vec4(-bo, sqrt(best), id);
}

// One foliage clump seen from the side: x = albedo brightness, yz = normal xy
// (sprite plane, 0.5 + n/2), w = coverage.
// Broadleaf leaf mass: lumpy round clump of leaf clusters.
vec4 leafClump(vec2 uv, float seed) {
  vec2 p = uv * 2.0 - 1.0;
  float r = length(p);
  float ang = atan(p.y, p.x) / 6.2831853 + 0.5;
  float R = 0.64 + 0.1 * pnoise(vec2(ang * 5.0, seed * 3.1), vec2(5.0, 4096.0)) + 0.06 * pnoise(vec2(ang * 11.0, seed * 1.7 + 5.0), vec2(11.0, 4096.0));
  vec4 c1 = vor(p * 6.5 + seed * 3.7, seed);
  float dome1 = sqrt(clamp(1.0 - c1.z / 0.65, 0.0, 1.0));
  vec4 c2 = vor(p * 17.5 + seed * 1.3, seed + 4.0);
  float dome2 = sqrt(clamp(1.0 - c2.z / 0.62, 0.0, 1.0));
  float fn = pnoise(p * 9.0 + seed * 5.3, vec2(4096.0));
  float edge = R - r + 0.12 * (dome1 - 0.55) + 0.1 * (dome2 - 0.5) + 0.035 * fn;
  float a = smoothstep(-0.01, 0.01, edge);
  // a few small see-through gaps between leaf masses
  float gap = pfbm(uv + seed * 0.37, 6.0, 3, seed + 9.0);
  a *= smoothstep(-0.52, -0.42, gap - 0.25 * (1.0 - smoothstep(0.0, 0.5, R - r)));
  vec2 n = clamp(p / max(R, 0.3) * 0.45 + c1.xy * 0.75 * 0.5 + c2.xy * 0.2, vec2(-0.95), vec2(0.95));
  float bright = (0.7 + 0.3 * c1.w) * (0.66 + 0.34 * dome1) * (0.78 + 0.22 * dome2) * (0.9 + 0.1 * fn);
  bright *= 0.72 + 0.28 * smoothstep(0.15, 0.9, r / max(R, 0.3));
  return vec4(bright, n * 0.5 + 0.5, a);
}

// Conifer branch tier: pointed tip at +0.9, ragged drooping base at -0.75,
// base half-width 0.82, serrated sides made of hanging branch ends.
vec4 needleTier(vec2 uv, float seed) {
  vec2 p = uv * 2.0 - 1.0;
  float w = 0.82 * clamp((0.9 - p.y) / 1.65, 0.0, 1.0);
  vec4 c2 = vor(p * vec2(14.0, 20.0) + seed * 1.3, seed + 4.0);
  float dome2 = sqrt(clamp(1.0 - c2.z / 0.62, 0.0, 1.0));
  float saw = 0.5 + 0.5 * sin(p.y * 24.0 + seed * 2.0 + abs(p.x) * 5.0);
  float side = w - abs(p.x) + 0.07 * (saw - 0.5) * smoothstep(0.05, 0.3, w) + 0.05 * (dome2 - 0.5);
  // drooping lower edge: lower at the middle, curling up toward the tips
  float bottom = p.y + 0.75 - 0.18 * (abs(p.x) / 0.82) + 0.05 * (dome2 - 0.5);
  float edge = min(side, bottom * 0.8);
  float a = smoothstep(-0.01, 0.01, edge);
  a *= 1.0 - smoothstep(0.9, 0.97, max(abs(p.x), abs(p.y)));
  vec2 n = clamp(vec2(p.x / max(w, 0.15) * 0.65, 0.3 - 0.4 * smoothstep(0.0, 0.25, -bottom + 0.25)) + c2.xy * 0.25, vec2(-0.95), vec2(0.95));
  float bright = (0.72 + 0.28 * c2.w) * (0.68 + 0.32 * dome2);
  bright *= 0.84 + 0.16 * (0.5 + 0.5 * sin(p.x * 70.0 + c2.w * 6.28 + p.y * 9.0));
  bright *= 0.75 + 0.25 * smoothstep(0.0, 0.5, w - abs(p.x) < 0.12 ? 1.0 : 0.3); // tips catch more light
  return vec4(bright, n * 0.5 + 0.5, a);
}

vec4 clump(vec2 uv, float seed, bool needle) {
  return needle ? needleTier(uv, seed) : leafClump(uv, seed);
}

void main() {
  vec2 uv = (floor(vUv * uRes) + 0.5) / uRes;
  // 2×2 atlas: 0,1 broadleaf clumps; 2,3 conifer clumps
  vec2 t = floor(uv * 2.0);
  vec2 lu = fract(uv * 2.0);
  float v = t.x + 2.0 * t.y;
  vec4 c = clump(lu, 1.0 + v * 2.3, v >= 2.0);
  outColor = vec4(clamp(c.rgb, 0.0, 1.0), c.a);
}
`;

/** Texels one generation pass renders at most (bounds the GPU work in flight while loading). */
const PASS_TEXELS = 256 * 256;
/** GPU time a batch of loading passes should take; fast GPUs batch many passes per round trip. */
const BATCH_MS = 60;

/**
 * Resolves once the GPU has executed every command submitted so far. Polls a
 * fence between tasks instead of blocking the main thread; gives up after a
 * while (e.g. context loss) rather than hanging the caller.
 */
function gpuDone(gl: WebGL2RenderingContext, timeoutMs = 8000): Promise<void> {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return Promise.resolve();
  gl.flush();
  const t0 = performance.now();
  return new Promise((resolve) => {
    const poll = () => {
      if (gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED || performance.now() - t0 > timeoutMs) {
        gl.deleteSync(sync);
        resolve();
      } else setTimeout(poll, 4);
    };
    setTimeout(poll, 0);
  });
}

export interface GroundTextureSet {
  /** sqrt(albedo).rgb + height, one layer per GroundLayer. */
  readonly albedo: THREE.DataArrayTexture;
  /** slope.xy (encoded 0.5 + s/4) + roughness + cavity AO. */
  readonly detail: THREE.DataArrayTexture;
  /** Tileable 256² noise: r,g,b = fbm at 4/8/16 cells, a = caustic web. */
  readonly noise: THREE.Texture;
  /** Tileable wave slope map: rg = slope (0.5 + s/2), b = height. */
  readonly waves: THREE.Texture;
  /** 2×2 foliage clump atlas (distant trees): r = albedo, gb = normal xy, a = coverage. */
  readonly foliage: THREE.Texture;
}

/** Owns and (re)generates the procedural ground textures. */
export class GroundTextures implements GroundTextureSet {
  private heightRT: THREE.WebGLArrayRenderTarget;
  private detailRT: THREE.WebGLArrayRenderTarget;
  private noiseRT: THREE.WebGLRenderTarget;
  private wavesRT: THREE.WebGLRenderTarget;
  private foliageRT: THREE.WebGLRenderTarget;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private groundMat: THREE.RawShaderMaterial;
  private detailMat: THREE.RawShaderMaterial;
  private noiseMat: THREE.RawShaderMaterial;
  private wavesMat: THREE.RawShaderMaterial;
  private foliageMat: THREE.RawShaderMaterial;

  constructor(
    private renderer: THREE.WebGLRenderer,
    readonly resolution: number,
    anisotropy: number,
  ) {
    const arrOpts: THREE.RenderTargetOptions = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      anisotropy,
    };
    this.heightRT = new THREE.WebGLArrayRenderTarget(resolution, resolution, GROUND_LAYERS, arrOpts);
    this.detailRT = new THREE.WebGLArrayRenderTarget(resolution, resolution, GROUND_LAYERS, arrOpts);
    for (const rt of [this.heightRT, this.detailRT]) {
      rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping;
      rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
      rt.texture.generateMipmaps = true;
      rt.texture.anisotropy = anisotropy;
    }
    const flatOpts: THREE.RenderTargetOptions = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
    };
    this.noiseRT = new THREE.WebGLRenderTarget(256, 256, flatOpts);
    this.wavesRT = new THREE.WebGLRenderTarget(256, 256, { ...flatOpts, anisotropy });
    const fRes = resolution >= 512 ? 512 : 256;
    this.foliageRT = new THREE.WebGLRenderTarget(fRes, fRes, { ...flatOpts, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });

    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.groundMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: GROUND_FRAG,
      uniforms: {
        uLayer: { value: 0 },
        uRes: { value: resolution },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.detailMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: GROUND_FRAG,
      defines: { DETAIL_PASS: 1 },
      uniforms: {
        uLayer: { value: 0 },
        uRes: { value: resolution },
        uHeightArr: { value: this.heightRT.texture },
        uSlopeScale: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.noiseMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: NOISE_FRAG,
      uniforms: { uRes: { value: 256 } },
      depthTest: false,
      depthWrite: false,
    });
    this.wavesMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: WAVE_FRAG,
      uniforms: { uRes: { value: 256 } },
      depthTest: false,
      depthWrite: false,
    });
    this.foliageMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FOLIAGE_FRAG,
      uniforms: { uRes: { value: fRes } },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(tri, this.groundMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  get albedo(): THREE.DataArrayTexture {
    return this.heightRT.texture;
  }
  get detail(): THREE.DataArrayTexture {
    return this.detailRT.texture;
  }
  get noise(): THREE.Texture {
    return this.noiseRT.texture;
  }
  get waves(): THREE.Texture {
    return this.wavesRT.texture;
  }
  get foliage(): THREE.Texture {
    return this.foliageRT.texture;
  }

  /** Render every texture at once (after a context restore or a tier change). */
  generate(): void {
    for (const pass of this.passes()) this.run(pass);
  }

  /**
   * Render every texture without long main-thread stalls (loading): compile the
   * programs in parallel, then submit the passes in batches, waiting for the GPU
   * to finish each batch so that little work is ever queued (any GPU sync then
   * stalls briefly). Batches start at one pass and are sized from the measured
   * time per pass: slow GPUs keep one pass per round trip, fast ones finish in a
   * few.
   */
  async generateAsync(): Promise<void> {
    const programs = new THREE.Scene();
    for (const m of [this.noiseMat, this.wavesMat, this.foliageMat, this.groundMat, this.detailMat]) {
      const mesh = new THREE.Mesh(this.quad.geometry, m);
      mesh.frustumCulled = false;
      programs.add(mesh);
    }
    await this.renderer.compileAsync(programs, this.quadCam);
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const passes = this.passes();
    let msPerPass = BATCH_MS;
    for (let i = 0; i < passes.length; ) {
      const n = Math.min(Math.max(1, Math.floor(BATCH_MS / msPerPass)), passes.length - i);
      const t0 = performance.now();
      for (const end = i + n; i < end; i++) this.run(passes[i]);
      await gpuDone(gl);
      // layers differ in cost: shrink at once, grow at most 2× per batch
      msPerPass = Math.max((performance.now() - t0) / n, msPerPass / 2);
    }
  }

  /**
   * All generation work as ordered passes of at most PASS_TEXELS texels: every
   * ground layer (in row bands at high resolution) of the albedo / height array
   * and of the detail array that derives from it, then the flat textures. (The
   * heavy grass layer comes first, so batch sizing starts from a pessimistic
   * measurement.)
   */
  private passes(): (() => void)[] {
    const out: (() => void)[] = [];
    const res = this.resolution;
    const bandRows = Math.max(1, Math.floor(PASS_TEXELS / res));
    for (let pass = 0; pass < 2; pass++) {
      const rt = pass === 0 ? this.heightRT : this.detailRT;
      const mat = pass === 0 ? this.groundMat : this.detailMat;
      const u = mat.uniforms;
      for (let layer = 0; layer < GROUND_LAYERS; layer++)
        for (let y = 0; y < res; y += bandRows) {
          const rows = Math.min(bandRows, res - y);
          out.push(() => {
            // mipmaps once, after the last band of the last layer
            rt.texture.mipmapsAutoUpdate = layer === GROUND_LAYERS - 1 && y + rows >= res;
            u.uLayer.value = layer;
            if (u.uSlopeScale) u.uSlopeScale.value = LAYER_RELIEF_M[layer] / (LAYER_SIZE_M[layer] / res);
            rt.scissor.set(0, y, res, rows);
            rt.scissorTest = rows < res;
            this.draw(mat, rt, layer);
            rt.scissorTest = false;
          });
        }
    }
    out.push(
      () => this.draw(this.noiseMat, this.noiseRT),
      () => this.draw(this.wavesMat, this.wavesRT),
      () => this.draw(this.foliageMat, this.foliageRT),
    );
    return out;
  }

  /** Run one pass with the renderer state it needs, restoring the caller's. */
  private run(pass: () => void): void {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.autoClear = false;
    pass();
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.xr.enabled = prevXr;
  }

  private draw(mat: THREE.RawShaderMaterial, rt: THREE.WebGLRenderTarget | THREE.WebGLArrayRenderTarget, layer = 0): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(rt, layer);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  dispose(): void {
    this.heightRT.dispose();
    this.detailRT.dispose();
    this.noiseRT.dispose();
    this.wavesRT.dispose();
    this.foliageRT.dispose();
    this.foliageMat.dispose();
    this.groundMat.dispose();
    this.detailMat.dispose();
    this.noiseMat.dispose();
    this.wavesMat.dispose();
    this.quad.geometry.dispose();
  }
}
