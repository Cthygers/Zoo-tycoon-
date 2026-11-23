// Memory of opened enclosures. When a fence is removed the World drops the
// habitat at once (its tiles become public). The Simulation keeps the old
// footprint, name and id here so that:
//  - its animals linger in the old footprint instead of counting as escaped
//    straight away (they get out only by wandering through the gap);
//  - closing the gap again gives the new habitat the old name, and the animals'
//    home moves to it, so strays can still be brought back;
//  - references to a vanished habitat id (animal homes, staff jobs) are cleared,
//    so they can never point at some later habitat;
//  - keepers still feed (and water) the animals lingering in it, from the paths
//    beside the old footprint.

import { MAP_W } from '../core/constants';
import { Terrain, type Habitat } from '../core/types';
import { N_TILES } from './nav';
import type { Simulation } from './simulation';
import type { AnimalSim } from './state';

/** A habitat whose fence was opened (its tiles are public now). */
export interface OpenEnclosure {
  id: number;
  name: string;
  /** Tile indices of the old habitat. */
  tiles: number[];
  /** Simulated time (s) when the fence was opened. */
  openedAt: number;
  /** Food a keeper left for the animals lingering in it (hunger units, like HabitatRuntime.food). */
  food: number;
  /** Water a keeper left in a tub, for a footprint without a pond or trough (thirst units). */
  water: number;
  /** Where the keeper left them (world metres, -1 = nowhere yet). */
  spotX: number;
  spotZ: number;
}

/** Save form: tiles as sorted runs [start, length, start, length, ...]. */
export interface OpenEnclosureSave {
  id: number;
  name: string;
  runs: number[];
  openedAt: number;
  food?: number;
  water?: number;
  spotX?: number;
  spotZ?: number;
}

/** Drinking spots left inside an opened enclosure's footprint. */
export interface FootprintWater {
  /** Land tiles at the water's edge. */
  edge: number[];
  /** Water trough object ids. */
  troughs: number[];
}

const DX = [1, -1, 0, 0];
const DZ = [0, 0, 1, -1];

/** Opened enclosures remembered at most (oldest are forgotten first). */
const MAX_OPEN = 8;

export class EnclosureMemory {
  /** Opened enclosures, oldest first. */
  readonly open: OpenEnclosure[] = [];
  /** Id of the opened enclosure each public tile belonged to (0 = none). */
  readonly openOf = new Int32Array(N_TILES);
  /** The World's habitat map as last seen (replaced whenever habitats are recomputed). */
  private known: Map<number, Habitat>;

  constructor(private sim: Simulation) {
    this.known = sim.world.habitats;
  }

  find(id: number): OpenEnclosure | undefined {
    return id ? this.open.find((e) => e.id === id) : undefined;
  }

  /** Start over from the current world (new game / load), with saved enclosures if any. */
  reset(saved: OpenEnclosureSave[] = []) {
    this.known = this.sim.world.habitats;
    this.open.length = 0;
    for (const s of saved) {
      if (!s || !s.id || this.sim.world.habitats.has(s.id) || !Array.isArray(s.runs)) continue;
      this.open.push({
        id: s.id,
        name: String(s.name ?? ''),
        tiles: decodeRuns(s.runs),
        openedAt: s.openedAt ?? this.sim.time,
        food: s.food ?? 0,
        water: s.water ?? 0,
        spotX: s.spotX ?? -1,
        spotZ: s.spotZ ?? -1,
      });
    }
    this.rebuildMask();
  }

  serialize(): OpenEnclosureSave[] {
    return this.open.map((e) => ({
      id: e.id,
      name: e.name,
      runs: encodeRuns(e.tiles),
      openedAt: e.openedAt,
      food: Math.round(e.food * 100) / 100,
      water: Math.round(e.water * 100) / 100,
      spotX: Math.round(e.spotX * 100) / 100,
      spotZ: Math.round(e.spotZ * 100) / 100,
    }));
  }

  /** Animals still lingering in the old footprint (their home, not loose yet). */
  residents(enc: OpenEnclosure): AnimalSim[] {
    const out: AnimalSim[] = [];
    for (const a of this.sim.animals.values()) if (a.home === enc.id && !a.escaped && !a.habitatId) out.push(a);
    return out;
  }

  /** Path tiles within two steps of the old footprint: where a keeper can stand to service it. */
  serviceTiles(enc: OpenEnclosure, out: number[]): void {
    const w = this.sim.world;
    for (const t of enc.tiles) {
      if (this.openOf[t] !== enc.id) continue;
      const x = t % MAP_W,
        z = (t / MAP_W) | 0;
      for (let k = 0; k < 4; k++)
        for (let st = 1; st <= 2; st++) {
          const nx = x + DX[k] * st,
            nz = z + DZ[k] * st;
          if (w.inBounds(nx, nz) && w.path[w.idx(nx, nz)] && this.openOf[w.idx(nx, nz)] !== enc.id) out.push(w.idx(nx, nz));
        }
    }
  }

  /** The pond edges and troughs still inside the old footprint. */
  footprintWater(enc: OpenEnclosure): FootprintWater {
    const w = this.sim.world;
    const water = (i: number) => w.terrain[i] === Terrain.Water || w.terrain[i] === Terrain.DeepWater;
    const res: FootprintWater = { edge: [], troughs: [] };
    for (const t of enc.tiles) {
      if (this.openOf[t] !== enc.id) continue;
      const oid = w.objectGrid[t];
      if (oid && w.objects.get(oid)?.defId === 'water_trough' && !res.troughs.includes(oid)) res.troughs.push(oid);
      if (water(t)) continue;
      const x = t % MAP_W,
        z = (t / MAP_W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k],
          nz = z + DZ[k];
        if (!w.inBounds(nx, nz)) continue;
        const n = w.idx(nx, nz);
        if (this.openOf[n] === enc.id && water(n) && !w.fenceBetween(x, z, nx, nz)) {
          res.edge.push(t);
          break;
        }
      }
    }
    return res;
  }

  /** After World.recomputeHabitats: note vanished habitats and give re-closed ones their old identity. */
  onHabitatsChanged() {
    const w = this.sim.world;
    const before = this.known;
    if (w.habitats === before) return; // stats refresh or rename only
    this.known = w.habitats;
    for (const [id, hab] of before) {
      if (w.habitats.has(id)) continue;
      // opened (mostly public now) rather than merged into a neighbour
      let publicTiles = 0;
      for (const t of hab.tiles) if (!w.habitatOf[t]) publicTiles++;
      const opened = publicTiles * 2 > hab.tiles.length;
      this.sim.forgetHabitat(id, opened);
      // what the keeper left in the habitat stays where it was
      const rt = this.sim.habRt.get(id);
      if (opened)
        this.open.push({ id, name: hab.name, tiles: hab.tiles, openedAt: this.sim.time, food: rt?.food ?? 0, water: 0, spotX: rt?.spotX ?? -1, spotZ: rt?.spotZ ?? -1 });
    }
    while (this.open.length > MAX_OPEN) this.sim.forgetHabitat(this.open.shift()!.id, false);
    for (const [id, hab] of w.habitats) {
      if (before.has(id)) continue;
      const enc = this.bestMatch(hab);
      if (!enc) continue;
      this.open.splice(this.open.indexOf(enc), 1);
      this.sim.rehomeHabitat(enc.id, id);
      if (enc.name && hab.name !== enc.name) w.renameHabitat(id, enc.name);
    }
    this.rebuildMask();
  }

  /** The opened enclosure a new habitat re-closes: it must cover most of the old footprint. */
  private bestMatch(hab: Habitat): OpenEnclosure | undefined {
    const w = this.sim.world;
    let best: OpenEnclosure | undefined;
    let bestOverlap = 0;
    for (const enc of this.open) {
      let overlap = 0;
      for (const t of enc.tiles) if (w.habitatOf[t] === hab.id) overlap++;
      if (overlap * 2 > enc.tiles.length && overlap > bestOverlap) {
        best = enc;
        bestOverlap = overlap;
      }
    }
    return best;
  }

  private rebuildMask() {
    const w = this.sim.world;
    this.openOf.fill(0);
    for (const enc of this.open) for (const t of enc.tiles) if (!w.habitatOf[t]) this.openOf[t] = enc.id;
  }
}

function encodeRuns(tiles: number[]): number[] {
  const sorted = tiles.slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < sorted.length; ) {
    let n = 1;
    while (i + n < sorted.length && sorted[i + n] === sorted[i] + n) n++;
    out.push(sorted[i], n);
    i += n;
  }
  return out;
}

function decodeRuns(runs: number[]): number[] {
  const out: number[] = [];
  for (let k = 0; k + 1 < runs.length; k += 2) {
    const start = runs[k] | 0,
      n = runs[k + 1] | 0;
    for (let j = 0; j < n; j++) if (start + j >= 0 && start + j < N_TILES) out.push(start + j);
  }
  return out;
}
