// Large rocks the follow camera has to look around. Small rocks on the
// camera → subject line dissolve with the occluder cut (lod/fade.ts), but an
// outcrop is ground an animal stands or lies on, so it stays; the camera
// swings its follow yaw instead (src/ui, through followBlockers). The props
// layer registers every outcrop-sized rock here as an ellipsoid around the
// part of its body above the ground (layer.ts outcropBody).

/** A rock body: centre (world, m), horizontal and vertical radius (m). */
export interface Blocker {
  x: number;
  y: number;
  z: number;
  r: number;
  ry: number;
}

/** A blocker the camera → subject segment passes through. */
export interface BlockerHit extends Blocker {
  /** Share of the segment (0 = camera, 1 = subject) at its deepest point inside the rock. */
  t: number;
  /** Side of the segment, seen from the camera, the rock's centre lies on: 1 = right, -1 = left. */
  side: number;
}

const blockers = new Map<number, Blocker>();

/** Register (or with null, drop) the rock body of a placed object. */
export function setBlocker(id: number, b: Blocker | null): void {
  if (b) blockers.set(id, b);
  else blockers.delete(id);
}

/** Drop every registered rock (layer rebuild / dispose). */
export function clearBlockers(): void {
  blockers.clear();
}

/** The segment stops this far (m) short of the subject: a rock the subject stands on or beside does not count. */
const SUBJECT_CLEAR = 0.8;
/** Height (m) of the subject's top above the queried body point when the caller gives none (a lion's head over its body). */
export const SUBJECT_TOP_UP = 0.6;

/**
 * Share (0..1) of the segment from the camera to `end` (stopping
 * SUBJECT_CLEAR short of it) at its deepest point inside rock `b`, or −1 when
 * it misses the rock: the closest point to the centre in the rock's
 * unit-sphere space.
 */
function segmentHit(cam: { x: number; y: number; z: number }, ex: number, ey: number, ez: number, b: Blocker): number {
  const dx = ex - cam.x;
  const dy = ey - cam.y;
  const dz = ez - cam.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-3) return -1;
  const tMax = Math.max(0, 1 - SUBJECT_CLEAR / len);
  const ax = (cam.x - b.x) / b.r;
  const ay = (cam.y - b.y) / b.ry;
  const az = (cam.z - b.z) / b.r;
  const ux = dx / b.r;
  const uy = dy / b.ry;
  const uz = dz / b.r;
  const uu = ux * ux + uy * uy + uz * uz;
  const t = Math.min(tMax, Math.max(0, -(ax * ux + ay * uy + az * uz) / uu));
  const px = ax + ux * t;
  const py = ay + uy * t;
  const pz = az + uz * t;
  return px * px + py * py + pz * pz < 1 ? t : -1;
}

/**
 * Large rocks hiding the subject from the camera, nearest the camera first:
 * those the segment to its body (e.g. about half its height above its feet)
 * or the segment to its top (`topY`, world height; default SUBJECT_TOP_UP
 * above the body point) passes through, so a rock that hides the body
 * counts even when the head shows over it, and one that hides the head of a
 * low-aimed subject too. Fills `out` (reused; its length is set) and returns
 * the number of hits. One cheap bounds check per registered rock, two
 * segment–ellipsoid tests only for those near the segment.
 */
export function followBlockers(cam: { x: number; y: number; z: number }, subject: { x: number; y: number; z: number }, out: BlockerHit[], topY = subject.y + SUBJECT_TOP_UP): number {
  let n = 0;
  if (Math.hypot(subject.x - cam.x, subject.y - cam.y, subject.z - cam.z) < 1e-3) {
    out.length = 0;
    return 0;
  }
  const dx = subject.x - cam.x;
  const dz = subject.z - cam.z;
  const minX = Math.min(cam.x, subject.x);
  const maxX = Math.max(cam.x, subject.x);
  const minZ = Math.min(cam.z, subject.z);
  const maxZ = Math.max(cam.z, subject.z);
  for (const b of blockers.values()) {
    if (b.x + b.r < minX || b.x - b.r > maxX || b.z + b.r < minZ || b.z - b.r > maxZ) continue;
    let t = segmentHit(cam, subject.x, subject.y, subject.z, b);
    if (t < 0) t = segmentHit(cam, subject.x, topY, subject.z, b);
    if (t < 0) continue;
    const hit = out[n] ?? (out[n] = { x: 0, y: 0, z: 0, r: 0, ry: 0, t: 0, side: 1 });
    hit.x = b.x;
    hit.y = b.y;
    hit.z = b.z;
    hit.r = b.r;
    hit.ry = b.ry;
    hit.t = t;
    // screen right of a camera looking along (dx, dz) is (-dz, dx) on the ground
    hit.side = (b.x - cam.x) * -dz + (b.z - cam.z) * dx >= 0 ? 1 : -1;
    n++;
  }
  out.length = n;
  out.sort(byT);
  return n;
}

const byT = (a: BlockerHit, b: BlockerHit) => a.t - b.t;
