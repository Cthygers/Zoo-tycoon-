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
import { Kit } from '../src/audio/kit';
import type { Recipe } from '../src/audio/render';
import { SPECIES } from '../src/data/species';
import { FakeAudioContext, FakeNode, FakeParam } from './helpers/fakeAudio';

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

  it('gives the types played in long series or often in a row enough variants not to cycle audibly', () => {
    for (const [voice, syl, n] of [
      ['lion', 'grunt', 8],
      ['giraffe', 'snort', 4],
      ['rhino', 'snort', 5],
      ['flamingo', 'grunt', 6],
      ['penguin', 'pair', 6],
      ['gorilla', 'hoot', 6],
    ] as const)
      expect(SPECIES_AUDIO[voice].syllables[syl].variants, `${voice}.${syl}`).toBeGreaterThanOrEqual(n);
    // lowSpec renders at most two of each, one whole zebra bray
    for (const sp of Object.values(SPECIES_AUDIO)) for (const b of Object.values(sp.syllables)) expect(b.lowSpecVariants ?? 2).toBeLessThanOrEqual(2);
    expect(SPECIES_AUDIO.zebra.syllables.bray.lowSpecVariants).toBe(1);
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

  it('never lets one animal overlap its own penguin display pairs', () => {
    for (const [voice, syl] of [['penguin', 'pair']]) {
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

/** Build a recipe on a recording context: every pulse source with its start and length, s. */
function pulses(id: string): { t: number; len: number }[] {
  const r = RECIPES[id];
  const ctx = new FakeAudioContext(r.rate);
  const kit = new Kit(ctx as unknown as BaseAudioContext, ctx.createGain() as unknown as AudioNode, null, new Rng(seedFor(id)), r.dur + (r.tail ?? 0));
  const it = r.build(kit);
  if (it) while (!it.next().done);
  return ctx.sources.filter((src) => src.buffer && !src.loop).map((src) => ({ t: src.startAt!, len: src.buffer!.duration }));
}

describe('zebra bray', () => {
  it('is one syllable whose inhale-exhale cycles run back to back: cross-fades of 15 ms, no gap', () => {
    const cycles = new Set<number>();
    for (let v = 0; v < SPECIES_AUDIO.zebra.syllables.bray.variants; v++) {
      // squeal, bark, squeal, bark... then the final bark
      const p = pulses(sylId('zebra', 'bray', v));
      expect(p.length % 2, `#${v}`).toBe(1);
      cycles.add((p.length - 1) / 2);
      // each part (squeal, bark, next squeal...) starts as the previous one ends
      for (let i = 1; i < p.length; i++) {
        const gap = p[i].t - (p[i - 1].t + p[i - 1].len);
        expect(gap, `#${v} part ${i}`).toBeGreaterThanOrEqual(-0.02);
        expect(gap, `#${v} part ${i}`).toBeLessThanOrEqual(0.02);
      }
      expect(p[p.length - 1].t + p[p.length - 1].len).toBeLessThanOrEqual(RECIPES[sylId('zebra', 'bray', v)].dur + 1e-3);
    }
    // the variants differ in length: 4, 6 and 7 cycles
    expect(cycles.size).toBe(3);
    for (const n of cycles) expect(n >= 4 && n <= 7).toBe(true);
  });
});

/** A recording context that also makes oscillators (thumps, flutter). */
class OscContext extends FakeAudioContext {
  readonly oscillators: { frequency: FakeParam; startAt: number }[] = [];
  createOscillator() {
    const o = Object.assign(new FakeNode(this), {
      type: 'sine',
      frequency: new FakeParam(this, 440),
      detune: new FakeParam(this, 0),
      startAt: 0,
      setPeriodicWave() {},
      start(t = 0) {
        o.startAt = t;
      },
      stop() {},
    });
    this.oscillators.push(o);
    return o;
  }
  createPeriodicWave() {
    return {};
  }
}

describe('signature calls up close', () => {
  it('a chest-beat is a run of hollow, damped beats: nothing rings on between them', () => {
    for (let v = 0; v < SPECIES_AUDIO.gorilla.syllables.beat.variants; v++) {
      const id = sylId('gorilla', 'beat', v);
      const r = RECIPES[id];
      const ctx = new OscContext(r.rate);
      const kit = new Kit(ctx as unknown as BaseAudioContext, ctx.createGain() as unknown as AudioNode, null, new Rng(seedFor(id)), r.dur + (r.tail ?? 0));
      r.build(kit);
      // every envelope of a beat closes within 80 ms of its start; the body thump decays with τ ≤ 15 ms
      for (const g of ctx.gains) {
        const ev = g.gain.scheduled;
        const set = ev.find((e) => e.type === 'set');
        const target = ev.find((e) => e.type === 'target');
        if (target && target.type === 'target') expect(target.tc, id).toBeLessThanOrEqual(0.015);
        else if (set && ev.length > 2 && ev[ev.length - 1].v === 0) expect(ev[ev.length - 1].t - set.t, id).toBeLessThanOrEqual(0.08);
      }
      // resonances are broad (a narrow one rang like a tom-drum)
      for (const f of ctx.filters) if (f.type === 'bandpass') expect(f.Q.value, id).toBeLessThanOrEqual(3);
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
    // demo zoo (where the round's targets are measured): every variant ≤ 6.4 MB (A3: whole
    // zebra brays and bigger grunt, snort, hoot and display banks; variants render on first use
    // and the engine gives back sounds unheard for minutes), the #0 set rendered at warmup ≤ 2.5 MB
    expect(sylBytes(DEMO_ZOO, false)).toBeLessThanOrEqual(6.4 * MB);
    expect(sylBytes(DEMO_ZOO, true)).toBeLessThanOrEqual(2.5 * MB);
    // any species adds at most 1.6 MB (the lion, with six roars and moans and eight grunts), 0.5 MB at warmup
    for (const voice of Object.keys(SPECIES_AUDIO)) {
      expect(sylBytes([voice], false), voice).toBeLessThanOrEqual(1.6 * MB);
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
