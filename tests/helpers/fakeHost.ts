// In-memory AudioHost for module tests (src/audio/modules/*): no Web Audio,
// a manual clock and a record of every play / loop / duck request. Uses the
// same distance model as the engine, so levels and pans are realistic.
import { RECIPES } from '../../src/audio/recipes';
import {
  DEFAULT_RADIUS,
  DEFAULT_REF_DIST,
  distanceModel,
  type Attenuation,
  type AudioHost,
  type Channel,
  type ListenerState,
  type PlaySpec,
  type Pool,
  type VoiceHandle,
} from '../../src/audio/host';
import type { ISimulation } from '../../src/core/contracts';
import { EventBus } from '../../src/core/events';

export interface FakeHostOptions {
  sim: ISimulation;
  events?: EventBus;
  lowSpec?: boolean;
  ready?: (id: string) => boolean;
  dur?: (id: string) => number;
}

export class FakeHost implements AudioHost {
  readonly sim: ISimulation;
  readonly events: EventBus;
  readonly lowSpec: boolean;
  time = 0;
  active = true;
  listener: ListenerState = { x: 0, y: 10, z: 0, fx: 0, fz: 0, camDist: 30, zoomNear: 0.8 };
  hour = 12;
  nightness = 0;
  followId = -1;
  readonly plays: { spec: PlaySpec; t: number; final: number; dist: number }[] = [];
  readonly loops = new Map<string, { id: string; level: number; side: number; ch: Channel }>();
  readonly ducks: { ch: Channel; db: number; hold: number; t: number }[] = [];
  worldFilter = { cutHz: 20000, gainDb: 0, tc: 0 };
  readonly requested: string[] = [];
  /** End time and pool of every recorded play (parallel to `plays`). */
  private readonly ends: { pool: Pool; endAt: number }[] = [];
  private readonly att: Attenuation = { gain: 1, pan: 0, cut: 18000, shelfDb: 0, wet: 0.05, dist: 0 };
  private readonly ready?: (id: string) => boolean;
  private readonly dur?: (id: string) => number;

  constructor(o: FakeHostOptions) {
    this.sim = o.sim;
    this.events = o.events ?? new EventBus();
    this.lowSpec = o.lowSpec ?? false;
    this.ready = o.ready;
    this.dur = o.dur;
  }

  now(): number {
    return this.time;
  }

  advance(dt: number): void {
    this.time += dt;
  }

  attenuate(x: number, y: number, z: number, refDist = DEFAULT_REF_DIST, radius = DEFAULT_RADIUS): Readonly<Attenuation> {
    const l = this.listener;
    const dx = x - l.x,
      dy = y - l.y,
      dz = z - l.z;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-3;
    // right = +x, forward = −z
    return distanceModel(r, dx / r, -dz / r, refDist, radius, this.att);
  }

  has(id: string): boolean {
    return this.ready?.(id) ?? id in RECIPES;
  }

  request(id: string): void {
    this.requested.push(id);
  }

  duration(id: string): number {
    return this.has(id) ? (this.dur?.(id) ?? 0.5) : 0;
  }

  play(spec: PlaySpec): VoiceHandle | null {
    if (!this.has(spec.id)) {
      this.requested.push(spec.id);
      return null;
    }
    let pos = spec.at;
    if (spec.track !== undefined && spec.track >= 0) {
      const a = this.sim.animals.get(spec.track);
      if (a) pos = { x: a.x, y: a.y + 1, z: a.z };
    }
    let final = spec.gain ?? 1;
    let dist = 0;
    if (pos) {
      const att = this.attenuate(pos.x, pos.y, pos.z, spec.refDist, spec.radius);
      final *= att.gain;
      dist = att.dist;
    }
    if (final < 0.01) return null;
    const t = spec.when ?? this.time;
    const end = { pool: spec.pool ?? 'voice', endAt: t + (this.dur?.(spec.id) ?? 0.5) / (spec.rate ?? 1) };
    this.plays.push({ spec, t, final, dist });
    this.ends.push(end);
    return {
      get endAt() {
        return end.endAt;
      },
      stop: () => {
        end.endAt = Math.min(end.endAt, this.time);
      },
    };
  }

  loop(key: string, id: string, level: number, side = 0, ch: Channel = 'ambience'): void {
    this.loops.set(key, { id, level, side, ch });
  }

  duck(ch: Channel, db: number, hold: number): void {
    this.ducks.push({ ch, db, hold, t: this.time });
  }

  setWorldFilter(cutHz: number, gainDb: number, tc: number): void {
    this.worldFilter = { cutHz, gainDb, tc };
  }

  playing(pool: Pool): number {
    let n = 0;
    for (const e of this.ends) if (e.pool === pool && e.endAt > this.time) n++;
    return n;
  }
}
