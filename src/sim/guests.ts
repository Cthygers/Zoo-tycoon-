// Guest AI: arrive through the gate (paying admission), walk only on paths
// (following cached distance fields), view habitats, buy food / drinks /
// souvenirs, use restrooms, rest on benches, drop litter, donate, and head home.

import { CLOSE_HOUR, MAP_H, MAP_W, OPEN_HOUR, TILE } from '../core/constants';
import type { PlacedObject, ShopKind } from '../core/types';
import { FENCES_BY_ID } from '../data/fences';
import { OBJECTS_BY_ID } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import { personName, pluralName, randomGuestAppearance, singularName } from './names';
import { FAR, N_TILES } from './nav';
import { hash01 } from './rng';
import type { Simulation } from './simulation';
import type { GuestSim } from './state';
import { approach, personY, standFacing, turnTowards, walkToNext } from './walker';

const SHOP_KINDS: ShopKind[] = ['food', 'drink', 'icecream', 'gift'];
const HALF_DX = [0, 1, -1, 0, 1];
const HALF_DZ = [0, 0, 1, 1, 1];
const DX = [1, -1, 0, 0];
const DZ = [0, 0, 1, -1];
/** Minute of day after which remaining guests are removed (escorted out). */
const LATE_CLEAR = (CLOSE_HOUR + 1.5) * 60;
/** Seconds a guest spends inside the restroom. */
const RESTROOM_TIME = 7;

export class GuestSystem {
  private fills = new Map<string, (out: number[]) => void>();
  private gateTmp: number[] = [];
  private toRemove: number[] = [];
  /** Guests allowed in the park right now (scales with zoo size). */
  capacity = 40;
  private capRev = -1;
  /** Admission value factor from the last arrival-rate estimate (1 = fair price). */
  priceFactor = 1;
  private deterred = 0;

  constructor(private sim: Simulation) {}

  // ================================================================ fields
  /** Source-filler for a navigation key (created once per key). */
  private fillFor(key: string): (out: number[]) => void {
    let f = this.fills.get(key);
    if (f) return f;
    const sim = this.sim;
    if (key === 'exit') f = (out) => sim.gateTiles(this.gateTmp).forEach((t) => out.push(t));
    else if (key.startsWith('hab:')) {
      const id = Number(key.slice(4));
      f = (out) => {
        const h = sim.world.habitats.get(id);
        if (h) for (const t of h.viewTiles) out.push(t);
      };
    } else if (key.startsWith('t:')) {
      const t = Number(key.slice(2));
      f = (out) => out.push(t);
    } else {
      // object categories: shop:<kind>, restroom, bench, donation
      const match = (defId: string): boolean => {
        const d = OBJECTS_BY_ID[defId];
        if (!d) return false;
        if (key.startsWith('shop:')) return d.shop?.kind === key.slice(5);
        if (key === 'restroom') return !!d.restroom;
        if (key === 'bench') return !!d.bench;
        if (key === 'donation') return defId === 'donation_box';
        return false;
      };
      f = (out) => {
        for (const o of sim.world.objects.values()) if (match(o.defId)) sim.nav.accessTiles(o, out);
      };
    }
    this.fills.set(key, f);
    return f;
  }

  field(key: string): Uint16Array {
    return this.sim.nav.field(key, this.fillFor(key));
  }

  /** Distance (tiles) from a tile to the goal of `key`, FAR if unreachable. */
  distance(key: string, tile: number): number {
    if (tile < 0 || tile >= N_TILES) return FAR;
    return this.field(key)[tile];
  }

  // ================================================================ spawn
  private updateCapacity() {
    const w = this.sim.world;
    if (this.capRev === w.revision) return;
    this.capRev = w.revision;
    let paths = 0;
    for (let i = 0; i < w.path.length; i++) if (w.path[i]) paths++;
    this.capacity = Math.round(Math.max(40, Math.min(150, 30 + paths * 0.45 + w.habitats.size * 10)));
  }

  /** Expected arrivals per game hour right now. */
  arrivalRate(): number {
    const sim = this.sim;
    const appeal = new Map<string, number>();
    let count = 0;
    let happy = 0;
    for (const a of sim.animals.values()) {
      if (a.escaped) continue;
      count++;
      happy += a.happiness;
      if (!appeal.has(a.speciesId)) appeal.set(a.speciesId, SPECIES_BY_ID[a.speciesId]?.appeal ?? 5);
    }
    let attraction = 0;
    for (const v of appeal.values()) attraction += v;
    attraction += Math.min(20, count * 0.4);
    if (count) attraction *= 0.7 + 0.3 * (happy / count);
    attraction = Math.min(130, attraction);
    const fair = 8 + attraction * 0.6;
    const priceFactor = Math.max(0.05, Math.min(1.5, 1.5 - (0.5 * sim.admissionPrice) / fair));
    this.priceFactor = priceFactor;
    const h = sim.minuteOfDay / 60;
    const tod = h < OPEN_HOUR + 1 ? 0.8 : h < 13 ? 1.2 : h < CLOSE_HOUR - 2 ? 0.95 : h < CLOSE_HOUR - 1 ? 0.45 : 0;
    return (2 + attraction * 0.9) * (0.35 + (sim.rating / 100) * 1.1) * priceFactor * tod;
  }

  private trySpawn(hours: number) {
    const sim = this.sim;
    if (!sim.isOpen() || sim.minuteOfDay >= (CLOSE_HOUR - 1) * 60) {
      sim.spawnAcc = 0;
      return;
    }
    this.updateCapacity();
    const rate = this.arrivalRate();
    sim.spawnAcc += rate * hours;
    // visitors who looked at the ticket price and walked away
    if (this.priceFactor < 0.75) {
      this.deterred += (rate / this.priceFactor) * (1 - this.priceFactor) * hours;
      if (this.deterred >= 1) {
        sim.progress.complaints.price += Math.floor(this.deterred);
        this.deterred -= Math.floor(this.deterred);
      }
    }
    while (sim.spawnAcc >= 1) {
      sim.spawnAcc -= 1;
      if (sim.guests.size >= this.capacity) {
        sim.spawnAcc = Math.min(sim.spawnAcc, 1);
        break;
      }
      this.spawn();
    }
  }

  spawn(): GuestSim | null {
    const sim = this.sim;
    const rng = sim.rng;
    const gates = sim.gateTiles(this.gateTmp);
    if (!gates.length) return null;
    const tile = gates[rng.int(0, gates.length - 1)];
    // guests who think the ticket is too pricey turn around at the gate
    const child = rng.chance(0.25);
    const appearance = randomGuestAppearance(rng, child);
    const budget = child ? rng.range(6, 22) : rng.range(18, 80);
    const tx = tile % MAP_W;
    const x = (tx + 0.5) * TILE + rng.range(-0.6, 0.6);
    const z = MAP_H * TILE - 0.25;
    const id = sim.nextIds.guest++;
    const g: GuestSim = {
      id,
      name: personName(rng, appearance.female),
      appearance,
      x,
      y: personY(sim.world, x, z),
      z,
      heading: Math.PI,
      speed: 0,
      action: 'walk',
      actionTime: 0,
      needs: {
        hunger: rng.range(0.55, 1),
        thirst: rng.range(0.55, 1),
        bladder: rng.range(0.55, 1),
        energy: rng.range(0.75, 1),
        fun: rng.range(0.25, 0.45),
      },
      happiness: rng.range(0.6, 0.8),
      money: Math.round(budget),
      holding: 'none',
      thoughts: [],
      seenSpecies: [],
      hidden: false,
      seed: rng.int(0, 0x7fffffff),
      tile,
      next: -1,
      prev: -1,
      lane: rng.range(0.2, 0.7),
      walkSpeed: child ? rng.range(1.0, 1.3) : Math.max(0.9, Math.min(1.55, 1.25 + rng.gauss() * 0.13)),
      phase: 0,
      ax: x,
      az: z,
      faceHeading: 0,
      goalKey: '',
      wanderSteps: 0,
      stuck: 0,
      goal: 'enter',
      goalRef: 0,
      timer: 0,
      holdTime: 0,
      visitLeft: Math.max(30, Math.min(rng.range(80, 190), ((CLOSE_HOUR - 1) * 60 - sim.minuteOfDay) / 4)),
      think: 0,
      mood: 0,
      funRate: 0,
      seatObj: 0,
      seatIdx: 0,
      lookTimer: rng.range(1, 3),
      donated: false,
      viewed: [],
      scenic: 0.3,
    };
    // walk in from the gate to its tile centre
    g.phase = 1;
    g.ax = (tx + 0.5) * TILE + rng.range(-0.5, 0.5);
    g.az = ((tile / MAP_W) | 0) * TILE + TILE * 0.5;
    sim.guests.set(id, g);
    if (sim.admissionPrice > 0) sim.earn('admissions', sim.admissionPrice, { x: g.ax, z: z - 1 });
    sim.guestsToday++;
    sim.totalVisitors++;
    sim.events.emit('guestAdded', { id });
    return g;
  }

  // ================================================================ update
  update(dt: number, hours: number) {
    const sim = this.sim;
    this.trySpawn(hours);
    sim.ensureSceneryGrid();
    sim.nav.sync();
    // after closing, stragglers still inside are shown out by security
    const late = sim.minuteOfDay >= LATE_CLEAR || sim.minuteOfDay < OPEN_HOUR * 60 - 60;
    for (const g of sim.guests.values()) {
      if (late && g.phase !== 3) {
        this.toRemove.push(g.id);
        continue;
      }
      this.updateGuest(g, dt);
    }
    // crowd separation at ~30 Hz is plenty (people move a few cm per step)
    sim.crowdAcc += dt;
    if (sim.crowdAcc >= 1 / 30) {
      sim.crowdAcc = 0;
      this.separate();
    }
    if (this.toRemove.length) {
      for (const id of this.toRemove) {
        const g = sim.guests.get(id);
        if (!g) continue;
        sim.satisfaction += (g.happiness - sim.satisfaction) * 0.05;
        if (g.seatObj) g.seatObj = 0;
        sim.guests.delete(id);
        sim.events.emit('guestRemoved', { id });
      }
      this.toRemove.length = 0;
    }
  }

  // ================================================================ crowding
  private head = new Int32Array(N_TILES).fill(-1);
  private link = new Int32Array(1024);
  private crowd: GuestSim[] = [];
  private touched: number[] = [];

  /** Push apart people standing / walking on top of each other (spatial hash per tile). */
  private separate() {
    const sim = this.sim;
    const crowd = this.crowd;
    crowd.length = 0;
    const head = this.head;
    for (const t of this.touched) head[t] = -1;
    this.touched.length = 0;
    for (const g of sim.guests.values()) {
      if (g.hidden || g.phase === 3 || g.action === 'sit' || crowd.length >= this.link.length) continue;
      const t = Math.floor(g.z / TILE) * MAP_W + Math.floor(g.x / TILE);
      if (t < 0 || t >= N_TILES) continue;
      const k = crowd.length;
      crowd.push(g);
      this.link[k] = head[t];
      if (head[t] < 0) this.touched.push(t);
      head[t] = k;
    }
    const w = sim.world;
    for (let k = 0; k < crowd.length; k++) {
      const a = crowd[k];
      const tx = Math.floor(a.x / TILE),
        tz = Math.floor(a.z / TILE);
      // half neighbourhood: own tile (j > k) + E, SW, S, SE — every pair is visited once
      for (let q = 0; q < 5; q++) {
        const nx = tx + HALF_DX[q],
          nz = tz + HALF_DZ[q];
        if (nx < 0 || nz < 0 || nx >= MAP_W || nz >= MAP_H) continue;
        for (let j = head[nz * MAP_W + nx]; j >= 0; j = this.link[j]) {
            if (q === 0 && j <= k) continue;
            const b = crowd[j];
            const ddx = b.x - a.x,
              ddz = b.z - a.z;
            const min = a.appearance.child || b.appearance.child ? 0.42 : 0.52;
            const d2 = ddx * ddx + ddz * ddz;
            if (d2 >= min * min) continue;
            const d = Math.sqrt(d2);
            let ux: number, uz: number;
            if (d < 1e-4) {
              const ang = hash01(a.id, b.id) * Math.PI * 2;
              ux = Math.cos(ang);
              uz = Math.sin(ang);
            } else {
              ux = ddx / d;
              uz = ddz / d;
            }
            const push = (min - d) * 0.5;
            // people busy at a counter / fence hold their place a little more
            const wa = a.phase === 2 ? 0.35 : 0.65,
              wb = b.phase === 2 ? 0.35 : 0.65;
            const sum = wa + wb;
            this.push(a, -ux * push * (2 * wa) / sum, -uz * push * (2 * wa) / sum, w);
            this.push(b, ux * push * (2 * wb) / sum, uz * push * (2 * wb) / sum, w);
        }
      }
    }
  }

  /** Walkers only sidestep (keep their forward progress); others are pushed fully. */
  private push(g: GuestSim, dx: number, dz: number, w: Simulation['world']) {
    if (g.phase === 0 && g.next >= 0) {
      const fx = (g.next % MAP_W) - (g.tile % MAP_W),
        fz = ((g.next / MAP_W) | 0) - ((g.tile / MAP_W) | 0);
      const l = Math.hypot(fx, fz) || 1;
      const ux = fx / l,
        uz = fz / l;
      const along = dx * ux + dz * uz;
      dx -= along * ux;
      dz -= along * uz;
      if (along > 0) {
        // being pushed from behind: allow a little forward shove
        dx += along * 0.5 * ux;
        dz += along * 0.5 * uz;
      }
    }
    this.nudge(g, dx, dz, w);
  }

  /** Move a person by (dx, dz) but never off the path network. */
  private nudge(g: GuestSim, dx: number, dz: number, w: Simulation['world']) {
    const nx = g.x + dx,
      nz = g.z + dz;
    const okX = w.isPath(Math.floor(nx / TILE), Math.floor(g.z / TILE));
    if (okX) g.x = nx;
    const okZ = w.isPath(Math.floor(g.x / TILE), Math.floor(nz / TILE));
    if (okZ) g.z = nz;
    if (g.phase === 1) {
      // keep the approach target consistent so we don't walk straight back into the crowd
      if (okX) g.ax += dx * 0.5;
      if (okZ) g.az += dz * 0.5;
    }
  }

  private updateGuest(g: GuestSim, dt: number) {
    const sim = this.sim;
    const n = g.needs;
    const sitting = g.action === 'sit';
    // needs (per simulated second — a visit lasts a few minutes)
    n.hunger = Math.max(0, n.hunger - dt / 170);
    n.thirst = Math.max(0, n.thirst - dt / 140);
    n.bladder = Math.max(0, n.bladder - dt / 160);
    if (sitting) n.energy = Math.min(1, n.energy + dt * 0.05);
    else n.energy = Math.max(0, n.energy - dt / (g.appearance.child ? 260 : 220));
    if (g.action === 'watch') n.fun = Math.min(1, n.fun + g.funRate * dt);
    else n.fun = Math.max(0, n.fun - dt / 120);
    this.consume(g, dt);
    g.mood *= 1 - Math.min(1, 0.03 * dt);
    const basic = Math.min(n.hunger, n.thirst, n.bladder);
    const comfort = basic < 0.25 ? basic * 2 : 0.5 + basic * 0.5;
    const target = Math.max(0, Math.min(1, 0.24 + 0.4 * n.fun + 0.1 * n.energy + 0.14 * comfort + 0.12 * g.scenic + g.mood));
    g.happiness += (target - g.happiness) * Math.min(1, dt * 0.06);
    g.visitLeft -= dt;
    g.lookTimer -= dt;
    if (g.lookTimer <= 0) {
      g.lookTimer = 2.5;
      this.look(g);
    }
    const prevAction = g.action;
    switch (g.phase) {
      case 0:
        this.walkPhase(g, dt);
        break;
      case 1:
        g.action = 'walk';
        if (approach(sim.world, g, dt, g.goal === 'enter' ? 1 : 0.7)) this.beginAction(g);
        break;
      case 2:
        standFacing(g, g.faceHeading, dt);
        g.timer -= dt;
        if (g.timer <= 0) this.finishAction(g);
        break;
      case 3: {
        // walking out through the gate to the map edge
        g.action = 'leave';
        g.speed = g.walkSpeed;
        g.z += g.speed * dt;
        turnTowards(g, 0, dt);
        g.y = personY(sim.world, g.x, Math.min(g.z, MAP_H * TILE - 0.01));
        if (g.z > MAP_H * TILE + 0.6) this.toRemove.push(g.id);
        break;
      }
    }
    if (g.action !== prevAction) g.actionTime = 0;
    else g.actionTime += dt;
  }

  /** Eating / drinking the held item while walking. */
  private consume(g: GuestSim, dt: number) {
    if (g.holdTime <= 0) return;
    const n = g.needs;
    g.holdTime -= dt;
    if (g.holding === 'food') n.hunger = Math.min(1, n.hunger + dt * 0.035);
    else if (g.holding === 'drink') n.thirst = Math.min(1, n.thirst + dt * 0.04);
    else if (g.holding === 'icecream') {
      n.hunger = Math.min(1, n.hunger + dt * 0.012);
      n.thirst = Math.min(1, n.thirst + dt * 0.015);
      n.fun = Math.min(1, n.fun + dt * 0.004);
    }
    if (g.holdTime <= 0) {
      const wasDrink = g.holding === 'drink';
      g.holdTime = 0;
      g.holding = 'none';
      if (wasDrink) n.bladder = Math.max(0, n.bladder - 0.2);
      this.dropLitterMaybe(g);
    }
  }

  private dropLitterMaybe(g: GuestSim) {
    const sim = this.sim;
    if (g.tile < 0 || sim.binNear[g.tile]) return;
    if (!sim.rng.chance(0.35)) return;
    const tx = g.tile % MAP_W,
      tz = (g.tile / MAP_W) | 0;
    if (!sim.world.isPath(tx, tz)) return;
    const x = (tx + 0.5) * TILE + sim.rng.range(-0.8, 0.8);
    const z = (tz + 0.5) * TILE + sim.rng.range(-0.8, 0.8);
    sim.addLitter('trash', x, z);
  }

  // ================================================================ walking
  private walkPhase(g: GuestSim, dt: number) {
    const sim = this.sim;
    g.action = 'walk';
    if (g.next < 0 && !this.chooseNext(g)) return;
    if (g.next < 0) return;
    // the path under our feet may have been removed
    if (!sim.nav.adj[g.tile] && !sim.world.path[g.next]) {
      this.recover(g);
      return;
    }
    if (walkToNext(sim.world, g, dt, g.goal === 'leave' && sim.minuteOfDay >= (CLOSE_HOUR - 0.5) * 60 ? 1.35 : 1)) {
      // reached the tile centre: immediately pick the next tile so motion is continuous
      g.think -= 0;
      if (g.goal === 'wander') g.wanderSteps--;
      this.chooseNext(g);
    }
  }

  /** Decide the next tile (or arrive). Returns false if the guest stopped walking. */
  private chooseNext(g: GuestSim): boolean {
    const sim = this.sim;
    const nav = sim.nav;
    // re-evaluate needs at tile centres while wandering / every so often
    if (g.goal === 'wander' || g.goal === 'enter') {
      if (g.wanderSteps <= 0 || g.goal === 'enter') {
        this.think(g);
        if (g.phase !== 0) return false;
        if (g.goal !== 'wander') return this.chooseNext(g);
      }
      if (!sim.world.path[g.tile]) {
        this.recover(g);
        return false;
      }
      const nxt = nav.wanderStep(g.tile, g.prev, sim.rng.float());
      if (nxt < 0) {
        g.wanderSteps = 0;
        this.think(g);
        return false;
      }
      g.next = nxt;
      return true;
    }
    const f = this.field(g.goalKey);
    const d = f[g.tile];
    if (d === 0) {
      this.arrive(g);
      return false;
    }
    if (d === FAR) {
      if (!sim.world.path[g.tile]) {
        this.recover(g);
        return false;
      }
      if (g.goal === 'leave') {
        // no way out (paths cut): slip out quietly
        this.toRemove.push(g.id);
        g.phase = 3;
        return false;
      }
      this.setWander(g, 4);
      return true;
    }
    g.next = nav.downhill(f, g.tile, g.seed);
    return g.next >= 0;
  }

  /** Off the path network (e.g. the path was bulldozed): step back onto the nearest path. */
  private recover(g: GuestSim) {
    const sim = this.sim;
    const tx = Math.floor(g.x / TILE),
      tz = Math.floor(g.z / TILE);
    const t = sim.nav.nearestPathTile(tx, tz, 6);
    if (t < 0) {
      this.toRemove.push(g.id);
      g.phase = 3;
      return;
    }
    g.tile = t;
    g.next = -1;
    g.prev = -1;
    g.phase = 1;
    g.goal = 'enter';
    g.ax = ((t % MAP_W) + 0.5) * TILE;
    g.az = (((t / MAP_W) | 0) + 0.5) * TILE;
  }

  private setWander(g: GuestSim, steps: number) {
    g.goal = 'wander';
    g.goalKey = '';
    g.goalRef = 0;
    g.wanderSteps = steps;
  }

  private setGoal(g: GuestSim, goal: GuestSim['goal'], key: string, ref: number) {
    g.goal = goal;
    g.goalKey = key;
    g.goalRef = ref;
    g.phase = 0;
  }

  // ================================================================ thinking
  private addThought(g: GuestSim, text: string) {
    if (g.thoughts[g.thoughts.length - 1] === text) return;
    g.thoughts.push(text);
    if (g.thoughts.length > 5) g.thoughts.shift();
  }

  private leave(g: GuestSim, thought: string) {
    if (g.goal === 'leave') return;
    this.addThought(g, thought);
    if (g.seatObj) g.seatObj = 0;
    g.hidden = false;
    this.setGoal(g, 'leave', 'exit', 0);
  }

  private think(g: GuestSim) {
    const sim = this.sim;
    const rng = sim.rng;
    const n = g.needs;
    const tile = g.tile;
    g.think = 6;
    // ---------------------------------------------------------- going home
    const closing = !sim.isOpen() || sim.minuteOfDay >= (CLOSE_HOUR - 0.5) * 60;
    if (closing) return this.leave(g, 'The zoo is closing — time to go home.');
    // stagger departures through the late afternoon
    if (sim.minuteOfDay >= (CLOSE_HOUR - 2) * 60 && hash01(g.seed, sim.day) < (sim.minuteOfDay - (CLOSE_HOUR - 2) * 60) / 90)
      return this.leave(g, 'It’s getting late, let’s head home.');
    if (g.visitLeft <= 0) return this.leave(g, g.happiness > 0.6 ? 'What a lovely day at the zoo!' : 'Time to go home.');
    if (n.energy < 0.12) return this.leave(g, 'I’m exhausted. Time to go home.');
    if (g.happiness < 0.22) return this.leave(g, 'This zoo is awful. I’m leaving!');
    if (g.money < 2 && n.hunger < 0.3) return this.leave(g, 'I’ve run out of money and I’m starving.');

    // ---------------------------------------------------------- needs
    if (n.bladder < 0.3) {
      if (this.distance('restroom', tile) !== FAR) return this.setGoal(g, 'restroom', 'restroom', 0);
      sim.progress.complaints.restroom++;
      g.mood -= 0.08;
      this.addThought(g, 'I really need a restroom!');
      if (n.bladder < 0.08) return this.leave(g, 'There are no restrooms here. I’m going home!');
    }
    if (n.hunger < 0.35 && g.holding !== 'food') {
      if (this.wantShop(g, 'food') || this.wantShop(g, 'icecream')) return;
      sim.progress.complaints.food++;
      g.mood -= 0.05;
      this.addThought(g, g.money < 4 ? 'I’m hungry, but I can’t afford anything.' : 'I’m hungry but there’s nowhere to eat!');
    }
    if (n.thirst < 0.35 && g.holding !== 'drink') {
      if (this.wantShop(g, 'drink') || this.wantShop(g, 'icecream')) return;
      sim.progress.complaints.drink++;
      g.mood -= 0.05;
      this.addThought(g, 'I’m so thirsty. Where can I get a drink?');
    }
    if (n.energy < 0.35 || (g.holding === 'food' && rng.chance(0.35))) {
      const d = this.distance('bench', tile);
      if (d !== FAR && d < 30 && this.freeSeatExists()) return this.setGoal(g, 'sit', 'bench', 0);
      if (n.energy < 0.35) {
        sim.progress.complaints.bench++;
        this.addThought(g, 'My feet hurt. I wish there were more benches.');
      }
    }
    // ---------------------------------------------------------- treats
    if (!g.donated && g.happiness > 0.68 && g.money > 4 && g.viewed.length >= 2 && rng.chance(0.15) && this.distance('donation', tile) < 40)
      return this.setGoal(g, 'donate', 'donation', 0);
    if ((g.holding === 'none' || g.holding === 'food') && g.money >= 15 && g.happiness > 0.62 && g.seenSpecies.length >= 2 && rng.chance(0.1)) {
      if (this.wantShop(g, 'gift')) return;
    }
    const hour = sim.minuteOfDay / 60;
    if (g.holding === 'none' && g.money >= 4 && hour > 11 && hour < 17 && rng.chance(0.08)) {
      if (this.wantShop(g, 'icecream')) return;
    }
    // ---------------------------------------------------------- animals
    if (this.chooseHabitat(g)) return;
    let any = false;
    for (const a of sim.animals.values())
      if (!a.escaped) {
        any = true;
        break;
      }
    if (!any) {
      sim.progress.complaints.noAnimals++;
      this.addThought(g, 'There are no animals to see!');
      g.visitLeft -= 25;
      g.mood -= 0.04;
    } else if (g.viewed.length) {
      g.visitLeft -= 8; // seen everything: a few more strolls, then home
    }
    this.setWander(g, rng.int(5, 12));
  }

  private wantShop(g: GuestSim, kind: ShopKind): boolean {
    const price = this.cheapestPrice(kind);
    if (price === null || g.money < price) return false;
    const key = `shop:${kind}`;
    const d = this.distance(key, g.tile);
    if (d === FAR || d > 45) return false;
    this.setGoal(g, 'shop', key, SHOP_KINDS.indexOf(kind));
    return true;
  }

  private cheapestPrice(kind: ShopKind): number | null {
    let best: number | null = null;
    for (const o of this.sim.world.objects.values()) {
      const s = OBJECTS_BY_ID[o.defId]?.shop;
      if (s && s.kind === kind && (best === null || s.price < best)) best = s.price;
    }
    return best;
  }

  private freeSeatExists(): boolean {
    let seats = 0;
    for (const o of this.sim.world.objects.values()) {
      const d = OBJECTS_BY_ID[o.defId];
      if (d?.bench) seats += o.defId === 'picnic_table' ? 4 : 2;
    }
    let used = 0;
    for (const g of this.sim.guests.values()) if (g.seatObj) used++;
    return used < seats;
  }

  private chooseHabitat(g: GuestSim): boolean {
    const sim = this.sim;
    let best = 0,
      bestScore = 0;
    for (const hab of sim.world.habitats.values()) {
      if (!hab.viewTiles.length) continue;
      const pop = sim.population(hab.id);
      if (!pop.count.size) continue;
      let appeal = 0;
      let unseen = false;
      for (const sid of pop.count.keys()) {
        appeal = Math.max(appeal, SPECIES_BY_ID[sid]?.appeal ?? 5);
        if (!g.seenSpecies.includes(sid)) unseen = true;
      }
      const viewed = g.viewed.includes(hab.id);
      const d = this.distance(`hab:${hab.id}`, g.tile);
      if (d === FAR) continue;
      const score = (appeal * (viewed ? 0.12 : unseen ? 1 : 0.4) * (0.6 + 0.8 * sim.rng.float())) / (1 + d / 25);
      if (score > bestScore) {
        bestScore = score;
        best = hab.id;
      }
    }
    if (!best || bestScore < 0.25) return false;
    this.setGoal(g, 'view', `hab:${best}`, best);
    return true;
  }

  // ================================================================ arrival
  /** Find an object next to the current tile matching a predicate (no fence between). */
  private adjacentObject(tile: number, pred: (defId: string, id: number) => boolean): number {
    const w = this.sim.world;
    const x = tile % MAP_W,
      z = (tile / MAP_W) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX[k],
        nz = z + DZ[k];
      if (!w.inBounds(nx, nz)) continue;
      const oid = w.objectGrid[nz * MAP_W + nx];
      if (!oid) continue;
      const o = w.objects.get(oid);
      if (!o || w.fenceBetween(x, z, nx, nz)) continue;
      if (pred(o.defId, oid)) return oid;
    }
    return 0;
  }

  private arrive(g: GuestSim) {
    const sim = this.sim;
    const w = sim.world;
    const rng = sim.rng;
    const cx = ((g.tile % MAP_W) + 0.5) * TILE,
      cz = (((g.tile / MAP_W) | 0) + 0.5) * TILE;
    const faceObj = (oid: number, reach: number) => {
      const o = w.objects.get(oid)!;
      const c = w.objectCenter(o);
      const dx = c.x - cx,
        dz = c.z - cz;
      const d = Math.hypot(dx, dz) || 1;
      // stand at the edge of our tile facing the object, with a little jitter so people queue side by side
      const side = rng.range(-0.45, 0.45);
      g.ax = cx + (dx / d) * reach - (dz / d) * side;
      g.az = cz + (dz / d) * reach + (dx / d) * side;
      g.faceHeading = Math.atan2(dx, dz);
    };
    switch (g.goal) {
      case 'leave':
        g.phase = 3;
        g.hidden = false;
        return;
      case 'view': {
        const hab = w.habitats.get(g.goalRef);
        if (!hab) break;
        // first arrival at the nearest viewing tile: stroll along the fence to a better spot
        if (g.goalKey.charCodeAt(0) !== 116 /* 't' */) {
          const best = this.pickViewTile(g, hab.id, hab.viewTiles);
          if (best >= 0 && best !== g.tile) {
            g.goalKey = `t:${best}`;
            g.phase = 0;
            g.next = -1;
            return;
          }
        }
        const x = g.tile % MAP_W,
          z = (g.tile / MAP_W) | 0;
        for (let k = 0; k < 4; k++) {
          for (let s = 1; s <= 2; s++) {
            const nx = x + DX[k] * s,
              nz = z + DZ[k] * s;
            if (!w.inBounds(nx, nz) || w.habitatOf[nz * MAP_W + nx] !== hab.id) continue;
            const side = rng.range(-0.6, 0.6);
            g.ax = cx + DX[k] * 0.55 - DZ[k] * side;
            g.az = cz + DZ[k] * 0.55 + DX[k] * side;
            g.faceHeading = Math.atan2(DX[k], DZ[k]);
            g.phase = 1;
            return;
          }
        }
        break;
      }
      case 'shop': {
        const kind = SHOP_KINDS[g.goalRef] ?? 'food';
        const oid = this.adjacentObject(g.tile, (id) => OBJECTS_BY_ID[id]?.shop?.kind === kind);
        if (!oid) break;
        g.goalRef = oid;
        faceObj(oid, 0.6);
        g.phase = 1;
        return;
      }
      case 'restroom': {
        const oid = this.adjacentObject(g.tile, (id) => !!OBJECTS_BY_ID[id]?.restroom);
        if (!oid) break;
        g.goalRef = oid;
        faceObj(oid, 0.75);
        g.phase = 1;
        return;
      }
      case 'donate': {
        const oid = this.adjacentObject(g.tile, (id) => id === 'donation_box');
        if (!oid) break;
        g.goalRef = oid;
        faceObj(oid, 0.55);
        g.phase = 1;
        return;
      }
      case 'sit': {
        const seat = this.findSeat(g.tile);
        if (!seat) break;
        g.seatObj = seat.obj;
        g.seatIdx = seat.idx;
        g.ax = seat.x;
        g.az = seat.z;
        g.faceHeading = seat.heading;
        g.goalRef = seat.obj;
        g.phase = 1;
        return;
      }
    }
    // goal vanished (object removed etc.)
    this.think(g);
  }

  private viewCrowd = new Map<number, number>();
  private viewSeen = new Set<number>();
  private viewQueue: number[] = [];

  /**
   * Choose a viewing tile reachable along the habitat's viewing tiles (within
   * a short stroll) that is close to the animals and not crowded.
   */
  private pickViewTile(g: GuestSim, habId: number, viewTiles: number[]): number {
    const sim = this.sim;
    const crowd = this.viewCrowd;
    crowd.clear();
    for (const o of sim.guests.values()) {
      if (o === g || o.goal !== 'view' || o.goalRef !== habId) continue;
      const t = o.phase === 0 && o.goalKey.charCodeAt(0) === 116 ? Number(o.goalKey.slice(2)) : o.phase !== 0 ? o.tile : -1;
      if (t >= 0) crowd.set(t, (crowd.get(t) ?? 0) + 1);
    }
    // BFS over this habitat's viewing tiles (and the path tiles between them), max ~14 steps
    const seen = this.viewSeen;
    seen.clear();
    const q = this.viewQueue;
    q.length = 0;
    q.push(g.tile);
    seen.add(g.tile);
    const adj = sim.nav.adj;
    let best = g.tile,
      bestScore = -Infinity;
    for (let head = 0; head < q.length && head < 220; head++) {
      const t = q[head];
      const isView = viewTiles.includes(t);
      if (isView) {
        const cx = ((t % MAP_W) + 0.5) * TILE,
          cz = (((t / MAP_W) | 0) + 0.5) * TILE;
        let near = Infinity;
        for (const a of sim.animals.values()) {
          if (a.escaped || a.habitatId !== habId) continue;
          const d = Math.hypot(a.x - cx, a.z - cz);
          if (d < near) near = d;
        }
        const walk = Math.hypot(cx - g.x, cz - g.z);
        const score = -Math.min(near, 60) * 0.12 - (crowd.get(t) ?? 0) * 1.4 - walk * 0.03 + sim.rng.float() * 1.2;
        if (score > bestScore) {
          bestScore = score;
          best = t;
        }
      }
      if (!isView && head > 0) continue; // only stroll along the viewing tiles
      const m = adj[t];
      for (let k = 0; k < 4; k++) {
        if (!(m & (1 << k))) continue;
        const n = t + DX[k] + DZ[k] * MAP_W;
        if (seen.has(n)) continue;
        seen.add(n);
        q.push(n);
      }
    }
    return best;
  }

  private seatPos(o: PlacedObject, idx: number, out: { x: number; z: number; heading: number }) {
    const c = this.sim.world.objectCenter(o);
    const th = (o.rot * Math.PI) / 2;
    const rx = Math.cos(th),
      rz = -Math.sin(th); // local +X
    const fx = Math.sin(th),
      fz = Math.cos(th); // local +Z (front)
    if (o.defId === 'picnic_table') {
      const lx = idx % 2 ? 0.4 : -0.4;
      const lz = idx < 2 ? -0.62 : 0.62;
      out.x = c.x + rx * lx + fx * lz;
      out.z = c.z + rz * lx + fz * lz;
      out.heading = idx < 2 ? th : th + Math.PI;
    } else {
      const lx = idx ? 0.42 : -0.42;
      out.x = c.x + rx * lx + fx * 0.05;
      out.z = c.z + rz * lx + fz * 0.05;
      out.heading = th;
    }
  }

  private findSeat(tile: number): { obj: number; idx: number; x: number; z: number; heading: number } | null {
    const sim = this.sim;
    const used = new Set<number>();
    const oid = this.adjacentObject(tile, (id, objId) => {
      if (!OBJECTS_BY_ID[id]?.bench) return false;
      const seats = id === 'picnic_table' ? 4 : 2;
      used.clear();
      for (const g of sim.guests.values()) if (g.seatObj === objId) used.add(g.seatIdx);
      return used.size < seats;
    });
    if (!oid) return null;
    const o = sim.world.objects.get(oid)!;
    const seats = o.defId === 'picnic_table' ? 4 : 2;
    used.clear();
    for (const g of sim.guests.values()) if (g.seatObj === oid) used.add(g.seatIdx);
    for (let i = 0; i < seats; i++) {
      if (used.has(i)) continue;
      const p = { x: 0, z: 0, heading: 0 };
      this.seatPos(o, i, p);
      return { obj: oid, idx: i, x: p.x, z: p.z, heading: p.heading };
    }
    return null;
  }

  /** Reached the spot for the goal's action (phase 1 → 2). */
  private beginAction(g: GuestSim) {
    const sim = this.sim;
    const rng = sim.rng;
    g.phase = 2;
    switch (g.goal) {
      case 'enter':
        g.phase = 0;
        g.next = -1;
        this.think(g);
        return;
      case 'view':
        this.startWatch(g);
        return;
      case 'shop':
        g.action = 'shop';
        g.timer = rng.range(2, 3.5);
        return;
      case 'restroom':
        g.action = 'restroom';
        g.hidden = true;
        g.timer = RESTROOM_TIME + rng.range(-1.5, 2);
        return;
      case 'donate':
        g.action = 'idle';
        g.timer = rng.range(1.5, 2.5);
        return;
      case 'sit':
        g.action = 'sit';
        g.timer = rng.range(10, 22);
        return;
      default:
        g.phase = 0;
        this.think(g);
    }
  }

  private startWatch(g: GuestSim) {
    const sim = this.sim;
    const rng = sim.rng;
    const hab = sim.world.habitats.get(g.goalRef);
    g.action = 'watch';
    g.timer = rng.range(6, 12);
    g.funRate = 0;
    if (!hab) return;
    let count = 0,
      happy = 0,
      appeal = 0,
      near = 0,
      baby = false;
    let star = '';
    for (const a of sim.animals.values()) {
      if (a.escaped || a.habitatId !== hab.id) continue;
      count++;
      happy += a.happiness;
      const ap = SPECIES_BY_ID[a.speciesId]?.appeal ?? 5;
      if (ap > appeal) {
        appeal = ap;
        star = a.speciesId;
      }
      if (a.growth < 0.7) baby = true;
      const d2 = (a.x - g.x) ** 2 + (a.z - g.z) ** 2;
      if (d2 < 35 * 35) near++;
    }
    if (!count) {
      this.addThought(g, 'I can’t see any animals here.');
      g.mood -= 0.06;
      g.timer = 3;
      return;
    }
    // fence the guest looks through
    const x = g.tile % MAP_W,
      z = (g.tile / MAP_W) | 0;
    const fx = Math.round(Math.sin(g.faceHeading)),
      fz = Math.round(Math.cos(g.faceHeading));
    let vis = 1;
    for (let s = 0; s < 2; s++) {
      const ax = x + fx * s,
        az = z + fz * s;
      const f = sim.world.fenceBetween(ax, az, ax + fx, az + fz);
      if (f) {
        vis = FENCES_BY_ID[f]?.visibility ?? 1;
        break;
      }
    }
    const avgHappy = happy / count;
    const info = sim.infoNear[g.tile] === 1;
    const unseen = !g.seenSpecies.includes(star);
    const seeFactor = near > 0 ? 1 : 0.35;
    const quality = (appeal / 10) * (0.45 + 0.55 * avgHappy) * (0.35 + 0.65 * vis) * (info ? 1.25 : 1) * (unseen ? 1 : 0.55) * seeFactor;
    g.funRate = 0.09 * quality;
    g.mood += 0.05 * quality;
    const plural = pluralName(star);
    if (near === 0) this.addThought(g, `The ${plural} are too far away to see properly.`);
    else if (vis < 0.4) this.addThought(g, `I can barely see the ${plural} behind that wall.`);
    else if (avgHappy < 0.4) {
      this.addThought(g, `The ${plural} look miserable.`);
      g.mood -= 0.05;
    } else if (sim.habitatDirt(hab.id) > 0.6) this.addThought(g, 'That enclosure is filthy!');
    else if (baby && rng.chance(0.6)) this.addThought(g, `Aww, a baby ${singularName(star)}!`);
    else if (appeal >= 8 && quality > 0.45) this.addThought(g, `Wow, the ${plural} are amazing!`);
    else if (info && rng.chance(0.5)) this.addThought(g, `I learned something new about ${plural}.`);
    else this.addThought(g, `I like the ${plural}.`);
    for (const a of sim.animals.values()) {
      if (a.escaped || a.habitatId !== hab.id) continue;
      if (!g.seenSpecies.includes(a.speciesId)) g.seenSpecies.push(a.speciesId);
    }
    if (!g.viewed.includes(hab.id)) g.viewed.push(hab.id);
  }

  private finishAction(g: GuestSim) {
    const sim = this.sim;
    const rng = sim.rng;
    const w = sim.world;
    switch (g.goal) {
      case 'shop': {
        if (g.action === 'shop') {
          const o = w.objects.get(g.goalRef);
          const s = o ? OBJECTS_BY_ID[o.defId]?.shop : undefined;
          if (o && s && g.money >= s.price) {
            g.money -= s.price;
            const c = w.objectCenter(o);
            sim.earn('shopIncome', s.price - s.stockCost, { x: c.x, z: c.z });
            if (s.kind === 'food') {
              g.holding = 'food';
              g.holdTime = rng.range(25, 40);
            } else if (s.kind === 'drink') {
              g.holding = 'drink';
              g.holdTime = rng.range(20, 30);
            } else if (s.kind === 'icecream') {
              g.holding = 'icecream';
              g.holdTime = rng.range(15, 25);
              this.addThought(g, 'This ice cream is delicious!');
            } else {
              g.holding = g.appearance.child || rng.chance(0.4) ? 'balloon' : 'gift';
              g.holdTime = 0;
              g.needs.fun = Math.min(1, g.needs.fun + 0.15);
              this.addThought(g, g.holding === 'balloon' ? 'I love my new balloon!' : 'I bought a lovely souvenir.');
            }
            if (s.kind === 'food' || s.kind === 'drink') {
              // stand and take the first bites / sips
              g.action = s.kind === 'food' ? 'eat' : 'drink';
              g.timer = rng.range(3, 5);
              g.goalRef = 0;
              return;
            }
          } else this.addThought(g, 'I can’t afford that.');
        }
        break;
      }
      case 'restroom':
        g.hidden = false;
        g.needs.bladder = 1;
        break;
      case 'donate': {
        const o = w.objects.get(g.goalRef);
        g.donated = true;
        if (o) {
          const amount = Math.max(1, Math.min(g.money, Math.round(1 + rng.float() * 5 * g.happiness)));
          g.money -= amount;
          const c = w.objectCenter(o);
          sim.earn('donations', amount, { x: c.x, z: c.z });
          this.addThought(g, 'I donated to help the animals.');
        }
        break;
      }
      case 'sit':
        g.seatObj = 0;
        // step back onto our path tile
        g.ax = ((g.tile % MAP_W) + 0.5) * TILE;
        g.az = (((g.tile / MAP_W) | 0) + 0.5) * TILE;
        g.goal = 'enter';
        g.phase = 1;
        return;
      case 'view':
        g.funRate = 0;
        break;
    }
    g.phase = 0;
    g.next = -1;
    this.think(g);
  }

  // ================================================================ surroundings
  private look(g: GuestSim) {
    const sim = this.sim;
    const t = g.tile;
    if (t < 0) return;
    const s = Math.min(1, sim.scenery[t] / 4);
    g.scenic += (s - g.scenic) * 0.35;
    // litter nearby
    let trash = 0;
    const x = t % MAP_W,
      z = (t / MAP_W) | 0;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx,
          nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= MAP_W || nz >= MAP_H) continue;
        const i = nz * MAP_W + nx;
        if (!sim.world.habitatOf[i]) trash += sim.litterGrid[i];
      }
    if (trash >= 4) {
      g.mood -= 0.03;
      sim.progress.complaints.litter++;
      if (sim.rng.chance(0.3)) this.addThought(g, 'There’s litter everywhere!');
    } else if (s > 0.7 && sim.rng.chance(0.05)) {
      g.mood += 0.03;
      this.addThought(g, 'What a beautiful zoo!');
    }
    // escaped animals
    for (const a of sim.animalSys.loose) {
      const d2 = (a.x - g.x) ** 2 + (a.z - g.z) ** 2;
      if (d2 > 12 * 12) continue;
      const sp = SPECIES_BY_ID[a.speciesId];
      g.mood -= sp && sp.danger >= 3 ? 0.25 : 0.1;
      this.addThought(g, `Help! There’s a ${singularName(a.speciesId)} on the loose!`);
      if (sp && sp.danger >= 3 && g.phase !== 3 && g.action !== 'restroom') {
        g.phase = 0;
        g.seatObj = 0;
        this.leave(g, 'I’m not staying here with a dangerous animal loose!');
      }
      break;
    }
  }
}
