// Player feedback: toasts (tap to fly the camera to the event), objective
// celebrations, floating "+$20" money popups projected from world positions,
// and the live cost label that follows a build drag.

import * as THREE from 'three';
import type { NotifyKind } from '../core/events';
import { el, escapeHtml, fmtMoney, setText, swallowPointer } from './dom';
import { icon, type IconName } from './icons';
import { cue } from './sound';

const KIND_ICON: Record<NotifyKind, IconName> = { info: 'info', good: 'good', warn: 'warn', bad: 'bad' };

interface ToastRec {
  root: HTMLElement;
  text: string;
  count: number;
  countEl: HTMLElement;
  timer: number;
}

export class Toasts {
  readonly root = el('div', 'wh-toasts');
  private list: ToastRec[] = [];
  private max = 3;

  constructor(private onFocus: (x: number, z: number) => void) {}

  show(text: string, kind: NotifyKind, focus?: { x: number; z: number }): void {
    // merge repeats of the same message instead of stacking them
    const dup = this.list.find((t) => t.text === text);
    if (dup) {
      dup.count++;
      setText(dup.countEl, `×${dup.count}`);
      dup.countEl.style.display = '';
      window.clearTimeout(dup.timer);
      dup.timer = window.setTimeout(() => this.remove(dup), 4200);
      return;
    }
    const countEl = el('span', 'wh-toast-count');
    countEl.style.display = 'none';
    const root = el('div', `wh-toast wh-glass-2 ${kind}`);
    root.innerHTML = `${icon(KIND_ICON[kind])}<span>${escapeHtml(text)}</span>`;
    root.append(countEl);
    if (focus) {
      const go = el('span', 'wh-toast-go');
      go.innerHTML = icon('target');
      root.append(go);
    }
    swallowPointer(root);
    const rec: ToastRec = { root, text, count: 1, countEl, timer: 0 };
    root.addEventListener('click', (ev) => {
      ev.stopPropagation();
      cue('tap');
      if (focus) this.onFocus(focus.x, focus.z);
      this.remove(rec);
    });
    rec.timer = window.setTimeout(() => this.remove(rec), kind === 'bad' || kind === 'warn' ? 5200 : 4200);
    this.list.push(rec);
    this.root.append(root);
    const max = window.innerHeight < 520 ? this.max - 1 : this.max;
    while (this.list.length > max) this.remove(this.list[0]);
  }

  private remove(rec: ToastRec): void {
    const i = this.list.indexOf(rec);
    if (i < 0) return;
    this.list.splice(i, 1);
    window.clearTimeout(rec.timer);
    rec.root.classList.add('out');
    window.setTimeout(() => rec.root.remove(), 300);
  }

  dispose(): void {
    for (const t of this.list) window.clearTimeout(t.timer);
    this.list = [];
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

/** "Goal complete" celebration card with a confetti burst. */
export class Celebration {
  private queue: { text: string; reward: number }[] = [];
  private showing = false;
  private card: HTMLElement | null = null;

  /** Cards are stacked at the top of the given column (the toast stack). */
  constructor(private root: HTMLElement) {}

  show(text: string, reward: number): void {
    this.queue.push({ text, reward });
    if (!this.showing) this.next();
  }

  private next(): void {
    const item = this.queue.shift();
    if (!item) {
      this.showing = false;
      return;
    }
    this.showing = true;
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
    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      card.classList.add('out');
      window.setTimeout(() => {
        card.remove();
        this.next();
      }, 380);
    };
    card.addEventListener('click', (ev) => {
      ev.stopPropagation();
      close();
    });
    this.card = card;
    this.root.prepend(card);
    window.setTimeout(close, 4800);
  }

  dispose(): void {
    this.queue = [];
    this.card?.remove();
  }
}
