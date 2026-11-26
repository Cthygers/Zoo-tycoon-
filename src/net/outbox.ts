// Versus outbox (spec §5.6, review S7): one queue per account + match in wh2:outbox:<accountId>:<matchId>,
// flushed only with that account's session. Classification of every answer:
//   2xx (or a duplicate) → drop what was acknowledged; 401 → keep, needs-signin;
//   network / timeout / 5xx / 429 / 507 → back off (5 s … 5 min); any other 4xx → the queue moves to
//   wh2:outbox-dead:<accountId>:<matchId> ({code, at, items}) and the match says "We couldn't send this
//   match's score". One match never waits for another.
import type { FinishBody, MatchDto, SnapshotsBody, SnapshotsResponse, VersusSnapshot } from '../../shared/api-types';
import { SNAPSHOTS_PER_CALL } from '../../shared/limits';
import type { FlushResult, OutboxState } from '../core/cloud-types';
import { KEYS } from '../core/storage-keys';
import type { CloudApi } from './cloudApi';
import { utf8Length } from './codec';
import { asFailure, isOfflineFailure, type ApiFailure } from './http';
import { BACKOFF_S } from './sync';
import type { LocalStoreImpl } from './storage';

export type OutboxItem = { kind: 'snapshots'; h: number; snap: VersusSnapshot } | { kind: 'finish'; body: FinishBody };

export interface OutboxRecord {
  profileId: string;
  items: OutboxItem[];
  lastAck: SnapshotsResponse | null;
  finishSent?: boolean;
  finishMatch?: MatchDto | null;
}

export interface DeadRecord { code: string; at: number; items: OutboxItem[]; profileId?: string }

export interface OutboxDeps {
  enabled: boolean;
  local: LocalStoreImpl;
  api: CloudApi;
  now: () => number;
  /** Signed-in (or needs-signin) account; null for the guest. */
  session: () => { accountId: string; signedIn: boolean } | null;
  onUnauthorized: () => void;
  random?: () => number;
}

type AckFn = (matchId: string, res: SnapshotsResponse | MatchDto) => void;

export class OutboxManager {
  private readonly d: OutboxDeps;
  private readonly backoff = new Map<string, { attempt: number; nextAt: number }>();
  private readonly running = new Map<string, Promise<FlushResult>>();
  private readonly ackFns = new Set<AckFn>();

  constructor(deps: OutboxDeps) {
    this.d = deps;
  }

  onAck(fn: AckFn): () => void {
    this.ackFns.add(fn);
    return () => {
      this.ackFns.delete(fn);
    };
  }

  private emitAck(matchId: string, res: SnapshotsResponse | MatchDto): void {
    for (const fn of [...this.ackFns]) {
      try {
        fn(matchId, res);
      } catch (e) {
        console.error('[net] outbox ack listener failed', e);
      }
    }
  }

  private read(accountId: string, matchId: string): OutboxRecord | null {
    const raw = this.d.local.getRaw(KEYS.outbox(accountId, matchId));
    if (!raw) return null;
    try {
      const r = JSON.parse(raw) as OutboxRecord;
      return r && Array.isArray(r.items) ? r : null;
    } catch {
      return null;
    }
  }

  private write(accountId: string, matchId: string, rec: OutboxRecord): boolean {
    return this.d.local.setRaw(KEYS.outbox(accountId, matchId), JSON.stringify(rec));
  }

  private readDead(accountId: string, matchId: string): DeadRecord | null {
    const raw = this.d.local.getRaw(KEYS.outboxDead(accountId, matchId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DeadRecord;
    } catch {
      return { code: 'unknown', at: 0, items: [] };
    }
  }

  private accountFor(profileId: string): string | null {
    return this.d.local.accountOfProfile(profileId) ?? this.d.session()?.accountId ?? null;
  }

  /** Persisted synchronously; a snapshot at an hour already acknowledged or queued is replaced/dropped. */
  enqueueSnapshots(matchId: string, profileId: string, snaps: VersusSnapshot[]): void {
    if (!this.d.enabled || snaps.length === 0) return;
    const acc = this.accountFor(profileId);
    if (!acc) return;
    const rec = this.read(acc, matchId) ?? { profileId, items: [], lastAck: null };
    const acked = rec.lastAck?.ackHour ?? 0;
    for (const snap of snaps) {
      if (snap.h <= acked) continue;
      const i = rec.items.findIndex((x) => x.kind === 'snapshots' && x.h === snap.h);
      const item: OutboxItem = { kind: 'snapshots', h: snap.h, snap };
      if (i >= 0) rec.items[i] = item;
      else rec.items.push(item);
    }
    rec.items = [
      ...rec.items.filter((x): x is Extract<OutboxItem, { kind: 'snapshots' }> => x.kind === 'snapshots').sort((a, b) => a.h - b.h),
      ...rec.items.filter((x) => x.kind === 'finish'),
    ];
    if (!this.write(acc, matchId, rec)) console.warn('[net] could not store the match outbox');
  }

  enqueueFinish(matchId: string, profileId: string, body: FinishBody): void {
    if (!this.d.enabled) return;
    const acc = this.accountFor(profileId);
    if (!acc) return;
    const rec = this.read(acc, matchId) ?? { profileId, items: [], lastAck: null };
    rec.items = [...rec.items.filter((x) => x.kind !== 'finish'), { kind: 'finish', body }];
    if (!this.write(acc, matchId, rec)) console.warn('[net] could not store the match outbox');
  }

  state(matchId: string): OutboxState {
    const s = this.d.session();
    const empty: OutboxState = { pending: 0, lastAck: null, dead: null, finishSent: false, finishMatch: null };
    if (!this.d.enabled || !s) return empty;
    const rec = this.read(s.accountId, matchId);
    const dead = this.readDead(s.accountId, matchId);
    return {
      pending: rec?.items.length ?? 0,
      lastAck: rec?.lastAck ?? null,
      dead: dead ? { code: dead.code, at: dead.at } : null,
      finishSent: rec?.finishSent === true,
      finishMatch: rec?.finishMatch ?? null,
    };
  }

  private scheduleBackoff(matchId: string, f: ApiFailure): void {
    const prev = this.backoff.get(matchId);
    const attempt = (prev?.attempt ?? 0) + 1;
    let ms = BACKOFF_S[Math.min(attempt, BACKOFF_S.length) - 1]! * 1000 * (1 + ((this.d.random ?? Math.random)() * 0.4 - 0.2));
    if (f.status === 507) ms = 30 * 60_000;
    if (f.retryAfterMs !== undefined) ms = Math.max(ms, f.retryAfterMs);
    this.backoff.set(matchId, { attempt, nextAt: this.d.now() + Math.round(ms) });
  }

  /** Classify a failed send (S7). */
  private failed(accountId: string, matchId: string, e: unknown): FlushResult {
    const f = asFailure(e);
    if (f.status === 401) {
      this.d.onUnauthorized();
      return 'needs-signin';
    }
    if (isOfflineFailure(f) || f.status >= 500 || f.status === 429 || f.status === 507 || f.code === 'disabled') {
      this.scheduleBackoff(matchId, f);
      return isOfflineFailure(f) ? 'offline' : 'backoff';
    }
    // permanent: park the queue so it never blocks this match's later state, nor any other match
    const rec = this.read(accountId, matchId);
    const dead: DeadRecord = { code: f.code, at: this.d.now(), items: rec?.items ?? [], profileId: rec?.profileId };
    this.d.local.setRaw(KEYS.outboxDead(accountId, matchId), JSON.stringify(dead));
    this.d.local.removeRaw(KEYS.outbox(accountId, matchId));
    this.backoff.delete(matchId);
    return 'dead';
  }

  private applySnapshotsAck(accountId: string, matchId: string, res: SnapshotsResponse): number {
    const rec = this.read(accountId, matchId);
    if (!rec) return 0;
    const before = rec.items.length;
    rec.items = rec.items.filter((x) => !(x.kind === 'snapshots' && x.h <= res.ackHour));
    rec.lastAck = res;
    this.write(accountId, matchId, rec);
    this.emitAck(matchId, res);
    return before - rec.items.length;
  }

  private applyFinishAck(accountId: string, matchId: string, match: MatchDto): void {
    const rec = this.read(accountId, matchId);
    if (rec) {
      rec.items = rec.items.filter((x) => x.kind !== 'finish');
      rec.finishSent = true;
      rec.finishMatch = match;
      this.write(accountId, matchId, rec);
    }
    this.emitAck(matchId, match);
  }

  /** Send everything queued for this match (snapshots in batches of ≤ 48, then the finish). */
  flush(matchId: string): Promise<FlushResult> {
    const running = this.running.get(matchId);
    if (running) return running;
    const p = this.flushOnce(matchId).finally(() => this.running.delete(matchId));
    this.running.set(matchId, p);
    return p;
  }

  private async flushOnce(matchId: string): Promise<FlushResult> {
    if (!this.d.enabled) return 'offline';
    const s = this.d.session();
    if (!s || !s.signedIn) return 'needs-signin';
    const acc = s.accountId;
    if (this.readDead(acc, matchId)) return 'dead';
    let rec = this.read(acc, matchId);
    if (!rec || rec.items.length === 0) return 'empty';
    const b = this.backoff.get(matchId);
    if (b && b.nextAt > this.d.now()) return 'backoff';
    for (let guard = 0; guard < 64; guard++) {
      rec = this.read(acc, matchId);
      if (!rec || rec.items.length === 0) break;
      const snaps = rec.items.filter((x): x is Extract<OutboxItem, { kind: 'snapshots' }> => x.kind === 'snapshots').slice(0, SNAPSHOTS_PER_CALL);
      if (snaps.length > 0) {
        const body: SnapshotsBody = { profileId: rec.profileId, snapshots: snaps.map((x) => x.snap) };
        try {
          const res = await this.d.api.postSnapshots(matchId, body);
          if (this.d.session()?.accountId !== acc) return 'needs-signin';
          if (this.applySnapshotsAck(acc, matchId, res) === 0) break; // nothing acknowledged: stop, don't spin
        } catch (e) {
          return this.failed(acc, matchId, e);
        }
        continue;
      }
      const fin = rec.items.find((x): x is Extract<OutboxItem, { kind: 'finish' }> => x.kind === 'finish');
      if (!fin) break;
      try {
        const res = await this.d.api.finish(matchId, fin.body);
        this.applyFinishAck(acc, matchId, res.match);
      } catch (e) {
        return this.failed(acc, matchId, e);
      }
    }
    this.backoff.delete(matchId);
    return 'sent';
  }

  /**
   * At most one keepalive request (page hide) whose JSON body fits maxBytes: the oldest snapshots that fit,
   * or the finish when only it is left. Returns the body size (0 when nothing was sent).
   */
  flushKeepalive(matchId: string, maxBytes: number): number {
    if (!this.d.enabled) return 0;
    const s = this.d.session();
    if (!s || !s.signedIn) return 0;
    const acc = s.accountId;
    if (this.readDead(acc, matchId)) return 0;
    const rec = this.read(acc, matchId);
    if (!rec || rec.items.length === 0) return 0;
    const snaps = rec.items.filter((x): x is Extract<OutboxItem, { kind: 'snapshots' }> => x.kind === 'snapshots').slice(0, SNAPSHOTS_PER_CALL);
    if (snaps.length > 0) {
      let n = snaps.length;
      let body: SnapshotsBody = { profileId: rec.profileId, snapshots: snaps.slice(0, n).map((x) => x.snap) };
      while (n > 0 && utf8Length(JSON.stringify(body)) > maxBytes) {
        n--;
        body = { profileId: rec.profileId, snapshots: snaps.slice(0, n).map((x) => x.snap) };
      }
      if (n === 0) return 0;
      const sent = this.d.api.keepalive({ kind: 'snapshots', matchId, body }, maxBytes);
      if (!sent) return 0;
      void sent.done.then((r) => {
        if (r.ok && r.value && typeof (r.value as SnapshotsResponse).ackHour === 'number') this.applySnapshotsAck(acc, matchId, r.value as SnapshotsResponse);
      });
      return sent.bytes;
    }
    const fin = rec.items.find((x): x is Extract<OutboxItem, { kind: 'finish' }> => x.kind === 'finish');
    if (!fin) return 0;
    const sent = this.d.api.keepalive({ kind: 'finish', matchId, body: fin.body }, maxBytes);
    if (!sent) return 0;
    void sent.done.then((r) => {
      const m = r.ok ? (r.value as { match?: MatchDto } | undefined)?.match : undefined;
      if (m) this.applyFinishAck(acc, matchId, m);
    });
    return sent.bytes;
  }

  /** Match ids with a queue of the signed-in account. */
  queuedMatches(): string[] {
    const s = this.d.session();
    if (!this.d.enabled || !s) return [];
    const prefix = `wh2:outbox:${s.accountId}:`;
    return this.d.local.listKeys(prefix).map((k) => k.slice(prefix.length));
  }

  /** Flush every queue of the signed-in account, each on its own (one never waits for another). */
  async flushAll(): Promise<FlushResult[]> {
    return Promise.all(this.queuedMatches().map((id) => this.flush(id)));
  }

  /** Reset backoff (online event, resume). */
  resetBackoff(): void {
    this.backoff.clear();
  }
}
