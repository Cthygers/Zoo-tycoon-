// Public entry point of the simulation module.

import type { ISimulation } from '../core/contracts';
import type { EventBus } from '../core/events';
import { Simulation } from './simulation';

export { Simulation } from './simulation';

/**
 * Create the game simulation. It owns a World built with `seed`; call
 * `newGame()` (lays out the starter map) or `load()` before playing.
 */
export function createSimulation(events: EventBus, seed?: number): ISimulation {
  return new Simulation(events, seed);
}
