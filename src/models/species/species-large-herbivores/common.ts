// Shared helpers for the large herbivores (elephant, giraffe, rhino, hippo,
// camel): posture transitions (lying down / getting up as a sequence rather
// than a straight crossfade), pose blending, extra-bone mirroring and a few
// coat utilities. Nothing here allocates per frame.

import { Pose, rotLocal } from '../../rig/rig';
import { smooth } from '../../anim/util';
import type { AnimCtx, BoneSpec, Vec3 } from '../../types';

// ---------------------------------------------------------------------------
// Pose helpers

/** out = mix(out, src, w) per bone (slerp rotations, lerp offsets / scales). */
export function blendInto(out: Pose, src: Pose, w: number): void {
  if (w <= 0) return;
  const n = out.q.length;
  if (w >= 1) {
    out.copy(src);
    return;
  }
  for (let i = 0; i < n; i++) {
    out.q[i].slerp(src.q[i], w);
    out.p[i].lerp(src.p[i], w);
    out.s[i] += (src.s[i] - out.s[i]) * w;
  }
}

/** Apply per-bone angles (array) about one local axis. */
export function applyAngles(pose: Pose, bones: readonly number[], axis: 'x' | 'y' | 'z', angles: ArrayLike<number>, scale = 1): void {
  const n = Math.min(bones.length, angles.length);
  for (let i = 0; i < n; i++) rotLocal(pose, bones[i], axis, angles[i] * scale);
}

/** Mirror an extra (left-side, x > 0) bone spec to the right side: names `x.L` → `x.R`. */
function mirrorBone(b: BoneSpec): BoneSpec {
  const sw = (n: string | null) => (n && /\.L$/.test(n) ? n.slice(0, -2) + '.R' : n);
  return { name: sw(b.name)!, parent: sw(b.parent), pos: [-b.pos[0], b.pos[1], b.pos[2]] };
}

/** Left + right copies of extra bones (extra bones are not mirrored by quadSkeleton). */
export function bilateralBones(bones: readonly BoneSpec[]): BoneSpec[] {
  return [...bones, ...bones.map(mirrorBone)];
}

/** Linear interpolation between two points. */
export function lerpV(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ---------------------------------------------------------------------------
// Posture: a 0..1 "down" value that lying actions drive towards 1 and every
// other action drives back to 0. Lying actions render `lying(down)`; other
// actions blend their own pose with `lying(down)` while `down` is above 0,
// so lying down and getting up play as a sequence (and the framework's
// crossfade between the two slots is seamless).

export class Posture {
  /** 0 standing … 1 fully lying. */
  down = 0;
  /** true while getting up (sequence may differ from lying down). */
  rising = false;
  readonly tmp: Pose;
  constructor(bones: number) {
    this.tmp = new Pose(bones);
  }
}

/**
 * Advance the posture (call once per frame from driver.pre).
 * @param lying whether the current action is a lying one
 * @param downTime seconds to lie down, upTime seconds to get up
 */
export function updatePosture(ctx: AnimCtx, ps: Posture, lying: boolean, downTime: number, upTime: number): void {
  if (lying) {
    ps.rising = false;
    ps.down = Math.min(1, ps.down + ctx.dt / downTime);
  } else if (ps.down > 0) {
    ps.rising = true;
    ps.down = Math.max(0, ps.down - ctx.dt / upTime);
  } else ps.rising = false;
}

/** Pose function of the lying continuum (0 standing … 1 lying). */
export type LyingFn<S> = (ctx: AnimCtx, st: S, pose: Pose, down: number, rising: boolean) => void;

/**
 * For non-lying actions: while `down` > 0 (getting up), replace / blend the
 * action pose with the lying sequence. Fully the sequence above `fullBelow`.
 */
export function riseOverlay<S>(ctx: AnimCtx, st: S, ps: Posture, pose: Pose, lying: LyingFn<S>, fullBelow = 0.18): void {
  if (ps.down <= 0) return;
  ps.tmp.reset();
  lying(ctx, st, ps.tmp, ps.down, ps.rising);
  blendInto(pose, ps.tmp, smooth(0, fullBelow, ps.down));
}

// ---------------------------------------------------------------------------
// Small math helpers

/** Rise-hold-fall envelope over [a, d] with ramps a→b and c→d. */
export function envelope(v: number, a: number, b: number, c: number, d: number): number {
  return smooth(a, b, v) * (1 - smooth(c, d, v));
}

// ---------------------------------------------------------------------------
// Coat helpers

/** Distance from a point to segment ab plus the segment parameter t∈[0,1]. */
export function segDist(px: number, py: number, pz: number, a: Vec3, b: Vec3): { d: number; t: number } {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const l2 = bx * bx + by * by + bz * bz || 1;
  let t = ((px - a[0]) * bx + (py - a[1]) * by + (pz - a[2]) * bz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (a[0] + bx * t), dy = py - (a[1] + by * t), dz = pz - (a[2] + bz * t);
  _sd.d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  _sd.t = t;
  return _sd;
}
const _sd = { d: 0, t: 0 };

/**
 * Arc length parameter of the closest point on a polyline (metres from its
 * start) — used to lay rings (trunk wrinkles, neck folds) along a bent tube.
 */
export function polyArc(px: number, py: number, pz: number, pts: readonly Vec3[]): { s: number; d: number } {
  let best = 1e9, bestS = 0, acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const r = segDist(px, py, pz, a, b);
    if (r.d < best) {
      best = r.d;
      bestS = acc + r.t * len;
    }
    acc += len;
  }
  _pa.s = bestS;
  _pa.d = best;
  return _pa;
}
const _pa = { s: 0, d: 0 };


// ---------------------------------------------------------------------------
// Reticulated patch network (giraffe): a jittered body-centred-cubic point set
// split into two sublattices A (integer) and B (half-integer). The signed
// field dB − dA is smooth across A|B cell borders and crosses zero exactly on
// them, so linear interpolation between vertices keeps the border position —
// draw the network as thin per-pixel "stripes" at s = 0 (|s| stays < 0.9).
// A|A and B|B borders carry no line: those cells merge into larger, irregular
// patches, as they do on real animals.

function hash3(x: number, y: number, z: number, s: number): number {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f) ^ Math.imul(s | 0, 0x165667b1);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function nearestSub(px: number, py: number, pz: number, off: number, jitter: number, seed: number): number {
  const bx = Math.floor(px - off), by = Math.floor(py - off), bz = Math.floor(pz - off);
  let best = 1e9;
  for (let k = -1; k <= 2; k++)
    for (let j = -1; j <= 2; j++)
      for (let i = -1; i <= 2; i++) {
        const cx = bx + i, cy = by + j, cz = bz + k;
        const fx = cx + off + (hash3(cx, cy, cz, seed) - 0.5) * jitter;
        const fy = cy + off + (hash3(cx, cy, cz, seed + 1) - 0.5) * jitter;
        const fz = cz + off + (hash3(cx, cy, cz, seed + 2) - 0.5) * jitter;
        const dx = fx - px, dy = fy - py, dz = fz - pz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
  return Math.sqrt(best);
}

/**
 * Signed reticulation field in CELL units at a point given in cell units:
 * > 0 inside A-cells, < 0 inside B-cells, 0 on A|B borders.
 */
export function reticulation(px: number, py: number, pz: number, jitter = 0.45, seed = 7): number {
  const dA = nearestSub(px, py, pz, 0, jitter, seed);
  const dB = nearestSub(px, py, pz, 0.5, jitter, seed + 17);
  return dB - dA;
}
