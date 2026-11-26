// shared/versus-rules.ts — pure versus rules shared by the sim, the client and the server.
// No DOM, no Node APIs, no dependencies. Files inside shared/ import each other with '.js' suffixes.
import type { MatchResultDto, ResultReason, VersusParts, VersusSnapshot } from './api-types.js';

export const VERSUS_RULES_VERSION = 1;
export const VERSUS_SPEED = 3 as const;            // SimSpeed index → SPEED_MULTIPLIERS[3] = 4×
export const VERSUS_MULTIPLIER = 4;
export const MATCH_HOUR_SIM_S = 20;                // 1 game hour at GAME_MINUTES_PER_SECOND = 3
export const MATCH_DAY_SIM_S = 480;                // 1 zoo day = 120 real s at 4×
export const HOUR_REAL_S = 5;                      // 1 match hour = 5 real s at 4×
export const VERSUS_START_MINUTE = 510;            // 08:30 = NEW_ZOO_START_MINUTE
export const SNAPSHOT_EVERY_HOURS = 6;             // uploaded/stored cadence (30 real s)
export const BUDGET_FACTOR = 1.5;                  // real-time budget = length × 1.5 (review V1)
export const PACE_SLACK_S = 120;
export const CODE_TTL_MS = 48 * 3600_000;
export const FINISH_WINDOW_MS = 72 * 3600_000;     // finishBy = joinedAt + 72 h
export const LIVE_WINDOW_MS = 90_000;
export const OVER_BUDGET_GRACE_MS = 10 * 60_000;
export const LOST_ANIMAL_POINTS = 25;

export interface LengthSpec { lengthMin: number; days: number; startMoney: number; budgetMin: number }
export const LENGTHS: Readonly<Record<30 | 60 | 90 | 120, LengthSpec>> = {
  30: { lengthMin: 30, days: 15, startMoney: 100_000, budgetMin: 45 },
  60: { lengthMin: 60, days: 30, startMoney: 80_000, budgetMin: 90 },
  90: { lengthMin: 90, days: 45, startMoney: 70_000, budgetMin: 135 },
  120: { lengthMin: 120, days: 60, startMoney: 60_000, budgetMin: 180 },
};
export const TEST_LENGTH: LengthSpec = { lengthMin: 4, days: 2, startMoney: 100_000, budgetMin: 6 };

/** null for anything not in LENGTHS (or 4 when allowTest). Returns the shared table entry itself. */
export function lengthSpec(lengthMin: number, allowTest = false): LengthSpec | null {
  switch (lengthMin) {
    case 30: return LENGTHS[30];
    case 60: return LENGTHS[60];
    case 90: return LENGTHS[90];
    case 120: return LENGTHS[120];
    case 4: return allowTest ? TEST_LENGTH : null;
    default: return null;
  }
}

/** What the sim needs to start a match (stored in the versus save block). */
export interface VersusRules {
  matchId: string;
  seed: number;
  lengthMin: number;
  days: number;
  rulesVersion: number;
  startMoney: number;
  startMinute: number;             // VERSUS_START_MINUTE
}

/** Match hours in a match of `days` zoo days: 24 * days. */
export function hoursTotal(days: number): number {
  return 24 * days;
}

/** Real-time budget of one seat in ms: lengthMin * 60_000 * BUDGET_FACTOR. */
export function budgetMs(lengthMin: number): number {
  return lengthMin * 60_000 * BUDGET_FACTOR;
}

/** Unrounded Zoo Points: max(0, v + a + s + b + m − 25·l). */
export function score(p: VersusParts): number {
  return Math.max(0, p.v + p.a + p.s + p.b + p.m - LOST_ANIMAL_POINTS * p.l);
}

/** Math.round(score(p)): the number the HUD shows, snapshots carry as `total` and outcomes compare. */
export function scoreRounded(p: VersusParts): number {
  return Math.round(score(p));
}

// ------------------------------------------------------------------ match codes
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

/** Whitespace of any kind plus ASCII and Unicode hyphens/dashes/minus. */
const CODE_STRIP = /[\s\-‐-―−]/g;

/** Upper-case, strip spaces and dashes. Idempotent. */
export function normalizeCode(input: string): string {
  return String(input).toUpperCase().replace(CODE_STRIP, '');
}

/** After normalizeCode (applied here too, so raw input is fine): 6 chars, all in CODE_ALPHABET. */
export function isValidCode(code: string): boolean {
  const c = normalizeCode(code);
  if (c.length !== CODE_LENGTH) return false;
  for (const ch of c) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * 'K7PM2Q' → 'K7P-M2Q'. The input is normalised first ('k7p m2q' → 'K7P-M2Q');
 * anything up to 3 chars comes back without a dash ('K7' → 'K7', 'K7PM' → 'K7P-M').
 */
export function formatCode(code: string): string {
  const c = normalizeCode(code);
  return c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

/** True when the input contains one of 0 O 1 I L (either case; show the "codes don't use…" hint). */
export function codeHasLookalikes(input: string): boolean {
  return /[01OIL]/i.test(String(input));
}

// ------------------------------------------------------------------ pace
export type PaceVerdict = 'ok' | 'flag' | 'reject';

/**
 * allowed = elapsedMs/1000 + PACE_SLACK_S; need = HOUR_REAL_S * h.
 * need ≤ allowed → 'ok'; family → 'flag'; need > 2·allowed → 'reject'; else 'flag'.
 */
export function checkPace(h: number, elapsedMs: number, family: boolean): PaceVerdict {
  const allowed = elapsedMs / 1000 + PACE_SLACK_S;
  const need = HOUR_REAL_S * h;
  if (need <= allowed) return 'ok';
  if (family) return 'flag';
  if (need > 2 * allowed) return 'reject';
  return 'flag';
}

// ------------------------------------------------------------------ snapshot plausibility
export interface StepCheck { ok: boolean; error?: 'bad_snapshot'; detail?: string; flags: string[] }

/** Per-zoo-day rate caps of checkSnapshotStep (flag only). `t` is the snapshot total. */
export const DAILY_RATE_CAPS: Readonly<{ v: number; a: number; s: number; b: number; m: number; t: number }> = {
  v: 160, a: 60.5, s: 50.5, b: 40, m: 300, t: 500,
};

const PART_KEYS = ['v', 'a', 's', 'b', 'm', 'l'] as const;
const MONOTONIC_KEYS = ['v', 'a', 's', 'b', 'l'] as const;
const CAPPED_KEYS = ['v', 'a', 's', 'b', 'm'] as const;

function reject(detail: string): StepCheck {
  return { ok: false, error: 'bad_snapshot', detail, flags: [] };
}

/**
 * Rejects (ok:false, error 'bad_snapshot') when: h not an integer, h < 1, h > hoursTotal, prev && h ≤ prev.h,
 * any part non-finite or negative, l not an integer, |total − scoreRounded(parts)| > 1,
 * prev && any of v, a, s, b, l decreased. (m may decrease: a loss-making day lowers run.)
 * Flags (ok:true, flags[]) per-day rates over (Δh/24) days, Δ measured from prev (or zero):
 * visitors > 160/day 'cap_v', animals > 60.5 'cap_a', variety > 50.5 'cap_s', babies > 40 'cap_b',
 * money > 300 'cap_m', total > 500/day 'cap_t'.
 *
 * `detail` on a reject is one of: 'h not an integer', 'h < 1', 'h > hoursTotal', 'h not after previous',
 * 'part <k> not finite or negative', 'l not an integer', 'total does not match parts', '<k> decreased'.
 * A non-finite `total` counts as not matching the parts.
 */
export function checkSnapshotStep(prev: VersusSnapshot | null, next: VersusSnapshot, hoursTotal: number): StepCheck {
  const h = next.h;
  if (!Number.isInteger(h)) return reject('h not an integer');
  if (h < 1) return reject('h < 1');
  if (h > hoursTotal) return reject('h > hoursTotal');
  if (prev && h <= prev.h) return reject('h not after previous');

  const parts = next.parts;
  for (const k of PART_KEYS) {
    const x = parts?.[k];
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) return reject(`part ${k} not finite or negative`);
  }
  if (!Number.isInteger(parts.l)) return reject('l not an integer');
  if (typeof next.total !== 'number' || !Number.isFinite(next.total) || Math.abs(next.total - scoreRounded(parts)) > 1) {
    return reject('total does not match parts');
  }
  if (prev) {
    for (const k of MONOTONIC_KEYS) {
      if (parts[k] < prev.parts[k]) return reject(`${k} decreased`);
    }
  }

  // Rates per zoo day over the Δh match hours since prev (or since hour 0 with every part at zero).
  const dh = h - (prev ? prev.h : 0);
  const perDay = (delta: number): number => (delta * 24) / dh;
  const flags: string[] = [];
  for (const k of CAPPED_KEYS) {
    const delta = parts[k] - (prev ? prev.parts[k] : 0);
    if (perDay(delta) > DAILY_RATE_CAPS[k]) flags.push(`cap_${k}`);
  }
  if (perDay(next.total - (prev ? prev.total : 0)) > DAILY_RATE_CAPS.t) flags.push('cap_t');
  return { ok: true, flags };
}

// ------------------------------------------------------------------ outcome
export interface SeatOutcomeInput {
  forfeited: boolean;
  done: boolean;                    // finished (complete or budget) or forfeited
  endHour: number;                  // done ? end_hour : last stored hour (0 if none)
  /** Stored total at exactly hour h, or null when no row exists for h. */
  totalAt(h: number): number | null;
  lastTotal: number;
}
export type MatchResultCore = Omit<MatchResultDto, 'decidedAt'>;

function result(
  kind: MatchResultCore['kind'],
  winnerSeat: 0 | 1 | null,
  reason: ResultReason,
  comparedAtHour: number | null,
  totals: [number, number],
): MatchResultCore {
  return { kind, winnerSeat, reason, comparedAtHour, totals };
}

/**
 * Pure outcome rule. Returns 'pending' until both seats are done or now > finishBy.
 * 1. Forfeit: one seat forfeited → the other wins (reason 'forfeit', totals = lastTotal);
 *    both → kind 'none', reason 'forfeit'.
 * 2. Not both done and (finishBy === null or now ≤ finishBy) → 'pending'.
 *    (After finishBy, a seat that is not done counts as ended at its endHour = last stored hour.)
 * 3. half = hoursTotal / 2. reach_i = endHour_i ≥ half.
 * 4. Both reach: H = min(endHour_0, endHour_1); while H > 0 and (totalAt0(H) or totalAt1(H) is null) H--.
 *    Compare totalAt0(H) vs totalAt1(H): larger wins, equal → tie.
 *    reason = (H === hoursTotal ? 'both_finished' : 'compared_at_hour'), comparedAtHour = H.
 *    (If the step-down reaches H = 0 there is no common stored hour: both totals count as 0 → tie at hour 0.)
 * 5. Exactly one reaches → it wins, reason 'other_unfinished', comparedAtHour null, totals = lastTotal.
 * 6. Neither reaches → kind 'none', reason 'none_finished' (totals = lastTotal).
 * kind 'tie' and kind 'none' have winnerSeat null.
 */
export function decideOutcome(input: {
  hoursTotal: number;
  now: number;
  finishBy: number | null;
  seats: [SeatOutcomeInput, SeatOutcomeInput];
}): MatchResultCore | 'pending' {
  const [s0, s1] = input.seats;
  const last: [number, number] = [s0.lastTotal, s1.lastTotal];

  // 1. Forfeit.
  if (s0.forfeited && s1.forfeited) return result('none', null, 'forfeit', null, last);
  if (s0.forfeited) return result('win', 1, 'forfeit', null, last);
  if (s1.forfeited) return result('win', 0, 'forfeit', null, last);

  // 2. Pending until both are done or the deadline has passed.
  if (!(s0.done && s1.done) && (input.finishBy === null || input.now <= input.finishBy)) return 'pending';

  // 3. Half the match hours counts as "reached".
  const half = input.hoursTotal / 2;
  const reach0 = s0.endHour >= half;
  const reach1 = s1.endHour >= half;

  // 4. Both reached: compare at the largest hour both seats stored, at most the earlier end hour.
  if (reach0 && reach1) {
    let H = Math.floor(Math.min(s0.endHour, s1.endHour));
    while (H > 0 && (s0.totalAt(H) === null || s1.totalAt(H) === null)) H--;
    const t0 = H > 0 ? (s0.totalAt(H) ?? 0) : 0;
    const t1 = H > 0 ? (s1.totalAt(H) ?? 0) : 0;
    const reason: ResultReason = H === input.hoursTotal ? 'both_finished' : 'compared_at_hour';
    if (t0 === t1) return result('tie', null, reason, H, [t0, t1]);
    return result('win', t0 > t1 ? 0 : 1, reason, H, [t0, t1]);
  }

  // 5. Exactly one reached.
  if (reach0 !== reach1) return result('win', reach0 ? 0 : 1, 'other_unfinished', null, last);

  // 6. Neither reached.
  return result('none', null, 'none_finished', null, last);
}
