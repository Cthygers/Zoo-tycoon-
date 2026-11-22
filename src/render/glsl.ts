// Shared GLSL snippets (hashes, periodic noise, voronoi). Plain strings so they
// can be pasted into RawShaderMaterial / onBeforeCompile code.

/** Sine-free hashes (Dave Hoskins style), stable in highp on mobile GPUs. */
export const GLSL_HASH = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
`;

/** Periodic (tileable) gradient noise, fbm and voronoi. Requires GLSL_HASH. */
export const GLSL_PNOISE = /* glsl */ `
vec2 pgrad(vec2 c) {
  float a = hash12(c) * 6.2831853;
  return vec2(cos(a), sin(a));
}
// Gradient noise in ~[-1,1], periodic with integer period 'per' (in cells).
float pnoise(vec2 p, vec2 per) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 i0 = mod(i, per);
  vec2 i1 = mod(i + 1.0, per);
  float a = dot(pgrad(i0), f);
  float b = dot(pgrad(vec2(i1.x, i0.y)), f - vec2(1.0, 0.0));
  float c = dot(pgrad(vec2(i0.x, i1.y)), f - vec2(0.0, 1.0));
  float d = dot(pgrad(i1), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.45;
}
// fbm of tileable noise. uv in [0,1) over the texture, n = base cells across.
float pfbm(vec2 uv, float n, int oct, float seed) {
  float s = 0.0, amp = 0.5, norm = 0.0;
  vec2 off = vec2(seed * 17.13, seed * 31.71);
  for (int o = 0; o < 8; o++) {
    if (o >= oct) break;
    s += amp * pnoise(uv * n + off, vec2(n));
    norm += amp;
    amp *= 0.5;
    n *= 2.0;
  }
  return s / norm;
}
// Periodic voronoi: x = F1, y = F2, z = cell id hash, w = unused. n cells across.
vec4 pvoronoi(vec2 uv, float n, float jitter, float seed) {
  vec2 p = uv * n;
  vec2 i = floor(p);
  vec2 f = p - i;
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 c = mod(i + o, vec2(n));
      vec2 r = o + 0.5 + (hash22(c + seed * 7.31) - 0.5) * jitter - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; id = hash12(c + seed * 3.17 + 11.0); }
      else if (d < f2) { f2 = d; }
    }
  return vec4(sqrt(f1), sqrt(f2), id, 0.0);
}
`;

/** sRGB (0..255) to linear helper for authoring colours inside shaders. */
export const GLSL_COLOR = /* glsl */ `
vec3 srgb(float r, float g, float b) { return pow(vec3(r, g, b) / 255.0, vec3(2.2)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;
