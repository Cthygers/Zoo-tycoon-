// Pure helpers of the fauna module for when animals call: daily activity,
// which bout a scheduled caller makes (night roars, the giraffe's nocturnal
// hum), idle weighting by distance and time of day, how far spontaneous bouts
// reach in a close view, zoo-wide rate trims and the colony murmur level.

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

/** Idlers of a species asleep by its daily rhythm still murmur a little (×0.15). */
export const IDLE_ACTIVITY_FLOOR = 0.15;
/** Peak hourly activity per species (cached). */
const peaks = new WeakMap<SpeciesAudio, number>();

/**
 * Idle-lottery weight for the time of day: the species' activity relative to its
 * own peak hour, at least IDLE_ACTIVITY_FLOOR (a diurnal gorilla barely grunts at
 * night; lions and hippos idle more after dark).
 */
export function idleActivity(sp: SpeciesAudio, hour: number): number {
  let peak = peaks.get(sp);
  if (peak === undefined) peaks.set(sp, (peak = Math.max(...sp.activity)));
  return peak > 0 ? Math.max(IDLE_ACTIVITY_FLOOR, activityAt(sp, hour) / peak) : IDLE_ACTIVITY_FLOOR;
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

/** Lions roar in full only from this activity on (dusk and night); by day a call is moans and a few grunts. */
export const ROAR_ACTIVITY = 0.6;
const softCalls = new WeakMap<Bout, Bout>();

/** A lion's daytime call: its call grammar without the inhale and the roars, and a short grunt series. */
export function daytimeCall(sp: SpeciesAudio, bout: Bout): Bout {
  if (sp.voice !== 'lion' || bout.kind !== 'call') return bout;
  let soft = softCalls.get(bout);
  if (!soft) {
    const steps = bout.steps.filter((s) => s.syl !== 'roar' && s.syl !== 'inhale').map((s) => (s.syl === 'grunt' ? { ...s, n: [3, 6] as const } : s));
    soft = { ...bout, steps };
    softCalls.set(bout, soft);
  }
  return soft;
}

/** Whether a bout is a lion's full roaring call. */
export function isRoar(sp: SpeciesAudio, bout: Bout): boolean {
  return sp.voice === 'lion' && bout.kind === 'call' && bout.steps.some((s) => s.syl === 'roar');
}

/**
 * Zoo-wide presence of the big, quiet species of the savanna and the forest:
 * in mid and far views (camera over PRESENCE_CAM m from its focus), at least
 * `perMin` scheduled bouts per minute per group in range, whatever the hour;
 * and ×`idle` chattiness. They are heard around the zoo now and then, while
 * close views stay about the animals in them.
 */
export const ZOO_RATE: Readonly<Record<string, { perMin: number; idle: number }>> = {
  elephant: { perMin: 1, idle: 1.75 },
  giraffe: { perMin: 4, idle: 3 },
  rhino: { perMin: 4, idle: 2 },
  tiger: { perMin: 1.5, idle: 2 },
};
/** Presence applies with the camera further than this from its focus, m (closer views are about the animals in them). */
const PRESENCE_CAM = 20;

/** Scheduled bouts per second of one species group in range at this hour, its closest member `dist` m from the ear. */
export function schedRate(sp: SpeciesAudio, hour: number, dist: number, camDist: number): number {
  const reach = reachFactor(dist, camDist, sp.refDist);
  const presence = camDist > PRESENCE_CAM ? (ZOO_RATE[sp.voice]?.perMin ?? 0) * reach : 0;
  return Math.max(sp.boutsPerMin * activityAt(sp, hour) * reach * reach, presence) / 60;
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
 * How likely a far animal is to start a spontaneous bout: the closer the camera,
 * the more a view is about the animals in it rather than the whole zoo's
 * chatter. Reach is 1.5 × the camera distance (10–60 m), scaled by the species'
 * reference distance (a lion's roar carries 2.5× further than a honk). Idle and
 * scheduler rates use its square.
 */
export function reachFactor(dist: number, camDist: number, refDist: number): number {
  const reach = Math.min(60, Math.max(10, 1.5 * camDist)) * (refDist / 10);
  const q = dist / reach;
  return 1 / (1 + q * q);
}

/** Idle vocalisations per second for candidates with this summed chattiness (× reach and activity). */
export function idleRate(sumChatty: number): number {
  return Math.min(0.6, 0.05 * sumChatty);
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
