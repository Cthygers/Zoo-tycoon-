// Crowd renderer: draws every creature of the main scene through a handful of
// SkinnedBatches (one per animal mesh variant, one for all people of a quality
// tier) plus one batch of hand-held items. Once per frame (update) it reads
// each model's object (world matrix, visibility), picks the LOD level with
// hysteresis, decides shadow casting, builds missing LOD meshes within a small
// time budget and flushes the instance data textures.

import * as THREE from 'three';
import type { QualitySettings } from '../../core/contracts';
import { LOD_LEVELS, castsShadow, lodPolicy, pickLod, type LodChain, type LodPolicy } from '../lod/lod';
import type { CrowdHost, RiggedModel } from '../model';
import { FilteredBatch, SkinnedBatch } from './batch';
import type { BatchMaterials } from './materials';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** How a model's batch is created (materials + layout). */
export interface BatchSpec {
  key: string;
  bones: number;
  look: number;
  make(): BatchMaterials;
}

/** Models that render batched implement this on top of RiggedModel. */
export interface BatchedModel {
  batchSpec(): BatchSpec;
  /** Free extra instances (held items) when leaving the batch. */
  releaseExtras?(crowd: CrowdRenderer): void;
}

const _world = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _cam = new THREE.Vector3();

export interface CrowdStats {
  batches: number;
  instances: number;
  visible: number;
  shadow: number;
  perLod: number[];
  lodBuilds: number;
  lodBuildMs: number;
}

export class CrowdRenderer implements CrowdHost {
  readonly root: THREE.Group;
  private readonly batches = new Map<string, SkinnedBatch>();
  private readonly materials = new Map<string, BatchMaterials>();
  private readonly models = new Set<RiggedModel>();
  /** Models rendered standalone (re-checked each frame in case they move into the scene). */
  private readonly loose = new Set<RiggedModel>();
  private itemBatch: FilteredBatch | null = null;
  private itemMaterial: THREE.Material | null = null;
  private policy: LodPolicy;
  private readonly queue: { chain: LodChain; level: number }[] = [];
  private readonly queued = new Set<string>();
  /** Force every creature to one LOD level (debug / harness), -1 = automatic. */
  forceLod = -1;
  /**
   * Shadow casters use this many LOD levels coarser than their main-pass mesh
   * (capped at the coarsest). Shadow maps are low-res: even the 12 % level
   * casts a shadow indistinguishable from the full mesh (checked in the harness).
   */
  shadowLodBias = 3;
  /** Time budget (ms) per frame for building LOD meshes. */
  buildBudgetMs = 4;
  readonly stats: CrowdStats = { batches: 0, instances: 0, visible: 0, shadow: 0, perLod: [0, 0, 0, 0], lodBuilds: 0, lodBuildMs: 0 };

  constructor(quality: QualitySettings, itemMaterial: () => THREE.Material) {
    this.root = new THREE.Group();
    this.root.name = 'creature-batches';
    this.policy = lodPolicy(quality);
    this.makeItemMaterial = itemMaterial;
  }
  private readonly makeItemMaterial: () => THREE.Material;

  setQuality(q: QualitySettings): void {
    this.policy = lodPolicy(q);
  }

  /** The scene the batches render in (null while the root is not in a scene). */
  private scene(): THREE.Object3D | null {
    let o: THREE.Object3D = this.root;
    while (o.parent) o = o.parent;
    return o === this.root ? null : o;
  }

  private inScene(obj: THREE.Object3D): boolean {
    const scene = this.scene();
    if (!scene) return false;
    let o: THREE.Object3D | null = obj;
    while (o) {
      if (o === scene) return true;
      o = o.parent;
    }
    return false;
  }

  // ---------------------------------------------------------------- CrowdHost
  parentChanged(model: RiggedModel): void {
    const want = model.object.parent !== null && this.inScene(model.object);
    if (want && !model.isBatched) this.attach(model);
    else if (!want && model.isBatched) this.detach(model);
    if (!model.isBatched) {
      this.loose.add(model);
      if (model.object.parent) model.ensureDrawable();
    } else this.loose.delete(model);
  }

  release(model: RiggedModel): void {
    if (model.isBatched) this.detach(model);
    this.loose.delete(model);
  }

  // ---------------------------------------------------------------- batches
  private batchFor(spec: BatchSpec, firstGeometry: THREE.BufferGeometry, expected: number): SkinnedBatch {
    let b = this.batches.get(spec.key);
    if (b) return b;
    let mats = this.materials.get(spec.key);
    if (!mats) {
      mats = spec.make();
      this.materials.set(spec.key, mats);
    }
    const nv = firstGeometry.getAttribute('position').count;
    const ni = firstGeometry.getIndex()?.count ?? nv * 3;
    // room for level 0 + the lighter LODs (Σ LOD_RATIOS ≈ 1.9) of the expected number of mesh variants
    const room = 1.9 * expected;
    b = new SkinnedBatch(spec.key, mats.material, mats.depth, mats.uniforms, {
      bones: spec.bones,
      look: spec.look,
      instances: expected > 2 ? 128 : 8,
      vertices: Math.ceil(nv * room),
      indices: Math.ceil(ni * room),
    });
    this.batches.set(spec.key, b);
    this.root.add(b);
    return b;
  }

  private attach(model: RiggedModel): void {
    const bm = model as unknown as RiggedModel & BatchedModel;
    const spec = bm.batchSpec();
    const chain = model.asset.lod;
    if (!chain) return;
    const b = this.batchFor(spec, chain.levels[0]!, spec.key.startsWith('human') ? 16 : 1);
    const g0 = b.addKeyedGeometry(`${model.asset.key}#0`, chain.levels[0]!, chain.sphere);
    const slot = b.addSlot(g0);
    b.setVisible(slot, false); // shown by the next update once its matrix is known
    model.enterBatch(b, slot);
    model.geoIds[0] = g0;
    this.models.add(model);
    this.loose.delete(model);
  }

  private detach(model: RiggedModel): void {
    const b = model.batch;
    if (!b) return;
    (model as unknown as BatchedModel).releaseExtras?.(this);
    b.removeSlot(model.slot);
    model.leaveBatch();
    this.models.delete(model);
  }

  /** Batch geometry id for a LOD level of a model's asset (falls back to finer built levels). */
  private geometryFor(model: RiggedModel, level: number): number {
    const ids = model.geoIds;
    for (let l = level; l >= 0; l--) {
      if (ids[l] >= 0) return ids[l];
      const b = model.batch!;
      const chain = model.asset.lod!;
      const key = `${model.asset.key}#${l}`;
      let id = b.geometryId(key);
      if (id < 0 && chain.has(l)) id = b.addKeyedGeometry(key, chain.levels[l]!, chain.sphere);
      if (id >= 0) {
        ids[l] = id;
        return id;
      }
      this.request(chain, l, model.asset.key);
    }
    return ids[0];
  }

  private request(chain: LodChain, level: number, key: string): void {
    const k = `${key}#${level}`;
    if (this.queued.has(k)) return;
    this.queued.add(k);
    this.queue.push({ chain, level });
  }

  private buildQueued(): void {
    if (!this.queue.length) return;
    const t0 = now();
    // at least one clustering pass per frame, then as many as fit in the budget
    do {
      const job = this.queue[0];
      const t = now();
      let done = true;
      try {
        done = job.chain.step(job.level);
      } catch (err) {
        console.error('[models] LOD build failed', err);
      }
      this.stats.lodBuildMs += now() - t;
      if (done) {
        this.queue.shift();
        this.stats.lodBuilds++;
      }
    } while (this.queue.length && now() - t0 < this.buildBudgetMs);
  }

  // ---------------------------------------------------------------- items
  /** Shared batch of hand-held items (food, drinks, balloons, brooms …). */
  items(): FilteredBatch {
    if (!this.itemBatch) {
      this.itemMaterial = this.makeItemMaterial();
      this.itemBatch = new FilteredBatch('creature-items', this.itemMaterial, 64, 4096, 8192);
      this.root.add(this.itemBatch);
    }
    return this.itemBatch;
  }

  // ---------------------------------------------------------------- per frame
  update(camera: THREE.Camera): void {
    this.buildQueued();
    camera.updateMatrixWorld();
    _cam.setFromMatrixPosition(camera.matrixWorld);
    // standalone models that may have entered the scene through an ancestor
    if (this.loose.size) for (const m of this.loose) if (m.object.parent) this.parentChanged(m);
    for (const b of this.batches.values()) b.beginBounds();
    this.itemBatch?.beginBounds();
    const st = this.stats;
    st.visible = 0;
    st.shadow = 0;
    st.perLod.fill(0);
    const p = this.policy;
    let lastParent: THREE.Object3D | null = null;
    for (const m of this.models) {
      const b = m.batch!;
      const id = m.slot;
      const obj = m.object;
      let vis = true;
      for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
        if (!o.visible) {
          vis = false;
          break;
        }
      }
      b.setVisible(id, vis);
      if (!vis) {
        m.syncFrame(_world, false);
        continue;
      }
      // parents (the entities group) are updated once per frame, not once per model
      const parent = obj.parent;
      if (parent && parent !== lastParent) {
        parent.updateWorldMatrix(true, false);
        lastParent = parent;
      }
      obj.updateMatrix();
      if (parent) obj.matrixWorld.multiplyMatrices(parent.matrixWorld, obj.matrix);
      else obj.matrixWorld.copy(obj.matrix);
      _world.copy(obj.matrixWorld);
      b.setMatrixAt(id, _world);
      _pos.setFromMatrixPosition(_world);
      const dist = _pos.distanceTo(_cam);
      const size = m.sizeFactor;
      const lod = this.forceLod >= 0 ? Math.min(this.forceLod, LOD_LEVELS - 1) : pickLod(m.lod, dist / size, p);
      m.lod = lod;
      b.setGeometry(id, this.geometryFor(m, lod));
      const shadow = castsShadow(dist, size, p);
      m.shadowOn = shadow;
      b.setCastShadow(id, shadow);
      const sl = Math.min(LOD_LEVELS - 1, lod + this.shadowLodBias);
      b.setShadowGeometry(id, shadow && sl !== lod ? this.geometryFor(m, sl) : -1);
      b.includeBounds(_pos, m.cullRadius, shadow);
      m.syncFrame(_world, true);
      st.visible++;
      if (shadow) st.shadow++;
      st.perLod[lod]++;
    }
    for (const b of this.batches.values()) {
      b.endBounds();
      b.flush();
    }
    this.itemBatch?.endBounds();
    st.batches = this.batches.size;
    st.instances = this.models.size;
  }

  /** Number of models currently rendered through batches. */
  get batchedCount(): number {
    return this.models.size;
  }

  /** Number of live models rendering standalone (or detached). */
  get looseCount(): number {
    return this.loose.size;
  }

  batchList(): SkinnedBatch[] {
    return [...this.batches.values()];
  }

  dispose(): void {
    for (const m of [...this.models]) this.detach(m);
    for (const b of this.batches.values()) {
      b.removeFromParent();
      b.dispose();
    }
    this.batches.clear();
    for (const m of this.materials.values()) {
      m.material.dispose();
      m.depth.dispose();
    }
    this.materials.clear();
    if (this.itemBatch) {
      this.itemBatch.removeFromParent();
      this.itemBatch.dispose();
      this.itemBatch = null;
    }
  }
}
