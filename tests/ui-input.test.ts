// Touch gestures and follow mode: pinching in on a followed animal or person keeps following it
// (also when the two fingers lift one after the other); dragging the finger that is left pans
// and ends following, lifting it is not a tap.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { World } from '../src/core/world';
import { CameraController, DEFAULT_LIMITS } from '../src/ui/camera';
import { InputController } from '../src/ui/input';

const world = { heightAt: () => 0 } as unknown as World;

class FakeCanvas extends EventTarget {
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 915, height: 412, right: 915, bottom: 412, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
}

function pointer(type: string, id: number, x: number, y: number): Event {
  return Object.assign(new Event(type), { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0, preventDefault() {} });
}

describe('InputController pinch while following', () => {
  const g = globalThis as unknown as { window?: unknown };
  let saved: unknown;
  beforeEach(() => {
    saved = g.window;
    g.window = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
  });
  afterEach(() => {
    g.window = saved;
  });

  function setup() {
    const cam = new THREE.PerspectiveCamera(34, 915 / 412, 0.3, 2000);
    const c = new CameraController(cam, world, () => undefined);
    c.setView(70, 70, 12, 0.4, 0.6);
    c.follow(() => ({ x: 70, z: 70 }));
    c.update(1 / 30);
    const canvas = new FakeCanvas();
    const select = vi.fn();
    const tool = { active: false, down() {}, move() {}, up() {}, cancel() {}, hover() {}, leave() {} };
    const input = new InputController(canvas as unknown as HTMLElement, c, { tool, select, touchedView() {}, key: () => false });
    // two fingers spread apart around the middle of the view
    canvas.dispatchEvent(pointer('pointerdown', 1, 430, 200));
    canvas.dispatchEvent(pointer('pointerdown', 2, 490, 200));
    for (let i = 1; i <= 10; i++) {
      canvas.dispatchEvent(pointer('pointermove', 1, 430 - i * 15, 200));
      canvas.dispatchEvent(pointer('pointermove', 2, 490 + i * 15, 200));
    }
    // the fingers lift one after the other
    canvas.dispatchEvent(pointer('pointerup', 1, 280, 200));
    return { c, canvas, select, input };
  }

  it('keeps following when the pinch fingers lift one by one, zoomed in past the free limit', () => {
    const { c, canvas, select, input } = setup();
    canvas.dispatchEvent(pointer('pointerup', 2, 640, 200));
    expect(c.following).toBe(true);
    expect(c.distance).toBeLessThan(DEFAULT_LIMITS.minDistance);
    expect(select).not.toHaveBeenCalled();
    input.dispose();
  });

  it('pans with the finger left down once it moves, which ends following', () => {
    const { c, canvas, select, input } = setup();
    canvas.dispatchEvent(pointer('pointermove', 2, 644, 202));
    expect(c.following).toBe(true); // within the slop
    canvas.dispatchEvent(pointer('pointermove', 2, 600, 240));
    expect(c.following).toBe(false);
    canvas.dispatchEvent(pointer('pointerup', 2, 600, 240));
    expect(select).not.toHaveBeenCalled();
    input.dispose();
  });
});
