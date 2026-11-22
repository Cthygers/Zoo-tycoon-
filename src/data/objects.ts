// Placeable object catalogue: habitat scenery, animal facilities, guest
// buildings and decorations. Every id here must have a 3D model in
// src/props (createObjectModel) — the props module is the source of visuals.

import type { ObjectDef } from '../core/types';

export const OBJECTS: ObjectDef[] = [
  // ---------------------------------------------------------------- trees
  { id: 'tree_acacia', name: 'Umbrella Acacia', category: 'tree', size: [1, 1], cost: 240, upkeep: 0, appeal: 3, solid: true, biomes: ['savanna'], description: 'Flat-topped thorn tree of the African savanna.' },
  { id: 'tree_baobab', name: 'Baobab', category: 'tree', size: [2, 2], cost: 600, upkeep: 0, appeal: 5, solid: true, biomes: ['savanna'], description: 'Massive bottle-trunked tree that stores water.' },
  { id: 'tree_oak', name: 'Broadleaf Oak', category: 'tree', size: [1, 1], cost: 220, upkeep: 0, appeal: 3, solid: true, biomes: ['temperate', 'tropical'], description: 'Spreading deciduous shade tree.' },
  { id: 'tree_pine', name: 'Scots Pine', category: 'tree', size: [1, 1], cost: 200, upkeep: 0, appeal: 3, solid: true, biomes: ['temperate', 'arctic'], description: 'Tall evergreen conifer with orange upper bark.' },
  { id: 'tree_birch', name: 'Silver Birch', category: 'tree', size: [1, 1], cost: 180, upkeep: 0, appeal: 3, solid: true, biomes: ['temperate'], description: 'Slender tree with white papery bark.' },
  { id: 'tree_palm', name: 'Date Palm', category: 'tree', size: [1, 1], cost: 260, upkeep: 0, appeal: 3, solid: true, biomes: ['tropical', 'desert', 'wetland'], description: 'Feathery-fronded palm of oases and riverbanks.' },
  { id: 'bamboo', name: 'Bamboo Grove', category: 'plant', size: [1, 1], cost: 150, upkeep: 0, appeal: 2, solid: true, biomes: ['tropical'], description: 'Dense clump of giant bamboo canes.' },
  // --------------------------------------------------------------- plants
  { id: 'bush_savanna', name: 'Thorn Bush', category: 'plant', size: [1, 1], cost: 60, upkeep: 0, appeal: 1, solid: false, biomes: ['savanna', 'desert'], description: 'Hardy dry-country shrub.' },
  { id: 'bush_fern', name: 'Fern Thicket', category: 'plant', size: [1, 1], cost: 60, upkeep: 0, appeal: 1, solid: false, biomes: ['temperate', 'tropical'], description: 'Lush ground ferns for shady forest floors.' },
  { id: 'grass_tall', name: 'Tall Grass', category: 'plant', size: [1, 1], cost: 30, upkeep: 0, appeal: 1, solid: false, biomes: ['savanna', 'temperate'], description: 'Waist-high grass tussocks — great cover for big cats.' },
  { id: 'reeds', name: 'Reed Bed', category: 'plant', size: [1, 1], cost: 50, upkeep: 0, appeal: 1, solid: false, biomes: ['wetland'], description: 'Tall reeds that grow at the water’s edge or in shallows.' },
  { id: 'cactus', name: 'Desert Cactus', category: 'plant', size: [1, 1], cost: 80, upkeep: 0, appeal: 2, solid: true, biomes: ['desert'], description: 'Columnar cactus for arid habitats.' },
  { id: 'flower_bed', name: 'Flower Bed', category: 'decoration', size: [1, 1], cost: 90, upkeep: 1, appeal: 3, solid: false, guestOnly: true, description: 'Colourful planting that cheers up guests.' },
  { id: 'hedge', name: 'Clipped Hedge', category: 'decoration', size: [1, 1], cost: 70, upkeep: 1, appeal: 2, solid: true, guestOnly: true, description: 'Neat box hedge for borders.' },
  // ---------------------------------------------------------------- rocks
  { id: 'rock_small', name: 'Rocks', category: 'rock', size: [1, 1], cost: 40, upkeep: 0, appeal: 1, solid: false, description: 'A scatter of weathered stones.' },
  { id: 'rock_boulder', name: 'Boulder', category: 'rock', size: [1, 1], cost: 120, upkeep: 0, appeal: 2, solid: true, description: 'A large rounded granite boulder.' },
  { id: 'rock_outcrop', name: 'Rock Outcrop', category: 'rock', size: [2, 2], cost: 400, upkeep: 0, appeal: 4, solid: true, description: 'Layered sandstone ledges — a favourite lookout for big cats.' },
  { id: 'rock_ice', name: 'Ice Rocks', category: 'rock', size: [1, 1], cost: 150, upkeep: 1, appeal: 2, solid: true, biomes: ['arctic'], description: 'Frost-covered rocks and ice blocks.' },
  { id: 'log_fallen', name: 'Fallen Log', category: 'rock', size: [2, 1], cost: 90, upkeep: 0, appeal: 2, solid: false, description: 'A mossy fallen trunk for climbing and scratching.' },
  // ------------------------------------------------------ animal shelters
  { id: 'shelter_wood', name: 'Timber Shelter', category: 'shelter', size: [2, 2], cost: 900, upkeep: 3, appeal: 1, solid: true, habitatOnly: true, serves: 'shelter', description: 'Roofed timber shelter for shade and rain.' },
  { id: 'shelter_cave', name: 'Rock Den', category: 'shelter', size: [2, 2], cost: 1400, upkeep: 2, appeal: 3, solid: true, habitatOnly: true, serves: 'shelter', description: 'A naturalistic rock cave den.' },
  // ---------------------------------------------------------- enrichment
  { id: 'toy_ball', name: 'Enrichment Ball', category: 'enrichment', size: [1, 1], cost: 150, upkeep: 1, appeal: 2, solid: false, habitatOnly: true, serves: 'play', description: 'Large durable ball to push and chase.' },
  { id: 'climbing_frame', name: 'Climbing Frame', category: 'enrichment', size: [2, 2], cost: 1100, upkeep: 3, appeal: 3, solid: true, habitatOnly: true, serves: 'play', description: 'Timber poles, platforms and ropes for climbers.' },
  // ------------------------------------------------------------- feeders
  { id: 'feeder_hay', name: 'Hay Feeder', category: 'feeder', size: [1, 1], cost: 250, upkeep: 4, appeal: 0, solid: true, habitatOnly: true, serves: 'food', description: 'Raised hay rack for grazers and browsers. Keepers refill it.' },
  { id: 'feeder_meat', name: 'Meat Platform', category: 'feeder', size: [1, 1], cost: 300, upkeep: 6, appeal: 0, solid: false, habitatOnly: true, serves: 'food', description: 'Feeding platform for carnivores. Keepers refill it.' },
  { id: 'water_trough', name: 'Water Trough', category: 'feeder', size: [1, 1], cost: 200, upkeep: 1, appeal: 0, solid: true, habitatOnly: true, serves: 'water', description: 'Stone drinking trough (animals can also drink from ponds).' },
  // --------------------------------------------------------------- shops
  { id: 'shop_snack', name: 'Snack Kiosk', category: 'shop', size: [2, 2], cost: 2500, upkeep: 12, appeal: 1, solid: true, guestOnly: true, needsPathAccess: true, light: true, shop: { kind: 'food', price: 6, stockCost: 2 }, description: 'Sells hot snacks to hungry guests.' },
  { id: 'shop_drinks', name: 'Drinks Kiosk', category: 'shop', size: [1, 1], cost: 1500, upkeep: 8, appeal: 1, solid: true, guestOnly: true, needsPathAccess: true, light: true, shop: { kind: 'drink', price: 4, stockCost: 1 }, description: 'Cold drinks and juices.' },
  { id: 'shop_icecream', name: 'Ice Cream Cart', category: 'shop', size: [1, 1], cost: 1200, upkeep: 6, appeal: 2, solid: true, guestOnly: true, needsPathAccess: true, shop: { kind: 'icecream', price: 4, stockCost: 1 }, description: 'A striped-awning cart selling ice cream.' },
  { id: 'shop_gift', name: 'Gift Shop', category: 'shop', size: [2, 2], cost: 4000, upkeep: 15, appeal: 2, solid: true, guestOnly: true, needsPathAccess: true, light: true, shop: { kind: 'gift', price: 15, stockCost: 6 }, description: 'Plush toys, balloons and souvenirs.' },
  // ---------------------------------------------------------- facilities
  { id: 'restroom', name: 'Restrooms', category: 'facility', size: [2, 2], cost: 2000, upkeep: 10, appeal: 0, solid: true, guestOnly: true, needsPathAccess: true, light: true, restroom: true, description: 'Guests will leave unhappy without these.' },
  { id: 'entrance_gate', name: 'Entrance Gate', category: 'facility', size: [3, 1], cost: 0, upkeep: 0, appeal: 4, solid: false, guestOnly: true, notBuildable: true, light: true, description: 'The main entrance and ticket booths.' },
  // ------------------------------------------------------------ amenities
  { id: 'bench', name: 'Park Bench', category: 'amenity', size: [1, 1], cost: 120, upkeep: 0, appeal: 1, solid: false, guestOnly: true, needsPathAccess: true, bench: true, description: 'Tired guests rest here.' },
  { id: 'bin', name: 'Litter Bin', category: 'amenity', size: [1, 1], cost: 80, upkeep: 0, appeal: 0, solid: false, guestOnly: true, needsPathAccess: true, bin: true, description: 'Reduces litter along paths.' },
  { id: 'lamp', name: 'Lamp Post', category: 'amenity', size: [1, 1], cost: 150, upkeep: 1, appeal: 1, solid: false, guestOnly: true, light: true, description: 'Victorian-style lamp that lights paths at night.' },
  { id: 'picnic_table', name: 'Picnic Table', category: 'amenity', size: [1, 1], cost: 200, upkeep: 0, appeal: 1, solid: true, guestOnly: true, needsPathAccess: true, bench: true, description: 'Guests sit here to eat.' },
  { id: 'donation_box', name: 'Donation Box', category: 'amenity', size: [1, 1], cost: 250, upkeep: 0, appeal: 0, solid: false, guestOnly: true, needsPathAccess: true, description: 'Happy guests near popular habitats donate here.' },
  { id: 'fountain', name: 'Fountain', category: 'decoration', size: [2, 2], cost: 1800, upkeep: 4, appeal: 6, solid: true, guestOnly: true, description: 'A stone fountain with running water.' },
  { id: 'info_sign', name: 'Info Board', category: 'decoration', size: [1, 1], cost: 100, upkeep: 0, appeal: 2, solid: false, guestOnly: true, description: 'Educational sign that makes viewing more rewarding.' },
];

export const OBJECTS_BY_ID: Record<string, ObjectDef> = Object.fromEntries(OBJECTS.map((o) => [o.id, o]));

export function getObjectDef(id: string): ObjectDef {
  const d = OBJECTS_BY_ID[id];
  if (!d) throw new Error(`Unknown object ${id}`);
  return d;
}

/** Footprint size in tiles after applying a quarter-turn rotation. */
export function rotatedSize(def: ObjectDef, rot: number): [number, number] {
  return rot % 2 === 1 ? [def.size[1], def.size[0]] : [def.size[0], def.size[1]];
}
