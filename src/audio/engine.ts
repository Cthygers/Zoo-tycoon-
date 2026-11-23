// Procedural audio engine for Wildhaven Zoo (IAudio).
//
// Signal flow (one live AudioContext, created lazily on the first gesture):
//
//   beds  (2 looping sources each, panned L/R) ─► amb bus ─┐
//   voices (pooled: lowpass ► panner ► gain)   ─► sfx bus ─┼─► master ─► compressor ─► soft clip ─► out
//   UI cues (one buffer source each)           ─► ui  bus ─┘
//
// Every sound is pre-rendered once (lazily, one recipe at a time, off the
// main thread in an OfflineAudioContext — see render.ts) so the per-frame work
// is only bookkeeping: a few distance / panning computations and occasional
// AudioParam ramps. No nodes are created per frame; a call or cue creates a
// single AudioBufferSourceNode.

import type * as THREE from 'three';
import { MAP_H, MAP_W, QUALITY_KEY, TILE } from '../core/constants';
import type { IAudio, ISimulation } from '../core/contracts';
import type { EventBus } from '../core/events';
import { Rng } from '../core/rng';
import { Terrain, type AnimalState, type GuestState } from '../core/types';
import { SPECIES_BY_ID } from '../data/species';
import { smoothstep } from './kit';
import { RECIPES, SPECIES_VOICE, seedFor, voiceIdFor, type SpeciesVoice } from './recipes';
import { offlineCtor, renderRecipe, setRenderBudget, yieldMain, type SoundAsset } from './render';

export type Cue = Parameters<IAudio['play']>[0];

export interface AudioEngineOptions {
  /** Render into this context instead of creating an AudioContext (offline harness mix). */
  context?: BaseAudioContext;
  seed?: number;
  /** Fewer voices and single-source beds for low-end phones. */
  lowSpec?: boolean;
  /** Install one-shot unlock listeners (touchend / click / keydown). Default: true with a window. */
  autoUnlock?: boolean;
}

const BED_IDS = ['wind', 'birds', 'night', 'crowd', 'water', 'fountain'] as const;
type BedId = (typeof BED_IDS)[number];
/** Static mix level of each bed relative to its normalised buffer. */
const BED_MIX: Record<BedId, number> = { wind: 0.36, birds: 0.5, night: 0.4, crowd: 0.4, water: 0.42, fountain: 0.36 };
/** Scratch per-bed target levels (reused every update). */
const BED_LEVELS: Record<BedId, number> = { wind: 0, birds: 0, night: 0, crowd: 0, water: 0, fountain: 0 };
const CUE_IDS: readonly Cue[] = ['tap', 'select', 'open', 'close', 'build', 'bulldoze', 'error', 'cash', 'celebrate'];
const MASTER = 0.9;
/** Ambience bus level: beds sit well under calls and cues. */
const AMB_LEVEL = 0.7;
/** Distance (m) up to which a source plays at full level. */
const REF_DIST = 10;
const CALL_RADIUS = 60;
const AMBIENT_ONESHOTS = ['amb.songA', 'amb.songB', 'amb.songA', 'amb.wood', 'amb.crow'] as const;

const noop = () => {};

// -------------------------------------------------------------------- beds

class Bed {
  asset: SoundAsset | null = null;
  readonly out: GainNode;
  private readonly inputs: AudioNode[];
  private readonly pans: StereoPannerNode[] = [];
  private srcs: AudioBufferSourceNode[] = [];
  playing = false;
  quiet = 0;
  level = 0;
  bias = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    dest: AudioNode,
    stereo: boolean,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
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
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(0, now);
    this.level = 0;
    for (let i = 0; i < this.inputs.length; i++) {
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.connect(this.inputs[i]);
      // the second copy runs half a loop apart and 3.5 % slower: decorrelated
      // left / right, and the pair never lines up the same way twice
      if (i === 1) s.playbackRate.value = 0.966;
      s.start(now, (off + i * L * 0.5) % L);
      this.srcs.push(s);
    }
    this.playing = true;
    this.quiet = 0;
  }

  stop(immediate = false): void {
    const now = this.ctx.currentTime;
    for (const s of this.srcs) {
      try {
        s.stop(immediate ? 0 : now + 0.05);
      } catch {
        /* already stopped */
      }
      s.onended = () => s.disconnect();
    }
    this.srcs = [];
    this.playing = false;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(0, now);
    this.level = 0;
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
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, tc);
  }
}

// -------------------------------------------------------------------- voices

class Voice {
  src: AudioBufferSourceNode | null = null;
  readonly filter: BiquadFilterNode;
  readonly pan: StereoPannerNode | null;
  readonly gain: GainNode;
  endAt = 0;
  startAt = 0;
  /** Base level (species loudness) before distance attenuation. */
  level = 0;
  /** Priority at start (for stealing). */
  prio = 0;
  /** Animal id to follow (-1 = fixed). */
  track = -1;
  curGain = 0;
  curPan = 0;
  curCut = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    dest: AudioNode,
  ) {
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 16000;
    this.filter.Q.value = 0.5;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    if (this.pan) {
      this.filter.connect(this.pan);
      this.pan.connect(this.gain);
    } else this.filter.connect(this.gain);
    this.gain.connect(dest);
  }

  busy(now: number): boolean {
    if (this.src && now >= this.endAt) this.src = null;
    return this.src !== null;
  }

  play(buf: AudioBuffer, rate: number, gain: number, pan: number, cut: number): void {
    const now = this.ctx.currentTime;
    let at = now + 0.005;
    const g = this.gain.gain;
    g.cancelScheduledValues(now);
    if (this.src) {
      // steal: quick fade of the old sound on the shared gain, then switch
      g.setValueAtTime(this.curGain, now);
      g.linearRampToValueAtTime(0, now + 0.025);
      try {
        this.src.stop(now + 0.03);
      } catch {
        /* ignore */
      }
      at = now + 0.035;
    }
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    s.connect(this.filter);
    g.setValueAtTime(gain, at);
    this.filter.frequency.cancelScheduledValues(now);
    this.filter.frequency.setValueAtTime(cut, at);
    if (this.pan) {
      this.pan.pan.cancelScheduledValues(now);
      this.pan.pan.setValueAtTime(pan, at);
    }
    s.start(at);
    this.src = s;
    this.startAt = at;
    this.endAt = at + buf.duration / rate + 0.05;
    this.curGain = gain;
    this.curPan = pan;
    this.curCut = cut;
    s.onended = () => {
      s.disconnect();
      if (this.src === s) this.src = null;
    };
  }

  /** Smoothly follow a moving source. */
  steer(gain: number, pan: number, cut: number): void {
    const now = this.ctx.currentTime;
    if (Math.abs(gain - this.curGain) > 0.01) {
      this.curGain = gain;
      this.gain.gain.setTargetAtTime(gain, now, 0.08);
    }
    if (this.pan && Math.abs(pan - this.curPan) > 0.03) {
      this.curPan = pan;
      this.pan.pan.setTargetAtTime(pan, now, 0.08);
    }
    if (Math.abs(cut - this.curCut) > this.curCut * 0.08) {
      this.curCut = cut;
      this.filter.frequency.setTargetAtTime(cut, now, 0.1);
    }
  }

  stop(immediate = false): void {
    if (!this.src) return;
    const now = this.ctx.currentTime;
    try {
      this.src.stop(immediate ? 0 : now + 0.03);
    } catch {
      /* ignore */
    }
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0, now + (immediate ? 0 : 0.03));
    this.src = null;
  }
}

interface SpeciesInfo {
  callId: string;
  idleId: string;
  voice: SpeciesVoice;
}

// -------------------------------------------------------------------- engine

export class ZooAudio implements IAudio {
  private _enabled = true;
  private appSuspended = false;
  private disposed = false;
  private readonly injected: BaseAudioContext | null;
  private ctx: BaseAudioContext | null = null;
  private master!: GainNode;
  private ambBus!: GainNode;
  private sfxBus!: GainNode;
  private uiBus!: GainNode;
  private readonly beds = new Map<BedId, Bed>();
  private voices: Voice[] = [];
  private fxVoices: Voice[] = [];
  private readonly sounds = new Map<string, SoundAsset>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private queue: string[] = [];
  private working = false;
  private idleWaiters: (() => void)[] = [];
  private warned = false;
  private offTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly rng: Rng;
  private readonly lowSpec: boolean;
  private readonly unsub: (() => void)[] = [];
  private unlockBound: (() => void) | null = null;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Background pre-rendering has been queued (warmup or context boot). */
  private warmed = false;

  // listener (updated every frame)
  private lx = 0;
  private ly = 30;
  private lz = 0;
  private rx = 1;
  private ry = 0;
  private rz = 0;
  private fwx = 0;
  private fwy = 0;
  private fwz = -1;
  private fx = 0;
  private fz = 0;
  private camDist = 60;
  private zoomNear = 0.5;
  // attenuation scratch output
  private aGain = 0;
  private aPan = 0;
  private aCut = 16000;

  // environment
  private time = 0;
  private envT = 0;
  private animT = 0;
  private voiceT = 0;
  private gNear = 0;
  private gTotal = 0;
  private gSide = 0;
  private waterSide = 0;
  private fountainSide = 0;
  private crowdNear = 0;
  private crowdFar = 0;
  private waterNear = 0;
  private fountainNear = 0;
  private openness = 1;
  private nightness = 0;
  private birdsDay = 1;
  private fountains: number[] = [];
  private fountainsDirty = true;
  private readonly calling = new Set<number>();
  private readonly near = new Int32Array(256);
  private nearCount = 0;
  private readonly lastCall = new Map<string, number>();
  private readonly lastIdle = new Map<string, number>();
  private readonly lastCue = new Map<Cue, number>();
  private readonly spInfo = new Map<string, SpeciesInfo>();
  private owlT = 20;
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
    this.unsub.push(
      events.on('moneyPopup', (m) => this.onCoin(m.x, m.z, m.amount)),
      events.on('objectiveCompleted', () => this.play('celebrate')),
      events.on('animalAdded', (e) => {
        const a = this.sim.animals.get(e.id);
        if (a && this.warmed) this.requestSpecies(a.speciesId);
      }),
      events.on('animalRemoved', (e) => this.calling.delete(e.id)),
      events.on('objectAdded', () => (this.fountainsDirty = true)),
      events.on('objectRemoved', () => (this.fountainsDirty = true)),
      events.on('worldReset', () => {
        this.fountainsDirty = true;
        this.calling.clear();
        if (this.warmed) this.requestAllSpecies();
      }),
    );
    if (this.injected) {
      this.boot(this.injected);
    } else if ((opts.autoUnlock ?? true) && typeof window !== 'undefined') {
      // Android: touch `pointerdown` is not a user activation; the first
      // touchend / click is. Unlock on whichever comes first.
      const fn = () => {
        if (!this._enabled) return;
        this.resume();
        const c = this.ctx as AudioContext | null;
        if (c && c.state === 'running') this.removeUnlock();
      };
      this.unlockBound = fn;
      for (const ev of ['touchend', 'pointerup', 'click', 'keydown']) window.addEventListener(ev, fn, { capture: true, passive: true });
      // Pre-render in the background (no gesture needed for offline rendering)
      // once the first frames are out, so sounds are ready at the first tap.
      this.warmTimer = setTimeout(() => this.warmup(), 1200);
    }
  }

  /** Queue the sounds the current scene needs; start audio if the page already had a tap. */
  private warmup(): void {
    this.warmTimer = null;
    if (this.disposed || !this._enabled || this.warmed) return;
    this.warmed = true;
    for (const cue of CUE_IDS) this.request(cueId(cue));
    this.request('cue.coin');
    const h = this.sim.minuteOfDay / 60;
    this.request(h < 5.5 || h > 20 ? 'bed.night' : 'bed.birds', true);
    this.request('bed.wind', true);
    if (this.sim.guests.size) this.request('bed.crowd');
    this.requestAllSpecies();
    // the player tapped through the menu: the context may start without another gesture
    if (userActivation() === true) this.resume();
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
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
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
        this.stopAll(true);
        if (!this.injected) (this.ctx as AudioContext).suspend().catch(noop);
      }, 150);
    }
  }

  resume(): void {
    if (this.disposed) return;
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
    this.resumeContext();
    void this.pump();
  }

  suspend(): void {
    this.appSuspended = true;
    if (!this.ctx) return;
    this.stopVoices(true);
    if (!this.injected) {
      const c = this.ctx as AudioContext;
      if (c.state === 'running') c.suspend().catch(noop);
    }
  }

  play(cue: Cue): void {
    if (!this._enabled || this.disposed || this.appSuspended) return;
    // a UI cue runs right after a tap: a good moment to unlock / resume
    if (!this.ctx || (!this.injected && (this.ctx as AudioContext).state !== 'running')) this.resume();
    if (!this.active()) return;
    const c = this.ctx!;
    const a = this.sounds.get(cueId(cue));
    if (!a) {
      this.request(cueId(cue), true);
      return;
    }
    const now = c.currentTime;
    const last = this.lastCue.get(cue) ?? -1;
    if (now - last < 0.045) return;
    this.lastCue.set(cue, now);
    const s = c.createBufferSource();
    s.buffer = a.buffer;
    if (cue === 'tap' || cue === 'select' || cue === 'cash') s.playbackRate.value = 1 + this.rng.range(-0.025, 0.025);
    s.connect(this.uiBus);
    s.start(now);
    s.onended = () => s.disconnect();
    if (cue === 'celebrate') {
      // let the jingle breathe: duck the ambience briefly
      const g = this.ambBus.gain;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(AMB_LEVEL * 0.5, now, 0.06);
      g.setTargetAtTime(AMB_LEVEL, now + 1.3, 0.5);
    }
  }

  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3): void {
    if (!this.active()) return;
    this.time += dt;
    this.updateListener(camera, focus);
    this.envT -= dt;
    if (this.envT <= 0) {
      this.envT = 0.25;
      this.sampleEnvironment();
      this.updateBeds(0.25);
    }
    this.animT -= dt;
    if (this.animT <= 0) {
      this.animT = 0.1;
      this.scanAnimals();
    }
    this.voiceT -= dt;
    if (this.voiceT <= 0) {
      this.voiceT = 0.1;
      this.steerVoices();
    }
    this.ambientOneShots(dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    this.removeUnlock();
    if (this.offTimer !== null) clearTimeout(this.offTimer);
    if (this.warmTimer !== null) clearTimeout(this.warmTimer);
    if (this.ctx) {
      this.stopAll(true);
      if (!this.injected) (this.ctx as AudioContext).close().catch(noop);
    }
    this.ctx = null;
    this.sounds.clear();
    this.queue.length = 0;
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

  /** Snapshot of the mixer state (for debugging / automated checks). */
  debugState(): Record<string, unknown> {
    const beds: Record<string, number> = {};
    const bias: Record<string, number> = {};
    for (const [id, b] of this.beds) {
      beds[id] = b.playing ? Math.round(b.level * 1000) / 1000 : -1;
      if (b.bias) bias[id] = Math.round(b.bias * 100) / 100;
    }
    const now = this.ctx?.currentTime ?? 0;
    return {
      state: this.injected ? 'offline' : ((this.ctx as AudioContext | null)?.state ?? 'none'),
      enabled: this._enabled,
      suspended: this.appSuspended,
      rendered: this.sounds.size,
      pending: this.queue.length + (this.working ? 1 : 0),
      failed: [...this.failed],
      beds,
      bias,
      voices: this.voices.filter((v) => v.busy(now)).length,
      env: {
        crowdNear: +this.crowdNear.toFixed(2),
        crowdFar: +this.crowdFar.toFixed(2),
        water: +this.waterNear.toFixed(2),
        fountain: +this.fountainNear.toFixed(2),
        night: +this.nightness.toFixed(2),
        zoomNear: +this.zoomNear.toFixed(2),
        near: this.nearCount,
      },
    };
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
    this.master = c.createGain();
    this.master.gain.value = 0;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    const clip = c.createWaveShaper();
    clip.curve = softClipCurve();
    this.master.connect(comp);
    comp.connect(clip);
    clip.connect(c.destination);
    this.ambBus = c.createGain();
    this.ambBus.gain.value = AMB_LEVEL;
    this.sfxBus = c.createGain();
    this.sfxBus.gain.value = 0.8;
    this.uiBus = c.createGain();
    this.uiBus.gain.value = 0.9;
    this.ambBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.uiBus.connect(this.master);
    const stereo = !this.lowSpec;
    for (const id of BED_IDS) this.beds.set(id, new Bed(c, this.ambBus, stereo));
    const nv = this.lowSpec ? 4 : 6;
    for (let i = 0; i < nv; i++) this.voices.push(new Voice(c, this.sfxBus));
    for (let i = 0; i < (this.lowSpec ? 1 : 2); i++) this.fxVoices.push(new Voice(c, this.uiBus));
    if (this._enabled) this.master.gain.setTargetAtTime(MASTER, c.currentTime + 0.05, 0.6);
    // UI cues first (tiny), then calls for the animals in the zoo; beds are
    // requested (with priority) by the first environment update.
    this.warmed = true;
    for (const cue of CUE_IDS) this.request(cueId(cue));
    this.request('cue.coin');
    this.requestAllSpecies();
  }

  private resumeContext(): void {
    if (!this.ctx || this.injected) return;
    const c = this.ctx as AudioContext;
    if (c.state === 'suspended' || (c.state as string) === 'interrupted') c.resume().catch(noop);
  }

  private active(): boolean {
    if (!this.ctx || !this._enabled || this.appSuspended || this.disposed) return false;
    return this.injected !== null || (this.ctx as AudioContext).state === 'running';
  }

  private removeUnlock(): void {
    if (!this.unlockBound || typeof window === 'undefined') return;
    for (const ev of ['touchend', 'pointerup', 'click', 'keydown']) window.removeEventListener(ev, this.unlockBound, { capture: true });
    this.unlockBound = null;
  }

  private stopVoices(immediate: boolean): void {
    for (const v of this.voices) v.stop(immediate);
    for (const v of this.fxVoices) v.stop(immediate);
  }

  private stopAll(immediate: boolean): void {
    this.stopVoices(immediate);
    for (const b of this.beds.values()) if (b.playing) b.stop(immediate);
  }

  // ================================================================ render queue

  private request(id: string, urgent = false): void {
    if (this.sounds.has(id) || this.failed.has(id) || !RECIPES[id]) return;
    if (this.pending.has(id)) {
      if (urgent) {
        const i = this.queue.indexOf(id);
        if (i > 0) {
          this.queue.splice(i, 1);
          this.queue.unshift(id);
        }
      }
      return;
    }
    this.pending.add(id);
    if (urgent) this.queue.unshift(id);
    else this.queue.push(id);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length && !this.disposed && this._enabled && !this.appSuspended) {
        const id = this.queue.shift()!;
        try {
          const a = await renderRecipe(RECIPES[id], seedFor(id));
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
    } finally {
      this.working = false;
      if (!this.queue.length) {
        const w = this.idleWaiters;
        this.idleWaiters = [];
        for (const f of w) f();
      }
    }
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

  // ================================================================ listener & environment

  private updateListener(camera: THREE.Camera, focus: THREE.Vector3): void {
    const p = camera.position;
    const q = camera.quaternion;
    this.fx = focus.x;
    this.fz = focus.z;
    const dx = p.x - focus.x,
      dy = p.y - focus.y,
      dz = p.z - focus.z;
    this.camDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.zoomNear = 1 - smoothstep(18, 120, this.camDist);
    // the ear sits a third of the way from the focus point towards the camera
    this.lx = focus.x + dx * 0.35;
    this.ly = focus.y + dy * 0.35;
    this.lz = focus.z + dz * 0.35;
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

  /** Distance gain / stereo pan / air-absorption cutoff for a world point → aGain, aPan, aCut. */
  private attenuate(x: number, y: number, z: number): void {
    const dx = x - this.lx,
      dy = y - this.ly,
      dz = z - this.lz;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-3;
    this.aGain = (REF_DIST / Math.max(REF_DIST, r)) * (1 - smoothstep(55, 95, r));
    const side = (dx * this.rx + dy * this.ry + dz * this.rz) / r;
    const front = (dx * this.fwx + dy * this.fwy + dz * this.fwz) / r;
    this.aPan = Math.max(-0.85, Math.min(0.85, side * 0.9));
    let cut = Math.max(1500, Math.min(16000, 17000 * Math.exp(-r / 38)));
    if (front < 0) cut *= 0.6 + 0.4 * (1 + front);
    this.aCut = cut;
  }

  private readonly scanGuest = (g: GuestState): void => {
    if (g.hidden) return;
    this.gTotal++;
    const dx = g.x - this.fx,
      dz = g.z - this.fz;
    const w = 1 / (1 + (dx * dx + dz * dz) / 225);
    this.gNear += w;
    this.gSide += w * this.side(g.x, g.z);
  };

  /** Left / right position (-1..1) of a ground point as heard from the listener. */
  private side(x: number, z: number): number {
    const dx = x - this.lx,
      dy = -this.ly,
      dz = z - this.lz;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-3;
    return (dx * this.rx + dy * this.ry + dz * this.rz) / r;
  }

  private sampleEnvironment(): void {
    this.gNear = 0;
    this.gTotal = 0;
    this.gSide = 0;
    this.sim.guests.forEach(this.scanGuest);
    this.crowdNear = 1 - Math.exp(-this.gNear / 4);
    this.crowdFar = 1 - Math.exp(-this.gTotal / 50);
    // water tiles around the focus
    const world = this.sim.world;
    const R = 7;
    const tx0 = Math.floor(this.fx / TILE),
      tz0 = Math.floor(this.fz / TILE);
    let w = 0;
    let ws = 0;
    for (let dz = -R; dz <= R; dz++) {
      const z = tz0 + dz;
      if (z < 0 || z >= MAP_H) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = tx0 + dx;
        if (x < 0 || x >= MAP_W) continue;
        const t = world.terrain[z * MAP_W + x];
        if (t !== Terrain.Water && t !== Terrain.DeepWater) continue;
        const d = Math.sqrt(dx * dx + dz * dz) / R;
        if (d < 1) {
          const k = (1 - d) * (1 - d);
          w += k;
          ws += k * this.side((x + 0.5) * TILE, (z + 0.5) * TILE);
        }
      }
    }
    this.waterNear = 1 - Math.exp(-w / 5);
    this.waterSide = w > 0 ? ws / w : 0;
    // fountains
    if (this.fountainsDirty) {
      this.fountainsDirty = false;
      this.fountains.length = 0;
      world.objects.forEach((o) => {
        if (o.defId !== 'fountain') return;
        const c = world.objectCenter(o);
        this.fountains.push(c.x, c.z);
      });
    }
    let best = 1e12;
    let bi = -1;
    for (let i = 0; i < this.fountains.length; i += 2) {
      const dx = this.fountains[i] - this.fx,
        dz = this.fountains[i + 1] - this.fz;
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
    const zn = this.zoomNear;
    this.nightness = h < 12 ? 1 - smoothstep(4.6, 5.9, h) : smoothstep(19.6, 21.2, h);
    this.birdsDay = smoothstep(4.9, 5.9, h) * (1 - smoothstep(19.8, 20.9, h));
    const chorus = Math.max(Math.exp(-(((h - 6.4) / 1.1) ** 2)), 0.8 * Math.exp(-(((h - 19.0) / 0.8) ** 2)));
    this.openness += ((this.sim.isOpen() ? 1 : 0.55) - this.openness) * Math.min(1, dt * 0.5);
    const levels = BED_LEVELS;
    levels.birds = this.birdsDay * (0.55 + 0.45 * chorus) * (0.55 + 0.45 * zn);
    levels.night = this.nightness * (0.7 + 0.3 * zn);
    levels.wind = (0.5 + 0.55 * (1 - zn)) * (1 - 0.25 * this.nightness);
    levels.crowd = this.openness * (this.crowdNear * (0.35 + 0.65 * zn) + this.crowdFar * 0.4 * (1 - zn));
    levels.water = this.waterNear * (0.3 + 0.7 * zn);
    levels.fountain = this.fountainNear * (0.25 + 0.75 * zn);
    for (const id of BED_IDS) {
      const bed = this.beds.get(id)!;
      const tgt = levels[id] * BED_MIX[id];
      if (tgt > 0.004) {
        if (!bed.asset) {
          const a = this.sounds.get(`bed.${id}`);
          if (a) bed.asset = a;
          else this.request(`bed.${id}`, true);
        }
        if (bed.asset && !bed.playing) bed.start(this.rng);
        bed.quiet = 0;
      } else if (bed.playing) {
        bed.quiet += dt;
        if (bed.quiet > 4) bed.stop();
      }
      if (bed.playing) bed.setLevel(tgt, 0.9);
    }
    // localised beds lean towards their source
    const crowdSide = this.gNear > 0.05 ? this.gSide / this.gNear : 0;
    this.beds.get('crowd')!.setBias(0.35 * crowdSide * zn);
    this.beds.get('water')!.setBias(0.4 * this.waterSide * zn);
    this.beds.get('fountain')!.setBias(0.5 * this.fountainSide * zn);
  }

  // ================================================================ animals

  private readonly scanAnimal = (a: AnimalState): void => {
    if (a.action === 'call') {
      if (!this.calling.has(a.id)) {
        this.calling.add(a.id);
        if (a.actionTime < 1.5) {
          const dx = a.x - this.fx,
            dz = a.z - this.fz;
          if (dx * dx + dz * dz < CALL_RADIUS * CALL_RADIUS) this.tryVoice(a, true);
        }
      }
    } else if (this.calling.size !== 0) this.calling.delete(a.id);
    if (a.action !== 'sleep' && this.nearCount < this.near.length) {
      const dx = a.x - this.fx,
        dz = a.z - this.fz;
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
    const asset = this.sounds.get(id);
    if (!asset) {
      this.request(id, true);
      return false;
    }
    const lastMap = isCall ? this.lastCall : this.lastIdle;
    const last = lastMap.get(a.speciesId) ?? -1e9;
    if (this.time - last < (isCall ? 2.5 : 9)) return false;
    this.attenuate(a.x, a.y + 1, a.z);
    const young = a.growth < 0.95;
    const level = (isCall ? info.voice.call : info.voice.idle) * (young ? 0.7 : 1);
    const g = this.aGain * level;
    if (g < 0.02) return false;
    const v = this.allocVoice(this.voices, g);
    if (!v) return false;
    let rate = 1 + this.rng.range(-0.05, 0.05);
    if (young) rate *= 1 + (1 - a.growth) * 0.6;
    if (a.sex === 'F') rate *= 1.06;
    v.track = a.id;
    v.level = level;
    v.prio = g;
    v.play(asset.buffer, rate, g, this.aPan, this.aCut);
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
    for (const v of this.voices) {
      if (!v.busy(now) || v.track < 0) continue;
      const a = this.sim.animals.get(v.track);
      if (!a) continue;
      this.attenuate(a.x, a.y + 1, a.z);
      v.steer(this.aGain * v.level, this.aPan, this.aCut);
    }
  }

  // ================================================================ ambient one-shots & coins

  private ambientOneShots(dt: number): void {
    this.owlT -= dt;
    if (this.owlT <= 0) {
      this.owlT = this.rng.range(25, 70);
      if (this.nightness > 0.6) this.playAmbient('amb.owl', 1);
    }
    this.birdT -= dt;
    if (this.birdT <= 0) {
      this.birdT = this.rng.range(7, 20);
      if (this.birdsDay > 0.5) this.playAmbient(AMBIENT_ONESHOTS[this.rng.int(0, AMBIENT_ONESHOTS.length - 1)], 0.5);
    }
  }

  private playAmbient(id: string, level: number): void {
    const a = this.sounds.get(id);
    if (!a) {
      this.request(id);
      return;
    }
    const ang = this.rng.range(0, Math.PI * 2);
    const d = id === 'amb.owl' ? this.rng.range(14, 32) : this.rng.range(12, 45);
    const g = level * (REF_DIST / Math.max(REF_DIST, d)) * (0.6 + 0.4 * this.zoomNear);
    const v = this.allocVoice(this.voices, g * 0.5);
    if (!v) return;
    v.track = -1;
    v.level = g;
    v.prio = g * 0.5;
    v.play(a.buffer, 1 + this.rng.range(-0.04, 0.04), g, Math.sin(ang) * 0.8, Math.max(2500, 16000 * Math.exp(-d / 30)));
  }

  private onCoin(x: number, z: number, amount: number): void {
    if (!this.active() || amount <= 0) return;
    const t = this.time;
    this.coinTokens = Math.min(3, this.coinTokens + (t - this.coinRefill) * 2);
    this.coinRefill = t;
    if (t - this.coinLast < 0.12 || this.coinTokens < 1) return;
    const a = this.sounds.get('cue.coin');
    if (!a) {
      this.request('cue.coin', true);
      return;
    }
    this.attenuate(x, 1, z);
    const g = this.aGain * (0.3 + 0.7 * this.zoomNear) * (amount >= 50 ? 1 : amount >= 10 ? 0.8 : 0.6);
    if (g < 0.04) return;
    const v = this.allocVoice(this.fxVoices, g);
    if (!v) return;
    this.coinTokens -= 1;
    this.coinLast = t;
    v.track = -1;
    v.level = g;
    v.prio = g;
    v.play(a.buffer, 1 + this.rng.range(-0.04, 0.06), g, this.aPan, 16000);
  }
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

/** Transparent below 0.8, then a smooth knee towards ±0.98 (never hard clips). */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a < 0.8 ? a : 0.8 + 0.18 * Math.tanh((a - 0.8) / 0.18);
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
