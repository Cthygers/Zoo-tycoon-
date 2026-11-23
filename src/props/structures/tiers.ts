// Quality tiers and distant LODs for built props. Every builder runs inside
// a Kit detail mode: the tier scales round segment counts (low 0.65×, high
// 1.35×; squares / octagons stay), and buildLod re-runs the same builder in
// LOD mode (round parts at half the segments, pieces under ~11 cm dropped,
// window interiors reduced to their back panel). Same origin, scale and
// materials, so LOD instances share the full model's batches.

import type * as THREE from 'three';
import type { QualityLevel, QualitySettings } from '../../core/contracts';
import type { PropSpec } from '../registry';
import { withDetail } from './kit';

const SEG: Record<QualityLevel, number> = { low: 0.65, medium: 1, high: 1.35 };

type Build = (v: number) => THREE.Object3D;

/** build (+ buildLod unless `lod` is false) for a builder, honouring the quality tier. */
export function tiered(build: Build, lod = true): Pick<PropSpec, 'build' | 'buildLod'> {
  const seg = (q?: QualitySettings) => SEG[q?.level ?? 'medium'] ?? 1;
  const out: Pick<PropSpec, 'build' | 'buildLod'> = {
    build: (v, q) => withDetail({ seg: seg(q), lod: false }, () => build(v)),
  };
  if (lod) out.buildLod = (v, q) => withDetail({ seg: seg(q), lod: true }, () => build(v));
  return out;
}
