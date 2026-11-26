// Contract test (spec §10.3): ONE scenario list run twice — against the client's in-memory model of
// the server (src/net/fakeCloud.ts, which every net unit test uses) and against the real Fastify app
// through the client's own HTTP layer (HttpCloudApi + injectFetch, no sockets). Each step records a
// normalised observation (status codes, revs, flags; never ids or times); any behavioural difference
// between the two fails the test, so the fake the client tests rely on cannot drift from the server.
//
// Typechecked with tsconfig.contract.json (the client modules use bundler-style imports).
import { describe, expect, it } from 'vitest';
import type { PutSaveBody, SaveRef, VersusParts, VersusSnapshot } from '../../shared/api-types';
import { scoreRounded } from '../../shared/versus-rules';
import { HttpCloudApi, type CloudApi } from '../../src/net/cloudApi';
import { encodeSave, sha256OfB64Sync } from '../../src/net/codec';
import { FakeCloud } from '../../src/net/fakeCloud';
import { ApiFailure } from '../../src/net/http';
import { injectFetch } from './support/injectFetch';
import { makeTestApp } from './support/testApp';

/** One server under test: two devices of parent1 (A, B), one device of parent2 (C), a bad token (X). */
interface Side {
  A: CloudApi;
  B: CloudApi;
  C: CloudApi;
  X: CloudApi;
  advance(ms: number): void;
  newEpoch(): void;
  close(): Promise<void>;
}

const DEV_A = { id: 'dev-aaaa-0001', name: 'Phone' };
const DEV_B = { id: 'dev-bbbb-0002', name: 'Tablet' };
const DEV_C = { id: 'dev-cccc-0003', name: 'Friend phone' };

async function realSide(): Promise<Side> {
  const t = await makeTestApp({ LEASE_SECONDS: '150', VERSUS_TEST_LENGTH: '1' });
  const f = injectFetch(t.app);
  const mk = (token: string) => new HttpCloudApi({ base: 'http://localhost', fetch: f, token: () => token, appVersion: '0.15.0', client: 'web' });
  const a = await t.signIn('parent1', DEV_A);
  const b = await t.signIn('parent1', DEV_B);
  const c = await t.signIn('parent2', DEV_C);
  return {
    A: mk(a.token),
    B: mk(b.token),
    C: mk(c.token),
    X: mk('whs_' + 'x'.repeat(43)),
    advance: (ms) => void t.clock.advance(ms),
    newEpoch: () => void t.newEpoch(),
    close: () => t.close(),
  };
}

async function fakeSide(): Promise<Side> {
  let now = Date.now();
  const fake = new FakeCloud({ now: () => now, leaseSeconds: 150 });
  const a = fake.signInDirect('parent1', DEV_A);
  const b = fake.signInDirect('parent1', DEV_B);
  const c = fake.signInDirect('parent2', DEV_C);
  const mk = (token: string) => fake.api({ token: () => token, appVersion: '0.15.0', client: 'web' });
  return {
    A: mk(a.token),
    B: mk(b.token),
    C: mk(c.token),
    X: mk('whs_' + 'x'.repeat(43)),
    advance: (ms) => void (now += ms),
    newEpoch: () => void fake.restoreEpoch(),
    close: async () => {},
  };
}

// ------------------------------------------------------------------ helpers
const meta = (playSeconds: number) => ({ day: 3, minute: 600, money: 5000, rating: 40, animals: 2, species: 1, visitors: 9, playSeconds });
let pushN = 0;
const pushId = () => `00000000-0000-4000-8000-${String(++pushN).padStart(12, '0')}`;
function zoo(tag: string): { data: string; sha256: string } {
  const data = encodeSave(JSON.stringify({ version: 1, tag }));
  return { data, sha256: sha256OfB64Sync(data) };
}
function put(tag: string, base: SaveRef | null, extra: Partial<PutSaveBody> = {}, playSeconds = 300): PutSaveBody {
  const z = zoo(tag);
  return { base, pushId: pushId(), saveVersion: 1, meta: meta(playSeconds), clientSavedAt: 1_700_000_000_000, encoding: 'gzip+base64', data: z.data, sha256: z.sha256, ...extra };
}
/** 'ok' or '<status>:<code>' of a call. */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ApiFailure ? `${e.status}:${e.code}` : `threw:${String(e)}`;
  }
}
async function failure(p: Promise<unknown>): Promise<ApiFailure | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof ApiFailure ? e : null;
  }
}
function snap(h: number, scale = 1): VersusSnapshot {
  const parts: VersusParts = { v: h * 2 * scale, a: h * 1.5, s: h, b: 0, m: h * 3 * scale, l: 0 };
  return { h, day: 1 + Math.floor(h / 24), min: 510, parts, total: scoreRounded(parts), run: h * 300, cash: 100_000, guests: 20, visitors: h * 4, animals: 6, species: 3, habitats: 2, stars: 50 };
}
const finalSave = () => {
  const z = zoo('final');
  return { encoding: 'gzip+base64' as const, data: z.data, sha256: z.sha256 };
};
/** A save head without ids or times. */
const headView = (h: { rev: number; playSeconds?: number; meta?: { playSeconds: number }; deviceName?: string; pushId?: string | null } | null | undefined) =>
  h ? { rev: h.rev, play: h.meta?.playSeconds ?? null, device: h.deviceName ?? null } : null;

// ------------------------------------------------------------------ the scenario list
type Obs = Record<string, unknown>;
type Step = { name: string; run(s: Side, ctx: Record<string, any>): Promise<Obs> };

const steps: Step[] = [
  {
    name: 'profiles: create, name_taken, list',
    async run(s, c) {
      const mia = await s.A.createProfile({ name: 'Mia', avatar: { animal: 'lion', color: 0 } });
      c.mia = mia.profile.id;
      const dup = await outcome(s.A.createProfile({ name: 'mia', avatar: { animal: 'bear', color: 1 } }));
      const list = await s.B.profiles();
      return { name: mia.profile.name, dup, listed: list.profiles.map((p) => p.name), mainNull: list.profiles[0]?.main ?? null };
    },
  },
  {
    name: 'saves: empty head, create (base null), replay by pushId, second create → 412',
    async run(s, c) {
      const empty = await s.A.getHead(c.mia);
      const body = put('a1', null);
      const r1 = await s.A.putSave(c.mia, body);
      c.r1 = r1.head;
      c.firstPush = body.pushId;
      const replay = await s.A.putSave(c.mia, body);
      const f = await failure(s.B.putSave(c.mia, put('b-create', null)));
      return {
        empty: empty.head,
        r1: headView(r1.head),
        replay: [replay.replay, replay.head.rev],
        second: f ? `${f.status}:${f.code}` : 'ok',
        detailsHeadRev: (f?.details as { head?: { rev: number } } | undefined)?.head?.rev ?? null,
        detailsHeadPushId: (f?.details as { head?: { pushId?: string } } | undefined)?.head?.pushId === body.pushId,
      };
    },
  },
  {
    name: 'saves: CAS 200 and 412 with details.head; pushIds lookup returns the newest landed',
    async run(s, c) {
      const base = { epoch: c.r1.epoch, rev: c.r1.rev };
      const b2 = put('a2', base);
      const r2 = await s.A.putSave(c.mia, b2);
      c.r2 = r2.head;
      const stale = await failure(s.B.putSave(c.mia, put('b-stale', base)));
      const h = await s.A.getHead(c.mia, [c.firstPush, b2.pushId, '00000000-0000-4000-8000-ffffffffffff']);
      const data = await s.B.getData(c.mia);
      return {
        r2: headView(r2.head),
        stale: stale ? `${stale.status}:${stale.code}` : 'ok',
        staleHead: (stale?.details as { head?: { rev: number } } | undefined)?.head?.rev ?? null,
        pushedRev: h.pushed?.rev ?? null,
        pushedIsNewest: h.pushed?.pushId === b2.pushId,
        dataSha: sha256OfB64Sync(data.data) === data.head.sha256,
        dataRev: data.head.rev,
      };
    },
  },
  {
    name: 'lease: acquire, in_use, leased_elsewhere, takeover, lease_lost, holder push',
    async run(s, c) {
      const a = await s.A.lease(c.mia, { action: 'acquire' });
      const inUse = await failure(s.B.lease(c.mia, { action: 'acquire' }));
      const base = { epoch: c.r2.epoch, rev: c.r2.rev };
      const elsewhere = await outcome(s.B.putSave(c.mia, put('b3', base)));
      const take = await s.B.lease(c.mia, { action: 'acquire', takeover: true });
      const lost = await outcome(s.A.lease(c.mia, { action: 'renew' }));
      const aPush = await outcome(s.A.putSave(c.mia, put('a3', base)));
      const r3 = await s.B.putSave(c.mia, put('b3', base, {}, 900));
      c.r3 = r3.head;
      const renew = await s.B.lease(c.mia, { action: 'renew' });
      const rel = await s.B.lease(c.mia, { action: 'release' });
      return {
        aMine: a.lease?.mine ?? null,
        inUse: inUse ? `${inUse.status}:${inUse.code}` : 'ok',
        holderDevice: (inUse?.details as { holder?: { deviceName?: string } } | undefined)?.holder?.deviceName ?? null,
        elsewhere,
        takeMine: take.lease?.mine ?? null,
        lost,
        aPush,
        r3: headView(r3.head),
        renewMine: renew.lease?.mine ?? null,
        released: rel.lease ?? null,
      };
    },
  },
  {
    name: 'lease: expiry after LEASE_SECONDS lets another device in',
    async run(s, c) {
      // a second player: the server allows 6 lease calls a minute per player
      const kai = (await s.A.createProfile({ name: 'Kai', avatar: { animal: 'tiger', color: 4 } })).profile.id;
      await s.A.lease(kai, { action: 'acquire' });
      const before = await outcome(s.B.lease(kai, { action: 'acquire' }));
      s.advance(151_000);
      const after = await s.B.lease(kai, { action: 'acquire' });
      const aRenew = await outcome(s.A.lease(kai, { action: 'renew' }));
      await s.B.lease(kai, { action: 'release' });
      return { before, afterMine: after.lease?.mine ?? null, aRenew };
    },
  },
  {
    name: 'keep_local pins the replaced head; stash create + replay; checksum mismatch',
    async run(s, c) {
      // A diverged from r2 while B pushed r3: A keeps its zoo (conflict "here")
      const stale = await failure(s.A.putSave(c.mia, put('a-div', { epoch: c.r2.epoch, rev: c.r2.rev })));
      const head = (stale?.details as { head: SaveRef }).head;
      const keep = await s.A.putSave(c.mia, put('a-keep', { epoch: head.epoch, rev: head.rev }, { resolution: 'keep_local' }));
      c.r4 = keep.head;
      const z = zoo('stash');
      const sb = { stashId: '00000000-0000-4000-9000-000000000001', reason: 'auto_pull' as const, saveVersion: 1, meta: meta(40), clientSavedAt: 1, encoding: 'gzip+base64' as const, data: z.data, sha256: z.sha256 };
      const st1 = await s.A.stash(c.mia, sb);
      const st2 = await s.A.stash(c.mia, sb);
      const headAfterStash = await s.A.getHead(c.mia);
      const bad = await outcome(s.A.putSave(c.mia, { ...put('bad', { epoch: c.r4.epoch, rev: c.r4.rev }), sha256: '0'.repeat(64) }));
      return {
        stale: stale ? `${stale.status}:${stale.code}` : 'ok',
        keep: headView(keep.head),
        stashPinned: typeof st1.pinnedUntil === 'number' && st1.pinnedUntil > 0,
        stashReplaySame: st2.pinnedUntil === st1.pinnedUntil,
        stashNotHead: headAfterStash.head?.rev === c.r4.rev,
        bad,
      };
    },
  },
  {
    name: 'new epoch (server restored): the next push lands in the new epoch; an old ref → 412 with that head',
    async run(s, c) {
      s.newEpoch();
      const h = await s.A.getHead(c.mia);
      // a push on the current head lands in the new epoch; a device still holding the old ref then loses the CAS
      const r5 = await s.A.putSave(c.mia, put('a-new', { epoch: h.head!.epoch, rev: h.head!.rev }));
      const oldBase = await failure(s.B.putSave(c.mia, put('b-old', { epoch: c.r4.epoch, rev: c.r4.rev })));
      const after = await s.B.getHead(c.mia);
      return {
        headRev: h.head?.rev ?? null,
        headEpochSame: h.head?.epoch === c.r4.epoch,
        oldBase: oldBase ? `${oldBase.status}:${oldBase.code}` : 'ok',
        r5: headView(r5.head),
        r5NewEpoch: r5.head.epoch !== c.r4.epoch,
        oldBaseHeadIsR5: (oldBase?.details as { head?: SaveRef } | undefined)?.head?.epoch === r5.head.epoch,
        afterRev: after.head?.rev ?? null,
      };
    },
  },
  {
    name: 'profile removed → 410 everywhere, listed as removed; restore; foreign id → 404',
    async run(s, c) {
      const rm = await s.A.removeProfile(c.mia);
      const head = await outcome(s.B.getHead(c.mia));
      const lease = await outcome(s.B.getData(c.mia)); // (lease calls are rate-limited to 6 a minute per player)
      const list = await s.B.profiles();
      const back = await s.A.restoreProfile(c.mia);
      const after = await outcome(s.B.getHead(c.mia));
      const foreign = await outcome(s.C.getHead(c.mia));
      const unknown = await outcome(s.A.getHead('AAAAAAAAAAAAAAAAAAAAAA'));
      return {
        removed: rm.removed.name,
        head,
        lease,
        listedRemoved: list.removed.map((r) => r.name),
        listed: list.profiles.map((p) => p.name),
        restored: back.profile.name,
        after,
        foreign,
        unknown,
      };
    },
  },
  {
    name: '401 for an unknown session token',
    async run(s, c) {
      return { profiles: await outcome(s.X.profiles()), head: await outcome(s.X.getHead(c.mia)), config: await outcome(s.X.config()) };
    },
  },
  {
    name: 'versus: coded create → preview → join → snapshots (pace) → finish both → decided',
    async run(s, c) {
      const ben = await s.C.createProfile({ name: 'Ben', avatar: { animal: 'bear', color: 2 } });
      c.ben = ben.profile.id;
      const created = await s.A.createMatch({ profileId: c.mia, lengthMin: 4, rulesVersion: 1 });
      const m = created.match;
      const own = await outcome(s.A.previewCode(m.code!, c.mia));
      const ownJoin = await outcome(s.A.joinMatch(m.id, { profileId: c.mia, code: m.code!, rulesVersion: 1 }));
      const prev = await s.C.previewCode(m.code!, c.ben);
      const wrong = await outcome(s.C.previewCode('ZZZZZZ', c.ben));
      const joined = (await s.C.joinMatch(prev.matchId, { profileId: c.ben, code: m.code!, rulesVersion: 1 })).match;
      const again = await outcome(s.C.joinMatch(prev.matchId, { profileId: c.ben, code: m.code!, rulesVersion: 1 }));
      // 6 match hours = 30 real s at the earliest; post after 60 s
      s.advance(60_000);
      const a6 = await s.A.postSnapshots(m.id, { profileId: c.mia, snapshots: [snap(6)] });
      const aDup = await s.A.postSnapshots(m.id, { profileId: c.mia, snapshots: [snap(6)] });
      const bad = await outcome(s.A.postSnapshots(m.id, { profileId: c.mia, snapshots: [{ ...snap(12), total: 1 }] }));
      const c6 = await s.C.postSnapshots(m.id, { profileId: c.ben, snapshots: [snap(6, 0.5)] });
      // another device of the challenger's account cannot post for the bound seat
      const otherDevice = await outcome(s.B.postSnapshots(m.id, { profileId: c.mia, snapshots: [snap(12)] }));
      s.advance(300_000);
      const a42 = await s.A.postSnapshots(m.id, { profileId: c.mia, snapshots: [6, 12, 18, 24, 30, 36, 42].map((h) => snap(h)) });
      const seriesC = await s.C.series(m.id, c.ben);
      const fa = (await s.A.finish(m.id, { profileId: c.mia, final: snap(48), endReason: 'complete', save: finalSave() })).match;
      const faAgain = await outcome(s.A.finish(m.id, { profileId: c.mia, final: snap(48), endReason: 'complete', save: finalSave() }));
      const fc = (await s.C.finish(m.id, { profileId: c.ben, final: snap(48, 0.5), endReason: 'complete', save: finalSave() })).match;
      const seenA = (await s.A.getMatch(m.id, c.mia)).match;
      const listA = await s.A.listMatches(c.mia, 'finished');
      return {
        created: [m.status, m.kind, m.days, m.mySeat, m.players.length, m.budgetMin, typeof m.code === 'string' && m.code.length === 6],
        own,
        ownJoin,
        preview: [prev.challenger.name, prev.lengthMin, prev.days, prev.status],
        wrong,
        joined: [joined.status, joined.mySeat, joined.players.map((p) => [p.name, p.role, p.isMe, p.state]), joined.code],
        again,
        a6: [a6.ackHour, a6.opponent?.lastHour ?? null],
        aDup: aDup.ackHour,
        bad,
        c6: [c6.ackHour, c6.opponent?.lastHour ?? null, c6.opponent?.total ?? null, c6.opponent?.atMyHour ?? null],
        otherDevice,
        a42: [a42.ackHour, a42.opponent?.lastHour ?? null],
        seriesC: [seriesC.lastHour, seriesC.series.length, seriesC.done],
        fa: [fa.status, fa.players[fa.mySeat]!.state, fa.result],
        faAgain,
        fc: [fc.status, fc.result?.kind ?? null, fc.result?.winnerSeat ?? null, fc.result?.reason ?? null, fc.result?.totals ?? null],
        seenA: [seenA.status, seenA.result?.winnerSeat ?? null, seenA.players.map((p) => [p.name, p.isMe, p.state, p.total, p.endReason])],
        listedFinished: listA.matches.length,
      };
    },
  },
  {
    name: 'versus: family match created already joined; cancel refused after a snapshot; forfeit decides',
    async run(s, c) {
      const lea = await s.A.createProfile({ name: 'Lea', avatar: { animal: 'zebra', color: 3 } });
      const fam = (await s.A.createMatch({ profileId: c.mia, lengthMin: 4, opponentProfileId: lea.profile.id, rulesVersion: 1 })).match;
      s.advance(60_000);
      await s.A.postSnapshots(fam.id, { profileId: c.mia, snapshots: [snap(6)] });
      const cancel = await outcome(s.A.cancel(fam.id, { profileId: c.mia }));
      const ff = (await s.A.forfeit(fam.id, { profileId: lea.profile.id })).match;
      return {
        fam: [fam.status, fam.kind, fam.code, fam.players.map((p) => [p.name, p.role, p.state])],
        cancel,
        forfeit: [ff.status, ff.result?.kind ?? null, ff.result?.reason ?? null, ff.players.map((p) => p.state)],
      };
    },
  },
  {
    name: 'versus: an open coded match can be cancelled before the first snapshot',
    async run(s, c) {
      const m = (await s.A.createMatch({ profileId: c.mia, lengthMin: 4, rulesVersion: 1 })).match;
      const cancelled = (await s.A.cancel(m.id, { profileId: c.mia })).match;
      const join = await outcome(s.C.joinMatch(m.id, { profileId: c.ben, code: m.code!, rulesVersion: 1 }));
      return { cancelled: [cancelled.status, cancelled.result?.kind ?? null], join };
    },
  },
];

async function runAll(side: Side): Promise<Array<{ name: string; obs: Obs }>> {
  const ctx: Record<string, any> = {};
  const out: Array<{ name: string; obs: Obs }> = [];
  try {
    for (const st of steps) {
      let obs: Obs;
      try {
        obs = await st.run(side, ctx);
      } catch (e) {
        obs = { crashed: e instanceof ApiFailure ? `${e.status}:${e.code}` : String(e) };
      }
      out.push({ name: st.name, obs });
    }
  } finally {
    await side.close();
  }
  return out;
}

describe('contract: FakeCloud vs the real server (HttpCloudApi + injectFetch)', () => {
  it('every scenario step observes the same behaviour on both', async () => {
    pushN = 0;
    const real = await runAll(await realSide());
    pushN = 0;
    const fake = await runAll(await fakeSide());
    // no step may crash on either side, and the real server must actually do the work checked below
    for (const r of [...real, ...fake]) expect(r.obs, r.name).not.toHaveProperty('crashed');
    for (let i = 0; i < steps.length; i++) expect(fake[i]!.obs, `fake vs real: ${steps[i]!.name}`).toEqual(real[i]!.obs);
    // anchor the shared behaviour (a step both sides got wrong the same way would still fail here)
    const byName = Object.fromEntries(real.map((r) => [r.name, r.obs]));
    if (process.env.CONTRACT_DUMP) console.log(JSON.stringify(real, null, 1));
    expect(byName[steps[1]!.name]).toMatchObject({ empty: null, r1: { rev: 1 }, replay: [true, 1], second: '412:conflict' });
    expect(byName[steps[2]!.name]).toMatchObject({ stale: '412:conflict', staleHead: 2, pushedRev: 2, pushedIsNewest: true, dataSha: true });
    expect(byName[steps[3]!.name]).toMatchObject({ aMine: true, inUse: '409:in_use', holderDevice: 'Phone', elsewhere: '409:leased_elsewhere', takeMine: true, lost: '409:lease_lost', aPush: '409:leased_elsewhere', renewMine: true });
    expect(byName[steps[4]!.name]).toMatchObject({ before: '409:in_use', afterMine: true, aRenew: '409:lease_lost' });
    expect(byName[steps[5]!.name]).toMatchObject({ stale: '412:conflict', stashPinned: true, stashReplaySame: true, stashNotHead: true, bad: '422:checksum' });
    expect(byName[steps[6]!.name]).toMatchObject({ headEpochSame: true, oldBase: '412:conflict', r5NewEpoch: true, oldBaseHeadIsR5: true });
    expect(byName[steps[7]!.name]).toMatchObject({ head: '410:profile_deleted', lease: '410:profile_deleted', restored: 'Mia', after: 'ok', foreign: '404:not_found', unknown: '404:not_found' });
    expect(byName[steps[8]!.name]).toMatchObject({ profiles: '401:unauthorized', head: '401:unauthorized' });
    expect(byName[steps[9]!.name]).toMatchObject({ own: 'ok', ownJoin: '403:own_match', again: '409:match_full', otherDevice: '409:other_device', faAgain: 'ok' });
    expect((byName[steps[9]!.name] as { fc: unknown[] }).fc.slice(0, 3)).toEqual(['finished', 'win', 0]);
  });
});
