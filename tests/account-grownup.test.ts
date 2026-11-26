// The grown-up check (spec §3.3, P2): factors 12–19 × 6–9, a keypad, and a 30 s lockout after
// 3 wrong answers.
import { describe, expect, it } from 'vitest';
import { GATE_LOCK_MS, GATE_WRONG_LIMIT, GrownupGate, lockText, makeQuestion, typeKey } from '../src/ui/account/grownup';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, add: (ms: number) => (t += ms) };
}

/** A deterministic random source. */
function lcg(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('questions', () => {
  it('uses factors 12–19 × 6–9 (answers 72–171) and reaches every factor', () => {
    const r = lcg(3);
    const as = new Set<number>();
    const bs = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const q = makeQuestion(r);
      expect(q.a).toBeGreaterThanOrEqual(12);
      expect(q.a).toBeLessThanOrEqual(19);
      expect(q.b).toBeGreaterThanOrEqual(6);
      expect(q.b).toBeLessThanOrEqual(9);
      expect(q.answer).toBe(q.a * q.b);
      expect(q.answer).toBeGreaterThanOrEqual(72);
      expect(q.answer).toBeLessThanOrEqual(171);
      as.add(q.a);
      bs.add(q.b);
    }
    expect([...as].sort((x, y) => x - y)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
    expect([...bs].sort((x, y) => x - y)).toEqual([6, 7, 8, 9]);
    // edge values of the random source stay in range
    expect(makeQuestion(() => 0)).toEqual({ a: 12, b: 6, answer: 72 });
    expect(makeQuestion(() => 0.999999)).toEqual({ a: 19, b: 9, answer: 171 });
    expect(makeQuestion(() => 1)).toEqual({ a: 19, b: 9, answer: 171 });
  });
});

describe('GrownupGate', () => {
  it('a right answer opens it and a new question comes next time', () => {
    const c = clock();
    const g = new GrownupGate({ now: c.now, random: lcg(1) });
    const q = g.question;
    expect(g.submit(q.answer)).toBe('ok');
    expect(g.wrongCount).toBe(0);
    expect(g.lockedMs()).toBe(0);
  });

  it('locks for 30 s after 3 wrong answers, then opens again with a fresh count', () => {
    const c = clock();
    const g = new GrownupGate({ now: c.now, random: lcg(2) });
    expect(GATE_WRONG_LIMIT).toBe(3);
    expect(GATE_LOCK_MS).toBe(30_000);
    expect(g.submit(g.question.answer + 1)).toBe('wrong');
    expect(g.submit(g.question.answer + 1)).toBe('wrong');
    expect(g.wrongCount).toBe(2);
    expect(g.submit(g.question.answer + 1)).toBe('locked');
    expect(g.lockedMs()).toBe(30_000);
    // even the right answer is refused while locked
    expect(g.submit(g.question.answer)).toBe('locked');
    c.add(29_000);
    expect(g.lockedMs()).toBe(1_000);
    expect(g.submit(g.question.answer)).toBe('locked');
    c.add(1_000);
    expect(g.lockedMs()).toBe(0);
    expect(g.wrongCount).toBe(0);
    expect(g.submit(g.question.answer)).toBe('ok');
  });

  it('each wrong answer asks a new question; a right one resets the count', () => {
    const c = clock();
    const g = new GrownupGate({ now: c.now, random: lcg(9) });
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      const q = g.question;
      seen.push(`${q.a}x${q.b}`);
      expect(g.submit(0)).toBe('wrong');
    }
    expect(g.submit(g.question.answer)).toBe('ok');
    expect(g.wrongCount).toBe(0);
    // two more wrong answers do not lock (the count restarted)
    expect(g.submit(-1)).toBe('wrong');
    expect(g.submit(NaN)).toBe('wrong');
    expect(g.lockedMs()).toBe(0);
    expect(seen.length).toBe(2);
  });

  it('a lockout survives closing and reopening the check (same gate)', () => {
    const c = clock();
    const g = new GrownupGate({ now: c.now });
    for (let i = 0; i < 3; i++) g.submit(-5);
    c.add(10_000);
    expect(g.lockedMs()).toBe(20_000);
    expect(lockText(g.lockedMs())).toBe('Too many wrong answers. Wait 20 seconds and ask a grown-up again.');
    expect(lockText(400)).toBe('Too many wrong answers. Wait 1 second and ask a grown-up again.');
  });
});

describe('keypad', () => {
  it('types up to 3 digits, deletes, and ignores other keys', () => {
    let s = '';
    for (const k of ['1', '4', '0', '9']) s = typeKey(s, k);
    expect(s).toBe('140');
    s = typeKey(s, 'back');
    expect(s).toBe('14');
    expect(typeKey('', 'back')).toBe('');
    expect(typeKey('0', '7')).toBe('7');
    expect(typeKey('12', 'x')).toBe('12');
  });
});
