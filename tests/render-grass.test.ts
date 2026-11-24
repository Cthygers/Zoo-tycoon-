// Grass tuft field placement (render/grass.ts): tufts go where the shader can
// show them, so the instance capacity is spent near the focus. Dry tufts near
// the camera read as thin, matte straw blades.
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

describe('dry tufts', () => {
  it('know each vertex\'s offset from its blade\'s centre line, so near straw blades can be thinned', () => {
    const gf = new GrassField(lawnWorld(), new THREE.Texture(), 64, { blades: 6, segs: 2 });
    const g = gf.mesh.geometry;
    const pos = g.getAttribute('position');
    const side = g.getAttribute('aSide');
    const blade = g.getAttribute('aBlade');
    expect(side.count).toBe(pos.count);
    // each blade: a left / right pair per segment, then the tip
    const perBlade = 2 * 2 + 1;
    expect(pos.count % perBlade).toBe(0);
    for (let b = 0; b < pos.count; b += perBlade) {
      const tip = b + perBlade - 1;
      expect(blade.getX(tip)).toBe(1);
      expect([side.getX(tip), side.getY(tip)]).toEqual([0, 0]);
      for (let i = b; i < tip; i += 2) {
        // the same centre point, opposite half widths
        expect(pos.getX(i + 1) - side.getX(i + 1)).toBeCloseTo(pos.getX(i) - side.getX(i), 6);
        expect(pos.getZ(i + 1) - side.getY(i + 1)).toBeCloseTo(pos.getZ(i) - side.getY(i), 6);
        expect(side.getX(i + 1)).toBeCloseTo(-side.getX(i), 6);
        expect(Math.hypot(side.getX(i), side.getY(i))).toBeGreaterThan(0.002);
      }
    }
    gf.dispose();
  });

  it('are thin straw-toned blades without white sheen close to the camera', () => {
    const gf = new GrassField(lawnWorld(), new THREE.Texture(), 64, { blades: 6, segs: 2 });
    const mat = gf.mesh.material as THREE.Material;
    const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {}, defines: {} };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    const vs = shader.vertexShader;
    // near the camera (3-9 m) dry blades keep their own width instead of the clump's 1.35x spread,
    // tapering further toward the tip; lush blades keep theirs
    expect(vs).toContain('float gNear = 1.0 - smoothstep(3.0, 9.0, distance(cameraPosition, iPos.xyz));');
    expect(vs).toContain('float gWidth = mix(1.0, mix(gSpread.x, 0.85 * (1.0 - 0.3 * aBlade.x), gNear), iPar.y);');
    // straw tips no paler than the dry-grass ground's pale straw (sRGB 180, 163, 118 ≈ 0.46, 0.37, 0.18 linear)
    const tip = /vec3 tip = mix\(vec3\([^)]*\), vec3\(([\d.]+), ([\d.]+), ([\d.]+)\), iPar\.y\);/.exec(vs)!;
    const [r, gr, b] = tip.slice(1).map(Number);
    expect(0.2126 * r + 0.7152 * gr + 0.0722 * b).toBeLessThan(0.35);
    expect(r).toBeGreaterThan(b * 1.8);
    // matte straw
    expect(shader.fragmentShader).toContain('reflectedLight.indirectSpecular *= 1.0 - 0.6 * vGDry;');
    gf.dispose();
  });
});
