// The tutorial as a UI extension (spec §6.1, §8.7): createTutorialExtension() is mounted by
// createGameUI and reaches the game only through the UIExtensionHost (core/ui-ext.ts).
//
// The controller owns the step machine (machine.ts), the DOM overlay (overlay.ts), the yellow
// ground markers (ground.ts) and read-aloud (speech.ts). At 8 Hz it builds Facts from the sim
// and the UI, ticks the machine and carries out its effects; every frame it lays the bubble,
// dim, ring and hand out over whatever the step points at.

import { TILE } from '../../core/constants';
import type { PlayerInfo, SimSpeed } from '../../core/contracts';
import type { TileRect } from '../../core/events';
import type { KV } from '../../core/player-state';
import { readActiveSlot } from '../../core/player-state';
import type { SpeedLock, UIExtension, UIExtensionHost, UIRect } from '../../core/ui-ext';
import { SPECIES } from '../../data/species';
import { button, el, escapeHtml, toggleClass } from '../dom';
import { gateOpen, hintBounds, hintFor, homeOf, simFacts, starterMax, uiFacts, type Facts, type HintContext, type SimFacts, type WorldHint, GATE_SPOT } from './facts';
import { GroundMarkers } from './ground';
import { runHelp, type HelpHost } from './help';
import { TutorialMachine, type Effect, type TargetSpec, type TutorialView } from './machine';
import { Overlay } from './overlay';
import { inflate, intersects, placeBubble, union, type PlaceInput, type Rect } from './place';
import { anchorTile, findPlot, rectCentre } from './plot';
import { migrateLegacyTour, readAloudOn, readProfile, setReadAloud, setStatus } from './profile';
import { BUTTONS, CARDS, CHAPTERS, fill, HELP_POP, lineFor, stepLabel, type StepId } from './script';
import { createSpeech, speechText, type Speech } from './speech';

export interface TutorialExtension extends UIExtension {
  readonly running: boolean;
  stopSpeech(): void;
  view(): unknown;
}

export interface TutorialOptions {
  player: PlayerInfo;
  start: 'first' | 'practice' | null;
  versusEnabled: boolean;
  /** Local storage (tests pass a fake). */
  storage?: KV;
}

const TICK_S = 0.125;
const SAVE_EVERY_MS = 2000;
const HAND_CYCLE_S = 2.4;
const HAND_CYCLES = 3;
const HAND_REST_S = 6;
const NUDGE_REPLAY_MS = 20_000;

const reducedMotion = () => {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

function safeStorage(): KV {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* blocked */
  }
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}

const toRect = (r: DOMRect | UIRect): Rect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
const rectOfEl = (e: Element | null | undefined): Rect | null => {
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return r.width > 0 || r.height > 0 ? toRect(r) : null;
};
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

class TutorialController implements TutorialExtension {
  readonly id = 'tutorial';
  private host!: UIExtensionHost;
  private machine: TutorialMachine;
  private overlay!: Overlay;
  private ground!: GroundMarkers;
  private speech: Speech;
  private kv: KV;
  private offs: (() => void)[] = [];
  private acc = TICK_S;
  private v: TutorialView | null = null;
  private voice: boolean | null = null;
  private readAloud = false;
  private lastSaveAt = -1e9;
  private locked = false;
  private lock: SpeedLock = { owner: 'tutorial', onBlocked: () => this.blocked() };
  private hint: WorldHint | null = null;
  private hintKey = '';
  private lastSpoken = '';
  private handT = 0;
  private handKey = '';
  private handSlow = 1;
  private lastPointerAt = -1e9;
  private lastReplayAt = 0;
  private revealed: HTMLElement | null = null;
  private learnDismissed = false;
  private practice = false;
  private placed: Rect | null = null;
  private sizeKey = '';
  private size = { w: 0, h: 0 };
  private narrowW: number | undefined;
  private helping = false;
  private disposed = false;
  private sectionOff: (() => void) | null = null;
  private lastStatus = '';
  private reduced = reducedMotion();
  private lastLayout: Record<string, unknown> | null = null;
  private reframes = 0;
  private reframedAt = -1e9;

  constructor(private opts: TutorialOptions) {
    this.machine = new TutorialMachine({ versusEnabled: opts.versusEnabled });
    this.kv = opts.storage ?? safeStorage();
    this.speech = createSpeech();
  }

  get running(): boolean {
    return this.machine.running;
  }

  // ------------------------------------------------------------------ mount
  mount(host: UIExtensionHost): void {
    this.host = host;
    const sim = host.sim;
    this.overlay = new Overlay(host.root, {
      skip: () => this.askSkip(),
      speaker: () => this.toggleReadAloud(),
      back: () => this.noteAndTick({ kind: 'back' }),
      next: () => this.noteAndTick({ kind: 'next' }),
      gotIt: () => this.noteAndTick({ kind: 'gotIt' }),
      help: () => void this.help(),
      skipStep: () => this.noteAndTick({ kind: 'skipStep' }),
      learn: () => this.askPractice(true),
    });
    this.ground = new GroundMarkers(sim.world, host.ctx.scene, this.reduced);
    this.speech.onSpeaking = (on) => {
      try {
        (host.audio as { speechDuck?(on: boolean): void }).speechDuck?.(on);
      } catch {
        /* audio without ducking */
      }
    };
    void this.speech.available().then((ok) => {
      this.voice = ok;
      this.readAloud = readAloudOn(readProfile(this.kv, this.opts.player.ref), ok);
      if (this.machine.status === 'welcome') {
        this.overlay.setWelcomeSpeaker(this.speakerState());
        if (this.readAloud) this.speakWelcome();
      }
      this.renderSettings();
    });
    const ev = host.events;
    this.offs.push(
      host.onGesture((g) => this.machine.note({ kind: 'gesture', g })),
      ev.on('terrainChanged', (r) => this.painted(r)),
      ev.on('pathChanged', () => {
        if (this.machine.current === 'path') this.machine.note({ kind: 'pathBuilt' });
      }),
      ev.on('commandResult', (r) => {
        if (!r.ok) this.machine.note({ kind: 'commandFailed' });
        this.acc = TICK_S; // re-check at once
      }),
      host.onZooPanel((e) => this.machine.note(e.kind === 'shown' ? { kind: 'zooShown', tab: e.tab } : { kind: 'zooClosed' })),
      host.onPillTapped(() => this.pillTapped()),
      ev.on('worldReset', () => this.worldReset()),
    );
    this.practice = this.opts.start === 'practice' || readActiveSlot(this.kv, this.opts.player.ref) === 'practice';
    if (this.practice) host.hideSettingsRow('newZoo', true);
    this.renderSettings();
    this.begin(this.opts.start);
    // automation hooks (dev builds and ?tutdebug)
    let debug = false;
    try {
      debug = !!import.meta.env?.DEV || new URLSearchParams(location.search).has('tutdebug');
    } catch {
      debug = false;
    }
    if (debug) (globalThis as Record<string, unknown>).__tutorial = this;
  }

  /** Start, resume or migrate for the zoo that is loaded now. */
  private begin(start: 'first' | 'practice' | null): void {
    const sim = this.host.sim;
    if (sim.versus) return; // never inside a versus match
    if (start) {
      this.startFresh(start);
      return;
    }
    if (sim.tutorial && this.machine.resume(sim.tutorial, performance.now())) {
      this.afterStart();
      return;
    }
    const mig = migrateLegacyTour(this.kv, this.opts.player.ref, { day: sim.day, animals: sim.animals.size });
    if (mig?.passed) {
      this.machine.startMigrated(mig.passed, performance.now());
      this.machine.plot = findPlot(sim);
      this.machine.objBase = starterMax(sim, 0);
      this.afterStart();
    }
  }

  private startFresh(mode: 'first' | 'practice'): void {
    const sim = this.host.sim;
    this.machine.start(mode, performance.now());
    this.machine.plot = findPlot(sim);
    this.machine.objBase = starterMax(sim, 0);
    this.afterStart();
  }

  private afterStart(): void {
    this.applyEffects(this.machine.drain());
    this.writeBlob(true);
    this.lastStatus = '';
    this.syncCards();
    this.acc = TICK_S;
  }

  private worldReset(): void {
    if (this.disposed) return;
    const sim = this.host.sim;
    this.overlay.hideCard();
    this.hint = null;
    this.hintKey = '';
    this.ground.set(null);
    if (sim.versus) {
      if (this.machine.running) this.machine.skip();
      this.machine.drain();
      this.releaseClock(false);
      this.hideAll();
      return;
    }
    if (sim.tutorial) {
      if (this.machine.resume(sim.tutorial, performance.now())) this.afterStart();
      return;
    }
    // a brand-new zoo (Settings › New zoo): a running first-run tutorial starts over there
    const st = readProfile(this.kv, this.opts.player.ref).status;
    if (this.machine.running && (st === 'never' || st === 'running')) this.startFresh(this.machine.mode === 'practice' ? 'practice' : 'first');
    else if (this.machine.running) {
      this.machine.skip();
      this.machine.drain();
      this.releaseClock(false);
      this.hideAll();
    }
  }

  // ------------------------------------------------------------------ frame
  update(dt: number): void {
    if (this.disposed) return;
    const now = performance.now();
    if (this.host.pointersDown() > 0) this.lastPointerAt = now;
    this.acc += dt;
    if (this.acc >= TICK_S) {
      this.acc = 0;
      this.tick(now);
      this.updateLearnChip();
    }
    if (this.machine.changed && now - this.lastSaveAt >= SAVE_EVERY_MS) this.writeBlob(false);
    this.layout(dt, now);
    this.ground.update(dt);
  }

  private tick(now: number): void {
    const m = this.machine;
    if (m.status !== 'running') {
      this.syncCards();
      return;
    }
    const sim = this.host.sim;
    const step = m.hintStep;
    const hc = this.hintContext();
    const sf = simFacts(sim, { plot: m.plot, homeHabitat: m.homeHabitat, animalId: m.animalId, objBase: m.objBase });
    this.hint = step ? this.hintCached(step, hc, sf) : null;
    const f: Facts = { ...sf, ...uiFacts(this.host), now, hint: this.hint };
    const prev = this.v;
    const v = m.tick(f);
    this.v = v;
    // step 5b: a tap that just missed the zebra selects its habitat; show the zebra's sheet instead
    if (m.current === 'happy') {
      const sel = this.host.selection();
      const a = sim.animals.get(m.animalId);
      if (sel?.kind === 'habitat' && a && a.habitatId === sel.id) this.host.select({ kind: 'animal', id: a.id });
    }
    // still nobody at the gate in step 9b (the clock was paused, or the gate just opened): ask again each second
    if (m.current === 'guests' && sim.guests.size === 0 && now - this.welcomeAt > 1000 && sim.speed > 0) this.welcomeGuests();
    // remember the corridor the child is shown, for the bench / bin / keeper spots later
    if (v.step === 'path' && this.hint?.kind === 'tiles') m.corridor = this.hint.tiles.map((t) => ({ x: t.x, z: t.z }));
    this.applyEffects(m.drain());
    if (m.status !== 'running') {
      this.syncCards();
      return;
    }
    this.render(v, prev);
  }

  private hintContext(): HintContext {
    const m = this.machine;
    return { plot: m.plot, homeHabitat: m.homeHabitat, animalId: m.animalId, speciesId: m.speciesId, corridor: m.corridor, regressed: !!m.current && m.regressed.has(m.current) };
  }

  private hintCached(step: StepId, hc: HintContext, sf: SimFacts): WorldHint | null {
    const sim = this.host.sim;
    // animals and guests move: their hints follow them every tick; the rest only change with the world
    const key = `${step}|${sim.world.revision}|${hc.homeHabitat}|${hc.regressed}|${sf.gap ? 1 : 0}|${sim.animals.size}|${sim.staff.size}`;
    if (step === 'happy' || key !== this.hintKey) {
      this.hintKey = key;
      try {
        this.hint = hintFor(step, sim, hc, sf.gap);
      } catch (err) {
        console.warn('[tutorial] hint failed', err);
        this.hint = null;
      }
    }
    return this.hint;
  }

  // ------------------------------------------------------------------ effects
  private applyEffects(effects: Effect[]): void {
    const host = this.host;
    for (const e of effects) {
      switch (e.kind) {
        case 'emit':
          host.events.emit('tutorial', { step: e.step, chapter: e.chapter, state: e.state });
          // step 9b: the first party walks in now instead of in ~20 s
          if (e.step === 'guests' && e.state === 'start') this.welcomeGuests();
          // Got it on the animal's sheet closes it: the next step's dock buttons are free again
          if (e.step === 'happy' && e.state === 'done' && host.selection()?.kind === 'animal') host.select(null);
          break;
        case 'clock':
          if (e.mode === 'hold') this.holdClock();
          else this.releaseClock(false);
          break;
        case 'frame':
          this.frame(e.step);
          break;
        case 'endTool':
          host.endTool();
          break;
        case 'pop':
          this.pop(e.text);
          break;
        case 'profile':
          setStatus(this.kv, this.opts.player.ref, e.status);
          break;
        case 'speak':
          this.lastSpoken = '';
          break;
      }
    }
  }

  private welcomeAt = 0;
  private welcomeGuests(): void {
    const sim = this.host.sim;
    this.welcomeAt = performance.now();
    if (sim.guests.size === 0) sim.welcomeFirstGuests?.();
  }

  private holdClock(): void {
    const host = this.host;
    if (!this.locked) {
      host.setSpeedLock(this.lock);
      this.locked = true;
    }
    if (host.sim.speed !== 0) host.setSpeed(0, 'ext');
  }

  /** Let the clock go; `resume` also sets 1× when the tutorial was holding it (skip). */
  private releaseClock(resume: boolean): void {
    const host = this.host;
    const was = this.locked;
    if (this.locked) {
      host.setSpeedLock(null);
      this.locked = false;
    }
    if (resume && was && host.sim.speed === 0 && !host.sim.versus) host.setSpeed(1, 'ext');
  }

  private blocked(): void {
    this.machine.note({ kind: 'speedLocked' });
    this.acc = TICK_S;
  }

  private frame(step: StepId, zoomOut = 1): void {
    const sim = this.host.sim;
    const m = this.machine;
    const hc = this.hintContext();
    let at: { x: number; z: number } | null = null;
    let d = 30;
    try {
      if (step === 'fence') {
        if (m.plot) {
          at = rectCentre(m.plot);
          d = 38;
        }
      } else if (step === 'paint') {
        const h = sim.world.habitats.get(homeOf(sim, hc));
        if (h) at = { x: ((h.minX + h.maxX + 1) / 2) * TILE, z: ((h.minZ + h.maxZ + 1) / 2) * TILE };
      } else if (step === 'water' || step === 'shelter' || step === 'plant' || step === 'adopt') {
        // the yellow spot, with the habitat around it
        const h = sim.world.habitats.get(homeOf(sim, hc));
        const spot = hintFor(step, sim, hc, null);
        if (h) at = { x: ((h.minX + h.maxX + 1) / 2) * TILE, z: ((h.minZ + h.maxZ + 1) / 2) * TILE };
        if (spot && at) {
          const b = hintBounds(spot);
          at = { x: (at.x + (b.x0 + b.x1) / 2) / 2, z: (at.z + (b.z0 + b.z1) / 2) / 2 };
        }
      } else if (step === 'happy') {
        const a = sim.animals.get(m.animalId) ?? sim.animals.values().next().value;
        if (a) {
          at = { x: a.x, z: a.z };
          d = 16;
        }
      } else if (step === 'path' || step === 'kiosk' || step === 'bench' || step === 'bin' || step === 'keeper') {
        const h = hintFor(step, sim, hc, null);
        if (h) {
          const b = hintBounds(h);
          at = { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 };
          d = 26;
        }
      } else if (step === 'guests') {
        at = GATE_SPOT;
        d = 26;
      }
    } catch (err) {
      console.warn('[tutorial] framing failed', err);
    }
    // a short screen shows less ground: start a little further out there
    const short = Math.max(1, 412 / Math.max(240, window.innerHeight));
    if (at) this.host.focusClear(at.x, at.z, d * zoomOut * short);
  }

  private pop(text: string): void {
    const r = this.placed;
    const vw = window.innerWidth,
      vh = window.innerHeight;
    const x = r ? (r.left + r.right) / 2 : vw / 2;
    const y = r ? (r.top + r.bottom) / 2 : vh / 3;
    this.overlay.pop(text, Math.max(70, Math.min(vw - 70, x)), Math.max(40, Math.min(vh - 40, y)));
    try {
      this.host.audio.play('celebrate');
    } catch {
      /* no audio */
    }
  }

  // ------------------------------------------------------------------ persistence
  private writeBlob(saveNow: boolean): void {
    const sim = this.host.sim;
    if (sim.versus) return;
    const b = this.machine.blob();
    sim.tutorial = b ? (JSON.parse(JSON.stringify(b)) as Record<string, unknown>) : null;
    this.machine.changed = false;
    const now = performance.now();
    if (saveNow || now - this.lastSaveAt >= SAVE_EVERY_MS) {
      this.lastSaveAt = now;
      try {
        this.host.save();
      } catch (err) {
        console.warn('[tutorial] save failed', err);
      }
    }
  }

  // ------------------------------------------------------------------ cards
  /** Show the welcome or finish card when the machine's status changes. */
  private syncCards(): void {
    const st = this.machine.status;
    if (st === this.lastStatus) return;
    this.lastStatus = st;
    if (st === 'welcome') {
      this.hideAll();
      const name = this.opts.player.name;
      const title = name ? fill(CARDS.welcomeTitleNamed, { name }) : CARDS.welcomeTitle;
      this.overlay.showWelcome({
        title,
        text: CARDS.welcomeText,
        note: this.machine.mode === 'practice' ? CARDS.welcomePractice : undefined,
        speaker: this.speakerState(),
        go: () => this.letsGo(),
        skip: () => this.askSkip(),
        speakerToggle: () => this.toggleReadAloud(),
      });
      if (this.readAloud) this.speakWelcome();
    } else if (st === 'finish') {
      this.finish();
    } else if (st === 'off') {
      this.overlay.hideCard();
      this.hideAll();
    }
  }

  private letsGo(): void {
    if (this.machine.status !== 'welcome') return;
    this.speech.stop();
    this.overlay.hideCard();
    this.machine.begin(performance.now());
    this.lastStatus = 'running';
    try {
      this.host.audio.resume();
    } catch {
      /* no audio */
    }
    this.writeBlob(true);
    this.acc = TICK_S;
    this.tick(performance.now());
  }

  private finish(): void {
    const host = this.host;
    const sim = host.sim;
    this.speech.stop();
    this.hideAll();
    this.releaseClock(false);
    sim.tutorial = null;
    this.machine.changed = false;
    try {
      host.save();
    } catch {
      /* main says */
    }
    const a = sim.animals.get(this.machine.animalId) ?? sim.animals.values().next().value;
    const sp = SPECIES.find((s) => s.id === (a?.speciesId ?? this.machine.speciesId ?? 'zebra'));
    const vars = { speciesId: a?.speciesId ?? this.machine.speciesId, n: sp ? Math.max(1, sp.groupMin - 1) : 2 };
    const text = a && a.happiness >= 0.55 ? fill(CARDS.finishHappy, vars) : CARDS.finishGuests;
    const rows = [
      { icon: 'paw' as const, text: sp && sp.groupMin > 1 ? fill(CARDS.tryFriends, vars) : CARDS.tryMore },
      { icon: 'home' as const, text: CARDS.tryRestrooms },
      { icon: 'trophy' as const, text: this.opts.versusEnabled ? CARDS.tryVersus : CARDS.tryGoal },
    ];
    const close = () => {
      this.overlay.hideCard();
      this.machine.closeFinish();
      this.lastStatus = 'off';
      host.setPillStep(null);
      host.root.classList.remove('wh-pill-off');
    };
    const buttons = this.practice || this.machine.mode === 'practice'
      ? [
          { label: BUTTONS.keepPlayingHere, primary: false, run: close },
          { label: BUTTONS.backToMyZoo, primary: true, run: () => this.backToMyZoo() },
        ]
      : [{ label: BUTTONS.keepPlaying, primary: true, run: close }];
    this.overlay.showFinish({ text, rows, buttons });
    if (!this.reduced) this.overlay.leafBurst();
    if (this.readAloud && this.voice) this.speech.speak(`${CARDS.finishTitle} ${text}`);
  }

  private backToMyZoo(): void {
    this.speech.stop();
    this.host.switchSlot({ kind: 'continue', player: this.opts.player.ref, slot: 'main', discard: 'practice' }).catch((err) => console.warn('[tutorial] switchSlot failed', err));
  }

  // ------------------------------------------------------------------ skip / help / events
  private askSkip(): void {
    if (this.host.dialogOpen()) return;
    void this.host
      .showDialog({ title: CARDS.skipTitle, text: CARDS.skipText, ok: CARDS.skipOk, cancel: CARDS.skipCancel, primary: 'cancel' })
      .then((ok) => {
        if (ok) this.doSkip();
      });
  }

  private doSkip(): void {
    const wasHeld = this.locked;
    this.speech.stop();
    this.machine.skip();
    this.applyEffects(this.machine.drain());
    if (wasHeld && this.host.sim.speed === 0) this.host.setSpeed(1, 'ext');
    this.host.sim.tutorial = null;
    try {
      this.host.save();
    } catch {
      /* main says */
    }
    this.lastStatus = '';
    this.syncCards();
  }

  private noteAndTick(e: Parameters<TutorialMachine['note']>[0]): void {
    this.machine.note(e);
    this.handT = 0;
    this.acc = TICK_S;
    this.tick(performance.now());
  }

  private async help(): Promise<void> {
    if (this.helping) return;
    const step = this.machine.current;
    if (!step) return;
    this.helping = true;
    this.handSlow = 1.5;
    this.handT = 0;
    const host = this.host;
    const hh: HelpHost = {
      sim: host.sim,
      runCommand: (fn, at) => host.runCommand(fn, at),
      select: (s) => host.select(s),
      setSpeed: (s: SimSpeed, src) => host.setSpeed(s, src),
      openMenu: (t) => host.openMenu(t),
      cameraDemo: (k) => host.cameraDemo(k),
      tapPill: () => host.hudEl('pill')?.click(),
    };
    try {
      if (step !== 'look-pan' && step !== 'look-zoom' && step !== 'look-turn') host.endTool();
      const sf = simFacts(host.sim, { plot: this.machine.plot, homeHabitat: this.machine.homeHabitat, animalId: this.machine.animalId, objBase: this.machine.objBase });
      const out = await runHelp(step, hh, this.hintContext(), sf.gap, this.hint);
      if (out.ok) {
        this.machine.note({ kind: 'helped' });
        this.pop(HELP_POP);
      } else this.machine.note({ kind: 'helpFailed' });
    } catch (err) {
      console.warn('[tutorial] help failed', err);
    } finally {
      this.helping = false;
      this.handSlow = 1;
      this.acc = TICK_S;
    }
  }

  private painted(r: TileRect): void {
    if (this.machine.current !== 'paint') return;
    const w = this.host.sim.world;
    let inHab = false;
    for (let z = r.z0; z <= r.z1 && !inHab; z++) for (let x = r.x0; x <= r.x1 && !inHab; x++) if (w.inBounds(x, z) && w.habitatOf[w.idx(x, z)]) inHab = true;
    this.machine.note({ kind: 'painted', inHabitat: inHab });
    this.acc = TICK_S;
  }

  private pillTapped(): void {
    const m = this.machine;
    if (m.status !== 'running') {
      if (m.status === 'welcome') return;
      return;
    }
    if (m.current === 'goal') {
      m.note({ kind: 'pillTapped' });
      this.acc = TICK_S;
      return;
    }
    // "show me": close what is in the way, frame the step again, replay the hand and the voice
    const host = this.host;
    if (host.selection()) host.select(null);
    host.closeDrawer();
    if (m.current) this.frame(m.current);
    this.handT = 0;
    this.lastSpoken = '';
    this.acc = TICK_S;
  }

  // ------------------------------------------------------------------ read aloud
  private speakerState(): 'on' | 'off' | 'hidden' {
    if (!this.voice) return 'hidden';
    return this.readAloud ? 'on' : 'off';
  }

  private toggleReadAloud(): void {
    if (!this.voice) return;
    this.readAloud = !this.readAloud;
    setReadAloud(this.kv, this.opts.player.ref, this.readAloud);
    this.host.events.emit('tutorial', { step: this.machine.current ?? '', chapter: this.v?.chapter ?? 0, state: 'prefs' });
    if (!this.readAloud) this.speech.stop();
    else if (this.machine.status === 'welcome') this.speakWelcome();
    else this.lastSpoken = '';
    this.overlay.setWelcomeSpeaker(this.speakerState());
    this.renderSettings();
  }

  private speakWelcome(): void {
    if (!this.voice || !this.readAloud) return;
    const name = this.opts.player.name;
    const title = name ? fill(CARDS.welcomeTitleNamed, { name }) : CARDS.welcomeTitle;
    this.speech.speak(`${title} ${CARDS.welcomeText}`);
  }

  stopSpeech(): void {
    this.speech.stop();
    this.lastSpoken = '';
  }

  // ------------------------------------------------------------------ settings
  private renderSettings(): void {
    if (!this.host) return;
    this.sectionOff?.();
    this.sectionOff = null;
    // no practice zoo from inside a versus match
    if (this.host.sim.versus) return;
    this.sectionOff = this.host.addSettingsSection({
      id: 'tutorial',
      order: 30,
      render: () => {
        const row = (title: string, sub: string, ctrl: HTMLElement) =>
          el('div', 'wh-setting', [el('div', { class: 'wh-setting-t', html: `<b>${escapeHtml(title)}</b><span>${escapeHtml(sub)}</span>` }), ctrl]);
        const rows: HTMLElement[] = [];
        if (this.practice) rows.push(row(CARDS.settingsPractice, CARDS.settingsPracticeText, button('wh-btn-primary wh-tut-set-back', null, BUTTONS.backToMyZoo, () => this.backToMyZoo())));
        rows.push(row(CARDS.settingsTutorial, CARDS.settingsTutorialText, button('wh-btn-ghost wh-tut-set-play', null, BUTTONS.playTutorial, () => this.askPractice(false))));
        if (this.voice) {
          const sw = button(`wh-switch wh-tut-set-aloud ${this.readAloud ? 'on' : ''}`, null, null, () => this.toggleReadAloud(), CARDS.settingsAloud);
          sw.setAttribute('role', 'switch');
          sw.setAttribute('aria-checked', String(this.readAloud));
          rows.push(row(CARDS.settingsAloud, CARDS.settingsAloudText, sw));
        }
        const box = el('div', 'wh-tut-settings', rows);
        box.style.display = 'contents';
        return box;
      },
    });
  }

  private askPractice(fromChip: boolean): void {
    if (fromChip) this.learnDismissed = true;
    void this.host.showDialog({ title: CARDS.practiceTitle, text: CARDS.practiceText, ok: CARDS.practiceOk, cancel: CARDS.practiceCancel }).then((ok) => {
      if (!ok) return;
      this.host.switchSlot({ kind: 'tutorial', player: this.opts.player.ref, slot: 'practice' }).catch((err) => {
        console.warn('[tutorial] switchSlot failed', err);
        this.host.notify('The practice zoo is not available here.', 'warn');
      });
    });
  }

  /** "Learn to play" under the goal pill for players who skipped, until day 6 or a tap. */
  private updateLearnChip(): void {
    const sim = this.host.sim;
    const show = !this.learnDismissed && !this.machine.running && this.machine.status !== 'finish' && !sim.versus && sim.day < 6 && readProfile(this.kv, this.opts.player.ref).status === 'skipped';
    if (!show) {
      this.overlay.placeLearn(null);
      return;
    }
    const pill = this.host.hudEl('pill');
    const r = pill && getComputedStyle(pill).visibility !== 'hidden' ? pill.getBoundingClientRect() : null;
    this.overlay.placeLearn(r && r.height > 0 ? { left: r.left, top: r.bottom + 6 } : null);
  }

  // ------------------------------------------------------------------ render
  private render(v: TutorialView, prev: TutorialView | null): void {
    const host = this.host;
    if (v.status !== 'running') return;
    const ov = this.overlay;
    if (v.hidden) {
      ov.showBubble(false);
      host.setReservedRect('tutorial', null);
      this.placed = null;
      const pill = this.machine.pillFor(v);
      host.setPillStep(v.pillStep ? pill : null);
      host.root.classList.remove('wh-pill-off');
      this.ground.setVisible(!host.zooPanel().close);
      return;
    }
    this.ground.setVisible(true);
    if (v.step === 'goal' && !v.review) {
      host.setPillStep(null);
      host.root.classList.remove('wh-pill-off');
    } else {
      host.setPillStep(this.machine.pillFor(v));
      host.root.classList.add('wh-pill-off');
    }
    const narrow = window.innerWidth < 700;
    const text = v.text ?? lineFor('nudge.resume');
    ov.setContent({
      chip: stepLabel(v.chapter, narrow),
      title: CHAPTERS[v.chapter - 1] ?? '',
      a: text.a,
      w: text.w ?? '',
      speaker: this.speakerState(),
      buttons: v.buttons,
    });
    ov.showBubble(true);
    // markers: the step's world hint (hidden while reviewing another step's line)
    this.ground.set(v.review ? null : v.target?.kind === 'world' ? v.target.hint : v.step === 'happy' ? this.hint : null);
    const key = `${v.step}|${v.phase}|${v.line}|${v.review}`;
    if (!prev || key !== `${prev.step}|${prev.phase}|${prev.line}|${prev.review}`) {
      this.handT = 0;
      this.revealed = null;
    }
    // read aloud each new line
    const say = speechText(text.a, text.w);
    if (this.readAloud && this.voice && say !== this.lastSpoken) {
      this.lastSpoken = say;
      this.speech.speak(say);
    }
  }

  private hideAll(): void {
    if (!this.overlay) return;
    const host = this.host;
    this.overlay.showBubble(false);
    this.overlay.setHole(null);
    this.overlay.setRing(null);
    this.overlay.hideHand();
    this.ground.set(null);
    host.setReservedRect('tutorial', null);
    host.setReservedRect('tutorial-bar', null);
    host.setPillStep(null);
    host.root.classList.remove('wh-pill-off');
    this.placed = null;
  }

  /** Screen rect(s) of the view's target. */
  private targetRect(t: TargetSpec | null): { rect: Rect | null; radius: number; container: Rect | null; handFrom?: { x: number; y: number }; handTo?: { x: number; y: number } } {
    const host = this.host;
    if (!t) return { rect: null, radius: 16, container: null };
    switch (t.kind) {
      case 'cat':
        return { rect: rectOfEl(host.categoryButton(t.id)), radius: 14, container: null };
      case 'card': {
        const c = host.card((k) => k === t.key);
        if (c && c !== this.revealed) {
          host.revealCard(c);
          this.revealed = c;
        }
        return { rect: rectOfEl(c), radius: 14, container: rectOfEl(host.drawer()) };
      }
      case 'confirm':
        return { rect: rectOfEl(host.confirmOk()), radius: 12, container: rectOfEl(host.confirmBar()) };
      case 'speed': {
        let r: Rect | null = null;
        for (const s of t.s) {
          const e = rectOfEl(host.hudSpeedButton(s));
          if (e) r = r ? union(r, e) : e;
        }
        const last = rectOfEl(host.hudSpeedButton(t.s[t.s.length - 1]));
        return { rect: r, radius: 20, container: null, handTo: last ? { x: (last.left + last.right) / 2, y: (last.top + last.bottom) / 2 } : undefined };
      }
      case 'speedGroup':
        return { rect: rectOfEl(host.hudEl('speedGroup')), radius: 22, container: null };
      case 'money':
        return { rect: rectOfEl(host.hudEl('money')), radius: 22, container: null };
      case 'pill':
        return { rect: rectOfEl(host.hudEl('pill')), radius: 16, container: null };
      case 'sheetMeter': {
        const s = host.sheet();
        return { rect: rectOfEl(s.anchor('happiness')), radius: 10, container: rectOfEl(s.root) };
      }
      case 'sheetClose': {
        const s = host.sheet();
        return { rect: rectOfEl(s.close), radius: 22, container: rectOfEl(s.root) };
      }
      case 'panelClose':
        return { rect: rectOfEl(host.zooPanel().close), radius: 22, container: null };
      case 'panelTab':
        return { rect: rectOfEl(host.zooPanel().tabButton(t.tab)), radius: 12, container: null };
      case 'gesture':
        return { rect: null, radius: 0, container: null };
      case 'world':
        return this.worldRect(t.hint);
    }
  }

  /** The projected screen rect of a world hint, and the hand's drag ends. */
  private worldRect(h: WorldHint | null): { rect: Rect | null; radius: number; container: Rect | null; handFrom?: { x: number; y: number }; handTo?: { x: number; y: number } } {
    if (!h) return { rect: null, radius: 0, container: null };
    const host = this.host;
    const w = host.sim.world;
    const p = (x: number, z: number) => host.project(x, w.heightAt(x, z), z);
    const b = hintBounds(h);
    const pts = [p(b.x0, b.z0), p(b.x1, b.z0), p(b.x0, b.z1), p(b.x1, b.z1)];
    const rect: Rect = {
      left: Math.min(...pts.map((q) => q.x)),
      top: Math.min(...pts.map((q) => q.y)),
      right: Math.max(...pts.map((q) => q.x)),
      bottom: Math.max(...pts.map((q) => q.y)),
    };
    let handFrom: { x: number; y: number } | undefined;
    let handTo: { x: number; y: number } | undefined;
    if (h.kind === 'box') {
      // a quarter tile in from the corners: the fence tool rounds to the corner, the paint brush to the tile inside
      handFrom = p(b.x0 + TILE * 0.25, b.z0 + TILE * 0.25);
      handTo = p(b.x1 - TILE * 0.25, b.z1 - TILE * 0.25);
    } else if (h.kind === 'tiles' && h.tiles.length > 1) {
      const a = h.tiles[0],
        z = h.tiles[h.tiles.length - 1];
      handFrom = p((a.x + 0.5) * TILE, (a.z + 0.5) * TILE);
      handTo = p((z.x + 0.5) * TILE, (z.z + 0.5) * TILE);
    } else if (h.kind === 'animal') {
      const a = host.sim.animals.get(h.id);
      const q = a ? p(a.x, a.z) : p(h.x, h.z);
      handTo = { x: q.x, y: q.y - 10 };
    } else if (h.kind === 'spot') {
      // the tile the finger must land on (the object tool places a footprint from it)
      const a = anchorTile(h.spot);
      const c = p((a.x + 0.5) * TILE, (a.z + 0.5) * TILE);
      handTo = { x: c.x, y: c.y };
    } else {
      const c = p((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
      handTo = { x: c.x, y: c.y };
    }
    return { rect, radius: 0, container: null, handFrom, handTo };
  }

  /** Per frame: place the bubble, dim, ring and hand over the current target. */
  private layout(dt: number, now: number): void {
    const v = this.v;
    const ov = this.overlay;
    const host = this.host;
    if (!v || v.status !== 'running' || v.hidden || this.machine.status !== 'running') {
      host.setReservedRect('tutorial-bar', null);
      ov.setHole(null);
      ov.setRing(null);
      ov.hideHand();
      return;
    }
    const vw = window.innerWidth,
      vh = window.innerHeight;
    const t = this.targetRect(v.target);
    const view = toRect(host.viewArea());
    const hudBar = this.hudRect();
    const safe: Rect = { left: 10, top: 8, right: vw - 10, bottom: vh - 8 };
    const obstacles: Rect[] = [];
    const add = (e: Element | null | undefined) => {
      const r = rectOfEl(e);
      if (r) obstacles.push(r);
    };
    const zone = v.zone;
    // a HUD step may sit over an open drawer (e.g. the one the goal pill just opened); a dock
    // nudge ("Tap Habitat first.") over the wrong drawer, never over the other dock buttons
    if (zone !== 'drawer' && zone !== 'hud' && zone !== 'dock') add(host.drawer());
    if (zone !== 'confirm') add(host.confirmBar());
    add(host.toolBar());
    if (zone !== 'sheet') add(host.sheet().root);
    if (zone === 'hud' || zone === 'sheet' || zone === 'world' || zone === 'confirm' || zone === 'dock') add(host.categoryButton('habitats')?.parentElement);
    // the bubble's size (re-measured only when its content changes)
    const key = `${v.step}|${v.line}|${v.text?.a}|${v.text?.w}|${JSON.stringify(v.buttons)}|${this.speakerState()}|${vw}x${vh}`;
    if (key !== this.sizeKey) {
      this.sizeKey = key;
      this.narrowW = undefined;
      this.size = ov.measure();
    }
    let avoid: Rect | null = t.rect;
    if (t.handFrom && t.handTo) {
      const hp: Rect = { left: Math.min(t.handFrom.x, t.handTo.x) - 10, top: Math.min(t.handFrom.y, t.handTo.y) - 10, right: Math.max(t.handFrom.x, t.handTo.x) + 46, bottom: Math.max(t.handFrom.y, t.handTo.y) + 56 };
      avoid = avoid ? union(avoid, hp) : hp;
    }
    if (zone === 'world') {
      const work = host.workRect();
      if (work) avoid = avoid ? union(avoid, toRect(work)) : toRect(work);
    } else if (zone === 'confirm') {
      // keep the pending build itself in sight where there is room
      const work = host.workRect();
      avoid = work ? toRect(work) : null;
    } else avoid = null;
    const input: PlaceInput = {
      vw,
      vh,
      safe,
      size: this.size,
      target: zone === 'world' || zone === 'gesture' ? null : t.rect,
      zone,
      view,
      hud: hudBar,
      obstacles,
      container: t.container,
      gap: zone === 'panel' ? host.zooPanel().headGap() : null,
      avoid,
    };
    let res = placeBubble(input);
    if (res.maxW && res.maxW !== this.narrowW) {
      this.narrowW = res.maxW;
      this.size = ov.measure(res.maxW);
      res = placeBubble({ ...input, size: this.size });
    } else if (!res.maxW && this.narrowW) {
      this.narrowW = undefined;
      this.size = ov.measure();
      res = placeBubble({ ...input, size: this.size });
    }
    ov.place(res.left, res.top, res.arrow, res.faded, zone === 'panel');
    // while a world marker is the target, the tool bar is off limits for the camera's clear area too
    // (so a re-frame centres the marker above it)
    let bars: Rect | null = null;
    if (zone === 'world' && !v.review) for (const e of [host.toolBar(), host.confirmBar()]) {
      const r = rectOfEl(e);
      if (r) bars = bars ? union(bars, r) : r;
    }
    host.setReservedRect('tutorial-bar', bars ? { left: 0, top: bars.top, right: vw, bottom: vh } : null);
    const placed: Rect = { left: res.left, top: res.top, right: res.left + this.size.w, bottom: res.top + this.size.h };
    this.placed = placed;
    this.lastLayout = { zone, how: res.how, ok: res.ok, faded: res.faded, bubble: placed, target: t.rect, handFrom: t.handFrom ?? null, handTo: t.handTo ?? null, clear: true };
    host.setReservedRect('tutorial', placed);
    // dim + hole (DOM targets only), hidden while a finger is down
    const fingers = now - this.lastPointerAt < 1000;
    // a yellow marker under the docked bubble or off the view: glide the camera to it (a little
    // further out each time), never while a finger is down
    let clear = true;
    if (zone === 'world' && t.rect && !v.review) {
      // the marker (and the hand's path) must be in the open: not under the bubble, the tool bar,
      // the confirm bar or the dock, and inside the view
      const tr = t.rect;
      const inner = inflate(tr, -3);
      const off =
        intersects(placed, inflate(tr, 4)) ||
        obstacles.some((o) => intersects(o, inner)) ||
        tr.left < view.left || tr.right > view.right || tr.top < view.top || tr.bottom > view.bottom;
      clear = !off;
      if (off && now - this.lastPointerAt > 1200 && now - this.reframedAt > 1600 && this.reframes < 5 && v.step) {
        this.reframes++;
        this.reframedAt = now;
        this.frame(v.step, 1 + 0.3 * this.reframes);
      }
    }
    if (this.lastLayout) this.lastLayout.clear = clear;
    ov.setHole(v.dim && t.rect && !fingers && !v.review ? t.rect : null);
    const ringRect = v.target?.kind === 'world' || v.target?.kind === 'gesture' ? null : t.rect;
    ov.setRing(ringRect, t.radius, zone === 'panel');
    this.animateHand(dt, v, t, view, fingers);
  }

  private hudRect(): Rect {
    const host = this.host;
    const money = rectOfEl(host.hudEl('money'));
    const menu = rectOfEl(host.hudEl('menu'));
    if (money && menu) return { left: money.left, top: Math.min(money.top, menu.top), right: menu.right, bottom: Math.max(money.bottom, menu.bottom) };
    return { left: 10, top: 8, right: window.innerWidth - 10, bottom: 54 };
  }

  private animateHand(dt: number, v: TutorialView, t: ReturnType<TutorialController['targetRect']>, view: Rect, fingers: boolean): void {
    const ov = this.overlay;
    const kind = v.hand;
    if (!kind || fingers) {
      ov.hideHand();
      return;
    }
    const now = performance.now();
    // 20 s without progress: replay at once (and say it again)
    const key = `${v.step}|${v.phase}`;
    if (key !== this.handKey) {
      this.handKey = key;
      this.handT = 0;
      this.lastReplayAt = now;
      this.reframes = 0;
    } else if (now - this.lastReplayAt > NUDGE_REPLAY_MS) {
      this.lastReplayAt = now;
      this.handT = 0;
      this.lastSpoken = '';
    }
    const cyc = HAND_CYCLE_S * this.handSlow;
    this.handT += dt;
    const period = cyc * HAND_CYCLES + HAND_REST_S;
    const inPeriod = this.handT % period;
    if (inPeriod > cyc * HAND_CYCLES && !this.reduced) {
      ov.hideHand();
      return;
    }
    const u = this.reduced ? 0.45 : (inPeriod % cyc) / cyc;
    const cx = (view.left + view.right) / 2,
      cy = (view.top + view.bottom) / 2 + 20;
    const fade = (a: number, b: number) => (u < a ? u / a : u > b ? Math.max(0, 1 - (u - b) / (1 - b)) : 1);
    switch (kind) {
      case 'tap': {
        const p = t.handTo ?? (t.rect ? { x: (t.rect.left + t.rect.right) / 2, y: (t.rect.top + t.rect.bottom) / 2 } : null);
        if (!p) {
          ov.hideHand();
          return;
        }
        ov.dotsAt(null);
        ov.trailFrom(null);
        if (u < 0.35) {
          const k = ease(u / 0.35);
          ov.handAt(p.x + 34 * (1 - k), p.y + 44 * (1 - k), 1, Math.min(1, u / 0.12));
          ov.rippleAt(null);
        } else if (u < 0.55) {
          ov.handAt(p.x, p.y, 0.88, 1);
          ov.rippleAt(p, (u - 0.35) / 0.2);
        } else {
          ov.rippleAt(null);
          ov.handAt(p.x, p.y, 1, fade(0.01, 0.75));
        }
        return;
      }
      case 'drag': {
        const a = t.handFrom ?? { x: view.left + (view.right - view.left) * 0.35, y: cy };
        const b = t.handTo ?? { x: view.left + (view.right - view.left) * 0.65, y: cy };
        ov.dotsAt(null);
        ov.rippleAt(null);
        const k = u < 0.15 ? 0 : u > 0.75 ? 1 : ease((u - 0.15) / 0.6);
        const x = a.x + (b.x - a.x) * k,
          y = a.y + (b.y - a.y) * k;
        ov.handAt(x, y, u > 0.08 && u < 0.8 ? 0.9 : 1, fade(0.08, 0.85));
        ov.trailFrom(u > 0.15 ? a : null, { x, y }, fade(0.08, 0.85) * 0.9);
        return;
      }
      case 'pinch': {
        const r = 40 + 80 * (u < 0.15 ? 0 : u > 0.75 ? 1 : ease((u - 0.15) / 0.6));
        const pts = [
          { x: cx - r, y: cy },
          { x: cx + r, y: cy },
        ];
        const o = fade(0.08, 0.85);
        ov.dotsAt(pts, o);
        ov.trailFrom(null);
        ov.rippleAt(null);
        ov.handAt(pts[1].x, pts[1].y, 0.9, o);
        return;
      }
      case 'twist': {
        const ang = (Math.PI / 3) * (u < 0.15 ? 0 : u > 0.75 ? 1 : ease((u - 0.15) / 0.6));
        const r = 80;
        const pts = [
          { x: cx - Math.cos(ang) * r, y: cy - Math.sin(ang) * r },
          { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r },
        ];
        const o = fade(0.08, 0.85);
        ov.dotsAt(pts, o);
        ov.trailFrom(null);
        ov.rippleAt(null);
        ov.handAt(pts[1].x, pts[1].y, 0.9, o);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ host hooks
  handleBack(): boolean {
    if (this.overlay?.cardOpen) {
      // Android back = the card's primary action
      this.overlay.cardPrimary()?.click();
      return true;
    }
    return false;
  }

  onKey(code: string): boolean {
    if (code !== 'Enter' && code !== 'NumpadEnter') return false;
    if (this.overlay?.cardOpen) {
      this.overlay.cardPrimary()?.click();
      return true;
    }
    const v = this.v;
    if (!v || v.hidden || this.machine.status !== 'running') return false;
    if (v.buttons.gotIt) {
      this.noteAndTick({ kind: 'gotIt' });
      return true;
    }
    if (v.buttons.next) {
      this.noteAndTick({ kind: 'next' });
      return true;
    }
    return false;
  }

  view(): TutorialView | null {
    return this.machine.status === 'running' ? this.v ?? this.machine.view : this.machine.statusView();
  }

  /** The current world hint and its screen rect (automation). */
  hintInfo(): { step: StepId | null; hint: WorldHint | null; bounds: ReturnType<typeof hintBounds> | null } {
    return { step: this.machine.hintStep, hint: this.hint, bounds: this.hint ? hintBounds(this.hint) : null };
  }

  /** Debug / e2e: the machine's state. */
  debugState(): Record<string, unknown> {
    const m = this.machine;
    return {
      status: m.status,
      mode: m.mode,
      current: m.current,
      passed: [...m.passed],
      plot: m.plot,
      homeHabitat: m.homeHabitat,
      animalId: m.animalId,
      locked: this.locked,
      gateOpen: gateOpen(this.host.sim),
      bubble: this.placed,
      voice: this.voice,
      readAloud: this.readAloud,
    };
  }

  /** Debug / e2e: where the bubble went and what it points at. */
  debugLayout(): Record<string, unknown> | null {
    return this.lastLayout;
  }

  /** Debug / e2e: press Help me for the current step. */
  debugHelp(): Promise<void> {
    return this.help();
  }

  /** Debug: finish at once (e2e practice scenario). */
  debugFinish(): void {
    const m = this.machine;
    if (m.status === 'welcome') {
      m.begin(performance.now());
      this.overlay.hideCard();
    }
    // every step counts as done whatever the zoo holds (skipped steps are never re-checked)
    m.debugPassBefore('speed-note');
    for (const s of m.steps) {
      m.passed.add(s.id);
      m.skipped.add(s.id);
    }
    this.acc = TICK_S;
    this.tick(performance.now());
  }

  /** Debug: mark the steps before `id` passed (the zoo is not changed). */
  debugJump(id: StepId): void {
    const m = this.machine;
    if (m.status === 'welcome') {
      m.begin(performance.now());
      this.overlay.hideCard();
      this.lastStatus = 'running';
    }
    m.debugPassBefore(id);
    this.acc = TICK_S;
    this.tick(performance.now());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.speech.stop();
    for (const off of this.offs) off();
    this.offs = [];
    this.sectionOff?.();
    if (this.locked) this.host.setSpeedLock(null);
    this.hideAll();
    this.overlay?.dispose();
    this.ground?.dispose();
  }
}

export function createTutorialExtension(opts: TutorialOptions): TutorialExtension {
  return new TutorialController(opts);
}

export { tutorialDone } from './profile';
