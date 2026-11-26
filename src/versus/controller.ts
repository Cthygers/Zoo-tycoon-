// Versus match controller (spec §5.6, §7.2–§7.5, §8.7): boots the match's zoo, holds the clock
// through the 3-2-1 countdown, keeps the seat's real-time budget, queues the hourly snapshots
// and the final for upload (through net's per-match outbox), follows the opponent and runs the
// end of the match. main.ts drives it once per frame; the versus UI extension reads it.
//
// Boot order: read wh2:vs → GET match (4 s, else the cached DTO; neither → "Connect to the
// internet…") → refuse ended matches and seats bound to another device → load the local vs slot
// (same matchId) or start the match's new zoo → a budget already used up ends the match now →
// hold until the countdown's "Go!".
import type { Avatar, FinishBody, MatchDto, SeriesRow, SnapshotsResponse, VersusParts, VersusSnapshot } from '../../shared/api-types';
import { SNAPSHOT_EVERY_HOURS, VERSUS_RULES_VERSION, VERSUS_START_MINUTE, type VersusRules } from '../../shared/versus-rules';
import type { CloudHandle, OutboxState } from '../core/cloud-types';
import type { BootIntent, ISimulation, PlayerInfo, SlotKey, VersusView } from '../core/contracts';
import type { EventBus } from '../core/events';
import type { KV } from '../core/player-state';
import { slotKey, vsSlot } from '../core/storage-keys';
import { bytesToBase64, gzipString, sha256HexSync } from '../net/codec';
import { addForeground, budgetLeft, newBudget, noteHidden, noteVisible, startBudget } from './budget';
import { readRecord, upsertIndex, writeRecord, type VersusRecord } from './record';

/** The countdown before play (and after every break): 3… 2… 1… Go! */
export const COUNTDOWN_S = 3;
/** How long "Go!" stays on screen after the hold ends. */
export const GO_FLASH_S = 0.8;
/** Autosave, outbox flush and opponent poll cadence (real seconds). */
export const SAVE_EVERY_S = 30;
export const FLUSH_EVERY_S = 30;
export const POLL_EVERY_S = 30;
/** The opponent's points series is refreshed this often (real seconds). */
export const SERIES_EVERY_S = 300;
/** Longest frame the 4× clock catches up (4 fps). */
export const MAX_FRAME_S = 0.25;

export const BOOT_MSG = {
  offline: 'Connect to the internet to start this match.',
  ended: 'This match has ended.',
  update: 'Update Wildhaven Zoo to play this match.',
  elsewhere: (name: string) => `This match is being played on ${name}.`,
  lost: 'This match was lost. Your zoo is kept as practice.',
} as const;

/** A match that cannot be played here; `message` is the kid text the loading screen shows. */
export class VersusBootError extends Error {
  constructor(
    message: string,
    readonly reason: 'offline' | 'ended' | 'other_device' | 'update' = 'offline',
  ) {
    super(message);
    this.name = 'VersusBootError';
  }
}

/** The other player as the HUD chip and the breakdown sheet show them (null while nobody joined). */
export interface OpponentView {
  name: string;
  avatar: Avatar;
  lastHour: number;
  total: number;
  atMyHour: number | null;
  parts: VersusParts | null;
  live: boolean;
  done: boolean;
}

export interface CountdownView {
  /** Seconds left (3 → 0); 0 while "Go!" flashes. */
  left: number;
  /** The very first countdown of this seat (the match starts) rather than a return from a break. */
  first: boolean;
  /** "Go!" is showing (the hold is over). */
  go: boolean;
}

export interface VersusController {
  readonly matchId: string;
  readonly slotKey: SlotKey;
  readonly holding: boolean;
  boot(sim: ISimulation): Promise<void>;
  startCountdown(): void;
  frameDt(rawSeconds: number): number;
  update(realDt: number): void;
  wantsSave(): boolean;
  onHidden(keepaliveBudgetBytes: number): number;
  onVisible(): void;
  budgetLeftMs(): number;
  opponent(): OpponentView | null;
  outbox(): OutboxState;
  // ---- read by the versus UI extension (src/ui/versus)
  readonly player: PlayerInfo;
  /** The match as last heard from the server (or cached). */
  match(): MatchDto | null;
  /** The sim's match state once booted. */
  view(): VersusView | null;
  countdown(): CountdownView | null;
  /** Real seconds left to play: min(game time left / 4, budget left). */
  timeLeftS(): number;
  /** The server lost this match: it is local practice now. */
  lost(): boolean;
  /** My totals at the uploaded hours and the opponent's stored series, for the results chart. */
  mySeries(): ReadonlyArray<readonly [number, number]>;
  oppSeries(): readonly SeriesRow[];
  /** The other seat is a player on this account who still has to play (family hand-off). */
  familyNext(): { name: string; avatar: Avatar | null; profileId: string } | null;
  /** Ask the server for news now (results). */
  refresh(): void;
  giveUp(): Promise<'ok' | 'offline' | 'error'>;
  rematch(): Promise<'ok' | 'offline' | 'error'>;
  backToMenu(): Promise<void>;
  passTo(profileId: string): Promise<void>;
  /** Subscribe to state changes (DTO, opponent, end); returns the unsubscribe. */
  onChange(fn: () => void): () => void;
  dispose(): void;
}

export interface VersusControllerDeps {
  cloud: CloudHandle;
  events: EventBus;
  player: PlayerInfo;
  matchId: string;
  save(): void;
  switchSlot(t: BootIntent): Promise<void>;
  /** Test seams: the wall clock (Date.now) and the store for wh2:vs records (localStorage). */
  now?: () => number;
  storage?: KV;
}

/** Rules the sim plays from a match DTO. */
export function rulesOf(m: MatchDto): VersusRules {
  return { matchId: m.id, seed: m.seed, lengthMin: m.lengthMin, days: m.days, rulesVersion: m.rulesVersion, startMoney: m.startMoney, startMinute: m.startMinute ?? VERSUS_START_MINUTE };
}

/** Only these hourly snapshots go to the server (4 a zoo day); the last hour travels with the finish. */
export function shouldUpload(h: number, hoursTotal: number): boolean {
  return h > 0 && h % SNAPSHOT_EVERY_HOURS === 0 && h < hoursTotal;
}

/**
 * The opponent's total at my hour from their stored series: the row at the largest stored hour
 * ≤ myHour. Null when they have not got that far, or no stored row is that early.
 */
export function ghostAt(rows: readonly SeriesRow[], oppLastHour: number, myHour: number): number | null {
  if (oppLastHour < myHour || myHour <= 0) return null;
  let best: SeriesRow | null = null;
  for (const r of rows) if (r[0] <= myHour && (!best || r[0] > best[0])) best = r;
  return best ? best[1] : null;
}

/** Why a match DTO cannot be played on this device (null: it can). */
export function bootRefusal(m: MatchDto): VersusBootError | null {
  if (m.rulesVersion > VERSUS_RULES_VERSION) return new VersusBootError(BOOT_MSG.update, 'update');
  const me = m.players[m.mySeat];
  const done = !!me && (me.state === 'done' || me.doneAt !== null);
  if (m.status === 'cancelled' || m.status === 'expired' || m.status === 'finished' || done) return new VersusBootError(BOOT_MSG.ended, 'ended');
  if (me?.device && !me.device.here) return new VersusBootError(BOOT_MSG.elsewhere(me.device.name), 'other_device');
  return null;
}

function defaultStorage(): KV {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* blocked storage: fall through */
  }
  const mem = new Map<string, string>();
  return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
}

/** The final save for the finish call: gzip (deterministic), base64, sha256 of the gzip bytes. */
export function encodeFinalSave(sim: ISimulation): FinishBody['save'] {
  const gz = gzipString(JSON.stringify(sim.serialize()));
  return { encoding: 'gzip+base64', data: bytesToBase64(gz), sha256: sha256HexSync(gz) };
}

class Controller implements VersusController {
  readonly matchId: string;
  readonly slotKey: SlotKey;
  readonly player: PlayerInfo;
  private readonly pid: string;
  private readonly d: VersusControllerDeps;
  private readonly now: () => number;
  private readonly store: KV;
  private sim: ISimulation | null = null;
  private rec: VersusRecord | null = null;
  private booted = false;
  /** The clock waits for a "Go!" (from boot, and again after every break). */
  private hold = true;
  private countLeft = 0;
  private countFirst = false;
  private goLeft = 0;
  private saveAcc = 0;
  private saveDue = false;
  private flushAcc = 0;
  private pollAcc = 0;
  private seriesAcc = 0;
  private flushing = false;
  private polling = false;
  private lastAck: SnapshotsResponse | null = null;
  private series: SeriesRow[] = [];
  private seriesLast = -1;
  private seriesDone = false;
  private offs: (() => void)[] = [];
  private changeFns = new Set<() => void>();
  /** Debug wall-clock offset (__versusDebug.addWallMs). */
  private wallOffset = 0;
  private disposed = false;

  constructor(deps: VersusControllerDeps) {
    this.d = deps;
    this.matchId = deps.matchId;
    this.player = deps.player;
    this.pid = deps.player.profileId ?? deps.player.ref;
    this.slotKey = slotKey(deps.player.ref, vsSlot(deps.matchId));
    const now = deps.now ?? (() => Date.now());
    this.now = () => now() + this.wallOffset;
    this.store = deps.storage ?? defaultStorage();
    this.installDebug();
  }

  get holding(): boolean {
    return !this.booted || this.hold || this.countLeft > 0;
  }

  // ------------------------------------------------------------------ boot
  async boot(sim: ISimulation): Promise<void> {
    this.sim = sim;
    const stored = readRecord(this.store, this.pid, this.matchId);
    let lost = stored?.lost === true;
    let fresh: MatchDto | null = null;
    if (!lost) {
      try {
        fresh = await this.d.cloud.versus.get(this.matchId, this.pid);
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        if (code === 'other_device') throw new VersusBootError((e as Error).message || BOOT_MSG.elsewhere('another device'), 'other_device');
        if (code === 'upgrade_required') throw new VersusBootError(BOOT_MSG.update, 'update');
        // a match the server no longer knows (restored): keep playing it as local practice
        if (code === 'not_found' && stored) lost = true;
      }
    }
    const match = fresh ?? stored?.match ?? null;
    if (!match) throw new VersusBootError(BOOT_MSG.offline, 'offline');
    if (!lost) {
      const refusal = bootRefusal(match);
      // an ended seat still opens when this device holds the end that has not been sent yet
      if (refusal && !(refusal.reason === 'ended' && stored?.ended && !fresh)) throw refusal;
    }
    const rec: VersusRecord = stored ?? { v: 1, match, budget: newBudget(), ended: null, finishQueued: false, mine: [], parts: null, familyPid: null };
    rec.match = match;
    rec.lost = lost;
    rec.mine ??= [];
    // killed in the background: the gap still counts
    noteVisible(rec.budget, this.now());
    this.rec = rec;

    // the zoo: the local vs slot of this match, else the match's new zoo
    let loaded = false;
    const slot = this.d.cloud.local.read(this.slotKey);
    if (slot) {
      try {
        sim.load(JSON.parse(slot.json));
        loaded = sim.versus?.rules.matchId === this.matchId;
      } catch (err) {
        console.warn('[versus] the saved match zoo did not load; starting it again', err);
      }
    }
    if (!loaded) sim.newGame(match.seed, { startMinute: match.startMinute ?? VERSUS_START_MINUTE, versus: rulesOf(match) });

    const ev = this.d.events;
    this.offs.push(
      ev.on('versusHour', (e) => this.onHour(e.hour, e.snapshot)),
      ev.on('versusPoints', (e) => {
        if (e.part === 'lost' || e.part === 'babies') this.saveDue = true;
      }),
      ev.on('versusEnded', (e) => this.onEnded(e.reason)),
      this.d.cloud.versus.onAck((id, res) => {
        if (id === this.matchId) this.onAck(res);
      }),
    );
    this.persist();
    upsertIndex(this.store, this.pid, match, this.now());
    this.booted = true;

    const v = sim.versus;
    this.hold = !v?.ended;
    if (v && !v.ended && this.budgetLeftMs() <= 0) this.expire();
    else if (v?.ended && !rec.finishQueued && !rec.forfeitPending) this.onEnded(v.endReason ?? 'complete');
    if (rec.forfeitPending) void this.sendForfeit();
    if (!lost) {
      void this.fetchSeries();
      this.flushSoon();
    }
    this.changed();
  }

  startCountdown(): void {
    if (!this.booted || this.sim?.versus?.ended) {
      this.countLeft = 0;
      this.hold = false;
      return;
    }
    this.hold = true;
    this.countFirst = this.rec?.budget.firstGoAt === null;
    this.countLeft = COUNTDOWN_S;
    this.goLeft = 0;
    this.changed();
  }

  private go(): void {
    this.countLeft = 0;
    this.hold = false;
    this.goLeft = GO_FLASH_S;
    if (this.rec) {
      startBudget(this.rec.budget, this.now());
      this.persist();
    }
    this.changed();
  }

  frameDt(rawSeconds: number): number {
    if (this.holding) return 0;
    return Math.min(Math.max(0, Number.isFinite(rawSeconds) ? rawSeconds : 0), MAX_FRAME_S);
  }

  update(realDt: number): void {
    if (this.disposed || !this.booted || !this.rec || !(realDt >= 0)) return;
    if (this.countLeft > 0) {
      this.countLeft -= realDt;
      if (this.countLeft <= 0) this.go();
    } else if (this.goLeft > 0) this.goLeft = Math.max(0, this.goLeft - realDt);
    const v = this.sim?.versus;
    if (v && !v.ended) {
      addForeground(this.rec.budget, realDt * 1000);
      if (this.budgetLeftMs() <= 0) this.expire();
    }
    this.saveAcc += realDt;
    if (this.saveAcc >= SAVE_EVERY_S) this.saveDue = true;
    if (this.rec.lost) return;
    this.flushAcc += realDt;
    if (this.flushAcc >= FLUSH_EVERY_S) {
      this.flushAcc = 0;
      this.flushSoon();
    }
    this.pollAcc += realDt;
    if (this.pollAcc >= POLL_EVERY_S) {
      this.pollAcc = 0;
      if (this.rec.forfeitPending) void this.sendForfeit();
      // opponent progress rides on every snapshot answer; with nothing to send, ask
      else if (this.outbox().pending === 0) void this.poll();
    }
    this.seriesAcc += realDt;
    if (this.seriesAcc >= SERIES_EVERY_S) {
      this.seriesAcc = 0;
      void this.fetchSeries();
    }
  }

  wantsSave(): boolean {
    if (!this.saveDue) return false;
    this.saveDue = false;
    this.saveAcc = 0;
    this.persist();
    return true;
  }

  onHidden(keepaliveBudgetBytes: number): number {
    if (!this.rec) return 0;
    noteHidden(this.rec.budget, this.now());
    this.persist();
    if (this.rec.lost || !this.booted) return 0;
    try {
      return this.d.cloud.versus.flushKeepalive(this.matchId, Math.max(0, keepaliveBudgetBytes));
    } catch (err) {
      console.warn('[versus] keepalive flush failed', err);
      return 0;
    }
  }

  onVisible(): void {
    if (!this.rec) return;
    noteVisible(this.rec.budget, this.now());
    this.persist();
    const v = this.sim?.versus;
    if (!this.booted || !v) return;
    if (!v.ended && this.budgetLeftMs() <= 0) this.expire();
    else if (!v.ended) this.startCountdown();
    if (!this.rec.lost) {
      this.flushSoon();
      void this.poll();
    }
  }

  budgetLeftMs(): number {
    const m = this.rec?.match;
    if (!this.rec || !m) return 0;
    return budgetLeft(this.rec.budget, m.budgetMin * 60_000, this.now());
  }

  timeLeftS(): number {
    const v = this.sim?.versus;
    if (!v || v.ended) return 0;
    return Math.max(0, Math.min(v.realSecondsLeft(), this.budgetLeftMs() / 1000));
  }

  opponent(): OpponentView | null {
    const m = this.rec?.match;
    if (!m) return null;
    const other = m.players.find((p) => p.seat !== m.mySeat);
    if (!other || other.state === 'invited') return null;
    const o: OpponentView = {
      name: other.name,
      avatar: other.avatar,
      lastHour: other.lastHour,
      total: other.total,
      atMyHour: null,
      parts: other.parts,
      live: other.live,
      done: other.state === 'done' || other.doneAt !== null,
    };
    const ack = this.lastAck?.opponent;
    if (ack && ack.lastHour >= o.lastHour) {
      o.lastHour = ack.lastHour;
      o.total = ack.total;
      o.parts = ack.parts ?? o.parts;
      o.live = ack.live;
      o.done = o.done || ack.done;
      o.atMyHour = ack.atMyHour;
    }
    const myHour = this.sim?.versus?.hour ?? 0;
    const g = ghostAt(this.series, Math.max(o.lastHour, this.seriesLast), myHour);
    if (g !== null) o.atMyHour = g;
    else if (o.lastHour < myHour) o.atMyHour = null;
    return o;
  }

  outbox(): OutboxState {
    try {
      return this.d.cloud.versus.outboxState(this.matchId);
    } catch {
      return { pending: 0, lastAck: null, dead: null, finishSent: false, finishMatch: null };
    }
  }

  match(): MatchDto | null {
    return this.rec?.match ?? null;
  }

  view(): VersusView | null {
    return this.sim?.versus ?? null;
  }

  countdown(): CountdownView | null {
    if (this.countLeft > 0) return { left: this.countLeft, first: this.countFirst, go: false };
    if (this.goLeft > 0) return { left: 0, first: this.countFirst, go: true };
    return null;
  }

  lost(): boolean {
    return this.rec?.lost === true;
  }

  mySeries(): ReadonlyArray<readonly [number, number]> {
    return this.rec?.mine ?? [];
  }

  oppSeries(): readonly SeriesRow[] {
    return this.series;
  }

  familyNext(): { name: string; avatar: Avatar | null; profileId: string } | null {
    const m = this.rec?.match;
    if (!m) return null;
    const other = m.players.find((p) => p.seat !== m.mySeat);
    if (!other || other.state === 'done' || other.doneAt !== null) return null;
    let pid = this.rec?.familyPid ?? null;
    if (!pid) {
      try {
        pid = this.d.cloud.profiles.list().find((p) => p.id !== this.pid && p.name === other.name)?.id ?? null;
      } catch {
        pid = null;
      }
    }
    return pid ? { name: other.name, avatar: other.avatar, profileId: pid } : null;
  }

  refresh(): void {
    if (this.rec?.lost) return;
    this.flushSoon();
    void this.poll();
    void this.fetchSeries();
  }

  async giveUp(): Promise<'ok' | 'offline' | 'error'> {
    try {
      const m = await this.d.cloud.versus.forfeit(this.matchId, this.pid);
      if (this.rec) {
        this.rec.match = m;
        this.persist();
      }
      upsertIndex(this.store, this.pid, m, this.now());
      await this.d.switchSlot({ kind: 'menu', player: this.player.ref });
      return 'ok';
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      return code === 'network' || code === 'timeout' ? 'offline' : 'error';
    }
  }

  async rematch(): Promise<'ok' | 'offline' | 'error'> {
    try {
      const m = await this.d.cloud.versus.rematch(this.matchId, this.pid);
      upsertIndex(this.store, this.pid, m, this.now());
      await this.d.switchSlot({ kind: 'versus', player: this.player.ref, slot: vsSlot(m.id), matchId: m.id });
      return 'ok';
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      return code === 'network' || code === 'timeout' ? 'offline' : 'error';
    }
  }

  backToMenu(): Promise<void> {
    return this.d.switchSlot({ kind: 'menu', player: this.player.ref });
  }

  passTo(profileId: string): Promise<void> {
    return this.d.switchSlot({ kind: 'versus', player: profileId, slot: vsSlot(this.matchId), matchId: this.matchId });
  }

  onChange(fn: () => void): () => void {
    this.changeFns.add(fn);
    return () => void this.changeFns.delete(fn);
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.changeFns.clear();
  }

  // ------------------------------------------------------------------ internals
  private changed(): void {
    for (const fn of [...this.changeFns]) {
      try {
        fn();
      } catch (err) {
        console.error('[versus] change handler failed', err);
      }
    }
  }

  private persist(): void {
    if (this.rec && !writeRecord(this.store, this.pid, this.rec)) console.warn('[versus] could not store the match record');
  }

  private onHour(h: number, snap: VersusSnapshot): void {
    const rec = this.rec;
    const v = this.sim?.versus;
    if (!rec || !v) return;
    if (h % SNAPSHOT_EVERY_HOURS === 0 || h === v.hoursTotal) {
      rec.mine = [...(rec.mine ?? []).filter((x) => x[0] !== h), [h, snap.total]];
      rec.parts = snap.parts;
    }
    if (rec.lost || !shouldUpload(h, v.hoursTotal)) return;
    this.d.cloud.versus.enqueueSnapshots(this.matchId, this.pid, [snap]);
  }

  /** The budget ran out: freeze at the last completed hour (the versusEnded handler does the rest). */
  private expire(): void {
    const v = this.sim?.versus;
    if (v && !v.ended) v.endNow('budget');
  }

  private onEnded(reason: 'complete' | 'budget'): void {
    const rec = this.rec;
    const sim = this.sim;
    const v = sim?.versus;
    if (!rec || !sim || !v) return;
    rec.ended = reason;
    rec.parts = v.parts();
    this.countLeft = 0;
    this.hold = false;
    this.saveDue = true;
    const final = v.lastSnapshot();
    if (!rec.lost) {
      if (!final) {
        // no hour completed: nothing to compare, the seat gives up instead
        rec.forfeitPending = true;
        void this.sendForfeit();
      } else if (!rec.finishQueued) {
        try {
          const body: FinishBody = { profileId: this.pid, final, endReason: reason, save: encodeFinalSave(sim) };
          this.d.cloud.versus.enqueueFinish(this.matchId, this.pid, body);
          rec.finishQueued = true;
        } catch (err) {
          console.error('[versus] could not queue the final score', err);
        }
      }
    }
    this.persist();
    try {
      this.d.save();
    } catch (err) {
      console.warn('[versus] save at the end failed', err);
    }
    if (!rec.lost) this.flushSoon();
    this.changed();
  }

  private async sendForfeit(): Promise<void> {
    const rec = this.rec;
    if (!rec || rec.lost) return;
    try {
      const m = await this.d.cloud.versus.forfeit(this.matchId, this.pid);
      rec.match = m;
      rec.forfeitPending = false;
      this.persist();
      upsertIndex(this.store, this.pid, m, this.now());
      this.changed();
    } catch {
      /* offline: tried again on the next poll */
    }
  }

  private onAck(res: SnapshotsResponse | MatchDto): void {
    const rec = this.rec;
    if (!rec) return;
    if ('ackHour' in res) this.lastAck = res;
    else {
      rec.match = res;
      this.persist();
      upsertIndex(this.store, this.pid, res, this.now());
    }
    this.changed();
  }

  private flushSoon(): void {
    if (this.flushing || this.disposed || this.rec?.lost) return;
    this.flushing = true;
    this.d.cloud.versus
      .flush(this.matchId)
      .catch(() => 'offline')
      .finally(() => {
        this.flushing = false;
      });
  }

  private async poll(): Promise<void> {
    if (this.polling || this.disposed || this.rec?.lost) return;
    this.polling = true;
    try {
      const m = await this.d.cloud.versus.get(this.matchId, this.pid);
      if (this.rec) {
        this.rec.match = m;
        this.persist();
      }
      upsertIndex(this.store, this.pid, m, this.now());
      this.changed();
    } catch {
      /* offline or not ready: the next poll tries again */
    } finally {
      this.polling = false;
    }
  }

  private async fetchSeries(): Promise<void> {
    const m = this.rec?.match;
    if (!m || this.rec?.lost || this.seriesDone || !m.players.some((p) => p.seat !== m.mySeat && p.state !== 'invited')) return;
    try {
      const res = await this.d.cloud.versus.series(this.matchId, this.pid, this.seriesLast >= 0 ? this.seriesLast : undefined);
      const byH = new Map(this.series.map((r) => [r[0], r] as const));
      for (const r of res.series) byH.set(r[0], r);
      this.series = [...byH.values()].sort((a, b) => a[0] - b[0]);
      this.seriesLast = Math.max(this.seriesLast, res.lastHour, ...this.series.map((r) => r[0]));
      this.seriesDone = res.done;
      this.changed();
    } catch {
      /* no opponent yet, or offline */
    }
  }

  private installDebug(): void {
    // (import.meta.env.DEV is false in a production build, so all of this is dropped there)
    if (!import.meta.env.DEV || typeof window === 'undefined') return;
    (window as unknown as { __versusDebug?: unknown }).__versusDebug = {
      /** Run the match clock n match hours ahead (sim.update in 1 sim-s pieces). */
      skipHours: (n: number) => {
        const sim = this.sim;
        const v = sim?.versus;
        if (!sim || !v || v.ended) return v?.hour ?? 0;
        const target = Math.min(v.hoursTotal, v.hour + Math.max(0, Math.floor(n)));
        for (let guard = 0; v.hour < target && !v.ended && guard < (target - v.hour + 1) * 40; guard++) sim.update(MAX_FRAME_S);
        return v.hour;
      },
      /** Pretend this much wall time has passed (the real-time budget). */
      addWallMs: (ms: number) => {
        this.wallOffset += Number(ms) || 0;
        return this.budgetLeftMs();
      },
      state: () => ({
        matchId: this.matchId,
        hour: this.sim?.versus?.hour ?? 0,
        total: this.sim?.versus?.total() ?? 0,
        ended: this.sim?.versus?.ended ?? false,
        endReason: this.sim?.versus?.endReason ?? null,
        holding: this.holding,
        countdown: this.countdown(),
        budgetLeftMs: this.budgetLeftMs(),
        timeLeftS: this.timeLeftS(),
        outbox: this.outbox(),
        opponent: this.opponent(),
        status: this.rec?.match.status ?? null,
        result: this.rec?.match.result ?? null,
        lost: this.lost(),
      }),
    };
  }
}

export function createVersusController(deps: VersusControllerDeps): VersusController {
  return new Controller(deps);
}
