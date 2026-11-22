// Showcase zoo used for screenshots, integration testing and as an optional
// "sandbox" start. Built entirely through the public simulation commands so it
// also exercises the real build rules.

import { ENTRANCE_TILE } from './core/constants';
import type { ISimulation } from './core/contracts';
import type { TileRect } from './core/events';
import { PathType, Terrain } from './core/types';
import { Noise, Rng } from './core/rng';

interface HabitatPlan {
  name: string;
  rect: TileRect;
  fence: number; // default fence id
  viewFence?: number; // fence used on the side facing the main path (south edge)
  base: Terrain;
  patches: { t: Terrain; frac: number; scale: number }[];
  pond?: { cx: number; cz: number; rx: number; rz: number; deep: boolean };
  objects: { id: string; n: number }[];
  animals: { species: string; n: number }[];
}

export interface DemoReport {
  failures: string[];
  animals: number;
  objects: number;
}

export function buildDemoZoo(sim: ISimulation, seed = 4242): DemoReport {
  const w = sim.world;
  const rng = new Rng(seed);
  const noise = new Noise(seed);
  const failures: string[] = [];
  const startMoney = sim.money;
  sim.money = 5_000_000;

  const ok = (what: string, r: { ok: boolean; reason?: string }) => {
    if (!r.ok) failures.push(`${what}: ${r.reason ?? 'failed'}`);
    return r.ok;
  };

  // ------------------------------------------------------------------ paths
  const ex = ENTRANCE_TILE.x;
  const ez = ENTRANCE_TILE.z;
  const avenueZ = ez - 14; // the starter T-junction row
  const path: { x: number; z: number }[] = [];
  const line = (x0: number, z0: number, x1: number, z1: number) => {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) path.push({ x, z });
  };
  line(8, avenueZ, 63, avenueZ); // southern promenade
  line(8, 10, 8, avenueZ); // west walk
  line(63, 10, 63, avenueZ); // east walk
  line(8, 10, 63, 10); // northern walk
  line(36, 10, 36, avenueZ); // central spine
  line(37, 27, 62, 27); // east cross walk
  // tiles over the natural pond become a timber boardwalk
  const isWet = (t: { x: number; z: number }) => {
    const ter = w.getTerrain(t.x, t.z);
    return ter === Terrain.Water || ter === Terrain.DeepWater;
  };
  ok('paths', sim.placePaths(path.filter((t) => !isWet(t)), PathType.Paved));
  const wet = path.filter(isWet);
  if (wet.length) ok('boardwalk', sim.placePaths(wet, PathType.Boardwalk));

  // --------------------------------------------------------------- habitats
  const plans: HabitatPlan[] = [
    {
      name: 'Savanna Plains',
      rect: { x0: 11, z0: 39, x1: 33, z1: avenueZ - 2 },
      fence: 2,
      viewFence: 4,
      base: Terrain.DryGrass,
      patches: [
        { t: Terrain.Dirt, frac: 0.22, scale: 0.18 },
        { t: Terrain.Grass, frac: 0.1, scale: 0.25 },
      ],
      pond: { cx: 27, cz: 44, rx: 3, rz: 2, deep: false },
      objects: [
        { id: 'tree_acacia', n: 9 },
        { id: 'tree_baobab', n: 1 },
        { id: 'bush_savanna', n: 12 },
        { id: 'grass_tall', n: 10 },
        { id: 'rock_small', n: 5 },
        { id: 'feeder_hay', n: 2 },
        { id: 'water_trough', n: 1 },
      ],
      animals: [
        { species: 'giraffe', n: 3 },
        { species: 'zebra', n: 5 },
        { species: 'gazelle', n: 5 },
      ],
    },
    {
      name: 'Lion Kopje',
      rect: { x0: 38, z0: 39, x1: 61, z1: avenueZ - 2 },
      fence: 3,
      viewFence: 4,
      base: Terrain.DryGrass,
      patches: [
        { t: Terrain.Rock, frac: 0.15, scale: 0.2 },
        { t: Terrain.Dirt, frac: 0.2, scale: 0.15 },
      ],
      pond: { cx: 56, cz: 42, rx: 2, rz: 1.5, deep: false },
      objects: [
        { id: 'rock_outcrop', n: 3 },
        { id: 'rock_boulder', n: 6 },
        { id: 'tree_acacia', n: 6 },
        { id: 'grass_tall', n: 14 },
        { id: 'log_fallen', n: 2 },
        { id: 'shelter_cave', n: 1 },
        { id: 'feeder_meat', n: 1 },
      ],
      animals: [{ species: 'lion', n: 4 }],
    },
    {
      name: 'Elephant Valley',
      rect: { x0: 11, z0: 12, x1: 33, z1: 36 },
      fence: 5,
      base: Terrain.DryGrass,
      patches: [
        { t: Terrain.Dirt, frac: 0.25, scale: 0.15 },
        { t: Terrain.Mud, frac: 0.08, scale: 0.3 },
      ],
      pond: { cx: 19, cz: 22, rx: 4, rz: 3, deep: false },
      objects: [
        { id: 'water_trough', n: 1 },
        { id: 'tree_acacia', n: 6 },
        { id: 'tree_baobab', n: 2 },
        { id: 'rock_boulder', n: 6 },
        { id: 'bush_savanna', n: 8 },
        { id: 'feeder_hay', n: 2 },
        { id: 'toy_ball', n: 1 },
        { id: 'shelter_wood', n: 1 },
      ],
      animals: [
        { species: 'elephant', n: 4 },
        { species: 'rhino', n: 2 },
      ],
    },
    {
      name: 'Polar Coast',
      rect: { x0: 38, z0: 12, x1: 48, z1: 25 },
      fence: 4,
      base: Terrain.Snow,
      patches: [{ t: Terrain.Rock, frac: 0.2, scale: 0.3 }],
      pond: { cx: 43, cz: 21, rx: 4, rz: 3, deep: true },
      objects: [
        { id: 'rock_ice', n: 8 },
        { id: 'rock_boulder', n: 3 },
        { id: 'shelter_cave', n: 1 },
      ],
      animals: [{ species: 'penguin', n: 10 }],
    },
    {
      name: 'Tiger Forest',
      rect: { x0: 51, z0: 12, x1: 61, z1: 25 },
      fence: 5,
      base: Terrain.Grass,
      patches: [{ t: Terrain.Rock, frac: 0.12, scale: 0.3 }],
      pond: { cx: 56, cz: 22, rx: 2.5, rz: 2, deep: true },
      objects: [
        { id: 'tree_oak', n: 4 },
        { id: 'bamboo', n: 5 },
        { id: 'bush_fern', n: 8 },
        { id: 'rock_outcrop', n: 1 },
        { id: 'log_fallen', n: 1 },
        { id: 'feeder_meat', n: 1 },
      ],
      animals: [{ species: 'tiger', n: 2 }],
    },
    {
      name: 'Flamingo Lagoon',
      rect: { x0: 38, z0: 29, x1: 48, z1: 36 },
      fence: 1,
      base: Terrain.Mud,
      patches: [{ t: Terrain.Sand, frac: 0.25, scale: 0.3 }],
      pond: { cx: 43, cz: 32, rx: 4, rz: 2.5, deep: false },
      objects: [
        { id: 'reeds', n: 10 },
        { id: 'tree_palm', n: 3 },
      ],
      animals: [{ species: 'flamingo', n: 12 }],
    },
    {
      name: 'Gorilla Grove',
      rect: { x0: 51, z0: 29, x1: 61, z1: 36 },
      fence: 4,
      base: Terrain.Grass,
      patches: [{ t: Terrain.Dirt, frac: 0.15, scale: 0.3 }],
      objects: [
        { id: 'tree_palm', n: 3 },
        { id: 'tree_oak', n: 2 },
        { id: 'bamboo', n: 4 },
        { id: 'bush_fern', n: 6 },
        { id: 'climbing_frame', n: 1 },
        { id: 'log_fallen', n: 1 },
        { id: 'water_trough', n: 1 },
        { id: 'shelter_wood', n: 1 },
      ],
      animals: [{ species: 'gorilla', n: 4 }],
    },
  ];

  for (const p of plans) {
    const r = p.rect;
    // clear the ground (wild trees / rocks from the starter map)
    sim.bulldoze(r);
    // terrain
    ok(`${p.name} base`, sim.paintTerrain(r, p.base));
    for (const patch of p.patches) {
      for (let z = r.z0; z <= r.z1; z++)
        for (let x = r.x0; x <= r.x1; x++) {
          const v = noise.fbm2(x * patch.scale + patch.t * 13.1, z * patch.scale, 2) * 0.5 + 0.5;
          if (v < patch.frac * 1.6 && rng.chance(0.9)) sim.paintTerrain({ x0: x, z0: z, x1: x, z1: z }, patch.t);
        }
    }
    if (p.pond) {
      const pd = p.pond;
      for (let z = Math.floor(pd.cz - pd.rz - 1); z <= Math.ceil(pd.cz + pd.rz + 1); z++)
        for (let x = Math.floor(pd.cx - pd.rx - 1); x <= Math.ceil(pd.cx + pd.rx + 1); x++) {
          if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
          const d = Math.hypot((x - pd.cx) / pd.rx, (z - pd.cz) / pd.rz) + noise.noise2(x * 0.4, z * 0.4) * 0.15;
          if (d < 0.6 && pd.deep) sim.paintTerrain({ x0: x, z0: z, x1: x, z1: z }, Terrain.DeepWater);
          else if (d < 1) sim.paintTerrain({ x0: x, z0: z, x1: x, z1: z }, Terrain.Water);
        }
    }
    // fence: view side (south edge) may use a different fence
    const edges = w.edgesAroundRect(r);
    const south = edges.filter((e) => e.dir === 'h' && e.z === r.z1 + 1);
    const rest = edges.filter((e) => !(e.dir === 'h' && e.z === r.z1 + 1));
    ok(`${p.name} fence`, sim.placeFences(rest, p.fence));
    ok(`${p.name} view fence`, sim.placeFences(south, p.viewFence ?? p.fence));
    const hab = w.habitatAt(r.x0 + 1, r.z0 + 1);
    if (!hab) {
      failures.push(`${p.name}: enclosure not detected`);
      continue;
    }
    w.renameHabitat(hab.id, p.name);
    // objects
    for (const o of p.objects) {
      let placed = 0;
      for (let attempt = 0; attempt < o.n * 25 && placed < o.n; attempt++) {
        const x = rng.int(r.x0, r.x1);
        const z = rng.int(r.z0, r.z1);
        const res = sim.placeObject(o.id, x, z, rng.int(0, 3));
        if (res.ok) placed++;
      }
      if (placed < o.n) failures.push(`${p.name}: placed ${placed}/${o.n} ${o.id}`);
    }
    // animals
    for (const a of p.animals) {
      for (let i = 0; i < a.n; i++) {
        for (let attempt = 0; attempt < 30; attempt++) {
          const x = rng.int(r.x0 + 1, r.x1 - 1);
          const z = rng.int(r.z0 + 1, r.z1 - 1);
          const t = w.getTerrain(x, z);
          if (w.isTileSolid(x, z)) continue;
          if (t === Terrain.DeepWater && a.species !== 'penguin') continue;
          const res = sim.buyAnimal(a.species, (x + 0.5) * 2, (z + 0.5) * 2);
          if (res.ok) break;
          if (attempt === 29) failures.push(`${p.name}: buy ${a.species}: ${res.reason}`);
        }
      }
    }
  }

  // ------------------------------------------------------- guest facilities
  const guestObjects: { id: string; x: number; z: number; rot: number }[] = [
    { id: 'shop_snack', x: ex + 2, z: avenueZ + 1, rot: 0 },
    { id: 'shop_drinks', x: ex - 2, z: avenueZ + 1, rot: 0 },
    { id: 'shop_icecream', x: ex - 4, z: avenueZ + 1, rot: 0 },
    { id: 'restroom', x: ex + 4, z: avenueZ + 1, rot: 0 },
    { id: 'shop_gift', x: ex - 8, z: avenueZ + 1, rot: 0 },
    { id: 'fountain', x: ex + 1, z: avenueZ + 6, rot: 0 },
    { id: 'picnic_table', x: ex - 1, z: avenueZ + 4, rot: 1 },
    { id: 'picnic_table', x: ex - 1, z: avenueZ + 6, rot: 1 },
    { id: 'info_sign', x: 20, z: avenueZ + 1, rot: 2 },
    { id: 'info_sign', x: 48, z: avenueZ + 1, rot: 2 },
    { id: 'donation_box', x: 30, z: avenueZ + 1, rot: 2 },
    { id: 'shop_drinks', x: 37, z: 18, rot: 1 },
    { id: 'restroom', x: 64, z: 40, rot: 3 },
  ];
  for (const g of guestObjects) {
    const res = sim.placeObject(g.id, g.x, g.z, g.rot);
    if (!res.ok) {
      // try a few nearby spots along the path
      let done = false;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [2, 0],
        [-2, 0],
        [0, 2],
      ]) {
        if (sim.placeObject(g.id, g.x + dx, g.z + dz, g.rot).ok) {
          done = true;
          break;
        }
      }
      if (!done) failures.push(`facility ${g.id}: ${res.reason}`);
    }
  }
  // benches, bins and lamps along the promenade
  for (let x = 10; x <= 61; x += 6) {
    sim.placeObject('lamp', x, avenueZ + 1, 0);
    sim.placeObject(x % 12 === 4 ? 'bench' : 'bin', x + 2, avenueZ + 1, 2);
  }
  for (let z = 14; z <= avenueZ - 2; z += 7) {
    sim.placeObject('lamp', 9, z, 0);
    sim.placeObject('bench', 35, z, 1);
    sim.placeObject('lamp', 62, z, 0);
  }
  for (let x = 12; x < 60; x += 9) sim.placeObject('flower_bed', x, avenueZ + 2, 0);

  // ------------------------------------------------------------------ staff
  const staffSpots: [Parameters<ISimulation['hireStaff']>[0], number, number][] = [
    ['keeper', 36, 40],
    ['keeper', 36, 20],
    ['keeper', 63, 30],
    ['groundskeeper', ex, avenueZ],
    ['groundskeeper', 8, 30],
    ['vet', 36, 30],
  ];
  for (const [role, x, z] of staffSpots) ok(`hire ${role}`, sim.hireStaff(role, (x + 0.5) * 2, (z + 0.5) * 2));

  sim.money = Math.max(startMoney, 85_000);
  return { failures, animals: sim.animals.size, objects: w.objects.size };
}
