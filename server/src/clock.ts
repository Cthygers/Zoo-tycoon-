// clock.ts — the only source of "now" for the server (tests inject a FakeClock).

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Manually driven clock for tests: starts at `start` (default: real now) and moves only on advance()/set(). */
export class FakeClock implements Clock {
  private t: number;
  constructor(start: number = Date.now()) {
    this.t = Math.floor(start);
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): number {
    this.t += Math.floor(ms);
    return this.t;
  }
  set(t: number): void {
    this.t = Math.floor(t);
  }
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
