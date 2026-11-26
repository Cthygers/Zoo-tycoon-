// Versus match state inside the simulation (spec §5.2, versus.md §2 and §4): Zoo Points
// accumulators, hourly samples aligned to the match start (xx:30 game time), the end of the
// match and its save block. The clock lock itself (4×, never past the end) lives in
// Simulation.update / setSpeed; this class only keeps the score and says when it is over.
//
// Zoo Points (versus.md §4.2), on-view animals only:
//   per match hour  🐾 2.5 × (1 − e^(−C/18)) × w̄
//                   🌍 (50/24) × (1 − e^(−S/3.5)) × (0.5 + 0.5·p̄) × (0.4 + 0.6·w̄)
//   per guest out   😊 0.5 × happiness
//   per birth       🍼 +10 (+20 for the species' first baby of the match), ≤ 40 a zoo day
//   per midnight    💰 max(0, run) / 100   (run = cumulative operating result, $)
//   per loss        😢 −25
//   total = max(0, v + a + s + b + m − 25·l)   (shared/versus-rules.ts `score`)

import type { VersusParts, VersusSnapshot } from '../../shared/api-types';
import {
  LOST_ANIMAL_POINTS,
  MATCH_DAY_SIM_S,
  MATCH_HOUR_SIM_S,
  VERSUS_MULTIPLIER,
  VERSUS_RULES_VERSION,
  hoursTotal,
  scoreRounded,
  type VersusRules,
} from '../../shared/versus-rules';
import { MINUTES_PER_DAY } from '../core/constants';
import type { VersusView } from '../core/contracts';
import type { LedgerEntry } from '../core/types';
import { singularName } from './names';
import type { ExhibitParts } from './progress';
import type { Simulation } from './simulation';
import type { AnimalSim } from './state';

// ------------------------------------------------------------------ point functions
/** Most 🐾 points one match hour can give (≤ 60 a zoo day). */
export const ANIMAL_HOUR_MAX = 2.5;
/** Most 🌍 points one zoo day can give. */
export const VARIETY_DAY_MAX = 50;
export const BABY_POINTS = 10;
export const FIRST_BABY_BONUS = 20;
/** Baby points one zoo day can give (reset at midnight). */
export const BABY_DAY_CAP = 40;

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);

/** 🐾 for one match hour: collection weight `C` of the on-view animals, their mean welfare `w`. */
export function animalHourPoints(C: number, w: number): number {
  if (!(C > 0)) return 0;
  return ANIMAL_HOUR_MAX * (1 - Math.exp(-C / 18)) * clamp01(w);
}

/** 🌍 for one match hour: `S` species on view, their mean appeal ÷ 10 `p`, mean welfare `w`. */
export function varietyHourPoints(S: number, p: number, w: number): number {
  if (!(S > 0)) return 0;
  return (VARIETY_DAY_MAX / 24) * (1 - Math.exp(-S / 3.5)) * (0.5 + 0.5 * clamp01(p)) * (0.4 + 0.6 * clamp01(w));
}

/** 😊 for one guest going home this happy (0..1). */
export function visitorPoints(happiness: number): number {
  return 0.5 * clamp01(happiness);
}

/** 🍼 for one birth: 10, +20 for the species' first baby of the match, within today's 40-point cap. */
export function babyPoints(first: boolean, dayGiven: number): number {
  return Math.max(0, Math.min(BABY_POINTS + (first ? FIRST_BABY_BONUS : 0), BABY_DAY_CAP - Math.max(0, dayGiven)));
}

/** 💰 for a cumulative operating result `run` ($). */
export function moneyPoints(run: number): number {
  return Math.max(0, run) / 100;
}

/** A day's operating result (tickets, shops, donations less wages, food, upkeep): Simulation's runningResult. */
function dayRunning(d: LedgerEntry): number {
  return d.admissions + d.shopIncome + d.donations - (d.salaries + d.food + d.upkeep);
}

/** Parts as shown and uploaded: one decimal (l is a count). */
function round1(p: VersusParts): VersusParts {
  const r = (x: number) => Math.round(x * 10) / 10;
  return { v: r(p.v), a: r(p.a), s: r(p.s), b: r(p.b), m: r(p.m), l: Math.round(p.l) };
}

const zeroParts = (): VersusParts => ({ v: 0, a: 0, s: 0, b: 0, m: 0, l: 0 });

/** Animals that count for points: not loose, in a habitat guests can see. */
export function onView(sim: Simulation): (a: AnimalSim) => boolean {
  const habs = sim.world.habitats;
  return (a) => {
    if (a.escaped || !a.habitatId) return false;
    const h = habs.get(a.habitatId);
    return !!h && h.viewTiles.length > 0;
  };
}

/** A sample time within this of an hour boundary counts as on it (sub-steps sum 0.1 s pieces). */
const HOUR_EPS = 1e-6;

/** The versus block of a save. */
export interface VersusSave {
  v: 1;
  rules: VersusRules;
  /** Match hours completed. */
  hour: number;
  /** Unrounded accumulators (m follows run). */
  raw: VersusParts;
  /** Cumulative operating result since the match started ($). */
  run: number;
  /** Baby points given since the last midnight. */
  babyDay: number;
  /** Species that had a baby in this match. */
  bred: string[];
  /** total() at the last midnight (todayPoints). */
  dayStart: number;
  ended: boolean;
  endReason: 'complete' | 'budget' | null;
  /** The snapshot of the last completed hour and the accumulators then (what a budget end freezes at). */
  last: VersusSnapshot | null;
  lastRaw: { raw: VersusParts; run: number } | null;
}

export class VersusMatch implements VersusView {
  readonly rules: VersusRules;
  hour = 0;
  ended = false;
  endReason: 'complete' | 'budget' | null = null;
  private raw: VersusParts = zeroParts();
  private run = 0;
  private babyDay = 0;
  private readonly bred = new Set<string>();
  private dayStart = 0;
  private last: VersusSnapshot | null = null;
  private lastRaw: { raw: VersusParts; run: number } | null = null;

  constructor(
    rules: VersusRules,
    private readonly sim: Simulation,
  ) {
    this.rules = { ...rules };
  }

  get hoursTotal(): number {
    return hoursTotal(this.rules.days);
  }

  /** sim.time at the end of the match (day N+1 08:30): N × 480 sim-s. */
  get endTime(): number {
    return this.rules.days * MATCH_DAY_SIM_S;
  }

  // ------------------------------------------------------------------ VersusView
  parts(): VersusParts {
    return round1({ ...this.raw, m: Math.max(0, this.run) / 100 });
  }

  total(): number {
    return scoreRounded(this.parts());
  }

  /** The unrounded accumulators (m from the running result): for tests and the exact oracle. */
  rawParts(): VersusParts {
    return { ...this.raw, m: Math.max(0, this.run) / 100 };
  }

  todayPoints(): number {
    return this.total() - this.dayStart;
  }

  gameSecondsLeft(): number {
    return this.ended ? 0 : Math.max(0, this.endTime - this.sim.time);
  }

  realSecondsLeft(): number {
    return this.gameSecondsLeft() / VERSUS_MULTIPLIER;
  }

  lastSnapshot(): VersusSnapshot | null {
    return this.last ? cloneSnapshot(this.last) : null;
  }

  /**
   * The seat's real-time budget ran out: freeze at the last completed match hour (the points
   * earned since are dropped, so the score equals lastSnapshot()), stop the clock, emit versusEnded.
   */
  endNow(reason: 'budget'): void {
    if (this.ended) return;
    if (this.lastRaw) {
      this.raw = { ...this.lastRaw.raw };
      this.run = this.lastRaw.run;
    } else {
      this.raw = zeroParts();
      this.run = 0;
    }
    this.end(reason);
  }

  // ------------------------------------------------------------------ sim hooks
  /** After every sim step: take the hourly samples that are due. */
  tick(sim: Simulation = this.sim): void {
    if (this.ended) return;
    while (this.hour < this.hoursTotal && sim.time + HOUR_EPS >= (this.hour + 1) * MATCH_HOUR_SIM_S) {
      this.sampleHour(sim.progress.exhibitParts(onView(sim)));
    }
  }

  /** One completed match hour with these on-view exhibit terms: 🐾 and 🌍 points, a snapshot, versusHour. */
  sampleHour(ex: Pick<ExhibitParts, 'held' | 'welfare' | 'species' | 'appeal'>): VersusSnapshot {
    this.raw.a += animalHourPoints(ex.held, ex.welfare);
    this.raw.s += varietyHourPoints(ex.species, ex.appeal, ex.welfare);
    this.hour++;
    const snap = this.snapshot();
    this.last = snap;
    this.lastRaw = { raw: { ...this.raw }, run: this.run };
    this.sim.events.emit('versusHour', { hour: this.hour, snapshot: cloneSnapshot(snap) });
    return snap;
  }

  /** A guest went home this happy. */
  onDeparture(happiness: number): void {
    if (this.ended) return;
    this.raw.v += visitorPoints(happiness);
  }

  /** A baby was born: +10 (+20 for the species' first of the match), within the day cap. */
  onBirth(speciesId: string): void {
    if (this.ended) return;
    const first = !this.bred.has(speciesId);
    this.bred.add(speciesId);
    const pts = babyPoints(first, this.babyDay);
    if (pts <= 0) return;
    this.raw.b += pts;
    this.babyDay += pts;
    this.sim.events.emit('versusPoints', { part: 'babies', delta: pts, total: this.total(), text: `Baby ${singularName(speciesId)}!` });
  }

  /** An animal died of anything but old age, or was taken to a sanctuary: −25. `text` says who. */
  onLost(text?: string): void {
    if (this.ended) return;
    this.raw.l += 1;
    this.sim.events.emit('versusPoints', { part: 'lost', delta: -LOST_ANIMAL_POINTS, total: this.total(), text: text ?? 'An animal was lost — hire keepers!' });
  }

  /** Midnight: the closed day's operating result counts towards 💰; "Day 7: +142 points". */
  onDayClosed(entry: LedgerEntry): void {
    if (this.ended) return;
    const before = Math.max(0, this.run) / 100;
    this.run += dayRunning(entry);
    this.babyDay = 0;
    const after = Math.max(0, this.run) / 100;
    const total = this.total();
    const day = total - this.dayStart;
    this.dayStart = total;
    const text = `Day ${entry.day}: ${day >= 0 ? '+' : '−'}${Math.abs(day).toLocaleString('en-US')} points`;
    this.sim.events.emit('versusPoints', { part: 'money', delta: Math.round((after - before) * 10) / 10, total, text });
  }

  /** The clock reached the end of the match (Simulation.finishVersus): last samples, then versusEnded. */
  finish(): void {
    if (this.ended) return;
    this.tick(this.sim);
    this.end('complete');
  }

  private end(reason: 'complete' | 'budget'): void {
    this.ended = true;
    this.endReason = reason;
    this.sim.speed = 0;
    this.sim.events.emit('versusEnded', { reason, hour: this.hour, total: this.total(), parts: this.parts() });
  }

  private snapshot(): VersusSnapshot {
    const sim = this.sim;
    const parts = this.parts();
    // the sample instant in game minutes since day 1 00:00 (exact, whatever the float clock says)
    const abs = this.rules.startMinute + this.hour * 60;
    const species = new Set<string>();
    for (const a of sim.animals.values()) species.add(a.speciesId);
    return {
      h: this.hour,
      day: 1 + Math.floor(abs / MINUTES_PER_DAY),
      min: abs % MINUTES_PER_DAY,
      parts,
      total: scoreRounded(parts),
      run: Math.round(this.run),
      cash: Math.round(sim.money),
      guests: sim.guests.size,
      visitors: sim.totalVisitors,
      animals: sim.animals.size,
      species: species.size,
      habitats: sim.world.habitats.size,
      stars: Math.round(sim.rating),
    };
  }

  // ------------------------------------------------------------------ persistence
  serialize(): VersusSave {
    return {
      v: 1,
      rules: { ...this.rules },
      hour: this.hour,
      raw: { ...this.raw },
      run: this.run,
      babyDay: this.babyDay,
      bred: Array.from(this.bred),
      dayStart: this.dayStart,
      ended: this.ended,
      endReason: this.endReason,
      last: this.last ? cloneSnapshot(this.last) : null,
      lastRaw: this.lastRaw ? { raw: { ...this.lastRaw.raw }, run: this.lastRaw.run } : null,
    };
  }

  /** Rebuild from a save block; throws on a block this version cannot play (newer rules, corrupt). */
  static load(data: unknown, sim: Simulation): VersusMatch {
    const d = data as Partial<VersusSave> | null;
    const rules = d?.rules;
    if (!d || typeof d !== 'object' || !rules || typeof rules !== 'object') throw new Error('Corrupt save: bad versus block');
    if (!(Number(rules.rulesVersion) <= VERSUS_RULES_VERSION)) throw new Error('This match needs a newer version of Wildhaven Zoo.');
    if (!(Number.isInteger(rules.days) && rules.days > 0) || typeof rules.matchId !== 'string') throw new Error('Corrupt save: bad versus rules');
    const m = new VersusMatch(rules, sim);
    const num = (x: unknown, dflt = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : dflt);
    m.hour = Math.max(0, Math.min(m.hoursTotal, Math.floor(num(d.hour))));
    m.raw = parts(d.raw);
    m.run = num(d.run);
    m.babyDay = num(d.babyDay);
    for (const s of Array.isArray(d.bred) ? d.bred : []) if (typeof s === 'string') m.bred.add(s);
    m.dayStart = num(d.dayStart);
    m.ended = d.ended === true;
    m.endReason = m.ended ? (d.endReason === 'budget' ? 'budget' : 'complete') : null;
    m.last = d.last && typeof d.last === 'object' ? cloneSnapshot(d.last) : null;
    m.lastRaw = d.lastRaw && typeof d.lastRaw === 'object' ? { raw: parts(d.lastRaw.raw), run: num(d.lastRaw.run) } : null;
    return m;
  }
}

function parts(x: unknown): VersusParts {
  const p = (x ?? {}) as Partial<VersusParts>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { v: n(p.v), a: n(p.a), s: n(p.s), b: n(p.b), m: n(p.m), l: n(p.l) };
}

function cloneSnapshot(s: VersusSnapshot): VersusSnapshot {
  return { ...s, parts: { ...s.parts } };
}
