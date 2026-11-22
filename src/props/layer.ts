// The props layer: renders every placed object, fences, litter, night lights
// and the selection highlight.
//
// Placed objects are drawn through one of two batching back-ends, chosen once:
//  - 'batched' (default when WEBGL_multi_draw exists): one BatchedMesh per
//    material — every geometry / variant / def sharing a material is a single
//    multi-draw call with per-instance frustum culling. Scales with the number
//    of materials instead of meshes × variants.
//  - 'instanced' (fallback): one InstancedMesh per template mesh (geometry +
//    material), packed with swap-remove, grown by doubling.

import * as THREE from 'three';
import { TILE } from '../core/constants';
import type { IPropsLayer, QualitySettings } from '../core/contracts';
import type { EventBus, TileRect } from '../core/events';
import { hashFloat } from '../core/rng';
import type { Litter, ObjectDef, PlacedObject } from '../core/types';
import type { World } from '../core/world';
import { OBJECTS_BY_ID, rotatedSize } from '../data/objects';
import { createFenceSegment, disposeFenceStyles, FenceRenderer } from './fences';
import { Highlighter } from './highlight';
import { LitterRenderer } from './litter';
import { concreteMaterial, disposePropMaterials, projectBoxUVs, surfaceTextures } from './materials';
import { PROP_SPECS, type PropSpec } from './registry';
import { applyWind, cloneWithHooks, disposeWind, hasSway, setupWindMesh, updateWind } from './wind';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const LIGHT_COLOR = 0xffc68a;
/** Candela of a pooled lamp light at full night. */
const LIGHT_INTENSITY = 3.2;
const LIGHT_RANGE = 16;
const DEFAULT_GLOW = new THREE.Color(0xffd9a0);

// ---------------------------------------------------------------------------
// Templates

interface TemplatePart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Mesh transform relative to the object origin. */
  local: THREE.Matrix4;
  cast: boolean;
  batch: PropBatch | null;
}

interface Template {
  defId: string;
  variant: number;
  spec: PropSpec;
  root: THREE.Object3D;
  parts: TemplatePart[];
  radius: number;
  height: number;
  small: boolean;
  /** Local-space position of the light source (lamps / lit windows), if any. */
  lightAnchor: THREE.Vector3 | null;
}

interface Slot {
  batch: PropBatch;
  index: number;
}

interface ObjRec {
  obj: PlacedObject;
  tpl: Template;
  matrix: THREE.Matrix4;
  slots: Slot[];
  unique: THREE.Object3D | null;
  light: THREE.Vector3 | null;
}

interface SlotRef {
  rec: ObjRec;
  part: number;
}

// ---------------------------------------------------------------------------
// Batching back-ends

export type PropsBackend = 'auto' | 'instanced' | 'batched';

/** Common surface of the two batching back-ends. */
interface PropBatch {
  readonly mesh: THREE.Mesh;
  dirty: boolean;
  readonly cullDist: number;
  /** Add an instance of `geometry`; returns its slot handle. */
  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, ref: SlotRef): number;
  set(slot: number, matrix: THREE.Matrix4): void;
  remove(slot: number): void;
  clear(): void;
  /** Push pending changes / distance culling to the GPU. */
  sync(cam: THREE.Vector3 | null): void;
  needsCull(cam: THREE.Vector3): boolean;
  /** Instances currently drawn. */
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

/** BatchedMesh back-end: every geometry using one material in a single multi-draw. */
class MultiBatch implements PropBatch {
  readonly mesh: THREE.BatchedMesh;
  dirty = false;
  private geoIds = new Map<THREE.BufferGeometry, number>();
  private maxV = 4096;
  private maxI = 8192;
  private usedV = 0;
  private usedI = 0;
  private maxInst = 16;
  private live = 0;
  /** Object id per instance id (-1 = free). */
  private owners: number[] = [];
  /** Instance positions (xyz per instance id) for distance culling. */
  private pos: number[] = [];
  private lastCull = new THREE.Vector3(1e9, 0, 0);

  constructor(
    material: THREE.Material,
    private readonly cast: boolean,
    private readonly receive: boolean,
    readonly cullDist: number,
    private readonly parent: THREE.Object3D,
  ) {
    const m = new THREE.BatchedMesh(this.maxInst, this.maxV, this.maxI, material);
    m.sortObjects = false; // saves CPU; opaque overdraw is small for props
    m.perObjectFrustumCulled = true;
    m.frustumCulled = false; // per-instance culling replaces the whole-mesh test
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.name = 'prop-multibatch';
    setupWindMesh(m);
    this.mesh = m;
    parent.add(m);
  }

  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, ref: SlotRef): number {
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
    }
    if (this.live >= this.maxInst) {
      this.maxInst *= 2;
      mesh.setInstanceCount(this.maxInst);
    }
    const id = mesh.addInstance(gid);
    mesh.setMatrixAt(id, matrix);
    this.live++;
    this.owners[id] = ref.rec.obj.id;
    const e = matrix.elements;
    this.pos[id * 3] = e[12];
    this.pos[id * 3 + 1] = e[13];
    this.pos[id * 3 + 2] = e[14];
    if (this.cullDist !== Infinity) this.dirty = true;
    return id;
  }

  set(id: number, matrix: THREE.Matrix4): void {
    this.mesh.setMatrixAt(id, matrix);
    const e = matrix.elements;
    this.pos[id * 3] = e[12];
    this.pos[id * 3 + 1] = e[13];
    this.pos[id * 3 + 2] = e[14];
    if (this.cullDist !== Infinity) this.dirty = true;
  }

  remove(id: number): void {
    if (this.owners[id] === undefined || this.owners[id] < 0) return;
    this.mesh.deleteInstance(id);
    this.owners[id] = -1;
    this.live--;
  }

  clear(): void {
    for (let id = 0; id < this.owners.length; id++) if (this.owners[id] >= 0) this.remove(id);
  }

  sync(cam: THREE.Vector3 | null): void {
    this.dirty = false;
    if (this.cullDist === Infinity || !cam) return;
    const d2 = this.cullDist * this.cullDist;
    const p = this.pos;
    for (let id = 0; id < this.owners.length; id++) {
      if (this.owners[id] < 0) continue;
      const dx = p[id * 3] - cam.x;
      const dy = p[id * 3 + 1] - cam.y;
      const dz = p[id * 3 + 2] - cam.z;
      const vis = dx * dx + dy * dy + dz * dz <= d2;
      if (this.mesh.getVisibleAt(id) !== vis) this.mesh.setVisibleAt(id, vis);
    }
    this.lastCull.copy(cam);
  }

  needsCull(cam: THREE.Vector3): boolean {
    return this.cullDist !== Infinity && this.live > 0 && this.lastCull.distanceToSquared(cam) > 9;
  }

  drawn(): number {
    return this.live;
  }

  ownerOf(hit: THREE.Intersection): number | null {
    const id = hit.batchId;
    if (id === undefined) return null;
    const o = this.owners[id];
    return o !== undefined && o >= 0 ? o : null;
  }

  setShadows(on: boolean): void {
    this.mesh.castShadow = on && this.cast;
    this.mesh.receiveShadow = on && this.receive;
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
  }
}

/** InstancedMesh back-end: one geometry + material, swap-remove packed storage. */
class Batch implements PropBatch {
  mesh: THREE.InstancedMesh;
  private cap = 0;
  n = 0;
  /** Master matrices (all live instances, packed). */
  private mats: Float32Array;
  private refs: SlotRef[] = [];
  /** Object id per drawn instance (after culling). */
  visOwners: Int32Array;
  dirty = true;
  private lastCull = new THREE.Vector3(1e9, 0, 0);

  constructor(
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material | THREE.Material[],
    private readonly cast: boolean,
    private readonly receive: boolean,
    readonly cullDist: number,
    private readonly parent: THREE.Object3D,
  ) {
    this.mats = new Float32Array(0);
    this.visOwners = new Int32Array(0);
    this.mesh = this.create(8);
  }

  private create(cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.geometry, this.material, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.visible = false;
    m.castShadow = this.cast;
    m.receiveShadow = this.receive;
    m.name = 'prop-batch';
    setupWindMesh(m);
    const mats = new Float32Array(cap * 16);
    mats.set(this.mats.subarray(0, this.n * 16));
    this.mats = mats;
    const vo = new Int32Array(cap);
    vo.set(this.visOwners.subarray(0, Math.min(this.visOwners.length, cap)));
    this.visOwners = vo;
    this.cap = cap;
    this.parent.add(m);
    return m;
  }

  add(_geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, ref: SlotRef): number {
    if (this.n >= this.cap) {
      const old = this.mesh;
      this.mesh = this.create(this.cap * 2);
      this.parent.remove(old);
      old.dispose();
    }
    const i = this.n++;
    matrix.toArray(this.mats, i * 16);
    this.refs[i] = ref;
    this.dirty = true;
    return i;
  }

  set(i: number, matrix: THREE.Matrix4): void {
    matrix.toArray(this.mats, i * 16);
    this.dirty = true;
  }

  remove(i: number): void {
    const last = --this.n;
    if (i !== last) {
      this.mats.copyWithin(i * 16, last * 16, last * 16 + 16);
      const moved = this.refs[last];
      this.refs[i] = moved;
      moved.rec.slots[moved.part].index = i;
    }
    this.refs.length = last;
    this.dirty = true;
  }

  clear(): void {
    this.n = 0;
    this.refs.length = 0;
    this.dirty = true;
  }

  /** Copy (and cull) master data into the GPU instance buffer. */
  sync(cam: THREE.Vector3 | null): void {
    const mesh = this.mesh;
    const dst = mesh.instanceMatrix.array as Float32Array;
    const src = this.mats;
    let count = 0;
    if (this.cullDist === Infinity || !cam) {
      count = this.n;
      dst.set(src.subarray(0, count * 16));
      for (let i = 0; i < count; i++) this.visOwners[i] = this.refs[i].rec.obj.id;
    } else {
      const d2 = this.cullDist * this.cullDist;
      for (let i = 0; i < this.n; i++) {
        const o = i * 16;
        const dx = src[o + 12] - cam.x;
        const dy = src[o + 13] - cam.y;
        const dz = src[o + 14] - cam.z;
        if (dx * dx + dy * dy + dz * dz > d2) continue;
        dst.set(src.subarray(o, o + 16), count * 16);
        this.visOwners[count] = this.refs[i].rec.obj.id;
        count++;
      }
      if (cam) this.lastCull.copy(cam);
    }
    mesh.count = count;
    mesh.visible = count > 0;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, Math.max(count, 1) * 16);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.boundingSphere = null;
    mesh.boundingBox = null;
    if (count > 0) mesh.computeBoundingSphere();
    this.dirty = false;
  }

  needsCull(cam: THREE.Vector3): boolean {
    return this.cullDist !== Infinity && this.n > 0 && this.lastCull.distanceToSquared(cam) > 9;
  }

  drawn(): number {
    return this.mesh.count;
  }

  ownerOf(hit: THREE.Intersection): number | null {
    const i = hit.instanceId;
    return i !== undefined && i < this.mesh.count ? this.visOwners[i] : null;
  }

  setShadows(on: boolean): void {
    this.mesh.castShadow = on && this.cast;
    this.mesh.receiveShadow = on && this.receive;
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
  }
}

/** Split a multi-material mesh into one geometry per material group. */
function splitByMaterial(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]): { geometry: THREE.BufferGeometry; material: THREE.Material }[] {
  if (!Array.isArray(material)) return [{ geometry, material }];
  if (geometry.groups.length === 0) return material.length ? [{ geometry, material: material[0] }] : [];
  const out: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
  for (const g of geometry.groups) {
    const m = material[g.materialIndex ?? 0];
    if (!m) continue;
    const sub = new THREE.BufferGeometry();
    if (geometry.index) {
      for (const name of Object.keys(geometry.attributes)) sub.setAttribute(name, geometry.getAttribute(name));
      const src = geometry.index.array;
      const end = Math.min(g.start + g.count, src.length);
      sub.setIndex(new THREE.BufferAttribute(src.slice(g.start, end), 1));
    } else {
      for (const name of Object.keys(geometry.attributes)) {
        const a = geometry.getAttribute(name) as THREE.BufferAttribute;
        const arr = a.array.slice(g.start * a.itemSize, (g.start + g.count) * a.itemSize);
        sub.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
      }
    }
    out.push({ geometry: sub, material: m });
  }
  return out;
}

/** Attribute layout key: BatchedMesh needs identical layouts per batch. */
function layoutKey(g: THREE.BufferGeometry): string {
  const parts: string[] = [];
  for (const name of Object.keys(g.attributes).sort()) {
    const a = g.getAttribute(name) as THREE.BufferAttribute;
    parts.push(`${name}:${a.itemSize}:${a.normalized ? 1 : 0}:${a.array.constructor.name}`);
  }
  if (g.index) parts.push('idx');
  return parts.join(',');
}

// ---------------------------------------------------------------------------
// Placeholder for defs without a registered builder

const placeholderGeo = new Map<string, THREE.BufferGeometry>();

function placeholderSpec(def: ObjectDef | undefined): PropSpec {
  const w = (def?.size[0] ?? 1) * TILE;
  const d = (def?.size[1] ?? 1) * TILE;
  const cat = def?.category;
  const h = cat === 'tree' ? 4 : cat === 'shop' || cat === 'facility' || cat === 'shelter' ? 2.6 : cat === 'plant' || cat === 'rock' ? 0.8 : 1;
  return {
    variants: 1,
    build: () => {
      const key = `${w}x${h}x${d}`;
      let g = placeholderGeo.get(key);
      if (!g) {
        g = new THREE.BoxGeometry(w * 0.8, h, d * 0.8);
        g.translate(0, h / 2, 0);
        projectBoxUVs(g, surfaceTextures('concrete').tile);
        placeholderGeo.set(key, g);
      }
      const m = new THREE.Mesh(g, concreteMaterial());
      const grp = new THREE.Group();
      grp.add(m);
      return grp;
    },
  };
}

// ---------------------------------------------------------------------------
// Point-light pool for lamps near the camera

interface LightSlot {
  light: THREE.PointLight;
  anchor: ObjRec | null;
  /** Fade level 0..1. */
  level: number;
  /** The anchor is among the nearest wanted lamps. */
  want: boolean;
}

// ---------------------------------------------------------------------------

export class PropsLayer implements IPropsLayer {
  readonly root = new THREE.Group();
  private readonly objRoot = new THREE.Group();
  private readonly uniqueRoot = new THREE.Group();
  private readonly fences: FenceRenderer;
  private readonly litter: LitterRenderer;
  private readonly highlight: Highlighter;

  private templates = new Map<string, Template>();
  private placeholders = new Map<string, PropSpec>();
  private sizeClass = new Map<string, { small: boolean; large: boolean }>();
  private batches = new Map<string, PropBatch>();
  private batchList: PropBatch[] = [];
  /** Geometries created by splitting multi-material meshes (owned). */
  private splitGeos: THREE.BufferGeometry[] = [];
  readonly backend: 'instanced' | 'batched';
  private recs = new Map<number, ObjRec>();
  private uniques: ObjRec[] = [];
  private lightRecs: ObjRec[] = [];
  private nightMats: THREE.MeshStandardMaterial[] = [];
  private nightSet = new Set<THREE.Material>();
  private lights: LightSlot[] = [];
  private unsub: (() => void)[] = [];
  private highlightId: number | null = null;
  private time = 0;
  private night = -1;
  private lightTimer = 0;
  private disposed = false;

  // scratch
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private hits: THREE.Intersection[] = [];
  private nearest: ObjRec[] = [];
  private nearestD: number[] = [];

  constructor(
    private readonly world: World,
    events: EventBus,
    scene: THREE.Scene,
    private readonly quality: QualitySettings,
    opts: { backend?: PropsBackend } = {},
  ) {
    const want = opts.backend ?? 'auto';
    this.backend = want === 'auto' ? (supportsMultiDraw() ? 'batched' : 'instanced') : want;
    this.root.name = 'props';
    this.objRoot.name = 'objects';
    this.uniqueRoot.name = 'unique-objects';
    this.fences = new FenceRenderer(world, events, quality);
    this.litter = new LitterRenderer(world);
    this.highlight = new Highlighter(world);
    this.root.add(this.objRoot, this.uniqueRoot, this.fences.group, this.litter.group, this.highlight.group);
    scene.add(this.root);

    const nLights = quality.level === 'high' ? 4 : quality.level === 'medium' ? 2 : 0;
    for (let i = 0; i < nLights; i++) {
      const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_RANGE, 2);
      light.castShadow = false;
      light.name = `props-lamp-light-${i}`;
      this.root.add(light);
      this.lights.push({ light, anchor: null, level: 0, want: false });
    }

    this.unsub.push(
      events.on('objectAdded', ({ id }) => {
        const o = world.objects.get(id);
        if (o) this.addObject(o);
      }),
      events.on('objectRemoved', ({ id }) => this.removeObject(id)),
      events.on('worldReset', () => this.rebuildAll()),
      events.on('terrainChanged', (r) => this.refreshRect(r)),
    );
    this.rebuildAll();
  }

  // ------------------------------------------------------------ templates

  private specFor(defId: string): PropSpec {
    const s = PROP_SPECS[defId];
    if (s) return s;
    let p = this.placeholders.get(defId);
    if (!p) {
      p = placeholderSpec(OBJECTS_BY_ID[defId]);
      this.placeholders.set(defId, p);
    }
    return p;
  }

  private variantOf(spec: PropSpec, seed: number): number {
    const v = Math.max(1, spec.variants | 0);
    return ((seed % v) + v) % v;
  }

  private buildVariant(defId: string, spec: PropSpec, variant: number): THREE.Object3D {
    try {
      const o = spec.build(variant);
      if (o) return o;
    } catch (err) {
      console.error(`[props] builder for "${defId}" failed`, err);
    }
    return placeholderSpec(OBJECTS_BY_ID[defId]).build(0);
  }

  private template(defId: string, variant: number): Template {
    const key = `${defId}#${variant}`;
    let t = this.templates.get(key);
    if (t) return t;
    const spec = this.specFor(defId);
    const root = this.buildVariant(defId, spec, variant);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
    const height = box.isEmpty() ? 1 : box.max.y;
    const radius = Math.max(size.x, size.z) * 0.5;
    // size class is decided once per def (first variant built) so all variants share batches
    let cls = this.sizeClass.get(defId);
    if (!cls) {
      cls = { small: height < 1.25 && radius < 1.05, large: height > 0.7 || radius > 1.0 };
      this.sizeClass.set(defId, cls);
    }
    const { small, large } = cls;
    const parts: TemplatePart[] = [];
    const glowBox = new THREE.Box3();
    const tmpBox = new THREE.Box3();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible || (mesh as THREE.InstancedMesh).isInstancedMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      let transparent = false;
      for (const m of mats) {
        this.registerMaterial(m);
        if (m.transparent && m.opacity < 0.6) transparent = true;
        if (typeof m.userData.nightEmissive === 'number') {
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          tmpBox.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
          glowBox.union(tmpBox);
        }
      }
      for (const sp of splitByMaterial(mesh.geometry, mesh.material)) {
        if (sp.geometry !== mesh.geometry) this.splitGeos.push(sp.geometry);
        parts.push({
          geometry: sp.geometry,
          material: sp.material,
          local: mesh.matrixWorld.clone(),
          cast: large && !mesh.userData.noShadow && !(sp.material.transparent && sp.material.opacity < 0.6) && !transparent,
          batch: null,
        });
      }
    });
    let lightAnchor: THREE.Vector3 | null = null;
    if (!glowBox.isEmpty()) lightAnchor = glowBox.getCenter(new THREE.Vector3());
    else if (OBJECTS_BY_ID[defId]?.light) lightAnchor = new THREE.Vector3(0, Math.max(0.5, height - 0.4), 0);
    t = { defId, variant, spec, root, parts, radius, height, small, lightAnchor };
    this.templates.set(key, t);
    return t;
  }

  private registerMaterial(m: THREE.Material): void {
    if (hasSway(m)) applyWind(m);
    const ne = m.userData.nightEmissive;
    if (typeof ne === 'number' && !this.nightSet.has(m) && (m as THREE.MeshStandardMaterial).emissive) {
      const sm = m as THREE.MeshStandardMaterial;
      if (sm.emissive.r + sm.emissive.g + sm.emissive.b === 0) sm.emissive.copy(DEFAULT_GLOW);
      sm.emissiveIntensity = Math.max(this.night, 0) * ne;
      this.nightSet.add(m);
      this.nightMats.push(sm);
    }
  }

  private batchFor(tpl: Template, part: TemplatePart): PropBatch {
    if (part.batch) return part.batch;
    const cast = part.cast && this.quality.shadows;
    const cull = tpl.small ? Math.max(this.quality.detailDistance * 2.2, 55) : Infinity;
    const multi = this.backend === 'batched';
    const key = multi
      ? `B|${part.material.uuid}|${layoutKey(part.geometry)}|${cast ? 1 : 0}|${cull}`
      : `I|${part.geometry.uuid}|${part.material.uuid}|${cast ? 1 : 0}|${cull}`;
    let b = this.batches.get(key);
    if (!b) {
      b = multi
        ? new MultiBatch(part.material, cast, this.quality.shadows, cull, this.objRoot)
        : new Batch(part.geometry, part.material, cast, this.quality.shadows, cull, this.objRoot);
      this.batches.set(key, b);
      this.batchList.push(b);
    }
    part.batch = b;
    return b;
  }

  // ------------------------------------------------------------ objects

  private computeMatrix(o: PlacedObject, spec: PropSpec, out: THREE.Matrix4): void {
    const c = this.world.objectCenter(o);
    let yaw = (o.rot * Math.PI) / 2;
    let s = 1;
    const j = spec.jitter;
    if (j) {
      if (j.yaw) yaw += hashFloat(o.seed, 3, 17) * Math.PI * 2;
      s = j.scale[0] + (j.scale[1] - j.scale[0]) * hashFloat(o.seed, 5, 29);
    }
    this.tmpQ.setFromAxisAngle(Y_AXIS, yaw);
    this.tmpP.set(c.x, c.y, c.z);
    this.tmpS.set(s, s, s);
    out.compose(this.tmpP, this.tmpQ, this.tmpS);
  }

  private addObject(o: PlacedObject): void {
    if (this.recs.has(o.id)) this.removeObject(o.id);
    if (!OBJECTS_BY_ID[o.defId]) {
      console.warn(`[props] unknown object def "${o.defId}"`);
      return;
    }
    const spec = this.specFor(o.defId);
    const tpl = this.template(o.defId, this.variantOf(spec, o.seed));
    const rec: ObjRec = { obj: o, tpl, matrix: new THREE.Matrix4(), slots: [], unique: null, light: null };
    this.computeMatrix(o, spec, rec.matrix);
    if (spec.unique) {
      // holder carries the placement; the clone keeps the builder's own root transform
      const holder = new THREE.Group();
      holder.name = `unique-${o.defId}-${o.id}`;
      holder.add(this.cloneUnique(tpl));
      rec.matrix.decompose(holder.position, holder.quaternion, holder.scale);
      holder.userData.objectId = o.id;
      this.uniqueRoot.add(holder);
      rec.unique = holder;
      this.uniques.push(rec);
    } else {
      tpl.parts.forEach((p, i) => {
        const b = this.batchFor(tpl, p);
        this.tmpM.multiplyMatrices(rec.matrix, p.local);
        rec.slots.push({ batch: b, index: b.add(p.geometry, this.tmpM, { rec, part: i }) });
      });
    }
    if (tpl.lightAnchor) {
      rec.light = tpl.lightAnchor.clone().applyMatrix4(rec.matrix);
      this.lightRecs.push(rec);
    }
    this.recs.set(o.id, rec);
    if (this.highlightId === o.id) this.showHighlight(rec);
  }

  private cloneUnique(tpl: Template): THREE.Object3D {
    const u = tpl.root.clone(true);
    const cast = this.quality.shadows;
    const large = this.sizeClass.get(tpl.defId)?.large ?? true;
    u.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const transparent = mats.some((m) => m.transparent && m.opacity < 0.6);
      mesh.castShadow = cast && large && !mesh.userData.noShadow && !transparent;
      mesh.receiveShadow = cast;
      setupWindMesh(mesh);
      for (const m of mats) this.registerMaterial(m);
    });
    return u;
  }

  private removeObject(id: number): void {
    const rec = this.recs.get(id);
    if (!rec) return;
    // remove slots from the highest index down per batch is not required: swap-remove updates refs
    for (const s of rec.slots) s.batch.remove(s.index);
    rec.slots.length = 0;
    if (rec.unique) {
      this.uniqueRoot.remove(rec.unique);
      const i = this.uniques.indexOf(rec);
      if (i >= 0) this.uniques.splice(i, 1);
    }
    if (rec.light) {
      const i = this.lightRecs.indexOf(rec);
      if (i >= 0) this.lightRecs.splice(i, 1);
      for (const l of this.lights)
        if (l.anchor === rec) {
          l.anchor = null;
          l.want = false;
        }
    }
    this.recs.delete(id);
    if (this.highlightId === id) this.highlight.clear();
  }

  private rebuildAll(): void {
    for (const b of this.batchList) b.clear();
    for (const r of this.uniques) if (r.unique) this.uniqueRoot.remove(r.unique);
    this.uniques.length = 0;
    this.lightRecs.length = 0;
    for (const l of this.lights) {
      l.anchor = null;
      l.want = false;
    }
    this.recs.clear();
    this.highlight.clear();
    for (const o of this.world.objects.values()) this.addObject(o);
    if (this.highlightId !== null && !this.recs.has(this.highlightId)) this.highlightId = null;
  }

  /** Terrain heights changed: re-seat objects whose footprint touches the rect. */
  private refreshRect(r: TileRect): void {
    for (const rec of this.recs.values()) {
      const o = rec.obj;
      const def = OBJECTS_BY_ID[o.defId];
      const [w, d] = rotatedSize(def, o.rot);
      if (o.tx > r.x1 + 1 || o.tz > r.z1 + 1 || o.tx + w < r.x0 - 1 || o.tz + d < r.z0 - 1) continue;
      this.computeMatrix(o, rec.tpl.spec, rec.matrix);
      if (rec.unique) rec.matrix.decompose(rec.unique.position, rec.unique.quaternion, rec.unique.scale);
      rec.slots.forEach((s, i) => {
        this.tmpM.multiplyMatrices(rec.matrix, rec.tpl.parts[i].local);
        s.batch.set(s.index, this.tmpM);
      });
      if (rec.light && rec.tpl.lightAnchor) rec.light.copy(rec.tpl.lightAnchor).applyMatrix4(rec.matrix);
    }
  }

  // ------------------------------------------------------------ per frame

  update(dt: number, nightFactor: number, camera: THREE.Camera): void {
    if (this.disposed) return;
    this.time += dt;
    updateWind(dt);
    this.fences.update();

    camera.updateMatrixWorld();
    const cam = this.camPos.setFromMatrixPosition(camera.matrixWorld);
    for (const b of this.batchList) if (b.dirty || b.needsCull(cam)) b.sync(cam);

    // lamps / windows
    if (Math.abs(nightFactor - this.night) > 0.001) {
      this.night = nightFactor;
      for (const m of this.nightMats) m.emissiveIntensity = nightFactor * (m.userData.nightEmissive as number);
    }

    // unique props
    for (const r of this.uniques) r.tpl.spec.animate?.(r.unique!.children[0], this.time, nightFactor);

    this.updateLights(dt, nightFactor, camera);
    this.highlight.update(dt, this.time);
  }

  private updateLights(dt: number, night: number, camera: THREE.Camera): void {
    if (this.lights.length === 0) return;
    this.lightTimer -= dt;
    if (this.lightTimer <= 0 && night > 0.02) {
      this.lightTimer = 0.4;
      // ground point the camera looks at
      camera.getWorldDirection(this.camDir);
      const f = this.focus.copy(this.camPos);
      if (this.camDir.y < -0.05) {
        const t = Math.min((this.camPos.y - 0) / -this.camDir.y, 150);
        f.addScaledVector(this.camDir, t);
      }
      // N nearest light anchors (insertion into a tiny sorted list)
      const N = this.lights.length;
      const near = this.nearest;
      const nd = this.nearestD;
      near.length = 0;
      nd.length = 0;
      for (const r of this.lightRecs) {
        const p = r.light!;
        const d = (p.x - f.x) * (p.x - f.x) + (p.z - f.z) * (p.z - f.z);
        if (d > 60 * 60) continue;
        if (near.length === N && d >= nd[N - 1]) continue;
        let k = near.length < N ? near.length : N - 1;
        while (k > 0 && nd[k - 1] > d) {
          near[k] = near[k - 1];
          nd[k] = nd[k - 1];
          k--;
        }
        near[k] = r;
        nd[k] = d;
      }
      // slots keep wanted anchors; wanted anchors without a slot take a free (dark) one
      for (const sl of this.lights) sl.want = sl.anchor !== null && near.indexOf(sl.anchor) >= 0;
      for (const r of near) {
        let held = false;
        for (const sl of this.lights) if (sl.anchor === r) held = true;
        if (held) continue;
        let free: LightSlot | null = null;
        for (const sl of this.lights) if (!sl.want && sl.level <= 0.01) free = sl;
        if (!free) continue;
        free.anchor = r;
        free.level = 0;
        free.want = true;
        free.light.position.copy(r.light!);
      }
    }
    for (const sl of this.lights) {
      const target = sl.want && night > 0.02 ? 1 : 0;
      sl.level += Math.sign(target - sl.level) * Math.min(Math.abs(target - sl.level), dt * 2.5);
      if (sl.level <= 0.001 && !sl.want) sl.anchor = null;
      sl.light.intensity = LIGHT_INTENSITY * night * sl.level;
    }
  }

  // ------------------------------------------------------------ models for UI

  createObjectModel(defId: string, seed: number): THREE.Object3D {
    const spec = this.specFor(defId);
    const tpl = this.template(defId, this.variantOf(spec, seed));
    const out = tpl.root.clone(true);
    const cloned = new Map<THREE.Material, THREE.Material>();
    const cloneMat = (m: THREE.Material): THREE.Material => {
      let c = cloned.get(m);
      if (!c) {
        c = cloneWithHooks(m);
        cloned.set(m, c);
      }
      return c;
    };
    out.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneMat) : cloneMat(mesh.material);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      setupWindMesh(mesh);
    });
    out.position.set(0, 0, 0);
    out.rotation.set(0, 0, 0);
    out.scale.set(1, 1, 1);
    out.userData.defId = defId;
    /** Materials owned by this clone (dispose them when the model is discarded; geometry is shared). */
    out.userData.ownedMaterials = Array.from(cloned.values());
    return out;
  }

  createFenceSegmentModel(fenceId: number): THREE.Object3D {
    const g = createFenceSegment(fenceId);
    const owned: THREE.Material[] = [];
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !Array.isArray(mesh.material)) owned.push(mesh.material);
    });
    g.userData.ownedMaterials = owned;
    return g;
  }

  setLitter(items: Iterable<Litter>): void {
    this.litter.set(items);
  }

  // ------------------------------------------------------------ picking / selection

  pickObject(raycaster: THREE.Raycaster): number | null {
    for (const b of this.batchList) if (b.dirty) b.sync(this.camPos.lengthSq() > 0 ? this.camPos : null);
    let best = Infinity;
    let bestId: number | null = null;
    const hits = this.hits;
    for (const b of this.batchList) {
      if (b.drawn() === 0) continue;
      hits.length = 0;
      b.mesh.raycast(raycaster, hits);
      for (const h of hits) {
        if (h.distance >= best) continue;
        const id = b.ownerOf(h);
        if (id === null) continue;
        best = h.distance;
        bestId = id;
      }
    }
    for (const r of this.uniques) {
      hits.length = 0;
      raycaster.intersectObject(r.unique!, true, hits);
      if (hits.length && hits[0].distance < best) {
        best = hits[0].distance;
        bestId = r.obj.id;
      }
    }
    hits.length = 0;
    return bestId;
  }

  setHighlight(objectId: number | null): void {
    this.highlightId = objectId;
    const rec = objectId === null ? undefined : this.recs.get(objectId);
    if (!rec) {
      this.highlight.clear();
      return;
    }
    this.showHighlight(rec);
  }

  private showHighlight(rec: ObjRec): void {
    const model = rec.unique ? rec.unique.clone(true) : rec.tpl.root.clone(true);
    model.position.set(0, 0, 0);
    model.quaternion.identity();
    model.scale.set(1, 1, 1);
    const o = rec.obj;
    const def = OBJECTS_BY_ID[o.defId];
    const [w, d] = rotatedSize(def, o.rot);
    const m = this.tmpM.copy(rec.matrix);
    if (!rec.unique) {
      // template root's own transform is baked in tpl.parts; keep it on the clone
      model.position.copy(rec.tpl.root.position);
      model.quaternion.copy(rec.tpl.root.quaternion);
      model.scale.copy(rec.tpl.root.scale);
      model.updateMatrix();
      m.multiply(model.matrix);
    }
    this.highlight.show(model, m, { x0: o.tx * TILE, z0: o.tz * TILE, x1: (o.tx + w) * TILE, z1: (o.tz + d) * TILE });
  }

  // ------------------------------------------------------------ misc

  /** Debug counters (not part of the contract). */
  debugInfo(): { backend: string; batches: number; liveBatches: number; instances: number; uniques: number; fenceMeshes: number } {
    let live = 0;
    let inst = 0;
    for (const b of this.batchList) {
      const n = b.drawn();
      if (n > 0) live++;
      inst += n;
    }
    return {
      backend: this.backend,
      batches: this.batchList.length,
      liveBatches: live,
      instances: inst,
      uniques: this.uniques.length,
      fenceMeshes: this.fences.meshes().filter((m) => m.count > 0).length,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsub) u();
    this.unsub = [];
    for (const b of this.batchList) b.dispose();
    this.batchList = [];
    this.batches.clear();
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    for (const t of this.templates.values())
      t.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        geos.add(mesh.geometry);
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mats.add(m);
      });
    for (const g of geos) g.dispose();
    for (const g of this.splitGeos) g.dispose();
    this.splitGeos = [];
    for (const m of mats) {
      disposeWind(m);
      m.dispose();
    }
    this.templates.clear();
    for (const g of placeholderGeo.values()) g.dispose();
    placeholderGeo.clear();
    this.fences.dispose();
    disposeFenceStyles();
    this.litter.dispose();
    this.highlight.dispose();
    for (const l of this.lights) l.light.removeFromParent();
    this.lights = [];
    disposePropMaterials();
    this.root.removeFromParent();
  }
}
