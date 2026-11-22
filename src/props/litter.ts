// Litter: dropped paper cups, crumpled paper, snack wrappers and animal dung,
// drawn with one InstancedMesh per kind. Geometry is generated once
// (deterministically), instances get a seeded yaw / scale / tint per id.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { WATER_LEVEL } from '../core/constants';
import { hash3, hashFloat } from '../core/rng';
import type { Litter } from '../core/types';
import type { World } from '../core/world';

// ---------------------------------------------------------------------------
// Geometry

function setColor(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number, out: THREE.Color) => void): void {
  const p = g.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    fn(p.getX(i), p.getY(i), p.getZ(i), c);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  return g.index ? g.toNonIndexed() : g.clone();
}

function keep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal' && n !== 'color') g.deleteAttribute(n);
  return g;
}

/** A trodden-on paper cup lying on its side. */
function cupGeometry(): THREE.BufferGeometry {
  const side = new THREE.CylinderGeometry(0.04, 0.027, 0.092, 14, 4, true);
  const bottom = new THREE.CircleGeometry(0.027, 14);
  bottom.rotateX(Math.PI / 2);
  bottom.translate(0, -0.046, 0);
  const rim = new THREE.TorusGeometry(0.04, 0.0025, 4, 14);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 0.046, 0);
  const g = mergeGeometries([keep(flat(side)), keep(flat(bottom)), keep(flat(rim))])!;
  side.dispose();
  bottom.dispose();
  rim.dispose();
  // crush: flatten across one axis, dent the wall
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 0.62 + 0.25 * Math.cos(y * 30 + 0.7);
    const dent = 1 - 0.18 * Math.max(0, Math.cos(Math.atan2(z, x) * 2 + y * 20));
    p.setXYZ(i, x * dent, y, z * k * dent);
  }
  setColor(g, (_x, y, _z, c) => {
    if (y > 0.022 && y < 0.04) c.setRGB(0.42, 0.07, 0.05);
    else if (y > 0.044) c.setRGB(0.82, 0.8, 0.76);
    else c.setRGB(0.78, 0.76, 0.72);
  });
  g.rotateZ(Math.PI / 2 + 0.06);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox!.min.y - 0.004, 0);
  return g;
}

/** A crumpled ball of paper / napkin. */
function paperBallGeometry(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(0.03, 1);
  const g = keep(flat(ico));
  ico.dispose();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const s = 0.72 + 0.5 * hashFloat(Math.round(x * 1e4), Math.round(y * 1e4), Math.round(z * 1e4));
    p.setXYZ(i, x * s, y * s * 0.8, z * s);
  }
  g.computeVertexNormals();
  setColor(g, (x, y, z, c) => {
    const v = 0.74 + 0.08 * hashFloat(Math.round(x * 300), Math.round(y * 300), Math.round(z * 300));
    c.setRGB(v, v * 0.98, v * 0.93);
  });
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox!.min.y - 0.006, 0);
  return g;
}

/** A crinkled snack wrapper lying flat (tinted per instance). */
function wrapperGeometry(): THREE.BufferGeometry {
  const plane = new THREE.PlaneGeometry(0.13, 0.085, 8, 5);
  plane.rotateX(-Math.PI / 2);
  const g = keep(flat(plane));
  plane.dispose();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const kx = Math.round(x * 1e4);
    const kz = Math.round(z * 1e4);
    const edge = Math.max(Math.abs(x) / 0.065, Math.abs(z) / 0.0425);
    const crinkle = (hashFloat(kx, kz, 5) - 0.3) * 0.012;
    const lift = edge > 0.95 ? 0.004 + hashFloat(kx, kz, 6) * 0.014 : 0;
    const twist = Math.sin(x * 40) * 0.004;
    p.setXYZ(i, x * (1 - 0.15 * hashFloat(kx, kz, 7) * edge), Math.max(0, crinkle + lift + twist + 0.004), z);
  }
  g.computeVertexNormals();
  setColor(g, (x, _y, z, c) => {
    // printed body (tinted per instance), pale logo band, crimped ends
    if (Math.abs(x) > 0.052) c.setRGB(0.5, 0.5, 0.48);
    else if (Math.abs(z) < 0.012 && Math.abs(x) < 0.03) c.setRGB(0.95, 0.93, 0.88);
    else c.setRGB(0.62, 0.62, 0.62);
  });
  return g;
}

/** A pile of dung: a few squashed lumps. */
function dungGeometry(): THREE.BufferGeometry {
  const lumps: THREE.BufferGeometry[] = [];
  const spec: [number, number, number, number][] = [
    [0, 0, 0, 0.075],
    [0.07, 0, 0.035, 0.06],
    [-0.055, 0, 0.055, 0.055],
    [0.02, 0.05, -0.01, 0.05],
    [-0.04, 0, -0.065, 0.05],
    [0.085, 0, -0.06, 0.04],
  ];
  spec.forEach(([x, y, z, r], k) => {
    const ico = new THREE.IcosahedronGeometry(r, 2);
    const g = keep(flat(ico));
    ico.dispose();
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const px = p.getX(i);
      const py = p.getY(i);
      const pz = p.getZ(i);
      const n = 0.85 + 0.25 * hashFloat(Math.round(px * 2e3) + k * 31, Math.round(py * 2e3), Math.round(pz * 2e3));
      p.setXYZ(i, px * n + x, Math.max(py * n * 0.62 + y + r * 0.35, 0), pz * n + z);
    }
    lumps.push(g);
  });
  const g = mergeGeometries(lumps)!;
  for (const l of lumps) l.dispose();
  g.computeVertexNormals();
  setColor(g, (x, y, z, c) => {
    const v = hashFloat(Math.round(x * 400), Math.round(y * 400), Math.round(z * 400));
    c.setRGB(0.085 + v * 0.03, 0.066 + v * 0.02, 0.035 + v * 0.012);
  });
  return g;
}

// ---------------------------------------------------------------------------

const enum Kind {
  Cup = 0,
  Ball = 1,
  Wrapper = 2,
  Dung = 3,
}

/** Muted print colours for wrappers (instance colour multiplies vertex colour). */
const WRAPPER_TINTS = [0xb8402e, 0xd2a63c, 0x34619e, 0x4f8a44, 0xc8c8c8, 0x7d357d, 0xc86a28].map((h) => new THREE.Color(h));

class LitterBatch {
  mesh: THREE.InstancedMesh;
  private capacity = 0;
  count = 0;
  constructor(
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly parent: THREE.Object3D,
  ) {
    this.mesh = this.create(32);
  }
  private create(cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.geometry, this.material, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.castShadow = false;
    m.receiveShadow = true;
    m.name = 'litter';
    this.capacity = cap;
    this.parent.add(m);
    return m;
  }
  begin(n: number): void {
    if (n > this.capacity) {
      this.parent.remove(this.mesh);
      this.mesh.dispose();
      let cap = this.capacity;
      while (cap < n) cap *= 2;
      this.mesh = this.create(cap);
    }
    this.count = 0;
  }
  push(m: THREE.Matrix4, c: THREE.Color): void {
    this.mesh.setMatrixAt(this.count, m);
    this.mesh.setColorAt(this.count, c);
    this.count++;
  }
  end(): void {
    const m = this.mesh;
    m.count = this.count;
    m.visible = this.count > 0;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.boundingSphere = null;
    if (this.count) m.computeBoundingSphere();
  }
  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
  }
}

export class LitterRenderer {
  readonly group = new THREE.Group();
  private batches: LitterBatch[];
  private geometries: THREE.BufferGeometry[];
  private materials: THREE.Material[];
  /** Scratch: x, z, kind-code, id per item (reused between calls). */
  private scratch: number[] = [];
  private counts = [0, 0, 0, 0];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(private readonly world: World) {
    this.group.name = 'litter';
    const paper = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, side: THREE.DoubleSide });
    const foil = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.15, side: THREE.DoubleSide });
    const dung = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 });
    this.materials = [paper, foil, dung];
    this.geometries = [cupGeometry(), paperBallGeometry(), wrapperGeometry(), dungGeometry()];
    this.batches = [
      new LitterBatch(this.geometries[Kind.Cup], paper, this.group),
      new LitterBatch(this.geometries[Kind.Ball], paper, this.group),
      new LitterBatch(this.geometries[Kind.Wrapper], foil, this.group),
      new LitterBatch(this.geometries[Kind.Dung], dung, this.group),
    ];
  }

  set(items: Iterable<Litter>): void {
    const sc = this.scratch;
    sc.length = 0;
    const counts = this.counts;
    counts.fill(0);
    for (const it of items) {
      let kind: Kind;
      if (it.kind === 'dung') kind = Kind.Dung;
      else {
        const r = hashFloat(it.id, 11, 3);
        kind = r < 0.36 ? Kind.Cup : r < 0.68 ? Kind.Ball : Kind.Wrapper;
      }
      counts[kind]++;
      sc.push(it.x, it.z, kind, it.id);
    }
    for (let k = 0; k < 4; k++) this.batches[k].begin(counts[k]);
    for (let i = 0; i < sc.length; i += 4) {
      const x = sc[i];
      const z = sc[i + 1];
      const kind = sc[i + 2] as Kind;
      const id = sc[i + 3];
      const h0 = hash3(id, 977, 5);
      const yaw = (h0 / 4294967296) * Math.PI * 2;
      const r1 = hashFloat(id, 13, 7);
      const r2 = hashFloat(id, 17, 9);
      const y = Math.max(this.world.heightAt(x, z), WATER_LEVEL);
      let sxz = 1;
      let sy = 1;
      if (kind === Kind.Dung) {
        sxz = 0.75 + r1 * 0.85;
        sy = sxz * (0.7 + r2 * 0.5);
        this.c.setRGB(0.85 + r2 * 0.3, 0.85 + r2 * 0.25, 0.8 + r1 * 0.3);
      } else if (kind === Kind.Wrapper) {
        sxz = 1.05 + r1 * 0.4;
        this.c.copy(WRAPPER_TINTS[h0 % WRAPPER_TINTS.length]);
      } else {
        sxz = 1.1 + r1 * 0.3;
        sy = sxz;
        const t = 0.88 + r2 * 0.14;
        this.c.setRGB(t, t, t * (0.96 + r1 * 0.04));
      }
      this.e.set(0, yaw, 0);
      this.q.setFromEuler(this.e);
      this.s.set(sxz, kind === Kind.Wrapper ? 1 : sy, kind === Kind.Dung ? sxz * (0.8 + r2 * 0.4) : sxz);
      this.p.set(x, y, z);
      this.m.compose(this.p, this.q, this.s);
      this.batches[kind].push(this.m, this.c);
    }
    for (const b of this.batches) b.end();
  }

  setShadows(on: boolean): void {
    for (const b of this.batches) b.mesh.receiveShadow = on;
  }

  dispose(): void {
    for (const b of this.batches) b.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.group.removeFromParent();
  }
}
