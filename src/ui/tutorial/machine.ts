// The tutorial's step machine (tutorial.md §5, spec §6.3–§6.5). Pure: it reads Facts, hears
// events (note) and answers with a view plus a queue of effects for the controller (index.ts)
// to carry out — emit the `tutorial` event, hold or release the clock, frame the camera, put
// the tool away, pop "Great!", write the profile state. No DOM, no sim calls.
//
//  * The current step is the first one not passed (or passed but no longer kept: a regress).
//  * Every build step finishes on real sim state, the others on UI events.
//  * Steps 1a–8 hold the clock; 9a releases it; once 'play' has passed it is never held again.
//  * After 3 attempts or 60 s without progress the bubble offers Help me.

import type { SimSpeed } from '../../core/contracts';
import type { TileRect } from '../../core/events';
import type { GestureSummary } from '../../core/ui-ext';
import type { TutorialStatus } from '../../../shared/api-types';
import type { Facts, WorldHint } from './facts';
import { buildPhase, PHASE_RANK } from './phase';
import type { TilePos } from './plot';
import {
  CHAPTER_COUNT,
  CHAPTERS,
  DOCK_LABEL,
  isStepId,
  lineFor,
  POPS,
  STEPS,
  type HandKind,
  type Line,
  type LineKey,
  type StepDef,
  type StepId,
} from './script';

export type TutMode = 'first' | 'practice' | 'migrated';
export type TutStatus = 'off' | 'welcome' | 'running' | 'finish';

/** Thresholds (tutorial.md §3.2, spec §6.3/§6.4). */
export const PAN_PX = 120;
export const ZOOM_LOG = 0.35;
export const TURN_DEG = 20;
export const HELP_ATTEMPTS = 3;
export const HELP_AFTER_MS = 60_000;
export const PAUSED_MS = 3000;
export const LOCKED_NUDGE_MS = 3000;
export const SHEET_MIN_MS = 1500;
export const RESUME_LINE_MS = 4500;

export type TutEvent =
  | { kind: 'gesture'; g: GestureSummary }
  | { kind: 'painted'; inHabitat: boolean }
  | { kind: 'pathBuilt' }
  | { kind: 'commandFailed' }
  | { kind: 'zooShown'; tab: string }
  | { kind: 'zooClosed' }
  | { kind: 'pillTapped' }
  | { kind: 'gotIt' }
  | { kind: 'next' }
  | { kind: 'back' }
  | { kind: 'speedLocked' }
  | { kind: 'helped' }
  | { kind: 'helpFailed' }
  | { kind: 'skipStep' };

export type TargetSpec =
  | { kind: 'cat'; id: string }
  | { kind: 'card'; key: string }
  | { kind: 'confirm' }
  | { kind: 'world'; hint: WorldHint | null }
  | { kind: 'gesture'; g: 'drag' | 'pinch' | 'twist' }
  | { kind: 'speed'; s: SimSpeed[] }
  | { kind: 'speedGroup' }
  | { kind: 'money' }
  | { kind: 'pill' }
  | { kind: 'sheetMeter' }
  | { kind: 'sheetClose' }
  | { kind: 'panelClose' }
  | { kind: 'panelTab'; tab: string };

export type Zone = 'dock' | 'drawer' | 'confirm' | 'hud' | 'sheet' | 'panel' | 'world' | 'gesture';

export function zoneOf(t: TargetSpec | null): Zone {
  switch (t?.kind) {
    case 'cat':
      return 'dock';
    case 'card':
      return 'drawer';
    case 'confirm':
      return 'confirm';
    case 'speed':
    case 'speedGroup':
    case 'money':
    case 'pill':
      return 'hud';
    case 'sheetMeter':
    case 'sheetClose':
      return 'sheet';
    case 'panelClose':
    case 'panelTab':
      return 'panel';
    case 'gesture':
      return 'gesture';
    default:
      return 'world';
  }
}

export interface ViewButtons {
  back: boolean;
  next: boolean;
  gotIt: boolean;
  help: boolean;
  skipStep: boolean;
}

export interface TutorialView {
  status: TutStatus;
  mode: TutMode;
  /** The step on show (in review: the one being reviewed). */
  step: StepId | null;
  /** The step the game is waiting for. */
  current: StepId | null;
  index: number;
  chapter: number;
  phase: string;
  line: LineKey | null;
  text: Line | null;
  target: TargetSpec | null;
  hand: HandKind | null;
  dim: boolean;
  zone: Zone;
  review: boolean;
  /** The bubble steps aside (dialog, zoo menu, own tool with its drawer open): the pill shows the step. */
  hidden: boolean;
  buttons: ViewButtons;
  /** The pill's form while the bubble is hidden: the step (true) or the next goal (false, step 10b). */
  pillStep: boolean;
  speciesId: string;
}

export type Effect =
  | { kind: 'emit'; step: string; chapter: number; state: 'start' | 'done' | 'skip' | 'finish' | 'help' | 'prefs' }
  | { kind: 'clock'; mode: 'hold' | 'release' }
  | { kind: 'frame'; step: StepId }
  | { kind: 'endTool' }
  | { kind: 'pop'; text: string }
  | { kind: 'profile'; status: TutorialStatus }
  | { kind: 'speak' };

/** The tutorial's progress as stored in the zoo save (sim.tutorial; opaque to the sim). */
export interface TutorialBlob {
  v: 1;
  mode: TutMode;
  /** Saved while the welcome card was up. */
  welcome?: boolean;
  passed: StepId[];
  skipped?: StepId[];
  step: StepId;
  mem?: { pan?: number; zoom?: number; turn?: number; attempts?: number; financeSeen?: boolean };
  plot: TileRect | null;
  homeHabitat: number;
  animalId: number;
  speciesId?: string;
  corridor?: TilePos[];
  objBase?: number;
}

interface StepMemory {
  pan: number;
  zoom: number;
  turn: number;
  attempts: number;
  enteredAt: number;
  lastProgressAt: number;
  lastPhase: string;
  /** Gesture sub-line: 'tap' | 'oneFinger' | 'noTwist'. */
  sub: string | null;
  painted: boolean;
  outside: boolean;
  pathAt: number;
  notConnected: boolean;
  sheetShownAt: number;
  happyDone: boolean;
  financeSeen: boolean;
  moneyDone: boolean;
  goalDone: boolean;
  gotIt: boolean;
  helped: boolean;
  noMoney: boolean;
  pausedSince: number;
  /** View ticks shown for this step (0: it passed on entry, quietly). */
  shown: number;
}

function freshMemory(now: number): StepMemory {
  return {
    pan: 0, zoom: 0, turn: 0, attempts: 0, enteredAt: now, lastProgressAt: now, lastPhase: '', sub: null,
    painted: false, outside: false, pathAt: 0, notConnected: false, sheetShownAt: 0, happyDone: false,
    financeSeen: false, moneyDone: false, goalDone: false, gotIt: false, helped: false, noMoney: false,
    pausedSince: 0, shown: 0,
  };
}

const NO_BUTTONS: ViewButtons = { back: false, next: false, gotIt: false, help: false, skipStep: false };

/** A stored blob, checked field by field (null when it is not one of ours). */
export function parseBlob(raw: unknown): TutorialBlob | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  const mode = r.mode === 'first' || r.mode === 'practice' || r.mode === 'migrated' ? r.mode : null;
  if (!mode || !isStepId(r.step)) return null;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter(isStepId) : []);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const rect = (v: unknown): TileRect | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    return ['x0', 'z0', 'x1', 'z1'].every((k) => typeof o[k] === 'number') ? { x0: o.x0 as number, z0: o.z0 as number, x1: o.x1 as number, z1: o.z1 as number } : null;
  };
  const mem = r.mem && typeof r.mem === 'object' ? (r.mem as Record<string, unknown>) : {};
  const corridor = Array.isArray(r.corridor)
    ? (r.corridor as unknown[]).filter((t): t is TilePos => !!t && typeof t === 'object' && typeof (t as TilePos).x === 'number' && typeof (t as TilePos).z === 'number').map((t) => ({ x: t.x, z: t.z }))
    : [];
  return {
    v: 1,
    mode,
    welcome: r.welcome === true ? true : undefined,
    passed: ids(r.passed),
    skipped: ids(r.skipped),
    step: r.step,
    mem: { pan: num(mem.pan), zoom: num(mem.zoom), turn: num(mem.turn), attempts: num(mem.attempts), financeSeen: mem.financeSeen === true },
    plot: rect(r.plot),
    homeHabitat: num(r.homeHabitat),
    animalId: num(r.animalId),
    speciesId: typeof r.speciesId === 'string' ? r.speciesId : undefined,
    corridor,
    objBase: num(r.objBase),
  };
}

export interface MachineOptions {
  versusEnabled: boolean;
  /** Steps (tests may pass a shorter list). */
  steps?: readonly StepDef[];
}

export class TutorialMachine {
  status: TutStatus = 'off';
  mode: TutMode = 'first';
  readonly steps: readonly StepDef[];
  passed = new Set<StepId>();
  skipped = new Set<StepId>();
  /** Steps that came back because their Keep failed (their regress line shows). */
  regressed = new Set<StepId>();
  plot: TileRect | null = null;
  homeHabitat = 0;
  animalId = 0;
  speciesId: string | null = null;
  corridor: TilePos[] = [];
  objBase = 0;
  /** True when something worth saving changed (the controller writes sim.tutorial and saves). */
  changed = false;
  effects: Effect[] = [];
  private lastId: StepId | null = null;
  private mem: StepMemory = freshMemory(0);
  private reviewIndex: number | null = null;
  private now = 0;
  private lockedAt = -1e9;
  private resumeUntil = 0;
  private resumeShown = false;
  private savedMem: TutorialBlob['mem'] | null = null;
  private lastView: TutorialView | null = null;

  constructor(private opts: MachineOptions) {
    this.steps = opts.steps ?? STEPS;
  }

  // ------------------------------------------------------------------ lifecycle
  /** A fresh tutorial (first run or practice zoo): the welcome card first. */
  start(mode: 'first' | 'practice', now: number): void {
    this.reset();
    this.mode = mode;
    this.status = 'welcome';
    this.now = now;
    this.effects.push({ kind: 'clock', mode: 'hold' }, { kind: 'profile', status: 'running' });
    this.changed = true;
  }

  /** "Let's go" on the welcome card. */
  begin(now: number): void {
    if (this.status !== 'welcome') return;
    this.status = 'running';
    this.now = now;
    this.lastId = null;
    this.changed = true;
  }

  /** Continue from a saved blob; false when there is nothing to continue. */
  resume(raw: unknown, now: number): boolean {
    const b = parseBlob(raw);
    if (!b) return false;
    this.reset();
    this.mode = b.mode;
    this.passed = new Set(b.passed);
    this.skipped = new Set(b.skipped ?? []);
    this.plot = b.plot;
    this.homeHabitat = b.homeHabitat;
    this.animalId = b.animalId;
    this.speciesId = b.speciesId ?? null;
    this.corridor = b.corridor ?? [];
    this.objBase = b.objBase ?? 0;
    this.savedMem = b.mem ?? null;
    this.now = now;
    this.status = b.welcome ? 'welcome' : 'running';
    // the welcome card holds the clock too (the steps hold it again as they start)
    if (b.welcome) this.effects.push({ kind: 'clock', mode: 'hold' });
    else {
      this.resumeUntil = now + RESUME_LINE_MS;
      this.resumeShown = true;
    }
    this.effects.push({ kind: 'profile', status: 'running' });
    return true;
  }

  /** The old five-step tour was under way in this zoo (spec §6.6): continue as 'migrated'. */
  startMigrated(passed: readonly StepId[], now: number): void {
    this.reset();
    this.mode = 'migrated';
    this.status = 'running';
    this.passed = new Set(passed);
    this.now = now;
    this.resumeUntil = now + RESUME_LINE_MS;
    this.resumeShown = true;
    this.effects.push({ kind: 'profile', status: 'running' });
    this.changed = true;
  }

  /** Skip confirmed: off, clock free again, profile 'skipped'. */
  skip(): void {
    if (this.status === 'off') return;
    const s = this.currentDef();
    this.status = 'off';
    this.reviewIndex = null;
    this.effects.push({ kind: 'clock', mode: 'release' }, { kind: 'profile', status: 'skipped' }, { kind: 'emit', step: s?.id ?? '', chapter: s?.chapter ?? 0, state: 'skip' });
    this.changed = true;
  }

  /** The finish card was closed. */
  closeFinish(): void {
    if (this.status === 'finish') this.status = 'off';
  }

  private reset(): void {
    this.passed = new Set();
    this.skipped = new Set();
    this.regressed = new Set();
    this.plot = null;
    this.homeHabitat = 0;
    this.animalId = 0;
    this.speciesId = null;
    this.corridor = [];
    this.objBase = 0;
    this.lastId = null;
    this.reviewIndex = null;
    this.resumeUntil = 0;
    this.resumeShown = false;
    this.savedMem = null;
    this.lockedAt = -1e9;
    this.mem = freshMemory(this.now);
  }

  get running(): boolean {
    return this.status === 'welcome' || this.status === 'running';
  }

  /** Has the player pressed Play (the clock is never held again)? */
  get clockFree(): boolean {
    return this.passed.has('play');
  }

  /** The blob to store in the zoo save (null when the tutorial is not running). */
  blob(): TutorialBlob | null {
    if (!this.running) return null;
    const cur = this.currentDef() ?? this.steps[0];
    return {
      v: 1,
      mode: this.mode,
      welcome: this.status === 'welcome' ? true : undefined,
      passed: [...this.passed],
      skipped: this.skipped.size ? [...this.skipped] : undefined,
      step: cur.id,
      mem: { pan: this.mem.pan, zoom: this.mem.zoom, turn: this.mem.turn, attempts: this.mem.attempts, financeSeen: this.mem.financeSeen },
      plot: this.plot,
      homeHabitat: this.homeHabitat,
      animalId: this.animalId,
      speciesId: this.speciesId ?? undefined,
      corridor: this.corridor.length ? this.corridor : undefined,
      objBase: this.objBase || undefined,
    };
  }

  drain(): Effect[] {
    const e = this.effects;
    this.effects = [];
    return e;
  }

  /** The step the game waits for (as of the last tick). */
  currentDef(): StepDef | null {
    return this.lastId ? this.steps.find((s) => s.id === this.lastId) ?? null : null;
  }

  get current(): StepId | null {
    return this.status === 'running' ? this.lastId : null;
  }

  /** The step whose hint the controller should compute: the one on show (review) or the current. */
  get hintStep(): StepId | null {
    if (this.status !== 'running') return null;
    if (this.reviewIndex !== null) return this.steps[this.reviewIndex]?.id ?? null;
    return this.lastId ?? this.steps.find((s) => !this.isPassed(s))?.id ?? null;
  }

  // ------------------------------------------------------------------ predicates
  private kept(s: StepDef, f: Facts): boolean {
    if (!s.keeps || this.skipped.has(s.id)) return true;
    switch (s.id) {
      case 'fence':
        return f.habitats > 0;
      case 'adopt':
        // an escaped animal never sends the child back to adopt (spec §6.5)
        return f.animals > 0;
      case 'path':
        return f.gateOpen || f.animalsInHabitat === 0;
      case 'keeper':
        return f.keeper;
      default:
        return true;
    }
  }

  private isPassed(s: StepDef): boolean {
    return this.passed.has(s.id) || this.skipped.has(s.id);
  }

  private done(s: StepDef, f: Facts): boolean {
    const m = this.mem;
    switch (s.id) {
      case 'look-pan':
        return m.helped || m.pan >= PAN_PX;
      case 'look-zoom':
        return m.helped || m.zoom >= ZOOM_LOG;
      case 'look-turn':
        return m.helped || m.turn >= TURN_DEG;
      case 'fence':
        return f.habitats > 0;
      case 'paint':
        return m.painted;
      case 'water':
        return f.hasWater;
      case 'shelter':
        return f.hasShelter;
      case 'plant':
        return f.plantIn;
      case 'adopt':
        return f.animalsInHabitat > 0;
      case 'happy':
        return m.happyDone;
      case 'path':
        return f.gateOpen;
      case 'kiosk':
        return f.kiosk;
      case 'bench':
        return f.bench;
      case 'bin':
        return f.bin;
      case 'keeper':
        return f.keeper;
      case 'play':
        return f.speed >= 1;
      case 'guests':
        return f.guestIn;
      case 'money':
        return m.moneyDone;
      case 'goal':
        return m.goalDone;
      case 'speed':
        return f.speed >= 2;
      case 'speed-note':
        return m.gotIt;
    }
  }

  // ------------------------------------------------------------------ tick
  tick(f: Facts): TutorialView {
    this.now = f.now;
    if (this.status !== 'running') return (this.lastView = this.cardView());
    // timers and UI-state completions of the step on show (before the done check below)
    const shownStep = this.currentDef();
    if (shownStep) this.watch(shownStep, f);
    let s: StepDef | null = null;
    for (let guard = 0; guard <= this.steps.length + 1; guard++) {
      s = this.steps.find((d) => !(this.isPassed(d) && this.kept(d, f))) ?? null;
      if (!s) {
        this.finish();
        return (this.lastView = this.cardView());
      }
      if (this.passed.has(s.id)) {
        // a Keep failed: back to this step
        this.passed.delete(s.id);
        this.regressed.add(s.id);
      }
      if (s.id !== this.lastId) this.enter(s, f);
      if (this.done(s, f)) {
        this.pass(s, f);
        continue;
      }
      break;
    }
    if (!s) return (this.lastView = this.cardView());
    const v = this.stepView(s, f);
    this.mem.shown++;
    if (v.phase !== this.mem.lastPhase) {
      const a = PHASE_RANK[this.mem.lastPhase as keyof typeof PHASE_RANK];
      const b = PHASE_RANK[v.phase as keyof typeof PHASE_RANK];
      if (a !== undefined && b !== undefined && b > a) this.mem.lastProgressAt = this.now;
      if ((v.phase === 'wrong' || v.phase === 'invalid') && this.mem.lastPhase !== v.phase) this.mem.attempts++;
      if (this.mem.lastPhase) this.effects.push({ kind: 'speak' });
      this.mem.lastPhase = v.phase;
    }
    if (!v.review && !v.hidden) v.buttons.help = this.helpOffered(s, v);
    if (this.reviewIndex === null && this.resumeShown && this.now >= this.resumeUntil) this.resumeShown = false;
    return (this.lastView = v);
  }

  private enter(s: StepDef, _f: Facts): void {
    const first = this.lastId === null;
    this.lastId = s.id;
    this.mem = freshMemory(this.now);
    if (first && this.savedMem) {
      // resumed: the gesture totals and the Finances visit survive a reload
      this.mem.pan = this.savedMem.pan ?? 0;
      this.mem.zoom = this.savedMem.zoom ?? 0;
      this.mem.turn = this.savedMem.turn ?? 0;
      this.mem.attempts = this.savedMem.attempts ?? 0;
      this.mem.financeSeen = !!this.savedMem.financeSeen;
      this.savedMem = null;
    }
    this.reviewIndex = null;
    this.effects.push({ kind: 'emit', step: s.id, chapter: s.chapter, state: 'start' });
    if (s.clock === 'hold' && !this.clockFree) this.effects.push({ kind: 'clock', mode: 'hold' });
    else this.effects.push({ kind: 'clock', mode: 'release' });
    this.effects.push({ kind: 'frame', step: s.id }, { kind: 'speak' });
    this.changed = true;
  }

  private pass(s: StepDef, f: Facts): void {
    const quiet = this.mem.shown === 0;
    this.passed.add(s.id);
    this.regressed.delete(s.id);
    if (s.id === 'fence') this.homeHabitat = f.plotHabitat || (this.homeHabitat && f.habitatIds.includes(this.homeHabitat) ? this.homeHabitat : f.habitatIds[0] ?? 0);
    if (s.id === 'adopt' && f.animal) {
      this.animalId = f.animal.id;
      this.speciesId = f.animal.speciesId;
    }
    this.effects.push({ kind: 'emit', step: s.id, chapter: s.chapter, state: 'done' });
    if (s.build) this.effects.push({ kind: 'endTool' });
    if (!quiet) {
      const n = this.passed.size;
      this.effects.push({ kind: 'pop', text: POPS[n % POPS.length] });
    }
    this.reviewIndex = null;
    this.resumeShown = false;
    this.changed = true;
  }

  private finish(): void {
    this.status = 'finish';
    this.lastId = null;
    this.reviewIndex = null;
    this.effects.push({ kind: 'clock', mode: 'release' }, { kind: 'profile', status: 'done' }, { kind: 'emit', step: 'finish', chapter: CHAPTER_COUNT, state: 'finish' });
    this.changed = true;
  }

  /** Per-tick bookkeeping that is not a view: the happy sheet timer, the paused timer, a path that did not join. */
  private watch(s: StepDef, f: Facts): void {
    const m = this.mem;
    if (s.id === 'happy') {
      const own = f.sheet?.kind === 'animal';
      if (own && !m.sheetShownAt) {
        m.sheetShownAt = this.now;
        m.lastProgressAt = this.now;
      } else if (!own && m.sheetShownAt) {
        if (this.now - m.sheetShownAt >= SHEET_MIN_MS && !f.sheetOpen) m.happyDone = true;
        m.sheetShownAt = 0;
      }
    }
    if (s.id === 'path' && m.pathAt && this.now - m.pathAt > 300) {
      m.pathAt = 0;
      if (!f.gateOpen) {
        m.notConnected = true;
        m.attempts++;
      }
    }
    if ((s.id === 'guests' || s.id === 'speed') && f.speed === 0) {
      if (!m.pausedSince) m.pausedSince = this.now;
    } else m.pausedSince = 0;
  }

  // ------------------------------------------------------------------ events
  note(e: TutEvent): void {
    if (this.status !== 'running') return;
    const s = this.currentDef();
    const m = this.mem;
    switch (e.kind) {
      case 'gesture':
        if (s) this.gesture(s.id, e.g);
        return;
      case 'painted':
        if (s?.id !== 'paint') return;
        if (e.inHabitat) m.painted = true;
        else {
          m.outside = true;
          m.attempts++;
        }
        return;
      case 'pathBuilt':
        if (s?.id === 'path') m.pathAt = this.now || 1;
        return;
      case 'commandFailed':
        m.attempts++;
        return;
      case 'zooShown':
        if (s?.id === 'money' && e.tab === 'finance') {
          if (!m.financeSeen) m.lastProgressAt = this.now;
          m.financeSeen = true;
          this.changed = true;
        }
        return;
      case 'zooClosed':
        if (s?.id === 'money' && m.financeSeen) m.moneyDone = true;
        return;
      case 'pillTapped':
        if (s?.id === 'goal') m.goalDone = true;
        return;
      case 'gotIt':
        if (s?.id === 'happy' && (m.sheetShownAt || this.lastView?.phase === 'sheet')) m.happyDone = true;
        if (s?.id === 'speed-note') m.gotIt = true;
        return;
      case 'back': {
        const cur = this.steps.findIndex((d) => d.id === this.lastId);
        if (cur <= 0) return;
        const from = this.reviewIndex ?? cur;
        this.reviewIndex = Math.max(0, from - 1);
        this.effects.push({ kind: 'speak' });
        return;
      }
      case 'next': {
        if (this.reviewIndex === null) return;
        const cur = this.steps.findIndex((d) => d.id === this.lastId);
        const n = this.reviewIndex + 1;
        this.reviewIndex = n >= cur ? null : n;
        this.effects.push({ kind: 'speak' });
        return;
      }
      case 'speedLocked':
        this.lockedAt = this.now;
        m.attempts++;
        return;
      case 'helped':
        // camera steps pass on the demo; the menu and pill steps on what the help opened;
        // build steps on the state the help's command made, happy on Got it as usual
        if (s && s.kind === 'gesture') m.helped = true;
        if (s?.id === 'money') m.moneyDone = true;
        if (s?.id === 'goal') m.goalDone = true;
        if (s?.id === 'speed-note') m.gotIt = true;
        m.attempts = 0;
        m.noMoney = false;
        m.lastProgressAt = this.now;
        if (s) this.effects.push({ kind: 'emit', step: s.id, chapter: s.chapter, state: 'help' });
        return;
      case 'helpFailed':
        m.noMoney = true;
        return;
      case 'skipStep':
        if (s) {
          this.skipped.add(s.id);
          this.lastId = null;
          this.changed = true;
        }
        return;
    }
  }

  private gesture(id: StepId, g: GestureSummary): void {
    const m = this.mem;
    let gained = false;
    if (id === 'look-pan') {
      if (g.pan > 0 && g.fingers === 1) {
        m.pan += g.pan;
        gained = true;
        m.sub = null;
      } else if (g.tap) m.sub = 'tap';
    } else if (id === 'look-zoom') {
      if (g.zoom > 0.005) {
        m.zoom += g.zoom;
        gained = true;
        m.sub = null;
      } else if (g.fingers === 1 && (g.pan > 0 || g.tap)) m.sub = 'oneFinger';
    } else if (id === 'look-turn') {
      if (g.turn > 0.5) {
        m.turn += g.turn;
        gained = true;
        m.sub = null;
      } else if (g.fingers === 2 || g.zoom > 0) m.sub = 'noTwist';
    } else return;
    if (gained) m.lastProgressAt = this.now;
    else m.attempts++;
    this.changed = true;
  }

  // ------------------------------------------------------------------ views
  private base(s: StepDef | null, f: Facts | null): TutorialView {
    const index = s ? this.steps.indexOf(s) : -1;
    return {
      status: this.status,
      mode: this.mode,
      step: s?.id ?? null,
      current: this.status === 'running' ? this.lastId : null,
      index,
      chapter: s?.chapter ?? (this.status === 'finish' ? CHAPTER_COUNT : 0),
      phase: '',
      line: null,
      text: null,
      target: null,
      hand: null,
      dim: false,
      zone: 'world',
      review: false,
      hidden: false,
      buttons: { ...NO_BUTTONS },
      pillStep: true,
      speciesId: this.speciesId ?? 'zebra',
    };
  }

  /** The view while no step is on show (welcome / finish card, or off). */
  statusView(): TutorialView {
    return this.cardView();
  }

  private cardView(): TutorialView {
    const v = this.base(null, null);
    v.phase = this.status;
    return v;
  }

  /** Fill a view's line, target and zone. */
  private say(v: TutorialView, key: LineKey, target: TargetSpec | null, hand: HandKind | null, dim = false): TutorialView {
    v.line = key;
    const cat = target?.kind === 'cat' ? DOCK_LABEL[target.id] : undefined;
    v.text = lineFor(key, { speciesId: this.speciesId, cat });
    v.target = target;
    v.hand = hand;
    v.dim = dim;
    v.zone = zoneOf(target);
    return v;
  }

  private stepView(cur: StepDef, f: Facts): TutorialView {
    if (this.reviewIndex !== null) return this.reviewView(this.steps[this.reviewIndex], f);
    const v = this.base(cur, f);
    const m = this.mem;
    this.phaseView(v, cur, f);
    if (v.hidden) return v;
    // nudges over the step's own line
    if (m.noMoney) {
      this.say(v, 'nudge.noMoney', v.target, v.hand, false);
      v.buttons.skipStep = true;
    } else if (this.now - this.lockedAt < LOCKED_NUDGE_MS && !this.clockFree) {
      this.say(v, 'nudge.speedLocked', { kind: 'speedGroup' }, null, false);
      v.phase = 'speedLocked';
    } else if (this.resumeShown && this.now < this.resumeUntil) {
      const t = v.target;
      this.say(v, 'nudge.resume', t, v.hand, v.dim);
    }
    const idx = this.steps.indexOf(cur);
    v.buttons.back = idx > 0;
    v.buttons.help = this.helpOffered(cur, v);
    return v;
  }

  /** Help me: after 3 attempts or 60 s without progress (not where Got it / Skip this step is the action). */
  private helpOffered(s: StepDef, v: TutorialView): boolean {
    const m = this.mem;
    if (s.id === 'speed-note' || v.buttons.gotIt || v.buttons.skipStep) return false;
    return m.attempts >= HELP_ATTEMPTS || this.now - m.lastProgressAt >= HELP_AFTER_MS;
  }

  private phaseView(v: TutorialView, s: StepDef, f: Facts): void {
    const m = this.mem;
    const hidden = () => {
      v.hidden = true;
      v.phase = 'hidden';
    };
    const sheetNudge = () => {
      v.phase = 'otherSheet';
      this.say(v, 'nudge.otherSheet', { kind: 'sheetClose' }, 'tap');
    };
    if (s.kind === 'build' && s.build) {
      const b = s.build;
      const regressed = this.regressed.has(s.id);
      const pr = buildPhase(b, f, regressed);
      v.phase = pr.phase;
      const world: TargetSpec = { kind: 'world', hint: f.hint };
      switch (pr.phase) {
        case 'hidden':
          return hidden();
        case 'otherSheet':
          return sheetNudge();
        case 'open':
        case 'regress':
          this.say(v, this.special(s, f, 'open') ?? (pr.phase === 'regress' ? this.regressLine(s, f) : (`${s.id}.open` as LineKey)), { kind: 'cat', id: b.cat }, 'tap', true);
          return;
        case 'wrong':
          this.say(v, 'nudge.wrongCat', { kind: 'cat', id: b.cat }, 'tap', false);
          return;
        case 'pick':
          this.say(v, `${s.id}.pick` as LineKey, { kind: 'card', key: b.card }, 'tap', true);
          return;
        case 'use':
          this.say(v, this.special(s, f, 'use') ?? (s.id === 'fence' && !this.plot ? 'fence.useAny' : (`${s.id}.use` as LineKey)), world, b.hand);
          return;
        case 'invalid':
          this.say(v, pr.line ?? (s.id === 'fence' ? 'fence.invalid' : 'spot.invalid'), world, b.hand);
          return;
        case 'confirm':
          m.outside = false;
          this.say(v, `${s.id}.confirm` as LineKey, { kind: 'confirm' }, 'tap', true);
          return;
      }
      return;
    }
    if (f.dialog) return hidden();
    switch (s.id) {
      case 'look-pan':
      case 'look-zoom':
      case 'look-turn': {
        if (f.zooOpen) return hidden();
        if (f.sheetOpen) return sheetNudge();
        const g = s.id === 'look-pan' ? 'drag' : s.id === 'look-zoom' ? 'pinch' : 'twist';
        const mouse = f.pointer === 'mouse';
        const key = (m.sub && !mouse ? `${s.id}.${m.sub}` : `${s.id}.${mouse ? 'mouse' : 'touch'}`) as LineKey;
        v.phase = m.sub && !mouse ? m.sub : 'main';
        this.say(v, key, { kind: 'gesture', g }, g);
        return;
      }
      case 'happy': {
        if (f.zooOpen) return hidden();
        if (f.sheet?.kind === 'animal') {
          const a = f.animal;
          v.phase = 'sheet';
          this.say(v, !a || a.happiness >= 0.55 ? 'happy.sheet' : 'happy.sheetLow', { kind: 'sheetMeter' }, null);
          v.buttons.gotIt = true;
          return;
        }
        if (f.sheetOpen) {
          v.phase = 'other';
          this.say(v, 'happy.other', { kind: 'sheetClose' }, 'tap');
          return;
        }
        v.phase = 'tap';
        this.say(v, 'happy.tap', { kind: 'world', hint: f.hint }, 'tap');
        return;
      }
      case 'play':
        if (f.zooOpen) return hidden();
        v.phase = 'main';
        this.say(v, 'play.main', { kind: 'speed', s: [1] }, 'tap', true);
        return;
      case 'guests':
        if (f.zooOpen) return hidden();
        if (m.pausedSince && this.now - m.pausedSince > PAUSED_MS) {
          v.phase = 'paused';
          this.say(v, 'clock.paused', { kind: 'speed', s: [1] }, 'tap');
          return;
        }
        if (!f.gateOpen && f.animalsInHabitat > 0) {
          v.phase = 'shut';
          this.say(v, 'guests.shut', { kind: 'cat', id: 'paths' }, 'tap');
          return;
        }
        if (!f.isOpen) {
          v.phase = 'closed';
          this.say(v, 'guests.closed', { kind: 'world', hint: f.hint }, null);
          return;
        }
        v.phase = 'main';
        this.say(v, 'guests.main', { kind: 'world', hint: f.hint }, null);
        return;
      case 'money':
        if (f.zooOpen) {
          if (f.zooTab === 'finance') {
            v.phase = 'finance';
            this.say(v, 'money.finance', { kind: 'panelClose' }, 'tap');
          } else {
            v.phase = 'otherTab';
            this.say(v, 'money.otherTab', { kind: 'panelTab', tab: 'finance' }, 'tap');
          }
          return;
        }
        v.phase = 'hud';
        this.say(v, 'money.hud', { kind: 'money' }, 'tap', true);
        return;
      case 'goal':
        v.pillStep = false;
        if (f.zooOpen) return hidden();
        v.phase = 'main';
        this.say(v, 'goal.main', { kind: 'pill' }, 'tap', true);
        return;
      case 'speed':
        if (f.zooOpen) return hidden();
        if (m.pausedSince && this.now - m.pausedSince > PAUSED_MS) {
          v.phase = 'paused';
          this.say(v, 'clock.paused', { kind: 'speed', s: [1] }, 'tap');
          return;
        }
        v.phase = 'main';
        this.say(v, 'speed.main', { kind: 'speed', s: [2, 3] }, 'tap');
        return;
      case 'speed-note':
        if (f.zooOpen) return hidden();
        v.phase = 'main';
        this.say(v, this.opts.versusEnabled ? 'speed-note.versus' : 'speed-note.offline', { kind: 'speedGroup' }, null);
        v.buttons.gotIt = true;
        return;
    }
  }

  /** A step's special line for the open / use phases (paint outside, plant outside, path not joined, fence gap). */
  private special(s: StepDef, f: Facts, phase: 'open' | 'use'): LineKey | null {
    const m = this.mem;
    switch (s.id) {
      case 'fence':
        return this.regressed.has('fence') && f.gap ? 'fence.gap' : null;
      case 'paint':
        return m.outside ? 'paint.outside' : null;
      case 'plant':
        return f.plantOut && !f.plantIn ? 'plant.outside' : null;
      case 'path':
        return m.notConnected ? 'path.notConnected' : null;
      default:
        return phase === 'open' || phase === 'use' ? null : null;
    }
  }

  private regressLine(s: StepDef, f: Facts): LineKey {
    switch (s.id) {
      case 'fence':
        return f.gap ? 'fence.gap' : 'fence.regress';
      case 'adopt':
        return 'adopt.regress';
      case 'path':
        return 'path.regress';
      case 'keeper':
        return 'keeper.regress';
      default:
        return `${s.id}.open` as LineKey;
    }
  }

  /** Back: an earlier step's main line, its demo and Next (nothing in the zoo changes). */
  private reviewView(s: StepDef, f: Facts): TutorialView {
    const v = this.base(s, f);
    v.review = true;
    v.phase = 'review';
    if (f.dialog || f.zooOpen) {
      v.hidden = true;
      return v;
    }
    const mouse = f.pointer === 'mouse';
    if (s.build) this.say(v, `${s.id}.open` as LineKey, { kind: 'cat', id: s.build.cat }, 'tap');
    else
      switch (s.id) {
        case 'look-pan':
        case 'look-zoom':
        case 'look-turn': {
          const g = s.id === 'look-pan' ? 'drag' : s.id === 'look-zoom' ? 'pinch' : 'twist';
          this.say(v, `${s.id}.${mouse ? 'mouse' : 'touch'}` as LineKey, { kind: 'gesture', g }, g);
          break;
        }
        case 'happy':
          this.say(v, 'happy.tap', null, null);
          break;
        case 'play':
          this.say(v, 'play.main', { kind: 'speed', s: [1] }, 'tap');
          break;
        case 'guests':
          this.say(v, 'guests.main', null, null);
          break;
        case 'money':
          this.say(v, 'money.hud', { kind: 'money' }, 'tap');
          break;
        case 'goal':
          this.say(v, 'goal.main', { kind: 'pill' }, 'tap');
          break;
        case 'speed':
          this.say(v, 'speed.main', { kind: 'speed', s: [2, 3] }, 'tap');
          break;
        default:
          this.say(v, this.opts.versusEnabled ? 'speed-note.versus' : 'speed-note.offline', { kind: 'speedGroup' }, null);
      }
    v.buttons.back = (this.reviewIndex ?? 0) > 0;
    v.buttons.next = true;
    return v;
  }

  /** The last view the machine produced. */
  get view(): TutorialView | null {
    return this.lastView;
  }

  /** "Step 4 of 12" pill data for a view. */
  pillFor(v: TutorialView): { label: string; sub: string; fraction: number } | null {
    if (v.status !== 'running' || !v.chapter) return null;
    return { label: CHAPTERS[v.chapter - 1], sub: `${v.chapter} / ${CHAPTER_COUNT}`, fraction: Math.max(0, v.index) / this.steps.length };
  }

  /** Test / debug: mark every step before `id` passed (the zoo is not changed). */
  debugPassBefore(id: StepId): void {
    for (const s of this.steps) {
      if (s.id === id) break;
      this.passed.add(s.id);
    }
    this.lastId = null;
    this.changed = true;
  }
}
