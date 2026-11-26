// VersusApi (spec §5.6, §8.6): the versus endpoints (#18–#28) for the controller and the hub, plus the
// per-account+match outbox for snapshots and the finish. Online-only calls reject with FriendlyErr.
import type {
  CodePreviewResponse, CreateMatchBody, FinishBody, JoinMatchBody, MatchDto, SeriesResponse, ServerConfig, SnapshotsResponse,
  VersusSnapshot,
} from '../../shared/api-types';
import type { FlushResult, OutboxState, VersusApi } from '../core/cloud-types';
import type { AuthManagerImpl } from './auth';
import type { CloudApi } from './cloudApi';
import { FriendlyErr, friendly, MSG } from './friendly';
import { asFailure, type FailureCode } from './http';
import type { OutboxManager } from './outbox';
import type { LocalStoreImpl } from './storage';

export const VS_MSG = {
  offline: 'You need the internet for this. Ask a grown-up to connect to Wi-Fi.',
  offlineCreate: 'You need the internet to start a challenge. Ask a grown-up to connect to Wi-Fi.',
  badCode: "That code doesn't work — check the letters",
  ended: 'This challenge has ended',
  own: "That's your own challenge!",
  full: 'Someone already joined this one',
  matchEnded: 'This match has ended.',
  openLimit: 'Finish or cancel your open challenge first.',
  activeLimit: 'You already have 3 matches going. Finish one first.',
  update: 'Update Wildhaven to play Versus.',
  lost: 'This match was lost. Your zoo is kept as practice.',
} as const;

const COMMON: Partial<Record<FailureCode, string>> = {
  network: VS_MSG.offline, timeout: VS_MSG.offline, upgrade_required: VS_MSG.update, open_limit: VS_MSG.openLimit,
  active_limit: VS_MSG.activeLimit, match_state: VS_MSG.matchEnded, match_over: VS_MSG.matchEnded,
};

export interface VersusApiDeps {
  enabled: boolean;
  api: CloudApi;
  auth: AuthManagerImpl;
  local: LocalStoreImpl;
  outbox: OutboxManager;
}

export class VersusApiImpl implements VersusApi {
  private readonly d: VersusApiDeps;

  constructor(deps: VersusApiDeps) {
    this.d = deps;
  }

  get available(): boolean {
    return this.d.enabled && this.d.auth.signedIn;
  }

  config(): ServerConfig | null {
    const acc = this.d.auth.accountId;
    return acc ? (this.d.local.account(acc)?.config ?? null) : null;
  }

  private ready(): void {
    if (!this.d.enabled) throw new FriendlyErr(MSG.disabled, 'disabled');
    if (!this.d.auth.signedIn) throw new FriendlyErr('Sign in to play Versus.', 'unauthorized');
  }

  private async call<T>(fn: () => Promise<T>, msgs: Partial<Record<FailureCode, string>> = {}): Promise<T> {
    this.ready();
    try {
      return await fn();
    } catch (e) {
      const f = asFailure(e);
      if (f.status === 401) this.d.auth.markNeedsSignin();
      if (f.code === 'other_device') {
        const name = (f.details as { deviceName?: string } | undefined)?.deviceName ?? 'another device';
        throw new FriendlyErr(`This match is being played on ${name}.`, 'other_device');
      }
      throw friendly(f, { ...COMMON, ...msgs });
    }
  }

  async create(body: CreateMatchBody): Promise<MatchDto> {
    return (await this.call(() => this.d.api.createMatch(body), { network: VS_MSG.offlineCreate, timeout: VS_MSG.offlineCreate })).match;
  }

  preview(code: string, profileId: string): Promise<CodePreviewResponse> {
    return this.call(() => this.d.api.previewCode(code, profileId), { not_found: VS_MSG.badCode });
  }

  async join(matchId: string, body: JoinMatchBody): Promise<MatchDto> {
    return (await this.call(() => this.d.api.joinMatch(matchId, body), {
      not_found: VS_MSG.badCode, code_expired: VS_MSG.ended, own_match: VS_MSG.own, match_full: VS_MSG.full, match_state: VS_MSG.ended,
    })).match;
  }

  async get(matchId: string, profileId: string): Promise<MatchDto> {
    return (await this.call(() => this.d.api.getMatch(matchId, profileId, { timeoutMs: 4_000 }), { not_found: VS_MSG.lost })).match;
  }

  async list(profileId: string, state?: 'active' | 'finished' | 'all'): Promise<MatchDto[]> {
    return (await this.call(() => this.d.api.listMatches(profileId, state))).matches;
  }

  series(matchId: string, profileId: string, since?: number): Promise<SeriesResponse> {
    return this.call(() => this.d.api.series(matchId, profileId, since));
  }

  async forfeit(matchId: string, profileId: string): Promise<MatchDto> {
    return (await this.call(() => this.d.api.forfeit(matchId, { profileId }))).match;
  }

  async cancel(matchId: string, profileId: string): Promise<MatchDto> {
    return (await this.call(() => this.d.api.cancel(matchId, { profileId }))).match;
  }

  async rematch(matchId: string, profileId: string): Promise<MatchDto> {
    return (await this.call(() => this.d.api.rematch(matchId, { profileId }), { network: VS_MSG.offlineCreate, timeout: VS_MSG.offlineCreate })).match;
  }

  enqueueSnapshots(matchId: string, profileId: string, snaps: VersusSnapshot[]): void {
    this.d.outbox.enqueueSnapshots(matchId, profileId, snaps);
  }

  enqueueFinish(matchId: string, profileId: string, body: FinishBody): void {
    this.d.outbox.enqueueFinish(matchId, profileId, body);
  }

  flush(matchId: string): Promise<FlushResult> {
    return this.d.outbox.flush(matchId);
  }

  flushKeepalive(matchId: string, maxBytes: number): number {
    return this.d.outbox.flushKeepalive(matchId, maxBytes);
  }

  outboxState(matchId: string): OutboxState {
    return this.d.outbox.state(matchId);
  }

  onAck(fn: (matchId: string, res: SnapshotsResponse | MatchDto) => void): () => void {
    return this.d.outbox.onAck(fn);
  }
}
