// Local versus records (spec §5.6, §5.7): the per-match record wh2:vs:<pid>/<matchId> (match DTO,
// real-time budget, end state) and the cached matches list wh2:vsidx:<pid> the hub shows offline.
// Every access swallows storage exceptions, like storageGet / storageSet.
import type { MatchDto, VersusParts } from '../../shared/api-types';
import type { KV } from '../core/player-state';
import { KEYS } from '../core/storage-keys';
import { readBudget, type BudgetState } from './budget';

export interface VersusRecord {
  v: 1;
  match: MatchDto;
  budget: BudgetState;
  ended: 'complete' | 'budget' | null;
  finishQueued: boolean;
  /** h = 0 budget end: the forfeit still has to reach the server. */
  forfeitPending?: boolean;
  /** The server lost this match (404): the zoo stays as local practice, nothing is uploaded. */
  lost?: boolean;
  /** My totals at the uploaded hours ([h, total]), for the results chart. */
  mine?: [number, number][];
  /** My parts at the last sample (results bars before the server answers). */
  parts?: VersusParts | null;
  /** The other seat's profile id when it is on this account (family hand-off). */
  familyPid?: string | null;
}

function get(s: KV, key: string): string | null {
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

function set(s: KV, key: string, value: string): boolean {
  try {
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function isMatch(m: unknown): m is MatchDto {
  const x = m as Partial<MatchDto> | null;
  return !!x && typeof x === 'object' && typeof x.id === 'string' && Array.isArray(x.players) && typeof x.days === 'number';
}

export function readRecord(s: KV, pid: string, matchId: string): VersusRecord | null {
  const raw = get(s, KEYS.vs(pid, matchId));
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<VersusRecord>;
    if (!r || r.v !== 1 || !isMatch(r.match)) return null;
    return {
      v: 1,
      match: r.match,
      budget: readBudget(r.budget),
      ended: r.ended === 'complete' || r.ended === 'budget' ? r.ended : null,
      finishQueued: r.finishQueued === true,
      forfeitPending: r.forfeitPending === true,
      lost: r.lost === true,
      mine: Array.isArray(r.mine) ? r.mine.filter((x) => Array.isArray(x) && x.length === 2) : [],
      parts: r.parts ?? null,
      familyPid: typeof r.familyPid === 'string' ? r.familyPid : null,
    };
  } catch {
    return null;
  }
}

export function writeRecord(s: KV, pid: string, rec: VersusRecord): boolean {
  return set(s, KEYS.vs(pid, rec.match.id), JSON.stringify(rec));
}

// ------------------------------------------------------------------ matches list cache
export interface VersusIndex {
  v: 1;
  at: number;
  matches: MatchDto[];
  /** When the player last opened the hub (results decided after it are "new"). */
  seenAt?: number;
}

export function readIndex(s: KV, pid: string): VersusIndex {
  const raw = get(s, KEYS.vsIndex(pid));
  if (raw) {
    try {
      const x = JSON.parse(raw) as Partial<VersusIndex>;
      if (x && x.v === 1 && Array.isArray(x.matches)) return { v: 1, at: Number(x.at) || 0, matches: x.matches.filter(isMatch), seenAt: Number(x.seenAt) || 0 };
    } catch {
      /* rebuilt below */
    }
  }
  return { v: 1, at: 0, matches: [] };
}

/** Replace the cached list (newest first, at most 50). */
export function writeIndex(s: KV, pid: string, matches: MatchDto[], at: number, seenAt?: number): void {
  const list = [...matches].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  const seen = seenAt ?? readIndex(s, pid).seenAt ?? 0;
  set(s, KEYS.vsIndex(pid), JSON.stringify({ v: 1, at, matches: list, seenAt: seen } satisfies VersusIndex));
}

/** The hub was opened now: results decided before this are no longer new. */
export function markIndexSeen(s: KV, pid: string, now: number): void {
  const idx = readIndex(s, pid);
  writeIndex(s, pid, idx.matches, idx.at, now);
}

/**
 * The menu's red dot on Versus (spec §5.7): one of my cached matches waits for my turn, or has a
 * result decided since I last opened the hub. Reads only the local cache (works offline).
 */
export function versusNeedsAttention(s: KV, pid: string): boolean {
  const idx = readIndex(s, pid);
  return idx.matches.some((m) => {
    const me = m.players.find((p) => p.seat === m.mySeat);
    const myTurn = (m.status === 'open' || m.status === 'active') && !!me && me.state !== 'done' && me.doneAt === null;
    return myTurn || (!!m.result && m.result.decidedAt > (idx.seenAt ?? 0));
  });
}

/** Put one match into the cached list (replacing its older copy). */
export function upsertIndex(s: KV, pid: string, m: MatchDto, at: number): void {
  const idx = readIndex(s, pid);
  const rest = idx.matches.filter((x) => x.id !== m.id);
  writeIndex(s, pid, [m, ...rest], at || idx.at);
}
