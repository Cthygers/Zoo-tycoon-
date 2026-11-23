// Design → skinned BufferGeometry:
//   prims → compiled SDF → multi-resolution surface nets → skin weights →
//   per-vertex attributes (coat or human clothing zones) → eyes.

import * as THREE from 'three';
import { CompiledPrim, type Prim, type Vec3 } from '../sdf/prims';
import { SdfField } from '../sdf/field';
import { mergeRaw, surfaceNets, type Box3Like, type MeshRegion, type RawMesh } from '../sdf/mesher';
import { RigDef, type BoneSpec } from '../rig/rig';
import type { CoatSample, EyeSpec, RegionOpts } from '../types';

export let DEBUG_REGIONS = false;
export function setDebugRegions(v: boolean): void {
  DEBUG_REGIONS = v;
}

export const BASE_CELLS: readonly number[] = [28, 36, 50];

export interface MeshInput {
  bones: BoneSpec[];
  prims: Prim[];
  regions?: Record<string, RegionOpts>;
  resolution?: number;
  /** Cells along the longest axis for detail 0/1/2 (default BASE_CELLS). */
  cells?: readonly number[];
  /** Base cell anisotropy multiplier (e.g. humans [1, 1.5, 1]). */
  baseAniso?: Vec3;
}

export interface AttrSpec {
  name: string;
  size: number;
}

/** Writes custom per-vertex attributes from a surface sample. */
export interface VertexBaker {
  attributes: AttrSpec[];
  bake(s: SampleImpl, out: Float32Array[], vi: number): void;
}

export interface BuildResult {
  geometry: THREE.BufferGeometry;
  rig: RigDef;
  field: SdfField;
  bounds: THREE.Box3;
  triangles: number;
  ms: number;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Mutable sample implementing the CoatSample interface. */
export class SampleImpl implements CoatSample {
  x = 0; y = 0; z = 0;
  nx = 0; ny = 1; nz = 0;
  part = '';
  bone = '';
  t = 0;
  partIdx = 0;
  boneIdx = 0;
  readonly color = new THREE.Color();
  readonly color2 = new THREE.Color();
  s = 0;
  w = 0;
  gloss = 0;
  fur = 1;
  /** Normalized part weights (index = part id). */
  partW: Float32Array;
  /** Raw min distance per part (index = part id). */
  partD: Float32Array;
  private readonly partIndex: Map<string, number>;
  private readonly parts: string[];

  constructor(parts: string[]) {
    this.parts = parts;
    this.partW = new Float32Array(parts.length);
    this.partD = new Float32Array(parts.length);
    this.partIndex = new Map(parts.map((p, i) => [p, i]));
  }

  pw(part: string): number {
    const i = this.partIndex.get(part);
    return i === undefined ? 0 : this.partW[i];
  }

  /** Smallest raw SDF distance to any primitive tagged `part` (large if none). */
  pd(part: string): number {
    const i = this.partIndex.get(part);
    return i === undefined ? 1e3 : this.partD[i];
  }

  /** Smallest raw distance to any primitive whose part is NOT in `exclude`. */
  pdExcept(exclude: readonly string[]): number {
    let m = 1e3;
    for (let i = 0; i < this.parts.length; i++) if (!exclude.includes(this.parts[i]) && this.partD[i] < m) m = this.partD[i];
    return m;
  }

  resetOutputs(): void {
    this.color.setRGB(0.5, 0.5, 0.5);
    this.color2.setRGB(0, 0, 0);
    this.s = 0;
    this.w = 0;
    this.gloss = 0;
    this.fur = 1;
  }
}

export function compile(bones: BoneSpec[], prims: Prim[]): { field: SdfField; rig: RigDef; parts: string[]; regions: string[] } {
  const rig = new RigDef(bones);
  const parts: string[] = [];
  const regions: string[] = [];
  const partId = (p: string) => {
    let i = parts.indexOf(p);
    if (i < 0) i = parts.push(p) - 1;
    return i;
  };
  const regionId = (r: string | undefined) => {
    if (!r) return -1;
    let i = regions.indexOf(r);
    if (i < 0) i = regions.push(r) - 1;
    return i;
  };
  const compiled = prims.map((p) => new CompiledPrim(p, rig.bone(p.bone), partId(p.part ?? p.bone), regionId(p.region)));
  return { field: new SdfField(compiled), rig, parts, regions };
}

function geomBox(p: CompiledPrim): [number, number, number, number, number, number] {
  // influence box shrunk back by blend (≈ geometric box incl. noise) + k/4 bulge
  const g = p.k * 0.75;
  return [p.minX + g, p.minY + g, p.minZ + g, p.maxX - g, p.maxY - g, p.maxZ - g];
}

/** Fine-cell divisor (minimum primitive radius / k) per detail level. */
const REGION_K: readonly number[] = [0.95, 1.25, 1.75];

interface Plan {
  region: MeshRegion;
  /** region index (-1 = base) */
  ri: number;
  /** largest cell dimension */
  h: number;
  /** The region's primitives are left out of coarser grids. */
  noBase: boolean;
  /**
   * How far (in dominance metres) this plan's mesh reaches into territory
   * owned by other primitives: its own cell plus half a cell of the coarsest
   * overlapping grid, so the coarse mesh is already sunk where the fine one
   * ends (no coincident surfaces at the seam).
   */
  reach: number;
}

function overlapsBox(a: Box3Like, b: Box3Like): boolean {
  for (let k = 0; k < 3; k++) if (a.max[k] < b.min[k] || a.min[k] > b.max[k]) return false;
  return true;
}

/**
 * Dominance of region `ri` at a point: (distance to the nearest primitive NOT
 * in the region) − (distance to the nearest primitive IN the region).
 * Positive where the region's primitives are the closest surface.
 */
function dominance(field: SdfField, ri: number, x: number, y: number, z: number, list: Int32Array | null): number {
  let dIn = 1e3, dOut = 1e3;
  const prims = field.prims;
  const n = list ? list.length : prims.length;
  for (let k = 0; k < n; k++) {
    const p = prims[list ? list[k] : k];
    if (p.sub) continue;
    const d = p.dist(x, y, z);
    if (p.region === ri) {
      if (d < dIn) dIn = d;
    } else if (d < dOut) dOut = d;
  }
  return dOut - dIn;
}

/**
 * Seam tuning (exported for the harness): `reach` = extra coverage of a fine
 * mesh into territory owned by coarser grids (in coarse cells, at most
 * `reachMax` of its own cells so tiny regions stay cheap), `lead` = how
 * far (coarse cells) before the fine mesh ends the coarse sink starts, `full`
 * = dominance (coarse cells, 0 = the junction itself) where the sink is
 * complete, `sink` = full sink depth (coarse cells).
 * `legacy` restores the first-pass behaviour for A/B comparisons.
 */
export const SEAM = { reach: 0, reachMax: 1.5, lead: 0.1, full: 1.2, sink: 0.35, legacy: false };

/**
 * Mesh the design on a multi-resolution grid: a base grid over everything
 * plus finer grids for detail regions. Surface cells are partitioned by
 * ownership (which region's primitives are closest) with an overlap band; the
 * coarser mesh sinks inside the band so the finer mesh always wins the depth
 * test (no z-fighting, no cracks). The sink ramp starts a little before the
 * fine mesh ends and reaches ≈ half a coarse cell at the junction itself, so
 * coarse chords that bridge concave creases (leg into body, head into neck)
 * stay under the fine surface. Regions with `noBase` are left out of coarser
 * grids altogether (no bridging sheets between thin parts and the body).
 */
export function meshDesign(input: MeshInput, detail: 0 | 1 | 2, field: SdfField, regions: string[]): { raw: RawMesh; bounds: THREE.Box3 } {
  const bounds = new THREE.Box3();
  const v3 = new THREE.Vector3();
  for (const p of field.prims) {
    if (p.sub) continue;
    const b = geomBox(p);
    bounds.expandByPoint(v3.set(b[0], b[1], b[2]));
    bounds.expandByPoint(v3.set(b[3], b[4], b[5]));
  }
  const size = bounds.getSize(new THREE.Vector3());
  const cells = (input.cells ?? BASE_CELLS)[detail] * (input.resolution ?? 1);
  const h = Math.max(size.x, size.y, size.z) / cells;
  const an = input.baseAniso ?? [1, 1, 1];
  const margin = h * 1.5;
  const plans: Plan[] = [
    {
      region: {
        min: [bounds.min.x - margin, bounds.min.y - margin, bounds.min.z - margin],
        max: [bounds.max.x + margin, bounds.max.y + margin, bounds.max.z + margin],
        cell: [h * an[0], h * an[1], h * an[2]],
      },
      ri: -1,
      h: h * Math.max(an[0], an[1], an[2]),
      noBase: false,
      reach: 0,
    },
  ];
  regions.forEach((name, ri) => {
    const members = field.prims.filter((p) => p.region === ri);
    if (!members.length) return;
    const opts = input.regions?.[name] ?? {};
    let minR = Infinity;
    const rb = new THREE.Box3();
    for (const p of members) {
      if (p.sub) continue;
      minR = Math.min(minR, p.minR);
      const b = geomBox(p);
      rb.expandByPoint(v3.set(b[0], b[1], b[2]));
      rb.expandByPoint(v3.set(b[3], b[4], b[5]));
    }
    if (!isFinite(minR)) return;
    let fine = opts.scale !== undefined ? h * opts.scale : Math.max(h * 0.18, minR / REGION_K[detail]);
    if (opts.cell !== undefined && opts.cell > 0) fine = Math.min(fine, opts.cell);
    fine = Math.min(fine, h);
    const a = opts.aniso ?? [1, 1, 1];
    const cell: Vec3 = [fine * a[0], fine * a[1], fine * a[2]];
    const cm = Math.max(cell[0], cell[1], cell[2]);
    // room for the seam reach (see below) on top of the usual 2.5 cells
    const m = Math.max(cm * 2.5, (cm * 1.2 + Math.min(SEAM.reach * h, SEAM.reachMax * cm)) * 1.3 + cm);
    plans.push({
      region: { min: [rb.min.x - m, rb.min.y - m, rb.min.z - m], max: [rb.max.x + m, rb.max.y + m, rb.max.z + m], cell },
      ri,
      h: Math.max(cell[0], cell[1], cell[2]),
      noBase: !!opts.noBase,
      reach: 0,
    });
  });
  // finer / coarser overlapping plans
  const finerOf = new Map<Plan, Plan[]>();
  for (const P of plans) finerOf.set(P, plans.filter((R) => R !== P && R.h < P.h && overlapsBox(P.region, R.region)));
  for (const P of plans) {
    let coarse = 0;
    for (const Q of plans) if (Q !== P && Q.h > P.h && overlapsBox(P.region, Q.region)) coarse = Math.max(coarse, Q.h);
    P.reach = P.h * 1.2 + (SEAM.legacy ? 0 : Math.min(coarse * SEAM.reach, P.h * SEAM.reachMax));
  }
  // ownership tests + primitives left out of coarser grids
  for (const P of plans) {
    const finer = finerOf.get(P)!;
    if (P.ri >= 0) P.region.ownRegion = P.ri;
    const skipRegions = finer.filter((R) => R.noBase).map((R) => R.ri);
    if (skipRegions.length) {
      const skip = new Uint8Array(field.prims.length);
      field.prims.forEach((p, i) => {
        if (skipRegions.includes(p.region)) skip[i] = 1;
      });
      P.region.skipPrims = skip;
    }
    const keepFiner = finer.filter((R) => !R.noBase);
    P.region.keep = (x, y, z, list) => {
      if (P.ri >= 0 && dominance(field, P.ri, x, y, z, list) < -P.reach) return false;
      for (const R of keepFiner) {
        const b = R.region;
        if (x < b.min[0] || x > b.max[0] || y < b.min[1] || y > b.max[1] || z < b.min[2] || z > b.max[2]) continue;
        if (dominance(field, R.ri, x, y, z, list) > P.h * 1.5) return false;
      }
      return true;
    };
  }
  const parts: RawMesh[] = [];
  for (const P of plans) {
    const mesh = surfaceNets(field, P.region);
    // sink vertices where a finer region takes over (ramped across the overlap band)
    const finer = finerOf.get(P)!;
    if (finer.length) {
      mesh.surface = mesh.positions.slice();
      const pos = mesh.positions, nrm = mesh.normals;
      const lists = finer.map((R) => field.cull(R.region.min[0], R.region.min[1], R.region.min[2], R.region.max[0], R.region.max[1], R.region.max[2]));
      // sink relative to the smallest cell dimension (anisotropic grids would
      // otherwise push vertices through thin limbs)
      const minCell = Math.min(P.region.cell[0], P.region.cell[1], P.region.cell[2]);
      const maxSink = SEAM.legacy ? 0.3 * P.h : SEAM.sink * minCell;
      for (let v = 0; v < pos.length; v += 3) {
        let ramp = 0;
        const x = pos[v], y = pos[v + 1], z = pos[v + 2];
        let li = -1;
        for (let ri = 0; ri < finer.length; ri++) {
          const R = finer[ri];
          if (x < R.region.min[0] || x > R.region.max[0] || y < R.region.min[1] || y > R.region.max[1] || z < R.region.min[2] || z > R.region.max[2]) continue;
          const dom = dominance(field, R.ri, x, y, z, lists[ri]);
          li = ri;
          // fade out toward the faces of the finer region's box: past them the fine
          // mesh does not exist, and a sudden step in sink would tear the coarse mesh
          const b = R.region;
          const edge = Math.min(x - b.min[0], b.max[0] - x, y - b.min[1], b.max[1] - y, z - b.min[2], b.max[2] - z);
          const boxFade = SEAM.legacy ? 1 : Math.min(1, edge / Math.max(1e-6, P.h));
          // starts just before the fine mesh ends, complete at the junction itself
          const lo = SEAM.legacy ? -R.h * 1.2 : -R.reach - SEAM.lead * P.h;
          const hi = SEAM.legacy ? P.h * 1.5 : SEAM.full * P.h;
          if (dom > lo) ramp = Math.max(ramp, Math.min(1, (dom - lo) / (hi - lo)) * boxFade);
        }
        if (ramp > 0) {
          let sink = ramp * ramp * (3 - 2 * ramp) * maxSink;
          // never sink past the middle of a thin part (the vertex would come out
          // on the far side as a flap): halve until the sunk point is still deep inside
          if (!SEAM.legacy && li >= 0) {
            const L = lists[li];
            for (let k = 0; k < 3; k++) {
              const d = field.evalList(x - nrm[v] * sink, y - nrm[v + 1] * sink, z - nrm[v + 2] * sink, L, L.length);
              if (d < -0.45 * sink) break;
              sink *= 0.5;
            }
          }
          pos[v] -= nrm[v] * sink;
          pos[v + 1] -= nrm[v + 1] * sink;
          pos[v + 2] -= nrm[v + 2] * sink;
        }
      }
    }
    parts.push(mesh);
  }
  if (DEBUG_REGIONS) {
    plans.forEach((P, i) => console.log(i === 0 ? 'base' : '  region ' + regions[P.ri], P.region.cell.map((v) => v.toFixed(3)).join(','), 'tris', parts[i].indices.length / 3, P.noBase ? '(noBase)' : ''));
  }
  return { raw: mergeRaw(parts), bounds };
}

/** Remove vertices not referenced by any triangle and compact. */
function compact(raw: RawMesh): RawMesh {
  const nv = raw.positions.length / 3;
  const used = new Int32Array(nv).fill(-1);
  let n = 0;
  for (let i = 0; i < raw.indices.length; i++) {
    const v = raw.indices[i];
    if (used[v] < 0) used[v] = n++;
  }
  if (n === nv) return raw;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const surface = new Float32Array(n * 3);
  const src = raw.surface ?? raw.positions;
  for (let v = 0; v < nv; v++) {
    const u = used[v];
    if (u < 0) continue;
    positions[u * 3] = raw.positions[v * 3];
    positions[u * 3 + 1] = raw.positions[v * 3 + 1];
    positions[u * 3 + 2] = raw.positions[v * 3 + 2];
    surface[u * 3] = src[v * 3];
    surface[u * 3 + 1] = src[v * 3 + 1];
    surface[u * 3 + 2] = src[v * 3 + 2];
    normals[u * 3] = raw.normals[v * 3];
    normals[u * 3 + 1] = raw.normals[v * 3 + 1];
    normals[u * 3 + 2] = raw.normals[v * 3 + 2];
  }
  const indices = new Uint32Array(raw.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = used[raw.indices[i]];
  return { positions, normals, indices, surface };
}

/**
 * Full build: mesh, skin and bake. `eyes` are merged as glossy spheres rigidly
 * bound to their bone (one draw call per creature).
 */
export function buildGeometry(input: MeshInput, detail: 0 | 1 | 2, baker: VertexBaker, eyes: EyeSpec[] = []): BuildResult {
  const t0 = now();
  const { field, rig, parts, regions } = compile(input.bones, input.prims);
  const meshed = meshDesign(input, detail, field, regions);
  const raw = compact(meshed.raw);
  const nv = raw.positions.length / 3;

  // ---- eyes
  const eyeGeo: { pos: number[]; nrm: number[]; idx: number[]; bone: number[]; color: number[] } = { pos: [], nrm: [], idx: [], bone: [], color: [] };
  const eyeDetail = detail === 0 ? 1 : 2;
  for (const e of eyes) {
    const bi = rig.bone(e.bone);
    for (const side of [1, -1]) {
      const g = new THREE.IcosahedronGeometry(e.radius, eyeDetail);
      const p = g.getAttribute('position');
      const base = (nv * 3 + eyeGeo.pos.length) / 3;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        eyeGeo.pos.push(e.pos[0] * side + x, e.pos[1] + y, e.pos[2] + z);
        const l = Math.sqrt(x * x + y * y + z * z) || 1;
        eyeGeo.nrm.push(x / l, y / l, z / l);
        eyeGeo.idx.push(base + i);
        eyeGeo.bone.push(bi);
        eyeGeo.color.push(e.color ?? 0x120c08);
      }
      g.dispose();
    }
  }
  const ne = eyeGeo.pos.length / 3;
  const total = nv + ne;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  position.set(raw.positions, 0);
  normal.set(raw.normals, 0);
  position.set(eyeGeo.pos, nv * 3);
  normal.set(eyeGeo.nrm, nv * 3);
  const skinIndex = new Uint16Array(total * 4);
  const skinWeight = new Float32Array(total * 4);
  const outs = baker.attributes.map((a) => new Float32Array(total * a.size));

  // ---- skin weights + samples
  const prims = field.prims;
  const nb = rig.count;
  const boneW = new Float32Array(nb);
  const sample = new SampleImpl(parts);
  const np = parts.length;
  const top = [0, 0, 0, 0];
  const topW = [0, 0, 0, 0];
  const surf = raw.surface ?? raw.positions;
  // bones may only share a vertex with bones close in the hierarchy (≤ 2
  // ancestor / descendant steps) of its dominant bone, so e.g. a hand hanging
  // next to a thigh never gets thigh weights.
  const allowed = new Uint8Array(nb * nb);
  for (let b = 0; b < nb; b++) {
    allowed[b * nb + b] = 1;
    let a = rig.parent[b];
    for (let k = 0; k < 2 && a >= 0; k++, a = rig.parent[a]) {
      allowed[b * nb + a] = 1;
      allowed[a * nb + b] = 1;
    }
  }
  // carving primitives with an explicit part tag are measured by pd(part)
  // (mouth lines, nostrils, eye sockets) but never contribute skin / part weights
  const measureSub = new Uint8Array(prims.length);
  input.prims.forEach((p, i) => {
    if (p.sub && p.part !== undefined) measureSub[i] = 1;
  });
  // coarse spatial grid of candidate primitives (skin influence reaches ≈ 5σ)
  const GN = 8;
  const bmin = meshed.bounds.min, bsize = meshed.bounds.getSize(new THREE.Vector3());
  const gs = [Math.max(bsize.x, 1e-3) / GN, Math.max(bsize.y, 1e-3) / GN, Math.max(bsize.z, 1e-3) / GN];
  const cellLists: Int32Array[] = [];
  for (let k = 0; k < GN; k++)
    for (let j = 0; j < GN; j++)
      for (let i = 0; i < GN; i++) {
        const x0 = bmin.x + i * gs[0], y0 = bmin.y + j * gs[1], z0 = bmin.z + k * gs[2];
        const l: number[] = [];
        for (let pi = 0; pi < prims.length; pi++) {
          const p = prims[pi];
          if (p.sub && !measureSub[pi]) continue;
          const m = Math.min(5 * p.skinSigma, 0.3) + 0.02;
          if (!(x0 + gs[0] < p.minX - m || x0 > p.maxX + m || y0 + gs[1] < p.minY - m || y0 > p.maxY + m || z0 + gs[2] < p.minZ - m || z0 > p.maxZ + m)) l.push(pi);
        }
        cellLists.push(Int32Array.from(l));
      }
  const cellOf = (x: number, y: number, z: number): Int32Array => {
    const i = Math.min(GN - 1, Math.max(0, Math.floor((x - bmin.x) / gs[0])));
    const j = Math.min(GN - 1, Math.max(0, Math.floor((y - bmin.y) / gs[1])));
    const k = Math.min(GN - 1, Math.max(0, Math.floor((z - bmin.z) / gs[2])));
    return cellLists[i + GN * (j + GN * k)];
  };
  for (let v = 0; v < nv; v++) {
    const x = surf[v * 3], y = surf[v * 3 + 1], z = surf[v * 3 + 2];
    boneW.fill(0);
    sample.partW.fill(0);
    sample.partD.fill(1e3);
    let bestW = -1, bestPrim = -1;
    const cand = cellOf(x, y, z);
    for (let ci = 0; ci < cand.length; ci++) {
      const i = cand[ci];
      const p = prims[i];
      const d = p.dist(x, y, z);
      if (d < sample.partD[p.part]) sample.partD[p.part] = d;
      if (p.noSkin) continue;
      const w = p.skinW * Math.exp(-(d > 0 ? d : 0) / p.skinSigma) * (d < 0 ? 1 + Math.min(1, -d / p.skinSigma) * 0.25 : 1);
      if (w > boneW[p.bone]) boneW[p.bone] = w;
      sample.partW[p.part] += w;
      if (w > bestW) {
        bestW = w;
        bestPrim = i;
      }
    }
    if (bestPrim < 0) {
      // nothing nearby (should not happen): fall back to every primitive
      for (let i = 0; i < prims.length; i++) {
        const p = prims[i];
        if (p.sub || p.noSkin) continue;
        const d = p.dist(x, y, z);
        if (-d > bestW) {
          bestW = -d;
          bestPrim = i;
        }
      }
      boneW[prims[bestPrim].bone] = 1;
    }
    const dom = prims[bestPrim].bone;
    for (let b = 0; b < nb; b++) if (!allowed[dom * nb + b]) boneW[b] = 0;
    // top 4 bones
    for (let k = 0; k < 4; k++) {
      top[k] = 0;
      topW[k] = 0;
    }
    for (let b = 0; b < nb; b++) {
      const w = boneW[b];
      if (w <= topW[3]) continue;
      let k = 3;
      while (k > 0 && topW[k - 1] < w) {
        topW[k] = topW[k - 1];
        top[k] = top[k - 1];
        k--;
      }
      topW[k] = w;
      top[k] = b;
    }
    // drop tiny weights to keep deformation crisp
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      if (topW[k] < topW[0] * 0.04) topW[k] = 0;
      sum += topW[k];
    }
    if (sum <= 0) {
      topW[0] = 1;
      top[0] = prims[bestPrim]?.bone ?? 0;
      sum = 1;
    }
    for (let k = 0; k < 4; k++) {
      skinIndex[v * 4 + k] = top[k];
      skinWeight[v * 4 + k] = topW[k] / sum;
    }
    // part weights
    let ps = 0;
    for (let i = 0; i < np; i++) ps += sample.partW[i];
    if (ps > 0) for (let i = 0; i < np; i++) sample.partW[i] /= ps;
    const bp = prims[bestPrim];
    bp.dist(x, y, z);
    sample.x = x; sample.y = y; sample.z = z;
    sample.nx = normal[v * 3]; sample.ny = normal[v * 3 + 1]; sample.nz = normal[v * 3 + 2];
    sample.partIdx = bp.part;
    sample.part = parts[bp.part];
    sample.boneIdx = bp.bone;
    sample.bone = rig.names[bp.bone];
    sample.t = bp.t;
    sample.resetOutputs();
    baker.bake(sample, outs, v);
  }
  // eyes: rigid, glossy
  for (let e = 0; e < ne; e++) {
    const v = nv + e;
    skinIndex[v * 4] = eyeGeo.bone[e];
    skinWeight[v * 4] = 1;
    sample.x = position[v * 3]; sample.y = position[v * 3 + 1]; sample.z = position[v * 3 + 2];
    sample.nx = normal[v * 3]; sample.ny = normal[v * 3 + 1]; sample.nz = normal[v * 3 + 2];
    sample.part = 'eye';
    sample.bone = rig.names[eyeGeo.bone[e]];
    sample.partW.fill(0);
    sample.resetOutputs();
    sample.color.setHex(eyeGeo.color[e]);
    sample.color2.copy(sample.color);
    sample.gloss = 1;
    baker.bake(sample, outs, v);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  baker.attributes.forEach((a, i) => geometry.setAttribute(a.name, new THREE.BufferAttribute(outs[i], a.size)));
  const indexArr = new Uint32Array(raw.indices.length + eyeGeo.idx.length);
  indexArr.set(raw.indices, 0);
  indexArr.set(eyeGeo.idx, raw.indices.length);
  geometry.setIndex(total < 65535 ? new THREE.BufferAttribute(Uint16Array.from(indexArr), 1) : new THREE.BufferAttribute(indexArr, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, rig, field, bounds: meshed.bounds, triangles: indexArr.length / 3, ms: now() - t0 };
}

/** Baker for animals: color (vec3), color2 (vec3), pattern (vec4: s, w, gloss, fur − 1). */
export function coatBaker(coat: (s: SampleImpl) => void): VertexBaker {
  return {
    attributes: [
      { name: 'color', size: 3 },
      { name: 'color2', size: 3 },
      { name: 'pattern', size: 4 },
    ],
    bake(s, out, v) {
      if (s.part !== 'eye') coat(s);
      out[0][v * 3] = s.color.r;
      out[0][v * 3 + 1] = s.color.g;
      out[0][v * 3 + 2] = s.color.b;
      out[1][v * 3] = s.color2.r;
      out[1][v * 3 + 1] = s.color2.g;
      out[1][v * 3 + 2] = s.color2.b;
      out[2][v * 4] = s.s;
      out[2][v * 4 + 1] = s.w;
      out[2][v * 4 + 2] = s.gloss;
      out[2][v * 4 + 3] = s.fur - 1;
    },
  };
}
