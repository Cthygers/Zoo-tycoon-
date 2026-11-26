// db/sessions.ts — session rows (opaque whs_ token, sha256 at rest).
import type { DeviceInfo } from '../../../shared/api-types.js';
import { DAY_MS } from '../clock.js';
import { newSessionToken, randomId, sha256 } from '../ids.js';
import type { DB } from './sqlite.js';

export const SLIDING_MS = 180 * DAY_MS;
export const ABSOLUTE_MS = 730 * DAY_MS;
export const TOUCH_EVERY_MS = DAY_MS;

export interface SessionRow {
  id: string;
  account_id: string;
  token_hash: Uint8Array;
  device_id: string;
  device_name: string;
  platform: string;
  app_version: string;
  created_at: number;
  last_touched_at: number;
  expires_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
}

export function createSession(db: DB, accountId: string, device: DeviceInfo, now: number): { token: string; session: SessionRow } {
  const token = newSessionToken();
  const id = randomId();
  db.run(
    `INSERT INTO sessions (id, account_id, token_hash, device_id, device_name, platform, app_version,
       created_at, last_touched_at, expires_at, absolute_expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    id, accountId, sha256(token), device.id, device.name, device.platform, device.appVersion,
    now, now, now + SLIDING_MS, now + ABSOLUTE_MS,
  );
  return { token, session: db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id)! };
}

export function sessionByToken(db: DB, token: string): SessionRow | undefined {
  return db.get<SessionRow>('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
}

export function isSessionLive(s: SessionRow, now: number): boolean {
  return s.revoked_at === null && s.expires_at > now && s.absolute_expires_at > now;
}

/** Sliding expiry, touched at most once per 24 h. */
export function touchSession(db: DB, s: SessionRow, now: number): void {
  if (s.last_touched_at >= now - TOUCH_EVERY_MS) return;
  const exp = Math.min(now + SLIDING_MS, s.absolute_expires_at);
  db.run('UPDATE sessions SET expires_at = ?, last_touched_at = ? WHERE id = ?', exp, now, s.id);
  db.run('UPDATE accounts SET last_seen_at = ? WHERE id = ?', now, s.account_id);
}

export function revokeSession(db: DB, id: string, now: number): void {
  db.run('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', now, id);
}
