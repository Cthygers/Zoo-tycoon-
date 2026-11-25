// Orbit camera for the zoo: looks at a target point on the ground from a
// distance / pitch / yaw. Supports "grab the ground" panning, zoom and rotate
// around an anchor under the fingers, inertia, smooth go-to and follow mode
// (which may zoom in closer, to inspect a face or a coat, looking at the
// entity's body rather than its feet, beside any open side panel).
// Keeps the camera above the terrain and the target inside the map.

import * as THREE from 'three';
import { WATER_LEVEL, WORLD_H, WORLD_W } from '../core/constants';
import type { World } from '../core/world';

const DEG = Math.PI / 180;
/** Vertical FOV (deg) the distances below are tuned for (render/context.ts narrows it on wide screens). */
const BASE_FOV = 45;

export interface CameraLimits {
  /** Closest zoom of the free camera. */
  minDistance: number;
  /** Closest zoom while following an animal or a person: close enough to see faces, fabric and fur. */
  followMinDistance: number;
  maxDistance: number;
  minPitch: number; // radians
  maxPitch: number;
}

export const DEFAULT_LIMITS: CameraLimits = {
  minDistance: 8,
  followMinDistance: 5.25,
  maxDistance: 140,
  minPitch: 25 * DEG,
  maxPitch: 80 * DEG,
};

/**
 * Where a followed entity is: its ground position and, optionally, the height
 * (m above its feet) the camera should look at once zoomed in close, so a
 * person or animal sits in the middle of the view instead of its feet, and
 * the closest zoom it can be framed at (never closer than followMinDistance).
 */
export type FollowFn = () => { x: number; z: number; lookHeight?: number; minDistance?: number } | null;

/**
 * Distance (m) from which the look point starts rising from the ground to the
 * followed entity's lookHeight, for a subject framed at followMinDistance; a
 * subject that needs a farther closest zoom starts rising proportionally farther.
 */
const LIFT_FROM = 12;

/**
 * Closest follow distance per metre of a subject's height and of its body
 * length: on a 20:9 phone a 5 m giraffe shows from its head down to its hooves
 * at 8.5 m, and a 6 m elephant shows whole beside the info sheet from about
 * 6.5 m. Smaller subjects stay at followMinDistance.
 */
const FIT_PER_HEIGHT = 1.7;
const FIT_PER_LENGTH = 1.1;
/** Look-point height as a share of the subject's height: the chest or middle of most subjects… */
const LOOK_SHARE = 0.55;
/** …rising for subjects from TALL_FROM to TALL_FULL metres high, so a giraffe's head stays in frame. */
const LOOK_SHARE_TALL = 0.7;
const TALL_FROM = 3;
const TALL_FULL = 5;

/**
 * Close-up framing of a followed subject of the given standing height and
 * body length (m, as drawn): the height to look at and the closest zoom.
 */
export function followFraming(height: number, length: number): { lookHeight: number; minDistance: number } {
  const share = LOOK_SHARE + (LOOK_SHARE_TALL - LOOK_SHARE) * THREE.MathUtils.clamp((height - TALL_FROM) / (TALL_FULL - TALL_FROM), 0, 1);
  return { lookHeight: share * height, minDistance: Math.max(FIT_PER_HEIGHT * height, FIT_PER_LENGTH * length) };
}

const _ray = new THREE.Ray();
const _v = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _look = new THREE.Vector3();

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
  /**
   * Closest zoom right now: the followed subject's closest zoom while
   * following, minDistance otherwise. A floor that rises (following ends close
   * up, or a taller subject is picked) eases out, carrying the view with it.
   */
  private floor: number;
  /** Closest zoom for the followed subject (followMinDistance or more, see followFraming). */
  private followFloor: number;
  /** Height (m) of the look point above the ground target (rises when close to a followed entity). */
  private lift = 0;
  /** Screen x (NDC) a followed entity is kept at: the middle of the view the side panels leave clear. */
  followScreenX = 0;
  /** followScreenX eased, so a panel opening or closing slides the view instead of jumping it. */
  private screenX = 0;
  /**
   * Eased offset (x, z) from the look point to the followed entity: the render
   * focus (near-camera foliage cut, shadow and grass centre) is the entity
   * itself, also when it is kept beside a panel, and glides back when following ends.
   */
  private readonly focusOff = new THREE.Vector2();

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
    this.floor = this.limits.minDistance;
    this.followFloor = this.limits.followMinDistance;
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
    if (!this.followFn) {
      // a jump, not a glide: drop what is left of an ended follow's close-up framing
      this.floor = this.limits.minDistance;
      this.lift = 0;
      this.focusOff.set(0, 0);
    }
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
    this.distance = Math.min(L.maxDistance, Math.max(this.floor, this.distance));
    this.pitch = Math.min(L.maxPitch, Math.max(L.minPitch, this.pitch));
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /**
   * Camera distance per unit of `distance`. A FOV narrower than BASE_FOV
   * (capped horizontal FOV on wide phones) zooms in; the camera backs off by
   * the square root of that zoom (≈ +15 % on 20:9), so views keep most of
   * their framing while the longer lens flattens the perspective. Distances,
   * limits and callers' zoom levels stay in BASE_FOV terms.
   */
  private lensScale(): number {
    return Math.sqrt(Math.tan((BASE_FOV / 2) * DEG) / Math.tan((this.camera.fov / 2) * DEG));
  }

  /** Position the three.js camera from target / yaw / pitch / distance. */
  applyPose(): void {
    const cp = Math.cos(this.pitch);
    const cam = this.camera;
    const d = this.distance * this.lensScale();
    const look = _look.copy(this.target);
    look.y += this.lift;
    const px = look.x + Math.sin(this.yaw) * cp * d;
    const pz = look.z + Math.cos(this.yaw) * cp * d;
    let py = look.y + Math.sin(this.pitch) * d;
    const minY = this.groundHeight(px, pz) + 1.6;
    if (py < minY) py = minY;
    cam.position.set(px, py, pz);
    cam.lookAt(look);
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

  /**
   * Like focusOn, but the ground point ends up at the screen position (ndcX, ndcY)
   * instead of the centre, e.g. the middle of the area a side panel leaves uncovered.
   */
  focusAt(x: number, z: number, ndcX: number, ndcY: number, distance?: number, duration?: number): void {
    const d1 = distance === undefined ? this.distance : Math.min(this.limits.maxDistance, Math.max(this.limits.minDistance, distance));
    let ox = 0,
      oz = 0;
    // offset from the orbit target to the ground under (ndcX, ndcY); it only depends on the
    // orientation and grows linearly with the distance
    if (this.groundPointAt(ndcX, ndcY, this.target.y, _hit)) {
      const k = d1 / this.distance;
      ox = (_hit.x - this.target.x) * k;
      oz = (_hit.z - this.target.z) * k;
    }
    this.focusOn(x - ox, z - oz, distance, duration);
  }

  /** Follow a moving entity until the user pans or fn returns null. */
  follow(fn: FollowFn, distance?: number): void {
    this.followFn = fn;
    this.followFloor = this.subjectFloor(fn());
    // a lower floor applies at once (the view does not move); a higher one eases in (update)
    this.floor = Math.min(this.floor, this.followFloor);
    this.screenX = this.followScreenX;
    this.anim = null;
    this.velX = this.velZ = 0;
    if (distance !== undefined) this.distance = Math.min(this.distance, distance);
  }

  stopFollow(): void {
    if (!this.followFn) return;
    this.followFn = null;
    this.onFollowEnd?.();
  }

  private subjectFloor(p: ReturnType<FollowFn>): number {
    return Math.max(this.limits.followMinDistance, p?.minDistance ?? 0);
  }

  /**
   * Move the closest zoom to `want`: lowering it is immediate; raising it (after
   * following, or for a taller subject) eases, carrying a closer view smoothly out.
   */
  private easeFloor(want: number, dt: number): void {
    if (this.floor >= want) {
      this.floor = want;
      return;
    }
    this.floor = Math.max(this.floor, Math.min(this.distance, want));
    this.floor += (want - this.floor) * (1 - Math.exp(-dt * 4));
    if (want - this.floor < 0.01) this.floor = want;
    if (this.distance < this.floor) this.distance = this.floor;
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

    let lookHeight = 0;
    let offX = 0,
      offZ = 0;
    if (this.followFn) {
      const p = this.followFn();
      if (!p) this.stopFollow();
      else {
        const f = 1 - Math.exp(-dt * 5);
        this.screenX += (this.followScreenX - this.screenX) * f;
        // look beside the entity so it shows at screenX: half the view's width at the look
        // point is camDist · tan(hfov / 2); screen-right on the ground is (cos yaw, −sin yaw)
        const w = this.screenX * this.distance * this.lensScale() * Math.tan((this.camera.fov / 2) * DEG) * this.camera.aspect;
        this.target.x += (p.x - Math.cos(this.yaw) * w - this.target.x) * f;
        this.target.z += (p.z + Math.sin(this.yaw) * w - this.target.z) * f;
        this.clampTarget();
        this.followFloor = this.subjectFloor(p);
        const liftFrom = (LIFT_FROM * this.followFloor) / this.limits.followMinDistance;
        lookHeight = (p.lookHeight ?? 0) * THREE.MathUtils.smoothstep(liftFrom - this.distance, 0, liftFrom - this.followFloor);
        offX = p.x - this.target.x;
        offZ = p.z - this.target.z;
      }
    }
    this.easeFloor(this.followFn ? this.followFloor : this.limits.minDistance, dt);
    const ease = 1 - Math.exp(-dt * 5);
    this.lift += (lookHeight - this.lift) * ease;
    this.focusOff.x += (offX - this.focusOff.x) * ease;
    this.focusOff.y += (offZ - this.focusOff.y) * ease;

    // terrain-following target height (smoothed so it never jitters)
    const gy = this.groundHeight(this.target.x, this.target.z);
    this.target.y += (gy - this.target.y) * (1 - Math.exp(-dt * 8));

    this.applyPose();
    const cp = Math.cos(this.pitch);
    this.setFocus(this.target.x + this.focusOff.x, this.target.z + this.focusOff.y, this.distance * (0.85 + 1.5 * cp * cp));
  }
}

const KEY_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyQ', 'KeyE', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'PageUp', 'PageDown',
]);
