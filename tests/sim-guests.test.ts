// Focused tests for the guest and economy review fixes: guests spread over the
// zoo (GAME-2), ticket price and running costs (GAME-3), the rating scale
// (GAME-7), warnings that name the real cause (GAME-9), litter complaints
// (GAME-10) and the evening walk-out (GAME-11).

import { describe, expect, it } from 'vitest';
import { MAP_W, TILE } from '../src/core/constants';
import { EventBus } from '../src/core/events';
import { PathType, Terrain } from '../src/core/types';
import { SPECIES_BY_ID } from '../src/data/species';
import { buildDemoZoo } from '../src/demo';
import { createSimulation } from '../src/sim';
import { dailyFoodCost } from '../src/sim/animals';
import type { Simulation } from '../src/sim/simulation';
import type { GuestSim } from '../src/sim/state';
import { AVENUE, EX, buildZoo, buyHerd, hire, newSim } from './sim-helpers';

const texts = (log: { type: string; payload: unknown }[]) => log.filter((e) => e.type === 'notify').map((e) => (e.payload as { text: string }).text);
/** The plaza where the entrance spine meets the promenade (world metres). */
const PLAZA = { x: (EX + 0.5) * TILE, z: (AVENUE + 1.5) * TILE };

function demoSim(): Simulation {
  const sim = createSimulation(new EventBus(), 42) as Simulation;
  sim.newGame();
  buildDemoZoo(sim);
  sim.setSpeed(3);
  sim.minuteOfDay = 7 * 60 + 50;
  return sim;
}

/** Run until the given minute of the current day, calling `each` every few frames. */
function runUntil(sim: Simulation, minute: number, each?: () => void) {
  const day = sim.day;
  for (let i = 0; sim.day === day && sim.minuteOfDay < minute; i++) {
    sim.update(0.1);
    if (each && i % 10 === 0) each();
  }
}

/** Habitats each party leader has viewed, remembered after the party leaves. */
function trackViews(sim: Simulation) {
  const viewed = new Map<number, number[]>();
  return {
    viewed,
    sample() {
      for (const g of sim.guests.values()) if (!g.leader) viewed.set(g.id, g.viewed.slice());
    },
  };
}

describe('guests spread over the whole zoo (GAME-2)', () => {
  it('leaves the entrance plaza behind and sees several exhibits in the showcase zoo', () => {
    const sim = demoSim();
    const views = trackViews(sim);
    runUntil(sim, 16 * 60, views.sample);
    const all = [...sim.guests.values()];
    const dist = (g: GuestSim) => Math.hypot(g.x - PLAZA.x, g.z - PLAZA.z);
    expect(all.length).toBeGreaterThan(100);
    // before the fix about 80% stood within 20 m of the plaza and almost nobody went past 40 m
    expect(all.filter((g) => dist(g) < 20).length / all.length).toBeLessThan(0.62);
    expect(all.filter((g) => dist(g) > 40).length / all.length).toBeGreaterThan(0.15);
    runUntil(sim, 21 * 60, views.sample);
    const counts = [...views.viewed.values()].map((v) => v.length);
    const mean = counts.reduce((s, n) => s + n, 0) / counts.length;
    expect(mean).toBeGreaterThan(1.25);
    expect(counts.filter((n) => n >= 2).length / counts.length).toBeGreaterThan(0.35);
    const seen = new Set([...views.viewed.values()].flat());
    expect(seen.size).toBeGreaterThanOrEqual(5); // of 7 habitats
  }, 30_000);

  it('walks past near exhibits to far ones: five equal habitats along one path all get visitors', () => {
    const { sim } = newSim(23);
    sim.money = 1_000_000;
    // a straight path north from the avenue with five zebra habitats beside it, 10 tiles apart
    sim.bulldoze({ x0: 28, z0: 6, x1: 38, z1: AVENUE - 1 });
    const path: { x: number; z: number }[] = [];
    for (let z = 8; z < AVENUE; z++) path.push({ x: EX, z });
    expect(sim.placePaths(path, PathType.Paved).ok).toBe(true);
    const habs: number[] = [];
    for (let k = 0; k < 5; k++) {
      const c = AVENUE - 6 - 10 * k;
      const rect = { x0: 29, z0: c - 3, x1: EX - 2, z1: c + 3 };
      expect(sim.paintTerrain(rect, Terrain.DryGrass).ok).toBe(true);
      expect(sim.paintTerrain({ x0: 30, z0: c, x1: 31, z1: c }, Terrain.Water).ok).toBe(true);
      expect(sim.placeFences(sim.world.edgesAroundRect(rect), 2).ok).toBe(true);
      const hab = sim.world.habitatAt(30, c - 2)!;
      expect(hab.viewTiles.length).toBeGreaterThan(3);
      expect(sim.placeObject('feeder_hay', 32, c + 2, 0).ok).toBe(true);
      for (let i = 0; i < 4; i++) expect(sim.buyAnimal('zebra', (30 + i + 0.5) * TILE, (c - 2 + 0.5) * TILE).ok).toBe(true);
      habs.push(hab.id);
    }
    expect(sim.placeObject('shop_snack', EX + 1, AVENUE + 2, 0).ok).toBe(true);
    expect(sim.placeObject('shop_drinks', EX - 1, AVENUE + 2, 0).ok).toBe(true);
    expect(sim.placeObject('restroom', EX + 1, AVENUE + 5, 0).ok).toBe(true);
    for (let i = 0; i < 2; i++) expect(sim.hireStaff('keeper', (EX + 0.5) * TILE, (AVENUE - 10 * i - 3 + 0.5) * TILE).ok).toBe(true);
    sim.setSpeed(3);
    const views = trackViews(sim);
    const start = sim.day;
    while (sim.day < start + 3) {
      runUntil(sim, 24 * 60, views.sample);
    }
    const visitors = habs.map((h) => [...views.viewed.values()].filter((v) => v.includes(h)).length);
    // Before the fix: 33 / 15 / 8 / 1 / 1 parties over three days from the nearest to the
    // farthest (and half the parties saw nothing). Walking 120 m takes four game hours,
    // so the far end stays quieter, but people who pass the near ones on the way get there.
    for (const n of visitors) expect(n).toBeGreaterThan(0);
    expect(visitors[3] + visitors[4]).toBeGreaterThan(visitors[0] * 0.15);
    const counts = [...views.viewed.values()].map((v) => v.length);
    expect(counts.reduce((s, n) => s + n, 0) / counts.length).toBeGreaterThan(1);
  }, 30_000);
});

describe('far exhibits get their share', () => {
  it('sends parties to the showcase zoo’s far northern exhibits, not just the ones by the gate', () => {
    const sim = demoSim();
    const views = trackViews(sim);
    const start = sim.day;
    while (sim.day < start + 2) runUntil(sim, 24 * 60, views.sample);
    const byName = new Map([...sim.world.habitats.values()].map((h) => [h.name, h.id]));
    const visitors = (name: string) => [...views.viewed.values()].filter((v) => v.includes(byName.get(name)!)).length;
    const far = visitors('Elephant Valley') + visitors('Tiger Forest') + visitors('Gorilla Grove');
    // Before: 1 / 3 / 1 parties over three days at Elephant Valley, Tiger Forest and Gorilla Grove
    // (59–64 path tiles from the gate) against ~170 at Lion Kopje by the promenade. The middle
    // cross walk brings Elephant Valley and Gorilla Grove closer, and parties now pick their first
    // exhibit by what they'd see and keep time for the one they set out for.
    expect(visitors('Elephant Valley')).toBeGreaterThan(12);
    expect(visitors('Tiger Forest')).toBeGreaterThan(0);
    expect(visitors('Gorilla Grove')).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(visitors('Lion Kopje') * 0.2);
  }, 30_000);
});

describe('ticket price and running costs (GAME-3)', () => {
  it('overpricing turns visitors away even when the ticket booths are the limit, and sours the visit', () => {
    const sim = demoSim();
    runUntil(sim, 10 * 60);
    const gs = sim.guestSys;
    sim.setAdmission(10);
    const cheap = gs.arrivalRate();
    const fair = gs.fairPrice;
    expect(fair).toBeGreaterThan(30); // a big zoo is worth a dear ticket
    sim.setAdmission(Math.round(fair));
    const atFair = gs.arrivalRate();
    sim.setAdmission(Math.round(fair * 1.5));
    const dear = gs.arrivalRate();
    expect(cheap).toBeCloseTo(atFair, 5); // the booths are the limit either way
    expect(dear).toBeLessThan(atFair * 0.4);
    const party = gs.spawnParty()!;
    expect(party.ticketValue).toBeLessThan(-0.2);
    expect(party.thoughts).toContain('The tickets here are expensive.');
  }, 30_000);

  it('a small zoo is worth less than a big one; animals eat into the daily budget', () => {
    const plain = newSim(11).sim;
    buildZoo(plain);
    hire(plain);
    const fed = newSim(11).sim;
    buildZoo(fed);
    hire(fed);
    buyHerd(fed, 'zebra', 5);
    fed.guestSys.arrivalRate();
    expect(fed.guestSys.fairPrice).toBeLessThan(18);
    for (const sim of [plain, fed]) {
      sim.setSpeed(3);
      runUntil(sim, 24 * 60);
    }
    const food = 5 * dailyFoodCost(SPECIES_BY_ID.zebra, 1);
    expect(food).toBeGreaterThan(20);
    expect(fed.ledger[0].food - plain.ledger[0].food).toBe(food);
    expect(fed.ledger[0].upkeep).toBe(plain.ledger[0].upkeep); // food has its own ledger row
  }, 30_000);

  it('loads saves from before animal food had its own ledger row', () => {
    const { sim } = newSim(5);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    sim.setSpeed(3);
    runUntil(sim, 24 * 60);
    const save = JSON.parse(JSON.stringify(sim.serialize()));
    delete save.today.food;
    for (const e of save.ledger) delete e.food;
    const { sim: sim2 } = newSim(5);
    sim2.load(save);
    expect(sim2.today.food).toBe(0);
    expect(sim2.ledger.every((e) => e.food === 0)).toBe(true);
    expect(sim2.stats().fairAdmission).toBeGreaterThan(0);
  }, 30_000);

  it('a starter zoo makes a steady but modest profit', () => {
    const { sim } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 5);
    hire(sim);
    sim.setSpeed(3);
    const start = sim.day;
    while (sim.day < start + 4) runUntil(sim, 24 * 60);
    // day-to-day trading only (goal rewards are a one-off)
    for (const d of sim.ledger.slice(1)) {
      const income = d.admissions + d.shopIncome + d.donations;
      const costs = d.upkeep + d.food + d.salaries;
      expect(income - costs).toBeGreaterThan(0);
      expect(income - costs).toBeLessThan(1500);
      expect(costs / income).toBeGreaterThan(0.25); // wages, upkeep and food matter
    }
  }, 30_000);

  it('keeps the showcase zoo profitable at the default price', () => {
    const big = demoSim();
    runUntil(big, 24 * 60);
    runUntil(big, 24 * 60);
    const d = big.ledger[1];
    expect(d.admissions + d.shopIncome + d.donations - d.upkeep - d.food - d.salaries).toBeGreaterThan(300);
  }, 30_000);
});

describe('zoo rating scale (GAME-7)', () => {
  it('rates a one-habitat zoo in the 40s and the showcase zoo above 70', () => {
    const { sim } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 4);
    hire(sim);
    sim.setSpeed(3);
    runUntil(sim, 24 * 60);
    expect(sim.rating).toBeGreaterThan(35);
    expect(sim.rating).toBeLessThan(50);
    expect(sim.objectives.find((o) => o.id === 'rating_60')!.done).toBe(false);
    const big = demoSim();
    runUntil(big, 24 * 60);
    expect(big.rating).toBeGreaterThan(70);
    expect(big.rating - sim.rating).toBeGreaterThan(25);
  }, 30_000);
});

describe('warnings name the real cause (GAME-9)', () => {
  it('blames thirst, not terrain, when animals have nothing to drink', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    expect(sim.paintTerrain({ x0: 33, z0: 47, x1: 35, z1: 48 }, Terrain.DryGrass).ok).toBe(true);
    const trough = [...sim.world.objects.values()].find((o) => o.defId === 'water_trough')!;
    expect(sim.removeObject(trough.id).ok).toBe(true);
    buyHerd(sim, 'zebra', 4);
    sim.setSpeed(3);
    const start = sim.day;
    while (sim.day < start + 2 && !texts(log).some((t) => / is unhappy/.test(t))) sim.update(0.25);
    const unhappy = texts(log).filter((t) => / is unhappy/.test(t));
    expect(unhappy.length).toBeGreaterThan(0);
    for (const t of unhappy) {
      expect(t).not.toMatch(/Needs more|Too much/);
      expect(t).toMatch(/drink|thirsty/);
    }
  }, 30_000);

  it('says the zoo is cut off from the entrance instead of “nothing built”', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 5);
    hire(sim);
    // cut the only path from the gate plaza to the avenue
    expect(sim.bulldoze({ x0: EX - 1, z0: 65, x1: EX + 1, z1: 65 }).ok).toBe(true);
    sim.setSpeed(3);
    runUntil(sim, 16 * 60);
    const all = texts(log);
    expect(all.some((t) => /entrance path is cut — reconnect it/.test(t))).toBe(true);
    expect(all.some((t) => /can’t reach .* — connect/.test(t))).toBe(false);
    expect(all.some((t) => /nowhere to buy food|no restrooms|build a drinks kiosk/.test(t))).toBe(false);
  }, 30_000);
});

describe('litter complaints (GAME-10)', () => {
  it('counts each party once per report, points at the spot and fits the advice to the staff', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    hire(sim);
    const p = sim.progress;
    const tile = 20 * MAP_W + EX; // a tile far from any bin
    const report = () => {
      sim.time += 200; // past the toast cooldown
      p.tick(15);
    };
    // one party lingering at a dirty spot is not a zoo-wide problem
    for (let i = 0; i < 12; i++) p.noteLitter(1, tile, 6);
    report();
    expect(texts(log).filter((t) => /litter/.test(t))).toEqual([]);
    for (let id = 1; id <= 4; id++) p.noteLitter(id, tile, 6);
    report();
    const toast = log.filter((e) => e.type === 'notify').at(-1)!.payload as { text: string; focus?: { x: number; z: number } };
    expect(toast.text).toMatch(/litter here — put litter bins along this path/);
    expect(toast.focus).toEqual({ x: (EX + 0.5) * TILE, z: 20.5 * TILE });
    for (const s of [...sim.staff.values()]) if (s.role === 'groundskeeper') sim.fireStaff(s.id);
    for (let id = 1; id <= 4; id++) p.noteLitter(id, tile, 6);
    report();
    expect(texts(log).at(-1)).toMatch(/hire a groundskeeper/);
  });
});

describe('evening walk-out (GAME-11)', () => {
  it('empties the zoo by walking out in time; stragglers are escorted, not deleted', () => {
    const sim = demoSim();
    runUntil(sim, 20 * 60 + 30);
    expect(sim.guests.size).toBeLessThan(8);
    runUntil(sim, 21 * 60);
    expect(sim.guests.size).toBeLessThan(3);
    // a party still deep inside the zoo at 21:00 is shown out, not removed on the spot
    const lead = sim.guestSys.spawnParty()!;
    const t = 30 * MAP_W + 36; // half way up the central walk
    expect(sim.world.path[t]).toBeTruthy();
    for (const g of [lead, ...lead.party.map((id) => sim.guests.get(id)!)]) {
      g.x = (36 + 0.5) * TILE;
      g.z = (30 + 0.5) * TILE;
      g.tile = t;
    }
    lead.phase = 0;
    lead.next = -1;
    lead.goal = 'wander';
    lead.goalKey = '';
    lead.wanderSteps = 999;
    let removedAt = -1;
    sim.events.on('guestRemoved', (e) => {
      if (e.id === lead.id) removedAt = sim.minuteOfDay;
    });
    runUntil(sim, 21 * 60 + 31);
    expect(sim.guests.has(lead.id)).toBe(true);
    expect(lead.goal).toBe('leave');
    let lastPhase = -1;
    while (removedAt < 0 && sim.minuteOfDay > 60) {
      lastPhase = lead.phase;
      sim.update(0.1);
    }
    expect(removedAt).toBeGreaterThan(21 * 60 + 31);
    expect(lastPhase).toBe(3); // walked out through the gate
  }, 30_000);
});
