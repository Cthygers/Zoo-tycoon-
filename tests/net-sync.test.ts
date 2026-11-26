// Sync engine: the edge cases of spec §3.12 (S-1 … S-15) with phones (createCloud + MemoryStorage)
// against one FakeCloud, under fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaseLostInfo, SyncEvents } from '../src/core/cloud-types';
import type { SlotKey } from '../src/core/contracts';
import { decodeSave } from '../src/net/codec';
import { FakeCloud } from '../src/net/fakeCloud';
import { MemoryStorage } from '../src/net/memoryStorage';
import { decide, divergence, toDecideRecord } from '../src/net/sync';
import { bootPhone, mainKey, makePhone, meta, tagOf, zooJson, type Phone, type PhoneOptions } from '../src/net/testkit';

const T0 = Date.UTC(2026, 10, 26, 9);
let fake: FakeCloud;
let phones: Phone[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  fake = new FakeCloud();
  phones = [];
});
afterEach(() => {
  for (const p of phones) p.cloud.dispose();
  vi.useRealTimers();
});

async function phone(o: PhoneOptions): Promise<Phone> {
  const p = await bootPhone(fake, o);
  phones.push(p);
  await settle();
  return p;
}

/** Let background work run (microtasks + a little fake time). */
async function settle(ms = 1): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(ms);
    for (const p of phones) await p.cloud.sync.idle();
  }
}

const play = (p: Phone, pid: string, tag: string, playSeconds: number) =>
  p.cloud.local.write(mainKey(pid), zooJson(tag), meta(playSeconds));
const localTag = (p: Phone, pid: string) => {
  const r = p.cloud.local.getRecord(mainKey(pid));
  return r ? tagOf(decodeSave(r.gz)) : null;
};
const rec = (p: Phone, pid: string) => p.cloud.local.getRecord(mainKey(pid))!;
function events<E extends keyof SyncEvents>(p: Phone, e: E): Array<SyncEvents[E]> {
  const out: Array<SyncEvents[E]> = [];
  p.cloud.sync.on(e, (x) => out.push(x));
  return out;
}

/** Phone and Tablet signed in to one account with player Mia whose zoo (tag, play) is in the cloud on both. */
async function family(tag = 'zoo1', playSeconds = 100) {
  const A = await phone({ name: 'Phone' });
  const B = await phone({ name: 'Tablet' });
  const mia = (await A.cloud.profiles.create('Mia', { animal: 'zebra', color: 1 })).id;
  await B.cloud.profiles.refresh();
  play(A, mia, tag, playSeconds);
  await A.cloud.sync.syncNow();
  const opened = await B.cloud.sync.openSlot(mainKey(mia), B.prompts);
  expect(opened).toMatchObject({ kind: 'ok', source: 'cloud' });
  await B.cloud.sync.onLeave(mainKey(mia));
  await settle();
  expect(fake.head(mia)?.rev).toBe(1);
  return { A, B, mia, key: mainKey(mia) };
}

describe('decide() (spec §3.7)', () => {
  const H = (o: Partial<{ epoch: string; rev: number; play: number; sha: string; v: number }>) => ({
    epoch: o.epoch ?? 'E1', rev: o.rev ?? 1, sha256: o.sha ?? 'h', sizeGz: 1, sizeRaw: 1, saveVersion: o.v ?? 1, appVersion: '1',
    meta: meta(o.play ?? 0), device: { id: 'd', name: 'Tablet' }, savedAt: 0, clientSavedAt: 0, pushId: 'p',
  });
  const R = (o: Partial<{ dirty: boolean; base: { epoch: string; rev: number; playSeconds: number } | null; play: number; data: boolean }>) => ({
    hasData: o.data ?? true, dirty: o.dirty ?? false, playSeconds: o.play ?? 0,
    base: o.base === undefined ? { epoch: 'E1', rev: 1, playSeconds: 0, sha256: 'h' } : o.base ? { ...o.base, sha256: 'h' } : null,
  });
  it('covers every branch', () => {
    expect(decide(R({}), H({ v: 2 }), () => '')).toEqual({ kind: 'blocked', reason: 'newer_version' });
    expect(decide(R({ data: false }), null, () => '')).toEqual({ kind: 'in_sync' });
    expect(decide(R({ data: false }), H({}), () => '')).toEqual({ kind: 'pull', keepLocalCopy: false });
    expect(decide(R({}), null, () => '')).toEqual({ kind: 'push', base: null, keepLocal: false });
    expect(decide(R({ base: null }), H({ sha: 'same' }), () => 'same')).toEqual({ kind: 'adopt' });
    expect(decide(R({ base: null, play: 500 }), H({ play: 600 }), () => 'x')).toEqual({ kind: 'conflict' });
    expect(decide(R({}), H({}), () => '')).toEqual({ kind: 'in_sync' });
    expect(decide(R({ dirty: true }), H({}), () => '')).toEqual({ kind: 'push', base: { epoch: 'E1', rev: 1 }, keepLocal: false });
    expect(decide(R({}), H({ rev: 2 }), () => '')).toEqual({ kind: 'pull', keepLocalCopy: false });
    expect(decide(R({ dirty: true, play: 10 }), H({ rev: 2, play: 500 }), () => '')).toEqual({ kind: 'pull', keepLocalCopy: true });
    expect(decide(R({ dirty: true, play: 500 }), H({ rev: 2, play: 10 }), () => '')).toEqual({ kind: 'push', base: { epoch: 'E1', rev: 2 }, keepLocal: true });
    expect(decide(R({ dirty: true, play: 500 }), H({ rev: 2, play: 300 }), () => '')).toEqual({ kind: 'conflict' });
    // epoch changed / rev went backwards: by play time
    expect(decide(R({ play: 900 }), H({ epoch: 'E2', rev: 1, play: 100 }), () => '')).toEqual({ kind: 'push', base: { epoch: 'E2', rev: 1 }, keepLocal: true });
    expect(decide(R({ play: 50 }), H({ epoch: 'E2', rev: 5, play: 100 }), () => '')).toEqual({ kind: 'pull', keepLocalCopy: false });
    expect(decide(R({ base: { epoch: 'E1', rev: 5, playSeconds: 0 }, play: 900 }), H({ rev: 3, play: 100 }), () => '')).toEqual({ kind: 'push', base: { epoch: 'E1', rev: 3 }, keepLocal: true });
    expect(divergence(toDecideRecord(null), H({ play: 0 }))).toEqual({ kind: 'pull', keepLocalCopy: true });
  });
});

describe('sync engine edge cases (spec §3.12)', () => {
  it('S-1: two phones offline from the same base both play > 2 min: the first fast-forwards, the second gets a conflict; both versions survive', async () => {
    const { A, B, mia, key } = await family('zoo1', 100);
    A.client().offline = true;
    B.client().offline = true;
    play(A, mia, 'phone-play', 100 + 200);
    play(B, mia, 'tablet-play', 100 + 300);
    A.client().offline = false;
    await A.cloud.sync.syncNow();
    expect(fake.head(mia)).toMatchObject({ rev: 2 });
    expect(tagOf(fake.headJson(mia))).toBe('phone-play');
    B.client().offline = false;
    B.prompts.conflict = 'here';
    const opened = await B.cloud.sync.openSlot(key, B.prompts);
    const c = B.prompts.log.find((l) => l.kind === 'conflict')!.info as import('../src/core/cloud-types').ConflictInfo;
    expect(c.profileName).toBe('Mia');
    expect(c.here).toMatchObject({ thisDevice: true, uniquePlaySeconds: 300, newest: true });
    expect(c.other).toMatchObject({ deviceName: 'Phone', uniquePlaySeconds: 200, newest: false });
    expect(opened).toMatchObject({ kind: 'ok' });
    expect(tagOf((opened as { json: string }).json)).toBe('tablet-play');
    await settle();
    // head = the Tablet's zoo; the Phone's is pinned on the server and kept as a backup on the Tablet
    expect(fake.head(mia)?.rev).toBe(3);
    expect(tagOf(fake.headJson(mia))).toBe('tablet-play');
    expect(fake.revisions(mia).find((r) => r.rev === 2)!.pinnedUntil).toBeGreaterThan(T0);
    const bak = B.cloud.local.backups(mia);
    expect(bak).toHaveLength(1);
    expect(bak[0]).toMatchObject({ reason: 'replaced', fromDevice: 'Phone' });
    // the Phone, clean, takes the Tablet's zoo
    await A.cloud.sync.syncNow();
    expect(localTag(A, mia)).toBe('tablet-play');
  });

  it('S-1b: choosing the other zoo keeps this one as a backup and a server stash', async () => {
    const { A, B, mia, key } = await family('zoo1', 100);
    B.client().offline = true;
    play(A, mia, 'phone-play', 400);
    await A.cloud.sync.syncNow();
    play(B, mia, 'tablet-play', 350);
    B.client().offline = false;
    await B.cloud.sync.syncNow();
    expect(B.cloud.sync.slotState(key)).toBe('conflict');
    expect(B.cloud.status.get()).toEqual({ kind: 'conflict', keys: [key] });
    expect(await B.cloud.sync.resolveConflict(key, 'other')).toBe('continue');
    await settle();
    expect(localTag(B, mia)).toBe('phone-play');
    expect(B.cloud.sync.slotState(key)).toBe('synced');
    expect(fake.stashes(mia).map((s) => [s.reason, tagOf(s.json)])).toEqual([['chose_other', 'tablet-play']]);
    expect(B.cloud.local.backups(mia)[0]).toMatchObject({ reason: 'chose_other', uploaded: true });
    expect(fake.head(mia)?.rev).toBe(2);
  });

  it('S-2: the same player opened on two phones: takeover, the first gets leaseLost (≤ 120 s) and its play goes to a backup + stash', async () => {
    const { A, B, mia, key } = await family('zoo1', 100);
    const lost = events(A, 'leaseLost');
    expect(await A.cloud.sync.openSlot(key, A.prompts)).toMatchObject({ kind: 'ok', source: 'local' });
    play(A, mia, 'phone-recent', 150);
    B.prompts.takeover = true;
    const opened = await B.cloud.sync.openSlot(key, B.prompts);
    expect(B.prompts.log[0]).toMatchObject({ kind: 'takeover', info: { profileName: 'Mia', holderDevice: 'Phone' } });
    expect(opened).toMatchObject({ kind: 'ok' });
    await vi.advanceTimersByTimeAsync(61_000);
    await settle();
    expect(lost).toHaveLength(1);
    expect(lost[0]!.key).toBe(key);
    expect(lost[0]!.info.localDeltaSeconds).toBe(50);
    expect(lost[0]!.info.other.deviceName).toBe('Tablet');
    expect(await A.cloud.sync.resolveLeaseLost(key, 'other')).toBe('reload');
    await settle();
    expect(localTag(A, mia)).toBe('zoo1');
    expect(A.cloud.local.backups(mia)[0]).toMatchObject({ reason: 'lease_lost', uploaded: true });
    expect(fake.stashes(mia).map((s) => tagOf(s.json))).toEqual(['phone-recent']);
    // the old session's save (switchSlot → save()) cannot overwrite the newer copy before the reload
    expect(play(A, mia, 'stale-session-save', 160)).toBe('saved');
    expect(localTag(A, mia)).toBe('zoo1');
    // declining a takeover leaves the zoo to the other phone
    const C = await phone({ name: 'Laptop' });
    C.prompts.takeover = false;
    expect(await C.cloud.sync.openSlot(key, C.prompts)).toEqual({ kind: 'cancelled' });
  });

  it('S-2b: Phone offline 1 h after the lease ran out, Tablet took the zoo; back online → leaseLost with ≈ 3600 s, "here" wins with keep_local', async () => {
    const { A, B, mia, key } = await family('zoo1', 1000);
    const lostA = events(A, 'leaseLost');
    const lostB = events(B, 'leaseLost');
    await A.cloud.sync.openSlot(key, A.prompts);
    A.client().offline = true;
    await vi.advanceTimersByTimeAsync(3_600_000);
    play(A, mia, 'phone-hour', 1000 + 3600);
    expect(await B.cloud.sync.openSlot(key, B.prompts)).toMatchObject({ kind: 'ok' }); // A's lease expired: no prompt
    expect(B.prompts.log.filter((l) => l.kind === 'takeover')).toHaveLength(0);
    play(B, mia, 'tablet-short', 1000 + 90);
    await B.cloud.sync.syncNow();
    expect(fake.head(mia)?.rev).toBe(2);
    A.client().offline = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(lostA).toHaveLength(1);
    const info: LeaseLostInfo = lostA[0]!.info;
    expect(info.localDeltaSeconds).toBeGreaterThan(120);
    expect(info.localDeltaSeconds).toBe(3600);
    expect(info.here.newest).toBe(true);
    expect(info.other).toMatchObject({ deviceName: 'Tablet', playingNow: true });
    expect(await A.cloud.sync.resolveLeaseLost(key, 'here')).toBe('continue');
    await settle();
    expect(fake.head(mia)?.rev).toBe(3);
    expect(tagOf(fake.headJson(mia))).toBe('phone-hour');
    expect(fake.revisions(mia).find((r) => r.rev === 2)!.pinnedUntil).toBeGreaterThan(Date.now());
    // the Tablet loses its lease the same way
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(lostB).toHaveLength(1);
    expect(lostB[0]!.info.localDeltaSeconds).toBe(0);
  });

  it('S-3: a reinstall (empty storage) pulls the zoo when it is opened', async () => {
    const { mia, key } = await family('zoo1', 100);
    const C = await phone({ name: 'New phone' });
    await C.cloud.profiles.refresh();
    expect(C.cloud.profiles.list().map((p) => p.name)).toEqual(['Mia']);
    const opened = await C.cloud.sync.openSlot(key, C.prompts);
    expect(opened).toMatchObject({ kind: 'ok', source: 'cloud' });
    expect(tagOf((opened as { json: string }).json)).toBe('zoo1');
    expect(C.cloud.sync.slotState(key)).toBe('synced');
    expect(rec(C, mia).base?.rev).toBe(1);
  });

  it('S-3b: an Auto Backup restore onto a new phone drops the session and never silently overwrites more cloud play', async () => {
    const { A, B, mia, key } = await family('zoo1', 100);
    A.client().offline = true;
    play(A, mia, 'stale-dirty', 150); // 50 s never uploaded
    play(B, mia, 'tablet-lots', 100 + 3000);
    await B.cloud.sync.syncNow();
    // copy the Phone's storage to another phone (different hardware id)
    const copy = new MemoryStorage();
    for (const k of A.storage.keys()) copy.setItem(k, A.storage.getItem(k)!);
    const C = makePhone(fake, { name: 'Restored phone', storage: copy, hwId: 'other-hardware' });
    phones.push(C);
    await C.cloud.init();
    expect(C.cloud.auth.state.get()).toEqual({ kind: 'guest' });
    expect(copy.getItem('wh2:auth')).toBeNull();
    expect(C.cloud.device().id).not.toBe(A.cloud.device().id);
    expect(await C.cloud.auth.signIn()).toEqual({ kind: 'ok', isNew: false });
    const opened = await C.cloud.sync.openSlot(key, C.prompts);
    await settle();
    expect(tagOf((opened as { json: string }).json)).toBe('tablet-lots');
    expect(fake.head(mia)?.rev).toBe(2); // untouched
    expect(tagOf(fake.headJson(mia))).toBe('tablet-lots');
    expect(C.cloud.local.backups(mia)[0]).toMatchObject({ reason: 'auto_pull' });
    expect(C.prompts.log.some((l) => l.kind === 'conflict')).toBe(false);
  });

  it('S-4: sign-out with unsynced changes warns, keeps the data, and the same account pushes after signing in again', async () => {
    const { A, mia, key } = await family('zoo1', 100);
    A.client().offline = true;
    play(A, mia, 'unsynced', 400);
    expect(await A.cloud.auth.signOut()).toBe('unsynced');
    expect(A.cloud.auth.state.get().kind).toBe('signed-in');
    expect(await A.cloud.auth.signOut({ force: true })).toBe('ok');
    expect(A.cloud.auth.state.get()).toEqual({ kind: 'guest' });
    expect(A.storage.getItem('wh2:auth')).toBeNull();
    expect(JSON.parse(A.storage.getItem('wh2:last')!)).toEqual({ accountId: null, player: 'guest' });
    expect(localTag(A, mia)).toBe('unsynced'); // kept, hidden
    expect(A.cloud.profiles.list()).toEqual([]);
    A.client().offline = false;
    expect((await A.cloud.auth.signIn()).kind).toBe('ok');
    await settle();
    expect(tagOf(fake.headJson(mia))).toBe('unsynced');
    expect(A.cloud.sync.slotState(key)).toBe('synced');
  });

  it('S-5: switching player while a pull is in flight: no cross-slot write, and a seq change re-decides', async () => {
    const { A, B, mia, key } = await family('zoo1', 100);
    const ben = (await A.cloud.profiles.create('Ben', { animal: 'bear', color: 3 })).id;
    play(A, ben, 'ben-1', 50);
    await A.cloud.sync.syncNow();
    play(B, mia, 'tablet-more', 100 + 1000);
    await B.cloud.sync.syncNow();
    fake.delayNext('getData', 5_000);
    const run = A.cloud.sync.syncNow();
    await vi.advanceTimersByTimeAsync(1_000);
    // the player switched: Ben plays, and Mia's slot changed under the pull
    play(A, ben, 'ben-2', 80);
    play(A, mia, 'mia-local-edit', 110);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    await settle();
    expect(localTag(A, ben)).toBe('ben-2');
    expect(fake.count('getData', A.client().id)).toBe(2); // the first pull noticed the new seq and decided again
    expect(localTag(A, mia)).toBe('tablet-more');
    expect(A.cloud.local.backups(mia).map((b) => b.reason)).toEqual(['auto_pull']);
    expect(tagOf(decodeSave(A.cloud.local.backupEntries(mia)[0]!.gz))).toBe('mia-local-edit');
    expect(tagOf(fake.headJson(ben))).toBe('ben-2'); // Ben's own slot synced on its own
    expect(A.cloud.sync.slotState(key)).toBe('synced');
  });

  it('S-6: a player removed on another device: 410 → hidden + profileGone; Undo restores it and sync resumes', async () => {
    const { A, mia, key } = await family('zoo1', 100);
    const gone = events(A, 'profileGone');
    fake.removeProfile(mia);
    play(A, mia, 'after-remove', 200);
    await A.cloud.sync.syncNow();
    expect(gone).toEqual([{ profileId: mia }]);
    expect(A.cloud.sync.slotState(key)).toBe('blocked');
    expect(A.cloud.profiles.list()).toEqual([]);
    expect(localTag(A, mia)).toBe('after-remove'); // kept until purgeAt
    expect(await A.cloud.sync.openSlot(key, A.prompts)).toEqual({ kind: 'blocked', reason: 'profile_deleted' });
    await A.cloud.profiles.refresh();
    expect(A.cloud.profiles.removed().map((r) => r.id)).toEqual([mia]);
    await A.cloud.profiles.restore(mia);
    await settle();
    expect(A.cloud.profiles.list().map((p) => p.id)).toEqual([mia]);
    expect(tagOf(fake.headJson(mia))).toBe('after-remove');
    expect(A.cloud.sync.slotState(key)).toBe('synced');
  });

  it('S-7: server restored (new epoch) and the phone has more play: it re-seeds with keep_local, the old head pinned', async () => {
    const { A, mia } = await family('zoo1', 100);
    const backup = fake.snapshot();
    play(A, mia, 'after-backup', 400);
    await A.cloud.sync.syncNow();
    const oldEpoch = fake.epoch;
    const epoch = fake.restoreEpoch(backup);
    expect(fake.head(mia)).toMatchObject({ epoch: oldEpoch, rev: 1 });
    await A.cloud.sync.syncNow();
    expect(fake.head(mia)).toMatchObject({ epoch, rev: 2 });
    expect(tagOf(fake.headJson(mia))).toBe('after-backup');
    expect(fake.revisions(mia).find((r) => r.epoch === oldEpoch && r.rev === 1)!.pinnedUntil).toBeGreaterThan(Date.now());
  });

  it('S-7b: new epoch and the phone is clean with less play: it pulls', async () => {
    const { A, B, mia, key } = await family('zoo1', 500);
    const backup = fake.snapshot();
    play(A, mia, 'lost-by-restore', 600);
    await A.cloud.sync.syncNow();
    await B.cloud.sync.syncNow(); // the Tablet is clean at (E1, rev 2)
    expect(localTag(B, mia)).toBe('lost-by-restore');
    fake.restoreEpoch(backup);
    // the Phone (more play: 600 ≥ 500) re-seeds… then plays on to 900
    await A.cloud.sync.syncNow();
    play(A, mia, 'phone-900', 900);
    await A.cloud.sync.syncNow();
    expect(fake.head(mia)).toMatchObject({ rev: 3, epoch: fake.epoch });
    await B.cloud.sync.syncNow();
    expect(localTag(B, mia)).toBe('phone-900');
    expect(B.cloud.sync.slotState(key)).toBe('synced');
    expect(fake.count('putSave', B.client().id)).toBe(0);
  });

  it('S-8a: a lost answer: the retry finds the push through pushIds, no second upload, no conflict', async () => {
    const { A, mia, key } = await family('zoo1', 100);
    play(A, mia, 'zoo2', 200);
    fake.dropResponseAfterCommit('putSave');
    await A.cloud.sync.syncNow();
    expect(fake.head(mia)?.rev).toBe(2);
    expect(rec(A, mia).pending).toHaveLength(1);
    expect(['pending', 'offline']).toContain(A.cloud.sync.slotState(key));
    await vi.advanceTimersByTimeAsync(6_000); // backoff 5 s
    await settle();
    expect(fake.count('putSave', A.client().id)).toBe(2); // the first (family) push and the lost one
    expect(rec(A, mia)).toMatchObject({ base: { rev: 2 }, pending: [] });
    expect(rec(A, mia).syncedSeq).toBe(rec(A, mia).seq);
    expect(A.cloud.sync.slotState(key)).toBe('synced');
  });

  it('S-8b: app killed after the commit: the ring survives in storage and reconciles on the next start', async () => {
    const { A, mia, key } = await family('zoo1', 100);
    play(A, mia, 'zoo2', 200);
    fake.dropResponseAfterCommit('putSave');
    await A.cloud.sync.syncNow();
    A.cloud.dispose();
    const A2 = makePhone(fake, { name: 'Phone', storage: A.storage });
    phones.push(A2);
    await A2.cloud.init();
    expect(A2.cloud.auth.state.get().kind).toBe('signed-in');
    await A2.cloud.sync.syncNow();
    expect(fake.count('putSave', A2.client().id)).toBe(0);
    expect(rec(A2, mia)).toMatchObject({ base: { rev: 2 }, pending: [] });
    expect(A2.cloud.sync.slotState(key)).toBe('synced');
  });

  it('S-8c: our lost push landed and another device built on it: the clean phone pulls, no conflict', async () => {
    const { A, B, mia, key } = await family('zoo1', 100);
    play(A, mia, 'phone-2', 300);
    fake.dropResponseAfterCommit('putSave');
    A.client().offline = false;
    await A.cloud.sync.syncNow();
    await B.cloud.sync.syncNow();
    expect(localTag(B, mia)).toBe('phone-2');
    play(B, mia, 'tablet-3', 500);
    await B.cloud.sync.syncNow();
    expect(fake.head(mia)?.rev).toBe(3);
    await vi.advanceTimersByTimeAsync(6_000);
    await settle();
    expect(localTag(A, mia)).toBe('tablet-3');
    expect(A.cloud.sync.slotState(key)).toBe('synced');
    expect(A.cloud.local.backups(mia)).toEqual([]);
  });

  it('S-8d: push delivered but committed after the client timeout; a re-push with a new pushId gets 412 whose head is ours → adopted, no conflict', async () => {
    const { A, mia, key } = await family('zoo1', 100);
    const conflicts = events(A, 'conflict');
    play(A, mia, 'a1', 200);
    fake.delayNext('putSave', 40_000); // server commits p1 at +40 s, the client gives up at +35 s
    const first = A.cloud.sync.syncNow();
    await vi.advanceTimersByTimeAsync(36_000);
    await first;
    expect(rec(A, mia).pending).toHaveLength(1);
    const p1 = rec(A, mia).pending[0]!.pushId;
    play(A, mia, 'a2', 260); // new content → new pushId
    fake.delayNext('putSave', 6_000); // processed at +42 s, after p1 landed
    const second = A.cloud.sync.syncNow();
    await vi.advanceTimersByTimeAsync(10_000);
    await second;
    await settle();
    expect(fake.revisions(mia).find((r) => r.rev === 2)!.pushId).toBe(p1);
    // the re-push really met a 412 whose head was our late p1 (adopted from the ring), then went through
    const puts = fake.calls.filter((c) => c.op === 'putSave' && c.client === A.client().id).map((c) => c.status);
    expect(puts).toEqual([200, 200, 412, 200]); // family push, p1 (answer too late), p2 → 412, p2 again
    expect(fake.head(mia)?.rev).toBe(3);
    expect(tagOf(fake.headJson(mia))).toBe('a2');
    expect(conflicts).toEqual([]);
    expect(A.cloud.sync.slotState(key)).toBe('synced');
    expect(rec(A, mia).pending).toEqual([]);
  });

  it('S-9: a 412 race is tried at most 3 rounds, then backs off', async () => {
    const { A, mia } = await family('zoo1', 100);
    play(A, mia, 'phone-long', 600);
    let n = 0;
    fake.before = (op, call) => {
      if (op === 'putSave' && call.client === A.client().id) fake.commitDirect(mia, zooJson(`tiny-${++n}`), meta(100 + n));
    };
    await A.cloud.sync.syncNow();
    expect(fake.count('putSave', A.client().id)).toBe(1 + 3); // family's first push + 3 rounds
    expect(A.cloud.sync.nextTryAt()).toBeGreaterThan(Date.now());
    expect(tagOf(fake.headJson(mia))).toBe('tiny-3');
    fake.before = null;
    await vi.advanceTimersByTimeAsync(6_000);
    await settle();
    expect(tagOf(fake.headJson(mia))).toBe('phone-long');
    expect(fake.revisions(mia).find((r) => r.rev === 4)!.pinnedUntil).toBeGreaterThan(Date.now()); // keep_local pinned tiny-3
  });

  it('S-10: a newer saveVersion in the cloud blocks the slot: never pulled, never pushed over', async () => {
    const { A, mia, key } = await family('zoo1', 100);
    const blocked = events(A, 'blocked');
    fake.commitDirect(mia, JSON.stringify({ version: 2, tag: 'future' }), meta(900), { saveVersion: 2 });
    play(A, mia, 'local', 300);
    await A.cloud.sync.syncNow();
    expect(blocked).toEqual([{ key, reason: 'newer_version' }]);
    expect(A.cloud.sync.slotState(key)).toBe('blocked');
    expect(fake.count('getData', A.client().id)).toBe(0);
    expect(fake.head(mia)?.saveVersion).toBe(2);
    expect(await A.cloud.sync.openSlot(key, A.prompts)).toEqual({ kind: 'blocked', reason: 'newer_version' });
    expect(fake.head(mia)?.rev).toBe(2);
    expect(localTag(A, mia)).toBe('local');
  });

  it('S-11: a 401 → needs-signin, data kept, nothing retried until sign-in', async () => {
    const { A, mia, key } = await family('zoo1', 100);
    fake.expireSessions();
    play(A, mia, 'local', 300);
    await A.cloud.sync.syncNow();
    expect(A.cloud.auth.state.get()).toMatchObject({ kind: 'needs-signin' });
    expect(A.cloud.status.get()).toEqual({ kind: 'needs-signin' });
    const calls = fake.calls.length;
    A.cloud.sync.noteSaved(key);
    play(A, mia, 'local-2', 400);
    await A.cloud.sync.syncNow();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(fake.calls.length).toBe(calls);
    expect(localTag(A, mia)).toBe('local-2');
    expect(JSON.parse(A.storage.getItem('wh2:auth')!).stale).toBe(true);
    expect((await A.cloud.auth.signIn()).kind).toBe('ok');
    await settle();
    expect(tagOf(fake.headJson(mia))).toBe('local-2');
  });

  it('S-12: a wrong device clock changes no decision', async () => {
    async function scenario(skewA: number, skewB: number) {
      fake = new FakeCloud();
      for (const p of phones) p.cloud.dispose();
      phones = [];
      const { A, B, mia } = await family('zoo1', 100);
      A.skewMs = skewA;
      B.skewMs = skewB;
      A.client().offline = true;
      B.client().offline = true;
      play(A, mia, 'phone', 400);
      play(B, mia, 'tablet', 350);
      A.client().offline = false;
      B.client().offline = false;
      await A.cloud.sync.syncNow();
      await B.cloud.sync.syncNow();
      const out = { stateB: B.cloud.sync.slotState(mainKey(mia)), head: tagOf(fake.headJson(mia)) };
      play(A, mia, 'phone-2', 500);
      await A.cloud.sync.syncNow();
      await B.cloud.sync.resolveConflict(mainKey(mia), 'here');
      await settle();
      return { ...out, final: tagOf(fake.headJson(mia)), aState: A.cloud.sync.slotState(mainKey(mia)) };
    }
    const normal = await scenario(0, 0);
    const skewed = await scenario(365 * 86_400_000, -2 * 86_400_000);
    expect(skewed).toEqual(normal);
    expect(normal).toMatchObject({ stateB: 'conflict', head: 'phone' });
  });

  it('S-13: a damaged download is retried and never stored', async () => {
    const { A, B, mia } = await family('zoo1', 100);
    play(B, mia, 'tablet-2', 300);
    await B.cloud.sync.syncNow();
    fake.corruptNextData();
    await A.cloud.sync.syncNow();
    expect(localTag(A, mia)).toBe('zoo1');
    expect(rec(A, mia).base?.rev).toBe(1);
    await vi.advanceTimersByTimeAsync(6_000);
    await settle();
    expect(localTag(A, mia)).toBe('tablet-2');
    expect(fake.count('getData', A.client().id)).toBe(2);
  });

  it('S-14: 20 s offline on the Phone, then 1 h on the Tablet: the Phone pulls silently with a backup (no stash) and a toast, no dialog', async () => {
    const { A, B, mia, key } = await family('zoo1', 1000);
    A.client().offline = true;
    expect(await A.cloud.sync.openSlot(key, A.prompts)).toMatchObject({ kind: 'ok', source: 'local' });
    play(A, mia, 'phone-20s', 1020);
    await A.cloud.sync.onLeave(key);
    expect(await B.cloud.sync.openSlot(key, B.prompts)).toMatchObject({ kind: 'ok' });
    play(B, mia, 'tablet-hour', 1000 + 3600);
    await B.cloud.sync.onLeave(key);
    expect(fake.head(mia)?.rev).toBe(2);
    A.client().offline = false;
    const opened = await A.cloud.sync.openSlot(key, A.prompts);
    await settle();
    expect(opened).toMatchObject({ kind: 'ok', source: 'cloud' });
    expect(tagOf((opened as { json: string }).json)).toBe('tablet-hour');
    expect(A.prompts.toasts).toEqual(["Got Mia's newer zoo from Tablet"]);
    expect(A.prompts.log.some((l) => l.kind === 'conflict' || l.kind === 'takeover')).toBe(false);
    const bak = A.cloud.local.backupEntries(mia);
    expect(bak).toHaveLength(1);
    expect(bak[0]).toMatchObject({ reason: 'auto_pull', stash: false, uploaded: false });
    expect(tagOf(decodeSave(bak[0]!.gz))).toBe('phone-20s');
    expect(fake.stashes(mia)).toEqual([]);
  });

  it('S-15: a New zoo on the Phone (play time keeps counting) reaches the clean Tablet, which never overwrites it', async () => {
    const { A, B, mia, key } = await family('zoo1', 1000);
    play(A, mia, 'new-zoo', 1030);
    await A.cloud.sync.syncNow();
    await B.cloud.sync.syncNow();
    expect(localTag(B, mia)).toBe('new-zoo');
    expect(fake.count('putSave', B.client().id)).toBe(0);
    // even when the Tablet had a few seconds of the old zoo, the new zoo wins (and the old bit is a backup)
    play(A, mia, 'new-zoo-2', 1100);
    await A.cloud.sync.syncNow();
    play(B, mia, 'old-zoo-10s', 1040);
    await B.cloud.sync.syncNow();
    expect(localTag(B, mia)).toBe('new-zoo-2');
    expect(tagOf(fake.headJson(mia))).toBe('new-zoo-2');
    expect(B.cloud.sync.slotState(key)).toBe('synced');
  });

  it('page hide: a keepalive push within the budget plus the lease release; resume after > 60 s pulls a newer zoo (reload)', async () => {
    const { A, B, mia, key } = await family('zoo1', 100);
    await A.cloud.sync.openSlot(key, A.prompts);
    play(A, mia, 'before-hide', 200);
    expect(A.cloud.sync.onHidden(key, 100)).toBeLessThanOrEqual(100); // too small for the push: release only
    expect(fake.calls.filter((c) => c.keepalive && c.op === 'putSave')).toHaveLength(0);
    await A.cloud.sync.onVisible(key, 1_000);
    await settle();
    const mark = fake.calls.length;
    const used = A.cloud.sync.onHidden(key, 65_536 - 2048);
    expect(used).toBeGreaterThan(100);
    expect(used).toBeLessThanOrEqual(65_536 - 2048);
    await settle();
    expect(fake.calls.slice(mark).filter((c) => c.keepalive).map((c) => c.op)).toEqual(['putSave', 'lease']);
    expect(tagOf(fake.headJson(mia))).toBe('before-hide');
    expect(rec(A, mia).syncedSeq).toBe(rec(A, mia).seq);
    // while hidden the Tablet plays on
    expect(await B.cloud.sync.openSlot(key, B.prompts)).toMatchObject({ kind: 'ok' });
    play(B, mia, 'tablet-while-hidden', 900);
    await B.cloud.sync.onLeave(key);
    const t = Date.now();
    const res = await A.cloud.sync.onVisible(key, 5 * 60_000);
    expect(Date.now() - t).toBeLessThanOrEqual(2_000);
    expect(res).toEqual({ kind: 'reload', fromDevice: 'Tablet' });
    expect(localTag(A, mia)).toBe('tablet-while-hidden');
    // onLeave resolves within 3 s even when the server hangs
    fake.delayNext('*', 60_000, 10);
    const t2 = Date.now();
    const leave = A.cloud.sync.onLeave(key);
    await vi.advanceTimersByTimeAsync(3_100);
    await leave;
    expect(Date.now() - t2).toBeLessThanOrEqual(3_100);
  });
});
