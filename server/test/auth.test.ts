import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS } from '../src/clock.js';
import { makeTestApp, type TestApp } from './support/testApp.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

const device = { id: 'device-aaaaaaaa-0001', name: 'Pixel 7', platform: 'android' as const, appVersion: '0.15.0' };

async function nonce(): Promise<string> {
  const r = await t.call('POST', '/v1/auth/nonce', { body: {} });
  expect(r.status).toBe(200);
  expect(typeof r.body.nonce).toBe('string');
  expect(r.body.expiresAt).toBe(t.clock.now() + 10 * 60_000);
  return r.body.nonce;
}

async function google(idToken: string, n: string) {
  return t.call('POST', '/v1/auth/google', { body: { idToken, nonce: n, device } });
}

const nowS = () => Math.floor(t.clock.now() / 1000);

describe('sign-in', () => {
  it('valid token → session, account, config; second sign-in is not new', async () => {
    const n = await nonce();
    const tok = await t.google.mintIdToken({ sub: 'g-1', email: 'Mum@Example.com', nonce: n });
    const r = await google(tok, n);
    expect(r.status).toBe(200);
    expect(r.body.session.token).toMatch(/^whs_[A-Za-z0-9_-]{43}$/);
    expect(r.body.session.expiresAt).toBe(t.clock.now() + 180 * DAY_MS);
    expect(r.body.isNew).toBe(true);
    expect(r.body.account.email).toBe('Mum@Example.com');
    expect(r.body.profiles).toEqual([]);
    expect(r.body.removed).toEqual([]);
    expect(r.body.config).toMatchObject({ apiVersion: 1, maxProfiles: 8, versusLengths: [30, 60, 90, 120], versusRulesVersion: 1 });
    expect(typeof r.body.serverTime).toBe('number');
    const me = await t.call('GET', '/v1/account', { token: r.body.session.token });
    expect(me.status).toBe(200);
    expect(me.body.account.id).toBe(r.body.account.id);

    const n2 = await nonce();
    const r2 = await google(await t.google.mintIdToken({ sub: 'g-1', email: 'mum@example.com', nonce: n2 }), n2);
    expect(r2.status).toBe(200);
    expect(r2.body.isNew).toBe(false);
    expect(r2.body.account.id).toBe(r.body.account.id);
    // The token is stored only as a hash.
    const rows = t.db.all<{ token_hash: Uint8Array }>('SELECT token_hash FROM sessions');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(Buffer.from(row.token_hash).toString('latin1')).not.toContain('whs_');
  });

  it.each([
    ['wrong aud', () => ({ aud: 'someone-else' })],
    ['wrong iss', () => ({ iss: 'https://evil.example.com' })],
    ['expired', () => ({ iat: nowS() - 7200, exp: nowS() - 3600 })],
    ['future iat', () => ({ iat: nowS() + 3600, exp: nowS() + 7200 })],
    ['too old (maxTokenAge 15m)', () => ({ iat: nowS() - 20 * 60, exp: nowS() + 3600 })],
    ['unknown kid', () => ({ kid: 'rotated-away' })],
  ])('%s → 401 token_invalid', async (_name, claims) => {
    const n = await nonce();
    const tok = await t.google.mintIdToken({ sub: 'g-1', email: 'a@example.com', nonce: n, ...claims() });
    const r = await google(tok, n);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('token_invalid');
  });

  it('exp within the 60 s clock tolerance still verifies', async () => {
    const n = await nonce();
    const r = await google(await t.google.mintIdToken({ sub: 'g-1', nonce: n, iat: nowS() - 600, exp: nowS() - 30 }), n);
    expect(r.status).toBe(200);
  });

  it('both Google issuer spellings are accepted', async () => {
    for (const iss of ['https://accounts.google.com', 'accounts.google.com']) {
      const n = await nonce();
      const r = await google(await t.google.mintIdToken({ sub: 'g-iss', nonce: n, iss }), n);
      expect(r.status).toBe(200);
    }
  });

  it('bad signature → 401 token_invalid; garbage and oversize tokens too', async () => {
    const n = await nonce();
    expect((await google(await t.google.mintForged({ sub: 'g-1', nonce: n }), n)).body.error.code).toBe('token_invalid');
    expect((await google('not.a.jwt', n)).body.error.code).toBe('token_invalid');
    expect((await google('x'.repeat(5000), n)).body.error.code).toBe('token_invalid');
  });

  it('nonce: missing, mismatched, unknown, expired and reused → 401 nonce_invalid', async () => {
    const n = await nonce();
    const noNonce = await t.google.mintIdToken({ sub: 'g-1' });
    expect((await google(noNonce, n)).body.error.code).toBe('nonce_invalid');
    const other = await nonce();
    expect((await google(await t.google.mintIdToken({ sub: 'g-1', nonce: other }), n)).body.error.code).toBe('nonce_invalid');
    expect((await google(await t.google.mintIdToken({ sub: 'g-1', nonce: 'never-issued' }), 'never-issued')).body.error.code).toBe('nonce_invalid');
    // reuse: the first use succeeds, the second fails
    const ok = await google(await t.google.mintIdToken({ sub: 'g-1', nonce: n }), n);
    expect(ok.status).toBe(200);
    const again = await google(await t.google.mintIdToken({ sub: 'g-1', nonce: n }), n);
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('nonce_invalid');
    // expired after 10 minutes (the token itself is minted fresh at the new clock time)
    const late = await nonce();
    t.clock.advance(10 * 60_000 + 1);
    const r = await google(await t.google.mintIdToken({ sub: 'g-1', nonce: late }), late);
    expect(r.body.error.code).toBe('nonce_invalid');
  });

  it('email_verified:false → no email stored', async () => {
    const s = await t.signIn('g-unverified', {}, { email: 'kid@example.com', emailVerified: false });
    expect(s.response.account.email).toBeNull();
    expect(t.db.get<{ email: string | null }>('SELECT email FROM accounts WHERE id = ?', s.accountId)!.email).toBeNull();
  });

  it('malformed body → 422 invalid; non-JSON → 415; broken JSON → 400', async () => {
    const r = await t.call('POST', '/v1/auth/google', { body: { idToken: 'x' } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('invalid');
    expect(Array.isArray(r.body.error.details.issues)).toBe(true);
    const r2 = await t.call('POST', '/v1/auth/google', { raw: 'hello', headers: { 'content-type': 'text/plain' } });
    expect(r2.status).toBe(415);
    expect(r2.body.error.code).toBe('unsupported_media_type');
    const r3 = await t.call('POST', '/v1/auth/google', { raw: '{bad json', headers: { 'content-type': 'application/json' } });
    expect(r3.status).toBe(400);
    expect(r3.body.error.code).toBe('bad_request');
    const r4 = await t.call('POST', '/v1/auth/google', { raw: '{"__proto__":{"x":1}}', headers: { 'content-type': 'application/json' } });
    expect(r4.status).toBe(400);
  });
});

describe('ALLOWED_EMAILS', () => {
  it('only listed (verified) emails may sign in, case-insensitively', async () => {
    await t.close();
    t = await makeTestApp({ ALLOWED_EMAILS: 'Mum@Example.com, dad@example.com' });
    await expect(t.signIn('g-mum', {}, { email: 'mum@example.COM' })).resolves.toBeTruthy();
    const n = (await t.call('POST', '/v1/auth/nonce', { body: {} })).body.nonce;
    const r = await google(await t.google.mintIdToken({ sub: 'g-stranger', email: 'stranger@example.com', nonce: n }), n);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('not_allowed');
    const n2 = (await t.call('POST', '/v1/auth/nonce', { body: {} })).body.nonce;
    const r2 = await google(await t.google.mintIdToken({ sub: 'g-unv', email: 'dad@example.com', emailVerified: false, nonce: n2 }), n2);
    expect(r2.status).toBe(403);
    expect(t.db.get<{ n: number }>('SELECT count(*) AS n FROM accounts')!.n).toBe(1);
  });
});

describe('sessions', () => {
  it('sliding expiry is touched at most once per 24 h; idle past 180 days → 401', async () => {
    const s = await t.signIn('g-slide');
    const row = () => t.db.get<{ expires_at: number; last_touched_at: number; absolute_expires_at: number }>('SELECT * FROM sessions')!;
    const first = row();
    t.clock.advance(12 * HOUR_MS);
    expect((await t.call('GET', '/v1/profiles', { token: s.token })).status).toBe(200);
    expect(row().expires_at).toBe(first.expires_at); // not touched within 24 h
    expect(row().last_touched_at).toBe(first.last_touched_at);
    t.clock.advance(13 * HOUR_MS);
    expect((await t.call('GET', '/v1/profiles', { token: s.token })).status).toBe(200);
    expect(row().expires_at).toBe(t.clock.now() + 180 * DAY_MS);
    expect(row().last_touched_at).toBe(t.clock.now());
    t.clock.advance(180 * DAY_MS + 1);
    const r = await t.call('GET', '/v1/profiles', { token: s.token });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthorized');
  });

  it('absolute expiry after 730 days even when used every few months', async () => {
    const s = await t.signIn('g-abs');
    const start = t.clock.now();
    while (t.clock.now() + 100 * DAY_MS < start + 730 * DAY_MS) {
      t.clock.advance(100 * DAY_MS);
      expect((await t.call('GET', '/v1/profiles', { token: s.token })).status).toBe(200);
    }
    const abs = t.db.get<{ absolute_expires_at: number; expires_at: number }>('SELECT * FROM sessions')!;
    expect(abs.absolute_expires_at).toBe(start + 730 * DAY_MS);
    expect(abs.expires_at).toBe(abs.absolute_expires_at); // capped
    t.clock.set(abs.absolute_expires_at);
    expect((await t.call('GET', '/v1/profiles', { token: s.token })).status).toBe(401);
  });

  it('sign-out revokes the session (idempotent); unknown and missing tokens → 401', async () => {
    const s = await t.signIn('g-out');
    const other = await t.signIn('g-out', { id: 'device-tablet-0002', name: 'Tablet' });
    expect((await t.call('POST', '/v1/auth/signout', { token: s.token, body: {} })).status).toBe(204);
    expect((await t.call('POST', '/v1/auth/signout', { token: s.token, body: {} })).status).toBe(204);
    expect((await t.call('GET', '/v1/account', { token: s.token })).status).toBe(401);
    expect((await t.call('GET', '/v1/account', { token: other.token })).status).toBe(200);
    expect((await t.call('POST', '/v1/auth/signout', { body: {} })).status).toBe(401);
    expect((await t.call('GET', '/v1/account', { token: 'whs_' + 'A'.repeat(43) })).status).toBe(401);
    expect((await t.call('GET', '/v1/account', { headers: { authorization: 'Basic abc' } })).status).toBe(401);
  });

  it('there is no refresh endpoint', async () => {
    const r = await t.call('POST', '/v1/auth/refresh', { body: {} });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });

  it('MIN_APP_VERSION: older X-App-Version → 426 (config stays readable)', async () => {
    await t.close();
    t = await makeTestApp({ MIN_APP_VERSION: '0.16.0' });
    const r = await t.call('POST', '/v1/auth/nonce', { body: {}, headers: { 'x-app-version': '0.15.9' } });
    expect(r.status).toBe(426);
    expect(r.body.error.code).toBe('upgrade_required');
    expect((await t.call('GET', '/v1/config', { headers: { 'x-app-version': '0.15.9' } })).body.minAppVersion).toBe('0.16.0');
    expect((await t.call('POST', '/v1/auth/nonce', { body: {}, headers: { 'x-app-version': '0.16.0' } })).status).toBe(200);
  });
});
