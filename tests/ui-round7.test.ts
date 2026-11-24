// Focused tests for the round-7 UI leftovers: a goal with nothing measured yet, and money
// popups that fade out before they rise into the top bar. A tiny fake DOM stands in for the
// few element properties the popups touch.
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goalFraction, goalProgressText } from '../src/ui/coach';
import { MoneyPopups } from '../src/ui/notify';

class FakeEl {
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  append(): void {}
  remove(): void {}
}

describe('goal progress before anything is measured', () => {
  it('shows the sim’s note and no share of the bar', () => {
    const waiting = { current: 0, target: 75, waiting: 'No full day yet' };
    expect(goalProgressText({ text: 'Reach 75% guest happiness for a day' }, waiting)).toBe('No full day yet');
    expect(goalFraction(waiting)).toBe(0);
  });
});

describe('money popups', () => {
  beforeEach(() => vi.stubGlobal('document', { createElement: () => new FakeEl() }));
  afterEach(() => vi.unstubAllGlobals());

  /** A popup at the gate seen from a camera looking north; returns its element. */
  function popupAt(pops: MoneyPopups, z: number): FakeEl {
    pops.spawn(0, z, 26);
    return (pops as unknown as { pool: { el: FakeEl; active: boolean }[] }).pool.find((p) => p.active)!.el;
  }

  it('fade out before they reach the top bar, and show normally below it', () => {
    const camera = new THREE.PerspectiveCamera(50, 800 / 360, 0.5, 500);
    camera.position.set(0, 20, 30);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const pops = new MoneyPopups(camera, () => 0);
    const near = popupAt(pops, 10); // low on the screen
    pops.update(0.5, 800, 360, 52);
    expect(Number(near.style.opacity)).toBeGreaterThan(0.9);
    // the same popup with a top bar reaching down past it: hidden
    pops.update(0.01, 800, 360, 300);
    expect(Number(near.style.opacity)).toBe(0);
  });
});
