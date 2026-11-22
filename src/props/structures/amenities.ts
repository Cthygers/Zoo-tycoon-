// Guest amenities: park bench, litter bin, Victorian lamp post, picnic table,
// donation box, info board (lectern) and the animated stone fountain.

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { registerProp } from '../registry';
import { box, cyl, extrude, Kit, lathe, mat, quad, rod, V } from './kit';
import * as M from './mats';
import { signUV, type SignKey } from './signs';

// ---------------------------------------------------------------------------
// helpers

/** Polyline (profile plane) → closed outline of a bar of width w (for extrusion). */
function barShape(pts: [number, number][], w: number): THREE.Shape {
  const n = pts.length;
  const left: THREE.Vector2[] = [];
  const right: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const p = new THREE.Vector2(...pts[i]);
    const a = new THREE.Vector2(...pts[Math.max(i - 1, 0)]);
    const b = new THREE.Vector2(...pts[Math.min(i + 1, n - 1)]);
    const d = b.sub(a).normalize();
    const nrm = new THREE.Vector2(-d.y, d.x).multiplyScalar(w / 2);
    left.push(p.clone().add(nrm));
    right.push(p.clone().sub(nrm));
  }
  const s = new THREE.Shape();
  s.moveTo(left[0].x, left[0].y);
  for (let i = 1; i < n; i++) s.lineTo(left[i].x, left[i].y);
  for (let i = n - 1; i >= 0; i--) s.lineTo(right[i].x, right[i].y);
  s.closePath();
  return s;
}

/** Sample a quadratic / cubic path into points. */
function curve(ctrl: [number, number][], steps: number): [number, number][] {
  const v = ctrl.map(([x, y]) => new THREE.Vector2(x, y));
  const c = v.length === 3 ? new THREE.QuadraticBezierCurve(v[0], v[1], v[2]) : new THREE.CubicBezierCurve(v[0], v[1], v[2], v[3]);
  return c.getPoints(steps).map((p) => [p.x, p.y] as [number, number]);
}

/** Extrude a profile drawn in (forward z, up y) into a slab of thickness t centred on x. */
function profileSlab(shape: THREE.Shape, t: number, x: number): THREE.BufferGeometry {
  const g = extrude(shape, t, { tile: 1, curveSegments: 4 });
  // shape x → world z, extrusion z → world -x
  g.rotateY(-Math.PI / 2);
  g.translate(x + t / 2, 0, 0);
  return g;
}

function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  if (n !== g) g.dispose();
  n.computeVertexNormals();
  return n;
}

// ---------------------------------------------------------------------------
// Bench: 1.8 m, timber slats on cast-iron ends. Sitter faces +Z.

function buildBench(v: number): THREE.Object3D {
  const k = new Kit();
  const iron = M.paint(v === 1 ? M.COL.ironBlack : M.COL.ironGreen);
  const wood = v === 2 ? M.weathered() : M.timber();
  const W = 0.04;
  const T = 0.032;
  for (const x of [-0.76, 0.76]) {
    const parts: [number, number][][] = [
      curve([[0.27, 0.0], [0.2, 0.2], [0.215, 0.43]], 5), // front leg
      [...curve([[-0.28, 0.0], [-0.19, 0.22], [-0.2, 0.43]], 5), ...curve([[-0.2, 0.43], [-0.21, 0.62], [-0.3, 0.86]], 4).slice(1)], // rear leg + back
      curve([[0.25, 0.415], [0.02, 0.39], [-0.21, 0.415]], 4), // seat rail
      [...curve([[-0.235, 0.63], [0.0, 0.67], [0.2, 0.63]], 4), ...curve([[0.2, 0.63], [0.29, 0.6], [0.24, 0.55]], 3).slice(1)], // arm + scroll
      curve([[0.215, 0.43], [0.235, 0.5], [0.24, 0.56]], 2), // arm support
    ];
    for (const p of parts) k.add(iron, profileSlab(barShape(p, W), T, x));
    // feet pads
    k.add(iron, box(0.05, 0.02, 0.09).translate(x, 0.01, 0.27));
    k.add(iron, box(0.05, 0.02, 0.09).translate(x, 0.01, -0.28));
  }
  // seat slats
  const L = 1.82;
  for (let i = 0; i < 5; i++) {
    const z = 0.205 - i * 0.092;
    const y = 0.43 + (i === 0 ? 0.0 : 0.012);
    k.add(wood, box(L, 0.034, 0.072, { tile: 1, grain: 'x', off: i * 0.37 }).translate(0, y + 0.017, z));
  }
  // back slats (on the inclined back line)
  const a = V(0, 0.5, -0.218);
  const b = V(0, 0.84, -0.282);
  const ang = Math.atan2(b.z - a.z, b.y - a.y); // lean back
  for (let i = 0; i < 3; i++) {
    const t = 0.12 + i * 0.36;
    const p = a.clone().lerp(b, t);
    const g = box(L, 0.085, 0.03, { tile: 1, grain: 'x', off: 0.9 + i * 0.41 });
    g.rotateX(ang);
    g.translate(0, p.y, p.z + 0.03);
    k.add(wood, g);
  }
  // under-seat stretcher rod
  k.add(iron, rod(V(-0.76, 0.3, -0.05), V(0.76, 0.3, -0.05), 0.012, 6));
  return k.build(`bench${v}`);
}

// ---------------------------------------------------------------------------
// Litter bin with liner

function liner(k: Kit, r: number, y: number): void {
  // black bag folded over the rim: a ring with soft folds
  const rng = new Rng(11);
  const pts: [number, number][] = [
    [r - 0.02, y - 0.25],
    [r - 0.012, y - 0.02],
    [r + 0.006, y + 0.012],
    [r + 0.022, y - 0.005],
    [r + 0.028, y - 0.07],
    [r + 0.026, y - 0.1],
  ];
  const g = lathe(pts, 20, { tile: 0.5 });
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const a = Math.atan2(z, x);
    const f = 1 + Math.sin(a * 7 + 1.3) * 0.02 + Math.sin(a * 13) * 0.012;
    p.setXYZ(i, x * f, p.getY(i) + Math.sin(a * 5) * 0.006, z * f);
  }
  g.computeVertexNormals();
  void rng;
  k.add(M.plasticDark(), g);
  // inner bag depth (dark interior)
  k.add(M.plasticDark(), new THREE.CircleGeometry(r - 0.03, 16).rotateX(-Math.PI / 2).translate(0, y - 0.3, 0));
}

function buildBin(v: number): THREE.Object3D {
  const k = new Kit();
  if (v === 0) {
    // painted steel bin: tapered drum with rolled rim, base ring, banding
    const pm = M.paint(M.COL.ironGreen);
    const outer = lathe(
      [
        [0.0, 0.03],
        [0.2, 0.03],
        [0.215, 0.05],
        [0.215, 0.09],
        [0.205, 0.1],
        [0.225, 0.8],
        [0.24, 0.81],
        [0.243, 0.83],
        [0.232, 0.84],
        [0.215, 0.835],
        [0.2, 0.8],
      ],
      24,
      { tile: 1 },
    );
    k.add(pm, outer);
    for (const y of [0.3, 0.6]) k.add(pm, cyl(0.222 + (y - 0.1) * 0.03, 0.222 + (y - 0.1) * 0.03, 0.03, 24, { caps: false }).translate(0, y, 0));
    k.add(M.galv(), cyl(0.21, 0.22, 0.03, 20).translate(0, 0.015, 0));
    liner(k, 0.205, 0.84);
  } else {
    // timber-slatted bin around a galvanised liner can
    const n = 14;
    const r = 0.24;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const g = box(0.085, 0.82, 0.025, { tile: 1, grain: 'y', off: i * 0.31 });
      g.translate(0, 0.43, 0);
      g.rotateY(a);
      g.translate(Math.sin(a) * r, 0, Math.cos(a) * r);
      k.add(M.timber(), g);
    }
    for (const y of [0.15, 0.72]) k.add(M.paint(M.COL.ironBlack), cyl(0.258, 0.258, 0.04, 24, { caps: false }).translate(0, y, 0));
    k.add(M.galv(), cyl(0.215, 0.205, 0.78, 20, { caps: false }).translate(0, 0.43, 0));
    k.add(M.galv(), cyl(0.22, 0.22, 0.02, 20, { caps: false }).translate(0, 0.83, 0));
    liner(k, 0.21, 0.84);
  }
  return k.build(`bin${v}`);
}

// ---------------------------------------------------------------------------
// Victorian lamp post (cast iron, square tapered lantern)

function lantern(k: Kit, iron: THREE.Material, x: number, y: number, z: number, s = 1): void {
  const yy = (v: number) => y + v * s;
  const r = (v: number) => v * s;
  // base cup (round) + square lantern body
  k.add(iron, lathe([[0.0, yy(0)], [r(0.05), yy(0)], [r(0.09), yy(0.05)], [r(0.1), yy(0.08)], [r(0.0), yy(0.081)]], 12, { tile: 0.5 }).translate(x, 0, z));
  const sq = (pts: [number, number][]) => flat(lathe(pts, 4, { tile: 0.5, phi: Math.PI / 4 }).translate(x, 0, z));
  // bottom tray
  k.add(iron, sq([[0.0, yy(0.08)], [r(0.15), yy(0.08)], [r(0.16), yy(0.11)], [r(0.0), yy(0.11)]]));
  // glass (tapered outward)
  k.add(M.lampGlow(), sq([[r(0.135), yy(0.11)], [r(0.17), yy(0.46)]]));
  // corner frame posts
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const c0 = V(x + Math.cos(a) * r(0.19), yy(0.11), z + Math.sin(a) * r(0.19));
    const c1 = V(x + Math.cos(a) * r(0.24), yy(0.46), z + Math.sin(a) * r(0.24));
    k.add(iron, rod(c0, c1, r(0.012), 4, { caps: false }));
  }
  // roof + finial
  k.add(iron, sq([[r(0.0), yy(0.46)], [r(0.2), yy(0.46)], [r(0.215), yy(0.49)], [r(0.07), yy(0.6)], [r(0.0), yy(0.61)]]));
  k.add(iron, lathe([[0.0, yy(0.6)], [r(0.03), yy(0.61)], [r(0.02), yy(0.66)], [r(0.035), yy(0.7)], [r(0.0), yy(0.74)]], 8, { tile: 0.5 }).translate(x, 0, z));
}

function buildLamp(v: number): THREE.Object3D {
  const k = new Kit();
  const iron = M.paint(v === 1 ? M.COL.ironGreen : M.COL.ironBlack);
  // fluted-look post: base plinth, tapering shaft, collars
  k.add(
    iron,
    lathe(
      [
        [0.0, 0.0],
        [0.17, 0.0],
        [0.17, 0.06],
        [0.145, 0.09],
        [0.135, 0.32],
        [0.155, 0.35],
        [0.155, 0.38],
        [0.1, 0.44],
        [0.075, 0.55],
        [0.06, 0.62],
        [0.068, 0.66],
        [0.055, 0.7],
        [0.045, 2.55],
        [0.06, 2.58],
        [0.06, 2.63],
        [0.045, 2.66],
        [0.04, 2.95],
        [0.07, 2.98],
        [0.075, 3.02],
        [0.0, 3.03],
      ],
      14,
      { tile: 1 },
    ),
  );
  // ladder bar
  k.add(iron, rod(V(-0.3, 2.7, 0), V(0.3, 2.7, 0), 0.014, 6));
  for (const x of [-0.31, 0.31]) k.add(iron, new THREE.SphereGeometry(0.028, 8, 6).translate(x, 2.7, 0));
  if (v === 2) {
    // twin-arm: scrolled cross arm with two lanterns
    k.add(iron, rod(V(-0.5, 3.0, 0), V(0.5, 3.0, 0), 0.03, 8));
    for (const sx of [-1, 1]) {
      const pts = [V(0, 2.75, 0), V(sx * 0.25, 2.82, 0), V(sx * 0.42, 2.95, 0)];
      k.add(iron, rod(pts[0], pts[1], 0.016, 6));
      k.add(iron, rod(pts[1], pts[2], 0.016, 6));
      lantern(k, iron, sx * 0.48, 3.02, 0, 0.85);
    }
    k.add(iron, lathe([[0.0, 3.03], [0.04, 3.05], [0.025, 3.12], [0.0, 3.16]], 8));
  } else {
    lantern(k, iron, 0, 3.03, 0, 1);
  }
  return k.build(`lamp${v}`);
}

// ---------------------------------------------------------------------------
// Picnic table with attached benches (A-frame)

function buildPicnic(v: number): THREE.Object3D {
  const k = new Kit();
  const wood = v === 1 ? M.weathered() : M.timber();
  const L = 1.8;
  // table top: 5 planks across z
  for (let i = 0; i < 5; i++) {
    const z = -0.3 + i * 0.15;
    k.add(wood, box(L, 0.04, 0.135, { tile: 1, grain: 'x', off: i * 0.53 }).translate(0, 0.74, z));
  }
  // benches: 2 planks each side
  for (const s of [-1, 1])
    for (let i = 0; i < 2; i++) {
      const z = s * (0.6 + i * 0.13 - 0.065);
      k.add(wood, box(L, 0.04, 0.12, { tile: 1, grain: 'x', off: 2.1 + i * 0.7 + s }).translate(0, 0.45, z));
    }
  // A-frames
  for (const x of [-0.62, 0.62]) {
    for (const s of [-1, 1]) {
      const a = V(x, 0.0, s * 0.62);
      const b = V(x, 0.72, s * 0.1);
      k.add(wood, beamBox(a, b, 0.045, 0.09, 0.6 + s));
    }
    // cleats under top and benches
    k.add(wood, box(0.045, 0.07, 0.75, { tile: 1, grain: 'z' }).translate(x, 0.685, 0));
    k.add(wood, box(0.045, 0.08, 1.62, { tile: 1, grain: 'z' }).translate(x, 0.39, 0));
  }
  // diagonal braces
  for (const s of [-1, 1]) k.add(wood, beamBox(V(s * 0.6, 0.43, 0), V(s * 0.05, 0.69, 0), 0.045, 0.07, 3.3));
  // bolts
  for (const x of [-0.6, 0.6]) for (const z of [-0.62, -0.42, 0.42, 0.62, -0.25, 0.25]) k.add(M.galv(), cyl(0.012, 0.012, 0.06, 6).rotateZ(Math.PI / 2).translate(x, z === 0.25 || z === -0.25 ? 0.685 : 0.39, z));
  return k.build(`picnic${v}`);
}

function beamBox(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, off: number): THREE.BufferGeometry {
  // rectangular member a→b, w across X, h in the a-b plane
  const len = a.distanceTo(b);
  const g = box(w, len, h, { tile: 1, grain: 'y', off });
  const dir = b.clone().sub(a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

// ---------------------------------------------------------------------------
// Donation box: clear acrylic box on a post, coins & notes inside, sign panel

function buildDonation(): THREE.Object3D {
  const k = new Kit();
  const pm = M.paint(M.COL.ironGreen);
  // base plate + post
  k.add(pm, box(0.3, 0.02, 0.3).translate(0, 0.01, 0));
  k.add(pm, box(0.09, 0.98, 0.09, { tile: 1, grain: 'y' }).translate(0, 0.5, 0));
  // sign panel on the post front (+Z), slightly tilted
  const r = signUV('donate');
  const sign = quad(0.34, 0.34, r.u0, r.v0, r.u1, r.v1);
  sign.rotateX(-0.12);
  k.add(M.signs(), sign.translate(0, 0.68, 0.075));
  k.add(pm, box(0.37, 0.37, 0.02).rotateX(-0.12).translate(0, 0.68, 0.06));
  // box: bottom tray, acrylic walls, metal edges, lid with slot
  const W = 0.38;
  const H = 0.44;
  const D = 0.32;
  const y0 = 0.99;
  k.add(pm, box(W + 0.03, 0.03, D + 0.03).translate(0, y0 + 0.015, 0));
  k.add(pm, box(W + 0.03, 0.035, D + 0.03).translate(0, y0 + H - 0.017, 0));
  k.add(M.plasticDark(), box(0.18, 0.006, 0.025).translate(0, y0 + H + 0.001, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add(pm, box(0.022, H, 0.022).translate((sx * W) / 2, y0 + H / 2, (sz * D) / 2));
  const glassY = y0 + H / 2;
  const ac = M.acrylic();
  k.add(ac, quad(W, H - 0.06).translate(0, glassY, D / 2));
  k.add(ac, quad(W, H - 0.06).rotateY(Math.PI).translate(0, glassY, -D / 2));
  k.add(ac, quad(D, H - 0.06).rotateY(Math.PI / 2).translate(W / 2, glassY, 0));
  k.add(ac, quad(D, H - 0.06).rotateY(-Math.PI / 2).translate(-W / 2, glassY, 0));
  // coin heap + scattered coins + notes
  const heap = lathe(
    [
      [0.0, y0 + 0.11],
      [0.08, y0 + 0.095],
      [0.15, y0 + 0.06],
      [0.17, y0 + 0.035],
      [0.17, y0 + 0.03],
    ],
    12,
    { tile: 0.3 },
  );
  heap.scale(1, 1, 0.82);
  k.add(M.brass(), heap);
  const rng = new Rng(5);
  for (let i = 0; i < 10; i++) {
    const c = cyl(0.013, 0.013, 0.003, 7);
    c.rotateX(rng.range(-0.5, 0.5));
    c.rotateZ(rng.range(-0.5, 0.5));
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(0.0, 0.12);
    const y = y0 + 0.1 - d * 0.45 + 0.004;
    k.add(i % 3 === 0 ? M.steel() : M.brass(), c.translate(Math.cos(a) * d, y, Math.sin(a) * d * 0.8));
  }
  const nr = signUV('note');
  for (let i = 0; i < 3; i++) {
    const n = quad(0.13, 0.065, nr.u0, nr.v0, nr.u1, nr.v1);
    n.rotateX(-Math.PI / 2 + rng.range(-0.35, 0.35));
    n.rotateY(rng.range(0, Math.PI));
    n.translate(rng.range(-0.08, 0.08), y0 + 0.105 + i * 0.008, rng.range(-0.07, 0.07));
    k.add(M.signs(), n);
  }
  return k.build('donation');
}

// ---------------------------------------------------------------------------
// Info board: lectern on two posts with an angled painted panel

function buildInfo(v: number): THREE.Object3D {
  const k = new Kit();
  const wood = M.timber();
  const key = (['info0', 'info1', 'info2'] as SignKey[])[v % 3];
  const W = 1.05;
  const H = W / 1.5;
  const tilt = 0.62; // radians back from vertical
  const cy = 1.0;
  for (const x of [-0.46, 0.46]) {
    k.add(wood, box(0.09, cy + 0.12, 0.09, { tile: 1, grain: 'y', off: x }).translate(x, (cy + 0.12) / 2 - 0.05, -0.06));
    k.add(M.concrete(), box(0.16, 0.06, 0.16).translate(x, 0.02, -0.06));
  }
  // panel: backing board + frame + face, tilted about X (top leans back)
  const m = mat(0, cy + 0.05, -0.02, -tilt, 0, 0);
  k.add(M.boards(M.STAIN.dark), box(W + 0.1, H + 0.1, 0.04, { tile: 1.2, grain: 'x' }), m);
  const face = quad(W, H, ...uvArr(key));
  face.translate(0, 0, 0.0215);
  k.add(M.signs(), face, m);
  // frame lips
  const fw = M.paint(M.COL.ironGreen);
  k.add(fw, box(W + 0.12, 0.03, 0.06).translate(0, -(H + 0.1) / 2, 0.01), m);
  k.add(fw, box(W + 0.12, 0.03, 0.06).translate(0, (H + 0.1) / 2, 0.01), m);
  k.add(fw, box(0.03, H + 0.1, 0.06).translate(-(W + 0.1) / 2, 0, 0.01), m);
  k.add(fw, box(0.03, H + 0.1, 0.06).translate((W + 0.1) / 2, 0, 0.01), m);
  // cross rail
  k.add(wood, box(0.92, 0.07, 0.04, { tile: 1, grain: 'x' }).translate(0, 0.45, -0.06));
  return k.build(`info${v}`);
}

function uvArr(key: SignKey): [number, number, number, number] {
  const r = signUV(key);
  return [r.u0, r.v0, r.u1, r.v1];
}

// ---------------------------------------------------------------------------
// Fountain: octagonal stone basin, baluster pedestal with two tiers of bowls,
// falling water sheets and a central jet (unique, animated).

function buildFountain(): THREE.Object3D {
  const k = new Kit();
  const st = M.ashlar();
  const oct = (pts: [number, number][], tile = 1.2) => flat(lathe(pts, 8, { tile, phi: Math.PI / 8 }));
  // outer basin wall + coping + inner wall + floor
  k.add(
    st,
    oct([
      [1.66, -0.08],
      [1.66, 0.4],
      [1.76, 0.42],
      [1.76, 0.52],
      [1.7, 0.55],
      [1.42, 0.55],
      [1.38, 0.52],
      [1.38, 0.15],
    ]),
  );
  k.add(M.concrete(), new THREE.CircleGeometry(1.39, 8, Math.PI / 8).rotateX(-Math.PI / 2).translate(0, 0.15, 0));
  // pedestal (round, smooth)
  const sm = (pts: [number, number][]) => lathe(pts, 16, { tile: 1.2 });
  k.add(
    st,
    sm([
      [0.0, 0.14],
      [0.42, 0.14],
      [0.42, 0.24],
      [0.34, 0.3],
      [0.24, 0.36],
      [0.2, 0.5],
      [0.23, 0.62],
      [0.16, 0.8],
      [0.13, 0.95],
      [0.2, 1.0],
    ]),
  );
  // lower bowl
  k.add(
    st,
    sm([
      [0.2, 0.99],
      [0.45, 1.04],
      [0.66, 1.12],
      [0.72, 1.16],
      [0.72, 1.2],
      [0.66, 1.2],
      [0.6, 1.14],
      [0.0, 1.12],
    ]),
  );
  // upper column + bowl + finial
  k.add(
    st,
    sm([
      [0.0, 1.12],
      [0.12, 1.12],
      [0.09, 1.25],
      [0.12, 1.36],
      [0.07, 1.5],
      [0.09, 1.62],
      [0.22, 1.66],
      [0.36, 1.72],
      [0.38, 1.76],
      [0.33, 1.76],
      [0.0, 1.73],
    ]),
  );
  k.add(st, sm([[0.0, 1.73], [0.06, 1.74], [0.08, 1.8], [0.05, 1.86], [0.035, 1.9], [0.045, 1.94], [0.0, 1.97]]));
  // still water surfaces (pool + bowls)
  const pool = new THREE.CircleGeometry(1.385, 8, Math.PI / 8).rotateX(-Math.PI / 2);
  setPlanarUV(pool, 1.5);
  k.addNamed('pool', M.fountainWater(), pool.translate(0, 0.42, 0));
  const b1 = new THREE.CircleGeometry(0.62, 16).rotateX(-Math.PI / 2);
  setPlanarUV(b1, 1.5);
  k.addNamed('pool', M.fountainWater(), b1.translate(0, 1.165, 0));
  const b2 = new THREE.CircleGeometry(0.33, 12).rotateX(-Math.PI / 2);
  setPlanarUV(b2, 1.5);
  k.addNamed('pool', M.fountainWater(), b2.translate(0, 1.745, 0));
  // falling sheets: open cones from bowl lips down to the water below
  const fall = (r0: number, y0: number, r1: number, y1: number, seg: number) => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      // parabolic fall: leaves the lip outward, accelerates down
      pts.push([r0 + (r1 - r0) * Math.sqrt(t), y0 + (y1 - y0) * t * t]);
    }
    const g = lathe(pts.reverse(), seg, { tile: 0.5 });
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    // V along the flow (top → bottom = 0 → 1), U around
    const n = pts.length;
    for (let i = 0; i <= seg; i++)
      for (let j = 0; j < n; j++) uv.setXY(i * n + j, (i / seg) * 6, 1 - j / (n - 1));
    return g;
  };
  k.addNamed('falls', M.fallingWater(), fall(0.73, 1.19, 0.86, 0.42, 24));
  k.addNamed('falls', M.fallingWater(), fall(0.385, 1.755, 0.45, 1.17, 16));
  // central jet (scaled in animate)
  const jet = new THREE.Group();
  jet.name = 'jet';
  const jg = lathe(
    [
      [0.0, 0.0],
      [0.018, 0.02],
      [0.022, 0.3],
      [0.03, 0.42],
      [0.0, 0.5],
    ],
    8,
    { tile: 0.5 },
  );
  const juv = jg.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < juv.count; i++) juv.setY(i, juv.getY(i) * 2);
  const out = k.build('fountain');
  const jm = new THREE.Mesh(jg, M.fallingWater());
  jm.userData.noShadow = true;
  jet.add(jm);
  jet.position.y = 1.95;
  out.add(jet);
  return out;
}

function setPlanarUV(g: THREE.BufferGeometry, tile: number): void {
  const p = g.getAttribute('position');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / tile, p.getZ(i) / tile);
}

function animateFountain(obj: THREE.Object3D, t: number): void {
  const ud = obj.userData as { jet?: THREE.Object3D | null; falls?: THREE.Mesh | null; pool?: THREE.Mesh | null };
  if (ud.jet === undefined) {
    ud.jet = obj.getObjectByName('jet') ?? null;
    ud.falls = (obj.getObjectByName('falls') as THREE.Mesh | undefined) ?? null;
    ud.pool = (obj.getObjectByName('pool') as THREE.Mesh | undefined) ?? null;
  }
  if (ud.jet) {
    const s = 1 + 0.12 * Math.sin(t * 7.3) + 0.06 * Math.sin(t * 13.1);
    ud.jet.scale.set(1, s, 1);
  }
  const fm = ud.falls?.material as THREE.MeshStandardMaterial | undefined;
  if (fm?.map) fm.map.offset.set(0, (t * 0.9) % 1);
  const pm = ud.pool?.material as THREE.MeshStandardMaterial | undefined;
  if (pm?.normalMap) pm.normalMap.offset.set((t * 0.013) % 1, (t * 0.021) % 1);
}

// ---------------------------------------------------------------------------

export function registerAmenities(): void {
  registerProp('bench', { variants: 3, build: buildBench });
  registerProp('bin', { variants: 2, build: buildBin });
  registerProp('lamp', { variants: 3, build: buildLamp });
  registerProp('picnic_table', { variants: 2, build: buildPicnic });
  registerProp('donation_box', { variants: 1, build: buildDonation });
  registerProp('info_sign', { variants: 3, build: buildInfo });
  registerProp('fountain', { variants: 1, unique: true, build: buildFountain, animate: animateFountain });
}
