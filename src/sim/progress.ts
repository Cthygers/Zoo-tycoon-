// Zoo rating (0..100, smoothed) and the progressive objective list.

import { MAP_W, TILE } from '../core/constants';
import { fmtMoney } from '../core/format';
import type { Objective } from '../core/types';
import { OBJECTS_BY_ID } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import type { Simulation } from './simulation';

interface ObjectiveDef {
  id: string;
  text: string;
  reward: number;
  check: (sim: Simulation, p: Progress) => boolean;
}

const OBJECTIVES: ObjectiveDef[] = [
  { id: 'build_habitat', text: 'Build your first habitat (enclose an area with fences)', reward: 2000, check: (s) => s.world.habitats.size > 0 },
  { id: 'first_animal', text: 'Adopt your first animal', reward: 2500, check: (s) => s.animals.size > 0 },
  { id: 'hire_keeper', text: 'Hire a keeper to feed your animals', reward: 1000, check: (s) => s.keeperCount() > 0 },
  { id: 'food_stand', text: 'Build a snack or drinks kiosk', reward: 1500, check: (_s, p) => p.has.food || p.has.drink },
  { id: 'restrooms', text: 'Build restrooms for your guests', reward: 1500, check: (_s, p) => p.has.restroom },
  { id: 'guests_25', text: 'Welcome 25 guests in a single day', reward: 2500, check: (s) => s.guestsToday >= 25 },
  { id: 'species_3', text: 'Exhibit 3 different species', reward: 5000, check: (_s, p) => p.speciesCount >= 3 },
  { id: 'happy_10', text: 'Have 10 animals with happiness above 70%', reward: 5000, check: (_s, p) => p.happyAnimals >= 10 },
  { id: 'guests_50', text: 'Welcome 50 guests in a single day', reward: 5000, check: (s) => s.guestsToday >= 50 },
  { id: 'baby', text: 'Have a baby animal born in your zoo', reward: 5000, check: (_s, p) => p.counters.births > 0 },
  { id: 'rating_60', text: 'Reach a zoo rating of 60', reward: 8000, check: (s) => s.rating >= 60 },
  { id: 'species_6', text: 'Exhibit 6 different species', reward: 10000, check: (_s, p) => p.speciesCount >= 6 },
  { id: 'guests_150', text: 'Welcome 150 guests in a single day', reward: 10000, check: (s) => s.guestsToday >= 150 },
  { id: 'money_100k', text: 'Have $100,000 in the bank', reward: 15000, check: (s) => s.money >= 100000 },
  { id: 'rating_80', text: 'Reach a zoo rating of 80', reward: 20000, check: (s) => s.rating >= 80 },
  { id: 'species_10', text: 'Exhibit 10 different species', reward: 25000, check: (_s, p) => p.speciesCount >= 10 },
  { id: 'visitors_5000', text: 'Welcome 5,000 visitors in total', reward: 30000, check: (s) => s.totalVisitors >= 5000 },
];

export function createObjectives(): Objective[] {
  return OBJECTIVES.map((o) => ({ id: o.id, text: o.text, done: false, reward: o.reward }));
}

/** Guest complaint counters (reset after each report window). */
export interface Complaints {
  restroom: number;
  food: number;
  drink: number;
  bench: number;
  noAnimals: number;
  price: number;
}

export class Progress {
  counters = { births: 0 };
  has = { food: false, drink: false, restroom: false, bench: false, bin: false, gift: false };
  speciesCount = 0;
  happyAnimals = 0;
  complaints: Complaints = { restroom: 0, food: 0, drink: 0, bench: 0, noAnimals: 0, price: 0 };
  /** Parties put off by a litter hot spot this report window (each counts once), and the worst spot. */
  private litterParties = new Set<number>();
  private worstLitterTile = -1;
  private worstLitter = 0;
  private ratingAcc = 0;
  private complaintAcc = 0;
  private facilitiesRev = -1;

  constructor(private sim: Simulation) {}

  reset() {
    this.counters = { births: 0 };
    this.ratingAcc = 0;
    this.complaintAcc = 0;
    this.facilitiesRev = -1;
    this.clearComplaints();
  }

  serialize(): Record<string, number> {
    return { births: this.counters.births, ratingAcc: this.ratingAcc, complaintAcc: this.complaintAcc };
  }
  load(d: Record<string, number>) {
    this.counters.births = d.births ?? 0;
    this.ratingAcc = d.ratingAcc ?? 0;
    this.complaintAcc = d.complaintAcc ?? 0;
    this.facilitiesRev = -1;
    this.clearComplaints();
  }

  private clearComplaints() {
    const c = this.complaints;
    c.restroom = c.food = c.drink = c.bench = c.noAnimals = c.price = 0;
    this.litterParties.clear();
    this.worstLitterTile = -1;
    this.worstLitter = 0;
  }

  /** A party leader saw `trash` items around path tile `tile`. */
  noteLitter(leaderId: number, tile: number, trash: number) {
    this.litterParties.add(leaderId);
    if (trash > this.worstLitter) {
      this.worstLitter = trash;
      this.worstLitterTile = tile;
    }
  }

  private refreshFacilities() {
    const w = this.sim.world;
    if (this.facilitiesRev === w.revision) return;
    this.facilitiesRev = w.revision;
    const h = this.has;
    const n = this.outlets;
    h.food = h.drink = h.restroom = h.bench = h.bin = h.gift = false;
    n.food = n.drink = n.restroom = 0;
    for (const o of w.objects.values()) {
      const d = OBJECTS_BY_ID[o.defId];
      if (!d) continue;
      const kind = d.shop?.kind;
      if (kind === 'food') h.food = true;
      if (kind === 'drink') h.drink = true;
      if (kind === 'gift') h.gift = true;
      if (d.restroom) h.restroom = true;
      if (d.bench) h.bench = true;
      if (d.bin) h.bin = true;
      // an ice cream cart takes some pressure off both the snack and the drinks kiosks
      n.food += kind === 'food' ? 1 : kind === 'icecream' ? 0.5 : 0;
      n.drink += kind === 'drink' ? 1 : kind === 'icecream' ? 0.5 : 0;
      if (d.restroom) n.restroom++;
    }
  }
  /** Food, drink and restroom outlets (an ice cream cart counts half for food and drink). */
  private outlets = { food: 0, drink: 0, restroom: 0 };

  /**
   * Instantaneous rating target 0..100 from the current zoo: up to 55 for the
   * exhibits (a varied, large, appealing collection, scaled by how well the
   * animals are kept) and up to 45 for the visit (mostly how happy guests are,
   * then scenery, clean paths and enough facilities for the crowd). Collection
   * size and variety keep counting with diminishing returns, so a small zoo
   * rates in the 40s and only a big, well-run one reaches 80.
   */
  targetRating(): number {
    const sim = this.sim;
    this.refreshFacilities();
    let ah = 0;
    let n = 0;
    const species = new Set<string>();
    let appeal = 0;
    for (const a of sim.animals.values()) {
      ah += a.happiness * (0.6 + 0.4 * a.health);
      n++;
      if (!species.has(a.speciesId)) {
        species.add(a.speciesId);
        appeal += SPECIES_BY_ID[a.speciesId]?.appeal ?? 5;
      }
    }
    const welfare = n ? ah / n : 0;
    const diversity = 1 - Math.exp(-species.size / 3.5);
    const collection = 1 - Math.exp(-n / 18);
    const avgAppeal = species.size ? appeal / species.size / 10 : 0;
    const exhibits = 55 * (0.5 * diversity + 0.3 * collection + 0.2 * avgAppeal) * (0.4 + 0.6 * welfare);

    let gh = 0;
    for (const g of sim.guests.values()) gh += g.happiness;
    const guestHappy = sim.guests.size ? 0.5 * (gh / sim.guests.size) + 0.5 * sim.satisfaction : sim.satisfaction;
    // scenery along the paths
    sim.ensureSceneryGrid();
    let sc = 0,
      pathTiles = 0;
    const w = sim.world;
    for (let i = 0; i < w.path.length; i++) {
      if (!w.path[i]) continue;
      pathTiles++;
      sc += Math.min(4, sim.scenery[i]);
    }
    const scenery = pathTiles ? Math.min(1, sc / pathTiles / 2) : 0;
    let trash = 0;
    for (const l of sim.litter.values()) if (l.kind === 'trash') trash++;
    const cleanliness = 1 - Math.min(1, trash / (6 + pathTiles * 0.06));
    // about one of each outlet per 60 guests the zoo can hold, plus somewhere to sit and a bin
    const need = Math.max(1, sim.guestSys.capacity / 60);
    const o = this.outlets;
    const outlets = (Math.min(1, o.food / need) + Math.min(1, o.drink / need) + Math.min(1, o.restroom / need)) / 3;
    const facilities = 0.8 * outlets + 0.1 * (this.has.bench ? 1 : 0) + 0.1 * (this.has.bin ? 1 : 0);
    const visit = 45 * (0.55 * guestHappy + 0.15 * scenery + 0.15 * cleanliness + 0.15 * facilities);

    const total = exhibits + visit - this.viewablePenalty();
    return Math.max(0, Math.min(100, total));
  }

  private viewablePenalty(): number {
    // habitats with animals that guests can't see don't count for much
    let hidden = 0;
    for (const hab of this.sim.world.habitats.values()) {
      if (hab.viewTiles.length) continue;
      const pop = this.sim.population(hab.id);
      if (pop.count.size) hidden++;
    }
    return Math.min(6, hidden * 3);
  }

  tick(dt: number) {
    const sim = this.sim;
    this.ratingAcc += dt;
    if (this.ratingAcc >= 2) {
      this.ratingAcc -= 2;
      const target = this.targetRating();
      sim.rating += (target - sim.rating) * Math.min(1, 2 / 40);
      sim.rating = Math.max(0, Math.min(100, sim.rating));
      // counts for objectives
      const species = new Set<string>();
      let happy = 0;
      for (const a of sim.animals.values()) {
        species.add(a.speciesId);
        if (a.happiness > 0.7) happy++;
      }
      this.speciesCount = species.size;
      this.happyAnimals = happy;
      this.checkObjectives();
    }
    this.complaintAcc += dt;
    if (this.complaintAcc >= 15) {
      this.complaintAcc -= 15;
      this.reportComplaints();
    }
  }

  checkObjectives() {
    const sim = this.sim;
    this.refreshFacilities();
    for (const o of sim.objectives) {
      if (o.done) continue;
      const def = OBJECTIVES.find((d) => d.id === o.id);
      if (!def || !def.check(sim, this)) continue;
      o.done = true;
      sim.earn('other', o.reward);
      // the UI celebrates it with a card, so the message only goes to the log
      sim.events.emit('objectiveCompleted', { id: o.id, text: o.text, reward: o.reward });
      sim.logMessage(`Goal complete: ${o.text} (${fmtMoney(o.reward, { sign: true })})`, 'good');
    }
  }

  private reportComplaints() {
    const sim = this.sim;
    const c = this.complaints;
    const g = sim.guests.size;
    const thr = Math.max(3, g * 0.08);
    this.refreshFacilities();
    const h = this.has;
    // a path cut off from the entrance first: otherwise guests seem to say things are missing
    const cut = g ? sim.guestSys.unreachable() : null;
    if (cut) sim.notify('cmp-cutoff', cut.text, 'warn', cut.focus, 300);
    if (c.restroom >= thr)
      sim.notify('cmp-restroom', h.restroom ? 'Guests can’t find a restroom nearby — build more around the zoo.' : 'Guests are complaining that there are no restrooms.', 'warn', undefined, 120);
    if (c.food >= thr)
      sim.notify('cmp-food', h.food ? 'Hungry guests can’t find food nearby — build snack kiosks around the zoo.' : 'Guests are hungry but there is nowhere to buy food.', 'warn', undefined, 120);
    if (c.drink >= thr)
      sim.notify('cmp-drink', h.drink ? 'Thirsty guests can’t find a drink nearby — build drinks kiosks around the zoo.' : 'Guests are thirsty — build a drinks kiosk.', 'warn', undefined, 120);
    if (c.bench >= thr) sim.notify('cmp-bench', 'Tired guests want benches to sit on.', 'info', undefined, 150);
    if (this.litterParties.size >= thr) this.reportLitter();
    if (c.noAnimals >= Math.max(2, thr * 0.5)) sim.notify('cmp-noanimals', 'Guests are disappointed: there are no animals to see yet!', 'warn', undefined, 150);
    if (c.price >= thr)
      sim.notify('cmp-price', `Many visitors turned away at the gate — they think about ${fmtMoney(sim.guestSys.fairPrice)} would be fair.`, 'warn', undefined, 150);
    this.clearComplaints();
  }

  /** Point at the worst litter spot, with advice that fits the staff and bins already there. */
  private reportLitter() {
    const sim = this.sim;
    const t = this.worstLitterTile;
    const focus = t >= 0 ? { x: ((t % MAP_W) + 0.5) * TILE, z: (((t / MAP_W) | 0) + 0.5) * TILE } : undefined;
    let groundskeepers = 0;
    for (const s of sim.staff.values()) if (s.role === 'groundskeeper') groundskeepers++;
    const text = !groundskeepers
      ? 'Guests are disgusted by the litter — hire a groundskeeper and put bins along the paths.'
      : t >= 0 && !sim.binNear[t]
        ? 'Guests are disgusted by the litter here — put litter bins along this path.'
        : 'Guests are disgusted by the litter here — your groundskeepers can’t keep up, hire another.';
    sim.notify('cmp-litter', text, 'warn', focus, 150);
  }
}
