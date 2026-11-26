// Registry of every pre-rendered sound, keyed by id:
//   bed.<name>                       seamless ambient loops
//   syl.<voice>.<type>#<k>           animal syllable variants (speciesAudio.ts)
//   call.<voice> / idle.<voice>      short composites for the built-in animal path
//   loop.colony.<voice>              colony murmur loops
//   amb.<name>                       ambient wildlife one-shots (owl, songbirds...)
//   cue.<name>                       UI / feedback cues
// Engine modules add their own ids (e.g. fx.*) with registerRecipes.

import type { Recipe } from '../render';
import { ANIMAL_RECIPES } from './animals';
import { BED_RECIPES } from './beds';
import { COLONY_RECIPES } from './colony';
import { CUE_RECIPES } from './cues';

export const RECIPES: Record<string, Recipe> = { ...BED_RECIPES, ...ANIMAL_RECIPES, ...COLONY_RECIPES };
for (const [id, r] of Object.entries(CUE_RECIPES)) RECIPES[`cue.${id}`] = r;

/** Add recipes to the registry; an id may only be registered again with the same Recipe object. */
export function registerRecipes(map: Record<string, Recipe>): void {
  for (const [id, r] of Object.entries(map))
    if (RECIPES[id] && RECIPES[id] !== r) throw new Error(`recipe ${id} is already registered`);
  Object.assign(RECIPES, map);
}

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
export { SPECIES_AUDIO, sylId } from './speciesAudio';
export type { BoutKind, SylBank, Step, Bout, SpeciesAudio } from './speciesAudio';
