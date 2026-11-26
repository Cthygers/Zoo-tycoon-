// Fauna module, audio round A3: the share limiter by reference energy and
// what the player looks at, lion roaring by count, penguin colony displays,
// presence and landmark calls in mid and far views, close-up body sounds by
// family, the focus animal's herd, signature moments and focus precedence.
// FakeHost and a stub sim, as in audio-fauna-focus.test.ts.
import { describe, expect, it } from 'vitest';
import type { ISimulation } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { PathType, Terrain, type AnimalState } from '../src/core/types';
import { PRESENCE_CAM, carryRefDist, signatureBout, spontaneousReach, reachFactor } from '../src/audio/fauna/diel';
import { HANDOVER_HOLD, HOVER_KEEP, HOVER_MIN, HoverFocus } from '../src/audio/fauna/focus';
import { CLOSE_STEP_DB, CLOSE_STEP_MASS, FOLEY_SPECIES, RUSTLE_EVERY, STEP_DB } from '../src/audio/fauna/foley';
import { EXTRA_ROARS, ROAR_SPACING, RoarCount } from '../src/audio/fauna/roar';
import { SHARE_REF_DIST, refEnergy } from '../src/audio/fauna/share';
import { createFauna, FAUNA } from '../src/audio/modules/fauna';
import { SPECIES_AUDIO } from '../src/audio/recipes';
import { Rng } from '../src/core/rng';
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

function setup(o: { seed?: number; camDist?: number; hour?: number; terrain?: Terrain } = {}) {
  const events = new EventBus();
  const animals = new Map<number, AnimalState>();
  const sim = {
    animals,
    guests: new Map(),
    speed: 1,
    events,
    world: { getTerrain: () => o.terrain ?? Terrain.Grass, getPath: () => PathType.None },
  } as unknown as ISimulation & { speed: number };
  const host = new FakeHost({ sim, events });
  const camDist = o.camDist ?? 30;
  host.listener = { x: 0, y: 1, z: 0, fx: 0, fz: 0, camDist, zoomNear: camDist <= 20 ? 1 : 0.8 };
  host.hour = o.hour ?? 12;
  host.nightness = host.hour >= 21 || host.hour < 5 ? 1 : 0;
  const fauna = createFauna(host, o.seed ?? 1);
  const add = (a: AnimalState) => (animals.set(a.id, a), a);
  const run = (seconds: number, dt = 0.1, each?: (t: number) => void) => {
    for (let t = 0; t < seconds; t += dt) {
      host.advance(dt);
      each?.(t);
      fauna.update(dt);
    }
  };
  const debug = () => fauna.debug!() as Record<string, unknown> & { started: Record<string, number>; focusId: number; mates: number[] };
  return { sim, events, host, fauna, add, run, debug };
}

const lin2db = (g: number) => 20 * Math.log10(g);
const vocal = (h: FakeHost, track?: number) => h.plays.filter((p) => p.spec.id.startsWith('syl.') && (track === undefined || p.spec.track === track));
const bouts = (h: FakeHost, track?: number) => new Set(vocal(h, track).map((p) => p.spec.group)).size;

describe('species share', () => {
  it('measures energy at a fixed distance from the caller, not at the listener', () => {
    expect(refEnergy(0.5, 2, 25)).toBeCloseTo(0.5);
    expect(refEnergy(0.5, 2, SHARE_REF_DIST)).toBeCloseTo(0.5);
    expect(refEnergy(1, 1, SHARE_REF_DIST / 2)).toBeCloseTo(0.25);
  });

  it('never holds back the species the camera is on, the focus animal or its herd', () => {
    // lions calling every 4 s right under the camera, penguins and elephants further off
    const s = setup({ seed: 3, hour: 12, camDist: 25 });
    const lions = [0, 1, 2, 3].map((i) => s.add(animal('lion', 14 + i * 3, 4, { habitatId: 3, sex: i ? 'F' : 'M' })));
    for (let i = 0; i < 6; i++) s.add(animal('penguin', -30 - i, 6, { habitatId: 4 }));
    for (let i = 0; i < 3; i++) s.add(animal('elephant', 5, -35 - i * 4, { habitatId: 5 }));
    let k = 0;
    s.run(600, 0.1, (t) => {
      if (t >= k * 4) {
        const l = lions[k++ % 4];
        l.action = 'call';
        l.actionTime = 0;
      } else for (const l of lions) if (l.action === 'call') ((l.action = 'idle'), (l.actionTime = 10));
    });
    expect(s.debug().shareHeld).toBe(0);
    expect(bouts(s.host)).toBeGreaterThan(60);
  });
});

describe('lion roaring by count', () => {
  it('a dusk chorus, at most EXTRA_ROARS more roars ≥ 60 s apart until 01:30, a dawn chorus; a new night starts afresh', () => {
    const r = new RoarCount();
    expect(r.slot(15, 0)).toBeNull();
    expect(r.slot(19.6, 10)).toBe('dusk');
    r.take('dusk', 10);
    expect(r.slot(20, 10 + ROAR_SPACING - 1)).toBeNull();
    for (let i = 0; i < EXTRA_ROARS; i++) {
      const t = 10 + (i + 1) * ROAR_SPACING;
      expect(r.slot(21 + i, t)).toBe('extra');
      r.take('extra', t);
    }
    expect(r.slot(0.5, 1000)).toBeNull();
    expect(r.slot(4.8, 1000)).toBe('dawn');
    r.take('dawn', 1000);
    expect(r.slot(5, 1100)).toBeNull();
    expect(r.slot(12, 1200)).toBeNull();
    expect(r.slot(19.7, 1300)).toBe('dusk');
    // a game started after midnight: its first chorus counts as the dusk one; no extras after 01:30
    const late = new RoarCount();
    expect(late.slot(2, 0)).toBe('dusk');
    late.take('dusk', 0);
    expect(late.slot(3, 100)).toBeNull();
  });

  it('a pride roars 3–4 times from dusk to dawn, each with at most 2 joiners, and only moans and grunts by day', () => {
    const s = setup({ seed: 5, hour: 18.5, camDist: 40 });
    for (let i = 0; i < 5; i++) s.add(animal('lion', 40 + i * 3, 5, { habitatId: 3, sex: i ? 'F' : 'M' }));
    s.host.listener = { ...s.host.listener, fx: 40, fz: 5 };
    // 3 game minutes per real second: 18:30 → 07:30 in 260 s
    s.run(260, 0.1, () => {
      s.host.hour = (s.host.hour + 0.1 / 20) % 24;
      s.host.nightness = s.host.hour >= 20.5 || s.host.hour < 5 ? 1 : 0;
    });
    const roars = vocal(s.host).filter((p) => p.spec.id.startsWith('syl.lion.roar'));
    // roaring bouts (first roar of each), grouped into choruses: a caller and the joiners within 15 s
    const first = new Map<number, number>();
    for (const p of roars) if (!first.has(p.spec.group!)) first.set(p.spec.group!, p.t);
    const choruses: number[][] = [];
    for (const t of [...first.values()].sort((a, b) => a - b)) {
      const last = choruses[choruses.length - 1];
      if (last && t - last[0] < 15) last.push(t);
      else choruses.push([t]);
    }
    expect(choruses.length).toBeGreaterThanOrEqual(3);
    expect(choruses.length).toBeLessThanOrEqual(2 + EXTRA_ROARS);
    for (const c of choruses) expect(c.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < choruses.length; i++) expect(choruses[i][0] - choruses[i - 1][0]).toBeGreaterThanOrEqual(ROAR_SPACING - 1);
    // by day (18:30–19:30 and after 06:00) a lion calls without roaring
    for (const p of roars) {
      const hour = (18.5 + p.t / 20) % 24;
      expect(hour >= 19.5 || hour < 6, `roar at ${hour.toFixed(2)} h`).toBe(true);
    }
  });
});

describe('penguin colony displays', () => {
  const displays = (n: number, hour: number) => {
    const s = setup({ seed: 6, hour, camDist: 40 });
    for (let i = 0; i < n; i++) s.add(animal('penguin', 30 + (i % 3) * 2, 10 + Math.floor(i / 3) * 2, { habitatId: 4 }));
    s.run(300);
    return s.debug().started.colony;
  };

  it('four or more birds within 15 m display every 30–60 s in their active hours', () => {
    const n = displays(6, 8);
    expect(n).toBeGreaterThanOrEqual(300 / 60 - 1);
    expect(n).toBeLessThanOrEqual(300 / 30);
  });

  it('not with three birds, nor at night', () => {
    expect(displays(3, 8)).toBe(0);
    expect(displays(6, 23)).toBe(0);
  });
});

describe('mid and far views', () => {
  it('reach: close views by distance from the ear, squared; mid views by distance from the focus point, once', () => {
    expect(spontaneousReach(20, 50, 20, 10)).toBeCloseTo(reachFactor(20, 20, 10) ** 2);
    expect(spontaneousReach(50, 20, 52, 10)).toBeCloseTo(reachFactor(20, 52, 10));
  });

  it('calls and displays carry: (refDist / r)^0.75 beyond PRESENCE_CAM', () => {
    // the host's law with the carried reference distance
    const law = (r: number) => {
      const ref = carryRefDist(true, r, 10, 52);
      return ref / Math.max(ref, r);
    };
    expect(law(80)).toBeCloseTo(Math.pow(10 / 80, 0.75));
    expect(law(5)).toBe(1);
    expect(carryRefDist(true, 80, 10, PRESENCE_CAM)).toBe(10);
    expect(carryRefDist(false, 80, 10, 52)).toBe(10);
  });

  it('every habitat in view calls every 12–20 s, and landmark calls sound every 6–10 s with the ambience dip', () => {
    const s = setup({ seed: 7, hour: 11, camDist: 52 });
    for (let i = 0; i < 3; i++) s.add(animal('elephant', -20 + i * 4, 10, { habitatId: 1 }));
    for (let i = 0; i < 4; i++) s.add(animal('zebra', 25 + i * 3, -10, { habitatId: 2 }));
    for (let i = 0; i < 6; i++) s.add(animal('flamingo', 5 + i, 35, { habitatId: 3 }));
    s.run(240);
    const st = s.debug().started;
    expect(st.landmark).toBeGreaterThanOrEqual(240 / 10 - 2);
    expect(st.landmark).toBeLessThanOrEqual(240 / 6 + 1);
    // three habitats, one presence turn each every 12–20 s (a turn is skipped as often as activity says)
    expect(st.presence).toBeGreaterThanOrEqual(10);
    expect(st.presence).toBeLessThanOrEqual((3 * 240) / 12);
    const lm = s.host.plays.filter((p) => p.spec.landmark);
    expect(new Set(lm.map((p) => p.spec.id.split('.')[1])).size).toBe(3);
    // only landmark calls dip the ambience
    for (const p of s.host.plays.filter((p) => p.spec.landmark)) expect(p.spec.pool).toBe('voice');
  });

  it('presence and landmark calls do not set off choruses; far colony birds idle only in the murmur loop', () => {
    const s = setup({ seed: 17, hour: 11, camDist: 52 });
    for (let i = 0; i < 4; i++) s.add(animal('zebra', 20 + i * 3, -10, { habitatId: 2 }));
    // a flamingo flock 40 m from the ear
    for (let i = 0; i < 8; i++) s.add(animal('flamingo', -40 + (i % 4), 10 + Math.floor(i / 4), { habitatId: 3 }));
    s.run(180);
    const st = s.debug().started;
    expect(st.landmark + st.presence).toBeGreaterThan(10);
    expect(st.join).toBeLessThanOrEqual(st.sched + st.sim);
    // flamingo idle honks: none from the far flock (its murmur loop plays instead)
    const flamingoIdles = s.host.plays.filter((p) => p.spec.id.startsWith('syl.flamingo.grunt'));
    expect(flamingoIdles.length).toBe(0);
    expect(s.host.loops.has('colony:3:flamingo')).toBe(true);
  });

  it('idle chatter recedes with the camera height in mid and far views; calls do not', () => {
    const level = (camDist: number, kind: 'idle' | 'call') => {
      const s = setup({ seed: 18, hour: 11, camDist });
      s.host.listener = { ...s.host.listener, zoomNear: camDist >= 90 ? 0 : 1 };
      const z = s.add(animal('zebra', 3, 0));
      for (let i = 0; i < 20; i++) {
        s.run(1);
        s.fauna.force!(z.id, kind);
      }
      // a zebra's idle is a blow, its call a bray
      const syl = kind === 'idle' ? 'syl.zebra.blow' : 'syl.zebra.bray';
      const g = vocal(s.host, z.id)
        .filter((p) => p.spec.id.startsWith(syl))
        .map((p) => lin2db(p.spec.gain!));
      expect(g.length, `${camDist} ${kind}`).toBeGreaterThan(2);
      return g.reduce((a, b) => a + b, 0) / g.length - SPECIES_AUDIO.zebra.levels[kind]!;
    };
    // 40 m (zoomNear 1 here) against the overview: no hover focus in either
    expect(level(90, 'idle') - level(40, 'idle')).toBeLessThan(-9);
    expect(Math.abs(level(90, 'call') - level(40, 'call'))).toBeLessThan(1);
  });

  it('no presence or landmark calls in close views', () => {
    const s = setup({ seed: 8, hour: 11, camDist: 25 });
    for (let i = 0; i < 4; i++) s.add(animal('zebra', 25 + i * 3, -10, { habitatId: 2 }));
    s.run(120);
    expect(s.debug().started.presence).toBe(0);
    expect(s.debug().started.landmark).toBe(0);
  });
});

describe('close-up body sounds', () => {
  const follow = (species: string, o: Partial<AnimalState> = {}, seconds = 120, seed = 9) => {
    const s = setup({ seed, camDist: 6 });
    const a = s.add(animal(species, 2, 0, o));
    s.host.followId = a.id;
    s.run(seconds);
    return { s, a, plays: s.host.plays.filter((p) => p.spec.track === a.id) };
  };

  it('breathes at its family rhythm: an elephant every 9–13 s, a lion every 4–6 s, panting after a run', () => {
    const el = follow('elephant').plays.filter((p) => p.spec.id.startsWith('fx.breath.'));
    expect(el.length).toBeLessThanOrEqual(120 / 9 + 3);
    const lion = follow('lion').plays.filter((p) => p.spec.id.startsWith('fx.breath.'));
    expect(lion.length).toBeGreaterThanOrEqual(120 / 6 - 2);
    expect(lion.length).toBeLessThanOrEqual(120 / 4 + 4);
    // a lion that just ran pants: breaths 1–1.5 s apart
    const s = setup({ seed: 10, camDist: 6 });
    const a = s.add(animal('lion', 2, 0, { action: 'run', speed: 0.1 }));
    s.host.followId = a.id;
    s.run(1);
    a.action = 'idle';
    s.run(6);
    const t = s.host.plays.filter((p) => p.spec.track === a.id && p.spec.id.startsWith('fx.breath.')).map((p) => p.t);
    expect(t.length).toBeGreaterThanOrEqual(4);
  });

  it('a breath sits at least 6 dB under its idle call as heard; pad-footed giants step 8 dB softer', () => {
    for (const sp of ['lion', 'elephant', 'zebra', 'gorilla']) {
      const b = follow(sp).plays.filter((p) => p.spec.id.startsWith('fx.breath.'));
      expect(b.length, sp).toBeGreaterThan(0);
      // under its idle call as heard close up (the focus animal's voice is FAUNA.focusVocalDb forward)
      for (const p of b) expect(lin2db(p.spec.gain!), sp).toBeLessThanOrEqual(SPECIES_AUDIO[sp].levels.idle! + FAUNA.focusVocalDb - FAUNA.breathUnderIdle + 0.01);
    }
    for (const sp of ['elephant', 'hippo', 'rhino']) expect(FOLEY_SPECIES[sp].stepDb, sp).toBeLessThanOrEqual(-8);
    const steps = follow('elephant', { action: 'walk', speed: 1.2 }, 20).plays.filter((p) => p.spec.id.startsWith('fx.step'));
    expect(steps.length).toBeGreaterThan(5);
    for (const p of steps) expect(lin2db(p.spec.gain!)).toBeLessThanOrEqual(STEP_DB + FOLEY_SPECIES.elephant.stepDb! + CLOSE_STEP_DB + 1.5 + 2 + 0.01);
    expect(CLOSE_STEP_MASS).toBeGreaterThan(0);
  });

  it('birds do not breathe: a feather rustle every 8–20 s; a sleeping flamingo grunts softly now and then', () => {
    const awake = follow('penguin', {}, 120).plays;
    expect(awake.filter((p) => p.spec.id.startsWith('fx.breath')).length).toBe(0);
    const rustles = awake.filter((p) => p.spec.id.startsWith('fx.tail') || p.spec.id.startsWith('fx.rustle'));
    expect(rustles.length).toBeGreaterThanOrEqual(120 / RUSTLE_EVERY[1]);
    const asleep = follow('flamingo', { action: 'sleep' }, 240, 11).plays;
    expect(asleep.filter((p) => p.spec.id.startsWith('fx.breath')).length).toBe(0);
    const grunts = asleep.filter((p) => p.spec.id.startsWith('syl.flamingo.grunt'));
    expect(grunts.length).toBeGreaterThan(2);
    for (const p of grunts) expect(lin2db(p.spec.gain!)).toBeLessThanOrEqual(FAUNA.sleepyGruntDb + 1.5 + FAUNA.focusVocalDb + 0.01);
    expect(asleep.filter((p) => p.spec.id.startsWith('syl.') && !p.spec.id.startsWith('syl.flamingo.grunt')).length).toBe(0);
  });

  it('fills silences of a big herbivore from a mixed pool, not with breath alone', () => {
    const { plays } = follow('elephant', {}, 240);
    const kinds = new Set(plays.filter((p) => p.spec.pool === 'foley').map((p) => p.spec.id.replace(/#.*/, '').split('.').slice(0, 2).join('.')));
    for (const k of ['fx.breath', 'fx.flap', 'fx.tail']) expect(kinds.has(k), k).toBe(true);
    const breaths = plays.filter((p) => p.spec.id.startsWith('fx.breath')).length;
    expect(breaths / plays.length).toBeLessThan(0.35);
  });
});

describe("the focus animal's herd", () => {
  const herd = (species: string, seed = 12, seconds = 120) => {
    const s = setup({ seed, camDist: 6, hour: 10 });
    const f = s.add(animal(species, 2, 0, { habitatId: 5 }));
    const mates = Array.from({ length: 6 }, (_, i) => s.add(animal(species, 4 + i * 2, 3, { habitatId: 5 })));
    s.host.followId = f.id;
    s.run(seconds);
    return { s, f, mates };
  };

  it('herd-mates keep talking, 3 dB under the focus animal', () => {
    const { s, f, mates } = herd('penguin');
    const own = vocal(s.host, f.id);
    const theirs = mates.flatMap((m) => vocal(s.host, m.id));
    // colonies: at least 2 mate calls per 10 s
    expect(new Set(theirs.map((p) => p.spec.group)).size).toBeGreaterThanOrEqual(120 / 10 * 2 * 0.75);
    const idle = (list: typeof own) => list.filter((p) => p.spec.id.startsWith('syl.penguin.contact')).map((p) => lin2db(p.spec.gain!));
    const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
    expect(mean(idle(own)) - mean(idle(theirs))).toBeCloseTo(-FAUNA.mateDb, 0);
    expect(s.debug().mates.length).toBe(6);
  });

  it("caps the focus animal's own calls at about 8 a minute and lets a mate answer its contact calls", () => {
    const { s, f } = herd('penguin', 13, 180);
    const own = s.host.plays.filter((p) => p.spec.track === f.id && p.spec.id.startsWith('syl.penguin.contact'));
    expect(new Set(own.map((p) => p.spec.group)).size).toBeLessThanOrEqual((180 / 60) * (FAUNA.focusCallsPerMin + 3));
    expect(s.debug().started.answer).toBeGreaterThanOrEqual(3);
  });

  it("herd-mates' own bouts are capped per minute (answers aside), so the focus animal is not drowned", () => {
    const { s, mates } = herd('zebra', 19, 120);
    const starts = new Set(mates.flatMap((m) => vocal(s.host, m.id)).map((p) => p.spec.group));
    expect(starts.size).toBeLessThanOrEqual((120 / 60) * FAUNA.mateCallsPerMin[1] + s.debug().started.answer + 2);
    // herds: at least one mate call per 15 s
    expect(starts.size).toBeGreaterThanOrEqual(120 / 15);
  });

  it('the share limiter never holds the focus herd back', () => {
    const { s } = herd('flamingo', 14, 180);
    expect(s.debug().shareHeld).toBe(0);
  });
});

/** The syllable of each species' idle bout (a follow start's answer that is not its signature call). */
const IDLE_SYL: Record<string, string> = { lion: 'huff', elephant: 'snort', penguin: 'contact', zebra: 'blow', tiger: 'prusten' };

describe('signature moments', () => {
  it('signature bouts: a lion calls, an elephant rumbles or trumpets, a penguin displays in its active hours, a lying giraffe hums at night', () => {
    const rng = new Rng(1);
    const m = { action: 'idle', sex: 'M' as const };
    expect(signatureBout(SPECIES_AUDIO.lion, m, 12, 0, rng)!.kind).toBe('call');
    const el = new Set(Array.from({ length: 50 }, () => signatureBout(SPECIES_AUDIO.elephant, m, 12, 0, rng)!.kind));
    expect([...el].sort()).toEqual(['call', 'contact']);
    expect(signatureBout(SPECIES_AUDIO.penguin, m, 8, 0, rng)!.kind).toBe('call');
    expect(signatureBout(SPECIES_AUDIO.penguin, m, 23, 1, rng)!.kind).toBe('contact');
    expect(signatureBout(SPECIES_AUDIO.gorilla, m, 12, 0, rng)!.kind).toBe('display');
    expect(signatureBout(SPECIES_AUDIO.giraffe, { action: 'sleep', sex: 'M' }, 23, 1, rng)!.kind).toBe('night');
  });

  it('the followed animal makes its signature call at least twice a minute by day', () => {
    for (const sp of ['lion', 'elephant', 'penguin', 'zebra', 'tiger']) {
      let ok = 0;
      for (let seed = 1; seed <= 5; seed++) {
        const s = setup({ seed, camDist: 6, hour: sp === 'penguin' ? 8 : 11 });
        const a = s.add(animal(sp, 2, 0));
        s.host.followId = a.id;
        s.run(60);
        // signature moments, plus the follow start's answer when it was the signature call
        const answered = vocal(s.host, a.id).some((p) => p.t < 1.5 && !p.spec.id.includes(IDLE_SYL[sp]));
        if (s.debug().started.signature + (answered ? 1 : 0) >= 2) ok++;
      }
      expect(ok, sp).toBeGreaterThanOrEqual(4);
    }
  });

  it('a giraffe lying at night hums at least twice a minute', () => {
    const s = setup({ seed: 15, camDist: 6, hour: 23 });
    const g = s.add(animal('giraffe', 2, 0, { action: 'sleep' }));
    s.host.followId = g.id;
    s.run(60);
    expect(vocal(s.host, g.id).filter((p) => p.spec.id.startsWith('syl.giraffe.hum')).length).toBeGreaterThanOrEqual(2);
    expect(vocal(s.host, g.id).filter((p) => p.spec.id.startsWith('syl.giraffe.snort')).length).toBe(0);
  });

  it('a tap or a follow start is answered with the signature call most of the time', () => {
    let calls = 0;
    const n = 40;
    for (let seed = 1; seed <= n; seed++) {
      // a close view without presence or landmark calls, the zebra not under the camera
      const s = setup({ seed, camDist: 25 });
      const z = s.add(animal('zebra', 20, 0));
      s.run(0.5);
      s.events.emit('selectionChanged', { selection: { kind: 'animal', id: z.id } });
      s.run(1);
      if (vocal(s.host, z.id).some((p) => p.spec.id.startsWith('syl.zebra.bray'))) calls++;
    }
    expect(calls / n).toBeGreaterThan(0.45);
    expect(calls / n).toBeLessThan(0.85);
  });

  it("the focus animal's roars and displays get no focus boost", () => {
    const s = setup({ seed: 16, camDist: 40, hour: 22 });
    s.host.nightness = 1;
    const g = s.add(animal('gorilla', 3, 0));
    s.host.followId = g.id;
    let forced = false;
    for (let i = 0; i < 40 && !forced; i++) {
      s.run(0.5);
      forced = s.fauna.force!(g.id, 'display');
    }
    expect(forced).toBe(true);
    s.run(15);
    const hoots = vocal(s.host, g.id).filter((p) => p.spec.id.startsWith('syl.gorilla.hoot'));
    expect(hoots.length).toBeGreaterThan(2);
    for (const p of hoots) expect(lin2db(p.spec.gain!)).toBeLessThanOrEqual(SPECIES_AUDIO.gorilla.levels.display! + 1.5 + 3.01);
  });
});

describe('focus precedence', () => {
  it('follow > selected within 25 m > resting at the focus point > nearest under a hovering camera', () => {
    const s = setup({ camDist: 12 });
    const rest = s.add(animal('lion', 0.5, 0.5));
    const sel = s.add(animal('lion', 8, 0));
    const far = s.add(animal('lion', 60, 0));
    s.run(3);
    // resting at the screen centre for 2 s: auto-follow
    expect(s.debug().focusId).toBe(rest.id);
    s.events.emit('selectionChanged', { selection: { kind: 'animal', id: sel.id } });
    s.run(0.3);
    expect(s.debug().focusId).toBe(sel.id);
    s.events.emit('selectionChanged', { selection: { kind: 'animal', id: far.id } });
    s.run(0.3);
    expect(s.debug().focusId).toBe(rest.id);
    s.host.followId = far.id;
    s.run(0.3);
    expect(s.debug().focusId).toBe(far.id);
  });

  it('a hover focus changes hands only when another animal is 3 m nearer for 2 s (at most once per 10 s), and ends beyond 18 m', () => {
    const h = new HoverFocus();
    expect(h.update(0.1, 1, 5, Infinity)).toBe(1);
    // a clear rival in the first HOVER_MIN s: the focus holds
    for (let t = 0; t < HOVER_MIN - 0.5; t += 0.1) expect(h.update(0.1, 3, 1, 5)).toBe(1);
    // another one 2 m nearer: stays
    for (let t = 0; t < 5; t += 0.1) expect(h.update(0.1, 2, 3, 5)).toBe(1);
    // 3 m nearer, but not for long enough
    for (let t = 0; t < HANDOVER_HOLD - 0.3; t += 0.1) expect(h.update(0.1, 2, 2, 5)).toBe(1);
    h.update(0.1, 1, 5, 5);
    for (let t = 0; t < HANDOVER_HOLD - 0.05; t += 0.1) h.update(0.1, 2, 2, 5);
    expect(h.update(0.1, 2, 2, 5)).toBe(2);
    // the focus wanders off beyond HOVER_KEEP with nobody near
    expect(h.update(0.1, -1, Infinity, HOVER_KEEP + 1)).toBe(-1);
  });
});
