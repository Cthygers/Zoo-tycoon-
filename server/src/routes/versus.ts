// routes/versus.ts — versus matches (#18–#28). Every response goes through db/versus.ts matchDto()/
// opponentProgress()/seriesRows(): seat-based, no ids/emails/device names of the other seat (P1).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  CodePreviewResponse, MatchListResponse, MatchResponse, MatchStatus, SeriesResponse, SnapshotsResponse, VersusSnapshot,
} from '../../../shared/api-types.js';
import { FINAL_SAVE_MAX_GZ_BYTES, SAVE_MAX_RAW_BYTES } from '../../../shared/limits.js';
import { checkName } from '../../../shared/names.js';
import {
  CODE_TTL_MS, FINISH_WINDOW_MS, HOUR_REAL_S, OVER_BUDGET_GRACE_MS, PACE_SLACK_S, SNAPSHOT_EVERY_HOURS, TEST_LENGTH,
  VERSUS_RULES_VERSION, checkPace, checkSnapshotStep, hoursTotal, isValidCode, lengthSpec, normalizeCode, type LengthSpec,
} from '../../../shared/versus-rules.js';
import { authOf, type Limiter } from '../auth/plugin.js';
import { DAY_MS } from '../clock.js';
import type { Ctx } from '../context.js';
import { parseAvatar, profileOfAccount, type ProfileRow } from '../db/profiles.js';
import { accountFinalSaveBytes } from '../db/saves.js';
import {
  addFlags, bindSeatDevice, codeInUse, countActive, countOpenCoded, createdSince, createdSinceByAccount, finalizeMatch, getMatch, getSeats,
  insertMatch, insertSeat, insertSnapshot, isFamily, matchByCode, matchDto, matchIdsForProfile, opponentProgress,
  seatOf, seriesRows, storedSnapshot, touchSeat, updateSeatProgress, viewerSeat, type MatchRow, type NewSeat, type SeatRow,
} from '../db/versus.js';
import { ApiError, notFound } from '../errors.js';
import { decodeSave } from '../gzip.js';
import { newMatchCode, newSeed, randomId, sha256Hex } from '../ids.js';
import { securityEvent } from '../log.js';
import {
  CreateMatchSchema, FinishSchema, JoinMatchSchema, ListQuery, ProfileOnlySchema, ProfileQuery, SeriesQuery, SnapshotsSchema,
  parse, pathId,
} from '../validate.js';
import { appVersionOf, assertNotFull, ownProfile, send } from './common.js';

export const FINISH_BODY_LIMIT = 409_600; // 400 KiB
const MAX_ACTIVE = 3;
const MAX_OPEN_CODED = 1;
const MAX_CREATES_PER_DAY = 10;
/** Per account (all its profiles, removed ones included) on top of the per-profile 10 a day. */
export const MAX_CREATES_PER_DAY_ACCOUNT = 30;
/**
 * Versus final saves are only kept for the owner's review (30 days, never served). Per account they may use
 * this share of MAX_ACCOUNT_BYTES, on top of the save quota so they never crowd out real cloud saves; past it
 * the finish still counts and the save is dropped (flag 'save_dropped'). Family matches keep no final save.
 */
export const FINAL_SAVES_SHARE = 0.25;
/** A 'budget' end needs budgetMin of wall time since T0, less this slack (clock rounding, request latency). */
const BUDGET_END_SLACK_MS = 60_000;

export interface VersusLimiters {
  create: Limiter;
  codes: Limiter[];
  snapshots: Limiter;
}

function seatName(p: ProfileRow): string {
  const r = checkName(p.name);
  return r.ok ? r.name : 'Player';
}

function newSeat(seat: 0 | 1, p: ProfileRow, now: number, appVersion: string): NewSeat {
  return { seat, profileId: p.id, accountId: p.account_id, name: seatName(p), avatar: parseAvatar(p.avatar), joinedAt: now, appVersion };
}

function etagOf(body: unknown): string {
  return `"${sha256Hex(JSON.stringify(body)).slice(0, 32)}"`;
}

export function registerVersus(app: FastifyInstance, ctx: Ctx, lim: VersusLimiters): void {
  const { db, clock, config } = ctx;

  /** The caller's active profile (404 for foreign, unknown or removed). */
  const caller = (req: FastifyRequest, pid: unknown): ProfileRow => ownProfile(ctx, req, pid, { activeOnly: true });

  /** Load + lazily finalise a match the profile sits in (or is invited to). 404 otherwise. */
  const loadMatch = (req: FastifyRequest, rawId: unknown, pid: string): { m: MatchRow; seats: SeatRow[]; mySeat: 0 | 1 } => {
    const id = pathId(rawId);
    const m0 = getMatch(db, id);
    if (!m0) throw notFound();
    let seats = getSeats(db, id);
    const mySeat = viewerSeat(m0, seats, pid);
    if (mySeat === null) {
      securityEvent(req.log, 'idor_denied', { accountId: req.auth?.accountId });
      throw notFound();
    }
    const m = finalizeMatch(db, m0, clock.now());
    if (m !== m0) seats = getSeats(db, id);
    return { m, seats, mySeat };
  };

  const dtoFor = (m: MatchRow, pid: string, req: FastifyRequest, seats?: SeatRow[]) =>
    matchDto(db, m, { profileId: pid, deviceId: authOf(req).deviceId }, clock.now(), seats);

  const sendMatch = (reply: FastifyReply, status: number, m: MatchRow, pid: string, req: FastifyRequest) =>
    send<Omit<MatchResponse, 'serverTime'>>(ctx, reply, status, { match: dtoFor(db.get<MatchRow>('SELECT * FROM matches WHERE id = ?', m.id) ?? m, pid, req) });

  /** Lazy finalisation of a profile's unsettled matches, so stale ones never count against the limits. */
  const settle = (pid: string, now: number) => {
    for (const id of matchIdsForProfile(db, pid, ['open', 'active'], 200)) finalizeMatch(db, getMatch(db, id)!, now);
  };

  const checkLimitsForCreate = (p: ProfileRow, now: number, coded: boolean, others: ProfileRow[]) => {
    for (const x of [p, ...others]) settle(x.id, now);
    const perDay = (recent: number[], max: number) => {
      if (recent.length < max) return;
      const secs = Math.max(1, Math.ceil((recent[recent.length - max]! + DAY_MS - now) / 1000));
      throw new ApiError('rate_limited', 429, 'Too many new matches today.', { retryAfter: secs }, { 'retry-after': String(secs) });
    };
    perDay(createdSince(db, p.id, now - DAY_MS), MAX_CREATES_PER_DAY);
    perDay(createdSinceByAccount(db, p.account_id, now - DAY_MS), MAX_CREATES_PER_DAY_ACCOUNT);
    if (coded && countOpenCoded(db, p.id) >= MAX_OPEN_CODED) throw new ApiError('open_limit', 409);
    for (const x of [p, ...others]) if (countActive(db, x.id) >= MAX_ACTIVE) throw new ApiError('active_limit', 409);
  };

  const uniqueCode = (): string => {
    for (let i = 0; i < 50; i++) {
      const c = newMatchCode();
      if (!codeInUse(db, c)) return c;
    }
    throw new ApiError('internal', 503, 'Could not make a match code. Try again.');
  };

  const specFor = (lengthMin: number): LengthSpec => {
    const allowed = (config.versusLengths as number[]).includes(lengthMin) || (lengthMin === 4 && config.testLength);
    const spec = allowed ? lengthSpec(lengthMin, config.testLength) : null;
    if (!spec) throw new ApiError('invalid', 422, 'That match length is not offered.', { issues: [`lengthMin: ${lengthMin} is not offered`] });
    return spec;
  };

  // ---------------------------------------------------------------- #18 create
  app.post('/v1/versus/matches', { config: { auth: true }, preHandler: [lim.create] }, async (req, reply) => {
    const auth = authOf(req);
    const body = parse(CreateMatchSchema, req.body);
    if (body.rulesVersion !== VERSUS_RULES_VERSION) throw new ApiError('upgrade_required', 426, 'Update Wildhaven to play Versus.', { rulesVersion: VERSUS_RULES_VERSION });
    const spec = specFor(body.lengthMin);
    const appVersion = appVersionOf(req);
    assertNotFull(ctx, req);
    const m = db.tx(() => {
      const now = clock.now();
      const p = caller(req, body.profileId);
      const id = randomId();
      if (body.opponentProfileId !== undefined) {
        if (body.opponentProfileId === p.id) throw new ApiError('invalid', 422, 'Pick another player.', { issues: ['opponentProfileId: same as profileId'] });
        const o = profileOfAccount(db, auth.accountId, body.opponentProfileId);
        if (!o || o.deleted_at !== null) throw notFound();
        checkLimitsForCreate(p, now, false, [o]);
        insertMatch(db, {
          id, kind: 'family', code: null, spec, seed: newSeed(), rulesVersion: VERSUS_RULES_VERSION, status: 'active',
          createdAt: now, codeExpiresAt: null, joinedAt: now, finishBy: now + FINISH_WINDOW_MS, invitedProfileId: null,
          seats: [newSeat(0, p, now, appVersion), newSeat(1, o, now, appVersion)],
        });
      } else {
        checkLimitsForCreate(p, now, true, []);
        insertMatch(db, {
          id, kind: 'coded', code: uniqueCode(), spec, seed: newSeed(), rulesVersion: VERSUS_RULES_VERSION, status: 'open',
          createdAt: now, codeExpiresAt: now + CODE_TTL_MS, joinedAt: null, finishBy: null, invitedProfileId: null,
          seats: [newSeat(0, p, now, appVersion)],
        });
      }
      return { match: getMatch(db, id)!, pid: p.id };
    });
    return sendMatch(reply, 201, m.match, m.pid, req);
  });

  // ---------------------------------------------------------------- #19 preview by code
  app.get('/v1/versus/codes/:code', { config: { auth: true }, preHandler: lim.codes }, async (req, reply) => {
    const q = parse(ProfileQuery, req.query ?? {});
    const raw = (req.params as { code?: string }).code ?? '';
    const code = normalizeCode(raw);
    const res = db.tx(() => {
      caller(req, q.profileId);
      if (!isValidCode(code)) throw notFound();
      const m0 = matchByCode(db, code);
      if (!m0) throw notFound();
      const m = finalizeMatch(db, m0, clock.now());
      const s0 = getSeats(db, m.id).find((s) => s.seat === 0);
      if (!s0) throw notFound();
      const out: Omit<CodePreviewResponse, 'serverTime'> = {
        matchId: m.id,
        challenger: { name: s0.name, avatar: parseAvatar(s0.avatar) },
        lengthMin: m.length_min as CodePreviewResponse['lengthMin'],
        days: m.days,
        status: m.status,
        codeExpiresAt: m.code_expires_at,
      };
      return out;
    });
    return send(ctx, reply, 200, res);
  });

  // ---------------------------------------------------------------- #20 join
  app.post('/v1/versus/matches/:id/join', { config: { auth: true }, preHandler: lim.codes }, async (req, reply) => {
    const body = parse(JoinMatchSchema, req.body);
    if (body.rulesVersion !== VERSUS_RULES_VERSION) throw new ApiError('upgrade_required', 426, 'Update Wildhaven to play Versus.', { rulesVersion: VERSUS_RULES_VERSION });
    const appVersion = appVersionOf(req);
    assertNotFull(ctx, req);
    const out = db.tx(() => {
      const now = clock.now();
      const p = caller(req, body.profileId);
      const id = pathId((req.params as { id?: string }).id);
      const m0 = getMatch(db, id);
      if (!m0) throw notFound();
      if (body.code !== undefined) {
        if (m0.code === null || normalizeCode(body.code) !== m0.code) throw notFound();
      } else if (!(m0.kind === 'rematch' && m0.invited_profile_id === p.id)) {
        throw notFound();
      }
      const m = finalizeMatch(db, m0, now);
      const seats = getSeats(db, id);
      if (seats.find((s) => s.seat === 0)?.profile_id === p.id) throw new ApiError('own_match', 403);
      if (m.status === 'expired') throw new ApiError('code_expired', 409);
      if (m.status === 'cancelled' || m.status === 'finished') throw new ApiError('match_state', 409);
      if (m.status === 'active' || seats.some((s) => s.seat === 1)) throw new ApiError('match_full', 409);
      settle(p.id, now);
      if (countActive(db, p.id) >= MAX_ACTIVE) throw new ApiError('active_limit', 409);
      insertSeat(db, id, newSeat(1, p, now, appVersion));
      db.run(
        "UPDATE matches SET status = 'active', joined_at = ?, finish_by = ?, invited_profile_id = NULL WHERE id = ? AND status = 'open'",
        now, now + FINISH_WINDOW_MS, id,
      );
      // The challenger may already have finished (open matches accept seat 0's finish): settle now if so.
      const fresh = finalizeMatch(db, getMatch(db, id)!, now);
      return { m: fresh, pid: p.id };
    });
    return sendMatch(reply, 200, out.m, out.pid, req);
  });

  // ---------------------------------------------------------------- #21 list
  app.get('/v1/versus/matches', { config: { auth: true } }, async (req, reply) => {
    const q = parse(ListQuery, req.query ?? {});
    const res = db.tx(() => {
      const now = clock.now();
      const p = caller(req, q.profileId);
      for (const id of matchIdsForProfile(db, p.id, ['open', 'active'], 200)) finalizeMatch(db, getMatch(db, id)!, now);
      const statuses: MatchStatus[] | null =
        q.state === 'active' ? ['open', 'active'] : q.state === 'finished' ? ['finished', 'expired', 'cancelled'] : null;
      const ids = matchIdsForProfile(db, p.id, statuses, 50);
      return { matches: ids.map((id) => dtoFor(getMatch(db, id)!, p.id, req)) };
    });
    return send<Omit<MatchListResponse, 'serverTime'>>(ctx, reply, 200, res);
  });

  // ---------------------------------------------------------------- #22 get
  app.get('/v1/versus/matches/:id', { config: { auth: true } }, async (req, reply) => {
    const q = parse(ProfileQuery, req.query ?? {});
    const match = db.tx(() => {
      const p = caller(req, q.profileId);
      const { m, seats } = loadMatch(req, (req.params as { id?: string }).id, p.id);
      return dtoFor(m, p.id, req, seats);
    });
    const etag = etagOf(match);
    reply.header('etag', etag);
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.split(',').map((s) => s.trim()).includes(etag)) return reply.code(304).send();
    return send<Omit<MatchResponse, 'serverTime'>>(ctx, reply, 200, { match });
  });

  /** Seat/state/device checks shared by snapshots (#23) and finish (#25). */
  const playableSeat = (m: MatchRow, me: SeatRow, deviceId: string): void => {
    const now = clock.now();
    if (m.status === 'cancelled') throw new ApiError('match_state', 409);
    if (me.done_at !== null) throw new ApiError('match_over', 409);
    const ok = (m.status === 'active' && m.finish_by !== null && now <= m.finish_by) || (m.status === 'open' && me.seat === 0);
    if (!ok) throw new ApiError('match_over', 409);
    if (me.device_id !== null && me.device_id !== deviceId) {
      throw new ApiError('other_device', 409, 'This match is being played on another device.', { deviceName: me.device_name ?? 'another device' });
    }
  };

  const t0Of = (m: MatchRow, me: SeatRow, family: boolean): number => (me.seat === 1 && !family ? (m.joined_at ?? me.joined_at) : m.created_at);

  /**
   * First snapshot/finish of a seat: bind it to the caller's device (S6). Both seats of a non-family match
   * bound to one device install (two Google accounts on one phone) are flagged 'same_device' (flag only).
   */
  const bindDevice = (m: MatchRow, seats: SeatRow[], me: SeatRow, family: boolean, deviceId: string, deviceName: string, now: number): void => {
    if (me.device_id !== null) return;
    bindSeatDevice(db, m.id, me.seat, deviceId, deviceName, now);
    const other = seats.find((s) => s.seat !== me.seat);
    if (!family && other && other.device_id === deviceId) {
      addFlags(db, m.id, me.seat, ['same_device']);
      addFlags(db, m.id, other.seat, ['same_device']);
    }
  };

  // ---------------------------------------------------------------- #23 snapshots
  app.post('/v1/versus/matches/:id/snapshots', { config: { auth: true }, preHandler: [lim.snapshots] }, async (req, reply) => {
    const auth = authOf(req);
    const body = parse(SnapshotsSchema, req.body);
    assertNotFull(ctx, req);
    const out = db.tx(() => {
      const now = clock.now();
      const p = caller(req, body.profileId);
      const { m, seats, mySeat } = loadMatch(req, (req.params as { id?: string }).id, p.id);
      const me = seats.find((s) => s.seat === mySeat);
      if (!me) throw notFound();
      playableSeat(m, me, auth.deviceId);
      const family = isFamily(m, seats);
      const total = hoursTotal(m.days);
      const fresh = [...body.snapshots].sort((a, b) => a.h - b.h).filter((s) => !(s.h <= me.ack_hour));
      if (fresh.length > 0) {
        const maxH = fresh[fresh.length - 1]!.h;
        const verdict = checkPace(maxH, now - t0Of(m, me, family), family);
        if (verdict === 'reject') {
          securityEvent(req.log, 'pace_flag', { accountId: auth.accountId, verdict, h: maxH });
          throw new ApiError('too_fast', 422, 'The match progress is too fast.');
        }
        if (verdict === 'flag') {
          securityEvent(req.log, 'pace_flag', { accountId: auth.accountId, verdict, h: maxH });
          addFlags(db, m.id, me.seat, ['pace']);
        }
      }
      bindDevice(m, seats, me, family, auth.deviceId, auth.deviceName, now);
      let prev = storedSnapshot(db, m.id, me.seat, me.ack_hour);
      let failure: ApiError | null = null;
      for (const s of fresh) {
        if (!Number.isInteger(s.h) || s.h % SNAPSHOT_EVERY_HOURS !== 0) {
          failure = new ApiError('bad_snapshot', 422, 'The match progress is not valid.', { h: s.h, detail: `h not a multiple of ${SNAPSHOT_EVERY_HOURS}` });
          break;
        }
        const step = checkSnapshotStep(prev, s, total);
        if (!step.ok) {
          failure = new ApiError('bad_snapshot', 422, 'The match progress is not valid.', { h: s.h, detail: step.detail ?? 'bad snapshot' });
          break;
        }
        insertSnapshot(db, m.id, me.seat, s, now);
        updateSeatProgress(db, m.id, me.seat, s, now);
        addFlags(db, m.id, me.seat, step.flags);
        prev = s;
      }
      touchSeat(db, m.id, me.seat, now);
      const seats2 = getSeats(db, m.id);
      const me2 = seats2.find((s) => s.seat === mySeat)!;
      const res: Omit<SnapshotsResponse, 'serverTime'> = { ackHour: me2.ack_hour, opponent: opponentProgress(db, m, seats2, mySeat, now) };
      return { res, failure };
    });
    // A failing snapshot: the ones before it are stored (committed above), the batch answers 422.
    if (out.failure) throw out.failure;
    return send(ctx, reply, 200, out.res);
  });

  // ---------------------------------------------------------------- #24 series
  app.get('/v1/versus/matches/:id/series', { config: { auth: true } }, async (req, reply) => {
    const q = parse(SeriesQuery, req.query ?? {});
    const res = db.tx(() => {
      const p = caller(req, q.profileId);
      const { m, seats, mySeat } = loadMatch(req, (req.params as { id?: string }).id, p.id);
      const opp = seats.find((s) => s.seat !== mySeat);
      if (!opp) throw notFound();
      const out: Omit<SeriesResponse, 'serverTime'> = {
        lastHour: opp.ack_hour,
        done: opp.done_at !== null,
        series: seriesRows(db, m.id, opp.seat, q.since ?? 0),
      };
      return out;
    });
    return send(ctx, reply, 200, res);
  });

  // ---------------------------------------------------------------- #25 finish
  app.post('/v1/versus/matches/:id/finish', { config: { auth: true }, bodyLimit: FINISH_BODY_LIMIT }, async (req, reply) => {
    const auth = authOf(req);
    const body = parse(FinishSchema, req.body);
    const dec = decodeSave(body.save.data, body.save.sha256, {
      maxGz: FINAL_SAVE_MAX_GZ_BYTES,
      maxRaw: SAVE_MAX_RAW_BYTES,
      onZipBomb: () => securityEvent(req.log, 'zip_bomb', { accountId: auth.accountId }),
    });
    const out = db.tx(() => {
      const now = clock.now();
      const p = caller(req, body.profileId);
      const { m, seats, mySeat } = loadMatch(req, (req.params as { id?: string }).id, p.id);
      const me = seats.find((s) => s.seat === mySeat);
      if (!me) throw notFound();
      if (me.done_at !== null) return { m, pid: p.id }; // idempotent
      assertNotFull(ctx, req);
      playableSeat(m, me, auth.deviceId);
      const total = hoursTotal(m.days);
      const f: VersusSnapshot = body.final;
      if (body.endReason === 'complete' && f.h !== total) {
        throw new ApiError('invalid', 422, 'A complete match ends at the last hour.', { issues: [`final.h: must be ${total} for endReason complete`] });
      }
      if (body.endReason === 'budget' && !(Number.isInteger(f.h) && f.h >= 1 && f.h < total)) {
        throw new ApiError('invalid', 422, 'A budget end is before the last hour.', { issues: [`final.h: must be 1..${total - 1} for endReason budget`] });
      }
      const family = isFamily(m, seats);
      const flags: string[] = [];
      // The seat's real-time budget starts at its first "Go!", which cannot be before T0 (joinedAt, or
      // createdAt), even when played offline: an earlier 'budget' end is a seat locking in a lead. Refused for
      // real matches; only flagged for family matches and for the 4-minute test length (non-production only,
      // where the e2e skips the phone's budget clock ahead).
      const sinceT0 = now - t0Of(m, me, family);
      if (body.endReason === 'budget' && sinceT0 < m.budget_min * 60_000 - BUDGET_END_SLACK_MS) {
        securityEvent(req.log, 'pace_flag', { accountId: auth.accountId, verdict: 'early_budget', h: f.h });
        if (!family && m.length_min !== TEST_LENGTH.lengthMin) {
          throw new ApiError('invalid', 422, 'The time budget has not run out yet.', { issues: ['endReason: budget before budgetMin'] });
        }
        flags.push('early_budget');
      }
      const verdict = checkPace(f.h, sinceT0, family);
      if (verdict === 'reject') {
        securityEvent(req.log, 'pace_flag', { accountId: auth.accountId, verdict, h: f.h });
        throw new ApiError('too_fast', 422, 'The match progress is too fast.');
      }
      if (verdict === 'flag') {
        securityEvent(req.log, 'pace_flag', { accountId: auth.accountId, verdict, h: f.h });
        flags.push('pace');
      }
      const prev = storedSnapshot(db, m.id, me.seat, me.ack_hour);
      if (prev && f.h === prev.h) {
        // The final is the snapshot already stored at this hour (e.g. the budget ran out right after an upload).
        if (Math.abs(Math.round(f.total) - prev.total) > 1) {
          throw new ApiError('bad_snapshot', 422, 'The match progress is not valid.', { h: f.h, detail: 'final differs from the stored hour' });
        }
      } else {
        const step = checkSnapshotStep(prev, f, total);
        if (!step.ok) throw new ApiError('bad_snapshot', 422, 'The match progress is not valid.', { h: f.h, detail: step.detail ?? 'bad snapshot' });
        flags.push(...step.flags);
        insertSnapshot(db, m.id, me.seat, f, now);
        updateSeatProgress(db, m.id, me.seat, f, now);
      }
      bindDevice(m, seats, me, family, auth.deviceId, auth.deviceName, now);
      const first = me.first_snapshot_at ?? now;
      if (now > first + m.budget_min * 60_000 + OVER_BUDGET_GRACE_MS) flags.push('over_budget');
      // Idle, then the whole match uploaded in far less wall time than playing it takes (or played offline).
      if (f.h * HOUR_REAL_S * 1000 > 2 * (now - first) + PACE_SLACK_S * 1000) flags.push('burst');
      let keep: Uint8Array | null = null;
      if (!family) {
        if (accountFinalSaveBytes(db, auth.accountId) + dec.sizeGz <= Math.floor(ctx.config.maxAccountBytes * FINAL_SAVES_SHARE)) keep = dec.gz;
        else flags.push('save_dropped');
      }
      db.run(
        'UPDATE match_seats SET done_at = ?, end_hour = ?, end_reason = ?, final_save = ?, last_post_at = ? WHERE match_id = ? AND seat = ?',
        now, f.h, body.endReason, keep, now, m.id, me.seat,
      );
      addFlags(db, m.id, me.seat, flags);
      return { m: finalizeMatch(db, getMatch(db, m.id)!, now), pid: p.id };
    });
    return sendMatch(reply, 200, out.m, out.pid, req);
  });

  // ---------------------------------------------------------------- #26 forfeit ("Give up")
  app.post('/v1/versus/matches/:id/forfeit', { config: { auth: true } }, async (req, reply) => {
    const body = parse(ProfileOnlySchema, req.body);
    const out = db.tx(() => {
      const now = clock.now();
      const p = caller(req, body.profileId);
      const { m, seats, mySeat } = loadMatch(req, (req.params as { id?: string }).id, p.id);
      const me = seats.find((s) => s.seat === mySeat);
      if (!me) throw notFound(); // an invitation can only be ignored
      if (m.status === 'open') {
        db.run("UPDATE matches SET status = 'cancelled', finished_at = ?, code = NULL WHERE id = ? AND status = 'open'", now, m.id);
        db.run("UPDATE match_seats SET done_at = COALESCE(done_at, ?), end_hour = COALESCE(end_hour, ack_hour), end_reason = COALESCE(end_reason, 'forfeit') WHERE match_id = ? AND seat = ?", now, m.id, me.seat);
      } else if (m.status === 'active' && me.done_at === null) {
        db.run("UPDATE match_seats SET done_at = ?, end_hour = ack_hour, end_reason = 'forfeit' WHERE match_id = ? AND seat = ?", now, m.id, me.seat);
      }
      return { m: finalizeMatch(db, getMatch(db, m.id)!, now), pid: p.id };
    });
    return sendMatch(reply, 200, out.m, out.pid, req);
  });

  // ---------------------------------------------------------------- #27 cancel
  app.post('/v1/versus/matches/:id/cancel', { config: { auth: true } }, async (req, reply) => {
    const body = parse(ProfileOnlySchema, req.body);
    const out = db.tx(() => {
      const now = clock.now();
      const p = caller(req, body.profileId);
      const { m, seats } = loadMatch(req, (req.params as { id?: string }).id, p.id);
      const s0 = seats.find((s) => s.seat === 0);
      if (!s0 || s0.profile_id !== p.id) throw notFound();
      if (m.status !== 'open' || s0.first_snapshot_at !== null || s0.ack_hour > 0 || s0.done_at !== null) throw new ApiError('match_state', 409);
      db.run("UPDATE matches SET status = 'cancelled', finished_at = ?, code = NULL WHERE id = ?", now, m.id);
      return { m: getMatch(db, m.id)!, pid: p.id };
    });
    return sendMatch(reply, 200, out.m, out.pid, req);
  });

  // ---------------------------------------------------------------- #28 rematch
  app.post('/v1/versus/matches/:id/rematch', { config: { auth: true }, preHandler: [lim.create] }, async (req, reply) => {
    const auth = authOf(req);
    const body = parse(ProfileOnlySchema, req.body);
    const appVersion = appVersionOf(req);
    assertNotFull(ctx, req);
    const out = db.tx(() => {
      const now = clock.now();
      const p = caller(req, body.profileId);
      const { m, seats } = loadMatch(req, (req.params as { id?: string }).id, p.id);
      const me = seatOf(seats, p.id);
      if (!me) throw notFound();
      if (m.status !== 'finished') throw new ApiError('match_state', 409);
      const other = seats.find((s) => s.seat !== me.seat);
      if (!other || other.profile_id === null) throw notFound();
      const op = db.get<ProfileRow>('SELECT * FROM profiles WHERE id = ?', other.profile_id);
      if (!op || op.deleted_at !== null) throw notFound();
      const spec = specFor(m.length_min); // VERSUS_LENGTHS and the test length, as for #18
      const id = randomId();
      if (op.account_id === auth.accountId) {
        checkLimitsForCreate(p, now, false, [op]);
        insertMatch(db, {
          id, kind: 'family', code: null, spec, seed: newSeed(), rulesVersion: VERSUS_RULES_VERSION, status: 'active',
          createdAt: now, codeExpiresAt: null, joinedAt: now, finishBy: now + FINISH_WINDOW_MS, invitedProfileId: null,
          seats: [newSeat(0, p, now, appVersion), newSeat(1, op, now, appVersion)],
        });
      } else {
        checkLimitsForCreate(p, now, false, []);
        insertMatch(db, {
          id, kind: 'rematch', code: null, spec, seed: newSeed(), rulesVersion: VERSUS_RULES_VERSION, status: 'open',
          createdAt: now, codeExpiresAt: now + CODE_TTL_MS, joinedAt: null, finishBy: null, invitedProfileId: op.id,
          seats: [newSeat(0, p, now, appVersion)],
        });
      }
      return { m: getMatch(db, id)!, pid: p.id };
    });
    return sendMatch(reply, 201, out.m, out.pid, req);
  });
}
