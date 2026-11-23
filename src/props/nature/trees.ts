// Tree species: umbrella acacia, baobab, broadleaf oak, Scots pine, silver
// birch (recursive skeletons) plus date palm and bamboo clump (bespoke).
// Each builder returns a Group with ≤ 3 meshes: bark, foliage (+ extras).

import * as THREE from 'three';
import { Noise, Rng } from '../../core/rng';
import { atlas, type AtlasKind, cellUV, leafMaterial } from './atlases';
import { barkMat, type BarkKind, BARK_U, BARK_V } from './barks';
import { addRibbon, addTube, CardSet, ellipsoidNormal, type Ellipsoid, groupOf, MeshData, v3, type V3 } from './geo';
import { detail, natureQuality } from './mats';
import { sstep } from './tex';
import { crownOf, growTree, leafAO, meshBark, placeLeaves, type Branch, type Skeleton, type TreeSpec } from './treegen';

const bnoise = new Noise(4242);

/** Trunk radius hook: root flare with buttress lobes + bark irregularity. */
function flare(amount: number, lobes: number, phase: number, rough: number, height = 0.55): (ring: number, a: number, p: V3) => number {
  return (_r, a, p) => {
    const y = Math.max(0, p.y);
    const f = amount * Math.exp(-y / height) * (0.65 + 0.35 * Math.cos(lobes * a + phase));
    const n = bnoise.noise3(Math.cos(a) * 1.4, p.y * 0.7, Math.sin(a) * 1.4) * rough;
    return 1 + f + n;
  };
}

function leanDir(rng: Rng, maxLean: number): V3 {
  const a = rng.range(0, Math.PI * 2);
  const l = rng.range(0, maxLean);
  return v3(Math.sin(l) * Math.cos(a), Math.cos(l), Math.sin(l) * Math.sin(a));
}

const TRUNK_SINK = 0.4;
/** Triangle budget per tree at medium quality. */
const TREE_TRIS = 4000;
const budgetRng = (seed: number): (() => number) => {
  const r = new Rng(seed * 31 + 7);
  return () => r.float();
};

interface FinishOpts {
  barkSway: number;
  trunkMod?: (ring: number, a: number, p: V3) => number;
  tint?: (p: V3, b: Branch, out: [number, number, number]) => void;
  bend?: number;
  aoInner?: number;
}

/** Everything a recursive tree needs to be meshed (full or LOD) — built once per variant. */
interface TreeParts {
  sk: Skeleton;
  spec: TreeSpec;
  /** Every placed card (unthinned). */
  cards: CardSet;
  bark: BarkKind;
  leaf: AtlasKind;
  opts: FinishOpts;
  /** LOD: deepest skeleton level meshed, thinnest branch meshed (m), crown-shell preference. */
  lod: { maxLevel: number; minRadius: number; shell?: number; frac?: number };
  /** Filled by fullTree(). */
  crown?: Ellipsoid;
  fullTris?: number;
  fullCards?: number;
  seed: number;
}

function fullTree(p: TreeParts): THREE.Group {
  const { sk, spec, opts } = p;
  const crown = crownOf(p.cards);
  // triangle budget (medium ≈ 4k per tree): thin branch rings first, then cap the cards
  const budget = TREE_TRIS * detail().cards;
  const barkOpts = { spec, crown, trunkMod: opts.trunkMod, tint: opts.tint };
  let bark = new MeshData();
  meshBark(sk, bark, barkOpts);
  if (bark.tris > budget * 0.5) {
    bark = new MeshData();
    meshBark(sk, bark, { ...barkOpts, thinFrom: 2 });
  }
  if (bark.tris > budget * 0.55) {
    bark = new MeshData();
    meshBark(sk, bark, { ...barkOpts, thinFrom: 1 });
  }
  const cards = p.cards.clone();
  cards.thin(Math.max(200, Math.floor((budget - bark.tris) / 2)), budgetRng(bark.tris));
  const leaves = new MeshData();
  cards.emit(leaves, crown, opts.bend ?? 0.78, leafAO(opts.aoInner ?? 0.45));
  const g = groupOf([
    [bark, barkMat(p.bark, opts.barkSway), 'bark'],
    [leaves, leafMat(p, opts), 'leaves'],
  ]);
  p.crown = crown;
  p.fullTris = bark.tris + leaves.tris;
  p.fullCards = cards.length;
  g.userData.tris = p.fullTris;
  return g;
}

/** All tree species share one foliage material (packed atlas sheet). */
function leafMat(_p: TreeParts, _opts: FinishOpts): THREE.Material {
  return leafMaterial('trees');
}

/**
 * Distant version (~15–20 % of the triangles): trunk + main limbs at half the
 * radial segments, every other ring, no caps; a sparse shell of larger cards
 * from the same atlas (same crown normals / AO, so shading and colour match).
 */
function lodTree(p: TreeParts): THREE.Group {
  if (p.fullTris === undefined) disposeGroup(fullTree(p));
  const { sk, spec, opts } = p;
  const crown = p.crown!;
  const bark = new MeshData();
  meshBark(sk, bark, { spec, crown, trunkMod: opts.trunkMod, tint: opts.tint, maxLevel: p.lod.maxLevel, minRadius: p.lod.minRadius, radialMul: 0.5, thinFrom: 1, noCaps: true });
  const fullCards = p.fullCards ?? p.cards.length;
  // a fixed share of the cards, grown to keep the crown's coverage
  const frac = p.lod.frac ?? 0.16;
  const n = Math.max(18, fullCards * frac);
  const grow = Math.min(2.6, Math.max(1, Math.sqrt(fullCards / n) * 0.9));
  const cards = p.cards.lodSet(n, grow, crown, budgetRng(p.seed + 17), p.lod.shell ?? 0.35);
  const leaves = new MeshData();
  // fewer layers of cards: darken slightly so the crown keeps the full model's depth
  const ao = leafAO(opts.aoInner ?? 0.45);
  cards.emit(leaves, crown, opts.bend ?? 0.78, (q, d, nn) => ao(q, d, nn) * 0.87);
  const g = groupOf([
    [bark, barkMat(p.bark, opts.barkSway), 'bark'],
    [leaves, leafMat(p, opts), 'leaves'],
  ]);
  g.userData.tris = bark.tris + leaves.tris;
  return g;
}

function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
}

// Parts of the last full build per species / variant / tier, so the LOD that
// the props layer requests right after reuses the same skeleton and cards.
const partsCache = new Map<string, TreeParts>();

function treeBuilders(name: string, make: (variant: number) => TreeParts): { build: (v: number) => THREE.Group; buildLod: (v: number) => THREE.Group } {
  const key = (v: number) => `${name}:${v}:${natureQuality()}`;
  return {
    build: (v) => {
      const p = make(v);
      const g = fullTree(p);
      partsCache.set(key(v), p);
      return g;
    },
    buildLod: (v) => {
      const k = key(v);
      const p = partsCache.get(k) ?? make(v);
      partsCache.delete(k);
      return lodTree(p);
    },
  };
}

// ---------------------------------------------------------------------------
// Oak — short massive bole, wide spreading tortuous limbs, broad dome

function oakParts(variant: number): TreeParts {
  const seed = 1100 + variant * 7919;
  const rng = new Rng(seed);
  const H = [12.5, 11, 14, 13][variant % 4];
  const r0 = 0.3 + H * 0.007;
  const spec: TreeSpec = {
    levels: [
      { segs: 8, gnarl: 0.05, taper: 0.3, taperPow: 0.8, kids: { count: [8, 10], range: [0.45, 1.0], angle: [1.15, 0.62], lenFrac: [1, 1], length: (t) => H * 0.5 * (1.0 - 0.3 * t) * rng.range(0.9, 1.06), radFrac: 0.62, phyllo: 'spiral', outward: 0.5 } },
      { segs: 5, gnarl: 0.18, taper: 0.28, kids: { perMetre: 1.2, range: [0.25, 1.0], angle: [0.9, 0.6], lenFrac: [0.4, 0.58], radFrac: 0.55, phyllo: 'spiral', outward: 0.3 } },
      { segs: 3, gnarl: 0.22, taper: 0.3, minMeshRadius: 0.03, kids: { perMetre: 2.4, range: [0.15, 1.0], angle: [0.95, 0.6], lenFrac: [0.38, 0.55], radFrac: 0.5, phyllo: 'spiral', outward: 0.2 } },
      { segs: 2, gnarl: 0.2, taper: 0.4, minMeshRadius: 10 },
    ],
    tropism: (level, _p, d, t) => {
      if (level === 1) d.y += 0.05 + 0.04 * t;
      else if (level >= 2) d.y += 0.05;
    },
  };
  const sk = growTree(spec, rng, v3(0, -TRUNK_SINK, 0), leanDir(rng, 0.06), H * 0.5 + TRUNK_SINK, r0);
  const cards = placeLeaves(sk, rng, {
    atlas: atlas('oak'),
    levels: [3],
    perMetre: 2.0,
    range: [0.2, 1],
    tip: 1.4,
    size: [1.45, 1.95],
    aspect: 1,
    orient: 'outward',
    tilt: 0.55,
    tintA: [0.92, 0.95, 0.9],
    tintB: [1.08, 1.04, 0.92],
  });
  placeLeaves(sk, rng, { atlas: atlas('oak'), levels: [2], perMetre: 0.9, range: [0.45, 1], tip: 1, size: [1.4, 1.9], aspect: 1, orient: 'outward', tilt: 0.5, tintA: [0.9, 0.92, 0.88], tintB: [1.0, 1.0, 0.9] }, cards);
  const opts: FinishOpts = {
    barkSway: 0.003,
    trunkMod: flare(0.55, 5, rng.range(0, 6), 0.05),
    aoInner: 0.42,
  };
  return { sk, spec, cards, bark: 'oak', leaf: 'oak', opts, lod: { maxLevel: 1, minRadius: 0.06 }, seed };
}
const OAK = treeBuilders('oak', oakParts);
export const buildOak = OAK.build;
export const buildOakLod = OAK.buildLod;

// ---------------------------------------------------------------------------
// Umbrella thorn acacia — short leaning trunk, ascending leaders, flat top

function acaciaParts(variant: number): TreeParts {
  const seed = 2200 + variant * 7919;
  const rng = new Rng(seed);
  const H = [8.0, 7.0, 9.0, 7.5][variant % 4];
  const trunkLen = rng.range(1.5, 2.5);
  const r0 = rng.range(0.19, 0.25);
  const top = H - 0.8;
  const spec: TreeSpec = {
    levels: [
      { segs: 5, gnarl: 0.07, taper: 0.72, kids: { count: [3, 4], range: [0.82, 1.0], angle: [0.5, 0.8], lenFrac: [1, 1], length: (_t, p) => Math.max(1.5, (top - 1.3 - p.y) * rng.range(1.3, 1.55)), radFrac: 0.78, phyllo: 'spiral', outward: 0.25 } },
      { segs: 6, gnarl: 0.1, taper: 0.35, kids: { perMetre: 1.9, range: [0.3, 1.0], angle: [1.0, 0.75], lenFrac: [1, 1], length: () => rng.range(2.0, 3.4), radFrac: 0.55, phyllo: 'spiral', outward: 0.4 } },
      { segs: 4, gnarl: 0.14, taper: 0.3, minMeshRadius: 0.016, kids: { perMetre: 2.4, range: [0.2, 1.0], angle: [1.05, 0.8], lenFrac: [0.4, 0.6], radFrac: 0.5, phyllo: 'spiral', outward: 0.5 } },
      { segs: 2, gnarl: 0.15, taper: 0.4, minMeshRadius: 10 },
    ],
    tropism: (level, p, d) => {
      if (level === 0) {
        d.y += 0.02;
        return;
      }
      // flat crown: climb freely below the canopy, level out in it, never exceed it
      const target = top - 0.25 * (level - 1);
      const dy = target - p.y;
      if (dy > 1.5) d.y += 0.02;
      else if (dy > 0) d.y = Math.min(d.y, dy * 0.3);
      else d.y = Math.min(d.y, -0.1);
    },
  };
  const sk = growTree(spec, rng, v3(0, -TRUNK_SINK, 0), leanDir(rng, 0.16), trunkLen + TRUNK_SINK, r0);
  const cards = placeLeaves(sk, rng, {
    atlas: atlas('acacia'),
    levels: [2, 3],
    perMetre: 2.4,
    range: [0.25, 1],
    tip: 2,
    size: [1.5, 2.0],
    aspect: 0.95,
    orient: 'up',
    tilt: 0.3,
    tintA: [0.9, 0.92, 0.9],
    tintB: [1.05, 1.03, 0.95],
    minY: top - 2.2,
    sink: 0.2,
  });
  // a thinner outward-facing layer gives the canopy some depth from the side
  placeLeaves(sk, rng, { atlas: atlas('acacia'), levels: [3], perMetre: 0.9, range: [0.4, 1], tip: 0.6, size: [1.0, 1.3], aspect: 1, orient: 'up', tilt: 0.9, tintA: [0.85, 0.88, 0.85], tintB: [1.0, 1.0, 0.92], minY: top - 2.0, sink: 0.4 }, cards);
  const opts: FinishOpts = {
    barkSway: 0.003,
    trunkMod: flare(0.35, 4, rng.range(0, 6), 0.05),
    bend: 0.7,
    aoInner: 0.5,
  };
  // flat canopy: the visible layer is the top, keep cards spread through it
  return { sk, spec, cards, bark: 'acacia', leaf: 'acacia', opts, lod: { maxLevel: 1, minRadius: 0.05, shell: 0.15 }, seed };
}
const ACACIA = treeBuilders('acacia', acaciaParts);
export const buildAcacia = ACACIA.build;
export const buildAcaciaLod = ACACIA.buildLod;

// ---------------------------------------------------------------------------
// Baobab — massive flared bole with vertical fluting that shoulders into
// thick, quickly tapering limbs (the "upside-down tree" crown), sparse leaves

function baobabParts(variant: number): TreeParts {
  const seed = 3300 + variant * 7919;
  const rng = new Rng(seed);
  const H = [12.5, 11, 13.5, 12][variant % 4];
  const trunkLen = H * rng.range(0.5, 0.56);
  const r0 = rng.range(1.2, 1.45);
  const spec: TreeSpec = {
    levels: [
      {
        segs: 10,
        gnarl: 0.01,
        taper: 0.52,
        taperPow: 1.8,
        kids: { count: [6, 8], range: [0.84, 1.0], angle: [1.4, 1.0], lenFrac: [1, 1], length: (t) => rng.range(H * 0.36, H * 0.48) * (1.05 - 0.3 * t), radFrac: 0.5, phyllo: 'spiral', outward: 0.8 },
      },
      { segs: 5, gnarl: 0.14, taper: 0.16, taperPow: 0.55, kids: { perMetre: 1.15, range: [0.3, 1.0], angle: [0.9, 0.6], lenFrac: [0.38, 0.6], radFrac: 0.55, phyllo: 'spiral', outward: 0.5 } },
      { segs: 3, gnarl: 0.24, taper: 0.35, minMeshRadius: 0.028, kids: { perMetre: 1.7, range: [0.3, 1.0], angle: [0.8, 0.6], lenFrac: [0.4, 0.62], radFrac: 0.5, phyllo: 'random' } },
      { segs: 2, gnarl: 0.2, taper: 0.4, minMeshRadius: 10 },
    ],
    tropism: (level, _p, d, t) => {
      // limbs leave the shoulder steeply outward, then turn up like candelabra arms
      if (level === 1) d.y += 0.01 + 0.06 * t * t;
      else if (level >= 2) d.y += 0.04;
    },
  };
  const sk = growTree(spec, rng, v3(0, -TRUNK_SINK, 0), leanDir(rng, 0.03), trunkLen + TRUNK_SINK, r0);
  const phase = rng.range(0, 6);
  const fl = flare(0.26, 6, phase, 0.03, 0.8);
  const fn = new Noise(900 + variant);
  const trunkMod = (ring: number, a: number, p: V3): number => {
    const y = Math.max(0, p.y) / trunkLen;
    // bottle bulge low-middle, pinched just under the shoulder
    const bulge = 1 + 0.09 * Math.sin(Math.PI * Math.min(1, y * 1.2)) - 0.05 * sstep(0.7, 1.0, y);
    // irregular vertical fluting: 4 broad lobes + finer ribs, drifting with height
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const lobes = 1 + 0.075 * Math.pow(Math.abs(Math.cos(2 * a + phase + y * 0.9)), 2.5) + 0.03 * Math.cos(7 * a + phase * 2 + y * 2) + fn.noise3(ca * 1.6, y * 2.2, sa * 1.6) * 0.05;
    return fl(ring, a, p) * bulge * lobes;
  };
  // leaves on twigs plus small tufts on the outer branches (the crown stays airy)
  const cards = placeLeaves(sk, rng, {
    atlas: atlas('baobab'),
    levels: [3],
    perMetre: 1.9,
    range: [0.4, 1],
    tip: 1.4,
    size: [1.05, 1.45],
    aspect: 1,
    orient: 'outward',
    tilt: 0.6,
    tintA: [0.9, 0.94, 0.88],
    tintB: [1.05, 1.04, 0.94],
    skip: 0.18,
  });
  placeLeaves(sk, rng, { atlas: atlas('baobab'), levels: [2], perMetre: 0.5, range: [0.6, 1], tip: 1, size: [1.0, 1.3], aspect: 1, orient: 'outward', tilt: 0.6, tintA: [0.88, 0.92, 0.86], tintB: [1.0, 1.0, 0.92], skip: 0.3 }, cards);
  // bark colour: grey-brown with large coppery / pale grey patches (breaks the tiling)
  const cn = new Noise(950 + variant);
  const tint = (p: V3, b: Branch, out: [number, number, number]): void => {
    const n = cn.fbm3(p.x * 0.35, p.y * 0.3, p.z * 0.35, 3);
    const copper = sstep(-0.15, 0.45, n);
    const pale = sstep(0.25, 0.6, cn.noise3(p.x * 0.8 + 7, p.y * 0.5, p.z * 0.8));
    let r = 0.94 + copper * 0.1 + pale * 0.06;
    let g = 0.94 + copper * 0.0 + pale * 0.07;
    let bl = 0.96 - copper * 0.06 + pale * 0.09;
    // rain streaks / soil splash darken the lower bole
    const low = b.level === 0 ? 1 - 0.22 * (1 - sstep(0.0, 1.6, p.y)) : 1;
    r *= low;
    g *= low;
    bl *= low;
    out[0] = r;
    out[1] = g;
    out[2] = bl;
  };
  const opts: FinishOpts = { barkSway: 0.001, trunkMod, tint, aoInner: 0.55 };
  // limbs are the baobab's silhouette: keep the second branch level in the LOD
  return { sk, spec, cards, bark: 'baobab', leaf: 'baobab', opts, lod: { maxLevel: 2, minRadius: 0.1, frac: 0.3 }, seed };
}
const BAOBAB = treeBuilders('baobab', baobabParts);
export const buildBaobab = BAOBAB.build;
export const buildBaobabLod = BAOBAB.buildLod;

// ---------------------------------------------------------------------------
// Scots pine — tall straight bole, high whorled crown of dense needle pads,
// orange upper bark

function pineParts(variant: number): TreeParts {
  const seed = 4400 + variant * 7919;
  const rng = new Rng(seed);
  // variant 3 grew in the open (parkland / lawn): shorter, crown reaching
  // much lower, few dead stubs; the others are forest-grown with a long bare bole
  const open = variant % 4 === 3;
  const H = [17, 15.5, 19, 13][variant % 4];
  const r0 = 0.19 + H * 0.0055;
  const crownBase = open ? rng.range(0.3, 0.38) : rng.range(0.5, 0.58);
  const whorls = Math.round((H * (0.97 - crownBase)) / 0.62);
  const spec: TreeSpec = {
    levels: [
      {
        segs: 12,
        gnarl: 0.025,
        taper: 0.06,
        taperPow: 0.9,
        kids: {
          count: [whorls * 3, whorls * 3],
          range: [crownBase, 0.97],
          angle: [1.68, 0.9],
          lenFrac: [1, 1],
          length: (t) => {
            const tc = (t - crownBase) / (0.97 - crownBase);
            // mature Scots pine: broad, irregular, flattening top
            return Math.max(0.6, H * 0.23 * (1 - 0.62 * Math.pow(tc, 1.6)) * (0.85 + 0.15 * Math.sin(Math.PI * Math.min(1, tc * 2.2))) * rng.range(0.65, 1.2));
          },
          radFrac: 0.34,
          phyllo: 'whorl',
          whorl: 3,
        },
      },
      { segs: 3, gnarl: 0.14, taper: 0.25, kids: { perMetre: 2.2, range: [0.3, 1.0], angle: [0.85, 0.55], lenFrac: [0.3, 0.5], radFrac: 0.5, phyllo: 'opposite' } },
      { segs: 2, gnarl: 0.14, taper: 0.4, minMeshRadius: 10 },
    ],
    tropism: (level, _p, d, t) => {
      // limbs droop a little then turn up at the tips; shoots point up
      if (level === 1) d.y += -0.02 + 0.09 * t * t;
      else if (level === 2) d.y += 0.14;
      else d.y += 0.03;
    },
  };
  const sk = growTree(spec, rng, v3(0, -TRUNK_SINK, 0), leanDir(rng, 0.03), H * 0.97 + TRUNK_SINK, r0);
  // dead branch stubs on the bare lower bole
  const trunk = sk.branches[0];
  const stubs = open ? 1 + rng.int(0, 2) : 5 + rng.int(0, 4);
  for (let k = 0; k < stubs; k++) {
    const t = rng.range(0.2, crownBase - 0.03);
    const i = Math.floor(t * (trunk.pts.length - 1));
    const p = trunk.pts[i].clone().lerp(trunk.pts[i + 1], t * (trunk.pts.length - 1) - i);
    const a = rng.range(0, Math.PI * 2);
    const d = v3(Math.cos(a), rng.range(-0.35, 0.05), Math.sin(a)).normalize();
    const len = rng.range(0.25, 0.7);
    const r = rng.range(0.018, 0.035);
    sk.branches.push({ level: 9, pts: [p, p.clone().addScaledVector(d, len)], radii: [r, r * 0.6], length: len, parent: trunk, parentT: t });
  }
  // needle pads: dense clumps along the outer half of every limb and shoot,
  // flat-ish ("up") pads on top, outward ones for the sides
  const pa = atlas('pine');
  const cards = placeLeaves(sk, rng, { atlas: pa, levels: [1], perMetre: 2.3, range: [0.45, 1], tip: 3, size: [1.3, 1.75], aspect: 1.0, orient: 'outward', tilt: 0.5, tintA: [0.86, 0.92, 0.9], tintB: [1.02, 1.04, 0.98] });
  placeLeaves(sk, rng, { atlas: pa, levels: [2], perMetre: 2.6, range: [0.2, 1], tip: 2, size: [1.15, 1.55], aspect: 1.0, orient: 'up', tilt: 0.6, tintA: [0.86, 0.92, 0.9], tintB: [1.04, 1.05, 0.98], sink: 0.3 }, cards);
  const orangeFrom = H * (crownBase - 0.12);
  const opts: FinishOpts = {
    barkSway: 0.002,
    trunkMod: flare(0.3, 4, rng.range(0, 6), 0.03),
    aoInner: 0.42,
    bend: 0.72,
    tint: (p, b, out) => {
      const t = b.level === 0 ? sstep(orangeFrom - 2.5, orangeFrom + 1.0, p.y) : 1;
      out[0] = 0.62 + (1.22 - 0.62) * t;
      out[1] = 0.55 + (0.72 - 0.55) * t;
      out[2] = 0.52 + (0.46 - 0.52) * t;
    },
  };
  return { sk, spec, cards, bark: 'pine', leaf: 'pine', opts, lod: { maxLevel: 1, minRadius: 0.04, frac: 0.22 }, seed };
}
const PINE = treeBuilders('pine', pineParts);
export const buildPine = PINE.build;
export const buildPineLod = PINE.buildLod;

// ---------------------------------------------------------------------------
// Silver birch — slender white stem, ascending limbs, pendulous twigs

function birchParts(variant: number): TreeParts {
  const seed = 5500 + variant * 7919;
  const rng = new Rng(seed);
  const H = [12, 10.5, 13, 11][variant % 4];
  const r0 = 0.11 + H * 0.004;
  const cb = 0.3;
  const spec: TreeSpec = {
    levels: [
      {
        segs: 12,
        gnarl: 0.035,
        taper: 0.08,
        kids: {
          perMetre: 2.1,
          range: [cb, 0.96],
          angle: [0.8, 0.45],
          lenFrac: [1, 1],
          length: (t) => {
            const tc = (t - cb) / (0.96 - cb);
            return 0.5 + H * 0.29 * Math.pow(Math.sin(Math.PI * (0.16 + 0.84 * tc)), 0.8) * rng.range(0.8, 1.1);
          },
          radFrac: 0.4,
          phyllo: 'spiral',
          outward: 0.2,
        },
      },
      { segs: 5, gnarl: 0.1, taper: 0.2, kids: { perMetre: 2.4, range: [0.2, 1.0], angle: [0.65, 0.5], lenFrac: [0.4, 0.6], radFrac: 0.45, phyllo: 'spiral' } },
      { segs: 3, gnarl: 0.08, taper: 0.3, minMeshRadius: 10 },
    ],
    tropism: (level, _p, d, t) => {
      if (level === 1) d.y += 0.05 * (1 - t) - 0.11 * t * t;
      else if (level === 2) d.y -= 0.32;
      else d.y += 0.01;
    },
  };
  const sk = growTree(spec, rng, v3(0, -TRUNK_SINK, 0), leanDir(rng, 0.05), H * 0.96 + TRUNK_SINK, r0);
  const cards = placeLeaves(sk, rng, { atlas: atlas('birch'), levels: [2], perMetre: 2.8, range: [0.1, 1], tip: 1.5, size: [0.8, 1.1], aspect: 1.2, orient: 'hang', tilt: 0.3, tintA: [0.92, 0.96, 0.9], tintB: [1.08, 1.05, 0.92], sink: 0.05 });
  placeLeaves(sk, rng, { atlas: atlas('birch'), levels: [1], perMetre: 1.4, range: [0.4, 1], tip: 1, size: [0.8, 1.1], aspect: 1.2, orient: 'hang', tilt: 0.3, tintA: [0.92, 0.96, 0.9], tintB: [1.05, 1.03, 0.92], sink: 0.05 }, cards);
  const bn = new Noise(77 + variant);
  const opts: FinishOpts = {
    barkSway: 0.003,
    trunkMod: flare(0.25, 3, rng.range(0, 6), 0.02),
    aoInner: 0.5,
    tint: (p, b, out) => {
      if (b.level === 0) {
        // black fissured base, patchy above
        const dark = 1 - sstep(0.3, 1.6 + bn.noise3(p.x * 3, p.y, p.z * 3) * 0.5, p.y);
        const k = 1 - dark * 0.72;
        out[0] = k;
        out[1] = k;
        out[2] = k * 0.98;
      } else {
        // thin twigs are dark reddish-brown, older limbs white
        const w = sstep(0.025, 0.06, b.radii[0]);
        out[0] = 0.35 + 0.65 * w;
        out[1] = 0.27 + 0.73 * w;
        out[2] = 0.24 + 0.76 * w;
      }
    },
  };
  return { sk, spec, cards, bark: 'birch', leaf: 'birch', opts, lod: { maxLevel: 1, minRadius: 0.035 }, seed };
}
const BIRCH = treeBuilders('birch', birchParts);
export const buildBirch = BIRCH.build;
export const buildBirchLod = BIRCH.buildLod;


// ---------------------------------------------------------------------------
// Date palm — leaf-base patterned trunk, crown of V-folded feathery fronds

export function buildPalm(variant: number): THREE.Group {
  return palm(variant, false);
}

/** Distant palm: 6-sided trunk, 3-segment fronds (the larger ones), no fruit stalks. */
export function buildPalmLod(variant: number): THREE.Group {
  return palm(variant, true);
}

function palm(variant: number, lod: boolean): THREE.Group {
  const rng = new Rng(6600 + variant * 7919);
  const H = [10, 8.6, 11.2, 9.3][variant % 4];
  const trunkH = H - 2.2;
  const r = rng.range(0.21, 0.25);
  // gently curved trunk
  const leanA = rng.range(0, Math.PI * 2);
  const lean = rng.range(0.03, 0.12);
  const pts: V3[] = [];
  const radii: number[] = [];
  const segs = 14;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const off = lean * trunkH * (t * t * 0.7 + t * 0.3);
    pts.push(v3(Math.cos(leanA) * off, -TRUNK_SINK + t * (trunkH + TRUNK_SINK), Math.sin(leanA) * off));
    const boot = sstep(0.86, 1, t) * 0.45;
    radii.push(r * (1 + 0.35 * Math.exp(-t * 14) + boot - 0.06 * t));
  }
  const bark = new MeshData();
  const circ = Math.PI * 2 * r;
  const tp = lod ? pts.filter((_p, i) => i % 2 === 0 || i === segs) : pts;
  const tr = lod ? radii.filter((_r, i) => i % 2 === 0 || i === segs) : radii;
  addTube(bark, tp, tr, {
    radial: lod ? 6 : Math.round(11 * detail().seg),
    uRepeat: Math.max(2, Math.round(circ / BARK_U)),
    vPerMetre: 1 / BARK_V,
    capEnd: true,
    radiusMod: (_i, a, p) => 1 + bnoise.noise3(Math.cos(a) * 2, p.y * 1.3, Math.sin(a) * 2) * 0.03,
    color: (_i, _a, p, out) => {
      const ao = 0.62 + 0.38 * sstep(-0.1, 0.6, p.y);
      const topDark = 1 - sstep(trunkH - 0.8, trunkH, p.y) * 0.35;
      out[0] = out[1] = out[2] = ao * topDark;
    },
  });
  const crownC = pts[segs].clone();
  const tdir = v3().subVectors(pts[segs], pts[segs - 1]).normalize();
  const fronds = new MeshData();
  const pal = atlas('palm');
  const crown: Ellipsoid = { c: crownC.clone().add(v3(0, 0.3, 0)), r: v3(3.5, 2.2, 3.5) };
  const nFronds = Math.round(26 * Math.min(1.15, detail().cards));
  const up = v3(0, 1, 0);
  const tmp = v3();
  const addFrond = (az: number, elev: number, len: number, dry: boolean, skip = false) => {
    const N = 10;
    const d = v3(Math.cos(elev) * Math.cos(az), Math.sin(elev), Math.cos(elev) * Math.sin(az)).add(tdir.clone().multiplyScalar(0.25)).normalize();
    const p = crownC.clone().addScaledVector(d, 0.2);
    let fp: V3[] = [];
    let tangents: V3[] = [];
    const sl = len / N;
    const droop = dry ? 0.05 : 0.11 + (1 - Math.max(0, Math.sin(elev))) * 0.08;
    for (let i = 0; i <= N; i++) {
      fp.push(p.clone());
      tangents.push(d.clone());
      d.y -= droop * (0.4 + i / N);
      d.normalize();
      p.addScaledVector(d, sl);
    }
    // LOD: the same curve sampled at 4 points
    const keep = lod ? [0, 3, 6, 10] : null;
    if (keep) {
      fp = keep.map((i) => fp[i]);
      tangents = keep.map((i) => tangents[i]);
    }
    const n = fp.length - 1;
    const tOf = (i: number) => (keep ? keep[i] / N : i / N);
    const uv = cellUV(pal, dry ? 1 : 0);
    const um = (uv[0] + uv[2]) / 2;
    for (const s of [-1, 1]) {
      const sides: V3[] = [];
      const nrms: V3[] = [];
      const w: number[] = [];
      for (let i = 0; i <= n; i++) {
        const t = tOf(i);
        const T = tangents[i];
        const S = tmp.crossVectors(T, up);
        if (S.lengthSq() < 1e-4) S.set(1, 0, 0);
        S.normalize();
        const N = v3().crossVectors(S, T).normalize();
        const fold = (dry ? 0.15 : 0.55) * (1 - t * 0.5);
        const half = S.clone().multiplyScalar(s * Math.cos(fold)).addScaledVector(N, Math.sin(fold)).normalize();
        sides.push(half);
        const fn = v3().crossVectors(half, T).normalize();
        if (fn.y < 0) fn.negate();
        const en = ellipsoidNormal(crown, fp[i], v3());
        nrms.push(fn.lerp(en, 0.6).normalize());
        w.push((dry ? 0.32 : 0.5) * Math.pow(Math.sin(Math.PI * (0.06 + 0.94 * t)), 0.6));
      }
      const uvr: [number, number, number, number] = s < 0 ? [um, uv[1], uv[0], uv[3]] : [um, uv[1], uv[2], uv[3]];
      const tint = dry ? 0.8 : rng.range(0.9, 1.08);
      if (skip) continue;
      addRibbon(fronds, fp, w, sides, nrms, uvr, (i, t) => {
        const ao = 0.6 + 0.4 * sstep(0.0, 0.5, t) * (0.7 + 0.3 * nrms[i].y);
        return [tint * ao, tint * ao, tint * ao * 0.96];
      }, true);
    }
  };
  let az = rng.range(0, 6.28);
  for (let k = 0; k < nFronds; k++) {
    az += 2.39996 + rng.range(-0.2, 0.2);
    const tier = k / nFronds; // 0 = youngest (top)
    const elev = 1.25 - tier * 1.55 + rng.range(-0.12, 0.12);
    // LOD: every third frond dropped (the crown stays full at distance)
    addFrond(az, elev, rng.range(3.0, 4.0) * (tier < 0.15 ? 0.8 : 1), false, lod && k % 3 === 0);
  }
  const dead = 4 + rng.int(0, 3);
  for (let k = 0; k < dead; k++) addFrond(rng.range(0, 6.28), rng.range(-1.35, -1.05), rng.range(2.0, 2.8), true, lod && k > 1);
  // fruit stalks: a few drooping orange strands under the crown
  for (let k = 0; k < (lod ? 0 : 3); k++) {
    const a = rng.range(0, 6.28);
    const s0 = crownC.clone().add(v3(Math.cos(a) * 0.25, -0.15, Math.sin(a) * 0.25));
    const s1 = s0.clone().add(v3(Math.cos(a) * 0.5, -0.6, Math.sin(a) * 0.5));
    addTube(bark, [s0, s0.clone().lerp(s1, 0.5).add(v3(0, 0.1, 0)), s1], [0.03, 0.04, 0.05], {
      radial: 5,
      uRepeat: 1,
      vPerMetre: 1,
      capEnd: true,
      color: (_i, _a, _p, out) => {
        out[0] = 1.4;
        out[1] = 0.85;
        out[2] = 0.35;
      },
    });
  }
  const g = groupOf([
    [bark, barkMat('palm', 0.004), 'bark'],
    [fronds, leafMaterial('trees'), 'leaves'],
  ]);
  g.userData.tris = bark.tris + fronds.tris;
  return g;
}

// ---------------------------------------------------------------------------
// Bamboo clump — arching segmented canes with drooping leaf sprays

export function buildBamboo(variant: number): THREE.Group {
  return bamboo(variant, false);
}

/** Distant bamboo: 3-sided canes (3 of 5 kept, 3 segments), ~15 % of the sprays as larger single-row cards. */
export function buildBambooLod(variant: number): THREE.Group {
  return bamboo(variant, true);
}

function bamboo(variant: number, lod: boolean): THREE.Group {
  const rng = new Rng(7700 + variant * 7919);
  const n = [22, 18, 25, 20][variant % 4];
  const H = [7.5, 6.5, 8.6, 7][variant % 4];
  const canes = new MeshData();
  const cards = new CardSet();
  const ba = atlas('bamboo');
  const internode = 0.34;
  const pts: V3[] = [];
  for (let k = 0; k < n; k++) {
    const a = rng.range(0, Math.PI * 2);
    const rr = Math.sqrt(rng.float()) * 0.6;
    const base = v3(Math.cos(a) * rr, -0.2, Math.sin(a) * rr);
    const h = H * rng.range(0.7, 1.05) * (1 - rr * 0.3);
    const outA = Math.atan2(base.z, base.x) + rng.range(-0.4, 0.4);
    const lean = 0.04 + rr * 0.2 + rng.range(0, 0.06);
    const d = v3(Math.cos(outA) * Math.sin(lean), Math.cos(lean), Math.sin(outA) * Math.sin(lean));
    const segs = 7;
    const p = base.clone();
    const cp: V3[] = [];
    const cr: number[] = [];
    const r0 = rng.range(0.028, 0.045) * (H / 7.5);
    const sl = (h + 0.2) / segs;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      cp.push(p.clone());
      cr.push(r0 * (1 - 0.55 * t * t));
      // arch outward under the weight of the leafy top
      d.x += Math.cos(outA) * 0.025 * t;
      d.z += Math.sin(outA) * 0.025 * t;
      d.y -= 0.012 * t;
      d.normalize();
      p.addScaledVector(d, sl);
    }
    const hue = rng.float();
    const keepCane = !lod || k % 5 === 0 || k % 5 === 2 || k % 5 === 3;
    const lp = lod ? [cp[0], cp[2], cp[5], cp[7]] : cp;
    const lr = lod ? [cr[0], cr[2], cr[5], cr[7]] : cr;
    if (keepCane)
    addTube(canes, lp, lr, {
      radial: lod ? 3 : Math.max(4, Math.round(5 * detail().seg)),
      uRepeat: 1,
      vPerMetre: 1 / internode,
      v0: rng.float(),
      capEnd: !lod,
      color: (_i, _a, q, out) => {
        const ao = 0.55 + 0.45 * sstep(-0.1, 1.5, q.y);
        out[0] = (0.95 + hue * 0.2) * ao;
        out[1] = (1.0 - hue * 0.05) * ao;
        out[2] = (0.9 - hue * 0.2) * ao;
      },
    });
    // leaf sprays from the upper canes
    const sprays = Math.round(rng.range(11, 15) * detail().cards);
    for (let s = 0; s < sprays; s++) {
      const t = rng.range(0.38, 1.0);
      const fi = t * segs;
      const i = Math.min(segs - 1, Math.floor(fi));
      const q = cp[i].clone().lerp(cp[i + 1], fi - i);
      pts.push(q);
      const sa = outA + rng.range(-1.6, 1.6);
      const U = v3(Math.cos(sa), rng.range(-0.5, 0.25), Math.sin(sa)).normalize();
      const S = v3().crossVectors(U, v3(0, 1, 0)).normalize();
      const tl = rng.range(-0.6, 0.6);
      const N = v3().crossVectors(S, U);
      S.multiplyScalar(Math.cos(tl)).addScaledVector(N, Math.sin(tl)).normalize();
      const w = rng.range(0.9, 1.25);
      const tint = rng.range(0.9, 1.08);
      cards.add({ base: q.clone().addScaledVector(U, -0.05), up: U, side: S, width: w, height: w, uv: cellUV(ba, rng.int(0, 3)), flip: rng.chance(0.5), color: [tint, tint, tint * 0.95], curl: -0.12, rows: 2 });
    }
  }
  // sheath litter / small shoots at the base
  for (let k = 0; k < (lod ? 0 : 6); k++) {
    const a = rng.range(0, 6.28);
    const rr = rng.range(0.1, 0.6);
    const b = v3(Math.cos(a) * rr, -0.1, Math.sin(a) * rr);
    const h = rng.range(0.3, 0.9);
    addTube(canes, [b, b.clone().add(v3(rng.range(-0.05, 0.05), h, rng.range(-0.05, 0.05)))], [0.03, 0.012], {
      radial: 4,
      uRepeat: 1,
      vPerMetre: 1 / internode,
      capEnd: true,
      color: (_i, _a, _q, out) => {
        out[0] = 0.75;
        out[1] = 0.62;
        out[2] = 0.42;
      },
    });
  }
  const crown = crownOf(cards);
  const leaves = new MeshData();
  if (lod) {
    const n = Math.max(16, cards.length * 0.15);
    cards.lodSet(n, Math.min(2.3, Math.sqrt(cards.length / n) * 0.78), crown, budgetRng(variant + 77), 0.5).emit(leaves, crown, 0.65, leafAO(0.5));
  } else cards.emit(leaves, crown, 0.65, leafAO(0.5));
  const g = groupOf([
    [canes, barkMat('bamboo', 0.012), 'canes'],
    [leaves, leafMaterial('trees'), 'leaves'],
  ]);
  g.userData.tris = canes.tris + leaves.tris;
  return g;
}
