// Zoo rating (0..100, smoothed) and the progressive objective list.

import { GAME_MINUTES_PER_SECOND, MAP_W, MINUTES_PER_DAY, TILE } from '../core/constants';
import type { GoalProgress, SimMessage } from '../core/contracts';
import { fmtMoney } from '../core/format';
import type { Objective } from '../core/types';
import { OBJECTS_BY_ID } from '../data/objects';
import { SPECIES, SPECIES_BY_ID } from '../data/species';
import { GATE_SPOT } from './guests';
import type { Simulation } from './simulation';

interface ObjectiveDef {
  id: string;
  text: string;
  reward: number;
  check: (sim: Simulation, p: Progress) => boolean;
  /** How far along it is (omitted for one-step goals). */
  progress?: (sim: Simulation, p: Progress) => GoalProgress;
}

const of = (current: number, target: number): GoalProgress => ({ current: Math.min(target, Math.floor(current)), target });
/** Guests on the best single day so far, today included. */
const bestDay = (s: Simulation, p: Progress) => Math.max(p.bestDayGuests, s.guestsToday);
/** Departing guests a day needs before their average happiness counts as that day's. */
const HAPPY_DAY_GUESTS = 20;
/** The happiest day so far in percent, or a note while no day has had enough departing guests to judge. */
const happyDay = (p: Progress, target: number): GoalProgress =>
  p.bestDayHappiness > 0 ? of(p.bestDayHappiness * 100, target) : { current: 0, target, waiting: 'No full day yet' };

// Rewards start small (the first week runs on ticket money with a little help) and grow
// with the goals; the mid-game goals keep something to aim for while the zoo expands.
const OBJECTIVES: ObjectiveDef[] = [
  { id: 'build_habitat', text: 'Build your first habitat (enclose an area with fences)', reward: 1000, check: (s) => s.world.habitats.size > 0 },
  { id: 'first_animal', text: 'Adopt your first animal', reward: 1500, check: (s) => s.animals.size > 0 },
  { id: 'hire_keeper', text: 'Hire a keeper to feed your animals', reward: 500, check: (s) => s.keeperCount() > 0 },
  { id: 'food_stand', text: 'Build a snack or drinks kiosk', reward: 1000, check: (_s, p) => p.has.food || p.has.drink },
  { id: 'restrooms', text: 'Build restrooms for your guests', reward: 1000, check: (_s, p) => p.has.restroom },
  { id: 'guests_25', text: 'Welcome 25 guests in a single day', reward: 1500, check: (s) => s.guestsToday >= 25, progress: (s, p) => of(bestDay(s, p), 25) },
  { id: 'species_3', text: 'Exhibit 3 different species', reward: 2500, check: (_s, p) => p.speciesCount >= 3, progress: (_s, p) => of(p.speciesCount, 3) },
  { id: 'happy_10', text: 'Have 10 animals with happiness above 70%', reward: 2500, check: (_s, p) => p.happyAnimals >= 10, progress: (_s, p) => of(p.happyAnimals, 10) },
  { id: 'guests_50', text: 'Welcome 50 guests in a single day', reward: 2500, check: (s) => s.guestsToday >= 50, progress: (s, p) => of(bestDay(s, p), 50) },
  { id: 'baby', text: 'Have a baby animal born in your zoo', reward: 3000, check: (_s, p) => p.counters.births > 0 },
  { id: 'rating_60', text: 'Reach a zoo rating of 60', reward: 4000, check: (s) => s.rating >= 60, progress: (s) => of(s.rating, 60) },
  { id: 'species_6', text: 'Exhibit 6 different species', reward: 5000, check: (_s, p) => p.speciesCount >= 6, progress: (_s, p) => of(p.speciesCount, 6) },
  { id: 'visitors_1000', text: 'Welcome 1,000 visitors in total', reward: 3000, check: (s) => s.totalVisitors >= 1000, progress: (s) => of(s.totalVisitors, 1000) },
  { id: 'gift_shop', text: 'Build a gift shop', reward: 2000, check: (_s, p) => p.has.gift },
  { id: 'profit_3000', text: 'Make $3,000 running profit in one day', reward: 5000, check: (_s, p) => p.bestRunning >= 3000, progress: (_s, p) => of(Math.max(0, p.bestRunning), 3000) },
  { id: 'guests_150', text: 'Welcome 150 guests in a single day', reward: 5000, check: (s) => s.guestsToday >= 150, progress: (s, p) => of(bestDay(s, p), 150) },
  { id: 'species_8', text: 'Exhibit 8 different species', reward: 8000, check: (_s, p) => p.speciesCount >= 8, progress: (_s, p) => of(p.speciesCount, 8) },
  { id: 'visitors_2500', text: 'Welcome 2,500 visitors in total', reward: 5000, check: (s) => s.totalVisitors >= 2500, progress: (s) => of(s.totalVisitors, 2500) },
  { id: 'guest_happy_75', text: 'Reach 75% guest happiness for a day', reward: 6000, check: (_s, p) => p.bestDayHappiness >= 0.75, progress: (_s, p) => happyDay(p, 75) },
  { id: 'rating_70', text: 'Reach a zoo rating of 70', reward: 8000, check: (s) => s.rating >= 70, progress: (s) => of(s.rating, 70) },
  { id: 'habitats_80', text: 'Get 8 habitats to 80% suitability', reward: 6000, check: (_s, p) => p.goodHabitats >= 8, progress: (_s, p) => of(p.goodHabitats, 8) },
  { id: 'money_100k', text: 'Have $100,000 in the bank', reward: 10000, check: (s) => s.money >= 100000, progress: (s) => of(Math.max(0, s.money), 100000) },
  { id: 'rating_80', text: 'Reach a zoo rating of 80', reward: 15000, check: (s) => s.rating >= 80, progress: (s) => of(s.rating, 80) },
  { id: 'species_10', text: 'Exhibit 10 different species', reward: 20000, check: (_s, p) => p.speciesCount >= 10, progress: (_s, p) => of(p.speciesCount, 10) },
  { id: 'visitors_5000', text: 'Welcome 5,000 visitors in total', reward: 20000, check: (s) => s.totalVisitors >= 5000, progress: (s) => of(s.totalVisitors, 5000) },
];

export function createObjectives(): Objective[] {
  return OBJECTIVES.map((o) => ({ id: o.id, text: o.text, done: false, reward: o.reward }));
}

/**
 * Guests only complain while they are in the zoo, and some complaints only at the busiest hour,
 * so one that comes back within a day and a half (simulated seconds) is the same problem as
 * the day before: a toast when it starts, then the log.
 */
const COMPLAINT_LASTS = (1.5 * MINUTES_PER_DAY) / GAME_MINUTES_PER_SECOND;

/** Guest complaint counters (reset after each report window). */
export interface Complaints {
  restroom: number;
  food: number;
  drink: number;
  bench: number;
  noAnimals: number;
  price: number;
}

/** What Progress keeps in a save (fields added later are optional). */
export interface ProgressSave {
  births?: number;
  ratingAcc?: number;
  complaintAcc?: number;
  /** Pregnancies announced so far. */
  pregnancies?: number;
  /** Most guests welcomed in one completed day. */
  bestDayGuests?: number;
  /** Species that have had a baby here. */
  bredSpecies?: string[];
  /** Best running result (tickets, shops, donations less running costs) of one closed day. */
  bestRunning?: number;
  /** Best average happiness (0..1) of the guests who left on one closed day. */
  bestDayHappiness?: number;
  /** Warnings already shown once as a toast (see Simulation.notifyFirst). */
  announced?: string[];
}

export class Progress {
  counters = { births: 0, pregnancies: 0 };
  /** Most guests welcomed in one completed day. */
  bestDayGuests = 0;
  /** Best running result of one closed day. */
  bestRunning = 0;
  /**
   * Best average happiness of the guests leaving on one closed day (days with a handful of guests
   * don't count); 0 until such a day has closed, as in saves from before it was kept.
   */
  bestDayHappiness = 0;
  /** Today's departing guests: summed happiness and head count. */
  private leftHappy = 0;
  private leftCount = 0;
  /** Habitats whose animals all find it 80% suitable or better (refreshed with the rating). */
  goodHabitats = 0;
  /** Species that have had a baby in this zoo. */
  readonly bredSpecies = new Set<string>();
  /** Warnings this zoo has already shown once as a toast: later ones go to the log only. */
  readonly announced = new Set<string>();
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
    this.counters = { births: 0, pregnancies: 0 };
    this.bestDayGuests = 0;
    this.bestRunning = 0;
    this.bestDayHappiness = 0;
    this.leftHappy = this.leftCount = 0;
    this.goodHabitats = 0;
    this.bredSpecies.clear();
    this.announced.clear();
    this.ratingAcc = 0;
    this.complaintAcc = 0;
    this.facilitiesRev = -1;
    this.clearComplaints();
  }

  serialize(): ProgressSave {
    return {
      births: this.counters.births,
      ratingAcc: this.ratingAcc,
      complaintAcc: this.complaintAcc,
      pregnancies: this.counters.pregnancies,
      bestDayGuests: this.bestDayGuests,
      bredSpecies: Array.from(this.bredSpecies),
      bestRunning: this.bestRunning,
      bestDayHappiness: this.bestDayHappiness,
      announced: Array.from(this.announced),
    };
  }
  /** `bestRunning`: the best closed day in the saved ledger, for saves that did not keep it. */
  load(d: ProgressSave, bestRunning = 0) {
    this.counters.births = d.births ?? 0;
    // older saves: every birth followed a pregnancy
    this.counters.pregnancies = d.pregnancies ?? this.counters.births;
    this.bestDayGuests = d.bestDayGuests ?? 0;
    this.bestRunning = d.bestRunning ?? bestRunning;
    this.bestDayHappiness = d.bestDayHappiness ?? 0;
    this.leftHappy = this.leftCount = 0;
    this.goodHabitats = 0;
    this.bredSpecies.clear();
    for (const id of d.bredSpecies ?? []) this.bredSpecies.add(id);
    this.announced.clear();
    for (const key of d.announced ?? []) this.announced.add(key);
    this.ratingAcc = d.ratingAcc ?? 0;
    this.complaintAcc = d.complaintAcc ?? 0;
    this.facilitiesRev = -1;
    this.clearComplaints();
  }

  /**
   * Saves from before the species that bred here were kept: young still with
   * their mother and the births in the saved message log tell which species
   * have had a baby, so their next birth does not toast as the first again.
   */
  recallBredSpecies(messages: readonly SimMessage[]) {
    for (const a of this.sim.animals.values()) if (a.mother) this.bredSpecies.add(a.speciesId);
    for (const m of messages) {
      const sp = SPECIES.find((sp) => m.text.includes(` the ${sp.name} gave birth`));
      if (sp) this.bredSpecies.add(sp.id);
    }
  }

  private clearComplaints() {
    const c = this.complaints;
    c.restroom = c.food = c.drink = c.bench = c.noAnimals = c.price = 0;
    this.litterParties.clear();
    this.worstLitterTile = -1;
    this.worstLitter = 0;
  }

  /** Midnight: remember the best day for the guest and profit goals. */
  closeDay(guests: number, running: number) {
    this.bestDayGuests = Math.max(this.bestDayGuests, guests);
    this.bestRunning = Math.max(this.bestRunning, running);
    if (this.leftCount >= HAPPY_DAY_GUESTS) this.bestDayHappiness = Math.max(this.bestDayHappiness, this.leftHappy / this.leftCount);
    this.leftHappy = this.leftCount = 0;
  }

  /** A guest went home this happy (0..1). */
  noteDeparture(happiness: number) {
    this.leftHappy += happiness;
    this.leftCount++;
  }

  /** current / target of an objective (null for unknown or one-step goals). */
  goalProgress(id: string): GoalProgress | null {
    const def = OBJECTIVES.find((d) => d.id === id);
    if (!def?.progress) return null;
    this.refreshFacilities();
    return def.progress(this.sim, this);
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
    let held = 0;
    const species = new Set<string>();
    let appeal = 0;
    for (const a of sim.animals.values()) {
      ah += a.happiness * (0.6 + 0.4 * a.health);
      n++;
      held += sim.collectionWeight(a);
      if (!species.has(a.speciesId)) {
        species.add(a.speciesId);
        appeal += SPECIES_BY_ID[a.speciesId]?.appeal ?? 5;
      }
    }
    const welfare = n ? ah / n : 0;
    const diversity = 1 - Math.exp(-species.size / 3.5);
    // cramming more animals into a full habitat adds nothing
    const collection = 1 - Math.exp(-held / 18);
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
      this.refreshCounts();
      this.checkObjectives();
    }
    this.complaintAcc += dt;
    if (this.complaintAcc >= 15) {
      this.complaintAcc -= 15;
      this.reportComplaints();
    }
  }

  /** Species, happy animals and well-suited habitats, for the objectives. */
  private refreshCounts() {
    const species = new Set<string>();
    let happy = 0;
    for (const a of this.sim.animals.values()) {
      species.add(a.speciesId);
      if (a.happiness > 0.7) happy++;
    }
    this.speciesCount = species.size;
    this.happyAnimals = happy;
    this.goodHabitats = this.countGoodHabitats();
  }

  /**
   * A save from before these goals existed: the ones the zoo has already reached are
   * marked done without a reward, so Continue doesn't pop a pile of goal cards.
   */
  settleNewGoals(ids: readonly string[]) {
    const sim = this.sim;
    this.refreshFacilities();
    this.refreshCounts();
    for (const o of sim.objectives) {
      if (o.done || !ids.includes(o.id)) continue;
      if (OBJECTIVES.find((d) => d.id === o.id)?.check(sim, this)) o.done = true;
    }
  }

  private countGoodHabitats(): number {
    const sim = this.sim;
    let n = 0;
    for (const hab of sim.world.habitats.values()) {
      const pop = sim.population(hab.id);
      if (!pop.count.size) continue;
      let ok = true;
      for (const sid of pop.count.keys()) if ((sim.evalFor(hab.id, sid)?.score ?? 0) < 0.8) ok = false;
      if (ok) n++;
    }
    return n;
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
    // ongoing needs: one toast when the complaints start, then log lines while they last
    if (c.restroom >= thr)
      sim.remind('cmp-restroom', h.restroom ? 'Guests can’t find a restroom nearby — build more around the zoo.' : 'Guests are complaining that there are no restrooms.', 'warn', undefined, 120, COMPLAINT_LASTS);
    if (c.food >= thr)
      sim.remind('cmp-food', h.food ? 'Hungry guests can’t find food nearby — build snack kiosks around the zoo.' : 'Guests are hungry but there is nowhere to buy food.', 'warn', undefined, 120, COMPLAINT_LASTS);
    if (c.drink >= thr)
      sim.remind('cmp-drink', h.drink ? 'Thirsty guests can’t find a drink nearby — build drinks kiosks around the zoo.' : 'Guests are thirsty — build a drinks kiosk.', 'warn', undefined, 120, COMPLAINT_LASTS);
    if (c.bench >= thr) sim.remind('cmp-bench', 'Tired guests want benches to sit on.', 'info', undefined, 150, COMPLAINT_LASTS);
    if (this.litterParties.size >= thr) this.reportLitter();
    if (c.noAnimals >= Math.max(2, thr * 0.5)) sim.notify('cmp-noanimals', 'Guests are disappointed: there are no animals to see yet!', 'warn', undefined, 150);
    if (c.price >= thr)
      sim.remind('cmp-price', `Many visitors turned away at the gate — they think about ${fmtMoney(sim.guestSys.fairPrice)} would be fair.`, 'warn', GATE_SPOT, 150, COMPLAINT_LASTS);
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
    sim.remind('cmp-litter', text, 'warn', focus, 150, COMPLAINT_LASTS);
  }
}
