// Procedural audio (placeholder: silent). The audio module owner replaces this
// with WebAudio ambience, animal calls and UI cues.
import type * as THREE from 'three';
import type { IAudio, ISimulation } from '../core/contracts';
import type { EventBus } from '../core/events';

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

export function createAudio(_sim: ISimulation, _events: EventBus): IAudio {
  return new SilentAudio();
}
