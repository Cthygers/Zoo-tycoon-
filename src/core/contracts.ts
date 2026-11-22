// Module contracts. Each subsystem is implemented in its own directory and
// talks to the others ONLY through these interfaces (plus core/types, core/world,
// core/events, core/constants and src/data). Do not change these signatures
// without updating every implementer and consumer.
//
//  src/sim      → ISimulation           (game rules, AI, economy; no three.js)
//  src/render   → IRenderContext        (renderer, sky, lighting, terrain, water, grass, post-fx)
//  src/models   → ICreatureFactory      (animal + human 3D models and their animation)
//  src/props    → IPropsLayer           (trees, rocks, buildings, fences, litter models)
//  src/views    → IEntityViews          (binds sim animals/guests/staff to creature models)
//  src/ui       → IGameUI / camera      (HUD, menus, touch input, tools, camera)
//  src/main.ts  → wires everything together and runs the loop

import type * as THREE from 'three';
import type { EventBus, TileRect } from './events';
import type { EdgeRef, World } from './world';
import type {
  AnimalState,
  CommandResult,
  GuestState,
  HumanAppearance,
  LedgerEntry,
  Litter,
  Objective,
  PathType,
  SelectionRef,
  StaffRole,
  StaffState,
  Terrain,
} from './types';

// ===========================================================================
// Simulation (src/sim)
// ===========================================================================

export interface SpeciesSuitability {
  speciesId: string;
  /** Overall 0..1 */
  score: number;
  terrain: number; // 0..1 match of terrain composition
  foliage: number; // 0..1 match of liked objects density
  space: number; // 0..1 (1 = enough room for current population)
  fenceOk: boolean; // fence strength >= species danger
  hasWater: boolean; // pond/trough reachable
  hasFood: boolean; // feeder present (or keeper can feed)
  issues: string[]; // human readable problems, e.g. "Needs more sand"
}

export interface HabitatReport {
  habitatId: number;
  name: string;
  area: number; // tiles
  animals: number[]; // animal ids
  species: string[]; // species ids present
  suitability: SpeciesSuitability[]; // one per species present
  terrainFractions: number[]; // indexed by Terrain
  viewable: boolean; // guests can see it from a path
}

export interface ZooStats {
  guestsInZoo: number;
  guestsToday: number;
  totalVisitors: number;
  animalCount: number;
  speciesCount: number;
  avgAnimalHappiness: number; // 0..1
  avgGuestHappiness: number; // 0..1
  staffCount: number;
  litterCount: number;
}

export type SimSpeed = 0 | 1 | 2 | 3; // paused, 1x, 2x, 4x
export const SPEED_MULTIPLIERS = [0, 1, 2, 4] as const;

export interface SimSave {
  version: 1;
  [key: string]: unknown;
}

export interface ISimulation {
  readonly world: World;
  readonly events: EventBus;
  readonly animals: Map<number, AnimalState>;
  readonly guests: Map<number, GuestState>;
  readonly staff: Map<number, StaffState>;
  readonly litter: Map<number, Litter>;

  money: number;
  admissionPrice: number;
  day: number; // starts at 1
  minuteOfDay: number; // 0..1440 (fractional)
  speed: SimSpeed;
  rating: number; // 0..100
  objectives: Objective[];
  /** Completed days, most recent last (max ~30 kept). */
  ledger: LedgerEntry[];
  /** Running totals for the current day. */
  today: LedgerEntry;

  isOpen(): boolean;
  stats(): ZooStats;

  /**
   * Advance by `realDt` real seconds; internally multiplied by the speed
   * multiplier. Entity movement is in real metres/second scaled by speed;
   * the clock advances GAME_MINUTES_PER_SECOND game-minutes per scaled second.
   * Must be cheap enough to call every frame (≤ ~2 ms with 150 guests).
   */
  update(realDt: number): void;

  // ---- build commands: validate, charge money, mutate world, emit events.
  // ---- With dryRun=true nothing changes and the result gives cost/validity.
  paintTerrain(rect: TileRect, terrain: Terrain, dryRun?: boolean): CommandResult;
  placePaths(tiles: { x: number; z: number }[], type: PathType, dryRun?: boolean): CommandResult;
  placeFences(edges: EdgeRef[], fenceId: number, dryRun?: boolean): CommandResult;
  placeObject(defId: string, tx: number, tz: number, rot: number, dryRun?: boolean): CommandResult;
  /** Remove objects, paths and fences inside the tile rect (partial refund). */
  bulldoze(rect: TileRect, dryRun?: boolean): CommandResult;
  /** Remove specific fence edges (partial refund). */
  removeFences(edges: EdgeRef[], dryRun?: boolean): CommandResult;
  /** Adopt an animal at a world position; must be inside a habitat. */
  buyAnimal(speciesId: string, wx: number, wz: number, dryRun?: boolean): CommandResult;
  sellAnimal(animalId: number): CommandResult;
  hireStaff(role: StaffRole, wx: number, wz: number, dryRun?: boolean): CommandResult;
  fireStaff(staffId: number): CommandResult;
  setAdmission(price: number): void;
  setSpeed(speed: SimSpeed): void;

  // ---- queries
  habitatReport(habitatId: number): HabitatReport | null;
  /** How well a habitat suits a species (for the adopt menu preview). */
  suitability(speciesId: string, habitatId: number): SpeciesSuitability;

  // ---- persistence
  serialize(): SimSave;
  load(save: SimSave): void;
  /** Reset to a brand-new zoo. */
  newGame(seed?: number): void;
}

// ===========================================================================
// Rendering core (src/render)
// ===========================================================================

export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualitySettings {
  level: QualityLevel;
  pixelRatio: number;
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** 0..1 multiplier for instanced grass blades / ground clutter. */
  grassDensity: number;
  /** Post-processing (colour grading, AO, bloom) enabled. */
  postFX: boolean;
  /** Max distance (m) at which small props / grass are drawn. */
  detailDistance: number;
  /** Creature mesh detail 0 (low) .. 2 (high). */
  creatureDetail: 0 | 1 | 2;
}

export interface IRenderContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly quality: QualitySettings;
  /** 0 during full daylight … 1 at full night. Props use it for lamps / windows. */
  readonly nightFactor: number;
  /** Current sun direction (normalized, pointing from ground toward the sun). */
  readonly sunDirection: THREE.Vector3;

  /** Update sky, sun/moon light, fog and exposure for the game clock. */
  setTimeOfDay(minuteOfDay: number, day: number): void;
  /**
   * Tell the renderer where the camera is looking (ground point) and roughly
   * how much ground is visible, so the shadow frustum / grass field follow.
   */
  setFocus(x: number, z: number, viewRadius: number): void;
  /** Per-frame animation (water ripples, grass sway, clouds). dt in real seconds. */
  update(dt: number): void;
  render(): void;
  resize(width: number, height: number): void;
  /** Ray-cast terrain + water surface from normalized device coords (-1..1). */
  pickGround(ndcX: number, ndcY: number): THREE.Vector3 | null;
  setQuality(level: QualityLevel): void;
  dispose(): void;
}

// ===========================================================================
// Creatures (src/models) — animals and people
// ===========================================================================

/** Animation input for a creature model each frame. */
export interface CreatureAnim {
  /** AnimalAction | GuestAction | staff action ('walk','idle','work', ...). */
  action: string;
  /** Ground speed in m/s (drives gait / cadence). */
  speed: number;
  /** In deep water — body sinks to swim depth (animals). */
  swimming?: boolean;
  /** Seconds in the current action (for one-shot motions like 'call'). */
  actionTime?: number;
  /** Item held in hand (humans): 'none'|'food'|'drink'|'icecream'|'balloon'|'gift'. */
  holding?: string;
}

export interface CreatureModel {
  /** Root object. Its origin is on the ground between the feet; it faces +Z. */
  readonly object: THREE.Object3D;
  /** Approximate standing height in metres (after growth scaling). */
  readonly height: number;
  /** Approximate radius in metres (for picking / selection rings). */
  readonly radius: number;
  update(dt: number, anim: CreatureAnim): void;
  /** Change age scaling (0..1 = baby..adult). */
  setGrowth(growth: number): void;
  setHighlighted(on: boolean): void;
  dispose(): void;
}

export interface ICreatureFactory {
  /** Build (and cache) the meshes for these species up front. */
  preload(speciesIds: string[], onProgress?: (fraction: number) => void): Promise<void>;
  createAnimal(speciesId: string, opts: { seed: number; sex: 'M' | 'F'; growth: number }): CreatureModel;
  createHuman(appearance: HumanAppearance, role: 'guest' | StaffRole, seed: number): CreatureModel;
}

// ===========================================================================
// Props / static scenery (src/props)
// ===========================================================================

export interface IPropsLayer {
  /** Root group (already added to the scene by the factory). */
  readonly root: THREE.Group;
  /** Per-frame: lamps glow at night, foliage sways, fountain water animates. */
  update(dt: number, nightFactor: number, camera: THREE.Camera): void;
  /** Standalone model of an object def for ghosts / thumbnails. Origin = footprint centre on ground, facing +Z. */
  createObjectModel(defId: string, seed: number): THREE.Object3D;
  /** Standalone model of one 2 m fence segment along +X (centre at origin) for ghosts / thumbnails. */
  createFenceSegmentModel(fenceId: number): THREE.Object3D;
  /** Replace the drawn litter (trash / dung). */
  setLitter(items: Iterable<Litter>): void;
  /** Ray-cast placed objects; returns the PlacedObject id or null. */
  pickObject(raycaster: THREE.Raycaster): number | null;
  setHighlight(objectId: number | null): void;
  dispose(): void;
}

// ===========================================================================
// Entity views (src/views)
// ===========================================================================

export interface IEntityViews {
  /** Sync creature models with sim state; animate. */
  update(dt: number): void;
  /** Ray-cast animals / guests / staff (and objects via props) at NDC. */
  pick(ndcX: number, ndcY: number): SelectionRef | null;
  setSelected(sel: SelectionRef | null): void;
  /** Current world position of a selectable thing (for camera follow / labels). */
  positionOf(sel: SelectionRef): THREE.Vector3 | null;
  dispose(): void;
}

// ===========================================================================
// UI (src/ui)
// ===========================================================================

export interface UIDeps {
  sim: ISimulation;
  ctx: IRenderContext;
  props: IPropsLayer;
  creatures: ICreatureFactory;
  views: IEntityViews;
  /** Persist the game (main.ts provides). */
  save(): void;
  /** Start a new game (main.ts provides). */
  newGame(): void;
}

export interface IGameUI {
  /** Per-frame UI refresh + camera update. */
  update(dt: number): void;
  dispose(): void;
}
