// Per-player state kept in local storage (feature round 14, spec §6.6 / §8.5):
// the tutorial status (mirrored to profile.prefs.tutorial by the net layer) and the
// active slot ('main' or 'practice', or a versus slot for profiles).
// Every storage access swallows exceptions (private mode, quota, blocked storage), like storageGet.
import type { TutorialPrefs, TutorialStatus } from '../../shared/api-types';
import type { PlayerRef, SlotName } from './contracts';
import { GUEST, KEYS } from './storage-keys';

export interface TutorialProfileState extends TutorialPrefs { legacyFromGuest?: true }
export type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const STATUS_RANK: Readonly<Record<TutorialStatus, number>> = { never: 0, running: 1, skipped: 2, done: 3 };

function isStatus(v: unknown): v is TutorialStatus {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(STATUS_RANK, v);
}

function defaultState(): TutorialProfileState {
  return { v: 1, status: 'never', readAloud: null, updatedAt: 0 };
}

/** A clean copy with only the known fields (bad or missing fields fall back to the defaults). */
function clean(raw: unknown): TutorialProfileState {
  const st = defaultState();
  if (!raw || typeof raw !== 'object') return st;
  const r = raw as Record<string, unknown>;
  if (isStatus(r.status)) st.status = r.status;
  if (typeof r.readAloud === 'boolean') st.readAloud = r.readAloud;
  if (typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) && r.updatedAt > 0) st.updatedAt = r.updatedAt;
  if (r.legacyFromGuest === true) st.legacyFromGuest = true;
  return st;
}

function tutorialKey(player: PlayerRef): string {
  return player === GUEST ? KEYS.guestTutorial : KEYS.tutorial(player);
}

function activeKey(player: PlayerRef): string {
  return player === GUEST ? KEYS.guestActive : KEYS.active(player);
}

function safeGet(s: KV, key: string): string | null {
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(s: KV, key: string, value: string): void {
  try {
    s.setItem(key, value);
  } catch {
    /* storage unavailable (private mode / quota) */
  }
}

/** The player's tutorial state; default {v:1, status:'never', readAloud:null, updatedAt:0}. */
export function readTutorialState(s: KV, player: PlayerRef): TutorialProfileState {
  const text = safeGet(s, tutorialKey(player));
  if (text == null) return defaultState();
  try {
    return clean(JSON.parse(text));
  } catch {
    return defaultState();
  }
}

export function writeTutorialState(s: KV, player: PlayerRef, st: TutorialProfileState): void {
  safeSet(s, tutorialKey(player), JSON.stringify(clean(st)));
}

/**
 * Status rank done > skipped > running > never (the higher wins); readAloud from the newer
 * updatedAt (a tie keeps `a`; a not-yet-chosen null never replaces a real choice);
 * updatedAt is the newer of the two; legacyFromGuest kept if either has it.
 */
export function mergeTutorialState(a: TutorialProfileState, b: TutorialPrefs | null | undefined): TutorialProfileState {
  const x = clean(a);
  if (!b) return x;
  const y = clean(b);
  const out: TutorialProfileState = {
    v: 1,
    status: STATUS_RANK[y.status] > STATUS_RANK[x.status] ? y.status : x.status,
    readAloud: x.readAloud,
    updatedAt: Math.max(x.updatedAt, y.updatedAt),
  };
  const newer = y.updatedAt > x.updatedAt ? y : x;
  const older = newer === y ? x : y;
  out.readAloud = newer.readAloud !== null ? newer.readAloud : older.readAloud;
  if (x.legacyFromGuest || y.legacyFromGuest) out.legacyFromGuest = true;
  return out;
}

/** The slot the player last played: 'main' unless 'practice' (or, for a profile, a versus slot) was stored. */
export function readActiveSlot(s: KV, player: PlayerRef): SlotName {
  const v = safeGet(s, activeKey(player));
  if (v === 'main' || v === 'practice') return v;
  if (player !== GUEST && v && v.length > 3 && v.startsWith('vs-') && !v.includes('/')) return v as SlotName;
  return 'main';
}

export function writeActiveSlot(s: KV, player: PlayerRef, slot: SlotName): void {
  safeSet(s, activeKey(player), slot);
}
