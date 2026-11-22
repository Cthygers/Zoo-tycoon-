// Guest shops: thatched snack kiosk (2×2), drinks kiosk (1×1), ice-cream
// cart (1×1) and gift shop (2×2). Serving counters face +Z.

import * as THREE from 'three';
import { projectBoxUVs } from '../materials';
import { registerProp } from '../registry';
import { door, frame, glazedDoor, glazedWindow, interiorBox, post, signBoard, signFace, wallLantern } from './common';
import { box, cyl, gableEnd, gablePlanes, hipPlanes, Kit, lathe, mat, quad, rod, roof, skillionPlane, V, wall } from './kit';
import * as M from './mats';
import { signUV, type SignKey } from './signs';

/** Map all UVs of a geometry onto one flat-colour swatch of the sign atlas. */
function swatch(g: THREE.BufferGeometry, key: SignKey): THREE.BufferGeometry {
  const r = signUV(key);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const u = (r.u0 + r.u1) / 2;
  const v = (r.v0 + r.v1) / 2;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u, v);
  return g;
}

/** Move every mesh of a sub-kit into k with a transform. */
function moveInto(k: Kit, sub: Kit, m: THREE.Matrix4): void {
  const b = sub.build('sub');
  for (const c of [...b.children]) {
    const mm = c as THREE.Mesh;
    k.add(mm.material as THREE.Material, mm.geometry, m);
  }
}

/** Stone / concrete plinth course under walls. */
function plinth(k: Kit, w: number, d: number, h: number, cz = 0, m: THREE.Material = M.ashlar()): void {
  k.add(m, box(w, h + 0.15, d, { tile: M.TILE.ashlar, off: 0.2 }).translate(0, (h - 0.15) / 2, cz));
}

/** Four walls of a rectangular building: front wall gets openings. */
function walls(
  k: Kit,
  m: THREE.Material,
  w: number,
  d: number,
  y0: number,
  y1: number,
  t: number,
  front: [number, number, number, number][],
  cz: number,
  opts: { tile: number; grain: 'x' | 'y'; back?: [number, number, number, number][]; sides?: [number, number, number, number][] },
): void {
  const o = { tile: opts.tile, grain: opts.grain };
  // front & back span the full width; sides fit between
  k.add(m, wall(-w / 2, w / 2, y0, y1, t, front, o).translate(0, 0, cz + d / 2 - t / 2));
  k.add(m, wall(-w / 2, w / 2, y0, y1, t, opts.back ?? [], o).rotateY(Math.PI).translate(0, 0, cz - d / 2 + t / 2));
  for (const s of [-1, 1]) {
    const g = wall(-(d / 2 - t), d / 2 - t, y0, y1, t, opts.sides ?? [], o);
    g.rotateY((s * Math.PI) / 2);
    g.translate(s * (w / 2 - t / 2), 0, cz);
    k.add(m, g);
  }
}

// ---------------------------------------------------------------------------
// Snack kiosk (2×2): timber hut, thatched pyramid roof, serving hatch with a
// propped shutter, counter, fascia sign, A-board menu.

function buildSnack(v: number): THREE.Object3D {
  const k = new Kit();
  const clad = M.boards(v === 1 ? M.STAIN.sage : M.STAIN.oak);
  const trim = M.hardwood(v === 1 ? M.HW.dark : M.HW.honey);
  const W = 2.7;
  const D = 2.65;
  const cz = -0.1;
  const zf = cz + D / 2; // front face z
  const T = 0.12;
  const y0 = 0.25;
  const yTop = 2.6;
  plinth(k, W + 0.1, D + 0.1, y0, cz);
  // hatch opening
  const hx0 = -1.0;
  const hx1 = 1.0;
  const hy0 = 1.02;
  const hy1 = 2.0;
  walls(k, clad, W, D, y0, yTop, T, [[hx0, hy0, hx1, hy1]], cz, { tile: M.TILE.boards, grain: 'y', back: [[0.35, 0.25 + y0, 1.15, 2.2]] });
  // back door (staff)
  {
    // staff door on the back wall (built facing +Z, turned to face -Z)
    const g = new Kit();
    door(g, trim, 0, y0, 0.8, 1.95, 0, { metal: trim });
    moveInto(k, g, mat(-0.75, 0, cz - D / 2, 0, Math.PI, 0));
  }
  // corner posts (trim)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) post(k, trim, sx * (W / 2 - 0.02), cz + sz * (D / 2 - 0.02), y0, yTop, 0.14, sx + sz);
  // interior + counter
  interiorBox(k, 0, (hy0 + hy1) / 2, hx1 - hx0, hy1 - hy0, zf, 1.0, 'kitchen', T);
  k.add(trim, box(hx1 - hx0 + 0.3, 0.05, 0.42, { grain: 'x' }).translate(0, hy0 - 0.005, zf + 0.1));
  for (const x of [-0.8, 0.8]) k.add(trim, box(0.05, 0.2, 0.25, { grain: 'y' }).translate(x, hy0 - 0.13, zf + 0.12));
  frame(k, trim, 0, (hy0 + hy1) / 2, hx1 - hx0, hy1 - hy0, zf + 0.005, 0.06, 0.06);
  // pelmet board over the hatch
  k.add(trim, box(hx1 - hx0 + 0.2, 0.16, 0.05, { grain: 'x' }).translate(0, hy1 + 0.13, zf + 0.03));
  // roof-top sign board on two posts, standing proud of the thatch so it
  // reads from the elevated game camera
  {
    const g = new Kit();
    signBoard(g, 'snacks', 0, 0.3, 0.0, 1.6, 0.4, { lit: true, backing: trim, thick: 0.06 });
    for (const x of [-0.55, 0.55]) g.add(trim, box(0.08, 0.75, 0.08, { grain: 'y' }).translate(x, -0.12, -0.08));
    moveInto(k, g, mat(0, 3.02, zf + 0.12, -0.12, 0, 0));
  }
  // lights under the eave
  for (const x of [-1.32, 1.32]) wallLantern(k, x, 1.95, zf, trim);
  // thatched pyramid roof with hip rolls and a timber finial
  const ov = 0.45;
  const eaveY = 2.45;
  const rise = 1.7;
  const rw = Math.min(W + ov * 2, 3.55);
  const rd = Math.min(D + ov * 2, 3.55);
  const pl = hipPlanes(rw, rd, eaveY, rise);
  for (const p of pl) for (const q of [p.el, p.er, p.tr, p.tl]) q.z += cz;
  const r = roof(pl, 0.3, { tile: 1 });
  k.add(M.thatch(), r.top);
  k.add(M.thatch(), r.under);
  k.add(M.thatch(), r.edge);
  const apex = V(pl[0].tl.x, eaveY + rise, pl[0].tl.z);
  // hip rolls (bound thatch ridges) along each hip line
  for (const c of [pl[0].el, pl[0].er, pl[1].el, pl[1].er]) {
    const g = rod(c.clone().add(V(0, 0.04, 0)), apex.clone().add(V(0, 0.05, 0)), 0.11, 7, { tile: 1 });
    k.add(M.thatch(), g);
  }
  if (pl[0].tl.x !== pl[0].tr.x) k.add(M.thatch(), rod(pl[0].tl.clone().add(V(-0.05, 0.06, 0)), pl[0].tr.clone().add(V(0.05, 0.06, 0)), 0.13, 7));
  k.add(trim, lathe([[0.0, 0], [0.09, 0.0], [0.07, 0.25], [0.11, 0.32], [0.0, 0.42]], 8).translate(apex.x, apex.y - 0.02, apex.z));
  // ridge/wall plate under the eaves
  k.add(trim, box(W + 0.1, 0.14, D + 0.1, { grain: 'x' }).translate(0, yTop + 0.02, cz));
  // A-frame menu board at front right
  {
    const g = new Kit();
    const bw = 0.55;
    const bh = 0.78;
    const th = Math.atan2(0.18, bh);
    const r2 = signUV('menu');
    for (const back of [false, true]) {
      const brd = box(bw + 0.06, bh, 0.025, { grain: 'y' }).translate(0, bh / 2, 0);
      const face = quad(bw, bw, r2.u0, r2.v0, r2.u1, r2.v1).translate(0, bh / 2 + 0.06, 0.0135);
      for (const [geo, mm] of [
        [brd, trim],
        [face, M.signsLit()],
      ] as const) {
        geo.translate(0, -bh / 2, 0).rotateX(-th).translate(0, bh / 2, 0.1);
        if (back) geo.rotateY(Math.PI);
        g.add(mm, geo);
      }
    }
    moveInto(k, g, mat(1.4, 0, 1.5, 0, -0.35, 0));
  }
  // bin beside the counter (simple) + stools are left to placed props
  return k.build(`snack${v}`);
}

// ---------------------------------------------------------------------------
// Drinks kiosk (1×1): rendered box, serving window onto a glass-door fridge,
// mono-pitch metal roof, sign board on the roof edge.

function buildDrinks(v: number): THREE.Object3D {
  const k = new Kit();
  const wallM = v === 1 ? M.boards(M.STAIN.dark) : M.render(M.COL.renderCream);
  const tileW = v === 1 ? M.TILE.boards : M.TILE.render;
  const trim = M.paint(v === 1 ? M.COL.ironBlack : M.COL.forest);
  const W = 1.6;
  const D = 1.35;
  const cz = -0.18;
  const zf = cz + D / 2;
  const T = 0.1;
  const y0 = 0.18;
  const yTop = 2.3;
  plinth(k, W + 0.06, D + 0.06, y0, cz, trim);
  const wx0 = -0.6;
  const wx1 = 0.6;
  const wy0 = 0.98;
  const wy1 = 1.9;
  walls(k, wallM, W, D, y0, yTop, T, [[wx0, wy0, wx1, wy1]], cz, { tile: tileW, grain: v === 1 ? 'y' : 'x', back: [[-0.35, y0 + 0.02, 0.4, 2.05]] });
  {
    const g = new Kit();
    door(g, trim, 0, y0 + 0.02, 0.75, 1.87, 0, { metal: trim });
    moveInto(k, g, mat(-0.025, 0, cz - D / 2, 0, Math.PI, 0));
  }
  interiorBox(k, 0, (wy0 + wy1) / 2, wx1 - wx0, wy1 - wy0, zf, 0.55, 'fridge', T);
  frame(k, trim, 0, (wy0 + wy1) / 2, wx1 - wx0, wy1 - wy0, zf + 0.005, 0.05, 0.06);
  k.add(trim, box(wx1 - wx0 + 0.26, 0.04, 0.34).translate(0, wy0 - 0.005, zf + 0.12));
  for (const x of [-0.5, 0.5]) k.add(trim, box(0.04, 0.18, 0.22).translate(x, wy0 - 0.12, zf + 0.1));
  // roller-shutter box above the window
  k.add(trim, box(wx1 - wx0 + 0.16, 0.16, 0.14).translate(0, wy1 + 0.1, zf + 0.06));
  // corner trims
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add(trim, box(0.05, yTop - y0, 0.05).translate(sx * (W / 2 + 0.005), (yTop + y0) / 2, cz + sz * (D / 2 + 0.005)));
  // roof: falls to the back
  const zl = cz - D / 2 - 0.2;
  const zh = Math.min(zf + 0.32, 0.99);
  const pl = skillionPlane(1.96, zl, yTop + 0.06, zh, yTop + 0.26);
  const r = roof(pl, 0.06, { tile: M.TILE.corrugated, rake: true, top: true });
  const sheet = M.corrugated(v === 1 ? M.COL.charcoal : M.COL.slate);
  k.add(sheet, r.top);
  k.add(sheet, r.under);
  k.add(trim, r.edge);
  {
    // wedge infill between the wall tops and the sloping roof underside
    const slope = 0.2 / (zh - zl);
    const yUnder = (z: number) => yTop + 0.06 + (z - zl) * slope - 0.065;
    const zb = cz - D / 2;
    const sh = new THREE.Shape();
    sh.moveTo(zb, yTop - 0.01);
    sh.lineTo(zf, yTop - 0.01);
    sh.lineTo(zf, yUnder(zf));
    sh.lineTo(zb, yUnder(zb));
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: W, bevelEnabled: false });
    g.rotateY(-Math.PI / 2);
    g.translate(W / 2, 0, 0);
    projectBoxUVs(g, tileW, v === 1 ? 'y' : 'x');
    k.add(wallM, g);
  }
  // sign board standing on the roof front
  signBoard(k, 'drinks', 0, yTop + 0.55, zh - 0.12, 1.4, 0.35, { lit: true, backing: trim });
  for (const x of [-0.5, 0.5]) k.add(trim, box(0.04, 0.3, 0.04).translate(x, yTop + 0.3, zh - 0.17));
  return k.build(`drinks${v}`);
}

// ---------------------------------------------------------------------------
// Ice-cream cart (1×1): painted cart on two spoked wheels, stainless lids,
// striped parasol.

const PARASOL: [number, number][] = [
  [0x8e3029, 0xe4d9c0],
  [0x2f6564, 0xe4d9c0],
  [0xb48a35, 0xe7dfca],
];

function wheel(k: Kit, x: number, y: number, z: number, r: number): void {
  const tyre = new THREE.TorusGeometry(r - 0.02, 0.022, 3, 20);
  k.add(M.rubber(), tyre.translate(x, y, z));
  const rimM = M.rubber();
  k.add(rimM, new THREE.TorusGeometry(r - 0.045, 0.008, 3, 20).translate(x, y, z));
  k.add(M.steel(), cyl(0.035, 0.035, 0.06, 6).rotateX(Math.PI / 2).translate(x, y, z));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    k.add(M.steel(), rod(V(x, y, z + (i % 2 ? 0.02 : -0.02)), V(x + Math.cos(a) * (r - 0.05), y + Math.sin(a) * (r - 0.05), z), 0.0035, 3, { caps: false }));
  }
}

function buildIceCream(v: number): THREE.Object3D {
  const k = new Kit();
  const [ca, cb] = PARASOL[v % PARASOL.length];
  const body = M.paint(0xe2dccd);
  const accent = M.paint(ca);
  // cart body
  const L = 1.25;
  const H0 = 0.36;
  const H1 = 0.98;
  const D = 0.7;
  k.add(body, box(L, H1 - H0, D, { tile: 1 }).translate(0, (H0 + H1) / 2, 0));
  // accent band + skirt
  k.add(accent, box(L + 0.01, 0.08, D + 0.01).translate(0, H0 + 0.08, 0));
  k.add(accent, box(L + 0.03, 0.04, D + 0.03).translate(0, H1 - 0.02, 0));
  // front sign + flavour panel
  const sw = 0.92;
  k.add(M.signs(), signFace('icecream', sw, sw / 4).translate(-0.08, 0.76, D / 2 + 0.003));
  const fr = signUV('flavours');
  k.add(M.signs(), quad(0.2, 0.2, fr.u0, fr.v0, fr.u1, fr.v1).translate(0.49, 0.75, D / 2 + 0.003));
  // stainless top with two round lids
  k.add(M.steel(), box(L + 0.04, 0.03, D + 0.04).translate(0, H1 + 0.015, 0));
  for (const x of [-0.3, 0.12]) {
    k.add(M.steel(), lathe([[0.17, 0.0], [0.17, 0.02], [0.12, 0.06], [0.0, 0.07]], 10, { tile: 0.5 }).translate(x, H1 + 0.03, 0));
    k.add(M.rubber(), cyl(0.012, 0.012, 0.03, 6).translate(x, H1 + 0.11, 0));
  }
  // cone dispenser box
  k.add(M.steel(), cyl(0.05, 0.05, 0.3, 8, { caps: true }).translate(0.47, H1 + 0.16, -0.18));
  // wheels on the right end, leg + handle on the left
  for (const z of [-D / 2 - 0.04, D / 2 + 0.04]) wheel(k, 0.38, 0.3, z, 0.3);
  const iron = M.rubber();
  k.add(iron, rod(V(0.38, 0.3, -D / 2 - 0.06), V(0.38, 0.3, D / 2 + 0.06), 0.015, 6));
  for (const z of [-0.25, 0.25]) {
    k.add(iron, rod(V(-0.5, H0, z), V(-0.52, 0.0, z), 0.016, 6, { caps: false }));
    k.add(M.rubber(), cyl(0.025, 0.025, 0.02, 6).translate(-0.52, 0.01, z));
    k.add(iron, rod(V(-L / 2, 0.82, z), V(-L / 2 - 0.26, 0.92, z), 0.015, 6, { caps: false }));
  }
  k.add(iron, rod(V(-L / 2 - 0.26, 0.92, -0.3), V(-L / 2 - 0.26, 0.92, 0.3), 0.018, 8));
  // parasol
  const pole = V(0.0, H1, -0.05);
  k.add(M.steel(), rod(pole, V(0.0, 2.32, -0.05), 0.018, 6));
  const R = 0.95;
  const gores = 8;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    pts.push([R * t, 2.34 - 0.36 * Math.pow(t, 1.35)]);
  }
  pts.reverse();
  const canopy = lathe(pts, gores * 2, { tile: 1 });
  // flat facets per gore: rebuild as non-indexed with flat normals + stripe UVs
  const cp = canopy.getAttribute('position') as THREE.BufferAttribute;
  const cuv = canopy.getAttribute('uv') as THREE.BufferAttribute;
  const n = pts.length;
  for (let i = 0; i <= gores * 2; i++)
    for (let j = 0; j < n; j++) {
      const idx = i * n + j;
      // scallop the gore between ribs (rib = every 2nd lathe segment)
      const onRib = i % 2 === 0;
      const rr = Math.hypot(cp.getX(idx), cp.getZ(idx));
      if (!onRib && rr > 0) {
        const f = 1 - 0.035 * (rr / R);
        cp.setXYZ(idx, cp.getX(idx) * f, cp.getY(idx) + 0.025 * (rr / R), cp.getZ(idx) * f);
      }
      cuv.setXY(idx, (i / (gores * 2)) * (gores / 2), (pts[j][0] / R) * 2);
    }
  canopy.computeVertexNormals();
  const fab = M.fabric(ca, cb);
  k.add(fab, canopy.translate(pole.x, 0, pole.z));
  // valance skirt
  const val = cyl(R * 0.985, R * 0.985, 0.12, gores * 2, { caps: false });
  const vuv = val.getAttribute('uv') as THREE.BufferAttribute;
  const vpos = val.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < vuv.count; i++) {
    const a = Math.atan2(vpos.getZ(i), vpos.getX(i));
    vuv.setXY(i, ((a / (Math.PI * 2) + 1) % 1) * (gores / 2), vpos.getY(i));
  }
  k.add(fab, val.translate(pole.x, 2.34 - 0.36 - 0.05, pole.z));
  // ribs
  for (let i = 0; i < gores; i++) {
    const a = (i / gores) * Math.PI * 2;
    k.add(M.steel(), rod(V(pole.x, 2.33, pole.z), V(pole.x + Math.cos(a) * R * 0.99, 1.97, pole.z + Math.sin(a) * R * 0.99), 0.006, 3, { caps: false }));
  }
  k.add(accent, new THREE.SphereGeometry(0.035, 6, 4).translate(pole.x, 2.38, pole.z));
  return k.build(`icecream${v}`);
}

// ---------------------------------------------------------------------------
// Gift shop (2×2): rendered walls on a stone plinth, clay-tile gable roof,
// display window with merchandise, glazed door, canopy, fascia sign.

function buildGift(v: number): THREE.Object3D {
  const k = new Kit();
  const wallC = v === 1 ? M.COL.renderSage : M.COL.renderCream;
  const wallM = M.render(wallC);
  const trim = M.paint(v === 1 ? M.COL.oxblood : M.COL.forest);
  const W = 3.4;
  const D = 2.9;
  const cz = -0.3;
  const zf = cz + D / 2;
  const T = 0.18;
  const y0 = 0.35;
  const yTop = 2.9;
  plinth(k, W + 0.08, D + 0.08, y0, cz);
  // openings: display window left, glazed door right
  const win: [number, number, number, number] = [-1.45, 0.8, 0.2, 2.15];
  const dr: [number, number, number, number] = [0.55, y0, 1.4, 2.45];
  walls(k, wallM, W, D, y0, yTop, T, [win, dr], cz, { tile: M.TILE.render, grain: 'x', sides: [[-0.6, 1.2, 0.6, 2.1]] });
  // display window + merch
  glazedWindow(k, (win[0] + win[2]) / 2, (win[1] + win[3]) / 2, win[2] - win[0], win[3] - win[1], zf, T, 'gift', trim, { mullions: 1, depth: 0.85 });
  // shelf with plush toys right behind the glass (flat-colour swatches of the
  // sign atlas, so they add no material and glow softly with the lit window)
  {
    const sx = (win[0] + win[2]) / 2;
    k.add(trim, box(win[2] - win[0], 0.04, 0.3).translate(sx, win[1] + 0.02, zf - T - 0.15));
    const lit = M.signsLit();
    (['swBrown', 'swBeige', 'swBrown', 'swGrey'] as const).forEach((key, i) => {
      const x = win[0] + 0.25 + i * 0.4;
      const yb = win[1] + 0.04;
      const z = zf - T - 0.15;
      k.add(lit, swatch(new THREE.SphereGeometry(0.1, 10, 8).scale(1, 1.15, 0.9).translate(x, yb + 0.11, z), key));
      k.add(lit, swatch(new THREE.SphereGeometry(0.075, 10, 8).translate(x, yb + 0.28, z + 0.02), key));
      k.add(lit, swatch(new THREE.SphereGeometry(0.03, 6, 5).translate(x - 0.06, yb + 0.34, z + 0.01), key));
      k.add(lit, swatch(new THREE.SphereGeometry(0.03, 6, 5).translate(x + 0.06, yb + 0.34, z + 0.01), key));
    });
  }
  glazedDoor(k, trim, (dr[0] + dr[2]) / 2, y0, dr[2] - dr[0], dr[3] - dr[1], zf, T, 'door', trim);
  // side window (frosted / shelves)
  for (const s of [-1, 1]) {
    const g = new Kit();
    glazedWindow(g, 0, 1.65, 1.2, 0.9, 0, T, 'gift', trim, { mullions: 1, depth: 0.5, glass: false });
    moveInto(k, g, mat(s * (W / 2), 0, cz, 0, (s * Math.PI) / 2, 0));
  }
  // fascia sign + canopy over the front
  signBoard(k, 'gifts', -0.35, 2.55, zf + 0.04, 1.6, 0.4, { lit: true, backing: trim });
  {
    // timber canopy on brackets over the window and door
    const cw = 3.0;
    const depth = 0.55;
    const ang = 0.35;
    const m = mat(0, 2.3, zf, ang, 0, 0);
    k.add(M.clayTiles(), quad(cw, depth, 0, 0, cw, depth).rotateX(-Math.PI / 2).translate(0, 0.04, depth / 2), m);
    k.add(trim, box(cw, 0.04, depth, { grain: 'x' }).translate(0, 0.0, depth / 2), m);
    k.add(trim, box(cw + 0.02, 0.1, 0.04).translate(0, 0.0, depth), m);
    for (const x of [-1.4, 0, 1.4]) {
      const a = V(x, 1.95, zf);
      const b = V(x, 2.3 - Math.sin(ang) * 0.5, zf + Math.cos(ang) * 0.5);
      k.add(trim, rod(a, b, 0.02, 5));
    }
  }
  wallLantern(k, 1.62, 2.15, zf, trim);
  // gable roof (ridge along x) with clay tiles, timber soffit and bargeboards
  const ov = 0.28;
  const eaveY = yTop + 0.05;
  const rise = 1.25;
  const rw = W + 0.5;
  const rd = D + ov * 2;
  const pl = gablePlanes(rw, rd, eaveY, rise);
  for (const p of pl) for (const q of [p.el, p.er, p.tr, p.tl]) q.z += cz;
  const r = roof(pl, 0.1, { tile: 1, rake: true });
  k.add(M.clayTiles(), r.top);
  k.add(wallM, r.under);
  k.add(trim, r.edge);
  // ridge tiles
  k.add(M.clayTiles(), rod(V(-rw / 2, eaveY + rise + 0.02, cz), V(rw / 2, eaveY + rise + 0.02, cz), 0.09, 8, { tile: 0.6 }));
  // gable end walls (render) under the roof
  for (const s of [-1, 1]) {
    const g = gableEnd(D, yTop - 0.001, (rise * D) / rd + 0.05, T, { tile: M.TILE.render });
    g.rotateY((s * Math.PI) / 2).translate(s * (W / 2 - T / 2), 0, cz);
    k.add(wallM, g);
  }
  // balloons tied by the door
  {
    const bx = 1.55;
    const bz = zf + 0.25;
    (['swRed', 'swYellow', 'swBlue'] as const).forEach((key, i) => {
      const top = V(bx + (i - 1) * 0.18, 2.35 + (i % 2) * 0.15, bz + (i - 1) * 0.06);
      k.add(M.signsLit(), swatch(new THREE.SphereGeometry(0.13, 10, 8).scale(1, 1.2, 1).translate(top.x, top.y, top.z), key));
      k.add(trim, rod(V(bx, 1.05, zf + 0.05), top.clone().add(V(0, -0.15, 0)), 0.003, 3, { caps: false }));
    });
  }
  return k.build(`gift${v}`);
}

// ---------------------------------------------------------------------------

export function registerShops(): void {
  registerProp('shop_snack', { variants: 2, build: buildSnack });
  registerProp('shop_drinks', { variants: 2, build: buildDrinks });
  registerProp('shop_icecream', { variants: 3, build: buildIceCream });
  registerProp('shop_gift', { variants: 2, build: buildGift });
}

