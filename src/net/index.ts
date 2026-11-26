// src/net — the client platform layer (spec §2, §3, §8.6/§8.7): createCloud() wires LocalStore, auth,
// profiles, the sync engine and the versus outbox. Without an API base the handle is disabled: auth
// state 'disabled', every network method a no-op or a 'disabled' rejection, zero fetch calls, and the
// LocalStore still serves the guest slots exactly as before.
import type { CloudHandle, CloudStatus, DeviceProvider, GoogleSignIn } from '../core/cloud-types';
import type { CloudApi } from './cloudApi';
import { HttpCloudApi } from './cloudApi';
import { API_BASE } from './config';
import { bindDevice, readDeviceRecord } from './device';
import { ApiFailure, type KeepaliveSent } from './http';
import { AuthManagerImpl } from './auth';
import { OutboxManager } from './outbox';
import { ProfileServiceImpl } from './profiles';
import { createStore, deriveStatus, sameJson } from './status';
import { LocalStoreImpl } from './storage';
import { SyncEngineImpl } from './sync';
import { VersusApiImpl } from './versusApi';

export { createDeviceProvider } from './device';
export { createGoogleSignIn } from './google';
export { metaFromSim } from './meta';
export { HttpCloudApi } from './cloudApi';
export type { CloudApi, KeepaliveCall } from './cloudApi';
export { MemoryStorage } from './memoryStorage';
export { ApiFailure, isApiFailure } from './http';

export interface CreateCloudOptions {
  storage: Storage;
  fetch: typeof fetch;
  google: GoogleSignIn;
  device: DeviceProvider;
  appVersion: string;
  /** API origin; default VITE_API_BASE. '' = cloud disabled. */
  apiBase?: string;
  now?: () => number;
  /** Tests: use this CloudApi (e.g. a FakeCloud client) instead of HttpCloudApi over `fetch`. */
  api?: (token: () => string | null) => CloudApi;
  /** Tests: jitter source for backoff. */
  random?: () => number;
  /** Listen to window 'online' (default: when a window exists). */
  listenOnline?: boolean;
}

/** The handle's extra members for main.ts, e2e and tests (all optional to use). */
export interface CloudHandleImpl extends CloudHandle {
  readonly local: LocalStoreImpl;
  readonly auth: AuthManagerImpl;
  readonly profiles: ProfileServiceImpl;
  readonly sync: SyncEngineImpl;
  readonly versus: VersusApiImpl;
  readonly outbox: OutboxManager;
  /** This install's device id and name (after init). */
  device(): { id: string; name: string; platform: 'android' | 'web' };
  /** Stop timers and listeners (tests). */
  dispose(): void;
}

/** A CloudApi that never touches the network (cloud-disabled builds). */
class DisabledCloudApi {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        if (prop === 'keepalive') return (): KeepaliveSent | null => null;
        if (prop === 'serverTimeOffset') return () => 0;
        if (prop === 'then') return undefined;
        if (typeof prop === 'symbol') return Reflect.get(target, prop);
        return () => Promise.reject(new ApiFailure(0, 'disabled', 'Online play is off in this build'));
      },
    });
  }
}

export function createCloud(opts: CreateCloudOptions): CloudHandleImpl {
  const now = opts.now ?? (() => Date.now());
  const base = (opts.apiBase ?? API_BASE).trim().replace(/\/+$/, '');
  const enabled = base !== '' || !!opts.api;
  const storage = opts.storage;
  let dev = { id: readDeviceRecord(storage)?.id ?? '', name: 'Android phone', platform: 'web' as 'android' | 'web' };

  // auth is created after the api (token getter reads it lazily)
  let authRef: AuthManagerImpl | null = null;
  const token = () => authRef?.token() ?? null;
  const api: CloudApi = !enabled
    ? (new DisabledCloudApi() as unknown as CloudApi)
    : opts.api
      ? opts.api(token)
      : new HttpCloudApi({
          base,
          fetch: opts.fetch,
          token,
          appVersion: opts.appVersion,
          get client() {
            return dev.platform;
          },
          now,
        } as ConstructorParameters<typeof HttpCloudApi>[0]);

  const local = new LocalStoreImpl(storage, {
    now,
    trackGuestMeta: enabled,
    currentAccount: () => (enabled ? (authRef?.accountId ?? null) : null),
    deviceName: () => dev.name,
  });

  const status = createStore<CloudStatus>(enabled ? { kind: 'guest' } : { kind: 'disabled' }, sameJson);
  let sync: SyncEngineImpl;
  let profiles: ProfileServiceImpl;
  let outbox: OutboxManager;
  const recompute = () => {
    if (!sync || !authRef) return;
    status.set(deriveStatus({
      enabled,
      auth: authRef.state.get().kind,
      conflictKeys: sync.conflictKeys(),
      error: sync.lastError,
      syncing: sync.isSyncing(),
      pending: sync.pendingCount(),
      offline: sync.isOffline(),
      nextTryAt: sync.nextTryAt(),
      lastSyncAt: sync.lastSyncAt,
    }));
  };

  const session = () => {
    const a = authRef;
    if (!enabled || !a || !a.accountId) return null;
    return { accountId: a.accountId, signedIn: a.signedIn };
  };

  const auth = new AuthManagerImpl({
    enabled,
    storage,
    api,
    google: opts.google,
    local,
    now,
    device: () => dev,
    appVersion: opts.appVersion,
    onSignedIn: () => {
      sync.resetBackoff();
      outbox.resetBackoff();
      void sync.syncDirty();
      void outbox.flushAll();
    },
    finalSync: async (ms) => {
      const deadline = new Promise<void>((r) => setTimeout(r, ms));
      await Promise.race([
        Promise.all([sync.syncNow(), Promise.race([outbox.flushAll(), new Promise((r) => setTimeout(r, 5_000))])]),
        deadline,
      ]);
      return sync.unsynced().length;
    },
    onSignedOut: () => recompute(),
  });
  authRef = auth;

  sync = new SyncEngineImpl({
    api,
    local,
    now,
    device: () => dev,
    session,
    onUnauthorized: () => auth.markNeedsSignin(),
    onProfileGone: (pid) => profiles.markGone(pid),
    isProfileGone: (pid) => profiles.isGone(pid),
    profileName: (pid) => profiles.nameOf(pid),
    onChange: recompute,
    random: opts.random,
  });

  outbox = new OutboxManager({ enabled, local, api, now, session, onUnauthorized: () => auth.markNeedsSignin(), random: opts.random });

  profiles = new ProfileServiceImpl({
    enabled,
    api,
    auth,
    local,
    sync: () => sync,
    now,
    afterRefresh: () => {
      void sync.syncDirty();
      void outbox.flushAll();
    },
    onChange: recompute,
  });

  const versus = new VersusApiImpl({ enabled, api, auth, local, outbox });
  const unsubAuth = auth.state.subscribe(() => recompute());

  // Settings › Sync now also flushes the versus outboxes
  const syncNow = sync.syncNow.bind(sync);
  sync.syncNow = async () => {
    if (!enabled) return;
    outbox.resetBackoff();
    await Promise.all([syncNow(), outbox.flushAll()]);
  };

  let onlineListener: (() => void) | null = null;
  const handle: CloudHandleImpl = {
    enabled,
    status,
    auth,
    profiles,
    local,
    sync,
    versus,
    outbox,
    device: () => dev,
    async init() {
      if (enabled) {
        let info: { name: string; platform: 'android' | 'web'; hwId: string | null } | null = null;
        try {
          info = await Promise.race([
            opts.device.info(),
            new Promise<null>((r) => setTimeout(() => r(null), 1_500)),
          ]);
        } catch {
          info = null;
        }
        if (info) dev = { ...dev, name: info.name || dev.name, platform: info.platform };
        try {
          const bound = await bindDevice(storage, info ? info.hwId : null, now());
          dev = { ...dev, id: bound.device.id };
          if (bound.reset) console.info('[net] this zoo data came from another phone: sign in again');
        } catch (e) {
          console.warn('[net] device binding failed', e);
        }
        auth.load();
        const want = opts.listenOnline ?? typeof globalThis.addEventListener === 'function';
        if (want && !onlineListener && typeof globalThis.addEventListener === 'function') {
          onlineListener = () => {
            sync.onOnline();
            outbox.resetBackoff();
            void outbox.flushAll();
          };
          globalThis.addEventListener('online', onlineListener);
        }
      }
      try {
        local.housekeeping(now());
      } catch (e) {
        console.warn('[net] housekeeping failed', e);
      }
      recompute();
    },
    dispose() {
      sync.dispose();
      unsubAuth();
      if (onlineListener && typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('online', onlineListener);
      onlineListener = null;
    },
  };
  return handle;
}
