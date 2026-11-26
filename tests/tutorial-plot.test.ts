// The tutorial's spot finders on 25 starter maps (tutorial.md §7): the yellow box is clear and
// fences into a habitat that is not on view yet; the short path joins it to the gate; every
// spot inside and beside the path passes its dry run; the keeper tile is a path tile.
import { describe, expect, it } from 'vitest';
import { MAP_W, TILE } from '../src/core/constants';
import { EventBus } from '../src/core/events';
import { PathType, Terrain } from '../src/core/types';
import { createSimulation } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';
import { gateOpen, hintFor, type HintContext } from '../src/ui/tutorial/facts';
import { adoptSpot, findPlot, keeperTile, pathHintHabitat, pathHintRect, plotCandidates, rectTiles, spotBesidePath, spotInside } from '../src/ui/tutorial/plot';

function newSim(seed: number): Simulation {
  const sim = createSimulation(new EventBus(), seed) as Simulation;
  sim.newGame(seed);
  return sim;
}

const SEEDS = Array.from({ length: 25 }, (_, i) => i * 37 + 7);

describe('tutorial plot finder', () => {
  const firstChoice: number[] = [];
  for (const seed of SEEDS) {
    it(`seed ${seed}: plot, habitat, path, spots and keeper tile`, () => {
      const sim = newSim(seed);
      const w = sim.world;
      const plot = findPlot(sim);
      expect(plot, 'a plot').not.toBeNull();
      const r = plot!;
      const ci = plotCandidates().findIndex((c) => c.x0 === r.x0 && c.z0 === r.z0 && c.x1 === r.x1 && c.z1 === r.z1);
      firstChoice.push(ci);
      // every tile clear
      for (const t of rectTiles(r)) {
        const i = w.idx(t.x, t.z);
        expect(w.objectGrid[i], `object at ${t.x},${t.z}`).toBe(0);
        expect(w.path[i]).toBe(0);
        expect(w.habitatOf[i]).toBe(0);
        expect([Terrain.Water, Terrain.DeepWater]).not.toContain(w.terrain[i]);
      }
      // fenced: a habitat that is not on view yet
      const corridor0 = pathHintRect(w, r)!;
      expect(corridor0.length).toBeGreaterThan(0);
      expect(corridor0.length).toBeLessThanOrEqual(4);
      const fr = sim.placeFences(w.edgesAroundRect(r), 1);
      expect(fr.ok).toBe(true);
      expect(fr.warning).toBeUndefined();
      expect(w.habitats.size).toBe(1);
      const hab = [...w.habitats.values()][0];
      expect(hab.viewTiles.length).toBe(0);
      // furnish it from the yellow spots
      for (const [defId, prefer] of [
        ['water_trough', 'near-path'],
        ['shelter_wood', 'far'],
        ['grass_tall', 'corner'],
      ] as const) {
        const s = spotInside(sim, hab.id, defId, prefer);
        expect(s, defId).not.toBeNull();
        const dry = sim.placeObject(defId, s!.tx, s!.tz, s!.rot, true);
        expect(dry.ok && !dry.warning, `${defId} dry run`).toBe(true);
        expect(sim.placeObject(defId, s!.tx, s!.tz, s!.rot).ok).toBe(true);
      }
      const a = adoptSpot(sim, hab.id, 'zebra');
      expect(a).not.toBeNull();
      expect(sim.buyAnimal('zebra', (a!.x + 0.5) * TILE, (a!.z + 0.5) * TILE).ok).toBe(true);
      expect(gateOpen(sim)).toBe(false);
      // the corridor: ≤ 4 tiles; building it puts the habitat on view and opens the gate
      const corridor = pathHintHabitat(w, hab.id)!;
      expect(corridor.length).toBeGreaterThan(0);
      expect(corridor.length).toBeLessThanOrEqual(4);
      expect(sim.placePaths(corridor, PathType.Paved).ok).toBe(true);
      expect(w.habitats.get(hab.id)!.viewTiles.length).toBeGreaterThan(0);
      expect(gateOpen(sim)).toBe(true);
      // guest buildings beside the path
      const ctx: HintContext = { plot: r, homeHabitat: hab.id, animalId: 0, speciesId: 'zebra', corridor, regressed: false };
      for (const [step, defId] of [
        ['kiosk', 'shop_snack'],
        ['bench', 'bench'],
        ['bin', 'bin'],
      ] as const) {
        const h = hintFor(step, sim, ctx, null);
        expect(h?.kind, step).toBe('spot');
        if (h?.kind !== 'spot') continue;
        const dry = sim.placeObject(defId, h.spot.tx, h.spot.tz, h.spot.rot, true);
        expect(dry.ok && !dry.warning, `${step} dry run`).toBe(true);
        expect(sim.placeObject(defId, h.spot.tx, h.spot.tz, h.spot.rot).ok).toBe(true);
      }
      // the keeper tile is a path tile next to the habitat
      const k = keeperTile(sim, hab.id, corridor);
      expect(k).not.toBeNull();
      expect(w.isPath(k!.x, k!.z)).toBe(true);
      expect(sim.hireStaff('keeper', (k!.x + 0.5) * TILE, (k!.z + 0.5) * TILE, true).ok).toBe(true);
    });
  }

  it('picks candidate A (east of the avenue) on most starter maps, and on seed 7 the measured 39–46 × 60–67 with a 2-tile path', () => {
    const sim = newSim(7);
    const r = findPlot(sim)!;
    expect(r).toEqual({ x0: 39, z0: 60, x1: 46, z1: 67 });
    expect(pathHintRect(sim.world, r)!.length).toBe(2);
    const p = pathHintRect(sim.world, r)!;
    // from the grey path's end to the fence
    expect(sim.world.isPath(p[0].x - 1, p[0].z)).toBe(true);
    expect(p[p.length - 1].x).toBe(38);
    expect(firstChoice.filter((c) => c === 0).length).toBeGreaterThanOrEqual(Math.floor(SEEDS.length * 0.6));
    void MAP_W;
  });

  it('with no clear spot near the gate the plot is null', () => {
    const sim = newSim(11);
    // cover the area around the gate with path
    const tiles: { x: number; z: number }[] = [];
    for (let z = 36; z < 70; z++) for (let x = 4; x < 68; x++) tiles.push({ x, z });
    sim.money = 1e7;
    sim.bulldoze({ x0: 4, z0: 36, x1: 67, z1: 69 });
    expect(sim.placePaths(tiles, PathType.Gravel).ok).toBe(true);
    expect(findPlot(sim)).toBeNull();
  });
});
