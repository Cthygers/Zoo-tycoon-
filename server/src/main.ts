// main.ts — env → config → db → migrate → createApp → listen; housekeeping, backups, DB size check; SIGTERM.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app.js';
import { remoteGoogleVerifier } from './auth/verifier.js';
import { HOUR_MS, systemClock } from './clock.js';
import { ConfigError, loadConfig } from './config.js';
import { runBackup, snapshot } from './db/backup.js';
import { runHousekeeping } from './db/housekeeping.js';
import { migrate } from './db/migrate.js';
import { openDb } from './db/sqlite.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(e.message + '\n');
      process.exit(78);
    }
    throw e;
  }
  const clock = systemClock;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = openDb(config.dbPath);
  const mig = await migrate(db, {
    clock,
    backup: (from, to) => snapshot(db, config.backupDir, clock, `pre-migrate-${from}-${to}-${clock.now()}.db.gz`),
  });

  const verifier = remoteGoogleVerifier({ audiences: config.googleClientIds, issuers: config.googleIssuers, jwksUrl: config.googleJwksUrl });
  const app = createApp({ db, clock, verifier, config, log: { level: config.logLevel } });
  const log = app.log;
  if (mig.applied.length > 0) log.info({ from: mig.from, to: mig.to, applied: mig.applied, backup: mig.backupFile }, 'database migrated');

  const timers: NodeJS.Timeout[] = [];
  const housekeeping = () => {
    try {
      const r = runHousekeeping(db, clock.now());
      log.info({ housekeeping: r }, 'housekeeping');
    } catch (err) {
      log.error({ err }, 'housekeeping failed');
    }
  };
  housekeeping();
  timers.push(setInterval(housekeeping, HOUR_MS));

  const sizeCheck = () => {
    try {
      app.ops.dbBytes = db.sizeBytes();
      app.ops.dbBytesAt = clock.now();
      if (app.ops.dbBytes >= config.maxDbBytes) log.error({ kind: 'server_full', dbBytes: app.ops.dbBytes }, 'database is full');
    } catch (err) {
      log.error({ err }, 'db size check failed');
    }
  };
  sizeCheck();
  timers.push(setInterval(sizeCheck, 60_000));

  if (config.backupEveryHours > 0) {
    const every = config.backupEveryHours * HOUR_MS;
    let running = false;
    const backup = async () => {
      if (running) return;
      running = true;
      try {
        const file = await runBackup(db, clock, { dir: config.backupDir, keepRecent: config.backupKeepRecent, keepDaily: config.backupKeepDaily });
        app.ops.lastBackupAt = clock.now();
        app.ops.lastBackupError = null;
        log.info({ file: file.split('/').pop() }, 'backup written');
      } catch (err) {
        app.ops.lastBackupError = String((err as Error).message ?? err);
        log.error({ err }, 'backup failed');
      } finally {
        running = false;
      }
    };
    // Next backup: one interval after the newest file, but not sooner than a minute from now.
    const last = app.ops.lastBackupAt;
    const firstIn = Math.max(60_000, last === null ? 60_000 : last + every - clock.now());
    timers.push(setTimeout(() => {
      void backup();
      timers.push(setInterval(() => void backup(), every));
    }, Math.min(firstIn, every)));
  }

  await app.listen({ port: config.port, host: config.host });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    for (const t of timers) clearTimeout(t);
    try {
      await app.close();
    } finally {
      db.close();
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`wildhaven-api failed to start: ${(err as Error)?.stack ?? err}\n`);
  process.exit(1);
});
