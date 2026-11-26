// The seat's real-time budget (spec §5.1, review V1): from the first "Go!" wall time counts
// whether the app is open or not, and turning the device clock back never gives time back.
//
//   elapsed = max(now − firstGoAt, accMs)
//
// accMs adds the foreground frame deltas (performance.now based, so a clock change in the
// foreground does not move it) and every background gap (Date.now difference, clamped ≥ 0).
// Pure functions over a plain record, persisted in wh2:vs:<pid>/<matchId>.

export interface BudgetState {
  /** Wall time (ms) of the seat's first "Go!", null before it. */
  firstGoAt: number | null;
  /** Accumulated ms: foreground frames plus background gaps. */
  accMs: number;
  /** Wall time the app was hidden at (a gap still open), else null. */
  hiddenAt: number | null;
}

export function newBudget(): BudgetState {
  return { firstGoAt: null, accMs: 0, hiddenAt: null };
}

/** A clean copy of a stored budget (bad fields become their defaults). */
export function readBudget(x: unknown): BudgetState {
  const b = (x ?? {}) as Partial<BudgetState>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { firstGoAt: num(b.firstGoAt), accMs: Math.max(0, num(b.accMs) ?? 0), hiddenAt: num(b.hiddenAt) };
}

/** ms used so far at wall time `now` (a gap still open counts up to now). */
export function budgetElapsed(b: BudgetState, now: number): number {
  if (b.firstGoAt === null) return 0;
  const wall = Math.max(0, now - b.firstGoAt);
  const acc = b.accMs + (b.hiddenAt !== null ? Math.max(0, now - b.hiddenAt) : 0);
  return Math.max(wall, acc);
}

/** ms left of a `totalMs` budget (never negative). */
export function budgetLeft(b: BudgetState, totalMs: number, now: number): number {
  return Math.max(0, totalMs - budgetElapsed(b, now));
}

/** The first "Go!": the budget starts counting. */
export function startBudget(b: BudgetState, now: number): void {
  if (b.firstGoAt === null) b.firstGoAt = now;
}

/** A foreground frame of `ms` (performance.now delta) after the first "Go!". */
export function addForeground(b: BudgetState, ms: number): void {
  if (b.firstGoAt === null || !(ms > 0) || !Number.isFinite(ms)) return;
  b.accMs += ms;
}

/** The app went to the background at wall time `now`. */
export function noteHidden(b: BudgetState, now: number): void {
  if (b.hiddenAt === null) b.hiddenAt = now;
}

/** Back in the foreground (or booted after being killed in the background): the gap counts, ≥ 0. */
export function noteVisible(b: BudgetState, now: number): void {
  if (b.hiddenAt === null) return;
  if (b.firstGoAt !== null) b.accMs += Math.max(0, now - b.hiddenAt);
  b.hiddenAt = null;
}
