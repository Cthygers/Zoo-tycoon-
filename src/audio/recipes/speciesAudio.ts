// What each species sounds like and when: syllable banks, bout grammars,
// levels, daily activity, contagion and colony murmur. Pure data consumed by
// the fauna module; the syllables themselves are rendered from animals.ts
// (whose SYLLABLES table is the single source of variant counts and lengths).

import { SYLLABLES } from './animals';

export { sylId } from './animals';

export type BoutKind = 'call' | 'night' | 'contact' | 'display' | 'idle' | 'eat' | 'social' | 'alarm' | 'juvenile';
export interface SylBank {
  variants: number; // registered ids sylId(voice, syl, 0..variants-1)
  lowSpecVariants?: number; // default 2
  dur: number; // nominal duration, s (for planning before render)
}
export interface Step {
  syl: string; // syllable type in this species' bank
  n: readonly [number, number]; // repetitions (inclusive)
  ioi: readonly [number, number]; // first onset-to-onset interval, s
  grow?: number; // IOI × per repetition (default 1)
  ioiMax?: number; // cap for the grown IOI
  gap?: readonly [number, number]; // pause after the previous step's last syllable ends (default [0.1, 0.3])
  db?: number; // step level re the bout level (default 0)
  dbStep?: number; // dB per repetition (default 0)
  peak?: number; // index of the loudest repetition (−1.5 dB per index away)
  rateStep?: number; // playbackRate × per repetition (default 1)
  p?: number; // probability that the step happens (default 1)
}
export interface Bout {
  kind: BoutKind;
  steps: readonly Step[];
  w?: number; // weight among bouts of the same kind / scheduled kinds (default 1)
  refDist?: number; // override of the species value
  radius?: number;
  sex?: 'M' | 'F'; // only animals of this sex
}
export interface SpeciesAudio {
  voice: string;
  levels: Readonly<Partial<Record<BoutKind, number>>>; // dB re lion roar (0)
  refDist: number;
  radius: number;
  chatty: number; // 0..1 idle propensity
  activity: readonly number[]; // 24 hourly multipliers for scheduled bouts
  boutsPerMin: number; // scheduled bouts / min per in-range group at activity 1
  callsWhileAsleep: boolean;
  contagion?: { p: number; delay: readonly [number, number]; radius: number };
  syllables: Readonly<Record<string, SylBank>>;
  bouts: readonly Bout[];
  rateJitter: number; // per play ±
  pitchSpread: number; // per individual ±
  formant: { hz: number; db: number }; // per-individual colour filter centre and ±dB
  colony?: { loopId: string; night: number };
}

/** The bank of a voice, derived from the registered syllable variants. */
function banks(voice: string): Record<string, SylBank> {
  const out: Record<string, SylBank> = {};
  for (const [syl, def] of Object.entries(SYLLABLES[voice])) out[syl] = { variants: def.n, lowSpecVariants: def.lowSpec, dur: (def.d[0] + def.d[1]) / 2 };
  return out;
}

/** 24 hourly values: `base`, with inclusive hour spans [from, to, value] (spans may wrap midnight). */
function hours(base: number, ...spans: (readonly [number, number, number])[]): number[] {
  const out = new Array<number>(24).fill(base);
  for (const [from, to, v] of spans) for (let h = from; ; h = (h + 1) % 24) {
    out[h] = v;
    if (h === to) break;
  }
  return out;
}

/** Day (06–19 h) and night values. */
function dayNight(day: number, night: number): number[] {
  return hours(night, [6, 19, day]);
}

const one = [1, 1] as const;

/** Single-syllable step. */
function once(syl: string, db?: number): Step {
  return { syl, n: one, ioi: one, db };
}

export const SPECIES_AUDIO: Readonly<Record<string, SpeciesAudio>> = {
  lion: {
    voice: 'lion',
    levels: { call: 0, idle: -12, eat: -8, social: -12, juvenile: -10 },
    refDist: 25,
    radius: 250,
    chatty: 0.4,
    // day base 0.1 (plan 0.15) keeps night ≥ 4× day now that bouts are more frequent
    activity: hours(0.1, [22, 2, 0.6], [19, 21, 1], [3, 5, 1]),
    // an in-game night lasts ~3.7 real minutes at 1×: 0.5 (plan 0.3) gives a pride about 1.5
    // scheduled roaring bouts per night, plus contagion joins (0.8 roared almost non-stop)
    boutsPerMin: 0.5,
    callsWhileAsleep: true,
    contagion: { p: 0.6, delay: [2, 8], radius: 80 },
    syllables: banks('lion'),
    bouts: [
      {
        kind: 'call',
        steps: [
          { syl: 'inhale', n: one, ioi: [0.3, 0.3], p: 0.5, db: -20 },
          { syl: 'moan', n: [1, 3], ioi: [1.2, 2] },
          { syl: 'roar', n: [3, 5], ioi: [2, 3.5], peak: 1, gap: [0.8, 1.5] },
          { syl: 'grunt', n: [13, 18], ioi: [0.9, 0.9], grow: 1.05, ioiMax: 1.9, dbStep: -1.5, gap: [1, 2] },
        ],
      },
      { kind: 'idle', steps: [{ syl: 'huff', n: [1, 2], ioi: [0.4, 0.6] }] },
      { kind: 'eat', steps: [once('growl')] },
      { kind: 'social', steps: [{ syl: 'grunt', n: [2, 4], ioi: [0.5, 0.8], dbStep: -1 }] },
      { kind: 'juvenile', steps: [{ syl: 'juv', n: [1, 3], ioi: [0.7, 1.2] }] },
    ],
    rateJitter: 0.03,
    pitchSpread: 0.06,
    formant: { hz: 850, db: 3 },
  },
  tiger: {
    voice: 'tiger',
    levels: { call: -2, social: -14, idle: -14, eat: -8, alarm: -8 },
    refDist: 15,
    radius: 150,
    chatty: 0.3,
    activity: hours(0.2, [23, 3, 0.5], [18, 22, 1], [4, 5, 1]),
    boutsPerMin: 0.15,
    callsWhileAsleep: false,
    syllables: banks('tiger'),
    bouts: [
      { kind: 'call', steps: [{ syl: 'main', n: [1, 3], ioi: [8, 20] }] },
      { kind: 'social', steps: [once('prusten')] },
      { kind: 'idle', steps: [once('prusten')] },
      { kind: 'eat', steps: [once('growl')] },
      { kind: 'alarm', steps: [once('hiss'), { ...once('growl'), p: 0.5 }] },
    ],
    rateJitter: 0.03,
    pitchSpread: 0.06,
    formant: { hz: 1000, db: 3 },
  },
  grizzly: {
    voice: 'grizzly',
    levels: { call: -7, idle: -16, eat: -16, social: -14 },
    refDist: 10,
    radius: 80,
    chatty: 0.3,
    activity: dayNight(0.5, 0.1),
    boutsPerMin: 0.1,
    callsWhileAsleep: false,
    syllables: banks('grizzly'),
    bouts: [
      {
        kind: 'call',
        w: 0.8,
        steps: [
          { syl: 'huff', n: [2, 4], ioi: [0.3, 0.5] },
          { syl: 'jawpop', n: [3, 8], ioi: [0.12, 0.4], gap: [0.2, 0.5] },
          { ...once('moan'), p: 0.5 },
        ],
      },
      { kind: 'call', w: 0.15, steps: [once('growl', 2)] },
      { kind: 'call', w: 0.05, steps: [once('roar', 4)] },
      { kind: 'idle', steps: [once('sniff')] },
      { kind: 'eat', steps: [once('sniff')] },
      { kind: 'social', steps: [{ syl: 'huff', n: [1, 2], ioi: [0.3, 0.5] }] },
    ],
    rateJitter: 0.03,
    pitchSpread: 0.06,
    formant: { hz: 900, db: 3 },
  },
  polarbear: {
    voice: 'polarbear',
    levels: { call: -7, idle: -16, eat: -16, social: -14 },
    refDist: 10,
    radius: 80,
    chatty: 0.3,
    activity: dayNight(0.5, 0.1),
    boutsPerMin: 0.1,
    callsWhileAsleep: false,
    syllables: banks('polarbear'),
    bouts: [
      {
        kind: 'call',
        w: 0.8,
        steps: [
          { ...once('hiss'), p: 0.3 },
          { syl: 'huff', n: [2, 4], ioi: [0.3, 0.5] },
          { syl: 'jawpop', n: [3, 10], ioi: [0.12, 0.4], gap: [0.2, 0.5] },
          { ...once('moan'), p: 0.5 },
        ],
      },
      { kind: 'call', w: 0.15, steps: [once('growl', 2)] },
      { kind: 'call', w: 0.05, steps: [once('roar', 4)] },
      { kind: 'idle', steps: [once('sniff')] },
      { kind: 'eat', steps: [once('sniff')] },
      { kind: 'social', steps: [once('chuff')] },
    ],
    rateJitter: 0.03,
    pitchSpread: 0.06,
    formant: { hz: 900, db: 3 },
  },
  elephant: {
    voice: 'elephant',
    levels: { call: 0, contact: -6, idle: -14, eat: -12, social: -8, juvenile: -10 },
    refDist: 15,
    radius: 150,
    chatty: 0.4,
    activity: hours(0.6),
    boutsPerMin: 1.0,
    callsWhileAsleep: true,
    contagion: { p: 0.5, delay: [0, 2], radius: 80 },
    syllables: banks('elephant'),
    bouts: [
      { kind: 'call', w: 0.1, refDist: 25, radius: 250, steps: [{ syl: 'trumpet', n: [1, 2], ioi: [1.5, 3] }] },
      { kind: 'contact', w: 0.9, refDist: 15, radius: 150, steps: [{ syl: 'rumble', n: [1, 2], ioi: [3, 8] }] },
      { kind: 'idle', steps: [once('snort')] },
      { kind: 'eat', steps: [once('rumble')] },
      { kind: 'social', steps: [{ syl: 'rumble', n: [1, 2], ioi: [2.5, 5] }] },
      { kind: 'juvenile', steps: [{ syl: 'juv', n: [1, 3], ioi: [0.6, 1.1] }] },
    ],
    rateJitter: 0.03,
    pitchSpread: 0.06,
    formant: { hz: 520, db: 3 },
  },
  hippo: {
    voice: 'hippo',
    levels: { call: -1, idle: -12, eat: -14, social: -12, juvenile: -10 },
    refDist: 25,
    radius: 250,
    chatty: 0.3,
    activity: hours(0.3, [23, 3, 0.4], [18, 22, 1], [4, 6, 1]),
    boutsPerMin: 0.8,
    callsWhileAsleep: true,
    contagion: { p: 0.7, delay: [1, 5], radius: 120 },
    syllables: banks('hippo'),
    bouts: [
      {
        kind: 'call',
        steps: [
          once('wheeze'),
          { syl: 'honk', n: [4, 10], ioi: [0.3, 0.3], grow: 1.06, ioiMax: 0.5, dbStep: -1.5, gap: [0.1, 0.2] },
          { ...once('grunt'), p: 0.6 },
        ],
      },
      { kind: 'idle', steps: [{ syl: 'grunt', n: [1, 2], ioi: [0.5, 0.9] }] },
      { kind: 'eat', steps: [once('grunt')] },
      { kind: 'social', steps: [{ syl: 'grunt', n: [1, 2], ioi: [0.5, 0.9] }] },
      { kind: 'juvenile', steps: [{ syl: 'juv', n: [1, 3], ioi: [0.5, 0.9] }] },
    ],
    rateJitter: 0.03,
    pitchSpread: 0.06,
    formant: { hz: 900, db: 3 },
  },
  rhino: {
    voice: 'rhino',
    levels: { call: -7, idle: -12, social: -8, eat: -14 },
    refDist: 10,
    radius: 80,
    chatty: 0.3,
    activity: dayNight(0.5, 0.3),
    boutsPerMin: 0.15,
    callsWhileAsleep: false,
    syllables: banks('rhino'),
    bouts: [
      { kind: 'call', steps: [{ syl: 'snort', n: [2, 4], ioi: [0.4, 0.7] }, { ...once('pant'), p: 0.4 }] },
      { kind: 'idle', w: 0.7, steps: [{ syl: 'puff', n: [1, 2], ioi: [0.5, 0.9] }] },
      { kind: 'idle', w: 0.3, steps: [once('hic')] },
      { kind: 'social', steps: [once('growl')] },
      { kind: 'eat', steps: [once('puff')] },
    ],
    rateJitter: 0.03,
    pitchSpread: 0.06,
    formant: { hz: 900, db: 3 },
  },
  giraffe: {
    voice: 'giraffe',
    levels: { call: -10, night: -11, idle: -14 },
    refDist: 10,
    radius: 80,
    chatty: 0.03,
    activity: hours(0.05, [21, 4, 1]),
    boutsPerMin: 0.5,
    callsWhileAsleep: true,
    syllables: banks('giraffe'),
    bouts: [
      { kind: 'call', steps: [{ syl: 'snort', n: [1, 2], ioi: [0.4, 0.8] }] },
      { kind: 'night', steps: [{ syl: 'hum', n: [1, 3], ioi: [4, 12] }] },
      { kind: 'idle', steps: [once('snort')] },
    ],
    rateJitter: 0.03,
    pitchSpread: 0.05,
    formant: { hz: 520, db: 3 },
  },
  camel: {
    voice: 'camel',
    levels: { call: -4, idle: -10, display: -6, eat: -12, social: -10 },
    refDist: 10,
    radius: 80,
    chatty: 0.3,
    activity: dayNight(0.4, 0.1),
    boutsPerMin: 0.15,
    callsWhileAsleep: false,
    syllables: banks('camel'),
    bouts: [
      { kind: 'call', steps: [{ syl: 'groan', n: [1, 2], ioi: [3, 6] }] },
      { kind: 'idle', steps: [once('grumble')] },
      { kind: 'display', sex: 'M', w: 0.2, steps: [once('gurgle')] },
      { kind: 'eat', steps: [once('grumble')] },
      { kind: 'social', steps: [once('grumble')] },
    ],
    rateJitter: 0.03,
    pitchSpread: 0.06,
    formant: { hz: 900, db: 3 },
  },
  zebra: {
    voice: 'zebra',
    levels: { call: -4, idle: -12, alarm: -6, eat: -14, social: -12, juvenile: -10 },
    refDist: 15,
    radius: 150,
    chatty: 0.5,
    activity: hours(0.15, [8, 16, 0.4], [5, 7, 1], [17, 19, 1]),
    boutsPerMin: 0.3,
    callsWhileAsleep: false,
    contagion: { p: 0.4, delay: [0.5, 3], radius: 80 },
    syllables: banks('zebra'),
    bouts: [
      {
        kind: 'call',
        // one piece: its inhale-exhale cycles run back to back (animals.ts zebraBray)
        steps: [once('bray')],
      },
      { kind: 'idle', steps: [once('blow')] },
      { kind: 'alarm', steps: [{ syl: 'snort', n: [1, 2], ioi: [0.2, 0.35] }] },
      { kind: 'eat', steps: [once('blow')] },
      { kind: 'social', steps: [once('blow')] },
      { kind: 'juvenile', steps: [{ syl: 'juv', n: [1, 2], ioi: [0.7, 1.2] }] },
    ],
    rateJitter: 0.03,
    pitchSpread: 0.06,
    formant: { hz: 2000, db: 3 },
  },
  gazelle: {
    voice: 'gazelle',
    levels: { call: -10, alarm: -10, idle: -14, social: -14 },
    refDist: 10,
    radius: 80,
    chatty: 0.2,
    activity: dayNight(0.3, 0.1),
    boutsPerMin: 0.1,
    callsWhileAsleep: false,
    syllables: banks('gazelle'),
    bouts: [
      { kind: 'call', steps: [{ syl: 'snort', n: [1, 3], ioi: [0.25, 0.4] }] },
      { kind: 'alarm', steps: [{ syl: 'snort', n: [1, 3], ioi: [0.25, 0.4] }] },
      { kind: 'idle', steps: [once('bleat')] },
      { kind: 'social', steps: [once('bleat')] },
    ],
    rateJitter: 0.04,
    pitchSpread: 0.06,
    formant: { hz: 1800, db: 3 },
  },
  gorilla: {
    voice: 'gorilla',
    levels: { display: -3, idle: -12, eat: -12, contact: -10, social: -12 },
    refDist: 15,
    radius: 150,
    chatty: 0.5,
    activity: hours(0, [6, 9, 1], [10, 18, 0.4]),
    boutsPerMin: 0.15,
    callsWhileAsleep: false,
    contagion: { p: 0.2, delay: [2, 6], radius: 40 },
    syllables: banks('gorilla'),
    bouts: [
      { kind: 'display', steps: [{ syl: 'hoot', n: [4, 12], ioi: [0.5, 0.5], grow: 0.88 }, { ...once('beat'), gap: [0.3, 0.8] }] },
      { kind: 'idle', steps: [{ syl: 'belch', n: [1, 2], ioi: [0.5, 1] }] },
      { kind: 'eat', steps: [{ syl: 'belch', n: [1, 2], ioi: [0.5, 1] }] },
      { kind: 'contact', w: 0.6, steps: [{ syl: 'piggrunt', n: [3, 8], ioi: [0.22, 0.28] }] },
      { kind: 'social', steps: [{ syl: 'belch', n: [2, 2], ioi: [0.6, 1] }] },
    ],
    rateJitter: 0.03,
    pitchSpread: 0.06,
    formant: { hz: 700, db: 3 },
  },
  penguin: {
    voice: 'penguin',
    levels: { call: -5, idle: -9, contact: -9, social: -9, juvenile: -10 },
    refDist: 10,
    radius: 80,
    chatty: 0.9,
    activity: hours(0.4, [9, 16, 0.6], [5, 8, 1], [17, 20, 1]),
    boutsPerMin: 0.6,
    callsWhileAsleep: true,
    contagion: { p: 0.5, delay: [1, 4], radius: 40 },
    syllables: banks('penguin'),
    bouts: [
      {
        kind: 'call',
        steps: [
          // pairs (≤ 0.45 s) start at least 0.58 s apart: each inhaled whistle is heard
          { syl: 'pair', n: [2, 5], ioi: [0.58, 0.64], grow: 1.03, rateStep: 1.02 },
          { ...once('final'), gap: [0.05, 0.15] },
        ],
      },
      { kind: 'idle', steps: [once('contact')] },
      { kind: 'contact', steps: [once('contact')] },
      { kind: 'social', steps: [{ syl: 'contact', n: [1, 2], ioi: [0.5, 0.9] }] },
      { kind: 'juvenile', steps: [{ syl: 'juv', n: [1, 2], ioi: [0.8, 1.4] }] },
    ],
    rateJitter: 0.05,
    pitchSpread: 0.06,
    formant: { hz: 1000, db: 3 },
    colony: { loopId: 'loop.colony.penguin', night: 0.4 },
  },
  flamingo: {
    voice: 'flamingo',
    levels: { call: -7, idle: -9, eat: -12, social: -9 },
    refDist: 10,
    radius: 80,
    chatty: 1.0,
    activity: dayNight(1, 0.5),
    boutsPerMin: 0.5,
    callsWhileAsleep: false,
    contagion: { p: 0.5, delay: [0.3, 2], radius: 40 },
    syllables: banks('flamingo'),
    bouts: [
      { kind: 'call', steps: [{ syl: 'honk', n: [6, 12], ioi: [0.12, 0.26] }] },
      { kind: 'idle', w: 0.8, steps: [{ syl: 'honk', n: [1, 3], ioi: [0.15, 0.3] }] },
      { kind: 'idle', w: 0.2, steps: [{ syl: 'grunt', n: [1, 2], ioi: [0.15, 0.3] }] },
      { kind: 'eat', steps: [{ syl: 'grunt', n: [2, 4], ioi: [0.15, 0.3] }] },
      { kind: 'social', steps: [{ syl: 'honk', n: [1, 3], ioi: [0.15, 0.3] }] },
    ],
    rateJitter: 0.05,
    pitchSpread: 0.06,
    formant: { hz: 1300, db: 3 },
    colony: { loopId: 'loop.colony.flamingo', night: 0.5 },
  },
};
