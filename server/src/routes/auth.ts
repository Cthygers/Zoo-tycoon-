// routes/auth.ts — nonce (#3), Google sign-in (#4), sign-out (#5).
import type { FastifyInstance } from 'fastify';
import type { NonceResponse, SignInResponse } from '../../../shared/api-types.js';
import type { Limiter } from '../auth/plugin.js';
import { consumeNonce, issueNonce } from '../auth/nonces.js';
import { bearerToken } from '../auth/sessions.js';
import type { VerifiedIdentity } from '../auth/verifier.js';
import { publicConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { upsertAccount } from '../db/accounts.js';
import { listForAccount } from '../db/profiles.js';
import { createSession, revokeSession, sessionByToken } from '../db/sessions.js';
import { ApiError } from '../errors.js';
import { securityEvent } from '../log.js';
import { EmptyBody, GoogleSignInSchema, parse } from '../validate.js';
import { send } from './common.js';
import type { FastifyRequest } from 'fastify';

/** Verify a Google ID token and consume the nonce (shared by sign-in and account deletion). */
export async function verifyGoogle(ctx: Ctx, req: FastifyRequest, idToken: string, nonce: string): Promise<VerifiedIdentity> {
  let id: VerifiedIdentity;
  try {
    id = await ctx.verifier.verify(idToken);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'token_invalid') securityEvent(req.log, 'token_invalid');
    throw e;
  }
  const ok = ctx.db.tx(() => consumeNonce(ctx.db, nonce, id.nonce, ctx.clock.now()));
  if (!ok) {
    securityEvent(req.log, 'nonce_invalid');
    throw new ApiError('nonce_invalid', 401);
  }
  return id;
}

/** Per-IP limits (10/min and 50/h), counted separately for the nonce and the sign-in route. */
export interface AuthLimiters {
  nonce: Limiter[];
  google: Limiter[];
}

export function registerAuth(app: FastifyInstance, ctx: Ctx, lim: AuthLimiters): void {
  app.post('/v1/auth/nonce', { onRequest: lim.nonce }, async (req, reply) => {
    parse(EmptyBody, req.body);
    const n = ctx.db.tx(() => issueNonce(ctx.db, ctx.clock.now()));
    return send<Omit<NonceResponse, 'serverTime'>>(ctx, reply, 200, n);
  });

  app.post('/v1/auth/google', { onRequest: lim.google }, async (req, reply) => {
    const body = parse(GoogleSignInSchema, req.body);
    const id = await verifyGoogle(ctx, req, body.idToken, body.nonce);
    const verifiedEmail = id.emailVerified && id.email ? id.email : null;
    if (ctx.config.allowedEmails.length > 0 && (verifiedEmail === null || !ctx.config.allowedEmails.includes(verifiedEmail.toLowerCase()))) {
      securityEvent(req.log, 'not_allowed');
      throw new ApiError('not_allowed', 403);
    }
    const out = ctx.db.tx(() => {
      const now = ctx.clock.now();
      const { account, isNew } = upsertAccount(ctx.db, id.sub, verifiedEmail, now);
      const { token, session } = createSession(ctx.db, account.id, body.device, now);
      const lists = listForAccount(ctx.db, account.id, body.device.id, now);
      const res: Omit<SignInResponse, 'serverTime'> = {
        session: { token, expiresAt: session.expires_at },
        account: { id: account.id, email: account.email, createdAt: account.created_at },
        isNew,
        profiles: lists.profiles,
        removed: lists.removed,
        config: publicConfig(ctx.config),
      };
      return { res, accountId: account.id };
    });
    req.auth = { accountId: out.accountId, sessionId: '', deviceId: body.device.id, deviceName: body.device.name, appVersion: body.device.appVersion };
    return send(ctx, reply, 200, out.res);
  });

  // Idempotent: a revoked or expired token still answers 204; a missing/unknown one is 401 (onRequest).
  app.post('/v1/auth/signout', async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    const s = token ? sessionByToken(ctx.db, token) : undefined;
    if (!s) throw new ApiError('unauthorized', 401);
    ctx.db.tx(() => revokeSession(ctx.db, s.id, ctx.clock.now()));
    req.auth = { accountId: s.account_id, sessionId: s.id, deviceId: s.device_id, deviceName: s.device_name, appVersion: s.app_version };
    return reply.code(204).send();
  });
}
