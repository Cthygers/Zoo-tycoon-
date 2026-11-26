// Which part of a build step the player is in (tutorial.md §5.4), from the UI state alone.
// Pure and table-tested (tests/tutorial-phase.test.ts).

import type { Tool } from '../../core/types';
import type { PendingInfo } from '../../core/ui-ext';
import type { BuildSpec, LineKey } from './script';

/** What the build UI looks like right now (a slice of Facts). */
export interface PhaseInput {
  category: string | null;
  tool: Tool;
  moving: boolean;
  pending: PendingInfo | null;
  /** An info sheet is open (selection). */
  sheetOpen: boolean;
  /** The zoo menu is open. */
  zooOpen: boolean;
  dialog: boolean;
}

export type BuildPhase = 'hidden' | 'otherSheet' | 'open' | 'regress' | 'wrong' | 'pick' | 'use' | 'confirm' | 'invalid';

export interface PhaseResult {
  phase: BuildPhase;
  /** For 'invalid': the nudge the step's spec chose (null = its generic invalid line). */
  line: LineKey | null;
}

/** Order of the forward phases, to tell "progress" from "a step back". */
export const PHASE_RANK: Readonly<Partial<Record<BuildPhase, number>>> = { open: 0, regress: 0, wrong: 0, pick: 1, use: 2, invalid: 2, confirm: 3 };

export function buildPhase(b: BuildSpec, f: PhaseInput, regressed: boolean): PhaseResult {
  if (f.dialog || f.zooOpen) return { phase: 'hidden', line: null };
  if (f.sheetOpen) return { phase: 'otherSheet', line: null };
  const own = b.accepts(f.tool) && !f.moving;
  if (f.category === null) {
    if (f.tool.kind === 'select') return { phase: regressed ? 'regress' : 'open', line: null };
    if (!own) return { phase: 'wrong', line: null };
    if (f.pending) {
      const bad = b.invalid?.(f.pending) ?? null;
      if (bad) return { phase: 'invalid', line: bad };
      return f.pending.ok ? { phase: 'confirm', line: null } : { phase: 'invalid', line: null };
    }
    return { phase: 'use', line: null };
  }
  // the old tour's rule: the step's own tool in hand with its drawer open again → step aside
  if (f.category === b.cat) return { phase: own ? 'hidden' : 'pick', line: null };
  return { phase: 'wrong', line: null };
}
