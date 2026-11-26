// app.ts — createApp({ db, clock, verifier, config, log? }): the Fastify instance, without listening.
import cors from '@fastify/cors';
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerAuthHooks, makeLimiter } from './auth/plugin.js';
import type { IdTokenVerifier } from './auth/verifier.js';
import { HOUR_MS, MINUTE_MS, DAY_MS, type Clock } from './clock.js';
import type { AppConfig } from './config.js';
import type { Ctx, OpsState } from './context.js';
import { newestBackup } from './db/backup.js';
import type { DB } from './db/sqlite.js';
import { ApiError } from './errors.js';
import { loggerOptions, scrub, type LogOptions } from './log.js';
import { serverRoot } from './paths.js';
import { registerAccount } from './routes/account.js';
import { registerAuth } from './routes/auth.js';
import { registerHealth } from './routes/health.js';
import { registerProfiles } from './routes/profiles.js';
import { registerPublic } from './routes/public.js';
import { registerSaves } from './routes/saves.js';
import { registerVersus } from './routes/versus.js';

export interface AppDeps {
  db: DB;
  clock: Clock;
  verifier: IdTokenVerifier;
  config: AppConfig;
  /** Logger settings; omitted or false = no logging (tests capture with { stream }). */
  log?: LogOptions | false;
}

export const DEFAULT_BODY_LIMIT = 32_768;

function serverVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(serverRoot(), 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared state for health, backups and the DB size check (main.ts updates it). */
    ops: OpsState;
    ctx: Ctx;
    /** Every registered route (method, URL template, needs a session) — the security test walks it. */
    routeTable: { method: string; url: string; auth: boolean }[];
  }
}

const KNOWN_4XX: Record<string, { status: number; code: ApiError['code'] }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'too_large' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'unsupported_media_type' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { status: 400, code: 'bad_request' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'bad_request' },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: 'bad_request' },
};

/**
 * Rate-limit key of a client address: IPv4 as is, IPv6 masked to its /64 (one customer line gets a /64 or
 * more), the same as @fastify/rate-limit's default key. A custom keyGenerator replaces that default.
 */
export function ipKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  try {
    return normalizeIP(ip, 64);
  } catch {
    return ip.toLowerCase();
  }
}

export function createApp(deps: AppDeps): FastifyInstance {
  const { db, clock, verifier, config } = deps;
  const ops: OpsState = {
    startedAt: clock.now(),
    lastBackupAt: config.backupEveryHours > 0 ? newestBackup(config.backupDir) : null,
    lastBackupError: null,
    dbBytes: 0,
    dbBytesAt: 0,
    serverFullLogged: false,
  };
  const ctx: Ctx = { db, clock, config, verifier, ops, version: serverVersion() };

  const app = Fastify({
    logger: loggerOptions(deps.log) as never,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: DEFAULT_BODY_LIMIT,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 65_000,
    trustProxy: config.trustProxy.length > 0 ? config.trustProxy : false,
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false, maxParamLength: 200 },
  });
  app.decorate('ops', ops);
  app.decorate('ctx', ctx);
  const routeTable: { method: string; url: string; auth: boolean }[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
      if (m === 'HEAD' || m === 'OPTIONS') continue;
      routeTable.push({ method: m, url: r.url, auth: !!(r.config as { auth?: boolean } | undefined)?.auth });
    }
  });

  // JSON only: drop the default text/plain parser so other bodies get 415. An empty JSON body
  // (e.g. DELETE with Content-Type: application/json) parses as "no body"; everything else goes
  // through Fastify's own parser with proto/constructor poisoning → error.
  app.removeContentTypeParser(['text/plain', 'application/json']);
  const json = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '' || (typeof body === 'string' && body.trim() === '')) return done(null, undefined);
    json(req, body as string, done);
  });

  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, false);
      cb(null, config.allowedOrigins.includes(origin) ? origin : false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-App-Version', 'X-Client', 'If-None-Match'],
    exposedHeaders: ['ETag', 'Retry-After', 'Date'],
    maxAge: 7200,
    credentials: false,
    strictPreflight: false,
  });
  app.register(rateLimit, { global: false });

  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    const now = clock.now();
    if (err instanceof ApiError) {
      if (err.headers) for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
        serverTime: now,
      });
    }
    const fe = err as FastifyError;
    const known = fe.code ? KNOWN_4XX[fe.code] : undefined;
    if (known) {
      return reply.code(known.status).send({ error: { code: known.code, message: scrub(fe.message) }, serverTime: now });
    }
    const status = typeof fe.statusCode === 'number' ? fe.statusCode : 500;
    if (status >= 400 && status < 500) {
      const code = status === 404 ? 'not_found' : status === 413 ? 'too_large' : status === 415 ? 'unsupported_media_type' : status === 429 ? 'rate_limited' : 'bad_request';
      return reply.code(status).send({ error: { code, message: code === 'bad_request' ? 'Malformed request.' : scrub(fe.message) }, serverTime: now });
    }
    req.log.error({ err: fe }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on the server.' }, serverTime: now });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' }, serverTime: clock.now() }));

  // One request line per response: route template, status, time, request id, internal account id.
  app.addHook('onResponse', async (req, reply) => {
    req.log.info({ method: req.method, route: req.routeOptions.url ?? null, status: reply.statusCode, ms: Math.round(reply.elapsedTime), accountId: req.auth?.accountId ?? null }, 'request');
  });

  app.register(async (api) => {
    const acct = (name: string, max: number, windowMs: number) => makeLimiter(api, name, max, windowMs, (r) => r.auth?.accountId ?? null);
    const profileKey = (r: { params: unknown; auth: { accountId: string } | null }) => {
      const pid = (r.params as { pid?: string }).pid;
      return pid && r.auth ? `${r.auth.accountId}:${pid}` : null;
    };
    const ip = (name: string, max: number, windowMs: number) => makeLimiter(api, name, max, windowMs, (r) => ipKey(r.ip));

    registerAuthHooks(api, ctx, acct('account', 300, MINUTE_MS));
    registerHealth(api, ctx);
    registerAuth(api, ctx, {
      nonce: [ip('nonce-min', 10, MINUTE_MS), ip('nonce-hour', 50, HOUR_MS)],
      google: [ip('google-min', 10, MINUTE_MS), ip('google-hour', 50, HOUR_MS)],
    });
    registerAccount(api, ctx);
    registerProfiles(api, ctx, acct('profile-writes', 20, HOUR_MS));
    registerSaves(api, ctx, {
      put: makeLimiter(api, 'save-put', 20, MINUTE_MS, profileKey),
      lease: makeLimiter(api, 'lease', 6, MINUTE_MS, profileKey),
      stash: makeLimiter(api, 'stash', 10, HOUR_MS, profileKey),
    });
    registerVersus(api, ctx, {
      create: acct('versus-create', 10, HOUR_MS),
      codes: [acct('codes-min', 10, MINUTE_MS), acct('codes-day', 60, DAY_MS)],
      snapshots: makeLimiter(api, 'snapshots', 30, MINUTE_MS, (r) => {
        const id = (r.params as { id?: string }).id;
        const pid = (r.body as { profileId?: unknown } | undefined)?.profileId;
        return id && typeof pid === 'string' ? `${id}:${pid}` : null;
      }),
    });
    registerPublic(api, ctx);
  });

  return app;
}
