// Top HUD: money (animated), day + clock with sun/moon, guests, rating stars,
// speed controls and the zoo menu button. Values refresh at ~4 Hz; only the
// money counter animates per frame while it is catching up.

import type { ISimulation, SimSpeed } from '../core/contracts';
import { button, el, fmtClock, fmtMoney, iconEl, setText, swallowPointer, toggleClass } from './dom';
import { icon } from './icons';
import { UnreadBadge, type MessageLog } from './notify';

export interface HudHost {
  sim: ISimulation;
  /** Message log: the menu button shows how many warnings are unread. */
  log: MessageLog;
  openMenu(tab?: 'finance' | 'goals' | 'stats' | 'messages' | 'settings'): void;
  setSpeed(s: SimSpeed): void;
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
  private guestsText: HTMLElement;
  private starsFg: HTMLElement;
  private ratingNum: HTMLElement;
  private speedBtns: HTMLButtonElement[] = [];
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
    const guests = el('div', { class: 'wh-chip wh-chip-guests wh-glass', title: 'Guests in the zoo', onClick: () => host.openMenu('stats') }, [iconEl('guests'), this.guestsText]);

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
    const icons = ['pause', 'play1', 'play2', 'play3'] as const;
    const titles = ['Pause', 'Normal speed', 'Fast (2×)', 'Fastest (4×)'];
    icons.forEach((ic, i) => {
      const b = button('', ic, null, () => host.setSpeed(i as SimSpeed), titles[i]);
      this.speedBtns.push(b);
      seg.append(b);
    });

    // with unread warnings, the menu opens on the Messages tab
    const menu = button('wh-menubtn wh-glass', 'menu', null, () => host.openMenu(host.log.unread ? 'messages' : undefined), 'Zoo menu');
    this.unread = new UnreadBadge(menu, host.log, 'Zoo menu');

    this.root = el('div', 'wh-top', [
      el('div', 'wh-top-left', [this.moneyChip, this.clockChip]),
      el('div', 'wh-top-mid', [guests, rating]),
      el('div', 'wh-top-speed', [seg]),
      el('div', 'wh-top-menu', [menu]),
    ]);
    for (const c of [this.moneyChip, this.clockChip, guests, rating, seg, menu]) swallowPointer(c);
    this.shown = sim.money;
    this.refresh();
  }

  update(dt: number): void {
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
    setText(this.guestsText, String(sim.guests.size));
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
