// GLSL snippets shared by the creature materials (WebGL2 / GLSL ES 3.0 via three).

export const NOISE_GLSL = /* glsl */ `
float cr_hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float cr_vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(cr_hash13(i), cr_hash13(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(cr_hash13(i + vec3(0.0, 1.0, 0.0)), cr_hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(cr_hash13(i + vec3(0.0, 0.0, 1.0)), cr_hash13(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(cr_hash13(i + vec3(0.0, 1.0, 1.0)), cr_hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
// Cellular (Worley F2-F1) edge distance for cracked hide.
float cr_cells(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = vec3(cr_hash13(i + g), cr_hash13(i + g + 17.3), cr_hash13(i + g + 41.7));
    vec3 r = g + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return sqrt(d2) - sqrt(d1);
}
// Bump-mapped normal from a scalar height using screen-space derivatives.
vec3 cr_bump(vec3 surfPos, vec3 n, float h) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1);
  float dhx = dFdx(h);
  float dhy = dFdy(h);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * n - grad);
}
`;

/**
 * `crHighlightOf(light, h)` (→ vec3) for the end of a standard material's
 * fragment shader, e.g. at `#include <opaque_fragment>` (needs `irradiance`, `iblIrradiance`,
 * `nonPerturbedNormal` and `geometryViewDir` from the normal and lighting chunks). `h` is the pulsing highlight
 * amount (0.16 … 0.32, see highlightPulse in model.ts): a +4 % lift of the lit colour
 * and a warm Fresnel rim along the silhouette, at its edge about half as bright
 * as a white surface in the scene's light (sky plus part of the key light on
 * level ground, so shaded sides at a low sun don't wash out). Scaled to the
 * scene light it reads on dark and pale coats in full sun, at dusk and at night
 * alike, while the coat's own colour (the inner surface) stays within a few
 * per cent. `crHighlightFurOf(light, h, fur)` dims the rim on long hair (fur =
 * extra strand length, manes ≈ 2.6): the deep folds of a mane face away from
 * the camera and would light up as bright streaks inside the silhouette.
 */
export const HIGHLIGHT_FN_GLSL = /* glsl */ `
vec3 crHighlight(vec3 light, float h, vec3 sceneIrradiance, vec3 n, vec3 v, float rimK) {
  float k = clamp(h * 3.2, 0.0, 1.0);
  float rim = 1.0 - saturate(dot(n, v));
  rim *= rim;
  rim *= rim * rimK;
  float white = dot(sceneIrradiance * RECIPROCAL_PI, vec3(0.2126, 0.7152, 0.0722));
  return light * (1.0 + 0.04 * k) + vec3(1.0, 0.8, 0.42) * (0.5 * rim * k * white);
}
#if NUM_DIR_LIGHTS > 0
// the key light (sun or moon) falling on level ground
#define crKeyLevel() (directionalLights[0].color * saturate(dot(directionalLights[0].direction, (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)))
#else
#define crKeyLevel() vec3(0.0)
#endif
// the rim follows the surface's own normal: fur / hide micro-normals would speckle it
#define crHighlightOf(light, h) crHighlight(light, h, irradiance + iblIrradiance + 0.6 * crKeyLevel(), nonPerturbedNormal, geometryViewDir, 1.0)
#define crHighlightFurOf(light, h, fur) crHighlight(light, h, irradiance + iblIrradiance + 0.6 * crKeyLevel(), nonPerturbedNormal, geometryViewDir, 1.0 / (1.0 + 2.5 * max(fur, 0.0)))
`;
