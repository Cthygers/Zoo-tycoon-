// Focused tests for the round-5 fixes: fences always win over object push-out (PT2-1),
// the day summary keeps rewards apart from the running result (PT2-3), the move preview
// of a resident (REG-1), wages settled on dismissal (PT2-4), fence advice and guest view
// (PT2-2/5), full refunds for just-built things (PT2-8), re-surfaced paths (PT2-7), day
// stats for shops, restrooms and staff (PT2-6), unique names (PT2-10), quicker breeding
// (PT2-11) and favourite terrain (PRE-1).

import { describe, expect, it } from 'vitest';
import { TILE } from '../src/core/constants';
import type { SimSave } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import type { TileRect } from '../src/core/events';
import { PathType, Terrain } from '../src/core/types';
import { fenceAdvice } from '../src/data/fences';
import { OBJECTS_BY_ID } from '../src/data/objects';
import { SPECIES_BY_ID } from '../src/data/species';
import { buildDemoZoo } from '../src/demo';
import { createSimulation } from '../src/sim';
import { animalName } from '../src/sim/names';
import { SimRng } from '../src/sim/rng';
import type { Simulation } from '../src/sim/simulation';
import type { AnimalSim } from '../src/sim/state';
import { AVENUE, EX, HAB, buildZoo, buyHerd, hire, newSim } from './sim-helpers';

const texts = (log: { type: string; payload: unknown }[]) => log.filter((e) => e.type === 'notify').map((e) => (e.payload as { text: string }).text);
const tileOf = (x: number, z: number) => Math.floor(z / TILE) * 72 + Math.floor(x / TILE);

/** The private body fitting and approach of the animal AI, for the deterministic repro. */
interface AnimalInternals {
  setCtx(a: AnimalSim, sp: (typeof SPECIES_BY_ID)[string]): void;
  fitBody(sp: (typeof SPECIES_BY_ID)[string], growth: number, h: number, x: number, z: number, out: { x: number; z: number }): void;
  approachObject(a: AnimalSim, sp: (typeof SPECIES_BY_ID)[string], obj: { id: number; cx: number; cz: number }, nearOnly: boolean): boolean;
  routeBudget: number;
}

describe('fences win over object push-out (PT2-1)', () => {
  /** The playtest's spot: a Timber Shelter on tiles 31-32 / 28-29 and a steel fence at x = 33|34. */
  function shelterByFence() {
    const { sim, log } = newSim();
    sim.money = 1e6;
    const rect: TileRect = { x0: 24, z0: 22, x1: 33, z1: 33 };
    sim.bulldoze({ x0: rect.x0 - 1, z0: rect.z0 - 1, x1: rect.x1 + 1, z1: rect.z1 + 1 });
    expect(sim.paintTerrain(rect, Terrain.DryGrass).ok).toBe(true);
    expect(sim.placeFences(sim.world.edgesAroundRect(rect), 5).ok).toBe(true);
    expect(sim.placeObject('shelter_wood', 31, 28, 0).ok).toBe(true);
    expect(sim.placeObject('water_trough', 25, 23, 0).ok).toBe(true);
    const hid = sim.world.habitatAt(30, 30)!.id;
    expect(sim.world.fenceBetween(33, 28, 34, 28)).toBe(5);
    expect(sim.buyAnimal('elephant', 27.5 * TILE, 25.5 * TILE).ok).toBe(true);
    const el = [...sim.animals.values()].find((a) => a.speciesId === 'elephant')!;
    return { sim, log, hid, el, sys: sim.animalSys as unknown as AnimalInternals, sp: SPECIES_BY_ID.elephant };
  }

  it('never fits a body over the fence, whatever its heading (the playtest repro)', () => {
    const { sim, hid, el, sys, sp } = shelterByFence();
    sys.setCtx(el, sp);
    const out = { x: 0, z: 0 };
    for (const h of [Math.PI / 2, -Math.PI / 2, 0, Math.PI, Math.PI / 4])
      for (const [x, z] of [
        [67, 57],
        [67, 58],
        [67, 59],
      ]) {
        sys.fitBody(sp, 1, h, x, z, out);
        // before: (69, 57) at ±π/2, a tile east of the fence
        expect(sim.world.habitatOf[tileOf(out.x, out.z)]).toBe(hid);
        expect(out.x).toBeLessThan(68);
      }
  });

  it('does not bed an elephant down in the gap between the shelter and the fence', () => {
    const { sim, el, sys, sp } = shelterByFence();
    const shelter = [...sim.world.objects.values()].find((o) => o.defId === 'shelter_wood')!;
    const c = sim.world.objectCenter(shelter);
    const spots = new Set<string>();
    for (let i = 0; i < 40; i++) {
      // standing just north of the gap, so a walk into it needs no route
      el.x = 67;
      el.z = 51;
      sys.routeBudget = 6;
      sys.setCtx(el, sp);
      if (sys.approachObject(el, sp, { id: shelter.id, cx: c.x, cz: c.z }, true)) spots.add(`${Math.floor(el.tgtX / TILE)},${Math.floor(el.tgtZ / TILE)}`);
    }
    expect(spots.size).toBeGreaterThan(2);
    for (const s of spots) expect(s.startsWith('33,')).toBe(false);
  });

  it('keeps a turning elephant inside an intact fence, with no escape message', () => {
    const { sim, log, hid, el } = shelterByFence();
    sim.setSpeed(1);
    for (const face of [Math.PI / 2, -Math.PI / 2, Math.PI / 2]) {
      el.x = 67;
      el.z = 57;
      el.heading = 0;
      el.face = face;
      el.goal = 'sleep';
      el.goalTime = 30;
      el.moving = false;
      for (let i = 0; i < 60; i++) {
        sim.update(0.1);
        expect(el.escaped).toBe(false);
        expect(sim.world.habitatOf[tileOf(el.x, el.z)]).toBe(hid);
      }
    }
    expect(texts(log).filter((t) => /got out|broke|fenced in/.test(t))).toEqual([]);
  });

  it('has no false escapes over several days of the showcase zoo, for every species', () => {
    const events = new EventBus();
    const escapes: string[] = [];
    events.on('notify', (n) => {
      if (/got out|broken out|wandered out/.test(n.text)) escapes.push(n.text);
    });
    const sim = createSimulation(events, 7) as Simulation;
    sim.newGame();
    buildDemoZoo(sim, 7);
    const species = new Set([...sim.animals.values()].map((a) => a.speciesId));
    expect(species.size).toBeGreaterThanOrEqual(10);
    sim.setSpeed(3);
    // before: elephants were pushed over the steel fence by the shelter on days 3 and 5
    for (let i = 0; sim.day <= 6; i++) {
      sim.update(0.1);
      if (i % 4) continue;
      for (const a of sim.animals.values()) {
        if (a.escaped || a.crossing) continue;
        expect(sim.world.habitatOf[tileOf(a.x, a.z)], `${a.speciesId} ${a.name} outside its habitat`).toBeGreaterThan(0);
      }
    }
    expect(escapes).toEqual([]);
  }, 60_000);
});

describe('day summary keeps one-offs apart (PT2-3)', () => {
  it('reports goal rewards beside the daily running result, and warns only on a running loss', () => {
    const { sim, log } = newSim();
    sim.earn('admissions', 600);
    sim.earn('shopIncome', 150);
    sim.earn('other', 31000); // goal rewards
    expect(sim.today.other).toBe(31000);
    sim.minuteOfDay = 23 * 60 + 59;
    sim.setSpeed(1);
    sim.update(0.5);
    const day = sim.ledger[0];
    const running = day.admissions + day.shopIncome + day.donations - (day.salaries + day.food + day.upkeep);
    const msg = texts(log).find((t) => t.startsWith('Day 1 closed'))!;
    expect(msg).toContain(`daily running ${running < 0 ? '−' : '+'}$${Math.abs(running).toLocaleString('en-US')}`);
    expect(msg).toContain('rewards & refunds +$31,000');
  });

  it('recovers rewards and refunds in saves from before the ledger had them', () => {
    const { sim } = newSim();
    sim.earn('admissions', 500);
    sim.earn('other', 2000);
    sim.minuteOfDay = 23 * 60 + 59;
    sim.update(0.5);
    sim.earn('other', 700);
    const save = sim.serialize() as unknown as { ledger: Record<string, number>[]; today: Record<string, number> };
    delete save.ledger[0].other;
    delete save.today.other;
    sim.load(save as unknown as SimSave);
    expect(sim.ledger[0].other).toBe(2000);
    expect(sim.today.other).toBe(700);
  });
});

describe('move preview of a resident (REG-1)', () => {
  it('counts a moved animal as a newcomer only when it comes from another habitat', () => {
    const { sim } = newSim();
    sim.money = 1e6;
    const a: TileRect = { x0: 30, z0: 44, x1: 35, z1: 49 }; // 36 tiles: room for one zebra (20) but not two
    const b: TileRect = { x0: 38, z0: 44, x1: 43, z1: 49 };
    sim.bulldoze({ x0: 29, z0: 43, x1: 44, z1: 50 });
    for (const r of [a, b]) {
      expect(sim.paintTerrain(r, Terrain.DryGrass).ok).toBe(true);
      expect(sim.placeFences(sim.world.edgesAroundRect(r), 2).ok).toBe(true);
    }
    const ha = sim.world.habitatAt(a.x0, a.z0)!.id;
    const hb = sim.world.habitatAt(b.x0, b.z0)!.id;
    expect(sim.buyAnimal('zebra', (a.x0 + 2.5) * TILE, (a.z0 + 2.5) * TILE).ok).toBe(true);
    expect(sim.buyAnimal('zebra', (b.x0 + 2.5) * TILE, (b.z0 + 2.5) * TILE).ok).toBe(true);
    const [inA, inB] = [...sim.animals.values()];
    // moving the resident about its own habitat: the same one animal, so enough room
    expect(sim.suitability('zebra', ha, { animalId: inA.id }).space).toBe(1);
    // an animal from the other habitat (or a new one) is one more
    expect(sim.suitability('zebra', ha, { animalId: inB.id }).space).toBeCloseTo(36 / 40, 5);
    expect(sim.suitability('zebra', ha).space).toBeCloseTo(36 / 40, 5);
    expect(sim.suitability('zebra', hb, { animalId: inB.id }).space).toBe(1);
  });
});

describe('dismissal settles the day’s wage (PT2-4)', () => {
  it('pays for the hours worked since hiring when staff are dismissed the same day', () => {
    const { sim, log } = newSim();
    sim.minuteOfDay = 10 * 60;
    expect(sim.hireStaff('keeper', (EX + 0.5) * TILE, (AVENUE + 0.5) * TILE).ok).toBe(true);
    const k = [...sim.staff.values()][0];
    sim.minuteOfDay = 22 * 60;
    const owed = Math.round((120 * 12) / 24);
    expect(sim.staffSettlement(k.id)).toBe(owed);
    const before = sim.money;
    const r = sim.fireStaff(k.id);
    expect(r.ok).toBe(true);
    expect(r.cost).toBe(owed);
    expect(sim.money).toBe(before - owed);
    expect(sim.today.salaries).toBe(owed);
    expect(texts(log)).toContain(`${k.name} has left the zoo (paid $${owed} for today).`);
    // nothing more at midnight
    sim.setSpeed(3);
    while (sim.day < 2) sim.update(0.5);
    expect(sim.ledger[0].salaries).toBe(owed);
  });

  it('pays for the hours since midnight on a later day', () => {
    const { sim } = newSim();
    hire(sim);
    sim.setSpeed(3);
    while (sim.day < 2) sim.update(0.5);
    sim.minuteOfDay = 6 * 60;
    const k = [...sim.staff.values()].find((s) => s.role === 'keeper')!;
    expect(sim.staffSettlement(k.id)).toBe(30); // a quarter of $120
    const before = sim.today.salaries;
    expect(sim.fireStaff(k.id).cost).toBe(30);
    expect(sim.today.salaries).toBe(before + 30);
    expect(sim.staffSettlement(k.id)).toBe(0);
  });
});

describe('fence advice and guest view (PT2-2, PT2-5)', () => {
  it('names the cheapest strong-enough fence and the one guests see through best', () => {
    expect(fenceAdvice(3)).toBe('Stone Wall (blocks the view) or Glass Viewing Wall');
    expect(fenceAdvice(2)).toBe('Chain-Link Fence or Glass Viewing Wall');
    expect(fenceAdvice(4)).toBe('Heavy Steel Barrier');
    expect(fenceAdvice(1)).toBe('Timber Rail Fence');
  });

  it('warns about a weak fence with both options when adopting', () => {
    const { sim } = newSim();
    buildZoo(sim, 2);
    const lion = sim.buyAnimal('lion', (HAB.x0 + 3.5) * TILE, (HAB.z0 + 3.5) * TILE, true);
    expect(lion.warning).toContain('The fence is too weak for a Lion — use Stone Wall (blocks the view) or Glass Viewing Wall');
  });

  it('knows the weakest fence types and how well guests see in', () => {
    const { sim } = newSim();
    const hid = buildZoo(sim, 3); // stone walls all round
    const hab = sim.world.habitats.get(hid)!;
    expect(hab.weakestFenceIds).toEqual([3]);
    expect(hab.viewQuality).toBeCloseTo(0.25, 5);
    buyHerd(sim, 'zebra', 1);
    expect(sim.habitatReport(hid)!.suitability[0].issues).toContain('Walls block the guests’ view (Glass Viewing Wall shows the animals)');
    // glass along the viewing path (the south side): same strength, both types listed, a clear view
    const south = sim.world.edgesAroundRect(HAB).filter((e) => e.dir === 'h' && e.z === HAB.z1 + 1);
    expect(sim.placeFences(south, 4).ok).toBe(true);
    const glassy = sim.world.habitats.get(hid)!;
    expect(glassy.weakestFenceIds).toEqual([3, 4]);
    expect(glassy.viewQuality).toBeCloseTo(1, 5);
    expect(sim.habitatReport(hid)!.suitability[0].issues.some((i) => i.startsWith('Walls block'))).toBe(false);
  });
});

describe('full refund for just-built things (PT2-8)', () => {
  it('pays back everything removed within a game hour of building it, and 40% later', () => {
    const { sim } = newSim();
    sim.money = 1e6;
    sim.bulldoze({ x0: 4, z0: 4, x1: 14, z1: 14 });
    const gift = OBJECTS_BY_ID.shop_gift.cost;
    expect(sim.placePaths([{ x: 6, z: 9 }, { x: 7, z: 9 }, { x: 8, z: 9 }], PathType.Paved).ok).toBe(true);
    expect(sim.placeObject('shop_gift', 6, 7, 0).ok).toBe(true);
    const shop = Math.max(...sim.world.objects.keys());
    sim.minuteOfDay += 45;
    const quick = sim.removeObject(shop, true);
    expect(quick.cost).toBe(-gift);
    expect(quick.refundFraction).toBe(1);
    sim.minuteOfDay += 30; // 75 minutes after building
    const late = sim.removeObject(shop);
    expect(late.cost).toBe(-Math.round(gift * 0.4));
    expect(late.refundFraction).toBe(0.4);
    // fences and paths too
    const edges = sim.world.edgesAroundRect({ x0: 10, z0: 10, x1: 12, z1: 12 });
    expect(sim.placeFences(edges, 3).ok).toBe(true);
    const fence = sim.removeFences(edges, true);
    expect(fence.cost).toBe(-edges.length * 90);
    expect(fence.refundFraction).toBe(1);
    const path = sim.bulldoze({ x0: 6, z0: 9, x1: 8, z1: 9 }, true);
    expect(path.refundFraction).toBe(0.4); // the paths were built 75 minutes ago
    expect(sim.placePaths([{ x: 9, z: 9 }], PathType.Paved).ok).toBe(true);
    const mixed = sim.bulldoze({ x0: 6, z0: 9, x1: 9, z1: 9 }, true);
    expect(mixed.cost).toBe(-(3 * 8 + 20));
    expect(mixed.refundFraction).toBeCloseTo(44 / 80, 2);
  });
});

describe('re-surfacing paths (PT2-7)', () => {
  it('reports tiles that already had another path type, with their price', () => {
    const { sim } = newSim();
    sim.bulldoze({ x0: 4, z0: 4, x1: 12, z1: 6 });
    expect(sim.placePaths([{ x: 5, z: 5 }, { x: 6, z: 5 }], PathType.Paved).ok).toBe(true);
    const r = sim.placePaths([4, 5, 6, 7].map((x) => ({ x, z: 5 })), PathType.Boardwalk, true);
    expect(r.ok).toBe(true);
    expect(r.cost).toBe(4 * 30);
    expect(r.resurfaced).toEqual({ tiles: 2, cost: 60 });
    expect(sim.placePaths([{ x: 9, z: 5 }], PathType.Paved, true).resurfaced).toBeUndefined();
  });
});

describe('day stats for shops, restrooms and staff (PT2-6)', () => {
  it('counts today’s sales, visits and work, clears them at midnight and keeps them in saves', () => {
    const { sim } = newSim(3);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    hire(sim);
    sim.setSpeed(3);
    while (sim.minuteOfDay < 17 * 60) sim.update(0.5);
    const objs = [...sim.world.objects.values()];
    const snack = objs.find((o) => o.defId === 'shop_snack')!;
    const drinks = objs.find((o) => o.defId === 'shop_drinks')!;
    const loo = objs.find((o) => o.defId === 'restroom')!;
    const shops = [snack, drinks].map((o) => sim.serviceStats(o.id)!);
    const sold = shops.reduce((n, s) => n + s.sold, 0);
    expect(sold).toBeGreaterThan(5);
    for (const s of shops) {
      expect(s.sold).toBeGreaterThanOrEqual(s.visits);
      expect(s.queue).toBeGreaterThanOrEqual(0);
    }
    expect(shops.reduce((n, s) => n + s.income, 0)).toBe(sim.today.shopIncome);
    expect(sim.serviceStats(loo.id)!.visits).toBeGreaterThan(0);
    expect(sim.serviceStats(objs.find((o) => o.defId === 'bench')!.id)).toBeNull();
    const keeper = [...sim.staff.values()].find((s) => s.role === 'keeper')!;
    expect(sim.staffStats(keeper.id)!.serviced).toBeGreaterThan(0);

    // a save keeps them; one from before day stats loads with none
    const save = sim.serialize() as unknown as { serviceDay?: unknown; staff: { k: string[]; r: unknown[][] } };
    const sim2 = createSimulation(new EventBus(), 3) as Simulation;
    sim2.load(save as unknown as SimSave);
    expect(sim2.serviceStats(snack.id)!.sold).toBe(shops[0].sold);
    expect(sim2.staffStats(keeper.id)).toEqual(sim.staffStats(keeper.id));
    delete save.serviceDay;
    const cols = save.staff.k.map((k, i) => (k.startsWith('today.') ? i : -1)).filter((i) => i >= 0).reverse();
    expect(cols.length).toBe(4);
    for (const c of cols) {
      save.staff.k.splice(c, 1);
      for (const row of save.staff.r) row.splice(c, 1);
    }
    sim2.load(save as unknown as SimSave);
    expect(sim2.serviceStats(snack.id)!.sold).toBe(0);
    expect(sim2.staffStats(keeper.id)).toEqual({ cleaned: 0, serviced: 0, treated: 0, recaptured: 0 });

    while (sim.day < 2) sim.update(0.5);
    expect(sim.serviceStats(snack.id)!.sold).toBe(0);
    expect(sim.staffStats(keeper.id)!.serviced).toBe(0);
  }, 30_000);
});

describe('unique animal names (PT2-10)', () => {
  it('gives every living animal its own name, then numbered ones', () => {
    const rng = new SimRng(5);
    const taken = new Set<string>();
    for (let i = 0; i < 120; i++) {
      const n = animalName(rng, taken);
      expect(taken.has(n)).toBe(false);
      taken.add(n);
    }
    expect([...taken].some((n) => / II$/.test(n))).toBe(true);
    const sim = createSimulation(new EventBus(), 7) as Simulation;
    sim.newGame();
    buildDemoZoo(sim, 7);
    const names = [...sim.animals.values()].map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('breeding (PT2-11)', () => {
  it('a starter herd of three happy zebras pairs up and has a baby within a week, with notice', () => {
    const { sim, log } = newSim(5);
    sim.money = 1e6;
    buildZoo(sim);
    hire(sim);
    const ids = buyHerd(sim, 'zebra', 3);
    const sexes = ids.map((id) => sim.animals.get(id)!.sex);
    expect(sexes).toContain('M');
    expect(sexes).toContain('F');
    sim.setSpeed(3);
    let due: { day: number; of: number } | null = null;
    while (sim.day <= 7 && sim.animals.size === 3) {
      sim.update(0.5);
      for (const id of ids) due ??= sim.pregnancy(id);
    }
    expect(due).toEqual({ day: 1, of: SPECIES_BY_ID.zebra.gestationDays });
    expect(texts(log).some((t) => /is expecting! The baby is due in about 4 days\./.test(t))).toBe(true);
    expect(sim.animals.size).toBe(4);
    expect(texts(log).some((t) => t.includes('gave birth'))).toBe(true);
  }, 30_000);
});

describe('favourite terrain (PRE-1)', () => {
  it('a habitat painted all over with the species’ favourite ground suits it well', () => {
    const { sim } = newSim();
    const rect: TileRect = { x0: 30, z0: 44, x1: 39, z1: 53 };
    sim.bulldoze({ x0: 29, z0: 43, x1: 40, z1: 54 });
    expect(sim.paintTerrain(rect, Terrain.DryGrass).ok).toBe(true);
    expect(sim.placeFences(sim.world.edgesAroundRect(rect), 2).ok).toBe(true);
    const hid = sim.world.habitatAt(rect.x0, rect.z0)!.id;
    const zebra = sim.suitability('zebra', hid);
    expect(zebra.terrain).toBeGreaterThanOrEqual(0.8);
    expect(zebra.issues.some((i) => i.startsWith('Too much'))).toBe(false);
    // ground it does not like is still a problem
    expect(sim.paintTerrain(rect, Terrain.Sand).ok).toBe(true);
    const sandy = sim.suitability('zebra', hid);
    expect(sandy.terrain).toBeLessThan(0.1);
    expect(sandy.issues).toContain('Too much Sand (100%)');
  });
});

describe('exhibit trips (stretch)', () => {
  it('parties eating an ice cream are not sent straight back to the kiosk', () => {
    const sim = createSimulation(new EventBus(), 7) as Simulation;
    sim.newGame();
    buildDemoZoo(sim, 7);
    sim.setSpeed(3);
    // per party: the last shop, restroom or exhibit it set off for
    const last = new Map<number, string>();
    const current = new Map<number, string>();
    let trips = 0,
      repeats = 0;
    while (sim.minuteOfDay < 14 * 60) {
      sim.update(0.1);
      for (const g of sim.guests.values()) {
        if (g.leader) continue;
        const goal = `${g.goal}:${g.goalRef}`;
        if (current.get(g.id) === goal) continue;
        current.set(g.id, goal);
        if (g.goal !== 'shop' && g.goal !== 'restroom' && g.goal !== 'view') continue;
        if (g.goal !== 'view') {
          trips++;
          if (last.get(g.id) === goal) repeats++;
        }
        last.set(g.id, goal);
      }
    }
    // before: by 14:00 parties had gone straight back to the same kiosk 5 times (some up to six times running)
    expect(trips).toBeGreaterThan(40);
    expect(repeats).toBe(0);
  }, 60_000);
});
