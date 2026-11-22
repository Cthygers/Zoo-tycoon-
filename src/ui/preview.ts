// 3D build previews: tile fills and outlines draped on the terrain, a local
// tile grid around the cursor, instanced ghost fence segments, ghost objects
// and a placement marker. Owned GPU resources are disposed in dispose().

import * as THREE from 'three';
import { TILE, WATER_LEVEL } from '../core/constants';
import type { IPropsLayer } from '../core/contracts';
import type { EdgeRef, World } from '../core/world';

export type RGBA = [number, number, number, number];

export const COL = {
  ok: [0.55, 0.95, 0.42, 0.34] as RGBA,
  okLine: [0.72, 1.0, 0.55, 0.95] as RGBA,
  bad: [1.0, 0.38, 0.3, 0.36] as RGBA,
  badLine: [1.0, 0.45, 0.36, 0.95] as RGBA,
  remove: [1.0, 0.42, 0.25, 0.32] as RGBA,
  removeLine: [1.0, 0.55, 0.3, 0.95] as RGBA,
  habitat: [0.74, 0.92, 0.5, 0.17] as RGBA,
  habitatLine: [0.8, 0.98, 0.6, 0.9] as RGBA,
  grid: [1, 1, 0.92, 0.55] as RGBA,
};

const LIFT = 0.07;

/** Ground (or water surface) height + a small lift so overlays sit on top. */
export function surfaceY(world: World, x: number, z: number): number {
  return Math.max(world.heightAt(x, z), WATER_LEVEL) + LIFT;
}

// ---------------------------------------------------------------------------
/** Dynamic vertex-coloured triangle mesh draped over the terrain. */
export class DrapedMesh {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  private idx: Uint32Array;
  private nv = 0;
  private ni = 0;
  private cap: number;

  constructor(
    private world: World,
    renderOrder: number,
    initialVerts = 1024,
  ) {
    this.cap = initialVerts;
    this.pos = new Float32Array(this.cap * 3);
    this.col = new Float32Array(this.cap * 4);
    this.idx = new Uint32Array(this.cap * 2);
    this.attach();
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.name = 'ui-draped';
  }

  private attach(): void {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(this.idx, 1).setUsage(THREE.DynamicDrawUsage));
  }

  private ensure(verts: number, indices: number): void {
    if (this.nv + verts <= this.cap && this.ni + indices <= this.idx.length) return;
    let cap = this.cap;
    while (this.nv + verts > cap || this.ni + indices > cap * 2) cap *= 2;
    const pos = new Float32Array(cap * 3);
    pos.set(this.pos.subarray(0, this.nv * 3));
    const col = new Float32Array(cap * 4);
    col.set(this.col.subarray(0, this.nv * 4));
    const idx = new Uint32Array(cap * 2);
    idx.set(this.idx.subarray(0, this.ni));
    this.pos = pos;
    this.col = col;
    this.idx = idx;
    this.cap = cap;
    this.geo.dispose();
    this.attach();
  }

  begin(): void {
    this.nv = 0;
    this.ni = 0;
  }

  private vert(x: number, y: number, z: number, c: RGBA): number {
    const i = this.nv++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.col[i * 4] = c[0];
    this.col[i * 4 + 1] = c[1];
    this.col[i * 4 + 2] = c[2];
    this.col[i * 4 + 3] = c[3];
    return i;
  }

  /** Axis-aligned rectangle in world metres, subdivided to follow the ground. */
  rect(x0: number, z0: number, x1: number, z1: number, c: RGBA, sub = 2): void {
    const n = sub + 1;
    this.ensure(n * n, sub * sub * 6);
    const base = this.nv;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = x0 + ((x1 - x0) * i) / sub;
        const z = z0 + ((z1 - z0) * j) / sub;
        this.vert(x, surfaceY(this.world, x, z), z, c);
      }
    for (let j = 0; j < sub; j++)
      for (let i = 0; i < sub; i++) {
        const a = base + j * n + i;
        this.idx[this.ni++] = a;
        this.idx[this.ni++] = a + n;
        this.idx[this.ni++] = a + 1;
        this.idx[this.ni++] = a + 1;
        this.idx[this.ni++] = a + n;
        this.idx[this.ni++] = a + n + 1;
      }
  }

  /** A tile (tx, tz) filled with a colour. */
  tile(tx: number, tz: number, c: RGBA, inset = 0.04): void {
    this.rect(tx * TILE + inset, tz * TILE + inset, (tx + 1) * TILE - inset, (tz + 1) * TILE - inset, c, 2);
  }

  /** Axis-aligned draped line (ribbon) from (x0,z0) to (x1,z1). */
  line(x0: number, z0: number, x1: number, z1: number, width: number, c: RGBA): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-4) return;
    const steps = Math.max(1, Math.ceil(len / 0.5));
    const nx = (-(z1 - z0) / len) * width * 0.5;
    const nz = ((x1 - x0) / len) * width * 0.5;
    this.ensure((steps + 1) * 2, steps * 6);
    const base = this.nv;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      const y = surfaceY(this.world, x, z) + 0.01;
      this.vert(x + nx, y, z + nz, c);
      this.vert(x - nx, y, z - nz, c);
    }
    for (let s = 0; s < steps; s++) {
      const a = base + s * 2;
      this.idx[this.ni++] = a;
      this.idx[this.ni++] = a + 1;
      this.idx[this.ni++] = a + 2;
      this.idx[this.ni++] = a + 2;
      this.idx[this.ni++] = a + 1;
      this.idx[this.ni++] = a + 3;
    }
  }

  /** Outline of a tile rectangle (inclusive tile coords). */
  outline(tx0: number, tz0: number, tx1: number, tz1: number, width: number, c: RGBA): void {
    const x0 = tx0 * TILE,
      z0 = tz0 * TILE,
      x1 = (tx1 + 1) * TILE,
      z1 = (tz1 + 1) * TILE;
    const h = width / 2;
    this.line(x0 - h, z0, x1 + h, z0, width, c);
    this.line(x0 - h, z1, x1 + h, z1, width, c);
    this.line(x0, z0 + h, x0, z1 - h, width, c);
    this.line(x1, z0 + h, x1, z1 - h, width, c);
  }

  end(): void {
    const g = this.geo;
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    g.index!.needsUpdate = true;
    g.setDrawRange(0, this.ni);
    this.mesh.visible = this.ni > 0;
  }

  clear(): void {
    this.begin();
    this.end();
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------------------
/** Faint tile grid that fades out around a centre tile. */
export class GridOverlay {
  readonly lines: THREE.LineSegments;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  private cx = -999;
  private cz = -999;
  private rev = -1;
  private readonly R = 6;
  private readonly STEP = 4; // samples per tile edge

  constructor(private world: World) {
    const lines = (this.R * 2 + 2) * 2;
    const segs = lines * (this.R * 2 + 1) * this.STEP;
    this.pos = new Float32Array(segs * 2 * 3);
    this.col = new Float32Array(segs * 2 * 4);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, fog: false });
    this.lines = new THREE.LineSegments(this.geo, mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
    this.lines.visible = false;
    this.lines.name = 'ui-grid';
  }

  show(cx: number, cz: number): void {
    this.lines.visible = true;
    if (cx === this.cx && cz === this.cz && this.rev === this.world.revision) return;
    this.cx = cx;
    this.cz = cz;
    this.rev = this.world.revision;
    const R = this.R,
      S = this.STEP;
    let v = 0;
    const c = COL.grid;
    const push = (x: number, z: number, a: number) => {
      this.pos[v * 3] = x;
      this.pos[v * 3 + 1] = surfaceY(this.world, x, z) + 0.015;
      this.pos[v * 3 + 2] = z;
      this.col[v * 4] = c[0];
      this.col[v * 4 + 1] = c[1];
      this.col[v * 4 + 2] = c[2];
      this.col[v * 4 + 3] = a;
      v++;
    };
    const fade = (x: number, z: number) => {
      const d = Math.hypot(x / TILE - (cx + 0.5), z / TILE - (cz + 0.5)) / (R + 0.5);
      return d >= 1 ? 0 : c[3] * (1 - d * d) * (1 - d * d);
    };
    // lines of constant x and constant z through tile corners
    for (let k = -R; k <= R + 1; k++) {
      const gx = (cx + k) * TILE;
      const gz = (cz + k) * TILE;
      for (let t = -R * S; t < (R + 1) * S; t++) {
        const a0 = (cz * S + t) / S,
          a1 = (cz * S + t + 1) / S;
        push(gx, a0 * TILE, fade(gx, a0 * TILE));
        push(gx, a1 * TILE, fade(gx, a1 * TILE));
        const b0 = (cx * S + t) / S,
          b1 = (cx * S + t + 1) / S;
        push(b0 * TILE, gz, fade(b0 * TILE, gz));
        push(b1 * TILE, gz, fade(b1 * TILE, gz));
      }
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    this.geo.setDrawRange(0, v);
  }

  hide(): void {
    this.lines.visible = false;
  }

  dispose(): void {
    this.geo.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------------------
/** Dispose only the materials a props model marks as owned (geometry is shared). */
export function disposeOwned(obj: THREE.Object3D): void {
  const owned = obj.userData.ownedMaterials as THREE.Material[] | undefined;
  if (Array.isArray(owned)) for (const m of owned) m.dispose();
}

interface GhostPart {
  mesh: THREE.InstancedMesh;
  local: THREE.Matrix4;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export type EdgeState = 'new' | 'blocked' | 'same';

/** Instanced, tinted ghost fence segments (one InstancedMesh per segment part). */
export class FenceGhosts {
  readonly group = new THREE.Group();
  private fenceId = 0;
  private parts: GhostPart[] = [];
  private template: THREE.Object3D | null = null;
  private cap = 0;

  constructor(
    private world: World,
    private props: IPropsLayer,
  ) {
    this.group.name = 'ui-fence-ghosts';
  }

  private build(fenceId: number, cap: number): void {
    this.teardown();
    this.fenceId = fenceId;
    this.cap = cap;
    let tpl: THREE.Object3D;
    try {
      tpl = this.props.createFenceSegmentModel(fenceId);
    } catch (err) {
      console.warn('[ui] fence ghost model failed', err);
      return;
    }
    this.template = tpl;
    tpl.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(tpl.matrixWorld).invert();
    tpl.traverse((o) => {
      const src = o as THREE.Mesh;
      if (!src.isMesh) return;
      const mats = Array.isArray(src.material) ? src.material : [src.material];
      for (const m of mats) {
        m.transparent = true;
        m.opacity = 0.8;
        m.depthWrite = true;
        const sm = m as THREE.MeshStandardMaterial;
        if (sm.emissive) {
          // lift the ghost so thin / see-through fence types still read clearly
          sm.emissive.setHex(0x2c4a1e);
          sm.emissiveIntensity = 0.7;
        }
        m.needsUpdate = true;
      }
      const local = new THREE.Matrix4().multiplyMatrices(rootInv, src.matrixWorld);
      const inst = src as unknown as THREE.InstancedMesh;
      if (inst.isInstancedMesh) {
        // expand nested instancing into our own instances
        for (let i = 0; i < inst.count; i++) {
          const im = new THREE.Matrix4();
          inst.getMatrixAt(i, im);
          this.addPart(src.geometry, src.material, new THREE.Matrix4().multiplyMatrices(local, im), cap);
        }
      } else this.addPart(src.geometry, src.material, local, cap);
    });
  }

  private addPart(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], local: THREE.Matrix4, cap: number): void {
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 4;
    mesh.setColorAt(0, _c.setRGB(1, 1, 1));
    this.parts.push({ mesh, local });
    this.group.add(mesh);
  }

  private teardown(): void {
    for (const p of this.parts) {
      this.group.remove(p.mesh);
      p.mesh.dispose();
    }
    this.parts = [];
    if (this.template) disposeOwned(this.template);
    this.template = null;
    this.fenceId = 0;
  }

  /** Show ghosts for these edges (skips 'same' edges). */
  set(fenceId: number, edges: EdgeRef[], states: EdgeState[]): void {
    let n = 0;
    for (let i = 0; i < edges.length; i++) if (states[i] !== 'same') n++;
    if (fenceId !== this.fenceId || n > this.cap) {
      let cap = Math.max(64, this.cap);
      while (cap < n) cap *= 2;
      this.build(fenceId, cap);
    }
    let k = 0;
    for (let i = 0; i < edges.length; i++) {
      const st = states[i];
      if (st === 'same') continue;
      const e = edges[i];
      const cx = e.dir === 'h' ? (e.x + 0.5) * TILE : e.x * TILE;
      const cz = e.dir === 'h' ? e.z * TILE : (e.z + 0.5) * TILE;
      _p.set(cx, this.world.heightAt(cx, cz), cz);
      _q.setFromAxisAngle(UP, e.dir === 'h' ? 0 : -Math.PI / 2);
      _m.compose(_p, _q, _s);
      if (st === 'new') _c.setRGB(0.62, 1.35, 0.55);
      else _c.setRGB(1.6, 0.42, 0.36);
      for (const part of this.parts) {
        part.mesh.setMatrixAt(k, _m2.multiplyMatrices(_m, part.local));
        part.mesh.setColorAt(k, _c);
      }
      k++;
    }
    for (const part of this.parts) {
      part.mesh.count = k;
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
    this.group.visible = k > 0;
  }

  clear(): void {
    for (const part of this.parts) part.mesh.count = 0;
    this.group.visible = false;
  }

  dispose(): void {
    this.teardown();
  }
}

// ---------------------------------------------------------------------------
/** Pulsing ground ring that marks a tap position (animal / staff placement). */
export class Marker {
  readonly mesh: THREE.Mesh;
  private t = 0;
  constructor() {
    const g = new THREE.RingGeometry(0.62, 0.86, 48);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({ color: 0x9fe870, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
    this.mesh.name = 'ui-marker';
  }
  place(x: number, y: number, z: number, ok: boolean, scale = 1): void {
    this.mesh.position.set(x, y, z);
    (this.mesh.material as THREE.MeshBasicMaterial).color.setHex(ok ? 0x9fe870 : 0xff6a50);
    this.mesh.userData.base = scale;
    this.mesh.visible = true;
  }
  hide(): void {
    this.mesh.visible = false;
  }
  update(dt: number): void {
    if (!this.mesh.visible) return;
    this.t += dt;
    const base = (this.mesh.userData.base as number) || 1;
    const s = base * (1 + 0.08 * Math.sin(this.t * 5));
    this.mesh.scale.set(s, 1, s);
  }
  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Make a props model look like a translucent placement ghost. */
export function ghostify(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 4;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      m.transparent = true;
      m.opacity = Math.min(m.opacity, 0.8);
      m.depthWrite = true;
      m.needsUpdate = true;
    }
  });
}

/** Tint a ghost: green = valid, red = invalid (uses emissive where available). */
export function tintGhost(obj: THREE.Object3D, ok: boolean): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const sm = m as THREE.MeshStandardMaterial;
      if (sm.emissive) {
        sm.emissive.setHex(ok ? 0x2f7a1c : 0xa02a18);
        sm.emissiveIntensity = ok ? 0.32 : 0.6;
      }
    }
  });
}
