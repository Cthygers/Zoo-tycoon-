// Focused tests for the round-4 playtest fixes: the adopt preview counts the newcomer
// (PT-2), animal bodies keep apart and out of objects (PT-4), staff wages are charged
// once (PT-7), watching guests spread out (PT-9), the day summary (PT-10) and goal
// messages that the celebration card already shows (PT-6).

import { describe, expect, it } from 'vitest';
import { TILE } from '../src/core/constants';
import type { SimSave } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import type { TileRect } from '../src/core/events';
import { Terrain, type LedgerEntry, type PlacedObject } from '../src/core/types';
import { OBJECTS_BY_ID, rotatedSize } from '../src/data/objects';
import { SPECIES_BY_ID } from '../src/data/species';
import { buildDemoZoo } from '../src/demo';
import { createSimulation } from '../src/sim';
import { daySummary, emptyLedger, type Simulation } from '../src/sim/simulation';
import type { AnimalSim } from '../src/sim/state';
import { AVENUE, EX, buildZoo, buyHerd, hire, newSim } from './sim-helpers';

/** A bare 6×6 habitat (36 tiles) north of the starter avenue. */
const SMALL: TileRect = { x0: 30, z0: 44, x1: 35, z1: 49 };

function smallHabitat(sim: ReturnType<typeof newSim>['sim']): number {
  sim.bulldoze({ x0: SMALL.x0 - 1, z0: SMALL.z0 - 1, x1: SMALL.x1 + 1, z1: SMALL.z1 + 1 });
  expect(sim.paintTerrain(SMALL, Terrain.DryGrass).ok).toBe(true);
  expect(sim.placeFences(sim.world.edgesAroundRect(SMALL), 2).ok).toBe(true);
  expect(sim.placeObject('water_trough', SMALL.x1, SMALL.z1, 0).ok).toBe(true);
  expect(sim.hireStaff('keeper', (EX + 0.5) * TILE, (AVENUE + 0.5) * TILE).ok).toBe(true);
  const hab = sim.world.habitatAt(SMALL.x0, SMALL.z0);
  expect(hab).toBeTruthy();
  return hab!.id;
}

const spot = (i: number) => ({ x: (SMALL.x0 + 1 + i + 0.5) * TILE, z: (SMALL.z0 + 2.5) * TILE });

describe('adopt preview (PT-2)', () => {
  it('evaluates the habitat with the animal being adopted, while the report keeps the residents’ view', () => {
    const { sim } = newSim();
    const hid = smallHabitat(sim);
    // zebras need 20 tiles each: one fits, two need 40 of the 36 tiles
    expect(sim.suitability('zebra', hid).space).toBe(1);
    expect(sim.buyAnimal('zebra', spot(0).x, spot(0).z).ok).toBe(true);
    const second = sim.suitability('zebra', hid);
    expect(second.space).toBeCloseTo(36 / 40, 5);
    expect(second.issues).toContain('Too crowded (36 tiles, needs 40)');
    expect(sim.habitatReport(hid)!.suitability[0].space).toBe(1);
    // the adopt dry run warns before the player pays
    expect(sim.buyAnimal('zebra', spot(1).x, spot(1).z, true).warning).toMatch(/too crowded here \(36 tiles, needs 40\)/);
    expect(sim.buyAnimal('zebra', spot(1).x, spot(1).z).ok).toBe(true);
    expect(sim.habitatReport(hid)!.suitability[0].space).toBeCloseTo(36 / 40, 5);
    expect(sim.suitability('zebra', hid).space).toBeCloseTo(36 / 60, 5);
    // moving a resident within its own habitat adds no one, so it is not "too crowded" news
    const resident = [...sim.animals.values()][0];
    expect(sim.moveAnimal(resident.id, spot(3).x, spot(3).z, true).warning ?? '').not.toMatch(/crowded/);
  });
});

/** Spine sample points (body capsule) of an animal: centre ± spine along its heading. */
function spine(a: AnimalSim, n = 9): { x: number; z: number; r: number }[] {
  const sp = SPECIES_BY_ID[a.speciesId];
  const g = 0.45 + 0.55 * a.growth;
  const L = sp.length * 0.4 * g,
    r = Math.max(0.12, Math.min(0.85, 0.13 * sp.length + 0.1)) * g;
  const s = Math.max(0, L - r);
  const out: { x: number; z: number; r: number }[] = [];
  for (let k = 0; k < n; k++) {
    const f = -s + (2 * s * k) / (n - 1);
    out.push({ x: a.x + Math.sin(a.heading) * f, z: a.z + Math.cos(a.heading) * f, r });
  }
  return out;
}

/** Deepest overlap (m) of two animals' bodies. */
function bodyOverlap(a: AnimalSim, b: AnimalSim): number {
  let worst = 0;
  for (const p of spine(a)) for (const q of spine(b)) worst = Math.max(worst, p.r + q.r - Math.hypot(p.x - q.x, p.z - q.z));
  return worst;
}

/** Deepest intrusion (m) of an animal's body into the solid part of an object. */
function objectIntrusion(a: AnimalSim, o: PlacedObject): number {
  const def = OBJECTS_BY_ID[o.defId];
  const [fw, fd] = rotatedSize(def, o.rot);
  const cx = (o.tx + fw / 2) * TILE,
    cz = (o.tz + fd / 2) * TILE;
  const odd = o.rot % 2 === 1;
  const hx = def.solidSize ? def.solidSize[odd ? 1 : 0] / 2 : (fw * TILE) / 2 - 0.1,
    hz = def.solidSize ? def.solidSize[odd ? 0 : 1] / 2 : (fd * TILE) / 2 - 0.1;
  let worst = 0;
  for (const p of spine(a)) {
    const dx = p.x - Math.max(cx - hx, Math.min(cx + hx, p.x)),
      dz = p.z - Math.max(cz - hz, Math.min(cz + hz, p.z));
    worst = Math.max(worst, p.r - Math.hypot(dx, dz));
  }
  return worst;
}

describe('animal bodies (PT-4)', () => {
  it('keeps elongated bodies apart and out of feeders, troughs and trees, while they still eat there', () => {
    const { sim } = newSim(5);
    const hid = buildZoo(sim);
    hire(sim);
    buyHerd(sim, 'zebra', 7);
    const solids = [...sim.world.objects.values()].filter((o) => sim.world.habitatOf[sim.world.idx(o.tx, o.tz)] === hid && OBJECTS_BY_ID[o.defId].solid);
    expect(solids.map((o) => o.defId).sort()).toEqual(['feeder_hay', 'tree_acacia', 'tree_acacia', 'water_trough']);
    const feeder = solids.find((o) => o.defId === 'feeder_hay')!;
    sim.setSpeed(3);
    let pairs = 0,
      pairOverlap = 0,
      worstPair = 0,
      worstObject = 0,
      worstReach = 0,
      atFeeder = 0;
    const zebras = () => [...sim.animals.values()].filter((a) => !a.escaped && a.habitatId === hid);
    for (let i = 0; i < 2400; i++) {
      sim.update(0.1);
      if (i % 4) continue;
      const zs = zebras();
      for (let p = 0; p < zs.length; p++) {
        for (let q = p + 1; q < zs.length; q++) {
          if (zs[p].mother === zs[q].id || zs[q].mother === zs[p].id) continue;
          // sleeping herd mates may huddle a little closer
          const ov = bodyOverlap(zs[p], zs[q]) - (zs[p].action === 'sleep' && zs[q].action === 'sleep' ? 0.2 : 0);
          pairs++;
          if (ov > 0.1) pairOverlap++;
          worstPair = Math.max(worstPair, ov);
        }
        for (const o of solids) worstObject = Math.max(worstObject, objectIntrusion(zs[p], o));
        const z = zs[p];
        if (z.goal === 'eat' && !z.moving && Math.hypot(z.x - (feeder.tx + 0.5) * TILE, z.z - (feeder.tz + 0.5) * TILE) < 2.4) {
          // the muzzle reaches the rack: the body's front is within a few centimetres of it
          atFeeder++;
          worstReach = Math.max(worstReach, -objectIntrusion(z, feeder));
        }
      }
    }
    // (before: 7.7% of samples overlapped by over 10 cm, up to 0.78 m; bodies reached 16 cm into objects)
    expect(pairOverlap / pairs).toBeLessThan(0.01);
    expect(worstPair).toBeLessThan(0.4);
    expect(worstObject).toBeLessThan(0.02);
    expect(atFeeder).toBeGreaterThan(50);
    expect(worstReach).toBeLessThan(0.1);
  }, 60_000);
});

describe('staff wages (PT-7)', () => {
  it('charges nothing at hire and pays the first day only for the hours left', () => {
    const { sim } = newSim();
    sim.minuteOfDay = 12 * 60;
    const before = sim.money;
    const dry = sim.hireStaff('keeper', (EX + 0.5) * TILE, (AVENUE + 0.5) * TILE, true);
    expect(dry.ok).toBe(true);
    expect(dry.cost).toBe(0);
    expect(sim.hireStaff('keeper', (EX + 0.5) * TILE, (AVENUE + 0.5) * TILE).cost).toBe(0);
    sim.minuteOfDay = 18 * 60;
    expect(sim.hireStaff('groundskeeper', (EX + 0.5) * TILE, (AVENUE - 3 + 0.5) * TILE).ok).toBe(true);
    expect(sim.money).toBe(before);
    expect(sim.today.salaries).toBe(0);
    sim.setSpeed(3);
    while (sim.day < 3) sim.update(0.5);
    // half a day for the keeper (from noon), a quarter for the groundskeeper (from 18:00)
    expect(sim.ledger[0].salaries).toBe(Math.round(120 / 2 + 90 / 4));
    expect(sim.ledger[1].salaries).toBe(120 + 90);
  });

  it('pays a full day for staff in saves from before wages were pro-rated', () => {
    const { sim } = newSim();
    hire(sim);
    const save = sim.serialize() as unknown as { staff: { k: string[]; r: unknown[][] } };
    const col = save.staff.k.indexOf('payShare');
    expect(col).toBeGreaterThanOrEqual(0);
    save.staff.k.splice(col, 1);
    for (const row of save.staff.r) row.splice(col, 1);
    sim.load(save as unknown as SimSave);
    for (const s of sim.staff.values()) expect(s.payShare).toBe(1);
  });
});

describe('guests watching an exhibit (PT-9)', () => {
  it('spread along the fence instead of piling into one stretch, standing shoulder to shoulder at most', () => {
    // the showcase zoo as ?demo=1&seed=7 builds it; the Lion Kopje wall by the plaza kiosk drew a clump
    const sim = createSimulation(new EventBus(), 7) as Simulation;
    sim.newGame();
    buildDemoZoo(sim, 7);
    sim.setSpeed(3);
    sim.minuteOfDay = 7 * 60 + 50;
    while (sim.minuteOfDay < 11 * 60) sim.update(0.1);
    const KOPJE = { x: 76.6, z: 115.3 };
    let samples = 0,
      watchers = 0,
      overlaps = 0,
      worstCluster = 0,
      worstKopje = 0;
    for (let i = 0; sim.minuteOfDay < 15 * 60; i++) {
      sim.update(0.1);
      if (i % 2) continue;
      samples++;
      const standing = [...sim.guests.values()].filter((g) => !g.hidden && g.phase !== 3 && g.action !== 'sit' && g.speed < 0.25);
      const watching = standing.filter((g) => g.action === 'watch');
      watchers += watching.length;
      for (let a = 0; a < standing.length; a++)
        for (let b = a + 1; b < standing.length; b++) {
          const A = standing[a],
            B = standing[b];
          const bodies = (A.appearance.child ? 0.2 : 0.26) + (B.appearance.child ? 0.2 : 0.26);
          if (Math.hypot(A.x - B.x, A.z - B.z) < bodies * 0.85) overlaps++;
        }
      for (const w of watching) worstCluster = Math.max(worstCluster, watching.filter((o) => Math.hypot(o.x - w.x, o.z - w.z) < 3).length);
      worstKopje = Math.max(worstKopje, standing.filter((g) => Math.hypot(g.x - KOPJE.x, g.z - KOPJE.z) < 6).length);
    }
    // before: up to 12 watchers within 3 m of one another and 10 people by the Kopje wall, 15 overlapping pairs
    expect(watchers / samples).toBeGreaterThan(10);
    expect(worstCluster).toBeLessThanOrEqual(9);
    expect(worstKopje).toBeLessThanOrEqual(7);
    expect(overlaps).toBeLessThanOrEqual(6);
  }, 60_000);
});

describe('end-of-day summary (PT-10)', () => {
  const day = (over: Partial<LedgerEntry>): LedgerEntry => ({ ...emptyLedger(1), ...over });

  it('separates one-off purchases from the running result and formats money like the rest of the game', () => {
    // the playtest's opening day: mostly building and animals
    const opening = daySummary(day({ income: 8791, expenses: 16767, construction: 5790, animalPurchases: 10500, salaries: 300, food: 120, upkeep: 57 }));
    expect(opening.text).toBe('Day 1 closed: −$7,976 (building and animals $16,290; daily running +$8,314)');
    expect(opening.kind).toBe('info');
    const losing = daySummary(day({ income: 900, expenses: 2400, construction: 600, salaries: 1500, upkeep: 300 }));
    expect(losing.text).toBe('Day 1 closed: −$1,500 (building $600; daily running −$900)');
    expect(losing.kind).toBe('warn');
    const ordinary = daySummary(day({ day: 3, income: 2211, expenses: 2000, salaries: 1500, upkeep: 500 }));
    expect(ordinary.text).toBe('Day 3 closed: +$211 (income $2,211, running costs $2,000)');
    expect(ordinary.kind).toBe('info');
    expect(daySummary(day({ income: 100, expenses: 408, upkeep: 408 })).kind).toBe('warn');
  });

  it('is what the player sees when a day ends', () => {
    const { sim, log } = newSim();
    sim.minuteOfDay = 23 * 60 + 59;
    sim.setSpeed(1);
    sim.update(0.5);
    const msg = log.filter((e) => e.type === 'notify').map((e) => (e.payload as { text: string }).text).find((t) => t.startsWith('Day 1 closed'));
    expect(msg).toMatch(/^Day 1 closed: [+−]\$[\d,]+ \(/);
  });
});

describe('goal messages (PT-6)', () => {
  it('logs a completed goal without a second toast: the celebration card shows it', () => {
    const { sim, log } = newSim();
    buildZoo(sim);
    buyHerd(sim, 'zebra', 1);
    sim.progress.checkObjectives();
    const done = log.filter((e) => e.type === 'objectiveCompleted');
    expect(done.length).toBeGreaterThan(0);
    const goals = log.filter((e) => e.type === 'notify' && /^Goal complete/.test((e.payload as { text: string }).text));
    expect(goals.length).toBe(done.length);
    for (const g of goals) expect(g.payload).toMatchObject({ kind: 'good', logOnly: true });
    expect((goals[0].payload as { text: string }).text).toMatch(/\(\+\$[\d,]+\)$/);
  });
});
