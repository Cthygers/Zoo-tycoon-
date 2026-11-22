// Creature factory: procedural animals and people (implements ICreatureFactory).
//
//   import { createCreatureFactory } from './models';
//   const creatures = createCreatureFactory(quality);
//   await creatures.preload(['zebra', 'lion'], (f) => bar.set(f));
//   const z = creatures.createAnimal('zebra', { seed: 7, sex: 'F', growth: 1 });
//   scene.add(z.object); … z.update(dt, { action: 'walk', speed: 1.4 });
//
// See src/models/README.md for the species / rig authoring guide.

import type { CreatureModel, ICreatureFactory, QualitySettings } from '../core/contracts';
import type { HumanAppearance, StaffRole } from '../core/types';
import { SPECIES_BY_ID } from '../data/species';
import { assetFromDesign } from './assets';
import { RiggedModel, type RigAsset } from './model';
import { SPECIES_MODELS, placeholderFor } from './species';
import { HumanFactory } from './humans/human';
import type { SpeciesModel } from './types';

export type { CreatureDesign, SpeciesModel, CoatSample, AnimCtx, AnimDriver } from './types';

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export class CreatureFactory implements ICreatureFactory {
  readonly quality: QualitySettings;
  private readonly assets = new Map<string, RigAsset>();
  private readonly humans: HumanFactory;

  constructor(quality: QualitySettings) {
    this.quality = quality;
    this.humans = new HumanFactory(quality);
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
    const model = new RiggedModel(asset, opts.seed, opts.sex, scale);
    model.setGrowth(opts.growth);
    return model;
  }

  createHuman(appearance: HumanAppearance, role: 'guest' | StaffRole, seed: number): CreatureModel {
    return this.humans.create(appearance, role, seed);
  }

  /** Stats for debugging / the harness. */
  stats(): { key: string; triangles: number; ms: number }[] {
    return [...this.assets.values()].map((a) => ({ key: a.key, triangles: a.triangles, ms: a.buildMs })).concat(this.humans.stats());
  }
}

export function createCreatureFactory(quality: QualitySettings): ICreatureFactory {
  return new CreatureFactory(quality);
}
