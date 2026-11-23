// Registry of every pre-rendered sound, keyed by id:
//   bed.<name>     seamless ambient loops
//   call.<species> / idle.<species>   animal vocalisations
//   amb.<name>     ambient wildlife one-shots (owl, songbirds...)
//   cue.<name>     UI / feedback cues

import type { Recipe } from '../render';
import { ANIMAL_RECIPES } from './animals';
import { BED_RECIPES } from './beds';
import { CUE_RECIPES } from './cues';

export const RECIPES: Record<string, Recipe> = { ...BED_RECIPES, ...ANIMAL_RECIPES };
for (const [id, r] of Object.entries(CUE_RECIPES)) RECIPES[`cue.${id}`] = r;

/** Stable per-sound seed so every render of a recipe is identical. */
export function seedFor(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export { SPECIES_VOICE, voiceIdFor } from './animals';
export type { SpeciesVoice } from './animals';
