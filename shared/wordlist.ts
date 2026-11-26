// shared/wordlist.ts — blocklist for profile names (checked by shared/names.ts checkName()).
// Data only. No DOM, no Node APIs, no dependencies.
//
// Every entry is a lower-case SKELETON, exactly what names.ts builds from a name: lower-case, diacritics
// stripped, leetspeak mapped (0→o 1→i 3→e 4→a 5→s 7→t @→a $→s), non-letters dropped, repeated letters
// collapsed ('asshole' → 'ashole', 'nigger' → 'niger'). Entries of 5+ letters match anywhere in the name's
// skeleton; shorter entries only match a whole token (or the whole name), which avoids the Scunthorpe problem.
// Entries that hit ordinary names across a word gap ('Sasha Tiger', 'Rowan King', 'Prince Steve') are left out.
// Bump WORDLIST_VERSION whenever the list changes; the server re-checks stored names against it.

export const WORDLIST_VERSION: number = 2;

export const BLOCKED_WORDS: readonly string[] = Object.freeze([
  'fuck', 'fucker', 'fuckin', 'fucked', 'fucks', 'fuckface', 'fuckhead', 'fuckwit', 'fucktard', 'fuckboy',
  'fuckof', 'fuckyou', 'dumbfuck', 'mofo', 'fck', 'fuk', 'shit', 'shithead', 'shitface', 'shity', 'bulshit',
  'shithole', 'horseshit', 'dipshit', 'bitch', 'bastard', 'cunt', 'cunts', 'twat', 'dick', 'dickhead',
  'dickface', 'cock', 'cocksucker', 'pusy', 'pusies', 'slut', 'sluts', 'sluty', 'whore', 'hoe', 'skank', 'tit',
  'tits', 'tity', 'tities', 'cum', 'cumshot', 'cumslut', 'jiz', 'jism', 'sex', 'sexy', 'porn', 'porno',
  'pornhub', 'nude', 'nudes', 'penis', 'vagina', 'anus', 'anal', 'clit', 'clitoris', 'dildo', 'orgasm', 'orgy',
  'blowjob', 'handjob', 'rimjob', 'wank', 'wanker', 'jerkof', 'jackof', 'masturbate', 'balsack', 'nutsack',
  'scrotum', 'testicle', 'bolocks', 'as', 'arse', 'arsehole', 'ashole', 'aswipe', 'dumbas', 'buthole',
  'butface', 'pis', 'crap', 'damn', 'godamn', 'douche', 'turd', 'milf', 'thot', 'pimp', 'pedo', 'paedo',
  'pedophile', 'molester', 'rape', 'rapist', 'kys', 'kilyourself', 'hitler', 'nazi', 'heil', 'swastika', 'wtf',
  'stfu', 'gtfo', 'niger', 'niga', 'nigah', 'nigas', 'nig', 'chink', 'gok', 'spic', 'wetback', 'beaner',
  'kike', 'kyke', 'raghead', 'towelhead', 'paki', 'jap', 'darkie', 'jigabo', 'porchmonkey', 'ziperhead',
  'redskin', 'wop', 'dago', 'polack', 'honky', 'fagot', 'fag', 'fags', 'dyke', 'homo', 'shemale', 'retard',
  'tard', 'spaz', 'spastic', 'mongoloid', 'chingchong', 'slanteye', 'goliwog', 'hymie', 'yid', 'cameljockey',
  'junglebuny',
]);
