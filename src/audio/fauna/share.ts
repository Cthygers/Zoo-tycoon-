// Species-share limiter: no voice may take more than a set share of the vocal
// energy over a sliding window (a far pride of lions must not flood the zoo).
// Two measures: energy at a fixed distance from the caller (refEnergy: the
// species the camera is on does not look "loud" for it, 10 minutes), and the
// energy the player hears (heardEnergy: no loud, carrying species may become a
// view's monologue, 2 minutes).

/** Default window (s) and share. */
export const SHARE_WINDOW = 600;
export const SHARE_LIMIT = 0.3;
/** Shares are measured this far from the caller, m: there every species plays at its own level (refDist ≥ 10). */
export const SHARE_REF_DIST = 10;

/** Energy (gain² × s) of one play of `seconds` at SHARE_REF_DIST from the caller. */
export function refEnergy(gain: number, seconds: number, refDist: number): number {
  const g = gain * Math.min(1, refDist / SHARE_REF_DIST);
  return g * g * seconds;
}

/** Heard energy: window (s) and share. */
export const HEARD_WINDOW = 120;
export const HEARD_LIMIT = 0.3;

/** Energy (gain² × s) of one play as heard: `heard` is its gain after distance attenuation. */
export function heardEnergy(heard: number, seconds: number): number {
  return heard * heard * seconds;
}

/** Below this many recent plays the shares say too little to limit anyone. */
const MIN_PLAYS = 12;

export class ShareLimiter {
  private readonly t: number[] = [];
  private readonly voice: string[] = [];
  private readonly energy: number[] = [];
  private head = 0;
  private total = 0;
  private readonly sums = new Map<string, number>();

  constructor(
    private readonly window = SHARE_WINDOW,
    private readonly limit = SHARE_LIMIT,
  ) {}

  /** Record a play of `voice` with this energy (refEnergy) at time `now`. */
  add(voice: string, energy: number, now: number): void {
    this.prune(now);
    this.t.push(now);
    this.voice.push(voice);
    this.energy.push(energy);
    this.total += energy;
    this.sums.set(voice, (this.sums.get(voice) ?? 0) + energy);
  }

  /** Share 0..1 of `voice` in the window ending at `now`. */
  share(voice: string, now: number): number {
    this.prune(now);
    return this.total > 0 ? (this.sums.get(voice) ?? 0) / this.total : 0;
  }

  /**
   * Whether `voice` would be over its share after adding `energy` more (a bout's
   * planned energy); only once the window holds enough plays to judge.
   */
  over(voice: string, now: number, energy = 0): boolean {
    this.prune(now);
    if (this.t.length - this.head < MIN_PLAYS) return false;
    return ((this.sums.get(voice) ?? 0) + energy) / (this.total + energy) > this.limit;
  }

  private prune(now: number): void {
    while (this.head < this.t.length && now - this.t[this.head] > this.window) {
      const v = this.voice[this.head];
      const e = this.energy[this.head];
      this.total -= e;
      this.sums.set(v, (this.sums.get(v) ?? 0) - e);
      this.head++;
    }
    if (this.head > 256 && this.head * 2 > this.t.length) {
      this.t.splice(0, this.head);
      this.voice.splice(0, this.head);
      this.energy.splice(0, this.head);
      this.head = 0;
    }
    if (this.total < 1e-12) this.total = 0;
  }
}
