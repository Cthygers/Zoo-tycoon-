// "Help me" (spec §6.3, T2): after 3 attempts or 60 s without progress the bubble offers to do
// the step for the child, through the game's normal commands (so the usual feedback plays),
// then "Your turn next time!". Pure over a small host so tests can run it on a real Simulation.

import { TILE } from '../../core/constants';
import type { ISimulation, SimSpeed } from '../../core/contracts';
import { PathType, Terrain, type CommandResult, type SelectionRef } from '../../core/types';
import { hintFor, homeOf, type HintContext, type SimFacts, type WorldHint } from './facts';
import { findPlot, habitatRect, inset, rectCentre, type Spot } from './plot';
import type { StepId } from './script';

export interface HelpHost {
  sim: ISimulation;
  runCommand(fn: () => CommandResult, at?: { x: number; z: number }): CommandResult;
  select(sel: SelectionRef | null): void;
  setSpeed(s: SimSpeed, source: 'ext'): boolean;
  openMenu(tab?: string): void;
  cameraDemo(kind: 'pan' | 'zoom' | 'turn'): Promise<void>;
  /** The goal pill's own action (as if tapped). */
  tapPill(): void;
}

export type HelpOutcome = { ok: true } | { ok: false; reason: 'noMoney' | 'noSpot' | 'failed' };

/** The defId each furnishing step places. */
export const HELP_OBJECT: Partial<Record<StepId, string>> = {
  water: 'water_trough',
  shelter: 'shelter_wood',
  plant: 'grass_tall',
  kiosk: 'shop_snack',
  bench: 'bench',
  bin: 'bin',
};

function outcome(sim: ISimulation, r: CommandResult): HelpOutcome {
  if (r.ok) return { ok: true };
  return { ok: false, reason: r.cost > 0 && sim.money < r.cost ? 'noMoney' : 'failed' };
}

const spotCentre = (s: Spot) => ({ x: (s.tx + s.w / 2) * TILE, z: (s.tz + s.d / 2) * TILE });

/**
 * Do the current step for the player. `hint` is the step's yellow marker when the controller
 * has one (else it is worked out here).
 */
export async function runHelp(step: StepId, host: HelpHost, c: HintContext, gap: SimFacts['gap'], hint: WorldHint | null = null): Promise<HelpOutcome> {
  const sim = host.sim;
  const w = sim.world;
  const h = hint ?? hintFor(step, sim, c, gap);
  switch (step) {
    case 'look-pan':
      await host.cameraDemo('pan');
      return { ok: true };
    case 'look-zoom':
      await host.cameraDemo('zoom');
      return { ok: true };
    case 'look-turn':
      await host.cameraDemo('turn');
      return { ok: true };
    case 'fence': {
      if (c.regressed && gap && gap.edges.length) {
        const e = gap.edges[0];
        return outcome(sim, host.runCommand(() => sim.placeFences(gap.edges, gap.fenceId), { x: e.x * TILE, z: e.z * TILE }));
      }
      const plot = c.plot ?? findPlot(sim);
      if (!plot) return { ok: false, reason: 'noSpot' };
      return outcome(sim, host.runCommand(() => sim.placeFences(w.edgesAroundRect(plot), 1), rectCentre(plot)));
    }
    case 'paint': {
      const r = habitatRect(w, homeOf(sim, c));
      if (!r) return { ok: false, reason: 'noSpot' };
      const ri = inset(r, 1);
      return outcome(sim, host.runCommand(() => sim.paintTerrain(ri, Terrain.DryGrass), rectCentre(ri)));
    }
    case 'water':
    case 'shelter':
    case 'plant':
    case 'kiosk':
    case 'bench':
    case 'bin': {
      const defId = HELP_OBJECT[step]!;
      if (!h || h.kind !== 'spot') return { ok: false, reason: 'noSpot' };
      const s = h.spot;
      return outcome(sim, host.runCommand(() => sim.placeObject(defId, s.tx, s.tz, s.rot), spotCentre(s)));
    }
    case 'adopt': {
      if (!h || h.kind !== 'spot') return { ok: false, reason: 'noSpot' };
      const p = spotCentre(h.spot);
      return outcome(sim, host.runCommand(() => sim.buyAnimal(c.speciesId ?? 'zebra', p.x, p.z), p));
    }
    case 'happy': {
      const a = sim.animals.get(c.animalId) ?? sim.animals.values().next().value;
      if (!a) return { ok: false, reason: 'noSpot' };
      host.select({ kind: 'animal', id: a.id });
      return { ok: true };
    }
    case 'path': {
      if (!h || h.kind !== 'tiles') return { ok: false, reason: 'noSpot' };
      const t = h.tiles;
      return outcome(sim, host.runCommand(() => sim.placePaths(t, PathType.Paved), { x: (t[0].x + 0.5) * TILE, z: (t[0].z + 0.5) * TILE }));
    }
    case 'keeper': {
      if (!h || h.kind !== 'tiles' || !h.tiles.length) return { ok: false, reason: 'noSpot' };
      const t = h.tiles[0];
      const p = { x: (t.x + 0.5) * TILE, z: (t.z + 0.5) * TILE };
      return outcome(sim, host.runCommand(() => sim.hireStaff('keeper', p.x, p.z), p));
    }
    case 'play':
      host.setSpeed(1, 'ext');
      return { ok: true };
    case 'guests':
      if (sim.speed === 0) host.setSpeed(1, 'ext');
      sim.welcomeFirstGuests?.();
      return { ok: true };
    case 'money':
      host.openMenu('finance');
      return { ok: true };
    case 'goal':
      host.tapPill();
      return { ok: true };
    case 'speed':
      host.setSpeed(3, 'ext');
      return { ok: true };
    case 'speed-note':
      return { ok: true };
  }
}
