// UI sound cues. Every widget calls `cue(name)`; requests made during the same
// task and its promise continuations (one tap → button 'tap' + drawer 'open';
// a dialog's OK → 'tap' + 'bulldoze') are merged and only the most meaningful
// cue is played on the next macrotask, so one interaction never stacks two
// sounds. The game UI binds the audio module on creation.

import type { IAudio } from '../core/contracts';

export type UiCue = 'tap' | 'open' | 'close' | 'select' | 'build' | 'bulldoze' | 'error';

const PRIORITY: Record<UiCue, number> = { tap: 1, close: 2, open: 3, select: 4, error: 5, build: 6, bulldoze: 6 };

let audio: IAudio | null = null;
let pending: UiCue | null = null;
let scheduled = false;
let muted = 0;

function flush(): void {
  scheduled = false;
  const c = pending;
  pending = null;
  if (!c || !audio) return;
  try {
    audio.play(c);
  } catch (err) {
    console.warn('[ui] audio cue failed', err);
  }
}

/** Request a UI cue (merged with other cues requested in the same task). */
export function cue(c: UiCue): void {
  if (!audio || muted > 0) return;
  if (!pending || PRIORITY[c] >= PRIORITY[pending]) pending = c;
  if (!scheduled) {
    scheduled = true;
    setTimeout(flush, 0);
  }
}

/** Run `fn` without producing UI cues (programmatic UI changes). */
export function silently<T>(fn: () => T): T {
  muted++;
  try {
    return fn();
  } finally {
    muted--;
  }
}

export function bindAudio(a: IAudio | null): void {
  audio = a;
  pending = null;
}
