// Focused tests for the review fixes: opened enclosures (GAME-1 / CODE-3),
// not-a-habitat warnings (GAME-6), animals drinking (GAME-4 / GAME-5), resting
// in water (VIS-17), habitat advice wording (GAME-8) and refunds (CODE-5).

import { describe, expect, it } from 'vitest';
import { START_MONEY, TILE, WATER_LEVEL } from '../src/core/constants';
import { EventBus } from '../src/core/events';
import { PathType } from '../src/core/types';
import type { EdgeRef } from '../src/core/world';
import { SPECIES_BY_ID } from '../src/data/species';
import { buildDemoZoo } from '../src/demo';
import { createSimulation } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';
import { AVENUE, EX, HAB, buildZoo, buyHerd, hire, newSim } from './sim-helpers';

const texts = (log: { type: string; payload: unknown }[]) => log.filter((e) => e.type === 'notify').map((e) => (e.payload as { text: string }).text);
const inHab = (sim: Simulation, x: number, z: number) => {
  const t = sim.world.tileOfWorld(x, z);
  return t.x >= HAB.x0 && t.x <= HAB.x1 && t.z >= HAB.z0 && t.z <= HAB.z1;
};
/** One segment of the habitat's north fence (open grass beyond it). */
const GAP: EdgeRef = { dir: 'h', x: 36, z: HAB.z0 };

describe('opened enclosures', () => {
  it('keeps animals home while the fence is open, then restores name and home when it is closed again', () => {
    const { sim, events, log } = newSim(11);
    const hid = buildZoo(sim);
    sim.renameHabitat(hid, 'Zebra Flats');
    const ids = buyHerd(sim, 'zebra', 4);
    hire(sim);
    const keeper = [...sim.staff.values()].find((s) => s.role === 'keeper')!;
    keeper.job = 'service';
    keeper.jobRef = hid;

    const dry = sim.removeFences([GAP], true);
    expect(dry.ok).toBe(true);
    expect(dry.warning).toBe('Opens Zebra Flats — 4 animals can wander out');
    expect(sim.removeFences([GAP]).ok).toBe(true);
    expect(sim.world.habitats.size).toBe(0);
    expect(keeper.job).toBe('none'); // no stale job on a vanished habitat

    sim.setSpeed(1);
    for (let i = 0; i < 30; i++) sim.update(0.1);
    for (const id of ids) {
      const a = sim.animals.get(id)!;
      expect(a.escaped).toBe(!inHab(sim, a.x, a.z)); // only those that walked out through the gap
      expect(a.home).toBe(hid);
    }

    // one wanders out: it is loose now, but nobody can take it back while the fence is open
    const stray = sim.animals.get(ids[0])!;
    stray.x = (36 + 0.5) * TILE;
    stray.z = (HAB.z0 - 3 + 0.5) * TILE;
    stray.moving = false;
    sim.update(0.1);
    expect(stray.escaped).toBe(true);
    expect(texts(log).some((t) => /wandered out of Zebra Flats through the open fence/.test(t))).toBe(true);
    expect(sim.animalSys.homeFor(stray)).toBe(0);

    // the open enclosure survives a save / load
    const sim2 = createSimulation(events, 11) as Simulation;
    sim2.load(sim.serialize());
    const stray2 = sim2.animals.get(ids[0])!;
    expect(sim2.placeFences([GAP], 2).ok).toBe(true);
    const hab = sim2.world.habitatAt(36, 50)!;
    expect(hab.name).toBe('Zebra Flats');
    expect(stray2.home).toBe(hab.id);
    sim2.update(0.1);
    for (const id of ids.slice(1)) {
      const a = sim2.animals.get(id)!;
      if (inHab(sim2, a.x, a.z)) expect(a.habitatId).toBe(hab.id);
    }
    expect(sim2.animalSys.returnHome(stray2)).toBe(true);
    expect(stray2.escaped).toBe(false);
    expect(stray2.habitatId).toBe(hab.id);
  });

  it('keepers still feed the animals lingering in an opened enclosure, and they drink from what is left in it', () => {
    const { sim } = newSim(13);
    const hid = buildZoo(sim);
    const ids = buyHerd(sim, 'zebra', 4);
    hire(sim);
    expect(sim.removeFences([GAP]).ok).toBe(true);
    const enc = sim.enclosures.find(hid)!;
    expect(enc).toBeTruthy();
    enc.food = 0;
    const residents = () => ids.map((id) => sim.animals.get(id)!).filter((a) => !a.escaped && !a.habitatId && a.home === hid);
    for (const a of residents()) {
      a.needs.hunger = 0.3;
      a.needs.thirst = 0.3;
      a.think = 0;
    }
    // a keeper walks over from the avenue and leaves food from the path beside the old fence
    sim.setSpeed(1);
    const keeper = [...sim.staff.values()].find((s) => s.role === 'keeper')!;
    let assigned = false;
    let fed = 0;
    for (let i = 0; i < 1200 && !fed; i++) {
      sim.update(0.1);
      if (keeper.job === 'service' && keeper.jobRef === hid) assigned = true;
      fed = enc.food;
    }
    expect(assigned).toBe(true);
    expect(fed).toBeGreaterThan(0);
    expect(enc.spotX).toBeGreaterThan(0);
    // the pond and the trough are still inside the old footprint: no tub needed
    expect(enc.water).toBe(0);
    for (const a of residents()) {
      a.needs.hunger = 0.3; // hungry again, now that there is food
      a.think = 0;
    }
    for (let i = 0; i < 600; i++) sim.update(0.1);
    const left = residents();
    expect(left.length).toBeGreaterThan(0);
    // (both needs started at 0.3 and fall ~0.07 an hour: above 0.4 they have drunk and eaten)
    for (const a of left) {
      expect(a.needs.thirst).toBeGreaterThan(0.4);
      expect(a.needs.hunger).toBeGreaterThan(0.4);
    }
    expect(enc.food).toBeLessThan(fed); // they ate the keeper's food

    // without a pond or trough the keeper brings water in a tub, and it survives a save
    expect(sim.bulldoze({ x0: 31, z0: 50, x1: 31, z1: 50 }).ok).toBe(true); // the trough
    sim.world.setTerrainRect({ x0: HAB.x0, z0: HAB.z0, x1: HAB.x1, z1: HAB.z1 }, 1);
    expect(sim.enclosures.footprintWater(enc)).toEqual({ edge: [], troughs: [] });
    enc.food = 0;
    for (let i = 0; i < 1200 && !enc.water; i++) sim.update(0.1);
    expect(enc.water).toBeGreaterThan(0);
    const sim2 = createSimulation(new EventBus(), 13) as Simulation;
    sim2.load(sim.serialize());
    expect(sim2.enclosures.find(hid)).toMatchObject({ food: expect.any(Number), water: expect.closeTo(enc.water, 1) });
  });

  it('enlarging a habitat (remove a side, fence a bigger area) keeps its name and contains its animals', () => {
    const { sim, log } = newSim(12);
    const hid = buildZoo(sim);
    sim.renameHabitat(hid, 'Zebra Flats');
    const ids = buyHerd(sim, 'zebra', 4);
    const east = sim.world.edgesBetweenCorners(HAB.x1 + 1, HAB.z0, HAB.x1 + 1, HAB.z1 + 1);
    expect(sim.removeFences(east).ok).toBe(true);
    const bigger = { ...HAB, x1: HAB.x1 + 5 };
    const r = sim.placeFences(sim.world.edgesAroundRect(bigger), 2);
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
    const hab = sim.world.habitatAt(HAB.x0, HAB.z0)!;
    expect(hab.name).toBe('Zebra Flats');
    expect(hab.tiles.length).toBe((bigger.x1 - bigger.x0 + 1) * (bigger.z1 - bigger.z0 + 1));
    sim.update(0.1);
    for (const id of ids) {
      const a = sim.animals.get(id)!;
      expect(a.escaped).toBe(false);
      expect(a.habitatId).toBe(hab.id);
      expect(a.home).toBe(hab.id);
    }
    expect(texts(log).some((t) => /got out|wandered out/.test(t))).toBe(false);
  });

  it('takes strays to a habitat that suits them, never in with predators', () => {
    const { sim } = newSim(13);
    const zebraHab = buildZoo(sim);
    buyHerd(sim, 'zebra', 2);
    const lionRect = { x0: 50, z0: 40, x1: 58, z1: 48 };
    sim.bulldoze({ x0: lionRect.x0 - 1, z0: lionRect.z0 - 1, x1: lionRect.x1 + 1, z1: lionRect.z1 + 1 });
    expect(sim.placeFences(sim.world.edgesAroundRect(lionRect), 4).ok).toBe(true);
    expect(sim.buyAnimal('lion', 54.5 * TILE, 44.5 * TILE).ok).toBe(true);
    // a gazelle loose in the park with no home of its own (e.g. from an old save)
    const gazelle = sim.animalSys.create('gazelle', (EX + 0.5) * TILE, (AVENUE + 0.5) * TILE);
    expect(gazelle.escaped).toBe(true);
    expect(sim.animalSys.homeFor(gazelle)).toBe(zebraHab);
  });
});

describe('fences that do not make a habitat', () => {
  it('warns when a path runs inside, the map edge is used as a side, or the outline cannot close', () => {
    const { sim } = newSim(3);
    const w = sim.world;
    sim.bulldoze({ x0: 0, z0: 0, x1: 16, z1: 16 });
    expect(sim.placePaths([{ x: 10, z: 10 }], PathType.Gravel).ok).toBe(true);
    const ring = w.edgesAroundRect({ x0: 6, z0: 6, x1: 14, z1: 14 });
    const dry = sim.placeFences(ring, 1, true);
    expect(dry.ok).toBe(true);
    expect(dry.warning).toBe('Not a habitat yet: a path runs inside the fence (bulldoze it)');
    const built = sim.placeFences(ring, 1);
    expect(built.ok).toBe(true);
    expect(built.warning).toBe(dry.warning);
    expect(w.habitats.size).toBe(0);
    const buy = sim.buyAnimal('zebra', 8.5 * TILE, 8.5 * TILE, true);
    expect(buy.ok).toBe(false);
    expect(buy.reason).toBe(dry.warning);
    // without the path it is a habitat
    expect(sim.bulldoze({ x0: 10, z0: 10, x1: 10, z1: 10 }).ok).toBe(true);
    expect(w.habitats.size).toBe(1);
    expect(sim.buyAnimal('zebra', 8.5 * TILE, 8.5 * TILE, true).ok).toBe(true);

    // two sides in the map corner
    const corner = [...w.edgesBetweenCorners(0, 4, 4, 4), ...w.edgesBetweenCorners(4, 0, 4, 4)];
    expect(sim.placeFences(corner, 1, true).warning).toBe('Not a habitat yet: the fence must close on every side (the map edge doesn’t count)');
    // ... adding the map-edge sides closes it
    const edges = [...corner, ...w.edgesBetweenCorners(0, 0, 4, 0), ...w.edgesBetweenCorners(0, 0, 0, 4)];
    expect(sim.placeFences(edges, 1, true).warning).toBeUndefined();

    // a rectangle across the starter avenue: the segments over the path are skipped
    const across = sim.placeFences(w.edgesAroundRect({ x0: EX - 3, z0: AVENUE + 3, x1: EX + 3, z1: AVENUE + 7 }), 1, true);
    expect(across.ok).toBe(true);
    expect(across.reason).toMatch(/cannot cross paths/);
    expect(across.warning).toBe('Not a habitat yet: fences can’t cross a path, so this one won’t close');
    // a plain new habitat: no warning
    expect(sim.placeFences(w.edgesAroundRect({ x0: 20, z0: 4, x1: 26, z1: 10 }), 1, true).warning).toBeUndefined();
  });
});

describe('animals drinking and resting', () => {
  it('babies drink by themselves instead of waiting for their mother', () => {
    const { sim } = newSim(5);
    buildZoo(sim);
    hire(sim);
    const [m] = buyHerd(sim, 'zebra', 1);
    const mother = sim.animals.get(m)!;
    const baby = sim.animalSys.create('zebra', mother.x + 1, mother.z, { growth: 0.3, mother: m });
    mother.needs.thirst = mother.needs.hunger = 1;
    baby.needs.thirst = 0.25;
    sim.setSpeed(3);
    for (let i = 0; i < 150; i++) sim.update(0.1);
    expect(baby.needs.thirst).toBeGreaterThan(0.6);
  });

  it('never freezes for long wading towards a drink, and only reports unreachable water when it is', () => {
    const { sim, log } = newSim(30);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 5);
    hire(sim);
    sim.setSpeed(3);
    // per animal: seconds spent walking to a drink without getting anywhere
    const frozen = new Map<number, { x: number; z: number; t: number }>();
    let worst = 0;
    while (sim.day < 4) {
      sim.update(0.25);
      for (const a of sim.animals.values()) {
        const f = frozen.get(a.id);
        if (a.goal !== 'drink' || !a.moving || !f || Math.hypot(a.x - f.x, a.z - f.z) > 0.5) frozen.set(a.id, { x: a.x, z: a.z, t: sim.time });
        else worst = Math.max(worst, sim.time - f.t);
      }
    }
    expect(worst).toBeLessThan(6);
    expect(texts(log).filter((t) => /reach their water/.test(t))).toEqual([]);
    for (const a of sim.animals.values()) expect(a.needs.thirst).toBeGreaterThan(0.1);
  });

  it('nobody sits in the water, and only waders sleep standing in it', () => {
    const events = new EventBus();
    const sim = createSimulation(events, 42) as Simulation;
    sim.newGame();
    buildDemoZoo(sim);
    sim.setSpeed(3);
    sim.minuteOfDay = 18 * 60; // through the evening into the night
    let wet = 0;
    const bad: string[] = [];
    for (let i = 0; i < 1200; i++) {
      sim.update(0.1);
      for (const a of sim.animals.values()) {
        const sp = SPECIES_BY_ID[a.speciesId];
        if (sp.swims || WATER_LEVEL - a.y <= 0.05) continue;
        wet++;
        if (a.action === 'sit' || (a.action === 'sleep' && sp.rig !== 'bird')) bad.push(`${a.speciesId} ${a.action}`);
      }
    }
    expect(wet).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  }, 30_000); // a full day of the showcase zoo, guests included

  it('names terrain in habitat advice the way the paint palette does', () => {
    const { sim } = newSim(3);
    const hid = buildZoo(sim);
    const issues = sim.suitability('polarbear', hid).issues.join(' | ');
    expect(issues).toMatch(/Needs more Snow & Ice/);
    expect(issues).toMatch(/Too much Savanna Grass/);
  });
});

describe('refunds', () => {
  it('gives nothing back for the free starter scenery and books refunds as income', () => {
    const { sim } = newSim(77);
    const objects = sim.world.objects.size;
    expect(objects).toBeGreaterThan(50);
    const dry = sim.bulldoze({ x0: 0, z0: 0, x1: 71, z1: 71 }, true);
    expect(dry.cost).toBe(0);
    expect(sim.bulldoze({ x0: 0, z0: 0, x1: 71, z1: 71 }).ok).toBe(true);
    expect(sim.world.objects.size).toBe(1); // the gate stays
    expect(sim.money).toBe(START_MONEY);
    expect(sim.today.expenses).toBe(0);
    // things the player bought (even a tree like the free ones) refund 40%, as income
    expect(sim.placeObject('tree_oak', 10, 10, 0).ok).toBe(true);
    const tree = [...sim.world.objects.values()].find((o) => o.defId === 'tree_oak')!;
    const r = sim.removeObject(tree.id);
    expect(r.cost).toBeLessThan(0);
    expect(sim.today.income).toBe(-r.cost);
    expect(sim.today.expenses).toBeGreaterThan(0);
    // ... and a starter path tile, once re-laid by the player, refunds too
    expect(sim.placePaths([{ x: 5, z: 5 }], PathType.Paved).ok).toBe(true);
    expect(sim.bulldoze({ x0: 5, z0: 5, x1: 5, z1: 5 }, true).cost).toBeLessThan(0);
  });
});
