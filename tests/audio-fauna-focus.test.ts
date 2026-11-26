// Fauna module, audio round A2: the focus animal as a close-up microphone, far
// animals in close views, the species-share limiter, daytime lions and night
// roaring, idles by time of day, runtime variety, water foley, versus pace and
// the per-family foley hook. FakeHost and a stub sim, as in audio-fauna.test.ts.
import { describe, expect, it } from 'vitest';
import type { ISimulation } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import { PathType, Terrain, type AnimalState } from '../src/core/types';
import { individual } from '../src/audio/fauna/bout';
import { daytimeCall, idleActivity, isRoar, reachFactor, schedRate, spontaneousReach } from '../src/audio/fauna/diel';
import { CLOSE_STEP_DB, CLOSE_STEP_MASS, FEET_BANK, FOLEY_FAMILY, FOLEY_SPECIES, FoleyLimiter, GENERIC_FOLEY, QUIET_MAX, STEP_DB, foleyBankFor, registeredVariants } from '../src/audio/fauna/foley';
import { ShareLimiter } from '../src/audio/fauna/share';
import { REPEAT_RATE, RepeatGuard, playColor } from '../src/audio/fauna/variety';
import { createFauna, FAUNA } from '../src/audio/modules/fauna';
import { RECIPES, SPECIES_AUDIO } from '../src/audio/recipes';
import { FOLEY_RECIPES } from '../src/audio/recipes/foley';
import { FakeHost } from './helpers/fakeHost';

let nextId = 1;
function animal(speciesId: string, x: number, z: number, o: Partial<AnimalState> = {}): AnimalState {
  const id = nextId++;
  return {
    id,
    speciesId,
    name: `${speciesId}${id}`,
    sex: 'M',
    ageDays: 5,
    growth: 1,
    x,
    y: 0,
    z,
    heading: 0,
    speed: 0,
    action: 'idle',
    actionTime: 10,
    habitatId: 1,
    needs: { hunger: 1, thirst: 1, energy: 1, social: 1, environment: 1, space: 1, enrichment: 1 },
    happiness: 1,
    health: 1,
    pregnantDays: 0,
    escaped: false,
    seed: id * 7919,
    ...o,
  };
}

type Sim = ISimulation & { speed: number; paceScale?: number };

function setup(o: { seed?: number; terrain?: Terrain; camDist?: number; hour?: number; dur?: (id: string) => number } = {}) {
  const events = new EventBus();
  const animals = new Map<number, AnimalState>();
  const sim = {
    animals,
    guests: new Map(),
    speed: 1,
    events,
    world: { getTerrain: () => o.terrain ?? Terrain.Grass, getPath: () => PathType.None },
  } as unknown as Sim;
  const host = new FakeHost({ sim, events, dur: o.dur });
  const camDist = o.camDist ?? 30;
  host.listener = { x: 0, y: 1, z: 0, fx: 0, fz: 0, camDist, zoomNear: camDist <= 20 ? 1 : 0.8 };
  host.hour = o.hour ?? 12;
  host.nightness = host.hour >= 21 || host.hour < 5 ? 1 : 0;
  const fauna = createFauna(host, o.seed ?? 1);
  const add = (a: AnimalState) => (animals.set(a.id, a), a);
  const run = (seconds: number, dt = 0.05, each?: (t: number) => void) => {
    for (let t = 0; t < seconds; t += dt) {
      host.advance(dt);
      each?.(t);
      fauna.update(dt);
    }
  };
  const debug = () => fauna.debug!() as Record<string, unknown> & { started: Record<string, number> };
  return { sim, events, host, fauna, add, run, debug };
}

const db2lin = (db: number) => Math.pow(10, db / 20);
const lin2db = (g: number) => 20 * Math.log10(g);
const isStep = (id: string) => /^fx\.(step|splash\.small)/.test(id);
const vocal = (h: FakeHost, track?: number) => h.plays.filter((p) => p.spec.id.startsWith('syl.') && (track === undefined || p.spec.track === track));
const foley = (h: FakeHost, prefix: string, track?: number) => h.plays.filter((p) => p.spec.id.startsWith(prefix) && (track === undefined || p.spec.track === track));
/** Longest stretch without a sound of this animal (other than a footstep unless `steps`: a standing animal's weight shift), s. */
function longestQuiet(h: FakeHost, id: number, seconds: number, steps = false): number {
  const t = h.plays.filter((p) => p.spec.track === id && (steps || !isStep(p.spec.id))).map((p) => p.t);
  let gap = 0;
  let prev = 0;
  for (const x of [...t, seconds]) {
    gap = Math.max(gap, x - prev);
    prev = x;
  }
  return gap;
}

describe('the focus animal', () => {
  it('is the followed animal, else the selected one in view, else the nearest under a hovering camera', () => {
    const s = setup({ camDist: 12 });
    const near = s.add(animal('zebra', 1, 1));
    const sel = s.add(animal('zebra', 8, 0));
    const far = s.add(animal('zebra', 60, 0));
    s.run(0.2);
    expect(s.debug().focusId).toBe(near.id);
    s.events.emit('selectionChanged', { selection: { kind: 'animal', id: far.id } });
    s.run(0.2);
    // selected, but 60 m from the camera focus: not the one in view
    expect(s.debug().focusId).toBe(near.id);
    s.events.emit('selectionChanged', { selection: { kind: 'animal', id: sel.id } });
    s.run(0.2);
    expect(s.debug().focusId).toBe(sel.id);
    s.host.followId = far.id;
    s.run(0.2);
    expect(s.debug().focusId).toBe(far.id);
  });

  it('comes forward: its voice +5 dB, its foley at its own level', () => {
    // beyond hovering distance: only the followed animal is the focus
    const laps = (follow: boolean) => {
      const s = setup({ seed: 2, camDist: 40 });
      const lion = s.add(animal('lion', 4, 0, { action: 'drink' }));
      if (follow) s.host.followId = lion.id;
      s.run(3);
      return foley(s.host, foleyBankFor('drink', 'lion', (id) => id in RECIPES), lion.id).map((p) => p.spec.gain!);
    };
    const plain = laps(false);
    const focused = laps(true);
    expect(plain.length).toBeGreaterThan(5);
    expect(lin2db(Math.max(...focused) / Math.max(...plain))).toBeCloseTo(FAUNA.focusFoleyDb, 0);

    const voice = (follow: boolean) => {
      const s = setup({ seed: 3, camDist: 40 });
      const el = s.add(animal('elephant', 5, 0));
      if (follow) s.host.followId = el.id;
      for (let i = 0; i < 40; i++) {
        s.fauna.force!(el.id, 'idle');
        s.run(4);
      }
      // its idle snorts (the forced bouts and its own idles; not presence or signature calls)
      const g = vocal(s.host, el.id)
        .filter((p) => p.spec.id.startsWith('syl.elephant.snort'))
        .map((p) => lin2db(p.spec.gain!));
      return g.reduce((a, b) => a + b, 0) / g.length;
    };
    expect(voice(true) - voice(false)).toBeGreaterThan(FAUNA.focusVocalDb - 0.7);
    expect(voice(true) - voice(false)).toBeLessThan(FAUNA.focusVocalDb + 0.7);
  });

  it('is never silent for longer than its family allows (big herbivores 5 s, others 3 s), awake or asleep, birds included', () => {
    for (const sp of ['lion', 'elephant', 'giraffe', 'penguin', 'flamingo']) {
      for (const action of ['idle', 'sleep'] as const) {
        const s = setup({ seed: 4 });
        const a = s.add(animal(sp, 3, 0, { action }));
        for (let i = 0; i < 4; i++) s.add(animal(sp, 15 + i * 3, 10));
        s.host.followId = a.id;
        s.run(120);
        expect(longestQuiet(s.host, a.id, 120, true), `${sp} ${action}`).toBeLessThanOrEqual((FOLEY_SPECIES[sp].quietMax ?? QUIET_MAX) + 1.2);
      }
    }
  });

  it('calls a little more often than its species elsewhere, keeping its bout grammar', () => {
    const s = setup({ seed: 5 });
    const el = s.add(animal('elephant', 4, 0));
    s.host.followId = el.id;
    s.run(300, 0.1);
    const bouts = new Map<number, number>();
    for (const p of vocal(s.host, el.id)) if (!bouts.has(p.spec.group!)) bouts.set(p.spec.group!, p.t);
    const starts = [...bouts.values()].sort((a, b) => a - b);
    // focus clock: cooldown 4 s, then 0.35/s → a bout every ≈ 7 s
    expect(starts.length).toBeGreaterThanOrEqual(300 / 12);
    expect(starts.length).toBeLessThanOrEqual(300 / 5);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThan(1);
  });

  it('is heard walking even when light: close-up steps have a level floor', () => {
    const s = setup({ seed: 6 });
    const lion = s.add(animal('lion', 3, 0, { action: 'walk', speed: 1.5 }));
    s.host.followId = lion.id;
    s.run(20);
    const steps = foley(s.host, 'fx.step.pad', lion.id);
    expect(steps.length).toBeGreaterThan(20);
    const floor = CLOSE_STEP_MASS * db2lin(STEP_DB + CLOSE_STEP_DB + FAUNA.focusFoleyDb - 3.5);
    for (const p of steps) expect(p.spec.gain!).toBeGreaterThanOrEqual(floor * 0.999);
  });

  it('keeps foley slots for the focus animal among a walking herd', () => {
    const s = setup({ seed: 7 });
    for (let i = 0; i < 20; i++) s.add(animal('zebra', 5 * Math.cos(i), 5 * Math.sin(i), { action: 'walk', speed: 2.5 }));
    const el = s.add(animal('elephant', 3, 0, { action: 'walk', speed: 1.2 }));
    s.host.followId = el.id;
    s.run(30);
    // one step per metre at 1.2 m/s (stride 2.0 m, two feet): ≈ 18 in 30 s, none lost to the herd
    expect(foley(s.host, FEET_BANK[FOLEY_SPECIES.elephant.feet], el.id).length).toBeGreaterThanOrEqual(16);
    const t = s.host.plays.filter((p) => p.spec.pool === 'foley').map((p) => p.t);
    for (const t0 of t) expect(t.filter((x) => x >= t0 && x < t0 + 1).length).toBeLessThanOrEqual(FAUNA.foleyMax);
  });
});

describe('close views', () => {
  it('reach is 1.5 × the camera distance (10–60 m) × refDist / 10', () => {
    expect(reachFactor(15, 10, 10)).toBeCloseTo(0.5);
    expect(reachFactor(10, 2, 10)).toBeCloseTo(0.5);
    expect(reachFactor(60, 100, 10)).toBeCloseTo(0.5);
    expect(reachFactor(37.5, 10, 25)).toBeCloseTo(0.5);
  });

  it('mostly hears the animals in view: ≥ 60 % of vocal plays within 30 m, far bouts one at a time', () => {
    const s = setup({ seed: 8, camDist: 10 });
    for (let i = 0; i < 4; i++) s.add(animal('elephant', 4 + i * 4, 3));
    for (let i = 0; i < 12; i++) s.add(animal('flamingo', 50 + i, -20, { habitatId: 2 }));
    for (let i = 0; i < 4; i++) s.add(animal('lion', -45 - i * 2, 20, { habitatId: 3 }));
    s.run(600, 0.1);
    const v = vocal(s.host);
    expect(v.length).toBeGreaterThan(50);
    expect(v.filter((p) => p.dist <= 30).length / v.length).toBeGreaterThanOrEqual(0.6);
    // far bouts: never two at once, starts ≥ farGap s apart
    const far = new Map<number, { t0: number; t1: number }>();
    for (const p of v.filter((p) => p.dist > FAUNA.farDist)) {
      const b = far.get(p.spec.group!);
      if (b) b.t1 = p.t;
      else far.set(p.spec.group!, { t0: p.t, t1: p.t });
    }
    const list = [...far.values()].sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < list.length; i++) {
      expect(list[i].t0 - list[i - 1].t0).toBeGreaterThanOrEqual(FAUNA.farGap - 0.2);
      expect(list[i].t0).toBeGreaterThanOrEqual(list[i - 1].t1 - 0.2);
    }
  });

  it('steps the colony murmur back while one of its birds is the focus', () => {
    const level = (camDist: number) => {
      const s = setup({ camDist });
      for (let i = 0; i < 8; i++) s.add(animal('penguin', 2 + i, 2, { habitatId: 4 }));
      s.run(1);
      return s.host.loops.get('colony:4:penguin')!.level;
    };
    expect(lin2db(level(10) / level(FAUNA.closeView + 1))).toBeCloseTo(FAUNA.colonyFocusDb, 1);
  });
});

describe('species balance', () => {
  it('share limiter: tracks shares over its window and judges only with enough plays', () => {
    const l = new ShareLimiter(600, 0.3);
    for (let i = 0; i < 6; i++) l.add('lion', 1, i);
    expect(l.over('lion', 6)).toBe(false); // too few plays to judge
    for (let i = 0; i < 6; i++) l.add('zebra', 1, 10 + i);
    expect(l.share('lion', 20)).toBeCloseTo(0.5);
    expect(l.over('lion', 20)).toBe(true);
    for (let i = 0; i < 20; i++) l.add('penguin', 1, 30 + i);
    expect(l.over('lion', 50)).toBe(false);
    // a planned bout that would tip the lions over: (6 + 6) / (32 + 6) > 0.3
    expect(l.over('lion', 50, 6)).toBe(true);
    // the lion plays leave the window
    expect(l.share('lion', 607)).toBe(0);
  });

  it('holds back a far calling pride while it is over its share and other species are in range', () => {
    const calling = (others: boolean) => {
      // a close view with nothing under the camera: the pride is beyond shareNear of its focus point
      const s = setup({ seed: 9, hour: 12, camDist: 25 });
      const lions = [0, 1, 2, 3].map((i) => s.add(animal('lion', 40 + i * 3, 5, { habitatId: 3, sex: i ? 'F' : 'M' })));
      if (others) {
        for (let i = 0; i < 6; i++) s.add(animal('penguin', -14 - i, 6, { habitatId: 4 }));
        for (let i = 0; i < 3; i++) s.add(animal('elephant', 5, -15 - i * 4, { habitatId: 5 }));
      }
      let k = 0;
      s.run(600, 0.1, (t) => {
        // the sim makes some lion call every 6 s
        if (t >= k * 6) {
          const l = lions[k++ % 4];
          l.action = 'call';
          l.actionTime = 0;
        } else for (const l of lions) if (l.action === 'call') ((l.action = 'idle'), (l.actionTime = 10));
      });
      return { lionBouts: new Set(vocal(s.host).filter((p) => p.spec.id.startsWith('syl.lion')).map((p) => p.spec.group)).size, held: s.debug().shareHeld as number };
    };
    const mixed = calling(true);
    expect(mixed.held).toBeGreaterThan(20);
    // alone in range the lions are not limited
    const alone = calling(false);
    expect(alone.held).toBe(0);
    expect(alone.lionBouts).toBeGreaterThan(2 * mixed.lionBouts);
  });

  it('lions moan and grunt by day; full roaring belongs to dusk and night', () => {
    const lion = SPECIES_AUDIO.lion;
    const call = lion.bouts.find((b) => b.kind === 'call')!;
    expect(isRoar(lion, call)).toBe(true);
    expect(isRoar(lion, daytimeCall(lion, call))).toBe(false);
    expect(daytimeCall(lion, call).steps.find((st) => st.syl === 'grunt')!.n[1]).toBeLessThanOrEqual(6);
    for (const [hour, roars] of [
      [12, false],
      [21, true],
    ] as const) {
      const s = setup({ hour });
      const a = s.add(animal('lion', 20, 0));
      s.run(1);
      a.action = 'call';
      a.actionTime = 0.2;
      s.run(40);
      expect(vocal(s.host, a.id).length, `${hour} h`).toBeGreaterThan(2);
      expect(vocal(s.host, a.id).some((p) => p.spec.id.startsWith('syl.lion.roar')), `${hour} h`).toBe(roars);
    }
  });

  it('the big quiet species are heard around the zoo now and then', () => {
    for (const sp of ['elephant', 'giraffe', 'rhino', 'tiger']) {
      expect(schedRate(SPECIES_AUDIO[sp], 12, spontaneousReach(40, 40, 40, SPECIES_AUDIO[sp].refDist), 40) * 60, sp).toBeGreaterThanOrEqual(0.5);
      const s = setup({ seed: 11, camDist: 40 });
      for (let i = 0; i < 2; i++) s.add(animal(sp, 35 + i * 4, 10));
      s.run(600, 0.2);
      expect(s.debug().started.sched, sp).toBeGreaterThanOrEqual(4);
    }
  });

  it('idles by daily rhythm: a diurnal gorilla barely grunts at night', () => {
    // every voice silent by its rhythm at 23:00 idles at most 0.2× its busiest daytime rate
    for (const sp of Object.values(SPECIES_AUDIO)) {
      if (sp.activity[23] > 0) continue;
      const day = Math.max(...sp.activity.slice(6, 19).map((_, i) => idleActivity(sp, 6 + i)));
      expect(idleActivity(sp, 23), sp.voice).toBeLessThanOrEqual(0.2 * day);
    }
    // a night-active voice keeps idling after dark
    expect(idleActivity(SPECIES_AUDIO.lion, 23)).toBeGreaterThan(0.5);
    // and the lottery follows it
    const idles = (hour: number) => {
      // a close view with no gorilla under the camera: the lottery alone (no focus, presence or landmark calls)
      const s = setup({ seed: 12, hour, camDist: 25 });
      for (let i = 0; i < 4; i++) s.add(animal('gorilla', 14 + i * 4, 5, { action: 'walk', speed: 0.5 }));
      s.run(1800, 0.2);
      return s.debug().started.idle;
    };
    const day = idles(8);
    expect(day).toBeGreaterThan(20);
    expect(idles(23)).toBeLessThanOrEqual(0.35 * day);
  });
});

describe('runtime variety', () => {
  it('repeat guard: a variant within 3 % inside 10 s clashes; a nudged rate avoids it', () => {
    const g = new RepeatGuard();
    g.note('a#0', 1, 0);
    expect(g.clashes('a#0', 1.02, 5)).toBe(true);
    expect(g.clashes('a#0', 1.04, 5)).toBe(false);
    expect(g.clashes('a#0', 1, 10.5)).toBe(false);
    expect(g.clashes('a#1', 1, 5)).toBe(false);
    const r = g.freeRate('a#0', 1.01, 5)!;
    expect(Math.abs(r / 1 - 1)).toBeGreaterThan(REPEAT_RATE);
    expect(Math.abs(r / 1.01 - 1)).toBeLessThanOrEqual(0.1);
  });

  it('gives every play its own colour, ±2 dB around the individual in 1–3 kHz', () => {
    const ind = individual(SPECIES_AUDIO.lion, 77, 'M');
    const rng = new Rng(3);
    for (let i = 0; i < 200; i++) {
      const c = playColor(ind, rng);
      expect(c.hz).toBeGreaterThanOrEqual(920);
      expect(c.hz).toBeLessThanOrEqual(3240);
      expect(Math.abs(c.db - ind.color.db)).toBeLessThanOrEqual(2);
    }
  });

  it('never plays one animal the same variant twice in a row, and spreads rates ±4 %', () => {
    const s = setup({ seed: 13 });
    const birds = [0, 1, 2].map((i) => s.add(animal('penguin', 4 + i, 0)));
    for (let k = 0; k < 60; k++) {
      for (const b of birds) s.fauna.force!(b.id, 'idle');
      s.run(4);
    }
    for (const b of birds) {
      const ids = vocal(s.host, b.id).map((p) => p.spec.id);
      expect(ids.length).toBeGreaterThan(40);
      for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1]);
    }
    const rates = vocal(s.host, birds[0].id).map((p) => p.spec.rate!);
    expect(Math.max(...rates) / Math.min(...rates)).toBeGreaterThan(1.06);
    // three contact variants played every 4 s by three birds: repeats within 10 s at ≤ 3 % stay rare
    expect(s.debug().repeated as number).toBeLessThanOrEqual(5);
  });
});

describe('water foley', () => {
  it('caps splashes of birds out of focus per habitat, never the focus bird', () => {
    // a camera beyond hovering distance: no bird is the focus until one is followed
    const s = setup({ seed: 14, terrain: Terrain.Water, camDist: 40 });
    const flock = Array.from({ length: 9 }, (_, i) => s.add(animal('penguin', 3 + (i % 3), (i / 3) | 0, { action: 'swim', habitatId: 4 })));
    s.run(30);
    const splash = (track?: number) => foley(s.host, 'fx.splash', track).map((p) => p.t);
    const t = splash();
    expect(t.length).toBeGreaterThan(10);
    for (const t0 of t) expect(t.filter((x) => x >= t0 && x < t0 + FAUNA.waterWindow - 1e-6).length).toBeLessThanOrEqual(FAUNA.waterMax);
    s.host.followId = flock[0].id;
    const before = s.host.plays.length;
    s.run(30);
    const mine = s.host.plays.slice(before).filter((p) => p.spec.track === flock[0].id && p.spec.id.startsWith('fx.splash'));
    // a stroke every 0.8–1.5 s: ≈ 26 in 30 s
    expect(mine.length).toBeGreaterThanOrEqual(18);
  });

  it('limiter reserve: priority starts may use the last slots', () => {
    const l = new FoleyLimiter(6, 1, 0.15, 2);
    let n = 0;
    for (let i = 0; i < 10; i++) if (l.take(i, i * 0.01)) n++;
    expect(n).toBe(4);
    expect(l.take(50, 0.2, true)).toBe(true);
    expect(l.take(51, 0.21, true)).toBe(true);
    expect(l.take(52, 0.22, true)).toBe(false);
  });
});

describe('versus pace', () => {
  it('a locked-4× match has the animal density of 1× and never fills the voice pool', () => {
    const density = (pace: number) => {
      // a close view with no animal under the camera: no focus, no presence or landmark calls
      const s = setup({ seed: 15, camDist: 25 });
      s.sim.speed = pace === 4 ? 3 : 1;
      s.sim.paceScale = pace;
      const herd = Array.from({ length: 8 }, (_, i) => s.add(animal('zebra', 16 + i * 2, 4)));
      let k = 0;
      // the sim makes a zebra call every 12 game seconds: `pace`× as often per real second
      s.run(300, 0.1, (t) => {
        if (t * pace >= k * 12) {
          const z = herd[k++ % herd.length];
          z.action = 'call';
          z.actionTime = 0;
        } else for (const z of herd) if (z.action === 'call') ((z.action = 'idle'), (z.actionTime = 10));
      });
      // busy voices: a bout layers its syllables on one voice (group)
      const v = vocal(s.host);
      let maxVoices = 0;
      for (let t = 0; t < 300; t += 0.25) maxVoices = Math.max(maxVoices, new Set(v.filter((p) => p.t <= t && t < p.t + 0.5 / p.spec.rate!).map((p) => p.spec.group)).size);
      return { sim: s.debug().started.sim, plays: v.length, maxVoices };
    };
    const one = density(1);
    const four = density(4);
    expect(four.sim / one.sim).toBeGreaterThan(0.6);
    expect(four.sim / one.sim).toBeLessThan(1.6);
    expect(four.plays / one.plays).toBeLessThan(1.6);
    // the 6-voice pool keeps room (the engine layers a bout's syllables on one voice)
    expect(four.maxVoices).toBeLessThan(6);
  });
});

describe('per-family foley', () => {
  it('maps every voice to a family and falls back to the generic banks', () => {
    for (const voice of Object.keys(SPECIES_AUDIO)) expect(FOLEY_FAMILY[voice], voice).toBeDefined();
    const none = () => false;
    expect(foleyBankFor('breath', 'lion', none)).toBe(GENERIC_FOLEY.breath);
    expect(foleyBankFor('chew', 'zebra', none)).toBe('fx.chew');
    expect(foleyBankFor('drink', 'penguin', none)).toBe('fx.lap');
    const cats = (id: string) => /^fx\.breath\.cat#[01]$/.test(id);
    expect(foleyBankFor('breath', 'tiger', cats)).toBe('fx.breath.cat');
    expect(foleyBankFor('breath', 'elephant', cats)).toBe('fx.breath.big');
    expect(registeredVariants('fx.breath.cat', cats)).toBe(2);
  });

  it('breathes from fx.breath.<family>#k once the voices owner registers it', () => {
    expect(FOLEY_RECIPES['fx.breath.cat#0']).toBeDefined();
    const s = setup({ seed: 16 });
    const lion = s.add(animal('lion', 3, 0));
    s.host.followId = lion.id;
    s.run(30);
    const breaths = s.host.plays.filter((p) => p.spec.track === lion.id && p.spec.id.startsWith('fx.breath'));
    expect(breaths.length).toBeGreaterThan(5);
    for (const p of breaths) expect(p.spec.id).toMatch(/^fx\.breath\.cat#\d$/);
  });
});
