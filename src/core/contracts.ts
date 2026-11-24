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
import type { EventBus, NotifyKind, TileRect } from './events';
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
  ServiceDayStats,
  StaffDayStats,
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

export interface SuitabilityOptions {
  /** The animal being moved (Move tool): counted as a newcomer only if it lives in another habitat. */
  animalId?: number;
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
  /** Ticket price guests currently think is fair for this zoo. */
  fairAdmission: number;
  /** Guests the zoo holds at once (grows with paths and habitats); arrivals wait while it is full. */
  guestCapacity: number;
  /** People turned away today because the zoo was full. */
  turnedAwayToday: number;
  /** Why the gate lets nobody in right now (no animals on view, the entrance path cut), or null. */
  gateClosed: string | null;
}

/** A message the simulation sent (a `notify` event), kept in the save for the Messages log. */
export interface SimMessage {
  day: number;
  /** Game minute of the day it was sent. */
  minute: number;
  text: string;
  kind: NotifyKind;
  focus?: { x: number; z: number };
  logOnly?: boolean;
}

/** How far along a goal is, e.g. 141 of 150 guests (best day so far for the guest goals). */
export interface GoalProgress {
  current: number;
  target: number;
}

/** Wages, animal food and upkeep: booked at midnight, accruing through the day. */
export interface RunningCostEstimate {
  /** Share of the day gone since midnight (0..1). */
  fraction: number;
  /** Costs incurred so far today (pro rata; wages of staff dismissed today in full). */
  soFar: { wages: number; food: number; upkeep: number; total: number };
  /** What midnight will book for the whole day at the current staff, animals and buildings. */
  day: { wages: number; food: number; upkeep: number; total: number };
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
  /** Remove one placed object (partial refund). Fences and paths are untouched. */
  removeObject(objectId: number, dryRun?: boolean): CommandResult;
  /** Rename a habitat (trimmed, max ~32 chars). */
  renameHabitat(habitatId: number, name: string): CommandResult;
  /** Adopt an animal at a world position; must be inside a habitat. */
  buyAnimal(speciesId: string, wx: number, wz: number, dryRun?: boolean): CommandResult;
  /** Rehome an animal to another zoo for part of its price (dryRun: what it would fetch). */
  sellAnimal(animalId: number, dryRun?: boolean): CommandResult;
  /**
   * Carry an animal to a spot inside a habitat (its own or another one), free of charge.
   * Same spot rules and warnings as buyAnimal; escaped animals have to be caught first.
   */
  moveAnimal(animalId: number, wx: number, wz: number, dryRun?: boolean): CommandResult;
  /**
   * Move and/or turn a placed object, free of charge, with the same rules as placeObject
   * (its current spot does not block the new one). The object keeps its id.
   */
  moveObject(objectId: number, tx: number, tz: number, rot: number, dryRun?: boolean): CommandResult;
  hireStaff(role: StaffRole, wx: number, wz: number, dryRun?: boolean): CommandResult;
  /** Dismiss a staff member; `cost` is the wage paid for the part of today they worked. */
  fireStaff(staffId: number): CommandResult;
  setAdmission(price: number): void;
  setSpeed(speed: SimSpeed): void;

  // ---- queries
  /** Daily wage of a staff role, paid at day end (on the hiring day only for the hours left). */
  staffWage(role: StaffRole): number;
  /** Wage a staff member has earned so far today: what dismissing them now costs. */
  staffSettlement(staffId: number): number;
  /** Today's sales / visits and current line of a shop or restroom (null for other objects). */
  serviceStats(objectId: number): ServiceDayStats | null;
  /** What a staff member has done today (null if no such staff member). */
  staffStats(staffId: number): StaffDayStats | null;
  /** Price to repaint one tile with this terrain type. */
  terrainCost(terrain: Terrain): number;
  habitatReport(habitatId: number): HabitatReport | null;
  /** How far along an expecting animal is ("Expecting · day 3 of 4"); null when it is not. */
  pregnancy(animalId: number): { day: number; of: number } | null;
  /** How well a habitat suits a species with one more of it there (adopt / move preview). */
  suitability(speciesId: string, habitatId: number, opts?: SuitabilityOptions): SpeciesSuitability;
  /** Progress towards an objective (null for one-step goals such as "build restrooms"). */
  objectiveProgress(objectiveId: string): GoalProgress | null;
  /** Today's running costs so far and for the whole day (they are booked at midnight). */
  runningCosts(): RunningCostEstimate;
  /** The latest messages (oldest first, up to ~50), kept in saves so the Messages log survives Continue. */
  messages(): readonly SimMessage[];

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
  /**
   * HDR post chain (night bloom) enabled. Colour grading is part of tone
   * mapping on every tier; there is no screen-space AO.
   */
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
   * Snap exposure adaptation and the sky environment map to the current time
   * of day (after loading a save or jumping the clock).
   */
  settle(): void;
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
  /**
   * Current level of detail chosen by the factory each frame (0 = full mesh,
   * higher = coarser, -1 / undefined = unknown or not batched). Views use it to
   * animate distant creatures at a lower rate.
   */
  readonly lod?: number;
  update(dt: number, anim: CreatureAnim): void;
  /** Change age scaling (0..1 = baby..adult). */
  setGrowth(growth: number): void;
  setHighlighted(on: boolean): void;
  dispose(): void;
}

export interface ICreatureFactory {
  /**
   * Scene-level group the factory may use for batched / instanced crowd
   * rendering (main.ts adds it to the scene). May stay empty.
   */
  readonly root: THREE.Object3D;
  /**
   * Called once per frame after all CreatureModel.update calls: pick LODs from
   * the camera distance, flush instance buffers, decide shadow casting.
   */
  update(camera: THREE.Camera): void;
  /** Apply a new quality tier to models created from now on (and LOD distances). */
  setQuality(quality: QualitySettings): void;
  /**
   * Optional: resolves once every live model uses the meshes of the tier last given to
   * setQuality (they are rebuilt over several frames). The UI shows "Applying graphics
   * settings…" until then.
   */
  whenQualityApplied?(): Promise<void>;
  /** Build (and cache) the meshes for these species up front. */
  preload(speciesIds: string[], onProgress?: (fraction: number) => void): Promise<void>;
  /**
   * Optional: build every level of detail for the meshes created so far
   * (loading screen), so the first frames don't draw full meshes everywhere.
   */
  warmLods?(onProgress?: (fraction: number) => void): Promise<void>;
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
  /** Apply a new quality tier (detail distances, shadows, LOD, light count). */
  setQuality(quality: QualitySettings): void;
  /**
   * Build what the current world draws ahead of time — foliage atlases (painted in a worker), the templates of the object types in use and the fence styles in use — in short main-thread tasks, then add the world's objects. Other types are built on first use (thumbnail / ghost / placement). Called during the loading screen; without it the world is added on the first update().
   */
  prewarm(onProgress?: (fraction: number) => void): Promise<void>;
  dispose(): void;
}

/**
 * Ownership of models returned by createObjectModel / createFenceSegmentModel:
 * geometry is shared with the layer's templates and must NOT be disposed;
 * the clone's own materials are listed in `object.userData.ownedMaterials`
 * (THREE.Material[]) and the caller disposes exactly those when done.
 */

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
// Audio (src/audio)
// ===========================================================================

export interface IAudio {
  /**
   * Per frame: ambient beds (birds, wind, crowd murmur scaled by nearby guests,
   * night insects), positional animal calls near the camera focus.
   */
  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3): void;
  /** Short UI / feedback sounds. */
  play(cue: 'tap' | 'build' | 'bulldoze' | 'cash' | 'error' | 'select' | 'open' | 'close' | 'celebrate'): void;
  setEnabled(on: boolean): void;
  readonly enabled: boolean;
  /** Must be called from a user gesture on mobile to unlock the AudioContext. */
  resume(): void;
  /** Pause everything (app backgrounded). */
  suspend(): void;
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
  audio: IAudio;
  /** Persist the game: 'saved', or why not ('showcase' zoo; 'kept' = an unreadable old save is being kept; 'failed' = main already told the player). */
  save(): 'saved' | 'showcase' | 'kept' | 'failed';
  /** Start a new game (main.ts provides). */
  newGame(): void;
}

export interface IGameUI {
  /** Per-frame UI refresh + camera update. */
  update(dt: number): void;
  /** Ground point the camera orbits (for audio / focus). */
  readonly focus: THREE.Vector3;
  /**
   * Android back button: close the top-most panel / cancel the active tool.
   * Returns false when nothing was open (main then offers to exit the app).
   */
  handleBack(): boolean;
  dispose(): void;
}
