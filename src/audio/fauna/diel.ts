// Pure helpers of the fauna module for when animals call: daily activity,
// which bout a scheduled caller makes (night roars, the giraffe's nocturnal
// hum), idle weighting by distance, how far spontaneous bouts reach in a close
// view, and the colony murmur level.

import type { Rng } from '../../core/rng';
import type { Bout, SpeciesAudio } from '../recipes/speciesAudio';
import { pickBout, pickWhere } from './bout';

/** Scheduled-bout multiplier at a fractional hour: linear between the 24 hourly values. */
export function activityAt(sp: SpeciesAudio, hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  const f = h - i;
  return sp.activity[i] * (1 - f) + sp.activity[(i + 1) % 24] * f;
}

/** Giraffes hum only lying down, at night, and never between these hours. */
const HUM_DAY: readonly [number, number] = [6, 19];
const SCHEDULED: readonly Bout['kind'][] = ['call', 'contact', 'display'];

export interface Member {
  action: string;
  sex: 'M' | 'F';
}

/**
 * The bout a scheduled caller makes: its species' 'night' bout when it is night
 * (giraffes only while lying down, never by day), otherwise one of its call /
 * contact / display bouts weighted by Bout.w. Null when the species has none.
 */
export function pickKind(sp: SpeciesAudio, nightness: number, member: Member, rng: Rng, hour = 0): Bout | null {
  if (nightness > 0.5 && canNight(sp, member, hour)) {
    const b = pickBout(sp, 'night', member.sex, rng);
    if (b) return b;
  }
  return pickWhere(sp, rng, (b) => SCHEDULED.includes(b.kind) && (!b.sex || b.sex === member.sex));
}

function canNight(sp: SpeciesAudio, m: Member, hour: number): boolean {
  if (sp.voice !== 'giraffe') return true;
  const h = ((hour % 24) + 24) % 24;
  return (m.action === 'sleep' || m.action === 'sit') && (h < HUM_DAY[0] || h >= HUM_DAY[1]);
}

/** Idle-lottery weight: chatty animals near the ear win; `boost` for the followed / selected / close-up animal. */
export function idleWeight(chatty: number, dist: number, boost = 1): number {
  const q = dist / 12;
  return (chatty / (1 + q * q)) * boost;
}

/** Weighted random choice (null when every weight is 0). */
export function pickWeighted<T>(items: readonly T[], weight: (x: T) => number, rng: Rng): T | null {
  let total = 0;
  for (const x of items) total += weight(x);
  if (total <= 0) return null;
  let r = rng.float() * total;
  for (const x of items) {
    r -= weight(x);
    if (r < 0) return x;
  }
  return items[items.length - 1];
}

/**
 * How likely a far animal is to start an idle or scheduled bout: the closer the
 * camera, the more a view is about the animals in it rather than the whole
 * zoo's chatter. Reach is 2.5 × the camera distance (15–60 m), scaled by the
 * species' reference distance (a lion's roar carries 2.5× further than a honk).
 */
export function reachFactor(dist: number, camDist: number, refDist: number): number {
  const reach = Math.min(60, Math.max(15, 2.5 * camDist)) * (refDist / 10);
  const q = dist / reach;
  return 1 / (1 + q * q);
}

/** Idle vocalisations per second for candidates with this summed chattiness (× reachFactor). */
export function idleRate(sumChatty: number): number {
  return Math.min(0.6, 0.03 * sumChatty);
}

/**
 * Colony murmur level (linear, before the loop's own normalisation): grows with
 * the square root of the colony size (capped at 30), follows daily activity,
 * drops to `colony.night` at night and with distance.
 */
export function colonyLevel(sp: SpeciesAudio, n: number, hour: number, nightness: number, attGain: number): number {
  if (!sp.colony || n <= 0) return 0;
  return Math.sqrt(Math.min(n, 30) / 12) * activityAt(sp, hour) * (nightness > 0.5 ? sp.colony.night : 1) * Math.pow(10, (sp.levels.idle ?? 0) / 20) * attGain;
}
