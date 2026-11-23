// Procedural audio for Wildhaven Zoo: ambient beds (birdsong, wind in leaves,
// night insects, crowd murmur, water, fountains) cross-faded by time of day,
// camera height and what is near the camera focus; positional, synthesised
// animal calls; soft UI / feedback cues. No audio files — every sound is
// synthesised with Web Audio and pre-rendered once into buffers.
//
// Degrades to a silent implementation when Web Audio is unavailable (tests,
// old WebViews) so callers never need to check.

import type * as THREE from 'three';
import type { IAudio, ISimulation } from '../core/contracts';
import type { EventBus } from '../core/events';
import { ZooAudio, savedLowSpec, type AudioEngineOptions } from './engine';

class SilentAudio implements IAudio {
  enabled = true;
  update(_dt: number, _camera: THREE.Camera, _focus: THREE.Vector3): void {}
  play(_cue: Parameters<IAudio['play']>[0]): void {}
  setEnabled(on: boolean): void {
    this.enabled = on;
  }
  resume(): void {}
  suspend(): void {}
  dispose(): void {}
}

function webAudioAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return typeof (w.AudioContext ?? w.webkitAudioContext) === 'function' && typeof (w.OfflineAudioContext ?? w.webkitOfflineAudioContext) === 'function';
}

export function createAudio(sim: ISimulation, events: EventBus, opts: AudioEngineOptions = {}): IAudio {
  if (!opts.context && !webAudioAvailable()) return new SilentAudio();
  try {
    return new ZooAudio(sim, events, { lowSpec: savedLowSpec(), ...opts });
  } catch (err) {
    console.warn('[audio] disabled:', err);
    return new SilentAudio();
  }
}

export { ZooAudio };
export type { AudioEngineOptions };
