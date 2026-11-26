// shared/versus-rules.ts: constants, lengths, Zoo Points, match codes, pace, snapshot plausibility and the
// outcome rule (api.md §5). The server and the client both run these functions, so the oracles here are
// the contract.
import { describe, expect, it } from 'vitest';
import * as apiTypes from '../shared/api-types';
import type { VersusParts, VersusSnapshot } from '../shared/api-types';
import {
  BUDGET_FACTOR,
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_TTL_MS,
  DAILY_RATE_CAPS,
  FINISH_WINDOW_MS,
  HOUR_REAL_S,
  LENGTHS,
  LIVE_WINDOW_MS,
  LOST_ANIMAL_POINTS,
  MATCH_DAY_SIM_S,
  MATCH_HOUR_SIM_S,
  OVER_BUDGET_GRACE_MS,
  PACE_SLACK_S,
  SNAPSHOT_EVERY_HOURS,
  TEST_LENGTH,
  VERSUS_MULTIPLIER,
  VERSUS_RULES_VERSION,
  VERSUS_SPEED,
  VERSUS_START_MINUTE,
  budgetMs,
  checkPace,
  checkSnapshotStep,
  codeHasLookalikes,
  decideOutcome,
  formatCode,
  hoursTotal,
  isValidCode,
  lengthSpec,
  normalizeCode,
  score,
  scoreRounded,
  type SeatOutcomeInput,
} from '../shared/versus-rules';

const P0: VersusParts = { v: 0, a: 0, s: 0, b: 0, m: 0, l: 0 };

function parts(p: Partial<VersusParts>): VersusParts {
  return { ...P0, ...p };
}

/** A snapshot whose total is consistent with its parts unless `total` is given. */
function snap(h: number, p: Partial<VersusParts> = {}, total?: number): VersusSnapshot {
  const pp = parts(p);
  return {
    h, day: 1 + Math.floor(h / 24), min: 510, parts: pp, total: total ?? scoreRounded(pp),
    run: 0, cash: 100_000, guests: 0, visitors: 0, animals: 0, species: 0, habitats: 0, stars: 0,
  };
}

describe('api-types', () => {
  it('has no runtime values', () => {
    expect(Object.keys(apiTypes)).toEqual([]);
  });
});

describe('constants', () => {
  it('match the pinned values', () => {
    expect(VERSUS_RULES_VERSION).toBe(1);
    expect(VERSUS_SPEED).toBe(3);
    expect(VERSUS_MULTIPLIER).toBe(4);
    expect(MATCH_HOUR_SIM_S).toBe(20);
    expect(MATCH_DAY_SIM_S).toBe(480);
    expect(HOUR_REAL_S).toBe(5);
    expect(VERSUS_START_MINUTE).toBe(510);
    expect(SNAPSHOT_EVERY_HOURS).toBe(6);
    expect(BUDGET_FACTOR).toBe(1.5);
    expect(PACE_SLACK_S).toBe(120);
    expect(CODE_TTL_MS).toBe(48 * 3600 * 1000);
    expect(FINISH_WINDOW_MS).toBe(72 * 3600 * 1000);
    expect(LIVE_WINDOW_MS).toBe(90_000);
    expect(OVER_BUDGET_GRACE_MS).toBe(600_000);
    expect(LOST_ANIMAL_POINTS).toBe(25);
  });

  it('are consistent with each other (4×: 1 match hour = 20 sim-s = 5 real s, 1 zoo day = 120 real s)', () => {
    expect(MATCH_HOUR_SIM_S * 24).toBe(MATCH_DAY_SIM_S);
    expect(MATCH_HOUR_SIM_S / VERSUS_MULTIPLIER).toBe(HOUR_REAL_S);
    expect(MATCH_DAY_SIM_S / VERSUS_MULTIPLIER).toBe(120);
  });

  it('LENGTHS table: days = lengthMin / 2 and budgetMin = lengthMin × 1.5', () => {
    expect(LENGTHS).toEqual({
      30: { lengthMin: 30, days: 15, startMoney: 100_000, budgetMin: 45 },
      60: { lengthMin: 60, days: 30, startMoney: 80_000, budgetMin: 90 },
      90: { lengthMin: 90, days: 45, startMoney: 70_000, budgetMin: 135 },
      120: { lengthMin: 120, days: 60, startMoney: 60_000, budgetMin: 180 },
    });
    expect(TEST_LENGTH).toEqual({ lengthMin: 4, days: 2, startMoney: 100_000, budgetMin: 6 });
    for (const spec of [...Object.values(LENGTHS), TEST_LENGTH]) {
      expect(spec.days * 2).toBe(spec.lengthMin);
      expect(spec.budgetMin).toBe(spec.lengthMin * BUDGET_FACTOR);
      // The whole match in real time at 4×: days × 120 s = lengthMin minutes.
      expect(hoursTotal(spec.days) * HOUR_REAL_S).toBe(spec.lengthMin * 60);
    }
  });
});

describe('lengthSpec / hoursTotal / budgetMs', () => {
  it('returns the table entry for 30, 60, 90 and 120', () => {
    for (const n of [30, 60, 90, 120] as const) {
      expect(lengthSpec(n)).toBe(LENGTHS[n]);
      expect(lengthSpec(n, true)).toBe(LENGTHS[n]);
    }
  });

  it('returns the test length only with allowTest', () => {
    expect(lengthSpec(4)).toBeNull();
    expect(lengthSpec(4, false)).toBeNull();
    expect(lengthSpec(4, true)).toBe(TEST_LENGTH);
  });

  it('returns null for anything else', () => {
    for (const n of [0, 1, 2, 5, 15, 29, 31, 45, 120.5, 180, 240, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(lengthSpec(n)).toBeNull();
      expect(lengthSpec(n, true)).toBeNull();
    }
  });

  it('hoursTotal = 24 × days; budgetMs = lengthMin × 60 000 × 1.5', () => {
    expect(hoursTotal(15)).toBe(360);
    expect(hoursTotal(60)).toBe(1440);
    expect(hoursTotal(2)).toBe(48);
    expect(budgetMs(30)).toBe(2_700_000);
    expect(budgetMs(60)).toBe(5_400_000);
    expect(budgetMs(120)).toBe(10_800_000);
    expect(budgetMs(4)).toBe(360_000);
    for (const spec of Object.values(LENGTHS)) expect(budgetMs(spec.lengthMin)).toBe(spec.budgetMin * 60_000);
  });
});

describe('score', () => {
  it('versus.md §4.3 worked example: 24.69 + 19.84 + 34.10 + 30 + 15.65 = 124.28 → 124', () => {
    // The parts as the sim computes them for that day (versus.md §4.2 formulas).
    const animals = 24 * 2.5 * (1 - Math.exp(-13 / 18)) * 0.8;
    const variety = 24 * (50 / 24) * (1 - Math.exp(-3 / 3.5)) * (0.5 + 0.5 * (17 / 30)) * (0.4 + 0.6 * 0.8);
    const visitors = 110 * 0.5 * 0.62;
    expect(animals).toBeCloseTo(24.69, 2);
    expect(variety).toBeCloseTo(19.84, 2);
    expect(visitors).toBeCloseTo(34.1, 10);

    const day: VersusParts = { v: 34.1, a: 24.69, s: 19.84, b: 30, m: 1565 / 100, l: 0 };
    expect(score(day)).toBeCloseTo(124.28, 10);
    expect(scoreRounded(day)).toBe(124);
    // "If a camel had starved that day, the day would show +99."
    expect(scoreRounded({ ...day, l: 1 })).toBe(99);
  });

  it('is v + a + s + b + m − 25·l', () => {
    expect(score({ v: 1, a: 2, s: 3, b: 4, m: 5, l: 0 })).toBe(15);
    expect(score({ v: 100, a: 0, s: 0, b: 0, m: 0, l: 2 })).toBe(50);
  });

  it('floors at 0', () => {
    expect(score(P0)).toBe(0);
    expect(score({ v: 10, a: 0, s: 0, b: 0, m: 0, l: 1 })).toBe(0);
    expect(score({ v: 0, a: 0, s: 0, b: 0, m: 0, l: 24 })).toBe(0);
    expect(scoreRounded({ v: 24.9, a: 0, s: 0, b: 0, m: 0, l: 1 })).toBe(0);
  });

  it('scoreRounded is Math.round', () => {
    expect(scoreRounded(parts({ v: 0.5 }))).toBe(1);
    expect(scoreRounded(parts({ v: 0.49 }))).toBe(0);
    expect(scoreRounded(parts({ v: 1239.5 }))).toBe(1240);
  });
});

describe('match codes', () => {
  it('the alphabet has no lookalikes and 31 symbols', () => {
    expect(CODE_ALPHABET).toHaveLength(31);
    expect(new Set(CODE_ALPHABET).size).toBe(31);
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
    expect(CODE_LENGTH).toBe(6);
  });

  it('normalizeCode upper-cases and strips spaces and dashes', () => {
    expect(normalizeCode('k7p-m2q')).toBe('K7PM2Q');
    expect(normalizeCode('  K7P M2Q ')).toBe('K7PM2Q');
    expect(normalizeCode('k7p – m2q')).toBe('K7PM2Q');
    expect(normalizeCode('K7P‑M2Q')).toBe('K7PM2Q');
    expect(normalizeCode('')).toBe('');
    expect(normalizeCode(normalizeCode('k-7 p'))).toBe(normalizeCode('k-7 p'));
  });

  it('isValidCode: 6 chars from the alphabet (after normalizeCode)', () => {
    expect(isValidCode('K7PM2Q')).toBe(true);
    expect(isValidCode('k7p-m2q')).toBe(true);
    expect(isValidCode('ABCDEF')).toBe(true);
    expect(isValidCode('234567')).toBe(true);
    expect(isValidCode('')).toBe(false);
    expect(isValidCode('K7PM2')).toBe(false);
    expect(isValidCode('K7PM2QX')).toBe(false);
    expect(isValidCode('K7PM2O')).toBe(false);
    expect(isValidCode('K7PM20')).toBe(false);
    expect(isValidCode('K7PM2I')).toBe(false);
    expect(isValidCode('K7PM2L')).toBe(false);
    expect(isValidCode('K7PM21')).toBe(false);
    expect(isValidCode('K7PM2!')).toBe(false);
    expect(isValidCode('K7PM2É')).toBe(false);
    for (let i = 0; i + CODE_LENGTH <= CODE_ALPHABET.length; i++) {
      expect(isValidCode(CODE_ALPHABET.slice(i, i + CODE_LENGTH))).toBe(true);
    }
  });

  it("formatCode: 'K7PM2Q' → 'K7P-M2Q'", () => {
    expect(formatCode('K7PM2Q')).toBe('K7P-M2Q');
    expect(formatCode('k7p m2q')).toBe('K7P-M2Q');
    expect(formatCode('K7P-M2Q')).toBe('K7P-M2Q');
    expect(formatCode('K7')).toBe('K7');
    expect(formatCode('K7PM')).toBe('K7P-M');
    expect(normalizeCode(formatCode('K7PM2Q'))).toBe('K7PM2Q');
  });

  it('codeHasLookalikes: 0 O 1 I L in either case', () => {
    for (const s of ['K7PM2O', 'K7PM20', 'k7pm21', 'k7pm2i', 'k7pm2l', 'o', 'L']) expect(codeHasLookalikes(s)).toBe(true);
    for (const s of ['K7PM2Q', 'k7p-m2q', '', 'ABC-DEF', '23456789']) expect(codeHasLookalikes(s)).toBe(false);
  });
});

describe('checkPace', () => {
  it('h=60 at 300 s is ok', () => {
    expect(checkPace(60, 300_000, false)).toBe('ok');
  });
  it('h=60 at 150 s is flag (too fast, but not 2×)', () => {
    expect(checkPace(60, 150_000, false)).toBe('flag');
  });
  it('h=200 at 150 s is reject (more than 2× too fast)', () => {
    expect(checkPace(200, 150_000, false)).toBe('reject');
  });
  it('family matches are never rejected', () => {
    expect(checkPace(200, 150_000, true)).toBe('flag');
    expect(checkPace(1440, 0, true)).toBe('flag');
    expect(checkPace(60, 300_000, true)).toBe('ok');
  });
  it('boundaries: need = allowed is ok; need = 2·allowed is flag; just above is reject', () => {
    // allowed = 0 + 120 s → 24 hours ok; 48 hours = 2·allowed → flag; 49 → reject.
    expect(checkPace(24, 0, false)).toBe('ok');
    expect(checkPace(25, 0, false)).toBe('flag');
    expect(checkPace(48, 0, false)).toBe('flag');
    expect(checkPace(49, 0, false)).toBe('reject');
    // A whole 30-minute match played in exactly 30 minutes.
    expect(checkPace(360, 30 * 60_000, false)).toBe('ok');
  });
});

describe('checkSnapshotStep', () => {
  const HT = 360;

  it('accepts a plausible step with no flags', () => {
    const prev = snap(6, { v: 10, a: 12, s: 10, b: 0, m: 0 });
    const next = snap(12, { v: 20, a: 24, s: 20, b: 10, m: 15.65 });
    expect(checkSnapshotStep(prev, next, HT)).toEqual({ ok: true, flags: [] });
    expect(checkSnapshotStep(null, snap(6, { v: 10, a: 12, s: 10 }), HT)).toEqual({ ok: true, flags: [] });
  });

  it('accepts the final hour and totals within ±1 of scoreRounded(parts)', () => {
    const p = { v: 100.4, a: 50.2, s: 40 };
    expect(checkSnapshotStep(null, snap(HT, p), HT).ok).toBe(true);
    const exact = scoreRounded(parts(p));
    expect(checkSnapshotStep(null, snap(HT, p, exact + 1), HT).ok).toBe(true);
    expect(checkSnapshotStep(null, snap(HT, p, exact - 1), HT).ok).toBe(true);
  });

  it('lets money fall (a loss-making day lowers run)', () => {
    const prev = snap(24, { m: 20 });
    expect(checkSnapshotStep(prev, snap(30, { m: 5 }), HT)).toEqual({ ok: true, flags: [] });
  });

  const rejects: [string, VersusSnapshot | null, VersusSnapshot][] = [
    ['h not an integer', null, snap(6.5)],
    ['h < 1 (0)', null, snap(0)],
    ['h < 1 (negative)', null, snap(-6)],
    ['h > hoursTotal', null, snap(HT + 6)],
    ['h equal to prev', snap(12), snap(12)],
    ['h before prev', snap(12), snap(6)],
    ['v NaN', null, snap(6, { v: Number.NaN }, 0)],
    ['a Infinity', null, snap(6, { a: Number.POSITIVE_INFINITY }, 0)],
    ['s negative', null, snap(6, { s: -1 }, 0)],
    ['b negative', null, snap(6, { b: -10 }, 0)],
    ['m negative', null, snap(6, { m: -0.5 }, 0)],
    ['l negative', null, snap(6, { l: -1 }, 0)],
    ['l not an integer', null, snap(6, { v: 100, l: 1.5 })],
    ['total off by 2', null, snap(6, { v: 10 }, 12)],
    ['total NaN', null, snap(6, { v: 10 }, Number.NaN)],
    ['v decreased', snap(6, { v: 10 }), snap(12, { v: 9 })],
    ['a decreased', snap(6, { a: 10 }), snap(12, { a: 9.9 })],
    ['s decreased', snap(6, { s: 10 }), snap(12, { s: 5 })],
    ['b decreased', snap(6, { b: 30 }), snap(12, { b: 10 })],
    ['l decreased', snap(6, { v: 100, l: 2 }), snap(12, { v: 100, l: 1 })],
  ];
  for (const [name, prev, next] of rejects) {
    it(`rejects: ${name}`, () => {
      const r = checkSnapshotStep(prev, next, HT);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('bad_snapshot');
      expect(typeof r.detail).toBe('string');
      expect(r.flags).toEqual([]);
    });
  }

  it('reports a detail per reject reason', () => {
    expect(checkSnapshotStep(null, snap(6.5), HT).detail).toBe('h not an integer');
    expect(checkSnapshotStep(null, snap(0), HT).detail).toBe('h < 1');
    expect(checkSnapshotStep(null, snap(HT + 1), HT).detail).toBe('h > hoursTotal');
    expect(checkSnapshotStep(snap(12), snap(12), HT).detail).toBe('h not after previous');
    expect(checkSnapshotStep(null, snap(6, { s: -1 }, 0), HT).detail).toBe('part s not finite or negative');
    expect(checkSnapshotStep(null, snap(6, { l: 0.5 }, 0), HT).detail).toBe('l not an integer');
    expect(checkSnapshotStep(null, snap(6, { v: 10 }, 12), HT).detail).toBe('total does not match parts');
    expect(checkSnapshotStep(snap(6, { b: 30 }), snap(12, { b: 10 }), HT).detail).toBe('b decreased');
  });

  // One zoo day (Δh = 24) from a zero snapshot: each part just over its per-day cap raises only its flag.
  const capCases: [string, Partial<VersusParts>][] = [
    ['cap_v', { v: 160.1 }],
    ['cap_a', { a: 60.6 }],
    ['cap_s', { s: 50.6 }],
    ['cap_b', { b: 41 }],
    ['cap_m', { m: 300.5 }],
  ];
  for (const [flag, p] of capCases) {
    it(`flags ${flag} above the per-day cap`, () => {
      expect(checkSnapshotStep(snap(24), snap(48, p), HT)).toEqual({ ok: true, flags: [flag] });
      // Measured from zero when there is no previous snapshot.
      expect(checkSnapshotStep(null, snap(24, p), HT)).toEqual({ ok: true, flags: [flag] });
    });
  }

  it('flags cap_t when the total grows more than 500 a day although every part is at its cap', () => {
    const atCaps = { v: 160, a: 60.5, s: 50.5, b: 40, m: 300 };
    expect(checkSnapshotStep(snap(24), snap(48, atCaps), HT)).toEqual({ ok: true, flags: ['cap_t'] });
  });

  it('does not flag rates exactly at the caps', () => {
    expect(checkSnapshotStep(snap(24), snap(48, { v: 160 }), HT).flags).toEqual([]);
    expect(checkSnapshotStep(snap(24), snap(48, { a: 60.5 }), HT).flags).toEqual([]);
    expect(checkSnapshotStep(snap(24), snap(48, { s: 50.5 }), HT).flags).toEqual([]);
    expect(checkSnapshotStep(snap(24), snap(48, { b: 40 }), HT).flags).toEqual([]);
    expect(checkSnapshotStep(snap(24), snap(48, { m: 300 }), HT).flags).toEqual([]);
    expect(checkSnapshotStep(snap(24), snap(48, { v: 160, a: 60.5, s: 50.5, b: 40, m: 189 }), HT).flags).toEqual([]);
  });

  it('measures rates over Δh/24 days', () => {
    // 30 baby points within 6 match hours is 120 a day.
    expect(checkSnapshotStep(snap(6), snap(12, { b: 30 }), HT).flags).toEqual(['cap_b']);
    // The same 30 points over two days is 15 a day.
    expect(checkSnapshotStep(snap(6), snap(54, { b: 30 }), HT).flags).toEqual([]);
  });

  it('raises several flags in the order v, a, s, b, m, t', () => {
    const r = checkSnapshotStep(null, snap(24, { v: 400, a: 100, s: 100, b: 100, m: 400 }), HT);
    expect(r).toEqual({ ok: true, flags: ['cap_v', 'cap_a', 'cap_s', 'cap_b', 'cap_m', 'cap_t'] });
  });

  it('exposes the per-day caps', () => {
    expect(DAILY_RATE_CAPS).toEqual({ v: 160, a: 60.5, s: 50.5, b: 40, m: 300, t: 500 });
  });
});

describe('decideOutcome', () => {
  const HT = 360;          // a 30-minute match: 15 days
  const FINISH_BY = 1_000_000;
  const BEFORE = FINISH_BY - 1;
  const AFTER = FINISH_BY + 1;

  interface SeatSpec { totals: Record<number, number>; endHour: number; done?: boolean; forfeited?: boolean; lastTotal?: number }
  function seat(s: SeatSpec): SeatOutcomeInput {
    const hours = Object.keys(s.totals).map(Number);
    const last = hours.length ? s.totals[Math.max(...hours)]! : 0;
    return {
      forfeited: s.forfeited ?? false,
      done: s.done ?? s.forfeited ?? false,
      endHour: s.endHour,
      totalAt: (h) => (h in s.totals ? s.totals[h]! : null),
      lastTotal: s.lastTotal ?? last,
    };
  }
  /** Totals stored every 6 hours up to `to` (plus `to` itself), growing by `perHour`. */
  function series(to: number, perHour: number): Record<number, number> {
    const out: Record<number, number> = {};
    for (let h = 6; h <= to; h += 6) out[h] = Math.round(h * perHour);
    out[to] = Math.round(to * perHour);
    return out;
  }
  function decide(a: SeatSpec, b: SeatSpec, now = BEFORE, finishBy: number | null = FINISH_BY) {
    return decideOutcome({ hoursTotal: HT, now, finishBy, seats: [seat(a), seat(b)] });
  }

  it('both finished: the higher total wins (both_finished, compared at hoursTotal)', () => {
    const r = decide({ totals: series(HT, 3.4), endHour: HT, done: true }, { totals: series(HT, 3.3), endHour: HT, done: true });
    expect(r).toEqual({ kind: 'win', winnerSeat: 0, reason: 'both_finished', comparedAtHour: HT, totals: [1224, 1188] });
    const r2 = decide({ totals: series(HT, 3.3), endHour: HT, done: true }, { totals: series(HT, 3.4), endHour: HT, done: true });
    expect(r2).toEqual({ kind: 'win', winnerSeat: 1, reason: 'both_finished', comparedAtHour: HT, totals: [1188, 1224] });
  });

  it('both finished with equal totals: tie', () => {
    const r = decide({ totals: { [HT]: 1240 }, endHour: HT, done: true }, { totals: { [HT]: 1240 }, endHour: HT, done: true });
    expect(r).toEqual({ kind: 'tie', winnerSeat: null, reason: 'both_finished', comparedAtHour: HT, totals: [1240, 1240] });
  });

  it('is decided as soon as both seats are done, even before finishBy', () => {
    const r = decide({ totals: { [HT]: 10 }, endHour: HT, done: true }, { totals: { [HT]: 5 }, endHour: HT, done: true }, 0);
    expect(r).not.toBe('pending');
  });

  it('compares at the largest hour both seats stored, stepping down from the earlier end hour', () => {
    // Seat 1 ran out of real-time budget at hour 200; its rows are at 6, 12, …, 198 and its final at 200.
    // Seat 0 finished; it has rows every 6 hours (no 199 or 200), so H steps 200 → 199 → 198.
    const s0 = { totals: { ...series(HT, 5), 198: 950 }, endHour: HT, done: true };
    const s1 = { totals: { ...series(198, 4), 198: 900, 200: 905 }, endHour: 200, done: true };
    const r = decide(s0, s1);
    expect(r).toEqual({ kind: 'win', winnerSeat: 0, reason: 'compared_at_hour', comparedAtHour: 198, totals: [950, 900] });
  });

  it('compared_at_hour uses the totals at H, not the last totals, and can go to the other seat', () => {
    const s0 = { totals: { 180: 600, 186: 610, [HT]: 2000 }, endHour: HT, done: true };
    const s1 = { totals: { 180: 650, 186: 700 }, endHour: 186, done: false };
    expect(decide(s0, s1, AFTER)).toEqual({
      kind: 'win', winnerSeat: 1, reason: 'compared_at_hour', comparedAtHour: 186, totals: [610, 700],
    });
  });

  it('compared_at_hour with equal totals at H is a tie', () => {
    const s0 = { totals: { 192: 640, [HT]: 1500 }, endHour: HT, done: true };
    const s1 = { totals: { 192: 640 }, endHour: 192, done: false };
    expect(decide(s0, s1, AFTER)).toEqual({
      kind: 'tie', winnerSeat: null, reason: 'compared_at_hour', comparedAtHour: 192, totals: [640, 640],
    });
  });

  it('both reached half but share no stored hour: compared at hour 0, a tie at 0 points', () => {
    const s0 = { totals: { 181: 500 }, endHour: 181, done: true };
    const s1 = { totals: { 183: 700 }, endHour: 183, done: true };
    expect(decide(s0, s1)).toEqual({ kind: 'tie', winnerSeat: null, reason: 'compared_at_hour', comparedAtHour: 0, totals: [0, 0] });
  });

  it('pending while a seat is not done and now ≤ finishBy', () => {
    const s0 = { totals: series(HT, 3), endHour: HT, done: true };
    const s1 = { totals: series(120, 3), endHour: 120, done: false };
    expect(decide(s0, s1, BEFORE)).toBe('pending');
    expect(decide(s0, s1, FINISH_BY)).toBe('pending');
    expect(decide({ ...s0, done: false, endHour: 12, totals: { 12: 30 } }, s1, BEFORE)).toBe('pending');
  });

  it('pending forever without a finishBy (open match) until both are done', () => {
    const s0 = { totals: series(HT, 3), endHour: HT, done: true };
    const s1 = { totals: {}, endHour: 0, done: false };
    expect(decide(s0, s1, Number.MAX_SAFE_INTEGER, null)).toBe('pending');
  });

  it('after finishBy the unfinished seat counts as ended at its last stored hour', () => {
    const s0 = { totals: series(HT, 3), endHour: HT, done: true };
    const s1 = { totals: series(120, 3), endHour: 120, done: false };
    // 120 < half (180): seat 0 wins without a comparison.
    expect(decide(s0, s1, AFTER)).toEqual({
      kind: 'win', winnerSeat: 0, reason: 'other_unfinished', comparedAtHour: null, totals: [1080, 360],
    });
  });

  it('other_unfinished: exactly one seat reached half; it wins with the last totals', () => {
    // Both done (budget ran out for seat 0 early), decided before finishBy.
    const s0 = { totals: { 48: 300, 50: 310 }, endHour: 50, done: true };
    const s1 = { totals: { 180: 400, 210: 420 }, endHour: 210, done: true };
    expect(decide(s0, s1)).toEqual({
      kind: 'win', winnerSeat: 1, reason: 'other_unfinished', comparedAtHour: null, totals: [310, 420],
    });
  });

  it('half is inclusive: endHour = hoursTotal / 2 counts as reached', () => {
    const s0 = { totals: { 180: 300 }, endHour: 180, done: false };
    const s1 = { totals: { 174: 400 }, endHour: 174, done: false };
    expect(decide(s0, s1, AFTER)).toEqual({
      kind: 'win', winnerSeat: 0, reason: 'other_unfinished', comparedAtHour: null, totals: [300, 400],
    });
  });

  it('none_finished: neither seat reached half', () => {
    const s0 = { totals: { 120: 300 }, endHour: 120, done: false };
    const s1 = { totals: { 174: 500 }, endHour: 174, done: true };
    expect(decide(s0, s1, AFTER)).toEqual({
      kind: 'none', winnerSeat: null, reason: 'none_finished', comparedAtHour: null, totals: [300, 500],
    });
    const empty = { totals: {}, endHour: 0, done: false };
    expect(decide(empty, empty, AFTER)).toEqual({
      kind: 'none', winnerSeat: null, reason: 'none_finished', comparedAtHour: null, totals: [0, 0],
    });
  });

  it('forfeit by one seat: the other wins at once (even before finishBy, whatever the totals)', () => {
    const quitter = { totals: { 300: 2000 }, endHour: 300, forfeited: true };
    const player = { totals: { 6: 10 }, endHour: 6, done: false };
    expect(decide(quitter, player, BEFORE)).toEqual({
      kind: 'win', winnerSeat: 1, reason: 'forfeit', comparedAtHour: null, totals: [2000, 10],
    });
    expect(decide(player, quitter, BEFORE)).toEqual({
      kind: 'win', winnerSeat: 0, reason: 'forfeit', comparedAtHour: null, totals: [10, 2000],
    });
    expect(decide(player, quitter, AFTER, null)).toMatchObject({ winnerSeat: 0, reason: 'forfeit' });
  });

  it('forfeit by both seats: no result', () => {
    const a = { totals: { 30: 100 }, endHour: 30, forfeited: true };
    const b = { totals: { 60: 200 }, endHour: 60, forfeited: true };
    expect(decide(a, b)).toEqual({ kind: 'none', winnerSeat: null, reason: 'forfeit', comparedAtHour: null, totals: [100, 200] });
  });

  it('never sets decidedAt (the caller adds it)', () => {
    const r = decide({ totals: { [HT]: 1 }, endHour: HT, done: true }, { totals: { [HT]: 2 }, endHour: HT, done: true });
    expect(r).not.toBe('pending');
    expect(Object.keys(r as object).sort()).toEqual(['comparedAtHour', 'kind', 'reason', 'totals', 'winnerSeat']);
  });

  it('works for the 4-minute test length (48 hours)', () => {
    const h = hoursTotal(TEST_LENGTH.days);
    const r = decideOutcome({
      hoursTotal: h, now: 0, finishBy: 10,
      seats: [seat({ totals: { 24: 50, 48: 90 }, endHour: 48, done: true }), seat({ totals: { 24: 60, 48: 80 }, endHour: 48, done: true })],
    });
    expect(r).toEqual({ kind: 'win', winnerSeat: 0, reason: 'both_finished', comparedAtHour: 48, totals: [90, 80] });
  });
});
