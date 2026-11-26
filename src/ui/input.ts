// Pointer / touch / mouse / keyboard input on the 3D view.
//
// Touch:  select mode — 1 finger drag pans, tap selects.
//         build mode  — 1 finger drives the active tool; 2 fingers always move the camera.
//         2 fingers   — pinch zoom + twist rotate + pan around the fingers, or (fingers side
//                       by side moving vertically together) tilt.
// Mouse:  left drag pans (select) / uses the tool (build), right drag orbits, middle drag pans,
//         wheel zooms toward the cursor, hover previews the tool.
//
// At the end of each gesture (all fingers or the mouse button up) and after each burst of
// wheel turns (200 ms quiet) a GestureSummary goes to the `gesture` callback: how far the
// view was panned, zoomed, turned and tilted, with how many fingers, or that it was a tap.

import * as THREE from 'three';
import type { GestureSummary } from '../core/ui-ext';
import type { CameraController } from './camera';

export interface ToolInput {
  /** True when a build tool consumes one-finger gestures. */
  readonly active: boolean;
  down(ndcX: number, ndcY: number): void;
  move(ndcX: number, ndcY: number): void;
  up(ndcX: number, ndcY: number, tap: boolean): void;
  /** Gesture aborted (second finger, pointer cancel): revert the in-progress drag. */
  cancel(): void;
  /** Mouse moved without buttons (desktop preview). */
  hover(ndcX: number, ndcY: number): void;
  leave(): void;
}

export interface InputCallbacks {
  tool: ToolInput;
  /** Tap / click in select mode. */
  select(ndcX: number, ndcY: number): void;
  /** Any pointer went down on the 3D view. */
  touchedView(): void;
  /** Non-camera key press (Escape, Enter, R …). Return true if handled. */
  key(code: string): boolean;
  /**
   * A gesture ended. Units: `pan` = screen px the panning finger / mouse travelled,
   * `zoom` = summed |Δ ln camera distance|, `turn` and `tilt` = summed |Δ yaw| and |Δ pitch|
   * in degrees; `fingers` = most pointers down at once (the mouse counts 1); `tap` = a quick
   * touch or click without movement (in select or build mode).
   */
  gesture?(g: GestureSummary): void;
}

interface Ptr {
  id: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  t0: number;
  type: string;
}

/** 'rest': one finger left down after a pinch / twist; it pans once it moves (lifting it is no tap). */
type Mode = 'idle' | 'pending' | 'pan' | 'tool' | 'multi' | 'orbit' | 'locked' | 'rest';

const TOUCH_SLOP = 10;
const MOUSE_SLOP = 4;
const TOOL_DELAY_MS = 90;
const TAP_MS = 650;
/** A burst of wheel turns ends after this quiet time (ms). */
const WHEEL_BURST_MS = 200;
const RAD2DEG = 180 / Math.PI;

const _a = new THREE.Vector3();

/** A gesture's running totals (see InputCallbacks.gesture for the units). */
interface GestureAcc {
  pan: number;
  zoom: number;
  turn: number;
  tilt: number;
  fingers: number;
  tap: boolean;
}

const newAcc = (): GestureAcc => ({ pan: 0, zoom: 0, turn: 0, tilt: 0, fingers: 0, tap: false });

/** Smallest signed difference of two angles (rad). */
function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class InputController {
  private ptrs = new Map<number, Ptr>();
  private mode: Mode = 'idle';
  private primary = -1;
  private rect: DOMRect;
  private planeY = 0;
  private anchor = new THREE.Vector3();
  private hasAnchor = false;
  private toolTimer = 0;
  // two-finger state
  private prevMidX = 0;
  private prevMidY = 0;
  private prevSpan = 1;
  private prevAngle = 0;
  private multiKind: 'undecided' | 'transform' | 'tilt' = 'undecided';
  private multiMove = 0;
  private startP1 = { x: 0, y: 0 };
  private startP2 = { x: 0, y: 0 };
  private offs: (() => void)[] = [];
  /** The touch / mouse gesture in progress (null between gestures), and the current wheel burst. */
  private acc: GestureAcc | null = null;
  private wheelAcc: GestureAcc | null = null;
  private wheelTimer = 0;

  constructor(
    private canvas: HTMLElement,
    private cam: CameraController,
    private cb: InputCallbacks,
  ) {
    this.rect = canvas.getBoundingClientRect();
    const on = <E extends Event>(t: EventTarget, type: string, fn: (e: E) => void, opts?: AddEventListenerOptions) => {
      const h = fn as EventListener;
      t.addEventListener(type, h, opts);
      this.offs.push(() => t.removeEventListener(type, h, opts));
    };
    on(canvas, 'pointerdown', (e: PointerEvent) => this.onDown(e));
    on(canvas, 'pointermove', (e: PointerEvent) => this.onMove(e));
    on(canvas, 'pointerup', (e: PointerEvent) => this.onUp(e, false));
    on(canvas, 'pointercancel', (e: PointerEvent) => this.onUp(e, true));
    on(canvas, 'pointerleave', (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && this.mode === 'idle') this.cb.tool.leave();
    });
    on(canvas, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    on(canvas, 'contextmenu', (e: Event) => e.preventDefault());
    on(window, 'resize', () => (this.rect = canvas.getBoundingClientRect()));
    on(window, 'keydown', (e: KeyboardEvent) => this.onKey(e, true));
    on(window, 'keyup', (e: KeyboardEvent) => this.onKey(e, false));
    on(window, 'blur', () => this.cam.clearKeys());
    // Block browser gestures (iOS pinch, double-tap zoom) on the view.
    on(canvas, 'touchstart', (e: TouchEvent) => e.preventDefault(), { passive: false });
    on(canvas, 'gesturestart', (e: Event) => e.preventDefault());
  }

  /** Pointers down on the 3D view right now. */
  get pointers(): number {
    return this.ptrs.size;
  }

  dispose(): void {
    window.clearTimeout(this.toolTimer);
    window.clearTimeout(this.wheelTimer);
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** Abort whatever gesture is running (e.g. the tool changed mid-drag). */
  reset(): void {
    window.clearTimeout(this.toolTimer);
    if (this.mode === 'pan' || this.mode === 'multi' || this.mode === 'orbit') this.cam.endInteraction();
    this.mode = this.ptrs.size ? 'locked' : 'idle';
  }

  // ------------------------------------------------------------ gesture summaries
  /** Run a camera change and add how much it zoomed, turned and tilted to `acc`. */
  private tracked(acc: GestureAcc | null, fn: () => void): void {
    const c = this.cam;
    const d0 = c.distance;
    const y0 = c.yaw;
    const p0 = c.pitch;
    fn();
    if (!acc) return;
    if (d0 > 0 && c.distance > 0) acc.zoom += Math.abs(Math.log(c.distance / d0));
    acc.turn += Math.abs(angleDelta(c.yaw, y0)) * RAD2DEG;
    acc.tilt += Math.abs(c.pitch - p0) * RAD2DEG;
  }

  private emit(a: GestureAcc): void {
    const g: GestureSummary = {
      pan: Math.round(a.pan * 10) / 10,
      zoom: a.zoom,
      turn: a.turn,
      tilt: a.tilt,
      fingers: a.fingers >= 2 ? 2 : 1,
      tap: a.tap,
    };
    try {
      this.cb.gesture?.(g);
    } catch (err) {
      console.error('[ui] gesture handler failed', err);
    }
  }

  /** All pointers are up: the gesture is over (a build-tool drag or a long press that moved nothing says nothing). */
  private endGesture(): void {
    const a = this.acc;
    if (!a || this.ptrs.size) return;
    this.acc = null;
    if (a.tap || a.pan > 0 || a.zoom > 0 || a.turn > 0 || a.tilt > 0) this.emit(a);
  }

  // ------------------------------------------------------------ helpers
  private ndcX(x: number): number {
    return ((x - this.rect.left) / Math.max(1, this.rect.width)) * 2 - 1;
  }
  private ndcY(y: number): number {
    return -(((y - this.rect.top) / Math.max(1, this.rect.height)) * 2 - 1);
  }

  private startPan(p: Ptr, fromStart: boolean): void {
    this.mode = 'pan';
    this.cam.beginInteraction('pan');
    this.planeY = this.cam.target.y;
    const x = fromStart ? p.sx : p.x,
      y = fromStart ? p.sy : p.y;
    this.hasAnchor = this.cam.groundPointAt(this.ndcX(x), this.ndcY(y), this.planeY, this.anchor);
    if (fromStart) this.panTo(p, p.x - p.sx, p.y - p.sy);
  }

  private panTo(p: Ptr, dx = 0, dy = 0): void {
    if (this.acc) this.acc.pan += Math.hypot(dx, dy);
    if (!this.hasAnchor) {
      this.hasAnchor = this.cam.groundPointAt(this.ndcX(p.x), this.ndcY(p.y), this.planeY, this.anchor);
      return;
    }
    if (this.cam.groundPointAt(this.ndcX(p.x), this.ndcY(p.y), this.planeY, _a)) {
      this.cam.panBy(this.anchor.x - _a.x, this.anchor.z - _a.z);
    }
  }

  private startTool(p: Ptr): void {
    window.clearTimeout(this.toolTimer);
    if (this.mode !== 'pending') return;
    this.mode = 'tool';
    this.cb.tool.down(this.ndcX(p.sx), this.ndcY(p.sy));
    if (p.x !== p.sx || p.y !== p.sy) this.cb.tool.move(this.ndcX(p.x), this.ndcY(p.y));
  }

  private twoPointers(): [Ptr, Ptr] | null {
    let a: Ptr | null = null,
      b: Ptr | null = null;
    for (const p of this.ptrs.values()) {
      if (!a) a = p;
      else if (!b) b = p;
    }
    return a && b ? [a, b] : null;
  }

  private startMulti(): void {
    const pair = this.twoPointers();
    if (!pair) return;
    const [a, b] = pair;
    this.mode = 'multi';
    this.cam.beginInteraction('orbit');
    this.prevMidX = (a.x + b.x) / 2;
    this.prevMidY = (a.y + b.y) / 2;
    this.prevSpan = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    this.prevAngle = Math.atan2(b.y - a.y, b.x - a.x);
    this.multiKind = 'undecided';
    this.multiMove = 0;
    this.startP1 = { x: a.x, y: a.y };
    this.startP2 = { x: b.x, y: b.y };
  }

  // ------------------------------------------------------------ events
  private onDown(e: PointerEvent): void {
    this.rect = this.canvas.getBoundingClientRect();
    this.cb.touchedView();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const p: Ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t0: performance.now(), type: e.pointerType };
    this.ptrs.set(e.pointerId, p);
    const toolActive = this.cb.tool.active;
    if (!this.acc) this.acc = newAcc();
    this.acc.fingers = Math.max(this.acc.fingers, e.pointerType === 'mouse' ? 1 : this.ptrs.size);

    if (e.pointerType === 'mouse') {
      if (this.mode !== 'idle') return;
      this.primary = e.pointerId;
      if (e.button === 2) {
        this.mode = 'orbit';
        this.cam.beginInteraction('orbit');
      } else if (e.button === 1) {
        e.preventDefault();
        this.startPan(p, false);
      } else if (e.button === 0) {
        if (toolActive) {
          this.mode = 'pending';
          this.startTool(p);
        } else this.mode = 'pending';
      }
      return;
    }

    // touch / pen
    if (this.ptrs.size === 1) {
      this.primary = e.pointerId;
      this.mode = 'pending';
      if (toolActive) this.toolTimer = window.setTimeout(() => this.startTool(p), TOOL_DELAY_MS);
    } else if (this.ptrs.size === 2) {
      window.clearTimeout(this.toolTimer);
      if (this.mode === 'tool') this.cb.tool.cancel();
      if (this.mode === 'pan') this.cam.endInteraction();
      this.startMulti();
    }
  }

  private onMove(e: PointerEvent): void {
    const p = this.ptrs.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse' && this.mode === 'idle' && this.cb.tool.active) {
        this.cb.tool.hover(this.ndcX(e.clientX), this.ndcY(e.clientY));
      }
      return;
    }
    const dxm = e.clientX - p.x,
      dym = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    switch (this.mode) {
      case 'pending': {
        const slop = p.type === 'mouse' ? MOUSE_SLOP : TOUCH_SLOP;
        if (Math.hypot(p.x - p.sx, p.y - p.sy) > slop) {
          if (this.cb.tool.active) this.startTool(p);
          else this.startPan(p, true);
        }
        break;
      }
      case 'rest':
        if (e.pointerId === this.primary && Math.hypot(p.x - p.sx, p.y - p.sy) > TOUCH_SLOP) this.startPan(p, true);
        break;
      case 'pan':
        if (e.pointerId === this.primary) this.panTo(p, dxm, dym);
        break;
      case 'tool':
        if (e.pointerId === this.primary) this.cb.tool.move(this.ndcX(p.x), this.ndcY(p.y));
        break;
      case 'orbit':
        this.tracked(this.acc, () => this.cam.rotateBy(-dxm * 0.0065, dym * 0.0045));
        break;
      case 'multi':
        this.onMultiMove();
        break;
      default:
        break;
    }
  }

  private onMultiMove(): void {
    const pair = this.twoPointers();
    if (!pair) return;
    const [a, b] = pair;
    const midX = (a.x + b.x) / 2,
      midY = (a.y + b.y) / 2;
    const span = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const angle = Math.atan2(b.y - a.y, b.x - a.x);

    if (this.multiKind === 'undecided') {
      const d1y = a.y - this.startP1.y,
        d2y = b.y - this.startP2.y;
      const d1x = a.x - this.startP1.x,
        d2x = b.x - this.startP2.x;
      this.multiMove = Math.max(Math.hypot(d1x, d1y), Math.hypot(d2x, d2y));
      if (this.multiMove > 14) {
        const sideBySide = Math.abs(Math.cos(angle)) > 0.75;
        const sameDir = d1y * d2y > 0;
        const vertical = Math.abs(d1y) > 2 * Math.abs(d1x) && Math.abs(d2y) > 2 * Math.abs(d2x);
        const spanStable = Math.abs(span / Math.hypot(this.startP2.x - this.startP1.x, this.startP2.y - this.startP1.y) - 1) < 0.12;
        this.multiKind = sideBySide && sameDir && vertical && spanStable ? 'tilt' : 'transform';
      }
      // keep the start values so the first classified frame applies the whole motion so far
      if (this.multiKind === 'undecided') return;
    }

    if (this.multiKind === 'tilt') {
      const dy = midY - this.prevMidY;
      this.tracked(this.acc, () => this.cam.rotateBy(0, (dy / Math.max(200, this.rect.height)) * 2.4));
    } else if (this.multiKind === 'transform') {
      let dAng = angle - this.prevAngle;
      if (dAng > Math.PI) dAng -= Math.PI * 2;
      if (dAng < -Math.PI) dAng += Math.PI * 2;
      const fx = this.ndcX(this.prevMidX),
        fy = this.ndcY(this.prevMidY),
        tx = this.ndcX(midX),
        ty = this.ndcY(midY);
      this.tracked(this.acc, () => this.cam.zoomRotateAround(this.prevSpan / span, dAng, fx, fy, tx, ty));
    }
    this.prevMidX = midX;
    this.prevMidY = midY;
    this.prevSpan = span;
    this.prevAngle = angle;
  }

  private onUp(e: PointerEvent, cancelled: boolean): void {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    this.ptrs.delete(e.pointerId);
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const ndcX = this.ndcX(p.x),
      ndcY = this.ndcY(p.y);

    switch (this.mode) {
      case 'pending': {
        window.clearTimeout(this.toolTimer);
        this.mode = 'idle';
        const quick = performance.now() - p.t0 < TAP_MS || p.type === 'mouse';
        if (cancelled || !quick) break;
        if (this.acc && this.acc.fingers <= 1) this.acc.tap = true;
        if (this.cb.tool.active) {
          this.cb.tool.down(ndcX, ndcY);
          this.cb.tool.up(ndcX, ndcY, true);
        } else this.cb.select(ndcX, ndcY);
        break;
      }
      case 'tool':
        if (e.pointerId !== this.primary) break;
        this.mode = 'idle';
        if (cancelled) this.cb.tool.cancel();
        else this.cb.tool.up(ndcX, ndcY, Math.hypot(p.x - p.sx, p.y - p.sy) < (p.type === 'mouse' ? MOUSE_SLOP : TOUCH_SLOP));
        break;
      case 'pan':
      case 'orbit':
        this.cam.endInteraction();
        this.mode = this.ptrs.size ? 'locked' : 'idle';
        break;
      case 'multi': {
        this.cam.endInteraction();
        const rest = this.ptrs.size === 1 ? this.ptrs.values().next().value : undefined;
        if (this.ptrs.size >= 2) this.startMulti();
        else if (rest && !this.cb.tool.active) {
          // pan with the finger that is still down once it moves (not before: lifting the
          // fingers of a pinch one by one must not end follow mode)
          this.primary = rest.id;
          rest.sx = rest.x;
          rest.sy = rest.y;
          this.mode = 'rest';
        } else this.mode = this.ptrs.size ? 'locked' : 'idle';
        break;
      }
      case 'locked':
        if (!this.ptrs.size) this.mode = 'idle';
        break;
      default:
        if (!this.ptrs.size) this.mode = 'idle';
    }
    this.endGesture();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.rect = this.canvas.getBoundingClientRect();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 33;
    else if (e.deltaMode === 2) dy *= 400;
    dy = Math.max(-300, Math.min(300, dy));
    const f = Math.exp(dy * 0.0013);
    const x = this.ndcX(e.clientX),
      y = this.ndcY(e.clientY);
    if (!this.wheelAcc) this.wheelAcc = { ...newAcc(), fingers: 1 };
    this.cam.beginInteraction('orbit');
    this.tracked(this.wheelAcc, () => this.cam.zoomRotateAround(f, 0, x, y, x, y));
    this.cam.endInteraction();
    // one summary per burst of wheel turns
    window.clearTimeout(this.wheelTimer);
    this.wheelTimer = window.setTimeout(() => {
      const a = this.wheelAcc;
      this.wheelAcc = null;
      if (a) this.emit(a);
    }, WHEEL_BURST_MS);
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!down) {
      this.cam.keyUp(e.code);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.cb.key(e.code)) {
      e.preventDefault();
      return;
    }
    if (this.cam.keyDown(e.code)) e.preventDefault();
  }
}
