// Tiny DOM helpers (no framework): element creation, cheap text/style updates
// that skip redundant writes, and formatting of game values.

import { icon, type IconName } from './icons';

type Child = Node | string | null | undefined | false;

export interface ElOpts {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  attrs?: Record<string, string>;
  onClick?: (ev: MouseEvent) => void;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, opts: ElOpts | string = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const o: ElOpts = typeof opts === 'string' ? { class: opts } : opts;
  if (o.class) e.className = o.class;
  if (o.text !== undefined) e.textContent = o.text;
  if (o.html !== undefined) e.innerHTML = o.html;
  if (o.title) e.title = o.title;
  if (o.attrs) for (const k in o.attrs) e.setAttribute(k, o.attrs[k]);
  if (o.onClick) {
    const fn = o.onClick;
    (e as HTMLElement).addEventListener('click', (ev: MouseEvent) => {
      ev.stopPropagation();
      fn(ev);
    });
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c);
  }
  return e;
}

/** A button with an icon and optional label. */
export function button(cls: string, ico: IconName | null, label: string | null, onClick: (ev: MouseEvent) => void, title?: string): HTMLButtonElement {
  const b = el('button', { class: `wh-btn ${cls}`, attrs: { type: 'button' }, title: title ?? label ?? undefined, onClick });
  b.innerHTML = (ico ? icon(ico) : '') + (label ? `<span class="wh-btn-label">${escapeHtml(label)}</span>` : '');
  return b;
}

export function iconEl(name: IconName, cls = ''): HTMLSpanElement {
  const s = el('span', { class: `wh-icon-wrap ${cls}` });
  s.innerHTML = icon(name);
  return s;
}

/** Write text only when it changed (avoids layout / style recalcs). */
export function setText(e: Element, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

export function setStyle(e: HTMLElement, prop: string, value: string): void {
  if (e.style.getPropertyValue(prop) !== value) e.style.setProperty(prop, value);
}

export function toggleClass(e: Element, cls: string, on: boolean): void {
  if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

// ---------------------------------------------------------------- formatting

export function fmtMoney(v: number, opts: { sign?: boolean; compact?: boolean } = {}): string {
  const neg = v < 0;
  const a = Math.abs(Math.round(v));
  let body: string;
  if (opts.compact && a >= 1_000_000) body = `${(a / 1_000_000).toFixed(a >= 10_000_000 ? 1 : 2)}M`;
  else body = a.toLocaleString('en-US');
  const sign = neg ? '−' : opts.sign ? '+' : '';
  return `${sign}$${body}`;
}

export function fmtClock(minuteOfDay: number): string {
  const m = Math.floor(minuteOfDay) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm}`;
}

export function fmtPct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Colour band for a 0..1 wellbeing value. */
export function levelClass(v: number): 'lvl-bad' | 'lvl-warn' | 'lvl-ok' | 'lvl-good' {
  return v < 0.3 ? 'lvl-bad' : v < 0.55 ? 'lvl-warn' : v < 0.8 ? 'lvl-ok' : 'lvl-good';
}

/** A labelled 0..1 meter bar. Returns the root and an updater. */
export function meter(label: string, ico?: IconName): { root: HTMLElement; set(v: number, text?: string): void } {
  const fill = el('div', 'wh-meter-fill');
  const val = el('span', 'wh-meter-val');
  const root = el('div', 'wh-meter', [
    el('div', 'wh-meter-head', [ico ? iconEl(ico, 'wh-meter-ico') : null, el('span', { class: 'wh-meter-label', text: label }), val]),
    el('div', 'wh-meter-track', [fill]),
  ]);
  let last = -1;
  let lastCls = '';
  return {
    root,
    set(v: number, text?: string) {
      const c = clamp01(v);
      const q = Math.round(c * 200) / 200;
      if (q !== last) {
        last = q;
        fill.style.transform = `scaleX(${q.toFixed(3)})`;
      }
      const cls = levelClass(c);
      if (cls !== lastCls) {
        if (lastCls) fill.classList.remove(lastCls);
        fill.classList.add(cls);
        lastCls = cls;
      }
      setText(val, text ?? fmtPct(c));
    },
  };
}

/** Prevent pointer events from leaking through panels to the 3D view. */
export function swallowPointer(e: HTMLElement): void {
  const stop = (ev: Event) => ev.stopPropagation();
  e.addEventListener('pointerdown', stop);
  e.addEventListener('wheel', stop, { passive: true });
  e.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

export function storageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

export function storageSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable (private mode / quota) */
  }
}
