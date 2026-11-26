// Player sound-mix preferences: one volume per mixer channel, kept in
// localStorage apart from the save game. The Sound switch keeps its own
// SOUND_KEY ('1' / '0'), so older builds still read it.

import type { AudioChannel, IAudio } from '../core/contracts';

export const AUDIO_PREFS_KEY = 'wildhaven-audio';

export interface AudioPrefs {
  v: 1;
  master: number;
  ambience: number;
  world: number;
  ui: number;
  /** Stored for the music channel to come; nothing plays on it yet. */
  music: number;
}

export const DEFAULT_PREFS: Readonly<AudioPrefs> = { v: 1, master: 1, ambience: 0.9, world: 1, ui: 0.85, music: 0.75 };

const CHANNELS = ['master', 'ambience', 'world', 'ui', 'music'] as const satisfies readonly AudioChannel[];
/** Channels the engine mixes today (music is stored only). */
const APPLIED = ['master', 'ambience', 'world', 'ui'] as const satisfies readonly AudioChannel[];

/** Clamp to 0..1 in steps of 0.05 (the slider step). */
function level(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.round(Math.max(0, Math.min(1, v)) * 20) / 20;
}

/** Preferences from storage: missing, malformed or another version → defaults. */
export function parsePrefs(raw: string | null): AudioPrefs {
  let o: unknown = null;
  try {
    o = raw ? JSON.parse(raw) : null;
  } catch {
    o = null;
  }
  const p: AudioPrefs = { ...DEFAULT_PREFS };
  if (!o || typeof o !== 'object' || (o as { v?: unknown }).v !== 1) return p;
  for (const ch of CHANNELS) p[ch] = level((o as Record<string, unknown>)[ch], DEFAULT_PREFS[ch]);
  return p;
}

export function serializePrefs(p: AudioPrefs): string {
  const out: AudioPrefs = { ...DEFAULT_PREFS };
  for (const ch of CHANNELS) out[ch] = level(p[ch], DEFAULT_PREFS[ch]);
  return JSON.stringify(out);
}

/** Push the volumes to the audio engine (an IAudio without channel volumes is left alone). */
export function applyPrefs(audio: Pick<IAudio, 'setVolume'>, p: AudioPrefs): void {
  for (const ch of APPLIED) audio.setVolume?.(ch, p[ch]);
}
