// Every animal sound: vocal bouts (call series, idles, night roaring, choruses
// that spread through a group), colony murmur loops, foley (footsteps,
// drinking, eating, breathing, swimming), reactions to the player (placement,
// births, selection, escapes) and guest footsteps by path surface.
//
// The animal the camera follows, the selected animal and animals close to a
// zoomed-in camera are favoured: they idle more often and get close-up foley,
// so whatever the player looks at sounds alive.

import { TILE } from '../../core/constants';
import { SPEED_MULTIPLIERS } from '../../core/contracts';
import { Rng } from '../../core/rng';
import { Terrain, isWater, type AnimalState } from '../../core/types';
import { SPECIES_BY_ID } from '../../data/species';
import {
  JUVENILE_DB,
  JUVENILE_GROWTH,
  JUVENILE_MAX_RATE,
  VariantPicker,
  hasBout,
  individual,
  juvenilePitch,
  pickBout,
  planBout,
  planJoins,
  type BoutItem,
  type Individual,
} from '../fauna/bout';
import { activityAt, colonyLevel, idleRate, idleWeight, pickKind, pickWeighted, reachFactor } from '../fauna/diel';
import { FEET_BANK, FOLEY_SPECIES, FoleyLimiter, CLOSE_STEP_DB, STEP_DB, guestCadence, guestStepBank, stepCrossings, type FoleySpecies } from '../fauna/foley';
import type { AudioHost, AudioModule, AudioModuleFactory, VoiceHandle } from '../host';
import { SPECIES_AUDIO, registerRecipes, sylId, voiceIdFor, type Bout, type BoutKind, type SpeciesAudio } from '../recipes';
import { FOLEY_BANKS, FOLEY_RECIPES, LAP_SPACING, type FoleyBank } from '../recipes/foley';

registerRecipes(FOLEY_RECIPES);

/** Behaviour tuning (exported for tests). */
export const FAUNA = {
  /** Animal scan period, s (10 Hz). */
  scan: 0.1,
  /** Syllables are handed to the host this far ahead, s. */
  lookahead: 0.15,
  /** Attenuated gain (species ref / radius) above which an animal counts as audible. */
  inRange: 0.02,
  /** Concurrent bouts [normal, lowSpec]. */
  maxBouts: [3, 2] as const,
  /** Per species: at most one new bout per this many s. */
  speciesGap: 1.5,
  /** Per animal: idle cooldown, s. */
  idleCooldown: 12,
  /** Close-up animals (followed, selected, nearest to a zoomed-in camera): own idle cooldown and rate after it, per s. */
  closeCooldown: 8,
  closeRate: 0.2,
  /** A bout whose animal stays below 0.01 gain this long is dropped, s. */
  quietAbort: 2,
  /** A sim 'call' action younger than this starts a call bout, s. */
  callEdge: 1.5,
  /** Followed / selected / close-up animals: idle weight ×boost. */
  boost: 4,
  /** Close-up: within `nearRadius` m of the camera focus while the camera is within `nearCam` m of it. */
  nearRadius: 12,
  nearCam: 20,
  /** How many of the close-up animals (nearest the focus first) also get the follow foley (breath, tail, ears). */
  nearFoley: 2,
  /** Auto-follow: an animal within this many m of the focus for `followAfter` s. */
  followRadius: 1.5,
  followAfter: 2,
  /** Foley only within this distance of the ear [normal, lowSpec], m, and while zoomNear exceeds `foleyZoom`. */
  foleyDist: [15, 10] as const,
  foleyZoom: 0.4,
  foleyRef: 3,
  foleyRadius: 20,
  /** Foley quieter than this at the ear is not started (twice this for animals out of focus): saves voices and CPU. */
  foleyMin: 0.015,
  /** Reactions. */
  placeDelay: [0.8, 1.5] as const,
  placeGap: 2,
  birthDist: 45,
  selectDist: 40,
  selectDelay: [0.15, 0.4] as const,
  selectP: 0.7,
  selectGap: 6,
  /** Guest steps: the nearest `guestMax` walking guests within `guestDist` m of the ear, camera within `guestCam` m. */
  guestMax: 3,
  guestDist: 12,
  guestCam: 30,
  guestScan: 0.25,
  guestDb: -20,
} as const;

/** Linear foley levels re a lion roar at the foley refDist. */
const FOLEY_GAIN = {
  lap: 0.3,
  suck: 0.45,
  pour: 0.4,
  wade: 0.35,
  crop: 0.3,
  chew: 0.32,
  breath: 0.5,
  flap: 0.35,
  tail: 0.25,
  dust: 0.4,
  swim: 0.35,
  swimBig: 0.5,
  surface: 0.6,
  dive: 0.55,
} as const;

/** Bout group ids (layered syllables share one voice). The feedback module uses 0x40000000 and up. */
const GROUP_BASE = 0x100000;

type Trigger = 'sched' | 'sim' | 'idle' | 'join' | 'react' | 'force';

interface Critter {
  readonly id: number;
  readonly voice: string;
  readonly sp: SpeciesAudio;
  readonly body: FoleySpecies;
  readonly ind: Individual;
  prevAction: string;
  prevEscaped: boolean;
  bout: RunningBout | null;
  lastIdle: number;
  lastSelect: number;
  /** Last scan: attenuated gain (species ref / radius) and distance from the ear. */
  gain: number;
  dist: number;
  /** Distance to the camera focus on the ground, m. */
  focusDist: number;
  /** Footstep phase and alternating foot. */
  phase: number;
  foot: number;
  /** Next action / close-up foley times (host.time). */
  nextAct: number;
  pourAt: number;
  nextChew: number;
  nextBreath: number;
  nextFlap: number;
  nextTail: number;
  nextDust: number;
  nextSurface: number;
  /** Time spent at the camera focus (auto-follow). */
  atFocus: number;
  /** Followed, selected or close to a zoomed-in camera (last scan): idles ×4. */
  boosted: boolean;
  /** Gets the close-up foley this scan (breath, chewing, tail, ears). */
  closeUp: boolean;
  /** Started swimming since the last scan (penguins and polar bears dive). */
  dived: boolean;
}

interface RunningBout {
  readonly group: number;
  readonly c: Critter;
  readonly kind: BoutKind;
  readonly trigger: Trigger;
  readonly items: BoutItem[];
  next: number;
  readonly t0: number;
  readonly gainDb: number;
  readonly rate: number;
  readonly juvenile: boolean;
  readonly refDist: number;
  readonly radius: number;
  readonly handles: VoiceHandle[];
  quiet: number;
  endAt: number;
}

interface Pending {
  at: number;
  id: number;
  kind: BoutKind;
  trigger: Trigger;
}

const SPEED = SPEED_MULTIPLIERS as readonly number[];
/** Bout kinds that spread through a group (choruses); idles, eating and social chatter stay individual. */
const CHORUS: ReadonlySet<BoutKind> = new Set<BoutKind>(['call', 'contact', 'display', 'night', 'alarm']);
/** A syllable never repeats with the same playbackRate (±REPEAT_RATE) within REPEAT_WINDOW s. */
const REPEAT_WINDOW = 30;
const REPEAT_RATE = 0.006;
const db2lin = (db: number) => Math.pow(10, db / 20);
/** Colony murmur runs on the world channel; this keeps the level it was tuned at on the ambience channel. */
const COLONY_WORLD_TRIM = 0.55 / 0.4;

class Fauna implements AudioModule {
  readonly ownsAnimals = true;
  private readonly rng: Rng;
  private readonly picker = new VariantPicker();
  private readonly has = (id: string) => this.host.has(id);
  private readonly limiter = new FoleyLimiter();
  private readonly critters = new Map<number, Critter>();
  private readonly bouts: RunningBout[] = [];
  private readonly pending: Pending[] = [];
  private readonly lastBoutAt = new Map<string, number>();
  private readonly recentRates = new Map<string, { t: number; rate: number }[]>();
  private readonly colonyKeys = new Map<string, string>();
  private readonly guestSteps = new Map<number, { phase: number; foot: number }>();
  private readonly warmedVoices = new Set<string>();
  private readonly unsub: (() => void)[] = [];
  private readonly offsets: number[] = [];
  private readonly inRange: Critter[] = [];
  private readonly near: Critter[] = [];
  private readonly idlers: Critter[] = [];
  private readonly foleyList: Critter[] = [];
  /** Close-up animals of the last scan (followed, selected, nearest to a zoomed-in camera). */
  private readonly closeList: Critter[] = [];
  private nextGroup = GROUP_BASE;
  /** Time since each periodic pass last ran (start due). */
  private scanAcc: number = FAUNA.scan;
  private dielAcc = 1;
  private colonyAcc = 0.25;
  private guestAcc: number = FAUNA.guestScan;
  private warmed = false;
  private selectedId = -1;
  private autoFollow = -1;
  private readonly placedAt = new Map<number, number>();
  private lastPlaceReact = -1e9;
  private readonly births: number[] = [];
  private readonly started: Record<Trigger, number> = { sched: 0, sim: 0, idle: 0, join: 0, react: 0, force: 0 };
  private foleyStarts = 0;
  private joinsPlanned = 0;
  private lastBout: Record<string, unknown> | null = null;

  constructor(
    private readonly host: AudioHost,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    const ev = host.events;
    this.unsub.push(
      ev.on('animalAdded', (e) => {
        const a = host.sim.animals.get(e.id);
        if (a && this.warmed) this.warmSpecies(this.voiceOf(a.speciesId));
        if (host.active) this.births.push(e.id);
      }),
      ev.on('animalPlaced', (e) => {
        // react only to what the player can hear (not to the demo zoo built before audio starts)
        if (!host.active) return;
        this.placedAt.set(e.id, host.time);
        if (host.time - this.lastPlaceReact < FAUNA.placeGap) return;
        this.lastPlaceReact = host.time;
        const a = host.sim.animals.get(e.id);
        if (!a) return;
        const sp = SPECIES_AUDIO[this.voiceOf(a.speciesId)];
        this.later(this.rng.range(FAUNA.placeDelay[0], FAUNA.placeDelay[1]), e.id, sp.chatty >= 0.7 ? 'call' : 'idle', 'react');
      }),
      ev.on('animalRemoved', (e) => this.forget(e.id)),
      ev.on('selectionChanged', (e) => this.onSelect(e.selection?.kind === 'animal' ? e.selection.id : -1)),
      ev.on('worldReset', () => {
        for (const id of [...this.critters.keys()]) this.forget(id);
        this.pending.length = 0;
        this.births.length = 0;
        this.placedAt.clear();
        this.selectedId = this.autoFollow = -1;
      }),
    );
  }

  // ------------------------------------------------------------ AudioModule

  warm(): readonly string[] {
    this.warmed = true;
    const ids: string[] = [];
    for (const a of this.host.sim.animals.values()) {
      const voice = this.voiceOf(a.speciesId);
      if (this.warmedVoices.has(voice)) continue;
      this.warmedVoices.add(voice);
      ids.push(...this.warmSet(voice));
    }
    for (const b of ['fx.splash.small', 'fx.breath.big', 'fx.lap', 'fx.crop'] as const) ids.push(`${b}#0`);
    if (this.host.sim.guests.size) ids.push('fx.gstep.paved#0', 'fx.gstep.gravel#0', 'fx.gstep.board#0');
    return ids;
  }

  update(dt: number): void {
    if (!this.host.active) return;
    const running = this.host.sim.speed > 0;
    this.runBouts(dt);
    if (running) this.runPending();
    // periodic work gets the time since its last run (frames vary; tests step coarsely)
    this.scanAcc += dt;
    if (this.scanAcc >= FAUNA.scan) {
      this.scan(this.scanAcc, running);
      this.scanAcc = 0;
    }
    this.dielAcc += dt;
    if (this.dielAcc >= 1) {
      if (running) this.schedule(this.dielAcc);
      this.dielAcc = 0;
    }
    this.colonyAcc += dt;
    if (this.colonyAcc >= 0.25) {
      this.colonies();
      this.colonyAcc = 0;
    }
    this.guestAcc += dt;
    if (this.guestAcc >= FAUNA.guestScan) {
      if (running) this.guestFeet(this.guestAcc);
      this.guestAcc = 0;
    }
  }

  force(animalId: number, kind: string): boolean {
    const a = this.host.sim.animals.get(animalId);
    if (!a) return false;
    const c = this.critter(a);
    const b = this.boutFor(c, a, kind === 'call' ? ['call', 'display'] : [kind as BoutKind]);
    return !!b && this.start(c, a, b, 'force');
  }

  debug(): Record<string, unknown> {
    const colony: Record<string, string> = {};
    for (const [k, id] of this.colonyKeys) colony[k] = id;
    return {
      bouts: this.bouts.length,
      lastBout: this.lastBout,
      started: { ...this.started },
      joinsPlanned: this.joinsPlanned,
      foley: this.foleyStarts,
      followId: this.followed(),
      selectedId: this.selectedId,
      near: this.near.map((c) => c.id),
      colony,
    };
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    for (const b of this.bouts) this.stopBout(b);
    this.bouts.length = 0;
    for (const [key, id] of this.colonyKeys) this.host.loop(key, id, 0, 0, 'world');
    this.colonyKeys.clear();
  }

  // ------------------------------------------------------------ animals

  private voiceOf(speciesId: string): string {
    return voiceIdFor(speciesId, SPECIES_BY_ID[speciesId]?.diet);
  }

  private warmSet(voice: string): string[] {
    const sp = SPECIES_AUDIO[voice];
    const ids = Object.keys(sp.syllables).map((syl) => sylId(voice, syl, 0));
    if (sp.colony) ids.push(sp.colony.loopId);
    ids.push(`${FEET_BANK[FOLEY_SPECIES[voice].feet]}#0`);
    return ids;
  }

  private warmSpecies(voice: string): void {
    if (this.warmedVoices.has(voice)) return;
    this.warmedVoices.add(voice);
    for (const id of this.warmSet(voice)) this.host.request(id);
  }

  private critter(a: AnimalState): Critter {
    let c = this.critters.get(a.id);
    if (!c) {
      const voice = this.voiceOf(a.speciesId);
      const sp = SPECIES_AUDIO[voice];
      const t = this.host.time;
      c = {
        id: a.id,
        voice,
        sp,
        body: FOLEY_SPECIES[voice],
        ind: individual(sp, a.seed, a.sex),
        prevAction: a.action,
        prevEscaped: a.escaped,
        bout: null,
        lastIdle: -1e9,
        lastSelect: -1e9,
        gain: 0,
        dist: 1e9,
        focusDist: 1e9,
        phase: this.rng.float(),
        foot: 0,
        nextAct: t,
        pourAt: -1,
        nextChew: t,
        nextBreath: t + this.rng.range(0.5, 3),
        nextFlap: t + this.rng.range(2, 8),
        nextTail: t + this.rng.range(1, 6),
        nextDust: t + this.rng.range(10, 40),
        nextSurface: t + this.rng.range(5, 20),
        atFocus: 0,
        boosted: false,
        closeUp: false,
        dived: false,
      };
      this.critters.set(a.id, c);
      if (this.warmed) this.warmSpecies(voice);
    }
    return c;
  }

  private forget(id: number): void {
    const c = this.critters.get(id);
    if (c?.bout) this.abort(c.bout);
    this.critters.delete(id);
    if (this.selectedId === id) this.selectedId = -1;
    if (this.autoFollow === id) this.autoFollow = -1;
  }

  private followed(): number {
    return this.host.followId >= 0 ? this.host.followId : this.autoFollow;
  }

  /** Followed or selected: idles more and gets the close-up foley. */
  private isFocus(c: Critter): boolean {
    return c.id === this.followed() || c.id === this.selectedId;
  }

  private awake(a: AnimalState): boolean {
    return a.action !== 'sleep';
  }

  /** One pass over the animals: audibility, sim edges (call, escape, dive), idle lottery and foley. */
  private scan(dt: number, running: boolean): void {
    const h = this.host;
    const l = h.listener;
    const closeCam = l.camDist <= FAUNA.nearCam;
    const foleyOn = running && l.zoomNear > FAUNA.foleyZoom;
    const foleyDist = FAUNA.foleyDist[h.lowSpec ? 1 : 0];
    this.inRange.length = 0;
    this.near.length = 0;
    this.idlers.length = 0;
    this.foleyList.length = 0;
    let follow: Critter | null = null;
    this.closeList.length = 0;
    for (const a of h.sim.animals.values()) {
      const c = this.critter(a);
      c.boosted = c.closeUp = this.isFocus(c);
      if (c.closeUp) this.closeList.push(c);
      c.dived = false;
      const att = h.attenuate(a.x, a.y + 1, a.z, c.sp.refDist, c.sp.radius);
      c.gain = att.gain;
      c.dist = att.dist;
      c.focusDist = Math.hypot(a.x - l.fx, a.z - l.fz);
      c.atFocus = c.focusDist <= FAUNA.followRadius ? c.atFocus + dt : 0;
      if (c.atFocus > FAUNA.followAfter && (!follow || c.focusDist < follow.focusDist)) follow = c;
      if (closeCam && c.focusDist <= FAUNA.nearRadius) this.near.push(c);
      if (running) this.edges(c, a);
      c.prevAction = a.action;
      c.prevEscaped = a.escaped;
      if (c.gain >= FAUNA.inRange) {
        this.inRange.push(c);
        if (running && !c.bout && this.awake(a) && h.time - c.lastIdle >= FAUNA.idleCooldown) this.idlers.push(c);
      }
      if (foleyOn && c.dist <= foleyDist) this.foleyList.push(c);
    }
    this.autoFollow = follow ? follow.id : -1;
    this.near.sort((p, q) => p.focusDist - q.focusDist);
    this.near.forEach((c, i) => {
      c.boosted = true;
      if (i < FAUNA.nearFoley && !c.closeUp) {
        c.closeUp = true;
        this.closeList.push(c);
      }
    });
    for (const c of this.foleyList) {
      const a = h.sim.animals.get(c.id);
      if (a) this.foley(c, a, dt);
    }
    if (running) {
      this.closeUpIdles(dt);
      this.idleLottery(dt);
    }
  }

  /** Sim edges: a new 'call' action (if reached), the start of a swim (dive), an escape. */
  private edges(c: Critter, a: AnimalState): void {
    if (a.action === 'call' && c.prevAction !== 'call' && a.actionTime < FAUNA.callEdge && c.gain >= FAUNA.inRange && !c.bout && this.reached(c)) {
      const b = this.boutFor(c, a, ['call', 'display']);
      if (b) this.start(c, a, b, 'sim');
    }
    if (a.action === 'swim' && c.prevAction !== 'swim') c.dived = c.voice === 'penguin' || c.voice === 'polarbear';
    if (a.escaped && !c.prevEscaped) {
      if (c.bout) this.abort(c.bout);
      const b = this.boutFor(c, a, ['alarm', 'call', 'display']);
      if (b) this.start(c, a, b, 'react');
    }
  }

  /** Random draw against the reach factor: far animals start fewer spontaneous bouts in a close view. */
  private reached(c: Critter): boolean {
    return this.rng.float() < reachFactor(c.dist, this.host.listener.camDist, c.sp.refDist);
  }

  private speciesFree(voice: string): boolean {
    return this.host.time - (this.lastBoutAt.get(voice) ?? -1e9) >= FAUNA.speciesGap;
  }

  /** The animals the player looks at idle on their own clock (≈ every 8–13 s), outside the lottery. */
  private closeUpIdles(dt: number): void {
    const h = this.host;
    for (const c of this.closeList) {
      if (c.bout || h.time - c.lastIdle < FAUNA.closeCooldown || !this.speciesFree(c.voice)) continue;
      const a = h.sim.animals.get(c.id);
      if (!a || !this.awake(a) || c.gain < FAUNA.inRange || this.rng.float() >= FAUNA.closeRate * dt) continue;
      const b = this.contextBout(c, a);
      if (b && this.start(c, a, b, 'idle')) c.lastIdle = h.time;
    }
  }

  /** Idle lottery (every scan): rate from the candidates' chattiness and reach; weights favour the ear and the focus. */
  private idleLottery(dt: number): void {
    const free = this.idlers.filter((c) => this.speciesFree(c.voice));
    let sumChatty = 0;
    // the animals the player looks at raise the rate as well as winning the draw
    for (const c of free) sumChatty += c.sp.chatty * reachFactor(c.dist, this.host.listener.camDist, c.sp.refDist) * (c.boosted ? FAUNA.boost : 1);
    if (!free.length || this.rng.float() >= idleRate(sumChatty) * dt) return;
    const c = pickWeighted(free, (x) => idleWeight(x.sp.chatty, x.dist, x.boosted ? FAUNA.boost : 1), this.rng);
    const a = c && this.host.sim.animals.get(c.id);
    if (!c || !a) return;
    const b = this.contextBout(c, a);
    if (b && this.start(c, a, b, 'idle')) c.lastIdle = this.host.time;
  }

  /** Idle kind by context: eating, a walking gorilla's pig grunts, a neighbour, a youngster. */
  private contextBout(c: Critter, a: AnimalState): Bout | null {
    const sp = c.sp;
    let kind: BoutKind = 'idle';
    if (a.action === 'eat' && hasBout(sp, 'eat')) kind = 'eat';
    else if (c.voice === 'gorilla' && a.action === 'walk' && hasBout(sp, 'contact')) kind = 'contact';
    else if (hasBout(sp, 'social') && this.rng.float() < 0.5 && this.neighbour(a, 6)) kind = 'social';
    return this.boutFor(c, a, [kind, 'idle']);
  }

  /** The first of `kinds` the species has; youngsters use their juvenile bout instead (except for alarms and eating). */
  private boutFor(c: Critter, a: AnimalState, kinds: readonly BoutKind[]): Bout | null {
    if (kinds[0] !== 'alarm' && kinds[0] !== 'eat') {
      const y = this.youngBout(c, a);
      if (y) return y;
    }
    for (const k of kinds) {
      const b = pickBout(c.sp, k, a.sex, this.rng);
      if (b) return b;
    }
    return null;
  }

  private youngBout(c: Critter, a: AnimalState): Bout | null {
    return a.growth < JUVENILE_GROWTH ? pickBout(c.sp, 'juvenile', a.sex, this.rng) : null;
  }

  /** A conspecific within r m. */
  private neighbour(a: AnimalState, r: number): boolean {
    for (const o of this.host.sim.animals.values())
      if (o.id !== a.id && o.speciesId === a.speciesId && Math.abs(o.x - a.x) < r && Math.abs(o.z - a.z) < r && Math.hypot(o.x - a.x, o.z - a.z) < r)
        return true;
    return false;
  }

  /** Diel scheduler (1 Hz): per species group in range, scheduled bouts by daily activity (far groups less often). */
  private schedule(dt: number): void {
    const h = this.host;
    const groups = new Map<string, Critter[]>();
    for (const c of this.inRange) {
      const a = h.sim.animals.get(c.id);
      if (!a) continue;
      const key = `${c.voice}:${a.habitatId ?? -1}`;
      const g = groups.get(key);
      if (g) g.push(c);
      else groups.set(key, [c]);
    }
    for (const g of groups.values()) {
      const sp = g[0].sp;
      let closest = Infinity;
      for (const c of g) closest = Math.min(closest, c.dist);
      let p = (sp.boutsPerMin / 60) * activityAt(sp, h.hour) * reachFactor(closest, h.listener.camDist, sp.refDist) * dt;
      if (sp.voice === 'lion' && g.every((c) => h.sim.animals.get(c.id)?.sex === 'F')) p *= 0.5;
      if (this.rng.float() >= p) continue;
      const free = g.filter((c) => {
        const a = h.sim.animals.get(c.id);
        return !!a && !c.bout && (sp.callsWhileAsleep || this.awake(a));
      });
      if (!free.length) continue;
      const c = free[this.rng.int(0, free.length - 1)];
      const a = h.sim.animals.get(c.id)!;
      const b = this.youngBout(c, a) ?? pickKind(sp, h.nightness, a, this.rng, h.hour);
      if (b) this.start(c, a, b, 'sched');
    }
  }

  // ------------------------------------------------------------ bouts

  /**
   * Start a bout. Gates: no new bouts while paused; one new bout per species per
   * 1.5 s (reactions, joins and forced bouts skip it); at most 3 at once (2 on
   * lowSpec): a louder newcomer replaces the quietest running bout.
   */
  private start(c: Critter, a: AnimalState, bout: Bout, trigger: Trigger): boolean {
    const h = this.host;
    const urgent = trigger === 'react' || trigger === 'force';
    if (h.sim.speed === 0 && trigger !== 'force') return false;
    if (!urgent && trigger !== 'join' && !this.speciesFree(c.voice)) return false;
    if (c.bout) return false;
    const sp = c.sp;
    const juvenile = a.growth < JUVENILE_GROWTH;
    const gainDb = (sp.levels[bout.kind] ?? sp.levels.idle ?? -12) + c.ind.db + (juvenile ? JUVENILE_DB : 0);
    const refDist = bout.refDist ?? sp.refDist;
    const radius = bout.radius ?? sp.radius;
    const max = FAUNA.maxBouts[h.lowSpec ? 1 : 0];
    if (this.bouts.length >= max) {
      const level = db2lin(gainDb) * h.attenuate(a.x, a.y + 1, a.z, refDist, radius).gain;
      let weakest: RunningBout | null = null;
      let wl = Infinity;
      for (const b of this.bouts) {
        const l = this.boutLevel(b);
        if (l < wl) {
          wl = l;
          weakest = b;
        }
      }
      if (!weakest || (!urgent && level <= wl * 1.25)) return false;
      this.abort(weakest);
    }
    const items = planBout(sp, bout, this.rng, (syl) => this.sylDur(c.voice, syl));
    if (!items.length) return false;
    const rb: RunningBout = {
      group: this.nextGroup++,
      c,
      kind: bout.kind,
      trigger,
      items,
      next: 0,
      t0: h.now() + 0.1,
      gainDb,
      rate: c.ind.pitch * juvenilePitch(a.growth),
      juvenile,
      refDist,
      radius,
      handles: [],
      quiet: 0,
      endAt: 0,
    };
    this.bouts.push(rb);
    c.bout = rb;
    this.lastBoutAt.set(c.voice, h.time);
    this.started[trigger]++;
    this.lastBout = { voice: c.voice, kind: bout.kind, trigger, animal: c.id, items: items.length, span: +items[items.length - 1].t.toFixed(2) };
    if (trigger !== 'join' && CHORUS.has(bout.kind)) this.spread(c, a, bout.kind);
    return true;
  }

  /** Contagion: conspecifics near the caller may join after a delay, with the same kind; joins never spread. */
  private spread(c: Critter, a: AnimalState, kind: BoutKind): void {
    const con = c.sp.contagion;
    if (!con) return;
    const eligible: number[] = [];
    for (const o of this.host.sim.animals.values()) {
      if (o.id === a.id || o.speciesId !== a.speciesId || Math.hypot(o.x - a.x, o.z - a.z) > con.radius) continue;
      if (this.critters.get(o.id)?.bout || !(c.sp.callsWhileAsleep || this.awake(o))) continue;
      eligible.push(o.id);
    }
    for (const j of planJoins(con, eligible, this.rng)) {
      this.later(j.delay, j.id, kind, 'join');
      this.joinsPlanned++;
    }
  }

  private later(delay: number, id: number, kind: BoutKind, trigger: Trigger): void {
    this.pending.push({ at: this.host.time + delay, id, kind, trigger });
  }

  private runPending(): void {
    const h = this.host;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (h.time < p.at) continue;
      this.pending.splice(i, 1);
      const a = h.sim.animals.get(p.id);
      if (!a) continue;
      const c = this.critter(a);
      if (c.bout || (p.trigger === 'join' && (!(c.sp.callsWhileAsleep || this.awake(a)) || !this.reached(c)))) continue;
      const b = this.boutFor(c, a, [p.kind, 'idle']);
      if (b && this.start(c, a, b, p.trigger) && p.trigger !== 'join') c.lastIdle = h.time;
    }
    if (this.births.length) this.reactToBirths();
  }

  private sylDur(voice: string, syl: string): number {
    return this.host.duration(sylId(voice, syl, 0)) || SPECIES_AUDIO[voice].syllables[syl].dur;
  }

  /** Current level of a bout at the ear (for stealing). */
  private boutLevel(b: RunningBout): number {
    const a = this.host.sim.animals.get(b.c.id);
    return a ? db2lin(b.gainDb) * this.host.attenuate(a.x, a.y + 1, a.z, b.refDist, b.radius).gain : 0;
  }

  /** Hand due syllables to the host; drop bouts that ended, lost their animal or went inaudible. */
  private runBouts(dt: number): void {
    const h = this.host;
    const now = h.now();
    for (let i = this.bouts.length - 1; i >= 0; i--) {
      const b = this.bouts[i];
      const a = h.sim.animals.get(b.c.id);
      if (!a || (a.action === 'run' && b.kind !== 'alarm' && b.trigger !== 'react')) {
        this.abort(b);
        continue;
      }
      b.quiet = h.attenuate(a.x, a.y + 1, a.z, b.refDist, b.radius).gain < 0.01 ? b.quiet + dt : 0;
      if (b.quiet >= FAUNA.quietAbort) {
        this.abort(b);
        continue;
      }
      while (b.next < b.items.length && b.t0 + b.items[b.next].t <= now + FAUNA.lookahead) this.playItem(b, b.items[b.next++], now);
      if (b.next >= b.items.length && now >= b.endAt) this.finish(b);
    }
  }

  private playItem(b: RunningBout, it: BoutItem, now: number): void {
    const h = this.host;
    const c = b.c;
    const bank = c.sp.syllables[it.syl];
    const base = `syl.${c.voice}.${it.syl}`;
    const count = h.lowSpec ? Math.min(bank.variants, bank.lowSpecVariants ?? 2) : bank.variants;
    const id = this.picker.pick(base, count, this.has, this.rng);
    const missing = this.picker.missing(base, count, this.has);
    if (missing) h.request(missing);
    if (!id) return;
    let rate = b.rate * it.rate * (1 + this.rng.range(-c.sp.rateJitter, c.sp.rateJitter));
    rate = this.freshRate(id, rate, now, b.juvenile ? JUVENILE_MAX_RATE : Infinity);
    const handle = h.play({
      id,
      track: c.id,
      pool: 'voice',
      gain: db2lin(b.gainDb + it.db + this.rng.range(-1.5, 1.5)),
      rate,
      when: Math.max(now, b.t0 + it.t),
      group: b.group,
      color: c.ind.color,
      refDist: b.refDist,
      radius: b.radius,
    });
    if (!handle) return;
    b.handles.push(handle);
    b.endAt = Math.max(b.endAt, handle.endAt);
  }

  /**
   * Nudge a rate away from recent plays of the same variant (no machine-identical
   * repeats): the nearest rate within ±10 % that clashes with none, else the one
   * furthest from all of them.
   */
  private freshRate(id: string, rate: number, now: number, max: number): number {
    let recent = this.recentRates.get(id);
    if (!recent) this.recentRates.set(id, (recent = []));
    while (recent.length && now - recent[0].t > REPEAT_WINDOW) recent.shift();
    const gap = (x: number) => {
      let g = Infinity;
      for (const r of recent) g = Math.min(g, Math.abs(x / r.rate - 1));
      return g;
    };
    let best = Math.min(max, rate);
    let bestGap = gap(best);
    for (let k = 1; k <= 25 && bestGap <= REPEAT_RATE; k++)
      for (const x of [rate * (1 - k * 0.004), rate * (1 + k * 0.004)]) {
        const y = Math.min(max, x);
        const g = gap(y);
        if (g > bestGap) {
          best = y;
          bestGap = g;
        }
      }
    recent.push({ t: now, rate: best });
    return best;
  }

  private stopBout(b: RunningBout): void {
    for (const hd of b.handles) hd.stop(0.3);
  }

  private abort(b: RunningBout): void {
    this.stopBout(b);
    this.finish(b);
  }

  private finish(b: RunningBout): void {
    const i = this.bouts.indexOf(b);
    if (i >= 0) this.bouts.splice(i, 1);
    if (b.c.bout === b) b.c.bout = null;
  }

  // ------------------------------------------------------------ reactions

  private onSelect(id: number): void {
    this.selectedId = id;
    const h = this.host;
    if (!h.active) return;
    const a = id >= 0 ? h.sim.animals.get(id) : undefined;
    if (!a || !this.awake(a)) return;
    const c = this.critter(a);
    if (h.time - c.lastSelect < FAUNA.selectGap) return;
    c.lastSelect = h.time;
    const att = h.attenuate(a.x, a.y + 1, a.z);
    if (att.dist > FAUNA.selectDist || this.rng.float() >= FAUNA.selectP) return;
    this.later(this.rng.range(FAUNA.selectDelay[0], FAUNA.selectDelay[1]), id, 'idle', 'react');
  }

  /** A new animal that was not placed by the player is a birth: the baby squeaks, its mother answers. */
  private reactToBirths(): void {
    const h = this.host;
    for (const id of this.births) {
      const a = h.sim.animals.get(id);
      const placed = this.placedAt.get(id);
      if (!a || a.growth >= 0.5 || (placed !== undefined && h.time - placed < 2)) continue;
      if (h.attenuate(a.x, a.y + 1, a.z).dist > FAUNA.birthDist) continue;
      this.later(0, id, 'idle', 'react');
      let mother: AnimalState | null = null;
      let md = Infinity;
      for (const o of h.sim.animals.values()) {
        if (o.speciesId !== a.speciesId || o.sex !== 'F' || o.growth < JUVENILE_GROWTH) continue;
        const d = Math.hypot(o.x - a.x, o.z - a.z);
        if (d < md) {
          md = d;
          mother = o;
        }
      }
      if (mother) this.later(1, mother.id, 'idle', 'react');
    }
    this.births.length = 0;
    for (const [id, t] of this.placedAt) if (h.time - t > 2) this.placedAt.delete(id);
  }

  // ------------------------------------------------------------ colonies

  /** Colony murmur (4 Hz): one loop per colony species and habitat with ≥ 3 members. */
  private colonies(): void {
    const h = this.host;
    const seen = new Set<string>();
    const sums = new Map<string, { sp: SpeciesAudio; n: number; x: number; z: number }>();
    for (const a of h.sim.animals.values()) {
      const c = this.critters.get(a.id);
      if (!c?.sp.colony || a.habitatId === null) continue;
      const key = `colony:${a.habitatId}:${c.voice}`;
      const s = sums.get(key);
      if (s) {
        s.n++;
        s.x += a.x;
        s.z += a.z;
      } else sums.set(key, { sp: c.sp, n: 1, x: a.x, z: a.z });
    }
    for (const [key, s] of sums) {
      if (s.n < 3) continue;
      const att = h.attenuate(s.x / s.n, 0.5, s.z / s.n, s.sp.refDist, s.sp.radius);
      const id = s.sp.colony!.loopId;
      if (!h.has(id)) h.request(id);
      // on the world channel so the 'Animals & effects' volume covers it; ×1.375 keeps the
      // level it was tuned at on the ambience channel (channel levels 0.4 vs 0.55)
      h.loop(key, id, COLONY_WORLD_TRIM * colonyLevel(s.sp, s.n, h.hour, h.nightness, att.gain), att.pan, 'world');
      this.colonyKeys.set(key, id);
      seen.add(key);
    }
    for (const [key, id] of this.colonyKeys)
      if (!seen.has(key)) {
        h.loop(key, id, 0, 0, 'world');
        this.colonyKeys.delete(key);
      }
  }

  // ------------------------------------------------------------ foley

  private foley(c: Critter, a: AnimalState, dt: number): void {
    const h = this.host;
    const t = h.time;
    const body = c.body;
    const terrain = h.sim.world.getTerrain(Math.floor(a.x / TILE), Math.floor(a.z / TILE));
    const wet = isWater(terrain);
    const focus = c.closeUp;
    const size = Math.max(0.4, a.growth);
    // footsteps
    if ((a.action === 'walk' || a.action === 'run') && a.speed > 0.2) {
      const stotting = c.voice === 'gazelle' && a.action === 'run' ? 2 : 1;
      const speed = a.speed * (SPEED[h.sim.speed] ?? 1) * stotting;
      c.phase = stepCrossings(c.phase, speed, body.stride * size, dt, this.offsets);
      for (const off of this.offsets) {
        c.foot ^= 1;
        const db = STEP_DB + (focus ? CLOSE_STEP_DB : 0) + (c.foot ? 1.5 : -1.5) + this.rng.range(-2, 2);
        const bank = wet ? 'fx.splash.small' : FEET_BANK[body.feet];
        this.playFoley(c, bank, (wet ? Math.max(0.3, body.mass) : body.mass) * size * db2lin(db), body.rateScale * this.rng.range(0.95, 1.05), off, focus);
      }
    }
    // actions
    if (c.dived) this.playFoley(c, 'fx.dive', FOLEY_GAIN.dive * size, body.rateScale, 0, focus);
    if (c.pourAt >= 0 && c.pourAt < t + dt) {
      this.playFoley(c, 'fx.pour', FOLEY_GAIN.pour, 1, Math.max(0, c.pourAt - t), focus);
      c.pourAt = -1;
    }
    // action sounds due before the next scan are scheduled at their exact time (steady lap / crop cadence)
    const due = Math.max(c.nextAct, t);
    if (due < t + dt) this.actionFoley(c, a, wet, focus, size, due);
    // close-up body sounds of the animal the player looks at
    if (!focus) return;
    if (a.action === 'eat' && t >= c.nextChew) {
      c.nextChew = t + 1.2;
      this.playFoley(c, 'fx.chew', FOLEY_GAIN.chew * size, body.rateScale, 0, true);
    }
    if (body.breath > 0 && t >= c.nextBreath) {
      c.nextBreath = t + this.rng.range(4, 8);
      if (a.action !== 'swim') this.playFoley(c, 'fx.breath.big', FOLEY_GAIN.breath * body.breath * size, body.rateScale * this.rng.range(0.95, 1.05), 0, true);
    }
    if (c.voice === 'elephant' && t >= c.nextFlap) {
      c.nextFlap = t + this.rng.range(6, 20);
      this.playFoley(c, 'fx.flap', FOLEY_GAIN.flap * size, this.rng.range(0.9, 1.1), 0, true);
    }
    if (body.tail && t >= c.nextTail) {
      c.nextTail = t + this.rng.range(5, 15);
      if (a.action !== 'swim' && a.action !== 'sleep') this.playFoley(c, 'fx.tail', FOLEY_GAIN.tail, this.rng.range(0.9, 1.15), 0, true);
    }
    if (c.voice === 'elephant' && t >= c.nextDust) {
      c.nextDust = t + this.rng.range(30, 90);
      if (a.action === 'idle' && (terrain === Terrain.Dirt || terrain === Terrain.Sand)) this.playFoley(c, 'fx.dust', FOLEY_GAIN.dust, 1, 0, true);
    }
  }

  /** Drinking, grazing and swimming sounds at time `due`; sets the next one from the action's cadence. */
  private actionFoley(c: Critter, a: AnimalState, wet: boolean, focus: boolean, size: number, due: number): void {
    const off = due - this.host.time;
    const r = this.rng;
    const body = c.body;
    if (a.action === 'drink') {
      if (c.voice === 'elephant') {
        this.playFoley(c, 'fx.suck', FOLEY_GAIN.suck * size, r.range(0.95, 1.05), off, focus);
        c.pourAt = due + 1.2;
        c.nextAct = due + r.range(4, 6);
      } else if (wet && !body.laps) {
        this.playFoley(c, 'fx.splash.small', FOLEY_GAIN.wade * size, body.rateScale * r.range(0.95, 1.05), off, focus);
        c.nextAct = due + r.range(1.5, 2.5);
      } else {
        this.playFoley(c, 'fx.lap', FOLEY_GAIN.lap * size, r.range(0.93, 1.07) / Math.max(0.8, body.rateScale), off, focus);
        c.nextAct = due + LAP_SPACING * r.range(0.9, 1.1);
      }
    } else if (a.action === 'eat' && body.grazer) {
      this.playFoley(c, 'fx.crop', FOLEY_GAIN.crop * size, r.range(0.9, 1.1), off, focus);
      c.nextAct = due + r.range(1.5, 3);
    } else if (a.action === 'swim') {
      const big = body.mass >= 0.6 && r.chance(0.5);
      this.playFoley(
        c,
        big ? 'fx.splash.big' : 'fx.splash.small',
        big ? FOLEY_GAIN.swimBig : FOLEY_GAIN.swim * Math.max(0.5, body.mass),
        body.rateScale * r.range(0.95, 1.05),
        off,
        focus,
      );
      c.nextAct = due + r.range(0.8, 1.5);
      if ((c.voice === 'hippo' || c.voice === 'elephant') && due >= c.nextSurface) {
        c.nextSurface = due + r.range(15, 40);
        this.playFoley(c, 'fx.surface', FOLEY_GAIN.surface, body.rateScale * r.range(0.95, 1.05), off + 0.3, focus);
      }
    } else c.nextAct = due + 0.3;
  }

  /** One foley start through the limiter (≤ 6/s, ≤ 1 per source per 0.15 s); inaudible ones are not started. */
  private playFoley(c: Critter, bank: FoleyBank, gain: number, rate: number, offset: number, focus: boolean): boolean {
    const h = this.host;
    if ((gain * FAUNA.foleyRef) / Math.max(FAUNA.foleyRef, c.dist) < (focus ? FAUNA.foleyMin : 2 * FAUNA.foleyMin)) return false;
    const when = h.now() + offset;
    const count = FOLEY_BANKS[bank];
    const id = this.picker.pick(bank, count, this.has, this.rng);
    const missing = this.picker.missing(bank, count, this.has);
    if (missing) h.request(missing);
    if (!id || !this.limiter.take(c.id, when)) return false;
    const handle = h.play({
      id,
      track: c.id,
      pool: 'foley',
      gain,
      rate,
      when,
      refDist: FAUNA.foleyRef,
      radius: FAUNA.foleyRadius,
      prio: gain * (focus ? FAUNA.boost : 1),
    });
    if (handle) this.foleyStarts++;
    return !!handle;
  }

  // ------------------------------------------------------------ guests

  /** Steps of the nearest walking guests on paved, gravel or boardwalk paths (4 Hz). */
  private guestFeet(dt: number): void {
    const h = this.host;
    const l = h.listener;
    if (l.camDist >= FAUNA.guestCam) {
      this.guestSteps.clear();
      return;
    }
    const best: { id: number; d: number }[] = [];
    for (const g of h.sim.guests.values()) {
      if (g.action !== 'walk' || g.speed < 0.1) continue;
      const d = Math.hypot(g.x - l.x, g.y - l.y, g.z - l.z);
      if (d > FAUNA.guestDist) continue;
      if (best.length < FAUNA.guestMax) best.push({ id: g.id, d });
      else {
        let w = 0;
        for (let i = 1; i < best.length; i++) if (best[i].d > best[w].d) w = i;
        if (d < best[w].d) best[w] = { id: g.id, d };
      }
    }
    const keep = new Set(best.map((b) => b.id));
    for (const id of this.guestSteps.keys()) if (!keep.has(id)) this.guestSteps.delete(id);
    const mult = SPEED[h.sim.speed] ?? 1;
    for (const { id } of best) {
      const g = h.sim.guests.get(id)!;
      const bank = guestStepBank(h.sim.world.getPath(Math.floor(g.x / TILE), Math.floor(g.z / TILE)));
      let st = this.guestSteps.get(id);
      if (!st) this.guestSteps.set(id, (st = { phase: this.rng.float(), foot: 0 }));
      st.phase = stepCrossings(st.phase, guestCadence(g.speed * mult, g.appearance.child), 1, dt, this.offsets);
      if (!bank) continue;
      for (const off of this.offsets) {
        st.foot ^= 1;
        this.guestStep(-1 - id, bank, { x: g.x, y: g.y, z: g.z }, db2lin(FAUNA.guestDb + (st.foot ? 2 : -2) + this.rng.range(-2, 2)), off);
      }
    }
  }

  private guestStep(key: number, bank: FoleyBank, at: { x: number; y: number; z: number }, gain: number, offset: number): void {
    const h = this.host;
    const when = h.now() + offset;
    const id = this.picker.pick(bank, FOLEY_BANKS[bank], this.has, this.rng);
    const missing = this.picker.missing(bank, FOLEY_BANKS[bank], this.has);
    if (missing) h.request(missing);
    if (!id || !this.limiter.take(key, when)) return;
    if (h.play({ id, at, pool: 'foley', gain, rate: this.rng.range(0.96, 1.04), when, refDist: FAUNA.foleyRef, radius: FAUNA.foleyRadius })) this.foleyStarts++;
  }
}

/** The module with its own random seed (tests run many seeds). */
export function createFauna(host: AudioHost, seed = 0xfa0a): AudioModule {
  return new Fauna(host, seed);
}

const factory: AudioModuleFactory = (host) => createFauna(host);
export default factory;
