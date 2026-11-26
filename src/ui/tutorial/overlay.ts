// The tutorial's DOM (tutorial.md §6, spec §6.2): the two-tier bubble, the dim with a hole,
// the pulsing ring, the animated hand, the "Great!" pop, the welcome and finish cards and the
// "Learn to play" chip. Only DOM writes live here; what to show and where is decided by the
// machine (machine.ts) and the placement function (place.ts).

import { button, el, escapeHtml, setText, swallowPointer, toggleClass } from '../dom';
import { icon, type IconName } from '../icons';
import type { Rect } from './place';
import { BUTTONS, CARDS } from './script';

const CSS = /* css */ `
.wh-tut-bubble {
  position: absolute; left: 0; top: 0; z-index: 22; box-sizing: border-box;
  width: max-content; min-width: 220px; max-width: min(340px, calc(100vw - 24px));
  padding: 6px 8px 10px 14px; border-radius: 16px;
  background: #1d2a19; border: 2px solid #b8da8c; box-shadow: 0 12px 30px rgba(0,0,0,.5);
  color: #fff; pointer-events: none; transition: opacity .2s ease;
  font-family: inherit;
}
.wh-tut-bubble.hidden { display: none; }
.wh-tut-bubble.measuring { visibility: hidden; }
.wh-tut-bubble.faded { opacity: .4; }
.wh-tut-bubble.over-panel { z-index: 46; }
.wh-tut-head { display: flex; align-items: center; gap: 6px; height: 30px; margin-right: -2px; }
.wh-tut-chip { flex: none; background: var(--wh-leaf, #97c46c); color: #16230f; font-size: 12px; font-weight: 800; line-height: 1; border-radius: 9px; padding: 4px 8px; white-space: nowrap; }
.wh-tut-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 700; color: #e4d0a0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-tut-icon { pointer-events: auto; width: 36px; height: 36px; min-width: 36px; min-height: 36px; padding: 0; border-radius: 18px; position: relative; color: #e4d0a0; background: rgba(255,255,255,.06); }
.wh-tut-icon::before { content: ""; position: absolute; inset: -4px; }
.wh-tut-icon .wh-ico { width: 20px; height: 20px; }
.wh-tut-say.off { color: rgba(228,208,160,.55); }
.wh-tut-a { font-size: 20px; line-height: 1.2; font-weight: 800; margin: 2px 6px 0 0; color: #fff; }
.wh-tut-w { font-size: 15px; line-height: 1.3; font-weight: 600; margin: 3px 6px 0 0; color: #f6f1e4; }
.wh-tut-w:empty { display: none; }
.wh-tut-foot { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; align-items: center; }
.wh-tut-foot:empty { display: none; }
.wh-tut-foot .wh-btn { pointer-events: auto; min-height: 44px; height: 44px; font-size: 15px; border-radius: 14px; }
.wh-tut-foot .wh-btn .wh-ico { width: 20px; height: 20px; }
.wh-tut-arrow { position: absolute; width: 14px; height: 14px; background: #1d2a19; border: 2px solid #b8da8c; transform: rotate(45deg); }
.wh-tut-arrow.bottom { bottom: -9px; border-top: 0; border-left: 0; }
.wh-tut-arrow.top { top: -9px; border-bottom: 0; border-right: 0; }
.wh-tut-arrow.left { left: -9px; border-top: 0; border-right: 0; }
.wh-tut-arrow.right { right: -9px; border-bottom: 0; border-left: 0; }
.wh-tut-arrow.hidden { display: none; }
@media (max-height: 380px) {
  .wh-tut-a { font-size: 18px; }
  .wh-tut-w { font-size: 14px; }
  .wh-tut-head { height: 28px; }
}
.wh-tut-hole {
  position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 19; border-radius: 16px;
  box-shadow: 0 0 0 200vmax rgba(6,10,7,.42); pointer-events: none;
  transition: left .25s ease, top .25s ease, width .25s ease, height .25s ease, opacity .2s ease;
}
.wh-tut-hole.hidden { opacity: 0; visibility: hidden; transition: none; }
.wh-tut-ring {
  position: absolute; left: 0; top: 0; z-index: 21; border: 3px solid #f4dca0; border-radius: 16px;
  pointer-events: none; box-shadow: 0 0 12px rgba(244,220,160,.6); animation: wh-tut-pulse 1.2s ease-in-out infinite;
}
.wh-tut-ring.over-panel { z-index: 47; }
.wh-tut-ring.hidden { display: none; }
@keyframes wh-tut-pulse { 50% { transform: scale(1.08); opacity: .35; } }
.wh-tut-hand { position: absolute; left: 0; top: 0; width: 56px; height: 56px; z-index: 48; pointer-events: none; will-change: transform, opacity; filter: drop-shadow(0 3px 4px rgba(0,0,0,.45)); }
.wh-tut-hand svg { display: block; width: 56px; height: 56px; }
.wh-tut-dot { position: absolute; left: 0; top: 0; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%; z-index: 48; pointer-events: none; background: rgba(255,255,255,.88); border: 2.5px solid #1d2a19; box-shadow: 0 2px 6px rgba(0,0,0,.4); will-change: transform; }
.wh-tut-trail { position: absolute; left: 0; top: 0; height: 0; border-top: 4px dotted rgba(255,255,255,.75); z-index: 47; pointer-events: none; transform-origin: 0 50%; }
.wh-tut-ripple { position: absolute; left: 0; top: 0; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid rgba(255,255,255,.9); z-index: 47; pointer-events: none; }
.wh-tut-hand.hidden, .wh-tut-dot.hidden, .wh-tut-trail.hidden, .wh-tut-ripple.hidden { display: none; }
.wh-tut-pop {
  position: absolute; z-index: 23; pointer-events: none; transform: translate(-50%, -50%);
  background: linear-gradient(180deg, #a6d17b, #7eae55); color: #16230f; font-weight: 800; font-size: 22px;
  padding: 8px 18px; border-radius: 22px; box-shadow: 0 8px 22px rgba(0,0,0,.4); animation: wh-tut-popin 1.1s ease both;
}
@keyframes wh-tut-popin { 0% { transform: translate(-50%,-50%) scale(.5); opacity: 0; } 18% { transform: translate(-50%,-50%) scale(1.08); opacity: 1; } 30% { transform: translate(-50%,-50%) scale(1); } 80% { opacity: 1; } 100% { opacity: 0; transform: translate(-50%,-62%) scale(1); } }
.wh-tut-cardback { position: absolute; inset: 0; z-index: 50; background: rgba(6,10,8,.45); display: flex; align-items: center; justify-content: center; pointer-events: auto; padding: 8px 12px; }
.wh-tut-card {
  width: min(520px, 92vw); max-height: 92vh; overflow-y: auto; box-sizing: border-box; text-align: center;
  background: #1d2a19; border: 2px solid #b8da8c; border-radius: 22px; padding: 16px 20px 14px; color: #fff;
  box-shadow: 0 18px 50px rgba(0,0,0,.55); animation: wh-tut-cardin .3s cubic-bezier(.2,.9,.3,1.2) both;
}
@keyframes wh-tut-cardin { from { transform: scale(.9); opacity: 0; } }
.wh-tut-logo { width: 64px; height: 64px; margin: 0 auto 6px; border-radius: 32px; background: rgba(151,196,108,.18); color: #b8da8c; display: grid; place-items: center; }
.wh-tut-logo .wh-ico { width: 38px; height: 38px; }
.wh-tut-card h2 { margin: 0 0 6px; font-size: 24px; line-height: 1.2; font-weight: 800; }
.wh-tut-card p { margin: 0 0 8px; font-size: 17px; line-height: 1.35; font-weight: 600; color: #f6f1e4; }
.wh-tut-card p.wh-tut-note { color: #e4d0a0; font-size: 15px; }
.wh-tut-card .wh-tut-row { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
.wh-tut-card .wh-tut-go { min-height: 52px; height: 52px; padding: 0 26px; font-size: 18px; border-radius: 18px; pointer-events: auto; }
.wh-tut-card .wh-tut-ghost { min-height: 52px; height: 52px; padding: 0 18px; font-size: 16px; border-radius: 18px; pointer-events: auto; }
.wh-tut-bigsay { pointer-events: auto; width: 60px; height: 52px; min-width: 60px; border-radius: 18px; padding: 0; color: #e4d0a0; }
.wh-tut-bigsay .wh-ico { width: 30px; height: 30px; }
.wh-tut-bigsay.on { background: rgba(151,196,108,.28); border-color: #b8da8c; color: #fff; }
.wh-tut-skiplink { pointer-events: auto; background: none; border: 0; color: rgba(243,238,226,.7); font: inherit; font-size: 14px; text-decoration: underline; min-height: 44px; padding: 0 10px; cursor: pointer; }
.wh-tut-try { list-style: none; margin: 10px 0 4px; padding: 0; text-align: left; display: flex; flex-direction: column; gap: 6px; }
.wh-tut-try li { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 600; line-height: 1.3; color: #f6f1e4; }
.wh-tut-try li .wh-ico { flex: none; width: 24px; height: 24px; color: #b8da8c; }
.wh-tut-leaves { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 51; }
.wh-tut-leaves i { position: absolute; top: -20px; width: 14px; height: 9px; border-radius: 9px 0; background: #97c46c; animation: wh-tut-leaf 2.4s ease-in forwards; }
@keyframes wh-tut-leaf { to { transform: translate(var(--dx), 110vh) rotate(540deg); opacity: .2; } }
@media (max-height: 400px) {
  .wh-tut-logo { width: 44px; height: 44px; margin-bottom: 4px; }
  .wh-tut-logo .wh-ico { width: 28px; height: 28px; }
  .wh-tut-card { padding: 12px 18px 10px; }
  .wh-tut-card h2 { font-size: 21px; margin-bottom: 4px; }
  .wh-tut-card p { font-size: 16px; margin-bottom: 4px; }
  .wh-tut-card .wh-tut-row { margin-top: 8px; }
  .wh-tut-try { margin-top: 6px; gap: 3px; }
  .wh-tut-try li { font-size: 14px; }
}
.wh-tut-learn {
  position: absolute; z-index: 8; pointer-events: auto; height: 32px; min-height: 32px; padding: 0 12px; border-radius: 16px;
  font-size: 13px; font-weight: 700; color: #e4d0a0; background: rgba(29,42,25,.92); border: 1px solid rgba(184,218,140,.5);
}
.wh-tut-learn .wh-ico { width: 16px; height: 16px; }
.wh-tut-learn.hidden { display: none; }
.wh-ui.drawer-open .wh-tut-learn, .wh-ui.card-open .wh-tut-learn, .wh-ui.menu-open .wh-tut-learn { display: none; }
@media (prefers-reduced-motion: reduce) {
  .wh-tut-ring { animation: none; }
  .wh-tut-pop { animation: none; }
  .wh-tut-hole { transition: none; }
}
`;

let cssDone = false;
function ensureCss(): void {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  const s = document.createElement('style');
  s.id = 'wh-tutorial-css';
  s.textContent = CSS;
  document.head.append(s);
}

/** A 56 px pointing hand; its fingertip is at (18, 4). */
export const HAND_TIP = { x: 18, y: 4 };
const HAND_SVG = `<svg viewBox="0 0 56 56" aria-hidden="true"><path d="M18 4.5c-2.8 0-5 2.2-5 5v19.2l-2.6-2.6c-2-2-5.1-2-7.1 0s-2 5.1 0 7.1l11.3 12.2c2.3 2.9 5.4 4.6 9.2 4.6h9.6c6.3 0 10.6-4.8 10.6-10.6V26.2c0-2.7-2.1-4.8-4.8-4.8-1.1 0-2.1.3-2.9 1 0-2.7-2.1-4.6-4.8-4.6-1.3 0-2.6.6-3.5 1.5-.8-1.7-2.5-2.9-4.5-2.9-1 0-2 .3-2.7.8V9.5c0-2.8-2.2-5-5-5z" fill="#fff" stroke="#1d2a19" stroke-width="2.6" stroke-linejoin="round"/><path d="M23 18.6v9M30.6 19.8v8M37.7 22.8v6" stroke="#1d2a19" stroke-width="2" stroke-linecap="round" fill="none" opacity=".55"/></svg>`;

export interface BubbleContent {
  chip: string;
  title: string;
  a: string;
  w: string;
  speaker: 'on' | 'off' | 'hidden';
  buttons: { back: boolean; next: boolean; gotIt: boolean; help: boolean; skipStep: boolean };
}

export interface OverlayHandlers {
  skip(): void;
  speaker(): void;
  back(): void;
  next(): void;
  gotIt(): void;
  help(): void;
  skipStep(): void;
  learn(): void;
}

export class Overlay {
  readonly bubble: HTMLElement;
  private chip = el('span', 'wh-tut-chip');
  private title = el('span', 'wh-tut-title');
  private say: HTMLButtonElement;
  private aEl = el('div', 'wh-tut-a');
  private wEl = el('div', 'wh-tut-w');
  private foot = el('div', 'wh-tut-foot');
  private arrow = el('div', 'wh-tut-arrow hidden');
  private btns: Record<Exclude<keyof BubbleContent['buttons'], 'back'>, HTMLButtonElement>;
  /** Back sits in the header (a small arrow): the bubble stays two lines tall on most steps. */
  private backBtn: HTMLButtonElement;
  readonly hole = el('div', 'wh-tut-hole hidden');
  readonly ring = el('div', 'wh-tut-ring hidden');
  readonly hand = el('div', { class: 'wh-tut-hand hidden', html: HAND_SVG });
  readonly dots = [el('div', 'wh-tut-dot hidden'), el('div', 'wh-tut-dot hidden')];
  readonly trail = el('div', 'wh-tut-trail hidden');
  readonly ripple = el('div', 'wh-tut-ripple hidden');
  readonly learnChip: HTMLButtonElement;
  private card: HTMLElement | null = null;
  private contentKey = '';
  private footKey = '';

  constructor(
    private root: HTMLElement,
    private h: OverlayHandlers,
  ) {
    ensureCss();
    this.say = button('wh-btn-ghost wh-tut-icon wh-tut-say', 'soundOn', null, () => h.speaker(), 'Read aloud');
    const x = button('wh-btn-ghost wh-tut-icon wh-tut-x', 'close', null, () => h.skip(), 'Skip tutorial');
    this.backBtn = button('wh-btn-ghost wh-tut-icon wh-tut-back', 'chevronLeft', null, () => h.back(), BUTTONS.back);
    this.bubble = el('div', { class: 'wh-tut-bubble hidden', attrs: { role: 'status', 'aria-live': 'polite' } }, [
      el('div', 'wh-tut-head', [this.chip, this.title, this.backBtn, this.say, x]),
      this.aEl,
      this.wEl,
      this.foot,
      this.arrow,
    ]);
    this.btns = {
      help: button('wh-btn-primary wh-tut-help', 'pointer', BUTTONS.helpMe, () => h.help()),
      skipStep: button('wh-btn-ghost wh-tut-skipstep', null, BUTTONS.skipStep, () => h.skipStep()),
      next: button('wh-btn-primary wh-tut-next', 'chevronRight', BUTTONS.next, () => h.next()),
      gotIt: button('wh-btn-primary wh-tut-gotit', 'check', BUTTONS.gotIt, () => h.gotIt()),
    };
    this.learnChip = button('wh-btn-ghost wh-tut-learn hidden', 'leaf', CARDS.learnChip, () => h.learn());
    swallowPointer(this.bubble);
    swallowPointer(this.learnChip);
    root.append(this.hole, this.ring, this.bubble, this.trail, this.ripple, ...this.dots, this.hand, this.learnChip);
  }

  // ------------------------------------------------------------------ bubble
  setContent(c: BubbleContent): void {
    const key = `${c.chip}|${c.title}|${c.a}|${c.w}|${c.speaker}`;
    if (key !== this.contentKey) {
      this.contentKey = key;
      setText(this.chip, c.chip);
      setText(this.title, c.title);
      setText(this.aEl, c.a);
      setText(this.wEl, c.w);
      toggleClass(this.say, 'hidden', c.speaker === 'hidden');
      this.say.style.display = c.speaker === 'hidden' ? 'none' : '';
      toggleClass(this.say, 'off', c.speaker === 'off');
      this.say.innerHTML = icon(c.speaker === 'off' ? 'soundOff' : 'soundOn');
      this.say.setAttribute('aria-pressed', c.speaker === 'on' ? 'true' : 'false');
    }
    const b = c.buttons;
    const fk = `${b.back}${b.help}${b.skipStep}${b.next}${b.gotIt}`;
    if (fk !== this.footKey) {
      this.footKey = fk;
      this.backBtn.style.display = b.back ? '' : 'none';
      this.foot.replaceChildren(...(['help', 'skipStep', 'next', 'gotIt'] as const).filter((k) => b[k]).map((k) => this.btns[k]));
    }
  }

  showBubble(on: boolean): void {
    toggleClass(this.bubble, 'hidden', !on);
  }

  get bubbleShown(): boolean {
    return !this.bubble.classList.contains('hidden');
  }

  /** The bubble's size at a width limit (it is measured where it stands, invisibly). */
  measure(maxW?: number): { w: number; h: number } {
    const b = this.bubble;
    const mw = maxW ? `${Math.floor(maxW)}px` : '';
    if (b.style.maxWidth !== mw) b.style.maxWidth = mw;
    return { w: b.offsetWidth, h: b.offsetHeight };
  }

  place(left: number, top: number, arrow: { side: 'top' | 'bottom' | 'left' | 'right'; at: number } | null, faded: boolean, overPanel: boolean): void {
    const b = this.bubble;
    const tr = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    if (b.style.transform !== tr) b.style.transform = tr;
    toggleClass(b, 'faded', faded);
    toggleClass(b, 'over-panel', overPanel);
    const a = this.arrow;
    if (!arrow) {
      toggleClass(a, 'hidden', true);
      return;
    }
    a.className = `wh-tut-arrow ${arrow.side}`;
    if (arrow.side === 'top' || arrow.side === 'bottom') {
      a.style.left = `${Math.round(arrow.at - 9)}px`;
      a.style.top = '';
    } else {
      a.style.top = `${Math.round(arrow.at - 9)}px`;
      a.style.left = '';
    }
  }

  bubbleRect(): Rect {
    const r = this.bubble.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }

  // ------------------------------------------------------------------ hole and ring
  setHole(r: Rect | null): void {
    const h = this.hole;
    if (!r) {
      toggleClass(h, 'hidden', true);
      return;
    }
    toggleClass(h, 'hidden', false);
    const p = 6;
    setPx(h, 'left', r.left - p);
    setPx(h, 'top', r.top - p);
    setPx(h, 'width', r.right - r.left + p * 2);
    setPx(h, 'height', r.bottom - r.top + p * 2);
  }

  setRing(r: Rect | null, radius = 16, overPanel = false): void {
    const g = this.ring;
    if (!r) {
      toggleClass(g, 'hidden', true);
      return;
    }
    toggleClass(g, 'hidden', false);
    toggleClass(g, 'over-panel', overPanel);
    const p = 5;
    setPx(g, 'left', r.left - p);
    setPx(g, 'top', r.top - p);
    setPx(g, 'width', r.right - r.left + p * 2);
    setPx(g, 'height', r.bottom - r.top + p * 2);
    const br = `${Math.round(radius + 4)}px`;
    if (g.style.borderRadius !== br) g.style.borderRadius = br;
  }

  // ------------------------------------------------------------------ hand
  /** Put the hand's fingertip at (x, y) with a press scale and opacity. */
  handAt(x: number, y: number, scale = 1, opacity = 1): void {
    toggleClass(this.hand, 'hidden', opacity <= 0.01);
    const tr = `translate(${(x - HAND_TIP.x).toFixed(1)}px, ${(y - HAND_TIP.y).toFixed(1)}px) scale(${scale.toFixed(3)})`;
    this.hand.style.transform = tr;
    this.hand.style.transformOrigin = `${HAND_TIP.x}px ${HAND_TIP.y}px`;
    this.hand.style.opacity = opacity.toFixed(2);
  }

  dotsAt(pts: { x: number; y: number }[] | null, opacity = 1): void {
    this.dots.forEach((d, i) => {
      const p = pts?.[i];
      toggleClass(d, 'hidden', !p || opacity <= 0.01);
      if (!p) return;
      d.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      d.style.opacity = opacity.toFixed(2);
    });
  }

  trailFrom(a: { x: number; y: number } | null, b?: { x: number; y: number }, opacity = 1): void {
    const t = this.trail;
    if (!a || !b) {
      toggleClass(t, 'hidden', true);
      return;
    }
    toggleClass(t, 'hidden', false);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    t.style.width = `${len.toFixed(1)}px`;
    t.style.transform = `translate(${a.x.toFixed(1)}px, ${(a.y - 2).toFixed(1)}px) rotate(${ang.toFixed(4)}rad)`;
    t.style.opacity = opacity.toFixed(2);
  }

  rippleAt(p: { x: number; y: number } | null, k = 0): void {
    const r = this.ripple;
    if (!p) {
      toggleClass(r, 'hidden', true);
      return;
    }
    toggleClass(r, 'hidden', false);
    r.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) scale(${(0.5 + k).toFixed(3)})`;
    r.style.opacity = Math.max(0, 1 - k).toFixed(2);
  }

  hideHand(): void {
    toggleClass(this.hand, 'hidden', true);
    this.dotsAt(null);
    this.trailFrom(null);
    this.rippleAt(null);
  }

  // ------------------------------------------------------------------ pops
  pop(text: string, x: number, y: number): void {
    const p = el('div', { class: 'wh-tut-pop', text });
    p.style.left = `${Math.round(x)}px`;
    p.style.top = `${Math.round(y)}px`;
    this.root.append(p);
    setTimeout(() => p.remove(), 1200);
  }

  leafBurst(): void {
    const box = el('div', 'wh-tut-leaves');
    for (let i = 0; i < 26; i++) {
      const leaf = el('i');
      leaf.style.left = `${Math.round(Math.random() * 100)}%`;
      leaf.style.animationDelay = `${(Math.random() * 0.6).toFixed(2)}s`;
      leaf.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 160)}px`);
      leaf.style.background = ['#97c46c', '#b8da8c', '#e4d0a0', '#6f9f4a'][i % 4];
      box.append(leaf);
    }
    this.root.append(box);
    setTimeout(() => box.remove(), 3300);
  }

  // ------------------------------------------------------------------ cards
  get cardOpen(): boolean {
    return !!this.card;
  }

  /** The welcome card: title, text, Let's go, a big speaker toggle (when a voice exists) and a small Skip. */
  showWelcome(o: { title: string; text: string; note?: string; speaker: 'on' | 'off' | 'hidden'; go(): void; skip(): void; speakerToggle(): void }): void {
    this.hideCard();
    const say = button(`wh-btn-ghost wh-tut-bigsay ${o.speaker === 'on' ? 'on' : ''}`, o.speaker === 'off' ? 'soundOff' : 'soundOn', null, () => o.speakerToggle(), 'Read aloud');
    say.setAttribute('aria-pressed', o.speaker === 'on' ? 'true' : 'false');
    if (o.speaker === 'hidden') say.style.display = 'none';
    const go = button('wh-btn-primary wh-tut-go', null, BUTTONS.letsGo, () => o.go());
    const skip = el('button', { class: 'wh-tut-skiplink', text: BUTTONS.skipLink, attrs: { type: 'button' }, onClick: () => o.skip() });
    this.showCard([
      el('div', { class: 'wh-tut-logo', html: icon('leaf') }),
      el('h2', { text: o.title }),
      el('p', { text: o.text }),
      o.note ? el('p', { class: 'wh-tut-note', text: o.note }) : null,
      el('div', 'wh-tut-row', [say, go]),
      el('div', 'wh-tut-row wh-tut-row-skip', [skip]),
    ], 'wh-tut-welcome', o.title);
    go.focus({ preventScroll: true });
  }

  setWelcomeSpeaker(state: 'on' | 'off' | 'hidden'): void {
    const b = this.card?.querySelector<HTMLButtonElement>('.wh-tut-bigsay');
    if (!b) return;
    b.style.display = state === 'hidden' ? 'none' : '';
    toggleClass(b, 'on', state === 'on');
    b.innerHTML = icon(state === 'off' ? 'soundOff' : 'soundOn');
    b.setAttribute('aria-pressed', state === 'on' ? 'true' : 'false');
  }

  /** The finish card: "You did it!", the line, three try-next rows and the buttons. */
  showFinish(o: { text: string; rows: { icon: IconName; text: string }[]; buttons: { label: string; primary: boolean; run(): void }[] }): void {
    this.hideCard();
    const btns = o.buttons.map((b) => button(b.primary ? 'wh-btn-primary wh-tut-go' : 'wh-btn-ghost wh-tut-ghost', null, b.label, () => b.run()));
    this.showCard([
      el('div', { class: 'wh-tut-logo', html: icon('trophy') }),
      el('h2', { text: CARDS.finishTitle }),
      el('p', { text: o.text }),
      el('ul', { class: 'wh-tut-try', html: o.rows.map((r) => `<li>${icon(r.icon)}<span>${escapeHtml(r.text)}</span></li>`).join('') }),
      el('div', 'wh-tut-row', btns),
    ], 'wh-tut-finish', CARDS.finishTitle);
    btns.find((_, i) => o.buttons[i].primary)?.focus({ preventScroll: true });
  }

  private showCard(children: (HTMLElement | null)[], cls: string, label: string): void {
    const card = el('div', `wh-tut-card ${cls}`, children);
    const back = el('div', { class: 'wh-tut-cardback', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': label } }, [card]);
    swallowPointer(back);
    this.root.append(back);
    this.card = back;
  }

  hideCard(): void {
    this.card?.remove();
    this.card = null;
  }

  /** The card's primary button (Android back / Enter press it). */
  cardPrimary(): HTMLButtonElement | null {
    return this.card?.querySelector<HTMLButtonElement>('.wh-tut-go') ?? null;
  }

  // ------------------------------------------------------------------ learn chip
  placeLearn(at: { left: number; top: number } | null): void {
    const c = this.learnChip;
    toggleClass(c, 'hidden', !at);
    if (!at) return;
    setPx(c, 'left', at.left);
    setPx(c, 'top', at.top);
  }

  dispose(): void {
    for (const e of [this.hole, this.ring, this.bubble, this.trail, this.ripple, ...this.dots, this.hand, this.learnChip]) e.remove();
    this.hideCard();
  }
}

function setPx(e: HTMLElement, prop: 'left' | 'top' | 'width' | 'height', v: number): void {
  const s = `${Math.round(v)}px`;
  if (e.style[prop] !== s) e.style[prop] = s;
}
