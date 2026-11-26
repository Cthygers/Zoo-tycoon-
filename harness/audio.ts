// Audio harness: renders every procedural sound offline (exactly as the game
// does), measures it and draws spectrograms so the sounds can be checked
// without ears. Optionally runs an offline full-mix scenario through the real
// engine (beds + calls + cues + master chain) and measures the master output.
//
// URL params:
//   ?only=bed.,cue.   comma-separated id prefixes to render (default: all)
//   ?mix=0            skip the full-mix scenarios
//   ?sounds=0         skip the per-sound renders
// Results: window.__audioReport, window.__audioDone = true.

import * as THREE from 'three';
import { ZooAudio } from '../src/audio/engine';
import { RECIPES, seedFor } from '../src/audio/recipes';
import { renderRecipe, weightedRms, type SoundAsset } from '../src/audio/render';
import type { ISimulation } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { Terrain, type AnimalState, type GuestState } from '../src/core/types';
import { World } from '../src/core/world';

const params = new URLSearchParams(location.search);
const only = (params.get('only') ?? '').split(',').filter(Boolean);
const doMix = params.get('mix') !== '0';
const doSounds = params.get('sounds') !== '0';

interface SoundReport {
  id: string;
  ms: number;
  mainMs: number;
  dur: number;
  peak: number;
  rmsDb: number;
  rmsShortDb: number;
  /** Phone-weighted RMS (what normalisation targets) and which limit bound. */
  wDb: number;
  limit: string;
  dc: number;
  centroid: number;
  bands: number[]; // % energy <250, 250-1k, 1k-4k, >4k
  seam?: number; // loop seam jump / mean step
  seamRms?: number; // rms(last 50 ms) / rms(first 50 ms)
  problems: string[];
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const g2 = canvas.getContext('2d')!;
const statusEl = document.getElementById('status')!;
const outEl = document.getElementById('out')!;
const bar = document.getElementById('bar')!;

// ---------------------------------------------------------------- FFT

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang),
      wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j],
          ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br;
        im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br;
        im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const N = 1024;
const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));

/** Spectrogram columns (dB) + average power spectrum. */
function stft(d: Float32Array, cols: number): { spec: Float32Array[]; avg: Float64Array } {
  const re = new Float64Array(N),
    im = new Float64Array(N);
  const hop = Math.max(1, Math.floor((d.length - N) / cols));
  const spec: Float32Array[] = [];
  const avg = new Float64Array(N / 2);
  for (let c = 0; c < cols; c++) {
    const s = c * hop;
    for (let i = 0; i < N; i++) {
      re[i] = (d[s + i] ?? 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const col = new Float32Array(N / 2);
    for (let k = 0; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      avg[k] += p;
      col[k] = 10 * Math.log10(p / (N * N * 0.25) + 1e-12);
    }
    spec.push(col);
  }
  return { spec, avg };
}

function colour(db: number): string {
  const t = Math.min(1, Math.max(0, (db + 95) / 90));
  const r = Math.round(255 * Math.min(1, Math.max(0, 1.8 * t - 0.5)));
  const g = Math.round(255 * Math.min(1, Math.max(0, 1.6 * t - 0.65)) + 40 * t);
  const b = Math.round(255 * Math.min(1, Math.max(0, 0.55 - Math.abs(t - 0.35) * 1.3)) + 30 * t);
  return `rgb(${r},${Math.min(255, g)},${b})`;
}

const TILE_W = 312,
  TILE_H = 150,
  COLS = 4;

function drawTile(i: number, id: string, a: SoundAsset, rep: SoundReport): void {
  const x0 = (i % COLS) * (TILE_W + 8) + 6;
  const y0 = Math.floor(i / COLS) * (TILE_H + 8) + 4;
  const d = a.buffer.getChannelData(0);
  const sr = a.buffer.sampleRate;
  const W = TILE_W,
    H = 100;
  const { spec } = stft(d, W);
  // log frequency axis 60 Hz .. nyquist
  const fmin = 60,
    fmax = sr / 2;
  for (let c = 0; c < spec.length; c++) {
    for (let y = 0; y < H; y++) {
      const f = fmin * Math.pow(fmax / fmin, 1 - y / H);
      const k = Math.min(N / 2 - 1, Math.round((f / sr) * N));
      g2.fillStyle = colour(spec[c][k]);
      g2.fillRect(x0 + c, y0 + 16 + y, 1, 1);
    }
  }
  // waveform envelope underneath
  g2.fillStyle = '#1c2216';
  g2.fillRect(x0, y0 + 16 + H, W, 22);
  g2.fillStyle = '#9fc46a';
  const per = Math.max(1, Math.floor(d.length / W));
  for (let c = 0; c < W; c++) {
    let pk = 0;
    for (let j = c * per; j < Math.min(d.length, (c + 1) * per); j++) pk = Math.max(pk, Math.abs(d[j]));
    const h = Math.max(1, pk * 22);
    g2.fillRect(x0 + c, y0 + 16 + H + 11 - h / 2, 1, h);
  }
  g2.fillStyle = rep.problems.length ? '#ff8a6a' : '#e4e8d4';
  g2.font = '11px system-ui';
  g2.fillText(`${id}  ${rep.dur.toFixed(2)}s  pk ${rep.peak.toFixed(2)}  rms ${rep.rmsDb.toFixed(1)}dB  c ${Math.round(rep.centroid)}Hz`, x0, y0 + 11);
  // frequency gridlines 250 / 1k / 4k
  g2.fillStyle = 'rgba(255,255,255,0.35)';
  for (const f of [250, 1000, 4000]) {
    const y = H * (1 - Math.log(f / fmin) / Math.log(fmax / fmin));
    g2.fillRect(x0, y0 + 16 + y, 4, 1);
    g2.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x0 + 6, y0 + 20 + y);
  }
}

function analyse(id: string, a: SoundAsset): SoundReport {
  const d = a.buffer.getChannelData(0);
  const sr = a.buffer.sampleRate;
  const n = d.length;
  let peak = 0,
    ss = 0,
    mean = 0,
    nan = false;
  for (let i = 0; i < n; i++) {
    const v = d[i];
    if (!Number.isFinite(v)) nan = true;
    mean += v;
    ss += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  mean /= n;
  const rms = Math.sqrt(ss / n);
  // loudest 400 ms
  const w = Math.min(n, Math.floor(0.4 * sr));
  let s = 0,
    best = 0;
  for (let i = 0; i < n; i++) {
    s += d[i] * d[i];
    if (i >= w) s -= d[i - w] * d[i - w];
    best = Math.max(best, s);
  }
  const rmsShort = Math.sqrt(best / w);
  const { avg } = stft(d, Math.min(400, Math.max(8, Math.floor(n / 512))));
  let num = 0,
    den = 0;
  const bands = [0, 0, 0, 0];
  for (let k = 1; k < avg.length; k++) {
    const f = (k * sr) / N;
    num += f * avg[k];
    den += avg[k];
    bands[f < 250 ? 0 : f < 1000 ? 1 : f < 4000 ? 2 : 3] += avg[k];
  }
  const tot = bands.reduce((p, q) => p + q, 0) || 1;
  const rep: SoundReport = {
    id,
    ms: Math.round(a.ms),
    mainMs: Math.round(a.mainMs * 10) / 10,
    dur: a.duration,
    peak,
    rmsDb: 20 * Math.log10(rms + 1e-12),
    rmsShortDb: 20 * Math.log10(rmsShort + 1e-12),
    wDb: 20 * Math.log10(weightedRms(d, n, sr, a.loopEnd > 0 ? 0 : Math.floor(0.4 * sr)) + 1e-12),
    limit: Math.abs(peak - RECIPES[id].peak) < 0.01 ? 'PEAK' : 'rms',
    dc: mean,
    centroid: num / (den || 1),
    bands: bands.map((b) => Math.round((100 * b) / tot)),
    problems: [],
  };
  if (a.loopEnd > 0) {
    let step = 0;
    for (let i = 1; i < n; i++) step += Math.abs(d[i] - d[i - 1]);
    step /= n - 1;
    rep.seam = Math.abs(d[n - 1] - d[0]) / (step || 1e-9);
    const m = Math.floor(0.05 * sr);
    let e0 = 0,
      e1 = 0;
    for (let i = 0; i < m; i++) {
      e0 += d[i] * d[i];
      e1 += d[n - 1 - i] * d[n - 1 - i];
    }
    rep.seamRms = Math.sqrt(e1 / (e0 || 1e-12));
    if (rep.seam > 4) rep.problems.push(`seam jump ${rep.seam.toFixed(1)}x step`);
  }
  if (nan) rep.problems.push('NaN');
  if (peak >= 0.9) rep.problems.push(`peak ${peak.toFixed(2)} >= 0.9`);
  if (rms < 1e-3) rep.problems.push('near silent');
  if (Math.abs(mean) > 0.002) rep.problems.push(`DC ${mean.toFixed(4)}`);
  return rep;
}

// ---------------------------------------------------------------- playback buttons (for humans)

let live: AudioContext | null = null;
const assets = new Map<string, SoundAsset>();
function playAsset(id: string): void {
  live ??= new AudioContext();
  void live.resume();
  const a = assets.get(id);
  if (!a) return;
  const s = live.createBufferSource();
  s.buffer = a.buffer;
  s.loop = a.loopEnd > 0;
  s.connect(live.destination);
  s.start();
  if (s.loop) s.stop(live.currentTime + 12);
}

// ---------------------------------------------------------------- offline full-mix scenarios

interface Segment {
  name: string;
  t0: number;
  t1: number;
  peak: number;
  rmsDb: number;
}
interface ScenarioReport {
  name: string;
  seconds: number;
  renderMs: number;
  peak: number;
  overThreshold: number; // samples above 0.8 (soft-clip knee)
  segments: Segment[];
  updateMsAvg: number;
  updateMsMax: number;
  updateMsP99: number;
  sourcesCreated: number;
  nodesCreated: number;
  debug: Record<string, unknown>;
  problems: string[];
}
type MixReport = { scenarios: ScenarioReport[]; pan?: unknown };

interface Script {
  name: string;
  seconds: number;
  minute: number;
  /** Camera distance from focus over time. */
  dist: (t: number) => number;
  /** Timed actions. */
  at: [number, (h: Harness) => void | Promise<void>][];
  segments: [string, number, number][];
}

interface Harness {
  audio: ZooAudio;
  sim: { minuteOfDay: number; animals: Map<number, AnimalState>; speed: number };
  events: EventBus;
  animal(species: string): AnimalState;
}

const FOCUS = new THREE.Vector3(60, 0, 60);

function makeSim(): { sim: ISimulation; events: EventBus; animals: Map<number, AnimalState> } {
  const events = new EventBus();
  const world = new World(events, 3);
  // a pond just west of the focus, a fountain to the south-east
  world.setTerrainRect({ x0: 22, z0: 27, x1: 27, z1: 32 }, Terrain.Water);
  world.setTerrainRect({ x0: 23, z0: 28, x1: 25, z1: 31 }, Terrain.DeepWater);
  world.addObject('fountain', 34, 34, 0, 9);
  const animals = new Map<number, AnimalState>();
  const spots: [string, number, number][] = [
    ['lion', 8, 4],
    ['elephant', -16, 12],
    ['zebra', 14, -10],
    ['penguin', -6, -18],
    ['gorilla', 25, 20],
    ['flamingo', -10, 2],
    ['tiger', 45, -30],
  ];
  let id = 1;
  for (const [sp, dx, dz] of spots) {
    animals.set(id, {
      id,
      speciesId: sp,
      name: sp,
      sex: 'M',
      ageDays: 30,
      growth: 1,
      x: FOCUS.x + dx,
      y: 0,
      z: FOCUS.z + dz,
      heading: 0,
      speed: 0,
      action: 'idle',
      actionTime: 5,
      habitatId: 1,
      needs: { hunger: 1, thirst: 1, energy: 1, social: 1, environment: 1, space: 1, enrichment: 1 },
      happiness: 1,
      health: 1,
      pregnantDays: 0,
      escaped: false,
      seed: id,
    });
    id++;
  }
  const guests = new Map<number, GuestState>();
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const r = 6 + (i % 7) * 4;
    guests.set(i + 1, { id: i + 1, x: FOCUS.x + Math.cos(a) * r, y: 0, z: FOCUS.z + Math.sin(a) * r, hidden: false } as unknown as GuestState);
  }
  const sim = {
    world,
    events,
    animals,
    guests,
    staff: new Map(),
    litter: new Map(),
    minuteOfDay: 660,
    speed: 1,
    day: 1,
    isOpen(this: { minuteOfDay: number }) {
      return this.minuteOfDay >= 480 && this.minuteOfDay < 1200;
    },
  } as unknown as ISimulation;
  return { sim, events, animals };
}

async function runScenario(sc: Script): Promise<ScenarioReport> {
  const sr = 44100;
  const off = new OfflineAudioContext(2, Math.ceil(sc.seconds * sr), sr);
  // count node creation during the scenario
  let sources = 0,
    nodes = 0;
  for (const m of ['createGain', 'createBiquadFilter', 'createStereoPanner', 'createBufferSource'] as const) {
    const orig = (off as unknown as Record<string, () => AudioNode>)[m].bind(off);
    (off as unknown as Record<string, () => AudioNode>)[m] = () => {
      nodes++;
      if (m === 'createBufferSource') sources++;
      return orig();
    };
  }
  const { sim, events, animals } = makeSim();
  (sim as unknown as { minuteOfDay: number }).minuteOfDay = sc.minute;
  const audio = new ZooAudio(sim, events, { context: off, seed: 11 });
  // lazily played syllable variants render on first use, as in the game: only the #0 sets up front
  await audio.prefetch(Object.keys(RECIPES).filter((id) => !id.startsWith('syl.') || id.endsWith('#0')));
  const nodesBoot = nodes;
  const sourcesBoot = sources;
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 2000);
  const placeCam = (d: number) => {
    cam.position.set(FOCUS.x + d * 0.55, d * 0.7, FOCUS.z + d * 0.45);
    cam.lookAt(FOCUS);
  };
  const h: Harness & { cam: THREE.PerspectiveCamera } = {
    cam: undefined as unknown as THREE.PerspectiveCamera,
    audio,
    sim: sim as unknown as Harness['sim'],
    events,
    animal: (sp) => [...animals.values()].find((a) => a.speciesId === sp)!,
  };
  h.cam = cam;
  placeCam(sc.dist(0));
  audio.update(0.001, cam, FOCUS);
  const step = 0.05;
  const times: number[] = [];
  const actions = [...sc.at].sort((a, b) => a[0] - b[0]);
  let ai = 0;
  for (let i = 1; i * step < sc.seconds - 0.05; i++) {
    const t = i * step;
    off.suspend(t).then(async () => {
      while (ai < actions.length && actions[ai][0] <= t + 1e-6) await actions[ai++][1](h);
      placeCam(sc.dist(t));
      for (const a of animals.values()) a.actionTime += step;
      const t0 = performance.now();
      audio.update(step, cam, FOCUS);
      times.push(performance.now() - t0);
      await off.resume();
    });
  }
  const tr = performance.now();
  const buf = await off.startRendering();
  const renderMs = performance.now() - tr;
  {
    // where the fountain (+10,+10) and the pond (west) are on screen, for the bed bias check
    cam.updateMatrixWorld();
    const f = new THREE.Vector3(70, 0, 70).project(cam);
    const w = new THREE.Vector3(50, 0, 60).project(cam);
    biasRef.push({ scenario: sc.name, fountainNdcX: +f.x.toFixed(2), pondNdcX: +w.x.toFixed(2) });
  }
  const L = buf.getChannelData(0),
    R = buf.getChannelData(1);
  let peak = 0,
    over = 0;
  for (let i = 0; i < L.length; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peak) peak = a;
    if (a > 0.8) over++;
  }
  const segments: Segment[] = sc.segments.map(([name, t0, t1]) => {
    let pk = 0,
      ss = 0;
    const i0 = Math.floor(t0 * sr),
      i1 = Math.min(L.length, Math.floor(t1 * sr));
    for (let i = i0; i < i1; i++) {
      pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
      ss += L[i] * L[i] + R[i] * R[i];
    }
    return { name, t0, t1, peak: +pk.toFixed(3), rmsDb: +(10 * Math.log10(ss / (2 * Math.max(1, i1 - i0)) + 1e-12)).toFixed(1) };
  });
  const problems: string[] = [];
  if (peak >= 0.9) problems.push(`master peak ${peak.toFixed(3)}`);
  if (over > 0) problems.push(`${over} samples in soft-clip knee`);
  const rep: ScenarioReport = {
    name: sc.name,
    seconds: sc.seconds,
    renderMs: Math.round(renderMs),
    peak: +peak.toFixed(3),
    overThreshold: over,
    segments,
    updateMsAvg: +(times.reduce((a, b) => a + b, 0) / Math.max(1, times.length)).toFixed(4),
    updateMsMax: +Math.max(...times).toFixed(3),
    updateMsP99: +[...times].sort((a, b) => a - b)[Math.floor(times.length * 0.99)].toFixed(3),
    sourcesCreated: sources - sourcesBoot,
    nodesCreated: nodes - nodesBoot,
    debug: audio.debugState(),
    problems,
  };
  mixBuffers.set(sc.name, buf);
  audio.dispose();
  return rep;
}

const mixBuffers = new Map<string, AudioBuffer>();
const biasRef: Record<string, unknown>[] = [];

function callAt(sp: string, t: number): [number, (h: Harness) => void][] {
  return [
    [
      t,
      (h) => {
        const a = h.animal(sp);
        a.action = 'call';
        a.actionTime = 0;
      },
    ],
    [t + 3, (h) => void (h.animal(sp).action = 'idle')],
  ];
}

/** Check that a playing call's stereo pan agrees with the animal's screen position. */
function panCheck(sp: string): [number, (h: Harness) => void] {
  return [
    0,
    (h) => {
      const a = h.animal(sp);
      const cam = (h as unknown as { cam: THREE.PerspectiveCamera }).cam;
      cam.updateMatrixWorld();
      const ndc = new THREE.Vector3(a.x, a.y + 1, a.z).project(cam);
      const voices = (h.audio as unknown as { voices: { track: number; curPan: number; layers: unknown[] }[] }).voices;
      const v = voices.find((x) => x.track === a.id && x.layers.length > 0);
      panResults.push({ species: sp, ndcX: +ndc.x.toFixed(2), pan: v ? +v.curPan.toFixed(2) : null, ok: !!v && Math.sign(v.curPan) === Math.sign(ndc.x) });
    },
  ];
}
const panResults: { species: string; ndcX: number; pan: number | null; ok: boolean }[] = [];

const SCENARIOS: Script[] = [
  {
    name: 'day-close',
    seconds: 24,
    minute: 11 * 60,
    dist: () => 26,
    at: [
      ...callAt('lion', 6),
      [6.3, panCheck('lion')[1]],
      ...callAt('elephant', 10),
      [10.3, panCheck('elephant')[1]],
      ...callAt('zebra', 11.5),
      [14, (h) => h.audio.play('tap')],
      [14.4, (h) => h.audio.play('select')],
      [14.8, (h) => h.audio.play('open')],
      [15.2, (h) => h.audio.play('build')],
      [15.6, (h) => h.audio.play('error')],
      [16, (h) => h.audio.play('bulldoze')],
      [16.4, (h) => h.audio.play('close')],
      ...[0, 0.05, 0.1, 0.2, 0.3, 0.45, 0.6].map((d, i): [number, (h: Harness) => void] => [17 + d, (h) => h.events.emit('moneyPopup', { x: FOCUS.x + i * 3 - 9, z: FOCUS.z + 4, amount: 20 })]),
      [19, (h) => h.events.emit('objectiveCompleted', { id: 'x', text: 'x', reward: 100 })],
      ...callAt('penguin', 21),
      [21.3, panCheck('penguin')[1]],
    ],
    segments: [
      ['ambience', 3, 6],
      ['lion call', 6, 9.5],
      ['elephant+zebra', 10, 13.5],
      ['ui cues', 14, 17],
      ['coins', 17, 18.5],
      ['celebrate', 19, 20.8],
      ['penguin', 21, 23.5],
    ],
  },
  {
    name: 'day-overview',
    seconds: 14,
    minute: 7 * 60,
    dist: (t) => (t < 7 ? 70 : 135),
    at: [...callAt('lion', 4), ...callAt('tiger', 9)],
    segments: [
      ['ambience d70 dawn', 2, 4],
      ['lion d70', 4, 7],
      ['ambience d135', 8, 9],
      ['tiger d135 (far)', 9, 12],
    ],
  },
  {
    name: 'night',
    seconds: 14,
    minute: 23 * 60,
    dist: () => 40,
    at: [[3, (h) => void ((h.audio as unknown as { owlT: number }).owlT = 0)]],
    segments: [
      ['night ambience', 2, 3],
      ['owl', 3, 6],
      ['night ambience', 7, 14],
    ],
  },
  {
    name: 'toggle',
    seconds: 9,
    minute: 11 * 60,
    dist: () => 30,
    at: [
      ...callAt('lion', 3),
      [
        4,
        async (h) => {
          h.audio.setEnabled(false);
          await new Promise((r) => setTimeout(r, 300)); // let the off-timer stop the sources
        },
      ],
      [6.5, (h) => h.audio.setEnabled(true)],
    ],
    segments: [
      ['on', 3, 4],
      ['after off ramp', 4.12, 6.4],
      ['back on', 7.5, 9],
    ],
  },
];

async function runMixScenarios(): Promise<MixReport> {
  const scenarios: ScenarioReport[] = [];
  for (const sc of SCENARIOS) {
    statusEl.textContent = `mix scenario ${sc.name}…`;
    scenarios.push(await runScenario(sc));
  }
  for (const [name, buf] of mixBuffers) {
    const b = document.createElement('button');
    b.textContent = `mix: ${name}`;
    b.onclick = () => {
      live ??= new AudioContext();
      void live.resume();
      const s = live.createBufferSource();
      s.buffer = buf;
      s.connect(live.destination);
      s.start();
    };
    bar.append(b);
  }
  return { scenarios, pan: panResults, bias: biasRef } as MixReport;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const ids = Object.keys(RECIPES).filter((id) => !only.length || only.some((p) => id.startsWith(p)));
  const reports: SoundReport[] = [];
  if (doSounds) {
    canvas.height = Math.ceil(ids.length / COLS) * (TILE_H + 8) + 8;
    g2.fillStyle = '#12150f';
    g2.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      statusEl.textContent = `rendering ${id} (${i + 1}/${ids.length})`;
      try {
        const a = await renderRecipe(RECIPES[id], seedFor(id));
        assets.set(id, a);
        const rep = analyse(id, a);
        reports.push(rep);
        drawTile(i, id, a, rep);
        const b = document.createElement('button');
        b.textContent = id;
        b.onclick = () => playAsset(id);
        bar.append(b);
      } catch (err) {
        reports.push({ id, ms: 0, mainMs: 0, dur: 0, peak: 0, rmsDb: -999, rmsShortDb: -999, wDb: -999, limit: '', dc: 0, centroid: 0, bands: [], problems: [`render failed: ${String(err)}`] });
      }
    }
  }
  let mix: MixReport | null = null;
  if (doMix) {
    statusEl.textContent = 'running offline mix scenarios…';
    try {
      mix = await runMixScenarios();
    } catch (err) {
      mix = { error: String((err as Error)?.stack ?? err) } as unknown as MixReport;
    }
  }
  const lines = reports.map(
    (r) =>
      `${r.id.padEnd(16)} ${String(r.ms).padStart(5)}ms main ${r.mainMs.toFixed(1).padStart(5)} ${r.dur.toFixed(2).padStart(6)}s pk ${r.peak.toFixed(3)} rms ${r.rmsDb.toFixed(1).padStart(6)} short ${r.rmsShortDb
        .toFixed(1)
        .padStart(6)} w ${r.wDb.toFixed(1).padStart(6)} ${r.limit.padEnd(4)} dc ${r.dc.toFixed(4).padStart(7)} cen ${String(Math.round(r.centroid)).padStart(5)} bands ${r.bands.join('/')}${
        r.seam !== undefined ? ` seam ${r.seam.toFixed(2)} seamRms ${r.seamRms!.toFixed(2)}` : ''
      }${r.problems.length ? '  !! ' + r.problems.join('; ') : ''}`,
  );
  outEl.textContent = lines.join('\n') + (mix ? '\n\n' + JSON.stringify(mix, null, 1) : '');
  statusEl.textContent = `done: ${reports.length} sounds, ${reports.filter((r) => r.problems.length).length} with problems`;
  (window as unknown as Record<string, unknown>).__audioReport = { sounds: reports, lines, mix };
  (window as unknown as Record<string, unknown>).__audioDone = true;
}

main().catch((err) => {
  statusEl.textContent = 'FAILED ' + String(err);
  (window as unknown as Record<string, unknown>).__audioReport = { error: String(err?.stack ?? err) };
  (window as unknown as Record<string, unknown>).__audioDone = true;
});
