// db/accounts.ts — accounts table and the account-deletion transaction body.
import { randomId } from '../ids.js';
import { detachProfilesFromMatches } from './versus.js';
import type { DB } from './sqlite.js';

export interface AccountRow {
  id: string;
  google_sub: string;
  email: string | null;
  created_at: number;
  last_seen_at: number;
}

export function getAccount(db: DB, id: string): AccountRow | undefined {
  return db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', id);
}

/** Upsert by Google `sub`. `email` is only passed when Google says it is verified. */
export function upsertAccount(db: DB, sub: string, verifiedEmail: string | null, now: number): { account: AccountRow; isNew: boolean } {
  const existing = db.get<AccountRow>('SELECT * FROM accounts WHERE google_sub = ?', sub);
  if (existing) {
    if (verifiedEmail !== null) db.run('UPDATE accounts SET email = ?, last_seen_at = ? WHERE id = ?', verifiedEmail, now, existing.id);
    else db.run('UPDATE accounts SET last_seen_at = ? WHERE id = ?', now, existing.id);
    return { account: getAccount(db, existing.id)!, isNew: false };
  }
  const id = randomId();
  db.run('INSERT INTO accounts (id, google_sub, email, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', id, sub, verifiedEmail, now, now);
  return { account: getAccount(db, id)!, isNew: true };
}

/**
 * Delete everything of one account (api #7), inside the caller's transaction:
 * seats → "Player left", matches without any remaining seat deleted, sessions, profiles
 * (cascade: saves, revisions, stashes) and the account row. secure_delete=ON zeroes the pages.
 */
export function deleteAccountData(db: DB, accountId: string): void {
  const pids = db.all<{ id: string }>('SELECT id FROM profiles WHERE account_id = ?', accountId).map((r) => r.id);
  detachProfilesFromMatches(db, pids, accountId);
  db.run('DELETE FROM sessions WHERE account_id = ?', accountId);
  db.run('DELETE FROM profiles WHERE account_id = ?', accountId);
  db.run('DELETE FROM accounts WHERE id = ?', accountId);
}
