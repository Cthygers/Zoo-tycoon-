// Registry of placeable-object visuals. Builders live in src/props/nature and
// src/props/structures; the props layer (src/props/layer.ts) instances them.

import type * as THREE from 'three';
import type { QualitySettings } from '../core/contracts';

/**
 * Material userData conventions understood by the props layer:
 *  - material.userData.sway = number        → wind sway amplitude (metres at 1 m height, scaled by vertex height)
 *  - material.userData.nightEmissive = number → emissiveIntensity at full night (lamps, windows)
 * Mesh userData conventions:
 *  - mesh.userData.noShadow = true          → never cast shadows (tiny details, glass)
 */
export interface PropSpec {
  /**
   * Build one visual variant. Origin = footprint centre on the ground, facing +Z,
   * units metres, real-world scale. Should return a Group of Meshes whose
   * geometries/materials may be shared between variants. Keep each variant to
   * a handful of meshes (merge geometry per material) so instancing stays cheap.
   */
  build(variant: number, quality: QualitySettings): THREE.Object3D;
  /**
   * Optional cheaper version for distant instances (e.g. a tree with a
   * simplified crown or a camera-facing impostor). Same origin / scale.
   */
  buildLod?(variant: number, quality: QualitySettings): THREE.Object3D;
  /** Number of distinct variants; an instance uses seed % variants. */
  variants: number;
  /** Per-instance random yaw / uniform scale jitter (natural props). */
  jitter?: { yaw: boolean; scale: [number, number] };
  /** Not instanced: the layer clones the variant per placement (animated / unique props). */
  unique?: boolean;
  /** Per-frame animation for unique props (t = elapsed seconds). */
  animate?(obj: THREE.Object3D, t: number, nightFactor: number): void;
}

export const PROP_SPECS: Record<string, PropSpec> = {};

export function registerProp(defId: string, spec: PropSpec): void {
  PROP_SPECS[defId] = spec;
}
