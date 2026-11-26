// db/versus.ts — matches, seats and snapshots; lazy finalisation; the seat-based DTO serializer (P1).
// The serializer below is the ONLY place that turns match rows into JSON. It never emits a profile id,
// account id, email or device name of the other seat.
import type {
  Avatar,
  EndReason,
  MatchDto,
  MatchKind,
  MatchResultDto,
  MatchStatus,
  OpponentProgressDto,
  SeatDto,
  SeatState,
  SeriesRow,
  VersusLength,
  VersusParts,
  VersusSnapshot,
} from '../../../shared/api-types.js';
import { LIVE_WINDOW_MS, VERSUS_START_MINUTE, decideOutcome, hoursTotal, type LengthSpec, type SeatOutcomeInput } from '../../../shared/versus-rules.js';
import type { DB } from './sqlite.js';

export interface MatchRow {
  id: string;
  kind: MatchKind;
  code: string | null;
  length_min: number;
  days: number;
  seed: number;
  rules_version: number;
  start_money: number;
  budget_min: number;
  status: MatchStatus;
  created_at: number;
  code_expires_at: number | null;
  joined_at: number | null;
  finish_by: number | null;
  invited_profile_id: string | null;
  finished_at: number | null;
  result: string | null;
}

export interface SeatRow {
  match_id: string;
  seat: 0 | 1;
  profile_id: string | null;
  account_id: string | null;
  name: string;
  avatar: string;
  joined_at: number;
  device_id: string | null;
  device_name: string | null;
  first_snapshot_at: number | null;
  ack_hour: number;
  last_total: number;
  last_parts: string | null;
  last_post_at: number | null;
  done_at: number | null;
  end_hour: number | null;
  end_reason: EndReason | null;
  flags: string;
  app_version: string | null;
}

/** Every seat column except the final_save blob. */
const SEAT_COLS = `match_id, seat, profile_id, account_id, name, avatar, joined_at, device_id, device_name, first_snapshot_at,
  ack_hour, last_total, last_parts, last_post_at, done_at, end_hour, end_reason, flags, app_version`;

export const PLAYER_LEFT = 'Player left';

export function getMatch(db: DB, id: string): MatchRow | undefined {
  return db.get<MatchRow>('SELECT * FROM matches WHERE id = ?', id);
}

export function matchByCode(db: DB, code: string): MatchRow | undefined {
  return db.get<MatchRow>('SELECT * FROM matches WHERE code = ?', code);
}

export function codeInUse(db: DB, code: string): boolean {
  return !!db.get('SELECT 1 AS x FROM matches WHERE code = ?', code);
}

export function getSeats(db: DB, matchId: string): SeatRow[] {
  return db.all<SeatRow>(`SELECT ${SEAT_COLS} FROM match_seats WHERE match_id = ? ORDER BY seat`, matchId);
}

export function seatOf(seats: SeatRow[], pid: string): SeatRow | undefined {
  return seats.find((s) => s.profile_id === pid);
}

export function parseParts(s: string | null): VersusParts | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as VersusParts;
  } catch {
    return null;
  }
}

function parseAvatar(s: string): Avatar {
  try {
    const a = JSON.parse(s) as Avatar;
    return { animal: a.animal, color: a.color };
  } catch {
    return { animal: 'lion', color: 0 };
  }
}

export function parseFlags(s: string): string[] {
  try {
    const a = JSON.parse(s) as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function addFlags(db: DB, matchId: string, seat: number, add: string[]): void {
  if (add.length === 0) return;
  const r = db.get<{ flags: string }>('SELECT flags FROM match_seats WHERE match_id = ? AND seat = ?', matchId, seat);
  const set = new Set(parseFlags(r?.flags ?? '[]'));
  const before = set.size;
  for (const f of add) set.add(f);
  if (set.size !== before) db.run('UPDATE match_seats SET flags = ? WHERE match_id = ? AND seat = ?', JSON.stringify([...set]), matchId, seat);
}

/** Family for anti-cheat: a family match, or both seats on one account. */
export function isFamily(m: MatchRow, seats: SeatRow[]): boolean {
  if (m.kind === 'family') return true;
  const [a, b] = [seats[0], seats[1]];
  return !!a && !!b && a.account_id !== null && a.account_id === b.account_id;
}

/** Stored snapshot at exactly hour h (only the fields checkSnapshotStep reads), or null. */
export function storedSnapshot(db: DB, matchId: string, seat: number, h: number): VersusSnapshot | null {
  if (h <= 0) return null;
  const r = db.get<{ h: number; total: number; parts: string; extra: string }>(
    'SELECT h, total, parts, extra FROM match_snapshots WHERE match_id = ? AND seat = ? AND h = ?', matchId, seat, h,
  );
  if (!r) return null;
  const extra = JSON.parse(r.extra) as Omit<VersusSnapshot, 'h' | 'parts' | 'total'>;
  return { ...extra, h: r.h, total: r.total, parts: JSON.parse(r.parts) as VersusParts };
}

export function insertSnapshot(db: DB, matchId: string, seat: number, s: VersusSnapshot, now: number): void {
  const { h, total, parts, ...rest } = s;
  const extra = {
    day: rest.day, min: rest.min, run: rest.run, cash: rest.cash, guests: rest.guests, visitors: rest.visitors,
    animals: rest.animals, species: rest.species, habitats: rest.habitats, stars: rest.stars,
  };
  const p = { v: parts.v, a: parts.a, s: parts.s, b: parts.b, m: parts.m, l: parts.l };
  db.run(
    'INSERT OR IGNORE INTO match_snapshots (match_id, seat, h, total, parts, extra, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    matchId, seat, h, Math.round(total), JSON.stringify(p), JSON.stringify(extra), now,
  );
}

export function updateSeatProgress(db: DB, matchId: string, seat: number, s: VersusSnapshot, now: number): void {
  const p = { v: s.parts.v, a: s.parts.a, s: s.parts.s, b: s.parts.b, m: s.parts.m, l: s.parts.l };
  db.run(
    'UPDATE match_seats SET ack_hour = ?, last_total = ?, last_parts = ?, last_post_at = ? WHERE match_id = ? AND seat = ?',
    s.h, Math.round(s.total), JSON.stringify(p), now, matchId, seat,
  );
}

export function touchSeat(db: DB, matchId: string, seat: number, now: number): void {
  db.run('UPDATE match_seats SET last_post_at = ? WHERE match_id = ? AND seat = ?', now, matchId, seat);
}

export function bindSeatDevice(db: DB, matchId: string, seat: number, deviceId: string, deviceName: string, now: number): void {
  db.run(
    'UPDATE match_seats SET device_id = ?, device_name = ?, first_snapshot_at = COALESCE(first_snapshot_at, ?) WHERE match_id = ? AND seat = ?',
    deviceId, deviceName, now, matchId, seat,
  );
}

/** Opponent rows h > since, as SeriesRow tuples. */
export function seriesRows(db: DB, matchId: string, seat: number, since: number): SeriesRow[] {
  const rows = db.all<{ h: number; total: number; parts: string }>(
    'SELECT h, total, parts FROM match_snapshots WHERE match_id = ? AND seat = ? AND h > ? ORDER BY h',
    matchId, seat, since,
  );
  return rows.map((r) => {
    const p = JSON.parse(r.parts) as VersusParts;
    return [r.h, r.total, p.v, p.a, p.s, p.b, p.m, p.l] as SeriesRow;
  });
}

// ------------------------------------------------------------------ counts for limits
export function countOpenCoded(db: DB, pid: string): number {
  return Number(db.get<{ n: number }>(
    "SELECT count(*) AS n FROM matches m JOIN match_seats s ON s.match_id = m.id AND s.seat = 0 WHERE s.profile_id = ? AND m.status = 'open' AND m.kind = 'coded'",
    pid,
  )?.n ?? 0);
}

export function countActive(db: DB, pid: string): number {
  return Number(db.get<{ n: number }>(
    "SELECT count(*) AS n FROM matches m JOIN match_seats s ON s.match_id = m.id WHERE s.profile_id = ? AND m.status = 'active'",
    pid,
  )?.n ?? 0);
}

/** Matches this profile created (seat 0) since `since`, oldest first (for the 10/day limit). */
export function createdSince(db: DB, pid: string, since: number): number[] {
  return db.all<{ created_at: number }>(
    'SELECT m.created_at FROM matches m JOIN match_seats s ON s.match_id = m.id AND s.seat = 0 WHERE s.profile_id = ? AND m.created_at > ? ORDER BY m.created_at',
    pid, since,
  ).map((r) => r.created_at);
}

/**
 * Matches created (seat 0) since `since` by any profile of the account, removed ones included, oldest first:
 * the per-account daily limit, so deleting and re-creating profiles does not multiply the per-profile one.
 */
export function createdSinceByAccount(db: DB, accountId: string, since: number): number[] {
  return db.all<{ created_at: number }>(
    `SELECT m.created_at FROM matches m JOIN match_seats s ON s.match_id = m.id AND s.seat = 0
     WHERE s.profile_id IN (SELECT id FROM profiles WHERE account_id = ?) AND m.created_at > ? ORDER BY m.created_at`,
    accountId, since,
  ).map((r) => r.created_at);
}

// ------------------------------------------------------------------ create / join
export interface NewSeat {
  seat: 0 | 1;
  profileId: string;
  accountId: string;
  name: string;
  avatar: Avatar;
  joinedAt: number;
  appVersion: string | null;
}

export interface NewMatch {
  id: string;
  kind: MatchKind;
  code: string | null;
  spec: LengthSpec;
  seed: number;
  rulesVersion: number;
  status: MatchStatus;
  createdAt: number;
  codeExpiresAt: number | null;
  joinedAt: number | null;
  finishBy: number | null;
  invitedProfileId: string | null;
  seats: NewSeat[];
}

export function insertMatch(db: DB, m: NewMatch): void {
  db.run(
    `INSERT INTO matches (id, kind, code, length_min, days, seed, rules_version, start_money, budget_min, status,
       created_at, code_expires_at, joined_at, finish_by, invited_profile_id, finished_at, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    m.id, m.kind, m.code, m.spec.lengthMin, m.spec.days, m.seed, m.rulesVersion, m.spec.startMoney, m.spec.budgetMin, m.status,
    m.createdAt, m.codeExpiresAt, m.joinedAt, m.finishBy, m.invitedProfileId,
  );
  for (const s of m.seats) insertSeat(db, m.id, s);
}

export function insertSeat(db: DB, matchId: string, s: NewSeat): void {
  db.run(
    `INSERT INTO match_seats (match_id, seat, profile_id, account_id, name, avatar, joined_at, app_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    matchId, s.seat, s.profileId, s.accountId, s.name, JSON.stringify({ animal: s.avatar.animal, color: s.avatar.color }), s.joinedAt, s.appVersion,
  );
}

// ------------------------------------------------------------------ lazy finalisation
/** Apply decideOutcome (api §5) / code expiry. Must run inside a transaction. Returns the fresh row. */
export function finalizeMatch(db: DB, m: MatchRow, now: number): MatchRow {
  if (m.status === 'open') {
    if (m.code_expires_at !== null && now > m.code_expires_at) {
      const s0 = db.get<{ last_total: number }>('SELECT last_total FROM match_seats WHERE match_id = ? AND seat = 0', m.id);
      const result: MatchResultDto = { kind: 'none', winnerSeat: null, reason: 'expired', comparedAtHour: null, totals: [s0?.last_total ?? 0, 0], decidedAt: now };
      db.run("UPDATE matches SET status = 'expired', finished_at = ?, result = ? WHERE id = ? AND status = 'open'", now, JSON.stringify(result), m.id);
      return getMatch(db, m.id)!;
    }
    return m;
  }
  if (m.status !== 'active') return m;
  const seats = getSeats(db, m.id);
  if (seats.length < 2) return m;
  const totals = new Map<string, number>();
  for (const r of db.all<{ seat: number; h: number; total: number }>('SELECT seat, h, total FROM match_snapshots WHERE match_id = ?', m.id)) {
    totals.set(`${r.seat}:${r.h}`, r.total);
  }
  const input = (s: SeatRow): SeatOutcomeInput => ({
    forfeited: s.end_reason === 'forfeit',
    done: s.done_at !== null,
    endHour: s.done_at !== null ? (s.end_hour ?? s.ack_hour) : s.ack_hour,
    totalAt: (h: number) => totals.get(`${s.seat}:${h}`) ?? null,
    lastTotal: s.last_total,
  });
  const core = decideOutcome({ hoursTotal: hoursTotal(m.days), now, finishBy: m.finish_by, seats: [input(seats[0]!), input(seats[1]!)] });
  if (core === 'pending') return m;
  if (m.finish_by !== null && now > m.finish_by) {
    db.run(
      "UPDATE match_seats SET done_at = ?, end_hour = ack_hour, end_reason = 'deadline' WHERE match_id = ? AND done_at IS NULL",
      m.finish_by, m.id,
    );
  }
  const result: MatchResultDto = { ...core, decidedAt: now };
  db.run("UPDATE matches SET status = 'finished', finished_at = ?, result = ? WHERE id = ? AND status = 'active'", now, JSON.stringify(result), m.id);
  return getMatch(db, m.id)!;
}

// ------------------------------------------------------------------ DTOs (seat-based, P1)
export interface Viewer {
  profileId: string;
  deviceId: string;
}

function seatState(s: SeatRow): SeatState {
  if (s.profile_id === null) return 'left';
  if (s.done_at !== null) return 'done';
  if (s.first_snapshot_at !== null || s.ack_hour > 0) return 'playing';
  return 'joined';
}

function seatDto(s: SeatRow, mySeat: 0 | 1, viewer: Viewer, now: number): SeatDto {
  const isMe = s.seat === mySeat;
  return {
    seat: s.seat,
    role: s.seat === 0 ? 'challenger' : 'opponent',
    name: s.name,
    avatar: parseAvatar(s.avatar),
    isMe,
    state: seatState(s),
    lastHour: s.ack_hour,
    total: s.last_total,
    parts: parseParts(s.last_parts),
    live: s.last_post_at !== null && now - s.last_post_at <= LIVE_WINDOW_MS,
    doneAt: s.done_at,
    endHour: s.end_hour,
    endReason: s.end_reason,
    device: isMe && s.device_name !== null ? { name: s.device_name, here: s.device_id === viewer.deviceId } : null,
  };
}

/** Seat the viewer's profile sits in (or is invited to), or null when it has nothing to do with the match. */
export function viewerSeat(m: MatchRow, seats: SeatRow[], profileId: string): 0 | 1 | null {
  const s = seatOf(seats, profileId);
  if (s) return s.seat;
  // A rematch invitation (seat 1 not taken yet) stays visible to the invited profile in every status.
  if (m.invited_profile_id === profileId && !seats.some((x) => x.seat === 1)) return 1;
  return null;
}

export function matchDto(db: DB, m: MatchRow, viewer: Viewer, now: number, seatsIn?: SeatRow[]): MatchDto {
  const seats = seatsIn ?? getSeats(db, m.id);
  const mySeat = viewerSeat(m, seats, viewer.profileId);
  if (mySeat === null) throw new Error('matchDto: viewer has no seat');
  const players: SeatDto[] = seats.map((s) => seatDto(s, mySeat, viewer, now));
  if (m.invited_profile_id !== null && !seats.some((s) => s.seat === 1)) {
    const p = db.get<{ name: string; avatar: string; deleted_at: number | null }>('SELECT name, avatar, deleted_at FROM profiles WHERE id = ?', m.invited_profile_id);
    players.push({
      seat: 1,
      role: 'opponent',
      name: p && p.deleted_at === null ? p.name : 'Player',
      avatar: p ? parseAvatar(p.avatar) : { animal: 'lion', color: 0 },
      isMe: mySeat === 1,
      state: 'invited',
      lastHour: 0,
      total: 0,
      parts: null,
      live: false,
      doneAt: null,
      endHour: null,
      endReason: null,
      device: null,
    });
  }
  return {
    id: m.id,
    kind: m.kind,
    code: m.kind === 'coded' && m.status === 'open' && mySeat === 0 ? m.code : null,
    lengthMin: m.length_min as VersusLength,
    days: m.days,
    seed: m.seed,
    rulesVersion: m.rules_version,
    startMoney: m.start_money,
    startMinute: VERSUS_START_MINUTE,
    budgetMin: m.budget_min,
    status: m.status,
    createdAt: m.created_at,
    codeExpiresAt: m.code_expires_at,
    joinedAt: m.joined_at,
    finishBy: m.finish_by,
    mySeat,
    players,
    result: m.result ? (JSON.parse(m.result) as MatchResultDto) : null,
  };
}

export function opponentProgress(db: DB, m: MatchRow, seats: SeatRow[], mySeat: 0 | 1, now: number): OpponentProgressDto | null {
  const opp = seats.find((s) => s.seat !== mySeat);
  const me = seats.find((s) => s.seat === mySeat);
  if (!opp || !me) return null;
  let atMyHour: number | null = null;
  if (opp.ack_hour >= me.ack_hour) {
    const r = db.get<{ total: number }>(
      'SELECT total FROM match_snapshots WHERE match_id = ? AND seat = ? AND h <= ? ORDER BY h DESC LIMIT 1',
      m.id, opp.seat, me.ack_hour,
    );
    atMyHour = r ? r.total : null;
  }
  return {
    lastHour: opp.ack_hour,
    total: opp.last_total,
    parts: parseParts(opp.last_parts),
    live: opp.last_post_at !== null && now - opp.last_post_at <= LIVE_WINDOW_MS,
    done: opp.done_at !== null,
    atMyHour,
  };
}

// ------------------------------------------------------------------ lists
export function matchIdsForProfile(db: DB, pid: string, statuses: MatchStatus[] | null, limit: number): string[] {
  const where = statuses ? `AND m.status IN (${statuses.map(() => '?').join(',')})` : '';
  return db.all<{ id: string }>(
    `SELECT m.id FROM matches m
     WHERE (EXISTS (SELECT 1 FROM match_seats s WHERE s.match_id = m.id AND s.profile_id = ?)
            OR (m.invited_profile_id = ? AND m.status = 'open'))
       ${where}
     ORDER BY m.created_at DESC, m.id DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
    pid, pid, ...(statuses ?? []),
  ).map((r) => r.id);
}

/** Matches still open/active whose deadlines may have passed (housekeeping finalises them). */
export function unsettledMatchIds(db: DB, now: number): string[] {
  return db.all<{ id: string }>(
    "SELECT id FROM matches WHERE (status = 'open' AND code_expires_at < ?) OR (status = 'active' AND finish_by < ?)",
    now, now,
  ).map((r) => r.id);
}

// ------------------------------------------------------------------ leaving
/**
 * Seats of these profiles (and, when given, of this account) become "Player left": no profile, no account,
 * no device, no final save. Rematch invitations to them are dropped; matches with no remaining seat are deleted.
 */
export function detachProfilesFromMatches(db: DB, pids: string[], accountId: string | null): void {
  const clear = `profile_id = NULL, account_id = NULL, name = '${PLAYER_LEFT}', final_save = NULL, device_id = NULL, device_name = NULL`;
  for (const pid of pids) {
    db.run(`UPDATE match_seats SET ${clear} WHERE profile_id = ?`, pid);
    db.run('UPDATE matches SET invited_profile_id = NULL WHERE invited_profile_id = ?', pid);
  }
  if (accountId !== null) db.run(`UPDATE match_seats SET ${clear} WHERE account_id = ?`, accountId);
  db.run('DELETE FROM matches WHERE NOT EXISTS (SELECT 1 FROM match_seats s WHERE s.match_id = matches.id AND s.profile_id IS NOT NULL)');
}
