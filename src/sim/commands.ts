// Player commands: validate (via World helpers), price (from the data
// catalogues), charge, mutate and report. Every command supports dryRun for
// ghost previews: nothing changes and the result carries cost / validity.

import { ENTRANCE_TILE, MAP_H, MAP_W, TILE } from '../core/constants';
import type { TileRect } from '../core/events';
import { PathType, Terrain, isWater, type CommandResult, type StaffRole } from '../core/types';
import type { EdgeRef } from '../core/world';
import { FENCES_BY_ID, PATHS_BY_TYPE } from '../data/fences';
import { OBJECTS_BY_ID, rotatedSize } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import { evaluateSpecies, weakestFenceName } from './habitat';
import { STAFF_SALARY, STAFF_TITLE } from './names';

/** Price to repaint one tile with `terrain` (0 for unknown terrain). */
export function terrainCost(terrain: Terrain): number {
  return TERRAIN_COST[terrain] ?? 0;
}
/** Daily wage of a staff role (0 for an unknown role). */
export function staffWage(role: StaffRole): number {
  return STAFF_SALARY[role] ?? 0;
}
import type { Simulation } from './simulation';

/** Price per tile to repaint terrain (index = Terrain). Water is dug out, snow and rock are imported. */
export const TERRAIN_COST: readonly number[] = [
  4, // Grass
  4, // DryGrass
  3, // Dirt
  5, // Sand
  6, // Rock
  7, // Snow
  4, // Mud
  12, // Water
  18, // DeepWater
];
export const REFUND_FRACTION = 0.4;
/** Longest habitat name (characters). */
export const MAX_HABITAT_NAME = 32;
export const SELL_FRACTION = 0.5;

const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;

export class Commands {
  /** Wall-clock throttle for failure toasts while dragging tools. */
  private lastFail = new Map<string, number>();

  constructor(private sim: Simulation) {}

  // ------------------------------------------------------------ helpers
  private result(ok: boolean, cost: number, reason: string | undefined, dryRun: boolean, at?: { x: number; z: number }): CommandResult {
    const r: CommandResult = reason ? { ok, cost, reason } : { ok, cost };
    if (!dryRun) {
      this.sim.events.emit('commandResult', at ? { ...r, x: at.x, z: at.z } : { ...r });
      if (!ok && reason) this.toastFail(reason, at);
      else if (ok && reason) this.sim.notify(null, reason, 'warn', at);
      this.sim.flushMoney();
    }
    return r;
  }

  private toastFail(reason: string, at?: { x: number; z: number }) {
    const now = Date.now();
    const last = this.lastFail.get(reason) ?? 0;
    if (now - last < 2500) return;
    this.lastFail.set(reason, now);
    this.sim.notify(null, reason, 'warn', at);
  }

  private noMoney(cost: number): string {
    return this.sim.money < 0
      ? `Your zoo is in debt — earn money before building (needs ${money(cost)})`
      : `Not enough money (needs ${money(cost)}, you have ${money(this.sim.money)})`;
  }

  private rectCentre(r: TileRect) {
    return { x: ((r.x0 + r.x1 + 1) / 2) * TILE, z: ((r.z0 + r.z1 + 1) / 2) * TILE };
  }

  /** Natural scenery that paths may clear (not buildings, not habitat furniture). */
  private isNatural(defId: string): boolean {
    const c = OBJECTS_BY_ID[defId]?.category;
    return c === 'tree' || c === 'plant' || c === 'rock';
  }

  /** Entrance plaza tiles are protected from removal so guests can always get in. */
  private isProtectedPath(x: number, z: number): boolean {
    return Math.abs(x - ENTRANCE_TILE.x) <= 2 && z >= ENTRANCE_TILE.z - 2 && z <= ENTRANCE_TILE.z;
  }

  // ------------------------------------------------------------ terrain
  paintTerrain(rect: TileRect, terrain: Terrain, dryRun = false): CommandResult {
    const w = this.sim.world;
    if (!(terrain >= Terrain.Grass && terrain <= Terrain.DeepWater)) return this.result(false, 0, 'Unknown terrain', dryRun);
    const r = w.clampRect(rect);
    const at = this.rectCentre(r);
    const water = isWater(terrain);
    let count = 0;
    let blocked = 0;
    let blockReason = '';
    const allowed = (x: number, z: number): boolean => {
      const i = w.idx(x, z);
      if (w.terrain[i] === terrain) return false;
      if (water) {
        if (w.path[i]) {
          blockReason = 'Cannot flood path tiles';
          return false;
        }
        const o = w.objectAt(x, z);
        if (o && !(o.defId === 'reeds' && terrain === Terrain.Water)) {
          blockReason = 'Cannot flood under objects';
          return false;
        }
      }
      return true;
    };
    for (let z = r.z0; z <= r.z1; z++)
      for (let x = r.x0; x <= r.x1; x++) {
        if (allowed(x, z)) count++;
        else if (w.terrain[w.idx(x, z)] !== terrain) blocked++;
      }
    const cost = count * terrainCost(terrain);
    if (count === 0) return this.result(false, 0, blocked ? blockReason : 'Already that terrain', dryRun, at);
    if (!this.sim.canAfford(cost)) return this.result(false, cost, this.noMoney(cost), dryRun, at);
    if (dryRun) return this.result(true, cost, blocked ? `${blocked} tile(s) skipped: ${blockReason}` : undefined, true, at);
    w.setTerrainRect(r, terrain, allowed);
    this.sim.spend('construction', cost);
    return this.result(true, cost, undefined, false, at);
  }

  // -------------------------------------------------------------- paths
  placePaths(tiles: { x: number; z: number }[], type: PathType, dryRun = false): CommandResult {
    const w = this.sim.world;
    const def = PATHS_BY_TYPE[type];
    if (!def) return this.result(false, 0, 'Unknown path type', dryRun);
    const seen = new Set<number>();
    const todo: { x: number; z: number }[] = [];
    const clear = new Set<number>();
    let firstReason = '';
    for (const t of tiles) {
      if (!w.inBounds(t.x, t.z)) {
        firstReason ||= 'Out of bounds';
        continue;
      }
      const i = w.idx(t.x, t.z);
      if (seen.has(i)) continue;
      seen.add(i);
      if (w.path[i] === type) continue;
      let why = w.canPlacePath(t.x, t.z, type);
      if (why && !w.habitatOf[i]) {
        // wild trees, plants and rocks are cleared to make way for the path
        const o = w.objectAt(t.x, t.z);
        if (o && this.isNatural(o.defId)) {
          clear.add(o.id);
          why = null;
          if (isWater(w.terrain[i] as Terrain) && type !== PathType.Boardwalk) why = 'Only boardwalks can cross water';
        }
      }
      if (why) {
        firstReason ||= why;
        continue;
      }
      todo.push(t);
    }
    const at = tiles.length ? { x: (tiles[0].x + 0.5) * TILE, z: (tiles[0].z + 0.5) * TILE } : undefined;
    if (!todo.length) return this.result(false, 0, firstReason || 'Path already there', dryRun, at);
    const cost = todo.length * def.costPerTile;
    if (!this.sim.canAfford(cost)) return this.result(false, cost, this.noMoney(cost), dryRun, at);
    const note = clear.size ? `Clears ${clear.size} tree${clear.size > 1 ? 's' : ''}/plant${clear.size > 1 ? 's' : ''} in the way` : undefined;
    if (dryRun) return this.result(true, cost, note, true, at);
    for (const id of clear) w.removeObject(id);
    for (const t of todo) w.setPath(t.x, t.z, type);
    // viewing tiles next to habitats depend on paths
    w.refreshHabitatStats();
    this.sim.spend('construction', cost);
    return this.result(true, cost, undefined, false, at);
  }

  // ------------------------------------------------------------- fences
  private edgeTiles(e: EdgeRef): [number, number, number, number] {
    return e.dir === 'h' ? [e.x, e.z - 1, e.x, e.z] : [e.x - 1, e.z, e.x, e.z];
  }

  private fenceBlocked(e: EdgeRef): string | null {
    const w = this.sim.world;
    const [ax, az, bx, bz] = this.edgeTiles(e);
    const aIn = w.inBounds(ax, az),
      bIn = w.inBounds(bx, bz);
    if (aIn && bIn && w.isPath(ax, az) && w.isPath(bx, bz)) return 'Fences cannot cross paths';
    if (aIn && bIn) {
      const oa = w.objectGrid[w.idx(ax, az)];
      if (oa && oa === w.objectGrid[w.idx(bx, bz)]) return 'A fence would cut through an object';
    }
    return null;
  }

  placeFences(edges: EdgeRef[], fenceId: number, dryRun = false): CommandResult {
    const w = this.sim.world;
    const def = FENCES_BY_ID[fenceId];
    if (!def) return this.result(false, 0, 'Unknown fence type', dryRun);
    const seen = new Set<string>();
    const todo: EdgeRef[] = [];
    let cost = 0;
    let firstReason = '';
    for (const e of edges) {
      if (!w.edgeInBounds(e)) continue;
      const k = `${e.dir}${e.x},${e.z}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = w.getFence(e);
      if (cur === fenceId) continue;
      const why = this.fenceBlocked(e);
      if (why) {
        firstReason ||= why;
        continue;
      }
      cost += def.costPerSegment;
      if (cur) cost -= Math.round((FENCES_BY_ID[cur]?.costPerSegment ?? 0) * REFUND_FRACTION);
      todo.push(e);
    }
    const at = edges.length ? this.edgeCentre(edges[Math.floor(edges.length / 2)]) : undefined;
    if (!todo.length) return this.result(false, 0, firstReason || 'Fence already there', dryRun, at);
    if (!this.sim.canAfford(cost)) return this.result(false, cost, this.noMoney(cost), dryRun, at);
    if (dryRun) return this.result(true, cost, firstReason ? `Some segments skipped: ${firstReason}` : undefined, true, at);
    for (const e of todo) w.setFence(e, fenceId, false);
    w.recomputeHabitats();
    this.sim.spend('construction', cost);
    this.sim.markPopulationDirty();
    return this.result(true, cost, undefined, false, at);
  }

  private edgeCentre(e: EdgeRef) {
    return e.dir === 'h' ? { x: (e.x + 0.5) * TILE, z: e.z * TILE } : { x: e.x * TILE, z: (e.z + 0.5) * TILE };
  }

  removeFences(edges: EdgeRef[], dryRun = false): CommandResult {
    const w = this.sim.world;
    const seen = new Set<string>();
    const todo: EdgeRef[] = [];
    let refund = 0;
    for (const e of edges) {
      if (!w.edgeInBounds(e)) continue;
      const k = `${e.dir}${e.x},${e.z}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = w.getFence(e);
      if (!cur) continue;
      refund += Math.round((FENCES_BY_ID[cur]?.costPerSegment ?? 0) * REFUND_FRACTION);
      todo.push(e);
    }
    const at = edges.length ? this.edgeCentre(edges[0]) : undefined;
    if (!todo.length) return this.result(false, 0, 'No fence to remove', dryRun, at);
    if (dryRun) return this.result(true, -refund, undefined, true, at);
    for (const e of todo) w.setFence(e, 0, false);
    w.recomputeHabitats();
    this.sim.spend('construction', -refund);
    this.sim.markPopulationDirty();
    return this.result(true, -refund, undefined, false, at);
  }

  // ------------------------------------------------------------ objects
  placeObject(defId: string, tx: number, tz: number, rot: number, dryRun = false): CommandResult {
    const w = this.sim.world;
    const def = OBJECTS_BY_ID[defId];
    const at = { x: (tx + 0.5) * TILE, z: (tz + 0.5) * TILE };
    if (!def) return this.result(false, 0, 'Unknown object', dryRun, at);
    if (def.notBuildable) return this.result(false, 0, `${def.name} cannot be built`, dryRun, at);
    let r = ((Math.round(rot) % 4) + 4) % 4;
    const why = w.canPlaceObject(def, tx, tz, r);
    if (!why && (def.shop || def.restroom)) r = this.faceThePath(defId, tx, tz, r);
    if (why) return this.result(false, def.cost, why, dryRun, at);
    // keep animals from being buried under solid objects
    if (def.solid) {
      for (const t of w.footprint({ defId, tx, tz, rot: r })) {
        for (const a of this.sim.animals.values()) {
          const ax = Math.floor(a.x / TILE),
            az = Math.floor(a.z / TILE);
          if (ax === t.x && az === t.z) return this.result(false, def.cost, 'An animal is standing there', dryRun, at);
        }
      }
    }
    if (!this.sim.canAfford(def.cost)) return this.result(false, def.cost, this.noMoney(def.cost), dryRun, at);
    if (dryRun) return this.result(true, def.cost, undefined, true, at);
    const o = w.addObject(defId, tx, tz, r, this.sim.rng.int(0, 0x7fffffff));
    this.sim.spend('construction', def.cost);
    const c = w.objectCenter(o);
    return this.result(true, def.cost, undefined, false, { x: c.x, z: c.z });
  }

  /**
   * Shops and restrooms serve guests from their front (+Z of the model). If the
   * requested rotation leaves the front facing away from every path, turn the
   * building (same footprint) so its counter / doors open onto a path.
   */
  private faceThePath(defId: string, tx: number, tz: number, rot: number): number {
    const w = this.sim.world;
    const def = OBJECTS_BY_ID[defId];
    const opens = (r: number): boolean => {
      const [fw, fd] = rotatedSize(def, r);
      const [ow, od] = rotatedSize(def, rot);
      if (fw !== ow || fd !== od) return false; // footprint must stay the same
      // tiles just beyond the front edge, front = (sin θ, cos θ) with θ = r·π/2
      const fx = [0, 1, 0, -1][r],
        fz = [1, 0, -1, 0][r];
      for (let i = 0; i < (fx ? fd : fw); i++) {
        const x = fx > 0 ? tx + fw : fx < 0 ? tx - 1 : tx + i;
        const z = fz > 0 ? tz + fd : fz < 0 ? tz - 1 : tz + i;
        if (!w.inBounds(x, z) || !w.isPath(x, z) || w.habitatOf[w.idx(x, z)]) continue;
        const ax = Math.min(Math.max(x, tx), tx + fw - 1),
          az = Math.min(Math.max(z, tz), tz + fd - 1);
        if (!w.fenceBetween(ax, az, x, z)) return true;
      }
      return false;
    };
    if (opens(rot)) return rot;
    for (const d of [1, 3, 2]) {
      const r = (rot + d) % 4;
      if (opens(r)) return r;
    }
    return rot;
  }

  /** Remove one placed object (partial refund); fences, paths and litter stay. */
  removeObject(objectId: number, dryRun = false): CommandResult {
    const sim = this.sim;
    const w = sim.world;
    const o = w.objects.get(objectId);
    if (!o) return this.result(false, 0, 'Nothing to remove', dryRun);
    const c = w.objectCenter(o);
    const at = { x: c.x, z: c.z };
    if (o.defId === 'entrance_gate') return this.result(false, 0, 'The entrance cannot be removed', dryRun, at);
    const refund = Math.round((OBJECTS_BY_ID[o.defId]?.cost ?? 0) * REFUND_FRACTION);
    if (dryRun) return this.result(true, -refund, undefined, true, at);
    // guests queueing at / sitting on / walking to it change their plans first
    sim.guestSys.releaseObject(objectId);
    w.removeObject(objectId); // emits objectRemoved + habitatsChanged (habitat stats refreshed)
    if (refund) sim.spend('construction', -refund);
    sim.markPopulationDirty();
    return this.result(true, -refund, undefined, false, at);
  }

  /** Rename a habitat: control characters stripped, whitespace collapsed, max MAX_HABITAT_NAME chars. */
  renameHabitat(habitatId: number, name: string): CommandResult {
    const w = this.sim.world;
    const hab = w.habitats.get(habitatId);
    if (!hab) return this.result(false, 0, 'No such habitat', false);
    const at = { x: ((hab.minX + hab.maxX + 1) / 2) * TILE, z: ((hab.minZ + hab.maxZ + 1) / 2) * TILE };
    // eslint-disable-next-line no-control-regex
    const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return this.result(false, 0, 'Please enter a name', false, at);
    const chars = Array.from(clean); // keep surrogate pairs (emoji) intact
    const n = chars.length > MAX_HABITAT_NAME ? chars.slice(0, MAX_HABITAT_NAME).join('').trimEnd() : clean;
    if (n !== hab.name) w.renameHabitat(habitatId, n); // emits habitatsChanged
    return this.result(true, 0, undefined, false, at);
  }

  // ----------------------------------------------------------- bulldoze
  bulldoze(rect: TileRect, dryRun = false): CommandResult {
    const w = this.sim.world;
    const r = w.clampRect(rect);
    const at = this.rectCentre(r);
    let refund = 0;
    const objs = new Set<number>();
    let protectedHit = false;
    for (let z = r.z0; z <= r.z1; z++)
      for (let x = r.x0; x <= r.x1; x++) {
        const o = w.objectAt(x, z);
        if (!o || objs.has(o.id)) continue;
        if (o.defId === 'entrance_gate') {
          protectedHit = true;
          continue;
        }
        objs.add(o.id);
        refund += Math.round((OBJECTS_BY_ID[o.defId]?.cost ?? 0) * REFUND_FRACTION);
      }
    const paths: { x: number; z: number }[] = [];
    for (let z = r.z0; z <= r.z1; z++)
      for (let x = r.x0; x <= r.x1; x++) {
        const p = w.getPath(x, z);
        if (!p) continue;
        if (this.isProtectedPath(x, z)) {
          protectedHit = true;
          continue;
        }
        paths.push({ x, z });
        refund += Math.round((PATHS_BY_TYPE[p]?.costPerTile ?? 0) * REFUND_FRACTION);
      }
    const fences: EdgeRef[] = [];
    for (let z = r.z0; z <= r.z1 + 1; z++)
      for (let x = r.x0; x <= r.x1; x++) {
        const e: EdgeRef = { dir: 'h', x, z };
        const f = w.getFence(e);
        if (f) {
          fences.push(e);
          refund += Math.round((FENCES_BY_ID[f]?.costPerSegment ?? 0) * REFUND_FRACTION);
        }
      }
    for (let z = r.z0; z <= r.z1; z++)
      for (let x = r.x0; x <= r.x1 + 1; x++) {
        const e: EdgeRef = { dir: 'v', x, z };
        const f = w.getFence(e);
        if (f) {
          fences.push(e);
          refund += Math.round((FENCES_BY_ID[f]?.costPerSegment ?? 0) * REFUND_FRACTION);
        }
      }
    const trash: number[] = [];
    for (const l of this.sim.litter.values()) {
      const tx = Math.floor(l.x / TILE),
        tz = Math.floor(l.z / TILE);
      if (tx >= r.x0 && tx <= r.x1 && tz >= r.z0 && tz <= r.z1) trash.push(l.id);
    }
    if (!objs.size && !paths.length && !fences.length && !trash.length)
      return this.result(false, 0, protectedHit ? 'The entrance cannot be removed' : 'Nothing to remove here', dryRun, at);
    if (dryRun) return this.result(true, -refund, undefined, true, at);
    for (const id of objs) this.sim.guestSys.releaseObject(id);
    for (const id of objs) w.removeObject(id);
    for (const p of paths) w.setPath(p.x, p.z, PathType.None);
    for (const e of fences) w.setFence(e, 0, false);
    if (fences.length || paths.length) w.recomputeHabitats();
    for (const id of trash) this.sim.removeLitter(id);
    if (refund) this.sim.spend('construction', -refund);
    this.sim.markPopulationDirty();
    return this.result(true, -refund, undefined, false, at);
  }

  // ------------------------------------------------------------ animals
  buyAnimal(speciesId: string, wx: number, wz: number, dryRun = false): CommandResult {
    const sim = this.sim;
    const w = sim.world;
    const sp = SPECIES_BY_ID[speciesId];
    const at = { x: wx, z: wz };
    if (!sp) return this.result(false, 0, 'Unknown species', dryRun, at);
    const t = w.tileOfWorld(wx, wz);
    if (!w.inBounds(t.x, t.z)) return this.result(false, sp.cost, 'Out of bounds', dryRun, at);
    const hab = w.habitatAt(t.x, t.z);
    if (!hab) return this.result(false, sp.cost, 'Animals must be placed inside a fenced habitat', dryRun, at);
    if (w.isTileSolid(t.x, t.z)) return this.result(false, sp.cost, 'Something is in the way — pick an open spot', dryRun, at);
    if (w.getTerrain(t.x, t.z) === Terrain.DeepWater && !sp.swims) return this.result(false, sp.cost, `${sp.name}s can’t swim — place it on land`, dryRun, at);
    if (!sim.canAfford(sp.cost)) return this.result(false, sp.cost, this.noMoney(sp.cost), dryRun, at);
    // warnings (purchase still allowed)
    const warn: string[] = [];
    if (hab.minFenceStrength < sp.danger) warn.push(`the fence is too weak for a ${sp.name} (use ${weakestFenceName(sp.danger)})`);
    const ev = evaluateSpecies(w, hab, sp, sim.population(hab.id), sim.keeperCount(), true);
    if (ev.compat < 0.5) warn.push(ev.issues.find((i) => i.includes('predators')) ?? 'it does not get along with the other animals here');
    else if (ev.score < 0.45) warn.push(`this habitat suits it poorly (${Math.round(ev.score * 100)}%): ${ev.issues[0] ?? ''}`);
    const reason = warn.length ? `Warning: ${warn.join('; ')}` : undefined;
    if (dryRun) return this.result(true, sp.cost, reason, true, at);
    const a = sim.animalSys.create(speciesId, wx, wz, { adult: true });
    sim.spend('animalPurchases', sp.cost);
    sim.events.emit('animalAdded', { id: a.id });
    sim.markPopulationDirty();
    return this.result(true, sp.cost, reason, false, at);
  }

  sellAnimal(animalId: number): CommandResult {
    const sim = this.sim;
    const a = sim.animals.get(animalId);
    if (!a) return this.result(false, 0, 'No such animal', false);
    const sp = SPECIES_BY_ID[a.speciesId];
    const value = Math.round((sp?.cost ?? 0) * SELL_FRACTION * (0.4 + 0.6 * a.growth) * (0.5 + 0.5 * a.health));
    sim.animalSys.remove(animalId);
    sim.spend('animalPurchases', -value);
    sim.notify(null, `${a.name} the ${sp?.name ?? 'animal'} was sold to another zoo for ${money(value)}.`, 'info', { x: a.x, z: a.z });
    return this.result(true, -value, undefined, false, { x: a.x, z: a.z });
  }

  // -------------------------------------------------------------- staff
  hireStaff(role: StaffRole, wx: number, wz: number, dryRun = false): CommandResult {
    const sim = this.sim;
    const w = sim.world;
    const at = { x: wx, z: wz };
    const salary = STAFF_SALARY[role];
    if (!salary) return this.result(false, 0, 'Unknown staff role', dryRun, at);
    const t = w.tileOfWorld(wx, wz);
    const tx = Math.max(0, Math.min(MAP_W - 1, t.x)),
      tz = Math.max(0, Math.min(MAP_H - 1, t.z));
    sim.nav.sync();
    const tile = sim.nav.nearestPathTile(tx, tz, 4);
    if (tile < 0) return this.result(false, salary, `${STAFF_TITLE[role]}s must be placed on a path`, dryRun, at);
    if (!sim.canAfford(salary)) return this.result(false, salary, this.noMoney(salary), dryRun, at);
    if (dryRun) return this.result(true, salary, undefined, true, at);
    const s = sim.staffSys.create(role, tile);
    sim.spend('salaries', salary); // recruitment: first day's wage up front
    sim.events.emit('staffAdded', { id: s.id });
    sim.markPopulationDirty();
    sim.notify(null, `${s.name} joined as ${role === 'keeper' ? 'a keeper' : role === 'vet' ? 'a vet' : 'a groundskeeper'} (${money(salary)}/day).`, 'good', { x: s.x, z: s.z });
    return this.result(true, salary, undefined, false, { x: s.x, z: s.z });
  }

  fireStaff(staffId: number): CommandResult {
    const sim = this.sim;
    const s = sim.staff.get(staffId);
    if (!s) return this.result(false, 0, 'No such staff member', false);
    sim.staff.delete(staffId);
    sim.events.emit('staffRemoved', { id: staffId });
    sim.markPopulationDirty();
    sim.notify(null, `${s.name} has left the zoo.`, 'info');
    return this.result(true, 0, undefined, false, { x: s.x, z: s.z });
  }
}
