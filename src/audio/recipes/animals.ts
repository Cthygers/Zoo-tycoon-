// Animal vocalisations and ambient wildlife one-shots, synthesised from
// voiced sources (glottal / nasal / brass periodic waves) shaped by pitch
// contours, formant filters, roughness and breath noise. Each species gets a
// full 'call' (played when the sim's animal starts its 'call' action) and a
// short, quieter 'idle' sound for occasional ambient vocalisations.

import type { Formant, Kit, Note } from '../kit';
import type { Recipe } from '../render';

const REV = { decay: 0.3, length: 1.3, bright: 0.45 };

function call(dur: number, build: Recipe['build'], extra: Partial<Recipe> = {}): Recipe {
  return { dur, tail: 0.9, rate: 22050, reverb: REV, peak: 0.85, rms: 0.14, hp: 105, build, ...extra };
}
function idle(dur: number, build: Recipe['build'], extra: Partial<Recipe> = {}): Recipe {
  return { dur, tail: 0.7, rate: 22050, reverb: REV, peak: 0.8, rms: 0.12, hp: 105, build, ...extra };
}

// ------------------------------------------------------------------ big cats

const F_LION: Formant[] = [
  [340, 6, 2],
  [800, 8, 2.5],
  [1500, 6, 3],
];
const F_TIGER: Formant[] = [
  [420, 6, 2],
  [1050, 8, 2.5],
  [2300, 5, 3],
];
const F_BEAR: Formant[] = [
  [380, 6, 2],
  [900, 7, 2],
  [1800, 5, 3],
];
const F_HIPPO: Formant[] = [
  [450, 9, 2.5],
  [1100, 6, 3],
  [2200, 3, 3],
];
const F_ELE: Formant[] = [
  [1050, 7, 2],
  [2300, 6, 2.5],
  [3600, 4, 3],
];

function* lionCall(k: Kit): Generator<void> {
  // low moan building into the full roar, then the trailing grunt series
  k.tone({ t: 0, dur: 0.55, f: [[0, 105], [0.55, 150]], amp: [[0, 0], [0.35, 0.45], [0.55, 0.4]], rough: [35, 0.4], breath: 0.25, breathBand: [600, 0.8], formants: F_LION, sub: 0.3, drive: 1.5, lp: 2600 });
  yield;
  k.tone({
    t: 0.5,
    dur: 1.45,
    f: [[0, 165], [0.3, 225], [0.75, 205], [1.15, 140], [1.45, 92]],
    amp: [[0, 0], [0.12, 1], [0.95, 0.85], [1.45, 0]],
    sub: 0.5,
    drive: 2.6,
    rough: [55, 0.55],
    breath: 0.35,
    breathBand: [750, 0.7],
    formants: F_LION,
    fmove: [[[0, 300], [0.4, 380], [1.45, 280]]],
    vib: [5, 12],
    lp: 3200,
  });
  yield;
  const grunts: [number, number][] = [
    [2.15, 0.75],
    [2.6, 0.58],
    [3.0, 0.45],
    [3.35, 0.33],
  ];
  for (const [t, a] of grunts) {
    k.tone({ t, dur: 0.3, f: [[0, 150], [0.06, 160], [0.3, 92]], amp: [[0, 0], [0.04, a], [0.18, a * 0.8], [0.3, 0]], sub: 0.45, drive: 2, rough: [45, 0.6], breath: 0.4, breathBand: [650, 0.8], formants: F_LION, lp: 2600 });
    yield;
  }
}

function* lionIdle(k: Kit): Generator<void> {
  for (const [t, a] of [
    [0, 0.8],
    [0.42, 0.6],
  ] as const) {
    k.tone({ t, dur: 0.34, f: [[0, 120], [0.08, 128], [0.34, 85]], amp: [[0, 0], [0.05, a], [0.22, a * 0.7], [0.34, 0]], sub: 0.4, drive: 1.8, rough: [40, 0.55], breath: 0.45, breathBand: [550, 0.9], formants: [[300, 7, 2], [720, 5, 2.5]], lp: 2200 });
    yield;
  }
}

function* tigerCall(k: Kit): Generator<void> {
  k.burst({ t: 0, dur: 0.2, color: 'pink', band: [[0, 500], [0.2, 350]], q: 1.2, amp: [[0, 0], [0.03, 0.35], [0.2, 0]], wet: 0.15 });
  yield;
  k.tone({
    t: 0.18,
    dur: 1.65,
    f: [[0, 95], [0.25, 155], [0.8, 140], [1.3, 105], [1.65, 78]],
    amp: [[0, 0], [0.15, 0.95], [1.15, 0.8], [1.65, 0]],
    sub: 0.7,
    drive: 3.4,
    rough: [30, 0.75],
    breath: 0.5,
    breathBand: [900, 0.7],
    formants: F_TIGER,
    fmove: [[[0, 360], [0.5, 460], [1.65, 330]]],
    lp: 2900,
  });
  yield;
  k.tone({ t: 1.9, dur: 0.8, f: [[0, 72], [0.8, 60]], amp: [[0, 0], [0.1, 0.4], [0.6, 0.3], [0.8, 0]], sub: 0.8, drive: 3, rough: [22, 0.9], breath: 0.35, breathBand: [500, 1], formants: F_TIGER, lp: 1800 });
  yield;
}

function* tigerIdle(k: Kit): Generator<void> {
  // friendly "chuff": rapid breathy nasal puffs with lip flutter
  for (const [t, a] of [
    [0, 0.9],
    [0.15, 1],
    [0.3, 0.8],
    [0.46, 0.55],
  ] as const) {
    k.burst({ t, dur: 0.12, color: 'pink', band: [[0, 700], [0.12, 450]], q: 1.4, rough: [26, 0.9], amp: [[0, 0], [0.012, a], [0.12, 0]], formants: [[350, 6, 2]], wet: 0.12 });
    yield;
    k.tone({ t, dur: 0.11, f: [[0, 130], [0.11, 105]], amp: [[0, 0], [0.015, a * 0.3], [0.11, 0]], rough: [26, 0.8], lp: 1200, wet: 0.1 });
    yield;
  }
}

// ------------------------------------------------------------------ bears

function* grizzlyCall(k: Kit): Generator<void> {
  for (const [t, a] of [
    [0, 0.6],
    [0.24, 0.7],
  ] as const) {
    k.burst({ t, dur: 0.16, color: 'pink', band: [[0, 600], [0.16, 400]], q: 1, rough: [30, 0.5], amp: [[0, 0], [0.015, a], [0.16, 0]] });
    yield;
  }
  k.tone({
    t: 0.55,
    dur: 1.35,
    f: [[0, 82], [0.2, 118], [0.9, 104], [1.35, 70]],
    amp: [[0, 0], [0.15, 1], [1.0, 0.8], [1.35, 0]],
    sub: 0.6,
    drive: 3,
    rough: [28, 0.8],
    breath: 0.5,
    breathBand: [700, 0.8],
    formants: F_BEAR,
    lp: 2500,
  });
  yield;
}

function* grizzlyIdle(k: Kit): Generator<void> {
  k.tone({ t: 0, dur: 0.75, f: [[0, 95], [0.3, 102], [0.75, 75]], amp: [[0, 0], [0.1, 0.8], [0.5, 0.6], [0.75, 0]], sub: 0.4, drive: 2, rough: [26, 0.6], breath: 0.5, breathBand: [600, 0.8], formants: [[350, 7, 2], [820, 4, 2]], lp: 1800 });
  yield;
}

function* polarCall(k: Kit): Generator<void> {
  k.burst({ t: 0, dur: 0.6, color: 'white', band: [[0, 2500], [0.6, 1800]], q: 0.6, amp: [[0, 0], [0.1, 0.45], [0.5, 0.35], [0.6, 0]], wet: 0.1 });
  yield;
  k.tone({
    t: 0.45,
    dur: 1.2,
    f: [[0, 75], [0.2, 105], [0.8, 95], [1.2, 66]],
    amp: [[0, 0], [0.15, 1], [0.9, 0.8], [1.2, 0]],
    sub: 0.65,
    drive: 3,
    rough: [24, 0.85],
    breath: 0.7,
    breathBand: [800, 0.7],
    formants: [[360, 7, 2], [850, 5, 2], [1700, 3, 3]],
    lp: 2300,
  });
  yield;
  // jaw pops
  for (const t of [1.85, 2.05, 2.22]) {
    k.burst({ t, dur: 0.04, color: 'white', band: [[0, 1600]], q: 3, amp: [[0, 0], [0.002, 0.9], [0.04, 0]], wet: 0.25 });
    yield;
    k.thump(t, 300, 180, 0.05, 0.5);
    yield;
  }
}

function* polarIdle(k: Kit): Generator<void> {
  for (const [t, a] of [
    [0, 0.8],
    [0.22, 0.7],
    [0.42, 0.5],
  ] as const) {
    k.burst({ t, dur: 0.15, color: 'pink', band: [[0, 650], [0.15, 420]], q: 1.2, rough: [25, 0.7], amp: [[0, 0], [0.01, a], [0.15, 0]] });
    yield;
  }
}

// ------------------------------------------------------------------ large herbivores

function* elephantCall(k: Kit): Generator<void> {
  k.burst({ t: 0, dur: 0.18, color: 'pink', band: [[0, 600], [0.18, 1100]], q: 1, amp: [[0, 0], [0.05, 0.3], [0.18, 0]] });
  yield;
  k.tone({
    t: 0.15,
    dur: 1.35,
    wave: 'brass',
    f: [[0, 380], [0.12, 560], [0.5, 610], [0.95, 560], [1.35, 420]],
    amp: [[0, 0], [0.07, 1], [0.9, 0.9], [1.35, 0]],
    drive: 4,
    rough: [75, 0.5],
    breath: 0.6,
    breathBand: [2200, 0.7],
    formants: F_ELE,
    vib: [6.5, 22],
    jitter: 35,
    lp: 6500,
    hp: 200,
  });
  yield;
  k.tone({ t: 1.55, dur: 0.55, wave: 'brass', f: [[0, 520], [0.15, 580], [0.55, 400]], amp: [[0, 0], [0.05, 0.7], [0.35, 0.6], [0.55, 0]], drive: 4, rough: [70, 0.4], breath: 0.45, breathBand: [2200, 0.7], formants: F_ELE, vib: [7, 25], lp: 6000, hp: 200 });
  yield;
  k.tone({ t: 2.05, dur: 1.0, f: [[0, 75], [0.5, 82], [1.0, 68]], amp: [[0, 0], [0.2, 0.45], [0.75, 0.4], [1, 0]], rough: [14, 0.5], formants: [[280, 8, 2], [600, 5, 2]], drive: 1.5, lp: 1500 });
  yield;
}

function* elephantIdle(k: Kit): Generator<void> {
  k.tone({ t: 0, dur: 1.1, f: [[0, 80], [0.5, 92], [1.1, 76]], amp: [[0, 0], [0.25, 0.8], [0.8, 0.7], [1.1, 0]], rough: [12, 0.5], formants: [[260, 9, 2], [560, 6, 2]], drive: 1.6, sub: 0.2, lp: 1400 });
  yield;
  k.burst({ t: 0.95, dur: 0.35, color: 'pink', band: [[0, 900], [0.35, 600]], q: 0.8, amp: [[0, 0], [0.04, 0.5], [0.35, 0]], rough: [30, 0.5] });
  yield;
}

function* hippoCall(k: Kit): Generator<void> {
  k.tone({ t: 0, dur: 0.65, wave: 'nasal', f: [[0, 230], [0.65, 320]], amp: [[0, 0], [0.5, 0.55], [0.65, 0.5]], breath: 0.9, breathBand: [1400, 0.7], rough: [60, 0.5], formants: F_HIPPO, lp: 4000 });
  yield;
  for (let i = 0; i < 5; i++) {
    const t = 0.72 + i * 0.24;
    const a = 1 - i * 0.13;
    const s = 1 - i * 0.06;
    k.tone({
      t,
      dur: 0.19,
      wave: 'nasal',
      f: [[0, 175 * s], [0.05, 215 * s], [0.19, 150 * s]],
      amp: [[0, 0], [0.02, a], [0.1, 0.8 * a], [0.19, 0]],
      drive: 3,
      sub: 0.4,
      rough: [42, 0.5],
      breath: 0.3,
      breathBand: [900, 0.8],
      formants: F_HIPPO,
      lp: 3500,
    });
    yield;
  }
  k.tone({ t: 2.0, dur: 0.5, f: [[0, 120], [0.5, 85]], amp: [[0, 0], [0.05, 0.6], [0.3, 0.45], [0.5, 0]], sub: 0.5, drive: 2.5, rough: [30, 0.6], formants: F_HIPPO, lp: 2000 });
  yield;
}

function* hippoIdle(k: Kit): Generator<void> {
  k.tone({ t: 0, dur: 0.4, wave: 'nasal', f: [[0, 150], [0.06, 175], [0.4, 110]], amp: [[0, 0], [0.03, 1], [0.25, 0.7], [0.4, 0]], drive: 2.5, sub: 0.45, rough: [35, 0.55], breath: 0.3, breathBand: [800, 0.8], formants: F_HIPPO, lp: 2600 });
  yield;
  k.burst({ t: 0.45, dur: 0.35, color: 'white', band: [[0, 1500], [0.35, 900]], q: 0.7, amp: [[0, 0], [0.03, 0.35], [0.35, 0]], rough: [20, 0.4] });
  yield;
}

function snort(k: Kit, t: number, a: number, f0: number, f1: number, dur = 0.36): void {
  k.burst({ t, dur, color: 'pink', band: [[0, f0], [dur, f1]], q: 1.2, rough: [26, 0.65], amp: [[0, 0], [0.02, a], [dur * 0.33, 0.7 * a], [dur, 0]], formants: [[250, 6, 2]], lp: 2400 });
}

function* rhinoCall(k: Kit): Generator<void> {
  snort(k, 0, 1, 520, 300);
  yield;
  snort(k, 0.45, 0.85, 500, 290);
  yield;
  snort(k, 0.85, 0.75, 480, 280);
  yield;
  k.tone({ t: 1.3, dur: 1.0, f: [[0, 115], [0.4, 155], [1.0, 105]], amp: [[0, 0], [0.15, 0.4], [0.7, 0.32], [1.0, 0]], sub: 0.35, drive: 2, rough: [28, 0.35], breath: 0.25, breathBand: [600, 0.8], formants: [[380, 7, 2], [880, 5, 2.5]], lp: 2200 });
  yield;
}

function* rhinoIdle(k: Kit): Generator<void> {
  snort(k, 0, 1, 560, 320, 0.4);
  yield;
  k.burst({ t: 0.45, dur: 0.25, color: 'pink', band: [[0, 420], [0.25, 300]], q: 1, amp: [[0, 0], [0.02, 0.45], [0.25, 0]], rough: [20, 0.5] });
  yield;
}

function* giraffeCall(k: Kit): Generator<void> {
  // soft low hum with a snort at the end
  k.tone({ t: 0, dur: 1.9, f: [[0, 92], [0.6, 98], [1.4, 96], [1.9, 88]], amp: [[0, 0], [0.35, 0.7], [1.5, 0.65], [1.9, 0]], vib: [4.5, 12], jitter: 15, formants: [[240, 6, 2], [520, 8, 2.5], [900, 3, 3]], rough: [8, 0.25], lp: 1600, hp: 120 });
  yield;
  k.burst({ t: 2.0, dur: 0.35, color: 'pink', band: [[0, 1000], [0.35, 500]], q: 1, amp: [[0, 0], [0.03, 0.9], [0.35, 0]], rough: [30, 0.6] });
  yield;
}

function* giraffeIdle(k: Kit): Generator<void> {
  k.burst({ t: 0, dur: 0.28, color: 'pink', band: [[0, 900], [0.28, 480]], q: 1.1, amp: [[0, 0], [0.02, 1], [0.28, 0]], rough: [28, 0.6] });
  yield;
  k.burst({ t: 0.32, dur: 0.2, color: 'pink', band: [[0, 700], [0.2, 450]], q: 1.1, amp: [[0, 0], [0.02, 0.6], [0.2, 0]], rough: [28, 0.6] });
  yield;
}

function* camelCall(k: Kit): Generator<void> {
  k.tone({
    t: 0,
    dur: 2.1,
    f: [[0, 105], [0.4, 150], [1.2, 138], [1.7, 115], [2.1, 88]],
    amp: [[0, 0], [0.25, 0.9], [1.6, 0.8], [2.1, 0]],
    sub: 0.5,
    drive: 2.6,
    rough: [17, 0.85],
    breath: 0.4,
    breathBand: [900, 0.7],
    formants: [[600, 8, 2.5], [1150, 6, 3], [2400, 3, 3]],
    fmove: [[[0, 650], [1.0, 480], [2.1, 420]], [[0, 1250], [1.0, 900], [2.1, 800]]],
    lp: 3000,
  });
  yield;
  k.tone({ t: 2.15, dur: 0.6, f: [[0, 95], [0.6, 80]], amp: [[0, 0], [0.08, 0.5], [0.45, 0.4], [0.6, 0]], rough: [11, 0.95], sub: 0.5, drive: 2, formants: [[450, 7, 2.5]], lp: 1800 });
  yield;
}

function* camelIdle(k: Kit): Generator<void> {
  k.tone({ t: 0, dur: 0.6, f: [[0, 110], [0.2, 125], [0.6, 90]], amp: [[0, 0], [0.08, 0.8], [0.4, 0.6], [0.6, 0]], rough: [14, 0.85], sub: 0.4, drive: 2.2, breath: 0.35, breathBand: [800, 0.8], formants: [[550, 7, 2.5], [1100, 5, 3]], lp: 2200 });
  yield;
}

// ------------------------------------------------------------------ grazers

function* zebraCall(k: Kit): Generator<void> {
  // braying bark series: noisy "hee" inhale + barked "kwa" exhale, sagging in pitch
  for (let i = 0; i < 6; i++) {
    const t = i * 0.36;
    const s = 1 - i * 0.07;
    const a = 1 - i * 0.1;
    k.tone({ t, dur: 0.12, wave: 'nasal', f: [[0, 950 * s], [0.12, 1150 * s]], amp: [[0, 0], [0.03, 0.35 * a], [0.12, 0]], breath: 0.7, breathBand: [2500, 0.8], formants: [[1400, 6, 3]], lp: 5000 });
    yield;
    k.tone({
      t: t + 0.14,
      dur: 0.2,
      wave: 'nasal',
      f: [[0, 640 * s], [0.04, 780 * s], [0.2, 470 * s]],
      amp: [[0, 0], [0.02, a], [0.08, 0.8 * a], [0.2, 0]],
      drive: 2.2,
      rough: [85, 0.3],
      breath: 0.25,
      breathBand: [1800, 0.8],
      formants: [[900, 7, 3], [2000, 5, 3]],
      lp: 5200,
    });
    yield;
  }
}

function* zebraIdle(k: Kit): Generator<void> {
  k.burst({ t: 0, dur: 0.3, color: 'pink', band: [[0, 1300], [0.3, 650]], q: 1.4, rough: [38, 0.85], amp: [[0, 0], [0.02, 1], [0.12, 0.6], [0.3, 0]], formants: [[500, 4, 2]] });
  yield;
  k.tone({ t: 0, dur: 0.25, f: [[0, 170], [0.25, 130]], amp: [[0, 0], [0.02, 0.25], [0.25, 0]], rough: [38, 0.85], lp: 1500 });
  yield;
}

function* gazelleCall(k: Kit): Generator<void> {
  for (const [t, a] of [
    [0, 1],
    [0.32, 0.85],
    [0.62, 0.75],
  ] as const) {
    k.burst({ t, dur: 0.11, color: 'white', band: [[0, 2600], [0.11, 1700]], q: 2, amp: [[0, 0], [0.008, a], [0.11, 0]], wet: 0.25 });
    yield;
    k.tone({ t, dur: 0.1, wave: 'soft', f: [[0, 1500], [0.1, 1150]], amp: [[0, 0], [0.01, 0.3 * a], [0.1, 0]], lp: 5000 });
    yield;
  }
  k.tone({ t: 1.0, dur: 0.5, wave: 'nasal', f: [[0, 360], [0.1, 420], [0.5, 340]], amp: [[0, 0], [0.04, 0.6], [0.35, 0.5], [0.5, 0]], vib: [9, 40], rough: [9, 0.5], formants: [[700, 6, 3], [1800, 5, 3]], breath: 0.2, breathBand: [2000, 0.8], lp: 5000 });
  yield;
}

function* gazelleIdle(k: Kit): Generator<void> {
  k.burst({ t: 0, dur: 0.12, color: 'white', band: [[0, 2300], [0.12, 1500]], q: 1.8, amp: [[0, 0], [0.01, 1], [0.12, 0]], wet: 0.25 });
  yield;
  k.burst({ t: 0.2, dur: 0.1, color: 'pink', band: [[0, 1400], [0.1, 1000]], q: 1.4, amp: [[0, 0], [0.01, 0.4], [0.1, 0]], wet: 0.2 });
  yield;
}

// ------------------------------------------------------------------ primates

function* gorillaCall(k: Kit): Generator<void> {
  let t = 0;
  for (let i = 0; i < 5; i++) {
    k.tone({ t, dur: 0.2, wave: 'soft', f: [[0, 250 + i * 28], [0.2, 290 + i * 32]], amp: [[0, 0], [0.05, 0.45 + i * 0.1], [0.15, 0.4 + i * 0.08], [0.2, 0]], breath: 0.25, breathBand: [600, 1], formants: [[330, 6, 3], [750, 3, 3]], lp: 2000 });
    yield;
    t += 0.33 - i * 0.04;
  }
  const tb = t + 0.08;
  for (let j = 0; j < 11; j++) {
    const tt = tb + j * 0.082 + k.rng.range(-0.006, 0.006);
    const a = Math.min(1, 0.55 + j * 0.08) * (j > 8 ? 0.8 : 1);
    // hollow cupped-hand "pok": a resonant knock plus a short slap of air
    const f = j % 2 ? 235 : 265;
    k.thump(tt, f, f * 0.7, 0.08, a, { wet: 0.3 });
    yield;
    k.burst({ t: tt, dur: 0.045, color: 'pink', band: [[0, f * 2.4]], q: 2.2, amp: [[0, 0], [0.002, a * 1.2], [0.045, 0]], wet: 0.3 });
    yield;
  }
}

function* gorillaIdle(k: Kit): Generator<void> {
  for (const [t, a] of [
    [0, 0.8],
    [0.26, 0.65],
  ] as const) {
    k.tone({ t, dur: 0.19, wave: 'glottal', f: [[0, 140], [0.19, 108]], amp: [[0, 0], [0.025, a], [0.12, a * 0.7], [0.19, 0]], breath: 0.25, breathBand: [500, 1], formants: [[300, 7, 2], [700, 3, 2.5]], rough: [30, 0.4], lp: 1500 });
    yield;
  }
}

// ------------------------------------------------------------------ birds

const F_PENG: Formant[] = [
  [1000, 8, 3],
  [2400, 6, 3],
];

function* penguinCall(k: Kit): Generator<void> {
  let t = 0;
  for (let i = 0; i < 4; i++) {
    const s = 1 + i * 0.03;
    const a = 0.6 + i * 0.12;
    const len = 0.22 + i * 0.03;
    k.tone({ t, dur: 0.11, wave: 'nasal', f: [[0, 700 * s], [0.11, 820 * s]], amp: [[0, 0], [0.02, 0.35 * a], [0.11, 0]], breath: 0.6, breathBand: [2200, 0.8], formants: F_PENG, lp: 5000 });
    yield;
    k.tone({
      t: t + 0.13,
      dur: len,
      wave: 'nasal',
      f: [[0, 470 * s], [0.05, 610 * s], [len, 520 * s]],
      amp: [[0, 0], [0.02, a], [len * 0.7, 0.8 * a], [len, 0]],
      drive: 2.4,
      rough: [55, 0.35],
      breath: 0.2,
      breathBand: [1500, 0.8],
      formants: F_PENG,
      vib: [11, 30],
      lp: 5500,
    });
    yield;
    t += 0.13 + len + 0.07;
  }
  k.tone({ t, dur: 0.6, wave: 'nasal', f: [[0, 500], [0.08, 640], [0.6, 480]], amp: [[0, 0], [0.03, 1], [0.45, 0.8], [0.6, 0]], drive: 2.6, rough: [50, 0.4], breath: 0.2, breathBand: [1500, 0.8], formants: F_PENG, vib: [12, 35], lp: 5500 });
  yield;
}

function* penguinIdle(k: Kit): Generator<void> {
  k.tone({ t: 0, dur: 0.22, wave: 'nasal', f: [[0, 560], [0.05, 650], [0.22, 520]], amp: [[0, 0], [0.02, 1], [0.15, 0.7], [0.22, 0]], drive: 2.2, rough: [50, 0.35], formants: F_PENG, lp: 5000 });
  yield;
  k.tone({ t: 0.3, dur: 0.16, wave: 'nasal', f: [[0, 600], [0.16, 540]], amp: [[0, 0], [0.02, 0.6], [0.16, 0]], drive: 2, rough: [50, 0.35], formants: F_PENG, lp: 5000 });
  yield;
}

function honk(k: Kit, t: number, s: number, len: number, a: number): void {
  k.tone({
    t,
    dur: len,
    wave: 'nasal',
    f: [[0, 600 * s], [0.03, 690 * s], [len, 540 * s]],
    amp: [[0, 0], [0.015, a], [len * 0.6, a * 0.8], [len, 0]],
    drive: 2,
    rough: [60, 0.25],
    formants: [[1300, 9, 3], [2700, 6, 3]],
    breath: 0.15,
    breathBand: [2500, 1],
    lp: 6000,
    hp: 300,
  });
}

function* flamingoCall(k: Kit): Generator<void> {
  // a small group honking over each other
  const voices = [0.9, 1.0, 1.13];
  let t = 0;
  for (let i = 0; i < 9; i++) {
    honk(k, t, voices[k.rng.int(0, 2)] * k.rng.range(0.97, 1.03), k.rng.range(0.11, 0.17), k.rng.range(0.55, 1));
    yield;
    t += k.rng.range(0.12, 0.26);
  }
}

function* flamingoIdle(k: Kit): Generator<void> {
  honk(k, 0, 1.02, 0.13, 0.9);
  yield;
  honk(k, 0.22, 0.98, 0.12, 0.6);
  yield;
}

// ------------------------------------------------------------------ ambient wildlife one-shots

function* owl(k: Kit): Generator<void> {
  const hoot = (t: number, d: number, f: number, a: number, vib = false) =>
    k.tone({
      t,
      dur: d,
      wave: 'soft',
      f: [[0, f * 0.97], [d * 0.3, f], [d, f * 0.93]],
      amp: [[0, 0], [d * 0.25, a], [d * 0.7, a * 0.85], [d, 0]],
      breath: 0.08,
      breathBand: [500, 1.5],
      formants: [[420, 4, 2]],
      vib: vib ? [6, 18] : undefined,
      lp: 1400,
      wet: 0.5,
    });
  hoot(0, 0.42, 395, 1);
  yield;
  hoot(0.85, 0.16, 382, 0.6);
  yield;
  hoot(1.08, 0.16, 380, 0.65);
  yield;
  hoot(1.4, 0.75, 372, 0.9, true);
  yield;
}

function* songA(k: Kit): Generator<void> {
  const n: Note[] = [];
  let t = 0;
  n.push({ t, d: 0.16, f0: 2900, f1: 3400, a: 0.8 });
  t += 0.22;
  n.push({ t, d: 0.12, f0: 3600, f1: 3000, a: 0.9 });
  t += 0.17;
  for (let i = 0; i < 7; i++) {
    n.push({ t, d: 0.035, f0: 4800 - i * 60, f1: 3600 - i * 40, a: 0.75, att: 0.1 });
    t += 0.055;
  }
  t += 0.06;
  n.push({ t, d: 0.25, f0: 2600, f1: 2500, fm: 3100, a: 0.85 });
  k.phrase(n, { harm: 0.08, wet: 0.25 });
  yield;
}

function* songB(k: Kit): Generator<void> {
  const n: Note[] = [];
  let t = 0;
  for (let i = 0; i < 3; i++) {
    n.push({ t, d: 0.075, f0: 6100, f1: 5500, a: 0.7, att: 0.15 });
    t += 0.13;
  }
  t += 0.05;
  for (let i = 0; i < 4; i++) {
    n.push({ t, d: 0.06, f0: 3400, f1: 4100, fm: 2900, a: 0.9 });
    t += 0.09;
  }
  k.phrase(n, { harm: 0.05, wet: 0.25 });
  yield;
}

function* woodpecker(k: Kit): Generator<void> {
  let t = 0;
  for (let i = 0; i < 19; i++) {
    const a = 1 - i / 24;
    k.burst({ t, dur: 0.02, color: 'white', band: [[0, 1300]], q: 4, amp: [[0, 0], [0.001, a], [0.02, 0]], wet: 0.4 });
    yield;
    k.thump(t, 820, 640, 0.02, a * 0.6, { wet: 0.4 });
    yield;
    t += 0.052 + i * 0.0012;
  }
}

function* crow(k: Kit): Generator<void> {
  for (const [t, a] of [
    [0, 1],
    [0.5, 0.85],
    [0.95, 0.7],
  ] as const) {
    k.tone({ t, dur: 0.32, wave: 'nasal', f: [[0, 560], [0.06, 620], [0.32, 500]], amp: [[0, 0], [0.03, a], [0.2, a * 0.8], [0.32, 0]], drive: 2.5, rough: [70, 0.55], breath: 0.3, breathBand: [1800, 0.8], formants: [[1200, 8, 3], [2100, 5, 3]], lp: 4000, wet: 0.35 });
    yield;
  }
}

// ------------------------------------------------------------------ registry

export const ANIMAL_RECIPES: Record<string, Recipe> = {
  'call.lion': call(3.7, lionCall, { hp: 160, squash: 2 }),
  'idle.lion': idle(0.8, lionIdle, { hp: 160, squash: 2 }),
  'call.tiger': call(2.7, tigerCall, { hp: 160, squash: 2 }),
  'idle.tiger': idle(0.6, tigerIdle, { hp: 160, squash: 1.6 }),
  'call.grizzly': call(1.9, grizzlyCall, { hp: 160, squash: 2 }),
  'idle.grizzly': idle(0.75, grizzlyIdle, { hp: 160, squash: 1.6 }),
  'call.polarbear': call(2.3, polarCall, { hp: 160, squash: 2 }),
  'idle.polarbear': idle(0.6, polarIdle),
  'call.elephant': call(3.05, elephantCall),
  'idle.elephant': idle(1.3, elephantIdle, { hp: 150, squash: 1.6 }),
  'call.hippo': call(2.5, hippoCall, { squash: 1.5 }),
  'idle.hippo': idle(0.8, hippoIdle, { squash: 1.5 }),
  'call.rhino': call(2.3, rhinoCall, { hp: 150, squash: 1.8 }),
  'idle.rhino': idle(0.7, rhinoIdle, { squash: 1.5 }),
  'call.giraffe': call(2.35, giraffeCall, { rms: 0.1 }),
  'idle.giraffe': idle(0.52, giraffeIdle, { rms: 0.1 }),
  'call.camel': call(2.75, camelCall, { hp: 150, squash: 1.8 }),
  'idle.camel': idle(0.6, camelIdle, { hp: 150, squash: 1.6 }),
  'call.zebra': call(2.2, zebraCall),
  'idle.zebra': idle(0.3, zebraIdle, { hp: 180, squash: 1.5 }),
  'call.gazelle': call(1.5, gazelleCall, { rms: 0.12 }),
  'idle.gazelle': idle(0.3, gazelleIdle, { rms: 0.1 }),
  'call.gorilla': call(2.3, gorillaCall),
  'idle.gorilla': idle(0.45, gorillaIdle, { hp: 150, squash: 1.5 }),
  'call.penguin': call(2.4, penguinCall),
  'idle.penguin': idle(0.46, penguinIdle),
  'call.flamingo': call(2.0, flamingoCall, { rms: 0.13 }),
  'idle.flamingo': idle(0.34, flamingoIdle, { rms: 0.11 }),
  'amb.owl': call(2.15, owl, { reverb: { decay: 0.55, length: 2, bright: 0.35 }, rms: 0.12 }),
  'amb.songA': call(1.3, songA, { reverb: { decay: 0.45, length: 1.6, bright: 0.5 }, rms: 0.12, hp: 300 }),
  'amb.songB': call(0.8, songB, { reverb: { decay: 0.45, length: 1.6, bright: 0.5 }, rms: 0.11, hp: 300 }),
  'amb.wood': call(1.1, woodpecker, { reverb: { decay: 0.5, length: 1.8, bright: 0.4 }, rms: 0.12, hp: 200 }),
  'amb.crow': call(1.3, crow, { reverb: { decay: 0.5, length: 1.8, bright: 0.4 }, rms: 0.12, hp: 200 }),
};

/** Mix data per species: loudness of call / idle and minimum seconds between calls. */
export interface SpeciesVoice {
  call: number;
  idle: number;
  /** Relative chance of idle vocalising (0 = never). */
  chatty: number;
}

export const SPECIES_VOICE: Record<string, SpeciesVoice> = {
  lion: { call: 1.0, idle: 0.55, chatty: 0.6 },
  tiger: { call: 0.95, idle: 0.5, chatty: 0.7 },
  grizzly: { call: 0.85, idle: 0.5, chatty: 0.5 },
  polarbear: { call: 0.85, idle: 0.45, chatty: 0.5 },
  elephant: { call: 1.0, idle: 0.6, chatty: 0.8 },
  hippo: { call: 0.95, idle: 0.6, chatty: 0.7 },
  rhino: { call: 0.8, idle: 0.55, chatty: 0.7 },
  giraffe: { call: 0.6, idle: 0.45, chatty: 0.5 },
  camel: { call: 0.85, idle: 0.5, chatty: 0.6 },
  zebra: { call: 0.85, idle: 0.5, chatty: 0.8 },
  gazelle: { call: 0.6, idle: 0.4, chatty: 0.6 },
  gorilla: { call: 0.9, idle: 0.5, chatty: 0.7 },
  penguin: { call: 0.75, idle: 0.5, chatty: 1.0 },
  flamingo: { call: 0.7, idle: 0.45, chatty: 1.0 },
};

/** Sound used for a species without its own recipe (new species added later). */
export function voiceIdFor(speciesId: string, diet: string | undefined): string {
  if (SPECIES_VOICE[speciesId]) return speciesId;
  if (diet === 'carnivore') return 'grizzly';
  if (diet === 'piscivore') return 'penguin';
  if (diet === 'omnivore') return 'gorilla';
  return 'rhino';
}
