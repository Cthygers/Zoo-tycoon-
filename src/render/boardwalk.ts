// Timber deck for boardwalk path tiles that cross water: individual planks at
// DECK_Y (core/constants; ramping up to meet the bank), stringers, posts down to
// the lake bed and a simple post-and-rail handrail along open water edges.
// Boardwalk tiles on dry land are drawn by the ground shader, except where the
// bank drops below DECK_Y: there the deck carries on flat over the bank until
// it meets the slope, exactly where guests walk (World.walkHeightAt =
// max(ground, DECK_Y)), and the ground shader paints no planks under it.

import * as THREE from 'three';
import { DECK_Y, MAP_H, MAP_W, TILE } from '../core/constants';
import { Noise, hashFloat } from '../core/rng';
import { PathType, isWater, type Terrain } from '../core/types';
import type { World } from '../core/world';

export { DECK_Y };
const PLANKS = 13;
const PLANK_T = 0.035;

class BoxBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /**
   * Oriented box: centre c, half extents along local axes a (length), b (up), d (width).
   * uv.x runs along the length in metres (+ offset), uv.y across.
   */
  box(c: THREE.Vector3, ax: THREE.Vector3, up: THREE.Vector3, wd: THREE.Vector3, hl: number, hh: number, hw: number, tint: number, uOff: number) {
    const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3, number, number, number][] = [
      // normal, u axis, v axis, half extents along n, u, v
      [up, ax, wd, hh, hl, hw],
      [up.clone().negate(), ax, wd.clone().negate(), hh, hl, hw],
      [wd, ax, up.clone().negate(), hw, hl, hh],
      [wd.clone().negate(), ax, up, hw, hl, hh],
      [ax, wd, up, hl, hw, hh],
      [ax.clone().negate(), wd.clone().negate(), up, hl, hw, hh],
    ];
    const v = new THREE.Vector3();
    for (const [n, u, w, en, eu, ew] of faces) {
      const base = this.pos.length / 3;
      for (let k = 0; k < 4; k++) {
        const su = k === 0 || k === 3 ? -1 : 1;
        const sw = k < 2 ? -1 : 1;
        v.copy(c).addScaledVector(n, en).addScaledVector(u, su * eu).addScaledVector(w, sw * ew);
        this.pos.push(v.x, v.y, v.z);
        this.nrm.push(n.x, n.y, n.z);
        this.uv.push(uOff + su * eu, 0.5 + sw * ew * 3);
        this.col.push(tint, tint, tint);
      }
      // winding: (u × w) should point along n
      const cr = new THREE.Vector3().crossVectors(u, w);
      if (cr.dot(n) > 0) this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

function woodTexture(): THREE.DataTexture {
  const W = 256,
    H = 64;
  const data = new Uint8Array(W * H * 4);
  const n = new Noise(4242);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x / W,
        v = y / H;
      // periodic along u: sample on a circle
      const a = u * Math.PI * 2;
      const grain = n.fbm3(Math.cos(a) * 1.2, Math.sin(a) * 1.2, v * 24, 4);
      const rings = Math.sin((v * 7 + grain * 1.6) * Math.PI * 2) * 0.5 + 0.5;
      const fine = n.noise3(Math.cos(a) * 9, Math.sin(a) * 9, v * 90);
      let r = 128,
        g = 106,
        b = 84;
      const k = 0.82 + 0.12 * rings + 0.07 * fine + 0.08 * grain;
      r *= k;
      g *= k;
      b *= k;
      const i = (y * W + x) * 4;
      data[i] = Math.min(255, r);
      data[i + 1] = Math.min(255, g);
      data[i + 2] = Math.min(255, b);
      data[i + 3] = 255;
    }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

export class BoardwalkDecks {
  readonly mesh: THREE.Mesh;
  private material: THREE.MeshStandardMaterial;
  private tex: THREE.DataTexture;

  constructor(private world: World) {
    this.tex = woodTexture();
    // texture covers 2 m along u
    this.tex.repeat.set(0.5, 1);
    this.material = new THREE.MeshStandardMaterial({ map: this.tex, vertexColors: true, roughness: 0.78, metalness: 0 });
    this.material.name = 'boardwalk';
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'boardwalk';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.rebuild();
  }

  private isDeck(x: number, z: number): boolean {
    const w = this.world;
    if (!w.inBounds(x, z)) return false;
    const i = w.idx(x, z);
    return w.path[i] === PathType.Boardwalk && isWater(w.terrain[i] as Terrain);
  }
  private isBoardwalk(x: number, z: number): boolean {
    const w = this.world;
    return w.inBounds(x, z) && w.path[w.idx(x, z)] === PathType.Boardwalk;
  }
  private isPath(x: number, z: number): boolean {
    const w = this.world;
    return w.inBounds(x, z) && w.path[w.idx(x, z)] !== PathType.None;
  }

  /** Planks run across the walking direction: along Z when the boardwalk runs along X. */
  private alongX(x: number, z: number): boolean {
    return (this.isBoardwalk(x - 1, z) || this.isBoardwalk(x + 1, z)) && !this.isBoardwalk(x, z - 1) && !this.isBoardwalk(x, z + 1);
  }

  /**
   * Boardwalk on a land tile: flat deck at DECK_Y over the part of the bank
   * below it (planks whose ground dips under the deck, stringers while there
   * is room under them, posts where they end in the air). Nothing on banks
   * that stay above DECK_Y.
   */
  private bankDeck(b: BoxBuilder, x: number, z: number, posts: Set<number>): void {
    const w = this.world;
    const x0 = x * TILE,
      z0 = z * TILE;
    const alongX = this.alongX(x, z);
    // ground at (along, across) fractions of the tile; along = walking direction
    const ground = (fa: number, fc: number) => (alongX ? w.heightAt(x0 + fa * TILE, z0 + fc * TILE) : w.heightAt(x0 + fc * TILE, z0 + fa * TILE));
    const X = new THREE.Vector3(1, 0, 0),
      Y = new THREE.Vector3(0, 1, 0),
      Z = new THREE.Vector3(0, 0, 1);
    const c = new THREE.Vector3();
    const at = (fa: number, fc: number, y: number) => (alongX ? c.set(x0 + fa * TILE, y, z0 + fc * TILE) : c.set(x0 + fc * TILE, y, z0 + fa * TILE));
    const pw = (TILE / PLANKS) * 0.46;
    for (let p = 0; p < PLANKS; p++) {
      const f = (p + 0.5) / PLANKS;
      if (Math.min(ground(f, 0), ground(f, 0.5), ground(f, 1)) > DECK_Y - 0.005) continue;
      const tint = 0.78 + 0.32 * hashFloat(x * 31 + p, z * 17, 5);
      const uOff = hashFloat(x, z * 13 + p, 9) * 2;
      at(f, 0.5, DECK_Y - PLANK_T / 2);
      if (alongX) b.box(c, Z, Y, X, TILE / 2, PLANK_T / 2, pw, tint, uOff);
      else b.box(c, X, Y, Z, TILE / 2, PLANK_T / 2, pw, tint, uOff);
    }
    // stringers: one run per side over the stretch with room beneath (normally from the water edge up the bank)
    const SAMPLES = 16;
    const stringerTop = DECK_Y - PLANK_T;
    for (const s of [0.2, 0.8]) {
      let lo = -1,
        hi = -1;
      for (let i = 0; i <= SAMPLES; i++) {
        if (ground(i / SAMPLES, s) >= stringerTop - 0.16) continue;
        if (lo < 0) lo = i;
        hi = i;
      }
      if (lo < 0) continue;
      const a0 = Math.max(0, (lo - 0.5) / SAMPLES),
        a1 = Math.min(1, (hi + 0.5) / SAMPLES);
      at((a0 + a1) / 2, s, stringerTop - 0.08);
      if (alongX) b.box(c, X, Y, Z, ((a1 - a0) * TILE) / 2, 0.08, 0.045, 0.6, 0);
      else b.box(c, Z, Y, X, ((a1 - a0) * TILE) / 2, 0.08, 0.045, 0.6, 0);
      // posts at the stringer's ends (shared with the deck tile at the water edge)
      for (const fa of [a0, a1]) {
        at(fa, s, 0);
        const key = Math.round(c.x * 10) * 100000 + Math.round(c.z * 10);
        const top = stringerTop - 0.12;
        const bottom = ground(fa, s) - 0.25;
        if (posts.has(key) || top - bottom < 0.3) continue;
        posts.add(key);
        at(fa, s, (top + bottom) / 2);
        b.box(c, X, Y, Z, 0.06, (top - bottom) / 2, 0.06, 0.5, 0);
      }
    }
  }

  /** Deck height at a tile corner: on the water line, ramping up to meet higher banks. */
  private cornerDeck(cx: number, cz: number): number {
    return Math.max(DECK_Y, this.world.heightAt(cx * TILE, cz * TILE) + 0.06);
  }

  rebuild(): void {
    const b = new BoxBuilder();
    const X = new THREE.Vector3(1, 0, 0),
      Y = new THREE.Vector3(0, 1, 0),
      Z = new THREE.Vector3(0, 0, 1);
    const c = new THREE.Vector3();
    const posts = new Set<number>();
    const w = this.world;
    for (let z = 0; z < MAP_H; z++)
      for (let x = 0; x < MAP_W; x++) {
        if (this.isBoardwalk(x, z) && !this.isDeck(x, z)) {
          this.bankDeck(b, x, z, posts);
          continue;
        }
        if (!this.isDeck(x, z)) continue;
        const alongX = this.alongX(x, z);
        const h00 = this.cornerDeck(x, z),
          h10 = this.cornerDeck(x + 1, z),
          h01 = this.cornerDeck(x, z + 1),
          h11 = this.cornerDeck(x + 1, z + 1);
        const hAt = (fx: number, fz: number) => (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
        const x0 = x * TILE,
          z0 = z * TILE;
        // planks run across the walking direction
        for (let p = 0; p < PLANKS; p++) {
          const f = (p + 0.5) / PLANKS;
          const tint = 0.78 + 0.32 * hashFloat(x * 31 + p, z * 17, 5);
          const uOff = hashFloat(x, z * 13 + p, 9) * 2;
          const pw = (TILE / PLANKS) * 0.46;
          if (alongX) {
            c.set(x0 + f * TILE, hAt(f, 0.5) - PLANK_T / 2, z0 + TILE / 2);
            b.box(c, Z, Y, X, TILE / 2, PLANK_T / 2, pw, tint, uOff);
          } else {
            c.set(x0 + TILE / 2, hAt(0.5, f) - PLANK_T / 2, z0 + f * TILE);
            b.box(c, X, Y, Z, TILE / 2, PLANK_T / 2, pw, tint, uOff);
          }
        }
        // stringers under the planks, along the walking direction
        for (const s of [0.2, 0.8]) {
          if (alongX) {
            c.set(x0 + TILE / 2, hAt(0.5, s) - PLANK_T - 0.08, z0 + s * TILE);
            b.box(c, X, Y, Z, TILE / 2, 0.08, 0.045, 0.6, 0);
          } else {
            c.set(x0 + s * TILE, hAt(s, 0.5) - PLANK_T - 0.08, z0 + TILE / 2);
            b.box(c, Z, Y, X, TILE / 2, 0.08, 0.045, 0.6, 0);
          }
        }
        // posts at the stringer ends (deduplicated across tiles)
        const postAt = (fx: number, fz: number) => {
          const px = x0 + fx * TILE,
            pz = z0 + fz * TILE;
          const key = Math.round(px * 10) * 100000 + Math.round(pz * 10);
          if (posts.has(key)) return;
          posts.add(key);
          const top = hAt(fx, fz) - PLANK_T - 0.12;
          const bottom = w.heightAt(px, pz) - 0.25;
          if (top - bottom < 0.05) return;
          c.set(px, (top + bottom) / 2, pz);
          b.box(c, X, Y, Z, 0.06, (top - bottom) / 2, 0.06, 0.5, 0);
        };
        if (alongX) {
          postAt(0, 0.2); postAt(0, 0.8); postAt(1, 0.2); postAt(1, 0.8);
        } else {
          postAt(0.2, 0); postAt(0.8, 0); postAt(0.2, 1); postAt(0.8, 1);
        }
        // handrail along edges that open onto water
        const sides: [number, number, boolean][] = [
          [x - 1, z, false],
          [x + 1, z, false],
          [x, z - 1, true],
          [x, z + 1, true],
        ];
        for (const [nx, nz, horiz] of sides) {
          if (this.isPath(nx, nz)) continue;
          if (!w.inBounds(nx, nz) || !isWater(w.terrain[w.idx(nx, nz)] as Terrain)) continue;
          const edgeF = horiz ? (nz < z ? 0.04 : 0.96) : nx < x ? 0.04 : 0.96;
          for (let k = 0; k <= 2; k++) {
            const t = k / 2;
            const fx = horiz ? t : edgeF,
              fz = horiz ? edgeF : t;
            const deck = hAt(fx, fz);
            c.set(x0 + fx * TILE, deck + 0.45, z0 + fz * TILE);
            b.box(c, X, Y, Z, 0.045, 0.45, 0.045, 0.55, 0);
          }
          for (const ry of [0.88, 0.48]) {
            const fx = horiz ? 0.5 : edgeF,
              fz = horiz ? edgeF : 0.5;
            c.set(x0 + fx * TILE, hAt(fx, fz) + ry, z0 + fz * TILE);
            if (horiz) b.box(c, X, Y, Z, TILE / 2, 0.03, 0.04, 0.7, 0);
            else b.box(c, Z, Y, X, TILE / 2, 0.03, 0.04, 0.7, 0);
          }
        }
      }
    const old = this.mesh.geometry;
    this.mesh.geometry = b.geometry();
    old.dispose();
    this.mesh.visible = b.idx.length > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.tex.dispose();
  }
}
