// Plants: thorn bush, fern thicket, tall grass tussocks, reed / cattail bed,
// columnar cactus, flower bed and clipped box hedge.

import * as THREE from 'three';
import { Noise, Rng } from '../../core/rng';
import { atlas, cellUV, hedgeTextures, leafMaterial, soilTextures } from './atlases';
import { barkMat } from './barks';
import { addCrownFade, addRibbon, addTube, CardSet, type Ellipsoid, ellipsoidNormal, groupOf, MeshData, v3, type V3 } from './geo';
import { barkMaterial, cachedMaterial, detail, natureQuality } from './mats';
import { graniteMaterial } from './rocks';
import { sstep } from './tex';
import { crownOf, growTree, leafAO, meshBark, placeLeaves, type TreeSpec } from './treegen';

const UP = v3(0, 1, 0);

/** Plain vertex-coloured material for small stems / seed heads. */
function stemMaterial(sway: number): THREE.MeshStandardMaterial {
  return cachedMaterial(`stem:${sway}`, () => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    m.userData.sway = sway;
    m.userData.foliage = true;
    return m;
  });
}

// ---------------------------------------------------------------------------
// Thorn bush — multi-stemmed, flat-topped dry-country shrub

export function buildThornBush(variant: number): THREE.Group {
  return thornBush(variant, false);
}

/** Distant thorn bush: main stems only (3-sided), a quarter of the cards, larger. */
export function buildThornBushLod(variant: number): THREE.Group {
  return thornBush(variant, true);
}

function thornBush(variant: number, lod: boolean): THREE.Group {
  const rng = new Rng(12100 + variant * 7919);
  const H = [1.8, 1.5, 2.0, 1.65][variant % 4];
  const spec: TreeSpec = {
    levels: [
      { segs: 4, gnarl: 0.16, taper: 0.45, kids: { perMetre: 3.6, range: [0.3, 1.0], angle: [0.9, 0.6], lenFrac: [0.4, 0.55], radFrac: 0.6, phyllo: 'spiral', outward: 0.5 } },
      { segs: 3, gnarl: 0.2, taper: 0.4, minMeshRadius: 0.012, kids: { perMetre: 4, range: [0.2, 1.0], angle: [1.0, 0.7], lenFrac: [0.35, 0.55], radFrac: 0.5, phyllo: 'spiral' } },
      { segs: 2, gnarl: 0.2, taper: 0.4, minMeshRadius: 10 },
    ],
    tropism: (level, p, d) => {
      // dense flat-ish top: branches level out near the top height
      if (p.y > H * 0.8) d.y = Math.min(d.y, 0.1);
      else if (level > 0) d.y += 0.04;
    },
  };
  const stems = 5 + rng.int(0, 3);
  const sk = { branches: [] as ReturnType<typeof growTree>['branches'] };
  for (let k = 0; k < stems; k++) {
    const a = (k / stems) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const lean = rng.range(0.3, 0.7);
    const d = v3(Math.cos(a) * Math.sin(lean), Math.cos(lean), Math.sin(a) * Math.sin(lean));
    const s = growTree(spec, rng, v3(Math.cos(a) * 0.08, -0.1, Math.sin(a) * 0.08), d, (H / Math.cos(lean)) * rng.range(0.5, 0.65), rng.range(0.025, 0.04));
    sk.branches.push(...s.branches);
  }
  const cards = placeLeaves(sk, rng, {
    atlas: atlas('acacia'),
    levels: [1, 2],
    perMetre: 3.2,
    range: [0.2, 1],
    tip: 1.2,
    size: [0.55, 0.8],
    aspect: 1,
    orient: 'outward',
    tilt: 0.7,
    // dusty grey-green (the acacia sprites × 0xd8dccb in linear terms)
    tintA: [0.58, 0.62, 0.48],
    tintB: [0.69, 0.7, 0.53],
    minY: 0.25,
  });
  const crown = crownOf(cards);
  const bark = new MeshData();
  if (lod) meshBark(sk, bark, { spec, crown, maxLevel: 0, radialMul: 0.6, thinFrom: 0, noCaps: true });
  else meshBark(sk, bark, { spec, crown });
  const leaves = new MeshData();
  const n = cards.length;
  const lodCards = (k: number) => cards.lodSet(Math.max(12, n * k), Math.min(2, Math.sqrt(1 / k) * 0.8), crown, () => rng.float(), 0.5);
  (lod ? lodCards(0.25) : cards).emit(leaves, crown, 0.75, leafAO(0.45));
  const g = groupOf([
    // tree acacia bark / shared tree foliage: no extra batches for bushes
    [bark, barkMat('acacia', 0.003, true, true), 'bark'],
    [leaves, leafMaterial('trees'), 'leaves'],
  ]);
  addCrownFade(g, crown);
  g.userData.tris = bark.tris + leaves.tris;
  return g;
}

// ---------------------------------------------------------------------------
// Fern thicket — rosettes of arching pinnate fronds

export function buildFern(variant: number): THREE.Group {
  const rng = new Rng(12200 + variant * 7919);
  const md = new MeshData();
  const fa = atlas('fern');
  const plants = 2 + (variant % 2);
  const centres: V3[] = [];
  for (let k = 0; k < plants; k++) {
    const a = (k / plants) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const r = plants === 1 ? 0 : rng.range(0.25, 0.45);
    centres.push(v3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }
  const dome: Ellipsoid = { c: v3(0, 0.1, 0), r: v3(1.1, 0.8, 1.1) };
  const nrm: V3[] = [];
  const sides: V3[] = [];
  for (const c of centres) {
    const fronds = Math.round(rng.range(12, 16) * Math.min(1.2, detail().cards));
    const size = rng.range(0.95, 1.3);
    const cell = rng.int(0, 1);
    let az = rng.range(0, 6.28);
    for (let f = 0; f < fronds; f++) {
      az += 2.39996 + rng.range(-0.25, 0.25);
      const elev = rng.range(0.95, 1.38);
      const len = size * rng.range(0.75, 1.05);
      // frond segments: 8 high, 6 medium, 5 low
      const n = natureQuality() === 'high' ? 8 : natureQuality() === 'medium' ? 6 : 5;
      const d = v3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
      const p = c.clone().add(v3(0, 0.03, 0));
      const pts: V3[] = [];
      const w: number[] = [];
      nrm.length = 0;
      sides.length = 0;
      const roll = rng.range(-0.35, 0.35);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        pts.push(p.clone());
        const S = v3().crossVectors(d, UP);
        if (S.lengthSq() < 1e-4) S.set(1, 0, 0);
        S.normalize();
        const N = v3().crossVectors(S, d).normalize();
        S.multiplyScalar(Math.cos(roll)).addScaledVector(N, Math.sin(roll)).normalize();
        sides.push(S);
        const fn = v3().crossVectors(S, d).normalize();
        if (fn.y < 0) fn.negate();
        nrm.push(fn.lerp(ellipsoidNormal(dome, p, v3()), 0.55).normalize());
        w.push(0.135 * len);
        // arching under its own weight
        d.y -= (0.12 + t * 0.22) * (len / n) * 1.9;
        d.normalize();
        p.addScaledVector(d, len / n);
      }
      const tint = rng.range(0.88, 1.08);
      addRibbon(md, pts, w, sides, nrm.slice(), cellUV(fa, cell), (i, t) => {
        const ao = 0.55 + 0.45 * sstep(0, 0.6, t) * (0.6 + 0.4 * sstep(0, 0.5, pts[i].y));
        return [tint * ao, tint * ao, tint * ao * 0.95];
      });
    }
  }
  const g = groupOf([[md, leafMaterial('ground'), 'fronds']]);
  g.userData.tris = md.tris;
  return g;
}

// ---------------------------------------------------------------------------
// Tall grass — fountain tussocks of curved cards (golden savanna / green)

export function buildTallGrass(variant: number): THREE.Group {
  const rng = new Rng(12300 + variant * 7919);
  const ga = atlas('grass');
  const cards = new CardSet();
  const tussocks = 5 + rng.int(0, 2);
  const golden = variant !== 2;
  for (let k = 0; k < tussocks; k++) {
    const a = rng.range(0, 6.28);
    const r = Math.sqrt(rng.float()) * 0.7;
    const c = v3(Math.cos(a) * r, -0.03, Math.sin(a) * r);
    const h = rng.range(0.9, 1.3);
    const n = Math.round(rng.range(8, 11) * Math.min(1.2, detail().cards));
    const cell = golden ? (variant === 3 && rng.chance(0.35) ? 1 : 0) : 1;
    for (let q = 0; q < n; q++) {
      const az = (q / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const out = v3(Math.cos(az), 0, Math.sin(az));
      const lean = rng.range(0.08, 0.32);
      const U = out.clone().multiplyScalar(Math.sin(lean)).addScaledVector(UP, Math.cos(lean)).normalize();
      // half the cards tangential (curl outward), half radial (flat fan)
      const tangential = q % 2 === 0;
      const S = tangential ? v3(-out.z, 0, out.x) : out.clone();
      S.addScaledVector(U, -S.dot(U)).normalize();
      const w = rng.range(0.55, 0.85);
      const tint = rng.range(0.9, 1.08);
      cards.add({
        base: c.clone().addScaledVector(out, 0.04),
        up: U,
        side: S,
        width: w,
        height: h,
        uv: cellUV(ga, cell),
        flip: rng.chance(0.5),
        color: [tint, tint, tint],
        curl: tangential ? 0.22 : 0,
        rows: 3,
      });
    }
  }
  const crown: Ellipsoid = { c: v3(0, 0.0, 0), r: v3(1.2, 1.3, 1.2) };
  const md = new MeshData();
  cards.emit(md, crown, 0.55, (p) => 0.55 + 0.45 * sstep(0.0, 0.7, p.y));
  const g = groupOf([[md, leafMaterial('ground'), 'grass']]);
  g.userData.tris = md.tris;
  return g;
}

// ---------------------------------------------------------------------------
// Reed bed — strap-leaved clumps with cattail spikes

export function buildReeds(variant: number): THREE.Group {
  const rng = new Rng(12400 + variant * 7919);
  const ra = atlas('reed');
  const cards = new CardSet();
  const stems = new MeshData();
  const clumps = 6 + rng.int(0, 3);
  for (let k = 0; k < clumps; k++) {
    const a = rng.range(0, 6.28);
    const r = Math.sqrt(rng.float()) * 0.75;
    const c = v3(Math.cos(a) * r, -0.05, Math.sin(a) * r);
    const h = rng.range(1.5, 2.3);
    const n = Math.round(rng.range(5, 7) * Math.min(1.2, detail().cards));
    for (let q = 0; q < n; q++) {
      const az = (q / n) * Math.PI + rng.range(-0.4, 0.4);
      const S = v3(Math.cos(az), 0, Math.sin(az));
      const lean = rng.range(-0.12, 0.12);
      const U = v3(-S.z * lean, 1, S.x * lean).normalize();
      const w = rng.range(0.5, 0.75);
      const tint = rng.range(0.9, 1.08);
      cards.add({ base: c.clone(), up: U, side: S, width: w, height: h, uv: cellUV(ra, rng.int(0, 1)), flip: rng.chance(0.5), color: [tint, tint, tint], curl: rng.range(-0.15, 0.15), rows: 3 });
    }
    // cattail spikes
    const spikes = rng.int(0, 2);
    for (let s = 0; s < spikes; s++) {
      const b = c.clone().add(v3(rng.range(-0.1, 0.1), 0, rng.range(-0.1, 0.1)));
      const top = rng.range(1.7, 2.4);
      const lean = v3(rng.range(-0.08, 0.08), 1, rng.range(-0.08, 0.08)).normalize();
      const p1 = b.clone().addScaledVector(lean, top * 0.5);
      const p2 = b.clone().addScaledVector(lean, top - 0.32);
      const green = (_i: number, _a: number, q: V3, out: [number, number, number]) => {
        const ao = 0.6 + 0.4 * sstep(0, 1, q.y);
        out[0] = 0.32 * ao;
        out[1] = 0.4 * ao;
        out[2] = 0.16 * ao;
      };
      addTube(stems, [b, p1, p2], [0.009, 0.007, 0.006], { radial: 3, uRepeat: 1, vPerMetre: 1, color: green });
      // velvety brown head + thin tip spike
      const h0 = p2.clone();
      const h1 = p2.clone().addScaledVector(lean, 0.26);
      addTube(stems, [h0, h0.clone().addScaledVector(lean, 0.02), h1.clone().addScaledVector(lean, -0.02), h1], [0.012, 0.026, 0.026, 0.014], {
        radial: 6,
        uRepeat: 1,
        vPerMetre: 1,
        capEnd: true,
        color: (_i, _a, _q, out) => {
          out[0] = 0.24;
          out[1] = 0.14;
          out[2] = 0.07;
        },
      });
      addTube(stems, [h1, h1.clone().addScaledVector(lean, 0.16)], [0.004, 0.002], { radial: 3, uRepeat: 1, vPerMetre: 1, color: green });
    }
  }
  const crown: Ellipsoid = { c: v3(0, 0.3, 0), r: v3(1.2, 2.0, 1.2) };
  const md = new MeshData();
  cards.emit(md, crown, 0.45, (p) => 0.5 + 0.5 * sstep(0.0, 1.2, p.y));
  const g = groupOf([
    [md, leafMaterial('ground'), 'reeds'],
    [stems, stemMaterial(0.04), 'stems'],
  ]);
  g.userData.tris = md.tris + stems.tris;
  return g;
}

// ---------------------------------------------------------------------------
// Columnar cactus — ribbed stems with areoles & spines (saguaro / organ pipe)

function cactusStem(md: MeshData, path0: V3[], R: number, ribs: number, noise: Noise, lod = false): void {
  // densify the last stretch so the crown is a rounded dome, not a cone
  const path = path0.slice(0, -1);
  const a = path0[path0.length - 2];
  const b = path0[path0.length - 1];
  const dir = v3().subVectors(b, a);
  const segLen = dir.length();
  dir.normalize();
  const domeLen = Math.min(R * 1.1, segLen * 0.9);
  const flatEnd = b.clone().addScaledVector(dir, -domeLen);
  path.push(flatEnd);
  const radii = path.map((_p, i) => R * (1 - 0.05 * (i / path.length)));
  const k = lod ? 2 : 3;
  for (let i = 1; i <= k; i++) {
    const t = i / k;
    const ang = t * Math.PI * 0.5 * 0.92;
    path.push(flatEnd.clone().addScaledVector(dir, Math.sin(ang) * domeLen));
    radii.push(R * 0.95 * Math.cos(ang));
  }
  // crest + groove per rib; the low tier has fewer ribs
  const nr = Math.max(6, Math.round(ribs * Math.min(1, detail().seg + 0.1)));
  const radial = lod ? Math.max(5, Math.round(ribs * 0.6)) : nr * 2;
  addTube(md, path, radii, {
    radial,
    uRepeat: nr,
    vPerMetre: 1 / 0.05,
    capEnd: true,
    radiusMod: lod ? () => 0.93 : (_i, ang, p) => {
      // crest on odd vertices (u = k + 0.5), groove on even
      const ph = (ang / (Math.PI * 2)) * nr;
      const f = ph - Math.floor(ph);
      const crest = 1 - Math.abs(f - 0.5) * 2;
      return 0.86 + 0.14 * crest + noise.noise3(p.x * 3, p.y * 3, p.z * 3) * 0.015;
    },
    color: (_i, _a, p, out) => {
      const ao = 0.62 + 0.38 * sstep(-0.05, 0.5, p.y);
      out[0] = out[1] = out[2] = ao;
    },
  });
}

function bentPath(base: V3, segments: [V3, number][]): V3[] {
  // segments: [direction, length] with intermediate points every ~0.65 m
  // (straight runs need no rings; bends get one per segment)
  const out: V3[] = [base.clone()];
  const p = base.clone();
  for (const [d, len] of segments) {
    const n = Math.max(1, Math.round(len / 0.65));
    for (let i = 0; i < n; i++) {
      p.addScaledVector(d, len / n);
      out.push(p.clone());
    }
  }
  return out;
}

export function buildCactus(variant: number): THREE.Group {
  return cactus(variant, false);
}

/** Distant cactus: smooth 5–7-sided stems, short domes. */
export function buildCactusLod(variant: number): THREE.Group {
  return cactus(variant, true);
}

function cactus(variant: number, lod: boolean): THREE.Group {
  const rng = new Rng(12500 + variant * 7919);
  const noise = new Noise(77 + variant);
  const md = new MeshData();
  const v = variant % 4;
  if (v === 2) {
    // organ pipe: many stems from a common base
    const n = 5 + rng.int(0, 2);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const r = rng.range(0.08, 0.28);
      const base = v3(Math.cos(a) * r, -0.15, Math.sin(a) * r);
      const out = v3(Math.cos(a), 0, Math.sin(a));
      const h = rng.range(1.6, 3.0);
      const curve = rng.range(0.15, 0.4);
      cactusStem(md, bentPath(base, [[out.clone().multiplyScalar(curve).add(UP).normalize(), 0.5], [out.clone().multiplyScalar(0.08).add(UP).normalize(), h]]), rng.range(0.075, 0.1), 7, noise, lod);
    }
  } else {
    // saguaro: main column, 0–3 arms that elbow out then turn up
    const H = [3.6, 3.0, 0, 2.4][v] * rng.range(0.92, 1.08);
    const R = [0.22, 0.2, 0, 0.18][v];
    const lean = v3(rng.range(-0.04, 0.04), 1, rng.range(-0.04, 0.04)).normalize();
    const main = bentPath(v3(0, -0.2, 0), [[lean, H + 0.2]]);
    cactusStem(md, main, R, 10, noise, lod);
    const arms = [2, 1, 0, 0][v] + (v === 0 ? rng.int(0, 1) : 0);
    let az = rng.range(0, 6.28);
    for (let k = 0; k < arms; k++) {
      az += Math.PI * rng.range(0.6, 1.2);
      const out = v3(Math.cos(az), 0, Math.sin(az));
      const y0 = rng.range(H * 0.38, H * 0.58);
      const base = v3(0, y0, 0).addScaledVector(out, R * 0.3);
      const reach = rng.range(0.3, 0.45);
      const rise = rng.range(0.8, Math.min(1.7, H - y0 - 0.1));
      cactusStem(
        md,
        bentPath(base, [
          [out.clone().add(v3(0, 0.2, 0)).normalize(), reach],
          [out.clone().add(v3(0, 1.0, 0)).normalize(), 0.12],
          [out.clone().multiplyScalar(0.35).add(UP).normalize(), 0.14],
          [UP.clone().addScaledVector(out, 0.04).normalize(), rise],
        ]),
        R * rng.range(0.62, 0.75),
        8,
        noise,
        lod,
      );
    }
    if (v === 3) {
      // a young column beside the older one
      cactusStem(md, bentPath(v3(0.55, -0.15, 0.3), [[v3(0.05, 1, 0).normalize(), 1.1]]), 0.15, 8, noise, lod);
    }
  }
  const g = groupOf([[md, barkMat('cactus', 0), 'cactus']]);
  g.userData.tris = md.tris;
  return g;
}

// ---------------------------------------------------------------------------
// Flower bed — stone-kerbed raised bed of soil with blocks of bedding plants

export function buildFlowerBed(variant: number): THREE.Group {
  const rng = new Rng(12600 + variant * 7919);
  const half = 0.86;
  const kerbW = 0.09;
  const kerbH = 0.13;
  const corner = 0.18;
  // rounded-rectangle outline
  const outline = (inset: number, steps = 5): [number, number][] => {
    const pts: [number, number][] = [];
    const h = half - inset;
    const cr = Math.max(0.02, corner - inset);
    const cs: [number, number, number][] = [
      [h - cr, h - cr, 0],
      [-(h - cr), h - cr, Math.PI / 2],
      [-(h - cr), -(h - cr), Math.PI],
      [h - cr, -(h - cr), Math.PI * 1.5],
    ];
    for (const [cx, cz, a0] of cs)
      for (let i = 0; i <= steps; i++) {
        const a = a0 + (i / steps) * (Math.PI / 2);
        pts.push([cx + Math.cos(a) * cr, cz + Math.sin(a) * cr]);
      }
    return pts;
  };
  // kerb: extruded ring (outer wall, top, inner wall)
  const kerb = new MeshData();
  const outer = outline(0);
  const inner = outline(kerbW);
  const n = outer.length;
  const rows: { pts: [number, number][]; y: number }[] = [
    { pts: outer, y: -0.08 },
    { pts: outer, y: kerbH - 0.015 },
    { pts: outline(0.012), y: kerbH },
    { pts: outline(kerbW - 0.012), y: kerbH },
    { pts: inner, y: kerbH - 0.015 },
    { pts: inner, y: 0.0 },
  ];
  const kn = new Noise(900 + variant);
  for (const r of rows)
    for (let i = 0; i < n; i++) {
      const [x, z] = r.pts[i];
      // individual kerb stones: slight height steps every ~0.3 m
      const seg = Math.floor((Math.atan2(z, x) + Math.PI) / 0.32);
      const dy = r.y > 0.05 ? (kn.noise2(seg * 7.3, 1) * 0.008) : 0;
      kerb.vert(x, r.y + dy, z, 0, 1, 0, 0, 0, 0.62, 0.6, 0.57, 0);
    }
  for (let r = 0; r < rows.length - 1; r++)
    for (let i = 0; i < n; i++) {
      const a = r * n + i;
      const b = r * n + ((i + 1) % n);
      const c = (r + 1) * n + ((i + 1) % n);
      const d = (r + 1) * n + i;
      kerb.quad(a, d, c, b);
    }
  kerb.useExtra = true;
  const kg = kerb.build();
  kg.computeVertexNormals();
  // soil: slightly mounded grid inside the kerb
  const soil = new MeshData();
  const sh = half - kerbW + 0.01;
  const G = 8;
  const sn = new Noise(950 + variant);
  for (let j = 0; j <= G; j++)
    for (let i = 0; i <= G; i++) {
      const x = -sh + (2 * sh * i) / G;
      const z = -sh + (2 * sh * j) / G;
      const edge = Math.min(sh - Math.abs(x), sh - Math.abs(z));
      const y = 0.05 + 0.05 * sstep(0, 0.4, edge) + sn.noise2(x * 4, z * 4) * 0.01;
      const ao = 0.7 + 0.3 * sstep(0, 0.2, edge);
      soil.vert(x, y, z, 0, 1, 0, x / 0.8, z / 0.8, ao, ao, ao);
    }
  for (let j = 0; j < G; j++)
    for (let i = 0; i < G; i++) {
      const a = j * (G + 1) + i;
      soil.quad(a, a + G + 1, a + G + 2, a + 1);
    }
  const sg = soil.build();
  sg.computeVertexNormals();
  // bedding plants on a jittered grid; colour blocks by variant
  const fa = atlas('flowers');
  const cards = new CardSet();
  const N = 5;
  const pat = variant % 4;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N - 0.5;
      const w = (j + 0.5) / N - 0.5;
      const x = u * 2 * (sh - 0.12) + rng.range(-0.05, 0.05);
      const z = w * 2 * (sh - 0.12) + rng.range(-0.05, 0.05);
      const border = i === 0 || j === 0 || i === N - 1 || j === N - 1;
      let cell: number;
      if (pat === 0) cell = border ? 1 : 0;
      else if (pat === 1) cell = border ? 3 : 2;
      else if (pat === 2) cell = j < 2 ? 2 : j < 3 ? 3 : 0;
      else cell = (i + j) % 2 === 0 ? 0 : 3;
      const s = rng.range(0.34, 0.44) * (cell === 2 ? 1.15 : 1);
      const yaw = rng.range(0, Math.PI);
      for (let c = 0; c < 2; c++) {
        const a = yaw + c * (Math.PI / 2);
        const S = v3(Math.cos(a), 0, Math.sin(a));
        const tint = rng.range(0.92, 1.06);
        cards.add({ base: v3(x, 0.07, z), up: UP.clone(), side: S, width: s, height: s, uv: cellUV(fa, cell), flip: rng.chance(0.5), color: [tint, tint, tint] });
      }
    }
  const flowers = new MeshData();
  const dome: Ellipsoid = { c: v3(0, -0.2, 0), r: v3(1, 0.7, 1) };
  cards.emit(flowers, dome, 0.6, (p) => 0.6 + 0.4 * sstep(0.08, 0.35, p.y));
  const st = soilTextures();
  const g = new THREE.Group();
  const km = new THREE.Mesh(kg, graniteMaterial());
  km.name = 'kerb';
  const sm = new THREE.Mesh(sg, barkMaterial('soil', st.map, st.normal, { roughness: 0.95, fade: false }));
  sm.name = 'soil';
  g.add(km, sm);
  const fm = new THREE.Mesh(flowers.build(), leafMaterial('ground'));
  fm.name = 'flowers';
  g.add(fm);
  g.userData.tris = kerb.tris + soil.tris + flowers.tris;
  return g;
}

// ---------------------------------------------------------------------------
// Clipped box hedge — a 2 m run that joins seamlessly with its neighbours

export function buildHedge(variant: number): THREE.Group {
  const noise = new Noise(1300 + variant);
  const L = 2.0;
  const H = [1.05, 0.95, 1.15, 1.0][variant % 4];
  const D = 0.78;
  const md = new MeshData();
  // cross-section (y, z) loop: bottom-front → top → bottom-back, slightly battered sides
  const sec: [number, number][] = [];
  const top = H;
  const rr = 0.16;
  const halfB = D / 2;
  const halfT = D / 2 - 0.05;
  const steps = 4;
  sec.push([-0.05, halfB]);
  sec.push([H * 0.35, halfB - 0.015]);
  sec.push([H * 0.7, halfT + 0.02]);
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    sec.push([top - rr + Math.sin(a) * rr, halfT - rr + Math.cos(a) * rr]);
  }
  for (let i = steps; i >= 0; i--) {
    const a = (i / steps) * (Math.PI / 2);
    sec.push([top - rr + Math.sin(a) * rr, -(halfT - rr + Math.cos(a) * rr)]);
  }
  sec.push([H * 0.7, -(halfT + 0.02)]);
  sec.push([H * 0.35, -(halfB - 0.015)]);
  sec.push([-0.05, -halfB]);
  // arc length along the section for v
  const arc: number[] = [0];
  for (let i = 1; i < sec.length; i++) arc.push(arc[i - 1] + Math.hypot(sec[i][0] - sec[i - 1][0], sec[i][1] - sec[i - 1][1]));
  const NX = 10;
  const tile = 0.5;
  for (let ix = 0; ix <= NX; ix++) {
    const x = -L / 2 + (L * ix) / NX;
    const endFade = sstep(0, 0.2, Math.min(x + L / 2, L / 2 - x));
    for (let k = 0; k < sec.length; k++) {
      const [y, z] = sec[k];
      // clipped-but-lumpy surface, flat at the joins
      const bump = noise.noise3(x * 2.2, y * 2.2, z * 2.2) * 0.035 * endFade * sstep(0.0, 0.3, y);
      const nz = Math.sign(z) * (y < top - rr ? 1 : 0.5);
      const ny = y > top - rr ? 1 : 0.1;
      const ao = (0.5 + 0.5 * sstep(-0.05, H * 0.8, y)) * (1 + bump * 3);
      const fresh = sstep(top - 0.25, top, y) * 0.12;
      md.vert(x, y + (y > 0.2 ? bump * 0.6 : 0), z + Math.sign(z) * bump, 0, ny, nz, (x + L / 2) / tile, arc[k] / tile, ao * (1 + fresh * 0.6), ao * (1 + fresh), ao * (1 - fresh * 0.5));
    }
  }
  const S = sec.length;
  for (let ix = 0; ix < NX; ix++)
    for (let k = 0; k < S - 1; k++) {
      const a = ix * S + k;
      md.quad(a, a + S, a + S + 1, a + 1);
    }
  // end caps (hidden inside a run, visible on a free end)
  for (const sx of [-1, 1]) {
    const x = (sx * L) / 2;
    const base = md.count;
    let cy = 0;
    for (const [y] of sec) cy += y;
    cy /= S;
    md.vert(x, cy, 0, sx, 0, 0, 0.5, cy / tile, 0.7, 0.7, 0.7);
    for (let k = 0; k < S; k++) {
      const [y, z] = sec[k];
      const ao = 0.5 + 0.5 * sstep(-0.05, H * 0.8, y);
      md.vert(x, y, z, sx, 0, 0, z / tile, y / tile, ao, ao, ao);
    }
    for (let k = 0; k < S - 1; k++) {
      if (sx > 0) md.tri(base, base + 2 + k, base + 1 + k);
      else md.tri(base, base + 1 + k, base + 2 + k);
    }
  }
  const geo = md.build();
  geo.computeVertexNormals();
  const ht = hedgeTextures();
  const mat = cachedMaterial('hedge', () => {
    const m = new THREE.MeshStandardMaterial({ map: ht.map, normalMap: ht.normal, vertexColors: true, roughness: 0.82, metalness: 0 });
    m.normalScale.set(1.4, 1.4);
    m.userData.sway = 0.004;
    return m;
  });
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'hedge';
  g.add(mesh);
  g.userData.tris = md.tris;
  return g;
}
