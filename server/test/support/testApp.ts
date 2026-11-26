// test/support/testApp.ts — makeTestApp(): createApp on a temp SQLite file with a FakeClock and the fake Google.
// Pinned for the integrator: { app, clock, google, signIn(sub, device?), close() } (plus a few helpers).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { DeviceInfo, SignInResponse } from '../../../shared/api-types.js';
import { createApp } from '../../src/app.js';
import { FakeClock } from '../../src/clock.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { migrate, setNewEpoch } from '../../src/db/migrate.js';
import { openDb, type DB } from '../../src/db/sqlite.js';
import { createFakeGoogle, type FakeGoogle } from './fakeGoogle.js';

/** camelCase AppConfig fields, or UPPER_CASE env vars (parsed like the real server), or both. */
export type TestOverrides = Partial<AppConfig> & { [ENV_VAR: string]: unknown };

export interface CallOptions {
  token?: string | null;
  body?: unknown;
  /** Raw payload (string/Buffer) instead of JSON. */
  raw?: string | Buffer;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
}

export interface CallResult<T = any> {
  status: number;
  body: T;
  headers: LightMyRequestResponse['headers'];
  raw: LightMyRequestResponse;
}

export interface SignedIn {
  token: string;
  accountId: string;
  deviceId: string;
  email: string;
  response: SignInResponse;
}

export interface TestApp {
  app: FastifyInstance;
  db: DB;
  clock: FakeClock;
  google: FakeGoogle;
  config: AppConfig;
  dir: string;
  /** Captured JSON log lines (security tests read them). */
  logs: string[];
  signIn(sub: string, device?: Partial<DeviceInfo>, opts?: { email?: string; emailVerified?: boolean }): Promise<SignedIn>;
  call<T = any>(method: string, url: string, opts?: CallOptions): Promise<CallResult<T>>;
  /** What `cli restore` does to the epoch, without a backup file: new revisions get a new epoch. Returns it. */
  newEpoch(): string;
  /** Close the app and the DB, run `between` (e.g. a restore), then reopen both on the same file. */
  restart(between?: () => Promise<void> | void): Promise<void>;
  close(): Promise<void>;
}

export const TEST_AUDIENCE = 'test-web-client';

export function testEnv(dir: string): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DB_PATH: join(dir, 'test.db'),
    BACKUP_DIR: join(dir, 'backups'),
    BACKUP_EVERY_HOURS: '0',
    GOOGLE_CLIENT_IDS: TEST_AUDIENCE,
    GOOGLE_ISSUERS: 'https://accounts.google.com,accounts.google.com',
    ALLOWED_ORIGINS: 'https://localhost,http://localhost:5173',
    CONTACT_EMAIL: 'owner@example.test',
    VERSUS_TEST_LENGTH: '1',
    LOG_LEVEL: 'info',
  };
}

export async function makeTestApp(over: TestOverrides = {}): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'wh-server-'));
  const env = testEnv(dir);
  const camel: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(over)) {
    if (/^[A-Z0-9_]+$/.test(k)) env[k] = String(v);
    else camel[k] = v;
  }
  const config: AppConfig = { ...loadConfig(env), ...(camel as Partial<AppConfig>) };
  const clock = new FakeClock(Date.now());
  const db = openDb(config.dbPath);
  await migrate(db, { clock });
  const google = await createFakeGoogle({ audience: config.googleClientIds[0] ?? TEST_AUDIENCE, clock });
  const logs: string[] = [];
  const build = async (d: DB): Promise<FastifyInstance> => {
    const a = createApp({ db: d, clock, verifier: google.verifier({ audiences: config.googleClientIds, issuers: config.googleIssuers }), config, log: { level: 'info', stream: { write: (l) => void logs.push(l) } } });
    await a.ready();
    return a;
  };
  const app = await build(db);

  const call = async <T = any>(method: string, url: string, o: CallOptions = {}): Promise<CallResult<T>> => {
    const headers: Record<string, string> = { 'x-app-version': '0.15.0', 'x-client': 'android', ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    let payload: string | Buffer | undefined;
    if (o.raw !== undefined) payload = o.raw;
    else if (o.body !== undefined) {
      payload = JSON.stringify(o.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    }
    const qs = o.query
      ? '?' + Object.entries(o.query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
      : '';
    const res = await out.app.inject({ method: method as 'GET', url: url + qs, headers, ...(payload !== undefined ? { payload } : {}) });
    let body: unknown = null;
    if (res.payload.length > 0) {
      try {
        body = JSON.parse(res.payload);
      } catch {
        body = res.payload;
      }
    }
    return { status: res.statusCode, body: body as T, headers: res.headers, raw: res };
  };

  const signIn = async (sub: string, device: Partial<DeviceInfo> = {}, o: { email?: string; emailVerified?: boolean } = {}): Promise<SignedIn> => {
    const n = await call('POST', '/v1/auth/nonce', { body: {} });
    if (n.status !== 200) throw new Error(`nonce failed: ${n.status} ${JSON.stringify(n.body)}`);
    const email = o.email ?? `${sub}@example.com`;
    const idToken = await google.mintIdToken({ sub, email, emailVerified: o.emailVerified ?? true, nonce: n.body.nonce, aud: config.googleClientIds[0] });
    const dev: DeviceInfo = {
      id: device.id ?? `device-${sub}-0001`.replace(/[^A-Za-z0-9_-]/g, '-'),
      name: device.name ?? 'Test Phone',
      platform: device.platform ?? 'android',
      appVersion: device.appVersion ?? '0.15.0',
    };
    const r = await call<SignInResponse>('POST', '/v1/auth/google', { body: { idToken, nonce: n.body.nonce, device: dev } });
    if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${JSON.stringify(r.body)}`);
    return { token: r.body.session.token, accountId: r.body.account.id, deviceId: dev.id, email, response: r.body };
  };

  const out: TestApp = {
    app,
    db,
    clock,
    google,
    config,
    dir,
    logs,
    signIn,
    call,
    newEpoch() {
      return setNewEpoch(out.db);
    },
    async restart(between) {
      await out.app.close();
      out.db.close();
      if (between) await between();
      out.db = openDb(config.dbPath);
      await migrate(out.db, { clock });
      out.app = await build(out.db);
    },
    async close() {
      await out.app.close();
      out.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return out;
}
