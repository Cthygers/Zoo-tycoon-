// auth/sessions.ts — Bearer token → req.auth (api #5 "Session check on every Bearer route").
import type { DB } from '../db/sqlite.js';
import { isSessionLive, sessionByToken, touchSession } from '../db/sessions.js';
import { ApiError } from '../errors.js';
import { SESSION_TOKEN_RE } from '../ids.js';

export interface AuthInfo {
  accountId: string;
  sessionId: string;
  deviceId: string;
  deviceName: string;
  appVersion: string;
}

export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m || !SESSION_TOKEN_RE.test(m[1]!)) return null;
  return m[1]!;
}

export function authenticate(db: DB, header: string | undefined, now: number): AuthInfo {
  const token = bearerToken(header);
  if (!token) throw new ApiError('unauthorized', 401);
  const s = sessionByToken(db, token);
  if (!s || !isSessionLive(s, now)) throw new ApiError('unauthorized', 401);
  touchSession(db, s, now);
  return { accountId: s.account_id, sessionId: s.id, deviceId: s.device_id, deviceName: s.device_name, appVersion: s.app_version };
}
