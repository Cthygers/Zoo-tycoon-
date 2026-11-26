import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { injectFetch } from './support/injectFetch.js';
import { deepScan, makeProfile, putBody } from './support/helpers.js';
import { makeTestApp, type SignedIn, type TestApp } from './support/testApp.js';

let t: TestApp;
let A: SignedIn;
beforeEach(async () => {
  t = await makeTestApp();
  A = await t.signIn('parent-a', {}, { email: 'secret.parent@example.com' });
});
afterEach(async () => {
  await t.close();
});

describe('CORS (not an auth boundary)', () => {
  it('echoes an allowed origin with exposed headers; other origins get no ACAO', async () => {
    const ok = await t.call('GET', '/v1/config', { headers: { origin: 'https://localhost' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://localhost');
    expect(String(ok.headers['access-control-expose-headers'])).toMatch(/ETag/i);
    expect(String(ok.headers['access-control-expose-headers'])).toMatch(/Retry-After/i);
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    const bad = await t.call('GET', '/v1/config', { headers: { origin: 'https://evil.example.com' } });
    expect(bad.status).toBe(200); // no Origin check on the request itself
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    const none = await t.call('GET', '/v1/config');
    expect(none.status).toBe(200);
    expect(none.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('preflight: methods, headers and max-age', async () => {
    const r = await t.app.inject({
      method: 'OPTIONS',
      url: '/v1/profiles',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type,x-app-version,x-client' },
    });
    expect(r.statusCode).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) expect(String(r.headers['access-control-allow-methods'])).toContain(m);
    for (const h of ['Authorization', 'Content-Type', 'X-App-Version', 'X-Client']) expect(String(r.headers['access-control-allow-headers'])).toContain(h);
    expect(r.headers['access-control-max-age']).toBe('7200');
    const evil = await t.app.inject({ method: 'OPTIONS', url: '/v1/profiles', headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'PUT' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('limits', () => {
  it('body limit (32 KiB default) is enforced before parsing; save routes allow 1.5 MiB', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(40_000), avatar: { animal: 'lion', color: 0 } });
    const r = await t.call('POST', '/v1/profiles', { token: A.token, raw: big, headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('too_large');
    // unauthenticated big bodies are refused before anything is read
    const u = await t.call('POST', '/v1/profiles', { raw: big, headers: { 'content-type': 'application/json' } });
    expect(u.status).toBe(401);
    const pid = await makeProfile(t, A.token, 'Mia');
    const huge = JSON.stringify(putBody(null, { data: 'A'.repeat(1_600_000) }));
    const s = await t.call('PUT', `/v1/profiles/${pid}/saves/main`, { token: A.token, raw: huge, headers: { 'content-type': 'application/json' } });
    expect(s.status).toBe(413);
    // a 100 KB save body is fine on the save route
    const mid = putBody(null);
    expect((await t.call('PUT', `/v1/profiles/${pid}/saves/main`, { token: A.token, body: mid })).status).toBe(200);
  });

  it('rate limits → 429 rate_limited with Retry-After (auth per IP, lease per profile)', async () => {
    let last = await t.call('POST', '/v1/auth/nonce', { body: {} });
    for (let i = 0; i < 12 && last.status !== 429; i++) last = await t.call('POST', '/v1/auth/nonce', { body: {} });
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('rate_limited');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    const pid = await makeProfile(t, A.token, 'Mia');
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await t.call('POST', `/v1/profiles/${pid}/saves/main/lease`, { token: A.token, body: { action: 'renew' } })).status);
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses[6]).toBe(429);
    expect(t.logs.some((l) => l.includes('"kind":"rate_limited"'))).toBe(true);
  });
});

describe('every /v1 route without a session → 401', () => {
  it('walks the route table', async () => {
    const table = t.app.routeTable;
    const open = new Set(['GET /healthz', 'GET /v1/config', 'POST /v1/auth/nonce', 'POST /v1/auth/google', 'GET /privacy', 'GET /account/delete']);
    const expected = [
      'POST /v1/auth/signout', 'GET /v1/account', 'DELETE /v1/account', 'GET /v1/profiles', 'POST /v1/profiles', 'PATCH /v1/profiles/:pid',
      'DELETE /v1/profiles/:pid', 'POST /v1/profiles/:pid/restore', 'GET /v1/profiles/:pid/saves/main', 'GET /v1/profiles/:pid/saves/main/data',
      'PUT /v1/profiles/:pid/saves/main', 'POST /v1/profiles/:pid/saves/main/lease', 'POST /v1/profiles/:pid/saves/main/stash',
      'POST /v1/versus/matches', 'GET /v1/versus/codes/:code', 'POST /v1/versus/matches/:id/join', 'GET /v1/versus/matches',
      'GET /v1/versus/matches/:id', 'POST /v1/versus/matches/:id/snapshots', 'GET /v1/versus/matches/:id/series',
      'POST /v1/versus/matches/:id/finish', 'POST /v1/versus/matches/:id/forfeit', 'POST /v1/versus/matches/:id/cancel',
      'POST /v1/versus/matches/:id/rematch',
    ];
    const all = table.map((r) => `${r.method} ${r.url}`);
    expect(new Set(all)).toEqual(new Set([...expected, ...open]));
    for (const r of table) {
      const key = `${r.method} ${r.url}`;
      if (open.has(key)) continue;
      const url = r.url.replace(':pid', 'AAAAAAAAAAAAAAAAAAAAAA').replace(':id', 'BBBBBBBBBBBBBBBBBBBBBB').replace(':code', 'ABCDEF');
      for (const auth of [undefined, 'Bearer whs_' + 'x'.repeat(43), 'Bearer nonsense']) {
        const res = await t.app.inject({ method: r.method as 'GET', url, headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, ...(r.method !== 'GET' ? { payload: '{}' } : {}) });
        expect(res.statusCode, `${key} ${auth ?? '(none)'}`).toBe(401);
        expect(JSON.parse(res.payload).error.code).toBe('unauthorized');
      }
    }
  });
});

describe('logging', () => {
  it('no tokens, ID tokens, emails, names or IPs in the logs; request lines carry route templates', async () => {
    const pid = await makeProfile(t, A.token, 'Mia Secretname');
    await t.call('PUT', `/v1/profiles/${pid}/saves/main`, { token: A.token, body: putBody(null) });
    await t.call('GET', '/v1/profiles', { token: A.token });
    await t.call('POST', '/v1/auth/google', { body: { idToken: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln', nonce: 'n', device: { id: 'device-x-00000001', name: 'P', platform: 'android', appVersion: '1' } } });
    await t.call('GET', '/v1/account', { token: 'whs_' + 'Z'.repeat(43) });
    const text = t.logs.join('\n');
    expect(t.logs.length).toBeGreaterThan(5);
    expect(text).not.toMatch(/whs_[A-Za-z0-9_-]{10}/);
    expect(text).not.toContain('eyJ');
    expect(text).not.toContain('secret.parent@example.com');
    expect(text).not.toMatch(/@example\.com/);
    expect(text).not.toContain('Secretname');
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain(pid); // route templates, not raw URLs
    const lines = t.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    const req = lines.filter((l) => l.msg === 'request');
    expect(req.some((l) => l.route === '/v1/profiles/:pid/saves/main' && l.status === 200 && l.accountId === A.accountId)).toBe(true);
    expect(lines.some((l) => l.kind === 'token_invalid' && l.level === 40)).toBe(true);
  });

  it('error bodies never echo tokens', async () => {
    const r = await t.call('GET', '/v1/account', { token: 'whs_' + 'Q'.repeat(43) });
    expect(JSON.stringify(r.body)).not.toContain('QQQQ');
  });
});

describe('support modules', () => {
  it('injectFetch maps a Request to app.inject (status, headers, JSON, 204, 304)', async () => {
    const f = injectFetch(t.app);
    const cfg = await f('https://api.example/v1/config', { headers: { 'x-app-version': '0.15.0' } });
    expect(cfg.status).toBe(200);
    expect(((await cfg.json()) as { versusLengths: number[] }).versusLengths).toEqual([30, 60, 90, 120]);
    const prof = await f('https://api.example/v1/profiles', {
      method: 'POST',
      headers: { authorization: `Bearer ${A.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ben', avatar: { animal: 'bear', color: 2 } }),
    });
    expect(prof.status).toBe(201);
    const out = await f(new Request('https://api.example/v1/auth/signout', { method: 'POST', headers: { authorization: `Bearer ${A.token}`, 'content-type': 'application/json' }, body: '{}' }));
    expect(out.status).toBe(204);
    expect(await out.text()).toBe('');
    const ac = new AbortController();
    ac.abort();
    await expect(f('https://api.example/v1/config', { signal: ac.signal })).rejects.toBeTruthy();
  });

  it('deepScan finds nested keys and strings (the versus whitelist test relies on it)', () => {
    const { keys, strings } = deepScan({ a: [{ b: { profileId: 'x' } }], c: 'y' });
    expect(keys.has('profileId')).toBe(true);
    expect(strings.has('x') && strings.has('y')).toBe(true);
  });

  it('static pages: privacy and account deletion with CONTACT_EMAIL, no scripts', async () => {
    for (const url of ['/privacy', '/account/delete']) {
      const r = await t.app.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/html');
      expect(r.payload).toContain('owner@example.test');
      expect(r.payload).not.toContain('{{CONTACT_EMAIL}}');
      expect(r.payload.toLowerCase()).not.toContain('<script');
      expect(String(r.headers['content-security-policy'])).toContain("default-src 'none'");
    }
  });

  it('healthz and config', async () => {
    const h = await t.call('GET', '/healthz');
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ ok: true, db: 'ok', disk: 'ok', backup: 'off' });
    expect(typeof h.body.version).toBe('string');
    const c = await t.call('GET', '/v1/config');
    expect(c.body).toMatchObject({ apiVersion: 1, minAppVersion: null, maxProfiles: 8, versusLengths: [30, 60, 90, 120], versusRulesVersion: 1, testLength: true });
  });
});
