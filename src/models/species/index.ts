// Species registry: one file per species id (src/data/species.ts). Each file
// default-exports a SpeciesModel. Specialists edit only their species files;
// this index just collects them.

import type { SpeciesModel } from '../types';
import { genericQuadruped } from '../kit/generic';
import elephant from './elephant';
import giraffe from './giraffe';
import zebra from './zebra';
import lion from './lion';
import tiger from './tiger';
import grizzly from './grizzly';
import polarbear from './polarbear';
import hippo from './hippo';
import rhino from './rhino';
import gazelle from './gazelle';
import camel from './camel';
import gorilla from './gorilla';
import penguin from './penguin';
import flamingo from './flamingo';

export const SPECIES_MODELS: Record<string, SpeciesModel> = {
  elephant,
  giraffe,
  zebra,
  lion,
  tiger,
  grizzly,
  polarbear,
  hippo,
  rhino,
  gazelle,
  camel,
  gorilla,
  penguin,
  flamingo,
};

/** Fallback for ids without a model file (e.g. new data entries). */
export function placeholderFor(id: string): SpeciesModel {
  return {
    id,
    design: (ctx) => genericQuadruped(ctx, { palette: { back: 0x7a6650, side: 0x8a7560, belly: 0xb8a68c } }),
  };
}
