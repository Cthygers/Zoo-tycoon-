// Versus controller (spec §5.6, §7.4, §8.7, V1) against a fake VersusApi, LocalStore and clock:
// boot order, the countdown hold, frameDt, the real-time budget (max of wall and accumulated
// time, clock changes) and its expiry, the h % 6 upload filter, the end flows and a dead outbox.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinishBody, MatchDto, SaveMeta, SeatDto, SnapshotsResponse, VersusSnapshot } from '../shared/api-types';
import { TEST_LENGTH } from '../shared/versus-rules';
import type { CloudHandle, FlushResult, LocalSlot, OutboxState, VersusApi } from '../src/core/cloud-types';
import type { BootIntent, PlayerInfo, SlotKey } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { KEYS } from '../src/core/storage-keys';
import { createSimulation } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';
import { addForeground, budgetElapsed, newBudget, noteHidden, noteVisible, startBudget } from '../src/versus/budget';
import { COUNTDOWN_S, VersusBootError, createVersusController, ghostAt, shouldUpload, type VersusController } from '../src/versus/controller';
import { readIndex, readRecord } from '../src/versus/record';
import { createSoakRecorder, percentile } from '../src/versus/soak';

const PID = 'p-ana';
const MATCH = 'm-1';
const T0 = Date.UTC(2026, 10, 26, 9, 0, 0);

function seat(seatNo: 0 | 1, isMe: boolean, extra: Partial<SeatDto> = {}): SeatDto {
  return {
    seat: seatNo, role: seatNo === 0 ? 'challenger' : 'opponent', name: isMe ? 'Ana' : 'Mia', avatar: { animal: isMe ? 'lion' : 'zebra', color: isMe ? 1 : 4 },
    isMe, state: 'joined', lastHour: 0, total: 0, parts: null, live: false, doneAt: null, endHour: null, endReason: null,
    device: isMe ? null : null, ...extra,
  };
}

function matchDto(extra: Partial<MatchDto> = {}): MatchDto {
  return {
    id: MATCH, kind: 'coded', code: null, lengthMin: 4, days: TEST_LENGTH.days, seed: 777, rulesVersion: 1, startMoney: TEST_LENGTH.startMoney,
    startMinute: 510, budgetMin: TEST_LENGTH.budgetMin, status: 'active', createdAt: T0 - 60_000, codeExpiresAt: null, joinedAt: T0 - 30_000,
    finishBy: T0 + 72 * 3600_000, mySeat: 0, players: [seat(0, true), seat(1, false)], result: null, ...extra,
  };
}

class Mem {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const offline = () => Object.assign(new Error('offline'), { code: 'network' });

class FakeVersus implements VersusApi {
  available = true;
  online = true;
  match = matchDto();
  getError: unknown = null;
  snaps: VersusSnapshot[] = [];
  finishes: FinishBody[] = [];
  forfeits = 0;
  flushes = 0;
  keepalives: number[] = [];
  dead: OutboxState['dead'] = null;
  private ackFns = new Set<(id: string, res: SnapshotsResponse | MatchDto) => void>();
  config() {
    return null;
  }
  async create(): Promise<MatchDto> {
    throw offline();
  }
  async preview(): Promise<never> {
    throw offline();
  }
  async join(): Promise<MatchDto> {
    throw offline();
  }
  async get(): Promise<MatchDto> {
    if (this.getError) throw this.getError;
    if (!this.online) throw offline();
    return structuredClone(this.match);
  }
  async list(): Promise<MatchDto[]> {
    return [structuredClone(this.match)];
  }
  async series() {
    return { lastHour: 0, done: false, series: [], serverTime: Date.now() };
  }
  async forfeit(): Promise<MatchDto> {
    if (!this.online) throw offline();
    this.forfeits++;
    const m = structuredClone(this.match);
    m.players[m.mySeat] = { ...m.players[m.mySeat], state: 'done', endReason: 'forfeit', doneAt: T0 };
    return m;
  }
  async cancel(): Promise<MatchDto> {
    throw offline();
  }
  async rematch(): Promise<MatchDto> {
    throw offline();
  }
  enqueueSnapshots(_id: string, _pid: string, snaps: VersusSnapshot[]): void {
    this.snaps.push(...snaps);
  }
  enqueueFinish(_id: string, _pid: string, body: FinishBody): void {
    this.finishes.push(body);
  }
  async flush(): Promise<FlushResult> {
    this.flushes++;
    return this.online ? 'empty' : 'offline';
  }
  flushKeepalive(_id: string, maxBytes: number): number {
    this.keepalives.push(maxBytes);
    return 0;
  }
  outboxState(): OutboxState {
    return { pending: 0, lastAck: null, dead: this.dead, finishSent: false, finishMatch: null };
  }
  onAck(fn: (id: string, res: SnapshotsResponse | MatchDto) => void) {
    this.ackFns.add(fn);
    return () => void this.ackFns.delete(fn);
  }
  ack(res: SnapshotsResponse | MatchDto) {
    for (const fn of this.ackFns) fn(MATCH, res);
  }
}

class FakeLocal {
  slots = new Map<string, LocalSlot>();
  read(key: SlotKey) {
    return this.slots.get(key) ?? null;
  }
  write(key: SlotKey, json: string, meta: SaveMeta) {
    this.slots.set(key, { json, meta, savedAt: 0 });
    return 'saved' as const;
  }
  has(key: SlotKey) {
    return this.slots.has(key);
  }
}

interface Rig {
  ctrl: VersusController;
  sim: Simulation;
  events: EventBus;
  versus: FakeVersus;
  local: FakeLocal;
  store: Mem;
  clock: { now: number };
  switched: BootIntent[];
  saves: number;
}

const player: PlayerInfo = { ref: PID, profileId: PID, accountId: 'acc-1', name: 'Ana', avatar: { animal: 'lion', color: 1 } };

function rig(o: { versus?: FakeVersus; local?: FakeLocal; store?: Mem; clock?: { now: number } } = {}): Rig {
  const versus = o.versus ?? new FakeVersus();
  const local = o.local ?? new FakeLocal();
  const store = o.store ?? new Mem();
  const clock = o.clock ?? { now: T0 };
  const events = new EventBus();
  const sim = createSimulation(events, 11) as Simulation;
  const switched: BootIntent[] = [];
  const r: Rig = { ctrl: null as unknown as VersusController, sim, events, versus, local, store, clock, switched, saves: 0 };
  const cloud = { enabled: true, versus, local, profiles: { list: () => [] } } as unknown as CloudHandle;
  r.ctrl = createVersusController({
    cloud, events, player, matchId: MATCH, now: () => clock.now, storage: store,
    save: () => {
      r.saves++;
      local.write(r.ctrl.slotKey, JSON.stringify(sim.serialize()), {} as SaveMeta);
    },
    switchSlot: async (t) => void switched.push(t),
  });
  return r;
}

/** One frame as main.ts runs it: raw seconds of wall time pass. */
function frame(r: Rig, raw: number) {
  r.clock.now += raw * 1000;
  r.sim.update(r.ctrl.frameDt(raw));
  r.ctrl.update(raw);
}

async function bootAndGo(r: Rig) {
  await r.ctrl.boot(r.sim);
  r.ctrl.startCountdown();
  for (let i = 0; i < 13; i++) frame(r, 0.25);
  expect(r.ctrl.holding).toBe(false);
}

function playHours(r: Rig, hours: number) {
  const v = r.sim.versus!;
  const target = v.hour + hours;
  while (v.hour < target && !v.ended) frame(r, 0.25);
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('boot', () => {
  it('starts the match zoo from the DTO, holds until the countdown says Go, and stores the record', async () => {
    const r = rig();
    expect(r.ctrl.slotKey).toBe(`${PID}/vs-${MATCH}`);
    expect(r.ctrl.holding).toBe(true);
    await r.ctrl.boot(r.sim);
    const v = r.sim.versus!;
    expect(v.rules).toMatchObject({ matchId: MATCH, seed: 777, days: 2, startMoney: 100_000 });
    expect(r.sim.speed).toBe(3);
    expect(r.ctrl.holding).toBe(true);
    r.ctrl.startCountdown();
    expect(r.ctrl.countdown()).toMatchObject({ first: true, go: false });
    frame(r, 1);
    frame(r, 1);
    expect(r.ctrl.holding).toBe(true);
    expect(r.sim.time).toBe(0);
    frame(r, 1.01);
    expect(r.ctrl.holding).toBe(false);
    expect(r.ctrl.countdown()?.go).toBe(true);
    const rec = readRecord(r.store, PID, MATCH)!;
    expect(rec.match.id).toBe(MATCH);
    expect(rec.budget.firstGoAt).toBe(r.clock.now);
    expect(readIndex(r.store, PID).matches.map((m) => m.id)).toEqual([MATCH]);
  });

  it('offline with no cached match → "Connect to the internet to start this match."', async () => {
    const versus = new FakeVersus();
    versus.online = false;
    const r = rig({ versus });
    await expect(r.ctrl.boot(r.sim)).rejects.toThrow(VersusBootError);
    await expect(rig({ versus }).ctrl.boot(r.sim)).rejects.toThrow('Connect to the internet to start this match.');
  });

  it('offline with a cached match plays it, and continues the local vs slot', async () => {
    const store = new Mem();
    const local = new FakeLocal();
    const first = rig({ store, local });
    await bootAndGo(first);
    playHours(first, 7);
    first.ctrl.wantsSave();
    local.write(first.ctrl.slotKey, JSON.stringify(first.sim.serialize()), {} as SaveMeta);
    const versus = new FakeVersus();
    versus.online = false;
    const again = rig({ store, local, versus, clock: first.clock });
    await again.ctrl.boot(again.sim);
    expect(again.sim.versus!.hour).toBe(7);
    expect(again.sim.versus!.rules.matchId).toBe(MATCH);
  });

  it('refuses ended matches and seats bound to another device', async () => {
    for (const [m, text] of [
      [matchDto({ status: 'cancelled' }), 'This match has ended.'],
      [matchDto({ status: 'finished' }), 'This match has ended.'],
      [matchDto({ players: [seat(0, true, { state: 'done', doneAt: T0 }), seat(1, false)] }), 'This match has ended.'],
      [matchDto({ players: [seat(0, true, { device: { name: 'Tablet', here: false } }), seat(1, false)] }), 'This match is being played on Tablet.'],
      [matchDto({ rulesVersion: 99 }), 'Update Wildhaven Zoo to play this match.'],
    ] as const) {
      const versus = new FakeVersus();
      versus.match = m;
      const r = rig({ versus });
      await expect(r.ctrl.boot(r.sim)).rejects.toThrow(text);
    }
  });

  it('a match the server lost is kept as local practice: nothing is uploaded', async () => {
    const store = new Mem();
    const first = rig({ store });
    await bootAndGo(first);
    const versus = new FakeVersus();
    versus.getError = Object.assign(new Error('lost'), { code: 'not_found' });
    const r = rig({ store, versus, clock: first.clock });
    await bootAndGo(r);
    expect(r.ctrl.lost()).toBe(true);
    playHours(r, 12);
    expect(versus.snaps).toHaveLength(0);
  });
});

describe('frames and the countdown', () => {
  it('frameDt is 0 while holding and ≤ 0.25 otherwise', async () => {
    const r = rig();
    expect(r.ctrl.frameDt(0.016)).toBe(0);
    await r.ctrl.boot(r.sim);
    r.ctrl.startCountdown();
    expect(r.ctrl.frameDt(0.016)).toBe(0);
    expect(r.ctrl.frameDt(5)).toBe(0);
    r.ctrl.update(COUNTDOWN_S + 0.01);
    expect(r.ctrl.holding).toBe(false);
    expect(r.ctrl.frameDt(0.016)).toBe(0.016);
    expect(r.ctrl.frameDt(0.1)).toBe(0.1);
    expect(r.ctrl.frameDt(0.25)).toBe(0.25);
    expect(r.ctrl.frameDt(1)).toBe(0.25);
    expect(r.ctrl.frameDt(-1)).toBe(0);
    expect(r.ctrl.frameDt(Number.NaN)).toBe(0);
  });

  it('after a break: the gap counts against the budget and a new countdown holds the clock', async () => {
    const r = rig();
    await bootAndGo(r);
    const left = r.ctrl.budgetLeftMs();
    expect(r.ctrl.onHidden(60_000)).toBe(0);
    expect(r.versus.keepalives).toEqual([60_000]);
    r.clock.now += 60_000;
    r.ctrl.onVisible();
    expect(r.ctrl.holding).toBe(true);
    expect(r.ctrl.countdown()).toMatchObject({ first: false });
    expect(left - r.ctrl.budgetLeftMs()).toBeGreaterThanOrEqual(60_000);
    const t = r.sim.time;
    frame(r, 1);
    expect(r.sim.time).toBe(t);
  });

  it('wantsSave(): every 30 s, at once after a lost animal or a baby, and stores the budget', async () => {
    const r = rig();
    await bootAndGo(r);
    let n = 0;
    while (!r.ctrl.wantsSave() && n++ < 200) frame(r, 0.25);
    expect(n).toBeLessThan(121);
    expect(r.ctrl.wantsSave()).toBe(false);
    for (let i = 0; i < 4 * 29; i++) frame(r, 0.25);
    expect(r.ctrl.wantsSave()).toBe(false);
    for (let i = 0; i < 8; i++) frame(r, 0.25);
    expect(r.ctrl.wantsSave()).toBe(true);
    expect(r.ctrl.wantsSave()).toBe(false);
    r.sim.versus!.onLost('test');
    expect(r.ctrl.wantsSave()).toBe(true);
    expect(readRecord(r.store, PID, MATCH)!.budget.accMs).toBeGreaterThan(30_000);
  });
});

describe('snapshots and the outbox', () => {
  it('only h % 6 snapshots are enqueued (the last hour travels with the finish)', async () => {
    const r = rig();
    await bootAndGo(r);
    playHours(r, 30);
    expect(r.versus.snaps.map((s) => s.h)).toEqual([6, 12, 18, 24, 30]);
    expect(shouldUpload(48, 48)).toBe(false);
    expect(shouldUpload(42, 48)).toBe(true);
    expect(shouldUpload(5, 48)).toBe(false);
  });

  it('a complete match enqueues the finish with the final hour and a checked save', async () => {
    const r = rig();
    await bootAndGo(r);
    playHours(r, 48);
    expect(r.sim.versus!.ended).toBe(true);
    expect(r.versus.snaps.map((s) => s.h)).toEqual([6, 12, 18, 24, 30, 36, 42]);
    expect(r.versus.finishes).toHaveLength(1);
    const f = r.versus.finishes[0];
    expect(f.endReason).toBe('complete');
    expect(f.final.h).toBe(48);
    expect(f.profileId).toBe(PID);
    expect(f.save.encoding).toBe('gzip+base64');
    expect(f.save.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.saves).toBeGreaterThan(0);
    const rec = readRecord(r.store, PID, MATCH)!;
    expect(rec.ended).toBe('complete');
    expect(rec.finishQueued).toBe(true);
    expect(rec.mine!.at(-1)).toEqual([48, f.final.total]);
  });

  it('a dead outbox shows in state', async () => {
    const r = rig();
    await bootAndGo(r);
    expect(r.ctrl.outbox().dead).toBeNull();
    r.versus.dead = { code: 'bad_snapshot', at: T0 };
    expect(r.ctrl.outbox().dead).toEqual({ code: 'bad_snapshot', at: T0 });
  });

  it('opponent progress from acks and the ghost at my hour', async () => {
    const r = rig();
    await bootAndGo(r);
    expect(r.ctrl.opponent()).toMatchObject({ name: 'Mia', total: 0, live: false });
    playHours(r, 6);
    r.versus.ack({ ackHour: 6, opponent: { lastHour: 12, total: 140, parts: null, live: true, done: false, atMyHour: 60 }, serverTime: T0 });
    expect(r.ctrl.opponent()).toMatchObject({ lastHour: 12, total: 140, live: true, atMyHour: 60 });
    expect(ghostAt([[6, 50, 0, 0, 0, 0, 0, 0], [12, 140, 0, 0, 0, 0, 0, 0]], 12, 9)).toBe(50);
    expect(ghostAt([[6, 50, 0, 0, 0, 0, 0, 0]], 6, 9)).toBeNull();
    expect(ghostAt([[12, 140, 0, 0, 0, 0, 0, 0]], 12, 9)).toBeNull();
    // nobody joined yet
    const versus = new FakeVersus();
    versus.match = matchDto({ status: 'open', players: [seat(0, true)], joinedAt: null });
    const open = rig({ versus });
    await open.ctrl.boot(open.sim);
    expect(open.ctrl.opponent()).toBeNull();
  });
});

describe('the real-time budget', () => {
  it('budget expiry ends at the last completed hour and enqueues the finish with endReason "budget"', async () => {
    const r = rig();
    await bootAndGo(r);
    playHours(r, 10);
    for (let i = 0; i < 9; i++) frame(r, 0.25); // part of hour 11
    expect(r.sim.versus!.hour).toBe(10);
    const last = r.sim.versus!.lastSnapshot()!;
    r.clock.now += TEST_LENGTH.budgetMin * 60_000; // the wall clock says the budget is gone
    frame(r, 0.25);
    const v = r.sim.versus!;
    expect(v.ended).toBe(true);
    expect(v.endReason).toBe('budget');
    expect(v.hour).toBe(10);
    expect(v.total()).toBe(last.total);
    expect(r.ctrl.budgetLeftMs()).toBe(0);
    expect(r.ctrl.timeLeftS()).toBe(0);
    expect(r.versus.finishes).toHaveLength(1);
    expect(r.versus.finishes[0]).toMatchObject({ endReason: 'budget', final: { h: 10, total: last.total } });
    expect(r.versus.forfeits).toBe(0);
    const t = r.sim.time;
    frame(r, 0.25);
    expect(r.sim.time).toBe(t);
  });

  it('h = 0 at budget expiry → forfeit instead of a finish', async () => {
    const r = rig();
    await bootAndGo(r);
    expect(r.sim.versus!.hour).toBe(0);
    r.clock.now += TEST_LENGTH.budgetMin * 60_000 + 1;
    frame(r, 0.25);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.sim.versus!.ended).toBe(true);
    expect(r.versus.finishes).toHaveLength(0);
    expect(r.versus.forfeits).toBe(1);
    expect(readRecord(r.store, PID, MATCH)!.forfeitPending).toBe(false);
  });

  it('a budget found used up when the match is opened ends it at once', async () => {
    const store = new Mem();
    const local = new FakeLocal();
    const clock = { now: T0 };
    const first = rig({ store, local, clock });
    await bootAndGo(first);
    playHours(first, 8);
    local.write(first.ctrl.slotKey, JSON.stringify(first.sim.serialize()), {} as SaveMeta);
    first.ctrl.onHidden(1000);
    clock.now += 2 * 3600_000; // two hours later
    const again = rig({ store, local, clock });
    await again.ctrl.boot(again.sim);
    expect(again.sim.versus!.ended).toBe(true);
    expect(again.sim.versus!.endReason).toBe('budget');
    expect(again.versus.finishes[0]).toMatchObject({ endReason: 'budget', final: { h: 8 } });
  });

  it('moving the wall clock back does not extend the budget', async () => {
    const r = rig();
    await bootAndGo(r);
    for (let i = 0; i < 400; i++) frame(r, 0.25); // 100 s of play
    const left = r.ctrl.budgetLeftMs();
    r.clock.now -= 3600_000; // the device clock goes back an hour
    frame(r, 0.25);
    expect(r.ctrl.budgetLeftMs()).toBeLessThanOrEqual(left);
    // and a background gap across the change counts as nothing, not negative
    r.ctrl.onHidden(0);
    r.clock.now -= 600_000;
    r.ctrl.onVisible();
    expect(r.ctrl.budgetLeftMs()).toBeLessThanOrEqual(left);
  });

  it('budget arithmetic: elapsed = max(wall, accumulated)', () => {
    const b = newBudget();
    expect(budgetElapsed(b, 1000)).toBe(0);
    addForeground(b, 5000); // before the first Go: not counted
    expect(b.accMs).toBe(0);
    startBudget(b, 1000);
    addForeground(b, 2000);
    expect(budgetElapsed(b, 1500)).toBe(2000);
    expect(budgetElapsed(b, 10_000)).toBe(9000);
    noteHidden(b, 10_000);
    expect(budgetElapsed(b, 70_000)).toBe(69_000);
    noteVisible(b, 5_000); // clock went back while hidden: the gap is 0
    expect(b.accMs).toBe(2000);
    expect(budgetElapsed(b, 5_000)).toBe(4000);
  });
});

describe('soak recorder', () => {
  it('logs fps, p50, p95, heap and long tasks once a minute', () => {
    const lines: string[] = [];
    const rec = createSoakRecorder({ log: (l) => lines.push(l), heap: () => 150 * 1048576, longTasks: () => () => 2 });
    for (let i = 0; i < 1800; i++) rec.update(1 / 30);
    expect(lines).toHaveLength(0);
    rec.update(1 / 30);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[soak\] \{"min":1,"fps":30,"p50":33\.3,"p95":33\.3,"heapMB":150,"longTasks":2\}$/);
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('storage keys', () => {
  it('the record lives at wh2:vs:<pid>/<matchId>', async () => {
    const r = rig();
    await r.ctrl.boot(r.sim);
    expect(r.store.map.has(KEYS.vs(PID, MATCH))).toBe(true);
    expect(r.store.map.has(KEYS.vsIndex(PID))).toBe(true);
  });
});
