// Smooth movement for people (guests and staff) between path tile centres,
// with a right-hand lane offset so two-way traffic does not overlap.

import { MAP_W, TILE } from '../core/constants';
import type { World } from '../core/world';
import type { Walker } from './state';

const TWO_PI = Math.PI * 2;
const TURN_RATE = 7; // rad/s

export function wrap(a: number): number {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

export function turnTowards(w: Walker, target: number, dt: number, rate = TURN_RATE) {
  const d = wrap(target - w.heading);
  const m = rate * dt;
  w.heading = Math.abs(d) <= m ? target : wrap(w.heading + Math.sign(d) * m);
}

/** Height of the surface a person stands on (boardwalk decks over water are raised). */
export function personY(world: World, x: number, z: number): number {
  return world.walkHeightAt(x, z);
}

/**
 * Walk towards the lane point of `w.next`. Returns true when the tile centre
 * (lane point) is reached: `tile` becomes `next` and `next` is reset to -1.
 */
export function walkToNext(world: World, w: Walker, dt: number, speedMul: number): boolean {
  const n = w.next;
  const nx = n % MAP_W,
    nz = (n / MAP_W) | 0;
  const tx = w.tile % MAP_W,
    tz = (w.tile / MAP_W) | 0;
  let fx = nx - tx,
    fz = nz - tz;
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl;
  fz /= fl;
  const px = (nx + 0.5) * TILE - fz * w.lane;
  const pz = (nz + 0.5) * TILE + fx * w.lane;
  const target = w.walkSpeed * speedMul;
  w.speed += Math.max(-4 * dt, Math.min(2.5 * dt, target - w.speed));
  // reached once the lane point is passed along the travel direction (robust to being jostled sideways)
  const along = (px - w.x) * fx + (pz - w.z) * fz;
  const step = Math.max(0.01, w.speed) * dt;
  if (along <= step && Math.abs((px - w.x) * fz - (pz - w.z) * fx) < 0.6) {
    const dx = px - w.x,
      dz = pz - w.z;
    const d = Math.hypot(dx, dz);
    const k = d > step ? step / d : 1;
    w.x += dx * k;
    w.z += dz * k;
    w.y = personY(world, w.x, w.z);
    w.prev = w.tile;
    w.tile = w.next;
    w.next = -1;
    return true;
  }
  return stepTo(world, w, px, pz, dt, true);
}

/** Straight move towards (ax, az). Returns true on arrival. */
export function approach(world: World, w: Walker, dt: number, speedMul = 0.7): boolean {
  const target = w.walkSpeed * speedMul;
  w.speed += Math.max(-4 * dt, Math.min(2.5 * dt, target - w.speed));
  if (stepTo(world, w, w.ax, w.az, dt, false)) {
    w.speed = 0;
    return true;
  }
  return false;
}

function stepTo(world: World, w: Walker, px: number, pz: number, dt: number, advanceTile: boolean): boolean {
  const dx = px - w.x,
    dz = pz - w.z;
  const d = Math.hypot(dx, dz);
  const step = Math.max(0.01, w.speed) * dt;
  if (d <= step + 1e-4) {
    w.x = px;
    w.z = pz;
    if (advanceTile) {
      w.prev = w.tile;
      w.tile = w.next;
      w.next = -1;
    }
    w.y = personY(world, w.x, w.z);
    return true;
  }
  w.x += (dx / d) * step;
  w.z += (dz / d) * step;
  if (d > 0.05) turnTowards(w, Math.atan2(dx, dz), dt);
  w.y = personY(world, w.x, w.z);
  return false;
}

/** Stand still (decelerate) and turn to a heading. */
export function standFacing(w: Walker, heading: number, dt: number) {
  w.speed = Math.max(0, w.speed - 4 * dt);
  turnTowards(w, heading, dt, 4);
}
