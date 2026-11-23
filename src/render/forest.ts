// Distant forest around the map, drawn as instanced "sprite-cloud" trees: each
// tree is a narrow camera-facing trunk card plus a handful of camera-facing
// foliage-clump sprites placed on the crown volume (an ellipsoid for
// broadleaves, a stacked cone for conifers). The clumps sample a procedurally
// painted 2×2 atlas (textures.ts) holding albedo, a sprite-space normal and
// coverage; lighting combines the crown-volume normal of each sprite with the
// per-pixel clump normal, so crowns get a lit side, a shaded side, self-shadow
// toward the bottom and soft translucency against the sun — from any view
// angle, including straight down. Two templates per kind (detailed near the
// map, sparse further out) keep it at ~7k triangles on low and ~19k on
// medium in 4 draw calls. Fog (aerial perspective) comes from the scene fog.

import * as THREE from 'three';

export interface ForestTree {
  x: number;
  y: number;
  z: number;
  /** Total tree height (m). */
  h: number;
  /** 0 = broadleaf, 1 = conifer. */
  kind: 0 | 1;
  rot: number;
  /** Crown width multiplier (~0.8..1.25). */
  width: number;
  /** Linear albedo of the foliage. */
  color: THREE.Color;
  /** Use the detailed template (close to the map). */
  near: boolean;
}

export interface ForestUniforms {
  [k: string]: THREE.IUniform;
  uAtlas: THREE.IUniform<THREE.Texture>;
  uAtlasRes: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunE: THREE.IUniform<THREE.Color>;
  uSkyE: THREE.IUniform<THREE.Color>;
  uGroundE: THREE.IUniform<THREE.Color>;
  uTime: THREE.IUniform<number>;
}

interface Sprite {
  x: number;
  y: number;
  z: number;
  /** Half size (unit tree height). */
  size: number;
  /** Atlas tile 0..3, or -1 for the trunk card. */
  variant: number;
  rot: number;
  /** Ambient occlusion / depth-in-crown shade 0..1. */
  shade: number;
  nx: number;
  ny: number;
  nz: number;
}

function rngFrom(seed: number): () => number {
  let s = Math.max(1, Math.floor(seed) % 2147483647);
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Visible radius of a clump relative to its sprite half size (atlas coverage). */
const CLUMP_R = 0.6;

/** Broadleaf: ellipsoid crown on a short trunk (unit height). */
function broadleafSprites(n: number, seed: number): Sprite[] {
  const rnd = rngFrom(seed);
  const cy = 0.57,
    rx = 0.3,
    ry = 0.31;
  const out: Sprite[] = [];
  // trunk card: from the ground into the crown
  out.push({ x: 0, y: 0, z: 0, size: 0.016, variant: -1, rot: 0, shade: 0.6, nx: 0, ny: 0, nz: 1 });
  // a core sprite fills the middle, the rest sit on a shell (golden spiral, upper 85 %)
  const core = n >= 7 ? 1 : 0;
  if (core) out.push({ x: 0, y: cy, z: 0, size: (rx * 0.75) / CLUMP_R, variant: Math.floor(rnd() * 2), rot: rnd() * 6.28, shade: 0.6, nx: 0, ny: 0.3, nz: 0 });
  const shellN = n - core;
  // union of clump discs ≈ 1.6 × the crown's silhouette area
  const v = Math.sqrt((1.6 * rx * ry) / shellN);
  for (let i = 0; i < shellN; i++) {
    const t = (i + 0.5) / shellN;
    const yy = 1 - t * 1.75; // 1 .. -0.75 (unit sphere)
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
    const a = i * 2.39996 + rnd() * 0.6;
    const shell = 0.5 + rnd() * 0.15;
    const ux = Math.cos(a) * rr,
      uz = Math.sin(a) * rr;
    let nx = ux / rx,
      ny = yy / ry,
      nz = uz / rx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    out.push({
      x: ux * rx * shell,
      y: cy + yy * ry * shell,
      z: uz * rx * shell,
      size: (v / CLUMP_R) * (0.9 + rnd() * 0.25),
      variant: Math.floor(rnd() * 2),
      rot: rnd() * 6.28,
      shade: 0.62 + 0.38 * (0.5 + 0.5 * yy),
      nx,
      ny,
      nz,
    });
  }
  return out;
}

/**
 * Conifer: a stack of pointed, ragged branch tiers (atlas tiles 2/3 are
 * triangular "Christmas tree" layers: tip at +0.9, base at −0.75 of the
 * sprite, base half-width 0.82) narrowing toward the top, each tier's tip
 * reaching well into the one above so the silhouette is continuous.
 */
function coniferSprites(n: number, seed: number): Sprite[] {
  const rnd = rngFrom(seed);
  const out: Sprite[] = [];
  out.push({ x: 0, y: 0, z: 0, size: 0.011, variant: -1, rot: 0, shade: 0.55, nx: 0, ny: 0, nz: 1 });
  const base = 0.12,
    top = 1.0;
  const R = (y: number) => 0.16 * Math.pow(Math.max(0, (top - y) / (top - base)), 0.9) + 0.012;
  const tiers = Math.max(3, n);
  // overlap factor chosen so `tiers` tiers span base → top
  let lo = 0.2,
    hi = 1.0;
  const span = (step: number): number => {
    let y = base;
    for (let k = 0; k < tiers - 1; k++) y += step * 1.65 * (R(y) / 0.82);
    return y + 1.65 * (R(y) / 0.82) * 0.92;
  };
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) / 2;
    if (span(mid) > top) hi = mid;
    else lo = mid;
  }
  const step = (lo + hi) / 2;
  let yb = base;
  for (let k = 0; k < tiers; k++) {
    const sz = R(yb) / 0.82;
    const t = k / Math.max(1, tiers - 1);
    out.push({
      x: (rnd() - 0.5) * 0.01,
      y: yb + 0.75 * sz, // sprite centre: base edge sits at yb
      z: (rnd() - 0.5) * 0.01,
      size: sz,
      variant: 2 + Math.floor(rnd() * 2),
      rot: (rnd() - 0.5) * 0.12,
      shade: 0.55 + 0.45 * t,
      nx: 0,
      ny: 0.25 + 0.6 * t,
      nz: 0,
    });
    yb += step * 1.65 * sz;
  }
  return out;
}

function templateGeometry(sprites: Sprite[], trunkTop: number): THREE.InstancedBufferGeometry {
  const n = sprites.length;
  const pos = new Float32Array(n * 4 * 3);
  const nrm = new Float32Array(n * 4 * 3);
  const corner = new Float32Array(n * 4 * 2);
  const info = new Float32Array(n * 4 * 4);
  const idx: number[] = [];
  const C = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let i = 0; i < n; i++) {
    const s = sprites[i];
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      // trunk card: bottom vertices on the ground, top ones inside the crown
      const y = s.variant < 0 ? (C[k][1] > 0 ? trunkTop : s.y) : s.y;
      pos[v * 3] = s.x;
      pos[v * 3 + 1] = y;
      pos[v * 3 + 2] = s.z;
      nrm[v * 3] = s.nx;
      nrm[v * 3 + 1] = s.ny;
      nrm[v * 3 + 2] = s.nz;
      corner[v * 2] = C[k][0];
      corner[v * 2 + 1] = C[k][1];
      info[v * 4] = s.size;
      info[v * 4 + 1] = s.variant;
      info[v * 4 + 2] = s.rot;
      info[v * 4 + 3] = s.shade;
    }
    const b = i * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  g.setAttribute('aSprite', new THREE.BufferAttribute(info, 4));
  g.setIndex(idx);
  return g;
}

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec2 aCorner;
attribute vec4 aSprite;
attribute vec4 iPos;
attribute vec4 iCol;
attribute float iWidth;
uniform float uTime;
varying vec2 vUv;
varying vec3 vN;
varying vec4 vInfo;
varying vec3 vCol;
varying vec3 vWPos;
void main() {
  float H = iPos.w;
  float cr = cos(iCol.w), sr = sin(iCol.w);
  mat2 rY = mat2(cr, sr, -sr, cr);
  vec3 off = position;
  off.xz = rY * off.xz * iWidth;
  vec3 n = normal;
  n.xz = rY * n.xz;
  vec3 wc = iPos.xyz + off * H;
  // slow, small sway growing with height
  float sw = sin(uTime * 0.6 + iPos.x * 0.07 + iPos.z * 0.05) * 0.01 * position.y * position.y * H;
  wc.xz += vec2(sw, sw * 0.6);
  vec4 mvPosition;
  bool trunk = aSprite.y < 0.0;
  if (trunk) {
    vec3 right = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
    wc += right * aCorner.x * aSprite.x * H * mix(1.0, 0.6, position.y);
    mvPosition = viewMatrix * vec4(wc, 1.0);
    vUv = vec2(aCorner.x, position.y);
  } else {
    mvPosition = viewMatrix * vec4(wc, 1.0);
    float c = cos(aSprite.z), s = sin(aSprite.z);
    mvPosition.xy += mat2(c, s, -s, c) * aCorner * aSprite.x * H * mix(1.0, iWidth, 0.6);
    float v = aSprite.y;
    vec2 tile = vec2(mod(v, 2.0), floor(v * 0.5));
    vUv = (tile + aCorner * 0.5 + 0.5) * 0.5;
  }
  gl_Position = projectionMatrix * mvPosition;
  vN = normalize(n + vec3(0.0, 1e-4, 0.0));
  vInfo = vec4(aSprite.w, trunk ? 1.0 : 0.0, aSprite.z, 0.0);
  vCol = iCol.rgb;
  vWPos = wc;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uAtlas;
uniform float uAtlasRes;
uniform vec3 uSunDir;
uniform vec3 uSunE;
uniform vec3 uSkyE;
uniform vec3 uGroundE;
varying vec2 vUv;
varying vec3 vN;
varying vec4 vInfo;
varying vec3 vCol;
varying vec3 vWPos;
void main() {
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camB = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 albedo;
  vec3 n;
  float ao;
  float alpha = 1.0;
  if (vInfo.y > 0.5) {
    float x = vUv.x;
    n = normalize(camR * x + camB * sqrt(max(1.0 - x * x, 0.0)));
    albedo = vec3(0.075, 0.062, 0.05) * (0.85 + 0.3 * fract(vWPos.y * 1.7 + vWPos.x * 0.37));
    ao = vInfo.x;
  } else {
    vec4 t = texture2D(uAtlas, vUv);
    // mip-level coverage boost keeps distant crowns from thinning out
    vec2 dx = dFdx(vUv) * uAtlasRes, dy = dFdy(vUv) * uAtlasRes;
    float lod = max(0.5 * log2(max(dot(dx, dx), dot(dy, dy))), 0.0);
    float a = t.a * (1.0 + 0.2 * lod);
#ifdef USE_A2C
    alpha = clamp((a - 0.5) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0);
    if (alpha < 0.02) discard;
#else
    if (a < 0.5) discard;
#endif
    float c = cos(vInfo.z), s = sin(vInfo.z);
    vec2 nxy = mat2(c, s, -s, c) * (t.gb * 2.0 - 1.0);
    vec3 nt = camR * nxy.x + camU * nxy.y + camB * sqrt(max(1.0 - dot(nxy, nxy), 0.0));
    n = normalize(vN * 0.8 + nt * 0.6);
    albedo = vCol * (0.5 + 0.75 * t.r);
    ao = vInfo.x * (0.6 + 0.4 * t.r);
  }
  // the rest of the crown shades sprites on the side away from the light
  float crownSun = 0.3 + 0.7 * smoothstep(-0.75, 0.55, dot(vN, uSunDir));
  float ndl = max((dot(n, uSunDir) + 0.35) / 1.35, 0.0);
  vec3 vdir = normalize(vWPos - cameraPosition);
  float back = pow(clamp(dot(vdir, uSunDir), 0.0, 1.0), 4.0);
  // sky dome (more from above) + light bounced off the sunlit ground below
  vec3 amb = uSkyE * (0.7 + 0.5 * n.y) + uGroundE * (0.6 - 0.4 * n.y);
  vec3 irr = uSunE * (ndl * crownSun) + amb * ao;
  // leaves scatter part of the sunlight through the crown
  vec3 col = albedo * RECIPROCAL_PI * irr + albedo * uSunE * (0.035 + back * 0.12) * crownSun;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface ForestOptions {
  /** Sprites per detailed (near) broadleaf crown. */
  nearSprites: number;
  /** Sprites per sparse (far) crown. */
  farSprites: number;
  /** MSAA available → alpha-to-coverage edges. */
  msaa: boolean;
}

export class DistantForest {
  readonly group = new THREE.Group();
  readonly uniforms: ForestUniforms;
  private material: THREE.ShaderMaterial;
  private geos: THREE.InstancedBufferGeometry[] = [];
  readonly meshes: THREE.Mesh[] = [];

  constructor(trees: ForestTree[], atlas: THREE.Texture, opts: ForestOptions) {
    this.group.name = 'outer-forest';
    this.uniforms = {
      uAtlas: { value: atlas },
      uAtlasRes: { value: (atlas.image as { width?: number } | undefined)?.width ?? 512 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunE: { value: new THREE.Color(1, 1, 1) },
      uSkyE: { value: new THREE.Color(0.3, 0.35, 0.4) },
      uGroundE: { value: new THREE.Color(0.05, 0.05, 0.04) },
      uTime: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'outer-forest',
      vertexShader: VERT,
      fragmentShader: FRAG,
      // fog uniforms (filled by the renderer) + ours, by reference
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...this.uniforms },
      fog: true,
      side: THREE.DoubleSide,
      defines: opts.msaa ? { USE_A2C: 1 } : {},
      alphaToCoverage: opts.msaa,
    });
    const templates: [boolean, 0 | 1, THREE.InstancedBufferGeometry][] = [
      [true, 0, templateGeometry(broadleafSprites(opts.nearSprites, 11), 0.42)],
      [true, 1, templateGeometry(coniferSprites(Math.max(4, Math.round(opts.nearSprites * 0.6)), 23), 0.45)],
      [false, 0, templateGeometry(broadleafSprites(opts.farSprites, 37), 0.42)],
      [false, 1, templateGeometry(coniferSprites(Math.max(3, opts.farSprites - 1), 41), 0.45)],
    ];
    for (const [near, kind, geo] of templates) {
      const list = trees.filter((t) => t.near === near && t.kind === kind);
      if (!list.length) {
        geo.dispose();
        continue;
      }
      const iPos = new Float32Array(list.length * 4);
      const iCol = new Float32Array(list.length * 4);
      const iWidth = new Float32Array(list.length);
      list.forEach((t, i) => {
        iPos.set([t.x, t.y, t.z, t.h], i * 4);
        iCol.set([t.color.r, t.color.g, t.color.b, t.rot], i * 4);
        iWidth[i] = t.width;
      });
      geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 4));
      geo.setAttribute('iCol', new THREE.InstancedBufferAttribute(iCol, 4));
      geo.setAttribute('iWidth', new THREE.InstancedBufferAttribute(iWidth, 1));
      geo.instanceCount = list.length;
      this.geos.push(geo);
      const m = new THREE.Mesh(geo, this.material);
      m.frustumCulled = false; // surrounds the map: always partly visible
      m.castShadow = false;
      m.receiveShadow = false;
      m.name = `outer-forest-${near ? 'near' : 'far'}-${kind ? 'conifer' : 'broadleaf'}`;
      this.meshes.push(m);
      this.group.add(m);
    }
  }

  /** Triangles drawn per frame (for stats). */
  get triangles(): number {
    let t = 0;
    for (const g of this.geos) t += ((g.index?.count ?? 0) / 3) * g.instanceCount;
    return t;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    this.material.dispose();
  }
}
