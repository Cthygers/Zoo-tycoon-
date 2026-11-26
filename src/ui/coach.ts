// First-run guidance that stays with the game shell (the step-by-step tutorial is a UI
// extension, src/ui/tutorial):
//  * the "next goal" pill under the top bar: the first open objective; a tap opens the
//    build category that achieves it (or the Goals tab). While the tutorial runs it can
//    turn the pill into its "STEP" form (setStep) and hear every tap (onPillTapped);
//  * how many times build mode was entered, so the tool bar can teach the camera
//    gesture for the first few uses (localStorage, best effort).

import type { GoalProgress, ISimulation } from '../core/contracts';
import type { Objective } from '../core/types';
import type { PillStepView } from '../core/ui-ext';
import type { CategoryId } from './catalog';
import { el, fmtMoney, setText, storageGet, storageSet, swallowPointer, toggleClass } from './dom';
import { icon } from './icons';

const BUILD_USES_KEY = 'wildhaven-build-uses';
/** Build-mode entries that still show the camera tip on the tool bar. */
const CAMERA_TIP_USES = 5;
/** Seconds between pill refreshes. */
const PILL_EVERY = 0.12;

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

export interface CoachHost {
  sim: ISimulation;
  openBuildCategory(id: CategoryId): void;
  openGoals(): void;
}

/** What the pill shows: the next goal, or (while the tutorial runs) its step. */
export interface PillContent {
  mode: 'goal' | 'step';
  text: string;
  /** Goal: "141 / 150" (or the sim's note); step: e.g. "4 / 12". */
  progress: string;
  /** 0..1 for the bar, or null for no bar. */
  fraction: number | null;
  /** "+$2,000" for a goal with a reward, else ''. */
  reward: string;
}

/** The pill's content for a step view (pure). */
export function pillStepContent(v: PillStepView): PillContent {
  const f = Number.isFinite(v.fraction) ? Math.max(0, Math.min(1, v.fraction)) : 0;
  return { mode: 'step', text: v.label, progress: v.sub, fraction: f, reward: '' };
}

export class Coach {
  readonly pill: HTMLElement;
  private pillKey = el('span', 'wh-goal-k');
  private pillText = el('span', 'wh-goal-t');
  private pillReward = el('span', 'wh-goal-r');
  private pillBar = el('i');
  private pillTrack = el('span', 'wh-goal-bar', [this.pillBar]);
  private pillProgress = el('span', 'wh-goal-p');
  private pillId = '';
  /** Viewport width the pill's text was fitted to. */
  private pillFitW = 0;
  private acc = PILL_EVERY;
  /** The tutorial's step shown on the pill (null: the next goal). */
  private step: PillStepView | null = null;
  private keyMode: 'goal' | 'step' | '' = '';
  private tapFns: (() => void)[] = [];

  constructor(private host: CoachHost) {
    // two lines: the goal, then how far along it is and the reward
    this.pill = el('div', { class: 'wh-goal wh-glass hidden', attrs: { role: 'button', 'aria-label': 'Next goal' }, onClick: () => this.pillTapped() }, [
      this.pillKey,
      el('span', 'wh-goal-main', [this.pillText, el('span', 'wh-goal-sub', [this.pillTrack, this.pillProgress, this.pillReward])]),
    ]);
    this.setKey('goal');
    swallowPointer(this.pill);
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

  /** Show a tutorial step on the pill ("STEP", the chapter title, "4 / 12" and its bar), or null for the next goal again. */
  setStep(view: PillStepView | null): void {
    const same = view && this.step ? view.label === this.step.label && view.sub === this.step.sub && view.fraction === this.step.fraction : view === this.step;
    this.step = view ? { label: view.label, sub: view.sub, fraction: view.fraction } : null;
    if (same) return;
    this.pillId = '';
    this.acc = PILL_EVERY; // at the next update, not 0.12 s later
  }

  /** Every tap on the pill (step or goal form); a goal's own action still runs. Returns an unsubscribe. */
  onPillTapped(fn: () => void): () => void {
    this.tapFns.push(fn);
    return () => {
      const i = this.tapFns.indexOf(fn);
      if (i >= 0) this.tapFns.splice(i, 1);
    };
  }

  update(dt: number): void {
    this.acc += dt;
    if (this.acc < PILL_EVERY) return;
    this.acc = 0;
    if (this.step) this.showStep(this.step);
    else this.updatePill();
  }

  // ------------------------------------------------------------ next-goal pill
  private nextGoal(): Objective | undefined {
    return this.host.sim.objectives.find((o) => !o.done);
  }

  /** The label on the pill's left: a trophy over "Next", or a leaf over "Step". */
  private setKey(mode: 'goal' | 'step'): void {
    if (mode === this.keyMode) return;
    this.keyMode = mode;
    this.pillKey.innerHTML = mode === 'step' ? `${icon('leaf')}<span>Step</span>` : `${icon('trophy')}<span>Next</span>`;
    toggleClass(this.pill, 'step', mode === 'step');
    this.pill.setAttribute('aria-label', mode === 'step' ? 'Tutorial step: show me' : 'Next goal');
  }

  private showStep(v: PillStepView): void {
    const c = pillStepContent(v);
    this.setKey('step');
    toggleClass(this.pill, 'hidden', false);
    setText(this.pillText, c.text);
    setText(this.pillProgress, c.progress);
    setText(this.pillReward, '');
    toggleClass(this.pillTrack, 'hidden', c.fraction === null);
    const w = `${((c.fraction ?? 0) * 100).toFixed(1)}%`;
    if (this.pillBar.style.width !== w) this.pillBar.style.width = w;
    if (this.pill.title !== c.text) this.pill.title = c.text;
  }

  private updatePill(): void {
    this.setKey('goal');
    const goal = this.nextGoal();
    toggleClass(this.pill, 'hidden', !goal);
    if (!goal) return;
    this.updatePillProgress(goal);
    const vw = window.innerWidth;
    if (goal.id === this.pillId && vw === this.pillFitW) return;
    const fresh = goal.id !== this.pillId && this.pillId !== '';
    this.pillId = goal.id;
    this.pillFitW = vw;
    // the objective without its parenthesised how-to (the build menus cover that);
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
    for (const fn of [...this.tapFns]) {
      try {
        fn();
      } catch (err) {
        console.error('[ui] pill tap handler failed', err);
      }
    }
    // the step form is the tutorial's "show me" (its handler above); the goal form opens what achieves it
    if (this.step) return;
    const goal = this.nextGoal();
    if (!goal) return;
    const cat = GOAL_CATEGORY[goal.id];
    if (cat) this.host.openBuildCategory(cat);
    else this.host.openGoals();
  }
}
