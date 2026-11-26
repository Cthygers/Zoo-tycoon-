// db/backup.ts — online snapshots (sqlite backup → gzip → atomic rename), retention, restore.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { Clock } from '../clock.js';
import { deletionLogPath, reapplyDeletions, type ReapplyResult } from './deletions.js';
import { migrate, setNewEpoch } from './migrate.js';
import { DatabaseInUseError, backupTo, checkpointAlone, openDb, type DB } from './sqlite.js';

export const BACKUP_RE = /^wildhaven-(\d{8})T(\d{4})Z\.db\.gz$/;

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
}

/** Time encoded in a backup file name, or null. */
export function backupTime(name: string): number | null {
  const m = BACKUP_RE.exec(name);
  if (!m) return null;
  const [d, hm] = [m[1]!, m[2]!];
  return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +hm.slice(0, 2), +hm.slice(2, 4));
}

async function gzipFile(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(dest, { mode: 0o600 }));
}

/** Snapshot `db` into `<dir>/<prefix><stamp>.db.gz` (or an explicit file name). Returns the path. */
export async function snapshot(db: DB, dir: string, clock: Clock, fileName?: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const now = clock.now();
  const name = fileName ?? `wildhaven-${stamp(now)}.db.gz`;
  const tmpDb = join(dir, `tmp-${now}-${process.pid}.db`);
  const tmpGz = join(dir, `tmp-${now}-${process.pid}.db.gz`);
  try {
    await backupTo(db, tmpDb);
    await gzipFile(tmpDb, tmpGz);
    const dest = join(dir, name);
    renameSync(tmpGz, dest);
    return dest;
  } finally {
    rmSync(tmpDb, { force: true });
    rmSync(tmpDb + '-wal', { force: true });
    rmSync(tmpDb + '-shm', { force: true });
    rmSync(tmpGz, { force: true });
  }
}

/** Keep the newest `keepRecent` plus the newest file of each of the `keepDaily` most recent days. */
export function retention(dir: string, keepRecent: number, keepDaily: number): { kept: string[]; deleted: string[] } {
  if (!existsSync(dir)) return { kept: [], deleted: [] };
  const files = readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort().reverse(); // newest first
  const keep = new Set(files.slice(0, keepRecent));
  const days: string[] = [];
  for (const f of files) {
    const day = BACKUP_RE.exec(f)![1]!;
    if (days.includes(day)) continue;
    if (days.length >= keepDaily) break;
    days.push(day);
    keep.add(f); // first seen = newest of that day
  }
  const deleted: string[] = [];
  for (const f of files) {
    if (keep.has(f)) continue;
    rmSync(join(dir, f), { force: true });
    deleted.push(f);
  }
  return { kept: files.filter((f) => keep.has(f)), deleted };
}

/** Newest backup time in `dir` (from file names), or null. */
export function newestBackup(dir: string): number | null {
  if (!existsSync(dir)) return null;
  let best: number | null = null;
  for (const f of readdirSync(dir)) {
    const t = backupTime(f);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

export interface BackupJobOptions {
  dir: string;
  keepRecent: number;
  keepDaily: number;
}

/** One scheduled backup: snapshot + retention. */
export async function runBackup(db: DB, clock: Clock, o: BackupJobOptions): Promise<string> {
  const file = await snapshot(db, o.dir, clock);
  retention(o.dir, o.keepRecent, o.keepDaily);
  return file;
}

export interface RestoreOptions {
  /** The erasure log to re-apply (default `<dir of dbPath>/backups/deletions.log`, the default BACKUP_DIR). */
  deletionLog?: string;
}

export interface RestoreResult {
  epoch: string;
  /** File name (next to dbPath) the replaced database was kept under, with its -wal/-shm if any. */
  keptOld: string | null;
  /** Logged account deletions and revocations applied again to the restored data. */
  reapplied: ReapplyResult;
}

/**
 * Restore (API stopped). Fail-safe: the live database is only touched once the backup has been checked.
 * 1. The live DB (if any) is opened alone: DatabaseInUseError while the API still has it open; its -wal is
 *    folded into the main file so the kept copy is complete.
 * 2. `file` is gunzipped next to dbPath and checked there: integrity_check, migrate() (refuses a newer schema),
 *    the erasure log re-applied, a NEW meta.epoch written, WAL checkpointed. Any failure removes the temp
 *    file and rethrows; dbPath is untouched.
 * 3. The old DB (with any -wal/-shm) is renamed to `<db>.pre-restore-<ts>`, the checked copy takes its place.
 */
export async function restoreDatabase(file: string, dbPath: string, clock: Clock, o: RestoreOptions = {}): Promise<RestoreResult> {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`no such backup file: ${file}`);
  const logPath = o.deletionLog ?? deletionLogPath(join(dirname(dbPath), 'backups'));
  const hasOld = existsSync(dbPath);
  if (hasOld) {
    try {
      checkpointAlone(dbPath);
    } catch (e) {
      if (e instanceof DatabaseInUseError) throw e;
      // A damaged live DB is exactly when a restore is needed: keep it as it is (with its -wal) below.
    }
  }
  const tmp = `${dbPath}.restoring-${process.pid}`;
  const SIDECARS = ['-wal', '-shm'] as const;
  const removeTmp = () => {
    for (const s of ['', ...SIDECARS]) rmSync(tmp + s, { force: true });
  };
  removeTmp();
  let epoch: string;
  let reapplied: ReapplyResult;
  try {
    if (file.endsWith('.gz')) await pipeline(createReadStream(file), createGunzip(), createWriteStream(tmp, { mode: 0o600 }));
    else await pipeline(createReadStream(file), createWriteStream(tmp, { mode: 0o600 }));
    const db = openDb(tmp);
    try {
      const ic = db.all<{ integrity_check: string }>('PRAGMA integrity_check');
      if (ic.length !== 1 || ic[0]!.integrity_check !== 'ok') {
        throw new Error(`the backup fails integrity_check: ${ic.map((r) => r.integrity_check).slice(0, 3).join('; ')}`);
      }
      await migrate(db, { clock });
      reapplied = reapplyDeletions(db, logPath);
      epoch = setNewEpoch(db);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  } catch (e) {
    removeTmp();
    throw e;
  }
  let keptOld: string | null = null;
  if (hasOld && existsSync(dbPath)) {
    keptOld = `${dbPath}.pre-restore-${clock.now()}`;
    renameSync(dbPath, keptOld);
    for (const s of SIDECARS) if (existsSync(dbPath + s)) renameSync(dbPath + s, keptOld + s);
  }
  for (const s of SIDECARS) rmSync(dbPath + s, { force: true });
  renameSync(tmp, dbPath);
  for (const s of SIDECARS) if (existsSync(tmp + s)) renameSync(tmp + s, dbPath + s);
  return { epoch: epoch!, keptOld: keptOld ? basename(keptOld) : null, reapplied: reapplied! };
}
