// Gesture summaries for UI extensions (the tutorial's "look around" steps): one summary at the
// end of each touch or mouse gesture and per burst of wheel turns, with the pan travel, zoom,
// turn and tilt it caused, how many fingers and whether it was a tap; plus the camera's demo
// moves for "Help me".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { World } from '../src/core/world';
import type { GestureSummary } from '../src/core/ui-ext';
import { CameraController } from '../src/ui/camera';
import { InputController } from '../src/ui/input';

const world = { heightAt: () => 0 } as unknown as World;

class FakeCanvas extends EventTarget {
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 915, height: 412, right: 915, bottom: 412, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
}

function pointer(type: string, id: number, x: number, y: number, pointerType = 'touch', button = 0): Event {
  return Object.assign(new Event(type), { pointerId: id, pointerType, clientX: x, clientY: y, button, preventDefault() {} });
}

function wheel(deltaY: number): Event {
  return Object.assign(new Event('wheel'), { deltaY, deltaMode: 0, clientX: 450, clientY: 200, preventDefault() {} });
}

describe('gesture summaries', () => {
  const g = globalThis as unknown as { window?: unknown };
  let saved: unknown;
  beforeEach(() => {
    saved = g.window;
    // looked up at call time, so vi.useFakeTimers() in a test applies
    g.window = Object.assign(new EventTarget(), {
      setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    });
  });
  afterEach(() => {
    g.window = saved;
    vi.useRealTimers();
  });

  function setup(toolActive = false) {
    const cam = new THREE.PerspectiveCamera(34, 915 / 412, 0.3, 2000);
    const c = new CameraController(cam, world, () => undefined);
    c.setView(70, 70, 40, 0.4, 0.8);
    c.update(1 / 30);
    const canvas = new FakeCanvas();
    const got: GestureSummary[] = [];
    const tool = { active: toolActive, down() {}, move() {}, up() {}, cancel() {}, hover() {}, leave() {} };
    const input = new InputController(canvas as unknown as HTMLElement, c, { tool, select() {}, touchedView() {}, key: () => false, gesture: (s) => got.push(s) });
    const fire = (e: Event) => canvas.dispatchEvent(e);
    return { c, input, got, fire };
  }

  it('sums one-finger pan travel and reports once, when the finger lifts', () => {
    const { got, fire, input } = setup();
    fire(pointer('pointerdown', 1, 300, 200));
    expect(input.pointers).toBe(1);
    for (let i = 1; i <= 10; i++) fire(pointer('pointermove', 1, 300 + i * 15, 200));
    expect(got).toHaveLength(0);
    fire(pointer('pointerup', 1, 450, 200));
    expect(input.pointers).toBe(0);
    expect(got).toHaveLength(1);
    expect(got[0].pan).toBeCloseTo(150, 0);
    expect(got[0]).toMatchObject({ fingers: 1, tap: false, zoom: 0, turn: 0 });
    input.dispose();
  });

  it('reports a quick touch as a tap', () => {
    const { got, fire, input } = setup();
    fire(pointer('pointerdown', 1, 300, 200));
    fire(pointer('pointerup', 1, 302, 201));
    expect(got).toEqual([{ pan: 0, zoom: 0, turn: 0, tilt: 0, fingers: 1, tap: true }]);
    input.dispose();
  });

  it('reports a pinch-and-twist with two fingers: zoom as |Δ ln distance| and turn in degrees', () => {
    const { c, got, fire, input } = setup();
    const d0 = c.distance;
    const y0 = c.yaw;
    fire(pointer('pointerdown', 1, 400, 200));
    fire(pointer('pointerdown', 2, 500, 200));
    expect(input.pointers).toBe(2);
    // spread apart while turning (the right finger goes down, the left one up)
    for (let i = 1; i <= 10; i++) {
      fire(pointer('pointermove', 1, 400 - i * 8, 200 - i * 4));
      fire(pointer('pointermove', 2, 500 + i * 8, 200 + i * 4));
    }
    fire(pointer('pointerup', 1, 320, 160));
    expect(got).toHaveLength(0); // one finger still down
    fire(pointer('pointerup', 2, 580, 240));
    expect(got).toHaveLength(1);
    const s = got[0];
    expect(s.fingers).toBe(2);
    expect(s.tap).toBe(false);
    expect(s.zoom).toBeCloseTo(Math.abs(Math.log(c.distance / d0)), 3);
    expect(s.zoom).toBeGreaterThan(0.35);
    expect(s.turn).toBeGreaterThan(10);
    expect(s.turn).toBeCloseTo(Math.abs(c.yaw - y0) * (180 / Math.PI), 1);
    input.dispose();
  });

  it('turns with a right-drag of the mouse', () => {
    const { got, fire, input } = setup();
    fire(pointer('pointerdown', 9, 300, 200, 'mouse', 2));
    for (let i = 1; i <= 5; i++) fire(pointer('pointermove', 9, 300 + i * 20, 200, 'mouse', 2));
    fire(pointer('pointerup', 9, 400, 200, 'mouse', 2));
    expect(got).toHaveLength(1);
    expect(got[0].fingers).toBe(1);
    expect(got[0].turn).toBeCloseTo(100 * 0.0065 * (180 / Math.PI), 1);
    input.dispose();
  });

  it('reports one summary per burst of wheel turns, 200 ms after the last', () => {
    vi.useFakeTimers();
    const { got, fire, input } = setup();
    for (let i = 0; i < 5; i++) {
      fire(wheel(-100));
      vi.advanceTimersByTime(50);
    }
    expect(got).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(got).toHaveLength(1);
    expect(got[0].zoom).toBeCloseTo(5 * 0.13, 2);
    expect(got[0]).toMatchObject({ fingers: 1, tap: false, pan: 0 });
    fire(wheel(100));
    vi.advanceTimersByTime(250);
    expect(got).toHaveLength(2);
    input.dispose();
  });

  it('says nothing for a build-tool drag', () => {
    vi.useFakeTimers();
    const { got, fire, input } = setup(true);
    fire(pointer('pointerdown', 1, 300, 200));
    vi.advanceTimersByTime(100); // the tool takes the finger
    for (let i = 1; i <= 5; i++) fire(pointer('pointermove', 1, 300 + i * 20, 200));
    fire(pointer('pointerup', 1, 400, 200));
    expect(got).toHaveLength(0);
    input.dispose();
  });
});

describe('camera demo moves (Help me)', () => {
  function cam() {
    const c = new CameraController(new THREE.PerspectiveCamera(34, 915 / 412, 0.3, 2000), world, () => undefined);
    c.setView(70, 70, 40, 0.4, 0.8);
    return c;
  }
  const run = (c: CameraController, seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 30) c.update(1 / 30);
  };

  it('turns 40°, zooms in (out when already close) and pans sideways over about 1.5 s, then resolves', async () => {
    const c = cam();
    const y0 = c.yaw;
    let done = false;
    const p = c.demo('turn').then(() => (done = true));
    run(c, 0.7);
    expect(c.demoing).toBe(true);
    run(c, 0.9);
    await p;
    expect(done).toBe(true);
    expect(c.demoing).toBe(false);
    expect((c.yaw - y0) * (180 / Math.PI)).toBeCloseTo(40, 3);

    const d0 = c.distance;
    const z = c.demo('zoom');
    run(c, 1.6);
    await z;
    expect(c.distance / d0).toBeCloseTo(0.55, 3);
    c.setView(70, 70, 12);
    const zOut = c.demo('zoom');
    run(c, 1.6);
    await zOut;
    expect(c.distance).toBeCloseTo(12 * 1.7, 3);

    const x0 = c.target.x;
    const z0 = c.target.z;
    const pan = c.demo('pan');
    run(c, 1.6);
    await pan;
    expect(Math.hypot(c.target.x - x0, c.target.z - z0)).toBeCloseTo(c.distance * 0.45, 3);
  });

  it('stops when the player touches the view', async () => {
    const c = cam();
    const y0 = c.yaw;
    const p = c.demo('turn');
    run(c, 0.3);
    c.beginInteraction('orbit');
    c.endInteraction();
    await p;
    const y1 = c.yaw;
    run(c, 1);
    expect(c.yaw).toBeCloseTo(y1, 6);
    expect(Math.abs(y1 - y0)).toBeLessThan((40 * Math.PI) / 180);
  });
});
