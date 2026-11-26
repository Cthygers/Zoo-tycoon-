// Which animal a hovering camera is about: the nearest one under the camera
// focus point becomes the focus and keeps it while it stays near, so a pan or
// a herd milling about does not hop the close-up from animal to animal.

/** A hover focus starts within this many m of the camera focus point ... */
export const HOVER_START = 12;
/** ... and ends beyond this many m. */
export const HOVER_KEEP = 18;
/** Another animal takes the focus over only when it is this many m nearer ... */
export const HANDOVER_GAP = 3;
/** ... for this long, s; and a focus keeps the close-up at least `HOVER_MIN` s before handing it over. */
export const HANDOVER_HOLD = 2;
export const HOVER_MIN = 10;

export class HoverFocus {
  private id = -1;
  private held = 0;
  private rival = -1;
  private rivalFor = 0;

  /** The current hover focus, or −1. */
  get current(): number {
    return this.id;
  }

  /**
   * One scan: `near` / `nearDist` = the animal nearest the camera focus point (−1:
   * none) and its distance, `curDist` = the current focus's distance (Infinity
   * when it is gone). Returns the focus id or −1.
   */
  update(dt: number, near: number, nearDist: number, curDist: number): number {
    if (this.id < 0 || curDist > HOVER_KEEP) {
      this.id = near >= 0 && nearDist <= HOVER_START ? near : -1;
      this.held = this.rivalFor = 0;
      this.rival = -1;
      return this.id;
    }
    this.held += dt;
    if (near >= 0 && near !== this.id && nearDist <= curDist - HANDOVER_GAP) {
      this.rivalFor = near === this.rival ? this.rivalFor + dt : dt;
      this.rival = near;
      if (this.rivalFor >= HANDOVER_HOLD && this.held >= HOVER_MIN) {
        this.id = near;
        this.held = this.rivalFor = 0;
        this.rival = -1;
      }
    } else {
      this.rival = -1;
      this.rivalFor = 0;
    }
    return this.id;
  }

  reset(): void {
    this.id = this.rival = -1;
    this.held = this.rivalFor = 0;
  }
}
