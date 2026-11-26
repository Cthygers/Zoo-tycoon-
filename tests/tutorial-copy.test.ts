// Copy lint for the tutorial (spec §6.2, T3/T6): every bubble is a short action line that starts
// with a verb and names the button, plus a short why line; checked with every species noun.
import { describe, expect, it } from 'vitest';
import { FENCES, PATHS } from '../src/data/fences';
import { OBJECTS_BY_ID } from '../src/data/objects';
import { SPECIES } from '../src/data/species';
import { STAFF_INFO, TERRAIN_INFO } from '../src/ui/catalog';
import { BUILD, BUTTONS, CARDS, DOCK_LABEL, fill, HELP_POP, LINES, NOUNS, POPS, STEPS, type LineKey } from '../src/ui/tutorial/script';

const VERBS = ['Tap', 'Drag', 'Pinch', 'Twist', 'Roll', 'Hold', 'Use', 'Keep', 'Turn', 'Try', 'Fix', 'Paint', 'Plant', 'Join', 'Watch', 'Let', "Let's"];
const PICTO = /\p{Extended_Pictographic}/u;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const species = [...Object.keys(NOUNS), 'zebra'];
const keys = Object.keys(LINES) as LineKey[];

/** Every way a line can read: each species noun and each dock label substituted. */
function variants(text: string): string[] {
  const out = new Set<string>();
  for (const sp of species) for (const cat of Object.values(DOCK_LABEL)) out.add(fill(text, { speciesId: sp, cat }));
  return [...out];
}

describe('tutorial copy lint', () => {
  it('has the lines of every build step and phase', () => {
    for (const s of STEPS) {
      if (!s.build) continue;
      for (const ph of ['open', 'pick', 'use', 'confirm']) expect(keys, `${s.id}.${ph}`).toContain(`${s.id}.${ph}`);
    }
  });

  it('action lines: 2–5 words, start with an allowed verb, no emoji, end with . ! or ?', () => {
    for (const k of keys) {
      for (const a of variants(LINES[k].a)) {
        const n = words(a).length;
        expect(n, `${k}: "${a}"`).toBeGreaterThanOrEqual(2);
        expect(n, `${k}: "${a}"`).toBeLessThanOrEqual(5);
        expect(VERBS, `${k}: "${a}" starts with a verb`).toContain(words(a)[0]);
        expect(PICTO.test(a), `${k} emoji`).toBe(false);
        expect(a, k).toMatch(/[.!?]$/);
      }
    }
  });

  it('why lines: at most 10 words, no emoji, end with . ! or ?', () => {
    for (const k of keys) {
      const w = (LINES[k] as { w?: string }).w;
      if (!w) continue;
      for (const v of variants(w)) {
        expect(words(v).length, `${k}: "${v}"`).toBeLessThanOrEqual(10);
        expect(PICTO.test(v), `${k} emoji`).toBe(false);
        expect(v, k).toMatch(/[.!?]$/);
      }
    }
  });

  it('open / pick / confirm lines name the dock label, the catalogue card and the confirm verb exactly', () => {
    for (const s of STEPS) {
      const b = BUILD[s.id];
      if (!b) continue;
      const open = LINES[`${s.id}.open` as LineKey].a;
      const pick = LINES[`${s.id}.pick` as LineKey].a;
      const confirm = LINES[`${s.id}.confirm` as LineKey].a;
      expect(open, `${s.id}.open`).toContain(DOCK_LABEL[b.cat]);
      expect(pick, `${s.id}.pick`).toContain(b.cardName);
      expect(confirm, `${s.id}.confirm`).toContain(b.verb);
      expect(new RegExp(`\\b${b.verb}\\b`).test(confirm)).toBe(true);
    }
  });

  it('card names in pick lines are the real catalogue names', () => {
    const names: Record<string, string> = {
      'fence:1': FENCES.find((f) => f.id === 1)!.name,
      'terrain:1': TERRAIN_INFO[1].name,
      'obj:water_trough': OBJECTS_BY_ID.water_trough.name,
      'obj:shelter_wood': OBJECTS_BY_ID.shelter_wood.name,
      'obj:grass_tall': OBJECTS_BY_ID.grass_tall.name,
      'animal:zebra': SPECIES.find((s) => s.id === 'zebra')!.name,
      'path:1': PATHS.find((p) => p.type === 1)!.name,
      'obj:shop_snack': OBJECTS_BY_ID.shop_snack.name,
      'obj:bench': OBJECTS_BY_ID.bench.name,
      'obj:bin': OBJECTS_BY_ID.bin.name,
      'staff:keeper': STAFF_INFO.keeper.name,
    };
    for (const b of Object.values(BUILD)) expect(b!.cardName, b!.card).toBe(names[b!.card]);
    expect(Object.values(names)).toEqual([
      'Timber Rail Fence', 'Savanna Grass', 'Water Trough', 'Timber Shelter', 'Tall Grass', 'Plains Zebra',
      'Stone Pavers', 'Snack Kiosk', 'Park Bench', 'Litter Bin', 'Animal Keeper',
    ]);
  });

  it("step 11b's versus line is exact (T6)", () => {
    expect(LINES['speed-note.versus'].w).toBe('In Versus matches, time always runs fast. No pausing!');
    expect(LINES['speed-note.versus'].a).toBe('Tap Got it.');
  });

  it('every species noun fills {animal} / {Animals}, and the default is the zebra', () => {
    expect(fill('Tap your {animal}.')).toBe('Tap your zebra.');
    expect(fill('{Animals} need food every day.', { speciesId: 'polarbear' })).toBe('Polar bears need food every day.');
    for (const s of SPECIES) expect(NOUNS[s.id], s.id).toBeDefined();
  });

  it('cards, buttons, pops and the help pop: no emoji, sentences end with punctuation', () => {
    for (const t of [...Object.values(CARDS), ...POPS, HELP_POP]) {
      expect(PICTO.test(t)).toBe(false);
    }
    for (const k of ['welcomeText', 'welcomePractice', 'finishHappy', 'finishGuests', 'tryFriends', 'tryMore', 'tryRestrooms', 'tryVersus', 'tryGoal', 'skipText', 'practiceText'] as const) {
      expect(CARDS[k], k).toMatch(/[.!?]$/);
    }
    expect(CARDS.skipTitle).toBe('Stop learning?');
    expect(CARDS.skipCancel).toBe('Keep learning');
    expect(BUTTONS.helpMe).toBe('Help me');
    expect(HELP_POP).toBe('Your turn next time!');
  });
});
