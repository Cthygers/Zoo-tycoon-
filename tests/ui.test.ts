// UI logic that runs without a browser: the toast queue / message log and the
// camera's off-centre focus. A minimal fake DOM stands in for the few element
// methods the toast stack touches.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { World } from '../src/core/world';
import { CameraController } from '../src/ui/camera';
import { MessageLog, Toasts } from '../src/ui/notify';

class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  className = '';
  textContent = '';
  innerHTML = '';
  title = '';
  /** Every fake toast is one line tall. */
  offsetHeight = 44;
  style: Record<string, string> = {};
  classList = {
    add: (c: string) => {
      if (!this.classList.contains(c)) this.className = `${this.className} ${c}`.trim();
    },
    remove: (c: string) => {
      this.className = this.className
        .split(/\s+/)
        .filter((x) => x !== c)
        .join(' ');
    },
    contains: (c: string) => this.className.split(/\s+/).includes(c),
    toggle: (c: string, on?: boolean) => ((on ?? !this.classList.contains(c)) ? this.classList.add(c) : this.classList.remove(c)),
  };
  setAttribute(): void {}
  addEventListener(): void {}
  append(...cs: (FakeEl | string)[]): void {
    for (const c of cs) {
      if (typeof c === 'string') continue;
      c.parent = this;
      this.children.push(c);
    }
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((x) => x !== this);
    this.parent = null;
  }
}

/** Texts of the toasts on screen (not the ones fading out). */
function visible(t: Toasts): string[] {
  const root = t.root as unknown as FakeEl;
  return root.children.filter((c) => !c.classList.contains('out')).map((c) => /<span>(.*?)<\/span>/.exec(c.innerHTML)?.[1] ?? '');
}

describe('Toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.stubGlobal('document', { createElement: () => new FakeEl() });
    vi.stubGlobal('window', { innerHeight: 400, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (id: number) => clearTimeout(id) });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const make = () => new Toasts(() => undefined, () => ({ day: 2, minute: 600 }));

  it('queues toasts a short screen has no room for instead of dropping them', () => {
    const t = make();
    t.show('A guest complained', 'warn');
    t.show('Tilly is hungry', 'bad');
    t.show('A baby giraffe was born!', 'good');
    expect(visible(t)).toEqual(['A guest complained', 'Tilly is hungry']);
    // the waiting toast speeds the others up, but they stay readable for a moment
    vi.advanceTimersByTime(2000);
    expect(visible(t)).toEqual(['A guest complained', 'Tilly is hungry']);
    vi.advanceTimersByTime(600);
    expect(visible(t)).toEqual(['A baby giraffe was born!']);
    expect(t.log.entries.map((e) => e.text)).toEqual(['A baby giraffe was born!', 'Tilly is hungry', 'A guest complained']);
  });

  it('lets a warning take the place of a routine toast, which comes back later', () => {
    const t = make();
    t.show('Gift shop opened', 'good');
    t.show('New habitat created', 'good');
    t.show('A lion escaped!', 'bad');
    expect(visible(t)).toEqual(['New habitat created', 'A lion escaped!']);
    vi.advanceTimersByTime(2500);
    expect(visible(t)).toContain('Gift shop opened');
  });

  it('only shows what fits above the dock, and brings back what an open drawer pushed off', () => {
    const t = make();
    t.setRoom(60); // room for one toast (44 px + 8 px gap)
    t.show('A guest complained', 'warn');
    t.show('Tilly is hungry', 'warn');
    expect(visible(t)).toEqual(['A guest complained']);
    // a build drawer opens over the column: nothing fits, the barely seen toast waits too
    t.setRoom(10);
    expect(visible(t)).toEqual([]);
    t.show('A baby giraffe was born!', 'good');
    expect(visible(t)).toEqual([]);
    // the drawer closes: the waiting toasts come back, as many as fit
    t.setRoom(200);
    expect(visible(t)).toEqual(['A guest complained', 'Tilly is hungry']);
    expect(t.log.entries).toHaveLength(3);
  });

  it('merges repeats of the same message', () => {
    const t = make();
    t.show('Tilly is hungry', 'bad');
    t.show('Tilly is hungry', 'bad');
    expect(visible(t)).toEqual(['Tilly is hungry']);
    expect(t.log.entries).toHaveLength(1);
    expect(t.log.entries[0].count).toBe(2);
  });

  it('logs a message another widget already shows without popping a toast', () => {
    const t = make();
    t.logOnly('Goal complete: Adopt your first animal (+$2,500)', 'good');
    expect(visible(t)).toEqual([]);
    expect(t.log.entries.map((e) => e.text)).toEqual(['Goal complete: Adopt your first animal (+$2,500)']);
  });
});

describe('MessageLog', () => {
  it('keeps the newest 40 messages, newest first, with the time they happened', () => {
    const log = new MessageLog();
    for (let i = 0; i < 45; i++) log.add(`m${i}`, 'info', undefined, 3, 100 + i);
    expect(log.entries).toHaveLength(40);
    expect(log.entries[0]).toMatchObject({ text: 'm44', day: 3, minute: 144, count: 1 });
    const v = log.version;
    log.add('m44', 'info', { x: 1, z: 2 }, 3, 200);
    expect(log.entries).toHaveLength(40);
    expect(log.entries[0]).toMatchObject({ count: 2, minute: 200 });
    expect(log.version).toBeGreaterThan(v);
  });
});

describe('MessageLog unread warnings', () => {
  it('counts warnings and problems since the log was last read', () => {
    const log = new MessageLog();
    log.add('Zoo saved', 'good', undefined, 1, 600);
    log.add('A guest says hi', 'info', undefined, 1, 601);
    expect(log.unread).toBe(0);
    log.add('Guests want benches', 'warn', undefined, 1, 602);
    expect(log).toMatchObject({ unread: 1, unreadBad: false });
    log.add('Tilly is hungry', 'bad', undefined, 1, 603);
    log.add('Tilly is hungry', 'bad', undefined, 1, 604); // a repeat is news too
    expect(log).toMatchObject({ unread: 3, unreadBad: true });
    log.markRead();
    expect(log).toMatchObject({ unread: 0, unreadBad: false });
  });
});

describe('CameraController.focusAt', () => {
  const ground = 3;
  const world = { heightAt: () => ground } as unknown as World;

  it('puts the ground point at the requested screen position, also when zooming', () => {
    const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 2000);
    const c = new CameraController(cam, world, () => undefined);
    c.setView(70, 70, 40, 0.4, 0.8);
    for (const [ndcX, ndcY, d] of [
      [-0.38, 0.1, undefined],
      [0.25, -0.3, 26],
    ] as const) {
      c.focusAt(60, 85, ndcX, ndcY, d);
      for (let i = 0; i < 40; i++) c.update(0.05);
      const p = new THREE.Vector3(60, ground, 85).project(cam);
      expect(p.x).toBeCloseTo(ndcX, 2);
      expect(p.y).toBeCloseTo(ndcY, 2);
    }
    expect(c.distance).toBeCloseTo(26, 5);
  });
});
