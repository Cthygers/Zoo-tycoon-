// shared/names.ts — profile-name normalisation and filter, used by the server and the account UI.
// No DOM, no Node APIs, no dependencies. Files inside shared/ import each other with '.js' suffixes.
import { NAME_MAX_GRAPHEMES } from './limits.js';
import { BLOCKED_WORDS } from './wordlist.js';

export type NameProblem = 'empty' | 'too_long' | 'bad_chars' | 'too_many_digits' | 'looks_like_contact' | 'not_nice';

/** Kid-friendly text for each problem (api.md §6). */
export const NAME_MESSAGES: Readonly<Record<NameProblem, string>> = {
  empty: 'Type a name first.',
  too_long: 'That name is a bit long. Try a shorter one.',
  bad_chars: 'Use letters and numbers only.',
  too_many_digits: 'Use fewer numbers.',
  looks_like_contact: 'Use a nickname, not an email or website.',
  not_nice: "Let's pick a different name.",
};

/** At most this many digits (\p{N}) in a name: rules out phone numbers. */
export const NAME_MAX_DIGITS = 4;

/** NFKC, trim, collapse internal whitespace to one space. */
export function normalizeName(raw: string): string {
  return String(raw ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/** Lower-cased normalised name used for per-account uniqueness. */
export function nameKey(name: string): string {
  return normalizeName(name).toLowerCase();
}

type SegmenterCtor = new (locales?: string, options?: { granularity: 'grapheme' }) => {
  segment(input: string): Iterable<unknown>;
};
let segmenter: { segment(input: string): Iterable<unknown> } | null | undefined;

/** Graphemes via Intl.Segmenter when the runtime has it, else code points. */
export function graphemeCount(s: string): number {
  if (segmenter === undefined) {
    const Ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
    segmenter = typeof Ctor === 'function' ? new Ctor(undefined, { granularity: 'grapheme' }) : null;
  }
  return segmenter ? Array.from(segmenter.segment(s)).length : Array.from(s).length;
}

const LEET: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

/**
 * Cyrillic, Greek and other letters that look like Latin ones, upper and lower case (homoglyphs:
 * 'Fuсk' with a Cyrillic с). Upper case is looked up before lower-casing, so 'Η' (Eta) reads as h, 'η' as n.
 */
const CONFUSABLE: Readonly<Record<string, string>> = {
  // Cyrillic
  'А': 'a', 'В': 'b', 'Е': 'e', 'К': 'k', 'М': 'm', 'Н': 'h', 'О': 'o', 'Р': 'p', 'С': 'c', 'Т': 't', 'У': 'y', 'Х': 'x',
  'Ѕ': 's', 'І': 'i', 'Ј': 'j', 'Ԁ': 'd', 'Ӏ': 'l', 'Һ': 'h', 'Ԛ': 'q', 'Ԝ': 'w',
  'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x',
  'ѕ': 's', 'і': 'i', 'ј': 'j', 'ԁ': 'd', 'ӏ': 'l', 'һ': 'h', 'ԛ': 'q', 'ԝ': 'w',
  // Greek
  'Α': 'a', 'Β': 'b', 'Ε': 'e', 'Ζ': 'z', 'Η': 'h', 'Ι': 'i', 'Κ': 'k', 'Μ': 'm', 'Ν': 'n', 'Ο': 'o', 'Ρ': 'p', 'Τ': 't',
  'Υ': 'y', 'Χ': 'x',
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ϲ': 'c',
  // Latin script g, Armenian
  'ɡ': 'g', 'ս': 'u', 'օ': 'o',
};

function collapseRepeats(s: string): string {
  return s.replace(/(.)\1+/gu, '$1');
}

/**
 * The name's skeleton split into tokens: strip diacritics, map leetspeak (0→o 1→i 3→e 4→a 5→s 7→t @→a $→s)
 * and Latin lookalikes (CONFUSABLE), lower-case, then split at every non-letter (dropping it) and collapse
 * repeated letters.
 */
export function skeletonTokens(raw: string): string[] {
  const base = normalizeName(raw).normalize('NFD').replace(/\p{M}/gu, '');
  let mapped = '';
  for (const ch of base) {
    const lower = ch.toLowerCase();
    mapped += LEET[ch] ?? CONFUSABLE[ch] ?? CONFUSABLE[lower] ?? lower;
  }
  return mapped.split(/[^\p{L}]+/u).filter((t) => t.length > 0).map(collapseRepeats);
}

/** The whole skeleton: every non-letter dropped, repeats collapsed ('B1tch' → 'bitch', 'A55 hole' → 'ashole'). */
export function nameSkeleton(raw: string): string {
  return collapseRepeats(skeletonTokens(raw).join(''));
}

const LONG_WORDS = BLOCKED_WORDS.filter((w) => w.length >= 5);
const SHORT_WORDS = new Set(BLOCKED_WORDS.filter((w) => w.length < 5));
/** Short roots no name starts or ends with: they also match glued to other letters ('Cuntface', 'Bigtwat'). */
const GLUED_ROOTS = ['cunt', 'twat', 'fck'] as const;
const VOWELS = 'aiou';

/**
 * 'shit' glued to other letters ('Shitbag', 'Batshit'), but not the names Shital, Shitara, Shitanshu (vowel after)
 * or Harshit, Akshit, Rakshit, Ashit, Rushit (k, r or a vowel before). Shitake stays allowed.
 */
function gluedShit(t: string): boolean {
  if (t.length <= 4) return false;
  if (t.startsWith('shit') && !VOWELS.includes(t[4]!)) return true;
  if (t.endsWith('shit') && !(VOWELS + 'kr').includes(t[t.length - 5]!)) return true;
  return false;
}

/** Skeleton filter: entries ≥ 5 letters match as substrings; shorter ones only as a whole token or the whole name. */
export function isBlockedName(raw: string): boolean {
  const tokens = skeletonTokens(raw);
  const whole = collapseRepeats(tokens.join(''));
  if (whole.length === 0) return false;
  if (SHORT_WORDS.has(whole)) return true;
  for (const t of tokens) if (SHORT_WORDS.has(t)) return true;
  for (const w of LONG_WORDS) if (whole.includes(w)) return true;
  if (whole.includes('fuck')) return true; // 'BigFuck', 'Fuckhole': in no name
  for (const t of tokens) {
    if (gluedShit(t)) return true;
    for (const r of GLUED_ROOTS) if (t.length > r.length && (t.startsWith(r) || t.endsWith(r))) return true;
  }
  return false;
}

const CONTACT_MARKS = ['@', 'http', 'www', '.com', '.net', '.org'] as const;
const ALLOWED_CHARS = /^[\p{L}\p{M}\p{N} .'-]+$/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/gu;
/** Generic combining diacritics (Latin, Greek and Cyrillic letters come precomposed after NFKC). */
const STACKED_DIACRITICS = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]{3,}/u;
/** Nonspacing marks of any script: Tibetan stacks reach 3, Thai/Devanagari/Burmese 2. */
const STACKED_MARKS = /\p{Mn}{4,}/u;
export const NAME_MAX_CODE_POINTS = 64;

function fail(problem: NameProblem): { ok: false; problem: NameProblem; message: string } {
  return { ok: false, problem, message: NAME_MESSAGES[problem] };
}

/**
 * Checks a profile name. The checks run in this order and the first failure is returned:
 * 1. empty after normalizeName → 'empty';
 * 2. contains '@', 'http', 'www', '.com', '.net' or '.org' (any case) → 'looks_like_contact';
 * 3. more than NAME_MAX_GRAPHEMES (16) graphemes → 'too_long';
 * 4. a character outside [\p{L}\p{M}\p{N} .'-], no letter/digit at all, 3+ generic combining diacritics in a row,
 *    4+ nonspacing marks in a row, or more than NAME_MAX_CODE_POINTS (64) code points ("Zalgo") → 'bad_chars';
 * 5. more than 4 digits → 'too_many_digits';
 * 6. skeleton hits BLOCKED_WORDS → 'not_nice'.
 * On success `name` is the normalised name to store and `key` its nameKey().
 */
export function checkName(raw: string):
  | { ok: true; name: string; key: string }
  | { ok: false; problem: NameProblem; message: string } {
  const name = normalizeName(raw);
  if (name.length === 0) return fail('empty');
  const lower = name.toLowerCase();
  if (CONTACT_MARKS.some((m) => lower.includes(m))) return fail('looks_like_contact');
  if (graphemeCount(name) > NAME_MAX_GRAPHEMES) return fail('too_long');
  if (!ALLOWED_CHARS.test(name) || !HAS_LETTER_OR_DIGIT.test(name)) return fail('bad_chars');
  if (STACKED_DIACRITICS.test(name) || STACKED_MARKS.test(name) || Array.from(name).length > NAME_MAX_CODE_POINTS) return fail('bad_chars');
  if ((name.match(DIGIT) ?? []).length > NAME_MAX_DIGITS) return fail('too_many_digits');
  if (isBlockedName(name)) return fail('not_nice');
  return { ok: true, name, key: nameKey(name) };
}
