// First-run guidance:
//  * the "next goal" pill under the top bar: the first open objective; a tap opens the
//    build category that achieves it (or the Goals tab);
//  * a five-step coach-mark tour for a new zoo (fence a habitat → paint its ground →
//    adopt an animal → connect a path → hire a keeper). A bubble points at the dock
//    button, then the card, then the tool bar / confirm bar, step by step;
//  * how many times build mode was entered, so the tool bar can teach the camera
//    gesture for the first few uses.
// Progress lives in localStorage (best effort: without storage the tour simply shows again).

import type { ISimulation } from '../core/contracts';
import type { Objective, Tool } from '../core/types';
import type { CategoryId } from './catalog';
import { button, el, fmtMoney, setText, storageGet, storageSet, swallowPointer, toggleClass } from './dom';
import { icon } from './icons';

/** 'done' once the tour was finished or skipped, else the number of steps reached so far. */
const TOUR_KEY = 'wildhaven-tour';
const BUILD_USES_KEY = 'wildhaven-build-uses';
/** Build-mode entries that still show the camera tip on the tool bar. */
const CAMERA_TIP_USES = 5;
/** Seconds between bubble re-anchors (a handful of layout reads, only while the tour runs). */
const ANCHOR_EVERY = 0.12;

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
    use: 'Drag a rectangle on open grass. Keep paths outside it.',
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
    open: 'Guests only walk on paths. Tap Paths.',
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
  /** Used instead of `top` when the bubble would not fit above it. */
  fallbackTop?: number;
  /** The bubble stays below this (besides the top HUD). */
  ceiling?: number;
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
  drawer(): HTMLElement | null;
  toolBar(): HTMLElement | null;
  confirmBar(): HTMLElement | null;
  /** Bottom edge (px) of the top HUD: the bubble never covers it. */
  hudBottom(): number;
  /** Something modal or a side sheet is up: keep the tour out of the way. */
  busy(): boolean;
  openBuildCategory(id: CategoryId): void;
  openGoals(): void;
  toast(text: string, kind: 'good'): void;
}

export class Coach {
  readonly pill: HTMLElement;
  readonly bubble: HTMLElement;
  private pillText = el('span', 'wh-goal-t');
  private pillReward = el('span', 'wh-goal-r');
  private pillId = '';
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

  constructor(private host: CoachHost) {
    this.pill = el('div', { class: 'wh-goal wh-glass hidden', attrs: { role: 'button', 'aria-label': 'Next goal' }, onClick: () => this.pillTapped() }, [
      el('span', { class: 'wh-goal-k', html: `${icon('trophy')}<span>Next</span>` }),
      this.pillText,
      this.pillReward,
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
    const step = this.touring ? this.currentStep() : -1;
    this.updatePill(step >= 0);
    this.updateBubble(step);
  }

  // ------------------------------------------------------------ next-goal pill
  private nextGoal(): Objective | undefined {
    return this.host.sim.objectives.find((o) => !o.done);
  }

  private updatePill(tourShowing: boolean): void {
    const goal = this.nextGoal();
    toggleClass(this.pill, 'hidden', !goal || tourShowing);
    if (!goal || goal.id === this.pillId) return;
    const first = this.pillId === '';
    this.pillId = goal.id;
    // the objective without its parenthesised how-to (the tour and the build menus cover that)
    setText(this.pillText, goal.text.replace(/\s*\(.*\)\s*$/, ''));
    setText(this.pillReward, goal.reward ? fmtMoney(goal.reward, { sign: true }) : '');
    this.pill.title = goal.text;
    if (first) return;
    // a new goal: a short glow draws the eye to it
    this.pill.classList.remove('fresh');
    void this.pill.offsetWidth;
    this.pill.classList.add('fresh');
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

  private finish(completed: boolean): void {
    if (!this.touring) return;
    this.touring = false;
    storageSet(TOUR_KEY, 'done');
    this.bubble.classList.add('hidden');
    if (completed) this.host.toast('Your zoo is up and running! The goal at the top left shows what to aim for next.', 'good');
    else this.updatePill(false);
  }

  private updateBubble(step: number): void {
    const h = this.host;
    const s = STEPS[step];
    if (!s || h.busy()) {
      this.bubble.classList.add('hidden');
      return;
    }
    if (step !== this.shownStep) {
      this.shownStep = step;
      setText(this.bubbleStep, `${step + 1}/${STEPS.length}`);
      setText(this.bubbleTitle, s.title);
    }
    const { tool, moving } = h.tool();
    const confirm = h.confirmBar();
    // the tool bar or the confirm bar (one at a time), above the drawer and the dock buttons
    const actionsEl = confirm ?? h.toolBar();
    const actions = actionsEl ? actionsEl.getBoundingClientRect() : null;
    let text = '';
    let anchor: Anchor | null = null;
    if (s.tool(tool) && !moving) {
      text = confirm ? s.confirm : s.use;
      if (actions) anchor = { x: actions.left + actions.width / 2, top: actions.top };
    } else if (h.openCategory() === s.cat) {
      text = s.pick;
      const card = h.card(s.card);
      const drawer = h.drawer();
      if (card && drawer) {
        const c = card.getBoundingClientRect();
        const d = drawer.getBoundingClientRect();
        // above the drawer pointing down at the card; where a tool bar over the drawer leaves
        // no room, over the drawer's title row instead (never over the tool bar)
        anchor = {
          x: Math.max(d.left + 16, Math.min(d.right - 16, c.left + c.width / 2)),
          top: d.top,
          fallbackTop: c.top,
          ceiling: actions && actions.bottom <= d.top + 1 ? actions.bottom : 0,
        };
      }
    } else if (h.openCategory() === null) {
      // (while the player browses another category the bubble keeps out of the way)
      text = s.open;
      const b = h.categoryButton(s.cat)?.getBoundingClientRect();
      // above the tool bar as well when one sits over the dock
      if (b && b.width) anchor = { x: b.left + b.width / 2, top: actions ? Math.min(b.top, actions.top) : b.top };
    }
    if (!anchor) {
      this.bubble.classList.add('hidden');
      return;
    }
    setText(this.bubbleText, text);
    this.bubble.classList.remove('hidden');
    this.place(anchor);
  }

  /** Put the bubble above the anchor, inside the screen and below the top HUD. */
  private place(a: Anchor): void {
    const b = this.bubble;
    const w = b.offsetWidth;
    const hgt = b.offsetHeight;
    const vw = window.innerWidth;
    const left = Math.max(8, Math.min(vw - 8 - w, a.x - w / 2));
    const ceiling = Math.max(this.host.hudBottom(), a.ceiling ?? 0) + 4;
    let top = a.top - 12 - hgt;
    if (top < ceiling && a.fallbackTop !== undefined) top = a.fallbackTop - 12 - hgt;
    top = Math.max(ceiling, top);
    b.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    // the arrow stays on the anchor even when the bubble is pushed sideways
    this.arrow.style.left = `${Math.round(Math.max(14, Math.min(w - 14, a.x - left)))}px`;
  }
}
