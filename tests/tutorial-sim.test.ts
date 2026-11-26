// The whole tutorial on a real Simulation (tutorial.md §11.1): for 5 seeds each step is done
// with the game's own commands (the yellow spots) and synthetic UI facts, in order, with the
// clock held until Play, under $10,000 of spending; the save round-trips the progress blob.
import { describe, expect, it } from 'vitest';
import { TILE } from '../src/core/constants';
import { EventBus } from '../src/core/events';
import { PathType, Terrain, type CommandResult } from '../src/core/types';
import { createSimulation, NEW_ZOO_START_MINUTE } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';
import { hintFor, simFacts, type Facts, type UIFacts, type WorldHint } from '../src/ui/tutorial/facts';
import { TutorialMachine, type TutorialView } from '../src/ui/tutorial/machine';
import { findPlot, habitatRect, inset } from '../src/ui/tutorial/plot';
import { STEP_IDS, type StepId } from '../src/ui/tutorial/script';

const UI: UIFacts = { category: null, tool: { kind: 'select' }, moving: false, pending: null, sheet: null, sheetOpen: false, zooOpen: false, zooTab: null, dialog: false, pointer: 'touch' };

/** A machine driven by a real sim, with the controller's bookkeeping (clock, corridor, hint). */
export class Driver {
  readonly events = new EventBus();
  readonly sim: Simulation;
  readonly m = new TutorialMachine({ versusEnabled: false });
  now = 0;
  spend = 0;
  order: StepId[] = [];
  speedAtStart: Partial<Record<StepId, number>> = {};
  hint: WorldHint | null = null;
  v: TutorialView | null = null;
  ui: UIFacts = { ...UI };

  constructor(seed: number) {
    this.sim = createSimulation(this.events, seed) as Simulation;
    this.sim.newGame(seed, { startMinute: NEW_ZOO_START_MINUTE });
    this.m.start('first', 0);
    this.m.plot = findPlot(this.sim);
    this.m.objBase = this.sim.starterObjectMaxId;
    this.apply();
    this.m.begin(0);
  }

  /** Carry out the machine's effects the way the controller does (clock and the step log). */
  apply(): void {
    for (const e of this.m.drain()) {
      if (e.kind === 'clock' && e.mode === 'hold') this.sim.setSpeed(0);
      if (e.kind === 'emit' && e.state === 'start') {
        this.order.push(e.step as StepId);
        this.speedAtStart[e.step as StepId] = this.sim.speed;
      }
    }
  }

  facts(extra: Partial<UIFacts> = {}): Facts {
    const m = this.m;
    const sf = simFacts(this.sim, { plot: m.plot, homeHabitat: m.homeHabitat, animalId: m.animalId, objBase: m.objBase });
    const step = m.hintStep;
    const hc = { plot: m.plot, homeHabitat: m.homeHabitat, animalId: m.animalId, speciesId: m.speciesId, corridor: m.corridor, regressed: !!m.current && m.regressed.has(m.current) };
    this.hint = step ? hintFor(step, this.sim, hc, sf.gap) : null;
    return { ...sf, ...this.ui, ...extra, now: this.now, hint: this.hint };
  }

  tick(extra: Partial<UIFacts> = {}): TutorialView {
    this.now += 125;
    const v = this.m.tick(this.facts(extra));
    if (v.step === 'path' && this.hint?.kind === 'tiles') this.m.corridor = this.hint.tiles.map((t) => ({ ...t }));
    this.apply();
    this.v = v;
    return v;
  }

  cmd(r: CommandResult): CommandResult {
    expect(r.ok, r.reason).toBe(true);
    if (r.cost > 0) this.spend += r.cost;
    return r;
  }

  /** The current step's hint, refreshed. */
  spot(): WorldHint {
    this.facts();
    expect(this.hint, `hint for ${this.m.current}`).not.toBeNull();
    return this.hint!;
  }
}

/** Do one step the way a player would (the yellow marker, the game's own commands). */
export function doStep(d: Driver, step: StepId): void {
  const sim = d.sim;
  const w = sim.world;
  const m = d.m;
  switch (step) {
    case 'look-pan':
      m.note({ kind: 'gesture', g: { pan: 160, zoom: 0, turn: 0, tilt: 0, fingers: 1, tap: false } });
      break;
    case 'look-zoom':
      m.note({ kind: 'gesture', g: { pan: 0, zoom: 0.5, turn: 0, tilt: 0, fingers: 2, tap: false } });
      break;
    case 'look-turn':
      m.note({ kind: 'gesture', g: { pan: 0, zoom: 0.05, turn: 40, tilt: 0, fingers: 2, tap: false } });
      break;
    case 'fence': {
      const h = d.spot();
      expect(h.kind).toBe('box');
      if (h.kind === 'box') d.cmd(sim.placeFences(w.edgesAroundRect(h.rect), 1));
      break;
    }
    case 'paint': {
      const r = inset(habitatRect(w, m.homeHabitat)!, 1);
      d.cmd(sim.paintTerrain(r, Terrain.DryGrass));
      m.note({ kind: 'painted', inHabitat: true });
      break;
    }
    case 'water':
    case 'shelter':
    case 'plant':
    case 'kiosk':
    case 'bench':
    case 'bin': {
      const def = { water: 'water_trough', shelter: 'shelter_wood', plant: 'grass_tall', kiosk: 'shop_snack', bench: 'bench', bin: 'bin' }[step];
      const h = d.spot();
      expect(h.kind, step).toBe('spot');
      if (h.kind === 'spot') d.cmd(sim.placeObject(def, h.spot.tx, h.spot.tz, h.spot.rot));
      break;
    }
    case 'adopt': {
      const h = d.spot();
      if (h.kind === 'spot') d.cmd(sim.buyAnimal('zebra', (h.spot.tx + 0.5) * TILE, (h.spot.tz + 0.5) * TILE));
      break;
    }
    case 'happy': {
      const a = [...sim.animals.values()][0];
      d.tick({ sheet: { kind: 'animal', id: a.id }, sheetOpen: true });
      m.note({ kind: 'gotIt' });
      d.ui = { ...UI, sheet: { kind: 'animal', id: a.id }, sheetOpen: true };
      break;
    }
    case 'path': {
      d.ui = { ...UI };
      const h = d.spot();
      expect(h.kind).toBe('tiles');
      if (h.kind === 'tiles') d.cmd(sim.placePaths(h.tiles, PathType.Paved));
      break;
    }
    case 'keeper': {
      const h = d.spot();
      if (h.kind === 'tiles') d.cmd(sim.hireStaff('keeper', (h.tiles[0].x + 0.5) * TILE, (h.tiles[0].z + 0.5) * TILE));
      break;
    }
    case 'play':
      sim.setSpeed(1);
      break;
    case 'guests': {
      expect(sim.welcomeFirstGuests()).toBe(true);
      expect(sim.welcomeFirstGuests()).toBe(false); // guests are in now
      for (let i = 0; i < 600 && d.tick().step === 'guests'; i++) sim.update(0.1);
      break;
    }
    case 'money':
      m.note({ kind: 'zooShown', tab: 'finance' });
      d.tick({ zooOpen: true, zooTab: 'finance' });
      m.note({ kind: 'zooClosed' });
      break;
    case 'goal':
      m.note({ kind: 'pillTapped' });
      break;
    case 'speed':
      sim.setSpeed(3);
      break;
    case 'speed-note':
      m.note({ kind: 'gotIt' });
      break;
  }
}

const SEEDS = [7, 21, 303, 562, 1234];

describe('tutorial on a real simulation', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: every step in order, clock held until Play, spend < $10,000, finish`, () => {
      const d = new Driver(seed);
      const money0 = d.sim.money;
      expect(d.tick().step).toBe('look-pan');
      for (const id of STEP_IDS) {
        expect(d.m.current, `before ${id}`).toBe(id);
        doStep(d, id);
        if (id === 'happy') {
          // the save keeps the progress blob midway
          d.sim.tutorial = d.m.blob() as unknown as Record<string, unknown>;
          const save = JSON.parse(JSON.stringify(d.sim.serialize()));
          const sim2 = createSimulation(new EventBus(), seed) as Simulation;
          sim2.load(save);
          expect(sim2.tutorial).toEqual(d.sim.tutorial);
          const m2 = new TutorialMachine({ versusEnabled: false });
          expect(m2.resume(sim2.tutorial, 0)).toBe(true);
          expect([...m2.passed]).toEqual([...d.m.passed]);
          expect(m2.homeHabitat).toBe(d.m.homeHabitat);
        }
        const v = d.tick();
        if (id !== 'speed-note') expect(v.step, `after ${id}`).not.toBe(id);
      }
      expect(d.v!.status).toBe('finish');
      expect(d.order).toEqual([...STEP_IDS]);
      for (const id of STEP_IDS.slice(0, STEP_IDS.indexOf('play') + 1)) expect(d.speedAtStart[id], `speed entering ${id}`).toBe(0);
      expect(d.spend).toBeLessThan(10_000);
      expect(d.spend).toBeGreaterThan(7_000);
      expect(d.sim.money).toBeGreaterThan(money0 - 10_000);
      expect(d.m.blob()).toBeNull();
      expect(d.sim.world.habitats.size).toBe(1);
    });
  }

  it('welcomeFirstGuests: once when open with the gate open; never with the gate shut, the zoo closed or guests in', () => {
    const d = new Driver(7);
    expect(d.sim.welcomeFirstGuests()).toBe(false); // nothing on view: the gate is shut
    d.tick();
    for (const id of STEP_IDS.slice(0, STEP_IDS.indexOf('play'))) {
      doStep(d, id);
      d.tick();
    }
    d.sim.minuteOfDay = 22 * 60; // closed
    expect(d.sim.welcomeFirstGuests()).toBe(false);
    d.sim.minuteOfDay = 9 * 60;
    expect(d.sim.welcomeFirstGuests()).toBe(true);
    expect(d.sim.welcomeFirstGuests()).toBe(false);
  });

  it('the clock is never held again once Play has passed, even when a step regresses', () => {
    const d = new Driver(21);
    d.tick();
    for (const id of STEP_IDS.slice(0, STEP_IDS.indexOf('guests') + 1)) {
      doStep(d, id);
      d.tick();
    }
    expect(d.m.current).toBe('money');
    const keeper = [...d.sim.staff.values()].find((s) => s.role === 'keeper')!;
    expect(d.sim.fireStaff(keeper.id).ok).toBe(true);
    expect(d.tick().step).toBe('keeper');
    expect(d.sim.speed).toBeGreaterThan(0);
  });
});
