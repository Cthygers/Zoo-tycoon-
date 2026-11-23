// Prop batching back-ends with per-instance culling, LOD selection and
// shadow-caster selection.
//
//  - MultiBatch (default when WEBGL_multi_draw exists): one BatchedMesh per
//    material + attribute layout. The draw list is built by our own culling
//    (not three's): per-instance world bounding spheres are cached in typed
//    arrays, so the main pass tests camera frustum + per-instance max draw
//    distance + LOD level, and the shadow pass only draws instances flagged
//    as casters that lie within their own shadow distance of the camera focus
//    (and inside the shadow camera's frustum). One multi-draw call per batch
//    per pass; batches with nothing to draw are hidden (no program switch).
//    Each pass has its own draw-id texture, re-uploaded only when its list
//    changes (a still camera uploads nothing).
//  - InstancedBatch (fallback): one InstancedMesh per geometry + material,
//    swap-remove packed; distance + LOD culled into the GPU buffer; casts
//    shadows only while one of its casters is near the camera focus.

import * as THREE from 'three';
import { setupWindMesh } from '../wind';

/** Shared per-frame culling inputs (filled by the layer). */
export interface CullView {
  camera: THREE.Camera | null;
  cam: THREE.Vector3;
  /** Ground point the camera looks at (shadow-caster centre). */
  focus: THREE.Vector3;
  /** Frustum planes of `camera` (nx, ny, nz, constant) × 6. */
  planes: Float32Array;
  shadows: boolean;
}

/** Per-instance culling parameters. */
export interface InstParams {
  /** Max camera distance (m) at which it is drawn; Infinity = always. */
  cull: number;
  /**
   * Distance band LOD: drawn only beyond this camera distance (m), in both
   * passes; an instance with minDist > 0 or a finite cull in band mode swaps
   * exactly at the boundary with its counterpart (no per-object LOD pass).
   */
  minDist?: number;
  /** Apply the camera-distance band to the shadow pass too (band-swapped versions). */
  band?: boolean;
  /** Max horizontal distance (m) from the focus at which it casts shadows; 0 = never. */
  shadow: number;
  /** Drawn at the object's current LOD level. */
  lodOn: boolean;
  /** Drawn in the shadow pass at the object's current level (defaults to lodOn). */
  shadowOn?: boolean;
  /** Per-instance colour (batches whose material was merged from colour variants). */
  tint?: THREE.Color | null;
}

export interface SlotRef {
  /** Object id (for picking). */
  id: number;
  /** Updated by swap-remove back-ends. */
  slot: { index: number };
}

/** Common surface of the two batching back-ends. */
export interface PropBatch {
  readonly mesh: THREE.Mesh;
  /** Instances changed since the last cull. */
  dirty: boolean;
  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, ref: SlotRef, p: InstParams): number;
  set(slot: number, matrix: THREE.Matrix4): void;
  setLodOn(slot: number, on: boolean, shadowOn?: boolean): void;
  remove(slot: number): void;
  clear(): void;
  /** Build the main-pass draw list (and shadow candidates) for this frame. */
  cull(view: CullView): void;
  /** Live instances. */
  size(): number;
  /** Instances in the last main-pass draw list. */
  drawn(): number;
  /** Object id behind a raycast hit on `mesh`. */
  ownerOf(hit: THREE.Intersection): number | null;
  setShadows(on: boolean): void;
  dispose(): void;
}

let multiDrawSupport: boolean | null = null;
/** Does this browser expose WEBGL_multi_draw (checked once on a throw-away context)? */
export function supportsMultiDraw(): boolean {
  if (multiDrawSupport !== null) return multiDrawSupport;
  multiDrawSupport = false;
  try {
    if (typeof document === 'undefined') return false;
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl) {
      multiDrawSupport = gl.getExtension('WEBGL_multi_draw') !== null;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    multiDrawSupport = false;
  }
  return multiDrawSupport;
}

/** Frustum planes → flat array (nx, ny, nz, d) × 6. */
export function frustumToArray(f: THREE.Frustum, out: Float32Array): Float32Array {
  for (let i = 0; i < 6; i++) {
    const p = f.planes[i];
    out[i * 4] = p.normal.x;
    out[i * 4 + 1] = p.normal.y;
    out[i * 4 + 2] = p.normal.z;
    out[i * 4 + 3] = p.constant;
  }
  return out;
}

function sphereOutside(p: Float32Array, x: number, y: number, z: number, r: number): boolean {
  for (let i = 0; i < 24; i += 4) if (p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3] < -r) return true;
  return false;
}

// three.js internals of BatchedMesh we drive directly (r187)
interface BatchedInternals {
  _multiDrawStarts: Int32Array;
  _multiDrawCounts: Int32Array;
  _multiDrawCount: number;
  _indirectTexture: THREE.DataTexture;
}

const F_ACTIVE = 1;
const F_LODON = 2;
/** Drawn in the shadow pass (shadows may use a cheaper LOD than the view). */
const F_SHADOWON = 4;
/** Distance band applies to shadows too. */
const F_BAND = 8;

/** A draw-id texture shaped like BatchedMesh's own (one uint per instance), uploaded on first use. */
function idTextureLike(t: THREE.DataTexture): THREE.DataTexture {
  const { width, height } = t.image;
  const c = new THREE.DataTexture(new Uint32Array(width * height), width, height, THREE.RedIntegerFormat, THREE.UnsignedIntType);
  c.needsUpdate = true;
  return c;
}

const _frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();
const _planes = new Float32Array(24);
const _s = new THREE.Sphere();

class PropBatchedMesh extends THREE.BatchedMesh {
  owner: MultiBatch | null = null;
  override onBeforeRender(_r: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry): void {
    this.owner?.writeMain(camera, geometry);
  }
  override onBeforeShadow(_r: THREE.WebGLRenderer, _o: THREE.Scene, _c: THREE.Camera, shadowCamera: THREE.Camera, geometry: THREE.BufferGeometry): void {
    this.owner?.writeShadow(shadowCamera, geometry);
  }
}

/** BatchedMesh back-end: every geometry using one material in a single multi-draw. */
export class MultiBatch implements PropBatch {
  readonly mesh: PropBatchedMesh;
  dirty = true;
  private geoIds = new Map<THREE.BufferGeometry, number>();
  private gStart: number[] = [];
  private gCount: number[] = [];
  /** Local bounding sphere per geometry id (x, y, z, r). */
  private gSph: number[] = [];
  private maxV = 4096;
  private maxI = 8192;
  private usedV = 0;
  private usedI = 0;
  private maxInst = 16;
  private live = 0;
  /** Instance id high-water mark. */
  private hw = 0;
  private owners = new Int32Array(16).fill(-1);
  private geo = new Int32Array(16);
  private flags = new Uint8Array(16);
  /** World bounding sphere per instance (x, y, z, r). */
  private sph = new Float32Array(64);
  private cull2 = new Float32Array(16);
  private shadow2 = new Float32Array(16);
  private min2 = new Float32Array(16);
  private mainIds = new Int32Array(16);
  private mainN = 0;
  private shIds = new Int32Array(16);
  private shN = 0;
  private shOut = new Int32Array(16);
  private casters = 0;
  private shadowsOn: boolean;
  private culledFor: THREE.Camera | null = null;
  private view: CullView | null = null;
  /** Draw-id textures of the two passes (main = three's own). */
  private mainIdsTex: THREE.DataTexture;
  private shadowIdsTex: THREE.DataTexture;

  constructor(
    material: THREE.Material,
    shadows: boolean,
    private readonly parent: THREE.Object3D,
  ) {
    const m = new PropBatchedMesh(this.maxInst, this.maxV, this.maxI, material);
    m.owner = this;
    m.sortObjects = false;
    m.perObjectFrustumCulled = false; // our own culling (onBeforeRender / onBeforeShadow)
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = shadows;
    m.visible = false;
    m.name = 'prop-multibatch';
    setupWindMesh(m);
    this.shadowsOn = shadows;
    this.mesh = m;
    this.mainIdsTex = (m as unknown as BatchedInternals)._indirectTexture;
    this.mainIdsTex.needsUpdate = true;
    this.shadowIdsTex = idTextureLike(this.mainIdsTex);
    parent.add(m);
  }

  private grow(n: number): void {
    const g = <T extends Int32Array | Uint8Array | Float32Array>(a: T, size: number, fill = 0): T => {
      const b = new (a.constructor as new (n: number) => T)(size);
      if (fill) b.fill(fill);
      b.set(a);
      return b;
    };
    this.owners = g(this.owners, n, -1);
    this.geo = g(this.geo, n);
    this.flags = g(this.flags, n);
    this.sph = g(this.sph, n * 4);
    this.cull2 = g(this.cull2, n);
    this.shadow2 = g(this.shadow2, n);
    this.min2 = g(this.min2, n);
    this.mainIds = new Int32Array(n);
    this.shIds = new Int32Array(n);
    this.shOut = new Int32Array(n);
    this.mainN = 0;
    this.shN = 0;
  }

  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, ref: SlotRef, p: InstParams): number {
    const mesh = this.mesh;
    let gid = this.geoIds.get(geometry);
    if (gid === undefined) {
      const vc = geometry.getAttribute('position').count;
      const ic = geometry.index ? geometry.index.count : 0;
      if (this.usedV + vc > this.maxV || this.usedI + ic > this.maxI) {
        while (this.usedV + vc > this.maxV) this.maxV *= 2;
        while (this.usedI + ic > this.maxI) this.maxI *= 2;
        mesh.setGeometrySize(this.maxV, this.maxI);
      }
      gid = mesh.addGeometry(geometry);
      this.usedV += vc;
      this.usedI += ic;
      this.geoIds.set(geometry, gid);
      const r = mesh.getGeometryRangeAt(gid)!;
      this.gStart[gid] = geometry.index ? r.indexStart : r.vertexStart;
      this.gCount[gid] = geometry.index ? r.indexCount : r.vertexCount;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const bs = geometry.boundingSphere!;
      this.gSph[gid * 4] = bs.center.x;
      this.gSph[gid * 4 + 1] = bs.center.y;
      this.gSph[gid * 4 + 2] = bs.center.z;
      this.gSph[gid * 4 + 3] = bs.radius;
    }
    if (this.live >= this.maxInst) {
      this.maxInst *= 2;
      // three re-creates (and copies) the texture it currently holds: hand it its own
      const internal = mesh as unknown as BatchedInternals;
      internal._indirectTexture = this.mainIdsTex;
      mesh.setInstanceCount(this.maxInst);
      this.mainIdsTex = internal._indirectTexture;
      this.mainIdsTex.needsUpdate = true;
      this.shadowIdsTex.dispose();
      this.shadowIdsTex = idTextureLike(this.mainIdsTex);
      this.grow(this.maxInst);
    }
    const id = mesh.addInstance(gid);
    if (id >= this.owners.length) this.grow(Math.max(this.maxInst, id + 1));
    this.live++;
    this.hw = Math.max(this.hw, id + 1);
    this.owners[id] = ref.id;
    this.geo[id] = gid;
    this.flags[id] = F_ACTIVE | (p.lodOn ? F_LODON : 0) | ((p.shadowOn ?? p.lodOn) ? F_SHADOWON : 0) | (p.band ? F_BAND : 0);
    this.min2[id] = p.minDist ? p.minDist * p.minDist : 0;
    this.cull2[id] = p.cull === Infinity ? Infinity : p.cull * p.cull;
    this.shadow2[id] = p.shadow * p.shadow;
    if (p.shadow > 0) this.casters++;
    if (!p.lodOn) mesh.setVisibleAt(id, false);
    if (p.tint) mesh.setColorAt(id, p.tint);
    this.set(id, matrix);
    return id;
  }

  set(id: number, matrix: THREE.Matrix4): void {
    this.mesh.setMatrixAt(id, matrix);
    const g = this.geo[id] * 4;
    _s.center.set(this.gSph[g], this.gSph[g + 1], this.gSph[g + 2]).applyMatrix4(matrix);
    const o = id * 4;
    this.sph[o] = _s.center.x;
    this.sph[o + 1] = _s.center.y;
    this.sph[o + 2] = _s.center.z;
    this.sph[o + 3] = this.gSph[g + 3] * matrix.getMaxScaleOnAxis();
    this.dirty = true;
  }

  setLodOn(id: number, on: boolean, shadowOn = on): void {
    const f = this.flags[id];
    if (!(f & F_ACTIVE)) return;
    const nf = (f & ~(F_LODON | F_SHADOWON)) | (on ? F_LODON : 0) | (shadowOn ? F_SHADOWON : 0);
    if (nf === f) return;
    this.flags[id] = nf;
    if (((f ^ nf) & F_LODON) !== 0) this.mesh.setVisibleAt(id, on); // keeps raycasts on the drawn LOD only
    this.dirty = true;
  }

  remove(id: number): void {
    if (!(this.flags[id] & F_ACTIVE)) return;
    this.mesh.deleteInstance(id);
    if (this.shadow2[id] > 0) this.casters--;
    this.flags[id] = 0;
    this.owners[id] = -1;
    this.live--;
    this.dirty = true;
  }

  clear(): void {
    for (let id = 0; id < this.hw; id++) if (this.flags[id] & F_ACTIVE) this.remove(id);
    this.hw = 0;
    this.mainN = 0;
    this.shN = 0;
    this.mesh.visible = false;
  }

  cull(view: CullView): void {
    this.view = view;
    this.dirty = false;
    this.culledFor = view.camera;
    const p = view.planes;
    const cx = view.cam.x;
    const cy = view.cam.y;
    const cz = view.cam.z;
    const fx = view.focus.x;
    const fz = view.focus.z;
    const shadows = view.shadows && this.shadowsOn && this.casters > 0;
    const flags = this.flags;
    const sph = this.sph;
    const cull2 = this.cull2;
    const min2 = this.min2;
    const shadow2 = this.shadow2;
    const main = this.mainIds;
    const sh = this.shIds;
    let n = 0;
    let s = 0;
    for (let id = 0; id < this.hw; id++) {
      const f = flags[id];
      if (!(f & F_ACTIVE)) continue;
      const o = id * 4;
      const x = sph[o];
      const y = sph[o + 1];
      const z = sph[o + 2];
      const c2 = cull2[id];
      const m2 = min2[id];
      let out = false;
      if (c2 !== Infinity || m2 > 0) {
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        out = d2 > c2 || d2 <= m2;
      }
      if (shadows && f & F_SHADOWON && !(out && f & F_BAND)) {
        const s2 = shadow2[id];
        if (s2 > 0) {
          const dx = x - fx;
          const dz = z - fz;
          if (dx * dx + dz * dz <= s2) sh[s++] = id;
        }
      }
      if (out || !(f & F_LODON)) continue;
      if (sphereOutside(p, x, y, z, sph[o + 3])) continue;
      main[n++] = id;
    }
    this.mainN = n;
    this.shN = s;
    this.mesh.visible = n > 0 || s > 0;
    this.mesh.castShadow = s > 0;
  }

  /** Called from onBeforeRender: hand the main-pass list to three. */
  writeMain(camera: THREE.Camera, geometry: THREE.BufferGeometry): void {
    if (this.view && (this.dirty || camera !== this.culledFor)) {
      // another camera (or changes after the layer's cull): frustum-test now
      _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_m, camera.coordinateSystem);
      const saved = this.view.planes;
      const savedCam = this.view.camera;
      this.view.planes = frustumToArray(_frustum, _planes);
      this.view.camera = camera;
      this.cull(this.view);
      this.view.planes = saved;
      this.view.camera = savedCam;
    }
    this.write(this.mainIds, this.mainN, geometry, this.mainIdsTex);
  }

  /** Called from onBeforeShadow: casters near the focus inside the shadow frustum. */
  writeShadow(shadowCamera: THREE.Camera, geometry: THREE.BufferGeometry): void {
    _m.multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_m, shadowCamera.coordinateSystem);
    const p = frustumToArray(_frustum, _planes);
    const sph = this.sph;
    const ids = this.shIds;
    const out = this.shOut;
    let n = 0;
    for (let i = 0; i < this.shN; i++) {
      const id = ids[i];
      const o = id * 4;
      if (!sphereOutside(p, sph[o], sph[o + 1], sph[o + 2], sph[o + 3])) out[n++] = id;
    }
    this.write(out, n, geometry, this.shadowIdsTex);
  }

  /** Hand a pass's draw list to three (draw ranges + its draw-id texture). */
  private write(ids: Int32Array, n: number, geometry: THREE.BufferGeometry, tex: THREE.DataTexture): void {
    const internal = this.mesh as unknown as BatchedInternals;
    const starts = internal._multiDrawStarts;
    const counts = internal._multiDrawCounts;
    const indirect = tex.image.data as Uint32Array;
    let changed = false;
    const bpe = geometry.index ? geometry.index.array.BYTES_PER_ELEMENT : 1;
    const gs = this.gStart;
    const gc = this.gCount;
    const geo = this.geo;
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      const g = geo[id];
      starts[i] = gs[g] * bpe;
      counts[i] = gc[g];
      if (indirect[i] !== id) {
        indirect[i] = id;
        changed = true;
      }
    }
    internal._multiDrawCount = n;
    internal._indirectTexture = tex;
    // the GPU copy always matches `indirect` (every change is uploaded), and
    // entries past n are never read
    if (changed) tex.needsUpdate = true;
  }

  size(): number {
    return this.live;
  }

  drawn(): number {
    return this.mainN;
  }

  ownerOf(hit: THREE.Intersection): number | null {
    const id = hit.batchId;
    if (id === undefined) return null;
    const o = this.owners[id];
    return o !== undefined && o >= 0 ? o : null;
  }

  setShadows(on: boolean): void {
    this.shadowsOn = on;
    this.mesh.receiveShadow = on;
    if (!on) this.mesh.castShadow = false;
    this.dirty = true;
  }

  dispose(): void {
    this.mesh.owner = null;
    this.parent.remove(this.mesh);
    (this.mesh as unknown as BatchedInternals)._indirectTexture = this.mainIdsTex;
    this.mesh.dispose();
    this.shadowIdsTex.dispose();
  }
}

/** InstancedMesh back-end: one geometry + material, swap-remove packed storage. */
export class InstancedBatch implements PropBatch {
  mesh: THREE.InstancedMesh;
  private cap = 0;
  n = 0;
  /** Master matrices (all live instances, packed). */
  private mats = new Float32Array(0);
  private cull2 = new Float32Array(0);
  /** Squared shadow distance from the focus per instance (0 = never casts). */
  private shadow2 = new Float32Array(0);
  private on = new Uint8Array(0);
  private refs: SlotRef[] = [];
  /** Object id per drawn instance (after culling). */
  private visOwners = new Int32Array(0);
  dirty = true;
  private shadowsOn: boolean;
  private lastCam = new THREE.Vector3(1e9, 0, 0);

  constructor(
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly cast: boolean,
    shadows: boolean,
    private readonly parent: THREE.Object3D,
  ) {
    this.shadowsOn = shadows;
    this.mesh = this.create(8);
  }

  private create(cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.geometry, this.material, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.visible = false;
    m.castShadow = this.cast && this.shadowsOn;
    m.receiveShadow = this.shadowsOn;
    m.name = 'prop-batch';
    setupWindMesh(m);
    const grow = <T extends Float32Array | Uint8Array | Int32Array>(a: T, size: number): T => {
      const b = new (a.constructor as new (n: number) => T)(size);
      b.set(a.subarray(0, Math.min(a.length, size)));
      return b;
    };
    this.mats = grow(this.mats, cap * 16);
    this.cull2 = grow(this.cull2, cap);
    this.shadow2 = grow(this.shadow2, cap);
    this.on = grow(this.on, cap);
    this.visOwners = grow(this.visOwners, cap);
    this.cap = cap;
    this.parent.add(m);
    return m;
  }

  add(_geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, ref: SlotRef, p: InstParams): number {
    if (this.n >= this.cap) {
      const old = this.mesh;
      this.mesh = this.create(this.cap * 2);
      this.parent.remove(old);
      old.dispose();
    }
    const i = this.n++;
    matrix.toArray(this.mats, i * 16);
    this.cull2[i] = p.cull === Infinity ? Infinity : p.cull * p.cull;
    this.shadow2[i] = p.shadow * p.shadow;
    this.on[i] = p.lodOn ? 1 : 0;
    this.refs[i] = ref;
    this.dirty = true;
    return i;
  }

  set(i: number, matrix: THREE.Matrix4): void {
    matrix.toArray(this.mats, i * 16);
    this.dirty = true;
  }

  setLodOn(i: number, on: boolean): void {
    // (no separate shadow LOD in the fallback: shadows follow the drawn level)
    const v = on ? 1 : 0;
    if (this.on[i] === v) return;
    this.on[i] = v;
    this.dirty = true;
  }

  remove(i: number): void {
    const last = --this.n;
    if (i !== last) {
      this.mats.copyWithin(i * 16, last * 16, last * 16 + 16);
      this.cull2[i] = this.cull2[last];
      this.shadow2[i] = this.shadow2[last];
      this.on[i] = this.on[last];
      const moved = this.refs[last];
      this.refs[i] = moved;
      moved.slot.index = i;
    }
    this.refs.length = last;
    this.dirty = true;
  }

  clear(): void {
    this.n = 0;
    this.refs.length = 0;
    this.dirty = true;
  }

  cull(view: CullView): void {
    // distance / LOD culling into the GPU buffer (frustum culling is per mesh)
    if (!this.dirty && this.lastCam.distanceToSquared(view.cam) < 4) return;
    const mesh = this.mesh;
    const dst = mesh.instanceMatrix.array as Float32Array;
    const src = this.mats;
    const cam = view.cam;
    const f = view.focus;
    // the shadow pass draws every drawn instance, so cast only while one of them
    // is a caster within its shadow distance of the focus
    const canCast = this.cast && this.shadowsOn && view.shadows;
    let nearCaster = false;
    let count = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.on[i]) continue;
      const o = i * 16;
      const c2 = this.cull2[i];
      if (c2 !== Infinity) {
        const dx = src[o + 12] - cam.x;
        const dy = src[o + 13] - cam.y;
        const dz = src[o + 14] - cam.z;
        if (dx * dx + dy * dy + dz * dz > c2) continue;
      }
      if (canCast && !nearCaster) {
        const dx = src[o + 12] - f.x;
        const dz = src[o + 14] - f.z;
        nearCaster = dx * dx + dz * dz <= this.shadow2[i];
      }
      dst.set(src.subarray(o, o + 16), count * 16);
      this.visOwners[count] = this.refs[i].id;
      count++;
    }
    this.lastCam.copy(cam);
    mesh.count = count;
    mesh.visible = count > 0;
    mesh.castShadow = canCast && nearCaster;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, Math.max(count, 1) * 16);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.boundingSphere = null;
    mesh.boundingBox = null;
    if (count > 0) mesh.computeBoundingSphere();
    this.dirty = false;
  }

  size(): number {
    return this.n;
  }

  drawn(): number {
    return this.mesh.count;
  }

  ownerOf(hit: THREE.Intersection): number | null {
    const i = hit.instanceId;
    return i !== undefined && i < this.mesh.count ? this.visOwners[i] : null;
  }

  setShadows(on: boolean): void {
    this.shadowsOn = on;
    this.mesh.castShadow = on && this.cast;
    this.mesh.receiveShadow = on;
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
  }
}
