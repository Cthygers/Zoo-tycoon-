// Pure view models of the versus screens (spec §5.7): every text the chip, the hub, the lobby
// and the results show is decided here, so it can be tested without a DOM.
import type { Avatar, MatchDto, SeatDto, VersusParts } from '../../../shared/api-types';
import { formatCode, scoreRounded } from '../../../shared/versus-rules';
import type { IconName } from '../icons';

const NUM = new Intl.NumberFormat('en-US');
/** 1240 → "1,240". */
export function fmtPoints(n: number): string {
  return NUM.format(Math.round(n));
}

/** Seconds left → "23:41", "1:05:09" (rounded up, so 0:00 shows only at the end). */
export function fmtLeft(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Real minutes → "45 minutes", "1 hour", "1½ hours", "2¼ hours". */
export function fmtMinutes(min: number): string {
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  const frac = rest === 0 ? '' : rest === 15 ? '¼' : rest === 30 ? '½' : rest === 45 ? '¾' : null;
  if (frac === null) return `${h} h ${rest} min`;
  return `${h}${frac} hour${h === 1 && !frac ? '' : 's'}`;
}

/** "30 minutes · 15 zoo days". */
export function lengthLabel(lengthMin: number, days: number): string {
  return `${fmtMinutes(lengthMin)} · ${days} zoo days`;
}

/** "You have 45 minutes to finish". */
export function budgetLabel(budgetMin: number): string {
  return `You have ${fmtMinutes(budgetMin)} to finish`;
}

/** The share-sheet text for a challenge code. */
export function shareText(code: string): string {
  return `Can you build a better zoo than me? Join my Wildhaven Zoo match with code ${formatCode(code)}`;
}

// ------------------------------------------------------------------ in-match chip
export interface ChipModel {
  /** Line 1: time left, or "Last night! 0:38" during day N+1. */
  time: string;
  amber: boolean;
  lastNight: boolean;
  /** Line 2: "1,240 vs 1,180". */
  score: string;
  live: boolean;
  ended: boolean;
}

export function chipModel(o: { timeLeftS: number; ended: boolean; day: number; days: number; me: number; opp: { total: number; atMyHour: number | null; live: boolean } | null }): ChipModel {
  const lastNight = !o.ended && o.day > o.days;
  const t = fmtLeft(o.timeLeftS);
  const them = o.opp ? fmtPoints(o.opp.atMyHour ?? o.opp.total) : '—';
  return {
    time: o.ended ? "Time's up!" : lastNight ? `Last night! ${t}` : t,
    amber: !o.ended && o.timeLeftS <= 60,
    lastNight,
    score: `${fmtPoints(o.me)} vs ${them}`,
    live: !!o.opp?.live && !o.ended,
    ended: o.ended,
  };
}

// ------------------------------------------------------------------ matches list
export type ChipTone = 'turn' | 'wait' | 'live' | 'won' | 'lost' | 'tie' | 'info' | 'warn';
export interface StatusChip {
  text: string;
  tone: ChipTone;
  /** Second line: "Ends in 2 days". */
  sub: string | null;
}

export function seatOf(m: MatchDto, me: boolean): SeatDto | null {
  return m.players.find((p) => (me ? p.seat === m.mySeat : p.seat !== m.mySeat)) ?? null;
}

const done = (s: SeatDto | null) => !!s && (s.state === 'done' || s.doneAt !== null);

/** "Ends in 2 days" / "Ends in 5 hours" / "Ends soon" from finishBy (or the code's expiry). */
export function endsIn(at: number | null, now: number): string | null {
  if (at === null) return null;
  const ms = at - now;
  if (ms <= 0) return null;
  const h = ms / 3600_000;
  if (h >= 36) return `Ends in ${Math.round(h / 24)} days`;
  if (h >= 1.5) return `Ends in ${Math.round(h)} hours`;
  return 'Ends soon';
}

/** The status chip of a match card (spec §5.7). */
export function statusChip(m: MatchDto, now: number, deadOutbox = false): StatusChip {
  const me = seatOf(m, true);
  const them = seatOf(m, false);
  const name = them?.name ?? 'your friend';
  const sub = endsIn(m.finishBy ?? m.codeExpiresAt, now);
  if (deadOutbox) return { text: "We couldn't send this match's score", tone: 'warn', sub: null };
  if (m.status === 'cancelled') return { text: 'Cancelled', tone: 'info', sub: null };
  if (m.status === 'expired') {
    const t = me?.total ?? m.result?.totals[m.mySeat] ?? 0;
    return { text: `Nobody joined — you scored ${fmtPoints(t)}!`, tone: 'info', sub: null };
  }
  if (m.result) {
    const r = m.result;
    if (r.kind === 'tie') return { text: 'Tie!', tone: 'tie', sub: null };
    if (r.kind === 'win') return r.winnerSeat === m.mySeat ? { text: 'You won!', tone: 'won', sub: null } : { text: `${name} won`, tone: 'lost', sub: null };
    return { text: 'No winner this time', tone: 'info', sub: null };
  }
  if (me?.device && !me.device.here && !done(me)) return { text: `This match is being played on ${me.device.name}`, tone: 'info', sub };
  if (!done(me)) return { text: 'Your turn!', tone: 'turn', sub };
  if (!them || them.state === 'invited') return { text: m.kind === 'rematch' ? `Waiting for ${name}…` : 'Waiting for a friend to join', tone: 'wait', sub };
  if (them.live && !done(them)) return { text: `${name} is playing — LIVE`, tone: 'live', sub };
  return { text: `Waiting for ${name}…`, tone: 'wait', sub };
}

/** Whose turn it is in a list (for sorting and the menu dot): my seat still has to play. */
export function myTurn(m: MatchDto): boolean {
  const me = seatOf(m, true);
  return (m.status === 'open' || m.status === 'active') && !done(me);
}

/** "Send your score before Friday 6 pm". */
export function deadlineText(finishBy: number | null, now: number): string | null {
  if (finishBy === null || finishBy <= now) return null;
  const d = new Date(finishBy);
  const day = d.toLocaleDateString('en-US', { weekday: 'long' });
  const h = d.getHours();
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = d.getMinutes();
  const time = `${hh}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return `Send your score before ${sameDay ? 'today' : day} ${time}`;
}

// ------------------------------------------------------------------ breakdown and results
export interface CategoryRow {
  key: keyof VersusParts;
  icon: IconName;
  label: string;
  me: number;
  them: number | null;
  tip: string;
}

const CATS: ReadonlyArray<{ key: keyof VersusParts; icon: IconName; label: string; tip: string }> = [
  { key: 'v', icon: 'guests', label: 'Happy visitors', tip: 'Build kiosks and benches so visitors leave happy' },
  { key: 'a', icon: 'paw', label: 'Happy animals', tip: 'Hire a vet — sick animals earn fewer points' },
  { key: 's', icon: 'layers', label: 'Different animals', tip: 'Try a new kind of animal!' },
  { key: 'b', icon: 'heart', label: 'Babies', tip: 'Happy animals with room have babies' },
  { key: 'm', icon: 'coin', label: 'Money made', tip: 'Tickets and shops earn more than they cost' },
  { key: 'l', icon: 'bad', label: 'Animals lost', tip: 'Feed and water your animals — hire keepers!' },
];

/** The six rows of the breakdown sheet and the results bars (lost counts −25 each). */
export function categoryRows(me: VersusParts, them: VersusParts | null): CategoryRow[] {
  return CATS.map((c) => ({
    key: c.key,
    icon: c.icon,
    label: c.label,
    me: c.key === 'l' ? (me.l ? -25 * me.l : 0) : me[c.key],
    them: them ? (c.key === 'l' ? (them.l ? -25 * them.l : 0) : them[c.key]) : null,
    tip: c.tip,
  }));
}

export interface ResultModel {
  decided: boolean;
  outcome: 'won' | 'lost' | 'tie' | 'none' | 'pending';
  title: string;
  line: string;
  me: { name: string; avatar: Avatar | null; total: number; crown: boolean; confetti: boolean };
  them: { name: string; avatar: Avatar | null; total: number | null; crown: boolean; confetti: boolean } | null;
  close: boolean;
}

/** What the end-of-match overlay says (spec §5.7 End). `mine` is this seat's final score. */
export function resultModel(m: MatchDto | null, mine: { name: string; avatar: Avatar | null; total: number }, o: { offline: boolean; dead: boolean }): ResultModel {
  const them = m ? seatOf(m, false) : null;
  const themName = them?.name ?? 'your friend';
  const r = m?.result ?? null;
  const base = { name: mine.name, avatar: mine.avatar, total: mine.total, crown: false, confetti: false };
  if (!m || !r) {
    const line = o.dead
      ? "We couldn't send this match's score."
      : o.offline
        ? "We'll send your score when you're online."
        : them && them.state !== 'invited'
          ? `Waiting for ${themName}… We'll tell you who won.`
          : "Waiting for a friend to join… We'll tell you who won.";
    return {
      decided: false,
      outcome: 'pending',
      title: `Great job! You scored ${fmtPoints(mine.total)}.`,
      line,
      me: base,
      them: them && them.state !== 'invited' ? { name: themName, avatar: them.avatar, total: null, crown: false, confetti: false } : null,
      close: false,
    };
  }
  const myT = r.totals[m.mySeat] ?? mine.total;
  const theirT = r.totals[m.mySeat === 0 ? 1 : 0] ?? 0;
  const close = Math.max(myT, theirT) > 0 && Math.abs(myT - theirT) <= 0.02 * Math.max(myT, theirT);
  const me = { ...base, total: myT };
  const other = { name: themName, avatar: them?.avatar ?? null, total: theirT, crown: false, confetti: false };
  if (r.kind === 'tie') {
    me.crown = me.confetti = other.crown = other.confetti = true;
    return { decided: true, outcome: 'tie', title: 'Tie!', line: 'You both did great!', me, them: other, close };
  }
  if (r.kind === 'win') {
    const won = r.winnerSeat === m.mySeat;
    (won ? me : other).crown = true;
    (won ? me : other).confetti = true;
    const why = r.reason === 'forfeit' ? (won ? `${themName} gave up.` : 'You gave up this match.') : r.reason === 'other_unfinished' ? (won ? `${themName} didn't finish in time.` : "You didn't finish in time.") : '';
    return { decided: true, outcome: won ? 'won' : 'lost', title: won ? 'You won!' : `${themName} won!`, line: won ? why || 'Your zoo was the best!' : why || 'Great try!', me, them: other, close };
  }
  return { decided: true, outcome: 'none', title: 'No winner this time', line: r.reason === 'expired' ? `Nobody joined — you scored ${fmtPoints(myT)}!` : 'Neither zoo got far enough.', me, them: m.players.length > 1 ? other : null, close: false };
}

/** Biggest difference between the two zoos, in kid words ("Mia's visitors were happier"). */
export function biggestDifference(me: VersusParts, them: VersusParts | null, themName: string): string | null {
  if (!them) return null;
  const rows = categoryRows(me, them).filter((r) => r.them !== null);
  let best: CategoryRow | null = null;
  let gap = 0;
  for (const r of rows) {
    const d = Math.abs(r.me - (r.them ?? 0));
    if (d > gap) {
      gap = d;
      best = r;
    }
  }
  if (!best || gap < 1) return null;
  const mine = best.me > (best.them ?? 0);
  const who = mine ? 'Your' : `${themName}'s`;
  switch (best.key) {
    case 'v':
      return `${who} visitors were happier`;
    case 'a':
      return `${who} animals were happier`;
    case 's':
      return `${who} zoo had more kinds of animals`;
    case 'b':
      return `${who} zoo had more babies`;
    case 'm':
      return `${who} zoo made more money`;
    default:
      return mine ? `${themName} lost more animals` : 'You lost more animals';
  }
}

/** Points-over-time polylines for the results chart (SVG coordinates in a w × h box). */
export function chartPaths(mine: ReadonlyArray<readonly [number, number]>, theirs: ReadonlyArray<readonly [number, number]>, hoursTotal: number, w: number, h: number): { me: string; them: string; max: number } {
  const max = Math.max(1, ...mine.map((p) => p[1]), ...theirs.map((p) => p[1]));
  const path = (pts: ReadonlyArray<readonly [number, number]>) => {
    const all = [[0, 0] as const, ...[...pts].sort((a, b) => a[0] - b[0])];
    return all.map((p, i) => `${i ? 'L' : 'M'}${((p[0] / Math.max(1, hoursTotal)) * w).toFixed(1)} ${(h - (p[1] / max) * h).toFixed(1)}`).join(' ');
  };
  return { me: path(mine), them: theirs.length ? path(theirs) : '', max };
}

/** Total of parts as shown (the server's comparison uses the same rounding). */
export function partsTotal(p: VersusParts): number {
  return scoreRounded(p);
}
