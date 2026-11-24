// Grass tuft field placement (render/grass.ts): tufts go where the shader can
// show them, so the instance capacity is spent near the focus.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MAP_H, MAP_W, WATER_LEVEL } from '../src/core/constants';
import { EventBus } from '../src/core/events';
import { Terrain } from '../src/core/types';
import { World } from '../src/core/world';
import { GrassField } from '../src/render/grass';

function lawnWorld(): World {
  const w = new World(new EventBus(), 5);
  w.terrain.fill(Terrain.Grass);
  return w;
}

/** Build the whole field around (x, z) and return the tuft positions. */
function tufts(w: World, capacity: number, x: number, z: number): { x: number; z: number; y: number }[] {
  const gf = new GrassField(w, new THREE.Texture(), capacity, { blades: 6, segs: 2 });
  gf.configure(0.5, 40);
  gf.setCenter(x, z, 1);
  gf.update(0, 1e6);
  const pos = gf.mesh.geometry.getAttribute('iPos').array as Float32Array;
  const out = [];
  for (let k = 0; k < gf.count; k++) out.push({ x: pos[k * 4], y: pos[k * 4 + 1], z: pos[k * 4 + 2] });
  gf.dispose();
  return out;
}

describe('grass tuft field', () => {
  it('fills the lawn around the focus instead of spending its capacity on tufts that never show', () => {
    const all = tufts(lawnWorld(), 1900, 72, 72);
    expect(all.length).toBeLessThan(1900);
    const near = all.filter((t) => Math.hypot(t.x - 72, t.z - 72) < 8).length;
    // ≈ 6 candidates/m² × the density scaled to the capacity (≈0.18) over 200 m²;
    // the far rows used to fill the capacity first, leaving none here
    expect(near).toBeGreaterThan(150);
  });

  it('lets the turf grow into a pond\'s mud ring above the water, not at the waterline', () => {
    const w = lawnWorld();
    for (let z = 29; z <= 41; z++) for (let x = 29; x <= 41; x++) w.terrain[w.idx(x, z)] = Terrain.Mud;
    for (let z = 30; z <= 40; z++) for (let x = 30; x <= 40; x++) w.terrain[w.idx(x, z)] = Terrain.Water;
    w.recomputeHeights({ x0: 0, z0: 0, x1: MAP_W - 1, z1: MAP_H - 1 });
    const onMud = tufts(w, 3000, 71, 71).filter((t) => w.terrain[w.idx(Math.floor(t.x / 2), Math.floor(t.z / 2))] === Terrain.Mud);
    expect(onMud.length).toBeGreaterThan(0);
    for (const t of onMud) expect(t.y + 0.01).toBeGreaterThan(WATER_LEVEL + 0.12);
  });
});
