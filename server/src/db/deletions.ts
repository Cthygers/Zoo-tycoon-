// db/deletions.ts — the erasure log: account deletions and session revocations that a restore must not undo.
// One JSON line per event in <BACKUP_DIR>/deletions.log, next to the backups (so an off-site copy of the
// backups carries it too). It holds random internal ids and times only: no names, emails or tokens.
// `cli restore` re-applies every entry to the restored database before it is swapped in.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deleteAccountData } from './accounts.js';
import type { DB } from './sqlite.js';

export const DELETIONS_LOG = 'deletions.log';

export type DeletionEntry =
  | { kind: 'account'; accountId: string; at: number } // DELETE /v1/account
  | { kind: 'revoke'; accountId: string; at: number }; // cli revoke: every session created up to `at`

export function deletionLogPath(backupDir: string): string {
  return join(backupDir, DELETIONS_LOG);
}

/** Append one entry and fsync it (owner-only file). */
export function appendDeletion(logPath: string, e: DeletionEntry): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a', 0o600);
  try {
    writeSync(fd, JSON.stringify(e) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readDeletions(logPath: string): { entries: DeletionEntry[]; skipped: number } {
  if (!existsSync(logPath)) return { entries: [], skipped: 0 };
  const entries: DeletionEntry[] = [];
  let skipped = 0;
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const e = JSON.parse(line) as Partial<DeletionEntry>;
      if ((e.kind === 'account' || e.kind === 'revoke') && typeof e.accountId === 'string' && typeof e.at === 'number') {
        entries.push({ kind: e.kind, accountId: e.accountId, at: e.at });
      } else skipped++;
    } catch {
      skipped++; // e.g. a line cut short by a crash
    }
  }
  return { entries, skipped };
}

export interface ReapplyResult {
  accountsDeleted: number;
  sessionsRevoked: number;
  skipped: number;
}

/** Re-apply the log to `db` (one transaction): logged accounts that exist again are deleted, revocations redone. */
export function reapplyDeletions(db: DB, logPath: string): ReapplyResult {
  const { entries, skipped } = readDeletions(logPath);
  const out: ReapplyResult = { accountsDeleted: 0, sessionsRevoked: 0, skipped };
  if (entries.length === 0) return out;
  db.tx(() => {
    for (const e of entries) {
      if (e.kind === 'account') {
        if (db.get('SELECT 1 AS x FROM accounts WHERE id = ?', e.accountId)) {
          deleteAccountData(db, e.accountId);
          out.accountsDeleted++;
        }
      } else {
        out.sessionsRevoked += revokeAccountSessions(db, e.accountId, e.at);
      }
    }
  });
  return out;
}

/** Revoke every live session of the account created at or before `at`. Returns how many. */
export function revokeAccountSessions(db: DB, accountId: string, at: number): number {
  return db.run('UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL AND created_at <= ?', at, accountId, at).changes;
}
