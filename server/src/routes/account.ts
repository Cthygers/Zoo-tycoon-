// routes/account.ts — GET /v1/account (#6), DELETE /v1/account (#7, fresh re-auth, P4).
import type { FastifyInstance } from 'fastify';
import type { AccountResponse } from '../../../shared/api-types.js';
import { authOf } from '../auth/plugin.js';
import { publicConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { deleteAccountData, getAccount } from '../db/accounts.js';
import { appendDeletion, deletionLogPath } from '../db/deletions.js';
import { listForAccount } from '../db/profiles.js';
import { ApiError } from '../errors.js';
import { securityEvent } from '../log.js';
import { DeleteAccountSchema, parse } from '../validate.js';
import { verifyGoogle } from './auth.js';
import { send } from './common.js';

export function registerAccount(app: FastifyInstance, ctx: Ctx): void {
  app.get('/v1/account', { config: { auth: true } }, async (req, reply) => {
    const auth = authOf(req);
    const a = getAccount(ctx.db, auth.accountId);
    if (!a) throw new ApiError('unauthorized', 401);
    const lists = listForAccount(ctx.db, a.id, auth.deviceId, ctx.clock.now());
    const res: Omit<AccountResponse, 'serverTime'> = {
      account: { id: a.id, email: a.email, createdAt: a.created_at },
      profiles: lists.profiles,
      removed: lists.removed,
      config: publicConfig(ctx.config),
    };
    return send(ctx, reply, 200, res);
  });

  app.delete('/v1/account', { config: { auth: true } }, async (req, reply) => {
    const auth = authOf(req);
    const body = parse(DeleteAccountSchema, req.body);
    const id = await verifyGoogle(ctx, req, body.idToken, body.nonce);
    ctx.db.tx(() => {
      const a = getAccount(ctx.db, auth.accountId);
      if (!a) throw new ApiError('unauthorized', 401);
      if (a.google_sub !== id.sub) {
        securityEvent(req.log, 'reauth_mismatch', { accountId: auth.accountId });
        throw new ApiError('reauth_mismatch', 403);
      }
      deleteAccountData(ctx.db, a.id);
    });
    // Logged outside the DB (after the commit) so that restoring an older backup cannot bring the account back.
    try {
      appendDeletion(deletionLogPath(ctx.config.backupDir), { kind: 'account', accountId: auth.accountId, at: ctx.clock.now() });
    } catch (err) {
      req.log.error({ kind: 'deletion_log_failed', accountId: auth.accountId, err }, 'could not log the account deletion');
    }
    return reply.code(204).send();
  });
}
