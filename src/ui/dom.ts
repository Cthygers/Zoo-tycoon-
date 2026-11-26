// Tiny DOM helpers (no framework): element creation, cheap text/style updates
// that skip redundant writes, and formatting of game values.

import { icon, type IconName } from './icons';
import { cue } from './sound';

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

/** A button with an icon and optional label (plays the 'tap' cue unless the handler plays a richer one). */
export function button(cls: string, ico: IconName | null, label: string | null, onClick: (ev: MouseEvent) => void, title?: string): HTMLButtonElement {
  const click = (ev: MouseEvent) => {
    cue('tap');
    onClick(ev);
  };
  const t = title ?? label ?? undefined;
  const b = el('button', { class: `wh-btn ${cls}`, attrs: t ? { type: 'button', 'aria-label': t } : { type: 'button' }, title: t, onClick: click });
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

export { fmtMoney } from '../core/format';

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
/** Screen rectangle (px), as getBoundingClientRect reports it. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A screen box as the shell's layout code keeps it (px): x0/y0 top-left, x1/y1 bottom-right. */
export interface ScreenBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Below / above a rect is preferred over beside it unless beside leaves this much more room (keeps things centred sideways). */
const VERTICAL_CUT_BONUS = 1.25;

/**
 * The part of `area` left clear of `r` (e.g. the tutorial's bubble): `area` cut on the side that
 * keeps the most room, below or above it preferred (VERTICAL_CUT_BONUS; below wins ties). A bubble
 * docked in a top corner leaves the view below it, as the old tour's did; a tall one at a side
 * leaves the other side. Unchanged when they do not overlap; a rect covering all of it leaves
 * the area as it was.
 */
export function avoidRect(area: ScreenBox, r: ScreenRect): ScreenBox {
  if (r.right <= area.x0 || r.left >= area.x1 || r.bottom <= area.y0 || r.top >= area.y1) return area;
  const options: [ScreenBox, number][] = [
    [{ ...area, y0: Math.max(area.y0, r.bottom) }, VERTICAL_CUT_BONUS],
    [{ ...area, y1: Math.min(area.y1, r.top) }, VERTICAL_CUT_BONUS],
    [{ ...area, x0: Math.max(area.x0, r.right) }, 1],
    [{ ...area, x1: Math.min(area.x1, r.left) }, 1],
  ];
  let best = area;
  let bestA = 0;
  for (const [o, k] of options) {
    const a = Math.max(0, o.x1 - o.x0) * Math.max(0, o.y1 - o.y0) * k;
    if (a > bestA) {
      best = o;
      bestA = a;
    }
  }
  return best;
}

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
