// Staff AI. Keepers feed habitats and clean dung, groundskeepers pick up
// litter on the paths, vets treat sick animals and bring escaped ones home.
// Staff walk on the path network like guests and work from the fence line.

import { MAP_W, MINUTES_PER_DAY, TILE } from '../core/constants';
import type { StaffRole } from '../core/types';
import { OBJECTS_BY_ID } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import { foodScale } from './animals';
import type { OpenEnclosure } from './enclosures';
import { STAFF_SALARY, STAFF_TITLE, personName, staffAppearance, singularName } from './names';
import { FAR, N_TILES } from './nav';
import type { Simulation } from './simulation';
import type { AnimalSim, StaffSim } from './state';
import { approach, personY, standFacing, walkToNext } from './walker';

const DX = [1, -1, 0, 0];
const DZ = [0, 0, 1, -1];

/** Food (hunger units) a keeper leaves for one animal. */
function ration(a: AnimalSim): number {
  const sp = SPECIES_BY_ID[a.speciesId];
  return sp ? foodScale(sp) * (0.4 + 0.6 * a.growth) * 1.4 * 1.5 : 0;
}

/** Food stock a keeper leaves in a habitat (hunger units). */
export function foodCapacity(sim: Simulation, habId: number): number {
  const hab = sim.world.habitats.get(habId);
  if (!hab) return 0;
  let cap = 0;
  for (const a of sim.animals.values()) if (!a.escaped && a.habitatId === habId) cap += ration(a);
  if (cap <= 0) return 0;
  let feeder = false;
  for (const oid of hab.objects) {
    const o = sim.world.objects.get(oid);
    if (o && OBJECTS_BY_ID[o.defId]?.serves === 'food') feeder = true;
  }
  return Math.max(2, cap) * (feeder ? 1.5 : 1);
}

/** Food (and tub water) a keeper leaves for the animals lingering in an opened enclosure. */
export function enclosureCapacity(sim: Simulation, enc: OpenEnclosure): number {
  let cap = 0;
  for (const a of sim.enclosures.residents(enc)) cap += ration(a);
  return cap > 0 ? Math.max(2, cap) : 0;
}

function hasFeeder(sim: Simulation, habId: number): boolean {
  const hab = sim.world.habitats.get(habId);
  if (!hab) return false;
  for (const oid of hab.objects) {
    const o = sim.world.objects.get(oid);
    if (o && OBJECTS_BY_ID[o.defId]?.serves === 'food') return true;
  }
  return false;
}

export class StaffSystem {
  private scratch = new Uint16Array(N_TILES);
  private srcTmp: number[] = [];

  constructor(private sim: Simulation) {}

  create(role: StaffRole, tile: number): StaffSim {
    const sim = this.sim;
    const rng = sim.rng;
    const appearance = staffAppearance(rng, role);
    const id = sim.nextIds.staff++;
    const x = ((tile % MAP_W) + 0.5) * TILE,
      z = (((tile / MAP_W) | 0) + 0.5) * TILE;
    const s: StaffSim = {
      id,
      role,
      name: personName(rng, appearance.female),
      appearance,
      x,
      y: personY(sim.world, x, z),
      z,
      heading: rng.range(-Math.PI, Math.PI),
      speed: 0,
      action: 'idle',
      actionTime: 0,
      salary: STAFF_SALARY[role],
      task: 'Getting started',
      seed: rng.int(0, 0x7fffffff),
      tile,
      next: -1,
      prev: -1,
      lane: rng.range(0.25, 0.6),
      walkSpeed: rng.range(1.3, 1.5),
      phase: 0,
      ax: x,
      az: z,
      faceHeading: 0,
      goalKey: '',
      wanderSteps: 0,
      stuck: 0,
      job: 'none',
      jobRef: 0,
      timer: rng.range(0.5, 1.5),
      think: 0,
      noAccessWarned: false,
      payShare: (MINUTES_PER_DAY - sim.minuteOfDay) / MINUTES_PER_DAY,
    };
    sim.staff.set(id, s);
    return s;
  }

  update(dt: number) {
    const sim = this.sim;
    if (!sim.staff.size) return;
    sim.nav.sync();
    for (const s of sim.staff.values()) this.updateOne(s, dt);
  }

  private updateOne(s: StaffSim, dt: number) {
    const sim = this.sim;
    const prev = s.action;
    switch (s.phase) {
      case 0: {
        if (s.job === 'none') {
          s.action = 'idle';
          standFacing(s, s.heading, dt);
          s.timer -= dt;
          if (s.timer <= 0) this.think(s);
          break;
        }
        s.action = 'walk';
        if (s.next < 0 && !this.chooseNext(s)) break;
        if (s.next >= 0 && walkToNext(sim.world, s, dt, 1)) {
          if (s.job === 'patrol') s.wanderSteps--;
          this.chooseNext(s);
        }
        // recapture: keep an eye on the animal while walking
        if (s.job === 'recapture') this.checkRecapture(s);
        break;
      }
      case 1:
        s.action = 'walk';
        if (approach(sim.world, s, dt, 0.8)) {
          s.phase = 2;
          s.action = 'work';
        }
        break;
      case 2:
        s.action = 'work';
        standFacing(s, s.faceHeading, dt);
        s.timer -= dt;
        if (s.job === 'recapture') {
          const a = sim.animals.get(s.jobRef);
          if (a) s.faceHeading = Math.atan2(a.x - s.x, a.z - s.z);
        }
        if (s.timer <= 0) this.finishWork(s);
        break;
    }
    if (s.action !== prev) s.actionTime = 0;
    else s.actionTime += dt;
  }

  private chooseNext(s: StaffSim): boolean {
    const sim = this.sim;
    const nav = sim.nav;
    if (!sim.world.path[s.tile]) {
      const t = nav.nearestPathTile(Math.floor(s.x / TILE), Math.floor(s.z / TILE), 8);
      if (t < 0) {
        s.job = 'none';
        s.timer = 5;
        s.task = 'Stranded — needs a path';
        sim.notify(`stranded:${s.id}`, `${s.name} (${STAFF_TITLE[s.role]}) is stranded off the paths.`, 'warn', { x: s.x, z: s.z }, 300);
        return false;
      }
      s.tile = t;
      s.next = -1;
      s.ax = ((t % MAP_W) + 0.5) * TILE;
      s.az = (((t / MAP_W) | 0) + 0.5) * TILE;
      s.phase = 1;
      s.job = 'none';
      s.timer = 0.5;
      return false;
    }
    if (s.job === 'patrol') {
      if (s.wanderSteps <= 0) {
        s.job = 'none';
        s.timer = sim.rng.range(1, 3);
        return false;
      }
      s.next = nav.wanderStep(s.tile, s.prev, sim.rng.float());
      if (s.next < 0) {
        s.job = 'none';
        s.timer = 2;
        return false;
      }
      return true;
    }
    const f = sim.guestSys.field(s.goalKey);
    const d = f[s.tile];
    if (d === 0) {
      this.arrive(s);
      return false;
    }
    if (d === FAR) {
      s.job = 'none';
      s.timer = 1;
      return false;
    }
    s.next = nav.downhill(f, s.tile, s.seed);
    return s.next >= 0;
  }

  // ================================================================ jobs
  private think(s: StaffSim) {
    const sim = this.sim;
    s.next = -1;
    s.phase = 0;
    let found = false;
    if (s.role === 'vet') found = this.findLoose(s) || this.findSick(s);
    else if (s.role === 'keeper') found = this.findService(s) || (!this.hasVet() && this.findLoose(s));
    else found = this.findLitter(s);
    if (found) return;
    // nothing to do: stroll around
    s.job = 'patrol';
    s.goalKey = '';
    s.wanderSteps = sim.rng.int(4, 10);
    s.task = s.role === 'groundskeeper' ? 'Sweeping the paths' : 'Patrolling';
  }

  private hasVet(): boolean {
    for (const s of this.sim.staff.values()) if (s.role === 'vet') return true;
    return false;
  }

  private assigned(job: StaffSim['job'], ref: number, except: StaffSim): boolean {
    for (const o of this.sim.staff.values()) if (o !== except && o.job === job && o.jobRef === ref) return true;
    return false;
  }

  private findService(s: StaffSim): boolean {
    const sim = this.sim;
    let best = 0,
      bestScore = 0,
      blocked = 0;
    for (const hab of sim.world.habitats.values()) {
      const rt = sim.habitatRuntime(hab.id);
      if (!rt) continue;
      const cap = foodCapacity(sim, hab.id);
      const foodNeed = cap > 0 ? Math.max(0, 1 - rt.food / cap) : 0;
      const dung = sim.dungByHab.get(hab.id) ?? 0;
      const dungNeed = Math.min(1, dung / Math.max(2, hab.tiles.length * 0.04));
      const need = foodNeed * 1.2 + dungNeed * 0.8;
      if (need < 0.45 && !(cap > 0 && rt.food < cap * 0.3)) continue;
      if (this.assigned('service', hab.id, s)) continue;
      const d = sim.guestSys.distance(`hab:${hab.id}`, s.tile);
      if (d === FAR) {
        if (cap > 0) blocked++;
        continue;
      }
      const score = need / (1 + d / 30);
      if (score > bestScore) {
        bestScore = score;
        best = hab.id;
      }
    }
    // animals lingering in an opened enclosure still need feeding, and water when no pond or trough is left
    let bestOpen: OpenEnclosure | undefined;
    for (const enc of sim.enclosures.open) {
      const cap = enclosureCapacity(sim, enc);
      if (cap <= 0) continue;
      const foodNeed = Math.max(0, 1 - enc.food / cap);
      const own = sim.enclosures.footprintWater(enc);
      const waterNeed = own.edge.length || own.troughs.length ? 0 : Math.max(0, 1 - enc.water / cap);
      const need = Math.max(foodNeed, waterNeed) * 1.2;
      if (need < 0.45 || this.assigned('service', enc.id, s)) continue;
      const d = sim.guestSys.distance(`open:${enc.id}`, s.tile);
      if (d === FAR) {
        blocked++;
        continue;
      }
      const score = need / (1 + d / 30);
      if (score > bestScore) {
        bestScore = score;
        bestOpen = enc;
      }
    }
    if (bestOpen) {
      s.noAccessWarned = false;
      s.job = 'service';
      s.jobRef = bestOpen.id;
      s.goalKey = `open:${bestOpen.id}`;
      s.task = `Feeding the animals of ${bestOpen.name}`;
      return true;
    }
    if (!best) {
      if (blocked && !s.noAccessWarned) {
        s.noAccessWarned = true;
        sim.notify(
          `noaccess:${s.id}`,
          `${s.name} can’t reach a habitat that needs feeding — build a path along its fence.`,
          'warn',
          { x: s.x, z: s.z },
          300,
        );
      }
      return false;
    }
    s.noAccessWarned = false;
    const hab = sim.world.habitats.get(best)!;
    s.job = 'service';
    s.jobRef = best;
    s.goalKey = `hab:${best}`;
    s.task = `Feeding & cleaning ${hab.name}`;
    return true;
  }

  private findLitter(s: StaffSim): boolean {
    const sim = this.sim;
    let any = false;
    for (const l of sim.litter.values())
      if (l.kind === 'trash') {
        any = true;
        break;
      }
    if (!any) return false;
    const src = this.srcTmp;
    src.length = 0;
    src.push(s.tile);
    sim.nav.bfs(src, this.scratch);
    let bestTile = -1,
      bd = FAR;
    for (const l of sim.litter.values()) {
      if (l.kind !== 'trash') continue;
      const t = Math.floor(l.z / TILE) * MAP_W + Math.floor(l.x / TILE);
      if (this.scratch[t] === FAR) continue;
      // a pile is worth a few extra steps: guests notice heaps far more than single wrappers
      const d = this.scratch[t] - 3 * Math.min(4, sim.litterGrid[t] - 1);
      if (d >= bd) continue;
      if (this.assigned('litter', t, s)) continue;
      bd = d;
      bestTile = t;
    }
    if (bestTile < 0) return false;
    s.job = 'litter';
    s.jobRef = bestTile;
    s.goalKey = `t:${bestTile}`;
    s.task = 'Picking up litter';
    return true;
  }

  private findSick(s: StaffSim): boolean {
    const sim = this.sim;
    let best = 0,
      bestScore = 0;
    for (const a of sim.animals.values()) {
      if (a.escaped || !a.habitatId) continue;
      if (!a.sick && a.health > 0.7) continue;
      if (this.assigned('heal', a.habitatId, s)) continue;
      const d = sim.guestSys.distance(`hab:${a.habitatId}`, s.tile);
      if (d === FAR) continue;
      const score = (1.2 - a.health) / (1 + d / 30);
      if (score > bestScore) {
        bestScore = score;
        best = a.habitatId;
      }
    }
    if (!best) return false;
    s.job = 'heal';
    s.jobRef = best;
    s.goalKey = `hab:${best}`;
    s.task = `Treating animals in ${sim.world.habitats.get(best)?.name ?? 'a habitat'}`;
    return true;
  }

  private findLoose(s: StaffSim): boolean {
    const sim = this.sim;
    let best: AnimalSim | null = null,
      bestD = Infinity;
    for (const a of sim.animalSys.loose) {
      if (!sim.animals.has(a.id)) continue;
      if (this.assigned('recapture', a.id, s)) continue;
      if (!sim.animalSys.homeFor(a)) continue; // nowhere to take it yet (home fence open / no habitat)
      const d = (a.x - s.x) ** 2 + (a.z - s.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    if (!best) return false;
    const t = sim.nav.nearestPathTile(Math.floor(best.x / TILE), Math.floor(best.z / TILE), 10);
    if (t < 0) return false;
    if (sim.guestSys.distance(`t:${t}`, s.tile) === FAR) return false;
    s.job = 'recapture';
    s.jobRef = best.id;
    s.goalKey = `t:${t}`;
    s.task = `Catching ${best.name} the ${SPECIES_BY_ID[best.speciesId]?.name ?? 'animal'}`;
    return true;
  }

  private checkRecapture(s: StaffSim) {
    const sim = this.sim;
    const a = sim.animals.get(s.jobRef);
    if (!a || !a.escaped) {
      s.job = 'none';
      s.timer = 0.5;
      s.next = -1;
      return;
    }
    const d2 = (a.x - s.x) ** 2 + (a.z - s.z) ** 2;
    if (d2 < 6 * 6) {
      s.next = -1;
      s.phase = 2;
      s.timer = 3;
      s.faceHeading = Math.atan2(a.x - s.x, a.z - s.z);
    }
  }

  private arrive(s: StaffSim) {
    const sim = this.sim;
    const w = sim.world;
    const cx = ((s.tile % MAP_W) + 0.5) * TILE,
      cz = (((s.tile / MAP_W) | 0) + 0.5) * TILE;
    if (s.job === 'service' || s.job === 'heal') {
      const hab = w.habitats.get(s.jobRef);
      const enc = hab || s.job !== 'service' ? undefined : sim.enclosures.find(s.jobRef);
      if (!hab && !enc) {
        s.job = 'none';
        s.timer = 0.5;
        return;
      }
      // face the habitat (or the opened enclosure's old footprint) from the path
      const inside = (i: number) => (hab ? w.habitatOf[i] === hab.id : sim.enclosures.openOf[i] === s.jobRef);
      const x = s.tile % MAP_W,
        z = (s.tile / MAP_W) | 0;
      for (let k = 0; k < 4; k++)
        for (let st = 1; st <= 2; st++) {
          const nx = x + DX[k] * st,
            nz = z + DZ[k] * st;
          if (!w.inBounds(nx, nz) || !inside(nz * MAP_W + nx)) continue;
          s.ax = cx + DX[k] * 0.6;
          s.az = cz + DZ[k] * 0.6;
          s.faceHeading = Math.atan2(DX[k], DZ[k]);
          s.phase = 1;
          s.timer = s.job === 'heal' ? 5 : hab && hasFeeder(sim, hab.id) ? 3 : 5.5;
          return;
        }
      s.job = 'none';
      s.timer = 0.5;
      return;
    }
    if (s.job === 'litter') {
      s.ax = cx;
      s.az = cz;
      s.faceHeading = s.heading;
      s.phase = 1;
      s.timer = 1.6;
      return;
    }
    if (s.job === 'recapture') {
      const a = sim.animals.get(s.jobRef);
      if (a && a.escaped && (a.x - s.x) ** 2 + (a.z - s.z) ** 2 < 9 * 9) {
        s.phase = 2;
        s.timer = 3;
        s.faceHeading = Math.atan2(a.x - s.x, a.z - s.z);
        return;
      }
      // it moved on: look again
      s.job = 'none';
      s.timer = 0.3;
      return;
    }
    s.job = 'none';
    s.timer = 1;
  }

  /** A keeper leaves food just inside an opened enclosure's old footprint, and a tub of water if no pond or trough is left. */
  private serviceOpen(s: StaffSim, enc: OpenEnclosure) {
    const sim = this.sim;
    const w = sim.world;
    const cap = enclosureCapacity(sim, enc);
    enc.food = Math.max(enc.food, cap);
    const own = sim.enclosures.footprintWater(enc);
    if (!own.edge.length && !own.troughs.length) enc.water = Math.max(enc.water, cap);
    // just past the old fence line, one or two tiles from the path
    for (const d of [2.2, 4.2]) {
      const fx = s.x + Math.sin(s.faceHeading) * d,
        fz = s.z + Math.cos(s.faceHeading) * d;
      const t = w.tileOfWorld(fx, fz);
      if (w.inBounds(t.x, t.z) && sim.enclosures.openOf[w.idx(t.x, t.z)] === enc.id) {
        enc.spotX = fx;
        enc.spotZ = fz;
        return;
      }
    }
  }

  private finishWork(s: StaffSim) {
    const sim = this.sim;
    const w = sim.world;
    s.phase = 0;
    s.next = -1;
    switch (s.job) {
      case 'service': {
        const hab = w.habitats.get(s.jobRef);
        const rt = sim.habitatRuntime(s.jobRef);
        const enc = hab ? undefined : sim.enclosures.find(s.jobRef);
        if (enc) this.serviceOpen(s, enc);
        else if (hab && rt) {
          rt.food = Math.max(rt.food, foodCapacity(sim, hab.id));
          rt.sinceService = 0;
          // food is left just inside the fence where the keeper stands
          const fx = s.x + Math.sin(s.faceHeading) * 2.2,
            fz = s.z + Math.cos(s.faceHeading) * 2.2;
          const t = w.tileOfWorld(fx, fz);
          if (w.inBounds(t.x, t.z) && w.habitatOf[w.idx(t.x, t.z)] === hab.id) {
            rt.spotX = fx;
            rt.spotZ = fz;
          }
          // clean the dung
          const ids: number[] = [];
          for (const l of sim.litter.values()) {
            if (l.kind !== 'dung') continue;
            const lt = w.tileOfWorld(l.x, l.z);
            if (w.inBounds(lt.x, lt.z) && w.habitatOf[w.idx(lt.x, lt.z)] === hab.id) ids.push(l.id);
          }
          for (const id of ids) sim.removeLitter(id);
          sim.dungByHab.set(hab.id, 0);
        }
        break;
      }
      case 'litter': {
        const ids: number[] = [];
        for (const l of sim.litter.values()) {
          if (l.kind !== 'trash') continue;
          if ((l.x - s.x) ** 2 + (l.z - s.z) ** 2 < 2.6 * 2.6) ids.push(l.id);
        }
        for (const id of ids) sim.removeLitter(id);
        break;
      }
      case 'heal': {
        let healed = 0;
        for (const a of sim.animals.values()) {
          if (a.escaped || a.habitatId !== s.jobRef) continue;
          if (a.sick || a.health < 0.95) {
            a.sick = false;
            a.health = Math.min(1, a.health + 0.5);
            healed++;
          }
        }
        if (healed) {
          const hab = w.habitats.get(s.jobRef);
          sim.notify(`healed:${s.jobRef}`, `${s.name} treated ${healed} animal${healed > 1 ? 's' : ''} in ${hab?.name ?? 'a habitat'}.`, 'good', { x: s.x, z: s.z }, 60);
        }
        break;
      }
      case 'recapture': {
        const a = sim.animals.get(s.jobRef);
        if (a && a.escaped) {
          const sp = SPECIES_BY_ID[a.speciesId];
          if (sim.animalSys.returnHome(a)) {
            const where = w.habitats.get(a.home)?.name ?? 'its habitat';
            sim.notify(null, `${s.name} safely returned ${a.name} the ${singularName(sp.id)} to ${where}.`, 'good', { x: a.x, z: a.z });
          }
        }
        break;
      }
    }
    s.job = 'none';
    s.timer = sim.rng.range(0.5, 1.5);
    s.task = 'Looking for work';
  }
}
