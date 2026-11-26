// Access control after sign-in (red team RT-09) and per-IP limits for IPv6 clients (RT-10).
import { afterEach, describe, expect, it } from 'vitest';
import { ipKey } from '../src/app.js';
import { makeProfile } from './support/helpers.js';
import { makeTestApp, type TestApp } from './support/testApp.js';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe('RT-09: ALLOWED_EMAILS holds for live sessions', () => {
  it('an address removed from the list loses access at once (401 → sign in → 403), and can still delete its account', async () => {
    t = await makeTestApp({ ALLOWED_EMAILS: 'kid@example.com,Parent@Example.com' });
    const app = t;
    const kid = await app.signIn('kid-sub', { id: 'device-kid-0001' }, { email: 'kid@example.com' });
    const parent = await app.signIn('parent-sub', { id: 'device-par-0001' }, { email: 'parent@example.com' });
    await makeProfile(app, kid.token, 'Mia');
    expect((await app.call('GET', '/v1/account', { token: kid.token })).status).toBe(200);
    app.config.allowedEmails = ['parent@example.com'];
    await app.restart();
    await expect(app.signIn('kid-sub', {}, { email: 'kid@example.com' })).rejects.toThrow(/403/);
    for (const [m, u] of [['GET', '/v1/account'], ['GET', '/v1/profiles'], ['POST', '/v1/profiles']] as const) {
      const r = await app.call(m, u, { token: kid.token, ...(m === 'POST' ? { body: { name: 'Zed', avatar: { animal: 'lion', color: 0 } } } : {}) });
      expect(r.status, `${m} ${u}`).toBe(401);
      expect(r.body.error.code).toBe('unauthorized');
    }
    expect(app.logs.some((l) => l.includes('"kind":"not_allowed"'))).toBe(true);
    expect((await app.call('GET', '/v1/account', { token: parent.token })).status).toBe(200);
    // Deleting the account (fresh Google re-auth) still works for the removed address.
    const n = (await app.call('POST', '/v1/auth/nonce', { body: {} })).body.nonce;
    const idToken = await app.google.mintIdToken({ sub: 'kid-sub', nonce: n, aud: app.config.googleClientIds[0] });
    expect((await app.call('DELETE', '/v1/account', { token: kid.token, body: { idToken, nonce: n } })).status).toBe(204);
    expect(app.db.get('SELECT 1 AS x FROM accounts WHERE id = ?', kid.accountId)).toBeUndefined();
  });

  it('an account without a verified email is refused while a list is set', async () => {
    t = await makeTestApp();
    const app = t;
    const anon = await app.signIn('anon-sub', {}, { email: 'anon@example.com', emailVerified: false });
    expect((await app.call('GET', '/v1/account', { token: anon.token })).status).toBe(200);
    app.config.allowedEmails = ['anon@example.com'];
    await app.restart();
    expect((await app.call('GET', '/v1/account', { token: anon.token })).status).toBe(401);
  });
});

describe('RT-10: per-IP limits key on the IPv6 /64', () => {
  it('ipKey masks IPv6 to /64 and leaves IPv4 alone', () => {
    expect(ipKey('2001:db8:1:2::1')).toBe(ipKey('2001:db8:1:2:ffff:ffff:ffff:fffe'));
    expect(ipKey('2001:db8:1:2::1')).not.toBe(ipKey('2001:db8:1:3::1'));
    expect(ipKey('198.51.100.7')).toBe('198.51.100.7');
    expect(ipKey('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(ipKey(undefined)).toBe('unknown');
  });

  it('30 nonce requests from one /64 share the 10/min bucket; another /64 has its own', async () => {
    t = await makeTestApp();
    const app = t;
    const statuses: number[] = [];
    for (let i = 1; i <= 30; i++) {
      const r = await app.call('POST', '/v1/auth/nonce', { body: {}, headers: { 'x-forwarded-for': `2001:db8:1:2::${i.toString(16)}` } });
      statuses.push(r.status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
    expect((await app.call('POST', '/v1/auth/nonce', { body: {}, headers: { 'x-forwarded-for': '2001:db8:1:3::1' } })).status).toBe(200);
  });
});
