// Versus: the locked 4× clock in the simulation (versus.md §2.1, §12.2; spec §5.1–§5.2).
import { describe, expect, it } from 'vitest';
import { LENGTHS, TEST_LENGTH, VERSUS_RULES_VERSION, type VersusRules } from '../shared/versus-rules';
import type { SimSave } from '../src/core/contracts';
import { EventBus, type GameEvents } from '../src/core/events';
import { createSimulation } from '../src/sim';
import { REFUND_FRACTION } from '../src/sim/commands';
import type { Simulation } from '../src/sim/simulation';
import { AVENUE, EX, buildZoo, buyHerd, hire } from './sim-helpers';

function rulesFor(lengthMin: 30 | 60 | 90 | 120 | 4, matchId = 'match-1', seed = 1234): VersusRules {
  const L = lengthMin === 4 ? TEST_LENGTH : LENGTHS[lengthMin];
  return { matchId, seed, lengthMin, days: L.days, rulesVersion: VERSUS_RULES_VERSION, startMoney: L.startMoney, startMinute: 510 };
}

function matchSim(lengthMin: 30 | 60 | 90 | 120 | 4 = 30, simSeed = 7) {
  const events = new EventBus();
  const sim = createSimulation(events, simSeed) as Simulation;
  const ended: GameEvents['versusEnded'][] = [];
  events.on('versusEnded', (e) => ended.push(e));
  sim.newGame(1234, { versus: rulesFor(lengthMin) });
  return { sim, events, ended };
}

/** Run until the match ends (or `maxCalls` frames). */
function runToEnd(sim: Simulation, frame = 0.25, maxCalls = 1e6) {
  let n = 0;
  while (!sim.versus!.ended && n++ < maxCalls) sim.update(frame);
  return n;
}

describe('versus clock: locked 4×', () => {
  it('starts a match at day 1 08:30 with the length start money and speed 3', () => {
    const { sim } = matchSim(30);
    expect(sim.versus).not.toBeNull();
    expect(sim.speed).toBe(3);
    expect(sim.day).toBe(1);
    expect(sim.minuteOfDay).toBe(510);
    expect(sim.money).toBe(100_000);
    expect(sim.paceScale).toBe(4);
    expect(sim.tutorial).toBeNull();
    expect(matchSim(120).sim.money).toBe(60_000);
  });

  it('setSpeed(0|1|2) leaves speed 3 during a match', () => {
    const { sim } = matchSim();
    for (const s of [0, 1, 2, 3] as const) {
      sim.setSpeed(s);
      expect(sim.speed).toBe(3);
    }
  });

  it('update(0.1) advances exactly 0.4 sim-s (1.2 game minutes), whatever speed says', () => {
    const { sim } = matchSim();
    sim.speed = 0; // a stray write cannot stop the match clock either
    const t0 = sim.time;
    const m0 = sim.minuteOfDay;
    sim.update(0.1);
    expect(sim.time - t0).toBeCloseTo(0.4, 9);
    expect(sim.minuteOfDay - m0).toBeCloseTo(1.2, 9);
  });

  for (const len of [30, 60, 90, 120] as const) {
    it(`a ${len}-minute match ends exactly at time ${LENGTHS[len].days * 480} on day ${LENGTHS[len].days + 1} 08:30`, () => {
      const { sim, ended } = matchSim(len);
      runToEnd(sim, 0.25);
      const N = LENGTHS[len].days;
      expect(sim.versus!.ended).toBe(true);
      expect(sim.versus!.endReason).toBe('complete');
      expect(sim.time).toBe(N * 480);
      expect(sim.day).toBe(N + 1);
      expect(sim.minuteOfDay).toBe(510);
      expect(sim.speed).toBe(0);
      expect(sim.versus!.hour).toBe(24 * N);
      expect(ended).toHaveLength(1);
      expect(ended[0]).toMatchObject({ reason: 'complete', hour: 24 * N });
      // frozen: more frames change nothing, and setSpeed cannot restart it
      const snap = { time: sim.time, day: sim.day, money: sim.money, total: sim.versus!.total(), parts: sim.versus!.parts() };
      sim.setSpeed(3);
      expect(sim.speed).toBe(0);
      for (let i = 0; i < 40; i++) sim.update(0.25);
      expect({ time: sim.time, day: sim.day, money: sim.money, total: sim.versus!.total(), parts: sim.versus!.parts() }).toEqual(snap);
      expect(ended).toHaveLength(1);
      expect(sim.versus!.gameSecondsLeft()).toBe(0);
    });
  }

  it('never steps past the end, even with a huge frame', () => {
    const { sim } = matchSim(4);
    while (sim.time < 959) sim.update(0.25);
    sim.update(0.5);
    sim.update(0.5);
    expect(sim.time).toBe(960);
    expect(sim.versus!.ended).toBe(true);
  });

  it('serialize → speed 0 or 1 → load gives speed 3; an ended match loads stopped', () => {
    const { sim, events } = matchSim(4);
    for (let i = 0; i < 40; i++) sim.update(0.25);
    for (const speed of [0, 1]) {
      const save = sim.serialize() as SimSave & { speed: number };
      save.speed = speed;
      const other = createSimulation(events, 3) as Simulation;
      other.load(save);
      expect(other.versus).not.toBeNull();
      expect(other.speed).toBe(3);
      other.setSpeed(1);
      expect(other.speed).toBe(3);
    }
    runToEnd(sim);
    const done = createSimulation(new EventBus(), 3) as Simulation;
    done.load({ ...sim.serialize(), speed: 3 } as SimSave);
    expect(done.versus!.ended).toBe(true);
    expect(done.speed).toBe(0);
    const t = done.time;
    done.update(0.25);
    expect(done.time).toBe(t);
  });

  it('a normal save loads with versus null and its own speed', () => {
    const events = new EventBus();
    const sim = createSimulation(events, 7) as Simulation;
    sim.newGame();
    sim.setSpeed(2);
    const save = sim.serialize();
    expect((save as Record<string, unknown>).versus).toBeUndefined();
    const other = createSimulation(events, 3) as Simulation;
    other.load(save);
    expect(other.versus).toBeNull();
    expect(other.speed).toBe(2);
    expect(other.paceScale).toBe(1);
  });

  it('a save with rulesVersion 99 throws "needs a newer version" and leaves the sim as it was', () => {
    const { sim } = matchSim(4);
    sim.update(0.25);
    const save = sim.serialize() as SimSave & { versus: { rules: VersusRules } };
    save.versus.rules.rulesVersion = 99;
    const other = createSimulation(new EventBus(), 3) as Simulation;
    other.newGame();
    const before = other.serialize();
    expect(() => other.load(save)).toThrow(/newer version/);
    expect(other.serialize()).toEqual(before);
    expect(other.versus).toBeNull();
  });

  it('newGame after a match gives versus null and speed 1', () => {
    const { sim } = matchSim(4);
    runToEnd(sim);
    sim.newGame();
    expect(sim.versus).toBeNull();
    expect(sim.speed).toBe(1);
    expect(sim.paceScale).toBe(1);
    sim.setSpeed(2);
    expect(sim.speed).toBe(2);
  });

  it('endNow("budget") freezes at the last completed hour', () => {
    const { sim, ended } = matchSim(4);
    while (sim.versus!.hour < 7) sim.update(0.25);
    // part of hour 8 is played: its guests' points are dropped by the freeze
    for (let i = 0; i < 10; i++) sim.update(0.25);
    const last = sim.versus!.lastSnapshot()!;
    expect(last.h).toBe(7);
    sim.versus!.endNow('budget');
    expect(sim.versus!.ended).toBe(true);
    expect(sim.versus!.endReason).toBe('budget');
    expect(sim.speed).toBe(0);
    expect(sim.versus!.parts()).toEqual(last.parts);
    expect(sim.versus!.total()).toBe(last.total);
    expect(ended).toEqual([{ reason: 'budget', hour: 7, total: last.total, parts: last.parts }]);
    const t = sim.time;
    sim.update(0.25);
    expect(sim.time).toBe(t);
    sim.versus!.endNow('budget');
    expect(ended).toHaveLength(1);
  });
});

describe('versus pace scaling (versus.md §3.3 T1, T2)', () => {
  it('T1: an object built 200 game minutes ago refunds 100 % in versus and 40 % in a normal game', () => {
    const refundAfter200 = (versus: boolean) => {
      const events = new EventBus();
      const sim = createSimulation(events, 9) as Simulation;
      sim.newGame(1234, versus ? { versus: rulesFor(30) } : {});
      sim.money = 1e6;
      const r = sim.placeObject('bench', EX - 1, AVENUE + 4, 1);
      expect(r.reason ?? 'ok').toBe('ok');
      const id = Math.max(...sim.world.objects.keys());
      if (!versus) sim.setSpeed(1);
      // 200 game minutes
      const target = sim.time + 200 / 3;
      while (sim.time < target - 1e-9) sim.update(Math.min(0.1, (target - sim.time) / (versus ? 4 : 1)));
      const before = sim.money;
      expect(sim.removeObject(id).ok).toBe(true);
      sim.flushMoney();
      return (sim.money - before) / r.cost;
    };
    expect(refundAfter200(true)).toBeCloseTo(1, 6);
    expect(refundAfter200(false)).toBeCloseTo(REFUND_FRACTION, 2);
  });

  it('T2: a keyed notify repeats only after 4 × its cooldown in sim-s during a match', () => {
    const { sim, events } = matchSim(30);
    const seen: string[] = [];
    events.on('notify', (n) => seen.push(n.text));
    sim.notify('probe', 'hello', 'info', undefined, 10);
    expect(seen).toEqual(['hello']);
    sim.time += 39;
    sim.notify('probe', 'hello', 'info', undefined, 10);
    expect(seen).toHaveLength(1);
    sim.time += 1;
    sim.notify('probe', 'hello', 'info', undefined, 10);
    expect(seen).toHaveLength(2);
    // a normal game: the plain cooldown
    const normal = createSimulation(new EventBus(), 2) as Simulation;
    normal.newGame();
    const out: string[] = [];
    normal.events.on('notify', (n) => out.push(n.text));
    normal.notify('probe', 'x', 'info', undefined, 10);
    normal.time += 10;
    normal.notify('probe', 'x', 'info', undefined, 10);
    expect(out).toHaveLength(2);
  });

  it('the day-close summary is log-only in a match, with a "Day N: +P points" pop', () => {
    const { sim, events } = matchSim(30);
    sim.money = 1e6;
    buildZoo(sim);
    buyHerd(sim, 'zebra', 4);
    hire(sim);
    const toasts: GameEvents['notify'][] = [];
    const pops: GameEvents['versusPoints'][] = [];
    events.on('notify', (n) => {
      if (/^Day \d+ closed/.test(n.text)) toasts.push(n);
    });
    events.on('versusPoints', (p) => pops.push(p));
    while (sim.day < 2) sim.update(0.25);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].logOnly).toBe(true);
    const day = pops.find((p) => p.part === 'money');
    expect(day?.text).toMatch(/^Day 1: [+−]\d+ points$/);
    expect(sim.messages().some((m) => /^Day 1 closed/.test(m.text))).toBe(true);
  });

  it('a lost animal costs 25 points and pops its name', () => {
    const { sim, events } = matchSim(30);
    sim.money = 1e6;
    buildZoo(sim);
    const [id] = buyHerd(sim, 'zebra', 2);
    while (sim.versus!.hour < 1) sim.update(0.25);
    const pops: GameEvents['versusPoints'][] = [];
    events.on('versusPoints', (p) => pops.push(p));
    const a = sim.animals.get(id)!;
    a.health = 0.0001;
    a.needs.hunger = 0;
    a.needs.thirst = 0;
    const before = sim.versus!.parts().l;
    for (let i = 0; i < 40 && sim.animals.has(id); i++) sim.update(0.25);
    expect(sim.animals.has(id)).toBe(false);
    expect(sim.versus!.parts().l).toBe(before + 1);
    const lost = pops.find((p) => p.part === 'lost')!;
    expect(lost.delta).toBe(-25);
    expect(lost.text).toContain(a.name);
  });
});
