// Versus harness: the hub screens and the in-match UI against fakes (no server, no real sim).
//
//   ?screen=hub | challenge | code | join | family | lobby | prompt        (the hub, over a dark page)
//   ?screen=chip | sheet | countdown | timesup | results | waiting | game   (the game UI with mocks;
//                                                                           'game' = a normal game, no versus)
//
// window.__vsHarness.check() reports the chip rect, the speed group's rect (screen=game) and every
// element outside the viewport that is not clipped by a scrolling parent.
import type { Avatar, CodePreviewResponse, MatchDto, SeatDto, SeriesRow, ServerConfig, VersusParts, VersusSnapshot } from '../shared/api-types';
import { LENGTHS, VERSUS_RULES_VERSION, type VersusRules } from '../shared/versus-rules';
import type { CloudHandle, OutboxState, VersusApi } from '../src/core/cloud-types';
import type { PlayerInfo, SlotKey, UIDeps, VersusView } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { createGameUI } from '../src/ui';
import { createVersusExtension, openVersusHub } from '../src/ui/versus';
import type { HubScreen } from '../src/ui/versus/hub';
import type { CountdownView, OpponentView, VersusController } from '../src/versus/controller';
import { MockAudio, MockCreatures, MockProps, MockRenderContext, MockSim, MockViews } from './ui-mock';

const params = new URLSearchParams(location.search);
const screen = params.get('screen') ?? 'hub';
const gameEl = document.getElementById('game')!;
const uiEl = document.getElementById('ui')!;
const NOW = Date.now();
const H = 3600_000;

const av = (animal: Avatar['animal'], color: number): Avatar => ({ animal, color });
const ANA = av('lion', 1);
const MIA = av('zebra', 4);
const BEN = av('elephant', 2);
const LEO = av('tiger', 6);

function seat(n: 0 | 1, isMe: boolean, name: string, avatar: Avatar, extra: Partial<SeatDto> = {}): SeatDto {
  return { seat: n, role: n ? 'opponent' : 'challenger', name, avatar, isMe, state: 'joined', lastHour: 0, total: 0, parts: null, live: false, doneAt: null, endHour: null, endReason: null, device: null, ...extra };
}

function match(id: string, lengthMin: 30 | 60 | 90 | 120, players: SeatDto[], extra: Partial<MatchDto> = {}): MatchDto {
  const L = LENGTHS[lengthMin];
  return {
    id, kind: 'coded', code: null, lengthMin, days: L.days, seed: 1234, rulesVersion: VERSUS_RULES_VERSION, startMoney: L.startMoney, startMinute: 510, budgetMin: L.budgetMin,
    status: 'active', createdAt: NOW - 5 * H, codeExpiresAt: null, joinedAt: NOW - 4 * H, finishBy: NOW + 50 * H, mySeat: 0, players, result: null, ...extra,
  };
}

const PARTS_ME: VersusParts = { v: 341.5, a: 286.2, s: 214.8, b: 60, m: 352.4, l: 1 };
const PARTS_MIA: VersusParts = { v: 402.1, a: 251.9, s: 190.3, b: 30, m: 330.6, l: 0 };

const MATCHES: MatchDto[] = [
  match('m-turn', 30, [seat(0, true, 'Ana', ANA), seat(1, false, 'Mia', MIA, { lastHour: 96, total: 512, live: true, state: 'playing' })]),
  match('m-open', 60, [seat(0, true, 'Ana', ANA)], { status: 'open', code: 'K7PM2Q', joinedAt: null, finishBy: null, codeExpiresAt: NOW + 40 * H, createdAt: NOW - 2 * H }),
  match('m-wait', 30, [seat(0, true, 'Ana', ANA, { state: 'done', doneAt: NOW - H, total: 1240, lastHour: 360 }), seat(1, false, 'Ben', BEN, { lastHour: 48, total: 210 })], { kind: 'family', createdAt: NOW - 8 * H }),
  match('m-won', 30, [seat(0, true, 'Ana', ANA, { state: 'done', total: 1240 }), seat(1, false, 'Mia', MIA, { state: 'done', total: 1180 })], {
    status: 'finished', createdAt: NOW - 30 * H, result: { kind: 'win', winnerSeat: 0, reason: 'both_finished', comparedAtHour: 360, totals: [1240, 1180], decidedAt: NOW - 20 * H },
  }),
  match('m-lost', 60, [seat(0, false, 'Leo', LEO, { state: 'done', total: 2210 }), seat(1, true, 'Ana', ANA, { state: 'done', total: 1990 })], {
    mySeat: 1, status: 'finished', createdAt: NOW - 60 * H, result: { kind: 'win', winnerSeat: 0, reason: 'both_finished', comparedAtHour: 720, totals: [2210, 1990], decidedAt: NOW - 50 * H },
  }),
  match('m-tie', 30, [seat(0, true, 'Ana', ANA, { state: 'done', total: 999 }), seat(1, false, 'Ben', BEN, { state: 'done', total: 999 })], {
    kind: 'family', status: 'finished', createdAt: NOW - 90 * H, result: { kind: 'tie', winnerSeat: null, reason: 'both_finished', comparedAtHour: 360, totals: [999, 999], decidedAt: NOW - 80 * H },
  }),
];

const CONFIG: ServerConfig = { apiVersion: 1, minAppVersion: null, maxProfiles: 8, versusLengths: [30, 60, 90, 120], versusRulesVersion: VERSUS_RULES_VERSION, testLength: false };

class FakeVersusApi implements VersusApi {
  available = true;
  config() {
    return CONFIG;
  }
  async create(body: { lengthMin: number; opponentProfileId?: string }): Promise<MatchDto> {
    const l = (body.lengthMin as 30 | 60 | 90 | 120) || 30;
    if (body.opponentProfileId) return match('m-fam', l, [seat(0, true, 'Ana', ANA), seat(1, false, 'Ben', BEN)], { kind: 'family' });
    return match('m-new', l, [seat(0, true, 'Ana', ANA)], { status: 'open', code: 'K7PM2Q', joinedAt: null, finishBy: null, codeExpiresAt: NOW + 48 * H });
  }
  async preview(code: string): Promise<CodePreviewResponse> {
    if (code === 'ABCDEF') throw Object.assign(new Error("That code doesn't work — check the letters"), { code: 'not_found' });
    return { matchId: 'm-join', challenger: { name: 'Mia', avatar: MIA }, lengthMin: 60, days: 30, status: 'open', codeExpiresAt: NOW + 30 * H, serverTime: NOW };
  }
  async join(): Promise<MatchDto> {
    return match('m-join', 60, [seat(0, false, 'Mia', MIA), seat(1, true, 'Ana', ANA)], { mySeat: 1 });
  }
  async get(id: string): Promise<MatchDto> {
    return MATCHES.find((m) => m.id === id) ?? MATCHES[0];
  }
  async list(): Promise<MatchDto[]> {
    return MATCHES;
  }
  async series() {
    return { lastHour: 0, done: false, series: [], serverTime: NOW };
  }
  async forfeit(id: string): Promise<MatchDto> {
    return this.get(id);
  }
  async cancel(id: string): Promise<MatchDto> {
    return { ...(await this.get(id)), status: 'cancelled' };
  }
  async rematch(id: string): Promise<MatchDto> {
    return this.get(id);
  }
  enqueueSnapshots(): void {}
  enqueueFinish(): void {}
  async flush() {
    return 'empty' as const;
  }
  flushKeepalive() {
    return 0;
  }
  outboxState(id: string): OutboxState {
    return { pending: 0, lastAck: null, dead: id === 'm-dead' ? { code: 'bad_snapshot', at: NOW } : null, finishSent: false, finishMatch: null };
  }
  onAck() {
    return () => {};
  }
}

const memory = new Map<string, string>();
const store = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
const player: PlayerInfo = { ref: 'p-ana', profileId: 'p-ana', accountId: 'acc', name: 'Ana', avatar: ANA };
const profiles = [
  { id: 'p-ana', name: 'Ana', avatar: ANA },
  { id: 'p-ben', name: 'Ben', avatar: BEN },
  { id: 'p-dad', name: 'Dad', avatar: av('bear', 7) },
];
const cloud = { enabled: true, versus: new FakeVersusApi(), profiles: { list: () => profiles } } as unknown as CloudHandle;

// ------------------------------------------------------------------ in-match fakes
function fakeView(sim: MockSim, ended: boolean, reason: 'complete' | 'budget' | null = null): VersusView {
  const rules: VersusRules = { matchId: 'm-turn', seed: 1234, lengthMin: 30, days: 15, rulesVersion: 1, startMoney: 100_000, startMinute: 510 };
  const snap: VersusSnapshot = { h: 120, day: 6, min: 510, parts: PARTS_ME, total: 1240, run: 35240, cash: 48250, guests: 87, visitors: 690, animals: 21, species: 5, habitats: 4, stars: 64 };
  return {
    rules,
    hour: ended ? 360 : 120,
    hoursTotal: 360,
    ended,
    endReason: reason,
    parts: () => PARTS_ME,
    total: () => 1240,
    todayPoints: () => 142,
    gameSecondsLeft: () => (ended ? 0 : 5684),
    realSecondsLeft: () => (ended ? 0 : 1421),
    lastSnapshot: () => snap,
    endNow: () => {},
  } satisfies VersusView & { sim?: MockSim };
}

function fakeCtrl(view: VersusView, o: { countdown?: CountdownView | null; result?: boolean; opp?: Partial<OpponentView> } = {}): VersusController {
  const decided = o.result !== false;
  const m: MatchDto = decided
    ? { ...MATCHES[3], id: 'm-turn' }
    : match('m-turn', 30, [seat(0, true, 'Ana', ANA, { state: 'done', total: 1240 }), seat(1, false, 'Mia', MIA, { lastHour: 210, total: 760, live: true })]);
  const opp: OpponentView = { name: 'Mia', avatar: MIA, lastHour: 140, total: 1305, atMyHour: 1180, parts: PARTS_MIA, live: true, done: false, ...o.opp };
  const mine: [number, number][] = [];
  const theirs: SeriesRow[] = [];
  for (let h = 6; h <= 360; h += 6) {
    mine.push([h, Math.round(1240 * (h / 360) ** 1.3)]);
    theirs.push([h, Math.round(1180 * (h / 360) ** 1.15), 0, 0, 0, 0, 0, 0]);
  }
  return {
    matchId: 'm-turn',
    slotKey: 'p-ana/vs-m-turn' as SlotKey,
    holding: !!o.countdown,
    player,
    boot: async () => {},
    startCountdown: () => {},
    frameDt: (raw) => Math.min(raw, 0.25),
    update: () => {},
    wantsSave: () => false,
    onHidden: () => 0,
    onVisible: () => {},
    budgetLeftMs: () => 1421_000,
    opponent: () => opp,
    outbox: () => ({ pending: 0, lastAck: null, dead: null, finishSent: true, finishMatch: null }),
    match: () => m,
    view: () => view,
    countdown: () => o.countdown ?? null,
    timeLeftS: () => (view.ended ? 0 : 1421),
    lost: () => false,
    mySeries: () => mine,
    oppSeries: () => theirs,
    familyNext: () => null,
    refresh: () => {},
    giveUp: async () => 'ok',
    rematch: async () => 'ok',
    backToMenu: async () => {},
    passTo: async () => {},
    onChange: () => () => {},
    dispose: () => {},
  };
}

async function game(kind: string): Promise<void> {
  const events = new EventBus();
  const sim = new MockSim(events);
  const ctx = new MockRenderContext(gameEl, sim.world, events, 'low');
  const props = new MockProps(sim.world, events, ctx.scene);
  const creatures = new MockCreatures();
  const views = new MockViews(sim, ctx, creatures);
  const audio = new MockAudio();
  const deps: UIDeps = { sim, ctx, props, creatures, views, audio, save: () => 'saved', newGame: () => sim.newGame(), player };
  if (kind !== 'game') {
    const ended = kind === 'results' || kind === 'waiting';
    const view = fakeView(sim, ended, ended ? 'complete' : null);
    (sim as unknown as { versus: VersusView }).versus = view;
    sim.speed = 3;
    const ctrl = fakeCtrl(view, {
      countdown: kind === 'countdown' ? { left: 2.4, first: false, go: false } : null,
      result: kind !== 'waiting',
    });
    deps.extensions = [createVersusExtension(ctrl)];
    deps.switchSlot = async () => {};
  }
  const ui = createGameUI(uiEl, deps);
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    ui.update(dt);
    ctx.render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  if (kind === 'sheet') setTimeout(() => (document.querySelector('.wh-vs-chip') as HTMLElement | null)?.click(), 300);
  if (kind === 'timesup') setTimeout(() => events.emit('versusEnded', { reason: 'budget', hour: 270, total: 1240, parts: PARTS_ME }), 300);
  if (kind === 'chip') {
    setTimeout(() => events.emit('versusPoints', { part: 'babies', delta: 30, total: 1240, text: 'Baby zebra!' }), 200);
    setTimeout(() => events.emit('versusPoints', { part: 'money', delta: 15.6, total: 1240, text: 'Day 6: +142 points' }), 500);
  }
}

function check(): unknown {
  const vw = innerWidth;
  const vh = innerHeight;
  const r = (sel: string) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom), width: Math.round(b.width), height: Math.round(b.height) };
  };
  const clipped = (e: Element): boolean => {
    for (let p = e.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowY !== 'visible' || s.overflowX !== 'visible') {
        const pb = p.getBoundingClientRect();
        const b = e.getBoundingClientRect();
        if (b.bottom > pb.bottom + 0.5 || b.top < pb.top - 0.5 || b.right > pb.right + 0.5 || b.left < pb.left - 0.5) return true;
      }
    }
    return false;
  };
  const outside: string[] = [];
  const scope = document.querySelector('.wh-vs') ?? document.querySelector('.wh-vs-end') ?? document.querySelector('.wh-vs-sheet') ?? document.querySelector('.wh-vs-count') ?? document.body;
  for (const e of Array.from(scope.querySelectorAll('*'))) {
    const b = e.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) continue;
    if (e.closest('.wh-confetti')) continue;
    const out = b.left < -0.5 || b.top < -0.5 || b.right > vw + 0.5 || b.bottom > vh + 0.5;
    if (out && !clipped(e)) outside.push(`${e.tagName.toLowerCase()}.${(e.className as unknown as string).toString().split(' ').join('.')} ${Math.round(b.left)},${Math.round(b.top)}–${Math.round(b.right)},${Math.round(b.bottom)}`);
  }
  return {
    viewport: [vw, vh],
    chip: r('.wh-vs-chip'),
    chipText: document.querySelector('.wh-vs-chip')?.textContent ?? null,
    speedGroup: r('.wh-top-speed'),
    speedSlot: r('.wh-slot-speed'),
    menu: r('.wh-menubtn'),
    outside: outside.slice(0, 20),
    outsideCount: outside.length,
  };
}

(window as unknown as { __vsHarness: unknown }).__vsHarness = { check };

async function boot(): Promise<void> {
  if (['chip', 'sheet', 'countdown', 'timesup', 'results', 'waiting', 'game'].includes(screen)) return game(screen);
  const hubScreen = (screen === 'prompt' ? 'hub' : screen) as HubScreen;
  const start = { screen: hubScreen, match: screen === 'code' ? MATCHES[1] : screen === 'lobby' ? MATCHES[0] : undefined, code: params.get('code') ?? (screen === 'join' ? 'K7PM2Q' : undefined) };
  const res = await openVersusHub(uiEl, { cloud, player, tutorialDone: screen !== 'prompt', storage: store, start });
  console.log('[harness] hub result', JSON.stringify(res));
}

void boot();
