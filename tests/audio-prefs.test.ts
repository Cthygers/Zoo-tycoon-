// Sound-mix preferences (src/audio/prefs.ts): parsing old / bad storage,
// clamping, round trip and pushing the volumes to the audio engine.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, applyPrefs, parsePrefs, serializePrefs } from '../src/audio/prefs';
import type { AudioChannel, IAudio } from '../src/core/contracts';

describe('audio preferences', () => {
  it('falls back to the defaults for nothing, bad JSON or another version', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('[1,2]')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(JSON.stringify({ ...DEFAULT_PREFS, v: 2, ui: 0.2 }))).toEqual(DEFAULT_PREFS);
  });

  it('clamps to 0..1 in 0.05 steps and keeps defaults for missing or non-numeric values', () => {
    const p = parsePrefs(JSON.stringify({ v: 1, master: 1.7, ambience: -1, world: 0.437, ui: 'loud' }));
    expect(p).toEqual({ v: 1, master: 1, ambience: 0, world: 0.45, ui: DEFAULT_PREFS.ui, music: DEFAULT_PREFS.music });
  });

  it('round-trips', () => {
    const p = { v: 1 as const, master: 0.8, ambience: 0.35, world: 0.6, ui: 0.5, music: 0.1 };
    expect(parsePrefs(serializePrefs(p))).toEqual(p);
  });

  it('applies master, ambience, world and ui, and tolerates an IAudio without volumes', () => {
    const calls: [AudioChannel, number][] = [];
    const audio = { setVolume: (ch: AudioChannel, v: number) => calls.push([ch, v]) } as Pick<IAudio, 'setVolume'>;
    applyPrefs(audio, { ...DEFAULT_PREFS, ui: 0.5 });
    expect(calls).toEqual([
      ['master', 1],
      ['ambience', 0.9],
      ['world', 1],
      ['ui', 0.5],
    ]);
    expect(() => applyPrefs({} as Pick<IAudio, 'setVolume'>, DEFAULT_PREFS)).not.toThrow();
  });
});
