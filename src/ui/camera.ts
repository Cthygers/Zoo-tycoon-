// Orbit camera for the zoo: looks at a target point on the ground from a
// distance / pitch / yaw. Supports "grab the ground" panning, zoom and rotate
// around an anchor under the fingers, inertia, smooth go-to and follow mode.
// Keeps the camera above the terrain and the target inside the map.

import * as THREE from 'three';
import { WATER_LEVEL, WORLD_H, WORLD_W } from '../core/constants';
import type { World } from '../core/world';

const DEG = Math.PI / 180;

export interface CameraLimits {
  minDistance: number;
  maxDistance: number;
  minPitch: number; // radians
  maxPitch: number;
}

export const DEFAULT_LIMITS: CameraLimits = {
  minDistance: 8,
  maxDistance: 140,
  minPitch: 25 * DEG,
  maxPitch: 80 * DEG,
};

export type FollowFn = () => { x: number; z: number } | null;

const _ray = new THREE.Ray();
const _v = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _hit = new THREE.Vector3();

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class CameraController {
  /** Ground point the camera orbits (y follows the terrain smoothly). */
  readonly target = new THREE.Vector3();
  yaw = 0;
  pitch = 48 * DEG;
  distance = 52;
  readonly limits: CameraLimits;

  /** Called when follow mode ends (user panned or the entity disappeared). */
  onFollowEnd: (() => void) | null = null;

  private velX = 0;
  private velZ = 0;
  private velYaw = 0;
  private velZoom = 0; // d(log distance)/s
  private accX = 0;
  private accZ = 0;
  private accYaw = 0;
  private accZoom = 0;
  private interacting = 0;
  private anim: { x0: number; z0: number; x1: number; z1: number; d0: number; d1: number; t: number; dur: number } | null = null;
  private followFn: FollowFn | null = null;
  private keys = new Set<string>();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private world: World,
    private setFocus: (x: number, z: number, viewRadius: number) => void,
    limits: Partial<CameraLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.target.set(WORLD_W / 2, 0, WORLD_H * 0.8);
    this.target.y = this.groundHeight(this.target.x, this.target.z);
    this.applyPose();
  }

  // ------------------------------------------------------------ state
  get following(): boolean {
    return this.followFn !== null;
  }

  setView(x: number, z: number, distance?: number, yaw?: number, pitch?: number): void {
    this.target.x = x;
    this.target.z = z;
    this.clampTarget();
    this.target.y = this.groundHeight(this.target.x, this.target.z);
    if (distance !== undefined) this.distance = distance;
    if (yaw !== undefined) this.yaw = yaw;
    if (pitch !== undefined) this.pitch = pitch;
    this.clampOrbit();
    this.anim = null;
    this.velX = this.velZ = this.velYaw = this.velZoom = 0;
    this.applyPose();
  }

  private groundHeight(x: number, z: number): number {
    return Math.max(this.world.heightAt(x, z), WATER_LEVEL);
  }

  private clampTarget(): void {
    this.target.x = Math.min(WORLD_W, Math.max(0, this.target.x));
    this.target.z = Math.min(WORLD_H, Math.max(0, this.target.z));
  }

  private clampOrbit(): void {
    const L = this.limits;
    this.distance = Math.min(L.maxDistance, Math.max(L.minDistance, this.distance));
    this.pitch = Math.min(L.maxPitch, Math.max(L.minPitch, this.pitch));
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /** Position the three.js camera from target / yaw / pitch / distance. */
  applyPose(): void {
    const cp = Math.cos(this.pitch);
    const cam = this.camera;
    const px = this.target.x + Math.sin(this.yaw) * cp * this.distance;
    const pz = this.target.z + Math.cos(this.yaw) * cp * this.distance;
    let py = this.target.y + Math.sin(this.pitch) * this.distance;
    const floor = this.groundHeight(px, pz) + 1.6;
    if (py < floor) py = floor;
    cam.position.set(px, py, pz);
    cam.lookAt(this.target);
    cam.updateMatrixWorld();
  }

  // ------------------------------------------------------------ direct manipulation
  /** Ground point (on the horizontal plane y = planeY) under an NDC position. */
  groundPointAt(ndcX: number, ndcY: number, planeY: number, out: THREE.Vector3): boolean {
    const cam = this.camera;
    _ray.origin.setFromMatrixPosition(cam.matrixWorld);
    _v.set(ndcX, ndcY, 0.5).unproject(cam).sub(_ray.origin).normalize();
    _ray.direction.copy(_v);
    if (_ray.direction.y > -0.02) return false; // at / above the horizon
    const t = (planeY - _ray.origin.y) / _ray.direction.y;
    if (t <= 0) return false;
    out.copy(_ray.direction).multiplyScalar(t).add(_ray.origin);
    // ignore absurdly far grazing hits
    return out.distanceTo(_ray.origin) < this.distance * 8 + 200;
  }

  beginInteraction(kind: 'pan' | 'orbit'): void {
    this.interacting++;
    this.anim = null;
    this.velX = this.velZ = this.velYaw = this.velZoom = 0;
    this.accX = this.accZ = this.accYaw = this.accZoom = 0;
    if (kind === 'pan') this.stopFollow();
  }

  endInteraction(): void {
    this.interacting = Math.max(0, this.interacting - 1);
  }

  /** Translate the target by a world delta (clamped to the map). */
  panBy(dx: number, dz: number): void {
    if (dx === 0 && dz === 0) return;
    // limit single-step jumps from grazing rays
    const max = this.distance * 0.75;
    const len = Math.hypot(dx, dz);
    if (len > max) {
      dx *= max / len;
      dz *= max / len;
    }
    const ox = this.target.x,
      oz = this.target.z;
    this.target.x += dx;
    this.target.z += dz;
    this.clampTarget();
    this.accX += this.target.x - ox;
    this.accZ += this.target.z - oz;
    this.applyPose();
  }

  /**
   * Zoom by a factor (<1 = closer) and rotate by dyaw, keeping the ground point
   * under `ndcFrom` (before) under `ndcTo` (after) — the core of pinch / twist / wheel.
   */
  zoomRotateAround(factor: number, dyaw: number, ndcFromX: number, ndcFromY: number, ndcToX: number, ndcToY: number): void {
    const planeY = this.target.y;
    const hasAnchor = this.groundPointAt(ndcFromX, ndcFromY, planeY, _anchor);
    const d0 = this.distance;
    this.distance *= factor;
    this.yaw += dyaw;
    this.clampOrbit();
    if (this.distance !== d0) this.accZoom += Math.log(this.distance / d0);
    this.accYaw += dyaw;
    this.applyPose();
    if (hasAnchor && this.groundPointAt(ndcToX, ndcToY, planeY, _hit)) {
      if (this.followFn) return; // keep the followed entity centred
      this.panBy(_anchor.x - _hit.x, _anchor.z - _hit.z);
    }
  }

  rotateBy(dyaw: number, dpitch: number): void {
    this.yaw += dyaw;
    this.pitch += dpitch;
    this.accYaw += dyaw;
    this.clampOrbit();
    this.applyPose();
  }

  /** Smoothly move the view to a ground point. */
  focusOn(x: number, z: number, distance?: number, duration = 0.75): void {
    this.anim = {
      x0: this.target.x,
      z0: this.target.z,
      x1: Math.min(WORLD_W, Math.max(0, x)),
      z1: Math.min(WORLD_H, Math.max(0, z)),
      d0: this.distance,
      d1: distance === undefined ? this.distance : Math.min(this.limits.maxDistance, Math.max(this.limits.minDistance, distance)),
      t: 0,
      dur: Math.max(0.05, duration),
    };
    this.velX = this.velZ = 0;
  }

  /** Follow a moving entity until the user pans or fn returns null. */
  follow(fn: FollowFn, distance?: number): void {
    this.followFn = fn;
    this.anim = null;
    this.velX = this.velZ = 0;
    if (distance !== undefined) this.distance = Math.min(this.distance, distance);
  }

  stopFollow(): void {
    if (!this.followFn) return;
    this.followFn = null;
    this.onFollowEnd?.();
  }

  // ------------------------------------------------------------ keyboard (desktop)
  keyDown(code: string): boolean {
    if (!KEY_CODES.has(code)) return false;
    this.keys.add(code);
    return true;
  }
  keyUp(code: string): void {
    this.keys.delete(code);
  }
  clearKeys(): void {
    this.keys.clear();
  }

  // ------------------------------------------------------------ per frame
  update(dt: number): void {
    dt = Math.min(0.1, Math.max(0, dt));
    const k = this.keys;
    if (k.size && dt > 0) {
      let rt = 0,
        fwd = 0;
      if (k.has('KeyW') || k.has('ArrowUp')) fwd += 1;
      if (k.has('KeyS') || k.has('ArrowDown')) fwd -= 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) rt -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) rt += 1;
      if (rt || fwd) {
        this.stopFollow();
        this.anim = null;
        const sp = this.distance * 0.9 * dt;
        const s = Math.sin(this.yaw),
          c = Math.cos(this.yaw);
        // screen-right on the ground = (c, -s); forward (away from camera) = (-s, -c)
        this.target.x += (rt * c - fwd * s) * sp;
        this.target.z += (-rt * s - fwd * c) * sp;
        this.clampTarget();
      }
      if (k.has('KeyQ')) this.yaw += 1.4 * dt;
      if (k.has('KeyE')) this.yaw -= 1.4 * dt;
      if (k.has('Equal') || k.has('NumpadAdd')) this.distance *= Math.exp(-1.6 * dt);
      if (k.has('Minus') || k.has('NumpadSubtract')) this.distance *= Math.exp(1.6 * dt);
      if (k.has('PageUp')) this.pitch += 0.9 * dt;
      if (k.has('PageDown')) this.pitch -= 0.9 * dt;
      this.clampOrbit();
    }

    if (this.interacting > 0) {
      // estimate velocities from the manipulation since the last frame
      if (dt > 0) {
        const a = 0.4;
        this.velX += (this.accX / dt - this.velX) * a;
        this.velZ += (this.accZ / dt - this.velZ) * a;
        this.velYaw += (this.accYaw / dt - this.velYaw) * a;
        this.velZoom += (this.accZoom / dt - this.velZoom) * a;
      }
    } else if (dt > 0) {
      // inertia
      const decay = Math.exp(-dt * 5.5);
      if (Math.abs(this.velX) + Math.abs(this.velZ) > 0.05) {
        this.target.x += this.velX * dt;
        this.target.z += this.velZ * dt;
        this.clampTarget();
        this.velX *= decay;
        this.velZ *= decay;
      } else this.velX = this.velZ = 0;
      if (Math.abs(this.velYaw) > 0.002) {
        this.yaw += this.velYaw * dt;
        this.velYaw *= Math.exp(-dt * 6.5);
      } else this.velYaw = 0;
      if (Math.abs(this.velZoom) > 0.002) {
        this.distance *= Math.exp(this.velZoom * dt);
        this.velZoom *= Math.exp(-dt * 7);
      } else this.velZoom = 0;
      this.clampOrbit();
    }
    this.accX = this.accZ = this.accYaw = this.accZoom = 0;

    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(1, a.t + dt / a.dur);
      const e = easeInOut(a.t);
      this.target.x = a.x0 + (a.x1 - a.x0) * e;
      this.target.z = a.z0 + (a.z1 - a.z0) * e;
      this.distance = a.d0 + (a.d1 - a.d0) * e;
      if (a.t >= 1) this.anim = null;
    }

    if (this.followFn) {
      const p = this.followFn();
      if (!p) this.stopFollow();
      else {
        const f = 1 - Math.exp(-dt * 5);
        this.target.x += (p.x - this.target.x) * f;
        this.target.z += (p.z - this.target.z) * f;
        this.clampTarget();
      }
    }

    // terrain-following target height (smoothed so it never jitters)
    const gy = this.groundHeight(this.target.x, this.target.z);
    this.target.y += (gy - this.target.y) * (1 - Math.exp(-dt * 8));

    this.applyPose();
    const cp = Math.cos(this.pitch);
    this.setFocus(this.target.x, this.target.z, this.distance * (0.85 + 1.5 * cp * cp));
  }
}

const KEY_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyQ', 'KeyE', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'PageUp', 'PageDown',
]);
