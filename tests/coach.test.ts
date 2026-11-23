// First-run guidance (UX-4): when the coach-mark tour runs, how it advances and is
// remembered, the next-goal pill, and the build-mode camera tip count. A tiny fake DOM
// stands in for the few element methods the coach touches.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISimulation } from '../src/core/contracts';
import type { Objective, Tool } from '../src/core/types';
import { Coach, type CoachHost } from '../src/ui/coach';

class FakeEl {
  className = '';
  textContent = '';
  innerHTML = '';
  title = '';
  offsetWidth = 200;
  offsetHeight = 50;
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
  getBoundingClientRect() {
    return { left: 300, top: 340, width: 60, height: 56, right: 360, bottom: 396 };
  }
}

interface FakeSim {
  objectives: Objective[];
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
    hudBottom: () => 54,
    busy: () => false,
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

  it('points at the tool bar while the step’s tool is in hand', () => {
    const { coach, host, setTool } = setup();
    const bar = new FakeEl() as unknown as HTMLElement;
    host.toolBar = () => bar;
    setTool({ kind: 'fence', fenceId: 1 });
    coach.update(1);
    expect(bubbleTexts(coach)[2]).toBe('Drag a rectangle on open grass. Keep paths outside it.');
    // while another category is being browsed the bubble keeps out of the way
    setTool({ kind: 'select' });
    host.openCategory = () => 'nature';
    coach.update(1);
    expect(bubbleTexts(coach)).toEqual([]);
  });

  it('opens the build category for a goal, or the Goals tab', () => {
    const { sim, coach, host } = setup({ animals: 1 });
    (coach as unknown as { pillTapped(): void }).pillTapped();
    expect(host.openBuildCategory).toHaveBeenCalledWith('habitats');
    sim.objectives = [{ id: 'guests_25', text: 'Welcome 25 guests in a single day', done: false, reward: 2500 }];
    (coach as unknown as { pillTapped(): void }).pillTapped();
    expect(host.openGoals).toHaveBeenCalled();
  });

  it('counts build-mode entries for the camera tip', () => {
    const { coach } = setup();
    const shown = Array.from({ length: 7 }, () => coach.buildModeEntered());
    expect(shown).toEqual([true, true, true, true, true, false, false]);
  });
});
