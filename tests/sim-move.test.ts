// Moving animals and objects (UX-12), the sale value preview (UX-8) and the
// bulldoze warning for paths cut off from the entrance (UX-7).

import { describe, expect, it } from 'vitest';
import { TILE } from '../src/core/constants';
import { Terrain } from '../src/core/types';
import { OBJECTS_BY_ID } from '../src/data/objects';
import type { Simulation } from '../src/sim/simulation';
import { AVENUE, EX, EZ, HAB, buildZoo, buyHerd, newSim } from './sim-helpers';

const centre = (x: number, z: number) => ({ x: (x + 0.5) * TILE, z: (z + 0.5) * TILE });
const objectAt = (sim: Simulation, defId: string) => [...sim.world.objects.values()].find((o) => o.defId === defId)!;

/** A second, empty habitat east of HAB (fences only, so it is all lush grass). */
function secondHabitat(sim: Simulation): number {
  const r = { x0: 46, z0: 44, x1: 54, z1: 52 };
  sim.bulldoze({ x0: r.x0 - 1, z0: r.z0 - 1, x1: r.x1 + 1, z1: r.z1 + 1 });
  expect(sim.placeFences(sim.world.edgesAroundRect(r), 2).ok).toBe(true);
  return sim.world.habitatAt(r.x0 + 1, r.z0 + 1)!.id;
}

describe('moveObject', () => {
  it('moves and turns an object for free, keeping its id', () => {
    const { sim } = newSim(21);
    const hid = buildZoo(sim);
    const feeder = objectAt(sim, 'feeder_hay');
    const { id, tx, tz } = feeder;
    const money = sim.money;
    const dry = sim.moveObject(id, tx, tz + 3, 1, true);
    expect(dry).toMatchObject({ ok: true, cost: 0 });
    expect(sim.world.objectAt(tx, tz)?.id).toBe(id); // a dry run changes nothing
    const r = sim.moveObject(id, tx, tz + 3, 1);
    expect(r).toMatchObject({ ok: true, cost: 0 });
    expect(sim.money).toBe(money);
    const moved = sim.world.objects.get(id)!;
    expect([moved.tx, moved.tz, moved.rot]).toEqual([tx, tz + 3, 1]);
    expect(sim.world.objectAt(tx, tz + 3)?.id).toBe(id);
    expect(sim.world.objectAt(tx, tz)).toBeUndefined(); // its old spot is free
    expect(sim.world.habitats.get(hid)!.objects).toContain(id);
  });

  it('may overlap its own footprint, but not other objects', () => {
    const { sim } = newSim(22);
    buildZoo(sim);
    const shop = objectAt(sim, 'shop_snack');
    expect(OBJECTS_BY_ID.shop_snack.size).toEqual([2, 2]);
    // one tile diagonally (still beside the avenue) overlaps where it stands now
    const step = sim.moveObject(shop.id, shop.tx + 1, shop.tz - 1, shop.rot, true);
    expect(step.ok).toBe(true);
    const drinks = objectAt(sim, 'shop_drinks');
    const onto = sim.moveObject(shop.id, drinks.tx, drinks.tz, shop.rot, true);
    expect(onto.ok).toBe(false);
    expect(onto.reason).toBe('Tile is occupied');
  });

  it('refuses the entrance and a move to the same spot', () => {
    const { sim } = newSim(23);
    const gate = objectAt(sim, 'entrance_gate');
    expect(sim.moveObject(gate.id, gate.tx - 6, gate.tz - 6, 0, true).ok).toBe(false);
    expect(sim.placeObject('bench', EX + 1, AVENUE + 1, 0).ok).toBe(true);
    const bench = objectAt(sim, 'bench');
    expect(sim.moveObject(bench.id, bench.tx, bench.tz, bench.rot, true).ok).toBe(false);
    expect(sim.moveObject(bench.id, bench.tx, bench.tz, bench.rot + 1, true).ok).toBe(true);
  });

  it('keeps the free starter scenery free (no refund exploit)', () => {
    const { sim } = newSim(24);
    const tree = [...sim.world.objects.values()].find((o) => OBJECTS_BY_ID[o.defId]?.category === 'tree' && o.id <= sim.starterObjectMaxId)!;
    let target: { x: number; z: number } | null = null;
    for (let z = 2; z < 30 && !target; z++)
      for (let x = 2; x < 30 && !target; x++) if (sim.moveObject(tree.id, x, z, 0, true).ok) target = { x, z };
    expect(target).not.toBeNull();
    expect(sim.moveObject(tree.id, target!.x, target!.z, 0).ok).toBe(true);
    expect(sim.removeObject(tree.id, true).cost).toBe(0);
  });
});

describe('moveAnimal', () => {
  it('moves an animal within its habitat and to another one, for free', () => {
    const { sim } = newSim(31);
    const hid = buildZoo(sim);
    const hid2 = secondHabitat(sim);
    const [id] = buyHerd(sim, 'zebra', 1);
    const money = sim.money;
    const near = centre(HAB.x0 + 2, HAB.z0 + 2);
    expect(sim.moveAnimal(id, near.x, near.z)).toMatchObject({ ok: true, cost: 0 });
    let a = sim.animals.get(id)!;
    expect([a.x, a.z, a.habitatId]).toEqual([near.x, near.z, hid]);
    const there = centre(50, 48);
    const dry = sim.moveAnimal(id, there.x, there.z, true);
    expect(dry.ok).toBe(true);
    expect(sim.animals.get(id)!.habitatId).toBe(hid); // dry run
    expect(sim.moveAnimal(id, there.x, there.z).ok).toBe(true);
    a = sim.animals.get(id)!;
    expect(a.habitatId).toBe(hid2);
    expect(sim.money).toBe(money);
    // it stays there: a few seconds of simulation don't send it "home"
    for (let i = 0; i < 60; i++) sim.update(0.1);
    expect(sim.animals.get(id)!.habitatId).toBe(hid2);
    expect(sim.habitatReport(hid2)!.animals).toContain(id);
  });

  it('applies the adoption spot rules', () => {
    const { sim } = newSim(32);
    buildZoo(sim);
    const [id] = buyHerd(sim, 'zebra', 1);
    const outside = centre(EX + 3, AVENUE + 3);
    expect(sim.moveAnimal(id, outside.x, outside.z, true).ok).toBe(false);
    expect(sim.paintTerrain({ x0: HAB.x0 + 1, z0: HAB.z1 - 1, x1: HAB.x0 + 2, z1: HAB.z1 - 1 }, Terrain.DeepWater).ok).toBe(true);
    const pool = centre(HAB.x0 + 1, HAB.z1 - 1);
    const r = sim.moveAnimal(id, pool.x, pool.z, true);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/can’t swim/);
  });

  it('leaves escaped animals to the staff', () => {
    const { sim } = newSim(33);
    buildZoo(sim);
    const [id] = buyHerd(sim, 'zebra', 1);
    sim.animals.get(id)!.escaped = true;
    const spot = centre(HAB.x0 + 3, HAB.z0 + 3);
    const r = sim.moveAnimal(id, spot.x, spot.z, true);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/on the loose/);
  });
});

describe('sellAnimal dry run', () => {
  it('reports what the sale fetches without selling', () => {
    const { sim } = newSim(41);
    buildZoo(sim);
    const [id] = buyHerd(sim, 'zebra', 1);
    const dry = sim.sellAnimal(id, true);
    expect(dry.ok).toBe(true);
    expect(dry.cost).toBeLessThan(0);
    expect(sim.animals.has(id)).toBe(true);
    const money = sim.money;
    const r = sim.sellAnimal(id);
    expect(r.cost).toBe(dry.cost);
    expect(sim.money).toBe(money - dry.cost);
  });
});

describe('bulldoze path warning', () => {
  it('warns when guests would be cut off from part of the path network', () => {
    const { sim } = newSim(51);
    // one tile of the entrance avenue: the crossbar and the rest of the avenue are stranded
    const cut = sim.bulldoze({ x0: EX, z0: EZ - 6, x1: EX, z1: EZ - 6 }, true);
    expect(cut.ok).toBe(true);
    expect(cut.warning).toBe('Cuts 24 path tiles off from the entrance — guests can’t get there');
    // the far end of the crossbar is a dead end: nothing else is stranded
    const tip = sim.bulldoze({ x0: EX + 8, z0: AVENUE, x1: EX + 8, z1: AVENUE }, true);
    expect(tip.ok).toBe(true);
    expect(tip.warning).toBeUndefined();
  });
});
