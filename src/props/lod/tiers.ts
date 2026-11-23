// Per-quality-tier distances for the props layer.

import type { QualitySettings } from '../../core/contracts';

export interface PropsTier {
  /** Smallest max-draw distance (m) for any part (small props / details). */
  minCull: number;
  /**
   * Screen-size culling: a part of bounding radius r is drawn up to
   * max(minCull, r × cullK) metres from the camera (≈ a few pixels on screen).
   */
  cullK: number;
  /** Camera distance (m) where objects with a buildLod switch to it (±8 % hysteresis). */
  lodDist: number;
  /** Shadow casters: horizontal distance (m) from the camera focus for ordinary casters. */
  shadowNear: number;
  /** … for tall casters (trees, buildings) and LOD parts. */
  shadowFar: number;
  /** Real point lights on the lamps nearest the focus. */
  pointLights: number;
  /** Near-camera foliage fade enabled. */
  fade: boolean;
  /** Multiplier on lamp-glass emissive at night (bloom on post-FX tiers). */
  lampGlow: number;
  /** Shadow pass uses this many LOD levels coarser than the view (0 = same). */
  shadowLodBias: number;
  /** Camera distance (m) beyond which fences use their detail-0 build (0 = never). */
  fenceLod: number;
  /** Props cast shadows only when taller (m) … */
  castH: number;
  /** … or wider (footprint radius, m) than this … */
  castR: number;
  /** … and never when thinner (footprint radius, m) than this (lamp posts, signposts). */
  castMinR: number;
}

export function propsTier(q: QualitySettings): PropsTier {
  const D = q.detailDistance;
  switch (q.level) {
    case 'low':
      // every caster material is one more shadow-pass draw: only buildings, shelters, trees and
      // bamboo cast (not shrubs, reeds, carts, feeders, small shelters or lamp posts)
      return { minCull: Math.max(D * 1.6, 38), cullK: 110, lodDist: 34, shadowNear: 30, shadowFar: 62, pointLights: 0, fade: true, lampGlow: 1, shadowLodBias: 1, fenceLod: 0, castH: 2.7, castR: 2.2, castMinR: 0.75 };
    case 'high':
      return { minCull: Math.max(D * 1.6, 70), cullK: 210, lodDist: 72, shadowNear: 70, shadowFar: 140, pointLights: 2, fade: true, lampGlow: 0.15, shadowLodBias: 0, fenceLod: 70, castH: 0.8, castR: 1.1, castMinR: 0 };
    default:
      return { minCull: Math.max(D * 1.6, 55), cullK: 150, lodDist: 50, shadowNear: 46, shadowFar: 95, pointLights: 0, fade: true, lampGlow: 0.15, shadowLodBias: 1, fenceLod: 42, castH: 1.0, castR: 1.25, castMinR: 0 };
  }
}
