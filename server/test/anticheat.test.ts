// Versus hardening from the red team: early budget ends (RT-04), bounded numbers (RT-11), idle-then-burst and
// same-device flags (RT-12), rematch lengths (RT-13).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '../src/clock.js';
import { encodeSave, makeProfile, snap } from './support/helpers.js';
import { makeTestApp, type SignedIn, type TestApp } from './support/testApp.js';

const V = '/v1/versus/matches';
let t: TestApp;
let A: SignedIn;
let B: SignedIn;
let mia: string;
let lea: string;
let ben: string;

beforeEach(async () => {
  t = await makeTestApp();
  A = await t.signIn('parent-a', { id: 'device-a-phone-01', name: 'Mia Phone' });
  B = await t.signIn('parent-b', { id: 'device-b-phone-01', name: 'Ben Phone' });
  mia = await makeProfile(t, A.token, 'Mia');
  lea = await makeProfile(t, A.token, 'Lea');
  ben = await makeProfile(t, B.token, 'Ben');
});
afterEach(async () => {
  await t.close();
});

const act = (token: string, id: string, action: string, body: Record<string, unknown>) => t.call('POST', `${V}/${id}/${action}`, { token, body });
const finalSave = () => {
  const e = encodeSave({ final: true });
  return { encoding: 'gzip+base64', data: e.data, sha256: e.sha256 };
};
const flagsOf = (id: string, seat: number) => JSON.parse(t.db.get<{ flags: string }>('SELECT flags FROM match_seats WHERE match_id = ? AND seat = ?', id, seat)!.flags) as string[];
const range = (from: number, to: number, step = 6) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

/** A coded match of Mia (seat 0, A) joined by Ben (seat 1, B). */
async function coded(lengthMin = 4, joinToken = B.token): Promise<string> {
  const c = await t.call('POST', V, { token: A.token, body: { rulesVersion: 1, lengthMin, profileId: mia } });
  expect(c.status).toBe(201);
  expect((await act(joinToken, c.body.match.id, 'join', { profileId: ben, code: c.body.match.code, rulesVersion: 1 })).status).toBe(200);
  return c.body.match.id;
}

describe('RT-04: a budget end needs the real-time budget to have run out', () => {
  it('30-min match (budget 45 min): a budget finish 16 min after the join is refused; after 45 min it counts', async () => {
    const id = await coded(30);
    t.clock.advance(16 * MINUTE_MS);
    const fast = (h: number) => ({ v: h * 2.5, a: h * 2, s: h * 1.2, b: 0, m: h * 3, l: 0 });
    expect((await act(B.token, id, 'snapshots', { profileId: ben, snapshots: range(6, 180).map((h) => snap(h, fast(h))) })).status).toBe(200);
    const early = await act(B.token, id, 'finish', { profileId: ben, final: snap(186, fast(186)), endReason: 'budget', save: finalSave() });
    expect(early.status).toBe(422);
    expect(early.body.error).toMatchObject({ code: 'invalid', details: { issues: ['endReason: budget before budgetMin'] } });
    expect(t.db.get<{ done_at: number | null }>('SELECT done_at FROM match_seats WHERE match_id = ? AND seat = 1', id)!.done_at).toBeNull();
    // A real budget end: the seat paused a lot and its 45 minutes are used up.
    t.clock.advance(29 * MINUTE_MS);
    const late = await act(B.token, id, 'finish', { profileId: ben, final: snap(186, fast(186)), endReason: 'budget', save: finalSave() });
    expect(late.status).toBe(200);
    expect(flagsOf(id, 1)).not.toContain('early_budget');
  });

  it('family matches are only flagged (early_budget), never refused', async () => {
    const f = await t.call('POST', V, { token: A.token, body: { rulesVersion: 1, lengthMin: 30, profileId: mia, opponentProfileId: lea } });
    const id = f.body.match.id;
    const r = await act(A.token, id, 'finish', { profileId: mia, final: snap(1), endReason: 'budget', save: finalSave() });
    expect(r.status).toBe(200);
    expect(flagsOf(id, 0)).toContain('early_budget');
  });

  it('the 4-minute test length (VERSUS_TEST_LENGTH=1, never in production) is only flagged: the e2e skips the phone budget clock', async () => {
    const id = await coded(4);
    t.clock.advance(2 * MINUTE_MS);
    const r = await act(B.token, id, 'finish', { profileId: ben, final: snap(12), endReason: 'budget', save: finalSave() });
    expect(r.status).toBe(200);
    expect(flagsOf(id, 1)).toContain('early_budget');
  });
});

describe('RT-11: snapshot numbers are bounded', () => {
  it('a part of 1e19 (or an absurd total) is 422 invalid, never a 500, and nothing of the batch is stored', async () => {
    const id = await coded();
    t.clock.advance(10 * MINUTE_MS);
    const r = await act(B.token, id, 'snapshots', { profileId: ben, snapshots: [snap(6), { ...snap(6, { v: 1e19 }), h: 12 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('invalid');
    const huge = await act(B.token, id, 'snapshots', { profileId: ben, snapshots: [snap(6, { m: 2e7 })] }); // > 1e7 per part
    expect(huge.status).toBe(422);
    expect(huge.body.error.code).toBe('invalid');
    expect(t.db.get<{ ack_hour: number }>('SELECT ack_hour FROM match_seats WHERE match_id = ? AND seat = 1', id)!.ack_hour).toBe(0);
    const fin = await act(B.token, id, 'finish', { profileId: ben, final: snap(48, {}, { total: 1e12 }), endReason: 'complete', save: finalSave() });
    expect(fin.status).toBe(422);
    expect(fin.body.error.code).toBe('invalid');
    // Contract kept: plausible-but-wrong values still answer bad_snapshot from checkSnapshotStep.
    const neg = await act(B.token, id, 'snapshots', { profileId: ben, snapshots: [snap(6, { v: -1 })] });
    expect(neg.body.error).toMatchObject({ code: 'bad_snapshot', details: { detail: 'part v not finite or negative' } });
    const frac = await act(B.token, id, 'snapshots', { profileId: ben, snapshots: [snap(6, { l: 0.5 })] });
    expect(frac.body.error).toMatchObject({ code: 'bad_snapshot', details: { detail: 'l not an integer' } });
  });
});

describe('RT-12: flag-only anti-cheat signals', () => {
  it('idle after the join, then the whole match uploaded within seconds → burst', async () => {
    const id = await coded();
    t.clock.advance(6 * HOUR_MS);
    expect((await act(B.token, id, 'snapshots', { profileId: ben, snapshots: range(6, 42).map((h) => snap(h)) })).status).toBe(200);
    t.clock.advance(2_000);
    expect((await act(B.token, id, 'finish', { profileId: ben, final: snap(48), endReason: 'complete', save: finalSave() })).status).toBe(200);
    expect(flagsOf(id, 1)).toContain('burst');
  });

  it('a match played at the real pace raises no burst flag', async () => {
    const id = await coded();
    t.clock.advance(30_000);
    for (const h of range(6, 42)) {
      expect((await act(B.token, id, 'snapshots', { profileId: ben, snapshots: [snap(h)] })).status).toBe(200);
      t.clock.advance(30_000);
    }
    expect((await act(B.token, id, 'finish', { profileId: ben, final: snap(48), endReason: 'complete', save: finalSave() })).status).toBe(200);
    expect(flagsOf(id, 1)).toEqual([]);
  });

  it('both seats of a coded match bound to one device install → same_device on both; family matches are not flagged', async () => {
    const c = await t.call('POST', V, { token: A.token, body: { rulesVersion: 1, lengthMin: 4, profileId: mia } });
    const id = c.body.match.id;
    const sameDevice = await t.signIn('parent-b', { id: 'device-a-phone-01', name: 'Mia Phone' });
    expect((await act(sameDevice.token, id, 'join', { profileId: ben, code: c.body.match.code, rulesVersion: 1 })).status).toBe(200);
    t.clock.advance(10 * MINUTE_MS);
    expect((await act(A.token, id, 'snapshots', { profileId: mia, snapshots: [snap(6)] })).status).toBe(200);
    expect(flagsOf(id, 0)).toEqual([]);
    expect((await act(sameDevice.token, id, 'snapshots', { profileId: ben, snapshots: [snap(6)] })).status).toBe(200);
    expect(flagsOf(id, 0)).toContain('same_device');
    expect(flagsOf(id, 1)).toContain('same_device');
    // Siblings on the family tablet: one device for both seats is normal.
    const f = await t.call('POST', V, { token: A.token, body: { rulesVersion: 1, lengthMin: 4, profileId: lea, opponentProfileId: mia } });
    const fid = f.body.match.id;
    t.clock.advance(MINUTE_MS);
    for (const p of [lea, mia]) expect((await act(A.token, fid, 'snapshots', { profileId: p, snapshots: [snap(6)] })).status).toBe(200);
    expect([...flagsOf(fid, 0), ...flagsOf(fid, 1)]).not.toContain('same_device');
  });

  it('the first bind at finish (no snapshot before) also checks the device', async () => {
    const c = await t.call('POST', V, { token: A.token, body: { rulesVersion: 1, lengthMin: 4, profileId: mia } });
    const id = c.body.match.id;
    const sameDevice = await t.signIn('parent-b', { id: 'device-a-phone-01', name: 'Mia Phone' });
    expect((await act(sameDevice.token, id, 'join', { profileId: ben, code: c.body.match.code, rulesVersion: 1 })).status).toBe(200);
    t.clock.advance(10 * MINUTE_MS);
    expect((await act(A.token, id, 'snapshots', { profileId: mia, snapshots: [snap(6)] })).status).toBe(200);
    expect((await act(sameDevice.token, id, 'finish', { profileId: ben, final: snap(48), endReason: 'complete', save: finalSave() })).status).toBe(200);
    expect(flagsOf(id, 1)).toContain('same_device');
  });
});

describe('RT-13: rematch offers only the lengths the server offers', () => {
  it('after VERSUS_LENGTHS drops 120, a rematch of a 120-minute match is 422 like a new one', async () => {
    const f = await t.call('POST', V, { token: A.token, body: { rulesVersion: 1, lengthMin: 120, profileId: mia, opponentProfileId: lea } });
    expect(f.status).toBe(201);
    const id = f.body.match.id;
    for (const p of [mia, lea]) expect((await act(A.token, id, 'finish', { profileId: p, final: snap(1), endReason: 'budget', save: finalSave() })).status).toBe(200);
    t.config.versusLengths = [30, 60];
    await t.restart();
    expect((await t.call('POST', V, { token: A.token, body: { rulesVersion: 1, lengthMin: 120, profileId: mia, opponentProfileId: lea } })).status).toBe(422);
    const re = await act(A.token, id, 'rematch', { profileId: mia });
    expect(re.status).toBe(422);
    expect(re.body.error.code).toBe('invalid');
  });
});
