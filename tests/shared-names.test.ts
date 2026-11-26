// shared/names.ts + shared/wordlist.ts + shared/limits.ts: profile-name rules (api.md §6). The server and the
// account UI both call checkName(), so these accepted/rejected tables are the shared fixtures.
import { describe, expect, it } from 'vitest';
import type { AvatarAnimal } from '../shared/api-types';
import {
  AVATAR_ANIMALS,
  AVATAR_COLORS,
  LEASE_SECONDS_DEFAULT,
  MAX_PROFILES_DEFAULT,
  NAME_MAX_GRAPHEMES,
  SNAPSHOTS_PER_CALL,
  UNIQUE_PLAY_THRESHOLD_S,
} from '../shared/limits';
import {
  NAME_MESSAGES,
  checkName,
  graphemeCount,
  isBlockedName,
  nameKey,
  nameSkeleton,
  normalizeName,
  type NameProblem,
} from '../shared/names';
import { BLOCKED_WORDS, WORDLIST_VERSION } from '../shared/wordlist';

/** 'कि' is one grapheme made of two code points (KA + VOWEL SIGN I). */
const KI = 'कि';

const ACCEPTED: [raw: string, name: string][] = [
  ['Mia', 'Mia'],
  ['Ben', 'Ben'],
  ['  Mia   Rose  ', 'Mia Rose'],
  ['Mia Rose', 'Mia Rose'],
  ['Mia\tRose', 'Mia Rose'],
  ["O'Brien", "O'Brien"],
  ['Anne-Marie', 'Anne-Marie'],
  ['J.R. Smith', 'J.R. Smith'],
  ['Zoë', 'Zoë'],
  ['Zoë', 'Zoë'],
  ['José', 'José'],
  ['Søren', 'Søren'],
  ['Ñandú', 'Ñandú'],
  ['李小龙', '李小龙'],
  ['Олег', 'Олег'],
  ['محمد', 'محمد'],
  ['ＭＩＡ', 'MIA'],
  ['ﬁona', 'fiona'],
  ['R2D2', 'R2D2'],
  ['Mia 2024', 'Mia 2024'],
  ['1234', '1234'],
  ['Abcdefghijklmnop', 'Abcdefghijklmnop'],
  [KI.repeat(16), KI.repeat(16)],
  ['Captain Zebra 7', 'Captain Zebra 7'],
  // Scunthorpe cases: short entries only match whole tokens; long entries are chosen to avoid names.
  ['Scunthorpe', 'Scunthorpe'],
  ['Cockburn', 'Cockburn'],
  ['Dickson', 'Dickson'],
  ['Peacock', 'Peacock'],
  ['Woodpecker', 'Woodpecker'],
  ['Hancock', 'Hancock'],
  ['Grape', 'Grape'],
  ['Shitake', 'Shitake'],
  ['Classic', 'Classic'],
  ['Cassandra', 'Cassandra'],
  ['Sussex', 'Sussex'],
  ['Spice', 'Spice'],
  ['Arsenal', 'Arsenal'],
  ['Cockatoo', 'Cockatoo'],
  ['Dickens', 'Dickens'],
  ['Titanic', 'Titanic'],
  ['Raccoon', 'Raccoon'],
  ['Japan', 'Japan'],
  ['Mongoose', 'Mongoose'],
  ['Montenegro', 'Montenegro'],
  ['Scrappy', 'Scrappy'],
  ['Thorny', 'Thorny'],
  ['Prickles', 'Prickles'],
  ['Fanny', 'Fanny'],
  ['Bob', 'Bob'],
  ['Pussycat', 'Pussycat'],
  ['Shih Tzu', 'Shih Tzu'],
  ['Sasha Tiger', 'Sasha Tiger'],
  ['Jack Asher', 'Jack Asher'],
  ['Rowan King', 'Rowan King'],
  ['Prince Steve', 'Prince Steve'],
  ['Baraka Fire', 'Baraka Fire'],
  ['Captain Juno', 'Captain Juno'],
  ['Phuc Kai', 'Phuc Kai'],
  ['Debugger', 'Debugger'],
  ['Analise', 'Analise'],
  ['Spicer', 'Spicer'],
];

const REJECTED: [raw: string, problem: NameProblem][] = [
  // empty
  ['', 'empty'],
  ['   ', 'empty'],
  ['\t\n', 'empty'],
  [' 　', 'empty'],
  // emails and websites
  ['mia@zoo.com', 'looks_like_contact'],
  ['mia.rose@example.org', 'looks_like_contact'],
  ['Mia@Home', 'looks_like_contact'],
  ['mia＠zoo', 'looks_like_contact'],
  ['www.mia.net', 'looks_like_contact'],
  ['WWW MIA', 'looks_like_contact'],
  ['http://mia.io', 'looks_like_contact'],
  ['https zoo', 'looks_like_contact'],
  ['Mia.com', 'looks_like_contact'],
  ['ZOO.ORG', 'looks_like_contact'],
  ['mia.net', 'looks_like_contact'],
  ['https://wildhaven.example.com/mia', 'looks_like_contact'],
  // more than 16 graphemes
  ['Abcdefghijklmnopq', 'too_long'],
  ['Mia Rose Johnson Smith', 'too_long'],
  [KI.repeat(17), 'too_long'],
  // characters
  ['Mia 🦁', 'bad_chars'],
  ['🦁', 'bad_chars'],
  ['🦁🦒🐘', 'bad_chars'],
  ['Mia_Rose', 'bad_chars'],
  ['Mia!', 'bad_chars'],
  ['Mia (7)', 'bad_chars'],
  ['Mi‍a', 'bad_chars'],
  ['<b>Mia</b>', 'bad_chars'],
  ['...', 'bad_chars'],
  ["'-'", 'bad_chars'],
  // digits (phone numbers)
  ['Mia12345', 'too_many_digits'],
  ['0712345678', 'too_many_digits'],
  ['555 1234', 'too_many_digits'],
  ['555-123-4567', 'too_many_digits'],
  ['A1B2C3D4E5', 'too_many_digits'],
  // word filter: plain, leetspeak, diacritics, repeats, spacing, full-width
  ['Fuck', 'not_nice'],
  ['fuuuuuck', 'not_nice'],
  ['f.u.c.k', 'not_nice'],
  ['F U C K', 'not_nice'],
  ['ｆｕｃｋ', 'not_nice'],
  ['B1tch', 'not_nice'],
  ['Bítch', 'not_nice'],
  ['Big Bitch', 'not_nice'],
  ['Sh1t', 'not_nice'],
  ['5h1t', 'not_nice'],
  ['Mia Shit', 'not_nice'],
  ['Shithead99', 'not_nice'],
  ['BULLSHIT', 'not_nice'],
  ['A55', 'not_nice'],
  ['A55hole', 'not_nice'],
  ['Peni5', 'not_nice'],
  ['N1gg3r', 'not_nice'],
  ['F4g', 'not_nice'],
  ['Fagg0t', 'not_nice'],
  ['C0ck', 'not_nice'],
  ['Dick Head', 'not_nice'],
  ['Mr Wanker', 'not_nice'],
  ['Hitler', 'not_nice'],
  ['Retarded', 'not_nice'],
];

describe('normalizeName / nameKey', () => {
  it('applies NFKC, trims and collapses whitespace', () => {
    expect(normalizeName('  Mia   Rose  ')).toBe('Mia Rose');
    expect(normalizeName('Mia  Rose')).toBe('Mia Rose');
    expect(normalizeName('Mia\n\tRose')).toBe('Mia Rose');
    expect(normalizeName('ＭＩＡ')).toBe('MIA');
    expect(normalizeName('Zoë')).toBe('Zoë');
    expect(normalizeName('')).toBe('');
    expect(normalizeName(normalizeName(' a  b '))).toBe('a b');
  });

  it('nameKey is the lower-cased normalised name', () => {
    expect(nameKey('Mia')).toBe('mia');
    expect(nameKey('  MIA  ROSE ')).toBe('mia rose');
    expect(nameKey('ＭＩＡ')).toBe(nameKey('mia'));
    expect(nameKey('Zoë')).toBe(nameKey('ZOË'));
    expect(nameKey('Mia')).not.toBe(nameKey('Mía'));
  });

  it('counts graphemes, not code points', () => {
    expect(graphemeCount('Mia')).toBe(3);
    expect(graphemeCount(KI.repeat(16))).toBe(16);
    expect(KI.repeat(16)).toHaveLength(32);
  });
});

describe('checkName', () => {
  for (const [raw, name] of ACCEPTED) {
    it(`accepts ${JSON.stringify(raw)}`, () => {
      expect(checkName(raw)).toEqual({ ok: true, name, key: nameKey(name) });
    });
  }

  for (const [raw, problem] of REJECTED) {
    it(`rejects ${JSON.stringify(raw)} as ${problem}`, () => {
      expect(checkName(raw)).toEqual({ ok: false, problem, message: NAME_MESSAGES[problem] });
    });
  }

  it('uses the kid-friendly messages of api.md §6', () => {
    expect(NAME_MESSAGES).toEqual({
      empty: 'Type a name first.',
      too_long: 'That name is a bit long. Try a shorter one.',
      bad_chars: 'Use letters and numbers only.',
      too_many_digits: 'Use fewer numbers.',
      looks_like_contact: 'Use a nickname, not an email or website.',
      not_nice: "Let's pick a different name.",
    });
  });

  it('allows exactly NAME_MAX_GRAPHEMES graphemes and 4 digits', () => {
    expect(NAME_MAX_GRAPHEMES).toBe(16);
    expect(checkName('x'.repeat(16)).ok).toBe(true);
    expect(checkName('x'.repeat(17))).toMatchObject({ ok: false, problem: 'too_long' });
    expect(checkName('Mia 1234').ok).toBe(true);
    expect(checkName('Mia 12345')).toMatchObject({ ok: false, problem: 'too_many_digits' });
  });

  it('returns the normalised name and its key', () => {
    const r = checkName('  Mia   ROSE ');
    expect(r).toEqual({ ok: true, name: 'Mia ROSE', key: 'mia rose' });
  });
});

describe('wordlist', () => {
  it('is versioned', () => {
    expect(WORDLIST_VERSION).toBe(2);
  });

  it('holds 100–200 unique lower-case skeletons', () => {
    expect(BLOCKED_WORDS.length).toBeGreaterThanOrEqual(100);
    expect(BLOCKED_WORDS.length).toBeLessThanOrEqual(200);
    expect(new Set(BLOCKED_WORDS).size).toBe(BLOCKED_WORDS.length);
    for (const w of BLOCKED_WORDS) {
      expect(w).toMatch(/^[a-z]+$/);
      expect(nameSkeleton(w)).toBe(w);
    }
  });

  it('blocks every entry typed as a name', () => {
    for (const w of BLOCKED_WORDS) {
      expect(isBlockedName(w)).toBe(true);
      expect(checkName(w)).toMatchObject({ ok: false, problem: 'not_nice' });
    }
  });

  it('builds skeletons as documented', () => {
    expect(nameSkeleton('B1tch')).toBe('bitch');
    expect(nameSkeleton('A55 hole')).toBe('ashole');
    expect(nameSkeleton('Fùùùck!')).toBe('fuck');
    expect(nameSkeleton('0137 45')).toBe('oietas');
    expect(nameSkeleton('Mia-Rose 2')).toBe('miarose');
  });

  it('matches short entries only as whole tokens', () => {
    expect(isBlockedName('Mia Cock')).toBe(true);
    expect(isBlockedName('Peacock')).toBe(false);
    expect(isBlockedName('Mia-Shit')).toBe(true);
    expect(isBlockedName('Shitake')).toBe(false);
  });

  it('matches long entries anywhere', () => {
    expect(isBlockedName('Superbitchy')).toBe(true);
    expect(isBlockedName('Big Bastards')).toBe(true);
  });
});

describe('limits', () => {
  it('pins the shared numbers', () => {
    expect(MAX_PROFILES_DEFAULT).toBe(8);
    expect(AVATAR_COLORS).toBe(8);
    expect(SNAPSHOTS_PER_CALL).toBe(48);
    expect(UNIQUE_PLAY_THRESHOLD_S).toBe(120);
    expect(LEASE_SECONDS_DEFAULT).toBe(150);
  });

  it('AVATAR_ANIMALS is exactly the AvatarAnimal union', () => {
    // Compile-time: every list entry is an AvatarAnimal, and this record must name every AvatarAnimal.
    const fromList: readonly AvatarAnimal[] = AVATAR_ANIMALS;
    const every: Record<AvatarAnimal, true> = {
      lion: true, giraffe: true, elephant: true, zebra: true, penguin: true,
      hippo: true, tiger: true, bear: true, gorilla: true, flamingo: true,
    };
    expect([...fromList].sort()).toEqual(Object.keys(every).sort());
    expect(new Set(AVATAR_ANIMALS).size).toBe(10);
  });
});
