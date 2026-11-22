// Selection highlight for placed objects: a soft additive Fresnel rim drawn
// over a clone of the object (shares geometry, sways with the wind, respects
// alpha-tested leaf cards) plus a glowing outline hugging the ground around
// the object's footprint. Works the same for instanced and unique props.

import * as THREE from 'three';
import { WATER_LEVEL } from '../core/constants';
import type { World } from '../core/world';
import { hasSway, WIND_GLSL, WIND_VERTEX, windUniforms } from './wind';

const RIM_VERT = /* glsl */ `
#include <common>
#ifdef WIND
${WIND_GLSL}
uniform float uSway;
#endif
uniform mat3 uvTransform;
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
void main() {
  vec3 transformed = position;
#ifdef WIND
${WIND_VERTEX}
#endif
  vec4 mv = modelViewMatrix * vec4( transformed, 1.0 );
  vN = normalize( normalMatrix * normal );
  vV = -mv.xyz;
  vUv = ( uvTransform * vec3( uv, 1.0 ) ).xy;
  gl_Position = projectionMatrix * mv;
}
`;

const RIM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
#ifdef CUTOUT
uniform sampler2D map;
uniform float alphaTest;
#endif
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
void main() {
#ifdef CUTOUT
  if ( texture2D( map, vUv ).a < alphaTest ) discard;
#endif
  float ndv = abs( dot( normalize( vN ), normalize( vV ) ) );
  float rim = pow( 1.0 - ndv, 2.5 );
#ifdef CUTOUT
  // foliage cards: many face sideways, keep it to a faint sheen
  float a = ( rim * 0.22 + 0.05 ) * uStrength;
#else
  float a = ( rim * 0.8 + 0.08 ) * uStrength;
#endif
  gl_FragColor = vec4( uColor, clamp( a, 0.0, 1.0 ) );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
varying vec2 vUv;
void main() {
  float d = vUv.y - 0.4;
  float line = exp( -d * d / 0.008 );
  float glow = exp( -d * d / 0.09 ) * 0.45;
  float a = ( line + glow ) * uStrength;
  gl_FragColor = vec4( uColor, clamp( a, 0.0, 1.0 ) );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Footprint rectangle in world metres. */
export interface FootprintRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const HIGHLIGHT_COLOR = new THREE.Color(1.0, 0.78, 0.4);

export class Highlighter {
  readonly group = new THREE.Group();
  private overlay: THREE.Object3D | null = null;
  private ring: THREE.Mesh | null = null;
  private rimCache = new Map<THREE.Material, THREE.ShaderMaterial>();
  private readonly rimStrength = { value: 0 };
  private readonly ringStrength = { value: 0 };
  private readonly color = { value: HIGHLIGHT_COLOR.clone() };
  private readonly ringMat: THREE.ShaderMaterial;
  private fade = 0;

  constructor(private readonly world: World) {
    this.group.name = 'highlight';
    this.ringMat = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: { uColor: this.color, uStrength: this.ringStrength },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
  }

  private rimMaterial(src: THREE.Material): THREE.ShaderMaterial {
    let m = this.rimCache.get(src);
    if (m) return m;
    const std = src as THREE.MeshStandardMaterial;
    const cutout = !!std.map && src.alphaTest > 0;
    const wind = hasSway(src);
    const defines: Record<string, string> = {};
    if (cutout) defines.CUTOUT = '';
    if (wind) defines.WIND = '';
    m = new THREE.ShaderMaterial({
      vertexShader: RIM_VERT,
      fragmentShader: RIM_FRAG,
      defines,
      uniforms: {
        uColor: this.color,
        uStrength: this.rimStrength,
        uvTransform: { value: cutout ? std.map!.matrix : new THREE.Matrix3() },
        map: { value: cutout ? std.map : null },
        alphaTest: { value: src.alphaTest },
        uSway: { value: wind ? (src.userData.sway as number) : 0 },
        uWindTime: windUniforms.uWindTime,
        uWindDir: windUniforms.uWindDir,
        uWindStrength: windUniforms.uWindStrength,
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: src.side,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    this.rimCache.set(src, m);
    return m;
  }

  /**
   * Highlight `model` (a clone sharing geometry with the rendered object;
   * its materials are replaced) placed with `matrix`, outlining `fp` on the ground.
   */
  show(model: THREE.Object3D, matrix: THREE.Matrix4, fp: FootprintRect): void {
    this.clear();
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map((x) => this.rimMaterial(x)) : this.rimMaterial(mesh.material);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 10;
    });
    model.matrixAutoUpdate = false;
    model.matrix.copy(matrix);
    model.matrixWorldNeedsUpdate = true;
    this.overlay = model;
    this.group.add(model);
    this.ring = new THREE.Mesh(this.ringGeometry(fp), this.ringMat);
    this.ring.renderOrder = 9;
    this.ring.frustumCulled = false;
    this.group.add(this.ring);
    this.fade = 0;
  }

  get active(): boolean {
    return this.overlay !== null;
  }

  clear(): void {
    if (this.overlay) {
      this.group.remove(this.overlay);
      this.overlay = null;
    }
    if (this.ring) {
      this.group.remove(this.ring);
      this.ring.geometry.dispose();
      this.ring = null;
    }
  }

  update(dt: number, t: number): void {
    if (!this.overlay) return;
    this.fade = Math.min(1, this.fade + dt * 4);
    const pulse = 0.82 + 0.18 * Math.sin(t * 3.2);
    this.rimStrength.value = 0.6 * pulse * this.fade;
    this.ringStrength.value = 0.8 * pulse * this.fade;
  }

  /** Rounded-rectangle band around the footprint, draped on the terrain. */
  private ringGeometry(fp: FootprintRect): THREE.BufferGeometry {
    const margin = 0.22;
    const x0 = fp.x0 - margin;
    const z0 = fp.z0 - margin;
    const x1 = fp.x1 + margin;
    const z1 = fp.z1 + margin;
    const rad = Math.min(0.45, (x1 - x0) / 2, (z1 - z0) / 2);
    const inner = 0.16;
    const outer = 0.24;
    // centre line of the rounded rectangle, sampled ~every 0.2 m
    const pts: number[] = [];
    const corners: [number, number, number][] = [
      [x1 - rad, z1 - rad, 0],
      [x0 + rad, z1 - rad, Math.PI / 2],
      [x0 + rad, z0 + rad, Math.PI],
      [x1 - rad, z0 + rad, (3 * Math.PI) / 2],
    ];
    const arcSteps = 6;
    for (let c = 0; c < 4; c++) {
      const [cx, cz, a0] = corners[c];
      for (let i = 0; i <= arcSteps; i++) {
        const a = a0 + (i / arcSteps) * (Math.PI / 2);
        pts.push(cx + Math.cos(a) * rad, cz + Math.sin(a) * rad, Math.cos(a), Math.sin(a));
      }
      // straight edge to next corner
      const [nx, nz, na] = corners[(c + 1) % 4];
      const ex = cx + Math.cos(a0 + Math.PI / 2) * rad;
      const ez = cz + Math.sin(a0 + Math.PI / 2) * rad;
      const fx = nx + Math.cos(na) * rad;
      const fz = nz + Math.sin(na) * rad;
      const len = Math.hypot(fx - ex, fz - ez);
      const n = Math.max(1, Math.ceil(len / 0.2));
      for (let i = 1; i < n; i++) {
        const t = i / n;
        pts.push(ex + (fx - ex) * t, ez + (fz - ez) * t, Math.cos(a0 + Math.PI / 2), Math.sin(a0 + Math.PI / 2));
      }
    }
    const count = pts.length / 4;
    const pos = new Float32Array(count * 2 * 3);
    const uv = new Float32Array(count * 2 * 2);
    const idx: number[] = [];
    const h = (x: number, z: number) => Math.max(this.world.heightAt(x, z), WATER_LEVEL) + 0.035;
    for (let i = 0; i < count; i++) {
      const x = pts[i * 4];
      const z = pts[i * 4 + 1];
      const nx = pts[i * 4 + 2];
      const nz = pts[i * 4 + 3];
      const ix = x - nx * inner;
      const iz = z - nz * inner;
      const ox = x + nx * outer;
      const oz = z + nz * outer;
      pos.set([ix, h(ix, iz), iz, ox, h(ox, oz), oz], i * 6);
      uv.set([i / count, 0, i / count, 1], i * 4);
      const j = (i + 1) % count;
      idx.push(i * 2, j * 2, i * 2 + 1, i * 2 + 1, j * 2, j * 2 + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  dispose(): void {
    this.clear();
    for (const m of this.rimCache.values()) m.dispose();
    this.rimCache.clear();
    this.ringMat.dispose();
    this.group.removeFromParent();
  }
}
