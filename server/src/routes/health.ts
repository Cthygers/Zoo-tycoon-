// routes/health.ts — GET /healthz (api #1) and GET /v1/config (api #2).
import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '../../../shared/api-types.js';
import { HOUR_MS } from '../clock.js';
import { publicConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { send } from './common.js';

export function backupStatus(ctx: Ctx): HealthResponse['backup'] {
  if (ctx.config.backupEveryHours <= 0) return 'off';
  const ref = ctx.ops.lastBackupAt ?? ctx.ops.startedAt;
  return ctx.clock.now() - ref > 2 * ctx.config.backupEveryHours * HOUR_MS ? 'stale' : 'ok';
}

export function healthOf(ctx: Ctx): Omit<HealthResponse, 'serverTime'> {
  let db: HealthResponse['db'] = 'ok';
  let disk: HealthResponse['disk'] = 'ok';
  try {
    ctx.db.get('SELECT 1 AS one');
    const now = ctx.clock.now();
    if (now - ctx.ops.dbBytesAt > 60_000 || ctx.ops.dbBytesAt === 0) {
      ctx.ops.dbBytes = ctx.db.sizeBytes();
      ctx.ops.dbBytesAt = now;
    }
    if (ctx.ops.dbBytes >= ctx.config.maxDbBytes) disk = 'full';
  } catch {
    db = 'error';
  }
  const backup = backupStatus(ctx);
  return { ok: db === 'ok' && disk === 'ok' && backup !== 'stale', db, disk, backup, version: ctx.version };
}

export function registerHealth(app: FastifyInstance, ctx: Ctx): void {
  app.get('/healthz', async (_req, reply) => {
    const h = healthOf(ctx);
    return send(ctx, reply, h.ok ? 200 : 503, h);
  });
  app.get('/v1/config', async (_req, reply) => send(ctx, reply, 200, publicConfig(ctx.config)));
}
