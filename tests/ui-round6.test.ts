// Round-6 UI: asking before serious outcomes, guest capacity, crowding, goal progress, the
// day's running costs in Finances, and the Messages log rebuilt from a save.
import { describe, expect, it } from 'vitest';
import type { RunningCostEstimate, SimMessage } from '../src/core/contracts';
import type { CommandResult, LedgerEntry } from '../src/core/types';
import { goalFraction, goalProgressText, pillGoalText } from '../src/ui/coach';
import { guestChip } from '../src/ui/hud';
import { MessageLog } from '../src/ui/notify';
import { roomText } from '../src/ui/panels';
import { confirmQuestion } from '../src/ui/tools';
import { chartDay, chartTop, todayRows } from '../src/ui/zoopanel';

describe('confirm before serious outcomes', () => {
  const ok = (extra: Partial<CommandResult>): CommandResult => ({ ok: true, cost: -120, ...extra });

  it('asks before a bulldoze cuts the entrance off, keeping any other warning', () => {
    const cut = ok({ warning: 'Cuts the entrance off from every exhibit — the gate closes until you reconnect it', severity: 'confirm', cutsEntrance: true });
    expect(confirmQuestion(cut, 'Remove')).toEqual({
      title: 'Cut off the entrance?',
      text: 'This cuts the entrance off from the whole zoo. Guests can’t get in until you reconnect it.',
      ok: 'Remove anyway',
    });
    const both = ok({ ...cut, warning: `${cut.warning}; opens Habitat 2 — its animals could get out` });
    expect(confirmQuestion(both, 'Remove')?.text).toBe(
      'This cuts the entrance off from the whole zoo. Guests can’t get in until you reconnect it. Opens Habitat 2 — its animals could get out.',
    );
  });

  it("asks before packing a habitat, in the sim's words", () => {
    const packed = ok({ cost: 900, warning: 'It would be far too crowded here (30 tiles, needs 80) — the animals get stressed and sick', severity: 'confirm' });
    expect(confirmQuestion(packed, 'Adopt')).toEqual({
      title: 'Overcrowd this habitat?',
      text: 'It would be far too crowded here (30 tiles, needs 80) — the animals get stressed and sick.',
      ok: 'Adopt anyway',
    });
    expect(confirmQuestion(packed, 'Move')?.ok).toBe('Move anyway');
    // any other outcome the sim wants confirmed is asked about in its own words
    expect(confirmQuestion(ok({ warning: 'something serious', severity: 'confirm' }), 'Remove')).toEqual({ title: 'Are you sure?', text: 'Something serious.', ok: 'Remove anyway' });
  });

  it('does not ask for plain warnings or failures', () => {
    expect(confirmQuestion(ok({ warning: 'Cuts 3 path tiles off from the entrance — guests can’t get there' }), 'Remove')).toBeNull();
    expect(confirmQuestion({ ok: false, cost: 0, reason: 'Not enough money', severity: 'confirm', warning: 'x' }, 'Adopt')).toBeNull();
    expect(confirmQuestion(ok({}), 'Remove')).toBeNull();
  });
});

describe('guest capacity', () => {
  it('shows guests in the zoo of how many fit, full once no party gets in', () => {
    expect(guestChip({ guestsInZoo: 110, guestCapacity: 141 })).toEqual({ count: '110', cap: '/141', full: false, label: 'Guests in the zoo: 110 of 141' });
    expect(guestChip({ guestsInZoo: 138, guestCapacity: 141 }).full).toBe(true); // a party of 4 no longer fits
    expect(guestChip({ guestsInZoo: 138, guestCapacity: 141 }).label).toBe('Guests in the zoo: 138 of 141 (full)');
  });
});

describe('habitat room', () => {
  it('says plainly when a habitat is crowded and how much room it needs', () => {
    expect(roomText(1, 30)).toEqual({ text: 'Enough room', kind: 'good' });
    expect(roomText(30 / 34, 30)).toEqual({ text: 'A bit crowded — needs 34 tiles', kind: 'warn' });
    expect(roomText(30 / 80, 30)).toEqual({ text: 'Too crowded — needs 80 tiles', kind: 'bad' }); // 16 zebras: stress and sickness
    expect(roomText(30 / 320, 30).text).toBe('Too crowded — needs 320 tiles');
  });
});

describe('goal progress', () => {
  it('reads progress the way the goal states its target', () => {
    expect(goalProgressText({ text: 'Welcome 150 guests in a single day' }, { current: 141, target: 150 })).toBe('141 / 150');
    expect(goalProgressText({ text: 'Have $100,000 in the bank' }, { current: 84016, target: 100000 })).toBe('$84,016 / $100,000');
    expect(goalProgressText({ text: 'Make $3,000 running profit in one day' }, { current: 2410, target: 3000 })).toBe('$2,410 / $3,000');
    expect(goalProgressText({ text: 'Reach 75% guest happiness for a day' }, { current: 62, target: 75 })).toBe('62% / 75%');
    // a percentage in the text that is not the target: a count
    expect(goalProgressText({ text: 'Have 10 animals with happiness above 70%' }, { current: 4, target: 10 })).toBe('4 / 10');
    expect(goalProgressText({ text: 'Get 8 habitats to 80% suitability' }, { current: 5, target: 8 })).toBe('5 / 8');
    expect(goalProgressText({ text: 'Welcome 5,000 visitors in total' }, { current: 4031, target: 5000 })).toBe('4,031 / 5,000');
    expect(goalFraction({ current: 141, target: 150 })).toBeCloseTo(0.94);
    expect(goalFraction({ current: 0, target: 0 })).toBe(0);
  });

  it('shortens a goal for the pill by dropping its how-to, then its verb', () => {
    expect(pillGoalText('Build your first habitat (enclose an area with fences)', false)).toBe('Build your first habitat');
    expect(pillGoalText('Welcome 150 guests in a single day', true)).toBe('150 guests in a single day');
    expect(pillGoalText('Have a baby animal born in your zoo', true)).toBe('A baby animal born in your zoo');
    expect(pillGoalText('Have $100,000 in the bank', true)).toBe('$100,000 in the bank');
  });
});

describe('finances', () => {
  const ledger = (o: Partial<LedgerEntry>): LedgerEntry => ({
    day: 13,
    income: 0,
    expenses: 0,
    admissions: 0,
    shopIncome: 0,
    donations: 0,
    other: 0,
    upkeep: 0,
    food: 0,
    salaries: 0,
    construction: 0,
    animalPurchases: 0,
    ...o,
  });
  const costs: RunningCostEstimate = {
    fraction: 0.59,
    soFar: { wages: 289, food: 106, upkeep: 41, total: 436 },
    day: { wages: 490, food: 180, upkeep: 70, total: 740 },
  };

  it("counts the day's running costs that midnight will book, so the profit doesn't drop at midnight", () => {
    const rows = todayRows(ledger({ admissions: 1629, shopIncome: 251 }), costs);
    expect(rows.map((r) => [r.label, r.value, r.note ?? ''])).toEqual([
      ['Tickets', 1629, ''],
      ['Shops', 251, ''],
      ['Donations', 0, ''],
      ['Wages', -490, 'due at midnight'],
      ['Animal food', -180, 'due at midnight'],
      ['Upkeep', -70, 'due at midnight'],
      ['Running profit', 1140, ''], // what the day-close message will say: $1,880 in, $740 running costs
    ]);
  });

  it('keeps building and rewards apart from the running profit', () => {
    const rows = todayRows(ledger({ admissions: 1000, other: 5000, construction: 12000, salaries: 490 }), costs);
    expect(rows.find((r) => r.label === 'Wages')?.note).toBeUndefined(); // all paid already (dismissed today)
    expect(rows.slice(6).map((r) => [r.label, r.value])).toEqual([
      ['Running profit', 260],
      ['Rewards & refunds', 5000],
      ['Construction', -12000],
      ['Net', 260 + 5000 - 12000],
    ]);
  });

  it('scales the chart to running income and costs, not to a big building day', () => {
    const days = [
      chartDay(ledger({ day: 8, admissions: 3000, shopIncome: 600, salaries: 500, food: 200, upkeep: 100 })),
      chartDay(ledger({ day: 9, admissions: 3200, salaries: 500, food: 200, upkeep: 100, construction: 45000, other: 18000 })),
      chartDay(ledger({ day: 10, admissions: 1000 }), costs),
    ];
    expect(days[1]).toEqual({ day: 9, income: 3200, costs: 800, oneOffIn: 18000, invest: 45000 });
    expect(days[2].costs).toBe(740); // today: the whole day's estimate
    expect(chartTop(days)).toBe(5000); // $3,600 of running income at most, not $45,000
    // an older save's ledger has no food field
    expect(chartDay({ ...ledger({ salaries: 300, upkeep: 50 }), food: undefined as unknown as number }).costs).toBe(350);
  });
});

describe('Messages after Continue', () => {
  it("rebuilds the log from the save's messages, newest first, with nothing unread", () => {
    const log = new MessageLog();
    log.add('Old news from another zoo', 'bad', undefined, 1, 600);
    const v = log.version;
    const saved: SimMessage[] = [
      { day: 31, minute: 600, text: 'Zebra Plains is getting crowded', kind: 'warn', focus: { x: 60, z: 120 } },
      { day: 31, minute: 900, text: 'The entrance path is cut — reconnect it to open the gate.', kind: 'bad', focus: { x: 73, z: 135 } },
      { day: 31, minute: 915, text: 'The entrance path is cut — reconnect it to open the gate.', kind: 'bad', focus: { x: 73, z: 135 } },
      { day: 32, minute: 0, text: 'Day 31 closed: +$1,934', kind: 'info', logOnly: true },
    ];
    log.restore(saved);
    expect(log.entries.map((e) => [e.text, e.count, e.day, e.minute])).toEqual([
      ['Day 31 closed: +$1,934', 1, 32, 0],
      ['The entrance path is cut — reconnect it to open the gate.', 2, 31, 915],
      ['Zebra Plains is getting crowded', 1, 31, 600],
    ]);
    expect(log.entries[1].focus).toEqual({ x: 73, z: 135 });
    expect(log.unread).toBe(0);
    expect(log.unreadBad).toBe(false);
    expect(log.version).toBeGreaterThan(v);
    // a new zoo starts with an empty log
    log.restore([]);
    expect(log.entries).toEqual([]);
  });
});
