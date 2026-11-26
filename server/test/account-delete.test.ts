import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MINUTE_MS } from '../src/clock.js';
import { encodeSave, makeProfile, meta, putBody, snap } from './support/helpers.js';
import { makeTestApp, type SignedIn, type TestApp } from './support/testApp.js';

let t: TestApp;
let A: SignedIn;
let B: SignedIn;
beforeEach(async () => {
  t = await makeTestApp();
  A = await t.signIn('parent-a', { id: 'device-a-0000000001', name: 'Mia Phone' }, { email: 'mum@example.com' });
  B = await t.signIn('parent-b', { id: 'device-b-0000000001', name: 'Ben Phone' }, { email: 'dad@example.com' });
});
afterEach(async () => {
  await t.close();
});

async function freshAuth(sub: string): Promise<{ idToken: string; nonce: string }> {
  const n = (await t.call('POST', '/v1/auth/nonce', { body: {} })).body.nonce as string;
  return { idToken: await t.google.mintIdToken({ sub, email: 'x@example.com', nonce: n }), nonce: n };
}

/** Rows that belong to an account, table by table. */
function rowsOf(accountId: string): Record<string, number> {
  const n = (sql: string) => Number(t.db.get<{ n: number }>(sql, accountId)!.n);
  return {
    accounts: n('SELECT count(*) AS n FROM accounts WHERE id = ?'),
    sessions: n('SELECT count(*) AS n FROM sessions WHERE account_id = ?'),
    profiles: n('SELECT count(*) AS n FROM profiles WHERE account_id = ?'),
    saves: n('SELECT count(*) AS n FROM saves s JOIN profiles p ON p.id = s.profile_id WHERE p.account_id = ?'),
    seats: n('SELECT count(*) AS n FROM match_seats WHERE account_id = ?'),
  };
}

describe('DELETE /v1/account', () => {
  it('requires a fresh, valid re-auth with a nonce', async () => {
    expect((await t.call('DELETE', '/v1/account', { token: A.token, body: {} })).status).toBe(422);
    const bad = await t.call('DELETE', '/v1/account', { token: A.token, body: { idToken: 'nope', nonce: 'nope' } });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('token_invalid');
    const tok = await t.google.mintIdToken({ sub: 'parent-a', nonce: 'never-issued' });
    const nn = await t.call('DELETE', '/v1/account', { token: A.token, body: { idToken: tok, nonce: 'never-issued' } });
    expect(nn.status).toBe(401);
    expect(nn.body.error.code).toBe('nonce_invalid');
    expect((await t.call('DELETE', '/v1/account', { body: await freshAuth('parent-a') })).status).toBe(401); // no session
    expect(rowsOf(A.accountId).accounts).toBe(1);
  });

  it('a different Google account → 403 reauth_mismatch and nothing is deleted (P4)', async () => {
    const r = await t.call('DELETE', '/v1/account', { token: A.token, body: await freshAuth('parent-b') });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('reauth_mismatch');
    expect(rowsOf(A.accountId)).toMatchObject({ accounts: 1, sessions: 1 });
    expect(rowsOf(B.accountId)).toMatchObject({ accounts: 1, sessions: 1 });
    expect((await t.call('GET', '/v1/account', { token: A.token })).status).toBe(200);
  });

  it('wipes every row of the account; the opponent seat becomes "Player left"; other accounts untouched', async () => {
    const mia = await makeProfile(t, A.token, 'Mia');
    const lea = await makeProfile(t, A.token, 'Lea');
    const ben = await makeProfile(t, B.token, 'Ben');
    // saves, revisions, stash, lease
    const h = (await t.call('PUT', `/v1/profiles/${mia}/saves/main`, { token: A.token, body: putBody(null) })).body.head;
    await t.call('PUT', `/v1/profiles/${mia}/saves/main`, { token: A.token, body: putBody({ epoch: h.epoch, rev: 1 }) });
    const enc = encodeSave({ lost: 1 });
    await t.call('POST', `/v1/profiles/${mia}/saves/main/stash`, { token: A.token, body: { stashId: '99999999-9999-4999-8999-999999999999', reason: 'replaced', saveVersion: 1, meta: meta(), clientSavedAt: 1, encoding: 'gzip+base64', data: enc.data, sha256: enc.sha256 } });
    await t.call('POST', `/v1/profiles/${lea}/saves/main/lease`, { token: A.token, body: { action: 'acquire' } });
    await t.call('PUT', `/v1/profiles/${ben}/saves/main`, { token: B.token, body: putBody(null) });
    // a coded match against Ben, a family match, and an open challenge of Mia's
    const c = await t.call('POST', '/v1/versus/matches', { token: B.token, body: { profileId: ben, lengthMin: 4, rulesVersion: 1 } });
    await t.call('POST', `/v1/versus/matches/${c.body.match.id}/join`, { token: A.token, body: { profileId: mia, code: c.body.match.code, rulesVersion: 1 } });
    t.clock.advance(10 * MINUTE_MS);
    await t.call('POST', `/v1/versus/matches/${c.body.match.id}/snapshots`, { token: A.token, body: { profileId: mia, snapshots: [snap(6), snap(12)] } });
    const fam = await t.call('POST', '/v1/versus/matches', { token: A.token, body: { profileId: mia, opponentProfileId: lea, lengthMin: 4, rulesVersion: 1 } });
    const open = await t.call('POST', '/v1/versus/matches', { token: A.token, body: { profileId: lea, lengthMin: 4, rulesVersion: 1 } });
    const bBefore = rowsOf(B.accountId);

    const r = await t.call('DELETE', '/v1/account', { token: A.token, body: await freshAuth('parent-a') });
    expect(r.status).toBe(204);
    expect(rowsOf(A.accountId)).toEqual({ accounts: 0, sessions: 0, profiles: 0, saves: 0, seats: 0 });
    for (const table of ['save_revisions', 'save_stash']) {
      const left = t.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} x JOIN saves s ON s.id = x.save_id WHERE s.profile_id IN (?, ?)`, mia, lea)!.n;
      expect(left, table).toBe(0);
    }
    expect(t.db.get<{ n: number }>('SELECT count(*) AS n FROM save_revisions')!.n).toBe(1); // Ben's
    expect(t.db.get<{ n: number }>('SELECT count(*) AS n FROM save_stash')!.n).toBe(0);
    expect(t.db.get<{ n: number }>("SELECT count(*) AS n FROM match_seats WHERE profile_id IN (?, ?)", mia, lea)!.n).toBe(0);
    // family and open matches had nobody left → deleted; the coded match survives with "Player left"
    expect(t.db.get('SELECT 1 AS x FROM matches WHERE id = ?', fam.body.match.id)).toBeUndefined();
    expect(t.db.get('SELECT 1 AS x FROM matches WHERE id = ?', open.body.match.id)).toBeUndefined();
    const seen = await t.call('GET', `/v1/versus/matches/${c.body.match.id}`, { token: B.token, query: { profileId: ben } });
    expect(seen.status).toBe(200);
    expect(seen.body.match.players[1]).toMatchObject({ name: 'Player left', state: 'left', lastHour: 12, total: snap(12).total, device: null });
    expect(t.db.get<{ device_name: string | null; final_save: unknown }>('SELECT device_name, final_save FROM match_seats WHERE match_id = ? AND seat = 1', c.body.match.id)).toEqual({ device_name: null, final_save: null });
    // the session is gone; B is untouched
    expect((await t.call('GET', '/v1/account', { token: A.token })).status).toBe(401);
    expect(rowsOf(B.accountId)).toEqual(bBefore);
    expect((await t.call('GET', `/v1/profiles/${ben}/saves/main`, { token: B.token })).body.head.rev).toBe(1);
    // the same Google account can sign up again from scratch
    const again = await t.signIn('parent-a');
    expect(again.response.isNew).toBe(true);
    expect(again.response.profiles).toEqual([]);
  });
});
