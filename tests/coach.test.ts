// First-run guidance (UX-4): when the coach-mark tour runs, how it advances and is
// remembered, the next-goal pill, and the build-mode camera tip count. A tiny fake DOM
// stands in for the few element methods the coach touches.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalProgress, ISimulation } from '../src/core/contracts';
import type { Objective, Tool } from '../src/core/types';
import { Coach, type CoachHost } from '../src/ui/coach';

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
  setAttribute(): void {}
  addEventListener(): void {}
  append(): void {}
  /** Width the text would need: about 7 px a character. */
  get scrollWidth(): number {
    return this.textContent.length * 7;
  }
  getBoundingClientRect() {
    return { left: 300, top: 340, width: 60, height: 56, right: 360, bottom: 396 };
  }
}

interface FakeSim {
  objectives: Objective[];
  progress: Record<string, GoalProgress>;
  objectiveProgress(id: string): GoalProgress | null;
  animals: Map<number, unknown>;
  staff: Map<number, { role: string }>;
  world: { habitats: Map<number, { viewTiles: number[] }>; habitatAt(): unknown };
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
    staff: new Map(),
    world: { habitats: new Map(), habitatAt: () => ({ id: 1 }) },
  };
  let tool: Tool = { kind: 'select' };
  const button = new FakeEl() as unknown as HTMLElement;
  const host: CoachHost = {
    sim: sim as unknown as ISimulation,
    tool: () => ({ tool, moving: false }),
    openCategory: () => null,
    categoryButton: () => button,
    card: () => null,
    drawer: () => null,
    toolBar: () => null,
    confirmBar: () => null,
    viewArea: () => ({ x0: 10, y0: 60, x1: 905, y1: 330 }),
    workRect: () => null,
    busy: () => false,
    endTool: vi.fn(() => (tool = { kind: 'select' })),
    bubbleMoved: vi.fn(),
    openBuildCategory: vi.fn(),
    openGoals: vi.fn(),
    toast: vi.fn(),
  };
  const coach = new Coach(host);
  return { sim, host, coach, setTool: (t: Tool) => (tool = t) };
}

/** Texts of the bubble's step counter and body (the fake DOM keeps them on the child elements). */
function bubbleTexts(c: Coach): string[] {
  const priv = c as unknown as { bubbleStep: FakeEl; bubbleTitle: FakeEl; bubbleText: FakeEl; bubble: FakeEl };
  if (priv.bubble.classList.contains('hidden')) return [];
  return [priv.bubbleStep.textContent, priv.bubbleTitle.textContent, priv.bubbleText.textContent];
}

describe('Coach', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('document', { createElement: () => new FakeEl() });
    vi.stubGlobal('window', { innerWidth: 915, innerHeight: 412 });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('runs the tour in a new zoo and moves on as each step is done, remembering how far it got', () => {
    const { sim, coach } = setup();
    coach.update(1);
    expect(bubbleTexts(coach)).toEqual(['1/5', 'Fence a habitat', 'Animals live in fenced habitats. Tap Habitat to build one.']);
    expect((coach.pill as unknown as FakeEl).classList.contains('hidden')).toBe(true); // the tour speaks for now
    sim.world.habitats.set(1, { viewTiles: [] });
    coach.update(1);
    expect(bubbleTexts(coach).slice(0, 2)).toEqual(['2/5', 'Shape the ground']);
    expect(store.get('wildhaven-tour')).toBe('1');
    coach.terrainPainted({ x0: 3, z0: 3, x1: 4, z1: 4 }); // inside the habitat
    coach.update(1);
    expect(bubbleTexts(coach).slice(0, 2)).toEqual(['3/5', 'Adopt an animal']);
    // a reload resumes at the step reached, painting included
    const again = new Coach((coach as unknown as { host: CoachHost }).host);
    again.update(1);
    expect(bubbleTexts(again)[0]).toBe('3/5');
  });

  it('finishes with a toast once the last step is done, and never shows again', () => {
    const { sim, coach, host } = setup();
    sim.world.habitats.set(1, { viewTiles: [5] });
    coach.terrainPainted({ x0: 0, z0: 0, x1: 0, z1: 0 });
    sim.animals.set(1, {});
    sim.staff.set(1, { role: 'keeper' });
    coach.update(1);
    expect(bubbleTexts(coach)).toEqual([]);
    expect(host.toast).toHaveBeenCalledTimes(1);
    expect(store.get('wildhaven-tour')).toBe('done');
    coach.reset(); // e.g. New Zoo
    sim.animals.clear();
    coach.update(1);
    expect(bubbleTexts(coach)).toEqual([]);
  });

  it('stays out of an existing zoo and can be skipped', () => {
    const old = setup({ animals: 3 });
    old.coach.update(1);
    expect(bubbleTexts(old.coach)).toEqual([]);
    // the pill shows the first open goal without its how-to
    const pill = old.coach.pill as unknown as FakeEl;
    expect(pill.classList.contains('hidden')).toBe(false);
    const priv = old.coach as unknown as { pillText: FakeEl; pillReward: FakeEl };
    expect(priv.pillText.textContent).toBe('Build your first habitat');
    expect(priv.pillReward.textContent).toBe('+$2,000');
    expect(store.has('wildhaven-tour')).toBe(false); // a later New Zoo still gets the tour

    const fresh = setup();
    fresh.coach.update(1);
    (fresh.coach as unknown as { finish(done: boolean): void }).finish(false); // the bubble's × button
    expect(store.get('wildhaven-tour')).toBe('done');
    expect(fresh.host.toast).not.toHaveBeenCalled();
  });

  it('docks in a top corner of the view while a tool is in hand, away from what is being built', () => {
    const { coach, host, setTool } = setup();
    const bubble = coach.bubble as unknown as FakeEl;
    coach.update(1);
    expect(bubble.classList.contains('docked')).toBe(false); // first it points at the Habitat button
    expect(coach.dockedRect).toBeNull();
    setTool({ kind: 'fence', fenceId: 1 });
    coach.update(1);
    expect(bubbleTexts(coach)[2]).toBe('Drag a rectangle on open grass. Keep paths outside it.');
    expect(bubble.classList.contains('docked')).toBe(true);
    // top-left, just under the top bar (the fake bubble is 200 × 50)
    expect(coach.rect).toEqual({ left: 10, top: 66, right: 210, bottom: 116 });
    expect(coach.dockedRect).toEqual(coach.rect);
    // a fence dragged into that corner sends it to the other one
    host.workRect = () => ({ left: 120, top: 90, right: 400, bottom: 200 });
    coach.update(1);
    expect(coach.rect).toEqual({ left: 705, top: 66, right: 905, bottom: 116 });
    expect(bubble.classList.contains('faded')).toBe(false);
    // one that spans the whole top of the view: the bubble fades so the work shows through
    host.workRect = () => ({ left: 0, top: 70, right: 915, bottom: 200 });
    coach.update(1);
    expect(bubble.classList.contains('faded')).toBe(true);
    expect(host.bubbleMoved).toHaveBeenCalled();
    // while another category is being browsed the bubble keeps out of the way
    setTool({ kind: 'select' });
    host.openCategory = () => 'nature';
    coach.update(1);
    expect(bubbleTexts(coach)).toEqual([]);
    expect(coach.rect).toBeNull();
  });

  it('puts the tool of a finished step away, but not another tool', () => {
    const { sim, coach, host, setTool } = setup();
    setTool({ kind: 'fence', fenceId: 1 });
    coach.update(1);
    sim.world.habitats.set(1, { viewTiles: [] }); // the fence went up
    coach.update(1);
    expect(host.endTool).toHaveBeenCalledTimes(1);
    expect(bubbleTexts(coach).slice(0, 2)).toEqual(['2/5', 'Shape the ground']);
    // step 2 is done while the player holds a path tool: that one stays
    setTool({ kind: 'path', pathType: 1 });
    coach.update(1);
    coach.terrainPainted({ x0: 0, z0: 0, x1: 0, z1: 0 });
    coach.update(1);
    expect(bubbleTexts(coach)[0]).toBe('3/5');
    expect(host.endTool).toHaveBeenCalledTimes(1);
  });

  it("shows how far along the next goal is, and drops the goal's verb rather than cut it off", () => {
    const { sim, coach } = setup({ animals: 1 });
    const priv = coach as unknown as { pillText: FakeEl; pillProgress: FakeEl; pillReward: FakeEl; pillTrack: FakeEl; pillBar: FakeEl };
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
  });

  it('opens the build category for a goal, or the Goals tab', () => {
    const { sim, coach, host } = setup({ animals: 1 });
    (coach as unknown as { pillTapped(): void }).pillTapped();
    expect(host.openBuildCategory).toHaveBeenCalledWith('habitats');
    sim.objectives = [{ id: 'guests_25', text: 'Welcome 25 guests in a single day', done: false, reward: 2500 }];
    (coach as unknown as { pillTapped(): void }).pillTapped();
    expect(host.openGoals).toHaveBeenCalled();
  });

  it('points at the card from beside a tool bar over the drawer, never over the drawer title (800x360)', () => {
    const { coach, host, setTool } = setup();
    const bubble = coach.bubble as unknown as FakeEl;
    // a real bubble wraps to the max-width it is given: 240 × 50 wide open, two text lines when narrower
    Object.defineProperty(bubble, 'offsetWidth', { get: () => Math.min(240, parseFloat(bubble.style.maxWidth) || 240) });
    Object.defineProperty(bubble, 'offsetHeight', { get: () => (bubble.offsetWidth < 240 ? 68 : 50) });
    const at = (r: { left: number; top: number; right: number; bottom: number }) => ({ getBoundingClientRect: () => ({ ...r, width: r.right - r.left, height: r.bottom - r.top }) }) as unknown as HTMLElement;
    const drawer = { left: 10, top: 133, right: 790, bottom: 290 };
    const toolBar = { left: 208, top: 80, right: 592, bottom: 125 };
    host.viewArea = () => ({ x0: 8, y0: 58, x1: 792, y1: 360 });
    host.openCategory = () => 'habitats';
    host.drawer = () => at(drawer);
    host.card = () => at({ left: 50, top: 172, right: 142, bottom: 280 }); // Timber Rail Fence
    host.toolBar = () => at(toolBar);
    // another tool of the category in hand (its tool bar sits over the drawer)
    setTool({ kind: 'terrain', terrain: 1, brush: 1 });
    coach.update(1);
    expect(bubbleTexts(coach)[2]).toBe('Pick a fence: timber rails suit grazers.');
    const r = coach.rect!;
    expect(r.right).toBeLessThanOrEqual(toolBar.left); // beside the tool bar, on the card's side
    expect(r.left).toBeGreaterThanOrEqual(8);
    expect(r.top).toBeGreaterThanOrEqual(62); // under the top HUD
    expect(r.bottom).toBeLessThanOrEqual(drawer.top + 8); // the drawer's top padding at most
    // with room below the tool bar it goes there, centred on the card
    host.toolBar = () => at({ ...toolBar, top: 10, bottom: 50 });
    coach.update(1);
    expect(coach.rect).toEqual({ left: 8, top: 71, right: 248, bottom: 121 });
    // the step's own tool already in hand: nothing to pick, so no bubble over the drawer
    setTool({ kind: 'fence', fenceId: 1 });
    coach.update(1);
    expect(bubbleTexts(coach)).toEqual([]);
  });

  it('counts build-mode entries for the camera tip', () => {
    const { coach } = setup();
    const shown = Array.from({ length: 7 }, () => coach.buildModeEntered());
    expect(shown).toEqual([true, true, true, true, true, false, false]);
  });
});
