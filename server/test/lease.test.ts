import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeProfile, putBody } from './support/helpers.js';
import { makeTestApp, type TestApp } from './support/testApp.js';

let t: TestApp;
let phone: { token: string; deviceId: string };
let tablet: { token: string; deviceId: string };
let pid: string;
let url: string;
beforeEach(async () => {
  t = await makeTestApp();
  phone = await t.signIn('parent-a', { id: 'device-phone-000001', name: 'Phone' });
  tablet = await t.signIn('parent-a', { id: 'device-tablet-00001', name: 'Tablet' });
  pid = await makeProfile(t, phone.token, 'Mia');
  url = `/v1/profiles/${pid}/saves/main`;
});
afterEach(async () => {
  await t.close();
});

const lease = (token: string, action: string, takeover?: boolean) =>
  t.call('POST', `${url}/lease`, { token, body: { action, ...(takeover !== undefined ? { takeover } : {}) } });

describe('lease', () => {
  it('acquire / renew / release by the holder', async () => {
    const a = await lease(phone.token, 'acquire');
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ lease: { deviceName: 'Phone', until: t.clock.now() + 150_000, mine: true }, head: null });
    t.clock.advance(60_000);
    const r = await lease(phone.token, 'renew');
    expect(r.body.lease.until).toBe(t.clock.now() + 150_000);
    const seen = await t.call('GET', url, { token: tablet.token });
    expect(seen.body.lease).toMatchObject({ deviceName: 'Phone', mine: false });
    const rel = await lease(phone.token, 'release');
    expect(rel.status).toBe(200);
    expect(rel.body.lease).toBeNull();
    expect((await t.call('GET', url, { token: tablet.token })).body.lease).toBeNull();
  });

  it('acquire while another device holds it → 409 in_use with holder + head; takeover wins', async () => {
    const h = (await t.call('PUT', url, { token: phone.token, body: putBody(null) })).body.head;
    await lease(phone.token, 'acquire');
    t.clock.advance(20_000);
    await lease(phone.token, 'renew');
    const busy = await lease(tablet.token, 'acquire');
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('in_use');
    expect(busy.body.error.details).toEqual({ holder: { deviceName: 'Phone', lastSeenAt: t.clock.now() }, head: h });
    const take = await lease(tablet.token, 'acquire', true);
    expect(take.status).toBe(200);
    expect(take.body.lease).toMatchObject({ deviceName: 'Tablet', mine: true });
    // the phone's renew now fails with lease_lost
    const lost = await lease(phone.token, 'renew');
    expect(lost.status).toBe(409);
    expect(lost.body.error.code).toBe('lease_lost');
    expect(lost.body.error.details.holder.deviceName).toBe('Tablet');
    // releasing someone else's lease is a no-op (still 200)
    expect((await lease(phone.token, 'release')).status).toBe(200);
    expect((await t.call('GET', url, { token: tablet.token })).body.lease).toMatchObject({ deviceName: 'Tablet', mine: true });
  });

  it('PUT from a non-holder while the lease is live → 409 leased_elsewhere', async () => {
    const h = (await t.call('PUT', url, { token: phone.token, body: putBody(null) })).body.head;
    await lease(tablet.token, 'acquire');
    const r = await t.call('PUT', url, { token: phone.token, body: putBody({ epoch: h.epoch, rev: 1 }) });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('leased_elsewhere');
    expect(r.body.error.details.holder.deviceName).toBe('Tablet');
    expect(r.body.error.details.head).toEqual(h);
  });

  it('the lease expires after 150 s: then anyone may push or acquire', async () => {
    const h = (await t.call('PUT', url, { token: phone.token, body: putBody(null) })).body.head;
    await lease(tablet.token, 'acquire');
    t.clock.advance(149_999);
    expect((await t.call('PUT', url, { token: phone.token, body: putBody({ epoch: h.epoch, rev: 1 }) })).status).toBe(409);
    t.clock.advance(1);
    expect((await t.call('GET', url, { token: phone.token })).body.lease).toBeNull();
    expect((await t.call('PUT', url, { token: phone.token, body: putBody({ epoch: h.epoch, rev: 1 }) })).status).toBe(200);
    expect((await lease(phone.token, 'acquire')).status).toBe(200);
    // renew after expiry by the old holder re-acquires when nobody else holds it
    t.clock.advance(200_000);
    expect((await lease(tablet.token, 'renew')).status).toBe(200);
  });

  it('a push by the holder extends the lease', async () => {
    await lease(phone.token, 'acquire');
    t.clock.advance(100_000);
    const r = await t.call('PUT', url, { token: phone.token, body: putBody(null) });
    expect(r.status).toBe(200);
    const g = await t.call('GET', url, { token: phone.token });
    expect(g.body.lease.until).toBe(t.clock.now() + 150_000);
  });

  it('invalid action → 422', async () => {
    expect((await lease(phone.token, 'steal')).status).toBe(422);
  });
});
