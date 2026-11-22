// Animal facilities: timber shelter, rock den, enrichment ball, climbing
// frame, hay rack, meat platform and water trough.

import * as THREE from 'three';
import { Noise, Rng } from '../../core/rng';
import { projectBoxUVs } from '../materials';
import { registerProp } from '../registry';
import { box, cyl, displace, gablePlanes, Kit, roof, rod, skillionPlane, V, wall } from './kit';
import * as M from './mats';
import { surfaceNets } from './surfacenets';

// ---------------------------------------------------------------------------
// helpers

/** Lumpy heap (hay / straw / meat): flattened-bottom ellipsoid with noise. */
function heap(rx: number, h: number, rz: number, seed: number, amp: number, tile: number, segs: [number, number] = [14, 8]): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, segs[0], segs[1]);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = new Noise(seed);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i);
    let y = p.getY(i);
    let z = p.getZ(i);
    const k = 1 + n.fbm3(x * 1.7, y * 1.7, z * 1.7, 3) * amp;
    if (y < 0) y *= 0.08;
    x *= rx * k;
    z *= rz * k;
    y *= h * k;
    p.setXYZ(i, x, Math.max(y, -0.01), z);
  }
  g.computeVertexNormals();
  projectBoxUVs(g, tile, 'x', [seed * 0.13, 0, seed * 0.07]);
  return g;
}

/** Straight log (round timber) a → b with slight taper. */
function log(a: THREE.Vector3, b: THREE.Vector3, r: number, off: number): THREE.BufferGeometry {
  return rod(a, b, r, 8, { tile: 1, off, r2: r * 0.9 });
}

// ---------------------------------------------------------------------------
// Timber shelter (2×2): open front, boarded back & sides, mono-pitch roof

function buildShelter(v: number): THREE.Object3D {
  const k = new Kit();
  const stain = v === 1 ? M.STAIN.dark : v === 2 ? M.STAIN.grey : M.STAIN.oak;
  const cladding = M.boards(stain);
  const frameMat = v === 2 ? M.weathered() : M.hardwood(v === 1 ? M.HW.honey : 0xffffff);
  const X = 1.675; // post centre x
  const ZB = -1.425; // back post line
  const ZF = 1.225; // front post line
  const yB = 2.2; // top of back plate
  const yF = 2.75; // top of front header
  const s = (yF - yB) / (ZF - ZB);
  const yAt = (z: number) => yB + (z - ZB) * s;
  // footings + posts
  for (const x of [-X, 0, X])
    for (const z of [ZB, ZF]) {
      if (x === 0 && z === ZF) continue;
      k.add(M.concrete(), box(0.3, 0.12, 0.3).translate(x, 0.04, z));
      const top = z === ZF ? yF - 0.25 : yB - 0.2;
      k.add(frameMat, box(0.15, top, 0.15, { grain: 'y', off: x + z }).translate(x, top / 2, z));
    }
  // header (front), back plate, side plates (sloped)
  k.add(frameMat, box(3.7, 0.25, 0.17, { grain: 'x' }).translate(0, yF - 0.125, ZF));
  k.add(frameMat, box(3.7, 0.2, 0.15, { grain: 'x', off: 0.4 }).translate(0, yB - 0.1, ZB));
  for (const x of [-X, X]) {
    const a = V(x, yAt(ZB - 0.1) - 0.1, ZB - 0.1);
    const b = V(x, yAt(ZF + 0.1) - 0.1, ZF + 0.1);
    k.add(frameMat, beamYZ(a, b, 0.15, 0.2, x));
  }
  // knee braces at the open front
  for (const x of [-X, X]) {
    const sx = Math.sign(x);
    k.add(frameMat, beamXY(V(x, yF - 0.95, ZF), V(x - sx * 0.62, yF - 0.24, ZF), 0.1, 0.09));
  }
  // rafters
  const rafterXs = [-1.75, -0.875, 0, 0.875, 1.75];
  for (const x of rafterXs) {
    const a = V(x, yAt(-1.72) + 0.075, -1.72);
    const b = V(x, yAt(1.55) + 0.075, 1.55);
    k.add(frameMat, beamYZ(a, b, 0.07, 0.15, x * 3));
  }
  // back wall (vertical boards, behind the posts)
  k.add(cladding, wall(-1.76, 1.76, 0.04, yB - 0.02, 0.03, [], { tile: 1.2, grain: 'y' }).translate(0, 0, ZB - 0.093));
  // side walls: boards following the roof slope, open for the front 0.9 m
  for (const x of [-X - 0.09, X + 0.09]) {
    const sh = new THREE.Shape();
    const z0 = ZB - 0.11;
    const z1 = ZF - 0.85;
    sh.moveTo(z0, 0.04);
    sh.lineTo(z1, 0.04);
    sh.lineTo(z1, yAt(z1) - 0.2);
    sh.lineTo(z0, yAt(z0) - 0.2);
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.03, bevelEnabled: false });
    g.rotateY(-Math.PI / 2);
    g.translate(x + 0.015, 0, 0);
    projectBoxUVs(g, 1.2, 'y');
    k.add(cladding, g);
  }
  // mid rail on the side openings
  for (const x of [-X, X]) k.add(frameMat, box(0.1, 0.12, ZF - ZB - 0.85, { grain: 'z' }).translate(x, 1.1, (ZB + ZF - 0.85) / 2 + 0.43));
  // roof: plates → rafters (0.15) → purlins (0.07, sheet roofs) → covering
  const zl = -1.82;
  const zh = 1.68;
  const cosP = Math.cos(Math.atan(s));
  if (v === 1) {
    const thick = 0.24;
    const base = 0.15 + thick / cosP;
    const r = roof(skillionPlane(3.96, zl, yAt(zl) + base, zh, yAt(zh) + base), thick, { tile: 1, rake: true, top: true });
    k.add(M.thatch(), r.top);
    k.add(M.thatch(), r.under);
    k.add(M.thatch(), r.edge);
  } else {
    const thick = 0.04;
    const base = 0.22 + thick / cosP;
    const sheet = M.corrugated(v === 2 ? M.COL.charcoal : M.COL.olive);
    const yl = yAt(zl) + base;
    const yh = yAt(zh) + base;
    const r = roof(skillionPlane(3.92, zl, yl, zh, yh), thick, { tile: M.TILE.corrugated, rake: true, top: true });
    k.add(sheet, r.top);
    k.add(sheet, r.under);
    k.add(sheet, r.edge);
    // purlins across the rafters (sloped with the roof)
    for (const z of [-1.55, -0.55, 0.45, 1.45]) {
      const g = box(3.9, 0.07, 0.07, { grain: 'x', off: z });
      g.rotateX(-Math.atan(s));
      k.add(frameMat, g.translate(0, yAt(z) + 0.15 + 0.035, z));
    }
    // barge flashing along both rakes
    for (const x of [-1.96, 1.96]) k.add(sheet, beamYZ(V(x, yl - 0.05, zl), V(x, yh - 0.05, zh), 0.02, 0.1, 0));
  }
  // straw bedding inside
  const bed = heap(1.55, 0.08, 1.2, 9 + v, 0.35, M.TILE.hay, [16, 6]);
  k.add(M.hay(), bed.translate(0, 0.0, -0.25));
  return k.build(`shelter${v}`);
}

/** Beam a → b where a/b differ in y,z only (cross-section w in x, h in the slope plane). */
function beamYZ(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, off: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = box(w, h, len, { tile: 1, grain: 'z', off });
  g.rotateX(-Math.atan2(b.y - a.y, b.z - a.z));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** Beam a → b in an XY plane (cross-section d in z). */
function beamXY(a: THREE.Vector3, b: THREE.Vector3, w: number, d: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = box(len, w, d, { tile: 1, grain: 'x' });
  g.rotateZ(Math.atan2(b.y - a.y, b.x - a.x));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

// ---------------------------------------------------------------------------
// Rock den (2×2): surface-nets rockwork mound with a dark cave opening (+Z)

function ellipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number): number {
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 < 1e-6 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

let caveMat: THREE.MeshStandardMaterial | null = null;
function caveMaterial(): THREE.MeshStandardMaterial {
  if (!caveMat) {
    const base = M.rock();
    caveMat = new THREE.MeshStandardMaterial({
      map: base.map,
      normalMap: base.normalMap,
      roughnessMap: base.roughnessMap,
      metalnessMap: base.metalnessMap,
      aoMap: base.aoMap,
      roughness: 1,
      metalness: 0,
      vertexColors: true,
    });
    caveMat.normalScale.set(1.3, 1.3);
    caveMat.name = 'struct/caveRock';
  }
  return caveMat;
}

function buildDen(v: number): THREE.Object3D {
  const n = new Noise(41 + v * 7);
  const flip = v === 1 ? -1 : 1;
  const cav = (x: number, y: number, z: number) =>
    Math.min(ellipsoid(x, y - 0.3, z + 0.35, 0.95, 0.95, 0.9), ellipsoid(x, y - 0.18, z - 0.95, 0.6, 0.9, 1.45));
  const solid = (x: number, y: number, z: number) => {
    const xx = x * flip;
    let d = ellipsoid(xx, y - 0.05, z + 0.35, 1.72, 2.0, 1.42);
    d = smin(d, ellipsoid(xx + 1.05, y, z - 0.55, 0.75, 1.2, 0.95), 0.45);
    d = smin(d, ellipsoid(xx - 1.1, y, z - 0.45, 0.72, 0.95, 0.95), 0.45);
    d = smin(d, ellipsoid(xx, y - 1.1, z - 0.5, 1.15, 0.5, 0.75), 0.4);
    return d;
  };
  const sdf = (x: number, y: number, z: number) => {
    let d = solid(x, y, z);
    d = Math.max(d, -cav(x, y, z));
    // big weathered lumps
    d += n.fbm3(x * 0.75, y * 0.75, z * 0.75, 3) * 0.2;
    // bedding planes: terraced ledges that overhang slightly
    const ly = y * 2.4 + n.noise3(x * 0.5, y * 0.3, z * 0.5) * 0.9;
    const f = ly - Math.floor(ly);
    d += (f < 0.82 ? f / 0.82 : (1 - f) / 0.18) * 0.07;
    // vertical joints / fractures (ridged noise creases)
    const cr = Math.abs(n.noise3(x * 1.3 + 7, y * 0.35, z * 1.3));
    d += (0.12 - Math.min(cr, 0.12)) * 0.45;
    return Math.max(d, -(y + 0.22));
  };
  // shading-only detail: crisp bedding-plane steps, joints and pitting
  const detail = (x: number, y: number, z: number) => {
    let d = sdf(x, y, z);
    const ly = y * 5.5 + n.noise3(x * 0.9, y * 0.5, z * 0.9) * 1.4;
    const f = ly - Math.floor(ly);
    d += (f < 0.85 ? f / 0.85 : (1 - f) / 0.15) * 0.014;
    const cr = Math.abs(n.noise3(x * 2.2 + 3, y * 0.7, z * 2.2));
    d += (0.06 - Math.min(cr, 0.06)) * 0.12;
    d += n.noise3(x * 6, y * 6, z * 6) * 0.005;
    return d;
  };
  const idxG = surfaceNets(sdf, { min: V(-2.05, -0.3, -2.05), max: V(2.05, 2.35, 2.05), cell: 0.19 }, detail);
  // clamp to the footprint
  const ip = idxG.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < ip.count; i++) {
    ip.setX(i, Math.max(-1.99, Math.min(1.99, ip.getX(i))));
    ip.setZ(i, Math.max(-1.99, Math.min(1.99, ip.getZ(i))));
  }
  // per-vertex colour: SDF ambient occlusion, darker cave interior, damp base
  const inor = idxG.getAttribute('normal') as THREE.BufferAttribute;
  const vcol = new Float32Array(ip.count * 3);
  for (let i = 0; i < ip.count; i++) {
    const x = ip.getX(i);
    const y = ip.getY(i);
    const z = ip.getZ(i);
    const nx = inor.getX(i);
    const ny = inor.getY(i);
    const nz = inor.getZ(i);
    let occ = 0;
    for (let st = 1; st <= 4; st++) {
      const h = st * 0.14;
      occ += (h - sdf(x + nx * h, y + ny * h, z + nz * h)) / (1 << st);
    }
    let ao = Math.min(Math.max(1 - occ * 1.7, 0.12), 1);
    const c = cav(x, y, z);
    if (c < 0.3) {
      const deep = Math.min(Math.max((1.3 - z) / 1.2, 0), 1);
      ao *= 1 - deep * 0.93 * Math.min(1, (0.3 - c) / 0.3);
    }
    // warm sandstone-grey, banded by bedding planes, damp/dirty near the ground
    const band = 0.5 + 0.5 * Math.sin(y * 15 + n.noise3(x, y, z) * 2);
    const warm = 0.5 + 0.5 * n.noise3(x * 0.6 + 3, y * 0.6, z * 0.6);
    const damp = Math.min(Math.max(1 - (y + 0.1) / 0.5, 0), 1);
    const top = Math.max(ny, 0) * 0.12;
    const l = ao * (0.66 + band * 0.08 + top) * (1 - damp * 0.25);
    vcol[i * 3] = l * (0.98 + warm * 0.14);
    vcol[i * 3 + 1] = l * (0.9 + warm * 0.06);
    vcol[i * 3 + 2] = l * (0.78 - warm * 0.02) * (1 - damp * 0.1);
  }
  // per-face box projection (no smeared triangles), smooth normals kept
  const index = idxG.index!.array;
  const nt = index.length / 3;
  const pos = new Float32Array(nt * 9);
  const nor = new Float32Array(nt * 9);
  const col = new Float32Array(nt * 9);
  const uv = new Float32Array(nt * 6);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const cc = new THREE.Vector3();
  const fn = new THREE.Vector3();
  const tile = 1.5;
  for (let t = 0; t < nt; t++) {
    const ia = index[t * 3];
    const ib = index[t * 3 + 1];
    const ic = index[t * 3 + 2];
    a.fromBufferAttribute(ip, ia);
    b.fromBufferAttribute(ip, ib);
    cc.fromBufferAttribute(ip, ic);
    fn.subVectors(cc, b).cross(a.clone().sub(b)).normalize();
    const ax = Math.abs(fn.x);
    const ay = Math.abs(fn.y);
    const az = Math.abs(fn.z);
    const axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    [ia, ib, ic].forEach((vi, k2) => {
      const o = t * 3 + k2;
      const x = ip.getX(vi);
      const y = ip.getY(vi);
      const z = ip.getZ(vi);
      pos[o * 3] = x;
      pos[o * 3 + 1] = y;
      pos[o * 3 + 2] = z;
      nor[o * 3] = inor.getX(vi);
      nor[o * 3 + 1] = inor.getY(vi);
      nor[o * 3 + 2] = inor.getZ(vi);
      col[o * 3] = vcol[vi * 3];
      col[o * 3 + 1] = vcol[vi * 3 + 1];
      col[o * 3 + 2] = vcol[vi * 3 + 2];
      const u = axis === 0 ? z : x;
      const w = axis === 1 ? z : y;
      uv[o * 2] = u / tile + axis * 0.31;
      uv[o * 2 + 1] = w / tile + axis * 0.57;
    });
  }
  idxG.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const grp = new THREE.Group();
  grp.name = `den${v}`;
  grp.add(new THREE.Mesh(g, caveMaterial()));
  // dark earth floor inside the chamber/tunnel (irregular outline) so lit
  // terrain never shows inside the den
  const k = new Kit();
  const fl = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
  const fp = fl.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < fp.count; i++) {
    const x = fp.getX(i);
    const z = fp.getZ(i);
    const r = Math.hypot(x, z);
    const ang = Math.atan2(z, x);
    const wob = 1 + 0.08 * Math.sin(ang * 5 + v);
    // ellipse covering the chamber, narrowing into the tunnel toward +Z
    const zz = z > 0 ? z * 1.05 : z * 0.95;
    const xx = x * (z > 0 ? 0.55 + 0.4 * (1 - z) : 0.92);
    fp.setXYZ(i, xx * wob * (r > 0 ? 1 : 0), 0.012, zz * wob - 0.1);
  }
  k.add(M.voidDark(), fl);
  const fk = k.build('denfloor');
  for (const c of [...fk.children]) grp.add(c);
  return grp;
}

// ---------------------------------------------------------------------------
// Enrichment ball (0.9 m hard plastic, scuffed)

const BALL_COLORS = [0x2c5577, 0x8a2f26, 0x3c6136];

function buildBall(v: number): THREE.Object3D {
  const k = new Kit();
  const r = 0.45;
  const g = new THREE.SphereGeometry(r, 26, 16);
  g.scale(1, 0.965, 1);
  // a couple of shallow dents
  const n = new Noise(7 + v);
  displace(g, (x, y, z) => n.noise3(x * 3, y * 3, z * 3) * 0.006);
  g.rotateY(v * 1.3);
  g.rotateZ(0.0);
  k.add(M.ball(BALL_COLORS[v % BALL_COLORS.length]), g.translate(0, r * 0.965 - 0.012, 0));
  return k.build(`ball${v}`);
}

// ---------------------------------------------------------------------------
// Climbing frame (2×2): log poles, two decks, rope bridge, hanging ropes, cargo net

function buildClimbing(v: number): THREE.Object3D {
  const k = new Kit();
  const logM = M.weathered();
  const deck = M.hardwood(M.HW.honey);
  const rng = new Rng(300 + v);
  const poles: [number, number, number][] = [
    [-1.45, -1.3, 4.1],
    [1.4, -1.35, 3.5],
    [1.45, 0.75, 2.9],
    [-1.4, 0.8, 3.7],
    [-0.35, -1.3, 3.0],
  ];
  const top: THREE.Vector3[] = [];
  poles.forEach(([x, z, h], i) => {
    const lean = V(rng.range(-0.06, 0.06), 0, rng.range(-0.06, 0.06));
    const a = V(x, -0.2, z);
    const b = V(x + lean.x, h, z + lean.z);
    k.add(logM, log(a, b, 0.11, i * 0.37));
    top.push(b);
  });
  const along = (i: number, y: number) => {
    const t = (y + 0.2) / (top[i].y + 0.2);
    return V(poles[i][0] + (top[i].x - poles[i][0]) * t, y, poles[i][1] + (top[i].z - poles[i][1]) * t);
  };
  // high deck between poles 0 / 3 / 4 (left), 2.2 m
  const yA = 2.2;
  const deckA = { x0: -1.42, x1: -0.3, z0: -1.25, z1: 0.75 };
  // low deck right: between poles 1 / 2, 1.3 m
  const yB = 1.3;
  const deckB = { x0: 0.55, x1: 1.42, z0: -1.3, z1: 0.7 };
  for (const [d, y, s] of [
    [deckA, yA, 0],
    [deckB, yB, 1],
  ] as const) {
    // bearers (logs) along x at both ends, planks along z
    for (const z of [d.z0 + 0.08, d.z1 - 0.08]) k.add(logM, log(V(d.x0 - 0.12, y - 0.1, z), V(d.x1 + 0.12, y - 0.1, z), 0.08, z + s));
    const np = Math.floor((d.x1 - d.x0) / 0.15);
    for (let i = 0; i < np; i++) {
      const x = d.x0 + 0.075 + i * ((d.x1 - d.x0 - 0.15) / (np - 1));
      k.add(deck, box(0.13, 0.04, d.z1 - d.z0, { tile: 1, grain: 'z', off: i * 0.29 + s }).translate(x, y + 0.0, (d.z0 + d.z1) / 2));
    }
  }
  // top beams (hanging ropes from 0-1), side rails
  k.add(logM, log(along(0, 3.55), along(1, 3.3), 0.09, 2.2));
  k.add(logM, log(along(1, 2.6), along(2, 2.6), 0.08, 2.9));
  k.add(logM, log(along(3, 3.0), along(0, 3.0), 0.08, 3.4));
  // diagonal braces
  k.add(logM, log(along(4, 0.4), along(0, 1.9), 0.06, 4.1));
  k.add(logM, log(along(2, 0.5), along(1, 1.15), 0.06, 4.7));
  // rope bridge between decks (two hand ropes + foot rope with slats)
  const ropeM = M.rope();
  const sag = (a: THREE.Vector3, b: THREE.Vector3, dip: number, r: number) => {
    const mid = a.clone().lerp(b, 0.5);
    mid.y -= dip;
    const c = new THREE.QuadraticBezierCurve3(a, mid, b);
    const g = new THREE.TubeGeometry(c, 14, r, 5, false);
    // U along the rope in metres
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const len = c.getLength();
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * len) / M.TILE.rope, uv.getY(i));
    return g;
  };
  const bz = -0.25;
  const ba = V(deckA.x1, yA + 0.02, bz);
  const bb = V(deckB.x0, yB + 0.02, bz);
  for (const dz of [-0.32, 0.32]) k.add(ropeM, sag(ba.clone().setZ(bz + dz).setY(yA + 0.75), bb.clone().setZ(bz + dz).setY(yB + 0.75), 0.18, 0.016));
  for (const dz of [-0.22, 0.22]) k.add(ropeM, sag(ba.clone().setZ(bz + dz), bb.clone().setZ(bz + dz), 0.22, 0.02));
  const nSl = 6;
  for (let i = 1; i < nSl; i++) {
    const t = i / nSl;
    const p = ba.clone().lerp(bb, t);
    p.y -= 4 * 0.22 * t * (1 - t) - 0.02;
    const ang = Math.atan2(bb.y - ba.y, bb.x - ba.x) * (1 - 2 * t) * 0.6;
    k.add(deck, box(0.09, 0.03, 0.55, { tile: 1, grain: 'z', off: i }).rotateZ(ang).translate(p.x, p.y, p.z));
  }
  // hanging ropes with knots from the top beam
  for (const t of [0.3, 0.62]) {
    const a = along(0, 3.55).lerp(along(1, 3.3), t);
    a.y -= 0.07;
    const b = a.clone();
    b.y = 0.35;
    b.x += 0.04;
    k.add(ropeM, rod(a, b, 0.019, 6, { tile: M.TILE.rope, caps: false }));
    for (const y of [0.45, 0.95, 1.45]) k.add(ropeM, new THREE.SphereGeometry(0.045, 7, 5).scale(1, 0.8, 1).translate(b.x - 0.04 * ((y - 0.35) / (a.y - 0.35)) + 0.04, y, b.z));
  }
  // cargo net ramp: from the front edge of the high deck down to the ground
  {
    const segU = 8;
    const segV = 8;
    const p0 = V(deckA.x0 + 0.05, yA, deckA.z1);
    const p1 = V(deckA.x1 - 0.05, yA, deckA.z1);
    const q0 = V(deckA.x0 - 0.05, 0.02, 1.85);
    const q1 = V(deckA.x1 + 0.05, 0.02, 1.85);
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= segV; j++) {
      const t = j / segV;
      for (let i = 0; i <= segU; i++) {
        const s2 = i / segU;
        const top2 = p0.clone().lerp(p1, s2);
        const bot = q0.clone().lerp(q1, s2);
        const pt = top2.lerp(bot, t);
        // sag inward
        pt.y -= Math.sin(t * Math.PI) * 0.18 * (0.6 + 0.4 * Math.sin(s2 * Math.PI));
        pos.push(pt.x, pt.y, pt.z);
        // diamond mesh: rotate UVs 45°
        const uu = s2 * 1.15;
        const vv = t * 2.9;
        uv.push(((uu + vv) / M.TILE.net) * 0.707, ((uu - vv) / M.TILE.net) * 0.707);
      }
    }
    for (let j = 0; j < segV; j++)
      for (let i = 0; i < segU; i++) {
        const a = j * (segU + 1) + i;
        idx.push(a, a + 1, a + segU + 2, a, a + segU + 2, a + segU + 1);
      }
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ng.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    ng.setIndex(idx);
    ng.computeVertexNormals();
    k.add(M.net(), ng);
    // ground anchor log + side ropes
    k.add(logM, log(V(deckA.x0 - 0.15, 0.06, 1.88), V(deckA.x1 + 0.15, 0.06, 1.88), 0.07, 5.5));
    k.add(ropeM, sag(p0, q0, 0.12, 0.018));
    k.add(ropeM, sag(p1, q1, 0.12, 0.018));
  }
  return k.build(`climb${v}`);
}

// ---------------------------------------------------------------------------
// Hay rack: timber frame, galvanised V-rack full of hay, small roof

function buildHayFeeder(v: number): THREE.Object3D {
  const k = new Kit();
  const wood = v === 1 ? M.weathered() : M.hardwood(M.HW.honey);
  const X = 0.62;
  const Z = 0.42;
  const H = 2.25;
  for (const x of [-X, X])
    for (const z of [-Z, Z]) {
      k.add(wood, box(0.11, H, 0.11, { grain: 'y', off: x * 3 + z }).translate(x, H / 2, z));
      k.add(M.concrete(), box(0.2, 0.08, 0.2).translate(x, 0.02, z));
    }
  // rails
  for (const y of [1.0, 1.85])
    for (const z of [-Z, Z]) k.add(wood, box(X * 2 + 0.1, 0.09, 0.07, { grain: 'x', off: y + z }).translate(0, y, z));
  for (const x of [-X, X]) k.add(wood, box(0.07, 0.09, Z * 2 + 0.1, { grain: 'z', off: x }).translate(x, 1.85, 0));
  // V rack: bars from the trough bottom (centre line) up to the top rails
  const g = M.galv();
  const yb = 1.02;
  const yt = 1.82;
  for (const side of [-1, 1]) {
    k.add(g, rod(V(-X + 0.05, yt, side * (Z - 0.06)), V(X - 0.05, yt, side * (Z - 0.06)), 0.018, 6));
    for (let i = 0; i <= 10; i++) {
      const x = -X + 0.08 + (i / 10) * (2 * X - 0.16);
      k.add(g, rod(V(x, yb, side * 0.06), V(x, yt, side * (Z - 0.06)), 0.009, 4, { caps: false }));
    }
  }
  k.add(g, rod(V(-X + 0.05, yb, 0), V(X - 0.05, yb, 0), 0.02, 6));
  // tray under the rack
  k.add(M.boards(M.STAIN.dark), box(X * 2 - 0.05, 0.03, 0.34, { tile: 1.2, grain: 'x' }).translate(0, yb - 0.04, 0));
  // hay: a wedge-shaped mound filling the V and heaping over the top
  const hayG = heap(X - 0.08, 0.55, Z - 0.1, 77 + v, 0.22, M.TILE.hay, [16, 10]);
  const hp = hayG.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < hp.count; i++) {
    const y = hp.getY(i);
    // squeeze the bottom into the V
    const f = 0.25 + 0.75 * Math.min(y / 0.55, 1);
    hp.setZ(i, hp.getZ(i) * f);
  }
  hayG.computeVertexNormals();
  k.add(M.hay(), hayG.translate(0, yb + 0.02, 0));
  // fallen hay below
  k.add(M.hay(), heap(0.75, 0.06, 0.5, 91 + v, 0.5, M.TILE.hay, [12, 5]).translate(0.05, 0, 0.1));
  // roof: small gable, ridge along x
  const pl = gablePlanes(1.62, 1.25, H + 0.02, 0.32);
  if (v === 1) {
    const r = roof(pl, 0.05, { tile: M.TILE.corrugated, rake: true });
    const sh = M.corrugated(M.COL.charcoal);
    k.add(sh, r.top);
    k.add(sh, r.under);
    k.add(sh, r.edge);
  } else {
    const r = roof(pl, 0.035, { tile: 1.2, rake: true });
    const b = M.boards(M.STAIN.dark);
    k.add(b, r.top);
    k.add(b, r.under);
    k.add(b, r.edge);
  }
  k.add(wood, box(1.4, 0.1, 0.08, { grain: 'x' }).translate(0, H + 0.3, 0));
  for (const x of [-X, X]) {
    const s = new THREE.Shape();
    s.moveTo(-Z - 0.06, H);
    s.lineTo(Z + 0.06, H);
    s.lineTo(0, H + 0.3);
    s.closePath();
    const tri = new THREE.ExtrudeGeometry(s, { depth: 0.04, bevelEnabled: false });
    tri.rotateY(Math.PI / 2);
    tri.translate(x - 0.02, 0, 0);
    projectBoxUVs(tri, 1, 'y');
    k.add(wood, tri);
  }
  return k.build(`hay${v}`);
}

// ---------------------------------------------------------------------------
// Meat platform: sleeper deck or stone slab with meat & a bone

function meatPieces(k: Kit, y: number, seed: number): void {
  const rng = new Rng(seed);
  const spots: [number, number, number, number][] = [
    [-0.35, 0.05, 0.24, 0.13],
    [0.15, -0.12, 0.2, 0.1],
    [0.42, 0.18, 0.16, 0.09],
  ];
  spots.forEach(([x, z, r, h], i) => {
    const g = heap(r, h, r * 0.72, seed * 13 + i, 0.3, M.TILE.meat, [12, 8]);
    g.rotateY(rng.range(0, Math.PI));
    k.add(M.meat(), g.translate(x, y, z));
  });
  // bone
  const a = V(-0.05, y + 0.04, 0.28);
  const b = V(0.38, y + 0.04, 0.38);
  k.add(M.bone(), rod(a, b, 0.025, 6));
  for (const p of [a, b]) {
    const d = b.clone().sub(a).normalize().multiplyScalar(0.012);
    k.add(M.bone(), new THREE.SphereGeometry(0.038, 7, 5).translate(p.x + d.x, p.y, p.z + d.z + 0.02));
    k.add(M.bone(), new THREE.SphereGeometry(0.038, 7, 5).translate(p.x - d.x, p.y, p.z - d.z - 0.02));
  }
}

function buildMeat(v: number): THREE.Object3D {
  const k = new Kit();
  if (v === 0) {
    // railway-sleeper style deck on two bearers
    const sl = M.hardwood(M.HW.dark);
    for (const z of [-0.42, 0.42]) k.add(sl, box(1.5, 0.1, 0.15, { grain: 'x', off: z }).translate(0, 0.05, z));
    for (let i = 0; i < 6; i++) {
      const z = -0.6 + i * 0.24;
      k.add(sl, box(1.6, 0.11, 0.22, { grain: 'x', off: i * 0.71 }).translate(0, 0.155, z));
    }
    meatPieces(k, 0.21, 3);
  } else {
    // stone slab on rough blocks
    const st = M.rock();
    const slab = box(1.55, 0.14, 1.15, { tile: 1.5 });
    const n = new Noise(5);
    const sp = slab.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) sp.setY(i, sp.getY(i) + n.noise2(sp.getX(i) * 2, sp.getZ(i) * 2) * 0.015);
    slab.computeVertexNormals();
    k.add(st, slab.translate(0, 0.32, 0));
    for (const x of [-0.5, 0.5]) k.add(st, heap(0.22, 0.27, 0.42, 8 + x * 10, 0.25, 1.5, [8, 6]).translate(x, 0, 0));
    meatPieces(k, 0.39, 4);
  }
  return k.build(`meat${v}`);
}

// ---------------------------------------------------------------------------
// Water trough: stone or concrete, water surface, float-valve box

function buildTrough(v: number): THREE.Object3D {
  const k = new Kit();
  const mat = v === 0 ? M.ashlar() : M.concrete();
  const tile = v === 0 ? M.TILE.ashlar : M.TILE.concrete;
  const L = 1.6;
  const W = 0.72;
  const H = 0.55;
  const t = 0.11;
  // walls + floor (below the waterline, the inner floor is unseen)
  const o = { tile, grain: 'x' as const };
  k.add(mat, box(L, H, t, o).translate(0, H / 2, W / 2 - t / 2));
  k.add(mat, box(L, H, t, { ...o, off: 0.3 }).translate(0, H / 2, -W / 2 + t / 2));
  k.add(mat, box(t, H, W - t * 2, { ...o, grain: 'z', off: 0.6 }).translate(L / 2 - t / 2, H / 2, 0));
  k.add(mat, box(t, H, W - t * 2, { ...o, grain: 'z', off: 0.9 }).translate(-L / 2 + t / 2, H / 2, 0));
  k.add(mat, box(L - t * 2, 0.1, W - t * 2, o).translate(0, 0.12, 0));
  // coping lip
  if (v === 0) {
    k.add(mat, box(L + 0.06, 0.06, 0.16, o).translate(0, H + 0.03, W / 2 - 0.07));
    k.add(mat, box(L + 0.06, 0.06, 0.16, { ...o, off: 0.5 }).translate(0, H + 0.03, -W / 2 + 0.07));
    k.add(mat, box(0.16, 0.06, W - 0.28, { ...o, grain: 'z' }).translate(L / 2 - 0.05, H + 0.03, 0));
    k.add(mat, box(0.16, 0.06, W - 0.28, { ...o, grain: 'z', off: 0.2 }).translate(-L / 2 + 0.05, H + 0.03, 0));
  }
  // water
  const w = new THREE.PlaneGeometry(L - t * 2 + 0.02, W - t * 2 + 0.02).rotateX(-Math.PI / 2);
  const uv = w.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (L / M.TILE.water), uv.getY(i) * (W / M.TILE.water));
  k.add(M.water(), w.translate(0, H - 0.09, 0));
  // float-valve cover + supply pipe at one end
  const g = M.galv();
  k.add(g, box(0.26, 0.12, W - t * 2 - 0.04).translate(-L / 2 + t + 0.13, H - 0.02, 0));
  k.add(g, cyl(0.025, 0.025, H + 0.1, 8).translate(-L / 2 - 0.05, (H + 0.1) / 2 - 0.1, -0.15));
  k.add(g, rod(V(-L / 2 - 0.05, H - 0.05, -0.15), V(-L / 2 + t, H - 0.05, -0.15), 0.025, 8));
  return k.build(`trough${v}`);
}

// ---------------------------------------------------------------------------

export function registerHabitat(): void {
  registerProp('shelter_wood', { variants: 3, build: buildShelter });
  registerProp('shelter_cave', { variants: 2, build: buildDen });
  registerProp('toy_ball', { variants: 3, build: buildBall, jitter: { yaw: true, scale: [0.95, 1.05] } });
  registerProp('climbing_frame', { variants: 1, build: buildClimbing });
  registerProp('feeder_hay', { variants: 2, build: buildHayFeeder });
  registerProp('feeder_meat', { variants: 2, build: buildMeat });
  registerProp('water_trough', { variants: 2, build: buildTrough });
}

