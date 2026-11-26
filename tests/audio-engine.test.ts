// Engine (src/audio/engine.ts) against a fake AudioContext: the AudioHost
// contract, pools, stealing, layering, loops, ducking, volumes, beds and the
// distance model. Renders are mocked (silent buffers of plausible length).
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { distanceModel, type Attenuation, type AudioModule } from '../src/audio/host';
import { ZooAudio, bedHeightTrim, fountainsOn, presenceAllowed, presenceTrim, releasable, uiScaleFor, voiceCeiling, type AudioEngineOptions } from '../src/audio/engine';
import { RECIPES } from '../src/audio/recipes';
import { MAP_H, MAP_W, TILE } from '../src/core/constants';
import type { ISimulation } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { Terrain, type AnimalState, type GuestState } from '../src/core/types';
import { FakeAudioContext, FakeParam, steepestRamp, type FakeGain, type FakeSource } from './helpers/fakeAudio';

vi.mock('../src/audio/render', async (orig) => {
  const m = await orig<typeof import('../src/audio/render')>();
  const { fakeAsset } = await import('./helpers/fakeAudio');
  return { ...m, renderRecipe: vi.fn(async (r: { dur: number; loop?: number; rate?: number }) => fakeAsset(r.loop ? r.dur : Math.min(r.dur, 1.5), r.rate ?? 22050, !!r.loop)) };
});

// ---------------------------------------------------------------- fakes

interface FakeWorld {
  terrain: Uint8Array;
  habitatOf: Int32Array;
  objects: Map<number, { defId: string; x: number; z: number }>;
  habitats: Map<number, unknown>;
  objectCenter(o: { x: number; z: number }): { x: number; y: number; z: number };
  heightAt(x: number, z: number): number;
}

function fakeSim() {
  const world: FakeWorld = {
    terrain: new Uint8Array(MAP_W * MAP_H).fill(Terrain.Grass),
    habitatOf: new Int32Array(MAP_W * MAP_H),
    objects: new Map(),
    habitats: new Map(),
    objectCenter: (o) => ({ x: o.x, y: 0, z: o.z }),
    heightAt: () => 0,
  };
  const sim = {
    world,
    animals: new Map<number, AnimalState>(),
    guests: new Map<number, GuestState>(),
    minuteOfDay: 11 * 60,
    speed: 1,
    isOpen: () => true,
  };
  return sim;
}
type Sim = ReturnType<typeof fakeSim>;

function animal(id: number, speciesId: string, x: number, z: number, extra: Partial<AnimalState> = {}): AnimalState {
  return { id, speciesId, sex: 'M', growth: 1, x, y: 0, z, action: 'idle', actionTime: 0, habitatId: null, ...extra } as AnimalState;
}

function guest(id: number, x: number, z: number): GuestState {
  return { id, x, y: 0, z, hidden: false } as GuestState;
}

/** Camera `dist` m from a ground focus, looking at it from the direction `yaw` (0 = from +z). */
function view(fx: number, fz: number, dist = 30, yaw = 0, pitch = 0.6) {
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 2000);
  const focus = new THREE.Vector3(fx, 0, fz);
  cam.position.set(fx + Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, fz + Math.cos(yaw) * Math.cos(pitch) * dist);
  cam.lookAt(focus);
  cam.updateMatrixWorld();
  return { cam, focus };
}

/** White-box view of the engine's runtime fields. */
interface Internals {
  pools: Record<'voice' | 'foley' | 'fx' | 'amb', { layers: { src: FakeSource; gain: FakeGain }[]; curPan: number; track: number }[]>;
  loops: Map<string, unknown>;
  sounds: Map<string, { buffer: unknown }>;
  pending: Set<string>;
  chan: Record<'ambience' | 'world' | 'ui' | 'music', { vol: FakeGain; duck: FakeGain; input: FakeGain; focus: FakeGain; trim: FakeGain }>;
  master: FakeGain;
  beds: Map<string, { playing: boolean }>;
  focusEq: { gain: FakeParam };
  animalBus: FakeGain;
  vocalBus: FakeGain;
  reverbIn: FakeGain;
}

const created: ZooAudio[] = [];
function engine(sim: Sim, opts: AudioEngineOptions = {}) {
  const ctx = new FakeAudioContext();
  const audio = new ZooAudio(sim as unknown as ISimulation, new EventBus(), { context: ctx as unknown as BaseAudioContext, modules: {}, ...opts });
  created.push(audio);
  return { audio, ctx, i: audio as unknown as Internals };
}

/** Run `seconds` of updates at 20 Hz with a fixed camera, advancing the fake clock. */
function run(audio: ZooAudio, ctx: FakeAudioContext, v: ReturnType<typeof view>, seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += 0.05) {
    ctx.currentTime += 0.05;
    audio.update(0.05, v.cam, v.focus);
  }
}

const AMB = Object.keys(RECIPES).filter((k) => k.startsWith('amb.'));

afterEach(() => {
  for (const a of created.splice(0)) a.dispose();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- tests

describe('distance model', () => {
  const out: Attenuation = { gain: 0, pan: 0, cut: 0, shelfDb: 0, wet: 0, dist: 0 };
  it('keeps the air bright far away and fades to zero at the radius', () => {
    expect(distanceModel(60, 0, 1, 10, 95, out).cut).toBeGreaterThanOrEqual(10000);
    for (let r = 0; r <= 300; r += 5) expect(distanceModel(r, 0, 0.5, 10, 95, out).cut).toBeGreaterThanOrEqual(5000);
    expect(distanceModel(95, 0, 1, 10, 95, out).gain).toBe(0);
    expect(distanceModel(140, 0, 1, 10, 95, out).gain).toBe(0);
    expect(distanceModel(10, 0, 1, 10, 95, out).gain).toBe(1);
    expect(distanceModel(4, 0, 1, 10, 95, out).gain).toBe(1);
  });
  it('sends more to the reverb with distance', () => {
    expect(distanceModel(8, 0, 1, 10, 95, out).wet).toBeCloseTo(0.05, 5);
    expect(distanceModel(29, 0, 1, 10, 95, out).wet).toBeCloseTo(0.45, 5);
    expect(distanceModel(80, 0, 1, 10, 95, out).wet).toBeCloseTo(0.45, 5);
  });
});

describe('AudioHost play', () => {
  it('requests an unrendered id and plays it once rendered', async () => {
    const sim = fakeSim();
    const { audio, i } = engine(sim);
    const id = AMB[0];
    expect(audio.host.play({ id, pool: 'amb', at: { x: 5, y: 0, z: 0 } })).toBeNull();
    expect(i.pending.has(id)).toBe(true);
    await audio.prefetch();
    const h = audio.host.play({ id, pool: 'amb', at: { x: 5, y: 0, z: 0 } });
    expect(h).not.toBeNull();
    expect(h!.endAt).toBeGreaterThan(0);
  });

  it('layers a play in the same group without stopping the first source', async () => {
    const sim = fakeSim();
    const { audio, ctx, i } = engine(sim);
    await audio.prefetch([AMB[0], AMB[1]]);
    const v = view(0, 0);
    audio.update(0.01, v.cam, v.focus);
    const a = audio.host.play({ id: AMB[0], at: { x: 3, y: 0, z: 3 }, group: 7 })!;
    const b = audio.host.play({ id: AMB[1], at: { x: 3, y: 0, z: 3 }, group: 7, when: ctx.currentTime + 0.3 })!;
    expect(a && b).toBeTruthy();
    const busy = i.pools.voice.filter((x) => x.layers.length);
    expect(busy).toHaveLength(1);
    const [first, second] = busy[0].layers;
    expect(second.src.startAt).toBeCloseTo(ctx.currentTime + 0.3, 6);
    expect(first.src.stopAt).toBeNull();
    expect(b.endAt).toBeGreaterThan(a.endAt);
  });

  it('steals the lowest priority voice with a held 20 ms fade', async () => {
    const sim = fakeSim();
    const { audio, ctx, i } = engine(sim);
    await audio.prefetch([AMB[0]]);
    const v = view(0, 0);
    audio.update(0.01, v.cam, v.focus);
    for (let k = 0; k < 6; k++) expect(audio.host.play({ id: AMB[0], at: { x: 2 + k, y: 0, z: 0 }, gain: 0.3 + k * 0.1 })).not.toBeNull();
    // not loud enough to steal (needs > 1.25 × the weakest)
    expect(audio.host.play({ id: AMB[0], at: { x: 1, y: 0, z: 0 }, gain: 0.31 })).toBeNull();
    const victim = i.pools.voice[0].layers[0];
    ctx.currentTime += 0.2;
    expect(audio.host.play({ id: AMB[0], at: { x: 1, y: 0, z: 0 }, gain: 1 })).not.toBeNull();
    const now = ctx.currentTime;
    const calls = victim.gain.gain.calls;
    const holdAt = calls.findIndex((c) => c.type === 'hold' && c.t === now);
    expect(holdAt).toBeGreaterThanOrEqual(0);
    const ramp = calls.slice(holdAt).find((c) => c.type === 'linear')!;
    expect(ramp).toBeDefined();
    expect(ramp.t - now).toBeGreaterThanOrEqual(0.02 - 1e-9);
    expect(victim.src.stopAt! - now).toBeGreaterThanOrEqual(0.02);
    expect(steepestRamp(ctx.gainParams())).toBeLessThanOrEqual(0.05 + 1e-6);
  });

  it('has 6/3/2/2 pooled voices (lowSpec 4/1/1/1)', () => {
    const sizes = (low: boolean) => {
      const { i } = engine(fakeSim(), { lowSpec: low });
      return [i.pools.voice.length, i.pools.foley.length, i.pools.fx.length, i.pools.amb.length];
    };
    expect(sizes(false)).toEqual([6, 3, 2, 2]);
    expect(sizes(true)).toEqual([4, 1, 1, 1]);
  });

  it("steers an 'at' voice as the camera turns", async () => {
    const sim = fakeSim();
    const { audio, ctx, i } = engine(sim);
    await audio.prefetch([AMB[0]]);
    const v0 = view(0, 0, 30, 0);
    audio.update(0.01, v0.cam, v0.focus);
    expect(audio.host.play({ id: AMB[0], at: { x: 20, y: 0, z: 10 }, rate: 0.5 })).not.toBeNull();
    const voice = i.pools.voice.find((x) => x.layers.length)!;
    expect(voice.curPan).toBeGreaterThan(0.5);
    run(audio, ctx, view(0, 0, 30, Math.PI / 2), 0.3);
    expect(voice.curPan).toBeLessThan(0);
  });

  it('records started sounds in debugLog', async () => {
    const sim = fakeSim();
    const { audio } = engine(sim);
    await audio.prefetch([AMB[0]]);
    audio.debugLog = [];
    audio.host.play({ id: AMB[0], pool: 'amb', at: { x: 12, y: 0, z: 0 }, group: 3 });
    audio.play('tap');
    expect(audio.debugLog.map((l) => l.id)).toEqual([AMB[0], 'cue.tap']);
    expect(audio.debugLog[0]).toMatchObject({ pool: 'amb', group: 3 });
  });
});

describe('night owl', () => {
  it('calls from a real tree, and its neighbour always answers from one place', async () => {
    const sim = fakeSim();
    sim.minuteOfDay = 23 * 60;
    sim.world.objects.set(1, { defId: 'tree_oak', x: 25, z: 9 });
    const { audio, ctx } = engine(sim);
    await audio.prefetch(['amb.owl']);
    audio.debugLog = [];
    run(audio, ctx, view(0, 0), 240);
    const owls = audio.debugLog.filter((l) => l.id === 'amb.owl');
    expect(owls.length).toBeGreaterThanOrEqual(5);
    const spots = new Set(owls.map((l) => `${l.x},${l.z}`));
    expect(spots.has('25,9')).toBe(true);
    expect(spots.size).toBeLessThanOrEqual(2);
    for (const o of owls) expect(o.pool).toBe('amb');
  });
});

describe('keyed loops', () => {
  it('starts once per key and stops after 4 s at level 0', async () => {
    const sim = fakeSim();
    const { audio, ctx, i } = engine(sim);
    const v = view(0, 0);
    audio.update(0.01, v.cam, v.focus);
    audio.host.loop('colony', 'bed.water', 0.5);
    await audio.prefetch();
    for (let k = 0; k < 3; k++) audio.host.loop('colony', 'bed.water', 0.5, 0.3);
    const buf = i.sounds.get('bed.water')!.buffer;
    const srcs = ctx.sources.filter((s) => s.buffer === buf);
    expect(srcs).toHaveLength(2);
    audio.host.loop('colony', 'bed.water', 0);
    run(audio, ctx, v, 3.5);
    expect(i.loops.size).toBe(1);
    run(audio, ctx, v, 1);
    expect(i.loops.size).toBe(0);
    expect(srcs.every((s) => s.stopAt !== null)).toBe(true);
  });
});

describe('modules', () => {
  it('an animal-owning module replaces the built-in calls and receives debugForce', async () => {
    const sim = fakeSim();
    sim.animals.set(1, animal(1, 'lion', 2, 2, { action: 'call', actionTime: 0.2 }));
    const force = vi.fn((id: number, kind: string) => id === 1 && kind === 'call');
    const update = vi.fn();
    const dispose = vi.fn();
    const mod: AudioModule = { ownsAnimals: true, warm: () => ['amb.owl'], update, force, dispose };
    const tryVoice = vi.spyOn(ZooAudio.prototype as unknown as { tryVoice: () => boolean }, 'tryVoice');
    const { audio, ctx, i } = engine(sim, { modules: { './modules/test.ts': () => mod } });
    expect(i.pending.has('amb.owl') || i.sounds.has('amb.owl')).toBe(true);
    expect([...i.pending].some((id) => id.startsWith('call.'))).toBe(false);
    await audio.prefetch();
    run(audio, ctx, view(0, 0), 1);
    expect(tryVoice).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
    expect(audio.debugForce(1, 'call')).toBe(true);
    expect(force).toHaveBeenCalledWith(1, 'call');
    expect((audio.debugState().modules as Record<string, unknown>).test).toBeDefined();
    audio.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('a throwing module factory is skipped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { audio } = engine(fakeSim(), {
      modules: {
        './modules/bad.ts': () => {
          throw new Error('boom');
        },
      },
    });
    expect(Object.keys(audio.debugState().modules as object)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('mix: ducking, volumes, suspend', () => {
  it('channel volume and ducking use separate gains', () => {
    const { audio, ctx, i } = engine(fakeSim());
    audio.setVolume('ui', 0.5);
    expect(i.chan.ui.vol.gain.valueAt(ctx.currentTime + 0.1)).toBeCloseTo(0.25, 6);
    expect(i.chan.ui.duck.gain.calls).toHaveLength(0);
    audio.setVolume('ambience', 0.6);
    audio.host.duck('ambience', -3, 1);
    expect(i.chan.ambience.duck.gain.valueAt(ctx.currentTime + 0.6)).toBeCloseTo(Math.pow(10, -3 / 20), 2);
    expect(i.chan.ambience.vol.gain.valueAt(ctx.currentTime + 10)).toBeCloseTo(0.36, 6);
    expect(i.chan.ambience.duck.gain.valueAt(ctx.currentTime + 10)).toBeCloseTo(1, 2);
    expect(audio.volume('ambience')).toBe(0.6);
  });

  it('volume 0 silences a channel: world plays return null', async () => {
    const { audio } = engine(fakeSim());
    await audio.prefetch([AMB[0]]);
    audio.setVolume('world', 0);
    expect(audio.host.play({ id: AMB[0], pool: 'voice', at: { x: 1, y: 0, z: 1 } })).toBeNull();
    expect(audio.host.play({ id: AMB[0], pool: 'amb', at: { x: 1, y: 0, z: 1 } })).not.toBeNull();
  });

  it('stops and suspends without gain steps', async () => {
    const { audio, ctx, i } = engine(fakeSim());
    await audio.prefetch([AMB[0]]);
    const v = view(0, 0);
    audio.update(0.01, v.cam, v.focus);
    const h = audio.host.play({ id: AMB[0], at: { x: 2, y: 0, z: 0 } })!;
    ctx.currentTime += 0.1;
    h.stop();
    audio.host.play({ id: AMB[0], at: { x: 2, y: 0, z: 0 } });
    const m: FakeParam = i.master.gain;
    const level = m.valueAt(ctx.currentTime);
    audio.suspend();
    expect(m.calls.some((c) => c.type === 'hold')).toBe(true);
    expect(m.valueAt(ctx.currentTime + 0.05)).toBe(0);
    audio.resume();
    expect(m.valueAt(ctx.currentTime + 0.31)).toBeCloseTo(level, 6);
    expect(steepestRamp(ctx.gainParams())).toBeLessThanOrEqual(0.05 + 1e-6);
  });

  it('starts the master at its level (the first cue is not swallowed)', () => {
    const { i, ctx } = engine(fakeSim());
    expect(i.master.gain.valueAt(ctx.currentTime)).toBeGreaterThan(1);
    expect(i.master.gain.calls.filter((c) => c.type !== 'set')).toHaveLength(0);
  });
});

describe('beds', () => {
  let addedB = false;
  beforeEach(() => {
    addedB = false;
  });
  afterEach(() => {
    if (addedB) delete RECIPES['bed.wind.b'];
  });

  it('renders urgent requests in request order: beds re-requested every frame do not overtake the current one', () => {
    const sim = fakeSim();
    const { audio } = engine(sim);
    const q = audio as unknown as { queue: string[]; request(id: string, urgent?: boolean): void };
    expect(q.queue).toContain('bed.birds');
    // what update() does every frame for the audible beds that are still rendering
    for (let f = 0; f < 3; f++) for (const id of ['bed.wind', 'bed.birds', 'bed.savanna', 'bed.crowd.b']) q.request(id, true);
    const order = ['bed.birds', 'bed.wind', 'bed.savanna', 'bed.crowd.b'].map((id) => q.queue.indexOf(id));
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // and all of them after the queued UI cues
    const lastCue = Math.max(...q.queue.map((id, k) => (id.startsWith('cue.') ? k : -1)));
    expect(order[0]).toBeGreaterThan(lastCue);
  });

  it('plays bed.<id>.b as the right-hand layer when registered', async () => {
    if (!RECIPES['bed.wind.b']) {
      RECIPES['bed.wind.b'] = { ...RECIPES['bed.wind'] };
      addedB = true;
    }
    const { audio, ctx, i } = engine(fakeSim());
    const v = view(0, 0);
    audio.update(0.01, v.cam, v.focus);
    await audio.prefetch();
    run(audio, ctx, v, 0.5);
    const a = i.sounds.get('bed.wind')!.buffer;
    const b = i.sounds.get('bed.wind.b')!.buffer;
    const left = ctx.sources.filter((s) => s.buffer === a);
    const right = ctx.sources.filter((s) => s.buffer === b);
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
    expect(right[0].playbackRate.value).toBe(1);
  });

  function crowdNear(guests: [number, number][]): number {
    const sim = fakeSim();
    guests.forEach(([x, z], k) => sim.guests.set(k + 1, guest(k + 1, x, z)));
    const { audio, ctx } = engine(sim);
    // camera straight above the focus: the ear's ground point is the focus
    run(audio, ctx, view(100, 100, 20, 0, Math.PI / 2 - 1e-4), 0.3);
    return (audio.debugState().env as { crowdNear: number }).crowdNear;
  }

  it('crowd density follows the guests around the ear', () => {
    expect(crowdNear([])).toBe(0);
    expect(crowdNear([[110, 100]])).toBeLessThanOrEqual(0.25);
    const close: [number, number][] = [];
    for (let k = 0; k < 30; k++) close.push([100 + Math.cos(k) * (k % 5), 100 + Math.sin(k) * (k % 5)]);
    expect(crowdNear(close)).toBeGreaterThanOrEqual(0.95);
    const far: [number, number][] = [];
    for (let k = 0; k < 120; k++) far.push([100 + Math.cos(k * 0.7) * (40 + (k % 30)), 100 + Math.sin(k * 0.7) * (40 + (k % 30))]);
    expect(crowdNear(far)).toBeLessThanOrEqual(0.05);
  });

  function biomeRun(paint: (sim: Sim) => void) {
    const sim = fakeSim();
    paint(sim);
    const { audio, ctx, i } = engine(sim);
    run(audio, ctx, view(72, 72, 25), 20);
    return { audio, i, state: audio.debugState() as { biome: Record<string, number>; beds: Record<string, number> } };
  }
  const fill = (sim: Sim, t: Terrain) => sim.world.terrain.fill(t);

  it('weights biomes from the terrain and habitats around the focus', async () => {
    const snow = biomeRun((s) => fill(s, Terrain.Snow));
    expect(snow.state.biome.arctic).toBeGreaterThanOrEqual(0.9);
    expect(biomeRun((s) => fill(s, Terrain.DryGrass)).state.biome.savanna).toBeGreaterThanOrEqual(0.9);
    const gorilla = biomeRun((s) => {
      const id = 5;
      for (let z = 30; z < 42; z++) for (let x = 30; x < 42; x++) s.world.habitatOf[z * MAP_W + x] = id;
      s.animals.set(9, animal(9, 'gorilla', 36 * TILE, 36 * TILE, { habitatId: id }));
    });
    expect(gorilla.state.biome.humid).toBeGreaterThanOrEqual(0.5);
  });

  it('thins the birds over snow', async () => {
    const level = async (t: Terrain) => {
      const sim = fakeSim();
      fill(sim, t);
      const { audio, ctx } = engine(sim);
      const v = view(72, 72, 25);
      audio.update(0.01, v.cam, v.focus);
      await audio.prefetch();
      run(audio, ctx, v, 20);
      return (audio.debugState().beds as Record<string, number>).birds;
    };
    const grass = await level(Terrain.Grass);
    expect(grass).toBeGreaterThan(0);
    expect(await level(Terrain.Snow)).toBeLessThanOrEqual(0.3 * grass);
  });

  it('requests no biome bed that is not registered', () => {
    const ids = ['bed.savanna', 'bed.savanna.night', 'bed.arctic', 'bed.humid', 'bed.humid.night'];
    const saved = ids.map((id) => [id, RECIPES[id]] as const);
    for (const id of ids) delete RECIPES[id];
    try {
      const { i } = biomeRun((s) => fill(s, Terrain.DryGrass));
      for (const id of ids) expect(i.pending.has(id) || i.sounds.has(id)).toBe(false);
    } finally {
      for (const [id, r] of saved) if (r) RECIPES[id] = r;
    }
  });
});

describe('mix: focus views, altitude trim, speech duck', () => {
  const db = (p: FakeParam, t: number) => 20 * Math.log10(p.valueAt(t));
  /** Run a lion at (100, 100) under a camera `dist` m from it; `setup` follows, selects or removes it. */
  function scene(dist: number, setup: (audio: ZooAudio, events: EventBus, sim: Sim) => void = () => {}, seconds = 3) {
    const sim = fakeSim();
    sim.animals.set(1, animal(1, 'lion', 100, 100));
    const events = new EventBus();
    const ctx = new FakeAudioContext();
    const audio = new ZooAudio(sim as unknown as ISimulation, events, { context: ctx as unknown as BaseAudioContext, modules: {} });
    created.push(audio);
    const i = audio as unknown as Internals;
    setup(audio, events, sim);
    const v = view(100, 100, dist);
    run(audio, ctx, v, seconds);
    // the focus mix and the speech duck are separate gain stages
    const level = (ch: 'ambience' | 'world' | 'ui', t: number) => db(i.chan[ch].focus.gain, t) + db(i.chan[ch].trim.gain, t);
    const mix = (t = ctx.currentTime) => ({ amb: level('ambience', t), world: level('world', t), ui: level('ui', t), band: i.focusEq.gain.valueAt(t) });
    return { audio, ctx, i, v, sim, events, mix };
  }
  const focusOf = (audio: ZooAudio) => (audio.debugState().mix as { focus: number }).focus;

  it('ducks the ambience 6 dB and dips its 2–6 kHz band while following an animal close up; animals +4 dB, UI +5 dB', () => {
    const { mix } = scene(6, (audio) => audio.follow(1));
    const m = mix();
    expect(m.amb).toBeCloseTo(-6, 0);
    expect(m.band).toBeCloseTo(-6, 0);
    expect(m.world).toBeCloseTo(4, 0);
    expect(m.ui).toBeCloseTo(5, 0);
  });

  it("gives the game's own follow framing (23.4 m, 26 m on the widest phones) the full focus mix", () => {
    expect(focusOf(scene(23.4, (a) => a.follow(1), 5).audio)).toBe(1);
    expect(focusOf(scene(26, (a) => a.follow(1), 5).audio)).toBe(1);
    expect(focusOf(scene(34, (a) => a.follow(1)).audio)).toBe(0);
  });

  it('moves the ear in to 4 m of the focus point in a focus view (a close-up microphone)', async () => {
    const heardFrom = async (dist: number, follow: boolean) => {
      const s = scene(dist, (a) => follow && a.follow(1));
      await s.audio.prefetch(['syl.lion.moan#0']);
      s.audio.debugLog = [];
      s.audio.host.play({ id: 'syl.lion.moan#0', track: 1, gain: 0.1 });
      return s.audio.debugLog[0].dist;
    };
    // the lion 1 m over the focus point: from the game's follow framing it is heard from 4 m, not 8 m
    expect(await heardFrom(23.4, true)).toBeLessThan(4.6);
    expect(await heardFrom(23.4, true)).toBeGreaterThan(3);
    // closer in, the ear stays a third of the way to the camera; a wide view is not a close-up
    expect(await heardFrom(6, true)).toBeLessThan(2.5);
    expect(await heardFrom(60, true)).toBeGreaterThan(19);
  });

  it('at night the focus mix ducks the ambience and steps the animals back 6 dB (no boost)', () => {
    const { mix } = scene(6, (audio, _e, sim) => {
      audio.follow(1);
      sim.minuteOfDay = 23 * 60;
    });
    expect(mix().amb).toBeCloseTo(-6, 0);
    expect(mix().world).toBeCloseTo(-6, 0);
  });

  it('compresses near-field calls 2:1 above the ceiling, the focus boost included; quieter calls are untouched', async () => {
    expect(voiceCeiling(0.3)).toBe(1);
    expect(voiceCeiling(0.5)).toBe(1);
    // 12 dB over the ceiling comes out 6 dB over it
    expect(2 * voiceCeiling(2)).toBeCloseTo(1, 5);
    // a louder call stays louder
    expect(2 * voiceCeiling(2)).toBeGreaterThan(1 * voiceCeiling(1));
    const s = scene(6, (a) => a.follow(1));
    await s.audio.prefetch(['syl.lion.moan#0']);
    s.audio.debugLog = [];
    s.audio.host.play({ id: 'syl.lion.moan#0', track: 1, gain: 1, refDist: 40 });
    s.audio.host.play({ id: 'syl.lion.moan#0', track: 1, gain: 0.05, refDist: 40 });
    const [loud, soft] = s.audio.debugLog;
    // focus view by day: +4 dB on the world, so the loud call is heard at 1.58 and compressed to √(0.5 / 1.58)
    expect(loud.gain).toBeCloseTo(Math.sqrt(0.5 / Math.pow(10, 4 / 20)), 2);
    expect(soft.gain).toBeCloseTo(0.05, 3);
  });

  it('hovering over an animal is a focus view; an empty close view or a far camera is not (the birds band still dips a little)', () => {
    expect(scene(12).mix().amb).toBeCloseTo(-6, 0);
    const empty = scene(12, (_a, _e, sim) => sim.animals.clear()).mix();
    expect(empty.amb).toBeCloseTo(0, 1);
    expect(empty.band).toBeCloseTo(0.6 * -6, 1);
    const far = scene(60, (audio) => audio.follow(1)).mix();
    expect(far.amb).toBeCloseTo(0, 1);
    expect(far.band).toBeCloseTo(0.3 * -6, 1);
  });

  it('hover focus: starts within 12 m, deepens with proximity, holds 3 s and ends beyond 18 m', () => {
    // the lion 15 m from the focus point never came within 12 m: no focus
    const s = scene(15, (_a, _e, sim) => (sim.animals.get(1)!.x = 115));
    expect(focusOf(s.audio)).toBe(0);
    const lion = s.sim.animals.get(1)!;
    lion.x = 110; // 10 m: the focus starts, at the depth of 10 m
    run(s.audio, s.ctx, s.v, 3);
    const at10 = focusOf(s.audio);
    expect(at10).toBeGreaterThan(0.7);
    expect(at10).toBeLessThan(0.95);
    lion.x = 104; // closer: deeper
    run(s.audio, s.ctx, s.v, 3);
    expect(focusOf(s.audio)).toBeGreaterThan(0.95);
    lion.x = 116; // 16 m: still on (hysteresis), shallow
    run(s.audio, s.ctx, s.v, 4);
    expect(focusOf(s.audio)).toBeGreaterThan(0.02);
    expect(focusOf(s.audio)).toBeLessThan(0.2);
    lion.x = 130; // gone
    run(s.audio, s.ctx, s.v, 8);
    expect(focusOf(s.audio)).toBeLessThan(0.02);
  });

  it('a brief pass over an animal holds the focus for 3 s instead of toggling it', () => {
    const s = scene(15, (_a, _e, sim) => (sim.animals.get(1)!.x = 130), 1);
    const lion = s.sim.animals.get(1)!;
    lion.x = 105;
    run(s.audio, s.ctx, s.v, 0.5);
    lion.x = 130;
    run(s.audio, s.ctx, s.v, 2);
    expect(focusOf(s.audio)).toBeGreaterThan(0.5);
    run(s.audio, s.ctx, s.v, 9);
    expect(focusOf(s.audio)).toBeLessThan(0.02);
  });

  it('follows the selection with a rate-limited attack and a ≈ 1.5 s release', () => {
    const { audio, ctx, v, events, mix, i } = scene(15, (_a, events) => events.emit('selectionChanged', { selection: { kind: 'animal', id: 1 } }), 0.05);
    const t0 = ctx.currentTime;
    expect(mix(t0 + 0.6).amb).toBeGreaterThan(-4);
    run(audio, ctx, v, 2.5);
    expect(mix().amb).toBeLessThan(-5.4);
    events.emit('selectionChanged', { selection: null });
    // the lion is still right under the camera: hovering keeps the focus mix
    run(audio, ctx, v, 1);
    expect(mix().amb).toBeCloseTo(-6, 0);
    (audio as unknown as { sim: Sim }).sim.animals.clear();
    run(audio, ctx, v, 3.3);
    // hovering ends after its 3 s hold; then a 1.5 s release
    const t1 = ctx.currentTime;
    run(audio, ctx, v, 1.5);
    expect(mix(t1 + 1.5).amb).toBeLessThan(-1.5);
    run(audio, ctx, v, 4);
    expect(mix().amb).toBeGreaterThan(-0.5);
    // never faster than 6 dB in a second
    const g = i.chan.ambience.focus.gain;
    let worst = 0;
    for (let t = 0; t < ctx.currentTime - 1; t += 0.05) worst = Math.max(worst, Math.abs(db(g, t + 1) - db(g, t)));
    expect(worst).toBeLessThanOrEqual(6);
  });

  it('a pan at 18 m across a herd moves the ambience at most 6 dB per second', () => {
    const sim = fakeSim();
    for (let k = 0; k < 6; k++) sim.animals.set(k + 1, animal(k + 1, 'zebra', 100 + k * 25, 100 + (k % 2) * 6));
    const { audio, ctx, i } = engine(sim);
    const g = i.chan.ambience.focus.gain;
    for (let t = 0; t < 30; t += 0.05) {
      ctx.currentTime += 0.05;
      const v = view(80 + t * 6, 100, 18);
      audio.update(0.05, v.cam, v.focus);
    }
    let worst = 0;
    let deepest = 0;
    for (let t = 1; t < 29; t += 0.05) {
      worst = Math.max(worst, Math.abs(db(g, t + 1) - db(g, t)));
      deepest = Math.min(deepest, db(g, t));
    }
    expect(deepest).toBeLessThan(-3);
    expect(worst).toBeLessThanOrEqual(6);
  });

  it('foley and colony loops recede 6 dB at the overview, vocal calls 3.1 dB', () => {
    const close = scene(10);
    expect(close.i.animalBus.gain.valueAt(close.ctx.currentTime + 5)).toBeCloseTo(1, 2);
    expect(close.i.vocalBus.gain.valueAt(close.ctx.currentTime + 5)).toBeCloseTo(1, 2);
    const over = scene(140);
    expect(over.i.animalBus.gain.valueAt(over.ctx.currentTime + 5)).toBeCloseTo(0.5, 2);
    expect(over.i.vocalBus.gain.valueAt(over.ctx.currentTime + 5)).toBeCloseTo(0.7, 2);
    const out = (v: unknown) => (v as { pan: { outputs: unknown[] } }).pan.outputs[0];
    expect(out(over.i.pools.voice[0])).toBe(over.i.vocalBus);
    expect(out(over.i.pools.foley[0])).toBe(over.i.animalBus);
    expect(out(over.i.pools.fx[0])).toBe(over.i.chan.world.input);
  });

  it('beds lose 1.5 dB from mid views up by day, not at night', () => {
    expect(20 * Math.log10(bedHeightTrim(20, 0))).toBeCloseTo(0, 3);
    expect(20 * Math.log10(bedHeightTrim(52, 0))).toBeCloseTo(-1.5, 2);
    expect(20 * Math.log10(bedHeightTrim(90, 0))).toBeCloseTo(-1.5, 2);
    expect(20 * Math.log10(bedHeightTrim(90, 1))).toBeCloseTo(0, 3);
  });

  it('a landmark call dips the ambience 3 dB for at least 1 s in a non-focus view, not in a focus view', async () => {
    const far = scene(52);
    await far.audio.prefetch(['syl.lion.moan#0']);
    far.audio.host.play({ id: 'syl.lion.moan#0', track: 1, landmark: true });
    const t = far.ctx.currentTime;
    expect(db(far.i.chan.ambience.duck.gain, t + 0.5)).toBeCloseTo(-3, 0);
    expect(db(far.i.chan.ambience.duck.gain, t + 1)).toBeLessThan(-2.5);
    expect(db(far.i.chan.ambience.duck.gain, t + 4)).toBeGreaterThan(-0.2);
    const close = scene(6, (a) => a.follow(1));
    await close.audio.prefetch(['syl.lion.moan#0']);
    close.audio.host.play({ id: 'syl.lion.moan#0', track: 1, landmark: true });
    expect(db(close.i.chan.ambience.duck.gain, close.ctx.currentTime + 0.5)).toBeCloseTo(0, 1);
  });

  it('a loud call ducks the ambience 3 dB outside focus views only (a focus view must not pump)', async () => {
    const duckAt = async (dist: number, follow: boolean) => {
      const s = scene(dist, (a) => follow && a.follow(1));
      await s.audio.prefetch(['syl.lion.moan#0']);
      s.audio.host.play({ id: 'syl.lion.moan#0', track: 1, gain: 1, refDist: 40 });
      return db(s.i.chan.ambience.duck.gain, s.ctx.currentTime + 0.5);
    };
    expect(await duckAt(52, false)).toBeCloseTo(-3, 0);
    expect(await duckAt(6, true)).toBeCloseTo(0, 1);
  });

  it('speechDuck ducks ambience and world 9 dB, tolerates repeats and lets go on its own', () => {
    const { audio, ctx, v, mix } = scene(60);
    audio.speechDuck(true);
    audio.speechDuck(true);
    const t0 = ctx.currentTime;
    expect(mix(t0 + 0.25).amb).toBeLessThan(-8);
    expect(mix(t0 + 0.25).world).toBeLessThan(-8);
    audio.speechDuck(false);
    expect(mix(t0 + 0.6).amb).toBeGreaterThan(-0.5);
    audio.speechDuck(false);
    audio.speechDuck(true);
    run(audio, ctx, v, 32);
    expect(mix().amb).toBeCloseTo(0, 1);
    expect((audio.debugState().mix as { speech: boolean }).speech).toBe(false);
  });

  it('while the tutorial speaks, landmark calls are refused and the calls dip 6 dB more, back over ~1.5 s', async () => {
    const s = scene(52);
    await s.audio.prefetch(['syl.lion.moan#0']);
    run(s.audio, s.ctx, s.v, 1);
    const calls = () => 20 * Math.log10(s.i.vocalBus.gain.valueAt(s.ctx.currentTime));
    const quiet = calls();
    s.audio.speechDuck(true);
    expect(s.audio.host.speech).toBe(true);
    expect(s.audio.host.play({ id: 'syl.lion.moan#0', track: 1, landmark: true })).toBeNull();
    // the zoo's other sounds still play (ducked with the world)
    expect(s.audio.host.play({ id: 'syl.lion.moan#0', track: 1 })).not.toBeNull();
    run(s.audio, s.ctx, s.v, 0.5);
    expect(calls() - quiet).toBeCloseTo(-6, 0);
    s.audio.speechDuck(false);
    expect(s.audio.host.speech).toBe(false);
    run(s.audio, s.ctx, s.v, 0.75);
    expect(calls() - quiet).toBeLessThan(-2);
    run(s.audio, s.ctx, s.v, 1.25);
    expect(calls() - quiet).toBeCloseTo(0, 1);
    expect(s.audio.host.play({ id: 'syl.lion.moan#0', track: 1, landmark: true })).not.toBeNull();
  });

  it('a speech duck asked for before the context exists applies when it starts', () => {
    const sim = fakeSim();
    const audio = new ZooAudio(sim as unknown as ISimulation, new EventBus(), { modules: {}, autoUnlock: false });
    created.push(audio);
    audio.speechDuck(true);
    const ctx = Object.assign(new FakeAudioContext(), { close: () => Promise.resolve() });
    (audio as unknown as { boot(c: unknown): void }).boot(ctx);
    expect(db((audio as unknown as Internals).chan.world.trim.gain, 0)).toBeCloseTo(-9, 1);
  });

  it('celebrate ducks the ambience and the world', async () => {
    const { audio, ctx, i } = scene(30);
    await audio.prefetch(['cue.celebrate']);
    audio.play('celebrate');
    const t = ctx.currentTime + 0.5;
    expect(db(i.chan.ambience.duck.gain, t)).toBeLessThan(-5);
    expect(db(i.chan.world.duck.gain, t)).toBeLessThan(-5);
  });

  it('UI level follows the beds: full at the busy day reference, up to +2.9 dB over a crowded plaza, floored at night', () => {
    expect(uiScaleFor(1)).toBeCloseTo(1, 5);
    expect(uiScaleFor(1.3)).toBeCloseTo(1.4, 5);
    expect(uiScaleFor(0.49)).toBeCloseTo(0.168, 3);
    expect(uiScaleFor(0.3)).toBe(0.165);
  });

  it('a close-up over a busy plaza keeps the UI scale and focus boost together within +4 dB', async () => {
    const sim = fakeSim();
    sim.animals.set(1, animal(1, 'lion', 100, 100));
    for (let k = 0; k < 60; k++) sim.guests.set(k + 1, guest(k + 1, 100 + (k % 8) * 2 - 8, 100 + Math.floor(k / 8) * 2 - 8));
    sim.world.objects.set(1, { defId: 'fountain', x: 100, z: 104 });
    for (let z = 22; z < 28; z++) for (let x = 22; x < 28; x++) sim.world.terrain[z * MAP_W + x] = Terrain.Water;
    const { audio, ctx, i } = engine(sim);
    audio.follow(1);
    const v = view(100, 100, 6);
    audio.update(0.01, v.cam, v.focus);
    run(audio, ctx, v, 1);
    await audio.prefetch();
    run(audio, ctx, v, 4);
    const ui = (audio.debugState().mix as { uiScale: number }).uiScale;
    expect(ui).toBeGreaterThan(1);
    const t = ctx.currentTime;
    expect(i.chan.ui.input.gain.valueAt(t) * i.chan.ui.focus.gain.valueAt(t)).toBeLessThanOrEqual(0.7 * 1.6 + 1e-3);
  });

  it('lifts the UI over a mid view carried by its calls (at most +4 dB with the scale), not over a quiet one', async () => {
    const uiAt = async (calls: number) => {
      const sim = fakeSim();
      sim.animals.set(1, animal(1, 'lion', 100, 100));
      const { audio, ctx, i } = engine(sim);
      const v = view(100, 100, 52);
      audio.update(0.01, v.cam, v.focus);
      await audio.prefetch(['syl.lion.moan#0', 'bed.wind', 'bed.birds']);
      for (let k = 0; k < 20; k++) {
        for (let c = 0; c < calls; c++) audio.host.play({ id: 'syl.lion.moan#0', track: 1, gain: 1, refDist: 200, group: 1 });
        run(audio, ctx, v, 0.5);
      }
      const t = ctx.currentTime;
      return { lift: i.chan.ui.focus.gain.valueAt(t), total: i.chan.ui.input.gain.valueAt(t) * i.chan.ui.focus.gain.valueAt(t) };
    };
    const quiet = await uiAt(0);
    expect(quiet.lift).toBeLessThan(1.1);
    const busy = await uiAt(4);
    expect(busy.lift).toBeGreaterThan(1.2);
    expect(busy.total).toBeLessThanOrEqual(0.7 * 1.6 + 1e-3);
  });

  it('keeps the UI channel between its floor and full level as the ambience thins', () => {
    const { audio } = scene(140, (_a, _e, sim) => (sim.minuteOfDay = 23 * 60), 3);
    const s = (audio.debugState().mix as { uiScale: number }).uiScale;
    expect(s).toBeGreaterThanOrEqual(0.165);
    expect(s).toBeLessThan(0.45);
  });
});

describe('shared reverb', () => {
  it('is set up in three delayed partial convolvers after the cues and the urgent beds', async () => {
    const { audio, ctx, i } = engine(fakeSim());
    let renderedAtFirstConvolver: string[] | null = null;
    const create = ctx.createConvolver.bind(ctx);
    ctx.createConvolver = () => {
      renderedAtFirstConvolver ??= [...i.sounds.keys()];
      return create();
    };
    await audio.prefetch();
    expect(renderedAtFirstConvolver).toEqual(expect.arrayContaining(['cue.tap', 'bed.birds', 'bed.wind']));
    const outs = i.reverbIn.outputs as unknown as { buffer?: { length: number }; delayTime?: FakeParam; outputs: unknown[] }[];
    expect(outs).toHaveLength(3);
    const lens = [outs[0].buffer!.length, ...outs.slice(1).map((d) => (d.outputs[0] as { buffer: { length: number } }).buffer.length)];
    const seg = lens[0];
    expect(outs[1].delayTime!.value).toBeCloseTo(seg / ctx.sampleRate, 6);
    expect(outs[2].delayTime!.value).toBeCloseTo((2 * seg) / ctx.sampleRate, 6);
    expect(lens.reduce((a, b) => a + b, 0)).toBe(Math.floor(1.2 * ctx.sampleRate));
  });
});

describe('beds: repetition and lowSpec memory', () => {
  it('moves each bed side to a random point of its loop, crossfaded, so the bed never repeats at its period', async () => {
    const { audio, ctx, i } = engine(fakeSim());
    const v = view(0, 0);
    audio.update(0.01, v.cam, v.focus);
    await audio.prefetch();
    run(audio, ctx, v, 60);
    const wind = i.sounds.get('bed.wind')!.buffer as { duration: number };
    const srcs = ctx.sources.filter((s) => s.buffer === (wind as unknown));
    // two sides, each re-seeking every 40–75 % of the 16 s loop
    expect(srcs.length).toBeGreaterThanOrEqual(2 + 2 * Math.floor(60 / (0.75 * wind.duration)));
    expect(new Set(srcs.map((s) => s.startOffset.toFixed(4))).size).toBe(srcs.length);
    const now = ctx.currentTime;
    const live = srcs.filter((s) => s.stopAt === null || s.stopAt > now + 2);
    expect(live).toHaveLength(2);
    for (const s of live) expect((s.outputs[0] as FakeGain).gain.valueAt(now + 2)).toBeCloseTo(1, 3);
    for (const s of srcs) if (s.stopAt !== null) expect((s.outputs[0] as FakeGain | undefined)?.gain.valueAt(s.stopAt) ?? 0).toBeLessThan(0.05);
  });

  it('lowSpec skips the second crowd layer and the night biome beds', async () => {
    const sim = fakeSim();
    sim.world.terrain.fill(Terrain.DryGrass);
    sim.minuteOfDay = 23 * 60;
    for (let k = 0; k < 30; k++) sim.guests.set(k + 1, guest(k + 1, 72 + (k % 5), 72 + (k % 6)));
    const { audio, ctx, i } = engine(sim, { lowSpec: true });
    const v = view(72, 72, 20);
    audio.update(0.01, v.cam, v.focus);
    for (let k = 0; k < 4; k++) {
      run(audio, ctx, v, 5);
      await audio.prefetch();
    }
    for (const id of ['bed.crowd.b', 'bed.savanna.night', 'bed.humid.night']) expect(i.pending.has(id) || i.sounds.has(id), id).toBe(false);
    const beds = audio.debugState().beds as Record<string, number>;
    expect(beds.savanna).toBeGreaterThan(0);
    expect(beds.crowd).toBeGreaterThan(0);
  });

  it('releases a bed silent for minutes (both tiers), and renders it again when it is heard again', async () => {
    const released = async (lowSpec: boolean) => {
      const sim = fakeSim();
      sim.world.terrain.fill(Terrain.DryGrass);
      const { audio, ctx, i } = engine(sim, { lowSpec });
      const v = view(72, 72, 20);
      audio.update(0.01, v.cam, v.focus);
      run(audio, ctx, v, 2);
      await audio.prefetch();
      run(audio, ctx, v, 2);
      expect(i.beds.get('savanna')!.playing).toBe(true);
      sim.world.terrain.fill(Terrain.Grass);
      // the biome fades out over ~40 s, then the bed stays silent for its release time
      run(audio, ctx, v, 240);
      const gone = !i.sounds.has('bed.savanna');
      sim.world.terrain.fill(Terrain.DryGrass);
      run(audio, ctx, v, 2);
      await audio.prefetch();
      run(audio, ctx, v, 2);
      expect(i.beds.get('savanna')!.playing).toBe(true);
      return gone;
    };
    expect(await released(true)).toBe(true);
    expect(await released(false)).toBe(true);
  });
});

describe('decoded memory', () => {
  const SYL = Object.keys(RECIPES).filter((k) => k.startsWith('syl.lion.') && /#[12]$/.test(k));

  it('gives back a variant not played for 3 minutes, never a #0 or a UI cue, and renders it again when its bank is looked at', async () => {
    const sim = fakeSim();
    const { audio, ctx, i } = engine(sim);
    const v = view(0, 0, 60);
    audio.update(0.01, v.cam, v.focus);
    const ids = [SYL[0], SYL[0].replace(/#\d$/, '#0'), 'cue.tap'];
    await audio.prefetch(ids);
    run(audio, ctx, v, 170);
    for (const id of ids) expect(i.sounds.has(id), id).toBe(true);
    run(audio, ctx, v, 25);
    expect(i.sounds.has(ids[0])).toBe(false);
    expect(i.sounds.has(ids[1])).toBe(true);
    expect(i.sounds.has('cue.tap')).toBe(true);
    // the fauna module's variant picker asks the host: the released variant renders again
    expect(audio.host.has(ids[0])).toBe(false);
    await audio.prefetch();
    expect(audio.host.has(ids[0])).toBe(true);
  });

  it('a variant played within 3 minutes stays', async () => {
    const sim = fakeSim();
    sim.animals.set(1, animal(1, 'lion', 0, 0));
    const { audio, ctx, i } = engine(sim);
    const v = view(0, 0, 20);
    audio.update(0.01, v.cam, v.focus);
    await audio.prefetch([SYL[0]]);
    for (let k = 0; k < 4; k++) {
      run(audio, ctx, v, 60);
      expect(audio.host.play({ id: SYL[0], track: 1 })).not.toBeNull();
    }
    expect(i.sounds.has(SYL[0])).toBe(true);
  });

  it('a burst of variant requests stops at the cap; later ones wait for idle sounds to make room, least recently used first', async () => {
    const sim = fakeSim();
    sim.animals.set(1, animal(1, 'lion', 0, 0));
    const { audio, ctx, i } = engine(sim, { lowSpec: true });
    const v = view(0, 0, 20);
    audio.update(0.01, v.cam, v.focus);
    const cap = 13 * 1048576;
    const bytes = () => [...i.sounds.values()].reduce((n, a) => n + (a.buffer as AudioBuffer).length * (a.buffer as AudioBuffer).numberOfChannels * 4, 0);
    // the largest fake variant: 1.5 s at 24 kHz, mono
    const one = 1.5 * 24000 * 4;
    // every releasable variant at once (silent fake buffers): far more than the lowSpec cap
    const big = Object.keys(RECIPES).filter((k) => releasable(k) && !k.startsWith('bed.'));
    await audio.prefetch(big);
    expect(bytes()).toBeLessThanOrEqual(cap + one);
    const waiting = big.filter((id) => !i.sounds.has(id));
    expect(waiting.length).toBeGreaterThan(10);
    run(audio, ctx, v, 20);
    audio.host.play({ id: big[0], track: 1 });
    run(audio, ctx, v, 15);
    // asked for again: sounds idle for 35 s make room, the one played 15 s ago stays
    expect(audio.host.has(waiting[0])).toBe(false);
    await audio.prefetch();
    expect(i.sounds.has(waiting[0])).toBe(true);
    expect(i.sounds.has(big[0])).toBe(true);
    expect(bytes()).toBeLessThanOrEqual(cap + one);
    expect((audio.debugState().decodedMiB as number) * 1048576).toBeCloseTo(bytes(), -4);
  });
});

describe('presence leveller', () => {
  it('turns the calls down only by how far their mean power exceeds the beds beyond the ratio allowed at that distance', () => {
    const at = (camDist: number, overDb: number) => presenceTrim(Math.pow(10, (presenceAllowed(camDist) + overDb) / 10), 1, camDist);
    expect(at(40, 0)).toBeCloseTo(0, 5);
    expect(at(40, -3)).toBe(0);
    expect(at(40, 10)).toBeCloseTo(-10, 5);
    expect(presenceTrim(1, 1, 90)).toBeCloseTo(-11, 5);
    expect(presenceTrim(0.05, 1, 90)).toBe(0);
    expect(presenceTrim(1e4, 1, 40)).toBe(-12);
    expect(presenceTrim(1, 0, 40)).toBe(0);
  });

  it('follows the proximity ladder: a wider view never allows its calls more than a closer one', () => {
    expect(presenceAllowed(30)).toBe(-5);
    expect(presenceAllowed(52)).toBe(-8);
    expect(presenceAllowed(90)).toBe(-11);
    expect(presenceAllowed(140)).toBe(-11);
    expect(presenceAllowed(20)).toBe(-5);
    for (let d = 20; d < 140; d += 1) expect(presenceAllowed(d + 1)).toBeLessThanOrEqual(presenceAllowed(d));
  });

  it('catches a chorus far over the beds at 6 dB/s, a mild excess at 1.5 dB/s', async () => {
    const trimAfter = async (gain: number, plays: number) => {
      const sim = fakeSim();
      sim.animals.set(1, animal(1, 'lion', 100, 100));
      const { audio, ctx } = engine(sim);
      const v = view(100, 100, 60);
      audio.update(0.01, v.cam, v.focus);
      await audio.prefetch(['syl.lion.moan#0', 'bed.wind', 'bed.birds']);
      run(audio, ctx, v, 2);
      // one group: every call is layered (and counted), none waits for a free voice
      for (let k = 0; k < plays; k++) audio.host.play({ id: 'syl.lion.moan#0', track: 1, gain, refDist: 200, group: 1 });
      run(audio, ctx, v, 1);
      return (audio.debugState().mix as { presenceDb: number }).presenceDb;
    };
    // 1 s into a roaring chorus the calls are already turned down by more than 4 dB
    expect(await trimAfter(1, 30)).toBeLessThan(-4);
    // a few soft calls are turned down slowly, if at all
    expect(await trimAfter(0.3, 3)).toBeGreaterThan(-1.6);
  });

  it('keeps the trim moving in a focus view (no stale trim when the camera leaves it)', async () => {
    const sim = fakeSim();
    sim.animals.set(1, animal(1, 'lion', 100, 100));
    const { audio, ctx } = engine(sim);
    const far = view(100, 100, 60);
    audio.update(0.01, far.cam, far.focus);
    await audio.prefetch(['syl.lion.moan#0', 'bed.wind', 'bed.birds']);
    for (let k = 0; k < 40; k++) {
      audio.host.play({ id: 'syl.lion.moan#0', track: 1, gain: 1, refDist: 200 });
      run(audio, ctx, far, 0.5);
    }
    const presence = () => (audio.debugState().mix as { presenceDb: number }).presenceDb;
    expect(presence()).toBeLessThan(-3);
    audio.follow(1);
    run(audio, ctx, view(100, 100, 6), 20);
    expect(presence()).toBe(0);
  });

  it('a zoo calling over its beds in a mid view is turned down slowly; a focus view is left alone', async () => {
    const level = async (dist: number, follow: boolean) => {
      const sim = fakeSim();
      sim.animals.set(1, animal(1, 'lion', 100, 100));
      const { audio, ctx, i } = engine(sim);
      if (follow) audio.follow(1);
      const v = view(100, 100, dist);
      audio.update(0.01, v.cam, v.focus);
      await audio.prefetch(['syl.lion.moan#0', 'bed.wind', 'bed.birds']);
      const start = i.vocalBus.gain.valueAt(ctx.currentTime + 1);
      for (let k = 0; k < 40; k++) {
        audio.host.play({ id: 'syl.lion.moan#0', track: 1, gain: 1, refDist: 200 });
        run(audio, ctx, v, 0.5);
      }
      return 20 * Math.log10(i.vocalBus.gain.valueAt(ctx.currentTime) / start);
    };
    const mid = await level(60, false);
    expect(mid).toBeLessThan(-3);
    expect(mid).toBeGreaterThanOrEqual(-12.5);
    expect(await level(6, true)).toBeCloseTo(0, 1);
  });
  it('a tap to follow takes the trim off with the focus mix', async () => {
    const sim = fakeSim();
    sim.animals.set(1, animal(1, 'lion', 100, 100));
    const { audio, ctx, i } = engine(sim);
    const far = view(100, 100, 60);
    audio.update(0.01, far.cam, far.focus);
    await audio.prefetch(['syl.lion.moan#0', 'bed.wind', 'bed.birds']);
    for (let k = 0; k < 40; k++) {
      audio.host.play({ id: 'syl.lion.moan#0', track: 1, gain: 1, refDist: 200 });
      run(audio, ctx, far, 0.5);
    }
    expect((audio.debugState().mix as { presenceDb: number }).presenceDb).toBeLessThan(-3);
    audio.follow(1);
    run(audio, ctx, view(100, 100, 6), 3);
    expect(i.vocalBus.gain.valueAt(ctx.currentTime)).toBeGreaterThan(0.95);
  });
});

describe('fountains', () => {
  it('run from 07:00 to 22:00 while the zoo is open', () => {
    expect(fountainsOn(12, true)).toBe(true);
    expect(fountainsOn(12, false)).toBe(false);
    expect(fountainsOn(6.5, true)).toBe(false);
    expect(fountainsOn(22.5, true)).toBe(false);
  });

  it('fade out over ~20 s when the zoo closes, and a night start finds them off', async () => {
    const sim = fakeSim();
    sim.world.objects.set(1, { defId: 'fountain', x: 100, z: 100 });
    let open = true;
    sim.isOpen = () => open;
    const { audio, ctx } = engine(sim);
    const v = view(100, 100, 20);
    audio.update(0.01, v.cam, v.focus);
    run(audio, ctx, v, 1);
    await audio.prefetch();
    run(audio, ctx, v, 3);
    const running = () => (audio.debugState().mix as { fountains: number }).fountains;
    const bed = () => (audio.debugState().beds as Record<string, number>).fountain;
    expect(running()).toBe(1);
    expect(bed()).toBeGreaterThan(0.1);
    open = false;
    run(audio, ctx, v, 10);
    expect(running()).toBeGreaterThan(0.3);
    expect(running()).toBeLessThan(0.75);
    run(audio, ctx, v, 15);
    expect(running()).toBe(0);
    expect(bed()).toBeLessThan(0.01);
    const night = fakeSim();
    night.minuteOfDay = 23 * 60;
    night.world.objects.set(1, { defId: 'fountain', x: 100, z: 100 });
    const n = engine(night);
    n.audio.update(0.01, v.cam, v.focus);
    run(n.audio, n.ctx, v, 1);
    expect((n.audio.debugState().mix as { fountains: number }).fountains).toBe(0);
  });
});

describe('voices: node reuse', () => {
  it('reuses the layer gains of finished plays, and a late stop() of an old play leaves the new one alone', async () => {
    const { audio, ctx } = engine(fakeSim(), { lowSpec: true });
    await audio.prefetch([AMB[0]]);
    const v = view(0, 0);
    audio.update(0.01, v.cam, v.focus);
    const gainsBefore = ctx.gains.length;
    let first: ReturnType<typeof audio.host.play> = null;
    for (let k = 0; k < 12; k++) {
      const h = audio.host.play({ id: AMB[0], pool: 'fx', at: { x: 2, y: 0, z: 0 } });
      expect(h).not.toBeNull();
      first ??= h;
      ctx.currentTime += 0.01;
      h!.stop(0.01);
      ctx.currentTime += 0.05;
    }
    // one fx voice on lowSpec: its first play's gain is reused by every later play
    expect(ctx.gains.length - gainsBefore).toBeLessThanOrEqual(2);
    const last = audio.host.play({ id: AMB[0], pool: 'fx', at: { x: 2, y: 0, z: 0 } })!;
    const layerGain = (ctx.sources.at(-1)!.outputs[0] as FakeGain).gain;
    const before = layerGain.calls.length;
    first!.stop();
    expect(layerGain.calls.length).toBe(before);
    expect(last.endAt).toBeGreaterThan(ctx.currentTime);
  });
});

describe('silent fallback', () => {
  it('accepts the tutorial speech duck without Web Audio', async () => {
    const { createAudio } = await import('../src/audio');
    const audio = createAudio(fakeSim() as unknown as ISimulation, new EventBus()) as unknown as { speechDuck(on: boolean): void };
    expect(() => {
      audio.speechDuck(true);
      audio.speechDuck(false);
    }).not.toThrow();
  });
});
