// Guest AI. Visitors arrive in parties (alone, couples, families with
// children) through the gate, paying admission. The party leader decides where
// to go; companions and children follow it. Guests walk only on paths
// (following cached distance fields), view habitats, queue in orderly lines at
// shops and restrooms (see queues.ts), rest on benches, drop litter, donate and
// head home together.

import { CLOSE_HOUR, DEFAULT_ADMISSION, GAME_MINUTES_PER_SECOND, MAP_H, MAP_W, OPEN_HOUR, TILE } from '../core/constants';
import type { PlacedObject, ShopKind } from '../core/types';
import { FENCES_BY_ID } from '../data/fences';
import { OBJECTS_BY_ID } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import { personName, pluralName, randomGuestAppearance, singularName } from './names';
import { FAR, N_TILES } from './nav';
import { QP_INSIDE, QP_SERVE, QueueSystem, type ServiceKind, type ServicePoint } from './queues';
import { hash01 } from './rng';
import type { Simulation } from './simulation';
import type { GuestSim } from './state';
import { approach, personY, standFacing, turnTowards, walkToNext } from './walker';

const HALF_DX = [0, 1, -1, 0, 1];
const HALF_DZ = [0, 0, 1, 1, 1];
const DX = [1, -1, 0, 0];
const DZ = [0, 0, 1, -1];
/** From this minute of the day security shows the last visitors out (they hurry to the gate). */
const LATE_CLEAR = (CLOSE_HOUR + 1.5) * 60;
/** Average party size (arrival rates are in people, parties spawn as units). */
const AVG_PARTY = 2.25;
/**
 * People the ticket booths let in per game hour: a base plus a little per exhibit,
 * so a bigger zoo welcomes more visitors. People walk in real time while the clock
 * runs GAME_MINUTES_PER_SECOND game minutes per second (an hour is 20 s), so this
 * also caps how crowded the entrance avenue gets on a busy morning.
 */
const GATE_BASE = 14;
const GATE_PER_EXHIBIT = 2.5;
const GATE_MAX = 30;
/** Ticket price guests think is fair: a base plus this much per point of the zoo's attraction. */
const FAIR_BASE = 13.5;
const FAIR_PER_ATTRACTION = 0.25;
/** Share of guests who stop to look at an exhibit they pass on the way somewhere else. */
const GLANCE_CHANCE = 0.7;
/** People who fit along one tile of fence (2 m) side by side. */
const VIEWERS_PER_TILE = 4;
/** Body radii (m) for crowd spacing: adults' shoulders, children's. */
const ADULT_R = 0.26;
const CHILD_R = 0.2;
/** Longest look at an exhibit passed on the way to another (sim seconds, see arrive). */
const GLANCE_SECONDS = 9;
/** With more than this many tiles to go, guests walk briskly (this much faster than their stroll). */
const BRISK_AFTER = 12;
const BRISK = 1.2;
/** Visit time left (sim seconds, ≈ 6 game hours) at which a party weighs distance as usual (see chooseHabitat). */
const VISIT_AHEAD = 120;
/** Visit time (sim seconds, ≈ 1 game hour) a new plan leaves spare for a stop on the way. */
const PLAN_SLACK = 20;
/**
 * Relative arrival rate for each hour of the day: a morning rush after the gates
 * open, a lunchtime plateau, then fewer and fewer newcomers towards closing.
 */
const ARRIVALS_BY_HOUR = [0, 0, 0, 0, 0, 0, 0, 0, 0.8, 1.3, 1.4, 1.25, 1.05, 0.95, 0.8, 0.6, 0.42, 0.24, 0.08, 0, 0, 0, 0, 0];
/** Companion offsets [right, forward] while walking / standing / queueing (m, leader's frame). */
const FOLLOW_WALK = [-0.45, -0.62, 0.45, -0.62, 0, -1.2];
const FOLLOW_STAND = [0.56, -0.2, -0.56, -0.2, 0, -0.85];
const FOLLOW_BESIDE = [0.56, 0, -0.56, 0, 1.12, 0];

/** Options for GuestSystem.wantService. */
interface ServiceOpts {
  /** Farthest path distance (tiles) worth walking. */
  maxDist?: number;
  /** Skip lines longer than this. */
  maxLine?: number;
  /** A spur-of-the-moment buy: no thoughts or complaints when nothing suits. */
  impulse?: boolean;
  /** The need is not pressing: a shop far off the route to the planned exhibit can wait. */
  canWait?: boolean;
  /** A substitute kind of service (counts as a little farther). */
  alt?: ServiceKind;
}
type ServiceAnswer = 'ok' | 'later' | 'full' | 'far' | 'cutoff' | 'broke' | 'none';

/** Party-wide minimum of the basic needs (filled by partyNeeds). */
interface PartyNeeds {
  hunger: number;
  thirst: number;
  bladder: number;
  energy: number;
  kids: number;
}

export class GuestSystem {
  private fills = new Map<string, (out: number[]) => void>();
  private gateTmp: number[] = [];
  private toRemove: number[] = [];
  private released: GuestSim[] = [];
  /** Shops and restrooms with their queues. */
  readonly queues: QueueSystem;
  /** Guests allowed in the park right now (scales with zoo size). */
  capacity = 40;
  private capRev = -1;
  /** Ticket price (dollars) visitors think the zoo is worth (refreshed with the arrival rate). */
  fairPrice = DEFAULT_ADMISSION;
  /** Share of would-be visitors who pay at the current price (above 1 = a bargain draws extra). */
  priceFactor = 1;
  /** People per game hour who look at the price and walk away (from the last estimate). */
  private turnedAway = 0;
  private deterred = 0;
  private pn: PartyNeeds = { hunger: 1, thirst: 1, bladder: 1, energy: 1, kids: 0 };
  /** Diagnostics since the simulation was created (not saved). */
  readonly counters = { served: 0, items: 0, gaveUp: 0, full: 0, none: 0, restroom: 0 };

  constructor(private sim: Simulation) {
    this.queues = new QueueSystem(sim.world);
  }

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
    } else if (key.startsWith('open:')) {
      // an opened enclosure (keepers still service it): the paths beside its old footprint
      const id = Number(key.slice(5));
      f = (out) => {
        const enc = sim.enclosures.find(id);
        if (enc) sim.enclosures.serviceTiles(enc, out);
      };
    } else if (key.startsWith('t:')) {
      const t = Number(key.slice(2));
      f = (out) => out.push(t);
    } else if (key.startsWith('o:')) {
      // one shop / restroom: the path tile at the head of its line
      const id = Number(key.slice(2));
      f = (out) => {
        const p = this.queues.points.get(id);
        if (p && p.tile >= 0) out.push(p.tile);
      };
    } else {
      // object categories: bench, donation
      const match = (defId: string): boolean => {
        const d = OBJECTS_BY_ID[defId];
        if (!d) return false;
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

  /** Relative arrival rate at a minute of the day (smoothly interpolated between hours). */
  static arrivalCurve(minute: number): number {
    const h = minute / 60 - 0.5;
    const i = Math.floor(h);
    const f = h - i;
    const a = ARRIVALS_BY_HOUR[Math.max(0, Math.min(23, i))] ?? 0;
    const b = ARRIVALS_BY_HOUR[Math.max(0, Math.min(23, i + 1))] ?? 0;
    return a + (b - a) * f;
  }

  private appealTmp = new Map<string, number>();

  /** Draw of the animals on show (species appeal, herd sizes, how well they look). */
  private attraction(): number {
    const sim = this.sim;
    const appeal = this.appealTmp;
    appeal.clear();
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
    return Math.min(130, attraction);
  }

  /** Habitats with animals guests can see. */
  private exhibitCount(): number {
    let n = 0;
    for (const hab of this.sim.world.habitats.values()) if (hab.viewTiles.length && this.sim.population(hab.id).count.size) n++;
    return n;
  }

  /**
   * Expected paying arrivals (people) per game hour right now. Also refreshes
   * `fairPrice`, `priceFactor` and how many walk away because of the price.
   */
  arrivalRate(): number {
    const sim = this.sim;
    const attraction = this.attraction();
    // more and better exhibits, and a good reputation, make a dearer ticket acceptable
    this.fairPrice = FAIR_BASE + FAIR_PER_ATTRACTION * attraction * (0.6 + (0.6 * sim.rating) / 100);
    const r = sim.admissionPrice / this.fairPrice;
    // a bargain draws a few more people; above the fair price fewer and fewer will pay
    this.priceFactor = r <= 1 ? 1 + 0.3 * (1 - r) : Math.max(0.03, 1 - 1.4 * (r - 1));
    // word of mouth saturates: a huge zoo is not proportionally busier than a big one
    const draw = 2 + (attraction * 0.7) / (1 + attraction / 60);
    const demand = draw * (0.35 + (sim.rating / 100) * 1.1);
    const curve = GuestSystem.arrivalCurve(sim.minuteOfDay);
    const gate = Math.min(GATE_MAX, GATE_BASE + GATE_PER_EXHIBIT * this.exhibitCount()) * Math.min(1, curve * 1.6);
    // the booths cap how many reach the till; the price decides how many of those pay
    const atGate = Math.min(demand * curve * Math.max(1, this.priceFactor), gate);
    const paying = Math.min(1, this.priceFactor);
    this.turnedAway = atGate * (1 - paying);
    return atGate * paying;
  }

  private trySpawn(hours: number) {
    const sim = this.sim;
    if (!sim.isOpen() || sim.minuteOfDay >= (CLOSE_HOUR - 1) * 60) {
      sim.spawnAcc = 0;
      return;
    }
    this.updateCapacity();
    const rate = this.arrivalRate();
    sim.spawnAcc += (rate * hours) / AVG_PARTY;
    // visitors who looked at the ticket price and walked away
    if (this.priceFactor < 0.85) {
      this.deterred += this.turnedAway * hours;
      if (this.deterred >= 1) {
        sim.progress.complaints.price += Math.floor(this.deterred);
        this.deterred -= Math.floor(this.deterred);
      }
    }
    while (sim.spawnAcc >= 1) {
      sim.spawnAcc -= 1;
      if (sim.guests.size + 4 > this.capacity) {
        sim.spawnAcc = Math.min(sim.spawnAcc, 1);
        break;
      }
      this.spawnParty();
    }
  }

  /** A party of 1–4 arrives at the gate: singles, couples, friends, families. */
  spawnParty(): GuestSim | null {
    const rng = this.sim.rng;
    const r = rng.float();
    let adults = 1,
      kids = 0;
    if (r < 0.3) adults = 1;
    else if (r < 0.48) adults = 2;
    else if (r < 0.62) kids = 1;
    else if (r < 0.78) {
      adults = 2;
      kids = 1;
    } else if (r < 0.9) {
      adults = 2;
      kids = 2;
    } else kids = 2;
    const lead = this.spawn(false, null, 0);
    if (!lead) return null;
    for (let i = 1; i < adults + kids; i++) {
      const g = this.spawn(i >= adults, lead, i);
      if (!g) break;
      lead.party.push(g.id);
      // the party walks at the pace of its slowest member
      lead.walkSpeed = Math.min(lead.walkSpeed, g.walkSpeed * 1.04);
    }
    return lead;
  }

  /** Create one guest at the gate (a party leader, or a companion of `lead`). */
  spawn(child = false, lead: GuestSim | null = null, slot = 0): GuestSim | null {
    const sim = this.sim;
    const rng = sim.rng;
    const gates = sim.gateTiles(this.gateTmp);
    if (!gates.length) return null;
    const tile = lead ? lead.tile : gates[rng.int(0, gates.length - 1)];
    const appearance = randomGuestAppearance(rng, child);
    if (lead && (child || rng.chance(0.4))) {
      // family resemblance
      appearance.skin = lead.appearance.skin;
      if (rng.chance(0.55)) appearance.hair = lead.appearance.hair;
    }
    const budget = child ? rng.range(0, 8) : rng.range(18, 80);
    const tx = tile % MAP_W;
    const x = lead ? lead.x + (slot % 2 ? 0.5 : -0.5) : (tx + 0.5) * TILE + rng.range(-0.6, 0.6);
    const z = lead ? lead.z + 0.55 * Math.ceil(slot / 2) : MAP_H * TILE - 0.25;
    const id = sim.nextIds.guest++;
    // A visit lasts 8–12 game hours: people walk in real time while the clock runs
    // GAME_MINUTES_PER_SECOND game minutes per second, so crossing the zoo takes a few
    // game hours. Everyone wants to be out a little before closing, so most stay until
    // late afternoon, late arrivals make it a shorter visit, and the zoo empties
    // through the evening.
    const stay = (rng.range(8, 12) * 60) / GAME_MINUTES_PER_SECOND;
    const untilDeadline = ((CLOSE_HOUR - rng.range(0.2, 0.9)) * 60 - sim.minuteOfDay) / GAME_MINUTES_PER_SECOND;
    // the ticket against what the zoo seems worth: a bargain cheers, overpaying sours the visit
    const value = sim.admissionPrice / Math.max(1, this.fairPrice);
    const ticketValue = lead ? lead.ticketValue : value <= 0.8 ? 0.04 : value > 1.05 ? -Math.min(0.3, 0.5 * (value - 1)) : 0;
    const g: GuestSim = {
      id,
      name: personName(rng, appearance.female),
      appearance,
      x,
      y: personY(sim.world, x, Math.min(z, MAP_H * TILE - 0.01)),
      z,
      heading: Math.PI,
      speed: 0,
      action: 'walk',
      actionTime: 0,
      needs: {
        hunger: rng.range(0.5, 1),
        thirst: rng.range(0.5, 1),
        bladder: rng.range(0.6, 1),
        energy: rng.range(0.8, 1),
        fun: rng.range(0.3, 0.5),
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
      walkSpeed: child ? rng.range(1.12, 1.38) : Math.max(0.95, Math.min(1.55, 1.27 + rng.gauss() * 0.12)),
      phase: lead ? 4 : 1,
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
      visitLeft: Math.max(25, Math.min(stay, untilDeadline)),
      think: 0,
      mood: 0,
      funRate: 0,
      seatObj: 0,
      seatIdx: 0,
      lookTimer: rng.range(1, 3),
      donated: false,
      viewed: [],
      plan: 0,
      ticketValue,
      scenic: 0.3,
      qObj: 0,
      qPos: -1,
      qWait: 0,
      leader: lead ? lead.id : 0,
      party: [],
      fstate: 0,
      avoidObj: 0,
      avoidUntil: 0,
    };
    if (!lead) {
      // walk in from the gate to its tile centre
      g.ax = (tx + 0.5) * TILE + rng.range(-0.5, 0.5);
      g.az = ((tile / MAP_W) | 0) * TILE + TILE * 0.5;
    }
    if (!lead) {
      if (ticketValue < -0.04) g.thoughts.push('The tickets here are expensive.');
      else if (ticketValue > 0) g.thoughts.push('The tickets are a real bargain!');
    }
    sim.guests.set(id, g);
    const fee = child ? Math.round(sim.admissionPrice * 0.5) : sim.admissionPrice;
    if (fee > 0) sim.earn('admissions', fee, lead ? undefined : { x: g.ax, z: z - 1 });
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
    this.syncQueues();
    // late in the evening security walks the stragglers to the gate; anyone
    // still inside after midnight is taken out of the park
    const m = sim.minuteOfDay;
    const gone = m < OPEN_HOUR * 60 - 60;
    const escort = m >= LATE_CLEAR;
    for (const g of sim.guests.values()) {
      if (gone && g.phase !== 3) {
        this.toRemove.push(g.id);
        continue;
      }
      if (escort && !g.leader && g.goal !== 'leave' && g.phase !== 3) this.sendHome(g, 'Security is showing the last visitors out.');
      this.updateGuest(g, dt);
    }
    this.queues.advance();
    // crowd separation at ~30 Hz is plenty (people move a few cm per step)
    sim.crowdAcc += dt;
    if (sim.crowdAcc >= 1 / 30) {
      sim.crowdAcc = 0;
      this.separate();
    }
    if (this.toRemove.length) {
      for (const id of this.toRemove) this.removeGuest(id);
      this.toRemove.length = 0;
    }
  }

  private removeGuest(id: number) {
    const sim = this.sim;
    const g = sim.guests.get(id);
    if (!g) return;
    if (g.qObj) this.queues.leave(g);
    sim.satisfaction += (g.happiness - sim.satisfaction) * 0.05;
    g.seatObj = 0;
    sim.guests.delete(id);
    // companions of a leader that vanished carry on alone; a companion leaving drops out of the party
    if (g.leader) {
      const l = sim.guests.get(g.leader);
      if (l) {
        const i = l.party.indexOf(id);
        if (i >= 0) l.party.splice(i, 1);
      }
    }
    for (const fid of g.party) {
      const f = sim.guests.get(fid);
      if (!f || f.phase === 3) continue;
      f.leader = 0;
      f.fstate = 0;
      f.seatObj = 0;
      this.resumeWalking(f);
    }
    sim.events.emit('guestRemoved', { id });
  }

  /** Queue geometry follows world edits; guests whose place vanished pick something else. */
  private syncQueues() {
    const rel = this.released;
    this.queues.sync(rel);
    if (!rel.length) return;
    for (const g of rel) this.afterRelease(g);
    rel.length = 0;
  }

  /** Re-attach queues and parties after a save was loaded. */
  afterLoad() {
    const sim = this.sim;
    this.queues.reset();
    this.capRev = -1;
    this.habCrowdTime = -1;
    this.glanceRev = -1;
    this.habExitRev = -1;
    const rel = this.released;
    this.queues.sync(rel);
    this.queues.rebuildFrom(sim.guests.values(), rel);
    for (const g of rel) this.afterRelease(g);
    rel.length = 0;
    for (const g of sim.guests.values()) {
      if (g.leader && !sim.guests.has(g.leader)) {
        g.leader = 0;
        this.resumeWalking(g);
      }
      if (g.party.length) g.party = g.party.filter((id) => sim.guests.has(id));
    }
  }

  /** The shop / restroom / bench `objId` is being removed: everyone using it changes plans. */
  releaseObject(objId: number) {
    const sim = this.sim;
    this.syncQueues();
    const p = this.queues.points.get(objId);
    for (const g of sim.guests.values()) {
      if (g.qObj === objId) {
        const atBuilding = g.qPos >= QP_SERVE;
        this.queues.leave(g);
        if (atBuilding && p) {
          if (g.hidden) {
            // was inside: comes out of the door
            const d = g.id % p.sx.length;
            g.x = p.sx[d];
            g.z = p.sz[d];
          }
          g.hidden = false;
          this.exitTo(g, p);
        } else this.afterRelease(g);
      } else if (g.seatObj === objId) {
        g.seatObj = 0;
        if (g.leader) g.fstate = 0;
        else this.resumeWalking(g);
      } else if (!g.leader && g.goalRef === objId && g.goal !== 'view') this.resumeWalking(g);
    }
  }

  private afterRelease(g: GuestSim) {
    g.qObj = 0;
    g.qPos = -1;
    if (g.hidden) g.hidden = false;
    if (!g.leader) this.resumeWalking(g);
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
          // shoulder to shoulder at most; members of one party walk a little closer
          const family = a.leader === b.id || b.leader === a.id || (a.leader !== 0 && a.leader === b.leader);
          const walking = a.speed > 0.25 || b.speed > 0.25;
          const min = ((a.appearance.child ? CHILD_R : ADULT_R) + (b.appearance.child ? CHILD_R : ADULT_R)) * (family && walking ? 0.85 : 1);
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
          const push = (min - d) * 0.7;
          // people in a queue / at a counter / at a fence hold their place more
          const wa = this.weight(a),
            wb = this.weight(b);
          const sum = wa + wb;
          this.push(a, (-ux * push * (2 * wa)) / sum, (-uz * push * (2 * wa)) / sum, w);
          this.push(b, (ux * push * (2 * wb)) / sum, (uz * push * (2 * wb)) / sum, w);
        }
      }
    }
  }

  private weight(g: GuestSim): number {
    if (g.qObj && g.qPos >= 0) return g.qPos >= QP_SERVE ? 0.1 : 0.18;
    if (g.phase === 2) return 0.35;
    return g.phase === 4 ? 0.75 : 0.65;
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
    if (g.phase === 1 && !g.qObj && !g.leader) {
      // keep the approach target consistent so we don't walk straight back into the crowd
      if (okX) g.ax += dx * 0.5;
      if (okZ) g.az += dz * 0.5;
    }
  }

  // ================================================================ per guest
  private updateGuest(g: GuestSim, dt: number) {
    const sim = this.sim;
    const n = g.needs;
    const sitting = g.action === 'sit';
    // Needs, per simulated second (one game hour = 20 s); everyone's body clock differs a
    // little. Tuned so a typical visit has one meal, a drink or two and a restroom break
    // or two, with long enough between them to walk across the zoo.
    const k = 0.8 + 0.45 * hash01(g.seed, 11);
    n.hunger = Math.max(0, n.hunger - (dt * k) / 215);
    n.thirst = Math.max(0, n.thirst - (dt * (1.85 - k)) / 165);
    n.bladder = Math.max(0, n.bladder - (dt * (0.6 + 0.8 * hash01(g.seed, 13))) / 230);
    if (sitting) n.energy = Math.min(1, n.energy + dt * 0.05);
    else if (g.speed > 0.2) n.energy = Math.max(0, n.energy - dt / (g.appearance.child ? 300 : 280));
    else n.energy = Math.max(0, n.energy - dt / 600);
    if (g.action === 'watch') n.fun = Math.min(1, n.fun + g.funRate * dt);
    else n.fun = Math.max(0, n.fun - dt / 220);
    this.consume(g, dt);
    g.mood *= 1 - Math.min(1, 0.03 * dt);
    const basic = Math.min(n.hunger, n.thirst, n.bladder);
    const comfort = basic < 0.25 ? basic * 2 : 0.5 + basic * 0.5;
    const target = Math.max(0, Math.min(1, 0.24 + 0.4 * n.fun + 0.1 * n.energy + 0.14 * comfort + 0.12 * g.scenic + g.mood + g.ticketValue));
    g.happiness += (target - g.happiness) * Math.min(1, dt * 0.06);
    g.visitLeft -= dt;
    g.lookTimer -= dt;
    if (g.lookTimer <= 0) {
      g.lookTimer = 2.5;
      this.look(g);
    }
    const prevAction = g.action;
    if (g.phase === 4) this.followStep(g, dt);
    else if (g.qObj && g.qPos >= 0) this.queueStep(g, dt);
    else
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
          g.hidden = false;
          g.speed = g.walkSpeed * (sim.minuteOfDay >= LATE_CLEAR ? 1.4 : 1);
          g.z += g.speed * dt;
          turnTowards(g, 0, dt);
          g.y = personY(sim.world, g.x, Math.min(g.z, MAP_H * TILE - 0.01));
          if (g.z > MAP_H * TILE + 0.6) {
            this.toRemove.push(g.id);
            // the party steps out through the gate together
            for (const id of g.party) if (sim.guests.get(id)?.phase === 3) this.toRemove.push(id);
          }
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

  // ================================================================ companions
  /** Children and companions stay with their leader, on the path. */
  private followStep(g: GuestSim, dt: number) {
    const sim = this.sim;
    const L = sim.guests.get(g.leader);
    if (!L) {
      g.leader = 0;
      this.resumeWalking(g);
      return;
    }
    if (L.phase === 3) {
      g.phase = 3;
      g.fstate = 0;
      g.seatObj = 0;
      return;
    }
    // inside a building with the leader (restroom, gift shop)
    if (L.hidden) {
      g.hidden = true;
      g.x = L.x;
      g.z = L.z;
      g.y = L.y;
      g.speed = 0;
      g.action = L.action === 'restroom' ? 'restroom' : 'shop';
      return;
    }
    if (g.hidden) {
      g.hidden = false;
      g.x = L.x - Math.sin(L.heading) * 0.45;
      g.z = L.z - Math.cos(L.heading) * 0.45;
      g.heading = L.heading;
    }
    if (g.fstate === 1) {
      g.action = 'walk';
      if (approach(sim.world, g, dt, 0.8)) g.fstate = 2;
      return;
    }
    if (g.fstate === 2) {
      g.action = 'sit';
      standFacing(g, g.faceHeading, dt);
      return;
    }
    const slot = Math.max(0, Math.min(2, L.party.indexOf(g.id)));
    const walking = L.speed > 0.25;
    const h = L.heading;
    const s = Math.sin(h),
      c = Math.cos(h);
    let tx: number, tz: number;
    const qp = L.qObj && L.qPos >= 0 ? this.queues.points.get(L.qObj) : undefined;
    if (qp && L.qPos >= QP_SERVE) {
      // wait off to the side by the exit while the leader is served
      const a = 0.35 + slot * 0.5;
      tx = qp.ex - qp.dx * a + qp.nx * (0.25 + (slot & 1) * 0.4);
      tz = qp.ez - qp.dz * a + qp.nz * (0.25 + (slot & 1) * 0.4);
    } else if (qp) {
      // stand next to the leader on the path side of the line
      const along = slot === 1 ? 0.45 : 0;
      const out = slot === 2 ? 1.05 : 0.55;
      tx = L.x + qp.nx * out + qp.dx * along;
      tz = L.z + qp.nz * out + qp.dz * along;
    } else {
      const tbl = walking ? FOLLOW_WALK : L.action === 'watch' ? FOLLOW_BESIDE : FOLLOW_STAND;
      const ox = tbl[slot * 2],
        oz = tbl[slot * 2 + 1];
      // leader's right = (cos h, -sin h), forward = (sin h, cos h)
      tx = L.x + c * ox + s * oz;
      tz = L.z - s * ox + c * oz;
    }
    const dx = tx - g.x,
      dz = tz - g.z;
    const d = Math.hypot(dx, dz);
    const w = sim.world;
    if (d > 0.12) {
      const want = Math.min(g.walkSpeed * 1.45, d * 1.7 + (walking ? L.speed * 0.85 : 0));
      g.speed += Math.max(-4 * dt, Math.min(3 * dt, want - g.speed));
      if (g.speed < 0) g.speed = 0;
      const step = Math.min(d, g.speed * dt);
      const ox0 = g.x,
        oz0 = g.z;
      const ct = Math.floor(g.z / TILE) * MAP_W + Math.floor(g.x / TILE);
      if (g.z >= MAP_H * TILE - 0.01 || g.x < 0 || ct < 0 || ct >= N_TILES || !w.path[ct]) {
        // stepping in through the gate / off a bench: free movement until back on the path
        g.x += (dx / d) * step;
        g.z += (dz / d) * step;
      } else this.nudge(g, (dx / d) * step, (dz / d) * step, w);
      const moved = Math.abs(g.x - ox0) + Math.abs(g.z - oz0);
      if (d > 0.3 && moved > 1e-4) turnTowards(g, Math.atan2(g.x - ox0, g.z - oz0), dt);
      else turnTowards(g, L.action === 'watch' ? L.faceHeading : h, dt, 4);
      g.action = g.speed > 0.18 && moved > 1e-4 ? 'walk' : L.action === 'watch' ? 'watch' : 'idle';
      // lost the leader (e.g. a path was removed between them): catch up
      if (d > 1.5 && moved < step * 0.3) {
        g.stuck += dt;
        if (g.stuck > 2.5) {
          g.stuck = 0;
          g.x = L.x - s * 0.5;
          g.z = L.z - c * 0.5;
        }
      } else g.stuck = 0;
    } else {
      g.speed = Math.max(0, g.speed - 4 * dt);
      turnTowards(g, L.action === 'watch' ? L.faceHeading : h, dt, 4);
      g.action = L.action === 'watch' ? 'watch' : 'idle';
    }
    g.funRate = L.action === 'watch' ? L.funRate * (g.appearance.child ? 1.15 : 1) : 0;
    const t = Math.floor(g.z / TILE) * MAP_W + Math.floor(g.x / TILE);
    if (t >= 0 && t < N_TILES && w.path[t]) g.tile = t;
    g.y = personY(w, g.x, g.z);
  }

  /** Party-wide minimum needs (the leader decides for everyone). */
  private partyNeeds(g: GuestSim): PartyNeeds {
    const pn = this.pn;
    const n = g.needs;
    pn.hunger = g.holding === 'food' ? 1 : n.hunger;
    pn.thirst = g.holding === 'drink' ? 1 : n.thirst;
    pn.bladder = n.bladder;
    pn.energy = n.energy;
    pn.kids = 0;
    for (const id of g.party) {
      const f = this.sim.guests.get(id);
      if (!f) continue;
      const m = f.needs;
      if (f.holding !== 'food') pn.hunger = Math.min(pn.hunger, m.hunger);
      if (f.holding !== 'drink') pn.thirst = Math.min(pn.thirst, m.thirst);
      pn.bladder = Math.min(pn.bladder, m.bladder);
      pn.energy = Math.min(pn.energy, m.energy);
      if (f.appearance.child) pn.kids++;
    }
    return pn;
  }

  // ================================================================ queues
  private queueStep(g: GuestSim, dt: number) {
    const sim = this.sim;
    const p = this.queues.points.get(g.qObj);
    if (!p) {
      this.afterRelease(g);
      return;
    }
    if (g.qPos === QP_INSIDE) {
      g.hidden = true;
      g.speed = 0;
      g.action = p.service === 'restroom' ? 'restroom' : 'shop';
      g.timer -= dt;
      if (g.timer <= 0) this.finishInside(g, p);
      return;
    }
    const serve = g.qPos >= QP_SERVE;
    const k = serve ? g.qPos - QP_SERVE : g.qPos;
    if (serve ? k >= p.sx.length : k >= p.lx.length) {
      this.queues.leave(g);
      this.afterRelease(g);
      return;
    }
    const tx = serve ? p.sx[k] : p.lx[k],
      tz = serve ? p.sz[k] : p.lz[k];
    if (!serve) g.qWait += dt;
    if (!serve && !sim.isOpen()) {
      // shops shut: the line breaks up
      this.queues.leave(g);
      this.resumeWalking(g);
      return;
    }
    const far = (tx - g.x) ** 2 + (tz - g.z) ** 2 > 0.35 * 0.35;
    if (g.phase !== 2 || (far && g.timer <= 0)) {
      // walk up / shuffle forward to our place
      g.phase = 1;
      g.ax = tx;
      g.az = tz;
      g.action = 'walk';
      if (approach(sim.world, g, dt, serve ? 0.75 : g.qWait < 1 ? 0.8 : 0.5)) {
        g.phase = 2;
        if (serve) this.beginService(g, p, k);
      }
      return;
    }
    standFacing(g, serve ? p.sh[k] : p.lh[k], dt);
    if (serve) {
      g.timer -= dt;
      if (g.timer <= 0) this.finishService(g, p, k);
      return;
    }
    g.action = 'idle';
    // closing time, or out of patience
    const patience = 24 + hash01(g.seed, 17) * 18;
    if (!sim.isOpen() || g.qWait > patience) {
      const def = OBJECTS_BY_ID[sim.world.objects.get(p.obj)?.defId ?? ''];
      if (sim.isOpen()) {
        this.addThought(g, `This queue for the ${def?.name ?? 'shop'} is taking forever!`);
        g.mood -= 0.05;
        g.avoidObj = p.obj;
        g.avoidUntil = sim.time + 40;
        this.counters.gaveUp++;
      }
      this.queues.leave(g);
      this.resumeWalking(g);
    }
  }

  private beginService(g: GuestSim, p: ServicePoint, _k: number) {
    const rng = this.sim.rng;
    if (p.mode === 'enter') {
      this.queues.enter(p, g);
      g.hidden = true;
      g.action = p.service === 'restroom' ? 'restroom' : 'shop';
      g.timer = p.service === 'restroom' ? rng.range(2.8, 4.6) : rng.range(4, 7);
      return;
    }
    g.action = 'shop';
    g.timer = p.service === 'food' ? rng.range(1.8, 2.8) : p.service === 'gift' ? rng.range(2.5, 4) : rng.range(1.3, 2.1);
  }

  private finishService(g: GuestSim, p: ServicePoint, k: number) {
    this.purchase(g, p);
    if (p.serving[k] === g) p.serving[k] = null;
    g.qObj = 0;
    g.qPos = -1;
    this.exitTo(g, p);
  }

  private finishInside(g: GuestSim, p: ServicePoint) {
    const sim = this.sim;
    if (p.service === 'restroom') {
      this.counters.restroom++;
      g.needs.bladder = 1;
      for (const id of g.party) {
        const f = sim.guests.get(id);
        if (f) f.needs.bladder = 1;
      }
    } else this.purchase(g, p);
    this.queues.leave(g);
    g.hidden = false;
    const d = g.id % p.sx.length;
    g.x = p.sx[d];
    g.z = p.sz[d];
    g.heading = p.sh[d] + Math.PI;
    this.exitTo(g, p);
  }

  /** Step clear of the counter / door, then walk on. */
  private exitTo(g: GuestSim, p: ServicePoint) {
    g.qObj = 0;
    g.qPos = -1;
    g.goal = 'enter';
    g.goalKey = '';
    g.goalRef = 0;
    g.phase = 1;
    g.ax = p.ex + (hash01(g.id, 3) - 0.5) * 0.4;
    g.az = p.ez + (hash01(g.id, 5) - 0.5) * 0.4;
    g.tile = p.exitTile;
    g.next = -1;
    g.prev = -1;
    g.timer = 0;
  }

  /** Pay and hand over the goods: the leader treats the party. */
  private purchase(g: GuestSim, p: ServicePoint) {
    const sim = this.sim;
    const rng = sim.rng;
    const o = sim.world.objects.get(p.obj);
    const s = o ? OBJECTS_BY_ID[o.defId]?.shop : undefined;
    if (!o || !s) return;
    const kind = s.kind;
    const buyers = this.buyers;
    buyers.length = 0;
    for (let i = -1; i < g.party.length; i++) {
      const m = i < 0 ? g : sim.guests.get(g.party[i]);
      if (!m) continue;
      const n = m.needs;
      let wants: boolean;
      if (kind === 'food') wants = n.hunger < 0.7 && m.holding !== 'food';
      else if (kind === 'drink') wants = n.thirst < 0.72 && m.holding !== 'drink';
      else if (kind === 'icecream') wants = m.holding === 'none' && (m.appearance.child || n.hunger < 0.85 || n.thirst < 0.85 || rng.chance(0.4));
      else wants = m === g || (m.appearance.child && rng.chance(0.75));
      if (wants) buyers.push(m);
    }
    if (!buyers.length) buyers.push(g); // queued for it, so buy one anyway
    let earned = 0;
    let bought = 0;
    for (const m of buyers) {
      const payer = g.money >= s.price ? g : m.money >= s.price ? m : null;
      if (!payer) continue;
      payer.money -= s.price;
      earned += s.price - s.stockCost;
      bought++;
      this.giveItem(m, kind);
    }
    this.counters.served++;
    this.counters.items += bought;
    if (bought) {
      const c = sim.world.objectCenter(o);
      sim.earn('shopIncome', earned, { x: c.x, z: c.z });
    } else this.addThought(g, 'I can’t afford that.');
  }

  private buyers: GuestSim[] = [];

  private giveItem(m: GuestSim, kind: ShopKind) {
    const rng = this.sim.rng;
    if (kind === 'food') {
      m.holding = 'food';
      m.holdTime = rng.range(22, 34);
    } else if (kind === 'drink') {
      m.holding = 'drink';
      m.holdTime = rng.range(16, 26);
    } else if (kind === 'icecream') {
      m.holding = 'icecream';
      m.holdTime = rng.range(14, 22);
      this.addThought(m, m.appearance.child ? 'Yay, ice cream!' : 'This ice cream is delicious!');
    } else {
      m.holding = m.appearance.child || rng.chance(0.4) ? 'balloon' : 'gift';
      m.holdTime = 0;
      m.needs.fun = Math.min(1, m.needs.fun + 0.15);
      this.addThought(m, m.holding === 'balloon' ? 'I love my new balloon!' : 'I bought a lovely souvenir.');
    }
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
    g.think -= dt;
    // passers-by keep to the far side of a path with a queue along it
    const lane = g.lane;
    const qs = this.queues.side[g.next];
    if (qs && !(g.qObj && g.qPos < 0 && g.next === this.queues.points.get(g.qObj)?.tile)) {
      const fx = (g.next % MAP_W) - (g.tile % MAP_W),
        fz = ((g.next / MAP_W) | 0) - ((g.tile / MAP_W) | 0);
      const nx = qs === 1 ? 1 : qs === 2 ? -1 : 0,
        nz = qs === 3 ? 1 : qs === 4 ? -1 : 0;
      // lane offset vector is lane · (−fz, fx)
      const dot = -fz * nx + fx * nz;
      if (dot !== 0) g.lane = Math.sign(dot) * Math.max(0.35, Math.min(0.6, Math.abs(lane)));
    }
    const m = sim.minuteOfDay;
    // a long way to go: a brisk walk rather than a stroll; at closing time, hurry
    const pace =
      g.goal === 'leave' && m >= LATE_CLEAR ? 1.6 : g.goal === 'leave' && m >= (CLOSE_HOUR - 0.5) * 60 ? 1.35 : g.goalKey && this.field(g.goalKey)[g.tile] > BRISK_AFTER ? BRISK : 1;
    const reached = walkToNext(sim.world, g, dt, pace);
    g.lane = lane;
    if (reached) {
      // reached the tile centre: immediately pick the next tile so motion is continuous
      if (g.goal === 'wander') g.wanderSteps--;
      if (g.goal !== 'leave' && g.think <= 0) {
        g.think = 4;
        // time to head for the gate, or (on a long walk to a habitat) urgent needs take over
        const n = this.partyNeeds(g);
        if (this.homeTime(g) || (g.goal === 'view' && (n.bladder < 0.24 || n.hunger < 0.25 || n.thirst < 0.25 || n.energy < 0.25))) {
          this.think(g);
          g.think = 14;
          if (g.phase !== 0) return;
          g.next = -1;
        }
      }
      if (this.glance(g)) return;
      this.chooseNext(g);
    }
  }

  /** Whether this party is the kind to stop at this exhibit when passing it. */
  private wouldGlance(g: GuestSim, habId: number): boolean {
    return hash01(g.seed, habId) < GLANCE_CHANCE;
  }

  /**
   * Passing the fence of an exhibit the party hasn't seen yet, most stop for a
   * look (it counts as a visit), then carry on to where they were going.
   */
  private glance(g: GuestSim): boolean {
    if (g.goal !== 'view' && g.goal !== 'wander') return false;
    const habId = this.viewHabitats()[g.tile];
    if (!habId || habId === g.goalRef || g.viewed.includes(habId) || !this.wouldGlance(g, habId)) return false;
    const hab = this.sim.world.habitats.get(habId);
    if (!hab || this.crowdAt(habId) > Math.max(4, hab.viewTiles.length * 0.5)) return false;
    const n = this.partyNeeds(g);
    if (n.bladder < 0.3 || n.hunger < 0.3 || n.thirst < 0.3 || n.energy < 0.3) return false;
    // not if the look would leave no time for the exhibit the party set out for (it can look on the way back)
    if (g.plan && g.plan !== habId && this.tripTime(g, g.plan) + GLANCE_SECONDS > g.visitLeft) return false;
    // stand right here at the fence (the plan stays: think() resumes it afterwards), or a
    // few steps along it when this stretch is full
    const size = 1 + g.party.length;
    const crowd = this.countViewers(g, habId);
    let spot = g.tile;
    if ((crowd.get(spot) ?? 0) + size > VIEWERS_PER_TILE) {
      spot = this.pickViewTile(g, habId, hab.viewTiles, 4);
      if ((crowd.get(spot) ?? 0) + size > VIEWERS_PER_TILE) return false;
    }
    this.setGoal(g, 'view', `t:${spot}`, habId);
    if (spot === g.tile) this.arrive(g);
    else {
      g.phase = 0;
      g.next = -1;
    }
    return true;
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
    // heading for a queue: join it as soon as we reach its tail
    if (g.qObj && g.qPos < 0) {
      const p = this.queues.points.get(g.qObj);
      if (!p) {
        g.qObj = 0;
        this.think(g);
        return false;
      }
      const last = Math.min(p.line.length + 1, p.lt.length - 1);
      for (let i = 0; i <= last; i++)
        if (p.lt[i] === g.tile) {
          this.arrive(g);
          return false;
        }
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
        for (const id of g.party) this.toRemove.push(id);
        g.phase = 3;
        return false;
      }
      g.qObj = 0;
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

  /** Carry on from where we stand (after leaving a queue / losing a goal). */
  private resumeWalking(g: GuestSim) {
    const sim = this.sim;
    if (g.qObj) this.queues.leave(g);
    g.hidden = false;
    if (g.seatObj && !g.leader) g.seatObj = 0;
    if (g.leader) {
      g.phase = 4;
      return;
    }
    const tx = Math.floor(g.x / TILE),
      tz = Math.floor(g.z / TILE);
    let t = sim.world.inBounds(tx, tz) && sim.world.path[tz * MAP_W + tx] && !sim.world.habitatOf[tz * MAP_W + tx] ? tz * MAP_W + tx : -1;
    if (t < 0) t = sim.nav.nearestPathTile(tx, tz, 6);
    if (t < 0) {
      this.recover(g);
      return;
    }
    g.tile = t;
    g.next = -1;
    g.prev = -1;
    g.goal = 'enter';
    g.goalKey = '';
    g.goalRef = 0;
    g.phase = 1;
    g.ax = g.x;
    g.az = g.z;
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

  /** Walking time (s) from the guest's tile to the gate (0 if there is no way out). */
  private walkOutTime(g: GuestSim): number {
    const d = this.distance('exit', g.tile);
    return d === FAR ? 0 : (d * TILE) / Math.max(0.6, g.walkSpeed * (d > BRISK_AFTER ? BRISK : 1));
  }

  /** Why the party should head for the gate now (null = stay a while longer). */
  private homeTime(g: GuestSim): string | null {
    const sim = this.sim;
    const m = sim.minuteOfDay;
    if (!sim.isOpen() || m >= (CLOSE_HOUR - 0.5) * 60) return 'The zoo is closing — time to go home.';
    // allow for the walk back to the gate: from the far end of a big zoo that takes game hours
    const walk = this.walkOutTime(g) * 1.1;
    if (m + walk * GAME_MINUTES_PER_SECOND >= CLOSE_HOUR * 60 - 10) return 'The zoo closes soon — time to head back.';
    if (g.visitLeft <= walk) return g.happiness > 0.6 ? 'What a lovely day at the zoo!' : 'Time to go home.';
    return null;
  }

  /** A happy party heading home may stop at a gift shop that is (nearly) on the way out. */
  private souvenirOnTheWayOut(g: GuestSim): boolean {
    if (g.money < 15 || g.happiness < 0.55 || g.holding === 'gift' || g.holding === 'balloon' || hash01(g.seed, 31) > 0.5) return false;
    const exit = this.field('exit');
    const here = exit[g.tile];
    if (here === FAR) return false;
    for (const p of this.queues.points.values()) {
      if (p.service !== 'gift' || p.tile < 0 || p.full() || exit[p.tile] === FAR) continue;
      const d = this.distance(p.key, g.tile);
      if (d === FAR || d + exit[p.tile] - here > 6) continue;
      this.setGoal(g, 'shop', p.key, p.obj);
      g.qObj = p.obj;
      g.qPos = -1;
      return true;
    }
    return false;
  }

  /** Drop whatever the party is doing and head for the gate. */
  private sendHome(g: GuestSim, thought: string) {
    this.resumeWalking(g);
    if (g.phase === 3) return; // stranded off the paths: already being removed
    g.phase = 0;
    this.leave(g, thought);
  }

  private leave(g: GuestSim, thought: string) {
    if (g.goal === 'leave') return;
    this.addThought(g, thought);
    if (g.ticketValue < -0.08 && g.happiness < 0.55) this.addThought(g, 'That was too expensive for what we saw.');
    if (g.qObj) this.queues.leave(g);
    g.seatObj = 0;
    g.hidden = false;
    for (const id of g.party) {
      const f = this.sim.guests.get(id);
      if (f) {
        f.seatObj = 0;
        f.fstate = 0;
      }
    }
    this.setGoal(g, 'leave', 'exit', 0);
  }

  private think(g: GuestSim) {
    const sim = this.sim;
    const rng = sim.rng;
    const tile = g.tile;
    g.think = 6;
    if (g.qObj && g.qPos < 0) g.qObj = 0;
    // ---------------------------------------------------------- going home
    const home = this.homeTime(g);
    if (home) {
      if (sim.minuteOfDay < (CLOSE_HOUR - 1) * 60 && this.souvenirOnTheWayOut(g)) return;
      return this.leave(g, home);
    }
    const n = this.partyNeeds(g);
    if (n.energy < 0.12) return this.leave(g, n.kids ? 'The kids are worn out. Time to go home.' : 'I’m exhausted. Time to go home.');
    if (g.happiness < 0.22) return this.leave(g, 'This zoo is awful. I’m leaving!');
    if (g.money < 2 && n.hunger < 0.3) return this.leave(g, 'I’ve run out of money and I’m starving.');

    // ---------------------------------------------------------- needs
    // Not desperate yet: a shop far behind can wait until we have seen what we came for.
    const c = sim.progress.complaints;
    if (n.bladder < 0.3) {
      const r = this.wantService(g, 'restroom', { canWait: n.bladder > 0.15 });
      if (r === 'ok') return;
      if (r !== 'later') {
        if (r === 'none' || r === 'far') {
          c.restroom++;
          this.addThought(g, 'I really need a restroom!');
        } else if (r === 'cutoff') this.addThought(g, 'There are restrooms, but no path leads to them!');
        g.mood -= 0.08;
        if (n.bladder < 0.08) return this.leave(g, r === 'full' ? 'The restroom queues are hopeless. I’m going home!' : 'I can’t find a restroom. I’m going home!');
      }
    }
    if (n.hunger < 0.35) {
      const r = this.wantService(g, 'food', { alt: 'icecream', canWait: n.hunger > 0.15 });
      if (r === 'ok') return;
      if (r === 'none' || r === 'far') {
        c.food++;
        this.addThought(g, 'I’m hungry but there’s nowhere to eat!');
      } else if (r === 'broke') this.addThought(g, 'I’m hungry, but I can’t afford anything.');
      if (r !== 'later') g.mood -= 0.05;
    }
    if (n.thirst < 0.35) {
      const r = this.wantService(g, 'drink', { alt: 'icecream', canWait: n.thirst > 0.15 });
      if (r === 'ok') return;
      if (r === 'none' || r === 'far') {
        c.drink++;
        this.addThought(g, 'I’m so thirsty. Where can I get a drink?');
      }
      if (r !== 'later') g.mood -= 0.05;
    }
    if (n.energy < 0.35 || (g.holding === 'food' && rng.chance(0.35))) {
      const d = this.distance('bench', tile);
      if (d !== FAR && d < 30 && this.freeSeatExists()) return this.setGoal(g, 'sit', 'bench', 0);
      if (n.energy < 0.35) {
        sim.progress.complaints.bench++;
        this.addThought(g, 'My feet hurt. I wish there were more benches.');
      }
    }
    // passing a kiosk with a short queue: a snack or a drink on impulse
    if (g.money >= 6 && rng.chance(0.5)) {
      if (n.thirst < 0.55 && this.wantService(g, 'drink', { maxDist: 9, maxLine: 1, impulse: true }) === 'ok') return;
      if (n.hunger < 0.5 && this.wantService(g, 'food', { maxDist: 9, maxLine: 1, impulse: true }) === 'ok') return;
    }
    // ---------------------------------------------------------- treats (only when close by: nobody crosses the zoo for them)
    if (!g.donated && g.happiness > 0.68 && g.money > 4 && g.viewed.length >= 2 && rng.chance(0.15) && this.distance('donation', tile) < 15)
      return this.setGoal(g, 'donate', 'donation', 0);
    if ((g.holding === 'none' || g.holding === 'food') && g.money >= 15 && g.happiness > 0.62 && g.seenSpecies.length >= 2 && rng.chance(n.kids ? 0.12 : 0.07)) {
      if (this.wantService(g, 'gift', { maxDist: 15, impulse: true }) === 'ok') return;
    }
    const hour = sim.minuteOfDay / 60;
    if (g.holding === 'none' && g.money >= 4 && hour > 11 && hour < 17.5 && rng.chance(n.kids ? 0.12 : 0.05)) {
      if (this.wantService(g, 'icecream', { maxDist: 12, impulse: true }) === 'ok') return;
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
      g.visitLeft -= 20; // seen everything: a stroll or two more, then home
    }
    this.setWander(g, rng.int(5, 12));
  }

  /**
   * Head for the best shop / restroom of a kind (or of the substitute `alt`,
   * e.g. an ice cream instead of a snack, which counts as a little farther):
   * near, little detour from the exhibit the party is on its way to, short
   * queue, not one we gave up on recently. Otherwise say why not: it can wait
   * until after that exhibit ('later', only with `canWait`), every line is too
   * long ('full'), the nearest is too far away ('far'), none can be reached
   * from here ('cutoff'), the guest can't afford any ('broke') or none has
   * been built ('none'). `impulse` buys add no thoughts or complaints.
   */
  private wantService(g: GuestSim, kind: ServiceKind, opts: ServiceOpts = {}): ServiceAnswer {
    const sim = this.sim;
    const maxDist = opts.maxDist ?? 45;
    const maxLine = opts.maxLine ?? 99;
    const planning = g.plan && !g.viewed.includes(g.plan);
    const toPlan = planning ? this.field(`hab:${g.plan}`) : null;
    const planHere = toPlan ? toPlan[g.tile] : FAR;
    let best: ServicePoint | null = null;
    let bestScore = Infinity;
    let built = false,
      affordable = false,
      reachable = false,
      near = false,
      deferred = false,
      crowded = false;
    let crowdedName = '';
    for (const p of this.queues.points.values()) {
      if (p.service !== kind && p.service !== opts.alt) continue;
      built = true;
      if (p.service !== 'restroom') {
        const o = sim.world.objects.get(p.obj);
        const price = o ? OBJECTS_BY_ID[o.defId]?.shop?.price ?? 0 : 0;
        if (g.money < price) continue;
      }
      affordable = true;
      const d = this.distance(p.key, g.tile);
      if (d === FAR) continue;
      reachable = true;
      if (d > maxDist) continue;
      near = true;
      if (p.line.length > maxLine) continue;
      let score = d + (p.line.length + p.busy() * 0.5) * 2.6 + (p.service === kind ? 0 : 8);
      // on the way somewhere: weigh the detour, so a stop along the route beats one behind us
      const planThere = toPlan && p.tile >= 0 ? toPlan[p.tile] : FAR;
      if (planHere !== FAR && planThere !== FAR) {
        const detour = d + planThere - planHere;
        if (opts.canWait && detour > 8 + planHere * 0.5) {
          deferred = true;
          continue;
        }
        score += detour - 0.5 * d;
      }
      const avoided = g.avoidObj === p.obj && sim.time < g.avoidUntil;
      if (avoided || p.full()) {
        crowded = true;
        if (!crowdedName) crowdedName = OBJECTS_BY_ID[sim.world.objects.get(p.obj)?.defId ?? '']?.name ?? '';
        continue;
      }
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) {
      this.setGoal(g, kind === 'restroom' ? 'restroom' : 'shop', best.key, best.obj);
      g.qObj = best.obj;
      g.qPos = -1;
      return 'ok';
    }
    const why = deferred ? 'later' : !built ? 'none' : !affordable ? 'broke' : !reachable ? 'cutoff' : !near ? 'far' : 'full';
    if (opts.impulse) return why;
    if (why === 'full' && crowded) {
      this.counters.full++;
      this.addThought(g, `The queue at the ${crowdedName || 'kiosk'} is far too long.`);
      g.mood -= 0.02;
    } else if (why !== 'full' && why !== 'later') this.counters.none++;
    return why;
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

  private habCrowd = new Map<number, number>();
  private habCrowdTime = -1;

  /** People (parties weighted by size) at or heading to each habitat, refreshed each simulated second. */
  private crowdAt(habId: number): number {
    const sim = this.sim;
    if (sim.time - this.habCrowdTime >= 1 || this.habCrowdTime > sim.time) {
      this.habCrowdTime = sim.time;
      const m = this.habCrowd;
      m.clear();
      for (const o of sim.guests.values()) {
        if (o.leader || o.goal !== 'view') continue;
        m.set(o.goalRef, (m.get(o.goalRef) ?? 0) + 1 + o.party.length);
      }
    }
    return this.habCrowd.get(habId) ?? 0;
  }

  private habExit = new Map<number, number>();
  private habExitRev = -1;

  /** Path distance (tiles) from a habitat's viewing fence to the gate, cached per world revision. */
  private habExitDist(habId: number): number {
    const w = this.sim.world;
    if (this.habExitRev !== w.revision) {
      this.habExitRev = w.revision;
      this.habExit.clear();
    }
    let d = this.habExit.get(habId);
    if (d === undefined) {
      d = FAR;
      const exit = this.field('exit');
      for (const t of w.habitats.get(habId)?.viewTiles ?? []) d = Math.min(d, exit[t]);
      this.habExit.set(habId, d);
    }
    return d;
  }

  /**
   * An exhibit, shop or restroom no path from the entrance leads to (so the
   * player is told to reconnect it, rather than that it is missing), or null.
   */
  unreachable(): { text: string; focus: { x: number; z: number } } | null {
    const sim = this.sim;
    const w = sim.world;
    if (!sim.gateTiles(this.gateTmp).length) return null;
    for (const hab of w.habitats.values()) {
      if (!hab.viewTiles.length || !sim.population(hab.id).count.size || this.habExitDist(hab.id) !== FAR) continue;
      const t = hab.viewTiles[0];
      return {
        text: `Guests can’t reach ${hab.name} — connect its viewing path to the paths from the entrance.`,
        focus: { x: ((t % MAP_W) + 0.5) * TILE, z: (((t / MAP_W) | 0) + 0.5) * TILE },
      };
    }
    const exit = this.field('exit');
    for (const p of this.queues.points.values()) {
      if (p.tile < 0 || exit[p.tile] !== FAR) continue;
      const o = w.objects.get(p.obj);
      if (!o) continue;
      const c = w.objectCenter(o);
      return {
        text: `Guests can’t reach the ${OBJECTS_BY_ID[o.defId]?.name ?? 'shop'} — connect it to the paths from the entrance.`,
        focus: { x: c.x, z: c.z },
      };
    }
    return null;
  }

  /** Seconds to walk to a habitat, watch, and still make it back to the gate (Infinity if unreachable). */
  private tripTime(g: GuestSim, habId: number): number {
    const there = this.distance(`hab:${habId}`, g.tile);
    const back = this.habExitDist(habId);
    if (there === FAR || back === FAR) return Infinity;
    return ((there + back) * TILE) / Math.max(0.6, g.walkSpeed * BRISK) + 12;
  }

  /** A habitat with animals the guest can see and hasn't viewed yet. */
  private worthSeeing(g: GuestSim, habId: number): boolean {
    const hab = this.sim.world.habitats.get(habId);
    return !!hab && hab.viewTiles.length > 0 && !g.viewed.includes(habId) && this.sim.population(habId).count.size > 0;
  }

  /**
   * Pick the next exhibit. The party keeps to the one it set out for (after a
   * snack, a restroom or a look at another exhibit on the way). Otherwise it
   * weighs every exhibit it still has time for by what it would see: the
   * exhibit itself plus the unseen ones the walk there passes (most people
   * stop for a look on the way). What counts against an exhibit is the walk
   * it adds to the way out, so the day makes a loop: with most of the visit
   * ahead a party is happy to head for the far exhibits first, and on the way
   * back the ones near the gate cost little. How far people are happy to go
   * differs, and crowded fence lines put them off.
   */
  private chooseHabitat(g: GuestSim): boolean {
    const sim = this.sim;
    if (g.plan && this.worthSeeing(g, g.plan) && this.tripTime(g, g.plan) <= g.visitLeft) {
      this.setGoal(g, 'view', `hab:${g.plan}`, g.plan);
      return true;
    }
    g.plan = 0;
    // tiles of detour they shrug off; more with a long visit ahead (VISIT_AHEAD sim seconds ≈ 6 game hours)
    const reach = (10 + 30 * hash01(g.seed, 23)) * Math.min(2, Math.max(0.6, g.visitLeft / VISIT_AHEAD));
    const home = this.distance('exit', g.tile);
    const fresh = !g.viewed.length || home === FAR;
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
      // with room for a snack or restroom stop on the way, so the party still makes it there
      if (d === FAR || this.tripTime(g, hab.id) + PLAN_SLACK > g.visitLeft) continue;
      const value = appeal * (viewed ? 0.1 : unseen ? 1 : 0.5) + this.sightsOnTheWay(g, hab.id);
      const crowd = this.crowdAt(hab.id) / Math.max(4, hab.viewTiles.length * 0.5);
      // a party that has seen nothing yet picks where to head mostly by what it would see there and
      // on the way (the round trip counts as its share of the visit left; it can catch the near
      // exhibits coming back); later picks weigh the walk they add to the way out
      const far = fresh ? 1 + this.tripTime(g, hab.id) / g.visitLeft : 1 + Math.max(0, d + this.habExitDist(hab.id) - home) / (2 * reach);
      const score = (value * (0.75 + 0.5 * sim.rng.float())) / (far * (1 + crowd * crowd));
      if (score > bestScore) {
        bestScore = score;
        best = hab.id;
      }
    }
    if (!best || bestScore < 0.25) return false;
    // a favourite seen before is a one-off stroll back, not a plan to keep
    if (!g.viewed.includes(best)) g.plan = best;
    this.setGoal(g, 'view', `hab:${best}`, best);
    return true;
  }

  private routeSeen: number[] = [];

  /**
   * Expected appeal of the unseen exhibits the party would pass on its way to
   * `habId`: follows the same downhill steps the walk will take.
   */
  private sightsOnTheWay(g: GuestSim, habId: number): number {
    const field = this.field(`hab:${habId}`);
    const views = this.viewHabitats();
    const nav = this.sim.nav;
    const seen = this.routeSeen;
    seen.length = 0;
    let value = 0;
    for (let t = g.tile, steps = 0; t >= 0 && field[t] !== 0 && field[t] !== FAR && steps < 160; steps++) {
      const h = views[t];
      if (h && h !== habId && !seen.includes(h) && !g.viewed.includes(h)) {
        seen.push(h);
        if (this.wouldGlance(g, h)) value += this.viewAppealGrid[t] * 10;
      }
      t = nav.downhill(field, t, g.seed);
    }
    return value;
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
    switch (g.goal) {
      case 'leave':
        g.phase = 3;
        g.hidden = false;
        for (const id of g.party) {
          const f = sim.guests.get(id);
          if (f && f.phase === 4) {
            f.phase = 3;
            f.hidden = false;
            f.seatObj = 0;
          }
        }
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
            const side = this.fenceSlot(g, cx, cz, DX[k], DZ[k]);
            g.ax = cx + DX[k] * 0.55 - DZ[k] * side;
            g.az = cz + DZ[k] * 0.55 + DX[k] * side;
            g.faceHeading = Math.atan2(DX[k], DZ[k]);
            g.phase = 1;
            return;
          }
        }
        break;
      }
      case 'shop':
      case 'restroom': {
        const p = this.queues.points.get(g.qObj);
        if (!p || sim.minuteOfDay >= CLOSE_HOUR * 60 - 20) break;
        g.timer = 0;
        if (!this.queues.join(p, g)) {
          // the line filled up while we walked over: try another, else give up for now
          g.avoidObj = p.obj;
          g.avoidUntil = sim.time + 30;
          g.qObj = 0;
          const kind = p.service;
          if (this.wantService(g, kind) === 'ok') return;
          break;
        }
        return;
      }
      case 'donate': {
        const oid = this.adjacentObject(g.tile, (id) => id === 'donation_box');
        if (!oid) break;
        g.goalRef = oid;
        const o = w.objects.get(oid)!;
        const c = w.objectCenter(o);
        const dx = c.x - cx,
          dz = c.z - cz;
        const d = Math.hypot(dx, dz) || 1;
        const side = rng.range(-0.3, 0.3);
        g.ax = cx + (dx / d) * 0.55 - (dz / d) * side;
        g.az = cz + (dz / d) * 0.55 + (dx / d) * side;
        g.faceHeading = Math.atan2(dx, dz);
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
    g.qObj = 0;
    this.think(g);
  }

  private viewCrowd = new Map<number, number>();
  private viewSeen = new Set<number>();
  private viewQueue: number[] = [];
  /** BFS depth of each viewQueue entry. */
  private viewSteps: number[] = [];
  private slotSides: number[] = [];

  /** People (whole parties) standing at, or walking to, each viewing tile of a habitat. */
  private countViewers(g: GuestSim, habId: number): Map<number, number> {
    const crowd = this.viewCrowd;
    crowd.clear();
    for (const o of this.sim.guests.values()) {
      if (o === g || o.leader || o.goal !== 'view' || o.goalRef !== habId) continue;
      const t = o.phase === 0 && o.goalKey.charCodeAt(0) === 116 ? Number(o.goalKey.slice(2)) : o.phase !== 0 ? o.tile : -1;
      if (t >= 0) crowd.set(t, (crowd.get(t) ?? 0) + 1 + o.party.length);
    }
    return crowd;
  }

  /**
   * Choose a viewing tile reachable along the habitat's viewing tiles (within a short
   * stroll, `maxSteps` tiles) that is close to the animals and has room for the party.
   */
  private pickViewTile(g: GuestSim, habId: number, viewTiles: number[], maxSteps = 14): number {
    const sim = this.sim;
    const crowd = this.countViewers(g, habId);
    const size = 1 + g.party.length;
    // BFS over this habitat's viewing tiles (and the path tiles between them), up to maxSteps
    const seen = this.viewSeen;
    seen.clear();
    const q = this.viewQueue;
    q.length = 0;
    q.push(g.tile);
    seen.add(g.tile);
    const steps = this.viewSteps;
    steps.length = 0;
    steps.push(0);
    const adj = sim.nav.adj;
    let best = g.tile,
      bestScore = -Infinity;
    for (let head = 0; head < q.length && head < 60; head++) {
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
        // neighbouring tiles feel busy too; a stretch without room for the party is a last resort
        let busy = (crowd.get(t) ?? 0) * 0.9;
        for (let k = 0; k < 4; k++) busy += (crowd.get(t + DX[k] + DZ[k] * MAP_W) ?? 0) * 0.3;
        const overflow = Math.max(0, (crowd.get(t) ?? 0) + size - VIEWERS_PER_TILE);
        const score = -Math.min(near, 60) * 0.08 - busy - overflow * 4 - walk * 0.05 + sim.rng.float() * 1.2;
        if (score > bestScore) {
          bestScore = score;
          best = t;
        }
      }
      if ((!isView && head > 0) || steps[head] >= maxSteps) continue; // only stroll along the viewing tiles
      const m = adj[t];
      for (let k = 0; k < 4; k++) {
        if (!(m & (1 << k))) continue;
        const n = t + DX[k] + DZ[k] * MAP_W;
        if (seen.has(n)) continue;
        seen.add(n);
        q.push(n);
        steps.push(steps[head] + 1);
      }
    }
    return best;
  }

  /**
   * Where along the fence of this tile (offset from its centre, m) a party stands to watch:
   * the slot whose members (leader, then FOLLOW_BESIDE) keep clear of people already there.
   * (fx, fz) points from the tile centre at the fence.
   */
  private fenceSlot(g: GuestSim, cx: number, cz: number, fx: number, fz: number): number {
    const sim = this.sim;
    // others' positions along the fence (people already near this stretch, or walking up to it)
    const sides = this.slotSides;
    sides.length = 0;
    for (const o of sim.guests.values()) {
      // (leaders just walking past don't count)
      if (o === g || o.leader === g.id || o.hidden || o.phase === 3 || (o.phase === 0 && !o.leader)) continue;
      const px = o.phase === 1 && !o.leader ? o.ax : o.x,
        pz = o.phase === 1 && !o.leader ? o.az : o.z;
      const ox = px - cx,
        oz = pz - cz;
      if (ox * fx + oz * fz < 0.05 || Math.abs(ox * -fz + oz * fx) > 2.4) continue;
      sides.push(ox * -fz + oz * fx);
    }
    let best = 0,
      bestCost = Infinity;
    const start = sim.rng.int(0, 4);
    for (let c = 0; c < 5; c++) {
      const side = -0.7 + ((start + c) % 5) * 0.35;
      let cost = 0;
      for (let m = 0; m <= g.party.length; m++) {
        // follower m−1 stands its FOLLOW_BESIDE x to the leader's right, which is towards −side
        const ms = m === 0 ? side : side - FOLLOW_BESIDE[Math.min(2, m - 1) * 2];
        for (const os of sides) cost += Math.max(0, 2 * ADULT_R + 0.04 - Math.abs(ms - os));
        cost += Math.max(0, Math.abs(ms) - 1.2) * 0.5; // past the tile: a little worse
      }
      if (cost < bestCost - 1e-6) {
        bestCost = cost;
        best = side;
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

  private seatTmp = { x: 0, z: 0, heading: 0 };
  private usedSeats = new Set<number>();

  /** Free seat index on a bench object (-1 = none). */
  private freeSeat(objId: number, seats: number): number {
    const used = this.usedSeats;
    used.clear();
    for (const g of this.sim.guests.values()) if (g.seatObj === objId) used.add(g.seatIdx);
    for (let i = 0; i < seats; i++) if (!used.has(i)) return i;
    return -1;
  }

  private findSeat(tile: number): { obj: number; idx: number; x: number; z: number; heading: number } | null {
    const sim = this.sim;
    const oid = this.adjacentObject(tile, (id, objId) => !!OBJECTS_BY_ID[id]?.bench && this.freeSeat(objId, id === 'picnic_table' ? 4 : 2) >= 0);
    if (!oid) return null;
    const o = sim.world.objects.get(oid)!;
    const idx = this.freeSeat(oid, o.defId === 'picnic_table' ? 4 : 2);
    if (idx < 0) return null;
    const p = this.seatTmp;
    this.seatPos(o, idx, p);
    return { obj: oid, idx, x: p.x, z: p.z, heading: p.heading };
  }

  /** Reached the spot for the goal's action (phase 1 → 2). */
  private beginAction(g: GuestSim) {
    const sim = this.sim;
    const rng = sim.rng;
    g.phase = 2;
    switch (g.goal) {
      case 'enter':
        // just through the turnstiles: some parties stop to get their bearings
        if (!g.plan && !g.viewed.length && rng.chance(0.4) && this.gateTmp.length && sim.gateTiles(this.gateTmp).includes(g.tile)) {
          this.addThought(g, g.party.length ? 'Where shall we go first?' : 'Where shall I go first?');
          g.action = 'idle';
          g.timer = rng.range(1.5, 4);
          g.faceHeading = Math.PI + rng.range(-0.9, 0.9);
          return;
        }
        g.phase = 0;
        g.next = -1;
        this.think(g);
        return;
      case 'view':
        this.startWatch(g);
        return;
      case 'donate':
        g.action = 'idle';
        g.timer = rng.range(1.5, 2.5);
        return;
      case 'sit': {
        g.action = 'sit';
        g.timer = rng.range(10, 22);
        // companions take the free seats next to the leader
        const o = sim.world.objects.get(g.seatObj);
        if (o) {
          const seats = o.defId === 'picnic_table' ? 4 : 2;
          for (const id of g.party) {
            const f = sim.guests.get(id);
            if (!f || f.phase !== 4) continue;
            const idx = this.freeSeat(o.id, seats);
            if (idx < 0) break;
            this.seatPos(o, idx, this.seatTmp);
            f.seatObj = o.id;
            f.seatIdx = idx;
            f.ax = this.seatTmp.x;
            f.az = this.seatTmp.z;
            f.faceHeading = this.seatTmp.heading;
            f.fstate = 1;
          }
        }
        return;
      }
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
    // a stop on the way somewhere is a shorter look than the exhibit the party came for
    g.timer = g.plan && g.plan !== hab?.id ? rng.range(5, GLANCE_SECONDS) : rng.range(9, 17);
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
    // the whole party saw them
    for (const id of g.party) {
      const f = sim.guests.get(id);
      if (!f) continue;
      for (const sid of g.seenSpecies) if (!f.seenSpecies.includes(sid)) f.seenSpecies.push(sid);
      if (!f.viewed.includes(hab.id)) f.viewed.push(hab.id);
      f.mood += 0.05 * quality;
      if (near > 0 && rng.chance(0.5)) this.addThought(f, f.appearance.child ? `Look at the ${plural}!` : `I like the ${plural}.`);
    }
  }

  private finishAction(g: GuestSim) {
    const sim = this.sim;
    const rng = sim.rng;
    const w = sim.world;
    switch (g.goal) {
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
        for (const id of g.party) {
          const f = sim.guests.get(id);
          if (f && f.fstate) {
            f.fstate = 0;
            f.seatObj = 0;
          }
        }
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
  private viewAppealGrid = new Float32Array(N_TILES);
  private viewHabGrid = new Uint16Array(N_TILES);
  private glanceRev = -1;
  private glanceTime = -1;

  /** Refresh the per-tile view grids (every few seconds, or when the world changed). */
  private refreshViewGrids() {
    const sim = this.sim;
    if (this.glanceRev === sim.world.revision && sim.time - this.glanceTime < 4 && this.glanceTime <= sim.time) return;
    this.glanceRev = sim.world.revision;
    this.glanceTime = sim.time;
    const v = this.viewAppealGrid;
    const h = this.viewHabGrid;
    v.fill(0);
    h.fill(0);
    for (const hab of sim.world.habitats.values()) {
      if (!hab.viewTiles.length) continue;
      let appeal = 0;
      for (const sid of sim.population(hab.id).count.keys()) appeal = Math.max(appeal, SPECIES_BY_ID[sid]?.appeal ?? 5);
      if (!appeal) continue;
      for (const t of hab.viewTiles) {
        if (appeal / 10 <= v[t]) continue;
        v[t] = appeal / 10;
        h[t] = hab.id;
      }
    }
  }

  /** Per path tile: appeal (0..1) of the animals visible from it. */
  private viewAppeal(): Float32Array {
    this.refreshViewGrids();
    return this.viewAppealGrid;
  }

  /** Per path tile: the most appealing habitat with animals seen from it (0 = none). */
  private viewHabitats(): Uint16Array {
    this.refreshViewGrids();
    return this.viewHabGrid;
  }

  private look(g: GuestSim) {
    const sim = this.sim;
    const t = g.tile;
    if (t < 0) return;
    const s = Math.min(1, sim.scenery[t] / 4);
    g.scenic += (s - g.scenic) * 0.35;
    // glancing at the animals while walking past an enclosure
    if (g.action === 'walk') {
      const v = this.viewAppeal()[t];
      if (v > 0) g.needs.fun = Math.min(1, g.needs.fun + 0.012 * v);
    }
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
    if (trash >= 5) {
      g.mood -= 0.03;
      if (!g.leader) sim.progress.noteLitter(g.id, t, trash);
      if (sim.rng.chance(0.3)) this.addThought(g, 'There’s litter all over this path!');
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
      if (sp && sp.danger >= 3 && !g.leader && g.phase !== 3 && !g.hidden) this.sendHome(g, 'I’m not staying here with a dangerous animal loose!');
      break;
    }
  }
}
