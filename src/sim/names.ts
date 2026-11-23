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

export function animalName(rng: SimRng): string {
  return rng.pick(ANIMAL_NAMES);
}

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
  0x1f2328, 0x9b6b43, 0x5b7c8c,
];
const PANTS = [0x2c3e5c, 0x3b4f6e, 0x1e2a3c, 0x6b5f4a, 0x8c7b5e, 0x2a2a2c, 0x55585c, 0x5a4636, 0x46503b, 0x9a8f7c];
const SHOES = [0xe8e6e1, 0x222222, 0x4a3426, 0x6b6b6b, 0x8a6a4a, 0x2c3a4f];

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
  return {
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
