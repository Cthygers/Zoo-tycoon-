import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/clock.js';
import { runHousekeeping } from '../src/db/housekeeping.js';
import { encodeSave, makeProfile, meta, putBody } from './support/helpers.js';
import { makeTestApp, type TestApp } from './support/testApp.js';

let t: TestApp;
let A: { token: string };
let pid: string;
let url: string;
beforeEach(async () => {
  t = await makeTestApp();
  A = await t.signIn('parent-a');
  pid = await makeProfile(t, A.token, 'Mia');
  url = `/v1/profiles/${pid}/saves/main`;
});
afterEach(async () => {
  await t.close();
});

function stashBody(stashId: string, content: Record<string, unknown> = { lost: 'zoo' }) {
  const enc = encodeSave(content);
  return { stashId, reason: 'lease_lost', saveVersion: 1, meta: meta({ playSeconds: 4000 }), clientSavedAt: 1_700_000_000_000, encoding: 'gzip+base64', data: enc.data, sha256: enc.sha256 };
}

describe('stash', () => {
  it('create → 201; replay with the same stashId → 200 with the same body', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const r = await t.call('POST', `${url}/stash`, { token: A.token, body: stashBody(id) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ stashId: id, pinnedUntil: t.clock.now() + 30 * DAY_MS });
    t.clock.advance(5000);
    const again = await t.call('POST', `${url}/stash`, { token: A.token, body: stashBody(id) });
    expect(again.status).toBe(200);
    expect(again.body.stashId).toBe(id);
    expect(again.body.pinnedUntil).toBe(r.body.pinnedUntil);
    expect(t.db.get<{ n: number }>('SELECT count(*) AS n FROM save_stash')!.n).toBe(1);
  });

  it('is never served as the head, never moves the head and never appears in pushIds', async () => {
    const h = (await t.call('PUT', url, { token: A.token, body: putBody(null) })).body.head;
    await t.call('POST', `${url}/stash`, { token: A.token, body: stashBody('33333333-3333-4333-8333-333333333333') });
    const g = await t.call('GET', url, { token: A.token, query: { pushIds: '33333333-3333-4333-8333-333333333333' } });
    expect(g.body.head).toEqual(h);
    expect(g.body.pushed).toBeNull();
    const d = await t.call('GET', `${url}/data`, { token: A.token });
    expect(d.body.head).toEqual(h);
    // a stash on a profile with no head leaves "no cloud zoo"
    const ben = await makeProfile(t, A.token, 'Ben');
    await t.call('POST', `/v1/profiles/${ben}/saves/main/stash`, { token: A.token, body: stashBody('44444444-4444-4444-8444-444444444444') });
    expect((await t.call('GET', `/v1/profiles/${ben}/saves/main`, { token: A.token })).body.head).toBeNull();
    const list = await t.call('GET', '/v1/profiles', { token: A.token });
    expect(list.body.profiles.find((p: { id: string }) => p.id === ben).main).toBeNull();
  });

  it('same size/checksum checks as a push; quota counts stashes', async () => {
    const bad = { ...stashBody('55555555-5555-4555-8555-555555555555'), sha256: 'b'.repeat(64) };
    expect((await t.call('POST', `${url}/stash`, { token: A.token, body: bad })).body.error.code).toBe('checksum');
    expect((await t.call('POST', `${url}/stash`, { token: A.token, body: { ...stashBody('x1234567'), reason: 'whatever' } })).status).toBe(422);

    await t.close();
    const probe = encodeSave({ blob: randomBytes(1500).toString('hex') });
    t = await makeTestApp({ maxAccountBytes: probe.bytes.length + 100 });
    A = await t.signIn('parent-a');
    pid = await makeProfile(t, A.token, 'Mia');
    url = `/v1/profiles/${pid}/saves/main`;
    const s1 = await t.call('POST', `${url}/stash`, { token: A.token, body: stashBody('66666666-6666-4666-8666-666666666666', { blob: randomBytes(1500).toString('hex') }) });
    expect(s1.status).toBe(201);
    const s2 = await t.call('POST', `${url}/stash`, { token: A.token, body: stashBody('77777777-7777-4777-8777-777777777777', { blob: randomBytes(1500).toString('hex') }) });
    expect(s2.status).toBe(413);
    expect(s2.body.error.code).toBe('quota');
    // and the stash counts against pushes too
    const enc = encodeSave({ blob: randomBytes(1500).toString('hex') });
    expect((await t.call('PUT', url, { token: A.token, body: putBody(null, { data: enc.data, sha256: enc.sha256 }) })).body.error.code).toBe('quota');
  });

  it('expires after 30 days (housekeeping)', async () => {
    await t.call('POST', `${url}/stash`, { token: A.token, body: stashBody('88888888-8888-4888-8888-888888888888') });
    t.clock.advance(30 * DAY_MS + 1);
    expect(runHousekeeping(t.db, t.clock.now()).stashes).toBe(1);
    expect(t.db.get<{ n: number }>('SELECT count(*) AS n FROM save_stash')!.n).toBe(0);
  });
});
