// Cloud interfaces (feature round 14, spec §8.6): what src/net/** implements and main.ts, the
// title menu, the account UI and versus use. Types only; the wire types live in shared/api-types.
import type * as Api from '../../shared/api-types';
import type { ISimulation, PlayerInfo, PlayerRef, SlotKey } from './contracts';

export interface Store<T> { get(): T; subscribe(fn: (v: T) => void): () => void }
export type AuthState =
  | { kind: 'disabled' } | { kind: 'guest' } | { kind: 'signing-in' }
  | { kind: 'signed-in'; accountId: string; email: string | null }
  | { kind: 'needs-signin'; accountId: string; email: string | null };
export type SignInOutcome = { kind: 'ok'; isNew: boolean } | { kind: 'cancelled' }
  | { kind: 'error'; reason: 'offline' | 'no_google' | 'server' | 'not_allowed' | 'unknown'; message: string };
export interface AuthManager {
  readonly state: Store<AuthState>;
  readonly accountId: string | null;
  signIn(): Promise<SignInOutcome>;
  signOut(opts?: { force?: boolean }): Promise<'ok' | 'unsynced'>;   // 'unsynced': caller shows the warning, then signOut({force:true})
  deleteAccount(): Promise<'ok' | 'cancelled' | 'mismatch' | 'offline' | 'error'>;
}
export type SlotUiState = 'local' | 'synced' | 'pending' | 'offline' | 'conflict' | 'waiting' | 'blocked';
export interface CachedProfile extends Api.ProfileDto { local: { hasMain: boolean; meta: Api.SaveMeta | null; state: SlotUiState } }
export interface FriendlyError { message: string; code: Api.ApiErrorCode | 'network' | 'timeout' | 'disabled' }
export interface ProfileService {
  list(): CachedProfile[];                     // signed-in or needs-signin account; [] otherwise
  removed(): Api.RemovedProfileDto[];
  refresh(): Promise<boolean>;                 // false when offline
  create(name: string, avatar: Api.Avatar): Promise<Api.ProfileDto>;            // rejects with FriendlyError
  rename(pid: string, name: string): Promise<Api.ProfileDto>;
  setAvatar(pid: string, avatar: Api.Avatar): Promise<Api.ProfileDto>;
  remove(pid: string): Promise<Api.RemovedProfileDto>;
  restore(pid: string): Promise<Api.ProfileDto>;
  syncTutorialState(pid: string): void;        // merge local + remote prefs.tutorial; PATCH when different (best effort)
  last(): PlayerRef;
  setLast(p: PlayerRef): void;
  player(ref: PlayerRef): PlayerInfo;
  guestZoo(): Api.SaveMeta | null;             // meta of wildhaven-save-v1 (parsed once), null if none
  guestAsked(): boolean;
  setGuestAsked(): void;
}
export interface LocalSlot { json: string; meta: Api.SaveMeta | null; savedAt: number }
export interface LocalBackup { id: string; reason: Api.StashReason; fromDevice: string; meta: Api.SaveMeta; savedAt: number; createdAt: number; uploaded: boolean }
export interface LocalStore {
  read(key: SlotKey): LocalSlot | null;
  write(key: SlotKey, json: string, meta: Api.SaveMeta): 'saved' | 'failed';
  has(key: SlotKey): boolean;
  meta(key: SlotKey): Api.SaveMeta | null;
  remove(key: SlotKey): void;
  markUnreadable(key: SlotKey, text: string): boolean;    // false: could not back it up → caller keeps mayWriteSave=false
  adoptGuestInto(accountId: string, profileId: string): 'ok' | 'no-guest' | 'failed';
  backups(profileId: string): LocalBackup[];
  playBackup(profileId: string, backupId: string): 'ok' | 'failed';
  giveTo(from: { profileId: string; backupId: string } | { guest: true }, toProfileId: string): 'ok' | 'not-empty' | 'failed';
  deleteBackup(profileId: string, backupId: string): void;
  housekeeping(now: number): void;
}
export interface SaveCard { deviceName: string; thisDevice: boolean; meta: Api.SaveMeta; savedAt: number; uniquePlaySeconds: number; newest: boolean; playingNow: boolean }
export interface ConflictInfo { profileName: string; here: SaveCard; other: SaveCard }
export interface LeaseLostInfo { profileName: string; here: SaveCard; other: SaveCard; localDeltaSeconds: number; since: number }
export interface TakeoverInfo { profileName: string; holderDevice: string; lastSeenAt: number }
export type NoticeKind = 'moved' | 'profileGone' | 'newerVersion' | 'tooLarge' | 'matchLost';
export interface SyncPrompts {
  confirmTakeover(info: TakeoverInfo): Promise<boolean>;
  chooseConflict(info: ConflictInfo): Promise<'here' | 'other'>;
  chooseLeaseLost(info: LeaseLostInfo): Promise<'here' | 'other'>;
  notice(kind: NoticeKind, info: { profileName: string; deviceName?: string; since?: number }): Promise<void>;
  toast(text: string): void;
}
export type OpenedSlot =
  | { kind: 'ok'; json: string | null; meta: Api.SaveMeta | null; source: 'local' | 'cloud' | 'none' }
  | { kind: 'cancelled' }
  | { kind: 'blocked'; reason: 'newer_version' | 'profile_deleted' };
export type ResumeResult = { kind: 'continue' } | { kind: 'reload'; fromDevice: string } | { kind: 'leaseLost'; info: LeaseLostInfo };
export interface SyncEvents {
  leaseLost: { key: SlotKey; info: LeaseLostInfo };
  conflict: { key: SlotKey; info: ConflictInfo };
  pulledNewer: { key: SlotKey; fromDevice: string };
  profileGone: { profileId: string };
  blocked: { key: SlotKey; reason: 'newer_version' | 'too_large' | 'quota' | 'server_full' };
}
export interface SyncEngine {
  openSlot(key: SlotKey, prompts: SyncPrompts): Promise<OpenedSlot>;
  noteSaved(key: SlotKey): void;
  syncNow(): Promise<void>;
  onHidden(key: SlotKey | null, keepaliveBudgetBytes: number): number;     // synchronous; returns keepalive bytes used
  onVisible(key: SlotKey | null, hiddenMs: number): Promise<ResumeResult>;  // resolves within 2 s
  onLeave(key: SlotKey): Promise<void>;                                     // push + release, resolves within 3 s
  resolveLeaseLost(key: SlotKey, keep: 'here' | 'other'): Promise<'continue' | 'reload'>;
  resolveConflict(key: SlotKey, keep: 'here' | 'other'): Promise<'continue' | 'reload'>;
  slotState(key: SlotKey): SlotUiState;
  on<E extends keyof SyncEvents>(e: E, fn: (p: SyncEvents[E]) => void): () => void;
}
export interface OutboxState { pending: number; lastAck: Api.SnapshotsResponse | null; dead: { code: string; at: number } | null; finishSent: boolean; finishMatch: Api.MatchDto | null }
export type FlushResult = 'sent' | 'empty' | 'offline' | 'backoff' | 'dead' | 'needs-signin';
export interface VersusApi {
  readonly available: boolean;                 // cloud enabled and signed in
  config(): Api.ServerConfig | null;
  create(body: Api.CreateMatchBody): Promise<Api.MatchDto>;          // rejects with FriendlyError
  preview(code: string, profileId: string): Promise<Api.CodePreviewResponse>;
  join(matchId: string, body: Api.JoinMatchBody): Promise<Api.MatchDto>;
  get(matchId: string, profileId: string): Promise<Api.MatchDto>;
  list(profileId: string, state?: 'active' | 'finished' | 'all'): Promise<Api.MatchDto[]>;
  series(matchId: string, profileId: string, since?: number): Promise<Api.SeriesResponse>;
  forfeit(matchId: string, profileId: string): Promise<Api.MatchDto>;
  cancel(matchId: string, profileId: string): Promise<Api.MatchDto>;
  rematch(matchId: string, profileId: string): Promise<Api.MatchDto>;
  enqueueSnapshots(matchId: string, profileId: string, snaps: Api.VersusSnapshot[]): void;   // persisted synchronously
  enqueueFinish(matchId: string, profileId: string, body: Api.FinishBody): void;
  flush(matchId: string): Promise<FlushResult>;
  flushKeepalive(matchId: string, maxBytes: number): number;
  outboxState(matchId: string): OutboxState;
  onAck(fn: (matchId: string, res: Api.SnapshotsResponse | Api.MatchDto) => void): () => void;
}
export type CloudStatus =
  | { kind: 'disabled' } | { kind: 'guest' } | { kind: 'needs-signin' }
  | { kind: 'synced'; at: number } | { kind: 'syncing' }
  | { kind: 'pending'; count: number; offline: boolean; nextTryAt?: number }
  | { kind: 'conflict'; keys: SlotKey[] } | { kind: 'error'; message: string };
export interface CloudHandle {
  readonly enabled: boolean;
  readonly status: Store<CloudStatus>;
  readonly auth: AuthManager;
  readonly profiles: ProfileService;
  readonly local: LocalStore;
  readonly sync: SyncEngine;
  readonly versus: VersusApi;
  init(): Promise<void>;                       // device binding (P5), session restore, housekeeping; no network
}
export interface GoogleSignIn { available(): Promise<boolean>; getIdToken(nonce: string): Promise<{ idToken: string } | null>; signOut(): Promise<void> }
export interface DeviceProvider { info(): Promise<{ name: string; platform: 'android' | 'web'; hwId: string | null }> }
