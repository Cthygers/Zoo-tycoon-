// Instanced grass tufts on Grass / DryGrass tiles around the area the camera
// looks at. Each instance is a tuft of curved, tapered blades; placement is
// deterministic per 4 m cell (hash based) so tufts never jump when the field
// is rebuilt. Density falls off with distance from the centre and every tuft
// carries a random threshold, so the vertex shader can shrink tufts smoothly
// in/out as the focus moves (no popping). Rebuilds are amortised over frames.

import * as THREE from 'three';
import { MAP_H, MAP_W, TILE, WATER_LEVEL } from '../core/constants';
import { hashFloat } from '../core/rng';
import { Terrain } from '../core/types';
import type { World } from '../core/world';
import { OBJECTS_BY_ID } from '../data/objects';
import { nightGroundLight, nightGroundMark } from './groundMaterial';
import { crownCover, lawnShare } from './terrain';

const CELL = 4; // metres
const CANDIDATES_PER_M2 = 6;

/** Tuft geometry per quality tier: blades × segments (triangles = blades × (2·segs − 1)). */
export interface TuftShape {
  blades: number;
  segs: number;
}

function buildTuft(shape: TuftShape): THREE.InstancedBufferGeometry {
  const BLADES = shape.blades;
  const SEGS = shape.segs;
  const pos: number[] = [];
  const nrm: number[] = [];
  const at: number[] = [];
  const side: number[] = [];
  const idx: number[] = [];
  let s = 12345;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let b = 0; b < BLADES; b++) {
    const r = Math.sqrt(rnd()) * 0.13;
    const ra = rnd() * Math.PI * 2;
    const rx = Math.cos(ra) * r,
      rz = Math.sin(ra) * r;
    const h = 0.17 + rnd() * 0.12;
    const face = rnd() * Math.PI * 2;
    const sx = Math.cos(face),
      sz = Math.sin(face);
    // lean roughly outward from the tuft centre
    const la = ra + (rnd() - 0.5) * 1.2;
    const lean = (0.12 + rnd() * 0.25) * h;
    const lx = Math.cos(la) * lean,
      lz = Math.sin(la) * lean;
    const w0 = 0.006 + rnd() * 0.004;
    const phase = rnd();
    const base = pos.length / 3;
    for (let k = 0; k <= SEGS; k++) {
      const t = k / SEGS;
      const cx = rx + lx * t * t,
        cz = rz + lz * t * t;
      const cy = h * t * (1 - 0.18 * t * t);
      // face normal: perpendicular to the side vector, tilted by the lean
      let nx = -sz,
        nz = sx;
      if (nx * lx + nz * lz > 0) {
        nx = -nx;
        nz = -nz;
      }
      const ny = 0.9;
      const l = Math.hypot(nx, ny, nz);
      if (k < SEGS) {
        const wdt = w0 * Math.pow(1 - t, 0.9);
        pos.push(cx - sx * wdt, cy, cz - sz * wdt, cx + sx * wdt, cy, cz + sz * wdt);
        nrm.push(nx / l, ny / l, nz / l, nx / l, ny / l, nz / l);
        at.push(t, phase, t, phase);
        side.push(-sx * wdt, -sz * wdt, sx * wdt, sz * wdt);
      } else {
        pos.push(cx, cy, cz);
        nrm.push(nx / l, ny / l, nz / l);
        at.push(1, phase);
        side.push(0, 0);
      }
    }
    for (let k = 0; k < SEGS - 1; k++) {
      const a = base + k * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const lastRow = base + (SEGS - 1) * 2;
    idx.push(lastRow, lastRow + 1, lastRow + 2);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(at, 2));
  // offset of each vertex from its blade's centre line (half width), so the shader can thin blades
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 2));
  g.setIndex(idx);
  return g;
}

export interface GrassUniforms {
  [k: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uCenter: THREE.IUniform<THREE.Vector2>;
  uRadius: THREE.IUniform<number>;
  uR0: THREE.IUniform<number>;
  uGlobal: THREE.IUniform<number>;
  uWind: THREE.IUniform<THREE.Vector2>;
  uNoise: THREE.IUniform<THREE.Texture>;
  uSunCol: THREE.IUniform<THREE.Color>;
  uSunDirW: THREE.IUniform<THREE.Vector3>;
  /** Night level of moonlit ground, as the ground's (groundMaterial.ts NIGHT_GROUND). */
  uNightLift: THREE.IUniform<number>;
}

/** Shared LOD falloff (CPU twin of the vertex-shader function). */
function falloff(r: number, r0: number, R: number): number {
  const f = r < r0 ? 1 : Math.pow(r0 / r, 1.4);
  const e = Math.min(Math.max((r - R * 0.8) / (R * 0.2), 0), 1);
  return f * (1 - e * e * (3 - 2 * e));
}

/** Lawn share (terrain.ts lawnShare) from which a pond's mud ring counts as lawn margin (groundMaterial.ts gShoreMud). */
const SHORE_LAWN_MIN = 0.25;

/** Lawn share of every pond-shore mud tile (0 elsewhere), row-major MAP_W × MAP_H. */
export function shoreLawnShares(world: World): Float32Array {
  const out = new Float32Array(MAP_W * MAP_H);
  for (let z = 0; z < MAP_H; z++)
    for (let x = 0; x < MAP_W; x++) if (world.terrain[world.idx(x, z)] === Terrain.Mud) out[z * MAP_W + x] = lawnShare(world, x, z);
  return out;
}

export class GrassField {
  readonly mesh: THREE.Mesh;
  readonly uniforms: GrassUniforms;
  private geo: THREE.InstancedBufferGeometry;
  private material: THREE.MeshStandardMaterial;
  private iPos: THREE.InstancedBufferAttribute;
  private iPar: THREE.InstancedBufferAttribute;
  private capacity: number;
  private stagePos: Float32Array;
  private stagePar: Float32Array;
  private stageCount = 0;

  private density = 1;
  /** Tree crown cover per tile (terrain.ts crownCover), refreshed when the world changes. */
  private cover: Float32Array | null = null;
  /** Lawn share of pond-shore mud tiles (terrain.ts lawnShare), refreshed with `cover`. */
  private shoreLawn: Float32Array | null = null;
  private radius = 40;
  private builtCenter = new THREE.Vector2(1e9, 1e9);
  private wantCenter = new THREE.Vector2();
  private job: { cx0: number; cz0: number; cx1: number; cz1: number; cz: number; center: THREE.Vector2 } | null = null;
  private dirty = true;
  private enabled = true;

  constructor(
    private world: World,
    noise: THREE.Texture,
    capacity: number,
    readonly shape: TuftShape = { blades: 8, segs: 3 },
  ) {
    this.capacity = Math.max(64, capacity);
    this.geo = buildTuft(shape);
    this.stagePos = new Float32Array(this.capacity * 4);
    this.stagePar = new Float32Array(this.capacity * 4);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.iPar = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.iPos.setUsage(THREE.DynamicDrawUsage);
    this.iPar.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.iPos);
    this.geo.setAttribute('iPar', this.iPar);
    this.geo.instanceCount = 0;

    this.uniforms = {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector2() },
      uRadius: { value: 40 },
      uR0: { value: 10 },
      uGlobal: { value: 1 },
      uWind: { value: new THREE.Vector2(0.8, 0.6) },
      uNoise: { value: noise },
      uSunCol: { value: new THREE.Color(1, 1, 1) },
      uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
      uNightLift: { value: 0 },
    };
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0, side: THREE.DoubleSide });
    m.name = 'grass';
    m.customProgramCacheKey = () => 'wildhaven-grass';
    const u = this.uniforms;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec4 iPos;
          attribute vec4 iPar;
          attribute vec2 aBlade;
          attribute vec2 aSide;
          uniform float uTime;
          uniform vec2 uCenter;
          uniform float uRadius;
          uniform float uR0;
          uniform float uGlobal;
          uniform vec2 uWind;
          uniform sampler2D uNoise;
          varying vec3 vGCol;
          varying vec3 vGN;
          varying float vGT;
          varying float vGDry;
          float gFalloff(float r) {
            float f = r < uR0 ? 1.0 : pow(uR0 / r, 1.4);
            return f * (1.0 - smoothstep(uRadius * 0.8, uRadius, r));
          }`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `float gc = cos(iPos.w), gs = sin(iPos.w);
          mat2 gRot = mat2(gc, gs, -gs, gc);
          vec3 objectNormal = normal;
          objectNormal.xz = gRot * objectNormal.xz;`,
        )
        .replace(
          '#include <begin_vertex>',
          `float gr = length(iPos.xz - uCenter);
          float gvis = clamp((gFalloff(gr) * uGlobal - iPar.w) / 0.1, 0.0, 1.0);
          float gsc = iPar.x * gvis;
          // dry tufts: low, wide clumps (straw lodges and spreads) rather than tall sticks
          vec3 gSpread = mix(vec3(1.0), vec3(1.35, 0.7, 1.35), iPar.y);
          // their blades stay thin, finely tapered straw close to the camera (not
          // widened with the clump); a few metres out they keep the spread width
          // so they never thin below a pixel and flicker
          float gNear = 1.0 - smoothstep(3.0, 9.0, distance(cameraPosition, iPos.xyz));
          float gWidth = mix(1.0, mix(gSpread.x, 0.85 * (1.0 - 0.3 * aBlade.x), gNear), iPar.y);
          vec3 transformed = (position + vec3(aSide.x, 0.0, aSide.y) * (gWidth / gSpread.x - 1.0)) * gsc * gSpread;
          transformed.xz = gRot * transformed.xz;
          vec2 gwp = iPos.xz + transformed.xz;
          float gust = textureLod(uNoise, gwp * 0.012 - uWind * uTime * 0.035, 0.0).r;
          float sway = sin(uTime * 1.9 + aBlade.y * 6.2832 + dot(gwp, vec2(0.37, 0.23))) * 0.22 + (gust - 0.4) * 1.5;
          float bend = aBlade.x * aBlade.x * gsc * 0.42;
          transformed.xz += uWind * sway * bend;
          transformed.y -= abs(sway) * bend * 0.35;
          transformed += iPos.xyz;
          // colour: root dark, tip light; matches the ground's macro patches
          vec4 gm = textureLod(uNoise, iPos.xz * 0.019, 0.0);
          float macro = gm.r * 0.6 + 0.2;
          // dry straw: the dry-grass ground's own straw tone (tips a little paler,
          // bases a little darker), not bleached white
          vec3 base = mix(vec3(0.034, 0.052, 0.018), vec3(0.25, 0.2, 0.115), iPar.y);
          vec3 tip = mix(vec3(0.12, 0.19, 0.055), vec3(0.4, 0.33, 0.18), iPar.y);
          tip *= 0.85 + 0.3 * iPar.z;
          tip = mix(tip, tip * vec3(1.15, 1.02, 0.72), smoothstep(0.45, 0.75, gm.b) * 0.6);
          vGCol = mix(base, tip, smoothstep(0.0, 1.0, aBlade.x)) * (0.8 + 0.4 * macro);
          vGT = aBlade.x;
          vGDry = iPar.y;
          vGN = normalize(mix(vec3(0.0, 1.0, 0.0), objectNormal, 0.45));`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform vec3 uSunCol;
          uniform vec3 uSunDirW;
          uniform float uNightLift;
          varying vec3 vGCol;
          varying vec3 vGN;
          varying float vGT;
          varying float vGDry;`,
        )
        .replace('#include <map_fragment>', 'diffuseColor.rgb = vGCol;')
        .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(vGN, 0.0)).xyz);')
        .replace(
          '#include <aomap_fragment>',
          `float gNightMark = 0.0;
          {
            // blade-base occlusion of the sky fill: kept mild so shaded lawn
            // stays near the ground's own shade level (~20 % of sunlit)
            // (less on sparse dry clumps: dark roots made straw read as sticks)
            float occ = mix(mix(0.65, 0.8, vGDry), 1.0, vGT);
            reflectedLight.indirectDiffuse *= occ;
            reflectedLight.directDiffuse *= mix(mix(0.7, 0.85, vGDry), 1.0, vGT);
            // thin-blade translucency when looking toward the sun
            vec3 vdW = normalize(vViewPosition);
            vec3 vdWorld = normalize((vec4(vdW, 0.0) * viewMatrix).xyz);
            float back = pow(clamp(dot(-vdWorld, uSunDirW), 0.0, 1.0), 3.0);
            reflectedLight.directDiffuse += uSunCol * diffuseColor.rgb * back * vGT * 0.22;
            // straw is matte: no white sky sheen or glints along near blades
            reflectedLight.directSpecular *= 1.0 - 0.6 * vGDry;
            reflectedLight.indirectSpecular *= 1.0 - 0.6 * vGDry;
            // moonlit tufts get the ground's night look (groundMaterial.ts NIGHT_GROUND)
            ${nightGroundLight('1.0', 'diffuseColor.rgb', 'gNightMark')}
          }`,
        )
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>${nightGroundMark('gNightMark')}`);
    };
    this.material = m;
    this.mesh = new THREE.Mesh(this.geo, m);
    this.mesh.name = 'grass';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
  }

  configure(density: number, radius: number): void {
    // keep the expected tuft count inside the instance capacity
    const r0 = Math.max(8, radius * 0.28);
    const area = Math.PI * r0 * r0 + ((2 * Math.PI * Math.pow(r0, 1.4)) / 0.6) * (Math.pow(radius, 0.6) - Math.pow(r0, 0.6));
    const expected = area * CANDIDATES_PER_M2 * density * 0.85;
    this.density = density * Math.min(1, (this.capacity * 0.92) / Math.max(1, expected));
    this.radius = radius;
    this.enabled = this.density > 0.01;
    this.mesh.visible = this.enabled;
    this.uniforms.uRadius.value = radius;
    this.uniforms.uR0.value = Math.max(8, radius * 0.28);
    this.dirty = true;
  }

  markDirty(): void {
    this.dirty = true;
    this.cover = null;
    this.shoreLawn = null;
  }

  /**
   * Set the field centre (ground point) and the global visibility (0 hides grass
   * when the camera is too far for blades to be visible).
   */
  setCenter(x: number, z: number, global: number): void {
    this.wantCenter.set(x, z);
    this.uniforms.uGlobal.value = global;
  }

  /** Amortised rebuild; call every frame. `budget` = cells processed per call. */
  update(time: number, budget = 160): void {
    this.uniforms.uTime.value = time;
    if (!this.enabled) return;
    if (!this.job) {
      const moved = this.wantCenter.distanceTo(this.builtCenter);
      if (!this.dirty && moved < 4) return;
      this.startJob();
    }
    const job = this.job;
    if (!job) return;
    let cells = 0;
    while (job.cz <= job.cz1 && cells < budget) {
      for (let cx = job.cx0; cx <= job.cx1; cx++) this.fillCell(cx, job.cz, job.center);
      cells += job.cx1 - job.cx0 + 1;
      job.cz++;
    }
    if (job.cz > job.cz1) this.finishJob();
  }

  private startJob() {
    const c = this.wantCenter.clone();
    const R = this.radius + 6;
    this.job = {
      cx0: Math.floor((c.x - R) / CELL),
      cx1: Math.floor((c.x + R) / CELL),
      cz0: Math.floor((c.y - R) / CELL),
      cz1: Math.floor((c.y + R) / CELL),
      cz: Math.floor((c.y - R) / CELL),
      center: c,
    };
    this.stageCount = 0;
    this.dirty = false;
    this.cover ??= crownCover(this.world);
    this.shoreLawn ??= shoreLawnShares(this.world);
  }

  private fillCell(cx: number, cz: number, center: THREE.Vector2) {
    const x0 = cx * CELL,
      z0 = cz * CELL;
    if (x0 + CELL <= 0 || z0 + CELL <= 0 || x0 >= MAP_W * TILE || z0 >= MAP_H * TILE) return;
    const R = this.radius;
    const r0 = Math.max(8, R * 0.28);
    // nearest point of the cell to the centre: early out
    const nx = Math.min(Math.max(center.x, x0), x0 + CELL),
      nz = Math.min(Math.max(center.y, z0), z0 + CELL);
    const dmin = Math.hypot(nx - center.x, nz - center.y);
    if (dmin > R) return;
    const fMax = falloff(dmin, r0, R) * this.density;
    const n = Math.round(CELL * CELL * CANDIDATES_PER_M2);
    const w = this.world;
    for (let k = 0; k < n; k++) {
      const h = hashFloat(cx * 7 + k, cz * 13 - k, 77);
      if (h >= fMax) continue;
      const px = x0 + hashFloat(cx, cz, k * 2 + 1) * CELL;
      const pz = z0 + hashFloat(cx, cz, k * 2 + 2) * CELL;
      // kept only where the shader can show it (threshold below the falloff at
      // the tuft; uCenter is the centre this field was built for): tufts that
      // could never show used to fill the capacity from the field's far rows,
      // leaving none near the focus
      if (h >= falloff(Math.hypot(px - center.x, pz - center.y), r0, R) * this.density) continue;
      const tx = Math.floor(px / TILE),
        tz = Math.floor(pz / TILE);
      if (!w.inBounds(tx, tz)) continue;
      const ti = w.idx(tx, tz);
      const ter = w.terrain[ti];
      // the turf also grows into a pond's mud ring, as the ground shader draws it
      // (groundMaterial.ts sampleGround): thinning out toward the water
      const shore = ter === Terrain.Mud && this.shoreLawn ? this.shoreLawn[ti] : 0;
      if (ter !== Terrain.Grass && ter !== Terrain.DryGrass && shore < SHORE_LAWN_MIN) continue;
      if (w.path[ti]) continue;
      const oid = w.objectGrid[ti];
      if (oid) {
        const o = w.objects.get(oid);
        if (o && OBJECTS_BY_ID[o.defId]?.solid) continue;
      }
      // keep clear of neighbouring paths / water
      const fx = px / TILE - tx,
        fz = pz / TILE - tz;
      const m = 0.2;
      if (fx < m && this.blocked(tx - 1, tz)) continue;
      if (fx > 1 - m && this.blocked(tx + 1, tz)) continue;
      if (fz < m && this.blocked(tx, tz - 1)) continue;
      if (fz > 1 - m && this.blocked(tx, tz + 1)) continue;
      // thinner, shorter turf under tree crowns
      const under = this.cover ? this.cover[ti] : 0;
      if (under > 0 && hashFloat(cz - k, cx, 29) < under * 0.5) continue;
      const y = w.heightAt(px, pz);
      if (y < WATER_LEVEL + 0.08) continue;
      if (shore > 0 && y < WATER_LEVEL + 0.12 + 0.14 * hashFloat(cx - k, cz + k, 41)) continue;
      if (this.stageCount >= this.capacity) return;
      const dry = ter === Terrain.DryGrass;
      const j = this.stageCount * 4;
      this.stagePos[j] = px;
      this.stagePos[j + 1] = y - 0.01;
      this.stagePos[j + 2] = pz;
      this.stagePos[j + 3] = hashFloat(cx + k, cz, 3) * Math.PI * 2;
      const hs = hashFloat(k, cx, cz + 11);
      this.stagePar[j] = (dry ? 1.7 + hs * 0.5 : 0.55 + hs * 0.35) * (1 - 0.3 * under) * (shore > 0 ? 0.8 : 1);
      this.stagePar[j + 1] = dry ? 1 : 0;
      this.stagePar[j + 2] = hashFloat(cz, k, cx + 5);
      this.stagePar[j + 3] = h / Math.max(this.density, 1e-3);
      this.stageCount++;
    }
  }

  private blocked(x: number, z: number): boolean {
    const w = this.world;
    if (!w.inBounds(x, z)) return false;
    const i = w.idx(x, z);
    const t = w.terrain[i];
    return w.path[i] !== 0 || t === Terrain.Water || t === Terrain.DeepWater;
  }

  private finishJob() {
    const job = this.job!;
    this.job = null;
    (this.iPos.array as Float32Array).set(this.stagePos.subarray(0, this.stageCount * 4));
    (this.iPar.array as Float32Array).set(this.stagePar.subarray(0, this.stageCount * 4));
    this.iPos.clearUpdateRanges();
    this.iPar.clearUpdateRanges();
    this.iPos.addUpdateRange(0, this.stageCount * 4);
    this.iPar.addUpdateRange(0, this.stageCount * 4);
    this.iPos.needsUpdate = true;
    this.iPar.needsUpdate = true;
    this.geo.instanceCount = this.stageCount;
    this.builtCenter.copy(job.center);
    this.uniforms.uCenter.value.copy(job.center);
  }

  /** Number of tufts currently drawn. */
  get count(): number {
    return this.geo.instanceCount;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}
