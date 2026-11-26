// The build-step phase table (tutorial.md §5.4): which part of a step the player is in, from
// the category, tool, pending action, sheet, zoo menu and dialog.
import { describe, expect, it } from 'vitest';
import type { Tool } from '../src/core/types';
import type { PendingInfo } from '../src/core/ui-ext';
import { buildPhase, type PhaseInput } from '../src/ui/tutorial/phase';
import { BUILD, STEPS, type StepId } from '../src/ui/tutorial/script';

const SELECT: Tool = { kind: 'select' };
const OWN: Record<string, Tool> = {
  fence: { kind: 'fence', fenceId: 1 },
  paint: { kind: 'terrain', terrain: 1, brush: 1 },
  water: { kind: 'object', defId: 'water_trough', rot: 0 },
  shelter: { kind: 'object', defId: 'shelter_wood', rot: 0 },
  plant: { kind: 'object', defId: 'grass_tall', rot: 0 },
  adopt: { kind: 'animal', speciesId: 'zebra' },
  path: { kind: 'path', pathType: 1 },
  kiosk: { kind: 'object', defId: 'shop_snack', rot: 0 },
  bench: { kind: 'object', defId: 'bench', rot: 0 },
  bin: { kind: 'object', defId: 'bin', rot: 0 },
  keeper: { kind: 'staff', role: 'keeper' },
};
const OTHER: Tool = { kind: 'bulldoze' };
const pend = (ok: boolean, note: string | null = null, risky = false, kind: Tool['kind'] = 'object'): PendingInfo => ({ kind, ok, risky, note, noteKind: note ? (ok ? 'warning' : 'reason') : null });
const input = (o: Partial<PhaseInput>): PhaseInput => ({ category: null, tool: SELECT, moving: false, pending: null, sheetOpen: false, zooOpen: false, dialog: false, ...o });

const builds = STEPS.filter((s) => s.build).map((s) => s.id as StepId);

describe('tutorial build phases', () => {
  it('covers the eleven build steps', () => {
    expect(builds).toEqual(['fence', 'paint', 'water', 'shelter', 'plant', 'adopt', 'path', 'kiosk', 'bench', 'bin', 'keeper']);
  });

  for (const id of builds) {
    const b = BUILD[id]!;
    describe(id, () => {
      const table: [string, Partial<PhaseInput>, boolean, string][] = [
        ['nothing open', {}, false, 'open'],
        ['nothing open after a regress', {}, true, 'regress'],
        ['its category open', { category: b.cat }, false, 'pick'],
        ['another category open', { category: b.cat === 'animals' ? 'paths' : 'animals' }, false, 'wrong'],
        ['another tool in hand', { tool: OTHER }, false, 'wrong'],
        ['its tool in hand', { tool: OWN[id] }, false, 'use'],
        ['its tool with its drawer open again (old tour: step aside)', { tool: OWN[id], category: b.cat }, false, 'hidden'],
        ['its tool, moving something', { tool: OWN[id], moving: true }, false, 'wrong'],
        ['a valid pending action', { tool: OWN[id], pending: pend(true) }, false, 'confirm'],
        ['a red pending action', { tool: OWN[id], pending: pend(false, 'Tile is occupied') }, false, 'invalid'],
        ['an info sheet open', { sheetOpen: true, tool: OWN[id] }, false, 'otherSheet'],
        ['the zoo menu open', { zooOpen: true }, false, 'hidden'],
        ['a dialog open', { dialog: true, category: b.cat }, false, 'hidden'],
      ];
      for (const [name, f, regressed, want] of table) {
        it(`${name} → ${want}`, () => {
          expect(buildPhase(b, input(f), regressed).phase).toBe(want);
        });
      }
    });
  }

  it("a fence whose note says it won't make a habitat is invalid (even though ok)", () => {
    const b = BUILD.fence!;
    const r = buildPhase(b, input({ tool: OWN.fence, pending: pend(true, 'Not a habitat yet: fences can’t cross a path, so this one won’t close', false, 'fence') }), false);
    expect(r).toEqual({ phase: 'invalid', line: 'fence.invalid' });
    expect(buildPhase(b, input({ tool: OWN.fence, pending: pend(true, null, false, 'fence') }), false).phase).toBe('confirm');
    // any fence type counts as the step's tool
    expect(buildPhase(b, input({ tool: { kind: 'fence', fenceId: 3 } }), false).phase).toBe('use');
  });

  it('adopting an animal the fence is too weak for nudges to the zebra', () => {
    const b = BUILD.adopt!;
    const lion: Tool = { kind: 'animal', speciesId: 'lion' };
    expect(buildPhase(b, input({ tool: lion, pending: pend(true, 'The fence is too weak for lions', true, 'animal') }), false)).toEqual({ phase: 'invalid', line: 'adopt.weak' });
    expect(buildPhase(b, input({ tool: lion, pending: pend(true, null, false, 'animal') }), false).phase).toBe('confirm');
  });

  it('shops that miss the path, keepers off the path and red spots get their own nudge', () => {
    expect(buildPhase(BUILD.kiosk!, input({ tool: OWN.kiosk, pending: pend(false, 'Must be next to a path') }), false).line).toBe('kiosk.invalid');
    expect(buildPhase(BUILD.keeper!, input({ tool: OWN.keeper, pending: pend(false, 'Staff start on a path', false, 'staff') }), false).line).toBe('keeper.invalid');
    expect(buildPhase(BUILD.water!, input({ tool: OWN.water, pending: pend(false, 'Must be placed inside a habitat') }), false).line).toBe('spot.invalid');
  });

  it('the other furnishing and plant tools count (Rock Den is a shelter, any plant or rock)', () => {
    expect(BUILD.shelter!.accepts({ kind: 'object', defId: 'shelter_cave', rot: 0 })).toBe(true);
    expect(BUILD.plant!.accepts({ kind: 'object', defId: 'rock_boulder', rot: 0 })).toBe(true);
    expect(BUILD.plant!.accepts({ kind: 'object', defId: 'shelter_wood', rot: 0 })).toBe(false);
    expect(BUILD.kiosk!.accepts({ kind: 'object', defId: 'shop_icecream', rot: 0 })).toBe(true);
    expect(BUILD.kiosk!.accepts({ kind: 'object', defId: 'shop_gift', rot: 0 })).toBe(false);
    expect(BUILD.bench!.accepts({ kind: 'object', defId: 'picnic_table', rot: 0 })).toBe(true);
    expect(BUILD.keeper!.accepts({ kind: 'staff', role: 'vet' })).toBe(false);
  });
});
