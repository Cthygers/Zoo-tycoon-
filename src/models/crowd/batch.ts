// Batched creature rendering built on THREE.BatchedMesh.
//
// One BatchedMesh draws many instances of several geometries (body variants ×
// LOD levels) with a single multi-draw call. three.js culls every instance
// against the camera frustum (and, in the shadow pass, against the shadow
// camera), compacts the surviving instances into the multi-draw list and
// sorts them front to back — per render pass, with no allocations.
//
// On top of that this file adds:
//   * FilteredBatch — per-instance "visible" and "casts shadow" flags (only
//     near creatures cast shadows: far ones are hidden during the shadow pass),
//     automatic capacity growth (instances and vertex / index buffers), and a
//     per-frame bounding sphere so a batch with nothing on screen is skipped.
//   * SkinnedBatch — per-instance bone matrices + look parameters in one float
//     DataTexture (see skinning.ts), uploaded once per frame (only the rows in
//     use).

import * as THREE from 'three';
import type { CrowdUniforms } from './skinning';

const _box = new THREE.Box3();
const _v = new THREE.Vector3();

export interface BatchGeometryInfo {
  id: number;
  vertices: number;
  indices: number;
}

/** BatchedMesh with visibility / shadow flags per instance and buffer growth. */
export class FilteredBatch extends THREE.BatchedMesh {
  /** Desired visibility per instance id (1 = visible). */
  protected want = new Uint8Array(16);
  /** Shadow casting per instance id. */
  protected shadow = new Uint8Array(16);
  /** Geometry id used in the shadow pass (-1 = same as the main pass). */
  protected shadowGeo = new Int32Array(16).fill(-1);
  /** Ids temporarily hidden for the current shadow pass. */
  private readonly hidden: number[] = [];
  /** (id, main geometry id) pairs swapped to their shadow geometry for the current shadow pass. */
  private readonly swapped: number[] = [];
  private readonly geometries = new Map<string, BatchGeometryInfo>();
  private boundsCount = 0;
  private boundsRadius = 0;
  /** Live instances (not counting freed ids). */
  live = 0;

  constructor(name: string, material: THREE.Material, instances: number, vertices: number, indices: number) {
    super(Math.max(4, instances), Math.max(64, vertices), Math.max(192, indices), material);
    this.name = name;
    // instances move every frame: per-frame bounds are set by beginBounds/endBounds
    this.frustumCulled = true;
    this.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    this.castShadow = true;
    this.receiveShadow = true;
  }

  /** Geometry id for a key, or -1 when the key was never added. */
  geometryId(key: string): number {
    return this.geometries.get(key)?.id ?? -1;
  }

  /**
   * Add a geometry under `key` (no-op when present). `sphere` (mesh space)
   * replaces the geometry's own bounds for instance culling (posed creatures
   * reach outside their rest-pose bounds).
   */
  addKeyedGeometry(key: string, geo: THREE.BufferGeometry, sphere?: THREE.Sphere): number {
    const have = this.geometries.get(key);
    if (have) return have.id;
    const nv = geo.getAttribute('position').count;
    const ni = geo.getIndex()?.count ?? 0;
    if (this.unusedVertexCount < nv || this.unusedIndexCount < ni) {
      const usedV = this.usedVertices();
      const usedI = this.usedIndices();
      const nV = Math.max(this.vertexCapacity() * 2, usedV + nv * 2);
      const nI = Math.max(this.indexCapacity() * 2, usedI + ni * 2);
      this.setGeometrySize(nV, nI);
    }
    const saved = geo.boundingSphere;
    if (sphere) geo.boundingSphere = sphere;
    let id: number;
    try {
      id = this.addGeometry(geo);
    } finally {
      geo.boundingSphere = saved;
    }
    this.geometries.set(key, { id, vertices: nv, indices: ni });
    return id;
  }

  private vertexCapacity(): number {
    return this.usedVertices() + this.unusedVertexCount;
  }
  private indexCapacity(): number {
    return this.usedIndices() + this.unusedIndexCount;
  }
  private usedVertices(): number {
    let n = 0;
    for (const g of this.geometries.values()) n += g.vertices;
    return n;
  }
  private usedIndices(): number {
    let n = 0;
    for (const g of this.geometries.values()) n += g.indices;
    return n;
  }

  /** Add an instance of a geometry; grows the instance capacity when needed. */
  addSlot(geometryId: number): number {
    if (this.live >= this.maxInstanceCount) this.grow(this.maxInstanceCount * 2);
    const id = this.addInstance(geometryId);
    this.live++;
    this.ensureFlags(id + 1);
    this.want[id] = 1;
    this.shadow[id] = 1;
    this.shadowGeo[id] = -1;
    this.onInstanceAdded(id);
    return id;
  }

  removeSlot(id: number): void {
    this.deleteInstance(id);
    this.want[id] = 0;
    this.shadow[id] = 0;
    this.shadowGeo[id] = -1;
    this.live--;
  }

  protected grow(capacity: number): void {
    this.setInstanceCount(capacity);
    this.ensureFlags(capacity);
  }

  /** Hook for subclasses (data blocks). */
  protected onInstanceAdded(_id: number): void {}

  private ensureFlags(n: number): void {
    if (n <= this.want.length) return;
    let cap = this.want.length;
    while (cap < n) cap *= 2;
    const w = new Uint8Array(cap);
    w.set(this.want);
    const s = new Uint8Array(cap);
    s.set(this.shadow);
    const g = new Int32Array(cap).fill(-1);
    g.set(this.shadowGeo);
    this.want = w;
    this.shadow = s;
    this.shadowGeo = g;
  }

  setVisible(id: number, on: boolean): void {
    const v = on ? 1 : 0;
    if (this.want[id] === v) return;
    this.want[id] = v;
    this.setVisibleAt(id, on);
  }

  isVisible(id: number): boolean {
    return this.want[id] === 1;
  }

  setCastShadow(id: number, on: boolean): void {
    this.shadow[id] = on ? 1 : 0;
  }

  castsShadowAt(id: number): boolean {
    return this.shadow[id] === 1;
  }

  /** Use a (cheaper) geometry for this instance in the shadow pass; -1 = same as the main pass. */
  setShadowGeometry(id: number, geometryId: number): void {
    this.shadowGeo[id] = geometryId;
  }

  setGeometry(id: number, geometryId: number): void {
    if (this.getGeometryIdAt(id) !== geometryId) this.setGeometryIdAt(id, geometryId);
  }

  // ---- per-frame bounds (lets three skip the whole batch when nothing is in view)
  beginBounds(): void {
    _box.makeEmpty();
    this.boundsCount = 0;
    this.boundsRadius = 0;
    this.anyShadow = false;
  }
  private anyShadow = false;

  /** Include an instance at world position `p` with radius `r`. */
  includeBounds(p: THREE.Vector3, r: number, shadow: boolean): void {
    _box.expandByPoint(p);
    if (r > this.boundsRadius) this.boundsRadius = r;
    this.boundsCount++;
    if (shadow) this.anyShadow = true;
  }

  endBounds(): void {
    const s = this.boundingSphere!;
    if (!this.boundsCount) {
      this.visible = false;
      return;
    }
    this.visible = true;
    _box.getCenter(s.center);
    s.radius = _box.getSize(_v).length() * 0.5 + this.boundsRadius;
    this.castShadow = this.anyShadow;
  }

  // ---- shadow pass: hide instances that do not cast shadows
  onBeforeShadow(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    shadowCamera: THREE.Camera,
    geometry: THREE.BufferGeometry,
    depthMaterial: THREE.Material,
    group: THREE.Group,
  ): void {
    const h = this.hidden;
    const sw = this.swapped;
    h.length = 0;
    sw.length = 0;
    const n = Math.min(this.want.length, this.maxInstanceCount);
    for (let i = 0; i < n; i++) {
      if (!this.want[i]) continue;
      if (!this.shadow[i]) {
        this.setVisibleAt(i, false);
        h.push(i);
      } else if (this.shadowGeo[i] >= 0) {
        const g = this.getGeometryIdAt(i);
        if (g !== this.shadowGeo[i]) {
          sw.push(i, g);
          this.setGeometryIdAt(i, this.shadowGeo[i]);
        }
      }
    }
    super.onBeforeShadow(renderer, scene, camera, shadowCamera, geometry, depthMaterial, group);
  }

  onAfterShadow(): void {
    const h = this.hidden;
    for (let i = 0; i < h.length; i++) this.setVisibleAt(h[i], true);
    h.length = 0;
    const sw = this.swapped;
    for (let i = 0; i < sw.length; i += 2) this.setGeometryIdAt(sw[i], sw[i + 1]);
    sw.length = 0;
  }

  /** Number of draws in the last computed multi-draw list (for tests / stats). */
  get lastDrawCount(): number {
    return (this as unknown as { _multiDrawCount: number })._multiDrawCount;
  }

  /** Instance ids of the last computed multi-draw list, in draw order. */
  lastDrawIds(out: number[] = []): number[] {
    const tex = (this as unknown as { _indirectTexture: THREE.DataTexture })._indirectTexture;
    const data = tex.image.data as Uint32Array;
    out.length = 0;
    for (let i = 0; i < this.lastDrawCount; i++) out.push(data[i]);
    return out;
  }
}

export const DATA_WIDTH = 2048;

/**
 * FilteredBatch whose instances carry a block of `stride` RGBA float texels in
 * a shared DataTexture: `look` parameter texels followed by 3 texels per bone.
 */
export class SkinnedBatch extends FilteredBatch {
  readonly stride: number;
  readonly look: number;
  readonly bones: number;
  data: Float32Array;
  texture: THREE.DataTexture;
  private readonly uniforms: CrowdUniforms[];
  private maxUsed = 0;

  constructor(
    name: string,
    material: THREE.Material,
    depthMaterial: THREE.Material,
    uniforms: CrowdUniforms[],
    opts: { bones: number; look: number; instances: number; vertices: number; indices: number },
  ) {
    super(name, material, opts.instances, opts.vertices, opts.indices);
    this.bones = opts.bones;
    this.look = opts.look;
    this.stride = opts.look + opts.bones * 3;
    this.uniforms = uniforms;
    this.customDepthMaterial = depthMaterial;
    this.data = new Float32Array(0);
    this.texture = this.makeTexture(this.maxInstanceCount);
  }

  private makeTexture(capacity: number): THREE.DataTexture {
    const texels = capacity * this.stride;
    const w = Math.min(DATA_WIDTH, Math.max(16, 1 << Math.ceil(Math.log2(texels))));
    const h = Math.max(1, Math.ceil(texels / w));
    const data = new Float32Array(w * h * 4);
    data.set(this.data.subarray(0, Math.min(this.data.length, data.length)));
    this.data = data;
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    for (const u of this.uniforms) {
      u.crData.value = tex;
      u.crStride.value = this.stride;
      u.crLook.value = this.look;
    }
    return tex;
  }

  protected grow(capacity: number): void {
    super.grow(capacity);
    const old = this.texture;
    this.texture = this.makeTexture(capacity);
    old.dispose();
  }

  protected onInstanceAdded(id: number): void {
    const o = id * this.stride * 4;
    this.data.fill(0, o, o + this.stride * 4);
    if (id + 1 > this.maxUsed) this.maxUsed = id + 1;
  }

  /** Float offset of an instance's block in `data`. */
  offset(id: number): number {
    return id * this.stride * 4;
  }

  /** Float offset of an instance's first bone row. */
  boneOffset(id: number): number {
    return (id * this.stride + this.look) * 4;
  }

  /** Mark the rows in use for upload (call once per frame after writing). */
  flush(): void {
    if (!this.live) return;
    const tex = this.texture;
    const w = tex.image.width;
    const rows = Math.min(tex.image.height, Math.ceil((this.maxUsed * this.stride) / w));
    if (rows >= tex.image.height) {
      tex.clearUpdateRanges();
    } else {
      tex.clearUpdateRanges();
      for (let r = 0; r < rows; r++) tex.addUpdateRange(r * w * 4, w * 4);
    }
    tex.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    for (const u of this.uniforms) u.crData.value = null;
    super.dispose();
  }
}
