// Device identity (P5) and the cloud-disabled handle (spec §1 rule 1: no API base → no request at all).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlotKey } from '../src/core/contracts';
import { sha256HexOfString } from '../src/net/codec';
import { createDeviceProvider } from '../src/net/device';
import { FakeCloud } from '../src/net/fakeCloud';
import { createCloud, MemoryStorage } from '../src/net/index';
import { bootPhone, makePhone, meta, scriptedPrompts, zooJson } from '../src/net/testkit';

const T0 = Date.UTC(2026, 10, 26, 9);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('device identity (P5)', () => {
  it('first run makes a random install id bound to sha256(hardware id); the same phone keeps it', async () => {
    const fake = new FakeCloud();
    const p = makePhone(fake, { name: 'Pixel 7', hwId: 'android-id-1' });
    await p.cloud.init();
    const dev = JSON.parse(p.storage.getItem('wh2:device')!);
    expect(dev.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(dev.hw).toBe(await sha256HexOfString('android-id-1'));
    expect(dev.hw).not.toContain('android-id-1');
    expect(dev.createdAt).toBe(T0);
    const again = makePhone(fake, { name: 'Pixel 7', hwId: 'android-id-1', storage: p.storage });
    await again.cloud.init();
    expect(again.cloud.device().id).toBe(dev.id);
    // a browser (no hardware id) keeps its id too
    const web = makePhone(fake, { name: 'Browser', hwId: null, platform: 'web' });
    await web.cloud.init();
    const webId = web.cloud.device().id;
    const web2 = makePhone(fake, { name: 'Browser', hwId: null, platform: 'web', storage: web.storage });
    await web2.cloud.init();
    expect(web2.cloud.device().id).toBe(webId);
    for (const x of [p, again, web, web2]) x.cloud.dispose();
  });

  it('hardware-id mismatch (Auto Backup restore onto another phone) → new device id and the session dropped; slots kept', async () => {
    const fake = new FakeCloud();
    const a = await bootPhone(fake, { name: 'Old phone', hwId: 'hw-old' });
    const mia = (await a.cloud.profiles.create('Mia', { animal: 'lion', color: 0 })).id;
    a.cloud.local.write(`${mia}/main` as SlotKey, zooJson('z'), meta(10));
    await a.cloud.sync.syncNow();
    const copy = new MemoryStorage();
    for (const k of a.storage.keys()) copy.setItem(k, a.storage.getItem(k)!);
    const b = makePhone(fake, { name: 'New phone', hwId: 'hw-new', storage: copy });
    await b.cloud.init();
    expect(b.cloud.device().id).not.toBe(a.cloud.device().id);
    expect(JSON.parse(copy.getItem('wh2:device')!).hw).toBe(await sha256HexOfString('hw-new'));
    expect(copy.getItem('wh2:auth')).toBeNull();
    expect(b.cloud.auth.state.get()).toEqual({ kind: 'guest' });
    expect(copy.getItem(`wh2:slot:${mia}/main`)).not.toBeNull(); // kept: never synced on this device, CAS protects the cloud
    // the next sign-in registers the new install id with the server
    expect((await b.cloud.auth.signIn()).kind).toBe('ok');
    expect(fake.state.sessions.at(-1)).toMatchObject({ deviceId: b.cloud.device().id, deviceName: 'New phone' });
    a.cloud.dispose();
    b.cloud.dispose();
  });

  it('createDeviceProvider: on the web / in tests it reports a browser without a hardware id', async () => {
    vi.useRealTimers();
    expect(await createDeviceProvider().info()).toEqual({ name: 'Browser', platform: 'web', hwId: null });
  });
});

describe('cloud disabled (no API base)', () => {
  it('makes zero fetch calls through init, openSlot, write, noteSaved, onHidden and onVisible (and every other entry point)', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const storage = new MemoryStorage();
    const google = { available: vi.fn(async () => true), getIdToken: vi.fn(async () => ({ idToken: 'x' })), signOut: vi.fn(async () => undefined) };
    const device = { info: vi.fn(async () => ({ name: 'Pixel 7', platform: 'android' as const, hwId: 'hw' })) };
    const cloud = createCloud({ storage, fetch: fetchSpy as unknown as typeof fetch, google, device, appVersion: '0.15.0', apiBase: '' });
    expect(cloud.enabled).toBe(false);
    await cloud.init();
    expect(cloud.auth.state.get()).toEqual({ kind: 'disabled' });
    expect(cloud.status.get()).toEqual({ kind: 'disabled' });

    const key = 'guest/main' as SlotKey;
    const json = zooJson('guest zoo', { note: 'plain' });
    expect(cloud.local.write(key, json, meta(42))).toBe('saved');
    expect(storage.getItem('wildhaven-save-v1')).toBe(json); // plain JSON, exactly as before
    const prompts = scriptedPrompts();
    expect(await cloud.sync.openSlot(key, prompts)).toEqual({ kind: 'ok', json, meta: expect.any(Object), source: 'local' });
    cloud.sync.noteSaved(key);
    expect(cloud.sync.onHidden(key, 65_536)).toBe(0);
    expect(await cloud.sync.onVisible(key, 10 * 60_000)).toEqual({ kind: 'continue' });
    await cloud.sync.onLeave(key);
    await cloud.sync.syncNow();
    expect(cloud.sync.slotState(key)).toBe('local');
    // everything else is a no-op or a 'disabled' rejection
    expect(await cloud.auth.signIn()).toMatchObject({ kind: 'error' });
    expect(await cloud.auth.signOut()).toBe('ok');
    expect(await cloud.auth.deleteAccount()).toBe('error');
    expect(cloud.profiles.list()).toEqual([]);
    expect(await cloud.profiles.refresh()).toBe(false);
    await expect(cloud.profiles.create('Mia', { animal: 'lion', color: 0 })).rejects.toMatchObject({ code: 'disabled' });
    cloud.profiles.syncTutorialState('x');
    expect(cloud.versus.available).toBe(false);
    expect(cloud.versus.config()).toBeNull();
    await expect(cloud.versus.create({ profileId: 'p', lengthMin: 30, rulesVersion: 1 })).rejects.toMatchObject({ code: 'disabled' });
    cloud.versus.enqueueSnapshots('m', 'p', []);
    expect(await cloud.versus.flush('m')).toBe('offline');
    expect(cloud.versus.flushKeepalive('m', 65_536)).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(google.available).not.toHaveBeenCalled();
    expect(google.getIdToken).not.toHaveBeenCalled();
    expect(device.info).not.toHaveBeenCalled();
    // and no new keys: the guest zoo is the only thing stored
    expect(storage.keys()).toEqual(['wildhaven-save-v1']);
    // the guest practice zoo and the -unreadable backups work as before
    expect(cloud.local.write('guest/practice' as SlotKey, zooJson('p'), meta(1))).toBe('saved');
    expect(storage.getItem('wildhaven-practice-v1')).toBe(zooJson('p'));
    expect(cloud.local.markUnreadable(key, 'bad')).toBe(true);
    expect(storage.getItem('wildhaven-save-v1-unreadable')).toBe('bad');
    cloud.dispose();
  });

  it('without apiBase, createCloud() reads VITE_API_BASE, which tests leave unset', () => {
    const fetchSpy = vi.fn();
    const cloud = createCloud({
      storage: new MemoryStorage(), fetch: fetchSpy as unknown as typeof fetch, appVersion: '0.15.0',
      google: { available: async () => false, getIdToken: async () => null, signOut: async () => undefined },
      device: { info: async () => ({ name: 'x', platform: 'web', hwId: null }) },
    });
    expect(cloud.enabled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
