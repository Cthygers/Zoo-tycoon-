// Player feedback: toasts (tap to fly the camera to the event), objective
// celebrations, floating "+$20" money popups projected from world positions,
// and the live cost label that follows a build drag.

import * as THREE from 'three';
import type { NotifyKind } from '../core/events';
import { el, escapeHtml, fmtMoney, setText, swallowPointer, toggleClass } from './dom';
import { icon, type IconName } from './icons';
import { cue } from './sound';

const KIND_ICON: Record<NotifyKind, IconName> = { info: 'info', good: 'good', warn: 'warn', bad: 'bad' };

/** How long a toast stays up (ms). */
const LIFE: Record<NotifyKind, number> = { info: 4200, good: 4200, warn: 5200, bad: 5200 };
/** Even with messages waiting, a toast stays up at least this long (ms) so it can be read. */
const MIN_LIFE = 2400;
/** Waiting toasts beyond this are dropped (oldest routine ones first); the message log keeps them. */
const MAX_QUEUED = 6;
const LOG_SIZE = 40;
/** Gap between the cards of the toast column (px, as in .wh-toasts). */
const GAP = 8;
/** Height (px) assumed for a toast that has not been on screen yet: one line of text. */
const TOAST_H = 44;
/** Height (px) assumed for a "Goal complete" card that has not been on screen yet. */
const CARD_H = 88;

const urgent = (k: NotifyKind) => k === 'warn' || k === 'bad';

export interface LogEntry {
  text: string;
  kind: NotifyKind;
  focus?: { x: number; z: number };
  day: number;
  /** Game minute of the day of the latest occurrence. */
  minute: number;
  count: number;
}

/** The last few dozen notifications, newest first (the zoo menu's Messages tab). */
export class MessageLog {
  readonly entries: LogEntry[] = [];
  /** Bumped on every change, so a list can cheaply tell whether to re-render. */
  version = 0;
  /** Warnings and problems logged since the Messages tab was last looked at. */
  unread = 0;
  /** At least one of them is a problem ('bad'), not just a warning. */
  unreadBad = false;

  add(text: string, kind: NotifyKind, focus: { x: number; z: number } | undefined, day: number, minute: number): void {
    this.version++;
    if (urgent(kind)) {
      this.unread++;
      if (kind === 'bad') this.unreadBad = true;
    }
    const last = this.entries[0];
    if (last && last.text === text && last.kind === kind) {
      last.count++;
      last.day = day;
      last.minute = minute;
      return;
    }
    this.entries.unshift({ text, kind, focus, day, minute, count: 1 });
    if (this.entries.length > LOG_SIZE) this.entries.length = LOG_SIZE;
  }

  /** The player is looking at the Messages tab. */
  markRead(): void {
    this.unread = 0;
    this.unreadBad = false;
  }
}

/** Count of unread warnings on a button (the menu button, the Messages tab); call update() to refresh. */
export class UnreadBadge {
  private readonly badge = el('span', { class: 'wh-badge hidden', attrs: { 'aria-hidden': 'true' } });
  private shown = '';

  /** `label`: the button's accessible name, which then also says how many are new. */
  constructor(
    private button: HTMLElement,
    private log: MessageLog,
    private label?: string,
  ) {
    button.append(this.badge);
  }

  update(): void {
    const n = this.log.unread;
    const key = n ? `${n}${this.log.unreadBad ? 'b' : ''}` : '';
    if (key === this.shown) return;
    this.shown = key;
    toggleClass(this.badge, 'hidden', !n);
    toggleClass(this.badge, 'bad', this.log.unreadBad);
    setText(this.badge, n > 9 ? '9+' : String(n));
    if (this.label) this.button.setAttribute('aria-label', n ? `${this.label} (${n} new warning${n > 1 ? 's' : ''})` : this.label);
  }
}

interface ToastRec {
  text: string;
  kind: NotifyKind;
  focus?: { x: number; z: number };
  count: number;
  root: HTMLElement | null;
  countEl: HTMLElement | null;
  timer: number;
  shownAt: number;
  expiresAt: number;
  /** Measured height (px) once it has been on screen, 0 before. */
  height: number;
}

/** Height (px) the live cards of a toast column take, gaps included (leaving ones don't count). */
function columnHeight(col: HTMLElement): number {
  let h = 0;
  for (const c of col.children) if (!c.classList.contains('out')) h += (c as HTMLElement).offsetHeight + GAP;
  return h;
}

/**
 * Toast stack. On a short screen only two fit, so extra messages wait in a queue
 * (warnings first) instead of pushing the visible ones off at once; while
 * something waits, visible toasts leave after MIN_LIFE. The column also never
 * grows past the room GameUI gives it (setRoom), so it never covers the dock,
 * an open build drawer or the tool bar: messages wait while there is no room.
 * Every message is also written to the log.
 */
export class Toasts {
  readonly root = el('div', 'wh-toasts');
  readonly log = new MessageLog();
  private list: ToastRec[] = [];
  private queue: ToastRec[] = [];
  /** Height (px) the column may fill. */
  private room = Infinity;
  /** Ongoing-work line at the top of the column (e.g. applying graphics settings), if any. */
  private status: HTMLElement | null = null;

  constructor(
    private onFocus: (x: number, z: number) => void,
    private clock: () => { day: number; minute: number },
  ) {}

  private get capacity(): number {
    return window.innerHeight < 520 ? 2 : 3;
  }

  show(text: string, kind: NotifyKind, focus?: { x: number; z: number }): void {
    const now = this.clock();
    this.log.add(text, kind, focus, now.day, now.minute);
    // merge repeats of the same message instead of stacking them
    const dup = this.list.find((t) => t.text === text) ?? this.queue.find((t) => t.text === text);
    if (dup) {
      dup.count++;
      if (dup.root) {
        setText(dup.countEl!, `×${dup.count}`);
        dup.countEl!.style.display = '';
        this.schedule(dup, performance.now() + (this.queue.length ? MIN_LIFE : LIFE[dup.kind]));
      }
      return;
    }
    const rec: ToastRec = { text, kind, focus, count: 1, root: null, countEl: null, timer: 0, shownAt: 0, expiresAt: 0, height: 0 };
    if (this.list.length >= this.capacity || !this.fits(TOAST_H)) {
      // a warning takes the place of the oldest routine toast rather than waiting behind it
      const routine = urgent(kind) ? this.list.find((t) => !urgent(t.kind)) : undefined;
      if (!routine || !this.fits(TOAST_H, routine)) {
        this.enqueue(rec);
        return;
      }
      this.remove(routine, false);
      // barely seen: let it come back once there is room
      if (performance.now() - routine.shownAt < MIN_LIFE) this.enqueue(this.requeued(routine));
    }
    this.display(rec);
  }

  /**
   * Height (px) the column may fill below its top edge: GameUI keeps it clear of the
   * dock, drawer and tool bar. Toasts that no longer fit leave, oldest first (and come
   * back later if they were barely seen); waiting ones appear as room frees up.
   */
  setRoom(px: number): void {
    this.room = px;
    // the status line steps aside (but stays) while there is no room for it at all
    if (this.status) toggleClass(this.status, 'hidden', TOAST_H + GAP > px);
    // oldest first; they line up again in the order they were shown
    const off: ToastRec[] = [];
    while (this.list.length && columnHeight(this.root) > px) {
      const t = this.list[0];
      this.remove(t, false);
      if (performance.now() - t.shownAt < MIN_LIFE) off.push(this.requeued(t));
    }
    if (off.length) {
      this.queue.unshift(...off);
      this.trimQueue();
    }
    this.fill();
  }

  /** Show (text) or clear (null) a line about ongoing work, with a spinner, at the top of the column. */
  setStatus(text: string | null): void {
    if (!text) {
      this.status?.remove();
      this.status = null;
      return;
    }
    if (!this.status) {
      this.status = el('div', { class: 'wh-toast wh-glass-2 info wh-toast-status', attrs: { role: 'status' } });
      toggleClass(this.status, 'hidden', TOAST_H + GAP > this.room);
      this.root.prepend(this.status);
    }
    this.status.innerHTML = `<i class="wh-spin"></i><span>${escapeHtml(text)}</span>`;
  }

  /** Would a toast of height `h` fit in the column (after `without` left)? */
  private fits(h: number, without?: ToastRec): boolean {
    const freed = without?.root ? without.root.offsetHeight + GAP : 0;
    return columnHeight(this.root) - freed + h <= this.room;
  }

  /** Show waiting toasts while there is room for them. */
  private fill(): void {
    while (this.queue.length && this.list.length < this.capacity && this.fits(this.queue[0].height || TOAST_H)) this.display(this.queue.shift()!);
  }

  /** A fresh record (no DOM yet) for a toast that was evicted early. */
  private requeued(t: ToastRec): ToastRec {
    return { ...t, root: null, countEl: null, timer: 0, shownAt: 0, expiresAt: 0 };
  }

  private enqueue(rec: ToastRec): void {
    // urgent ones go ahead of routine ones, otherwise first come first served
    const at = urgent(rec.kind) ? this.queue.findIndex((t) => !urgent(t.kind)) : -1;
    if (at < 0) this.queue.push(rec);
    else this.queue.splice(at, 0, rec);
    this.trimQueue();
    this.hurry();
  }

  private trimQueue(): void {
    while (this.queue.length > MAX_QUEUED) {
      const drop = this.queue.findIndex((t) => !urgent(t.kind));
      this.queue.splice(drop < 0 ? 0 : drop, 1);
    }
  }

  /** Shorten what is on screen so the queue drains, but never below MIN_LIFE. */
  private hurry(): void {
    for (const t of this.list) {
      const soonest = Math.max(performance.now(), t.shownAt + MIN_LIFE);
      if (soonest < t.expiresAt) this.schedule(t, soonest);
    }
  }

  private schedule(t: ToastRec, at: number): void {
    window.clearTimeout(t.timer);
    t.expiresAt = at;
    t.timer = window.setTimeout(() => this.remove(t), Math.max(0, at - performance.now()));
  }

  private display(rec: ToastRec): void {
    const countEl = el('span', 'wh-toast-count');
    if (rec.count > 1) countEl.textContent = `×${rec.count}`;
    else countEl.style.display = 'none';
    const root = el('div', `wh-toast wh-glass-2 ${rec.kind}`);
    root.innerHTML = `${icon(KIND_ICON[rec.kind])}<span>${escapeHtml(rec.text)}</span>`;
    root.append(countEl);
    if (rec.focus) {
      const go = el('span', 'wh-toast-go');
      go.innerHTML = icon('target');
      root.append(go);
    }
    swallowPointer(root);
    root.addEventListener('click', (ev) => {
      ev.stopPropagation();
      cue('tap');
      if (rec.focus) this.onFocus(rec.focus.x, rec.focus.z);
      this.remove(rec);
    });
    rec.root = root;
    rec.countEl = countEl;
    rec.shownAt = performance.now();
    this.list.push(rec);
    this.root.append(root);
    rec.height = root.offsetHeight;
    this.schedule(rec, rec.shownAt + (this.queue.length ? MIN_LIFE : LIFE[rec.kind]));
  }

  /** Take a toast off screen; `refill` shows the next waiting one in its place. */
  private remove(rec: ToastRec, refill = true): void {
    const i = this.list.indexOf(rec);
    if (i < 0) return;
    this.list.splice(i, 1);
    window.clearTimeout(rec.timer);
    const root = rec.root!;
    root.classList.add('out');
    window.setTimeout(() => root.remove(), 300);
    if (refill) this.fill();
  }

  dispose(): void {
    for (const t of this.list) window.clearTimeout(t.timer);
    this.list = [];
    this.queue = [];
    this.root.remove();
  }
}

// ---------------------------------------------------------------------------
interface Popup {
  el: HTMLElement;
  x: number;
  y: number;
  z: number;
  age: number;
  active: boolean;
}

const _v = new THREE.Vector3();
const POPUP_LIFE = 1.7;

/** Pooled floating money labels anchored to world positions. */
export class MoneyPopups {
  readonly root = el('div', 'wh-popups');
  private pool: Popup[] = [];
  private activeCount = 0;

  constructor(private camera: THREE.Camera, private heightAt: (x: number, z: number) => number) {
    for (let i = 0; i < 14; i++) {
      const e = el('div', 'wh-popup');
      this.root.append(e);
      this.pool.push({ el: e, x: 0, y: 0, z: 0, age: 0, active: false });
    }
  }

  spawn(x: number, z: number, amount: number): void {
    if (!amount) return;
    let p = this.pool.find((q) => !q.active);
    if (!p) p = this.pool.reduce((a, b) => (a.age > b.age ? a : b));
    else this.activeCount++;
    p.active = true;
    p.age = 0;
    p.x = x;
    p.z = z;
    p.y = this.heightAt(x, z) + 2.2;
    p.el.textContent = fmtMoney(amount, { sign: true });
    p.el.className = `wh-popup ${amount > 0 ? 'plus' : 'minus'}`;
    p.el.style.display = 'block';
  }

  update(dt: number, width: number, height: number): void {
    if (!this.activeCount) return;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= POPUP_LIFE) {
        p.active = false;
        this.activeCount--;
        p.el.style.display = 'none';
        continue;
      }
      _v.set(p.x, p.y + p.age * 1.1, p.z).project(this.camera);
      if (_v.z > 1 || _v.x < -1.2 || _v.x > 1.2 || _v.y < -1.2 || _v.y > 1.2) {
        p.el.style.opacity = '0';
        continue;
      }
      const sx = (_v.x * 0.5 + 0.5) * width;
      const sy = (1 - (_v.y * 0.5 + 0.5)) * height;
      const t = p.age / POPUP_LIFE;
      const a = t < 0.15 ? t / 0.15 : t > 0.65 ? 1 - (t - 0.65) / 0.35 : 1;
      const s = 0.85 + Math.min(1, p.age * 6) * 0.15;
      p.el.style.opacity = a.toFixed(3);
      p.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -50%) scale(${s.toFixed(3)})`;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

// ---------------------------------------------------------------------------
/** Cost label that follows the end of a build drag. */
export class CostLabel {
  readonly root: HTMLElement;
  private main = el('span');
  private sub = el('span', 'wh-cl-sub');
  private anchor: THREE.Vector3 | null = null;
  private halfW = 70;
  private measure = true;

  constructor(private camera: THREE.Camera) {
    this.root = el('div', 'wh-costlabel wh-glass-2', [this.main, this.sub]);
  }

  set(anchor: THREE.Vector3 | null, text: string, sub: string, ok: boolean): void {
    this.anchor = anchor;
    if (!anchor) {
      this.root.style.display = 'none';
      return;
    }
    if (this.main.textContent !== text || this.sub.textContent !== sub) this.measure = true;
    setText(this.main, text);
    setText(this.sub, sub);
    this.root.classList.toggle('bad', !ok);
    this.root.style.display = 'block';
  }

  /** `maxY`: lowest screen y the label's anchor may sit at (keeps it above the dock / confirm bar). */
  update(width: number, height: number, maxY = height - 30): void {
    if (!this.anchor) return;
    _v.copy(this.anchor).project(this.camera);
    if (_v.z > 1) {
      this.root.style.opacity = '0';
      return;
    }
    this.root.style.opacity = '1';
    if (this.measure) {
      this.measure = false;
      this.halfW = this.root.offsetWidth / 2 || 70;
    }
    const m = this.halfW + 8;
    const sx = Math.min(width - m, Math.max(m, (_v.x * 0.5 + 0.5) * width));
    const sy = Math.min(Math.min(height - 30, maxY), Math.max(100, (1 - (_v.y * 0.5 + 0.5)) * height));
    this.root.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -135%)`;
  }
}

// ---------------------------------------------------------------------------
const CONFETTI = ['#97c46c', '#e4d0a0', '#f2cf74', '#82bfd6', '#e88466', '#f3eee2'];
/** How long a "Goal complete" card stays up (ms). */
const CARD_LIFE = 4800;

interface CardItem {
  text: string;
  reward: number;
  /** Measured height (px) once it has been on screen, 0 before. */
  height: number;
}

interface ShownCard {
  item: CardItem;
  card: HTMLElement;
  shownAt: number;
  closing: boolean;
  close(): void;
}

/** "Goal complete" celebration card with a confetti burst. */
export class Celebration {
  private queue: CardItem[] = [];
  /** The card on screen (until its fade-out ends). */
  private current: ShownCard | null = null;
  /** Height (px) the toast column may fill (see Toasts.setRoom). */
  private room = Infinity;

  /** Cards are stacked at the top of the given column (the toast stack). */
  constructor(private root: HTMLElement) {}

  show(text: string, reward: number): void {
    this.queue.push({ text, reward, height: 0 });
    this.next();
  }

  /**
   * Height (px) the column may fill. A card waits while it would not fit, and one on
   * screen steps aside when the room shrinks (coming back later if it was barely seen);
   * toasts below a card make way for it (Toasts.setRoom).
   */
  setRoom(px: number): void {
    this.room = px;
    const cur = this.current;
    if (!cur) this.next();
    else if (!cur.closing && cur.card.offsetHeight + GAP > px) {
      if (performance.now() - cur.shownAt < MIN_LIFE) this.queue.unshift(cur.item);
      cur.close();
    }
  }

  private next(): void {
    const item = this.queue[0];
    if (this.current || !item || (item.height || CARD_H) + GAP > this.room) return;
    this.queue.shift();
    const card = el('div', 'wh-cele-card wh-glass-2');
    card.innerHTML = `<div class="wh-cele-badge">${icon('trophy')}</div><div><div class="wh-cele-k">Goal complete</div><div class="wh-cele-t">${escapeHtml(
      item.text,
    )}</div>${item.reward ? `<div class="wh-cele-r">Reward ${fmtMoney(item.reward, { sign: true })}</div>` : ''}</div>`;
    const conf = el('div', 'wh-confetti');
    for (let i = 0; i < 28; i++) {
      const p = el('i');
      const ang = (i / 28) * Math.PI * 2 + Math.random() * 0.3;
      const dist = 90 + Math.random() * 110;
      p.style.background = CONFETTI[i % CONFETTI.length];
      p.style.setProperty('--dx', `${(Math.cos(ang) * dist).toFixed(0)}px`);
      p.style.setProperty('--dy', `${(Math.sin(ang) * dist * 0.6 + 60).toFixed(0)}px`);
      p.style.setProperty('--rot', `${Math.round(Math.random() * 720 - 360)}deg`);
      p.style.animationDelay = `${(Math.random() * 0.12).toFixed(2)}s`;
      conf.append(p);
    }
    card.append(conf);
    swallowPointer(card);
    const cur: ShownCard = {
      item,
      card,
      shownAt: performance.now(),
      closing: false,
      close: () => {
        if (cur.closing) return;
        cur.closing = true;
        window.clearTimeout(timer);
        card.classList.add('out');
        window.setTimeout(() => {
          card.remove();
          if (this.current === cur) this.current = null;
          this.next();
        }, 380);
      },
    };
    card.addEventListener('click', (ev) => {
      ev.stopPropagation();
      cur.close();
    });
    this.current = cur;
    this.root.prepend(card);
    item.height = card.offsetHeight;
    const timer = window.setTimeout(cur.close, CARD_LIFE);
  }

  dispose(): void {
    this.queue = [];
    this.current?.card.remove();
    this.current = null;
  }
}
