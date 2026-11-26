// db/migrate.ts — numbered SQL files + PRAGMA user_version; pre-migration backup; refuse newer DBs.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../clock.js';
import { newEpoch } from '../ids.js';
import { migrationsDir } from '../paths.js';
import type { DB } from './sqlite.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(dir: string = migrationsDir()): Migration[] {
  const out: Migration[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^(\d{4})_[A-Za-z0-9_-]+\.sql$/.exec(f);
    if (!m) continue;
    out.push({ version: Number(m[1]), name: f, sql: readFileSync(join(dir, f), 'utf8') });
  }
  out.sort((a, b) => a.version - b.version);
  out.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations must be numbered 0001, 0002, … without gaps (found ${m.name})`);
  });
  return out;
}

export function userVersion(db: DB): number {
  const r = db.get<{ user_version: number }>('PRAGMA user_version');
  return Number(r?.user_version ?? 0);
}

export function isEmptyDb(db: DB): boolean {
  const r = db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'");
  return Number(r?.n ?? 0) === 0;
}

export interface MigrateOptions {
  clock: Clock;
  /** Called before the first pending migration when the DB is not empty (pre-migration backup). */
  backup?: (from: number, to: number) => Promise<string | void>;
  migrations?: Migration[];
  /** Stop after this version (tests build a v1 fixture). */
  target?: number;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: string[];
  backupFile: string | null;
}

export class NewerDatabaseError extends Error {
  constructor(found: number, latest: number) {
    super(`The database is at schema version ${found}, newer than this server knows (${latest}). Refusing to start: use a newer server image or restore a backup.`);
    this.name = 'NewerDatabaseError';
  }
}

export async function migrate(db: DB, opts: MigrateOptions): Promise<MigrateResult> {
  const all = opts.migrations ?? loadMigrations();
  const latest = all.length;
  const target = Math.min(opts.target ?? latest, latest);
  const from = userVersion(db);
  if (from > latest) throw new NewerDatabaseError(from, latest);
  const pending = all.filter((m) => m.version > from && m.version <= target);
  let backupFile: string | null = null;
  if (pending.length > 0 && !isEmptyDb(db) && opts.backup) {
    backupFile = (await opts.backup(from, target)) || null;
  }
  const applied: string[] = [];
  for (const m of pending) {
    db.tx(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
    applied.push(m.name);
  }
  if (target >= 1) ensureMeta(db, opts.clock);
  return { from, to: Math.max(from, target), applied, backupFile };
}

/** The meta table holds the server epoch (S4) and the creation time. */
export function ensureMeta(db: DB, clock: Clock): void {
  db.tx(() => {
    db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', ?)", newEpoch());
    db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?)", String(clock.now()));
  });
}

export function currentEpoch(db: DB): string {
  const r = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'epoch'");
  if (!r) throw new Error('meta.epoch missing (database not migrated)');
  return r.value;
}

/** Restore (cli) writes a new epoch: every new revision then carries it (api §3.4). */
export function setNewEpoch(db: DB): string {
  const e = newEpoch();
  db.tx(() => {
    db.run("INSERT INTO meta (key, value) VALUES ('epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", e);
  });
  return e;
}
