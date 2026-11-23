// A boardwalk leaving the water carries on as a flat deck over the bank until
// it meets the slope, exactly at the height guests walk (World.walkHeightAt),
// instead of ending in the air above the first land tile.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DECK_Y, TILE } from '../src/core/constants';
import { EventBus } from '../src/core/events';
import { PathType, Terrain } from '../src/core/types';
import { World } from '../src/core/world';
import { BoardwalkDecks } from '../src/render/boardwalk';

/** Shallow water at x 38..41, z 52..55 and a boardwalk at x = 39 from z 50 to 57 (the playtest repro). */
function crossing(): World {
  const world = new World(new EventBus(), 3);
  world.setTerrainRect({ x0: 38, z0: 52, x1: 41, z1: 55 }, Terrain.Water);
  for (let z = 50; z <= 57; z++) world.setPath(39, z, PathType.Boardwalk);
  return world;
}

/** Top faces (normal up) of the deck geometry over tile (x, z) of a boardwalk running along Z: their vertices. */
function topVertices(geo: THREE.BufferGeometry, x: number, z: number): THREE.Vector3[] {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i),
      pz = pos.getZ(i);
    if (nrm.getY(i) < 0.99) continue;
    // planks span the tile across the walking direction (x); keep the ones whose centre lies in the tile along z
    if (px < x * TILE - 1e-3 || px > (x + 1) * TILE + 1e-3 || pz <= z * TILE + 1e-3 || pz >= (z + 1) * TILE - 1e-3) continue;
    out.push(new THREE.Vector3(px, pos.getY(i), pz));
  }
  return out;
}

describe('boardwalk decks at the shore', () => {
  it('extends the deck over the bank at the guests’ walking height', () => {
    const world = crossing();
    const decks = new BoardwalkDecks(world);
    const geo = decks.mesh.geometry;
    for (const z of [51, 56]) {
      // the first land tile on each side: its bank drops below the deck
      expect(world.heightAt(39 * TILE + 1, (z === 51 ? 52 : 56) * TILE)).toBeLessThan(DECK_Y);
      const tops = topVertices(geo, 39, z);
      expect(tops.length).toBeGreaterThan(0);
      const planks = tops.filter((v) => Math.abs(v.y - DECK_Y) < 1e-4);
      expect(planks.length).toBeGreaterThan(0);
      // flush with the deck over the water, and only where the ground is below it
      for (const v of planks) expect(world.heightAt(v.x, v.z)).toBeLessThan(DECK_Y + 0.15);
      // guests on this tile walk at max(ground, DECK_Y): the deck is what they stand on over the bank
      const mid = (z === 51 ? 51.95 : 56.05) * TILE;
      expect(world.walkHeightAt(39 * TILE + 1, mid)).toBeCloseTo(DECK_Y, 5);
      // no deck where the bank stays above DECK_Y
      const far = (z === 51 ? 51.05 : 56.95) * TILE;
      if (world.heightAt(39 * TILE + 1, far) > DECK_Y + 0.05) {
        expect(planks.every((v) => Math.abs(v.z - far) > 0.25)).toBe(true);
      }
    }
    // land boardwalk tiles away from the water get no geometry
    expect(topVertices(geo, 39, 50).length).toBe(0);
    expect(topVertices(geo, 39, 57).length).toBe(0);
    decks.dispose();
  });
});
