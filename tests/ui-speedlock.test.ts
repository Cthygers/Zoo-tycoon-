// The one speed path (feature round 14): HUD buttons, keys (Space, 0–3) and UI extensions all
// go through SpeedControl. Under an extension's SpeedLock the HUD and key paths are refused
// (the lock hears about each try, the speed stays) while the extension itself may still set
// it; during a versus match every source is refused and the HUD never builds the speed group.
// A small fake DOM stands in for the elements the HUD builds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISimulation, SimSpeed, VersusView } from '../src/core/contracts';
import type { SpeedLock } from '../src/core/ui-ext';
import { Hud, SpeedControl, speedForKey, speedRefusal, type SpeedSource } from '../src/ui/hud';
import { MessageLog } from '../src/ui/notify';

class FakeEl {
  className = '';
  innerHTML = '';
  title = '';
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  private text = '';
  constructor(readonly tagName: string) {}
  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
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
  get childElementCount(): number {
    return this.children.length;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  insertAdjacentHTML(): void {}
  append(...cs: (FakeEl | string)[]): void {
    for (const c of cs) {
      if (typeof c === 'string') continue;
      c.remove();
      c.parent = this;
      this.children.push(c);
    }
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((x) => x !== this);
    this.parent = null;
  }
  click(): void {
    for (const fn of this.listeners.click ?? []) fn({ stopPropagation() {} });
  }
  /** Depth-first search by class. */
  find(cls: string): FakeEl | null {
    for (const c of this.children) {
      if (c.classList.contains(cls)) return c;
      const d = c.find(cls);
      if (d) return d;
    }
    return null;
  }
}

function fakeSim(versus: boolean) {
  const sim = {
    speed: 0 as SimSpeed,
    setSpeed: vi.fn((s: SimSpeed) => {
      sim.speed = s;
    }),
    versus: versus ? ({ hour: 0 } as unknown as VersusView) : null,
    money: 10000,
    day: 1,
    minuteOfDay: 510,
    rating: 40,
    isOpen: () => true,
    stats: () => ({ guestsInZoo: 0, guestCapacity: 100, full: false }),
  };
  return sim;
}

function setup(opts: { versus?: boolean } = {}) {
  const sim = fakeSim(!!opts.versus);
  let hud: Hud | null = null;
  const ctl = new SpeedControl(sim as unknown as ISimulation, () => hud?.refresh());
  hud = new Hud({ sim: sim as unknown as ISimulation, log: new MessageLog(), openMenu: vi.fn(), setSpeed: (s) => ctl.set(s, 'hud') });
  const priv = hud as unknown as { speedBtns: FakeEl[]; seg: FakeEl; lockBadge: FakeEl };
  const lock: SpeedLock = { owner: 'tutorial', onBlocked: vi.fn() };
  /** What the shell's key handler does: map the key, then ask the speed path. */
  const key = (code: string) => {
    const s = speedForKey(code, sim.speed);
    return s === null ? null : ctl.set(s, 'key');
  };
  return { sim, ctl, hud, lock, key, btn: (i: number) => priv.speedBtns[i], seg: priv.seg, lockBadge: priv.lockBadge, root: hud.root as unknown as FakeEl };
}

describe('speed lock and versus speed', () => {
  beforeEach(() => vi.stubGlobal('document', { createElement: (t: string) => new FakeEl(t) }));
  afterEach(() => vi.unstubAllGlobals());

  it('refuses the HUD and key paths under a SpeedLock (onBlocked called, speed unchanged) and lets the extension set it', () => {
    const t = setup();
    t.ctl.setLock(t.lock);
    t.hud.setSpeedLock(t.lock);
    // the HUD shows the lock, and its buttons stay tappable
    expect(t.seg.classList.contains('locked')).toBe(true);
    expect(t.lockBadge.classList.contains('hidden')).toBe(false);
    for (let i = 0; i < 4; i++) expect(t.btn(i).attrs['aria-disabled']).toBe('true');
    // the Play button
    t.btn(1).click();
    expect(t.sim.speed).toBe(0);
    expect(t.sim.setSpeed).not.toHaveBeenCalled();
    expect(t.lock.onBlocked).toHaveBeenCalledTimes(1);
    // the keys
    expect(t.key('Space')).toBe(false);
    expect(t.key('Digit3')).toBe(false);
    expect(t.key('KeyW')).toBeNull(); // not a speed key: not asked
    expect(t.sim.speed).toBe(0);
    expect(t.lock.onBlocked).toHaveBeenCalledTimes(3);
    // the extension holding the lock may still run the clock
    expect(t.ctl.set(1, 'ext')).toBe(true);
    expect(t.sim.speed).toBe(1);
    expect(t.btn(1).classList.contains('on')).toBe(true);
    expect(t.lock.onBlocked).toHaveBeenCalledTimes(3);
    // released: everything works again
    t.ctl.setLock(null);
    t.hud.setSpeedLock(null);
    expect(t.seg.classList.contains('locked')).toBe(false);
    expect(t.lockBadge.classList.contains('hidden')).toBe(true);
    expect(t.btn(0).attrs['aria-disabled']).toBeUndefined();
    t.btn(3).click();
    expect(t.sim.speed).toBe(3);
    expect(t.key('Space')).toBe(true);
    expect(t.sim.speed).toBe(0);
  });

  it('refuses every source during a versus match, and the HUD never builds the speed group', () => {
    const t = setup({ versus: true });
    t.ctl.setLock(t.lock);
    for (const source of ['hud', 'key', 'ext'] as SpeedSource[]) {
      for (const s of [0, 1, 2, 3] as SimSpeed[]) expect(t.ctl.set(s, source)).toBe(false);
    }
    expect(t.key('Space')).toBe(false);
    expect(t.key('Digit2')).toBe(false);
    expect(t.sim.setSpeed).not.toHaveBeenCalled();
    expect(t.sim.speed).toBe(0);
    // the match refuses before any lock is asked
    expect(t.lock.onBlocked).not.toHaveBeenCalled();
    expect(t.root.find('wh-top-speed')).toBeNull();
    expect(t.root.find('wh-seg')).toBeNull();
    expect(t.hud.speedGroupEl).toBeNull();
    expect(t.hud.speedButton(1)).toBeNull();
    // the slot for the versus chip is there
    expect(t.root.find('wh-slot-speed')).toBe(t.hud.speedSlot as unknown as FakeEl);
  });

  it('maps keys to speeds', () => {
    expect(speedForKey('Space', 0)).toBe(1);
    expect(speedForKey('Space', 2)).toBe(0);
    expect(speedForKey('Digit0', 3)).toBe(0);
    expect(speedForKey('Digit1', 0)).toBe(1);
    expect(speedForKey('Digit2', 0)).toBe(2);
    expect(speedForKey('Digit3', 0)).toBe(3);
    expect(speedForKey('Numpad3', 0)).toBe(3);
    expect(speedForKey('Digit4', 0)).toBeNull();
    expect(speedForKey('KeyR', 0)).toBeNull();
  });

  it('decides refusals in order: versus, then a lock unless the extension asks', () => {
    const lock: SpeedLock = { owner: 'x', onBlocked() {} };
    expect(speedRefusal(false, null, 'hud')).toBeNull();
    expect(speedRefusal(false, lock, 'hud')).toBe('locked');
    expect(speedRefusal(false, lock, 'key')).toBe('locked');
    expect(speedRefusal(false, lock, 'ext')).toBeNull();
    expect(speedRefusal(true, null, 'ext')).toBe('versus');
    expect(speedRefusal(true, lock, 'hud')).toBe('versus');
  });

  it('keeps going when a lock owner throws', () => {
    const t = setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.ctl.setLock({
      owner: 'broken',
      onBlocked() {
        throw new Error('boom');
      },
    });
    expect(t.ctl.set(2, 'hud')).toBe(false);
    expect(t.sim.speed).toBe(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
