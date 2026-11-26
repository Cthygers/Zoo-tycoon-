// shared/api-types.ts — HTTP contract shared by the game (src/net) and the server (server/src).
// Types only. No runtime values, no DOM, no Node APIs.

export type Millis = number;

// ------------------------------------------------------------------ errors
export type ApiErrorCode =
  | 'bad_request' | 'invalid' | 'unsupported_media_type'
  | 'unauthorized' | 'token_invalid' | 'nonce_invalid' | 'not_allowed' | 'reauth_mismatch'
  | 'not_found' | 'profile_deleted'
  | 'conflict' | 'leased_elsewhere' | 'lease_lost' | 'in_use'
  | 'profile_limit' | 'name_taken' | 'bad_name'
  | 'own_match' | 'match_full' | 'match_state' | 'match_over' | 'code_expired' | 'other_device'
  | 'open_limit' | 'active_limit' | 'bad_snapshot' | 'too_fast'
  | 'too_large' | 'quota' | 'checksum' | 'bad_save'
  | 'upgrade_required' | 'rate_limited' | 'server_full' | 'internal';

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: Record<string, unknown> };
  serverTime: Millis;
}

// ------------------------------------------------------------------ health / config
export interface HealthResponse {
  ok: boolean;
  db: 'ok' | 'error';
  disk: 'ok' | 'full';
  backup: 'ok' | 'stale' | 'off';
  version: string;
  serverTime: Millis;
}

export type VersusLength = 30 | 60 | 90 | 120 | 4; // 4 = test length (server test mode only)

export interface ServerConfig {
  apiVersion: 1;
  minAppVersion: string | null;
  maxProfiles: number;
  versusLengths: VersusLength[];
  versusRulesVersion: number;
  testLength: boolean;
}
export interface ConfigResponse extends ServerConfig { serverTime: Millis }

// ------------------------------------------------------------------ auth / account
export interface DeviceInfo {
  id: string;                     // random install id (wh2:device), never a hardware id
  name: string;                   // "Pixel 7" (≤ 40 chars)
  platform: 'android' | 'web';
  appVersion: string;
}
export interface NonceResponse { nonce: string; expiresAt: Millis; serverTime: Millis }
export interface GoogleSignInBody { idToken: string; nonce: string; device: DeviceInfo }
export interface SessionDto { token: string; expiresAt: Millis }
export interface AccountDto { id: string; email: string | null; createdAt: Millis }
export interface SignInResponse {
  session: SessionDto;
  account: AccountDto;
  isNew: boolean;
  profiles: ProfileDto[];
  removed: RemovedProfileDto[];
  config: ServerConfig;
  serverTime: Millis;
}
export interface AccountResponse {
  account: AccountDto;
  profiles: ProfileDto[];
  removed: RemovedProfileDto[];
  config: ServerConfig;
  serverTime: Millis;
}
export interface DeleteAccountBody { idToken: string; nonce: string }

// ------------------------------------------------------------------ profiles
export type AvatarAnimal =
  | 'lion' | 'giraffe' | 'elephant' | 'zebra' | 'penguin'
  | 'hippo' | 'tiger' | 'bear' | 'gorilla' | 'flamingo';
export interface Avatar { animal: AvatarAnimal; color: number } // color 0..7

export type TutorialStatus = 'never' | 'running' | 'done' | 'skipped';
export interface TutorialPrefs {
  v: 1;
  status: TutorialStatus;
  readAloud: boolean | null;      // null = not chosen yet (default: on when a voice exists)
  updatedAt: Millis;              // device clock; only used for the readAloud last-writer rule
}
export interface ProfilePrefs { tutorial?: TutorialPrefs }

export interface LeaseInfo { deviceName: string; until: Millis; mine: boolean }
export interface SaveSummary {
  epoch: string;
  rev: number;
  meta: SaveMeta;
  savedAt: Millis;
  deviceName: string;
  lease: LeaseInfo | null;
}
export interface ProfileDto {
  id: string;
  name: string;
  avatar: Avatar;
  prefs: ProfilePrefs;
  createdAt: Millis;
  updatedAt: Millis;
  main: SaveSummary | null;       // null = no cloud zoo yet
}
export interface RemovedProfileDto { id: string; name: string; avatar: Avatar; removedAt: Millis; purgeAt: Millis }
export interface CreateProfileBody { name: string; avatar: Avatar }
export interface PatchProfileBody { name?: string; avatar?: Avatar; prefs?: ProfilePrefs }
export interface ProfileResponse { profile: ProfileDto; serverTime: Millis }
export interface ProfilesResponse { profiles: ProfileDto[]; removed: RemovedProfileDto[]; serverTime: Millis }
export interface RemoveProfileResponse { removed: RemovedProfileDto; serverTime: Millis }

// ------------------------------------------------------------------ saves
/** Shown on cards and used by the divergence rule (playSeconds); never used for ordering. */
export interface SaveMeta {
  day: number;                    // sim.day (1..100000)
  minute: number;                 // floor(sim.minuteOfDay) 0..1439
  money: number;                  // rounded, -1e9..1e10
  rating: number;                 // 0..100 rounded
  animals: number;                // 0..100000
  species: number;                // 0..1000
  visitors: number;               // stats().totalVisitors, 0..1e9
  playSeconds: number;            // real seconds this zoo ran unpaused in the foreground, cumulative, 0..1e9
}
export interface SaveRef { epoch: string; rev: number }
export interface SaveHead extends SaveRef {
  sha256: string;                 // hex of the gzip bytes
  sizeGz: number;
  sizeRaw: number;
  saveVersion: number;            // SimSave.version
  appVersion: string;
  meta: SaveMeta;
  device: { id: string; name: string };   // pusher (same account only)
  savedAt: Millis;                // server time of the push
  clientSavedAt: Millis | null;
  pushId: string;
}
export interface PushedRef extends SaveRef { pushId: string }
export interface GetHeadResponse { head: SaveHead | null; lease: LeaseInfo | null; pushed: PushedRef | null; serverTime: Millis }
export interface SaveDataResponse { head: SaveHead; encoding: 'gzip+base64'; data: string; serverTime: Millis }
export interface PutSaveBody {
  base: SaveRef | null;           // the head this content descends from; null = "there is no cloud save yet"
  pushId: string;                 // uuid v4; reused when re-sending the same pending push
  saveVersion: number;
  meta: SaveMeta;
  clientSavedAt: Millis;
  encoding: 'gzip+base64';
  data: string;
  sha256: string;
  resolution?: 'keep_local';      // pin the head this push replaces for 30 days
}
export interface PutSaveResponse { head: SaveHead; replay: boolean; serverTime: Millis }
/** `error.details` of 412 conflict. */
export interface ConflictDetails { head: SaveHead | null }
export interface LeaseBody { action: 'acquire' | 'renew' | 'release'; takeover?: boolean }
export interface LeaseResponse { lease: LeaseInfo | null; head: SaveHead | null; serverTime: Millis }
/** `error.details` of 409 in_use / lease_lost / leased_elsewhere. */
export interface LeaseConflictDetails { holder: { deviceName: string; lastSeenAt: Millis }; head: SaveHead | null }
export type StashReason = 'lease_lost' | 'chose_other' | 'auto_pull' | 'replaced';
export interface StashBody {
  stashId: string;                // uuid v4 = the local backup id
  reason: StashReason;
  saveVersion: number;
  meta: SaveMeta;
  clientSavedAt: Millis;
  encoding: 'gzip+base64';
  data: string;
  sha256: string;
}
export interface StashResponse { stashId: string; pinnedUntil: Millis; serverTime: Millis }

// ------------------------------------------------------------------ versus
export interface VersusParts {
  v: number;   // happy visitors (1 decimal)
  a: number;   // happy animals
  s: number;   // different animals (variety)
  b: number;   // babies
  m: number;   // money made = max(0, run) / 100
  l: number;   // animals lost (integer COUNT; −25 each)
}
export interface VersusSnapshot {
  h: number;              // match hours completed, 1..24·days
  day: number;            // zoo day at the sample
  min: number;            // minute of day at the sample
  parts: VersusParts;
  total: number;          // Math.round(score(parts))
  run: number;            // cumulative running result $ (integer)
  cash: number;           // money in the bank (integer)
  guests: number;         // guests in the zoo now
  visitors: number;       // visitors since match start
  animals: number;
  species: number;
  habitats: number;
  stars: number;          // sim.rating 0..100 (integer)
}

export type MatchStatus = 'open' | 'active' | 'finished' | 'expired' | 'cancelled';
export type MatchKind = 'coded' | 'family' | 'rematch';
export type SeatState = 'invited' | 'joined' | 'playing' | 'done' | 'left';
export type EndReason = 'complete' | 'budget' | 'deadline' | 'forfeit';
export type ResultReason = 'both_finished' | 'compared_at_hour' | 'other_unfinished' | 'forfeit' | 'none_finished' | 'expired';

export interface SeatDto {
  seat: 0 | 1;
  role: 'challenger' | 'opponent';
  name: string;
  avatar: Avatar;
  isMe: boolean;
  state: SeatState;
  lastHour: number;
  total: number;
  parts: VersusParts | null;
  live: boolean;                      // posted in the last 90 s
  doneAt: Millis | null;
  endHour: number | null;
  endReason: EndReason | null;
  device: { name: string; here: boolean } | null;   // ONLY on the caller's own seat, null elsewhere
}
export interface MatchResultDto {
  kind: 'win' | 'tie' | 'none';
  winnerSeat: 0 | 1 | null;
  reason: ResultReason;
  comparedAtHour: number | null;
  totals: [number, number];           // by seat
  decidedAt: Millis;
}
export interface MatchDto {
  id: string;
  kind: MatchKind;
  code: string | null;                // only to seat 0 while open (coded)
  lengthMin: VersusLength;
  days: number;
  seed: number;
  rulesVersion: number;
  startMoney: number;
  startMinute: number;                // 510
  budgetMin: number;                  // lengthMin × 1.5
  status: MatchStatus;
  createdAt: Millis;
  codeExpiresAt: Millis | null;
  joinedAt: Millis | null;
  finishBy: Millis | null;
  mySeat: 0 | 1;
  players: SeatDto[];                 // index = seat; length 1 while open
  result: MatchResultDto | null;
}
export interface CreateMatchBody {
  profileId: string;
  lengthMin: VersusLength;
  opponentProfileId?: string;         // family match (same account)
  rulesVersion: number;
}
export interface MatchResponse { match: MatchDto; serverTime: Millis }
export interface CodePreviewResponse {
  matchId: string;
  challenger: { name: string; avatar: Avatar };
  lengthMin: VersusLength;
  days: number;
  status: MatchStatus;
  codeExpiresAt: Millis | null;
  serverTime: Millis;
}
export interface JoinMatchBody { profileId: string; code?: string; rulesVersion: number }
export interface MatchListResponse { matches: MatchDto[]; serverTime: Millis }
export interface SnapshotsBody { profileId: string; snapshots: VersusSnapshot[] }
export interface OpponentProgressDto {
  lastHour: number;
  total: number;
  parts: VersusParts | null;
  live: boolean;
  done: boolean;
  atMyHour: number | null;
}
export interface SnapshotsResponse { ackHour: number; opponent: OpponentProgressDto | null; serverTime: Millis }
export type SeriesRow = [h: number, total: number, v: number, a: number, s: number, b: number, m: number, l: number];
export interface SeriesResponse { lastHour: number; done: boolean; series: SeriesRow[]; serverTime: Millis }
export interface FinishBody {
  profileId: string;
  final: VersusSnapshot;
  endReason: 'complete' | 'budget';
  save: { encoding: 'gzip+base64'; data: string; sha256: string };
}
export interface ProfileOnlyBody { profileId: string }
