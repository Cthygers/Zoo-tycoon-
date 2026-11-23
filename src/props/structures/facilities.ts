// Guest facilities: restroom block (2×2) and the zoo entrance gate (3×1,
// extends 1 m beyond the footprint on each side): stone piers carrying a
// timber arch with the "WILDHAVEN ZOO" board under a small tiled roof, two
// ticket booths and turnstile lanes. The central 2.3 m stays clear.

import * as THREE from 'three';
import { registerProp } from '../registry';
import { tiered } from './tiers';
import { door, frame, glazedWindow, interiorBox, signBoard, wallLantern } from './common';
import { box, cyl, gableEnd, gablePlanes, hipPlanes, Kit, mat, quad, rod, roof, V, wall } from './kit';
import * as M from './mats';
import { signUV } from './signs';

function moveInto(k: Kit, sub: Kit, m: THREE.Matrix4): void {
  const b = sub.build('sub');
  for (const c of [...b.children]) {
    const mm = c as THREE.Mesh;
    k.add(mm.material as THREE.Material, mm.geometry, m);
  }
}

// ---------------------------------------------------------------------------
// Restroom block

function buildRestroom(v: number): THREE.Object3D {
  const k = new Kit();
  const wallM = v === 1 ? M.render(M.COL.renderCream) : M.brick();
  const wallTile = v === 1 ? M.TILE.render : M.TILE.brick;
  const trim = M.paint(v === 1 ? M.COL.slate : M.COL.forest);
  const W = 3.5;
  const D = 2.7;
  const cz = -0.25;
  const zf = cz + D / 2;
  const T = 0.2;
  const y0 = 0.2;
  const yTop = 2.75;
  // concrete plinth
  k.add(M.concrete(), box(W + 0.08, y0 + 0.15, D + 0.08, { tile: 2 }).translate(0, (y0 - 0.15) / 2, cz));
  const d1: [number, number, number, number] = [-1.4, y0, -0.5, y0 + 2.0];
  const d2: [number, number, number, number] = [0.5, y0, 1.4, y0 + 2.0];
  const side: [number, number, number, number][] = [[-0.6, 2.05, 0.6, 2.45]];
  const o = { tile: wallTile, grain: 'x' as const };
  k.add(wallM, wall(-W / 2, W / 2, y0, yTop, T, [d1, d2], o).translate(0, 0, zf - T / 2));
  k.add(wallM, wall(-W / 2, W / 2, y0, yTop, T, [[-1.0, 2.05, -0.2, 2.45], [0.2, 2.05, 1.0, 2.45]], o).rotateY(Math.PI).translate(0, 0, cz - D / 2 + T / 2));
  for (const s of [-1, 1]) k.add(wallM, wall(-(D / 2 - T), D / 2 - T, y0, yTop, T, side, o).rotateY((s * Math.PI) / 2).translate(s * (W / 2 - T / 2), 0, cz));
  // soldier course / lintels over the doors (concrete)
  for (const dd of [d1, d2]) k.add(M.concrete(), box(dd[2] - dd[0] + 0.3, 0.15, T + 0.02, { tile: 2 }).translate((dd[0] + dd[2]) / 2, dd[3] + 0.075, zf - T / 2));
  // doors + plates
  door(k, trim, (d1[0] + d1[2]) / 2, y0, d1[2] - d1[0], d1[3] - d1[1], zf, { metal: trim });
  door(k, trim, (d2[0] + d2[2]) / 2, y0, d2[2] - d2[0], d2[3] - d2[1], zf, { handleRight: false, metal: trim });
  for (const [dd, key] of [
    [d1, 'women'],
    [d2, 'men'],
  ] as const) {
    const r = signUV(key);
    k.add(M.signsLit(), quad(0.2, 0.2, r.u0, r.v0, r.u1, r.v1).translate((dd[0] + dd[2]) / 2, y0 + 1.55, zf - 0.02));
  }
  // high frosted strip windows (back + sides), glowing at night
  const hw = (g: Kit, cx: number, w: number) => {
    interiorBox(g, cx, 2.25, w, 0.4, 0, 0.2, 'frosted', T);
    frame(g, trim, cx, 2.25, w, 0.4, -0.02, 0.05, 0.06, { sill: true, mullions: 1 });
  };
  for (const s of [-1, 1]) {
    const g = new Kit();
    hw(g, 0, 1.2);
    moveInto(k, g, mat(s * (W / 2), 0, cz, 0, (s * Math.PI) / 2, 0));
  }
  {
    const g = new Kit();
    hw(g, -0.6, 0.8);
    hw(g, 0.6, 0.8);
    moveInto(k, g, mat(0, 0, cz - D / 2, 0, Math.PI, 0));
  }
  // sign centred over the doors + wall lanterns
  signBoard(k, 'restrooms', 0, 2.55, zf + 0.03, 1.44, 0.36, { lit: true, backing: trim });
  for (const x of [-1.62, 1.62]) wallLantern(k, x, 1.95, zf, trim);
  // hand-wash basin between the doors
  k.add(M.concrete(), box(0.5, 0.12, 0.32, { tile: 2 }).translate(0, 0.95, zf + 0.16));
  k.add(M.concrete(), box(0.12, 0.75, 0.12, { tile: 2 }).translate(0, 0.48, zf + 0.1));
  k.add(trim, box(0.03, 0.12, 0.03).translate(0, 1.07, zf + 0.06));
  // hip roof: v0 slate-grey standing-seam metal, v1 clay tiles
  const ov = 0.25;
  const eaveY = yTop + 0.02;
  const rw = W + ov * 2;
  const rd = D + ov * 2;
  const pl = hipPlanes(rw, rd, eaveY, 1.0);
  for (const p of pl) for (const q of [p.el, p.er, p.tr, p.tl]) q.z += cz;
  if (v === 1) {
    const r = roof(pl, 0.1, { tile: 1 });
    k.add(M.clayTiles(), r.top);
    k.add(M.concrete(), r.under);
    k.add(trim, r.edge);
  } else {
    const sheet = M.corrugated(M.COL.charcoal);
    const r = roof(pl, 0.08, { tile: M.TILE.corrugated });
    k.add(sheet, r.top);
    k.add(M.concrete(), r.under);
    k.add(trim, r.edge);
  }
  // downpipe at the back corner
  k.add(trim, cyl(0.04, 0.04, yTop, 8).translate(W / 2 + 0.05, yTop / 2, cz - D / 2 - 0.05));
  return k.build(`restroom${v}`);
}

// ---------------------------------------------------------------------------
// Entrance gate

function booth(k: Kit, cx: number, mirror: boolean): void {
  const W = 1.3;
  const D = 1.6;
  const T = 0.12;
  const y0 = 0.5; // stone base height
  const yTop = 2.55;
  const clad = M.boards(M.STAIN.dark);
  const trim = M.hardwood(M.HW.honey);
  // stone base course
  k.add(M.ashlar(), box(W + 0.08, y0 + 0.15, D + 0.08, { tile: M.TILE.ashlar, off: cx }).translate(cx, (y0 - 0.15) / 2, 0));
  const zf = D / 2;
  // ticket window front (+Z)
  const win: [number, number, number, number] = [-0.42, 1.05, 0.42, 1.95];
  const g = new Kit();
  g.add(clad, wall(-W / 2, W / 2, y0, yTop, T, [win], { tile: M.TILE.boards, grain: 'y' }).translate(0, 0, zf - T / 2));
  g.add(clad, wall(-W / 2, W / 2, y0, yTop, T, [], { tile: M.TILE.boards, grain: 'y' }).rotateY(Math.PI).translate(0, 0, -zf + T / 2));
  // inner side: door to the turnstile lane; outer side: plain
  for (const s of [-1, 1]) {
    const inner = mirror ? s === -1 : s === 1;
    // door hole: local x maps to -z (s = +1) or +z (s = -1) after the turn
    const holes: [number, number, number, number][] = inner ? [[s > 0 ? -0.55 : -0.15, y0, s > 0 ? 0.15 : 0.55, y0 + 1.8]] : [];
    g.add(clad, wall(-(D / 2 - T), D / 2 - T, y0, yTop, T, holes, { tile: M.TILE.boards, grain: 'y' }).rotateY((s * Math.PI) / 2).translate(s * (W / 2 - T / 2), 0, 0));
  }
  glazedWindow(g, 0, (win[1] + win[3]) / 2, win[2] - win[0], win[3] - win[1], zf, T, 'booth', trim, { mullions: 0, depth: 0.9, glass: false });
  // ticket counter + speaking slot
  g.add(trim, box(0.95, 0.05, 0.3, { grain: 'x' }).translate(0, win[1] - 0.02, zf + 0.12));
  signBoard(g, 'tickets', 0, 2.25, zf + 0.03, 1.0, 0.25, { lit: true, backing: trim });
  // corner trims
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(trim, box(0.1, yTop - y0, 0.1, { grain: 'y' }).translate(sx * (W / 2 - 0.03), (y0 + yTop) / 2, sz * (D / 2 - 0.03)));
  // hip roof with clay tiles
  const pl = hipPlanes(W + 0.3, D + 0.36, yTop + 0.02, 0.75);
  const r = roof(pl, 0.09, { tile: 1 });
  g.add(M.clayTiles(), r.top);
  g.add(trim, r.under);
  g.add(trim, r.edge);
  g.add(M.clayTiles(), rod(pl[0].tl.clone().add(V(-0.04, 0.04, 0)), pl[0].tr.clone().add(V(0.04, 0.04, 0)), 0.07, 7, { tile: 0.6 }));
  // staff door leaf in the inner side opening (faces the turnstile lane)
  {
    const d = new Kit();
    const sx = mirror ? -1 : 1;
    door(d, trim, -0.2 * sx, y0, 0.7, 1.8, 0, { metal: trim });
    moveInto(g, d, mat(sx * (W / 2), 0, 0, 0, (sx * Math.PI) / 2, 0));
  }
  moveInto(k, g, mat(cx, 0, 0));
}

function buildGate(): THREE.Object3D {
  const k = new Kit();
  const stone = M.ashlar();
  const beamM = M.hardwood(M.HW.honey);
  // ticket booths at the outer ends
  booth(k, -3.2, false);
  booth(k, 3.2, true);
  // stone piers
  const PX = 2.25;
  const PH = 3.55;
  for (const sx of [-1, 1]) {
    const x = sx * PX;
    k.add(stone, box(0.64, PH, 0.64, { tile: M.TILE.ashlar, grain: 'x', off: sx * 0.7 }).translate(x, PH / 2 - 0.05, 0));
    k.add(stone, box(0.76, 0.14, 0.76, { tile: M.TILE.ashlar }).translate(x, 0.07, 0));
    k.add(stone, box(0.74, 0.12, 0.74, { tile: M.TILE.ashlar }).translate(x, PH - 0.02, 0));
    // lanterns on the pier faces (front + back)
    for (const sz of [-1, 1]) {
      const g = new Kit();
      wallLantern(g, 0, 2.45, 0, M.steel());
      moveInto(k, g, mat(x, 0, sz * 0.32, 0, sz > 0 ? 0 : Math.PI, 0));
    }
  }
  // timber arch: lower beam, sign board, upper beam, posts, knee braces
  const span = 2 * PX + 0.64 + 0.3;
  const yL = PH + 0.04;
  k.add(beamM, box(span, 0.3, 0.32, { grain: 'x' }).translate(0, yL + 0.15, 0));
  const yU = yL + 1.18;
  k.add(beamM, box(span + 0.2, 0.28, 0.3, { grain: 'x', off: 0.4 }).translate(0, yU + 0.14, 0));
  for (const sx of [-1, 1]) k.add(beamM, box(0.22, yU - yL - 0.3, 0.22, { grain: 'y' }).translate(sx * (PX + 0.05), (yL + 0.3 + yU) / 2, 0));
  // the board (double-sided: front and back faces)
  const sw = 3.9;
  const sh = sw / (1024 / 176);
  const sy = (yL + 0.3 + yU) / 2;
  signBoard(k, 'arch', 0, sy, 0.1, sw, sh, { lit: true, backing: M.boards(M.STAIN.dark), thick: 0.12, border: 0.05 });
  {
    const g = new Kit();
    signBoard(g, 'arch', 0, sy, 0.1, sw, sh, { lit: true, backing: M.boards(M.STAIN.dark), thick: 0.001, border: 0 });
    moveInto(k, g, mat(0, 0, 0, 0, Math.PI, 0));
  }
  // knee braces from piers to the lower beam (inside face of the opening)
  for (const sx of [-1, 1]) {
    const a = V(sx * (PX - 0.32), PH - 0.75, 0);
    const b = V(sx * (PX - 0.95), yL + 0.02, 0);
    const len = a.distanceTo(b);
    const g = box(0.14, len, 0.16, { grain: 'y' });
    g.rotateZ(Math.atan2(-(b.x - a.x), b.y - a.y));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
    k.add(beamM, g);
  }
  // gable roof over the arch (ridge along x), clay tiles
  const rw = span + 0.7;
  const pl = gablePlanes(rw, 1.5, yU + 0.3, 0.6);
  const r = roof(pl, 0.12, { tile: 1, rake: true });
  k.add(M.clayTiles(), r.top);
  k.add(beamM, r.under);
  k.add(beamM, r.edge);
  k.add(M.clayTiles(), rod(V(-rw / 2, yU + 0.92, 0), V(rw / 2, yU + 0.92, 0), 0.08, 8, { tile: 0.6 }));
  // gable triangles (boarded)
  for (const sx of [-1, 1]) {
    const g = gableEnd(1.2, yU + 0.28, 0.48, 0.06, { tile: M.TILE.boards, grain: 'y' });
    g.rotateY(Math.PI / 2).translate(sx * (span / 2 - 0.1), 0, 0);
    k.add(M.boards(M.STAIN.dark), g);
  }
  // logo roundel on the gable apex front + back
  {
    const r2 = signUV('logo');
    for (const s of [1, -1]) k.add(M.signsLit(), quad(0.46, 0.46, r2.u0, r2.v0, r2.u1, r2.v1).rotateY(s > 0 ? 0 : Math.PI).translate(0, yU + 0.62, s * 0.56));
  }
  // turnstiles: stainless cabinets at x = ±1.27 with tripod arms into the side lanes
  for (const sx of [-1, 1]) {
    const x = sx * 1.27;
    {
      // cabinet with a sloping reader top (profile in z/y, extruded along x)
      const sh = new THREE.Shape();
      sh.moveTo(-0.32, 0);
      sh.lineTo(0.32, 0);
      sh.lineTo(0.32, 0.88);
      sh.lineTo(0.18, 1.02);
      sh.lineTo(-0.32, 1.02);
      sh.closePath();
      const g = new THREE.ExtrudeGeometry(sh, { depth: 0.24, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 1 });
      g.rotateY(-Math.PI / 2);
      g.translate(x + 0.12, 0, 0);
      k.add(M.steel(), g);
      k.add(stone, box(0.36, 0.05, 0.74, { tile: M.TILE.ashlar }).translate(x, 0.025, 0));
    }
    // hub + three arms (one horizontal into the lane)
    const hub = V(x + sx * 0.13, 0.9, 0.05);
    k.add(M.steel(), cyl(0.06, 0.06, 0.08, 10).rotateZ(Math.PI / 2).translate(hub.x + sx * 0.03, hub.y, hub.z));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const dir = V(sx * 0.35, Math.cos(a) * 0.47, Math.sin(a) * 0.47).normalize();
      k.add(M.steel(), rod(hub, hub.clone().addScaledVector(dir, 0.48), 0.018, 6));
    }

    // low railing from the cabinet out to the pier, behind the lane
    k.add(M.steel(), rod(V(x, 0.95, -0.31), V(sx * (PX - 0.32), 0.95, -0.31), 0.02, 6));
    k.add(M.steel(), rod(V(sx * (PX - 0.34), 0.0, -0.31), V(sx * (PX - 0.34), 0.95, -0.31), 0.02, 6));
  }
  // paving threshold strip
  k.add(stone, box(4.0, 0.03, 0.7, { tile: M.TILE.ashlar }).translate(0, 0.015, 0));
  return k.build('gate');
}

export function registerFacilities(): void {
  registerProp('restroom', { variants: 2, ...tiered(buildRestroom) });
  registerProp('entrance_gate', { variants: 1, ...tiered(buildGate) });
}

