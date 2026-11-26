// AuthManager (spec §3.1): Google sign-in → one opaque whs_ session token in wh2:auth. Any 401 →
// 'needs-signin' (play continues, data stays, nothing is retried until the player signs in again).
// Sign-out and account deletion keep / remove the account's local data as the spec says.
import type { SignInResponse } from '../../shared/api-types';
import type { AuthManager, AuthState, GoogleSignIn, SignInOutcome } from '../core/cloud-types';
import { KEYS } from '../core/storage-keys';
import type { CloudApi } from './cloudApi';
import { NoGoogleAccountError } from './google';
import { asFailure, isOfflineFailure, SMALL_TIMEOUT_MS } from './http';
import { createStore, sameJson, type WritableStore } from './status';
import type { LocalStoreImpl } from './storage';

export interface AuthRecord {
  accountId: string;
  email: string | null;
  token: string;
  expiresAt: number;
  /** A 401 was seen: the token is dead, the account's data stays (needs-signin). */
  stale?: boolean;
}

export const AUTH_MSG = {
  offline: 'Connect to the internet to sign in',
  noGoogle: "Add a Google account in your phone's Settings to sign in",
  server: "Can't reach the Wildhaven server right now. You can keep playing.",
  notAllowed: "This Google account can't use Wildhaven online yet. Ask the grown-up who set it up.",
  unknown: "Sign-in didn't work. Try again.",
  disabled: "Online play isn't switched on in this version of Wildhaven.",
  update: 'Update Wildhaven to sign in.',
} as const;

export interface AuthDeps {
  enabled: boolean;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  api: CloudApi;
  google: GoogleSignIn;
  local: LocalStoreImpl;
  now: () => number;
  device: () => { id: string; name: string; platform: 'android' | 'web' };
  appVersion: string;
  /** After a successful sign-in: push dirty slots, upload stashes, flush outboxes. */
  onSignedIn?: () => void;
  /** Final sync before sign-out (≤ the given ms); resolves with what is still not online. */
  finalSync?: (ms: number) => Promise<number>;
  onSignedOut?: () => void;
}

export function readAuth(s: Pick<Storage, 'getItem'>): AuthRecord | null {
  try {
    const raw = s.getItem(KEYS.auth);
    if (!raw) return null;
    const a = JSON.parse(raw) as Partial<AuthRecord>;
    if (typeof a.accountId !== 'string' || typeof a.token !== 'string' || !a.accountId || !a.token) return null;
    return { accountId: a.accountId, email: typeof a.email === 'string' ? a.email : null, token: a.token, expiresAt: Number(a.expiresAt) || 0, stale: a.stale === true };
  } catch {
    return null;
  }
}

export class AuthManagerImpl implements AuthManager {
  readonly state: WritableStore<AuthState>;
  private readonly d: AuthDeps;
  private rec: AuthRecord | null = null;
  private busy = false;

  constructor(deps: AuthDeps) {
    this.d = deps;
    this.state = createStore<AuthState>(deps.enabled ? { kind: 'guest' } : { kind: 'disabled' }, sameJson);
  }

  /** Restore the session from wh2:auth (cloud.init). No network. */
  load(): void {
    if (!this.d.enabled) return;
    this.rec = readAuth(this.d.storage);
    if (this.rec && this.rec.expiresAt > 0 && this.rec.expiresAt <= this.d.now()) this.rec.stale = true;
    this.publish();
  }

  private publish(): void {
    if (!this.d.enabled) {
      this.state.set({ kind: 'disabled' });
      return;
    }
    const r = this.rec;
    if (!r) this.state.set({ kind: 'guest' });
    else this.state.set(r.stale ? { kind: 'needs-signin', accountId: r.accountId, email: r.email } : { kind: 'signed-in', accountId: r.accountId, email: r.email });
  }

  get accountId(): string | null {
    return this.rec?.accountId ?? null;
  }

  /** The Bearer token while signed in (null when guest or needs-signin). */
  token(): string | null {
    return this.rec && !this.rec.stale ? this.rec.token : null;
  }

  get signedIn(): boolean {
    return !!this.rec && !this.rec.stale;
  }

  /** A 401 anywhere: keep everything, stop sending, ask to sign in again. */
  markNeedsSignin(): void {
    if (!this.rec || this.rec.stale) return;
    this.rec = { ...this.rec, stale: true };
    try {
      this.d.storage.setItem(KEYS.auth, JSON.stringify(this.rec));
    } catch {
      /* in memory is enough for this session */
    }
    this.publish();
  }

  private error(reason: 'offline' | 'no_google' | 'server' | 'not_allowed' | 'unknown', message: string): SignInOutcome {
    this.publish();
    return { kind: 'error', reason, message };
  }

  async signIn(): Promise<SignInOutcome> {
    if (!this.d.enabled) return { kind: 'error', reason: 'unknown', message: AUTH_MSG.disabled };
    if (this.busy) return { kind: 'cancelled' };
    this.busy = true;
    this.state.set({ kind: 'signing-in' });
    try {
      let available = false;
      try {
        available = await this.d.google.available();
      } catch {
        available = false;
      }
      if (!available) return this.error('no_google', AUTH_MSG.noGoogle);
      let nonce: string;
      try {
        nonce = (await this.d.api.nonce()).nonce;
      } catch (e) {
        return this.serverError(e);
      }
      let idToken: string;
      try {
        const t = await this.d.google.getIdToken(nonce);
        if (!t) {
          this.publish();
          return { kind: 'cancelled' };
        }
        idToken = t.idToken;
      } catch (e) {
        if (e instanceof NoGoogleAccountError) return this.error('no_google', AUTH_MSG.noGoogle);
        if (isOfflineFailure(e) || /network|offline|internet/i.test(String((e as Error)?.message ?? ''))) return this.error('offline', AUTH_MSG.offline);
        console.warn('[net] Google sign-in failed', e);
        return this.error('unknown', AUTH_MSG.unknown);
      }
      const dev = this.d.device();
      let res: SignInResponse;
      try {
        res = await this.d.api.signIn({ idToken, nonce, device: { id: dev.id, name: dev.name.slice(0, 40) || 'Phone', platform: dev.platform, appVersion: this.d.appVersion } });
      } catch (e) {
        return this.serverError(e);
      }
      this.rec = { accountId: res.account.id, email: res.account.email, token: res.session.token, expiresAt: res.session.expiresAt };
      try {
        this.d.storage.setItem(KEYS.auth, JSON.stringify(this.rec));
      } catch {
        /* kept in memory; the next start asks again */
      }
      const active = new Set(res.profiles.map((p) => p.id));
      this.d.local.updateAccount(res.account.id, (a) => {
        a.email = res.account.email;
        a.profiles = res.profiles;
        a.removed = res.removed;
        a.config = res.config;
        a.fetchedAt = this.d.now();
        a.gone = (a.gone ?? []).filter((pid) => !active.has(pid));
      });
      this.publish();
      try {
        this.d.onSignedIn?.();
      } catch (e) {
        console.warn('[net] after sign-in', e);
      }
      return { kind: 'ok', isNew: res.isNew };
    } finally {
      this.busy = false;
      if (this.state.get().kind === 'signing-in') this.publish();
    }
  }

  private serverError(e: unknown): SignInOutcome {
    const f = asFailure(e);
    if (isOfflineFailure(f)) return this.error('offline', AUTH_MSG.offline);
    if (f.code === 'not_allowed') return this.error('not_allowed', AUTH_MSG.notAllowed);
    if (f.code === 'upgrade_required') return this.error('unknown', AUTH_MSG.update);
    if (f.status >= 500 || f.status === 429 || f.status === 0) return this.error('server', AUTH_MSG.server);
    return this.error('unknown', AUTH_MSG.unknown);
  }

  async signOut(opts: { force?: boolean } = {}): Promise<'ok' | 'unsynced'> {
    if (!this.d.enabled || !this.rec) {
      this.publish();
      return 'ok';
    }
    if (!opts.force && this.signedIn && this.d.finalSync) {
      const left = await this.d.finalSync(10_000).catch(() => 1);
      if (left > 0) return 'unsynced';
    }
    if (this.signedIn) {
      await Promise.race([this.d.api.signOut().catch(() => undefined), new Promise((r) => setTimeout(r, SMALL_TIMEOUT_MS))]);
    }
    await this.d.google.signOut().catch(() => undefined);
    this.forget();
    return 'ok';
  }

  /** Drop the session locally (the account's slots, outboxes and backups stay, hidden). */
  private forget(): void {
    this.rec = null;
    try {
      this.d.storage.removeItem(KEYS.auth);
      this.d.storage.setItem(KEYS.last, JSON.stringify({ accountId: null, player: 'guest' }));
    } catch {
      /* ignore */
    }
    this.publish();
    try {
      this.d.onSignedOut?.();
    } catch {
      /* ignore */
    }
  }

  async deleteAccount(): Promise<'ok' | 'cancelled' | 'mismatch' | 'offline' | 'error'> {
    if (!this.d.enabled || !this.rec) return 'error';
    const acc = this.rec.accountId;
    let nonce: string;
    try {
      nonce = (await this.d.api.nonce()).nonce;
    } catch (e) {
      return isOfflineFailure(e) ? 'offline' : 'error';
    }
    let idToken: string;
    try {
      const t = await this.d.google.getIdToken(nonce);
      if (!t) return 'cancelled';
      idToken = t.idToken;
    } catch (e) {
      return isOfflineFailure(e) ? 'offline' : 'error';
    }
    try {
      await this.d.api.deleteAccount({ idToken, nonce });
    } catch (e) {
      const f = asFailure(e);
      if (f.code === 'reauth_mismatch') return 'mismatch';
      if (isOfflineFailure(f)) return 'offline';
      if (f.status === 401) this.markNeedsSignin();
      return 'error';
    }
    this.d.local.deleteAccountLocal(acc);
    await this.d.google.signOut().catch(() => undefined);
    this.forget();
    return 'ok';
  }
}
