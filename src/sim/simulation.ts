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
  type HabitatReport,
  type ISimulation,
  type SimSave,
  type SimSpeed,
  type SpeciesSuitability,
  type ZooStats,
} from '../core/contracts';
import type { EventBus, NotifyKind, TileRect } from '../core/events';
import { TERRAIN_COUNT, Terrain, type CommandResult, type LedgerEntry, type Litter, type Objective, type PathType, type StaffRole } from '../core/types';
import { World, type EdgeRef, type WorldSave } from '../core/world';
import { FENCES_BY_ID } from '../data/fences';
import { OBJECTS_BY_ID } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import { AnimalSystem } from './animals';
import { Commands, TERRAIN_COST_LAND, TERRAIN_COST_WATER } from './commands';
import { STAFF_SALARY } from './names';
import { buildHabitatTiles, evaluateSpecies, type HabitatPopulation, type HabitatTiles, type SpeciesEval } from './habitat';
import { GuestSystem } from './guests';
import { N_TILES, PathNav, TileSearch } from './nav';
import { Progress, createObjectives } from './progress';
import { SimRng } from './rng';
import { StaffSystem } from './staff';
import type { AnimalSim, GuestSim, HabitatRuntime, StaffSim } from './state';

/** Largest simulated step (scaled seconds). Larger frames are sub-stepped. */
export const MAX_STEP = 0.1;
export const MAX_LITTER = 450;
const SAVE_VERSION = 1;

export type IncomeKind = 'admissions' | 'shopIncome' | 'donations' | 'other';
export type ExpenseKind = 'upkeep' | 'salaries' | 'construction' | 'animalPurchases';

export function emptyLedger(day: number): LedgerEntry {
  return {
    day,
    income: 0,
    expenses: 0,
    admissions: 0,
    shopIncome: 0,
    donations: 0,
    upkeep: 0,
    salaries: 0,
    construction: 0,
    animalPurchases: 0,
  };
}

interface SimSaveData extends SimSave {
  world: WorldSave;
  money: number;
  admissionPrice: number;
  day: number;
  minuteOfDay: number;
  speed: SimSpeed;
  rating: number;
  objectives: Objective[];
  ledger: LedgerEntry[];
  today: LedgerEntry;
  animals: AnimalSim[];
  guests: GuestSim[];
  staff: StaffSim[];
  litter: Litter[];
  habitats: HabitatRuntime[];
  /** habitat id → one tile inside it (restores ids after World.load renumbers them). */
  habitatIds: [number, number][];
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
  progress: Record<string, number>;
  debtWarned: boolean;
}

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
  totalVisitors = 0;
  /** Smoothed happiness of departing guests (0..1). */
  satisfaction = 0.6;
  nextIds = { animal: 1, guest: 1, staff: 1, litter: 1 };
  readonly habRt = new Map<number, HabitatRuntime>();
  debtWarned = false;

  // ---- subsystems
  readonly nav: PathNav;
  readonly search = new TileSearch();
  readonly animalSys: AnimalSystem;
  readonly guestSys: GuestSystem;
  readonly staffSys: StaffSystem;
  readonly cmd: Commands;
  readonly progress: Progress;

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
  private pendingDelta = 0;
  private pendingNewSeed: number | undefined;
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

  private endOfDay() {
    let upkeep = 0;
    for (const o of this.world.objects.values()) upkeep += OBJECTS_BY_ID[o.defId]?.upkeep ?? 0;
    // fences: small upkeep scaled by strength
    let fenceUpkeep = 0;
    for (let i = 0; i < this.world.hFence.length; i++) if (this.world.hFence[i]) fenceUpkeep += 0.1 * (FENCES_BY_ID[this.world.hFence[i]]?.strength ?? 1);
    for (let i = 0; i < this.world.vFence.length; i++) if (this.world.vFence[i]) fenceUpkeep += 0.1 * (FENCES_BY_ID[this.world.vFence[i]]?.strength ?? 1);
    upkeep += Math.round(fenceUpkeep);
    let salaries = 0;
    for (const s of this.staff.values()) salaries += s.salary;
    if (upkeep) this.spend('upkeep', upkeep);
    if (salaries) this.spend('salaries', salaries);
    const done = this.today;
    this.ledger.push(done);
    while (this.ledger.length > 30) this.ledger.shift();
    this.day++;
    this.today = emptyLedger(this.day);
    this.guestsToday = 0;
    this.animalSys.daily();
    this.debtWarned = false;
    this.events.emit('dayChanged', { day: this.day });
    const net = done.income - done.expenses;
    this.notify(null, `Day ${done.day} closed: income $${Math.round(done.income)}, expenses $${Math.round(done.expenses)} (${net >= 0 ? '+' : '-'}$${Math.abs(Math.round(net))})`, net >= 0 ? 'info' : 'warn');
    if (this.money < 0) {
      this.notify('debt', `You are $${Math.round(-this.money)} in debt! Building is blocked until you earn money — raise income or sell something.`, 'bad', undefined, 0);
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
    if (kind !== 'other') this.today[kind] += amount;
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
  /**
   * Toast for the player. `key` throttles repeats: the same key is not shown
   * again for `cooldown` simulated seconds (null = never throttled).
   */
  notify(key: string | null, text: string, kind: NotifyKind, focus?: { x: number; z: number }, cooldown = 90) {
    if (key) {
      const last = this.notifyLast.get(key);
      if (last !== undefined && this.time - last < cooldown) return;
      this.notifyLast.set(key, this.time);
    }
    this.events.emit('notify', focus ? { text, kind, focus: { x: focus.x, z: focus.z } } : { text, kind });
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
  }  removeObject(objectId: number, dryRun = false): CommandResult {
    // TODO(polish): dedicated command that leaves fences/paths alone.
    const o = this.world.objects.get(objectId);
    if (!o) return { ok: false, cost: 0, reason: 'Nothing to remove' };
    const fp = this.world.footprint(o);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const t of fp) {
      x0 = Math.min(x0, t.x); z0 = Math.min(z0, t.z); x1 = Math.max(x1, t.x); z1 = Math.max(z1, t.z);
    }
    return this.cmd.bulldoze({ x0, z0, x1, z1 }, dryRun);
  }
  renameHabitat(habitatId: number, name: string): CommandResult {
    const n = name.trim().slice(0, 32);
    if (!n || !this.world.habitats.has(habitatId)) return { ok: false, cost: 0, reason: 'Invalid name' };
    this.world.renameHabitat(habitatId, n);
    return { ok: true, cost: 0 };
  }
  staffWage(role: StaffRole): number {
    return STAFF_SALARY[role] ?? 0;
  }
  terrainCost(terrain: Terrain): number {
    return terrain === Terrain.Water || terrain === Terrain.DeepWater ? TERRAIN_COST_WATER : TERRAIN_COST_LAND;
  }

  buyAnimal(speciesId: string, wx: number, wz: number, dryRun = false): CommandResult {
    return this.cmd.buyAnimal(speciesId, wx, wz, dryRun);
  }
  sellAnimal(animalId: number): CommandResult {
    return this.cmd.sellAnimal(animalId);
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
    };
    this.statsCache = out;
    this.statsTime = this.time;
    return out;
  }

  suitability(speciesId: string, habitatId: number): SpeciesSuitability {
    const sp = SPECIES_BY_ID[speciesId];
    const hab = this.world.habitats.get(habitatId);
    if (!sp || !hab) {
      return {
        speciesId,
        score: 0,
        terrain: 0,
        foliage: 0,
        space: 0,
        fenceOk: false,
        hasWater: false,
        hasFood: false,
        issues: [!sp ? 'Unknown species' : 'Not a habitat — enclose an area with fences first'],
      };
    }
    const pop = this.population(habitatId);
    const present = (pop.count.get(speciesId) ?? 0) > 0;
    const e = present ? this.evalFor(habitatId, speciesId)! : evaluateSpecies(this.world, hab, sp, pop, this.keeperCount(), true);
    const issues = e.issues.slice();
    const rt = this.habitatRuntime(habitatId);
    if (present && rt && rt.food < 0.5 && this.keeperCount() > 0) issues.push('Food is running out (keepers will refill it)');
    if (this.habitatDirt(habitatId) > 0.5) issues.push('Dirty — dung needs cleaning by a keeper');
    if (!hab.viewTiles.length) issues.push('Guests cannot see this habitat (build a path next to the fence)');
    return {
      speciesId: e.speciesId,
      score: e.score,
      terrain: e.terrain,
      foliage: e.foliage,
      space: e.space,
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
      suitability: species.map((s) => this.suitability(s, habitatId)),
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
    const habitatIds: [number, number][] = [];
    for (const h of this.world.habitats.values()) if (h.tiles.length) habitatIds.push([h.id, h.tiles[0]]);
    const data: SimSaveData = {
      version: SAVE_VERSION,
      world: this.world.serialize(),
      money: this.money,
      admissionPrice: this.admissionPrice,
      day: this.day,
      minuteOfDay: this.minuteOfDay,
      speed: this.speed,
      rating: this.rating,
      objectives: this.objectives,
      ledger: this.ledger,
      today: this.today,
      animals: Array.from(this.animals.values()),
      guests: Array.from(this.guests.values()),
      staff: Array.from(this.staff.values()),
      litter: Array.from(this.litter.values()),
      habitats: Array.from(this.habRt.values()),
      habitatIds,
      nextIds: this.nextIds,
      rng: this.rng.state,
      time: this.time,
      slowAcc: this.slowAcc,
      spawnAcc: this.spawnAcc,
      hourAcc: this.hourAcc,
      crowdAcc: this.crowdAcc,
      guestsToday: this.guestsToday,
      totalVisitors: this.totalVisitors,
      satisfaction: this.satisfaction,
      progress: this.progress.serialize(),
      debtWarned: this.debtWarned,
    };
    // deep copy so later simulation never mutates a save that is still being written
    return JSON.parse(JSON.stringify(data)) as SimSave;
  }

  load(save: SimSave): void {
    if (!save || save.version !== SAVE_VERSION) throw new Error('Unsupported save version');
    const s = JSON.parse(JSON.stringify(save)) as SimSaveData;
    if (!s.world || !Array.isArray(s.world.terrain)) throw new Error('Corrupt save: missing world');

    // entities first so listeners of worldReset (emitted by World.load) see the new state
    this.animals.clear();
    this.guests.clear();
    this.staff.clear();
    this.litter.clear();
    for (const a of s.animals ?? []) this.animals.set(a.id, a);
    for (const g of s.guests ?? []) this.guests.set(g.id, g);
    for (const st of s.staff ?? []) this.staff.set(st.id, st);
    for (const l of s.litter ?? []) this.litter.set(l.id, l);

    this.money = s.money;
    this.admissionPrice = s.admissionPrice;
    this.day = s.day;
    this.minuteOfDay = s.minuteOfDay;
    this.speed = s.speed;
    this.rating = s.rating;
    this.objectives = mergeObjectives(s.objectives ?? []);
    this.ledger = s.ledger ?? [];
    this.today = s.today ?? emptyLedger(this.day);
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
    this.totalVisitors = s.totalVisitors ?? 0;
    this.satisfaction = s.satisfaction ?? 0.6;
    this.progress.load(s.progress ?? {});
    this.debtWarned = s.debtWarned ?? false;
    this.pendingDelta = 0;
    this.resetCaches();
    // the world last: World.load emits worldReset, by which time every other piece of state is in place
    this.world.load(s.world);
    this.restoreHabitatIds(s.habitatIds ?? [], s.world);
    this.resetCaches();
    this.events.emit('moneyChanged', { money: this.money, delta: 0 });
  }

  /**
   * World.load() renumbers habitats from scratch. Re-label every region with
   * the id it had when saved (by a sample tile), then recompute so the world's
   * id-voting keeps them. Also drops the throw-away names World.load created.
   */
  private restoreHabitatIds(ids: [number, number][], ws: WorldSave) {
    const w = this.world;
    if (!ids.length) return;
    const map = new Map<number, number>();
    for (const [oldId, tile] of ids) {
      const now = w.habitatOf[tile];
      if (now) map.set(now, oldId);
    }
    let differs = false;
    for (const [now, old] of map) if (now !== old) differs = true;
    if (!differs) return;
    for (let i = 0; i < N_TILES; i++) {
      const h = w.habitatOf[i];
      if (h) w.habitatOf[i] = map.get(h) ?? 0;
    }
    w.recomputeHabitats();
    // World keeps a private name map; remove names of the temporary ids it invented.
    const names = (w as unknown as { habitatNames?: unknown }).habitatNames;
    if (names instanceof Map) {
      const keep = new Set(Object.keys(ws.habitatNames ?? {}).map(Number));
      for (const k of Array.from(names.keys())) if (!keep.has(k as number) && !w.habitats.has(k as number)) names.delete(k);
    }
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

  newGame(seed?: number): void {
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
    this.minuteOfDay = START_MINUTE;
    this.speed = 1;
    this.objectives = createObjectives();
    this.ledger = [];
    this.today = emptyLedger(1);
    this.rng = new SimRng(s ^ 0x5bd1e995);
    this.time = 0;
    this.slowAcc = 0;
    this.spawnAcc = 0;
    this.hourAcc = 0;
    this.crowdAcc = 0;
    this.guestsToday = 0;
    this.totalVisitors = 0;
    this.satisfaction = 0.6;
    this.nextIds = { animal: 1, guest: 1, staff: 1, litter: 1 };
    this.debtWarned = false;
    this.progress.reset();
    this.pendingDelta = 0;
    this.resetCaches();
    this.world.load(blank);
    this.world.generateStarterMap(); // emits worldReset
    this.resetCaches();
    this.rating = this.progress.targetRating();
    this.events.emit('moneyChanged', { money: this.money, delta: 0 });
  }

  dispose() {
    this.offs.forEach((f) => f());
    this.nav.dispose();
  }
}

/** Keep saved objective progress but pick up new objectives added in later versions. */
function mergeObjectives(saved: Objective[]): Objective[] {
  const fresh = createObjectives();
  const byId = new Map(saved.map((o) => [o.id, o]));
  return fresh.map((o) => ({ ...o, done: byId.get(o.id)?.done ?? false }));
}
