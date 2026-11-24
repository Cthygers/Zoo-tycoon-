// Night lighting for lamps, lit windows and kiosks that scales to hundreds of
// lamps on a phone:
//  - light pools: ONE terrain-conforming ground mesh on a shared 1 m grid.
//    Every grid vertex sums the light of all emitters around it (inverse-
//    square / cosine falloff from each light's real position) and saturates
//    the sum, so overlapping pools (double lamp heads, kiosk bulbs, windows)
//    add up like light instead of compounding, and every ground point is
//    covered once. The pool lights the moonlit ground it covers, so it
//    respects albedo, texture and shadows, and leaves the ground untouched
//    where its light is 0 (soft fringes, no seam at the mesh edge):
//      dst × (1 + s);  HDR pipeline (post-FX tier, linear light): s ≤ 3,
//                      LDR pipeline (display space): s ≤ 1
//    (an 8-bit framebuffer clamps the blend source to 1, so LDR multiplies
//    by 2 at most). In display space nothing rolls off highlights after the
//    blend, so on LDR tiers s gets a soft knee per vertex from the brightness
//    of the moonlit surface there (snow vs paving vs lawn), keeping it under
//    white. LDR tiers also add a faint warm fill first (a second draw of the
//    same mesh, not on snow-bright ground): a multiply alone cannot warm the
//    moon-graded blue-green of a lawn, nor bluish paving within its ×2.
//  - halos: one camera-facing soft sprite per lamp head (ONE instanced draw)
//    so lamps read as glowing even without bloom, sized to stay under the
//    bloom threshold.
//  - lamp light on animals and people: the pool grid's light is also written
//    to a map-wide texture that creature and human materials sample once per
//    vertex (lampField.ts), so anyone standing in a pool is lit warm.
//  - real point lights: at most a couple (high tier only) on the lamps
//    nearest the camera focus, so nearby benches / kiosk walls are lit too
//    (not animals and people: the field above already lights them).
// Everything is invisible (0 draw calls) during the day.

import * as THREE from 'three';
import { TILE, WATER_LEVEL } from '../../core/constants';
import { PathType, Terrain } from '../../core/types';
import type { World } from '../../core/world';
import { resetLampField, setLampLight, writeLampField } from './lampField';

/** Warm ≈2700 K lamp colour (linear-ish, as used by the shaders). */
const WARM = new THREE.Color(0xffc68a);
/**
 * Pool tint in the HDR pipeline: about lamp light over moonlight per channel
 * (the multiply scales moonlit, blue-graded ground). The pools also mark the
 * pixels they light in the HDR alpha, so the night grade shows them in
 * colour instead of in rod vision (render/grade.ts).
 */
const WARM_HDR = new THREE.Color(1.0, 0.38, 0.1);
/**
 * Pool tint in the LDR pipeline: saturated for the same reason (the moonlit
 * grade is in the framebuffer): moonlit paving is bluish grey, and only a
 * multiply far stronger in red than in blue turns it warm.
 */
const WARM_LDR = new THREE.Color(1.0, 0.6, 0.0);
/**
 * Peak pool gain at full night (s at saturated light, red channel). HDR: the
 * multiplier stays under 4× in linear light, so lamp-lit paving keeps its
 * texture through the tone curve; LDR: 1, the most the 8-bit framebuffer
 * passes (more would flatten pool centres to a plateau).
 */
const POOL_GAIN_HDR = 3.0;
const POOL_GAIN_LDR = 1.0;
/**
 * Additive warm fill of LDR tiers at saturated light (display units): amber,
 * so the multiply that follows turns moonlit paving ≈ 2700 K, not white.
 */
const FILL_GAIN = 0.32;
const FILL_COLOR = new THREE.Color(1.0, 0.62, 0.3);
/**
 * Point lights (high tier) light what stands near a lamp: benches, kiosk
 * walls (animals and people skip them, lampField.ts). Their range ends just
 * past the ground under the lamp, which the pools already light, so the
 * ground is not lit twice (and the pools of the lamps that have a point light
 * don't stand out).
 */
const POINT_INTENSITY = 0.6;
const POINT_RANGE = 3.8;
/**
 * Lamp irradiance on animals and people at full pool light (lampField.ts):
 * ≈ 5× full moonlight, enough to show a guest's clothes in colour, about as
 * bright as the lit paving around them.
 */
const CREATURE_LAMP = WARM.clone().multiplyScalar(0.45);
/**
 * Halo core brightness. LDR: display-referred additive glow. HDR (post-FX
 * tier): in displayed units (divided by the exposure, which is ≈ 15× the noon
 * one at night), kept well under the bloom threshold (render/post.ts) so
 * bloom catches the lantern glass only, not a metre-wide white disc.
 */
const HALO_LDR = 0.42;
const HALO_HDR = 0.6;
/** Reference lamp height for the falloff normalisation (m). */
const H0 = 3.2;
/** Pool mesh height above the walk surface (m); small, so walls standing in a pool show no lit seam. */
const POOL_LIFT = 0.02;
/** Window light: relative strength, and height of its virtual source above the window (m). */
const WINDOW_INTENSITY = 0.18;
const WINDOW_LIFT = 1;
/** Light below which a pool cell is not drawn. */
const POOL_MIN = 0.004;

/**
 * Brightest moonlit display value (LDR tiers, red channel, with texture
 * variation) of each walk surface / terrain: where the LDR pool's knee sets in.
 */
const PATH_BRIGHTNESS: Partial<Record<PathType, number>> = {
  [PathType.Paved]: 0.34,
  [PathType.Gravel]: 0.3,
  [PathType.Boardwalk]: 0.24,
};
const TERRAIN_BRIGHTNESS: Partial<Record<Terrain, number>> = {
  [Terrain.Sand]: 0.36,
  [Terrain.Rock]: 0.24,
  [Terrain.Snow]: 0.62,
};
/** Lawn, earth, mud, water. */
const DARK_BRIGHTNESS = 0.12;

/**
 * Moonlit brightness of the surface at a pool grid vertex (world metres): the
 * brightest of the tiles touching it, so a vertex on a path edge is never
 * pushed past white.
 */
export function surfaceBrightness(world: World, x: number, z: number): number {
  let b = DARK_BRIGHTNESS;
  // a vertex on a tile edge touches the tiles on both sides
  for (let tz = Math.ceil(z / TILE) - 1; tz <= Math.floor(z / TILE); tz++)
    for (let tx = Math.ceil(x / TILE) - 1; tx <= Math.floor(x / TILE); tx++) {
      if (!world.inBounds(tx, tz)) continue;
      b = Math.max(b, PATH_BRIGHTNESS[world.getPath(tx, tz)] ?? TERRAIN_BRIGHTNESS[world.getTerrain(tx, tz)] ?? DARK_BRIGHTNESS);
    }
  return b;
}

export type EmitterKind = 'lamp' | 'window';

/** A light source in object-local space (found once per template). */
export interface LocalEmitter {
  pos: THREE.Vector3;
  kind: EmitterKind;
  /** Horizontal unit direction the light spills toward (windows), or null. */
  dir: THREE.Vector2 | null;
}

/** A placed light source in world space. */
export interface WorldEmitter {
  x: number;
  y: number;
  z: number;
  kind: EmitterKind;
  /** Pool centre on the ground. */
  px: number;
  pz: number;
  radius: number;
  intensity: number;
}

// ---------------------------------------------------------------------------
// Pool mesh

/**
 * Ground light of a summed emitter irradiance (1 = right under one standard
 * lamp): ≈ linear when dim, saturating toward 1 where lights overlap, so a
 * double lamp is brighter than a single one but nothing gets a hot spot.
 */
export function poolLight(e: number): number {
  return 1 - Math.exp(-1.2 * e);
}

/** Irradiance (1 = right under a standard lamp) at a ground point from one emitter, with the pool's edge fade. */
function emitterLight(em: WorldEmitter, x: number, y: number, z: number): number {
  const rc = Math.hypot(x - em.px, z - em.pz);
  if (rc >= em.radius) return 0;
  // point light on a horizontal surface: E = I cos(theta) / dist^2, normalised to 1 under an H0 lamp
  const h = Math.max(em.y - y, 0.35);
  const r2 = (x - em.x) ** 2 + (z - em.z) ** 2;
  const e = (H0 * H0 * h) / Math.pow(h * h + r2, 1.5);
  const t = THREE.MathUtils.clamp((rc - em.radius * 0.5) / (em.radius * 0.5), 0, 1);
  return e * (1 - t * t * (3 - 2 * t)) * em.intensity;
}

export interface PoolGrid {
  /** xyz per vertex. */
  position: Float32Array;
  /** Saturated ground light 0..1 per vertex (poolLight of the summed irradiance). */
  light: Float32Array;
  /** Moonlit surface brightness per vertex (see surfaceBrightness). */
  bright: Float32Array;
  /** Two triangles per lit 1 m cell; every cell appears once. */
  index: number[];
}

/**
 * Drape one 1 m grid over the ground under all emitters: vertices are shared
 * between overlapping pools and carry the summed light, so the mesh covers
 * each ground point exactly once. `surfaceY(x, z)` gives the mesh height,
 * `surfaceBright(x, z)` the moonlit brightness of the surface there.
 */
export function buildPoolGrid(
  emitters: Iterable<WorldEmitter>,
  surfaceY: (x: number, z: number) => number,
  surfaceBright: (x: number, z: number) => number = () => DARK_BRIGHTNESS,
): PoolGrid {
  const key = (x: number, z: number) => (x + 4096) * 8192 + (z + 4096);
  const vert = new Map<number, number>();
  const pos: number[] = [];
  const bright: number[] = [];
  const sum: number[] = [];
  for (const em of emitters) {
    // one ring beyond the pool so its edge cells are complete
    const x0 = Math.floor(em.px - em.radius) - 1;
    const x1 = Math.ceil(em.px + em.radius) + 1;
    const z0 = Math.floor(em.pz - em.radius) - 1;
    const z1 = Math.ceil(em.pz + em.radius) + 1;
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const k = key(x, z);
        let v = vert.get(k);
        if (v === undefined) {
          v = sum.length;
          vert.set(k, v);
          pos.push(x, surfaceY(x, z), z);
          bright.push(surfaceBright(x, z));
          sum.push(0);
        }
        sum[v] += emitterLight(em, x, pos[v * 3 + 1], z);
      }
  }
  const light = new Float32Array(sum.length);
  for (let i = 0; i < sum.length; i++) light[i] = poolLight(sum[i]);
  const index: number[] = [];
  for (const [k, a] of vert) {
    const b = vert.get(k + 1); // (x, z + 1)
    const c = vert.get(k + 8192); // (x + 1, z)
    const d = vert.get(k + 8193); // (x + 1, z + 1)
    if (b === undefined || c === undefined || d === undefined) continue;
    if (Math.max(light[a], light[b], light[c], light[d]) < POOL_MIN) continue;
    index.push(a, b, c, c, b, d);
  }
  return { position: new Float32Array(pos), light, bright: new Float32Array(bright), index };
}

// ---------------------------------------------------------------------------
// Emitter discovery

const _v = new THREE.Vector3();

/**
 * Cluster the vertices of glowing parts into point emitters (a double lamp
 * gives two heads, a kiosk a few bulbs). `nightEmissive` ≥ 3 counts as a lamp
 * / bulb, lower values (window interiors) as a window; signs (< 1) are ignored.
 */
export function findEmitters(parts: { geometry: THREE.BufferGeometry; material: THREE.Material; local: THREE.Matrix4 }[]): LocalEmitter[] {
  const clusters: { sum: THREE.Vector3; n: number; kind: EmitterKind; r: number }[] = [];
  for (const p of parts) {
    const ne = p.material.userData?.nightEmissive;
    if (typeof ne !== 'number' || ne < 1) continue;
    const kind: EmitterKind = ne >= 3 ? 'lamp' : 'window';
    const r = kind === 'lamp' ? 0.9 : 1.6;
    const pos = p.geometry.getAttribute('position');
    if (!pos) continue;
    const step = Math.max(1, Math.floor(pos.count / 400));
    for (let i = 0; i < pos.count; i += step) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(p.local);
      let best: (typeof clusters)[number] | null = null;
      let bestD = Infinity;
      for (const c of clusters) {
        if (c.kind !== kind) continue;
        const cx = c.sum.x / c.n;
        const cy = c.sum.y / c.n;
        const cz = c.sum.z / c.n;
        const d = (cx - _v.x) ** 2 + (cy - _v.y) ** 2 + (cz - _v.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best && bestD < best.r * best.r) {
        best.sum.add(_v);
        best.n++;
      } else clusters.push({ sum: _v.clone(), n: 1, kind, r });
    }
  }
  const out: LocalEmitter[] = [];
  for (const c of clusters) {
    const pos = c.sum.divideScalar(c.n);
    let dir: THREE.Vector2 | null = null;
    if (c.kind === 'window') {
      const h = Math.hypot(pos.x, pos.z);
      dir = h > 0.15 ? new THREE.Vector2(pos.x / h, pos.z / h) : new THREE.Vector2(0, 1);
    }
    out.push({ pos, kind: c.kind, dir });
  }
  // windows of one shop: keep at most 3 pools (big glazed fronts cluster into many)
  const windows = out.filter((e) => e.kind === 'window');
  if (windows.length > 3) {
    windows.sort((a, b) => b.pos.y - a.pos.y);
    for (const w of windows.slice(3)) out.splice(out.indexOf(w), 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shaders

const POOL_VERT = /* glsl */ `
attribute float aLight;
attribute float aBright;
varying float vLight;
varying float vBright;
void main() {
  vLight = aLight;
  vBright = aBright;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

// uKnee (LDR pool): soft knee at s = 1 / b − 1, where a surface of moonlit
// brightness b reaches white; uSkipBright (LDR fill): none on snow-bright
// ground, which it would push past white; uMark (HDR pool): lamp-lit mark
// added to the target's alpha (render/grade.ts).
const POOL_FRAG = /* glsl */ `
precision mediump float;
uniform vec3 uColor;
uniform float uGain;
uniform float uKnee;
uniform float uSkipBright;
uniform float uMark;
varying float vLight;
varying float vBright;
void main() {
  vec3 s = uColor * ( vLight * uGain * ( 1.0 - uSkipBright * smoothstep( 0.45, 0.6, vBright ) ) );
  vec3 x = s * ( uKnee * vBright / ( 1.0 - vBright ) );
  s /= sqrt( sqrt( 1.0 + x * x * x * x ) );
  gl_FragColor = vec4( s, vLight * uMark );
}
`;

const HALO_VERT = /* glsl */ `
uniform float uMinPx;
varying vec2 vQ;
void main() {
  vec3 c = instanceMatrix[ 3 ].xyz;
  float s = length( instanceMatrix[ 0 ].xyz );
  vec4 mv = modelViewMatrix * vec4( c, 1.0 );
  float dist = -mv.z;
  // keep a minimum apparent size so far lamps still read as points of light
  s = max( s, dist * uMinPx );
  // pull toward the camera so the lantern geometry never clips the halo
  mv.xyz += normalize( -mv.xyz ) * min( 0.35, dist * 0.3 );
  mv.xy += position.xy * s;
  vQ = position.xy * 2.0;
  gl_Position = projectionMatrix * mv;
}
`;

const HALO_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uGain;
varying vec2 vQ;
void main() {
  float r2 = dot( vQ, vQ );
  if ( r2 > 1.0 ) discard;
  float a = exp( -r2 * 5.5 ) * ( 1.0 - r2 );
  gl_FragColor = vec4( uColor * a * uGain, 1.0 );
}
`;

// ---------------------------------------------------------------------------

export class NightLights {
  readonly group = new THREE.Group();
  private readonly poolMat: THREE.ShaderMaterial;
  private readonly fillMat: THREE.ShaderMaterial;
  private readonly haloMat: THREE.ShaderMaterial;
  private pools: THREE.Mesh;
  /** Additive warm fill over the pools (LDR tiers only). */
  private fill: THREE.Mesh;
  private warmFill = false;
  private halos: THREE.InstancedMesh;
  private haloCap = 0;
  private entries = new Map<number, WorldEmitter[]>();
  private dirty = true;
  private night = 0;
  private points: { light: THREE.PointLight; anchor: WorldEmitter | null; level: number; want: boolean }[] = [];
  private pointTimer = 0;
  private readonly tmpM = new THREE.Matrix4();
  private near: WorldEmitter[] = [];
  private nearD: number[] = [];

  constructor(private readonly world: World) {
    this.group.name = 'night-lights';
    const lin = WARM.clone();
    this.poolMat = new THREE.ShaderMaterial({
      name: 'props/lightPool',
      vertexShader: POOL_VERT,
      fragmentShader: POOL_FRAG,
      uniforms: { uColor: { value: lin.clone() }, uGain: { value: 0 }, uKnee: { value: 0 }, uSkipBright: { value: 0 }, uMark: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      fog: false,
      // a slope-scaled pull toward the camera would let the pool paint a
      // band of every wall standing in it: keep it to depth-precision size
      polygonOffset: true,
      polygonOffsetFactor: -0.5,
      polygonOffsetUnits: -2,
      // colour: dst × (1 + s); alpha: + lamp-lit mark
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.haloMat = new THREE.ShaderMaterial({
      name: 'props/lampHalo',
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      uniforms: { uColor: { value: lin.clone() }, uGain: { value: 0 }, uMinPx: { value: 0.004 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      fog: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.pools = new THREE.Mesh(new THREE.BufferGeometry(), this.poolMat);
    this.pools.name = 'lamp-light-pools';
    this.pools.renderOrder = -1; // before other transparents (glass, water) that sit above the ground
    this.pools.visible = false;
    this.pools.onBeforeRender = (renderer) => this.configureBlend(renderer);
    this.fillMat = this.poolMat.clone();
    this.fillMat.name = 'props/lightPoolFill';
    this.fillMat.blendSrc = THREE.OneFactor;
    this.fillMat.blendDst = THREE.OneFactor;
    this.fillMat.uniforms.uColor.value.copy(FILL_COLOR);
    this.fillMat.uniforms.uSkipBright.value = 1;
    this.fill = new THREE.Mesh(this.pools.geometry, this.fillMat);
    this.fill.name = 'lamp-light-fill';
    // before the pools, which then scale it like the ground
    this.fill.renderOrder = -2;
    this.fill.visible = false;
    this.fill.onBeforeRender = () => {
      this.fillMat.uniforms.uGain.value = this.night * FILL_GAIN;
    };
    this.group.add(this.fill);
    this.halos = this.makeHalos(16);
    this.group.add(this.pools);
  }

  private makeHalos(cap: number): THREE.InstancedMesh {
    const g = new THREE.PlaneGeometry(1, 1);
    const m = new THREE.InstancedMesh(g, this.haloMat, cap);
    m.count = 0;
    m.frustumCulled = false;
    m.visible = false;
    m.name = 'lamp-halos';
    m.onBeforeRender = (renderer) => {
      const hdr = renderer.getRenderTarget() !== null;
      this.haloMat.uniforms.uGain.value = this.night * (hdr ? HALO_HDR / Math.max(renderer.toneMappingExposure, 1e-3) : HALO_LDR);
    };
    this.haloCap = cap;
    this.group.add(m);
    return m;
  }

  private configureBlend(renderer: THREE.WebGLRenderer): void {
    const hdr = renderer.getRenderTarget() !== null;
    const m = this.poolMat;
    // HDR: linear light, the tone curve rolls off highlights; LDR: display
    // space, the knee keeps bright surfaces under white (header)
    m.uniforms.uKnee.value = hdr ? 0 : 1;
    m.uniforms.uMark.value = hdr ? this.night : 0;
    m.uniforms.uGain.value = this.night * (hdr ? POOL_GAIN_HDR : POOL_GAIN_LDR);
    m.uniforms.uColor.value.copy(hdr ? WARM_HDR : WARM_LDR);
  }

  /** Set (or clear with null / []) the emitters of one placed object. */
  setObject(id: number, emitters: LocalEmitter[] | null, matrix: THREE.Matrix4 | null): void {
    if (!emitters || emitters.length === 0 || !matrix) {
      if (this.entries.delete(id)) this.dirty = true;
      return;
    }
    const list: WorldEmitter[] = [];
    const e = matrix.elements;
    for (const em of emitters) {
      _v.copy(em.pos).applyMatrix4(matrix);
      if (em.kind === 'lamp') {
        const h = Math.max(_v.y - this.world.heightAt(_v.x, _v.z), 0.5);
        const radius = THREE.MathUtils.clamp(h * 1.9 + 0.6, 3, 8);
        list.push({ x: _v.x, y: _v.y, z: _v.z, kind: em.kind, px: _v.x, pz: _v.z, radius, intensity: 1 });
        continue;
      }
      // rotate the local spill direction by the placement matrix
      const dx = em.dir ? e[0] * em.dir.x + e[8] * em.dir.y : 0;
      const dz = em.dir ? e[2] * em.dir.x + e[10] * em.dir.y : 1;
      const l = Math.hypot(dx, dz) || 1;
      const px = _v.x + (dx / l) * 1.1;
      const pz = _v.z + (dz / l) * 1.1;
      // a lit window is a broad, dim source: light it from above the pool
      // centre so the pool is a soft patch in front of the shop, not a hot
      // line along the wall foot
      list.push({ x: px, y: _v.y + WINDOW_LIFT, z: pz, kind: em.kind, px, pz, radius: 2.8, intensity: WINDOW_INTENSITY });
    }
    this.entries.set(id, list);
    this.dirty = true;
  }

  clear(): void {
    this.entries.clear();
    this.dirty = true;
    for (const p of this.points) {
      p.anchor = null;
      p.want = false;
    }
  }

  /** Terrain changed: re-drape the pools. */
  markDirty(): void {
    this.dirty = true;
  }

  /** Draw the additive warm fill (tiers rendering straight to the display, without the HDR target). */
  setWarmFill(on: boolean): void {
    this.warmFill = on;
  }

  /** Number of real point lights (recreated on change; changing it recompiles lit materials once). */
  setPointLights(n: number): void {
    if (n === this.points.length) return;
    for (const p of this.points) p.light.removeFromParent();
    this.points = [];
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(WARM, 0, POINT_RANGE, 2);
      light.castShadow = false;
      light.name = `props-lamp-light-${i}`;
      this.group.add(light);
      this.points.push({ light, anchor: null, level: 0, want: false });
    }
  }

  private rebuild(): void {
    this.dirty = false;
    let lamps = 0;
    const all: WorldEmitter[] = [];
    for (const list of this.entries.values())
      for (const em of list) {
        all.push(em);
        if (em.kind === 'lamp') lamps++;
      }
    const grid = buildPoolGrid(
      all,
      (x, z) => Math.max(this.world.walkHeightAt(x, z), WATER_LEVEL + 0.02) + POOL_LIFT,
      (x, z) => surfaceBrightness(this.world, x, z),
    );
    const old = this.pools.geometry;
    const g = new THREE.BufferGeometry();
    if (grid.index.length) {
      g.setAttribute('position', new THREE.BufferAttribute(grid.position, 3));
      g.setAttribute('aLight', new THREE.BufferAttribute(grid.light, 1));
      g.setAttribute('aBright', new THREE.BufferAttribute(grid.bright, 1));
      g.setIndex(grid.light.length > 65535 ? new THREE.Uint32BufferAttribute(grid.index, 1) : new THREE.Uint16BufferAttribute(grid.index, 1));
      g.computeBoundingSphere();
    }
    this.pools.geometry = g;
    this.fill.geometry = g;
    old.dispose();
    writeLampField(grid.position, grid.light);

    // halos: one per lamp head
    if (lamps > this.haloCap) {
      const oldH = this.halos;
      let cap = this.haloCap;
      while (cap < lamps) cap *= 2;
      this.group.remove(oldH);
      oldH.geometry.dispose();
      oldH.dispose();
      this.halos = this.makeHalos(cap);
    }
    let k = 0;
    const M = this.tmpM;
    for (const list of this.entries.values())
      for (const em of list) {
        if (em.kind !== 'lamp') continue;
        M.makeScale(1.5, 1.5, 1.5).setPosition(em.x, em.y, em.z);
        this.halos.setMatrixAt(k++, M);
      }
    this.halos.count = k;
    this.halos.instanceMatrix.needsUpdate = true;
  }

  /** Per frame. `focus` = ground point the camera looks at. */
  update(dt: number, night: number, focus: THREE.Vector3): void {
    this.night = night;
    const on = night > 0.02;
    if (on && this.dirty) this.rebuild();
    this.pools.visible = on && this.pools.geometry.index !== null;
    this.fill.visible = this.pools.visible && this.warmFill;
    this.halos.visible = on && this.halos.count > 0;
    setLampLight(CREATURE_LAMP, on ? night : 0);
    this.updatePoints(dt, night, focus);
  }

  private updatePoints(dt: number, night: number, f: THREE.Vector3): void {
    if (this.points.length === 0) return;
    this.pointTimer -= dt;
    if (this.pointTimer <= 0 && night > 0.02) {
      this.pointTimer = 0.4;
      const N = this.points.length;
      const near = this.near;
      const nd = this.nearD;
      near.length = 0;
      nd.length = 0;
      for (const list of this.entries.values())
        for (const em of list) {
          if (em.kind !== 'lamp') continue;
          const d = (em.x - f.x) * (em.x - f.x) + (em.z - f.z) * (em.z - f.z);
          if (d > 45 * 45) continue;
          if (near.length === N && d >= nd[N - 1]) continue;
          let k = near.length < N ? near.length : N - 1;
          while (k > 0 && nd[k - 1] > d) {
            near[k] = near[k - 1];
            nd[k] = nd[k - 1];
            k--;
          }
          near[k] = em;
          nd[k] = d;
        }
      for (const sl of this.points) sl.want = sl.anchor !== null && near.indexOf(sl.anchor) >= 0;
      for (const em of near) {
        if (this.points.some((sl) => sl.anchor === em)) continue;
        const free = this.points.find((sl) => !sl.want && sl.level <= 0.01);
        if (!free) continue;
        free.anchor = em;
        free.level = 0;
        free.want = true;
        free.light.position.set(em.x, em.y - 0.15, em.z);
      }
    }
    for (const sl of this.points) {
      const target = sl.want && night > 0.02 ? 1 : 0;
      sl.level += Math.sign(target - sl.level) * Math.min(Math.abs(target - sl.level), dt * 2.5);
      if (sl.level <= 0.001 && !sl.want) sl.anchor = null;
      sl.light.intensity = POINT_INTENSITY * night * sl.level;
    }
  }

  /** Debug counters. */
  stats(): { emitters: number; poolTris: number; halos: number; points: number } {
    let n = 0;
    for (const l of this.entries.values()) n += l.length;
    const idx = this.pools.geometry.index;
    return { emitters: n, poolTris: idx ? idx.count / 3 : 0, halos: this.halos.count, points: this.points.length };
  }

  dispose(): void {
    this.pools.geometry.dispose();
    this.halos.geometry.dispose();
    this.halos.dispose();
    this.poolMat.dispose();
    this.fillMat.dispose();
    this.haloMat.dispose();
    for (const p of this.points) p.light.removeFromParent();
    this.points = [];
    this.entries.clear();
    this.group.removeFromParent();
    resetLampField();
  }
}
