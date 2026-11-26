// auth/plugin.ts — request typing, the Bearer onRequest hook, app-version gate and rate-limit helpers.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { compareVersions } from '../config.js';
import type { Ctx } from '../context.js';
import { ApiError } from '../errors.js';
import { securityEvent } from '../log.js';
import { authenticate, type AuthInfo } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
  interface FastifyContextConfig {
    /** Route needs a Bearer session (every /v1 route except config, nonce and google). */
    auth?: boolean;
  }
}

/** The caller's session (routes with config.auth only). */
export function authOf(req: FastifyRequest): AuthInfo {
  if (!req.auth) throw new ApiError('unauthorized', 401);
  return req.auth;
}

export type Limiter = (req: FastifyRequest) => Promise<void>;

/**
 * One @fastify/rate-limit counter (in memory). `key` picks the bucket (account, profile, seat, IP);
 * returning null skips the check. Over the limit → 429 rate_limited with Retry-After.
 */
export function makeLimiter(app: FastifyInstance, name: string, max: number, windowMs: number, key: (req: FastifyRequest) => string | null): Limiter {
  const check = app.createRateLimit({ max, timeWindow: windowMs, keyGenerator: (req) => `${name}:${key(req) ?? '-'}` });
  return async (req) => {
    if (key(req) === null) return;
    const r = await check(req);
    if (!r.isAllowed && r.isExceeded) {
      const secs = Math.max(1, r.ttlInSeconds);
      securityEvent(req.log, 'rate_limited', { limiter: name, accountId: req.auth?.accountId });
      throw new ApiError('rate_limited', 429, undefined, { retryAfter: secs }, { 'retry-after': String(secs) });
    }
  };
}

export function registerAuthHooks(app: FastifyInstance, ctx: Ctx, accountLimiter: Limiter): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (req.is404) return;
    const url = req.routeOptions.url ?? '';
    if (ctx.config.minAppVersion && url.startsWith('/v1/') && url !== '/v1/config') {
      const v = req.headers['x-app-version'];
      if (typeof v === 'string' && /^\d/.test(v) && compareVersions(v, ctx.config.minAppVersion) < 0) {
        throw new ApiError('upgrade_required', 426, 'Update Wildhaven to keep playing online.', { minAppVersion: ctx.config.minAppVersion });
      }
    }
    if (req.routeOptions.config?.auth) {
      req.auth = authenticate(ctx.db, req.headers.authorization, ctx.clock.now());
      // ALLOWED_EMAILS holds for live sessions too: an address the owner removed loses access at once.
      // Deleting the account (fresh Google re-auth) stays possible so a removed family can still erase its data.
      if (ctx.config.allowedEmails.length > 0 && !(req.method === 'DELETE' && url === '/v1/account')) {
        const a = ctx.db.get<{ email: string | null }>('SELECT email FROM accounts WHERE id = ?', req.auth.accountId);
        if (!a?.email || !ctx.config.allowedEmails.includes(a.email.toLowerCase())) {
          securityEvent(req.log, 'not_allowed', { accountId: req.auth.accountId });
          req.auth = null;
          throw new ApiError('unauthorized', 401);
        }
      }
      await accountLimiter(req);
    }
  });
}
