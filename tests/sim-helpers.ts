// Shared helpers for the simulation tests: a fresh game and a small savanna
// habitat with a viewing path and guest facilities, built only with commands.

import { expect } from 'vitest';
import { ENTRANCE_TILE, TILE } from '../src/core/constants';
import { EventBus, type GameEvents } from '../src/core/events';
import { PathType, Terrain } from '../src/core/types';
import { createSimulation } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';

export const EX = ENTRANCE_TILE.x;
export const EZ = ENTRANCE_TILE.z;
export const AVENUE = EZ - 14; // starter T-junction row
/** Habitat rect north of the starter avenue; a viewing path runs along its south fence. */
export const HAB = { x0: 30, z0: 44, x1: 42, z1: 54 };

export function newSim(seed = 7): { sim: Simulation; events: EventBus; log: { type: keyof GameEvents; payload: unknown }[] } {
  const events = new EventBus();
  const log: { type: keyof GameEvents; payload: unknown }[] = [];
  for (const t of ['notify', 'guestAdded', 'guestRemoved', 'objectiveCompleted', 'dayChanged', 'animalAdded', 'animalRemoved'] as const)
    events.on(t, (p) => log.push({ type: t, payload: p }));
  const sim = createSimulation(events, seed) as Simulation;
  sim.newGame();
  return { sim, events, log };
}

/** Build a small savanna habitat with a viewing path and guest facilities using only commands. */
export function buildZoo(sim: Simulation, fenceId = 2) {
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

export function buyHerd(sim: Simulation, species: string, n: number) {
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

export function hire(sim: Simulation) {
  expect(sim.hireStaff('keeper', (EX + 0.5) * TILE, (AVENUE + 0.5) * TILE).ok).toBe(true);
  expect(sim.hireStaff('groundskeeper', (EX + 0.5) * TILE, (AVENUE - 3 + 0.5) * TILE).ok).toBe(true);
}
