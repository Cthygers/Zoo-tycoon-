// Every animal sound: vocal bouts (call series, idles, night roaring, choruses
// that spread through a group), colony murmur loops, foley (footsteps,
// drinking, eating, breathing, swimming), reactions to the player (placement,
// births, selection, escapes) and guest footsteps by path surface.
//
// The focus animal (the one the camera follows, else the selected one in view,
// else one resting at the screen centre, else the nearest under a hovering
// camera) is a close-up microphone: its voice a few dB forward, its body sounds
// close-miked, its signature call now and then, a silence drawn afresh after
// every sound (never long, never a clock), and a herd that keeps talking 6 dB
// under it and answers it; the zoo's directors stand down around it. Mid and
// far views hear the zoo: every habitat on screen makes contact calls now and
// then, landmark calls carry across the view. Rare calls stay rare (a zoo-wide
// budget per species), no species becomes a view's monologue (shares of the
// energy heard and of the energy at the caller), lions roar by count (a dusk
// chorus, a few roars in the night, a dawn chorus; a game started late in the
// night opens quietly), and the zoo holds its calls while the tutorial speaks.

import { TILE } from '../../core/constants';
import { SPEED_MULTIPLIERS } from '../../core/contracts';
import { Rng } from '../../core/rng';
import { Terrain, isWater, type AnimalState } from '../../core/types';
import { SPECIES_BY_ID } from '../../data/species';
import {
  JUVENILE_DB,
  JUVENILE_GROWTH,
  JUVENILE_MAX_RATE,
  MAX_JOINERS,
  VariantPicker,
  boutSpan,
  hasBout,
  individual,
  juvenilePitch,
  pickBout,
  planBout,
  planJoins,
  type BoutItem,
  type Individual,
} from '../fauna/bout';
import {
  ACTIVE_HOURS,
  ANSWERS,
  LANDMARKS,
  PRESENCE_CAM,
  ROAR_ACTIVITY,
  ZOO_RATE,
  activityAt,
  calmBout,
  carryRefDist,
  colonyLevel,
  daytimeCall,
  idleActivity,
  idleRate,
  idleWeight,
  isRoar,
  landmarkBout,
  nightCaller,
  pickKind,
  pickWeighted,
  schedRate,
  signatureBout,
  spontaneousReach,
} from '../fauna/diel';
import { jittered, jitteredIn } from '../fauna/clock';
import { HoverFocus } from '../fauna/focus';
import {
  BREATH_RANGE,
  CHEW_EVERY,
  CLOSE_STEP_DB,
  CLOSE_STEP_MASS,
  FEET_BANK,
  FOLEY_SPECIES,
  FoleyLimiter,
  PANT_EVERY,
  PANT_FOR,
  QUIET,
  QUIET_SPAN,
  RUSTLE_EVERY,
  SLEEP_BREATH,
  SLEEP_BREATH_DB,
  SLEEP_RUSTLE,
  STEP_DB,
  foleyBankFor,
  guestCadence,
  guestStepBank,
  registeredVariants,
  stepCrossings,
  type FoleyKind,
  type FoleySpecies,
} from '../fauna/foley';
import { FLOCK_BURST, FLOCK_BURST_GAP, RareBudget, isRare, rareHour } from '../fauna/rare';
import { RoarCount } from '../fauna/roar';
import { HEARD_LIMIT, HEARD_WINDOW, ShareLimiter, heardEnergy, refEnergy } from '../fauna/share';
import { RATE_SPREAD, RepeatGuard, playColor, seriesColor } from '../fauna/variety';
import type { AudioHost, AudioModule, AudioModuleFactory, VoiceHandle } from '../host';
import { RECIPES, SPECIES_AUDIO, registerRecipes, sylId, voiceIdFor, type Bout, type BoutKind, type SpeciesAudio } from '../recipes';
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
  /** Per species: at most one new bout per this many s; per animal, one per `animalGap` s (reactions aside). */
  speciesGap: 1.5,
  animalGap: 1.5,
  /** Per animal: idle cooldown, s. */
  idleCooldown: 12,
  /** The focus animal idles on its own clock: cooldown, s, then a rate per s (a little above its zoo-wide rate). */
  focusCooldown: 4,
  focusRate: 0.35,
  /** The focus animal's own calls at most this many a minute: beyond that a herd-mate calls instead. */
  focusCallsPerMin: 8,
  /** The focus animal's voice comes forward by this much, dB (not its roars and displays: loud enough as they are). */
  focusVocalDb: 5,
  /** ... and its foley (steps, breath, chewing) by this much: body sounds stay well under the voice. */
  focusFoleyDb: 0,
  /**
   * Its foley is close-miked: heard as from min(ear distance, foleyRef + closeMic × camera distance) m
   * (5.3 m at the game's 23.4 m follow framing), so its steps, laps and chews carry to the follow framing.
   */
  closeMic: 0.1,
  /**
   * Herd-mates within `mateRadius` m of the focus animal keep their idle rate, `mateDb` under its voice
   * (every syllable, their roars and chorus joins too); their foley `mateFoleyDb` under its foley.
   */
  mateRadius: 15,
  mateDb: -6,
  mateFoleyDb: -9,
  /**
   * ... and start at most this many bouts a minute between them [colony, herd] (their answers
   * to the focus animal count but are never held back), so it is not drowned by its flock.
   */
  mateCallsPerMin: [12, 4] as const,
  /** Animals in the focus animal's habitat idle at full reach, ×`habitatBoost`. */
  habitatBoost: 1.5,
  /** A herd-mate answers the focus animal's contact call with this chance, after [min, max] s. */
  answerP: 0.4,
  answerDelay: [1, 3] as const,
  /**
   * Signature moments: the focus animal's species call after `sigFirst` s in focus, then
   * every `sigEvery` s; its idle clock plays one instead with chance `sigP`, at most one per
   * `sigGap` s.
   */
  sigFirst: [15, 30] as const,
  sigEvery: [45, 90] as const,
  sigP: 0.3,
  sigGap: [20, 30] as const,
  /** Select and follow start: the animal answers with its signature call with this chance, else an idle. */
  callP: 0.65,
  /** An awake idle of an animal that calls lying down at night (a giraffe) is its night call with this chance (asleep: always). */
  nightCallP: 0.3,
  /** Resting breath intervals over the body families [shortest, longest], s (per family: FOLEY_SPECIES.breathEvery). */
  focusBreath: BREATH_RANGE,
  /** A breath sits at least this far under the animal's idle call as heard (the focus animal's voice is forward), dB. */
  breathUnderIdle: 6,
  /** A sleeping flamingo grunts softly instead of a rustle now and then (chance per rustle), dB re a lion roar. */
  sleepyGruntP: 0.3,
  sleepyGruntDb: -18,
  /** A selected animal further than this from the camera focus is not the one in view, m. */
  selectRadius: 25,
  /**
   * Close views (camera within this many m of its focus): vocal bouts of animals over
   * `farDist` m away are quieter and one at a time, about one syllable per `farGap` s.
   */
  closeView: 20,
  farDist: 30,
  farGap: 4,
  farDb: -4,
  /** The colony murmur under a close-up on one of its members, dB. */
  colonyFocusDb: -6,
  /** Water splashes of animals out of focus: at most `waterMax` per habitat in any `waterWindow` s. */
  waterMax: 2,
  waterWindow: 3,
  /** Foley limiter: starts per second, of which `foleyReserve` are kept for the focus animal. */
  foleyMax: 6,
  foleyReserve: 2,
  /**
   * Night roaring (fauna/roar.ts RoarCount): once the dusk or dawn chorus may start it
   * comes with chance `chorusDue` per s; the roars between them with `roarDue` per s.
   */
  chorusDue: 0.3,
  roarDue: 0.05,
  /** A bout whose animal stays below 0.01 gain this long is dropped, s. */
  quietAbort: 2,
  /** A sim 'call' action younger than this starts a call bout, s. */
  callEdge: 1.5,
  /** The focus animal: idle weight ×boost (and foley priority). */
  boost: 4,
  /**
   * Hovering: animals within `nearRadius` m of the camera focus while the camera is within
   * `nearCam` m of it (where the engine's focus mix fades out, FOCUS_CAM[1]).
   */
  nearRadius: 12,
  nearCam: 34,
  /** Hovering: the nearest animal is the focus (fauna/focus.ts); the others within `nearRadius` idle ×`nearBoost`. */
  nearBoost: 2,
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
  /**
   * Mid and far views (camera over PRESENCE_CAM m from its focus): every habitat on screen
   * with awake animals makes a contact or idle call about every `presenceEvery` s, and by day
   * a landmark call (a species' rare call, as its budget allows) sounds somewhere on screen
   * about every `landmarkEvery` s (intervals drawn around the middle of these ranges). On
   * screen: within the camera distance of the focus point (clamped to `viewRadius` m), and
   * ahead of it, where the camera looks, up to `viewAhead` × that and `viewRadius[1]` m.
   */
  presenceEvery: [14, 30] as const,
  landmarkEvery: [12, 28] as const,
  /** A landmark voice takes its turn with its activity at this hour relative to its peak, at least this chance. */
  landmarkFloor: 0.3,
  viewRadius: [30, 90] as const,
  viewAhead: 1.5,
  /** ... beside the line of sight: the view radius plus this × the distance ahead. */
  viewWiden: 0.5,
  /** Focus views: presence and landmark callers within this many m of the camera focus point stand down. */
  focusClear: 40,
  /** While the tutorial speaks (host speech duck) and this many s after, the zoo's directors hold their calls. */
  speechResume: 2,
  /** Hovering: a sleeping animal counts this many m further from the screen centre (an awake neighbour is heard). */
  sleepPenalty: 2,
  /** Mid and far views: colony birds further than this from the ear idle only in the murmur loop, m. */
  colonyIdleDist: 25,
  /** Penguin colonies: `colonyMin` birds within `colonyRadius` m in their active hours display every `colonyEvery` s. */
  colonyMin: 4,
  colonyRadius: 15,
  colonyEvery: [30, 60] as const,
  /** The share limiter leaves alone a species with a member this near the camera focus point, m. */
  shareNear: 30,
  /** Reactions. */
  placeDelay: [0.8, 1.5] as const,
  placeGap: 2,
  birthDist: 45,
  selectDist: 40,
  selectDelay: [0.15, 0.4] as const,
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
  flap: 0.35,
  tail: 0.25,
  rustle: 0.15,
  dust: 0.4,
  swim: 0.35,
  swimBig: 0.5,
  surface: 0.6,
  dive: 0.55,
} as const;
/** A weight shift close up: one step this far under a close-up footstep, dB. */
const SHIFT_DB = -6;

/** Bout group ids (layered syllables share one voice). The feedback module uses 0x40000000 and up. */
const GROUP_BASE = 0x100000;

type Trigger = 'sched' | 'sim' | 'idle' | 'focus' | 'join' | 'roar' | 'react' | 'force' | 'signature' | 'landmark' | 'presence' | 'colony' | 'answer';
const TRIGGERS: readonly Trigger[] = ['sched', 'sim', 'idle', 'focus', 'join', 'roar', 'react', 'force', 'signature', 'landmark', 'presence', 'colony', 'answer'];
/** Starts that skip the per-species gap: reactions, choruses, the focus animal and its herd's answers. */
const NO_GAP: ReadonlySet<Trigger> = new Set<Trigger>(['react', 'force', 'roar', 'join', 'focus', 'signature', 'answer']);
/** Starts that may replace the quietest running bout whatever its level. */
const URGENT: ReadonlySet<Trigger> = new Set<Trigger>(['react', 'force', 'roar', 'signature', 'landmark']);
/** Moments the species-share limiter never holds back. */
const MOMENTS: ReadonlySet<Trigger> = new Set<Trigger>(['react', 'force', 'roar', 'signature', 'landmark', 'colony', 'answer']);
/** Starts the heard-energy share never holds back: the player's own moments and the night's counted roars. */
const HEARD_EXEMPT: ReadonlySet<Trigger> = new Set<Trigger>(['react', 'force', 'roar', 'signature', 'answer', 'focus']);
/** Starts held back while the tutorial speaks: the zoo's directors, scheduled calls, choruses and signature moments. */
const HUSHED: ReadonlySet<Trigger> = new Set<Trigger>(['sched', 'sim', 'presence', 'landmark', 'colony', 'signature', 'roar', 'join']);

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
  /** Start of its last bout (host.time). */
  lastStart: number;
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
  nextRustle: number;
  nextFlap: number;
  nextTail: number;
  nextDust: number;
  nextSurface: number;
  /** Last time it was seen running (big cats pant after a run). */
  ranAt: number;
  /** Time spent at the camera focus (auto-follow). */
  atFocus: number;
  /** Near the camera focus under a hovering camera (last scan): idles more often. */
  boosted: boolean;
  /** The focus animal of the last scan. */
  focus: boolean;
  /** In the focus animal's habitat (last scan): idles at full reach. */
  habitat: boolean;
  /** Of the focus animal's species in its habitat (last scan): never held by the share limiter. */
  herd: boolean;
  /** A herd-mate within `mateRadius` m of the focus animal (last scan): heard just under it, answers it. */
  mate: boolean;
  /** Last start of one of its sounds other than a footstep (host.time). */
  lastHeard: number;
  /** Close up and awake: the silence after which it makes a sound, drawn afresh after each filler, s. */
  quietFor: number;
  /** Its last interval per clock (breath, rustle, tail, ...): the next one is never the same. */
  readonly gaps: Map<Clock, number>;
  /** Asleep (last scan). */
  asleep: boolean;
  /** Last syllable variant per bank (no variant twice in a row from one animal). */
  readonly lastSyl: Map<string, string>;
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
  /** Direction (±1) of the bout's colour drift across its series. */
  readonly drift: number;
  /** A lion's full roaring bout: no syllable of it comes forward. */
  readonly roar: boolean;
  /** Carries like a call in mid and far views (calls, displays and the presence and landmark directors' bouts). */
  readonly carry: boolean;
}

/** The repeating close-up sounds of an animal, each on its own irregular clock. */
type Clock = 'breath' | 'rustle' | 'tail' | 'flap' | 'dust' | 'chew' | 'quiet';

interface Pending {
  at: number;
  id: number;
  /** A bout kind, or the species' signature call at that moment. */
  kind: BoutKind | 'signature';
  trigger: Trigger;
  /** A join of a roaring chorus (roars in full; others call by day). */
  roar?: boolean;
}

const SPEED = SPEED_MULTIPLIERS as readonly number[];
/** Bout kinds that spread through a group (choruses); idles, eating and social chatter stay individual. */
const CHORUS: ReadonlySet<BoutKind> = new Set<BoutKind>(['call', 'contact', 'display', 'night', 'alarm']);
/** Idle chatter (not calls): it recedes in mid and far views, to CHATTER_TRIM at the overview. */
const CHATTER: ReadonlySet<BoutKind> = new Set<BoutKind>(['idle', 'eat', 'social', 'juvenile']);
const CHATTER_TRIM = 0.3;
/** A species whose activity at this hour is under this is asleep by its rhythm: no presence calls (a gorilla at night). */
const PRESENCE_ASLEEP = 0.05;
/** Water foley capped per habitat when out of focus. */
const WATER: ReadonlySet<string> = new Set(['fx.splash.small', 'fx.splash.big']);
/** Lions joining the dusk and dawn roaring choruses (the lion's roars outweigh every other voice of the zoo). */
const CHORUS_ROAR_JOINERS = 1;
/** A sleeping flamingo's grunt (played at FAUNA.sleepyGruntDb). */
const SLEEPY_GRUNT: Bout = { kind: 'idle', steps: [{ syl: 'grunt', n: [1, 1], ioi: [1, 1] }] };
const db2lin = (db: number) => Math.pow(10, db / 20);
/** Colony murmur runs on the world channel; this keeps the level it was tuned at on the ambience channel. */
const COLONY_WORLD_TRIM = 0.55 / 0.4;

class Fauna implements AudioModule {
  readonly ownsAnimals = true;
  private readonly rng: Rng;
  private readonly picker = new VariantPicker();
  private readonly has = (id: string) => this.host.has(id);
  private readonly limiter = new FoleyLimiter(FAUNA.foleyMax, 1, 0.15, FAUNA.foleyReserve);
  private readonly water = new Map<number, FoleyLimiter>();
  private readonly repeats = new RepeatGuard();
  private readonly share = new ShareLimiter();
  /** The energy the player hears per species (no view becomes one species' monologue). */
  private readonly heard = new ShareLimiter(HEARD_WINDOW, HEARD_LIMIT);
  private readonly rare = new RareBudget();
  private readonly roars: RoarCount;
  private readonly hover = new HoverFocus();
  /** Family foley banks resolved per kind and voice, with their variant counts. */
  private readonly familyBanks = new Map<string, string>();
  private readonly bankSizes = new Map<string, number>();
  private readonly critters = new Map<number, Critter>();
  private readonly bouts: RunningBout[] = [];
  private readonly pending: Pending[] = [];
  private readonly lastBoutAt = new Map<string, number>();
  private readonly colonyKeys = new Map<string, string>();
  private readonly guestSteps = new Map<number, { phase: number; foot: number }>();
  private readonly warmedVoices = new Set<string>();
  private readonly unsub: (() => void)[] = [];
  private readonly offsets: number[] = [];
  private readonly inRange: Critter[] = [];
  /** Voices audible at the last complete scan (the share limiter acts only when another one is). */
  private readonly audible = new Set<string>();
  /** Per voice: its member nearest the camera focus point (last scan), m. */
  private readonly nearestOf = new Map<string, number>();
  private readonly near: Critter[] = [];
  private readonly mates: Critter[] = [];
  private readonly idlers: Critter[] = [];
  private readonly foleyList: Critter[] = [];
  /** Mid and far views: next presence call per habitat (host.time) and its last voice; the next landmark call. */
  private readonly presenceAt = new Map<number, number>();
  private readonly presenceLast = new Map<number, string>();
  private landmarkAt = 0;
  private landmarkNext = 0;
  /** Last presence and landmark intervals (never the same twice). */
  private presenceGap = 0;
  private landmarkGap = 0;
  /** Flamingo flocks out of focus: last honking burst per habitat (host.time). */
  private readonly flockBurstAt = new Map<number, number>();
  /** The zoo's directors hold their calls until this time (the tutorial speaks). */
  private hushUntil = -1e9;
  /** On screen in mid and far views (schedule tick): camera focus point, line of sight on the ground, view radius. */
  private readonly view = { fx: 0, fz: 0, ux: 0, uz: 0, r: 30 };
  /** Penguin colonies: next display per group key. */
  private readonly colonyAt = new Map<string, number>();
  private nextGroup = GROUP_BASE;
  /** Time since each periodic pass last ran (start due). */
  private scanAcc: number = FAUNA.scan;
  private dielAcc = 1;
  private colonyAcc = 0.25;
  private guestAcc: number = FAUNA.guestScan;
  private warmed = false;
  private selectedId = -1;
  private autoFollow = -1;
  private prevFollow = -1;
  /** The focus animal of the last scan, or −1. */
  private focusId = -1;
  /** The focus animal's signature moments (host.time): the next scheduled one and the earliest of any. */
  private nextSig = 0;
  private sigFree = 0;
  /** Start times of the focus animal's own calls, and of its herd-mates' bouts, in the last minute. */
  private readonly focusCalls: number[] = [];
  private readonly mateCalls: number[] = [];
  /** Close views: no far vocal bout starts before this time (host.time). */
  private farUntil = -1e9;
  private readonly placedAt = new Map<number, number>();
  private lastPlaceReact = -1e9;
  private readonly births: number[] = [];
  private readonly started = Object.fromEntries(TRIGGERS.map((t) => [t, 0])) as Record<Trigger, number>;
  /** Bouts held back by the species-share limiter and the far-vocal ration; syllables that had to repeat. */
  private shareHeld = 0;
  private farHeld = 0;
  private repeated = 0;
  private foleyStarts = 0;
  private joinsPlanned = 0;
  private roaring = 0;
  private lastBout: Record<string, unknown> | null = null;

  constructor(
    private readonly host: AudioHost,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    this.roars = new RoarCount(this.rng.float());
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
    // every voice has its own breath / chew / drink family banks (below), so the generic breath and lap are never played
    for (const b of ['fx.splash.small', 'fx.crop'] as const) ids.push(`${b}#0`);
    // per-family breath / chew / drink banks of the species present, once registered
    for (const voice of this.warmedVoices)
      for (const kind of ['breath', 'chew', 'drink'] as const) {
        // birds ruffle their feathers instead of breathing
        const base = this.familyBank(kind === 'breath' && !FOLEY_SPECIES[voice]?.breathEvery ? 'rustle' : kind, voice);
        if (this.bankSize(base) > 0 && !ids.includes(`${base}#0`)) ids.push(`${base}#0`);
      }
    if (this.host.sim.guests.size) ids.push('fx.gstep.paved#0', 'fx.gstep.gravel#0', 'fx.gstep.board#0');
    return ids;
  }

  update(dt: number): void {
    if (!this.host.active) return;
    const running = this.host.sim.speed > 0;
    if (this.speaking()) this.hushUntil = this.host.time + FAUNA.speechResume;
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
      roaring: this.roaring,
      foley: this.foleyStarts,
      shareHeld: this.shareHeld,
      farHeld: this.farHeld,
      repeated: this.repeated,
      focusId: this.focusId,
      followId: this.host.followId >= 0 ? this.host.followId : this.autoFollow,
      selectedId: this.selectedId,
      near: this.near.map((c) => c.id),
      mates: this.mates.map((c) => c.id),
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
        lastStart: -1e9,
        gain: 0,
        dist: 1e9,
        focusDist: 1e9,
        phase: this.rng.float(),
        foot: 0,
        nextAct: t,
        pourAt: -1,
        nextChew: t,
        nextBreath: t + this.rng.range(0.5, 3),
        nextRustle: t + this.rng.range(2, RUSTLE_EVERY[0]),
        nextFlap: t + this.rng.range(2, 8),
        nextTail: t + this.rng.range(1, 6),
        nextDust: t + this.rng.range(10, 40),
        nextSurface: t + this.rng.range(5, 20),
        ranAt: -1e9,
        atFocus: 0,
        boosted: false,
        focus: false,
        habitat: false,
        herd: false,
        mate: false,
        lastHeard: t,
        quietFor: QUIET,
        gaps: new Map(),
        asleep: a.action === 'sleep',
        lastSyl: new Map(),
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

  /** Mid and far views: a colony bird beyond `colonyIdleDist` m idles only in its colony's murmur loop. */
  private murmured(c: Critter): boolean {
    return !!c.sp.colony && this.host.listener.camDist > PRESENCE_CAM && c.dist > FAUNA.colonyIdleDist;
  }

  /** Versus matches run the sim locked at 4×: sim-driven sounds are thinned to the density of 1×. */
  private pace(): number {
    const p = (this.host.sim as { paceScale?: number }).paceScale ?? 1;
    // a non-number pace (NaN would silence every sim-driven sound) counts as 1×, like feedback.ts paceOf
    return Number.isFinite(p) && p > 1 ? p : 1;
  }

  /** The tutorial's read-aloud is speaking: the host's speech duck (`speech`, read structurally: optional on AudioHost). */
  private speaking(): boolean {
    return (this.host as { readonly speech?: boolean }).speech === true;
  }

  /** A random draw that keeps 1 in `pace` sim-driven sounds. */
  private paced(): boolean {
    return this.rng.float() * this.pace() < 1;
  }

  private awake(a: AnimalState): boolean {
    return a.action !== 'sleep';
  }

  /** One pass over the animals: audibility, the focus and its herd, sim edges (call, escape, dive), idle lottery and foley. */
  private scan(dt: number, running: boolean): void {
    const h = this.host;
    const l = h.listener;
    const hovering = l.camDist <= FAUNA.nearCam;
    const foleyOn = running && l.zoomNear > FAUNA.foleyZoom;
    const foleyDist = FAUNA.foleyDist[h.lowSpec ? 1 : 0];
    this.inRange.length = 0;
    this.near.length = 0;
    this.idlers.length = 0;
    this.foleyList.length = 0;
    this.nearestOf.clear();
    let follow: Critter | null = null;
    for (const a of h.sim.animals.values()) {
      const c = this.critter(a);
      c.dived = false;
      c.asleep = a.action === 'sleep';
      const att = h.attenuate(a.x, a.y + 1, a.z, c.sp.refDist, c.sp.radius);
      c.gain = att.gain;
      c.dist = att.dist;
      c.focusDist = Math.hypot(a.x - l.fx, a.z - l.fz);
      if (c.focusDist < (this.nearestOf.get(c.voice) ?? Infinity)) this.nearestOf.set(c.voice, c.focusDist);
      c.atFocus = c.focusDist <= FAUNA.followRadius ? c.atFocus + dt : 0;
      if (c.atFocus > FAUNA.followAfter && (!follow || c.focusDist < follow.focusDist)) follow = c;
      if (hovering && c.focusDist <= FAUNA.nearRadius) this.near.push(c);
      if (a.action === 'run') c.ranAt = h.time;
      if (c.gain >= FAUNA.inRange) {
        this.inRange.push(c);
        if (running && !c.bout && this.awake(a) && h.time - c.lastIdle >= FAUNA.idleCooldown && !this.murmured(c)) this.idlers.push(c);
      }
      if (foleyOn && c.dist <= foleyDist) this.foleyList.push(c);
    }
    this.autoFollow = follow ? follow.id : -1;
    this.audible.clear();
    for (const c of this.inRange) this.audible.add(c.voice);
    this.near.sort((p, q) => p.focusDist - q.focusDist);
    const hoverFocus = this.setFocus(dt, hovering);
    this.markHerd(hoverFocus, running);
    for (const c of this.foleyList) {
      const a = h.sim.animals.get(c.id);
      if (a) this.foley(c, a, dt);
    }
    if (running) {
      this.focusIdles(dt);
      this.idleLottery(dt);
    }
  }

  /**
   * The focus animal, by precedence: the one the camera follows, the selected one
   * within selectRadius of the camera focus, one resting at the focus point
   * (auto-follow), else under a hovering camera the nearest (HoverFocus: it keeps
   * the focus until another is clearly nearer for a while). True for a hover focus.
   */
  private setFocus(dt: number, hovering: boolean): boolean {
    const h = this.host;
    const l = h.listener;
    let id = h.followId >= 0 && h.sim.animals.has(h.followId) ? h.followId : -1;
    if (id < 0) {
      const s = this.selectedId >= 0 ? h.sim.animals.get(this.selectedId) : undefined;
      if (s && Math.hypot(s.x - l.fx, s.z - l.fz) <= FAUNA.selectRadius) id = s.id;
      else id = this.autoFollow;
    }
    const hover = id < 0 && hovering;
    if (!hover) this.hover.reset();
    else {
      // the animal at the screen centre; a sleeping one counts a little further (its awake neighbour is heard)
      let n: Critter | null = null;
      for (const x of this.near) if (!n || this.centreDist(x) < this.centreDist(n)) n = x;
      const cur = this.critters.get(this.hover.current);
      id = this.hover.update(dt, n ? n.id : -1, n ? this.centreDist(n) : Infinity, cur ? this.centreDist(cur) : Infinity);
    }
    if (id !== this.focusId) {
      // a handover within a herd keeps its signature schedule and call ration
      const herd = this.critters.get(id)?.voice === this.critters.get(this.focusId)?.voice;
      this.focusId = id;
      if (!herd) {
        this.nextSig = h.time + this.rng.range(FAUNA.sigFirst[0], FAUNA.sigFirst[1]);
        this.focusCalls.length = this.mateCalls.length = 0;
      }
    }
    // following starts: the animal answers like a tap
    if (h.followId !== this.prevFollow) {
      this.prevFollow = h.followId;
      if (h.followId >= 0) this.greet(h.followId);
    }
    return hover && id >= 0;
  }

  /** Hovering: an animal's distance from the screen centre, a sleeping one's FAUNA.sleepPenalty further. */
  private centreDist(c: Critter): number {
    return c.focusDist + (c.asleep ? FAUNA.sleepPenalty : 0);
  }

  /** Flags of the last scan: the focus, its habitat, herd and mates; animals under a hovering camera; sim edges. */
  private markHerd(hoverFocus: boolean, running: boolean): void {
    const h = this.host;
    const f = h.sim.animals.get(this.focusId);
    const fv = f ? this.critters.get(f.id)?.voice : undefined;
    const hab = f?.habitatId ?? null;
    this.mates.length = 0;
    for (const a of h.sim.animals.values()) {
      const c = this.critter(a);
      c.focus = c.id === this.focusId;
      c.habitat = !!f && !c.focus && hab !== null && a.habitatId === hab;
      c.herd = c.habitat && c.voice === fv;
      c.mate = c.herd && Math.hypot(a.x - f!.x, a.z - f!.z) <= FAUNA.mateRadius;
      c.boosted = false;
      if (c.mate) this.mates.push(c);
      if (running) this.edges(c, a);
      c.prevAction = a.action;
      c.prevEscaped = a.escaped;
    }
    // hovering: the other animals under the camera idle more often too
    if (hoverFocus) for (const c of this.near) c.boosted = !c.focus;
  }

  /** Sim edges: a new 'call' action (if reached), the start of a swim (dive), an escape. */
  private edges(c: Critter, a: AnimalState): void {
    // a 4× versus match calls and dives 4× as often per real second: keep 1 in `pace`
    if (a.action === 'call' && c.prevAction !== 'call' && a.actionTime < FAUNA.callEdge && c.gain >= FAUNA.inRange && !c.bout && this.paced() && this.reached(c)) {
      const b = this.boutFor(c, a, ['call', 'display']);
      if (b) this.start(c, a, b, 'sim');
    }
    if (a.action === 'swim' && c.prevAction !== 'swim') c.dived = (c.voice === 'penguin' || c.voice === 'polarbear') && (c.focus || this.paced());
    if (a.escaped && !c.prevEscaped) {
      if (c.bout) this.abort(c.bout);
      const b = this.boutFor(c, a, ['alarm', 'call', 'display']);
      if (b) this.start(c, a, b, 'react');
    }
  }

  /**
   * How readily an animal starts spontaneous bouts, 0..1: in the focus animal's
   * habitat in full, else by spontaneousReach (close views: the animals in them;
   * mid and far views: the whole view).
   */
  private reach(c: Critter): number {
    if (c.habitat || c.focus) return 1;
    return spontaneousReach(c.dist, c.focusDist, this.host.listener.camDist, c.sp.refDist);
  }

  private reached(c: Critter): boolean {
    return this.rng.float() < this.reach(c);
  }

  private speciesFree(voice: string): boolean {
    return this.host.time - (this.lastBoutAt.get(voice) ?? -1e9) >= FAUNA.speciesGap;
  }

  /**
   * The focus animal's own clock: its signature moments (after 15–30 s in focus,
   * then every 45–90 s; a lying giraffe hums at night), and an idle about every
   * 4–7 s, now and then its signature call instead.
   */
  private focusIdles(dt: number): void {
    const h = this.host;
    const c = this.critters.get(this.focusId);
    if (!c || c.bout || c.gain < FAUNA.inRange) return;
    const a = h.sim.animals.get(c.id);
    if (!a) return;
    // a signature moment, not on the heels of the last one or of its last call
    if (h.time >= this.nextSig && h.time >= this.sigFree && h.time - c.lastIdle >= 2) {
      this.nextSig = h.time + this.rng.range(FAUNA.sigEvery[0], FAUNA.sigEvery[1]);
      if (this.signature(c, a)) return;
    }
    // a giraffe lying at night idles too: it hums
    const lyingCaller = nightCaller(c.sp, a, h.hour, h.nightness);
    if ((!this.awake(a) && !lyingCaller) || h.time - c.lastIdle < FAUNA.focusCooldown || this.rng.float() >= FAUNA.focusRate * dt) return;
    if (h.time >= this.sigFree && this.rng.float() < FAUNA.sigP && this.signature(c, a)) return;
    this.focusCall(c, a);
  }

  /** The focus animal's signature call for this hour (exempt from the share limiter). */
  private signature(c: Critter, a: AnimalState): boolean {
    const h = this.host;
    const b = this.youngBout(c, a) ?? signatureBout(c.sp, a, h.hour, h.nightness, this.rng);
    // asleep, only a night call of a species that calls lying down (a giraffe's hum)
    if (!b || (!this.awake(a) && !(c.sp.callsWhileAsleep && b.kind === 'night'))) return false;
    if (!this.start(c, a, b, 'signature')) return false;
    c.lastIdle = h.time;
    this.sigFree = h.time + this.rng.range(FAUNA.sigGap[0], FAUNA.sigGap[1]);
    return true;
  }

  /** The focus animal's own idle call, at most focusCallsPerMin a minute: beyond that a herd-mate calls instead. */
  private focusCall(c: Critter, a: AnimalState): boolean {
    const h = this.host;
    const calls = this.focusCalls;
    while (calls.length && h.time - calls[0] >= 60) calls.shift();
    if (calls.length >= FAUNA.focusCallsPerMin) return this.mateCall();
    const b = this.contextBout(c, a);
    if (!b || !this.start(c, a, b, 'focus')) return false;
    calls.push(h.time);
    c.lastIdle = h.time;
    return true;
  }

  private mateCall(): boolean {
    const m = this.freeMate();
    const a = m && this.host.sim.animals.get(m.id);
    const b = a && this.contextBout(m, a);
    if (!m || !a || !b || !this.start(m, a, b, 'idle')) return false;
    m.lastIdle = this.host.time;
    return true;
  }

  /** A random awake herd-mate of the focus animal without a bout, or null. */
  private freeMate(): Critter | null {
    const free = this.mates.filter((m) => {
      const a = this.host.sim.animals.get(m.id);
      return !m.bout && !!a && this.awake(a);
    });
    return free.length ? free[this.rng.int(0, free.length - 1)] : null;
  }

  /** After a contact call of the focus animal a herd-mate answers now and then. */
  private answer(c: Critter, kind: BoutKind): void {
    const ans = ANSWERS[c.voice];
    if (!ans?.to.includes(kind) || this.rng.float() >= FAUNA.answerP) return;
    const m = this.freeMate();
    if (m) this.later(this.rng.range(FAUNA.answerDelay[0], FAUNA.answerDelay[1]), m.id, ans.kind, 'answer');
  }

  /**
   * Never silent for long: an awake focus animal unheard (steps aside) for its
   * current silence (drawn afresh after every filler around its body's typical
   * one: no clock) makes a sound from a mixed pool: a call (as the minute's ration
   * allows), a breath when one is nearly due, a tail swish, an ear flap, a cud
   * chew or a weight shift; birds ruffle their feathers. Swimming, it calls.
   * Asleep it is quiet: its slow breaths and rare rustles keep their own clocks.
   */
  private fillSilence(c: Critter, a: AnimalState, wet: boolean, size: number): void {
    const h = this.host;
    const body = c.body;
    if (c.bout || c.asleep || h.time - c.lastHeard < c.quietFor) return;
    c.quietFor = this.interval(c, 'quiet', [body.quiet ?? QUIET, body.quiet ?? QUIET], QUIET_SPAN);
    const bird = !body.breathEvery;
    if (a.action === 'swim') {
      if (!this.focusCall(c, a)) c.lastHeard = h.time; // nothing to say now: look again later
      return;
    }
    const pool: [string, number][] = [
      ['call', 0.35],
      ['shift', 0.2],
    ];
    if (bird) pool.push(['rustle', 0.3]);
    else if (h.time >= c.nextBreath - 1.5) pool.push(['breath', 0.25]);
    if (body.tail) pool.push(['tail', 0.15]);
    if (c.voice === 'elephant') pool.push(['flap', 0.2]);
    if (body.cud && a.action !== 'eat') pool.push(['cud', 0.15]);
    switch (pickWeighted(pool, (p) => p[1], this.rng)?.[0]) {
      case 'call':
        if (this.focusCall(c, a)) return;
        break;
      case 'breath':
        return this.breathe(c, a, size);
      case 'rustle':
        return this.rustle(c, a);
      case 'tail':
        if (this.playFoley(c, a, 'fx.tail', FOLEY_GAIN.tail, this.rng.range(0.9, 1.15), 0)) return;
        break;
      case 'flap':
        if (this.playFoley(c, a, 'fx.flap', FOLEY_GAIN.flap * size, this.rng.range(0.9, 1.1), 0)) return;
        break;
      case 'cud':
        if (this.playFoley(c, a, this.familyBank('chew', c.voice), FOLEY_GAIN.chew * 0.7 * size, body.rateScale, 0)) return;
        break;
    }
    this.shift(c, a, wet, size);
  }

  /** A weight shift: one soft step on the spot. */
  private shift(c: Critter, a: AnimalState, wet: boolean, size: number): void {
    const body = c.body;
    const db = STEP_DB + (body.stepDb ?? 0) + CLOSE_STEP_DB + SHIFT_DB + this.rng.range(-2, 2);
    const bank = wet ? 'fx.splash.small' : FEET_BANK[body.feet];
    this.playFoley(c, a, bank, Math.max(body.mass, CLOSE_STEP_MASS) * size * db2lin(db), body.rateScale * this.rng.range(0.95, 1.05), 0);
  }

  /**
   * Idle lottery (every scan): rate from the candidates' chattiness, reach and
   * activity at this hour; weights favour the ear, the focus, its habitat and awake hours.
   */
  private idleLottery(dt: number): void {
    const free = this.idlers.filter((c) => this.speciesFree(c.voice));
    let sumChatty = 0;
    // the animals the player looks at raise the rate as well as winning the draw
    for (const c of free) sumChatty += this.chatty(c) * this.reach(c) * this.boost(c);
    if (!free.length || this.rng.float() >= idleRate(sumChatty) * dt) return;
    const c = pickWeighted(free, (x) => idleWeight(this.chatty(x), x.dist, this.boost(x)), this.rng);
    const a = c && this.host.sim.animals.get(c.id);
    if (!c || !a) return;
    const b = this.contextBout(c, a);
    if (b && this.start(c, a, b, 'idle')) c.lastIdle = this.host.time;
  }

  /** Idle-lottery boost: ×4 for the focus, ×1.5 in its habitat, ×2 under a hovering camera. */
  private boost(c: Critter): number {
    if (c.focus) return FAUNA.boost;
    return (c.boosted ? FAUNA.nearBoost : 1) * (c.habitat ? FAUNA.habitatBoost : 1);
  }

  /** Idle propensity at this hour: the species' chattiness × its zoo-wide trim × its activity (diurnal animals barely idle at night). */
  private chatty(c: Critter): number {
    return c.sp.chatty * (ZOO_RATE[c.voice]?.idle ?? 1) * idleActivity(c.sp, this.host.hour);
  }

  /** Idle kind by context: eating, a walking gorilla's pig grunts (in its active hours), a lying giraffe's hum at night, a neighbour, a youngster. */
  private contextBout(c: Critter, a: AnimalState): Bout | null {
    const sp = c.sp;
    const h = this.host;
    let kind: BoutKind = 'idle';
    if (a.action === 'eat' && hasBout(sp, 'eat')) kind = 'eat';
    // lying at night: asleep it only hums, awake now and then
    else if ((!this.awake(a) || this.rng.float() < FAUNA.nightCallP) && nightCaller(sp, a, h.hour, h.nightness)) kind = 'night';
    else if (c.voice === 'gorilla' && a.action === 'walk' && hasBout(sp, 'contact') && activityAt(sp, h.hour) >= 0.4) kind = 'contact';
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

  /**
   * Diel scheduler (1 Hz): per species group in range, scheduled bouts by daily
   * activity and reach (or the zoo-wide presence floor); a pride roars as the
   * night's roar count allows; penguin colonies display; mid and far views get
   * presence and landmark calls. While the tutorial speaks every clock waits (its
   * calls are deferred, not queued into a burst for afterwards).
   */
  private schedule(dt: number): void {
    const h = this.host;
    if (h.time < this.hushUntil) {
      this.defer(dt);
      return;
    }
    const hour = ((h.hour % 24) + 24) % 24;
    const camDist = h.listener.camDist;
    const slot = activityAt(SPECIES_AUDIO.lion, hour) >= ROAR_ACTIVITY ? this.roars.slot(hour, h.time) : null;
    // the dusk and dawn choruses come soon after they may; the roars between them are spread through the night
    let roarDue = !!slot && this.rng.float() < (slot === 'extra' ? FAUNA.roarDue : FAUNA.chorusDue) * dt;
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
      let reach = 0;
      for (const c of g) reach = Math.max(reach, this.reach(c));
      const roar = roarDue && sp.voice === 'lion';
      let p = schedRate(sp, h.hour, reach, camDist) * dt;
      if (sp.voice === 'lion' && g.every((c) => h.sim.animals.get(c.id)?.sex === 'F')) p *= 0.5;
      if (!roar && this.rng.float() >= p) continue;
      const free = g.filter((c) => {
        const a = h.sim.animals.get(c.id);
        return !!a && !c.bout && (sp.callsWhileAsleep || this.awake(a)) && (!roar || a.growth >= JUVENILE_GROWTH);
      });
      if (!free.length) continue;
      const c = free[this.rng.int(0, free.length - 1)];
      const a = h.sim.animals.get(c.id)!;
      const b = roar ? pickBout(sp, 'call', a.sex, this.rng) : (this.youngBout(c, a) ?? pickKind(sp, h.nightness, a, this.rng, h.hour));
      if (b && this.start(c, a, b, roar ? 'roar' : 'sched')) roarDue &&= !roar;
    }
    this.colonyDisplays(groups);
    if (camDist > PRESENCE_CAM) {
      this.updateView();
      this.presence();
      if (h.nightness <= 0.5) this.landmark();
    } else this.presenceAt.clear();
  }

  /** The directors' clocks wait `dt` s (the tutorial speaks). */
  private defer(dt: number): void {
    for (const [k, t] of this.presenceAt) this.presenceAt.set(k, t + dt);
    for (const [k, t] of this.colonyAt) this.colonyAt.set(k, t + dt);
    this.landmarkAt += dt;
  }

  /** Mid and far views: the radius around the camera focus point that counts as in view, m. */
  private viewRadius(): number {
    return Math.min(FAUNA.viewRadius[1], Math.max(FAUNA.viewRadius[0], this.host.listener.camDist));
  }

  /** What is on screen this tick: the camera focus point, the line of sight on the ground (ear → focus) and the view radius. */
  private updateView(): void {
    const l = this.host.listener;
    const v = this.view;
    const ux = l.fx - l.x;
    const uz = l.fz - l.z;
    const n = Math.hypot(ux, uz);
    v.fx = l.fx;
    v.fz = l.fz;
    v.ux = n > 1e-3 ? ux / n : 0;
    v.uz = n > 1e-3 ? uz / n : 0;
    v.r = this.viewRadius();
  }

  /**
   * Mid and far views: whether an animal is on screen: within the view radius of the
   * camera focus point, or ahead of it where the camera looks (up to `viewAhead` × the
   * radius, widening sideways), never beyond viewRadius[1] m. A focus view's directors
   * stand down around the focus point.
   */
  private onScreen(c: Critter): boolean {
    if (this.focusId >= 0 && c.focusDist <= FAUNA.focusClear) return false;
    if (c.focusDist <= this.view.r) return true;
    if (c.focusDist > FAUNA.viewRadius[1]) return false;
    const a = this.host.sim.animals.get(c.id);
    if (!a) return false;
    const v = this.view;
    const dx = a.x - v.fx;
    const dz = a.z - v.fz;
    const ahead = dx * v.ux + dz * v.uz;
    return ahead > 0 && ahead <= FAUNA.viewAhead * v.r && Math.abs(dx * v.uz - dz * v.ux) <= v.r + FAUNA.viewWiden * ahead;
  }

  /** A species is over its share of the energy heard recently (with another species audible): its turn goes to another. */
  private heardOver(voice: string): boolean {
    return this.othersInRange(voice) && this.heard.over(voice, this.host.time);
  }

  /**
   * Presence director: every habitat on screen with awake animals makes a contact
   * or idle call about every `presenceEvery` s, its species taking turns weighted
   * by their activity at this hour (and calling only as often as that activity
   * says); a species over its heard share rarely gets the turn, and species asleep
   * by their rhythm (a gorilla at night, a giraffe at night) none.
   */
  private presence(): void {
    const h = this.host;
    const night = h.nightness > 0.5;
    const habitats = new Map<number, Critter[]>();
    for (const c of this.inRange) {
      const a = h.sim.animals.get(c.id);
      if (!a || a.habitatId === null || c.asleep || (night && c.voice === 'giraffe') || !this.onScreen(c)) continue;
      const list = habitats.get(a.habitatId);
      if (list) list.push(c);
      else habitats.set(a.habitatId, [c]);
    }
    for (const k of this.presenceAt.keys()) if (!habitats.has(k)) this.presenceAt.delete(k);
    for (const [hab, list] of habitats) {
      const due = this.presenceAt.get(hab);
      // a habitat coming into view starts at a random point of its cycle
      if (due === undefined) this.presenceAt.set(hab, h.time + this.rng.range(0, FAUNA.presenceEvery[1]));
      if (due === undefined || h.time < due) continue;
      this.presenceAt.set(hab, h.time + (this.presenceGap = jitteredIn(FAUNA.presenceEvery, this.rng, this.presenceGap)));
      const last = this.presenceLast.get(hab);
      const voices = [...new Set(list.map((c) => c.voice))];
      const weight = (v: string) => (activityAt(SPECIES_AUDIO[v], h.hour) < PRESENCE_ASLEEP ? 0 : idleActivity(SPECIES_AUDIO[v], h.hour) * (v === last ? 0.3 : 1) * (this.heardOver(v) ? 0.1 : 1));
      const voice = pickWeighted(voices, weight, this.rng);
      if (!voice || this.rng.float() >= idleActivity(SPECIES_AUDIO[voice], h.hour)) continue;
      let c: Critter | null = null;
      for (const x of list) if (x.voice === voice && !x.bout && (!c || x.focusDist < c.focusDist)) c = x;
      const a = c && h.sim.animals.get(c.id);
      if (!c || !a) continue;
      const b = this.youngBout(c, a) ?? (nightCaller(c.sp, a, h.hour, h.nightness) ? pickBout(c.sp, 'night', a.sex, this.rng) : calmBout(c.sp, a, this.rng));
      if (b && this.start(c, a, b, 'presence')) this.presenceLast.set(hab, voice);
    }
  }

  /**
   * Landmark calls (by day): about every `landmarkEvery` s the next landmark voice on
   * screen whose rare-call budget allows (and whose daily rhythm says so) makes its
   * signature call, its member nearest the camera focus; none when no voice may.
   */
  private landmark(): void {
    const h = this.host;
    if (h.time < this.landmarkAt) return;
    this.landmarkAt = h.time + (this.landmarkGap = jitteredIn(FAUNA.landmarkEvery, this.rng, this.landmarkGap));
    for (let k = 0; k < LANDMARKS.length; k++) {
      const i = (this.landmarkNext + k) % LANDMARKS.length;
      const voice = LANDMARKS[i];
      if (!this.speciesFree(voice) || this.heardOver(voice)) continue;
      let c: Critter | null = null;
      for (const x of this.inRange) if (x.voice === voice && !x.bout && (!c || x.focusDist < c.focusDist) && this.onScreen(x)) c = x;
      const a = c && h.sim.animals.get(c.id);
      if (!c || !a || (c.asleep && !c.sp.callsWhileAsleep)) continue;
      // a species takes its turn as often as its daily rhythm says (a lion by day now and then)
      if (this.rng.float() >= Math.max(FAUNA.landmarkFloor, idleActivity(c.sp, h.hour))) continue;
      const b = landmarkBout(c.sp, a, h.hour, h.nightness, this.rng);
      if (!b || (isRare(voice, b) && !this.rareFree(c, a))) continue;
      if (this.start(c, a, b, 'landmark')) {
        this.landmarkNext = i + 1;
        return;
      }
    }
  }

  /** Penguin colonies of `colonyMin` birds within `colonyRadius` m display about every 30–60 s in their active hours (as their budget allows). */
  private colonyDisplays(groups: ReadonlyMap<string, Critter[]>): void {
    const h = this.host;
    for (const [key, g] of groups) {
      const sp = g[0].sp;
      if (sp.voice !== 'penguin') continue;
      if (g.length < FAUNA.colonyMin || activityAt(sp, h.hour) < ACTIVE_HOURS) {
        this.colonyAt.delete(key);
        continue;
      }
      const due = this.colonyAt.get(key);
      if (due === undefined) this.colonyAt.set(key, h.time + this.rng.range(FAUNA.colonyEvery[0], FAUNA.colonyEvery[1]));
      if (due === undefined || h.time < due) continue;
      const birds = g.map((c) => h.sim.animals.get(c.id)).filter((a): a is AnimalState => !!a);
      const r2 = FAUNA.colonyRadius ** 2;
      const caller = g.find((c) => {
        const a = h.sim.animals.get(c.id);
        if (!a || c.bout || c.asleep) return false;
        let n = 0;
        for (const o of birds) if ((o.x - a.x) ** 2 + (o.z - a.z) ** 2 <= r2) n++;
        return n >= FAUNA.colonyMin;
      });
      const a = caller && h.sim.animals.get(caller.id);
      const b = a && caller && this.rareFree(caller, a) ? pickBout(sp, 'call', a.sex, this.rng) : null;
      const ok = !!caller && !!a && !!b && this.start(caller, a, b, 'colony');
      // no colony together now (busy, or its budget spent): look again in a few seconds
      this.colonyAt.set(key, h.time + (ok ? jitteredIn(FAUNA.colonyEvery, this.rng) : 5));
    }
  }

  // ------------------------------------------------------------ bouts

  /**
   * Start a bout. Gates: no new bouts while paused; one new bout per species per
   * 1.5 s (reactions, choruses, the focus animal and its herd's answers skip it);
   * far animals in a close view one at a time, about one syllable per `farGap` s;
   * spontaneous bouts of species out of view held back while over their share of
   * the zoo's vocal energy, and any species' while over its share of the energy
   * heard; at most 3 at once (2 on lowSpec): a louder newcomer (or an urgent one)
   * replaces the quietest running bout. A lion's full roar needs a slot of the
   * night's roar count; otherwise its call is moans and grunts. A rare call needs
   * its species' budget (the focus animal's species: only the focus animal), else
   * the species calls calmly; a flamingo flock out of focus bursts with a few honks
   * at most every FLOCK_BURST_GAP s. The zoo's directors wait while the tutorial speaks.
   */
  private start(c: Critter, a: AnimalState, bout: Bout, trigger: Trigger, levelDb?: number): boolean {
    const h = this.host;
    if (h.sim.speed === 0 && trigger !== 'force') return false;
    if (HUSHED.has(trigger) && h.time < this.hushUntil) return false;
    if (!NO_GAP.has(trigger) && !this.speciesFree(c.voice)) return false;
    if (c.bout || (trigger !== 'react' && trigger !== 'force' && h.time - c.lastStart < FAUNA.animalGap)) return false;
    if (c.mate && !MOMENTS.has(trigger) && this.matesBusy(c)) return false;
    const urgent = URGENT.has(trigger);
    const sp = c.sp;
    if (!urgent && !c.focus && this.far(c) && h.time < this.farUntil) {
      this.farHeld++;
      return false;
    }
    // joins ride on their caller's roar; forced bouts (probes) roar as asked
    // a lion's full roar takes a slot of the night's count (not a landmark or presence call's: those are single voices of a view)
    const counted = isRoar(sp, bout) && trigger !== 'force' && trigger !== 'join';
    const slot = counted && trigger !== 'landmark' && trigger !== 'presence' && activityAt(sp, h.hour) >= ROAR_ACTIVITY ? this.roars.slot(h.hour, h.time) : null;
    // without a slot a lion calls softly, alone (its daytime call does not set off a chorus)
    const soft = counted && !slot;
    if (soft) bout = daytimeCall(sp, bout);
    const roar = isRoar(sp, bout);
    // rare calls stay rare (the night's roars are on their own count)
    let rareKey: string | null = null;
    if (trigger !== 'force' && !roar && isRare(c.voice, bout)) {
      if (this.rareFree(c, a)) rareKey = this.rareKey(c, a);
      else {
        const calm = calmBout(sp, a, this.rng);
        if (!calm) return false;
        bout = calm;
      }
    }
    const flock = c.voice === 'flamingo' && bout.kind === 'call' && !c.focus && !c.mate ? (a.habitatId ?? -1) : null;
    if (flock !== null && h.time - (this.flockBurstAt.get(flock) ?? -1e9) < FLOCK_BURST_GAP) return false;
    const juvenile = a.growth < JUVENILE_GROWTH;
    const gainDb = (levelDb ?? sp.levels[bout.kind] ?? sp.levels.idle ?? -12) + c.ind.db + (juvenile ? JUVENILE_DB : 0);
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
    if (flock !== null) items.length = Math.min(items.length, this.rng.int(FLOCK_BURST[0], FLOCK_BURST[1]));
    if (!items.length) return false;
    const carry = bout.kind === 'call' || bout.kind === 'display' || trigger === 'presence' || trigger === 'landmark';
    // spontaneous bouts of species out of view wait while they have had their share
    if (!MOMENTS.has(trigger) && !this.shareExempt(c) && this.othersInRange(c.voice)) {
      let energy = 0;
      for (const it of items) energy += refEnergy(db2lin(gainDb + it.db), this.sylDur(c.voice, it.syl) / it.rate, refDist);
      if (this.share.over(c.voice, h.time, energy)) {
        this.shareHeld++;
        return false;
      }
    }
    // ... and any species but the focus herd while it has had its share of what the player hears
    if (!HEARD_EXEMPT.has(trigger) && !c.herd && !c.focus && this.othersInRange(c.voice)) {
      const att = h.attenuate(a.x, a.y + 1, a.z, this.carryRef(carry, c.dist, refDist), radius).gain * this.chatterTrim(bout.kind, trigger);
      let energy = 0;
      for (const it of items) energy += heardEnergy(db2lin(gainDb + it.db) * att, this.sylDur(c.voice, it.syl) / it.rate);
      if (this.heard.over(c.voice, h.time, energy)) {
        this.shareHeld++;
        return false;
      }
    }
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
      drift: this.rng.float() < 0.5 ? -1 : 1,
      roar,
      carry,
    };
    this.bouts.push(rb);
    c.bout = rb;
    c.lastStart = h.time;
    this.lastBoutAt.set(c.voice, h.time);
    // one far bout at a time, and on average at most one far syllable per farGap s
    if (!urgent && !c.focus && this.far(c)) this.farUntil = h.time + Math.max(FAUNA.farGap * items.length, boutSpan(items, (syl) => this.sylDur(c.voice, syl)));
    if (slot) this.roars.take(slot, h.time);
    if (rareKey) this.rare.take(rareKey, c.voice, h.time, this.rng);
    if (flock !== null) this.flockBurstAt.set(flock, h.time);
    if (roar) this.roaring++;
    this.started[trigger]++;
    this.lastBout = { voice: c.voice, kind: bout.kind, trigger, animal: c.id, items: items.length, span: +items[items.length - 1].t.toFixed(2) };
    // presence and landmark calls are single voices of the view: they do not set off choruses
    // a roar in the night is one lion's, the dusk and dawn choruses a pair's; other choruses draw up to MAX_JOINERS
    const joiners = !slot ? MAX_JOINERS : slot === 'extra' ? 0 : CHORUS_ROAR_JOINERS;
    if (trigger !== 'join' && trigger !== 'presence' && trigger !== 'landmark' && !soft && CHORUS.has(bout.kind)) this.spread(c, a, bout.kind, roar, joiners);
    if (c.focus && trigger !== 'answer') this.answer(c, bout.kind);
    if (c.mate) this.mateCalls.push(h.time);
    return true;
  }

  /** The rare-call budget key: a penguin colony's own, else the species'. */
  private rareKey(c: Critter, a: AnimalState): string {
    return c.voice === 'penguin' ? `penguin:${a.habitatId ?? -1}` : c.voice;
  }

  /**
   * Whether an animal may make a rare call now: at this hour at all (no chest-beating at
   * night), within its species' budget, and, while the camera is on an animal of its
   * species, only that animal (signatures belong to the focus moments).
   */
  private rareFree(c: Critter, a: AnimalState): boolean {
    if (!rareHour(c.voice, this.host.hour)) return false;
    const f = this.focusId >= 0 && !c.focus ? this.critters.get(this.focusId) : undefined;
    if (f && f.voice === c.voice) return false;
    return this.rare.free(this.rareKey(c, a), this.host.time);
  }

  /** The focus animal's herd-mates have had their bouts for this minute. */
  private matesBusy(c: Critter): boolean {
    const t = this.host.time;
    while (this.mateCalls.length && t - this.mateCalls[0] >= 60) this.mateCalls.shift();
    return this.mateCalls.length >= FAUNA.mateCallsPerMin[c.sp.colony ? 0 : 1];
  }

  /**
   * The share limiter leaves alone what the player is looking at: the focus animal
   * and its herd, and any species with a member within `shareNear` m of the camera focus.
   */
  private shareExempt(c: Critter): boolean {
    return c.focus || c.herd || (this.nearestOf.get(c.voice) ?? Infinity) <= FAUNA.shareNear;
  }

  /** Another species is audible: only then does the share limiter hold a voice back. */
  private othersInRange(voice: string): boolean {
    return this.audible.size > (this.audible.has(voice) ? 1 : 0);
  }

  /** Contagion: up to `max` conspecifics near the caller may join after a delay, with the same kind; joins never spread. */
  private spread(c: Critter, a: AnimalState, kind: BoutKind, roar: boolean, max: number): void {
    const con = c.sp.contagion;
    if (!con) return;
    const eligible: number[] = [];
    for (const o of this.host.sim.animals.values()) {
      if (o.id === a.id || o.speciesId !== a.speciesId || Math.hypot(o.x - a.x, o.z - a.z) > con.radius) continue;
      if (this.critters.get(o.id)?.bout || !(c.sp.callsWhileAsleep || this.awake(o))) continue;
      eligible.push(o.id);
    }
    for (const j of planJoins(con, eligible, this.rng, max)) {
      this.later(j.delay, j.id, kind, 'join', roar);
      this.joinsPlanned++;
    }
  }

  private later(delay: number, id: number, kind: Pending['kind'], trigger: Trigger, roar = false): void {
    this.pending.push({ at: this.host.time + delay, id, kind, trigger, roar });
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
      if (c.bout) continue;
      if (p.trigger === 'answer' && !this.awake(a)) continue;
      if (p.trigger === 'join' && (!(c.sp.callsWhileAsleep || this.awake(a)) || !this.reached(c))) continue;
      let b = p.kind === 'signature' ? (this.youngBout(c, a) ?? signatureBout(c.sp, a, h.hour, h.nightness, this.rng)) : this.boutFor(c, a, [p.kind, 'idle']);
      // joiners roar only with a roaring caller
      if (b && p.trigger === 'join' && !p.roar) b = daytimeCall(c.sp, b);
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

  /**
   * One syllable: a variant this animal did not just play and that did not sound
   * at nearly this rate in the last 10 s anywhere in the zoo (else the rate is
   * nudged), a ±4 % rate spread and a per-play colour. The focus animal is a few
   * dB forward (not a roaring bout or a display), its herd-mates 6 dB under it;
   * far voices in a close view a few dB back; in mid and far views calls carry and
   * idle chatter recedes; a landmark call has the ambience make room for it.
   */
  private playItem(b: RunningBout, it: BoutItem, now: number): void {
    const h = this.host;
    const c = b.c;
    const bank = c.sp.syllables[it.syl];
    const base = `syl.${c.voice}.${it.syl}`;
    const count = h.lowSpec ? Math.min(bank.variants, bank.lowSpecVariants ?? 2) : bank.variants;
    const max = b.juvenile ? JUVENILE_MAX_RATE : Infinity;
    const spread = Math.max(RATE_SPREAD, c.sp.rateJitter);
    let rate = Math.min(max, b.rate * it.rate * (1 + this.rng.range(-spread, spread)));
    const when = Math.max(now, b.t0 + it.t);
    const own = c.lastSyl.get(base);
    // never the animal's own last variant, rather not one heard at nearly this rate; among the rest the one heard longest ago anywhere in the zoo
    const id = this.picker.pick(base, count, this.has, this.rng, (x) => (x === own ? 2 : this.repeats.clashes(x, rate, when) ? 1 : 0) + 0.45 * this.repeats.recency(x, when));
    const missing = this.picker.missing(base, count, this.has);
    if (missing) h.request(missing);
    if (!id) return;
    if (this.repeats.clashes(id, rate, when)) {
      const free = this.repeats.freeRate(id, rate, when, max);
      if (free === null) this.repeated++;
      else rate = free;
    }
    this.repeats.note(id, rate, when);
    c.lastSyl.set(base, id);
    const db = b.gainDb + it.db + this.rng.range(-1.5, 1.5);
    const gain = db2lin(db + this.forward(b) + (this.far(c) ? FAUNA.farDb : 0)) * this.chatterTrim(b.kind, b.trigger);
    const refDist = this.carryRef(b.carry, c.dist, b.refDist);
    const handle = h.play({
      id,
      track: c.id,
      pool: 'voice',
      gain,
      rate,
      when,
      group: b.group,
      color: seriesColor(playColor(c.ind, this.rng), b.next - 1, b.items.length, b.drift),
      // calls carry in mid and far views
      refDist,
      radius: b.radius,
      prio: c.focus ? gain * FAUNA.boost : undefined,
      landmark: b.trigger === 'landmark' || undefined,
    });
    if (!handle) return;
    b.handles.push(handle);
    b.endAt = Math.max(b.endAt, handle.endAt);
    c.lastHeard = h.time;
    // the species' shares (the focus animal's own plays aside): at the reference distance and as heard (its herd's aside too)
    const seconds = h.duration(id) / rate;
    if (!c.focus) this.share.add(c.voice, refEnergy(db2lin(db), seconds, b.refDist), h.time);
    const a = h.sim.animals.get(c.id);
    if (a && !c.focus && !c.mate) this.heard.add(c.voice, heardEnergy(gain * h.attenuate(a.x, a.y + 1, a.z, refDist, b.radius).gain, seconds), h.time);
  }

  /** How far a bout's syllables come forward, dB: the focus animal's voice (not a roaring bout or a display), its herd-mates `mateDb` under that. */
  private forward(b: RunningBout): number {
    const own = b.roar || b.kind === 'display' ? 0 : FAUNA.focusVocalDb;
    return b.c.focus ? own : b.c.mate ? own + FAUNA.mateDb : 0;
  }

  /** The reference distance a bout plays at: carried in mid and far views (carryRefDist). */
  private carryRef(carry: boolean, dist: number, refDist: number): number {
    return carryRefDist(carry, dist, refDist, this.host.listener.camDist);
  }

  /** Mid and far views: idle chatter (not calls, nor the directors' calls) recedes with the camera's height, to CHATTER_TRIM (−10 dB) at the overview. */
  private chatterTrim(kind: BoutKind, trigger: Trigger): number {
    const l = this.host.listener;
    const directed = trigger === 'presence' || trigger === 'landmark';
    return CHATTER.has(kind) && !directed && l.camDist > PRESENCE_CAM ? CHATTER_TRIM + (1 - CHATTER_TRIM) * l.zoomNear : 1;
  }

  /** A far animal while the camera is close (its vocal starts are rationed and quieter). */
  private far(c: Critter): boolean {
    return this.host.listener.camDist <= FAUNA.closeView && c.dist > FAUNA.farDist;
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
    if (id >= 0) this.greet(id);
  }

  /** A tapped or newly followed animal answers: its signature call (callP), else an idle. */
  private greet(id: number): void {
    const h = this.host;
    if (!h.active) return;
    const a = h.sim.animals.get(id);
    if (!a || !this.awake(a)) return;
    const c = this.critter(a);
    if (h.time - c.lastSelect < FAUNA.selectGap) return;
    c.lastSelect = h.time;
    if (h.attenuate(a.x, a.y + 1, a.z).dist > FAUNA.selectDist) return;
    this.later(this.rng.range(FAUNA.selectDelay[0], FAUNA.selectDelay[1]), id, this.rng.float() < FAUNA.callP ? 'signature' : 'idle', 'react');
  }

  /** A new animal that was not placed by the player is a birth: the baby squeaks, its mother answers. */
  private reactToBirths(): void {
    const h = this.host;
    for (const id of this.births) {
      const a = h.sim.animals.get(id);
      const placed = this.placedAt.get(id);
      if (!a || a.growth >= 0.5 || (placed !== undefined && h.time - placed < 2)) continue;
      // births come `pace`× as often per real second in a versus match
      if (h.attenuate(a.x, a.y + 1, a.z).dist > FAUNA.birthDist || !this.paced()) continue;
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
    const f = this.focusId >= 0 ? h.sim.animals.get(this.focusId) : undefined;
    const focusKey = f && h.listener.camDist <= FAUNA.closeView ? `colony:${f.habitatId}:${this.critters.get(f.id)?.voice}` : '';
    for (const [key, s] of sums) {
      if (s.n < 3) continue;
      const att = h.attenuate(s.x / s.n, 0.5, s.z / s.n, s.sp.refDist, s.sp.radius);
      const id = s.sp.colony!.loopId;
      if (!h.has(id)) h.request(id);
      // on the world channel so the 'Animals & effects' volume covers it; ×1.375 keeps the
      // level it was tuned at on the ambience channel (channel levels 0.4 vs 0.55)
      // a close-up on one colony member: the murmur steps back so that bird is heard
      const trim = key === focusKey ? db2lin(FAUNA.colonyFocusDb) : 1;
      h.loop(key, id, COLONY_WORLD_TRIM * trim * colonyLevel(s.sp, s.n, h.hour, h.nightness, att.gain), att.pan, 'world');
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
    const focus = c.focus;
    const size = Math.max(0.4, a.growth);
    // footsteps (out of focus, a versus match's 4× walkers keep 1 step in `pace`); pad-footed giants walk softly
    if ((a.action === 'walk' || a.action === 'run') && a.speed > 0.2) {
      const stotting = c.voice === 'gazelle' && a.action === 'run' ? 2 : 1;
      const speed = a.speed * (SPEED[h.sim.speed] ?? 1) * stotting;
      c.phase = stepCrossings(c.phase, speed, body.stride * size, dt, this.offsets);
      // close up even light animals are heard walking (a close-up microphone)
      const mass = focus ? Math.max(body.mass, CLOSE_STEP_MASS) : body.mass;
      for (const off of this.offsets) {
        c.foot ^= 1;
        if (!focus && !this.paced()) continue;
        const db = STEP_DB + (body.stepDb ?? 0) + (focus ? CLOSE_STEP_DB : 0) + (c.foot ? 1.5 : -1.5) + this.rng.range(-2, 2);
        const bank = wet ? 'fx.splash.small' : FEET_BANK[body.feet];
        this.playFoley(c, a, bank, (wet ? Math.max(0.3, mass) : mass) * size * db2lin(db), body.rateScale * this.rng.range(0.95, 1.05), off, true);
      }
    }
    // actions
    if (c.dived) this.playFoley(c, a, 'fx.dive', FOLEY_GAIN.dive * size, body.rateScale, 0);
    if (c.pourAt >= 0 && c.pourAt < t + dt) {
      this.playFoley(c, a, 'fx.pour', FOLEY_GAIN.pour, 1, Math.max(0, c.pourAt - t));
      c.pourAt = -1;
    }
    // action sounds due before the next scan are scheduled at their exact time (steady lap / crop cadence)
    const due = Math.max(c.nextAct, t);
    if (due < t + dt) this.actionFoley(c, a, wet, size, due);
    // close-up body sounds of the animal the player looks at
    if (!focus) return;
    if (a.action === 'eat' && t >= c.nextChew) {
      c.nextChew = t + this.interval(c, 'chew', CHEW_EVERY);
      this.playFoley(c, a, this.familyBank('chew', c.voice), FOLEY_GAIN.chew * size, body.rateScale, 0);
    }
    if (a.action !== 'swim') {
      if (body.breathEvery && t >= c.nextBreath) this.breathe(c, a, size);
      else if (!body.breathEvery && t >= c.nextRustle) this.rustle(c, a);
    }
    // asleep: only its slow breaths and rare rustles
    if (c.asleep) return;
    if (c.voice === 'elephant' && t >= c.nextFlap) {
      c.nextFlap = t + this.interval(c, 'flap', [6, 20]);
      this.playFoley(c, a, 'fx.flap', FOLEY_GAIN.flap * size, this.rng.range(0.9, 1.1), 0);
    }
    if (body.tail && t >= c.nextTail) {
      c.nextTail = t + this.interval(c, 'tail', [5, 15]);
      if (a.action !== 'swim') this.playFoley(c, a, 'fx.tail', FOLEY_GAIN.tail, this.rng.range(0.9, 1.15), 0);
    }
    if (c.voice === 'elephant' && t >= c.nextDust) {
      c.nextDust = t + this.interval(c, 'dust', [30, 90]);
      if (a.action === 'idle' && (terrain === Terrain.Dirt || terrain === Terrain.Sand)) this.playFoley(c, a, 'fx.dust', FOLEY_GAIN.dust, 1, 0);
    }
    this.fillSilence(c, a, wet, size);
  }

  /**
   * The next interval of one of an animal's clocks: drawn around the middle of
   * `range` s (jitteredIn; × `scale`), never the same as its last, within `span` s when given.
   */
  private interval(c: Critter, clock: Clock, range: readonly [number, number], span?: readonly [number, number], scale = 1): number {
    const prev = c.gaps.get(clock) ?? 0;
    const g = span
      ? jittered(((range[0] + range[1]) / 2) * scale, this.rng, prev, span[0], span[1])
      : jitteredIn([range[0] * scale, range[1] * scale], this.rng, prev);
    c.gaps.set(clock, g);
    return g;
  }

  /**
   * One close-up breath, at the family's resting rhythm drawn afresh each time
   * (asleep slower and softer; big cats pant for a few seconds after a run),
   * breathUnderIdle dB under its idle call as heard close up.
   */
  private breathe(c: Critter, a: AnimalState, size: number): void {
    const h = this.host;
    const body = c.body;
    const panting = !!body.pants && !c.asleep && h.time - c.ranAt < PANT_FOR;
    // panting is a steady rhythm; resting and sleeping breaths are not
    c.nextBreath = h.time + (panting ? this.rng.range(PANT_EVERY[0], PANT_EVERY[1]) : this.interval(c, 'breath', body.breathEvery ?? BREATH_RANGE, undefined, c.asleep ? SLEEP_BREATH : 1));
    const db = (c.sp.levels.idle ?? -12) + FAUNA.focusVocalDb - FAUNA.breathUnderIdle + (c.asleep ? SLEEP_BREATH_DB : 0);
    const level = db2lin(db) * Math.min(1, body.breath) * size;
    this.playFoley(c, a, this.familyBank('breath', c.voice), level, body.rateScale * this.rng.range(0.95, 1.05) * (panting ? 1.15 : 1), 0);
  }

  /** A bird ruffles its feathers (no audible breath); asleep rarely, and a sleeping flamingo grunts softly instead now and then. */
  private rustle(c: Critter, a: AnimalState): void {
    c.nextRustle = this.host.time + this.interval(c, 'rustle', c.asleep ? SLEEP_RUSTLE : RUSTLE_EVERY);
    if (c.asleep && c.voice === 'flamingo' && this.rng.float() < FAUNA.sleepyGruntP && this.start(c, a, SLEEPY_GRUNT, 'focus', FAUNA.sleepyGruntDb)) return;
    this.playFoley(c, a, this.familyBank('rustle', c.voice), FOLEY_GAIN.rustle, 1.25 * c.body.rateScale * this.rng.range(0.9, 1.1), 0);
  }

  /** Drinking, grazing and swimming sounds at time `due`; sets the next one from the action's cadence. */
  private actionFoley(c: Critter, a: AnimalState, wet: boolean, size: number, due: number): void {
    const off = due - this.host.time;
    const r = this.rng;
    const body = c.body;
    if (a.action === 'drink') {
      if (c.voice === 'elephant') {
        this.playFoley(c, a, 'fx.suck', FOLEY_GAIN.suck * size, r.range(0.95, 1.05), off);
        c.pourAt = due + 1.2;
        c.nextAct = due + r.range(4, 6);
      } else if (wet && !body.laps) {
        this.playFoley(c, a, 'fx.splash.small', FOLEY_GAIN.wade * size, body.rateScale * r.range(0.95, 1.05), off);
        c.nextAct = due + r.range(1.5, 2.5);
      } else {
        this.playFoley(c, a, this.familyBank('drink', c.voice), FOLEY_GAIN.lap * size, r.range(0.93, 1.07) / Math.max(0.8, body.rateScale), off);
        c.nextAct = due + LAP_SPACING * r.range(0.9, 1.1);
      }
    } else if (a.action === 'eat' && body.grazer) {
      this.playFoley(c, a, 'fx.crop', FOLEY_GAIN.crop * size, r.range(0.9, 1.1), off);
      c.nextAct = due + r.range(1.5, 3);
    } else if (a.action === 'swim') {
      const big = body.mass >= 0.6 && r.chance(0.5);
      this.playFoley(
        c,
        a,
        big ? 'fx.splash.big' : 'fx.splash.small',
        big ? FOLEY_GAIN.swimBig : FOLEY_GAIN.swim * Math.max(0.5, body.mass),
        body.rateScale * r.range(0.95, 1.05),
        off,
      );
      c.nextAct = due + r.range(0.8, 1.5);
      if ((c.voice === 'hippo' || c.voice === 'elephant') && due >= c.nextSurface) {
        c.nextSurface = due + r.range(15, 40);
        this.playFoley(c, a, 'fx.surface', FOLEY_GAIN.surface, body.rateScale * r.range(0.95, 1.05), off + 0.3);
      }
    } else c.nextAct = due + 0.3;
  }

  /** `fx.<kind>.<family>` once the voices owner registers it, else the generic bank (resolved once per kind and voice). */
  private familyBank(kind: FoleyKind, voice: string): string {
    const key = `${kind}:${voice}`;
    let base = this.familyBanks.get(key);
    if (base === undefined) this.familyBanks.set(key, (base = foleyBankFor(kind, voice, isRegistered)));
    return base;
  }

  private bankSize(base: string): number {
    let n = this.bankSizes.get(base);
    if (n === undefined) {
      n = base in FOLEY_BANKS ? FOLEY_BANKS[base as FoleyBank] : registeredVariants(base, isRegistered);
      // lowSpec: one breath, chew, drink and rustle per body family (the largest foley banks)
      if (this.host.lowSpec && /^fx\.(breath|chew|drink|rustle)\.(?!big$)[a-z]+$/.test(base)) n = Math.min(n, 1);
      this.bankSizes.set(base, n);
    }
    return n;
  }

  /**
   * One foley start through the limiters (≤ 6/s of which 2 are kept for the focus
   * animal, ≤ 1 per source per 0.15 s; out of focus at most `waterMax` splashes per
   * habitat per `waterWindow` s); inaudible ones are not started. The focus
   * animal's foley comes forward by `focusFoleyDb`; its herd-mates' sits
   * `mateFoleyDb` under it (a close-up microphone on the focus animal).
   */
  private playFoley(c: Critter, a: AnimalState, bank: string, gain: number, rate: number, offset: number, step = false): boolean {
    const h = this.host;
    if (c.focus) gain *= db2lin(FAUNA.focusFoleyDb);
    else if (c.mate) gain *= db2lin(FAUNA.focusFoleyDb + FAUNA.mateFoleyDb);
    if ((gain * FAUNA.foleyRef) / Math.max(FAUNA.foleyRef, c.dist) < (c.focus ? FAUNA.foleyMin : 2 * FAUNA.foleyMin)) return false;
    const when = h.now() + offset;
    const count = this.bankSize(bank);
    const id = this.picker.pick(bank, count, this.has, this.rng);
    const missing = this.picker.missing(bank, count, this.has);
    if (missing) h.request(missing);
    if (!id || (!c.focus && WATER.has(bank) && !this.waterFor(a.habitatId ?? -1).take(0, when))) return false;
    if (!this.limiter.take(c.id, when, c.focus)) return false;
    const handle = h.play({
      id,
      track: c.id,
      pool: 'foley',
      gain,
      rate,
      when,
      refDist: FAUNA.foleyRef,
      radius: FAUNA.foleyRadius,
      prio: gain * (c.focus ? FAUNA.boost : 1),
    });
    if (!handle) return false;
    this.foleyStarts++;
    if (!step) c.lastHeard = h.time;
    return true;
  }

  private waterFor(habitat: number): FoleyLimiter {
    let w = this.water.get(habitat);
    if (!w) this.water.set(habitat, (w = new FoleyLimiter(FAUNA.waterMax, FAUNA.waterWindow, 0)));
    return w;
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

const isRegistered = (id: string) => id in RECIPES;

/** The module with its own random seed (tests run many seeds). */
export function createFauna(host: AudioHost, seed = 0xfa0a): AudioModule {
  return new Fauna(host, seed);
}

const factory: AudioModuleFactory = (host) => createFauna(host);
export default factory;
