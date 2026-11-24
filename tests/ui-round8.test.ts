// Focused test for the round-8 UI leftover: money popups also fade out before they rise into
// the next-goal pill under the top bar. A tiny fake DOM stands in for the few element
// properties the popups touch.
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoneyPopups } from '../src/ui/notify';

class FakeEl {
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  append(): void {}
  remove(): void {}
}

describe('money popups and the goal pill', () => {
  beforeEach(() => vi.stubGlobal('document', { createElement: () => new FakeEl() }));
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const camera = new THREE.PerspectiveCamera(50, 800 / 360, 0.5, 500);
    camera.position.set(0, 20, 30);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const pops = new MoneyPopups(camera, () => 0);
    pops.spawn(0, 10, 1250);
    const p = (pops as unknown as { pool: { el: FakeEl; active: boolean }[] }).pool.find((q) => q.active)!;
    pops.update(0.5, 800, 360, 52);
    const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(p.el.style.transform)!;
    return { pops, el: p.el, sx: Number(m[1]), sy: Number(m[2]) };
  }

  it('hides a popup whose text reaches the pill, fades it just under it, and leaves others alone', () => {
    const { pops, el, sx, sy } = setup();
    expect(Number(el.style.opacity)).toBeGreaterThan(0.9);
    // a pill whose bottom edge is right at the text: hidden
    pops.update(0, 800, 360, 52, [{ left: sx - 80, top: sy - 50, right: sx + 80, bottom: sy - 6 }]);
    expect(Number(el.style.opacity)).toBe(0);
    // 20 px of gap below the pill: on its way out
    pops.update(0, 800, 360, 52, [{ left: sx - 80, top: sy - 70, right: sx + 80, bottom: sy - 30 }]);
    expect(Number(el.style.opacity)).toBeGreaterThan(0.1);
    expect(Number(el.style.opacity)).toBeLessThan(0.7);
    // the same pill off to the side: the popup shows normally
    pops.update(0, 800, 360, 52, [{ left: sx + 120, top: sy - 50, right: sx + 280, bottom: sy - 6 }]);
    expect(Number(el.style.opacity)).toBeGreaterThan(0.9);
    // its text (about 60 px wide) touching the pill's side: hidden
    pops.update(0, 800, 360, 52, [{ left: sx + 30, top: sy - 20, right: sx + 190, bottom: sy + 20 }]);
    expect(Number(el.style.opacity)).toBe(0);
  });
});
