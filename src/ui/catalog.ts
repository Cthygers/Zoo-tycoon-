// Build menu catalogue: categories → items (each item maps to a Tool), plus
// display names/colours for terrain, paths and staff.

import type { ISimulation } from '../core/contracts';
import { PathType, Terrain, type Biome, type StaffRole, type Tool } from '../core/types';
import { FENCES, PATHS } from '../data/fences';
import { OBJECTS } from '../data/objects';
import { SPECIES } from '../data/species';
import type { IconName } from './icons';

export type CategoryId = 'habitats' | 'nature' | 'animals' | 'paths' | 'guest' | 'animalfac' | 'staff';

export type ThumbSpec =
  | { kind: 'object'; defId: string }
  | { kind: 'fence'; fenceId: number }
  | { kind: 'animal'; speciesId: string }
  | { kind: 'staff'; role: StaffRole }
  | { kind: 'terrain'; terrain: Terrain }
  | { kind: 'path'; pathType: PathType }
  | { kind: 'icon'; icon: IconName };

export interface CatalogItem {
  key: string;
  name: string;
  /** Price shown on the card (live: wages / terrain prices come from the sim). */
  price: () => number;
  priceSuffix: string;
  tool: Tool;
  thumb: ThumbSpec;
  icon: IconName;
  section: string;
  description: string;
  biome?: Biome;
}

export interface Category {
  id: CategoryId;
  name: string;
  short: string;
  icon: IconName;
  hint: string;
  items: CatalogItem[];
}

export const TERRAIN_INFO: { name: string; color: string }[] = [
  { name: 'Lush Grass', color: '#6f8f45' },
  { name: 'Savanna Grass', color: '#b9a15e' },
  { name: 'Bare Earth', color: '#8a6a48' },
  { name: 'Sand', color: '#dcc690' },
  { name: 'Rocky Ground', color: '#8f8b84' },
  { name: 'Snow & Ice', color: '#e7edf1' },
  { name: 'Mud', color: '#5d4a36' },
  { name: 'Shallow Water', color: '#5f98ab' },
  { name: 'Deep Water', color: '#2e5d77' },
];

export const STAFF_INFO: Record<StaffRole, { name: string; icon: IconName; description: string }> = {
  keeper: { name: 'Animal Keeper', icon: 'bucket', description: 'Feeds the animals, refills feeders and cleans dung from habitats.' },
  groundskeeper: { name: 'Groundskeeper', icon: 'broom', description: 'Sweeps litter, empties bins and keeps paths tidy for guests.' },
  vet: { name: 'Veterinarian', icon: 'vet', description: 'Checks on animals and treats the sick and injured.' },
};

export const BIOME_NAME: Record<Biome, string> = {
  savanna: 'Savanna',
  temperate: 'Temperate',
  arctic: 'Arctic',
  tropical: 'Tropical',
  desert: 'Desert',
  wetland: 'Wetland',
};

const CATEGORY_ICON: Record<string, IconName> = {
  tree: 'tree',
  plant: 'leaf',
  rock: 'mountain',
  shelter: 'hut',
  enrichment: 'sparkle',
  feeder: 'bowl',
  shop: 'shop',
  facility: 'home',
  amenity: 'sparkle',
  decoration: 'sparkle',
};

export function buildCatalog(sim: ISimulation): Category[] {
  const objs = OBJECTS.filter((o) => !o.notBuildable);
  const objItem = (id: string, section: string): CatalogItem => {
    const d = objs.find((o) => o.id === id)!;
    return {
      key: `obj:${d.id}`,
      name: d.name,
      price: () => d.cost,
      priceSuffix: '',
      tool: { kind: 'object', defId: d.id, rot: 0 },
      thumb: { kind: 'object', defId: d.id },
      icon: CATEGORY_ICON[d.category] ?? 'sparkle',
      section,
      description: d.description,
      biome: d.biomes?.[0],
    };
  };
  const pick = (filter: (cat: string, id: string, guestOnly: boolean) => boolean, section: (cat: string) => string) =>
    objs.filter((o) => filter(o.category, o.id, !!o.guestOnly)).map((o) => objItem(o.id, section(o.category)));

  const habitats: CatalogItem[] = [
    ...FENCES.map(
      (f): CatalogItem => ({
        key: `fence:${f.id}`,
        name: f.name,
        price: () => f.costPerSegment,
        priceSuffix: '/2m',
        tool: { kind: 'fence', fenceId: f.id },
        thumb: { kind: 'fence', fenceId: f.id },
        icon: 'fence',
        section: 'Fences',
        description: `${f.description} Strength ${f.strength}/4 · ${Math.round(f.visibility * 100)}% visibility.`,
      }),
    ),
    ...TERRAIN_INFO.map(
      (t, i): CatalogItem => ({
        key: `terrain:${i}`,
        name: t.name,
        price: () => sim.terrainCost(i as Terrain),
        priceSuffix: '/tile',
        tool: { kind: 'terrain', terrain: i as Terrain, brush: 1 },
        thumb: { kind: 'terrain', terrain: i as Terrain },
        icon: i >= Terrain.Water ? 'water' : 'layers',
        section: 'Terrain',
        description: i === Terrain.DeepWater ? 'Deep water for swimmers. Carves a pool.' : i === Terrain.Water ? 'Wadeable shallows for drinking and bathing.' : `Paint ${t.name.toLowerCase()} terrain.`,
      }),
    ),
    {
      key: 'bulldoze',
      name: 'Bulldoze',
      price: () => 0,
      priceSuffix: '',
      tool: { kind: 'bulldoze' },
      thumb: { kind: 'icon', icon: 'bulldoze' },
      icon: 'bulldoze',
      section: 'Remove',
      description: 'Clear objects, paths and fences in an area, or remove single fence runs, for a partial refund.',
    },
  ];

  const nature = pick(
    (cat, id, guestOnly) => (cat === 'tree' || cat === 'plant' || cat === 'rock') && !guestOnly,
    (cat) => (cat === 'tree' ? 'Trees' : cat === 'plant' ? 'Plants' : 'Rocks'),
  );
  // keep sections grouped in a stable order
  const order = ['Trees', 'Plants', 'Rocks'];
  nature.sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));

  const animals = SPECIES.map(
    (s): CatalogItem => ({
      key: `animal:${s.id}`,
      name: s.name,
      price: () => s.cost,
      priceSuffix: '',
      tool: { kind: 'animal', speciesId: s.id },
      thumb: { kind: 'animal', speciesId: s.id },
      icon: 'paw',
      section: BIOME_NAME[s.biome],
      description: s.description,
      biome: s.biome,
    }),
  );
  const biomeOrder: Biome[] = ['savanna', 'tropical', 'temperate', 'arctic', 'wetland', 'desert'];
  animals.sort((a, b) => biomeOrder.indexOf(a.biome!) - biomeOrder.indexOf(b.biome!));

  const paths = PATHS.map(
    (p): CatalogItem => ({
      key: `path:${p.type}`,
      name: p.name,
      price: () => p.costPerTile,
      priceSuffix: '/tile',
      tool: { kind: 'path', pathType: p.type },
      thumb: { kind: 'path', pathType: p.type },
      icon: 'path',
      section: 'Paths',
      description: p.description,
    }),
  );

  const guestSection = (cat: string) => (cat === 'shop' ? 'Shops' : cat === 'facility' ? 'Services' : cat === 'amenity' ? 'Amenities' : 'Decor');
  const guestOrder = ['Shops', 'Services', 'Amenities', 'Decor'];
  const guest = pick((cat, _id, guestOnly) => cat === 'shop' || cat === 'facility' || cat === 'amenity' || (cat === 'decoration' && guestOnly) || ((cat === 'plant') && guestOnly), guestSection);
  guest.sort((a, b) => guestOrder.indexOf(a.section) - guestOrder.indexOf(b.section));

  const facSection = (cat: string) => (cat === 'shelter' ? 'Shelters' : cat === 'feeder' ? 'Food & Water' : 'Enrichment');
  const facOrder = ['Shelters', 'Food & Water', 'Enrichment'];
  const animalfac = pick((cat) => cat === 'shelter' || cat === 'feeder' || cat === 'enrichment', facSection);
  animalfac.sort((a, b) => facOrder.indexOf(a.section) - facOrder.indexOf(b.section));

  const staff = (['keeper', 'groundskeeper', 'vet'] as StaffRole[]).map(
    (r): CatalogItem => ({
      key: `staff:${r}`,
      name: STAFF_INFO[r].name,
      price: () => sim.staffWage(r),
      priceSuffix: '/day',
      tool: { kind: 'staff', role: r },
      thumb: { kind: 'staff', role: r },
      icon: STAFF_INFO[r].icon,
      section: 'Staff',
      description: STAFF_INFO[r].description,
    }),
  );

  return [
    { id: 'habitats', name: 'Habitats', short: 'Habitat', icon: 'fence', hint: 'Fence an enclosure, then shape its terrain', items: habitats },
    { id: 'nature', name: 'Nature', short: 'Nature', icon: 'tree', hint: 'Trees, plants and rocks that animals love', items: nature },
    { id: 'animals', name: 'Animals', short: 'Animals', icon: 'paw', hint: 'Adopt animals into a fenced habitat', items: animals },
    { id: 'paths', name: 'Paths', short: 'Paths', icon: 'path', hint: 'Guests only walk on paths', items: paths },
    { id: 'guest', name: 'Guest Facilities', short: 'Guests', icon: 'shop', hint: 'Shops, restrooms, benches and decorations', items: guest },
    { id: 'animalfac', name: 'Animal Facilities', short: 'Care', icon: 'hut', hint: 'Shelters, feeders and enrichment for habitats', items: animalfac },
    { id: 'staff', name: 'Staff', short: 'Staff', icon: 'staff', hint: 'Hire staff — tap a path to place them', items: staff },
  ];
}

/** A short human name for a tool (toolbar title). */
export function toolKey(tool: Tool): string {
  switch (tool.kind) {
    case 'fence':
      return `fence:${tool.fenceId}`;
    case 'path':
      return `path:${tool.pathType}`;
    case 'terrain':
      return `terrain:${tool.terrain}`;
    case 'object':
      return `obj:${tool.defId}`;
    case 'animal':
      return `animal:${tool.speciesId}`;
    case 'staff':
      return `staff:${tool.role}`;
    case 'bulldoze':
      return 'bulldoze';
    default:
      return 'select';
  }
}
