// cli.ts — owner tools: backup | restore <file> | restore-revision --profile <id> (--rev <n> | --stash <id>) | flags [--match <id>]
//          | revoke (--account <id> | --email <addr>) | vacuum | purge
// Run inside the container: docker compose exec api node dist/server/src/cli.js <command>
// (restore: with the API stopped — docker compose run --rm api node dist/server/src/cli.js restore /data/backups/<file>.db.gz)
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { systemClock, type Clock } from './clock.js';
import { restoreDatabase, runBackup } from './db/backup.js';
import { appendDeletion, deletionLogPath, revokeAccountSessions } from './db/deletions.js';
import { runHousekeeping } from './db/housekeeping.js';
import { currentEpoch, migrate } from './db/migrate.js';
import { PIN_MS, currentHead, getSave, insertRevision, pinRevision } from './db/saves.js';
import { checkpointAlone, openDb, type DB } from './db/sqlite.js';
import { parseFlags } from './db/versus.js';
import { randomId } from './ids.js';
import type { SaveHead, SaveMeta } from '../../shared/api-types.js';

export interface OpsEnv {
  dbPath: string;
  backupDir: string;
  keepRecent: number;
  keepDaily: number;
}

export function opsEnv(env: Record<string, string | undefined>): OpsEnv {
  const dbPath = env.DB_PATH || '/data/wildhaven.db';
  return {
    dbPath,
    backupDir: env.BACKUP_DIR || join(dirname(dbPath), 'backups'),
    keepRecent: Number(env.BACKUP_KEEP_RECENT || 8),
    keepDaily: Number(env.BACKUP_KEEP_DAILY || 14),
  };
}

/**
 * Make an old revision (by rev number) or a stash the new head of a profile's main save.
 * The replaced head is pinned for 30 days. Clients then pull it or see a conflict, as for any new head.
 */
export function restoreRevision(db: DB, clock: Clock, profileId: string, from: { rev: number } | { stash: string }): SaveHead {
  return db.tx(() => {
    const now = clock.now();
    const save = getSave(db, profileId);
    if (!save) throw new Error(`profile ${profileId} has no cloud save`);
    type Src = { blob: Uint8Array | null; meta: string; save_version: number; size_raw: number; size_gz: number; sha256: string; client_saved_at: number | null };
    let src: Src | undefined;
    if ('rev' in from) {
      src = db.get<Src>('SELECT blob, meta, save_version, size_raw, size_gz, sha256, client_saved_at FROM save_revisions WHERE save_id = ? AND rev = ? ORDER BY created_at DESC LIMIT 1', save.id, from.rev);
      if (!src) throw new Error(`no revision ${from.rev} for profile ${profileId}`);
    } else {
      src = db.get<Src>('SELECT blob, meta, save_version, size_raw, size_gz, sha256, client_saved_at FROM save_stash WHERE stash_id = ? AND save_id = ?', from.stash, save.id);
      if (!src) throw new Error(`no stash ${from.stash} for profile ${profileId}`);
    }
    if (!src.blob) throw new Error('that revision no longer has its data (only the newest 10 and pinned ones keep it)');
    const head = currentHead(db, save);
    insertRevision(db, save, {
      epoch: currentEpoch(db),
      rev: (head?.rev ?? 0) + 1,
      pushId: `cli-${randomId()}`,
      deviceId: 'support',
      deviceName: 'Restored by support',
      appVersion: 'cli',
      saveVersion: src.save_version,
      meta: JSON.parse(src.meta) as SaveMeta,
      clientSavedAt: src.client_saved_at,
      sizeRaw: src.size_raw,
      sizeGz: src.size_gz,
      sha256: src.sha256,
      blob: src.blob,
      pinnedUntil: now + PIN_MS,
    }, now);
    if (head) pinRevision(db, save.id, head, now + PIN_MS);
    return currentHead(db, getSave(db, profileId))!;
  });
}

export interface FlagRow {
  matchId: string;
  seat: number;
  name: string;
  kind: string;
  status: string;
  flags: string[];
  endReason: string | null;
}

export function listFlags(db: DB, matchId?: string): FlagRow[] {
  const rows = db.all<{ match_id: string; seat: number; name: string; flags: string; kind: string; status: string; end_reason: string | null }>(
    `SELECT s.match_id, s.seat, s.name, s.flags, s.end_reason, m.kind, m.status FROM match_seats s JOIN matches m ON m.id = s.match_id
     WHERE s.flags <> '[]' ${matchId ? 'AND s.match_id = ?' : ''} ORDER BY m.created_at DESC, s.seat`,
    ...(matchId ? [matchId] : []),
  );
  return rows.map((r) => ({ matchId: r.match_id, seat: r.seat, name: r.name, kind: r.kind, status: r.status, flags: parseFlags(r.flags), endReason: r.end_reason }));
}

/**
 * Sign an account out everywhere (a lost phone, an address removed from ALLOWED_EMAILS): every session it has
 * now is revoked, and the revocation is logged so a later restore applies it again. The family can sign in
 * again unless ALLOWED_EMAILS keeps them out. Returns the account id and how many sessions were revoked.
 */
export function revokeSessions(db: DB, clock: Clock, logPath: string, who: { account: string } | { email: string }): { accountId: string; revoked: number } {
  const acc = 'account' in who
    ? db.get<{ id: string }>('SELECT id FROM accounts WHERE id = ?', who.account)
    : db.get<{ id: string }>('SELECT id FROM accounts WHERE lower(email) = ?', who.email.trim().toLowerCase());
  if (!acc) throw new Error('no such account');
  const now = clock.now();
  const revoked = db.tx(() => revokeAccountSessions(db, acc.id, now));
  appendDeletion(logPath, { kind: 'revoke', accountId: acc.id, at: now });
  return { accountId: acc.id, revoked };
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const USAGE = `usage: node dist/server/src/cli.js <command>
  backup                                   write a snapshot to BACKUP_DIR now (+ retention)
  restore <file.db.gz>                     API stopped! replace DB_PATH with the backup, new epoch
  restore-revision --profile <id> --rev <n>      make an old revision the head again
  restore-revision --profile <id> --stash <id>   make a stashed copy the head
  flags [--match <id>]                     versus seats the server flagged
  revoke --account <id> | --email <addr>   sign that account out on every device
  vacuum                                   API stopped! give free pages in the DB file back to the disk
  purge                                    run the housekeeping clean-up now`;

export async function runCli(argv: string[], env: Record<string, string | undefined> = process.env, out: (s: string) => void = (s) => process.stdout.write(s + '\n')): Promise<number> {
  const [cmd, ...args] = argv;
  const o = opsEnv(env);
  const clock = systemClock;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    out(USAGE);
    return cmd ? 0 : 2;
  }
  if (cmd === 'restore') {
    const file = args[0];
    if (!file) {
      out(USAGE);
      return 2;
    }
    const r = await restoreDatabase(file, o.dbPath, clock, { deletionLog: deletionLogPath(o.backupDir) });
    out(`restored ${file} into ${o.dbPath}`);
    if (r.keptOld) out(`the previous database was kept as ${r.keptOld}`);
    out(`deleted accounts removed again: ${r.reapplied.accountsDeleted}, sessions revoked again: ${r.reapplied.sessionsRevoked}`);
    if (r.reapplied.skipped > 0) out(`warning: ${r.reapplied.skipped} unreadable line(s) in ${deletionLogPath(o.backupDir)} were skipped`);
    out(`new epoch: ${r.epoch}`);
    return 0;
  }
  if (cmd === 'vacuum') {
    if (!existsSync(o.dbPath)) throw new Error(`no database at ${o.dbPath}`);
    checkpointAlone(o.dbPath); // DatabaseInUseError while the API runs
    const before = statSync(o.dbPath).size;
    const v = openDb(o.dbPath);
    try {
      v.exec('VACUUM');
      v.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      v.close();
    }
    out(`vacuum: ${before} → ${statSync(o.dbPath).size} bytes`);
    return 0;
  }
  mkdirSync(dirname(o.dbPath), { recursive: true });
  const db = openDb(o.dbPath);
  try {
    await migrate(db, { clock });
    switch (cmd) {
      case 'backup': {
        const f = await runBackup(db, clock, { dir: o.backupDir, keepRecent: o.keepRecent, keepDaily: o.keepDaily });
        out(`backup written: ${f}`);
        return 0;
      }
      case 'restore-revision': {
        const profile = arg(args, '--profile');
        const rev = arg(args, '--rev');
        const stash = arg(args, '--stash');
        if (!profile || (rev === undefined) === (stash === undefined)) {
          out(USAGE);
          return 2;
        }
        const head = restoreRevision(db, clock, profile, rev !== undefined ? { rev: Number(rev) } : { stash: stash! });
        out(`new head for ${profile}: epoch ${head.epoch} rev ${head.rev} (day ${head.meta.day}, ${head.sizeGz} bytes)`);
        return 0;
      }
      case 'flags': {
        const rows = listFlags(db, arg(args, '--match'));
        for (const r of rows) out(JSON.stringify(r));
        if (rows.length === 0) out('no flagged seats');
        return 0;
      }
      case 'revoke': {
        const account = arg(args, '--account');
        const email = arg(args, '--email');
        if ((account === undefined) === (email === undefined)) {
          out(USAGE);
          return 2;
        }
        const r = revokeSessions(db, clock, deletionLogPath(o.backupDir), account !== undefined ? { account } : { email: email! });
        out(`revoked ${r.revoked} session(s) of account ${r.accountId}`);
        return 0;
      }
      case 'purge': {
        out(JSON.stringify(runHousekeeping(db, clock.now())));
        return 0;
      }
      default:
        out(USAGE);
        return 2;
    }
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`error: ${(err as Error).message ?? err}\n`);
      process.exit(1);
    },
  );
}
