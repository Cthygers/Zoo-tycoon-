// Sky dome: samples the CPU atmosphere LUT (Rayleigh with phase + Mie with the
// phase applied per pixel), adds the sun disc, a drifting fbm cloud layer lit
// by the sun colour at cloud altitude, a night sky with stars and a phased
// moon. Drawn last among the opaques at the far plane so terrain occludes it
// (early-z), and reused (without stars / sun disc) for the PMREM environment.

import * as THREE from 'three';
import { SKY_LUT_H, SKY_LUT_W, MIE_G } from './atmosphere';
import { GLSL_HASH } from './glsl';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform sampler2D uRay;
uniform sampler2D uMie;
uniform sampler2D uNoise;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uSunE;
uniform vec3 uSunDisc;
uniform vec3 uMoonColor;
uniform vec3 uCloudSun;
uniform vec3 uCloudAmb;
uniform vec3 uGround;
uniform vec3 uNightSky;
uniform vec3 uHorizonGlow;
uniform float uNight;
uniform float uTime;
uniform vec2 uCloudOffset;
uniform float uCloudCover;
uniform vec3 uTwilightBlue;
uniform float uTwilight;
${GLSL_HASH}

const float LUT_W = ${SKY_LUT_W.toFixed(1)};
const float LUT_H = ${SKY_LUT_H.toFixed(1)};
const float MIE_G = ${MIE_G.toFixed(3)};

float miePhase(float c) {
  float g2 = MIE_G * MIE_G;
  float k = 0.1193662 * (1.0 - g2) / (2.0 + g2);
  return k * (1.0 + c * c) / pow(1.0 + g2 - 2.0 * MIE_G * c, 1.5);
}

vec2 lutUV(vec3 d) {
  float el = asin(clamp(d.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / 1.5707963);
  vec2 dh = d.xz;
  vec2 sh = uSunDir.xz;
  float lh = length(dh), ls = length(sh);
  float c = (lh > 1e-4 && ls > 1e-4) ? dot(dh / lh, sh / ls) : 1.0;
  float u = acos(clamp(c, -1.0, 1.0)) / 3.14159265;
  return vec2((u * (LUT_W - 1.0) + 0.5) / LUT_W, (v * (LUT_H - 1.0) + 0.5) / LUT_H);
}

float cloudField(vec2 p) {
  float n = texture2D(uNoise, p * 0.23).r * 0.5;
  n += texture2D(uNoise, p * 0.61 + 0.37).g * 0.3;
#ifndef ENV_PASS
  n += texture2D(uNoise, p * 1.7 + 0.71).b * 0.2;
#else
  n += 0.1;
#endif
  return n;
}

void main() {
  vec3 d = normalize(vDir);
  float cs = dot(d, uSunDir);
  vec2 uv = lutUV(d);
  vec3 ray = texture2D(uRay, uv).rgb;
  // blue hour: the crude multiple-scattering term leaves the twilight sky
  // purple; pull the Rayleigh part toward a deep blue of equal luminance
  ray = mix(ray, vec3(dot(ray, vec3(0.2126, 0.7152, 0.0722))) * uTwilightBlue, uTwilight);
  vec3 col = uSunE * (ray + texture2D(uMie, uv).rgb * miePhase(cs));

  // night sky: faint blue airglow + warm light-dome near the horizon
  float hz = 1.0 - clamp(d.y, 0.0, 1.0);
  col += uNightSky * (0.55 + 0.45 * hz * hz) + uHorizonGlow * pow(hz, 10.0);

#ifndef ENV_PASS
  if (uNight > 0.01 && d.y > -0.02) {
    // stars
    vec3 sp = d * 260.0;
    vec3 cell = floor(sp);
    float h = hash13(cell);
    if (h > 0.95) {
      vec3 off = (hash33(cell + 3.7) - 0.5) * 0.55;
      float dist = length(fract(sp) - 0.5 - off);
      float px = max(length(fwidth(sp)), 0.05);
      float rad = max(0.09, px * 0.55);
      float mag = pow((h - 0.95) / 0.05, 3.0);
      float tw = 0.75 + 0.25 * sin(uTime * (1.5 + h * 6.0) + h * 91.0);
      vec3 sc = mix(vec3(1.0, 0.82, 0.65), vec3(0.75, 0.85, 1.0), fract(h * 37.0));
      float vis = smoothstep(-0.02, 0.25, d.y);
      col += sc * (0.02 + 0.45 * mag) * tw * smoothstep(rad, rad * 0.25, dist) * uNight * vis * (0.12 / max(rad, 0.12));
    }
    // milky band
    float band = exp(-pow(dot(d, normalize(vec3(0.35, 0.25, -0.9))) * 3.2, 2.0));
    float mw = texture2D(uNoise, vec2(atan(d.x, d.z) * 0.6, d.y * 1.3) * 0.8).g;
    col += vec3(0.6, 0.65, 0.8) * 0.004 * band * smoothstep(0.35, 0.8, mw) * uNight * smoothstep(0.0, 0.3, d.y);
  }
#endif

  // moon disc + halo
  float cm = dot(d, uMoonDir);
  float moonR = 0.0115;
#ifndef ENV_PASS
  if (cm > cos(moonR * 1.3)) {
    vec3 t1 = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 t2 = cross(t1, uMoonDir);
    vec2 q = vec2(dot(d, t1), dot(d, t2)) / moonR;
    float r2 = dot(q, q);
    if (r2 < 1.15) {
      vec3 n = q.x * t1 + q.y * t2 - sqrt(max(0.0, 1.0 - r2)) * uMoonDir;
      n = -n;
      float lit = smoothstep(-0.05, 0.12, dot(n, uSunDir));
      float maria = texture2D(uNoise, q * 0.22 + 0.4).r;
      float alb = 0.75 - 0.35 * smoothstep(0.45, 0.62, maria) + 0.1 * texture2D(uNoise, q * 0.9).b;
      vec3 mc = uMoonColor * alb * (lit + 0.015);
      float a = 1.0 - smoothstep(0.92, 1.0, r2);
      col = mix(col, mc, a * smoothstep(-0.01, 0.01, d.y));
    }
  }
#endif
  col += uMoonColor * (0.0025 * pow(max(cm, 0.0), 300.0) + 0.0006 * pow(max(cm, 0.0), 20.0)) * smoothstep(-0.05, 0.05, d.y);

  // clouds
  if (d.y > 0.0) {
    vec2 cp = d.xz / (d.y + 0.07) + uCloudOffset;
    float n = cloudField(cp);
    float dens = smoothstep(uCloudCover, uCloudCover + 0.2, n);
    if (dens > 0.0) {
      vec2 sdir = uSunDir.xz / max(length(uSunDir.xz), 1e-3);
      float n2 = cloudField(cp + sdir * 0.12);
      float lit = clamp(0.55 + (n - n2) * 5.0, 0.0, 1.0);
      float thick = smoothstep(uCloudCover, uCloudCover + 0.4, n);
      float silver = 1.0 + 3.0 * pow(max(cs, 0.0), 12.0) * (1.0 - thick);
      vec3 cc = uCloudSun * (0.3 + 0.7 * lit) * (1.0 - 0.45 * thick) * silver + uCloudAmb * (1.0 - 0.35 * thick);
      float fade = smoothstep(0.0, 0.2, d.y);
      col = mix(col, cc, dens * fade * 0.92);
    }
  }

  // ground below the horizon (only visible in reflections / env map)
  if (d.y < 0.0) {
    col = mix(col, uGround, smoothstep(0.0, -0.12, d.y));
  }

#ifndef ENV_PASS
  // sun disc with limb darkening
  float sr = 0.0062;
  float sd = 1.0 - smoothstep(cos(sr * 0.75), cos(sr), cs);
  if (sd > 0.0) {
    float rr = clamp(acos(clamp(cs, -1.0, 1.0)) / sr, 0.0, 1.0);
    col += uSunDisc * sd * (0.55 + 0.45 * sqrt(max(0.0, 1.0 - rr * rr))) * smoothstep(-0.01, 0.005, d.y);
  }
#endif

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface SkyUniforms {
  [uniform: string]: THREE.IUniform;
  uRay: THREE.IUniform<THREE.Texture>;
  uMie: THREE.IUniform<THREE.Texture>;
  uNoise: THREE.IUniform<THREE.Texture | null>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uSunE: THREE.IUniform<number>;
  uSunDisc: THREE.IUniform<THREE.Color>;
  uMoonColor: THREE.IUniform<THREE.Color>;
  uCloudSun: THREE.IUniform<THREE.Color>;
  uCloudAmb: THREE.IUniform<THREE.Color>;
  uGround: THREE.IUniform<THREE.Color>;
  uNightSky: THREE.IUniform<THREE.Color>;
  uHorizonGlow: THREE.IUniform<THREE.Color>;
  uNight: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uCloudOffset: THREE.IUniform<THREE.Vector2>;
  uCloudCover: THREE.IUniform<number>;
  uTwilightBlue: THREE.IUniform<THREE.Color>;
  uTwilight: THREE.IUniform<number>;
}

export class SkyDome {
  readonly uniforms: SkyUniforms;
  readonly mesh: THREE.Mesh;
  /** Same sky without stars / sun disc for PMREM capture. */
  readonly envMesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private envMat: THREE.ShaderMaterial;

  constructor(rayTex: THREE.Texture, mieTex: THREE.Texture, noise: THREE.Texture | null) {
    this.uniforms = {
      uRay: { value: rayTex },
      uMie: { value: mieTex },
      uNoise: { value: noise },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunE: { value: 1 },
      uSunDisc: { value: new THREE.Color(0, 0, 0) },
      uMoonColor: { value: new THREE.Color(0, 0, 0) },
      uCloudSun: { value: new THREE.Color(1, 1, 1) },
      uCloudAmb: { value: new THREE.Color(0.2, 0.25, 0.3) },
      uGround: { value: new THREE.Color(0.05, 0.05, 0.04) },
      uNightSky: { value: new THREE.Color(0, 0, 0) },
      uHorizonGlow: { value: new THREE.Color(0, 0, 0) },
      uNight: { value: 0 },
      uTime: { value: 0 },
      uCloudOffset: { value: new THREE.Vector2(0, 0) },
      uCloudCover: { value: 0.56 },
      uTwilightBlue: { value: new THREE.Color(0.646, 0.999, 2.056) },
      uTwilight: { value: 0 },
    };
    this.geo = new THREE.SphereGeometry(1, 48, 24);
    const common = {
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    };
    this.mat = new THREE.ShaderMaterial(common);
    this.envMat = new THREE.ShaderMaterial({ ...common, defines: { ENV_PASS: 1 } });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000; // after opaque geometry → early-z rejects covered pixels
    this.mesh.name = 'sky';
    this.envMesh = new THREE.Mesh(this.geo, this.envMat);
    this.envMesh.frustumCulled = false;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.envMat.dispose();
  }
}
