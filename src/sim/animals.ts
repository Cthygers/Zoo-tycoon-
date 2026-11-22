// Animal AI: needs, behaviour selection, steering inside the habitat (never
// through fences unless breaking out), swimming, herding, breeding, health,
// predators, escapes and dung.

import { GAME_MINUTES_PER_SECOND, MAP_W, TILE, WATER_LEVEL } from '../core/constants';
import { Terrain, type SpeciesDef } from '../core/types';
import { OBJECTS_BY_ID } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import { feederFor } from './habitat';
import { animalName, pluralName, singularName } from './names';
import { type Passable } from './nav';
import type { Simulation } from './simulation';
import { ANIMAL_ACTION_FOR_GOAL, NO_FACE, type AnimalGoal, type AnimalSim } from './state';

const TWO_PI = Math.PI * 2;
const BIRTH_GROWTH = 0.3;
/** Escaped animals are picked up by an outside rescue team after this many seconds (≈ one game day). */
const RESCUE_AFTER = 300;
const RESCUE_FEE = 500;

function wrapAngle(a: number): number {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

/** Food units a species eats relative to a medium animal. */
export function foodScale(sp: SpeciesDef): number {
  return Math.max(0.15, Math.min(5, (sp.height * sp.length) / 3));
}
/** Collision radius (m). */
export function bodyRadius(sp: SpeciesDef, growth: number): number {
  return Math.max(0.15, Math.min(1.2, sp.length * 0.24)) * (0.45 + 0.55 * growth);
}
/** Minimum distance kept from fences (m). */
function fenceMargin(sp: SpeciesDef, growth: number): number {
  return Math.max(0.25, Math.min(0.95, sp.length * 0.32)) * (0.5 + 0.5 * growth);
}
function turnRate(sp: SpeciesDef): number {
  return Math.max(1.0, Math.min(4.0, 3.2 / Math.sqrt(Math.max(0.5, sp.length / 1.5))));
}
function thirstRate(sp: SpeciesDef): number {
  return sp.id === 'camel' ? 0.35 : 1;
}

export interface CreateAnimalOpts {
  adult?: boolean;
  growth?: number;
  mother?: number;
  sex?: 'M' | 'F';
}

export class AnimalSystem {
  /** Animals bucketed per habitat id (0 = loose) — rebuilt each step, arrays reused. */
  private buckets = new Map<number, AnimalSim[]>();
  /** Escaped animals (refreshed every slow tick) for guests/staff. */
  readonly loose: AnimalSim[] = [];
  // passability context (avoids allocating closures per query)
  private ctxZone = 0;
  private ctxSwims = false;
  /** Species may wade into shallow water (swimmers and tall animals). */
  private ctxWades = false;
  private readonly pass: Passable;
  private readonly enterTest: (t: number) => boolean;
  private tmpRoute: number[] = [];
  private solid: Uint8Array = new Uint8Array(0);
  /** Path searches still allowed this step (spreads planning spikes over frames). */
  private routeBudget = 0;

  constructor(private sim: Simulation) {
    this.pass = (a, b) => this.passable(a, b);
    this.enterTest = (t) => this.enterable(t);
  }

  // ================================================================ create
  create(speciesId: string, wx: number, wz: number, opts: CreateAnimalOpts = {}): AnimalSim {
    const sim = this.sim;
    const sp = SPECIES_BY_ID[speciesId];
    const rng = sim.rng;
    const id = sim.nextIds.animal++;
    const t = sim.world.tileOfWorld(wx, wz);
    const hid = sim.world.inBounds(t.x, t.z) ? sim.world.habitatOf[sim.world.idx(t.x, t.z)] : 0;
    const adult = opts.adult ?? false;
    const growth = adult ? 1 : opts.growth ?? BIRTH_GROWTH;
    const a: AnimalSim = {
      id,
      speciesId,
      name: animalName(rng),
      sex: opts.sex ?? (rng.chance(0.5) ? 'M' : 'F'),
      ageDays: adult ? Math.round(rng.range(0.22, 0.42) * sp.lifespanDays) : 0,
      growth,
      x: wx,
      y: sim.world.heightAt(wx, wz),
      z: wz,
      heading: rng.range(-Math.PI, Math.PI),
      speed: 0,
      action: 'idle',
      actionTime: 0,
      habitatId: hid || null,
      needs: {
        hunger: rng.range(0.7, 0.9),
        thirst: rng.range(0.7, 0.9),
        energy: rng.range(0.7, 0.95),
        social: 0.6,
        environment: 0.6,
        space: 1,
        enrichment: 0.6,
      },
      happiness: 0.7,
      health: 1,
      pregnantDays: 0,
      escaped: !hid,
      seed: rng.int(0, 0x7fffffff),
      home: hid,
      goal: 'idle',
      goalTime: rng.range(0.5, 2),
      moving: false,
      tgtX: wx,
      tgtZ: wz,
      route: [],
      routeIdx: 0,
      ref: 0,
      think: 1,
      stuck: 0,
      mother: opts.mother ?? 0,
      breedCooldown: adult ? rng.range(1, 4) : sp.maturityDays,
      sick: false,
      dungIn: rng.range(3, 12),
      stress: 0,
      escapeTime: 0,
      crossing: false,
      sinceCall: rng.range(0, 60),
      face: NO_FACE,
    };
    this.placeY(a, sp);
    sim.animals.set(id, a);
    return a;
  }

  remove(id: number) {
    if (!this.sim.animals.delete(id)) return;
    for (const a of this.sim.animals.values()) if (a.mother === id) a.mother = 0;
    this.sim.emitAnimalRemoved(id);
    this.sim.markPopulationDirty();
  }

  // ============================================================ passability
  private enterable(t: number): boolean {
    const w = this.sim.world;
    if (w.habitatOf[t] !== this.ctxZone) return false;
    if (this.solid[t]) return false;
    const ter = w.terrain[t];
    if (!this.ctxSwims && ter === Terrain.DeepWater) return false;
    if (!this.ctxWades && ter === Terrain.Water) return false;
    return true;
  }

  private passable(from: number, to: number): boolean {
    if (!this.enterable(to)) return false;
    const fx = from % MAP_W,
      fz = (from / MAP_W) | 0,
      tx = to % MAP_W,
      tz = (to / MAP_W) | 0;
    const dx = tx - fx,
      dz = tz - fz;
    if (dx > 1 || dx < -1 || dz > 1 || dz < -1) return false;
    if (dx !== 0 && dz !== 0) {
      if (!this.enterable(fz * MAP_W + tx) || !this.enterable(tz * MAP_W + fx)) return false;
    }
    return this.sim.world.canStep(fx, fz, tx, tz);
  }

  private setCtx(a: AnimalSim, sp: SpeciesDef) {
    this.solid = this.sim.solidMask();
    this.ctxZone = a.escaped ? 0 : a.habitatId ?? 0;
    this.ctxSwims = sp.swims;
    this.ctxWades = sp.swims || sp.height >= 1.2;
  }

  private tileOf(x: number, z: number): number {
    return Math.floor(z / TILE) * MAP_W + Math.floor(x / TILE);
  }

  /** Straight segment walkable (sampled every ~0.7 m)? */
  private lineClear(x0: number, z0: number, x1: number, z1: number): boolean {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.ceil(len / 0.7));
    let prev = this.tileOf(x0, z0);
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      const t = this.tileOf(x0 + (x1 - x0) * f, z0 + (z1 - z0) * f);
      if (t !== prev) {
        if (!this.passable(prev, t)) return false;
        prev = t;
      }
    }
    return true;
  }

  // =============================================================== routing
  /** Plan a route to (tx, tz). Returns false if unreachable. */
  private goTo(a: AnimalSim, sp: SpeciesDef, tx: number, tz: number, maxNodes = 3000): boolean {
    this.setCtx(a, sp);
    const start = this.tileOf(a.x, a.z);
    const goal = this.tileOf(tx, tz);
    a.route.length = 0;
    a.routeIdx = 0;
    if (start !== goal && !this.lineClear(a.x, a.z, tx, tz)) {
      if (this.routeBudget <= 0) return false;
      this.routeBudget--;
      const r = this.sim.search.route(start, goal, this.pass, maxNodes, this.tmpRoute);
      if (!r) return false;
      // drop the final tile (we walk to the exact target inside it)
      for (let i = 0; i < r.length - 1; i++) a.route.push(r[i]);
    }
    a.tgtX = tx;
    a.tgtZ = tz;
    a.moving = true;
    a.stuck = 0;
    return true;
  }

  private tileCentre(t: number, out: { x: number; z: number }) {
    out.x = ((t % MAP_W) + 0.5) * TILE;
    out.z = (((t / MAP_W) | 0) + 0.5) * TILE;
    return out;
  }
  private tc = { x: 0, z: 0 };

  // ================================================================ update
  update(dt: number, hours: number) {
    const sim = this.sim;
    this.routeBudget = 6;
    this.solid = sim.solidMask();
    // bucket by habitat for separation
    for (const arr of this.buckets.values()) arr.length = 0;
    for (const a of sim.animals.values()) {
      const sp = SPECIES_BY_ID[a.speciesId];
      if (!sp) continue;
      this.updateZone(a, sp);
      this.updateNeeds(a, sp, dt, hours);
      this.updateBehaviour(a, sp, dt);
      if (a.moving) this.move(a, sp, dt);
      else this.idleMotion(a, sp, dt);
      this.updateAction(a, sp, dt);
      const key = a.escaped ? 0 : a.habitatId ?? 0;
      let arr = this.buckets.get(key);
      if (!arr) {
        arr = [];
        this.buckets.set(key, arr);
      }
      arr.push(a);
    }
    for (const [key, arr] of this.buckets) if (key && arr.length > 1) this.separate(arr);
    // removals requested during the step (caught prey, deaths) are applied by the callers directly
  }

  private updateZone(a: AnimalSim, sp: SpeciesDef) {
    const w = this.sim.world;
    const t = this.tileOf(a.x, a.z);
    const hid = t >= 0 && t < w.habitatOf.length ? w.habitatOf[t] : 0;
    if (a.crossing) return;
    if (!a.escaped) {
      if (!hid) {
        // the enclosure was opened (fence removed / bulldozed)
        this.becomeLoose(a, `${a.name} the ${sp.name} got out — its habitat is no longer fenced in!`);
      } else if (hid !== a.habitatId) {
        a.habitatId = hid;
        a.home = hid;
        this.sim.markPopulationDirty();
      }
    } else if (hid) {
      // fenced in again (player built a fence around it, or it was carried home)
      a.escaped = false;
      a.habitatId = hid;
      a.home = hid;
      a.escapeTime = 0;
      a.goal = 'idle';
      a.goalTime = 2;
      a.moving = false;
      this.sim.markPopulationDirty();
      const hab = w.habitats.get(hid);
      this.sim.notify(`contain:${a.id}`, `${a.name} the ${sp.name} is safely contained in ${hab?.name ?? 'a habitat'}.`, 'good', { x: a.x, z: a.z }, 30);
    }
    // never stand inside solid objects or deep water we can't swim in
    this.setCtx(a, sp);
    if (!this.enterable(t)) this.unstick(a, sp, t);
  }

  private unstick(a: AnimalSim, sp: SpeciesDef, t: number) {
    const w = this.sim.world;
    // accept any tile of the same zone that is enterable
    const zone = this.ctxZone;
    const savedZone = this.ctxZone;
    const free = this.sim.search.nearest(
      t,
      (_f, to) => w.habitatOf[to] === zone,
      this.enterTest,
      2000,
    );
    this.ctxZone = savedZone;
    if (free >= 0) {
      this.tileCentre(free, this.tc);
      a.x = this.tc.x;
      a.z = this.tc.z;
      a.moving = false;
      a.route.length = 0;
      this.placeY(a, sp);
    }
  }

  private becomeLoose(a: AnimalSim, msg: string) {
    a.escaped = true;
    a.habitatId = null;
    a.escapeTime = 0;
    a.crossing = false;
    a.goal = 'roam';
    a.goalTime = 0;
    a.moving = false;
    a.route.length = 0;
    this.sim.markPopulationDirty();
    this.sim.notify(`escape:${a.id}`, msg, 'bad', { x: a.x, z: a.z }, 20);
  }

  // ================================================================= needs
  private updateNeeds(a: AnimalSim, sp: SpeciesDef, dt: number, h: number) {
    const n = a.needs;
    const sleeping = a.action === 'sleep';
    const slow = sleeping ? 0.5 : 1;
    n.hunger = Math.max(0, n.hunger - 0.055 * h * slow);
    n.thirst = Math.max(0, n.thirst - 0.075 * h * slow * thirstRate(sp));
    if (sleeping) n.energy = Math.min(1, n.energy + 0.16 * h);
    else if (a.action === 'sit') n.energy = Math.min(1, n.energy + 0.05 * h);
    else n.energy = Math.max(0, n.energy - 0.05 * h * (a.action === 'run' ? 3 : 1));
    a.sinceCall += dt;
    // growth of young animals
    if (a.growth < 1) {
      a.growth = Math.min(1, a.growth + ((h / 24) * (1 - BIRTH_GROWTH)) / Math.max(1, sp.maturityDays));
      if (a.growth >= 1) {
        a.mother = 0;
        this.sim.markPopulationDirty();
      }
    }
    if (a.pregnantDays > 0) {
      a.pregnantDays += h / 24;
      if (a.pregnantDays >= sp.gestationDays) this.giveBirth(a, sp);
    }
    if (a.escaped) a.escapeTime += dt;
  }

  /** Every 0.5 s (simulated): slow-moving needs, happiness, health, warnings. */
  slow(dt: number) {
    const sim = this.sim;
    this.loose.length = 0;
    const hoursDt = (dt * GAME_MINUTES_PER_SECOND) / 60;
    const dead: AnimalSim[] = [];
    for (const a of sim.animals.values()) {
      const sp = SPECIES_BY_ID[a.speciesId];
      if (!sp) continue;
      const n = a.needs;
      if (a.escaped) {
        this.loose.push(a);
        n.environment += (0.2 - n.environment) * Math.min(1, hoursDt * 0.6);
        n.space += (1 - n.space) * Math.min(1, hoursDt);
        a.stress = Math.min(1, a.stress + 0.02);
      } else if (a.habitatId) {
        const e = sim.evalFor(a.habitatId, a.speciesId);
        if (e) {
          const dirt = sim.habitatDirt(a.habitatId);
          const envT = 0.55 * e.terrain + 0.3 * e.foliage + 0.15 * (e.hasWater ? 1 : 0);
          const env = envT * (1 - 0.35 * dirt);
          const k = Math.min(1, hoursDt * 0.4);
          n.environment += (env - n.environment) * k;
          n.space += (e.space - n.space) * Math.min(1, hoursDt * 0.6);
          n.social += (e.social - n.social) * k;
          // enrichment drifts towards what the habitat offers (liked scenery, toys); playing tops it up
          const enrT = 0.3 + 0.35 * e.foliage + (e.toys > 0 ? 0.3 : 0) + 0.05 * e.terrain;
          if (n.enrichment > enrT) n.enrichment += (enrT - n.enrichment) * Math.min(1, hoursDt * 0.15);
          else n.enrichment += (enrT - n.enrichment) * Math.min(1, hoursDt * 0.3);
          const stressT = e.predators > 0 ? 1 : 0;
          a.stress += (stressT - a.stress) * Math.min(1, hoursDt * (stressT > a.stress ? 2 : 0.5));
        }
      }
      // happiness
      let hp =
        0.18 * n.hunger + 0.14 * n.thirst + 0.08 * n.energy + 0.14 * n.social + 0.2 * n.environment + 0.14 * n.space + 0.12 * n.enrichment;
      if (n.hunger < 0.15 || n.thirst < 0.15) hp *= 0.6;
      hp *= 0.6 + 0.4 * a.health;
      hp *= 1 - 0.5 * a.stress;
      a.happiness += (Math.max(0, Math.min(1, hp)) - a.happiness) * Math.min(1, hoursDt * 0.8);
      // health
      let dh = 0;
      if (n.hunger < 0.06 || n.thirst < 0.06) dh -= 0.012;
      if (a.sick) dh -= 0.004;
      if (a.ageDays > sp.lifespanDays) dh -= 0.003;
      if (!a.sick && n.hunger > 0.35 && n.thirst > 0.35 && a.ageDays <= sp.lifespanDays) dh += 0.006;
      a.health = Math.max(0, Math.min(1, a.health + dh * hoursDt));
      if (a.health <= 0) dead.push(a);
      this.warn(a, sp);
    }
    for (const a of dead) {
      const sp = SPECIES_BY_ID[a.speciesId];
      const old = a.ageDays > sp.lifespanDays;
      sim.notify(
        null,
        old
          ? `${a.name} the ${sp.name} passed away peacefully of old age.`
          : `${a.name} the ${sp.name} has died. Keep your animals fed, watered and healthy.`,
        'bad',
        { x: a.x, z: a.z },
      );
      this.remove(a.id);
    }
    // escaped animals unattended for too long are brought back by a rescue team
    for (const a of this.loose) {
      if (a.escapeTime > RESCUE_AFTER) {
        const sp = SPECIES_BY_ID[a.speciesId];
        if (this.returnHome(a)) {
          sim.spend('animalPurchases', RESCUE_FEE);
          sim.notify(null, `An animal rescue team returned ${a.name} the ${sp.name} (fee $${RESCUE_FEE}). Hire a vet or keeper to handle escapes.`, 'warn', { x: a.x, z: a.z });
        }
      }
    }
  }

  private warn(a: AnimalSim, sp: SpeciesDef) {
    const sim = this.sim;
    const hid = a.habitatId;
    if (a.escaped || !hid) return;
    const hab = sim.world.habitats.get(hid);
    const where = hab?.name ?? 'their habitat';
    const focus = { x: a.x, z: a.z };
    if (a.needs.hunger < 0.15) {
      const rt = sim.habitatRuntime(hid);
      const grazer = sp.diet === 'herbivore' && a.goal === 'graze';
      if (!grazer && (!rt || rt.food < 0.5))
        sim.notify(
          `hungry:${hid}`,
          sim.keeperCount()
            ? `The ${pluralName(sp.id)} in ${where} are hungry — keepers can’t keep up (hire more or build paths to the habitat).`
            : `The ${pluralName(sp.id)} in ${where} are hungry! Hire a keeper.`,
          'bad',
          focus,
          150,
        );
    }
    if (a.needs.thirst < 0.15) {
      const e = sim.evalFor(hid, a.speciesId);
      if (e && !e.hasWater) sim.notify(`thirsty:${hid}`, `The ${pluralName(sp.id)} in ${where} are thirsty — add a pond or water trough.`, 'bad', focus, 150);
      else if (a.needs.thirst < 0.06) sim.notify(`thirsty:${hid}`, `The ${pluralName(sp.id)} in ${where} can’t reach their water.`, 'bad', focus, 150);
    }
    if (a.happiness < 0.3 && a.growth >= 1) {
      const e = sim.evalFor(hid, a.speciesId);
      const why = e?.issues[0];
      sim.notify(`unhappy:${hid}:${sp.id}`, `${a.name} the ${sp.name} is unhappy${why ? `: ${why}` : ''}.`, 'warn', focus, 300);
    }
  }

  /** Every game hour: dung, sickness, breeding and escape attempts. */
  hourly() {
    const sim = this.sim;
    const rng = sim.rng;
    for (const a of sim.animals.values()) {
      const sp = SPECIES_BY_ID[a.speciesId];
      if (!sp) continue;
      // dung
      a.dungIn -= 1;
      if (a.dungIn <= 0) {
        const scale = Math.max(0.5, Math.min(1.6, Math.sqrt(foodScale(sp))));
        a.dungIn = rng.range(9, 16) / scale;
        if (!a.escaped && a.habitatId) this.dropDung(a, sp);
      }
      if (a.escaped || !a.habitatId) continue;
      // sickness
      if (!a.sick) {
        const dirt = sim.habitatDirt(a.habitatId);
        const p = 0.0004 + (1 - a.happiness) * 0.0012 + dirt * 0.0012;
        if (rng.chance(p)) {
          a.sick = true;
          let vets = 0;
          for (const s of sim.staff.values()) if (s.role === 'vet') vets++;
          sim.notify(`sick:${a.id}`, `${a.name} the ${sp.name} is sick${vets ? ' — a vet is on the way' : '. Hire a vet!'}`, 'warn', { x: a.x, z: a.z }, 120);
        }
      }
      // breeding (females drive it)
      if (a.sex === 'F' && a.growth >= 1 && a.pregnantDays === 0 && a.breedCooldown <= 0 && a.happiness > 0.62 && a.health > 0.6) {
        if (this.canBreed(a, sp) && rng.chance(0.012)) {
          a.pregnantDays = 0.001;
        }
      }
      // escape attempts through a fence that is too weak
      if (a.goal !== 'breakout' && a.growth >= 0.8 && a.happiness < 0.5) {
        const hab = sim.world.habitats.get(a.habitatId);
        if (hab && hab.minFenceStrength < sp.danger) {
          const p = (0.5 - a.happiness) * 0.02 * (sp.danger - hab.minFenceStrength);
          if (rng.chance(p)) this.startBreakout(a, sp);
        }
      }
      // predators hunt prey sharing the habitat
      if (sp.diet === 'carnivore' && a.growth >= 0.8 && a.goal !== 'hunt' && a.action !== 'sleep' && rng.chance(0.25)) {
        const prey = this.nearestPrey(a);
        if (prey) {
          a.goal = 'hunt';
          a.ref = prey.id;
          a.goalTime = 25;
          a.tgtX = prey.x;
          a.tgtZ = prey.z;
          a.route.length = 0;
          a.routeIdx = 0;
          a.moving = true;
          a.stuck = 0;
        }
      }
    }
  }

  /** Once per game day. */
  daily() {
    for (const a of this.sim.animals.values()) {
      a.ageDays += 1;
      if (a.breedCooldown > 0) a.breedCooldown = Math.max(0, a.breedCooldown - 1);
    }
  }

  private canBreed(a: AnimalSim, sp: SpeciesDef): boolean {
    const sim = this.sim;
    const hid = a.habitatId!;
    const pop = sim.population(hid);
    const count = pop.count.get(sp.id) ?? 0;
    if (count >= sp.groupMax) return false;
    const e = sim.evalFor(hid, sp.id);
    if (!e || e.space < 0.9 || e.compat < 0.9) return false;
    for (const b of sim.animals.values()) {
      if (b.sex === 'M' && b.speciesId === sp.id && b.habitatId === hid && !b.escaped && b.growth >= 1 && b.health > 0.5) return true;
    }
    return false;
  }

  private giveBirth(mother: AnimalSim, sp: SpeciesDef) {
    const sim = this.sim;
    mother.pregnantDays = 0;
    mother.breedCooldown = Math.max(2, sp.gestationDays * 1.5);
    const baby = this.create(sp.id, mother.x, mother.z, { growth: BIRTH_GROWTH, mother: mother.id });
    baby.heading = mother.heading;
    baby.needs.hunger = 0.9;
    baby.needs.thirst = 0.9;
    sim.events.emit('animalAdded', { id: baby.id });
    sim.markPopulationDirty();
    sim.progress.counters.births++;
    sim.notify(null, `${mother.name} the ${sp.name} gave birth to a baby ${baby.sex === 'F' ? 'girl' : 'boy'}, ${baby.name}!`, 'good', {
      x: mother.x,
      z: mother.z,
    });
  }

  private dropDung(a: AnimalSim, sp: SpeciesDef) {
    const sim = this.sim;
    const hid = a.habitatId!;
    const hab = sim.world.habitats.get(hid);
    if (!hab) return;
    if ((sim.dungByHab.get(hid) ?? 0) > hab.tiles.length * 0.25) return;
    const back = sp.length * 0.45 * a.growth;
    let x = a.x - Math.sin(a.heading) * back;
    let z = a.z - Math.cos(a.heading) * back;
    const t = this.tileOf(x, z);
    if (t < 0 || t >= sim.world.habitatOf.length || sim.world.habitatOf[t] !== hid || sim.world.terrain[t] === Terrain.DeepWater) {
      x = a.x;
      z = a.z;
    }
    if (sim.world.terrain[this.tileOf(x, z)] === Terrain.DeepWater) return;
    sim.addLitter('dung', x, z);
    sim.dungByHab.set(hid, (sim.dungByHab.get(hid) ?? 0) + 1);
  }

  // ============================================================= behaviour
  private updateBehaviour(a: AnimalSim, sp: SpeciesDef, dt: number) {
    const n = a.needs;
    // activity effects while stationary at the goal
    if (!a.moving) {
      switch (a.goal) {
        case 'eat': {
          const rt = a.habitatId ? this.sim.habitatRuntime(a.habitatId) : undefined;
          const scale = foodScale(sp);
          if (rt && rt.food > 0) {
            const bite = Math.min(0.05 * dt, 1 - n.hunger);
            n.hunger += bite;
            rt.food = Math.max(0, rt.food - bite * scale);
          } else a.goalTime = Math.min(a.goalTime, 0.5);
          if (n.hunger > 0.98) a.goalTime = Math.min(a.goalTime, 0.5);
          break;
        }
        case 'graze':
          if (n.hunger < 0.7) n.hunger += 0.02 * dt;
          else a.goalTime = Math.min(a.goalTime, 0.5);
          break;
        case 'drink':
          n.thirst = Math.min(1, n.thirst + 0.08 * dt);
          if (n.thirst > 0.98) a.goalTime = Math.min(a.goalTime, 0.5);
          break;
        case 'sleep':
          if (!this.sim.isNight() && n.energy > 0.9) a.goalTime = Math.min(a.goalTime, 1);
          if (n.hunger < 0.22 || n.thirst < 0.22) a.goalTime = 0;
          break;
        case 'rest':
        case 'idle':
        case 'social':
        case 'play':
        case 'call':
        case 'wander':
        case 'swim':
          if (n.hunger < 0.3 || n.thirst < 0.3) a.goalTime = Math.min(a.goalTime, 0.2);
          break;
        case 'social':
          n.social = Math.min(1, n.social + 0.015 * dt);
          break;
        case 'play':
          n.enrichment = Math.min(1, n.enrichment + 0.035 * dt);
          break;
      }
      a.goalTime -= dt;
      if (a.goalTime <= 0) this.think(a, sp);
      return;
    }
    // while walking: periodically re-target moving goals and allow urgent interrupts
    a.think -= dt;
    if (a.goal === 'hunt') {
      a.goalTime -= dt;
      const prey = this.sim.animals.get(a.ref);
      if (!prey || prey.escaped || prey.habitatId !== a.habitatId || a.goalTime <= 0) {
        a.moving = false;
        a.goal = 'rest';
        a.goalTime = 8;
        return;
      }
      a.tgtX = prey.x;
      a.tgtZ = prey.z;
      a.route.length = 0;
      a.routeIdx = 0;
      const r = bodyRadius(sp, a.growth) + bodyRadius(SPECIES_BY_ID[prey.speciesId], prey.growth);
      const dx = prey.x - a.x,
        dz = prey.z - a.z;
      if (dx * dx + dz * dz < (r + 0.6) * (r + 0.6)) this.catchPrey(a, sp, prey);
      return;
    }
    if (a.think <= 0) {
      a.think = 1.5;
      if (a.goal === 'follow') {
        const m = this.sim.animals.get(a.mother);
        if (m && !m.escaped && m.habitatId === a.habitatId) {
          const msp = SPECIES_BY_ID[m.speciesId];
          const off = bodyRadius(msp, 1) * 1.6;
          const tx = m.x - Math.sin(m.heading) * off + Math.cos(m.heading) * 0.4;
          const tz = m.z - Math.cos(m.heading) * off - Math.sin(m.heading) * 0.4;
          this.setCtx(a, sp);
          if (this.enterable(this.tileOf(tx, tz))) this.goTo(a, sp, tx, tz, 600);
        }
      }
      if ((n.hunger < 0.18 && a.goal !== 'eat' && a.goal !== 'graze') || (n.thirst < 0.18 && a.goal !== 'drink')) {
        if (a.goal !== 'breakout' && a.goal !== 'flee') this.think(a, sp);
      }
    }
  }

  private catchPrey(pred: AnimalSim, sp: SpeciesDef, prey: AnimalSim) {
    const sim = this.sim;
    const psp = SPECIES_BY_ID[prey.speciesId];
    sim.notify(
      null,
      `Keepers rescued a frightened ${singularName(psp.id)} (${prey.name}) from the ${pluralName(sp.id)} and sent it to a sanctuary. Predators and prey must not share a habitat!`,
      'bad',
      { x: prey.x, z: prey.z },
    );
    this.remove(prey.id);
    pred.moving = false;
    pred.goal = 'rest';
    pred.goalTime = 20;
    pred.needs.hunger = Math.min(1, pred.needs.hunger + 0.3);
  }

  private nearestPrey(a: AnimalSim): AnimalSim | null {
    let best: AnimalSim | null = null;
    let bd = Infinity;
    for (const b of this.sim.animals.values()) {
      if (b === a || b.escaped || b.habitatId !== a.habitatId) continue;
      const bsp = SPECIES_BY_ID[b.speciesId];
      if (!bsp || bsp.diet === 'carnivore') continue;
      const d = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  /** Pick the next activity. */
  private think(a: AnimalSim, sp: SpeciesDef) {
    const sim = this.sim;
    const rng = sim.rng;
    const n = a.needs;
    a.moving = false;
    a.route.length = 0;
    a.routeIdx = 0;
    a.ref = 0;
    a.face = NO_FACE;
    a.think = 1.5 + rng.float();
    this.setCtx(a, sp);

    if (a.escaped) {
      this.chooseRoam(a, sp);
      return;
    }
    const hid = a.habitatId;
    if (!hid) {
      this.setGoal(a, 'idle', 3);
      return;
    }
    const tiles = sim.habitatTiles(hid);
    const e = sim.evalFor(hid, a.speciesId);
    const night = sim.isNight();

    // prey flees from hunting predators nearby
    if (sp.diet !== 'carnivore' && e && e.predators > 0) {
      const pred = this.nearestHunter(a);
      if (pred && rng.chance(0.8)) {
        if (this.chooseFlee(a, sp, pred)) return;
      }
    }
    // babies stay with their mother
    if (a.mother && a.growth < 0.75) {
      const m = sim.animals.get(a.mother);
      if (m && !m.escaped && m.habitatId === hid) {
        if (m.action === 'sleep' && !m.moving) {
          if (this.goNear(a, sp, m.x, m.z, bodyRadius(SPECIES_BY_ID[m.speciesId], 1) + 0.6)) {
            this.setGoal(a, 'sleep', 30, true);
            return;
          }
        } else if (m.goal === 'eat' || m.goal === 'drink' || m.goal === 'graze') {
          if (this.goNear(a, sp, m.x, m.z, 1.2)) {
            this.setGoal(a, m.goal === 'drink' ? 'drink' : 'graze', 8, true);
            return;
          }
        }
        const off = bodyRadius(SPECIES_BY_ID[m.speciesId], 1) * 1.6;
        if (this.goNear(a, sp, m.x - Math.sin(m.heading) * off, m.z - Math.cos(m.heading) * off, 0.5)) {
          this.setGoal(a, 'follow', rng.range(1, 3), true);
          return;
        }
      }
    }
    // eat and drink first (also before bedtime), then sleep at night / when exhausted
    if (n.thirst < (night ? 0.6 : 0.5) && this.chooseDrink(a, sp, hid)) return;
    if (n.hunger < (night ? 0.6 : 0.5) && this.chooseEat(a, sp, hid)) return;
    if ((night && rng.chance(0.92)) || n.energy < 0.18) {
      if (this.chooseSleep(a, sp, hid)) return;
    }
    if (n.social < 0.45 && rng.chance(0.6) && this.chooseSocial(a, sp, hid)) return;
    if (n.enrichment < 0.5 && rng.chance(0.6) && this.choosePlay(a, sp, hid)) return;

    // daytime idle behaviours
    const lazy = sp.diet === 'carnivore' ? 0.45 : 0.22;
    const r = rng.float();
    if (sp.swims && tiles && tiles.deep.length && r < 0.14) {
      if (this.chooseSwim(a, sp, tiles.deep)) return;
    }
    if (a.sinceCall > 90 && r > 0.93 && a.growth >= 1) {
      a.sinceCall = 0;
      this.setGoal(a, 'call', rng.range(2.5, 4));
      return;
    }
    if (r < lazy) {
      if (n.energy < 0.6 && rng.chance(0.5) && this.chooseSleep(a, sp, hid)) return;
      this.setGoal(a, 'rest', rng.range(12, 35));
      return;
    }
    if (r < lazy + 0.15) {
      if (sp.diet === 'herbivore' && rng.chance(0.6) && n.hunger < 0.8 && this.onGrazing(a)) {
        this.setGoal(a, 'graze', rng.range(8, 20));
        return;
      }
      this.setGoal(a, 'idle', rng.range(3, 8));
      return;
    }
    if (n.enrichment < 0.8 && rng.chance(0.2) && this.choosePlay(a, sp, hid)) return;
    this.chooseWander(a, sp, hid);
  }

  private setGoal(a: AnimalSim, goal: AnimalGoal, time: number, keepMoving = false) {
    a.goal = goal;
    a.goalTime = time;
    if (!keepMoving) a.moving = false;
  }

  private onGrazing(a: AnimalSim): boolean {
    const t = this.sim.world.terrain[this.tileOf(a.x, a.z)];
    return t === Terrain.Grass || t === Terrain.DryGrass;
  }

  /** Walk to within `dist` of (x, z) (picks an enterable spot). */
  private goNear(a: AnimalSim, sp: SpeciesDef, x: number, z: number, dist: number): boolean {
    this.setCtx(a, sp);
    const ang = Math.atan2(a.x - x, a.z - z);
    for (let k = 0; k < 4; k++) {
      const an = ang + (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.9);
      const tx = x + Math.sin(an) * dist,
        tz = z + Math.cos(an) * dist;
      const t = this.tileOf(tx, tz);
      if (t < 0 || t >= this.sim.world.habitatOf.length || !this.enterable(t)) continue;
      if (this.goTo(a, sp, tx, tz, 1500)) return true;
    }
    return false;
  }

  /** Random tile from a list that the current context can stand on (few tries). */
  private randomTile(list: number[]): number {
    if (!list.length) return -1;
    let t = -1;
    for (let k = 0; k < 6; k++) {
      t = list[Math.floor(this.sim.rng.float() * list.length)];
      if (this.enterable(t)) return t;
    }
    return t;
  }

  private chooseWander(a: AnimalSim, sp: SpeciesDef, hid: number) {
    const sim = this.sim;
    const rng = sim.rng;
    const tiles = sim.habitatTiles(hid);
    if (!tiles || !tiles.land.length) {
      this.setGoal(a, 'idle', 4);
      return;
    }
    const pool = sp.length > 1.6 && tiles.interior.length > 4 ? tiles.interior : tiles.land;
    // herd animals drift towards the herd
    let cx = 0,
      cz = 0,
      cnt = 0;
    if (sp.groupMin >= 2) {
      for (const b of sim.animals.values()) {
        if (b === a || b.speciesId !== a.speciesId || b.habitatId !== hid || b.escaped) continue;
        cx += b.x;
        cz += b.z;
        cnt++;
      }
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      let tx: number, tz: number;
      if (cnt > 0 && rng.chance(0.55)) {
        tx = cx / cnt + rng.range(-5, 5);
        tz = cz / cnt + rng.range(-5, 5);
        const t = this.tileOf(tx, tz);
        this.setCtx(a, sp);
        if (t < 0 || t >= sim.world.habitatOf.length || !this.enterable(t)) continue;
      } else {
        const t = this.randomTile(pool);
        this.tileCentre(t, this.tc);
        tx = this.tc.x + rng.range(-0.6, 0.6);
        tz = this.tc.z + rng.range(-0.6, 0.6);
      }
      if (this.goTo(a, sp, tx, tz)) {
        this.setGoal(a, 'wander', rng.range(1.5, 5), true);
        return;
      }
    }
    this.setGoal(a, 'idle', 3);
  }

  private chooseRoam(a: AnimalSim, sp: SpeciesDef) {
    const sim = this.sim;
    const rng = sim.rng;
    const w = sim.world;
    this.setCtx(a, sp);
    const tx0 = Math.floor(a.x / TILE),
      tz0 = Math.floor(a.z / TILE);
    for (let attempt = 0; attempt < 14; attempt++) {
      const x = tx0 + rng.int(-7, 7),
        z = tz0 + rng.int(-7, 7);
      if (!w.inBounds(x, z)) continue;
      const t = w.idx(x, z);
      if (!this.enterable(t)) continue;
      if (attempt < 10 && !w.path[t]) continue; // loose animals wander along the paths
      if (this.goTo(a, sp, (x + 0.5) * TILE + rng.range(-0.5, 0.5), (z + 0.5) * TILE + rng.range(-0.5, 0.5), 1500)) {
        this.setGoal(a, 'roam', rng.range(2, 6), true);
        return;
      }
    }
    this.setGoal(a, 'idle', 3);
  }

  private chooseSleep(a: AnimalSim, sp: SpeciesDef, hid: number): boolean {
    const sim = this.sim;
    const rng = sim.rng;
    const hab = sim.world.habitats.get(hid);
    if (!hab) return false;
    const dur = sim.isNight() ? rng.range(60, 140) : rng.range(25, 60);
    // shelters first
    const shelter = this.nearestObject(a, hab.objects, (id) => OBJECTS_BY_ID[id]?.serves === 'shelter');
    if (shelter && rng.chance(0.75) && this.approachObject(a, sp, shelter, true)) {
      this.setGoal(a, 'sleep', dur, true);
      return true;
    }
    // near herd mates
    for (const b of sim.animals.values()) {
      if (b === a || b.speciesId !== a.speciesId || b.habitatId !== hid || b.escaped) continue;
      if (b.action === 'sleep' || b.goal === 'sleep') {
        if (this.goNear(a, sp, b.x, b.z, bodyRadius(sp, 1) * 2.2)) {
          this.setGoal(a, 'sleep', dur, true);
          return true;
        }
        break;
      }
    }
    const tiles = sim.habitatTiles(hid);
    if (!tiles) return false;
    const pool = tiles.interior.length ? tiles.interior : tiles.land;
    const t = this.randomTile(pool);
    if (t < 0) return false;
    this.tileCentre(t, this.tc);
    if (this.goTo(a, sp, this.tc.x + rng.range(-0.5, 0.5), this.tc.z + rng.range(-0.5, 0.5))) {
      this.setGoal(a, 'sleep', dur, true);
      return true;
    }
    return false;
  }

  private chooseEat(a: AnimalSim, sp: SpeciesDef, hid: number): boolean {
    const sim = this.sim;
    const rng = sim.rng;
    const hab = sim.world.habitats.get(hid);
    const rt = sim.habitatRuntime(hid);
    if (!hab) return false;
    if (rt && rt.food > 0.2) {
      const feeders = feederFor(sp);
      const f = this.nearestObject(a, hab.objects, (id) => feeders.includes(id));
      if (f && this.approachObject(a, sp, f, false)) {
        this.setGoal(a, 'eat', rng.range(15, 26), true);
        return true;
      }
      // keeper scattered food on the ground
      let fx = rt.spotX,
        fz = rt.spotZ;
      if (fx < 0) {
        const c = { x: ((hab.minX + hab.maxX + 1) / 2) * TILE, z: ((hab.minZ + hab.maxZ + 1) / 2) * TILE };
        fx = c.x;
        fz = c.z;
      }
      if (this.goNear(a, sp, fx + rng.range(-1.5, 1.5), fz + rng.range(-1.5, 1.5), bodyRadius(sp, a.growth) + 0.3)) {
        this.setGoal(a, 'eat', rng.range(15, 26), true);
        return true;
      }
    }
    if (sp.diet === 'herbivore' && a.needs.hunger < 0.7) {
      // graze on a grassy tile
      const tiles = sim.habitatTiles(hid);
      if (tiles) {
        for (let k = 0; k < 6; k++) {
          const t = this.randomTile(tiles.land);
          const ter = sim.world.terrain[t];
          if (ter !== Terrain.Grass && ter !== Terrain.DryGrass) continue;
          this.tileCentre(t, this.tc);
          if (this.goTo(a, sp, this.tc.x + rng.range(-0.6, 0.6), this.tc.z + rng.range(-0.6, 0.6))) {
            this.setGoal(a, 'graze', rng.range(12, 22), true);
            return true;
          }
        }
      }
    }
    return false;
  }

  private chooseDrink(a: AnimalSim, sp: SpeciesDef, hid: number): boolean {
    const sim = this.sim;
    const rng = sim.rng;
    const hab = sim.world.habitats.get(hid);
    const tiles = sim.habitatTiles(hid);
    if (!hab || !tiles) return false;
    const trough = this.nearestObject(a, hab.objects, (id) => id === 'water_trough');
    // nearest drinking tile at the water's edge
    let best = -1,
      bd = Infinity;
    this.setCtx(a, sp);
    for (let k = 0; k < tiles.drink.length; k++) {
      const t = tiles.drink[k];
      if (!this.enterable(t)) continue;
      this.tileCentre(t, this.tc);
      const d = (this.tc.x - a.x) ** 2 + (this.tc.z - a.z) ** 2 + rng.float() * 30;
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    const troughD = trough ? (trough.cx - a.x) ** 2 + (trough.cz - a.z) ** 2 : Infinity;
    if (trough && troughD < bd && this.approachObject(a, sp, trough, false)) {
      this.setGoal(a, 'drink', rng.range(6, 12), true);
      return true;
    }
    if (best >= 0) {
      const w = sim.world;
      const bx = best % MAP_W,
        bz = (best / MAP_W) | 0;
      this.tileCentre(best, this.tc);
      let tx = this.tc.x + rng.range(-0.45, 0.45),
        tz = this.tc.z + rng.range(-0.45, 0.45);
      // lean towards the water
      for (let k = 0; k < 4; k++) {
        const nx = bx + (k === 0 ? 1 : k === 1 ? -1 : 0),
          nz = bz + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (!w.inBounds(nx, nz)) continue;
        const nt = w.terrain[w.idx(nx, nz)];
        if ((nt === Terrain.Water || nt === Terrain.DeepWater) && w.habitatOf[w.idx(nx, nz)] === hid && !w.fenceBetween(bx, bz, nx, nz)) {
          const lean = Math.max(0, 0.95 - fenceMargin(sp, a.growth) * 0.6);
          tx += (nx - bx) * lean;
          tz += (nz - bz) * lean;
          a.face = Math.atan2(nx - bx, nz - bz);
          break;
        }
      }
      if (this.goTo(a, sp, tx, tz)) {
        this.setGoal(a, 'drink', rng.range(6, 12), true);
        return true;
      }
    }
    if (trough && this.approachObject(a, sp, trough, false)) {
      this.setGoal(a, 'drink', rng.range(6, 12), true);
      return true;
    }
    return false;
  }

  private chooseSocial(a: AnimalSim, sp: SpeciesDef, hid: number): boolean {
    const sim = this.sim;
    let best: AnimalSim | null = null,
      bd = Infinity;
    for (const b of sim.animals.values()) {
      if (b === a || b.speciesId !== a.speciesId || b.habitatId !== hid || b.escaped) continue;
      const d = (b.x - a.x) ** 2 + (b.z - a.z) ** 2 + sim.rng.float() * 40;
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    if (!best) return false;
    const r = bodyRadius(sp, a.growth) + bodyRadius(sp, best.growth) + 0.4;
    if (!this.goNear(a, sp, best.x, best.z, r)) return false;
    a.face = Math.atan2(best.x - a.tgtX, best.z - a.tgtZ);
    a.ref = best.id;
    this.setGoal(a, 'social', sim.rng.range(6, 14), true);
    return true;
  }

  private choosePlay(a: AnimalSim, sp: SpeciesDef, hid: number): boolean {
    const hab = this.sim.world.habitats.get(hid);
    if (!hab) return false;
    const toy = this.nearestObject(a, hab.objects, (id) => OBJECTS_BY_ID[id]?.serves === 'play');
    if (!toy || !this.approachObject(a, sp, toy, false)) return false;
    this.setGoal(a, 'play', this.sim.rng.range(8, 16), true);
    return true;
  }

  private chooseSwim(a: AnimalSim, sp: SpeciesDef, deep: number[]): boolean {
    const t = this.randomTile(deep);
    if (t < 0) return false;
    this.tileCentre(t, this.tc);
    const rng = this.sim.rng;
    if (!this.goTo(a, sp, this.tc.x + rng.range(-0.6, 0.6), this.tc.z + rng.range(-0.6, 0.6))) return false;
    this.setGoal(a, 'swim', rng.range(3, 8), true);
    return true;
  }

  private chooseFlee(a: AnimalSim, sp: SpeciesDef, pred: AnimalSim): boolean {
    const dx = a.x - pred.x,
      dz = a.z - pred.z;
    for (let k = 0; k < 5; k++) {
      const ang = Math.atan2(dx, dz) + (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.6);
      const tx = a.x + Math.sin(ang) * 9,
        tz = a.z + Math.cos(ang) * 9;
      this.setCtx(a, sp);
      const t = this.tileOf(tx, tz);
      if (t < 0 || t >= this.sim.world.habitatOf.length || !this.enterable(t)) continue;
      if (this.goTo(a, sp, tx, tz, 800)) {
        this.setGoal(a, 'flee', 2, true);
        a.stress = 1;
        return true;
      }
    }
    return false;
  }

  private nearestHunter(a: AnimalSim): AnimalSim | null {
    for (const b of this.sim.animals.values()) {
      if (b.habitatId !== a.habitatId || b.escaped) continue;
      if (b.goal === 'hunt' && (b.x - a.x) ** 2 + (b.z - a.z) ** 2 < 144) return b;
    }
    return null;
  }

  private nearestObject(a: AnimalSim, ids: number[], pred: (defId: string) => boolean): { id: number; cx: number; cz: number } | null {
    const w = this.sim.world;
    let best: { id: number; cx: number; cz: number } | null = null;
    let bd = Infinity;
    for (const oid of ids) {
      const o = w.objects.get(oid);
      if (!o || !pred(o.defId)) continue;
      const c = w.objectCenter(o);
      const d = (c.x - a.x) ** 2 + (c.z - a.z) ** 2;
      if (d < bd) {
        bd = d;
        best = { id: oid, cx: c.x, cz: c.z };
      }
    }
    return best;
  }

  /** Walk up to an object: stand next to a solid one, or on a walk-over one. */
  private approachObject(a: AnimalSim, sp: SpeciesDef, obj: { id: number; cx: number; cz: number }, nearOnly: boolean): boolean {
    const w = this.sim.world;
    const rng = this.sim.rng;
    const o = w.objects.get(obj.id);
    if (!o) return false;
    const def = OBJECTS_BY_ID[o.defId];
    this.setCtx(a, sp);
    if (!def.solid && !nearOnly) {
      const tx = obj.cx + rng.range(-0.4, 0.4),
        tz = obj.cz + rng.range(-0.4, 0.4);
      if (this.goTo(a, sp, tx, tz)) {
        a.face = rng.range(-Math.PI, Math.PI);
        return true;
      }
      return false;
    }
    // collect free tiles around the footprint
    const fp = w.footprint(o);
    const cands: number[] = [];
    for (const t of fp) {
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = t.x + dx,
            nz = t.z + dz;
          if (!w.inBounds(nx, nz)) continue;
          const ni = w.idx(nx, nz);
          if (w.objectGrid[ni] === o.id || cands.includes(ni)) continue;
          if (!this.enterable(ni)) continue;
          if (dx !== 0 && dz !== 0) continue; // orthogonal neighbours only (reach)
          if (w.fenceBetween(t.x, t.z, nx, nz)) continue;
          cands.push(ni);
        }
    }
    for (let k = 0; k < 4 && cands.length; k++) {
      const pick = Math.floor(rng.float() * cands.length);
      const t = cands[pick];
      cands.splice(pick, 1);
      this.tileCentre(t, this.tc);
      const dx = obj.cx - this.tc.x,
        dz = obj.cz - this.tc.z;
      const d = Math.hypot(dx, dz) || 1;
      const lean = nearOnly ? 0 : Math.max(0, 0.95 - fenceMargin(sp, a.growth) * 0.5);
      const tx = this.tc.x + (dx / d) * lean,
        tz = this.tc.z + (dz / d) * lean;
      if (this.goTo(a, sp, tx, tz)) {
        a.face = nearOnly ? rng.range(-Math.PI, Math.PI) : Math.atan2(dx, dz);
        return true;
      }
    }
    return false;
  }

  // ============================================================== breakout
  private startBreakout(a: AnimalSim, sp: SpeciesDef) {
    const sim = this.sim;
    const w = sim.world;
    const hab = sim.world.habitats.get(a.habitatId!);
    if (!hab) return;
    this.setCtx(a, sp);
    let best = -1,
      bestOut = -1,
      bd = Infinity;
    for (const i of hab.tiles) {
      if (!this.enterable(i)) continue;
      const x = i % MAP_W,
        z = (i / MAP_W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0),
          nz = z + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (!w.inBounds(nx, nz)) continue;
        const ni = w.idx(nx, nz);
        if (w.habitatOf[ni] !== 0 || w.isTileSolid(nx, nz)) continue;
        if (!sp.swims && w.terrain[ni] === Terrain.DeepWater) continue;
        const f = w.fenceBetween(x, z, nx, nz);
        if (!f) continue;
        this.tileCentre(i, this.tc);
        const d = (this.tc.x - a.x) ** 2 + (this.tc.z - a.z) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
          bestOut = ni;
        }
      }
    }
    if (best < 0) return;
    this.tileCentre(best, this.tc);
    if (!this.goTo(a, sp, this.tc.x, this.tc.z)) return;
    a.goal = 'breakout';
    a.ref = bestOut;
    a.goalTime = 0.1;
  }

  /** Carry an escaped animal back to its habitat (staff / rescue). Returns success. */
  returnHome(a: AnimalSim): boolean {
    const sim = this.sim;
    const sp = SPECIES_BY_ID[a.speciesId];
    let hid = sim.world.habitats.has(a.home) ? a.home : 0;
    if (!hid) {
      for (const b of sim.animals.values()) if (b !== a && !b.escaped && b.speciesId === a.speciesId && b.habitatId) hid = b.habitatId;
    }
    if (!hid) {
      sim.notify(`nohome:${a.id}`, `${a.name} the ${sp.name} has no habitat to go back to — build one or sell it.`, 'warn', { x: a.x, z: a.z }, 120);
      return false;
    }
    const tiles = sim.habitatTiles(hid);
    if (!tiles) return false;
    const pool = tiles.interior.length ? tiles.interior : tiles.land;
    this.ctxZone = hid;
    this.ctxSwims = sp.swims;
    this.ctxWades = sp.swims || sp.height >= 1.2;
    const t = this.randomTile(pool);
    if (t < 0) return false;
    this.tileCentre(t, this.tc);
    a.x = this.tc.x;
    a.z = this.tc.z;
    a.escaped = false;
    a.crossing = false;
    a.habitatId = hid;
    a.home = hid;
    a.escapeTime = 0;
    a.stress = 0.3;
    a.moving = false;
    a.route.length = 0;
    a.goal = 'rest';
    a.goalTime = 10;
    this.placeY(a, sp);
    sim.markPopulationDirty();
    return true;
  }

  // ============================================================== movement
  private move(a: AnimalSim, sp: SpeciesDef, dt: number) {
    const w = this.sim.world;
    // breakout: final step across the fence
    if (a.goal === 'breakout' && a.routeIdx >= a.route.length && !a.crossing) {
      const dx = a.tgtX - a.x,
        dz = a.tgtZ - a.z;
      if (dx * dx + dz * dz < 0.3) {
        a.crossing = true;
        this.tileCentre(a.ref, this.tc);
        a.tgtX = this.tc.x;
        a.tgtZ = this.tc.z;
      }
    }
    let wx: number, wz: number;
    let final = false;
    for (;;) {
      if (a.routeIdx < a.route.length) {
        const t = a.route[a.routeIdx];
        this.tileCentre(t, this.tc);
        wx = this.tc.x;
        wz = this.tc.z;
        const cur = this.tileOf(a.x, a.z);
        const d2 = (wx - a.x) ** 2 + (wz - a.z) ** 2;
        if (cur === t || d2 < 0.64) {
          a.routeIdx++;
          continue;
        }
      } else {
        wx = a.tgtX;
        wz = a.tgtZ;
        final = true;
      }
      break;
    }
    const dx = wx - a.x,
      dz = wz - a.z;
    const dist = Math.hypot(dx, dz);
    const arrive = a.goal === 'hunt' ? 0 : a.goal === 'follow' ? 0.35 : 0.18;
    if (final && dist < arrive + 0.02) {
      this.arrive(a);
      return;
    }
    // jostling with a herd mate for the same spot: close enough counts as arrived
    if (final && a.goal !== 'hunt' && a.goal !== 'breakout' && dist < Math.max(0.6, bodyRadius(sp, a.growth) * 1.2)) {
      a.stuck += dt;
      if (a.stuck > 1.2) {
        this.arrive(a);
        return;
      }
    }
    const desired = Math.atan2(dx, dz);
    const diff = wrapAngle(desired - a.heading);
    const maxTurn = turnRate(sp) * dt * (a.goal === 'hunt' || a.goal === 'flee' ? 1.6 : 1);
    a.heading = wrapAngle(a.heading + Math.max(-maxTurn, Math.min(maxTurn, diff)));
    const running = a.goal === 'hunt' || a.goal === 'flee' || (a.goal === 'breakout' && a.crossing);
    let target = running ? sp.runSpeed * 0.85 : sp.walkSpeed * (0.85 + 0.15 * a.growth);
    if (a.goal === 'follow') {
      const m = this.sim.animals.get(a.mother);
      if (m) target = Math.max(target * 0.6, Math.min(sp.walkSpeed * 1.6, m.speed + dist * 0.3));
    }
    if (a.escaped && !running) target *= 1.15;
    const ter = w.terrain[this.tileOf(a.x, a.z)];
    if (ter === Terrain.Water || ter === Terrain.Mud) target *= 0.75;
    const ad = Math.abs(diff);
    if (ad > 1.1) target *= 0.15;
    else if (ad > 0.4) target *= 1 - (ad - 0.4) * 0.9;
    if (final) target = Math.min(target, 0.25 + dist * 0.9);
    const accel = running ? 5 : 1.6;
    a.speed += Math.max(-accel * 1.5 * dt, Math.min(accel * dt, target - a.speed));
    if (a.speed < 0) a.speed = 0;
    const step = a.speed * dt;
    const nx = a.x + Math.sin(a.heading) * step,
      nz = a.z + Math.cos(a.heading) * step;
    if (a.crossing) {
      a.x = nx;
      a.z = nz;
      const t = this.tileOf(a.x, a.z);
      if (t === a.ref) {
        a.crossing = false;
        const hab = w.habitats.get(a.home);
        this.becomeLoose(a, `${a.name} the ${sp.name} has broken out of ${hab?.name ?? 'its habitat'}!`);
      }
      this.placeY(a, sp);
      return;
    }
    const moved = this.tryMove(a, sp, nx, nz);
    if (!moved && a.speed > 0.05 && dist >= 0.6) {
      a.stuck += dt;
      if (a.stuck > 1.2) {
        a.speed = 0;
        if (a.stuck > 3 || !this.goTo(a, sp, a.tgtX, a.tgtZ)) {
          a.moving = false;
          a.stuck = 0;
          a.goalTime = Math.min(a.goalTime, 1);
        }
      }
    } else if (moved && dist >= 0.6) a.stuck = Math.max(0, a.stuck - dt);
    this.placeY(a, sp);
  }

  /** Move to (nx, nz) if legal, sliding along walls. Returns whether the animal moved. */
  private tryMove(a: AnimalSim, sp: SpeciesDef, nx: number, nz: number): boolean {
    this.setCtx(a, sp);
    const ct = this.tileOf(a.x, a.z);
    let nt = this.tileOf(nx, nz);
    if (nt !== ct && !this.passable(ct, nt)) {
      const tx = this.tileOf(nx, a.z);
      if (tx === ct || this.passable(ct, tx)) {
        nz = a.z;
        nt = tx;
      } else {
        const tz = this.tileOf(a.x, nz);
        if (tz === ct || this.passable(ct, tz)) {
          nx = a.x;
          nt = tz;
        } else return false;
      }
    }
    const ox = a.x,
      oz = a.z;
    a.x = nx;
    a.z = nz;
    this.applyMargins(a, sp, nt);
    return Math.abs(a.x - ox) + Math.abs(a.z - oz) > 1e-5;
  }

  /** Keep the body away from fences / blocked tiles around the current tile. */
  private applyMargins(a: AnimalSim, sp: SpeciesDef, t: number) {
    const w = this.sim.world;
    const x = t % MAP_W,
      z = (t / MAP_W) | 0;
    const m = fenceMargin(sp, a.growth);
    const ms = Math.min(0.55, m * 0.6);
    const x0 = x * TILE,
      z0 = z * TILE;
    // +x
    if (x + 1 >= MAP_W || !this.passable(t, t + 1)) {
      const mm = x + 1 < MAP_W && !w.fenceBetween(x, z, x + 1, z) ? ms : m;
      if (a.x > x0 + TILE - mm) a.x = x0 + TILE - mm;
    }
    if (x - 1 < 0 || !this.passable(t, t - 1)) {
      const mm = x - 1 >= 0 && !w.fenceBetween(x, z, x - 1, z) ? ms : m;
      if (a.x < x0 + mm) a.x = x0 + mm;
    }
    if (z + 1 >= w.h || !this.passable(t, t + MAP_W)) {
      const mm = z + 1 < w.h && !w.fenceBetween(x, z, x, z + 1) ? ms : m;
      if (a.z > z0 + TILE - mm) a.z = z0 + TILE - mm;
    }
    if (z - 1 < 0 || !this.passable(t, t - MAP_W)) {
      const mm = z - 1 >= 0 && !w.fenceBetween(x, z, x, z - 1) ? ms : m;
      if (a.z < z0 + mm) a.z = z0 + mm;
    }
  }

  private arrive(a: AnimalSim) {
    a.moving = false;
    a.route.length = 0;
    a.routeIdx = 0;
    if (a.goal === 'breakout') {
      // stuck at the fence without crossing: give up
      a.goal = 'idle';
      a.goalTime = 2;
      return;
    }
    if (a.goal === 'flee') a.goalTime = 2;
    if (a.goalTime <= 0) a.goalTime = 1;
  }

  /** Stationary: decelerate and turn to face the requested direction. */
  private idleMotion(a: AnimalSim, sp: SpeciesDef, dt: number) {
    if (a.speed > 0) a.speed = Math.max(0, a.speed - 3 * dt);
    if (a.face !== NO_FACE) {
      const diff = wrapAngle(a.face - a.heading);
      const maxTurn = turnRate(sp) * 0.6 * dt;
      if (Math.abs(diff) <= maxTurn) {
        a.heading = a.face;
        a.face = NO_FACE;
      } else a.heading = wrapAngle(a.heading + Math.sign(diff) * maxTurn);
    }
    this.placeY(a, sp);
  }

  private placeY(a: AnimalSim, sp: SpeciesDef) {
    const w = this.sim.world;
    const g = w.heightAt(a.x, a.z);
    if (sp.swims && g < WATER_LEVEL - sp.height * 0.6) a.y = WATER_LEVEL;
    else a.y = g;
  }

  private updateAction(a: AnimalSim, sp: SpeciesDef, dt: number) {
    let act = a.action;
    const swimming = sp.swims && a.y === WATER_LEVEL && this.sim.world.heightAt(a.x, a.z) < WATER_LEVEL - sp.height * 0.6;
    if (swimming) act = 'swim';
    else if (a.moving && a.speed > 0.05) act = a.speed > sp.walkSpeed * 1.45 ? 'run' : 'walk';
    else if (a.moving) act = 'idle';
    else act = ANIMAL_ACTION_FOR_GOAL[a.goal];
    if (act !== a.action) {
      a.action = act;
      a.actionTime = 0;
    } else a.actionTime += dt;
  }

  /** Push overlapping animals of one habitat apart. */
  private separate(arr: AnimalSim[]) {
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      const sa = SPECIES_BY_ID[a.speciesId];
      const ra = bodyRadius(sa, a.growth);
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j];
        const sb = SPECIES_BY_ID[b.speciesId];
        const rb = bodyRadius(sb, b.growth);
        const dx = b.x - a.x,
          dz = b.z - a.z;
        let min = ra + rb;
        // resting herd members (and mother + baby) huddle closer
        if ((a.action === 'sleep' && b.action === 'sleep') || a.mother === b.id || b.mother === a.id) min *= 0.6;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 0.01;
        const push = (min - d) * 0.5;
        const ux = d2 > 1e-6 ? dx / d : Math.cos(a.id),
          uz = d2 > 1e-6 ? dz / d : Math.sin(a.id);
        // heavier / stationary animals move less
        const wa = a.moving ? 0.6 : 0.4,
          wb = b.moving ? 0.6 : 0.4;
        const s = wa + wb;
        this.tryMove(a, sa, a.x - ux * push * (wa / s) * 2 * 0.5, a.z - uz * push * (wa / s) * 2 * 0.5);
        this.tryMove(b, sb, b.x + ux * push * (wb / s) * 2 * 0.5, b.z + uz * push * (wb / s) * 2 * 0.5);
      }
    }
  }
}
