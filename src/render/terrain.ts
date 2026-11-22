// Playable terrain mesh: a regular grid with TERRAIN_SEG vertices per tile
// edge whose heights come from world.heightAt (so entities stand exactly on
// it), plus a skirt around the border that hides cracks against the outer
// landscape. Owns the tile index texture (terrain type + path type) used by
// the ground shader, and updates both incrementally on world events.

import * as THREE from 'three';
import { MAP_H, MAP_W, TILE } from '../core/constants';
import type { TileRect } from '../core/events';
import type { World } from '../core/world';

export const TERRAIN_SEG = 2;
const NX = MAP_W * TERRAIN_SEG + 1;
const NZ = MAP_H * TERRAIN_SEG + 1;
const STEP = TILE / TERRAIN_SEG;
const SKIRT_DEPTH = 2.5;

export class TileIndexTexture {
  readonly texture: THREE.DataTexture;
  private data = new Uint8Array(MAP_W * MAP_H * 4);

  constructor(private world: World) {
    this.texture = new THREE.DataTexture(this.data, MAP_W, MAP_H, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.update({ x0: 0, z0: 0, x1: MAP_W - 1, z1: MAP_H - 1 });
  }

  update(rect: TileRect): void {
    const w = this.world;
    const x0 = Math.max(0, Math.min(rect.x0, rect.x1)),
      x1 = Math.min(MAP_W - 1, Math.max(rect.x0, rect.x1));
    const z0 = Math.max(0, Math.min(rect.z0, rect.z1)),
      z1 = Math.min(MAP_H - 1, Math.max(rect.z0, rect.z1));
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const i = z * MAP_W + x;
        this.data[i * 4] = w.terrain[i];
        this.data[i * 4 + 1] = w.path[i];
        this.data[i * 4 + 2] = w.objectGrid[i] ? 255 : 0;
        this.data[i * 4 + 3] = 255;
      }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private nrm: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private nrmAttr: THREE.BufferAttribute;
  /** Perimeter loop of grid vertex indices (skirt tops). */
  private loop: Int32Array;

  constructor(
    private world: World,
    material: THREE.Material,
  ) {
    const gridCount = NX * NZ;
    const loopLen = 2 * (NX - 1) + 2 * (NZ - 1);
    this.loop = new Int32Array(loopLen);
    let k = 0;
    for (let i = 0; i < NX - 1; i++) this.loop[k++] = i; // z = 0, west→east
    for (let j = 0; j < NZ - 1; j++) this.loop[k++] = j * NX + (NX - 1); // x = max, north→south
    for (let i = NX - 1; i > 0; i--) this.loop[k++] = (NZ - 1) * NX + i; // z = max, east→west
    for (let j = NZ - 1; j > 0; j--) this.loop[k++] = j * NX; // x = 0, south→north

    const vCount = gridCount + loopLen;
    this.pos = new Float32Array(vCount * 3);
    this.nrm = new Float32Array(vCount * 3);
    for (let j = 0; j < NZ; j++)
      for (let i = 0; i < NX; i++) {
        const v = j * NX + i;
        this.pos[v * 3] = i * STEP;
        this.pos[v * 3 + 2] = j * STEP;
      }
    const quads = (NX - 1) * (NZ - 1);
    const idx = new Uint32Array(quads * 6 + loopLen * 12);
    let t = 0;
    for (let j = 0; j < NZ - 1; j++)
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i,
          b = a + 1,
          c = a + NX,
          d = c + 1;
        // alternate diagonals for a more isotropic surface
        if ((i + j) & 1) {
          idx[t++] = a; idx[t++] = c; idx[t++] = b;
          idx[t++] = b; idx[t++] = c; idx[t++] = d;
        } else {
          idx[t++] = a; idx[t++] = c; idx[t++] = d;
          idx[t++] = a; idx[t++] = d; idx[t++] = b;
        }
      }
    // skirt (both windings; only a few hundred triangles)
    for (let s = 0; s < loopLen; s++) {
      const top0 = this.loop[s],
        top1 = this.loop[(s + 1) % loopLen];
      const bot0 = gridCount + s,
        bot1 = gridCount + ((s + 1) % loopLen);
      idx[t++] = top0; idx[t++] = bot0; idx[t++] = top1;
      idx[t++] = top1; idx[t++] = bot0; idx[t++] = bot1;
      idx[t++] = top0; idx[t++] = top1; idx[t++] = bot0;
      idx[t++] = top1; idx[t++] = bot1; idx[t++] = bot0;
    }
    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.nrmAttr = new THREE.BufferAttribute(this.nrm, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.nrmAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('normal', this.nrmAttr);
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.rebuild({ x0: 0, z0: 0, x1: MAP_W - 1, z1: MAP_H - 1 }, true);
    this.geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, -SKIRT_DEPTH - 3, 0), new THREE.Vector3(MAP_W * TILE, 4, MAP_H * TILE));
    this.geo.boundingSphere = this.geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.name = 'terrain';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  /** Recompute heights/normals for vertices touched by a tile rect. */
  rebuild(rect: TileRect, full = false): void {
    const w = this.world;
    const i0 = Math.max(0, Math.min(rect.x0, rect.x1) * TERRAIN_SEG - 1);
    const i1 = Math.min(NX - 1, (Math.max(rect.x0, rect.x1) + 1) * TERRAIN_SEG + 1);
    const j0 = Math.max(0, Math.min(rect.z0, rect.z1) * TERRAIN_SEG - 1);
    const j1 = Math.min(NZ - 1, (Math.max(rect.z0, rect.z1) + 1) * TERRAIN_SEG + 1);
    const e = 0.5;
    const pos = this.pos,
      nrm = this.nrm;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const v = j * NX + i;
        const x = i * STEP,
          z = j * STEP;
        pos[v * 3 + 1] = w.heightAt(x, z);
        const hl = w.heightAt(x - e, z),
          hr = w.heightAt(x + e, z);
        const hd = w.heightAt(x, z - e),
          hu = w.heightAt(x, z + e);
        let nx = hl - hr,
          ny = 2 * e,
          nz = hd - hu;
        const l = 1 / Math.hypot(nx, ny, nz);
        nx *= l;
        ny *= l;
        nz *= l;
        nrm[v * 3] = nx;
        nrm[v * 3 + 1] = ny;
        nrm[v * 3 + 2] = nz;
      }
    // skirts
    const gridCount = NX * NZ;
    for (let s = 0; s < this.loop.length; s++) {
      const top = this.loop[s];
      const b = gridCount + s;
      pos[b * 3] = pos[top * 3];
      pos[b * 3 + 1] = pos[top * 3 + 1] - SKIRT_DEPTH;
      pos[b * 3 + 2] = pos[top * 3 + 2];
      nrm[b * 3] = nrm[top * 3];
      nrm[b * 3 + 1] = nrm[top * 3 + 1];
      nrm[b * 3 + 2] = nrm[top * 3 + 2];
    }
    if (full) {
      this.posAttr.clearUpdateRanges();
      this.nrmAttr.clearUpdateRanges();
    } else {
      const start = j0 * NX * 3;
      const count = (j1 - j0 + 1) * NX * 3;
      this.posAttr.addUpdateRange(start, count);
      this.nrmAttr.addUpdateRange(start, count);
      this.posAttr.addUpdateRange(gridCount * 3, this.loop.length * 3);
      this.nrmAttr.addUpdateRange(gridCount * 3, this.loop.length * 3);
    }
    this.posAttr.needsUpdate = true;
    this.nrmAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
  }
}
