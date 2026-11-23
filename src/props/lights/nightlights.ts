// Night lighting for lamps, lit windows and kiosks that scales to hundreds of
// lamps on a phone:
//  - light pools: every emitter gets a terrain-conforming ground patch (1 m
//    grid, merged into ONE mesh) shaded with an inverse-square / cosine
//    falloff from the light's real position. In the HDR pipeline (post-FX
//    tiers) the pool multiplies the moonlit ground by a warm gain, so it
//    respects albedo and shadows (dst × (1 + E·warm)); the LDR pipeline (low
//    tier, no float target) adds warm light instead.
//  - halos: one camera-facing soft sprite per lamp head (ONE instanced draw)
//    so lamps read as glowing even without bloom, sized to stay under the
//    bloom threshold.
//  - real point lights: at most a couple (high tier only) on the lamps
//    nearest the camera focus, so nearby guests / benches are lit too.
// Everything is invisible (0 draw calls) during the day.

import * as THREE from 'three';
import { WATER_LEVEL } from '../../core/constants';
import type { World } from '../../core/world';

/** Warm ≈2700 K lamp colour (linear-ish, as used by the shaders). */
const WARM = new THREE.Color(0xffc68a);
/**
 * Pool tint in the HDR pipeline: more saturated, because the night grade
 * desaturates the frame (scotopic vision) and the multiply keeps the moonlit
 * ground's blue cast.
 */
const WARM_HDR = new THREE.Color(1.0, 0.42, 0.11);
const POINT_INTENSITY = 2.6;
const POINT_RANGE = 14;
/** Reference lamp height for the falloff normalisation (m). */
const H0 = 3.2;

export type EmitterKind = 'lamp' | 'window';

/** A light source in object-local space (found once per template). */
export interface LocalEmitter {
  pos: THREE.Vector3;
  kind: EmitterKind;
  /** Horizontal unit direction the light spills toward (windows), or null. */
  dir: THREE.Vector2 | null;
}

/** A placed light source in world space. */
interface WorldEmitter {
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
attribute vec3 aLamp;
attribute vec4 aPool;
varying vec3 vW;
varying vec3 vLamp;
varying vec4 vPool;
void main() {
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vW = w.xyz;
  vLamp = aLamp;
  vPool = aPool;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const POOL_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uGain;
varying vec3 vW;
varying vec3 vLamp;
varying vec4 vPool;
void main() {
  vec2 d = vW.xz - vLamp.xz;
  float r2 = dot( d, d );
  float h = max( vLamp.y - vW.y, 0.35 );
  // point light on a horizontal surface: E = I cos(theta) / dist^2, normalised to 1 under a ${H0} m lamp
  float E = min( ${(H0 * H0).toFixed(3)} * h / pow( h * h + r2, 1.5 ), 2.5 );
  float rc = length( vW.xz - vPool.xy );
  float edge = 1.0 - smoothstep( vPool.z * 0.5, vPool.z, rc );
  float k = E * edge * vPool.w * uGain;
  gl_FragColor = vec4( uColor * k, 1.0 );
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

export interface NightTier {
  /** Real point lights near the focus (0 = none). */
  pointLights: number;
  /** HDR (float target, multiply-add pools) vs LDR additive. Decided per frame from the render target. */
}

export class NightLights {
  readonly group = new THREE.Group();
  private readonly poolMat: THREE.ShaderMaterial;
  private readonly haloMat: THREE.ShaderMaterial;
  private pools: THREE.Mesh;
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
      uniforms: { uColor: { value: lin.clone() }, uGain: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
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
      // HDR: stay just under the night bloom threshold (~0.8) so bloom only
      // catches the lantern itself; LDR: display-referred additive glow
      this.haloMat.uniforms.uGain.value = this.night * (hdr ? 0.3 : 0.42);
    };
    this.haloCap = cap;
    this.group.add(m);
    return m;
  }

  private configureBlend(renderer: THREE.WebGLRenderer): void {
    const hdr = renderer.getRenderTarget() !== null;
    const m = this.poolMat;
    if (hdr) {
      // dst × (1 + E·warm·gain): albedo-respecting light in the float target
      m.blendSrc = THREE.DstColorFactor;
      m.blendDst = THREE.OneFactor;
      m.uniforms.uGain.value = this.night * 5.0;
      m.uniforms.uColor.value.copy(WARM_HDR);
    } else {
      // display-referred: additive warm light
      m.blendSrc = THREE.OneFactor;
      m.blendDst = THREE.OneFactor;
      m.uniforms.uGain.value = this.night * 0.3;
      m.uniforms.uColor.value.copy(WARM);
    }
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
      let px = _v.x;
      let pz = _v.z;
      let radius: number;
      let intensity: number;
      const ground = this.world.heightAt(_v.x, _v.z);
      const h = Math.max(_v.y - ground, 0.5);
      if (em.kind === 'lamp') {
        radius = THREE.MathUtils.clamp(h * 1.9 + 0.6, 3, 8);
        intensity = 1;
      } else {
        // rotate the local spill direction by the placement matrix
        const dx = em.dir ? e[0] * em.dir.x + e[8] * em.dir.y : 0;
        const dz = em.dir ? e[2] * em.dir.x + e[10] * em.dir.y : 1;
        const l = Math.hypot(dx, dz) || 1;
        px += (dx / l) * 1.1;
        pz += (dz / l) * 1.1;
        radius = 2.8;
        intensity = 0.55;
      }
      list.push({ x: _v.x, y: _v.y, z: _v.z, kind: em.kind, px, pz, radius, intensity });
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
    const pos: number[] = [];
    const lamp: number[] = [];
    const pool: number[] = [];
    const idx: number[] = [];
    let lamps = 0;
    for (const list of this.entries.values())
      for (const em of list) {
        if (em.kind === 'lamp') lamps++;
        const R = em.radius;
        const x0 = Math.floor(em.px - R);
        const z0 = Math.floor(em.pz - R);
        const n = Math.ceil(em.px + R) - x0;
        const m = Math.ceil(em.pz + R) - z0;
        const base = pos.length / 3;
        for (let j = 0; j <= m; j++)
          for (let i = 0; i <= n; i++) {
            const x = x0 + i;
            const z = z0 + j;
            const y = Math.max(this.world.walkHeightAt(x, z), WATER_LEVEL + 0.02) + 0.03;
            pos.push(x, y, z);
            lamp.push(em.x, em.y, em.z);
            pool.push(em.px, em.pz, R, em.intensity);
          }
        const lim = (R + 0.75) * (R + 0.75);
        for (let j = 0; j < m; j++)
          for (let i = 0; i < n; i++) {
            const cx = x0 + i + 0.5 - em.px;
            const cz = z0 + j + 0.5 - em.pz;
            if (cx * cx + cz * cz > lim) continue;
            const a = base + j * (n + 1) + i;
            const b = a + 1;
            const c = a + (n + 1);
            const d = c + 1;
            idx.push(a, c, b, b, c, d);
          }
      }
    const old = this.pools.geometry;
    const g = new THREE.BufferGeometry();
    if (idx.length) {
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aLamp', new THREE.Float32BufferAttribute(lamp, 3));
      g.setAttribute('aPool', new THREE.Float32BufferAttribute(pool, 4));
      g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
      g.computeBoundingSphere();
    }
    this.pools.geometry = g;
    old.dispose();

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
    this.halos.visible = on && this.halos.count > 0;
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
    this.haloMat.dispose();
    for (const p of this.points) p.light.removeFromParent();
    this.points = [];
    this.entries.clear();
    this.group.removeFromParent();
  }
}
