// src/core/storage-keys.ts: the one registry of local storage key names (spec §3.4 / §8.4).
// The key strings are a persistence format: once a phone has written them they must never change,
// so every one is pinned here literally.
import { describe, expect, it } from 'vitest';
import type { SlotKey, SlotName } from '../src/core/contracts';
import { SAVE_KEY } from '../src/core/constants';
import {
  BOOT_INTENT_KEY,
  GUEST,
  KEYS,
  isLocalOnly,
  matchIdOf,
  parseSlotKey,
  slotKey,
  vsSlot,
} from '../src/core/storage-keys';

const PID = 'pA1b2C3d4E5f6G7h8'; // ids are ^[A-Za-z0-9_-]{16,32}$ (api.md §1)
const MID = 'm_9Zy8Xw7Vu6Ts5Rq';
const ACC = 'acc-0123456789abcdef';

describe('fixed keys', () => {
  it('keeps the guest keys of today and the new guest keys', () => {
    expect(GUEST).toBe('guest');
    expect(BOOT_INTENT_KEY).toBe('wildhaven-boot');
    expect(KEYS.guestMain).toBe('wildhaven-save-v1');
    expect(KEYS.guestMain).toBe(SAVE_KEY);
    expect(KEYS.guestMainMoved).toBe('wildhaven-save-v1-moved');
    expect(KEYS.guestPractice).toBe('wildhaven-practice-v1');
    expect(KEYS.guestActive).toBe('wildhaven-active-slot');
    expect(KEYS.guestTutorial).toBe('wildhaven-tutorial');
    expect(KEYS.legacyTour).toBe('wildhaven-tour');
  });

  it('names the device-wide wh2 keys', () => {
    expect(KEYS.device).toBe('wh2:device');
    expect(KEYS.auth).toBe('wh2:auth');
    expect(KEYS.last).toBe('wh2:last');
    expect(KEYS.index).toBe('wh2:index');
    expect(KEYS.slotPrefix).toBe('wh2:slot:');
  });
});

describe('per-profile and per-match keys', () => {
  it('builds slot keys under the slot prefix', () => {
    expect(KEYS.slot(PID, 'main')).toBe(`wh2:slot:${PID}/main`);
    expect(KEYS.slot(PID, 'practice')).toBe(`wh2:slot:${PID}/practice`);
    expect(KEYS.slot(PID, vsSlot(MID))).toBe(`wh2:slot:${PID}/vs-${MID}`);
    for (const s of ['main', 'practice', vsSlot(MID)] as SlotName[]) {
      const k = KEYS.slot(PID, s);
      expect(k.startsWith(KEYS.slotPrefix)).toBe(true);
      // the rest after the prefix is exactly the SlotKey, so a storage scan can parse it back
      expect(parseSlotKey(k.slice(KEYS.slotPrefix.length) as SlotKey)).toEqual({ player: PID, slot: s });
    }
  });

  it('builds backup, remote, bad, versus and per-player keys', () => {
    expect(KEYS.bak(PID)).toBe(`wh2:bak:${PID}/main`);
    expect(KEYS.remote(PID)).toBe(`wh2:remote:${PID}/main`);
    expect(KEYS.bad(PID, 'main', 1700000000000)).toBe(`wh2:bad:${PID}/main:1700000000000`);
    expect(KEYS.bad(PID, vsSlot(MID), 5)).toBe(`wh2:bad:${PID}/vs-${MID}:5`);
    expect(KEYS.vs(PID, MID)).toBe(`wh2:vs:${PID}/${MID}`);
    expect(KEYS.vsIndex(PID)).toBe(`wh2:vsidx:${PID}`);
    expect(KEYS.active(PID)).toBe(`wh2:p:${PID}:active`);
    expect(KEYS.tutorial(PID)).toBe(`wh2:p:${PID}:tutorial`);
  });

  it('keys the versus outbox by account and match (review S7)', () => {
    expect(KEYS.outbox(ACC, MID)).toBe(`wh2:outbox:${ACC}:${MID}`);
    expect(KEYS.outboxDead(ACC, MID)).toBe(`wh2:outbox-dead:${ACC}:${MID}`);
    // a live outbox key is never a prefix of its dead-letter key or the other way round
    expect(KEYS.outboxDead(ACC, MID).startsWith('wh2:outbox:')).toBe(false);
    expect(KEYS.outbox('a', 'm')).not.toBe(KEYS.outbox('b', 'm'));
  });

  it('gives every builder a distinct key for the same ids', () => {
    const all = [
      KEYS.slot(PID, 'main'),
      KEYS.slot(PID, 'practice'),
      KEYS.bak(PID),
      KEYS.remote(PID),
      KEYS.bad(PID, 'main', 1),
      KEYS.vs(PID, MID),
      KEYS.vsIndex(PID),
      KEYS.active(PID),
      KEYS.tutorial(PID),
      KEYS.outbox(ACC, MID),
      KEYS.outboxDead(ACC, MID),
      KEYS.device,
      KEYS.auth,
      KEYS.last,
      KEYS.index,
      KEYS.guestMain,
      KEYS.guestMainMoved,
      KEYS.guestPractice,
      KEYS.guestActive,
      KEYS.guestTutorial,
      KEYS.legacyTour,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('slot keys', () => {
  it('slotKey joins player and slot with a slash', () => {
    expect(slotKey(GUEST, 'main')).toBe('guest/main');
    expect(slotKey(GUEST, 'practice')).toBe('guest/practice');
    expect(slotKey(PID, vsSlot(MID))).toBe(`${PID}/vs-${MID}`);
  });

  it('parseSlotKey is the inverse of slotKey', () => {
    const cases: Array<[string, SlotName]> = [
      [GUEST, 'main'],
      [GUEST, 'practice'],
      [PID, 'main'],
      [PID, 'practice'],
      [PID, vsSlot(MID)],
      [PID, vsSlot('a')],
    ];
    for (const [player, slot] of cases) {
      expect(parseSlotKey(slotKey(player, slot))).toEqual({ player, slot });
    }
  });

  it('parseSlotKey splits at the first slash only', () => {
    expect(parseSlotKey('guest/main')).toEqual({ player: 'guest', slot: 'main' });
    expect(parseSlotKey(`${PID}/vs-${MID}` as SlotKey)).toEqual({ player: PID, slot: `vs-${MID}` });
  });

  it('parseSlotKey throws on malformed keys', () => {
    const bad = [
      '',
      'main',
      '/main',
      'guest/',
      'guest/other',
      'guest/vs-',
      'guest/Main',
      'guest/main/x',
      `${PID}/vs-a/b`,
      'guest//main',
    ];
    for (const k of bad) {
      expect(() => parseSlotKey(k as SlotKey), k).toThrow(/Bad slot key/);
    }
  });

  it('only main is synced; practice and versus slots are local-only', () => {
    expect(isLocalOnly('main')).toBe(false);
    expect(isLocalOnly('practice')).toBe(true);
    expect(isLocalOnly(vsSlot(MID))).toBe(true);
  });

  it('vsSlot and matchIdOf round-trip a match id', () => {
    expect(vsSlot(MID)).toBe(`vs-${MID}`);
    expect(matchIdOf(vsSlot(MID))).toBe(MID);
    expect(matchIdOf(vsSlot('vs-x'))).toBe('vs-x');
    expect(matchIdOf('main')).toBeNull();
    expect(matchIdOf('practice')).toBeNull();
    expect(matchIdOf('vs-' as SlotName)).toBeNull();
  });
});
