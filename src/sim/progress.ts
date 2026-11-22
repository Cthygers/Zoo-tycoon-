// Zoo rating (0..100, smoothed) and the progressive objective list.

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
  litter: number;
  noAnimals: number;
  price: number;
}

export class Progress {
  counters = { births: 0 };
  has = { food: false, drink: false, restroom: false, bench: false, bin: false, gift: false };
  speciesCount = 0;
  happyAnimals = 0;
  complaints: Complaints = { restroom: 0, food: 0, drink: 0, bench: 0, litter: 0, noAnimals: 0, price: 0 };
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
    c.restroom = c.food = c.drink = c.bench = c.litter = c.noAnimals = c.price = 0;
  }

  private refreshFacilities() {
    const w = this.sim.world;
    if (this.facilitiesRev === w.revision) return;
    this.facilitiesRev = w.revision;
    const h = this.has;
    h.food = h.drink = h.restroom = h.bench = h.bin = h.gift = false;
    for (const o of w.objects.values()) {
      const d = OBJECTS_BY_ID[o.defId];
      if (!d) continue;
      if (d.shop?.kind === 'food') h.food = true;
      if (d.shop?.kind === 'drink') h.drink = true;
      if (d.shop?.kind === 'icecream') h.food = h.food || false;
      if (d.shop?.kind === 'gift') h.gift = true;
      if (d.restroom) h.restroom = true;
      if (d.bench) h.bench = true;
      if (d.bin) h.bin = true;
    }
  }

  /** Instantaneous rating target 0..100 from the current zoo. */
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
    let gh = 0;
    for (const g of sim.guests.values()) gh += g.happiness;
    const guestHappy = sim.guests.size ? 0.5 * (gh / sim.guests.size) + 0.5 * sim.satisfaction : sim.satisfaction;
    const animalPart = n ? (ah / n) * 30 * Math.min(1, 0.5 + n / 10) : 0;
    const variety = Math.min(1, species.size / 8) * 12 + (species.size ? Math.min(1, appeal / species.size / 10) * 4 : 0);
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
    const scenery = pathTiles ? Math.min(1, sc / pathTiles / 2) * 10 : 0;
    let trash = 0;
    for (const l of sim.litter.values()) if (l.kind === 'trash') trash++;
    const cleanliness = (1 - Math.min(1, trash / (6 + pathTiles * 0.06))) * 10;
    const h = this.has;
    const fac = ((h.food ? 1 : 0) + (h.drink ? 1 : 0) + (h.restroom ? 1 : 0) + (h.bench ? 1 : 0) + (h.bin ? 1 : 0)) / 5;
    const facilities = fac * 14;
    const viewable = this.viewablePenalty();
    const total = animalPart + guestHappy * 20 + variety + scenery + cleanliness + facilities - viewable;
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
      sim.events.emit('objectiveCompleted', { id: o.id, text: o.text, reward: o.reward });
      sim.notify(null, `Goal complete: ${o.text} (+$${o.reward.toLocaleString('en-US')})`, 'good');
    }
  }

  private reportComplaints() {
    const sim = this.sim;
    const c = this.complaints;
    const g = sim.guests.size;
    const thr = Math.max(3, g * 0.08);
    if (c.restroom >= thr) sim.notify('cmp-restroom', 'Guests are complaining that they can’t find a restroom.', 'warn', undefined, 120);
    if (c.food >= thr) sim.notify('cmp-food', 'Guests are hungry but there is nowhere to buy food.', 'warn', undefined, 120);
    if (c.drink >= thr) sim.notify('cmp-drink', 'Guests are thirsty — build a drinks kiosk.', 'warn', undefined, 120);
    if (c.bench >= thr) sim.notify('cmp-bench', 'Tired guests want benches to sit on.', 'info', undefined, 150);
    if (c.litter >= thr) sim.notify('cmp-litter', 'Guests are disgusted by the litter — add bins and hire a groundskeeper.', 'warn', undefined, 150);
    if (c.noAnimals >= Math.max(2, thr * 0.5)) sim.notify('cmp-noanimals', 'Guests are disappointed: there are no animals to see yet!', 'warn', undefined, 150);
    if (c.price >= thr) sim.notify('cmp-price', 'Many visitors turned away at the gate — admission seems too expensive.', 'warn', undefined, 150);
    this.clearComplaints();
  }
}
