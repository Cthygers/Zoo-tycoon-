// Playable terrain mesh. World height is bilinear over tile corners
// (world.heightAt), so the mesh only needs vertices at tile corners plus, for
// tiles whose bilinear patch is noticeably twisted (shores, carved ponds), a
// centre vertex with a 4-triangle fan; flat-ish tiles are two triangles.
// Fan and two-triangle tiles share only straight corner-to-corner edges, on
// which bilinear interpolation is linear, so the surface is crack-free. The
// result follows heightAt to within ~1 cm at ~12k triangles for the whole
// map (instead of ~44k for a uniform 1 m grid). A skirt around the border
// hides cracks against the outer landscape.
//
// Also owns the tile index texture (terrain type + path type) used by the
// ground shader, and updates both incrementally on world events.

import * as THREE from 'three';
import { MAP_H, MAP_W, TILE } from '../core/constants';
import type { TileRect } from '../core/events';
import { Terrain } from '../core/types';
import type { World } from '../core/world';

const CX = MAP_W + 1;
const CZ = MAP_H + 1;
const CORNERS = CX * CZ;
const CENTRES = MAP_W * MAP_H;
const SKIRT_DEPTH = 2.5;
/** |h00 + h11 − h10 − h01| above which a tile gets a centre vertex (error at centre = twist / 4). */
const TWIST_FAN = 0.04;

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

/** True when any tile in the 3×3 neighbourhood is water (shore / pond tiles). */
export function nearWater(world: World, x: number, z: number): boolean {
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const tx = x + dx,
        tz = z + dz;
      if (!world.inBounds(tx, tz)) continue;
      const t = world.terrain[world.idx(tx, tz)];
      if (t === Terrain.Water || t === Terrain.DeepWater) return true;
    }
  return false;
}

export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private nrm: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private nrmAttr: THREE.BufferAttribute;
  private index: THREE.BufferAttribute;
  /** 1 where the tile is drawn as a 4-triangle fan around its centre. */
  readonly fan = new Uint8Array(CENTRES);
  /** Perimeter loop of corner vertex indices (skirt tops). */
  private loop: Int32Array;

  constructor(
    private world: World,
    material: THREE.Material,
  ) {
    const loopLen = 2 * (CX - 1) + 2 * (CZ - 1);
    this.loop = new Int32Array(loopLen);
    let k = 0;
    for (let i = 0; i < CX - 1; i++) this.loop[k++] = i; // z = 0, west→east
    for (let j = 0; j < CZ - 1; j++) this.loop[k++] = j * CX + (CX - 1); // x = max, north→south
    for (let i = CX - 1; i > 0; i--) this.loop[k++] = (CZ - 1) * CX + i; // z = max, east→west
    for (let j = CZ - 1; j > 0; j--) this.loop[k++] = j * CX; // x = 0, south→north

    const vCount = CORNERS + CENTRES + loopLen;
    this.pos = new Float32Array(vCount * 3);
    this.nrm = new Float32Array(vCount * 3);
    for (let j = 0; j < CZ; j++)
      for (let i = 0; i < CX; i++) {
        const v = j * CX + i;
        this.pos[v * 3] = i * TILE;
        this.pos[v * 3 + 2] = j * TILE;
      }
    for (let z = 0; z < MAP_H; z++)
      for (let x = 0; x < MAP_W; x++) {
        const v = CORNERS + z * MAP_W + x;
        this.pos[v * 3] = (x + 0.5) * TILE;
        this.pos[v * 3 + 2] = (z + 0.5) * TILE;
      }
    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.nrmAttr = new THREE.BufferAttribute(this.nrm, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.nrmAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('normal', this.nrmAttr);
    // worst case: every tile a fan (12 indices) + double-sided skirt
    this.index = new THREE.BufferAttribute(new Uint32Array(CENTRES * 12 + loopLen * 12), 1);
    this.index.setUsage(THREE.DynamicDrawUsage);
    this.geo.setIndex(this.index);
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

  /** Triangles currently drawn (for stats). */
  get triangles(): number {
    return this.geo.drawRange.count / 3;
  }

  private setVertex(v: number, x: number, z: number) {
    const w = this.world;
    const e = 0.5;
    this.pos[v * 3 + 1] = w.heightAt(x, z);
    let nx = w.heightAt(x - e, z) - w.heightAt(x + e, z),
      ny = 2 * e,
      nz = w.heightAt(x, z - e) - w.heightAt(x, z + e);
    const l = 1 / Math.hypot(nx, ny, nz);
    nx *= l;
    ny *= l;
    nz *= l;
    this.nrm[v * 3] = nx;
    this.nrm[v * 3 + 1] = ny;
    this.nrm[v * 3 + 2] = nz;
  }

  private wantsFan(x: number, z: number): boolean {
    const w = this.world;
    const twist = w.cornerHeight(x, z) + w.cornerHeight(x + 1, z + 1) - w.cornerHeight(x + 1, z) - w.cornerHeight(x, z + 1);
    return Math.abs(twist) > TWIST_FAN || nearWater(w, x, z);
  }

  /** Recompute heights/normals (and the tessellation) for a tile rect. */
  rebuild(rect: TileRect, full = false): void {
    const tx0 = Math.max(0, Math.min(rect.x0, rect.x1) - 1);
    const tx1 = Math.min(MAP_W - 1, Math.max(rect.x0, rect.x1) + 1);
    const tz0 = Math.max(0, Math.min(rect.z0, rect.z1) - 1);
    const tz1 = Math.min(MAP_H - 1, Math.max(rect.z0, rect.z1) + 1);
    for (let j = tz0; j <= tz1 + 1; j++) for (let i = tx0; i <= tx1 + 1; i++) this.setVertex(j * CX + i, i * TILE, j * TILE);
    let topoChanged = full;
    for (let z = tz0; z <= tz1; z++)
      for (let x = tx0; x <= tx1; x++) {
        this.setVertex(CORNERS + z * MAP_W + x, (x + 0.5) * TILE, (z + 0.5) * TILE);
        const f = this.wantsFan(x, z) ? 1 : 0;
        if (this.fan[z * MAP_W + x] !== f) {
          this.fan[z * MAP_W + x] = f;
          topoChanged = true;
        }
      }
    // skirts
    const base = CORNERS + CENTRES;
    for (let s = 0; s < this.loop.length; s++) {
      const top = this.loop[s];
      const b = base + s;
      this.pos[b * 3] = this.pos[top * 3];
      this.pos[b * 3 + 1] = this.pos[top * 3 + 1] - SKIRT_DEPTH;
      this.pos[b * 3 + 2] = this.pos[top * 3 + 2];
      this.nrm[b * 3] = this.nrm[top * 3];
      this.nrm[b * 3 + 1] = this.nrm[top * 3 + 1];
      this.nrm[b * 3 + 2] = this.nrm[top * 3 + 2];
    }
    if (topoChanged) this.buildIndex();
    this.posAttr.clearUpdateRanges();
    this.nrmAttr.clearUpdateRanges();
    // big edits (world reset / load): one full upload instead of many row ranges
    const partial = !full && (tx1 - tx0 + 1) * (tz1 - tz0 + 1) < (MAP_W * MAP_H) / 3;
    if (partial) {
      for (let j = tz0; j <= tz1 + 1; j++) {
        this.posAttr.addUpdateRange((j * CX + tx0) * 3, (tx1 - tx0 + 2) * 3);
        this.nrmAttr.addUpdateRange((j * CX + tx0) * 3, (tx1 - tx0 + 2) * 3);
      }
      for (let z = tz0; z <= tz1; z++) {
        this.posAttr.addUpdateRange((CORNERS + z * MAP_W + tx0) * 3, (tx1 - tx0 + 1) * 3);
        this.nrmAttr.addUpdateRange((CORNERS + z * MAP_W + tx0) * 3, (tx1 - tx0 + 1) * 3);
      }
      this.posAttr.addUpdateRange(base * 3, this.loop.length * 3);
      this.nrmAttr.addUpdateRange(base * 3, this.loop.length * 3);
    }
    this.posAttr.needsUpdate = true;
    this.nrmAttr.needsUpdate = true;
  }

  private buildIndex(): void {
    const idx = this.index.array as Uint32Array;
    let t = 0;
    for (let z = 0; z < MAP_H; z++)
      for (let x = 0; x < MAP_W; x++) {
        const a = z * CX + x,
          b = a + 1,
          c = a + CX,
          d = c + 1;
        if (this.fan[z * MAP_W + x]) {
          const m = CORNERS + z * MAP_W + x;
          idx[t++] = a; idx[t++] = m; idx[t++] = b;
          idx[t++] = b; idx[t++] = m; idx[t++] = d;
          idx[t++] = d; idx[t++] = m; idx[t++] = c;
          idx[t++] = c; idx[t++] = m; idx[t++] = a;
        } else if ((x + z) & 1) {
          // alternate diagonals for a more isotropic surface
          idx[t++] = a; idx[t++] = c; idx[t++] = b;
          idx[t++] = b; idx[t++] = c; idx[t++] = d;
        } else {
          idx[t++] = a; idx[t++] = c; idx[t++] = d;
          idx[t++] = a; idx[t++] = d; idx[t++] = b;
        }
      }
    // skirt (both windings; only a few hundred triangles)
    const base = CORNERS + CENTRES;
    const n = this.loop.length;
    for (let s = 0; s < n; s++) {
      const top0 = this.loop[s],
        top1 = this.loop[(s + 1) % n];
      const bot0 = base + s,
        bot1 = base + ((s + 1) % n);
      idx[t++] = top0; idx[t++] = bot0; idx[t++] = top1;
      idx[t++] = top1; idx[t++] = bot0; idx[t++] = bot1;
      idx[t++] = top0; idx[t++] = top1; idx[t++] = bot0;
      idx[t++] = top1; idx[t++] = bot1; idx[t++] = bot0;
    }
    this.index.clearUpdateRanges();
    this.index.addUpdateRange(0, t);
    this.index.needsUpdate = true;
    this.geo.setDrawRange(0, t);
  }

  dispose(): void {
    this.geo.dispose();
  }
}
