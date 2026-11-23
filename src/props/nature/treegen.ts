// Generic recursive tree generator: a species describes its levels (trunk,
// limbs, branches, twigs) with segment counts, gnarl, taper and child
// spawning rules plus a tropism hook (light seeking, gravity, flat-top crown
// attraction). The skeleton is meshed into tapered bark tubes and dressed
// with leaf-cluster cards whose normals bend out of the crown ellipsoid.

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { type AtlasInfo, cellUV } from './atlases';
import { BARK_U, BARK_V } from './barks';
import { addTube, anyPerp, CardSet, coneDir, type Ellipsoid, ellipsoidDepth, ellipsoidOf, MeshData, v3, type V3 } from './geo';
import { detail } from './mats';
import { sstep } from './tex';

export interface Branch {
  level: number;
  pts: V3[];
  radii: number[];
  length: number;
  parent: Branch | null;
  /** Position along the parent (0..1). */
  parentT: number;
}

export interface KidSpec {
  /** Children per metre of parent length … */
  perMetre?: number;
  /** … or a fixed count range. */
  count?: [number, number];
  /** Range along the parent (0..1) where children spawn. */
  range: [number, number];
  /** Angle from the parent direction (radians) at range start / end. */
  angle: [number, number];
  angleJitter?: number;
  /** Child length as a fraction of parent length (random in range) × shape(t). */
  lenFrac: [number, number];
  shape?: (t: number) => number;
  /** Absolute length override (metres) — receives t along parent and the spawn point. */
  length?: (t: number, p: V3, rng: Rng) => number;
  /** Child base radius relative to the parent radius at the spawn point. */
  radFrac: number;
  phyllo: 'spiral' | 'whorl' | 'opposite' | 'random';
  /** Children per whorl. */
  whorl?: number;
  /** 0..1 pull of the child's horizontal direction away from the tree axis. */
  outward?: number;
}

export interface LevelSpec {
  segs: number;
  /** Random direction change per segment (radians-ish). */
  gnarl: number;
  /** Tip radius as a fraction of the base radius. */
  taper: number;
  /** Radius falloff exponent along the branch. */
  taperPow?: number;
  /** Tube is meshed only when the base radius exceeds this (m). */
  minMeshRadius?: number;
  kids?: KidSpec;
}

export interface TreeSpec {
  levels: LevelSpec[];
  /** Adjust the growth direction `d` (in place) at point p of a level, t along. */
  tropism?: (level: number, p: V3, d: V3, t: number, rng: Rng) => void;
}

export interface Skeleton {
  branches: Branch[];
}

const _a = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Grow a full skeleton from a trunk start / direction / length / radius. */
export function growTree(spec: TreeSpec, rng: Rng, start: V3, dir: V3, length: number, radius: number): Skeleton {
  const branches: Branch[] = [];
  const grow = (level: number, p0: V3, d0: V3, len: number, r0: number, parent: Branch | null, parentT: number): void => {
    const L = spec.levels[level];
    const segs = Math.max(2, L.segs);
    const sl = len / segs;
    const pts: V3[] = [p0.clone()];
    const radii: number[] = [r0];
    const d = d0.clone().normalize();
    const p = p0.clone();
    const tp = L.taperPow ?? 1;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      d.x += rng.gauss() * L.gnarl;
      d.y += rng.gauss() * L.gnarl * 0.6;
      d.z += rng.gauss() * L.gnarl;
      d.normalize();
      spec.tropism?.(level, p, d, t, rng);
      d.normalize();
      p.addScaledVector(d, sl);
      pts.push(p.clone());
      radii.push(r0 * (1 - (1 - L.taper) * Math.pow(t, tp)));
    }
    const br: Branch = { level, pts, radii, length: len, parent, parentT };
    branches.push(br);
    const K = L.kids;
    if (!K || level + 1 >= spec.levels.length) return;
    let n = K.count ? rng.int(K.count[0], K.count[1]) : Math.round((K.perMetre ?? 0) * len * (K.range[1] - K.range[0]) * (0.85 + rng.float() * 0.3));
    if (n <= 0) return;
    const whorl = K.whorl ?? 3;
    let az = rng.range(0, Math.PI * 2);
    for (let k = 0; k < n; k++) {
      let t: number;
      if (K.phyllo === 'whorl') {
        const nw = Math.max(1, Math.ceil(n / whorl));
        const w = Math.floor(k / whorl);
        t = K.range[0] + (K.range[1] - K.range[0]) * ((w + 0.5) / nw) + rng.range(-0.01, 0.01);
        az = w * 0.9 + ((k % whorl) / whorl) * Math.PI * 2 + rng.range(-0.35, 0.35);
      } else {
        t = K.range[0] + (K.range[1] - K.range[0]) * ((k + 0.5 + rng.range(-0.35, 0.35)) / n);
        if (K.phyllo === 'spiral') az += 2.39996 + rng.range(-0.3, 0.3);
        else if (K.phyllo === 'opposite') az += Math.PI + (k % 2 ? 1.5708 : 0) + rng.range(-0.3, 0.3);
        else az = rng.range(0, Math.PI * 2);
      }
      t = Math.min(0.999, Math.max(0, t));
      // point / direction / radius on the parent at t
      const fi = t * segs;
      const i = Math.min(segs - 1, Math.floor(fi));
      const f = fi - i;
      const sp = new THREE.Vector3().lerpVectors(pts[i], pts[i + 1], f);
      const pd = _d.subVectors(pts[i + 1], pts[i]).normalize();
      const pr = radii[i] + (radii[i + 1] - radii[i]) * f;
      const rt = (t - K.range[0]) / Math.max(1e-6, K.range[1] - K.range[0]);
      const ang = K.angle[0] + (K.angle[1] - K.angle[0]) * rt + rng.range(-1, 1) * (K.angleJitter ?? 0.12);
      const cd = coneDir(pd, ang, az, new THREE.Vector3());
      // (not for limbs off the trunk: the trunk is the axis, and its slight lean
      // would otherwise swing every limb to one side)
      if (K.outward && level > 0) {
        _a.set(sp.x, 0, sp.z);
        if (_a.lengthSq() > 1e-4) {
          _a.normalize();
          const hl = Math.hypot(cd.x, cd.z);
          cd.x += (_a.x * hl - cd.x) * K.outward;
          cd.z += (_a.z * hl - cd.z) * K.outward;
          cd.normalize();
        }
      }
      const cl = K.length ? K.length(t, sp, rng) : len * rng.range(K.lenFrac[0], K.lenFrac[1]) * (K.shape ? K.shape(t) : 1);
      if (cl < 0.05) continue;
      const cr = Math.min(pr * K.radFrac, pr * 0.92);
      grow(level + 1, sp, cd, cl, cr, br, t);
    }
  };
  grow(0, start, dir, length, radius, null, 0);
  return { branches };
}

/** Radial segment count for a tube of base radius r (× mul, e.g. 0.5 for LODs). */
export function radialFor(r: number, mul = 1): number {
  const m = detail().seg * mul;
  const base = r > 1.0 ? 22 : r > 0.5 ? 16 : r > 0.25 ? 10 : r > 0.12 ? 8 : r > 0.06 ? 6 : r > 0.03 ? 5 : 4;
  return Math.max(3, Math.round(base * m));
}

export interface BarkOptions {
  /** Radius multiplier hook for the trunk (flare, lobes). */
  trunkMod?: (ring: number, angle: number, p: V3, b: Branch) => number;
  /** Vertex tint per point (species colouring: pine orange top, birch dark base…). */
  tint?: (p: V3, b: Branch, out: [number, number, number]) => void;
  crown?: Ellipsoid | null;
  /** Skip branches above this level. */
  maxLevel?: number;
  /** Simplify: drop every other ring on branches of level ≥ this (keeps ends). */
  thinFrom?: number;
  /** Species spec: honours LevelSpec.minMeshRadius. */
  spec?: TreeSpec;
  /** Radial segment multiplier (LODs). */
  radialMul?: number;
  /** Skip branches whose base radius is below this (m). */
  minRadius?: number;
  /** No end caps (LODs: hidden in the crown). */
  noCaps?: boolean;
}

/** Mesh the skeleton's branches as bark tubes. */
export function meshBark(sk: Skeleton, md: MeshData, o: BarkOptions = {}): void {
  const tint: [number, number, number] = [1, 1, 1];
  for (const b of sk.branches) {
    if (o.maxLevel !== undefined && b.level > o.maxLevel) continue;
    const L = b.radii[0];
    const minR = Math.max(o.spec?.levels[b.level]?.minMeshRadius ?? 0.004, o.minRadius ?? 0);
    if (L < minR) continue;
    let pts = b.pts;
    let radii = b.radii;
    if (o.thinFrom !== undefined && b.level >= o.thinFrom && pts.length > 3) {
      const np: V3[] = [];
      const nr: number[] = [];
      for (let i = 0; i < pts.length; i++)
        if (i % 2 === 0 || i === pts.length - 1) {
          np.push(pts[i]);
          nr.push(radii[i]);
        }
      pts = np;
      radii = nr;
    }
    const circ = Math.PI * 2 * L;
    const uRepeat = Math.max(1, Math.round(circ / BARK_U));
    const crown = o.crown;
    addTube(md, pts, radii, {
      radial: radialFor(L, o.radialMul ?? 1),
      uRepeat,
      vPerMetre: 1 / BARK_V,
      v0: b.level * 0.37,
      capEnd: !o.noCaps,
      radiusMod: b.level === 0 && o.trunkMod ? (i, a, p) => o.trunkMod!(i, a, p, b) : undefined,
      color: (_i, _a, p, out) => {
        tint[0] = tint[1] = tint[2] = 1;
        o.tint?.(p, b, tint);
        let ao = 1;
        if (crown) {
          const d = ellipsoidDepth(crown, p);
          if (d < 1) ao *= 0.55 + 0.45 * sstep(0.15, 1, d);
        }
        // ground contact
        ao *= 0.62 + 0.38 * sstep(-0.1, 0.6, p.y);
        out[0] = tint[0] * ao;
        out[1] = tint[1] * ao;
        out[2] = tint[2] * ao;
      },
    });
  }
}

export interface LeafOptions {
  atlas: AtlasInfo;
  /** Atlas cells to choose from. */
  cells?: number[];
  /** Levels whose branches carry cards (along the branch). */
  levels: number[];
  /** Cards per metre along qualifying branches. */
  perMetre: number;
  range: [number, number];
  /** Extra cards at each qualifying branch tip. */
  tip: number;
  /** Card width range (m) and height / width ratio. */
  size: [number, number];
  aspect: number;
  orient: 'outward' | 'up' | 'hang';
  /** Random tilt (radians). */
  tilt: number;
  /** Vertex tint range (multiplies the atlas). */
  tintA: [number, number, number];
  tintB: [number, number, number];
  /** Push the card base back toward the branch (fraction of height). */
  sink?: number;
  /** Bend of each card out of plane (m). */
  curl?: number;
  /** Skip a branch entirely with this probability. */
  skip?: number;
  /** Only place cards above this height (m). */
  minY?: number;
}

/** Place leaf cards on the skeleton. Returns the card set (call emit() later). */
export function placeLeaves(sk: Skeleton, rng: Rng, o: LeafOptions, set = new CardSet()): CardSet {
  const mul = detail().cards;
  const cells = o.cells ?? Array.from({ length: o.atlas.cols * o.atlas.rows }, (_, i) => i);
  const up = v3(0, 1, 0);
  const tmp = v3();
  const out = v3();
  const add = (p: V3, d: V3) => {
    if (o.minY !== undefined && p.y < o.minY) return;
    const w = rng.range(o.size[0], o.size[1]);
    const h = w * o.aspect;
    const U = v3();
    const S = v3();
    out.set(p.x, 0, p.z);
    if (out.lengthSq() < 1e-4) out.set(rng.range(-1, 1), 0, rng.range(-1, 1));
    out.normalize();
    if (o.orient === 'up') {
      // flat, layered cards (umbrella crowns): sprite axis horizontal
      U.set(d.x, 0, d.z);
      if (U.lengthSq() < 1e-4) U.copy(out);
      U.normalize().lerp(out, 0.4).normalize();
      const yaw = rng.range(-0.8, 0.8);
      U.set(U.x * Math.cos(yaw) - U.z * Math.sin(yaw), 0, U.x * Math.sin(yaw) + U.z * Math.cos(yaw));
      U.y = rng.range(-0.15, 0.25);
      U.normalize();
      S.crossVectors(U, up).normalize();
      // tilt around U
      const tl = rng.range(-o.tilt, o.tilt);
      tmp.crossVectors(S, U).normalize(); // card normal (≈ up)
      S.multiplyScalar(Math.cos(tl)).addScaledVector(tmp, Math.sin(tl)).normalize();
    } else if (o.orient === 'hang') {
      U.set(d.x * 0.35 + rng.range(-0.25, 0.25), -1, d.z * 0.35 + rng.range(-0.25, 0.25)).normalize();
      const a = rng.range(0, Math.PI * 2);
      S.set(Math.cos(a), 0, Math.sin(a));
      S.addScaledVector(U, -S.dot(U)).normalize();
    } else {
      U.copy(d).multiplyScalar(0.8).addScaledVector(out, 0.55).add(tmp.set(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).multiplyScalar(o.tilt));
      U.y += 0.15;
      if (U.y < -0.3) U.y = -U.y * 0.4;
      U.normalize();
      anyPerp(U, S);
      const a = rng.range(0, Math.PI * 2);
      tmp.crossVectors(U, S);
      S.multiplyScalar(Math.cos(a)).addScaledVector(tmp, Math.sin(a)).normalize();
    }
    const base = p.clone().addScaledVector(U, -h * (o.sink ?? 0.12));
    const tint: [number, number, number] = [0, 0, 0];
    const tt = rng.float();
    for (let c = 0; c < 3; c++) tint[c] = o.tintA[c] + (o.tintB[c] - o.tintA[c]) * tt;
    set.add({ base, up: U, side: S, width: w, height: h, uv: cellUV(o.atlas, rng.pick(cells)), flip: rng.chance(0.5), color: tint, curl: o.curl ?? 0, rows: o.curl ? 2 : 1 });
  };
  const pd = v3();
  for (const b of sk.branches) {
    if (!o.levels.includes(b.level)) continue;
    if (o.skip && rng.chance(o.skip)) continue;
    const n = b.pts.length - 1;
    const count = Math.round(o.perMetre * b.length * (o.range[1] - o.range[0]) * mul + rng.float() * 0.999);
    for (let k = 0; k < count; k++) {
      const t = o.range[0] + (o.range[1] - o.range[0]) * rng.float();
      const fi = t * n;
      const i = Math.min(n - 1, Math.floor(fi));
      const f = fi - i;
      const p = v3().lerpVectors(b.pts[i], b.pts[i + 1], f);
      pd.subVectors(b.pts[i + 1], b.pts[i]).normalize();
      add(p, pd);
    }
    const tips = Math.round(o.tip * mul + rng.float() * 0.5);
    for (let k = 0; k < tips; k++) {
      pd.subVectors(b.pts[n], b.pts[n - 1]).normalize();
      add(b.pts[n], pd);
    }
  }
  return set;
}

/** Standard leaf AO: darker inside / under the crown. */
export function leafAO(inner = 0.5): (p: V3, depth: number, n: V3) => number {
  return (_p, depth, n) => (inner + (1 - inner) * sstep(0.25, 1.0, depth)) * (0.78 + 0.22 * (n.y * 0.5 + 0.5));
}

/** Crown ellipsoid from card centres. */
export function crownOf(cards: CardSet): Ellipsoid {
  return ellipsoidOf(cards.centres(), 1.08);
}
