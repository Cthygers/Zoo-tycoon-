// Level-of-detail chain per cached creature mesh + the distance policy.
//
//   level 0 = the full mesh of the current quality tier (built during preload)
//   level 1 ≈ 50 %, level 2 ≈ 28 % of its triangles (the "far" LOD), and
//   level 3 ≈ 12 % for creatures that are only a few dozen pixels tall (zoomed
//   out overview). Levels ≥ 1 are built lazily, on first demand, by
//   normal-aware vertex clustering (see simplify.ts), one clustering pass per
//   step so the crowd renderer can spread builds over frames.
//
// LODs are chosen from the camera distance normalised by the creature's size
// (an elephant keeps its full mesh much farther away than a penguin), with
// hysteresis so creatures walking at a threshold do not flicker between meshes.
// Only creatures near the camera cast shadows.

import * as THREE from 'three';
import type { QualityLevel, QualitySettings } from '../../core/contracts';
import { SimplifyJob } from './simplify';

/** Triangle ratio of each LOD level relative to level 0. */
export const LOD_RATIOS: readonly number[] = [1, 0.5, 0.28, 0.12];
export const LOD_LEVELS = LOD_RATIOS.length;

export class LodChain {
  readonly levels: (THREE.BufferGeometry | null)[];
  readonly triangles: number[];
  readonly ms: number[];
  /** Generous bounding sphere (mesh space) shared by every level (covers all poses). */
  readonly sphere: THREE.Sphere;

  constructor(base: THREE.BufferGeometry, sphere: THREE.Sphere, baseTriangles: number) {
    this.levels = LOD_RATIOS.map((_, i) => (i === 0 ? base : null));
    this.triangles = LOD_RATIOS.map((_, i) => (i === 0 ? baseTriangles : 0));
    this.ms = LOD_RATIOS.map(() => 0);
    this.sphere = sphere;
  }

  has(level: number): boolean {
    return !!this.levels[level];
  }

  private readonly jobs: (SimplifyJob | null)[] = LOD_RATIOS.map(() => null);

  /**
   * Advance the build of a level by one clustering pass (≈ 0.3–1 ms). Returns
   * true once the level exists. Lets the crowd renderer spread LOD builds over
   * frames.
   */
  step(level: number): boolean {
    if (this.levels[level]) return true;
    let job = this.jobs[level];
    if (!job) job = this.jobs[level] = new SimplifyJob(this.levels[0]!, LOD_RATIOS[level]);
    if (!job.step()) return false;
    const g = job.result!;
    g.boundingSphere = this.sphere.clone();
    this.levels[level] = g;
    this.triangles[level] = job.stats.triangles;
    this.ms[level] = job.stats.ms;
    this.jobs[level] = null;
    return true;
  }

  /** Build a level now (no-op when built). */
  build(level: number): THREE.BufferGeometry {
    while (!this.step(level));
    return this.levels[level]!;
  }

  /** Finest built level ≥ `want`'s detail that is available (falls back towards level 0). */
  best(want: number): number {
    for (let l = want; l > 0; l--) if (this.levels[l]) return l;
    return 0;
  }

  dispose(): void {
    // level 0 belongs to the asset; only the derived levels are ours
    for (let i = 1; i < this.levels.length; i++) {
      this.levels[i]?.dispose();
      this.levels[i] = null;
    }
  }
}

/** Distances (m, for a 1.8 m tall creature) per quality tier. */
export interface LodPolicy {
  /** Normalised distance thresholds: level k+1 is used beyond d[k] (length = LOD_LEVELS − 1). */
  d: readonly number[];
  /** Relative hysteresis band (a creature must move this fraction past a threshold to switch). */
  hysteresis: number;
  /** Creatures farther than this (m, scaled up for big animals) cast no shadow. */
  shadow: number;
  shadows: boolean;
}

const POLICY: Record<QualityLevel, Omit<LodPolicy, 'shadows'>> = {
  low: { d: [10, 22, 42], hysteresis: 0.12, shadow: 45 },
  medium: { d: [13, 28, 55], hysteresis: 0.12, shadow: 60 },
  high: { d: [20, 42, 80], hysteresis: 0.12, shadow: 80 },
};

export function lodPolicy(q: QualitySettings): LodPolicy {
  return { ...(POLICY[q.level] ?? POLICY.medium), shadows: q.shadows };
}

/** Size factor used to normalise distances (1 for a 1.8 m human). */
export function sizeFactor(height: number, radius: number): number {
  return Math.max(0.6, Math.max(height, radius * 2) / 1.8);
}

/**
 * Pick a LOD level for a normalised distance, with hysteresis around the
 * current level (pure function; tested).
 */
export function pickLod(current: number, nd: number, p: LodPolicy): number {
  const t = p.d;
  let want = 0;
  while (want < t.length && nd >= t[want]) want++;
  if (current < 0 || want === current) return want;
  const h = 1 + p.hysteresis;
  let l = current;
  if (want > current) {
    // coarsen only once clearly past each threshold
    while (l < want && nd >= t[l] * h) l++;
  } else {
    // refine only once clearly inside each threshold
    while (l > want && nd < t[l - 1] / h) l--;
  }
  return l;
}

/** Shadow casting decision (distance in metres, size factor as above). */
export function castsShadow(dist: number, size: number, p: LodPolicy): boolean {
  return p.shadows && dist < p.shadow * Math.min(2, Math.max(1, size));
}
