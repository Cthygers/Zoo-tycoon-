import * as THREE from 'three';
// Creature factory: procedural animals and people (implements ICreatureFactory).
//
//   import { createCreatureFactory } from './models';
//   const creatures = createCreatureFactory(quality);
//   scene.add(creatures.root);                       // batched crowd rendering
//   await creatures.preload(['zebra', 'lion'], (f) => bar.set(f));
//   const z = creatures.createAnimal('zebra', { seed: 7, sex: 'F', growth: 1 });
//   scene.add(z.object); … z.update(dt, { action: 'walk', speed: 1.4 });
//   creatures.update(camera);                        // once per frame, before render
//
// Rendering: models whose object is in the same scene as `root` are drawn by
// the crowd renderer (crowd/): one multi-draw call per animal mesh variant and
// one for all people, texture skinning, per-instance LOD + shadow culling.
// Models used elsewhere (UI thumbnails) render standalone. See README.md.

import type { CreatureModel, ICreatureFactory, QualitySettings } from '../core/contracts';
import type { HumanAppearance, StaffRole } from '../core/types';
import { SPECIES_BY_ID } from '../data/species';
import { assetFromDesign } from './assets';
import { RiggedModel, type CrowdHost, type RigAsset } from './model';
import { SPECIES_MODELS, placeholderFor } from './species';
import { HumanFactory } from './humans/human';
import { itemMaterial } from './humans/items';
import { CrowdRenderer, type BatchSpec, type BatchedModel, type CrowdStats } from './crowd/crowd';
import { ANIMAL_LOOK_TEXELS, batchedAnimalMaterials } from './crowd/materials';
import { LOD_LEVELS, LodChain } from './lod/lod';
import type { SpeciesModel } from './types';

export type { CreatureDesign, SpeciesModel, CoatSample, AnimCtx, AnimDriver } from './types';

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** An animal: RiggedModel rendered in the batch of its mesh variant. */
export class AnimalModel extends RiggedModel implements BatchedModel {
  batchSpec(): BatchSpec {
    const a = this.asset;
    return {
      key: `animal:${a.key}`,
      bones: a.rig.count,
      look: ANIMAL_LOOK_TEXELS,
      make: () => batchedAnimalMaterials(a.design.look, a.detail ?? 1),
    };
  }
}

export class CreatureFactory implements ICreatureFactory {
  quality: QualitySettings;
  /** Scene group holding the crowd batches (add it to the scene the creatures live in). */
  readonly root: THREE.Group;
  readonly crowd: CrowdRenderer;
  private readonly assets = new Map<string, RigAsset>();
  private readonly humans: HumanFactory;

  constructor(quality: QualitySettings) {
    this.quality = quality;
    this.crowd = new CrowdRenderer(quality, itemMaterial);
    this.root = this.crowd.root;
    this.humans = new HumanFactory(quality, this.crowd);
  }

  private model(id: string): SpeciesModel {
    return SPECIES_MODELS[id] ?? placeholderFor(id);
  }

  private variantKey(id: string, sex: 'M' | 'F'): string {
    const m = this.model(id);
    return `${id}:${m.dimorphic ? sex : '-'}:${this.quality.creatureDetail}`;
  }

  /** Build (or fetch) the cached asset for a species + sex. */
  getAsset(id: string, sex: 'M' | 'F'): RigAsset {
    const key = this.variantKey(id, sex);
    let a = this.assets.get(key);
    if (!a) {
      const m = this.model(id);
      const def = SPECIES_BY_ID[id] ?? SPECIES_BY_ID.zebra;
      const detail = this.quality.creatureDetail;
      a = assetFromDesign(key, m.design({ def, sex, detail }), detail);
      a.lod = new LodChain(a.geometry, a.sphere, a.triangles);
      this.assets.set(key, a);
    }
    return a;
  }

  async preload(speciesIds: string[], onProgress?: (fraction: number) => void): Promise<void> {
    const jobs: [string, 'M' | 'F'][] = [];
    for (const id of speciesIds) {
      const m = this.model(id);
      jobs.push([id, 'F']);
      if (m.dimorphic) jobs.push([id, 'M']);
    }
    onProgress?.(0);
    for (let i = 0; i < jobs.length; i++) {
      await yieldToBrowser();
      try {
        this.getAsset(jobs[i][0], jobs[i][1]);
      } catch (err) {
        console.error(`[models] failed to build ${jobs[i][0]}`, err);
      }
      onProgress?.((i + 1) / jobs.length);
    }
  }

  createAnimal(speciesId: string, opts: { seed: number; sex: 'M' | 'F'; growth: number }): CreatureModel {
    const m = this.model(speciesId);
    const asset = this.getAsset(speciesId, opts.sex);
    const r = ((opts.seed * 2246822519) >>> 0) / 4294967296;
    const scale = m.instanceScale ? m.instanceScale(opts.sex, r) : (opts.sex === 'M' ? 1 : 0.94) * (0.97 + r * 0.06);
    const model = new AnimalModel(asset, opts.seed, opts.sex, scale, '', this.crowd as CrowdHost);
    model.setGrowth(opts.growth);
    return model;
  }

  createHuman(appearance: HumanAppearance, role: 'guest' | StaffRole, seed: number): CreatureModel {
    return this.humans.create(appearance, role, seed);
  }

  /** Once per frame after the models were updated: LOD, shadows, instance upload. */
  update(camera: THREE.Camera): void {
    this.crowd.update(camera);
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.humans.quality = quality;
    this.crowd.setQuality(quality);
  }

  /** Stats for debugging / the harness. */
  stats(): { key: string; triangles: number; ms: number }[] {
    return [...this.assets.values()].map((a) => ({ key: a.key, triangles: a.triangles, ms: a.buildMs })).concat(this.humans.stats());
  }

  /** Triangles per LOD level of every cached mesh (0 = not built yet). */
  lodStats(): { key: string; triangles: number[] }[] {
    return [...this.assets.values()].map((a) => ({ key: a.key, triangles: a.lod?.triangles ?? [] })).concat(this.humans.lodStats());
  }

  crowdStats(): CrowdStats {
    return this.crowd.stats;
  }

  /**
   * Build every LOD level of every mesh created so far, in small async slices
   * (loading screen). Without this, LODs build lazily over the first seconds of
   * play and creatures draw their full meshes until then.
   */
  async warmLods(onProgress?: (fraction: number) => void): Promise<void> {
    const chains: LodChain[] = [];
    for (const a of this.assets.values()) if (a.lod) chains.push(a.lod);
    chains.push(...this.humans.lodChains());
    const jobs: [LodChain, number][] = [];
    for (const c of chains) for (let l = 1; l < LOD_LEVELS; l++) if (!c.has(l)) jobs.push([c, l]);
    onProgress?.(0);
    let t0 = performance.now();
    for (let i = 0; i < jobs.length; i++) {
      const [c, l] = jobs[i];
      while (!c.step(l)) {
        if (performance.now() - t0 > 24) {
          await yieldToBrowser();
          t0 = performance.now();
        }
      }
      onProgress?.((i + 1) / jobs.length);
    }
  }

  dispose(): void {
    this.crowd.dispose();
    for (const a of this.assets.values()) a.lod?.dispose();
  }
}

export function createCreatureFactory(quality: QualitySettings): ICreatureFactory {
  return new CreatureFactory(quality);
}
