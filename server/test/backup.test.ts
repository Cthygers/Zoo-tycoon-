import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listFlags, restoreRevision, runCli } from '../src/cli.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../src/clock.js';
import { BACKUP_RE, backupTime, newestBackup, restoreDatabase, retention, runBackup, snapshot } from '../src/db/backup.js';
import { currentEpoch } from '../src/db/migrate.js';
import { openDb } from '../src/db/sqlite.js';
import { makeProfile, putBody, snap } from './support/helpers.js';
import { makeTestApp, type SignedIn, type TestApp } from './support/testApp.js';

let t: TestApp;
let A: SignedIn;
beforeEach(async () => {
  t = await makeTestApp();
  A = await t.signIn('parent-a');
});
afterEach(async () => {
  await t.close();
});

describe('snapshots', () => {
  it('a snapshot is a valid gzip database that opens and answers queries', async () => {
    const pid = await makeProfile(t, A.token, 'Mia');
    await t.call('PUT', `/v1/profiles/${pid}/saves/main`, { token: A.token, body: putBody(null) });
    const dir = join(t.dir, 'backups');
    const file = await snapshot(t.db, dir, t.clock);
    expect(file.split('/').pop()).toMatch(BACKUP_RE);
    expect(readdirSync(dir).filter((f) => f.startsWith('tmp-'))).toEqual([]);
    const out = join(t.dir, 'check.db');
    const { epoch } = await restoreDatabase(file, out, t.clock);
    const db = openDb(out);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM profiles')!.n).toBe(1);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM save_revisions WHERE blob IS NOT NULL')!.n).toBe(1);
    expect(currentEpoch(db)).toBe(epoch);
    expect(epoch).not.toBe(currentEpoch(t.db));
    db.close();
  });

  it('retention keeps the newest 8 plus the newest of each of 14 days', () => {
    const dir = join(t.dir, 'ret');
    mkdirSync(dir, { recursive: true });
    const start = Date.UTC(2026, 9, 1, 0, 0);
    const names: string[] = [];
    for (let i = 0; i < 30 * 4; i++) {
      // every 6 h for 30 days
      const d = new Date(start + i * 6 * HOUR_MS);
      const p = (n: number) => String(n).padStart(2, '0');
      const name = `wildhaven-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z.db.gz`;
      writeFileSync(join(dir, name), 'x');
      names.push(name);
    }
    writeFileSync(join(dir, 'pre-migrate-1-2-123.db.gz'), 'x');
    const r = retention(dir, 8, 14);
    const kept = readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort();
    const newest8 = names.slice(-8);
    const daily = new Map<string, string>();
    for (const n of names) daily.set(n.slice(10, 18), n); // last of each day wins
    const last14days = [...daily.values()].slice(-14);
    expect(kept).toEqual([...new Set([...newest8, ...last14days])].sort());
    expect(kept.length).toBe(8 + 14 - 2); // the 2 newest days are already among the newest 8
    expect(r.deleted.length).toBe(names.length - kept.length);
    expect(existsSync(join(dir, 'pre-migrate-1-2-123.db.gz'))).toBe(true);
    expect(newestBackup(dir)).toBe(backupTime(names.at(-1)!));
  });

  it('/healthz reports backup stale after 2 missed intervals, ok after a backup', async () => {
    await t.close();
    t = await makeTestApp({ BACKUP_EVERY_HOURS: '6' });
    expect((await t.call('GET', '/healthz')).body.backup).toBe('ok');
    t.clock.advance(12 * HOUR_MS + 1);
    const h = await t.call('GET', '/healthz');
    expect(h.status).toBe(503);
    expect(h.body).toMatchObject({ ok: false, backup: 'stale' });
    await runBackup(t.db, t.clock, { dir: t.config.backupDir, keepRecent: 8, keepDaily: 14 });
    t.app.ops.lastBackupAt = t.clock.now();
    expect((await t.call('GET', '/healthz')).body).toMatchObject({ ok: true, backup: 'ok' });
  });
});

describe('cli', () => {
  const env = () => ({ DB_PATH: t.config.dbPath, BACKUP_DIR: t.config.backupDir });

  it('backup, flags and purge commands', async () => {
    const out: string[] = [];
    expect(await runCli(['backup'], env(), (s) => out.push(s))).toBe(0);
    expect(out[0]).toMatch(/backup written: .*wildhaven-\d{8}T\d{4}Z\.db\.gz$/);
    expect(readdirSync(t.config.backupDir).some((f) => BACKUP_RE.test(f))).toBe(true);
    out.length = 0;
    expect(await runCli(['purge'], env(), (s) => out.push(s))).toBe(0);
    expect(JSON.parse(out[0]!)).toHaveProperty('profilesPurged');
    out.length = 0;
    expect(await runCli(['flags'], env(), (s) => out.push(s))).toBe(0);
    expect(out).toEqual(['no flagged seats']);
    expect(await runCli(['nope'], env(), () => {})).toBe(2);
  });

  it('flags lists seats the server flagged', async () => {
    const mia = await makeProfile(t, A.token, 'Mia');
    const lea = await makeProfile(t, A.token, 'Lea');
    const f = await t.call('POST', '/v1/versus/matches', { token: A.token, body: { profileId: mia, opponentProfileId: lea, lengthMin: 30, rulesVersion: 1 } });
    await t.call('POST', `/v1/versus/matches/${f.body.match.id}/snapshots`, { token: A.token, body: { profileId: mia, snapshots: [6, 12, 18, 24, 30, 36, 42, 48, 54, 60].map((h) => snap(h)) } });
    const rows = listFlags(t.db);
    expect(rows).toEqual([expect.objectContaining({ matchId: f.body.match.id, seat: 0, name: 'Mia', flags: ['pace'] })]);
    expect(listFlags(t.db, 'someOtherMatchId0000')).toEqual([]);
  });

  it('restore-revision brings back an old revision or a stash as the new head (old head pinned)', async () => {
    const pid = await makeProfile(t, A.token, 'Mia');
    const url = `/v1/profiles/${pid}/saves/main`;
    const b1 = putBody(null, { content: { which: 'first' } });
    let h = (await t.call('PUT', url, { token: A.token, body: b1 })).body.head;
    h = (await t.call('PUT', url, { token: A.token, body: putBody({ epoch: h.epoch, rev: 1 }) })).body.head;
    t.clock.advance(MINUTE_MS);
    const restored = restoreRevision(t.db, t.clock, pid, { rev: 1 });
    expect(restored).toMatchObject({ rev: 3, sha256: b1.sha256, device: { id: 'support', name: 'Restored by support' } });
    const d = await t.call('GET', `${url}/data`, { token: A.token });
    expect(d.body.data).toBe(b1.data);
    expect(t.db.get<{ pinned_until: number }>('SELECT pinned_until FROM save_revisions WHERE rev = 2')!.pinned_until).toBe(t.clock.now() + 30 * DAY_MS);
    // a device that still has base rev 2 now gets 412 and the restored head
    const stale = await t.call('PUT', url, { token: A.token, body: putBody({ epoch: h.epoch, rev: 2 }) });
    expect(stale.status).toBe(412);
    expect(stale.body.error.details.head.rev).toBe(3);

    const enc = putBody(null, { content: { which: 'stash' } });
    await t.call('POST', `${url}/stash`, { token: A.token, body: { stashId: 'abcdabcd-0000-4000-8000-000000000001', reason: 'chose_other', saveVersion: 1, meta: enc.meta, clientSavedAt: 1, encoding: 'gzip+base64', data: enc.data, sha256: enc.sha256 } });
    const out: string[] = [];
    expect(await runCli(['restore-revision', '--profile', pid, '--stash', 'abcdabcd-0000-4000-8000-000000000001'], env(), (s) => out.push(s))).toBe(0);
    expect(out[0]).toMatch(/new head for .* rev 4/);
    expect((await t.call('GET', `${url}/data`, { token: A.token })).body.data).toBe(enc.data);
    expect(await runCli(['restore-revision', '--profile', pid], env(), () => {})).toBe(2);
  });

  it('restore <file> writes a new epoch and keeps the previous DB file', async () => {
    const pid = await makeProfile(t, A.token, 'Mia');
    await t.call('PUT', `/v1/profiles/${pid}/saves/main`, { token: A.token, body: putBody(null) });
    const before = currentEpoch(t.db);
    const file = await snapshot(t.db, t.config.backupDir, t.clock);
    const out: string[] = [];
    await t.restart(async () => {
      expect(await runCli(['restore', file], env(), (s) => out.push(s))).toBe(0);
    });
    const epochLine = out.find((l) => l.startsWith('new epoch: '))!;
    expect(epochLine.slice('new epoch: '.length)).toBe(currentEpoch(t.db));
    expect(currentEpoch(t.db)).not.toBe(before);
    expect(out.some((l) => l.includes('pre-restore-'))).toBe(true);
    expect((await t.call('GET', `/v1/profiles/${pid}/saves/main`, { token: A.token })).body.head.epoch).toBe(before);
  });
});
