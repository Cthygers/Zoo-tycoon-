// The tutorial's script: 12 chapters, 21 one-action steps (tutorial.md §3, spec §6.2).
// Pure data + small pure helpers (no DOM): every sentence the tutorial shows or reads aloud
// lives in LINES, so the overlay, read-aloud and the copy lint (tests/tutorial-copy.test.ts)
// all use one table.
//
// Every bubble has two tiers: a large ACTION line (2–5 words, starts with a verb, names the
// button or card) and an optional WHY line (≤ 10 words). {animal} / {animals} / {Animals}
// are the adopted species' short noun ("zebra" until one is adopted), {Cat} a dock label.

import { OBJECTS_BY_ID } from '../../data/objects';
import type { Tool } from '../../core/types';
import type { PendingInfo } from '../../core/ui-ext';

export type StepId =
  | 'look-pan' | 'look-zoom' | 'look-turn'
  | 'fence' | 'paint' | 'water' | 'shelter' | 'plant'
  | 'adopt' | 'happy' | 'path' | 'kiosk' | 'bench' | 'bin' | 'keeper'
  | 'play' | 'guests' | 'money' | 'goal' | 'speed' | 'speed-note';

export const STEP_IDS: readonly StepId[] = [
  'look-pan', 'look-zoom', 'look-turn',
  'fence', 'paint', 'water', 'shelter', 'plant',
  'adopt', 'happy', 'path', 'kiosk', 'bench', 'bin', 'keeper',
  'play', 'guests', 'money', 'goal', 'speed', 'speed-note',
];

export function isStepId(s: unknown): s is StepId {
  return typeof s === 'string' && (STEP_IDS as readonly string[]).includes(s);
}

/** Chapter titles (chapter n = CHAPTERS[n - 1]); 12 is the finish card. */
export const CHAPTERS = [
  'Look around', 'Build a habitat', 'Paint the ground', 'Make it cosy', 'Adopt an animal', 'Make a path',
  'Food, seats and bins', 'Hire a keeper', 'Open your zoo', 'Money and goals', 'Speed up time', 'You did it!',
] as const;
export const CHAPTER_COUNT = CHAPTERS.length;

/** One bubble: the action line and the why line. */
export interface Line {
  a: string;
  w?: string;
}

// --------------------------------------------------------------------------- copy
// Key = `<step or group>.<phase>`; the lint reads the phase from the key.
export const LINES = {
  // chapter 1: look around (touch / mouse)
  'look-pan.touch': { a: 'Drag one finger.', w: 'Slide it across the screen to look around.' },
  'look-pan.mouse': { a: 'Drag with the mouse.', w: 'Slide around your zoo.' },
  'look-pan.tap': { a: 'Keep your finger down.', w: 'Then slide it slowly.' },
  'look-zoom.touch': { a: 'Pinch two fingers apart.', w: 'This zooms in close.' },
  'look-zoom.mouse': { a: 'Roll the mouse wheel.', w: 'This zooms in and out.' },
  'look-zoom.oneFinger': { a: 'Use two fingers together.', w: 'Like the hand shows.' },
  'look-turn.touch': { a: 'Twist two fingers.', w: 'Turn them like a key.' },
  'look-turn.mouse': { a: 'Hold the right button.', w: 'Then drag to turn around.' },
  'look-turn.noTwist': { a: 'Turn both fingers round.', w: 'Keep them on the screen.' },
  // chapter 2: fence
  'fence.open': { a: 'Tap Habitat.', w: 'Animals need a home with a fence.' },
  'fence.pick': { a: 'Tap Timber Rail Fence.', w: 'It is great for zebras.' },
  'fence.use': { a: 'Drag across the yellow box.', w: 'Go from one corner to the other.' },
  'fence.useAny': { a: 'Drag across open grass.', w: 'Go from one corner to the other.' },
  'fence.confirm': { a: 'Tap Build.', w: 'Your fence goes up.' },
  'fence.invalid': { a: 'Try the yellow box.', w: 'That fence will not close.' },
  'fence.gap': { a: 'Fix the fence gap.', w: 'Use the fence tool on the yellow mark.' },
  'fence.regress': { a: 'Tap Habitat.', w: "Let's build the fence again." },
  // chapter 3: paint
  'paint.open': { a: 'Tap Habitat.', w: 'Zebras love dry savanna grass.' },
  'paint.pick': { a: 'Tap Savanna Grass.', w: "It is the zebras' favourite ground." },
  'paint.use': { a: 'Drag inside your fence.', w: 'Paint the ground in the yellow box.' },
  'paint.confirm': { a: 'Tap Paint.', w: 'The ground changes colour.' },
  'paint.outside': { a: 'Paint inside the fence.', w: 'That was outside the fence.' },
  // chapter 4: make it cosy
  'water.open': { a: 'Tap Care.', w: 'Animals get thirsty.' },
  'water.pick': { a: 'Tap Water Trough.', w: 'So they can drink.' },
  'water.use': { a: 'Tap the yellow spot.', w: 'Put the trough inside the fence.' },
  'water.confirm': { a: 'Tap Build.', w: 'The water trough goes there.' },
  'shelter.open': { a: 'Tap Care.', w: 'Zebras like shade.' },
  'shelter.pick': { a: 'Tap Timber Shelter.', w: 'It keeps off sun and rain.' },
  'shelter.use': { a: 'Tap the yellow spot.', w: 'The shelter goes inside the fence.' },
  'shelter.confirm': { a: 'Tap Build.', w: 'Great spot for a shelter!' },
  'plant.open': { a: 'Tap Nature.', w: 'Zebras love tall grass.' },
  'plant.pick': { a: 'Tap Tall Grass.', w: 'It makes zebras feel at home.' },
  'plant.use': { a: 'Tap the yellow spot.', w: 'Plant it inside the fence.' },
  'plant.confirm': { a: 'Tap Build.', w: 'You can add more later.' },
  'plant.outside': { a: 'Plant one inside the fence.', w: 'Pretty! Now one for the zebras.' },
  'spot.invalid': { a: 'Try the yellow spot.', w: 'That spot will not work.' },
  // chapter 5: adopt, happy
  'adopt.open': { a: 'Tap Animals.', w: 'Your habitat is ready!' },
  'adopt.pick': { a: 'Tap Plains Zebra.', w: 'Its card shows what it needs.' },
  'adopt.use': { a: 'Tap inside your fence.', w: 'That lets the zebra in.' },
  'adopt.confirm': { a: 'Tap Adopt.', w: 'Welcome your first zebra home!' },
  'adopt.weak': { a: 'Try the zebra.', w: 'That animal needs a stronger fence.' },
  'adopt.regress': { a: 'Tap Animals.', w: 'Your animal left. Adopt a new one.' },
  'happy.tap': { a: 'Tap your {animal}.', w: 'See how happy it is.' },
  'happy.sheet': { a: 'Tap Got it.', w: 'Green on the heart bar means happy!' },
  'happy.sheetLow': { a: 'Tap Got it.', w: 'Friends and food make it happier.' },
  'happy.other': { a: 'Tap X to close.', w: 'Then tap your {animal}.' },
  // chapter 6: path
  'path.open': { a: 'Tap Paths.', w: 'Guests walk on paths.' },
  'path.pick': { a: 'Tap Stone Pavers.', w: 'The same as the main path.' },
  'path.use': { a: 'Drag along the yellow tiles.', w: 'Start at the grey path.' },
  'path.confirm': { a: 'Tap Build.', w: 'Now guests can walk up to see!' },
  'path.notConnected': { a: 'Join the paths up.', w: 'It must touch the grey path and fence.' },
  'path.regress': { a: 'Tap Paths.', w: 'The path to your {animal} is gone.' },
  // chapter 7: food, seats and bins
  'kiosk.open': { a: 'Tap Guests.', w: 'Guests get hungry.' },
  'kiosk.pick': { a: 'Tap Snack Kiosk.', w: 'Guests buy food there.' },
  'kiosk.use': { a: 'Tap the yellow box.', w: 'Right next to the path.' },
  'kiosk.confirm': { a: 'Tap Build.', w: 'Yum! Your snack kiosk opens.' },
  'kiosk.invalid': { a: 'Try the yellow box.', w: 'Shops must touch a path.' },
  'bench.open': { a: 'Tap Guests.', w: 'Tired guests need seats.' },
  'bench.pick': { a: 'Tap Park Bench.', w: 'So guests can rest.' },
  'bench.use': { a: 'Tap the yellow spot.', w: 'Right beside the path.' },
  'bench.confirm': { a: 'Tap Build.', w: 'Guests will love it!' },
  'bin.open': { a: 'Tap Guests.', w: 'Litter goes in bins.' },
  'bin.pick': { a: 'Tap Litter Bin.', w: 'Clean paths make guests happy.' },
  'bin.use': { a: 'Tap the yellow spot.', w: 'Right beside the path.' },
  'bin.confirm': { a: 'Tap Build.', w: 'No more litter on the paths!' },
  // chapter 8: keeper
  'keeper.open': { a: 'Tap Staff.', w: '{Animals} need food every day.' },
  'keeper.pick': { a: 'Tap Animal Keeper.', w: 'Keepers feed and clean up.' },
  'keeper.use': { a: 'Tap the yellow path tile.', w: 'Near your {animal}.' },
  'keeper.confirm': { a: 'Tap Hire.', w: 'Your keeper starts work now!' },
  'keeper.invalid': { a: 'Tap the yellow tile.', w: 'Keepers start on a path.' },
  'keeper.regress': { a: 'Tap Staff.', w: 'Your keeper has gone.' },
  // chapter 9: open your zoo
  'play.main': { a: 'Tap Play.', w: 'Everything is ready. Start the day!' },
  'guests.main': { a: 'Watch the gate.', w: 'Here come your first guests!' },
  'guests.shut': { a: 'Tap Paths.', w: 'Guests need a path to your {animal}.' },
  'guests.closed': { a: 'Let time run.', w: 'The zoo opens at 8 in the morning.' },
  'clock.paused': { a: 'Tap Play.', w: 'Time must run for this step.' },
  // chapter 10: money and goals
  'money.hud': { a: 'Tap your money.', w: 'Guests pay to come in.' },
  'money.finance': { a: 'Tap X to close.', w: 'This page shows money in and out.' },
  'money.otherTab': { a: 'Tap Finances.', w: 'It is on the left.' },
  'goal.main': { a: 'Tap the next goal.', w: 'It gives you a hint.' },
  // chapter 11: speed
  'speed.main': { a: 'Tap the fast arrows.', w: 'Time goes quicker.' },
  'speed-note.versus': { a: 'Tap Got it.', w: 'In Versus matches, time always runs fast. No pausing!' },
  'speed-note.offline': { a: 'Tap Got it.', w: 'Tap pause any time you need a break.' },
  // generic
  'nudge.wrongCat': { a: 'Tap {Cat} first.', w: "Let's do that later." },
  'nudge.otherSheet': { a: 'Tap X to close.', w: 'Then carry on.' },
  'nudge.speedLocked': { a: 'Keep building first.', w: 'Time waits while you build.' },
  'nudge.noMoney': { a: 'Let time run.', w: 'You need more money first.' },
  'nudge.resume': { a: 'Keep going!', w: "Welcome back! Let's keep going." },
} as const satisfies Record<string, Line>;

export type LineKey = keyof typeof LINES;

/** Short success pops (not instructions: not held to the action-line rules). */
export const POPS = ['Great!', 'Nice work!', 'Super!'] as const;
export const HELP_POP = 'Your turn next time!';

/** Words on the tutorial's own buttons. */
export const BUTTONS = {
  letsGo: "Let's go",
  skipLink: 'Skip',
  gotIt: 'Got it',
  next: 'Next',
  back: 'Back',
  helpMe: 'Help me',
  skipStep: 'Skip this step',
  keepPlaying: 'Keep playing',
  backToMyZoo: 'Back to my zoo',
  keepPlayingHere: 'Keep playing here',
  playTutorial: 'Play tutorial',
} as const;

/** Card, dialog and Settings copy. */
export const CARDS = {
  welcomeTitle: 'Welcome to Wildhaven!',
  welcomeTitleNamed: 'Hi {name}!',
  welcomeText: "Let's build your very first zoo together.",
  welcomePractice: 'This is a practice zoo. Your own zoo is safe.',
  finishTitle: 'You did it!',
  finishHappy: 'Your zoo is open and your {animal} is happy.',
  finishGuests: 'Your zoo is open and your guests are coming.',
  tryFriends: 'Adopt {n} more {animals} so yours has friends.',
  tryMore: 'Adopt more animals and fill your zoo with life.',
  tryRestrooms: 'Build restrooms so guests stay longer and smile.',
  tryVersus: 'Challenge a friend in Versus to build the best zoo.',
  tryGoal: 'Follow the Next goal at the top for more ideas.',
  skipTitle: 'Stop learning?',
  skipText: 'You can learn again any time.',
  skipOk: 'Skip',
  skipCancel: 'Keep learning',
  practiceTitle: 'Play the tutorial?',
  practiceText: 'You get a practice zoo. Your own zoo stays safe.',
  practiceOk: 'Start',
  practiceCancel: 'Not now',
  settingsTutorial: 'Tutorial',
  settingsTutorialText: 'Learn the basics again in a practice zoo.',
  settingsAloud: 'Read tutorial aloud',
  settingsAloudText: 'A voice reads each tip out loud.',
  settingsPractice: 'Practice zoo',
  settingsPracticeText: 'Your own zoo is waiting for you.',
  learnChip: 'Learn to play',
} as const;

// --------------------------------------------------------------------------- nouns
/** Short nouns for {animal} / {animals}. Unknown species fall back to their id. */
export const NOUNS: Readonly<Record<string, { one: string; many: string }>> = {
  elephant: { one: 'elephant', many: 'elephants' },
  giraffe: { one: 'giraffe', many: 'giraffes' },
  zebra: { one: 'zebra', many: 'zebras' },
  lion: { one: 'lion', many: 'lions' },
  tiger: { one: 'tiger', many: 'tigers' },
  grizzly: { one: 'grizzly bear', many: 'grizzly bears' },
  polarbear: { one: 'polar bear', many: 'polar bears' },
  hippo: { one: 'hippo', many: 'hippos' },
  rhino: { one: 'rhino', many: 'rhinos' },
  gazelle: { one: 'gazelle', many: 'gazelles' },
  camel: { one: 'camel', many: 'camels' },
  gorilla: { one: 'gorilla', many: 'gorillas' },
  penguin: { one: 'penguin', many: 'penguins' },
  flamingo: { one: 'flamingo', many: 'flamingos' },
};

export function nounFor(speciesId: string | null | undefined): { one: string; many: string } {
  const id = speciesId || 'zebra';
  return NOUNS[id] ?? { one: id, many: `${id}s` };
}

export interface LineVars {
  speciesId?: string | null;
  cat?: string;
  name?: string | null;
  n?: number;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** Fill {animal} / {animals} / {Animals} / {Animal} / {Cat} / {name} / {n}. */
export function fill(text: string, v: LineVars = {}): string {
  const noun = nounFor(v.speciesId);
  return text
    .replace(/\{animal\}/g, noun.one)
    .replace(/\{animals\}/g, noun.many)
    .replace(/\{Animal\}/g, cap(noun.one))
    .replace(/\{Animals\}/g, cap(noun.many))
    .replace(/\{Cat\}/g, v.cat ?? '')
    .replace(/\{name\}/g, v.name ?? '')
    .replace(/\{n\}/g, v.n !== undefined ? NUMBER_WORDS[v.n] ?? String(v.n) : '');
}

/** A line with its variables filled in. */
export function lineFor(key: LineKey, v: LineVars = {}): Line {
  const l: Line = LINES[key];
  return { a: fill(l.a, v), w: l.w ? fill(l.w, v) : undefined };
}

// --------------------------------------------------------------------------- steps
/** Dock categories (src/ui/catalog.ts CategoryId) and their one-word dock labels. */
export const DOCK_LABEL: Readonly<Record<string, string>> = {
  habitats: 'Habitat',
  nature: 'Nature',
  animals: 'Animals',
  paths: 'Paths',
  guest: 'Guests',
  animalfac: 'Care',
  staff: 'Staff',
};

export type HandKind = 'tap' | 'drag' | 'pinch' | 'twist';

/** A build step: which dock button, which card, which tools count, which confirm verb. */
export interface BuildSpec {
  cat: string;
  card: string;
  cardName: string;
  verb: 'Build' | 'Paint' | 'Adopt' | 'Hire';
  accepts(t: Tool): boolean;
  /** A pending action that will not do the job → the nudge line, else null. */
  invalid?(p: PendingInfo): LineKey | null;
  hand: 'drag' | 'tap';
}

export type StepKind = 'gesture' | 'build' | 'select' | 'hud' | 'watch' | 'info';
export type ClockMode = 'hold' | 'release' | 'free';

export interface StepDef {
  id: StepId;
  chapter: number;
  kind: StepKind;
  build?: BuildSpec;
  clock: ClockMode;
  /** Re-checked after passing (fence, adopt, path, keeper): false sends the tutorial back here. */
  keeps: boolean;
}

const objDef = (t: Tool) => (t.kind === 'object' ? OBJECTS_BY_ID[t.defId] : undefined);
const spotInvalid = (p: PendingInfo): LineKey | null => (p.ok ? null : 'spot.invalid');

/** A pending fence that will not make a habitat (not ok, or the sim's "Not a habitat yet…" note). */
export function fenceWontClose(p: PendingInfo): boolean {
  return !p.ok || (p.note !== null && /not a habitat|won.?t close|stops being a habitat/i.test(p.note));
}

export const BUILD: Readonly<Partial<Record<StepId, BuildSpec>>> = {
  fence: {
    cat: 'habitats', card: 'fence:1', cardName: 'Timber Rail Fence', verb: 'Build', hand: 'drag',
    accepts: (t) => t.kind === 'fence',
    invalid: (p) => (fenceWontClose(p) ? 'fence.invalid' : null),
  },
  paint: {
    cat: 'habitats', card: 'terrain:1', cardName: 'Savanna Grass', verb: 'Paint', hand: 'drag',
    accepts: (t) => t.kind === 'terrain',
    invalid: spotInvalid,
  },
  water: {
    cat: 'animalfac', card: 'obj:water_trough', cardName: 'Water Trough', verb: 'Build', hand: 'tap',
    accepts: (t) => objDef(t)?.serves === 'water',
    invalid: spotInvalid,
  },
  shelter: {
    cat: 'animalfac', card: 'obj:shelter_wood', cardName: 'Timber Shelter', verb: 'Build', hand: 'tap',
    accepts: (t) => objDef(t)?.serves === 'shelter',
    invalid: spotInvalid,
  },
  plant: {
    cat: 'nature', card: 'obj:grass_tall', cardName: 'Tall Grass', verb: 'Build', hand: 'tap',
    accepts: (t) => {
      const c = objDef(t)?.category;
      return c === 'tree' || c === 'plant' || c === 'rock';
    },
    invalid: spotInvalid,
  },
  adopt: {
    cat: 'animals', card: 'animal:zebra', cardName: 'Plains Zebra', verb: 'Adopt', hand: 'tap',
    accepts: (t) => t.kind === 'animal',
    invalid: (p) => (p.risky && p.note && /fence/i.test(p.note) ? 'adopt.weak' : p.ok ? null : 'spot.invalid'),
  },
  path: {
    cat: 'paths', card: 'path:1', cardName: 'Stone Pavers', verb: 'Build', hand: 'drag',
    accepts: (t) => t.kind === 'path',
  },
  kiosk: {
    cat: 'guest', card: 'obj:shop_snack', cardName: 'Snack Kiosk', verb: 'Build', hand: 'tap',
    accepts: (t) => {
      const k = objDef(t)?.shop?.kind;
      return k === 'food' || k === 'drink' || k === 'icecream';
    },
    invalid: (p) => (p.ok ? null : 'kiosk.invalid'),
  },
  bench: {
    cat: 'guest', card: 'obj:bench', cardName: 'Park Bench', verb: 'Build', hand: 'tap',
    accepts: (t) => !!objDef(t)?.bench,
    invalid: spotInvalid,
  },
  bin: {
    cat: 'guest', card: 'obj:bin', cardName: 'Litter Bin', verb: 'Build', hand: 'tap',
    accepts: (t) => !!objDef(t)?.bin,
    invalid: spotInvalid,
  },
  keeper: {
    cat: 'staff', card: 'staff:keeper', cardName: 'Animal Keeper', verb: 'Hire', hand: 'tap',
    accepts: (t) => t.kind === 'staff' && t.role === 'keeper',
    invalid: (p) => (p.ok ? null : 'keeper.invalid'),
  },
};

const step = (id: StepId, chapter: number, kind: StepKind, clock: ClockMode, keeps = false): StepDef => ({
  id, chapter, kind, clock, keeps, build: BUILD[id],
});

export const STEPS: readonly StepDef[] = [
  step('look-pan', 1, 'gesture', 'hold'),
  step('look-zoom', 1, 'gesture', 'hold'),
  step('look-turn', 1, 'gesture', 'hold'),
  step('fence', 2, 'build', 'hold', true),
  step('paint', 3, 'build', 'hold'),
  step('water', 4, 'build', 'hold'),
  step('shelter', 4, 'build', 'hold'),
  step('plant', 4, 'build', 'hold'),
  step('adopt', 5, 'build', 'hold', true),
  step('happy', 5, 'select', 'hold'),
  step('path', 6, 'build', 'hold', true),
  step('kiosk', 7, 'build', 'hold'),
  step('bench', 7, 'build', 'hold'),
  step('bin', 7, 'build', 'hold'),
  step('keeper', 8, 'build', 'hold', true),
  step('play', 9, 'hud', 'release'),
  step('guests', 9, 'watch', 'free'),
  step('money', 10, 'hud', 'free'),
  step('goal', 10, 'hud', 'free'),
  step('speed', 11, 'hud', 'free'),
  step('speed-note', 11, 'info', 'free'),
];

export const STEP_BY_ID: Readonly<Record<StepId, StepDef>> = Object.fromEntries(STEPS.map((s) => [s.id, s])) as Record<StepId, StepDef>;

/** "Step 4 of 12" (chapter based). */
export function stepLabel(chapter: number, narrow = false): string {
  return narrow ? `${chapter}/${CHAPTER_COUNT}` : `Step ${chapter} of ${CHAPTER_COUNT}`;
}

/** Steps whose camera lines differ for touch and mouse. */
export const GESTURE_STEPS: readonly StepId[] = ['look-pan', 'look-zoom', 'look-turn'];
