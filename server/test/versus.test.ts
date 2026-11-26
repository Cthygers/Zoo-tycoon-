import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MatchDto } from '../../shared/api-types.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../src/clock.js';
import { runHousekeeping } from '../src/db/housekeeping.js';
import { randomId } from '../src/ids.js';
import { deepScan, encodeSave, makeProfile, sha256hex, snap } from './support/helpers.js';
import { makeTestApp, type SignedIn, type TestApp } from './support/testApp.js';

const V = '/v1/versus/matches';
let t: TestApp;
let A: SignedIn; // parent-a: Mia and Lea (family)
let B: SignedIn; // parent-b: Ben
let mia: string;
let lea: string;
let ben: string;

interface Captured { viewer: 'A' | 'B'; route: string; status: number; body: unknown }
let captured: Captured[] = [];

beforeEach(async () => {
  t = await makeTestApp();
  A = await t.signIn('parent-a', { id: 'device-a-phone-0001', name: 'Mia Phone' }, { email: 'mum@example.com' });
  B = await t.signIn('parent-b', { id: 'device-b-phone-0001', name: 'Ben Phone' }, { email: 'dad@example.com' });
  mia = await makeProfile(t, A.token, 'Mia', 'lion', 1);
  lea = await makeProfile(t, A.token, 'Lea', 'zebra', 2);
  ben = await makeProfile(t, B.token, 'Ben', 'hippo', 4);
  captured = [];
});

afterEach(async () => {
  // api §8: the deep key scan runs over EVERY versus response captured in the test.
  try {
    scanAll();
  } finally {
    await t.close();
  }
});

const FORBIDDEN_KEYS = ['profileId', 'accountId', 'account_id', 'profile_id', 'email', 'deviceId', 'deviceName', 'invited_profile_id', 'google_sub'];

function scanAll(): void {
  const ids = [mia, lea, ben, A.accountId, B.accountId, A.email, B.email, A.deviceId, B.deviceId, 'mum@example.com', 'dad@example.com'];
  for (const c of captured) {
    let body = JSON.parse(JSON.stringify(c.body)) as Record<string, any> | null;
    if (body && body.error?.code === 'other_device') {
      // The one documented exception: the caller's OWN bound device (never the opponent's).
      expect(typeof body.error.details.deviceName).toBe('string');
      delete body.error.details.deviceName;
    }
    const { keys, strings } = deepScan(body);
    for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `${c.route} (${c.viewer}) has key ${k}`).toBe(false);
    for (const s of ids) expect(strings.has(s), `${c.route} (${c.viewer}) leaks ${s}`).toBe(false);
    for (const s of strings) for (const id of ids) expect(s.includes(id), `${c.route} (${c.viewer}) embeds ${id}`).toBe(false);
    // Another account's device name never reaches this viewer.
    const otherDevice = c.viewer === 'A' ? 'Ben Phone' : 'Mia Phone';
    for (const s of strings) expect(s, `${c.route} (${c.viewer})`).not.toContain(otherDevice);
    const matches: MatchDto[] = body?.match ? [body.match] : Array.isArray(body?.matches) ? body!.matches : [];
    for (const m of matches) for (const p of m.players) if (!p.isMe) expect(p.device, `${c.route}: device on another seat`).toBeNull();
    body = null;
  }
}

async function vcall(viewer: 'A' | 'B', method: string, url: string, body?: unknown, query?: Record<string, string | number | undefined>, token?: string) {
  const r = await t.call(method, url, { token: token ?? (viewer === 'A' ? A.token : B.token), ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}) });
  const route = method + ' ' + url.replace(/[A-Za-z0-9_-]{16,32}/g, ':id').replace(/codes\/[^/?]+/, 'codes/:code');
  captured.push({ viewer, route, status: r.status, body: r.body });
  return r;
}

const create = (viewer: 'A' | 'B', body: Record<string, unknown>) => vcall(viewer, 'POST', V, { rulesVersion: 1, lengthMin: 4, ...body });
const get = (viewer: 'A' | 'B', id: string, profileId: string) => vcall(viewer, 'GET', `${V}/${id}`, undefined, { profileId });
const post = (viewer: 'A' | 'B', id: string, action: string, body: Record<string, unknown>, token?: string) => vcall(viewer, 'POST', `${V}/${id}/${action}`, body, undefined, token);
const snaps = (viewer: 'A' | 'B', id: string, profileId: string, hs: number[], over: (h: number) => Parameters<typeof snap>[1] = () => ({}), token?: string) =>
  post(viewer, id, 'snapshots', { profileId, snapshots: hs.map((h) => snap(h, over(h))) }, token);
const finalSave = () => {
  const e = encodeSave({ final: true });
  return { encoding: 'gzip+base64', data: e.data, sha256: e.sha256 };
};
const finish = (viewer: 'A' | 'B', id: string, profileId: string, h: number, endReason: 'complete' | 'budget', over: Parameters<typeof snap>[1] = {}) =>
  post(viewer, id, 'finish', { profileId, final: snap(h, over), endReason, save: finalSave() });
const range = (from: number, to: number, step = 6) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
const flagsOf = (id: string, seat: number) => JSON.parse(t.db.get<{ flags: string }>('SELECT flags FROM match_seats WHERE match_id = ? AND seat = ?', id, seat)!.flags) as string[];

/** Coded match: Mia (A) creates, Ben (B) joins with the code. */
async function coded(lengthMin = 4): Promise<string> {
  const c = await create('A', { profileId: mia, lengthMin });
  expect(c.status).toBe(201);
  const j = await post('B', c.body.match.id, 'join', { profileId: ben, code: c.body.match.code, rulesVersion: 1 });
  expect(j.status).toBe(200);
  return c.body.match.id;
}

describe('create, preview, join', () => {
  it('coded match: open, code for seat 0 only, preview, join → active with finishBy', async () => {
    const c = await create('A', { profileId: mia });
    expect(c.status).toBe(201);
    const m = c.body.match as MatchDto;
    expect(m).toMatchObject({ kind: 'coded', status: 'open', lengthMin: 4, days: 2, startMoney: 100_000, startMinute: 510, budgetMin: 6, rulesVersion: 1, mySeat: 0, joinedAt: null, finishBy: null, result: null });
    expect(m.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(m.codeExpiresAt).toBe(m.createdAt + 48 * HOUR_MS);
    expect(m.players).toHaveLength(1);
    expect(m.players[0]).toMatchObject({ seat: 0, role: 'challenger', name: 'Mia', avatar: { animal: 'lion', color: 1 }, isMe: true, state: 'joined', device: null });
    expect(Number.isInteger(m.seed) && m.seed >= 0 && m.seed < 2 ** 31).toBe(true);

    const code = `${m.code!.slice(0, 3).toLowerCase()}-${m.code!.slice(3)}`; // case/dash-insensitive
    const p = await vcall('B', 'GET', `/v1/versus/codes/${code}`, undefined, { profileId: ben });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ matchId: m.id, challenger: { name: 'Mia', avatar: { animal: 'lion', color: 1 } }, lengthMin: 4, days: 2, status: 'open', codeExpiresAt: m.codeExpiresAt });
    expect((await vcall('B', 'GET', '/v1/versus/codes/ZZZZZZ', undefined, { profileId: ben })).status).toBe(404);
    expect((await vcall('B', 'GET', '/v1/versus/codes/0OIL11', undefined, { profileId: ben })).status).toBe(404);

    t.clock.advance(MINUTE_MS);
    const j = await post('B', m.id, 'join', { profileId: ben, code, rulesVersion: 1 });
    expect(j.status).toBe(200);
    const jm = j.body.match as MatchDto;
    expect(jm).toMatchObject({ status: 'active', mySeat: 1, code: null, joinedAt: t.clock.now(), finishBy: t.clock.now() + 72 * HOUR_MS });
    expect(jm.players.map((x) => [x.seat, x.name, x.isMe, x.state])).toEqual([[0, 'Mia', false, 'joined'], [1, 'Ben', true, 'joined']]);
    // Joined codes still answer the preview ("Someone already joined this one").
    expect((await vcall('B', 'GET', `/v1/versus/codes/${m.code}`, undefined, { profileId: ben })).body.status).toBe('active');
    // the challenger no longer sees the code
    expect((await get('A', m.id, mia)).body.match.code).toBeNull();
  });

  it('join errors: wrong/missing code 404, own_match 403, match_full, code_expired, match_state, rules 426', async () => {
    const c = await create('A', { profileId: mia });
    const id = c.body.match.id;
    const code = c.body.match.code;
    expect((await post('B', id, 'join', { profileId: ben, code: 'ABCDEF', rulesVersion: 1 })).status).toBe(404);
    expect((await post('B', id, 'join', { profileId: ben, rulesVersion: 1 })).status).toBe(404);
    expect((await post('B', id, 'join', { profileId: ben, code, rulesVersion: 2 })).status).toBe(426);
    const own = await post('A', id, 'join', { profileId: mia, code, rulesVersion: 1 });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('own_match');
    // a different profile of the same account may join (family for anti-cheat)
    expect((await post('A', id, 'join', { profileId: lea, code, rulesVersion: 1 })).status).toBe(200);
    const full = await post('B', id, 'join', { profileId: ben, code, rulesVersion: 1 });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('match_full');

    const c2 = await create('B', { profileId: ben });
    t.clock.advance(48 * HOUR_MS + 1);
    const exp = await post('A', c2.body.match.id, 'join', { profileId: mia, code: c2.body.match.code, rulesVersion: 1 });
    expect(exp.status).toBe(409);
    expect(exp.body.error.code).toBe('code_expired');
    expect((await vcall('A', 'GET', `/v1/versus/codes/${c2.body.match.code}`, undefined, { profileId: mia })).body.status).toBe('expired');

    const c3 = await create('B', { profileId: ben });
    await post('B', c3.body.match.id, 'cancel', { profileId: ben });
    const st = await post('A', c3.body.match.id, 'join', { profileId: mia, code: c3.body.match.code, rulesVersion: 1 });
    expect(st.status).toBe(404); // a cancelled match frees its code
  });

  it('family match: same account, active at once, both seats joined; validation', async () => {
    const f = await create('A', { profileId: mia, opponentProfileId: lea, lengthMin: 30 });
    expect(f.status).toBe(201);
    expect(f.body.match).toMatchObject({ kind: 'family', status: 'active', code: null, codeExpiresAt: null, joinedAt: t.clock.now(), finishBy: t.clock.now() + 72 * HOUR_MS, days: 15, startMoney: 100_000, budgetMin: 45 });
    expect(f.body.match.players.map((p: { name: string; isMe: boolean }) => [p.name, p.isMe])).toEqual([['Mia', true], ['Lea', false]]);
    const asLea = await get('A', f.body.match.id, lea);
    expect(asLea.body.match.mySeat).toBe(1);
    expect((await create('A', { profileId: mia, opponentProfileId: ben })).status).toBe(404); // not on this account
    expect((await create('A', { profileId: mia, opponentProfileId: mia })).status).toBe(422);
    expect((await create('A', { profileId: ben })).status).toBe(404); // foreign profile
    expect((await create('A', { profileId: mia, lengthMin: 45 })).status).toBe(422);
    expect((await create('A', { profileId: mia, rulesVersion: 9 })).status).toBe(426);
  });

  it('limits: 1 open coded match (open_limit), 3 active (active_limit), 10 creates per day', async () => {
    expect((await create('A', { profileId: mia })).status).toBe(201);
    const second = await create('A', { profileId: mia });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('open_limit');
    for (let i = 0; i < 3; i++) expect((await create('A', { profileId: lea, opponentProfileId: mia })).status).toBe(201);
    const fourth = await create('A', { profileId: lea, opponentProfileId: mia });
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe('active_limit');
    // joining counts too
    const c = await create('B', { profileId: ben });
    const j = await post('A', c.body.match.id, 'join', { profileId: lea, code: c.body.match.code, rulesVersion: 1 });
    expect(j.body.error.code).toBe('active_limit');

    // 10 creates per profile per 24 h (seeded directly; the per-account hourly limiter is tested in security).
    const now = t.clock.now();
    for (let i = 0; i < 10; i++) {
      const id = randomId();
      t.db.run("INSERT INTO matches (id, kind, code, length_min, days, seed, rules_version, start_money, budget_min, status, created_at) VALUES (?, 'coded', NULL, 4, 2, 1, 1, 100000, 6, 'cancelled', ?)", id, now - 3600_000 + i);
      t.db.run("INSERT INTO match_seats (match_id, seat, profile_id, account_id, name, avatar, joined_at) VALUES (?, 0, ?, ?, 'Ben', '{\"animal\":\"hippo\",\"color\":4}', ?)", id, ben, B.accountId, now);
    }
    t.db.run("UPDATE matches SET status = 'cancelled' WHERE status = 'open'");
    const day = await create('B', { profileId: ben });
    expect(day.status).toBe(429);
    expect(day.body.error.code).toBe('rate_limited');
    expect(Number(day.headers['retry-after'])).toBeGreaterThan(20 * 3600);
  });
});

describe('snapshots', () => {
  it('idempotent by hour; ack + opponent progress; series', async () => {
    const id = await coded();
    t.clock.advance(10 * MINUTE_MS);
    const s1 = await snaps('A', id, mia, [6, 12]);
    expect(s1.status).toBe(200);
    expect(s1.body.ackHour).toBe(12);
    expect(s1.body.opponent).toEqual({ lastHour: 0, total: 0, parts: null, live: false, done: false, atMyHour: null });
    const again = await snaps('A', id, mia, [6, 12]);
    expect(again.body.ackHour).toBe(12);
    expect(t.db.get<{ n: number }>('SELECT count(*) AS n FROM match_snapshots')!.n).toBe(2);

    const sb = await snaps('B', id, ben, [6, 12, 18]);
    expect(sb.body.opponent).toMatchObject({ lastHour: 12, total: snap(12).total, live: true, done: false, atMyHour: null });
    const sa = await snaps('A', id, mia, [18]);
    expect(sa.body.opponent).toMatchObject({ lastHour: 18, atMyHour: snap(18).total, live: true });
    t.clock.advance(91_000);
    expect((await snaps('A', id, mia, [24])).body.opponent.live).toBe(false);

    const ser = await vcall('A', 'GET', `${V}/${id}/series`, undefined, { profileId: mia, since: 6 });
    expect(ser.status).toBe(200);
    expect(ser.body.lastHour).toBe(18);
    expect(ser.body.done).toBe(false);
    const p12 = snap(12).parts;
    expect(ser.body.series[0]).toEqual([12, snap(12).total, p12.v, p12.a, p12.s, p12.b, p12.m, p12.l]);
    expect(ser.body.series.map((r: number[]) => r[0])).toEqual([12, 18]);
    // seat 0 of an open match: series has no opponent yet → 404
    const c = await create('B', { profileId: ben });
    expect((await vcall('B', 'GET', `${V}/${c.body.match.id}/series`, undefined, { profileId: ben })).status).toBe(404);
  });

  it('bad_snapshot: the ones before the failing one are stored; h % 6, decreasing parts, wrong total', async () => {
    const id = await coded();
    t.clock.advance(10 * MINUTE_MS);
    const r = await post('A', id, 'snapshots', { profileId: mia, snapshots: [snap(6), { ...snap(12), total: 9999 }, snap(18)] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('bad_snapshot');
    expect(r.body.error.details).toMatchObject({ h: 12, detail: 'total does not match parts' });
    expect(t.db.get<{ ack_hour: number }>('SELECT ack_hour FROM match_seats WHERE match_id = ? AND seat = 0', id)!.ack_hour).toBe(6);
    expect((await snaps('A', id, mia, [7])).body.error.code).toBe('bad_snapshot');
    const dec = await snaps('A', id, mia, [12], () => ({ v: 1 }));
    expect(dec.body.error.details.detail).toBe('v decreased');
    const over = await snaps('A', id, mia, [54]); // > hoursTotal 48
    expect(over.body.error).toMatchObject({ code: 'bad_snapshot', details: { detail: 'h > hoursTotal' } });
    expect((await post('A', id, 'snapshots', { profileId: mia, snapshots: [] })).status).toBe(422);
    expect((await post('A', id, 'snapshots', { profileId: mia, snapshots: range(6, 6 * 49).map((h) => snap(h)) })).status).toBe(422); // > 48 per call
  });

  it('pace (V2): non-family > 2× too fast → 422 too_fast; 1–2× → stored + flagged; T0 = joinedAt for seat 1, createdAt for seat 0', async () => {
    const c = await create('A', { profileId: mia, lengthMin: 30 });
    t.clock.advance(HOUR_MS); // the challenger's clock runs from createdAt
    await post('B', c.body.match.id, 'join', { profileId: ben, code: c.body.match.code, rulesVersion: 1 });
    const id = c.body.match.id;
    // Ben just joined: h=54 needs 270 s, allowed 0 + 120 s → more than 2× → rejected, nothing stored.
    const fast = await snaps('B', id, ben, range(6, 54));
    expect(fast.status).toBe(422);
    expect(fast.body.error.code).toBe('too_fast');
    expect(t.db.get<{ ack_hour: number; device_id: string | null }>('SELECT ack_hour, device_id FROM match_seats WHERE match_id = ? AND seat = 1', id)).toEqual({ ack_hour: 0, device_id: null });
    expect(t.logs.some((l) => l.includes('"kind":"pace_flag"'))).toBe(true);
    // h=48 needs 240 s ≤ 2 × 120 → stored and flagged.
    const flag = await snaps('B', id, ben, range(6, 48));
    expect(flag.status).toBe(200);
    expect(flag.body.ackHour).toBe(48);
    expect(flagsOf(id, 1)).toContain('pace');
    // Mia's T0 is createdAt (1 h ago): h=54 is fine and unflagged.
    const ok = await snaps('A', id, mia, range(6, 54));
    expect(ok.status).toBe(200);
    expect(flagsOf(id, 0)).not.toContain('pace');
  });

  it('family matches are never rejected for pace (only flagged)', async () => {
    const f = await create('A', { profileId: mia, opponentProfileId: lea, lengthMin: 30 });
    const r = await snaps('A', f.body.match.id, mia, range(6, 240)); // 40 snapshots at elapsed 0: 10× too fast
    expect(r.status).toBe(200);
    expect(r.body.ackHour).toBe(240);
    expect(flagsOf(f.body.match.id, 0)).toContain('pace');
  });

  it('an open match accepts seat 0 (the challenger plays before anyone joins)', async () => {
    const c = await create('A', { profileId: mia });
    t.clock.advance(10 * MINUTE_MS);
    const r = await snaps('A', c.body.match.id, mia, [6, 12]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ackHour: 12, opponent: null });
  });

  it('device binding (S6): the first snapshot binds the seat; another device → 409 other_device; give up works anywhere', async () => {
    const id = await coded();
    t.clock.advance(10 * MINUTE_MS);
    expect((await snaps('B', id, ben, [6])).status).toBe(200);
    const mine = await get('B', id, ben);
    expect(mine.body.match.players[1].device).toEqual({ name: 'Ben Phone', here: true });
    expect(mine.body.match.players[0].device).toBeNull();
    const tablet = await t.signIn('parent-b', { id: 'device-b-tablet-001', name: 'Ben Tablet' });
    const other = await snaps('B', id, ben, [12], undefined, tablet.token);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('other_device');
    expect(other.body.error.details.deviceName).toBe('Ben Phone');
    const fin = await post('B', id, 'finish', { profileId: ben, final: snap(48), endReason: 'complete', save: finalSave() }, tablet.token);
    expect(fin.body.error.code).toBe('other_device');
    const fromTablet = await vcall('B', 'GET', `${V}/${id}`, undefined, { profileId: ben }, tablet.token);
    expect(fromTablet.body.match.players[1].device).toEqual({ name: 'Ben Phone', here: false });
    const gu = await post('B', id, 'forfeit', { profileId: ben }, tablet.token);
    expect(gu.status).toBe(200);
    expect(gu.body.match.result).toMatchObject({ kind: 'win', winnerSeat: 0, reason: 'forfeit' });
  });
});

describe('finish, forfeit, cancel', () => {
  it('finish complete: validation, final save stored, idempotent, result once both are done', async () => {
    const id = await coded();
    t.clock.advance(10 * MINUTE_MS);
    await snaps('A', id, mia, range(6, 42));
    expect((await finish('A', id, mia, 42, 'complete')).status).toBe(422); // complete must end at hour 48
    expect((await finish('A', id, mia, 48, 'budget')).status).toBe(422); // budget must be < 48
    const big = randomBytes(270_000);
    const tooBig = await post('A', id, 'finish', { profileId: mia, final: snap(48), endReason: 'complete', save: { encoding: 'gzip+base64', data: big.toString('base64'), sha256: sha256hex(big) } });
    expect(tooBig.status).toBe(413);
    const f = await finish('A', id, mia, 48, 'complete');
    expect(f.status).toBe(200);
    expect(f.body.match.players[0]).toMatchObject({ state: 'done', endHour: 48, endReason: 'complete', lastHour: 48 });
    expect(f.body.match.result).toBeNull(); // Ben is still playing → pending
    expect(t.db.get<{ n: number }>('SELECT count(*) AS n FROM match_seats WHERE final_save IS NOT NULL')!.n).toBe(1);
    const again = await finish('A', id, mia, 48, 'complete');
    expect(again.status).toBe(200);
    expect(again.body.match.players[0].doneAt).toBe(f.body.match.players[0].doneAt);
    expect((await snaps('A', id, mia, [48])).body.error.code).toBe('match_over');

    await snaps('B', id, ben, range(6, 48), (h) => ({ v: h * 3 }));
    const fb = await finish('B', id, ben, 48, 'complete', { v: 48 * 3 });
    expect(fb.body.match.status).toBe('finished');
    expect(fb.body.match.result).toMatchObject({ kind: 'win', winnerSeat: 1, reason: 'both_finished', comparedAtHour: 48, totals: [snap(48).total, snap(48, { v: 144 }).total] });
    const seen = await get('A', id, mia);
    expect(seen.body.match.result.winnerSeat).toBe(1);
    // Series after the end includes the final row
    const ser = await vcall('A', 'GET', `${V}/${id}/series`, undefined, { profileId: mia });
    expect(ser.body).toMatchObject({ lastHour: 48, done: true });
    expect(ser.body.series.at(-1)[0]).toBe(48);
  });

  it("finish with endReason 'budget' at h < 24N decides via compare-at-hour", async () => {
    const id = await coded();
    t.clock.advance(10 * MINUTE_MS);
    await snaps('A', id, mia, range(6, 30), (h) => ({ v: h * 4 })); // Mia leads but runs out of time at hour 30
    const fa = await finish('A', id, mia, 30, 'budget', { v: 120 });
    expect(fa.status).toBe(200);
    expect(fa.body.match.players[0]).toMatchObject({ endReason: 'budget', endHour: 30 });
    await snaps('B', id, ben, range(6, 48));
    const fb = await finish('B', id, ben, 48, 'complete');
    expect(fb.body.match.result).toMatchObject({ kind: 'win', winnerSeat: 0, reason: 'compared_at_hour', comparedAtHour: 30, totals: [snap(30, { v: 120 }).total, snap(30).total] });
  });

  it('budget finish at an hour already uploaded is accepted; a later hour than uploaded is stored', async () => {
    const id = await coded();
    t.clock.advance(10 * MINUTE_MS);
    await snaps('A', id, mia, range(6, 24));
    expect((await finish('A', id, mia, 24, 'budget')).status).toBe(200);
    await snaps('B', id, ben, range(6, 24));
    const fb = await finish('B', id, ben, 27, 'budget');
    expect(fb.status).toBe(200);
    expect(fb.body.match.result).toMatchObject({ kind: 'tie', reason: 'compared_at_hour', comparedAtHour: 24 });
  });

  it('over_budget flag when finish comes later than first snapshot + budget + 10 min', async () => {
    const id = await coded();
    t.clock.advance(10 * MINUTE_MS);
    await snaps('A', id, mia, [6]);
    t.clock.advance(6 * MINUTE_MS + 10 * MINUTE_MS + 1);
    await snaps('A', id, mia, range(12, 42));
    await finish('A', id, mia, 48, 'complete');
    expect(flagsOf(id, 0)).toContain('over_budget');
    await snaps('B', id, ben, [6]);
    await finish('B', id, ben, 48, 'complete');
    expect(flagsOf(id, 1)).not.toContain('over_budget');
  });

  it('cancel only while open and before the challenger’s first snapshot (V4)', async () => {
    const c = await create('A', { profileId: mia });
    const id = c.body.match.id;
    expect((await post('B', id, 'cancel', { profileId: ben })).status).toBe(404);
    const ok = await post('A', id, 'cancel', { profileId: mia });
    expect(ok.status).toBe(200);
    expect(ok.body.match).toMatchObject({ status: 'cancelled', result: null, code: null });

    const c2 = await create('A', { profileId: mia });
    t.clock.advance(10 * MINUTE_MS);
    await snaps('A', c2.body.match.id, mia, [6]);
    const late = await post('A', c2.body.match.id, 'cancel', { profileId: mia });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('match_state');
    // after the challenger's first snapshot and a join, cancel stays refused
    const j = await post('B', c2.body.match.id, 'join', { profileId: ben, code: c2.body.match.code, rulesVersion: 1 });
    expect(j.status).toBe(200);
    expect((await post('A', c2.body.match.id, 'cancel', { profileId: mia })).body.error.code).toBe('match_state');
  });

  it('forfeit on an open match acts like cancel; on an active match the other seat wins; idempotent', async () => {
    const c = await create('A', { profileId: mia });
    const r = await post('A', c.body.match.id, 'forfeit', { profileId: mia });
    expect(r.body.match.status).toBe('cancelled');
    expect((await post('A', c.body.match.id, 'forfeit', { profileId: mia })).status).toBe(200);
    const id = await coded();
    const f = await post('A', id, 'forfeit', { profileId: mia });
    expect(f.body.match).toMatchObject({ status: 'finished', result: { kind: 'win', winnerSeat: 1, reason: 'forfeit' } });
    expect(f.body.match.players[0]).toMatchObject({ state: 'done', endReason: 'forfeit' });
    expect((await post('A', id, 'forfeit', { profileId: mia })).status).toBe(200);
    expect((await snaps('B', id, ben, [6])).body.error.code).toBe('match_over');
  });
});

describe('lazy finalisation (decideOutcome branches)', () => {
  it('pending until both are done or the deadline passes; deadline: other_unfinished', async () => {
    const id = await coded();
    t.clock.advance(10 * MINUTE_MS);
    await snaps('A', id, mia, range(6, 42));
    await finish('A', id, mia, 48, 'complete');
    await snaps('B', id, ben, [6, 12]); // below half (24)
    expect((await get('B', id, ben)).body.match.result).toBeNull();
    t.clock.advance(72 * HOUR_MS);
    const r = await get('B', id, ben);
    expect(r.body.match.status).toBe('finished');
    expect(r.body.match.result).toMatchObject({ kind: 'win', winnerSeat: 0, reason: 'other_unfinished', comparedAtHour: null });
    expect(r.body.match.players[1]).toMatchObject({ state: 'done', endReason: 'deadline', endHour: 12 });
  });

  it('deadline with both past half: compared at the earlier hour; neither past half: none_finished', async () => {
    const id = await coded();
    t.clock.advance(10 * MINUTE_MS);
    await snaps('A', id, mia, range(6, 36));
    await snaps('B', id, ben, range(6, 30), (h) => ({ s: h * 2 }));
    t.clock.advance(73 * HOUR_MS);
    const l = await vcall('A', 'GET', V, undefined, { profileId: mia, state: 'finished' });
    const m = l.body.matches.find((x: MatchDto) => x.id === id);
    expect(m.result).toMatchObject({ kind: 'win', winnerSeat: 1, reason: 'compared_at_hour', comparedAtHour: 30 });

    const id2 = await coded();
    t.clock.advance(10 * MINUTE_MS);
    await snaps('A', id2, mia, [6, 12]);
    await snaps('B', id2, ben, [6]);
    t.clock.advance(73 * HOUR_MS);
    runHousekeeping(t.db, t.clock.now()); // housekeeping settles it too
    const g = await get('A', id2, mia);
    expect(g.body.match.result).toMatchObject({ kind: 'none', winnerSeat: null, reason: 'none_finished' });
  });

  it('tie at the last hour', async () => {
    const id = await coded();
    t.clock.advance(10 * MINUTE_MS);
    for (const [v, pid] of [['A', mia], ['B', ben]] as const) {
      await snaps(v, id, pid, range(6, 42));
      await finish(v, id, pid, 48, 'complete');
    }
    expect((await get('A', id, mia)).body.match.result).toMatchObject({ kind: 'tie', winnerSeat: null, reason: 'both_finished', comparedAtHour: 48 });
  });

  it('an unjoined coded match expires after 48 h with a practice result', async () => {
    const c = await create('A', { profileId: mia });
    t.clock.advance(10 * MINUTE_MS);
    await snaps('A', c.body.match.id, mia, range(6, 42));
    await finish('A', c.body.match.id, mia, 48, 'complete');
    expect((await get('A', c.body.match.id, mia)).body.match.status).toBe('open');
    t.clock.advance(48 * HOUR_MS);
    const g = await get('A', c.body.match.id, mia);
    expect(g.body.match.status).toBe('expired');
    expect(g.body.match.result).toMatchObject({ kind: 'none', winnerSeat: null, reason: 'expired', comparedAtHour: null, totals: [snap(48).total, 0] });
  });

  it('the challenger may finish before anyone joins; the result waits for the join', async () => {
    const c = await create('A', { profileId: mia });
    t.clock.advance(10 * MINUTE_MS);
    await snaps('A', c.body.match.id, mia, range(6, 42));
    await finish('A', c.body.match.id, mia, 48, 'complete');
    await post('B', c.body.match.id, 'join', { profileId: ben, code: c.body.match.code, rulesVersion: 1 });
    t.clock.advance(10 * MINUTE_MS);
    await snaps('B', c.body.match.id, ben, range(6, 42), (h) => ({ a: h * 2 }));
    const f = await finish('B', c.body.match.id, ben, 48, 'complete', { a: 96 });
    expect(f.body.match.result).toMatchObject({ kind: 'win', winnerSeat: 1, reason: 'both_finished' });
  });
});

describe('rematch and lists', () => {
  it('rematch of a coded match → invite (no code) that the other profile joins without a code', async () => {
    const id = await coded();
    await post('B', id, 'forfeit', { profileId: ben });
    const r = await post('A', id, 'rematch', { profileId: mia });
    expect(r.status).toBe(201);
    const m = r.body.match as MatchDto;
    expect(m).toMatchObject({ kind: 'rematch', status: 'open', code: null, lengthMin: 4, mySeat: 0 });
    expect(m.codeExpiresAt).toBe(t.clock.now() + 48 * HOUR_MS);
    expect(m.players.map((p) => [p.seat, p.name, p.state, p.isMe])).toEqual([[0, 'Mia', 'joined', true], [1, 'Ben', 'invited', false]]);

    const list = await vcall('B', 'GET', V, undefined, { profileId: ben, state: 'active' });
    const inv = list.body.matches.find((x: MatchDto) => x.id === m.id);
    expect(inv).toMatchObject({ mySeat: 1, status: 'open' });
    expect(inv.players[1]).toMatchObject({ state: 'invited', isMe: true });
    expect((await get('B', m.id, ben)).status).toBe(200);
    expect((await post('A', m.id, 'join', { profileId: lea, rulesVersion: 1 })).status).toBe(404); // not invited
    const j = await post('B', m.id, 'join', { profileId: ben, rulesVersion: 1 });
    expect(j.status).toBe(200);
    expect(j.body.match).toMatchObject({ status: 'active', mySeat: 1 });
    // rematch of an unfinished match → match_state
    expect((await post('A', m.id, 'rematch', { profileId: mia })).body.error.code).toBe('match_state');
  });

  it('an unanswered invitation stays readable by the invited profile after it expires', async () => {
    const id = await coded();
    await post('B', id, 'forfeit', { profileId: ben });
    const m = (await post('A', id, 'rematch', { profileId: mia })).body.match as MatchDto;
    t.clock.advance(48 * HOUR_MS + 1);
    const g = await get('B', m.id, ben);
    expect(g.status).toBe(200);
    expect(g.body.match).toMatchObject({ status: 'expired', mySeat: 1, result: { reason: 'expired' } });
    expect(g.body.match.players[1]).toMatchObject({ state: 'invited', isMe: true });
    expect((await post('B', m.id, 'join', { profileId: ben, rulesVersion: 1 })).body.error.code).toBe('code_expired');
  });

  it('stale active matches past their deadline do not count against active_limit', async () => {
    for (let i = 0; i < 3; i++) expect((await create('A', { profileId: lea, opponentProfileId: mia })).status).toBe(201);
    expect((await create('A', { profileId: lea, opponentProfileId: mia })).body.error.code).toBe('active_limit');
    t.clock.advance(73 * HOUR_MS);
    expect((await create('A', { profileId: lea, opponentProfileId: mia })).status).toBe(201);
  });

  it('rematch of a family match → a new active family match', async () => {
    const f = await create('A', { profileId: mia, opponentProfileId: lea });
    await post('A', f.body.match.id, 'forfeit', { profileId: lea });
    const r = await post('A', f.body.match.id, 'rematch', { profileId: lea });
    expect(r.status).toBe(201);
    expect(r.body.match).toMatchObject({ kind: 'family', status: 'active', mySeat: 0 });
    expect(r.body.match.players.map((p: { name: string }) => p.name)).toEqual(['Lea', 'Mia']);
  });

  it('list: newest first, state filter, both seats; foreign match ids are 404; ETag/304', async () => {
    const a = await coded();
    t.clock.advance(1000);
    const f = await create('A', { profileId: mia, opponentProfileId: lea });
    const all = await vcall('A', 'GET', V, undefined, { profileId: mia });
    expect(all.body.matches.map((m: MatchDto) => m.id)).toEqual([f.body.match.id, a]);
    expect((await vcall('A', 'GET', V, undefined, { profileId: mia, state: 'finished' })).body.matches).toEqual([]);
    expect((await vcall('B', 'GET', V, undefined, { profileId: ben })).body.matches.map((m: MatchDto) => m.id)).toEqual([a]);
    expect((await get('B', f.body.match.id, ben)).status).toBe(404);
    expect((await get('B', a, mia)).status).toBe(404); // someone else's profile id
    const g = await get('A', a, mia);
    const etag = g.headers.etag as string;
    expect(etag).toMatch(/^".+"$/);
    const nm = await t.call('GET', `${V}/${a}`, { token: A.token, query: { profileId: mia }, headers: { 'if-none-match': etag } });
    expect(nm.status).toBe(304);
    expect(nm.raw.payload).toBe('');
  });
});

describe('player left', () => {
  it('a purged profile becomes "Player left"; the match keeps its totals', async () => {
    const id = await coded();
    t.clock.advance(10 * MINUTE_MS);
    await snaps('B', id, ben, [6, 12]);
    await t.call('DELETE', `/v1/profiles/${ben}`, { token: B.token });
    t.clock.advance(31 * DAY_MS);
    runHousekeeping(t.db, t.clock.now());
    const g = await get('A', id, mia);
    expect(g.body.match.players[1]).toMatchObject({ name: 'Player left', state: 'left', total: snap(12).total, device: null });
  });
});

describe('deep key scan (api §8)', () => {
  it('covers every versus endpoint, both seats, coded and family', async () => {
    // coded, seen from both seats
    const c = await create('A', { profileId: mia });
    const id = c.body.match.id;
    await vcall('B', 'GET', `/v1/versus/codes/${c.body.match.code}`, undefined, { profileId: ben });
    await post('B', id, 'join', { profileId: ben, code: c.body.match.code, rulesVersion: 1 });
    t.clock.advance(10 * MINUTE_MS);
    await snaps('A', id, mia, range(6, 24));
    await snaps('B', id, ben, range(6, 30));
    const tablet = await t.signIn('parent-b', { id: 'device-b-tablet-002', name: 'Ben Tablet' });
    await snaps('B', id, ben, [36], undefined, tablet.token); // 409 other_device
    for (const [v, pid] of [['A', mia], ['B', ben]] as const) {
      await get(v, id, pid);
      await vcall(v, 'GET', V, undefined, { profileId: pid });
      await vcall(v, 'GET', `${V}/${id}/series`, undefined, { profileId: pid });
    }
    await finish('A', id, mia, 30, 'budget');
    await finish('B', id, ben, 48, 'complete');
    await post('B', id, 'rematch', { profileId: ben });
    // family, seen as both profiles
    const f = await create('A', { profileId: mia, opponentProfileId: lea });
    const fid = f.body.match.id;
    await snaps('A', fid, lea, [6]);
    for (const pid of [mia, lea]) {
      await get('A', fid, pid);
      await vcall('A', 'GET', `${V}/${fid}/series`, undefined, { profileId: pid });
      await vcall('A', 'GET', V, undefined, { profileId: pid });
    }
    await post('A', fid, 'forfeit', { profileId: mia });
    await post('A', fid, 'rematch', { profileId: lea });
    const c2 = await create('B', { profileId: ben });
    await post('B', c2.body.match.id, 'cancel', { profileId: ben });

    const routes = new Set(captured.map((x) => x.route));
    for (const r of [
      'POST /v1/versus/matches', 'GET /v1/versus/codes/:code', 'POST /v1/versus/matches/:id/join', 'GET /v1/versus/matches',
      'GET /v1/versus/matches/:id', 'POST /v1/versus/matches/:id/snapshots', 'GET /v1/versus/matches/:id/series',
      'POST /v1/versus/matches/:id/finish', 'POST /v1/versus/matches/:id/forfeit', 'POST /v1/versus/matches/:id/cancel',
      'POST /v1/versus/matches/:id/rematch',
    ]) expect(routes.has(r), r).toBe(true);
    expect(new Set(captured.map((x) => x.viewer))).toEqual(new Set(['A', 'B']));
    expect(captured.some((x) => (x.body as { error?: { code: string } })?.error?.code === 'other_device')).toBe(true);
    // the scan itself runs in afterEach over all ${captured.length} responses
    expect(captured.length).toBeGreaterThan(25);
  });
});
