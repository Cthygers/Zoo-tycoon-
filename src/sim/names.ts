// Names, plural labels and random human appearance for guests and staff.

import type { HumanAppearance, StaffRole } from '../core/types';
import { SPECIES_BY_ID } from '../data/species';
import type { SimRng } from './rng';

const ANIMAL_NAMES = [
  'Amara', 'Bongo', 'Kito', 'Zuri', 'Tembo', 'Nala', 'Jabari', 'Imani', 'Kesi', 'Baraka', 'Asha', 'Duma',
  'Tano', 'Penny', 'Juno', 'Rufus', 'Mabel', 'Otto', 'Hazel', 'Pip', 'Willow', 'Bramble', 'Clover', 'Basil',
  'Maple', 'Fern', 'Ivy', 'Rowan', 'Sable', 'Tilly', 'Ziggy', 'Moss', 'Pebble', 'Sunny', 'Koa', 'Luna',
  'Odin', 'Freya', 'Kiri', 'Mosi', 'Nia', 'Sefu', 'Tamu', 'Uzuri', 'Wema', 'Yaro', 'Zola', 'Anouk',
  'Biscuit', 'Cedar', 'Dune', 'Ember', 'Flint', 'Ginger', 'Hugo', 'Indigo', 'Jasper', 'Kona', 'Lumi', 'Milo',
  'Nyx', 'Olive', 'Poppy', 'Quill', 'Rosie', 'Saffron', 'Toby', 'Umi', 'Vega', 'Wren', 'Yuki', 'Zephyr',
  'Akello', 'Bahati', 'Chausiku', 'Dalia', 'Eshe', 'Faraji', 'Hodari', 'Jelani', 'Kamaria', 'Lulu', 'Makena', 'Neema',
];

const FIRST_NAMES_F = [
  'Aisha', 'Mei', 'Sofia', 'Priya', 'Emma', 'Fatima', 'Yuna', 'Olivia', 'Amina', 'Lucia', 'Hana', 'Grace',
  'Chloe', 'Ingrid', 'Zara', 'Leila', 'Mia', 'Nadia', 'Rosa', 'Sakura', 'Tara', 'Valentina', 'Ama', 'Elena',
  'Isabel', 'Keisha', 'Lena', 'Maya', 'Noor', 'Ruth', 'Sana', 'Thandi', 'Ximena', 'Yasmin', 'Ana', 'Beatriz',
];
const FIRST_NAMES_M = [
  'Omar', 'Liam', 'Kenji', 'Arjun', 'Mateo', 'Kwame', 'Noah', 'Wei', 'Lucas', 'Tariq', 'Diego', 'Ethan',
  'Hiroshi', 'Ivan', 'Jamal', 'Kofi', 'Leo', 'Marco', 'Nikhil', 'Oscar', 'Pablo', 'Rafael', 'Samir', 'Theo',
  'Victor', 'Yusuf', 'Ade', 'Ben', 'Carlos', 'Dmitri', 'Elias', 'Felix', 'Hamza', 'Joon', 'Kai', 'Malik',
];
const LAST_INITIALS = 'ABCDEFGHJKLMNOPRSTVWYZ';

/** A name no living animal in the zoo has, so messages are never ambiguous; once all are used, "Tano II". */
export function animalName(rng: SimRng, taken: ReadonlySet<string>): string {
  const free = ANIMAL_NAMES.filter((n) => !taken.has(n));
  if (free.length) return rng.pick(free);
  const base = rng.pick(ANIMAL_NAMES);
  for (let k = 2; ; k++) {
    const name = `${base} ${roman(k)}`;
    if (!taken.has(name)) return name;
  }
}

/** Roman numeral for a name suffix (a zoo would need thousands of animals to pass XXXIX). */
function roman(n: number): string {
  let out = '';
  for (const [v, s] of ROMAN) for (; n >= v; n -= v) out += s;
  return out;
}
const ROMAN: [number, string][] = [
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

export function personName(rng: SimRng, female: boolean): string {
  const first = rng.pick(female ? FIRST_NAMES_F : FIRST_NAMES_M);
  return `${first} ${LAST_INITIALS[rng.int(0, LAST_INITIALS.length - 1)]}.`;
}

const PLURALS: Record<string, string> = {
  elephant: 'elephants',
  giraffe: 'giraffes',
  zebra: 'zebras',
  lion: 'lions',
  tiger: 'tigers',
  grizzly: 'grizzly bears',
  polarbear: 'polar bears',
  hippo: 'hippos',
  rhino: 'rhinos',
  gazelle: 'gazelles',
  camel: 'camels',
  gorilla: 'gorillas',
  penguin: 'penguins',
  flamingo: 'flamingos',
};
const SINGULARS: Record<string, string> = {
  elephant: 'elephant',
  giraffe: 'giraffe',
  zebra: 'zebra',
  lion: 'lion',
  tiger: 'tiger',
  grizzly: 'grizzly bear',
  polarbear: 'polar bear',
  hippo: 'hippo',
  rhino: 'rhino',
  gazelle: 'gazelle',
  camel: 'camel',
  gorilla: 'gorilla',
  penguin: 'penguin',
  flamingo: 'flamingo',
};

/** "elephants", "polar bears" … for guest thoughts. */
export function pluralName(speciesId: string): string {
  return PLURALS[speciesId] ?? `${(SPECIES_BY_ID[speciesId]?.name ?? speciesId).toLowerCase()}s`;
}
/** "elephant", "polar bear" … */
export function singularName(speciesId: string): string {
  return SINGULARS[speciesId] ?? (SPECIES_BY_ID[speciesId]?.name ?? speciesId).toLowerCase();
}

// --------------------------------------------------------------- appearance
// Natural, slightly desaturated palettes (art direction: realistic, no cartoon colours).
const SKIN = [0xf3d5c0, 0xe9c2a2, 0xdcab86, 0xcf9a73, 0xb98260, 0xa06c4b, 0x8a5a3c, 0x734a30, 0x5c3a25, 0x45291a, 0xe2b48f, 0xc89070];
const HAIR = [0x16110e, 0x241912, 0x33241a, 0x4a3324, 0x5e4330, 0x7a5a3c, 0xa0804f, 0xc4a46e, 0x8b4a2a, 0x6e6e6e, 0xb8b2a8];
const SHIRT = [
  0x2f3e55, 0x445a3a, 0x7a2f2f, 0xb8913a, 0x2f6b6b, 0xdcd8cf, 0x6f6f6f, 0xc4644a, 0x4f4a6b, 0x8a9a5b, 0x3b5f8a, 0xa35a6e, 0xe6e1d3,
  0x1f2328, 0x9b6b43, 0x5b7c8c, 0x8fa6bf, 0x9a9c9f, 0x6a85a6, 0x86977a,
];
const PANTS = [0x2c3e5c, 0x3b4f6e, 0x1e2a3c, 0x6b5f4a, 0x8c7b5e, 0x2a2a2c, 0x55585c, 0x5a4636, 0x46503b, 0x9a8f7c];
const SHOES = [0xe8e6e1, 0x222222, 0x4a3426, 0x6b6b6b, 0x8a6a4a, 0x2c3a4f];

// Outfit contrast. With smooth bodies and no garment seams, colour is the only
// clothing cue: a top or bottom close to the skin reads as bare skin, and an
// all-pale figure reads as a statue.
/** Below this CIE76 ΔE a garment reads as skin. */
const SKIN_DELTA_E = 15;
/** Minimum lightness gap (CIE L*, 0..100) between top and bottom. */
const TOP_BOTTOM_L = 18;
/** L* above which a top counts as white / cream, and hair as grey / blonde. */
const PALE_TOP_L = 80;
const PALE_HAIR_L = 45;

/** CIE L*a*b* (D65) of an sRGB colour. */
export function hexToLab(hex: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin((hex >> 16) & 255);
  const g = lin((hex >> 8) & 255);
  const b = lin(hex & 255);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** A garment colour close enough to the skin to read as bare skin. */
export function looksLikeSkin(cloth: number, skin: number): boolean {
  const [L1, a1, b1] = hexToLab(cloth);
  const [L2, a2, b2] = hexToLab(skin);
  if (Math.hypot(L1 - L2, a1 - a2, b1 - b2) < SKIN_DELTA_E) return true;
  // same lightness (relative luminance within 15 %) and a similar hue
  const y1 = ((L1 + 16) / 116) ** 3;
  const y2 = ((L2 + 16) / 116) ** 3;
  if (Math.abs(y1 - y2) > 0.15 * Math.max(y1, y2) || Math.hypot(a1, b1) < 10) return false;
  const dh = Math.abs(Math.atan2(b1, a1) - Math.atan2(b2, a2)) * (180 / Math.PI);
  return Math.min(dh, 360 - dh) < 25;
}

/**
 * `list[from]` if `ok` accepts it, else one of the accepted colours chosen by
 * `from` (so the rejected share spreads over them), else `list[from]`.
 */
function pickFrom(list: readonly number[], from: number, ok: (c: number) => boolean): number {
  if (ok(list[from])) return list[from];
  const good = list.filter(ok);
  return good.length ? good[from % good.length] : list[from];
}

/**
 * Make a guest's outfit read as clothes: neither garment passes for skin, the
 * top differs in lightness from the bottom, and a woman with grey or blonde
 * hair never gets a white / cream top (some wear it as a dress: a statue).
 * Only garments drawn from the guest palettes are changed, each to a suitable
 * palette colour chosen by its own index, so it uses no random draws and can run again after
 * a companion takes on the party leader's skin.
 */
export function fitOutfit(app: HumanAppearance): void {
  const pi = PANTS.indexOf(app.pants);
  if (pi >= 0) app.pants = pickFrom(PANTS, pi, (c) => !looksLikeSkin(c, app.skin));
  const si = SHIRT.indexOf(app.shirt);
  if (si < 0) return;
  const pantsL = hexToLab(app.pants)[0];
  const paleHair = app.female && hexToLab(app.hair)[0] > PALE_HAIR_L;
  app.shirt = pickFrom(SHIRT, si, (c) => {
    const L = hexToLab(c)[0];
    return !looksLikeSkin(c, app.skin) && Math.abs(L - pantsL) >= TOP_BOTTOM_L && !(paleHair && L > PALE_TOP_L);
  });
}

export function randomGuestAppearance(rng: SimRng, child: boolean): HumanAppearance {
  const female = rng.chance(0.5);
  const height = child ? rng.range(1.05, 1.42) : female ? 1.64 + rng.gauss() * 0.065 : 1.77 + rng.gauss() * 0.07;
  let hairStyle: 0 | 1 | 2 | 3;
  const r = rng.float();
  if (female) hairStyle = r < 0.62 ? 1 : r < 0.85 ? 0 : 3;
  else hairStyle = r < 0.62 ? 0 : r < 0.75 ? 2 : r < 0.92 ? 3 : 1;
  if (child && hairStyle === 2) hairStyle = 0;
  const greyChance = child ? 0 : 0.12;
  const hair = rng.chance(greyChance) ? rng.pick([0x6e6e6e, 0xb8b2a8]) : rng.pick(HAIR.slice(0, 9));
  const app: HumanAppearance = {
    skin: rng.pick(SKIN),
    hair,
    shirt: rng.pick(SHIRT),
    pants: rng.pick(PANTS),
    shoes: rng.pick(SHOES),
    hairStyle,
    height: Math.min(1.97, Math.max(child ? 1.0 : 1.5, height)),
    build: child ? rng.range(0.85, 1.0) : Math.min(1.2, Math.max(0.85, 1.0 + rng.gauss() * 0.08)),
    child,
    female,
  };
  fitOutfit(app);
  return app;
}

const UNIFORM: Record<StaffRole, { shirt: number; pants: number; shoes: number }> = {
  keeper: { shirt: 0x5d6640, pants: 0x6b5a42, shoes: 0x3e2c20 },
  groundskeeper: { shirt: 0x2f5a3c, pants: 0x3a3f44, shoes: 0x222222 },
  vet: { shirt: 0xe4e8ea, pants: 0x3d6f78, shoes: 0xe8e6e1 },
};

export function staffAppearance(rng: SimRng, role: StaffRole): HumanAppearance {
  const a = randomGuestAppearance(rng, false);
  const u = UNIFORM[role];
  a.shirt = u.shirt;
  a.pants = u.pants;
  a.shoes = u.shoes;
  if (a.hairStyle === 1 && role === 'keeper') a.hairStyle = 3;
  return a;
}

export const STAFF_SALARY: Record<StaffRole, number> = { keeper: 120, groundskeeper: 90, vet: 160 };
export const STAFF_TITLE: Record<StaffRole, string> = { keeper: 'Keeper', groundskeeper: 'Groundskeeper', vet: 'Vet' };
