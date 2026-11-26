// The game UI as the host of UI extensions (feature round 14): settings sections from
// extensions in order above 'Save game', the hidden 'New zoo' row, the zoo menu's shown /
// closed hooks, the HUD's speed and badge slots, the versus money-popup throttle, the clear
// area around reserved rects, dialogs whose primary button is Cancel, the pending action as
// extensions see it, and the player avatars. A small fake DOM stands in for the elements.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvatarAnimal } from '../shared/api-types';
import { AVATAR_ANIMALS } from '../shared/limits';
import type { IAudio, IRenderContext, ISimulation, SimSpeed } from '../src/core/contracts';
import { AVATAR_COLOR_HEX, avatarSvg } from '../src/ui/avatars';
import { avoidRect } from '../src/ui/dom';
import { Hud } from '../src/ui/hud';
import { ICONS } from '../src/ui/icons';
import { MessageLog, popupCell, throttlePopup, type PopupCellState } from '../src/ui/notify';
import { dialogButtonClasses } from '../src/ui/panels';
import { pendingInfoOf } from '../src/ui/tools';
import { ZooPanel, newZooText, orderSections, type ZooPanelHost } from '../src/ui/zoopanel';

class FakeEl {
  className = '';
  innerHTML = '';
  title = '';
  hidden = false;
  inert = false;
  value = '';
  scrollTop = 0;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  /** Set by the tests on the elements their sections render. */
  mark = '';
  private text = '';
  constructor(readonly tagName: string) {}
  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    for (const c of this.children) c.parent = null;
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
  get firstElementChild(): FakeEl | null {
    return this.children[0] ?? null;
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
  focus(): void {}
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
  contains(o: FakeEl): boolean {
    for (let p: FakeEl | null = o; p; p = p.parent) if (p === this) return true;
    return false;
  }
  find(cls: string): FakeEl | null {
    for (const c of this.children) {
      if (c.classList.contains(cls)) return c;
      const d = c.find(cls);
      if (d) return d;
    }
    return null;
  }
}

function zooPanel(host: Partial<ZooPanelHost> = {}) {
  const audio = { enabled: true, volume: () => 1, setEnabled() {}, resume() {} } as unknown as IAudio;
  const full: ZooPanelHost = {
    sim: {} as ISimulation,
    ctx: { quality: { level: 'low' } } as unknown as IRenderContext,
    audio,
    uiRoot: new FakeEl('div') as unknown as HTMLElement,
    save: () => 'saved',
    newGame: vi.fn(),
    toast: vi.fn(),
    qualityChanged: vi.fn(),
    qualityApplying: () => false,
    log: new MessageLog(),
    focus: vi.fn(),
    ...host,
  };
  const zoo = new ZooPanel(full);
  const body = (zoo as unknown as { body: FakeEl }).body;
  /** The settings body as labels: an extension section's mark, or a built-in row's title. */
  const rows = () =>
    body.children.map((c) => c.mark || /<b>(.*?)<\/b>/.exec(c.firstElementChild?.innerHTML ?? '')?.[1] || (c.find('wh-mix') ? 'Sound mix (list)' : c.className));
  return { zoo, rows, host: full };
}

function section(id: string, order: number, render = vi.fn()) {
  return {
    id,
    order,
    render: render.mockImplementation(() => {
      const e = new FakeEl('div');
      e.mark = id;
      return e as unknown as HTMLElement;
    }),
  };
}

describe('UI extension host', () => {
  beforeEach(() => vi.stubGlobal('document', { createElement: (t: string) => new FakeEl(t), activeElement: null }));
  afterEach(() => vi.unstubAllGlobals());

  it('renders settings sections in order above Save game, and re-renders an open Settings tab', () => {
    const { zoo, rows } = zooPanel();
    const offB = zoo.addSettingsSection(section('b', 20));
    zoo.addSettingsSection(section('a1', 10));
    zoo.addSettingsSection(section('a2', 10)); // same order: in the order added
    zoo.open('settings');
    const r = rows();
    const save = r.indexOf('Save game');
    expect(save).toBeGreaterThan(0);
    expect(r.slice(save - 3, save)).toEqual(['a1', 'a2', 'b']);
    expect(r.indexOf('Sound')).toBeLessThan(r.indexOf('a1'));
    expect(r).toContain('New game');
    // added or removed while the tab is open: shown at once
    zoo.addSettingsSection(section('c', 5));
    expect(rows().slice(rows().indexOf('Save game') - 4, rows().indexOf('Save game'))).toEqual(['c', 'a1', 'a2', 'b']);
    offB();
    expect(rows()).not.toContain('b');
    // a section that throws is left out, the rest still show
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    zoo.addSettingsSection({
      id: 'broken',
      order: 1,
      render: () => {
        throw new Error('boom');
      },
    });
    expect(rows()).toContain('Save game');
    expect(rows()).toContain('c');
    err.mockRestore();
    expect(orderSections([{ order: 3 }, { order: -1 }, { order: 3 }]).map((s) => s.order)).toEqual([-1, 3, 3]);
  });

  it("hides the 'New zoo' row on request, and says 'on all your devices' for a profile", () => {
    const { zoo, rows } = zooPanel();
    zoo.open('settings');
    expect(rows()).toContain('New game');
    zoo.hideSettingsRow('newZoo', true);
    expect(rows()).not.toContain('New game');
    expect(rows()).toContain('Save game');
    zoo.hideSettingsRow('newZoo', false);
    expect(rows()).toContain('New game');
    expect(newZooText('p_123')).toContain('on all your devices');
    expect(newZooText(null)).not.toContain('devices');
    expect(newZooText(undefined)).toBe('Your current zoo, animals and money will be replaced by a fresh start. This cannot be undone.');
  });

  it('tells the host when the zoo menu shows a tab and when it closes, and exposes its controls', () => {
    const onShown = vi.fn();
    const onClosed = vi.fn();
    const { zoo } = zooPanel({ onShown, onClosed });
    expect(zoo.currentTab).toBeNull();
    zoo.open('messages');
    zoo.showTab('settings');
    zoo.addSettingsSection(section('x', 1)); // drawn again in place: not a new 'shown'
    expect(onShown.mock.calls.map((c) => c[0])).toEqual(['messages', 'settings']);
    expect(zoo.currentTab).toBe('settings');
    expect(zoo.tabButton('finance')).not.toBeNull();
    expect(zoo.closeEl).toBeTruthy();
    zoo.close();
    zoo.close(); // already closed: once
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(zoo.currentTab).toBeNull();
  });

  it("replaces the speed group with the speed slot while it has a child; the badge slot sits left of the menu button", () => {
    const sim = {
      speed: 1 as SimSpeed,
      setSpeed: vi.fn(),
      versus: null,
      money: 500,
      day: 1,
      minuteOfDay: 600,
      rating: 50,
      isOpen: () => true,
      stats: () => ({ guestsInZoo: 0, guestCapacity: 10, full: false }),
    };
    const hud = new Hud({ sim: sim as unknown as ISimulation, log: new MessageLog(), openMenu: vi.fn(), setSpeed: vi.fn() });
    const root = hud.root as unknown as FakeEl;
    const group = root.find('wh-top-speed')!;
    const slot = hud.speedSlot as unknown as FakeEl;
    hud.update(0);
    expect(group.classList.contains('hidden')).toBe(false);
    expect(slot.classList.contains('hidden')).toBe(true);
    expect(hud.speedGroupEl).not.toBeNull();
    const chip = new FakeEl('div');
    slot.append(chip);
    hud.update(0);
    expect(group.classList.contains('hidden')).toBe(true);
    expect(slot.classList.contains('hidden')).toBe(false);
    expect(hud.speedGroupEl).toBeNull();
    expect(hud.speedButton(1)).toBeNull();
    chip.remove();
    hud.update(0);
    expect(group.classList.contains('hidden')).toBe(false);
    expect(hud.speedButton(1)).not.toBeNull();
    // badge slot: in the menu group, before the menu button
    const menuGroup = root.find('wh-top-menu')!;
    expect(menuGroup.children[0]).toBe(hud.badgeSlot as unknown as FakeEl);
    expect(menuGroup.children[1]).toBe(hud.menuEl as unknown as FakeEl);
  });
});

describe('versus money popups', () => {
  it('lets at most one popup per 0.5 s per cell through and sums the dropped amounts into the next', () => {
    const st = new Map<number, PopupCellState>();
    expect(throttlePopup(st, 4, 10, 30)).toBe(30);
    expect(throttlePopup(st, 4, 10.1, 20)).toBeNull();
    expect(throttlePopup(st, 4, 10.3, 15)).toBeNull();
    // another cell is independent
    expect(throttlePopup(st, 0, 10.3, 7)).toBe(7);
    // 0.5 s after the last shown one: the dropped 35 come along
    expect(throttlePopup(st, 4, 10.5, 5)).toBe(40);
    expect(throttlePopup(st, 4, 10.6, -25)).toBeNull();
    expect(throttlePopup(st, 4, 11.2, 10)).toBe(-15);
    // a burst of 40 small amounts in one cell over 2 s: at most one per 0.5 s, nothing lost
    const s2 = new Map<number, PopupCellState>();
    let shown = 0;
    let sum = 0;
    for (let i = 0; i < 40; i++) {
      const r = throttlePopup(s2, 8, i * 0.05, 3);
      if (r !== null) {
        shown++;
        sum += r;
      }
    }
    expect(shown).toBe(4); // t = 0, 0.5, 1.0, 1.5
    expect(sum + s2.get(8)!.carry).toBe(120);
  });

  it('cuts the view into a 3 × 3 grid, off-screen points to the nearest cell', () => {
    expect(popupCell(10, 10, 915, 412)).toBe(0);
    expect(popupCell(458, 206, 915, 412)).toBe(4);
    expect(popupCell(900, 400, 915, 412)).toBe(8);
    expect(popupCell(-50, 206, 915, 412)).toBe(3);
    expect(popupCell(2000, -10, 915, 412)).toBe(2);
  });
});

describe('layout and dialogs', () => {
  it("keeps the clear area off a reserved rect, on the side that leaves the most room", () => {
    const view = { x0: 10, y0: 60, x1: 905, y1: 330 };
    // a docked bubble in the top-left corner: the area starts below it (as the old tour's)
    expect(avoidRect(view, { left: 10, top: 66, right: 270, bottom: 136 })).toEqual({ x0: 10, y0: 136, x1: 905, y1: 330 });
    // also a wider one, where beside it would keep a little more room (measured in the game at 915x412)
    expect(avoidRect({ x0: 10, y0: 54, x1: 905, y1: 330 }, { left: 10, top: 60, right: 310, bottom: 160 })).toEqual({ x0: 10, y0: 160, x1: 905, y1: 330 });
    // a tall bubble on the right: the area ends left of it
    expect(avoidRect(view, { left: 600, top: 60, right: 905, bottom: 330 })).toEqual({ x0: 10, y0: 60, x1: 600, y1: 330 });
    // a bubble low in the view: the area ends above it
    expect(avoidRect(view, { left: 200, top: 250, right: 700, bottom: 330 })).toEqual({ x0: 10, y0: 60, x1: 905, y1: 250 });
    // not overlapping: unchanged
    expect(avoidRect(view, { left: 0, top: 0, right: 900, bottom: 50 })).toBe(view);
    // covering everything: unchanged
    expect(avoidRect(view, { left: 0, top: 0, right: 1000, bottom: 400 })).toBe(view);
  });

  it("styles Cancel as the primary button when asked (e.g. 'Keep learning')", () => {
    expect(dialogButtonClasses({})).toEqual({ ok: 'wh-btn-primary', cancel: 'wh-btn-ghost' });
    expect(dialogButtonClasses({ danger: true })).toEqual({ ok: 'wh-btn-danger', cancel: 'wh-btn-ghost' });
    expect(dialogButtonClasses({ primary: 'cancel' })).toEqual({ ok: 'wh-btn-ghost', cancel: 'wh-btn-primary' });
  });

  it('describes the pending action for extensions', () => {
    expect(pendingInfoOf('fence', null)).toBeNull();
    expect(pendingInfoOf('fence', { ok: true })).toEqual({ kind: 'fence', ok: true, risky: false, note: null, noteKind: null });
    expect(pendingInfoOf('fence', { ok: true, note: 'Not a habitat yet: close the fence' })).toEqual({
      kind: 'fence',
      ok: true,
      risky: false,
      note: 'Not a habitat yet: close the fence',
      noteKind: 'warning',
    });
    expect(pendingInfoOf('object', { ok: false, note: 'Not enough money', risky: false })).toMatchObject({ ok: false, noteKind: 'reason' });
    expect(pendingInfoOf('bulldoze', { ok: true, risky: true, note: 'Cuts off the entrance' })).toMatchObject({ risky: true, noteKind: 'warning' });
  });
});

describe('icons and avatars', () => {
  it('has the feature-round icons', () => {
    for (const n of ['lock', 'cloud', 'cloudOff', 'cloudCheck', 'cloudAlert', 'swords', 'share', 'copy', 'crown', 'user', 'users', 'undo', 'key'])
      expect(ICONS[n as keyof typeof ICONS], n).toMatch(/<(path|circle|rect)/);
  });

  it('draws every animal on every colour, unique ids, and falls back for unknown values', () => {
    expect(AVATAR_COLOR_HEX).toHaveLength(8);
    const seen = new Set<string>();
    for (const animal of AVATAR_ANIMALS) {
      for (let color = 0; color < 8; color++) {
        const svg = avatarSvg({ animal, color }, 48);
        expect(svg).toContain(`fill="${AVATAR_COLOR_HEX[color]}"`);
        expect(svg).toContain('width="48"');
        const id = /clipPath id="([^"]+)"/.exec(svg)![1];
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    // the ten heads differ
    const heads = new Set(AVATAR_ANIMALS.map((a) => avatarSvg({ animal: a, color: 0 }, 40).replace(/wh-av\d+/g, '').replace(/aria-label="[^"]*"/, '')));
    expect(heads.size).toBe(10);
    expect(avatarSvg({ animal: 'zebra', color: 3 }, 40)).toContain('aria-label="Zebra"');
    expect(avatarSvg({ animal: 'dragon' as AvatarAnimal, color: 11 }, 40)).toContain(`fill="${AVATAR_COLOR_HEX[3]}"`);
    expect(avatarSvg({ animal: 'dragon' as AvatarAnimal, color: -1 }, 40)).toContain('aria-label="Lion"');
  });
});
