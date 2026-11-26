// What the tutorial knows about the zoo and the UI each tick (tutorial.md §5.1): a plain read
// model built at 8 Hz from the simulation (simFacts) and the UI extension host (uiFacts), so
// the step machine itself stays pure and testable with hand-made facts.

import { ENTRANCE_TILE, MAP_W, TILE } from '../../core/constants';
import type { ISimulation, SimSpeed } from '../../core/contracts';
import type { TileRect } from '../../core/events';
import { Terrain, type SelectionRef, type Tool } from '../../core/types';
import type { PendingInfo, UIExtensionHost } from '../../core/ui-ext';
import type { EdgeRef } from '../../core/world';
import { OBJECTS_BY_ID } from '../../data/objects';
import {
  adoptSpot,
  gapEdges,
  habitatRect,
  inset,
  keeperTile,
  pathHintHabitat,
  spotBesidePath,
  spotInside,
  type PlotSim,
  type Spot,
  type TilePos,
} from './plot';
import type { StepId } from './script';

/** Where the gate's guests stand (sim/guests.ts GATE_SPOT). */
export const GATE_SPOT = { x: (ENTRANCE_TILE.x + 0.5) * TILE, z: (ENTRANCE_TILE.z - 0.5) * TILE };
/** A guest this far from the gate has walked in (step 9b). */
export const WALKED_IN_M = 10;

export interface SimFacts {
  habitats: number;
  habitatIds: number[];
  /** A habitat overlapping the suggested plot (0: none). */
  plotHabitat: number;
  /** A fence gap: an opened enclosure's missing edges (spec §6.5). */
  gap: { edges: EdgeRef[]; fenceId: number } | null;
  hasWater: boolean;
  hasShelter: boolean;
  /** A new tree, plant or rock inside / outside a habitat. */
  plantIn: boolean;
  plantOut: boolean;
  animals: number;
  animalsInHabitat: number;
  /** The tutorial's animal (or the first one), with its happiness. */
  animal: { id: number; speciesId: string; happiness: number; x: number; z: number } | null;
  gateOpen: boolean;
  keeper: boolean;
  kiosk: boolean;
  bench: boolean;
  bin: boolean;
  speed: SimSpeed;
  isOpen: boolean;
  day: number;
  money: number;
  /** A guest has walked at least WALKED_IN_M into the zoo. */
  guestIn: boolean;
  versus: boolean;
}

export interface UIFacts {
  category: string | null;
  tool: Tool;
  moving: boolean;
  pending: PendingInfo | null;
  /** The selection whose info sheet is open (null: no sheet). */
  sheet: SelectionRef | null;
  sheetOpen: boolean;
  zooOpen: boolean;
  zooTab: string | null;
  dialog: boolean;
  pointer: 'touch' | 'mouse';
}

export interface Facts extends SimFacts, UIFacts {
  now: number;
  /** The yellow marker for the current step (computed by the controller, null when none). */
  hint: WorldHint | null;
}

export type WorldHint =
  | { kind: 'box'; rect: TileRect }
  | { kind: 'spot'; spot: Spot }
  | { kind: 'tiles'; tiles: TilePos[] }
  | { kind: 'edges'; edges: EdgeRef[] }
  | { kind: 'animal'; id: number; x: number; z: number }
  | { kind: 'point'; x: number; z: number; r: number };

export interface FactsContext {
  plot: TileRect | null;
  homeHabitat: number;
  animalId: number;
  /** Objects up to this id came with the starter map (fallback when the sim does not say). */
  objBase: number;
}

const inRect = (r: TileRect, x: number, z: number) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;

/** Objects with an id up to this one are starter scenery (Simulation.starterObjectMaxId when there). */
export function starterMax(sim: ISimulation, fallback: number): number {
  const v = (sim as { starterObjectMaxId?: unknown }).starterObjectMaxId;
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Is the gate letting guests in? The sim's own gate state where it is reachable (stats() is
 * cached per sim instant, so while the clock is held it can be stale), else stats().
 */
export function gateOpen(sim: ISimulation): boolean {
  const gs = (sim as { guestSys?: { gateState?: () => string } }).guestSys;
  if (gs && typeof gs.gateState === 'function') {
    try {
      return gs.gateState() === 'open';
    } catch {
      /* fall through */
    }
  }
  return sim.stats().gateClosed === null;
}

export function simFacts(sim: ISimulation, c: FactsContext): SimFacts {
  const w = sim.world;
  const base = starterMax(sim, c.objBase);
  let hasWater = false,
    hasShelter = false,
    plantIn = false,
    plantOut = false,
    kiosk = false,
    bench = false,
    bin = false;
  for (const o of w.objects.values()) {
    const d = OBJECTS_BY_ID[o.defId];
    if (!d) continue;
    const inHab = w.inBounds(o.tx, o.tz) && w.habitatOf[w.idx(o.tx, o.tz)] !== 0;
    if (d.serves === 'water' && inHab) hasWater = true;
    if (d.serves === 'shelter' && inHab) hasShelter = true;
    if (o.id > base && (d.category === 'tree' || d.category === 'plant' || d.category === 'rock') && !d.guestOnly) {
      if (inHab) plantIn = true;
      else plantOut = true;
    }
    const k = d.shop?.kind;
    if (k === 'food' || k === 'drink' || k === 'icecream') kiosk = true;
    if (d.bench && o.id > base) bench = true;
    if (d.bin && o.id > base) bin = true;
  }
  const habitatIds = [...w.habitats.keys()];
  if (!hasWater)
    for (const h of w.habitats.values()) if ((h.terrainCounts[Terrain.Water] ?? 0) + (h.terrainCounts[Terrain.DeepWater] ?? 0) > 0) hasWater = true;
  let plotHabitat = 0;
  if (c.plot) {
    for (const h of w.habitats.values()) {
      if (h.maxX < c.plot.x0 || h.minX > c.plot.x1 || h.maxZ < c.plot.z0 || h.minZ > c.plot.z1) continue;
      if (h.tiles.some((i) => inRect(c.plot!, i % MAP_W, (i / MAP_W) | 0))) {
        plotHabitat = h.id;
        break;
      }
    }
  }
  let animalsInHabitat = 0;
  let animal: SimFacts['animal'] = null;
  for (const a of sim.animals.values()) {
    if (!a.escaped && a.habitatId) animalsInHabitat++;
    if (!animal || a.id === c.animalId) animal = { id: a.id, speciesId: a.speciesId, happiness: a.happiness, x: a.x, z: a.z };
  }
  let keeper = false;
  for (const s of sim.staff.values()) if (s.role === 'keeper') keeper = true;
  let guestIn = false;
  for (const g of sim.guests.values()) {
    if (Math.hypot(g.x - GATE_SPOT.x, g.z - GATE_SPOT.z) >= WALKED_IN_M) {
      guestIn = true;
      break;
    }
  }
  let gap: SimFacts['gap'] = null;
  const open = sim.openEnclosures?.() ?? [];
  if (open.length) {
    const g = gapEdges(w, open[0].tiles);
    if (g.edges.length) gap = g;
  }
  return {
    habitats: w.habitats.size,
    habitatIds,
    plotHabitat,
    gap,
    hasWater,
    hasShelter,
    plantIn,
    plantOut,
    animals: sim.animals.size,
    animalsInHabitat,
    animal,
    gateOpen: gateOpen(sim),
    keeper,
    kiosk,
    bench,
    bin,
    speed: sim.speed,
    isOpen: sim.isOpen(),
    day: sim.day,
    money: sim.money,
    guestIn,
    versus: !!sim.versus,
  };
}

function pointerKind(): 'touch' | 'mouse' {
  try {
    if (typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches) return 'mouse';
  } catch {
    /* no media queries */
  }
  return 'touch';
}

export function uiFacts(host: UIExtensionHost): UIFacts {
  const t = host.tool();
  const sheet = host.sheet();
  const zp = host.zooPanel();
  const zooOpen = !!zp.close;
  const sheetOpen = !!sheet.root;
  return {
    category: host.openedCategory(),
    tool: t.tool,
    moving: t.moving,
    pending: host.pending(),
    sheet: sheetOpen ? host.selection() : null,
    sheetOpen,
    zooOpen,
    zooTab: zooOpen ? zp.tab : null,
    dialog: host.dialogOpen(),
    pointer: pointerKind(),
  };
}

// --------------------------------------------------------------------------- hints
/** What the controller remembers for the hints (the machine's blob fields). */
export interface HintContext {
  plot: TileRect | null;
  homeHabitat: number;
  animalId: number;
  speciesId: string | null;
  corridor: TilePos[];
  regressed: boolean;
}

/** The home habitat: the remembered one while it exists, else the plot's, else the first. */
export function homeOf(sim: ISimulation, c: Pick<HintContext, 'homeHabitat' | 'plot'>): number {
  const w = sim.world;
  if (c.homeHabitat && w.habitats.has(c.homeHabitat)) return c.homeHabitat;
  if (c.plot) {
    for (const h of w.habitats.values()) if (h.tiles.some((i) => inRect(c.plot!, i % MAP_W, (i / MAP_W) | 0))) return h.id;
  }
  const first = w.habitats.keys().next();
  return first.done ? 0 : first.value;
}

const spotHint = (s: Spot | null): WorldHint | null => (s ? { kind: 'spot', spot: s } : null);

/** Corridor ends for the guest-building spots: the grey path's side and the fence's side. */
function corridorNear(sim: ISimulation, home: number, corridor: TilePos[]): { start: TilePos; end: TilePos; perp: TilePos; mirror: TilePos } | null {
  const w = sim.world;
  let start: TilePos | null = corridor[0] ?? null;
  let end: TilePos | null = corridor[corridor.length - 1] ?? null;
  if (!start || !end) {
    // the habitat was beside a path already: its nearest view tile
    const h = w.habitats.get(home);
    if (!h || !h.viewTiles.length) return null;
    const cx = (h.minX + h.maxX) / 2,
      cz = (h.minZ + h.maxZ) / 2;
    const v = h.viewTiles.map((i) => ({ x: i % MAP_W, z: (i / MAP_W) | 0 })).sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))[0];
    start = end = v;
  }
  const dx = Math.sign(end.x - start.x),
    dz = Math.sign(end.z - start.z);
  // perpendicular to the corridor (corridors run along x or z); a 1-tile corridor: along z
  const perp = dx !== 0 ? { x: 0, z: 1 } : dz !== 0 ? { x: 1, z: 0 } : { x: 0, z: 1 };
  // the grey path tile the corridor joins, and the point mirrored across it
  let mirror = { x: start.x, z: start.z };
  for (const [ax, az] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const px = start.x + ax,
      pz = start.z + az;
    if (corridor.some((t) => t.x === px && t.z === pz)) continue;
    if (w.isPath(px, pz)) {
      mirror = { x: px + ax, z: pz + az };
      break;
    }
  }
  return { start, end, perp, mirror };
}

/** The yellow marker for a step (tutorial.md §3, §7), or null when there is none to show. */
export function hintFor(step: StepId, sim: ISimulation, c: HintContext, gap: SimFacts['gap']): WorldHint | null {
  const w = sim.world;
  const ps = sim as PlotSim;
  const home = homeOf(sim, c);
  switch (step) {
    case 'fence':
      if (c.regressed && gap) return { kind: 'edges', edges: gap.edges };
      return c.plot ? { kind: 'box', rect: c.plot } : null;
    case 'paint': {
      const r = habitatRect(w, home);
      return r ? { kind: 'box', rect: inset(r, 1) } : null;
    }
    case 'water':
      return home ? spotHint(spotInside(ps, home, 'water_trough', 'near-path')) : null;
    case 'shelter':
      return home ? spotHint(spotInside(ps, home, 'shelter_wood', 'far')) : null;
    case 'plant':
      return home ? spotHint(spotInside(ps, home, 'grass_tall', 'corner')) : null;
    case 'adopt': {
      const t = home ? adoptSpot(ps, home, c.speciesId ?? 'zebra') : null;
      return t ? { kind: 'spot', spot: { tx: t.x, tz: t.z, rot: 0, w: 1, d: 1 } } : null;
    }
    case 'happy': {
      const a = sim.animals.get(c.animalId) ?? sim.animals.values().next().value;
      return a ? { kind: 'animal', id: a.id, x: a.x, z: a.z } : null;
    }
    case 'path': {
      const t = home ? pathHintHabitat(w, home) : null;
      return t && t.length ? { kind: 'tiles', tiles: t } : null;
    }
    case 'kiosk':
    case 'bench':
    case 'bin': {
      const n = corridorNear(sim, home, c.corridor);
      if (!n) return null;
      if (step === 'kiosk') return spotHint(spotBesidePath(ps, 'shop_snack', n.mirror));
      if (step === 'bench') return spotHint(spotBesidePath(ps, 'bench', { x: n.start.x - n.perp.x, z: n.start.z - n.perp.z }));
      return spotHint(spotBesidePath(ps, 'bin', { x: n.end.x + n.perp.x, z: n.end.z + n.perp.z }));
    }
    case 'keeper': {
      const t = home ? keeperTile(ps, home, c.corridor) : null;
      return t ? { kind: 'tiles', tiles: [t] } : null;
    }
    case 'guests':
      return { kind: 'point', x: GATE_SPOT.x, z: GATE_SPOT.z - 3, r: 3 };
    default:
      return null;
  }
}

/** World-space rect (metres) of a hint, for camera framing and the e2e. */
export function hintBounds(h: WorldHint): { x0: number; z0: number; x1: number; z1: number } {
  switch (h.kind) {
    case 'box':
      return { x0: h.rect.x0 * TILE, z0: h.rect.z0 * TILE, x1: (h.rect.x1 + 1) * TILE, z1: (h.rect.z1 + 1) * TILE };
    case 'spot':
      return { x0: h.spot.tx * TILE, z0: h.spot.tz * TILE, x1: (h.spot.tx + h.spot.w) * TILE, z1: (h.spot.tz + h.spot.d) * TILE };
    case 'tiles': {
      const xs = h.tiles.map((t) => t.x),
        zs = h.tiles.map((t) => t.z);
      return { x0: Math.min(...xs) * TILE, z0: Math.min(...zs) * TILE, x1: (Math.max(...xs) + 1) * TILE, z1: (Math.max(...zs) + 1) * TILE };
    }
    case 'edges': {
      let x0 = Infinity,
        z0 = Infinity,
        x1 = -Infinity,
        z1 = -Infinity;
      for (const e of h.edges) {
        x0 = Math.min(x0, e.x * TILE);
        z0 = Math.min(z0, e.z * TILE);
        x1 = Math.max(x1, (e.x + (e.dir === 'h' ? 1 : 0)) * TILE);
        z1 = Math.max(z1, (e.z + (e.dir === 'v' ? 1 : 0)) * TILE);
      }
      return { x0, z0, x1, z1 };
    }
    case 'animal':
      return { x0: h.x - 1.5, z0: h.z - 1.5, x1: h.x + 1.5, z1: h.z + 1.5 };
    case 'point':
      return { x0: h.x - h.r, z0: h.z - h.r, x1: h.x + h.r, z1: h.z + h.r };
  }
}
