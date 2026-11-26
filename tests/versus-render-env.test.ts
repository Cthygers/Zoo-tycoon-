// The renderer's environment re-capture floor (spec §5.8, V3): shouldRecapture is the whole
// decision; the defaults (6 s, jump bypass on) must keep the behaviour from before the floor.
import { describe, expect, it } from 'vitest';
import { shouldRecapture } from '../src/render/context';

/** The rule before setEnvCaptureFloor existed (with an environment already captured). */
function before(age: number, dirty: boolean, jump: boolean): boolean {
  if (!dirty && age < 40) return false;
  if (age < 6 && !jump) return false;
  return true;
}

describe('shouldRecapture', () => {
  it('with the defaults (6, true) matches the old rule everywhere, forced or not', () => {
    for (const age of [0, 1, 5.9, 6, 7, 19, 20, 39.9, 40, 100, 1e9])
      for (const dirty of [false, true])
        for (const jump of [false, true])
          for (const forced of [false, true]) expect(shouldRecapture(age, dirty, jump, 6, true, forced)).toBe(before(age, dirty, jump));
  });

  it('honours a 20 s floor', () => {
    expect(shouldRecapture(5, true, false, 20, false, false)).toBe(false);
    expect(shouldRecapture(19.9, true, false, 20, false, false)).toBe(false);
    expect(shouldRecapture(20, true, false, 20, false, false)).toBe(true);
    expect(shouldRecapture(25, true, false, 20, true, false)).toBe(true);
    // nothing to refresh: still waits for the 40 s cloud-drift age
    expect(shouldRecapture(25, false, false, 20, false, false)).toBe(false);
    expect(shouldRecapture(41, false, false, 20, false, false)).toBe(true);
  });

  it('ignores >10° sun jumps when bypass is off, except when an explicit path forced the capture', () => {
    expect(shouldRecapture(3, true, true, 20, false, false)).toBe(false);
    expect(shouldRecapture(3, true, true, 20, false, true)).toBe(true);
    expect(shouldRecapture(3, true, true, 20, true, false)).toBe(true);
    // settle() marks the map dirty and very old: captures through any floor
    expect(shouldRecapture(1e9, true, false, 20, false, true)).toBe(true);
    // a forced capture with no jump still waits for the floor (quality change mid-match)
    expect(shouldRecapture(3, true, false, 20, false, true)).toBe(false);
  });
});
