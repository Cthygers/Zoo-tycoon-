// Small pure text helpers for the account screens: play time, "5 min ago", stars and the zoo
// card lines. No DOM, so the tests can check every wording.
import type { SaveMeta } from '../../../shared/api-types';
import { fmtMoney } from '../../core/format';

/** "1 h 10 min", "25 min", "1 min" (anything under a minute counts as 1 min; 0 → "0 min"). */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  if (s === 0) return '0 min';
  const mins = Math.max(1, Math.round(s / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago" (device clock, display only). */
export function fmtAgo(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000);
  if (!Number.isFinite(s) || s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d <= 1 ? 'yesterday' : `${d} days ago`;
}

/** Zoo rating 0..100 → 0..5 filled stars ("★★★"); at least one star once the zoo has any rating. */
export function starCount(rating: number): number {
  const r = Math.max(0, Math.min(100, Number.isFinite(rating) ? rating : 0));
  if (r <= 0) return 0;
  return Math.max(1, Math.round(r / 20));
}

export function fmtStars(rating: number): string {
  return '★'.repeat(starCount(rating));
}

/** "$48k" / "$950" / "$1.2M": short money for tiles and cards. */
export function fmtMoneyShort(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return fmtMoney(v, { compact: true });
  if (a >= 10_000) return `${v < 0 ? '−' : ''}$${Math.round(a / 1000)}k`;
  return fmtMoney(v);
}

/** Minute of the day → "14:20". */
export function fmtClock(minute: number): string {
  const m = ((Math.floor(minute) % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm}`;
}

/** A wall-clock time ("14:05") for "since 14:05". */
export function fmtWallTime(ts: number): string {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  return fmtClock(d.getHours() * 60 + d.getMinutes());
}

/** Tile line: "Day 15 · ★★★" (no stars yet → "Day 15"); no meta → "No zoo yet". */
export function metaLine(meta: SaveMeta | null | undefined): string {
  if (!meta) return 'No zoo yet';
  const stars = fmtStars(meta.rating);
  return stars ? `Day ${meta.day} · ${stars}` : `Day ${meta.day}`;
}

/** "Day 12 · $48k": the zoo card in "Whose zoo is this?" and the backups list. */
export function zooLine(meta: SaveMeta): string {
  return `Day ${meta.day} · ${fmtMoneyShort(meta.money)}`;
}

/** "18 animals" / "1 animal" / "No animals yet". */
export function animalsText(n: number): string {
  if (!n) return 'No animals yet';
  return `${n} ${n === 1 ? 'animal' : 'animals'}`;
}
