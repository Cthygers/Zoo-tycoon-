// Focused tests for the round-10 sim changes: a player's New Zoo starts at 08:30 through a
// new-game option (the default start and the demo keep 07:30), and the 'last shown' times of
// notifications are saved, so an ongoing complaint stays a log line after Continue.

import { describe, expect, it } from 'vitest';
import type { SimSave } from '../src/core/contracts';
import { START_MINUTE } from '../src/core/constants';
import { EventBus } from '../src/core/events';
import { NEW_ZOO_START_MINUTE, createSimulation } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';
import { buildZoo, buyHerd, hire, newSim } from './sim-helpers';

type Note = { text: string; logOnly?: boolean };

describe('new zoo start time', () => {
  it('starts at 07:30 by default and at the requested minute for a New Zoo', () => {
    const { sim } = newSim(3);
    expect(sim.minuteOfDay).toBe(START_MINUTE);
    expect(NEW_ZOO_START_MINUTE).toBe(8 * 60 + 30);
    sim.update(5);
    sim.newGame(3, { startMinute: NEW_ZOO_START_MINUTE });
    expect(sim.day).toBe(1);
    expect(sim.minuteOfDay).toBe(NEW_ZOO_START_MINUTE);
    expect(sim.isOpen()).toBe(true);
    // the option is per call: the next plain newGame is back to 07:30
    sim.newGame(3);
    expect(sim.minuteOfDay).toBe(START_MINUTE);
  });
});

describe('notification throttles across a save', () => {
  it('an ongoing complaint is a log line after Continue, not a new toast', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    hire(sim);
    const c = sim.progress.complaints;
    sim.setSpeed(3);
    // the complaint starts (a toast) and goes on for a while
    while (sim.minuteOfDay < 12 * 60) {
      c.drink = 1000;
      sim.update(0.1);
    }
    const before = log.filter((e) => e.type === 'notify').map((e) => e.payload as Note).filter((n) => /^Thirsty guests|^Guests are thirsty/.test(n.text));
    expect(before.length).toBeGreaterThanOrEqual(1);
    expect(before[0].logOnly).toBeFalsy();
    const save = JSON.parse(JSON.stringify(sim.serialize())) as SimSave & { notifyLast?: [string, number][] };
    expect(save.notifyLast?.some(([k]) => k === 'cmp-drink')).toBe(true);

    const events = new EventBus();
    const notes: Note[] = [];
    events.on('notify', (n) => notes.push(n as Note));
    const cont = createSimulation(events, 1) as Simulation;
    cont.load(save);
    cont.setSpeed(3);
    while (cont.minuteOfDay < 16 * 60) {
      cont.progress.complaints.drink = 1000;
      cont.update(0.1);
    }
    const drinks = notes.filter((n) => /^Thirsty guests|^Guests are thirsty/.test(n.text));
    expect(drinks.length).toBeGreaterThanOrEqual(1);
    expect(drinks.every((n) => n.logOnly)).toBe(true);

    // an older save without the field loads and toasts the complaint once, as before
    delete save.notifyLast;
    const oldNotes: Note[] = [];
    const ev2 = new EventBus();
    ev2.on('notify', (n) => oldNotes.push(n as Note));
    const old = createSimulation(ev2, 1) as Simulation;
    old.load(save);
    old.setSpeed(3);
    while (old.minuteOfDay < 13 * 60) {
      old.progress.complaints.drink = 1000;
      old.update(0.1);
    }
    const oldDrinks = oldNotes.filter((n) => /^Thirsty guests|^Guests are thirsty/.test(n.text));
    expect(oldDrinks[0]?.logOnly).toBeFalsy();
  }, 90_000);

  it('saves only recent throttles', () => {
    const { sim } = newSim(4);
    sim.notify('long-ago', 'Something happened.', 'info');
    sim.time += 10_000;
    sim.notify('just-now', 'Something else happened.', 'info');
    const keys = (sim.serialize() as SimSave & { notifyLast: [string, number][] }).notifyLast.map(([k]) => k);
    expect(keys).toContain('just-now');
    expect(keys).not.toContain('long-ago');
  });
});
