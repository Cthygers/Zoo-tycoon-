// db/housekeeping.ts — hourly clean-up (also at start and via `cli purge`). Not a cron (api §7).
import { DAY_MS } from '../clock.js';
import { hardDeleteProfiles } from './profiles.js';
import { applyRetention } from './saves.js';
import type { DB } from './sqlite.js';
import { finalizeMatch, getMatch, unsettledMatchIds } from './versus.js';

export interface HousekeepingResult {
  nonces: number;
  sessions: number;
  profilesPurged: number;
  revisionsTrimmed: number;
  stashes: number;
  finalSaves: number;
  matchesSettled: number;
  codesFreed: number;
  matchesDeleted: number;
}

export function runHousekeeping(db: DB, now: number): HousekeepingResult {
  return db.tx(() => {
    const out: HousekeepingResult = {
      nonces: 0, sessions: 0, profilesPurged: 0, revisionsTrimmed: 0, stashes: 0,
      finalSaves: 0, matchesSettled: 0, codesFreed: 0, matchesDeleted: 0,
    };
    out.nonces = db.run('DELETE FROM auth_nonces WHERE expires_at <= ?', now).changes;
    out.sessions = db.run(
      'DELETE FROM sessions WHERE absolute_expires_at <= ? OR expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
      now, now - 30 * DAY_MS, now - 30 * DAY_MS,
    ).changes;

    // Deadlines first, so a purged profile's seat is settled with its stored progress.
    for (const id of unsettledMatchIds(db, now)) {
      const m = getMatch(db, id);
      if (!m) continue;
      const after = finalizeMatch(db, m, now);
      if (after.status !== m.status) out.matchesSettled++;
    }

    const purge = db.all<{ id: string }>('SELECT id FROM profiles WHERE deleted_at IS NOT NULL AND purge_at <= ?', now).map((r) => r.id);
    hardDeleteProfiles(db, purge);
    out.profilesPurged = purge.length;

    const before = Number(db.get<{ n: number }>('SELECT count(*) AS n FROM save_revisions')?.n ?? 0);
    for (const s of db.all<{ id: number }>('SELECT id FROM saves')) applyRetention(db, s.id, now);
    out.revisionsTrimmed = before - Number(db.get<{ n: number }>('SELECT count(*) AS n FROM save_revisions')?.n ?? 0);

    out.stashes = db.run('DELETE FROM save_stash WHERE pinned_until <= ?', now).changes;
    out.finalSaves = db.run(
      'UPDATE match_seats SET final_save = NULL WHERE final_save IS NOT NULL AND match_id IN (SELECT id FROM matches WHERE finished_at IS NOT NULL AND finished_at < ?)',
      now - 30 * DAY_MS,
    ).changes;
    // Codes of settled matches stay answerable ("This challenge has ended") for a week, then are freed.
    out.codesFreed = db.run(
      "UPDATE matches SET code = NULL WHERE code IS NOT NULL AND status <> 'open' AND COALESCE(finished_at, code_expires_at, created_at) < ?",
      now - 7 * DAY_MS,
    ).changes;
    out.matchesDeleted = db.run(
      "DELETE FROM matches WHERE status IN ('finished','expired','cancelled') AND finished_at IS NOT NULL AND finished_at < ?",
      now - 180 * DAY_MS,
    ).changes;
    return out;
  });
}
