// SaveMeta (api §4, spec §3.6): the small card data shown on tiles and conflict cards and used by
// the divergence rule (playSeconds). Built straight from the sim (no JSON parse) or, for zoos that
// were saved without one (the legacy guest key), from the save JSON once.
import type { SaveMeta } from '../../shared/api-types';
import type { ISimulation } from '../core/contracts';

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** Bounds the server checks (api §1.2 / validate.ts MetaSchema). */
export function cleanMeta(m: Partial<SaveMeta> | null | undefined): SaveMeta {
  const x = m ?? {};
  return {
    day: Math.round(clamp(Number(x.day ?? 1), 1, 100_000)),
    minute: Math.floor(clamp(Number(x.minute ?? 0), 0, 1439)),
    money: Math.round(clamp(Number(x.money ?? 0), -1e9, 1e10)),
    rating: Math.round(clamp(Number(x.rating ?? 0), 0, 100)),
    animals: Math.round(clamp(Number(x.animals ?? 0), 0, 100_000)),
    species: Math.round(clamp(Number(x.species ?? 0), 0, 1000)),
    visitors: Math.round(clamp(Number(x.visitors ?? 0), 0, 1e9)),
    playSeconds: Math.round(clamp(Number(x.playSeconds ?? 0), 0, 1e9)),
  };
}

/** SaveMeta of the running sim. `playSeconds` is the slot's cumulative unpaused foreground play. */
export function metaFromSim(sim: ISimulation, playSeconds: number): SaveMeta {
  const st = sim.stats();
  return cleanMeta({
    day: sim.day,
    minute: sim.minuteOfDay,
    money: sim.money,
    rating: sim.rating,
    animals: st.animalCount,
    species: st.speciesCount,
    visitors: st.totalVisitors,
    playSeconds,
  });
}

/** Rows of a packed entity list ({k, r}) or a plain array (older saves). */
function rows(p: unknown): { count: number; column(name: string): unknown[] } {
  if (Array.isArray(p)) {
    return { count: p.length, column: (n) => p.map((o) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[n] : undefined)) };
  }
  if (p && typeof p === 'object' && Array.isArray((p as { k?: unknown }).k) && Array.isArray((p as { r?: unknown }).r)) {
    const k = (p as { k: string[] }).k;
    const r = (p as { r: unknown[][] }).r;
    return { count: r.length, column: (n) => { const i = k.indexOf(n); return i < 0 ? [] : r.map((row) => row[i]); } };
  }
  return { count: 0, column: () => [] };
}

/**
 * SaveMeta from a save JSON (one parse). Used for zoos that have no stored meta: the legacy guest zoo.
 * `playSeconds` defaults to an over-estimate (the save's sim seconds): a zoo of unknown play counts as
 * "real play", so the divergence rule asks rather than silently replacing it.
 */
export function metaFromSaveJson(json: string, playSeconds?: number): SaveMeta | null {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object') return null;
  const animals = rows(s.animals);
  const species = new Set(animals.column('speciesId').filter((x) => typeof x === 'string'));
  return cleanMeta({
    day: Number(s.day ?? 1),
    minute: Number(s.minuteOfDay ?? 0),
    money: Number(s.money ?? 0),
    rating: Number(s.rating ?? 0),
    animals: animals.count,
    species: species.size,
    visitors: Number(s.totalVisitors ?? 0),
    playSeconds: playSeconds ?? Number(s.time ?? 0),
  });
}
