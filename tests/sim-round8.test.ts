// Focused tests for the round-8 leftovers: the day-close summary counts the visitors a full zoo
// turned away, and the price and litter complaints are a toast when they start, then log lines.

import { describe, expect, it } from 'vitest';
import { ENTRANCE_TILE, MAP_W, TILE } from '../src/core/constants';
import type { LedgerEntry } from '../src/core/types';
import { daySummary, emptyLedger, type Simulation } from '../src/sim/simulation';
import { buildZoo, buyHerd, hire, newSim } from './sim-helpers';

type Log = ReturnType<typeof newSim>['log'];
type Note = { text: string; kind: string; focus?: { x: number; z: number }; logOnly?: boolean };
const notes = (log: Log, re: RegExp) => log.filter((e) => e.type === 'notify').map((e) => e.payload as Note).filter((n) => re.test(n.text));
const GATE = { x: (ENTRANCE_TILE.x + 0.5) * TILE, z: (ENTRANCE_TILE.z - 0.5) * TILE };

/** Run at speed 3 until the clock reaches `minute` on `day`, calling `each` every step. */
function runTo(sim: Simulation, minute: number, day: number, each?: () => void) {
  sim.setSpeed(3);
  while (sim.day < day || (sim.day === day && sim.minuteOfDay < minute)) {
    each?.();
    sim.update(0.1);
  }
}

describe('day-close summary', () => {
  const day = (p: Partial<LedgerEntry>): LedgerEntry => ({ ...emptyLedger(4), ...p });

  it('adds the visitors a full zoo turned away, only when there were any', () => {
    const d = day({ income: 2211, admissions: 2211, expenses: 2000, salaries: 1500, upkeep: 500 });
    expect(daySummary(d).text).toBe('Day 4 closed: +$211 (income $2,211, running costs $2,000)');
    expect(daySummary(d, 0.4).text).toBe('Day 4 closed: +$211 (income $2,211, running costs $2,000)');
    expect(daySummary(d, 63.25).text).toBe('Day 4 closed: +$211 (income $2,211, running costs $2,000) — zoo\u00a0full, 63 visitors turned away');
    expect(daySummary(d, 1).text).toMatch(/ — zoo\u00a0full, 1 visitor turned away$/);
    const building = day({ income: 500, admissions: 500, expenses: 1100, construction: 600, upkeep: 500 });
    expect(daySummary(building, 9).text).toBe('Day 4 closed: −$600 (building $600; daily running +$0) — zoo\u00a0full, 9 visitors turned away');
    // a full zoo is not a money problem: the kind still follows the running result
    expect(daySummary(d, 63).kind).toBe('info');
  });

  it('gives the day’s final count, after the log-only “Zoo full” note gave the first one', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    hire(sim);
    sim.guestSys.full = () => true;
    runTo(sim, 23 * 60 + 59, 1);
    const total = Math.round(sim.turnedAwayToday);
    expect(total).toBeGreaterThan(10);
    runTo(sim, 1, 2);
    const close = notes(log, /^Day 1 closed:/);
    expect(close.length).toBe(1);
    expect(close[0].text).toMatch(new RegExp(` — zoo\u00a0full, ${total} visitors turned away$`));
    expect(notes(log, /^Zoo full — /)[0].text).not.toContain(`${total} visitors`);
  }, 60_000);
});

describe('lasting guest complaints', () => {
  it('too high a price: one toast, then log lines at the gate on the following days', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    hire(sim);
    sim.setAdmission(200);
    runTo(sim, 14 * 60, 3);
    const price = notes(log, /^Many visitors turned away at the gate/);
    expect(price.length).toBeGreaterThanOrEqual(3);
    expect(price[0].logOnly).toBeUndefined();
    expect(price.slice(1).every((n) => n.logOnly)).toBe(true);
    for (const n of price) expect(n.focus).toEqual(GATE);
  }, 90_000);

  it('litter: one toast while it goes on day after day, and a new toast when it comes back after a clean day', () => {
    const { sim, log } = newSim(11);
    const tile = 40 * MAP_W + 30;
    // three parties see litter on one path tile all through the opening hours of the given days
    const litterOn = (days: number[]) => () => {
      if (days.includes(sim.day) && sim.minuteOfDay > 9 * 60 && sim.minuteOfDay < 18 * 60)
        for (const id of [1, 2, 3]) sim.progress.noteLitter(id, tile, 5);
    };
    const each = litterOn([1, 2, 5]);
    runTo(sim, 12 * 60, 5, each);
    const litter = notes(log, /^Guests are disgusted by the litter/);
    const byDay = (d: number) => litter.filter((_, i) => noteDay(log, litter[i]) === d);
    expect(byDay(1)[0].logOnly).toBeUndefined();
    expect([...byDay(1).slice(1), ...byDay(2)].every((n) => n.logOnly)).toBe(true);
    expect(byDay(2).length).toBeGreaterThan(0);
    // days 3 and 4 were clean: on day 5 it is news again
    expect(byDay(5)[0].logOnly).toBeUndefined();
    for (const n of litter) expect(n.focus).toEqual({ x: 30.5 * TILE, z: 40.5 * TILE });
  }, 90_000);
});

/** The day a notify payload was sent on (the dayChanged events before it). */
function noteDay(log: Log, note: Note): number {
  let day = 1;
  for (const e of log) {
    if (e.type === 'dayChanged') day = (e.payload as { day: number }).day;
    if (e.payload === note) return day;
  }
  return -1;
}
