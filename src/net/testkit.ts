// Test support for the cloud layer (unit tests, the contract test, e2e helpers): a "phone" = a
// createCloud() handle with its own MemoryStorage and device, talking to a shared FakeCloud.
// Not imported by the app (tree-shaken out of the bundle).
import type { SaveMeta } from '../../shared/api-types';
import type { ConflictInfo, GoogleSignIn, LeaseLostInfo, NoticeKind, SyncPrompts, TakeoverInfo } from '../core/cloud-types';
import type { SlotKey } from '../core/contracts';
import type { FakeCloud, FakeCloudClient } from './fakeCloud';
import { createCloud, type CloudHandleImpl } from './index';
import { MemoryStorage } from './memoryStorage';

export interface ScriptedPrompts extends SyncPrompts {
  takeover: boolean;
  conflict: 'here' | 'other';
  leaseLost: 'here' | 'other';
  readonly log: Array<{ kind: string; info: unknown }>;
  readonly toasts: string[];
}

export function scriptedPrompts(answers: Partial<Pick<ScriptedPrompts, 'takeover' | 'conflict' | 'leaseLost'>> = {}): ScriptedPrompts {
  const log: Array<{ kind: string; info: unknown }> = [];
  const toasts: string[] = [];
  const p: ScriptedPrompts = {
    takeover: answers.takeover ?? true,
    conflict: answers.conflict ?? 'here',
    leaseLost: answers.leaseLost ?? 'other',
    log,
    toasts,
    async confirmTakeover(info: TakeoverInfo) {
      log.push({ kind: 'takeover', info });
      return p.takeover;
    },
    async chooseConflict(info: ConflictInfo) {
      log.push({ kind: 'conflict', info });
      return p.conflict;
    },
    async chooseLeaseLost(info: LeaseLostInfo) {
      log.push({ kind: 'leaseLost', info });
      return p.leaseLost;
    },
    async notice(kind: NoticeKind, info: { profileName: string; deviceName?: string; since?: number }) {
      log.push({ kind: `notice:${kind}`, info });
    },
    toast(text: string) {
      toasts.push(text);
      log.push({ kind: 'toast', info: text });
    },
  };
  return p;
}

export interface Phone {
  name: string;
  cloud: CloudHandleImpl;
  storage: MemoryStorage;
  prompts: ScriptedPrompts;
  /** The FakeCloud client of this phone (set .offline to cut its network). */
  client(): FakeCloudClient;
  /** fetch() calls made through the real fetch (always 0 with a FakeCloud). */
  fetchCalls: number;
  /** Skew of this phone's clock (ms); every decision must ignore it (S-12). */
  skewMs: number;
  /** The Google account picker of this phone (swap it to simulate cancel / another account). */
  google: GoogleSignIn;
}

export interface PhoneOptions {
  name: string;
  /** Google sub this phone signs in as (default parent1). */
  sub?: string;
  storage?: MemoryStorage;
  hwId?: string | null;
  skewMs?: number;
  platform?: 'android' | 'web';
}

/** A phone talking to `fake`. Call `await phone.cloud.init()` (or `bootPhone`). */
export function makePhone(fake: FakeCloud, o: PhoneOptions): Phone {
  const storage = o.storage ?? new MemoryStorage();
  let client: FakeCloudClient | null = null;
  const phone: Phone = {
    name: o.name,
    storage,
    prompts: scriptedPrompts(),
    fetchCalls: 0,
    skewMs: o.skewMs ?? 0,
    client: () => client!,
    cloud: null as unknown as CloudHandleImpl,
    google: fake.google(o.sub ?? 'parent1'),
  };
  phone.cloud = createCloud({
    storage,
    fetch: (async () => {
      phone.fetchCalls++;
      throw new Error('no real network in tests');
    }) as unknown as typeof fetch,
    google: {
      available: () => phone.google.available(),
      getIdToken: (nonce) => phone.google.getIdToken(nonce),
      signOut: () => phone.google.signOut(),
    },
    device: { info: async () => ({ name: o.name, platform: o.platform ?? 'android', hwId: o.hwId === undefined ? `hw-${o.name}` : o.hwId }) },
    appVersion: '0.15.0',
    apiBase: 'http://fake.invalid',
    now: () => Date.now() + phone.skewMs,
    api: (token) => (client = fake.api({ token })),
    random: () => 0.5,
    listenOnline: false,
  });
  return phone;
}

/** makePhone + init + sign in. */
export async function bootPhone(fake: FakeCloud, o: PhoneOptions): Promise<Phone> {
  const p = makePhone(fake, o);
  await p.cloud.init();
  const r = await p.cloud.auth.signIn();
  if (r.kind !== 'ok') throw new Error(`sign-in failed: ${JSON.stringify(r)}`);
  return p;
}

/** A small valid save JSON (numeric version first, like sim.serialize()). */
export function zooJson(tag: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, tag, day: 3, minuteOfDay: 600, money: 50000, rating: 40, animals: { k: ['speciesId'], r: [['lion']] }, totalVisitors: 10, ...extra });
}

export function meta(playSeconds: number, day = 3): SaveMeta {
  return { day, minute: 600, money: 50000, rating: 40, animals: 1, species: 1, visitors: 10, playSeconds };
}

export const mainKey = (pid: string) => `${pid}/main` as SlotKey;

/** The tag of a save JSON (tests). */
export function tagOf(json: string | null): string | null {
  if (json === null) return null;
  try {
    return (JSON.parse(json) as { tag?: string }).tag ?? null;
  } catch {
    return null;
  }
}
