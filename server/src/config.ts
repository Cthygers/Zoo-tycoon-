// config.ts — environment → AppConfig (zod), with production assertions (spec §4.3).
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { ServerConfig, VersusLength } from '../../shared/api-types.js';
import { MAX_PROFILES_DEFAULT, LEASE_SECONDS_DEFAULT } from '../../shared/limits.js';
import { VERSUS_RULES_VERSION } from '../../shared/versus-rules.js';

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export type NodeEnv = 'production' | 'development' | 'test';

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  host: string;
  dbPath: string;
  backupDir: string;
  backupEveryHours: number;
  backupKeepRecent: number;
  backupKeepDaily: number;
  googleClientIds: string[];
  googleIssuers: string[];
  googleJwksUrl: string;
  allowedOrigins: string[];
  allowedEmails: string[];          // lower-case; empty = everyone
  trustProxy: string[];
  maxProfiles: number;
  maxAccountBytes: number;
  maxDbBytes: number;
  leaseSeconds: number;
  versusLengths: Exclude<VersusLength, 4>[];
  testLength: boolean;              // VERSUS_TEST_LENGTH=1 and not production
  minAppVersion: string | null;
  contactEmail: string;
  logLevel: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const list = (s: string | undefined): string[] =>
  (s ?? '').split(',').map((x) => x.trim()).filter((x) => x.length > 0);

const intVar = (def: number, min: number, max: number) =>
  z.string().trim().optional().transform((s, ctx) => {
    if (s === undefined || s === '') return def;
    if (!/^-?\d+$/.test(s)) {
      ctx.addIssue({ code: 'custom', message: `expected an integer, got "${s}"` });
      return z.NEVER;
    }
    const n = Number(s);
    if (n < min || n > max) {
      ctx.addIssue({ code: 'custom', message: `must be between ${min} and ${max}` });
      return z.NEVER;
    }
    return n;
  });

const optStr = (def: string) => z.string().trim().optional().transform((s) => (s === undefined || s === '' ? def : s));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).optional().default('production'),
  PORT: intVar(8080, 1, 65535),
  HOST: optStr('0.0.0.0'),
  DB_PATH: optStr('/data/wildhaven.db'),
  BACKUP_DIR: z.string().trim().optional(),
  BACKUP_EVERY_HOURS: intVar(6, 0, 24 * 7),
  BACKUP_KEEP_RECENT: intVar(8, 1, 1000),
  BACKUP_KEEP_DAILY: intVar(14, 0, 1000),
  GOOGLE_CLIENT_IDS: z.string().optional(),
  GOOGLE_ISSUERS: z.string().optional(),
  GOOGLE_JWKS_URL: optStr(GOOGLE_JWKS_URL),
  ALLOWED_ORIGINS: optStr('https://localhost'),
  ALLOWED_EMAILS: z.string().optional(),
  TRUST_PROXY: optStr('127.0.0.1,::1,172.16.0.0/12'),
  MAX_PROFILES: intVar(MAX_PROFILES_DEFAULT, 1, 100),
  MAX_ACCOUNT_BYTES: intVar(16_777_216, 1, Number.MAX_SAFE_INTEGER),
  MAX_DB_BYTES: intVar(2_147_483_648, 1, Number.MAX_SAFE_INTEGER),
  LEASE_SECONDS: intVar(LEASE_SECONDS_DEFAULT, 5, 3600),
  VERSUS_LENGTHS: optStr('30,60,90,120'),
  VERSUS_TEST_LENGTH: z.enum(['0', '1', '']).optional(),
  MIN_APP_VERSION: z.string().trim().optional(),
  CONTACT_EMAIL: z.string().trim().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional().default('info'),
});

const VERSION_RE = /^\d+(\.\d+){0,3}$/;

/** Parse the environment. Throws ConfigError with every problem listed. */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new ConfigError('Invalid server configuration:\n  ' + lines.join('\n  '));
  }
  const e = parsed.data;
  const problems: string[] = [];
  const production = e.NODE_ENV === 'production';

  const googleClientIds = list(e.GOOGLE_CLIENT_IDS);
  if (googleClientIds.length === 0) problems.push('GOOGLE_CLIENT_IDS is required (the Google OAuth Web client id)');
  const googleIssuers = e.GOOGLE_ISSUERS === undefined || e.GOOGLE_ISSUERS.trim() === '' ? [...GOOGLE_ISSUERS] : list(e.GOOGLE_ISSUERS);

  const lengths: Exclude<VersusLength, 4>[] = [];
  for (const s of list(e.VERSUS_LENGTHS)) {
    const n = Number(s);
    if (n === 30 || n === 60 || n === 90 || n === 120) {
      if (!lengths.includes(n)) lengths.push(n);
    } else problems.push(`VERSUS_LENGTHS: ${s} is not one of 30, 60, 90, 120`);
  }
  if (lengths.length === 0) problems.push('VERSUS_LENGTHS must list at least one of 30, 60, 90, 120');
  lengths.sort((a, b) => a - b);

  const minAppVersion = e.MIN_APP_VERSION ? e.MIN_APP_VERSION : null;
  if (minAppVersion !== null && !VERSION_RE.test(minAppVersion)) problems.push('MIN_APP_VERSION must look like 0.15.0');

  const testFlag = e.VERSUS_TEST_LENGTH === '1';
  const contactEmail = e.CONTACT_EMAIL ?? '';

  if (production) {
    if (e.GOOGLE_JWKS_URL !== GOOGLE_JWKS_URL) problems.push(`GOOGLE_JWKS_URL must be ${GOOGLE_JWKS_URL} in production`);
    for (const iss of googleIssuers) {
      if (!GOOGLE_ISSUERS.includes(iss)) problems.push(`GOOGLE_ISSUERS: ${iss} is not a Google issuer (production)`);
    }
    if (!contactEmail) problems.push('CONTACT_EMAIL is required in production (privacy and account-deletion pages)');
    if (testFlag) problems.push('VERSUS_TEST_LENGTH=1 is refused in production');
  }
  if (problems.length > 0) throw new ConfigError('Invalid server configuration:\n  ' + problems.join('\n  '));

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    dbPath: e.DB_PATH,
    backupDir: e.BACKUP_DIR ? e.BACKUP_DIR : join(dirname(e.DB_PATH), 'backups'),
    backupEveryHours: e.BACKUP_EVERY_HOURS,
    backupKeepRecent: e.BACKUP_KEEP_RECENT,
    backupKeepDaily: e.BACKUP_KEEP_DAILY,
    googleClientIds,
    googleIssuers,
    googleJwksUrl: e.GOOGLE_JWKS_URL,
    allowedOrigins: list(e.ALLOWED_ORIGINS),
    allowedEmails: list(e.ALLOWED_EMAILS).map((x) => x.toLowerCase()),
    trustProxy: list(e.TRUST_PROXY),
    maxProfiles: e.MAX_PROFILES,
    maxAccountBytes: e.MAX_ACCOUNT_BYTES,
    maxDbBytes: e.MAX_DB_BYTES,
    leaseSeconds: e.LEASE_SECONDS,
    versusLengths: lengths,
    testLength: testFlag && !production,
    minAppVersion,
    contactEmail: contactEmail || 'the address in CONTACT_EMAIL',
    logLevel: e.LOG_LEVEL,
  };
}

/** The public part of the config (GET /v1/config, sign-in, account). */
export function publicConfig(c: AppConfig): ServerConfig {
  return {
    apiVersion: 1,
    minAppVersion: c.minAppVersion,
    maxProfiles: c.maxProfiles,
    versusLengths: [...c.versusLengths],
    versusRulesVersion: VERSUS_RULES_VERSION,
    testLength: c.testLength,
  };
}

/** Compare dotted numeric versions: -1, 0 or 1. Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
