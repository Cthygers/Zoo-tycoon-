// Registry of placeable-object visuals. Builders live in src/props/nature and
// src/props/structures; the props layer (src/props/layer.ts) instances them.

import type * as THREE from 'three';
import type { QualitySettings } from '../core/contracts';

/**
 * Material userData conventions understood by the props layer:
 *  - material.userData.sway = number        → wind sway amplitude (metres at 1 m height, scaled by vertex height)
 *  - material.userData.nightEmissive = number → emissiveIntensity at full night (lamps, windows).
 *      Night glows are absolute (night exposure rises ~20×): the emissive colour already carries
 *      the strength, and nightEmissive ≥ 3 (lamp glass, bulbs) marks a lamp (halo + light pool).
 *  - material.userData.foliage = true       → leaves / fronds / stems: near-camera fade (see lod/fade.ts)
 *  - material.userData.fadeNear = true      → solid parts (bark, cactus): fade only while the camera is
 *      inside / right next to the plant (never cut by the view hole)
 *  - material.userData.crownFade = true     → with foliage (leaves) or fadeNear (bark): the whole tree drops out (piece by
 *      piece, leaves, limbs and trunk together) when the camera → focus line passes through its crown or limbs. Every
 *      geometry drawn with it needs the crown attributes (nature/geo.ts addCrownFade)
 *  - material.userData.trunkRadius = number → with fadeNear only: distance (m) from the trunk axis inside which the view
 *      hole never cuts (default 0.9, lod/fade.ts TRUNK_R)
 *  - material.userData.occluderReach = number → for structures, small rocks and ground plants (follow-mode occluder
 *      cut, lod/fade.ts applyOccluderCut): about the piece's half width (m), so a bulky piece counts as on the
 *      camera → subject line from that much farther out
 *  - material.userData.occluderTop = true    → every geometry drawn with it carries its height (lod/fade.ts setOcclTop):
 *      the occluder cut keeps a piece whose top stays below the camera → subject line
 *  - material.userData.occluderAnywhere = true → (boulders, ice) cut anywhere on the line in front of the subject,
 *      not only near the camera
 *  - material.userData.occluderShell = true  → (a den) cut whole while the followed subject stands inside it
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
