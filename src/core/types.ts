// Shared data types. Pure types/enums only — no runtime dependencies on
// three.js or the DOM so the simulation can run (and be tested) in Node.

export enum Terrain {
  Grass = 0, // lush temperate grass
  DryGrass = 1, // savanna / prairie
  Dirt = 2, // bare earth
  Sand = 3, // desert / beach
  Rock = 4, // rocky ground / gravel scree
  Snow = 5, // snow & ice
  Mud = 6, // wet mud (wetland)
  Water = 7, // shallow water (wadeable)
  DeepWater = 8, // deep water (swimming)
}
export const TERRAIN_COUNT = 9;
export const isWater = (t: Terrain) => t === Terrain.Water || t === Terrain.DeepWater;

export enum PathType {
  None = 0,
  Paved = 1, // light stone pavers
  Gravel = 2, // compacted gravel
  Boardwalk = 3, // timber deck
}

export type Biome = 'savanna' | 'temperate' | 'arctic' | 'tropical' | 'desert' | 'wetland';
export type Diet = 'herbivore' | 'carnivore' | 'omnivore' | 'piscivore';

/** Skeleton template a species model is built on. */
export type RigKind = 'quadruped' | 'bird' | 'penguin' | 'primate';

export interface SpeciesDef {
  id: string;
  name: string;
  latin: string;
  biome: Biome;
  description: string;
  /** Ideal terrain composition (fractions, sum ≈ 1). */
  terrain: Partial<Record<Terrain, number>>;
  /** Object def ids this species likes in its habitat (foliage, rocks, shelters, toys). */
  likes: string[];
  /** Desired number of liked objects per tile of habitat (0..1). */
  foliageDensity: number;
  /** Tiles of habitat area wanted per adult animal. */
  spacePerAnimal: number;
  groupMin: number;
  groupMax: number;
  cost: number;
  /** Guest interest 1..10. */
  appeal: number;
  /** Fence strength needed to contain it (1..4). */
  danger: number;
  diet: Diet;
  swims: boolean;
  /** Adult shoulder height in metres (for scale reference). */
  height: number;
  /** Adult body length in metres. */
  length: number;
  walkSpeed: number; // m/s
  runSpeed: number; // m/s
  rig: RigKind;
  /** Days to adulthood (babies are scaled down until then). */
  maturityDays: number;
  gestationDays: number;
  lifespanDays: number;
}

export type ObjectCategory =
  | 'tree'
  | 'plant'
  | 'rock'
  | 'shelter'
  | 'enrichment'
  | 'feeder'
  | 'shop'
  | 'facility'
  | 'amenity'
  | 'decoration';

export type ShopKind = 'food' | 'drink' | 'gift' | 'icecream';

export interface ObjectDef {
  id: string;
  name: string;
  category: ObjectCategory;
  /** Footprint in tiles [width (x), depth (z)] at rotation 0. */
  size: [number, number];
  cost: number;
  /** Upkeep per game day. */
  upkeep: number;
  /** Scenery appeal for nearby guests (0..10). */
  appeal: number;
  /** Must be placed inside a habitat. */
  habitatOnly?: boolean;
  /** Must be placed outside habitats (shops, benches...). */
  guestOnly?: boolean;
  /** Animals / guests cannot walk through it. */
  solid: boolean;
  /**
   * Solid objects: size (m) [x, z] at rotation 0 of the part bodies must stay out of,
   * centred on the footprint (e.g. a feeder's frame, a tree's trunk). Defaults to the
   * footprint less a 0.1 m border.
   */
  solidSize?: [number, number];
  /** Terrain the object looks natural on (purely informational for UI). */
  biomes?: Biome[];
  shop?: { kind: ShopKind; price: number; stockCost: number };
  restroom?: boolean;
  bench?: boolean;
  bin?: boolean;
  /** Light source at night (lamps, shops). */
  light?: boolean;
  /** For feeders/shelters: which diet/species they serve. */
  serves?: 'food' | 'water' | 'shelter' | 'play';
  /** Guests need to walk to an adjacent path tile to use it (shops etc). */
  needsPathAccess?: boolean;
  /** Not available in the build menu (e.g. the entrance gate). */
  notBuildable?: boolean;
  description: string;
}

export interface FenceDef {
  id: number; // stored in world edge arrays (0 = none)
  key: string;
  name: string;
  strength: number; // 1..4 compared against SpeciesDef.danger
  costPerSegment: number;
  /** 0..1 — how well guests can see through it (glass = 1, stone wall = 0.2). */
  visibility: number;
  height: number; // metres
  description: string;
}

export interface PathDef {
  type: PathType;
  name: string;
  costPerTile: number;
  description: string;
}

/** An object instance placed in the world. */
export interface PlacedObject {
  id: number;
  defId: string;
  /** Footprint origin tile (min x / min z corner of the footprint). */
  tx: number;
  tz: number;
  /** Rotation in quarter turns 0..3 (footprint w/d swap on odd rotations). */
  rot: number;
  /** Deterministic per-instance seed for visual variety. */
  seed: number;
}

export interface Habitat {
  id: number;
  /** Tile indices (z * MAP_W + x) inside this enclosure. */
  tiles: number[];
  /** Tile count per terrain type. */
  terrainCounts: number[];
  /** Ids of placed objects inside. */
  objects: number[];
  /** Weakest fence segment strength around the habitat. */
  minFenceStrength: number;
  /** Path tiles adjacent to the fence, from which guests can view the habitat. */
  viewTiles: number[];
  /** Bounding box in tiles. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  name: string;
}

export type AnimalAction =
  | 'idle'
  | 'walk'
  | 'run'
  | 'eat'
  | 'drink'
  | 'sleep'
  | 'sit'
  | 'play'
  | 'swim'
  | 'social'
  | 'call'; // roar / trumpet / display

export interface AnimalNeeds {
  hunger: number; // 1 = full, 0 = starving
  thirst: number;
  energy: number;
  social: number;
  environment: number; // habitat suitability (terrain + foliage)
  space: number; // crowding
  enrichment: number; // toys / variety
}

export interface AnimalState {
  id: number;
  speciesId: string;
  name: string;
  sex: 'M' | 'F';
  ageDays: number;
  /** 0..1 — fraction of adult size (babies < 1). */
  growth: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Current movement speed in m/s (0 when stationary). */
  speed: number;
  action: AnimalAction;
  /** Seconds spent in the current action. */
  actionTime: number;
  habitatId: number | null;
  needs: AnimalNeeds;
  happiness: number; // 0..1
  health: number; // 0..1
  pregnantDays: number; // 0 = not pregnant
  escaped: boolean;
  seed: number;
}

export interface HumanAppearance {
  skin: number; // 0xRRGGBB
  hair: number;
  shirt: number;
  pants: number;
  shoes: number;
  hairStyle: 0 | 1 | 2 | 3; // short, long, bald, cap/hat
  height: number; // metres (kids ≈ 1.1–1.4, adults 1.55–1.95)
  build: number; // 0.85..1.2 (girth)
  child: boolean;
  female: boolean;
}

export type GuestAction = 'walk' | 'idle' | 'watch' | 'eat' | 'drink' | 'sit' | 'shop' | 'restroom' | 'leave';

export interface GuestNeeds {
  hunger: number; // 1 = satisfied
  thirst: number;
  bladder: number;
  energy: number;
  fun: number;
}

export interface GuestState {
  id: number;
  name: string;
  appearance: HumanAppearance;
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  action: GuestAction;
  actionTime: number;
  needs: GuestNeeds;
  happiness: number; // 0..1
  money: number;
  /** What the guest is holding (rendered in hand). */
  holding: 'none' | 'food' | 'drink' | 'icecream' | 'balloon' | 'gift';
  thoughts: string[];
  seenSpecies: string[];
  /** Hidden while inside a building (restroom / shop interior). */
  hidden: boolean;
  seed: number;
}

export type StaffRole = 'keeper' | 'groundskeeper' | 'vet';

export interface StaffState {
  id: number;
  role: StaffRole;
  name: string;
  appearance: HumanAppearance;
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  action: 'walk' | 'idle' | 'work';
  actionTime: number;
  salary: number; // per game day
  /** Habitat id currently assigned / being serviced. */
  task: string;
  seed: number;
}

export interface Litter {
  id: number;
  x: number;
  z: number;
  kind: 'trash' | 'dung';
}

export interface Objective {
  id: string;
  text: string;
  done: boolean;
  reward: number;
}

export interface LedgerEntry {
  day: number;
  income: number;
  expenses: number;
  admissions: number;
  shopIncome: number;
  donations: number;
  upkeep: number;
  /** Animal food (daily, scaled by each animal's size and growth). */
  food: number;
  salaries: number;
  construction: number;
  animalPurchases: number;
}

/** Result of a build / buy command. */
export interface CommandResult {
  ok: boolean;
  cost: number;
  reason?: string;
  /**
   * Set on a successful (or dry-run) command whose outcome is probably not what
   * the player wants, e.g. fences that close an area which still won't become a
   * habitat ("a path runs inside the fence"). The UI shows it as a warning.
   */
  warning?: string;
}

export type Tool =
  | { kind: 'select' }
  | { kind: 'fence'; fenceId: number }
  | { kind: 'path'; pathType: PathType }
  | { kind: 'terrain'; terrain: Terrain; brush: number }
  | { kind: 'object'; defId: string; rot: number }
  | { kind: 'animal'; speciesId: string }
  | { kind: 'staff'; role: StaffRole }
  | { kind: 'bulldoze' };

export type SelectionRef =
  | { kind: 'animal'; id: number }
  | { kind: 'guest'; id: number }
  | { kind: 'staff'; id: number }
  | { kind: 'object'; id: number }
  | { kind: 'habitat'; id: number };
