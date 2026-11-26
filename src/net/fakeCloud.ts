// FakeCloud: an in-memory model of api.md §3.2–§3.5 (auth, profiles, saves with epoch + CAS + replay +
// pushIds + keep_local pins + stashes + leases, 410/401, and the versus subset) with fault injection,
// for the client tests and the integrator's contract test (the same scenarios also run against the real
// server through HttpCloudApi + injectFetch). `fake.api({ token })` gives a CloudApi bound to a token,
// mirroring HttpCloudApi's constructor; client timeouts are the real ones (8 s / 35 s).
// No @capacitor/* imports and no DOM access at import time.
import type {
  AccountResponse, Avatar, CodePreviewResponse, ConfigResponse, CreateMatchBody, CreateProfileBody, DeleteAccountBody, FinishBody,
  GetHeadResponse, GoogleSignInBody, JoinMatchBody, LeaseBody, LeaseConflictDetails, LeaseInfo, LeaseResponse, MatchDto,
  MatchKind, MatchListResponse, MatchResponse, MatchResultDto, MatchStatus, NonceResponse, PatchProfileBody, ProfileDto,
  ProfileOnlyBody, ProfilePrefs, ProfileResponse, ProfilesResponse, PushedRef, PutSaveBody, PutSaveResponse, RemovedProfileDto,
  RemoveProfileResponse, SaveDataResponse, SaveHead, SaveMeta, SaveRef, SeatDto, SeriesResponse, SeriesRow, SignInResponse,
  SnapshotsBody, SnapshotsResponse, StashBody, StashReason, StashResponse, VersusLength, VersusParts, VersusSnapshot,
} from '../../shared/api-types';
import { FINAL_SAVE_MAX_GZ_BYTES, LEASE_SECONDS_DEFAULT, MAX_PROFILES_DEFAULT, SAVE_MAX_GZ_BYTES, SOFT_DELETE_DAYS } from '../../shared/limits';
import { checkName, nameKey } from '../../shared/names';
import {
  CODE_ALPHABET, CODE_TTL_MS, FINISH_WINDOW_MS, LIVE_WINDOW_MS, SNAPSHOT_EVERY_HOURS, VERSUS_RULES_VERSION, VERSUS_START_MINUTE,
  checkPace, checkSnapshotStep, decideOutcome, hoursTotal, lengthSpec, normalizeCode, type SeatOutcomeInput,
} from '../../shared/versus-rules';
import type { GoogleSignIn } from '../core/cloud-types';
import type { CallOptions, CloudApi, KeepaliveCall } from './cloudApi';
import { base64ToBytes, bytesToBase64, gunzipToString, gzipString, sha256HexSync, utf8Length } from './codec';
import { ApiFailure, LARGE_TIMEOUT_MS, SMALL_TIMEOUT_MS, type FailureCode, type KeepaliveSent } from './http';

const DAY_MS = 86_400_000;
const PIN_MS = 30 * DAY_MS;
const KEEP_BLOBS = 10;

export type FakeOp =
  | 'config' | 'nonce' | 'signIn' | 'signOut' | 'account' | 'deleteAccount'
  | 'profiles' | 'createProfile' | 'patchProfile' | 'removeProfile' | 'restoreProfile'
  | 'getHead' | 'getData' | 'putSave' | 'lease' | 'stash'
  | 'createMatch' | 'previewCode' | 'joinMatch' | 'listMatches' | 'getMatch' | 'postSnapshots' | 'series' | 'finish'
  | 'forfeit' | 'cancel' | 'rematch';

const LARGE_OPS = new Set<FakeOp>(['getData', 'putSave', 'stash', 'finish', 'deleteAccount']);

export type FakeFailure = 'network' | 'timeout' | { status: number; code: FailureCode; details?: Record<string, unknown>; retryAfterMs?: number };

// ------------------------------------------------------------------ server state
interface FAccount { id: string; sub: string; email: string | null; createdAt: number }
interface FSession { token: string; accountId: string; deviceId: string; deviceName: string; platform: string; appVersion: string; expiresAt: number; revoked: boolean }
interface FProfile { id: string; accountId: string; name: string; nameKey: string; avatar: Avatar; prefs: ProfilePrefs; createdAt: number; updatedAt: number; deletedAt: number | null; purgeAt: number | null }
interface FRevision {
  epoch: string; rev: number; pushId: string; deviceId: string; deviceName: string; appVersion: string; saveVersion: number; meta: SaveMeta;
  clientSavedAt: number | null; sizeRaw: number; sizeGz: number; sha256: string; data: string | null; pinnedUntil: number | null; createdAt: number;
}
interface FSave { profileId: string; head: SaveRef | null; revisions: FRevision[]; lease: { deviceId: string; deviceName: string; until: number; seenAt: number } | null; updatedAt: number }
interface FStash { stashId: string; profileId: string; reason: StashReason; deviceName: string; meta: SaveMeta; saveVersion: number; sha256: string; data: string; pinnedUntil: number; createdAt: number }
interface FSeat {
  seat: 0 | 1; profileId: string | null; accountId: string | null; name: string; avatar: Avatar; joinedAt: number;
  deviceId: string | null; deviceName: string | null; firstSnapshotAt: number | null; ackHour: number; lastTotal: number; lastParts: VersusParts | null;
  lastPostAt: number | null; doneAt: number | null; endHour: number | null; endReason: SeatDto['endReason']; flags: string[];
}
interface FMatch {
  id: string; kind: MatchKind; code: string | null; lengthMin: number; days: number; seed: number; rulesVersion: number; startMoney: number; budgetMin: number;
  status: MatchStatus; createdAt: number; codeExpiresAt: number | null; joinedAt: number | null; finishBy: number | null; invitedProfileId: string | null;
  result: MatchResultDto | null; seats: FSeat[]; snapshots: Record<string, VersusSnapshot>;
}
interface FState {
  accounts: FAccount[];
  sessions: FSession[];
  profiles: FProfile[];
  saves: FSave[];
  stashes: FStash[];
  matches: FMatch[];
  nonces: Record<string, { expiresAt: number; used: boolean }>;
}

export interface FakeSnapshot { state: FState; epoch: string }

export interface FakeCloudOptions {
  now?: () => number;
  leaseSeconds?: number;
  maxProfiles?: number;
  versusLengths?: VersusLength[];
  testLength?: boolean;
  maxAccountBytes?: number;
  allowedEmails?: string[];
}

export interface FakeCall { op: FakeOp; client: number; at: number; pid?: string; matchId?: string; keepalive?: boolean; body?: unknown; /** HTTP status the server answered (0 = no answer); set once processed. */ status?: number }

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function randomId(len = 22): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const b = new Uint8Array(len);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < len; i++) b[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const x of b) s += alphabet[x & 63];
  return s;
}

const fail = (status: number, code: FailureCode, details?: Record<string, unknown>, message?: string) =>
  new ApiFailure(status, code, message ?? code, details);
const notFound = () => fail(404, 'not_found');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------ the fake server
export class FakeCloud {
  state: FState = { accounts: [], sessions: [], profiles: [], saves: [], stashes: [], matches: [], nonces: {} };
  epoch: string = randomId(8);
  /** The server is unreachable for every client. */
  offline = false;
  /** Extra delay before the server processes any call (ms). */
  latencyMs = 0;
  readonly calls: FakeCall[] = [];
  /** Hook run just before the server processes a call (e.g. another device pushes first: S-9). */
  before: ((op: FakeOp, call: FakeCall) => void) | null = null;
  readonly opts: Required<Omit<FakeCloudOptions, 'now' | 'allowedEmails'>> & { allowedEmails: string[] };
  private readonly nowFn: () => number;
  private faults: Array<{ op: FakeOp | '*'; failure: FakeFailure; times: number }> = [];
  private drops: Array<{ op: FakeOp | '*'; times: number }> = [];
  private delays: Array<{ op: FakeOp | '*'; ms: number; times: number }> = [];
  private corrupt = 0;
  private clientSeq = 0;

  constructor(opts: FakeCloudOptions = {}) {
    this.nowFn = opts.now ?? (() => Date.now());
    this.opts = {
      leaseSeconds: opts.leaseSeconds ?? LEASE_SECONDS_DEFAULT,
      maxProfiles: opts.maxProfiles ?? MAX_PROFILES_DEFAULT,
      versusLengths: opts.versusLengths ?? [30, 60, 90, 120],
      testLength: opts.testLength ?? true,
      maxAccountBytes: opts.maxAccountBytes ?? 16 * 1024 * 1024,
      allowedEmails: (opts.allowedEmails ?? []).map((e) => e.toLowerCase()),
    };
  }

  now(): number {
    return this.nowFn();
  }

  // ================================================================ fault injection
  /** The next `times` calls of `op` fail with `failure` (the server does nothing). */
  failNext(op: FakeOp | '*', failure: FakeFailure, times = 1): void {
    this.faults.push({ op, failure, times });
  }
  /** The next call of `op` commits on the server, but the client gets a timeout (lost answer). */
  dropResponseAfterCommit(op: FakeOp | '*' = 'putSave', times = 1): void {
    this.drops.push({ op, times });
  }
  /** The server processes the next call of `op` only after `ms` (the client may time out first). */
  delayNext(op: FakeOp | '*', ms: number, times = 1): void {
    this.delays.push({ op, ms, times });
  }
  /** The next save download carries damaged bytes (sha256 no longer matches the head). */
  corruptNextData(times = 1): void {
    this.corrupt += times;
  }
  /** A copy of the whole server state (a backup). */
  snapshot(): FakeSnapshot {
    return { state: clone(this.state), epoch: this.epoch };
  }
  /** As `cli restore`: optionally go back to a backup, and always start a new epoch (S4). */
  restoreEpoch(snap?: FakeSnapshot): string {
    if (snap) this.state = clone(snap.state);
    let e = randomId(8);
    while (e === this.epoch) e = randomId(8);
    this.epoch = e;
    return e;
  }
  /** Soft-delete a profile as another device would. */
  removeProfile(pid: string): void {
    const p = this.state.profiles.find((x) => x.id === pid);
    if (!p || p.deletedAt !== null) return;
    p.deletedAt = this.now();
    p.purgeAt = this.now() + SOFT_DELETE_DAYS * DAY_MS;
    const s = this.saveOf(pid);
    if (s) s.lease = null;
  }
  /** Revoke every session (→ 401 everywhere). */
  expireSessions(): void {
    for (const s of this.state.sessions) s.revoked = true;
  }

  private take<T extends { op: FakeOp | '*'; times: number }>(list: T[], op: FakeOp): T | null {
    const i = list.findIndex((x) => x.op === op || x.op === '*');
    if (i < 0) return null;
    const f = list[i]!;
    f.times--;
    if (f.times <= 0) list.splice(i, 1);
    return f;
  }

  // ================================================================ test helpers
  /** A Google ID token the fake accepts (sub, nonce). */
  idTokenFor(sub: string, nonce: string, email: string | null = `${sub}@example.com`): string {
    return `fake.${btoa(JSON.stringify({ sub, email, nonce }))}`;
  }
  /** A GoogleSignIn for tests: signs in as `sub` (cancel: returns null). */
  google(sub: string, opts: { cancel?: boolean; available?: boolean; email?: string | null } = {}): GoogleSignIn & { sub: string } {
    const self = this;
    return {
      sub,
      async available() {
        return opts.available ?? true;
      },
      async getIdToken(nonce: string) {
        if (opts.cancel) return null;
        return { idToken: self.idTokenFor(this.sub, nonce, opts.email === undefined ? `${this.sub}@example.com` : opts.email) };
      },
      async signOut() {
        /* nothing */
      },
    };
  }
  /** Create an account + session without the Google flow; returns the token. */
  signInDirect(sub: string, device: { id: string; name: string; platform?: 'android' | 'web' }): { token: string; accountId: string } {
    const { account } = this.upsertAccount(sub, `${sub}@example.com`);
    const s = this.newSession(account.id, { id: device.id, name: device.name, platform: device.platform ?? 'web', appVersion: '0.0.0' });
    return { token: s.token, accountId: account.id };
  }
  /** Create a profile directly (as another device would). */
  createProfileDirect(accountId: string, name: string, avatar: Avatar = { animal: 'lion', color: 0 }): ProfileDto {
    const t = this.now();
    const p: FProfile = { id: randomId(), accountId, name, nameKey: nameKey(name), avatar, prefs: {}, createdAt: t, updatedAt: t, deletedAt: null, purgeAt: null };
    this.state.profiles.push(p);
    return this.profileDto(p, '');
  }
  accountBySub(sub: string): FAccount | undefined {
    return this.state.accounts.find((a) => a.sub === sub);
  }
  /** The current head of a profile's save (or null). */
  head(pid: string): SaveHead | null {
    const s = this.saveOf(pid);
    return s ? this.currentHead(s) : null;
  }
  /** Every revision of a profile's save, oldest first (with pins). */
  revisions(pid: string): Array<Omit<FRevision, 'data'> & { hasData: boolean }> {
    return (this.saveOf(pid)?.revisions ?? []).map(({ data, ...r }) => ({ ...r, hasData: data !== null }));
  }
  /** The JSON of the current head. */
  headJson(pid: string): string | null {
    const s = this.saveOf(pid);
    const r = s && s.head ? this.revOf(s, s.head) : undefined;
    return r?.data ? gunzipToString(base64ToBytes(r.data)) : null;
  }
  /** JSON of a revision (by rev, current epoch first). */
  revisionJson(pid: string, rev: number, epoch?: string): string | null {
    const s = this.saveOf(pid);
    const r = s?.revisions.find((x) => x.rev === rev && (epoch === undefined || x.epoch === epoch));
    return r?.data ? gunzipToString(base64ToBytes(r.data)) : null;
  }
  stashes(pid: string): Array<Omit<FStash, 'data'> & { json: string }> {
    return this.state.stashes.filter((s) => s.profileId === pid).map(({ data, ...s }) => ({ ...s, json: gunzipToString(base64ToBytes(data)) }));
  }
  /**
   * A revision committed as if another device pushed it right now (no CAS, no lease check). Returns its
   * head. Used to race a client (S-9) or to put a newer-version save in the cloud (S-10).
   */
  commitDirect(pid: string, json: string, meta: SaveMeta, opts: { deviceName?: string; deviceId?: string; saveVersion?: number } = {}): SaveHead {
    const s = this.ensureSave(pid);
    const head = this.currentHead(s);
    const gz = gzipString(json);
    const data = bytesToBase64(gz);
    const r: FRevision = {
      epoch: this.epoch, rev: (head?.rev ?? 0) + 1, pushId: randomId(), deviceId: opts.deviceId ?? 'other-device', deviceName: opts.deviceName ?? 'Tablet',
      appVersion: '0.15.0', saveVersion: opts.saveVersion ?? 1, meta: clone(meta), clientSavedAt: this.now(), sizeRaw: utf8Length(json),
      sizeGz: gz.length, sha256: sha256HexSync(gz), data, pinnedUntil: null, createdAt: this.now(),
    };
    s.revisions.push(r);
    s.head = { epoch: r.epoch, rev: r.rev };
    s.updatedAt = this.now();
    return this.toHead(r);
  }
  /** Count of calls (optionally of one op / one client). */
  count(op?: FakeOp, client?: number): number {
    return this.calls.filter((c) => (op === undefined || c.op === op) && (client === undefined || c.client === client)).length;
  }

  // ================================================================ clients
  /** A CloudApi bound to a session token (like HttpCloudApi). */
  api(opts: { token: () => string | null; appVersion?: string; client?: 'android' | 'web' }): FakeCloudClient {
    return new FakeCloudClient(this, ++this.clientSeq, opts.token, opts.appVersion ?? '0.0.0');
  }

  /** @internal run one call the way the network would. */
  async run<T>(client: FakeCloudClient, op: FakeOp, info: Partial<FakeCall>, timeoutMs: number | undefined, handler: (ctx: { token: string | null }) => T): Promise<T> {
    if (this.offline || client.offline) throw new ApiFailure(0, 'network', 'offline');
    const call: FakeCall = { op, client: client.id, at: this.now(), ...info };
    this.calls.push(call);
    const fault = this.take(this.faults, op);
    const token = client.token();
    const delay = (this.take(this.delays, op)?.ms ?? 0) + this.latencyMs;
    const drop = this.take(this.drops, op);
    const ms = timeoutMs ?? (LARGE_OPS.has(op) ? LARGE_TIMEOUT_MS : SMALL_TIMEOUT_MS);
    const work = (async () => {
      if (delay > 0) await sleep(delay);
      else await Promise.resolve();
      if (fault) {
        const f = fault.failure;
        if (f === 'network') throw new ApiFailure(0, 'network', 'injected network failure');
        if (f === 'timeout') throw new ApiFailure(0, 'timeout', 'injected timeout');
        throw new ApiFailure(f.status, f.code, f.code, f.details, f.retryAfterMs);
      }
      if (this.offline) throw new ApiFailure(0, 'network', 'offline');
      this.before?.(op, call);
      let out: T;
      try {
        out = handler({ token });
        call.status = 200;
      } catch (e) {
        call.status = e instanceof ApiFailure ? e.status : 500;
        throw e;
      }
      if (drop) throw new ApiFailure(0, 'timeout', 'answer lost');
      return out === undefined ? out : withServerTime(clone(out), this.now());
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ApiFailure(0, 'timeout', 'no answer')), ms);
    });
    work.catch(() => undefined); // the server may still finish after the client gave up
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // ================================================================ auth
  private upsertAccount(sub: string, email: string | null): { account: FAccount; isNew: boolean } {
    let a = this.state.accounts.find((x) => x.sub === sub);
    if (a) {
      if (email) a.email = email;
      return { account: a, isNew: false };
    }
    a = { id: randomId(), sub, email, createdAt: this.now() };
    this.state.accounts.push(a);
    return { account: a, isNew: true };
  }

  private newSession(accountId: string, device: { id: string; name: string; platform: string; appVersion: string }): FSession {
    const s: FSession = {
      token: `whs_${randomId(43)}`, accountId, deviceId: device.id, deviceName: device.name, platform: device.platform,
      appVersion: device.appVersion, expiresAt: this.now() + 180 * DAY_MS, revoked: false,
    };
    this.state.sessions.push(s);
    return s;
  }

  /** @internal Bearer check (401 unauthorized). */
  session(token: string | null): FSession {
    const s = token ? this.state.sessions.find((x) => x.token === token) : undefined;
    if (!s || s.revoked || s.expiresAt <= this.now() || !this.state.accounts.some((a) => a.id === s.accountId)) throw fail(401, 'unauthorized');
    return s;
  }

  private verifyIdToken(idToken: string, nonce: string): { sub: string; email: string | null } {
    let p: { sub?: string; email?: string | null; nonce?: string };
    try {
      if (!idToken.startsWith('fake.')) throw new Error('bad');
      p = JSON.parse(atob(idToken.slice(5))) as typeof p;
    } catch {
      throw fail(401, 'token_invalid');
    }
    if (!p.sub) throw fail(401, 'token_invalid');
    const n = this.state.nonces[nonce];
    if (!n || n.used || n.expiresAt <= this.now() || p.nonce !== nonce) throw fail(401, 'nonce_invalid');
    n.used = true;
    return { sub: p.sub, email: p.email ?? null };
  }

  /** @internal */
  h_config(): Omit<ConfigResponse, 'serverTime'> {
    return {
      apiVersion: 1, minAppVersion: null, maxProfiles: this.opts.maxProfiles, versusLengths: [...this.opts.versusLengths],
      versusRulesVersion: VERSUS_RULES_VERSION, testLength: this.opts.testLength,
    };
  }
  /** @internal */
  h_nonce(): Omit<NonceResponse, 'serverTime'> {
    const nonce = randomId(32);
    const expiresAt = this.now() + 10 * 60_000;
    this.state.nonces[nonce] = { expiresAt, used: false };
    return { nonce, expiresAt };
  }
  /** @internal */
  h_signIn(body: GoogleSignInBody): Omit<SignInResponse, 'serverTime'> {
    const id = this.verifyIdToken(body.idToken, body.nonce);
    if (this.opts.allowedEmails.length > 0 && (!id.email || !this.opts.allowedEmails.includes(id.email.toLowerCase()))) throw fail(403, 'not_allowed');
    const { account, isNew } = this.upsertAccount(id.sub, id.email);
    const s = this.newSession(account.id, body.device);
    return {
      session: { token: s.token, expiresAt: s.expiresAt },
      account: { id: account.id, email: account.email, createdAt: account.createdAt },
      isNew,
      ...this.lists(account.id, s.deviceId),
      config: this.h_config(),
    };
  }
  /** @internal */
  h_signOut(token: string | null): void {
    const s = this.session(token);
    s.revoked = true;
  }
  /** @internal */
  h_account(token: string | null): Omit<AccountResponse, 'serverTime'> {
    const s = this.session(token);
    const a = this.state.accounts.find((x) => x.id === s.accountId)!;
    return { account: { id: a.id, email: a.email, createdAt: a.createdAt }, ...this.lists(a.id, s.deviceId), config: this.h_config() };
  }
  /** @internal */
  h_deleteAccount(token: string | null, body: DeleteAccountBody): void {
    const s = this.session(token);
    const id = this.verifyIdToken(body.idToken, body.nonce);
    const a = this.state.accounts.find((x) => x.id === s.accountId)!;
    if (a.sub !== id.sub) throw fail(403, 'reauth_mismatch');
    const pids = new Set(this.state.profiles.filter((p) => p.accountId === a.id).map((p) => p.id));
    for (const m of this.state.matches) {
      for (const seat of m.seats) {
        if (seat.accountId === a.id || (seat.profileId && pids.has(seat.profileId))) {
          Object.assign(seat, { profileId: null, accountId: null, name: 'Player left', deviceId: null, deviceName: null });
        }
      }
    }
    this.state.matches = this.state.matches.filter((m) => m.seats.some((x) => x.profileId !== null));
    this.state.sessions = this.state.sessions.filter((x) => x.accountId !== a.id);
    this.state.saves = this.state.saves.filter((x) => !pids.has(x.profileId));
    this.state.stashes = this.state.stashes.filter((x) => !pids.has(x.profileId));
    this.state.profiles = this.state.profiles.filter((p) => p.accountId !== a.id);
    this.state.accounts = this.state.accounts.filter((x) => x.id !== a.id);
  }

  // ================================================================ profiles
  private lists(accountId: string, deviceId: string): { profiles: ProfileDto[]; removed: RemovedProfileDto[] } {
    const now = this.now();
    return {
      profiles: this.state.profiles.filter((p) => p.accountId === accountId && p.deletedAt === null).map((p) => this.profileDto(p, deviceId)),
      removed: this.state.profiles
        .filter((p) => p.accountId === accountId && p.deletedAt !== null && (p.purgeAt ?? 0) > now)
        .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
        .map((p) => this.removedDto(p)),
    };
  }

  private profileDto(p: FProfile, deviceId: string): ProfileDto {
    const s = this.saveOf(p.id);
    const r = s && s.head ? this.revOf(s, s.head) : undefined;
    return {
      id: p.id, name: p.name, avatar: { ...p.avatar }, prefs: clone(p.prefs), createdAt: p.createdAt, updatedAt: p.updatedAt,
      main: s && r ? { epoch: r.epoch, rev: r.rev, meta: clone(r.meta), savedAt: r.createdAt, deviceName: r.deviceName, lease: this.leaseInfo(s, deviceId) } : null,
    };
  }

  private removedDto(p: FProfile): RemovedProfileDto {
    return { id: p.id, name: p.name, avatar: { ...p.avatar }, removedAt: p.deletedAt ?? 0, purgeAt: p.purgeAt ?? 0 };
  }

  /** The caller's profile: 404 foreign/unknown, 410 removed (unless allowDeleted); activeOnly → 404. */
  private ownProfile(s: FSession, pid: string, opts: { allowDeleted?: boolean; activeOnly?: boolean } = {}): FProfile {
    const p = this.state.profiles.find((x) => x.id === pid && x.accountId === s.accountId);
    if (!p) throw notFound();
    if (p.deletedAt !== null && !opts.allowDeleted) {
      if (opts.activeOnly) throw notFound();
      throw fail(410, 'profile_deleted', { purgeAt: p.purgeAt });
    }
    return p;
  }

  private checked(raw: string): { name: string; key: string } {
    const r = checkName(raw);
    if (!r.ok) throw new ApiFailure(422, 'bad_name', r.message, { problem: r.problem });
    return { name: r.name, key: nameKey(r.name) };
  }

  private nameTaken(accountId: string, key: string, except: string | null): boolean {
    return this.state.profiles.some((p) => p.accountId === accountId && p.deletedAt === null && p.nameKey === key && p.id !== except);
  }

  /** @internal */
  h_profiles(token: string | null): Omit<ProfilesResponse, 'serverTime'> {
    const s = this.session(token);
    return this.lists(s.accountId, s.deviceId);
  }
  /** @internal */
  h_createProfile(token: string | null, body: CreateProfileBody): Omit<ProfileResponse, 'serverTime'> {
    const s = this.session(token);
    const { name, key } = this.checked(body.name);
    if (this.nameTaken(s.accountId, key, null)) throw fail(409, 'name_taken');
    if (this.state.profiles.filter((p) => p.accountId === s.accountId && p.deletedAt === null).length >= this.opts.maxProfiles) {
      throw fail(409, 'profile_limit', { max: this.opts.maxProfiles });
    }
    const t = this.now();
    const p: FProfile = { id: randomId(), accountId: s.accountId, name, nameKey: key, avatar: { ...body.avatar }, prefs: {}, createdAt: t, updatedAt: t, deletedAt: null, purgeAt: null };
    this.state.profiles.push(p);
    return { profile: this.profileDto(p, s.deviceId) };
  }
  /** @internal */
  h_patchProfile(token: string | null, pid: string, body: PatchProfileBody): Omit<ProfileResponse, 'serverTime'> {
    const s = this.session(token);
    const p = this.ownProfile(s, pid);
    if (body.name === undefined && body.avatar === undefined && body.prefs === undefined) throw fail(422, 'invalid');
    if (body.prefs?.tutorial && Object.keys(body.prefs.tutorial).some((k) => !['v', 'status', 'readAloud', 'updatedAt'].includes(k))) {
      throw fail(422, 'invalid', { issues: ['prefs.tutorial: unknown key'] });
    }
    if (body.name !== undefined) {
      const { name, key } = this.checked(body.name);
      if (this.nameTaken(s.accountId, key, p.id)) throw fail(409, 'name_taken');
      p.name = name;
      p.nameKey = key;
    }
    if (body.avatar) p.avatar = { ...body.avatar };
    if (body.prefs !== undefined) p.prefs = clone(body.prefs);
    p.updatedAt = this.now();
    return { profile: this.profileDto(p, s.deviceId) };
  }
  /** @internal */
  h_removeProfile(token: string | null, pid: string): Omit<RemoveProfileResponse, 'serverTime'> {
    const s = this.session(token);
    const p = this.ownProfile(s, pid);
    p.deletedAt = this.now();
    p.purgeAt = this.now() + SOFT_DELETE_DAYS * DAY_MS;
    p.updatedAt = this.now();
    const sv = this.saveOf(pid);
    if (sv) sv.lease = null;
    return { removed: this.removedDto(p) };
  }
  /** @internal */
  h_restoreProfile(token: string | null, pid: string): Omit<ProfileResponse, 'serverTime'> {
    const s = this.session(token);
    const p = this.ownProfile(s, pid, { allowDeleted: true });
    if (p.deletedAt !== null) {
      if (p.purgeAt === null || this.now() >= p.purgeAt) throw notFound();
      if (this.nameTaken(s.accountId, p.nameKey, p.id)) throw fail(409, 'name_taken');
      if (this.state.profiles.filter((x) => x.accountId === s.accountId && x.deletedAt === null).length >= this.opts.maxProfiles) throw fail(409, 'profile_limit');
      p.deletedAt = null;
      p.purgeAt = null;
      p.updatedAt = this.now();
    }
    return { profile: this.profileDto(p, s.deviceId) };
  }

  // ================================================================ saves
  private saveOf(pid: string): FSave | undefined {
    return this.state.saves.find((s) => s.profileId === pid);
  }
  private ensureSave(pid: string): FSave {
    let s = this.saveOf(pid);
    if (!s) {
      s = { profileId: pid, head: null, revisions: [], lease: null, updatedAt: this.now() };
      this.state.saves.push(s);
    }
    return s;
  }
  private revOf(s: FSave, ref: SaveRef): FRevision | undefined {
    return s.revisions.find((r) => r.epoch === ref.epoch && r.rev === ref.rev);
  }
  private toHead(r: FRevision): SaveHead {
    return {
      epoch: r.epoch, rev: r.rev, sha256: r.sha256, sizeGz: r.sizeGz, sizeRaw: r.sizeRaw, saveVersion: r.saveVersion, appVersion: r.appVersion,
      meta: clone(r.meta), device: { id: r.deviceId, name: r.deviceName }, savedAt: r.createdAt, clientSavedAt: r.clientSavedAt, pushId: r.pushId,
    };
  }
  private currentHead(s: FSave): SaveHead | null {
    const r = s.head ? this.revOf(s, s.head) : undefined;
    return r ? this.toHead(r) : null;
  }
  private leaseLive(s: FSave): boolean {
    return !!s.lease && s.lease.until > this.now();
  }
  private leaseInfo(s: FSave, deviceId: string): LeaseInfo | null {
    if (!this.leaseLive(s)) return null;
    return { deviceName: s.lease!.deviceName, until: s.lease!.until, mine: s.lease!.deviceId === deviceId };
  }
  private leaseConflict(s: FSave): LeaseConflictDetails {
    return { holder: { deviceName: s.lease?.deviceName ?? 'Another device', lastSeenAt: s.lease?.seenAt ?? s.updatedAt }, head: this.currentHead(s) };
  }

  /** Server-side checks of an uploaded save (size, sha256, gzip JSON with numeric version). */
  private decodeUpload(data: string, sha: string, saveVersion: number, maxGz: number): { sizeGz: number; sizeRaw: number; sha: string } {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(data);
    } catch {
      throw fail(422, 'invalid', { issues: ['data: not base64'] });
    }
    if (bytes.length > maxGz) throw fail(413, 'too_large');
    const real = sha256HexSync(bytes);
    if (real !== sha.toLowerCase()) throw fail(422, 'checksum');
    let json: string;
    try {
      json = gunzipToString(bytes);
    } catch {
      throw fail(422, 'bad_save');
    }
    let v: unknown;
    try {
      v = (JSON.parse(json) as { version?: unknown }).version;
    } catch {
      throw fail(422, 'bad_save');
    }
    if (typeof v !== 'number' || v !== saveVersion) throw fail(422, 'bad_save');
    return { sizeGz: bytes.length, sizeRaw: utf8Length(json), sha: real };
  }

  private accountBytes(accountId: string): number {
    const pids = new Set(this.state.profiles.filter((p) => p.accountId === accountId).map((p) => p.id));
    let n = 0;
    for (const s of this.state.saves) if (pids.has(s.profileId)) for (const r of s.revisions) if (r.data !== null) n += r.sizeGz;
    for (const st of this.state.stashes) if (pids.has(st.profileId)) n += base64ToBytes(st.data).length;
    return n;
  }

  private retention(s: FSave): void {
    const now = this.now();
    const newest = [...s.revisions].sort((a, b) => b.rev - a.rev || b.createdAt - a.createdAt).slice(0, KEEP_BLOBS);
    const keep = (r: FRevision) => newest.includes(r) || (r.pinnedUntil !== null && r.pinnedUntil > now) || (!!s.head && r.epoch === s.head.epoch && r.rev === s.head.rev);
    for (const r of s.revisions) if (!keep(r)) r.data = null;
    s.revisions = s.revisions.filter((r) => keep(r) || now - r.createdAt < 30 * DAY_MS);
  }

  /** @internal */
  h_getHead(token: string | null, pid: string, pushIds: readonly string[]): Omit<GetHeadResponse, 'serverTime'> {
    const se = this.session(token);
    this.ownProfile(se, pid);
    if (pushIds.length > 4) throw fail(422, 'invalid', { issues: ['at most 4 pushIds'] });
    const s = this.saveOf(pid);
    let pushed: PushedRef | null = null;
    if (s && pushIds.length) {
      for (const r of s.revisions) {
        if (!pushIds.includes(r.pushId)) continue;
        if (!pushed || r.rev > pushed.rev) pushed = { epoch: r.epoch, rev: r.rev, pushId: r.pushId };
      }
    }
    return { head: s ? this.currentHead(s) : null, lease: s ? this.leaseInfo(s, se.deviceId) : null, pushed };
  }
  /** @internal */
  h_getData(token: string | null, pid: string): Omit<SaveDataResponse, 'serverTime'> {
    const se = this.session(token);
    this.ownProfile(se, pid);
    const s = this.saveOf(pid);
    const r = s && s.head ? this.revOf(s, s.head) : undefined;
    if (!r || r.data === null) throw notFound();
    let data = r.data;
    if (this.corrupt > 0) {
      this.corrupt--;
      const b = base64ToBytes(data);
      b[b.length >> 1] = b[b.length >> 1]! ^ 0xff;
      data = btoa(String.fromCharCode(...b));
    }
    return { head: this.toHead(r), encoding: 'gzip+base64', data };
  }
  /** @internal */
  h_putSave(token: string | null, pid: string, body: PutSaveBody): Omit<PutSaveResponse, 'serverTime'> {
    const se = this.session(token);
    this.ownProfile(se, pid);
    const dec = this.decodeUpload(body.data, body.sha256, body.saveVersion, SAVE_MAX_GZ_BYTES);
    const now = this.now();
    const s = this.ensureSave(pid);
    if (this.leaseLive(s) && s.lease!.deviceId !== se.deviceId) throw fail(409, 'leased_elsewhere', { ...this.leaseConflict(s) });
    const replayed = [...s.revisions].sort((a, b) => b.rev - a.rev).find((r) => r.pushId === body.pushId);
    if (replayed) {
      const isHead = !!s.head && replayed.epoch === s.head.epoch && replayed.rev === s.head.rev;
      return { head: isHead ? this.toHead(replayed) : this.currentHead(s)!, replay: true };
    }
    const head = this.currentHead(s);
    const headRef = head ? { epoch: head.epoch, rev: head.rev } : null;
    const same = body.base === null || headRef === null ? body.base === headRef : body.base.epoch === headRef.epoch && body.base.rev === headRef.rev;
    if (!same) throw fail(412, 'conflict', { head });
    if (this.accountBytes(se.accountId) + dec.sizeGz > this.opts.maxAccountBytes) throw fail(413, 'quota');
    const r: FRevision = {
      epoch: this.epoch, rev: (head?.rev ?? 0) + 1, pushId: body.pushId, deviceId: se.deviceId, deviceName: se.deviceName,
      appVersion: se.appVersion, saveVersion: body.saveVersion, meta: clone(body.meta), clientSavedAt: body.clientSavedAt,
      sizeRaw: dec.sizeRaw, sizeGz: dec.sizeGz, sha256: dec.sha, data: body.data, pinnedUntil: null, createdAt: now,
    };
    s.revisions.push(r);
    s.head = { epoch: r.epoch, rev: r.rev };
    s.updatedAt = now;
    if (this.leaseLive(s) && s.lease!.deviceId === se.deviceId) {
      s.lease!.until = now + this.opts.leaseSeconds * 1000;
      s.lease!.seenAt = now;
    }
    if (body.resolution === 'keep_local' && headRef) {
      const old = this.revOf(s, headRef);
      if (old) old.pinnedUntil = Math.max(old.pinnedUntil ?? 0, now + PIN_MS);
    }
    this.retention(s);
    return { head: this.toHead(r), replay: false };
  }
  /** @internal */
  h_lease(token: string | null, pid: string, body: LeaseBody): Omit<LeaseResponse, 'serverTime'> {
    const se = this.session(token);
    this.ownProfile(se, pid);
    const now = this.now();
    if (body.action === 'release') {
      const s = this.saveOf(pid);
      if (s && s.lease && s.lease.deviceId === se.deviceId) s.lease = null;
      return { lease: s ? this.leaseInfo(s, se.deviceId) : null, head: s ? this.currentHead(s) : null };
    }
    const s = this.ensureSave(pid);
    const elsewhere = this.leaseLive(s) && s.lease!.deviceId !== se.deviceId;
    if (elsewhere && (body.action === 'renew' || !body.takeover)) {
      throw fail(409, body.action === 'renew' ? 'lease_lost' : 'in_use', { ...this.leaseConflict(s) });
    }
    s.lease = { deviceId: se.deviceId, deviceName: se.deviceName, until: now + this.opts.leaseSeconds * 1000, seenAt: now };
    return { lease: this.leaseInfo(s, se.deviceId), head: this.currentHead(s) };
  }
  /** @internal */
  h_stash(token: string | null, pid: string, body: StashBody): { status: number; res: Omit<StashResponse, 'serverTime'> } {
    const se = this.session(token);
    this.ownProfile(se, pid);
    const dec = this.decodeUpload(body.data, body.sha256, body.saveVersion, SAVE_MAX_GZ_BYTES);
    const existing = this.state.stashes.find((x) => x.stashId === body.stashId);
    if (existing) {
      if (existing.profileId !== pid) throw fail(422, 'invalid', { issues: ['stashId: already used'] });
      return { status: 200, res: { stashId: existing.stashId, pinnedUntil: existing.pinnedUntil } };
    }
    if (this.accountBytes(se.accountId) + dec.sizeGz > this.opts.maxAccountBytes) throw fail(413, 'quota');
    const st: FStash = {
      stashId: body.stashId, profileId: pid, reason: body.reason, deviceName: se.deviceName, meta: clone(body.meta), saveVersion: body.saveVersion,
      sha256: dec.sha, data: body.data, pinnedUntil: this.now() + PIN_MS, createdAt: this.now(),
    };
    this.state.stashes.push(st);
    return { status: 201, res: { stashId: st.stashId, pinnedUntil: st.pinnedUntil } };
  }

  // ================================================================ versus (subset of api §3.5)
  private matchOf(id: string): FMatch {
    const m = this.state.matches.find((x) => x.id === id);
    if (!m) throw notFound();
    return m;
  }
  private viewerSeat(m: FMatch, pid: string): 0 | 1 | null {
    const s = m.seats.find((x) => x.profileId === pid);
    if (s) return s.seat;
    if (m.invitedProfileId === pid && !m.seats.some((x) => x.seat === 1)) return 1;
    return null;
  }
  private family(m: FMatch): boolean {
    if (m.kind === 'family') return true;
    const [a, b] = m.seats;
    return !!a && !!b && a.accountId !== null && a.accountId === b.accountId;
  }
  private finalize(m: FMatch): void {
    const now = this.now();
    if (m.status === 'open') {
      if (m.codeExpiresAt !== null && now > m.codeExpiresAt) {
        m.status = 'expired';
        m.result = { kind: 'none', winnerSeat: null, reason: 'expired', comparedAtHour: null, totals: [m.seats[0]?.lastTotal ?? 0, 0], decidedAt: now };
      }
      return;
    }
    if (m.status !== 'active' || m.seats.length < 2) return;
    const input = (s: FSeat): SeatOutcomeInput => ({
      forfeited: s.endReason === 'forfeit',
      done: s.doneAt !== null,
      endHour: s.doneAt !== null ? (s.endHour ?? s.ackHour) : s.ackHour,
      totalAt: (h: number) => m.snapshots[`${s.seat}:${h}`]?.total ?? null,
      lastTotal: s.lastTotal,
    });
    const core = decideOutcome({ hoursTotal: hoursTotal(m.days), now, finishBy: m.finishBy, seats: [input(m.seats[0]!), input(m.seats[1]!)] });
    if (core === 'pending') return;
    if (m.finishBy !== null && now > m.finishBy) {
      for (const s of m.seats) if (s.doneAt === null) Object.assign(s, { doneAt: m.finishBy, endHour: s.ackHour, endReason: 'deadline' });
    }
    m.result = { ...core, decidedAt: now };
    m.status = 'finished';
  }
  private seatState(s: FSeat): SeatDto['state'] {
    if (s.profileId === null) return 'left';
    if (s.doneAt !== null) return 'done';
    if (s.firstSnapshotAt !== null || s.ackHour > 0) return 'playing';
    return 'joined';
  }
  private matchDto(m: FMatch, pid: string, deviceId: string): MatchDto {
    const mySeat = this.viewerSeat(m, pid);
    if (mySeat === null) throw notFound();
    const now = this.now();
    const players: SeatDto[] = m.seats.map((s) => ({
      seat: s.seat, role: s.seat === 0 ? 'challenger' : 'opponent', name: s.name, avatar: { ...s.avatar }, isMe: s.seat === mySeat,
      state: this.seatState(s), lastHour: s.ackHour, total: s.lastTotal, parts: clone(s.lastParts), live: s.lastPostAt !== null && now - s.lastPostAt <= LIVE_WINDOW_MS,
      doneAt: s.doneAt, endHour: s.endHour, endReason: s.endReason,
      device: s.seat === mySeat && s.deviceName !== null ? { name: s.deviceName, here: s.deviceId === deviceId } : null,
    }));
    if (m.invitedProfileId !== null && !m.seats.some((s) => s.seat === 1)) {
      const p = this.state.profiles.find((x) => x.id === m.invitedProfileId);
      players.push({
        seat: 1, role: 'opponent', name: p && p.deletedAt === null ? p.name : 'Player', avatar: p ? { ...p.avatar } : { animal: 'lion', color: 0 },
        isMe: mySeat === 1, state: 'invited', lastHour: 0, total: 0, parts: null, live: false, doneAt: null, endHour: null, endReason: null, device: null,
      });
    }
    return {
      id: m.id, kind: m.kind, code: m.kind === 'coded' && m.status === 'open' && mySeat === 0 ? m.code : null, lengthMin: m.lengthMin as VersusLength,
      days: m.days, seed: m.seed, rulesVersion: m.rulesVersion, startMoney: m.startMoney, startMinute: VERSUS_START_MINUTE, budgetMin: m.budgetMin,
      status: m.status, createdAt: m.createdAt, codeExpiresAt: m.codeExpiresAt, joinedAt: m.joinedAt, finishBy: m.finishBy, mySeat, players,
      result: clone(m.result),
    };
  }
  private newSeat(seat: 0 | 1, p: FProfile): FSeat {
    const r = checkName(p.name);
    return {
      seat, profileId: p.id, accountId: p.accountId, name: r.ok ? r.name : 'Player', avatar: { ...p.avatar }, joinedAt: this.now(), deviceId: null,
      deviceName: null, firstSnapshotAt: null, ackHour: 0, lastTotal: 0, lastParts: null, lastPostAt: null, doneAt: null, endHour: null, endReason: null, flags: [],
    };
  }
  private activeCount(pid: string): number {
    return this.state.matches.filter((m) => m.status === 'active' && m.seats.some((s) => s.profileId === pid)).length;
  }
  private newMatch(kind: MatchKind, lengthMin: number, seats: FSeat[], invited: string | null): FMatch {
    const spec = lengthSpec(lengthMin, this.opts.testLength);
    if (!spec || !((this.opts.versusLengths as number[]).includes(lengthMin) || (lengthMin === 4 && this.opts.testLength))) {
      throw fail(422, 'invalid', { issues: [`lengthMin: ${lengthMin} is not offered`] });
    }
    const now = this.now();
    let code: string | null = null;
    if (kind === 'coded') {
      do {
        code = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
      } while (this.state.matches.some((m) => m.code === code));
    }
    const active = seats.length === 2;
    const m: FMatch = {
      id: randomId(), kind, code, lengthMin, days: spec.days, seed: Math.floor(Math.random() * 2 ** 31), rulesVersion: VERSUS_RULES_VERSION,
      startMoney: spec.startMoney, budgetMin: spec.budgetMin, status: active ? 'active' : 'open', createdAt: now,
      codeExpiresAt: active ? null : now + CODE_TTL_MS, joinedAt: active ? now : null, finishBy: active ? now + FINISH_WINDOW_MS : null,
      invitedProfileId: invited, result: null, seats, snapshots: {},
    };
    this.state.matches.push(m);
    return m;
  }
  private callerProfile(se: FSession, pid: string): FProfile {
    return this.ownProfile(se, pid, { activeOnly: true });
  }
  private loadMatch(se: FSession, id: string, pid: string): { m: FMatch; mySeat: 0 | 1 } {
    this.callerProfile(se, pid);
    const m = this.matchOf(id);
    const mySeat = this.viewerSeat(m, pid);
    if (mySeat === null) throw notFound();
    this.finalize(m);
    return { m, mySeat };
  }
  private playable(m: FMatch, me: FSeat, deviceId: string): void {
    if (m.status === 'cancelled') throw fail(409, 'match_state');
    if (me.doneAt !== null) throw fail(409, 'match_over');
    const ok = (m.status === 'active' && m.finishBy !== null && this.now() <= m.finishBy) || (m.status === 'open' && me.seat === 0);
    if (!ok) throw fail(409, 'match_over');
    if (me.deviceId !== null && me.deviceId !== deviceId) throw fail(409, 'other_device', { deviceName: me.deviceName ?? 'another device' });
  }
  private bind(me: FSeat, se: FSession): void {
    if (me.deviceId !== null) return;
    me.deviceId = se.deviceId;
    me.deviceName = se.deviceName;
    me.firstSnapshotAt = me.firstSnapshotAt ?? this.now();
  }
  private t0(m: FMatch, me: FSeat): number {
    return me.seat === 1 && !this.family(m) ? (m.joinedAt ?? me.joinedAt) : m.createdAt;
  }

  /** @internal */
  h_createMatch(token: string | null, body: CreateMatchBody): Omit<MatchResponse, 'serverTime'> {
    const se = this.session(token);
    if (body.rulesVersion !== VERSUS_RULES_VERSION) throw fail(426, 'upgrade_required');
    const p = this.callerProfile(se, body.profileId);
    if (body.opponentProfileId !== undefined) {
      if (body.opponentProfileId === p.id) throw fail(422, 'invalid');
      const o = this.state.profiles.find((x) => x.id === body.opponentProfileId && x.accountId === se.accountId && x.deletedAt === null);
      if (!o) throw notFound();
      if (this.activeCount(p.id) >= 3 || this.activeCount(o.id) >= 3) throw fail(409, 'active_limit');
      const m = this.newMatch('family', body.lengthMin, [this.newSeat(0, p), this.newSeat(1, o)], null);
      return { match: this.matchDto(m, p.id, se.deviceId) };
    }
    if (this.state.matches.some((m) => m.kind === 'coded' && m.status === 'open' && m.seats[0]?.profileId === p.id)) throw fail(409, 'open_limit');
    if (this.activeCount(p.id) >= 3) throw fail(409, 'active_limit');
    const m = this.newMatch('coded', body.lengthMin, [this.newSeat(0, p)], null);
    return { match: this.matchDto(m, p.id, se.deviceId) };
  }
  /** @internal */
  h_previewCode(token: string | null, rawCode: string, profileId: string): Omit<CodePreviewResponse, 'serverTime'> {
    const se = this.session(token);
    this.callerProfile(se, profileId);
    const code = normalizeCode(rawCode);
    const m = this.state.matches.find((x) => x.code === code);
    if (!m) throw notFound();
    this.finalize(m);
    const s0 = m.seats[0]!;
    return { matchId: m.id, challenger: { name: s0.name, avatar: { ...s0.avatar } }, lengthMin: m.lengthMin as VersusLength, days: m.days, status: m.status, codeExpiresAt: m.codeExpiresAt };
  }
  /** @internal */
  h_joinMatch(token: string | null, id: string, body: JoinMatchBody): Omit<MatchResponse, 'serverTime'> {
    const se = this.session(token);
    if (body.rulesVersion !== VERSUS_RULES_VERSION) throw fail(426, 'upgrade_required');
    const p = this.callerProfile(se, body.profileId);
    const m = this.matchOf(id);
    if (body.code !== undefined) {
      if (m.code === null || normalizeCode(body.code) !== m.code) throw notFound();
    } else if (!(m.kind === 'rematch' && m.invitedProfileId === p.id)) throw notFound();
    this.finalize(m);
    if (m.seats[0]?.profileId === p.id) throw fail(403, 'own_match');
    if (m.status === 'expired') throw fail(409, 'code_expired');
    if (m.status === 'cancelled' || m.status === 'finished') throw fail(409, 'match_state');
    if (m.status === 'active' || m.seats.some((s) => s.seat === 1)) throw fail(409, 'match_full');
    if (this.activeCount(p.id) >= 3) throw fail(409, 'active_limit');
    m.seats.push(this.newSeat(1, p));
    m.status = 'active';
    m.joinedAt = this.now();
    m.finishBy = this.now() + FINISH_WINDOW_MS;
    m.invitedProfileId = null;
    // the code stays on the match (as on the server): a second joiner gets 409 match_full,
    // "Someone already joined this one" (the DTO shows the code only while open)
    this.finalize(m);
    return { match: this.matchDto(m, p.id, se.deviceId) };
  }
  /** @internal */
  h_listMatches(token: string | null, profileId: string, state?: 'active' | 'finished' | 'all'): Omit<MatchListResponse, 'serverTime'> {
    const se = this.session(token);
    const p = this.callerProfile(se, profileId);
    const mine = this.state.matches.filter((m) => m.seats.some((s) => s.profileId === p.id) || (m.invitedProfileId === p.id && m.status === 'open'));
    for (const m of mine) this.finalize(m);
    const ok = (m: FMatch) => state === 'active' ? m.status === 'open' || m.status === 'active' : state === 'finished' ? !(m.status === 'open' || m.status === 'active') : true;
    return { matches: mine.filter(ok).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map((m) => this.matchDto(m, p.id, se.deviceId)) };
  }
  /** @internal */
  h_getMatch(token: string | null, id: string, profileId: string): Omit<MatchResponse, 'serverTime'> {
    const se = this.session(token);
    const { m } = this.loadMatch(se, id, profileId);
    return { match: this.matchDto(m, profileId, se.deviceId) };
  }
  /** @internal */
  h_postSnapshots(token: string | null, id: string, body: SnapshotsBody): Omit<SnapshotsResponse, 'serverTime'> {
    const se = this.session(token);
    const { m, mySeat } = this.loadMatch(se, id, body.profileId);
    const me = m.seats.find((s) => s.seat === mySeat);
    if (!me) throw notFound();
    this.playable(m, me, se.deviceId);
    const total = hoursTotal(m.days);
    const fresh = [...body.snapshots].sort((a, b) => a.h - b.h).filter((s) => s.h > me.ackHour);
    if (fresh.length > 0) {
      const verdict = checkPace(fresh[fresh.length - 1]!.h, this.now() - this.t0(m, me), this.family(m));
      if (verdict === 'reject') throw fail(422, 'too_fast');
    }
    this.bind(me, se);
    let prev = me.ackHour > 0 ? (m.snapshots[`${me.seat}:${me.ackHour}`] ?? null) : null;
    let failure: ApiFailure | null = null;
    for (const s of fresh) {
      if (!Number.isInteger(s.h) || s.h % SNAPSHOT_EVERY_HOURS !== 0) {
        failure = fail(422, 'bad_snapshot', { h: s.h });
        break;
      }
      const step = checkSnapshotStep(prev, s, total);
      if (!step.ok) {
        failure = fail(422, 'bad_snapshot', { h: s.h, detail: step.detail });
        break;
      }
      m.snapshots[`${me.seat}:${s.h}`] = { ...clone(s), total: Math.round(s.total) };
      me.ackHour = s.h;
      me.lastTotal = Math.round(s.total);
      me.lastParts = clone(s.parts);
      prev = s;
    }
    me.lastPostAt = this.now();
    if (failure) throw failure;
    return { ackHour: me.ackHour, opponent: this.opponent(m, mySeat) };
  }
  private opponent(m: FMatch, mySeat: 0 | 1): SnapshotsResponse['opponent'] {
    const opp = m.seats.find((s) => s.seat !== mySeat);
    const me = m.seats.find((s) => s.seat === mySeat);
    if (!opp || !me) return null;
    let atMyHour: number | null = null;
    if (opp.ackHour >= me.ackHour) {
      for (let h = me.ackHour; h > 0; h--) {
        const s = m.snapshots[`${opp.seat}:${h}`];
        if (s) {
          atMyHour = s.total;
          break;
        }
      }
    }
    return { lastHour: opp.ackHour, total: opp.lastTotal, parts: clone(opp.lastParts), live: opp.lastPostAt !== null && this.now() - opp.lastPostAt <= LIVE_WINDOW_MS, done: opp.doneAt !== null, atMyHour };
  }
  /** @internal */
  h_series(token: string | null, id: string, profileId: string, since = 0): Omit<SeriesResponse, 'serverTime'> {
    const se = this.session(token);
    const { m, mySeat } = this.loadMatch(se, id, profileId);
    const opp = m.seats.find((s) => s.seat !== mySeat);
    if (!opp) throw notFound();
    const rows: SeriesRow[] = Object.values(m.snapshots)
      .filter((s) => m.snapshots[`${opp.seat}:${s.h}`] === s && s.h > since)
      .sort((a, b) => a.h - b.h)
      .map((s) => [s.h, s.total, s.parts.v, s.parts.a, s.parts.s, s.parts.b, s.parts.m, s.parts.l]);
    return { lastHour: opp.ackHour, done: opp.doneAt !== null, series: rows };
  }
  /** @internal */
  h_finish(token: string | null, id: string, body: FinishBody): Omit<MatchResponse, 'serverTime'> {
    const se = this.session(token);
    this.decodeUpload(body.save.data, body.save.sha256, (() => {
      try {
        return (JSON.parse(gunzipToString(base64ToBytes(body.save.data))) as { version: number }).version;
      } catch {
        return -1;
      }
    })(), FINAL_SAVE_MAX_GZ_BYTES);
    const { m, mySeat } = this.loadMatch(se, id, body.profileId);
    const me = m.seats.find((s) => s.seat === mySeat);
    if (!me) throw notFound();
    if (me.doneAt !== null) return { match: this.matchDto(m, body.profileId, se.deviceId) };
    this.playable(m, me, se.deviceId);
    const total = hoursTotal(m.days);
    const f = body.final;
    if (body.endReason === 'complete' && f.h !== total) throw fail(422, 'invalid');
    if (body.endReason === 'budget' && !(Number.isInteger(f.h) && f.h >= 1 && f.h < total)) throw fail(422, 'invalid');
    const prev = me.ackHour > 0 ? (m.snapshots[`${me.seat}:${me.ackHour}`] ?? null) : null;
    if (!(prev && prev.h === f.h)) {
      const step = checkSnapshotStep(prev, f, total);
      if (!step.ok) throw fail(422, 'bad_snapshot', { h: f.h, detail: step.detail });
      m.snapshots[`${me.seat}:${f.h}`] = { ...clone(f), total: Math.round(f.total) };
      me.ackHour = f.h;
      me.lastTotal = Math.round(f.total);
      me.lastParts = clone(f.parts);
    }
    this.bind(me, se);
    Object.assign(me, { doneAt: this.now(), endHour: f.h, endReason: body.endReason, lastPostAt: this.now() });
    this.finalize(m);
    return { match: this.matchDto(m, body.profileId, se.deviceId) };
  }
  /** @internal */
  h_forfeit(token: string | null, id: string, body: ProfileOnlyBody): Omit<MatchResponse, 'serverTime'> {
    const se = this.session(token);
    const { m, mySeat } = this.loadMatch(se, id, body.profileId);
    const me = m.seats.find((s) => s.seat === mySeat);
    if (!me) throw notFound();
    if (m.status === 'open') {
      m.status = 'cancelled';
      m.code = null;
      if (me.doneAt === null) Object.assign(me, { doneAt: this.now(), endHour: me.ackHour, endReason: 'forfeit' });
    } else if (m.status === 'active' && me.doneAt === null) {
      Object.assign(me, { doneAt: this.now(), endHour: me.ackHour, endReason: 'forfeit' });
    }
    this.finalize(m);
    return { match: this.matchDto(m, body.profileId, se.deviceId) };
  }
  /** @internal */
  h_cancel(token: string | null, id: string, body: ProfileOnlyBody): Omit<MatchResponse, 'serverTime'> {
    const se = this.session(token);
    const { m } = this.loadMatch(se, id, body.profileId);
    const s0 = m.seats[0];
    if (!s0 || s0.profileId !== body.profileId) throw notFound();
    if (m.status !== 'open' || s0.firstSnapshotAt !== null || s0.ackHour > 0 || s0.doneAt !== null) throw fail(409, 'match_state');
    m.status = 'cancelled';
    m.code = null;
    return { match: this.matchDto(m, body.profileId, se.deviceId) };
  }
  /** @internal */
  h_rematch(token: string | null, id: string, body: ProfileOnlyBody): Omit<MatchResponse, 'serverTime'> {
    const se = this.session(token);
    const { m } = this.loadMatch(se, id, body.profileId);
    const me = m.seats.find((s) => s.profileId === body.profileId);
    if (!me) throw notFound();
    if (m.status !== 'finished') throw fail(409, 'match_state');
    const other = m.seats.find((s) => s.seat !== me.seat);
    if (!other || other.profileId === null) throw notFound();
    const op = this.state.profiles.find((x) => x.id === other.profileId);
    if (!op || op.deletedAt !== null) throw notFound();
    const p = this.callerProfile(se, body.profileId);
    const nm = op.accountId === se.accountId
      ? this.newMatch('family', m.lengthMin, [this.newSeat(0, p), this.newSeat(1, op)], null)
      : this.newMatch('rematch', m.lengthMin, [this.newSeat(0, p)], op.id);
    return { match: this.matchDto(nm, body.profileId, se.deviceId) };
  }
}

function withServerTime<T>(v: T, now: number): T {
  if (v && typeof v === 'object' && !Array.isArray(v)) (v as Record<string, unknown>).serverTime = now;
  return v;
}

// ------------------------------------------------------------------ a client bound to one token
export class FakeCloudClient implements CloudApi {
  readonly fake: FakeCloud;
  readonly id: number;
  readonly token: () => string | null;
  readonly appVersion: string;
  /** This client (phone) has no network. */
  offline = false;

  constructor(fake: FakeCloud, id: number, token: () => string | null, appVersion: string) {
    this.fake = fake;
    this.id = id;
    this.token = token;
    this.appVersion = appVersion;
  }

  private r<T>(op: FakeOp, info: Partial<FakeCall>, opts: CallOptions | undefined, fn: (t: string | null) => T): Promise<T> {
    return this.fake.run(this, op, info, opts?.timeoutMs, (c) => fn(c.token));
  }

  serverTimeOffset(): number {
    return 0;
  }
  config(): Promise<ConfigResponse> {
    return this.r('config', {}, undefined, () => this.fake.h_config() as ConfigResponse);
  }
  nonce(): Promise<NonceResponse> {
    return this.r('nonce', {}, undefined, () => this.fake.h_nonce() as NonceResponse);
  }
  signIn(body: GoogleSignInBody): Promise<SignInResponse> {
    return this.r('signIn', { body }, undefined, () => this.fake.h_signIn(body) as SignInResponse);
  }
  signOut(): Promise<void> {
    return this.r('signOut', {}, undefined, (t) => this.fake.h_signOut(t));
  }
  account(): Promise<AccountResponse> {
    return this.r('account', {}, undefined, (t) => this.fake.h_account(t) as AccountResponse);
  }
  deleteAccount(body: DeleteAccountBody): Promise<void> {
    return this.r('deleteAccount', {}, undefined, (t) => this.fake.h_deleteAccount(t, body));
  }
  profiles(): Promise<ProfilesResponse> {
    return this.r('profiles', {}, undefined, (t) => this.fake.h_profiles(t) as ProfilesResponse);
  }
  createProfile(body: CreateProfileBody): Promise<ProfileResponse> {
    return this.r('createProfile', { body }, undefined, (t) => this.fake.h_createProfile(t, body) as ProfileResponse);
  }
  patchProfile(pid: string, body: PatchProfileBody): Promise<ProfileResponse> {
    return this.r('patchProfile', { pid, body }, undefined, (t) => this.fake.h_patchProfile(t, pid, body) as ProfileResponse);
  }
  removeProfile(pid: string): Promise<RemoveProfileResponse> {
    return this.r('removeProfile', { pid }, undefined, (t) => this.fake.h_removeProfile(t, pid) as RemoveProfileResponse);
  }
  restoreProfile(pid: string): Promise<ProfileResponse> {
    return this.r('restoreProfile', { pid }, undefined, (t) => this.fake.h_restoreProfile(t, pid) as ProfileResponse);
  }
  getHead(pid: string, pushIds: readonly string[] = [], opts?: CallOptions): Promise<GetHeadResponse> {
    return this.r('getHead', { pid }, opts, (t) => this.fake.h_getHead(t, pid, pushIds) as GetHeadResponse);
  }
  getData(pid: string, opts?: CallOptions): Promise<SaveDataResponse> {
    return this.r('getData', { pid }, opts, (t) => this.fake.h_getData(t, pid) as SaveDataResponse);
  }
  putSave(pid: string, body: PutSaveBody, opts?: CallOptions): Promise<PutSaveResponse> {
    return this.r('putSave', { pid, body }, opts, (t) => this.fake.h_putSave(t, pid, body) as PutSaveResponse);
  }
  lease(pid: string, body: LeaseBody, opts?: CallOptions): Promise<LeaseResponse> {
    return this.r('lease', { pid, body }, opts, (t) => this.fake.h_lease(t, pid, body) as LeaseResponse);
  }
  stash(pid: string, body: StashBody, opts?: CallOptions): Promise<StashResponse> {
    return this.r('stash', { pid }, opts, (t) => this.fake.h_stash(t, pid, body).res as StashResponse);
  }
  createMatch(body: CreateMatchBody): Promise<MatchResponse> {
    return this.r('createMatch', { body }, undefined, (t) => this.fake.h_createMatch(t, body) as MatchResponse);
  }
  previewCode(code: string, profileId: string): Promise<CodePreviewResponse> {
    return this.r('previewCode', {}, undefined, (t) => this.fake.h_previewCode(t, code, profileId) as CodePreviewResponse);
  }
  joinMatch(matchId: string, body: JoinMatchBody): Promise<MatchResponse> {
    return this.r('joinMatch', { matchId }, undefined, (t) => this.fake.h_joinMatch(t, matchId, body) as MatchResponse);
  }
  listMatches(profileId: string, state?: 'active' | 'finished' | 'all'): Promise<MatchListResponse> {
    return this.r('listMatches', {}, undefined, (t) => this.fake.h_listMatches(t, profileId, state) as MatchListResponse);
  }
  getMatch(matchId: string, profileId: string, opts?: CallOptions): Promise<MatchResponse> {
    return this.r('getMatch', { matchId }, opts, (t) => this.fake.h_getMatch(t, matchId, profileId) as MatchResponse);
  }
  postSnapshots(matchId: string, body: SnapshotsBody, opts?: CallOptions): Promise<SnapshotsResponse> {
    return this.r('postSnapshots', { matchId, body }, opts, (t) => this.fake.h_postSnapshots(t, matchId, body) as SnapshotsResponse);
  }
  series(matchId: string, profileId: string, since?: number): Promise<SeriesResponse> {
    return this.r('series', { matchId }, undefined, (t) => this.fake.h_series(t, matchId, profileId, since) as SeriesResponse);
  }
  finish(matchId: string, body: FinishBody, opts?: CallOptions): Promise<MatchResponse> {
    return this.r('finish', { matchId }, opts, (t) => this.fake.h_finish(t, matchId, body) as MatchResponse);
  }
  forfeit(matchId: string, body: ProfileOnlyBody): Promise<MatchResponse> {
    return this.r('forfeit', { matchId }, undefined, (t) => this.fake.h_forfeit(t, matchId, body) as MatchResponse);
  }
  cancel(matchId: string, body: ProfileOnlyBody): Promise<MatchResponse> {
    return this.r('cancel', { matchId }, undefined, (t) => this.fake.h_cancel(t, matchId, body) as MatchResponse);
  }
  rematch(matchId: string, body: ProfileOnlyBody): Promise<MatchResponse> {
    return this.r('rematch', { matchId }, undefined, (t) => this.fake.h_rematch(t, matchId, body) as MatchResponse);
  }

  keepalive(call: KeepaliveCall, maxBytes: number): KeepaliveSent | null {
    const bytes = utf8Length(JSON.stringify(call.body));
    if (bytes > maxBytes) return null;
    let p: Promise<unknown>;
    switch (call.kind) {
      case 'putSave':
        p = this.fake.run(this, 'putSave', { pid: call.pid, keepalive: true, body: call.body }, undefined, (c) => this.fake.h_putSave(c.token, call.pid, call.body));
        break;
      case 'lease':
        p = this.fake.run(this, 'lease', { pid: call.pid, keepalive: true, body: call.body }, undefined, (c) => this.fake.h_lease(c.token, call.pid, call.body));
        break;
      case 'snapshots':
        p = this.fake.run(this, 'postSnapshots', { matchId: call.matchId, keepalive: true, body: call.body }, undefined, (c) => this.fake.h_postSnapshots(c.token, call.matchId, call.body));
        break;
      case 'finish':
        p = this.fake.run(this, 'finish', { matchId: call.matchId, keepalive: true }, undefined, (c) => this.fake.h_finish(c.token, call.matchId, call.body));
        break;
    }
    const done = p.then(
      (value) => ({ ok: true as const, value }),
      (e: unknown) => ({ ok: false as const, failure: e instanceof ApiFailure ? e : new ApiFailure(0, 'network', String(e)) }),
    );
    return { bytes, done };
  }
}
