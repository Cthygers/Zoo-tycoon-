import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlotKey } from '../src/core/contracts';
import { readTutorialState, writeTutorialState } from '../src/core/player-state';
import { KEYS } from '../src/core/storage-keys';
import { decodeSave, encodeSave } from '../src/net/codec';
import { FakeCloud } from '../src/net/fakeCloud';
import { MemoryStorage } from '../src/net/memoryStorage';
import { LocalStoreImpl, type SlotRecord } from '../src/net/storage';
import { bootPhone, mainKey, meta, zooJson } from '../src/net/testkit';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 26, 12);

function store(s = new MemoryStorage(), opts: { track?: boolean; account?: string | null; now?: () => number } = {}) {
  return new LocalStoreImpl(s, { now: opts.now ?? (() => T0), trackGuestMeta: opts.track ?? true, currentAccount: () => (opts.account === undefined ? 'acc1' : opts.account), deviceName: () => 'Pixel 7' });
}

function record(s: MemoryStorage, key: SlotKey): SlotRecord {
  const [pid, slot] = key.split('/') as [string, string];
  return JSON.parse(s.getItem(`wh2:slot:${pid}/${slot}`)!) as SlotRecord;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('net storage (LocalStore)', () => {
  it('ST-1: the guest zoo is wildhaven-save-v1 as plain JSON, byte for byte, with the -unreadable backups as before', () => {
    const s = new MemoryStorage();
    const off = store(s, { track: false, account: null });
    const json = zooJson('guest', { note: 'é 🦁' });
    expect(off.write('guest/main' as SlotKey, json, meta(10))).toBe('saved');
    expect(s.getItem('wildhaven-save-v1')).toBe(json);
    expect(s.keys()).toEqual(['wildhaven-save-v1']); // a cloud-disabled build adds no keys at all
    expect(off.read('guest/main' as SlotKey)?.json).toBe(json);
    expect(off.write('guest/practice' as SlotKey, zooJson('practice'), meta(1))).toBe('saved');
    expect(s.getItem('wildhaven-practice-v1')).toBe(zooJson('practice'));
    // unreadable copies: '-unreadable', the same text again reuses it, another text gets '-<ts>'
    expect(off.markUnreadable('guest/main' as SlotKey, 'broken 1')).toBe(true);
    expect(s.getItem('wildhaven-save-v1-unreadable')).toBe('broken 1');
    expect(off.markUnreadable('guest/main' as SlotKey, 'broken 1')).toBe(true);
    expect(off.markUnreadable('guest/main' as SlotKey, 'broken 2')).toBe(true);
    expect(s.getItem(`wildhaven-save-v1-unreadable-${T0}`)).toBe('broken 2');
    expect(s.keys().filter((k) => k.startsWith('wildhaven-save-v1-unreadable'))).toHaveLength(2);
    // storage refusing the copy → false (main keeps mayWriteSave = false)
    s.failSet = () => true;
    expect(off.markUnreadable('guest/main' as SlotKey, 'broken 3')).toBe(false);
    s.failSet = null;
    // a cloud build keeps the guest's play time in wh2:index, the guest key is still plain JSON
    const s2 = new MemoryStorage();
    const on = store(s2);
    on.write('guest/main' as SlotKey, json, meta(321));
    expect(s2.getItem('wildhaven-save-v1')).toBe(json);
    expect(store(s2).read('guest/main' as SlotKey)?.meta?.playSeconds).toBe(321);
    expect(store(s2).meta('guest/main' as SlotKey)?.playSeconds).toBe(321);
  });

  it('ST-2: adoptGuestInto runs in the §3.5 order, copies the tutorial state, and fails safely; -moved is purged after 30 days', () => {
    const s = new MemoryStorage();
    const ls = store(s);
    expect(ls.adoptGuestInto('acc1', 'pidMia')).toBe('no-guest');
    const json = zooJson('guest-zoo', { time: 900 });
    s.setItem(KEYS.guestMain, json); // a pre-cloud guest zoo (no stored meta)
    // 1. failure while writing the profile slot → legacy key untouched, nothing half-written
    s.failSet = (k) => k === 'wh2:slot:pidMia/main';
    expect(ls.adoptGuestInto('acc1', 'pidMia')).toBe('failed');
    expect(s.getItem(KEYS.guestMain)).toBe(json);
    expect(s.getItem('wh2:slot:pidMia/main')).toBeNull();
    // 2. failure at step 4 (active slot) → undone, legacy key untouched
    s.failSet = (k) => k === KEYS.active('pidMia');
    expect(ls.adoptGuestInto('acc1', 'pidMia')).toBe('failed');
    expect(s.getItem(KEYS.guestMain)).toBe(json);
    expect(s.getItem('wh2:slot:pidMia/main')).toBeNull();
    expect(s.getItem(KEYS.guestMainMoved)).toBeNull();
    s.failSet = null;
    // 3. success
    expect(ls.adoptGuestInto('acc1', 'pidMia')).toBe('ok');
    const rec = record(s, mainKey('pidMia'));
    expect(rec).toMatchObject({ seq: 1, syncedSeq: 0, base: null, accountId: 'acc1', profileId: 'pidMia', slot: 'main', localOnly: false });
    expect(decodeSave(rec.gz)).toBe(json);
    expect(rec.meta.playSeconds).toBeGreaterThan(0); // unknown play counts as real play (asks, never silently drops)
    expect(s.getItem(KEYS.active('pidMia'))).toBe('main');
    expect(readTutorialState(s, 'pidMia')).toMatchObject({ status: 'never', legacyFromGuest: true });
    expect(s.getItem(KEYS.guestMain)).toBeNull();
    const moved = JSON.parse(s.getItem(KEYS.guestMainMoved)!) as { movedTo: unknown; at: number; data: string };
    expect(moved).toEqual({ movedTo: { accountId: 'acc1', profileId: 'pidMia' }, at: T0, data: json });
    // 4. a second guest zoo adopted by a player that already has one: the old one becomes a backup
    s.setItem(KEYS.guestMain, zooJson('guest-2'));
    writeTutorialState(s, 'guest', { v: 1, status: 'done', readAloud: false, updatedAt: T0 });
    expect(ls.adoptGuestInto('acc1', 'pidMia')).toBe('ok');
    expect(ls.backups('pidMia')).toHaveLength(1);
    expect(ls.backups('pidMia')[0]!.reason).toBe('replaced');
    expect(readTutorialState(s, 'pidMia')).toMatchObject({ status: 'done', readAloud: false });
    // -moved: kept 29 days, gone after 30
    ls.housekeeping(T0 + 29 * DAY);
    expect(s.getItem(KEYS.guestMainMoved)).not.toBeNull();
    ls.housekeeping(T0 + 31 * DAY);
    expect(s.getItem(KEYS.guestMainMoved)).toBeNull();
  });

  it('ST-3: an unreadable profile record is kept as wh2:bad and frees the slot; markUnreadable copies the text and pins the next push', () => {
    const s = new MemoryStorage();
    const ls = store(s);
    s.setItem('wh2:slot:pidBen/main', '{"v":2, this is not json');
    expect(ls.read(mainKey('pidBen'))).toBeNull();
    expect(s.getItem(`wh2:bad:pidBen/main:${T0}`)).toBe('{"v":2, this is not json');
    expect(s.getItem('wh2:slot:pidBen/main')).toBeNull();
    // a record whose gzip is damaged
    ls.write(mainKey('pidAva'), zooJson('ava'), meta(5));
    const r = record(s, mainKey('pidAva'));
    s.setItem('wh2:slot:pidAva/main', JSON.stringify({ ...r, gz: 'AAAA' }));
    const ls2 = store(s, { now: () => T0 + 1 });
    expect(ls2.read(mainKey('pidAva'))).toBeNull();
    expect(s.getItem(`wh2:bad:pidAva/main:${T0 + 1}`)).toContain('"gz":"AAAA"');
    // the sim could not load a readable record: main.ts calls markUnreadable
    ls2.write(mainKey('pidAva'), zooJson('ava-2'), meta(6));
    expect(ls2.markUnreadable(mainKey('pidAva'), 'text main could not load')).toBe(true);
    expect(s.getItem(`wh2:bad:pidAva/main:${T0 + 1}`)).toBe('text main could not load');
    expect(record(s, mainKey('pidAva')).pinNext).toBe(true);
  });

  it('ST-4: on a full storage the §3.4 purge order frees space step by step and stops as soon as the write fits', () => {
    const s = new MemoryStorage();
    const ls = store(s);
    const big = (n: number) => 'x'.repeat(n);
    // 1. -moved, 2. conflict copy, 3. an old backup (+ a fresh one), 4. finished vs slots, 5. a removed player, 6. another account's clean slot
    s.setItem(KEYS.guestMainMoved, JSON.stringify({ at: T0, data: big(3000) }));
    s.setItem(KEYS.remote('pidMia'), JSON.stringify({ head: {}, data: big(3000), at: T0 }));
    const oldGz = encodeSave(zooJson('old', { pad: big(3000) }));
    const freshGz = encodeSave(zooJson('fresh'));
    s.setItem(KEYS.bak('pidMia'), JSON.stringify([
      { id: 'b-old-1', reason: 'auto_pull', fromDevice: 'x', meta: meta(1), savedAt: 0, createdAt: T0 - 40 * DAY, uploaded: true, gz: oldGz + big(3000), saveVersion: 1, stash: false },
      { id: 'b-fresh', reason: 'auto_pull', fromDevice: 'x', meta: meta(1), savedAt: 0, createdAt: T0 - DAY, uploaded: false, gz: freshGz, saveVersion: 1, stash: true },
    ]));
    for (let i = 0; i < 4; i++) {
      ls.write(`pidMia/vs-m${i}` as SlotKey, zooJson(`vs${i}`, { pad: big(1500 + i) }), meta(1));
      s.setItem(KEYS.vs('pidMia', `m${i}`), JSON.stringify({ v: 1, match: { status: 'finished', createdAt: T0 - 20 * DAY, result: { decidedAt: T0 - (10 + i) * DAY } } }));
    }
    ls.updateAccount('acc1', (a) => {
      a.removed = [{ id: 'pidGone', name: 'Old', avatar: { animal: 'lion', color: 0 }, removedAt: T0 - 31 * DAY, purgeAt: T0 - DAY }];
    });
    ls.write(mainKey('pidGone'), zooJson('gone', { pad: big(2000) }), meta(1));
    const other = new LocalStoreImpl(s, { now: () => T0, currentAccount: () => 'acc2' });
    other.write(mainKey('pidOther'), zooJson('other', { pad: big(2000) }), meta(1));
    other.updateRecord(mainKey('pidOther'), (r) => {
      r.base = { epoch: 'E', rev: 1, playSeconds: 1, sha256: 'x' };
      r.syncedSeq = r.seq;
    });
    // this account's own unsynced zoo must never be purged
    ls.write(mainKey('pidMia'), zooJson('mine'), meta(100));
    const mine = s.getItem('wh2:slot:pidMia/main');

    // A: the write fits once the conflict copy is gone → -moved and the remote go, nothing else
    const quotaUntil = (target: string, gone: string) => (k: string) => k === target && s.getItem(gone) !== null;
    s.failSet = quotaUntil('wh2:slot:pidNew/main', KEYS.remote('pidMia'));
    expect(ls.write(mainKey('pidNew'), zooJson('new'), meta(1))).toBe('saved');
    expect(s.getItem(KEYS.guestMainMoved)).toBeNull();
    expect(s.getItem(KEYS.remote('pidMia'))).toBeNull();
    expect(JSON.parse(s.getItem(KEYS.bak('pidMia'))!)).toHaveLength(2);
    expect(s.getItem('wh2:slot:pidMia/vs-m3')).not.toBeNull();
    expect(s.getItem('wh2:slot:pidGone/main')).not.toBeNull();
    expect(s.getItem('wh2:slot:pidOther/main')).not.toBeNull();

    // B: it fits only once the other account's clean slot (step 6) is gone → steps 3–5 happened first
    s.failSet = quotaUntil('wh2:slot:pidNew2/main', 'wh2:slot:pidOther/main');
    expect(ls.write(mainKey('pidNew2'), zooJson('new2'), meta(1))).toBe('saved');
    expect((JSON.parse(s.getItem(KEYS.bak('pidMia'))!) as Array<{ id: string }>).map((b) => b.id)).toEqual(['b-fresh']);
    expect(s.getItem('wh2:slot:pidMia/vs-m3')).toBeNull(); // finished 13 days ago, the oldest of 4
    for (const i of [0, 1, 2]) expect(s.getItem(`wh2:slot:pidMia/vs-m${i}`)).not.toBeNull(); // the newest 3 stay
    expect(s.getItem('wh2:slot:pidGone/main')).toBeNull();
    expect(s.getItem('wh2:slot:pidOther/main')).toBeNull();
    expect(s.getItem('wh2:slot:pidMia/main')).toBe(mine);

    // C: nothing left to purge → 'failed', and this account's data is intact
    s.failSet = (k) => k === 'wh2:slot:pidNew3/main';
    expect(ls.write(mainKey('pidNew3'), zooJson('new3'), meta(1))).toBe('failed');
    expect(s.getItem('wh2:slot:pidMia/main')).toBe(mine);
    expect(s.getItem('wh2:slot:pidNew3/main')).toBeNull();
    s.failSet = null;

    // a real quota: only the -moved copy stands in the way
    const s2 = new MemoryStorage();
    const ls2 = store(s2);
    s2.setItem(KEYS.guestMainMoved, JSON.stringify({ at: T0, data: big(20_000) }));
    s2.quota = s2.usedChars + 100;
    expect(ls2.write(mainKey('pidMia'), zooJson('fits', { n: 1 }), meta(1))).toBe('saved');
    expect(s2.getItem(KEYS.guestMainMoved)).toBeNull();
  });

  it('ST-5: wh2:index is rebuilt from the slot records when missing or corrupt, skipping stray keys', () => {
    const s = new MemoryStorage();
    const ls = store(s);
    ls.write(mainKey('pidMia'), zooJson('mia'), meta(11, 4));
    ls.write('pidBen/practice' as SlotKey, zooJson('ben'), meta(22, 5));
    s.setItem('wh2:slot:garbage', '{}');
    s.setItem('wh2:slot:/main', '{}');
    s.setItem('wh2:slot:pidX/vs-a/b', '{}');
    for (const broken of [null, '{not json', JSON.stringify({ v: 1 })]) {
      if (broken === null) s.removeItem(KEYS.index);
      else s.setItem(KEYS.index, broken);
      const fresh = store(s);
      const idx = fresh.index();
      expect(Object.keys(idx.slots).sort()).toEqual(['pidBen/practice', 'pidMia/main']);
      expect(idx.slots['pidMia/main']).toMatchObject({ accountId: 'acc1', seq: 1, syncedSeq: 0, hasBase: false, localOnly: false, meta: { day: 4, playSeconds: 11 } });
      expect(idx.slots['pidBen/practice']).toMatchObject({ localOnly: true, meta: { playSeconds: 22 } });
      expect(fresh.meta(mainKey('pidMia'))?.day).toBe(4);
      expect(JSON.parse(s.getItem(KEYS.index)!).v).toBe(2);
    }
    // a summary whose record is gone is dropped
    s.removeItem('wh2:slot:pidBen/practice');
    expect(Object.keys(store(s).index().slots)).toEqual(['pidMia/main']);
  });

  it('ST-6: writing unchanged content is a no-op (no setItem, same seq)', () => {
    const s = new MemoryStorage();
    const ls = store(s);
    const json = zooJson('same');
    expect(ls.write(mainKey('pidMia'), json, meta(5))).toBe('saved');
    const seq = record(s, mainKey('pidMia')).seq;
    const spy = vi.spyOn(s, 'setItem');
    expect(ls.write(mainKey('pidMia'), json, meta(5))).toBe('saved');
    expect(ls.write('guest/main' as SlotKey, json, meta(5))).toBe('saved');
    spy.mockClear();
    expect(ls.write('guest/main' as SlotKey, json, meta(5))).toBe('saved');
    expect(spy.mock.calls.filter(([k]) => k === KEYS.guestMain)).toHaveLength(0);
    expect(record(s, mainKey('pidMia')).seq).toBe(seq);
    expect(ls.write(mainKey('pidMia'), zooJson('changed'), meta(6))).toBe('saved');
    expect(record(s, mainKey('pidMia')).seq).toBe(seq + 1);
  });

  it('ST-7: localOnly slots (practice, vs-*) never enter the sync queue', async () => {
    const fake = new FakeCloud();
    const phone = await bootPhone(fake, { name: 'Pixel 7' });
    const mia = await phone.cloud.profiles.create('Mia', { animal: 'zebra', color: 2 });
    const local = phone.cloud.local;
    local.write(`${mia.id}/practice` as SlotKey, zooJson('practice'), meta(50));
    local.write(`${mia.id}/vs-match1` as SlotKey, zooJson('vs'), meta(50));
    expect(record(phone.storage, `${mia.id}/practice` as SlotKey).localOnly).toBe(true);
    expect(record(phone.storage, `${mia.id}/vs-match1` as SlotKey).localOnly).toBe(true);
    expect(phone.cloud.sync.ownedSyncedKeys()).toEqual([]);
    phone.cloud.sync.noteSaved(`${mia.id}/practice` as SlotKey);
    await phone.cloud.sync.syncNow();
    const opened = await phone.cloud.sync.openSlot(`${mia.id}/practice` as SlotKey, phone.prompts);
    expect(opened).toMatchObject({ kind: 'ok', source: 'local' });
    expect(phone.cloud.sync.onHidden(`${mia.id}/vs-match1` as SlotKey, 65_000)).toBe(0);
    expect(fake.count('putSave') + fake.count('lease') + fake.count('getHead')).toBe(0);
    expect(phone.cloud.sync.slotState(`${mia.id}/practice` as SlotKey)).toBe('local');
    expect(phone.cloud.sync.pendingCount()).toBe(0);
    // the main slot does sync
    local.write(mainKey(mia.id), zooJson('main'), meta(10));
    expect(phone.cloud.sync.ownedSyncedKeys()).toEqual([mainKey(mia.id)]);
    await phone.cloud.sync.syncNow();
    expect(fake.count('putSave')).toBe(1);
    phone.cloud.dispose();
  });

  it('backups: at most 3, playBackup and giveTo', () => {
    const s = new MemoryStorage();
    let now = T0;
    const ls = store(s, { now: () => now });
    ls.updateAccount('acc1', (a) => {
      a.profiles = [
        { id: 'pidMia', name: 'Mia', avatar: { animal: 'lion', color: 0 }, prefs: {}, createdAt: 0, updatedAt: 0, main: null },
        { id: 'pidBen', name: 'Ben', avatar: { animal: 'bear', color: 1 }, prefs: {}, createdAt: 0, updatedAt: 0, main: null },
        { id: 'pidAva', name: 'Ava', avatar: { animal: 'hippo', color: 1 }, prefs: {}, createdAt: 0, updatedAt: { } as unknown as number, main: { epoch: 'E', rev: 1, meta: meta(1), savedAt: 0, deviceName: 'Tab', lease: null } },
      ];
    });
    for (let i = 0; i < 5; i++) {
      now = T0 + i;
      ls.addBackup('pidMia', { gz: encodeSave(zooJson(`b${i}`)), meta: meta(i), savedAt: now, saveVersion: 1, reason: 'auto_pull', fromDevice: 'Tab', stash: false });
    }
    const list = ls.backups('pidMia');
    expect(list).toHaveLength(3);
    expect(list.map((b) => b.meta.playSeconds)).toEqual([4, 3, 2]); // newest first, the oldest evicted
    ls.write(mainKey('pidMia'), zooJson('current'), meta(100));
    expect(ls.playBackup('pidMia', list[2]!.id)).toBe('ok');
    expect(decodeSave(record(s, mainKey('pidMia')).gz)).toBe(zooJson('b2'));
    expect(record(s, mainKey('pidMia')).pinNext).toBe(true);
    expect(ls.backups('pidMia').some((b) => b.reason === 'replaced')).toBe(true);
    // give a backup to Ben (empty) → ok; to Mia (has a slot) / Ava (has a cloud zoo) → not-empty
    const b0 = ls.backups('pidMia')[0]!;
    expect(ls.giveTo({ profileId: 'pidMia', backupId: b0.id }, 'pidBen')).toBe('ok');
    expect(record(s, mainKey('pidBen'))).toMatchObject({ seq: 1, base: null, accountId: 'acc1' });
    expect(ls.giveTo({ profileId: 'pidMia', backupId: b0.id }, 'pidMia')).toBe('not-empty');
    expect(ls.giveTo({ profileId: 'pidMia', backupId: b0.id }, 'pidAva')).toBe('not-empty');
    s.setItem(KEYS.guestMain, zooJson('guest'));
    expect(ls.giveTo({ guest: true }, 'pidBen')).toBe('not-empty');
    ls.remove(mainKey('pidBen'));
    expect(ls.giveTo({ guest: true }, 'pidBen')).toBe('ok');
    expect(s.getItem(KEYS.guestMain)).toBe(zooJson('guest')); // a copy
    ls.deleteBackup('pidMia', b0.id);
    expect(ls.backups('pidMia').find((b) => b.id === b0.id)).toBeUndefined();
    // backups older than 30 days go
    ls.housekeeping(T0 + 31 * DAY);
    expect(ls.backups('pidMia')).toEqual([]);
  });
});
