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
//   * the follow cut (setCreatureFollowCut): while the camera follows a
//     subject up close, other animals between the camera and the subject are
//     left out of the main pass (whole animals, and their shadows with them).
//   * SkinnedBatch — per-instance bone matrices + look parameters in one float
//     DataTexture (see skinning.ts); each frame only the blocks written since
//     the last upload are sent (creatures animated at a reduced rate, see
//     views, skip frames).
//
// Every texture upload costs a bind + texSubImage2D (and a GPU-process copy on
// Android), so all three per-batch textures upload only what changed: the
// matrix texture when an instance moved, the draw-id texture (one per pass)
// when the culled / sorted list differs from the one on the GPU.

import * as THREE from 'three';
import type { CrowdUniforms } from './skinning';

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _box = new THREE.Box3();
const _cam = new THREE.Vector3();

/**
 * Follow cut of other animals. Following a subject at the closest zooms, an
 * animal standing between the camera and the subject filled the frame (a
 * camel in front of the followed camel, an elephant in front of a hippo).
 * While a subject is set and the camera is within FOLLOW_CUT_MAX_D of it,
 * batches with `followCut` leave out of the main pass every instance whose
 * body stands in front of the subject (its body centre at least CUT_FRONT
 * ahead of the subject on the ground, toward the camera) and comes within
 * the cut margin of the view line from the camera to the subject: whole
 * animals, never the subject itself, with a wider margin to come back so one
 * standing at the edge does not flicker. Their shadows go too: an elephant's
 * legs left as dark blotches across the followed hippo, or an elephant-shaped
 * shadow on empty lawn, read as a rendering bug (the subject is lit as if the
 * animal had stepped aside). The cut is decided once per rendered frame, by
 * the shadow pass, which runs first, or else the main pass. No draw calls, no
 * shader cost.
 *
 * The body is the animal's rest-pose box (`cutBody`, mesh space, carried by
 * the instance matrix: heading, growth): an elephant beside the line is cut
 * by how far its flank or rump reaches, not by a sphere around every pose
 * (5 m across for an elephant, whose centre then never counted as in front).
 * The margin narrows from CUT_LINE_R at the subject to CUT_CAM_R at the
 * camera, as the subject's own size does on screen: a lion lying low in front
 * of the subject that the view passes over (it covers no part of the subject)
 * stays, a body reaching the line near the camera, or around it, goes.
 */
const cutAim = { on: false, subject: new THREE.Vector3(), feet: new THREE.Vector3() };
/** Camera-to-subject distance (m) up to which other animals are cut. */
export const FOLLOW_CUT_MAX_D = 16;
/** The view line aims this high above the subject's feet (m). */
const CUT_AIM_Y = 0.9;
/** Clearance (m) between an animal's body and the view line below which it is cut, at the subject's end and at the camera's; × CUT_OUT to come back. */
const CUT_LINE_R = 0.5;
const CUT_CAM_R = 0.25;
const CUT_OUT = 1.8;
/** An animal is cut only when its body centre stands this far (m, on the ground) in front of the subject; CUT_FRONT_OUT to stay cut. */
const CUT_FRONT = 1.1;
const CUT_FRONT_OUT = 0.9;
/** The view line is searched from this far (m) in front of the subject's aim point (a neighbour touching the subject's side stays). */
const CUT_LINE_FROM = 0.5;
/** Another instance whose feet are this close (m) to the subject's is the subject (never cut). */
const SUBJECT_EPS = 0.05;

/**
 * Aim the follow cut at the followed subject (its feet, world space; null
 * when the camera does not follow an animal or a person). Call every frame
 * before rendering.
 */
export function setCreatureFollowCut(subject: { x: number; y: number; z: number } | null): void {
  cutAim.on = subject !== null;
  if (!subject) return;
  cutAim.feet.set(subject.x, subject.y, subject.z);
  cutAim.subject.set(subject.x, subject.y + CUT_AIM_Y, subject.z);
}

const _inv = new THREE.Matrix4();
const _camL = new THREE.Vector3();
const _aimL = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Distance (mesh units) from `p` to the box `b` (0 inside). */
function boxDistance(b: THREE.Box3, p: THREE.Vector3): number {
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Is a body (rest-pose box `body` in mesh space, placed by `world`, a
 * rotation + uniform scale + translation) in the follow cut seen from `cam`?
 * `was`: it was cut last frame (hysteresis).
 */
export function inFollowCut(cam: THREE.Vector3, world: THREE.Matrix4, body: THREE.Box3, was: boolean): boolean {
  const s = cutAim.subject;
  const e = world.elements;
  // the subject itself is never cut
  if (Math.abs(e[12] - cutAim.feet.x) < SUBJECT_EPS && Math.abs(e[14] - cutAim.feet.z) < SUBJECT_EPS) return false;
  // in front: the body centre's ground distance ahead of the subject, toward the camera
  const hx = cam.x - s.x;
  const hz = cam.z - s.z;
  const hl = Math.hypot(hx, hz);
  if (hl < 1e-3) return false;
  body.getCenter(_c).applyMatrix4(world);
  if (((_c.x - s.x) * hx + (_c.z - s.z) * hz) / hl < (was ? CUT_FRONT_OUT : CUT_FRONT)) return false;
  // clearance between the view line and the box, in the body's own space;
  // box distance minus a linear margin is convex along the line: ternary search
  const scale = Math.hypot(e[0], e[1], e[2]);
  if (scale < 1e-6) return false;
  _inv.copy(world).invert();
  _camL.copy(cam).applyMatrix4(_inv);
  _aimL.copy(s).applyMatrix4(_inv);
  const len = cam.distanceTo(s);
  const out = was ? CUT_OUT : 1;
  const gap = (t: number) => boxDistance(body, _p.lerpVectors(_aimL, _camL, t)) * scale - out * (CUT_LINE_R + (CUT_CAM_R - CUT_LINE_R) * t);
  let lo = Math.min(CUT_LINE_FROM / len, 1);
  let hi = 1;
  for (let k = 0; k < 18; k++) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (gap(a) < gap(b)) hi = b;
    else lo = a;
  }
  return gap((lo + hi) * 0.5) < 0;
}

// three.js internals of BatchedMesh used here (r187)
interface BatchedInternals {
  _indirectTexture: THREE.DataTexture;
  _matricesTexture: THREE.DataTexture;
}

/**
 * Draw-id texture (BatchedMesh's per-pass instance list) that uploads only when
 * three writes a list different from the one on the GPU: three flags the list
 * for upload on every pass, though a still crowd draws the same ids.
 */
export class DrawIdTexture extends THREE.DataTexture {
  /** Ids last flagged for upload (null while three's constructor runs); starts impossible so the first list always uploads. */
  private sent: Uint32Array | null = null;

  constructor(size: number) {
    super(new Uint32Array(size * size), size, size, THREE.RedIntegerFormat, THREE.UnsignedIntType);
    this.sent = new Uint32Array(size * size).fill(0xffffffff);
  }

  override set needsUpdate(value: boolean) {
    if (!value) return;
    const ids = this.image.data as Uint32Array;
    const sent = this.sent;
    if (sent) {
      let i = 0;
      while (i < ids.length && ids[i] === sent[i]) i++;
      if (i === ids.length) return;
      sent.set(ids);
    }
    super.needsUpdate = true;
  }
}

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
  /** Draw-id textures of the main and shadow passes (swapped into three before each pass). */
  private mainIds: DrawIdTexture;
  private shadowIds: DrawIdTexture;
  private boundsCount = 0;
  private boundsRadius = 0;
  /** This frame's instance positions. One box per batch: a box shared by every batch gave each one the union of all creatures (~80 m), so no batch was ever frustum-culled. */
  private readonly bounds = new THREE.Box3();
  /** Live instances (not counting freed ids). */
  live = 0;
  /** Take part in the follow cut (animal batches; see setCreatureFollowCut). */
  followCut = false;
  /** The batch's body for the follow cut: rest-pose box in mesh space (null: half the all-pose sphere). */
  cutBody: THREE.Box3 | null = null;
  /** Instances cut last frame (hysteresis) and ids hidden for the current main pass. */
  private cut = new Uint8Array(16);
  private readonly cutHidden: number[] = [];
  /** renderer.info.render.frame the cut was last decided for (-1: never; see decideFollowCut). */
  private cutFrame = -1;

  constructor(name: string, material: THREE.Material, instances: number, vertices: number, indices: number) {
    super(Math.max(4, instances), Math.max(64, vertices), Math.max(192, indices), material);
    this.name = name;
    // instances move every frame: per-frame bounds are set by beginBounds/endBounds
    this.frustumCulled = true;
    this.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    this.castShadow = true;
    this.receiveShadow = true;
    [this.mainIds, this.shadowIds] = this.makeIdTextures();
  }

  /** Replace three's draw-id texture (after construction / growth) by one change-tracked texture per pass. */
  private makeIdTextures(): [DrawIdTexture, DrawIdTexture] {
    const internal = this as unknown as BatchedInternals;
    const size = internal._indirectTexture.image.width;
    internal._indirectTexture.dispose();
    const main = new DrawIdTexture(size);
    internal._indirectTexture = main;
    return [main, new DrawIdTexture(size)];
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
    this.cut[id] = 0;
    this.shadow[id] = 0;
    this.shadowGeo[id] = -1;
    this.live--;
  }

  protected grow(capacity: number): void {
    // three disposes and re-creates the texture it holds (one of ours)
    this.setInstanceCount(capacity);
    this.mainIds.dispose();
    this.shadowIds.dispose();
    [this.mainIds, this.shadowIds] = this.makeIdTextures();
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
    const c = new Uint8Array(cap);
    c.set(this.cut);
    this.cut = c;
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

  /** Same as BatchedMesh's, but an unchanged matrix does not re-upload the matrix texture (resting animals). */
  override setMatrixAt(id: number, matrix: THREE.Matrix4): this {
    const stored = (this as unknown as BatchedInternals)._matricesTexture.image.data as Float32Array;
    const e = matrix.elements;
    const o = id * 16;
    for (let i = 0; i < 16; i++) if (stored[o + i] !== Math.fround(e[i])) return super.setMatrixAt(id, matrix);
    return this;
  }

  // ---- per-frame bounds (lets three skip the whole batch when nothing is in view)
  beginBounds(): void {
    this.bounds.makeEmpty();
    this.boundsCount = 0;
    this.boundsRadius = 0;
    this.anyShadow = false;
  }
  private anyShadow = false;

  /** Include an instance at world position `p` with radius `r`. */
  includeBounds(p: THREE.Vector3, r: number, shadow: boolean): void {
    this.bounds.expandByPoint(p);
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
    this.bounds.getCenter(s.center);
    s.radius = this.bounds.getSize(_v).length() * 0.5 + this.boundsRadius;
    this.castShadow = this.anyShadow;
  }

  onBeforeRender(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    group: THREE.Group,
  ): void {
    (this as unknown as BatchedInternals)._indirectTexture = this.mainIds;
    if (this.followCut) this.applyFollowCut(camera, renderer.info.render.frame);
    super.onBeforeRender(renderer, scene, camera, geometry, material, group);
  }

  onAfterRender(): void {
    const h = this.cutHidden;
    for (let i = 0; i < h.length; i++) this.setVisibleAt(h[i], true);
    h.length = 0;
  }

  /**
   * Hide (for this pass) the instances in the follow cut; onAfterRender shows
   * them again. `frame`: see decideFollowCut.
   */
  private applyFollowCut(camera: THREE.Camera, frame = -1): void {
    if (!this.decideFollowCut(camera, frame)) return;
    const cut = this.cut;
    const n = Math.min(this.want.length, this.maxInstanceCount);
    for (let i = 0; i < n; i++) {
      if (cut[i] && this.want[i]) {
        this.setVisibleAt(i, false);
        this.cutHidden.push(i);
      }
    }
  }

  /**
   * Decide which instances the follow cut takes, seen from `camera` (the main
   * camera, in the shadow pass too), into `cut`. Once per rendered frame
   * (`frame`, renderer.info.render.frame, the same for a render's shadow and
   * main pass; -1 decides anew): the shadow pass runs first and decides it,
   * the main pass reuses it, so an animal and its shadow go together. False
   * when nothing is cut (not following, or too far from the subject).
   */
  private decideFollowCut(camera: THREE.Camera, frame: number): boolean {
    const cut = this.cut;
    const n = Math.min(this.want.length, this.maxInstanceCount);
    _cam.setFromMatrixPosition(camera.matrixWorld);
    if (!cutAim.on || _cam.distanceTo(cutAim.subject) > FOLLOW_CUT_MAX_D) {
      cut.fill(0);
      this.cutFrame = -1;
      return false;
    }
    if (frame >= 0 && frame === this.cutFrame) return true;
    this.cutFrame = frame;
    for (let i = 0; i < n; i++) {
      if (!this.want[i]) {
        cut[i] = 0;
        continue;
      }
      let body = this.cutBody;
      if (!body) {
        // no rest-pose box: half the all-pose sphere
        const sphere = this.getBoundingSphereAt(this.getGeometryIdAt(i), _sphere);
        if (!sphere) {
          cut[i] = 0;
          continue;
        }
        body = _box.setFromCenterAndSize(sphere.center, _v.setScalar(sphere.radius));
      }
      cut[i] = inFollowCut(_cam, this.getMatrixAt(i, _m).premultiply(this.matrixWorld), body, cut[i] === 1) ? 1 : 0;
    }
    return true;
  }

  // ---- shadow pass: hide instances that do not cast shadows, and those the follow cut takes
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
    // (`camera` is the main camera: the cut is decided as the main pass will see it)
    const cutting = this.followCut && this.decideFollowCut(camera, renderer.info.render.frame);
    const cut = this.cut;
    const n = Math.min(this.want.length, this.maxInstanceCount);
    for (let i = 0; i < n; i++) {
      if (!this.want[i]) continue;
      if (!this.shadow[i] || (cutting && cut[i] === 1)) {
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
    (this as unknown as BatchedInternals)._indirectTexture = this.shadowIds;
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
    const data = (this as unknown as BatchedInternals)._indirectTexture.image.data as Uint32Array;
    out.length = 0;
    for (let i = 0; i < this.lastDrawCount; i++) out.push(data[i]);
    return out;
  }

  dispose(): void {
    // three disposes the texture it holds; the other pass's is ours to free
    (this.mainIds === (this as unknown as BatchedInternals)._indirectTexture ? this.shadowIds : this.mainIds).dispose();
    super.dispose();
  }
}

export const DATA_WIDTH = 2048;
/** Queued update spans beyond which the next upload is whole (three merges spans per row, then sends one call each). */
const MAX_QUEUED_SPANS = 64;

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
  /** Texel span [lo, hi) written per texture row since the last flush. */
  private dirtyLo = new Int32Array(0);
  private dirtyHi = new Int32Array(0);
  private anyDirty = false;
  /**
   * The next upload must be whole (a new texture: update ranges would leave the
   * rest of it undefined). Stays set until the renderer has uploaded it.
   */
  private uploadWhole = true;
  /**
   * Flushed spans the renderer has not uploaded yet. three uploads a data
   * texture only when it draws a program that samples it, so while the batch is
   * culled (off screen, or no instance visible) the spans of every flush must
   * stay queued; dropping them left stale look texels on the GPU (a penguin
   * drawn with growth 0 wore the grey chick down).
   */
  private queued = false;

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
    tex.onUpdate = () => this.uploaded(tex);
    this.uploadWhole = true;
    this.queued = true;
    this.dirtyLo = new Int32Array(h).fill(w);
    this.dirtyHi = new Int32Array(h);
    this.anyDirty = false;
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
    this.markTexels(id * this.stride, (id + 1) * this.stride);
  }

  /** Flag texels [from, to) for the next flush. */
  private markTexels(from: number, to: number): void {
    const w = this.texture.image.width;
    while (from < to) {
      const row = Math.floor(from / w);
      const x0 = from - row * w;
      const x1 = Math.min(to - row * w, w);
      if (x0 < this.dirtyLo[row]) this.dirtyLo[row] = x0;
      if (x1 > this.dirtyHi[row]) this.dirtyHi[row] = x1;
      from = row * w + x1;
    }
    this.anyDirty = true;
  }

  /**
   * Float offset of an instance's look texels in `data`. Callers write them
   * right after, so they are flagged for the next upload.
   */
  offset(id: number): number {
    const t = id * this.stride;
    this.markTexels(t, t + this.look);
    return t * 4;
  }

  /**
   * Float offset of an instance's first bone row. Callers write the pose right
   * after, so the bone rows are flagged for the next upload (a creature that
   * was not re-posed this frame uploads nothing).
   */
  boneOffset(id: number): number {
    const t = id * this.stride + this.look;
    this.markTexels(t, t + this.bones * 3);
    return t * 4;
  }

  /** Upload the texels written since the last flush (call once per frame after writing). */
  flush(): void {
    if (!this.anyDirty) return;
    const tex = this.texture;
    const w = tex.image.width;
    if (!this.queued) tex.clearUpdateRanges();
    if (!this.uploadWhole) {
      let dirty = 0;
      for (let r = 0; r < this.dirtyLo.length; r++) {
        const n = this.dirtyHi[r] - this.dirtyLo[r];
        if (n <= 0) continue;
        tex.addUpdateRange((r * w + this.dirtyLo[r]) * 4, n * 4);
        dirty += n;
      }
      // mostly rewritten (a crowd of walkers), or spans piled up over the frames
      // the batch was culled: one whole upload beats a call per span
      const rewritten = this.dirtyLo.length > 1 && dirty * 4 >= this.maxUsed * this.stride * 3;
      if (rewritten || tex.updateRanges.length > MAX_QUEUED_SPANS) this.uploadWhole = true;
    }
    if (this.uploadWhole) tex.clearUpdateRanges();
    tex.needsUpdate = true;
    this.queued = true;
    this.anyDirty = false;
    this.dirtyLo.fill(w);
    this.dirtyHi.fill(0);
  }

  /** The renderer uploaded `tex` (three calls Texture.onUpdate after each upload). */
  private uploaded(tex: THREE.DataTexture): void {
    if (tex !== this.texture) return;
    this.queued = false;
    this.uploadWhole = false;
  }

  dispose(): void {
    this.texture.dispose();
    for (const u of this.uniforms) u.crData.value = null;
    super.dispose();
  }
}
