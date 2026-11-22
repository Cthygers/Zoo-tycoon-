// Material palette for built props. Every getter is cached and shared by all
// structures (the props layer batches per material, so a small shared palette
// keeps draw calls low). Shared surfaces from ../materials (timber, weathered
// timber, galvanised and painted steel, stone, concrete, glass) are re-used
// directly so structures batch together with fences and other props.

import * as THREE from 'three';
import {
  concreteMaterial,
  galvanisedMaterial,
  glassMaterial,
  paintedMetalMaterial,
  stoneMaterial,
  weatheredWoodMaterial,
  woodMaterial,
} from '../materials';
import { NO_SHADOW } from './kit';
import { interiorTexture, signTexture } from './signs';
import { ballSurface, fabricSurface, surface, type StructSurface, type Surface } from './tex';

const cache = new Map<string, THREE.Material>();

function cached<T extends THREE.Material>(key: string, make: () => T): T {
  let m = cache.get(key) as T | undefined;
  if (!m) {
    m = make();
    m.name = `struct/${key}`;
    cache.set(key, m);
  }
  return m;
}

function pbr(s: Surface, params: THREE.MeshStandardMaterialParameters = {}, normalScale = 1): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: s.map,
    normalMap: s.normalMap,
    roughnessMap: s.orm,
    metalnessMap: s.orm,
    aoMap: s.orm,
    roughness: 1,
    metalness: 1,
    ...params,
  });
  m.normalScale.set(normalScale, normalScale);
  return m;
}

const surf = (k: StructSurface) => surface(k);

/** Tile sizes (metres per repeat) of each surface, for UV authoring. */
export const TILE = {
  boards: 1.2,
  hardwood: 1,
  thatch: 1,
  clayTiles: 1,
  corrugated: 0.54,
  render: 2,
  brick: 0.9,
  ashlar: 1.2,
  hay: 0.5,
  rope: 0.12,
  net: 0.25,
  water: 1.5,
  meat: 0.3,
  wood: 1,
  stone: 1.5,
  concrete: 2,
  metal: 1,
  fabric: 0.5,
} as const;

// Re-exported shared surfaces ------------------------------------------------

/** Planed hardwood (benches, tables, posts, trims), tinted by stain. */
export function hardwood(tint: number = 0xffffff): THREE.MeshStandardMaterial {
  return cached(`hardwood:${tint.toString(16)}`, () => pbr(surf('hardwood'), { metalness: 0, color: tint }));
}
/** Hardwood stain tints (keep this palette small: each tint is a material). */
export const HW = {
  natural: 0xffffff,
  honey: 0xd2b494,
  dark: 0x8f765f,
} as const;

/** Default structural / joinery timber. */
export const timber = (): THREE.MeshStandardMaterial => hardwood();
/** Shared props timber (fences use it too). */
export const sharedTimber = (): THREE.MeshStandardMaterial => woodMaterial();
export const weathered = (): THREE.MeshStandardMaterial => weatheredWoodMaterial();
export const galv = (): THREE.MeshStandardMaterial => galvanisedMaterial();
export const paint = (hex: number): THREE.MeshStandardMaterial => paintedMetalMaterial(hex);
export const rock = (): THREE.MeshStandardMaterial => stoneMaterial();
export const concrete = (): THREE.MeshStandardMaterial => concreteMaterial();

export function glass(): THREE.MeshStandardMaterial {
  const m = glassMaterial({ opacity: 0.1 });
  NO_SHADOW.add(m);
  return m;
}

/** Clear acrylic (donation box): lighter tint, no laminated edge. */
export function acrylic(): THREE.MeshStandardMaterial {
  const m = glassMaterial({ tint: 0x101414, opacity: 0.05, edgeTint: false });
  NO_SHADOW.add(m);
  return m;
}

// Palette colours --------------------------------------------------------------

/** Brand / architecture colours (sRGB hex). */
export const COL = {
  ironGreen: 0x1f2b25,
  ironBlack: 0x1b1c1c,
  forest: 0x2f4537,
  olive: 0x4d5338,
  cream: 0xd9cfb6,
  oxblood: 0x5e2622,
  slate: 0x3a4246,
  sand: 0xb9a37f,
  charcoal: 0x2a2b2b,
  white: 0xd8d6cf,
  renderCream: 0xe4d6bb,
  renderSage: 0xb7c1ad,
} as const;

// Own surfaces -------------------------------------------------------------------

/** Cladding / deck boards, tinted (stain colour). */
export function boards(tint: number): THREE.MeshStandardMaterial {
  return cached(`boards:${tint.toString(16)}`, () => pbr(surf('boards'), { metalness: 0, color: tint }));
}

export const STAIN = {
  /** warm mid-brown oiled timber */
  oak: 0xffd2a6,
  /** dark tropical / creosote stain */
  dark: 0xa48468,
  /** silver-grey weathered */
  grey: 0xd9d6d0,
  /** painted sage cladding */
  sage: 0xa8b8a0,
} as const;

export function thatch(): THREE.MeshStandardMaterial {
  return cached('thatch', () => pbr(surf('thatch'), { metalness: 0 }, 1.1));
}

export function clayTiles(): THREE.MeshStandardMaterial {
  return cached('clayTiles', () => pbr(surf('clayTiles'), { metalness: 0 }));
}

export function corrugated(hex: number): THREE.MeshStandardMaterial {
  return cached(`corr:${hex.toString(16)}`, () => pbr(surf('corrugated'), { color: hex, metalness: 1, envMapIntensity: 0.9 }));
}

export function render(hex: number): THREE.MeshStandardMaterial {
  return cached(`render:${hex.toString(16)}`, () => pbr(surf('render'), { color: hex, metalness: 0 }));
}

export function brick(): THREE.MeshStandardMaterial {
  return cached('brick', () => pbr(surf('brick'), { metalness: 0 }));
}

export function ashlar(): THREE.MeshStandardMaterial {
  return cached('ashlar', () => pbr(surf('ashlar'), { metalness: 0 }));
}

export function hay(): THREE.MeshStandardMaterial {
  return cached('hay', () => pbr(surf('hay'), { metalness: 0 }, 1.2));
}

export function rope(): THREE.MeshStandardMaterial {
  return cached('rope', () => pbr(surf('rope'), { metalness: 0 }));
}

export function net(): THREE.MeshStandardMaterial {
  return cached('net', () => {
    const m = pbr(surf('net'), { metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide });
    return m;
  });
}

export function meat(): THREE.MeshStandardMaterial {
  return cached('meat', () => pbr(surf('meat'), { metalness: 0 }));
}

export function bone(): THREE.MeshStandardMaterial {
  return cached('bone', () => new THREE.MeshStandardMaterial({ color: 0xb3a688, roughness: 0.7, metalness: 0 }));
}

/** Still water (troughs, ponds): dark, glossy, rippled normal map. */
export function water(): THREE.MeshStandardMaterial {
  return cached('water', () => {
    const s = surf('water');
    const m = new THREE.MeshStandardMaterial({
      color: 0x0d1512,
      roughness: 0.06,
      metalness: 0,
      normalMap: s.normalMap,
      envMapIntensity: 1.2,
    });
    m.normalScale.set(0.35, 0.35);
    NO_SHADOW.add(m);
    return m;
  });
}

/** Fountain pool water: own texture instance so its ripples can scroll. */
export function fountainWater(): THREE.MeshStandardMaterial {
  return cached('fountainWater', () => {
    const s = surf('water');
    const n = s.normalMap.clone();
    n.needsUpdate = true;
    const m = new THREE.MeshStandardMaterial({
      color: 0x10211f,
      roughness: 0.04,
      metalness: 0,
      normalMap: n,
      envMapIntensity: 1.3,
      transparent: true,
      opacity: 0.88,
    });
    m.normalScale.set(0.45, 0.45);
    NO_SHADOW.add(m);
    return m;
  });
}

/** Falling sheets / jets of water (scrolling streak texture). */
export function fallingWater(): THREE.MeshStandardMaterial {
  return cached('falls', () => {
    const s = surf('falls');
    const map = s.map.clone();
    map.needsUpdate = true;
    const m = new THREE.MeshStandardMaterial({
      map,
      color: 0xdde8ea,
      roughness: 0.1,
      metalness: 0,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      side: THREE.DoubleSide,
      envMapIntensity: 1.4,
      emissive: 0x2a3436,
    });
    NO_SHADOW.add(m);
    return m;
  });
}

export function ball(hex: number): THREE.MeshStandardMaterial {
  return cached(`ball:${hex.toString(16)}`, () => pbr(ballSurface(hex), { metalness: 0 }));
}

export function fabric(a: number, b: number): THREE.MeshStandardMaterial {
  return cached(`fabric:${a.toString(16)}:${b.toString(16)}`, () => pbr(fabricSurface(a, b), { metalness: 0, side: THREE.DoubleSide }));
}

export function rubber(): THREE.MeshStandardMaterial {
  return cached('rubber', () => new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.88, metalness: 0 }));
}

export function brass(): THREE.MeshStandardMaterial {
  return cached('brass', () => new THREE.MeshStandardMaterial({ color: 0x9c7a3c, roughness: 0.38, metalness: 1 }));
}

export function steel(): THREE.MeshStandardMaterial {
  return cached('steel', () => new THREE.MeshStandardMaterial({ color: 0x9da2a4, roughness: 0.32, metalness: 1 }));
}

/** Black polythene bin liner / dark plastic. */
export function plasticDark(): THREE.MeshStandardMaterial {
  return cached('plasticDark', () => new THREE.MeshStandardMaterial({ color: 0x1c1d1e, roughness: 0.5, metalness: 0 }));
}

/** Near-black unlit void (cave interior, deep hatches). */
export function voidDark(): THREE.MeshStandardMaterial {
  return cached('void', () => new THREE.MeshStandardMaterial({ color: 0x050403, roughness: 1, metalness: 0, envMapIntensity: 0 }));
}

/** Painted signs (no glow). */
export function signs(): THREE.MeshStandardMaterial {
  return cached('signs', () => new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.62, metalness: 0 }));
}

/** Signs that are floodlit at night (shops, entrance). */
export function signsLit(): THREE.MeshStandardMaterial {
  return cached('signsLit', () => {
    const t = signTexture();
    const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, metalness: 0, emissive: 0xffe2b8, emissiveMap: t, emissiveIntensity: 0 });
    m.userData.nightEmissive = 0.55;
    return m;
  });
}

/** Window interiors: glow warmly at night. */
export function interior(): THREE.MeshStandardMaterial {
  return cached('interior', () => {
    const t = interiorTexture();
    const m = new THREE.MeshStandardMaterial({
      map: t,
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      emissive: 0xffd9a8,
      emissiveMap: t,
      emissiveIntensity: 0,
      // fully rough: interiors get dim ambient but no sky reflections (glass
      // panes in front carry the reflections where present)
      envMapIntensity: 0.45,
    });
    m.userData.nightEmissive = 1.4;
    NO_SHADOW.add(m);
    return m;
  });
}

/** Lamp lantern glass: frosted by day, bright at night. */
export function lampGlow(): THREE.MeshStandardMaterial {
  return cached('lampGlow', () => {
    const m = new THREE.MeshStandardMaterial({
      color: 0xe8e2d2,
      roughness: 0.25,
      metalness: 0,
      emissive: 0xffc982,
      emissiveIntensity: 0,
      transparent: false,
    });
    m.userData.nightEmissive = 6;
    NO_SHADOW.add(m);
    return m;
  });
}

/** Small warm bulb / downlight (kiosks, booths) glowing at night. */
export function bulbGlow(): THREE.MeshStandardMaterial {
  return cached('bulbGlow', () => {
    const m = new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.3, metalness: 0, emissive: 0xffcf8c, emissiveIntensity: 0 });
    m.userData.nightEmissive = 4;
    NO_SHADOW.add(m);
    return m;
  });
}

/** Free cached materials of this module (textures are freed separately). */
export function disposeStructMaterials(): void {
  for (const m of cache.values()) m.dispose();
}
