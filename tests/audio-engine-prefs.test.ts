// Sound-mix preferences across versions (src/audio/prefs.ts): the UI volume
// default moved from 0.85 to 1 in round A2; prefs saved by 0.14.0 still load.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, parsePrefs, serializePrefs } from '../src/audio/prefs';

describe('audio preferences: UI volume default', () => {
  it('defaults the UI channel to full volume', () => {
    expect(DEFAULT_PREFS.ui).toBe(1);
    expect(parsePrefs(null).ui).toBe(1);
  });

  it('moves the untouched 0.14.0 default (0.85) to the new one and keeps everything else', () => {
    const old = JSON.stringify({ v: 1, master: 0.7, ambience: 0.9, world: 1, ui: 0.85, music: 0.75 });
    expect(parsePrefs(old)).toEqual({ v: 1, master: 0.7, ambience: 0.9, world: 1, ui: 1, music: 0.75 });
    expect(parsePrefs(JSON.stringify({ v: 1, ui: 0.6 })).ui).toBe(0.6);
  });

  it('keeps a UI volume of 0.85 chosen after the change, and stays readable as version 1', () => {
    const saved = serializePrefs({ ...DEFAULT_PREFS, ui: 0.85 });
    expect(JSON.parse(saved).v).toBe(1);
    expect(parsePrefs(saved).ui).toBe(0.85);
  });
});
