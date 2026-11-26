// Fauna module (src/audio/modules/fauna.ts) and its pure helpers against a
// FakeHost and a stub sim: bout grammar, variants, individual voices, the diel
// scheduler, contagion, the idle lottery, colony murmur and reactions.
import { describe, expect, it } from 'vitest';
import type { ISimulation } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import { PathType, Terrain, type AnimalState } from '../src/core/types';
import { boutSpan, individual, MAX_JOINERS, planBout, planJoins, VariantPicker, type BoutItem } from '../src/audio/fauna/bout';
import { activityAt, colonyLevel, idleWeight, pickKind, pickWeighted } from '../src/audio/fauna/diel';
import { createFauna, FAUNA } from '../src/audio/modules/fauna';
import { SPECIES_AUDIO, type Bout } from '../src/audio/recipes';
import { FakeHost } from './helpers/fakeHost';

// ------------------------------------------------------------------ stubs

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

interface Stub {
  sim: ISimulation;
  events: EventBus;
  host: FakeHost;
  add(a: AnimalState): AnimalState;
}

function setup(o: { seed?: number; terrain?: Terrain; path?: PathType; lowSpec?: boolean } = {}): Stub & { fauna: ReturnType<typeof createFauna> } {
  const events = new EventBus();
  const animals = new Map<number, AnimalState>();
  const sim = {
    animals,
    guests: new Map(),
    speed: 1,
    events,
    world: { getTerrain: () => o.terrain ?? Terrain.Grass, getPath: () => o.path ?? PathType.None },
  } as unknown as ISimulation;
  const host = new FakeHost({ sim, events, lowSpec: o.lowSpec });
  // ear on the ground plane at the origin, close camera
  host.listener = { x: 0, y: 1, z: 0, fx: 0, fz: 0, camDist: 30, zoomNear: 0.8 };
  const fauna = createFauna(host, o.seed ?? 1);
  return {
    sim,
    events,
    host,
    fauna,
    add(a) {
      animals.set(a.id, a);
      return a;
    },
  };
}

function run(s: Stub & { fauna: ReturnType<typeof createFauna> }, seconds: number, dt = 0.05, each?: () => void): void {
  for (let t = 0; t < seconds; t += dt) {
    s.host.advance(dt);
    each?.();
    s.fauna.update(dt);
  }
}

const sylPlays = (h: FakeHost, track?: number) => h.plays.filter((p) => p.spec.id.startsWith('syl.') && (track === undefined || p.spec.track === track));
const nightness = (h: number) => (h < 12 ? 1 - smooth(4.6, 5.9, h) : smooth(19.6, 21.2, h));
function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
const pct = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) * p)];

// ------------------------------------------------------------------ A1-9 planner

describe('planBout', () => {
  const lion = SPECIES_AUDIO.lion;
  const call = lion.bouts.find((b) => b.kind === 'call')!;
  const dur = (sp: typeof lion) => (syl: string) => sp.syllables[syl].dur;

  it('plans lion call series of 25–45 s with slowing, fading grunts', () => {
    const spans: number[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const items = planBout(lion, call, new Rng(seed), dur(lion));
      spans.push(boutSpan(items, dur(lion)));
      const grunts = items.filter((i) => i.syl === 'grunt');
      expect(grunts.length).toBeGreaterThanOrEqual(13);
      const iois = grunts.slice(1).map((g, i) => g.t - grunts[i].t);
      expect(iois[0]).toBeGreaterThanOrEqual(0.81);
      expect(iois[iois.length - 1]).toBeLessThanOrEqual(2.1);
      // non-decreasing within the ±10 % jitter
      for (let i = 1; i < iois.length; i++) expect(iois[i]).toBeGreaterThanOrEqual(iois[i - 1] * (0.9 / 1.1) - 1e-9);
      for (let i = 1; i < grunts.length; i++) expect(grunts[i].db).toBeLessThan(grunts[i - 1].db);
    }
    expect(pct(spans, 0.05)).toBeGreaterThanOrEqual(25);
    expect(pct(spans, 0.95)).toBeLessThanOrEqual(45);
  });

  it('plans zebra cycles and hippo honk series by their grammar', () => {
    const zebra = SPECIES_AUDIO.zebra;
    const hippo = SPECIES_AUDIO.hippo;
    for (let seed = 1; seed <= 100; seed++) {
      const z = planBout(zebra, zebra.bouts.find((b) => b.kind === 'call')!, new Rng(seed), dur(zebra)).filter((i) => i.syl === 'cycle');
      const iois = z.slice(1).map((g, i) => g.t - z[i].t);
      expect(iois[0]).toBeGreaterThanOrEqual(0.42);
      expect(iois[0]).toBeLessThanOrEqual(0.46);
      expect(iois[iois.length - 1]).toBeLessThanOrEqual(0.55 * 1.1);
      const honks = planBout(hippo, hippo.bouts.find((b) => b.kind === 'call')!, new Rng(seed), dur(hippo)).filter((i) => i.syl === 'honk');
      expect(honks.length).toBeGreaterThanOrEqual(4);
      expect(honks.length).toBeLessThanOrEqual(10);
    }
  });

  it('starts each step after the previous syllable ends', () => {
    const steps: Bout = {
      kind: 'call',
      steps: [
        { syl: 'moan', n: [1, 1], ioi: [1, 1] },
        { syl: 'roar', n: [1, 1], ioi: [1, 1], gap: [0.5, 0.5] },
      ],
    };
    const items: BoutItem[] = planBout(lion, steps, new Rng(3), () => 2);
    expect(items.map((i) => i.t)).toEqual([0, 2.5]);
  });
});

describe('variants and individual voices', () => {
  it('never plays the same variant of a syllable twice in a row', () => {
    const s = setup();
    const a = s.add(animal('flamingo', 5, 0));
    for (let i = 0; i < 100; i++) {
      s.fauna.force!(a.id, 'call');
      run(s, 6);
    }
    const last = new Map<string, string>();
    let checked = 0;
    for (const p of sylPlays(s.host)) {
      const bank = p.spec.id.replace(/#\d+$/, '');
      if (last.get(bank) === p.spec.id) throw new Error(`repeat ${p.spec.id}`);
      last.set(bank, p.spec.id);
      checked++;
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('rarely replays a variant at nearly the same rate within 10 s, even across a chorus', () => {
    const s = setup({ seed: 5 });
    const pride = [0, 1, 2, 3].map((i) => s.add(animal('lion', 20 + i, 3, { sex: i ? 'F' : 'M' })));
    s.host.hour = 21;
    s.host.nightness = 1;
    for (let k = 0; k < 4; k++) {
      // the male roars, up to two lionesses join (contagion)
      s.fauna.force!(pride[0].id, 'call');
      run(s, 60);
    }
    const plays = sylPlays(s.host);
    expect(plays.length).toBeGreaterThan(100);
    let repeats = 0;
    for (let j = 0; j < plays.length; j++) {
      const clash = plays.some((p, i) => i < j && plays[j].t - p.t < 10 && p.spec.id === plays[j].spec.id && Math.abs(plays[j].spec.rate! / p.spec.rate! - 1) <= 0.03);
      if (clash) repeats++;
    }
    expect(repeats).toBeLessThanOrEqual(5);
    expect(s.fauna.debug!().repeated).toBe(repeats);
  });

  it('gives each animal its own pitch and colour, kept for life', () => {
    const lion = SPECIES_AUDIO.lion;
    const a = individual(lion, 101, 'M');
    const b = individual(lion, 202, 'M');
    expect(a.pitch).not.toBe(b.pitch);
    expect(a.color.hz).not.toBe(b.color.hz);
    expect(individual(lion, 101, 'M')).toEqual(a);
    expect(individual(lion, 101, 'F').db).toBe(-3);
    const s = setup();
    const x = s.add(animal('elephant', 4, 0));
    for (let i = 0; i < 5; i++) {
      s.fauna.force!(x.id, 'idle');
      run(s, 3);
    }
    // every play gets its own slight colour around the individual's, in the 1–3 kHz presence range
    const plays = sylPlays(s.host, x.id);
    const ind = individual(SPECIES_AUDIO.elephant, x.seed, x.sex);
    const centre = Math.min(3000, Math.max(1000, ind.color.hz));
    for (const p of plays) {
      expect(p.spec.color!.hz / centre).toBeGreaterThanOrEqual(0.92);
      expect(p.spec.color!.hz / centre).toBeLessThanOrEqual(1.08);
      expect(Math.abs(p.spec.color!.db - ind.color.db)).toBeLessThanOrEqual(2);
    }
    expect(new Set(plays.map((p) => JSON.stringify(p.spec.color))).size).toBe(plays.length);
  });

  it('keeps juveniles at most 12 % higher', () => {
    const s = setup();
    const cub = s.add(animal('lion', 5, 0, { growth: 0.2, sex: 'F' }));
    const calf = s.add(animal('giraffe', -5, 0, { growth: 0.1 }));
    for (let i = 0; i < 20; i++) {
      s.fauna.force!(cub.id, 'idle');
      s.fauna.force!(calf.id, 'idle');
      run(s, 4);
    }
    const plays = sylPlays(s.host);
    expect(plays.length).toBeGreaterThan(20);
    for (const p of plays) expect(p.spec.rate!).toBeLessThanOrEqual(1.12);
    expect(plays.some((p) => p.spec.id.startsWith('syl.lion.juv'))).toBe(true);
  });

  it('picks among rendered variants only and requests the next one', () => {
    const picker = new VariantPicker();
    const ready = new Set(['b#0', 'b#1']);
    const seen = new Set<string>();
    const rng = new Rng(4);
    for (let i = 0; i < 20; i++) seen.add(picker.pick('b', 4, (id) => ready.has(id), rng)!);
    expect([...seen].sort()).toEqual(['b#0', 'b#1']);
    expect(picker.missing('b', 4, (id) => ready.has(id))).toBe('b#2');
  });
});

describe('warm-up and lowSpec', () => {
  it('warms the #0 syllables, colony loop and feet of the species present, once', () => {
    const s = setup();
    s.add(animal('flamingo', 5, 0));
    s.add(animal('flamingo', 6, 0));
    s.add(animal('lion', 9, 0));
    const ids = s.fauna.warm!();
    expect(new Set(ids).size).toBe(ids.length);
    for (const syl of Object.keys(SPECIES_AUDIO.lion.syllables)) expect(ids).toContain(`syl.lion.${syl}#0`);
    expect(ids).toContain('loop.colony.flamingo');
    expect(ids).toContain('fx.step.pad#0');
    expect(ids.some((id) => /#[1-9]$/.test(id) && id.startsWith('syl.'))).toBe(false);
  });

  it('uses two variants and two bouts at most on lowSpec', () => {
    const s = setup({ lowSpec: true });
    const birds = [0, 1, 2, 3].map((i) => s.add(animal('flamingo', 5 + i, 0)));
    for (let k = 0; k < 20; k++) {
      for (const b of birds) s.fauna.force!(b.id, 'call');
      expect(s.fauna.debug!().bouts).toBeLessThanOrEqual(FAUNA.maxBouts[1]);
      run(s, 3);
    }
    const ids = new Set(sylPlays(s.host).map((p) => p.spec.id));
    expect([...ids].every((id) => /#[01]$/.test(id))).toBe(true);
  });

  it('warms and plays only the family breath / chew / drink banks, one variant of each on lowSpec', () => {
    for (const lowSpec of [false, true]) {
      const s = setup({ seed: 5, lowSpec });
      const lion = s.add(animal('lion', 3, 0));
      const ids = s.fauna.warm!();
      expect(ids).not.toContain('fx.breath.big#0');
      expect(ids).not.toContain('fx.lap#0');
      expect(ids).toContain('fx.breath.cat#0');
      s.host.followId = lion.id;
      s.host.listener = { x: 0, y: 1, z: 0, fx: 3, fz: 0, camDist: 6, zoomNear: 1 };
      const actions = ['idle', 'eat', 'drink', 'sleep'] as const;
      for (let k = 0; k < 16; k++) {
        lion.action = actions[k % actions.length];
        lion.actionTime = 0;
        run(s, 4);
      }
      const fam = s.host.plays.map((p) => p.spec.id).filter((id) => /^fx\.(breath|chew|drink)\./.test(id));
      expect(fam.length).toBeGreaterThan(10);
      expect(fam.every((id) => /^fx\.(breath|chew|drink)\.cat#\d$/.test(id))).toBe(true);
      const variants = new Set(fam.map((id) => id.split('#')[1]));
      if (lowSpec) expect([...variants]).toEqual(['0']);
      else expect(variants.size).toBeGreaterThan(1);
    }
  });
});

describe('bout runtime', () => {
  it('starts a call bout on a sim call action within range, and aborts when the animal runs', () => {
    const s = setup();
    const a = s.add(animal('lion', 20, 0));
    run(s, 1);
    a.action = 'call';
    a.actionTime = 0.2;
    run(s, 3);
    expect((s.fauna.debug!().started as Record<string, number>).sim).toBe(1);
    const before = sylPlays(s.host, a.id).length;
    a.action = 'run';
    run(s, 10);
    expect(sylPlays(s.host, a.id).length).toBe(before);
    expect(s.fauna.debug!().bouts).toBe(0);
  });

  it('keeps at most 3 bouts and drops bouts whose animal is removed', () => {
    const s = setup();
    const lions = [0, 1, 2, 3, 4].map((i) => s.add(animal('lion', 10 + i, 0)));
    for (const l of lions) s.fauna.force!(l.id, 'call');
    // forced bouts may replace each other, but never exceed the limit
    expect(s.fauna.debug!().bouts).toBeLessThanOrEqual(FAUNA.maxBouts[0]);
    run(s, 2);
    for (const l of lions) {
      s.sim.animals.delete(l.id);
      s.events.emit('animalRemoved', { id: l.id });
    }
    run(s, 1);
    expect(s.fauna.debug!().bouts).toBe(0);
  });

  it('starts no bouts while the sim is paused', () => {
    const s = setup();
    for (let i = 0; i < 6; i++) s.add(animal('flamingo', 5 + i, 0));
    s.sim.speed = 0;
    run(s, 120);
    expect(s.host.plays.length).toBe(0);
  });
});

// ------------------------------------------------------------------ A1-10 diel

describe('diel scheduler', () => {
  it('interpolates activity between hours', () => {
    const lion = SPECIES_AUDIO.lion;
    expect(activityAt(lion, 19)).toBeCloseTo(lion.activity[19]);
    expect(activityAt(lion, 18.5)).toBeCloseTo((lion.activity[18] + lion.activity[19]) / 2);
    expect(activityAt(lion, 23.5)).toBeCloseTo((lion.activity[23] + lion.activity[0]) / 2);
  });

  it('makes lions roar mostly at night', () => {
    let night = 0;
    let day = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const s = setup({ seed });
      for (let i = 0; i < 6; i++) s.add(animal('lion', 20 + i * 3, 10, { sex: i ? 'F' : 'M', action: i % 2 ? 'sleep' : 'idle' }));
      const perHour = new Array<number>(24).fill(0);
      let prev = 0;
      for (let t = 0; t < 24 * 3600; t++) {
        const hour = (t / 3600) % 24;
        s.host.hour = hour;
        s.host.nightness = nightness(hour);
        s.host.advance(1);
        s.fauna.update(1);
        const n = (s.fauna.debug!().started as Record<string, number>).sched;
        perHour[Math.floor(hour)] += n - prev;
        prev = n;
      }
      for (const h of [19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5]) night += perHour[h] / 11;
      for (let h = 7; h <= 18; h++) day += perHour[h] / 12;
    }
    expect(night).toBeGreaterThanOrEqual(4 * day);
  });

  it('lets lying giraffes hum at night, never by day', () => {
    const s = setup({ seed: 3 });
    for (let i = 0; i < 4; i++) s.add(animal('giraffe', 10 + i * 4, 5, { action: 'sleep' }));
    const hums = new Array<number>(24).fill(0);
    let seen = 0;
    for (let t = 0; t < 24 * 3600; t++) {
      const hour = (t / 3600) % 24;
      s.host.hour = hour;
      s.host.nightness = nightness(hour);
      s.host.advance(1);
      s.fauna.update(1);
      const plays = s.host.plays;
      for (; seen < plays.length; seen++) if (plays[seen].spec.id.startsWith('syl.giraffe.hum')) hums[Math.floor(hour)]++;
    }
    for (let h = 6; h < 19; h++) expect(hums[h], `hour ${h}`).toBe(0);
    for (const h of [21, 22, 23, 0, 1, 2, 3, 4]) expect(hums[h], `hour ${h}`).toBeGreaterThanOrEqual(1);
  });

  it('picks the night bout only when it may', () => {
    const g = SPECIES_AUDIO.giraffe;
    const rng = new Rng(1);
    expect(pickKind(g, 1, { action: 'sleep', sex: 'F' }, rng, 2)?.kind).toBe('night');
    expect(pickKind(g, 1, { action: 'walk', sex: 'F' }, rng, 2)?.kind).not.toBe('night');
    expect(pickKind(g, 1, { action: 'sleep', sex: 'F' }, rng, 12)?.kind).not.toBe('night');
    expect(pickKind(g, 0, { action: 'sleep', sex: 'F' }, rng, 2)?.kind).toBe('call');
  });

  it('is silent with no animal in range', () => {
    const s = setup();
    for (let i = 0; i < 6; i++) s.add(animal('lion', 600 + i, 600));
    s.host.hour = 21;
    s.host.nightness = 1;
    run(s, 600, 0.5);
    expect(s.host.plays.length).toBe(0);
  });
});

// ------------------------------------------------------------------ A1-11 contagion, idles, follow

describe('contagion', () => {
  it('at most 2 lionesses join a roar, after 2–8 s, any of the pride', () => {
    const con = SPECIES_AUDIO.lion.contagion!;
    const rng = new Rng(9);
    let joins = 0;
    const who = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const j = planJoins(con, [1, 2, 3, 4], rng);
      joins += j.length;
      expect(j.length).toBeLessThanOrEqual(MAX_JOINERS);
      for (const x of j) {
        who.add(x.id);
        expect(x.delay).toBeGreaterThanOrEqual(2);
        expect(x.delay).toBeLessThanOrEqual(8);
      }
    }
    expect(joins / 1000).toBeGreaterThan(1.5);
    expect([...who].sort()).toEqual([1, 2, 3, 4]);
  });

  it('offers every eligible pride member a join, and joins never spread further', () => {
    let planned = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = setup({ seed });
      const male = s.add(animal('lion', 20, 0));
      for (let i = 0; i < 4; i++) s.add(animal('lion', 20 + i * 2, 4, { sex: 'F' }));
      s.fauna.force!(male.id, 'call');
      planned += s.fauna.debug!().joinsPlanned as number;
      // joins are planned only in steps where a bout other than a join started
      let prev = s.fauna.debug!();
      for (let t = 0; t < 60; t += 0.05) {
        s.host.advance(0.05);
        s.fauna.update(0.05);
        const d = s.fauna.debug!();
        const st = d.started as Record<string, number>;
        const pst = prev.started as Record<string, number>;
        const others = (x: Record<string, number>) => x.sched + x.sim + x.idle + x.react + x.force;
        if (d.joinsPlanned !== prev.joinsPlanned) expect(others(st)).toBeGreaterThan(others(pst));
        prev = d;
      }
    }
    expect(planned / 40).toBeGreaterThan(1.6);
    expect(planned / 40).toBeLessThan(3.2);
  });
});

describe('idle lottery', () => {
  it('favours the animal near the ear', () => {
    const near = { d: 5 };
    const far = Array.from({ length: 10 }, () => ({ d: 40 }));
    const all = [near, ...far];
    const rng = new Rng(5);
    let n = 0;
    for (let i = 0; i < 2000; i++) if (pickWeighted(all, (x) => idleWeight(0.5, x.d), rng) === near) n++;
    expect(n / 2000).toBeGreaterThanOrEqual(0.4);
  });

  it('never breaks the per-animal cooldown or the per-species gap', () => {
    // camels: no contagion; their idle-lottery bouts (idle, social) are grumbles
    const s = setup({ seed: 11 });
    const near = s.add(animal('camel', 5, 0));
    for (let i = 0; i < 10; i++) s.add(animal('camel', 40 * Math.cos(i), 40 * Math.sin(i)));
    run(s, 1800, 0.1);
    const starts = new Map<number, { t: number; track: number }>();
    for (const p of s.host.plays)
      if (p.spec.id.startsWith('syl.camel.grumble') && !starts.has(p.spec.group!)) starts.set(p.spec.group!, { t: p.t, track: p.spec.track! });
    const list = [...starts.values()].sort((a, b) => a.t - b.t);
    expect(list.length).toBeGreaterThan(50);
    const lastBy = new Map<number, number>();
    for (let i = 0; i < list.length; i++) {
      if (i) expect(list[i].t - list[i - 1].t).toBeGreaterThanOrEqual(FAUNA.speciesGap - 1e-6);
      const prev = lastBy.get(list[i].track);
      if (prev !== undefined) expect(list[i].t - prev).toBeGreaterThanOrEqual(FAUNA.idleCooldown - 1e-6);
      lastBy.set(list[i].track, list[i].t);
    }
    // the cooldown caps the near camel at one idle per 12 s: it still gets far more than its 1/11 share
    expect(list.filter((x) => x.track === near.id).length / list.length).toBeGreaterThan(0.2);
  });

  it('makes the followed, selected or close-up animal sound alive', () => {
    for (const mode of ['follow', 'select', 'near'] as const) {
      const s = setup({ seed: 21 });
      const el = s.add(animal('elephant', 3, 0, { action: 'idle' }));
      for (let i = 0; i < 8; i++) s.add(animal('elephant', 25 + i * 3, 10, { action: 'idle' }));
      for (let i = 0; i < 6; i++) s.add(animal('zebra', -25 - i * 3, 10, { action: 'idle' }));
      if (mode === 'follow') s.host.followId = el.id;
      if (mode === 'select') s.events.emit('selectionChanged', { selection: { kind: 'animal', id: el.id } });
      s.host.listener = { x: 0, y: 3, z: 3, fx: 0, fz: 0, camDist: mode === 'near' ? 10 : 30, zoomNear: 0.9 };
      run(s, 300, 0.1);
      const mine = s.host.plays.filter((p) => p.spec.track === el.id).map((p) => p.t);
      // some sound (vocal or foley) from that elephant at least every 15 s on average
      expect(300 / mine.length, mode).toBeLessThanOrEqual(15);
      expect(s.host.plays.filter((p) => p.spec.track === el.id && p.spec.pool === 'foley').length, mode).toBeGreaterThan(10);
    }
  });

  it('detects a camera that keeps an animal at its focus as following it', () => {
    const s = setup();
    const z = s.add(animal('zebra', 0.5, 0.5));
    run(s, 3, 0.1);
    expect(s.fauna.debug!().followId).toBe(z.id);
  });
});

// ------------------------------------------------------------------ A1-12 colony

describe('colony murmur', () => {
  it('scales with the square root of the colony and drops at night', () => {
    const f = SPECIES_AUDIO.flamingo;
    const l3 = colonyLevel(f, 3, 12, 0, 1);
    const l12 = colonyLevel(f, 12, 12, 0, 1);
    expect(Math.abs(l3 / l12 - 0.5)).toBeLessThanOrEqual(0.02);
    expect(colonyLevel(f, 12, 12, 1, 1)).toBeCloseTo(l12 * f.colony!.night);
    expect(colonyLevel(f, 0, 12, 0, 1)).toBe(0);
  });

  it('runs one loop per colony habitat and stops it when the habitat empties', () => {
    const s = setup();
    const birds = [0, 1, 2, 3, 4].map((i) => s.add(animal('flamingo', 10 + i, 5)));
    run(s, 1);
    const key = 'colony:1:flamingo';
    expect(s.host.loops.get(key)?.id).toBe('loop.colony.flamingo');
    expect(s.host.loops.get(key)!.level).toBeGreaterThan(0);
    for (const b of birds) s.sim.animals.delete(b.id);
    run(s, 1);
    expect(s.host.loops.get(key)!.level).toBe(0);
  });
});

// ------------------------------------------------------------------ A1-15 reactions

describe('reactions', () => {
  it('a placed animal speaks once, 0.8–1.5 s later', () => {
    const s = setup();
    const a = s.add(animal('zebra', 6, 0));
    s.events.emit('animalAdded', { id: a.id });
    s.events.emit('animalPlaced', { id: a.id, x: a.x, z: a.z });
    const t0 = s.host.time;
    run(s, 5);
    const starts = new Set(sylPlays(s.host, a.id).map((p) => p.spec.group));
    expect(starts.size).toBe(1);
    const first = sylPlays(s.host, a.id)[0].t - t0;
    expect(first).toBeGreaterThanOrEqual(0.8);
    expect(first).toBeLessThanOrEqual(1.5 + 0.25);
  });

  it('a second selection within 6 s does not react again', () => {
    let reacted = 0;
    const reacts = (s: ReturnType<typeof setup>) => (s.fauna.debug!().started as Record<string, number>).react;
    for (let seed = 1; seed <= 20; seed++) {
      const s = setup({ seed });
      const a = s.add(animal('gorilla', 6, 0));
      const sel = { selection: { kind: 'animal' as const, id: a.id } };
      s.events.emit('selectionChanged', sel);
      run(s, 2);
      const n = reacts(s);
      reacted += n;
      s.events.emit('selectionChanged', { selection: null });
      s.events.emit('selectionChanged', sel);
      run(s, 2);
      expect(reacts(s)).toBe(n);
    }
    // p 0.7 per selection
    expect(reacted).toBeGreaterThan(8);
  });

  it('a birth plays the baby (≤ 1.12 rate), then its mother', () => {
    const s = setup();
    const mum = s.add(animal('elephant', 8, 0, { sex: 'F' }));
    run(s, 1);
    const baby = s.add(animal('elephant', 8, 1, { growth: 0.2 }));
    s.events.emit('animalAdded', { id: baby.id });
    run(s, 4);
    const b = sylPlays(s.host, baby.id);
    expect(b.length).toBeGreaterThan(0);
    expect(b[0].spec.id).toMatch(/^syl\.elephant\.juv#/);
    for (const p of b) expect(p.spec.rate!).toBeLessThanOrEqual(1.12);
    expect(sylPlays(s.host, mum.id).length).toBeGreaterThan(0);
  });

  it('an escape sounds the alarm within 0.2 s', () => {
    const s = setup();
    const a = s.add(animal('tiger', 10, 0));
    run(s, 1);
    a.escaped = true;
    a.action = 'run';
    const t0 = s.host.time;
    run(s, 1, 0.02);
    const p = sylPlays(s.host, a.id);
    expect(p.length).toBeGreaterThan(0);
    expect(p[0].t - t0).toBeLessThanOrEqual(0.2);
    expect(p[0].spec.id).toMatch(/^syl\.tiger\.(hiss|growl)#/);
  });
});
