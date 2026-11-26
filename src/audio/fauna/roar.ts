// Lion roaring by count, not by share: one dusk chorus, at most EXTRA_ROARS
// more roaring bouts through the night and one dawn chorus, each at least
// ROAR_SPACING s of real time after the last (a chorus is a caller and one
// joiner, a roar in the night one lion's). By day and once the
// night's count is spent a lion's call is moans and a grunt series (diel.ts
// daytimeCall). A game that starts (or a save that loads) in the night after the
// dusk chorus window does not open with a chorus: its dusk chorus counts as
// past, and its first roar waits LATE_HOLD s.

/** The night's roaring runs from dusk to dawn (hours). */
export const DUSK = 19.5;
export const DAWN = 6;
/** The dusk chorus window: a game starting in it may open with the chorus (hours). */
export const DUSK_WINDOW: readonly [number, number] = [19, 20.5];
/** The dawn chorus may start from this hour. */
export const DAWN_CHORUS = 4.5;
/** Roaring bouts between the dusk and dawn choruses, up to this hour (the dawn chorus keeps its spacing). */
export const EXTRA_ROARS = 2;
export const EXTRA_UNTIL = 1.5;
/** Real seconds between two roaring bouts at least. */
export const ROAR_SPACING = 60;
/** A late night start: no roar for this long [min, max] real s. */
export const LATE_HOLD: readonly [number, number] = [90, 180];
/** A jump of the clock by more than this many hours between two looks is a new start (a save loaded). */
const START_JUMP = 1;

export type RoarSlot = 'dusk' | 'extra' | 'dawn';

const isNight = (h: number) => h >= DUSK || h < DAWN;
const inDuskWindow = (h: number) => h >= DUSK_WINDOW[0] && h < DUSK_WINDOW[1];

export class RoarCount {
  private dusk = false;
  private extra = 0;
  private dawn = false;
  private last = -1e9;
  private wasNight = false;
  private lastHour = NaN;
  private holdUntil = -1e9;

  /** `hold` (0..1, a random draw) places a late start's wait within LATE_HOLD. */
  constructor(private readonly hold = 0.5) {}

  /** The roaring bout a lion may start now (hour 0..24, t real seconds), or null. */
  slot(hour: number, t: number): RoarSlot | null {
    this.track(hour, t);
    if (!isNight(hour) || t - this.last < ROAR_SPACING || t < this.holdUntil) return null;
    if (hour >= DAWN_CHORUS && hour < DAWN) return this.dawn ? null : 'dawn';
    // the night's first chorus (a game started in the dusk window opens with it)
    if (!this.dusk) return 'dusk';
    return this.extra < EXTRA_ROARS && (hour >= DUSK || hour < EXTRA_UNTIL) ? 'extra' : null;
  }

  /** A roaring bout started in `slot` at real time t. */
  take(slot: RoarSlot, t: number): void {
    if (slot === 'dusk') this.dusk = true;
    else if (slot === 'dawn') this.dawn = true;
    else this.extra++;
    this.last = t;
  }

  /** A new night (dusk crossed) starts a fresh count; a start in the night past the dusk window holds the roars back. */
  private track(hour: number, t: number): void {
    const night = isNight(hour);
    const gap = Math.abs(hour - this.lastHour);
    const start = !(Math.min(gap, 24 - gap) <= START_JUMP);
    if (start) {
      this.dusk = this.dawn = false;
      this.extra = 0;
      if (night && !inDuskWindow(hour)) {
        this.dusk = true;
        this.holdUntil = t + LATE_HOLD[0] + this.hold * (LATE_HOLD[1] - LATE_HOLD[0]);
      }
    } else if (night && !this.wasNight) {
      this.dusk = this.dawn = false;
      this.extra = 0;
    }
    this.wasNight = night;
    this.lastHour = hour;
  }
}
