// Versus Zoo Points (versus.md §4, §12.1; spec §5.3): the point functions, the worked example,
// exploit resistance and frame-rate independence.
import { describe, expect, it } from 'vitest';
import { LENGTHS, TEST_LENGTH, VERSUS_RULES_VERSION, score, scoreRounded, type VersusRules } from '../shared/versus-rules';
import { EventBus, type GameEvents } from '../src/core/events';
import type { LedgerEntry } from '../src/core/types';
import { createSimulation } from '../src/sim';
import { emptyLedger, runningResult, type Simulation } from '../src/sim/simulation';
import { animalHourPoints, babyPoints, moneyPoints, varietyHourPoints, visitorPoints, VersusMatch } from '../src/sim/versus';
import { buildZoo, buyHerd, hire } from './sim-helpers';

function rulesFor(lengthMin: 30 | 60 | 90 | 120 | 4, matchId = 'match-1', seed = 1234): VersusRules {
  const L = lengthMin === 4 ? TEST_LENGTH : LENGTHS[lengthMin];
  return { matchId, seed, lengthMin, days: L.days, rulesVersion: VERSUS_RULES_VERSION, startMoney: L.startMoney, startMinute: 510 };
}

describe('point functions (versus.md §4.2)', () => {
  it('match the worked example to 1e-6', () => {
    expect(animalHourPoints(13, 0.8)).toBeCloseTo(1.028656, 6);
    expect(varietyHourPoints(3, 17 / 30, 0.8)).toBeCloseTo(0.826665, 6);
    expect(visitorPoints(0.62)).toBeCloseTo(0.31, 9);
    expect(moneyPoints(1565)).toBeCloseTo(15.65, 9);
    expect(moneyPoints(-500)).toBe(0);
  });

  it('respect their caps', () => {
    expect(24 * animalHourPoints(1e9, 1)).toBeCloseTo(60, 6);
    expect(24 * varietyHourPoints(1e9, 1, 1)).toBeCloseTo(50, 6);
    expect(animalHourPoints(0, 1)).toBe(0);
    expect(varietyHourPoints(0, 1, 1)).toBe(0);
    expect(visitorPoints(2)).toBe(0.5);
    // babies: 10, +20 for the species' first; at most 40 a day
    expect(babyPoints(true, 0)).toBe(30);
    expect(babyPoints(false, 0)).toBe(10);
    expect(babyPoints(true, 30)).toBe(10);
    expect(babyPoints(false, 40)).toBe(0);
  });

  it('the first-of-species bonus is paid once per species, and the day cap resets at midnight', () => {
    const events = new EventBus();
    const sim = createSimulation(events, 3) as Simulation;
    sim.newGame(1, { versus: rulesFor(30) });
    const v = sim.versus!;
    const pops: GameEvents['versusPoints'][] = [];
    events.on('versusPoints', (p) => pops.push(p));
    v.onBirth('zebra'); // 30
    v.onBirth('zebra'); // 10 → 40, cap reached
    v.onBirth('giraffe'); // capped to 0 today (first bonus spent)
    expect(v.parts().b).toBe(40);
    v.onDayClosed(emptyLedger(1));
    v.onBirth('giraffe'); // not the first any more
    expect(v.parts().b).toBe(50);
    expect(pops.filter((p) => p.part === 'babies').map((p) => p.delta)).toEqual([30, 10, 10]);
    expect(pops[0].text).toBe('Baby zebra!');
  });
});

describe('worked example: day 10 of Ana’s match (versus.md §4.3)', () => {
  it('totals +124.28 ± 0.01 for the day, shown "+124"', () => {
    const events = new EventBus();
    const sim = createSimulation(events, 3) as Simulation;
    sim.newGame(1, { versus: rulesFor(30) });
    const v = sim.versus as VersusMatch;
    const pops: GameEvents['versusPoints'][] = [];
    events.on('versusPoints', (p) => pops.push(p));
    // all day: 4 zebras, 6 gazelles, 3 camels on view with room (C = 13), w̄ = 0.80, appeal 6, 5, 6
    for (let h = 0; h < 24; h++) v.sampleHour({ held: 13, welfare: 0.8, species: 3, appeal: 17 / 30 });
    for (let i = 0; i < 110; i++) v.onDeparture(0.62);
    v.onBirth('zebra');
    const day: LedgerEntry = { ...emptyLedger(10), admissions: 1650, shopIncome: 410, donations: 25, salaries: 370, food: 89, upkeep: 61 };
    expect(runningResult(day)).toBe(1565);
    v.onDayClosed(day);
    expect(score(v.rawParts())).toBeCloseTo(124.28, 2);
    expect(Math.abs(score(v.rawParts()) - 124.28)).toBeLessThanOrEqual(0.01);
    expect(v.total()).toBe(124);
    expect(pops.at(-1)).toMatchObject({ part: 'money', text: 'Day 10: +124 points' });
    // a starved camel that day: 25 fewer → "+99"
    v.onLost('Lulu the camel died — hire keepers!');
    expect(Math.round(score(v.rawParts()))).toBe(99);
  });
});

// ------------------------------------------------------------------ scripted matches
interface Run {
  total: number;
  hours: number[];
  log: { v: number; b: number; lost: number; money: number };
  sim: Simulation;
}

/** A 15-day match of the small test zoo; `act` may change the zoo at each frame. */
function playMatch(frame: number, act?: (sim: Simulation) => void, build = true): Run {
  const events = new EventBus();
  const sim = createSimulation(events, 7) as Simulation;
  sim.newGame(1234, { versus: rulesFor(30) });
  if (build) {
    sim.money = 1e6;
    buildZoo(sim);
    buyHerd(sim, 'zebra', 6);
    hire(sim);
    sim.money = 100_000;
  }
  const hours: number[] = [];
  const log = { v: 0, b: 0, lost: 0, money: 0 };
  events.on('versusHour', (e) => hours.push(e.hour));
  events.on('versusPoints', (p) => {
    if (p.part === 'babies') log.b += p.delta;
    if (p.part === 'lost') log.lost++;
  });
  events.on('guestRemoved', () => log.v++);
  let guard = 0;
  while (!sim.versus!.ended && guard++ < 2e6) {
    act?.(sim);
    sim.update(frame);
  }
  return { total: sim.versus!.total(), hours, log, sim };
}

let control: Run | null = null;
const getControl = () => (control ??= playMatch(1 / 30));

describe('a scripted 15-day match', () => {
  it('ends with 360 hourly samples, and the parts add up to the total', () => {
    const run = getControl();
    expect(run.hours).toEqual(Array.from({ length: 360 }, (_, i) => i + 1));
    const v = run.sim.versus!;
    const p = v.parts();
    expect(v.total()).toBe(scoreRounded(p));
    expect(p.b).toBe(run.log.b);
    expect(p.l).toBe(run.log.lost);
    expect(p.v).toBeGreaterThan(0);
    expect(p.a).toBeGreaterThan(0);
    expect(p.s).toBeGreaterThan(0);
    expect(run.total).toBeGreaterThan(200);
  }, 60_000);

  it('exploits score below the control: sell-all, fire-keepers, build-nothing, $200 ticket', () => {
    const ctrl = getControl().total;
    const sellAll = playMatch(1 / 30, (sim) => {
      if (sim.day === 15 && sim.minuteOfDay >= 720 && sim.animals.size) for (const id of [...sim.animals.keys()]) sim.sellAnimal(id);
    }).total;
    const fireKeepers = playMatch(1 / 30, (sim) => {
      if (sim.day === 3 && sim.staff.size) for (const id of [...sim.staff.keys()]) sim.fireStaff(id);
    }).total;
    const nothing = playMatch(1 / 30, undefined, false).total;
    const ticket200 = playMatch(1 / 30, (sim) => {
      if (sim.day === 15 && sim.admissionPrice !== 200) sim.setAdmission(200);
    }).total;
    // small test zoo (6 zebras, a keeper, a groundskeeper), seed 7: control 669, sell-all 638,
    // fire-keepers 616, build-nothing 0, $200 ticket 645 when this was written
    expect(sellAll).toBeLessThan(ctrl);
    // the showcase zoo loses 28 % (versus.md §4.5); this small, well-fed herd still loses clearly
    expect(fireKeepers).toBeLessThan(ctrl * 0.97);
    expect(nothing).toBe(0);
    expect(ticket200).toBeLessThan(ctrl);
  }, 120_000);

  it('animals guests cannot see earn no animal or variety points', () => {
    const events = new EventBus();
    const sim = createSimulation(events, 7) as Simulation;
    sim.newGame(1234, { versus: rulesFor(4) });
    sim.money = 1e6;
    buildZoo(sim);
    buyHerd(sim, 'zebra', 4);
    // hide the habitat: its view tiles go
    const hab = [...sim.world.habitats.values()][0];
    hab.viewTiles.length = 0;
    const p = sim.versus!;
    while (p.hour < 3) {
      hab.viewTiles.length = 0;
      sim.update(0.25);
    }
    expect(p.parts().a).toBe(0);
    expect(p.parts().s).toBe(0);
  });
});

describe('frame-rate independence (versus.md §2.4)', () => {
  for (const frame of [1 / 60, 1 / 30, 1 / 10]) {
    it(`update(${frame.toFixed(4)}) gives exactly 360 hourly samples and ends at time 7200, day 16 08:30`, () => {
      const run = frame === 1 / 30 ? getControl() : playMatch(frame);
      expect(run.hours).toHaveLength(360);
      expect(new Set(run.hours).size).toBe(360);
      expect(run.hours[359]).toBe(360);
      expect(run.sim.time).toBe(7200);
      expect(run.sim.day).toBe(16);
      expect(run.sim.minuteOfDay).toBe(510);
      // same zoo, different frame rates: RNG noise only
      expect(run.total).toBeGreaterThan(getControl().total * 0.8);
      expect(run.total).toBeLessThan(getControl().total * 1.2);
    }, 60_000);
  }
});
