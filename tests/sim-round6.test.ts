// Focused tests for the round-6 fixes: the gate closes when the entrance is cut off or
// nothing is on view (PT3-1), saved messages and capacity after Continue (PT3-8), running
// costs so far today (PT3-7) and goal progress (PT3-6).

import { describe, expect, it } from 'vitest';
import { TILE, WATER_LEVEL } from '../src/core/constants';
import type { SimSave } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { PathType, Terrain } from '../src/core/types';
import { buildDemoZoo } from '../src/demo';
import { createSimulation } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';
import { EX, HAB, buildZoo, buyHerd, hire, newSim } from './sim-helpers';

type Log = ReturnType<typeof newSim>['log'];
const notes = (log: Log) => log.filter((e) => e.type === 'notify').map((e) => e.payload as { text: string; kind: string; focus?: { x: number; z: number }; logOnly?: boolean });
const texts = (log: Log) => notes(log).map((n) => n.text);

/** Run at speed 3 until the clock reaches `minute` on `day` (default today). */
function runTo(sim: Simulation, minute: number, day = sim.day) {
  sim.setSpeed(3);
  while (sim.day < day || (sim.day === day && sim.minuteOfDay < minute)) sim.update(0.1);
}

describe('the gate (PT3-1)', () => {
  it('sells no tickets while no animals are on view, and says why', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    hire(sim);
    runTo(sim, 13 * 60);
    expect(sim.guestsToday).toBe(0);
    expect(sim.today.admissions).toBe(0);
    expect(sim.stats().gateClosed).toBe('No animals on view');
    expect(texts(log).some((t) => /gate stays closed until there are animals to see/.test(t))).toBe(true);
    buyHerd(sim, 'zebra', 3);
    runTo(sim, 15 * 60);
    expect(sim.stats().gateClosed).toBeNull();
    expect(sim.guestsToday).toBeGreaterThan(0);
  }, 30_000);

  it('a bulldoze that cuts the plaza off asks first, closes the gate, refunds the stranded and reopens when reconnected', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 4);
    hire(sim);
    const cutRect = { x0: EX - 1, z0: 65, x1: EX + 1, z1: 65 };
    // a cut elsewhere (a stub of the viewing path) is only the usual warning
    const stub = sim.bulldoze({ x0: HAB.x0 - 2, z0: HAB.z1 + 2, x1: HAB.x0 - 2, z1: HAB.z1 + 2 }, true);
    expect(stub.cutsEntrance).toBeUndefined();
    expect(stub.severity).toBeUndefined();
    const dry = sim.bulldoze(cutRect, true);
    expect(dry.ok).toBe(true);
    expect(dry.cutsEntrance).toBe(true);
    expect(dry.severity).toBe('confirm');
    expect(dry.warning).toMatch(/^Cuts the entrance off from every exhibit/);
    runTo(sim, 10 * 60);
    const inZoo = sim.guests.size;
    expect(inZoo).toBeGreaterThan(5);
    const admissions = sim.today.admissions;
    expect(sim.bulldoze(cutRect).ok).toBe(true);
    // let the parties at the plaza notice, then a few game hours
    runTo(sim, 14 * 60);
    expect(sim.stats().gateClosed).toBe('Entrance path cut');
    const arrivals = sim.guestsToday;
    runTo(sim, 16 * 60);
    expect(sim.guestsToday).toBe(arrivals); // nobody pays to get in any more
    // the parties that came in after the cut and saw nothing got their tickets back
    expect(sim.today.admissions).toBeLessThan(admissions + 1);
    const cut = notes(log).filter((n) => /entrance path is cut — reconnect it/.test(n.text));
    expect(cut.length).toBeGreaterThan(0);
    // pointed at the gap, not at a habitat
    expect(Math.floor(cut[0].focus!.x / TILE)).toBeGreaterThanOrEqual(EX - 1);
    expect(Math.floor(cut[0].focus!.x / TILE)).toBeLessThanOrEqual(EX + 1);
    expect(Math.floor(cut[0].focus!.z / TILE)).toBe(65);
    expect(texts(log).some((t) => /can’t reach Habitat/.test(t))).toBe(false);
    expect(sim.guestSys.unreachable()?.text).toMatch(/entrance path is cut/);
    // nobody is left standing at the plaza
    for (const g of sim.guests.values()) if (Math.floor(g.z / TILE) >= 66 && !g.leader) expect(g.goal).toBe('leave');
    // reconnect: the gate opens by itself
    expect(sim.placePaths([{ x: EX, z: 65 }], PathType.Paved).ok).toBe(true);
    runTo(sim, 17 * 60);
    expect(sim.stats().gateClosed).toBeNull();
    expect(sim.guestsToday).toBeGreaterThan(arrivals);
    expect(texts(log).some((t) => /gate is open again/.test(t))).toBe(true);
  }, 60_000);

  it('refunds exactly what a stranded party paid', () => {
    const { sim } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    hire(sim);
    runTo(sim, 8 * 60 + 5);
    sim.admissionPrice = 20;
    const lead = sim.guestSys.spawnParty()!;
    expect(lead).toBeTruthy();
    const party = [lead, ...lead.party.map((id) => sim.guests.get(id)!)];
    const paid = party.reduce((a, g) => a + g.paid, 0);
    expect(paid).toBe(party.reduce((a, g) => a + (g.appearance.child ? 10 : 20), 0));
    const before = sim.today.admissions;
    expect(sim.bulldoze({ x0: EX - 1, z0: 65, x1: EX + 1, z1: 65 }).ok).toBe(true);
    for (let i = 0; i < 30; i++) sim.update(0.1);
    expect(lead.goal).toBe('leave');
    expect(sim.today.admissions).toBe(before - paid);
  });

  it('names the habitat that is really cut off when the gate still reaches others', () => {
    const { sim } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    hire(sim);
    // a second habitat west of the avenue on its own little path, not joined to the others
    const rect = { x0: 20, z0: 58, x1: 26, z1: 62 };
    sim.bulldoze({ x0: rect.x0 - 1, z0: rect.z0 - 1, x1: rect.x1 + 1, z1: rect.z1 + 2 });
    expect(sim.placePaths(Array.from({ length: 7 }, (_, i) => ({ x: 20 + i, z: 64 })), PathType.Paved).ok).toBe(true);
    expect(sim.placeFences(sim.world.edgesAroundRect(rect), 2).ok).toBe(true);
    const hab = sim.world.habitatAt(22, 60)!;
    expect(hab.viewTiles.length).toBeGreaterThan(0);
    expect(sim.buyAnimal('gazelle', 22.5 * TILE, 60.5 * TILE).ok).toBe(true);
    sim.update(0.1);
    expect(sim.guestSys.gateState()).toBe('open');
    const cut = sim.guestSys.unreachable()!;
    expect(cut.text).toBe(`Guests can’t reach ${hab.name} — connect its viewing path to the paths from the entrance.`);
  });
});

describe('after Continue (PT3-8)', () => {
  it('keeps the latest messages and the guest capacity in the save', () => {
    const { sim } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    hire(sim);
    runTo(sim, 12 * 60);
    for (let i = 0; i < 60; i++) sim.notify(null, `Message ${i}`, i % 2 ? 'warn' : 'info', { x: i, z: 2 * i });
    sim.logMessage('Goal complete: test', 'good');
    const cap = sim.guestSys.capacity;
    expect(cap).toBeGreaterThan(40);
    const kept = sim.messages();
    expect(kept.length).toBe(50);
    expect(kept.at(-1)).toMatchObject({ text: 'Goal complete: test', kind: 'good', logOnly: true, day: 1, minute: Math.floor(sim.minuteOfDay) });
    expect(kept.find((m) => m.text === 'Message 59')).toMatchObject({ kind: 'warn', focus: { x: 59, z: 118 } });
    runTo(sim, 21 * 60);
    const save = JSON.parse(JSON.stringify(sim.serialize())) as SimSave;
    const events = new EventBus();
    const restored = createSimulation(events, 1) as Simulation;
    let seenOnReset: number | undefined;
    events.on('worldReset', () => (seenOnReset = restored.messages().length));
    restored.load(save);
    expect(seenOnReset).toBe(50);
    expect(restored.messages().map((m) => m.text)).toEqual(sim.messages().map((m) => m.text));
    // at night, before the gates open again
    expect(restored.guestSys.capacity).toBe(cap);
    expect(restored.progress.targetRating()).toBeCloseTo(sim.progress.targetRating(), 1);
  }, 30_000);

  it('loads saves from before messages, best day and full-zoo counts were kept', () => {
    const { sim } = newSim(11);
    buildZoo(sim);
    const save = JSON.parse(JSON.stringify(sim.serialize())) as SimSave & Record<string, unknown>;
    delete save.messages;
    delete save.turnedAwayToday;
    save.progress = { births: 2, ratingAcc: 0, complaintAcc: 0 };
    const restored = createSimulation(new EventBus(), 1) as Simulation;
    restored.load(save);
    expect(restored.messages()).toEqual([]);
    expect(restored.stats().turnedAwayToday).toBe(0);
    expect(restored.progress.counters.pregnancies).toBe(2);
    expect(restored.objectiveProgress('guests_150')).toEqual({ current: 0, target: 150 });
  });
});

describe('running costs so far today (PT3-7)', () => {
  it('accrue pro rata through the day and match what midnight books', () => {
    const { sim } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    runTo(sim, 0, 2);
    hire(sim); // at midnight: a full day's wage
    runTo(sim, 12 * 60);
    const c = sim.runningCosts();
    expect(c.fraction).toBeCloseTo(0.5, 2);
    expect(c.day.wages).toBe(sim.staffWage('keeper') + sim.staffWage('groundskeeper'));
    expect(c.soFar.wages).toBeCloseTo(c.day.wages / 2, -1);
    expect(c.soFar.food).toBe(Math.round(c.day.food * c.fraction));
    expect(c.day.total).toBe(c.day.wages + c.day.food + c.day.upkeep);
    expect(c.soFar.total).toBe(c.soFar.wages + c.soFar.food + c.soFar.upkeep);
    const day = sim.day;
    runTo(sim, 0, day + 1);
    const booked = sim.ledger.at(-1)!;
    expect(booked.salaries).toBe(c.day.wages);
    expect(booked.food).toBe(c.day.food);
    expect(booked.upkeep).toBe(c.day.upkeep);
  }, 60_000);

  it('counts a dismissal paid today in full', () => {
    const { sim } = newSim(11);
    buildZoo(sim);
    runTo(sim, 0, 2);
    hire(sim);
    runTo(sim, 6 * 60);
    const keeper = [...sim.staff.values()].find((s) => s.role === 'keeper')!;
    const owed = sim.staffSettlement(keeper.id);
    sim.fireStaff(keeper.id);
    const c = sim.runningCosts();
    expect(c.soFar.wages).toBe(owed + Math.round(sim.staffWage('groundskeeper') * c.fraction));
    expect(c.day.wages).toBe(owed + sim.staffWage('groundskeeper'));
  });
});

describe('goal progress (PT3-6)', () => {
  it('reports current / target, the best day for guest goals, and null for one-step goals', () => {
    const { sim } = newSim(11);
    expect(sim.objectiveProgress('restrooms')).toBeNull();
    expect(sim.objectiveProgress('no_such_goal')).toBeNull();
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    hire(sim);
    runTo(sim, 0, 2);
    const best = sim.ledger.length ? sim.progress.bestDayGuests : 0;
    expect(best).toBeGreaterThan(0);
    runTo(sim, 9 * 60);
    expect(sim.guestsToday).toBeLessThan(best);
    expect(sim.objectiveProgress('guests_150')).toEqual({ current: best, target: 150 });
    expect(sim.objectiveProgress('species_3')).toEqual({ current: 1, target: 3 });
    expect(sim.objectiveProgress('money_100k')!.current).toBe(Math.floor(sim.money));
    // never past the target
    sim.money = 2e6;
    expect(sim.objectiveProgress('money_100k')).toEqual({ current: 100000, target: 100000 });
    // the best day survives a save
    const restored = createSimulation(new EventBus(), 1) as Simulation;
    restored.load(sim.serialize());
    expect(restored.progress.bestDayGuests).toBe(best);
  }, 60_000);
});

describe('flooding a land habitat (PT3-4)', () => {
  it('warns before painting away the dry land of animals that can’t swim', () => {
    const { sim } = newSim(11);
    const hid = buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    const name = sim.world.habitats.get(hid)!.name;
    const pond = sim.paintTerrain({ x0: 31, z0: 45, x1: 33, z1: 46 }, Terrain.DeepWater, true);
    expect(pond.ok).toBe(true);
    expect(pond.warning).toBeUndefined();
    const flood = sim.paintTerrain(HAB, Terrain.DeepWater, true);
    expect(flood.ok).toBe(true);
    expect(flood.warning).toBe(`Zebras can’t swim — leave dry land in ${name}`);
    expect(flood.severity).toBe('confirm');
    expect(flood.reason).toMatch(/skipped: Cannot flood under objects/);
    // the habitat report says so too once it is flooded
    expect(sim.paintTerrain(HAB, Terrain.DeepWater).ok).toBe(true);
    const zebra = sim.habitatReport(hid)!.suitability.find((s) => s.speciesId === 'zebra')!;
    expect(zebra.issues[0]).toMatch(/^Too little dry land \(\d+%\) — zebras can’t swim/);
  });

  it('holds stranded zebras on the ground that is left, never on the pond bed', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    hire(sim);
    const ids = buyHerd(sim, 'zebra', 4);
    expect(sim.paintTerrain(HAB, Terrain.DeepWater).ok).toBe(true);
    runTo(sim, 14 * 60);
    for (const id of ids) {
      const a = sim.animals.get(id)!;
      const t = sim.world.tileOfWorld(a.x, a.z);
      expect(sim.world.getTerrain(t.x, t.z)).not.toBe(Terrain.DeepWater);
      expect(a.y).toBeGreaterThan(WATER_LEVEL - 0.6);
    }
    expect(texts(log).some((t) => /can’t reach their water/.test(t))).toBe(false);
  }, 30_000);

  it('with no ground at all they tread water, lose condition and the player is told', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    hire(sim);
    const rect = { x0: 20, z0: 58, x1: 24, z1: 62 };
    sim.bulldoze({ x0: rect.x0 - 1, z0: rect.z0 - 1, x1: rect.x1 + 1, z1: rect.z1 + 1 });
    expect(sim.placeFences(sim.world.edgesAroundRect(rect), 2).ok).toBe(true);
    const hab = sim.world.habitatAt(22, 60)!;
    for (const x of [21, 23]) expect(sim.buyAnimal('zebra', (x + 0.5) * TILE, 60.5 * TILE).ok).toBe(true);
    const zebras = [...sim.animals.values()].filter((a) => a.habitatId === hab.id);
    expect(sim.paintTerrain(rect, Terrain.DeepWater).ok).toBe(true);
    runTo(sim, 20 * 60);
    for (const a of zebras) {
      expect(a.y).toBe(WATER_LEVEL);
      expect(a.action).toBe('swim');
      expect(a.health).toBeLessThan(0.9);
      expect(a.needs.thirst).toBeGreaterThan(0.3); // drinks where it is
    }
    expect(texts(log)).toContain(`${hab.name} has no dry land for the zebras — paint some ground they can stand on.`);
    expect(texts(log).some((t) => /can’t reach their water/.test(t))).toBe(false);
    // given ground again, they climb out
    expect(sim.paintTerrain({ x0: 20, z0: 58, x1: 24, z1: 59 }, Terrain.DryGrass).ok).toBe(true);
    runTo(sim, 21 * 60);
    for (const a of zebras) {
      expect(a.action).not.toBe('swim');
      expect(sim.world.getTerrain(Math.floor(a.x / TILE), Math.floor(a.z / TILE))).not.toBe(Terrain.DeepWater);
    }
  }, 30_000);
});

describe('pregnancy and birth notices (round-5 verifier)', () => {
  it('toast only the zoo’s first pregnancy and each species’ first baby; the rest go to the log', () => {
    const { sim, log } = newSim(5);
    sim.money = 1e6;
    buildZoo(sim);
    hire(sim);
    buyHerd(sim, 'zebra', 4);
    sim.setSpeed(3);
    while (sim.day <= 20 && sim.progress.counters.births < 2) sim.update(0.5);
    expect(sim.progress.counters.births).toBeGreaterThanOrEqual(2);
    const expecting = notes(log).filter((n) => /is expecting!/.test(n.text));
    const births = notes(log).filter((n) => /gave birth/.test(n.text));
    expect(expecting.length).toBeGreaterThanOrEqual(2);
    expect(expecting.filter((n) => !n.logOnly).length).toBe(1);
    expect(expecting[0].logOnly).toBeUndefined();
    expect(births[0].logOnly).toBeUndefined();
    expect(births.slice(1).every((n) => n.logOnly)).toBe(true);
    // log-only messages still say where it happened
    expect(births[1].focus).toBeDefined();
    // a reloaded zoo remembers which species have bred
    const restored = createSimulation(new EventBus(), 1) as Simulation;
    restored.load(sim.serialize());
    expect([...restored.progress.bredSpecies]).toEqual(['zebra']);
    expect(restored.progress.counters.pregnancies).toBe(sim.progress.counters.pregnancies);
  }, 60_000);
});

describe('crowding (PT3-3)', () => {
  /** The playtest's starter habitat: 30 tiles of savanna with a trough, a hay feeder and 3 zebras. */
  function starter() {
    const ctx = newSim(11);
    const { sim } = ctx;
    sim.money = 1e6;
    sim.bulldoze({ x0: 26, z0: 57, x1: 33, z1: 63 });
    expect(sim.placeFences(sim.world.edgesAroundRect({ x0: 27, z0: 58, x1: 32, z1: 62 }), 1).ok).toBe(true);
    expect(sim.paintTerrain({ x0: 27, z0: 58, x1: 32, z1: 62 }, Terrain.DryGrass).ok).toBe(true);
    expect(sim.placeObject('water_trough', 28, 59, 0).ok).toBe(true);
    expect(sim.placeObject('feeder_hay', 31, 61, 0).ok).toBe(true);
    for (const x of [29, 30, 31]) expect(sim.buyAnimal('zebra', x * 2 + 1, 60 * 2 + 1).ok).toBe(true);
    expect(sim.hireStaff('keeper', 36 * 2 + 1, 63 * 2 + 1).ok).toBe(true);
    expect(sim.hireStaff('vet', 36 * 2 + 1, 64 * 2 + 1).ok).toBe(true);
    return { ...ctx, hid: sim.world.habitatAt(28, 60)!.id };
  }
  const zebras = (sim: Simulation) => [...sim.animals.values()].filter((a) => a.speciesId === 'zebra');
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  it('asks before an adoption packs a habitat past 150% of what it holds', () => {
    const { sim } = starter();
    // 3 zebras need 60 tiles of the 30: a 4th is far too many
    const r = sim.buyAnimal('zebra', 29 * 2 + 1, 61 * 2 + 1, true);
    expect(r.ok).toBe(true);
    expect(r.severity).toBe('confirm');
    expect(r.warning).toMatch(/^It would be far too crowded here \(30 tiles, needs 80\)/);
    // a roomy habitat: no question
    const { sim: roomy } = newSim(11);
    buildZoo(roomy);
    const ok = roomy.buyAnimal('zebra', (HAB.x0 + 3) * TILE, (HAB.z0 + 6) * TILE, true);
    expect(ok.severity).toBeUndefined();
  });

  it('cramming 16 zebras into 30 tiles stresses them, makes them ill or hurt, stops breeding and never raises the rating', () => {
    const { sim, hid } = starter();
    runTo(sim, 12 * 60, 2);
    const save = sim.serialize();
    const events = new EventBus();
    const log: { text: string }[] = [];
    events.on('notify', (n) => log.push(n));
    const crammed = createSimulation(events, 1) as Simulation;
    crammed.load(save);
    const spots = [[29, 59], [30, 59], [31, 59], [32, 59], [29, 60], [30, 60], [32, 60], [27, 61], [28, 61], [29, 61], [30, 61], [27, 62], [28, 62]];
    for (const [x, z] of spots) expect(crammed.buyAnimal('zebra', x * 2 + 1, z * 2 + 1).ok).toBe(true);
    expect(zebras(crammed).length).toBe(16);
    const report = crammed.habitatReport(hid)!.suitability[0];
    expect(report.issues[0]).toMatch(/^Too crowded \(30 tiles, needs 320\) — the animals get stressed and sick/);
    expect(report.score).toBeLessThan(0.5);
    for (const s of [sim, crammed]) runTo(s, 12 * 60, 5);
    expect(mean(zebras(crammed).map((a) => a.happiness))).toBeLessThan(0.45);
    expect(mean(zebras(crammed).map((a) => a.happiness))).toBeLessThan(mean(zebras(sim).map((a) => a.happiness)) - 0.15);
    expect(log.some((n) => /hurt in a scuffle — Habitat \d+ is far too crowded|is sick/.test(n.text))).toBe(true);
    expect(zebras(crammed).filter((a) => a.pregnantDays > 0 && a.pregnantDays < 3).length).toBe(0);
    expect(crammed.progress.targetRating()).toBeLessThan(sim.progress.targetRating());
  }, 60_000);

  it('breeds only while there is room for everyone grown up, so births alone never crowd a habitat', () => {
    const { sim } = newSim(5);
    sim.money = 1e6;
    const hid = buildZoo(sim); // 143 tiles: room for 7 zebras grown up
    hire(sim);
    expect(sim.hireStaff('vet', (EX + 0.5) * TILE, 60.5 * TILE).ok).toBe(true);
    buyHerd(sim, 'zebra', 4);
    sim.setSpeed(3);
    while (sim.day <= 30) {
      sim.update(0.5);
      const e = sim.evalFor(hid, 'zebra')!;
      expect(e.space).toBeGreaterThanOrEqual(0.95);
    }
    // the herd did grow, up to what the habitat holds
    expect(zebras(sim).length).toBeGreaterThan(4);
    expect(zebras(sim).length).toBeLessThanOrEqual(7);
    const all = sim.habitatReport(hid)!.suitability[0].issues;
    expect(all.some((i) => i.startsWith('Too crowded'))).toBe(false);
  }, 120_000);

  it('tells fish-eaters’ keepers which feeder to build (PT3-9)', () => {
    const { sim } = newSim(11);
    buildZoo(sim);
    hire(sim);
    expect(sim.buyAnimal('flamingo', (HAB.x0 + 4) * TILE, (HAB.z0 + 3) * TILE).ok).toBe(true);
    const fl = sim.habitatReport(sim.world.habitatAt(HAB.x0 + 1, HAB.z0 + 1)!.id)!.suitability.find((s) => s.speciesId === 'flamingo')!;
    expect(fl.issues).toContain('No Meat & Fish Platform (keepers scatter food on the ground)');
  });
});

describe('visits end after what a party came to see (PT3-2)', () => {
  function showcase() {
    const events = new EventBus();
    const log: { text: string }[] = [];
    events.on('notify', (n) => log.push(n));
    const sim = createSimulation(events, 7) as Simulation;
    sim.newGame();
    buildDemoZoo(sim, 7);
    sim.minuteOfDay = 7 * 60 + 50;
    return { sim, log };
  }

  it('turns over: more people visit in a day than the zoo holds at once, and the full zoo is reported', () => {
    const { sim, log } = showcase();
    const leftHappy = new Set<string>();
    let peak = 0;
    let turned = 0;
    sim.setSpeed(3);
    while (sim.minuteOfDay < 20 * 60) {
      sim.update(0.1);
      peak = Math.max(peak, sim.guests.size);
      turned = sim.stats().turnedAwayToday;
      for (const g of sim.guests.values()) if (g.goal === 'leave' && /saw everything we came for|saw what we came for/.test(g.thoughts.join('|'))) leftHappy.add(g.name);
    }
    const st = sim.stats();
    expect(peak).toBeLessThanOrEqual(st.guestCapacity);
    expect(st.guestCapacity).toBeLessThanOrEqual(150);
    expect(sim.guestsToday).toBeGreaterThan(st.guestCapacity);
    expect(leftHappy.size).toBeGreaterThan(3);
    if (turned >= 10) expect(log.some((n) => /^Zoo full — \d+ visitors turned away today\. More paths and exhibits make room\.$/.test(n.text))).toBe(true);
  }, 60_000);

  it('plans a round of a few appealing exhibits in walking order and keeps to it', () => {
    const { sim } = showcase();
    sim.setSpeed(3);
    while (sim.minuteOfDay < 9 * 60) sim.update(0.1);
    const gs = sim.guestSys as unknown as { distance(key: string, tile: number): number; habEntryTile(h: number): number };
    let checked = 0;
    for (const g of sim.guests.values()) {
      if (g.leader || !g.wants || g.viewed.length || g.route.length < 2) continue;
      // walking order: each next stop is the nearest of the rest from the previous one (or the reverse)
      const fwd = g.route.slice();
      const order = (r: number[], from: number) => {
        let at = from;
        for (let i = 0; i < r.length - 1; i++) {
          const d = gs.distance(`hab:${r[i]}`, at);
          for (const later of r.slice(i + 1)) if (gs.distance(`hab:${later}`, at) < d) return false;
          at = gs.habEntryTile(r[i]);
        }
        return true;
      };
      const ok = order(fwd, g.tile) || order(fwd.slice().reverse(), g.tile);
      if (g.plan === g.route[0]) {
        expect(g.goal === 'view' || g.qObj > 0 || g.goal === 'sit' || g.goal === 'enter').toBe(true);
      }
      expect(g.wants).toBeGreaterThanOrEqual(1);
      expect(g.route.length).toBeLessThanOrEqual(g.wants);
      if (ok) checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }, 30_000);

  it('older saves: parties without a plan make one on their next look round', () => {
    const { sim } = showcase();
    sim.setSpeed(3);
    while (sim.minuteOfDay < 10 * 60) sim.update(0.1);
    const save = JSON.parse(JSON.stringify(sim.serialize())) as SimSave & { guests: { k: string[]; r: unknown[][] } };
    // drop the new columns, as a save from round 5 would have them
    const cols = save.guests.k;
    for (const key of ['wants', 'route', 'paid']) {
      const i = cols.indexOf(key);
      expect(i).toBeGreaterThanOrEqual(0);
      cols.splice(i, 1);
      for (const row of save.guests.r) row.splice(i, 1);
    }
    const restored = createSimulation(new EventBus(), 1) as Simulation;
    restored.load(save);
    for (const g of restored.guests.values()) {
      expect(g.wants).toBe(0);
      expect(g.route).toEqual([]);
      expect(g.paid).toBe(0);
    }
    restored.setSpeed(3);
    while (restored.minuteOfDay < 12 * 60) restored.update(0.1);
    const leaders = [...restored.guests.values()].filter((g) => !g.leader && g.goal !== 'leave');
    expect(leaders.filter((g) => g.wants > 0).length / leaders.length).toBeGreaterThan(0.6);
  }, 30_000);
});

describe('goal pacing (PT3-5)', () => {
  it('keeps the first goals small and adds mid-game goals between species 6 and $100k', () => {
    const { sim } = newSim(11);
    const ids = sim.objectives.map((o) => o.id);
    const reward = (id: string) => sim.objectives.find((o) => o.id === id)!.reward;
    // the first week's goals (through 6 species) pay about $30k, not $49k
    const early = ids.slice(0, ids.indexOf('species_6') + 1).reduce((s, id) => s + reward(id), 0);
    expect(early).toBeLessThanOrEqual(32000);
    for (const id of ['visitors_1000', 'gift_shop', 'profit_3000', 'species_8', 'visitors_2500', 'guest_happy_75', 'rating_70', 'habitats_80'])
      expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf('species_6'));
    expect(ids.indexOf('money_100k')).toBeGreaterThan(ids.indexOf('habitats_80'));
    // every goal with a number to reach shows how far along it is
    for (const id of ids) if (!['build_habitat', 'first_animal', 'hire_keeper', 'food_stand', 'restrooms', 'baby', 'gift_shop'].includes(id)) expect(sim.objectiveProgress(id)).not.toBeNull();
  });

  it('counts the best day’s running profit and the happiest day, and pays for them once', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    hire(sim);
    sim.progress.closeDay(80, 3100);
    for (let i = 0; i < 25; i++) sim.progress.noteDeparture(0.8);
    sim.progress.closeDay(80, 1000);
    expect(sim.progress.bestRunning).toBe(3100);
    expect(sim.progress.bestDayHappiness).toBeCloseTo(0.8, 5);
    // a handful of guests is not a day's verdict
    for (let i = 0; i < 5; i++) sim.progress.noteDeparture(1);
    sim.progress.closeDay(10, 0);
    expect(sim.progress.bestDayHappiness).toBeCloseTo(0.8, 5);
    expect(sim.objectiveProgress('profit_3000')).toEqual({ current: 3000, target: 3000 });
    expect(sim.objectiveProgress('guest_happy_75')).toEqual({ current: 75, target: 75 });
    const money = sim.money;
    sim.progress.checkObjectives();
    const done = log.filter((e) => e.type === 'objectiveCompleted').map((e) => (e.payload as { id: string }).id);
    expect(done).toContain('profit_3000');
    expect(done).toContain('guest_happy_75');
    expect(sim.money).toBeGreaterThan(money);
    // the best day survives a save; older saves take it from the ledger
    const save = JSON.parse(JSON.stringify(sim.serialize())) as SimSave & { progress: Record<string, unknown>; ledger: Record<string, number>[] };
    const restored = createSimulation(new EventBus(), 1) as Simulation;
    restored.load(save);
    expect(restored.progress.bestRunning).toBe(3100);
    expect(restored.progress.bestDayHappiness).toBeCloseTo(0.8, 3);
    delete save.progress.bestRunning;
    save.ledger = [{ day: 1, income: 5000, admissions: 4000, shopIncome: 600, donations: 0, other: 400, expenses: 900, upkeep: 300, food: 200, salaries: 400, construction: 0, animalPurchases: 0 }];
    const old = createSimulation(new EventBus(), 1) as Simulation;
    old.load(save);
    expect(old.progress.bestRunning).toBe(4000 + 600 - 900);
  });

  it('old saves pick up the new goals, undone, and keep the ones already reached', () => {
    const { sim } = newSim(11);
    const save = JSON.parse(JSON.stringify(sim.serialize())) as SimSave & { objectives: { id: string; done: boolean }[] };
    save.objectives = save.objectives.filter((o) => !['visitors_1000', 'species_8', 'habitats_80'].includes(o.id));
    save.objectives.find((o) => o.id === 'build_habitat')!.done = true;
    const restored = createSimulation(new EventBus(), 1) as Simulation;
    restored.load(save);
    expect(restored.objectives.find((o) => o.id === 'build_habitat')!.done).toBe(true);
    for (const id of ['visitors_1000', 'species_8', 'habitats_80']) expect(restored.objectives.find((o) => o.id === id)!.done).toBe(false);
  });

  it('on an old save, new goals the zoo has already reached are ticked off quietly, without a pile of rewards', () => {
    const sim = createSimulation(new EventBus(), 7) as Simulation;
    sim.newGame();
    buildDemoZoo(sim, 7);
    sim.setSpeed(3);
    for (let i = 0; i < 50; i++) sim.update(0.1);
    expect(sim.progress.has.gift).toBe(true);
    const save = JSON.parse(JSON.stringify(sim.serialize())) as SimSave & { objectives: { id: string; done: boolean }[] };
    save.objectives = save.objectives.filter((o) => !['gift_shop', 'species_8', 'rating_80'].includes(o.id));
    const events = new EventBus();
    const done: string[] = [];
    events.on('objectiveCompleted', (e) => done.push(e.id));
    const restored = createSimulation(events, 1) as Simulation;
    restored.load(save);
    restored.setSpeed(3);
    for (let i = 0; i < 50; i++) restored.update(0.1);
    expect(restored.objectives.find((o) => o.id === 'gift_shop')!.done).toBe(true);
    expect(restored.objectives.find((o) => o.id === 'species_8')!.done).toBe(true);
    expect(done).not.toContain('gift_shop');
    expect(done).not.toContain('species_8');
    // one not reached yet stays open
    expect(restored.objectives.find((o) => o.id === 'rating_80')!.done).toBe(restored.rating >= 80);
  });

  it('counts habitats that suit all their animals 80% or better', () => {
    const { sim } = newSim(11);
    const hid = buildZoo(sim);
    hire(sim);
    buyHerd(sim, 'zebra', 4);
    sim.setSpeed(3);
    for (let i = 0; i < 40; i++) sim.update(0.1);
    const good = sim.evalFor(hid, 'zebra')!.score >= 0.8 ? 1 : 0;
    expect(sim.progress.goodHabitats).toBe(good);
    expect(sim.objectiveProgress('habitats_80')).toEqual({ current: good, target: 8 });
  });
});
