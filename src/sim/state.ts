// Internal (simulation-only) entity state. Each extends the public state type
// from core/types with AI bookkeeping. Everything here is plain JSON data so the
// whole entity can be serialized verbatim and restored exactly.

import type { AnimalAction, AnimalState, GuestState, StaffState } from '../core/types';

export type AnimalGoal =
  | 'idle'
  | 'wander'
  | 'eat'
  | 'graze'
  | 'drink'
  | 'sleep'
  | 'rest'
  | 'social'
  | 'play'
  | 'call'
  | 'swim'
  | 'follow'
  | 'hunt'
  | 'flee'
  | 'breakout'
  | 'roam';

export interface AnimalSim extends AnimalState {
  /** Habitat the animal belongs to (where it is returned after an escape). 0 = none. */
  home: number;
  /**
   * A tile of the habitat it last stood in (-1 = none). If that habitat is gone, the
   * one now covering this tile (e.g. after its fence was rebuilt or moved) is home.
   */
  homeTile: number;
  goal: AnimalGoal;
  /** Seconds left of the stationary part of the current goal. */
  goalTime: number;
  /** Walking towards (tgtX, tgtZ) via `route`. */
  moving: boolean;
  tgtX: number;
  tgtZ: number;
  /** Remaining waypoint tile indices (exclusive of the final exact target). */
  route: number[];
  routeIdx: number;
  /** Object id / animal id the goal refers to (feeder, toy, herd mate, prey…). 0 = none. */
  ref: number;
  /** Seconds until needs are re-evaluated while busy. */
  think: number;
  /** Seconds without progress towards the current waypoint while moving. */
  stuck: number;
  /** Closest distance (m) to the current waypoint so far (-1 = not measured yet). */
  bestDist: number;
  /** Mother id while young (0 = none). */
  mother: number;
  /** Game days until this animal may breed again. */
  breedCooldown: number;
  sick: boolean;
  /** Game hours until the next dung drop. */
  dungIn: number;
  /** 0..1 fear / stress (predators nearby, chased). */
  stress: number;
  /** Seconds spent outside a habitat after escaping. */
  escapeTime: number;
  /** Fence crossing permitted for the current breakout step. */
  crossing: boolean;
  /** Seconds since the last 'call'. */
  sinceCall: number;
  /** Heading to turn to on arrival (NO_FACE = keep current). */
  face: number;
}

/** Sentinel for "no facing requested" (JSON-safe, unlike NaN). */
export const NO_FACE = 99;

export type GuestGoal = 'enter' | 'wander' | 'view' | 'shop' | 'restroom' | 'sit' | 'donate' | 'leave';
/**
 * 0 walk the path grid, 1 approach a spot inside the tile, 2 perform the action,
 * 3 walk out through the gate, 4 follow the party leader (children / companions).
 */
export type WalkPhase = 0 | 1 | 2 | 3 | 4;

export interface Walker {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  /** Tile index the walker last reached (z * MAP_W + x). */
  tile: number;
  /** Tile index being walked to (-1 = none). */
  next: number;
  /** Tile reached before `tile` (-1 = none); keeps random walks going straight. */
  prev: number;
  /** Lateral lane offset (m) to the right of the travel direction. */
  lane: number;
  walkSpeed: number;
  phase: WalkPhase;
  /** Micro-move target for phase 1 (world metres). */
  ax: number;
  az: number;
  /** Heading to face when the action starts. */
  faceHeading: number;
  /** Field key of the current navigation goal ('' = wander). */
  goalKey: string;
  /** Remaining random-walk steps while wandering. */
  wanderSteps: number;
  /** Seconds spent unable to progress. */
  stuck: number;
}

export interface GuestSim extends GuestState, Walker {
  goal: GuestGoal;
  /** Habitat id / object id / shop kind index the goal refers to. */
  goalRef: number;
  /** Seconds left in the current action. */
  timer: number;
  /** Seconds left eating / drinking the held item. */
  holdTime: number;
  /** Seconds until the guest wants to head home. */
  visitLeft: number;
  /** Seconds until needs are re-checked while walking. */
  think: number;
  /** Short-term happiness modifier from events (decays to 0). */
  mood: number;
  /** Fun gained per second during the current 'watch'. */
  funRate: number;
  /** Bench seat taken (object id, 0 = none) and seat slot. */
  seatObj: number;
  seatIdx: number;
  /** Seconds until the next look at the surroundings. */
  lookTimer: number;
  donated: boolean;
  /** Habitat ids already viewed this visit. */
  viewed: number[];
  /**
   * Habitat the party set out to see (0 = none). Kept through a snack, a restroom
   * break or a look at another exhibit on the way, so the walk resumes there.
   */
  plan: number;
  /**
   * Happiness offset from the ticket price, compared with what the zoo seemed
   * worth at the gate: slightly positive for a bargain, negative when overpriced.
   */
  ticketValue: number;
  /** 0..1 scenery around the guest (smoothed). */
  scenic: number;
  /** Shop / restroom object the guest is walking to or queueing at (0 = none). */
  qObj: number;
  /** -1 walking to the line; 0.. place in line; QP_SERVE+k at counter / door k; QP_INSIDE inside. */
  qPos: number;
  /** Seconds spent waiting in the current line. */
  qWait: number;
  /** Party leader's id for companions and children (0 = leads the party / alone). */
  leader: number;
  /** Ids of the companions following this guest (leaders only). */
  party: number[];
  /** Companion sub-state: 0 follow, 1 walking to a seat, 2 seated. */
  fstate: number;
  /** A shop whose queue was too long, avoided until `avoidUntil` (simulated seconds). */
  avoidObj: number;
  avoidUntil: number;
}

export type StaffJob = 'none' | 'service' | 'litter' | 'heal' | 'recapture' | 'patrol';

export interface StaffSim extends StaffState, Walker {
  job: StaffJob;
  /** Habitat id / litter tile / animal id the job refers to. */
  jobRef: number;
  timer: number;
  think: number;
  noAccessWarned: boolean;
}

export interface HabitatRuntime {
  id: number;
  /** Food stock in hunger-units (1 unit fills one medium animal from empty). */
  food: number;
  /** A tile inside the habitat used to identify it across save/load. */
  sample: number;
  /** Where food is left when there is no feeder (world metres, -1 = unset). */
  spotX: number;
  spotZ: number;
  /** Game minutes since a keeper last serviced it. */
  sinceService: number;
}

export const ANIMAL_ACTION_FOR_GOAL: Record<AnimalGoal, AnimalAction> = {
  idle: 'idle',
  wander: 'idle',
  eat: 'eat',
  graze: 'eat',
  drink: 'drink',
  sleep: 'sleep',
  rest: 'sit',
  social: 'social',
  play: 'play',
  call: 'call',
  swim: 'swim',
  follow: 'idle',
  hunt: 'idle',
  flee: 'idle',
  breakout: 'idle',
  roam: 'idle',
};
