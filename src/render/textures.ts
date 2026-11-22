// One-time GPU generation of all procedural ground textures:
//  - a texture array with one layer per ground material (terrain types, lake
//    bed and path surfaces): layer A = sqrt(albedo).rgb + height, layer B =
//    encoded height slope (xy) + roughness + cavity AO;
//  - a tileable 4-channel noise texture (macro variation, clouds, caustics);
//  - a tileable water wave normal map.
// Everything is rendered with full-screen passes into render targets, so it
// costs a few milliseconds on the GPU and no CPU time. Render targets are lost
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
    vec3 g1 = srgb(58.0, 78.0, 30.0), g2 = srgb(92.0, 114.0, 46.0), g3 = srgb(130.0, 138.0, 66.0);
    c = mix(g1, g2, smoothstep(0.0, 0.7, r));
    c = mix(c, g3, smoothstep(0.75, 1.0, r));
    if (fract(r * 13.7) > 0.94) c = srgb(150.0, 140.0, 92.0);
  } else {
    vec3 s1 = srgb(150.0, 128.0, 82.0), s2 = srgb(192.0, 172.0, 120.0), s3 = srgb(128.0, 122.0, 100.0);
    c = mix(s1, s2, smoothstep(0.0, 0.8, r));
    if (fract(r * 7.31) > 0.8) c = mix(c, s3, 0.7);
    if (fract(r * 17.3) > 0.9) c = srgb(122.0, 124.0, 70.0);
  }
  return c * (0.72 + 0.45 * t);
}

Surf grassLike(vec2 uv, bool dry) {
  Surf s;
  float macro = pfbm(uv, 3.0, 4, dry ? 3.0 : 1.0);
  vec3 soil = dry ? srgb(122.0, 104.0, 76.0) : srgb(40.0, 52.0, 24.0);
  soil *= 0.8 + 0.4 * (0.5 + 0.5 * pfbm(uv, 24.0, 3, 4.0));
  s.alb = soil;
  s.h = 0.1 + 0.1 * pfbm(uv, 12.0, 3, 2.0);
  float n0 = dry ? 44.0 : 60.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float n = n0 * (1.0 + fk * 0.55);
    vec4 b = blades(uv, floor(n), dry ? 1.25 : 1.05, dry ? 0.15 : 0.19, 13.0 * fk + (dry ? 50.0 : 0.0));
    if (dry && k == 2 && hash12(vec2(b.z, 3.0)) > 0.6) continue;
    float hh = 0.25 + 0.75 * b.y - fk * 0.04;
    if (b.x > 0.0 && hh > s.h) {
      vec3 bc = grassBladeColor(fract(b.z + macro * 0.25), b.w, dry);
      s.alb = mix(s.alb, bc, b.x);
      s.h = mix(s.h, hh, b.x);
    }
  }
  s.alb *= 0.92 + 0.16 * macro;
  s.rough = dry ? 0.92 : 0.88;
  s.ao = mix(0.55, 1.0, smoothstep(0.1, 0.6, s.h));
  return s;
}

Surf dirt(vec2 uv) {
  Surf s;
  float n1 = pfbm(uv, 4.0, 5, 21.0);
  float n2 = pfbm(uv, 32.0, 3, 22.0);
  s.alb = mix(srgb(96.0, 82.0, 62.0), srgb(126.0, 110.0, 84.0), 0.5 + 0.5 * n1);
  s.alb *= 0.9 + 0.2 * (0.5 + 0.5 * n2);
  s.h = 0.35 + 0.15 * n1 + 0.08 * n2;
  // faint dry cracks
  vec4 cr = pvoronoi(uv, 7.0, 0.9, 23.0);
  float crack = 1.0 - smoothstep(0.0, 0.035, cr.y - cr.x);
  s.alb *= 1.0 - 0.3 * crack * smoothstep(-0.2, 0.4, n1);
  s.h -= 0.15 * crack;
  // pebbles
  vec4 v = pvoronoi(uv, 36.0, 0.9, 24.0);
  float r = 0.18 + 0.2 * fract(v.z * 7.0);
  if (v.z > 0.55) {
    float m = 1.0 - smoothstep(r * 0.75, r, v.x);
    vec3 pc = mix(srgb(150.0, 140.0, 124.0), srgb(110.0, 100.0, 88.0), fract(v.z * 13.0));
    s.alb = mix(s.alb, pc, m);
    s.h = max(s.h, mix(s.h, 0.6 + 0.4 * sqrt(max(0.0, 1.0 - (v.x * v.x) / (r * r))), m));
  }
  // sparse straw
  vec4 b = blades(uv, 22.0, 1.1, 0.07, 25.0);
  if (fract(b.z * 5.3) > 0.55) {
    s.alb = mix(s.alb, srgb(160.0, 140.0, 96.0) * (0.8 + 0.3 * b.w), b.x * 0.85);
    s.h = mix(s.h, 0.7, b.x * 0.8);
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

Surf rock(vec2 uv) {
  Surf s;
  // dark gravelly soil matrix
  float fine = pfbm(uv, 48.0, 3, 41.0);
  s.alb = mix(srgb(62.0, 57.0, 50.0), srgb(88.0, 82.0, 72.0), 0.5 + 0.5 * fine);
  s.h = 0.12 + 0.06 * fine;
  vec4 g = pvoronoi(uv, 70.0, 0.9, 42.0);
  float gm = 1.0 - smoothstep(0.28, 0.42, g.x);
  s.alb = mix(s.alb, mix(srgb(118.0, 112.0, 104.0), srgb(84.0, 80.0, 74.0), g.z), gm * 0.8);
  s.h = max(s.h, 0.16 + 0.12 * gm);
  // rounded embedded stones at three sizes (≈65, 35, 18 cm)
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float n = k == 0 ? 6.0 : (k == 1 ? 11.0 : 22.0);
    vec4 v = pvoronoi(uv, n, 0.85, 43.0 + fk * 5.0);
    float keep = k == 0 ? 0.45 : (k == 1 ? 0.35 : 0.3);
    if (v.z < keep) continue;
    float r = 0.33 + 0.14 * fract(v.z * 7.0);
    float d = v.x + 0.06 * pnoise(uv * n * 4.0 + v.z * 9.0, vec2(n * 4.0));
    float m = 1.0 - smoothstep(r * 0.82, r, d);
    float dome = sqrt(max(0.0, 1.0 - (d * d) / (r * r)));
    float hh = 0.3 + 0.62 * dome * (1.0 - 0.18 * fk);
    float t = fract(v.z * 11.0);
    vec3 sc = t < 0.35 ? srgb(122.0, 118.0, 110.0) : (t < 0.6 ? srgb(98.0, 94.0, 88.0) : (t < 0.85 ? srgb(132.0, 122.0, 106.0) : srgb(84.0, 84.0, 82.0)));
    float surf = pfbm(uv, n * 6.0, 3, 44.0 + fk);
    sc *= 0.85 + 0.28 * (0.5 + 0.5 * surf);
    float li = smoothstep(0.5, 0.72, pfbm(uv, n * 3.0, 3, 45.0 + fk));
    sc = mix(sc, srgb(130.0, 132.0, 88.0), li * 0.45 * step(0.55, fract(v.z * 9.0)) * dome);
    if (hh > s.h && m > 0.0) {
      s.alb = mix(s.alb, sc * (0.75 + 0.25 * dome), m);
      s.h = mix(s.h, hh + 0.04 * surf, m);
    }
  }
  s.rough = 0.84;
  s.ao = mix(0.4, 1.0, smoothstep(0.1, 0.55, s.h));
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

export interface GroundTextureSet {
  /** sqrt(albedo).rgb + height, one layer per GroundLayer. */
  readonly albedo: THREE.DataArrayTexture;
  /** slope.xy (encoded 0.5 + s/4) + roughness + cavity AO. */
  readonly detail: THREE.DataArrayTexture;
  /** Tileable 256² noise: r,g,b = fbm at 4/8/16 cells, a = caustic web. */
  readonly noise: THREE.Texture;
  /** Tileable wave slope map: rg = slope (0.5 + s/2), b = height. */
  readonly waves: THREE.Texture;
}

/** Owns and (re)generates the procedural ground textures. */
export class GroundTextures implements GroundTextureSet {
  private heightRT: THREE.WebGLArrayRenderTarget;
  private detailRT: THREE.WebGLArrayRenderTarget;
  private noiseRT: THREE.WebGLRenderTarget;
  private wavesRT: THREE.WebGLRenderTarget;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private groundMat: THREE.RawShaderMaterial;
  private detailMat: THREE.RawShaderMaterial;
  private noiseMat: THREE.RawShaderMaterial;
  private wavesMat: THREE.RawShaderMaterial;

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

  /** Render every texture. Call once at start-up and after a context restore. */
  generate(): void {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.autoClear = false;

    this.quad.material = this.noiseMat;
    r.setRenderTarget(this.noiseRT);
    r.render(this.quadScene, this.quadCam);
    this.quad.material = this.wavesMat;
    r.setRenderTarget(this.wavesRT);
    r.render(this.quadScene, this.quadCam);

    for (let pass = 0; pass < 2; pass++) {
      const rt = pass === 0 ? this.heightRT : this.detailRT;
      const mat = pass === 0 ? this.groundMat : this.detailMat;
      const u = mat.uniforms;
      this.quad.material = mat;
      for (let layer = 0; layer < GROUND_LAYERS; layer++) {
        rt.texture.mipmapsAutoUpdate = layer === GROUND_LAYERS - 1;
        u.uLayer.value = layer;
        if (u.uSlopeScale) u.uSlopeScale.value = LAYER_RELIEF_M[layer] / (LAYER_SIZE_M[layer] / this.resolution);
        r.setRenderTarget(rt, layer);
        r.render(this.quadScene, this.quadCam);
      }
      rt.texture.mipmapsAutoUpdate = true;
    }
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.xr.enabled = prevXr;
  }

  dispose(): void {
    this.heightRT.dispose();
    this.detailRT.dispose();
    this.noiseRT.dispose();
    this.wavesRT.dispose();
    this.groundMat.dispose();
    this.detailMat.dispose();
    this.noiseMat.dispose();
    this.wavesMat.dispose();
    this.quad.geometry.dispose();
  }
}
