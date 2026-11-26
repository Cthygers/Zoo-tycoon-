// Versus outbox (spec §5.6, review S7): per account + match, classification, dead letters, isolation,
// keepalive size limit; plus the VersusApi calls in kid words.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinishBody, VersusParts, VersusSnapshot } from '../shared/api-types';
import { scoreRounded } from '../shared/versus-rules';
import { encodeSave, sha256OfB64Sync, utf8Length } from '../src/net/codec';
import { FakeCloud } from '../src/net/fakeCloud';
import { VS_MSG } from '../src/net/versusApi';
import { bootPhone, type Phone } from '../src/net/testkit';

const T0 = Date.UTC(2026, 10, 26, 9);
let fake: FakeCloud;
let phones: Phone[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  fake = new FakeCloud();
  phones = [];
});
afterEach(() => {
  for (const p of phones) p.cloud.dispose();
  vi.useRealTimers();
});

function snap(h: number): VersusSnapshot {
  const parts: VersusParts = { v: h * 0.5, a: h * 0.2, s: h * 0.1, b: 0, m: 0, l: 0 };
  return { h, day: 1 + Math.floor((h + 0) / 24), min: 510, parts, total: scoreRounded(parts), run: 0, cash: 60000, guests: 5, visitors: h, animals: 3, species: 2, habitats: 1, stars: 30 };
}
const snaps = (from: number, to: number) => {
  const out: VersusSnapshot[] = [];
  for (let h = from; h <= to; h += 6) out.push(snap(h));
  return out;
};
function finishBody(profileId: string, final: VersusSnapshot, endReason: 'complete' | 'budget' = 'complete'): FinishBody {
  const data = encodeSave(JSON.stringify({ version: 1, tag: 'final' }));
  return { profileId, final, endReason, save: { encoding: 'gzip+base64', data, sha256: sha256OfB64Sync(data) } };
}

/** A family match (length 30 min = 360 match hours) between Mia and Ben on one phone. */
async function familyMatch(p: Phone, lengthMin: 30 | 4 = 30) {
  const mia = (await p.cloud.profiles.create('Mia', { animal: 'zebra', color: 1 })).id;
  const ben = (await p.cloud.profiles.create('Ben', { animal: 'bear', color: 2 })).id;
  const m = await p.cloud.versus.create({ profileId: mia, lengthMin, opponentProfileId: ben, rulesVersion: 1 });
  return { mia, ben, m };
}

describe('versus outbox', () => {
  it('2xx drops what was acknowledged (≤ 48 snapshots per call), then sends the finish', async () => {
    const p = await bootPhone(fake, { name: 'Pixel 7' });
    phones.push(p);
    const { mia, m } = await familyMatch(p);
    const acks: unknown[] = [];
    p.cloud.versus.onAck((id, res) => acks.push([id, res]));
    p.cloud.versus.enqueueSnapshots(m.id, mia, snaps(6, 360)); // 60 snapshots
    expect(p.cloud.versus.outboxState(m.id).pending).toBe(60);
    // persisted synchronously, per account + match
    expect(JSON.parse(p.storage.getItem(`wh2:outbox:${p.cloud.auth.accountId}:${m.id}`)!).items).toHaveLength(60);
    p.cloud.versus.enqueueFinish(m.id, mia, finishBody(mia, snap(360)));
    expect(await p.cloud.versus.flush(m.id)).toBe('sent');
    const posts = fake.calls.filter((c) => c.op === 'postSnapshots');
    expect(posts.map((c) => (c.body as { snapshots: unknown[] }).snapshots.length)).toEqual([48, 12]);
    expect(fake.count('finish')).toBe(1);
    const st = p.cloud.versus.outboxState(m.id);
    expect(st).toMatchObject({ pending: 0, dead: null, finishSent: true, lastAck: { ackHour: 360 } });
    expect(st.finishMatch?.players[0]).toMatchObject({ state: 'done', endHour: 360 });
    expect(acks).toHaveLength(3);
    expect(await p.cloud.versus.flush(m.id)).toBe('empty');
    // an already-acknowledged hour is not queued again
    p.cloud.versus.enqueueSnapshots(m.id, mia, [snap(6)]);
    expect(p.cloud.versus.outboxState(m.id).pending).toBe(0);
  });

  it('classification: 401 → needs-signin (kept); 5xx / network / 429 / 507 → backoff (kept); other 4xx → dead letter', async () => {
    const p = await bootPhone(fake, { name: 'Pixel 7' });
    phones.push(p);
    const { mia, m } = await familyMatch(p);
    p.cloud.versus.enqueueSnapshots(m.id, mia, snaps(6, 24));
    for (const [failure, expected] of [
      [{ status: 503, code: 'internal' }, 'backoff'],
      ['network', 'offline'],
      [{ status: 429, code: 'rate_limited', retryAfterMs: 120_000 }, 'backoff'],
      [{ status: 507, code: 'server_full' }, 'backoff'],
    ] as const) {
      fake.failNext('postSnapshots', failure);
      expect(await p.cloud.versus.flush(m.id)).toBe(expected);
      expect(p.cloud.versus.outboxState(m.id)).toMatchObject({ pending: 4, dead: null });
      expect(await p.cloud.versus.flush(m.id)).toBe('backoff'); // waits
      await vi.advanceTimersByTimeAsync(31 * 60_000);
    }
    expect(fake.count('postSnapshots')).toBe(4);
    // 401: kept, the account needs a new sign-in, nothing more is sent
    fake.failNext('postSnapshots', { status: 401, code: 'unauthorized' });
    expect(await p.cloud.versus.flush(m.id)).toBe('needs-signin');
    expect(p.cloud.auth.state.get().kind).toBe('needs-signin');
    expect(await p.cloud.versus.flush(m.id)).toBe('needs-signin');
    expect(p.cloud.versus.outboxState(m.id).pending).toBe(4);
    expect(fake.count('postSnapshots')).toBe(5);
    expect((await p.cloud.auth.signIn()).kind).toBe('ok');
    await vi.advanceTimersByTimeAsync(1);
    expect(p.cloud.versus.outboxState(m.id).pending).toBe(0); // flushed after sign-in
    // a permanent 4xx: the queue moves to the dead letters, the match says "We couldn't send…"
    p.cloud.versus.enqueueSnapshots(m.id, mia, snaps(30, 36));
    fake.failNext('postSnapshots', { status: 409, code: 'match_over' });
    expect(await p.cloud.versus.flush(m.id)).toBe('dead');
    const acc = p.cloud.auth.accountId!;
    expect(p.storage.getItem(`wh2:outbox:${acc}:${m.id}`)).toBeNull();
    expect(JSON.parse(p.storage.getItem(`wh2:outbox-dead:${acc}:${m.id}`)!)).toMatchObject({ code: 'match_over', at: Date.now(), items: [{ h: 30 }, { h: 36 }] });
    expect(p.cloud.versus.outboxState(m.id).dead).toEqual({ code: 'match_over', at: Date.now() });
    expect(await p.cloud.versus.flush(m.id)).toBe('dead');
  });

  it('a dead queue never blocks another match, and another account\'s queues are never flushed', async () => {
    const p = await bootPhone(fake, { name: 'Pixel 7' });
    phones.push(p);
    const { mia, ben, m } = await familyMatch(p);
    const m2 = await p.cloud.versus.create({ profileId: ben, lengthMin: 30, opponentProfileId: mia, rulesVersion: 1 });
    p.cloud.versus.enqueueSnapshots(m.id, mia, snaps(6, 12));
    p.cloud.versus.enqueueSnapshots(m2.id, ben, snaps(6, 12));
    // another account's queue on this device (signed out earlier, kept)
    p.storage.setItem(`wh2:outbox:otherAccount0001:${m.id}`, JSON.stringify({ profileId: mia, items: [{ kind: 'snapshots', h: 18, snap: snap(18) }], lastAck: null }));
    fake.failNext('postSnapshots', { status: 422, code: 'bad_snapshot' });
    const results = await p.cloud.outbox.flushAll();
    expect(results.sort()).toEqual(['dead', 'sent']);
    expect(p.cloud.versus.outboxState(m2.id)).toMatchObject({ pending: 0, dead: null });
    expect(p.cloud.outbox.queuedMatches().sort()).toEqual([m2.id].sort());
    expect(fake.calls.filter((c) => c.op === 'postSnapshots' && (c.body as { snapshots: VersusSnapshot[] }).snapshots.some((s) => s.h === 18))).toEqual([]);
    expect(p.storage.getItem(`wh2:outbox:otherAccount0001:${m.id}`)).not.toBeNull();
  });

  it('flushKeepalive sends at most one request that fits the byte budget and returns its size', async () => {
    const p = await bootPhone(fake, { name: 'Pixel 7' });
    phones.push(p);
    const { mia, m } = await familyMatch(p);
    p.cloud.versus.enqueueSnapshots(m.id, mia, snaps(6, 120)); // 20
    expect(p.cloud.versus.flushKeepalive(m.id, 50)).toBe(0); // not even one fits
    expect(fake.calls.filter((c) => c.keepalive)).toEqual([]);
    const used = p.cloud.versus.flushKeepalive(m.id, 2_000);
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThanOrEqual(2_000);
    const ka = fake.calls.filter((c) => c.keepalive);
    expect(ka).toHaveLength(1);
    const body = ka[0]!.body as { snapshots: VersusSnapshot[] };
    expect(utf8Length(JSON.stringify(body))).toBe(used);
    expect(body.snapshots.length).toBeGreaterThan(0);
    expect(body.snapshots.length).toBeLessThan(20);
    expect(body.snapshots[0]!.h).toBe(6); // the oldest first
    await vi.advanceTimersByTimeAsync(1);
    expect(p.cloud.versus.outboxState(m.id).pending).toBe(20 - body.snapshots.length); // its answer acknowledged them
    // only the finish left → the finish goes keepalive when it fits
    await p.cloud.versus.flush(m.id);
    p.cloud.versus.enqueueFinish(m.id, mia, finishBody(mia, snap(360)));
    expect(p.cloud.versus.flushKeepalive(m.id, 100)).toBe(0);
    expect(p.cloud.versus.flushKeepalive(m.id, 60_000)).toBeGreaterThan(100);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.cloud.versus.outboxState(m.id)).toMatchObject({ pending: 0, finishSent: true });
  });
});

describe('versus api', () => {
  it('create → preview → join, with the kid-friendly errors', async () => {
    const a = await bootPhone(fake, { name: 'Phone', sub: 'parentA' });
    const b = await bootPhone(fake, { name: 'Tablet', sub: 'parentB' });
    phones.push(a, b);
    expect(a.cloud.versus.available).toBe(true);
    const mia = (await a.cloud.profiles.create('Mia', { animal: 'zebra', color: 1 })).id;
    const leo = (await b.cloud.profiles.create('Leo', { animal: 'lion', color: 3 })).id;
    const m = await a.cloud.versus.create({ profileId: mia, lengthMin: 4, rulesVersion: 1 });
    expect(m).toMatchObject({ status: 'open', mySeat: 0, kind: 'coded' });
    expect(m.code).toMatch(/^[A-Z2-9]{6}$/);
    await expect(a.cloud.versus.create({ profileId: mia, lengthMin: 4, rulesVersion: 1 })).rejects.toMatchObject({ code: 'open_limit', message: VS_MSG.openLimit });
    await expect(b.cloud.versus.preview('ZZZZZZ', leo)).rejects.toMatchObject({ code: 'not_found', message: VS_MSG.badCode });
    const pv = await b.cloud.versus.preview(m.code!.toLowerCase(), leo);
    expect(pv).toMatchObject({ matchId: m.id, challenger: { name: 'Mia' }, lengthMin: 4, days: 2, status: 'open' });
    await expect(a.cloud.versus.join(m.id, { profileId: mia, code: m.code!, rulesVersion: 1 })).rejects.toMatchObject({ code: 'own_match', message: VS_MSG.own });
    const joined = await b.cloud.versus.join(m.id, { profileId: leo, code: m.code!, rulesVersion: 1 });
    expect(joined).toMatchObject({ status: 'active', mySeat: 1 });
    expect(joined.players.map((x) => x.name)).toEqual(['Mia', 'Leo']);
    const c = track(await bootPhone(fake, { name: 'Laptop', sub: 'parentC' }));
    const zoe = (await c.cloud.profiles.create('Zoe', { animal: 'hippo', color: 0 })).id;
    await expect(c.cloud.versus.join(m.id, { profileId: zoe, code: m.code!, rulesVersion: 1 })).rejects.toMatchObject({ code: 'not_found' });
    expect((await a.cloud.versus.list(mia)).map((x) => x.id)).toEqual([m.id]);
    // device binding: the seat is played on the Phone; another phone of the same account gets the device name
    a.cloud.versus.enqueueSnapshots(m.id, mia, [snap(6)]);
    expect(await a.cloud.versus.flush(m.id)).toBe('sent');
    const a2 = track(await bootPhone(fake, { name: 'Second phone', sub: 'parentA' }));
    await expect(a2.cloud.versus.get(m.id, mia)).resolves.toMatchObject({ id: m.id });
    a2.cloud.versus.enqueueSnapshots(m.id, mia, [snap(12)]);
    expect(await a2.cloud.versus.flush(m.id)).toBe('dead');
    expect(a2.cloud.versus.outboxState(m.id).dead?.code).toBe('other_device');
    // offline creation
    a.client().offline = true;
    await expect(a.cloud.versus.rematch(m.id, mia)).rejects.toMatchObject({ code: 'network', message: VS_MSG.offlineCreate });
    await expect(a.cloud.versus.series(m.id, mia)).rejects.toMatchObject({ message: VS_MSG.offline });
  });
});

function track(p: Phone): Phone {
  phones.push(p);
  return p;
}
