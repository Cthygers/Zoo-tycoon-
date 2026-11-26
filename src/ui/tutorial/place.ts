// Where the tutorial's bubble goes (tutorial.md §6.2): pure, so it is unit-tested against the
// layouts measured at 915×412 and 800×360 (tests/tutorial-place.test.ts). The rule that
// matters most for children: the bubble never covers the thing it points at.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type PlaceZone = 'dock' | 'drawer' | 'confirm' | 'hud' | 'sheet' | 'panel' | 'world' | 'gesture';

export interface PlaceInput {
  vw: number;
  vh: number;
  /** Inside the gutters / safe area. */
  safe: Rect;
  /** Measured bubble size. */
  size: { w: number; h: number };
  /** Screen rect of the target (DOM rect, or the projected world marker). */
  target: Rect | null;
  zone: PlaceZone;
  /** The 3D view the HUD leaves free (GameUI.viewArea()). */
  view: Rect;
  /** The top bar. */
  hud: Rect;
  /** Things the bubble must not cover (tool bar, confirm bar, sheet, dock bar…). */
  obstacles: Rect[];
  /** drawer: the drawer; confirm: the confirm bar; sheet: the info sheet. */
  container?: Rect | null;
  /** panel: the zoo menu's title-row gap. */
  gap?: { x0: number; x1: number; top: number } | null;
  /** world: what the bubble should stay off (the marker plus the hand's drag path, or the work rect);
   *  other zones: kept clear of it when a candidate allows (what is being built). */
  avoid?: Rect | null;
}

export interface PlaceResult {
  left: number;
  top: number;
  arrow: { side: 'top' | 'bottom' | 'left' | 'right'; at: number } | null;
  docked: boolean;
  faded: boolean;
  /** Narrowed to this width (the caller re-measures the height). */
  maxW?: number;
  /** Which candidate won (for tests and debugging). */
  how: string;
  ok: boolean;
}

export const TARGET_GAP = 8;
const ARROW_GAP = 12;
const ARROW_INSET = 14;
const MIN_NARROW_W = 220;

export function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function inflate(r: Rect, n: number): Rect {
  return { left: r.left - n, top: r.top - n, right: r.right + n, bottom: r.bottom + n };
}

export function union(a: Rect, b: Rect): Rect {
  return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.max(lo, Math.min(hi, v)));

interface Cand {
  how: string;
  left: number;
  top: number;
  w: number;
  h: number;
  arrow: PlaceResult['arrow'];
  maxW?: number;
  /** Rules this candidate may break (the drawer's may cover the top bar). */
  coverHud?: boolean;
}

/** Arrow on a horizontal edge pointing at x (null when the point is out of the arrow's reach). */
function hArrow(side: 'top' | 'bottom', left: number, w: number, x: number): PlaceResult['arrow'] {
  const at = x - left;
  if (at < ARROW_INSET - 6 || at > w - ARROW_INSET + 6) return null;
  return { side, at: clamp(at, ARROW_INSET, w - ARROW_INSET) };
}

function vArrow(side: 'left' | 'right', top: number, h: number, y: number): PlaceResult['arrow'] {
  const at = y - top;
  if (at < ARROW_INSET - 6 || at > h - ARROW_INSET + 6) return null;
  return { side, at: clamp(at, ARROW_INSET, h - ARROW_INSET) };
}

function rectOf(c: Cand): Rect {
  return { left: c.left, top: c.top, right: c.left + c.w, bottom: c.top + c.h };
}

export function placeBubble(i: PlaceInput): PlaceResult {
  const { safe, view } = i;
  let { w, h } = i.size;
  const t = i.target;
  const cands: Cand[] = [];
  const cx = t ? (t.left + t.right) / 2 : (view.left + view.right) / 2;
  const cy = t ? (t.top + t.bottom) / 2 : (view.top + view.bottom) / 2;
  const clampX = (x: number, ww = w) => clamp(x, safe.left, safe.right - ww);
  const clampY = (y: number, hh = h, lo = safe.top, hi = safe.bottom) => clamp(y, lo, hi - hh);
  const push = (how: string, left: number, top: number, arrow: PlaceResult['arrow'], extra: Partial<Cand> = {}) =>
    cands.push({ how, left: Math.round(left), top: Math.round(top), w: extra.w ?? w, h: extra.h ?? h, arrow, ...extra });

  switch (i.zone) {
    case 'gesture': {
      const left = clampX((view.left + view.right) / 2 - w / 2);
      return finish({ how: 'gesture-top', left: Math.round(left), top: Math.round(view.top + 6), w, h, arrow: null }, false);
    }
    case 'world': {
      const top = Math.max(safe.top, view.top + 6);
      const a = { how: 'world-left', left: Math.round(clampX(view.left)), top: Math.round(top), w, h, arrow: null } as Cand;
      const b = { how: 'world-right', left: Math.round(clampX(view.right - w)), top: Math.round(top), w, h, arrow: null } as Cand;
      const avoid = i.avoid ?? t;
      const cost = (c: Cand) => (avoid ? overlapArea(inflate(rectOf(c), TARGET_GAP), avoid) : 0) + i.obstacles.reduce((s, o) => s + overlapArea(rectOf(c), o), 0);
      const ca = cost(a),
        cb = cost(b);
      const best = ca <= cb ? a : b;
      return finish(best, Math.min(ca, cb) > 0, true);
    }
    case 'dock': {
      if (!t) break;
      const above = t.top - ARROW_GAP - h;
      const l0 = clampX(cx - w / 2);
      push('dock-above', l0, above, hArrow('bottom', l0, w, cx));
      // shifted sideways (the arrow stays on the button while it can)
      for (const dx of [-w / 3, w / 3, -w / 2 + ARROW_INSET + 4, w / 2 - ARROW_INSET - 4]) {
        const l = clampX(cx - w / 2 + dx);
        push('dock-above-shift', l, above, hArrow('bottom', l, w, cx));
      }
      // beside the button
      push('dock-left', t.left - ARROW_GAP - w, clampY(cy - h / 2), vArrow('right', clampY(cy - h / 2), h, cy));
      push('dock-right', t.right + ARROW_GAP, clampY(cy - h / 2), vArrow('left', clampY(cy - h / 2), h, cy));
      break;
    }
    case 'drawer': {
      if (!t) break;
      const d = i.container ?? t;
      const l0 = clampX(cx - w / 2);
      // above the drawer: may cover the top bar (it is not needed while choosing)
      push('drawer-above', l0, d.top - ARROW_GAP - h, hArrow('bottom', l0, w, cx), { coverHud: true });
      // as high as it may go, over the drawer's title row
      push('drawer-title', l0, Math.max(safe.top, t.top - ARROW_GAP - h), hArrow('bottom', l0, w, cx), { coverHud: true });
      // narrowed beside the card (old tour: beside the tool bar)
      const roomL = t.left - ARROW_GAP - safe.left;
      const roomR = safe.right - t.right - ARROW_GAP;
      for (const [room, side] of [
        [roomL, 'left'],
        [roomR, 'right'],
      ] as const) {
        if (room < MIN_NARROW_W) continue;
        const nw = Math.min(w, room);
        const nh = Math.round((h * w) / nw);
        const top = clampY(cy - nh / 2, nh);
        const left = side === 'left' ? t.left - ARROW_GAP - nw : t.right + ARROW_GAP;
        push(`drawer-${side}`, left, top, vArrow(side === 'left' ? 'right' : 'left', top, nh, cy), { w: nw, h: nh, maxW: nw < w ? nw : undefined, coverHud: true });
      }
      break;
    }
    case 'confirm': {
      if (!t) break;
      const bar = i.container ?? t;
      const above = bar.top - ARROW_GAP - h;
      const l0 = clampX(cx - w / 2);
      push('confirm-above', l0, above, hArrow('bottom', l0, w, cx));
      push('confirm-above-left', clampX(bar.left), above, hArrow('bottom', clampX(bar.left), w, cx));
      push('confirm-above-right', clampX(bar.right - w), above, hArrow('bottom', clampX(bar.right - w), w, cx));
      // beside the Build button, above the bar's right end (clear of a big preview in the middle)
      push('confirm-right', clampX(t.right - w), above, hArrow('bottom', clampX(t.right - w), w, cx));
      break;
    }
    case 'hud': {
      if (!t) break;
      const l0 = clampX(cx - w / 2);
      push('hud-below', l0, t.bottom + ARROW_GAP, hArrow('top', l0, w, cx));
      const top = clampY(cy - h / 2);
      push('hud-right', t.right + ARROW_GAP, top, vArrow('left', top, h, cy));
      push('hud-left', t.left - ARROW_GAP - w, top, vArrow('right', top, h, cy));
      // below, further down (clear of the pill or a toast)
      push('hud-below-far', l0, t.bottom + ARROW_GAP + 56, null);
      break;
    }
    case 'sheet': {
      if (!t) break;
      const sh = i.container ?? t;
      const top = clampY(cy - h / 2, h, Math.max(safe.top, view.top), Math.min(safe.bottom, view.bottom));
      push('sheet-left', sh.left - ARROW_GAP - w, top, vArrow('right', top, h, cy));
      const room = sh.left - ARROW_GAP - safe.left;
      if (room >= MIN_NARROW_W && room < w) {
        const nh = Math.round((h * w) / room);
        const nt = clampY(cy - nh / 2, nh, Math.max(safe.top, view.top), Math.min(safe.bottom, view.bottom));
        push('sheet-left-narrow', sh.left - ARROW_GAP - room, nt, vArrow('right', nt, nh, cy), { w: room, h: nh, maxW: room });
      }
      // above / below the target, left-aligned with the sheet's left part
      const la = clampX(sh.left - w / 2);
      push('sheet-below', la, t.bottom + ARROW_GAP, hArrow('top', la, w, cx));
      push('sheet-above', la, t.top - ARROW_GAP - h, hArrow('bottom', la, w, cx));
      break;
    }
    case 'panel': {
      const g = i.gap;
      if (g) {
        const room = g.x1 - g.x0;
        if (room >= w) push('panel-gap', clamp((g.x0 + g.x1) / 2 - w / 2, g.x0, g.x1 - w), g.top, null);
        else if (room >= MIN_NARROW_W) {
          const nh = Math.round((h * w) / room);
          push('panel-gap-narrow', g.x0, g.top, null, { w: room, h: nh, maxW: room });
        }
      }
      const l0 = clampX((safe.left + safe.right) / 2 - w / 2);
      push('panel-bottom', l0, safe.bottom - h - 4, null);
      push('panel-top', l0, safe.top, null);
      if (t) {
        const l1 = clampX(t.right + ARROW_GAP);
        push('panel-beside', l1, clampY(cy - h / 2), vArrow('left', clampY(cy - h / 2), h, cy));
      }
      break;
    }
  }

  const fits = (c: Cand): boolean => {
    const r = rectOf(c);
    if (r.left < safe.left - 0.5 || r.right > safe.right + 0.5 || r.top < safe.top - 0.5 || r.bottom > safe.bottom + 0.5) return false;
    if (t && intersects(r, inflate(t, TARGET_GAP))) return false;
    if (!c.coverHud && intersects(r, i.hud)) return false;
    return i.obstacles.every((o) => !intersects(r, o));
  };
  // what is being built (soft): first a spot clear of it too, then any spot that fits
  const soft = i.avoid ?? null;
  if (soft) for (const c of cands) if (fits(c) && !intersects(rectOf(c), soft)) return finish(c, false);
  for (const c of cands) if (fits(c)) return finish(c, false);
  // nothing fits: the candidate covering the target least, kept inside the safe area
  const fallback = cands.length
    ? cands
        .map((c) => {
          const cc = { ...c, left: clampX(c.left, c.w), top: clampY(c.top, c.h) };
          const r = rectOf(cc);
          return { c: cc, cost: (t ? overlapArea(r, inflate(t, TARGET_GAP)) * 4 : 0) + i.obstacles.reduce((s, o) => s + overlapArea(r, o), 0) };
        })
        .sort((a, b) => a.cost - b.cost)[0].c
    : { how: 'none', left: clampX(view.left), top: Math.max(safe.top, view.top + 6), w, h, arrow: null };
  return { ...finish(fallback, false), ok: false };

  function finish(c: Cand, faded: boolean, docked = false): PlaceResult {
    w = c.w;
    h = c.h;
    return { left: c.left, top: c.top, arrow: c.arrow, docked, faded, maxW: c.maxW, how: c.how, ok: true };
  }
}

/** The rect a placed bubble covers. */
export function placedRect(p: PlaceResult, size: { w: number; h: number }): Rect {
  return { left: p.left, top: p.top, right: p.left + size.w, bottom: p.top + size.h };
}
