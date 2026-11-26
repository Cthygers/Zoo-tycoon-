import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/clock.js';
import { restoreDatabase, snapshot } from '../src/db/backup.js';
import { currentEpoch } from '../src/db/migrate.js';
import { encodeSave, makeProfile, meta, putBody, sha256hex } from './support/helpers.js';
import { makeTestApp, type TestApp } from './support/testApp.js';

let t: TestApp;
let A: { token: string; accountId: string };
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

const put = (body: unknown, token = A.token) => t.call('PUT', url, { token, body });
const head = (q?: Record<string, string>) => t.call('GET', url, { token: A.token, ...(q ? { query: q } : {}) });

describe('CAS pushes', () => {
  it('first push with base null creates rev 1; GET head and data round-trip the bytes', async () => {
    expect((await head()).body).toMatchObject({ head: null, lease: null, pushed: null });
    const body = putBody(null, { meta: meta({ day: 9, playSeconds: 1234 }), content: { hello: 'zoo' } });
    const r = await put(body);
    expect(r.status).toBe(200);
    expect(r.body.replay).toBe(false);
    const h = r.body.head;
    expect(h).toMatchObject({ rev: 1, sha256: body.sha256, saveVersion: 1, appVersion: '0.15.0', pushId: body.pushId, clientSavedAt: body.clientSavedAt });
    expect(h.epoch).toBe(currentEpoch(t.db));
    expect(h.meta).toEqual(body.meta);
    expect(h.device).toEqual({ id: 'device-parent-a-0001', name: 'Test Phone' });
    expect(h.savedAt).toBe(t.clock.now());
    expect(h.sizeGz).toBe(Buffer.from(body.data, 'base64').length);
    const g = await head();
    expect(g.body.head).toEqual(h);
    const d = await t.call('GET', `${url}/data`, { token: A.token });
    expect(d.status).toBe(200);
    expect(d.body.encoding).toBe('gzip+base64');
    expect(d.body.data).toBe(body.data);
    expect(sha256hex(Buffer.from(d.body.data, 'base64'))).toBe(d.body.head.sha256);
  });

  it('data before any push → 404', async () => {
    expect((await t.call('GET', `${url}/data`, { token: A.token })).status).toBe(404);
  });

  it('second create (base null) → 412 conflict with details.head; wrong base → 412; right base → rev 2', async () => {
    const first = (await put(putBody(null))).body.head;
    const again = await put(putBody(null));
    expect(again.status).toBe(412);
    expect(again.body.error.code).toBe('conflict');
    expect(again.body.error.details.head).toEqual(first);
    const wrong = await put(putBody({ epoch: first.epoch, rev: 7 }));
    expect(wrong.status).toBe(412);
    const wrongEpoch = await put(putBody({ epoch: 'zzzzzzzz', rev: 1 }));
    expect(wrongEpoch.status).toBe(412);
    const ok = await put(putBody({ epoch: first.epoch, rev: 1 }));
    expect(ok.status).toBe(200);
    expect(ok.body.head.rev).toBe(2);
  });

  it('replay by pushId: same push → 200 replay (the revision while it is head, else the current head)', async () => {
    const b1 = putBody(null);
    const h1 = (await put(b1)).body.head;
    const r = await put(b1);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ replay: true, head: h1 });
    const b2 = putBody({ epoch: h1.epoch, rev: 1 });
    const h2 = (await put(b2)).body.head;
    const late = await put(b1); // the old push is no longer the head
    expect(late.body.replay).toBe(true);
    expect(late.body.head).toEqual(h2);
    expect(t.db.get<{ n: number }>('SELECT count(*) AS n FROM save_revisions')!.n).toBe(2);
  });

  it('pushIds returns the NEWEST landed push among the ids; null when none landed', async () => {
    const ids: string[] = [];
    let base: { epoch: string; rev: number } | null = null;
    for (let i = 0; i < 3; i++) {
      const b = putBody(base);
      ids.push(b.pushId);
      const h = (await put(b)).body.head;
      base = { epoch: h.epoch, rev: h.rev };
    }
    const g = await head({ pushIds: `${ids[0]},${ids[2]},${ids[1]}` });
    expect(g.body.pushed).toEqual({ epoch: base!.epoch, rev: 3, pushId: ids[2] });
    expect((await head({ pushIds: ids[0]! })).body.pushed).toEqual({ epoch: base!.epoch, rev: 1, pushId: ids[0] });
    expect((await head({ pushIds: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })).body.pushed).toBeNull();
    expect((await head({ pushIds: 'a,b,c,d,e' })).status).toBe(422);
  });

  it('keep_local pins the replaced head for 30 days', async () => {
    const h1 = (await put(putBody(null))).body.head;
    const h2 = (await put(putBody({ epoch: h1.epoch, rev: 1 }, { resolution: 'keep_local' }))).body.head;
    expect(h2.rev).toBe(2);
    const pins = t.db.all<{ rev: number; pinned_until: number | null }>('SELECT rev, pinned_until FROM save_revisions ORDER BY rev');
    expect(pins).toEqual([{ rev: 1, pinned_until: t.clock.now() + 30 * DAY_MS }, { rev: 2, pinned_until: null }]);
  });

  it('retention: blobs for the newest 10 + pinned; rows > 30 days go unless pinned/head/newest 10', async () => {
    let h = (await put(putBody(null))).body.head; // rev 1
    h = (await put(putBody({ epoch: h.epoch, rev: h.rev }))).body.head; // rev 2
    h = (await put(putBody({ epoch: h.epoch, rev: h.rev }, { resolution: 'keep_local' }))).body.head; // rev 3, pins rev 2
    for (let i = 0; i < 9; i++) h = (await put(putBody({ epoch: h.epoch, rev: h.rev }))).body.head; // rev 12
    const blobs = () => t.db.all<{ rev: number; has: number }>('SELECT rev, blob IS NOT NULL AS has FROM save_revisions ORDER BY rev');
    expect(blobs().filter((r) => r.has).map((r) => r.rev)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(blobs()).toHaveLength(12);
    t.clock.advance(31 * DAY_MS); // the pin on rev 2 has expired
    h = (await put(putBody({ epoch: h.epoch, rev: h.rev }))).body.head; // rev 13
    expect(blobs().map((r) => r.rev)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(blobs().every((r) => r.has)).toBe(true);
    // pushIds lookups still work for the kept rows
    expect((await head({ pushIds: h.pushId })).body.pushed.rev).toBe(13);
  });
});

describe('upload checks', () => {
  it('gz over 1 MiB → 413 too_large', async () => {
    const big = randomBytes(1_100_000);
    const r = await put(putBody(null, { data: big.toString('base64'), sha256: sha256hex(big) }));
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('too_large');
  });

  it('zip bomb (5 MiB of zeros) → 413 too_large, logged as zip_bomb', async () => {
    const bomb = gzipSync(Buffer.concat([Buffer.from('{"version":1,"x":"'), Buffer.alloc(5 * 1024 * 1024, 0x30), Buffer.from('"}')]));
    expect(bomb.length).toBeLessThan(20_000);
    const r = await put(putBody(null, { data: bomb.toString('base64'), sha256: sha256hex(bomb) }));
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('too_large');
    expect(t.logs.some((l) => l.includes('"kind":"zip_bomb"'))).toBe(true);
  });

  it('checksum mismatch → 422 checksum; not gzip / not JSON / no version / version mismatch → 422 bad_save', async () => {
    const enc = encodeSave({ a: 1 });
    expect((await put(putBody(null, { data: enc.data, sha256: 'a'.repeat(64) }))).body.error.code).toBe('checksum');
    const notGz = Buffer.from('hello world');
    expect((await put(putBody(null, { data: notGz.toString('base64'), sha256: sha256hex(notGz) }))).body.error.code).toBe('bad_save');
    const notJson = gzipSync(Buffer.from('not json'));
    expect((await put(putBody(null, { data: notJson.toString('base64'), sha256: sha256hex(notJson) }))).body.error.code).toBe('bad_save');
    const noVersion = gzipSync(Buffer.from('{"zoo":1}'));
    expect((await put(putBody(null, { data: noVersion.toString('base64'), sha256: sha256hex(noVersion) }))).body.error.code).toBe('bad_save');
    const v2 = encodeSave({ a: 1 }, 2);
    const mism = await put(putBody(null, { data: v2.data, sha256: v2.sha256, saveVersion: 1 }));
    expect(mism.status).toBe(422);
    expect(mism.body.error.code).toBe('bad_save');
    expect(t.db.get<{ n: number }>('SELECT count(*) AS n FROM save_revisions')!.n).toBe(0);
  });

  it('meta out of bounds or oversize → 422 invalid', async () => {
    for (const m of [meta({ day: 0 }), meta({ money: 1e11 }), meta({ rating: 101 }), meta({ playSeconds: -1 }), { ...meta(), extra: 1 }]) {
      const r = await put(putBody(null, { meta: m as never }));
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('invalid');
    }
  });

  it('account quota → 413 quota (counts revisions and stashes of every profile)', async () => {
    await t.close();
    const probe = encodeSave({ blob: randomBytes(1500).toString('hex') });
    t = await makeTestApp({ maxAccountBytes: probe.bytes.length * 2 + 100 });
    A = await t.signIn('parent-a');
    pid = await makeProfile(t, A.token, 'Mia');
    url = `/v1/profiles/${pid}/saves/main`;
    const mk = () => encodeSave({ blob: randomBytes(1500).toString('hex') });
    let enc = mk();
    let h = (await put(putBody(null, { data: enc.data, sha256: enc.sha256 }))).body.head;
    enc = mk();
    h = (await put(putBody({ epoch: h.epoch, rev: h.rev }, { data: enc.data, sha256: enc.sha256 }))).body.head;
    enc = mk();
    const r = await put(putBody({ epoch: h.epoch, rev: h.rev }, { data: enc.data, sha256: enc.sha256 }));
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('quota');
  });

  it('MAX_DB_BYTES reached → 507 server_full for writes, reads still work, /healthz unhealthy', async () => {
    const h = (await put(putBody(null))).body.head;
    await t.close();
    t = await makeTestApp({ maxDbBytes: 4096 });
    A = await t.signIn('parent-a');
    // sign-in itself still works (it is not a data write); profile creation is refused
    const c = await t.call('POST', '/v1/profiles', { token: A.token, body: { name: 'Mia', avatar: { animal: 'lion', color: 0 } } });
    expect(c.status).toBe(507);
    expect(c.body.error.code).toBe('server_full');
    expect((await t.call('GET', '/v1/profiles', { token: A.token })).status).toBe(200);
    const hz = await t.call('GET', '/healthz');
    expect(hz.status).toBe(503);
    expect(hz.body).toMatchObject({ ok: false, db: 'ok', disk: 'full' });
    expect(t.logs.some((l) => l.includes('"kind":"server_full"'))).toBe(true);
    void h;
  });
});

describe('epoch restore (cli restore)', () => {
  it('newEpoch() (test helper): the head keeps its epoch, the next push gets the new one', async () => {
    const h = (await put(putBody(null))).body.head;
    const e2 = t.newEpoch();
    expect(e2).not.toBe(h.epoch);
    expect((await head()).body.head.epoch).toBe(h.epoch);
    expect((await put(putBody({ epoch: h.epoch, rev: 1 }))).body.head).toMatchObject({ epoch: e2, rev: 2 });
  });

  it('restore writes a new epoch: an old base written after the backup gets 412; new revisions carry the new epoch', async () => {
    const e1 = currentEpoch(t.db);
    let h = (await put(putBody(null))).body.head;
    h = (await put(putBody({ epoch: h.epoch, rev: h.rev }))).body.head; // (e1, 2) — in the backup
    const file = await snapshot(t.db, `${t.dir}/backups`, t.clock);
    const lost = (await put(putBody({ epoch: h.epoch, rev: h.rev }))).body.head; // (e1, 3) — not in the backup
    expect(lost).toMatchObject({ epoch: e1, rev: 3 });

    let e2 = '';
    await t.restart(async () => {
      e2 = (await restoreDatabase(file, t.config.dbPath, t.clock)).epoch;
    });
    expect(e2).not.toBe(e1);
    expect(currentEpoch(t.db)).toBe(e2);

    // The restored head keeps its old epoch.
    const g = await head();
    expect(g.body.head).toMatchObject({ epoch: e1, rev: 2 });
    // A device whose base is the lost (e1, 3) never mistakes the head for its base.
    const stale = await put(putBody({ epoch: e1, rev: 3 }));
    expect(stale.status).toBe(412);
    expect(stale.body.error.details.head).toMatchObject({ epoch: e1, rev: 2 });
    // A device in sync with the restored head pushes on top; the new revision has the new epoch.
    const next = await put(putBody({ epoch: e1, rev: 2 }));
    expect(next.status).toBe(200);
    expect(next.body.head).toMatchObject({ epoch: e2, rev: 3 });
    // The lost revision's (e1, 3) base still conflicts after the renumbered rev 3 exists.
    expect((await put(putBody({ epoch: e1, rev: 3 }))).status).toBe(412);
  });
});
