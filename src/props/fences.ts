// Fence rendering: every fenced grid edge of the World drawn with one
// InstancedMesh per fence part (posts / piers at grid corners, panels between
// them). Panels are sheared (not rotated) to follow the ground between their
// two corners, so vertical members stay vertical on slopes. Posts and walls
// always reach the real ground (lake bed included) through a per-instance
// "ground extension" that stretches only the vertices at local y = 0.
// With the batched back-end, the opaque casters of every fence material cast
// from one shadow-only batch per shadow side (position-only copies on
// SHADOW_ONLY_LAYER), like the props: one shadow draw instead of one per material.
// Three's depth pass never ran the ground extension, so the shadows are unchanged.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MAP_H, MAP_W, SHADOW_ONLY_LAYER, TILE, WATER_LEVEL } from '../core/constants';
import type { EventBus } from '../core/events';
import { hashFloat } from '../core/rng';
import type { FenceDef } from '../core/types';
import type { World } from '../core/world';
import type { QualitySettings } from '../core/contracts';
import { FENCES_BY_ID } from '../data/fences';
import {
  chainLinkMaterial,
  concreteMaterial,
  drystoneMaterial,
  galvanisedMaterial,
  glassMaterial,
  paintedMetalMaterial,
  projectBoxUVs,
  stoneMaterial,
  surfaceTextures,
  weatheredWoodMaterial,
} from './materials';
import { MultiBatch, type CullView, type InstParams, type SlotRef } from './lod/batched';
import { cloneWithHooks } from './wind';

const HALF = TILE / 2;
/** Posts / walls sink this far into the ground so slopes never show a gap. */
const SINK = 0.07;
/** Lowest fence base: just above the water surface. */
const WATER_BASE = WATER_LEVEL + 0.08;
/** Corners lower than this count as under water for levelling fence runs. */
const WET_LEVEL = WATER_LEVEL + 0.02;
const AXES: [number, number][] = [
  [1, 0],
  [0, 1],
];

// ---------------------------------------------------------------------------
// Geometry helpers (all return indexed geometry with position/normal/uv)

function finalize(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') g.deleteAttribute(name);
  if (!g.index) {
    const n = g.getAttribute('position').count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts.map(finalize), false);
  for (const p of parts) p.dispose();
  if (!g) throw new Error('fence geometry merge failed');
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** Axis-aligned box from min/max corners, world-scaled UVs. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tile: number, grain: 'x' | 'y' | 'z' = 'x', uvOff: [number, number, number] = [0, 0, 0]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  projectBoxUVs(g, tile, grain, uvOff);
  return g;
}

/** Vertical cylinder (axis Y) from y0 to y1, UVs in metres / tile. */
function cylY(r: number, y0: number, y1: number, seg: number, x: number, z: number, tile: number, open = false): THREE.BufferGeometry {
  const h = y1 - y0;
  const g = new THREE.CylinderGeometry(r, r, h, seg, 1, open);
  scaleUV(g, (2 * Math.PI * r) / tile, h / tile);
  g.translate(x, (y0 + y1) / 2, z);
  return g;
}

/** Cylinder along X from x0 to x1 at (y, z). */
function cylX(r: number, x0: number, x1: number, seg: number, y: number, z: number, tile: number): THREE.BufferGeometry {
  const len = x1 - x0;
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
  scaleUV(g, (2 * Math.PI * r) / tile, len / tile);
  g.rotateZ(Math.PI / 2);
  g.translate((x0 + x1) / 2, y, z);
  return g;
}

function scaleUV(g: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}

/** Flat-shaded square frustum (4 sides + top), base at y0. */
function frustum(bw: number, bd: number, tw: number, td: number, y0: number, y1: number, tile: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const b = [
    [-bw, -bd],
    [bw, -bd],
    [bw, bd],
    [-bw, bd],
  ];
  const t = [
    [-tw, -td],
    [tw, -td],
    [tw, td],
    [-tw, td],
  ];
  const quad = (a: number[], c: number[], d: number[], e: number[]) => pos.push(...a, ...c, ...d, ...a, ...d, ...e);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    // outward winding (counter-clockwise seen from outside)
    quad([b[j][0], y0, b[j][1]], [b[i][0], y0, b[i][1]], [t[i][0], y1, t[i][1]], [t[j][0], y1, t[j][1]]);
  }
  quad([t[0][0], y1, t[0][1]], [t[3][0], y1, t[3][1]], [t[2][0], y1, t[2][1]], [t[1][0], y1, t[1][1]]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  projectBoxUVs(g, tile, 'x');
  return g;
}

/** Jitter vertices by a hash of their (rounded) position so shared corners move together. */
/** Uniform vertex colour (per-stone tone for vertex-coloured stone). */
function tint(g: THREE.BufferGeometry, r: number, gr: number, b: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set([r, gr, b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function roughen(g: THREE.BufferGeometry, amount: number, seed: number): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const kx = Math.round(x * 1000);
    const ky = Math.round(y * 1000);
    const kz = Math.round(z * 1000);
    p.setXYZ(
      i,
      x + (hashFloat(kx, ky, kz + seed) - 0.5) * amount,
      y + (hashFloat(ky, kz, kx + seed + 1) - 0.5) * amount,
      z + (hashFloat(kz, kx, ky + seed + 2) - 0.5) * amount,
    );
  }
  g.computeVertexNormals();
}

// ---------------------------------------------------------------------------
// Fence styles

export interface FencePart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  castShadow: boolean;
  /**
   * For parts that reach the ground: which UV axis runs up the part and the
   * metres per UV unit, so the stretched ground extension keeps texel density.
   */
  groundUv?: { axis: 'u' | 'v'; tile: number };
}

export type FenceDetail = 0 | 1 | 2;

export interface FenceStyle {
  def: FenceDef;
  /** Parts drawn at grid corners. */
  posts: FencePart[];
  /** Parts drawn once per 2 m edge, built along +X from -TILE/2..TILE/2. */
  panel: FencePart[];
  /** 'all' = a post at every corner; 'ends' = only where the run ends / turns / joins. */
  postMode: 'all' | 'ends';
}

function timberStyle(def: FenceDef, detail: FenceDetail): FenceStyle {
  const h = def.height;
  const wood = weatheredWoodMaterial();
  const tile = surfaceTextures('weatheredWood').tile;
  const s = 0.06;
  const post = merge([
    box(-s, 0, -s, s, h + 0.02, s, tile, 'y'),
    (() => {
      const c = new THREE.ConeGeometry(s * Math.SQRT2, 0.045, 4, 1, false, Math.PI / 4);
      c.translate(0, h + 0.02 + 0.0225, 0);
      projectBoxUVs(c, tile, 'y');
      return c;
    })(),
  ]);
  const rails: THREE.BufferGeometry[] = [];
  const ys = [h * 0.24, h * 0.55, h * 0.86];
  ys.forEach((y, i) => {
    const r = box(-HALF, y - 0.05, -0.022, HALF, y + 0.05, 0.022, tile, 'x', [0, i * 0.37, i * 0.11]);
    roughen(r, 0.002, 11 + i);
    rails.push(r);
  });
  return {
    def,
    postMode: 'all',
    posts: [{ geometry: post, material: wood, castShadow: true, groundUv: { axis: 'u', tile } }],
    panel: [{ geometry: merge(rails), material: wood, castShadow: true }],
  };
}

function chainlinkStyle(def: FenceDef, detail: FenceDetail): FenceStyle {
  const h = def.height;
  const galv = galvanisedMaterial();
  const tile = surfaceTextures('galvanised').tile;
  const r = 0.03;
  const seg = [6, 8, 12][detail];
  const cap = new THREE.SphereGeometry(r * 1.25, seg, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.55, 1);
  cap.translate(0, h, 0);
  const post = merge([cylY(r, 0, h, seg, 0, 0, tile, true), cylY(r * 1.25, h - 0.05, h, seg, 0, 0, tile, true), cap]);
  const railParts = [cylX(0.021, -HALF, HALF, Math.max(5, seg - 2), h - 0.05, 0, tile)];
  if (detail > 0) railParts.push(cylX(0.0025, -HALF, HALF, 3, 0.07, 0.034, tile));
  const rail = merge(railParts);
  // the mesh: a single quad (two-sided material) hung on the post faces
  const mt = surfaceTextures('chainlink').tile;
  const y0 = 0.05;
  const y1 = h - 0.07;
  const mesh = new THREE.PlaneGeometry(TILE, y1 - y0);
  mesh.translate(0, (y0 + y1) / 2, r + 0.004);
  {
    const uv = mesh.getAttribute('uv') as THREE.BufferAttribute;
    const p = mesh.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (p.getX(i) + HALF) / mt, p.getY(i) / mt);
  }
  return {
    def,
    postMode: 'all',
    posts: [{ geometry: post, material: galv, castShadow: true, groundUv: { axis: 'v', tile } }],
    panel: [
      { geometry: rail, material: galv, castShadow: true },
      { geometry: finalize(mesh), material: chainLinkMaterial(), castShadow: false },
    ],
  };
}

let coping: THREE.MeshStandardMaterial | null = null;
/** Weathered wall-top stone: the shared stone surface, a little darker and browner. */
function copingMaterial(): THREE.MeshStandardMaterial {
  if (!coping) {
    coping = stoneMaterial().clone();
    coping.vertexColors = true;
    coping.color.setRGB(0.86, 0.86, 0.85);
    coping.name = 'props/coping';
  }
  return coping;
}

function stoneStyle(def: FenceDef, detail: FenceDetail): FenceStyle {
  const h = def.height;
  const wallMat = drystoneMaterial();
  const capMat = copingMaterial();
  const wt = surfaceTextures('drystone').tile;
  const st = surfaceTextures('stone').tile;
  const copeH = 0.24;
  const yb = h - copeH + 0.03; // body top (coping sits slightly into it)
  const hwB = 0.3;
  const hwT = 0.21;

  // --- wall body: two battered faces with gentle periodic bulges + top
  const nx = [4, 8, 12][detail];
  const ny = [2, 4, 6][detail];
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const bump = (x: number, y: number) => {
    const p = ((x + HALF) / TILE) * Math.PI * 2;
    return 0.011 * Math.sin(p * 3 + 1.3) * Math.cos(y * 6.3 + 0.4) + 0.006 * Math.sin(p * 7 + y * 11.0) + 0.004 * Math.sin(p * 2 - y * 3.1);
  };
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let j = 0; j <= ny; j++) {
      const y = (yb * j) / ny;
      const hw = hwB + (hwT - hwB) * (y / yb);
      for (let i = 0; i <= nx; i++) {
        const x = -HALF + (TILE * i) / nx;
        const z = side * (hw + (y > 0 ? bump(x * side, y + (side < 0 ? 1.7 : 0)) : 0));
        pos.push(x, y, z);
        uvs.push((x + HALF) / wt + (side < 0 ? 0.37 : 0), y / wt + (side < 0 ? 0.21 : 0));
      }
    }
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const a = base + j * (nx + 1) + i;
        const b = a + 1;
        const c = a + nx + 2;
        const d = a + nx + 1;
        if (side > 0) idx.push(a, b, c, a, c, d);
        else idx.push(a, c, b, a, d, c);
      }
  }
  {
    const base = pos.length / 3;
    const zt = hwT;
    pos.push(-HALF, yb, zt, HALF, yb, zt, HALF, yb, -zt, -HALF, yb, -zt);
    uvs.push(0, 0.3, TILE / wt, 0.3, TILE / wt, 0.3 + (2 * zt) / wt, 0, 0.3 + (2 * zt) / wt);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  body.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  body.setIndex(idx);
  body.computeVertexNormals();
  body.computeBoundingSphere();

  // --- coping: a row of rough slabs set on edge ("cock and hen")
  const slabs: THREE.BufferGeometry[] = [];
  let x = -HALF;
  let k = 0;
  while (x < HALF - 0.04) {
    const r1 = hashFloat(k, 1, 77);
    const r2 = hashFloat(k, 2, 77);
    const r3 = hashFloat(k, 3, 77);
    const tall = r3 > 0.62;
    let w = 0.06 + r1 * r1 * 0.11;
    if (x + w > HALF - 0.03) w = HALF - x;
    const sh = (tall ? 0.24 : 0.15) + r2 * 0.07;
    const d = 2 * hwT + 0.0 + r3 * 0.08;
    const g = detail === 2 ? new THREE.BoxGeometry(w * 0.92, sh, d, 1, 2, 2) : new THREE.BoxGeometry(w * 0.92, sh, d);
    roughen(g, 0.028, 100 + k);
    g.rotateZ((r2 - 0.5) * 0.22 - 0.1);
    g.rotateY((r3 - 0.5) * 0.12);
    g.translate(x + w / 2, yb - 0.035 + sh / 2, (r1 - 0.5) * 0.03);
    projectBoxUVs(g, st, 'x', [k * 0.31, 0, k * 0.17]);
    const tone = 0.62 + hashFloat(k, 4, 77) * 0.4;
    const warm = hashFloat(k, 5, 77) * 0.04;
    slabs.push(tint(g, tone * (1 + warm), tone, tone * (1 - warm)));
    x += w;
    k++;
  }

  // --- pier (ends, corners, junctions): battered block + flat capstone
  const pierBody = frustum(0.33, 0.33, 0.25, 0.25, 0, yb + 0.02, wt);
  const capstone = new THREE.BoxGeometry(0.62, 0.11, 0.62, detail + 1, 1, detail + 1);
  roughen(capstone, 0.02, 31);
  capstone.translate(0, yb + 0.07, 0);
  projectBoxUVs(capstone, st, 'x');
  tint(capstone, 0.8, 0.78, 0.74);
  const capTop = new THREE.BoxGeometry(0.26, 0.14, 0.44);
  roughen(capTop, 0.02, 32);
  capTop.translate(0, yb + 0.18, 0);
  projectBoxUVs(capTop, st, 'x', [0.4, 0, 0.2]);
  tint(capTop, 0.7, 0.69, 0.66);
  return {
    def,
    postMode: 'ends',
    posts: [
      { geometry: finalize(pierBody), material: wallMat, castShadow: true, groundUv: { axis: 'v', tile: wt } },
      { geometry: merge([capstone, capTop]), material: capMat, castShadow: true },
    ],
    panel: [
      { geometry: finalize(body), material: wallMat, castShadow: true, groundUv: { axis: 'v', tile: wt } },
      { geometry: merge(slabs), material: capMat, castShadow: true },
    ],
  };
}

function glassStyle(def: FenceDef, detail: FenceDetail): FenceStyle {
  const h = def.height;
  const conc = concreteMaterial();
  const ct = surfaceTextures('concrete').tile;
  const steel = paintedMetalMaterial(0x34383b);
  const pt = surfaceTextures('paint').tile;
  const curbH = 0.28;
  const m = 0.045; // half mullion
  const block = box(-0.17, 0, -0.17, 0.17, curbH + 0.015, 0.17, ct);
  const mullion = merge([box(-m, curbH, -m, m, h + 0.01, m, pt, 'y'), box(-m - 0.01, h + 0.01, -m - 0.01, m + 0.01, h + 0.03, m + 0.01, pt)]);
  const curb = box(-HALF, 0, -0.15, HALF, curbH, 0.15, ct, 'x', [0.3, 0, 0]);
  const frame = merge([box(-HALF, curbH, -0.045, HALF, curbH + 0.06, 0.045, pt), box(-HALF, h - 0.06, -0.045, HALF, h, 0.045, pt)]);
  // glass pane: two faces (front +Z, back -Z), u = 0..1 across the pane
  const g0 = curbH + 0.045;
  const g1 = h - 0.045;
  const gw = HALF - m + 0.015;
  const front = new THREE.PlaneGeometry(gw * 2, g1 - g0);
  front.translate(0, (g0 + g1) / 2, 0.012);
  const back = new THREE.PlaneGeometry(gw * 2, g1 - g0);
  back.rotateY(Math.PI);
  back.translate(0, (g0 + g1) / 2, -0.012);
  const pane = merge([front, back]);
  return {
    def,
    postMode: 'all',
    posts: [
      { geometry: block, material: conc, castShadow: true, groundUv: { axis: 'v', tile: ct } },
      { geometry: mullion, material: steel, castShadow: true },
    ],
    panel: [
      { geometry: curb, material: conc, castShadow: true, groundUv: { axis: 'v', tile: ct } },
      { geometry: frame, material: steel, castShadow: true },
      { geometry: pane, material: glassMaterial({ edgeTint: true }), castShadow: false },
    ],
  };
}

function steelStyle(def: FenceDef, detail: FenceDetail): FenceStyle {
  const h = def.height;
  const conc = concreteMaterial();
  const ct = surfaceTextures('concrete').tile;
  const steel = paintedMetalMaterial(0x272d2a);
  const pt = surfaceTextures('paint').tile;
  const plH = 0.34;
  const block = box(-0.21, 0, -0.21, 0.21, plH + 0.02, 0.21, ct);
  const c = 0.075;
  const column = merge([
    box(-c, plH, -c, c, h + 0.04, c, pt, 'y'),
    box(-c - 0.02, h + 0.04, -c - 0.02, c + 0.02, h + 0.06, c + 0.02, pt),
    box(-c - 0.035, plH + 0.02, -c - 0.035, c + 0.035, plH + 0.035, c + 0.035, pt),
  ]);
  const plinth = box(-HALF, 0, -0.18, HALF, plH, 0.18, ct, 'x', [0.7, 0, 0]);
  const parts: THREE.BufferGeometry[] = [];
  const n = 17;
  const span = 1.76;
  for (let i = 0; i < n; i++) {
    const x = -span / 2 + (span * i) / (n - 1);
    parts.push(cylY(0.019, plH - 0.02, h - 0.08, [4, 6, 8][detail], x, 0, pt, true));
  }
  parts.push(box(-HALF, h - 0.1, -0.04, HALF, h, 0.04, pt));
  parts.push(box(-HALF, h * 0.52, -0.026, HALF, h * 0.52 + 0.075, 0.026, pt));
  parts.push(box(-HALF, plH, -0.03, HALF, plH + 0.05, 0.03, pt));
  return {
    def,
    postMode: 'all',
    posts: [
      { geometry: block, material: conc, castShadow: true, groundUv: { axis: 'v', tile: ct } },
      { geometry: column, material: steel, castShadow: true },
    ],
    panel: [
      { geometry: plinth, material: conc, castShadow: true, groundUv: { axis: 'v', tile: ct } },
      { geometry: merge(parts), material: steel, castShadow: true },
    ],
  };
}

const STYLE_BUILDERS: Record<string, (def: FenceDef, detail: FenceDetail) => FenceStyle> = {
  wood: timberStyle,
  chainlink: chainlinkStyle,
  stone: stoneStyle,
  glass: glassStyle,
  steel: steelStyle,
};

const styleCache = new Map<string, FenceStyle>();

/** Style (geometry + materials) for a fence id, built once per detail level. Unknown ids get a timber fence of their height. */
export function fenceStyle(fenceId: number, detail: FenceDetail = 1): FenceStyle | null {
  const key = `${fenceId}:${detail}`;
  let s = styleCache.get(key);
  if (s) return s;
  const def = FENCES_BY_ID[fenceId];
  if (!def) return null;
  s = (STYLE_BUILDERS[def.key] ?? timberStyle)(def, detail);
  styleCache.set(key, s);
  return s;
}

/** Geometry detail per quality tier (0 = low, 1 = medium, 2 = high). */
export function fenceDetail(q: QualitySettings): FenceDetail {
  return q.level === 'low' ? 0 : q.level === 'high' ? 2 : 1;
}

/** Standalone 2 m segment (two posts + panel) along +X centred at the origin, with cloned materials. */
export function createFenceSegment(fenceId: number, detail: FenceDetail = 2): THREE.Object3D {
  const g = new THREE.Group();
  g.name = `fence-segment-${fenceId}`;
  const s = fenceStyle(fenceId, detail);
  if (!s) return g;
  const add = (p: FencePart, x: number) => {
    const m = new THREE.Mesh(p.geometry, cloneWithHooks(p.material));
    m.position.x = x;
    m.castShadow = p.castShadow;
    m.receiveShadow = true;
    m.userData.sharedGeometry = true;
    g.add(m);
  };
  for (const p of s.panel) add(p, 0);
  for (const x of [-HALF, HALF]) for (const p of s.posts) add(p, x);
  return g;
}

// ---------------------------------------------------------------------------
// Instanced batches with a per-instance ground extension

/** Extension (m) of a vertex at local y = 0, interpolated along the 2 m segment. */
const GROUND_EXT = /* glsl */ `
float fenceGroundExt() {
#if defined( USE_BATCHING ) && defined( USE_BATCHING_COLOR )
  // batched back-end: (extA, extB) ride in the per-instance colour texture
  vec4 fgC = getBatchingColor( getIndirectIndex( gl_DrawID ) );
  return position.y < 0.002 ? mix( fgC.x, fgC.y, clamp( position.x * ${(1 / TILE).toFixed(6)} + 0.5, 0.0, 1.0 ) ) : 0.0;
#elif defined( USE_INSTANCING )
  return position.y < 0.002 ? mix( aGround.x, aGround.y, clamp( position.x * ${(1 / TILE).toFixed(6)} + 0.5, 0.0, 1.0 ) ) : 0.0;
#else
  return 0.0;
#endif
}
`;

/** color_vertex without the per-instance colour multiply (fences use that slot for the ground extension). */
const FENCE_COLOR_VERTEX = THREE.ShaderChunk.color_vertex.replace('vColor *= getBatchingColor( getIndirectIndex( gl_DrawID ) );', '');

function groundPatched(src: THREE.Material, uv: FencePart['groundUv']): THREE.Material {
  const m = src.clone();
  const srcHook = src.onBeforeCompile;
  const axis = uv ? (uv.axis === 'u' ? 'x' : 'y') : '';
  const scale = uv ? (1 / uv.tile).toFixed(6) : '0.0';
  m.onBeforeCompile = (shader, renderer) => {
    let vs = shader.vertexShader
      .replace('#include <batching_pars_vertex>', `#include <batching_pars_vertex>\n#ifdef USE_INSTANCING\nattribute vec2 aGround;\n#endif\n${GROUND_EXT}`)
      .replace('#include <color_vertex>', FENCE_COLOR_VERTEX)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y -= fenceGroundExt();');
    if (axis) {
      // keep texel density on the stretched part: shift the base vertices' UVs too
      vs = vs.replace('#include <uv_vertex>', `vec2 fenceUv = uv;\nfenceUv.${axis} -= fenceGroundExt() * ${scale};\n#define uv fenceUv\n#include <uv_vertex>\n#undef uv`);
    }
    shader.vertexShader = vs;
    // keep the source material's own patch (glass shading etc.)
    srcHook.call(m, shader, renderer);
  };
  const key = src.customProgramCacheKey();
  m.customProgramCacheKey = () => `${key}|fence-ground|${axis}${scale}`;
  return m;
}

class FenceBatch {
  mesh: THREE.InstancedMesh;
  private geometry: THREE.BufferGeometry;
  private ground: THREE.InstancedBufferAttribute;
  private capacity = 0;
  count = 0;

  constructor(
    private readonly base: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly castShadow: boolean,
    private readonly parent: THREE.Object3D,
    private readonly shadows: boolean,
  ) {
    this.geometry = base;
    this.ground = new THREE.InstancedBufferAttribute(new Float32Array(2), 2);
    this.mesh = this.create(16);
  }

  private create(cap: number): THREE.InstancedMesh {
    const geo = this.base.clone();
    const ground = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    ground.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aGround', ground);
    const mesh = new THREE.InstancedMesh(geo, this.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.castShadow = this.shadows && this.castShadow;
    mesh.receiveShadow = this.shadows;
    mesh.name = 'fence-batch';
    mesh.frustumCulled = true;
    if (this.material.transparent) mesh.renderOrder = 11;
    this.capacity = cap;
    this.geometry = geo;
    this.ground = ground;
    this.parent.add(mesh);
    return mesh;
  }

  begin(needed: number): void {
    if (needed > this.capacity) {
      const old = this.mesh;
      this.parent.remove(old);
      old.dispose();
      this.geometry.dispose();
      let cap = this.capacity;
      while (cap < needed) cap *= 2;
      this.mesh = this.create(cap);
    }
    this.count = 0;
  }

  push(m: THREE.Matrix4, extA: number, extB: number): void {
    const i = this.count++;
    this.mesh.setMatrixAt(i, m);
    this.ground.setXY(i, extA, extB);
  }

  end(): void {
    const mesh = this.mesh;
    mesh.count = this.count;
    mesh.visible = this.count > 0;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.needsUpdate = true;
    this.ground.needsUpdate = true;
    mesh.boundingSphere = null;
    mesh.boundingBox = null;
    if (this.count > 0) mesh.computeBoundingSphere();
  }

  setShadows(on: boolean): void {
    this.mesh.castShadow = on && this.castShadow;
    this.mesh.receiveShadow = on;
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
  }
}

interface StyleBatches {
  style: FenceStyle;
  posts: FenceBatch[];
  panel: FenceBatch[];
}

/** Renders all fences of a World; rebuilds lazily after fence / terrain changes. */
export class FenceRenderer {
  readonly group = new THREE.Group();
  private batches = new Map<number, StyleBatches>();
  /** Batched back-end: one BatchedMesh per (patched) material, shared by every style. */
  private multi = new Map<string, MultiBatch>();
  private multiList: MultiBatch[] = [];
  /** Batched back-end: shadow-only batches by shadow side (also in multiList). */
  private shadowMulti = new Map<THREE.Side, MultiBatch>();
  /** Position-only copies of style geometries for the shadow-only batches. */
  private shadowGeos = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
  private readonly shadowInst: InstParams = { cull: Infinity, shadow: 0, lodOn: false, shadowOn: true, tint: null };
  private readonly ref: SlotRef = { id: -1, slot: { index: -1 } };
  private readonly ext = new THREE.Color();
  private readonly inst: InstParams = { cull: Infinity, shadow: 0, lodOn: true, tint: null };
  /** Shadow-caster distances from the camera focus (set by the layer per tier). */
  private shadowNear = 45;
  private shadowFar = 90;
  /** Camera distance where detailed fences swap to the detail-0 build (0 = never). */
  private lodDist = 0;
  /** Per fence id: is the detail-0 build much cheaper than the current one? */
  private farWorth = new Map<number, boolean>();
  private patched = new Map<string, THREE.Material>();
  private dirty = true;
  private unsub: (() => void)[] = [];
  private readonly m = new THREE.Matrix4();
  // scratch lists, reused between rebuilds
  private postList: number[] = [];
  private bases = new Float32Array((MAP_W + 1) * (MAP_H + 1));

  constructor(
    private readonly world: World,
    events: EventBus,
    private quality: QualitySettings,
    /** Use BatchedMesh (WEBGL_multi_draw) with per-instance culling instead of InstancedMesh. */
    private readonly batched = false,
  ) {
    this.group.name = 'fences';
    const mark = () => {
      this.dirty = true;
    };
    this.unsub.push(events.on('fenceChanged', mark), events.on('worldReset', mark), events.on('terrainChanged', mark));
  }

  /** Rebuild if anything changed since the last call. */
  update(): void {
    if (this.dirty) this.rebuild();
  }

  /** Switch quality tier: rebuilds geometry when the detail level changes. */
  setQuality(q: QualitySettings): void {
    const changed = fenceDetail(q) !== fenceDetail(this.quality);
    this.quality = q;
    if (changed) {
      for (const b of this.batches.values()) for (const x of [...b.posts, ...b.panel]) x.dispose();
      this.batches.clear();
      this.disposeMulti();
      this.farWorth.clear();
      this.dirty = true;
      return;
    }
    for (const b of this.batches.values()) for (const x of [...b.posts, ...b.panel]) x.setShadows(q.shadows);
    for (const b of this.multiList) b.setShadows(q.shadows);
  }

  /** Shadow-caster distances around the camera focus and the far-LOD distance (batched back-end). */
  setShadowRange(near: number, far: number, lodDist = this.lodDist): void {
    if (near === this.shadowNear && far === this.shadowFar && lodDist === this.lodDist) return;
    this.shadowNear = near;
    this.shadowFar = far;
    this.lodDist = lodDist;
    this.dirty = true;
  }

  /** Detail-0 build of a fence when it is worth drawing beyond lodDist (batched back-end only). */
  private farStyle(id: number): FenceStyle | null {
    if (!this.batched || this.lodDist <= 0 || this.detail === 0) return null;
    let worth = this.farWorth.get(id);
    const far = fenceStyle(id, 0);
    if (worth === undefined) {
      const near = fenceStyle(id, this.detail);
      const tris = (st: FenceStyle | null) => {
        let n = 0;
        for (const p of st ? [...st.posts, ...st.panel] : []) n += (p.geometry.index ? p.geometry.index.count : p.geometry.getAttribute('position').count) / 3;
        return n;
      };
      worth = !!far && !!near && tris(far) < tris(near) * 0.8;
      this.farWorth.set(id, worth);
    }
    return worth ? far : null;
  }

  /** Per-frame culling of the batched back-end (no-op for instanced fences). */
  cull(view: CullView, force: boolean): void {
    for (const b of this.multiList) if (force || b.dirty) b.cull(view);
  }

  private multiFor(p: FencePart): MultiBatch {
    const mat = this.material(p);
    const key = `${mat.uuid}|${Object.keys(p.geometry.attributes).sort().join(',')}`;
    let b = this.multi.get(key);
    if (!b) {
      b = new MultiBatch(mat, this.quality.shadows, this.group);
      b.mesh.name = 'fence-multibatch';
      // see-through fences (glass, chain-link mesh) don't write depth: draw them after
      // the water (renderOrder 10) so they are never painted over where they cross a pond
      if (mat.transparent) b.mesh.renderOrder = 11;
      this.multi.set(key, b);
      this.multiList.push(b);
    }
    return b;
  }

  /**
   * Shadow-only batch for a material's casters, or null when it must cast from
   * its own batch (alpha-tested or transparent: the depth pass needs its maps).
   */
  private shadowMultiFor(mat: THREE.Material): MultiBatch | null {
    if (mat.transparent || mat.alphaTest > 0 || mat.alphaHash || (mat as THREE.MeshStandardMaterial).alphaMap) return null;
    // the depth pass draws back faces of single-sided materials (three's default shadow side)
    const side = mat.shadowSide ?? (mat.side === THREE.DoubleSide ? THREE.DoubleSide : mat.side === THREE.BackSide ? THREE.FrontSide : THREE.BackSide);
    let b = this.shadowMulti.get(side);
    if (!b) {
      const casters = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
      casters.name = 'fence-shadow-casters';
      casters.shadowSide = side;
      b = new MultiBatch(casters, this.quality.shadows, this.group, true);
      b.mesh.name = 'fence-shadow-casters';
      b.mesh.layers.set(SHADOW_ONLY_LAYER);
      this.shadowMulti.set(side, b);
      this.multiList.push(b);
    }
    return b;
  }

  /** Position-only copy of a style geometry (attributes shared) for a shadow-only batch. */
  private shadowGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
    let s = this.shadowGeos.get(g);
    if (!s) {
      s = new THREE.BufferGeometry();
      s.setAttribute('position', g.getAttribute('position'));
      s.setIndex(g.index);
      if (!g.boundingSphere) g.computeBoundingSphere();
      s.boundingSphere = g.boundingSphere;
      this.shadowGeos.set(g, s);
    }
    return s;
  }

  private pushMulti(st: FenceStyle, parts: FencePart[], m: THREE.Matrix4, extA: number, extB: number, cull = Infinity, minDist = 0): void {
    const p = this.inst;
    const sp = this.shadowInst;
    this.ext.setRGB(extA, extB, 0);
    p.tint = this.ext;
    p.cull = sp.cull = cull;
    p.minDist = sp.minDist = minDist;
    p.band = sp.band = cull !== Infinity || minDist > 0;
    const see = st.postMode === 'all' && parts === st.panel;
    for (const part of parts) {
      // fences outline habitats: never distance-culled; shadows only near the focus
      // (see-through panels — bars, rails, mesh — alias in a distant shadow map anyway)
      let sh = st.def.height > 2.4 ? this.shadowFar * 0.6 : this.shadowNear;
      if (see) sh *= 0.65;
      sh = part.castShadow && this.quality.shadows ? sh : 0;
      const batch = this.multiFor(part);
      const casters = sh > 0 ? this.shadowMultiFor(batch.mesh.material as THREE.Material) : null;
      p.shadow = casters ? 0 : sh;
      batch.add(part.geometry, m, this.ref, p);
      if (casters) {
        sp.shadow = sh;
        casters.add(this.shadowGeometry(part.geometry), m, this.ref, sp);
      }
    }
  }

  private material(p: FencePart): THREE.Material {
    const key = `${p.material.uuid}|${p.groundUv?.axis ?? ''}|${p.groundUv?.tile ?? 0}`;
    let m = this.patched.get(key);
    if (!m) {
      // no near-camera fade: fences are low or see-through, and a dithered hole
      // in rails / mesh reads as noise
      m = groundPatched(p.material, p.groundUv);
      this.patched.set(key, m);
    }
    return m;
  }

  private batchesFor(fenceId: number): StyleBatches | null {
    let b = this.batches.get(fenceId);
    if (b) return b;
    const style = fenceStyle(fenceId, fenceDetail(this.quality));
    if (!style) return null;
    const mk = (p: FencePart) => new FenceBatch(p.geometry, this.material(p), p.castShadow, this.group, this.quality.shadows);
    b = { style, posts: style.posts.map(mk), panel: style.panel.map(mk) };
    this.batches.set(fenceId, b);
    return b;
  }

  private base(cx: number, cz: number): { g: number; b: number } {
    const ci = cz * (MAP_W + 1) + cx;
    return { g: this.world.cornerHeight(cx, cz), b: this.bases[ci] };
  }

  /**
   * Fence base height per fenced corner. On dry ground it is the ground. Where
   * the ground is under water the run stays level: the base is interpolated
   * between the nearest dry corners along the same straight fence run (never
   * below the water line), while posts / walls still reach the bed.
   */
  private computeBases(): void {
    const w = this.world;
    const hF = w.hFence;
    const vF = w.vFence;
    const B = this.bases;
    const wet = (cx: number, cz: number) => w.cornerHeight(cx, cz) < WET_LEVEL;
    // walk along a fence run from (cx, cz) in direction (dx, dz) to the first dry corner
    const walk = (cx: number, cz: number, dx: number, dz: number): { h: number; d: number } | null => {
      for (let k = 1; k <= 24; k++) {
        const ex = dx > 0 ? cx + k - 1 : dx < 0 ? cx - k : cx;
        const ez = dz > 0 ? cz + k - 1 : dz < 0 ? cz - k : cz;
        const fenced = dx !== 0 ? ex >= 0 && ex < MAP_W && hF[w.hIdx(ex, cz)] !== 0 : ez >= 0 && ez < MAP_H && vF[w.vIdx(cx, ez)] !== 0;
        if (!fenced) return null;
        const nx = cx + dx * k;
        const nz = cz + dz * k;
        if (!wet(nx, nz)) return { h: w.cornerHeight(nx, nz), d: k };
      }
      return null;
    };
    for (let cz = 0; cz <= MAP_H; cz++)
      for (let cx = 0; cx <= MAP_W; cx++) {
        const g = w.cornerHeight(cx, cz);
        const ci = cz * (MAP_W + 1) + cx;
        if (!wet(cx, cz)) {
          B[ci] = g;
          continue;
        }
        let est = -Infinity;
        for (const [dx, dz] of AXES) {
          const a = walk(cx, cz, -dx, -dz);
          const b = walk(cx, cz, dx, dz);
          if (a && b) est = Math.max(est, a.h + ((b.h - a.h) * a.d) / (a.d + b.d));
          else if (a) est = Math.max(est, a.h);
          else if (b) est = Math.max(est, b.h);
        }
        B[ci] = Math.max(est, WATER_BASE, g);
      }
  }

  private get detail(): FenceDetail {
    return fenceDetail(this.quality);
  }

  rebuild(): void {
    this.dirty = false;
    const w = this.world;
    const hF = w.hFence;
    const vF = w.vFence;
    this.computeBases();
    // ---- count per fence id
    const panelCount = new Map<number, number>();
    for (let i = 0; i < hF.length; i++) if (hF[i]) panelCount.set(hF[i], (panelCount.get(hF[i]) ?? 0) + 1);
    for (let i = 0; i < vF.length; i++) if (vF[i]) panelCount.set(vF[i], (panelCount.get(vF[i]) ?? 0) + 1);

    // ---- corner posts: decide which styles put a post on each corner
    const posts = this.postList;
    posts.length = 0; // pairs (cornerIndex, fenceId)
    const postCount = new Map<number, number>();
    const ids: number[] = [0, 0, 0, 0];
    for (let cz = 0; cz <= MAP_H; cz++)
      for (let cx = 0; cx <= MAP_W; cx++) {
        const west = cx > 0 ? hF[w.hIdx(cx - 1, cz)] : 0;
        const east = cx < MAP_W ? hF[w.hIdx(cx, cz)] : 0;
        const north = cz > 0 ? vF[w.vIdx(cx, cz - 1)] : 0;
        const south = cz < MAP_H ? vF[w.vIdx(cx, cz)] : 0;
        if (!west && !east && !north && !south) continue;
        ids[0] = west;
        ids[1] = east;
        ids[2] = north;
        ids[3] = south;
        // tallest 'all'-mode style present gets the post
        let bestAll = 0;
        let bestH = -1;
        for (const id of ids) {
          if (!id) continue;
          const st = fenceStyle(id, this.detail);
          if (!st) continue;
          if (st.postMode === 'all') {
            if (st.def.height > bestH) {
              bestH = st.def.height;
              bestAll = id;
            }
          }
        }
        const ci = cz * (MAP_W + 1) + cx;
        if (bestAll) {
          posts.push(ci, bestAll);
          postCount.set(bestAll, (postCount.get(bestAll) ?? 0) + 1);
        }
        // 'ends'-mode styles (walls) put a pier wherever their run is not straight-through
        for (let k = 0; k < 4; k++) {
          const id = ids[k];
          if (!id || ids.indexOf(id) !== k) continue;
          const st = fenceStyle(id, this.detail);
          if (!st || st.postMode !== 'ends') continue;
          const n = (west === id ? 1 : 0) + (east === id ? 1 : 0) + (north === id ? 1 : 0) + (south === id ? 1 : 0);
          const straight = n === 2 && ((west === id && east === id) || (north === id && south === id));
          const others = (west && west !== id ? 1 : 0) + (east && east !== id ? 1 : 0) + (north && north !== id ? 1 : 0) + (south && south !== id ? 1 : 0);
          if (straight && others === 0) continue;
          posts.push(ci, id);
          postCount.set(id, (postCount.get(id) ?? 0) + 1);
        }
      }

    // ---- prepare batches
    const used = new Set<number>([...panelCount.keys(), ...postCount.keys()]);
    const multi = this.batched;
    if (multi) {
      for (const b of this.multiList) b.clear();
    } else {
      for (const [id, b] of this.batches) {
        if (used.has(id)) continue;
        for (const x of [...b.posts, ...b.panel]) {
          x.begin(0);
          x.end();
        }
      }
      for (const id of used) {
        const b = this.batchesFor(id);
        if (!b) continue;
        for (const x of b.panel) x.begin(panelCount.get(id) ?? 0);
        for (const x of b.posts) x.begin(postCount.get(id) ?? 0);
      }
    }

    // ---- panels
    const m = this.m;
    const addPanel = (id: number, ax: number, az: number, bx: number, bz: number, dir: 'h' | 'v') => {
      const st = multi ? fenceStyle(id, this.detail) : null;
      const sb = multi ? null : this.batchesFor(id);
      if (!sb && !st) return;
      const A = this.base(ax, az);
      const B = this.base(bx, bz);
      const s = (B.b - A.b) / TILE;
      const mx = ((ax + bx) / 2) * TILE;
      const mz = ((az + bz) / 2) * TILE;
      const my = (A.b + B.b) / 2;
      if (dir === 'h') m.set(1, 0, 0, mx, s, 1, 0, my, 0, 0, 1, mz, 0, 0, 0, 1);
      else m.set(0, 0, -1, mx, s, 1, 0, my, 1, 0, 0, mz, 0, 0, 0, 1);
      const eA = A.b - A.g + SINK;
      const eB = B.b - B.g + SINK;
      if (st) {
        const far = this.farStyle(id);
        if (far) {
          this.pushMulti(st, st.panel, m, eA, eB, this.lodDist);
          this.pushMulti(far, far.panel, m, eA, eB, Infinity, this.lodDist);
        } else this.pushMulti(st, st.panel, m, eA, eB);
      } else for (const x of sb!.panel) x.push(m, eA, eB);
    };
    for (let z = 0; z <= MAP_H; z++)
      for (let x = 0; x < MAP_W; x++) {
        const id = hF[w.hIdx(x, z)];
        if (id) addPanel(id, x, z, x + 1, z, 'h');
      }
    for (let z = 0; z < MAP_H; z++)
      for (let x = 0; x <= MAP_W; x++) {
        const id = vF[w.vIdx(x, z)];
        if (id) addPanel(id, x, z, x, z + 1, 'v');
      }

    // ---- posts
    const rot = new THREE.Matrix4();
    for (let i = 0; i < posts.length; i += 2) {
      const ci = posts[i];
      const id = posts[i + 1];
      const st = multi ? fenceStyle(id, this.detail) : null;
      const sb = multi ? null : this.batchesFor(id);
      if (!sb && !st) continue;
      const cx = ci % (MAP_W + 1);
      const cz = (ci / (MAP_W + 1)) | 0;
      const P = this.base(cx, cz);
      // quarter-turn variety so repeated posts don't look stamped
      rot.makeRotationY((((cx * 7 + cz * 13) & 3) * Math.PI) / 2);
      rot.setPosition(cx * TILE, P.b, cz * TILE);
      const e = P.b - P.g + SINK;
      if (st) {
        const far = this.farStyle(id);
        if (far) {
          this.pushMulti(st, st.posts, rot, e, e, this.lodDist);
          this.pushMulti(far, far.posts, rot, e, e, Infinity, this.lodDist);
        } else this.pushMulti(st, st.posts, rot, e, e);
      } else for (const x of sb!.posts) x.push(rot, e, e);
    }

    if (!multi)
      for (const id of used) {
        const b = this.batches.get(id);
        if (!b) continue;
        for (const x of b.panel) x.end();
        for (const x of b.posts) x.end();
      }
  }

  private disposeMulti(): void {
    for (const b of this.multiList) b.dispose();
    for (const b of this.shadowMulti.values()) (b.mesh.material as THREE.Material).dispose();
    this.multi.clear();
    this.shadowMulti.clear();
    this.multiList = [];
  }

  /** Draw-call relevant meshes (for stats / debugging). */
  meshes(): { count: number }[] {
    const out: { count: number }[] = [];
    for (const b of this.batches.values()) for (const x of [...b.posts, ...b.panel]) out.push(x.mesh);
    for (const b of this.multiList) out.push({ count: b.size() });
    return out;
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    for (const b of this.batches.values()) for (const x of [...b.posts, ...b.panel]) x.dispose();
    this.batches.clear();
    this.disposeMulti();
    for (const m of this.patched.values()) m.dispose();
    this.patched.clear();
    this.group.removeFromParent();
  }
}

/** Dispose the cached style geometries (materials are shared; see materials.ts). */
export function disposeFenceStyles(): void {
  for (const s of styleCache.values()) for (const p of [...s.posts, ...s.panel]) p.geometry.dispose();
  styleCache.clear();
  coping?.dispose();
  coping = null;
}
