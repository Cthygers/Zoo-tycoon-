// routes/common.ts — helpers shared by the route modules.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authOf } from '../auth/plugin.js';
import type { Ctx } from '../context.js';
import { profileExistsElsewhere, profileOfAccount, type ProfileRow } from '../db/profiles.js';
import { ApiError, notFound } from '../errors.js';
import { securityEvent } from '../log.js';
import { pathId } from '../validate.js';

/** Send a success body with serverTime. */
export function send<T extends object>(ctx: Ctx, reply: FastifyReply, status: number, body: T): FastifyReply {
  return reply.code(status).send({ ...body, serverTime: ctx.clock.now() });
}

/**
 * The caller's profile. Foreign or unknown ids → 404 (logged as idor_denied when the id exists elsewhere).
 * A soft-deleted profile → 410 profile_deleted, unless allowDeleted; `activeOnly` turns 410 into 404 (versus).
 */
export function ownProfile(ctx: Ctx, req: FastifyRequest, rawPid: unknown, opts: { allowDeleted?: boolean; activeOnly?: boolean } = {}): ProfileRow {
  const auth = authOf(req);
  const pid = pathId(rawPid);
  const p = profileOfAccount(ctx.db, auth.accountId, pid);
  if (!p) {
    if (profileExistsElsewhere(ctx.db, auth.accountId, pid)) securityEvent(req.log, 'idor_denied', { accountId: auth.accountId });
    throw notFound();
  }
  if (p.deleted_at !== null && !opts.allowDeleted) {
    if (opts.activeOnly) throw notFound();
    throw new ApiError('profile_deleted', 410, 'This player was removed.', { purgeAt: p.purge_at });
  }
  return p;
}

/** 507 server_full when the DB file is at MAX_DB_BYTES (checked before every write). */
export function assertNotFull(ctx: Ctx, req: FastifyRequest): void {
  const bytes = ctx.db.sizeBytes();
  ctx.ops.dbBytes = bytes;
  ctx.ops.dbBytesAt = ctx.clock.now();
  if (bytes >= ctx.config.maxDbBytes) {
    if (!ctx.ops.serverFullLogged) {
      ctx.ops.serverFullLogged = true;
      req.log.error({ kind: 'server_full', dbBytes: bytes, maxDbBytes: ctx.config.maxDbBytes }, 'database is full');
    }
    securityEvent(req.log, 'server_full');
    throw new ApiError('server_full', 507, 'The server is full. Your zoo is safe on this device.');
  }
  ctx.ops.serverFullLogged = false;
}

/** Version header (falls back to the session's app version). */
export function appVersionOf(req: FastifyRequest): string {
  const v = req.headers['x-app-version'];
  if (typeof v === 'string' && /^[0-9A-Za-z.+_-]{1,32}$/.test(v)) return v;
  return req.auth?.appVersion ?? 'unknown';
}
