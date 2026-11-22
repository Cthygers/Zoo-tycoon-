// Signed-distance primitives used to sculpt creatures.
//
// Author-facing primitives are plain objects (see `Prim`) created with the
// helper functions at the bottom of this file. The mesher compiles them into
// `CompiledPrim` instances (flat numeric fields, monomorphic → fast in V8).
//
// All coordinates are model space in metres: +Y up, the creature faces +Z,
// feet on y = 0, origin on the ground between the feet.

import { Noise } from '../../core/rng';

export type Vec3 = readonly [number, number, number];

/** Optional noise displacement of a primitive's surface (shaggy manes, lumpy hide). */
export interface NoiseDisp {
  /** Displacement amplitude in metres (positive = surface pushed outward on peaks). */
  amp: number;
  /** Base spatial frequency in cycles per metre. */
  freq: number;
  octaves?: number;
  /** Per-axis frequency multipliers in the primitive's local frame (e.g. [1, 3, 1] for vertical tufts). */
  stretch?: Vec3;
  /** Ridged (|noise|) displacement → clumpy tufts instead of round lumps. */
  ridged?: boolean;
  seed?: number;
}

export interface PrimOpts {
  /** Coat / material tag. Defaults to the bone name. Coat functions read it as `sample.part`. */
  part?: string;
  /** Smooth-union radius in metres (how softly this blends into what came before). Default 0.03. */
  blend?: number;
  /** Smooth subtraction (carve eye sockets, mouth line, nostrils). */
  sub?: boolean;
  noise?: NoiseDisp;
  /** Detail region id: primitives sharing a region are meshed on a finer local grid (thin legs, ears, tails). */
  region?: string;
  /** Skin-weight falloff scale (multiplies the default falloff distance). */
  skin?: number;
  /** Skin-weight multiplier (default 1). */
  skinWeight?: number;
  /** This primitive never contributes skin weights (e.g. a pad that should follow neighbours). */
  noSkin?: boolean;
}

interface PrimBase extends PrimOpts {
  /** Bone the primitive deforms with. */
  bone: string;
}

export interface EllipsoidPrim extends PrimBase {
  kind: 'ellipsoid';
  c: Vec3;
  r: Vec3;
  /** Euler XYZ rotation (radians) of the ellipsoid axes. */
  rot?: Vec3;
}

/** Tapered capsule ("round cone") from a (radius ra) to b (radius rb). */
export interface ConePrim extends PrimBase {
  kind: 'cone';
  a: Vec3;
  b: Vec3;
  ra: number;
  rb: number;
}

export interface BoxPrim extends PrimBase {
  kind: 'box';
  c: Vec3;
  half: Vec3;
  round: number;
  rot?: Vec3;
}

export type Prim = EllipsoidPrim | ConePrim | BoxPrim;

// ---------------------------------------------------------------------------
// Helpers for authors

export function ellipsoid(bone: string, c: Vec3, r: Vec3, opts: PrimOpts & { rot?: Vec3 } = {}): EllipsoidPrim {
  return { kind: 'ellipsoid', bone, c, r, ...opts };
}

export function sphere(bone: string, c: Vec3, r: number, opts: PrimOpts = {}): EllipsoidPrim {
  return { kind: 'ellipsoid', bone, c, r: [r, r, r], ...opts };
}

/** Tapered capsule between two points with two radii. */
export function cone(bone: string, a: Vec3, b: Vec3, ra: number, rb: number, opts: PrimOpts = {}): ConePrim {
  return { kind: 'cone', bone, a, b, ra, rb, ...opts };
}

export function capsule(bone: string, a: Vec3, b: Vec3, r: number, opts: PrimOpts = {}): ConePrim {
  return { kind: 'cone', bone, a, b, ra: r, rb: r, ...opts };
}

export function roundBox(bone: string, c: Vec3, half: Vec3, round: number, opts: PrimOpts & { rot?: Vec3 } = {}): BoxPrim {
  return { kind: 'box', bone, c, half, round, ...opts };
}

/**
 * A smoothly bent tube through a list of points (each with a radius), made of
 * chained tapered capsules. `bones` gives the bone of each segment (length
 * points-1) or one bone for all.
 */
export function tube(
  bones: string | string[],
  pts: readonly Vec3[],
  radii: readonly number[],
  opts: PrimOpts = {},
): ConePrim[] {
  const out: ConePrim[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const bone = typeof bones === 'string' ? bones : bones[Math.min(i, bones.length - 1)];
    out.push(cone(bone, pts[i], pts[i + 1], radii[i], radii[i + 1], { blend: 0.02, ...opts }));
  }
  return out;
}

/**
 * Mirror primitives across the X = 0 plane. `rename` maps bone / part / region
 * names of the left side to the right side (default: swaps 'L' ↔ 'R' in
 * suffixes like `FL_upper` → `FR_upper`, `ear.L` → `ear.R`).
 */
export function mirrorX<T extends Prim>(prims: readonly T[], rename: (name: string) => string = mirrorName): T[] {
  return prims.map((p) => {
    const m: Prim = { ...p, bone: rename(p.bone) };
    if (p.part) m.part = rename(p.part);
    if (p.region) m.region = rename(p.region);
    if (m.kind === 'ellipsoid' || m.kind === 'box') {
      const q = p as EllipsoidPrim | BoxPrim;
      m.c = [-q.c[0], q.c[1], q.c[2]];
      if (q.rot) m.rot = [q.rot[0], -q.rot[1], -q.rot[2]];
    } else if (m.kind === 'cone') {
      const q = p as ConePrim;
      m.a = [-q.a[0], q.a[1], q.a[2]];
      m.b = [-q.b[0], q.b[1], q.b[2]];
    }
    return m as T;
  });
}

/** Default L↔R name swap used by mirrorX: `FL`↔`FR`, `FL_x`↔`FR_x`, `HL_x`↔`HR_x`, `x.L`↔`x.R`, `x_L`↔`x_R`. */
export function mirrorName(name: string): string {
  if (/^[FH]L(_|$)/.test(name)) return name[0] + 'R' + name.slice(2);
  if (/^[FH]R(_|$)/.test(name)) return name[0] + 'L' + name.slice(2);
  if (/[._]L$/.test(name)) return name.slice(0, -1) + 'R';
  if (/[._]R$/.test(name)) return name.slice(0, -1) + 'L';
  return name;
}

/** Returns a copy of the primitives with every coordinate scaled (uniform). */
export function scalePrims<T extends Prim>(prims: readonly T[], s: number): T[] {
  const sv = (v: Vec3): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
  return prims.map((p) => {
    const m = { ...p } as Prim;
    if (m.blend !== undefined) m.blend *= s;
    if (m.kind === 'ellipsoid') {
      m.c = sv(m.c);
      m.r = sv(m.r);
    } else if (m.kind === 'box') {
      m.c = sv(m.c);
      m.half = sv(m.half);
      m.round *= s;
    } else {
      m.a = sv(m.a);
      m.b = sv(m.b);
      m.ra *= s;
      m.rb *= s;
    }
    if (m.noise) m.noise = { ...m.noise, amp: m.noise.amp * s, freq: m.noise.freq / s };
    return m as T;
  });
}

// ---------------------------------------------------------------------------
// Compiled form

const TYPE_ELLIPSOID = 0;
const TYPE_CONE = 1;
const TYPE_BOX = 2;

const noiseCache = new Map<number, Noise>();
function noiseFor(seed: number): Noise {
  let n = noiseCache.get(seed);
  if (!n) {
    n = new Noise(seed);
    noiseCache.set(seed, n);
  }
  return n;
}

/** Euler XYZ → rotation matrix (local → model), row-major 3x3. */
function eulerMatrix(rx: number, ry: number, rz: number): number[] {
  const a = Math.cos(rx), b = Math.sin(rx);
  const c = Math.cos(ry), d = Math.sin(ry);
  const e = Math.cos(rz), f = Math.sin(rz);
  // Same convention as THREE.Matrix4.makeRotationFromEuler with order 'XYZ'.
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  return [
    c * e, -c * f, d,
    af + be * d, ae - bf * d, -b * c,
    bf - ae * d, be + af * d, a * c,
  ];
}

export class CompiledPrim {
  readonly type: number;
  readonly sub: boolean;
  readonly k: number;
  readonly bone: number;
  readonly part: number;
  readonly region: number;
  readonly skinSigma: number;
  readonly skinW: number;
  readonly noSkin: boolean;
  // position / shape
  cx = 0; cy = 0; cz = 0;
  bx = 0; by = 0; bz = 0; // cone: b - a
  rx = 0; ry = 0; rz = 0; // ellipsoid radii / box half extents
  ra = 0; rb = 0; round = 0;
  minR = 0;
  hasRot = false;
  // model → local rotation (transpose of local→model)
  m00 = 1; m01 = 0; m02 = 0;
  m10 = 0; m11 = 1; m12 = 0;
  m20 = 0; m21 = 0; m22 = 1;
  // cone precompute
  l2 = 1; rr = 0; a2 = 1; il2 = 1;
  // noise
  nAmp = 0; nFreq = 0; nOct = 1; nsx = 1; nsy = 1; nsz = 1; nRidged = false;
  noise: Noise | null = null;
  // influence AABB (geometry + blend + noise)
  minX = 0; minY = 0; minZ = 0; maxX = 0; maxY = 0; maxZ = 0;
  /** Axis parameter of the last `dist` call (cones: 0 at a, 1 at b). */
  t = 0;

  constructor(p: Prim, boneIndex: number, partIndex: number, regionIndex: number) {
    this.sub = !!p.sub;
    this.k = Math.max(0, p.blend ?? 0.03);
    this.bone = boneIndex;
    this.part = partIndex;
    this.region = regionIndex;
    this.skinW = p.skinWeight ?? 1;
    this.noSkin = !!p.noSkin || this.sub;
    let ext = 0;
    if (p.kind === 'ellipsoid' || p.kind === 'box') {
      this.type = p.kind === 'ellipsoid' ? TYPE_ELLIPSOID : TYPE_BOX;
      this.cx = p.c[0]; this.cy = p.c[1]; this.cz = p.c[2];
      const r = p.kind === 'ellipsoid' ? p.r : p.half;
      this.rx = Math.max(1e-4, r[0]); this.ry = Math.max(1e-4, r[1]); this.rz = Math.max(1e-4, r[2]);
      if (p.kind === 'box') this.round = Math.min(p.round, this.rx, this.ry, this.rz);
      this.minR = Math.min(this.rx, this.ry, this.rz);
      ext = Math.max(this.rx, this.ry, this.rz);
      if (p.rot && (p.rot[0] || p.rot[1] || p.rot[2])) {
        this.hasRot = true;
        const m = eulerMatrix(p.rot[0], p.rot[1], p.rot[2]);
        // transpose
        this.m00 = m[0]; this.m01 = m[3]; this.m02 = m[6];
        this.m10 = m[1]; this.m11 = m[4]; this.m12 = m[7];
        this.m20 = m[2]; this.m21 = m[5]; this.m22 = m[8];
        // AABB of rotated box/ellipsoid: |M| * r
        const ex = Math.abs(m[0]) * this.rx + Math.abs(m[1]) * this.ry + Math.abs(m[2]) * this.rz;
        const ey = Math.abs(m[3]) * this.rx + Math.abs(m[4]) * this.ry + Math.abs(m[5]) * this.rz;
        const ez = Math.abs(m[6]) * this.rx + Math.abs(m[7]) * this.ry + Math.abs(m[8]) * this.rz;
        this.setBounds(this.cx - ex, this.cy - ey, this.cz - ez, this.cx + ex, this.cy + ey, this.cz + ez);
      } else {
        this.setBounds(this.cx - this.rx, this.cy - this.ry, this.cz - this.rz, this.cx + this.rx, this.cy + this.ry, this.cz + this.rz);
      }
    } else {
      this.type = TYPE_CONE;
      this.cx = p.a[0]; this.cy = p.a[1]; this.cz = p.a[2];
      this.bx = p.b[0] - p.a[0]; this.by = p.b[1] - p.a[1]; this.bz = p.b[2] - p.a[2];
      let ra = Math.max(1e-4, p.ra), rb = Math.max(1e-4, p.rb);
      const l2 = Math.max(1e-8, this.bx * this.bx + this.by * this.by + this.bz * this.bz);
      const len = Math.sqrt(l2);
      // A round cone requires |ra - rb| < length; otherwise shrink the smaller radius gap.
      if (Math.abs(ra - rb) > len * 0.98) {
        if (ra > rb) rb = ra - len * 0.98;
        else ra = rb - len * 0.98;
      }
      this.ra = ra; this.rb = rb;
      this.l2 = l2;
      this.rr = ra - rb;
      this.a2 = l2 - this.rr * this.rr;
      this.il2 = 1 / l2;
      this.minR = Math.min(ra, rb);
      ext = Math.max(ra, rb);
      this.setBounds(
        Math.min(p.a[0] - ra, p.b[0] - rb), Math.min(p.a[1] - ra, p.b[1] - rb), Math.min(p.a[2] - ra, p.b[2] - rb),
        Math.max(p.a[0] + ra, p.b[0] + rb), Math.max(p.a[1] + ra, p.b[1] + rb), Math.max(p.a[2] + ra, p.b[2] + rb),
      );
    }
    if (p.noise && p.noise.amp !== 0) {
      this.nAmp = p.noise.amp;
      this.nFreq = p.noise.freq;
      this.nOct = Math.max(1, Math.min(5, p.noise.octaves ?? 2));
      const st = p.noise.stretch ?? [1, 1, 1];
      this.nsx = st[0]; this.nsy = st[1]; this.nsz = st[2];
      this.nRidged = !!p.noise.ridged;
      this.noise = noiseFor(p.noise.seed ?? 7);
    }
    // Influence: anything within blend radius (+ noise) can modify the field.
    const grow = this.k + Math.abs(this.nAmp) * 1.05;
    this.minX -= grow; this.minY -= grow; this.minZ -= grow;
    this.maxX += grow; this.maxY += grow; this.maxZ += grow;
    this.skinSigma = Math.max(0.012, Math.min(0.08, this.k * 0.55 + this.minR * 0.18)) * (p.skin ?? 1);
    void ext;
  }

  private setBounds(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.minX = a; this.minY = b; this.minZ = c;
    this.maxX = d; this.maxY = e; this.maxZ = f;
  }

  /** True if the influence box intersects [x0,x1]×[y0,y1]×[z0,z1]. */
  overlaps(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    return !(x1 < this.minX || x0 > this.maxX || y1 < this.minY || y0 > this.maxY || z1 < this.minZ || z0 > this.maxZ);
  }

  /** Signed distance (approximate for ellipsoids) including noise displacement. Sets `this.t`. */
  dist(px: number, py: number, pz: number): number {
    let d: number;
    let lx = px - this.cx, ly = py - this.cy, lz = pz - this.cz;
    if (this.type === TYPE_CONE) {
      const bx = this.bx, by = this.by, bz = this.bz, l2 = this.l2;
      const y = lx * bx + ly * by + lz * bz;
      const z = y - l2;
      const qx = lx * l2 - bx * y, qy = ly * l2 - by * y, qz = lz * l2 - bz * y;
      const x2 = qx * qx + qy * qy + qz * qz;
      const y2 = y * y * l2;
      const z2 = z * z * l2;
      const rr = this.rr, a2 = this.a2, il2 = this.il2;
      const k = Math.sign(rr) * rr * rr * x2;
      const t = y * il2;
      this.t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.sign(z) * a2 * z2 > k) d = Math.sqrt(x2 + z2) * il2 - this.rb;
      else if (Math.sign(y) * a2 * y2 < k) d = Math.sqrt(x2 + y2) * il2 - this.ra;
      else d = (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - this.ra;
    } else {
      if (this.hasRot) {
        const ax = this.m00 * lx + this.m01 * ly + this.m02 * lz;
        const ay = this.m10 * lx + this.m11 * ly + this.m12 * lz;
        const az = this.m20 * lx + this.m21 * ly + this.m22 * lz;
        lx = ax; ly = ay; lz = az;
      }
      if (this.type === TYPE_ELLIPSOID) {
        const ix = lx / this.rx, iy = ly / this.ry, iz = lz / this.rz;
        const k0 = Math.sqrt(ix * ix + iy * iy + iz * iz);
        const jx = ix / this.rx, jy = iy / this.ry, jz = iz / this.rz;
        const k1 = Math.sqrt(jx * jx + jy * jy + jz * jz);
        d = k1 < 1e-9 ? -this.minR : (k0 * (k0 - 1)) / k1;
        // Far away the IQ approximation over-estimates wildly for flat ellipsoids; clamp to a bound.
        this.t = 0;
      } else {
        const r = this.round;
        const qx = Math.abs(lx) - this.rx + r, qy = Math.abs(ly) - this.ry + r, qz = Math.abs(lz) - this.rz + r;
        const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
        const inner = Math.max(qx, qy, qz);
        d = Math.sqrt(mx * mx + my * my + mz * mz) + (inner < 0 ? inner : 0) - r;
        this.t = 0;
      }
      lx = px - this.cx; ly = py - this.cy; lz = pz - this.cz;
    }
    if (this.noise !== null && d < Math.abs(this.nAmp) * 1.5 + 0.02) {
      const f = this.nFreq;
      let x = lx, y = ly, z = lz;
      if (this.hasRot) {
        x = this.m00 * lx + this.m01 * ly + this.m02 * lz;
        y = this.m10 * lx + this.m11 * ly + this.m12 * lz;
        z = this.m20 * lx + this.m21 * ly + this.m22 * lz;
      }
      x *= f * this.nsx; y *= f * this.nsy; z *= f * this.nsz;
      let n = 0, amp = 1, norm = 0;
      for (let o = 0; o < this.nOct; o++) {
        let v = this.noise.noise3(x, y, z);
        if (this.nRidged) v = 1 - 2 * Math.abs(v);
        n += v * amp;
        norm += amp;
        amp *= 0.5;
        x *= 2.03; y *= 2.03; z *= 2.03;
      }
      d -= (n / norm) * this.nAmp;
    }
    return d;
  }
}

/** Polynomial smooth minimum (k = blend radius). */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return a < b ? a : b;
  const h = k - Math.abs(a - b);
  const m = a < b ? a : b;
  return h > 0 ? m - (h * h * 0.25) / k : m;
}

/** Smooth maximum. */
export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

/**
 * Transform primitives: scale uniformly about `about` (default origin), then
 * translate by `offset`. Radii / blend / noise scale with `scale`.
 */
export function transformPrims<T extends Prim>(prims: readonly T[], t: { scale?: number; about?: Vec3; offset?: Vec3 }): T[] {
  const s = t.scale ?? 1;
  const a = t.about ?? [0, 0, 0];
  const o = t.offset ?? [0, 0, 0];
  const tp = (v: Vec3): Vec3 => [a[0] + (v[0] - a[0]) * s + o[0], a[1] + (v[1] - a[1]) * s + o[1], a[2] + (v[2] - a[2]) * s + o[2]];
  const sv = (v: Vec3): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
  return prims.map((p) => {
    const m = { ...p } as Prim;
    if (m.blend !== undefined) m.blend *= s;
    if (m.kind === 'ellipsoid') {
      m.c = tp(m.c);
      m.r = sv(m.r);
    } else if (m.kind === 'box') {
      m.c = tp(m.c);
      m.half = sv(m.half);
      m.round *= s;
    } else {
      m.a = tp(m.a);
      m.b = tp(m.b);
      m.ra *= s;
      m.rb *= s;
    }
    if (m.noise) m.noise = { ...m.noise, amp: m.noise.amp * s, freq: m.noise.freq / s };
    return m as T;
  });
}

/** Transform a point the same way as transformPrims. */
export function transformPoint(v: Vec3, t: { scale?: number; about?: Vec3; offset?: Vec3 }): Vec3 {
  const s = t.scale ?? 1;
  const a = t.about ?? [0, 0, 0];
  const o = t.offset ?? [0, 0, 0];
  return [a[0] + (v[0] - a[0]) * s + o[0], a[1] + (v[1] - a[1]) * s + o[1], a[2] + (v[2] - a[2]) * s + o[2]];
}

/** Left-side primitives plus their mirrored right-side copies. */
export function symmetric<T extends Prim>(prims: readonly T[], rename?: (name: string) => string): T[] {
  return [...prims, ...mirrorX(prims, rename)];
}
