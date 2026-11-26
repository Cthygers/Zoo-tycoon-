// Species audio table (speciesAudio.ts) against the recipe registry: every
// species has a complete, consistent voice; syllable banks stay within the
// render and memory budgets.
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { planBout } from '../src/audio/fauna/bout';
import { RATE_SPREAD } from '../src/audio/fauna/variety';
import { RECIPES, SPECIES_AUDIO, registerRecipes, seedFor, sylId, voiceIdFor } from '../src/audio/recipes';
import { ANIMAL_RECIPES, SYLLABLES } from '../src/audio/recipes/animals';
import { BED_RECIPES } from '../src/audio/recipes/beds';
import { COLONY_RECIPES } from '../src/audio/recipes/colony';
import { CUE_RECIPES } from '../src/audio/recipes/cues';
import type { Recipe } from '../src/audio/render';
import { SPECIES } from '../src/data/species';

/** Nominal decoded size of a recipe, bytes (mono float32). */
function bytes(r: Recipe): number {
  return (r.dur + (r.tail ?? 0)) * (r.rate ?? 22050) * 4;
}
function sylBytes(voices: readonly string[], firstOnly: boolean): number {
  let b = 0;
  for (const [id, r] of Object.entries(RECIPES)) {
    const m = /^syl\.([a-z]+)\.[a-z]+#(\d+)$/.exec(id);
    if (m && voices.includes(m[1]) && (!firstOnly || m[2] === '0')) b += bytes(r);
  }
  return b;
}
const MB = 1e6;
/** Species of the demo zoo the round's memory targets are measured on. */
const DEMO_ZOO = ['elephant', 'rhino', 'penguin', 'tiger', 'flamingo', 'gorilla', 'giraffe', 'zebra', 'gazelle', 'lion'];

describe('SPECIES_AUDIO', () => {
  it('covers every species of the game', () => {
    for (const s of SPECIES) {
      const v = voiceIdFor(s.id, s.diet);
      expect(SPECIES_AUDIO[v], s.id).toBeDefined();
      expect(SPECIES_AUDIO[v].voice).toBe(v);
    }
  });

  it('only uses registered syllables, with every variant rendered from a recipe', () => {
    for (const [voice, sp] of Object.entries(SPECIES_AUDIO)) {
      for (const b of sp.bouts) {
        expect(b.steps.length, `${voice} ${b.kind}`).toBeGreaterThan(0);
        expect(sp.levels[b.kind], `${voice} ${b.kind} level`).toBeDefined();
        for (const st of b.steps) {
          expect(sp.syllables[st.syl], `${voice} ${st.syl}`).toBeDefined();
          expect(st.n[0]).toBeLessThanOrEqual(st.n[1]);
          expect(st.ioi[0]).toBeLessThanOrEqual(st.ioi[1]);
          if (st.gap) expect(st.gap[0]).toBeLessThanOrEqual(st.gap[1]);
        }
      }
      for (const [syl, bank] of Object.entries(sp.syllables)) {
        expect(bank.variants).toBeGreaterThanOrEqual(1);
        expect(bank.dur).toBeGreaterThan(0);
        for (let k = 0; k < bank.variants; k++) expect(RECIPES[sylId(voice, syl, k)], sylId(voice, syl, k)).toBeDefined();
        expect(RECIPES[sylId(voice, syl, bank.variants)]).toBeUndefined();
      }
    }
  });

  it('has sane levels, activity, contagion and colony data', () => {
    for (const [voice, sp] of Object.entries(SPECIES_AUDIO)) {
      expect(sp.activity, voice).toHaveLength(24);
      for (const a of sp.activity) expect(a >= 0 && a <= 1, voice).toBe(true);
      for (const db of Object.values(sp.levels)) expect(db >= -20 && db <= 0, voice).toBe(true);
      if (sp.contagion) {
        expect(sp.contagion.delay[0]).toBeLessThanOrEqual(sp.contagion.delay[1]);
        expect(sp.contagion.p).toBeGreaterThan(0);
      }
      if (sp.colony) expect(RECIPES[sp.colony.loopId], sp.colony.loopId).toBeDefined();
      expect(sp.refDist).toBeLessThan(sp.radius);
    }
  });

  it('gives every species idle sounds and several kinds, and the young their own calls', () => {
    for (const [voice, sp] of Object.entries(SPECIES_AUDIO)) {
      const kinds = new Set(sp.bouts.map((b) => b.kind));
      expect(kinds.has('idle'), voice).toBe(true);
      expect(kinds.size, voice).toBeGreaterThanOrEqual(3);
      if (sp.syllables.juv) expect(kinds.has('juvenile'), voice).toBe(true);
    }
    for (const voice of ['lion', 'elephant', 'zebra', 'penguin', 'hippo']) expect(SPECIES_AUDIO[voice].syllables.juv?.variants).toBe(3);
  });

  it('gives the most-played syllable types six variants', () => {
    for (const [voice, syl] of [
      ['gorilla', 'piggrunt'],
      ['penguin', 'contact'],
      ['elephant', 'snort'],
      ['lion', 'moan'],
      ['lion', 'roar'],
    ])
      expect(SPECIES_AUDIO[voice].syllables[syl].variants, `${voice}.${syl}`).toBeGreaterThanOrEqual(6);
  });

  it('never lets one animal overlap its own zebra bray cycles or penguin display pairs', () => {
    for (const [voice, syl] of [
      ['zebra', 'cycle'],
      ['penguin', 'pair'],
    ]) {
      const sp = SPECIES_AUDIO[voice];
      const bout = sp.bouts.find((b) => b.kind === 'call')!;
      // longest variant at the slowest playback: the deepest individual and the lowest per-play rate
      const longest = SYLLABLES[voice][syl].d[1];
      const slowest = (1 - sp.pitchSpread) * (1 - Math.max(RATE_SPREAD, sp.rateJitter));
      for (let seed = 1; seed <= 300; seed++) {
        const items = planBout(sp, bout, new Rng(seed), (s) => sp.syllables[s].dur).filter((i) => i.syl === syl);
        for (let i = 1; i < items.length; i++) {
          const end = items[i - 1].t + longest / (slowest * items[i - 1].rate);
          expect(end - items[i].t, `${voice} seed ${seed} #${i}`).toBeLessThanOrEqual(0.02);
        }
      }
    }
  });
});

describe('syllable and colony recipes', () => {
  const ids = Object.keys(RECIPES).filter((id) => id.startsWith('syl.') || id.startsWith('loop.'));

  it('use the voice render rates, peak caps and lengths', () => {
    expect(ids.length).toBeGreaterThan(150);
    for (const id of ids) {
      const r = RECIPES[id];
      expect([16000, 22050], id).toContain(r.rate);
      expect(r.peak, id).toBeLessThanOrEqual(0.9);
      expect(r.dur, id).toBeLessThanOrEqual(id.startsWith('loop.') ? 10 : 6);
    }
  });

  it('never collide between registry sources, and seeds differ between variants', () => {
    const cues = Object.keys(CUE_RECIPES).map((id) => `cue.${id}`);
    const all = [...Object.keys(BED_RECIPES), ...Object.keys(ANIMAL_RECIPES), ...Object.keys(COLONY_RECIPES), ...cues];
    expect(new Set(all).size).toBe(all.length);
    for (const id of ids) {
      const m = /^(syl\..+)#(\d+)$/.exec(id);
      if (m && m[2] !== '0') expect(seedFor(id)).not.toBe(seedFor(`${m[1]}#0`));
    }
  });

  it('stay within the memory budget', () => {
    // demo zoo (where the round's targets are measured): every variant ≤ 6 MB
    // (a game day renders about 4.2 MB of them: variants render on first use),
    // the #0 set rendered at warmup ≤ 2.5 MB
    expect(sylBytes(DEMO_ZOO, false)).toBeLessThanOrEqual(6 * MB);
    expect(sylBytes(DEMO_ZOO, true)).toBeLessThanOrEqual(2.5 * MB);
    // any species adds at most 1.5 MB (the lion, with six roars and moans), 0.5 MB at warmup
    for (const voice of Object.keys(SPECIES_AUDIO)) {
      expect(sylBytes([voice], false), voice).toBeLessThanOrEqual(1.5 * MB);
      expect(sylBytes([voice], true), voice).toBeLessThanOrEqual(0.5 * MB);
    }
    // colony loops, once folded
    let colony = 0;
    for (const r of Object.values(COLONY_RECIPES)) colony += r.dur * (r.rate ?? 22050) * 4;
    expect(colony).toBeLessThanOrEqual(1.1 * MB);
  });
});

describe('registerRecipes', () => {
  it('adds new ids, accepts the same object again and rejects a different one', () => {
    const r: Recipe = { dur: 0.1, peak: 0.5, rms: 0.1, build: () => undefined };
    registerRecipes({ 'test.voices.registry': r });
    expect(RECIPES['test.voices.registry']).toBe(r);
    expect(() => registerRecipes({ 'test.voices.registry': r })).not.toThrow();
    expect(() => registerRecipes({ 'test.voices.registry': { ...r } })).toThrow();
    expect(() => registerRecipes({ 'syl.lion.roar#0': r })).toThrow();
    delete RECIPES['test.voices.registry'];
  });
});
