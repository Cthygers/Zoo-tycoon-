// Focused tests for the round-9 leftovers: the restroom, food, drink and bench complaints are a
// toast when they start, then log lines; a save from before the bred species were kept does not
// announce each species' next baby as its first again.

import { describe, expect, it } from 'vitest';
import type { SimSave } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { SPECIES_BY_ID } from '../src/data/species';
import { createSimulation } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';
import { buildZoo, buyHerd, hire, newSim } from './sim-helpers';

type Note = { text: string; logOnly?: boolean };

describe('lasting need complaints', () => {
  it('restroom, food, drink and bench: one toast each, then log lines while they go on', () => {
    const { sim, log } = newSim(11);
    buildZoo(sim);
    buyHerd(sim, 'zebra', 3);
    hire(sim);
    sim.setSpeed(3);
    const c = sim.progress.complaints;
    while (sim.minuteOfDay < 17 * 60) {
      c.restroom = c.food = c.drink = c.bench = 1000;
      sim.update(0.1);
    }
    const all = log.filter((e) => e.type === 'notify').map((e) => e.payload as Note);
    for (const re of [/^Guests can’t find a restroom/, /^Hungry guests/, /^Thirsty guests/, /^Tired guests/]) {
      const ns = all.filter((n) => re.test(n.text));
      expect(ns.length).toBeGreaterThanOrEqual(2);
      expect(ns[0].logOnly).toBeFalsy();
      expect(ns.slice(1).every((n) => n.logOnly)).toBe(true);
    }
  }, 90_000);
});

describe('first births in an old save', () => {
  it('recalls the species that bred from young with their mother and the births in the log', () => {
    const { sim } = newSim(5);
    sim.money = 1e6;
    buildZoo(sim);
    const [mum, calf] = buyHerd(sim, 'zebra', 2);
    sim.animals.get(calf)!.mother = mum;
    const save = JSON.parse(JSON.stringify(sim.serialize())) as SimSave & { progress: { bredSpecies?: string[] }; messages: { text: string }[] };
    // a save from before round 6: no bred species, a lion birth in the message log
    delete save.progress.bredSpecies;
    save.messages.push({ text: `Nala the ${SPECIES_BY_ID.lion.name} gave birth to a baby girl, Kesi!` });
    const old = createSimulation(new EventBus(), 1) as Simulation;
    old.load(save);
    expect([...old.progress.bredSpecies].sort()).toEqual(['lion', 'zebra']);
    // a newer save keeps exactly the list it has
    save.progress.bredSpecies = ['giraffe'];
    old.load(save);
    expect([...old.progress.bredSpecies]).toEqual(['giraffe']);
  });
});
