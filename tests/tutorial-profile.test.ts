// The player's tutorial state and the old tour's migration (spec §6.6, T1/T5/T7): who the legacy
// key applies to, the T7 guard, status ranks, read-aloud on by default, and an escaped animal
// never sending the child back to adopt.
import { describe, expect, it } from 'vitest';
import { readTutorialState, writeTutorialState } from '../src/core/player-state';
import { KEYS } from '../src/core/storage-keys';
import type { Facts } from '../src/ui/tutorial/facts';
import { TutorialMachine } from '../src/ui/tutorial/machine';
import { legacyApplies, legacyOutcome, migrateLegacyTour, nextStatus, readAloudOn, setReadAloud, setStatus, tutorialDone, wantsFirstRun } from '../src/ui/tutorial/profile';

class Mem {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

describe('tutorial profile state', () => {
  it("a new profile starts 'never' even when wildhaven-tour = 'done' (T1)", () => {
    const kv = new Mem();
    kv.setItem(KEYS.legacyTour, 'done');
    expect(legacyApplies(kv, 'p-new')).toBe(false);
    expect(migrateLegacyTour(kv, 'p-new', { day: 40, animals: 9 })).toBeNull();
    expect(readTutorialState(kv, 'p-new').status).toBe('never');
    expect(wantsFirstRun(kv, 'p-new')).toBe(true);
    expect(kv.getItem(KEYS.legacyTour)).toBe('done'); // read only
  });

  it("a legacyFromGuest profile with wildhaven-tour = '2' in a day-40 zoo with animals becomes 'done' (T7)", () => {
    const kv = new Mem();
    kv.setItem(KEYS.legacyTour, '2');
    writeTutorialState(kv, 'p1', { v: 1, status: 'never', readAloud: null, updatedAt: 5, legacyFromGuest: true });
    expect(legacyApplies(kv, 'p1')).toBe(true);
    const out = migrateLegacyTour(kv, 'p1', { day: 40, animals: 6 }, 1000);
    expect(out).toEqual({ status: 'done', passed: null });
    const st = readTutorialState(kv, 'p1');
    expect(st.status).toBe('done');
    expect(st.legacyFromGuest).toBeUndefined(); // runs once
    expect(legacyApplies(kv, 'p1')).toBe(false);
    expect(tutorialDone(kv, 'p1')).toBe(true);
  });

  it("'2' in a young zoo with no animals continues as a migrated tutorial (camera steps and paint passed)", () => {
    const kv = new Mem();
    kv.setItem(KEYS.legacyTour, '2');
    const out = migrateLegacyTour(kv, 'guest', { day: 1, animals: 0 });
    expect(out?.status).toBe('running');
    expect(out?.passed).toEqual(['look-pan', 'look-zoom', 'look-turn', 'paint']);
    expect(readTutorialState(kv, 'guest').status).toBe('running');
    // the guest's state now exists: the legacy key never applies again
    expect(legacyApplies(kv, 'guest')).toBe(false);
    expect(legacyOutcome('0', { day: 2, animals: 0 }).passed).toEqual(['look-pan', 'look-zoom', 'look-turn', 'play', 'guests']);
    expect(legacyOutcome('3', { day: 3, animals: 0 })).toEqual({ status: 'done', passed: null });
    expect(legacyOutcome('1', { day: 1, animals: 1 })).toEqual({ status: 'done', passed: null });
  });

  it('the legacy mapping: done → done; no key + animals → done; no key + no animals → never', () => {
    expect(legacyOutcome('done', { day: 1, animals: 0 })).toEqual({ status: 'done', passed: null });
    expect(legacyOutcome(null, { day: 9, animals: 3 })).toEqual({ status: 'done', passed: null });
    expect(legacyOutcome(null, { day: 1, animals: 0 })).toEqual({ status: 'never', passed: null });
    expect(legacyOutcome('banana', { day: 1, animals: 0 })).toEqual({ status: 'never', passed: null });
    const kv = new Mem();
    expect(migrateLegacyTour(kv, 'guest', { day: 1, animals: 0 })).toEqual({ status: 'never', passed: null });
    expect(kv.getItem(KEYS.guestTutorial)).not.toBeNull();
  });

  it('status only moves up: done beats skipped beats running beats never', () => {
    expect(nextStatus('never', 'running')).toBe('running');
    expect(nextStatus('skipped', 'running')).toBe('skipped');
    expect(nextStatus('running', 'skipped')).toBe('skipped');
    expect(nextStatus('done', 'skipped')).toBe('done');
    expect(nextStatus('skipped', 'done')).toBe('done');
    const kv = new Mem();
    setStatus(kv, 'guest', 'running', 10);
    setStatus(kv, 'guest', 'skipped', 20);
    expect(readTutorialState(kv, 'guest').status).toBe('skipped');
    expect(wantsFirstRun(kv, 'guest')).toBe(false);
    setStatus(kv, 'guest', 'done', 30);
    expect(readTutorialState(kv, 'guest')).toMatchObject({ status: 'done', updatedAt: 30 });
  });

  it('read-aloud is on by default when a voice exists, and a choice is kept per player', () => {
    const kv = new Mem();
    expect(readAloudOn(readTutorialState(kv, 'guest'), true)).toBe(true);
    expect(readAloudOn(readTutorialState(kv, 'guest'), false)).toBe(false);
    setReadAloud(kv, 'guest', false, 100);
    expect(readAloudOn(readTutorialState(kv, 'guest'), true)).toBe(false);
    expect(readTutorialState(kv, 'p2').readAloud).toBeNull();
    setReadAloud(kv, 'p2', true, 100);
    expect(readTutorialState(kv, 'p2').readAloud).toBe(true);
    expect(readTutorialState(kv, 'guest').readAloud).toBe(false);
  });

  it('an escaped animal never regresses adopt (T5)', () => {
    const m = new TutorialMachine({ versusEnabled: false });
    m.start('first', 0);
    m.begin(0);
    m.debugPassBefore('path');
    const base: Facts = {
      habitats: 1, habitatIds: [3], plotHabitat: 3, gap: null, hasWater: true, hasShelter: true, plantIn: true, plantOut: false,
      animals: 1, animalsInHabitat: 1, animal: { id: 5, speciesId: 'zebra', happiness: 0.7, x: 0, z: 0 }, gateOpen: false,
      keeper: false, kiosk: false, bench: false, bin: false, speed: 0, isOpen: true, day: 1, money: 50000, guestIn: false, versus: false,
      category: null, tool: { kind: 'select' }, moving: false, pending: null, sheet: null, sheetOpen: false, zooOpen: false, zooTab: null,
      dialog: false, pointer: 'touch', now: 0, hint: null,
    };
    expect(m.tick(base).step).toBe('path');
    // the zebra walked out of an opened fence: it still exists, escaped
    const v = m.tick({ ...base, animalsInHabitat: 0, habitats: 0, habitatIds: [], gap: { edges: [{ dir: 'h', x: 40, z: 60 }], fenceId: 1 } });
    expect(m.passed.has('adopt')).toBe(true);
    expect(v.step).toBe('fence'); // the gap is what needs fixing
    expect(v.line).toBe('fence.gap');
    // fixed: straight back to the path step, never via adopt
    expect(m.tick(base).step).toBe('path');
    // only when no animal exists at all does adopt come back
    expect(m.tick({ ...base, animals: 0, animalsInHabitat: 0, animal: null }).step).toBe('adopt');
  });
});
