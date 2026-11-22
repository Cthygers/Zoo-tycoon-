// Geometry toolkit for nature props: a growable mesh buffer, parallel-
// transport tubes (trunks, branches, canes, stems), leaf cards with crown-
// bent normals, bent ribbons (fronds, grass blades) and small vector helpers.

import * as THREE from 'three';

export type V3 = THREE.Vector3;
export const v3 = (x = 0, y = 0, z = 0): V3 => new THREE.Vector3(x, y, z);

/** Growable indexed triangle buffer with position / normal / uv / colour (+ optional scalar). */
export class MeshData {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  /** Optional per-vertex scalar (e.g. rock snow / moss factor). */
  extra: number[] = [];
  idx: number[] = [];
  useExtra = false;

  get count(): number {
    return this.pos.length / 3;
  }
  get tris(): number {
    return this.idx.length / 3;
  }

  vert(px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number, r = 1, g = 1, b = 1, e = 0): number {
    this.pos.push(px, py, pz);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    this.extra.push(e);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Append another buffer. */
  append(o: MeshData): void {
    const base = this.count;
    for (const v of o.pos) this.pos.push(v);
    for (const v of o.nrm) this.nrm.push(v);
    for (const v of o.uv) this.uv.push(v);
    for (const v of o.col) this.col.push(v);
    for (const v of o.extra) this.extra.push(v);
    for (const i of o.idx) this.idx.push(i + base);
    this.useExtra = this.useExtra || o.useExtra;
  }

  /** Apply a matrix to positions and normals of vertices [from, count). */
  transform(m: THREE.Matrix4, from = 0): void {
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const p = new THREE.Vector3();
    for (let i = from; i < this.count; i++) {
      p.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]).applyMatrix4(m);
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
      p.set(this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2]).applyMatrix3(nm).normalize();
      this.nrm[i * 3] = p.x;
      this.nrm[i * 3 + 1] = p.y;
      this.nrm[i * 3 + 2] = p.z;
    }
  }

  build(extraName = 'aSurf'): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.useExtra) g.setAttribute(extraName, new THREE.Float32BufferAttribute(this.extra, 1));
    const n = this.count;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Tubes

export interface TubeOptions {
  /** Radial segments. */
  radial: number;
  /** Texture repeats around the circumference (integer keeps the seam invisible). */
  uRepeat: number;
  /** V texture units per metre along the tube. */
  vPerMetre: number;
  /** V at the first ring. */
  v0?: number;
  /** Close the end with a short cone. */
  capEnd?: boolean;
  /** Close the start (for free-standing tubes such as cut logs). */
  capStart?: boolean;
  /** Radius multiplier per ring / angle (flare, lobes, bark roughness). */
  radiusMod?: (ring: number, angle: number, p: V3) => number;
  /** Vertex colour per ring / angle. */
  color?: (ring: number, angle: number, p: V3, out: [number, number, number]) => void;
}

const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _tmp = new THREE.Vector3();

/** Pick any unit vector perpendicular to `t`. */
export function anyPerp(t: V3, out: V3): V3 {
  if (Math.abs(t.y) < 0.9) out.set(0, 1, 0);
  else out.set(1, 0, 0);
  return out.cross(t).normalize();
}

/**
 * Tube along a polyline with per-point radii (parallel-transport frames,
 * no twisting). Returns the index of the first vertex.
 */
export function addTube(md: MeshData, pts: V3[], radii: number[], o: TubeOptions): number {
  const n = pts.length;
  const R = Math.max(3, o.radial | 0);
  const first = md.count;
  const col: [number, number, number] = [1, 1, 1];
  const tangents: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    tangents.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  const N = anyPerp(tangents[0], new THREE.Vector3());
  let v = o.v0 ?? 0;
  const ringStart: number[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const T = tangents[i];
    if (i > 0) {
      // transport the normal from the previous tangent
      _q.setFromUnitVectors(tangents[i - 1], T);
      N.applyQuaternion(_q);
      N.addScaledVector(T, -N.dot(T)).normalize();
      v += pts[i].distanceTo(pts[i - 1]) * o.vPerMetre;
    }
    _b.crossVectors(T, N).normalize();
    // radius slope tilts the normal along the tube axis
    const dr = i > 0 && i < n - 1 ? (radii[i + 1] - radii[i - 1]) / Math.max(1e-4, pts[i + 1].distanceTo(pts[i - 1])) : i === 0 && n > 1 ? (radii[1] - radii[0]) / Math.max(1e-4, pts[1].distanceTo(pts[0])) : 0;
    ringStart.push(md.count);
    for (let j = 0; j <= R; j++) {
      const ang = (j / R) * Math.PI * 2;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      _n.set(N.x * c + _b.x * s, N.y * c + _b.y * s, N.z * c + _b.z * s);
      const rm = o.radiusMod ? o.radiusMod(i, ang, pts[i]) : 1;
      const r = radii[i] * rm;
      p.copy(pts[i]).addScaledVector(_n, r);
      if (o.color) o.color(i, ang, p, col);
      _tmp.copy(_n).addScaledVector(T, -dr).normalize();
      md.vert(p.x, p.y, p.z, _tmp.x, _tmp.y, _tmp.z, (j / R) * o.uRepeat, v, col[0], col[1], col[2]);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const a = ringStart[i];
    const b = ringStart[i + 1];
    for (let j = 0; j < R; j++) md.quad(a + j, a + j + 1, b + j + 1, b + j);
  }
  if (o.capEnd && n > 1) {
    const T = tangents[n - 1];
    const tip = pts[n - 1].clone().addScaledVector(T, radii[n - 1] * 0.8);
    if (o.color) o.color(n - 1, 0, tip, col);
    const c = md.vert(tip.x, tip.y, tip.z, T.x, T.y, T.z, 0.5 * o.uRepeat, v + radii[n - 1] * o.vPerMetre, col[0], col[1], col[2]);
    const a = ringStart[n - 1];
    for (let j = 0; j < R; j++) md.tri(a + j, a + j + 1, c);
  }
  if (o.capStart && n > 1) {
    const T = tangents[0];
    const base = pts[0];
    if (o.color) o.color(0, 0, base, col);
    const c = md.vert(base.x, base.y, base.z, -T.x, -T.y, -T.z, 0.5 * o.uRepeat, (o.v0 ?? 0) - radii[0] * o.vPerMetre, col[0], col[1], col[2]);
    const a = ringStart[0];
    for (let j = 0; j < R; j++) md.tri(a + j + 1, a + j, c);
  }
  return first;
}

// ---------------------------------------------------------------------------
// Cards and ribbons

export interface Ellipsoid {
  c: V3;
  r: V3;
}

/** Ellipsoid around a set of points (bounding box based, slightly padded). */
export function ellipsoidOf(points: V3[], pad = 1.05): Ellipsoid {
  const box = new THREE.Box3().setFromPoints(points);
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).multiplyScalar(0.5 * pad);
  r.x = Math.max(r.x, 0.2);
  r.y = Math.max(r.y, 0.2);
  r.z = Math.max(r.z, 0.2);
  return { c, r };
}

/** Outward normal of an ellipsoid at p (gradient), written to out. */
export function ellipsoidNormal(e: Ellipsoid, p: V3, out: V3): V3 {
  out.set((p.x - e.c.x) / (e.r.x * e.r.x), (p.y - e.c.y) / (e.r.y * e.r.y), (p.z - e.c.z) / (e.r.z * e.r.z));
  if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
  return out.normalize();
}

/** Normalised radial depth (0 centre … 1 surface) of p in the ellipsoid. */
export function ellipsoidDepth(e: Ellipsoid, p: V3): number {
  const x = (p.x - e.c.x) / e.r.x;
  const y = (p.y - e.c.y) / e.r.y;
  const z = (p.z - e.c.z) / e.r.z;
  return Math.sqrt(x * x + y * y + z * z);
}

export interface CardSpec {
  /** Base centre of the card (sprite root). */
  base: V3;
  /** Unit axis from base to the far edge (sprite "up", v direction). */
  up: V3;
  /** Unit axis across the card (u direction). */
  side: V3;
  width: number;
  height: number;
  /** Atlas rect [u0, v0, u1, v1]. */
  uv: [number, number, number, number];
  /** Mirror horizontally. */
  flip?: boolean;
  color: [number, number, number];
  /** Bend the card: offset of the far edge along its normal (m), curving it. */
  curl?: number;
  /** Rows of quads along the height (≥1; >1 needed for curl). */
  rows?: number;
}

/** Collected card quads, finished with crown-bent normals. */
export class CardSet {
  private specs: CardSpec[] = [];
  add(c: CardSpec): void {
    this.specs.push(c);
  }
  get length(): number {
    return this.specs.length;
  }
  /** Randomly drop cards until at most `max` remain (keeps the spatial distribution). */
  thin(max: number, rnd: () => number): void {
    const s = this.specs;
    while (s.length > max) {
      const i = Math.floor(rnd() * s.length);
      s[i] = s[s.length - 1];
      s.pop();
    }
  }
  centres(): V3[] {
    return this.specs.map((s) => s.base.clone().addScaledVector(s.up, s.height * 0.5));
  }
  /**
   * Emit into md. Normals = mix(face normal (towards outside), ellipsoid normal, bendAmt).
   * `ao(p, depth)` returns a brightness multiplier per vertex.
   */
  emit(md: MeshData, crown: Ellipsoid | null, bendAmt: number, ao?: (p: V3, depth: number, nrm: V3) => number): void {
    const p = new THREE.Vector3();
    const fn = new THREE.Vector3();
    const en = new THREE.Vector3();
    const nn = new THREE.Vector3();
    for (const s of this.specs) {
      const rows = Math.max(1, s.rows ?? 1);
      fn.crossVectors(s.side, s.up).normalize();
      const centre = _tmp.copy(s.base).addScaledVector(s.up, s.height * 0.5);
      if (crown) {
        ellipsoidNormal(crown, centre, en);
        if (fn.dot(en) < 0) fn.negate();
      }
      const start = md.count;
      const [u0, v0, u1, v1] = s.uv;
      for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        const curlOff = (s.curl ?? 0) * t * t;
        for (let k = 0; k < 2; k++) {
          const sx = (k - 0.5) * s.width;
          p.copy(s.base).addScaledVector(s.up, t * s.height).addScaledVector(s.side, sx).addScaledVector(fn, curlOff);
          if (crown) {
            ellipsoidNormal(crown, p, en);
            nn.copy(fn).lerp(en, bendAmt).normalize();
          } else nn.copy(fn);
          const depth = crown ? ellipsoidDepth(crown, p) : 1;
          const a = ao ? ao(p, depth, nn) : 1;
          const uu = (k === 0) !== !!s.flip ? u0 : u1;
          md.vert(p.x, p.y, p.z, nn.x, nn.y, nn.z, uu, v0 + (v1 - v0) * t, s.color[0] * a, s.color[1] * a, s.color[2] * a);
        }
      }
      for (let r = 0; r < rows; r++) {
        const a = start + r * 2;
        md.quad(a, a + 1, a + 3, a + 2);
      }
    }
  }
}

/**
 * Ribbon along a polyline (frond / blade / leaf strap). `widths[i]` is the
 * half-width at each point; the ribbon spans side·[-w, +w] (or [0, w] when
 * `half` is set) with u from u0 to u1 across and v from v0 to v1 along.
 * `sideFn(i)` gives the across direction at each point.
 */
export function addRibbon(
  md: MeshData,
  pts: V3[],
  widths: number[],
  sides: V3[],
  normals: V3[],
  uv: [number, number, number, number],
  color: (i: number, t: number) => [number, number, number],
  half = false,
): void {
  const n = pts.length;
  const start = md.count;
  const [u0, v0, u1, v1] = uv;
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const c = color(i, t);
    const nr = normals[i];
    for (let k = 0; k < 2; k++) {
      const off = half ? k * widths[i] : (k * 2 - 1) * widths[i];
      p.copy(pts[i]).addScaledVector(sides[i], off);
      md.vert(p.x, p.y, p.z, nr.x, nr.y, nr.z, k === 0 ? u0 : u1, v0 + (v1 - v0) * t, c[0], c[1], c[2]);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const a = start + i * 2;
    md.quad(a, a + 1, a + 3, a + 2);
  }
}

/** Rotate vector `v` about unit `axis` by `ang` (in place). */
export function rotateAbout(v: V3, axis: V3, ang: number): V3 {
  _q.setFromAxisAngle(axis, ang);
  return v.applyQuaternion(_q);
}

/** Direction at angle `down` from `dir`, at azimuth `az` around it. */
export function coneDir(dir: V3, down: number, az: number, out: V3): V3 {
  const a = anyPerp(dir, _t);
  _n.crossVectors(dir, a).normalize();
  const s = Math.sin(down);
  out.copy(dir).multiplyScalar(Math.cos(down)).addScaledVector(a, s * Math.cos(az)).addScaledVector(_n, s * Math.sin(az));
  return out.normalize();
}

/** Build a group of meshes from (MeshData, material) pairs, skipping empties. */
export function groupOf(parts: [MeshData, THREE.Material, string?][]): THREE.Group {
  const g = new THREE.Group();
  for (const [md, mat, name] of parts) {
    if (md.tris === 0) continue;
    const mesh = new THREE.Mesh(md.build(), mat);
    if (name) mesh.name = name;
    g.add(mesh);
  }
  return g;
}
