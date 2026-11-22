// Habitat suitability: how well an enclosure suits a species (terrain mix,
// liked scenery, space, fence, water, food, social group, mixed-species
// compatibility) plus per-habitat cached tile lists the animal AI uses.

import { MAP_W } from '../core/constants';
import type { SpeciesSuitability } from '../core/contracts';
import { Terrain, TERRAIN_COUNT, type Habitat, type SpeciesDef } from '../core/types';
import type { World } from '../core/world';
import { FENCES } from '../data/fences';
import { OBJECTS_BY_ID, rotatedSize } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import { pluralName } from './names';

export const TERRAIN_NAMES: Record<number, string> = {
  [Terrain.Grass]: 'grass',
  [Terrain.DryGrass]: 'dry grass',
  [Terrain.Dirt]: 'dirt',
  [Terrain.Sand]: 'sand',
  [Terrain.Rock]: 'rock',
  [Terrain.Snow]: 'snow',
  [Terrain.Mud]: 'mud',
  [Terrain.Water]: 'shallow water',
  [Terrain.DeepWater]: 'deep water',
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Population of one habitat, used for space / social evaluation. */
export interface HabitatPopulation {
  /** species id → head count (babies included). */
  count: Map<string, number>;
  /** species id → adult-equivalents (babies weigh by growth). */
  weight: Map<string, number>;
}

/** Per-habitat lists derived from the tiles (rebuilt when the world changes). */
export interface HabitatTiles {
  /** Walkable land tiles (no solid object, not deep water). */
  land: number[];
  /** Land tiles whose 4 neighbours are also inside the habitat and open (good for big animals). */
  interior: number[];
  /** Tiles where an animal can stand to drink (shallow water or land next to water). */
  drink: number[];
  /** Deep water tiles (swimming). */
  deep: number[];
}

export interface SpeciesEval extends SpeciesSuitability {
  /** 0..1 social-group score (with compatibility folded in). */
  social: number;
  /** 0..1 mixed-species compatibility. */
  compat: number;
  /** Predator species present (prey gets stressed). */
  predators: number;
  /** Liked enrichment objects present. */
  toys: number;
}

export function terrainWant(sp: SpeciesDef, out: number[]): number[] {
  out.length = TERRAIN_COUNT;
  let sum = 0;
  for (let t = 0; t < TERRAIN_COUNT; t++) {
    const v = sp.terrain[t as Terrain] ?? 0;
    out[t] = v;
    sum += v;
  }
  if (sum > 0) for (let t = 0; t < TERRAIN_COUNT; t++) out[t] /= sum;
  return out;
}

export function feederFor(sp: SpeciesDef): string[] {
  if (sp.diet === 'herbivore') return ['feeder_hay'];
  if (sp.diet === 'omnivore') return ['feeder_meat', 'feeder_hay'];
  return ['feeder_meat'];
}

export function weakestFenceName(danger: number): string {
  const f = FENCES.filter((d) => d.strength >= danger).sort((a, b) => a.costPerSegment - b.costPerSegment)[0];
  return f ? f.name : 'a stronger fence';
}

/**
 * Evaluate a species in a habitat. `pop` is the current population; when
 * `adding` is true one extra animal of the species is assumed (adopt preview).
 */
export function evaluateSpecies(
  world: World,
  hab: Habitat,
  sp: SpeciesDef,
  pop: HabitatPopulation,
  keepers: number,
  adding: boolean,
): SpeciesEval {
  const issues: string[] = [];
  const area = Math.max(1, hab.tiles.length);

  // ---- terrain
  const want = terrainWant(sp, []);
  let l1 = 0;
  const deficits: { t: number; have: number; want: number }[] = [];
  const excess: { t: number; have: number }[] = [];
  for (let t = 0; t < TERRAIN_COUNT; t++) {
    const have = hab.terrainCounts[t] / area;
    l1 += Math.abs(have - want[t]);
    if (want[t] - have > 0.1) deficits.push({ t, have, want: want[t] });
    else if (have - want[t] > 0.25) excess.push({ t, have });
  }
  const terrain = Math.max(0, 1 - l1 / 2);
  deficits.sort((a, b) => b.want - b.have - (a.want - a.have));
  for (const d of deficits.slice(0, 2)) issues.push(`Needs more ${TERRAIN_NAMES[d.t]} (have ${pct(d.have)}, wants ${pct(d.want)})`);
  excess.sort((a, b) => b.have - a.have);
  for (const e of excess.slice(0, 1)) issues.push(`Too much ${TERRAIN_NAMES[e.t]} (${pct(e.have)})`);

  // ---- liked objects (foliage / rocks / shelters / toys)
  let liked = 0;
  let toys = 0;
  let hasTrough = false;
  let hasFeeder = false;
  const feeders = feederFor(sp);
  for (const oid of hab.objects) {
    const o = world.objects.get(oid);
    if (!o) continue;
    const def = OBJECTS_BY_ID[o.defId];
    if (!def) continue;
    if (o.defId === 'water_trough') hasTrough = true;
    if (feeders.includes(o.defId)) hasFeeder = true;
    if (sp.likes.includes(o.defId)) {
      const [w, d] = rotatedSize(def, o.rot);
      liked += Math.min(2, Math.sqrt(w * d)); // big objects count a bit more
      if (def.serves === 'play') toys++;
    }
  }
  const likedWant = Math.max(1, sp.foliageDensity * area);
  const foliage = Math.min(1, liked / likedWant);
  if (foliage < 0.75) {
    const examples = sp.likes
      .filter((id) => OBJECTS_BY_ID[id] && OBJECTS_BY_ID[id].category !== 'feeder')
      .slice(0, 2)
      .map((id) => OBJECTS_BY_ID[id].name);
    issues.push(`Needs more of the scenery it likes (${Math.floor(liked)} of ${Math.ceil(likedWant)}, e.g. ${examples.join(', ')})`);
  }

  // ---- space
  let required = 0;
  for (const [sid, wgt] of pop.weight) {
    const s2 = SPECIES_BY_ID[sid];
    if (s2) required += s2.spacePerAnimal * wgt;
  }
  if (adding || !pop.count.get(sp.id)) required += sp.spacePerAnimal;
  const space = required <= 0 ? 1 : Math.min(1, area / required);
  if (space < 0.95) issues.push(`Too crowded (${area} tiles, needs ${Math.ceil(required)})`);

  // ---- fence
  const fenceOk = hab.minFenceStrength >= sp.danger;
  if (!fenceOk) issues.push(`Fence too weak (strength ${hab.minFenceStrength}, needs ${sp.danger}: use ${weakestFenceName(sp.danger)})`);

  // ---- water
  const waterTiles = hab.terrainCounts[Terrain.Water] + hab.terrainCounts[Terrain.DeepWater];
  const hasWater = waterTiles > 0 || hasTrough;
  if (!hasWater) issues.push('No drinking water (paint a pond or add a Water Trough)');

  // ---- food
  const grazing = (hab.terrainCounts[Terrain.Grass] + hab.terrainCounts[Terrain.DryGrass]) / area;
  const hasFood = keepers > 0 || (sp.diet === 'herbivore' && grazing > 0.3);
  if (keepers === 0) issues.push('No keeper to bring food (hire a keeper)');
  else if (!hasFeeder) issues.push(`No ${OBJECTS_BY_ID[feeders[0]].name} (keepers scatter food on the ground)`);

  // ---- social group
  const n = (pop.count.get(sp.id) ?? 0) + (adding ? 1 : 0);
  const nEff = Math.max(1, n);
  let social = nEff < sp.groupMin ? nEff / sp.groupMin : nEff > sp.groupMax ? sp.groupMax / nEff : 1;
  if (nEff < sp.groupMin) issues.push(`Lonely: lives in groups of ${sp.groupMin}–${sp.groupMax} (has ${nEff})`);
  else if (nEff > sp.groupMax) issues.push(`Group too big (max ${sp.groupMax}, has ${nEff})`);

  // ---- compatibility with other species
  let compat = 1;
  let predators = 0;
  for (const [sid, cnt] of pop.count) {
    if (sid === sp.id || cnt <= 0) continue;
    const o = SPECIES_BY_ID[sid];
    if (!o) continue;
    const meCarn = sp.diet === 'carnivore';
    const otherCarn = o.diet === 'carnivore';
    if (meCarn && !otherCarn) {
      compat *= 0.35;
      issues.push(`Will hunt the ${pluralName(sid)} — keep predators and prey apart`);
    } else if (!meCarn && otherCarn) {
      compat *= 0.2;
      predators++;
      issues.push(`Terrified of the ${pluralName(sid)} — keep predators and prey apart`);
    } else if (meCarn && otherCarn) {
      compat *= 0.6;
      issues.push(`Fights with the ${pluralName(sid)}`);
    } else if (o.biome !== sp.biome) {
      compat *= 0.92;
      issues.push(`Doesn't mix well with the ${pluralName(sid)} (different habitat)`);
    }
  }
  social *= compat;

  const base = 0.3 * terrain + 0.17 * foliage + 0.18 * space + 0.15 * social + 0.1 * (hasWater ? 1 : 0) + 0.1 * (hasFood ? 1 : 0);
  const score = Math.max(0, Math.min(1, base * (compat < 1 ? 0.5 + 0.5 * compat : 1) * (fenceOk ? 1 : 0.9)));

  return {
    speciesId: sp.id,
    score,
    terrain,
    foliage,
    space,
    fenceOk,
    hasWater,
    hasFood,
    issues,
    social,
    compat,
    predators,
    toys,
  };
}

export function buildHabitatTiles(world: World, hab: Habitat): HabitatTiles {
  const land: number[] = [];
  const interior: number[] = [];
  const drink: number[] = [];
  const deep: number[] = [];
  for (const i of hab.tiles) {
    const x = i % MAP_W,
      z = (i / MAP_W) | 0;
    const t = world.terrain[i] as Terrain;
    if (world.isTileSolid(x, z)) continue;
    if (t === Terrain.DeepWater) {
      deep.push(i);
      continue;
    }
    land.push(i);
    let inner = true;
    let nearWater = t === Terrain.Water;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0),
        nz = z + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (!world.inBounds(nx, nz)) {
        inner = false;
        continue;
      }
      const ni = nz * MAP_W + nx;
      if (world.habitatOf[ni] !== hab.id || world.fenceBetween(x, z, nx, nz) || world.isTileSolid(nx, nz)) inner = false;
      const nt = world.terrain[ni];
      if ((nt === Terrain.Water || nt === Terrain.DeepWater) && world.habitatOf[ni] === hab.id && !world.fenceBetween(x, z, nx, nz)) nearWater = true;
    }
    if (inner) interior.push(i);
    if (nearWater) drink.push(i);
  }
  return { land, interior, drink, deep };
}
