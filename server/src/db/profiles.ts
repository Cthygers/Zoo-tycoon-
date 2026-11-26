// db/profiles.ts — profiles (players) of an account, soft delete and purge.
import type { Avatar, ProfileDto, ProfilePrefs, RemovedProfileDto } from '../../../shared/api-types.js';
import { DAY_MS } from '../clock.js';
import { SOFT_DELETE_DAYS } from '../../../shared/limits.js';
import { randomId } from '../ids.js';
import { saveSummary } from './saves.js';
import type { DB } from './sqlite.js';
import { detachProfilesFromMatches } from './versus.js';

export const SOFT_DELETE_MS = SOFT_DELETE_DAYS * DAY_MS;

export interface ProfileRow {
  id: string;
  account_id: string;
  name: string;
  name_key: string;
  avatar: string;
  prefs: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  purge_at: number | null;
}

export function parseAvatar(s: string): Avatar {
  try {
    const a = JSON.parse(s) as Avatar;
    if (a && typeof a.animal === 'string' && typeof a.color === 'number') return { animal: a.animal, color: a.color };
  } catch {
    /* fall through */
  }
  return { animal: 'lion', color: 0 };
}

export function parsePrefs(s: string): ProfilePrefs {
  try {
    const p = JSON.parse(s) as unknown;
    if (p && typeof p === 'object' && !Array.isArray(p)) return p as ProfilePrefs;
  } catch {
    /* fall through */
  }
  return {};
}

/** The profile row if it belongs to the account (any state), else undefined. */
export function profileOfAccount(db: DB, accountId: string, pid: string): ProfileRow | undefined {
  return db.get<ProfileRow>('SELECT * FROM profiles WHERE id = ? AND account_id = ?', pid, accountId);
}

/** True when the id exists under another account (for the `idor_denied` security log). */
export function profileExistsElsewhere(db: DB, accountId: string, pid: string): boolean {
  return !!db.get('SELECT 1 AS x FROM profiles WHERE id = ? AND account_id <> ?', pid, accountId);
}

export function activeProfiles(db: DB, accountId: string): ProfileRow[] {
  return db.all<ProfileRow>('SELECT * FROM profiles WHERE account_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid', accountId);
}

export function removedProfiles(db: DB, accountId: string, now: number): ProfileRow[] {
  return db.all<ProfileRow>(
    'SELECT * FROM profiles WHERE account_id = ? AND deleted_at IS NOT NULL AND purge_at > ? ORDER BY deleted_at DESC',
    accountId, now,
  );
}

export function countActive(db: DB, accountId: string): number {
  return Number(db.get<{ n: number }>('SELECT count(*) AS n FROM profiles WHERE account_id = ? AND deleted_at IS NULL', accountId)?.n ?? 0);
}

export function nameTaken(db: DB, accountId: string, key: string, exceptId: string | null): boolean {
  return !!db.get(
    'SELECT 1 AS x FROM profiles WHERE account_id = ? AND name_key = ? AND deleted_at IS NULL AND id <> ?',
    accountId, key, exceptId ?? '',
  );
}

export function insertProfile(db: DB, accountId: string, name: string, key: string, avatar: Avatar, now: number): ProfileRow {
  const id = randomId();
  db.run(
    `INSERT INTO profiles (id, account_id, name, name_key, avatar, prefs, created_at, updated_at, deleted_at, purge_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?, NULL, NULL)`,
    id, accountId, name, key, JSON.stringify({ animal: avatar.animal, color: avatar.color }), now, now,
  );
  return db.get<ProfileRow>('SELECT * FROM profiles WHERE id = ?', id)!;
}

export function profileDto(db: DB, p: ProfileRow, deviceId: string, now: number): ProfileDto {
  return {
    id: p.id,
    name: p.name,
    avatar: parseAvatar(p.avatar),
    prefs: parsePrefs(p.prefs),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    main: saveSummary(db, p.id, deviceId, now),
  };
}

export function removedDto(p: ProfileRow): RemovedProfileDto {
  return {
    id: p.id,
    name: p.name,
    avatar: parseAvatar(p.avatar),
    removedAt: p.deleted_at ?? 0,
    purgeAt: p.purge_at ?? 0,
  };
}

export function listForAccount(db: DB, accountId: string, deviceId: string, now: number): { profiles: ProfileDto[]; removed: RemovedProfileDto[] } {
  return {
    profiles: activeProfiles(db, accountId).map((p) => profileDto(db, p, deviceId, now)),
    removed: removedProfiles(db, accountId, now).map(removedDto),
  };
}

/** Hard delete (purge after 30 days, or account deletion): seats → "Player left", then cascade. */
export function hardDeleteProfiles(db: DB, pids: string[]): void {
  if (pids.length === 0) return;
  detachProfilesFromMatches(db, pids, null);
  for (const pid of pids) db.run('DELETE FROM profiles WHERE id = ?', pid);
}
