// context.ts — what every route and data module receives.
import type { FastifyBaseLogger } from 'fastify';
import type { AuthInfo } from './auth/sessions.js';
import type { IdTokenVerifier } from './auth/verifier.js';
import type { Clock } from './clock.js';
import type { AppConfig } from './config.js';
import type { DB } from './db/sqlite.js';

export interface OpsState {
  startedAt: number;
  /** Last successful scheduled backup (ms), seeded from the newest file in BACKUP_DIR. */
  lastBackupAt: number | null;
  lastBackupError: string | null;
  /** Last measured DB size and when (refreshed every 60 s and before writes). */
  dbBytes: number;
  dbBytesAt: number;
  serverFullLogged: boolean;
}

export interface Ctx {
  db: DB;
  clock: Clock;
  config: AppConfig;
  verifier: IdTokenVerifier;
  ops: OpsState;
  version: string;
}

export type { AuthInfo, FastifyBaseLogger };
