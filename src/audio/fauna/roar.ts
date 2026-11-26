// Lion roaring by count, not by share: one dusk chorus, at most EXTRA_ROARS
// more roaring bouts through the night and one dawn chorus, each at least
// ROAR_SPACING s of real time after the last (a chorus is a caller and one
// joiner, a roar in the night one lion's). By day and once the
// night's count is spent a lion's call is moans and a grunt series (diel.ts
// daytimeCall).

/** The night's roaring runs from dusk to dawn (hours). */
export const DUSK = 19.5;
export const DAWN = 6;
/** The dawn chorus may start from this hour. */
export const DAWN_CHORUS = 4.5;
/** Roaring bouts between the dusk and dawn choruses, up to this hour (the dawn chorus keeps its spacing). */
export const EXTRA_ROARS = 2;
export const EXTRA_UNTIL = 1.5;
/** Real seconds between two roaring bouts at least. */
export const ROAR_SPACING = 60;

export type RoarSlot = 'dusk' | 'extra' | 'dawn';

const isNight = (h: number) => h >= DUSK || h < DAWN;

export class RoarCount {
  private dusk = false;
  private extra = 0;
  private dawn = false;
  private last = -1e9;
  private wasNight = false;

  /** The roaring bout a lion may start now (hour 0..24, t real seconds), or null. */
  slot(hour: number, t: number): RoarSlot | null {
    this.track(hour);
    if (!isNight(hour) || t - this.last < ROAR_SPACING) return null;
    if (hour >= DAWN_CHORUS && hour < DAWN) return this.dawn ? null : 'dawn';
    // the night's first chorus (also when the game starts after dusk)
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

  /** A new night (dusk crossed) starts a fresh count. */
  private track(hour: number): void {
    const night = isNight(hour);
    if (night && !this.wasNight) {
      this.dusk = this.dawn = false;
      this.extra = 0;
    }
    this.wasNight = night;
  }
}
