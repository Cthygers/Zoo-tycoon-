// SyncEngine (spec §3.7–§3.10): keeps each profile's main slot in step with the server without ever
// overwriting a save made more recently elsewhere. Ordering comes only from the server ({epoch, rev}
// compare-and-swap); device clocks are display only. Whatever loses a decision is kept (local backup +
// server stash or keep_local pin). One async mutex per engine; operations are keyed by slot.
// No @capacitor/* imports and no DOM access at import time.
import type { LeaseConflictDetails, SaveHead, SaveRef, StashReason } from '../../shared/api-types';
import { UNIQUE_PLAY_THRESHOLD_S } from '../../shared/limits';
import type {
  ConflictInfo, LeaseLostInfo, OpenedSlot, ResumeResult, SaveCard, SlotUiState, SyncEngine, SyncEvents, SyncPrompts,
} from '../core/cloud-types';
import type { SlotKey } from '../core/contracts';
import { parseSlotKey } from '../core/storage-keys';
import type { CloudApi } from './cloudApi';
import { base64ToBytes, gunzipToString, sha256HexSync, sha256OfB64Sync, uuid } from './codec';
import { ApiFailure, asFailure, isOfflineFailure } from './http';
import { isDirty, type LocalStoreImpl, type PendingPush, type SlotBase, type SlotRecord } from './storage';

/** SimSave versions this build can load (src/sim/simulation.ts SAVE_VERSION). */
export const SUPPORTED_SAVE_VERSION = 1;
export const RING_MAX = 4;
export const RING_KEEP_MS = 60_000;
export const PUSH_EVERY_MS = 3 * 60_000;
export const RENEW_EVERY_MS = 60_000;
export const LEASE_TIMEOUT_MS = 4_000;
export const RESUME_HOLD_MS = 2_000;
export const RESUME_AFTER_HIDDEN_MS = 60_000;
export const LEAVE_BUDGET_MS = 3_000;
export const MAX_CAS_ROUNDS = 3;
export const STASH_MIN_PLAY_S = 30;
export const BACKOFF_S = [5, 15, 45, 120, 300] as const;
export const SERVER_FULL_BACKOFF_MS = 30 * 60_000;
export const LEASE_FALLBACK_MS = 150_000;
/** Reserved for the lease release when a keepalive push shares the page-hide budget. */
export const RELEASE_RESERVE_BYTES = 256;

// ------------------------------------------------------------------ the decision (spec §3.7)
export type Action =
  | { kind: 'in_sync' }
  | { kind: 'adopt' }
  | { kind: 'push'; base: SaveRef | null; keepLocal: boolean }
  | { kind: 'pull'; keepLocalCopy: boolean }
  | { kind: 'conflict' }
  | { kind: 'blocked'; reason: 'newer_version' };

/** What decide() needs of a slot record. */
export interface DecideRecord {
  hasData: boolean;
  dirty: boolean;
  base: SlotBase | null;
  playSeconds: number;
  /** Given up locally (lease lost → other): pull whatever the cloud has. */
  forcePull?: boolean;
  pinNext?: boolean;
}

export function toDecideRecord(r: SlotRecord | null): DecideRecord {
  if (!r) return { hasData: false, dirty: false, base: null, playSeconds: 0 };
  return { hasData: true, dirty: isDirty(r), base: r.base, playSeconds: r.meta.playSeconds, forcePull: r.forcePull, pinNext: r.pinNext };
}

const refOf = (h: SaveRef): SaveRef => ({ epoch: h.epoch, rev: h.rev });

/** S2: both sides diverged; resolve by unique play time. */
export function divergence(R: DecideRecord, H: SaveHead): Action {
  const b = R.base?.playSeconds ?? 0;
  const L = R.playSeconds - b;
  const C = H.meta.playSeconds - b;
  const T = UNIQUE_PLAY_THRESHOLD_S;
  if (L < T && C >= L) return { kind: 'pull', keepLocalCopy: true };
  if (C < T && L > C) return { kind: 'push', base: refOf(H), keepLocal: true };
  return { kind: 'conflict' };
}

/** spec §3.7 decide(), with `localSha` = sha256 of the local gzip bytes (only read when base is null). */
export function decide(R: DecideRecord, H: SaveHead | null, localSha: () => string): Action {
  if (H && H.saveVersion > SUPPORTED_SAVE_VERSION) return { kind: 'blocked', reason: 'newer_version' };
  if (!R.hasData) return H ? { kind: 'pull', keepLocalCopy: false } : { kind: 'in_sync' };
  if (R.forcePull && H) return { kind: 'pull', keepLocalCopy: false };
  if (!H) return { kind: 'push', base: null, keepLocal: false };
  if (!R.base) return H.sha256 === localSha() ? { kind: 'adopt' } : divergence(R, H);
  if (H.epoch === R.base.epoch && H.rev >= R.base.rev) {
    if (H.rev === R.base.rev) return R.dirty ? { kind: 'push', base: refOf(R.base), keepLocal: !!R.pinNext } : { kind: 'in_sync' };
    return R.dirty ? divergence(R, H) : { kind: 'pull', keepLocalCopy: false };
  }
  // epoch differs (server restored from a backup) or rev went backwards: re-decide by play time
  if (R.playSeconds >= H.meta.playSeconds) return { kind: 'push', base: refOf(H), keepLocal: true };
  return R.dirty ? divergence(R, H) : { kind: 'pull', keepLocalCopy: false };
}

// ------------------------------------------------------------------ engine
export interface SyncSession {
  accountId: string;
  /** false while 'needs-signin' (nothing is sent). */
  signedIn: boolean;
}

export interface SyncDeps {
  api: CloudApi;
  local: LocalStoreImpl;
  now: () => number;
  device: () => { id: string; name: string };
  session: () => SyncSession | null;
  /** A 401: the session is gone (auth → needs-signin). */
  onUnauthorized: () => void;
  /** 410/404 on a profile: removed on another device. */
  onProfileGone: (pid: string) => void;
  isProfileGone: (pid: string) => boolean;
  profileName: (pid: string) => string;
  /** Status recompute (pending count, syncing, conflict keys). */
  onChange?: () => void;
  random?: () => number;
}

type Outcome =
  | { kind: 'skipped' }
  | { kind: 'in_sync' }
  | { kind: 'pushed' }
  | { kind: 'pulled'; fromDevice: string; autoBackup: boolean }
  | { kind: 'conflict'; info: ConflictInfo }
  | { kind: 'blocked'; reason: 'newer_version' | 'too_large' | 'quota' | 'rejected' }
  | { kind: 'leased'; details: LeaseConflictDetails }
  | { kind: 'failed'; failure: ApiFailure }
  | { kind: 'signin' }
  | { kind: 'gone' };

type PushResult = { kind: 'done' } | { kind: 'retry'; head: SaveHead | null | undefined } | Outcome;

interface Backoff { attempt: number; nextAt: number; timer: ReturnType<typeof setTimeout> | null }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve with `fallback` after `ms` unless `p` settles first (p keeps running). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => t !== undefined && clearTimeout(t)),
    new Promise<T>((r) => {
      t = setTimeout(() => r(fallback), ms);
    }),
  ]);
}

export class SyncEngineImpl implements SyncEngine {
  private readonly d: SyncDeps;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly backoffs = new Map<SlotKey, Backoff>();
  private readonly lastPushAt = new Map<SlotKey, number>();
  private readonly leaseHeld = new Set<SlotKey>();
  private readonly leaseLostPending = new Set<SlotKey>();
  private readonly listeners = new Map<keyof SyncEvents, Set<(p: never) => void>>();
  private activeKey: SlotKey | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private visible = true;
  private running = 0;
  private offline = false;
  private disposed = false;
  lastSyncAt = 0;
  lastError: string | null = null;

  constructor(deps: SyncDeps) {
    this.d = deps;
  }

  // ================================================================ small helpers
  on<E extends keyof SyncEvents>(e: E, fn: (p: SyncEvents[E]) => void): () => void {
    let set = this.listeners.get(e);
    if (!set) this.listeners.set(e, (set = new Set()));
    set.add(fn as (p: never) => void);
    return () => {
      set!.delete(fn as (p: never) => void);
    };
  }

  private emit<E extends keyof SyncEvents>(e: E, p: SyncEvents[E]): void {
    for (const fn of [...(this.listeners.get(e) ?? [])]) {
      try {
        (fn as (p: SyncEvents[E]) => void)(p);
      } catch (err) {
        console.error('[net] sync listener failed', err);
      }
    }
  }

  private changed(): void {
    try {
      this.d.onChange?.();
    } catch (e) {
      console.error('[net] status update failed', e);
    }
  }

  /** One async mutex per engine. */
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private pidOf(key: SlotKey): string | null {
    try {
      const { player, slot } = parseSlotKey(key);
      return player !== 'guest' && slot === 'main' ? player : null;
    } catch {
      return null;
    }
  }

  /** A synced slot of the signed-in account (profile main, not gone). */
  private syncable(key: SlotKey): boolean {
    const pid = this.pidOf(key);
    const s = this.d.session();
    if (!pid || !s || !s.signedIn || this.d.isProfileGone(pid)) return false;
    return this.accountOf(key, pid) === s.accountId;
  }

  /** Is this slot ours to show sync state for (any session state)? */
  private ownSlot(key: SlotKey): boolean {
    const pid = this.pidOf(key);
    const s = this.d.session();
    if (!pid || !s) return false;
    return this.accountOf(key, pid) === s.accountId;
  }

  /** Account of a slot: its record's, or (record made before the player was known) the cached one. */
  private accountOf(key: SlotKey, pid: string): string | null {
    const r = this.d.local.getRecord(key);
    if (r && r.accountId) return r.accountId;
    const acc = this.d.local.accountOfProfile(pid);
    if (r && acc) this.d.local.updateRecord(key, (x) => { x.accountId = acc; });
    return acc;
  }

  private card(r: SlotRecord | null, h: SaveHead | null, here: boolean, unique: number, newest: boolean, playingNow: boolean): SaveCard {
    if (here) {
      return {
        deviceName: this.d.device().name, thisDevice: true, meta: r!.meta, savedAt: r!.savedAt,
        uniquePlaySeconds: Math.max(0, unique), newest, playingNow,
      };
    }
    return {
      deviceName: h?.device.name ?? 'Another device', thisDevice: !!h && h.device.id === this.d.device().id,
      meta: h!.meta, savedAt: h!.clientSavedAt ?? h!.savedAt, uniquePlaySeconds: Math.max(0, unique), newest, playingNow,
    };
  }

  private conflictInfo(r: SlotRecord, h: SaveHead, playingNow = false): ConflictInfo {
    const b = r.base?.playSeconds ?? 0;
    const L = r.meta.playSeconds - b;
    const C = h.meta.playSeconds - b;
    return {
      profileName: this.d.profileName(r.profileId),
      here: this.card(r, null, true, L, L >= C, false),
      other: this.card(null, h, false, C, C > L, playingNow),
    };
  }

  private leaseLostInfo(r: SlotRecord, h: SaveHead | null, holder: string | null): LeaseLostInfo {
    const b = r.base?.playSeconds ?? 0;
    const L = r.meta.playSeconds - b;
    const head: SaveHead = h ?? {
      epoch: r.base?.epoch ?? '', rev: r.base?.rev ?? 0, sha256: r.base?.sha256 ?? '', sizeGz: 0, sizeRaw: 0, saveVersion: r.saveVersion,
      appVersion: '', meta: { ...r.meta, playSeconds: b }, device: { id: '', name: holder ?? 'Another device' },
      savedAt: r.syncedAt ?? r.savedAt, clientSavedAt: null, pushId: '',
    };
    const C = head.meta.playSeconds - b;
    const other = this.card(null, head, false, C, C > L, true);
    if (holder) other.deviceName = holder;
    // the other card is the device holding the lease now, even when the latest push came from this one
    other.thisDevice = false;
    return {
      profileName: this.d.profileName(r.profileId),
      here: this.card(r, null, true, L, L >= C, false),
      other,
      localDeltaSeconds: Math.max(0, L),
      since: r.syncedAt ?? r.savedAt,
    };
  }

  // ================================================================ failures and backoff
  private clearBackoff(key: SlotKey): void {
    const b = this.backoffs.get(key);
    if (b?.timer) clearTimeout(b.timer);
    this.backoffs.delete(key);
  }

  private inBackoff(key: SlotKey): boolean {
    const b = this.backoffs.get(key);
    return !!b && b.nextAt > this.d.now();
  }

  private scheduleRetry(key: SlotKey, f: ApiFailure | null, minMs = 0): void {
    if (this.disposed) return;
    const prev = this.backoffs.get(key);
    if (prev?.timer) clearTimeout(prev.timer);
    const attempt = (prev?.attempt ?? 0) + 1;
    const base = BACKOFF_S[Math.min(attempt, BACKOFF_S.length) - 1]! * 1000;
    const jitter = 1 + ((this.d.random ?? Math.random)() * 0.4 - 0.2);
    let ms = Math.round(base * jitter);
    if (f?.status === 507) ms = SERVER_FULL_BACKOFF_MS;
    if (f?.retryAfterMs !== undefined) ms = Math.max(ms, f.retryAfterMs);
    ms = Math.max(ms, minMs);
    const b: Backoff = { attempt, nextAt: this.d.now() + ms, timer: null };
    b.timer = setTimeout(() => {
      b.timer = null;
      void this.background(key, { retry: true });
    }, ms);
    this.backoffs.set(key, b);
  }

  private fail(key: SlotKey, e: unknown): Outcome {
    const f = asFailure(e);
    const pid = this.pidOf(key);
    if (f.status === 401) {
      this.d.onUnauthorized();
      return { kind: 'signin' };
    }
    if (pid && (f.status === 410 || (f.status === 404 && f.code === 'not_found'))) {
      this.d.onProfileGone(pid);
      this.emit('profileGone', { profileId: pid });
      return { kind: 'gone' };
    }
    if (isOfflineFailure(f)) this.offline = true;
    if (f.status === 507) this.emit('blocked', { key, reason: 'server_full' });
    this.lastError = isOfflineFailure(f) || f.status >= 500 || f.status === 429 || f.status === 507 ? null : f.message;
    this.scheduleRetry(key, f);
    return { kind: 'failed', failure: f };
  }

  private ok(key: SlotKey): void {
    this.offline = false;
    this.lastError = null;
    this.clearBackoff(key);
    this.lastSyncAt = this.d.now();
  }

  // ================================================================ the slot sync (inside the lock)
  private commitSynced(key: SlotKey, ref: SaveRef, entry: PendingPush): void {
    this.d.local.updateRecord(key, (r) => {
      // never move base back to an older revision of the same lineage
      const newer = !r.base || (r.base.epoch === ref.epoch ? ref.rev >= r.base.rev : entry.seq > r.syncedSeq);
      if (newer) {
        r.base = { epoch: ref.epoch, rev: ref.rev, playSeconds: entry.playSeconds, sha256: entry.sha256 };
        r.syncedSeq = Math.max(r.syncedSeq, entry.seq);
        r.syncedAt = this.d.now();
        r.forcePull = false;
        if (r.syncedSeq >= r.seq) r.pinNext = false;
      }
      r.pending = r.pending.filter((p) => p.seq > entry.seq);
      if (r.state === 'waiting' || r.state === 'conflict') r.state = 'ok';
      delete r.waitUntil;
    });
  }

  private async syncLocked(key: SlotKey, mode: { opening?: boolean; force?: boolean }): Promise<Outcome> {
    if (!this.syncable(key)) return { kind: 'skipped' };
    const pid = this.pidOf(key)!;
    let R = this.d.local.getRecord(key);
    if (R?.localOnly) return { kind: 'skipped' };
    if (R?.state === 'blocked' && R.blocked !== 'newer_version' && !(R.blocked === 'profile_deleted' && mode.force)) {
      return { kind: 'blocked', reason: R.blocked === 'quota' ? 'quota' : R.blocked === 'rejected' ? 'rejected' : 'too_large' };
    }
    if (R?.state === 'conflict' && !mode.opening && !mode.force) return { kind: 'skipped' };
    // the lease was lost while this run waited for the lock: nothing goes up until the player chose (§3.8)
    if (this.leaseLostPending.has(key) && !mode.opening) return { kind: 'skipped' };
    if (R?.state === 'waiting' && R.waitUntil && R.waitUntil > this.d.now() && !mode.opening && !mode.force) return { kind: 'skipped' };
    this.running++;
    this.changed();
    try {
      let H: SaveHead | null | undefined; // undefined = fetch the head
      for (let round = 0; round < MAX_CAS_ROUNDS; round++) {
        R = this.d.local.getRecord(key);
        if (H === undefined) {
          const ring = (R?.pending ?? []).map((p) => p.pushId);
          let res;
          try {
            res = await this.d.api.getHead(pid, ring);
          } catch (e) {
            return this.fail(key, e);
          }
          H = res.head;
          if (res.pushed && R) {
            const entry = R.pending.find((p) => p.pushId === res.pushed!.pushId);
            if (entry) this.commitSynced(key, res.pushed, entry);
          }
          // ring entries older than 60 s that did not land will not land any more (S5)
          const now = this.d.now();
          this.d.local.updateRecord(key, (r) => {
            r.pending = r.pending.filter((p) => now - p.startedAt < RING_KEEP_MS);
          });
          R = this.d.local.getRecord(key);
        }
        if (R && R.state === 'blocked' && R.blocked === 'newer_version' && !(H && H.saveVersion > SUPPORTED_SAVE_VERSION)) {
          this.d.local.updateRecord(key, (r) => {
            r.state = 'ok';
            delete r.blocked;
          });
          R = this.d.local.getRecord(key);
        }
        const DR = toDecideRecord(R);
        const action = decide(DR, H, () => (R ? sha256OfB64Sync(R.gz) : ''));
        switch (action.kind) {
          case 'in_sync':
            if (R && R.state !== 'ok') this.d.local.updateRecord(key, (r) => { r.state = 'ok'; delete r.waitUntil; });
            this.ok(key);
            return { kind: 'in_sync' };
          case 'adopt':
            this.d.local.updateRecord(key, (r) => {
              r.base = { epoch: H!.epoch, rev: H!.rev, playSeconds: H!.meta.playSeconds, sha256: H!.sha256 };
              r.syncedSeq = r.seq;
              r.syncedAt = this.d.now();
              r.pending = [];
              r.state = 'ok';
            });
            this.ok(key);
            return { kind: 'in_sync' };
          case 'blocked':
            this.d.local.updateRecord(key, (r) => {
              r.state = 'blocked';
              r.blocked = 'newer_version';
            });
            this.emit('blocked', { key, reason: 'newer_version' });
            this.ok(key);
            return { kind: 'blocked', reason: 'newer_version' };
          case 'push': {
            const res = await this.push(key, R!, action.base, action.keepLocal || !!R!.pinNext);
            if (res.kind === 'done') {
              this.ok(key);
              return { kind: 'pushed' };
            }
            if (res.kind === 'retry') {
              H = res.head;
              continue;
            }
            return res;
          }
          case 'pull': {
            const res = await this.pull(key, R, H!, action.keepLocalCopy);
            if (res === 'changed') {
              H = undefined;
              continue;
            }
            if (res.kind === 'pulled') this.ok(key);
            return res;
          }
          case 'conflict':
            return await this.enterConflict(key, R!, H!);
        }
      }
      // the 412 race did not settle in MAX_CAS_ROUNDS: back off (S-9)
      const f = new ApiFailure(412, 'conflict', 'The cloud save kept changing.');
      this.scheduleRetry(key, f);
      return { kind: 'failed', failure: f };
    } finally {
      this.running--;
      this.changed();
    }
  }

  private async push(key: SlotKey, R: SlotRecord, base: SaveRef | null, keepLocal: boolean): Promise<PushResult> {
    const pid = R.profileId;
    let sha: string;
    try {
      sha = sha256HexSync(base64ToBytes(R.gz));
    } catch {
      return { kind: 'blocked', reason: 'rejected' };
    }
    const entry = this.ringEntry(key, R, sha);
    if (!entry) return this.fail(key, new ApiFailure(0, 'network', 'Could not store the pending push'));
    this.lastPushAt.set(key, this.d.now());
    try {
      const res = await this.d.api.putSave(pid, {
        base: base ? refOf(base) : null,
        pushId: entry.pushId,
        saveVersion: R.saveVersion,
        meta: R.meta,
        clientSavedAt: R.savedAt,
        encoding: 'gzip+base64',
        data: R.gz,
        sha256: sha,
        ...(keepLocal ? { resolution: 'keep_local' as const } : {}),
      });
      if (res.replay && res.head.pushId !== entry.pushId) return { kind: 'retry', head: undefined }; // landed earlier, built on since
      this.commitSynced(key, res.head, entry);
      return { kind: 'done' };
    } catch (e) {
      const f = asFailure(e);
      if (f.status === 412) {
        const dh = (f.details as { head?: SaveHead | null } | undefined)?.head ?? null;
        const mine = dh ? this.d.local.getRecord(key)?.pending.find((p) => p.pushId === dh.pushId) : undefined;
        if (dh && mine) this.commitSynced(key, dh, mine); // S5/S-8d: our earlier push landed late
        return { kind: 'retry', head: dh };
      }
      if (f.status === 409 && f.code === 'leased_elsewhere') {
        return { kind: 'leased', details: (f.details ?? { holder: { deviceName: 'Another device', lastSeenAt: 0 }, head: null }) as unknown as LeaseConflictDetails };
      }
      if (f.status === 413 || f.status === 422 || f.status === 426) {
        const reason = f.status === 426 ? 'newer_version' : f.code === 'quota' ? 'quota' : f.status === 413 ? 'too_large' : 'rejected';
        this.d.local.updateRecord(key, (r) => {
          r.state = 'blocked';
          r.blocked = reason;
          r.blockedHash = r.contentHash;
        });
        if (reason !== 'rejected') this.emit('blocked', { key, reason });
        else console.warn('[net] the server refused this zoo', f.code, f.message);
        return { kind: 'blocked', reason };
      }
      return this.fail(key, f);
    }
  }

  /** The ring entry for the record's current content (reused when the newest one has the same seq). */
  private ringEntry(key: SlotKey, R: SlotRecord, sha: string): PendingPush | null {
    const newest = R.pending[R.pending.length - 1];
    if (newest && newest.seq === R.seq) return newest;
    const entry: PendingPush = { pushId: uuid(), seq: R.seq, startedAt: this.d.now(), playSeconds: R.meta.playSeconds, sha256: sha };
    const saved = this.d.local.updateRecord(key, (r) => {
      r.pending = [...r.pending.filter((p) => p.seq < entry.seq), entry];
      while (r.pending.length > RING_MAX) r.pending.shift();
    });
    return saved ? entry : null;
  }

  /** Download the head's data and check it (S-13): sha256 of the bytes must match. */
  private async download(pid: string): Promise<{ head: SaveHead; data: string; json: string }> {
    let res;
    try {
      res = await this.d.api.getData(pid);
    } catch (e) {
      const f = asFailure(e);
      // no head right now (it moved, or the server was restored): decide again later, never "profile gone"
      if (f.status === 404) throw new ApiFailure(0, 'network', 'The cloud copy is not there right now');
      throw f;
    }
    const bytes = base64ToBytes(res.data);
    const sha = sha256HexSync(bytes);
    if (sha !== res.head.sha256.toLowerCase()) throw new ApiFailure(0, 'network', 'The download was damaged');
    let json: string;
    try {
      json = gunzipToString(bytes);
      JSON.parse(json);
    } catch {
      throw new ApiFailure(0, 'network', 'The download could not be read');
    }
    return { head: res.head, data: res.data, json };
  }

  private async pull(key: SlotKey, R: SlotRecord | null, H: SaveHead, keepLocalCopy: boolean): Promise<Outcome | 'changed'> {
    const pid = this.pidOf(key)!;
    const seqBefore = R?.seq ?? 0;
    let got;
    try {
      got = await this.download(pid);
    } catch (e) {
      return this.fail(key, e);
    }
    if (got.head.saveVersion > SUPPORTED_SAVE_VERSION) return 'changed';
    const R2 = this.d.local.getRecord(key);
    if ((R2?.seq ?? 0) !== seqBefore) return 'changed'; // played meanwhile: decide again (S-5)
    if (keepLocalCopy && R2) {
      const L = R2.meta.playSeconds - (R2.base?.playSeconds ?? 0);
      this.backupOf(R2, 'auto_pull', L >= STASH_MIN_PLAY_S);
    }
    const head = got.head;
    const ok = this.d.local.replaceContent(key, {
      gz: got.data, json: got.json, meta: head.meta, synced: true, saveVersion: head.saveVersion,
      base: { epoch: head.epoch, rev: head.rev, playSeconds: head.meta.playSeconds, sha256: head.sha256 },
    });
    if (!ok) return this.fail(key, new ApiFailure(0, 'network', 'This device is out of storage space'));
    this.d.local.removeRemote(pid);
    return { kind: 'pulled', fromDevice: head.device.name, autoBackup: keepLocalCopy };
  }

  private backupOf(R: SlotRecord, reason: StashReason, stash: boolean): string | null {
    return this.d.local.addBackup(R.profileId, {
      gz: R.gz, meta: R.meta, savedAt: R.savedAt, saveVersion: R.saveVersion, reason, fromDevice: this.d.device().name, stash,
    });
  }

  private async enterConflict(key: SlotKey, R: SlotRecord, H: SaveHead): Promise<Outcome> {
    const pid = R.profileId;
    try {
      const got = await this.download(pid);
      this.d.local.setRemote(pid, { head: got.head, data: got.data, at: this.d.now() });
      H = got.head;
    } catch (e) {
      if (!isOfflineFailure(e)) console.warn('[net] could not download the cloud copy', e);
    }
    this.d.local.updateRecord(key, (r) => {
      r.state = 'conflict';
    });
    this.ok(key);
    return { kind: 'conflict', info: this.conflictInfo(this.d.local.getRecord(key) ?? R, H) };
  }

  // ================================================================ background runs
  /** Sync one slot in the background and turn the outcome into events. */
  private async background(key: SlotKey, opts: { retry?: boolean; force?: boolean } = {}): Promise<Outcome> {
    if (this.disposed) return { kind: 'skipped' };
    if (!opts.force && !opts.retry && this.inBackoff(key)) return { kind: 'skipped' };
    if (this.leaseLostPending.has(key)) return { kind: 'skipped' };
    const out = await this.lock(() => this.syncLocked(key, { force: opts.force }));
    this.afterBackground(key, out);
    return out;
  }

  private afterBackground(key: SlotKey, out: Outcome): void {
    const active = key === this.activeKey;
    const pid = this.pidOf(key);
    switch (out.kind) {
      case 'pulled':
        if (active) this.emit('pulledNewer', { key, fromDevice: out.fromDevice });
        break;
      case 'conflict':
        if (active) this.emit('conflict', { key, info: out.info });
        break;
      case 'leased':
        if (active) this.leaseLost(key, out.details);
        else {
          const r = this.d.local.getRecord(key);
          const until = this.d.now() + LEASE_FALLBACK_MS;
          this.d.local.updateRecord(key, (x) => {
            x.state = 'waiting';
            x.waitUntil = until;
          });
          if (r) this.scheduleRetry(key, null, LEASE_FALLBACK_MS);
        }
        break;
      default:
        break;
    }
    if ((out.kind === 'pushed' || out.kind === 'in_sync' || out.kind === 'pulled') && pid) void this.uploadStashes(pid);
  }

  /** Lease lost while playing (§3.8): stop pushing and let main.ts ask. */
  private leaseLost(key: SlotKey, details: LeaseConflictDetails | null): LeaseLostInfo | null {
    this.leaseHeld.delete(key);
    const r = this.d.local.getRecord(key);
    if (!r) return null;
    this.leaseLostPending.add(key);
    const info = this.leaseLostInfo(r, details?.head ?? null, details?.holder.deviceName ?? null);
    this.emit('leaseLost', { key, info });
    return info;
  }

  // ================================================================ stashes
  private stashing = new Set<string>();

  /** Upload backups that lost a decision (POST …/stash) for one profile. */
  async uploadStashes(pid: string): Promise<void> {
    const s = this.d.session();
    if (!s || !s.signedIn || this.stashing.has(pid) || this.d.isProfileGone(pid)) return;
    if (this.d.local.accountOfProfile(pid) !== s.accountId) return;
    this.stashing.add(pid);
    try {
      for (const b of this.d.local.backupEntries(pid)) {
        if (!b.stash || b.uploaded || b.stashBlocked) continue;
        let sha: string;
        try {
          sha = sha256HexSync(base64ToBytes(b.gz));
        } catch {
          continue;
        }
        let mark: 'uploaded' | 'blocked' | null = null;
        try {
          await this.d.api.stash(pid, {
            stashId: b.id, reason: b.reason, saveVersion: b.saveVersion, meta: b.meta, clientSavedAt: b.savedAt,
            encoding: 'gzip+base64', data: b.gz, sha256: sha,
          });
          mark = 'uploaded';
        } catch (e) {
          const f = asFailure(e);
          if (f.status === 401) {
            this.d.onUnauthorized();
            return;
          }
          if (f.status === 413 || f.status === 422 || f.status === 404 || f.status === 410) mark = 'blocked';
          else return; // offline / server trouble: next time
        }
        const list = this.d.local.backupEntries(pid);
        const x = list.find((y) => y.id === b.id);
        if (x) {
          if (mark === 'uploaded') x.uploaded = true;
          else x.stashBlocked = true;
          this.d.local.saveBackupEntries(pid, list);
        }
      }
    } finally {
      this.stashing.delete(pid);
    }
  }

  // ================================================================ lease
  private async acquire(pid: string, takeover: boolean): Promise<{ ok: true; head: SaveHead | null } | { ok: false; failure: ApiFailure }> {
    try {
      const res = await this.d.api.lease(pid, takeover ? { action: 'acquire', takeover: true } : { action: 'acquire' }, { timeoutMs: LEASE_TIMEOUT_MS });
      return { ok: true, head: res.head };
    } catch (e) {
      return { ok: false, failure: asFailure(e) };
    }
  }

  private startRenew(): void {
    this.stopRenew();
    if (this.disposed) return;
    this.renewTimer = setInterval(() => void this.renewTick(), RENEW_EVERY_MS);
  }

  private stopRenew(): void {
    if (this.renewTimer !== null) clearInterval(this.renewTimer);
    this.renewTimer = null;
  }

  private async renewTick(): Promise<void> {
    const key = this.activeKey;
    if (!key || !this.visible || !this.syncable(key) || this.leaseLostPending.has(key)) return;
    const pid = this.pidOf(key)!;
    const held = this.leaseHeld.has(key);
    try {
      await this.d.api.lease(pid, held ? { action: 'renew' } : { action: 'acquire' }, { timeoutMs: LEASE_TIMEOUT_MS });
      this.leaseHeld.add(key);
      this.offline = false;
    } catch (e) {
      const f = asFailure(e);
      if (f.status === 409 && (f.code === 'lease_lost' || f.code === 'in_use')) {
        if (key === this.activeKey) this.leaseLost(key, (f.details ?? null) as LeaseConflictDetails | null);
        return;
      }
      if (f.status === 401) this.d.onUnauthorized();
      else if (f.status === 410 || f.status === 404) this.fail(key, f);
      else if (isOfflineFailure(f)) this.offline = true;
      this.changed();
      return;
    }
    const r = this.d.local.getRecord(key);
    if (r && isDirty(r) && this.d.now() - (this.lastPushAt.get(key) ?? 0) >= PUSH_EVERY_MS) void this.background(key);
  }

  // ================================================================ SyncEngine
  private openLocal(key: SlotKey): OpenedSlot {
    const s = this.d.local.read(key);
    return s ? { kind: 'ok', json: s.json, meta: s.meta, source: 'local' } : { kind: 'ok', json: null, meta: null, source: 'none' };
  }

  async openSlot(key: SlotKey, prompts: SyncPrompts): Promise<OpenedSlot> {
    const pid = this.pidOf(key);
    if (pid && this.ownSlot(key) && this.d.isProfileGone(pid)) return { kind: 'blocked', reason: 'profile_deleted' };
    if (!pid || !this.syncable(key)) return this.openLocal(key);
    const name = this.d.profileName(pid);
    this.leaseLostPending.delete(key);
    // 1. lease (4 s; offline → play the local copy, sync later)
    let lease = await this.acquire(pid, false);
    if (!lease.ok && lease.failure.status === 409 && lease.failure.code === 'in_use') {
      const holder = (lease.failure.details as Partial<LeaseConflictDetails> | undefined)?.holder;
      const go = await prompts.confirmTakeover({ profileName: name, holderDevice: holder?.deviceName ?? 'another device', lastSeenAt: holder?.lastSeenAt ?? 0 });
      if (!go) return { kind: 'cancelled' };
      lease = await this.acquire(pid, true);
    }
    if (!lease.ok) {
      const out = this.fail(key, lease.failure);
      if (out.kind === 'gone') return { kind: 'blocked', reason: 'profile_deleted' };
      return this.opened(key);
    }
    this.leaseHeld.add(key);
    this.clearBackoff(key);
    // 2. head + decide, pull or ask before loading
    const out = await this.lock(() => this.syncLocked(key, { opening: true }));
    let fromCloud = false;
    switch (out.kind) {
      case 'pulled':
        fromCloud = true;
        if (out.autoBackup) prompts.toast(`Got ${name}'s newer zoo from ${out.fromDevice}`);
        break;
      case 'conflict': {
        const choice = await prompts.chooseConflict(out.info);
        await this.resolveConflict(key, choice);
        fromCloud = choice === 'other' && this.d.local.getRecord(key)?.state === 'ok';
        break;
      }
      case 'blocked':
        if (out.reason === 'newer_version') {
          void this.release(key);
          return { kind: 'blocked', reason: 'newer_version' };
        }
        break;
      case 'gone':
        return { kind: 'blocked', reason: 'profile_deleted' };
      default:
        break;
    }
    return this.opened(key, fromCloud);
  }

  private opened(key: SlotKey, fromCloud = false): OpenedSlot {
    this.activeKey = key;
    this.visible = true;
    this.lastPushAt.set(key, this.d.now());
    this.startRenew();
    const res = this.openLocal(key);
    return res.kind === 'ok' && res.json !== null && fromCloud ? { ...res, source: 'cloud' } : res;
  }

  noteSaved(key: SlotKey): void {
    if (!this.syncable(key)) {
      this.changed();
      return;
    }
    this.changed();
    if (this.leaseLostPending.has(key) || this.inBackoff(key)) return;
    const r = this.d.local.getRecord(key);
    if (!r || r.localOnly || !isDirty(r)) return;
    if (this.d.now() - (this.lastPushAt.get(key) ?? 0) < PUSH_EVERY_MS) return;
    void this.background(key);
  }

  async syncNow(): Promise<void> {
    for (const key of this.ownedSyncedKeys()) this.clearBackoff(key);
    for (const key of this.ownedSyncedKeys()) await this.background(key, { force: true });
    const s = this.d.session();
    if (s) for (const pid of new Set(this.ownedSyncedKeys().map((k) => this.pidOf(k)!))) await this.uploadStashes(pid);
  }

  /** Push dirty synced slots of this account (menu shown, sign-in, online). */
  async syncDirty(): Promise<void> {
    for (const key of this.ownedSyncedKeys()) {
      const r = this.d.local.getRecord(key);
      if (!r || r.localOnly) continue;
      const due = isDirty(r) || r.pending.length > 0 || (r.state === 'waiting' && (r.waitUntil ?? 0) <= this.d.now());
      if (due && r.state !== 'conflict') await this.background(key);
      else void this.uploadStashes(r.profileId);
    }
  }

  /** Every synced (profile main) slot key of the session's account on this device (from the index). */
  ownedSyncedKeys(): SlotKey[] {
    const s = this.d.session();
    if (!s) return [];
    const out: SlotKey[] = [];
    for (const [k, v] of Object.entries(this.d.local.index().slots)) {
      const pid = this.pidOf(k as SlotKey);
      if (!pid || v.localOnly || this.d.isProfileGone(pid)) continue;
      if ((v.accountId || this.d.local.accountOfProfile(pid)) !== s.accountId) continue;
      out.push(k as SlotKey);
    }
    return out;
  }

  /** Forget every backoff (online, resume, sign-in). */
  resetBackoff(): void {
    for (const key of [...this.backoffs.keys()]) this.clearBackoff(key);
  }

  /** Network came back: reset backoff, sync the active and dirty slots. */
  onOnline(): void {
    this.resetBackoff();
    this.offline = false;
    void this.syncDirty();
  }

  onHidden(key: SlotKey | null, keepaliveBudgetBytes: number): number {
    this.visible = false;
    this.stopRenew();
    let used = 0;
    if (!key || !this.syncable(key)) return 0;
    const pid = this.pidOf(key)!;
    const budget = Math.max(0, keepaliveBudgetBytes);
    const r = this.d.local.getRecord(key);
    if (r && !r.localOnly && r.state === 'ok' && isDirty(r) && !this.leaseLostPending.has(key)) {
      try {
        const sha = sha256OfB64Sync(r.gz);
        const entry = this.ringEntry(key, r, sha);
        if (entry) {
          const sent = this.d.api.keepalive({
            kind: 'putSave', pid,
            body: {
              base: r.base ? refOf(r.base) : null, pushId: entry.pushId, saveVersion: r.saveVersion, meta: r.meta, clientSavedAt: r.savedAt,
              encoding: 'gzip+base64', data: r.gz, sha256: sha, ...(r.pinNext ? { resolution: 'keep_local' as const } : {}),
            },
          }, budget - (this.leaseHeld.has(key) ? RELEASE_RESERVE_BYTES : 0));
          if (sent) {
            used += sent.bytes;
            this.lastPushAt.set(key, this.d.now());
            void sent.done.then((res) => {
              if (!res.ok) return;
              const head = (res.value as { head?: SaveHead } | undefined)?.head;
              if (head && head.pushId === entry.pushId) void this.lock(async () => this.commitSynced(key, head, entry));
            });
          }
        }
      } catch (e) {
        console.warn('[net] keepalive push failed', e);
      }
    }
    if (this.leaseHeld.has(key)) {
      const sent = this.d.api.keepalive({ kind: 'lease', pid, body: { action: 'release' } }, budget - used);
      if (sent) {
        used += sent.bytes;
        this.leaseHeld.delete(key);
      }
    }
    return used;
  }

  async onVisible(key: SlotKey | null, hiddenMs: number): Promise<ResumeResult> {
    this.visible = true;
    for (const k of [...this.backoffs.keys()]) this.clearBackoff(k);
    if (!key || !this.syncable(key) || this.leaseLostPending.has(key)) {
      if (key && this.syncable(key)) this.startRenew();
      void this.syncDirty();
      return { kind: 'continue' };
    }
    this.activeKey = key;
    this.startRenew();
    const pid = this.pidOf(key)!;
    // A short break (≤ 60 s) is not held by main.ts: answer at once, report problems as events.
    const short = hiddenMs <= RESUME_AFTER_HIDDEN_MS;
    let answered = short;
    const work = (async (): Promise<ResumeResult> => {
      const lease = await this.acquire(pid, false);
      if (!lease.ok) {
        const f = lease.failure;
        if (f.status === 409 && f.code === 'in_use') {
          this.leaseHeld.delete(key);
          const r = this.d.local.getRecord(key);
          if (!r) return { kind: 'continue' };
          this.leaseLostPending.add(key);
          const info = this.leaseLostInfo(r, (f.details as Partial<LeaseConflictDetails> | undefined)?.head ?? null,
            (f.details as Partial<LeaseConflictDetails> | undefined)?.holder?.deviceName ?? null);
          return { kind: 'leaseLost', info };
        }
        this.fail(key, f);
        return { kind: 'continue' };
      }
      this.leaseHeld.add(key);
      if (short) {
        const r = this.d.local.getRecord(key);
        if (r && isDirty(r) && this.d.now() - (this.lastPushAt.get(key) ?? 0) >= PUSH_EVERY_MS) void this.background(key);
        return { kind: 'continue' };
      }
      const out = await this.lock(() => this.syncLocked(key, {}));
      if (out.kind === 'pulled') return { kind: 'reload', fromDevice: out.fromDevice };
      if (out.kind === 'conflict') {
        this.emit('conflict', { key, info: out.info });
        return { kind: 'continue' };
      }
      if (out.kind === 'leased') {
        const r = this.d.local.getRecord(key);
        if (r) {
          this.leaseLostPending.add(key);
          this.leaseHeld.delete(key);
          return { kind: 'leaseLost', info: this.leaseLostInfo(r, out.details.head, out.details.holder.deviceName) };
        }
      }
      if (out.kind === 'pushed' || out.kind === 'in_sync') void this.uploadStashes(pid);
      return { kind: 'continue' };
    })().catch((e): ResumeResult => {
      console.warn('[net] resume check failed', e);
      return { kind: 'continue' };
    });
    // main.ts waits at most 2 s; a late answer arrives as an event instead
    void work.then((res) => {
      if (!answered) return;
      if (res.kind === 'reload') this.emit('pulledNewer', { key, fromDevice: res.fromDevice });
      else if (res.kind === 'leaseLost') this.emit('leaseLost', { key, info: res.info });
    });
    if (short) return { kind: 'continue' };
    const first = await within(work, RESUME_HOLD_MS, null);
    answered = true;
    return first ?? { kind: 'continue' };
  }

  private async release(key: SlotKey): Promise<void> {
    const pid = this.pidOf(key);
    if (!pid || !this.leaseHeld.has(key)) return;
    this.leaseHeld.delete(key);
    try {
      await this.d.api.lease(pid, { action: 'release' }, { timeoutMs: LEASE_TIMEOUT_MS });
    } catch {
      /* the lease runs out by itself */
    }
  }

  async onLeave(key: SlotKey): Promise<void> {
    this.stopRenew();
    const work = (async () => {
      if (this.syncable(key) && !this.leaseLostPending.has(key)) {
        const r = this.d.local.getRecord(key);
        if (r && !r.localOnly && isDirty(r)) await this.lock(() => this.syncLocked(key, { force: true }));
      }
      await this.release(key);
    })().catch((e) => console.warn('[net] leave sync failed', e));
    await within(work.then(() => true), LEAVE_BUDGET_MS, false);
    if (this.activeKey === key) this.activeKey = null;
    this.leaseLostPending.delete(key);
    this.d.local.endSession(key);
  }

  async resolveLeaseLost(key: SlotKey, keep: 'here' | 'other'): Promise<'continue' | 'reload'> {
    const pid = this.pidOf(key);
    if (!pid) return 'continue';
    if (keep === 'other') {
      return this.lock(async () => {
        const r = this.d.local.getRecord(key);
        if (r) {
          this.backupOf(r, 'lease_lost', true);
          this.d.local.updateRecord(key, (x) => {
            x.forcePull = true; // even offline: the next sync takes the cloud copy
          });
        }
        try {
          const got = await this.download(pid);
          this.d.local.replaceContent(key, {
            gz: got.data, json: got.json, meta: got.head.meta, synced: true, saveVersion: got.head.saveVersion,
            base: { epoch: got.head.epoch, rev: got.head.rev, playSeconds: got.head.meta.playSeconds, sha256: got.head.sha256 },
          });
        } catch (e) {
          if (!isOfflineFailure(e)) console.warn('[net] could not fetch the other zoo', e);
        }
        this.leaseLostPending.delete(key);
        this.leaseHeld.delete(key);
        void this.uploadStashes(pid);
        return 'reload' as const;
      });
    }
    // 'here': take the lease back and push over the other device's head, pinning it (S1)
    const lease = await this.acquire(pid, true);
    this.leaseLostPending.delete(key);
    if (!lease.ok) {
      this.fail(key, lease.failure);
      return 'continue';
    }
    this.leaseHeld.add(key);
    const head = lease.head;
    await this.lock(async () => {
      if (head) {
        this.d.local.updateRecord(key, (r) => {
          r.base = { epoch: head.epoch, rev: head.rev, playSeconds: head.meta.playSeconds, sha256: head.sha256 };
          r.syncedSeq = Math.min(r.syncedSeq, r.seq - 1);
          r.pending = [];
          r.pinNext = true;
          r.forcePull = false;
          r.state = 'ok';
        });
      }
      const out = await this.syncLocked(key, { force: true });
      this.afterBackground(key, out);
    });
    return 'continue';
  }

  async resolveConflict(key: SlotKey, keep: 'here' | 'other'): Promise<'continue' | 'reload'> {
    const pid = this.pidOf(key);
    if (!pid) return 'continue';
    const result = await this.lock(async (): Promise<'continue' | 'reload' | 'sync'> => {
      const r = this.d.local.getRecord(key);
      if (!r) return 'continue';
      let remote = this.d.local.getRemote(pid);
      if (!remote) {
        try {
          const got = await this.download(pid);
          remote = { head: got.head, data: got.data, at: this.d.now() };
        } catch (e) {
          this.fail(key, e);
          return 'continue';
        }
      }
      const h = remote.head;
      if (keep === 'here') {
        // the cloud copy stays pinned on the server (keep_local) and as a local backup
        this.d.local.addBackup(pid, {
          gz: remote.data, meta: h.meta, savedAt: h.clientSavedAt ?? h.savedAt, saveVersion: h.saveVersion, reason: 'replaced',
          fromDevice: h.device.name, stash: false,
        });
        this.d.local.updateRecord(key, (x) => {
          x.base = { epoch: h.epoch, rev: h.rev, playSeconds: h.meta.playSeconds, sha256: h.sha256 };
          x.syncedSeq = Math.min(x.syncedSeq, x.seq - 1);
          x.pending = [];
          x.pinNext = true;
          x.state = 'ok';
        });
        this.d.local.removeRemote(pid);
        return 'sync';
      }
      // 'other': this device's copy → backup + stash, the cloud copy becomes the slot
      this.backupOf(r, 'chose_other', true);
      let json: string;
      try {
        json = gunzipToString(base64ToBytes(remote.data));
      } catch {
        this.d.local.removeRemote(pid);
        return 'continue';
      }
      this.d.local.replaceContent(key, {
        gz: remote.data, json, meta: h.meta, synced: true, saveVersion: h.saveVersion,
        base: { epoch: h.epoch, rev: h.rev, playSeconds: h.meta.playSeconds, sha256: h.sha256 },
      });
      this.d.local.removeRemote(pid);
      return key === this.activeKey ? 'reload' : 'continue';
    });
    if (result === 'sync') {
      const out = await this.background(key, { force: true });
      if (out.kind === 'conflict' && key !== this.activeKey) return 'continue';
      return 'continue';
    }
    void this.uploadStashes(pid);
    this.changed();
    return result;
  }

  slotState(key: SlotKey): SlotUiState {
    const pid = this.pidOf(key);
    if (!pid || !this.ownSlot(key)) return 'local';
    if (this.d.isProfileGone(pid)) return 'blocked';
    const r = this.d.local.getRecord(key);
    if (!r) {
      return 'local';
    }
    if (r.localOnly) return 'local';
    if (r.state === 'conflict') return 'conflict';
    if (r.state === 'waiting') return 'waiting';
    if (r.state === 'blocked') return 'blocked';
    if (!isDirty(r)) return 'synced';
    const s = this.d.session();
    if (!s || !s.signedIn) return 'pending';
    return this.offline ? 'offline' : 'pending';
  }

  // ================================================================ status inputs
  isSyncing(): boolean {
    return this.running > 0;
  }
  isOffline(): boolean {
    return this.offline;
  }
  pendingCount(): number {
    let n = 0;
    for (const key of this.ownedSyncedKeys()) {
      const r = this.d.local.getRecord(key);
      if (r && !r.localOnly && isDirty(r) && r.state !== 'conflict') n++;
    }
    return n;
  }
  conflictKeys(): SlotKey[] {
    return this.ownedSyncedKeys().filter((k) => this.d.local.getRecord(k)?.state === 'conflict');
  }
  nextTryAt(): number | undefined {
    let t: number | undefined;
    for (const b of this.backoffs.values()) if (b.nextAt > this.d.now()) t = t === undefined ? b.nextAt : Math.min(t, b.nextAt);
    return t;
  }
  /** Slot of the zoo being played (set by openSlot / onVisible). */
  get active(): SlotKey | null {
    return this.activeKey;
  }
  /** Unsynced work of this account (sign-out warning): dirty slots, open conflicts, stashes not uploaded. */
  unsynced(): SlotKey[] {
    const out: SlotKey[] = [];
    for (const key of this.ownedSyncedKeys()) {
      const r = this.d.local.getRecord(key);
      if (!r || r.localOnly) continue;
      const stashes = this.d.local.backupEntries(r.profileId).some((b) => b.stash && !b.uploaded && !b.stashBlocked);
      if (isDirty(r) || r.state === 'conflict' || stashes) out.push(key);
    }
    return out;
  }

  /** Stop timers (tests, sign-out). */
  dispose(): void {
    this.disposed = true;
    this.stopRenew();
    for (const k of [...this.backoffs.keys()]) this.clearBackoff(k);
  }

  /** Test hook: wait for queued sync work to finish. */
  idle(): Promise<void> {
    return this.lock(async () => undefined);
  }

  /** Test/diagnostic: let the event loop run (used by flushes waiting on keepalive answers). */
  static sleep = sleep;
}
