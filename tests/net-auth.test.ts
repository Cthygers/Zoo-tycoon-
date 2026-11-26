// Auth + profiles: sign-in outcomes in kid words, 401 → needs-signin, the unsynced sign-out path,
// account deletion, online-only profile changes and the tutorial-state mirror.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlotKey } from '../src/core/contracts';
import { readTutorialState, writeTutorialState } from '../src/core/player-state';
import { AUTH_MSG } from '../src/net/auth';
import { FakeCloud } from '../src/net/fakeCloud';
import { fakeGoogleSignIn, nativeGoogleSignIn } from '../src/net/google';
import { PROFILE_MSG } from '../src/net/profiles';
import { bootPhone, mainKey, makePhone, meta, zooJson, type Phone } from '../src/net/testkit';

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

function track(p: Phone): Phone {
  phones.push(p);
  return p;
}

describe('net auth', () => {
  it('signs in: nonce → Google → session in wh2:auth, profiles cached, device name sent', async () => {
    const p = track(makePhone(fake, { name: 'Pixel 7' }));
    await p.cloud.init();
    const seen: string[] = [];
    p.cloud.auth.state.subscribe((s) => seen.push(s.kind));
    expect(p.cloud.auth.state.get()).toEqual({ kind: 'guest' });
    expect(p.cloud.status.get()).toEqual({ kind: 'guest' });
    expect(await p.cloud.auth.signIn()).toEqual({ kind: 'ok', isNew: true });
    expect(seen).toEqual(['signing-in', 'signed-in']);
    const auth = JSON.parse(p.storage.getItem('wh2:auth')!);
    expect(auth.token).toMatch(/^whs_/);
    expect(auth.email).toBe('parent1@example.com');
    expect(p.cloud.auth.accountId).toBe(auth.accountId);
    expect(fake.state.sessions[0]).toMatchObject({ deviceName: 'Pixel 7', platform: 'android', deviceId: p.cloud.device().id });
    expect(fake.calls.map((c) => c.op).slice(0, 2)).toEqual(['nonce', 'signIn']);
    expect(p.cloud.status.get()).toMatchObject({ kind: 'synced' });
    // a second phone of the same Google account: not new; sees the same players
    await p.cloud.profiles.create('Mia', { animal: 'lion', color: 0 });
    const q = track(await bootPhone(fake, { name: 'Tablet' }));
    expect(q.cloud.profiles.list().map((x) => x.name)).toEqual(['Mia']);
    expect(q.cloud.versus.config()).toMatchObject({ apiVersion: 1, versusRulesVersion: 1 });
  });

  it('reports every failure in kid words and a cancel silently', async () => {
    const p = track(makePhone(fake, { name: 'Pixel 7' }));
    await p.cloud.init();
    // cancelled sheet: silent
    p.google = fake.google('x', { cancel: true });
    expect(await p.cloud.auth.signIn()).toEqual({ kind: 'cancelled' });
    expect(p.cloud.auth.state.get()).toEqual({ kind: 'guest' });
    expect(p.storage.getItem('wh2:auth')).toBeNull();
    // no Google on the phone
    p.google = fake.google('x', { available: false });
    expect(await p.cloud.auth.signIn()).toEqual({ kind: 'error', reason: 'no_google', message: AUTH_MSG.noGoogle });
    p.google = fake.google('parent1');
    // offline
    p.client().offline = true;
    expect(await p.cloud.auth.signIn()).toEqual({ kind: 'error', reason: 'offline', message: 'Connect to the internet to sign in' });
    p.client().offline = false;
    // server down
    fake.failNext('nonce', { status: 503, code: 'internal' });
    expect(await p.cloud.auth.signIn()).toEqual({ kind: 'error', reason: 'server', message: "Can't reach the Wildhaven server right now. You can keep playing." });
    // not on the allowlist
    const strict = new FakeCloud({ allowedEmails: ['grownup@example.com'] });
    const s = track(makePhone(strict, { name: 'S' }));
    await s.cloud.init();
    expect(await s.cloud.auth.signIn()).toEqual({
      kind: 'error', reason: 'not_allowed', message: "This Google account can't use Wildhaven online yet. Ask the grown-up who set it up.",
    });
    expect(p.cloud.auth.state.get()).toEqual({ kind: 'guest' });
  });

  it('401 → needs-signin: play goes on, data stays, the state survives a restart, nothing is sent until sign-in', async () => {
    const p = track(await bootPhone(fake, { name: 'Pixel 7' }));
    const mia = (await p.cloud.profiles.create('Mia', { animal: 'lion', color: 0 })).id;
    fake.expireSessions();
    expect(await p.cloud.profiles.refresh()).toBe(false);
    expect(p.cloud.auth.state.get()).toMatchObject({ kind: 'needs-signin', email: 'parent1@example.com' });
    expect(p.cloud.status.get()).toEqual({ kind: 'needs-signin' });
    expect(p.cloud.profiles.list().map((x) => x.id)).toEqual([mia]); // the cached list still works
    expect(p.cloud.local.write(mainKey(mia), zooJson('kept'), meta(10))).toBe('saved');
    const opened = await p.cloud.sync.openSlot(mainKey(mia), p.prompts);
    expect(opened).toMatchObject({ kind: 'ok', source: 'local' });
    await expect(p.cloud.profiles.create('Ben', { animal: 'bear', color: 1 })).rejects.toMatchObject({ code: 'unauthorized', message: 'Sign in again to keep your zoos safe online.' });
    expect(p.cloud.versus.available).toBe(false);
    // restart: still needs-signin, no request
    const before = fake.calls.length;
    const p2 = track(makePhone(fake, { name: 'Pixel 7', storage: p.storage }));
    await p2.cloud.init();
    expect(p2.cloud.auth.state.get().kind).toBe('needs-signin');
    await p2.cloud.sync.syncNow();
    await p2.cloud.sync.openSlot(mainKey(mia), p2.prompts);
    expect(fake.calls.length).toBe(before);
    // sign in again → pushes
    expect((await p2.cloud.auth.signIn()).kind).toBe('ok');
    await vi.advanceTimersByTimeAsync(1);
    await p2.cloud.sync.idle();
    expect(fake.head(mia)).not.toBeNull();
  });

  it('sign-out: unsynced work (a dirty zoo or a stash not uploaded) → "unsynced"; force keeps every local key of the account', async () => {
    const p = track(await bootPhone(fake, { name: 'Pixel 7' }));
    const mia = (await p.cloud.profiles.create('Mia', { animal: 'lion', color: 0 })).id;
    p.cloud.local.write(mainKey(mia), zooJson('z'), meta(10));
    expect(await p.cloud.auth.signOut()).toBe('ok'); // the final sync pushed it
    expect(fake.head(mia)).not.toBeNull();
    expect(p.cloud.auth.state.get()).toEqual({ kind: 'guest' });
    expect(fake.state.sessions.every((s) => s.revoked)).toBe(true);
    // again with a stash that cannot be uploaded
    expect((await p.cloud.auth.signIn()).kind).toBe('ok');
    p.cloud.local.addBackup(mia, { gz: p.cloud.local.getRecord(mainKey(mia))!.gz, meta: meta(10), savedAt: T0, saveVersion: 1, reason: 'lease_lost', fromDevice: 'Pixel 7', stash: true });
    fake.failNext('stash', 'network', 5);
    expect(await p.cloud.auth.signOut()).toBe('unsynced');
    const keysBefore = p.storage.keys().filter((k) => k.startsWith('wh2:') && k !== 'wh2:auth' && k !== 'wh2:last' && k !== 'wh2:index').sort();
    expect(await p.cloud.auth.signOut({ force: true })).toBe('ok');
    const keysAfter = p.storage.keys().filter((k) => k.startsWith('wh2:') && k !== 'wh2:auth' && k !== 'wh2:last' && k !== 'wh2:index').sort();
    expect(keysAfter).toEqual(keysBefore);
    expect(p.storage.getItem('wh2:auth')).toBeNull();
  });

  it('delete account: fresh re-auth, a different Google account is refused, every local key of the account goes', async () => {
    const p = track(await bootPhone(fake, { name: 'Pixel 7' }));
    const acc = p.cloud.auth.accountId!;
    const mia = (await p.cloud.profiles.create('Mia', { animal: 'lion', color: 0 })).id;
    p.cloud.local.write(mainKey(mia), zooJson('z'), meta(10));
    p.cloud.local.write(`${mia}/practice` as SlotKey, zooJson('p'), meta(1));
    writeTutorialState(p.storage, mia, { v: 1, status: 'done', readAloud: true, updatedAt: T0 });
    p.storage.setItem(`wh2:outbox:${acc}:m1`, '{"items":[]}');
    p.cloud.local.write('guest/main' as SlotKey, zooJson('guest'), meta(1));
    // the cancel and the wrong account
    p.google = fake.google('parent1', { cancel: true });
    expect(await p.cloud.auth.deleteAccount()).toBe('cancelled');
    p.google = fake.google('someone-else');
    expect(await p.cloud.auth.deleteAccount()).toBe('mismatch');
    p.client().offline = true;
    expect(await p.cloud.auth.deleteAccount()).toBe('offline');
    p.client().offline = false;
    p.google = fake.google('parent1');
    expect(await p.cloud.auth.deleteAccount()).toBe('ok');
    expect(fake.state.accounts).toEqual([]);
    expect(p.cloud.auth.state.get()).toEqual({ kind: 'guest' });
    const left = p.storage.keys().filter((k) => k.includes(mia) || k.includes(acc));
    expect(left).toEqual([]);
    expect(readTutorialState(p.storage, mia).status).toBe('never');
    expect(p.storage.getItem('wildhaven-save-v1')).toBe(zooJson('guest')); // the guest zoo is not the account's
  });
});

describe('net profiles', () => {
  it('create / rename / avatar / remove / restore online only, with kid-friendly errors', async () => {
    const p = track(await bootPhone(fake, { name: 'Pixel 7' }));
    const mia = await p.cloud.profiles.create('Mia', { animal: 'zebra', color: 2 });
    expect(p.cloud.profiles.player(mia.id)).toEqual({ ref: mia.id, profileId: mia.id, accountId: p.cloud.auth.accountId, name: 'Mia', avatar: { animal: 'zebra', color: 2 } });
    await expect(p.cloud.profiles.create('mia', { animal: 'lion', color: 0 })).rejects.toMatchObject({ code: 'name_taken', message: PROFILE_MSG.taken });
    await expect(p.cloud.profiles.create('', { animal: 'lion', color: 0 })).rejects.toMatchObject({ code: 'bad_name' });
    p.client().offline = true;
    await expect(p.cloud.profiles.create('Ben', { animal: 'bear', color: 0 })).rejects.toMatchObject({ code: 'network', message: 'Connect to the internet to add a player' });
    await expect(p.cloud.profiles.rename(mia.id, 'Mimi')).rejects.toMatchObject({ code: 'network' });
    expect(await p.cloud.profiles.refresh()).toBe(false);
    p.client().offline = false;
    for (const n of ['Ben', 'Ava', 'Leo', 'Zoe', 'Sam', 'Kai', 'Ivy']) await p.cloud.profiles.create(n, { animal: 'hippo', color: 1 });
    await expect(p.cloud.profiles.create('Max', { animal: 'lion', color: 0 })).rejects.toMatchObject({ code: 'profile_limit', message: PROFILE_MSG.limit });
    expect((await p.cloud.profiles.rename(mia.id, 'Mimi')).name).toBe('Mimi');
    expect((await p.cloud.profiles.setAvatar(mia.id, { animal: 'tiger', color: 5 })).avatar).toEqual({ animal: 'tiger', color: 5 });
    const removed = await p.cloud.profiles.remove(mia.id);
    expect(removed.purgeAt - removed.removedAt).toBe(30 * 86_400_000);
    expect(p.cloud.profiles.list().map((x) => x.id)).not.toContain(mia.id);
    expect(p.cloud.profiles.removed().map((x) => x.id)).toEqual([mia.id]);
    await p.cloud.profiles.remove(p.cloud.profiles.list()[0]!.id);
    await p.cloud.profiles.restore(mia.id);
    expect(p.cloud.profiles.list().map((x) => x.name)).toContain('Mimi');
    // the cached list works offline
    p.client().offline = true;
    const p2 = track(makePhone(fake, { name: 'Pixel 7', storage: p.storage }));
    await p2.cloud.init();
    expect(p2.cloud.profiles.list().map((x) => x.name)).toEqual(p.cloud.profiles.list().map((x) => x.name));
  });

  it('last player, guest zoo meta and "Whose zoo is this?" bookkeeping', async () => {
    const p = track(makePhone(fake, { name: 'Pixel 7' }));
    p.storage.setItem('wildhaven-save-v1', zooJson('guest', { day: 12, money: 48000, time: 2000 }));
    await p.cloud.init();
    expect(p.cloud.profiles.guestZoo()).toMatchObject({ day: 12, money: 48000, playSeconds: 2000 });
    expect((await p.cloud.auth.signIn()).kind).toBe('ok');
    const mia = await p.cloud.profiles.create('Mia', { animal: 'zebra', color: 2 });
    expect(p.cloud.profiles.last()).toBe('guest');
    p.cloud.profiles.setLast(mia.id);
    expect(p.cloud.profiles.last()).toBe(mia.id);
    expect(p.cloud.profiles.guestAsked()).toBe(false);
    p.cloud.profiles.setGuestAsked();
    expect(p.cloud.profiles.guestAsked()).toBe(true);
    expect(p.cloud.local.adoptGuestInto(p.cloud.auth.accountId!, mia.id)).toBe('ok');
    expect(p.cloud.profiles.guestZoo()).toBeNull();
    expect(p.cloud.profiles.list()[0]!.local).toMatchObject({ hasMain: true, state: 'pending' });
    await p.cloud.sync.syncNow();
    expect(p.cloud.profiles.list()[0]!.local.state).toBe('synced');
  });

  it('syncTutorialState merges local and prefs.tutorial and PATCHes only real changes (never legacyFromGuest)', async () => {
    const p = track(await bootPhone(fake, { name: 'Pixel 7' }));
    const mia = await p.cloud.profiles.create('Mia', { animal: 'zebra', color: 2 });
    writeTutorialState(p.storage, mia.id, { v: 1, status: 'running', readAloud: true, updatedAt: T0, legacyFromGuest: true });
    p.cloud.profiles.syncTutorialState(mia.id);
    await vi.advanceTimersByTimeAsync(1);
    const fp = fake.state.profiles.find((x) => x.id === mia.id)!;
    expect(fp.prefs.tutorial).toEqual({ v: 1, status: 'running', readAloud: true, updatedAt: T0 });
    const patches = () => fake.count('patchProfile');
    const n = patches();
    p.cloud.profiles.syncTutorialState(mia.id); // nothing new
    await vi.advanceTimersByTimeAsync(1);
    expect(patches()).toBe(n);
    // another device finished it: the higher status wins locally on refresh
    fp.prefs = { tutorial: { v: 1, status: 'done', readAloud: false, updatedAt: T0 + 5000 } };
    await p.cloud.profiles.refresh();
    expect(readTutorialState(p.storage, mia.id)).toMatchObject({ status: 'done', readAloud: false, legacyFromGuest: true });
    expect(patches()).toBe(n);
  });
});

describe('google sign-in providers', () => {
  it('native reports unavailable on the web/tests; fakeGoogle asks the local issuer with sub/email/aud/nonce', async () => {
    expect(await nativeGoogleSignIn('web-client').available()).toBe(false);
    expect(await nativeGoogleSignIn('').available()).toBe(false);
    const urls: string[] = [];
    const g = fakeGoogleSignIn('http://127.0.0.1:8799/', 'e2e-web-client', (async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ idToken: 'tok' }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(await g.available()).toBe(true);
    expect(await g.getIdToken('n0nce')).toEqual({ idToken: 'tok' });
    expect(urls).toEqual(['http://127.0.0.1:8799/token?sub=parent1&email=parent1%40example.com&aud=e2e-web-client&nonce=n0nce']);
  });
});
