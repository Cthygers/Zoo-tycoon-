// LocalStore (spec §3.4, §3.5, §3.9): every zoo on this device, synchronous over a Storage.
// - guest main = 'wildhaven-save-v1', plain JSON exactly as before (with the '-unreadable' backups);
//   guest practice = 'wildhaven-practice-v1' (plain JSON);
// - profile slots = SlotRecords (gzip + base64) in wh2:slot:<pid>/<slot>; practice and vs-* are localOnly;
// - wh2:index: cache of accounts → profiles and per-slot summaries, rebuilt by scanning when missing;
// - ≤ 3 backups per profile (wh2:bak), the downloaded cloud copy of an open conflict (wh2:remote);
// - the quota purge order of §3.4, adoption of the guest zoo, "Give this zoo to…", housekeeping.
// No @capacitor/* imports and no DOM access at import time (the server's contract test may import it).
import type { ProfileDto, RemovedProfileDto, SaveHead, SaveMeta, ServerConfig, StashReason } from '../../shared/api-types';
import type { LocalBackup, LocalSlot, LocalStore } from '../core/cloud-types';
import type { PlayerRef, SlotKey, SlotName } from '../core/contracts';
import { mergeTutorialState, readTutorialState, writeTutorialState, type TutorialProfileState } from '../core/player-state';
import { GUEST, KEYS, isLocalOnly, parseSlotKey } from '../core/storage-keys';
import { cyrb53, decodeSave, encodeSave, saveVersionOf, uuid } from './codec';
import { cleanMeta, metaFromSaveJson } from './meta';

const DAY_MS = 86_400_000;
export const BACKUP_KEEP_MS = 30 * DAY_MS;
export const MOVED_KEEP_MS = 30 * DAY_MS;
export const MAX_BACKUPS = 3;
export const VS_KEEP_MS = 7 * DAY_MS;
export const VS_KEEP_NEWEST = 3;

// ------------------------------------------------------------------ records
export interface SlotBase { epoch: string; rev: number; playSeconds: number; sha256: string }
export interface PendingPush { pushId: string; seq: number; startedAt: number; playSeconds: number; sha256: string }
export type SlotBlocked = 'profile_deleted' | 'newer_version' | 'too_large' | 'quota' | 'rejected';

/** The stored record of a profile slot (spec §3.4) plus a few net-internal fields. */
export interface SlotRecord {
  v: 2;
  key: SlotKey;
  accountId: string;
  profileId: string;
  slot: SlotName;
  /** practice and vs-*: never pushed, no lease, no backups, no dialogs. */
  localOnly: boolean;
  /** +1 whenever the stored content changes. */
  seq: number;
  /** seq whose content equals `base` on the server. */
  syncedSeq: number;
  base: SlotBase | null;
  /** Ring of the last ≤ 4 unconfirmed pushes (S5); survives an app kill. */
  pending: PendingPush[];
  /** cyrb53 of the JSON. */
  contentHash: string;
  meta: SaveMeta;
  /** Device clock, display only. */
  savedAt: number;
  state: 'ok' | 'conflict' | 'blocked' | 'waiting';
  blocked?: SlotBlocked;
  /** base64(gzip(JSON)), fflate level 6. */
  gz: string;
  // ---- net-internal
  /** SimSave.version of the content (sent with a push). */
  saveVersion: number;
  /** Device time `base` was last set ("what you did here since 14:05"). */
  syncedAt?: number | null;
  /** The next push carries resolution 'keep_local' (pins the head it replaces). */
  pinNext?: boolean;
  /** This copy was given up (lease lost → other): the next sync pulls whatever the cloud has. */
  forcePull?: boolean;
  /** contentHash the server refused (413/422): not retried until the content changes. */
  blockedHash?: string;
  /** Retry a 'waiting' slot (leased elsewhere) after this device time. */
  waitUntil?: number;
}

/** wh2:bak:<pid>/main entries (spec §3.9). `id` doubles as the server stashId. */
export interface BackupEntry extends LocalBackup {
  gz: string;
  saveVersion: number;
  /** Upload it with POST …/stash (a copy that lost a decision with real play). */
  stash: boolean;
  /** The server refused the stash (quota, not found): keep it local only. */
  stashBlocked?: boolean;
}

/** wh2:remote:<pid>/main: the cloud copy downloaded for an open conflict. */
export interface RemoteCopy { head: SaveHead; data: string; at: number }

export interface SlotSummary {
  accountId: string | null;
  meta: SaveMeta | null;
  seq: number;
  syncedSeq: number;
  hasBase: boolean;
  pending: number;
  state: SlotRecord['state'];
  blocked?: SlotBlocked;
  savedAt: number;
  localOnly: boolean;
  /** guest slots: cyrb53 of the JSON the meta belongs to. */
  hash?: string;
}

export interface AccountCache {
  email: string | null;
  profiles: ProfileDto[];
  removed: RemovedProfileDto[];
  config: ServerConfig | null;
  fetchedAt: number;
  guestAsked?: boolean;
  /** Profiles another device removed (410) and that no refresh has brought back yet. */
  gone?: string[];
}

export interface IndexData {
  v: 2;
  accounts: Record<string, AccountCache>;
  slots: Record<string, SlotSummary>;
}

export interface LocalStoreOptions {
  now?: () => number;
  /** Keep the guest zoo's meta (play seconds) in wh2:index. Off in cloud-disabled builds (no new keys). */
  trackGuestMeta?: boolean;
  /** Account of the signed-in (or needs-signin) session, for new records and the quota purge. */
  currentAccount?: () => string | null;
  /** This device's name, for backups. */
  deviceName?: () => string;
}

function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const x = e as { name?: string; code?: number };
  return x.name === 'QuotaExceededError' || x.name === 'NS_ERROR_DOM_QUOTA_REACHED' || x.code === 22 || x.code === 1014;
}

function profileOf(key: SlotKey): { pid: string; slot: SlotName } | null {
  try {
    const { player, slot } = parseSlotKey(key);
    if (player === GUEST) return null;
    return { pid: player, slot };
  } catch {
    return null;
  }
}

function guestKeyOf(key: SlotKey): string | null {
  if (key === 'guest/main') return KEYS.guestMain;
  if (key === 'guest/practice') return KEYS.guestPractice;
  return null;
}

/** Content of a record differs from its base (or was never synced). */
export function isDirty(r: SlotRecord): boolean {
  return r.seq > r.syncedSeq || r.base === null;
}

export class LocalStoreImpl implements LocalStore {
  readonly storage: Storage;
  private readonly now: () => number;
  private readonly trackGuestMeta: boolean;
  private readonly currentAccount: () => string | null;
  private readonly deviceName: () => string;
  private idxCache: IndexData | null = null;
  /** Keys a writer (the running zoo) has read or written in this page session. */
  private readonly touched = new Set<string>();
  /** Keys whose content was replaced under a running zoo: its writes are ignored until reload/read. */
  private readonly fenced = new Set<string>();
  /** Undecodable records that could not be backed up: never overwritten. */
  private readonly protectedKeys = new Set<string>();
  /** Profiles whose local data was purged in this page session (account deleted): writes are no-ops until reload. */
  private readonly purgedPids = new Set<string>();
  private guestMetaMemo = new Map<string, SaveMeta | null>();

  constructor(storage: Storage, opts: LocalStoreOptions = {}) {
    this.storage = storage;
    this.now = opts.now ?? (() => Date.now());
    this.trackGuestMeta = opts.trackGuestMeta ?? false;
    this.currentAccount = opts.currentAccount ?? (() => null);
    this.deviceName = opts.deviceName ?? (() => 'This device');
  }

  // ================================================================ raw storage helpers
  getRaw(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  removeRaw(key: string): void {
    try {
      this.storage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  /** setItem; on a quota error purge (spec §3.4 order) and retry. False when it still fails. */
  setRaw(key: string, value: string, opts: { purge?: boolean } = {}): boolean {
    try {
      this.storage.setItem(key, value);
      return true;
    } catch (e) {
      if (!isQuotaError(e) || opts.purge === false) {
        if (!isQuotaError(e)) console.warn('[net] storage write failed', e);
        return false;
      }
    }
    for (const step of this.purgeSteps(key)) {
      if (!step()) continue;
      try {
        this.storage.setItem(key, value);
        this.flushIndex();
        return true;
      } catch (e) {
        if (!isQuotaError(e)) return false;
      }
    }
    this.flushIndex();
    return false;
  }

  /** Every storage key starting with `prefix`. */
  listKeys(prefix: string): string[] {
    const out: string[] = [];
    try {
      const n = this.storage.length;
      for (let i = 0; i < n; i++) {
        const k = this.storage.key(i);
        if (k !== null && k.startsWith(prefix)) out.push(k);
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  private readJson<T>(key: string): T | null {
    const s = this.getRaw(key);
    if (s === null) return null;
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  }

  // ================================================================ index
  /** The wh2:index cache (loaded once; rebuilt from the slot records when missing or out of step). */
  index(): IndexData {
    if (this.idxCache) return this.idxCache;
    const raw = this.readJson<IndexData>(KEYS.index);
    let idx: IndexData;
    let dirty = false;
    if (raw && raw.v === 2 && raw.accounts && typeof raw.accounts === 'object' && raw.slots && typeof raw.slots === 'object') {
      idx = raw;
    } else {
      idx = { v: 2, accounts: {}, slots: {} };
      dirty = this.getRaw(KEYS.index) !== null || this.listKeys(KEYS.slotPrefix).length > 0;
    }
    // Rebuild missing / stale slot summaries from the records (a stray key never breaks the rebuild).
    const present = new Set<string>();
    for (const k of this.listKeys(KEYS.slotPrefix)) {
      const key = k.slice(KEYS.slotPrefix.length) as SlotKey;
      try {
        parseSlotKey(key);
      } catch {
        continue;
      }
      present.add(key);
      if (!idx.slots[key]) {
        const rec = this.readJson<SlotRecord>(k);
        if (rec && rec.v === 2) {
          idx.slots[key] = this.summaryOf(rec);
          dirty = true;
        }
      }
    }
    for (const key of Object.keys(idx.slots)) {
      if (key.startsWith(`${GUEST}/`)) continue;
      if (!present.has(key)) {
        delete idx.slots[key];
        dirty = true;
      }
    }
    this.idxCache = idx;
    if (dirty) this.flushIndex();
    return idx;
  }

  /** Persist the index (no purge on quota: the index is a cache). */
  flushIndex(): void {
    if (!this.idxCache) return;
    try {
      this.storage.setItem(KEYS.index, JSON.stringify(this.idxCache));
    } catch {
      /* a cache: rebuilt next time */
    }
  }

  account(accountId: string): AccountCache | null {
    return this.index().accounts[accountId] ?? null;
  }

  updateAccount(accountId: string, fn: (a: AccountCache) => void): AccountCache {
    const idx = this.index();
    const a = idx.accounts[accountId] ?? { email: null, profiles: [], removed: [], config: null, fetchedAt: 0 };
    fn(a);
    idx.accounts[accountId] = a;
    this.flushIndex();
    return a;
  }

  /** Account a profile belongs to: cache, then its records, then the current session. */
  accountOfProfile(pid: string): string | null {
    const idx = this.index();
    for (const [acc, a] of Object.entries(idx.accounts)) {
      if (a.profiles.some((p) => p.id === pid) || a.removed.some((p) => p.id === pid)) return acc;
    }
    for (const [key, s] of Object.entries(idx.slots)) {
      if (s.accountId && key.startsWith(`${pid}/`)) return s.accountId;
    }
    return this.currentAccount();
  }

  summary(key: SlotKey): SlotSummary | null {
    return this.index().slots[key] ?? null;
  }

  private summaryOf(r: SlotRecord): SlotSummary {
    return {
      accountId: r.accountId,
      meta: r.meta,
      seq: r.seq,
      syncedSeq: r.syncedSeq,
      hasBase: r.base !== null,
      pending: r.pending.length,
      state: r.state,
      ...(r.blocked ? { blocked: r.blocked } : {}),
      savedAt: r.savedAt,
      localOnly: r.localOnly,
    };
  }

  // ================================================================ slot records
  getRecord(key: SlotKey): SlotRecord | null {
    const p = profileOf(key);
    if (!p) return null;
    const r = this.readJson<SlotRecord>(KEYS.slot(p.pid, p.slot));
    return r && r.v === 2 && typeof r.gz === 'string' ? r : null;
  }

  /** Store a record (quota purge on failure) and its index summary. */
  putRecord(rec: SlotRecord): boolean {
    const ok = this.setRaw(KEYS.slot(rec.profileId, rec.slot), JSON.stringify(rec));
    if (ok) {
      this.index().slots[rec.key] = this.summaryOf(rec);
      this.flushIndex();
    }
    return ok;
  }

  /** Read-modify-write of a record's sync fields (not its content). */
  updateRecord(key: SlotKey, fn: (r: SlotRecord) => void): SlotRecord | null {
    const r = this.getRecord(key);
    if (!r) return null;
    fn(r);
    return this.putRecord(r) ? r : null;
  }

  /** JSON of a record, or null when it cannot be decoded. */
  recordJson(rec: SlotRecord): string | null {
    try {
      return decodeSave(rec.gz);
    } catch {
      return null;
    }
  }

  /**
   * Replace a slot's content with a copy the cloud has (pull, conflict "other", lease lost "other"):
   * base := that head, syncedSeq := the new seq. A running zoo of this slot is fenced (its later
   * saves are ignored) so it cannot overwrite the newer copy before the app reloads.
   */
  replaceContent(key: SlotKey, c: { gz: string; json: string; meta: SaveMeta; base: SlotBase | null; synced: boolean; saveVersion?: number }): boolean {
    const p = profileOf(key);
    if (!p) return false;
    const old = this.getRecord(key);
    const seq = (old?.seq ?? 0) + 1;
    const rec: SlotRecord = {
      v: 2,
      key,
      accountId: old?.accountId ?? this.accountOfProfile(p.pid) ?? '',
      profileId: p.pid,
      slot: p.slot,
      localOnly: isLocalOnly(p.slot),
      seq,
      syncedSeq: c.synced ? seq : (old?.syncedSeq ?? 0),
      base: c.base,
      pending: c.synced ? [] : (old?.pending ?? []),
      contentHash: cyrb53(c.json),
      meta: cleanMeta(c.meta),
      savedAt: this.now(),
      state: 'ok',
      gz: c.gz,
      saveVersion: c.saveVersion ?? saveVersionOf(c.json) ?? 1,
      syncedAt: c.synced ? this.now() : (old?.syncedAt ?? null),
    };
    if (!this.putRecord(rec)) return false;
    if (this.touched.has(key)) this.fenced.add(key);
    return true;
  }

  /** The zoo of this slot stopped running (sync.onLeave): later replacements no longer fence it. */
  endSession(key: SlotKey): void {
    this.touched.delete(key);
  }

  /** True while a running zoo's writes to this key are being ignored (content replaced under it). */
  isFenced(key: SlotKey): boolean {
    return this.fenced.has(key);
  }

  // ================================================================ guest meta
  private guestMeta(key: SlotKey, json: string): SaveMeta | null {
    const hash = cyrb53(json);
    const s = this.trackGuestMeta ? this.index().slots[key] : undefined;
    if (s && s.hash === hash && s.meta) return s.meta;
    const memo = `${key}:${hash}`;
    if (!this.guestMetaMemo.has(memo)) this.guestMetaMemo.set(memo, metaFromSaveJson(json));
    return this.guestMetaMemo.get(memo) ?? null;
  }

  /** Meta of the guest main zoo (null when there is none). */
  guestZooMeta(): SaveMeta | null {
    const json = this.getRaw(KEYS.guestMain);
    return json === null ? null : this.guestMeta('guest/main' as SlotKey, json);
  }

  // ================================================================ LocalStore
  read(key: SlotKey): LocalSlot | null {
    this.touched.add(key);
    this.fenced.delete(key);
    const g = guestKeyOf(key);
    if (g) {
      const json = this.getRaw(g);
      if (json === null) return null;
      return { json, meta: this.guestMeta(key, json), savedAt: this.index().slots[key]?.savedAt ?? 0 };
    }
    const p = profileOf(key);
    if (!p) return null;
    const storageKey = KEYS.slot(p.pid, p.slot);
    const raw = this.getRaw(storageKey);
    if (raw === null) return null;
    const rec = this.readJson<SlotRecord>(storageKey);
    const json = rec && rec.v === 2 && typeof rec.gz === 'string' ? this.recordJson(rec) : null;
    if (rec && json !== null) return { json, meta: rec.meta ?? null, savedAt: rec.savedAt ?? 0 };
    // An unreadable record: keep it as wh2:bad (like the guest's '-unreadable' copies), then free the slot.
    if (this.setRaw(KEYS.bad(p.pid, p.slot, this.now()), raw)) {
      this.removeRaw(storageKey);
      delete this.index().slots[key];
      this.flushIndex();
    } else {
      this.protectedKeys.add(key);
    }
    return null;
  }

  write(key: SlotKey, json: string, meta: SaveMeta): 'saved' | 'failed' {
    this.touched.add(key);
    if (this.fenced.has(key)) return 'saved';
    if (this.protectedKeys.has(key)) return 'failed';
    const g = guestKeyOf(key);
    if (g) {
      if (this.getRaw(g) !== json && !this.setRaw(g, json)) return 'failed';
      if (this.trackGuestMeta) {
        const idx = this.index();
        idx.slots[key] = { accountId: null, meta: cleanMeta(meta), seq: 0, syncedSeq: 0, hasBase: false, pending: 0, state: 'ok', savedAt: this.now(), localOnly: true, hash: cyrb53(json) };
        this.flushIndex();
      }
      return 'saved';
    }
    const p = profileOf(key);
    if (!p) return 'failed';
    // the running zoo's player was deleted under it (Delete account → switchSlot → save): no orphan record
    if (this.purgedPids.has(p.pid)) return 'saved';
    const hash = cyrb53(json);
    const old = this.getRecord(key);
    if (old && old.contentHash === hash) return 'saved';
    let gz: string;
    try {
      gz = encodeSave(json);
    } catch (e) {
      console.error('[net] could not compress the save', e);
      return 'failed';
    }
    const rec: SlotRecord = old
      ? { ...old }
      : {
          v: 2, key, accountId: this.accountOfProfile(p.pid) ?? '', profileId: p.pid, slot: p.slot, localOnly: isLocalOnly(p.slot),
          seq: 0, syncedSeq: 0, base: null, pending: [], contentHash: '', meta: cleanMeta(meta), savedAt: 0, state: 'ok', gz: '',
          saveVersion: 1, syncedAt: null,
        };
    rec.seq += 1;
    rec.contentHash = hash;
    rec.meta = cleanMeta(meta);
    rec.savedAt = this.now();
    rec.gz = gz;
    rec.saveVersion = saveVersionOf(json) ?? rec.saveVersion ?? 1;
    if (rec.state === 'blocked' && (rec.blocked === 'too_large' || rec.blocked === 'quota' || rec.blocked === 'rejected')) {
      rec.state = 'ok';
      delete rec.blocked;
      delete rec.blockedHash;
    }
    return this.putRecord(rec) ? 'saved' : 'failed';
  }

  has(key: SlotKey): boolean {
    const g = guestKeyOf(key);
    if (g) return this.getRaw(g) !== null;
    const p = profileOf(key);
    return p ? this.getRaw(KEYS.slot(p.pid, p.slot)) !== null : false;
  }

  meta(key: SlotKey): SaveMeta | null {
    const g = guestKeyOf(key);
    if (g) {
      const json = this.getRaw(g);
      return json === null ? null : this.guestMeta(key, json);
    }
    const s = this.index().slots[key];
    if (s) return s.meta;
    return this.getRecord(key)?.meta ?? null;
  }

  remove(key: SlotKey): void {
    const g = guestKeyOf(key);
    if (g) {
      this.removeRaw(g);
      if (this.index().slots[key]) {
        delete this.index().slots[key];
        this.flushIndex();
      }
      return;
    }
    const p = profileOf(key);
    if (!p) return;
    this.removeRaw(KEYS.slot(p.pid, p.slot));
    delete this.index().slots[key];
    this.flushIndex();
    this.fenced.delete(key);
  }

  markUnreadable(key: SlotKey, text: string): boolean {
    const g = guestKeyOf(key);
    if (g) {
      // Exactly the pre-cloud behaviour: '<key>-unreadable', or '-unreadable-<ts>' when that holds another copy.
      const backupKey = `${g}-unreadable`;
      const prev = this.getRaw(backupKey);
      const k = prev === null || prev === text ? backupKey : `${backupKey}-${this.now()}`;
      try {
        this.storage.setItem(k, text);
        return true;
      } catch (err) {
        console.warn('[save] storage unavailable', err);
        return false;
      }
    }
    const p = profileOf(key);
    if (!p) return false;
    if (!this.setRaw(KEYS.bad(p.pid, p.slot, this.now()), text)) return false;
    // The next push replaces the cloud copy of that zoo: pin it for 30 days on the server too.
    if (!isLocalOnly(p.slot)) this.updateRecord(key, (r) => { r.pinNext = true; });
    return true;
  }

  adoptGuestInto(accountId: string, profileId: string): 'ok' | 'no-guest' | 'failed' {
    // 1. read the legacy JSON
    const json = this.getRaw(KEYS.guestMain);
    if (json === null) return 'no-guest';
    const key = `${profileId}/main` as SlotKey;
    const meta = this.guestMeta('guest/main' as SlotKey, json) ?? metaFromSaveJson(json) ?? cleanMeta(null);
    const prevRaw = this.getRaw(KEYS.slot(profileId, 'main'));
    const prev = this.getRecord(key);
    try {
      // A zoo this player already had on this device is kept as a backup first.
      if (prev) {
        const prevJson = this.recordJson(prev);
        if (prevJson !== null) {
          this.addBackup(profileId, {
            gz: prev.gz, meta: prev.meta, savedAt: prev.savedAt, saveVersion: prev.saveVersion, reason: 'replaced',
            fromDevice: this.deviceName(), stash: isDirty(prev),
          });
        }
      }
      // 2. write the profile slot (seq 1, base null)
      const gz = encodeSave(json);
      const rec: SlotRecord = {
        v: 2, key, accountId, profileId, slot: 'main', localOnly: false, seq: 1, syncedSeq: 0, base: null, pending: [],
        contentHash: cyrb53(json), meta: cleanMeta(meta), savedAt: this.now(), state: 'ok', gz,
        saveVersion: saveVersionOf(json) ?? 1, syncedAt: null,
      };
      if (!this.putRecord(rec)) throw new Error('could not write the profile slot');
      // 3. read it back and decode it
      const back = this.getRecord(key);
      if (!back || this.recordJson(back) !== json) throw new Error('read-back mismatch');
      // 4. the player's active slot
      this.storage.setItem(KEYS.active(profileId), 'main');
      // 5. the guest's tutorial state goes with the zoo (§6.6, T1)
      const guestTut = this.getRaw(KEYS.guestTutorial);
      const fromGuest: TutorialProfileState = guestTut !== null
        ? readTutorialState(this.storage, GUEST)
        : { v: 1, status: 'never', readAloud: null, updatedAt: 0, legacyFromGuest: true };
      const merged = mergeTutorialState(readTutorialState(this.storage, profileId), fromGuest);
      writeTutorialState(this.storage, profileId, merged);
    } catch (e) {
      console.warn('[net] adopting the guest zoo failed', e);
      // Undo: the legacy key was never touched; put the player's old slot back.
      if (prevRaw !== null) {
        try {
          this.storage.setItem(KEYS.slot(profileId, 'main'), prevRaw);
        } catch {
          /* the backup made above still has it */
        }
        if (prev) this.index().slots[key] = this.summaryOf(prev);
      } else {
        this.removeRaw(KEYS.slot(profileId, 'main'));
        delete this.index().slots[key];
      }
      this.flushIndex();
      return 'failed';
    }
    // 6. keep a copy for 30 days, then remove the legacy key
    const moved = JSON.stringify({ movedTo: { accountId, profileId }, at: this.now(), data: json });
    if (!this.setRaw(KEYS.guestMainMoved, moved)) console.warn('[net] could not keep wildhaven-save-v1-moved');
    this.removeRaw(KEYS.guestMain);
    if (this.index().slots['guest/main']) {
      delete this.index().slots['guest/main'];
      this.flushIndex();
    }
    return 'ok';
  }

  // ---------------------------------------------------------------- backups
  backupEntries(pid: string): BackupEntry[] {
    const list = this.readJson<BackupEntry[]>(KEYS.bak(pid));
    return Array.isArray(list) ? list.filter((b) => b && typeof b.id === 'string' && typeof b.gz === 'string') : [];
  }

  saveBackupEntries(pid: string, list: BackupEntry[]): boolean {
    if (list.length === 0) {
      this.removeRaw(KEYS.bak(pid));
      return true;
    }
    return this.setRaw(KEYS.bak(pid), JSON.stringify(list));
  }

  /** Add a backup (≤ 3 kept; the oldest goes first). Returns its id, or null when it could not be stored. */
  addBackup(pid: string, b: { gz: string; meta: SaveMeta; savedAt: number; saveVersion: number; reason: StashReason; fromDevice: string; stash: boolean }): string | null {
    const entry: BackupEntry = {
      id: uuid(), reason: b.reason, fromDevice: b.fromDevice, meta: cleanMeta(b.meta), savedAt: b.savedAt, createdAt: this.now(),
      uploaded: false, gz: b.gz, saveVersion: b.saveVersion, stash: b.stash,
    };
    const list = [...this.backupEntries(pid), entry].sort((x, y) => x.createdAt - y.createdAt);
    while (list.length > MAX_BACKUPS) list.shift();
    return this.saveBackupEntries(pid, list) ? entry.id : null;
  }

  backups(profileId: string): LocalBackup[] {
    return this.backupEntries(profileId)
      .map(({ id, reason, fromDevice, meta, savedAt, createdAt, uploaded }) => ({ id, reason, fromDevice, meta, savedAt, createdAt, uploaded }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  deleteBackup(profileId: string, backupId: string): void {
    this.saveBackupEntries(profileId, this.backupEntries(profileId).filter((b) => b.id !== backupId));
  }

  playBackup(profileId: string, backupId: string): 'ok' | 'failed' {
    const list = this.backupEntries(profileId);
    const b = list.find((x) => x.id === backupId);
    if (!b) return 'failed';
    let json: string;
    try {
      json = decodeSave(b.gz);
    } catch {
      return 'failed';
    }
    const key = `${profileId}/main` as SlotKey;
    const cur = this.getRecord(key);
    const rest = list.filter((x) => x.id !== backupId);
    // current local → backup (it has unique play when dirty)
    if (cur && this.recordJson(cur) !== null) {
      rest.push({
        id: uuid(), reason: 'replaced', fromDevice: this.deviceName(), meta: cur.meta, savedAt: cur.savedAt, createdAt: this.now(),
        uploaded: false, gz: cur.gz, saveVersion: cur.saveVersion, stash: isDirty(cur),
      });
      rest.sort((x, y) => x.createdAt - y.createdAt);
      while (rest.length > MAX_BACKUPS) rest.shift();
    }
    const seq = (cur?.seq ?? 0) + 1;
    const rec: SlotRecord = {
      v: 2, key, accountId: cur?.accountId ?? this.accountOfProfile(profileId) ?? '', profileId, slot: 'main', localOnly: false,
      seq, syncedSeq: cur?.syncedSeq ?? 0, base: cur?.base ?? null, pending: cur?.pending ?? [], contentHash: cyrb53(json),
      meta: cleanMeta(b.meta), savedAt: this.now(), state: 'ok', gz: b.gz, saveVersion: b.saveVersion, syncedAt: cur?.syncedAt ?? null,
      // dirty → the normal sync pushes it, pinning the cloud copy it replaces
      pinNext: true,
    };
    if (cur?.state === 'blocked' && cur.blocked) {
      rec.state = 'blocked';
      rec.blocked = cur.blocked;
    }
    if (!this.putRecord(rec)) return 'failed';
    if (!this.saveBackupEntries(profileId, rest)) console.warn('[net] could not update the backups list');
    if (this.touched.has(key)) this.fenced.add(key);
    return 'ok';
  }

  giveTo(from: { profileId: string; backupId: string } | { guest: true }, toProfileId: string): 'ok' | 'not-empty' | 'failed' {
    const key = `${toProfileId}/main` as SlotKey;
    if (this.has(key)) return 'not-empty';
    const acc = this.accountOfProfile(toProfileId);
    const cached = acc ? this.account(acc)?.profiles.find((p) => p.id === toProfileId) : undefined;
    if (cached && cached.main !== null) return 'not-empty';
    let gz: string;
    let json: string;
    let meta: SaveMeta;
    if ('guest' in from) {
      const g = this.getRaw(KEYS.guestMain);
      if (g === null) return 'failed';
      json = g;
      meta = this.guestMeta('guest/main' as SlotKey, g) ?? cleanMeta(null);
      try {
        gz = encodeSave(json);
      } catch {
        return 'failed';
      }
    } else {
      const b = this.backupEntries(from.profileId).find((x) => x.id === from.backupId);
      if (!b) return 'failed';
      try {
        json = decodeSave(b.gz);
      } catch {
        return 'failed';
      }
      gz = b.gz;
      meta = b.meta;
    }
    const rec: SlotRecord = {
      v: 2, key, accountId: acc ?? '', profileId: toProfileId, slot: 'main', localOnly: false, seq: 1, syncedSeq: 0, base: null,
      pending: [], contentHash: cyrb53(json), meta: cleanMeta(meta), savedAt: this.now(), state: 'ok', gz,
      saveVersion: saveVersionOf(json) ?? 1, syncedAt: null,
    };
    return this.putRecord(rec) ? 'ok' : 'failed';
  }

  // ---------------------------------------------------------------- conflict copies
  getRemote(pid: string): RemoteCopy | null {
    const r = this.readJson<RemoteCopy>(KEYS.remote(pid));
    return r && r.head && typeof r.data === 'string' ? r : null;
  }

  setRemote(pid: string, r: RemoteCopy): boolean {
    return this.setRaw(KEYS.remote(pid), JSON.stringify(r));
  }

  removeRemote(pid: string): void {
    this.removeRaw(KEYS.remote(pid));
  }

  // ---------------------------------------------------------------- housekeeping and purges
  housekeeping(now: number): void {
    // '-moved' is a 30-day safety copy of the adopted guest zoo
    const moved = this.readJson<{ at?: number }>(KEYS.guestMainMoved);
    if (moved !== null && !(typeof moved.at === 'number' && now - moved.at < MOVED_KEEP_MS)) this.removeRaw(KEYS.guestMainMoved);
    // backups are kept 30 days
    for (const k of this.listKeys('wh2:bak:')) {
      const pid = k.slice('wh2:bak:'.length).replace(/\/main$/, '');
      const list = this.backupEntries(pid);
      const keep = list.filter((b) => now - b.createdAt < BACKUP_KEEP_MS);
      if (keep.length !== list.length) this.saveBackupEntries(pid, keep);
    }
    // cloud copies of conflicts that are no longer open
    for (const k of this.listKeys('wh2:remote:')) {
      const pid = k.slice('wh2:remote:'.length).replace(/\/main$/, '');
      if (this.getRecord(`${pid}/main` as SlotKey)?.state !== 'conflict') this.removeRaw(k);
    }
    // players removed more than 30 days ago (past purgeAt) lose their local data too
    this.purgeRemovedProfiles(now);
  }

  private purgeRemovedProfiles(now: number): boolean {
    let freed = false;
    const idx = this.index();
    for (const a of Object.values(idx.accounts)) {
      const past = a.removed.filter((r) => r.purgeAt > 0 && r.purgeAt <= now);
      if (past.length === 0) continue;
      for (const r of past) freed = this.purgeProfileLocal(r.id) || freed;
      a.removed = a.removed.filter((r) => !(r.purgeAt > 0 && r.purgeAt <= now));
    }
    if (freed) this.flushIndex();
    return freed;
  }

  /** Every local key of one profile. */
  profileKeys(pid: string): string[] {
    return [
      ...this.listKeys(`wh2:slot:${pid}/`),
      ...this.listKeys(`wh2:bak:${pid}/`),
      ...this.listKeys(`wh2:remote:${pid}/`),
      ...this.listKeys(`wh2:bad:${pid}/`),
      ...this.listKeys(`wh2:vs:${pid}/`),
      KEYS.vsIndex(pid),
      KEYS.active(pid),
      KEYS.tutorial(pid),
    ];
  }

  /** Delete one profile's local data. True when something was removed. */
  purgeProfileLocal(pid: string): boolean {
    this.purgedPids.add(pid);
    let freed = false;
    for (const k of this.profileKeys(pid)) {
      if (this.getRaw(k) !== null) {
        this.removeRaw(k);
        freed = true;
      }
    }
    const idx = this.index();
    for (const key of Object.keys(idx.slots)) if (key.startsWith(`${pid}/`)) delete idx.slots[key];
    this.flushIndex();
    return freed;
  }

  /** Delete every local key of an account (account deletion). */
  deleteAccountLocal(accountId: string): void {
    const idx = this.index();
    const pids = new Set<string>();
    const a = idx.accounts[accountId];
    if (a) {
      for (const p of a.profiles) pids.add(p.id);
      for (const p of a.removed) pids.add(p.id);
    }
    for (const [key, s] of Object.entries(idx.slots)) if (s.accountId === accountId) pids.add(key.split('/')[0]!);
    for (const k of this.listKeys(KEYS.slotPrefix)) {
      const r = this.readJson<SlotRecord>(k);
      if (r && r.accountId === accountId) pids.add(r.profileId);
    }
    for (const pid of pids) this.purgeProfileLocal(pid);
    for (const k of [...this.listKeys(`wh2:outbox:${accountId}:`), ...this.listKeys(`wh2:outbox-dead:${accountId}:`)]) this.removeRaw(k);
    delete idx.accounts[accountId];
    this.flushIndex();
  }

  /** The §3.4 purge steps, in order; each returns whether it freed anything. */
  private purgeSteps(writingKey: string): Array<() => boolean> {
    const now = this.now();
    return [
      // 1. the adopted guest zoo's 30-day copy
      () => {
        if (writingKey === KEYS.guestMainMoved || this.getRaw(KEYS.guestMainMoved) === null) return false;
        this.removeRaw(KEYS.guestMainMoved);
        return true;
      },
      // 2. downloaded conflict copies (downloaded again when needed)
      () => {
        const ks = this.listKeys('wh2:remote:').filter((k) => k !== writingKey);
        for (const k of ks) this.removeRaw(k);
        return ks.length > 0;
      },
      // 3. backups older than 30 days
      () => {
        let freed = false;
        for (const k of this.listKeys('wh2:bak:')) {
          if (k === writingKey) continue;
          const pid = k.slice('wh2:bak:'.length).replace(/\/main$/, '');
          const list = this.backupEntries(pid);
          const keep = list.filter((b) => now - b.createdAt < BACKUP_KEEP_MS);
          if (keep.length !== list.length) {
            if (keep.length === 0) this.removeRaw(k);
            else {
              try {
                this.storage.setItem(k, JSON.stringify(keep));
              } catch {
                continue;
              }
            }
            freed = true;
          }
        }
        return freed;
      },
      // 4. versus slots of matches finished more than 7 days ago (the newest 3 per player stay)
      () => this.purgeOldVersusSlots(now, writingKey),
      // 5. removed players past purgeAt
      () => this.purgeRemovedProfiles(now),
      // 6. clean (fully synced) slots of other accounts: they are safe in the cloud
      () => {
        const cur = this.currentAccount();
        let freed = false;
        for (const k of this.listKeys(KEYS.slotPrefix)) {
          if (k === writingKey) continue;
          const r = this.readJson<SlotRecord>(k);
          if (!r || r.localOnly || r.accountId === cur || r.accountId === '') continue;
          if (r.base && r.seq === r.syncedSeq && r.pending.length === 0 && r.state === 'ok') {
            this.removeRaw(k);
            delete this.index().slots[r.key];
            freed = true;
          }
        }
        return freed;
      },
    ];
  }

  private purgeOldVersusSlots(now: number, writingKey: string): boolean {
    const byProfile = new Map<string, Array<{ slotKey: string; finishedAt: number }>>();
    for (const k of this.listKeys('wh2:vs:')) {
      const rest = k.slice('wh2:vs:'.length);
      const i = rest.indexOf('/');
      if (i <= 0) continue;
      const pid = rest.slice(0, i);
      const matchId = rest.slice(i + 1);
      const vs = this.readJson<{ match?: { status?: string; createdAt?: number; codeExpiresAt?: number | null; finishBy?: number | null; result?: { decidedAt?: number } | null } }>(k);
      const m = vs?.match;
      if (!m || !(m.status === 'finished' || m.status === 'expired' || m.status === 'cancelled')) continue;
      const finishedAt = m.result?.decidedAt ?? m.finishBy ?? m.codeExpiresAt ?? m.createdAt ?? 0;
      const slotStorageKey = KEYS.slot(pid, `vs-${matchId}` as SlotName);
      if (this.getRaw(slotStorageKey) === null) continue;
      const list = byProfile.get(pid) ?? [];
      list.push({ slotKey: slotStorageKey, finishedAt });
      byProfile.set(pid, list);
    }
    let freed = false;
    for (const list of byProfile.values()) {
      list.sort((a, b) => b.finishedAt - a.finishedAt);
      for (const x of list.slice(VS_KEEP_NEWEST)) {
        if (x.slotKey === writingKey || now - x.finishedAt <= VS_KEEP_MS) continue;
        this.removeRaw(x.slotKey);
        delete this.index().slots[x.slotKey.slice(KEYS.slotPrefix.length)];
        freed = true;
      }
    }
    return freed;
  }

  /** Every profile slot record key (as SlotKey) on this device. */
  slotKeys(): SlotKey[] {
    const out: SlotKey[] = [];
    for (const k of this.listKeys(KEYS.slotPrefix)) {
      const key = k.slice(KEYS.slotPrefix.length) as SlotKey;
      try {
        parseSlotKey(key);
        out.push(key);
      } catch {
        /* stray key */
      }
    }
    return out;
  }

  /** The player ref of a slot key ('guest' or a profile id). */
  static playerOf(key: SlotKey): PlayerRef | null {
    try {
      return parseSlotKey(key).player;
    } catch {
      return null;
    }
  }
}
