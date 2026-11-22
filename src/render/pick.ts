// CPU ground picking: march the camera ray against world.heightAt (and the
// water plane where the ground dips below WATER_LEVEL), refine by bisection
// and clamp the result into the playable map. No mesh ray-casting needed.

import * as THREE from 'three';
import { WATER_LEVEL, WORLD_H, WORLD_W } from '../core/constants';
import type { World } from '../core/world';

const MAX_GROUND = 0.6; // relief never exceeds this (world relief ≤ 0.5 m)
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

function surface(world: World, x: number, z: number): number {
  return Math.max(world.heightAt(x, z), WATER_LEVEL);
}

export function pickGround(world: World, camera: THREE.Camera, ndcX: number, ndcY: number): THREE.Vector3 | null {
  camera.updateMatrixWorld();
  _o.setFromMatrixPosition(camera.matrixWorld);
  _d.set(ndcX, ndcY, 0.5).unproject(camera).sub(_o).normalize();
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    _o.set(ndcX, ndcY, -1).unproject(camera);
    _d.set(0, 0, -1).transformDirection(camera.matrixWorld);
  }
  let t = 0;
  if (_o.y > MAX_GROUND) {
    if (_d.y >= -1e-4) return null; // looking at the sky
    t = (_o.y - MAX_GROUND) / -_d.y;
  }
  const tMax = t + 2500;
  let prevT = t;
  let hit = false;
  for (let i = 0; i < 4000 && t < tMax; i++) {
    const x = _o.x + _d.x * t,
      y = _o.y + _d.y * t,
      z = _o.z + _d.z * t;
    if (y <= surface(world, x, z)) {
      hit = true;
      break;
    }
    // ray left the height slab upward: no hit
    if (_d.y >= 0 && y > MAX_GROUND) return null;
    prevT = t;
    t += 0.3 + t * 0.004;
  }
  if (!hit) {
    // grazing ray that never reached the ground: intersect a plane at the edge height
    if (_d.y >= -1e-4) return null;
    t = (_o.y - surface(world, WORLD_W / 2, WORLD_H / 2)) / -_d.y;
  } else {
    let lo = prevT,
      hi = t;
    for (let k = 0; k < 14; k++) {
      const m = (lo + hi) * 0.5;
      const x = _o.x + _d.x * m,
        y = _o.y + _d.y * m,
        z = _o.z + _d.z * m;
      if (y <= surface(world, x, z)) hi = m;
      else lo = m;
    }
    t = hi;
  }
  const x = Math.min(Math.max(_o.x + _d.x * t, 0), WORLD_W - 1e-3);
  const z = Math.min(Math.max(_o.z + _d.z * t, 0), WORLD_H - 1e-3);
  return new THREE.Vector3(x, surface(world, x, z), z);
}
