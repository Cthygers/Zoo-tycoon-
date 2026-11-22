// Building helpers shared by structure builders: framed windows with an
// interior view box, doors, sign boards, simple posts and small fittings.
// All functions add geometry to a Kit (merged per material by the caller).

import * as THREE from 'three';
import { box, Kit, quad, V } from './kit';
import * as M from './mats';
import { interiorUV, signUV, type InteriorKey, type SignKey } from './signs';

/**
 * Interior seen through an opening in a wall whose outer face lies at z = zf
 * (facing +Z). Back panel shows the atlas region; sides/top/bottom use the
 * region's darker border so the view reads as a shallow room.
 */
export function interiorBox(k: Kit, cx: number, cy: number, w: number, h: number, zf: number, depth: number, key: InteriorKey, wallT: number): void {
  const mat = M.interior();
  const r = interiorUV(key);
  const zb = zf - wallT - depth;
  // back
  k.add(mat, quad(w + 0.02, h + 0.02, r.u0, r.v0, r.u1, r.v1).translate(cx, cy, zb));
  // sample the dark region at one texel so mip levels never bleed neighbours in
  const dr = interiorUV('dark');
  const du = (dr.u0 + dr.u1) / 2;
  const dv = (dr.v0 + dr.v1) / 2;
  const d = { u0: du, v0: dv, u1: du, v1: dv };
  const zm = zf - wallT - depth / 2;
  // left / right (facing inward)
  k.add(mat, quad(depth, h, d.u0, d.v0, d.u1, d.v1).rotateY(Math.PI / 2).translate(cx - w / 2, cy, zm));
  k.add(mat, quad(depth, h, d.u0, d.v0, d.u1, d.v1).rotateY(-Math.PI / 2).translate(cx + w / 2, cy, zm));
  // ceiling (facing down) + floor (facing up): darker strip of the region's top/bottom
  k.add(mat, quad(w, depth, d.u0, d.v0, d.u1, d.v1).rotateX(Math.PI / 2).translate(cx, cy + h / 2, zm));
  k.add(mat, quad(w, depth, d.u0, d.v0, d.u1, d.v1).rotateX(-Math.PI / 2).translate(cx, cy - h / 2, zm));
}

/** Rectangular frame of square bars around an opening (in the XY plane at z). */
export function frame(k: Kit, mat: THREE.Material, cx: number, cy: number, w: number, h: number, z: number, bar: number, depth: number, opts: { sill?: boolean; mullions?: number; transom?: number } = {}): void {
  const t = { tile: 1, grain: 'y' as const };
  k.add(mat, box(bar, h + bar * 2, depth, t).translate(cx - w / 2 - bar / 2, cy, z));
  k.add(mat, box(bar, h + bar * 2, depth, t).translate(cx + w / 2 + bar / 2, cy, z));
  k.add(mat, box(w, bar, depth, { tile: 1 }).translate(cx, cy + h / 2 + bar / 2, z));
  if (opts.sill) k.add(mat, box(w + bar * 3, bar * 1.2, depth + 0.06, { tile: 1 }).translate(cx, cy - h / 2 - bar * 0.6, z + 0.03));
  else k.add(mat, box(w, bar, depth, { tile: 1 }).translate(cx, cy - h / 2 - bar / 2, z));
  const nm = opts.mullions ?? 0;
  for (let i = 1; i <= nm; i++) {
    const x = cx - w / 2 + (w * i) / (nm + 1);
    k.add(mat, box(bar * 0.6, h, depth * 0.8, t).translate(x, cy, z));
  }
  if (opts.transom !== undefined) k.add(mat, box(w, bar * 0.6, depth * 0.8, { tile: 1 }).translate(cx, opts.transom, z));
}

/** Glazed window in a wall face at z = zf (outer face), with interior view. */
export function glazedWindow(
  k: Kit,
  cx: number,
  cy: number,
  w: number,
  h: number,
  zf: number,
  wallT: number,
  key: InteriorKey,
  frameMat: THREE.Material,
  opts: { mullions?: number; depth?: number; sill?: boolean; transom?: number; glass?: boolean } = {},
): void {
  interiorBox(k, cx, cy, w, h, zf, opts.depth ?? 0.7, key, wallT);
  if (opts.glass !== false) k.add(M.glass(), quad(w, h).translate(cx, cy, zf - 0.04));
  frame(k, frameMat, cx, cy, w, h, zf - 0.02, 0.06, 0.08, { sill: opts.sill ?? true, mullions: opts.mullions, transom: opts.transom });
}

/** Solid panelled door leaf in an opening (bottom at y0) on a wall face z = zf. */
export function door(k: Kit, mat: THREE.Material, cx: number, y0: number, w: number, h: number, zf: number, opts: { handleRight?: boolean; metal?: THREE.Material } = {}): void {
  const zl = zf - 0.05;
  k.add(mat, box(w - 0.02, h - 0.01, 0.045, { tile: 1, grain: 'y' }).translate(cx, y0 + h / 2, zl));
  // raised panels
  const pw = (w - 0.2) / 2;
  for (const sx of [-1, 1])
    for (const [py, ph] of [
      [y0 + h * 0.28, h * 0.36],
      [y0 + h * 0.72, h * 0.4],
    ] as const)
      k.add(mat, box(pw - 0.04, ph, 0.02, { tile: 1, grain: 'y' }).translate(cx + sx * (pw / 2 + 0.03), py, zl + 0.028));
  // frame
  frame(k, mat, cx, y0 + h / 2, w, h, zf - 0.01, 0.05, 0.09);
  // handle + kick plate
  const hx = cx + (opts.handleRight === false ? -1 : 1) * (w / 2 - 0.1);
  const metal = opts.metal ?? M.steel();
  k.add(metal, box(0.12, 0.025, 0.04).translate(hx, y0 + 1.0, zl + 0.05));
  k.add(metal, box(0.025, 0.08, 0.02).translate(hx + 0.05 * (opts.handleRight === false ? -1 : 1), y0 + 1.0, zl + 0.03));
  k.add(metal, box(w - 0.08, 0.18, 0.006).translate(cx, y0 + 0.1, zl + 0.026));
}

/** Glazed door (shop front): frame, glass, interior behind. */
export function glazedDoor(k: Kit, frameMat: THREE.Material, cx: number, y0: number, w: number, h: number, zf: number, wallT: number, key: InteriorKey, metal: THREE.Material = M.steel()): void {
  interiorBox(k, cx, y0 + h / 2, w, h, zf, 0.9, key, wallT);
  const zl = zf - 0.05;
  const s = 0.08;
  // leaf frame (stiles + rails)
  k.add(frameMat, box(s, h, 0.05, { grain: 'y' }).translate(cx - w / 2 + s / 2, y0 + h / 2, zl));
  k.add(frameMat, box(s, h, 0.05, { grain: 'y' }).translate(cx + w / 2 - s / 2, y0 + h / 2, zl));
  k.add(frameMat, box(w, 0.22, 0.05).translate(cx, y0 + 0.11, zl));
  k.add(frameMat, box(w, s, 0.05).translate(cx, y0 + h - s / 2, zl));
  k.add(frameMat, box(w, 0.05, 0.05).translate(cx, y0 + h * 0.55, zl));
  k.add(M.glass(), quad(w - s * 2, h - 0.22 - s).translate(cx, y0 + 0.22 + (h - 0.22 - s) / 2, zl - 0.005));
  frame(k, frameMat, cx, y0 + h / 2, w, h, zf - 0.01, 0.05, 0.1);
  k.add(metal, box(0.025, 0.5, 0.03).translate(cx + w / 2 - 0.14, y0 + 1.05, zl + 0.05));
}

/**
 * Sign board: timber backing with the painted atlas face (lit or not).
 * Centre (cx, cy), face toward +Z at z = zFace; height h, width from the
 * region aspect unless given.
 */
export function signBoard(k: Kit, key: SignKey, cx: number, cy: number, zFace: number, w: number, h: number, opts: { lit?: boolean; backing?: THREE.Material; thick?: number; border?: number } = {}): void {
  const t = opts.thick ?? 0.05;
  const b = opts.border ?? 0.03;
  const back = opts.backing ?? M.timber();
  k.add(back, box(w + b * 2, h + b * 2, t, { tile: 1 }).translate(cx, cy, zFace - t / 2 - 0.002));
  const r = signUV(key);
  k.add(opts.lit ? M.signsLit() : M.signs(), quad(w, h, r.u0, r.v0, r.u1, r.v1).translate(cx, cy, zFace + 0.001));
}

/** A sign face only (no backing), in the XY plane facing +Z centred at origin. */
export function signFace(key: SignKey, w: number, h: number): THREE.BufferGeometry {
  const r = signUV(key);
  return quad(w, h, r.u0, r.v0, r.u1, r.v1);
}

/** Square timber post from y0 to y1 at (x, z), grain vertical. */
export function post(k: Kit, mat: THREE.Material, x: number, z: number, y0: number, y1: number, s: number, off = 0): void {
  k.add(mat, box(s, y1 - y0, s, { tile: 1, grain: 'y', off }).translate(x, (y0 + y1) / 2, z));
}

/**
 * Small wall-mounted lantern (bracket + glowing box) on a +Z facing wall at z.
 * The glass uses the interior atlas' bright 'glow' region (emissive at night)
 * so it adds no extra material to a building.
 */
export function wallLantern(k: Kit, x: number, y: number, z: number, iron: THREE.Material = M.paint(M.COL.ironBlack)): void {
  k.add(iron, box(0.12, 0.16, 0.03).translate(x, y, z + 0.015));
  k.add(iron, box(0.03, 0.03, 0.16).translate(x, y + 0.05, z + 0.09));
  k.add(iron, box(0.17, 0.03, 0.17).translate(x, y + 0.17, z + 0.17));
  k.add(iron, box(0.11, 0.02, 0.11).translate(x, y - 0.06, z + 0.17));
  const g = new THREE.BoxGeometry(0.13, 0.2, 0.13);
  const r = interiorUV('glow');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
  k.add(M.interior(), g.translate(x, y + 0.05, z + 0.17));
}

export { V };
