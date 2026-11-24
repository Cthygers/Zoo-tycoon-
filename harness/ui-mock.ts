// Lightweight fakes of every UI dependency so the Wildhaven UI can be exercised
// in isolation: a working ISimulation over a real World (generateStarterMap +
// two demo habitats), a simple three.js render context (vertex-coloured terrain
// that follows world.heightAt), box/capsule props and creatures, and an entity
// view layer with sphere picking.

import * as THREE from 'three';
import { DEFAULT_ADMISSION, ENTRANCE_TILE, MAP_H, MAP_W, START_MONEY, TILE, WATER_LEVEL, WORLD_H, WORLD_W } from '../src/core/constants';
import {
  SPEED_MULTIPLIERS,
  type CreatureAnim,
  type CreatureModel,
  type GoalProgress,
  type HabitatReport,
  type IAudio,
  type ICreatureFactory,
  type IEntityViews,
  type IPropsLayer,
  type IRenderContext,
  type ISimulation,
  type QualityLevel,
  type QualitySettings,
  type RunningCostEstimate,
  type SimMessage,
  type SimSave,
  type SimSpeed,
  type SpeciesSuitability,
  type ZooStats,
} from '../src/core/contracts';
import { EventBus, type TileRect } from '../src/core/events';
import { Rng } from '../src/core/rng';
import {
  PathType,
  Terrain,
  TERRAIN_COUNT,
  isWater,
  type AnimalState,
  type CommandResult,
  type GuestState,
  type HumanAppearance,
  type LedgerEntry,
  type Litter,
  type Objective,
  type SelectionRef,
  type ServiceDayStats,
  type StaffDayStats,
  type StaffRole,
  type StaffState,
} from '../src/core/types';
import { World, type EdgeRef } from '../src/core/world';
import { FENCES_BY_ID, PATHS_BY_TYPE } from '../src/data/fences';
import { OBJECTS_BY_ID, rotatedSize } from '../src/data/objects';
import { SPECIES_BY_ID } from '../src/data/species';
import { TERRAIN_INFO } from '../src/ui/catalog';

const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
const SALARY: Record<StaffRole, number> = { keeper: 120, groundskeeper: 90, vet: 160 };
const NAMES = ['Kibo', 'Amara', 'Juno', 'Tala', 'Rafi', 'Nia', 'Zuri', 'Bodhi', 'Imani', 'Sefu', 'Laila', 'Otto', 'Mosi', 'Kesi'];
const GUEST_NAMES = ['Maya Ortiz', 'Ben Hollis', 'Priya Shah', 'Tom Reed', 'Lena Vogel', 'Sam Okafor', 'Ivy Chen', 'Leo Marsh', 'Ada Novak', 'Kai Brooks'];
const THOUGHTS = ['The giraffes are so tall!', 'I could use a drink.', 'This path is lovely.', 'Those zebras look happy.', 'I wish there were more benches.', 'What a beautiful zoo!'];

function emptyLedger(day: number): LedgerEntry {
  return { day, income: 0, expenses: 0, admissions: 0, shopIncome: 0, donations: 0, other: 0, upkeep: 0, food: 0, salaries: 0, construction: 0, animalPurchases: 0 };
}

// ===========================================================================
// Simulation
// ===========================================================================

export class MockSim implements ISimulation {
  readonly world: World;
  readonly events: EventBus;
  readonly animals = new Map<number, AnimalState>();
  readonly guests = new Map<number, GuestState>();
  readonly staff = new Map<number, StaffState>();
  readonly litter = new Map<number, Litter>();
  money = START_MONEY;
  admissionPrice = DEFAULT_ADMISSION;
  day = 6;
  minuteOfDay = 10 * 60 + 25;
  speed: SimSpeed = 1;
  rating = 64;
  objectives: Objective[] = [];
  ledger: LedgerEntry[] = [];
  today: LedgerEntry = emptyLedger(6);
  private nextId = 1;
  private rng = new Rng(77);
  private targets = new Map<number, { x: number; z: number }>();

  constructor(events: EventBus, seed = 4242) {
    this.events = events;
    this.world = new World(events, seed);
    this.newGame(seed);
  }

  newGame(_seed?: number): void {
    const w = this.world;
    this.animals.clear();
    this.guests.clear();
    this.staff.clear();
    this.litter.clear();
    w.generateStarterMap();
    this.buildDemo();
    this.money = 48250;
    this.day = 6;
    this.minuteOfDay = 10 * 60 + 25;
    this.objectives = [
      { id: 'o1', text: 'Build your first habitat', done: true, reward: 1000 },
      { id: 'o2', text: 'Adopt 5 animals', done: true, reward: 2000 },
      { id: 'o3', text: 'Welcome 100 visitors', done: false, reward: 3000 },
      { id: 'o4', text: 'Hire a keeper', done: true, reward: 500 },
      { id: 'o5', text: 'Keep 3 species happy', done: false, reward: 5000 },
      { id: 'o6', text: 'Reach a 75 zoo rating', done: false, reward: 8000 },
      { id: 'o7', text: 'Reach 75% guest happiness for a day', done: false, reward: 6000 },
    ];
    this.ledger = [];
    const r = new Rng(5);
    for (let d = 1; d < this.day; d++) {
      const adm = Math.round(900 + d * 260 + r.range(-200, 200));
      const shop = Math.round(200 + d * 90 + r.range(-60, 60));
      const cons = d === 1 ? 14500 : d === 2 ? 22000 : Math.round(r.range(300, 2500));
      const e: LedgerEntry = { ...emptyLedger(d), admissions: adm, shopIncome: shop, donations: Math.round(r.range(20, 120)), construction: cons, salaries: 160, upkeep: Math.round(80 + d * 12), animalPurchases: d === 2 ? 25000 : 0 };
      e.income = e.admissions + e.shopIncome + e.donations;
      e.expenses = e.construction + e.salaries + e.upkeep + e.animalPurchases;
      this.ledger.push(e);
    }
    this.today = { ...emptyLedger(this.day), admissions: 1120, shopIncome: 340, donations: 45, construction: 640, salaries: 160, upkeep: 95 };
    this.today.income = this.today.admissions + this.today.shopIncome + this.today.donations;
    this.today.expenses = this.today.construction + this.today.salaries + this.today.upkeep;
    this.events.emit('worldReset', {});
  }

  private clearObjects(x0: number, z0: number, x1: number, z1: number): void {
    const w = this.world;
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const o = w.objectAt(x, z);
        if (o) w.removeObject(o.id);
      }
  }

  private fenceRect(r: TileRect, id: number, southId = id): void {
    const w = this.world;
    for (const e of w.edgesAroundRect(r)) w.setFence(e, e.dir === 'h' && e.z === r.z1 + 1 ? southId : id, false);
    w.recomputeHabitats();
  }

  private buildDemo(): void {
    const w = this.world;
    const avenueZ = ENTRANCE_TILE.z - 14; // 57
    // savanna habitat north-west of the avenue
    const sav: TileRect = { x0: 22, z0: 43, x1: 34, z1: avenueZ - 2 };
    this.clearObjects(sav.x0 - 1, sav.z0 - 1, sav.x1 + 1, sav.z1 + 1);
    w.setTerrainRect(sav, Terrain.DryGrass);
    w.setTerrainRect({ x0: 24, z0: 50, x1: 27, z1: 53 }, Terrain.Dirt);
    w.setTerrainRect({ x0: 30, z0: 45, x1: 32, z1: 47 }, Terrain.Water);
    w.setTerrainRect({ x0: 31, z0: 46, x1: 31, z1: 46 }, Terrain.DeepWater);
    this.fenceRect(sav, 2, 4);
    const savId = w.habitatOf[w.idx(sav.x0, sav.z0)];
    if (savId) w.renameHabitat(savId, 'Savanna Plains');
    for (const [x, z] of [[24, 45], [28, 44], [33, 52], [23, 53]]) w.addObject('tree_acacia', x, z, 0, x * 7 + z);
    w.addObject('rock_boulder', 29, 52, 0, 3);
    w.addObject('bush_savanna', 26, 47, 0, 4);
    w.addObject('feeder_hay', 25, 49, 0, 5);
    // rocky lion habitat
    const lion: TileRect = { x0: 39, z0: 46, x1: 47, z1: avenueZ - 2 };
    this.clearObjects(lion.x0 - 1, lion.z0 - 1, lion.x1 + 1, lion.z1 + 1);
    w.setTerrainRect(lion, Terrain.DryGrass);
    w.setTerrainRect({ x0: 43, z0: 47, x1: 46, z1: 49 }, Terrain.Rock);
    this.fenceRect(lion, 3, 4);
    const lionId = w.habitatOf[w.idx(lion.x0, lion.z0)];
    if (lionId) w.renameHabitat(lionId, 'Lion Rock');
    w.addObject('rock_outcrop', 44, 47, 0, 9);
    w.addObject('tree_acacia', 41, 52, 0, 10);
    w.addObject('grass_tall', 40, 49, 0, 11);
    // a shop and benches on the avenue
    w.addObject('shop_drinks', 37, avenueZ + 1, 0, 12);
    w.addObject('bench', 33, avenueZ + 1, 0, 13);
    w.addObject('lamp', 30, avenueZ + 1, 0, 14);

    const addAnimal = (sp: string, x: number, z: number, sex: 'M' | 'F', hab: number) => {
      const id = this.nextId++;
      const a: AnimalState = {
        id,
        speciesId: sp,
        name: NAMES[id % NAMES.length],
        sex,
        ageDays: 8 + ((id * 7) % 30),
        growth: id % 5 === 0 ? 0.6 : 1,
        x: (x + 0.5) * TILE,
        y: 0,
        z: (z + 0.5) * TILE,
        heading: id,
        speed: 0,
        action: 'idle',
        actionTime: 0,
        habitatId: hab,
        needs: { hunger: 0.82, thirst: 0.64, energy: 0.71, social: 0.9, environment: 0.58, space: 0.95, enrichment: 0.34 },
        happiness: 0.74,
        health: 0.93,
        pregnantDays: 0,
        escaped: false,
        seed: id * 101,
      };
      a.y = w.heightAt(a.x, a.z);
      this.animals.set(id, a);
      this.events.emit('animalAdded', { id });
    };
    addAnimal('zebra', 26, 45, 'M', savId);
    addAnimal('zebra', 27, 46, 'F', savId);
    addAnimal('zebra', 25, 52, 'F', savId);
    addAnimal('giraffe', 30, 50, 'F', savId);
    addAnimal('giraffe', 28, 53, 'M', savId);
    addAnimal('lion', 42, 50, 'M', lionId);
    addAnimal('lion', 44, 52, 'F', lionId);

    // guests on path tiles
    const paths: number[] = [];
    for (let i = 0; i < MAP_W * MAP_H; i++) if (w.path[i]) paths.push(i);
    for (let k = 0; k < 26; k++) {
      const i = paths[this.rng.int(0, paths.length - 1)];
      const x = ((i % MAP_W) + this.rng.range(0.2, 0.8)) * TILE,
        z = (Math.floor(i / MAP_W) + this.rng.range(0.2, 0.8)) * TILE;
      const id = this.nextId++;
      const ap = this.randomLook(k);
      this.guests.set(id, {
        id,
        name: GUEST_NAMES[k % GUEST_NAMES.length],
        appearance: ap,
        x,
        y: w.heightAt(x, z),
        z,
        heading: this.rng.range(0, 6.28),
        speed: 0,
        action: k % 3 ? 'walk' : 'watch',
        actionTime: 0,
        needs: { hunger: this.rng.range(0.3, 1), thirst: this.rng.range(0.2, 1), bladder: this.rng.range(0.4, 1), energy: this.rng.range(0.4, 1), fun: this.rng.range(0.5, 1) },
        happiness: this.rng.range(0.5, 0.95),
        money: Math.round(this.rng.range(8, 60)),
        holding: k % 4 === 0 ? 'balloon' : k % 5 === 0 ? 'icecream' : 'none',
        thoughts: [THOUGHTS[k % THOUGHTS.length], THOUGHTS[(k + 2) % THOUGHTS.length]],
        seenSpecies: k % 2 ? ['zebra', 'giraffe'] : ['lion'],
        hidden: false,
        seed: k,
      });
    }
    this.hire('keeper', ENTRANCE_TILE.x, avenueZ);
    this.hire('groundskeeper', ENTRANCE_TILE.x, avenueZ + 6);
  }

  private randomLook(k: number): HumanAppearance {
    const skins = [0xf1c7a5, 0xd9a07a, 0xa8714c, 0x6e4630];
    const shirts = [0x8a3b32, 0x2f5d7c, 0xd6b25c, 0x4f6b3a, 0xe8e2d6, 0x5a4a78];
    return {
      skin: skins[k % skins.length],
      hair: 0x2a1d14,
      shirt: shirts[k % shirts.length],
      pants: 0x3a3f4a,
      shoes: 0x222222,
      hairStyle: (k % 4) as 0 | 1 | 2 | 3,
      height: k % 6 === 0 ? 1.2 : 1.6 + (k % 5) * 0.06,
      build: 1,
      child: k % 6 === 0,
      female: k % 2 === 0,
    };
  }

  private hire(role: StaffRole, tx: number, tz: number): StaffState {
    const id = this.nextId++;
    const s: StaffState = {
      id,
      role,
      name: role === 'keeper' ? 'Grace Mwangi' : role === 'vet' ? 'Dr. Elena Ruiz' : 'Owen Pike',
      appearance: this.randomLook(id),
      x: (tx + 0.5) * TILE,
      y: 0,
      z: (tz + 0.5) * TILE,
      heading: 0,
      speed: 0,
      action: 'walk',
      actionTime: 0,
      salary: SALARY[role],
      task: role === 'keeper' ? 'Feeding — Savanna Plains' : role === 'vet' ? 'Checking animals' : 'Sweeping paths',
      seed: id,
    };
    s.y = this.world.heightAt(s.x, s.z);
    this.staff.set(id, s);
    this.events.emit('staffAdded', { id });
    return s;
  }

  isOpen(): boolean {
    return this.minuteOfDay >= 8 * 60 && this.minuteOfDay < 20 * 60;
  }

  stats(): ZooStats {
    let ah = 0,
      gh = 0;
    for (const a of this.animals.values()) ah += a.happiness;
    for (const g of this.guests.values()) gh += g.happiness;
    return {
      guestsInZoo: this.guests.size,
      guestsToday: 74,
      totalVisitors: 812,
      animalCount: this.animals.size,
      speciesCount: new Set(Array.from(this.animals.values(), (a) => a.speciesId)).size,
      avgAnimalHappiness: this.animals.size ? ah / this.animals.size : 0,
      avgGuestHappiness: this.guests.size ? gh / this.guests.size : 0,
      staffCount: this.staff.size,
      litterCount: this.litter.size,
      fairAdmission: 24,
      guestCapacity: 141,
      full: this.guests.size + 4 > 141,
      turnedAwayToday: 12,
      gateClosed: null,
    };
  }

  objectiveProgress(objectiveId: string): GoalProgress | null {
    const o = this.objectives.find((x) => x.id === objectiveId);
    if (!o || o.done) return null;
    // a one-day goal no day has been measured for yet
    return o.id === 'o7' ? { current: 0, target: 75, waiting: 'No full day yet' } : { current: 141, target: 150 };
  }

  runningCosts(): RunningCostEstimate {
    const fraction = this.minuteOfDay / (24 * 60);
    const day = { wages: 490, food: 180, upkeep: 70, total: 740 };
    const soFar = { wages: Math.round(490 * fraction), food: Math.round(180 * fraction), upkeep: Math.round(70 * fraction), total: 0 };
    soFar.total = soFar.wages + soFar.food + soFar.upkeep;
    return { fraction, soFar, day };
  }

  messages(): readonly SimMessage[] {
    return [{ day: this.day, minute: 9 * 60, text: 'Welcome to your new zoo!', kind: 'info' }];
  }

  update(realDt: number): void {
    const dt = realDt * SPEED_MULTIPLIERS[this.speed];
    if (dt <= 0) return;
    this.minuteOfDay += dt * 4;
    if (this.minuteOfDay >= 1440) {
      this.minuteOfDay -= 1440;
      this.ledger.push(this.today);
      if (this.ledger.length > 30) this.ledger.shift();
      this.day++;
      this.today = emptyLedger(this.day);
      this.events.emit('dayChanged', { day: this.day });
    }
    const w = this.world;
    for (const a of this.animals.values()) {
      const sp = SPECIES_BY_ID[a.speciesId];
      let t = this.targets.get(a.id);
      const hab = a.habitatId ? w.habitats.get(a.habitatId) : undefined;
      if (!t && hab && this.rng.chance(dt * 0.15)) {
        const i = hab.tiles[this.rng.int(0, hab.tiles.length - 1)];
        t = { x: ((i % MAP_W) + 0.5) * TILE, z: (Math.floor(i / MAP_W) + 0.5) * TILE };
        this.targets.set(a.id, t);
      }
      if (t) {
        const dx = t.x - a.x,
          dz = t.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.3) {
          this.targets.delete(a.id);
          a.speed = 0;
          a.action = this.rng.chance(0.5) ? 'eat' : 'idle';
        } else {
          const v = (sp?.walkSpeed ?? 1) * dt;
          a.x += (dx / d) * Math.min(v, d);
          a.z += (dz / d) * Math.min(v, d);
          a.heading = Math.atan2(dx, dz);
          a.speed = sp?.walkSpeed ?? 1;
          a.action = 'walk';
        }
        a.y = w.heightAt(a.x, a.z);
      }
    }
    for (const g of this.guests.values()) {
      if (g.action !== 'walk') continue;
      const nx = g.x + Math.sin(g.heading) * 1.1 * dt,
        nz = g.z + Math.cos(g.heading) * 1.1 * dt;
      const t = w.tileOfWorld(nx, nz);
      if (w.isPath(t.x, t.z)) {
        g.x = nx;
        g.z = nz;
        g.speed = 1.1;
      } else {
        g.heading += Math.PI / 2 + this.rng.range(-0.4, 0.4);
        g.speed = 0;
      }
      g.y = w.heightAt(g.x, g.z);
    }
  }

  // ------------------------------------------------------------ commands
  canAfford(c: number): boolean {
    return c <= 0 || this.money >= c;
  }

  private res(ok: boolean, cost: number, reason: string | undefined, dry: boolean, at?: { x: number; z: number }, warning?: string): CommandResult {
    const r: CommandResult = reason ? { ok, cost, reason } : { ok, cost };
    if (ok && warning) r.warning = warning;
    if (!dry) {
      this.events.emit('commandResult', at ? { ...r, x: at.x, z: at.z } : r);
      if (!ok && reason) this.events.emit('notify', { text: reason, kind: 'warn', focus: at });
      if (ok && cost) {
        this.money -= cost;
        this.events.emit('moneyChanged', { money: this.money, delta: -cost });
        if (at) this.events.emit('moneyPopup', { x: at.x, z: at.z, amount: -cost });
        if (cost > 0) {
          this.today.construction += cost;
          this.today.expenses += cost;
        }
      }
    }
    return r;
  }

  private noMoney(c: number): string {
    return `Not enough money (needs ${money(c)}, you have ${money(this.money)})`;
  }

  paintTerrain(rect: TileRect, terrain: Terrain, dryRun = false): CommandResult {
    const w = this.world;
    const r = w.clampRect(rect);
    const water = isWater(terrain);
    let count = 0;
    const ok = (x: number, z: number) => {
      const i = w.idx(x, z);
      if (w.terrain[i] === terrain) return false;
      if (water && (w.path[i] || w.objectGrid[i])) return false;
      return true;
    };
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) if (ok(x, z)) count++;
    const cost = count * (water ? 12 : 4);
    const at = { x: ((r.x0 + r.x1 + 1) / 2) * TILE, z: ((r.z0 + r.z1 + 1) / 2) * TILE };
    if (!count) return this.res(false, 0, 'Already that terrain', dryRun, at);
    if (!this.canAfford(cost)) return this.res(false, cost, this.noMoney(cost), dryRun, at);
    if (dryRun) return this.res(true, cost, undefined, true, at);
    w.setTerrainRect(r, terrain, ok);
    return this.res(true, cost, undefined, false, at);
  }

  placePaths(tiles: { x: number; z: number }[], type: PathType, dryRun = false): CommandResult {
    const w = this.world;
    const def = PATHS_BY_TYPE[type];
    const todo: { x: number; z: number }[] = [];
    let why = '';
    for (const t of tiles) {
      if (w.getPath(t.x, t.z) === type) continue;
      let reason = w.canPlacePath(t.x, t.z, type);
      const o = w.objectAt(t.x, t.z);
      if (reason === 'Tile is occupied' && o && ['tree', 'plant', 'rock'].includes(OBJECTS_BY_ID[o.defId].category) && !w.habitatOf[w.idx(t.x, t.z)]) reason = null;
      if (reason) why ||= reason;
      else todo.push(t);
    }
    const at = tiles.length ? { x: (tiles[0].x + 0.5) * TILE, z: (tiles[0].z + 0.5) * TILE } : undefined;
    if (!todo.length) return this.res(false, 0, why || 'Path already there', dryRun, at);
    const cost = todo.length * def.costPerTile;
    if (!this.canAfford(cost)) return this.res(false, cost, this.noMoney(cost), dryRun, at);
    if (dryRun) return this.res(true, cost, undefined, true, at);
    for (const t of todo) {
      const o = w.objectAt(t.x, t.z);
      if (o) w.removeObject(o.id);
      w.setPath(t.x, t.z, type);
    }
    w.refreshHabitatStats();
    return this.res(true, cost, undefined, false, at);
  }

  placeFences(edges: EdgeRef[], fenceId: number, dryRun = false): CommandResult {
    const w = this.world;
    const def = FENCES_BY_ID[fenceId];
    const todo: EdgeRef[] = [];
    let why = '';
    for (const e of edges) {
      if (!w.edgeInBounds(e) || w.getFence(e) === fenceId) continue;
      const [ax, az, bx, bz] = e.dir === 'h' ? [e.x, e.z - 1, e.x, e.z] : [e.x - 1, e.z, e.x, e.z];
      if (w.inBounds(ax, az) && w.inBounds(bx, bz) && w.isPath(ax, az) && w.isPath(bx, bz)) {
        why ||= 'Fences cannot cross paths';
        continue;
      }
      todo.push(e);
    }
    const mid = edges[Math.floor(edges.length / 2)];
    const at = mid ? (mid.dir === 'h' ? { x: (mid.x + 0.5) * TILE, z: mid.z * TILE } : { x: mid.x * TILE, z: (mid.z + 0.5) * TILE }) : undefined;
    if (!todo.length) return this.res(false, 0, why || 'Fence already there', dryRun, at);
    const cost = todo.length * def.costPerSegment;
    if (!this.canAfford(cost)) return this.res(false, cost, this.noMoney(cost), dryRun, at);
    if (dryRun) return this.res(true, cost, why ? `Some segments skipped: ${why}` : undefined, true, at);
    for (const e of todo) w.setFence(e, fenceId, false);
    w.recomputeHabitats();
    return this.res(true, cost, undefined, false, at);
  }

  placeObject(defId: string, tx: number, tz: number, rot: number, dryRun = false): CommandResult {
    const w = this.world;
    const def = OBJECTS_BY_ID[defId];
    const at = { x: (tx + 0.5) * TILE, z: (tz + 0.5) * TILE };
    const why = w.canPlaceObject(def, tx, tz, rot);
    if (why) return this.res(false, def.cost, why, dryRun, at);
    if (!this.canAfford(def.cost)) return this.res(false, def.cost, this.noMoney(def.cost), dryRun, at);
    if (dryRun) return this.res(true, def.cost, undefined, true, at);
    w.addObject(defId, tx, tz, rot, this.rng.int(0, 1e6));
    return this.res(true, def.cost, undefined, false, at);
  }

  bulldoze(rect: TileRect, dryRun = false): CommandResult {
    const w = this.world;
    const r = w.clampRect(rect);
    let refund = 0;
    const objs = new Set<number>();
    const paths: { x: number; z: number }[] = [];
    for (let z = r.z0; z <= r.z1; z++)
      for (let x = r.x0; x <= r.x1; x++) {
        const o = w.objectAt(x, z);
        if (o && o.defId !== 'entrance_gate' && !objs.has(o.id)) {
          objs.add(o.id);
          refund += Math.round(OBJECTS_BY_ID[o.defId].cost * 0.4);
        }
        if (w.isPath(x, z) && !(Math.abs(x - ENTRANCE_TILE.x) <= 2 && z >= ENTRANCE_TILE.z - 2)) {
          paths.push({ x, z });
          refund += Math.round(PATHS_BY_TYPE[w.getPath(x, z)].costPerTile * 0.4);
        }
      }
    const fences: EdgeRef[] = [];
    for (let z = r.z0; z <= r.z1 + 1; z++) for (let x = r.x0; x <= r.x1; x++) if (w.getFence({ dir: 'h', x, z })) fences.push({ dir: 'h', x, z });
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1 + 1; x++) if (w.getFence({ dir: 'v', x, z })) fences.push({ dir: 'v', x, z });
    for (const e of fences) refund += Math.round(FENCES_BY_ID[w.getFence(e)].costPerSegment * 0.4);
    const at = { x: ((r.x0 + r.x1 + 1) / 2) * TILE, z: ((r.z0 + r.z1 + 1) / 2) * TILE };
    if (!objs.size && !paths.length && !fences.length) return this.res(false, 0, 'Nothing to remove here', dryRun, at);
    if (dryRun) return this.res(true, -refund, undefined, true, at);
    for (const id of objs) w.removeObject(id);
    for (const p of paths) w.setPath(p.x, p.z, PathType.None);
    for (const e of fences) w.setFence(e, 0, false);
    if (fences.length || paths.length) w.recomputeHabitats();
    return this.res(true, -refund, undefined, false, at);
  }

  removeObject(objectId: number, dryRun = false): CommandResult {
    const w = this.world;
    const o = w.objects.get(objectId);
    if (!o) return this.res(false, 0, 'Nothing to remove', dryRun);
    const c = w.objectCenter(o);
    const at = { x: c.x, z: c.z };
    if (o.defId === 'entrance_gate') return this.res(false, 0, 'The entrance cannot be removed', dryRun, at);
    const refund = Math.round(OBJECTS_BY_ID[o.defId].cost * 0.4);
    if (dryRun) return this.res(true, -refund, undefined, true, at);
    w.removeObject(objectId);
    return this.res(true, -refund, undefined, false, at);
  }

  moveObject(objectId: number, tx: number, tz: number, rot: number, dryRun = false): CommandResult {
    const w = this.world;
    const o = w.objects.get(objectId);
    const at = { x: (tx + 0.5) * TILE, z: (tz + 0.5) * TILE };
    if (!o || o.defId === 'entrance_gate') return this.res(false, 0, 'Cannot move that', dryRun, at);
    const own = w.footprint(o).map((t) => w.idx(t.x, t.z));
    for (const i of own) w.objectGrid[i] = 0;
    const why = w.canPlaceObject(OBJECTS_BY_ID[o.defId], tx, tz, rot);
    for (const i of own) w.objectGrid[i] = o.id;
    if (why) return this.res(false, 0, why, dryRun, at);
    if (dryRun) return this.res(true, 0, undefined, true, at);
    w.removeObject(objectId);
    w.addObject(o.defId, tx, tz, rot, o.seed);
    return this.res(true, 0, undefined, false, at);
  }

  renameHabitat(habitatId: number, name: string): CommandResult {
    const n = name.replace(/\s+/g, ' ').trim().slice(0, 32);
    if (!this.world.habitats.has(habitatId)) return this.res(false, 0, 'No such habitat', false);
    if (!n) return this.res(false, 0, 'Please enter a name', false);
    this.world.renameHabitat(habitatId, n);
    return this.res(true, 0, undefined, false);
  }

  staffSettlement(staffId: number): number {
    const s = this.staff.get(staffId);
    return s ? Math.round((s.salary * this.minuteOfDay) / 1440) : 0;
  }
  serviceStats(objectId: number): ServiceDayStats | null {
    const o = this.world.objects.get(objectId);
    const def = o && OBJECTS_BY_ID[o.defId];
    if (!def || !(def.shop || def.restroom)) return null;
    return def.shop ? { visits: 14, sold: 22, income: 88, gaveUp: 1, queue: 3 } : { visits: 31, sold: 0, income: 0, gaveUp: 0, queue: 2 };
  }
  staffStats(staffId: number): StaffDayStats | null {
    return this.staff.has(staffId) ? { cleaned: 7, serviced: 2, treated: 0, recaptured: 0 } : null;
  }
  pregnancy(animalId: number): { day: number; of: number } | null {
    const a = this.animals.get(animalId);
    const sp = a && SPECIES_BY_ID[a.speciesId];
    return a && sp && a.pregnantDays > 0 ? { day: Math.min(sp.gestationDays, Math.floor(a.pregnantDays) + 1), of: sp.gestationDays } : null;
  }
  staffWage(role: StaffRole): number {
    return SALARY[role] ?? 0;
  }

  terrainCost(terrain: Terrain): number {
    return isWater(terrain) ? 12 : 4;
  }

  removeFences(edges: EdgeRef[], dryRun = false): CommandResult {
    const w = this.world;
    const todo = edges.filter((e) => w.getFence(e));
    const refund = todo.reduce((s, e) => s + Math.round(FENCES_BY_ID[w.getFence(e)].costPerSegment * 0.4), 0);
    if (!todo.length) return this.res(false, 0, 'No fence to remove', dryRun);
    if (dryRun) return this.res(true, -refund, undefined, true);
    for (const e of todo) w.setFence(e, 0, false);
    w.recomputeHabitats();
    return this.res(true, -refund, undefined, false);
  }

  buyAnimal(speciesId: string, wx: number, wz: number, dryRun = false): CommandResult {
    const w = this.world;
    const sp = SPECIES_BY_ID[speciesId];
    const t = w.tileOfWorld(wx, wz);
    const at = { x: wx, z: wz };
    const hab = w.habitatAt(t.x, t.z);
    if (!hab) return this.res(false, sp.cost, 'Animals must be placed inside a fenced habitat', dryRun, at);
    if (w.isTileSolid(t.x, t.z)) return this.res(false, sp.cost, 'Something is in the way — pick an open spot', dryRun, at);
    if (!this.canAfford(sp.cost)) return this.res(false, sp.cost, this.noMoney(sp.cost), dryRun, at);
    const warn = hab.minFenceStrength < sp.danger ? `The fence is too weak for a ${sp.name}` : undefined;
    if (dryRun) return this.res(true, sp.cost, undefined, true, at, warn);
    const id = this.nextId++;
    this.animals.set(id, {
      id,
      speciesId,
      name: NAMES[id % NAMES.length],
      sex: id % 2 ? 'M' : 'F',
      ageDays: 20,
      growth: 1,
      x: wx,
      y: w.heightAt(wx, wz),
      z: wz,
      heading: 0,
      speed: 0,
      action: 'idle',
      actionTime: 0,
      habitatId: hab.id,
      needs: { hunger: 1, thirst: 1, energy: 1, social: 0.5, environment: 0.5, space: 1, enrichment: 0.5 },
      happiness: 0.6,
      health: 1,
      pregnantDays: 0,
      escaped: false,
      seed: id,
    });
    this.events.emit('animalAdded', { id });
    return this.res(true, sp.cost, undefined, false, at, warn);
  }

  moveAnimal(animalId: number, wx: number, wz: number, dryRun = false): CommandResult {
    const w = this.world;
    const a = this.animals.get(animalId);
    const t = w.tileOfWorld(wx, wz);
    const at = { x: wx, z: wz };
    const hab = w.habitatAt(t.x, t.z);
    if (!a) return this.res(false, 0, 'No such animal', dryRun, at);
    if (!hab) return this.res(false, 0, 'Animals must be placed inside a fenced habitat', dryRun, at);
    if (dryRun) return this.res(true, 0, undefined, true, at);
    a.x = wx;
    a.z = wz;
    a.y = w.heightAt(wx, wz);
    a.habitatId = hab.id;
    return this.res(true, 0, undefined, false, at);
  }

  sellAnimal(animalId: number, dryRun = false): CommandResult {
    const a = this.animals.get(animalId);
    if (!a) return this.res(false, 0, 'No such animal', dryRun);
    const v = Math.round(SPECIES_BY_ID[a.speciesId].cost * 0.5);
    if (dryRun) return this.res(true, -v, undefined, true);
    this.animals.delete(animalId);
    this.events.emit('animalRemoved', { id: animalId });
    this.events.emit('notify', { text: `${a.name} was rehomed for ${money(v)}.`, kind: 'info', focus: { x: a.x, z: a.z } });
    return this.res(true, -v, undefined, false, { x: a.x, z: a.z });
  }

  hireStaff(role: StaffRole, wx: number, wz: number, dryRun = false): CommandResult {
    const w = this.world;
    const t = w.tileOfWorld(wx, wz);
    let best: { x: number; z: number } | null = null;
    let bd = 1e9;
    for (let z = t.z - 4; z <= t.z + 4; z++)
      for (let x = t.x - 4; x <= t.x + 4; x++)
        if (w.isPath(x, z)) {
          const d = (x - t.x) ** 2 + (z - t.z) ** 2;
          if (d < bd) {
            bd = d;
            best = { x, z };
          }
        }
    const sal = SALARY[role];
    if (!best) return this.res(false, sal, 'Staff must be placed on a path', dryRun, { x: wx, z: wz });
    if (!this.canAfford(sal)) return this.res(false, sal, this.noMoney(sal), dryRun);
    // like the sim: nothing is charged at hire, wages are paid at day end
    if (dryRun) return this.res(true, 0, undefined, true);
    const s = this.hire(role, best.x, best.z);
    this.events.emit('notify', { text: `${s.name} joined the team.`, kind: 'good', focus: { x: s.x, z: s.z } });
    return this.res(true, 0, undefined, false, { x: s.x, z: s.z });
  }

  fireStaff(staffId: number): CommandResult {
    const s = this.staff.get(staffId);
    if (!s) return this.res(false, 0, 'No such staff member', false);
    this.staff.delete(staffId);
    this.events.emit('staffRemoved', { id: staffId });
    return this.res(true, 0, undefined, false);
  }

  setAdmission(price: number): void {
    this.admissionPrice = Math.max(0, Math.round(price));
  }

  setSpeed(speed: SimSpeed): void {
    this.speed = speed;
  }

  habitatReport(habitatId: number): HabitatReport | null {
    const h = this.world.habitats.get(habitatId);
    if (!h) return null;
    const animals = Array.from(this.animals.values()).filter((a) => a.habitatId === habitatId);
    const species = Array.from(new Set(animals.map((a) => a.speciesId)));
    const tot = Math.max(1, h.tiles.length);
    return {
      habitatId,
      name: h.name,
      area: h.tiles.length,
      animals: animals.map((a) => a.id),
      species,
      suitability: species.map((s) => this.suitability(s, habitatId)),
      terrainFractions: h.terrainCounts.map((c) => c / tot),
      viewable: h.viewTiles.length > 0,
    };
  }

  suitability(speciesId: string, habitatId: number): SpeciesSuitability {
    const sp = SPECIES_BY_ID[speciesId];
    const h = this.world.habitats.get(habitatId);
    if (!sp || !h) return { speciesId, score: 0, terrain: 0, foliage: 0, space: 0, crowded: 'no', fenceOk: false, hasWater: false, hasFood: false, issues: ['Unknown habitat'] };
    const tot = Math.max(1, h.tiles.length);
    let diff = 0;
    for (let t = 0; t < TERRAIN_COUNT; t++) diff += Math.abs((sp.terrain[t as Terrain] ?? 0) - h.terrainCounts[t] / tot);
    const terrain = Math.max(0, 1 - diff * 0.6);
    const liked = h.objects.filter((id) => {
      const o = this.world.objects.get(id);
      return o && sp.likes.includes(o.defId);
    }).length;
    const foliage = Math.min(1, liked / Math.max(1, tot * sp.foliageDensity));
    const n = Array.from(this.animals.values()).filter((a) => a.habitatId === habitatId && a.speciesId === speciesId).length;
    const space = Math.min(1, tot / Math.max(1, (n || 1) * sp.spacePerAnimal));
    const fenceOk = h.minFenceStrength >= sp.danger;
    const hasWater = h.terrainCounts[Terrain.Water] + h.terrainCounts[Terrain.DeepWater] > 0;
    const hasFood = h.objects.some((id) => OBJECTS_BY_ID[this.world.objects.get(id)?.defId ?? '']?.serves === 'food');
    const issues: string[] = [];
    let best = -1,
      bestT = 0;
    for (let t = 0; t < TERRAIN_COUNT; t++) {
      const want = (sp.terrain[t as Terrain] ?? 0) - h.terrainCounts[t] / tot;
      if (want > best) {
        best = want;
        bestT = t;
      }
    }
    if (best > 0.1) issues.push(`Needs more ${TERRAIN_INFO[bestT].name.toLowerCase()}`);
    if (foliage < 0.6) issues.push('Would like more plants and rocks it knows');
    if (space < 0.8) issues.push('Too crowded for this many animals');
    if (!fenceOk) issues.push('Fence is too weak');
    if (!hasFood) issues.push('No feeder in the habitat');
    const score = Math.max(0, Math.min(1, terrain * 0.4 + foliage * 0.25 + space * 0.2 + (hasWater ? 0.08 : 0) + (hasFood ? 0.07 : 0) - (fenceOk ? 0 : 0.2)));
    const crowded = space < 0.7 ? 'severe' : space < 0.95 ? 'mild' : 'no';
    return { speciesId, score, terrain, foliage, space, crowded, fenceOk, hasWater, hasFood, issues };
  }

  serialize(): SimSave {
    return { version: 1, world: this.world.serialize(), money: this.money };
  }

  load(_save: SimSave): void {
    /* not needed for the harness */
  }
}

// ===========================================================================
// Render context
// ===========================================================================

function qualityOf(level: QualityLevel): QualitySettings {
  return {
    level,
    pixelRatio: 1,
    antialias: true,
    shadows: false,
    shadowMapSize: 1024,
    grassDensity: 0,
    postFX: false,
    detailDistance: 60,
    creatureDetail: level === 'low' ? 0 : level === 'medium' ? 1 : 2,
  };
}

export class MockRenderContext implements IRenderContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  quality: QualitySettings;
  readonly nightFactor = 0;
  readonly sunDirection = new THREE.Vector3(0.45, 0.75, 0.35).normalize();
  private terrain: THREE.Mesh;
  private offs: (() => void)[] = [];

  constructor(
    container: HTMLElement,
    private world: World,
    events: EventBus,
    level: QualityLevel = 'medium',
  ) {
    this.quality = qualityOf(level);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.3, 2000);
    this.scene.background = new THREE.Color(0xa9c4d6);
    this.scene.fog = new THREE.Fog(0xb8cbd6, 160, 420);
    const hemi = new THREE.HemisphereLight(0xdde8f2, 0x4a4632, 1.25);
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.position.copy(this.sunDirection).multiplyScalar(100);
    this.scene.add(hemi, sun);
    // a simple environment so PBR props / ghosts look plausible
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0x9fb6c4);
    this.scene.environment = pm.fromScene(envScene, 0.02).texture;
    pm.dispose();

    const outer = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), new THREE.MeshStandardMaterial({ color: 0x55703a, roughness: 1 }));
    outer.rotation.x = -Math.PI / 2;
    outer.position.set(WORLD_W / 2, 0.02, WORLD_H / 2);
    this.scene.add(outer);
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_W, WORLD_H),
      new THREE.MeshStandardMaterial({ color: 0x3d6f80, roughness: 0.15, metalness: 0.0, transparent: true, opacity: 0.82 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(WORLD_W / 2, WATER_LEVEL, WORLD_H / 2);
    this.scene.add(water);

    this.terrain = new THREE.Mesh(this.buildTerrain(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    this.scene.add(this.terrain);
    const rebuild = () => {
      this.terrain.geometry.dispose();
      this.terrain.geometry = this.buildTerrain();
    };
    this.offs.push(events.on('terrainChanged', rebuild), events.on('pathChanged', rebuild), events.on('worldReset', rebuild));
  }

  private buildTerrain(): THREE.BufferGeometry {
    const w = this.world;
    const pos = new Float32Array(MAP_W * MAP_H * 4 * 3);
    const col = new Float32Array(MAP_W * MAP_H * 4 * 3);
    const idx = new Uint32Array(MAP_W * MAP_H * 6);
    const c = new THREE.Color();
    const pathCol: Record<number, number> = { [PathType.Paved]: 0xcfc6b4, [PathType.Gravel]: 0xb3a68e, [PathType.Boardwalk]: 0x8a6440 };
    let v = 0,
      k = 0;
    for (let z = 0; z < MAP_H; z++)
      for (let x = 0; x < MAP_W; x++) {
        const p = w.getPath(x, z);
        c.set(p ? pathCol[p] : TERRAIN_INFO[w.getTerrain(x, z)].color);
        const n = ((x * 928371 + z * 1231) % 97) / 97;
        c.multiplyScalar(0.92 + n * 0.12);
        const base = v;
        for (const [dx, dz] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ]) {
          pos[v * 3] = (x + dx) * TILE;
          pos[v * 3 + 1] = w.cornerHeight(x + dx, z + dz) + (p ? 0.03 : 0);
          pos[v * 3 + 2] = (z + dz) * TILE;
          col[v * 3] = c.r;
          col[v * 3 + 1] = c.g;
          col[v * 3 + 2] = c.b;
          v++;
        }
        idx[k++] = base;
        idx[k++] = base + 2;
        idx[k++] = base + 1;
        idx[k++] = base + 1;
        idx[k++] = base + 2;
        idx[k++] = base + 3;
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    return g;
  }

  setTimeOfDay(): void {}
  settle(): void {}
  setFocus(): void {}
  update(): void {}

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  pickGround(ndcX: number, ndcY: number): THREE.Vector3 | null {
    const o = new THREE.Vector3().setFromMatrixPosition(this.camera.matrixWorld);
    const d = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(this.camera).sub(o).normalize();
    if (d.y >= -1e-4) return null;
    let t = Math.max(0, (o.y - 1) / -d.y);
    for (let i = 0; i < 2000; i++) {
      const x = o.x + d.x * t,
        y = o.y + d.y * t,
        z = o.z + d.z * t;
      const inside = x >= 0 && z >= 0 && x <= WORLD_W && z <= WORLD_H;
      const ground = inside ? Math.max(this.world.heightAt(x, z), WATER_LEVEL) : 0.02;
      if (y <= ground) return new THREE.Vector3(x, ground, z);
      t += 0.25;
    }
    return null;
  }

  setQuality(level: QualityLevel): void {
    this.quality = qualityOf(level);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.renderer.dispose();
  }
}

// ===========================================================================
// Props
// ===========================================================================

function stdMat(color: number, rough = 0.85, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, ...extra });
}

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
  cone: new THREE.ConeGeometry(0.5, 1, 10),
  sphere: new THREE.SphereGeometry(0.5, 14, 10),
  rock: new THREE.DodecahedronGeometry(0.5, 0),
};

function part(geo: THREE.BufferGeometry, mat: THREE.Material, owned: THREE.Material[], sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  if (!owned.includes(mat)) owned.push(mat);
  return m;
}

export function mockObjectModel(defId: string, seed: number): THREE.Object3D {
  const def = OBJECTS_BY_ID[defId];
  const g = new THREE.Group();
  const owned: THREE.Material[] = [];
  const [w, d] = def ? def.size : [1, 1];
  const W = w * TILE,
    D = d * TILE;
  const cat = def?.category ?? 'decoration';
  const r = 0.9 + ((seed * 9301 + 49297) % 233280) / 233280 * 0.2;
  if (cat === 'tree') {
    const trunk = stdMat(0x5b4632);
    const leaf = stdMat(defId === 'tree_acacia' ? 0x5f6e34 : defId === 'tree_pine' ? 0x2e4a2c : 0x4b6b30);
    const h = (defId === 'tree_baobab' ? 9 : 7) * r;
    g.add(part(GEO.cyl, trunk, owned, 0.35 * W * 0.5, h * 0.6, 0.35 * W * 0.5, 0, h * 0.3, 0));
    if (defId === 'tree_acacia') g.add(part(GEO.sphere, leaf, owned, 5.5, 1.3, 5.5, 0, h * 0.65, 0));
    else if (defId === 'tree_pine') g.add(part(GEO.cone, leaf, owned, 3, h * 0.8, 3, 0, h * 0.6, 0));
    else g.add(part(GEO.sphere, leaf, owned, 4.2, 3.8, 4.2, 0, h * 0.7, 0));
  } else if (cat === 'plant') {
    g.add(part(GEO.sphere, stdMat(defId === 'cactus' ? 0x4f6d3c : 0x667a3c), owned, 1.4, defId === 'cactus' ? 2.6 : 0.9, 1.4, 0, 0.45, 0));
  } else if (cat === 'rock') {
    g.add(part(GEO.rock, stdMat(defId === 'rock_ice' ? 0xd5e3ea : 0x8b8478, 0.95), owned, W * 0.8, defId === 'rock_outcrop' ? 2.4 : 1.1, D * 0.8, 0, 0.4, 0));
  } else if (cat === 'shop' || cat === 'facility' || cat === 'shelter') {
    const wall = stdMat(cat === 'shelter' ? 0x7b5a3a : 0xd8cbb0);
    const roof = stdMat(cat === 'shop' ? 0x8a3b2e : 0x4c3b2c);
    g.add(part(GEO.box, wall, owned, W * 0.85, 2.6, D * 0.85, 0, 1.3, 0));
    g.add(part(GEO.box, roof, owned, W * 0.95, 0.3, D * 0.95, 0, 2.75, 0));
  } else if (cat === 'feeder') {
    g.add(part(GEO.box, stdMat(0x6b5136), owned, 1.4, 0.8, 1.0, 0, 0.4, 0));
  } else if (defId === 'lamp') {
    g.add(part(GEO.cyl, stdMat(0x2a2b2c, 0.5, { metalness: 0.6 }), owned, 0.12, 3.4, 0.12, 0, 1.7, 0));
    g.add(part(GEO.sphere, stdMat(0xf5e6c0, 0.3, { emissive: 0x332a10 }), owned, 0.4, 0.5, 0.4, 0, 3.5, 0));
  } else if (defId === 'bench' || defId === 'picnic_table') {
    const wood = stdMat(0x7a5634);
    g.add(part(GEO.box, wood, owned, 1.6, 0.08, 0.5, 0, 0.45, 0));
    g.add(part(GEO.box, wood, owned, 1.6, 0.4, 0.08, 0, 0.75, -0.22));
  } else {
    g.add(part(GEO.box, stdMat(0x8f7f62), owned, W * 0.6, 0.9, D * 0.6, 0, 0.45, 0));
  }
  g.userData.ownedMaterials = owned;
  return g;
}

export function mockFenceSegment(fenceId: number): THREE.Object3D {
  const g = new THREE.Group();
  const owned: THREE.Material[] = [];
  const def = FENCES_BY_ID[fenceId];
  const h = def?.height ?? 1.5;
  const key = def?.key ?? 'wood';
  const postMat = stdMat(key === 'wood' ? 0x6b4e33 : key === 'stone' ? 0x8d8577 : 0x4d5257, key === 'steel' || key === 'chainlink' ? 0.45 : 0.9, { metalness: key === 'steel' || key === 'chainlink' ? 0.6 : 0 });
  for (const x of [-TILE / 2, TILE / 2]) g.add(part(GEO.box, postMat, owned, 0.14, h, 0.14, x, h / 2, 0));
  if (key === 'stone') g.add(part(GEO.box, stdMat(0x9a9282, 0.95), owned, TILE, h * 0.95, 0.45, 0, h * 0.475, 0));
  else if (key === 'glass') g.add(part(GEO.box, stdMat(0xbfd8e0, 0.05, { transparent: true, opacity: 0.35 }), owned, TILE, h * 0.9, 0.05, 0, h * 0.5, 0));
  else if (key === 'chainlink') g.add(part(GEO.box, stdMat(0x8f979c, 0.6, { metalness: 0.5, transparent: true, opacity: 0.55 }), owned, TILE, h * 0.92, 0.02, 0, h * 0.5, 0));
  else if (key === 'steel') for (let i = -4; i <= 4; i++) g.add(part(GEO.box, postMat, owned, 0.05, h, 0.05, i * 0.22, h / 2, 0));
  else for (const y of [0.45, 0.95]) g.add(part(GEO.box, postMat, owned, TILE, 0.1, 0.06, 0, y * h, 0));
  g.userData.ownedMaterials = owned;
  return g;
}

export class MockProps implements IPropsLayer {
  readonly root = new THREE.Group();
  private objs = new Map<number, THREE.Object3D>();
  private fences = new THREE.Group();
  private highlighted: number | null = null;
  private offs: (() => void)[] = [];

  constructor(
    private world: World,
    events: EventBus,
    scene: THREE.Scene,
  ) {
    scene.add(this.root);
    this.root.add(this.fences);
    this.offs.push(
      events.on('objectAdded', (e) => this.add(e.id)),
      events.on('objectRemoved', (e) => this.remove(e.id)),
      events.on('fenceChanged', () => this.rebuildFences()),
      events.on('habitatsChanged', () => this.rebuildFences()),
      events.on('terrainChanged', () => this.syncHeights()),
      events.on('worldReset', () => this.rebuildAll()),
    );
    this.rebuildAll();
  }

  private add(id: number): void {
    const o = this.world.objects.get(id);
    if (!o || this.objs.has(id)) return;
    const m = mockObjectModel(o.defId, o.seed);
    const c = this.world.objectCenter(o);
    m.position.set(c.x, c.y, c.z);
    m.rotation.y = (o.rot * Math.PI) / 2;
    m.traverse((x) => (x.userData.objectId = id));
    this.objs.set(id, m);
    this.root.add(m);
  }

  private remove(id: number): void {
    const m = this.objs.get(id);
    if (!m) return;
    this.root.remove(m);
    for (const mat of m.userData.ownedMaterials as THREE.Material[]) mat.dispose();
    this.objs.delete(id);
  }

  private syncHeights(): void {
    for (const [id, m] of this.objs) {
      const o = this.world.objects.get(id);
      if (o) m.position.y = this.world.objectCenter(o).y;
    }
  }

  private rebuildAll(): void {
    for (const id of Array.from(this.objs.keys())) this.remove(id);
    for (const id of this.world.objects.keys()) this.add(id);
    this.rebuildFences();
  }

  private rebuildFences(): void {
    for (const c of this.fences.children) for (const m of c.userData.ownedMaterials as THREE.Material[]) m.dispose();
    this.fences.clear();
    const w = this.world;
    const place = (e: EdgeRef, id: number) => {
      const s = mockFenceSegment(id);
      const cx = e.dir === 'h' ? (e.x + 0.5) * TILE : e.x * TILE;
      const cz = e.dir === 'h' ? e.z * TILE : (e.z + 0.5) * TILE;
      s.position.set(cx, w.heightAt(cx, cz), cz);
      s.rotation.y = e.dir === 'h' ? 0 : -Math.PI / 2;
      this.fences.add(s);
    };
    for (let z = 0; z <= MAP_H; z++) for (let x = 0; x < MAP_W; x++) if (w.hFence[w.hIdx(x, z)]) place({ dir: 'h', x, z }, w.hFence[w.hIdx(x, z)]);
    for (let z = 0; z < MAP_H; z++) for (let x = 0; x <= MAP_W; x++) if (w.vFence[w.vIdx(x, z)]) place({ dir: 'v', x, z }, w.vFence[w.vIdx(x, z)]);
  }

  update(): void {}

  setQuality(_quality: QualitySettings): void {}

  async prewarm(onProgress?: (fraction: number) => void): Promise<void> {
    onProgress?.(1);
  }

  createObjectModel(defId: string, seed: number): THREE.Object3D {
    return mockObjectModel(defId, seed);
  }

  createFenceSegmentModel(fenceId: number): THREE.Object3D {
    return mockFenceSegment(fenceId);
  }

  setLitter(): void {}

  pickObject(raycaster: THREE.Raycaster): number | null {
    const hits = raycaster.intersectObjects(Array.from(this.objs.values()), true);
    for (const h of hits) {
      const id = h.object.userData.objectId as number | undefined;
      if (id) return id;
    }
    return null;
  }

  setHighlight(objectId: number | null): void {
    const set = (id: number | null, on: boolean) => {
      const m = id ? this.objs.get(id) : undefined;
      if (!m) return;
      for (const mat of m.userData.ownedMaterials as THREE.MeshStandardMaterial[]) mat.emissive?.setHex(on ? 0x2c4a18 : 0x000000);
    };
    set(this.highlighted, false);
    this.highlighted = objectId;
    set(objectId, true);
  }

  dispose(): void {
    for (const off of this.offs) off();
  }
}

// ===========================================================================
// Creatures
// ===========================================================================

const SPECIES_COLOR: Record<string, number> = {
  elephant: 0x7d7a75,
  giraffe: 0xc89a55,
  zebra: 0xd9d6cf,
  lion: 0xb98b4e,
  tiger: 0xc77a35,
  grizzly: 0x5a4030,
  polarbear: 0xece6d8,
  hippo: 0x7c6a6a,
  rhino: 0x8a857c,
  gazelle: 0xb88a55,
  camel: 0xc6a066,
  gorilla: 0x2f2b29,
  penguin: 0x26292c,
  flamingo: 0xe9a0a0,
};

class CapsuleModel implements CreatureModel {
  readonly object = new THREE.Group();
  readonly height: number;
  readonly radius: number;
  private mats: THREE.MeshStandardMaterial[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private t = Math.random() * 10;
  private body: THREE.Object3D;

  constructor(color: number, height: number, length: number, upright: boolean) {
    this.height = height;
    this.radius = Math.max(0.3, (upright ? height * 0.2 : length * 0.5));
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
    this.mats.push(mat);
    const body = new THREE.Group();
    if (upright) {
      const r = height * 0.16;
      const g = new THREE.CapsuleGeometry(r, height - 2 * r - height * 0.18, 6, 12);
      this.geos.push(g);
      const m = new THREE.Mesh(g, mat);
      m.position.y = (height - height * 0.18) / 2;
      const hg = new THREE.SphereGeometry(height * 0.09, 12, 10);
      this.geos.push(hg);
      const head = new THREE.Mesh(hg, mat);
      head.position.y = height - height * 0.09;
      body.add(m, head);
    } else {
      const r = Math.min(height * 0.28, length * 0.25);
      const g = new THREE.CapsuleGeometry(r, Math.max(0.05, length - 2 * r), 6, 12);
      g.rotateX(Math.PI / 2);
      this.geos.push(g);
      const m = new THREE.Mesh(g, mat);
      m.position.y = height * 0.62;
      const lg = new THREE.CylinderGeometry(r * 0.22, r * 0.18, height * 0.62, 8);
      lg.translate(0, height * 0.31, 0);
      this.geos.push(lg);
      for (const [x, z] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        const leg = new THREE.Mesh(lg, mat);
        leg.position.set(x * r * 0.55, 0, z * (length / 2 - r * 0.8));
        body.add(leg);
      }
      const hg = new THREE.SphereGeometry(r * 0.6, 12, 10);
      this.geos.push(hg);
      const head = new THREE.Mesh(hg, mat);
      head.position.set(0, height * 0.85, length / 2);
      body.add(m, head);
    }
    this.body = body;
    this.object.add(body);
  }

  update(dt: number, anim: CreatureAnim): void {
    this.t += dt * (anim.speed > 0 ? 8 : 1.5);
    this.body.position.y = anim.speed > 0 ? Math.abs(Math.sin(this.t)) * 0.05 : 0;
  }

  setGrowth(growth: number): void {
    const s = 0.5 + 0.5 * growth;
    this.object.scale.setScalar(s);
  }

  setHighlighted(on: boolean): void {
    for (const m of this.mats) m.emissive.setHex(on ? 0x2a4a14 : 0);
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
    for (const g of this.geos) g.dispose();
  }
}

export class MockCreatures implements ICreatureFactory {
  readonly root = new THREE.Group();
  update(_camera: THREE.Camera): void {}
  setQuality(_quality: QualitySettings): void {}
  async preload(_ids: string[], onProgress?: (f: number) => void): Promise<void> {
    onProgress?.(1);
  }
  createAnimal(speciesId: string, opts: { seed: number; sex: 'M' | 'F'; growth: number }): CreatureModel {
    const sp = SPECIES_BY_ID[speciesId];
    const m = new CapsuleModel(SPECIES_COLOR[speciesId] ?? 0x8a7a60, sp?.height ?? 1, sp?.length ?? 1.5, sp?.rig === 'penguin' || sp?.rig === 'primate');
    m.setGrowth(opts.growth);
    return m;
  }
  createHuman(appearance: HumanAppearance, _role: 'guest' | StaffRole, _seed: number): CreatureModel {
    return new CapsuleModel(appearance.shirt, appearance.height, 0.4, true);
  }
}

// ===========================================================================
// Audio
// ===========================================================================

/** Silent audio that records cues (window.__cues) so the harness can check UI sounds. */
export class MockAudio implements IAudio {
  enabled = true;
  readonly cues: string[] = [];
  update(_dt: number, _camera: THREE.Camera, _focus: THREE.Vector3): void {}
  play(cue: Parameters<IAudio['play']>[0]): void {
    this.cues.push(cue);
    if (this.cues.length > 200) this.cues.shift();
  }
  setEnabled(on: boolean): void {
    this.enabled = on;
  }
  resume(): void {}
  suspend(): void {}
  dispose(): void {}
}

// ===========================================================================
// Entity views
// ===========================================================================

export class MockViews implements IEntityViews {
  private models = new Map<string, { kind: 'animal' | 'guest' | 'staff'; id: number; model: CreatureModel }>();
  private root = new THREE.Group();
  private ring: THREE.Mesh;
  private selected: SelectionRef | null = null;
  private raycaster = new THREE.Raycaster();
  private sphere = new THREE.Sphere();
  private tmp = new THREE.Vector3();

  constructor(
    private sim: ISimulation,
    private ctx: IRenderContext,
    private creatures: ICreatureFactory,
  ) {
    ctx.scene.add(this.root);
    const g = new THREE.RingGeometry(0.85, 1, 40);
    g.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x9fe870, transparent: true, opacity: 0.85, depthWrite: false }));
    this.ring.visible = false;
    ctx.scene.add(this.ring);
  }

  update(dt: number): void {
    const live = new Set<string>();
    const sync = (kind: 'animal' | 'guest' | 'staff', e: { id: number; x: number; y: number; z: number; heading: number; speed: number }, make: () => CreatureModel, action: string) => {
      const k = `${kind}:${e.id}`;
      live.add(k);
      let v = this.models.get(k);
      if (!v) {
        v = { kind, id: e.id, model: make() };
        this.models.set(k, v);
        this.root.add(v.model.object);
      }
      v.model.object.position.set(e.x, e.y, e.z);
      v.model.object.rotation.y = e.heading;
      v.model.update(dt, { action, speed: e.speed });
    };
    for (const a of this.sim.animals.values()) sync('animal', a, () => this.creatures.createAnimal(a.speciesId, { seed: a.seed, sex: a.sex, growth: a.growth }), a.action);
    for (const g of this.sim.guests.values()) sync('guest', g, () => this.creatures.createHuman(g.appearance, 'guest', g.seed), g.action);
    for (const s of this.sim.staff.values()) sync('staff', s, () => this.creatures.createHuman(s.appearance, s.role, s.seed), s.action);
    for (const [k, v] of this.models)
      if (!live.has(k)) {
        this.root.remove(v.model.object);
        v.model.dispose();
        this.models.delete(k);
      }
    const sel = this.selected;
    if (sel && sel.kind !== 'object' && sel.kind !== 'habitat') {
      const v = this.models.get(`${sel.kind}:${sel.id}`);
      if (v) {
        this.ring.visible = true;
        this.ring.position.copy(v.model.object.position).setY(v.model.object.position.y + 0.06);
        this.ring.scale.setScalar(v.model.radius * 1.3 + 0.3);
      } else this.ring.visible = false;
    } else this.ring.visible = false;
  }

  pick(ndcX: number, ndcY: number): SelectionRef | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.ctx.camera);
    let best: SelectionRef | null = null;
    let bd = Infinity;
    for (const v of this.models.values()) {
      this.sphere.center.copy(v.model.object.position);
      this.sphere.center.y += v.model.height * 0.5;
      this.sphere.radius = Math.max(v.model.radius, v.model.height * 0.5) * 1.15 + 0.25;
      if (!this.raycaster.ray.intersectSphere(this.sphere, this.tmp)) continue;
      const d = this.raycaster.ray.distanceSqToPoint(this.sphere.center);
      if (d < bd) {
        bd = d;
        best = { kind: v.kind, id: v.id } as SelectionRef;
      }
    }
    return best;
  }

  setSelected(sel: SelectionRef | null): void {
    const set = (s: SelectionRef | null, on: boolean) => {
      if (!s || s.kind === 'object' || s.kind === 'habitat') return;
      this.models.get(`${s.kind}:${s.id}`)?.model.setHighlighted(on);
    };
    set(this.selected, false);
    this.selected = sel;
    set(sel, true);
  }

  positionOf(sel: SelectionRef): THREE.Vector3 | null {
    const v = this.models.get(`${sel.kind}:${sel.id}`);
    return v ? v.model.object.position.clone() : null;
  }

  dispose(): void {
    this.ctx.scene.remove(this.root, this.ring);
  }
}

