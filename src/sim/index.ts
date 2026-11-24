// Public entry point of the simulation module.

import type { ISimulation } from '../core/contracts';
import type { EventBus } from '../core/events';
import { Simulation } from './simulation';

export { Simulation } from './simulation';

/** Start time (minute of the day) of a player's New Zoo: 08:30, a fresh, bright morning just after the gates open. */
export const NEW_ZOO_START_MINUTE = 8 * 60 + 30;

/**
 * Create the game simulation. It owns a World built with `seed`; call
 * `newGame()` (lays out the starter map) or `load()` before playing.
 */
export function createSimulation(events: EventBus, seed?: number): ISimulation {
  return new Simulation(events, seed);
}
