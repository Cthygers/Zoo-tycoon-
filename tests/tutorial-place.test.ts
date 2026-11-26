// Bubble placement (tutorial.md §6.2, §11.1) against the layouts measured in the running game
// at 915×412 and 800×360 (tutorial.md Appendix A), with bubbles of 300×94 and 320×140: inside
// the safe area, never touching its target (+8 px) or an obstacle, the arrow on the target.
import { describe, expect, it } from 'vitest';
import { inflate, intersects, placeBubble, type PlaceInput, type PlaceZone, type Rect } from '../src/ui/tutorial/place';

const R = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });

interface Layout {
  vw: number;
  vh: number;
  hud: Rect;
  money: Rect;
  speed: Rect;
  pill: Rect;
  cats: Rect;
  catsWithSheet: Rect;
  drawer: Rect;
  toolbar: Rect;
  confirm: Rect;
  sheet: Rect;
  meter: Rect;
  view: Rect;
}

// Appendix A (q=low, seed 7); dock buttons are 1/8 of the category bar; the pill sits under the top bar
const L915: Layout = {
  vw: 915, vh: 412,
  hud: R(10, 8, 905, 54), money: R(10, 9, 128, 53), speed: R(677, 8, 851, 54), pill: R(10, 62, 292, 106),
  cats: R(182, 338, 734, 404), catsWithSheet: R(55, 338, 511, 404),
  drawer: R(10, 153, 905, 330), toolbar: R(188, 267, 727, 330), confirm: R(139, 267, 776, 330),
  sheet: R(566, 62, 905, 404), meter: R(576, 122, 729, 152), view: R(10, 54, 905, 338),
};
const L800: Layout = {
  vw: 800, vh: 360,
  hud: R(10, 8, 790, 54), money: R(10, 9, 128, 53), speed: R(562, 8, 736, 54), pill: R(10, 62, 280, 106),
  cats: R(124, 294, 676, 352), catsWithSheet: R(10, 294, 460, 352),
  drawer: R(10, 133, 790, 288), toolbar: R(133, 227, 667, 288), confirm: R(110, 231, 690, 286),
  sheet: R(471, 62, 790, 352), meter: R(481, 122, 624, 152), view: R(10, 54, 790, 294),
};
const SIZES = [
  { w: 300, h: 94 },
  { w: 320, h: 140 },
];

const catButton = (l: Layout, i: number) => {
  const w = (l.cats.right - l.cats.left) / 8;
  return R(l.cats.left + i * w + 3, l.cats.top + 5, l.cats.left + (i + 1) * w - 3, l.cats.bottom - 5);
};
const card = (l: Layout, i: number) => R(l.drawer.left + 40 + i * 100, l.drawer.top + 41, l.drawer.left + 132 + i * 100, l.drawer.bottom - 9);
const speedBtn = (l: Layout, s: number) => {
  const w = (l.speed.right - l.speed.left - 6) / 4;
  return R(l.speed.left + 3 + s * w, l.speed.top + 4, l.speed.left + 3 + (s + 1) * w, l.speed.bottom - 4);
};
const buildBtn = (l: Layout) => R(l.confirm.right - 96, l.confirm.top + 6, l.confirm.right - 6, l.confirm.bottom - 6);

function base(l: Layout, size: { w: number; h: number }, zone: PlaceZone, target: Rect | null, extra: Partial<PlaceInput> = {}): PlaceInput {
  return { vw: l.vw, vh: l.vh, safe: R(10, 8, l.vw - 10, l.vh - 8), size, target, zone, view: l.view, hud: l.hud, obstacles: [], ...extra };
}

function expectGood(i: PlaceInput, label: string): ReturnType<typeof placeBubble> {
  const p = placeBubble(i);
  const w = p.maxW ?? i.size.w;
  const h = p.maxW ? Math.round((i.size.h * i.size.w) / p.maxW) : i.size.h;
  const r = R(p.left, p.top, p.left + w, p.top + h);
  expect(p.ok, `${label}: a candidate fits (${p.how})`).toBe(true);
  expect(r.left, `${label} left`).toBeGreaterThanOrEqual(i.safe.left - 0.5);
  expect(r.top, `${label} top`).toBeGreaterThanOrEqual(i.safe.top - 0.5);
  expect(r.right, `${label} right`).toBeLessThanOrEqual(i.safe.right + 0.5);
  expect(r.bottom, `${label} bottom`).toBeLessThanOrEqual(i.safe.bottom + 0.5);
  if (i.target) expect(intersects(r, inflate(i.target, 8)), `${label}: clear of the target (${p.how})`).toBe(false);
  for (const o of i.obstacles) expect(intersects(r, o), `${label}: clear of obstacle ${JSON.stringify(o)} (${p.how})`).toBe(false);
  if (p.arrow && i.target) {
    const t = i.target;
    if (p.arrow.side === 'top' || p.arrow.side === 'bottom') expect(Math.abs(p.left + p.arrow.at - (t.left + t.right) / 2), `${label} arrow x`).toBeLessThanOrEqual(14);
    else expect(Math.abs(p.top + p.arrow.at - (t.top + t.bottom) / 2), `${label} arrow y`).toBeLessThanOrEqual(14);
  }
  return p;
}

describe('tutorial bubble placement', () => {
  for (const [name, l] of [
    ['915x412', L915],
    ['800x360', L800],
  ] as const) {
    for (const size of SIZES) {
      const tag = `${name} ${size.w}x${size.h}`;
      describe(tag, () => {
        it('dock: above every category button, arrow down on it', () => {
          for (let i = 1; i < 8; i++) {
            const p = expectGood(base(l, size, 'dock', catButton(l, i), { obstacles: [] }), `${tag} dock ${i}`);
            expect(p.arrow?.side).toBe('bottom');
            expect(p.top + size.h).toBeLessThanOrEqual(l.cats.top);
          }
        });

        it('drawer: above the drawer with the arrow on the card (first, middle and last card)', () => {
          // the last card in full view (revealCard scrolls the step's card into view first)
          const last = Math.floor((l.drawer.right - l.drawer.left - 132) / 100);
          for (const i of [0, 3, last]) {
            const p = expectGood(base(l, size, 'drawer', card(l, i), { container: l.drawer }), `${tag} card ${i}`);
            expect(p.arrow?.side).toBe('bottom');
          }
        });

        it('confirm: above the confirm bar, arrow on Build', () => {
          const p = expectGood(base(l, size, 'confirm', buildBtn(l), { container: l.confirm }), `${tag} confirm`);
          expect(p.top + size.h).toBeLessThanOrEqual(l.confirm.top);
          expect(p.arrow?.side).toBe('bottom');
          expect(p.top).toBeGreaterThanOrEqual(l.hud.bottom); // the top bar stays visible here
        });

        it('hud: below the money chip, the Play button, the fast buttons and the goal pill', () => {
          for (const [what, t] of [
            ['money', l.money],
            ['play', speedBtn(l, 1)],
            ['fast', R(speedBtn(l, 2).left, speedBtn(l, 2).top, speedBtn(l, 3).right, speedBtn(l, 3).bottom)],
            ['group', l.speed],
          ] as const) {
            const p = expectGood(base(l, size, 'hud', t, { obstacles: [l.cats] }), `${tag} hud ${what}`);
            expect(p.arrow?.side, what).toBe('top');
          }
          expectGood(base(l, size, 'hud', l.pill, { obstacles: [l.cats] }), `${tag} hud pill`);
        });

        it('sheet: left of the sheet, arrow right on the happiness meter and on the close button', () => {
          const p = expectGood(base(l, size, 'sheet', l.meter, { container: l.sheet, obstacles: [l.catsWithSheet] }), `${tag} meter`);
          expect(p.arrow?.side).toBe('right');
          expect(p.left + size.w).toBeLessThanOrEqual(l.sheet.left);
          const close = R(l.sheet.right - 52, l.sheet.top + 6, l.sheet.right - 8, l.sheet.top + 50);
          expectGood(base(l, size, 'sheet', close, { container: l.sheet, obstacles: [l.catsWithSheet] }), `${tag} sheet close`);
        });

        it('panel: in the menu title gap, clear of the close button and the Finances tab', () => {
          const close = R(l.vw - 60, 14, l.vw - 16, 58);
          const gap = { x0: 200, x1: l.vw - 70, top: 16 };
          expectGood(base(l, size, 'panel', close, { gap }), `${tag} panel close`);
          const tab = R(24, 70, 170, 114);
          expectGood(base(l, size, 'panel', tab, { gap }), `${tag} panel tab`);
        });

        it('gesture: top centre of the view', () => {
          const p = placeBubble(base(l, size, 'gesture', null));
          expect(p.top).toBe(l.view.top + 6);
          expect(Math.abs(p.left + size.w / 2 - (l.view.left + l.view.right) / 2)).toBeLessThanOrEqual(1);
        });

        it('world: docks in the top corner away from the work, fades when both corners are covered', () => {
          const leftWork = R(l.view.left + 20, l.view.top + 10, l.view.left + 300, l.view.bottom - 30);
          const a = placeBubble(base(l, size, 'world', null, { avoid: leftWork }));
          expect(a.docked).toBe(true);
          expect(a.how).toBe('world-right');
          expect(a.faded).toBe(false);
          expect(intersects(R(a.left, a.top, a.left + size.w, a.top + size.h), leftWork)).toBe(false);
          const rightWork = R(l.view.right - 300, l.view.top + 10, l.view.right - 20, l.view.bottom - 30);
          const b = placeBubble(base(l, size, 'world', null, { avoid: rightWork }));
          expect(b.how).toBe('world-left');
          expect(b.faded).toBe(false);
          const both = R(l.view.left, l.view.top, l.view.right, l.view.bottom);
          const c = placeBubble(base(l, size, 'world', null, { avoid: both }));
          expect(c.faded).toBe(true);
        });
      });
    }
  }

  it('800x360: the drawer step may cover the top bar (the HUD-cover allowance)', () => {
    const l = L800;
    const p = placeBubble(base(l, { w: 320, h: 140 }, 'drawer', card(l, 2), { container: l.drawer }));
    expect(p.ok).toBe(true);
    expect(p.top).toBeLessThan(l.hud.bottom); // over the top bar
    expect(p.top + 140).toBeLessThanOrEqual(card(l, 2).top - 8);
    // a 2-line bubble also fits above the drawer, still over the HUD
    const q = placeBubble(base(l, { w: 300, h: 94 }, 'drawer', card(l, 2), { container: l.drawer }));
    expect(q.how).toBe('drawer-above');
    expect(q.top).toBeLessThan(l.hud.bottom);
  });

  it('800x360 sheet step: the measured case of tutorial.md §6.2 fits left of the sheet, clear of dock and top bar', () => {
    const l = L800;
    const p = placeBubble(base(l, { w: 320, h: 140 }, 'sheet', l.meter, { container: l.sheet, obstacles: [l.catsWithSheet] }));
    expect(p.how).toBe('sheet-left');
    expect(p.left).toBe(l.sheet.left - 12 - 320);
    expect(p.top).toBeGreaterThanOrEqual(l.hud.bottom);
    expect(p.top + 140).toBeLessThanOrEqual(l.catsWithSheet.top);
  });

  it('nothing fits: the least-covering spot inside the safe area, reported as not ok', () => {
    const l = L800;
    const huge = R(10, 8, 790, 352);
    const p = placeBubble(base(l, { w: 320, h: 140 }, 'hud', huge));
    expect(p.ok).toBe(false);
    expect(p.left).toBeGreaterThanOrEqual(10);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
});
