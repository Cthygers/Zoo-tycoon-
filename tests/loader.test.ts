// Loading screen: the shader warm-up plan (a few new materials per frame) and
// the entity views' time-sliced model creation.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { planWarmupSteps } from '../src/loader';
import { createEntityViews } from '../src/views';
import { EventBus } from '../src/core/events';
import type { CreatureModel, ICreatureFactory, IPropsLayer, IRenderContext, ISimulation } from '../src/core/contracts';
import type { GuestState } from '../src/core/types';

describe('planWarmupSteps', () => {
  const mats = (item: string) => item.split('');

  it('limits the new materials per step and keeps the item order', () => {
    const steps = planWarmupSteps(['ab', 'c', 'de', 'f', 'g'], mats, 3);
    expect(steps).toEqual([['ab', 'c'], ['de', 'f'], ['g']]);
  });

  it('adds items that bring nothing new to the current step', () => {
    const steps = planWarmupSteps(['ab', 'a', 'ba', 'cd', 'b'], mats, 2);
    expect(steps).toEqual([['ab', 'a', 'ba'], ['cd', 'b']]);
  });

  it('gives an item with more new materials than the limit a step of its own', () => {
    const steps = planWarmupSteps(['a', 'bcde', 'f'], mats, 2);
    expect(steps).toEqual([['a'], ['bcde'], ['f']]);
  });

  it('counts a material used twice by one item once', () => {
    expect(planWarmupSteps(['aa', 'b'], mats, 2)).toEqual([['aa', 'b']]);
    expect(planWarmupSteps([], mats, 2)).toEqual([]);
  });
});

describe('entity views prepare()', () => {
  function guest(id: number): GuestState {
    return {
      id,
      name: `g${id}`,
      appearance: { skin: 0, hair: 0, shirt: 0, pants: 0, shoes: 0, hairStyle: 0, height: 1.7, build: 1, child: false, female: false },
      x: id,
      y: 0,
      z: 0,
      heading: 0,
      speed: 0,
      action: 'walk',
      actionTime: 0,
      needs: {} as GuestState['needs'],
      happiness: 1,
      money: 0,
      holding: 'none',
      thoughts: [],
      seenSpecies: [],
      hidden: false,
      seed: id,
    };
  }

  function setup(guests: number, buildMs: number) {
    const sim = {
      animals: new Map(),
      guests: new Map(Array.from({ length: guests }, (_, i) => [i + 1, guest(i + 1)])),
      staff: new Map(),
      events: new EventBus(),
      speed: 1,
    } as unknown as ISimulation;
    const camera = new THREE.PerspectiveCamera();
    const ctx = { scene: new THREE.Scene(), camera } as unknown as IRenderContext;
    let created = 0;
    const model = (): CreatureModel => {
      // stands in for a body mesh build: a long main-thread task
      const end = performance.now() + buildMs;
      while (performance.now() < end);
      created++;
      return { object: new THREE.Object3D(), height: 1.7, radius: 0.3, update() {}, setGrowth() {}, setHighlighted() {}, dispose() {} };
    };
    const creatures = { createHuman: model, createAnimal: model } as unknown as ICreatureFactory;
    const views = createEntityViews(sim, ctx, creatures, {} as IPropsLayer);
    return { views, created: () => created };
  }

  it('creates no model until prepare() or the first update()', () => {
    const { views, created } = setup(3, 0);
    expect(created()).toBe(0);
    views.update(0);
    expect(created()).toBe(3);
    views.update(0.016);
    expect(created()).toBe(3);
  });

  it('creates every model in short slices, reporting progress, and update() keeps them', async () => {
    const { views, created } = setup(6, 5);
    const fractions: number[] = [];
    let yielded = 0;
    const timer = setInterval(() => yielded++, 0);
    await views.prepare((f) => fractions.push(f));
    clearInterval(timer);
    expect(created()).toBe(6);
    expect(fractions.at(-1)).toBe(1);
    // 6 × 5 ms with a 12 ms slice: the event loop ran in between
    expect(yielded).toBeGreaterThan(0);
    views.update(0);
    expect(created()).toBe(6);
  });
});
