// Storage quotas and create limits under abuse (red team RT-01, RT-03).
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, MINUTE_MS } from '../src/clock.js';
import { runHousekeeping } from '../src/db/housekeeping.js';
import { FINAL_SAVES_SHARE, MAX_CREATES_PER_DAY_ACCOUNT } from '../src/routes/versus.js';
import { encodeSave, makeProfile, putBody, snap } from './support/helpers.js';
import { makeTestApp, type CallResult, type SignedIn, type TestApp } from './support/testApp.js';

const V = '/v1/versus/matches';
let t: TestApp;
let A: SignedIn;

beforeEach(async () => {
  t = await makeTestApp();
  A = await t.signIn('parent-a', { id: 'device-a-0001', name: 'A Phone' });
});
afterEach(async () => {
  await t.close();
});

/** Incompressible gzip save of about `kib` KiB (random base64 padding, calibrated). */
function bigSave(kib: number): { data: string; sha256: string; bytes: Buffer } {
  const target = kib * 1024;
  let len = Math.round(target / 0.76);
  let e = encodeSave({ pad: randomBytes(Math.ceil(len * 0.75)).toString('base64').slice(0, len) });
  for (let i = 0; i < 3 && Math.abs(e.bytes.length - target) > target * 0.0005; i++) {
    len = Math.round(len * (target / e.bytes.length));
    e = encodeSave({ pad: randomBytes(Math.ceil(len * 0.75)).toString('base64').slice(0, len) });
  }
  return e;
}

const asFinal = (e: { data: string; sha256: string }) => ({ encoding: 'gzip+base64', data: e.data, sha256: e.sha256 });
const act = (token: string, id: string, action: string, body: Record<string, unknown>) => t.call('POST', `${V}/${id}/${action}`, { token, body });
const finalBytes = (accountId: string) =>
  Number(t.db.get<{ n: number }>('SELECT COALESCE(SUM(LENGTH(final_save)), 0) AS n FROM match_seats WHERE account_id = ?', accountId)!.n);
const flagsOf = (id: string, seat: number) => JSON.parse(t.db.get<{ flags: string }>('SELECT flags FROM match_seats WHERE match_id = ? AND seat = ?', id, seat)!.flags) as string[];

describe('RT-01: versus final saves cannot fill the database', () => {
  it('family matches keep no final save, round after round of rematches', async () => {
    await t.close();
    t = await makeTestApp({ maxAccountBytes: 1_048_576 });
    A = await t.signIn('parent-a');
    const mia = await makeProfile(t, A.token, 'Mia');
    const lea = await makeProfile(t, A.token, 'Lea');
    let id = (await t.call('POST', V, { token: A.token, body: { rulesVersion: 1, lengthMin: 4, profileId: mia, opponentProfileId: lea } })).body.match.id as string;
    for (let round = 0; round < 3; round++) {
      for (const p of [mia, lea]) {
        const r = await act(A.token, id, 'finish', { profileId: p, final: snap(1), endReason: 'budget', save: asFinal(bigSave(190)) });
        expect(r.status).toBe(200);
      }
      const re = await act(A.token, id, 'rematch', { profileId: round % 2 ? mia : lea });
      expect(re.status).toBe(201);
      id = re.body.match.id;
    }
    expect(finalBytes(A.accountId)).toBe(0);
  });

  it('coded matches: final saves stop at a quarter of MAX_ACCOUNT_BYTES (dropped and flagged, the result still counts), and never crowd out cloud saves', async () => {
    await t.close();
    t = await makeTestApp({ maxAccountBytes: 400_000 });
    A = await t.signIn('parent-a', { id: 'device-a-0001', name: 'A Phone' });
    const B = await t.signIn('parent-b', { id: 'device-b-0001', name: 'B Phone' });
    const mia = await makeProfile(t, A.token, 'Mia');
    const ben = await makeProfile(t, B.token, 'Ben');
    const budget = Math.floor(400_000 * FINAL_SAVES_SHARE);
    const ids: string[] = [];
    for (let round = 0; round < 3; round++) {
      const c = await t.call('POST', V, { token: A.token, body: { rulesVersion: 1, lengthMin: 4, profileId: mia } });
      expect(c.status).toBe(201);
      const id = c.body.match.id as string;
      expect((await act(B.token, id, 'join', { profileId: ben, code: c.body.match.code, rulesVersion: 1 })).status).toBe(200);
      t.clock.advance(10 * MINUTE_MS);
      const r = await act(B.token, id, 'finish', { profileId: ben, final: snap(48), endReason: 'complete', save: asFinal(bigSave(60)) });
      expect(r.status).toBe(200);
      expect(r.body.match.players.find((p: { isMe: boolean }) => p.isMe).state).toBe('done');
      expect((await act(A.token, id, 'forfeit', { profileId: mia })).status).toBe(200);
      ids.push(id);
    }
    expect(finalBytes(B.accountId)).toBeGreaterThan(0);
    expect(finalBytes(B.accountId)).toBeLessThanOrEqual(budget);
    expect(flagsOf(ids[0]!, 1)).not.toContain('save_dropped');
    expect(flagsOf(ids[2]!, 1)).toContain('save_dropped');
    // The stored final save does not count against the cloud-save quota.
    const s = bigSave(340);
    const put = await t.call('PUT', `/v1/profiles/${ben}/saves/main`, { token: B.token, body: putBody(null, { data: s.data, sha256: s.sha256 }) });
    expect(put.status).toBe(200);
  });

  it('rematch goes through the per-account create limiter (10 an hour)', async () => {
    const mia = await makeProfile(t, A.token, 'Mia');
    const lea = await makeProfile(t, A.token, 'Lea');
    let id = (await t.call('POST', V, { token: A.token, body: { rulesVersion: 1, lengthMin: 4, profileId: mia, opponentProfileId: lea } })).body.match.id as string;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      for (const p of [mia, lea]) await act(A.token, id, 'finish', { profileId: p, final: snap(1), endReason: 'budget', save: asFinal(encodeSave({ f: i })) });
      const re = await act(A.token, id, 'rematch', { profileId: i % 2 ? mia : lea });
      statuses.push(re.status);
      if (re.status === 201) id = re.body.match.id;
    }
    // 1 create + 9 rematches use up the hour; then 429.
    expect(statuses.filter((s) => s === 201)).toHaveLength(9);
    expect(statuses.slice(9)).toEqual([429, 429]);
  });

  it(`at most ${MAX_CREATES_PER_DAY_ACCOUNT} new matches a day per account, whatever the number of profiles`, async () => {
    const pids: string[] = [];
    for (const n of ['Mia', 'Lea', 'Ben', 'Ida']) pids.push(await makeProfile(t, A.token, n));
    const createAndCancel = async (pid: string) => {
      const c = await t.call('POST', V, { token: A.token, body: { rulesVersion: 1, lengthMin: 4, profileId: pid } });
      if (c.status === 201) expect((await act(A.token, c.body.match.id, 'cancel', { profileId: pid })).status).toBe(200);
      return c;
    };
    for (let p = 0; p < 3; p++) {
      for (let i = 0; i < 10; i++) expect((await createAndCancel(pids[p]!)).status, `profile ${p} match ${i}`).toBe(201);
      await t.restart(); // a fresh in-memory 10/h limiter: only the daily caps in the DB remain
    }
    const over = await createAndCancel(pids[3]!);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('rate_limited');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    // A day later the account may create again.
    t.clock.advance(DAY_MS + MINUTE_MS);
    expect((await createAndCancel(pids[3]!)).status).toBe(201);
  });
});

describe('RT-03: the save quota measures what stays stored after retention', () => {
  it('one player at the quota keeps saving zoos of the same size (and still can 60 days later)', async () => {
    await t.close();
    const S = bigSave(60).bytes.length;
    t = await makeTestApp({ maxAccountBytes: Math.floor(S * 10.5) });
    A = await t.signIn('parent-a');
    const pid = await makeProfile(t, A.token, 'Mia');
    const url = `/v1/profiles/${pid}/saves/main`;
    let h: { epoch: string; rev: number } | null = null;
    for (let i = 0; i < 12; i++) {
      const e = bigSave(60);
      const r: CallResult = await t.call('PUT', url, { token: A.token, body: putBody(h && { epoch: h.epoch, rev: h.rev }, { data: e.data, sha256: e.sha256 }) });
      expect(r.status, `push ${i + 1}: ${JSON.stringify(r.body.error ?? {})}`).toBe(200);
      h = r.body.head;
    }
    t.clock.advance(60 * DAY_MS);
    runHousekeeping(t.db, t.clock.now());
    const e = bigSave(60);
    const r = await t.call('PUT', url, { token: A.token, body: putBody({ epoch: h!.epoch, rev: h!.rev }, { data: e.data, sha256: e.sha256 }) });
    expect(r.status).toBe(200);
    expect(r.body.head.rev).toBe(13);
  });

  it('several players whose newest 10 saves fill the quota still sync; a push that really grows storage past it is refused and rolled back', async () => {
    await t.close();
    const S = bigSave(40).bytes.length;
    t = await makeTestApp({ maxAccountBytes: Math.floor(3 * S * 10.2) });
    A = await t.signIn('parent-a');
    const pids: string[] = [];
    for (const n of ['Mia', 'Lea', 'Ben']) pids.push(await makeProfile(t, A.token, n));
    const heads = new Map<string, { epoch: string; rev: number }>();
    const push = async (p: string, kib: number) => {
      const e = bigSave(kib);
      const prev = heads.get(p);
      const r = await t.call('PUT', `/v1/profiles/${p}/saves/main`, { token: A.token, body: putBody(prev ? { epoch: prev.epoch, rev: prev.rev } : null, { data: e.data, sha256: e.sha256 }) });
      if (r.status === 200) heads.set(p, r.body.head);
      return r;
    };
    for (let round = 0; round < 11; round++) for (const p of pids) expect((await push(p, 40)).status, `round ${round}`).toBe(200);
    // Twice the size: storage would grow past the quota → 413, and nothing of it stays.
    const before = Number(t.db.get<{ n: number }>('SELECT count(*) AS n FROM save_revisions')!.n);
    const big = await push(pids[0]!, 80);
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('quota');
    expect(Number(t.db.get<{ n: number }>('SELECT count(*) AS n FROM save_revisions')!.n)).toBe(before);
    expect((await t.call('GET', `/v1/profiles/${pids[0]}/saves/main`, { token: A.token })).body.head.rev).toBe(11);
    expect((await push(pids[0]!, 40)).status).toBe(200);
  });
});
