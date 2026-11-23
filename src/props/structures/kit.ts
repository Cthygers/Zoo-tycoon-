// Geometry kit for built props: primitives with world-scaled UVs (metres per
// texture repeat), orientation helpers, roofs, and a per-material collector
// that merges everything into one mesh per material (so a variant stays at a
// handful of draw calls and batches cleanly in the props layer).
//
// Every geometry produced here carries exactly position(3) + normal(3) + uv(2)
// and an index, so all props sharing a material have an identical attribute
// layout (required by the BatchedMesh back-end of the props layer).

import * as THREE from 'three';
import { projectBoxUVs } from '../materials';

export type Geo = THREE.BufferGeometry;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Collector

/** Materials whose merged mesh should never cast shadows (glass, glow, water…). */
export const NO_SHADOW = new WeakSet<THREE.Material>();

// ---------------------------------------------------------------------------
// Detail mode: quality tier (round-segment multiplier) and distant-LOD builds
// (round parts at half the segments, pieces smaller than lodMin metres in
// bounding radius — handles, bolts, brackets, trims — dropped). Set around a
// builder call with withDetail().

interface KitDetail {
  /** Multiplier for round segment counts above 8 (squares / octagons are kept). */
  seg: number;
  /** Distant LOD build. */
  lod: boolean;
  /** LOD: drop pieces whose bounding radius is below this (m). */
  lodMin: number;
}

let detail: KitDetail = { seg: 1, lod: false, lodMin: 0.11 };

export function withDetail<T>(d: Partial<KitDetail>, fn: () => T): T {
  const prev = detail;
  detail = { ...prev, ...d };
  try {
    return fn();
  } finally {
    detail = prev;
  }
}

/** Segment multiplier of the current quality tier. */
export function segScale(): number {
  return detail.seg;
}

/** True while a distant LOD is being built. */
export function kitLod(): boolean {
  return detail.lod;
}

/** Round segment count for the current detail mode (≤ 8 is left alone: deliberate polygons). */
export function segs(n: number): number {
  if (n <= 8) return n;
  return Math.max(8, Math.round(n * detail.seg * (detail.lod ? 0.5 : 1)));
}

/** Collects geometries per material and merges them into one mesh each. */
export class Kit {
  private lists = new Map<THREE.Material, Geo[]>();
  private order: THREE.Material[] = [];
  private named = new Map<string, { mat: THREE.Material; geos: Geo[] }>();

  /** Add a geometry (consumed: it is transformed in place and disposed after merging). */
  add(mat: THREE.Material, geo: Geo, matrix?: THREE.Matrix4): this {
    if (detail.lod) {
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      const sc = matrix ? matrix.getMaxScaleOnAxis() : 1;
      if ((geo.boundingSphere?.radius ?? 1) * sc < detail.lodMin) {
        geo.dispose();
        return this;
      }
    }
    if (matrix) geo.applyMatrix4(matrix);
    let l = this.lists.get(mat);
    if (!l) {
      l = [];
      this.lists.set(mat, l);
      this.order.push(mat);
    }
    l.push(geo);
    return this;
  }

  /** Add to a separately named mesh (for unique props that animate a part). */
  addNamed(name: string, mat: THREE.Material, geo: Geo, matrix?: THREE.Matrix4): this {
    if (matrix) geo.applyMatrix4(matrix);
    let n = this.named.get(name);
    if (!n) {
      n = { mat, geos: [] };
      this.named.set(name, n);
    }
    n.geos.push(geo);
    return this;
  }

  /** Merge into a Group with one Mesh per material. */
  build(name: string): THREE.Group {
    const g = new THREE.Group();
    g.name = name;
    for (const mat of this.order) {
      const geos = this.lists.get(mat)!;
      const mesh = new THREE.Mesh(mergeGeos(geos), mat);
      mesh.name = `${name}:${mat.name || 'mat'}`;
      if (NO_SHADOW.has(mat)) mesh.userData.noShadow = true;
      g.add(mesh);
    }
    for (const [n, { mat, geos }] of this.named) {
      const mesh = new THREE.Mesh(mergeGeos(geos), mat);
      mesh.name = n;
      if (NO_SHADOW.has(mat)) mesh.userData.noShadow = true;
      g.add(mesh);
    }
    this.lists.clear();
    this.order = [];
    this.named.clear();
    return g;
  }
}

/** Merge geometries into one indexed position/normal/uv geometry (inputs are disposed). */
export function mergeGeos(list: Geo[]): Geo {
  let nv = 0;
  let ni = 0;
  for (const g of list) {
    const c = g.getAttribute('position').count;
    nv += c;
    ni += g.index ? g.index.count : c;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let ov = 0;
  let oi = 0;
  for (const g of list) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    let n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    if (!n) {
      g.computeVertexNormals();
      n = g.getAttribute('normal') as THREE.BufferAttribute;
    }
    const t = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const c = p.count;
    for (let i = 0; i < c; i++) {
      pos[(ov + i) * 3] = p.getX(i);
      pos[(ov + i) * 3 + 1] = p.getY(i);
      pos[(ov + i) * 3 + 2] = p.getZ(i);
      nor[(ov + i) * 3] = n.getX(i);
      nor[(ov + i) * 3 + 1] = n.getY(i);
      nor[(ov + i) * 3 + 2] = n.getZ(i);
      if (t) {
        uv[(ov + i) * 2] = t.getX(i);
        uv[(ov + i) * 2 + 1] = t.getY(i);
      }
    }
    if (g.index) {
      const a = g.index.array;
      for (let i = 0; i < a.length; i++) idx[oi + i] = a[i] + ov;
      oi += a.length;
    } else {
      for (let i = 0; i < c; i++) idx[oi + i] = ov + i;
      oi += c;
    }
    ov += c;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------------------
// Transforms

/** Matrix from position + Euler angles (radians; applied Z, then X, then Y) + optional scale. */
export function mat(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

// ---------------------------------------------------------------------------
// Primitives (centred on the origin unless stated; UVs in metres / tile)

export interface UVOpts {
  /** Metres per texture repeat. */
  tile?: number;
  /** Axis the texture's U (grain / courses) follows. */
  grain?: 'x' | 'y' | 'z';
  /** Texture offset (decorrelates repeated pieces). */
  off?: number;
}

/** Axis-aligned box. */
export function box(w: number, h: number, d: number, o: UVOpts = {}): Geo {
  const g = new THREE.BoxGeometry(w, h, d);
  const off = o.off ?? 0;
  projectBoxUVs(g, o.tile ?? 1, o.grain ?? 'x', [off * 1.7, off * 0.9, off * 1.3]);
  return g;
}

/** Rotate+translate a geometry built along +X (centred) so it spans a → b. */
export function orientAlong(g: Geo, a: THREE.Vector3, b: THREE.Vector3): Geo {
  const dir = _a.subVectors(b, a).normalize();
  // basis: x = dir, y = up projected, z = x × y
  let up = _b.copy(UP);
  if (Math.abs(dir.dot(up)) > 0.98) up = _b.set(1, 0, 0);
  const z = _c.crossVectors(dir, up).normalize();
  const y = new THREE.Vector3().crossVectors(z, dir).normalize();
  _m.makeBasis(dir, y, z);
  _m.setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  g.applyMatrix4(_m);
  return g;
}

/** Cylinder along Y centred at origin, UVs: U around (metres), V along height (metres). */
export function cyl(rTop: number, rBot: number, h: number, seg: number, o: UVOpts & { caps?: boolean; hseg?: number; fixed?: boolean } = {}): Geo {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, o.fixed ? seg : segs(seg), o.hseg ?? 1, o.caps === false);
  const tile = o.tile ?? 1;
  const off = o.off ?? 0;
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const circ = Math.PI * (rTop + rBot);
  const alongU = (o.grain ?? 'y') === 'y';
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(nor.getY(i)) > 0.999) {
      uv.setXY(i, pos.getX(i) / tile + off, pos.getZ(i) / tile + off * 0.7);
    } else {
      const around = uv.getX(i) * circ;
      const along = pos.getY(i) + h / 2;
      if (alongU) uv.setXY(i, along / tile + off, around / tile + off * 0.3);
      else uv.setXY(i, around / tile + off, along / tile + off * 0.3);
    }
  }
  return g;
}

/** Cylinder spanning a → b (round section). Grain along the axis. */
export function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 6, o: UVOpts & { r2?: number; caps?: boolean } = {}): Geo {
  const len = a.distanceTo(b);
  const g = cyl(o.r2 ?? r, r, len, seg, { tile: o.tile, off: o.off, caps: o.caps });
  // cylinder is along Y: rotate so +Y → +X, then orient
  g.rotateZ(-Math.PI / 2);
  return orientAlong(g, a, b);
}

/**
 * Lathe around Y from (radius, y) profile points. U = around (metres at the
 * mean radius), V = arc length along the profile (metres).
 */
export function lathe(pts: [number, number][], seg: number, o: UVOpts & { phi?: number; fixed?: boolean } = {}): Geo {
  const v2 = pts.map(([r, y]) => new THREE.Vector2(r, y));
  // callers that address vertices by segment index pass fixed: true
  if (!o.fixed) seg = segs(seg);
  const g = new THREE.LatheGeometry(v2, seg, o.phi ?? 0);
  const tile = o.tile ?? 1;
  const off = o.off ?? 0;
  let meanR = 0;
  for (const [r] of pts) meanR += r;
  meanR /= pts.length;
  const circ = Math.PI * 2 * Math.max(meanR, 0.01);
  const arc: number[] = [0];
  for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // LatheGeometry vertex order: for each segment i (0..seg), for each point j
  const n = pts.length;
  for (let i = 0; i <= seg; i++)
    for (let j = 0; j < n; j++) {
      const k = i * n + j;
      uv.setXY(k, (i / seg) * (circ / tile) + off, arc[j] / tile + off * 0.6);
    }
  // LatheGeometry seams: recompute smooth normals is done by three already
  return g;
}

/** Flat rectangle in the XY plane facing +Z with UVs mapped to a rect (u0,v0)-(u1,v1). */
export function quad(w: number, h: number, u0 = 0, v0 = 0, u1 = 1, v1 = 1): Geo {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  return g;
}

/**
 * Extrude a 2D shape (XY plane, metres) by `depth` along +Z (from z = 0 to
 * depth). Front/back UVs = shape coordinates / tile.
 */
export function extrude(shape: THREE.Shape, depth: number, o: UVOpts & { bevel?: number; curveSegments?: number } = {}): Geo {
  const bev = o.bevel ?? 0;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(depth - bev * 2, 0.0001),
    bevelEnabled: bev > 0,
    bevelThickness: bev,
    bevelSize: bev,
    bevelSegments: 1,
    curveSegments: o.curveSegments ?? 6,
  });
  if (bev > 0) g.translate(0, 0, bev);
  const tile = o.tile ?? 1;
  const off = o.off ?? 0;
  // replace UVs with box projection in metres (side walls included)
  projectBoxUVs(g, tile, o.grain ?? 'x', [off, off * 0.6, off * 0.3]);
  return g;
}

/** Rectangle shape helper (x0,y0)-(x1,y1). */
export function rectShape(x0: number, y0: number, x1: number, y1: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(x0, y0);
  s.lineTo(x1, y0);
  s.lineTo(x1, y1);
  s.lineTo(x0, y1);
  s.closePath();
  return s;
}

/** Rectangular hole path. */
export function rectHole(x0: number, y0: number, x1: number, y1: number): THREE.Path {
  const p = new THREE.Path();
  p.moveTo(x0, y0);
  p.lineTo(x0, y1);
  p.lineTo(x1, y1);
  p.lineTo(x1, y0);
  p.closePath();
  return p;
}

/**
 * Wall slab in the XY plane spanning x0..x1, y0..y1, thickness t (from z = -t/2
 * to +t/2), with rectangular openings [x0, y0, x1, y1].
 */
export function wall(x0: number, x1: number, y0: number, y1: number, t: number, holes: [number, number, number, number][] = [], o: UVOpts = {}): Geo {
  const s = rectShape(x0, y0, x1, y1);
  for (const h of holes) s.holes.push(rectHole(h[0], h[1], h[2], h[3]));
  const g = extrude(s, t, o);
  g.translate(0, 0, -t / 2);
  return g;
}

// ---------------------------------------------------------------------------
// Roofs

/** One roof plane: quad (or triangle when tl == tr) given eave edge l→r and top edge. */
export interface RoofPlane {
  el: THREE.Vector3;
  er: THREE.Vector3;
  tr: THREE.Vector3;
  tl: THREE.Vector3;
}

/**
 * Build a roof from planes with real thickness: top surface (UV u along the
 * eave, v up the slope, metres / tile), underside (soffit) shifted straight
 * down by `thick / cos(pitch)` so hips meet, and eave fascia strips.
 * `edges` = which plane edges get closing strips: 'eave' always; 'rake' for
 * gable ends / mono-pitch sides; 'top' for mono-pitch high edge.
 */
export function roof(
  planes: RoofPlane[],
  thick: number,
  o: { tile?: number; rake?: boolean; top?: boolean; soffit?: boolean; off?: number } = {},
): { top: Geo; under: Geo; edge: Geo } {
  const tile = o.tile ?? 1;
  const off = o.off ?? 0;
  const topP: number[] = [];
  const topUV: number[] = [];
  const topI: number[] = [];
  const unP: number[] = [];
  const unUV: number[] = [];
  const unI: number[] = [];
  const edP: number[] = [];
  const edUV: number[] = [];
  const edI: number[] = [];
  const eaveDir = new THREE.Vector3();
  const upDir = new THREE.Vector3();
  const n = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const quadPush = (P: number[], UV: number[], I: number[], v: THREE.Vector3[], uvs: [number, number][]) => {
    const base = P.length / 3;
    for (let i = 0; i < 4; i++) {
      P.push(v[i].x, v[i].y, v[i].z);
      UV.push(uvs[i][0], uvs[i][1]);
    }
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (const pl of planes) {
    eaveDir.subVectors(pl.er, pl.el);
    const eaveLen = eaveDir.length();
    eaveDir.normalize();
    n.subVectors(pl.tl, pl.el).cross(eaveDir).negate();
    if (n.lengthSq() < 1e-9) n.subVectors(pl.tr, pl.el).cross(eaveDir).negate();
    n.normalize();
    upDir.crossVectors(n, eaveDir).normalize();
    const cosP = Math.max(n.y, 0.2);
    const drop = thick / cosP;
    const uvOf = (p: THREE.Vector3): [number, number] => {
      tmp.subVectors(p, pl.el);
      return [tmp.dot(eaveDir) / tile + off, tmp.dot(upDir) / tile + off * 0.37];
    };
    const v = [pl.el, pl.er, pl.tr, pl.tl];
    const uvs = v.map(uvOf);
    quadPush(topP, topUV, topI, v, uvs);
    const d = v.map((p) => p.clone().setY(p.y - drop));
    if (o.soffit !== false) quadPush(unP, unUV, unI, [d[1], d[0], d[3], d[2]], [uvs[1], uvs[0], uvs[3], uvs[2]]);
    // eave strip (faces outward/down-slope)
    quadPush(edP, edUV, edI, [d[0], d[1], pl.er, pl.el], [
      [0, 0],
      [eaveLen / tile, 0],
      [eaveLen / tile, thick / tile],
      [0, thick / tile],
    ]);
    if (o.rake) {
      const lenL = pl.el.distanceTo(pl.tl);
      const lenR = pl.er.distanceTo(pl.tr);
      quadPush(edP, edUV, edI, [d[3], d[0], pl.el, pl.tl], [
        [0, 0],
        [lenL / tile, 0],
        [lenL / tile, thick / tile],
        [0, thick / tile],
      ]);
      quadPush(edP, edUV, edI, [d[1], d[2], pl.tr, pl.er], [
        [0, 0],
        [lenR / tile, 0],
        [lenR / tile, thick / tile],
        [0, thick / tile],
      ]);
    }
    if (o.top) {
      const len = pl.tl.distanceTo(pl.tr);
      quadPush(edP, edUV, edI, [d[2], d[3], pl.tl, pl.tr], [
        [0, 0],
        [len / tile, 0],
        [len / tile, thick / tile],
        [0, thick / tile],
      ]);
    }
  }
  const mk = (P: number[], UV: number[], I: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    g.setIndex(I);
    // flat normals per quad: duplicate verts already per quad so compute is flat
    g.computeVertexNormals();
    return g;
  };
  return { top: mk(topP, topUV, topI), under: mk(unP, unUV, unI), edge: mk(edP, edUV, edI) };
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Hip roof over a w × d rectangle (eaves at y = eaveY, overhang included in w/d),
 * apex/ridge at eaveY + rise. Square plans give a pyramid.
 */
export function hipPlanes(w: number, d: number, eaveY: number, rise: number): RoofPlane[] {
  const hw = w / 2;
  const hd = d / 2;
  const top = eaveY + rise;
  if (w >= d) {
    const r = hw - hd; // half ridge length
    return [
      { el: V(-hw, eaveY, hd), er: V(hw, eaveY, hd), tr: V(r, top, 0), tl: V(-r, top, 0) }, // front
      { el: V(hw, eaveY, -hd), er: V(-hw, eaveY, -hd), tr: V(-r, top, 0), tl: V(r, top, 0) }, // back
      { el: V(hw, eaveY, hd), er: V(hw, eaveY, -hd), tr: V(r, top, 0), tl: V(r, top, 0) }, // right
      { el: V(-hw, eaveY, -hd), er: V(-hw, eaveY, hd), tr: V(-r, top, 0), tl: V(-r, top, 0) }, // left
    ];
  }
  const r = hd - hw;
  return [
    { el: V(-hw, eaveY, hd), er: V(hw, eaveY, hd), tr: V(0, top, r), tl: V(0, top, r) },
    { el: V(hw, eaveY, -hd), er: V(-hw, eaveY, -hd), tr: V(0, top, -r), tl: V(0, top, -r) },
    { el: V(hw, eaveY, hd), er: V(hw, eaveY, -hd), tr: V(0, top, -r), tl: V(0, top, r) },
    { el: V(-hw, eaveY, -hd), er: V(-hw, eaveY, hd), tr: V(0, top, r), tl: V(0, top, -r) },
  ];
}

/** Gable roof, ridge along X: two planes sloping to ±Z. */
export function gablePlanes(w: number, d: number, eaveY: number, rise: number): RoofPlane[] {
  const hw = w / 2;
  const hd = d / 2;
  const top = eaveY + rise;
  return [
    { el: V(-hw, eaveY, hd), er: V(hw, eaveY, hd), tr: V(hw, top, 0), tl: V(-hw, top, 0) },
    { el: V(hw, eaveY, -hd), er: V(-hw, eaveY, -hd), tr: V(-hw, top, 0), tl: V(hw, top, 0) },
  ];
}

/** Mono-pitch roof: eave (low) along -Z… configurable: low edge at z = lowZ. */
export function skillionPlane(w: number, zLow: number, yLow: number, zHigh: number, yHigh: number): RoofPlane[] {
  const hw = w / 2;
  // eave edge along low side; orientation so the normal points up
  if (zLow < zHigh)
    return [{ el: V(hw, yLow, zLow), er: V(-hw, yLow, zLow), tr: V(-hw, yHigh, zHigh), tl: V(hw, yHigh, zHigh) }];
  return [{ el: V(-hw, yLow, zLow), er: V(hw, yLow, zLow), tr: V(hw, yHigh, zHigh), tl: V(-hw, yHigh, zHigh) }];
}

/** Gable-end triangle wall (in XY plane at z = 0) spanning width w from y0 to y0 + rise, thickness t. */
export function gableEnd(w: number, y0: number, rise: number, t: number, o: UVOpts = {}): Geo {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, y0);
  s.lineTo(w / 2, y0);
  s.lineTo(0, y0 + rise);
  s.closePath();
  const g = extrude(s, t, o);
  g.translate(0, 0, -t / 2);
  return g;
}

// ---------------------------------------------------------------------------
// Misc helpers

/** Displace vertices of a geometry along their normals with a function. */
export function displace(g: Geo, fn: (x: number, y: number, z: number) => number): Geo {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const d = fn(x, y, z);
    p.setXYZ(i, x + n.getX(i) * d, y + n.getY(i) * d, z + n.getZ(i) * d);
  }
  g.computeVertexNormals();
  return g;
}

export { V };
