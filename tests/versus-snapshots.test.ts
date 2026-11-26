// Versus hourly snapshots and save continuity (versus.md §5, §12.3; spec §5.4), plus the
// tutorial's sim hooks (spec §6.1): the opaque tutorial blob, welcomeFirstGuests, openEnclosures.
import { describe, expect, it } from 'vitest';
import type { VersusSnapshot } from '../shared/api-types';
import { TEST_LENGTH, VERSUS_RULES_VERSION, checkSnapshotStep, scoreRounded, type VersusRules } from '../shared/versus-rules';
import { TILE } from '../src/core/constants';
import type { SimSave } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import type { EdgeRef } from '../src/core/world';
import { createSimulation } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';
import { HAB, buildZoo, buyHerd, hire, newSim } from './sim-helpers';

const RULES: VersusRules = { matchId: 'snap-1', seed: 4321, lengthMin: 4, days: TEST_LENGTH.days, rulesVersion: VERSUS_RULES_VERSION, startMoney: TEST_LENGTH.startMoney, startMinute: 510 };

function zooMatch(simSeed = 5) {
  const events = new EventBus();
  const sim = createSimulation(events, simSeed) as Simulation;
  sim.newGame(RULES.seed, { versus: RULES });
  sim.money = 1e6;
  buildZoo(sim);
  buyHerd(sim, 'zebra', 6);
  hire(sim);
  return { sim, events };
}

describe('versusHour snapshots', () => {
  it('fire 24N times with hours 1..24N in order, each equal to the score at that moment', () => {
    const { sim, events } = zooMatch();
    const got: { hour: number; snap: VersusSnapshot; partsNow: unknown; minute: number; day: number }[] = [];
    events.on('versusHour', (e) => got.push({ hour: e.hour, snap: e.snapshot, partsNow: sim.versus!.parts(), minute: sim.minuteOfDay, day: sim.day }));
    while (!sim.versus!.ended) sim.update(1 / 30);
    expect(got.map((g) => g.hour)).toEqual(Array.from({ length: 48 }, (_, i) => i + 1));
    let prev: VersusSnapshot | null = null;
    for (const g of got) {
      expect(g.snap.h).toBe(g.hour);
      expect(g.snap.parts).toEqual(g.partsNow);
      expect(g.snap.total).toBe(scoreRounded(g.snap.parts));
      // aligned to the match start: samples at xx:30
      expect(g.snap.min % 60).toBe(30);
      expect(Math.abs(g.minute - g.snap.min) < 0.5 || Math.abs(g.minute + 1440 - g.snap.min) < 0.5).toBe(true);
      // every one passes the server's plausibility step
      const step = checkSnapshotStep(prev, g.snap, 48);
      expect(step.ok).toBe(true);
      prev = g.snap;
    }
    expect(got.at(-1)!.snap).toMatchObject({ h: 48, day: 3, min: 510 });
    expect(sim.versus!.lastSnapshot()).toEqual(got.at(-1)!.snap);
  }, 30_000);

  it('save mid-hour → load → continue: no duplicate or missing hour', () => {
    const { sim, events } = zooMatch(6);
    const hours: number[] = [];
    events.on('versusHour', (e) => hours.push(e.hour));
    while (sim.versus!.hour < 10) sim.update(1 / 30);
    for (let i = 0; i < 37; i++) sim.update(1 / 30); // part way into hour 11
    const save = JSON.parse(JSON.stringify(sim.serialize())) as SimSave;
    const before = sim.versus!.parts();
    const events2 = new EventBus();
    const resumed = createSimulation(events2, 99) as Simulation;
    resumed.load(save);
    expect(resumed.versus!.hour).toBe(10);
    expect(resumed.versus!.parts()).toEqual(before);
    expect(resumed.versus!.lastSnapshot()).toEqual(sim.versus!.lastSnapshot());
    expect(resumed.speed).toBe(3);
    const after: number[] = [];
    events2.on('versusHour', (e) => after.push(e.hour));
    while (!resumed.versus!.ended) resumed.update(1 / 30);
    expect([...hours, ...after]).toEqual(Array.from({ length: 48 }, (_, i) => i + 1));
    expect(resumed.time).toBe(960);
  }, 30_000);

  it('a versus save never carries a tutorial blob', () => {
    const { sim } = zooMatch();
    sim.tutorial = { step: 'fence' };
    const save = sim.serialize() as Record<string, unknown>;
    expect(save.tutorial).toBeUndefined();
    expect(save.versus).toBeDefined();
  });
});

describe('tutorial sim hooks (spec §6.1)', () => {
  it('a serialize/load round-trip keeps sim.tutorial; newGame sets it to null', () => {
    const { sim, events } = newSim(4);
    expect(sim.tutorial).toBeNull();
    sim.tutorial = { v: 1, step: 'zebra', chapter: 3, done: ['fence', 'paint'], hand: { x: 12.5, z: 40 } };
    const save = JSON.parse(JSON.stringify(sim.serialize())) as SimSave;
    const other = createSimulation(events, 1) as Simulation;
    other.load(save);
    expect(other.tutorial).toEqual({ v: 1, step: 'zebra', chapter: 3, done: ['fence', 'paint'], hand: { x: 12.5, z: 40 } });
    other.tutorial = null;
    expect((other.serialize() as Record<string, unknown>).tutorial).toBeUndefined();
    sim.newGame();
    expect(sim.tutorial).toBeNull();
    // an old save without one loads with null
    const plain = createSimulation(events, 1) as Simulation;
    plain.load(other.serialize());
    expect(plain.tutorial).toBeNull();
  });

  it('welcomeFirstGuests() lets one party in now, then false while guests are there or the gate is shut', () => {
    const { sim } = newSim(4);
    sim.money = 1e6;
    // no animals on view: the gate is shut
    sim.minuteOfDay = 9 * 60;
    expect(sim.welcomeFirstGuests()).toBe(false);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 2);
    sim.minuteOfDay = 9 * 60;
    expect(sim.guests.size).toBe(0);
    expect(sim.welcomeFirstGuests()).toBe(true);
    expect(sim.guests.size).toBeGreaterThan(0);
    expect(sim.welcomeFirstGuests()).toBe(false);
    // closed for the night: false even when the zoo is empty
    for (const id of [...sim.guests.keys()]) sim.guests.delete(id);
    sim.minuteOfDay = 22 * 60;
    expect(sim.welcomeFirstGuests()).toBe(false);
  });

  it('openEnclosures() lists a habitat whose fence edge was removed, until it is closed again', () => {
    const { sim } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 2);
    const hab = [...sim.world.habitats.values()][0];
    const tiles = hab.tiles.length;
    expect(sim.openEnclosures()).toEqual([]);
    const gap: EdgeRef = { dir: 'h', x: 36, z: HAB.z0 };
    expect(sim.removeFences([gap]).ok).toBe(true);
    const open = sim.openEnclosures();
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(hab.id);
    expect(open[0].tiles.length).toBe(tiles);
    // a copy: changing it changes nothing in the sim
    (open[0].tiles as number[]).length = 0;
    expect(sim.openEnclosures()[0].tiles.length).toBe(tiles);
    expect(sim.placeFences([gap], 2).ok).toBe(true);
    expect(sim.openEnclosures()).toEqual([]);
    expect(TILE).toBeGreaterThan(0);
  });
});
