// The Simulation: owns the World and every entity, advances time, runs the
// economy, rating and objectives, and exposes the build commands. AI lives in
// animals.ts / guests.ts / staff.ts, commands in commands.ts.

import {
  CLOSE_HOUR,
  DEFAULT_ADMISSION,
  ENTRANCE_TILE,
  GAME_MINUTES_PER_SECOND,
  MAP_H,
  MAP_W,
  MINUTES_PER_DAY,
  OPEN_HOUR,
  START_MINUTE,
  START_MONEY,
  TILE,
} from '../core/constants';
import {
  SPEED_MULTIPLIERS,
  type GoalProgress,
  type HabitatReport,
  type ISimulation,
  type NewGameOptions,
  type RunningCostEstimate,
  type SimMessage,
  type SimSave,
  type SimSpeed,
  type SpeciesSuitability,
  type SuitabilityOptions,
  type ZooStats,
} from '../core/contracts';
import type { EventBus, GameEvents, NotifyKind, TileRect } from '../core/events';
import { fmtMoney } from '../core/format';
import {
  TERRAIN_COUNT,
  Terrain,
  type CommandResult,
  type LedgerEntry,
  type Litter,
  type Objective,
  type PathType,
  type PlacedObject,
  type ServiceDayStats,
  type StaffDayStats,
  type StaffRole,
} from '../core/types';
import { World, type EdgeRef, type WorldSave } from '../core/world';
import { BLOCKED_VIEW, FENCES_BY_ID, fencesFor } from '../data/fences';
import { OBJECTS_BY_ID } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import { AnimalSystem, dailyFoodCost } from './animals';
import { Commands, staffWage, terrainCost } from './commands';
import { EnclosureMemory, type OpenEnclosureSave } from './enclosures';
import { buildHabitatTiles, evaluateSpecies, type HabitatPopulation, type HabitatTiles, type SpeciesEval } from './habitat';
import { GuestSystem } from './guests';
import { N_TILES, PathNav, TileSearch } from './nav';
import { Progress, createObjectives, type ProgressSave } from './progress';
import { packRows, rleDecode, rleEncode, unpackRows, type PackedRows } from './savepack';
import { SimRng } from './rng';
import { StaffSystem } from './staff';
import { serviceOf } from './queues';
import { emptyStaffDay, type AnimalSim, type GuestSim, type HabitatRuntime, type ServiceTally, type StaffSim } from './state';

/** Largest simulated step (scaled seconds). Larger frames are sub-stepped. */
export const MAX_STEP = 0.1;
export const MAX_LITTER = 450;
const SAVE_VERSION = 1;
/** Guest satisfaction a new zoo starts with (it then follows departing guests' happiness). */
const START_SATISFACTION = 0.5;
/** Messages kept for the Messages log (and in saves). */
const MESSAGE_LOG_SIZE = 50;

export type IncomeKind = 'admissions' | 'shopIncome' | 'donations' | 'other';
export type ExpenseKind = 'upkeep' | 'food' | 'salaries' | 'construction' | 'animalPurchases';

export function emptyLedger(day: number): LedgerEntry {
  return {
    day,
    income: 0,
    expenses: 0,
    admissions: 0,
    shopIncome: 0,
    donations: 0,
    other: 0,
    upkeep: 0,
    food: 0,
    salaries: 0,
    construction: 0,
    animalPurchases: 0,
  };
}

interface SimSaveData extends SimSave {
  /** World state; in compact saves its grids and objects live in worldGrids / worldObjects. */
  world: WorldSave;
  /** Run-length encoded world grids (compact saves). */
  worldGrids?: { terrain: number[]; path: number[]; hFence: number[]; vFence: number[] };
  worldObjects?: PackedRows;
  money: number;
  admissionPrice: number;
  day: number;
  minuteOfDay: number;
  speed: SimSpeed;
  rating: number;
  objectives: Objective[];
  ledger: LedgerEntry[];
  today: LedgerEntry;
  /** Entity lists: column-keyed rows (compact saves) or plain arrays (older saves). */
  animals: AnimalSim[] | PackedRows;
  guests: GuestSim[] | PackedRows;
  staff: StaffSim[] | PackedRows;
  litter: Litter[] | PackedRows;
  habitats: HabitatRuntime[];
  /** Old saves only (before WorldSave.habitatRle): habitat id → one tile inside it. */
  habitatIds?: [number, number][];
  nextIds: { animal: number; guest: number; staff: number; litter: number };
  rng: number;
  time: number;
  slowAcc: number;
  spawnAcc: number;
  hourAcc: number;
  crowdAcc: number;
  guestsToday: number;
  totalVisitors: number;
  satisfaction: number;
  progress: ProgressSave;
  debtWarned: boolean;
  /** Habitats whose fence is open (remembered so re-closing restores them). */
  openEnclosures?: OpenEnclosureSave[];
  /** Objects with an id up to this came free with the starter map. */
  starterObjectMaxId?: number;
  /** Run-length encoded starterPath mask. */
  starterPath?: number[];
  /** Today's shop / restroom tallies by object id (older saves: none). */
  serviceDay?: [number, ServiceTally][];
  /** People turned away today because the zoo was full (older saves: none). */
  turnedAwayToday?: number;
  /** The latest messages, oldest first (older saves: none). */
  messages?: SimMessage[];
  /** When each recent notification key was last shown (sim time), so an ongoing problem stays quiet after Continue (older saves: none). */
  notifyLast?: [string, number][];
}

/** Notification throttles older than this (sim seconds, two game days) can no longer silence or demote a message, so saves leave them out. */
const NOTIFY_MEMORY = (2 * MINUTES_PER_DAY) / GAME_MINUTES_PER_SECOND;

export class Simulation implements ISimulation {
  readonly world: World;
  readonly events: EventBus;
  readonly animals = new Map<number, AnimalSim>();
  readonly guests = new Map<number, GuestSim>();
  readonly staff = new Map<number, StaffSim>();
  readonly litter = new Map<number, Litter>();

  money = START_MONEY;
  admissionPrice = DEFAULT_ADMISSION;
  day = 1;
  minuteOfDay = START_MINUTE;
  speed: SimSpeed = 1;
  rating = 30;
  objectives: Objective[] = createObjectives();
  ledger: LedgerEntry[] = [];
  today: LedgerEntry = emptyLedger(1);
  /** Today's figures per shop / restroom, by object id (cleared at midnight). */
  serviceDay = new Map<number, ServiceTally>();

  // ---- internal state (serialized)
  rng: SimRng;
  /** Total simulated (scaled) seconds. */
  time = 0;
  slowAcc = 0;
  spawnAcc = 0;
  hourAcc = 0;
  /** Accumulator for the 30 Hz crowd separation pass. */
  crowdAcc = 0;
  guestsToday = 0;
  /** People turned away today because the zoo was full. */
  turnedAwayToday = 0;
  totalVisitors = 0;
  /** Smoothed happiness of departing guests (0..1). */
  satisfaction = START_SATISFACTION;
  nextIds = { animal: 1, guest: 1, staff: 1, litter: 1 };
  readonly habRt = new Map<number, HabitatRuntime>();
  debtWarned = false;
  /**
   * Scenery the starter map came with is free, so removing it refunds nothing:
   * objects with an id up to this one, and path tiles marked in `starterPath`.
   */
  starterObjectMaxId = 0;
  readonly starterPath = new Uint8Array(N_TILES);

  // ---- subsystems
  readonly nav: PathNav;
  readonly search = new TileSearch();
  readonly animalSys: AnimalSystem;
  readonly guestSys: GuestSystem;
  readonly staffSys: StaffSystem;
  readonly cmd: Commands;
  readonly progress: Progress;
  readonly enclosures: EnclosureMemory;

  // ---- derived caches (never serialized; rebuilt from state on demand)
  private evalCache = new Map<number, Map<string, SpeciesEval>>();
  private popCache = new Map<number, HabitatPopulation>();
  private tilesCache = new Map<number, HabitatTiles>();
  private evalDirty = true;
  private tilesDirty = true;
  private habSyncDirty = true;
  /** Scenery appeal around each tile (for guests). */
  readonly scenery = new Float32Array(N_TILES);
  /** 1 where a litter bin is within reach of the tile. */
  readonly binNear = new Uint8Array(N_TILES);
  /** 1 where an info board is near the tile. */
  readonly infoNear = new Uint8Array(N_TILES);
  private sceneryRev = -1;
  /** 1 where a solid object stands (animals can't enter). */
  private readonly solid = new Uint8Array(N_TILES);
  private solidRev = -1;
  /** Litter items per tile. */
  readonly litterGrid = new Uint16Array(N_TILES);
  /** Dung count per habitat id (refreshed each slow tick). */
  readonly dungByHab = new Map<number, number>();
  private notifyLast = new Map<string, number>();
  /** The latest notify events, oldest first (see messages()). */
  private messageLog: SimMessage[] = [];
  private pendingDelta = 0;
  private pendingNewSeed: number | undefined;
  /** Set while load / newGame replace the world (habitats are not "changed" then, but new). */
  private replacingWorld = false;
  private offs: (() => void)[] = [];

  constructor(events: EventBus, seed?: number) {
    this.events = events;
    const s = seed ?? ((Math.random() * 0x7fffffff) | 0);
    this.pendingNewSeed = seed;
    this.world = new World(events, s);
    this.rng = new SimRng(s ^ 0x5bd1e995);
    this.nav = new PathNav(this.world, events);
    this.animalSys = new AnimalSystem(this);
    this.guestSys = new GuestSystem(this);
    this.staffSys = new StaffSystem(this);
    this.cmd = new Commands(this);
    this.progress = new Progress(this);
    this.enclosures = new EnclosureMemory(this);
    const dirtyAll = () => {
      this.evalDirty = true;
      this.tilesDirty = true;
      this.habSyncDirty = true;
    };
    this.offs.push(
      events.on('habitatsChanged', dirtyAll),
      events.on('terrainChanged', dirtyAll),
      events.on('objectAdded', dirtyAll),
      events.on('objectRemoved', dirtyAll),
      events.on('fenceChanged', dirtyAll),
      events.on('worldReset', dirtyAll),
      events.on('habitatsChanged', () => {
        if (!this.replacingWorld) this.enclosures.onHabitatsChanged();
      }),
      events.on('notify', (n) => this.recordMessage(n)),
    );
  }

  // =================================================================== time
  isOpen(): boolean {
    return this.minuteOfDay >= OPEN_HOUR * 60 && this.minuteOfDay < CLOSE_HOUR * 60;
  }
  /** Hours of darkness when most animals sleep. */
  isNight(): boolean {
    return this.minuteOfDay < 6 * 60 || this.minuteOfDay >= 21 * 60;
  }

  setSpeed(speed: SimSpeed): void {
    const s = Math.max(0, Math.min(3, Math.round(speed))) as SimSpeed;
    this.speed = s;
  }

  setAdmission(price: number): void {
    if (!Number.isFinite(price)) return;
    this.admissionPrice = Math.max(0, Math.min(200, Math.round(price)));
  }

  update(realDt: number): void {
    if (realDt > 0 && Number.isFinite(realDt)) {
      const mult = SPEED_MULTIPLIERS[this.speed] ?? 0;
      let remaining = Math.min(realDt, 0.5) * mult;
      while (remaining > 1e-9) {
        const dt = remaining > MAX_STEP ? MAX_STEP : remaining;
        this.step(dt);
        remaining -= dt;
      }
    }
    this.flushMoney();
  }

  private step(dt: number) {
    this.time += dt;
    this.minuteOfDay += dt * GAME_MINUTES_PER_SECOND;
    if (this.minuteOfDay >= MINUTES_PER_DAY) {
      this.minuteOfDay -= MINUTES_PER_DAY;
      this.endOfDay();
    }
    if (this.habSyncDirty) this.syncHabitats();
    const hours = (dt * GAME_MINUTES_PER_SECOND) / 60;
    this.animalSys.update(dt, hours);
    this.guestSys.update(dt, hours);
    this.staffSys.update(dt);
    for (const rt of this.habRt.values()) rt.sinceService += dt * GAME_MINUTES_PER_SECOND;
    this.hourAcc += hours;
    while (this.hourAcc >= 1) {
      this.hourAcc -= 1;
      this.animalSys.hourly();
    }
    this.slowAcc += dt;
    if (this.slowAcc >= 0.5) {
      this.slowAcc -= 0.5;
      this.slowTick();
    }
  }

  private slowTick() {
    // dung per habitat
    this.dungByHab.clear();
    for (const l of this.litter.values()) {
      if (l.kind !== 'dung') continue;
      const t = this.world.tileOfWorld(l.x, l.z);
      if (!this.world.inBounds(t.x, t.z)) continue;
      const h = this.world.habitatOf[this.world.idx(t.x, t.z)];
      if (h) this.dungByHab.set(h, (this.dungByHab.get(h) ?? 0) + 1);
    }
    this.animalSys.slow(0.5);
    this.progress.tick(0.5);
  }

  /** Upkeep of buildings, scenery and fences for one day. */
  private dailyUpkeep(): number {
    let upkeep = 0;
    for (const o of this.world.objects.values()) upkeep += OBJECTS_BY_ID[o.defId]?.upkeep ?? 0;
    // fences: small upkeep scaled by strength
    let fenceUpkeep = 0;
    for (let i = 0; i < this.world.hFence.length; i++) if (this.world.hFence[i]) fenceUpkeep += 0.1 * (FENCES_BY_ID[this.world.hFence[i]]?.strength ?? 1);
    for (let i = 0; i < this.world.vFence.length; i++) if (this.world.vFence[i]) fenceUpkeep += 0.1 * (FENCES_BY_ID[this.world.vFence[i]]?.strength ?? 1);
    return upkeep + Math.round(fenceUpkeep);
  }

  /** The animals' food for one day (a running cost of its own). */
  private dailyFood(): number {
    let food = 0;
    for (const a of this.animals.values()) {
      const sp = SPECIES_BY_ID[a.speciesId];
      if (sp) food += dailyFoodCost(sp, a.growth);
    }
    return food;
  }

  runningCosts(): RunningCostEstimate {
    const fraction = Math.max(0, Math.min(1, this.minuteOfDay / MINUTES_PER_DAY));
    // staff dismissed today were paid off already; the others accrue from midnight (or hiring)
    let wagesDay = this.today.salaries,
      wagesSoFar = this.today.salaries;
    for (const s of this.staff.values()) {
      wagesDay += s.salary * s.payShare;
      wagesSoFar += s.salary * Math.max(0, s.payShare - (1 - fraction));
    }
    const food = this.dailyFood(),
      upkeep = this.dailyUpkeep();
    const day = { wages: Math.round(wagesDay), food, upkeep, total: 0 };
    day.total = day.wages + food + upkeep;
    const soFar = { wages: Math.round(wagesSoFar), food: Math.round(food * fraction), upkeep: Math.round(upkeep * fraction), total: 0 };
    soFar.total = soFar.wages + soFar.food + soFar.upkeep;
    return { fraction, soFar, day };
  }

  private endOfDay() {
    const upkeep = this.dailyUpkeep();
    const food = this.dailyFood();
    let salaries = 0;
    for (const s of this.staff.values()) {
      salaries += s.salary * s.payShare;
      s.payShare = 1;
      s.today = emptyStaffDay();
    }
    this.serviceDay.clear();
    salaries = Math.round(salaries);
    if (upkeep) this.spend('upkeep', upkeep);
    if (food) this.spend('food', food);
    if (salaries) this.spend('salaries', salaries);
    const done = this.today;
    this.ledger.push(done);
    while (this.ledger.length > 30) this.ledger.shift();
    this.day++;
    this.today = emptyLedger(this.day);
    this.progress.closeDay(this.guestsToday, runningResult(done));
    const turnedAway = this.turnedAwayToday;
    this.guestsToday = 0;
    this.turnedAwayToday = 0;
    this.animalSys.daily();
    this.debtWarned = false;
    this.events.emit('dayChanged', { day: this.day });
    const summary = daySummary(done, turnedAway);
    this.notify(null, summary.text, summary.kind);
    if (this.money < 0) {
      this.notify('debt', `You are ${fmtMoney(-this.money)} in debt! Building is blocked until you earn money — raise income or sell something.`, 'bad', undefined, 0);
    }
  }

  // ================================================================ economy
  private addMoney(delta: number) {
    if (!delta) return;
    this.money += delta;
    this.pendingDelta += delta;
  }
  flushMoney() {
    if (this.pendingDelta !== 0) {
      const d = this.pendingDelta;
      this.pendingDelta = 0;
      this.events.emit('moneyChanged', { money: this.money, delta: d });
      if (this.money < 0 && !this.debtWarned) {
        this.debtWarned = true;
        this.notify('debt', 'Your zoo is in debt — purchases are blocked until the balance is positive.', 'bad', undefined, 30);
      }
    }
  }
  earn(kind: IncomeKind, amount: number, popup?: { x: number; z: number }) {
    if (!amount) return;
    this.addMoney(amount);
    this.today.income += amount;
    this.today[kind] += amount;
    if (popup) this.events.emit('moneyPopup', { x: popup.x, z: popup.z, amount });
  }
  /** Spend (positive) or refund (negative) money in an expense category. */
  spend(kind: ExpenseKind, amount: number) {
    if (!amount) return;
    this.addMoney(-amount);
    this.today.expenses += amount;
    this.today[kind] += amount;
  }
  canAfford(cost: number): boolean {
    return cost <= 0 || this.money >= cost;
  }

  // =========================================================== notifications
  /** Whether a toast with this key would be shown now (not throttled by `cooldown`). */
  canNotify(key: string, cooldown = 90): boolean {
    const last = this.notifyLast.get(key);
    return last === undefined || this.time - last >= cooldown;
  }

  /**
   * Toast for the player. `key` throttles repeats: the same key is not shown
   * again for `cooldown` simulated seconds (null = never throttled).
   */
  notify(key: string | null, text: string, kind: NotifyKind, focus?: { x: number; z: number }, cooldown = 90) {
    if (key && !this.claimNotify(key, cooldown)) return;
    this.emitNotify(text, kind, focus, false);
  }

  /**
   * A lasting problem (e.g. a flooded habitat), throttled like `notify`: a toast when it starts,
   * then log-only reminders while it lasts (a repeat within `lasting` simulated seconds of the
   * one before, two cooldowns by default).
   */
  remind(key: string, text: string, kind: NotifyKind, focus?: { x: number; z: number }, cooldown = 90, lasting = 2 * cooldown) {
    const last = this.notifyLast.get(key);
    if (!this.claimNotify(key, cooldown)) return;
    this.emitNotify(text, kind, focus, last !== undefined && this.time - last < lasting);
  }

  /** A toast the first time this zoo meets `key` (remembered in the save), log-only after that. */
  notifyFirst(key: string, text: string, kind: NotifyKind, focus?: { x: number; z: number }) {
    const seen = this.progress.announced.has(key);
    this.progress.announced.add(key);
    this.emitNotify(text, kind, focus, seen);
  }

  /** A message for the log only, no toast: something on screen already shows it. */
  logMessage(text: string, kind: NotifyKind, focus?: { x: number; z: number }) {
    this.emitNotify(text, kind, focus, true);
  }

  /** Throttle by key: false if `key` was sent less than `cooldown` simulated seconds ago. */
  private claimNotify(key: string, cooldown: number): boolean {
    if (!this.canNotify(key, cooldown)) return false;
    this.notifyLast.set(key, this.time);
    return true;
  }

  private emitNotify(text: string, kind: NotifyKind, focus: { x: number; z: number } | undefined, logOnly: boolean) {
    const n: GameEvents['notify'] = focus ? { text, kind, focus: { x: focus.x, z: focus.z } } : { text, kind };
    if (logOnly) n.logOnly = true;
    this.events.emit('notify', n);
  }

  private recordMessage(n: GameEvents['notify']) {
    const m: SimMessage = { day: this.day, minute: Math.floor(this.minuteOfDay), text: n.text, kind: n.kind };
    if (n.focus) m.focus = { x: n.focus.x, z: n.focus.z };
    if (n.logOnly) m.logOnly = true;
    this.messageLog.push(m);
    if (this.messageLog.length > MESSAGE_LOG_SIZE) this.messageLog.splice(0, this.messageLog.length - MESSAGE_LOG_SIZE);
  }

  messages(): readonly SimMessage[] {
    return this.messageLog;
  }

  // ================================================================= litter
  addLitter(kind: 'trash' | 'dung', x: number, z: number): number {
    if (this.litter.size >= MAX_LITTER) return 0;
    const t = this.world.tileOfWorld(x, z);
    if (!this.world.inBounds(t.x, t.z)) return 0;
    const id = this.nextIds.litter++;
    this.litter.set(id, { id, x, z, kind });
    this.litterGrid[this.world.idx(t.x, t.z)]++;
    this.events.emit('litterAdded', { id });
    return id;
  }
  removeLitter(id: number) {
    const l = this.litter.get(id);
    if (!l) return;
    this.litter.delete(id);
    const t = this.world.tileOfWorld(l.x, l.z);
    if (this.world.inBounds(t.x, t.z)) {
      const i = this.world.idx(t.x, t.z);
      if (this.litterGrid[i] > 0) this.litterGrid[i]--;
    }
    this.events.emit('litterRemoved', { id });
  }
  private rebuildLitterGrid() {
    this.litterGrid.fill(0);
    for (const l of this.litter.values()) {
      const t = this.world.tileOfWorld(l.x, l.z);
      if (this.world.inBounds(t.x, t.z)) this.litterGrid[this.world.idx(t.x, t.z)]++;
    }
  }

  // ============================================================ habitat caches
  markPopulationDirty() {
    this.evalDirty = true;
  }

  private syncHabitats() {
    this.habSyncDirty = false;
    for (const hab of this.world.habitats.values()) {
      let rt = this.habRt.get(hab.id);
      if (!rt) {
        rt = { id: hab.id, food: 0, sample: hab.tiles[0] ?? 0, spotX: -1, spotZ: -1, sinceService: 0 };
        this.habRt.set(hab.id, rt);
      }
      if (this.world.habitatOf[rt.sample] !== hab.id) rt.sample = hab.tiles[0] ?? 0;
    }
    for (const id of Array.from(this.habRt.keys())) if (!this.world.habitats.has(id)) this.habRt.delete(id);
  }

  habitatRuntime(id: number): HabitatRuntime | undefined {
    if (this.habSyncDirty) this.syncHabitats();
    return this.habRt.get(id);
  }

  /**
   * A habitat vanished: staff stop working on it, and animals forget it as their
   * home unless the enclosure was only opened (EnclosureMemory keeps it then).
   */
  forgetHabitat(id: number, opened: boolean) {
    for (const s of this.staff.values()) {
      if ((s.job === 'service' || s.job === 'heal') && s.jobRef === id) {
        s.job = 'none';
        s.jobRef = 0;
        s.goalKey = '';
        s.next = -1;
        s.phase = 0;
        s.timer = 0.5;
        s.task = 'Looking for work';
      }
    }
    if (!opened) for (const a of this.animals.values()) if (a.home === id) a.home = 0;
  }

  /** An opened enclosure was closed again as habitat `newId`: its animals live there now. */
  rehomeHabitat(oldId: number, newId: number) {
    for (const a of this.animals.values()) if (a.home === oldId) a.home = newId;
    this.markPopulationDirty();
  }

  /** After a load: drop references to habitats that no longer exist. */
  private dropStaleHabitatRefs() {
    for (const a of this.animals.values()) {
      if (a.home && !this.world.habitats.has(a.home) && !this.enclosures.find(a.home)) a.home = 0;
    }
    for (const s of this.staff.values()) {
      if ((s.job === 'service' || s.job === 'heal') && !this.world.habitats.has(s.jobRef)) this.forgetHabitat(s.jobRef, true);
    }
  }

  private refreshPopulations() {
    this.popCache.clear();
    for (const hab of this.world.habitats.values()) this.popCache.set(hab.id, { count: new Map(), weight: new Map() });
    for (const a of this.animals.values()) {
      if (a.escaped || a.habitatId === null) continue;
      const p = this.popCache.get(a.habitatId);
      if (!p) continue;
      p.count.set(a.speciesId, (p.count.get(a.speciesId) ?? 0) + 1);
      p.weight.set(a.speciesId, (p.weight.get(a.speciesId) ?? 0) + (a.growth >= 1 ? 1 : 0.5));
    }
  }

  population(habId: number): HabitatPopulation {
    if (this.evalDirty) this.cleanEval();
    return this.popCache.get(habId) ?? { count: new Map(), weight: new Map() };
  }

  private cleanEval() {
    this.evalDirty = false;
    this.evalCache.clear();
    this.refreshPopulations();
  }

  /**
   * How much an animal counts towards the collection (rating, the zoo's draw): animals
   * packed past what their habitat holds count only for the room there is.
   */
  collectionWeight(a: AnimalSim): number {
    if (a.escaped || !a.habitatId) return 1;
    return this.evalFor(a.habitatId, a.speciesId)?.space ?? 1;
  }

  keeperCount(): number {
    let n = 0;
    for (const s of this.staff.values()) if (s.role === 'keeper') n++;
    return n;
  }

  /** Cached suitability of a species in a habitat for its current population. */
  evalFor(habId: number, speciesId: string): SpeciesEval | null {
    if (this.evalDirty) this.cleanEval();
    let m = this.evalCache.get(habId);
    if (!m) {
      m = new Map();
      this.evalCache.set(habId, m);
    }
    let e = m.get(speciesId);
    if (e) return e;
    const hab = this.world.habitats.get(habId);
    const sp = SPECIES_BY_ID[speciesId];
    if (!hab || !sp) return null;
    e = evaluateSpecies(this.world, hab, sp, this.popCache.get(habId) ?? { count: new Map(), weight: new Map() }, this.keeperCount(), false);
    m.set(speciesId, e);
    return e;
  }

  habitatTiles(habId: number): HabitatTiles | null {
    if (this.tilesDirty) {
      this.tilesDirty = false;
      this.tilesCache.clear();
    }
    let t = this.tilesCache.get(habId);
    if (t) return t;
    const hab = this.world.habitats.get(habId);
    if (!hab) return null;
    t = buildHabitatTiles(this.world, hab);
    this.tilesCache.set(habId, t);
    return t;
  }

  /** 0..1 dirtiness of a habitat from dung. */
  habitatDirt(habId: number): number {
    const hab = this.world.habitats.get(habId);
    if (!hab) return 0;
    const dung = this.dungByHab.get(habId) ?? 0;
    return Math.min(1, dung / Math.max(3, hab.tiles.length * 0.06));
  }

  /** Scenery / bins / info-sign grids for guests (rebuilt when the world changes). */
  ensureSceneryGrid() {
    if (this.sceneryRev === this.world.revision) return;
    this.sceneryRev = this.world.revision;
    const sc = this.scenery;
    sc.fill(0);
    this.binNear.fill(0);
    this.infoNear.fill(0);
    const w = this.world;
    for (const o of w.objects.values()) {
      const def = OBJECTS_BY_ID[o.defId];
      if (!def) continue;
      const c = w.objectCenter(o);
      const cx = Math.floor(c.x / TILE),
        cz = Math.floor(c.z / TILE);
      if (def.bin) this.stamp(this.binNear, cx, cz, 3);
      if (o.defId === 'info_sign') this.stamp(this.infoNear, cx, cz, 3);
      if (def.appeal <= 0) continue;
      const R = def.appeal >= 5 ? 5 : 3;
      for (let z = cz - R; z <= cz + R; z++)
        for (let x = cx - R; x <= cx + R; x++) {
          if (x < 0 || z < 0 || x >= MAP_W || z >= MAP_H) continue;
          const d = Math.hypot(x - cx, z - cz);
          if (d > R) continue;
          sc[z * MAP_W + x] += def.appeal * (1 - d / (R + 1)) * 0.5;
        }
    }
    // water features add a little appeal to the paths next to them
    for (let i = 0; i < N_TILES; i++) {
      const t = w.terrain[i];
      if ((t === Terrain.Water || t === Terrain.DeepWater) && !w.habitatOf[i]) {
        const x = i % MAP_W,
          z = (i / MAP_W) | 0;
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) if (w.inBounds(x + dx, z + dz)) sc[(z + dz) * MAP_W + x + dx] += 0.15;
      }
    }
  }
  private stamp(arr: Uint8Array, cx: number, cz: number, r: number) {
    for (let z = cz - r; z <= cz + r; z++)
      for (let x = cx - r; x <= cx + r; x++) if (x >= 0 && z >= 0 && x < MAP_W && z < MAP_H) arr[z * MAP_W + x] = 1;
  }

  /** Solid-object mask per tile (refreshed lazily when the world changes). */
  solidMask(): Uint8Array {
    if (this.solidRev !== this.world.revision) {
      this.solidRev = this.world.revision;
      const w = this.world;
      for (let i = 0; i < N_TILES; i++) {
        const oid = w.objectGrid[i];
        let v = 0;
        if (oid) {
          const o = w.objects.get(oid);
          if (o && OBJECTS_BY_ID[o.defId]?.solid) v = 1;
        }
        this.solid[i] = v;
      }
    }
    return this.solid;
  }

  /** World-space entrance (gate) tiles that are on the path. */
  gateTiles(out: number[]): number[] {
    out.length = 0;
    for (const o of this.world.objects.values()) {
      if (o.defId !== 'entrance_gate') continue;
      for (const t of this.world.footprint(o)) {
        if (!this.world.inBounds(t.x, t.z)) continue;
        const i = this.world.idx(t.x, t.z);
        if (this.world.path[i]) out.push(i);
      }
    }
    if (!out.length) {
      const i = this.world.idx(ENTRANCE_TILE.x, ENTRANCE_TILE.z);
      if (this.world.path[i]) out.push(i);
    }
    return out;
  }

  // =============================================================== commands
  paintTerrain(rect: TileRect, terrain: Terrain, dryRun = false): CommandResult {
    return this.cmd.paintTerrain(rect, terrain, dryRun);
  }
  placePaths(tiles: { x: number; z: number }[], type: PathType, dryRun = false): CommandResult {
    return this.cmd.placePaths(tiles, type, dryRun);
  }
  placeFences(edges: EdgeRef[], fenceId: number, dryRun = false): CommandResult {
    return this.cmd.placeFences(edges, fenceId, dryRun);
  }
  placeObject(defId: string, tx: number, tz: number, rot: number, dryRun = false): CommandResult {
    return this.cmd.placeObject(defId, tx, tz, rot, dryRun);
  }
  bulldoze(rect: TileRect, dryRun = false): CommandResult {
    return this.cmd.bulldoze(rect, dryRun);
  }
  removeFences(edges: EdgeRef[], dryRun = false): CommandResult {
    return this.cmd.removeFences(edges, dryRun);
  }
  removeObject(objectId: number, dryRun = false): CommandResult {
    return this.cmd.removeObject(objectId, dryRun);
  }
  renameHabitat(habitatId: number, name: string): CommandResult {
    return this.cmd.renameHabitat(habitatId, name);
  }
  staffWage(role: StaffRole): number {
    return staffWage(role);
  }
  pregnancy(animalId: number): { day: number; of: number } | null {
    const a = this.animals.get(animalId);
    return a ? this.animalSys.pregnancy(a) : null;
  }
  staffSettlement(staffId: number): number {
    return this.cmd.staffSettlement(staffId);
  }

  /** Today's tally for a shop / restroom (created on first use; cleared at midnight). */
  serviceTally(objectId: number): ServiceTally {
    let t = this.serviceDay.get(objectId);
    if (!t) {
      t = { visits: 0, sold: 0, income: 0, gaveUp: 0 };
      this.serviceDay.set(objectId, t);
    }
    return t;
  }
  serviceStats(objectId: number): ServiceDayStats | null {
    const o = this.world.objects.get(objectId);
    if (!o || !serviceOf(o.defId)) return null;
    const t = this.serviceDay.get(objectId);
    const queue = this.guestSys.queues.points.get(objectId)?.line.length ?? 0;
    return { visits: t?.visits ?? 0, sold: t?.sold ?? 0, income: t?.income ?? 0, gaveUp: t?.gaveUp ?? 0, queue };
  }
  staffStats(staffId: number): StaffDayStats | null {
    const s = this.staff.get(staffId);
    return s ? { ...s.today } : null;
  }
  terrainCost(terrain: Terrain): number {
    return terrainCost(terrain);
  }

  buyAnimal(speciesId: string, wx: number, wz: number, dryRun = false): CommandResult {
    return this.cmd.buyAnimal(speciesId, wx, wz, dryRun);
  }
  sellAnimal(animalId: number, dryRun = false): CommandResult {
    return this.cmd.sellAnimal(animalId, dryRun);
  }
  moveAnimal(animalId: number, wx: number, wz: number, dryRun = false): CommandResult {
    return this.cmd.moveAnimal(animalId, wx, wz, dryRun);
  }
  moveObject(objectId: number, tx: number, tz: number, rot: number, dryRun = false): CommandResult {
    return this.cmd.moveObject(objectId, tx, tz, rot, dryRun);
  }
  hireStaff(role: StaffRole, wx: number, wz: number, dryRun = false): CommandResult {
    return this.cmd.hireStaff(role, wx, wz, dryRun);
  }
  fireStaff(staffId: number): CommandResult {
    return this.cmd.fireStaff(staffId);
  }

  // ================================================================ queries
  private statsCache: ZooStats | null = null;
  private statsTime = -1;
  private statsSpecies = new Set<string>();
  /** Zoo statistics (cached per simulated instant, so calling it every frame is cheap). */
  stats(): ZooStats {
    const st = this.statsCache;
    if (
      st &&
      this.statsTime === this.time &&
      st.guestsInZoo === this.guests.size &&
      st.animalCount === this.animals.size &&
      st.staffCount === this.staff.size &&
      st.litterCount === this.litter.size &&
      st.guestsToday === this.guestsToday
    )
      return st;
    let ah = 0,
      gh = 0;
    const species = this.statsSpecies;
    species.clear();
    for (const a of this.animals.values()) {
      ah += a.happiness;
      species.add(a.speciesId);
    }
    for (const g of this.guests.values()) gh += g.happiness;
    // a fresh object per simulated instant (callers may keep the previous one for comparison)
    const out: ZooStats = {
      guestsInZoo: this.guests.size,
      guestsToday: this.guestsToday,
      totalVisitors: this.totalVisitors,
      animalCount: this.animals.size,
      speciesCount: species.size,
      avgAnimalHappiness: this.animals.size ? ah / this.animals.size : 0,
      avgGuestHappiness: this.guests.size ? gh / this.guests.size : this.satisfaction,
      staffCount: this.staff.size,
      litterCount: this.litter.size,
      fairAdmission: Math.round(this.guestSys.fairPrice),
      guestCapacity: this.guestSys.capacity,
      full: this.guestSys.full(),
      turnedAwayToday: Math.round(this.turnedAwayToday),
      gateClosed: this.guestSys.gateNote(),
    };
    this.statsCache = out;
    this.statsTime = this.time;
    return out;
  }

  /**
   * Adopt / move preview: how the habitat would suit the species with the newcomer living
   * there. `opts.animalId` is an animal being moved: it is already counted when it lives in
   * this habitat, so the preview then adds no one.
   */
  suitability(speciesId: string, habitatId: number, opts?: SuitabilityOptions): SpeciesSuitability {
    const sp = SPECIES_BY_ID[speciesId];
    const hab = this.world.habitats.get(habitatId);
    if (!sp || !hab) {
      return {
        speciesId,
        score: 0,
        terrain: 0,
        foliage: 0,
        space: 0,
        crowded: 'no',
        fenceOk: false,
        hasWater: false,
        hasFood: false,
        issues: [!sp ? 'Unknown species' : 'Not a habitat — enclose an area with fences first'],
      };
    }
    const mover = opts?.animalId !== undefined ? this.animals.get(opts.animalId) : undefined;
    const adding = !mover || mover.escaped || mover.habitatId !== habitatId;
    const e = evaluateSpecies(this.world, hab, sp, this.population(habitatId), this.keeperCount(), adding);
    return this.describeSuitability(e, habitatId);
  }

  objectiveProgress(objectiveId: string): GoalProgress | null {
    return this.progress.goalProgress(objectiveId);
  }

  /** How the habitat suits the animals of a species already living there (habitat report). */
  private residentSuitability(speciesId: string, habitatId: number): SpeciesSuitability {
    const e = this.evalFor(habitatId, speciesId);
    return e ? this.describeSuitability(e, habitatId) : this.suitability(speciesId, habitatId);
  }

  /** Public suitability record: the evaluation plus the habitat's current upkeep problems. */
  private describeSuitability(e: SpeciesEval, habitatId: number): SpeciesSuitability {
    const hab = this.world.habitats.get(habitatId)!;
    const issues = e.issues.slice();
    const rt = this.habitatRuntime(habitatId);
    const present = (this.population(habitatId).count.get(e.speciesId) ?? 0) > 0;
    if (present && rt && rt.food < 0.5 && this.keeperCount() > 0) issues.push('Food is running out (keepers will refill it)');
    if (this.habitatDirt(habitatId) > 0.5) issues.push('Dirty — dung needs cleaning by a keeper');
    if (!hab.viewTiles.length) issues.push('Guests cannot see this habitat (build a path next to the fence)');
    else if (hab.viewQuality < BLOCKED_VIEW) {
      const better = fencesFor(SPECIES_BY_ID[e.speciesId]?.danger ?? 1).bestView;
      issues.push(`Walls block the guests’ view${better && better.visibility - hab.viewQuality >= 0.2 ? ` (${better.name} shows the animals)` : ''}`);
    }
    return {
      speciesId: e.speciesId,
      score: e.score,
      terrain: e.terrain,
      foliage: e.foliage,
      space: e.space,
      crowded: e.crowded,
      fenceOk: e.fenceOk,
      hasWater: e.hasWater,
      hasFood: e.hasFood,
      issues,
    };
  }

  habitatReport(habitatId: number): HabitatReport | null {
    const hab = this.world.habitats.get(habitatId);
    if (!hab) return null;
    const animals: number[] = [];
    const species: string[] = [];
    for (const a of this.animals.values()) {
      if (a.escaped || a.habitatId !== habitatId) continue;
      animals.push(a.id);
      if (!species.includes(a.speciesId)) species.push(a.speciesId);
    }
    const area = Math.max(1, hab.tiles.length);
    const terrainFractions: number[] = [];
    for (let t = 0; t < TERRAIN_COUNT; t++) terrainFractions.push(hab.terrainCounts[t] / area);
    return {
      habitatId,
      name: hab.name,
      area: hab.tiles.length,
      animals,
      species,
      suitability: species.map((s) => this.residentSuitability(s, habitatId)),
      terrainFractions,
      viewable: hab.viewTiles.length > 0,
    };
  }

  // ======================================================== entity helpers
  emitAnimalRemoved(id: number) {
    this.events.emit('animalRemoved', { id });
  }

  // ============================================================ persistence
  serialize(): SimSave {
    if (this.habSyncDirty) this.syncHabitats();
    const ws = this.world.serialize();
    const data: SimSaveData = {
      version: SAVE_VERSION,
      world: { ...ws, terrain: [], path: [], hFence: [], vFence: [], objects: [] },
      worldGrids: { terrain: rleEncode(ws.terrain), path: rleEncode(ws.path), hFence: rleEncode(ws.hFence), vFence: rleEncode(ws.vFence) },
      worldObjects: packRows(ws.objects),
      money: this.money,
      admissionPrice: this.admissionPrice,
      day: this.day,
      minuteOfDay: this.minuteOfDay,
      speed: this.speed,
      rating: this.rating,
      objectives: this.objectives,
      ledger: this.ledger,
      today: this.today,
      animals: packRows(Array.from(this.animals.values())),
      guests: packRows(Array.from(this.guests.values())),
      staff: packRows(Array.from(this.staff.values())),
      litter: packRows(Array.from(this.litter.values())),
      habitats: Array.from(this.habRt.values()),
      nextIds: this.nextIds,
      rng: this.rng.state,
      time: this.time,
      slowAcc: this.slowAcc,
      spawnAcc: this.spawnAcc,
      hourAcc: this.hourAcc,
      crowdAcc: this.crowdAcc,
      guestsToday: this.guestsToday,
      turnedAwayToday: this.turnedAwayToday,
      totalVisitors: this.totalVisitors,
      satisfaction: this.satisfaction,
      progress: this.progress.serialize(),
      debtWarned: this.debtWarned,
      openEnclosures: this.enclosures.serialize(),
      starterObjectMaxId: this.starterObjectMaxId,
      starterPath: rleEncode(this.starterPath),
      serviceDay: Array.from(this.serviceDay),
      messages: this.messageLog,
      notifyLast: Array.from(this.notifyLast).filter(([, t]) => this.time - t < NOTIFY_MEMORY),
    };
    // deep copy (so later simulation never mutates a save that is still being written),
    // with fractional numbers rounded to 1/1000 — positions to the millimetre — which
    // keeps the save small for localStorage.
    return JSON.parse(JSON.stringify(data, roundFloats)) as SimSave;
  }

  load(save: SimSave): void {
    if (!save || save.version !== SAVE_VERSION) throw new Error('Unsupported save version');
    const s = JSON.parse(JSON.stringify(save)) as SimSaveData;
    if (!s.world || !Array.isArray(s.world.terrain)) throw new Error('Corrupt save: missing world');
    if (s.worldGrids) {
      const g = s.worldGrids;
      s.world.terrain = rleDecode(g.terrain, MAP_W * MAP_H);
      s.world.path = rleDecode(g.path, MAP_W * MAP_H);
      s.world.hFence = rleDecode(g.hFence, MAP_W * (MAP_H + 1));
      s.world.vFence = rleDecode(g.vFence, (MAP_W + 1) * MAP_H);
    }
    if (s.worldObjects) s.world.objects = unpackRows<PlacedObject>(s.worldObjects);

    // entities first so listeners of worldReset (emitted by World.load) see the new state
    this.animals.clear();
    this.guests.clear();
    this.staff.clear();
    this.litter.clear();
    for (const a of unpackRows<AnimalSim>(s.animals)) this.animals.set(a.id, upgradeAnimal(a));
    for (const g of unpackRows<GuestSim>(s.guests)) this.guests.set(g.id, upgradeGuest(g));
    for (const st of unpackRows<StaffSim>(s.staff)) this.staff.set(st.id, upgradeStaff(st));
    for (const l of unpackRows<Litter>(s.litter)) this.litter.set(l.id, l);

    this.money = s.money;
    this.admissionPrice = s.admissionPrice;
    this.day = s.day;
    this.minuteOfDay = s.minuteOfDay;
    this.speed = s.speed;
    this.rating = s.rating;
    this.objectives = mergeObjectives(s.objectives ?? []);
    const newGoals = this.objectives.filter((o) => !(s.objectives ?? []).some((so) => so.id === o.id)).map((o) => o.id);
    // older saves have no 'food' field (food was booked under upkeep)
    this.ledger = (s.ledger ?? []).map((e) => upgradeLedger({ ...emptyLedger(e.day), ...e }));
    this.today = upgradeLedger({ ...emptyLedger(this.day), ...(s.today ?? {}) });
    this.habRt.clear();
    for (const h of s.habitats ?? []) this.habRt.set(h.id, h);
    this.nextIds = s.nextIds;
    this.rng.state = s.rng >>> 0;
    this.time = s.time ?? 0;
    this.slowAcc = s.slowAcc ?? 0;
    this.spawnAcc = s.spawnAcc ?? 0;
    this.hourAcc = s.hourAcc ?? 0;
    this.crowdAcc = s.crowdAcc ?? 0;
    this.guestsToday = s.guestsToday ?? 0;
    this.turnedAwayToday = s.turnedAwayToday ?? 0;
    this.totalVisitors = s.totalVisitors ?? 0;
    this.satisfaction = s.satisfaction ?? START_SATISFACTION;
    this.progress.load(s.progress ?? {}, Math.max(0, ...this.ledger.map(runningResult)));
    // before the world: the UI rebuilds its Messages log from these on worldReset
    this.messageLog = (s.messages ?? []).slice(-MESSAGE_LOG_SIZE);
    if (!s.progress?.bredSpecies) this.progress.recallBredSpecies(this.messageLog);
    this.debtWarned = s.debtWarned ?? false;
    // older saves did not track free starter scenery: everything counts as bought
    this.starterObjectMaxId = s.starterObjectMaxId ?? 0;
    this.starterPath.set(s.starterPath ? rleDecode(s.starterPath, N_TILES) : new Array<number>(N_TILES).fill(0));
    this.serviceDay = new Map(s.serviceDay ?? []);
    this.cmd.resetBuildLog();
    this.pendingDelta = 0;
    this.resetCaches();
    // Saves written before the world persisted habitat ids carry one sample tile per
    // habitat: seed the labelling with those so World.load keeps the old ids.
    if (!s.world.habitatRle && Array.isArray(s.habitatIds) && s.habitatIds.length) s.world.habitatRle = seedHabitatRle(s.habitatIds);
    // the world last: World.load emits worldReset, by which time every other piece of state is in place
    this.replacingWorld = true;
    try {
      this.world.load(s.world);
    } finally {
      this.replacingWorld = false;
    }
    this.enclosures.reset(s.openEnclosures ?? []);
    this.dropStaleHabitatRefs();
    this.resetCaches();
    for (const [key, t] of s.notifyLast ?? []) if (typeof key === 'string' && Number.isFinite(t)) this.notifyLast.set(key, t);
    this.guestSys.afterLoad();
    if ((s.objectives ?? []).length) this.progress.settleNewGoals(newGoals);
    this.events.emit('moneyChanged', { money: this.money, delta: 0 });
  }

  private resetCaches() {
    this.evalDirty = true;
    this.tilesDirty = true;
    this.habSyncDirty = true;
    this.sceneryRev = -1;
    this.notifyLast.clear();
    this.nav.markDirty();
    this.rebuildLitterGrid();
    this.dungByHab.clear();
    this.slowTickDungOnly();
  }
  private slowTickDungOnly() {
    for (const l of this.litter.values()) {
      if (l.kind !== 'dung') continue;
      const t = this.world.tileOfWorld(l.x, l.z);
      if (!this.world.inBounds(t.x, t.z)) continue;
      const h = this.world.habitatOf[this.world.idx(t.x, t.z)];
      if (h) this.dungByHab.set(h, (this.dungByHab.get(h) ?? 0) + 1);
    }
  }

  newGame(seed?: number, opts: NewGameOptions = {}): void {
    const s = seed ?? this.pendingNewSeed ?? ((Math.random() * 0x7fffffff) | 0);
    this.pendingNewSeed = undefined;
    this.animals.clear();
    this.guests.clear();
    this.staff.clear();
    this.litter.clear();
    this.habRt.clear();
    // reset the world to a blank map, then lay out the starter zoo
    const blank: WorldSave = {
      version: 1,
      seed: s,
      terrain: new Array(MAP_W * MAP_H).fill(Terrain.Grass),
      path: new Array(MAP_W * MAP_H).fill(0),
      hFence: new Array(MAP_W * (MAP_H + 1)).fill(0),
      vFence: new Array((MAP_W + 1) * MAP_H).fill(0),
      objects: [],
      nextObjectId: 1,
      habitatNames: {},
    };
    this.money = START_MONEY;
    this.admissionPrice = DEFAULT_ADMISSION;
    this.day = 1;
    this.minuteOfDay = opts.startMinute ?? START_MINUTE;
    this.speed = 1;
    this.objectives = createObjectives();
    this.ledger = [];
    this.today = emptyLedger(1);
    this.serviceDay.clear();
    this.cmd.resetBuildLog();
    this.rng = new SimRng(s ^ 0x5bd1e995);
    this.time = 0;
    this.slowAcc = 0;
    this.spawnAcc = 0;
    this.hourAcc = 0;
    this.crowdAcc = 0;
    this.guestsToday = 0;
    this.turnedAwayToday = 0;
    this.totalVisitors = 0;
    this.satisfaction = START_SATISFACTION;
    this.messageLog = [];
    this.nextIds = { animal: 1, guest: 1, staff: 1, litter: 1 };
    this.debtWarned = false;
    this.progress.reset();
    this.pendingDelta = 0;
    this.resetCaches();
    this.replacingWorld = true;
    try {
      this.world.load(blank);
      this.world.generateStarterMap(); // emits worldReset
    } finally {
      this.replacingWorld = false;
    }
    this.enclosures.reset();
    let starterMax = 0;
    for (const id of this.world.objects.keys()) starterMax = Math.max(starterMax, id);
    this.starterObjectMaxId = starterMax;
    for (let i = 0; i < N_TILES; i++) this.starterPath[i] = this.world.path[i] ? 1 : 0;
    this.resetCaches();
    this.guestSys.afterLoad();
    this.rating = this.progress.targetRating();
    this.events.emit('moneyChanged', { money: this.money, delta: 0 });
  }

  dispose() {
    this.offs.forEach((f) => f());
    this.nav.dispose();
  }
}

/** The day's running result: tickets, shops and donations less wages, food and upkeep. */
export function runningResult(d: LedgerEntry): number {
  return d.admissions + d.shopIncome + d.donations - (d.salaries + d.food + d.upkeep);
}

/**
 * End-of-day message. One-off items (building, animals, goal rewards, sales and refunds)
 * are reported apart from the day's running result, and only a running loss is a
 * warning: a day of building is an investment, and a reward is not everyday income.
 * `turnedAway`: visitors a full zoo sent away that day (the day's 'Zoo full' notes only go
 * to the log, so the final count is given here).
 */
export function daySummary(d: LedgerEntry, turnedAway = 0): { text: string; kind: NotifyKind } {
  const net = d.income - d.expenses;
  const investment = d.construction + d.animalPurchases;
  const running = runningResult(d);
  const other = Math.round(d.other);
  const kind: NotifyKind = running < 0 ? 'warn' : 'info';
  const away = Math.round(turnedAway);
  // (a no-break space keeps 'zoo full' together when the toast wraps)
  const full = away > 0 ? ` — zoo\u00a0full, ${away} ${away === 1 ? 'visitor' : 'visitors'} turned away` : '';
  if (investment === 0 && other === 0) {
    return {
      text: `Day ${d.day} closed: ${fmtMoney(net, { sign: true })} (income ${fmtMoney(d.income)}, running costs ${fmtMoney(d.expenses)})${full}`,
      kind,
    };
  }
  const parts: string[] = [];
  if (investment !== 0) {
    const what = [d.construction !== 0 && 'building', d.animalPurchases !== 0 && 'animals'].filter(Boolean).join(' and ');
    parts.push(`${what} ${fmtMoney(investment)}`);
  }
  parts.push(`daily running ${fmtMoney(running, { sign: true })}`);
  if (other !== 0) parts.push(`rewards & refunds ${fmtMoney(other, { sign: true })}`);
  return { text: `Day ${d.day} closed: ${fmtMoney(net, { sign: true })} (${parts.join('; ')})${full}`, kind };
}

/** JSON replacer: fractional numbers rounded to 3 decimals (integers, strings untouched). */
function roundFloats(_key: string, v: unknown): unknown {
  return typeof v === 'number' && !Number.isInteger(v) && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v;
}

/** Run-length habitat labelling with only the given sample tiles set ([id, count, ...]). */
function seedHabitatRle(ids: [number, number][]): number[] {
  const lab = new Int32Array(N_TILES);
  for (const [id, tile] of ids) if (tile >= 0 && tile < N_TILES && id > 0) lab[tile] = id;
  const out: number[] = [];
  for (let i = 0; i < N_TILES; ) {
    const v = lab[i];
    let n = 1;
    while (i + n < N_TILES && lab[i + n] === v) n++;
    out.push(v, n);
    i += n;
  }
  return out;
}

/** Fill in animal fields added after a save was written. */
function upgradeAnimal(a: AnimalSim): AnimalSim {
  const d = a as Partial<AnimalSim>;
  d.homeTile ??= a.escaped || !a.habitatId ? -1 : Math.floor(a.z / TILE) * MAP_W + Math.floor(a.x / TILE);
  d.bestDist ??= -1;
  return a;
}

/** Older saves booked rewards, sales and refunds only in `income`: recover them from it. */
function upgradeLedger(e: LedgerEntry): LedgerEntry {
  if (!e.other) e.other = Math.round(e.income - e.admissions - e.shopIncome - e.donations);
  return e;
}

/** Fill in staff fields added after a save was written. */
function upgradeStaff(s: StaffSim): StaffSim {
  const d = s as Partial<StaffSim>;
  d.payShare ??= 1;
  d.today = { ...emptyStaffDay(), ...d.today };
  return s;
}

/** Fill in guest fields added after a save was written. */
function upgradeGuest(g: GuestSim): GuestSim {
  const d = g as Partial<GuestSim>;
  d.qObj ??= 0;
  d.qPos ??= -1;
  d.qWait ??= 0;
  d.leader ??= 0;
  d.party ??= [];
  d.fstate ??= 0;
  d.avoidObj ??= 0;
  d.avoidUntil ??= 0;
  d.plan ??= 0;
  d.ticketValue ??= 0;
  d.paid ??= 0;
  d.wants ??= 0;
  d.route ??= [];
  return g;
}

/** Keep saved objective progress but pick up new objectives added in later versions. */
function mergeObjectives(saved: Objective[]): Objective[] {
  const fresh = createObjectives();
  const byId = new Map(saved.map((o) => [o.id, o]));
  return fresh.map((o) => ({ ...o, done: byId.get(o.id)?.done ?? false }));
}
