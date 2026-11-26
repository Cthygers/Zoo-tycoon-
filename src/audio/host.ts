// Contract between the audio engine (engine.ts) and engine modules
// (src/audio/modules/*.ts, discovered with import.meta.glob). Types plus the
// shared distance model only — no Web Audio here, so modules and tests can
// import it freely. Modules must never import engine.ts.
import type { ISimulation } from '../core/contracts';
import type { EventBus } from '../core/events';

/** Mixer channels; each has a volume gain and a separate duck gain. */
export type Channel = 'ambience' | 'world' | 'ui' | 'music';
/**
 * Voice pools. voice: animal vocalisations · foley: animal / guest foley ·
 * fx: diegetic one-shots (coins, crate, bell) · amb: ambient wildlife one-shots ·
 * ui: non-positional cues (unpooled, one source each).
 */
export type Pool = 'voice' | 'foley' | 'fx' | 'amb' | 'ui';
export const POOL_SIZES: Readonly<Record<Exclude<Pool, 'ui'>, readonly [number, number]>> = {
  voice: [6, 4], // [normal, lowSpec]
  foley: [3, 1],
  fx: [2, 1],
  amb: [2, 1],
};
export const POOL_CHANNEL: Readonly<Record<Pool, Channel>> = { voice: 'world', foley: 'world', fx: 'world', amb: 'ambience', ui: 'ui' };
export const DEFAULT_REF_DIST = 10;
export const DEFAULT_RADIUS = 95;

export interface Attenuation {
  /** Linear distance gain 0..1 (reference distance + fade over the last 25 % of the radius). */
  gain: number;
  /** Stereo pan −0.85..0.85. */
  pan: number;
  /** Air-absorption low-pass cutoff, Hz. */
  cut: number;
  /** High-shelf gain at 3 kHz, dB (≤ 0). */
  shelfDb: number;
  /** Send to the shared outdoor reverb, 0..1. */
  wet: number;
  /** Distance from the ear, m. */
  dist: number;
}

export interface PlaySpec {
  /** Recipe id. Not rendered yet → it is requested and play() returns null. */
  id: string;
  /** Fixed world position (steered as the camera turns). */
  at?: { x: number; y: number; z: number };
  /** Animal id to follow (position = animal x, y + 1, z); wins over `at`. */
  track?: number;
  /** Default 'voice'. */
  pool?: Pool;
  /** Linear level before distance attenuation; 1 = a lion roar at its refDist. Default 1. */
  gain?: number;
  /** playbackRate. Default 1. */
  rate?: number;
  /** Absolute AudioContext start time ≥ now(). Default now(). */
  when?: number;
  /** Stealing priority. Default: gain × attenuation. */
  prio?: number;
  /** Distance (m) up to which the gain is 1. Default DEFAULT_REF_DIST. */
  refDist?: number;
  /** Audible radius (m). Default DEFAULT_RADIUS. */
  radius?: number;
  /** Per-individual formant colour: peaking biquad (Q 1.2) on the voice. Default flat. */
  color?: { hz: number; db: number };
  /** Bout id: layer onto the voice already playing this group (no steal, tails overlap). */
  group?: number;
  /** Duck the ambience (−3 dB, less as the focus mix comes in) while it plays. Default: pool 'voice' and final gain > 0.3. */
  duck?: boolean;
  /**
   * A landmark / presence call heard from a mid or overview camera: the ambience dips 3 dB
   * (80 ms in) for its length, at least 1 s, then recovers over ~1.2 s. Scaled out as the
   * focus mix comes in (a focus view has made room already). Replaces `duck`.
   */
  landmark?: boolean;
}

export interface VoiceHandle {
  /** AudioContext time at which the (last layered) source of this play ends. */
  readonly endAt: number;
  /** Fade out (default 0.05 s) and stop the sources this handle started. */
  stop(fade?: number): void;
}

export interface ListenerState {
  /** Ear position (a third of the way from the focus towards the camera). */
  x: number;
  y: number;
  z: number;
  /** Camera focus on the ground. */
  fx: number;
  fz: number;
  /** Camera distance to the focus, m. */
  camDist: number;
  /** 1 close .. 0 overview: 1 − smoothstep(18, 120, camDist). */
  zoomNear: number;
}

/** Debug record of one started sound (ZooAudio.debugLog). */
export interface PlayLog {
  t: number;
  id: string;
  pool: Pool;
  gain: number;
  rate: number;
  dist: number;
  track: number;
  x: number;
  z: number;
  group: number;
}

export interface AudioHost {
  readonly sim: ISimulation;
  readonly events: EventBus;
  readonly lowSpec: boolean;
  /** Engine clock, s (advances by update dt while audio is active). */
  readonly time: number;
  /** AudioContext.currentTime (0 before the context exists). */
  now(): number;
  /** Context running and sound enabled; play/loop/duck are no-ops otherwise. */
  readonly active: boolean;
  readonly listener: Readonly<ListenerState>;
  /** Sim hour 0..24 (fractional). */
  readonly hour: number;
  /** 0 day .. 1 night (same curve as the night bed). */
  readonly nightness: number;
  /** Animal followed by the camera (IAudio.follow hint), or −1. */
  readonly followId: number;
  /** Distance model for a world point. Returns a shared scratch object: copy what you keep. */
  attenuate(x: number, y: number, z: number, refDist?: number, radius?: number): Readonly<Attenuation>;
  /** Recipe rendered and ready to play. */
  has(id: string): boolean;
  /** Queue a background render (no-op if unknown, ready, pending or failed). */
  request(id: string, urgent?: boolean): void;
  /** Rendered duration, s (0 if not ready). */
  duration(id: string): number;
  play(spec: PlaySpec): VoiceHandle | null;
  /**
   * Keyed looping layer (colony murmur, crowd feet). `level` is a linear target
   * (smoothed, tc 0.9 s); `side` −1..1 leans the stereo pair. A level ≤ 0.004 for
   * 4 s stops it. At most 4 loops (lowSpec 2): the quietest is dropped.
   */
  loop(key: string, id: string, level: number, side?: number, ch?: Channel): void;
  /** Duck a channel by `db` (attack 80 ms), hold `hold` s, release over ~1.2 s. */
  duck(ch: Channel, db: number, hold: number): void;
  /** Low-pass + gain on world + ambience (pause "time freeze"); (20000, 0, tc) restores. */
  setWorldFilter(cutHz: number, gainDb: number, tc: number): void;
  /** Busy voices in a pool. */
  playing(pool: Pool): number;
}

export interface AudioModule {
  /** Switch off the engine's built-in animal scheduler and its call.* / idle.* renders. */
  readonly ownsAnimals?: boolean;
  /** Switch off the engine's built-in coin sound. */
  readonly ownsCoins?: boolean;
  /** Recipe ids to pre-render in the background (after cues and the current beds). */
  warm?(): readonly string[];
  /** Called on every audio update while active. */
  update(dt: number): void;
  /** Debug / probes: force a sound for an animal; true if handled. */
  force?(animalId: number, kind: string): boolean;
  /** Debug snapshot, merged into ZooAudio.debugState().modules[fileName]. */
  debug?(): Record<string, unknown>;
  dispose(): void;
}
export type AudioModuleFactory = (host: AudioHost) => AudioModule;

/**
 * Shared distance model (engine and tests/helpers/fakeHost.ts). r = distance from
 * the ear; side / front = direction cosines on the camera's right / forward axes.
 */
export function distanceModel(r: number, side: number, front: number, refDist: number, radius: number, out: Attenuation): Attenuation {
  const a = radius * 0.75;
  const u = Math.min(1, Math.max(0, (r - a) / Math.max(1e-6, radius - a)));
  out.gain = (refDist / Math.max(refDist, r)) * (1 - u * u * (3 - 2 * u));
  out.pan = Math.max(-0.85, Math.min(0.85, side * 0.9));
  let cut = Math.max(5000, Math.min(18000, 18000 * Math.exp(-r / 160)));
  if (front < 0) cut *= 0.6 + 0.4 * (1 + front);
  out.cut = cut;
  out.shelfDb = -Math.min(9, 0.06 * r);
  out.wet = Math.max(0.05, Math.min(0.45, (r - 6) / 50));
  out.dist = r;
  return out;
}
