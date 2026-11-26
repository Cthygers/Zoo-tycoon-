// db/sqlite.ts — the one-file node:sqlite adapter: open + pragmas, a statement cache and tx().
// Node 26 names the class `Database` (DatabaseSync is a deprecated alias); Node 22/24 only have DatabaseSync.
import * as sqlite from 'node:sqlite';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

type DbCtor = new (path: string, options?: Record<string, unknown>) => DatabaseSync;
const Db: DbCtor = ((sqlite as unknown as { Database?: DbCtor }).Database ?? sqlite.DatabaseSync) as DbCtor;

export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, unknown>;

export interface DB {
  readonly path: string;
  readonly raw: DatabaseSync;
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  exec(sql: string): void;
  /** Runs fn inside BEGIN IMMEDIATE … COMMIT (ROLLBACK on throw). Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T;
  /**
   * Bytes in use: (page_count − freelist_count) × page_size. Free pages (left by deletes, retention and
   * purges; auto_vacuum is off) are reused before the file grows, so they do not count toward MAX_DB_BYTES.
   */
  sizeBytes(): number;
  close(): void;
  readonly isOpen: boolean;
}

export const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = FULL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA secure_delete = ON',
  'PRAGMA trusted_schema = OFF',
];

export function openDb(path: string): DB {
  const raw = new Db(path);
  try {
    for (const p of PRAGMAS) raw.exec(p);
  } catch (e) {
    raw.close(); // e.g. "file is not a database": do not leak the handle
    throw e;
  }
  const cache = new Map<string, StatementSync>();
  let depth = 0;
  let open = true;

  const stmt = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  const db: DB = {
    path,
    raw,
    run(sql, ...params) {
      const r = stmt(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get<T>(sql: string, ...params: SqlValue[]) {
      return stmt(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, ...params: SqlValue[]) {
      return stmt(sql).all(...params) as T[];
    },
    exec(sql) {
      raw.exec(sql);
    },
    tx<T>(fn: () => T): T {
      if (depth > 0) return fn();
      raw.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw e;
      } finally {
        depth--;
      }
    },
    sizeBytes() {
      const pc = stmt('PRAGMA page_count').get() as { page_count: number };
      const fl = stmt('PRAGMA freelist_count').get() as { freelist_count: number };
      const ps = stmt('PRAGMA page_size').get() as { page_size: number };
      return (Number(pc.page_count) - Number(fl.freelist_count)) * Number(ps.page_size);
    },
    close() {
      if (!open) return;
      open = false;
      cache.clear();
      raw.close();
    },
    get isOpen() {
      return open;
    },
  };
  return db;
}

/** Another connection (a running API) holds the database file open. */
export class DatabaseInUseError extends Error {
  constructor(path: string) {
    super(`${path} is in use: stop the API first (docker compose stop api)`);
    this.name = 'DatabaseInUseError';
  }
}

/**
 * Open `path` as the only connection (exclusive lock, no busy wait), fold its -wal into the main file and close.
 * Throws DatabaseInUseError while any other connection has the file open. Other errors (e.g. a damaged file)
 * are passed through unchanged.
 */
export function checkpointAlone(path: string): void {
  const raw = new Db(path);
  try {
    raw.exec('PRAGMA busy_timeout = 0');
    raw.exec('PRAGMA locking_mode = EXCLUSIVE');
    try {
      raw.exec('BEGIN EXCLUSIVE');
      raw.exec('COMMIT');
    } catch (e) {
      if (isBusy(e)) throw new DatabaseInUseError(path);
      throw e;
    }
    const r = raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number } | undefined;
    if (r && Number(r.busy) !== 0) throw new DatabaseInUseError(path);
  } finally {
    raw.close();
  }
}

/** SQLITE_BUSY (5) / SQLITE_LOCKED (6) from node:sqlite. */
export function isBusy(e: unknown): boolean {
  const code = (e as { errcode?: number } | null)?.errcode;
  return code === 5 || code === 6 || /database is locked|database table is locked/i.test(String((e as Error | null)?.message ?? ''));
}

/** sqlite.backup(source, path): an online, page-stepped copy (Node 22.16+/24/26). */
export async function backupTo(db: DB, destPath: string): Promise<void> {
  const fn = (sqlite as unknown as { backup?: (src: DatabaseSync, dest: string, opts?: Record<string, unknown>) => Promise<number> }).backup;
  if (typeof fn === 'function') {
    await fn(db.raw, destPath, { rate: 256 });
    return;
  }
  // Fallback for runtimes without sqlite.backup(): VACUUM INTO writes a consistent copy.
  db.raw.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
}

/** Booleans are not allowed in STRICT tables; keep the conversion in one place. */
export const toInt = (b: boolean): number => (b ? 1 : 0);
