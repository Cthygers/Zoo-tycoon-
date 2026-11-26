// Rocks and the fallen log. Rocks are icospheres sliced by random fracture
// planes (flat facets), noise-displaced, optionally terraced into strata,
// then smooth-shaded; vertex colours carry tint variation, cavity / underside
// darkening, lichen and moss, and ground-contact staining. Detail comes from a
// triplanar texture (RockMaterial) so there are no UV seams.

import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hashFloat as hashF, Noise, Rng } from '../../core/rng';
import { setOcclTop } from '../lod/fade';
import { barkMat, barkTextures } from './barks';
import { addCrownFade, addTube, groupOf, MeshData, v3, type V3 } from './geo';
import { barkMaterial, cachedTexture, natureQuality, rockMaterial, type RockMaterial } from './mats';
import { albedoHeightTexture, Img, lin, mix, pfbm, pworley, sat, sstep } from './tex';

// ---------------------------------------------------------------------------
// Triplanar detail textures (RGB albedo detail, A = height)

function genGranite(): Img {
  const S = 256;
  const img = new Img(S, S, 1);
  const wv = new Float32Array(5);
  const cr = new Float32Array(5);
  const light = lin(0xb9b4ac);
  const dark = lin(0x3a3836);
  const pink = lin(0xb8a094);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      pworley(u, v, 72, 72, 11, wv, 0.9);
      const id = wv[2];
      const c = id < 0.62 ? light : id < 0.86 ? dark : pink;
      const big = pfbm(u, v, 4, 4, 4, 12);
      const fine = pfbm(u, v, 32, 32, 2, 13);
      pworley(u + pfbm(u, v, 3, 3, 2, 14) * 0.04, v, 5, 5, 15, cr, 1);
      const crack = 1 - sstep(0.0, 0.025, cr[1] - cr[0]);
      const crackMask = sstep(-0.1, 0.3, pfbm(u, v, 3, 3, 2, 16));
      const ck = crack * crackMask;
      const streak = pfbm(u, v, 6, 1, 3, 17) * 0.08;
      const l = (0.9 + big * 0.18 + fine * 0.06 + streak) * (1 - ck * 0.6);
      // grain softening: blend toward the mean so crystals stay subtle
      const m = 0.8;
      img.set(i, mix(c[0], 0.42, m) * l, mix(c[1], 0.4, m) * l, mix(c[2], 0.38, m) * l, 1);
      img.h[i] = sat(0.55 + big * 0.25 + fine * 0.1 + (id < 0.62 ? 0.04 : 0) - ck * 0.5);
    }
  return img;
}

function genSandstone(): Img {
  const S = 256;
  const img = new Img(S, S, 1);
  const wv = new Float32Array(5);
  const buff = lin(0xc4ad94);
  const rust = lin(0xa07e64);
  const pale = lin(0xd6cbb8);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const warp = pfbm(u, v, 2, 2, 3, 21) * 0.08;
      const lam = Math.sin((v + warp + u * 0.0) * Math.PI * 2 * 18);
      const lam2 = Math.sin((v + warp * 1.5) * Math.PI * 2 * 57);
      const band = pfbm(0, v + warp, 1, 6, 3, 22);
      const big = pfbm(u, v, 4, 4, 4, 23);
      const fine = pfbm(u, v, 32, 32, 2, 24);
      pworley(u, v, 18, 18, 25, wv, 1);
      const pit = 1 - sstep(0.06, 0.16, wv[0]);
      const pitMask = sstep(0.1, 0.5, pfbm(u, v, 3, 3, 2, 26));
      const pp = pit * pitMask;
      const t = sat(0.5 + band * 1.2);
      let r = mix(buff[0], rust[0], t * 0.7);
      let g = mix(buff[1], rust[1], t * 0.7);
      let b = mix(buff[2], rust[2], t * 0.7);
      const pl = sstep(0.3, 0.9, lam * 0.5 + 0.5) * 0.1;
      r = mix(r, pale[0], pl);
      g = mix(g, pale[1], pl);
      b = mix(b, pale[2], pl);
      const speck = pfbm(u, v, 64, 64, 1, 27);
      const l = (0.9 + big * 0.16 + fine * 0.08 + lam2 * 0.008 + speck * 0.05) * (1 - pp * 0.45);
      img.set(i, r * l, g * l, b * l, 1);
      img.h[i] = sat(0.5 + lam * 0.04 + big * 0.25 + fine * 0.12 + speck * 0.05 - pp * 0.4);
    }
  return img;
}

function genIce(): Img {
  const S = 256;
  const img = new Img(S, S, 1);
  const wv = new Float32Array(5);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const i = y * S + x;
      const cloud = pfbm(u, v, 3, 3, 4, 31);
      // a few long fracture lines (not a cell network): worley edges, mostly masked out
      pworley(u, v, 3, 3, 32, wv, 1);
      const crack = (1 - sstep(0.0, 0.04, wv[1] - wv[0])) * sstep(0.15, 0.45, pfbm(u, v, 4, 4, 2, 34));
      pworley(u, v, 40, 40, 33, wv, 1);
      const bubble = (1 - sstep(0.05, 0.12, wv[0])) * sstep(0.6, 0.9, wv[2]);
      const l = 0.84 + cloud * 0.12 + crack * 0.08 + bubble * 0.08;
      img.set(i, 0.8 * l, 0.9 * l, 0.97 * l, 1);
      img.h[i] = sat(0.5 + cloud * 0.2 - crack * 0.12 + bubble * 0.05);
    }
  return img;
}

/**
 * Boulders and ice blocks are about a metre across their middle: one standing
 * this far (m) beside the camera → subject line still hides a followed animal,
 * so the follow-mode occluder cut (props layer, lod/fade.ts) reaches that much
 * farther for them than for a fence piece.
 */
const ROCK_OCCLUDER_REACH = 0.6;

/**
 * Follow-mode occluder cut of boulders and ice blocks (props/lod/fade.ts):
 * reach, anywhere on the line in front of the subject (they hide it from
 * close by too), and only when they reach up to the line (every rock
 * geometry carries its height, finishRocks; low stones and kerbs stay).
 */
function cutAsOccluder(m: RockMaterial): RockMaterial {
  m.userData.occluderReach = ROCK_OCCLUDER_REACH;
  m.userData.occluderAnywhere = true;
  m.userData.occluderTop = true;
  return m;
}

function graniteMat(): RockMaterial {
  return cutAsOccluder(rockMaterial('granite', { triTex: cachedTexture('rock-granite', () => albedoHeightTexture(genGranite())), tile: 1.1, bump: 0.012, roughness: 0.82, surfRoughness: 0.95, surfTint: 0x8fa060 }));
}

function sandstoneMat(): RockMaterial {
  return rockMaterial('sandstone', { triTex: cachedTexture('rock-sandstone', () => albedoHeightTexture(genSandstone())), tile: 1.5, bump: 0.02, roughness: 0.9, surfRoughness: 0.95, surfTint: 0x8fa060 });
}

function iceMat(): RockMaterial {
  const m = rockMaterial('ice', {
    triTex: cachedTexture('rock-ice', () => albedoHeightTexture(genIce())),
    tile: 1.2,
    bump: 0.008,
    // weathered, frosted faces: a soft sheen, not wet glass
    roughness: 0.45,
    surfRoughness: 0.9,
    surfTint: 0xf4f7fa,
    // faint blue "subsurface" lift in shadowed ice
    emissive: 0x0b1a24,
    emissiveIntensity: 0.1,
  });
  return cutAsOccluder(m);
}

/** Shared granite material (used by other nature props, e.g. bed kerbs: their geometry needs the occluder height too, lod/fade.ts setOcclTop). */
export function graniteMaterial(): RockMaterial {
  return graniteMat();
}

/** Generate the rock detail textures / materials now (prewarm). */
// ---------------------------------------------------------------------------
// Rock shape generator

interface RockOpts {
  radii: [number, number, number];
  detail: number;
  /** Planar fracture cuts. */
  cuts: number;
  /** Extra explicit cut planes (unit normal, offset in metres). */
  planes?: { n: V3; d: number }[];
  /** Random cut normals' vertical component range (default [-0.25, 1.1]). */
  cutY?: [number, number];
  /** Plane offset as a fraction of the support distance. */
  cutDepth: [number, number];
  /** Displacement amplitude (fraction of mean radius) and frequency (per m). */
  noise: number;
  freq: number;
  /** Terrace spacing (m) and strength (0..1). */
  strata?: number;
  strataAmt?: number;
  /** Fraction of height below which the base is flattened. */
  flatBase?: number;
  /** Faceted (flat) normals. */
  flat?: boolean;
  /** Hard edges where faces meet at more than this angle (rad): crisp fracture planes, cavity shading kept. */
  crease?: number;
  seed: number;
}

interface RockShape {
  geo: THREE.BufferGeometry;
  /** Per-vertex displacement value (for cavity shading). */
  disp: Float32Array;
}

function rockShape(rng: Rng, o: RockOpts): RockShape {
  const ico = new THREE.IcosahedronGeometry(1, o.detail);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const g = mergeVertices(ico);
  ico.dispose();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const noise = new Noise(o.seed);
  const [rx, ry, rz] = o.radii;
  const mean = (rx + ry + rz) / 3;
  const planes: { n: V3; d: number }[] = [];
  for (let k = 0; k < o.cuts; k++) {
    const n = v3(rng.gauss(), rng.range(o.cutY?.[0] ?? -0.25, o.cutY?.[1] ?? 1.1), rng.gauss()).normalize();
    const support = Math.sqrt(n.x * n.x * rx * rx + n.y * n.y * ry * ry + n.z * n.z * rz * rz);
    planes.push({ n, d: support * rng.range(o.cutDepth[0], o.cutDepth[1]) });
  }
  if (o.planes) planes.push(...o.planes);
  const disp = new Float32Array(pos.count);
  const p = v3();
  const dir = v3();
  for (let i = 0; i < pos.count; i++) {
    p.set(pos.getX(i) * rx, pos.getY(i) * ry, pos.getZ(i) * rz);
    for (const pl of planes) {
      const dp = p.dot(pl.n) - pl.d;
      if (dp > 0) p.addScaledVector(pl.n, -dp * 0.94);
    }
    dir.set(pos.getX(i) / rx, pos.getY(i) / ry, pos.getZ(i) / rz).normalize();
    const n1 = noise.fbm3(p.x * o.freq, p.y * o.freq, p.z * o.freq, 4);
    const d = n1 * o.noise * mean;
    disp[i] = n1;
    p.addScaledVector(dir, d);
    if (o.strata) {
      const s = o.strata;
      const yy = p.y / s + noise.noise3(p.x * 0.4, 0, p.z * 0.4) * 0.3;
      const f = yy - Math.floor(yy);
      // terrace: compress the lower part of each layer, overhang lip at the top
      const step = (sstep(0.0, 0.75, f) - f) * s * (o.strataAmt ?? 0.5);
      p.y += step * 0.6;
      // ledge lips: push out horizontally near the top of each layer
      const lip = sstep(0.55, 0.9, f) * (1 - sstep(0.9, 1.0, f));
      const k = 1 + (lip - 0.35) * 0.08 * (o.strataAmt ?? 0.5);
      p.x *= k;
      p.z *= k;
    }
    if (o.flatBase !== undefined) {
      const fb = -ry * o.flatBase;
      if (p.y < fb) p.y = fb + (p.y - fb) * 0.2;
    }
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  let geo = g;
  if (o.flat) {
    geo = g.toNonIndexed();
    g.dispose();
    // faceted: per-face normals; cavity shading is not used
    geo.computeVertexNormals();
    return { geo, disp: new Float32Array(geo.getAttribute('position').count) };
  }
  if (o.crease !== undefined) {
    // non-indexed in index order: carry each corner's displacement along
    const index = g.getIndex()!;
    const creased = toCreasedNormals(g, o.crease);
    g.dispose();
    const cd = new Float32Array(index.count);
    for (let i = 0; i < index.count; i++) cd[i] = disp[index.getX(i)];
    return { geo: creased, disp: cd };
  }
  geo.computeVertexNormals();
  return { geo, disp };
}

interface RockPaint {
  base: [number, number, number];
  /** Tint variation amplitude. */
  vary: number;
  lichen: number;
  moss: number;
  /** Snow caps (sets aSurf). */
  snow?: number;
  /** Sandstone band tint. */
  bands?: number;
  /** Sun-bleached, paler upward faces (0..1). */
  bleach?: number;
  /** Ice: cavities and undersides deepen to saturated blue instead of grey. */
  ice?: boolean;
  seed: number;
}

/** Append a rock geometry to md at transform m, with vertex colours / aSurf. */
function appendRock(md: MeshData, shape: RockShape, m: THREE.Matrix4, paint: RockPaint, groundY = 0): void {
  const g = shape.geo;
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const noise = new Noise(paint.seed);
  const p = v3();
  const n = v3();
  const base = md.count;
  const idx = g.getIndex();
  const vcount = pos.count;
  for (let i = 0; i < vcount; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(m);
    n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
    const nv = noise.fbm3(p.x * 0.9, p.y * 0.9, p.z * 0.9, 3);
    const fine = noise.noise3(p.x * 4.1, p.y * 4.1, p.z * 4.1);
    let r = paint.base[0] * (1 + nv * paint.vary);
    let gg = paint.base[1] * (1 + nv * paint.vary * 0.95);
    let b = paint.base[2] * (1 + nv * paint.vary * 0.9);
    if (paint.bands) {
      const bnd = Math.sin(p.y * 9 + nv * 2) * 0.5 + 0.5;
      r *= 1 - bnd * paint.bands * 0.12;
      gg *= 1 - bnd * paint.bands * 0.2;
      b *= 1 - bnd * paint.bands * 0.28;
    }
    if (paint.bleach) {
      const bl = sstep(0.55, 0.95, n.y) * paint.bleach * (0.7 + 0.3 * fine);
      r = mix(r, 0.72, bl * 0.35);
      gg = mix(gg, 0.66, bl * 0.35);
      b = mix(b, 0.58, bl * 0.35);
    }
    // cavity / underside darkening
    const cav = shape.disp.length === vcount ? shape.disp[i] : 0;
    let ao = 0.78 + 0.22 * sstep(-0.5, 0.4, cav);
    ao *= 0.62 + 0.38 * sstep(-0.6, 0.5, n.y);
    if (paint.ice) {
      // light scattered through thick ice comes out blue: shade crevices by
      // absorbing red / green rather than darkening
      const deep = 1 - ao;
      r *= 1 - deep * 1.5;
      gg *= 1 - deep * 0.7;
      b *= 1 - deep * 0.15;
      ao = 1 - deep * 0.35;
    }
    // ground contact: damp, darker, earthy
    const gh = p.y - groundY;
    const wet = 1 - sstep(0.0, 0.28, gh);
    ao *= 1 - wet * 0.38;
    r = mix(r, r * 0.9 + 0.02, wet);
    gg = mix(gg, gg * 0.85, wet);
    b = mix(b, b * 0.78, wet);
    let surf = 0;
    // lichen: pale grey-green and orange crusts on exposed faces
    const lm = sstep(0.25, 0.55, noise.fbm3(p.x * 2.2 + 9, p.y * 2.2, p.z * 2.2, 3) + fine * 0.15) * sstep(-0.1, 0.5, n.y) * paint.lichen;
    const orange = noise.noise3(p.x * 1.3, p.y * 1.3 + 4, p.z * 1.3) > 0.35;
    if (orange) {
      r = mix(r, 0.58, lm * 0.7);
      gg = mix(gg, 0.36, lm * 0.7);
      b = mix(b, 0.12, lm * 0.7);
    } else {
      r = mix(r, 0.5, lm * 0.6);
      gg = mix(gg, 0.53, lm * 0.6);
      b = mix(b, 0.42, lm * 0.6);
    }
    // moss on top / shaded faces near the ground
    const mm = sstep(0.1, 0.45, noise.fbm3(p.x * 1.6 - 5, p.y * 1.6, p.z * 1.6, 3)) * sstep(0.2, 0.75, n.y) * paint.moss;
    r = mix(r, 0.12, mm);
    gg = mix(gg, 0.2, mm);
    b = mix(b, 0.05, mm);
    surf = Math.max(surf, mm);
    if (paint.snow) {
      const sn = sstep(0.42, 0.78, n.y + noise.noise3(p.x * 2, p.y * 2, p.z * 2) * 0.22) * paint.snow;
      r = mix(r, 0.88, sn);
      gg = mix(gg, 0.9, sn);
      b = mix(b, 0.93, sn);
      ao = mix(ao, 0.95 + ao * 0.05, sn);
      surf = Math.max(surf, sn);
    }
    md.vert(p.x, p.y, p.z, n.x, n.y, n.z, 0, 0, r * ao, gg * ao, b * ao, surf);
  }
  if (idx) for (let k = 0; k < idx.count; k++) md.idx.push(base + idx.getX(k));
  else for (let k = 0; k < vcount; k++) md.idx.push(base + k);
  md.useExtra = true;
}

/**
 * Icosphere subdivision for the tier: `d` is the high-tier detail; medium
 * drops one level on the big (d ≥ 5) rocks, low one level everywhere.
 */
function rockDetail(d: number): number {
  const q = natureQuality();
  if (q === 'low') return Math.max(1, d - (d >= 5 ? 2 : 1));
  if (q === 'medium' && d >= 5) return d - 1;
  return d;
}

const mtx = (x: number, y: number, z: number, yaw: number, s = 1, tiltX = 0, tiltZ = 0): THREE.Matrix4 =>
  new THREE.Matrix4().compose(v3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, yaw, tiltZ, 'YXZ')), v3(s, s, s));

/** Lowest y of a shape (for seating it on the ground). */
function minY(shape: RockShape): number {
  shape.geo.computeBoundingBox();
  return shape.geo.boundingBox!.min.y;
}

function finishRocks(md: MeshData, mat: THREE.Material, name = 'rock'): THREE.Group {
  const g = groupOf([[md, mat, name]]);
  // the occluder cut's height on every rock drawn with a cut material (small stones too: one batch layout)
  if (mat.userData.occluderTop === true) for (const c of g.children) setOcclTop((c as THREE.Mesh).geometry);
  g.userData.tris = md.tris;
  return g;
}

// ---------------------------------------------------------------------------
// Builders

const GRANITE: [number, number, number] = [0.62, 0.6, 0.57];
const WARM_GRANITE: [number, number, number] = [0.66, 0.6, 0.54];

export function buildRockSmall(variant: number): THREE.Group {
  const rng = new Rng(9100 + variant * 7919);
  const md = new MeshData();
  const n = 5 + rng.int(0, 3);
  const placed: { x: number; z: number; r: number }[] = [];
  for (let k = 0; k < n; k++) {
    const big = k < 2;
    const rad = big ? rng.range(0.34, 0.5) : rng.range(0.14, 0.28);
    let x = 0;
    let z = 0;
    for (let tries = 0; tries < 12; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.float()) * (big ? 0.35 : 0.8);
      x = Math.cos(a) * d;
      z = Math.sin(a) * d;
      if (placed.every((q) => Math.hypot(q.x - x, q.z - z) > (q.r + rad) * 0.85)) break;
    }
    placed.push({ x, z, r: rad });
    const shape = rockShape(rng, { radii: [rad * rng.range(0.9, 1.3), rad * rng.range(0.55, 0.8), rad * rng.range(0.8, 1.1)], detail: big ? 2 : 1, cuts: 4, cutDepth: [0.55, 0.85], noise: 0.12, freq: 3 / rad, flatBase: 0.5, seed: 100 + k + variant * 13 });
    const sink = rad * 0.18;
    appendRock(md, shape, mtx(x, -minY(shape) - sink, z, rng.range(0, 6.28)), { base: variant % 2 ? WARM_GRANITE : GRANITE, vary: 0.18, lichen: 0.5, moss: 0.25, seed: 7 + k });
  }
  return finishRocks(md, graniteMat());
}

export function buildBoulder(variant: number): THREE.Group {
  return boulder(variant, false);
}

/** Distant boulder: same fractured shape sampled on a coarser sphere, no loose stones. */
export function buildBoulderLod(variant: number): THREE.Group {
  return boulder(variant, true);
}

function boulder(variant: number, lod: boolean): THREE.Group {
  const rng = new Rng(9200 + variant * 7919);
  const md = new MeshData();
  const rx = rng.range(0.9, 1.02);
  const ry = rng.range(0.72, 0.88);
  const rz = rng.range(0.78, 0.95);
  const shape = rockShape(rng, { radii: [rx, ry, rz], detail: lod ? 2 : rockDetail(5), cuts: 5 + rng.int(0, 2), cutDepth: [0.6, 0.82], noise: 0.06, freq: 1.5, flatBase: 0.55, seed: 200 + variant });
  const sink = ry * 0.22;
  appendRock(md, shape, mtx(0, -minY(shape) - sink, 0, rng.range(0, 6.28)), { base: variant === 2 ? WARM_GRANITE : GRANITE, vary: 0.14, lichen: 0.8, moss: 0.45, seed: 31 + variant });
  // a couple of loose stones at the foot
  for (let k = 0; k < (lod ? 0 : 2); k++) {
    const r = rng.range(0.12, 0.22);
    const a = rng.range(0, 6.28);
    const s2 = rockShape(rng, { radii: [r * 1.2, r * 0.7, r], detail: 1, cuts: 3, cutDepth: [0.5, 0.8], noise: 0.1, freq: 6, flatBase: 0.4, seed: 260 + k + variant * 3 });
    appendRock(md, s2, mtx(Math.cos(a) * (rx + r * 0.6), -minY(s2) - r * 0.25, Math.sin(a) * (rz + r * 0.6), rng.range(0, 6.28)), { base: GRANITE, vary: 0.2, lichen: 0.3, moss: 0.2, seed: 40 + k });
  }
  return finishRocks(md, graniteMat());
}

/**
 * Sandstone kopje: two or three weathered blocks stepping up toward the back
 * (−Z, ≈ 0.5 m steps: climbable). Each block is a fractured, noise-displaced
 * mass with a flat bedding-plane top, near-vertical joint faces and softly
 * rounded edges; bedding shows as faint banding, not as stacked slabs.
 */
export function buildOutcrop(variant: number): THREE.Group {
  return outcrop(variant, false);
}

/** Distant outcrop: the same blocks on coarser spheres, no loose stones. */
export function buildOutcropLod(variant: number): THREE.Group {
  return outcrop(variant, true);
}

function outcrop(variant: number, lod: boolean): THREE.Group {
  const rng = new Rng(9300 + variant * 7919);
  const md = new MeshData();
  const tall = variant % 2 === 1;
  const side = rng.chance(0.5) ? 1 : -1;
  // [radii, centre x, z, top height above ground, detail]
  const blocks: { r: [number, number, number]; x: number; z: number; top: number; det: number }[] = [
    { r: [1.8, 0.75, 1.5], x: 0, z: 0.25, top: rng.range(0.48, 0.6), det: 4 },
    { r: [1.25, 0.85, 1.05], x: side * rng.range(0.15, 0.45), z: -0.55, top: rng.range(0.98, 1.12), det: 3 },
  ];
  // third block: a higher step on tall variants, otherwise a split-off slab tipped against the base
  if (tall) blocks.push({ r: [0.8, 0.7, 0.7], x: -side * rng.range(0.0, 0.35), z: -1.0, top: rng.range(1.48, 1.62), det: 3 });
  else blocks.push({ r: [0.75, 0.38, 0.6], x: -side * rng.range(1.3, 1.5), z: rng.range(0.7, 1.0), top: rng.range(0.42, 0.55), det: 2 });
  const dip = rng.range(-0.05, 0.05);
  blocks.forEach((b, k) => {
    const tipped = !tall && k === 2;
    const [rx, ry, rz] = b.r;
    // flat bedding-plane top (slightly dipping) + flat base; vertical joints from the random cuts
    const topN = v3(dip * 0.6, 1, rng.range(-0.04, 0.04)).normalize();
    const shape = rockShape(rng, {
      radii: [rx, ry, rz],
      detail: lod ? Math.min(2, b.det) : rockDetail(b.det),
      cuts: 8,
      cutY: [-0.15, 0.25],
      cutDepth: [0.6, 0.82],
      planes: [{ n: topN, d: ry * 0.55 }],
      noise: 0.085,
      freq: 1.25,
      strata: 0.16,
      strataAmt: 0.18,
      flatBase: 0.5,
      seed: 300 + k + variant * 7,
    });
    shape.geo.computeBoundingBox();
    const top = shape.geo.boundingBox!.max.y;
    const y = b.top - top;
    const tx = tipped ? side * 0.3 : rng.range(-0.06, 0.06);
    const tz = tipped ? 0.18 : rng.range(-0.06, 0.06);
    appendRock(md, shape, mtx(b.x, y, b.z, rng.range(-0.5, 0.5), 1, tx, tz), { base: [0.6, 0.5, 0.41], vary: 0.2, lichen: 0.6, moss: 0.06, bands: 0.35, bleach: 0.6, seed: 50 + k });
  });
  // tumbled blocks at the foot
  for (let k = 0; k < (lod ? 0 : 3); k++) {
    const r = rng.range(0.16, 0.3);
    const a = rng.range(-0.6, 0.6) + (k === 0 ? Math.PI * 0.3 : k === 1 ? -Math.PI * 0.3 : Math.PI);
    const s2 = rockShape(rng, { radii: [r * 1.3, r * 0.75, r], detail: k === 2 ? 1 : 2, cuts: 5, cutDepth: [0.5, 0.75], noise: 0.06, freq: 4, flatBase: 0.4, seed: 360 + k + variant * 5 });
    appendRock(md, s2, mtx(Math.sin(a) * 1.9, -minY(s2) - r * 0.2, Math.cos(a) * 1.75, rng.range(0, 6.28)), { base: [0.6, 0.5, 0.41], vary: 0.2, lichen: 0.3, moss: 0.08, bands: 0.4, seed: 60 + k });
  }
  return finishRocks(md, sandstoneMat());
}

/**
 * Ice rockery for polar habitats: angular blocks of blue-white ice (many
 * fresh fracture faces, blue crevices) with snow on their upward faces. No
 * snow drift around the base: it would show as a white sheet off snow
 * terrain, and polar terrain already supplies the snow.
 */
export function buildIceRocks(variant: number): THREE.Group {
  const rng = new Rng(9400 + variant * 7919);
  const md = new MeshData();
  const blocks = [
    { r: [0.72, 0.62, 0.6] as [number, number, number], x: 0, z: 0, det: 3 },
    { r: [0.45, 0.4, 0.4] as [number, number, number], x: 0.75, z: 0.35, det: 2 },
    { r: [0.32, 0.26, 0.3] as [number, number, number], x: -0.6, z: 0.55, det: 1 },
  ];
  if (variant % 2) blocks.push({ r: [0.38, 0.5, 0.36], x: -0.35, z: -0.6, det: 2 });
  blocks.forEach((b, k) => {
    const shape = rockShape(rng, { radii: [b.r[0] * 1.25, b.r[1] * 1.3, b.r[2] * 1.25], detail: rockDetail(b.det), cuts: 14, cutDepth: [0.42, 0.78], noise: 0.02, freq: 2.0, flatBase: 0.5, crease: 0.45, seed: 400 + k + variant * 11 });
    // near-white glacial ice (≈ #dfe8ee): blue only where light travels deep (crevices, undersides)
    appendRock(md, shape, mtx(b.x * rng.range(0.9, 1.1), -minY(shape) - b.r[1] * 0.08, b.z * rng.range(0.9, 1.1), rng.range(0, 6.28)), { base: [0.74, 0.8, 0.85], vary: 0.06, lichen: 0, moss: 0, snow: 0.9, ice: true, seed: 70 + k });
  });
  return finishRocks(md, iceMat(), 'ice');
}

// ---------------------------------------------------------------------------
// Fallen log

export function buildLog(variant: number): THREE.Group {
  const rng = new Rng(9500 + variant * 7919);
  const L = rng.range(3.3, 3.7);
  const R = rng.range(0.27, 0.34);
  const noise = new Noise(500 + variant);
  const segs = 12;
  const pts: V3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const x = -L / 2 + t * L;
    pts.push(v3(x, R * 0.8 + noise.noise2(t * 2, 1) * 0.06 + (t - 0.5) * 0.06, noise.noise2(t * 1.5, 7) * 0.12));
    radii.push(R * (1.06 - 0.14 * t + noise.noise2(t * 3, 3) * 0.04));
  }
  const bark = new MeshData();
  const circ = Math.PI * 2 * R;
  addTube(bark, pts, radii, {
    radial: 12,
    uRepeat: Math.max(2, Math.round(circ / 0.6)),
    vPerMetre: 1 / 1.2,
    radiusMod: (_i, a, p) => 1 + noise.noise3(Math.cos(a) * 2, p.x * 1.5, Math.sin(a) * 2) * 0.05,
  });
  // branch stubs
  const stubs = 2 + rng.int(0, 1);
  for (let k = 0; k < stubs; k++) {
    const t = rng.range(0.2, 0.75);
    const i = Math.floor(t * segs);
    const c = pts[i];
    const a = rng.range(-0.3, Math.PI + 0.3);
    const d = v3(rng.range(-0.4, 0.4), Math.sin(a), Math.cos(a)).normalize();
    const r = rng.range(0.05, 0.085);
    const len = rng.range(0.3, 0.55);
    const s0 = c.clone().addScaledVector(d, radii[i] * 0.5);
    addTube(bark, [s0, s0.clone().addScaledVector(d, len * 0.6), s0.clone().addScaledVector(d, len)], [r, r * 0.8, r * 0.55], { radial: 6, uRepeat: 1, vPerMetre: 1 / 1.2, capEnd: true });
  }
  // moss / ground staining by normal and height
  for (let i = 0; i < bark.count; i++) {
    const px = bark.pos[i * 3];
    const py = bark.pos[i * 3 + 1];
    const pz = bark.pos[i * 3 + 2];
    const ny = bark.nrm[i * 3 + 1];
    const m = sstep(0.25, 0.85, ny + noise.noise3(px * 1.2, py * 1.2, pz * 1.2) * 0.3) * sstep(-0.3, 0.5, noise.noise3(px * 0.5 + 3, 0, pz * 0.5)) * 0.85;
    const ground = 1 - sstep(0.02, 0.3, py);
    const ao = (0.6 + 0.4 * sstep(-0.8, 0.3, ny)) * (1 - ground * 0.35);
    bark.col[i * 3] = mix(1, 0.7, m) * ao;
    bark.col[i * 3 + 1] = mix(1, 1.0, m) * ao;
    bark.col[i * 3 + 2] = mix(1, 0.45, m) * ao;
  }
  // end caps (end grain): left = sawn-ish break, right = splintered
  const ends = new MeshData();
  const capEnd = (end: 0 | 1) => {
    const i = end === 0 ? 0 : segs;
    const c = pts[i];
    const axis = v3().subVectors(pts[end === 0 ? 1 : segs], pts[end === 0 ? 0 : segs - 1]).normalize();
    if (end === 0) axis.negate();
    const up = v3(0, 1, 0);
    const sx = v3().crossVectors(axis, up).normalize();
    const sy = v3().crossVectors(sx, axis).normalize();
    const rings = [1, 0.75, 0.5, 0.25, 0];
    const R0 = radii[i] * 1.0;
    const nA = 14;
    const base = ends.count;
    const jag = end === 1 ? 0.26 : 0.03;
    for (let r = 0; r < rings.length; r++) {
      const rr = rings[r];
      const count = rr === 0 ? 1 : nA + 1;
      for (let j = 0; j < count; j++) {
        const a = (j / nA) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        // splinters: per-vertex random lengths, longest toward the middle of the break
        const jj = j % nA;
        const spike = hashF(jj, r * 31 + end * 7 + variant * 101);
        const h = end === 1 ? jag * (0.15 + 0.85 * spike * spike) * (1 - rr * 0.65) * (0.6 + 0.4 * Math.max(0, Math.sin(a + variant))) : jag * (0.5 + 0.5 * noise.noise2(ca * 3, sa * 3));
        const p = c.clone().addScaledVector(sx, ca * R0 * rr * 0.995).addScaledVector(sy, sa * R0 * rr * 0.995).addScaledVector(axis, h - 0.005);
        const ao = 0.75 + 0.25 * (1 - rr);
        ends.vert(p.x, p.y, p.z, axis.x, axis.y, axis.z, 0.5 + ca * rr * 0.47, 0.5 + sa * rr * 0.47, ao, ao, ao);
      }
    }
    // stitch rings
    const ringStart = (r: number) => base + r * (nA + 1);
    for (let r = 0; r < rings.length - 1; r++) {
      const a0 = ringStart(r);
      if (rings[r + 1] === 0) {
        const cIdx = ringStart(r + 1);
        for (let j = 0; j < nA; j++) end === 0 ? ends.tri(a0 + j, a0 + j + 1, cIdx) : ends.tri(a0 + j + 1, a0 + j, cIdx);
      } else {
        const b0 = ringStart(r + 1);
        for (let j = 0; j < nA; j++) end === 0 ? ends.quad(a0 + j, a0 + j + 1, b0 + j + 1, b0 + j) : ends.quad(a0 + j + 1, a0 + j, b0 + j, b0 + j + 1);
      }
    }
  };
  capEnd(0);
  capEnd(1);
  // recompute end normals from geometry (splinters)
  const eg = ends.build();
  eg.computeVertexNormals();
  const endT = barkTextures('endgrain');
  const endMat = barkMaterial('endgrain', endT.map, endT.normal, { roughness: 0.85, fade: false });
  // the oak trees' bark material, with neutral crown data: one batch for both
  const g = groupOf([[bark, barkMat('oak', 0.003, true, true), 'bark']]);
  addCrownFade(g, null);
  const em = new THREE.Mesh(eg, endMat);
  em.name = 'endgrain';
  g.add(em);
  g.userData.tris = bark.tris + ends.tris;
  return g;
}
