// Round 13: sleeping swimmers come ashore (a polar bear sent to sleep mid-swim
// lay flat on the pool surface), and nobody but a wader sleeps or sits in water.
import { describe, expect, it } from 'vitest';
import { TILE, WATER_LEVEL } from '../src/core/constants';
import { Terrain } from '../src/core/types';
import { SPECIES_BY_ID } from '../src/data/species';
import type { AnimalGoal, AnimalSim } from '../src/sim/state';
import { HAB, buildZoo, buyHerd, newSim } from './sim-helpers';

const WET = 0.05;

describe('sleeping in water', () => {
  it('a swimmer sent to sleep mid-swim swims ashore first; nobody but a wader sleeps or sits in water', () => {
    const { sim } = newSim(13);
    buildZoo(sim);
    const pool = { x0: HAB.x0 + 3, z0: HAB.z0 + 3, x1: HAB.x0 + 6, z1: HAB.z0 + 6 };
    expect(sim.paintTerrain(pool, Terrain.DeepWater).ok).toBe(true);
    const [id, mate] = buyHerd(sim, 'polarbear', 2);
    const bear = sim.animals.get(id)!;
    const mid = { x: (pool.x0 + 2) * TILE, z: (pool.z0 + 2) * TILE };
    expect(sim.moveAnimal(id, mid.x, mid.z).ok).toBe(true);
    const depth = (a: AnimalSim) => WATER_LEVEL - sim.world.heightAt(a.x, a.z);
    expect(depth(bear)).toBeGreaterThan(0.5);
    // what the verifier's probe did: a sleep goal while swimming
    bear.needs.energy = 0.1;
    bear.needs.hunger = 1;
    bear.needs.thirst = 1;
    (sim.animalSys as unknown as { setGoal(a: AnimalSim, g: AnimalGoal, t: number): void }).setGoal(bear, 'sleep', 400);
    bear.moving = false;
    sim.minuteOfDay = 23 * 60; // night: the mate beds down too, by its own choice
    sim.setSpeed(1);
    let wetBeds = 0;
    let asleepAshore = -1;
    for (let i = 0; i < 900; i++) {
      sim.update(0.1);
      for (const a of sim.animals.values()) {
        const sp = SPECIES_BY_ID[a.speciesId];
        const wader = sp.rig === 'bird' && !sp.swims;
        if ((a.action === 'sleep' && !wader) || a.action === 'sit') if (depth(a) > WET) wetBeds++;
      }
      if (asleepAshore < 0 && bear.action === 'sleep') asleepAshore = i;
    }
    expect(wetBeds).toBe(0);
    // it kept its goal and lay down on dry ground
    expect(asleepAshore).toBeGreaterThan(0);
    expect(bear.goal).toBe('sleep');
    expect(depth(bear)).toBeLessThanOrEqual(WET);
    expect(sim.animals.get(mate)!.action).toBe('sleep');
    expect(depth(sim.animals.get(mate)!)).toBeLessThanOrEqual(WET);
  }, 60_000);
});
