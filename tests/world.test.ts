import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/core/events';
import { World } from '../src/core/world';
import { Terrain } from '../src/core/types';

describe('World', () => {
  it('detects a fenced enclosure as a habitat', () => {
    const w = new World(new EventBus(), 1);
    const edges = w.edgesAroundRect({ x0: 5, z0: 5, x1: 12, z1: 10 });
    for (const e of edges) w.setFence(e, 2, false);
    w.recomputeHabitats();
    expect(w.habitats.size).toBe(1);
    const h = [...w.habitats.values()][0];
    expect(h.tiles.length).toBe(8 * 6);
    expect(h.minFenceStrength).toBe(2);
    expect(w.habitatAt(6, 6)?.id).toBe(h.id);
    expect(w.habitatAt(4, 6)).toBeUndefined();
    expect(w.canStep(5, 6, 4, 6)).toBe(false);
    expect(w.canStep(6, 6, 7, 7)).toBe(true);
  });
  it('keeps habitat ids stable when the fence grows', () => {
    const w = new World(new EventBus(), 1);
    for (const e of w.edgesAroundRect({ x0: 5, z0: 5, x1: 12, z1: 10 })) w.setFence(e, 1, false);
    w.recomputeHabitats();
    const id = [...w.habitats.keys()][0];
    w.setFence({ dir: 'v', x: 9, z: 5 }, 1); // partial divider doesn't split
    expect(w.habitatAt(6, 6)?.id).toBe(id);
  });
  it('carves water below the water level', () => {
    const w = new World(new EventBus(), 1);
    w.setTerrainRect({ x0: 10, z0: 10, x1: 14, z1: 14 }, Terrain.DeepWater);
    expect(w.heightAt(12 * 2 + 1, 12 * 2 + 1)).toBeLessThan(-1.5);
    expect(w.heightAt(30, 60)).toBeGreaterThan(0);
  });
  it('starter map has an entrance and paths', () => {
    const w = new World(new EventBus(), 7);
    w.generateStarterMap();
    expect([...w.objects.values()].some((o) => o.defId === 'entrance_gate')).toBe(true);
    expect(w.path.reduce((a, b) => a + (b ? 1 : 0), 0)).toBeGreaterThan(20);
    expect(w.habitats.size).toBe(0);
  });
});
