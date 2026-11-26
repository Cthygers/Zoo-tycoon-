import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkName, type NameProblem } from '../../shared/names.js';
import { DAY_MS } from '../src/clock.js';
import { runHousekeeping } from '../src/db/housekeeping.js';
import { makeProfile, putBody } from './support/helpers.js';
import { makeTestApp, type TestApp } from './support/testApp.js';

let t: TestApp;
let A: { token: string; accountId: string };
beforeEach(async () => {
  t = await makeTestApp();
  A = await t.signIn('parent-a');
});
afterEach(async () => {
  await t.close();
});

const avatar = { animal: 'giraffe', color: 3 };

// A slice of the shared name fixtures (tests/shared-names.test.ts): the server must agree with checkName().
const ACCEPTED: [string, string][] = [
  ['Mia', 'Mia'], ['  Mia   Rose  ', 'Mia Rose'], ["O'Brien", "O'Brien"], ['Zoë', 'Zoë'], ['李小龙', '李小龙'],
  ['ＭＩＡ', 'MIA'], ['Mia 2024', 'Mia 2024'], ['Scunthorpe', 'Scunthorpe'], ['Sasha Tiger', 'Sasha Tiger'], ['Abcdefghijklmnop', 'Abcdefghijklmnop'],
];
const REJECTED: [string, NameProblem][] = [
  ['', 'empty'], ['   ', 'empty'], ['mia@zoo.com', 'looks_like_contact'], ['www.mia.net', 'looks_like_contact'],
  ['Abcdefghijklmnopq', 'too_long'], ['Mia 🦁', 'bad_chars'], ['<b>Mia</b>', 'bad_chars'], ['0712345678', 'too_many_digits'],
  ['f.u.c.k', 'not_nice'], ['B1tch', 'not_nice'], ['Dick Head', 'not_nice'],
];

describe('profiles CRUD', () => {
  it('create → list → patch → get via list; DTO shape', async () => {
    const c = await t.call('POST', '/v1/profiles', { token: A.token, body: { name: 'Mia', avatar } });
    expect(c.status).toBe(201);
    expect(c.body.profile).toMatchObject({ name: 'Mia', avatar, prefs: {}, main: null });
    expect(c.body.profile.id).toMatch(/^[A-Za-z0-9_-]{16,32}$/);
    const pid = c.body.profile.id;

    const prefs = { tutorial: { v: 1, status: 'done', readAloud: true, updatedAt: 1_700_000_000_000 } };
    const p = await t.call('PATCH', `/v1/profiles/${pid}`, { token: A.token, body: { name: 'Mia R', avatar: { animal: 'zebra', color: 7 }, prefs } });
    expect(p.status).toBe(200);
    expect(p.body.profile).toMatchObject({ name: 'Mia R', avatar: { animal: 'zebra', color: 7 }, prefs });

    const l = await t.call('GET', '/v1/profiles', { token: A.token });
    expect(l.status).toBe(200);
    expect(l.body.profiles).toHaveLength(1);
    expect(l.body.profiles[0]).toMatchObject({ id: pid, name: 'Mia R', prefs });
    expect(l.body.removed).toEqual([]);
  });

  it('main summary shows the head and the lease', async () => {
    const pid = await makeProfile(t, A.token, 'Mia');
    expect((await t.call('PUT', `/v1/profiles/${pid}/saves/main`, { token: A.token, body: putBody(null) })).status).toBe(200);
    await t.call('POST', `/v1/profiles/${pid}/saves/main/lease`, { token: A.token, body: { action: 'acquire' } });
    const l = await t.call('GET', '/v1/profiles', { token: A.token });
    expect(l.body.profiles[0].main).toMatchObject({ rev: 1, deviceName: 'Test Phone', lease: { deviceName: 'Test Phone', mine: true } });
    expect(l.body.profiles[0].main.meta.day).toBe(3);
  });

  it('validation: avatar, colour, unknown fields, empty patch, prefs > 4 KiB', async () => {
    const bad = [
      { name: 'Mia', avatar: { animal: 'dragon', color: 1 } },
      { name: 'Mia', avatar: { animal: 'lion', color: 8 } },
      { name: 'Mia', avatar: { animal: 'lion', color: 1 }, extra: 1 },
    ];
    for (const body of bad) {
      const r = await t.call('POST', '/v1/profiles', { token: A.token, body });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('invalid');
    }
    const pid = await makeProfile(t, A.token, 'Mia');
    expect((await t.call('PATCH', `/v1/profiles/${pid}`, { token: A.token, body: {} })).status).toBe(422);
    const big = { notes: 'x'.repeat(4100) };
    const r = await t.call('PATCH', `/v1/profiles/${pid}`, { token: A.token, body: { prefs: big } });
    expect(r.status).toBe(422);
    const ok = await t.call('PATCH', `/v1/profiles/${pid}`, { token: A.token, body: { prefs: { notes: 'x'.repeat(3000) } } });
    expect(ok.status).toBe(200);
  });

  it.each(ACCEPTED)('accepts %j as %j', async (raw, name) => {
    const r = await t.call('POST', '/v1/profiles', { token: A.token, body: { name: raw, avatar } });
    expect(r.status).toBe(201);
    expect(r.body.profile.name).toBe(name);
  });

  it.each(REJECTED)('rejects %j (%s) with the shared message', async (raw, problem) => {
    const r = await t.call('POST', '/v1/profiles', { token: A.token, body: { name: raw, avatar } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('bad_name');
    expect(r.body.error.details.problem).toBe(problem);
    const c = checkName(raw);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(r.body.error.message).toBe(c.message);
  });

  it('duplicate names per account (case-insensitive) → 409 name_taken; other accounts may reuse', async () => {
    await makeProfile(t, A.token, 'Mia');
    const r = await t.call('POST', '/v1/profiles', { token: A.token, body: { name: 'mia', avatar } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('name_taken');
    const ben = await makeProfile(t, A.token, 'Ben');
    const rn = await t.call('PATCH', `/v1/profiles/${ben}`, { token: A.token, body: { name: 'MIA' } });
    expect(rn.body.error.code).toBe('name_taken');
    // renaming to its own name (different case) is fine
    expect((await t.call('PATCH', `/v1/profiles/${ben}`, { token: A.token, body: { name: 'BEN' } })).status).toBe(200);
    const B = await t.signIn('parent-b');
    expect((await t.call('POST', '/v1/profiles', { token: B.token, body: { name: 'Mia', avatar } })).status).toBe(201);
  });

  it('at most 8 active profiles → 409 profile_limit', async () => {
    for (let i = 0; i < 8; i++) await makeProfile(t, A.token, `Kid ${i}`);
    const r = await t.call('POST', '/v1/profiles', { token: A.token, body: { name: 'Kid 9', avatar } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('profile_limit');
  });
});

describe('soft delete, undo and purge', () => {
  it('delete → 410 on further calls, listed in removed; restore inside 30 days', async () => {
    const pid = await makeProfile(t, A.token, 'Mia');
    await t.call('PUT', `/v1/profiles/${pid}/saves/main`, { token: A.token, body: putBody(null) });
    await t.call('POST', `/v1/profiles/${pid}/saves/main/lease`, { token: A.token, body: { action: 'acquire' } });
    const d = await t.call('DELETE', `/v1/profiles/${pid}`, { token: A.token });
    expect(d.status).toBe(200);
    expect(d.body.removed).toMatchObject({ id: pid, name: 'Mia', removedAt: t.clock.now(), purgeAt: t.clock.now() + 30 * DAY_MS });
    for (const [m, u, body] of [
      ['PATCH', `/v1/profiles/${pid}`, { name: 'X' }],
      ['DELETE', `/v1/profiles/${pid}`, undefined],
      ['GET', `/v1/profiles/${pid}/saves/main`, undefined],
      ['PUT', `/v1/profiles/${pid}/saves/main`, putBody(null)],
    ] as const) {
      const r = await t.call(m, u, { token: A.token, ...(body ? { body } : {}) });
      expect(r.status, `${m} ${u}`).toBe(410);
      expect(r.body.error.code).toBe('profile_deleted');
      expect(r.body.error.details.purgeAt).toBe(d.body.removed.purgeAt);
    }
    const l = await t.call('GET', '/v1/profiles', { token: A.token });
    expect(l.body.profiles).toEqual([]);
    expect(l.body.removed).toHaveLength(1);
    // lease released, saves kept
    expect(t.db.get<{ lease_until: number | null }>('SELECT lease_until FROM saves')!.lease_until).toBeNull();
    expect(t.db.get<{ n: number }>('SELECT count(*) AS n FROM save_revisions')!.n).toBe(1);

    t.clock.advance(29 * DAY_MS);
    const u = await t.call('POST', `/v1/profiles/${pid}/restore`, { token: A.token, body: {} });
    expect(u.status).toBe(200);
    expect(u.body.profile).toMatchObject({ id: pid, name: 'Mia' });
    expect(u.body.profile.main.rev).toBe(1);
    expect((await t.call('GET', `/v1/profiles/${pid}/saves/main`, { token: A.token })).status).toBe(200);
  });

  it('DELETE with a JSON content type and an empty body is accepted', async () => {
    const pid = await makeProfile(t, A.token, 'Mia');
    const r = await t.call('DELETE', `/v1/profiles/${pid}`, { token: A.token, raw: '', headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(200);
  });

  it('restore: name_taken when the name was reused, profile_limit when 8 are active', async () => {
    const pid = await makeProfile(t, A.token, 'Mia');
    await t.call('DELETE', `/v1/profiles/${pid}`, { token: A.token });
    const again = await makeProfile(t, A.token, 'MIA');
    const r = await t.call('POST', `/v1/profiles/${pid}/restore`, { token: A.token, body: {} });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('name_taken');
    await t.call('PATCH', `/v1/profiles/${again}`, { token: A.token, body: { name: 'Other' } });
    for (let i = 0; i < 7; i++) await makeProfile(t, A.token, `Kid ${i}`);
    const r2 = await t.call('POST', `/v1/profiles/${pid}/restore`, { token: A.token, body: {} });
    expect(r2.body.error.code).toBe('profile_limit');
  });

  it('purge after 30 days (housekeeping): profile, saves, revisions and stashes are gone', async () => {
    const pid = await makeProfile(t, A.token, 'Mia');
    await t.call('PUT', `/v1/profiles/${pid}/saves/main`, { token: A.token, body: putBody(null) });
    await t.call('DELETE', `/v1/profiles/${pid}`, { token: A.token });
    t.clock.advance(30 * DAY_MS - 1);
    runHousekeeping(t.db, t.clock.now());
    expect(t.db.get<{ n: number }>('SELECT count(*) AS n FROM profiles')!.n).toBe(1);
    t.clock.advance(2);
    expect((await t.call('POST', `/v1/profiles/${pid}/restore`, { token: A.token, body: {} })).status).toBe(404);
    const r = runHousekeeping(t.db, t.clock.now());
    expect(r.profilesPurged).toBe(1);
    for (const table of ['profiles', 'saves', 'save_revisions', 'save_stash']) {
      expect(t.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n, table).toBe(0);
    }
    expect((await t.call('GET', '/v1/profiles', { token: A.token })).body.removed).toEqual([]);
  });
});

describe('IDOR matrix', () => {
  it("account B gets 404 (never 403/410) for every route on A's profile", async () => {
    const pid = await makeProfile(t, A.token, 'Mia');
    await t.call('PUT', `/v1/profiles/${pid}/saves/main`, { token: A.token, body: putBody(null) });
    const B = await t.signIn('parent-b', { id: 'device-b-000000001' });
    const stash = { stashId: '11111111-1111-4111-8111-111111111111', reason: 'replaced', ...(({ base, pushId, resolution, ...rest }) => rest)(putBody(null)) };
    const routes: [string, string, unknown?][] = [
      ['PATCH', `/v1/profiles/${pid}`, { name: 'Hacked' }],
      ['DELETE', `/v1/profiles/${pid}`],
      ['POST', `/v1/profiles/${pid}/restore`, {}],
      ['GET', `/v1/profiles/${pid}/saves/main`],
      ['GET', `/v1/profiles/${pid}/saves/main/data`],
      ['PUT', `/v1/profiles/${pid}/saves/main`, putBody(null)],
      ['POST', `/v1/profiles/${pid}/saves/main/lease`, { action: 'acquire', takeover: true }],
      ['POST', `/v1/profiles/${pid}/saves/main/stash`, stash],
    ];
    for (const [m, u, body] of routes) {
      const r = await t.call(m, u, { token: B.token, ...(body !== undefined ? { body } : {}) });
      expect(r.status, `${m} ${u}`).toBe(404);
      expect(r.body.error.code).toBe('not_found');
    }
    // A's data is untouched
    const l = await t.call('GET', '/v1/profiles', { token: A.token });
    expect(l.body.profiles[0]).toMatchObject({ name: 'Mia', main: { rev: 1, lease: null } });
    expect(t.logs.some((line) => line.includes('"kind":"idor_denied"'))).toBe(true);
    // Unknown and malformed ids are 404 too; other slots do not exist.
    expect((await t.call('GET', '/v1/profiles/AAAAAAAAAAAAAAAAAAAAAA/saves/main', { token: A.token })).status).toBe(404);
    expect((await t.call('GET', '/v1/profiles/not!an!id/saves/main', { token: A.token })).status).toBe(404);
    expect((await t.call('GET', `/v1/profiles/${pid}/saves/practice`, { token: A.token })).status).toBe(404);
    expect((await t.call('GET', `/v1/profiles/${pid}/saves/vs-abcdefghijklmnop`, { token: A.token })).status).toBe(404);
  });
});
