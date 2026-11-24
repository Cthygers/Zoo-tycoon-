// First-run guidance:
//  * the "next goal" pill under the top bar: the first open objective; a tap opens the
//    build category that achieves it (or the Goals tab);
//  * a five-step coach-mark tour for a new zoo (fence a habitat → paint its ground →
//    adopt an animal → connect a path → hire a keeper). A bubble points at the dock
//    button, then the card; while a tool is in hand it docks, compact, in a top corner
//    of the view away from what is being built. A finished step puts its tool away;
//  * how many times build mode was entered, so the tool bar can teach the camera
//    gesture for the first few uses.
// Progress lives in localStorage (best effort: without storage the tour simply shows again).

import type { GoalProgress, ISimulation } from '../core/contracts';
import type { Objective, Tool } from '../core/types';
import type { CategoryId } from './catalog';
import { button, el, fmtMoney, setText, storageGet, storageSet, swallowPointer, toggleClass, type ScreenRect } from './dom';
import { icon } from './icons';

/** 'done' once the tour was finished or skipped, else the number of steps reached so far. */
const TOUR_KEY = 'wildhaven-tour';
const BUILD_USES_KEY = 'wildhaven-build-uses';
/** Build-mode entries that still show the camera tip on the tool bar. */
const CAMERA_TIP_USES = 5;
/** Seconds between bubble re-anchors (a handful of layout reads, only while the tour runs). */
const ANCHOR_EVERY = 0.12;
/** Gap (px) between the docked bubble and the top bar, and around what is being built. */
const DOCK_GAP = 6;
/** Narrowest bubble (px) that may sit beside a tool bar. */
const MIN_SIDE_W = 150;
/** How far (px) a bubble beside the tool bar may reach into the drawer: its top padding, not the title row. */
const DRAWER_PAD = 8;

/** Build category that works towards an objective (others open the Goals tab). */
const GOAL_CATEGORY: Record<string, CategoryId> = {
  build_habitat: 'habitats',
  first_animal: 'animals',
  hire_keeper: 'staff',
  food_stand: 'guest',
  restrooms: 'guest',
  species_3: 'animals',
  species_6: 'animals',
  species_10: 'animals',
};

/**
 * A goal's progress the way the goal states its target: "141 / 150", "$84,016 / $100,000",
 * "62% / 75%" (or the sim's note while there is nothing to measure yet).
 */
export function goalProgressText(goal: Pick<Objective, 'text'>, p: GoalProgress): string {
  if (p.waiting) return p.waiting;
  const money = goal.text.includes(fmtMoney(p.target));
  const pct = new RegExp(`(^|\\D)${p.target}%`).test(goal.text);
  const f = (v: number) => (money ? fmtMoney(v) : `${v.toLocaleString('en-US')}${pct ? '%' : ''}`);
  return `${f(p.current)} / ${f(p.target)}`;
}

/** Share of a goal reached, 0..1. */
export function goalFraction(p: GoalProgress): number {
  return p.target > 0 && !p.waiting ? Math.max(0, Math.min(1, p.current / p.target)) : 0;
}

/** The goal as the pill words it: without its parenthesised how-to, and (`short`) without the leading verb. */
export function pillGoalText(text: string, short: boolean): string {
  const t = text.replace(/\s*\(.*\)\s*$/, '');
  if (!short) return t;
  const rest = t.replace(/^(Welcome|Have|Reach|Exhibit|Build|Hire|Adopt|Make|Get)\s+/, '');
  return rest[0].toUpperCase() + rest.slice(1);
}

/** Area (px²) two screen rects share, with `gap` added around the first. */
function overlapArea(a: ScreenRect, b: ScreenRect, gap: number): number {
  const w = Math.min(a.right + gap, b.right) - Math.max(a.left - gap, b.left);
  const h = Math.min(a.bottom + gap, b.bottom) - Math.max(a.top - gap, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

interface TourStep {
  title: string;
  cat: CategoryId;
  /** The catalogue card to point at once the category is open. */
  card(key: string): boolean;
  tool(t: Tool): boolean;
  /** Bubble text: category closed / category open / tool in hand / confirm bar up. */
  open: string;
  pick: string;
  use: string;
  confirm: string;
  done(sim: ISimulation, painted: boolean): boolean;
}

const STEPS: TourStep[] = [
  {
    title: 'Fence a habitat',
    cat: 'habitats',
    card: (k) => k === 'fence:1',
    tool: (t) => t.kind === 'fence',
    open: 'Animals live in fenced habitats. Tap Habitat to build one.',
    pick: 'Pick a fence: timber rails suit grazers.',
    // about 64 tiles: room for the smallest herd of any grazer a timber fence holds (3 zebras need 60)
    use: 'Drag about 8×8 tiles of open grass, room for a small herd. Keep paths outside it.',
    confirm: 'Tap Build to put the fence up.',
    done: (sim) => sim.world.habitats.size > 0,
  },
  {
    title: 'Shape the ground',
    cat: 'habitats',
    card: (k) => k === 'terrain:1',
    tool: (t) => t.kind === 'terrain',
    open: 'Each species likes its own ground. Tap Habitat again.',
    pick: 'Pick a ground type, e.g. Savanna Grass.',
    use: 'Drag inside your habitat to paint it.',
    confirm: 'Tap Paint to apply it.',
    done: (_sim, painted) => painted,
  },
  {
    title: 'Adopt an animal',
    cat: 'animals',
    card: (k) => k.startsWith('animal:'),
    tool: (t) => t.kind === 'animal',
    open: 'Time for residents. Tap Animals.',
    pick: 'Choose a species; its card shows its needs.',
    use: 'Tap inside your habitat to check how well it suits them.',
    confirm: 'Tap Adopt to bring it home.',
    done: (sim) => sim.animals.size > 0,
  },
  {
    title: 'Connect a path',
    cat: 'paths',
    card: (k) => k.startsWith('path:'),
    tool: (t) => t.kind === 'path',
    // the gate stays shut until guests can see an animal from a path
    open: 'Guests come once a path lets them see your animals. Tap Paths.',
    pick: 'Pick a path type.',
    use: 'Drag a path from the main path up to your fence so guests can watch.',
    confirm: 'Tap Build to lay it.',
    done: (sim) => [...sim.world.habitats.values()].some((h) => h.viewTiles.length > 0),
  },
  {
    title: 'Hire a keeper',
    cat: 'staff',
    card: (k) => k === 'staff:keeper',
    tool: (t) => t.kind === 'staff' && t.role === 'keeper',
    open: 'Someone has to feed the animals. Tap Staff.',
    pick: 'Pick the Animal Keeper.',
    use: 'Tap a path to place the keeper.',
    confirm: 'Tap Hire to take them on.',
    done: (sim) => [...sim.staff.values()].some((s) => s.role === 'keeper'),
  },
];

/** Where the bubble points (screen px): it sits above `top` with its arrow at `x`. */
interface Anchor {
  x: number;
  top: number;
  /** A tool bar over the drawer: the bubble goes below it, or beside it when there is no room below. */
  bar?: ScreenRect;
}

export interface CoachHost {
  sim: ISimulation;
  /** Active tool, and whether it is moving an existing thing (then it is not "the step's tool"). */
  tool(): { tool: Tool; moving: boolean };
  /** Open dock category, if any. */
  openCategory(): CategoryId | null;
  /** Dock elements the bubble can point at (null / hidden = not on screen). */
  categoryButton(id: CategoryId): HTMLElement | null;
  card(match: (key: string) => boolean): HTMLElement | null;
  /** Scroll the drawer so this card is in view. */
  revealCard(card: HTMLElement): void;
  drawer(): HTMLElement | null;
  toolBar(): HTMLElement | null;
  confirmBar(): HTMLElement | null;
  /** Part of the 3D view the top bar, dock and side cards leave free (screen px). */
  viewArea(): { x0: number; y0: number; x1: number; y1: number };
  /** Screen rect of what is being built (preview + cost label), if anything. */
  workRect(): ScreenRect | null;
  /** Something modal or a side sheet is up: keep the tour out of the way. */
  busy(): boolean;
  /** Put the tool in hand away (back to Inspect). */
  endTool(): void;
  /** The bubble appeared, moved or went away (the toasts make room for it). */
  bubbleMoved(): void;
  openBuildCategory(id: CategoryId): void;
  openGoals(): void;
  toast(text: string, kind: 'good'): void;
}

export class Coach {
  readonly pill: HTMLElement;
  readonly bubble: HTMLElement;
  private pillText = el('span', 'wh-goal-t');
  private pillReward = el('span', 'wh-goal-r');
  private pillBar = el('i');
  private pillTrack = el('span', 'wh-goal-bar', [this.pillBar]);
  private pillProgress = el('span', 'wh-goal-p');
  private pillId = '';
  /** Viewport width the pill's text was fitted to. */
  private pillFitW = 0;
  private bubbleStep = el('span', 'wh-coach-n');
  private bubbleTitle = el('span', 'wh-coach-title');
  private bubbleText = el('div', 'wh-coach-text');
  private arrow = el('i', 'wh-coach-arrow');
  /** Tour running for this zoo. */
  private touring = false;
  /** Steps reached so far (persisted, so a reload resumes the tour). */
  private reached = 0;
  private painted = false;
  private acc = ANCHOR_EVERY;
  private shownStep = -1;
  /** Current tour step (-1 when the tour is not showing). */
  private step = -1;
  /** Where the bubble is on screen (null while hidden), and whether it is docked in a top corner. */
  private placed: ScreenRect | null = null;
  private docked = false;
  /** The step's card last scrolled into view (the dock builds new cards each time a drawer opens). */
  private revealed: HTMLElement | null = null;

  constructor(private host: CoachHost) {
    // two lines: the goal, then how far along it is and the reward
    this.pill = el('div', { class: 'wh-goal wh-glass hidden', attrs: { role: 'button', 'aria-label': 'Next goal' }, onClick: () => this.pillTapped() }, [
      el('span', { class: 'wh-goal-k', html: `${icon('trophy')}<span>Next</span>` }),
      el('span', 'wh-goal-main', [this.pillText, el('span', 'wh-goal-sub', [this.pillTrack, this.pillProgress, this.pillReward])]),
    ]);
    swallowPointer(this.pill);
    const skip = button('wh-btn-ghost wh-coach-skip', 'close', null, () => this.finish(false), 'Skip the tour');
    swallowPointer(skip);
    this.bubble = el('div', { class: 'wh-coach hidden', attrs: { role: 'status', 'aria-live': 'polite' } }, [
      el('div', 'wh-coach-head', [this.bubbleStep, this.bubbleTitle, skip]),
      this.bubbleText,
      this.arrow,
    ]);
    this.reset();
  }

  /** Where the tour's bubble is on screen, or null while it is hidden. */
  get rect(): ScreenRect | null {
    return this.placed;
  }

  /** Where the bubble is while docked under the top bar (a tool in hand), else null. */
  get dockedRect(): ScreenRect | null {
    return this.docked ? this.placed : null;
  }

  /** (Re)decide whether the tour runs, for a newly started or loaded zoo. */
  reset(): void {
    const saved = storageGet(TOUR_KEY);
    this.painted = false;
    this.shownStep = -1;
    if (saved === 'done') {
      this.touring = false;
      return;
    }
    // never started on this device and the zoo already has animals: an experienced player's save
    this.touring = saved !== null || this.host.sim.animals.size === 0;
    this.reached = Math.max(0, Math.min(STEPS.length, Number(saved) || 0));
  }

  /** Terrain was repainted somewhere: inside a habitat, that is the tour's second step. */
  terrainPainted(r: { x0: number; z0: number; x1: number; z1: number }): void {
    if (!this.touring || this.painted) return;
    const w = this.host.sim.world;
    for (let z = r.z0; z <= r.z1 && !this.painted; z++) for (let x = r.x0; x <= r.x1; x++) if (w.habitatAt(x, z)) this.painted = true;
  }

  /**
   * Build mode was entered (from Inspect). Returns whether the tool bar should still
   * show how to move the camera while building.
   */
  buildModeEntered(): boolean {
    const n = (Number(storageGet(BUILD_USES_KEY)) || 0) + 1;
    if (n <= CAMERA_TIP_USES) storageSet(BUILD_USES_KEY, String(n));
    return n <= CAMERA_TIP_USES;
  }

  update(dt: number): void {
    this.acc += dt;
    if (this.acc < ANCHOR_EVERY) return;
    this.acc = 0;
    this.step = this.touring ? this.currentStep() : -1;
    this.updatePill(this.step >= 0);
    this.updateBubble(this.step);
  }

  /** Re-place the bubble now (e.g. a tool was just picked up, so it docks before the view is measured). */
  refresh(): void {
    if (this.touring) this.updateBubble(this.step);
  }

  // ------------------------------------------------------------ next-goal pill
  private nextGoal(): Objective | undefined {
    return this.host.sim.objectives.find((o) => !o.done);
  }

  private updatePill(tourShowing: boolean): void {
    const goal = this.nextGoal();
    toggleClass(this.pill, 'hidden', !goal || tourShowing);
    if (!goal) return;
    this.updatePillProgress(goal);
    const vw = window.innerWidth;
    if (goal.id === this.pillId && vw === this.pillFitW) return;
    const fresh = goal.id !== this.pillId && this.pillId !== '';
    this.pillId = goal.id;
    this.pillFitW = vw;
    // the objective without its parenthesised how-to (the tour and the build menus cover that);
    // where it does not fit, without its verb rather than cut off mid-word
    setText(this.pillText, pillGoalText(goal.text, false));
    if (this.pillText.scrollWidth > this.pillText.clientWidth + 1) setText(this.pillText, pillGoalText(goal.text, true));
    setText(this.pillReward, goal.reward ? fmtMoney(goal.reward, { sign: true }) : '');
    this.pill.title = goal.text;
    if (!fresh) return;
    // a new goal: a short glow draws the eye to it
    this.pill.classList.remove('fresh');
    void this.pill.offsetWidth;
    this.pill.classList.add('fresh');
  }

  /** Bar and "141 / 150" for a goal with a number to reach (no bar for one-step goals or before there is a number). */
  private updatePillProgress(goal: Objective): void {
    const p = this.host.sim.objectiveProgress(goal.id);
    toggleClass(this.pillTrack, 'hidden', !p || !!p.waiting);
    setText(this.pillProgress, p ? goalProgressText(goal, p) : '');
    const w = p ? `${(goalFraction(p) * 100).toFixed(1)}%` : '0%';
    if (this.pillBar.style.width !== w) this.pillBar.style.width = w;
  }

  private pillTapped(): void {
    const goal = this.nextGoal();
    if (!goal) return;
    const cat = GOAL_CATEGORY[goal.id];
    if (cat) this.host.openBuildCategory(cat);
    else this.host.openGoals();
  }

  // ------------------------------------------------------------ tour
  /** First unfinished step (and the progress is saved), or -1 once the tour is over. */
  private currentStep(): number {
    const sim = this.host.sim;
    // painting leaves no trace to check, so a resumed tour trusts the progress it saved
    const painted = this.painted || this.reached > 1;
    const i = STEPS.findIndex((s) => !s.done(sim, painted));
    // a step just done puts its tool away, so a drag to look around doesn't start another one
    if (this.shownStep >= 0 && (i < 0 || i > this.shownStep)) this.endStepTool(STEPS[this.shownStep]);
    if (i < 0) {
      this.finish(true);
      return -1;
    }
    if (i > this.reached) {
      this.reached = i;
      storageSet(TOUR_KEY, String(i));
    }
    return i;
  }

  private endStepTool(s: TourStep): void {
    const { tool, moving } = this.host.tool();
    if (s.tool(tool) && !moving) this.host.endTool();
  }

  private finish(completed: boolean): void {
    if (!this.touring) return;
    this.touring = false;
    storageSet(TOUR_KEY, 'done');
    this.hideBubble();
    if (completed) this.host.toast('Your zoo is up and running! The goal at the top left shows what to aim for next.', 'good');
    else this.updatePill(false);
  }

  private updateBubble(step: number): void {
    const h = this.host;
    const s = STEPS[step];
    if (!s || h.busy()) {
      this.hideBubble();
      return;
    }
    if (step !== this.shownStep) {
      this.shownStep = step;
      setText(this.bubbleStep, `${step + 1}/${STEPS.length}`);
      setText(this.bubbleTitle, s.title);
    }
    const { tool, moving } = h.tool();
    const cat = h.openCategory();
    if (cat === null && tool.kind !== 'select') {
      // building: docked in a top corner, clear of the preview and its cost label
      const own = s.tool(tool) && !moving;
      this.showText(own ? (h.confirmBar() ? s.confirm : s.use) : s.open);
      this.dock();
      return;
    }
    let text = '';
    let anchor: Anchor | null = null;
    if (cat === s.cat) {
      // the step's own tool is already in hand: nothing to pick (it docks again once the drawer closes)
      if (s.tool(tool) && !moving) {
        this.hideBubble();
        return;
      }
      const card = h.card(s.card);
      const drawer = h.drawer();
      if (card && drawer) {
        // once per drawer opening, so the player can still scroll on through the cards
        if (card !== this.revealed) {
          this.revealed = card;
          h.revealCard(card);
        }
        const c = card.getBoundingClientRect();
        const d = drawer.getBoundingClientRect();
        // the tool bar sits over the drawer while a tool is in hand
        const actions = h.toolBar()?.getBoundingClientRect();
        anchor = {
          x: Math.max(d.left + 16, Math.min(d.right - 16, c.left + c.width / 2)),
          top: d.top,
          bar: actions && actions.bottom <= d.top + 1 ? actions : undefined,
        };
      }
      text = s.pick;
    } else if (cat === null) {
      const b = h.categoryButton(s.cat)?.getBoundingClientRect();
      if (b && b.width) anchor = { x: b.left + b.width / 2, top: b.top };
      text = s.open;
    }
    // (while the player browses another category the bubble keeps out of the way)
    if (!anchor) {
      this.hideBubble();
      return;
    }
    this.showText(text);
    this.place(anchor);
  }

  private showText(text: string): void {
    setText(this.bubbleText, text);
    this.bubble.classList.remove('hidden');
  }

  private hideBubble(): void {
    this.bubble.classList.add('hidden');
    this.moveTo(null, false);
  }

  /**
   * Put the bubble above the anchor, with its arrow on it, inside the view and below the top HUD
   * (and below a tool bar over the drawer, or else beside it). Never over the tool bar, and over
   * the drawer's title row only when nothing else fits.
   */
  private place(a: Anchor): void {
    const b = this.bubble;
    b.classList.remove('docked', 'faded');
    b.style.maxWidth = '';
    // sideways inside the view (never over an open species card)
    const area = this.host.viewArea();
    const ceiling = area.y0 + 4;
    let w = b.offsetWidth;
    let hgt = b.offsetHeight;
    const put = (left: number, top: number) => {
      // the arrow stays on the anchor even when the bubble is pushed sideways; beside the tool bar
      // the anchor may be out of reach, and then there is no arrow
      const ax = a.x - left;
      this.arrow.style.display = ax >= 14 && ax <= w - 14 ? '' : 'none';
      this.arrow.style.left = `${Math.round(Math.max(14, Math.min(w - 14, ax)))}px`;
      this.moveTo({ left, top, right: left + w, bottom: top + hgt }, false);
    };
    const centred = (x0: number, x1: number) => Math.max(x0, Math.min(x1 - w, a.x - w / 2));
    const above = a.top - 12 - hgt;
    if (above >= Math.max(ceiling, a.bar ? a.bar.bottom + 4 : 0)) return put(centred(area.x0, area.x1), above);
    if (a.bar) {
      // beside the tool bar, the side nearer the card first, narrowed to the room there
      const bar = a.bar;
      const sides = [
        { x0: area.x0, x1: bar.left - DOCK_GAP },
        { x0: bar.right + DOCK_GAP, x1: area.x1 },
      ].sort((p, q) => Math.abs((p.x0 + p.x1) / 2 - a.x) - Math.abs((q.x0 + q.x1) / 2 - a.x));
      for (const side of sides) {
        if (side.x1 - side.x0 < MIN_SIDE_W) continue;
        b.style.maxWidth = `${Math.floor(side.x1 - side.x0)}px`;
        w = b.offsetWidth;
        hgt = b.offsetHeight;
        const top = Math.max(ceiling, a.top - 12 - hgt);
        if (top + hgt <= a.top + DRAWER_PAD) return put(centred(side.x0, side.x1), top);
      }
      b.style.maxWidth = '';
      w = b.offsetWidth;
      hgt = b.offsetHeight;
    }
    // last resort: as high as it may go, reaching into the drawer as little as possible
    put(centred(area.x0, area.x1), Math.max(ceiling, a.bar ? a.bar.bottom + 4 : 0));
  }

  /**
   * Compact, without an arrow, in the top-left corner of the clear view (top-right when what
   * is being built reaches into that corner; faded when it fills both).
   */
  private dock(): void {
    const b = this.bubble;
    b.classList.add('docked');
    b.style.maxWidth = '';
    const w = b.offsetWidth;
    const hgt = b.offsetHeight;
    const a = this.host.viewArea();
    const top = a.y0 + DOCK_GAP;
    const work = this.host.workRect();
    const at = (left: number): ScreenRect => ({ left, top, right: left + w, bottom: top + hgt });
    const cost = (r: ScreenRect) => (work ? overlapArea(r, work, DOCK_GAP) : 0);
    const leftSide = at(a.x0);
    const rightSide = at(Math.max(a.x0, a.x1 - w));
    const r = cost(leftSide) <= cost(rightSide) ? leftSide : rightSide;
    toggleClass(b, 'faded', cost(r) > 0);
    this.moveTo(r, true);
  }

  private moveTo(r: ScreenRect | null, docked: boolean): void {
    const p = this.placed;
    if (r) this.bubble.style.transform = `translate(${Math.round(r.left)}px, ${Math.round(r.top)}px)`;
    const same = p && r ? Math.abs(p.left - r.left) + Math.abs(p.top - r.top) + Math.abs(p.right - r.right) + Math.abs(p.bottom - r.bottom) < 2 : p === r;
    this.placed = r;
    this.docked = docked;
    if (!same) this.host.bubbleMoved();
  }
}
