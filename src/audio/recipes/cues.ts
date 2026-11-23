// UI and game-feedback cues: short, soft, warm "wooden mallet" sounds.
// All original: marimba-like bars (sine partials tuned 1 : 3.93 : 9.2),
// soft knocks, small metallic coin partials and a brief celebratory figure.

import type { Partial3 } from '../kit';
import type { Recipe } from '../render';

const SR = 44100;
/** Equal-tempered frequency, semitones relative to A4. */
const st = (n: number) => 440 * Math.pow(2, n / 12);
const ROOM = { decay: 0.09, length: 0.45, bright: 0.6 };

/** Small coin / metal tab: inharmonic plate partials. */
const COIN: readonly Partial3[] = [
  [1, 1, 1],
  [2.32, 0.55, 0.62],
  [4.25, 0.32, 0.4],
  [6.63, 0.16, 0.26],
];
/** Kalimba-ish: strong fundamental, faint octave-and-a-bit partial. */
const TINE: readonly Partial3[] = [
  [1, 1, 1],
  [5.4, 0.12, 0.18],
  [2.01, 0.12, 0.5],
];

export const CUE_RECIPES: Record<string, Recipe> = {
  tap: {
    dur: 0.14,
    tail: 0.12,
    rate: SR,
    peak: 0.26,
    rms: 0.07,
    hp: 150,
    reverb: ROOM,
    build(k) {
      // warm wooden click: low-mid bar with a soft mallet
      k.bar(0.002, st(9), 0.8, { decay: 0.045, click: 0.3, wet: 0.08, lp: 4500 }); // F#5
      k.bar(0.002, st(-3), 0.35, { decay: 0.03, click: 0, wet: 0 }); // body
    },
  },
  select: {
    dur: 0.3,
    tail: 0.2,
    rate: SR,
    peak: 0.27,
    rms: 0.08,
    hp: 150,
    reverb: ROOM,
    build(k) {
      k.bar(0.002, st(10), 0.7, { decay: 0.09, click: 0.2, lp: 5000 }); // G5
      k.bar(0.055, st(17), 0.55, { decay: 0.12, click: 0.15, lp: 5500 }); // D6
    },
  },
  open: {
    dur: 0.3,
    tail: 0.2,
    rate: SR,
    peak: 0.25,
    rms: 0.075,
    hp: 150,
    reverb: ROOM,
    build(k) {
      k.burst({ t: 0, dur: 0.13, color: 'pink', band: [[0, 700], [0.13, 2600]], q: 0.9, amp: [[0, 0], [0.07, 0.1], [0.13, 0]], wet: 0.05 });
      k.bar(0.012, st(5), 0.6, { decay: 0.08, click: 0.2, lp: 4800 }); // D5
      k.bar(0.07, st(12), 0.6, { decay: 0.12, click: 0.15, lp: 5000 }); // A5
    },
  },
  close: {
    dur: 0.3,
    tail: 0.2,
    rate: SR,
    peak: 0.22,
    rms: 0.07,
    hp: 150,
    reverb: ROOM,
    build(k) {
      k.burst({ t: 0, dur: 0.12, color: 'pink', band: [[0, 2300], [0.12, 750]], q: 0.9, amp: [[0, 0], [0.05, 0.09], [0.12, 0]], wet: 0.05 });
      k.bar(0.01, st(12), 0.55, { decay: 0.07, click: 0.2, lp: 4500 }); // A5
      k.bar(0.065, st(5), 0.5, { decay: 0.1, click: 0.12, lp: 4000 }); // D5
    },
  },
  build: {
    dur: 0.6,
    tail: 0.3,
    rate: SR,
    peak: 0.42,
    rms: 0.12,
    hp: 90,
    reverb: ROOM,
    build(k) {
      // timber "thock" as the piece settles, then a warm two-bar confirmation
      k.thump(0, 230, 120, 0.11, 0.9, { wet: 0.1 });
      k.burst({ t: 0, dur: 0.05, color: 'pink', band: [[0, 1100], [0.05, 600]], q: 1.2, amp: [[0, 0], [0.002, 0.7], [0.05, 0]], wet: 0.1 });
      k.bar(0.04, st(5), 0.6, { decay: 0.22, click: 0.15, lp: 5000 }); // D5
      k.bar(0.04, st(12), 0.4, { decay: 0.2, click: 0.1, lp: 5000 }); // A5
      k.bar(0.1, st(17), 0.32, { decay: 0.26, click: 0.1, lp: 5500 }); // D6
    },
  },
  bulldoze: {
    dur: 0.55,
    tail: 0.3,
    rate: SR,
    peak: 0.38,
    rms: 0.1,
    hp: 200,
    squash: 1.5,
    reverb: ROOM,
    build(k) {
      // soft earthy crunch: a dull knock, a short rumble of soil and crumbling grains
      k.thump(0, 240, 120, 0.13, 0.8, { wet: 0.12 });
      k.burst({ t: 0, dur: 0.3, color: 'brown', band: [[0, 650], [0.3, 380]], q: 0.9, amp: [[0, 0], [0.01, 0.9], [0.3, 0]], wet: 0.1 });
      for (let i = 0; i < 12; i++) {
        const t = 0.02 + k.rng.range(0, 0.36) * (i / 12 + 0.3);
        const a = (1 - i / 14) * k.rng.range(0.3, 0.6);
        k.burst({ t, dur: 0.03, color: 'pink', band: [[0, k.rng.range(800, 2200)]], q: 1.4, amp: [[0, 0], [0.002, a], [0.03, 0]], lp: 3500, wet: 0.1 });
      }
    },
  },
  error: {
    dur: 0.4,
    tail: 0.2,
    rate: SR,
    peak: 0.32,
    rms: 0.1,
    hp: 120,
    reverb: ROOM,
    build(k) {
      // muted low double "bonk", gentle not harsh
      k.bar(0.002, st(-2), 0.8, { decay: 0.08, click: 0.15, lp: 1800 }); // G4
      k.bar(0.13, st(-5), 0.75, { decay: 0.1, click: 0.12, lp: 1600 }); // E4
    },
  },
  cash: {
    dur: 0.5,
    tail: 0.25,
    rate: SR,
    peak: 0.32,
    rms: 0.08,
    hp: 400,
    reverb: ROOM,
    build(k) {
      k.bar(0.002, 2350, 0.8, { decay: 0.16, partials: COIN, click: 0.25, wet: 0.12 });
      k.bar(0.075, 2790, 0.55, { decay: 0.14, partials: COIN, click: 0.2, wet: 0.12 });
      k.bar(0.075, st(17), 0.18, { decay: 0.2, click: 0, wet: 0.1 }); // faint warm under-tone
    },
  },
  coin: {
    dur: 0.25,
    tail: 0.15,
    rate: SR,
    peak: 0.26,
    rms: 0.06,
    hp: 500,
    reverb: ROOM,
    build(k) {
      k.bar(0.002, 2620, 0.7, { decay: 0.1, partials: COIN, click: 0.2, wet: 0.1 });
      k.bar(0.045, 3080, 0.35, { decay: 0.08, partials: COIN, click: 0.12, wet: 0.1 });
    },
  },
  celebrate: {
    dur: 1.6,
    tail: 0.5,
    rate: SR,
    peak: 0.45,
    rms: 0.12,
    hp: 120,
    reverb: { decay: 0.22, length: 1.1, bright: 0.55 },
    build(k) {
      // original rising figure, then a soft open chord with a shimmer
      const fig: [number, number, number][] = [
        [0.0, 10, 0.55], // G5
        [0.1, 14, 0.55], // B5
        [0.2, 17, 0.6], // D6
        [0.32, 15, 0.5], // C6
        [0.42, 19, 0.65], // E6
      ];
      for (const [t, n, v] of fig) {
        k.bar(t, st(n), v, { decay: 0.2, click: 0.15, lp: 6000, wet: 0.2 });
        k.bar(t, st(n), v * 0.35, { decay: 0.35, partials: TINE, click: 0, wet: 0.25 });
      }
      const tc = 0.6;
      for (const [n, v] of [
        [-2, 0.45], // G4
        [10, 0.45], // G5
        [14, 0.4], // B5
        [17, 0.42], // D6
        [22, 0.38], // G6
      ] as const) {
        k.bar(tc + k.rng.range(0, 0.025), st(n), v, { decay: 0.55, click: 0.08, lp: 6500, wet: 0.3 });
        k.bar(tc, st(n), v * 0.3, { decay: 0.9, partials: TINE, click: 0, wet: 0.35 });
      }
      // shimmer: tiny high bells drifting down
      for (let i = 0; i < 6; i++) k.bar(tc + 0.05 + i * 0.07, st(31 - i * 2), 0.12, { decay: 0.25, partials: COIN, click: 0, wet: 0.4 });
    },
  },
};
