// Animal AI: needs, behaviour selection, steering inside the habitat (never
// through fences unless breaking out), swimming, herding, breeding, health,
// predators, escapes and dung.

import { GAME_MINUTES_PER_SECOND, MAP_H, MAP_W, TILE, WATER_LEVEL } from '../core/constants';
import { Terrain, type SpeciesDef } from '../core/types';
import { OBJECTS_BY_ID } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import type { OpenEnclosure } from './enclosures';
import { evaluateSpecies, feederFor, type SpeciesEval } from './habitat';
import { animalName, pluralName, singularName } from './names';
import { type Passable } from './nav';
import type { Simulation } from './simulation';
import { ANIMAL_ACTION_FOR_GOAL, NO_FACE, type AnimalGoal, type AnimalSim } from './state';

const TWO_PI = Math.PI * 2;
const BIRTH_GROWTH = 0.3;
/** Escaped animals are picked up by an outside rescue team after this many seconds (≈ one game day). */
const RESCUE_AFTER = 300;
const RESCUE_FEE = 500;
/** Seconds an opened enclosure may stay open before the player is reminded. */
const OPEN_REMINDER_AFTER = 20;
/** Water depth (m) above which a standing animal counts as being in the water. */
const WET_DEPTH = 0.05;
/** Seconds without progress before a moving animal re-plans its route, and before it gives up. */
const STUCK_REPLAN = 1.2;
const STUCK_GIVE_UP = 3;

function wrapAngle(a: number): number {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

/** Food units a species eats relative to a medium animal. */
export function foodScale(sp: SpeciesDef): number {
  return Math.max(0.15, Math.min(5, (sp.height * sp.length) / 3));
}
/** Daily food bill ($) for one animal: bulk grows with body size, meat and fish cost more than hay. */
export function dailyFoodCost(sp: SpeciesDef, growth: number): number {
  const diet = sp.diet === 'carnivore' ? 2.4 : sp.diet === 'herbivore' ? 1 : 1.6;
  return Math.round((1.5 + 6 * foodScale(sp) * diet) * (0.4 + 0.6 * Math.min(1, growth)));
}
/** Collision radius (m). */
export function bodyRadius(sp: SpeciesDef, growth: number): number {
  return Math.max(0.15, Math.min(1.2, sp.length * 0.24)) * (0.45 + 0.55 * growth);
}
/** Linear body scale of a growing animal (matches the models' growth scaling). */
function growthScale(growth: number): number {
  return 0.45 + 0.55 * growth;
}
/** Deepest water (m) a non-swimming species wades into: about a third of its height. */
export function wadeDepth(sp: SpeciesDef, growth: number): number {
  return 0.35 * sp.height * growthScale(growth);
}
/** Water depth (m) from which a swimming species swims, origin at the water surface. */
export function swimDepth(sp: SpeciesDef, growth: number): number {
  return Math.max(0.25, Math.min(1.2, 0.55 * sp.height)) * growthScale(growth);
}
/** Half the body length (nose to rump; a tail may overhang a fence). */
function halfLength(sp: SpeciesDef, growth: number): number {
  return sp.length * 0.4 * growthScale(growth);
}
/** Half the body width. */
function halfWidth(sp: SpeciesDef, growth: number): number {
  return Math.max(0.12, Math.min(0.85, 0.13 * sp.length + 0.1)) * growthScale(growth);
}
/** Fence posts / rails stand this far into the tile (m). */
const FENCE_CLEAR = 0.12;
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
  /** Deepest water the current animal may stand in (Infinity for swimmers). */
  private ctxWade = Infinity;
  /** Movement tests use the exact water depth at the position instead of the tile centre. */
  private ctxLoose = false;
  /** Water depth at each tile centre (refreshed when the world changes). */
  private depth = new Float32Array(MAP_W * MAP_H);
  private depthRev = -1;
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
      homeTile: hid ? sim.world.idx(t.x, t.z) : -1,
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
      bestDist: -1,
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
    // placed in water too deep to stand in: start on the nearest wadeable spot
    if (!sp.swims && hid) {
      this.setCtx(a, sp);
      const t0 = this.tileOf(wx, wz);
      if (!this.enterable(t0) || this.depthAt(wx, wz) > this.ctxWade) this.unstick(a, sp, t0);
    }
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
    if (!this.ctxSwims) {
      const ter = w.terrain[t];
      if (ter === Terrain.DeepWater) return false;
      // route only through shallows whose middle is wadeable (moves check the exact depth)
      if (ter === Terrain.Water && !this.ctxLoose && this.depth[t] > this.ctxWade) return false;
    }
    return true;
  }

  /** Water depth (m) at a point (≤ 0 on dry land). */
  private depthAt(x: number, z: number): number {
    return WATER_LEVEL - this.sim.world.heightAt(x, z);
  }

  private refreshDepth() {
    const w = this.sim.world;
    if (this.depthRev === w.revision) return;
    this.depthRev = w.revision;
    for (let i = 0; i < this.depth.length; i++) {
      const t = w.terrain[i];
      this.depth[i] = t === Terrain.Water || t === Terrain.DeepWater ? WATER_LEVEL - w.heightAt(((i % MAP_W) + 0.5) * TILE, (((i / MAP_W) | 0) + 0.5) * TILE) : 0;
    }
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
    this.refreshDepth();
    this.ctxZone = a.escaped ? 0 : a.habitatId ?? 0;
    this.ctxSwims = sp.swims;
    this.ctxWade = sp.swims ? Infinity : wadeDepth(sp, a.growth);
    this.ctxLoose = false;
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
    // non-swimmers only wade where the water stays below about a third of their height
    if (this.ctxWade < Infinity && this.depthAt(tx, tz) > this.ctxWade * 0.92) {
      const wd = this.ctxWade * 0.92;
      let lo = 0,
        hi = 1;
      for (let k = 0; k < 8; k++) {
        const m = (lo + hi) / 2;
        if (this.depthAt(a.x + (tx - a.x) * m, a.z + (tz - a.z) * m) <= wd) lo = m;
        else hi = m;
      }
      const nx = a.x + (tx - a.x) * lo,
        nz = a.z + (tz - a.z) * lo;
      if (Math.hypot(nx - a.x, nz - a.z) < 0.3) return false;
      tx = nx;
      tz = nz;
      if (!this.enterable(this.tileOf(tx, tz))) return false;
    }
    // keep the body clear of fences, facing the way it walks in
    {
      const h = (tx - a.x) ** 2 + (tz - a.z) ** 2 > 0.25 ? Math.atan2(tx - a.x, tz - a.z) : a.heading;
      const c = this.tc2;
      this.clampBody(sp, a.growth, h, tx, tz, c);
      if (this.tileOf(c.x, c.z) === this.tileOf(tx, tz) || this.enterable(this.tileOf(c.x, c.z))) {
        tx = c.x;
        tz = c.z;
      }
    }
    const goal2 = this.tileOf(tx, tz);
    if (goal2 !== goal && !this.enterable(goal2)) return false;
    if (start !== goal2 && !this.lineClear(a.x, a.z, tx, tz)) {
      if (this.routeBudget <= 0) return false;
      this.routeBudget--;
      const r = this.sim.search.route(start, goal2, this.pass, maxNodes, this.tmpRoute);
      if (!r) return false;
      // drop the final tile (we walk to the exact target inside it)
      for (let i = 0; i < r.length - 1; i++) a.route.push(r[i]);
    }
    a.tgtX = tx;
    a.tgtZ = tz;
    a.moving = true;
    a.stuck = 0;
    a.bestDist = -1;
    return true;
  }

  private tileCentre(t: number, out: { x: number; z: number }) {
    out.x = ((t % MAP_W) + 0.5) * TILE;
    out.z = (((t / MAP_W) | 0) + 0.5) * TILE;
    return out;
  }
  private tc = { x: 0, z: 0 };
  private tc2 = { x: 0, z: 0 };

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
    if (hid && !a.escaped) a.homeTile = t;
    if (!a.escaped) {
      if (!hid) {
        // the fence was opened (removed / bulldozed): the animal stays put in its old
        // enclosure, and only counts as escaped once it wanders out through the gap
        const open = a.home && this.sim.enclosures.openOf[t] === a.home ? this.sim.enclosures.find(a.home) : undefined;
        if (open) {
          if (a.habitatId !== null) {
            a.habitatId = null;
            this.sim.markPopulationDirty();
          }
        } else {
          const from = this.sim.enclosures.find(a.home);
          this.becomeLoose(
            a,
            from
              ? `${a.name} the ${sp.name} wandered out of ${from.name} through the open fence!`
              : `${a.name} the ${sp.name} got out — its habitat is no longer fenced in!`,
          );
        }
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
    // never stand inside solid objects or water too deep to wade
    this.setCtx(a, sp);
    this.ctxLoose = true;
    const deep = this.ctxWade === Infinity ? 0 : this.depthAt(a.x, a.z) / this.ctxWade;
    const ok = this.enterable(t) && deep <= 1.35;
    this.ctxLoose = false;
    if (!ok) this.unstick(a, sp, t);
    // standing about in water a little too deep (terrain repainted, old save): wade out
    else if (deep > 1.02 && !a.moving && a.goal !== 'breakout') this.think(a, sp);
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
        } else {
          this.warnNoHome(a, sp);
          // nowhere to take it yet: once there is, staff get a minute before the paid team steps in
          a.escapeTime = RESCUE_AFTER - 60;
        }
      }
    }
  }

  /** Tell the player why a stray can't be taken back (once in a while per home). */
  private warnNoHome(a: AnimalSim, sp: SpeciesDef) {
    const open = this.sim.enclosures.find(a.home);
    const focus = { x: a.x, z: a.z };
    if (open) this.sim.notify(`nohome:${open.id}`, `The animals of ${open.name} can’t be taken back until its fence is closed again.`, 'warn', focus, 300);
    else this.sim.notify(`nohome:${sp.id}`, `${a.name} the ${sp.name} has no habitat to go back to — build one or sell it.`, 'warn', focus, 300);
  }

  private warn(a: AnimalSim, sp: SpeciesDef) {
    const sim = this.sim;
    const hid = a.habitatId;
    if (a.escaped) return;
    if (!hid) {
      // a reminder once the fence has been open a while (removing it already warned)
      const open = sim.enclosures.find(a.home);
      if (open && sim.time - open.openedAt > OPEN_REMINDER_AFTER)
        sim.notify(`open:${open.id}`, `${open.name} is still open — close the gap in its fence before the animals wander off.`, 'bad', { x: a.x, z: a.z }, 150);
      return;
    }
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
      // only when no water is reachable at all; otherwise the animal is on its way to drink
      else if (a.needs.thirst < 0.06 && sim.canNotify(`thirsty:${hid}`, 150) && !this.canReachWater(a, sp, hid))
        sim.notify(`thirsty:${hid}`, `The ${pluralName(sp.id)} in ${where} can’t reach their water.`, 'bad', focus, 150);
    }
    if (a.happiness < 0.3 && a.growth >= 1) {
      const why = this.unhappyReason(a, sim.evalFor(hid, a.speciesId));
      sim.notify(`unhappy:${hid}:${sp.id}`, `${a.name} the ${sp.name} is unhappy${why ? `: ${why}` : ''}.`, 'warn', focus, 300);
    }
  }

  /** The most pressing reason an animal is unhappy: its own state first, then the habitat's worst problem. */
  private unhappyReason(a: AnimalSim, e: SpeciesEval | null): string | undefined {
    const n = a.needs;
    if (n.thirst < 0.2) return e && !e.hasWater ? 'it has nothing to drink — paint a pond or add a Water Trough' : 'it is very thirsty';
    if (n.hunger < 0.2) return this.sim.keeperCount() ? 'it is very hungry' : 'it is very hungry — hire a keeper';
    if (a.sick) return 'it is sick';
    if (a.stress > 0.5 && !e?.predators) return 'it is frightened';
    return e?.issues[0];
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
      const open = sim.enclosures.find(a.home);
      if (!open || !this.chooseLinger(a, sp, open)) this.setGoal(a, 'idle', 3);
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
    // babies stay with their mother, but drink and eat on their own when they need to
    if (a.mother && a.growth < 0.75) {
      if (n.thirst < 0.35 && this.chooseDrink(a, sp, hid)) return;
      if (n.hunger < 0.35 && this.chooseEat(a, sp, hid)) return;
      const m = sim.animals.get(a.mother);
      if (m && !m.escaped && m.habitatId === hid) {
        if (m.action === 'sleep' && !m.moving) {
          if (this.goNear(a, sp, m.x, m.z, bodyRadius(SPECIES_BY_ID[m.speciesId], 1) + 0.6) && this.canBedDown(sp, a.tgtX, a.tgtZ)) {
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

    // wading birds spend much of the day filter-feeding in the shallows
    if (!sp.swims && (sp.terrain[Terrain.Water] ?? 0) >= 0.3 && tiles && rng.chance(0.45) && this.chooseWade(a, sp, tiles.drink)) return;
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
      // nobody sits down in a pond: stand and rest instead
      this.setGoal(a, this.inWater(a, sp) ? 'idle' : 'rest', rng.range(12, 35));
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

  /**
   * The fence of the animal's enclosure was opened: it potters about the old
   * footprint, and now and then (more often when hungry or thirsty, since nobody
   * feeds an open enclosure) finds the gap and wanders out.
   */
  private chooseLinger(a: AnimalSim, sp: SpeciesDef, open: OpenEnclosure): boolean {
    const rng = this.sim.rng;
    const n = a.needs;
    const needy = n.thirst < 0.4 || n.hunger < 0.4;
    if (rng.chance(needy ? 0.3 : 0.08) && this.chooseWanderOut(a, sp, open)) return true;
    if (sp.diet === 'herbivore' && n.hunger < 0.8 && this.onGrazing(a) && rng.chance(0.5)) {
      this.setGoal(a, 'graze', rng.range(8, 20));
      return true;
    }
    if (rng.chance(0.3)) {
      this.setGoal(a, this.inWater(a, sp) ? 'idle' : 'rest', rng.range(6, 20));
      return true;
    }
    this.setCtx(a, sp);
    for (let k = 0; k < 3; k++) {
      const t = this.randomTile(open.tiles);
      if (t < 0 || !this.enterable(t)) continue;
      this.tileCentre(t, this.tc);
      if (this.goTo(a, sp, this.tc.x + rng.range(-0.6, 0.6), this.tc.z + rng.range(-0.6, 0.6))) {
        this.setGoal(a, 'wander', rng.range(1.5, 5), true);
        return true;
      }
    }
    return false;
  }

  /** Head for the nearest tile outside the opened enclosure (through the gap in its fence). */
  private chooseWanderOut(a: AnimalSim, sp: SpeciesDef, open: OpenEnclosure): boolean {
    const openOf = this.sim.enclosures.openOf;
    this.setCtx(a, sp);
    const out = this.sim.search.nearest(this.tileOf(a.x, a.z), this.pass, (t) => openOf[t] !== open.id, open.tiles.length + 64);
    if (out < 0) return false; // closed on every side after all (e.g. by the map edge)
    this.tileCentre(out, this.tc);
    if (!this.goTo(a, sp, this.tc.x, this.tc.z)) return false;
    this.setGoal(a, 'roam', 2, true);
    return true;
  }

  private chooseSleep(a: AnimalSim, sp: SpeciesDef, hid: number): boolean {
    const sim = this.sim;
    const rng = sim.rng;
    const hab = sim.world.habitats.get(hid);
    if (!hab) return false;
    const dur = sim.isNight() ? rng.range(60, 140) : rng.range(25, 60);
    // shelters first
    const shelter = this.nearestObject(a, hab.objects, (id) => OBJECTS_BY_ID[id]?.serves === 'shelter');
    if (shelter && rng.chance(0.75) && this.approachObject(a, sp, shelter, true) && this.canBedDown(sp, a.tgtX, a.tgtZ)) {
      this.setGoal(a, 'sleep', dur, true);
      return true;
    }
    // near herd mates
    for (const b of sim.animals.values()) {
      if (b === a || b.speciesId !== a.speciesId || b.habitatId !== hid || b.escaped) continue;
      if (b.action === 'sleep' || b.goal === 'sleep') {
        if (this.goNear(a, sp, b.x, b.z, bodyRadius(sp, 1) * 2.2) && this.canBedDown(sp, a.tgtX, a.tgtZ)) {
          this.setGoal(a, 'sleep', dur, true);
          return true;
        }
        break;
      }
    }
    this.stopMoving(a);
    const tiles = sim.habitatTiles(hid);
    if (!tiles) return false;
    const pool = tiles.interior.length ? tiles.interior : tiles.land;
    for (let k = 0, routes = 0; k < 8 && routes < 2; k++) {
      const t = this.randomTile(pool);
      if (t < 0) return false;
      this.tileCentre(t, this.tc);
      const x = this.tc.x + rng.range(-0.5, 0.5),
        z = this.tc.z + rng.range(-0.5, 0.5);
      if (!this.canBedDown(sp, x, z)) continue;
      routes++;
      if (this.goTo(a, sp, x, z)) {
        this.setGoal(a, 'sleep', dur, true);
        return true;
      }
    }
    return false;
  }

  /** A non-swimmer standing in water (more than ankle deep). */
  private inWater(a: AnimalSim, sp: SpeciesDef): boolean {
    return !sp.swims && WATER_LEVEL - this.sim.world.heightAt(a.x, a.z) > WET_DEPTH;
  }

  /** Can the animal sleep at (x, z)? Not in water, except waders: they sleep standing on one leg. */
  private canBedDown(sp: SpeciesDef, x: number, z: number): boolean {
    return sp.swims || sp.rig === 'bird' || WATER_LEVEL - this.sim.world.heightAt(x, z) <= WET_DEPTH;
  }

  private stopMoving(a: AnimalSim) {
    a.moving = false;
    a.route.length = 0;
    a.routeIdx = 0;
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
          const lean = Math.max(0, 0.95 - halfWidth(sp, a.growth));
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

  /** Stand in the shallows, the water up to a little below the wading limit. */
  private chooseWade(a: AnimalSim, sp: SpeciesDef, drink: number[]): boolean {
    const w = this.sim.world;
    const rng = this.sim.rng;
    if (!drink.length) return false;
    const wd = wadeDepth(sp, a.growth);
    for (let k = 0; k < 10; k++) {
      const t = drink[Math.floor(rng.float() * drink.length)];
      if (w.terrain[t] !== Terrain.Water) continue;
      const x = ((t % MAP_W) + rng.range(0.1, 0.9)) * TILE,
        z = (((t / MAP_W) | 0) + rng.range(0.1, 0.9)) * TILE;
      const d = this.depthAt(x, z);
      if (d < wd * 0.3 || d > wd * 0.85) continue;
      if (this.goTo(a, sp, x, z)) {
        a.face = rng.range(-Math.PI, Math.PI);
        this.setGoal(a, 'graze', rng.range(10, 25), true);
        return true;
      }
    }
    return false;
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

  /** Is there a drinking spot (water's edge or a trough) the animal can walk to? */
  private canReachWater(a: AnimalSim, sp: SpeciesDef, hid: number): boolean {
    const w = this.sim.world;
    const tiles = this.sim.habitatTiles(hid);
    const hab = w.habitats.get(hid);
    if (!tiles || !hab) return false;
    const spots = new Set(tiles.drink);
    for (const oid of hab.objects) {
      const o = w.objects.get(oid);
      if (!o || o.defId !== 'water_trough') continue;
      for (const f of w.footprint(o))
        for (let k = 0; k < 4; k++) {
          const nx = f.x + (k === 0 ? 1 : k === 1 ? -1 : 0),
            nz = f.z + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (w.inBounds(nx, nz) && !w.fenceBetween(f.x, f.z, nx, nz)) spots.add(w.idx(nx, nz));
        }
    }
    this.setCtx(a, sp);
    return this.sim.search.nearest(this.tileOf(a.x, a.z), this.pass, (t) => spots.has(t) && this.enterable(t), 4000) >= 0;
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
      const lean = nearOnly ? 0 : Math.max(0, 0.95 - Math.max(halfWidth(sp, a.growth), halfLength(sp, a.growth) * 0.55));
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

  /**
   * Habitat a stray should be taken back to (0 = none for now): its home; else the
   * habitat now covering its old home ground (fence rebuilt or moved); nothing while
   * its home enclosure is merely open (it goes back once that is closed again);
   * else the best habitat that suits the species and its residents.
   */
  homeFor(a: AnimalSim): number {
    const sim = this.sim;
    const w = sim.world;
    if (w.habitats.has(a.home)) return a.home;
    const covering = a.homeTile >= 0 && a.homeTile < w.habitatOf.length ? w.habitatOf[a.homeTile] : 0;
    if (covering) return covering;
    if (sim.enclosures.find(a.home)) return 0;
    const sp = SPECIES_BY_ID[a.speciesId];
    if (!sp) return 0;
    let best = 0,
      bestScore = -1;
    for (const hab of w.habitats.values()) {
      const pop = sim.population(hab.id);
      const e = evaluateSpecies(w, hab, sp, pop, sim.keeperCount(), true);
      if (e.compat < 0.9 || !e.fenceOk) continue; // never among predators / prey, nor behind a weak fence
      // its own kind first, then the best suited
      const score = e.score + ((pop.count.get(sp.id) ?? 0) > 0 ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = hab.id;
      }
    }
    return best;
  }

  /** Put an animal down at a validated spot inside a habitat (the player's Move command). */
  relocate(a: AnimalSim, wx: number, wz: number) {
    const w = this.sim.world;
    const sp = SPECIES_BY_ID[a.speciesId];
    const t = w.tileOfWorld(wx, wz);
    const hid = w.habitatAt(t.x, t.z)?.id ?? 0;
    a.x = a.tgtX = wx;
    a.z = a.tgtZ = wz;
    a.habitatId = hid || null;
    a.home = hid;
    a.homeTile = hid ? w.idx(t.x, t.z) : -1;
    a.crossing = false;
    a.moving = false;
    a.route.length = 0;
    a.routeIdx = 0;
    a.ref = 0;
    a.stuck = 0;
    a.bestDist = -1;
    a.face = NO_FACE;
    a.goal = 'idle';
    a.goalTime = 2;
    // set down in shallows too deep to stand in: step onto the nearest spot it can stand on
    if (!sp.swims) {
      this.setCtx(a, sp);
      const t0 = this.tileOf(wx, wz);
      if (!this.enterable(t0) || this.depthAt(wx, wz) > this.ctxWade) this.unstick(a, sp, t0);
    }
    this.placeY(a, sp);
    this.sim.markPopulationDirty();
  }

  /** Carry an escaped animal back to its habitat (staff / rescue). Returns success. */
  returnHome(a: AnimalSim): boolean {
    const sim = this.sim;
    const sp = SPECIES_BY_ID[a.speciesId];
    const hid = this.homeFor(a);
    if (!hid) return false;
    const tiles = sim.habitatTiles(hid);
    if (!tiles) return false;
    const pool = tiles.interior.length ? tiles.interior : tiles.land;
    this.setCtx(a, sp);
    this.ctxZone = hid;
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
        const reach = Math.max(0.8, halfLength(sp, a.growth) * 0.6);
        if (cur === t || d2 < reach * reach) {
          a.routeIdx++;
          a.bestDist = -1;
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
    this.checkProgress(a, sp, dt, dist, final, moved, ad);
    this.placeY(a, sp);
  }

  /**
   * Stuck = no progress towards the current waypoint. Sliding along a fence or being
   * clamped back by a fence / water margin still moves the body a little every
   * step, so progress is judged by the distance closed (5 cm), not by movement.
   * After STUCK_REPLAN s the route is planned again; after STUCK_GIVE_UP s the
   * animal settles where it is if that is close enough, or picks something else.
   */
  private checkProgress(a: AnimalSim, sp: SpeciesDef, dt: number, dist: number, final: boolean, moved: boolean, turning: number) {
    const was = a.stuck;
    if (a.goal === 'hunt' || a.goal === 'follow') {
      // chasing a moving target: only a blocked body counts
      a.stuck = moved ? Math.max(0, a.stuck - dt) : a.stuck + dt;
    } else if (a.bestDist < 0) a.bestDist = dist;
    else if (dist < a.bestDist - 0.05) {
      a.bestDist = dist;
      a.stuck = 0;
    } else if (turning < 0.6 || !moved) a.stuck += dt; // (turning round on the spot is not being stuck)
    if (a.stuck <= STUCK_REPLAN) return;
    // close enough: jostling with a herd mate for the same spot, or already at the water's edge to drink
    const settle = final && a.goal !== 'hunt' && a.goal !== 'breakout';
    const nearSpot = (reach: number) => settle && (dist < reach || (a.goal === 'drink' && this.atWater(a, sp)));
    const r = bodyRadius(sp, a.growth);
    if (was <= STUCK_REPLAN) {
      if (nearSpot(Math.max(0.6, r * 1.2))) {
        a.stuck = 0;
        this.arrive(a);
      } else if (this.goTo(a, sp, a.tgtX, a.tgtZ)) {
        a.stuck = was + dt; // keep counting: a hopeless target is still given up
        a.speed = 0;
      }
    } else if (a.stuck > STUCK_GIVE_UP) {
      a.stuck = 0;
      if (nearSpot(Math.max(1, r + 0.8))) this.arrive(a);
      else {
        this.stopMoving(a);
        this.setGoal(a, 'idle', 1);
      }
    }
  }

  /** Is the animal's head at (or in) water it may drink from? */
  private atWater(a: AnimalSim, sp: SpeciesDef): boolean {
    const w = this.sim.world;
    const x = Math.floor(a.x / TILE),
      z = Math.floor(a.z / TILE);
    const reach = halfLength(sp, a.growth) + 0.5;
    for (let k = 0; k < 5; k++) {
      const nx = x + (k === 1 ? 1 : k === 2 ? -1 : 0),
        nz = z + (k === 3 ? 1 : k === 4 ? -1 : 0);
      if (!w.inBounds(nx, nz) || (k > 0 && w.fenceBetween(x, z, nx, nz))) continue;
      const t = w.terrain[w.idx(nx, nz)];
      if (t !== Terrain.Water && t !== Terrain.DeepWater) continue;
      // distance from the body centre to that water tile
      const ddx = Math.max(nx * TILE - a.x, 0, a.x - (nx + 1) * TILE),
        ddz = Math.max(nz * TILE - a.z, 0, a.z - (nz + 1) * TILE);
      if (ddx * ddx + ddz * ddz < reach * reach) return true;
    }
    return false;
  }

  /** Move to (nx, nz) if legal, sliding along walls. Returns whether the animal moved. */
  private tryMove(a: AnimalSim, sp: SpeciesDef, nx: number, nz: number): boolean {
    this.setCtx(a, sp);
    this.ctxLoose = true;
    const ct = this.tileOf(a.x, a.z);
    const here = this.ctxWade < Infinity ? this.depthAt(a.x, a.z) : 0;
    if (!this.moveOk(ct, here, nx, nz)) {
      if (this.moveOk(ct, here, nx, a.z)) nz = a.z;
      else if (this.moveOk(ct, here, a.x, nz)) nx = a.x;
      else {
        this.ctxLoose = false;
        return false;
      }
    }
    const ox = a.x,
      oz = a.z;
    a.x = nx;
    a.z = nz;
    this.applyMargins(a, sp);
    this.ctxLoose = false;
    return Math.abs(a.x - ox) + Math.abs(a.z - oz) > 1e-5;
  }

  /** Can the current animal step to (x, z)? Water deeper than it wades blocks unless it gets shallower. */
  private moveOk(ct: number, here: number, x: number, z: number): boolean {
    const t = this.tileOf(x, z);
    if (t !== ct && !this.passable(ct, t)) return false;
    if (this.ctxWade < Infinity) {
      const d = this.depthAt(x, z);
      if (d > this.ctxWade && d > here + 1e-4) return false;
    }
    return true;
  }

  /** Keep the body (by its length and heading) clear of fences and blocked tiles. */
  private applyMargins(a: AnimalSim, sp: SpeciesDef) {
    const c = this.tc2;
    this.clampBody(sp, a.growth, a.heading, a.x, a.z, c);
    a.x = c.x;
    a.z = c.z;
  }

  /**
   * Clamp a body centre so an animal of this size facing `h` does not poke
   * through a fence (or the map edge / another zone), scanning a few tiles along
   * each axis; solid objects and water it can't enter get a small margin only.
   */
  private clampBody(sp: SpeciesDef, growth: number, h: number, x: number, z: number, out: { x: number; z: number }) {
    const w = this.sim.world;
    const L = halfLength(sp, growth),
      W = halfWidth(sp, growth);
    const sh = Math.abs(Math.sin(h)),
      ch = Math.abs(Math.cos(h));
    const ex = sh * L + ch * W + FENCE_CLEAR,
      ez = ch * L + sh * W + FENCE_CLEAR;
    const soft = Math.min(0.55, W * 0.8 + 0.15);
    const tx = Math.floor(x / TILE),
      tz = Math.floor(z / TILE);
    out.x = x;
    out.z = z;
    if (tx < 0 || tz < 0 || tx >= MAP_W || tz >= MAP_H) return;
    const zone = this.ctxZone;
    const hab = w.habitatOf;
    let lo = -Infinity,
      hi = Infinity;
    // ---- x axis (scan along row tz)
    for (let k = 0, cx = tx; k < 5; k++, cx++) {
      const edge = (cx + 1) * TILE;
      if (edge - x >= Math.max(ex, soft)) break;
      if (cx + 1 >= MAP_W || w.fenceBetween(cx, tz, cx + 1, tz) || hab[tz * MAP_W + cx + 1] !== zone) {
        hi = edge - ex;
        break;
      }
      if (!this.passable(tz * MAP_W + cx, tz * MAP_W + cx + 1)) {
        if (k === 0) hi = edge - soft;
        break;
      }
    }
    for (let k = 0, cx = tx; k < 5; k++, cx--) {
      const edge = cx * TILE;
      if (x - edge >= Math.max(ex, soft)) break;
      if (cx - 1 < 0 || w.fenceBetween(cx, tz, cx - 1, tz) || hab[tz * MAP_W + cx - 1] !== zone) {
        lo = edge + ex;
        break;
      }
      if (!this.passable(tz * MAP_W + cx, tz * MAP_W + cx - 1)) {
        if (k === 0) lo = edge + soft;
        break;
      }
    }
    if (lo > hi) out.x = (lo + hi) / 2;
    else out.x = Math.max(lo, Math.min(hi, x));
    // ---- z axis (scan along column tx)
    lo = -Infinity;
    hi = Infinity;
    for (let k = 0, cz = tz; k < 5; k++, cz++) {
      const edge = (cz + 1) * TILE;
      if (edge - z >= Math.max(ez, soft)) break;
      if (cz + 1 >= MAP_H || w.fenceBetween(tx, cz, tx, cz + 1) || hab[(cz + 1) * MAP_W + tx] !== zone) {
        hi = edge - ez;
        break;
      }
      if (!this.passable(cz * MAP_W + tx, (cz + 1) * MAP_W + tx)) {
        if (k === 0) hi = edge - soft;
        break;
      }
    }
    for (let k = 0, cz = tz; k < 5; k++, cz--) {
      const edge = cz * TILE;
      if (z - edge >= Math.max(ez, soft)) break;
      if (cz - 1 < 0 || w.fenceBetween(tx, cz, tx, cz - 1) || hab[(cz - 1) * MAP_W + tx] !== zone) {
        lo = edge + ez;
        break;
      }
      if (!this.passable(cz * MAP_W + tx, (cz - 1) * MAP_W + tx)) {
        if (k === 0) lo = edge + soft;
        break;
      }
    }
    if (lo > hi) out.z = (lo + hi) / 2;
    else out.z = Math.max(lo, Math.min(hi, z));
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
      // turning near a fence: shuffle back so the head stays inside
      this.setCtx(a, sp);
      this.ctxLoose = true;
      this.applyMargins(a, sp);
      this.ctxLoose = false;
    }
    this.placeY(a, sp);
  }

  /** Ground height, or the water surface for a swimmer in water deeper than it can stand in. */
  private placeY(a: AnimalSim, sp: SpeciesDef) {
    const g = this.sim.world.heightAt(a.x, a.z);
    a.y = sp.swims && WATER_LEVEL - g > swimDepth(sp, a.growth) ? WATER_LEVEL : g;
  }

  private updateAction(a: AnimalSim, sp: SpeciesDef, dt: number) {
    let act = a.action;
    const swimming = sp.swims && a.y === WATER_LEVEL;
    if (swimming) act = 'swim';
    else if (a.moving && a.speed > 0.05) act = a.speed > sp.walkSpeed * 1.45 ? 'run' : 'walk';
    else if (a.moving) act = 'idle';
    else act = ANIMAL_ACTION_FOR_GOAL[a.goal];
    // never sit (nor, except waders, sleep) in water: stand instead
    if ((act === 'sit' || (act === 'sleep' && sp.rig !== 'bird')) && !sp.swims && WATER_LEVEL - a.y > WET_DEPTH) act = 'idle';
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
