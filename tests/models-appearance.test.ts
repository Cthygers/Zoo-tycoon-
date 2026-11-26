// Guest outfits read as clothes (no skin-coloured or all-pale figures) and the
// outfit rules draw nothing from the shared sim RNG, so seeded sims are unchanged;
// the guest walk keeps a natural step; pachyderm skin folds sit on legs and trunks;
// the lion's mane is two-tone and its belly and inner legs are pale.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { fitOutfit, hairReads, hexToLab, looksLikeSkin, randomGuestAppearance } from '../src/sim/names';
import { SimRng } from '../src/sim/rng';
import { CreatureFactory } from '../src/models';
import { assetFromDesign } from '../src/models/assets';
import { SPECIES_MODELS } from '../src/models/species';
import { SPECIES_BY_ID } from '../src/data/species';
import type { QualitySettings, SimSave } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { createSimulation } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';
import { buildZoo, buyHerd, hire, newSim } from './sim-helpers';

const L = (hex: number) => hexToLab(hex)[0];
const dE = (a: number, b: number) => {
  const [p, q] = [hexToLab(a), hexToLab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};

describe('guest outfits', () => {
  it('never pass for skin, separate top from bottom, and keep pale tops off pale-haired women', () => {
    const rng = new SimRng(11);
    for (let i = 0; i < 3000; i++) {
      const a = randomGuestAppearance(rng, i % 4 === 0);
      expect(looksLikeSkin(a.shirt, a.skin)).toBe(false);
      expect(looksLikeSkin(a.pants, a.skin)).toBe(false);
      expect(Math.abs(L(a.shirt) - L(a.pants))).toBeGreaterThanOrEqual(18);
      if (a.female && L(a.hair) > 45) expect(L(a.shirt)).toBeLessThanOrEqual(80);
      // a woman's top or bottom may be a dress or skirt over bare legs; hair frames the face
      if (a.female) {
        expect(dE(a.shirt, a.skin)).toBeGreaterThanOrEqual(25);
        expect(dE(a.pants, a.skin)).toBeGreaterThanOrEqual(25);
      }
      expect(hairReads(a.hair, a.skin)).toBe(true);
    }
  });

  it('keeps every top well apart from the skin in a seeded crowd (no bare-torso look with a contrast collar)', () => {
    const rng = new SimRng(23);
    const tops = new Set<number>();
    let n = 0;
    for (let i = 0; i < 800; i++) {
      const a = randomGuestAppearance(rng, i % 5 === 0);
      const [L1, a1, b1] = hexToLab(a.shirt);
      const [L2, a2, b2] = hexToLab(a.skin);
      expect(dE(a.shirt, a.skin)).toBeGreaterThanOrEqual(25);
      // every top (a woman's maybe half of a dress) also keeps out of the skin's hue family at a similar lightness
      const hue = Math.abs(Math.atan2(b1, a1) - Math.atan2(b2, a2)) * (180 / Math.PI);
      if (Math.hypot(a1, b1) >= 15 && Math.min(hue, 360 - hue) < 30) expect(Math.abs(L1 - L2)).toBeGreaterThanOrEqual(30);
      tops.add(a.shirt);
      n++;
    }
    expect(n).toBe(800);
    // the rule narrows the choice on some skins, not the crowd's palette
    expect(tops.size).toBeGreaterThanOrEqual(16);
    // the reported look: a brown tee on brown skin is re-dyed
    const man = { skin: 0x5c3a25, hair: 0x16110e, shirt: 0x9b6b43, pants: 0x2a2a2c, shoes: 0x222222, hairStyle: 0 as const, height: 1.77, build: 1, child: false, female: false };
    fitOutfit(man);
    expect(man.shirt).not.toBe(0x9b6b43);
    expect(dE(man.shirt, man.skin)).toBeGreaterThanOrEqual(25);
    // and a man's tan tee on the darkest skin: ΔE 33 passes on lightness alone, but it is the skin's hue a little lighter
    const dark = { ...man, skin: 0x45291a };
    fitOutfit(dark);
    expect(dark.shirt).not.toBe(0x9b6b43);
  });

  it('re-dyes hair that melts into the skin to the nearest darker shade that reads, and keeps black hair on the darkest skin', () => {
    expect(hairReads(0x8b4a2a, 0x8a5a3c)).toBe(false); // dark red on brown
    expect(hairReads(0xb8b2a8, 0xf3d5c0)).toBe(false); // pale grey on pale
    expect(hairReads(0x16110e, 0x45291a)).toBe(true); // black on the darkest skin
    const brown = { skin: 0x8a5a3c, hair: 0x8b4a2a, shirt: 0xc4644a, pants: 0x2a2a2c, shoes: 0x222222, hairStyle: 1 as const, height: 1.64, build: 1, child: false, female: true };
    fitOutfit(brown);
    expect(brown.hair).toBe(0x4a3324); // a dark brown, not blonde
    expect(dE(brown.shirt, brown.skin)).toBeGreaterThanOrEqual(25); // no coral dress on brown skin
    // nor on darker brown skin, where ΔE alone passes it: same hue family, close in lightness
    for (const skin of [0x734a30, 0x5c3a25]) {
      const dark = { ...brown, skin, shirt: 0xc4644a };
      fitOutfit(dark);
      expect(dark.shirt).not.toBe(0xc4644a);
    }
    const pale = { skin: 0xf3d5c0, hair: 0xb8b2a8, shirt: 0x2f3e55, pants: 0x9a8f7c, shoes: 0x222222, hairStyle: 2 as const, height: 1.77, build: 1, child: false, female: false };
    fitOutfit(pale);
    expect(pale.hair).toBe(0x6e6e6e); // still grey, a shade darker
    const mid = { ...pale, skin: 0x5c3a25, hair: 0x7a5a3c };
    fitOutfit(mid);
    expect(mid.hair).toBe(0x241912); // very dark brown, not dark blonde
    // light-tan skins keep their blondes: dark blond stays, light blond darkens to dark blond
    const tan = { ...pale, skin: 0xdcab86, hair: 0xa0804f };
    fitOutfit(tan);
    expect(tan.hair).toBe(0xa0804f);
    const light = { ...pale, skin: 0xe9c2a2, hair: 0xc4a46e };
    fitOutfit(light);
    expect(light.hair).toBe(0xa0804f);
  });

  it('halves the bald share on the two palest skins', () => {
    const rng = new SimRng(5);
    const bald = { pale: [0, 0], other: [0, 0] };
    for (let i = 0; i < 20000; i++) {
      const a = randomGuestAppearance(rng, false);
      if (a.female) continue;
      const k = a.skin === 0xf3d5c0 || a.skin === 0xe9c2a2 ? bald.pale : bald.other;
      k[0] += a.hairStyle === 2 ? 1 : 0;
      k[1]++;
    }
    const pale = bald.pale[0] / bald.pale[1], other = bald.other[0] / bald.other[1];
    expect(other).toBeCloseTo(0.13, 1);
    expect(pale / other).toBeGreaterThan(0.35);
    expect(pale / other).toBeLessThan(0.65);
  });

  it('flags the reported look-alikes: tan dress on tan skin, cream top on pale skin', () => {
    expect(looksLikeSkin(0x9b6b43, 0xb98260)).toBe(true);
    expect(looksLikeSkin(0xe6e1d3, 0xf3d5c0)).toBe(true);
    expect(looksLikeSkin(0x2c3e5c, 0xb98260)).toBe(false);
  });

  it('uses exactly the draws of the plain palette picks (10 for a child, 16 for an adult)', () => {
    // mulberry32 advances its state by a fixed step per float
    for (const [child, draws] of [[true, 10], [false, 16]] as const) {
      for (let seed = 1; seed < 40; seed++) {
        const rng = new SimRng(seed * 7919);
        const s0 = rng.state;
        randomGuestAppearance(rng, child);
        expect(rng.state).toBe((s0 + draws * 0x6d2b79f5) >>> 0);
      }
    }
  });

  it('re-fits a companion that takes on the party leader’s skin', () => {
    const app = { skin: 0x2c3e5c, hair: 0x16110e, shirt: 0x2f3e55, pants: 0x9a8f7c, shoes: 0x222222, hairStyle: 0 as const, height: 1.7, build: 1, child: false, female: false };
    app.skin = 0xb98260;
    app.shirt = 0x9b6b43; // tan on tan
    fitOutfit(app);
    expect(looksLikeSkin(app.shirt, app.skin)).toBe(false);
    expect(Math.abs(L(app.shirt) - L(app.pants))).toBeGreaterThanOrEqual(18);
  });

  it('leaves colours outside the guest palettes (staff uniforms) alone', () => {
    const app = { skin: 0xe9c2a2, hair: 0xb8b2a8, shirt: 0xe4e8ea, pants: 0x3d6f78, shoes: 0xe8e6e1, hairStyle: 1 as const, height: 1.65, build: 1, child: false, female: true };
    fitOutfit(app);
    expect(app.shirt).toBe(0xe4e8ea);
    expect(app.pants).toBe(0x3d6f78);
  });

  it('re-fits guests loaded from a save made before the outfit rules', () => {
    const { sim } = newSim(7);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    hire(sim);
    sim.setSpeed(3);
    while (sim.guests.size < 6 && sim.minuteOfDay < 15 * 60) sim.update(0.1);
    expect(sim.guests.size).toBeGreaterThanOrEqual(6);
    // the old palette picks: a tan top on tan skin over tan trousers
    for (const g of sim.guests.values()) Object.assign(g.appearance, { skin: 0xb98260, shirt: 0x9b6b43, pants: 0x8c7b5e, hair: 0x8b4a2a });
    const save = JSON.parse(JSON.stringify(sim.serialize())) as SimSave;
    const old = createSimulation(new EventBus(), 1) as Simulation;
    old.load(save);
    expect(old.guests.size).toBe(sim.guests.size);
    for (const g of old.guests.values()) {
      expect(looksLikeSkin(g.appearance.shirt, g.appearance.skin)).toBe(false);
      expect(looksLikeSkin(g.appearance.pants, g.appearance.skin)).toBe(false);
      expect(Math.abs(L(g.appearance.shirt) - L(g.appearance.pants))).toBeGreaterThanOrEqual(18);
      expect(hairReads(g.appearance.hair, g.appearance.skin)).toBe(true);
    }
  }, 60_000);
});

const QUALITY: QualitySettings = { level: 'low', pixelRatio: 1, antialias: false, shadows: false, shadowMapSize: 1024, grassDensity: 0, postFX: false, detailDistance: 40, creatureDetail: 0 };

describe('guest walk', () => {
  it('caps the step at about 0.42 × height and folds the swing knee ≈ 55–60°', () => {
    const f = new CreatureFactory(QUALITY);
    const h = f.createHuman({ skin: 0xc68e6a, hair: 0x332211, shirt: 0x335577, pants: 0x222222, shoes: 0x111111, hairStyle: 0, height: 1.77, build: 1, child: false, female: false }, 'guest', 3);
    const m = h as unknown as { rt: { fk(p: unknown): void; wp: THREE.Vector3[]; def: { names: string[] } }; out: unknown };
    const id = (n: string) => m.rt.def.names.indexOf(n);
    const [hip, knee, ankle, ankleR] = ['thigh.L', 'shin.L', 'foot.L', 'foot.R'].map(id);
    for (const speed of [1.27, 2.2]) {
      let maxFlex = 0, maxGap = 0;
      for (let k = 0; k < 360; k++) {
        h.update(1 / 60, { action: 'walk', speed });
        if (k < 120) continue;
        m.rt.fk(m.out);
        const w = m.rt.wp;
        const flex = w[knee].clone().sub(w[hip]).angleTo(w[ankle].clone().sub(w[knee]));
        maxFlex = Math.max(maxFlex, flex);
        maxGap = Math.max(maxGap, Math.abs(w[ankle].z - w[ankleR].z));
      }
      expect(maxGap / h.height).toBeLessThan(0.42);
      expect(maxFlex * (180 / Math.PI)).toBeGreaterThan(50);
      expect(maxFlex * (180 / Math.PI)).toBeLessThan(65);
    }
    h.dispose();
  });

  it('sets the feet near the line of travel while walking, hip-wide when standing', () => {
    const f = new CreatureFactory(QUALITY);
    const h = f.createHuman({ skin: 0xc68e6a, hair: 0x332211, shirt: 0x335577, pants: 0x222222, shoes: 0x111111, hairStyle: 0, height: 1.77, build: 1, child: false, female: false }, 'guest', 3);
    const m = h as unknown as { rt: { fk(p: unknown): void; wp: THREE.Vector3[]; def: { names: string[] } }; out: unknown };
    const [ankleL, ankleR] = ['foot.L', 'foot.R'].map((n) => m.rt.def.names.indexOf(n));
    const width = (speed: number) => {
      let sum = 0, n = 0;
      for (let k = 0; k < 300; k++) {
        h.update(1 / 60, { action: 'walk', speed });
        if (k < 150) continue;
        m.rt.fk(m.out);
        sum += Math.abs(m.rt.wp[ankleL].x - m.rt.wp[ankleR].x);
        n++;
      }
      return sum / n;
    };
    const standing = width(0);
    const walking = width(1.27);
    expect(standing).toBeGreaterThan(0.16);
    expect(walking).toBeLessThan(standing * 0.72);
    expect(walking).toBeGreaterThan(0.08); // the feet never cross over
    h.dispose();
  });
});

describe('pachyderm skin folds', () => {
  it('bakes deep folds on the legs and trunk, a faint network on the body, none on the tusks', () => {
    const design = SPECIES_MODELS.elephant.design({ def: SPECIES_BY_ID.elephant, sex: 'M', detail: 0 });
    const geo = assetFromDesign('elephant-folds', design, 0).geometry;
    const pos = geo.getAttribute('position');
    const pat = geo.getAttribute('pattern');
    let lowLeg = 0, lowLegN = 0, back = 0, backN = 0, glossyFolds = 0;
    for (let i = 0; i < pos.count; i++) {
      const fold = Math.max(-pat.getW(i), 0);
      if (pos.getY(i) < 0.8 && Math.abs(pos.getZ(i)) < 1.2) { lowLeg += fold; lowLegN++; }
      if (pos.getY(i) > 2.9 && Math.abs(pos.getX(i)) < 0.3) { back += fold; backN++; }
      if (pat.getZ(i) > 0.3 && fold > 0) glossyFolds++;
    }
    expect(lowLeg / lowLegN).toBeGreaterThan(0.8);
    expect(back / backN).toBeCloseTo(0.3, 1);
    expect(glossyFolds).toBe(0);
  });
});

describe('lion coat', () => {
  /** Mean baked luminance (linear albedo) of the vertices matching `where`. */
  function regions(sex: 'M' | 'F') {
    const design = SPECIES_MODELS.lion.design({ def: SPECIES_BY_ID.lion, sex, detail: 0 });
    const geo = assetFromDesign(`lion-coat-${sex}`, design, 0).geometry;
    const pos = geo.getAttribute('position'), col = geo.getAttribute('color'), nor = geo.getAttribute('normal');
    const acc: Record<string, [number, number]> = {};
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), nx = nor.getX(i), ny = nor.getY(i);
      const lum = 0.2126 * col.getX(i) + 0.7152 * col.getY(i) + 0.0722 * col.getZ(i);
      const add = (k: string) => { (acc[k] ??= [0, 0])[0] += lum; acc[k][1]++; };
      if (y > 1.05 && z > 0.35 && z < 0.6) add('maneCrest');
      if (z > 0.86 && y > 0.85 && y < 1.15 && Math.abs(x) > 0.18) add('maneRim');
      if (Math.abs(x) > 0.14 && y > 0.75 && y < 0.88 && z > -0.2 && z < 0.1 && Math.abs(nx) > 0.6) add('flank');
      if (y > 0.55 && y < 0.72 && z > -0.3 && z < 0.1 && ny < -0.2 && ny > -0.7) add('lowerFlank');
      if (y < 0.5 && y > 0.15 && Math.sign(x) * nx < -0.4) add('innerLeg');
      if (y < 0.5 && y > 0.15 && Math.sign(x) * nx > 0.4) add('outerLeg');
    }
    const r: Record<string, number> = {};
    for (const [k, [sum, n]] of Object.entries(acc)) r[k] = sum / n;
    return r;
  }

  it('gives the male a two-tone mane, darker than the coat, and both sexes a pale belly and inner legs', () => {
    const m = regions('M');
    expect(m.maneCrest).toBeLessThan(m.flank * 0.5);
    expect(m.maneRim).toBeGreaterThan(m.maneCrest * 1.6);
    for (const r of [m, regions('F')]) {
      expect(r.lowerFlank).toBeGreaterThan(r.flank);
      expect(r.innerLeg).toBeGreaterThan(r.outerLeg);
    }
  });
});
