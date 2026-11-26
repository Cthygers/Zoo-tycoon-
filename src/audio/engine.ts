// Procedural audio engine for Wildhaven Zoo (IAudio + AudioHost).
//
// Signal flow (one live AudioContext, created lazily on the first gesture):
//
//   beds, keyed loops, amb pool ─► ambience ─┐
//   voice / foley / fx pools    ─► world    ─┤  (each channel: level ► volume ► duck)
//   shared outdoor reverb       ─► world    ─┤  world + ambience ► world filter ─┐
//   UI cues (unpooled)          ─► ui       ─┼───────────────────────────────────┼─► master volume ► master
//   (music: empty this round)   ─► music    ─┘                                   │      ► glue ► limiter ► soft clip ► out
//
// A pooled voice: source(s) ► low-pass (air) ► 3 kHz shelf ► colour peak ► gain
// (distance) ► panner ► channel, plus a send (distance wet) to the reverb.
//
// Every sound is pre-rendered once (lazily, one recipe at a time, off the
// main thread in an OfflineAudioContext — see render.ts) so the per-frame work
// is only bookkeeping: distance / panning and occasional AudioParam ramps.
// Nodes are created only when a sound starts.
//
// Engine modules (src/audio/modules/*.ts) add behaviour through the AudioHost
// contract in host.ts; a module that owns the animals or coins switches the
// built-in versions off.

import type * as THREE from 'three';
import { MAP_H, MAP_W, QUALITY_KEY, TILE } from '../core/constants';
import type { AudioChannel, IAudio, ISimulation } from '../core/contracts';
import type { EventBus } from '../core/events';
import { Rng } from '../core/rng';
import { Terrain, type AnimalState, type GuestState } from '../core/types';
import { getObjectDef } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import {
  DEFAULT_RADIUS,
  DEFAULT_REF_DIST,
  POOL_CHANNEL,
  POOL_SIZES,
  distanceModel,
  type Attenuation,
  type AudioHost,
  type AudioModule,
  type AudioModuleFactory,
  type Channel,
  type ListenerState,
  type PlayLog,
  type PlaySpec,
  type Pool,
  type VoiceHandle,
} from './host';
import { smoothstep } from './kit';
import { RECIPES, SPECIES_VOICE, seedFor, voiceIdFor, type SpeciesVoice } from './recipes';
import { offlineCtor, outdoorImpulse, releaseRenderCaches, renderRecipe, setRenderBudget, yieldMain, type SoundAsset } from './render';

export type Cue = Parameters<IAudio['play']>[0];

export interface AudioEngineOptions {
  /** Render into this context instead of creating an AudioContext (offline harness mix). */
  context?: BaseAudioContext;
  seed?: number;
  /** Fewer voices, mono side beds and 16 kHz renders for low-end phones. */
  lowSpec?: boolean;
  /** Install one-shot unlock listeners (touchend / click / keydown). Default: true with a window. */
  autoUnlock?: boolean;
  /** Engine modules by path (tests); default: every src/audio/modules/*.ts. */
  modules?: Record<string, AudioModuleFactory>;
}

const MODULES = import.meta.glob<AudioModuleFactory>('./modules/*.ts', { eager: true, import: 'default' });

const BED_IDS = ['wind', 'birds', 'night', 'crowd', 'water', 'fountain', 'savanna', 'savanna.night', 'arctic', 'humid', 'humid.night'] as const;
type BedId = (typeof BED_IDS)[number];
/** Static mix level of each bed relative to its normalised buffer (biome beds carry theirs in the level formula). */
const BED_MIX: Record<BedId, number> = {
  wind: 0.36,
  birds: 0.5,
  night: 0.4,
  crowd: 0.4,
  water: 0.42,
  fountain: 0.36,
  savanna: 1,
  'savanna.night': 1,
  arctic: 1,
  humid: 1,
  'humid.night': 1,
};
/** Beds that keep their stereo pair on lowSpec (wide, enveloping layers). */
const LOWSPEC_STEREO: ReadonlySet<BedId> = new Set(['wind', 'birds', 'night', 'crowd']);
/** Scratch per-bed target levels (reused every update). */
const BED_LEVELS = Object.fromEntries(BED_IDS.map((b) => [b, 0])) as Record<BedId, number>;
const CUE_IDS: readonly Cue[] = ['tap', 'select', 'open', 'close', 'build', 'bulldoze', 'error', 'deny', 'cash', 'celebrate'];
const CHANNELS: readonly Channel[] = ['ambience', 'world', 'ui', 'music'];
const VOLUME_CHANNELS: readonly AudioChannel[] = ['master', ...CHANNELS];
/** Master gain into the glue compressor (calibrated to the loudness targets). */
const MASTER = 1.9;
/**
 * Static channel levels, calibrated with MASTER on the demo zoo: day close
 * views −16 LUFS, a lion roar within its reference distance −10…−13 LUFS
 * momentary; UI cues stay at 0.8 × the world level.
 */
const CHANNEL_LEVEL: Record<Channel, number> = { ambience: 0.55, world: 0.4, ui: 0.32, music: 1 };
/** Outdoor reverb return (unit-energy IR): at the full send (≥ 29 m) the tail sits ~3 dB under the dry sound. */
const REVERB_RETURN = 1.8;
/** Σ bed levels in a busy daytime close view: the UI channel is at full level from here up. */
const DAY_CLOSE_REF = 1.1;
/** Legacy animal calls: audible radius around the ear, m. */
const CALL_RADIUS = 60;
const AMBIENT_ONESHOTS = ['amb.songA', 'amb.songB', 'amb.songA', 'amb.wood', 'amb.crow'] as const;
/** lowSpec render rate for everything but UI cues. */
const LOWSPEC_RATE = 16000;
/** Max keyed loops [normal, lowSpec] and beds playing at once. */
const MAX_LOOPS: readonly [number, number] = [4, 2];
const MAX_BEDS: readonly [number, number] = [7, 5];
/** Steal / stop fade (s) and the gap before a stolen voice restarts. */
const STEAL_FADE = 0.02;
const STEAL_GAP = 0.025;
const MAX_LAYERS = 2;

const noop = () => {};

/**
 * Freeze a param at its current value (cancelAndHoldAtTime where available) so
 * a ramp can start from it. The explicit setValueAtTime anchors the next ramp:
 * Chromium starts a ramp that follows a bare cancelAndHold from the wrong
 * point and the gain steps.
 */
function hold(p: AudioParam, now: number): void {
  const v = p.value;
  if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(now);
  else p.cancelScheduledValues(now);
  p.setValueAtTime(v, now);
}

/** Click-free fade to silence from the current value. */
function fadeOut(p: AudioParam, now: number, fade: number): void {
  hold(p, now);
  p.linearRampToValueAtTime(0, now + fade);
}

function safeStop(s: AudioScheduledSourceNode, at: number): void {
  try {
    s.stop(at);
  } catch {
    /* already stopped */
  }
}

/** Two-pole Butterworth sections for a 4-pole low-pass. */
const LP4_Q = [0.541, 1.307] as const;

// -------------------------------------------------------------------- beds

/** A looping bed: two sources (left / right) through a 4-pole low-pass. Also used for keyed loops. */
class Bed {
  asset: SoundAsset | null = null;
  /** Optional second layer for the right-hand source (bed.<id>.b). */
  assetB: SoundAsset | null = null;
  readonly out: GainNode;
  private readonly lp: BiquadFilterNode[];
  private readonly inputs: AudioNode[];
  private readonly pans: StereoPannerNode[] = [];
  private srcs: AudioBufferSourceNode[] = [];
  playing = false;
  quiet = 0;
  level = 0;
  bias = 0;
  cut = 0;
  /** Level changes wait until the start-up fade from silence is done. */
  private startAt = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    dest: AudioNode,
    stereo: boolean,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.lp = LP4_Q.map((q) => {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = Math.min(9000, 0.45 * ctx.sampleRate);
      f.Q.value = q;
      return f;
    });
    this.out.connect(this.lp[0]);
    this.lp[0].connect(this.lp[1]);
    this.lp[1].connect(dest);
    if (stereo && typeof ctx.createStereoPanner === 'function') {
      this.inputs = [-0.65, 0.65].map((p) => {
        const sp = ctx.createStereoPanner();
        sp.pan.value = p;
        sp.connect(this.out);
        this.pans.push(sp);
        return sp;
      });
    } else this.inputs = [this.out];
  }

  start(rng: Rng): void {
    if (this.playing || !this.asset) return;
    const buf = this.asset.buffer;
    const L = buf.duration;
    const off = rng.range(0, L);
    const now = this.ctx.currentTime;
    // from silence (a stop fade may still be running)
    fadeOut(this.out.gain, now, STEAL_FADE);
    const at = now + STEAL_GAP;
    this.startAt = at;
    this.level = 0;
    this.setCut(this.cut || 18000, 0);
    for (let i = 0; i < this.inputs.length; i++) {
      const s = this.ctx.createBufferSource();
      const b = i === 1 ? this.assetB : null;
      s.buffer = b ? b.buffer : buf;
      s.loop = true;
      s.connect(this.inputs[i]);
      if (b) s.start(at, rng.range(0, b.buffer.duration));
      else {
        // the second copy runs half a loop apart and 3.5 % slower: decorrelated
        // left / right, and the pair never lines up the same way twice
        if (i === 1) s.playbackRate.value = 0.966;
        s.start(at, (off + i * L * 0.5) % L);
      }
      this.srcs.push(s);
    }
    this.playing = true;
    this.quiet = 0;
  }

  /** Fade out over 60 ms, then stop the sources. */
  stop(): void {
    const now = this.ctx.currentTime;
    fadeOut(this.out.gain, now, 0.06);
    for (const s of this.srcs) {
      safeStop(s, now + 0.065);
      s.onended = () => s.disconnect();
    }
    this.srcs = [];
    this.playing = false;
    this.level = 0;
  }

  dispose(): void {
    if (this.playing) this.stop();
    const out = this.lp[1];
    setTimeout(() => out.disconnect(), 200);
  }

  /** Low-pass cutoff, capped below the buffer's Nyquist (no resampling images at 48 kHz). */
  setCut(hz: number, tc = 0.3): void {
    const sr = this.asset?.buffer.sampleRate ?? 22050;
    const f = Math.min(hz, 0.45 * sr, 0.49 * this.ctx.sampleRate);
    if (Math.abs(f - this.cut) < this.cut * 0.04) return;
    this.cut = f;
    const now = this.ctx.currentTime;
    for (const lp of this.lp) {
      if (tc > 0) lp.frequency.setTargetAtTime(f, now, tc);
      else {
        lp.frequency.cancelScheduledValues(now);
        lp.frequency.setValueAtTime(f, now);
      }
    }
  }

  /** Lean the stereo pair towards a side (-1..1) where the source of this bed is. */
  setBias(b: number): void {
    if (!this.pans.length || Math.abs(b - this.bias) < 0.04) return;
    this.bias = b;
    const now = this.ctx.currentTime;
    this.pans[0].pan.setTargetAtTime(Math.max(-1, Math.min(1, -0.65 + b)), now, 0.5);
    this.pans[1].pan.setTargetAtTime(Math.max(-1, Math.min(1, 0.65 + b)), now, 0.5);
  }

  setLevel(v: number, tc: number): void {
    if (Math.abs(v - this.level) < 0.002) return;
    this.level = v;
    this.out.gain.setTargetAtTime(v, Math.max(this.ctx.currentTime, this.startAt), tc);
  }
}

interface LoopEmitter {
  bed: Bed;
  id: string;
  ch: Channel;
  level: number;
  side: number;
  quiet: number;
}

// -------------------------------------------------------------------- voices

/** One source playing on a voice (a voice layers up to MAX_LAYERS of them for bouts). */
interface Layer {
  src: AudioBufferSourceNode;
  gain: GainNode;
  level: number;
  endAt: number;
  stopped: boolean;
}

class Voice {
  layers: Layer[] = [];
  readonly lp: BiquadFilterNode;
  readonly shelf: BiquadFilterNode;
  readonly color: BiquadFilterNode;
  readonly gain: GainNode;
  readonly pan: StereoPannerNode | null;
  readonly send: GainNode | null;
  endAt = 0;
  startAt = 0;
  /** Priority at start (for stealing). */
  prio = 0;
  /** Animal id to follow (-1 = fixed or non-positional). */
  track = -1;
  /** Fixed world position ('at' plays), steered as the camera moves. */
  fixed = false;
  px = 0;
  py = 0;
  pz = 0;
  refDist = DEFAULT_REF_DIST;
  radius = DEFAULT_RADIUS;
  group = -1;
  /** Sample rate of the playing buffer (caps the low-pass below its Nyquist). */
  bufRate = 22050;
  curGain = 0;
  curPan = 0;
  curCut = 0;
  curShelf = 0;
  curWet = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    dest: AudioNode,
    reverb: AudioNode | null,
  ) {
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = Math.min(9000, 0.45 * ctx.sampleRate);
    this.lp.Q.value = 0.5;
    this.shelf = ctx.createBiquadFilter();
    this.shelf.type = 'highshelf';
    this.shelf.frequency.value = 3000;
    this.color = ctx.createBiquadFilter();
    this.color.type = 'peaking';
    this.color.Q.value = 1.2;
    this.color.gain.value = 0;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.lp.connect(this.shelf);
    this.shelf.connect(this.color);
    this.color.connect(this.gain);
    this.pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    if (this.pan) {
      this.gain.connect(this.pan);
      this.pan.connect(dest);
    } else this.gain.connect(dest);
    if (reverb) {
      this.send = ctx.createGain();
      this.send.gain.value = 0;
      this.gain.connect(this.send);
      this.send.connect(reverb);
    } else this.send = null;
  }

  busy(now: number): boolean {
    if (this.layers.length && now >= this.endAt) this.layers.length = 0;
    return this.layers.length > 0;
  }

  /** Start a new play on this voice (stealing whatever it plays) with these distance parameters. */
  start(buf: AudioBuffer, rate: number, level: number, when: number, att: Readonly<Attenuation>, color: { hz: number; db: number } | undefined): Layer {
    const now = this.ctx.currentTime;
    let at = Math.max(now, when);
    if (this.busy(now)) {
      for (const l of this.layers) this.fadeLayer(l, now, STEAL_FADE);
      this.layers.length = 0;
      at = Math.max(at, now + STEAL_GAP);
    }
    this.bufRate = buf.sampleRate;
    const cut = this.cutFor(att);
    const params: [AudioParam, number][] = [
      [this.gain.gain, att.gain],
      [this.lp.frequency, cut],
      [this.shelf.gain, att.shelfDb],
      [this.color.frequency, color?.hz ?? 1000],
      [this.color.gain, color?.db ?? 0],
    ];
    if (this.pan) params.push([this.pan.pan, att.pan]);
    if (this.send) params.push([this.send.gain, att.wet]);
    // a stolen voice is silent from now + STEAL_FADE: switch its parameters after that
    for (const [p, v] of params) {
      hold(p, now);
      p.setValueAtTime(v, at);
    }
    this.curGain = att.gain;
    this.curPan = att.pan;
    this.curCut = cut;
    this.curShelf = att.shelfDb;
    this.curWet = att.wet;
    this.startAt = at;
    this.endAt = 0;
    return this.layer(buf, rate, level, at);
  }

  /** Add a source to this voice (bout layering; at most MAX_LAYERS overlap). */
  layer(buf: AudioBuffer, rate: number, level: number, when: number): Layer {
    const now = this.ctx.currentTime;
    const at = Math.max(now, when);
    const live = this.layers.filter((l) => !l.stopped && l.endAt > now);
    if (live.length >= MAX_LAYERS) {
      // drop the layer that ends first, just before the new one starts
      live.sort((a, b) => a.endAt - b.endAt);
      const old = live[0];
      const t0 = Math.max(now, at - STEAL_GAP);
      if (t0 <= now) this.fadeLayer(old, now, STEAL_FADE);
      else {
        old.gain.gain.setValueAtTime(old.level, t0);
        old.gain.gain.linearRampToValueAtTime(0, t0 + STEAL_FADE);
        safeStop(old.src, t0 + STEAL_GAP);
        old.stopped = true;
        old.endAt = Math.min(old.endAt, t0 + STEAL_GAP);
      }
    }
    this.layers = live.filter((l) => !l.stopped);
    this.refreshEnd();
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(level, at);
    g.connect(this.lp);
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    s.connect(g);
    s.start(at);
    const layer: Layer = { src: s, gain: g, level, endAt: at + buf.duration / rate + 0.05, stopped: false };
    s.onended = () => {
      s.disconnect();
      g.disconnect();
    };
    this.layers.push(layer);
    this.endAt = Math.max(this.endAt, layer.endAt);
    return layer;
  }

  /** Click-free stop of one layer: hold, 20 ms (or `fade`) ramp, then stop. */
  fadeLayer(l: Layer, now: number, fade: number): void {
    if (l.stopped) return;
    l.stopped = true;
    fadeOut(l.gain.gain, now, fade);
    safeStop(l.src, now + fade + 0.005);
    l.endAt = Math.min(l.endAt, now + fade + 0.005);
    this.refreshEnd();
  }

  private refreshEnd(): void {
    let end = 0;
    for (const l of this.layers) end = Math.max(end, l.endAt);
    this.endAt = end;
  }

  /** Smoothly follow a moving source / the turning camera. */
  steer(att: Readonly<Attenuation>): void {
    const now = this.ctx.currentTime;
    if (Math.abs(att.gain - this.curGain) > 0.01) {
      this.curGain = att.gain;
      this.gain.gain.setTargetAtTime(att.gain, now, 0.08);
    }
    if (this.pan && Math.abs(att.pan - this.curPan) > 0.03) {
      this.curPan = att.pan;
      this.pan.pan.setTargetAtTime(att.pan, now, 0.08);
    }
    const cut = this.cutFor(att);
    if (Math.abs(cut - this.curCut) > this.curCut * 0.08) {
      this.curCut = cut;
      this.lp.frequency.setTargetAtTime(cut, now, 0.1);
    }
    if (Math.abs(att.shelfDb - this.curShelf) > 0.5) {
      this.curShelf = att.shelfDb;
      this.shelf.gain.setTargetAtTime(att.shelfDb, now, 0.1);
    }
    if (this.send && Math.abs(att.wet - this.curWet) > 0.02) {
      this.curWet = att.wet;
      this.send.gain.setTargetAtTime(att.wet, now, 0.1);
    }
  }

  /** Air-absorption cutoff, kept below the buffer's and the context's Nyquist. */
  private cutFor(att: Readonly<Attenuation>): number {
    return Math.min(att.cut, 0.45 * this.bufRate, 0.49 * this.ctx.sampleRate);
  }

  stop(fade = STEAL_FADE): void {
    if (!this.layers.length) return;
    const now = this.ctx.currentTime;
    for (const l of this.layers) this.fadeLayer(l, now, fade);
    this.layers.length = 0;
  }
}

interface ChannelNodes {
  /** Static level (and, for ui, the ambience-relative scale). */
  input: GainNode;
  /** Player volume, v². */
  vol: GainNode;
  /** Ducking, separate from the volume. */
  duck: GainNode;
  duckDb: number;
  duckUntil: number;
}

interface SpeciesInfo {
  callId: string;
  idleId: string;
  voice: SpeciesVoice;
}

interface ModuleEntry {
  name: string;
  m: AudioModule;
  failed: boolean;
}

/** Owl bouts come from one tree for a while, then it moves (A1-25). */
interface OwlPerch {
  x: number;
  y: number;
  z: number;
  /** Engine time at which the owl moves on. */
  until: number;
}

// -------------------------------------------------------------------- engine

export class ZooAudio implements IAudio {
  /** Contract for engine modules (also used by tests and probes). */
  readonly host: AudioHost;
  /** Set to [] to record every started sound (host.play, cues and legacy). */
  debugLog: PlayLog[] | null = null;

  private _enabled = true;
  private appSuspended = false;
  private disposed = false;
  private readonly injected: BaseAudioContext | null;
  private ctx: BaseAudioContext | null = null;
  private master!: GainNode;
  private masterVol!: GainNode;
  private chan!: Record<Channel, ChannelNodes>;
  private worldFilter!: BiquadFilterNode;
  private worldGain!: GainNode;
  /** Probe names: ambience / world (reverb included) / ui channel outputs. */
  private ambBus!: GainNode;
  private sfxBus!: GainNode;
  private uiBus!: GainNode;
  private reverbIn!: GainNode;
  private readonly beds = new Map<BedId, Bed>();
  private readonly loops = new Map<string, LoopEmitter>();
  private readonly pools: Record<Exclude<Pool, 'ui'>, Voice[]> = { voice: [], foley: [], fx: [], amb: [] };
  /** Probe names for the animal and fx pools. */
  private voices: Voice[] = this.pools.voice;
  private fxVoices: Voice[] = this.pools.fx;
  private uiLive = 0;
  private readonly sounds = new Map<string, SoundAsset>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private queue: string[] = [];
  /** Queued ids that were requested urgently: they keep their order (first requested, first rendered). */
  private readonly urgentIds = new Set<string>();
  private working = false;
  private idleWaiters: (() => void)[] = [];
  private warned = false;
  private offTimer: ReturnType<typeof setTimeout> | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly rng: Rng;
  private readonly lowSpec: boolean;
  private readonly unsub: (() => void)[] = [];
  private unlockBound: (() => void) | null = null;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Background pre-rendering has been queued (warmup or context boot). */
  private warmed = false;
  /** Pending build of the shared reverb's impulse response (runs in the render queue after the cues). */
  private reverbBuild: (() => Promise<void>) | null = null;
  /** The context stopped on its own (Android interruption): retry resume. */
  private needsResume = false;
  private resumeRetryT = 0;
  private readonly volumes: Record<AudioChannel, number> = { master: 1, ambience: 1, world: 1, ui: 1, music: 1 };
  private followId = -1;
  private readonly modules: ModuleEntry[] = [];
  private readonly ownsAnimals: boolean;
  private readonly ownsCoins: boolean;

  // listener (updated every frame)
  private readonly ear: ListenerState = { x: 0, y: 30, z: 0, fx: 0, fz: 0, camDist: 60, zoomNear: 0.5 };
  private rx = 1;
  private ry = 0;
  private rz = 0;
  private fwx = 0;
  private fwy = 0;
  private fwz = -1;
  private readonly att: Attenuation = { gain: 0, pan: 0, cut: 18000, shelfDb: 0, wet: 0.05, dist: 0 };

  // environment
  private time = 0;
  private envT = 0;
  private animT = 0;
  private voiceT = 0;
  private gNear = 0;
  private gSide = 0;
  private gVisible = 0;
  private waterSide = 0;
  private fountainSide = 0;
  private crowdNear = 0;
  private crowdFar = 0;
  private waterNear = 0;
  private fountainNear = 0;
  private openness = 1;
  private nightness = 0;
  private birdsDay = 1;
  /** UI level relative to its channel level (follows how busy the ambience is). */
  private uiScale = 1;
  private readonly biome = { savanna: 0, arctic: 0, humid: 0 };
  private readonly biomeSide = { savanna: 0, arctic: 0, humid: 0 };
  /** Per habitat id: 1 = holds a desert species, 2 = holds a tropical / wetland species. */
  private readonly habitatBiome = new Map<number, number>();
  private habitatsDirty = true;
  private fountains: number[] = [];
  private trees: number[] = [];
  private objectsDirty = true;
  private readonly calling = new Set<number>();
  private readonly near = new Int32Array(256);
  private nearCount = 0;
  private readonly lastCall = new Map<string, number>();
  private readonly lastIdle = new Map<string, number>();
  private readonly lastCue = new Map<Cue, number>();
  private readonly spInfo = new Map<string, SpeciesInfo>();
  private owlT = 20;
  private owl: OwlPerch | null = null;
  private owlMate: { x: number; y: number; z: number } | null = null;
  private birdT = 6;
  private coinTokens = 3;
  private coinRefill = 0;
  private coinLast = -1;

  constructor(
    private readonly sim: ISimulation,
    private readonly events: EventBus,
    opts: AudioEngineOptions = {},
  ) {
    this.injected = opts.context ?? null;
    this.rng = new Rng(opts.seed ?? 0x5eed);
    this.lowSpec = opts.lowSpec ?? false;
    this.host = this.makeHost();
    const factories = opts.modules ?? MODULES;
    for (const path of Object.keys(factories).sort()) {
      const name = path.replace(/^.*\//, '').replace(/\.ts$/, '');
      try {
        this.modules.push({ name, m: factories[path](this.host), failed: false });
      } catch (err) {
        console.warn(`[audio] module ${name} disabled:`, err);
      }
    }
    this.ownsAnimals = this.modules.some((e) => e.m.ownsAnimals);
    this.ownsCoins = this.modules.some((e) => e.m.ownsCoins);
    this.unsub.push(
      events.on('objectiveCompleted', () => this.play('celebrate')),
      events.on('animalRemoved', (e) => this.calling.delete(e.id)),
      events.on('objectAdded', () => (this.objectsDirty = true)),
      events.on('objectRemoved', () => (this.objectsDirty = true)),
      events.on('habitatsChanged', () => (this.habitatsDirty = true)),
      events.on('worldReset', () => {
        this.objectsDirty = true;
        this.habitatsDirty = true;
        this.calling.clear();
        this.owl = this.owlMate = null;
        if (this.warmed && !this.ownsAnimals) this.requestAllSpecies();
      }),
    );
    if (!this.ownsCoins) this.unsub.push(events.on('moneyPopup', (m) => this.onCoin(m.x, m.z, m.amount)));
    this.unsub.push(
      events.on('animalAdded', (e) => {
        this.habitatsDirty = true;
        const a = this.sim.animals.get(e.id);
        if (a && this.warmed && !this.ownsAnimals) this.requestSpecies(a.speciesId);
      }),
    );
    if (this.injected) {
      this.boot(this.injected);
    } else if ((opts.autoUnlock ?? true) && typeof window !== 'undefined') {
      this.installUnlock();
      // Pre-render in the background (no gesture needed for offline rendering)
      // once the first frames are out, so sounds are ready at the first tap.
      this.warmTimer = setTimeout(() => this.warmup(), 1200);
    }
  }

  private makeHost(): AudioHost {
    const self = this;
    return {
      sim: this.sim,
      events: this.events,
      lowSpec: this.lowSpec,
      get time() {
        return self.time;
      },
      now: () => self.ctx?.currentTime ?? 0,
      get active() {
        return self.active();
      },
      listener: this.ear,
      get hour() {
        return self.sim.minuteOfDay / 60;
      },
      get nightness() {
        return self.nightness;
      },
      get followId() {
        return self.followId;
      },
      attenuate: (x, y, z, refDist, radius) => this.attenuate(x, y, z, refDist, radius),
      has: (id) => this.sounds.has(id),
      request: (id, urgent) => this.request(id, urgent),
      duration: (id) => this.sounds.get(id)?.duration ?? 0,
      play: (spec) => this.playSpec(spec),
      loop: (key, id, level, side, ch) => this.loop(key, id, level, side, ch),
      duck: (ch, db, holdS) => this.duck(ch, db, holdS),
      setWorldFilter: (cut, db, tc) => this.setWorldFilter(cut, db, tc),
      playing: (pool) => this.playing(pool),
    };
  }

  /** Queue the sounds the current scene needs; start audio if the page already had a tap. */
  private warmup(): void {
    this.warmTimer = null;
    if (this.disposed || !this._enabled) return;
    this.queueWarm();
    // the player tapped through the menu: the context may start without another gesture
    if (userActivation() === true) this.resume();
  }

  /** Render order: cues, the current beds (urgent), module warm-up ids, then legacy calls. */
  private queueWarm(): void {
    if (this.warmed) return;
    this.warmed = true;
    for (const cue of CUE_IDS) this.request(cueId(cue));
    if (!this.ownsCoins) for (let k = 0; k < 4; k++) this.request(`cue.coin#${k}`);
    const h = this.sim.minuteOfDay / 60;
    this.request(h < 5.5 || h > 20 ? 'bed.night' : 'bed.birds', true);
    this.request('bed.wind', true);
    if (this.sim.guests.size) this.request('bed.crowd');
    for (const e of this.modules) {
      try {
        for (const id of e.m.warm?.() ?? []) this.request(id);
      } catch (err) {
        this.moduleFailed(e, err);
      }
    }
    if (!this.ownsAnimals) this.requestAllSpecies();
  }

  // ================================================================ IAudio

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(on: boolean): void {
    on = !!on;
    if (on === this._enabled) return;
    this._enabled = on;
    const c = this.ctx;
    if (!c) return;
    const now = c.currentTime;
    const g = this.master.gain;
    hold(g, now);
    if (this.offTimer !== null) {
      clearTimeout(this.offTimer);
      this.offTimer = null;
    }
    if (on) {
      g.setTargetAtTime(MASTER, now + 0.02, 0.15);
      if (!this.appSuspended) this.resumeContext();
      void this.pump();
    } else {
      g.linearRampToValueAtTime(0, now + 0.06);
      // after the ramp: stop every source and suspend the context (no CPU)
      this.offTimer = setTimeout(() => {
        this.offTimer = null;
        if (this._enabled || !this.ctx) return;
        this.stopAll();
        if (!this.injected) (this.ctx as AudioContext).suspend().catch(noop);
      }, 150);
    }
  }

  resume(): void {
    if (this.disposed) return;
    const wasSuspended = this.appSuspended;
    this.appSuspended = false;
    if (!this._enabled) return;
    if (!this.ctx) {
      // never create a context before the page has had a user gesture: it would
      // start suspended and log an autoplay warning; the unlock listeners retry
      if (userActivation() === false) return;
      const c = this.createContext();
      if (!c) return;
      this.boot(c);
    }
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    this.resumeContext();
    if (wasSuspended) {
      // fade back in from the silence suspend() left
      const now = this.ctx!.currentTime;
      hold(this.master.gain, now);
      this.master.gain.linearRampToValueAtTime(MASTER, now + 0.3);
    }
    void this.pump();
  }

  suspend(): void {
    if (this.appSuspended) return;
    this.appSuspended = true;
    if (!this.ctx) return;
    // 40 ms fade first: suspending mid-waveform pops
    const now = this.ctx.currentTime;
    fadeOut(this.master.gain, now, 0.04);
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      if (!this.appSuspended || !this.ctx) return;
      this.stopVoices();
      if (!this.injected) {
        const c = this.ctx as AudioContext;
        if (c.state === 'running') c.suspend().catch(noop);
      }
    }, 60);
  }

  play(cue: Cue): void {
    if (!this._enabled || this.disposed || this.appSuspended) return;
    // a UI cue runs right after a tap: a good moment to unlock / resume
    if (!this.ctx || (!this.injected && (this.ctx as AudioContext).state !== 'running')) this.resume();
    if (!this.active()) return;
    const now = this.ctx!.currentTime;
    const last = this.lastCue.get(cue) ?? -1;
    if (now - last < 0.045) return;
    const id = cueId(cue);
    // tiny pitch and onset variation: repeated taps never sound machine-identical
    const jitter = cue === 'tap' || cue === 'select' || cue === 'cash';
    const h = this.playSpec({
      id,
      pool: 'ui',
      rate: jitter ? 1 + this.rng.range(-0.004, 0.004) : 1,
      when: jitter ? now + this.rng.range(0, 0.008) : now,
    });
    if (!h) return;
    this.lastCue.set(cue, now);
    // let the jingle breathe
    if (cue === 'celebrate') this.duck('ambience', -6, 1.3);
  }

  setVolume(ch: AudioChannel, v: number): void {
    v = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
    const was = this.volumes[ch];
    this.volumes[ch] = v;
    if (!this.ctx) return;
    const g = ch === 'master' ? this.masterVol.gain : this.chan[ch].vol.gain;
    const now = this.ctx.currentTime;
    hold(g, now);
    g.linearRampToValueAtTime(v * v, now + 0.05);
    if (v === 0 && was > 0) this.stopChannel(ch);
  }

  volume(ch: AudioChannel): number {
    return this.volumes[ch];
  }

  follow(animalId: number | null): void {
    this.followId = animalId ?? -1;
  }

  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3): void {
    if (this.needsResume) this.retryResume(dt);
    if (!this.active()) return;
    this.time += dt;
    this.updateListener(camera, focus);
    this.nightness = nightnessAt(this.sim.minuteOfDay / 60);
    this.envT -= dt;
    if (this.envT <= 0) {
      this.envT = 0.25;
      this.sampleEnvironment(0.25);
      this.updateBeds(0.25);
    }
    this.animT -= dt;
    if (this.animT <= 0) {
      this.animT = 0.1;
      if (!this.ownsAnimals) this.scanAnimals();
    }
    this.voiceT -= dt;
    if (this.voiceT <= 0) {
      this.voiceT = 0.1;
      this.steerVoices();
    }
    this.updateLoops(dt);
    this.ambientOneShots(dt);
    for (const e of this.modules) {
      if (e.failed) continue;
      try {
        e.m.update(dt);
      } catch (err) {
        this.moduleFailed(e, err);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    for (const e of this.modules) {
      try {
        e.m.dispose();
      } catch (err) {
        console.warn(`[audio] module ${e.name} dispose failed:`, err);
      }
    }
    this.removeUnlock();
    for (const t of [this.offTimer, this.warmTimer, this.suspendTimer, this.releaseTimer]) if (t !== null) clearTimeout(t);
    if (this.ctx) {
      this.stopAll();
      if (!this.injected) (this.ctx as AudioContext).close().catch(noop);
    }
    this.ctx = null;
    this.sounds.clear();
    this.queue.length = 0;
    this.urgentIds.clear();
    this.pending.clear();
  }

  // ================================================================ harness / debug

  /** Request sounds and resolve once the render queue is empty. */
  prefetch(ids: readonly string[] = []): Promise<void> {
    for (const id of ids) this.request(id);
    void this.pump();
    if (!this.working && !this.queue.length) return Promise.resolve();
    return new Promise((res) => this.idleWaiters.push(res));
  }

  /** Debug: fixed main-thread slice budget for background rendering (0 = idle-driven). */
  debugBudget(ms: number): void {
    setRenderBudget(ms);
  }

  /** Debug / probes: force a sound for an animal (first module that handles it; else the built-in call). */
  debugForce(animalId: number, kind: string): boolean {
    for (const e of this.modules) {
      if (e.failed || !e.m.force) continue;
      try {
        if (e.m.force(animalId, kind)) return true;
      } catch (err) {
        this.moduleFailed(e, err);
      }
    }
    if (this.ownsAnimals || !this.active()) return false;
    const a = this.sim.animals.get(animalId);
    if (!a) return false;
    const isCall = kind !== 'idle';
    (isCall ? this.lastCall : this.lastIdle).delete(a.speciesId);
    return this.tryVoice(a, isCall);
  }

  /** Snapshot of the mixer state (for debugging / automated checks). */
  debugState(): Record<string, unknown> {
    const beds: Record<string, number> = {};
    const bias: Record<string, number> = {};
    for (const [id, b] of this.beds) {
      beds[id] = b.playing ? Math.round(b.level * 1000) / 1000 : -1;
      if (b.bias) bias[id] = Math.round(b.bias * 100) / 100;
    }
    const loops: Record<string, number> = {};
    for (const [k, e] of this.loops) loops[k] = e.bed.playing ? Math.round(e.level * 1000) / 1000 : -1;
    const pools = { voice: 0, foley: 0, fx: 0, amb: 0, ui: 0 } as Record<Pool, number>;
    if (this.ctx) for (const p of ['voice', 'foley', 'fx', 'amb', 'ui'] as const) pools[p] = this.playing(p);
    const modules: Record<string, Record<string, unknown>> = {};
    for (const e of this.modules) {
      try {
        modules[e.name] = { ...(e.m.debug?.() ?? {}), ...(e.failed ? { failed: true } : {}) };
      } catch {
        modules[e.name] = { failed: true };
      }
    }
    const r2 = (v: number) => +v.toFixed(2);
    return {
      state: this.injected ? 'offline' : ((this.ctx as AudioContext | null)?.state ?? 'none'),
      enabled: this._enabled,
      suspended: this.appSuspended,
      rendered: this.sounds.size,
      pending: this.queue.length + (this.working ? 1 : 0),
      failed: [...this.failed],
      beds,
      bias,
      voices: pools.voice,
      pools,
      loops,
      volumes: { ...this.volumes },
      biome: { savanna: r2(this.biome.savanna), arctic: r2(this.biome.arctic), humid: r2(this.biome.humid) },
      followId: this.followId,
      modules,
      env: {
        crowdNear: r2(this.crowdNear),
        crowdFar: r2(this.crowdFar),
        water: r2(this.waterNear),
        fountain: r2(this.fountainNear),
        night: r2(this.nightness),
        zoomNear: r2(this.ear.zoomNear),
        near: this.nearCount,
      },
    };
  }

  private moduleFailed(e: ModuleEntry, err: unknown): void {
    if (e.failed) return;
    e.failed = true;
    console.warn(`[audio] module ${e.name} stopped:`, err);
  }

  // ================================================================ context

  private createContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const AC = w.AudioContext ?? w.webkitAudioContext;
    if (!AC || !offlineCtor()) {
      this.disposed = true; // no Web Audio: stay silent forever
      this.removeUnlock();
      return null;
    }
    try {
      return new AC({ latencyHint: 'interactive' });
    } catch {
      try {
        return new AC();
      } catch (err) {
        console.warn('[audio] AudioContext unavailable', err);
        this.disposed = true;
        this.removeUnlock();
        return null;
      }
    }
  }

  private boot(c: BaseAudioContext): void {
    this.ctx = c;
    // master at its level from the start (the first cue must not be swallowed
    // by a fade-in); the beds fade in on their own
    this.master = c.createGain();
    this.master.gain.value = this._enabled && !this.appSuspended ? MASTER : 0;
    this.masterVol = c.createGain();
    this.masterVol.gain.value = this.volumes.master ** 2;
    const glue = c.createDynamicsCompressor();
    glue.threshold.value = -18;
    glue.knee.value = 8;
    glue.ratio.value = 2.5;
    glue.attack.value = 0.015;
    glue.release.value = 0.3;
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    const clip = c.createWaveShaper();
    clip.curve = softClipCurve();
    this.masterVol.connect(this.master);
    this.master.connect(glue);
    glue.connect(limiter);
    limiter.connect(clip);
    clip.connect(c.destination);
    // compressors start out fully compressed and recover at their release rate:
    // release fast for the first moments so a cue right after the unlock is not swallowed
    for (const comp of [glue, limiter]) {
      const rel = comp.release.value;
      comp.release.setValueAtTime(0.001, c.currentTime);
      comp.release.setValueAtTime(rel, c.currentTime + 0.05);
    }
    // pause "time freeze": one low-pass + gain shared by world and ambience
    this.worldFilter = c.createBiquadFilter();
    this.worldFilter.type = 'lowpass';
    this.worldFilter.frequency.value = Math.min(20000, c.sampleRate * 0.49);
    this.worldFilter.Q.value = 0.5;
    this.worldGain = c.createGain();
    this.worldFilter.connect(this.worldGain);
    this.worldGain.connect(this.masterVol);
    const chan = {} as Record<Channel, ChannelNodes>;
    for (const ch of CHANNELS) {
      const input = c.createGain();
      input.gain.value = CHANNEL_LEVEL[ch];
      const vol = c.createGain();
      vol.gain.value = this.volumes[ch] ** 2;
      const duck = c.createGain();
      input.connect(vol);
      vol.connect(duck);
      duck.connect(ch === 'world' || ch === 'ambience' ? this.worldFilter : this.masterVol);
      chan[ch] = { input, vol, duck, duckDb: 0, duckUntil: 0 };
    }
    this.chan = chan;
    this.ambBus = chan.ambience.duck;
    this.sfxBus = chan.world.duck;
    this.uiBus = chan.ui.duck;
    // one shared outdoor reverb, returned into the world channel
    const conv = c.createConvolver();
    conv.normalize = false;
    // built by the render queue right after the UI cues, in idle slices (never inside the unlocking gesture)
    this.reverbBuild = async () => {
      const ir = await outdoorImpulse(c, this.lowSpec ? 0.8 : 1.2, this.lowSpec ? 1 : 2);
      if (!this.disposed) conv.buffer = ir;
    };
    this.reverbIn = c.createGain();
    this.reverbIn.gain.value = REVERB_RETURN;
    this.reverbIn.connect(conv);
    conv.connect(chan.world.input);
    for (const id of BED_IDS) this.beds.set(id, new Bed(c, chan.ambience.input, !this.lowSpec || LOWSPEC_STEREO.has(id)));
    const tier = this.lowSpec ? 1 : 0;
    for (const p of ['voice', 'foley', 'fx', 'amb'] as const) {
      const dest = chan[POOL_CHANNEL[p]].input;
      const rev = POOL_CHANNEL[p] === 'world' ? this.reverbIn : null;
      for (let i = 0; i < POOL_SIZES[p][tier]; i++) this.pools[p].push(new Voice(c, dest, rev));
    }
    if (!this.injected) {
      // Android can stop the context on its own (calls, other apps): retry
      (c as AudioContext).onstatechange = () => {
        const st = (c as AudioContext).state as string;
        if ((st === 'suspended' || st === 'interrupted') && this._enabled && !this.appSuspended && !this.disposed) {
          this.needsResume = true;
          this.installUnlock();
        }
      };
    }
    this.queueWarm();
  }

  private resumeContext(): void {
    if (!this.ctx || this.injected) return;
    const c = this.ctx as AudioContext;
    if (c.state === 'suspended' || (c.state as string) === 'interrupted') c.resume().catch(noop);
  }

  /** After an unexpected suspend: try resume about once a second from update(). */
  private retryResume(dt: number): void {
    const c = this.ctx as AudioContext | null;
    if (!c || this.injected || c.state === 'running' || !this._enabled || this.appSuspended || this.disposed) {
      // running again, or setEnabled / resume() own the restart now
      this.needsResume = false;
      return;
    }
    this.resumeRetryT -= dt;
    if (this.resumeRetryT > 0) return;
    this.resumeRetryT = 1;
    this.resumeContext();
  }

  private active(): boolean {
    if (!this.ctx || !this._enabled || this.appSuspended || this.disposed) return false;
    return this.injected !== null || (this.ctx as AudioContext).state === 'running';
  }

  private installUnlock(): void {
    if (this.unlockBound || typeof window === 'undefined') return;
    // Android: touch `pointerdown` is not a user activation; the first
    // touchend / click is. Unlock on whichever comes first.
    const fn = () => {
      if (!this._enabled) return;
      this.resume();
      const c = this.ctx as AudioContext | null;
      if (c && c.state === 'running') {
        this.needsResume = false;
        this.removeUnlock();
      }
    };
    this.unlockBound = fn;
    for (const ev of ['touchend', 'pointerup', 'click', 'keydown']) window.addEventListener(ev, fn, { capture: true, passive: true });
  }

  private removeUnlock(): void {
    if (!this.unlockBound || typeof window === 'undefined') return;
    for (const ev of ['touchend', 'pointerup', 'click', 'keydown']) window.removeEventListener(ev, this.unlockBound, { capture: true });
    this.unlockBound = null;
  }

  private stopVoices(): void {
    for (const pool of Object.values(this.pools)) for (const v of pool) v.stop();
  }

  private stopAll(): void {
    this.stopVoices();
    for (const b of this.beds.values()) if (b.playing) b.stop();
    for (const e of this.loops.values()) e.bed.dispose();
    this.loops.clear();
  }

  /** Volume 0: stop what plays on that channel (beds restart on their own when it comes back). */
  private stopChannel(ch: AudioChannel): void {
    if (ch === 'master') return this.stopAll();
    for (const p of ['voice', 'foley', 'fx', 'amb'] as const) if (POOL_CHANNEL[p] === ch) for (const v of this.pools[p]) v.stop();
    if (ch === 'ambience') for (const b of this.beds.values()) if (b.playing) b.stop();
    for (const [k, e] of this.loops)
      if (e.ch === ch) {
        e.bed.dispose();
        this.loops.delete(k);
      }
  }

  private channelOn(ch: Channel): boolean {
    return this.volumes[ch] > 0 && this.volumes.master > 0;
  }

  // ================================================================ render queue

  private request(id: string, urgent = false): void {
    if (this.sounds.has(id) || this.failed.has(id) || !RECIPES[id]) return;
    if (this.pending.has(id)) {
      // already urgent: keep its place (audible beds are re-requested every frame and must
      // not keep overtaking each other — the current-hour bed was starved by later ones)
      if (urgent && !this.urgentIds.has(id)) {
        const i = this.queue.indexOf(id);
        if (i >= 0) {
          this.queue.splice(i, 1);
          this.queue.splice(this.urgentSlot(), 0, id);
          this.urgentIds.add(id);
        }
      }
      return;
    }
    this.pending.add(id);
    if (urgent) {
      this.queue.splice(this.urgentSlot(), 0, id);
      this.urgentIds.add(id);
    } else this.queue.push(id);
    void this.pump();
  }

  /**
   * Urgent renders go after any queued UI cues (cues stay first: they are tiny and wanted at the
   * first tap) and after the urgent renders already queued (first requested, first rendered).
   */
  private urgentSlot(): number {
    let i = 0;
    while (i < this.queue.length && (this.queue[i].startsWith('cue.') || this.urgentIds.has(this.queue[i]))) i++;
    return i;
  }

  private async pump(): Promise<void> {
    if (this.working) return;
    this.working = true;
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    try {
      while (this.queue.length && !this.disposed && this._enabled && !this.appSuspended) {
        if (this.reverbBuild && !this.queue[0].startsWith('cue.')) {
          await this.buildReverb();
          // re-check: dispose (which empties the queue), the sound switch or an app pause may have come meanwhile
          continue;
        }
        const id = this.queue.shift()!;
        this.urgentIds.delete(id);
        try {
          const lowRate = this.lowSpec && !id.startsWith('cue.');
          const a = await renderRecipe(RECIPES[id], seedFor(id), lowRate ? { maxRate: LOWSPEC_RATE } : undefined);
          if (this.disposed) return;
          this.sounds.set(id, a);
        } catch (err) {
          this.failed.add(id);
          if (!this.warned) {
            this.warned = true;
            console.warn('[audio] could not render', id, err);
          }
        }
        this.pending.delete(id);
        // give the main thread a breather between renders
        await yieldMain();
      }
      if (this.reverbBuild && !this.disposed && this._enabled && !this.appSuspended) await this.buildReverb();
    } finally {
      this.working = false;
      if (!this.queue.length) {
        const w = this.idleWaiters;
        this.idleWaiters = [];
        for (const f of w) f();
        // nothing left to render for a while: free the render-only caches
        if (!this.disposed)
          this.releaseTimer = setTimeout(() => {
            this.releaseTimer = null;
            if (!this.working && !this.queue.length) releaseRenderCaches();
          }, 5000);
      }
    }
  }

  private async buildReverb(): Promise<void> {
    const build = this.reverbBuild!;
    this.reverbBuild = null;
    await build();
  }

  private speciesInfo(speciesId: string): SpeciesInfo {
    let s = this.spInfo.get(speciesId);
    if (!s) {
      const vid = voiceIdFor(speciesId, SPECIES_BY_ID[speciesId]?.diet);
      s = { callId: `call.${vid}`, idleId: `idle.${vid}`, voice: SPECIES_VOICE[vid] };
      this.spInfo.set(speciesId, s);
    }
    return s;
  }

  private requestSpecies(speciesId: string): void {
    const s = this.speciesInfo(speciesId);
    this.request(s.callId);
    this.request(s.idleId);
  }

  private requestAllSpecies(): void {
    const seen = new Set<string>();
    this.sim.animals.forEach((a) => {
      if (seen.has(a.speciesId)) return;
      seen.add(a.speciesId);
      this.requestSpecies(a.speciesId);
    });
  }

  // ================================================================ host: play / loop / duck

  private playSpec(spec: PlaySpec): VoiceHandle | null {
    if (!this.active()) return null;
    const pool = spec.pool ?? 'voice';
    const ch = POOL_CHANNEL[pool];
    if (!this.channelOn(ch)) return null;
    const asset = this.sounds.get(spec.id);
    if (!asset) {
      this.request(spec.id, pool === 'ui');
      return null;
    }
    const c = this.ctx!;
    const now = c.currentTime;
    const when = Math.max(now, spec.when ?? now);
    const level = spec.gain ?? 1;
    const rate = spec.rate ?? 1;
    if (pool === 'ui') return this.playUi(asset.buffer, spec.id, level, rate, when);

    let px = 0,
      py = 0,
      pz = 0,
      positional = false;
    const track = spec.track ?? -1;
    const an = track >= 0 ? this.sim.animals.get(track) : undefined;
    // a tracked animal that is gone must not play as a centred, full-level sound
    if (track >= 0 && !an && !spec.at) return null;
    if (an) {
      px = an.x;
      py = an.y + 1;
      pz = an.z;
      positional = true;
    } else if (spec.at) {
      px = spec.at.x;
      py = spec.at.y;
      pz = spec.at.z;
      positional = true;
    }
    const refDist = spec.refDist ?? DEFAULT_REF_DIST;
    const radius = spec.radius ?? DEFAULT_RADIUS;
    const att = positional ? this.attenuate(px, py, pz, refDist, radius) : this.centred();
    const final = level * att.gain;
    if (final < 0.01) return null;
    const pv = this.pools[pool];
    let v: Voice | null = null;
    let layer: Layer;
    if (spec.group !== undefined) v = pv.find((x) => x.group === spec.group && x.busy(now)) ?? null;
    if (v) layer = v.layer(asset.buffer, rate, level, when);
    else {
      v = this.allocVoice(pv, spec.prio ?? final);
      if (!v) return null;
      v.prio = spec.prio ?? final;
      v.track = an ? track : -1;
      v.fixed = !an && positional;
      v.px = px;
      v.py = py;
      v.pz = pz;
      v.refDist = refDist;
      v.radius = radius;
      v.group = spec.group ?? -1;
      layer = v.start(asset.buffer, rate, level, when, att, spec.color);
    }
    if (spec.duck ?? (pool === 'voice' && final > 0.3)) this.duck('ambience', -3, layer.endAt - now);
    this.log(spec.id, pool, final, rate, positional ? att.dist : 0, track, px, pz, spec.group ?? -1, when);
    const voice = v;
    return {
      get endAt() {
        return layer.endAt;
      },
      stop: (fade = 0.05) => {
        if (!this.ctx || layer.stopped) return;
        voice.fadeLayer(layer, this.ctx.currentTime, fade);
      },
    };
  }

  /** Non-positional UI cue: one unpooled source into the ui channel. */
  private playUi(buf: AudioBuffer, id: string, level: number, rate: number, when: number): VoiceHandle | null {
    const c = this.ctx!;
    const s = c.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = level;
    s.connect(g);
    g.connect(this.chan.ui.input);
    s.start(when);
    this.uiLive++;
    const end = { at: when + buf.duration / rate, stopped: false };
    s.onended = () => {
      this.uiLive--;
      s.disconnect();
      g.disconnect();
    };
    this.log(id, 'ui', level, rate, 0, -1, 0, 0, -1, when);
    return {
      get endAt() {
        return end.at;
      },
      stop: (fade = 0.05) => {
        if (!this.ctx || end.stopped) return;
        end.stopped = true;
        const now = this.ctx.currentTime;
        fadeOut(g.gain, now, fade);
        safeStop(s, now + fade + 0.005);
        end.at = Math.min(end.at, now + fade + 0.005);
      },
    };
  }

  private log(id: string, pool: Pool, gain: number, rate: number, dist: number, track: number, x: number, z: number, group: number, t: number): void {
    if (!this.debugLog) return;
    const r = (v: number, k = 1000) => Math.round(v * k) / k;
    this.debugLog.push({ t: r(t), id, pool, gain: r(gain), rate: r(rate), dist: r(dist, 10), track, x: r(x, 10), z: r(z, 10), group });
  }

  private playing(pool: Pool): number {
    if (!this.ctx) return 0;
    if (pool === 'ui') return this.uiLive;
    const now = this.ctx.currentTime;
    let n = 0;
    for (const v of this.pools[pool]) if (v.busy(now)) n++;
    return n;
  }

  private loop(key: string, id: string, level: number, side = 0, ch: Channel = 'ambience'): void {
    if (!this.active()) return;
    level = Number.isFinite(level) ? Math.max(0, level) : 0;
    let e = this.loops.get(key);
    if (!e) {
      if (level <= 0.004 || !this.channelOn(ch) || !RECIPES[id]) return;
      const max = MAX_LOOPS[this.lowSpec ? 1 : 0];
      if (this.loops.size >= max) {
        // full: the quietest loop (possibly this new one) loses
        let qk = '';
        let ql = Infinity;
        for (const [k, o] of this.loops)
          if (o.level < ql) {
            ql = o.level;
            qk = k;
          }
        if (ql >= level) return;
        this.loops.get(qk)!.bed.dispose();
        this.loops.delete(qk);
      }
      e = { bed: new Bed(this.ctx!, this.chan[ch].input, true), id, ch, level: 0, side: 0, quiet: 0 };
      this.loops.set(key, e);
    }
    if (e.id !== id) {
      e.bed.stop();
      e.bed.asset = null;
      e.id = id;
    }
    e.level = level;
    e.side = side;
    if (level > 0.004) e.quiet = 0;
    if (!e.bed.asset) {
      const a = this.sounds.get(id);
      if (a) e.bed.asset = a;
      else this.request(id, true);
    }
    if (e.bed.asset && !e.bed.playing && level > 0.004) e.bed.start(this.rng);
    if (e.bed.playing) {
      e.bed.setLevel(level, 0.9);
      e.bed.setBias(side);
    }
  }

  /** Quiet loops stop after 4 s. */
  private updateLoops(dt: number): void {
    for (const [k, e] of this.loops) {
      if (e.level > 0.004) continue;
      e.quiet += dt;
      if (e.quiet > 4) {
        e.bed.dispose();
        this.loops.delete(k);
      }
    }
  }

  private duck(ch: Channel, db: number, holdS: number): void {
    if (!this.active()) return;
    const c = this.chan[ch];
    const now = this.ctx!.currentTime;
    const activeDb = now < c.duckUntil ? c.duckDb : 0;
    const depth = Math.min(db, activeDb);
    const until = Math.max(now + 0.08 + Math.max(0, holdS), now < c.duckUntil ? c.duckUntil : 0);
    if (depth === activeDb && until <= c.duckUntil) return;
    c.duckDb = depth;
    c.duckUntil = until;
    const g = c.duck.gain;
    hold(g, now);
    g.setTargetAtTime(Math.pow(10, depth / 20), now, 0.027); // ≈ 80 ms attack
    g.setTargetAtTime(1, until, 0.4); // ≈ 1.2 s release
  }

  private setWorldFilter(cutHz: number, gainDb: number, tc: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const t = Math.max(0.001, tc);
    this.worldFilter.frequency.setTargetAtTime(Math.min(cutHz, this.ctx.sampleRate * 0.49), now, t);
    this.worldGain.gain.setTargetAtTime(Math.pow(10, gainDb / 20), now, t);
  }

  // ================================================================ listener & environment

  private updateListener(camera: THREE.Camera, focus: THREE.Vector3): void {
    const p = camera.position;
    const q = camera.quaternion;
    const e = this.ear;
    e.fx = focus.x;
    e.fz = focus.z;
    const dx = p.x - focus.x,
      dy = p.y - focus.y,
      dz = p.z - focus.z;
    e.camDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    e.zoomNear = 1 - smoothstep(18, 120, e.camDist);
    // the ear sits a third of the way from the focus point towards the camera
    e.x = focus.x + dx * 0.35;
    e.y = focus.y + dy * 0.35;
    e.z = focus.z + dz * 0.35;
    // camera right (+X) and forward (−Z) axes from its quaternion
    const x = q.x,
      y = q.y,
      z = q.z,
      w = q.w;
    this.rx = 1 - 2 * (y * y + z * z);
    this.ry = 2 * (x * y + w * z);
    this.rz = 2 * (x * z - w * y);
    this.fwx = -2 * (x * z + w * y);
    this.fwy = -2 * (y * z - w * x);
    this.fwz = -(1 - 2 * (x * x + y * y));
  }

  /** Probe name: camera distance to the focus. */
  private get camDist(): number {
    return this.ear.camDist;
  }

  /** Distance model for a world point (shared scratch result). */
  private attenuate(x: number, y: number, z: number, refDist = DEFAULT_REF_DIST, radius = DEFAULT_RADIUS): Readonly<Attenuation> {
    const e = this.ear;
    const dx = x - e.x,
      dy = y - e.y,
      dz = z - e.z;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-3;
    const side = (dx * this.rx + dy * this.ry + dz * this.rz) / r;
    const front = (dx * this.fwx + dy * this.fwy + dz * this.fwz) / r;
    return distanceModel(r, side, front, refDist, radius, this.att);
  }

  /** Attenuation of a non-positional world sound: full level, centred, dry. */
  private centred(): Readonly<Attenuation> {
    const a = this.att;
    a.gain = 1;
    a.pan = 0;
    a.cut = 18000;
    a.shelfDb = 0;
    a.wet = 0.05;
    a.dist = 0;
    return a;
  }

  private readonly scanGuest = (g: GuestState): void => {
    if (g.hidden) return;
    const e = this.ear;
    // density around the ear's ground point: a guest at 10 m counts 0.5, at 30 m 0.002
    const dx = g.x - e.x,
      dz = g.z - e.z;
    const w = Math.exp(-(dx * dx + dz * dz) / 144);
    this.gNear += w;
    if (w > 1e-3) this.gSide += w * this.side(g.x, g.z);
    const fx = g.x - e.fx,
      fz = g.z - e.fz;
    const vis = Math.max(40, e.camDist * 1.3);
    if (fx * fx + fz * fz < vis * vis) this.gVisible++;
  };

  /** Left / right position (-1..1) of a ground point as heard from the listener. */
  private side(x: number, z: number): number {
    const e = this.ear;
    const dx = x - e.x,
      dy = -e.y,
      dz = z - e.z;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-3;
    return (dx * this.rx + dy * this.ry + dz * this.rz) / r;
  }

  private refreshHabitatBiomes(): void {
    this.habitatsDirty = false;
    this.habitatBiome.clear();
    this.sim.animals.forEach((a) => {
      if (a.habitatId === null) return;
      const b = SPECIES_BY_ID[a.speciesId]?.biome;
      const f = b === 'desert' ? 1 : b === 'tropical' || b === 'wetland' ? 2 : 0;
      if (f) this.habitatBiome.set(a.habitatId, (this.habitatBiome.get(a.habitatId) ?? 0) | f);
    });
  }

  private refreshObjects(): void {
    this.objectsDirty = false;
    this.fountains.length = 0;
    this.trees.length = 0;
    const world = this.sim.world;
    world.objects.forEach((o) => {
      const isFountain = o.defId === 'fountain';
      let isTree = false;
      if (!isFountain) {
        try {
          isTree = getObjectDef(o.defId).category === 'tree';
        } catch {
          return;
        }
      }
      if (!isFountain && !isTree) return;
      const c = world.objectCenter(o);
      (isFountain ? this.fountains : this.trees).push(c.x, c.z);
    });
  }

  private sampleEnvironment(dt: number): void {
    const e = this.ear;
    this.gNear = 0;
    this.gSide = 0;
    this.gVisible = 0;
    this.sim.guests.forEach(this.scanGuest);
    this.crowdNear = crowdNearLevel(this.gNear);
    this.crowdFar = crowdFarLevel(this.gVisible);
    // water and biome tiles around the focus
    if (this.habitatsDirty) this.refreshHabitatBiomes();
    const world = this.sim.world;
    const R = 7;
    const tx0 = Math.floor(e.fx / TILE),
      tz0 = Math.floor(e.fz / TILE);
    let w = 0,
      ws = 0,
      sav = 0,
      savS = 0,
      arc = 0,
      arcS = 0,
      rock = 0,
      rockS = 0,
      hum = 0,
      humS = 0;
    for (let dz = -R; dz <= R; dz++) {
      const z = tz0 + dz;
      if (z < 0 || z >= MAP_H) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = tx0 + dx;
        if (x < 0 || x >= MAP_W) continue;
        const d = Math.sqrt(dx * dx + dz * dz) / R;
        if (d >= 1) continue;
        const k = (1 - d) * (1 - d);
        const i = z * MAP_W + x;
        const t = world.terrain[i];
        const hb = world.habitatOf[i] ? (this.habitatBiome.get(world.habitatOf[i]) ?? 0) : 0;
        if (t === Terrain.Water || t === Terrain.DeepWater) {
          w += k;
          ws += k * this.side((x + 0.5) * TILE, (z + 0.5) * TILE);
        }
        if (t === Terrain.DryGrass || t === Terrain.Sand || hb & 1) {
          sav += k;
          savS += k * this.side((x + 0.5) * TILE, (z + 0.5) * TILE);
        }
        if (t === Terrain.Snow) {
          arc += k;
          arcS += k * this.side((x + 0.5) * TILE, (z + 0.5) * TILE);
        } else if (t === Terrain.Rock) {
          rock += k;
          rockS += k * this.side((x + 0.5) * TILE, (z + 0.5) * TILE);
        }
        if (t === Terrain.Mud || hb & 2) {
          hum += k;
          humS += k * this.side((x + 0.5) * TILE, (z + 0.5) * TILE);
        }
      }
    }
    this.waterNear = 1 - Math.exp(-w / 5);
    this.waterSide = w > 0 ? ws / w : 0;
    // rock counts as arctic scree only next to snow
    if (arc > 0) {
      arc += rock * 0.3;
      arcS += rockS * 0.3;
    }
    const k = 1 - Math.exp(-dt / 2);
    const b = this.biome,
      bs = this.biomeSide;
    b.savanna += (biomeWeight(sav) - b.savanna) * k;
    b.arctic += (biomeWeight(arc) - b.arctic) * k;
    b.humid += (biomeWeight(hum) - b.humid) * k;
    bs.savanna = sav > 0 ? savS / sav : 0;
    bs.arctic = arc > 0 ? arcS / arc : 0;
    bs.humid = hum > 0 ? humS / hum : 0;
    // fountains
    if (this.objectsDirty) this.refreshObjects();
    let best = 1e12;
    let bi = -1;
    for (let i = 0; i < this.fountains.length; i += 2) {
      const dx = this.fountains[i] - e.fx,
        dz = this.fountains[i + 1] - e.fz;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        bi = i;
      }
    }
    this.fountainSide = bi >= 0 ? this.side(this.fountains[bi], this.fountains[bi + 1]) : 0;
    const f = Math.max(0, 1 - Math.sqrt(best) / 28);
    this.fountainNear = f * f;
  }

  private updateBeds(dt: number): void {
    const h = this.sim.minuteOfDay / 60;
    const zn = this.ear.zoomNear;
    const night = this.nightness;
    this.birdsDay = smoothstep(4.9, 5.9, h) * (1 - smoothstep(19.8, 20.9, h));
    const chorus = Math.max(Math.exp(-(((h - 6.4) / 1.1) ** 2)), 0.8 * Math.exp(-(((h - 19.0) / 0.8) ** 2)));
    this.openness += ((this.sim.isOpen() ? 1 : 0.55) - this.openness) * Math.min(1, dt * 0.5);
    const bio = this.biome;
    const L = BED_LEVELS;
    L.birds = this.birdsDay * (0.55 + 0.45 * chorus) * (0.4 + 0.6 * zn) * (1 - 0.8 * bio.arctic);
    L.night = night * (0.7 + 0.3 * zn) * 0.7 * (1 - 0.8 * bio.arctic);
    L.wind = 0.62 * (1 + 0.41 * (1 - zn)) * windByHour(h) * (1 - 0.25 * night);
    // close: the guests around the ear; overview: the whole visible crowd, muffled
    L.crowd = this.openness * (zn * this.crowdNear + (1 - zn) * 0.55 * this.crowdFar);
    L.water = this.waterNear * (0.3 + 0.7 * zn);
    L.fountain = this.fountainNear * (0.25 + 0.75 * zn);
    for (const bm of ['savanna', 'humid'] as const) {
      const nightId = `${bm}.night` as const;
      if (RECIPES[`bed.${nightId}`]) {
        L[bm] = bio[bm] * (1 - night) * (0.5 + 0.5 * zn) * 0.45;
        L[nightId] = bio[bm] * night * (0.6 + 0.4 * zn) * 0.4;
      } else {
        L[bm] = bio[bm] * (1 - 0.7 * night) * (0.5 + 0.5 * zn) * 0.45;
        L[nightId] = 0;
      }
    }
    L.arctic = bio.arctic * (0.5 + 0.5 * zn) * 0.45;
    // the ear rises with the camera: every bed recedes a little from above (−2.5 dB at overview)
    const alt = 0.75 + 0.25 * zn;
    // the loudest beds win when more would play than the tier allows
    const cap = MAX_BEDS[this.lowSpec ? 1 : 0];
    const ambOn = this.channelOn('ambience');
    let sum = 0;
    for (const id of BED_IDS) {
      const tgt = ambOn && RECIPES[`bed.${id}`] ? L[id] * BED_MIX[id] * alt : 0;
      L[id] = tgt;
      sum += tgt;
    }
    for (const id of BED_IDS) {
      const bed = this.beds.get(id)!;
      let tgt = L[id];
      if (tgt > 0.004) {
        let louder = 0;
        for (const o of BED_IDS) if (L[o] > tgt || (L[o] === tgt && o < id)) louder++;
        if (louder >= cap) tgt = 0;
      }
      if (tgt > 0.004) {
        if (!bed.asset) {
          const a = this.sounds.get(`bed.${id}`);
          if (a) bed.asset = a;
          else this.request(`bed.${id}`, true);
        }
        const bId = `bed.${id}.b`;
        const wantB = !!RECIPES[bId] && !this.failed.has(bId);
        if (wantB && !bed.assetB) {
          const a = this.sounds.get(bId);
          if (a) bed.assetB = a;
          else this.request(bId, true);
        }
        if (bed.asset && !bed.playing && (bed.assetB || !wantB)) bed.start(this.rng);
        bed.quiet = 0;
      } else if (bed.playing) {
        bed.quiet += dt;
        // over the cap: make room now; otherwise let it fade for 4 s first
        if (bed.quiet > 4 || L[id] > 0.004) bed.stop();
      }
      if (bed.playing) bed.setLevel(tgt, 0.9);
    }
    // camera height: the crowd and the leaves are muffled from above (the wind keeps its body)
    this.beds.get('crowd')!.setCut(1200 + 4800 * zn);
    this.beds.get('wind')!.setCut(3000 + 15000 * zn);
    for (const id of BED_IDS) if (id !== 'crowd' && id !== 'wind') this.beds.get(id)!.setCut(18000);
    // localised beds lean towards their source
    const crowdSide = this.gNear > 0.05 ? this.gSide / this.gNear : 0;
    this.beds.get('crowd')!.setBias(0.35 * crowdSide * zn);
    this.beds.get('water')!.setBias(0.4 * this.waterSide * zn);
    this.beds.get('fountain')!.setBias(0.5 * this.fountainSide * zn);
    for (const bm of ['savanna', 'arctic', 'humid'] as const) {
      const bias = 0.3 * this.biomeSide[bm] * zn;
      this.beds.get(bm)!.setBias(bias);
      if (bm !== 'arctic') this.beds.get(`${bm}.night`)!.setBias(bias);
    }
    // UI cues sit relative to the ambience: about −3 dB in a quiet night overview
    const uiScale = 0.62 + 0.38 * Math.min(1, sum / DAY_CLOSE_REF);
    if (Math.abs(uiScale - this.uiScale) > 0.01) {
      this.uiScale = uiScale;
      this.chan.ui.input.gain.setTargetAtTime(CHANNEL_LEVEL.ui * uiScale, this.ctx!.currentTime, 1.5);
    }
  }

  // ================================================================ animals (built-in; off when a module owns them)

  private readonly scanAnimal = (a: AnimalState): void => {
    const e = this.ear;
    if (a.action === 'call') {
      if (!this.calling.has(a.id)) {
        this.calling.add(a.id);
        if (a.actionTime < 1.5) {
          const dx = a.x - e.x,
            dy = a.y - e.y,
            dz = a.z - e.z;
          if (dx * dx + dy * dy + dz * dz < CALL_RADIUS * CALL_RADIUS) this.tryVoice(a, true);
        }
      }
    } else if (this.calling.size !== 0) this.calling.delete(a.id);
    if (a.action !== 'sleep' && this.nearCount < this.near.length) {
      const dx = a.x - e.fx,
        dz = a.z - e.fz;
      if (dx * dx + dz * dz < 2500) this.near[this.nearCount++] = a.id;
    }
  };

  private scanAnimals(): void {
    this.nearCount = 0;
    this.sim.animals.forEach(this.scanAnimal);
    // occasional idle vocalisations from awake animals near the focus
    if (this.sim.speed > 0 && this.nearCount > 0) {
      const rate = Math.min(0.16, 0.022 * this.nearCount); // per second
      if (this.rng.float() < rate * 0.1) {
        const a = this.sim.animals.get(this.near[this.rng.int(0, this.nearCount - 1)]);
        if (a && a.action !== 'call' && this.rng.float() < this.speciesInfo(a.speciesId).voice.chatty) this.tryVoice(a, false);
      }
    }
  }

  private tryVoice(a: AnimalState, isCall: boolean): boolean {
    const info = this.speciesInfo(a.speciesId);
    const id = isCall ? info.callId : info.idleId;
    if (!this.sounds.has(id)) {
      this.request(id, true);
      return false;
    }
    const lastMap = isCall ? this.lastCall : this.lastIdle;
    const last = lastMap.get(a.speciesId) ?? -1e9;
    if (this.time - last < (isCall ? 2.5 : 9)) return false;
    const young = a.growth < 0.95;
    const level = (isCall ? info.voice.call : info.voice.idle) * (young ? 0.7 : 1);
    let rate = 1 + this.rng.range(-0.05, 0.05);
    if (young) rate *= 1 + (1 - a.growth) * 0.6;
    if (a.sex === 'F') rate *= 1.06;
    if (!this.playSpec({ id, track: a.id, pool: 'voice', gain: level, rate })) return false;
    lastMap.set(a.speciesId, this.time);
    return true;
  }

  private allocVoice(pool: Voice[], prio: number): Voice | null {
    const now = this.ctx!.currentTime;
    let worst: Voice | null = null;
    let worstP = Infinity;
    for (const v of pool) {
      if (!v.busy(now)) return v;
      // prefer stealing quiet voices that are nearly finished
      const left = Math.max(0, (v.endAt - now) / Math.max(0.1, v.endAt - v.startAt));
      const p = v.prio * (0.3 + 0.7 * left);
      if (p < worstP) {
        worstP = p;
        worst = v;
      }
    }
    return worst && prio > worstP * 1.25 ? worst : null;
  }

  private steerVoices(): void {
    const now = this.ctx!.currentTime;
    for (const pool of Object.values(this.pools))
      for (const v of pool) {
        if (!v.busy(now)) continue;
        if (v.track >= 0) {
          const a = this.sim.animals.get(v.track);
          if (!a) continue;
          v.px = a.x;
          v.py = a.y + 1;
          v.pz = a.z;
        } else if (!v.fixed) continue;
        v.steer(this.attenuate(v.px, v.py, v.pz, v.refDist, v.radius));
      }
  }

  // ================================================================ ambient one-shots & coins

  private ambientOneShots(dt: number): void {
    this.owlT -= dt;
    if (this.owlT <= 0) {
      this.owlT = this.rng.range(20, 40);
      if (this.nightness > 0.6) this.owlBout();
      else this.owl = this.owlMate = null;
    }
    this.birdT -= dt;
    if (this.birdT <= 0) {
      this.birdT = this.rng.range(7, 20);
      if (this.birdsDay > 0.5) this.playAmbient(AMBIENT_ONESHOTS[this.rng.int(0, AMBIENT_ONESHOTS.length - 1)], 0.5);
    }
  }

  /** A songbird / woodpecker somewhere around the ear: a fixed point, steered as the camera moves. */
  private playAmbient(id: string, level: number): void {
    const e = this.ear;
    const ang = this.rng.range(0, Math.PI * 2);
    const d = this.rng.range(12, 45);
    this.playSpec({
      id,
      pool: 'amb',
      at: { x: e.x + Math.cos(ang) * d, y: e.y, z: e.z + Math.sin(ang) * d },
      gain: level * (0.6 + 0.4 * e.zoomNear),
      rate: 1 + this.rng.range(-0.04, 0.04),
    });
  }

  /**
   * Night owl: it perches in a real tree 15–40 m from the ear and calls from it
   * every 20–40 s for 2–5 min, then moves; 30 % of bouts get a distant answer.
   */
  private owlBout(): void {
    const e = this.ear;
    const now = this.ctx!.currentTime;
    if (!this.owl || this.time > this.owl.until || Math.hypot(this.owl.x - e.x, this.owl.z - e.z) > 60) this.owl = this.pickOwlTree();
    const p = this.owl;
    const gain = 0.9 * (0.6 + 0.4 * e.zoomNear);
    this.playSpec({ id: 'amb.owl', pool: 'amb', at: p, gain, rate: 1 + this.rng.range(-0.015, 0.015), radius: 120 });
    if (this.rng.float() < 0.3) {
      // the neighbour answers from its own territory, 60–120 m away
      let m = this.owlMate;
      if (!m || Math.hypot(m.x - e.x, m.z - e.z) > 150) {
        const ang = this.rng.range(0, Math.PI * 2);
        const d = this.rng.range(60, 120);
        m = this.owlMate = { x: p.x + Math.cos(ang) * d, y: p.y, z: p.z + Math.sin(ang) * d };
      }
      this.playSpec({ id: 'amb.owl', pool: 'amb', at: m, gain, rate: 0.97, radius: 160, when: now + this.rng.range(2.5, 5) });
    }
  }

  private pickOwlTree(): OwlPerch {
    if (this.objectsDirty) this.refreshObjects();
    const e = this.ear;
    const t = this.trees;
    const n = t.length / 2;
    // random start, first tree in the 15–40 m ring (horizontal distance from the ear)
    const s = n ? this.rng.int(0, n - 1) : 0;
    for (let k = 0; k < n; k++) {
      const i = ((s + k) % n) * 2;
      const d = Math.hypot(t[i] - e.x, t[i + 1] - e.z);
      if (d >= 15 && d <= 40) {
        const x = t[i],
          z = t[i + 1];
        return { x, y: this.sim.world.heightAt(x, z) + 6, z, until: this.time + this.rng.range(120, 300) };
      }
    }
    // no tree in reach: an owl somewhere out of sight in the outer forest
    const ang = this.rng.range(0, Math.PI * 2);
    const d = this.rng.range(25, 40);
    return { x: e.x + Math.cos(ang) * d, y: e.y, z: e.z + Math.sin(ang) * d, until: this.time + this.rng.range(120, 300) };
  }

  private onCoin(x: number, z: number, amount: number): void {
    if (!this.active() || amount <= 0) return;
    const t = this.time;
    this.coinTokens = Math.min(3, this.coinTokens + (t - this.coinRefill) * 2);
    this.coinRefill = t;
    if (t - this.coinLast < 0.12 || this.coinTokens < 1) return;
    const gain = (0.3 + 0.7 * this.ear.zoomNear) * (amount >= 50 ? 1 : amount >= 10 ? 0.8 : 0.6);
    // built-in fallback (no module owns coins): the feedback module's coin variants
    if (!this.playSpec({ id: `cue.coin#${this.rng.int(0, 3)}`, pool: 'fx', at: { x, y: 1, z }, gain, rate: 1 + this.rng.range(-0.04, 0.06), duck: false })) return;
    this.coinTokens -= 1;
    this.coinLast = t;
  }
}

/** 0 day .. 1 night. */
function nightnessAt(h: number): number {
  return h < 12 ? 1 - smoothstep(4.6, 5.9, h) : smoothstep(19.6, 21.2, h);
}

/** Wind by hour: calm nights (0.6), gusty afternoons (1.15 from 13 to 17 h). */
export function windByHour(h: number): number {
  if (h < 6 || h >= 22) return 0.6;
  if (h < 13) return 0.6 + (0.55 * (h - 6)) / 7;
  if (h < 17) return 1.15;
  return 1.15 - (0.55 * (h - 17)) / 5;
}

/** Crowd density near the ear → 0..1, logarithmic (1 guest ≈ 0.2, 7 ≈ 0.6, 30+ = 1). */
export function crowdNearLevel(g: number): number {
  return Math.min(1, Math.log2(1 + g) / Math.log2(31));
}

/** Visible guests → overview crowd 0..1 (10 ≈ 0.35, 100 ≈ 0.7, 300 = 1). */
export function crowdFarLevel(n: number): number {
  return Math.min(1, Math.log2(1 + n / 2) / Math.log2(151));
}

/** Weighted biome tile sum → 0..1 (a full 15×15 scan of one biome ≈ 0.92). */
export function biomeWeight(sum: number): number {
  return 1 - Math.exp(-sum / 10);
}

/** Sticky user activation of the page (null when the browser cannot tell). */
function userActivation(): boolean | null {
  const ua = typeof navigator !== 'undefined' ? (navigator as unknown as { userActivation?: { hasBeenActive: boolean } }).userActivation : undefined;
  return ua ? ua.hasBeenActive : null;
}

const cueCache = new Map<string, string>();
function cueId(c: string): string {
  let s = cueCache.get(c);
  if (!s) {
    s = `cue.${c}`;
    cueCache.set(c, s);
  }
  return s;
}

/** Transparent below 0.8, then a smooth knee towards ±0.885 (−1.06 dBFS: never hard clips, never over −1 dBFS). */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a < 0.8 ? a : 0.8 + 0.085 * Math.tanh((a - 0.8) / 0.085);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

/** Read the saved graphics tier: the low tier also gets a lighter audio mix. */
export function savedLowSpec(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(QUALITY_KEY) === 'low';
  } catch {
    return false;
  }
}
