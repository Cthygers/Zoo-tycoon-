import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock.js';
import { restoreDatabase, snapshot } from '../src/db/backup.js';
import { NewerDatabaseError, currentEpoch, loadMigrations, migrate, userVersion } from '../src/db/migrate.js';
import { openDb, type DB } from '../src/db/sqlite.js';

let dir: string;
let db: DB;
const clock = new FakeClock(Date.UTC(2026, 10, 26, 4, 0));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wh-mig-'));
  db = openDb(join(dir, 'w.db'));
});
afterEach(() => {
  if (db.isOpen) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const tables = (d: DB) => d.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);

describe('migrations', () => {
  it('fresh → latest: every table, STRICT, user_version, pragmas, meta epoch', async () => {
    const r = await migrate(db, { clock });
    expect(r).toMatchObject({ from: 0, to: 2, applied: ['0001_init.sql', '0002_versus.sql'], backupFile: null });
    expect(userVersion(db)).toBe(2);
    expect(tables(db)).toEqual(['accounts', 'auth_nonces', 'match_seats', 'match_snapshots', 'matches', 'meta', 'profiles', 'save_revisions', 'save_stash', 'saves', 'sessions']);
    for (const t of tables(db)) {
      const sql = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = ?", t)!.sql;
      expect(sql, t).toMatch(/\)\s*STRICT\s*$/);
    }
    expect(currentEpoch(db)).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')!.journal_mode).toBe('wal');
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')!.foreign_keys).toBe(1);
    expect(db.get<{ synchronous: number }>('PRAGMA synchronous')!.synchronous).toBe(2); // FULL
    expect(db.get<{ secure_delete: number }>('PRAGMA secure_delete')!.secure_delete).toBe(1);
    expect(db.get<{ trusted_schema: number }>('PRAGMA trusted_schema')!.trusted_schema).toBe(0);
    expect(db.get<{ timeout: number }>('PRAGMA busy_timeout')!.timeout).toBe(5000);
    // idempotent
    const again = await migrate(db, { clock });
    expect(again.applied).toEqual([]);
  });

  it('a v1 fixture with data → latest keeps the data and writes a pre-migration backup first', async () => {
    await migrate(db, { clock, target: 1 });
    expect(userVersion(db)).toBe(1);
    db.run("INSERT INTO accounts (id, google_sub, email, created_at, last_seen_at) VALUES ('acc-0000000000000001', 'sub-1', NULL, 1, 1)");
    const epoch = currentEpoch(db);
    const backups = join(dir, 'backups');
    const r = await migrate(db, { clock, backup: (from, to) => snapshot(db, backups, clock, `pre-migrate-${from}-${to}-${clock.now()}.db.gz`) });
    expect(r).toMatchObject({ from: 1, to: 2, applied: ['0002_versus.sql'] });
    expect(r.backupFile).toMatch(/pre-migrate-1-2-\d+\.db\.gz$/);
    expect(readdirSync(backups)).toHaveLength(1);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM accounts')!.n).toBe(1);
    expect(currentEpoch(db)).toBe(epoch);
    // the backup is the v1 database
    const restoredPath = join(dir, 'restored.db');
    await restoreDatabase(r.backupFile!, restoredPath, clock); // migrates the restored copy to latest
    const back = openDb(restoredPath);
    expect(back.get<{ n: number }>('SELECT count(*) AS n FROM accounts')!.n).toBe(1);
    expect(userVersion(back)).toBe(2);
    back.close();
  });

  it('an empty database gets no pre-migration backup', async () => {
    let called = false;
    await migrate(db, { clock, backup: async () => { called = true; } });
    expect(called).toBe(false);
  });

  it('refuses a database newer than this server', async () => {
    await migrate(db, { clock });
    db.exec('PRAGMA user_version = 3');
    await expect(migrate(db, { clock })).rejects.toBeInstanceOf(NewerDatabaseError);
  });

  it('migration files are numbered without gaps', () => {
    expect(loadMigrations().map((m) => m.version)).toEqual([1, 2]);
  });
});
