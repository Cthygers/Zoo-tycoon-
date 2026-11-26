// ProfileService (spec §3.3): the players of the signed-in account, cached in wh2:index so the picker
// and play work offline. Create / rename / avatar / remove / restore are online-only and reject with
// kid-friendly FriendlyErrors. The tutorial state is mirrored to profile.prefs.tutorial (§6.6).
import type { Avatar, ProfileDto, RemovedProfileDto, SaveMeta, TutorialPrefs } from '../../shared/api-types';
import { checkName } from '../../shared/names';
import type { CachedProfile, ProfileService } from '../core/cloud-types';
import type { PlayerInfo, PlayerRef, SlotKey } from '../core/contracts';
import { mergeTutorialState, readTutorialState, writeTutorialState } from '../core/player-state';
import { GUEST, KEYS } from '../core/storage-keys';
import type { AuthManagerImpl } from './auth';
import type { CloudApi } from './cloudApi';
import { FriendlyErr, friendly, MSG } from './friendly';
import { asFailure } from './http';
import type { LocalStoreImpl } from './storage';
import type { SyncEngineImpl } from './sync';

export const PROFILE_MSG = {
  offlineAdd: 'Connect to the internet to add a player',
  offlineChange: 'Connect to the internet to change players',
  limit: 'You already have 8 players. Remove one to add another.',
  taken: 'Another player already has that name. Pick a different one.',
  removed: 'This player was removed.',
  notFound: "We couldn't find this player.",
} as const;

export interface ProfilesDeps {
  enabled: boolean;
  api: CloudApi;
  auth: AuthManagerImpl;
  local: LocalStoreImpl;
  sync: () => SyncEngineImpl;
  now: () => number;
  /** After a refresh: push dirty slots, stashes, outboxes. */
  afterRefresh?: () => void;
  onChange?: () => void;
}

function sameTutorial(a: TutorialPrefs | undefined, b: TutorialPrefs): boolean {
  return !!a && a.status === b.status && a.readAloud === b.readAloud;
}

export class ProfileServiceImpl implements ProfileService {
  private readonly d: ProfilesDeps;
  private readonly tutorialBusy = new Map<string, boolean>();

  constructor(deps: ProfilesDeps) {
    this.d = deps;
  }

  private acc(): string | null {
    return this.d.enabled ? this.d.auth.accountId : null;
  }

  /** Profiles another device removed (410) that no refresh has brought back. */
  isGone(pid: string): boolean {
    const acc = this.d.local.accountOfProfile(pid);
    return !!acc && (this.d.local.account(acc)?.gone ?? []).includes(pid);
  }

  markGone(pid: string): void {
    const acc = this.d.local.accountOfProfile(pid);
    if (!acc) return;
    this.d.local.updateAccount(acc, (a) => {
      a.gone = [...new Set([...(a.gone ?? []), pid])];
      a.profiles = a.profiles.filter((p) => p.id !== pid);
    });
    this.d.onChange?.();
  }

  private profileDtos(): ProfileDto[] {
    const acc = this.acc();
    if (!acc) return [];
    const a = this.d.local.account(acc);
    if (!a) return [];
    const gone = new Set(a.gone ?? []);
    return a.profiles.filter((p) => !gone.has(p.id));
  }

  list(): CachedProfile[] {
    const sync = this.d.sync();
    return this.profileDtos().map((p) => {
      const key = `${p.id}/main` as SlotKey;
      const s = this.d.local.summary(key);
      return { ...p, local: { hasMain: !!s, meta: s?.meta ?? null, state: sync.slotState(key) } };
    });
  }

  removed(): RemovedProfileDto[] {
    const acc = this.acc();
    if (!acc) return [];
    const now = this.d.now();
    return (this.d.local.account(acc)?.removed ?? []).filter((r) => r.purgeAt > now);
  }

  async refresh(): Promise<boolean> {
    const acc = this.acc();
    if (!acc || !this.d.auth.signedIn) return false;
    let res;
    try {
      res = await this.d.api.profiles();
    } catch (e) {
      if (asFailure(e).status === 401) this.d.auth.markNeedsSignin();
      return false;
    }
    let config = this.d.local.account(acc)?.config ?? null;
    try {
      const c = await this.d.api.config();
      const { serverTime: _st, ...rest } = c;
      config = rest;
    } catch {
      /* keep the cached config */
    }
    if (this.d.auth.accountId !== acc) return false;
    const active = new Set(res.profiles.map((p) => p.id));
    this.d.local.updateAccount(acc, (a) => {
      a.profiles = res.profiles;
      a.removed = res.removed;
      a.config = config;
      a.fetchedAt = this.d.now();
      a.gone = [...new Set([...(a.gone ?? []).filter((pid) => !active.has(pid)), ...res.removed.map((r) => r.id)])];
    });
    for (const p of res.profiles) this.mergeTutorial(p, false);
    this.d.onChange?.();
    try {
      this.d.afterRefresh?.();
    } catch (e) {
      console.warn('[net] after refresh', e);
    }
    return true;
  }

  /** The signed-in account, or a FriendlyErr (cloud disabled / not signed in). */
  private requireAccount(): string {
    if (!this.d.enabled) throw new FriendlyErr(MSG.disabled, 'disabled');
    const acc = this.acc();
    if (!acc || !this.d.auth.signedIn) throw new FriendlyErr(MSG.signin, 'unauthorized');
    return acc;
  }

  private fail(e: unknown, offline: string): never {
    const f = asFailure(e);
    if (f.status === 401) this.d.auth.markNeedsSignin();
    // the server's bad_name message comes from shared/names.ts (already kid words)
    const nameMsg = f.code === 'bad_name' ? (f.message && f.message !== 'bad_name' ? f.message : 'Pick a different name.') : undefined;
    throw friendly(f, {
      network: offline, timeout: offline, profile_limit: PROFILE_MSG.limit, name_taken: PROFILE_MSG.taken,
      profile_deleted: PROFILE_MSG.removed, not_found: PROFILE_MSG.notFound, ...(nameMsg ? { bad_name: nameMsg } : {}),
    });
  }

  private upsertCached(acc: string, p: ProfileDto): void {
    this.d.local.updateAccount(acc, (a) => {
      const i = a.profiles.findIndex((x) => x.id === p.id);
      if (i >= 0) a.profiles[i] = p;
      else a.profiles.push(p);
      a.removed = a.removed.filter((r) => r.id !== p.id);
      a.gone = (a.gone ?? []).filter((x) => x !== p.id);
    });
    this.d.onChange?.();
  }

  async create(name: string, avatar: Avatar): Promise<ProfileDto> {
    const acc = this.requireAccount();
    const check = checkName(name);
    if (!check.ok) throw new FriendlyErr(check.message, 'bad_name');
    try {
      const res = await this.d.api.createProfile({ name: check.name, avatar });
      this.upsertCached(acc, res.profile);
      return res.profile;
    } catch (e) {
      return this.fail(e, PROFILE_MSG.offlineAdd);
    }
  }

  async rename(pid: string, name: string): Promise<ProfileDto> {
    const acc = this.requireAccount();
    const check = checkName(name);
    if (!check.ok) throw new FriendlyErr(check.message, 'bad_name');
    try {
      const res = await this.d.api.patchProfile(pid, { name: check.name });
      this.upsertCached(acc, res.profile);
      return res.profile;
    } catch (e) {
      return this.fail(e, PROFILE_MSG.offlineChange);
    }
  }

  async setAvatar(pid: string, avatar: Avatar): Promise<ProfileDto> {
    const acc = this.requireAccount();
    try {
      const res = await this.d.api.patchProfile(pid, { avatar });
      this.upsertCached(acc, res.profile);
      return res.profile;
    } catch (e) {
      return this.fail(e, PROFILE_MSG.offlineChange);
    }
  }

  async remove(pid: string): Promise<RemovedProfileDto> {
    const acc = this.requireAccount();
    try {
      const res = await this.d.api.removeProfile(pid);
      this.d.local.updateAccount(acc, (a) => {
        a.profiles = a.profiles.filter((p) => p.id !== pid);
        a.removed = [res.removed, ...a.removed.filter((r) => r.id !== pid)];
        a.gone = [...new Set([...(a.gone ?? []), pid])];
      });
      this.d.onChange?.();
      return res.removed;
    } catch (e) {
      return this.fail(e, PROFILE_MSG.offlineChange);
    }
  }

  async restore(pid: string): Promise<ProfileDto> {
    const acc = this.requireAccount();
    try {
      const res = await this.d.api.restoreProfile(pid);
      this.upsertCached(acc, res.profile);
      // its local data reappears and sync resumes
      void this.d.sync().syncDirty();
      return res.profile;
    } catch (e) {
      return this.fail(e, PROFILE_MSG.offlineChange);
    }
  }

  /** Merge the local tutorial state with prefs.tutorial; PATCH when status or readAloud differ. */
  private mergeTutorial(p: ProfileDto, push: boolean): void {
    const local = readTutorialState(this.d.local.storage, p.id);
    const remote = p.prefs?.tutorial;
    const merged = mergeTutorialState(local, remote);
    if (JSON.stringify(merged) !== JSON.stringify(local)) writeTutorialState(this.d.local.storage, p.id, merged);
    const wire: TutorialPrefs = { v: 1, status: merged.status, readAloud: merged.readAloud, updatedAt: merged.updatedAt };
    if ((push || remote) && !sameTutorial(remote, wire) && (merged.status !== 'never' || merged.readAloud !== null)) this.patchTutorial(p.id, wire);
  }

  private patchTutorial(pid: string, wire: TutorialPrefs): void {
    if (!this.d.auth.signedIn) return;
    if (this.tutorialBusy.get(pid)) {
      this.tutorialBusy.set(pid, true); // a run is in flight: it re-checks when done
      return;
    }
    this.tutorialBusy.set(pid, false);
    const acc = this.acc();
    void (async () => {
      try {
        const cached = this.profileDtos().find((x) => x.id === pid);
        // send only known prefs members (never legacyFromGuest: the server's schema is strict)
        const res = await this.d.api.patchProfile(pid, { prefs: { ...(cached?.prefs ?? {}), tutorial: wire } });
        if (acc) this.upsertCached(acc, res.profile);
      } catch (e) {
        if (asFailure(e).status === 401) this.d.auth.markNeedsSignin();
      } finally {
        const again = this.tutorialBusy.get(pid);
        this.tutorialBusy.delete(pid);
        if (again) this.syncTutorialState(pid);
      }
    })();
  }

  syncTutorialState(pid: string): void {
    if (!this.acc()) return;
    const p = this.profileDtos().find((x) => x.id === pid);
    if (!p) return;
    this.mergeTutorial(p, true);
  }

  last(): PlayerRef {
    try {
      const raw = this.d.local.getRaw(KEYS.last);
      if (!raw) return GUEST;
      const v = JSON.parse(raw) as { accountId?: string | null; player?: string };
      const acc = this.acc();
      if (!v || typeof v.player !== 'string' || v.player === GUEST) return GUEST;
      if (!acc || v.accountId !== acc) return GUEST;
      return this.profileDtos().some((p) => p.id === v.player) ? v.player : GUEST;
    } catch {
      return GUEST;
    }
  }

  setLast(p: PlayerRef): void {
    if (!this.d.enabled) return;
    this.d.local.setRaw(KEYS.last, JSON.stringify({ accountId: p === GUEST ? (this.acc() ?? null) : this.acc(), player: p }), { purge: false });
  }

  player(ref: PlayerRef): PlayerInfo {
    if (ref === GUEST) return { ref, profileId: null, accountId: null, name: null, avatar: null };
    const acc = this.d.local.accountOfProfile(ref);
    const a = acc ? this.d.local.account(acc) : null;
    const p = a?.profiles.find((x) => x.id === ref) ?? null;
    const r = p ? null : (a?.removed.find((x) => x.id === ref) ?? null);
    return { ref, profileId: ref, accountId: acc, name: p?.name ?? r?.name ?? null, avatar: p?.avatar ?? r?.avatar ?? null };
  }

  /** Display name for prompts ("Mia"). */
  nameOf(pid: string): string {
    return this.player(pid).name ?? 'This player';
  }

  guestZoo(): SaveMeta | null {
    return this.d.local.guestZooMeta();
  }

  guestAsked(): boolean {
    const acc = this.acc();
    return !!acc && this.d.local.account(acc)?.guestAsked === true;
  }

  setGuestAsked(): void {
    const acc = this.acc();
    if (!acc) return;
    this.d.local.updateAccount(acc, (a) => {
      a.guestAsked = true;
    });
  }
}
