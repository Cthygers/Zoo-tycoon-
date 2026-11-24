// Ground / water look near ponds and lawns: per-tile data the ground shader
// reads (lake bed after its shore, dry patches inside lawns) and the noisy
// waterline both shaders share.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MAP_W } from '../src/core/constants';
import { EventBus } from '../src/core/events';
import { Terrain } from '../src/core/types';
import { World } from '../src/core/world';
import { LakeBed, lakeBedKind, lawnShare, TileIndexTexture } from '../src/render/terrain';
import { SHORE_OFFSET_GLSL, WaterSurface } from '../src/render/water';

function flatWorld(t: Terrain): World {
  const w = new World(new EventBus(), 5);
  w.terrain.fill(t);
  return w;
}

function paint(w: World, x0: number, z0: number, x1: number, z1: number, t: Terrain): void {
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) w.terrain[w.idx(x, z)] = t;
}

describe('lake bed look', () => {
  it('follows the shore: gravel by snow or rock, pale sand by sand, silt by grass', () => {
    for (const [shore, bed] of [
      [Terrain.Snow, LakeBed.Gravel],
      [Terrain.Rock, LakeBed.Gravel],
      [Terrain.Sand, LakeBed.Sand],
      [Terrain.Grass, LakeBed.Silt],
    ] as const) {
      const w = flatWorld(shore);
      paint(w, 30, 30, 37, 37, Terrain.Water);
      paint(w, 32, 32, 35, 35, Terrain.DeepWater);
      expect(lakeBedKind(w, 30, 33)).toBe(bed);
      expect(lakeBedKind(w, 33, 33)).toBe(bed);
    }
  });

  it('is silt in the middle of a lake too wide for the shore to reach', () => {
    const w = flatWorld(Terrain.Snow);
    paint(w, 10, 10, 40, 40, Terrain.DeepWater);
    expect(lakeBedKind(w, 25, 25)).toBe(LakeBed.Silt);
    expect(lakeBedKind(w, 11, 25)).toBe(LakeBed.Gravel);
  });
});

describe('dry patches inside lawns', () => {
  it('measures how much lawn surrounds a dry-grass or dirt tile', () => {
    const w = flatWorld(Terrain.Grass);
    paint(w, 20, 20, 21, 21, Terrain.DryGrass);
    paint(w, 40, 10, 60, 30, Terrain.DryGrass);
    expect(lawnShare(w, 20, 20)).toBeGreaterThan(0.9);
    expect(lawnShare(w, 50, 20)).toBe(0);
    expect(lawnShare(w, 5, 5)).toBe(0); // lawn itself
  });

  it('packs bed look and lawn share into the tile texture alpha', () => {
    const w = flatWorld(Terrain.Grass);
    paint(w, 20, 20, 20, 20, Terrain.Dirt);
    paint(w, 40, 40, 44, 44, Terrain.Water);
    paint(w, 38, 38, 46, 39, Terrain.Sand);
    const tex = new TileIndexTexture(w);
    const a = (x: number, z: number) => (tex.texture.image.data as Uint8Array)[(z * MAP_W + x) * 4 + 3];
    expect(a(20, 20) & 3).toBe(LakeBed.Silt);
    expect(a(20, 20) >> 2).toBe(63);
    expect(a(42, 40) & 3).toBe(LakeBed.Sand);
    // edits refresh the tiles whose look depends on them
    paint(w, 38, 38, 46, 39, Terrain.Rock);
    tex.update({ x0: 38, z0: 38, x1: 46, z1: 39 });
    expect(a(42, 40) & 3).toBe(LakeBed.Gravel);
    tex.dispose();
  });
});

describe('noisy waterline', () => {
  it('is the same function in the water and ground shaders', () => {
    const w = flatWorld(Terrain.Grass);
    paint(w, 30, 30, 34, 34, Terrain.Water);
    const water = new WaterSurface(w, new THREE.Texture(), new THREE.Texture(), () => 0);
    const mat = water.mesh.material as THREE.Material;
    const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}, defines: {} };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain(SHORE_OFFSET_GLSL.trim());
    expect(shader.fragmentShader).toContain('float wEdge = wDepth - shoreOffset(texture2D(uNoise, vWPos.xz * 0.087), texture2D(uNoise, vWPos.xz * 0.41));');
    water.dispose();
  });

  it('hides what stands deep in a pond behind depth-only murk layers drawn between the ground and the rest', () => {
    const w = flatWorld(Terrain.Grass);
    paint(w, 30, 30, 34, 34, Terrain.Water);
    const water = new WaterSurface(w, new THREE.Texture(), new THREE.Texture(), () => 0);
    const layers = water.mesh.children as THREE.Mesh[];
    expect(layers.length).toBeGreaterThan(0);
    for (const l of layers) {
      const m = l.material as THREE.MeshBasicMaterial;
      expect(m.colorWrite).toBe(false);
      expect(m.depthWrite).toBe(true);
      expect(m.transparent).toBe(false);
      expect(l.renderOrder).toBe(-1);
      expect(l.position.y).toBeLessThan(0);
      expect(l.geometry).toBe(water.mesh.geometry);
    }
    water.dispose();
  });
});
