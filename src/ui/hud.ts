// Top HUD: money (animated), day + clock with sun/moon, guests, rating stars,
// speed controls and the zoo menu button. Values refresh at ~4 Hz; only the
// money counter animates per frame while it is catching up.
//
// Two slots let UI extensions add to the bar: 'speed' takes the speed group's place
// while it holds anything (the versus clock chip), 'badge' sits left of the menu
// button (the cloud badge). Every speed change, from the buttons, the keyboard or an
// extension, goes through one SpeedControl: refused during a versus match, and while
// an extension's SpeedLock is set unless that extension asks itself.

import type { ISimulation, SimSpeed, ZooStats } from '../core/contracts';
import type { SpeedLock } from '../core/ui-ext';
import { button, el, fmtClock, fmtMoney, iconEl, setText, swallowPointer, toggleClass } from './dom';
import { icon } from './icons';
import { UnreadBadge, type MessageLog } from './notify';

/** Who asks for a speed change: a HUD button, a key (Space, 0–3) or a UI extension. */
export type SpeedSource = 'hud' | 'key' | 'ext';

/** Why a speed change is refused, or null when it may go ahead (pure). */
export function speedRefusal(versus: boolean, lock: SpeedLock | null, source: SpeedSource): 'versus' | 'locked' | null {
  if (versus) return 'versus';
  if (lock && source !== 'ext') return 'locked';
  return null;
}

/** The speed a key asks for: Space toggles pause / normal, 0–3 pick one; null for other keys. */
export function speedForKey(code: string, current: SimSpeed): SimSpeed | null {
  switch (code) {
    case 'Space':
      return current === 0 ? 1 : 0;
    case 'Digit0':
    case 'Numpad0':
      return 0;
    case 'Digit1':
    case 'Digit2':
    case 'Digit3':
      return Number(code.slice(5)) as SimSpeed;
    case 'Numpad1':
    case 'Numpad2':
    case 'Numpad3':
      return Number(code.slice(6)) as SimSpeed;
    default:
      return null;
  }
}

/** The one path for speed changes (HUD buttons, keys and extensions). */
export class SpeedControl {
  private lockVal: SpeedLock | null = null;

  constructor(
    private sim: Pick<ISimulation, 'speed' | 'setSpeed' | 'versus'>,
    /** A change went through (the HUD refreshes its buttons). */
    private changed: () => void = () => {},
  ) {}

  get lock(): SpeedLock | null {
    return this.lockVal;
  }

  setLock(lock: SpeedLock | null): void {
    this.lockVal = lock;
  }

  /** True when the speed was set; false (nothing changes) when refused. A lock hears about each refused try. */
  set(s: SimSpeed, source: SpeedSource): boolean {
    const why = speedRefusal(!!this.sim.versus, this.lockVal, source);
    if (why === 'locked') {
      try {
        this.lockVal?.onBlocked();
      } catch (err) {
        console.error('[ui] speed lock onBlocked failed', err);
      }
    }
    if (why) return false;
    this.sim.setSpeed(s);
    this.changed();
    return true;
  }
}

export interface HudHost {
  sim: ISimulation;
  /** Message log: the menu button shows how many warnings are unread. */
  log: MessageLog;
  openMenu(tab?: 'finance' | 'goals' | 'stats' | 'messages' | 'settings'): void;
  /** A speed button was tapped (false: the change was refused). */
  setSpeed(s: SimSpeed): boolean | void;
}

/** Guest chip: how many are in the zoo of how many fit, and whether arrivals are turned away. */
export function guestChip(st: Pick<ZooStats, 'guestsInZoo' | 'guestCapacity' | 'full'>): { count: string; cap: string; full: boolean; label: string } {
  return {
    count: String(st.guestsInZoo),
    cap: `/${st.guestCapacity}`,
    full: st.full,
    label: `Guests in the zoo: ${st.guestsInZoo} of ${st.guestCapacity}${st.full ? ' (full)' : ''}`,
  };
}

export class Hud {
  readonly root: HTMLElement;
  private moneyChip: HTMLElement;
  private moneyText: HTMLElement;
  private clockChip: HTMLElement;
  private clockIcon: HTMLElement;
  private dayText: HTMLElement;
  private timeText: HTMLElement;
  private openDot: HTMLElement;
  private guestsChip: HTMLElement;
  private guestsText: HTMLElement;
  private guestsCap: HTMLElement;
  private starsFg: HTMLElement;
  private ratingNum: HTMLElement;
  private speedBtns: HTMLButtonElement[] = [];
  private seg: HTMLElement;
  private speedWrap: HTMLElement | null;
  private lockBadge: HTMLElement;
  private lockShown = false;
  private menuBtn: HTMLButtonElement;
  /** Extension slots: 'speed' replaces the speed group while it has children; 'badge' sits left of the menu button. */
  readonly speedSlot: HTMLElement;
  readonly badgeSlot: HTMLElement;
  private slotShown = false;
  private unread: UnreadBadge;
  private shown = Number.NaN;
  private acc = 0;
  private night = -1;

  constructor(private host: HudHost) {
    const sim = host.sim;
    this.moneyText = el('span', 'wh-money');
    this.moneyChip = el('div', { class: 'wh-chip wh-chip-money wh-glass', title: 'Finances', onClick: () => host.openMenu('finance') }, [iconEl('coin'), this.moneyText]);

    this.clockIcon = el('span', 'wh-icon-wrap');
    this.dayText = el('span', 'wh-day');
    this.timeText = el('span', 'wh-time');
    this.openDot = el('span', 'wh-open');
    this.clockChip = el('div', { class: 'wh-chip wh-chip-clock wh-glass', title: 'Day and time', onClick: () => host.openMenu('stats') }, [
      this.clockIcon,
      this.dayText,
      this.timeText,
      this.openDot,
    ]);

    this.guestsText = el('span');
    this.guestsCap = el('span', 'wh-guests-cap');
    const guests = el('div', { class: 'wh-chip wh-chip-guests wh-glass', title: 'Guests in the zoo', onClick: () => host.openMenu('stats') }, [
      iconEl('guests'),
      el('span', {}, [this.guestsText, this.guestsCap]),
    ]);
    this.guestsChip = guests;

    const starRow = (cls: string) => {
      const r = el('span', cls);
      for (let i = 0; i < 5; i++) r.insertAdjacentHTML('beforeend', icon('star', i > 0 ? 'wh-star-x' : ''));
      return r;
    };
    this.starsFg = starRow('wh-stars-fg');
    this.ratingNum = el('span', 'wh-rating-num');
    const rating = el('div', { class: 'wh-chip wh-chip-rating wh-glass', title: 'Zoo rating', onClick: () => host.openMenu('goals') }, [
      el('span', 'wh-stars', [starRow('wh-stars-bg'), this.starsFg]),
      this.ratingNum,
    ]);

    const seg = el('div', 'wh-seg wh-glass');
    this.seg = seg;
    const icons = ['pause', 'play1', 'play2', 'play3'] as const;
    const titles = ['Pause', 'Normal speed', 'Fast (2×)', 'Fastest (4×)'];
    icons.forEach((ic, i) => {
      // a locked button still answers a tap (the lock's owner explains why nothing happens)
      const b = button('', ic, null, () => host.setSpeed(i as SimSpeed), titles[i]);
      this.speedBtns.push(b);
      seg.append(b);
    });
    this.lockBadge = el('span', { class: 'wh-seg-lock hidden', html: icon('lock'), attrs: { 'aria-hidden': 'true' } });
    seg.append(this.lockBadge);

    // with unread warnings, the menu opens on the Messages tab
    const menu = button('wh-menubtn wh-glass', 'menu', null, () => host.openMenu(host.log.unread ? 'messages' : undefined), 'Zoo menu');
    this.menuBtn = menu;
    this.unread = new UnreadBadge(menu, host.log, 'Zoo menu');

    this.speedSlot = el('div', 'wh-top-slot wh-slot-speed hidden');
    this.badgeSlot = el('div', 'wh-top-slot wh-slot-badge');
    // a versus match never shows the speed group (its clock is locked); its chip goes in the speed slot
    this.speedWrap = sim.versus ? null : el('div', 'wh-top-speed', [seg]);
    this.root = el('div', 'wh-top', [
      el('div', 'wh-top-left', [this.moneyChip, this.clockChip]),
      el('div', 'wh-top-mid', [guests, rating]),
      this.speedWrap,
      this.speedSlot,
      el('div', 'wh-top-menu', [this.badgeSlot, menu]),
    ]);
    for (const c of [this.moneyChip, this.clockChip, guests, rating, seg, menu, this.speedSlot, this.badgeSlot]) swallowPointer(c);
    this.shown = sim.money;
    this.refresh();
  }

  /** The money chip, the speed group (null during a versus match), the menu button. */
  get moneyEl(): HTMLElement {
    return this.moneyChip;
  }

  get speedGroupEl(): HTMLElement | null {
    return this.speedWrap && !this.slotShown ? this.seg : null;
  }

  get menuEl(): HTMLElement {
    return this.menuBtn;
  }

  /** The button for a speed (null while the speed group is not shown). */
  speedButton(s: SimSpeed): HTMLElement | null {
    return this.speedGroupEl ? (this.speedBtns[s] ?? null) : null;
  }

  /**
   * Show the speed buttons as locked (an extension holds the clock): dimmed, a small lock
   * badge and aria-disabled. They stay tappable, so a tap can be explained.
   */
  setSpeedLock(lock: SpeedLock | null): void {
    const on = !!lock;
    if (on === this.lockShown) return;
    this.lockShown = on;
    toggleClass(this.seg, 'locked', on);
    toggleClass(this.lockBadge, 'hidden', !on);
    for (const b of this.speedBtns) {
      if (on) b.setAttribute('aria-disabled', 'true');
      else b.removeAttribute('aria-disabled');
    }
    this.seg.title = on ? 'Time waits while you build' : '';
  }

  /** The speed slot holds something: it takes the speed group's place (cheap, checked every frame). */
  private syncSlots(): void {
    const filled = this.speedSlot.childElementCount > 0;
    if (filled !== this.slotShown) {
      this.slotShown = filled;
      toggleClass(this.speedSlot, 'hidden', !filled);
      if (this.speedWrap) toggleClass(this.speedWrap, 'hidden', filled);
    }
    // a match that started after the HUD was built (never in the game; harnesses) still drops the group
    if (this.speedWrap && this.host.sim.versus) {
      this.speedWrap.remove();
      this.speedWrap = null;
    }
  }

  update(dt: number): void {
    this.syncSlots();
    const target = this.host.sim.money;
    if (this.shown !== target) {
      const diff = target - this.shown;
      this.shown = Math.abs(diff) < 1 ? target : this.shown + diff * (1 - Math.exp(-dt * 7));
      if (Math.abs(target - this.shown) < 1) this.shown = target;
      setText(this.moneyText, fmtMoney(this.shown, { compact: true }));
      toggleClass(this.moneyChip, 'neg', this.shown < 0);
    }
    this.acc += dt;
    if (this.acc >= 0.25) {
      this.acc = 0;
      this.refresh();
    }
  }

  refresh(): void {
    const sim = this.host.sim;
    setText(this.moneyText, fmtMoney(this.shown, { compact: true }));
    toggleClass(this.moneyChip, 'neg', this.shown < 0);
    setText(this.dayText, `Day ${sim.day}`);
    setText(this.timeText, fmtClock(sim.minuteOfDay));
    const h = sim.minuteOfDay / 60;
    const night = h < 6 || h >= 19.5 ? 1 : 0;
    if (night !== this.night) {
      this.night = night;
      this.clockIcon.innerHTML = icon(night ? 'moon' : 'sun');
      toggleClass(this.clockChip, 'night', !!night);
    }
    const open = sim.isOpen();
    toggleClass(this.openDot, 'closed', !open);
    this.openDot.title = open ? 'Zoo open' : 'Zoo closed';
    const g = guestChip(sim.stats());
    setText(this.guestsText, g.count);
    setText(this.guestsCap, g.cap);
    toggleClass(this.guestsCap, 'full', g.full);
    if (this.guestsChip.title !== g.label) this.guestsChip.title = g.label;
    const r = Math.max(0, Math.min(100, sim.rating));
    const w = `${(r / 100) * 100}%`;
    if (this.starsFg.style.width !== w) this.starsFg.style.width = w;
    setText(this.ratingNum, String(Math.round(r)));
    for (let i = 0; i < this.speedBtns.length; i++) {
      toggleClass(this.speedBtns[i], 'on', sim.speed === i);
      toggleClass(this.speedBtns[i], 'paused', i === 0);
    }
    this.unread.update();
  }

  dispose(): void {
    this.root.remove();
  }
}
