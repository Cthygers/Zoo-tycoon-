// Glottal pulse source (src/audio/voice.ts): period jitter, period doubling,
// determinism and output bounds.
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { Kit } from '../src/audio/kit';
import { RECIPES, seedFor } from '../src/audio/recipes';
import { glottalSource, glottalSteps, voice, voiceSteps, type PulseSpec, type VoiceSpec } from '../src/audio/voice';
import { FakeAudioContext } from './helpers/fakeAudio';

const SR = 22050;

/** Constant-pitch, constant-level source without aspiration (clean cycle marks). */
function steady(f0: number, extra: Partial<PulseSpec>): PulseSpec {
  return { dur: 1, f0: [[0, f0]], amp: [[0, 1]], shimmer: 0, aspiration: 0, ...extra };
}

/**
 * Cycle marks: for each derivative minimum (the closing spike), the falling
 * zero crossing just before it (the flow maximum), linearly interpolated
 * between samples. Returns the periods in samples.
 */
function periods(x: Float32Array): number[] {
  let pk = 0;
  for (const v of x) pk = Math.max(pk, Math.abs(v));
  const marks: number[] = [];
  let i = 1;
  while (i < x.length - 1) {
    if (x[i] < -0.3 * pk && x[i] <= x[i - 1] && x[i] <= x[i + 1]) {
      let j = i;
      while (j > 0 && x[j] < 0) j--;
      // x[j] >= 0 > x[j + 1]: interpolate the crossing
      marks.push(j + x[j] / (x[j] - x[j + 1]));
      while (i < x.length - 1 && x[i] < 0) i++;
    }
    i++;
  }
  const out: number[] = [];
  for (let k = 1; k < marks.length; k++) out.push(marks[k] - marks[k - 1]);
  return out.slice(1, -1); // drop edge cycles
}

function cv(p: number[]): number {
  const m = p.reduce((a, b) => a + b, 0) / p.length;
  const sd = Math.sqrt(p.reduce((a, b) => a + (b - m) * (b - m), 0) / p.length);
  return sd / m;
}

describe('glottalSource', () => {
  it('period jitter matches the spec (CV 0.007–0.013 at jitter 0.01)', () => {
    const p = periods(glottalSource(steady(120, { jitter: 0.01 }), SR, new Rng(11)));
    expect(p.length).toBeGreaterThan(100);
    const c = cv(p);
    expect(c).toBeGreaterThanOrEqual(0.007);
    expect(c).toBeLessThanOrEqual(0.013);
  });

  it('is strictly periodic without jitter (CV < 0.001)', () => {
    const p = periods(glottalSource(steady(120, { jitter: 0 }), SR, new Rng(11)));
    expect(p.length).toBeGreaterThan(100);
    expect(cv(p)).toBeLessThan(0.001);
    const mean = p.reduce((a, b) => a + b, 0) / p.length;
    expect(mean).toBeCloseTo(SR / 120, 0);
  });

  it('period doubling alternates long and short cycles', () => {
    const p = periods(glottalSource(steady(120, { jitter: 0, pd: [[0, 1, 0.3]] }), SR, new Rng(5)));
    expect(p.length).toBeGreaterThan(50);
    let odd = 0,
      even = 0;
    for (let i = 0; i + 1 < p.length; i += 2) {
      even += p[i];
      odd += p[i + 1];
    }
    const ratio = odd / even;
    expect(ratio >= 1.2 || ratio <= 1 / 1.2).toBe(true);
  });

  it('is deterministic per seed and differs between seeds', () => {
    const spec: PulseSpec = { dur: 0.5, f0: [[0, 90], [0.25, 180], [0.5, 70]], amp: [[0, 0], [0.1, 1], [0.5, 0]], chaos: [[0.3, 0.7, 0.08]], pd: [[0.7, 0.9, 0.3]], biphon: { ratio: 1.5, db: -12 }, tilt: 0.3 };
    const a = glottalSource(spec, 16000, new Rng(42));
    const b = glottalSource(spec, 16000, new Rng(42));
    const c = glottalSource(spec, 16000, new Rng(43));
    expect(a.length).toBe(8000);
    expect(Array.from(a)).toEqual(Array.from(b));
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - c[i]);
    expect(diff).toBeGreaterThan(1);
  });

  it('never produces NaN and peaks at 0.9', () => {
    const specs: PulseSpec[] = [
      { dur: 2.4, f0: [[0, 13], [1, 20], [2.4, 14]], amp: [[0, 0], [0.5, 1], [2.4, 0]], jitter: 0.03, shimmer: 0.1, oq: 0.5 },
      { dur: 0.3, f0: [[0, 2600]], amp: [[0, 1]], aspiration: 0.5, tilt: 0.9 },
      { dur: 0.2, f0: [[0, 0]], amp: [[0, 0]] },
    ];
    for (const s of specs) {
      const x = glottalSource(s, 16000, new Rng(3));
      expect(x.length).toBe(Math.ceil(s.dur * 16000));
      let pk = 0;
      for (const v of x) {
        expect(Number.isNaN(v)).toBe(false);
        pk = Math.max(pk, Math.abs(v));
      }
      expect(pk).toBeLessThanOrEqual(0.9 + 1e-6);
    }
  });
});

/** A kit on a recording context (no audio is rendered). */
function fakeKit(sr: number, seed: number) {
  const ctx = new FakeAudioContext(sr);
  const kit = new Kit(ctx as unknown as BaseAudioContext, ctx.createGain() as unknown as AudioNode, null, new Rng(seed), 3);
  return { ctx, kit };
}

const ROAR: VoiceSpec = {
  t: 0.1,
  dur: 1.7,
  f0: [[0, 75], [0.5, 190], [1.7, 60]],
  amp: [[0, 0], [0.5, 1], [1.7, 0]],
  chaos: [[0.45, 0.8, 0.08]],
  pd: [[0.8, 0.95, 0.3]],
  biphon: { ratio: 1.5, db: -14 },
  aspiration: 0.45,
  formants: [[300, 110, -1], [850, 160, -1], [1550, 230, -6]],
  drive: 1.3,
  bias: 0.2,
  noise: { level: 0.1, lo: 600, hi: 1500 },
};

describe('render slicing (long calls are built in steps)', () => {
  it('glottalSteps yields every few thousand samples and gives exactly glottalSource', () => {
    const g = glottalSteps(ROAR, 16000, new Rng(9));
    let steps = 0;
    let r = g.next();
    while (!r.done) {
      steps++;
      r = g.next();
    }
    // two pulse trains (biphonation) of 27200 samples, a step per 2048
    expect(steps).toBeGreaterThanOrEqual(2 * Math.floor(27200 / 2048) - 2);
    expect(Array.from(r.value)).toEqual(Array.from(glottalSource(ROAR, 16000, new Rng(9))));
  });

  it('voiceSteps schedules exactly what voice does, over several steps', () => {
    const a = fakeKit(16000, 4);
    voice(a.kit, ROAR);
    const b = fakeKit(16000, 4);
    const g = voiceSteps(b.kit, ROAR);
    let steps = 0;
    while (!g.next().done) steps++;
    expect(steps).toBeGreaterThan(10);
    expect(b.ctx.filters.map((f) => [f.type, f.frequency.value, f.Q.value])).toEqual(a.ctx.filters.map((f) => [f.type, f.frequency.value, f.Q.value]));
    expect(b.ctx.gains.map((g) => g.gain.value)).toEqual(a.ctx.gains.map((g) => g.gain.value));
    const data = (x: FakeAudioContext) => x.sources.filter((s) => !s.loop).map((s) => Array.from(s.buffer!.getChannelData(0)));
    expect(data(b.ctx)).toEqual(data(a.ctx));
  });

  it('builds the long voiced syllables (roars, moans, rumbles, brays) as generators of many short steps', () => {
    for (const id of ['syl.lion.roar#0', 'syl.lion.moan#1', 'syl.lion.growl#0', 'syl.elephant.rumble#0', 'syl.zebra.bray#2', 'syl.tiger.main#0']) {
      const r = RECIPES[id];
      const { kit } = fakeKit(r.rate ?? 22050, seedFor(id));
      const it = r.build(kit);
      expect(it, id).toBeTruthy();
      let steps = 0;
      while (!it!.next().done) steps++;
      expect(steps, id).toBeGreaterThanOrEqual(Math.floor((r.dur * (r.rate ?? 22050)) / 2048) - 1);
    }
  });
});
