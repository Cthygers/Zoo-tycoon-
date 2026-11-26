// db/saves.ts — the save head + lease per profile (slot 'main'), revisions, retention and stashes.
import type { LeaseConflictDetails, LeaseInfo, PushedRef, SaveHead, SaveMeta, SaveRef, SaveSummary } from '../../../shared/api-types.js';
import { DAY_MS } from '../clock.js';
import type { DB } from './sqlite.js';

export const PIN_MS = 30 * DAY_MS;
export const REVISION_ROWS_MS = 30 * DAY_MS;
export const KEEP_BLOBS = 10;

export interface SaveRow {
  id: number;
  profile_id: string;
  head_rev: number;
  head_epoch: string | null;
  updated_at: number;
  lease_device_id: string | null;
  lease_device_name: string | null;
  lease_until: number | null;
  lease_seen_at: number | null;
}

export interface RevisionRow {
  save_id: number;
  epoch: string;
  rev: number;
  push_id: string;
  device_id: string;
  device_name: string;
  app_version: string;
  save_version: number;
  meta: string;
  client_saved_at: number | null;
  size_raw: number;
  size_gz: number;
  sha256: string;
  pinned_until: number | null;
  created_at: number;
}

const REV_COLS = `save_id, epoch, rev, push_id, device_id, device_name, app_version, save_version, meta,
  client_saved_at, size_raw, size_gz, sha256, pinned_until, created_at`;

export function getSave(db: DB, pid: string): SaveRow | undefined {
  return db.get<SaveRow>('SELECT * FROM saves WHERE profile_id = ?', pid);
}

export function ensureSave(db: DB, pid: string, now: number): SaveRow {
  db.run('INSERT OR IGNORE INTO saves (profile_id, head_rev, head_epoch, updated_at) VALUES (?, 0, NULL, ?)', pid, now);
  return getSave(db, pid)!;
}

export function headRow(db: DB, save: SaveRow | undefined): RevisionRow | undefined {
  if (!save || save.head_rev === 0 || save.head_epoch === null) return undefined;
  return db.get<RevisionRow>(`SELECT ${REV_COLS} FROM save_revisions WHERE save_id = ? AND epoch = ? AND rev = ?`, save.id, save.head_epoch, save.head_rev);
}

export function parseMeta(s: string): SaveMeta {
  return JSON.parse(s) as SaveMeta;
}

export function toHead(r: RevisionRow): SaveHead {
  return {
    epoch: r.epoch,
    rev: r.rev,
    sha256: r.sha256,
    sizeGz: r.size_gz,
    sizeRaw: r.size_raw,
    saveVersion: r.save_version,
    appVersion: r.app_version,
    meta: parseMeta(r.meta),
    device: { id: r.device_id, name: r.device_name },
    savedAt: r.created_at,
    clientSavedAt: r.client_saved_at,
    pushId: r.push_id,
  };
}

export function currentHead(db: DB, save: SaveRow | undefined): SaveHead | null {
  const r = headRow(db, save);
  return r ? toHead(r) : null;
}

export function leaseLive(save: SaveRow | undefined, now: number): boolean {
  return !!save && save.lease_device_id !== null && save.lease_until !== null && save.lease_until > now;
}

export function leaseInfo(save: SaveRow | undefined, now: number, deviceId: string): LeaseInfo | null {
  if (!save || !leaseLive(save, now)) return null;
  return { deviceName: save.lease_device_name ?? 'Another device', until: save.lease_until!, mine: save.lease_device_id === deviceId };
}

export function leaseConflict(db: DB, save: SaveRow): LeaseConflictDetails {
  return {
    holder: { deviceName: save.lease_device_name ?? 'Another device', lastSeenAt: save.lease_seen_at ?? save.updated_at },
    head: currentHead(db, save),
  };
}

export function saveSummary(db: DB, pid: string, deviceId: string, now: number): SaveSummary | null {
  const save = getSave(db, pid);
  const r = headRow(db, save);
  if (!save || !r) return null;
  return {
    epoch: r.epoch,
    rev: r.rev,
    meta: parseMeta(r.meta),
    savedAt: r.created_at,
    deviceName: r.device_name,
    lease: leaseInfo(save, now, deviceId),
  };
}

export function headBlob(db: DB, save: SaveRow): Uint8Array | null {
  const r = db.get<{ blob: Uint8Array | null }>('SELECT blob FROM save_revisions WHERE save_id = ? AND epoch = ? AND rev = ?', save.id, save.head_epoch, save.head_rev);
  return r?.blob ?? null;
}

/** Newest revision whose push_id is one of `pushIds` (rows are kept 30 days), or null. */
export function pushedLookup(db: DB, saveId: number, pushIds: string[]): PushedRef | null {
  let best: { epoch: string; rev: number; push_id: string; created_at: number } | undefined;
  for (const id of pushIds) {
    const r = db.get<{ epoch: string; rev: number; push_id: string; created_at: number }>(
      'SELECT epoch, rev, push_id, created_at FROM save_revisions WHERE save_id = ? AND push_id = ? ORDER BY rev DESC, created_at DESC LIMIT 1',
      saveId, id,
    );
    if (r && (!best || r.rev > best.rev || (r.rev === best.rev && r.created_at > best.created_at))) best = r;
  }
  return best ? { epoch: best.epoch, rev: best.rev, pushId: best.push_id } : null;
}

export function revisionByPushId(db: DB, saveId: number, pushId: string): RevisionRow | undefined {
  return db.get<RevisionRow>(`SELECT ${REV_COLS} FROM save_revisions WHERE save_id = ? AND push_id = ? ORDER BY rev DESC LIMIT 1`, saveId, pushId);
}

export function sameRef(a: SaveRef | null, b: SaveRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.epoch === b.epoch && a.rev === b.rev;
}

/** Sum of stored save blob bytes (revisions + stashes) over every profile of the account: MAX_ACCOUNT_BYTES. */
export function accountBlobBytes(db: DB, accountId: string): number {
  const r = db.get<{ n: number }>(
    `SELECT
       COALESCE((SELECT SUM(LENGTH(r.blob)) FROM save_revisions r JOIN saves s ON s.id = r.save_id
                 JOIN profiles p ON p.id = s.profile_id WHERE p.account_id = ? AND r.blob IS NOT NULL), 0)
     + COALESCE((SELECT SUM(LENGTH(t.blob)) FROM save_stash t JOIN saves s ON s.id = t.save_id
                 JOIN profiles p ON p.id = s.profile_id WHERE p.account_id = ?), 0) AS n`,
    accountId, accountId,
  );
  return Number(r?.n ?? 0);
}

/** Bytes of Versus final saves (kept 30 days for review) stored for the account's seats. */
export function accountFinalSaveBytes(db: DB, accountId: string): number {
  const r = db.get<{ n: number }>(
    `SELECT COALESCE(SUM(LENGTH(final_save)), 0) AS n FROM match_seats
     WHERE profile_id IN (SELECT id FROM profiles WHERE account_id = ?) AND final_save IS NOT NULL`,
    accountId,
  );
  return Number(r?.n ?? 0);
}

export interface NewRevision {
  epoch: string;
  rev: number;
  pushId: string;
  deviceId: string;
  deviceName: string;
  appVersion: string;
  saveVersion: number;
  meta: SaveMeta;
  clientSavedAt: number | null;
  sizeRaw: number;
  sizeGz: number;
  sha256: string;
  blob: Uint8Array;
  pinnedUntil: number | null;
}

export function insertRevision(db: DB, save: SaveRow, r: NewRevision, now: number): void {
  db.run(
    `INSERT INTO save_revisions (save_id, epoch, rev, push_id, device_id, device_name, app_version, save_version, meta,
       client_saved_at, size_raw, size_gz, sha256, blob, pinned_until, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    save.id, r.epoch, r.rev, r.pushId, r.deviceId, r.deviceName, r.appVersion, r.saveVersion, JSON.stringify(r.meta),
    r.clientSavedAt, r.sizeRaw, r.sizeGz, r.sha256, r.blob, r.pinnedUntil, now,
  );
  db.run('UPDATE saves SET head_rev = ?, head_epoch = ?, updated_at = ? WHERE id = ?', r.rev, r.epoch, now, save.id);
}

export function pinRevision(db: DB, saveId: number, ref: SaveRef, until: number): void {
  db.run(
    'UPDATE save_revisions SET pinned_until = MAX(COALESCE(pinned_until, 0), ?) WHERE save_id = ? AND epoch = ? AND rev = ?',
    until, saveId, ref.epoch, ref.rev,
  );
}

/**
 * Retention for one save: blobs only for the newest 10 revisions, pinned ones and the head;
 * rows older than 30 days go unless pinned, head or among the newest 10.
 */
export function applyRetention(db: DB, saveId: number, now: number): void {
  const save = db.get<SaveRow>('SELECT * FROM saves WHERE id = ?', saveId);
  if (!save) return;
  const headEpoch = save.head_epoch ?? '';
  const headRev = save.head_rev;
  const newest = `SELECT rowid FROM save_revisions WHERE save_id = ? ORDER BY rev DESC, created_at DESC LIMIT ${KEEP_BLOBS}`;
  db.run(
    `UPDATE save_revisions SET blob = NULL
     WHERE save_id = ? AND blob IS NOT NULL
       AND (pinned_until IS NULL OR pinned_until <= ?)
       AND NOT (epoch = ? AND rev = ?)
       AND rowid NOT IN (${newest})`,
    saveId, now, headEpoch, headRev, saveId,
  );
  db.run(
    `DELETE FROM save_revisions
     WHERE save_id = ? AND created_at < ?
       AND (pinned_until IS NULL OR pinned_until <= ?)
       AND NOT (epoch = ? AND rev = ?)
       AND rowid NOT IN (${newest})`,
    saveId, now - REVISION_ROWS_MS, now, headEpoch, headRev, saveId,
  );
}

export interface StashRow {
  stash_id: string;
  save_id: number;
  pinned_until: number;
}

export function getStash(db: DB, stashId: string): StashRow | undefined {
  return db.get<StashRow>('SELECT stash_id, save_id, pinned_until FROM save_stash WHERE stash_id = ?', stashId);
}

export function insertStash(
  db: DB,
  saveId: number,
  s: { stashId: string; reason: string; deviceName: string; saveVersion: number; meta: SaveMeta; clientSavedAt: number | null; sizeRaw: number; sizeGz: number; sha256: string; blob: Uint8Array },
  now: number,
): number {
  const pinnedUntil = now + PIN_MS;
  db.run(
    `INSERT INTO save_stash (stash_id, save_id, reason, device_name, save_version, meta, client_saved_at, size_raw, size_gz, sha256, blob, pinned_until, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.stashId, saveId, s.reason, s.deviceName, s.saveVersion, JSON.stringify(s.meta), s.clientSavedAt, s.sizeRaw, s.sizeGz, s.sha256, s.blob, pinnedUntil, now,
  );
  return pinnedUntil;
}
