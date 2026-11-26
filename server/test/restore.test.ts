// Operations under failure: 507 recovery, fail-safe restore, kept WAL commits, erasures that survive a restore
// (red team RT-02, RT-06, RT-07, RT-08, and the revoke half of RT-09).
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { DAY_MS } from '../src/clock.js';
import { restoreDatabase, snapshot } from '../src/db/backup.js';
import { DELETIONS_LOG } from '../src/db/deletions.js';
import { runHousekeeping } from '../src/db/housekeeping.js';
import { NewerDatabaseError } from '../src/db/migrate.js';
import { DatabaseInUseError, openDb } from '../src/db/sqlite.js';
import { encodeSave, makeProfile, putBody } from './support/helpers.js';
import { makeTestApp, type SignedIn, type TestApp } from './support/testApp.js';

let t: TestApp;
let A: SignedIn;
let closed = false;

beforeEach(async () => {
  closed = false;
  t = await makeTestApp();
  A = await t.signIn('parent-a', { id: 'device-a-0001', name: 'A Phone' }, { email: 'mum@example.com' });
});
afterEach(async () => {
  if (!closed) await t.close();
  else rmSync(t.dir, { recursive: true, force: true });
});

const env = () => ({ DB_PATH: t.config.dbPath, BACKUP_DIR: t.config.backupDir });

/** Stop the API for good (the test then works on the files). */
async function stopApi(): Promise<void> {
  await t.app.close();
  t.db.close();
  closed = true;
}

function profileNames(path: string): string[] {
  const db = openDb(path);
  try {
    return db.all<{ name: string }>('SELECT name FROM profiles ORDER BY name').map((r) => r.name);
  } finally {
    db.close();
  }
}

async function deleteAccount(who: SignedIn, sub: string): Promise<void> {
  const n = (await t.call('POST', '/v1/auth/nonce', { body: {} })).body.nonce;
  const idToken = await t.google.mintIdToken({ sub, nonce: n, aud: t.config.googleClientIds[0] });
  expect((await t.call('DELETE', '/v1/account', { token: who.token, body: { idToken, nonce: n } })).status).toBe(204);
}

describe('RT-02: 507 server_full clears once space is free again', () => {
  it('after a big account is deleted and housekeeping runs, writes work again (free pages do not count)', async () => {
    const pid = await makeProfile(t, A.token, 'Mia');
    let h: { epoch: string; rev: number } | null = null;
    for (let i = 0; i < 4; i++) {
      const e = encodeSave({ pad: randomBytes(220 * 1024).toString('base64') });
      h = (await t.call('PUT', `/v1/profiles/${pid}/saves/main`, { token: A.token, body: putBody(h && { epoch: h.epoch, rev: h.rev }, { data: e.data, sha256: e.sha256 }) })).body.head;
    }
    const B = await t.signIn('parent-b', { id: 'device-b-0001', name: 'B Phone' });
    t.config.maxDbBytes = t.db.sizeBytes();
    const full = await t.call('POST', '/v1/profiles', { token: B.token, body: { name: 'Ben', avatar: { animal: 'lion', color: 0 } } });
    expect(full.status).toBe(507);
    expect((await t.call('GET', '/healthz')).body.disk).toBe('full');
    await deleteAccount(A, 'parent-a');
    runHousekeeping(t.db, t.clock.now());
    const free = Number(t.db.get<{ freelist_count: number }>('PRAGMA freelist_count')!.freelist_count);
    const page = Number(t.db.get<{ page_size: number }>('PRAGMA page_size')!.page_size);
    expect(free * page).toBeGreaterThan(800_000);
    expect(t.db.sizeBytes()).toBeLessThan(t.config.maxDbBytes - 800_000);
    expect((await t.call('POST', '/v1/profiles', { token: B.token, body: { name: 'Ben', avatar: { animal: 'lion', color: 0 } } })).status).toBe(201);
    t.clock.advance(61_000); // /healthz re-measures at most once a minute
    expect((await t.call('GET', '/healthz')).body.disk).toBe('ok');
    // `cli vacuum` gives the free pages back to the disk, and only with the API stopped.
    await expect(runCli(['vacuum'], env(), () => {})).rejects.toBeInstanceOf(DatabaseInUseError);
    const fileBytes = () => Number(t.db.get<{ n: number }>('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()')!.n);
    const before = fileBytes();
    const out: string[] = [];
    await t.restart(async () => {
      expect(await runCli(['vacuum'], env(), (s) => out.push(s))).toBe(0);
    });
    expect(fileBytes()).toBeLessThan(before - 800_000);
    expect(statSync(t.config.dbPath).size).toBe(fileBytes());
    expect(out[0]).toMatch(/^vacuum: \d+ → \d+ bytes$/);
    expect((await t.call('GET', '/v1/profiles', { token: B.token })).body.profiles).toHaveLength(1);
  });
});

describe('RT-07: a failed restore leaves the live database untouched', () => {
  it('a damaged backup file: the restore throws, the live DB still opens with its data, no temp or kept files', async () => {
    await makeProfile(t, A.token, 'Mia');
    await stopApi();
    const bad = join(t.dir, 'wildhaven-20260101T0000Z.db.gz');
    writeFileSync(bad, gzipSync(randomBytes(64 * 1024)));
    await expect(restoreDatabase(bad, t.config.dbPath, t.clock)).rejects.toThrow();
    expect(profileNames(t.config.dbPath)).toEqual(['Mia']);
    expect(readdirSync(t.dir).filter((f) => f.includes('pre-restore') || f.includes('restoring'))).toEqual([]);
  });

  it('a backup from a newer server: NewerDatabaseError before anything is swapped', async () => {
    await makeProfile(t, A.token, 'Mia');
    const file = await snapshot(t.db, t.config.backupDir, t.clock);
    const tmp = join(t.dir, 'newer.db');
    writeFileSync(tmp, gunzipSync(readFileSync(file)));
    const n = openDb(tmp);
    n.exec('PRAGMA user_version = 99');
    n.exec("UPDATE profiles SET name = 'FromTheFuture'");
    n.close();
    const newer = join(t.dir, 'wildhaven-20990101T0000Z.db.gz');
    writeFileSync(newer, gzipSync(readFileSync(tmp)));
    await stopApi();
    await expect(restoreDatabase(newer, t.config.dbPath, t.clock)).rejects.toBeInstanceOf(NewerDatabaseError);
    expect(profileNames(t.config.dbPath)).toEqual(['Mia']);
    expect(readdirSync(t.dir).filter((f) => f.includes('pre-restore') || f.includes('restoring'))).toEqual([]);
  });

  it('refuses while the API still has the database open', async () => {
    await makeProfile(t, A.token, 'Mia');
    const file = await snapshot(t.db, t.config.backupDir, t.clock);
    await expect(restoreDatabase(file, t.config.dbPath, t.clock)).rejects.toBeInstanceOf(DatabaseInUseError);
    expect((await t.call('GET', '/v1/profiles', { token: A.token })).body.profiles).toHaveLength(1);
    expect(readdirSync(t.dir).filter((f) => f.includes('pre-restore') || f.includes('restoring'))).toEqual([]);
  });
});

describe('RT-08: the kept pre-restore copy is complete', () => {
  it('commits that were still in the -wal (e.g. after an OOM kill) are in the kept copy', async () => {
    await makeProfile(t, A.token, 'BeforeBackup');
    const file = await snapshot(t.db, t.config.backupDir, t.clock);
    t.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    await makeProfile(t, A.token, 'AfterBackup'); // committed, only in the -wal
    const crash = join(t.dir, 'crash');
    mkdirSync(crash);
    for (const s of ['', '-wal', '-shm']) if (existsSync(t.config.dbPath + s)) copyFileSync(t.config.dbPath + s, join(crash, 'wh.db' + s));
    expect(existsSync(join(crash, 'wh.db-wal'))).toBe(true);
    const r = await restoreDatabase(file, join(crash, 'wh.db'), t.clock);
    expect(r.keptOld).toMatch(/^wh\.db\.pre-restore-\d+$/);
    expect(profileNames(join(crash, r.keptOld!))).toEqual(['AfterBackup', 'BeforeBackup']);
    expect(profileNames(join(crash, 'wh.db'))).toEqual(['BeforeBackup']);
  });
});

describe('RT-06: a restore does not undo an account deletion', () => {
  it('the deleted family stays deleted (token dead, data gone); the log holds ids only; the CLI reports it', async () => {
    await makeProfile(t, A.token, 'Mia');
    const B = await t.signIn('parent-b', { id: 'device-b-0001', name: 'B Phone' });
    await makeProfile(t, B.token, 'Ben');
    const file = await snapshot(t.db, t.config.backupDir, t.clock);
    await deleteAccount(A, 'parent-a');
    expect((await t.call('GET', '/v1/account', { token: A.token })).status).toBe(401);
    const log = readFileSync(join(t.config.backupDir, DELETIONS_LOG), 'utf8');
    expect(log).toContain(A.accountId);
    expect(log).not.toContain('mum@example.com');
    expect(log).not.toContain('Mia');
    t.clock.advance(3 * DAY_MS);
    const out: string[] = [];
    await t.restart(async () => {
      expect(await runCli(['restore', file], env(), (s) => out.push(s))).toBe(0);
    });
    expect(out).toContain('deleted accounts removed again: 1, sessions revoked again: 0');
    expect((await t.call('GET', '/v1/account', { token: A.token })).status).toBe(401);
    expect(t.db.get('SELECT 1 AS x FROM accounts WHERE id = ?', A.accountId)).toBeUndefined();
    expect(t.db.get("SELECT 1 AS x FROM profiles WHERE name = 'Mia'")).toBeUndefined();
    // The other family is untouched.
    expect((await t.call('GET', '/v1/profiles', { token: B.token })).body.profiles.map((p: { name: string }) => p.name)).toEqual(['Ben']);
    // The deleted family can start again with a new account.
    const again = await t.signIn('parent-a');
    expect(again.accountId).not.toBe(A.accountId);
  });
});

describe('RT-09: cli revoke signs an account out everywhere, and a restore keeps it signed out', () => {
  it('revoke --email: every session of that account is dead, also after restoring an older backup', async () => {
    const A2 = await t.signIn('parent-a', { id: 'device-a-0002', name: 'A Tablet' }, { email: 'mum@example.com' });
    const B = await t.signIn('parent-b', { id: 'device-b-0001', name: 'B Phone' });
    const file = await snapshot(t.db, t.config.backupDir, t.clock);
    const out: string[] = [];
    expect(await runCli(['revoke', '--email', 'MUM@example.com'], env(), (s) => out.push(s))).toBe(0);
    expect(out).toEqual([`revoked 2 session(s) of account ${A.accountId}`]);
    for (const s of [A, A2]) expect((await t.call('GET', '/v1/account', { token: s.token })).status).toBe(401);
    expect((await t.call('GET', '/v1/account', { token: B.token })).status).toBe(200);
    await t.restart(async () => void (await restoreDatabase(file, t.config.dbPath, t.clock)));
    for (const s of [A, A2]) expect((await t.call('GET', '/v1/account', { token: s.token })).status).toBe(401);
    expect((await t.call('GET', '/v1/account', { token: B.token })).status).toBe(200);
    // Signing in again works (no ALLOWED_EMAILS here) and that new session is not revoked.
    const back = await t.signIn('parent-a', {}, { email: 'mum@example.com' });
    expect(back.accountId).toBe(A.accountId);
    expect((await t.call('GET', '/v1/account', { token: back.token })).status).toBe(200);
    expect(await runCli(['revoke'], env(), () => {})).toBe(2);
    await expect(runCli(['revoke', '--account', 'nobody-0000000000'], env(), () => {})).rejects.toThrow(/no such account/);
  });
});
