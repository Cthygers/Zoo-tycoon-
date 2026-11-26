// The player's tutorial state (spec §6.6, §8.5): status never / running / skipped / done and
// the read-aloud choice, kept per player in local storage (core/player-state.ts) and mirrored
// to the server by main.ts. Also the one-time migration from the old five-step tour's
// `wildhaven-tour` key, which is read only (T1, T7). Pure over a key-value store.

import type { TutorialStatus } from '../../../shared/api-types';
import type { PlayerRef } from '../../core/contracts';
import { readTutorialState, writeTutorialState, type KV, type TutorialProfileState } from '../../core/player-state';
import { GUEST, KEYS } from '../../core/storage-keys';
import type { StepId } from './script';

const RANK: Readonly<Record<TutorialStatus, number>> = { never: 0, running: 1, skipped: 2, done: 3 };

function safeGet(kv: KV, key: string): string | null {
  try {
    return kv.getItem(key);
  } catch {
    return null;
  }
}

export function readProfile(kv: KV, player: PlayerRef): TutorialProfileState {
  return readTutorialState(kv, player);
}

/**
 * Move the status on: 'done' always wins; 'skipped' only over never / running; 'running' only
 * over never (a skipped player replaying in a practice zoo stays 'skipped' until they finish).
 */
export function nextStatus(cur: TutorialStatus, want: TutorialStatus): TutorialStatus {
  if (want === 'done') return 'done';
  if (want === 'skipped') return RANK[cur] < RANK.skipped ? 'skipped' : cur;
  if (want === 'running') return cur === 'never' ? 'running' : cur;
  return cur;
}

export function setStatus(kv: KV, player: PlayerRef, want: TutorialStatus, now = Date.now()): TutorialProfileState {
  const st = readTutorialState(kv, player);
  const status = nextStatus(st.status, want);
  const out: TutorialProfileState = { ...st, status, updatedAt: Math.max(st.updatedAt, now) };
  writeTutorialState(kv, player, out);
  return out;
}

export function setReadAloud(kv: KV, player: PlayerRef, on: boolean, now = Date.now()): TutorialProfileState {
  const st = readTutorialState(kv, player);
  const out: TutorialProfileState = { ...st, readAloud: on, updatedAt: Math.max(st.updatedAt + 1, now) };
  writeTutorialState(kv, player, out);
  return out;
}

/** For the versus hub ("Learn the basics first?"). */
export function tutorialDone(kv: KV, player: PlayerRef): boolean {
  return readTutorialState(kv, player).status === 'done';
}

/** Should a New Zoo start the first-run tutorial? */
export function wantsFirstRun(kv: KV, player: PlayerRef): boolean {
  const s = readTutorialState(kv, player).status;
  return s === 'never' || s === 'running';
}

/** Read aloud? null = never chosen (on by default when a voice exists, spec §6.7). */
export function readAloudOn(st: Pick<TutorialProfileState, 'readAloud'>, voice: boolean): boolean {
  return voice && st.readAloud !== false;
}

// --------------------------------------------------------------------------- legacy tour
export interface LegacyZoo {
  day: number;
  animals: number;
}

export interface LegacyOutcome {
  status: TutorialStatus;
  /** Start the tutorial in this zoo in 'migrated' mode with these steps passed (null: do not start). */
  passed: StepId[] | null;
}

const CAMERA_STEPS: StepId[] = ['look-pan', 'look-zoom', 'look-turn'];

/** The mapping of spec §6.6 (pure). */
export function legacyOutcome(legacy: string | null, zoo: LegacyZoo): LegacyOutcome {
  if (legacy === 'done') return { status: 'done', passed: null };
  if (legacy !== null && /^[0-4]$/.test(legacy)) {
    const n = Number(legacy);
    // T7: only a young zoo with no animals yet continues as a migrated tutorial
    if (zoo.day <= 2 && zoo.animals === 0) {
      const passed: StepId[] = [...CAMERA_STEPS];
      if (n > 1) passed.push('paint');
      if (zoo.day > 1) passed.push('play', 'guests');
      return { status: 'running', passed };
    }
    return { status: 'done', passed: null };
  }
  return zoo.animals > 0 ? { status: 'done', passed: null } : { status: 'never', passed: null };
}

/**
 * Does the legacy key apply to this player? Only for the guest before `wildhaven-tutorial`
 * exists, and for the one profile that adopted the guest zoo (legacyFromGuest, T1).
 */
export function legacyApplies(kv: KV, player: PlayerRef): boolean {
  if (player === GUEST) return safeGet(kv, KEYS.guestTutorial) === null;
  return readTutorialState(kv, player).legacyFromGuest === true;
}

/**
 * Run the migration once for this player when their zoo loads without a tutorial blob.
 * Writes the new state (dropping legacyFromGuest so it never runs twice) and returns what to
 * start, or null when it does not apply.
 */
export function migrateLegacyTour(kv: KV, player: PlayerRef, zoo: LegacyZoo, now = Date.now()): LegacyOutcome | null {
  if (!legacyApplies(kv, player)) return null;
  const st = readTutorialState(kv, player);
  const out = legacyOutcome(safeGet(kv, KEYS.legacyTour), zoo);
  const status = RANK[out.status] > RANK[st.status] ? out.status : st.status;
  const next: TutorialProfileState = { v: 1, status, readAloud: st.readAloud, updatedAt: Math.max(st.updatedAt, now) };
  writeTutorialState(kv, player, next);
  return { status, passed: status === 'running' ? out.passed : null };
}
