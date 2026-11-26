// First-run guidance that stays with the shell (UX-4): the next-goal pill, its "STEP" form for
// the tutorial extension, taps on it, and the build-mode camera tip count. The old coach-mark
// tour moved to the tutorial extension (src/ui/tutorial, tests/tutorial-*.test.ts). A tiny
// fake DOM stands in for the few element methods the pill touches.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalProgress, ISimulation } from '../src/core/contracts';
import type { Objective } from '../src/core/types';
import { Coach, pillStepContent, type CoachHost } from '../src/ui/coach';

class FakeEl {
  className = '';
  textContent = '';
  innerHTML = '';
  title = '';
  offsetWidth = 200;
  offsetHeight = 50;
  /** A pill text this wide (or less) fits on the pill. */
  clientWidth = 260;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  classList = {
    add: (c: string) => {
      if (!this.classList.contains(c)) this.className = `${this.className} ${c}`.trim();
    },
    remove: (c: string) => {
      this.className = this.className
        .split(/\s+/)
        .filter((x) => x !== c)
        .join(' ');
    },
    contains: (c: string) => this.className.split(/\s+/).includes(c),
    toggle: (c: string, on?: boolean) => ((on ?? !this.classList.contains(c)) ? this.classList.add(c) : this.classList.remove(c)),
  };
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  append(): void {}
  /** Width the text would need: about 7 px a character. */
  get scrollWidth(): number {
    return this.textContent.length * 7;
  }
  click(): void {
    for (const fn of this.listeners.click ?? []) fn({ stopPropagation() {} });
  }
}

interface FakeSim {
  objectives: Objective[];
  progress: Record<string, GoalProgress>;
  objectiveProgress(id: string): GoalProgress | null;
  animals: Map<number, unknown>;
}

function setup(opts: { animals?: number } = {}) {
  const sim: FakeSim = {
    objectives: [
      { id: 'build_habitat', text: 'Build your first habitat (enclose an area with fences)', done: false, reward: 2000 },
      { id: 'first_animal', text: 'Adopt your first animal', done: false, reward: 2500 },
    ],
    progress: {},
    objectiveProgress(id: string) {
      return this.progress[id] ?? null;
    },
    animals: new Map(Array.from({ length: opts.animals ?? 0 }, (_, i) => [i + 1, {}])),
  };
  const host: CoachHost = {
    sim: sim as unknown as ISimulation,
    openBuildCategory: vi.fn(),
    openGoals: vi.fn(),
  };
  const coach = new Coach(host);
  return { sim, host, coach };
}

type PillParts = { pillKey: FakeEl; pillText: FakeEl; pillProgress: FakeEl; pillReward: FakeEl; pillTrack: FakeEl; pillBar: FakeEl };
const parts = (c: Coach) => c as unknown as PillParts;

describe('Coach', () => {
  let store: Map<string, string>;
  let getItem: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    store = new Map();
    getItem = vi.fn((k: string) => store.get(k) ?? null);
    vi.stubGlobal('document', { createElement: () => new FakeEl() });
    vi.stubGlobal('window', { innerWidth: 915, innerHeight: 412 });
    vi.stubGlobal('localStorage', { getItem, setItem: (k: string, v: string) => void store.set(k, v) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the first open goal without its how-to, in any zoo, and never touches the old tour key', () => {
    for (const animals of [0, 3]) {
      const { coach } = setup({ animals });
      coach.update(1);
      const pill = coach.pill as unknown as FakeEl;
      expect(pill.classList.contains('hidden')).toBe(false);
      expect(parts(coach).pillText.textContent).toBe('Build your first habitat');
      expect(parts(coach).pillReward.textContent).toBe('+$2,000');
      expect(parts(coach).pillKey.innerHTML).toContain('Next');
    }
    expect(store.has('wildhaven-tour')).toBe(false);
    expect(getItem).not.toHaveBeenCalledWith('wildhaven-tour');
  });
  it("shows how far along the next goal is, and drops the goal's verb rather than cut it off", () => {
    const { sim, coach } = setup({ animals: 1 });
    const priv = parts(coach);
    sim.objectives = [{ id: 'guests_150', text: 'Welcome 150 guests in a single day', done: false, reward: 5000 }];
    sim.progress.guests_150 = { current: 141, target: 150 };
    coach.update(1);
    expect(priv.pillText.textContent).toBe('Welcome 150 guests in a single day'); // 34 × 7 px fits in 260
    expect(priv.pillProgress.textContent).toBe('141 / 150');
    expect(priv.pillBar.style.width).toBe('94.0%');
    expect(priv.pillReward.textContent).toBe('+$5,000');
    expect(priv.pillTrack.classList.contains('hidden')).toBe(false);
    // progress moves on without the goal changing
    sim.progress.guests_150 = { current: 146, target: 150 };
    coach.update(1);
    expect(priv.pillProgress.textContent).toBe('146 / 150');
    // a goal too long for the pill loses its verb, not the end of a word
    sim.objectives = [{ id: 'happy_10', text: 'Have 10 animals with happiness above 70%', done: false, reward: 2500 }];
    sim.progress.happy_10 = { current: 4, target: 10 };
    coach.update(1);
    expect(priv.pillText.textContent).toBe('10 animals with happiness above 70%');
    expect(priv.pillProgress.textContent).toBe('4 / 10');
    // a one-step goal: no bar, just the reward
    sim.objectives = [{ id: 'gift_shop', text: 'Build a gift shop', done: false, reward: 2000 }];
    coach.update(1);
    expect(priv.pillTrack.classList.contains('hidden')).toBe(true);
    expect(priv.pillProgress.textContent).toBe('');
    // nothing measured yet (no full day of guests): the sim's note instead of "0% / 75%"
    sim.objectives = [{ id: 'guest_happy_75', text: 'Reach 75% guest happiness for a day', done: false, reward: 6000 }];
    sim.progress.guest_happy_75 = { current: 0, target: 75, waiting: 'No full day yet' };
    coach.update(1);
    expect(priv.pillTrack.classList.contains('hidden')).toBe(true);
    expect(priv.pillProgress.textContent).toBe('No full day yet');
  });

  it('opens the build category for a goal, or the Goals tab', () => {
    const { sim, coach, host } = setup({ animals: 1 });
    (coach as unknown as { pillTapped(): void }).pillTapped();
    expect(host.openBuildCategory).toHaveBeenCalledWith('habitats');
    sim.objectives = [{ id: 'guests_25', text: 'Welcome 25 guests in a single day', done: false, reward: 2500 }];
    (coach as unknown as { pillTapped(): void }).pillTapped();
    expect(host.openGoals).toHaveBeenCalled();
  });

  it('shows a tutorial step instead of the goal ("STEP", the chapter, "4 / 12" and its bar), then the goal again', () => {
    const { coach } = setup();
    const pill = coach.pill as unknown as FakeEl;
    coach.update(1);
    expect(parts(coach).pillText.textContent).toBe('Build your first habitat');
    coach.setStep({ label: 'Build a habitat', sub: '2 / 12', fraction: 2 / 12 });
    coach.update(0); // shown at the next update, not 0.12 s later
    expect(pill.classList.contains('step')).toBe(true);
    expect(pill.classList.contains('hidden')).toBe(false);
    expect(parts(coach).pillKey.innerHTML).toContain('Step');
    expect(parts(coach).pillText.textContent).toBe('Build a habitat');
    expect(parts(coach).pillProgress.textContent).toBe('2 / 12');
    expect(parts(coach).pillReward.textContent).toBe('');
    expect(parts(coach).pillBar.style.width).toBe('16.7%');
    expect(pill.attrs['aria-label']).toBe('Tutorial step: show me');
    // also when every goal is done
    coach.update(1);
    expect(parts(coach).pillText.textContent).toBe('Build a habitat');
    // back to the next goal
    coach.setStep(null);
    coach.update(0);
    expect(pill.classList.contains('step')).toBe(false);
    expect(parts(coach).pillKey.innerHTML).toContain('Next');
    expect(parts(coach).pillText.textContent).toBe('Build your first habitat');
    expect(parts(coach).pillReward.textContent).toBe('+$2,000');
    expect(pill.attrs['aria-label']).toBe('Next goal');
  });

  it('clamps a step fraction to 0..1', () => {
    expect(pillStepContent({ label: 'A', sub: '1 / 12', fraction: 1.4 }).fraction).toBe(1);
    expect(pillStepContent({ label: 'A', sub: '1 / 12', fraction: Number.NaN }).fraction).toBe(0);
    expect(pillStepContent({ label: 'A', sub: '1 / 12', fraction: -1 }).fraction).toBe(0);
  });

  it('tells every tap subscriber; the goal form still opens its category, the step form does not', () => {
    const { coach, host } = setup({ animals: 1 });
    const pill = coach.pill as unknown as FakeEl;
    const a = vi.fn();
    const b = vi.fn(() => {
      throw new Error('a broken handler does not stop the others');
    });
    const offA = coach.onPillTapped(a);
    coach.onPillTapped(b);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    pill.click();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(host.openBuildCategory).toHaveBeenCalledWith('habitats');
    coach.setStep({ label: 'Look around', sub: '1 / 12', fraction: 0 });
    pill.click();
    expect(a).toHaveBeenCalledTimes(2);
    expect(host.openBuildCategory).toHaveBeenCalledTimes(1); // "show me" belongs to the tutorial
    offA();
    pill.click();
    expect(a).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('counts build-mode entries for the camera tip', () => {
    const { coach } = setup();
    const shown = Array.from({ length: 7 }, () => coach.buildModeEntered());
    expect(shown).toEqual([true, true, true, true, true, false, false]);
  });
});
