// Tree species: umbrella acacia, baobab, broadleaf oak, Scots pine, silver
// birch (recursive skeletons) plus date palm and bamboo clump (bespoke).
// Each builder returns a Group with ≤ 3 meshes: bark, foliage (+ extras).

import * as THREE from 'three';
import { Noise, Rng } from '../../core/rng';
import { atlas, cellUV } from './atlases';
import { barkMat, BARK_U, BARK_V } from './barks';
import { addRibbon, addTube, CardSet, ellipsoidNormal, type Ellipsoid, groupOf, MeshData, v3, type V3 } from './geo';
import { detail, foliageMaterial } from './mats';
import { sstep } from './tex';
import { crownOf, growTree, leafAO, meshBark, placeLeaves, type Branch, type TreeSpec } from './treegen';

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

function finishTree(sk: { branches: Branch[] }, spec: TreeSpec, cards: CardSet, barkKind: Parameters<typeof barkMat>[0], leafKey: Parameters<typeof atlas>[0], opts: {
  barkSway: number;
  leafSway: number;
  translucency: number;
  trunkMod?: (ring: number, a: number, p: V3) => number;
  tint?: (p: V3, b: Branch, out: [number, number, number]) => void;
  bend?: number;
  aoInner?: number;
  extra?: (bark: MeshData) => void;
}): THREE.Group {
  const crown = crownOf(cards);
  // triangle budget (medium ≈ 4k per tree): thin branch rings first, then cap the cards
  const budget = TREE_TRIS * detail().cards;
  const barkOpts = { spec, crown, trunkMod: opts.trunkMod ? (i: number, a: number, p: V3) => opts.trunkMod!(i, a, p) : undefined, tint: opts.tint };
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
  opts.extra?.(bark);
  cards.thin(Math.max(200, Math.floor((budget - bark.tris) / 2)), budgetRng(bark.tris));
  const leaves = new MeshData();
  cards.emit(leaves, crown, opts.bend ?? 0.78, leafAO(opts.aoInner ?? 0.45));
  const leafMat = foliageMaterial(leafKey, atlas(leafKey).tex, { sway: opts.leafSway, translucency: opts.translucency });
  const g = groupOf([
    [bark, barkMat(barkKind, opts.barkSway), 'bark'],
    [leaves, leafMat, 'leaves'],
  ]);
  g.userData.tris = bark.tris + leaves.tris;
  return g;
}

// ---------------------------------------------------------------------------
// Oak — short massive bole, wide spreading tortuous limbs, broad dome

export function buildOak(variant: number): THREE.Group {
  const rng = new Rng(1100 + variant * 7919);
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
  return finishTree(sk, spec, cards, 'oak', 'oak', {
    barkSway: 0.003,
    leafSway: 0.009,
    translucency: 0.45,
    trunkMod: flare(0.55, 5, rng.range(0, 6), 0.05),
    aoInner: 0.42,
  });
}

// ---------------------------------------------------------------------------
// Umbrella thorn acacia — short leaning trunk, ascending leaders, flat top

export function buildAcacia(variant: number): THREE.Group {
  const rng = new Rng(2200 + variant * 7919);
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
  return finishTree(sk, spec, cards, 'acacia', 'acacia', {
    barkSway: 0.003,
    leafSway: 0.01,
    translucency: 0.4,
    trunkMod: flare(0.35, 4, rng.range(0, 6), 0.05),
    bend: 0.7,
    aoInner: 0.5,
  });
}

// ---------------------------------------------------------------------------
// Baobab — bottle trunk with lobed cross-section, stubby crooked limbs, sparse crown

export function buildBaobab(variant: number): THREE.Group {
  const rng = new Rng(3300 + variant * 7919);
  const H = [12.5, 11, 13.5, 12][variant % 4];
  const trunkLen = H * rng.range(0.56, 0.62);
  const r0 = rng.range(1.25, 1.55);
  const spec: TreeSpec = {
    levels: [
      { segs: 9, gnarl: 0.012, taper: 0.5, taperPow: 3.0, kids: { count: [7, 9], range: [0.74, 1.0], angle: [1.5, 0.95], lenFrac: [1, 1], length: (t) => rng.range(H * 0.3, H * 0.4) * (1.1 - 0.3 * t), radFrac: 0.46, phyllo: 'spiral', outward: 0.7 } },
      { segs: 5, gnarl: 0.2, taper: 0.22, taperPow: 0.7, kids: { perMetre: 1.2, range: [0.3, 1.0], angle: [0.9, 0.6], lenFrac: [0.35, 0.55], radFrac: 0.5, phyllo: 'spiral', outward: 0.45 } },
      { segs: 3, gnarl: 0.24, taper: 0.35, minMeshRadius: 0.03, kids: { perMetre: 1.8, range: [0.3, 1.0], angle: [0.85, 0.6], lenFrac: [0.4, 0.6], radFrac: 0.5, phyllo: 'random' } },
      { segs: 2, gnarl: 0.2, taper: 0.4, minMeshRadius: 10 },
    ],
    tropism: (level, _p, d, t) => {
      if (level === 1) d.y += 0.05 * t;
      else if (level >= 2) d.y += 0.04;
    },
  };
  const sk = growTree(spec, rng, v3(0, -TRUNK_SINK, 0), leanDir(rng, 0.03), trunkLen + TRUNK_SINK, r0);
  const phase = rng.range(0, 6);
  const fl = flare(0.22, 6, phase, 0.035, 0.7);
  const trunkMod = (ring: number, a: number, p: V3): number => {
    const y = Math.max(0, p.y) / trunkLen;
    const bulge = 1 + 0.1 * Math.sin(Math.PI * Math.min(1, y * 1.15));
    const lobes = 1 + 0.085 * Math.pow(Math.abs(Math.cos(3.5 * a + phase + y * 1.2)), 3) + 0.03 * Math.cos(11 * a + phase * 2);
    return fl(ring, a, p) * bulge * lobes;
  };
  const cards = placeLeaves(sk, rng, {
    atlas: atlas('baobab'),
    levels: [3],
    perMetre: 1.8,
    range: [0.45, 1],
    tip: 1.4,
    size: [1.0, 1.4],
    aspect: 1,
    orient: 'outward',
    tilt: 0.6,
    tintA: [0.92, 0.95, 0.9],
    tintB: [1.06, 1.04, 0.95],
    skip: 0.2,
  });
  return finishTree(sk, spec, cards, 'baobab', 'baobab', { barkSway: 0.001, leafSway: 0.009, translucency: 0.45, trunkMod, aoInner: 0.55 });
}

// ---------------------------------------------------------------------------
// Scots pine — tall straight bole, high whorled crown, orange upper bark

export function buildPine(variant: number): THREE.Group {
  const rng = new Rng(4400 + variant * 7919);
  const H = [17, 15.5, 19, 16.5][variant % 4];
  const r0 = 0.19 + H * 0.0055;
  const crownBase = rng.range(0.48, 0.56);
  const whorls = Math.round((H * (0.97 - crownBase)) / 0.6);
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
          angle: [1.62, 0.85],
          lenFrac: [1, 1],
          length: (t) => {
            const tc = (t - crownBase) / (0.97 - crownBase);
            return Math.max(0.5, H * 0.24 * (1 - 0.8 * Math.pow(tc, 1.4)) * (0.85 + 0.15 * Math.sin(Math.PI * Math.min(1, tc * 2.2))) * rng.range(0.7, 1.15));
          },
          radFrac: 0.32,
          phyllo: 'whorl',
          whorl: 3,
        },
      },
      { segs: 4, gnarl: 0.12, taper: 0.25, kids: { perMetre: 2.4, range: [0.25, 1.0], angle: [0.8, 0.55], lenFrac: [0.35, 0.55], radFrac: 0.5, phyllo: 'opposite' } },
      { segs: 2, gnarl: 0.14, taper: 0.4, minMeshRadius: 10 },
    ],
    tropism: (level, _p, d, t) => {
      if (level === 1) d.y += 0.03 + 0.07 * t;
      else if (level === 2) d.y += 0.12;
      else d.y += 0.03;
    },
  };
  const sk = growTree(spec, rng, v3(0, -TRUNK_SINK, 0), leanDir(rng, 0.03), H * 0.97 + TRUNK_SINK, r0);
  // dead branch stubs on the bare lower bole
  const trunk = sk.branches[0];
  const stubs = 5 + rng.int(0, 4);
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
  const cards = placeLeaves(sk, rng, { atlas: atlas('pine'), levels: [1], perMetre: 2.0, range: [0.4, 1], tip: 2, size: [0.95, 1.3], aspect: 1.0, orient: 'outward', tilt: 0.6, tintA: [0.9, 0.95, 0.92], tintB: [1.05, 1.05, 0.98] });
  placeLeaves(sk, rng, { atlas: atlas('pine'), levels: [2], perMetre: 2.0, range: [0.2, 1], tip: 1, size: [0.9, 1.25], aspect: 1.0, orient: 'up', tilt: 0.75, tintA: [0.9, 0.95, 0.92], tintB: [1.05, 1.05, 0.98] }, cards);
  const orangeFrom = H * (crownBase - 0.12);
  return finishTree(sk, spec, cards, 'pine', 'pine', {
    barkSway: 0.002,
    leafSway: 0.007,
    translucency: 0.3,
    trunkMod: flare(0.3, 4, rng.range(0, 6), 0.03),
    aoInner: 0.5,
    tint: (p, b, out) => {
      const t = b.level === 0 ? sstep(orangeFrom - 2.5, orangeFrom + 1.0, p.y) : 1;
      out[0] = 0.62 + (1.28 - 0.62) * t;
      out[1] = 0.55 + (0.74 - 0.55) * t;
      out[2] = 0.52 + (0.46 - 0.52) * t;
    },
  });
}

// ---------------------------------------------------------------------------
// Silver birch — slender white stem, ascending limbs, pendulous twigs

export function buildBirch(variant: number): THREE.Group {
  const rng = new Rng(5500 + variant * 7919);
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
  return finishTree(sk, spec, cards, 'birch', 'birch', {
    barkSway: 0.003,
    leafSway: 0.012,
    translucency: 0.55,
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
  });
}

// ---------------------------------------------------------------------------
// Date palm — leaf-base patterned trunk, crown of V-folded feathery fronds

export function buildPalm(variant: number): THREE.Group {
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
  addTube(bark, pts, radii, {
    radial: Math.round(11 * detail().seg),
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
  const addFrond = (az: number, elev: number, len: number, dry: boolean) => {
    const n = 10;
    const d = v3(Math.cos(elev) * Math.cos(az), Math.sin(elev), Math.cos(elev) * Math.sin(az)).add(tdir.clone().multiplyScalar(0.25)).normalize();
    const p = crownC.clone().addScaledVector(d, 0.2);
    const fp: V3[] = [];
    const tangents: V3[] = [];
    const sl = len / n;
    const droop = dry ? 0.05 : 0.11 + (1 - Math.max(0, Math.sin(elev))) * 0.08;
    for (let i = 0; i <= n; i++) {
      fp.push(p.clone());
      tangents.push(d.clone());
      d.y -= droop * (0.4 + i / n);
      d.normalize();
      p.addScaledVector(d, sl);
    }
    const uv = cellUV(pal, dry ? 1 : 0);
    const um = (uv[0] + uv[2]) / 2;
    for (const s of [-1, 1]) {
      const sides: V3[] = [];
      const nrms: V3[] = [];
      const w: number[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
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
    addFrond(az, elev, rng.range(3.0, 4.0) * (tier < 0.15 ? 0.8 : 1), false);
  }
  const dead = 4 + rng.int(0, 3);
  for (let k = 0; k < dead; k++) addFrond(rng.range(0, 6.28), rng.range(-1.35, -1.05), rng.range(2.0, 2.8), true);
  // fruit stalks: a few drooping orange strands under the crown
  for (let k = 0; k < 3; k++) {
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
  const leafMat = foliageMaterial('palm', pal.tex, { sway: 0.016, translucency: 0.5, roughness: 0.8 });
  const g = groupOf([
    [bark, barkMat('palm', 0.004), 'bark'],
    [fronds, leafMat, 'leaves'],
  ]);
  g.userData.tris = bark.tris + fronds.tris;
  return g;
}

// ---------------------------------------------------------------------------
// Bamboo clump — arching segmented canes with drooping leaf sprays

export function buildBamboo(variant: number): THREE.Group {
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
    addTube(canes, cp, cr, {
      radial: Math.max(4, Math.round(5 * detail().seg)),
      uRepeat: 1,
      vPerMetre: 1 / internode,
      v0: rng.float(),
      capEnd: true,
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
  for (let k = 0; k < 6; k++) {
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
  cards.emit(leaves, crown, 0.65, leafAO(0.5));
  const g = groupOf([
    [canes, barkMat('bamboo', 0.012), 'canes'],
    [leaves, foliageMaterial('bamboo', ba.tex, { sway: 0.016, translucency: 0.55, roughness: 0.6 }), 'leaves'],
  ]);
  g.userData.tris = canes.tris + leaves.tris;
  return g;
}
