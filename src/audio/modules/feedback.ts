// Feedback that is not an animal: transactions where guests pay (turnstile,
// card reader, donation box, coins), notification notes (escape bell, births,
// sickness, debt, the day ledger, the gate chime), the crate when a bought
// animal is placed and the pause "time freeze". It owns the coin sound, so the
// engine's built-in coin path is off.

import { ENTRANCE_TILE, TILE } from '../../core/constants';
import type { GameEvents, MoneyKind, NotifySound } from '../../core/events';
import { Rng } from '../../core/rng';
import type { AudioHost, AudioModule, AudioModuleFactory, PlaySpec, VoiceHandle } from '../host';

/** Transaction tuning. */
export const TX = {
  /** No transaction sounds with the camera further than this from its focus (m)… */
  maxCamDist: 45,
  /** …or from further than this from the ear (m). */
  maxDist: 18,
  /** Popups of one kind within this distance (m) and window (s) become one transaction. */
  groupDist: 25,
  window: 0.6,
  /** Per-kind token bucket: refill per second and cap. */
  refill: 0.25,
  cap: 1,
  /** Gap after any transaction sound: max(minGap, Exp(meanGap)) s. */
  minGap: 0.35,
  meanGap: 0.9,
  /** Habituation: gain × 1/(1 + per · sounds in the last `span` s), floored. */
  habitPer: 0.2,
  habitSpan: 10,
  habitFloor: 0.4,
  /** Hard cap: at most this many sounds per `habitSpan` (the ≤ 0.75/s budget, whatever the mix of kinds). */
  maxRecent: 7,
  gain: 0.85,
} as const;

const KIND_SOUND: Readonly<Record<Exclude<MoneyKind, 'other'>, string>> = {
  admissions: 'cue.turnstile',
  shopIncome: 'cue.beep',
  donations: 'cue.coindrop',
};
/** Where the coins land after the kind's own sound (s). */
const KIND_COIN_DELAY: Readonly<Record<MoneyKind, number>> = { admissions: 0.14, shopIncome: 0.2, donations: 0.16, other: 0 };
export const COIN_IDS = ['cue.coin#0', 'cue.coin#1', 'cue.coin#2', 'cue.coin#3'] as const;
/** coin#3 is the two-coin clink; 0..2 are single coins. */
const CLINK = 3;
/** Bout ids for layered transaction sounds (far from the fauna module's ids). */
const GROUP_BASE = 0x40000000;

/** Notification sounds: priority (bad 3 > warn 2 > good 1 > info 0) and the cue. */
const NOTIFY: Readonly<Record<NotifySound, { prio: number; cue: string }>> = {
  escape: { prio: 3, cue: 'cue.note.bad' },
  death: { prio: 3, cue: 'cue.note.bad' },
  debt: { prio: 3, cue: 'cue.note.bad' },
  sick: { prio: 2, cue: 'cue.note.warn' },
  birth: { prio: 1, cue: 'cue.note.good' },
  contain: { prio: 1, cue: 'cue.note.good' },
  healed: { prio: 1, cue: 'cue.note.good' },
  hire: { prio: 1, cue: 'cue.note.good' },
  day: { prio: 0, cue: 'cue.ledger' },
  gate: { prio: 0, cue: 'cue.gate' },
  sold: { prio: 0, cue: 'cue.cash' },
};
/** At most one notification cue per NOTE_GAP s, unless the new one ranks higher. */
export const NOTE_GAP = 1.5;
/** The same notification sound again within this many s is skipped (escapes excepted). */
export const SAME_SOUND_GAP = 30;
/** Escape bell repeat interval while any animal is out (s). */
export const BELL_REPEAT: readonly [number, number] = [20, 30];
const CRATE_GAP = 1.5;
/** The gate chime hangs on the entrance arch. */
const GATE_AT = { x: (ENTRANCE_TILE.x + 0.5) * TILE, y: 3, z: (ENTRANCE_TILE.z + 0.5) * TILE };
/** Pause: world + ambience low-passed and 6 dB down. */
export const PAUSE_FILTER = { cutHz: 1800, gainDb: -6, tc: 0.08 };
export const RESUME_FILTER = { cutHz: 20000, gainDb: 0, tc: 0.13 };

/** Every cue this module plays (pre-rendered after the UI cues and beds). */
const FEEDBACK_CUES: readonly string[] = [
  ...Object.values(KIND_SOUND),
  ...COIN_IDS,
  'cue.note.good',
  'cue.note.warn',
  'cue.note.bad',
  'cue.bell',
  'cue.cash',
  'cue.crate',
  'cue.pause',
  'cue.resume',
  'cue.ledger',
  'cue.gate',
];

interface Pending {
  kind: MoneyKind;
  x: number;
  z: number;
  amount: number;
  end: number;
}

const dbGain = (db: number) => Math.pow(10, db / 20);

class Feedback implements AudioModule {
  readonly ownsCoins = true;
  private readonly rng = new Rng(0xfeedbac);
  private readonly unsub: (() => void)[];
  // transactions
  private readonly pending: Pending[] = [];
  private readonly bucket: Record<MoneyKind, { tokens: number; t: number }> = {
    admissions: { tokens: TX.cap, t: 0 },
    shopIncome: { tokens: TX.cap, t: 0 },
    donations: { tokens: TX.cap, t: 0 },
    other: { tokens: TX.cap, t: 0 },
  };
  private nextTx = 0;
  /** Times of recent transaction sounds (habituation). */
  private readonly recent: number[] = [];
  private lastCoin = -1;
  private groupSeq = 0;
  private txPlayed = 0;
  private txDropped = 0;
  // notifications
  private noteT = -Infinity;
  private notePrio = -1;
  private noteHandle: VoiceHandle | null = null;
  private readonly lastSound = new Map<NotifySound, number>();
  private notesPlayed = 0;
  private escapeNext = Infinity;
  private pollT = 0;
  // placement and pause
  private crateT = -Infinity;
  private paused: boolean | null = null;

  constructor(private readonly host: AudioHost) {
    const ev = host.events;
    this.unsub = [
      ev.on('moneyPopup', (m) => this.onMoney(m)),
      ev.on('notify', (n) => this.onNotify(n)),
      ev.on('animalPlaced', (p) => this.onPlaced(p)),
    ];
  }

  warm(): readonly string[] {
    return FEEDBACK_CUES;
  }

  update(dt: number): void {
    this.updatePause();
    if (this.pending.length) this.settle();
    this.pollT -= dt;
    if (this.pollT <= 0) {
      this.pollT = 1;
      this.pollEscapes();
    }
  }

  debug(): Record<string, unknown> {
    return {
      txPlayed: this.txPlayed,
      txDropped: this.txDropped,
      txPending: this.pending.length,
      notes: this.notesPlayed,
      paused: !!this.paused,
      bellIn: Number.isFinite(this.escapeNext) ? +(this.escapeNext - this.host.time).toFixed(1) : -1,
    };
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub.length = 0;
  }

  // ------------------------------------------------------------ transactions

  private onMoney(m: GameEvents['moneyPopup']): void {
    const h = this.host;
    if (!h.active || m.amount <= 0) return;
    // a far camera hears the zoo, not one till
    if (h.listener.camDist >= TX.maxCamDist || h.attenuate(m.x, 1, m.z).dist > TX.maxDist) return;
    const kind = m.kind ?? 'other';
    const r2 = TX.groupDist * TX.groupDist;
    for (const p of this.pending) {
      if (p.kind !== kind || (p.x - m.x) ** 2 + (p.z - m.z) ** 2 > r2) continue;
      p.amount += m.amount;
      p.x = m.x;
      p.z = m.z;
      return;
    }
    this.pending.push({ kind, x: m.x, z: m.z, amount: m.amount, end: h.time + TX.window });
  }

  /** Close the windows that are due: a sound if the kind's bucket and the global gap allow it. */
  private settle(): void {
    const t = this.host.time;
    let i = 0;
    while (i < this.pending.length) {
      const p = this.pending[i];
      if (p.end > t) {
        i++;
        continue;
      }
      this.pending.splice(i, 1);
      const b = this.bucket[p.kind];
      b.tokens = Math.min(TX.cap, b.tokens + (t - b.t) * TX.refill);
      b.t = t;
      while (this.recent.length && this.recent[0] < t - TX.habitSpan) this.recent.shift();
      if (b.tokens < 1 || t < this.nextTx || this.recent.length >= TX.maxRecent || !this.playTransaction(p)) {
        this.txDropped++;
        continue;
      }
      this.txPlayed++;
      // a random token cost keeps a saturated stream from ticking at the bucket's period
      b.tokens -= this.rng.range(0.5, 1.5);
      this.nextTx = t + Math.max(TX.minGap, -TX.meanGap * Math.log(1 - this.rng.float()));
      this.recent.push(t);
    }
  }

  private playTransaction(p: Pending): boolean {
    const h = this.host;
    const habit = Math.max(TX.habitFloor, 1 / (1 + TX.habitPer * this.recent.length));
    const gain = TX.gain * habit * dbGain(this.rng.range(-3, 3));
    const at = { x: p.x, y: 1, z: p.z };
    const group = GROUP_BASE + (this.groupSeq = (this.groupSeq + 1) & 0xffff);
    const base: Omit<PlaySpec, 'id'> = { pool: 'fx', at, gain, refDist: 5, radius: 25, group };
    const now = h.now();
    const first = p.kind === 'other' ? this.coin() : KIND_SOUND[p.kind];
    if (!h.play({ ...base, id: first, rate: 1 + this.rng.range(-0.03, 0.03), when: now })) return false;
    // the amount sets the size: a two-coin clink from $10, a short cascade from $40
    const coins = p.amount >= 40 ? this.rng.int(2, 3) : p.amount >= 10 ? 1 : 0;
    let when = now + KIND_COIN_DELAY[p.kind];
    for (let i = 0; i < coins; i++) {
      when += i || p.kind === 'other' ? this.rng.range(0.06, 0.09) : 0;
      const id = coins === 1 ? this.coin(CLINK) : this.coin();
      h.play({ ...base, id, gain: gain * 0.8, rate: 1 + this.rng.range(-0.04, 0.04), when });
    }
    return true;
  }

  /** A coin variant (preferring `want`), never the one played last. */
  private coin(want?: number): string {
    let k = want ?? this.rng.int(0, 2);
    if (k === this.lastCoin) k = (k + 1 + this.rng.int(0, 1)) % 3;
    this.lastCoin = k;
    return COIN_IDS[k];
  }

  // ------------------------------------------------------------ notifications

  private onNotify(n: GameEvents['notify']): void {
    const h = this.host;
    if (n.logOnly || !n.sound || !h.active) return;
    const s = NOTIFY[n.sound];
    const t = h.time;
    if (n.sound !== 'escape' && t - (this.lastSound.get(n.sound) ?? -Infinity) < SAME_SOUND_GAP) return;
    if (t - this.noteT < NOTE_GAP && s.prio <= this.notePrio) return;
    let played: VoiceHandle | null = null;
    if (n.sound === 'escape') {
      if (n.focus) this.bell({ at: { x: n.focus.x, y: 2, z: n.focus.z } });
      this.escapeNext = t + this.rng.range(BELL_REPEAT[0], BELL_REPEAT[1]);
    }
    if (n.sound === 'gate') played = h.play({ id: s.cue, pool: 'fx', at: GATE_AT, gain: 1, refDist: 15, radius: 120 });
    else {
      // a more urgent note replaces the one still sounding
      if (this.noteHandle && this.noteHandle.endAt > h.now()) this.noteHandle.stop(0.04);
      played = h.play({ id: s.cue, pool: 'ui' });
      this.noteHandle = played;
    }
    if (!played && n.sound !== 'escape') return;
    this.notesPlayed++;
    this.lastSound.set(n.sound, t);
    this.noteT = t;
    this.notePrio = s.prio;
  }

  private bell(where: { at: PlaySpec['at'] } | { track: number }): VoiceHandle | null {
    return this.host.play({ id: 'cue.bell', pool: 'fx', gain: 0.85, refDist: 20, radius: 150, ...where });
  }

  /** 1 Hz: ring the bell at the nearest escaped animal every 20–30 s while any is out. */
  private pollEscapes(): void {
    const h = this.host;
    const e = h.listener;
    let best = -1;
    let bestD = Infinity;
    for (const a of h.sim.animals.values()) {
      if (!a.escaped) continue;
      const d = (a.x - e.x) ** 2 + (a.z - e.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = a.id;
      }
    }
    if (best < 0) {
      this.escapeNext = Infinity;
      return;
    }
    const t = h.time;
    // out already (a loaded game): the first bell comes one interval from now
    if (!Number.isFinite(this.escapeNext)) this.escapeNext = t + this.rng.range(BELL_REPEAT[0], BELL_REPEAT[1]);
    if (t < this.escapeNext) return;
    this.bell({ track: best });
    this.escapeNext = t + this.rng.range(BELL_REPEAT[0], BELL_REPEAT[1]);
  }

  // ------------------------------------------------------------ placement and pause

  private onPlaced(p: GameEvents['animalPlaced']): void {
    const h = this.host;
    if (!h.active || h.time - this.crateT < CRATE_GAP) return;
    if (h.play({ id: 'cue.crate', pool: 'fx', at: { x: p.x, y: 1, z: p.z }, gain: 1, refDist: 8, radius: 60 })) this.crateT = h.time;
  }

  /** Speed 0 muffles the world ("time freeze"); unpausing opens it again. */
  private updatePause(): void {
    const h = this.host;
    const paused = h.sim.speed === 0;
    if (paused === this.paused) return;
    const first = this.paused === null;
    this.paused = paused;
    if (first && !paused) return;
    const f = paused ? PAUSE_FILTER : RESUME_FILTER;
    h.setWorldFilter(f.cutHz, f.gainDb, f.tc);
    if (!first) h.play({ id: paused ? 'cue.pause' : 'cue.resume', pool: 'ui' });
  }
}

const createFeedback: AudioModuleFactory = (host) => new Feedback(host);
export default createFeedback;
