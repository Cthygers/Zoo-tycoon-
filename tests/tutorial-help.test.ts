// "Help me" (spec §6.3, T2): every step can be done for the child through the normal commands,
// and the button appears after 3 attempts or 60 s without progress. The whole tutorial runs
// here on a real Simulation using nothing but Help me (plus Got it on the animal's sheet).
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import type { SimSpeed } from '../src/core/contracts';
import type { CommandResult, SelectionRef } from '../src/core/types';
import { createSimulation, NEW_ZOO_START_MINUTE } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';
import { hintFor, simFacts, type Facts, type HintContext, type UIFacts } from '../src/ui/tutorial/facts';
import { runHelp, type HelpHost } from '../src/ui/tutorial/help';
import { HELP_AFTER_MS, TutorialMachine } from '../src/ui/tutorial/machine';
import { findPlot } from '../src/ui/tutorial/plot';
import { STEP_IDS, type StepId } from '../src/ui/tutorial/script';

const UI: UIFacts = { category: null, tool: { kind: 'select' }, moving: false, pending: null, sheet: null, sheetOpen: false, zooOpen: false, zooTab: null, dialog: false, pointer: 'touch' };

class Rig {
  readonly events = new EventBus();
  readonly sim: Simulation;
  readonly m = new TutorialMachine({ versusEnabled: false });
  now = 0;
  ui: UIFacts = { ...UI };
  log: string[] = [];
  commands = 0;
  host: HelpHost;

  constructor(seed: number) {
    this.sim = createSimulation(this.events, seed) as Simulation;
    this.sim.newGame(seed, { startMinute: NEW_ZOO_START_MINUTE });
    this.m.start('first', 0);
    this.m.plot = findPlot(this.sim);
    this.m.objBase = this.sim.starterObjectMaxId;
    this.m.begin(0);
    // what the controller wires: painting inside a habitat counts, the zoo menu and the pill report back
    this.events.on('terrainChanged', (r) => {
      if (this.m.current !== 'paint') return;
      const w = this.sim.world;
      let inside = false;
      for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) if (w.habitatOf[w.idx(x, z)]) inside = true;
      this.m.note({ kind: 'painted', inHabitat: inside });
    });
    const rig = this;
    this.host = {
      sim: this.sim,
      runCommand(fn: () => CommandResult) {
        rig.commands++;
        return fn();
      },
      select(s: SelectionRef | null) {
        rig.log.push(`select:${s?.kind}`);
        rig.ui = s ? { ...rig.ui, sheet: s, sheetOpen: true } : { ...rig.ui, sheet: null, sheetOpen: false };
      },
      setSpeed(s: SimSpeed) {
        rig.sim.setSpeed(s);
        return true;
      },
      openMenu(tab?: string) {
        rig.log.push(`menu:${tab}`);
        rig.ui = { ...rig.ui, zooOpen: true, zooTab: tab ?? 'finance' };
        rig.m.note({ kind: 'zooShown', tab: tab ?? 'finance' });
      },
      async cameraDemo(kind) {
        rig.log.push(`demo:${kind}`);
      },
      tapPill() {
        rig.log.push('pill');
        rig.m.note({ kind: 'pillTapped' });
      },
    };
  }

  hc(): HintContext {
    const m = this.m;
    return { plot: m.plot, homeHabitat: m.homeHabitat, animalId: m.animalId, speciesId: m.speciesId, corridor: m.corridor, regressed: !!m.current && m.regressed.has(m.current) };
  }

  facts(): Facts {
    const m = this.m;
    const sf = simFacts(this.sim, { plot: m.plot, homeHabitat: m.homeHabitat, animalId: m.animalId, objBase: m.objBase });
    const step = m.hintStep;
    const hint = step ? hintFor(step, this.sim, this.hc(), sf.gap) : null;
    return { ...sf, ...this.ui, now: this.now, hint };
  }

  tick() {
    this.now += 125;
    const f = this.facts();
    const v = this.m.tick(f);
    if (v.step === 'path' && f.hint?.kind === 'tiles') this.m.corridor = f.hint.tiles.map((t) => ({ ...t }));
    for (const e of this.m.drain()) if (e.kind === 'clock' && e.mode === 'hold') this.sim.setSpeed(0);
    return v;
  }

  async help(): Promise<boolean> {
    const step = this.m.current!;
    const sf = simFacts(this.sim, { plot: this.m.plot, homeHabitat: this.m.homeHabitat, animalId: this.m.animalId, objBase: this.m.objBase });
    const out = await runHelp(step, this.host, this.hc(), sf.gap);
    if (out.ok) this.m.note({ kind: 'helped' });
    else this.m.note({ kind: 'helpFailed' });
    return out.ok;
  }
}

describe('tutorial Help me', () => {
  for (const seed of [7, 81]) {
    it(`seed ${seed}: every help action leaves its step done (the whole tutorial by Help me)`, async () => {
      const r = new Rig(seed);
      expect(r.tick().step).toBe('look-pan');
      for (const id of STEP_IDS) {
        expect(r.m.current, `at ${id}`).toBe(id);
        expect(await r.help(), `help ${id}`).toBe(true);
        if (id === 'happy') {
          // the help opened the animal's sheet; it completes on Got it as usual
          const v = r.tick();
          expect(v.step).toBe('happy');
          expect(v.phase).toBe('sheet');
          r.m.note({ kind: 'gotIt' });
          r.ui = { ...UI };
        }
        if (id === 'guests') {
          // the help let the first party in (and started the clock); they walk in
          for (let i = 0; i < 600 && r.tick().step === 'guests'; i++) r.sim.update(0.1);
        }
        if (id === 'money') r.ui = { ...UI }; // the child closes the menu afterwards
        const v = r.tick();
        if (id === 'speed-note') expect(v.status).toBe('finish');
        else expect(v.step, `after helping with ${id}`).not.toBe(id);
      }
      expect(r.log).toEqual(expect.arrayContaining(['demo:pan', 'demo:zoom', 'demo:turn', 'select:animal', 'menu:finance', 'pill']));
      expect(r.sim.world.habitats.size).toBe(1);
      expect([...r.sim.staff.values()].some((s) => s.role === 'keeper')).toBe(true);
      expect(r.sim.speed).toBe(3);
    });
  }

  it('Help me shows after 3 attempts (failed fence drags) and not before', () => {
    const r = new Rig(7);
    r.m.debugPassBefore('fence');
    r.tick();
    const fence = { kind: 'fence' as const, fenceId: 1 };
    const bad = { kind: 'fence' as const, ok: true, risky: true, note: 'Not a habitat yet: fences can’t cross a path, so this one won’t close', noteKind: 'warning' as const };
    for (let i = 1; i <= 3; i++) {
      r.ui = { ...UI, tool: fence };
      expect(r.tick().phase).toBe('use'); // dragging again
      r.ui = { ...UI, tool: fence, pending: bad };
      const v = r.tick();
      expect(v.phase).toBe('invalid');
      expect(v.line).toBe('fence.invalid');
      expect(v.buttons.help, `after ${i} failed drags`).toBe(i >= 3);
    }
  });

  it('Help me shows after 60 s without progress, and progress resets the clock', () => {
    const r = new Rig(7);
    r.m.debugPassBefore('water');
    r.ui = { ...UI };
    expect(r.sim.placeFences(r.sim.world.edgesAroundRect(r.m.plot!), 1).ok).toBe(true);
    r.m.homeHabitat = [...r.sim.world.habitats.keys()][0];
    r.m.passed.add('fence');
    r.m.passed.add('paint');
    expect(r.tick().step).toBe('water');
    r.now += HELP_AFTER_MS - 2000;
    expect(r.tick().buttons.help).toBe(false);
    r.ui = { ...UI, category: 'animalfac' }; // progress: open → pick
    r.now += 1500;
    expect(r.tick().buttons.help).toBe(false);
    r.now += HELP_AFTER_MS - 1000;
    expect(r.tick().buttons.help).toBe(false);
    r.now += 2000;
    expect(r.tick().buttons.help).toBe(true);
  });

  it('a help that cannot be paid for shows the no-money line and Skip this step', async () => {
    const r = new Rig(7);
    r.m.debugPassBefore('kiosk');
    r.tick();
    r.sim.money = 100;
    expect(await r.help()).toBe(false);
    const v = r.tick();
    expect(v.line).toBe('nudge.noMoney');
    expect(v.text).toEqual({ a: 'Let time run.', w: 'You need more money first.' });
    expect(v.buttons.skipStep).toBe(true);
    r.m.note({ kind: 'skipStep' });
    expect(r.tick().step).not.toBe('kiosk');
  });

  it('a fence gap is fixed by Help me with the neighbouring fence type (T5)', async () => {
    const r = new Rig(7);
    r.m.debugPassBefore('fence');
    r.tick();
    expect(await r.help()).toBe(true);
    expect(r.tick().step).toBe('paint');
    // open the fence: one edge bulldozed
    const w = r.sim.world;
    const plot = r.m.plot!;
    const edge = { dir: 'v' as const, x: plot.x0, z: plot.z0 + 3 };
    expect(r.sim.removeFences([edge]).ok).toBe(true);
    expect(w.habitats.size).toBe(0);
    const v = r.tick();
    expect(v.step).toBe('fence');
    expect(v.line).toBe('fence.gap');
    expect(r.facts().hint).toEqual({ kind: 'edges', edges: [edge] });
    expect(await r.help()).toBe(true);
    expect(w.getFence(edge)).toBe(1);
    expect(w.habitats.size).toBe(1);
    expect(r.tick().step).toBe('paint');
  });

  it('help never applies to the speed note (Got it is the only action)', () => {
    const r = new Rig(7);
    r.m.debugPassBefore('speed-note');
    r.now = 10 * HELP_AFTER_MS;
    expect(r.tick().buttons.help).toBe(false);
    void (null as unknown as StepId);
  });
});
