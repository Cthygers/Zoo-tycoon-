// Sim hooks that feed the audio feedback module: notification sound
// categories, money popup kinds and the animalPlaced event.
import { describe, expect, it } from 'vitest';
import { TILE } from '../src/core/constants';
import type { GameEvents } from '../src/core/events';
import type { EdgeRef } from '../src/core/world';
import { soundForKey } from '../src/sim/simulation';
import { HAB, buildZoo, buyHerd, newSim } from './sim-helpers';

function notifies(events: ReturnType<typeof newSim>['events']): GameEvents['notify'][] {
  const out: GameEvents['notify'][] = [];
  events.on('notify', (n) => out.push(n));
  return out;
}

describe('notification sounds', () => {
  it('maps throttle-key prefixes to sounds', () => {
    expect(soundForKey('escape:12')).toBe('escape');
    expect(soundForKey('contain:3')).toBe('contain');
    expect(soundForKey('healed:9')).toBe('healed');
    expect(soundForKey('sick:4')).toBe('sick');
    expect(soundForKey('debt')).toBe('debt');
    expect(soundForKey('gate')).toBe('gate');
    expect(soundForKey('thirsty:2')).toBeUndefined();
    expect(soundForKey(null)).toBeUndefined();
  });

  it('an escape emits notify with sound "escape"', () => {
    const { sim, events } = newSim(11);
    buildZoo(sim);
    const [id] = buyHerd(sim, 'zebra', 2);
    const seen = notifies(events);
    const gap: EdgeRef = { dir: 'h', x: 36, z: HAB.z0 };
    expect(sim.removeFences([gap]).ok).toBe(true);
    const stray = sim.animals.get(id)!;
    stray.x = (36 + 0.5) * TILE;
    stray.z = (HAB.z0 - 3 + 0.5) * TILE;
    stray.moving = false;
    sim.setSpeed(1);
    sim.update(0.1);
    expect(stray.escaped).toBe(true);
    const n = seen.find((m) => m.sound === 'escape');
    expect(n).toBeDefined();
    expect(n!.kind).toBe('bad');
    expect(n!.focus).toBeDefined();
  });

  it('the first birth of a species gives "birth"; later births stay log-only', () => {
    const { sim, events } = newSim(5);
    sim.money = 1e6;
    buildZoo(sim);
    const ids = buyHerd(sim, 'zebra', 3);
    const seen = notifies(events);
    const mother = ids.map((i) => sim.animals.get(i)!).find((a) => a.sex === 'F')!;
    const birth = () => {
      const before = sim.animals.size;
      mother.pregnantDays = 100;
      for (let i = 0; i < 50 && sim.animals.size === before; i++) sim.update(0.1);
      expect(sim.animals.size).toBe(before + 1);
    };
    sim.setSpeed(1);
    birth();
    const first = seen.filter((m) => /gave birth/.test(m.text));
    expect(first.length).toBe(1);
    expect(first[0].sound).toBe('birth');
    expect(first[0].logOnly).toBeUndefined();
    birth();
    const later = seen.filter((m) => /gave birth/.test(m.text));
    expect(later[1].logOnly).toBe(true);
  });

  it('debt gives "debt", the day summary "day", a sale "sold" and a hire "hire"', () => {
    const { sim, events } = newSim();
    buildZoo(sim);
    const [id] = buyHerd(sim, 'zebra', 1);
    const seen = notifies(events);
    sim.sellAnimal(id);
    expect(seen.at(-1)!.sound).toBe('sold');
    sim.money = 5;
    sim.spend('upkeep', 100);
    sim.flushMoney();
    expect(seen.some((m) => m.sound === 'debt' && m.kind === 'bad')).toBe(true);
    sim.money = 1e5;
    expect(sim.hireStaff('vet', (36 + 0.5) * TILE, (HAB.z1 + 2 + 0.5) * TILE).ok).toBe(true);
    expect(seen.at(-1)!.sound).toBe('hire');
    sim.setSpeed(3);
    const day = sim.day;
    while (sim.day === day) sim.update(0.5);
    expect(seen.some((m) => m.sound === 'day')).toBe(true);
  }, 30_000);
});

describe('money popups and placement', () => {
  it('money popups carry their income kind', () => {
    const { sim, events } = newSim();
    const kinds: GameEvents['moneyPopup'][] = [];
    events.on('moneyPopup', (m) => kinds.push(m));
    sim.earn('donations', 4, { x: 10, z: 12 });
    sim.earn('other', 4);
    expect(kinds).toEqual([{ x: 10, z: 12, amount: 4, kind: 'donations' }]);
  });

  it('buyAnimal emits animalPlaced right after animalAdded, never on a dry run', () => {
    const { sim, events } = newSim();
    buildZoo(sim);
    const order: string[] = [];
    let placed: GameEvents['animalPlaced'] | null = null;
    events.on('animalAdded', () => order.push('added'));
    events.on('animalPlaced', (p) => {
      order.push('placed');
      placed = p;
    });
    const x = (HAB.x0 + 3.5) * TILE,
      z = (HAB.z0 + 5.5) * TILE;
    expect(sim.buyAnimal('zebra', x, z, true).ok).toBe(true);
    expect(order).toEqual([]);
    expect(sim.buyAnimal('zebra', x, z).ok).toBe(true);
    expect(order).toEqual(['added', 'placed']);
    const a = [...sim.animals.values()].at(-1)!;
    expect(placed).toEqual({ id: a.id, x: a.x, z: a.z });
  });
});
