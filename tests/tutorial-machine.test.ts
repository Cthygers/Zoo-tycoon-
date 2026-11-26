// The tutorial's step machine with hand-made facts (tutorial.md §11.1): start, gestures, the
// clock hold, build steps on state, regress, events, Back / review, skip, persistence, versus.
import { describe, expect, it } from 'vitest';
import type { GestureSummary } from '../src/core/ui-ext';
import type { Facts } from '../src/ui/tutorial/facts';
import { HELP_AFTER_MS, parseBlob, TutorialMachine, type Effect } from '../src/ui/tutorial/machine';
import { STEP_IDS, type StepId } from '../src/ui/tutorial/script';

function facts(o: Partial<Facts> = {}): Facts {
  return {
    habitats: 0, habitatIds: [], plotHabitat: 0, gap: null, hasWater: false, hasShelter: false, plantIn: false, plantOut: false,
    animals: 0, animalsInHabitat: 0, animal: null, gateOpen: false, keeper: false, kiosk: false, bench: false, bin: false,
    speed: 0, isOpen: true, day: 1, money: 60000, guestIn: false, versus: false,
    category: null, tool: { kind: 'select' }, moving: false, pending: null, sheet: null, sheetOpen: false, zooOpen: false, zooTab: null, dialog: false, pointer: 'touch',
    now: 1000, hint: null,
    ...o,
  };
}
const g = (o: Partial<GestureSummary>): GestureSummary => ({ pan: 0, zoom: 0, turn: 0, tilt: 0, fingers: 1, tap: false, ...o });
const kinds = (e: Effect[], k: Effect['kind']) => e.filter((x) => x.kind === k);

/** A machine already running at `step` (everything before it passed). */
function at(step: StepId, f: Partial<Facts> = {}): { m: TutorialMachine; f: Facts } {
  const m = new TutorialMachine({ versusEnabled: false });
  m.start('first', 0);
  m.begin(0);
  m.debugPassBefore(step);
  const ff = facts(f);
  m.tick(ff);
  m.drain();
  return { m, f: ff };
}

/** The zoo as it is once every build step is done. */
// eslint-disable-next-line prefer-const
const builtAll: Partial<Facts> = {
  habitats: 1, habitatIds: [3], plotHabitat: 3, hasWater: true, hasShelter: true, plantIn: true, animals: 1, animalsInHabitat: 1,
  animal: { id: 5, speciesId: 'zebra', happiness: 0.7, x: 80, z: 120 }, gateOpen: true, keeper: true, kiosk: true, bench: true, bin: true,
};
const built = builtAll;

describe('tutorial machine', () => {
  it('starts with the welcome card, holds the clock and marks the profile running', () => {
    const m = new TutorialMachine({ versusEnabled: false });
    m.start('first', 0);
    expect(m.status).toBe('welcome');
    const e = m.drain();
    expect(kinds(e, 'clock')).toEqual([{ kind: 'clock', mode: 'hold' }]);
    expect(kinds(e, 'profile')).toEqual([{ kind: 'profile', status: 'running' }]);
    expect(m.blob()?.welcome).toBe(true);
    m.begin(10);
    const v = m.tick(facts({ now: 20 }));
    expect(v.step).toBe('look-pan');
    expect(v.line).toBe('look-pan.touch');
    expect(v.text).toEqual({ a: 'Drag one finger.', w: 'Slide it across the screen to look around.' });
    expect(m.blob()?.step).toBe('look-pan');
    const e2 = m.drain();
    expect(e2).toContainEqual({ kind: 'emit', step: 'look-pan', chapter: 1, state: 'start' });
    expect(e2).toContainEqual({ kind: 'clock', mode: 'hold' });
  });

  it('gestures: one-finger pans add up, one-finger drags never zoom, small pinches add up', () => {
    const { m } = at('look-pan');
    for (let i = 0; i < 2; i++) m.note({ kind: 'gesture', g: g({ pan: 50 }) });
    expect(m.tick(facts()).step).toBe('look-pan');
    m.note({ kind: 'gesture', g: g({ pan: 50 }) });
    expect(m.tick(facts()).step).toBe('look-zoom');
    for (let i = 0; i < 5; i++) m.note({ kind: 'gesture', g: g({ pan: 200 }) });
    const v = m.tick(facts());
    expect(v.step).toBe('look-zoom');
    expect(v.line).toBe('look-zoom.oneFinger');
    for (let i = 0; i < 3; i++) m.note({ kind: 'gesture', g: g({ zoom: 0.1, fingers: 2 }) });
    expect(m.tick(facts()).step).toBe('look-zoom');
    m.note({ kind: 'gesture', g: g({ zoom: 0.1, fingers: 2 }) });
    expect(m.tick(facts()).step).toBe('look-turn');
    m.note({ kind: 'gesture', g: g({ zoom: 0.3, fingers: 2 }) });
    expect(m.tick(facts()).line).toBe('look-turn.noTwist');
    m.note({ kind: 'gesture', g: g({ turn: 25, fingers: 2 }) });
    expect(m.tick(facts()).step).toBe('fence');
  });

  it('a tap on look-pan says keep the finger down; mouse players get mouse lines', () => {
    const { m } = at('look-pan');
    m.note({ kind: 'gesture', g: g({ tap: true }) });
    expect(m.tick(facts()).line).toBe('look-pan.tap');
    expect(m.tick(facts({ pointer: 'mouse' })).line).toBe('look-pan.mouse');
  });

  it('Help me shows after 3 unfinished gestures, and helping passes a camera step', () => {
    const { m } = at('look-zoom');
    m.note({ kind: 'gesture', g: g({ pan: 30 }) });
    m.note({ kind: 'gesture', g: g({ pan: 30 }) });
    expect(m.tick(facts()).buttons.help).toBe(false);
    m.note({ kind: 'gesture', g: g({ pan: 30 }) });
    expect(m.tick(facts()).buttons.help).toBe(true);
    m.note({ kind: 'helped' });
    expect(m.drain()).toContainEqual({ kind: 'emit', step: 'look-zoom', chapter: 1, state: 'help' });
    expect(m.tick(facts()).step).toBe('look-turn');
  });

  it('clock: hold steps hold it, play releases it, and after play a regress never holds again', () => {
    const { m } = at('keeper', { ...built, keeper: false });
    m.tick(facts({ ...built }));
    const e = m.drain();
    expect(e).toContainEqual({ kind: 'clock', mode: 'release' }); // entering 'play'
    expect(m.tick(facts({ ...built })).step).toBe('play');
    expect(m.tick(facts({ ...built, speed: 1 })).step).toBe('guests');
    m.drain();
    // the animal is sold: back to adopt, but the clock stays free
    const v = m.tick(facts({ ...built, speed: 1, animals: 0, animalsInHabitat: 0, animal: null }));
    expect(v.step).toBe('adopt');
    expect(v.line).toBe('adopt.regress');
    expect(kinds(m.drain(), 'clock')).toEqual([{ kind: 'clock', mode: 'release' }]);
  });

  it('fence: done on a habitat, the plot one is remembered, the tool is put away; a lost habitat regresses', () => {
    const { m } = at('fence');
    m.plot = { x0: 39, z0: 60, x1: 46, z1: 67 };
    expect(m.tick(facts({ category: 'habitats' })).phase).toBe('pick');
    expect(m.tick(facts({ tool: { kind: 'fence', fenceId: 1 } })).phase).toBe('use');
    const v = m.tick(facts({ habitats: 2, habitatIds: [2, 7], plotHabitat: 7 }));
    expect(v.step).toBe('paint');
    expect(m.homeHabitat).toBe(7);
    const e = m.drain();
    expect(e).toContainEqual({ kind: 'endTool' });
    expect(kinds(e, 'pop').length).toBe(1);
    m.note({ kind: 'painted', inHabitat: true });
    expect(m.tick(facts({ habitats: 1, habitatIds: [7], plotHabitat: 7 })).step).toBe('water');
    // bulldozed: back to the fence, its regress line; rebuilt → straight back to water
    const r = m.tick(facts({ habitats: 0 }));
    expect(r.step).toBe('fence');
    expect(r.line).toBe('fence.regress');
    expect(r.text?.a).toBe('Tap Habitat.');
    expect(m.tick(facts({ habitats: 1, habitatIds: [9], plotHabitat: 9 })).step).toBe('water');
  });

  it('a fence gap (open enclosure) shows the gap line and the marker on the missing edge (T5)', () => {
    const { m } = at('paint', { habitats: 1, habitatIds: [3] });
    const gap = { edges: [{ dir: 'v' as const, x: 39, z: 63 }], fenceId: 1 };
    const v = m.tick(facts({ habitats: 0, gap }));
    expect(v.step).toBe('fence');
    expect(v.line).toBe('fence.gap');
    expect(v.text).toEqual({ a: 'Fix the fence gap.', w: 'Use the fence tool on the yellow mark.' });
  });

  it('paint: outside the fence is not done and says so; inside is done', () => {
    const { m } = at('paint', { habitats: 1, habitatIds: [3] });
    m.note({ kind: 'painted', inHabitat: false });
    const v = m.tick(facts({ habitats: 1, habitatIds: [3] }));
    expect(v.step).toBe('paint');
    expect(v.line).toBe('paint.outside');
    m.note({ kind: 'painted', inHabitat: true });
    expect(m.tick(facts({ habitats: 1, habitatIds: [3] })).step).toBe('water');
  });

  it('water accepts a pond; the plant step wants a new plant inside a habitat', () => {
    const base = { habitats: 1, habitatIds: [3] };
    const { m } = at('water', base);
    expect(m.tick(facts({ ...base, hasWater: true })).step).toBe('shelter');
    expect(m.tick(facts({ ...base, hasWater: true, hasShelter: true })).step).toBe('plant');
    const v = m.tick(facts({ ...base, hasWater: true, hasShelter: true, plantOut: true }));
    expect(v.step).toBe('plant');
    expect(v.line).toBe('plant.outside');
    expect(m.tick(facts({ ...base, hasWater: true, hasShelter: true, plantOut: true, plantIn: true })).step).toBe('adopt');
  });

  it('adopt: any species, its noun in later lines; selling it regresses', () => {
    const base = { ...built, animals: 0, animalsInHabitat: 0, animal: null, gateOpen: false };
    const { m } = at('adopt', base);
    const v = m.tick(facts({ ...base, animals: 1, animalsInHabitat: 1, animal: { id: 4, speciesId: 'polarbear', happiness: 0.4, x: 0, z: 0 } }));
    expect(v.step).toBe('happy');
    expect(v.text?.a).toBe('Tap your polar bear.');
    expect(m.speciesId).toBe('polarbear');
    const r = m.tick(facts({ ...base }));
    expect(r.step).toBe('adopt');
    expect(r.text).toEqual({ a: 'Tap Animals.', w: 'Your animal left. Adopt a new one.' });
  });

  it('an escaped animal never sends the child back to adopt (T5)', () => {
    const { m } = at('path', built);
    expect(m.current).toBe('play');
    // the zebra got out: no animal in a habitat, the gate shuts — nothing goes back to adopt or path
    const v = m.tick(facts({ ...built, animalsInHabitat: 0, gateOpen: false }));
    expect(v.step).toBe('play');
    expect(m.passed.has('adopt')).toBe(true);
    expect(m.passed.has('path')).toBe(true);
  });

  it('happy: Got it only counts with the sheet shown; another sheet says close it; closing after 1.5 s counts', () => {
    const built = { ...builtAll, gateOpen: false };
    const { m } = at('happy', built);
    m.note({ kind: 'gotIt' });
    expect(m.tick(facts({ ...built, now: 1000 })).step).toBe('happy');
    const o = m.tick(facts({ ...built, sheet: { kind: 'object', id: 2 }, sheetOpen: true, now: 1100 }));
    expect(o.line).toBe('happy.other');
    const s = m.tick(facts({ ...built, sheet: { kind: 'animal', id: 5 }, sheetOpen: true, now: 1200 }));
    expect(s.line).toBe('happy.sheet');
    expect(s.buttons.gotIt).toBe(true);
    expect(s.target).toEqual({ kind: 'sheetMeter' });
    expect(m.tick(facts({ ...built, now: 1500 })).step).toBe('happy'); // closed after 0.3 s
    m.tick(facts({ ...built, sheet: { kind: 'animal', id: 5 }, sheetOpen: true, now: 2000 }));
    expect(m.tick(facts({ ...built, now: 3600 })).step).toBe('path');
  });

  it('happy: a sad animal gets the friends-and-food line; Got it on the sheet completes', () => {
    const sad = { ...built, gateOpen: false, animal: { id: 5, speciesId: 'zebra', happiness: 0.3, x: 0, z: 0 } };
    const { m } = at('happy', sad);
    expect(m.tick(facts({ ...sad, sheet: { kind: 'animal', id: 5 }, sheetOpen: true })).line).toBe('happy.sheetLow');
    m.note({ kind: 'gotIt' });
    expect(m.tick(facts({ ...sad, sheet: { kind: 'animal', id: 5 }, sheetOpen: true })).step).toBe('path');
  });

  it('path: done when the gate opens; a path that does not join says so; a shut gate later regresses it', () => {
    const base = { ...built, gateOpen: false, kiosk: false, bench: false, bin: false, keeper: false };
    const { m } = at('path', base);
    m.note({ kind: 'pathBuilt' });
    m.tick(facts({ ...base, now: 1400 }));
    const v = m.tick(facts({ ...base, now: 1500 }));
    expect(v.line).toBe('path.notConnected');
    expect(m.tick(facts({ ...base, gateOpen: true })).step).toBe('kiosk');
    const r = m.tick(facts({ ...base, gateOpen: false }));
    expect(r.step).toBe('path');
    expect(r.line).toBe('path.regress');
  });

  it('guests: Play first, then a guest walking in; paused > 3 s says Tap Play (T4)', () => {
    const { m } = at('play', built);
    expect(m.tick(facts({ ...built, speed: 0 })).target).toEqual({ kind: 'speed', s: [1] });
    expect(m.tick(facts({ ...built, speed: 1, now: 2000 })).step).toBe('guests');
    expect(m.tick(facts({ ...built, speed: 0, now: 2100 })).line).toBe('guests.main');
    const p = m.tick(facts({ ...built, speed: 0, now: 5200 }));
    expect(p.line).toBe('clock.paused');
    expect(p.text).toEqual({ a: 'Tap Play.', w: 'Time must run for this step.' });
    expect(m.tick(facts({ ...built, speed: 1, now: 5300, guestIn: true })).step).toBe('money');
  });

  it('money: the Finances tab shown and then closed completes it; closing without Finances does not', () => {
    const { m } = at('money', { ...built, speed: 1 });
    m.note({ kind: 'zooShown', tab: 'goals' });
    expect(m.tick(facts({ ...built, speed: 1, zooOpen: true, zooTab: 'goals' })).line).toBe('money.otherTab');
    m.note({ kind: 'zooClosed' });
    expect(m.tick(facts({ ...built, speed: 1 })).step).toBe('money');
    m.note({ kind: 'zooShown', tab: 'finance' });
    expect(m.tick(facts({ ...built, speed: 1, zooOpen: true, zooTab: 'finance' })).line).toBe('money.finance');
    m.note({ kind: 'zooClosed' });
    const v = m.tick(facts({ ...built, speed: 1 }));
    expect(v.step).toBe('goal');
    expect(v.pillStep).toBe(false); // the pill shows its goal form: it is the target
    m.note({ kind: 'pillTapped' });
    expect(m.tick(facts({ ...built, speed: 1 })).step).toBe('speed');
    expect(m.tick(facts({ ...built, speed: 3 })).step).toBe('speed-note');
  });

  it('speed note: offline and versus lines; Got it finishes the tutorial', () => {
    const { m } = at('speed-note', { ...built, speed: 3 });
    expect(m.tick(facts({ ...built, speed: 3 })).line).toBe('speed-note.offline');
    m.note({ kind: 'gotIt' });
    const v = m.tick(facts({ ...built, speed: 3 }));
    expect(v.status).toBe('finish');
    const e = m.drain();
    expect(e).toContainEqual({ kind: 'profile', status: 'done' });
    expect(e).toContainEqual({ kind: 'emit', step: 'finish', chapter: 12, state: 'finish' });
    expect(m.blob()).toBeNull();
    const vs = new TutorialMachine({ versusEnabled: true });
    vs.start('first', 0);
    vs.begin(0);
    vs.debugPassBefore('speed-note');
    expect(vs.tick(facts({ ...built, speed: 3 })).text?.w).toBe('In Versus matches, time always runs fast. No pausing!');
  });

  it('Back shows the previous line with Next; the step completing during review ends it', () => {
    const { m } = at('paint', { habitats: 1, habitatIds: [3] });
    m.note({ kind: 'back' });
    let v = m.tick(facts({ habitats: 1, habitatIds: [3] }));
    expect(v.review).toBe(true);
    expect(v.step).toBe('fence');
    expect(v.line).toBe('fence.open');
    expect(v.buttons.next).toBe(true);
    m.note({ kind: 'back' });
    expect(m.tick(facts({ habitats: 1, habitatIds: [3] })).step).toBe('look-turn');
    m.note({ kind: 'next' });
    m.note({ kind: 'next' });
    v = m.tick(facts({ habitats: 1, habitatIds: [3] }));
    expect(v.review).toBe(false);
    expect(v.step).toBe('paint');
    m.note({ kind: 'back' });
    m.note({ kind: 'painted', inHabitat: true });
    v = m.tick(facts({ habitats: 1, habitatIds: [3] }));
    expect(v.review).toBe(false);
    expect(v.step).toBe('water');
  });

  it('skip: off, profile skipped, clock released, skip event', () => {
    const { m } = at('paint', { habitats: 1, habitatIds: [3] });
    m.skip();
    expect(m.status).toBe('off');
    const e = m.drain();
    expect(e).toContainEqual({ kind: 'profile', status: 'skipped' });
    expect(e).toContainEqual({ kind: 'clock', mode: 'release' });
    expect(e).toContainEqual({ kind: 'emit', step: 'paint', chapter: 3, state: 'skip' });
    expect(m.blob()).toBeNull();
  });

  it('persistence: blob → a new machine resumes at the same step with the same passed steps and one resume line', () => {
    const { m } = at('water', { habitats: 1, habitatIds: [3] });
    m.note({ kind: 'gesture', g: g({ pan: 10 }) });
    const blob = JSON.parse(JSON.stringify(m.blob()));
    expect(parseBlob(blob)?.step).toBe('water');
    const n = new TutorialMachine({ versusEnabled: false });
    expect(n.resume(blob, 50_000)).toBe(true);
    const v = n.tick(facts({ habitats: 1, habitatIds: [3], now: 50_100 }));
    expect(v.step).toBe('water');
    expect(v.line).toBe('nudge.resume');
    expect(v.text?.w).toBe("Welcome back! Let's keep going.");
    expect([...n.passed].sort()).toEqual(['fence', 'look-pan', 'look-turn', 'look-zoom', 'paint']);
    expect(n.tick(facts({ habitats: 1, habitatIds: [3], now: 60_000 })).line).toBe('water.open');
    expect(n.resume({ v: 2 }, 0)).toBe(false);
    expect(n.resume(null, 0)).toBe(false);
  });

  it('steps already done on entry pass quietly (no pop), e.g. a bin built during the kiosk step', () => {
    const base = { ...built, keeper: false };
    const { m } = at('kiosk', { ...base, kiosk: false, bench: false, bin: true });
    m.drain();
    m.tick(facts({ ...base, kiosk: true, bench: true, bin: true }));
    const e = m.drain();
    expect(kinds(e, 'pop').length).toBe(1); // kiosk was on show; bench and bin passed on entry
    expect(m.current).toBe('keeper');
  });

  it('the locked speed nudge shows for 3 s and counts as an attempt; 60 s without progress offers help', () => {
    const { m } = at('fence', { now: 1000 });
    m.note({ kind: 'speedLocked' });
    const v = m.tick(facts({ now: 1500 }));
    expect(v.line).toBe('nudge.speedLocked');
    expect(v.text?.a).toBe('Keep building first.');
    expect(m.tick(facts({ now: 4500 })).line).toBe('fence.open');
    expect(m.tick(facts({ now: 1000 + HELP_AFTER_MS + 10 })).buttons.help).toBe(true);
  });

  it('a wrong category nudges to the right dock label', () => {
    const { m } = at('water', { habitats: 1, habitatIds: [3] });
    const v = m.tick(facts({ habitats: 1, habitatIds: [3], category: 'paths' }));
    expect(v.line).toBe('nudge.wrongCat');
    expect(v.text?.a).toBe('Tap Care first.');
    expect(v.target).toEqual({ kind: 'cat', id: 'animalfac' });
  });

  it('runs every step in script order', () => {
    expect(STEP_IDS.length).toBe(21);
  });
});
