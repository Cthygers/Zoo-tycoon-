// Decorative landscape around the playable map so there is never a visible
// world edge: rolling meadows rising into hills out to OUTER_RING metres (same
// ground shader as the map; a graded grid, 4 m cells at the border growing to
// ~12 m), a coarse far ring that keeps climbing into the haze, an impostor
// forest (forest.ts) with soft ground shadows and two ranges of distant
// mountains with aerial perspective.

import * as THREE from 'three';
import { OUTER_RING, WORLD_H, WORLD_W } from '../core/constants';
import { Noise, clamp, smoothstep } from '../core/rng';
import type { World } from '../core/world';
import { DistantForest, type ForestTree } from './forest';

const CELL = 4; // metres per near-ring cell
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s3 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const FAR_R1 = 1700;
const CX = WORLD_W / 2;
const CZ = WORLD_H / 2;

export class OuterHeight {
  private n: Noise;
  constructor(
    private world: World,
    seed: number,
  ) {
    this.n = new Noise(seed * 7 + 3);
  }
  /** Distance (m) outside the playable rectangle. */
  static outside(x: number, z: number): number {
    const dx = Math.max(-x, 0, x - WORLD_W);
    const dz = Math.max(-z, 0, z - WORLD_H);
    return Math.hypot(dx, dz);
  }
  height(x: number, z: number): number {
    const d = OuterHeight.outside(x, z);
    const edge = this.world.heightAt(clamp(x, 0, WORLD_W - 1e-3), clamp(z, 0, WORLD_H - 1e-3));
    if (d <= 0) return edge;
    const n = this.n;
    const roll = 0.35 + 1.6 * (n.fbm2(x * 0.011, z * 0.011, 4) * 0.5 + 0.5);
    const rise = 16 * smoothstep(14, 170, d);
    const far = 50 * smoothstep(110, 1400, d) * (0.5 + 1.0 * (n.fbm2(x * 0.0025 + 9, z * 0.0025, 3) * 0.5 + 0.5));
    const ridges = clamp(d - 40, 0, 300) * 0.05 * n.fbm2(x * 0.02 + 3, z * 0.02 - 5, 3);
    const s = smoothstep(0, 26, d);
    return edge * (1 - s) + (roll + rise + far + ridges) * s;
  }
}

/**
 * Height for an outer-ring vertex. Vertices on the map border are placed at the
 * minimum terrain edge height over their two adjacent 4 m segments (sampled at
 * the terrain's 1 m vertex spacing), so the terrain skirt always hides the
 * T-junction between the 1 m terrain edge and the 4 m outer grid.
 */
function ringHeight(h: OuterHeight, world: World, x: number, z: number): number {
  const onX = (x === 0 || x === WORLD_W) && z >= 0 && z <= WORLD_H;
  const onZ = (z === 0 || z === WORLD_H) && x >= 0 && x <= WORLD_W;
  if (!onX && !onZ) return h.height(x, z);
  let m = Infinity;
  for (let k = -CELL; k <= CELL; k++) {
    if (onX) m = Math.min(m, world.heightAt(Math.min(Math.max(x, 0), WORLD_W - 1e-3), Math.min(Math.max(z + k, 0), WORLD_H - 1e-3)));
    if (onZ) m = Math.min(m, world.heightAt(Math.min(Math.max(x + k, 0), WORLD_W - 1e-3), Math.min(Math.max(z, 0), WORLD_H - 1e-3)));
  }
  return m - 0.05;
}

function normalAt(h: OuterHeight, x: number, z: number, e: number, out: THREE.Vector3): THREE.Vector3 {
  const hl = h.height(x - e, z),
    hr = h.height(x + e, z),
    hd = h.height(x, z - e),
    hu = h.height(x, z + e);
  return out.set(hl - hr, 2 * e, hd - hu).normalize();
}

/**
 * Grid coordinates along one axis: 4 m cells across the map, outside it cells
 * growing by 0.6 m each step until OUTER_RING is reached.
 */
function ringAxis(size: number): number[] {
  const inner: number[] = [];
  for (let x = 0; x <= size + 1e-6; x += CELL) inner.push(x);
  const out: number[] = [];
  let x = 0,
    step = CELL;
  while (x > -OUTER_RING + 1e-6) {
    x = Math.max(x - step, -OUTER_RING);
    if (x - -OUTER_RING < step * 0.5) x = -OUTER_RING; // no sliver cell at the end
    out.push(x);
    step += 0.6;
  }
  const before = out.slice().reverse();
  const after = out.map((v) => size - v);
  return [...before, ...inner, ...after];
}

/** Graded grid ring between the map border and OUTER_RING (shares the ground material). */
function buildNearRing(h: OuterHeight, world: World): THREE.BufferGeometry {
  const xs = ringAxis(WORLD_W),
    zs = ringAxis(WORLD_H);
  const n = xs.length,
    nz = zs.length;
  const pos = new Float32Array(n * nz * 3);
  const nrm = new Float32Array(n * nz * 3);
  const v3 = new THREE.Vector3();
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < n; i++) {
      const x = xs[i],
        z = zs[j];
      const k = (j * n + i) * 3;
      pos[k] = x;
      pos[k + 1] = ringHeight(h, world, x, z);
      pos[k + 2] = z;
      normalAt(h, x, z, 1.5 + 0.02 * OuterHeight.outside(x, z), v3);
      nrm[k] = v3.x;
      nrm[k + 1] = v3.y;
      nrm[k + 2] = v3.z;
    }
  const idx: number[] = [];
  for (let j = 0; j < nz - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const x0 = xs[i],
        z0 = zs[j];
      if (x0 >= 0 && xs[i + 1] <= WORLD_W && z0 >= 0 && zs[j + 1] <= WORLD_H) continue; // inside the map
      const a = j * n + i,
        b = a + 1,
        c = a + n,
        d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Polar ring from just inside the near ring out to the horizon. */
function buildFarRing(h: OuterHeight): THREE.BufferGeometry {
  const r0 = WORLD_W / 2 + OUTER_RING - 10;
  const radial = 16,
    ang = 96;
  const pos = new Float32Array((radial + 1) * ang * 3);
  const nrm = new Float32Array((radial + 1) * ang * 3);
  const v3 = new THREE.Vector3();
  for (let r = 0; r <= radial; r++) {
    const rad = r0 * Math.pow(FAR_R1 / r0, r / radial);
    for (let a = 0; a < ang; a++) {
      const th = (a / ang) * Math.PI * 2;
      const x = CX + Math.cos(th) * rad,
        z = CZ + Math.sin(th) * rad;
      const k = (r * ang + a) * 3;
      const insideNear = Math.abs(x - CX) < WORLD_W / 2 + OUTER_RING - 2 && Math.abs(z - CZ) < WORLD_H / 2 + OUTER_RING - 2;
      pos[k] = x;
      pos[k + 1] = h.height(x, z) - (insideNear ? 1.2 : 0);
      pos[k + 2] = z;
      normalAt(h, x, z, Math.max(2, rad * 0.02), v3);
      nrm[k] = v3.x;
      nrm[k + 1] = v3.y;
      nrm[k + 2] = v3.z;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < radial; r++)
    for (let a = 0; a < ang; a++) {
      const a1 = (a + 1) % ang;
      const p = r * ang + a,
        q = r * ang + a1,
        s = (r + 1) * ang + a,
        t = (r + 1) * ang + a1;
      idx.push(p, q, s, q, t, s);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ forest

function makeBlobTexture(): THREE.DataTexture {
  const N = 64;
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N - 0.5,
        v = (y + 0.5) / N - 0.5;
      const r = Math.hypot(u, v) * 2;
      const a = Math.max(0, 1 - r);
      const val = Math.round(255 * a * a * (3 - 2 * a));
      const i = (y * N + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = val;
      d[i + 3] = 255;
    }
  const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export interface OuterLandOptions {
  treeCount: number;
  /** Foliage sprites per detailed / sparse crown. */
  nearSprites: number;
  farSprites: number;
  /** Foliage clump atlas (textures.ts). */
  foliage: THREE.Texture;
  msaa: boolean;
}

export class OuterLand {
  readonly group = new THREE.Group();
  readonly heights: OuterHeight;
  private near: THREE.Mesh;
  private far: THREE.Mesh;
  forest: DistantForest;
  private blobPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  /** x, y, z, height, crown radius per tree (for ground contact shadows). */
  private trees: Float32Array = new Float32Array(0);
  private treeCount = 0;
  private blobs: THREE.InstancedMesh | null = null;
  private blobMat: THREE.MeshBasicMaterial;
  private blobTex: THREE.DataTexture;
  private blobSunElev = -9;
  private blobStrength = -1;
  private mountains: THREE.Mesh;
  private mountainMat: THREE.ShaderMaterial;
  private geos: THREE.BufferGeometry[] = [];
  readonly mountainUniforms: {
    uHaze: THREE.IUniform<THREE.Color>;
    uSunCol: THREE.IUniform<THREE.Color>;
    uAmb: THREE.IUniform<THREE.Color>;
    uSunDir: THREE.IUniform<THREE.Vector3>;
  };

  constructor(
    private world: World,
    groundMaterial: THREE.Material,
    opts: OuterLandOptions,
  ) {
    this.group.name = 'outer-land';
    this.heights = new OuterHeight(world, world.seed);
    const nearGeo = buildNearRing(this.heights, world);
    const farGeo = buildFarRing(this.heights);
    this.geos.push(nearGeo, farGeo);
    this.near = new THREE.Mesh(nearGeo, groundMaterial);
    this.near.receiveShadow = true;
    this.near.name = 'outer-near';
    this.far = new THREE.Mesh(farGeo, groundMaterial);
    this.far.name = 'outer-far';
    this.group.add(this.near, this.far);

    this.blobTex = makeBlobTexture();
    this.blobMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      alphaMap: this.blobTex,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.blobMat.name = 'outer-tree-shadow';
    this.forest = new DistantForest(this.placeTrees(opts.treeCount), opts.foliage, {
      nearSprites: opts.nearSprites,
      farSprites: opts.farSprites,
      msaa: opts.msaa,
    });
    this.group.add(this.forest.group);

    // mountains
    this.mountainUniforms = {
      uHaze: { value: new THREE.Color(0.5, 0.6, 0.7) },
      uSunCol: { value: new THREE.Color(1, 1, 1) },
      uAmb: { value: new THREE.Color(0.2, 0.25, 0.3) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    };
    const mGeo = this.buildMountains();
    this.geos.push(mGeo);
    this.mountainMat = new THREE.ShaderMaterial({
      uniforms: this.mountainUniforms,
      vertexShader: /* glsl */ `
        attribute float aHaze;
        varying float vHaze;
        varying vec3 vN;
        varying float vY;
        void main() {
          vHaze = aHaze;
          vN = normal;
          vY = position.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uHaze;
        uniform vec3 uSunCol;
        uniform vec3 uAmb;
        uniform vec3 uSunDir;
        varying float vHaze;
        varying vec3 vN;
        varying float vY;
        void main() {
          vec3 n = normalize(vN);
          vec3 alb = vec3(0.06, 0.075, 0.07);
          vec3 lit = alb * (uSunCol * max(dot(n, uSunDir), 0.0) / 3.14159 + uAmb);
          float haze = mix(0.55, 0.74, vHaze) + 0.2 * (1.0 - smoothstep(0.0, 160.0, vY));
          vec3 col = mix(lit, uHaze * vec3(0.78, 0.84, 0.95), clamp(haze, 0.0, 0.97));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      fog: false,
      side: THREE.DoubleSide,
    });
    this.mountains = new THREE.Mesh(mGeo, this.mountainMat);
    this.mountains.name = 'mountains';
    this.mountains.frustumCulled = false;
    this.mountains.renderOrder = 900;
    this.group.add(this.mountains);
  }

  /**
   * Scatter the outer trees: an open meadow strip next to the map, then
   * scattered trees thickening into woodland belts with clearings; conifers
   * gather in their own stands. Also prepares the blob-shadow instances.
   */
  private placeTrees(count: number): ForestTree[] {
    const n = new Noise(this.world.seed + 101);
    let seed = this.world.seed * 13 + 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const out: ForestTree[] = [];
    const tdata: number[] = [];
    const maxR = OUTER_RING + 170;
    const NEAR_BAND = 60;
    // spatial hash for minimum spacing between trunks
    const GRID = 8;
    const grid = new Map<number, number[]>();
    const key = (gx: number, gz: number) => (gx + 512) * 4096 + (gz + 512);
    const tooClose = (x: number, z: number, r: number): boolean => {
      const gx = Math.floor(x / GRID),
        gz = Math.floor(z / GRID);
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const cell = grid.get(key(gx + dx, gz + dz));
          if (!cell) continue;
          for (let i = 0; i < cell.length; i += 3) {
            const ddx = cell[i] - x,
              ddz = cell[i + 1] - z;
            const rr = (r + cell[i + 2]) * 0.55;
            if (ddx * ddx + ddz * ddz < rr * rr) return true;
          }
        }
      return false;
    };
    let tries = 0;
    while (out.length < count && tries < count * 60) {
      tries++;
      // bias candidates toward the map (most views look inward / at the border)
      const ring = 9 + Math.pow(rnd(), 1.6) * (maxR - 9);
      const side = rnd() * (2 * (WORLD_W + WORLD_H) + 8 * ring);
      let x: number, z: number;
      const W = WORLD_W + 2 * ring,
        H = WORLD_H + 2 * ring;
      if (side < W) {
        x = -ring + side;
        z = -ring;
      } else if (side < W + H) {
        x = WORLD_W + ring;
        z = -ring + (side - W);
      } else if (side < 2 * W + H) {
        x = -ring + (side - W - H);
        z = WORLD_H + ring;
      } else {
        x = -ring;
        z = -ring + ((side - 2 * W - H) % H);
      }
      x += (rnd() - 0.5) * 6;
      z += (rnd() - 0.5) * 6;
      const d = OuterHeight.outside(x, z);
      if (d < 9) continue;
      // woodland patches (≈90 m features) with clearings, plus a few lone trees
      const wood = n.fbm2(x * 0.011, z * 0.011, 3) * 0.5 + 0.5;
      let dens = 0.05 + 0.95 * smoothstep(0.42, 0.58, wood);
      dens *= smoothstep(9, 24, d);
      if (rnd() > dens) continue;
      const stand = n.fbm2(x * 0.02 + 40, z * 0.02 - 13, 2) * 0.5 + 0.5;
      const kind: 0 | 1 = stand > 0.57 && rnd() < 0.85 ? 1 : rnd() < 0.07 ? 1 : 0;
      const grow = 0.8 + 0.4 * smoothstep(0.4, 0.75, wood);
      const h = (kind === 1 ? 15 + rnd() * 9 : 10 + rnd() * 7) * grow;
      const width = 0.85 + rnd() * 0.35;
      const crownR = (kind === 1 ? 0.16 : 0.3) * h * width;
      if (tooClose(x, z, crownR)) continue;
      const gx = Math.floor(x / GRID),
        gz = Math.floor(z / GRID);
      const cell = grid.get(key(gx, gz)) ?? [];
      cell.push(x, z, crownR);
      grid.set(key(gx, gz), cell);
      const y = this.heights.height(x, z) - 0.15;
      // linear foliage albedo: broadleaves fresh → olive (a few yellowing),
      // conifers dark blue-green
      const c = new THREE.Color();
      if (kind === 1) {
        c.setRGB(0.036, 0.06, 0.034).multiplyScalar(0.85 + rnd() * 0.4);
      } else {
        const t = rnd();
        c.setRGB(0.056, 0.1, 0.036).lerp(new THREE.Color(0.085, 0.1, 0.04), t * t);
        if (rnd() < 0.1) c.lerp(new THREE.Color(0.12, 0.095, 0.04), 0.45);
        c.multiplyScalar(0.85 + rnd() * 0.35);
      }
      out.push({ x, y, z, h, kind, rot: rnd() * Math.PI * 2, width, color: c, near: d < NEAR_BAND });
      tdata.push(x, y, z, h, crownR);
    }
    this.trees = new Float32Array(tdata);
    this.treeCount = tdata.length / 5;
    if (this.blobs) {
      this.group.remove(this.blobs);
      this.blobs.dispose();
    }
    this.blobSunElev = -9;
    this.blobStrength = -1;
    this.blobs = new THREE.InstancedMesh(this.blobPlane, this.blobMat, Math.max(1, this.treeCount));
    this.blobs.count = this.treeCount;
    this.blobs.frustumCulled = false;
    this.blobs.renderOrder = 1;
    this.blobs.name = 'outer-tree-shadows';
    this.group.add(this.blobs);
    return out;
  }

  private buildMountains(): THREE.BufferGeometry {
    const n = new Noise(this.world.seed + 555);
    const seg = 220;
    const ranges = [
      { r: 2100, base: -20, h: 170, haze: 0 },
      { r: 3000, base: -40, h: 360, haze: 1 },
    ];
    const pos: number[] = [],
      nrm: number[] = [],
      haze: number[] = [],
      idx: number[] = [];
    for (const rg of ranges) {
      const start = pos.length / 3;
      const rows = 3;
      for (let a = 0; a <= seg; a++) {
        const th = (a / seg) * Math.PI * 2;
        const ridge = Math.max(0, n.fbm2(Math.cos(th) * 3 + rg.r, Math.sin(th) * 3, 5) * 0.5 + 0.55);
        const sharp = Math.pow(ridge, 1.6);
        const top = rg.base + rg.h * sharp + 40;
        for (let r = 0; r < rows; r++) {
          const t = r / (rows - 1); // 0 = base, 1 = top
          const rad = rg.r - t * 120;
          const y = rg.base + (top - rg.base) * t;
          pos.push(CX + Math.cos(th) * rad, y, CZ + Math.sin(th) * rad);
          // normal: outward-facing toward the centre (we see the inner side) tilted up
          const slope = 0.45 + 0.35 * t;
          const nx = -Math.cos(th),
            nz = -Math.sin(th);
          const l = Math.hypot(nx, slope, nz);
          nrm.push(nx / l, slope / l, nz / l);
          haze.push(rg.haze);
        }
      }
      for (let a = 0; a < seg; a++)
        for (let r = 0; r < rows - 1; r++) {
          const i0 = start + a * rows + r,
            i1 = i0 + 1,
            j0 = start + (a + 1) * rows + r,
            j1 = j0 + 1;
          idx.push(i0, i1, j0, j0, i1, j1);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('aHaze', new THREE.Float32BufferAttribute(haze, 1));
    g.setIndex(idx);
    return g;
  }

  /** Rebuild the impostor forest for another quality tier (lighting uniforms are kept). */
  setForest(opts: OuterLandOptions): void {
    const old = this.forest;
    this.group.remove(old.group);
    this.forest = new DistantForest(this.placeTrees(opts.treeCount), opts.foliage, {
      nearSprites: opts.nearSprites,
      farSprites: opts.farSprites,
      msaa: opts.msaa,
    });
    for (const k of Object.keys(old.uniforms)) {
      const v = old.uniforms[k].value as unknown;
      const dst = this.forest.uniforms[k];
      if (v && typeof (v as { clone?: unknown }).clone === 'function' && !(v as THREE.Texture).isTexture) (dst.value as { copy(o: unknown): void }).copy(v);
      else dst.value = v;
    }
    this.group.add(this.forest.group);
    old.dispose();
  }

  /** Re-sample heights next to the map border after terrain edits near the edge. */
  refreshBorder(): void {
    const g = this.near.geometry;
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i),
        z = p.getZ(i);
      if (OuterHeight.outside(x, z) > 30) continue;
      p.setY(i, ringHeight(this.heights, this.world, x, z));
    }
    p.needsUpdate = true;
  }

  /** Re-place the soft ground shadows under the outer trees for the current sun. */
  updateTreeShadows(sunDir: THREE.Vector3, strength: number): void {
    const blobs = this.blobs;
    if (!blobs) return;
    const elev = Math.asin(Math.min(1, Math.max(-1, sunDir.y)));
    const strengthChanged = Math.abs(strength - this.blobStrength) > 0.04;
    if (Math.abs(elev - this.blobSunElev) < 0.03 && !strengthChanged) return;
    this.blobStrength = strength;
    this.blobMat.opacity = 0.28 * strength;
    blobs.visible = strength > 0.02;
    if (!blobs.visible) return;
    if (Math.abs(elev - this.blobSunElev) < 0.03) return;
    this.blobSunElev = elev;
    const cot = 1 / Math.tan(Math.max(elev, 0.12));
    const dx = -sunDir.x,
      dz = -sunDir.z;
    const hl = Math.hypot(dx, dz) || 1;
    const ux = dx / hl,
      uz = dz / hl;
    const yaw = Math.atan2(ux, uz);
    const m = _m4,
      q = _q,
      sc = _s3,
      p = _p3;
    q.setFromAxisAngle(_up, yaw);
    const t = this.trees;
    for (let i = 0; i < this.treeCount; i++) {
      const x = t[i * 5],
        z = t[i * 5 + 2],
        h = t[i * 5 + 3],
        r = t[i * 5 + 4];
      // shadow of the crown centre (~0.65 h) projected along the sun
      const len = Math.min(h * 0.65 * cot, h * 3);
      const cx = x + ux * len * 0.85,
        cz = z + uz * len * 0.85;
      p.set(cx, t[i * 5 + 1] + 0.1, cz);
      sc.set(r * 2.1, 1, r * 2.1 + len * 0.9);
      m.compose(p, q, sc);
      blobs.setMatrixAt(i, m);
    }
    blobs.instanceMatrix.needsUpdate = true;
  }

  setMountainLight(haze: THREE.Color, sunCol: THREE.Color, amb: THREE.Color, sunDir: THREE.Vector3): void {
    this.mountainUniforms.uHaze.value.copy(haze);
    this.mountainUniforms.uSunCol.value.copy(sunCol);
    this.mountainUniforms.uAmb.value.copy(amb);
    this.mountainUniforms.uSunDir.value.copy(sunDir);
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    this.forest.dispose();
    this.blobPlane.dispose();
    this.blobs?.dispose();
    this.blobMat.dispose();
    this.blobTex.dispose();
    this.mountainMat.dispose();
  }
}

