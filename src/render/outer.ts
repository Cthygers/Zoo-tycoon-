// Decorative landscape around the playable map so there is never a visible
// world edge: rolling meadows rising into hills out to OUTER_RING metres (same
// ground shader as the map), a coarse far ring that keeps climbing into the
// haze, an instanced low-poly forest and two ranges of distant mountains with
// aerial perspective.

import * as THREE from 'three';
import { OUTER_RING, WORLD_H, WORLD_W } from '../core/constants';
import { Noise, clamp, smoothstep } from '../core/rng';
import type { World } from '../core/world';

const CELL = 4; // metres per near-ring cell
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s3 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const FAR_R1 = 1700;
const CX = WORLD_W / 2;
const CZ = WORLD_H / 2;

export class OuterHeight {
  private n: Noise;
  constructor(
    private world: World,
    seed: number,
  ) {
    this.n = new Noise(seed * 7 + 3);
  }
  /** Distance (m) outside the playable rectangle. */
  static outside(x: number, z: number): number {
    const dx = Math.max(-x, 0, x - WORLD_W);
    const dz = Math.max(-z, 0, z - WORLD_H);
    return Math.hypot(dx, dz);
  }
  height(x: number, z: number): number {
    const d = OuterHeight.outside(x, z);
    const edge = this.world.heightAt(clamp(x, 0, WORLD_W - 1e-3), clamp(z, 0, WORLD_H - 1e-3));
    if (d <= 0) return edge;
    const n = this.n;
    const roll = 0.35 + 1.6 * (n.fbm2(x * 0.011, z * 0.011, 4) * 0.5 + 0.5);
    const rise = 16 * smoothstep(14, 170, d);
    const far = 50 * smoothstep(110, 1400, d) * (0.5 + 1.0 * (n.fbm2(x * 0.0025 + 9, z * 0.0025, 3) * 0.5 + 0.5));
    const ridges = clamp(d - 40, 0, 300) * 0.05 * n.fbm2(x * 0.02 + 3, z * 0.02 - 5, 3);
    const s = smoothstep(0, 26, d);
    return edge * (1 - s) + (roll + rise + far + ridges) * s;
  }
}

/**
 * Height for an outer-ring vertex. Vertices on the map border are placed at the
 * minimum terrain edge height over their two adjacent 4 m segments (sampled at
 * the terrain's 1 m vertex spacing), so the terrain skirt always hides the
 * T-junction between the 1 m terrain edge and the 4 m outer grid.
 */
function ringHeight(h: OuterHeight, world: World, x: number, z: number): number {
  const onX = (x === 0 || x === WORLD_W) && z >= 0 && z <= WORLD_H;
  const onZ = (z === 0 || z === WORLD_H) && x >= 0 && x <= WORLD_W;
  if (!onX && !onZ) return h.height(x, z);
  let m = Infinity;
  for (let k = -CELL; k <= CELL; k++) {
    if (onX) m = Math.min(m, world.heightAt(Math.min(Math.max(x, 0), WORLD_W - 1e-3), Math.min(Math.max(z + k, 0), WORLD_H - 1e-3)));
    if (onZ) m = Math.min(m, world.heightAt(Math.min(Math.max(x + k, 0), WORLD_W - 1e-3), Math.min(Math.max(z, 0), WORLD_H - 1e-3)));
  }
  return m - 0.05;
}

function normalAt(h: OuterHeight, x: number, z: number, e: number, out: THREE.Vector3): THREE.Vector3 {
  const hl = h.height(x - e, z),
    hr = h.height(x + e, z),
    hd = h.height(x, z - e),
    hu = h.height(x, z + e);
  return out.set(hl - hr, 2 * e, hd - hu).normalize();
}

/** Grid ring between the map border and OUTER_RING (shares the ground material). */
function buildNearRing(h: OuterHeight, world: World): THREE.BufferGeometry {
  const minC = -Math.ceil(OUTER_RING / CELL) * CELL;
  const cells = Math.round((WORLD_W + 2 * -minC) / CELL);
  const cellsZ = Math.round((WORLD_H + 2 * -minC) / CELL);
  const n = cells + 1,
    nz = cellsZ + 1;
  const pos = new Float32Array(n * nz * 3);
  const nrm = new Float32Array(n * nz * 3);
  const v3 = new THREE.Vector3();
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < n; i++) {
      const x = minC + i * CELL,
        z = minC + j * CELL;
      const k = (j * n + i) * 3;
      pos[k] = x;
      pos[k + 1] = ringHeight(h, world, x, z);
      pos[k + 2] = z;
      normalAt(h, x, z, 1.5, v3);
      nrm[k] = v3.x;
      nrm[k + 1] = v3.y;
      nrm[k + 2] = v3.z;
    }
  const idx: number[] = [];
  for (let j = 0; j < cellsZ; j++)
    for (let i = 0; i < cells; i++) {
      const x0 = minC + i * CELL,
        z0 = minC + j * CELL;
      if (x0 >= 0 && x0 + CELL <= WORLD_W && z0 >= 0 && z0 + CELL <= WORLD_H) continue; // inside the map
      const a = j * n + i,
        b = a + 1,
        c = a + n,
        d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Polar ring from just inside the near ring out to the horizon. */
function buildFarRing(h: OuterHeight): THREE.BufferGeometry {
  const r0 = WORLD_W / 2 + OUTER_RING - 10;
  const radial = 22,
    ang = 120;
  const pos = new Float32Array((radial + 1) * ang * 3);
  const nrm = new Float32Array((radial + 1) * ang * 3);
  const v3 = new THREE.Vector3();
  for (let r = 0; r <= radial; r++) {
    const rad = r0 * Math.pow(FAR_R1 / r0, r / radial);
    for (let a = 0; a < ang; a++) {
      const th = (a / ang) * Math.PI * 2;
      const x = CX + Math.cos(th) * rad,
        z = CZ + Math.sin(th) * rad;
      const k = (r * ang + a) * 3;
      const insideNear = Math.abs(x - CX) < WORLD_W / 2 + OUTER_RING - 2 && Math.abs(z - CZ) < WORLD_H / 2 + OUTER_RING - 2;
      pos[k] = x;
      pos[k + 1] = h.height(x, z) - (insideNear ? 1.2 : 0);
      pos[k + 2] = z;
      normalAt(h, x, z, Math.max(2, rad * 0.02), v3);
      nrm[k] = v3.x;
      nrm[k + 1] = v3.y;
      nrm[k + 2] = v3.z;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < radial; r++)
    for (let a = 0; a < ang; a++) {
      const a1 = (a + 1) % ang;
      const p = r * ang + a,
        q = r * ang + a1,
        s = (r + 1) * ang + a,
        t = (r + 1) * ang + a1;
      idx.push(p, q, s, q, t, s);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ forest

function crownBlob(rng: () => number, detail: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const noise = new Noise(Math.floor(rng() * 1e6));
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + 0.22 * noise.noise3(v.x * 1.6, v.y * 1.6, v.z * 1.6);
    v.multiplyScalar(k);
    if (v.y < 0) v.y *= 0.55;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  // soften: blend toward spherical normals
  const nAttr = g.getAttribute('normal') as THREE.BufferAttribute;
  const n = new THREE.Vector3();
  for (let i = 0; i < nAttr.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    n.fromBufferAttribute(nAttr, i).lerp(v, 0.6).normalize();
    nAttr.setXYZ(i, n.x, n.y, n.z);
  }
  return g;
}

function withColor(g: THREE.BufferGeometry, fn: (y: number) => [number, number, number]): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const c = fn(p.getY(i));
    col[i * 3] = c[0];
    col[i * 3 + 1] = c[1];
    col[i * 3 + 2] = c[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vCount = 0,
    iCount = 0;
  const prepared = geos;
  for (const g of prepared) {
    vCount += g.getAttribute('position').count;
    iCount += g.index ? g.index.count : g.getAttribute('position').count;
  }
  const pos = new Float32Array(vCount * 3),
    nrm = new Float32Array(vCount * 3),
    col = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0,
    io = 0;
  for (const g of prepared) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    const c = g.getAttribute('color') as THREE.BufferAttribute;
    pos.set(p.array as Float32Array, vo * 3);
    nrm.set(n.array as Float32Array, vo * 3);
    col.set(c.array as Float32Array, vo * 3);
    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      io += gi.length;
    } else {
      for (let i = 0; i < p.count; i++) idx[io + i] = vo + i;
      io += p.count;
    }
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  for (const g of geos) g.dispose();
  return out;
}

/** Point normals of a lump toward the crown centre so overlapping lumps shade as one canopy. */
function canopyNormals(g: THREE.BufferGeometry, centre: THREE.Vector3, k: number): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const v = new THREE.Vector3(),
    m = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).sub(centre).normalize();
    m.fromBufferAttribute(n, i).lerp(v, k).normalize();
    n.setXYZ(i, m.x, m.y, m.z);
  }
}

function broadleafGeometry(seed: number): THREE.BufferGeometry {
  let s = seed;
  const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const trunk = new THREE.CylinderGeometry(0.18, 0.3, 3.0, 5, 1, true).translate(0, 1.5, 0);
  const centre = new THREE.Vector3(0, 5.0, 0);
  const lumps: THREE.BufferGeometry[] = [];
  const n = 4;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng() * 0.8;
    const top = i === 0;
    const r = top ? 0 : 1.3 + rng() * 0.5;
    const sz = top ? 2.3 : 1.7 + rng() * 0.5;
    const g = crownBlob(rng, 0)
      .scale(sz, sz * (0.8 + rng() * 0.25), sz)
      .translate(Math.cos(a) * r, centre.y + (top ? 0.9 : -0.3 + rng() * 0.6), Math.sin(a) * r);
    canopyNormals(g, centre, 0.82);
    lumps.push(g);
  }
  const col = (y: number): [number, number, number] => {
    const t = clamp((y - 3.4) / 4.5, 0, 1);
    return [0.5 + 0.5 * t, 0.56 + 0.44 * t, 0.5 + 0.5 * t];
  };
  withColor(trunk, () => [-1, -1, -1]); // marker: trunk (negative = bark colour in shader)
  for (const c of lumps) withColor(c, col);
  return mergeGeos([trunk, ...lumps]);
}

function coniferGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.1, 0.2, 1.4, 5, 1, true).translate(0, 0.7, 0);
  const tiers: THREE.BufferGeometry[] = [];
  const levels = 5;
  for (let i = 0; i < levels; i++) {
    const t = i / (levels - 1);
    const rad = 1.9 * (1 - t * 0.78);
    const h = 2.9 * (1 - t * 0.3);
    const y = 0.7 + i * 1.75 + h / 2;
    const c = new THREE.ConeGeometry(rad, h, 8, 1, true).translate(0, y, 0);
    // jitter the rim so tiers look shaggy rather than geometric
    const p = c.getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < p.count; k++) {
      if (p.getY(k) < y) {
        const j = 0.82 + 0.3 * Math.abs(Math.sin(k * 2.39 + i * 1.7));
        p.setXYZ(k, p.getX(k) * j, p.getY(k) - 0.25 * j, p.getZ(k) * j);
      }
    }
    c.computeVertexNormals();
    canopyNormals(c, new THREE.Vector3(0, y - h * 0.2, 0), 0.62);
    tiers.push(c);
  }
  const col = (y: number): [number, number, number] => {
    const t = clamp((y - 1.6) / 8, 0, 1);
    return [0.5 + 0.5 * t, 0.55 + 0.45 * t, 0.5 + 0.5 * t];
  };
  withColor(trunk, () => [-1, -1, -1]);
  for (const c of tiers) withColor(c, col);
  return mergeGeos([trunk, ...tiers]);
}

function makeBlobTexture(): THREE.DataTexture {
  const N = 64;
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N - 0.5,
        v = (y + 0.5) / N - 0.5;
      const r = Math.hypot(u, v) * 2;
      const a = Math.max(0, 1 - r);
      const val = Math.round(255 * a * a * (3 - 2 * a));
      const i = (y * N + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = val;
      d[i + 3] = 255;
    }
  const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export interface OuterLandOptions {
  treeCount: number;
}

export class OuterLand {
  readonly group = new THREE.Group();
  readonly heights: OuterHeight;
  private near: THREE.Mesh;
  private far: THREE.Mesh;
  private forest: THREE.InstancedMesh[] = [];
  /** x, y, z, height, crown radius per tree (for ground contact shadows). */
  private trees: Float32Array = new Float32Array(0);
  private treeCount = 0;
  private blobs: THREE.InstancedMesh | null = null;
  private blobMat: THREE.MeshBasicMaterial;
  private blobTex: THREE.DataTexture;
  private blobSunElev = -9;
  private blobStrength = -1;
  private forestMat: THREE.MeshStandardMaterial;
  private mountains: THREE.Mesh;
  private mountainMat: THREE.ShaderMaterial;
  private geos: THREE.BufferGeometry[] = [];
  readonly mountainUniforms: {
    uHaze: THREE.IUniform<THREE.Color>;
    uSunCol: THREE.IUniform<THREE.Color>;
    uAmb: THREE.IUniform<THREE.Color>;
    uSunDir: THREE.IUniform<THREE.Vector3>;
  };

  constructor(
    private world: World,
    groundMaterial: THREE.Material,
    noiseTex: THREE.Texture,
    opts: OuterLandOptions,
  ) {
    this.group.name = 'outer-land';
    this.heights = new OuterHeight(world, world.seed);
    const nearGeo = buildNearRing(this.heights, world);
    const farGeo = buildFarRing(this.heights);
    this.geos.push(nearGeo, farGeo);
    this.near = new THREE.Mesh(nearGeo, groundMaterial);
    this.near.receiveShadow = true;
    this.near.name = 'outer-near';
    this.far = new THREE.Mesh(farGeo, groundMaterial);
    this.far.name = 'outer-far';
    this.group.add(this.near, this.far);

    // forest material: vertex colour shading + leafy noise breakup
    this.forestMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    this.forestMat.name = 'outer-forest';
    const noiseU = { value: noiseTex };
    this.forestMat.onBeforeCompile = (sh) => {
      sh.uniforms.uNoise = noiseU;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFPos;\nvarying vec3 vFCol;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          vec4 fwp = modelMatrix * vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            fwp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
          #endif
          vFPos = fwp.xyz;
          vFCol = vec3(1.0);
          #ifdef USE_INSTANCING_COLOR
            vFCol = instanceColor;
          #endif`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uNoise;\nvarying vec3 vFPos;\nvarying vec3 vFCol;')
        .replace(
          '#include <color_fragment>',
          `{
            vec3 vc = vColor.rgb;
            if (vc.r < 0.0) {
              diffuseColor.rgb = vec3(0.045, 0.036, 0.028);
            } else {
              // leaf clumps: two projections of the noise texture
              float leaf = texture2D(uNoise, vFPos.xz * 1.3 + vFPos.y * 0.8).b * 0.55
                         + texture2D(uNoise, vFPos.zy * 1.1 + vFPos.x * 0.3).g * 0.45;
              // ragged, see-through silhouette toward grazing angles
              float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
              float lc = smoothstep(0.36, 0.64, leaf);
              if (lc < (1.0 - facing) * 1.25 - 0.3) discard;
              diffuseColor.rgb = vc * (0.3 + 1.0 * lc);
            }
          }`,
        );
    };
    this.blobTex = makeBlobTexture();
    this.blobMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      alphaMap: this.blobTex,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.blobMat.name = 'outer-tree-shadow';
    this.buildForest(opts.treeCount);

    // mountains
    this.mountainUniforms = {
      uHaze: { value: new THREE.Color(0.5, 0.6, 0.7) },
      uSunCol: { value: new THREE.Color(1, 1, 1) },
      uAmb: { value: new THREE.Color(0.2, 0.25, 0.3) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    };
    const mGeo = this.buildMountains();
    this.geos.push(mGeo);
    this.mountainMat = new THREE.ShaderMaterial({
      uniforms: this.mountainUniforms,
      vertexShader: /* glsl */ `
        attribute float aHaze;
        varying float vHaze;
        varying vec3 vN;
        varying float vY;
        void main() {
          vHaze = aHaze;
          vN = normal;
          vY = position.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uHaze;
        uniform vec3 uSunCol;
        uniform vec3 uAmb;
        uniform vec3 uSunDir;
        varying float vHaze;
        varying vec3 vN;
        varying float vY;
        void main() {
          vec3 n = normalize(vN);
          vec3 alb = vec3(0.06, 0.075, 0.07);
          vec3 lit = alb * (uSunCol * max(dot(n, uSunDir), 0.0) / 3.14159 + uAmb);
          float haze = mix(0.55, 0.74, vHaze) + 0.2 * (1.0 - smoothstep(0.0, 160.0, vY));
          vec3 col = mix(lit, uHaze * vec3(0.78, 0.84, 0.95), clamp(haze, 0.0, 0.97));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      fog: false,
      side: THREE.DoubleSide,
    });
    this.mountains = new THREE.Mesh(mGeo, this.mountainMat);
    this.mountains.name = 'mountains';
    this.mountains.frustumCulled = false;
    this.mountains.renderOrder = 900;
    this.group.add(this.mountains);
  }

  private buildForest(count: number) {
    const n = new Noise(this.world.seed + 101);
    let seed = this.world.seed * 13 + 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const variants = [broadleafGeometry(11), broadleafGeometry(23), coniferGeometry()];
    this.geos.push(...variants);
    // 4 quadrant sectors × 3 variants: compact bounding spheres let frustum
    // culling drop most of the forest in normal game views
    const SECT = 4;
    const lists: THREE.Matrix4[][] = Array.from({ length: 3 * SECT }, () => []);
    const tdata: number[] = [];
    const cols: THREE.Color[][] = Array.from({ length: 3 * SECT }, () => []);
    const m = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      s = new THREE.Vector3(),
      p = new THREE.Vector3(),
      up = new THREE.Vector3(0, 1, 0);
    const maxR = OUTER_RING + 160;
    let placed = 0,
      tries = 0;
    while (placed < count && tries < count * 30) {
      tries++;
      const x = -maxR + rnd() * (WORLD_W + 2 * maxR);
      const z = -maxR + rnd() * (WORLD_H + 2 * maxR);
      const d = OuterHeight.outside(x, z);
      if (d < 10) continue;
      // density: meadow strip, then scattered trees, then woodland with clearings
      const wood = n.fbm2(x * 0.012, z * 0.012, 3) * 0.5 + 0.5;
      let dens = smoothstep(10, 45, d) * (0.25 + 0.75 * smoothstep(0.35, 0.6, wood));
      dens *= 1 - smoothstep(OUTER_RING + 60, maxR, d) * 0.7;
      if (rnd() > dens) continue;
      const kind = wood > 0.62 && rnd() < 0.7 ? 2 : rnd() < 0.5 ? 0 : 1;
      const y = this.heights.height(x, z);
      const sc = (0.75 + rnd() * 0.6) * (kind === 2 ? 1.25 : 1) * (1 + Math.min(d, 200) / 600);
      p.set(x, y - 0.2, z);
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      s.set(sc * (0.85 + rnd() * 0.3), sc, sc * (0.85 + rnd() * 0.3));
      m.compose(p, q, s);
      const sector = (x < CX ? 0 : 1) + (z < CZ ? 0 : 2);
      const li = kind * SECT + sector;
      lists[li].push(m.clone());
      tdata.push(x, y, z, (kind === 2 ? 10.0 : 7.6) * sc, (kind === 2 ? 1.9 : 3.0) * sc);
      const hue = kind === 2 ? new THREE.Color(0.035, 0.06, 0.035) : new THREE.Color(0.055, 0.08, 0.03);
      const v = 0.75 + rnd() * 0.5;
      hue.multiplyScalar(v);
      if (kind !== 2 && rnd() < 0.25) hue.lerp(new THREE.Color(0.13, 0.13, 0.05), 0.5);
      cols[li].push(hue);
      placed++;
    }
    this.trees = new Float32Array(tdata);
    this.treeCount = tdata.length / 5;
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.geos.push(plane);
    this.blobs = new THREE.InstancedMesh(plane, this.blobMat, Math.max(1, this.treeCount));
    this.blobs.count = this.treeCount;
    this.blobs.frustumCulled = false;
    this.blobs.renderOrder = 1;
    this.blobs.name = 'outer-tree-shadows';
    this.group.add(this.blobs);
    for (let k = 0; k < lists.length; k++) {
      if (!lists[k].length) continue;
      const im = new THREE.InstancedMesh(variants[Math.floor(k / SECT)], this.forestMat, lists[k].length);
      for (let i = 0; i < lists[k].length; i++) {
        im.setMatrixAt(i, lists[k][i]);
        im.setColorAt(i, cols[k][i]);
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = false;
      im.receiveShadow = false;
      im.name = 'outer-forest';
      this.forest.push(im);
      this.group.add(im);
    }
  }

  private buildMountains(): THREE.BufferGeometry {
    const n = new Noise(this.world.seed + 555);
    const seg = 220;
    const ranges = [
      { r: 2100, base: -20, h: 170, haze: 0 },
      { r: 3000, base: -40, h: 360, haze: 1 },
    ];
    const pos: number[] = [],
      nrm: number[] = [],
      haze: number[] = [],
      idx: number[] = [];
    for (const rg of ranges) {
      const start = pos.length / 3;
      const rows = 3;
      for (let a = 0; a <= seg; a++) {
        const th = (a / seg) * Math.PI * 2;
        const ridge = Math.max(0, n.fbm2(Math.cos(th) * 3 + rg.r, Math.sin(th) * 3, 5) * 0.5 + 0.55);
        const sharp = Math.pow(ridge, 1.6);
        const top = rg.base + rg.h * sharp + 40;
        for (let r = 0; r < rows; r++) {
          const t = r / (rows - 1); // 0 = base, 1 = top
          const rad = rg.r - t * 120;
          const y = rg.base + (top - rg.base) * t;
          pos.push(CX + Math.cos(th) * rad, y, CZ + Math.sin(th) * rad);
          // normal: outward-facing toward the centre (we see the inner side) tilted up
          const slope = 0.45 + 0.35 * t;
          const nx = -Math.cos(th),
            nz = -Math.sin(th);
          const l = Math.hypot(nx, slope, nz);
          nrm.push(nx / l, slope / l, nz / l);
          haze.push(rg.haze);
        }
      }
      for (let a = 0; a < seg; a++)
        for (let r = 0; r < rows - 1; r++) {
          const i0 = start + a * rows + r,
            i1 = i0 + 1,
            j0 = start + (a + 1) * rows + r,
            j1 = j0 + 1;
          idx.push(i0, i1, j0, j0, i1, j1);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('aHaze', new THREE.Float32BufferAttribute(haze, 1));
    g.setIndex(idx);
    return g;
  }

  /** Objects that should stay out of screen-space AO (thin / distant / transparent). */
  aoExcluded(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [...this.forest, this.mountains];
    if (this.blobs) out.push(this.blobs);
    return out;
  }

  /** Re-sample heights next to the map border after terrain edits near the edge. */
  refreshBorder(): void {
    const g = this.near.geometry;
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i),
        z = p.getZ(i);
      if (OuterHeight.outside(x, z) > 30) continue;
      p.setY(i, ringHeight(this.heights, this.world, x, z));
    }
    p.needsUpdate = true;
  }

  /** Re-place the soft ground shadows under the outer trees for the current sun. */
  updateTreeShadows(sunDir: THREE.Vector3, strength: number): void {
    const blobs = this.blobs;
    if (!blobs) return;
    const elev = Math.asin(Math.min(1, Math.max(-1, sunDir.y)));
    const strengthChanged = Math.abs(strength - this.blobStrength) > 0.04;
    if (Math.abs(elev - this.blobSunElev) < 0.03 && !strengthChanged) return;
    this.blobStrength = strength;
    this.blobMat.opacity = 0.55 * strength;
    blobs.visible = strength > 0.02;
    if (!blobs.visible) return;
    if (Math.abs(elev - this.blobSunElev) < 0.03) return;
    this.blobSunElev = elev;
    const cot = 1 / Math.tan(Math.max(elev, 0.12));
    const dx = -sunDir.x,
      dz = -sunDir.z;
    const hl = Math.hypot(dx, dz) || 1;
    const ux = dx / hl,
      uz = dz / hl;
    const yaw = Math.atan2(ux, uz);
    const m = _m4,
      q = _q,
      sc = _s3,
      p = _p3;
    q.setFromAxisAngle(_up, yaw);
    const t = this.trees;
    for (let i = 0; i < this.treeCount; i++) {
      const x = t[i * 5],
        z = t[i * 5 + 2],
        h = t[i * 5 + 3],
        r = t[i * 5 + 4];
      // shadow of the crown centre (~0.65 h) projected along the sun
      const len = Math.min(h * 0.65 * cot, h * 3);
      const cx = x + ux * len * 0.85,
        cz = z + uz * len * 0.85;
      p.set(cx, t[i * 5 + 1] + 0.1, cz);
      sc.set(r * 2.1, 1, r * 2.1 + len * 0.9);
      m.compose(p, q, sc);
      blobs.setMatrixAt(i, m);
    }
    blobs.instanceMatrix.needsUpdate = true;
  }

  setMountainLight(haze: THREE.Color, sunCol: THREE.Color, amb: THREE.Color, sunDir: THREE.Vector3): void {
    this.mountainUniforms.uHaze.value.copy(haze);
    this.mountainUniforms.uSunCol.value.copy(sunCol);
    this.mountainUniforms.uAmb.value.copy(amb);
    this.mountainUniforms.uSunDir.value.copy(sunDir);
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const f of this.forest) f.dispose();
    this.blobs?.dispose();
    this.blobMat.dispose();
    this.blobTex.dispose();
    this.forestMat.dispose();
    this.mountainMat.dispose();
  }
}

