// src/core/player-state.ts: per-player tutorial state and active slot in local storage
// (spec §6.6 / §8.5). Pure functions over a KV, so a Map-backed fake stands in for localStorage.
import { describe, expect, it } from 'vitest';
import type { TutorialPrefs, TutorialStatus } from '../shared/api-types';
import {
  mergeTutorialState,
  readActiveSlot,
  readTutorialState,
  writeActiveSlot,
  writeTutorialState,
  type KV,
  type TutorialProfileState,
} from '../src/core/player-state';
import { GUEST, KEYS, vsSlot } from '../src/core/storage-keys';

class MapKV implements KV {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
}

/** Storage that throws on every call (blocked storage, private mode, quota). */
const THROWING: KV = {
  getItem() { throw new Error('SecurityError: storage disabled'); },
  setItem() { throw new DOMException('quota', 'QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError: storage disabled'); },
};

const PID = 'pA1b2C3d4E5f6G7h8';
const DEFAULT: TutorialProfileState = { v: 1, status: 'never', readAloud: null, updatedAt: 0 };
const st = (status: TutorialStatus, readAloud: boolean | null = null, updatedAt = 0, legacy = false): TutorialProfileState =>
  legacy ? { v: 1, status, readAloud, updatedAt, legacyFromGuest: true } : { v: 1, status, readAloud, updatedAt };

describe('readTutorialState / writeTutorialState', () => {
  it('defaults to never / not chosen for guest and profiles', () => {
    const kv = new MapKV();
    expect(readTutorialState(kv, GUEST)).toEqual(DEFAULT);
    expect(readTutorialState(kv, PID)).toEqual(DEFAULT);
  });

  it('stores the guest under wildhaven-tutorial and a profile under wh2:p:<pid>:tutorial', () => {
    const kv = new MapKV();
    writeTutorialState(kv, GUEST, st('done', true, 100));
    writeTutorialState(kv, PID, st('running', false, 200, true));
    expect([...kv.map.keys()].sort()).toEqual([KEYS.tutorial(PID), KEYS.guestTutorial].sort());
    expect(KEYS.guestTutorial).toBe('wildhaven-tutorial');
    expect(KEYS.tutorial(PID)).toBe(`wh2:p:${PID}:tutorial`);
    expect(JSON.parse(kv.getItem('wildhaven-tutorial')!)).toEqual(st('done', true, 100));
    expect(readTutorialState(kv, GUEST)).toEqual(st('done', true, 100));
    expect(readTutorialState(kv, PID)).toEqual(st('running', false, 200, true));
    // players never see each other's state
    expect(readTutorialState(kv, 'pOtherProfile0001')).toEqual(DEFAULT);
  });

  it('never writes the legacy wildhaven-tour key', () => {
    const kv = new MapKV();
    kv.setItem(KEYS.legacyTour, '2');
    writeTutorialState(kv, GUEST, st('done'));
    expect(kv.getItem(KEYS.legacyTour)).toBe('2');
    // and reading the new state does not interpret it (migration is the tutorial's job)
    expect(readTutorialState(new MapKV(), GUEST)).toEqual(DEFAULT);
  });

  it('falls back to the default for unreadable or wrong-shaped records', () => {
    const kv = new MapKV();
    for (const text of ['{not json', 'null', '42', '"done"', '[]']) {
      kv.setItem(KEYS.guestTutorial, text);
      expect(readTutorialState(kv, GUEST), text).toEqual(DEFAULT);
    }
  });

  it('cleans bad fields one by one and drops unknown ones', () => {
    const kv = new MapKV();
    kv.setItem(KEYS.tutorial(PID), JSON.stringify({ v: 7, status: 'finished', readAloud: 'yes', updatedAt: 'x', extra: 1 }));
    expect(readTutorialState(kv, PID)).toEqual(DEFAULT);
    kv.setItem(KEYS.tutorial(PID), JSON.stringify({ status: 'skipped', readAloud: false, updatedAt: 5, legacyFromGuest: 'true' }));
    expect(readTutorialState(kv, PID)).toEqual(st('skipped', false, 5));
    kv.setItem(KEYS.tutorial(PID), JSON.stringify({ status: 'done', updatedAt: Number.NaN }));
    expect(readTutorialState(kv, PID)).toEqual(st('done'));
  });

  it('returns a fresh object each time (callers may mutate it)', () => {
    const kv = new MapKV();
    const a = readTutorialState(kv, GUEST);
    a.status = 'done';
    expect(readTutorialState(kv, GUEST)).toEqual(DEFAULT);
  });
});

describe('mergeTutorialState', () => {
  const ORDER: TutorialStatus[] = ['never', 'running', 'skipped', 'done'];

  it('ranks status done > skipped > running > never, whichever side holds it', () => {
    for (let i = 0; i < ORDER.length; i++) {
      for (let j = 0; j < ORDER.length; j++) {
        const want = ORDER[Math.max(i, j)];
        expect(mergeTutorialState(st(ORDER[i], null, 1), st(ORDER[j], null, 2)).status, `${ORDER[i]}+${ORDER[j]}`).toBe(want);
        expect(mergeTutorialState(st(ORDER[i], null, 2), st(ORDER[j], null, 1)).status, `${ORDER[i]}+${ORDER[j]} (a newer)`).toBe(want);
      }
    }
  });

  it('takes readAloud from the newer updatedAt', () => {
    expect(mergeTutorialState(st('running', true, 100), st('running', false, 200)).readAloud).toBe(false);
    expect(mergeTutorialState(st('running', true, 300), st('running', false, 200)).readAloud).toBe(true);
    expect(mergeTutorialState(st('never', false, 100), st('done', true, 50))).toEqual(st('done', false, 100));
    expect(mergeTutorialState(st('done', false, 10), st('never', true, 50))).toEqual(st('done', true, 50));
  });

  it('keeps the local readAloud on a tie and never lets a not-chosen null erase a choice', () => {
    expect(mergeTutorialState(st('running', true, 100), st('running', false, 100)).readAloud).toBe(true);
    expect(mergeTutorialState(st('running', true, 100), st('running', null, 200)).readAloud).toBe(true);
    expect(mergeTutorialState(st('running', null, 300), st('running', false, 200)).readAloud).toBe(false);
    expect(mergeTutorialState(st('running', null, 1), st('running', null, 2)).readAloud).toBeNull();
  });

  it('keeps the newer updatedAt', () => {
    expect(mergeTutorialState(st('never', null, 7), st('never', null, 9)).updatedAt).toBe(9);
    expect(mergeTutorialState(st('never', null, 9), st('never', null, 7)).updatedAt).toBe(9);
  });

  it('keeps legacyFromGuest if either side has it', () => {
    expect(mergeTutorialState(st('never', null, 0, true), st('done', true, 5)).legacyFromGuest).toBe(true);
    expect(mergeTutorialState(st('never'), st('done', true, 5, true) as TutorialPrefs).legacyFromGuest).toBe(true);
    expect(mergeTutorialState(st('never', null, 0, true), null).legacyFromGuest).toBe(true);
    expect('legacyFromGuest' in mergeTutorialState(st('never'), st('done'))).toBe(false);
  });

  it('returns a clean copy of a when there is no remote state', () => {
    const a = st('skipped', false, 42);
    expect(mergeTutorialState(a, null)).toEqual(a);
    expect(mergeTutorialState(a, undefined)).toEqual(a);
    expect(mergeTutorialState(a, null)).not.toBe(a);
  });

  it('survives a malformed remote prefs object', () => {
    const remote = { v: 1, status: 'bogus', readAloud: 3, updatedAt: -1 } as unknown as TutorialPrefs;
    expect(mergeTutorialState(st('running', true, 10), remote)).toEqual(st('running', true, 10));
  });

  it('is order-independent for status and updatedAt', () => {
    const a = st('skipped', true, 10);
    const b = st('running', false, 20);
    const ab = mergeTutorialState(a, b);
    const ba = mergeTutorialState(b, a);
    expect(ab).toEqual(ba);
    expect(ab).toEqual(st('skipped', false, 20));
  });
});

describe('readActiveSlot / writeActiveSlot', () => {
  it('defaults to main', () => {
    const kv = new MapKV();
    expect(readActiveSlot(kv, GUEST)).toBe('main');
    expect(readActiveSlot(kv, PID)).toBe('main');
  });

  it('stores the guest under wildhaven-active-slot and a profile under wh2:p:<pid>:active', () => {
    const kv = new MapKV();
    writeActiveSlot(kv, GUEST, 'practice');
    writeActiveSlot(kv, PID, 'practice');
    expect(kv.getItem('wildhaven-active-slot')).toBe('practice');
    expect(kv.getItem(`wh2:p:${PID}:active`)).toBe('practice');
    expect(readActiveSlot(kv, GUEST)).toBe('practice');
    expect(readActiveSlot(kv, PID)).toBe('practice');
    writeActiveSlot(kv, PID, 'main');
    expect(readActiveSlot(kv, PID)).toBe('main');
    expect(readActiveSlot(kv, GUEST)).toBe('practice');
  });

  it('round-trips a versus slot for a profile; the guest has no versus slots', () => {
    const kv = new MapKV();
    writeActiveSlot(kv, PID, vsSlot('m_9Zy8Xw7Vu6Ts5Rq'));
    expect(readActiveSlot(kv, PID)).toBe('vs-m_9Zy8Xw7Vu6Ts5Rq');
    kv.setItem(KEYS.guestActive, 'vs-m_9Zy8Xw7Vu6Ts5Rq');
    expect(readActiveSlot(kv, GUEST)).toBe('main');
  });

  it('reads anything unknown as main', () => {
    const kv = new MapKV();
    for (const v of ['', 'Main', 'garden', 'vs-', 'vs-a/b', '"practice"']) {
      kv.setItem(KEYS.active(PID), v);
      expect(readActiveSlot(kv, PID), v).toBe('main');
    }
  });
});

describe('storage failures are swallowed', () => {
  it('every function works on storage that throws', () => {
    expect(() => writeTutorialState(THROWING, GUEST, st('done'))).not.toThrow();
    expect(() => writeTutorialState(THROWING, PID, st('done'))).not.toThrow();
    expect(readTutorialState(THROWING, GUEST)).toEqual(DEFAULT);
    expect(readTutorialState(THROWING, PID)).toEqual(DEFAULT);
    expect(() => writeActiveSlot(THROWING, GUEST, 'practice')).not.toThrow();
    expect(() => writeActiveSlot(THROWING, PID, 'practice')).not.toThrow();
    expect(readActiveSlot(THROWING, GUEST)).toBe('main');
    expect(readActiveSlot(THROWING, PID)).toBe('main');
  });

  it('a full storage (setItem throws, getItem works) keeps the old value', () => {
    const kv = new MapKV();
    writeTutorialState(kv, PID, st('running', true, 1));
    const full: KV = { getItem: (k) => kv.getItem(k), setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); }, removeItem: (k) => kv.removeItem(k) };
    writeTutorialState(full, PID, st('done', false, 2));
    expect(readTutorialState(full, PID)).toEqual(st('running', true, 1));
  });
});
