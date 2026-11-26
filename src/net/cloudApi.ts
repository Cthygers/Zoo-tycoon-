// CloudApi: one typed method per endpoint of api.md §2 (#2–#28), plus fire-and-forget keepalive
// calls for page hide. HttpCloudApi talks to the real server; FakeCloud (fakeCloud.ts) is the
// in-memory model the client tests use; the integrator's contract test runs one scenario list
// against both. Every method rejects with ApiFailure (http.ts).
// No @capacitor/* imports and no DOM access at import time: the server's contract test imports this.
import type {
  AccountResponse, CodePreviewResponse, ConfigResponse, CreateMatchBody, CreateProfileBody, DeleteAccountBody, FinishBody,
  GetHeadResponse, GoogleSignInBody, JoinMatchBody, LeaseBody, LeaseResponse, MatchListResponse, MatchResponse, NonceResponse,
  PatchProfileBody, ProfileOnlyBody, ProfileResponse, ProfilesResponse, PutSaveBody, PutSaveResponse, RemoveProfileResponse,
  SaveDataResponse, SeriesResponse, SignInResponse, SnapshotsBody, SnapshotsResponse, StashBody, StashResponse,
} from '../../shared/api-types';
import { HttpClient, LARGE_TIMEOUT_MS, SMALL_TIMEOUT_MS, type KeepaliveSent } from './http';

/** A request sent with keepalive on page hide (spec §7.5). */
export type KeepaliveCall =
  | { kind: 'putSave'; pid: string; body: PutSaveBody }
  | { kind: 'lease'; pid: string; body: LeaseBody }
  | { kind: 'snapshots'; matchId: string; body: SnapshotsBody }
  | { kind: 'finish'; matchId: string; body: FinishBody };

export type { KeepaliveSent };

export interface CallOptions {
  /** Override the default timeout (ms). */
  timeoutMs?: number;
}

export interface CloudApi {
  // config, auth, account
  config(): Promise<ConfigResponse>;
  nonce(): Promise<NonceResponse>;
  signIn(body: GoogleSignInBody): Promise<SignInResponse>;
  signOut(): Promise<void>;
  account(): Promise<AccountResponse>;
  deleteAccount(body: DeleteAccountBody): Promise<void>;
  // profiles
  profiles(): Promise<ProfilesResponse>;
  createProfile(body: CreateProfileBody): Promise<ProfileResponse>;
  patchProfile(pid: string, body: PatchProfileBody): Promise<ProfileResponse>;
  removeProfile(pid: string): Promise<RemoveProfileResponse>;
  restoreProfile(pid: string): Promise<ProfileResponse>;
  // saves (slot main)
  getHead(pid: string, pushIds?: readonly string[], opts?: CallOptions): Promise<GetHeadResponse>;
  getData(pid: string, opts?: CallOptions): Promise<SaveDataResponse>;
  putSave(pid: string, body: PutSaveBody, opts?: CallOptions): Promise<PutSaveResponse>;
  lease(pid: string, body: LeaseBody, opts?: CallOptions): Promise<LeaseResponse>;
  stash(pid: string, body: StashBody, opts?: CallOptions): Promise<StashResponse>;
  // versus
  createMatch(body: CreateMatchBody): Promise<MatchResponse>;
  previewCode(code: string, profileId: string): Promise<CodePreviewResponse>;
  joinMatch(matchId: string, body: JoinMatchBody): Promise<MatchResponse>;
  listMatches(profileId: string, state?: 'active' | 'finished' | 'all'): Promise<MatchListResponse>;
  getMatch(matchId: string, profileId: string, opts?: CallOptions): Promise<MatchResponse>;
  postSnapshots(matchId: string, body: SnapshotsBody, opts?: CallOptions): Promise<SnapshotsResponse>;
  series(matchId: string, profileId: string, since?: number): Promise<SeriesResponse>;
  finish(matchId: string, body: FinishBody, opts?: CallOptions): Promise<MatchResponse>;
  forfeit(matchId: string, body: ProfileOnlyBody): Promise<MatchResponse>;
  cancel(matchId: string, body: ProfileOnlyBody): Promise<MatchResponse>;
  rematch(matchId: string, body: ProfileOnlyBody): Promise<MatchResponse>;
  /**
   * Fire-and-forget keepalive request (page hide). fetch() starts synchronously; when the JSON body is
   * larger than maxBytes nothing is sent and null is returned.
   */
  keepalive(call: KeepaliveCall, maxBytes: number): KeepaliveSent | null;
  /** Server clock − device clock (ms), display only. */
  serverTimeOffset(): number;
}

export interface HttpCloudApiOptions {
  base: string;
  fetch: typeof fetch;
  token: () => string | null;
  appVersion: string;
  client: 'android' | 'web';
  now?: () => number;
}

const enc = encodeURIComponent;
const P = (pid: string) => `/v1/profiles/${enc(pid)}`;
const SAVE = (pid: string) => `${P(pid)}/saves/main`;
const M = (id: string) => `/v1/versus/matches/${enc(id)}`;

/** The real server over fetch. */
export class HttpCloudApi implements CloudApi {
  private readonly http: HttpClient;

  constructor(opts: HttpCloudApiOptions) {
    this.http = new HttpClient(opts);
  }

  serverTimeOffset(): number {
    return this.http.serverTimeOffset;
  }

  config(): Promise<ConfigResponse> {
    return this.http.request('GET', '/v1/config', { auth: false });
  }
  nonce(): Promise<NonceResponse> {
    return this.http.request('POST', '/v1/auth/nonce', { auth: false, body: {} });
  }
  signIn(body: GoogleSignInBody): Promise<SignInResponse> {
    return this.http.request('POST', '/v1/auth/google', { auth: false, body });
  }
  async signOut(): Promise<void> {
    await this.http.request<void>('POST', '/v1/auth/signout', { body: {} });
  }
  account(): Promise<AccountResponse> {
    return this.http.request('GET', '/v1/account');
  }
  async deleteAccount(body: DeleteAccountBody): Promise<void> {
    await this.http.request<void>('DELETE', '/v1/account', { body, timeoutMs: LARGE_TIMEOUT_MS });
  }

  profiles(): Promise<ProfilesResponse> {
    return this.http.request('GET', '/v1/profiles');
  }
  createProfile(body: CreateProfileBody): Promise<ProfileResponse> {
    return this.http.request('POST', '/v1/profiles', { body });
  }
  patchProfile(pid: string, body: PatchProfileBody): Promise<ProfileResponse> {
    return this.http.request('PATCH', P(pid), { body });
  }
  removeProfile(pid: string): Promise<RemoveProfileResponse> {
    return this.http.request('DELETE', P(pid));
  }
  restoreProfile(pid: string): Promise<ProfileResponse> {
    return this.http.request('POST', `${P(pid)}/restore`, { body: {} });
  }

  getHead(pid: string, pushIds: readonly string[] = [], opts: CallOptions = {}): Promise<GetHeadResponse> {
    return this.http.request('GET', SAVE(pid), {
      query: { pushIds: pushIds.length ? pushIds.slice(0, 4).join(',') : undefined },
      timeoutMs: opts.timeoutMs ?? SMALL_TIMEOUT_MS,
    });
  }
  getData(pid: string, opts: CallOptions = {}): Promise<SaveDataResponse> {
    return this.http.request('GET', `${SAVE(pid)}/data`, { timeoutMs: opts.timeoutMs ?? LARGE_TIMEOUT_MS });
  }
  putSave(pid: string, body: PutSaveBody, opts: CallOptions = {}): Promise<PutSaveResponse> {
    return this.http.request('PUT', SAVE(pid), { body, timeoutMs: opts.timeoutMs ?? LARGE_TIMEOUT_MS });
  }
  lease(pid: string, body: LeaseBody, opts: CallOptions = {}): Promise<LeaseResponse> {
    return this.http.request('POST', `${SAVE(pid)}/lease`, { body, timeoutMs: opts.timeoutMs ?? SMALL_TIMEOUT_MS });
  }
  stash(pid: string, body: StashBody, opts: CallOptions = {}): Promise<StashResponse> {
    return this.http.request('POST', `${SAVE(pid)}/stash`, { body, timeoutMs: opts.timeoutMs ?? LARGE_TIMEOUT_MS });
  }

  createMatch(body: CreateMatchBody): Promise<MatchResponse> {
    return this.http.request('POST', '/v1/versus/matches', { body });
  }
  previewCode(code: string, profileId: string): Promise<CodePreviewResponse> {
    return this.http.request('GET', `/v1/versus/codes/${enc(code)}`, { query: { profileId } });
  }
  joinMatch(matchId: string, body: JoinMatchBody): Promise<MatchResponse> {
    return this.http.request('POST', `${M(matchId)}/join`, { body });
  }
  listMatches(profileId: string, state?: 'active' | 'finished' | 'all'): Promise<MatchListResponse> {
    return this.http.request('GET', '/v1/versus/matches', { query: { profileId, state } });
  }
  getMatch(matchId: string, profileId: string, opts: CallOptions = {}): Promise<MatchResponse> {
    return this.http.request('GET', M(matchId), { query: { profileId }, timeoutMs: opts.timeoutMs ?? SMALL_TIMEOUT_MS });
  }
  postSnapshots(matchId: string, body: SnapshotsBody, opts: CallOptions = {}): Promise<SnapshotsResponse> {
    return this.http.request('POST', `${M(matchId)}/snapshots`, { body, timeoutMs: opts.timeoutMs ?? SMALL_TIMEOUT_MS });
  }
  series(matchId: string, profileId: string, since?: number): Promise<SeriesResponse> {
    return this.http.request('GET', `${M(matchId)}/series`, { query: { profileId, since } });
  }
  finish(matchId: string, body: FinishBody, opts: CallOptions = {}): Promise<MatchResponse> {
    return this.http.request('POST', `${M(matchId)}/finish`, { body, timeoutMs: opts.timeoutMs ?? LARGE_TIMEOUT_MS });
  }
  forfeit(matchId: string, body: ProfileOnlyBody): Promise<MatchResponse> {
    return this.http.request('POST', `${M(matchId)}/forfeit`, { body });
  }
  cancel(matchId: string, body: ProfileOnlyBody): Promise<MatchResponse> {
    return this.http.request('POST', `${M(matchId)}/cancel`, { body });
  }
  rematch(matchId: string, body: ProfileOnlyBody): Promise<MatchResponse> {
    return this.http.request('POST', `${M(matchId)}/rematch`, { body });
  }

  keepalive(call: KeepaliveCall, maxBytes: number): KeepaliveSent | null {
    switch (call.kind) {
      case 'putSave':
        return this.http.keepalive('PUT', SAVE(call.pid), call.body, maxBytes);
      case 'lease':
        return this.http.keepalive('POST', `${SAVE(call.pid)}/lease`, call.body, maxBytes);
      case 'snapshots':
        return this.http.keepalive('POST', `${M(call.matchId)}/snapshots`, call.body, maxBytes);
      case 'finish':
        return this.http.keepalive('POST', `${M(call.matchId)}/finish`, call.body, maxBytes);
    }
  }
}
