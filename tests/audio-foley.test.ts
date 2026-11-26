// Animal and guest foley: the fx.* recipes (registry, memory budget) and the
// fauna module's foley triggers (step cadence, limits, drinking, guest steps).
import { describe, expect, it } from 'vitest';
import type { ISimulation } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { PathType, Terrain, type AnimalState, type GuestState } from '../src/core/types';
import { FEET_BANK, FOLEY_FAMILY, FOLEY_SPECIES, FoleyLimiter, foleyBankFor, guestCadence, guestStepBank, stepCrossings } from '../src/audio/fauna/foley';
import { FAUNA, createFauna } from '../src/audio/modules/fauna';
import { RECIPES } from '../src/audio/recipes';
import { FOLEY_BANKS, FOLEY_RECIPES, LAP_SPACING } from '../src/audio/recipes/foley';
import type { Recipe } from '../src/audio/render';
import { SPECIES } from '../src/data/species';
import { FakeHost } from './helpers/fakeHost';

const bytes = (r: Recipe) => (r.dur + (r.tail ?? 0.6)) * (r.rate ?? 22050) * 4;
const KINDS = ['breath', 'chew', 'drink'] as const;
const FAMILIES = [...new Set(Object.values(FOLEY_FAMILY))];
/** A per-family close-up bank: fx.breath.cat#2, fx.drink.bird#0, fx.rustle.bird#1... */
const isFamily = (id: string) => /^fx\.(breath|chew|drink|rustle)\.[a-z]+#\d+$/.test(id) && !id.startsWith('fx.breath.big');
/** Birds do not breathe audibly: in place of a breath they ruffle their feathers. */
const kindFor = (kind: (typeof KINDS)[number], voice: string) => (kind === 'breath' && !FOLEY_SPECIES[voice].breathEvery ? 'rustle' : kind);

describe('foley recipes', () => {
  it('registers every bank as fx.* ids with a short tail and capped peak', () => {
    for (const [base, n] of Object.entries(FOLEY_BANKS)) {
      const ids = n ? Array.from({ length: n }, (_, k) => `${base}#${k}`) : [base];
      for (const id of ids) {
        expect(RECIPES[id], id).toBe(FOLEY_RECIPES[id]);
        expect(RECIPES[id].tail, id).toBeLessThanOrEqual(0.2);
        expect(RECIPES[id].peak, id).toBeLessThanOrEqual(0.7);
        expect(RECIPES[id].reverb, id).toBeUndefined();
      }
    }
    expect(Object.keys(FOLEY_RECIPES).every((id) => id.startsWith('fx.'))).toBe(true);
  });

  it('fits the memory budget: animal foley ≤ 0.75 MB, guest steps ≤ 0.3 MB, family close-ups ≤ 0.45 MB each, all ≤ 3.72 MB (A2)', () => {
    let animal = 0;
    let guest = 0;
    const family: Record<string, number> = {};
    const warm: Record<string, number> = {};
    for (const [id, r] of Object.entries(FOLEY_RECIPES)) {
      if (id.startsWith('fx.gstep.')) guest += bytes(r);
      else if (isFamily(id)) {
        const f = id.split('.')[2].split('#')[0];
        family[f] = (family[f] ?? 0) + bytes(r);
        if (id.endsWith('#0')) warm[f] = (warm[f] ?? 0) + bytes(r);
      } else animal += bytes(r);
    }
    // the scuff, ear flap and tail banks grew; dropping the bird breath (0.2 MB) pays for them
    expect(animal).toBeLessThanOrEqual(0.75e6);
    expect(guest).toBeLessThanOrEqual(0.3e6);
    expect(animal + guest + Object.values(family).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3.72e6);
    // every variant of one family; the #0 breath, chew and drink the fauna module warms
    for (const f of FAMILIES) {
      expect(family[f], f).toBeLessThanOrEqual(0.45e6);
      expect(warm[f], f).toBeLessThanOrEqual(0.15e6);
    }
  });

  it('gives every body family its own breath (birds: feather rustle), chew and drink banks, rendered for phones', () => {
    const registered = (id: string) => id in RECIPES;
    for (const [voice, f] of Object.entries(FOLEY_FAMILY))
      for (const kind of KINDS) {
        const k = kindFor(kind, voice);
        const base = foleyBankFor(k, voice, registered) as keyof typeof FOLEY_BANKS;
        expect(base, `${voice} ${k}`).toBe(`fx.${k}.${f}`);
        expect(FOLEY_BANKS[base], base).toBeGreaterThanOrEqual(3);
        for (let v = 0; v < FOLEY_BANKS[base]; v++) {
          const r = FOLEY_RECIPES[`${base}#${v}`];
          // presence at 1–5 kHz needs more than the 8 kHz rate of the generic breath (a rustle is low-passed at 3.2 kHz)
          expect(r.rate, `${base}#${v}`).toBeGreaterThanOrEqual(k === 'rustle' ? 11025 : 16000);
        }
      }
    // no bird breath is left to hiss
    expect(Object.keys(FOLEY_RECIPES).some((id) => id.startsWith('fx.breath.bird'))).toBe(false);
  });

  it('lets big cats and pachyderms breathe 4 dB under the other families, and giants step 6 dB under other feet', () => {
    const db = (id: string) => 20 * Math.log10(FOLEY_RECIPES[id].rms / FOLEY_RECIPES['fx.breath.grazer#0'].rms);
    for (const f of ['cat', 'pachyderm']) for (let v = 0; v < 3; v++) expect(db(`fx.breath.${f}#${v}`)).toBeCloseTo(-4, 5);
    for (const f of ['bear', 'equid', 'primate']) expect(db(`fx.breath.${f}#0`)).toBeCloseTo(0, 5);
    expect(20 * Math.log10(FOLEY_RECIPES['fx.step.scuff#0'].rms / FOLEY_RECIPES['fx.step.pad#0'].rms)).toBeCloseTo(-6, 5);
    for (const sp of ['elephant', 'hippo', 'rhino']) expect(FEET_BANK[FOLEY_SPECIES[sp].feet], sp).toBe('fx.step.scuff');
    expect(FEET_BANK[FOLEY_SPECIES.lion.feet]).toBe('fx.step.pad');
  });

  it('gives the close-up fillers several variants: tail swish, ear flap, feather rustle, scuff', () => {
    for (const base of ['fx.tail', 'fx.flap', 'fx.rustle.bird', 'fx.step.scuff'] as const) expect(FOLEY_BANKS[base], base).toBeGreaterThanOrEqual(2);
    // a rustle is short: the fauna module plays it 1.25× faster every 8–20 s
    expect(FOLEY_RECIPES['fx.rustle.bird#0'].dur).toBeLessThanOrEqual(0.4);
  });

  it('keeps each family sound shorter than the cadence it is played at', () => {
    for (const [id, r] of Object.entries(FOLEY_RECIPES)) {
      if (!isFamily(id)) continue;
      const len = r.dur + (r.tail ?? 0);
      if (id.startsWith('fx.drink.')) expect(len, id).toBeLessThan(LAP_SPACING);
      // one chew per 1.2 s; one breath per FAUNA.focusBreath, slowed by the biggest bodies (rate 0.7)
      else if (id.startsWith('fx.chew.')) expect(len, id).toBeLessThan(1.2 * 0.7);
      else expect(len / 0.7, id).toBeLessThan(FAUNA.focusBreath[0]);
    }
  });

  it('covers every species of the game', () => {
    for (const s of SPECIES) expect(FOLEY_SPECIES[s.id], s.id).toBeDefined();
  });
});

// ------------------------------------------------------------------ triggers

let nextId = 1;
function animal(speciesId: string, x: number, z: number, o: Partial<AnimalState> = {}): AnimalState {
  const id = nextId++;
  return {
    id,
    speciesId,
    name: speciesId,
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
    seed: id * 104729,
    ...o,
  };
}

function guest(x: number, z: number, child = false): GuestState {
  const id = nextId++;
  return { id, x, y: 0, z, speed: 1.3, action: 'walk', appearance: { child } } as unknown as GuestState;
}

function setup(o: { terrain?: Terrain; path?: PathType; zoomNear?: number; camDist?: number } = {}) {
  const events = new EventBus();
  const animals = new Map<number, AnimalState>();
  const guests = new Map<number, GuestState>();
  const sim = {
    animals,
    guests,
    speed: 1,
    events,
    world: { getTerrain: () => o.terrain ?? Terrain.Grass, getPath: () => o.path ?? PathType.None },
  } as unknown as ISimulation;
  const host = new FakeHost({ sim, events });
  host.listener = { x: 0, y: 1, z: 0, fx: 0, fz: 0, camDist: o.camDist ?? 25, zoomNear: o.zoomNear ?? 0.8 };
  const fauna = createFauna(host, 7);
  const run = (seconds: number, dt = 0.05) => {
    for (let t = 0; t < seconds; t += dt) {
      host.advance(dt);
      fauna.update(dt);
    }
  };
  return { sim, events, host, fauna, run, animals, guests };
}

const foley = (h: FakeHost, prefix = 'fx.') => h.plays.filter((p) => p.spec.pool === 'foley' && p.spec.id.startsWith(prefix));

describe('foley triggers', () => {
  it('steps an elephant at 1.2 m/s every 1.67 s', () => {
    const s = setup();
    const el = animal('elephant', 5, 0, { action: 'walk', speed: 1.2 });
    s.animals.set(el.id, el);
    s.run(30);
    // a pad-footed giant: a soft, dull scuff
    const t = foley(s.host, 'fx.step.scuff').map((p) => p.t);
    const iv = t.slice(1).map((x, i) => x - t[i]);
    expect(iv.length).toBeGreaterThan(14);
    const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
    expect(Math.abs(mean - 2 / 1.2) / (2 / 1.2)).toBeLessThanOrEqual(0.1);
    for (const p of foley(s.host, 'fx.step')) {
      expect(p.spec.track).toBe(el.id);
      expect(p.spec.refDist).toBe(3);
      expect(p.spec.radius).toBe(20);
      expect(p.spec.rate!).toBeGreaterThan(0.6);
      expect(p.spec.rate!).toBeLessThan(0.8);
    }
  });

  it('keeps 20 walking zebras at 5 m to 6 foley starts per second', () => {
    const s = setup();
    for (let i = 0; i < 20; i++) {
      const z = animal('zebra', 5 * Math.cos(i), 5 * Math.sin(i), { action: 'walk', speed: 2.5 });
      s.animals.set(z.id, z);
    }
    s.run(20);
    const t = foley(s.host).map((p) => p.t);
    expect(t.length).toBeGreaterThan(60);
    for (const t0 of t) expect(t.filter((x) => x >= t0 && x < t0 + 1).length).toBeLessThanOrEqual(6);
  });

  it('plays no foley with the camera pulled back', () => {
    const s = setup({ zoomNear: 0.3 });
    const el = animal('elephant', 5, 0, { action: 'walk', speed: 1.2 });
    s.animals.set(el.id, el);
    s.run(20);
    expect(foley(s.host).length).toBe(0);
  });

  it('laps every 0.3 s while a lion drinks', () => {
    const s = setup();
    const lion = animal('lion', 4, 0, { action: 'drink' });
    s.animals.set(lion.id, lion);
    s.run(10);
    const t = foley(s.host, 'fx.drink.cat').map((p) => p.t);
    const iv = t.slice(1).map((x, i) => x - t[i]);
    const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
    expect(Math.abs(mean - LAP_SPACING)).toBeLessThanOrEqual(0.05);
  });

  it('lets an elephant suck up water, then pour it 1.2 s later', () => {
    const s = setup();
    const el = animal('elephant', 4, 0, { action: 'drink' });
    s.animals.set(el.id, el);
    s.run(3);
    const suck = foley(s.host, 'fx.suck')[0];
    const pour = foley(s.host, 'fx.pour')[0];
    expect(suck).toBeDefined();
    expect(pour.t - suck.t).toBeCloseTo(1.2, 1);
  });

  it('lets a penguin on land drink with a beak dip, not a cat lap', () => {
    const s = setup();
    const p = animal('penguin', 3, 0, { action: 'drink' });
    s.animals.set(p.id, p);
    s.run(5);
    expect(foley(s.host, 'fx.drink.bird').length).toBeGreaterThan(5);
    expect(foley(s.host, 'fx.lap').length).toBe(0);
  });

  it('splashes a wading zebra and dives a penguin', () => {
    const s = setup({ terrain: Terrain.Water });
    const z = animal('zebra', 4, 0, { action: 'walk', speed: 1.5 });
    const p = animal('penguin', -4, 0, { action: 'walk', speed: 0.5 });
    s.animals.set(z.id, z);
    s.animals.set(p.id, p);
    s.run(3);
    p.action = 'swim';
    s.run(3);
    expect(foley(s.host, 'fx.splash.small').length).toBeGreaterThan(2);
    expect(foley(s.host, 'fx.dive').length).toBe(1);
  });

  it('gives the followed animal breath, ear flaps and tail swishes', () => {
    const s = setup();
    const el = animal('elephant', 4, 0, { action: 'idle' });
    s.animals.set(el.id, el);
    s.host.followId = el.id;
    s.run(120);
    // an elephant at rest breathes every 9–13 s (FOLEY_SPECIES.breathEvery), a few more fill silences
    expect(foley(s.host, 'fx.breath.pachyderm').length).toBeGreaterThanOrEqual(Math.floor(120 / FOLEY_SPECIES.elephant.breathEvery![1]));
    expect(foley(s.host, 'fx.flap').length).toBeGreaterThanOrEqual(4);
    expect(foley(s.host, 'fx.tail').length).toBeGreaterThanOrEqual(6);
  });
});

describe('guest steps', () => {
  it('walks at 1.8–2.0 steps/s at 1.3 m/s', () => {
    expect(guestCadence(1.3, false)).toBeGreaterThanOrEqual(1.8);
    expect(guestCadence(1.3, false)).toBeLessThanOrEqual(2.0);
    expect(guestCadence(1.3, true)).toBeCloseTo(guestCadence(1.3, false) * 1.25);
  });

  it('maps path surfaces to step sounds', () => {
    expect(guestStepBank(PathType.Paved)).toBe('fx.gstep.paved');
    expect(guestStepBank(PathType.Gravel)).toBe('fx.gstep.gravel');
    expect(guestStepBank(PathType.Boardwalk)).toBe('fx.gstep.board');
    expect(guestStepBank(PathType.None)).toBeNull();
  });

  it('plays the nearest guests on a plaza in a close view', () => {
    const s = setup({ path: PathType.Paved, camDist: 12 });
    for (let i = 0; i < 6; i++) {
      const g = guest(2 + i * 1.5, 1);
      s.guests.set(g.id, g);
    }
    s.run(10);
    const steps = foley(s.host, 'fx.gstep.paved');
    expect(steps.length).toBeGreaterThan(30);
    // only the 3 nearest guests step
    expect(new Set(steps.map((p) => p.spec.at!.x)).size).toBeLessThanOrEqual(3);
    expect(Math.max(...steps.map((p) => p.final))).toBeLessThan(0.2);
  });

  it('is silent on grass and with the camera far away', () => {
    const a = setup({ path: PathType.None, camDist: 12 });
    const b = setup({ path: PathType.Paved, camDist: 40 });
    for (const s of [a, b]) {
      const g = guest(3, 1);
      s.guests.set(g.id, g);
      s.run(5);
      expect(foley(s.host, 'fx.gstep').length).toBe(0);
    }
  });
});

describe('foley helpers', () => {
  it('finds one footfall per stride crossing', () => {
    const out: number[] = [];
    let phase = 0.9;
    phase = stepCrossings(phase, 2, 1, 0.1, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toBeCloseTo(0.05);
    expect(phase).toBeCloseTo(1.1);
  });

  it('limits starts per second and per source', () => {
    const l = new FoleyLimiter(6, 1, 0.15);
    let n = 0;
    for (let i = 0; i < 20; i++) if (l.take(i, i * 0.01)) n++;
    expect(n).toBe(6);
    expect(l.take(100, 0.9)).toBe(false);
    expect(l.take(100, 1.06)).toBe(true);
    expect(l.take(100, 1.15)).toBe(false);
  });
});
