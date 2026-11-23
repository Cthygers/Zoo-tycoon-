import { describe, expect, it } from 'vitest';
import { ENTRANCE_TILE, MAP_W, START_MONEY, TILE, WATER_LEVEL } from '../src/core/constants';
import { EventBus, type GameEvents } from '../src/core/events';
import { PathType, Terrain } from '../src/core/types';
import { buildDemoZoo } from '../src/demo';
import { OBJECTS_BY_ID } from '../src/data/objects';
import { SPECIES_BY_ID } from '../src/data/species';
import { createSimulation } from '../src/sim';
import { QP_INSIDE, QP_SERVE } from '../src/sim/queues';
import type { Simulation } from '../src/sim/simulation';

const EX = ENTRANCE_TILE.x;
const EZ = ENTRANCE_TILE.z;
const AVENUE = EZ - 14; // starter T-junction row
/** Habitat rect north of the starter avenue; a viewing path runs along its south fence. */
const HAB = { x0: 30, z0: 44, x1: 42, z1: 54 };

function newSim(seed = 7): { sim: Simulation; events: EventBus; log: { type: keyof GameEvents; payload: unknown }[] } {
  const events = new EventBus();
  const log: { type: keyof GameEvents; payload: unknown }[] = [];
  for (const t of ['notify', 'guestAdded', 'guestRemoved', 'objectiveCompleted', 'dayChanged', 'animalAdded', 'animalRemoved'] as const)
    events.on(t, (p) => log.push({ type: t, payload: p }));
  const sim = createSimulation(events, seed) as Simulation;
  sim.newGame();
  return { sim, events, log };
}

/** Build a small savanna habitat with a viewing path and guest facilities using only commands. */
function buildZoo(sim: Simulation, fenceId = 2) {
  const w = sim.world;
  sim.bulldoze({ x0: HAB.x0 - 1, z0: HAB.z0 - 1, x1: HAB.x1 + 1, z1: HAB.z1 + 2 }); // clear wild trees
  const path: { x: number; z: number }[] = [];
  for (let x = HAB.x0 - 2; x <= HAB.x1 + 2; x++) path.push({ x, z: HAB.z1 + 2 });
  for (let z = HAB.z1 + 2; z <= AVENUE; z++) path.push({ x: EX, z });
  const rp = sim.placePaths(path, PathType.Paved);
  expect(rp.ok).toBe(true);
  expect(sim.paintTerrain(HAB, Terrain.DryGrass).ok).toBe(true);
  expect(sim.paintTerrain({ x0: 33, z0: 47, x1: 35, z1: 48 }, Terrain.Water).ok).toBe(true);
  expect(sim.paintTerrain({ x0: 38, z0: 46, x1: 41, z1: 49 }, Terrain.Dirt).ok).toBe(true);
  const fence = sim.placeFences(w.edgesAroundRect(HAB), fenceId);
  expect(fence.ok).toBe(true);
  const hab = w.habitatAt(HAB.x0 + 1, HAB.z0 + 1)!;
  expect(hab).toBeTruthy();
  expect(hab.viewTiles.length).toBeGreaterThan(5);
  for (const [id, x, z] of [
    ['feeder_hay', 37, 46],
    ['tree_acacia', 31, 45],
    ['tree_acacia', 41, 52],
    ['bush_savanna', 32, 52],
    ['bush_savanna', 40, 45],
    ['grass_tall', 35, 51],
    ['water_trough', 31, 50],
  ] as const)
    expect(sim.placeObject(id, x, z, 0).ok).toBe(true);
  // guest facilities along the avenue
  expect(sim.placeObject('shop_snack', EX + 1, AVENUE + 2, 0).ok).toBe(true);
  expect(sim.placeObject('shop_drinks', EX - 1, AVENUE + 2, 0).ok).toBe(true);
  expect(sim.placeObject('restroom', EX + 1, AVENUE + 5, 0).ok).toBe(true);
  expect(sim.placeObject('bench', EX - 1, AVENUE + 4, 1).ok).toBe(true);
  expect(sim.placeObject('bin', EX - 1, AVENUE + 1, 0).ok).toBe(true);
  return hab.id;
}

function buyHerd(sim: Simulation, species: string, n: number) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = (HAB.x0 + 2 + (i % 4) * 2 + 0.5) * TILE;
    const z = (HAB.z0 + 6 + Math.floor(i / 4) + 0.5) * TILE;
    const r = sim.buyAnimal(species, x, z);
    expect(r.ok).toBe(true);
    ids.push(Math.max(...sim.animals.keys()));
  }
  return ids;
}

function hire(sim: Simulation) {
  expect(sim.hireStaff('keeper', (EX + 0.5) * TILE, (AVENUE + 0.5) * TILE).ok).toBe(true);
  expect(sim.hireStaff('groundskeeper', (EX + 0.5) * TILE, (AVENUE - 3 + 0.5) * TILE).ok).toBe(true);
}

describe('commands', () => {
  it('dry runs report cost without changing anything', () => {
    const { sim } = newSim();
    const rev = sim.world.revision;
    const money = sim.money;
    const r = sim.paintTerrain({ x0: 2, z0: 2, x1: 4, z1: 4 }, Terrain.Sand, true);
    expect(r.ok).toBe(true);
    expect(r.cost).toBe(9 * sim.terrainCost(Terrain.Sand));
    const w = sim.paintTerrain({ x0: 2, z0: 2, x1: 3, z1: 3 }, Terrain.Water, true);
    expect(w.cost).toBe(4 * sim.terrainCost(Terrain.Water));
    expect(sim.terrainCost(Terrain.Water)).toBeGreaterThan(sim.terrainCost(Terrain.Grass));
    expect(sim.terrainCost(Terrain.DeepWater)).toBeGreaterThan(sim.terrainCost(Terrain.Water));
    expect(sim.placeFences(sim.world.edgesAroundRect({ x0: 2, z0: 2, x1: 4, z1: 4 }), 1, true).cost).toBe(12 * 30);
    expect(sim.world.revision).toBe(rev);
    expect(sim.money).toBe(money);
  });

  it('validates terrain, paths, objects and protects the entrance', () => {
    const { sim } = newSim();
    // cannot flood the entrance path
    const flood = sim.paintTerrain({ x0: EX, z0: EZ - 1, x1: EX, z1: EZ - 1 }, Terrain.Water);
    expect(flood.ok).toBe(false);
    expect(flood.reason).toMatch(/path/i);
    // paths cannot cross water except as boardwalk
    sim.paintTerrain({ x0: 5, z0: 60, x1: 5, z1: 60 }, Terrain.Water);
    expect(sim.placePaths([{ x: 5, z: 60 }], PathType.Paved).ok).toBe(false);
    expect(sim.placePaths([{ x: 5, z: 60 }], PathType.Boardwalk).ok).toBe(true);
    // shops need path access
    const shop = sim.placeObject('shop_drinks', 3, 3, 0);
    expect(shop.ok).toBe(false);
    expect(shop.reason).toMatch(/path/i);
    // the gate survives bulldozing; plaza paths too
    const before = [...sim.world.objects.values()].filter((o) => o.defId === 'entrance_gate').length;
    sim.bulldoze({ x0: EX - 3, z0: EZ - 3, x1: EX + 3, z1: EZ });
    expect([...sim.world.objects.values()].filter((o) => o.defId === 'entrance_gate').length).toBe(before);
    expect(sim.world.isPath(EX, EZ)).toBe(true);
  });

  it('charges money, refunds bulldozing and replacing fences', () => {
    const { sim } = newSim();
    const m0 = sim.money;
    const edges = sim.world.edgesAroundRect({ x0: 5, z0: 5, x1: 9, z1: 9 });
    sim.bulldoze({ x0: 4, z0: 4, x1: 10, z1: 10 });
    const m1 = sim.money;
    expect(m1).toBeGreaterThanOrEqual(m0);
    const r = sim.placeFences(edges, 1);
    expect(r.ok).toBe(true);
    expect(sim.money).toBe(m1 - edges.length * 30);
    expect(sim.world.habitats.size).toBe(1);
    // upgrade to stone: pays new minus 40% of old
    const up = sim.placeFences(edges, 3);
    expect(up.cost).toBe(edges.length * (90 - 12));
    // same type again is skipped
    expect(sim.placeFences(edges, 3).ok).toBe(false);
    const m2 = sim.money;
    const del = sim.removeFences(edges);
    expect(del.ok).toBe(true);
    expect(sim.money).toBe(m2 + edges.length * 36);
    expect(sim.world.habitats.size).toBe(0);
    expect(sim.today.construction).toBeGreaterThan(0);
  });

  it('adopts animals only inside habitats, warns about weak fences, sells for half', () => {
    const { sim } = newSim();
    const hid = buildZoo(sim, 1);
    const out = sim.buyAnimal('zebra', 5 * TILE, 5 * TILE);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/habitat/i);
    const lion = sim.buyAnimal('lion', (HAB.x0 + 3.5) * TILE, (HAB.z0 + 3.5) * TILE, true);
    expect(lion.ok).toBe(true);
    expect(lion.reason).toMatch(/fence/i);
    const before = sim.money;
    const z = sim.buyAnimal('zebra', (HAB.x0 + 3.5) * TILE, (HAB.z0 + 3.5) * TILE);
    expect(z.ok).toBe(true);
    expect(sim.money).toBe(before - 3500);
    const a = [...sim.animals.values()][0];
    expect(a.habitatId).toBe(hid);
    expect(a.growth).toBe(1);
    expect(['M', 'F']).toContain(a.sex);
    const sale = sim.sellAnimal(a.id);
    expect(sale.ok).toBe(true);
    expect(sim.money).toBe(before - 3500 + 1750);
    expect(sim.animals.size).toBe(0);
  });

  it('blocks purchases when broke without crashing', () => {
    const { sim } = newSim();
    buildZoo(sim);
    sim.money = 100;
    const r = sim.buyAnimal('elephant', (HAB.x0 + 3.5) * TILE, (HAB.z0 + 3.5) * TILE);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/money/i);
    sim.money = -500;
    expect(sim.placeObject('bench', EX - 1, AVENUE + 8, 1).ok).toBe(false);
    expect(() => {
      for (let i = 0; i < 100; i++) sim.update(0.1);
    }).not.toThrow();
  });
});

describe('object, habitat and pricing commands', () => {
  it('removes a single object with a partial refund, leaving paths and fences', () => {
    const { sim, events } = newSim(12);
    const hid = buildZoo(sim);
    const w = sim.world;
    const feeder = [...w.objects.values()].find((o) => o.defId === 'feeder_hay')!;
    expect(w.habitats.get(hid)!.objects).toContain(feeder.id);
    const fences = w.hFence.reduce((n, f) => n + (f ? 1 : 0), 0) + w.vFence.reduce((n, f) => n + (f ? 1 : 0), 0);
    const paths = w.path.reduce((n, p) => n + (p ? 1 : 0), 0);
    const removed: number[] = [];
    events.on('objectRemoved', (e) => removed.push(e.id));
    const rev = w.revision;
    const m0 = sim.money;
    const dry = sim.removeObject(feeder.id, true);
    expect(dry.ok).toBe(true);
    expect(dry.cost).toBe(-Math.round(OBJECTS_BY_ID.feeder_hay.cost * 0.4));
    expect(w.revision).toBe(rev);
    expect(sim.money).toBe(m0);
    const r = sim.removeObject(feeder.id);
    expect(r.ok).toBe(true);
    expect(sim.money).toBe(m0 - dry.cost);
    expect(w.objects.has(feeder.id)).toBe(false);
    expect(removed).toEqual([feeder.id]);
    expect(w.habitats.get(hid)!.objects).not.toContain(feeder.id);
    expect(w.hFence.reduce((n, f) => n + (f ? 1 : 0), 0) + w.vFence.reduce((n, f) => n + (f ? 1 : 0), 0)).toBe(fences);
    expect(w.path.reduce((n, p) => n + (p ? 1 : 0), 0)).toBe(paths);
    expect(sim.removeObject(feeder.id).ok).toBe(false);
    const gate = [...w.objects.values()].find((o) => o.defId === 'entrance_gate')!;
    expect(sim.removeObject(gate.id).ok).toBe(false);
    expect(w.objects.has(gate.id)).toBe(true);
  });

  it('sends guests elsewhere when the shop they queue at is removed', () => {
    const { sim } = newSim(13);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 4);
    hire(sim);
    sim.setSpeed(3);
    sim.minuteOfDay = 9 * 60;
    let shop = 0;
    for (let i = 0; i < 6000 && !shop; i++) {
      sim.update(0.1);
      for (const p of sim.guestSys.queues.points.values()) if (p.line.length >= 1 && p.service !== 'restroom' && p.serving.some(Boolean)) shop = p.obj;
    }
    expect(shop).toBeGreaterThan(0);
    const users = [...sim.guests.values()].filter((g) => g.qObj === shop);
    expect(users.length).toBeGreaterThan(0);
    expect(sim.removeObject(shop).ok).toBe(true);
    sim.update(0.01);
    expect(sim.guestSys.queues.points.has(shop)).toBe(false);
    for (const g of users) {
      expect(g.qObj).not.toBe(shop);
      if (!g.qObj) expect(g.hidden).toBe(false);
    }
    expect(() => {
      for (let i = 0; i < 300; i++) sim.update(0.1);
    }).not.toThrow();
  });

  it('renames habitats with validation', () => {
    const { sim, events } = newSim(14);
    const hid = buildZoo(sim);
    let changed = 0;
    events.on('habitatsChanged', () => changed++);
    const r = sim.renameHabitat(hid, '   Zebra   Flats  ');
    expect(r.ok).toBe(true);
    expect(r.cost).toBe(0);
    expect(sim.world.habitats.get(hid)!.name).toBe('Zebra Flats');
    expect(changed).toBeGreaterThan(0);
    expect(sim.renameHabitat(hid, '   ').ok).toBe(false);
    expect(sim.world.habitats.get(hid)!.name).toBe('Zebra Flats');
    expect(sim.renameHabitat(9999, 'Nowhere').ok).toBe(false);
    sim.renameHabitat(hid, 'A very long habitat name that goes on and on forever');
    expect(sim.world.habitats.get(hid)!.name.length).toBeLessThanOrEqual(32);
    sim.renameHabitat(hid, 'Tab\tand\nnewline');
    expect(sim.world.habitats.get(hid)!.name).toBe('Tab and newline');
    // names survive save/load
    const sim2 = createSimulation(new EventBus(), 2) as Simulation;
    sim2.newGame();
    sim2.load(JSON.parse(JSON.stringify(sim.serialize())));
    expect(sim2.world.habitats.get(hid)!.name).toBe('Tab and newline');
  });

  it('prices staff and terrain', () => {
    const { sim } = newSim();
    expect(sim.staffWage('keeper')).toBe(40);
    expect(sim.staffWage('groundskeeper')).toBe(30);
    expect(sim.staffWage('vet')).toBe(60);
    const before = sim.money;
    expect(sim.hireStaff('vet', (EX + 0.5) * TILE, (AVENUE + 0.5) * TILE).ok).toBe(true);
    expect(before - sim.money).toBe(sim.staffWage('vet'));
    for (const t of [Terrain.Grass, Terrain.DryGrass, Terrain.Dirt, Terrain.Sand, Terrain.Rock, Terrain.Snow, Terrain.Mud, Terrain.Water, Terrain.DeepWater])
      expect(sim.terrainCost(t)).toBeGreaterThan(0);
  });

  it('turns shops so their counter opens onto the path', () => {
    const { sim } = newSim(15);
    // south of the avenue: only the north side (-Z) touches the path
    expect(sim.placeObject('shop_drinks', EX - 3, AVENUE + 1, 0).ok).toBe(true);
    const o = [...sim.world.objects.values()].find((x) => x.defId === 'shop_drinks')!;
    expect(o.rot).toBe(2);
    const p = sim.guestSys.queues;
    sim.update(0.01);
    const sp = p.points.get(o.id)!;
    expect(sp).toBeTruthy();
    // line places stand on walkable path tiles
    for (let i = 0; i < sp.lx.length; i++) expect(sim.world.isPath(Math.floor(sp.lx[i] / TILE), Math.floor(sp.lz[i] / TILE))).toBe(true);
    expect(sp.lx.length).toBeGreaterThanOrEqual(5);
  });
});

describe('habitat evaluation', () => {
  it('scores terrain, scenery, water, food and social needs with readable issues', () => {
    const { sim } = newSim();
    const hid = buildZoo(sim);
    const zebra = sim.suitability('zebra', hid);
    expect(zebra.fenceOk).toBe(true);
    expect(zebra.hasWater).toBe(true);
    expect(zebra.terrain).toBeGreaterThan(0.5);
    const bear = sim.suitability('polarbear', hid);
    expect(bear.fenceOk).toBe(false);
    expect(bear.issues.some((i) => /Needs more snow \(have 0%, wants 45%\)/.test(i))).toBe(true);
    expect(bear.issues.some((i) => /Fence too weak/.test(i))).toBe(true);
    expect(bear.score).toBeLessThan(zebra.score);
    buyHerd(sim, 'zebra', 1);
    const lonely = sim.habitatReport(hid)!;
    expect(lonely.species).toEqual(['zebra']);
    expect(lonely.suitability[0].issues.some((i) => /Lonely/.test(i))).toBe(true);
    expect(lonely.terrainFractions[Terrain.DryGrass]).toBeGreaterThan(0.5);
    expect(lonely.viewable).toBe(true);
  });

  it('flags predators sharing a habitat with prey and removes stressed prey', () => {
    const { sim, log } = newSim(3);
    const hid = buildZoo(sim, 5);
    hire(sim);
    buyHerd(sim, 'gazelle', 4);
    const r = sim.buyAnimal('lion', (HAB.x0 + 9.5) * TILE, (HAB.z0 + 2.5) * TILE);
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/predators|get along/i);
    expect(sim.suitability('gazelle', hid).issues.some((i) => /Terrified of the lions/.test(i))).toBe(true);
    sim.setSpeed(3);
    let gazelles = 4;
    for (let i = 0; i < 6000 && gazelles === 4; i++) {
      sim.update(0.1);
      gazelles = [...sim.animals.values()].filter((a) => a.speciesId === 'gazelle').length;
    }
    expect(gazelles).toBeLessThan(4);
    expect(log.some((e) => e.type === 'notify' && /sanctuary/.test((e.payload as { text: string }).text))).toBe(true);
  });
});

describe('simulation over several days', () => {
  it('runs a small zoo: money flows, guests come and go, animals stay inside, keepers feed', () => {
    const { sim, log } = newSim(11);
    const hid = buildZoo(sim);
    buyHerd(sim, 'zebra', 5);
    hire(sim);
    const rt = sim.habitatRuntime(hid)!;
    expect(rt.food).toBe(0);
    sim.setSpeed(3);
    let maxFood = 0;
    let animalSamples = 0,
      animalOutside = 0;
    let guestSamples = 0,
      guestOffPath = 0;
    let maxGuests = 0;
    const w = sim.world;
    const startDay = sim.day;
    while (sim.day < startDay + 3) {
      sim.update(0.1);
      maxFood = Math.max(maxFood, sim.habitatRuntime(hid)?.food ?? 0);
      maxGuests = Math.max(maxGuests, sim.guests.size);
      for (const a of sim.animals.values()) {
        animalSamples++;
        const t = w.tileOfWorld(a.x, a.z);
        if (a.escaped || w.habitatOf[w.idx(t.x, t.z)] !== hid || a.habitatId !== hid) animalOutside++;
      }
      for (const g of sim.guests.values()) {
        if (g.phase !== 0) continue;
        guestSamples++;
        const t = w.tileOfWorld(g.x, g.z);
        if (!w.isPath(t.x, t.z)) guestOffPath++;
      }
    }
    // animals never left the habitat
    expect(animalSamples).toBeGreaterThan(1000);
    expect(animalOutside).toBe(0);
    // guests walked on the paths only
    expect(guestSamples).toBeGreaterThan(1000);
    expect(guestOffPath / guestSamples).toBeLessThan(0.002);
    // guests arrived, paid and left
    expect(maxGuests).toBeGreaterThan(5);
    expect(sim.totalVisitors).toBeGreaterThan(20);
    expect(log.filter((e) => e.type === 'guestRemoved').length).toBeGreaterThan(20);
    expect(sim.guests.size).toBe(0); // all gone at night
    // keepers refilled the food
    expect(maxFood).toBeGreaterThan(5);
    // ledger: three closed days with income and expenses
    expect(sim.ledger.length).toBe(3);
    const d1 = sim.ledger[0];
    expect(d1.admissions).toBeGreaterThan(0);
    expect(d1.salaries).toBeGreaterThan(0);
    expect(d1.upkeep).toBeGreaterThan(0);
    expect(d1.construction).toBeGreaterThan(0);
    expect(d1.animalPurchases).toBe(5 * 3500);
    expect(sim.ledger[1].income).toBeGreaterThan(0);
    expect(sim.ledger[1].expenses).toBeGreaterThan(0);
    expect(log.filter((e) => e.type === 'dayChanged').length).toBe(3);
    // animals are cared for
    const animals = [...sim.animals.values()];
    expect(animals.every((a) => a.health > 0.5)).toBe(true);
    const avgHappy = animals.reduce((s, a) => s + a.happiness, 0) / animals.length;
    expect(avgHappy).toBeGreaterThan(0.5);
    // objectives progressed
    const done = sim.objectives.filter((o) => o.done).map((o) => o.id);
    expect(done).toContain('build_habitat');
    expect(done).toContain('first_animal');
    expect(done).toContain('hire_keeper');
    expect(log.some((e) => e.type === 'objectiveCompleted')).toBe(true);
    expect(sim.rating).toBeGreaterThan(20);
  });

  it('keeps the clock and speeds consistent (paused, 1x, 4x with sub-stepping)', () => {
    const { sim } = newSim();
    const m0 = sim.minuteOfDay;
    sim.setSpeed(0);
    sim.update(1);
    expect(sim.minuteOfDay).toBe(m0);
    sim.setSpeed(1);
    sim.update(0.5);
    expect(sim.minuteOfDay).toBeCloseTo(m0 + 2, 5);
    sim.setSpeed(3);
    sim.update(0.25); // 1 simulated second in 0.1 s sub-steps
    expect(sim.minuteOfDay).toBeCloseTo(m0 + 6, 5);
    expect(sim.isOpen()).toBe(false); // 07:36
  });

  it('grows babies and lets them follow their mother', () => {
    const { sim, log } = newSim(5);
    buildZoo(sim);
    hire(sim);
    const [f, m] = buyHerd(sim, 'zebra', 2);
    const mother = sim.animals.get(f)!;
    const father = sim.animals.get(m)!;
    mother.sex = 'F';
    father.sex = 'M';
    (mother as { pregnantDays: number }).pregnantDays = 11.99; // gestation 12 days
    sim.setSpeed(3);
    for (let i = 0; i < 200 && sim.animals.size === 2; i++) sim.update(0.1);
    expect(sim.animals.size).toBe(3);
    const baby = [...sim.animals.values()].find((a) => a.growth < 1)!;
    expect(baby).toBeTruthy();
    expect(log.some((e) => e.type === 'notify' && /gave birth/.test((e.payload as { text: string }).text))).toBe(true);
    const g0 = baby.growth;
    for (let i = 0; i < 900; i++) sim.update(0.1); // one game day
    expect(baby.growth).toBeGreaterThan(g0);
    expect(Math.hypot(baby.x - mother.x, baby.z - mother.z)).toBeLessThan(20);
  });

  it('animals break out of fences that are too weak, and a vet brings them back', () => {
    const { sim, log } = newSim(9);
    buildZoo(sim, 1); // timber fence (strength 1)
    buyHerd(sim, 'lion', 2);
    for (const a of sim.animals.values()) a.happiness = 0.05;
    sim.setSpeed(3);
    let escaped = false;
    for (let i = 0; i < 20000 && !escaped; i++) {
      for (const a of sim.animals.values()) {
        a.happiness = 0.05; // keep them miserable
        a.needs.environment = 0;
      }
      sim.update(0.1);
      escaped = [...sim.animals.values()].some((a) => a.escaped);
    }
    expect(escaped).toBe(true);
    expect(log.some((e) => e.type === 'notify' && /broken out|got out/.test((e.payload as { text: string }).text))).toBe(true);
    const lion = [...sim.animals.values()].find((a) => a.escaped)!;
    const t = sim.world.tileOfWorld(lion.x, lion.z);
    expect(sim.world.habitatOf[sim.world.idx(t.x, t.z)]).toBe(0);
    expect(sim.hireStaff('vet', (EX + 0.5) * TILE, (AVENUE + 0.5) * TILE).ok).toBe(true);
    for (let i = 0; i < 4000 && lion.escaped; i++) sim.update(0.1);
    expect(lion.escaped).toBe(false);
  });
});

describe('guests: queues and families', () => {
  it('queues in order, one customer per counter, with bounded lines and restroom capacity', () => {
    const { sim } = newSim(31);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 5);
    hire(sim);
    sim.setSpeed(3);
    sim.minuteOfDay = 9 * 60;
    let maxLine = 0,
      lines = 0,
      served = 0,
      maxInside = 0;
    const seenServe = new Set<number>();
    for (let i = 0; i < 9000 && sim.day <= 2; i++) {
      sim.update(0.1);
      for (const p of sim.guestSys.queues.points.values()) {
        maxLine = Math.max(maxLine, p.line.length);
        expect(p.line.length).toBeLessThanOrEqual(p.maxQueue);
        if (p.line.length) lines++;
        // place numbers match the order in line
        p.line.forEach((g, k) => expect(g.qPos).toBe(k));
        for (let k = 0; k < p.serving.length; k++) {
          const g = p.serving[k];
          if (!g) continue;
          expect(g.qPos).toBe(QP_SERVE + k);
          seenServe.add(g.id);
        }
        if (p.mode === 'enter') {
          maxInside = Math.max(maxInside, p.busy());
          expect(p.busy()).toBeLessThanOrEqual(p.capacity);
          for (const g of p.inside) expect(g.qPos).toBe(QP_INSIDE);
        }
      }
      served = seenServe.size;
    }
    expect(served).toBeGreaterThan(8);
    expect(lines).toBeGreaterThan(5);
    expect(maxLine).toBeGreaterThanOrEqual(2);
    expect(maxInside).toBeGreaterThan(0);
    expect(sim.today.shopIncome + (sim.ledger.at(-1)?.shopIncome ?? 0)).toBeGreaterThan(0);
  });

  it('children arrive with a parent, follow them and leave together', () => {
    const { sim } = newSim(32);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 5);
    hire(sim);
    sim.setSpeed(3);
    sim.minuteOfDay = 9 * 60;
    let children = 0,
      orphans = 0,
      far = 0,
      samples = 0;
    const left = new Map<number, number>();
    sim.events.on('guestRemoved', (e) => left.set(e.id, sim.time));
    const leaderOf = new Map<number, number>();
    for (let i = 0; i < 9000 && sim.day === 1; i++) {
      sim.update(0.1);
      if (i % 20) continue;
      for (const g of sim.guests.values()) {
        if (!g.appearance.child) continue;
        samples++;
        if (!g.leader) {
          orphans++;
          continue;
        }
        leaderOf.set(g.id, g.leader);
        const l = sim.guests.get(g.leader)!;
        expect(l.party).toContain(g.id);
        expect(l.appearance.child).toBe(false);
        if (!l.hidden && !g.hidden && g.fstate === 0 && Math.hypot(l.x - g.x, l.z - g.z) > 5) far++;
      }
    }
    children = leaderOf.size;
    expect(children).toBeGreaterThan(4);
    expect(orphans).toBe(0);
    expect(far / samples).toBeLessThan(0.03);
    // children left within moments of their parent
    let together = 0,
      both = 0;
    for (const [kid, parent] of leaderOf) {
      if (!left.has(kid) || !left.has(parent)) continue;
      both++;
      if (Math.abs(left.get(kid)! - left.get(parent)!) < 6) together++;
    }
    expect(both).toBeGreaterThan(4);
    expect(together / both).toBeGreaterThan(0.9);
  });

  it('spreads a busy day: no rush to capacity at opening, visitors leave through the evening', () => {
    const events = new EventBus();
    const sim = createSimulation(events, 42) as Simulation;
    sim.newGame();
    buildDemoZoo(sim);
    sim.setSpeed(3);
    sim.minuteOfDay = 7 * 60 + 50;
    const at = new Map<number, number>();
    while (sim.minuteOfDay < 21 * 60) {
      sim.update(0.1);
      const h = Math.floor(sim.minuteOfDay / 60);
      if (!at.has(h)) at.set(h, sim.guests.size);
    }
    expect(at.get(9)!).toBeLessThan(45);
    expect(at.get(11)!).toBeGreaterThan(35);
    expect(at.get(11)!).toBeLessThan(120);
    expect(at.get(16)!).toBeGreaterThan(100);
    expect(at.get(21)!).toBeLessThan(at.get(18)! * 0.75);
    expect(sim.guestsToday).toBeGreaterThan(130);
    expect(sim.stats().avgGuestHappiness).toBeGreaterThan(0.45);
  });
});

describe('animals and water', () => {
  it('non-swimmers only wade shallows; swimmers float in deep water; big bodies stay inside fences', () => {
    const events = new EventBus();
    const sim = createSimulation(events, 42) as Simulation;
    sim.newGame();
    buildDemoZoo(sim);
    sim.setSpeed(3);
    sim.minuteOfDay = 8 * 60;
    const w = sim.world;
    let wading = 0,
      swimming = 0,
      tooDeep = 0,
      noseOut = 0;
    for (let i = 0; i < 1200; i++) {
      sim.update(0.1);
      if (i < 50) continue;
      for (const a of sim.animals.values()) {
        const sp = SPECIES_BY_ID[a.speciesId];
        const depth = WATER_LEVEL - w.heightAt(a.x, a.z);
        const h = sp.height * (0.45 + 0.55 * a.growth);
        if (!sp.swims && depth > 0.05) {
          wading++;
          if (depth > 0.36 * h) tooDeep++;
        }
        if (a.action === 'swim') {
          swimming++;
          expect(sp.swims).toBe(true);
          expect(a.y).toBe(WATER_LEVEL);
        }
        const L = sp.length * 0.4 * (0.45 + 0.55 * a.growth);
        if (w.segmentCrossesFence(a.x, a.z, a.x + Math.sin(a.heading) * L, a.z + Math.cos(a.heading) * L)) noseOut++;
      }
    }
    expect(wading).toBeGreaterThan(100); // flamingos stand in the lagoon margins
    expect(tooDeep).toBe(0);
    expect(swimming).toBeGreaterThan(50); // penguins / tigers swim
    expect(noseOut).toBe(0);
  });
});

describe('persistence', () => {
  it('save → load restores an identical game that continues identically', () => {
    const { sim } = newSim(21);
    const hid = buildZoo(sim);
    sim.world.renameHabitat(hid, 'Zebra Flats');
    buyHerd(sim, 'zebra', 4);
    hire(sim);
    sim.setSpeed(3);
    sim.minuteOfDay = 10 * 60;
    for (let i = 0; i < 120; i++) sim.update(0.1); // ≈ 3 game hours
    expect(sim.guests.size).toBeGreaterThan(0);
    const save = sim.serialize();
    const text = JSON.stringify(save);

    const events2 = new EventBus();
    const sim2 = createSimulation(events2, 999) as Simulation;
    sim2.newGame();
    sim2.load(JSON.parse(text));
    expect(sim2.serialize()).toEqual(save);
    expect(sim2.world.habitats.get(hid)?.name).toBe('Zebra Flats');
    expect(sim2.animals.size).toBe(sim.animals.size);
    expect(sim2.guests.size).toBe(sim.guests.size);
    expect(sim2.money).toBe(sim.money);

    // saves are rounded to the millimetre, so reload the original from the same save:
    // from there both copies evolve identically
    sim.load(JSON.parse(text));
    expect(sim.serialize()).toEqual(save);
    for (let i = 0; i < 400; i++) {
      sim.update(0.1);
      sim2.update(0.1);
    }
    expect(JSON.stringify(sim2.serialize())).toBe(JSON.stringify(sim.serialize()));
  });

  it('keeps the save compact and loads old saves without stored habitat ids', () => {
    const events = new EventBus();
    const sim = createSimulation(events, 42) as Simulation;
    sim.newGame();
    expect(buildDemoZoo(sim).failures).toEqual([]);
    sim.setSpeed(3);
    sim.minuteOfDay = 7 * 60 + 50;
    while (sim.minuteOfDay < 14 * 60) sim.update(0.1);
    expect(sim.guests.size).toBeGreaterThan(100);
    const save = sim.serialize() as unknown as Record<string, unknown> & { world: Record<string, unknown> };
    const text = JSON.stringify(save);
    expect(text.length).toBeLessThan(140_000);
    // no float carries more than 3 decimals
    expect(/\d\.\d{4,}/.test(text)).toBe(false);
    const ids = [...sim.world.habitats.values()].map((h) => [h.id, h.name] as const);
    // an old-format save: no habitatRle in the world, a sample tile per habitat instead
    const old = JSON.parse(text);
    delete old.world.habitatRle;
    old.habitatIds = [...sim.world.habitats.values()].map((h) => [h.id, h.tiles[h.tiles.length >> 1]]);
    const sim2 = createSimulation(new EventBus(), 1) as Simulation;
    sim2.newGame();
    sim2.load(old);
    expect([...sim2.world.habitats.values()].map((h) => [h.id, h.name] as const).sort()).toEqual(ids.slice().sort());
    for (const a of sim2.animals.values()) expect(sim2.world.habitats.has(a.habitatId!)).toBe(true);
    expect(() => {
      for (let i = 0; i < 50; i++) sim2.update(0.1);
    }).not.toThrow();
  });

  it('newGame resets everything', () => {
    const { sim } = newSim(4);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 2);
    hire(sim);
    sim.newGame(5);
    expect(sim.animals.size).toBe(0);
    expect(sim.staff.size).toBe(0);
    expect(sim.world.habitats.size).toBe(0);
    expect(sim.money).toBe(START_MONEY);
    expect(sim.day).toBe(1);
    expect([...sim.world.objects.values()].some((o) => o.defId === 'entrance_gate')).toBe(true);
    expect(sim.world.hFence.some((f) => f !== 0)).toBe(false);
  });
});

describe('performance', () => {
  it('updates a busy zoo (150 guests, ~50 animals) within budget', () => {
    const events = new EventBus();
    const sim = createSimulation(events, 42) as Simulation;
    sim.newGame();
    const report = buildDemoZoo(sim);
    expect(report.failures).toEqual([]);
    sim.setSpeed(3);
    // warm up until the park is full
    for (let i = 0; i < 2000 && sim.guests.size < 140; i++) {
      sim.minuteOfDay = 11 * 60;
      sim.update(0.1);
    }
    expect(sim.guests.size).toBeGreaterThan(120);
    expect(sim.animals.size).toBeGreaterThan(40);
    // measure at 1x, 60 fps
    sim.setSpeed(1);
    const frames = 600;
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) sim.update(1 / 60);
    const avg1 = (performance.now() - t0) / frames;
    // and at 4x
    sim.setSpeed(3);
    const t1 = performance.now();
    for (let i = 0; i < frames; i++) sim.update(1 / 60);
    const avg4 = (performance.now() - t1) / frames;
    expect(avg1).toBeLessThan(2);
    expect(avg4).toBeLessThan(4);
    // tile index sanity for guests
    for (const g of sim.guests.values()) expect(g.tile).toBeGreaterThanOrEqual(0), expect(g.tile).toBeLessThan(MAP_W * MAP_W);
  });
});
