// Focused tests for the round-7 leftovers: calmer repeat warnings (a full zoo, a flooded
// habitat), the happiest-day goal on older saves, the crowding level and full flag the UI
// reads, the short adopt warning for the confirm bar, and a first habitat that fits a herd.

import { describe, expect, it } from 'vitest';
import { ENTRANCE_TILE, TILE } from '../src/core/constants';
import type { SimSave } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { Terrain } from '../src/core/types';
import { FENCES } from '../src/data/fences';
import { SPECIES } from '../src/data/species';
import { createSimulation } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';
import { buildZoo, buyHerd, hire, newSim } from './sim-helpers';

type Log = ReturnType<typeof newSim>['log'];
type Note = { text: string; kind: string; focus?: { x: number; z: number }; logOnly?: boolean };
const notes = (log: Log, re: RegExp) => log.filter((e) => e.type === 'notify').map((e) => e.payload as Note).filter((n) => re.test(n.text));

/** Run at speed 3 until the clock reaches `minute` on `day` (default today). */
function runTo(sim: Simulation, minute: number, day = sim.day) {
  sim.setSpeed(3);
  while (sim.day < day || (sim.day === day && sim.minuteOfDay < minute)) sim.update(0.1);
}

/** A fenced square of dry savanna with its top-left tile at (x0, z0). */
function square(sim: Simulation, x0: number, z0: number, size: number) {
  const r = { x0, z0, x1: x0 + size - 1, z1: z0 + size - 1 };
  sim.bulldoze({ x0: r.x0 - 1, z0: r.z0 - 1, x1: r.x1 + 1, z1: r.z1 + 1 });
  expect(sim.placeFences(sim.world.edgesAroundRect(r), 1).ok).toBe(true);
  expect(sim.paintTerrain(r, Terrain.DryGrass).ok).toBe(true);
  const hab = sim.world.habitatAt(x0 + 1, z0 + 1)!;
  expect(hab.tiles.length).toBe(size * size);
  return hab;
}

describe('repeat warnings', () => {
  it('a full zoo is news the first time; after that one log line a day, at the gate', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    hire(sim);
    // every arrival finds the zoo full
    sim.guestSys.full = () => true;
    expect(sim.stats().full).toBe(true);
    runTo(sim, 14 * 60);
    runTo(sim, 14 * 60, 2);
    const full = notes(log, /^Zoo full — \d+ visitors turned away today\./);
    expect(full.length).toBe(2);
    expect(full.map((n) => !!n.logOnly)).toEqual([false, true]);
    for (const n of full) expect(n.focus).toEqual({ x: (ENTRANCE_TILE.x + 0.5) * TILE, z: (ENTRANCE_TILE.z - 0.5) * TILE });
    // the zoo remembers it has been told, also across Continue
    const restored = createSimulation(new EventBus(), 1) as Simulation;
    restored.load(sim.serialize());
    expect(restored.progress.announced.has('zoo-full')).toBe(true);
  }, 60_000);

  it('a flooded habitat is a toast when it floods, then log-only reminders while it stays flooded', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    hire(sim);
    const rect = { x0: 20, z0: 58, x1: 24, z1: 62 };
    sim.bulldoze({ x0: rect.x0 - 1, z0: rect.z0 - 1, x1: rect.x1 + 1, z1: rect.z1 + 1 });
    expect(sim.placeFences(sim.world.edgesAroundRect(rect), 2).ok).toBe(true);
    for (const x of [21, 23]) expect(sim.buyAnimal('zebra', (x + 0.5) * TILE, 60.5 * TILE).ok).toBe(true);
    expect(sim.paintTerrain(rect, Terrain.DeepWater).ok).toBe(true);
    runTo(sim, 8 * 60, 2);
    const dry = notes(log, /has no dry land for the zebras/);
    expect(dry.length).toBeGreaterThanOrEqual(3);
    expect(dry[0].logOnly).toBeUndefined();
    expect(dry.slice(1).every((n) => n.logOnly)).toBe(true);
    expect(dry.every((n) => n.focus)).toBe(true);
  }, 60_000);
});

describe('happiest-day goal on older saves', () => {
  it('says no full day has been measured yet instead of 0%, until one closes', () => {
    const { sim } = newSim(11);
    const save = JSON.parse(JSON.stringify(sim.serialize())) as SimSave & { progress: Record<string, unknown> };
    delete save.progress.bestDayHappiness;
    delete save.progress.announced;
    const old = createSimulation(new EventBus(), 1) as Simulation;
    old.load(save);
    expect(old.objectiveProgress('guest_happy_75')).toEqual({ current: 0, target: 75, waiting: 'No full day yet' });
    expect(old.progress.announced.size).toBe(0);
    // a day with a handful of guests still says nothing
    for (let i = 0; i < 5; i++) old.progress.noteDeparture(0.9);
    old.progress.closeDay(5, 0);
    expect(old.objectiveProgress('guest_happy_75')?.waiting).toBe('No full day yet');
    for (let i = 0; i < 25; i++) old.progress.noteDeparture(0.625);
    old.progress.closeDay(25, 0);
    expect(old.objectiveProgress('guest_happy_75')).toEqual({ current: 62, target: 75 });
  });
});

describe('crowding as the UI reads it', () => {
  it('rates the 30-tile starter with 3 zebras severely crowded, a 64-tile one roomy', () => {
    const { sim } = newSim(11);
    sim.money = 1e6;
    const small = square(sim, 27, 58, 5); // 25 tiles
    for (const x of [28, 29, 30]) expect(sim.buyAnimal('zebra', (x + 0.5) * TILE, 60.5 * TILE).ok).toBe(true);
    const tight = sim.habitatReport(small.id)!.suitability[0];
    expect(tight.crowded).toBe('severe');
    expect(tight.issues[0]).toMatch(/^Too crowded \(25 tiles, needs 60\) — the animals get stressed and sick/);

    const roomy = square(sim, 14, 54, 8);
    for (const x of [15, 16, 17]) {
      const r = sim.buyAnimal('zebra', (x + 0.5) * TILE, 57.5 * TILE, true);
      expect(r.warning).toBeUndefined();
      expect(sim.buyAnimal('zebra', (x + 0.5) * TILE, 57.5 * TILE).ok).toBe(true);
    }
    expect(sim.habitatReport(roomy.id)!.suitability[0].crowded).toBe('no');
    // a 4th is only a bit too many: a plain warning, no question
    const fourth = sim.buyAnimal('zebra', 18.5 * TILE, 57.5 * TILE, true);
    expect(fourth.warning).toBe('It would be too crowded here (64 tiles, needs 80)');
    expect(fourth.severity).toBeUndefined();
    expect(fourth.shortWarning).toBeUndefined();
    expect(sim.suitability('zebra', roomy.id).crowded).toBe('mild');
  });

  it('the tour’s 8×8 habitat holds the smallest herd of every grazer a timber fence keeps', () => {
    const timber = FENCES.find((f) => f.key === 'wood')!;
    const grazers = SPECIES.filter((sp) => sp.danger <= timber.strength);
    expect(grazers.map((sp) => sp.id)).toContain('zebra');
    for (const sp of grazers) expect(sp.groupMin * sp.spacePerAnimal).toBeLessThanOrEqual(8 * 8);
  });

  it('reports the zoo full exactly when the next party would not fit', () => {
    const { sim } = newSim(11);
    expect(sim.stats().full).toBe(sim.guestSys.full());
    expect(sim.stats().full).toBe(sim.guests.size + 4 > sim.guestSys.capacity);
  });
});

describe('short adopt warning for the confirm bar', () => {
  it('cuts the packed-habitat warning to fit, keeping the full text for the dialog', () => {
    const { sim } = newSim(11);
    sim.money = 1e6;
    square(sim, 27, 58, 5);
    for (const x of [28, 29, 30]) expect(sim.buyAnimal('zebra', (x + 0.5) * TILE, 60.5 * TILE).ok).toBe(true);
    const r = sim.buyAnimal('zebra', 28.5 * TILE, 61.5 * TILE, true);
    expect(r.severity).toBe('confirm');
    expect(r.warning).toBe('It would be far too crowded here (25 tiles, needs 80) — the animals get stressed and sick');
    expect(r.shortWarning).toBe('Far too crowded (25 tiles, needs 80)');
    // a lion behind timber rails: both problems, each in short
    const lion = sim.buyAnimal('lion', 29.5 * TILE, 61.5 * TILE, true);
    expect(lion.severity).toBe('confirm');
    expect(lion.warning).toMatch(/^The fence is too weak for a Lion — use .+; Will hunt the zebras — keep predators and prey apart$/);
    expect(lion.shortWarning).toBe('Fence too weak; will hunt the zebras');
  });
});

describe('save compatibility', () => {
  it('older saves without the round-7 fields load and play on', () => {
    const { sim } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    const save = JSON.parse(JSON.stringify(sim.serialize())) as SimSave & { progress: Record<string, unknown> };
    delete save.progress.announced;
    delete save.progress.bestDayHappiness;
    const old = createSimulation(new EventBus(), 1) as Simulation;
    old.load(save);
    expect(old.animals.size).toBe(3);
    runTo(old, 10 * 60);
    expect(old.stats().full).toBe(false);
  });
});
