// Small hand-held items (shared geometry, one vertex-coloured material).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type ItemKind = 'food' | 'drink' | 'icecream' | 'balloon' | 'gift' | 'broom';

let material: THREE.MeshStandardMaterial | null = null;
export function itemMaterial(): THREE.MeshStandardMaterial {
  if (!material) material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 });
  return material;
}

const cache = new Map<string, THREE.BufferGeometry>();

function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.getAttribute('position').count;
  const c = new THREE.Color(hex);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

const BALLOON_COLORS = [0xd8262e, 0x2f6fd0, 0xf2c230, 0x37a852, 0xe06aa8, 0xf07a2a];
const SCOOP_COLORS = [0xf3e6c8, 0xe9a3b4, 0x6b4128, 0xb6d99a];
const CUP_COLORS = [0xc8302b, 0x2a62b3, 0xe8e4dc];

/** Number of distinct colour variants of an item kind. */
export function itemVariants(kind: ItemKind): number {
  return kind === 'balloon' ? BALLOON_COLORS.length : kind === 'icecream' ? SCOOP_COLORS.length : kind === 'drink' ? CUP_COLORS.length : 1;
}

export const ITEM_KINDS: readonly ItemKind[] = ['food', 'drink', 'icecream', 'balloon', 'gift', 'broom'];

export function isItemKind(k: string): k is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(k);
}

/** Geometry for an item in the hand frame (origin at the wrist joint, hand hanging along −Y). */
export function itemGeometry(kind: ItemKind, variant: number): THREE.BufferGeometry {
  variant = Math.abs(Math.floor(variant)) % itemVariants(kind);
  const key = `${kind}:${variant}`;
  let g = cache.get(key);
  if (g) return g;
  const parts: THREE.BufferGeometry[] = [];
  const add = (geo: THREE.BufferGeometry, hex: number, m: THREE.Matrix4) => parts.push(paint(geo.applyMatrix4(m), hex));
  const M = (x: number, y: number, z: number, rx = 0) => new THREE.Matrix4().makeRotationX(rx).setPosition(x, y, z);
  switch (kind) {
    case 'food': {
      // wrapped sandwich held in the palm
      add(new THREE.BoxGeometry(0.075, 0.035, 0.11), 0xe2d6b8, M(0, 0, 0));
      add(new THREE.BoxGeometry(0.077, 0.012, 0.06), 0xb8432c, M(0, 0.012, 0.03));
      break;
    }
    case 'drink': {
      add(new THREE.CylinderGeometry(0.034, 0.027, 0.13, 14), CUP_COLORS[variant % CUP_COLORS.length], M(0, 0, 0));
      add(new THREE.CylinderGeometry(0.036, 0.036, 0.01, 14), 0xf2f2ee, M(0, 0.068, 0));
      add(new THREE.CylinderGeometry(0.004, 0.004, 0.1, 6), 0xf0f0f0, M(0.008, 0.11, 0));
      break;
    }
    case 'icecream': {
      add(new THREE.ConeGeometry(0.03, 0.11, 12).rotateX(Math.PI), 0xc38b4a, M(0, 0, 0));
      add(new THREE.SphereGeometry(0.036, 12, 10), SCOOP_COLORS[variant % SCOOP_COLORS.length], M(0, 0.06, 0));
      break;
    }
    case 'gift': {
      // paper carrier bag hanging from the hand
      add(new THREE.BoxGeometry(0.2, 0.24, 0.09), 0xb48a5a, M(0, -0.2, 0));
      add(new THREE.TorusGeometry(0.045, 0.005, 5, 12, Math.PI), 0x6a4a2a, M(0, -0.08, 0));
      break;
    }
    case 'balloon': {
      add(new THREE.SphereGeometry(0.15, 16, 12).scale(1, 1.18, 1), BALLOON_COLORS[variant % BALLOON_COLORS.length], M(0, 0, 0));
      add(new THREE.ConeGeometry(0.02, 0.03, 8).rotateX(Math.PI), BALLOON_COLORS[variant % BALLOON_COLORS.length], M(0, -0.185, 0));
      break;
    }
    case 'broom': {
      add(new THREE.CylinderGeometry(0.013, 0.013, 1.3, 8), 0x8a6a42, M(0, -0.25, 0));
      add(new THREE.BoxGeometry(0.32, 0.07, 0.06), 0x3a3a3a, M(0, -0.92, 0));
      add(new THREE.BoxGeometry(0.3, 0.07, 0.05), 0x6b5a3a, M(0, -0.99, 0));
      break;
    }
  }
  g = mergeGeometries(parts) ?? new THREE.BufferGeometry();
  parts.forEach((p) => p.dispose());
  g.computeVertexNormals();
  g.computeBoundingSphere();
  cache.set(key, g);
  return g;
}

/** Unit-length thin cylinder along +Y (balloon string), scaled per frame. */
let stringGeo: THREE.BufferGeometry | null = null;
export function stringGeometry(): THREE.BufferGeometry {
  if (!stringGeo) stringGeo = paint(new THREE.CylinderGeometry(0.0025, 0.0025, 1, 4).translate(0, 0.5, 0), 0xe8e8e8);
  return stringGeo;
}
