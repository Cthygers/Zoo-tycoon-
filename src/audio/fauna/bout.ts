// Pure helpers of the fauna module: the bout planner (a species' bout grammar
// → timed syllables), per-individual voices, variant choice and contagion.
// No host or Web Audio here, so everything is unit-testable.

import { mulberry32, type Rng } from '../../core/rng';
import type { Bout, SpeciesAudio } from '../recipes/speciesAudio';

/** One syllable of a planned bout: onset (s from the bout start), level (dB re the bout) and playbackRate factor. */
export interface BoutItem {
  t: number;
  syl: string;
  db: number;
  rate: number;
}

const DEFAULT_GAP: readonly [number, number] = [0.1, 0.3];

/**
 * Turn a bout grammar into timed syllables. Steps run in order; a step's first
 * onset follows the previous step's last syllable (onset + its duration + gap).
 * Inter-onset intervals grow by `grow` up to `ioiMax`; every interval after the
 * first gets ±10 % jitter that does not compound, so long grunt series stay
 * monotonic within the jitter.
 */
export function planBout(sp: SpeciesAudio, bout: Bout, rng: Rng, dur: (syl: string) => number): BoutItem[] {
  const out: BoutItem[] = [];
  for (const st of bout.steps) {
    if (st.p !== undefined && rng.float() >= st.p) continue;
    if (!sp.syllables[st.syl]) continue;
    const n = rng.int(st.n[0], st.n[1]);
    const prev = out[out.length - 1];
    const gap = st.gap ?? DEFAULT_GAP;
    let t = prev ? prev.t + dur(prev.syl) / prev.rate + rng.range(gap[0], gap[1]) : 0;
    let base = rng.range(st.ioi[0], st.ioi[1]);
    for (let i = 0; i < n; i++) {
      if (i === 1) t += base;
      else if (i > 1) {
        base = Math.min(st.ioiMax ?? Infinity, base * (st.grow ?? 1));
        t += base * rng.range(0.9, 1.1);
      }
      const db = (st.db ?? 0) + i * (st.dbStep ?? 0) - (st.peak !== undefined ? 1.5 * Math.abs(i - st.peak) : 0);
      out.push({ t, syl: st.syl, db, rate: Math.pow(st.rateStep ?? 1, i) });
    }
  }
  return out;
}

/** Span of a planned bout, s (last onset + that syllable's duration). */
export function boutSpan(items: readonly BoutItem[], dur: (syl: string) => number): number {
  const last = items[items.length - 1];
  return last ? last.t + dur(last.syl) / last.rate : 0;
}

/** Weighted choice (Bout.w, default 1) among a species' bouts that pass `ok`. */
export function pickWhere(sp: SpeciesAudio, rng: Rng, ok: (b: Bout) => boolean): Bout | null {
  let total = 0;
  for (const b of sp.bouts) if (ok(b)) total += b.w ?? 1;
  if (total <= 0) return null;
  let r = rng.float() * total;
  let last: Bout | null = null;
  for (const b of sp.bouts) {
    if (!ok(b)) continue;
    last = b;
    r -= b.w ?? 1;
    if (r < 0) return b;
  }
  return last;
}

/** Weighted choice among a species' bouts of one kind, respecting Bout.sex. */
export function pickBout(sp: SpeciesAudio, kind: Bout['kind'], sex: 'M' | 'F', rng: Rng): Bout | null {
  return pickWhere(sp, rng, (b) => b.kind === kind && (!b.sex || b.sex === sex));
}

export function hasBout(sp: SpeciesAudio, kind: Bout['kind']): boolean {
  return sp.bouts.some((b) => b.kind === kind);
}

/** What makes one animal sound like itself: fixed for its life (derived from its seed). */
export interface Individual {
  /** playbackRate factor (sex included, juvenile excluded: growth changes). */
  pitch: number;
  /** Formant colour of the PlaySpec. */
  color: { hz: number; db: number };
  /** Level offset, dB (lionesses are quieter). */
  db: number;
}

export function individual(sp: SpeciesAudio, seed: number, sex: 'M' | 'F'): Individual {
  const r = mulberry32(seed ^ 0x5a17c0de);
  const u = (a: number, b: number) => a + (b - a) * r();
  let pitch = 1 + u(-sp.pitchSpread, sp.pitchSpread);
  const color = { hz: sp.formant.hz * u(0.92, 1.08), db: u(-sp.formant.db, sp.formant.db) };
  let db = 0;
  if (sex === 'F') {
    pitch *= 1.04;
    if (sp.voice === 'lion') db -= 3;
  }
  return { pitch, color, db };
}

/** Juveniles sound younger without the old tape speed-up: at most +12 % pitch. */
export const JUVENILE_MAX_RATE = 1.12;
export const JUVENILE_GROWTH = 0.95;
export const JUVENILE_DB = -4;

export function juvenilePitch(growth: number): number {
  return growth < JUVENILE_GROWTH ? Math.min(JUVENILE_MAX_RATE, 1 + 0.2 * (1 - growth)) : 1;
}

/**
 * Variant choice for banks of pre-rendered ids `${base}#k`: uniform among the
 * rendered candidates, never the one this bank played last (when there is a
 * choice). `count` 0 means a single id without a suffix.
 */
export class VariantPicker {
  private readonly last = new Map<string, number>();
  private readonly idCache = new Map<string, readonly string[]>();
  /** Banks whose variants were all rendered at the last check. */
  private readonly complete = new Set<string>();

  /** The ids of a bank (cached: no string building per play). */
  ids(base: string, count: number): readonly string[] {
    let ids = this.idCache.get(base);
    if (!ids || ids.length !== Math.max(1, count)) {
      ids = count <= 0 ? [base] : Array.from({ length: count }, (_, k) => `${base}#${k}`);
      this.idCache.set(base, ids);
    }
    return ids;
  }

  /**
   * A rendered variant, uniformly among the best candidates. `avoid` (optional)
   * grades variants to pass over: 2 = never if possible (the animal's own last
   * one), 1 = rather not (a recent identical play); the bank's last variant comes
   * after those as a tie-breaker.
   */
  pick(base: string, count: number, has: (id: string) => boolean, rng: Rng, avoid?: (id: string) => number): string | null {
    const ids = this.ids(base, count);
    const prev = this.last.get(base) ?? -1;
    let best = Infinity;
    let n = 0;
    for (let k = 0; k < ids.length; k++) {
      if (!has(ids[k])) continue;
      const score = this.score(ids[k], k === prev, avoid);
      if (score < best) {
        best = score;
        n = 1;
      } else if (score === best) n++;
    }
    if (!n) {
      this.complete.delete(base);
      return null;
    }
    let r = rng.int(0, n - 1);
    for (let k = 0; k < ids.length; k++) {
      if (!has(ids[k]) || this.score(ids[k], k === prev, avoid) !== best) continue;
      if (r-- === 0) {
        this.last.set(base, k);
        return ids[k];
      }
    }
    return null;
  }

  private score(id: string, isLast: boolean, avoid?: (id: string) => number): number {
    return (avoid?.(id) ?? 0) * 2 + (isLast ? 1 : 0);
  }

  /** First variant of a bank that is not rendered yet (variants render lazily, after first use). */
  missing(base: string, count: number, has: (id: string) => boolean): string | null {
    if (this.complete.has(base)) return null;
    for (const id of this.ids(base, count)) if (!has(id)) return id;
    this.complete.add(base);
    return null;
  }
}

/** Contagion never pulls in more than this many joiners: one roar does not set off the whole pride. */
export const MAX_JOINERS = 2;

/** Conspecifics that join a bout: each eligible one (in random order) with probability p, after U(delay) s, at most `max`. */
export function planJoins(contagion: NonNullable<SpeciesAudio['contagion']>, eligible: readonly number[], rng: Rng, max = MAX_JOINERS): { id: number; delay: number }[] {
  const out: { id: number; delay: number }[] = [];
  const n = eligible.length;
  const start = n ? rng.int(0, n - 1) : 0;
  for (let i = 0; i < n && out.length < max; i++)
    if (rng.float() < contagion.p) out.push({ id: eligible[(start + i) % n], delay: rng.range(contagion.delay[0], contagion.delay[1]) });
  return out;
}
