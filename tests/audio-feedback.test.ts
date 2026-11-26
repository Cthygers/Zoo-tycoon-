// Feedback module (src/audio/modules/feedback.ts) against FakeHost:
// transactions, notification notes, the escape bell, the placement crate and
// the pause filter.
import { describe, expect, it } from 'vitest';
import createFeedback, { BELL_REPEAT, COIN_IDS, NOTE_GAP, PAUSE_FILTER, RESUME_FILTER, SAME_SOUND_GAP, TX } from '../src/audio/modules/feedback';
import { RECIPES } from '../src/audio/recipes';
import { ENTRANCE_TILE, TILE } from '../src/core/constants';
import type { ISimulation } from '../src/core/contracts';
import type { MoneyKind, NotifySound } from '../src/core/events';
import type { AnimalState } from '../src/core/types';
import { FakeHost } from './helpers/fakeHost';

const TX_IDS = new Set<string>(['cue.turnstile', 'cue.beep', 'cue.coindrop', ...COIN_IDS]);

function setup() {
  const sim = { animals: new Map<number, AnimalState>(), speed: 1 } as unknown as ISimulation & { speed: number };
  const host = new FakeHost({ sim });
  const mod = createFeedback(host);
  /** Clock time of every successful play call (a transaction schedules all its sounds in one call). */
  const callTimes: number[] = [];
  const play = host.play.bind(host);
  host.play = (spec) => {
    const h = play(spec);
    if (h) callTimes.push(host.time);
    return h;
  };
  /** Advance the clock in 50 ms frames, as the engine's update would. */
  const run = (seconds: number, each?: (t: number) => void) => {
    for (let i = 0; i < Math.round(seconds / 0.05); i++) {
      each?.(host.time);
      host.advance(0.05);
      mod.update(0.05);
    }
  };
  const ids = () => host.plays.map((p) => p.spec.id);
  return { sim, host, mod, run, ids, callTimes };
}

const notify = (sound: NotifySound, focus?: { x: number; z: number }) => ({ text: sound, kind: 'info' as const, sound, focus });

describe('feedback module: transactions', () => {
  it('registers every cue it plays and owns the coin sound', () => {
    const { mod } = setup();
    expect(mod.ownsCoins).toBe(true);
    for (const id of mod.warm!()) expect(RECIPES[id], id).toBeDefined();
  });

  it('turns a 12 popups/s storm near the ear into sparse, irregular, non-repeating sounds', () => {
    const { host, run, callTimes } = setup();
    const kinds: MoneyKind[] = ['admissions', 'admissions', 'admissions', 'shopIncome', 'donations', 'other'];
    let n = 0;
    run(20, () => {
      // 12 popups per second (3 in every 5 frames of 50 ms) within a few metres of the ear
      if (n++ % 5 < 3) host.events.emit('moneyPopup', { x: (n % 7) - 3, z: (n % 5) - 2, amount: n % 9 === 0 ? 55 : n % 4 === 0 ? 15 : 5, kind: kinds[n % kinds.length] });
    });
    // one transaction = the sounds scheduled together (the kind's sound plus its coins)
    const starts = [...new Set(callTimes)];
    expect(starts.length).toBeGreaterThan(3);
    expect(starts.length / 20).toBeLessThanOrEqual(0.75);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    expect(sd / mean).toBeGreaterThanOrEqual(0.25);
    const coins = host.plays.map((p) => p.spec.id).filter((id) => id.startsWith('cue.coin#'));
    expect(coins.length).toBeGreaterThan(2);
    for (let i = 1; i < coins.length; i++) expect(coins[i]).not.toBe(coins[i - 1]);
    for (const p of host.plays.filter((q) => TX_IDS.has(q.spec.id))) {
      expect(p.spec.pool).toBe('fx');
      expect(p.spec.refDist).toBe(5);
      expect(p.spec.radius).toBe(25);
    }
  });

  it('keeps a saturated single-kind stream irregular', () => {
    const { host, run, callTimes } = setup();
    run(60, () => host.events.emit('moneyPopup', { x: 2, z: 2, amount: 15, kind: 'admissions' }));
    const starts = [...new Set(callTimes)];
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    expect(1 / mean).toBeLessThanOrEqual(TX.refill + 0.02);
    expect(sd / mean).toBeGreaterThanOrEqual(0.2);
  });

  it('plays nothing for a popup 30 m away or with the camera far up', () => {
    const { host, run } = setup();
    run(2, () => host.events.emit('moneyPopup', { x: 30, z: 0, amount: 50, kind: 'shopIncome' }));
    expect(host.plays.length).toBe(0);
    host.listener.camDist = 60;
    run(2, () => host.events.emit('moneyPopup', { x: 1, z: 1, amount: 50, kind: 'shopIncome' }));
    expect(host.plays.length).toBe(0);
  });

  it('sizes the sound by the amount and quietens with habituation', () => {
    const { host, run, ids } = setup();
    host.events.emit('moneyPopup', { x: 0, z: 0, amount: 5, kind: 'donations' });
    run(1);
    expect(ids()).toEqual(['cue.coindrop']);
    run(10);
    host.events.emit('moneyPopup', { x: 0, z: 0, amount: 25, kind: 'shopIncome' });
    run(1);
    expect(ids().slice(1)).toEqual(['cue.beep', 'cue.coin#3']);
    run(10);
    host.events.emit('moneyPopup', { x: 0, z: 0, amount: 80, kind: 'admissions' });
    run(1);
    const big = ids().slice(3);
    expect(big[0]).toBe('cue.turnstile');
    expect(big.length).toBeGreaterThanOrEqual(3);
    expect(big.slice(1).every((id) => id.startsWith('cue.coin#'))).toBe(true);
  });
});

describe('feedback module: notifications', () => {
  it('maps sounds to notes, skips log-only and repeats within 30 s', () => {
    const { host, run, ids } = setup();
    host.events.emit('notify', { ...notify('birth'), logOnly: true });
    expect(host.plays.length).toBe(0);
    host.events.emit('notify', notify('birth'));
    run(2);
    host.events.emit('notify', notify('sick'));
    run(2);
    host.events.emit('notify', notify('sold'));
    run(2);
    host.events.emit('notify', notify('day'));
    run(2);
    host.events.emit('notify', notify('debt'));
    run(2);
    // the same sound again within 30 s stays silent
    host.events.emit('notify', notify('birth'));
    expect(ids()).toEqual(['cue.note.good', 'cue.note.warn', 'cue.cash', 'cue.ledger', 'cue.note.bad']);
    expect(host.plays.every((p) => p.spec.pool === 'ui')).toBe(true);
    // the gate chime is positional at the entrance: heard from nearby only
    host.events.emit('notify', notify('gate'));
    expect(ids().length).toBe(5);
    run(SAME_SOUND_GAP);
    host.listener.x = (ENTRANCE_TILE.x + 0.5) * TILE;
    host.listener.z = (ENTRANCE_TILE.z - 4) * TILE;
    host.events.emit('notify', notify('gate'));
    expect(ids().at(-1)).toBe('cue.gate');
    expect(host.plays.at(-1)!.spec).toMatchObject({ pool: 'fx', at: { x: host.listener.x } });
    run(2);
    host.events.emit('notify', notify('birth'));
    expect(ids().at(-1)).toBe('cue.note.good');
  });

  it('plays one note per 1.5 s unless the new one ranks higher', () => {
    const { host, run, ids } = setup();
    host.events.emit('notify', notify('hire'));
    host.events.emit('notify', notify('day'));
    host.events.emit('notify', notify('contain'));
    expect(ids()).toEqual(['cue.note.good']);
    host.events.emit('notify', notify('sick'));
    host.events.emit('notify', notify('death'));
    expect(ids()).toEqual(['cue.note.good', 'cue.note.warn', 'cue.note.bad']);
    run(NOTE_GAP + 0.1);
    host.events.emit('notify', notify('day'));
    expect(ids().at(-1)).toBe('cue.ledger');
  });

  it('rings the escape bell at the focus and every 20–30 s until no animal is out', () => {
    const { sim, host, run } = setup();
    const a = { id: 7, x: 12, y: 0, z: -6, escaped: true } as AnimalState;
    sim.animals.set(7, a);
    host.events.emit('notify', notify('escape', { x: 12, z: -6 }));
    const first = host.plays.filter((p) => p.spec.id === 'cue.bell');
    expect(first.length).toBe(1);
    expect(first[0].spec.at).toMatchObject({ x: 12, z: -6 });
    expect(first[0].spec.pool).toBe('fx');
    expect(host.plays.some((p) => p.spec.id === 'cue.note.bad')).toBe(true);
    run(120);
    const bells = host.plays.filter((p) => p.spec.id === 'cue.bell').map((p) => p.t);
    expect(bells.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < bells.length; i++) {
      expect(bells[i] - bells[i - 1]).toBeGreaterThanOrEqual(BELL_REPEAT[0] - 0.05);
      expect(bells[i] - bells[i - 1]).toBeLessThanOrEqual(BELL_REPEAT[1] + 1.05);
    }
    expect(host.plays.filter((p) => p.spec.id === 'cue.bell').slice(1).every((p) => p.spec.track === 7)).toBe(true);
    a.escaped = false;
    const n = bells.length;
    run(90);
    expect(host.plays.filter((p) => p.spec.id === 'cue.bell').length).toBe(n);
  });
});

describe('feedback module: crate and pause', () => {
  it('plays one crate per placement, at most one per 1.5 s', () => {
    const { host, run } = setup();
    host.events.emit('animalPlaced', { id: 1, x: 4, z: 3 });
    host.events.emit('animalPlaced', { id: 2, x: 5, z: 3 });
    run(1);
    host.events.emit('animalPlaced', { id: 3, x: 5, z: 3 });
    run(1);
    host.events.emit('animalPlaced', { id: 4, x: 5, z: 3 });
    const crates = host.plays.filter((p) => p.spec.id === 'cue.crate');
    expect(crates.length).toBe(2);
    expect(crates[0].spec).toMatchObject({ pool: 'fx', at: { x: 4, z: 3 }, refDist: 8, radius: 60 });
  });

  it('muffles the world while paused and restores it on resume', () => {
    const { sim, host, run, ids } = setup();
    run(0.5);
    expect(host.worldFilter.cutHz).toBe(20000);
    expect(ids()).toEqual([]);
    sim.speed = 0;
    run(0.1);
    expect(host.worldFilter).toEqual(PAUSE_FILTER);
    expect(ids()).toEqual(['cue.pause']);
    sim.speed = 2;
    run(0.1);
    expect(host.worldFilter).toEqual(RESUME_FILTER);
    expect(ids()).toEqual(['cue.pause', 'cue.resume']);
  });

  it('unsubscribes on dispose', () => {
    const { host, mod } = setup();
    mod.dispose();
    host.events.emit('animalPlaced', { id: 1, x: 0, z: 0 });
    host.events.emit('notify', notify('birth'));
    expect(host.plays.length).toBe(0);
  });
});
