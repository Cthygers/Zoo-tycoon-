// UI and game-feedback cues: short, soft, warm "wooden mallet" sounds.
// All original: marimba-like bars (sine partials tuned 1 : 3.93 : 9.2),
// soft knocks, small metallic coin partials, a hand bell and a few diegetic
// sounds for the feedback module (turnstile, card reader, donation box,
// animal crate, gate chime).
//
// Levels form a hierarchy on a phone speaker: `rms` is the phone-weighted RMS
// of the loudest 400 ms (render.ts), and every peak cap sits well above it so
// the rms target is what binds. Relative to build (−26 dB): tap −6, select /
// open / close −3 (select, the most frequent, −4), error +0.5, bulldoze −1.5,
// deny −9, celebrate +5.5.
// build at −26 dB puts a tap ≥ 6 dB over a busy day bed on a phone; the engine
// scales the UI channel down in quiet views, so a night overview's cues stay
// within 12 dB of its ambience. Feedback heard in the world (coins, bell, crate,
// gate) sits on its own reference, WORLD_DB: it is mixed with the animals.

import type { Kit, Partial3 } from '../kit';
import type { Recipe } from '../render';

/**
 * Render rates, chosen for the cue budget (≤ 1.6 MB for all cues): interface
 * cues at 24 kHz (their content stays under 10 kHz); positional feedback in the
 * world at 22.05 kHz like the animal voices, the long ones (bell, crate, gate)
 * at 16 kHz. The engine low-passes world voices under 0.45 × their rate.
 */
const SR = 24000;
const FX_SR = 22050;
const FX_LONG_SR = 16000;
/** Equal-tempered frequency, semitones relative to A4. */
const st = (n: number) => 440 * Math.pow(2, n / 12);
const ROOM = { decay: 0.09, length: 0.45, bright: 0.6 };
/** Peak cap of every cue: high enough that the rms target always binds. */
const PEAK = 0.6;
/** Phone-weighted rms targets (dBFS), see the hierarchy above. */
const rmsDb = (db: number) => Math.pow(10, db / 20);
const BUILD_DB = -26;
/** Reference of the positional feedback sounds (fx pool, world channel). */
const WORLD_DB = -30;

/** Small coin / metal tab: inharmonic plate partials. */
const COIN: readonly Partial3[] = [
  [1, 1, 1],
  [2.32, 0.55, 0.62],
  [4.25, 0.3, 0.4],
  [6.63, 0.14, 0.26],
];
const COIN_B: readonly Partial3[] = [
  [1, 1, 1],
  [2.08, 0.55, 0.62],
  [3.9, 0.3, 0.42],
  [6.1, 0.14, 0.26],
];
const COIN_C: readonly Partial3[] = [
  [1, 1, 1],
  [2.5, 0.55, 0.6],
  [4.6, 0.28, 0.4],
];
/** A coin in a wooden box: inharmonic clink. */
const CLINK: readonly Partial3[] = [
  [1, 1, 1],
  [1.742, 0.6, 0.75],
  [2.548, 0.4, 0.55],
];
/** Hand bell: hum, prime, tierce-ish and a bright upper partial. */
const BELL: readonly Partial3[] = [
  [1, 1, 1],
  [2.0, 0.5, 0.75],
  [2.76, 0.4, 0.55],
  [5.4, 0.18, 0.3],
];
/** Kalimba-ish: strong fundamental, faint octave-and-a-bit partial. */
const TINE: readonly Partial3[] = [
  [1, 1, 1],
  [5.4, 0.12, 0.18],
  [2.01, 0.12, 0.5],
];
/** Muted bar: fundamental and the first marimba overtone only. */
const FELT: readonly Partial3[] = [
  [1, 1, 1],
  [3.93, 0.2, 0.3],
];
const SINE: readonly Partial3[] = [[1, 1, 1]];

/** One-shot cue recipe at the cue rate with the shared room and peak cap. */
function cue(dur: number, db: number, build: Recipe['build'], o: Partial<Recipe> = {}): Recipe {
  return { dur, tail: 0.2, rate: SR, peak: PEAK, rms: rmsDb(db), hp: 150, reverb: ROOM, build, ...o };
}

/**
 * A coin on a wooden counter: the coin's partials plus a 1.1 kHz body knock,
 * which keeps the 2–5 kHz band (where the birds sing) to about half the energy.
 */
function coin(k: Kit, t: number, f: number, vel: number, partials: readonly Partial3[], decay: number): void {
  k.bar(t, f, vel, { decay, partials, click: 0.15, wet: 0.1 });
  k.bar(t, 1100 * k.rng.range(0.95, 1.05), vel * 1.2, { decay: 0.04, partials: FELT, click: 0.1, wet: 0.05 });
}

const COIN_DB = WORLD_DB - 4;

export const CUE_RECIPES: Record<string, Recipe> = {
  tap: cue(0.14, BUILD_DB - 6, (k) => {
    // warm wooden click: low-mid bar with a soft mallet
    k.bar(0.002, st(9), 0.8, { decay: 0.045, click: 0.3, wet: 0.08, lp: 4500 }); // F#5
    k.bar(0.002, st(-3), 0.35, { decay: 0.03, click: 0, wet: 0 }); // body
  }, { tail: 0.12 }),
  select: cue(0.3, BUILD_DB - 4, (k) => {
    k.bar(0.002, st(10), 0.7, { decay: 0.09, click: 0.2, lp: 5000 }); // G5
    k.bar(0.055, st(17), 0.55, { decay: 0.12, click: 0.15, lp: 5500 }); // D6
  }),
  open: cue(0.3, BUILD_DB - 3, (k) => {
    k.burst({ t: 0, dur: 0.13, color: 'pink', band: [[0, 700], [0.13, 2600]], q: 0.9, amp: [[0, 0], [0.07, 0.1], [0.13, 0]], wet: 0.05 });
    k.bar(0.012, st(5), 0.6, { decay: 0.08, click: 0.2, lp: 4800 }); // D5
    k.bar(0.07, st(12), 0.6, { decay: 0.12, click: 0.15, lp: 5000 }); // A5
  }),
  close: cue(0.3, BUILD_DB - 3, (k) => {
    k.burst({ t: 0, dur: 0.12, color: 'pink', band: [[0, 2300], [0.12, 750]], q: 0.9, amp: [[0, 0], [0.05, 0.09], [0.12, 0]], wet: 0.05 });
    k.bar(0.01, st(12), 0.55, { decay: 0.07, click: 0.2, lp: 4500 }); // A5
    k.bar(0.065, st(5), 0.5, { decay: 0.1, click: 0.12, lp: 4000 }); // D5
  }),
  build: cue(0.6, BUILD_DB, (k) => {
    // timber "thock" as the piece settles, then a warm two-bar confirmation
    k.thump(0, 230, 120, 0.11, 0.9, { wet: 0.1 });
    k.burst({ t: 0, dur: 0.05, color: 'pink', band: [[0, 1100], [0.05, 600]], q: 1.2, amp: [[0, 0], [0.002, 0.7], [0.05, 0]], wet: 0.1 });
    k.bar(0.04, st(5), 0.6, { decay: 0.22, click: 0.15, lp: 5000 }); // D5
    k.bar(0.04, st(12), 0.4, { decay: 0.2, click: 0.1, lp: 5000 }); // A5
    k.bar(0.1, st(17), 0.32, { decay: 0.26, click: 0.1, lp: 5500 }); // D6
  }, { tail: 0.3, hp: 90 }),
  bulldoze: cue(0.55, BUILD_DB - 1.5, (k) => {
    // earthy crunch a phone can play: a knock whose harmonics reach 300–500 Hz,
    // a wood crack and crumbling grains in the 1.4–2.8 kHz band
    k.thump(0, 160, 90, 0.13, 0.8, { wet: 0.12 });
    k.burst({ t: 0, dur: 0.3, color: 'brown', band: [[0, 650], [0.3, 380]], q: 0.9, amp: [[0, 0], [0.01, 0.9], [0.3, 0]], wet: 0.1 });
    k.bar(0.008, 600, 0.6, { decay: 0.04, click: 0.4, partials: FELT, wet: 0.1 });
    for (let i = 0; i < 12; i++) {
      const t = 0.02 + k.rng.range(0, 0.36) * (i / 12 + 0.3);
      const a = (1 - i / 14) * k.rng.range(0.6, 1.2);
      k.burst({ t, dur: 0.015, color: 'pink', band: [[0, k.rng.range(1400, 2800)]], q: 1.4, amp: [[0, 0], [0.001, a], [0.015, 0]], wet: 0.1 });
    }
  }, { tail: 0.3, hp: 200, squash: 1.6 }),
  error: cue(0.4, BUILD_DB + 0.5, (k) => {
    // muted low double "bonk" with enough overtone and clack to carry on a phone
    // (a phone speaker loses the G4 / E4 fundamentals)
    const p: readonly Partial3[] = [
      [1, 1, 1],
      [3.93, 0.85, 0.35],
      [9.2, 0.07, 0.12],
    ];
    k.bar(0.002, st(-2), 0.8, { decay: 0.08, click: 0.15, lp: 3000, partials: p }); // G4
    k.bar(0.002, 1200, 0.8, { decay: 0.015, click: 0.35, partials: SINE, wet: 0.05 }); // felt clack
    k.bar(0.13, st(-5), 0.75, { decay: 0.1, click: 0.12, lp: 3000, partials: p }); // E4
  }, { hp: 120 }),
  deny: cue(0.12, BUILD_DB - 9, (k) => {
    // one muted knock: "not here", quieter than an error
    k.bar(0.002, st(-2), 0.8, { decay: 0.05, click: 0.1, lp: 1500 }); // G4
  }, { tail: 0.12, hp: 120 }),
  cash: cue(0.5, BUILD_DB - 1, (k) => {
    k.bar(0.002, 2350, 0.8, { decay: 0.16, partials: COIN, click: 0.25, wet: 0.12 });
    k.bar(0.075, 2790, 0.55, { decay: 0.14, partials: COIN, click: 0.2, wet: 0.12 });
    k.bar(0.075, st(17), 0.18, { decay: 0.2, click: 0, wet: 0.1 }); // faint warm under-tone
    k.bar(0.002, 1100, 0.5, { decay: 0.03, partials: FELT, click: 0.1, wet: 0.05 }); // counter
  }, { tail: 0.25, hp: 400 }),
  // ---- transactions (feedback module): one coin per variant, never twice in a row
  'coin#0': cue(0.25, COIN_DB, (k) => {
    coin(k, 0.002, 2620, 0.7, COIN, 0.1);
    k.bar(0.045, 3080, 0.2, { decay: 0.06, partials: COIN, click: 0.1, wet: 0.1 });
  }, { tail: 0.15, hp: 400, rate: FX_SR }),
  'coin#1': cue(0.25, COIN_DB, (k) => {
    coin(k, 0.002, 2450, 0.7, COIN_B, 0.11);
    k.bar(0.05, 2490, 0.2, { decay: 0.06, partials: COIN_B, click: 0.1, wet: 0.1 });
  }, { tail: 0.15, hp: 400, rate: FX_SR }),
  'coin#2': cue(0.25, COIN_DB, (k) => {
    coin(k, 0.002, 2860, 0.7, COIN_C, 0.09);
    k.bar(0.038, 2900, 0.2, { decay: 0.05, partials: COIN_C, click: 0.1, wet: 0.1 });
  }, { tail: 0.15, hp: 400, rate: FX_SR }),
  'coin#3': cue(0.3, COIN_DB, (k) => {
    // two coins landing 25 ms apart
    coin(k, 0.002, 2620, 0.7, COIN, 0.1);
    coin(k, 0.027, 2940, 0.6, COIN_B, 0.09);
  }, { tail: 0.15, hp: 400, rate: FX_SR }),
  turnstile: cue(0.25, COIN_DB, (k) => {
    // ratchet ticks as the arm turns, then the arm's thunk
    const n = k.rng.int(3, 4);
    for (let i = 0; i < n; i++) {
      const f = k.rng.range(2000, 5000);
      k.burst({ t: i * 0.025, dur: 0.012, band: [[0, f]], q: 1.6, amp: [[0, 0], [0.0008, 1], [0.012, 0]], wet: 0.08 });
    }
    const t = n * 0.025;
    k.thump(t, 180, 120, 0.06, 0.35, { wet: 0.08 });
    k.bar(t, 720, 0.6, { decay: 0.03, partials: FELT, click: 0.4, wet: 0.08 }); // the arm's stop
    k.burst({ t, dur: 0.05, color: 'pink', band: [[0, 1100]], q: 1.1, amp: [[0, 0], [0.002, 0.5], [0.05, 0]], wet: 0.08 });
  }, { tail: 0.15, hp: 120, rate: FX_SR }),
  beep: cue(0.2, COIN_DB - 12, (k) => {
    // card reader: two short 1.8 kHz beeps
    for (const t of [0, 0.12]) k.tone({ t, dur: 0.07, wave: 'sine', f: [[0, 1800]], amp: [[0, 0], [0.003, 1], [0.067, 1], [0.07, 0]], lp: 4000, wet: 0.05 });
  }, { tail: 0.1, hp: 400, rate: FX_SR }),
  coindrop: cue(0.3, COIN_DB, (k) => {
    // coins dropping into a wooden donation box
    const n = k.rng.int(2, 3);
    let t = 0.002;
    for (let i = 0; i < n; i++) {
      k.bar(t, 3100 * k.rng.range(0.93, 1.07), 0.8 - i * 0.15, { decay: k.rng.range(0.06, 0.12), partials: CLINK, click: 0.2, wet: 0.1 });
      if (i === 0) k.thump(t + 0.004, 210, 170, 0.07, 0.7, { wet: 0.05 });
      t += k.rng.range(0.03, 0.07);
    }
  }, { tail: 0.15, hp: 120, rate: FX_SR }),
  // ---- notification notes (ui channel)
  'note.good': cue(0.4, BUILD_DB - 3, (k) => {
    k.bar(0.002, st(5), 0.7, { decay: 0.18, click: 0.15, lp: 5000 }); // D5
    k.bar(0.122, st(14), 0.6, { decay: 0.18, click: 0.12, lp: 5500 }); // B5
  }),
  'note.warn': cue(0.3, BUILD_DB - 2, (k) => {
    // felt double knock and a dry wood click
    k.bar(0.002, st(0), 0.8, { decay: 0.07, click: 0.4, partials: FELT, lp: 2400 }); // A4
    k.bar(0.002, 1400, 0.35, { decay: 0.012, click: 0.4, partials: SINE, wet: 0.05 });
    k.bar(0.142, st(0), 0.7, { decay: 0.08, click: 0.4, partials: FELT, lp: 2400 });
  }),
  'note.bad': cue(0.55, BUILD_DB - 1, (k) => {
    // a low, uneasy dyad with a slow tremolo
    const trem = k.gain(0.85);
    k.mod(k.osc('sine', 0, 0.75, 6), 0.15, trem.gain);
    k.send(trem, 1, 0.15);
    k.bar(0.002, st(-5), 0.7, { decay: 0.25, click: 0.12, lp: 3500, wet: 0, dest: trem }); // E4
    k.bar(0.002, st(-4), 0.6, { decay: 0.25, click: 0.08, lp: 3500, wet: 0, dest: trem }); // F4
    k.bar(0.002, 1200, 0.35, { decay: 0.015, click: 0.35, partials: SINE, wet: 0.05 }); // knock
  }, { tail: 0.25, hp: 120 }),
  bell: cue(1.2, WORLD_DB, function* (k) {
    // keeper's hand bell, three strikes; the second also rings a lower bell
    for (let i = 0; i < 3; i++) {
      const t = 0.002 + i * 0.18;
      k.bar(t, 880 * k.rng.range(0.995, 1.005), 0.8 - i * 0.08, { decay: 0.35, partials: BELL, click: 0.15, wet: 0.2 });
      if (i === 1) k.bar(t + 0.01, 660, 0.55, { decay: 0.4, partials: BELL, click: 0.1, wet: 0.2 });
      yield;
    }
  }, { tail: 0.4, rate: FX_LONG_SR, reverb: { decay: 0.2, length: 1, bright: 0.6 } }),
  crate: cue(0.7, WORLD_DB - 3, (k) => {
    // a wooden transport crate set down, its latch, then the gate creaking open
    k.thump(0, 120, 90, 0.15, 0.4, { wet: 0.1 });
    k.burst({ t: 0, dur: 0.12, color: 'brown', band: [[0, 520], [0.12, 300]], q: 1, amp: [[0, 0], [0.004, 1], [0.12, 0]], wet: 0.1 });
    k.bar(0.003, 340, 0.9, { decay: 0.06, partials: FELT, click: 0.4, wet: 0.08 }); // plank
    k.burst({ t: 0.25, dur: 0.008, band: [[0, 2400]], q: 3, amp: [[0, 0], [0.0005, 1], [0.008, 0]], wet: 0.1 });
    // creak: stick-slip pulses ringing a sweeping wooden resonance
    const saw = k.osc('sawtooth', 0.3, 0.66, 25);
    k.path(saw.frequency, 0.3, [[0, 22], [0.18, 30], [0.35, 26]]);
    const g = k.gain(0);
    k.path(g.gain, 0.3, [[0, 0], [0.04, 0.9], [0.28, 0.7], [0.35, 0]]);
    const bp = k.bq('bandpass', 380, 8);
    k.path(bp.frequency, 0.3, [[0, 380], [0.35, 720]], 'exp');
    const bp2 = k.bq('bandpass', 900, 5);
    k.path(bp2.frequency, 0.3, [[0, 900], [0.35, 1650]], 'exp');
    k.chain(saw, g, bp);
    g.connect(bp2);
    k.send(bp, 2, 0.15);
    k.send(bp2, 0.7, 0.15);
  }, { tail: 0.25, hp: 80, rate: FX_LONG_SR }),
  // ---- pause and resume: felt bars falling and rising
  pause: cue(0.3, BUILD_DB - 6, (k) => {
    k.bar(0.002, st(5), 0.7, { decay: 0.12, click: 0.25, partials: FELT, lp: 2600 }); // D5
    k.bar(0.11, st(0), 0.65, { decay: 0.14, click: 0.2, partials: FELT, lp: 2400 }); // A4
  }),
  resume: cue(0.3, BUILD_DB - 6, (k) => {
    k.bar(0.002, st(0), 0.65, { decay: 0.12, click: 0.25, partials: FELT, lp: 2600 }); // A4
    k.bar(0.11, st(5), 0.7, { decay: 0.14, click: 0.2, partials: FELT, lp: 2600 }); // D5
  }),
  // ---- day ledger and gate chime
  ledger: cue(0.5, BUILD_DB - 3, (k) => {
    // a page turned in the ledger, then G4 → D5
    k.burst({ t: 0, dur: 0.08, color: 'white', band: [[0, 2000], [0.08, 6000]], q: 0.8, amp: [[0, 0], [0.03, 0.5], [0.08, 0]], wet: 0.05 });
    k.bar(0.1, st(-2), 0.65, { decay: 0.16, click: 0.15, lp: 5000 }); // G4
    k.bar(0.22, st(5), 0.6, { decay: 0.2, click: 0.12, lp: 5000 }); // D5
  }),
  gate: cue(1.6, WORLD_DB - 2, (k) => {
    // entrance chime: two tones with a soft third harmonic
    const p: readonly Partial3[] = [
      [1, 1, 1],
      [3, 0.25, 0.5],
    ];
    k.bar(0.002, 659.3, 0.7, { decay: 0.45, partials: p, click: 0.08, wet: 0.25 }); // E5
    k.bar(0.45, 523.3, 0.7, { decay: 0.55, partials: p, click: 0.08, wet: 0.25 }); // C5
  }, { tail: 0.4, rate: FX_LONG_SR, reverb: { decay: 0.25, length: 1.2, bright: 0.5 } }),
  celebrate: cue(1.6, BUILD_DB + 5.5, function* (k) {
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
      yield;
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
      yield;
    }
    // shimmer: tiny high bells drifting down
    for (let i = 0; i < 6; i++) k.bar(tc + 0.05 + i * 0.07, st(31 - i * 2), 0.12, { decay: 0.25, partials: COIN, click: 0, wet: 0.4 });
  }, { tail: 0.5, hp: 120, reverb: { decay: 0.22, length: 1.1, bright: 0.55 } }),
};
