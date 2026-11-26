// Title menu and player flow logic (spec §7.1, §6.8, §3.3, §3.5): the pure menuModel for every
// case, the "Who's playing?" decisions and tiles, "Whose zoo is this?" (runWhoseZoo, against a
// scripted fake and against the real LocalStore on a FakeCloud phone), the sign-in error words
// and the live name check.
import { describe, expect, it, vi } from 'vitest';
import type { Avatar, SaveMeta } from '../shared/api-types';
import type { CachedProfile, CloudHandle, SignInOutcome } from '../src/core/cloud-types';
import type { PlayerRef } from '../src/core/contracts';
import { readTutorialState, writeActiveSlot } from '../src/core/player-state';
import { KEYS, slotKey } from '../src/core/storage-keys';
import { FakeCloud } from '../src/net/fakeCloud';
import { bootPhone, makePhone, meta as metaOf, zooJson } from '../src/net/testkit';
import {
  activeMatchFrom,
  cloudModeOf,
  menuModel,
  needsFirstPlayer,
  newZooConfirm,
  NEW_ZOO_TEXT,
  NEW_ZOO_TEXT_CLOUD,
  openPickerFirst,
  pickerTiles,
  startPlayer,
  type MenuInput,
  type MenuModel,
} from '../src/ui/account/menuModel';
import { addTileState } from '../src/ui/account/picker';
import { freshAvatar, nameFeedback, NAME_HINT } from '../src/ui/account/setup';
import { signInErrorText, SIGNIN_ERRORS } from '../src/ui/account/signin';
import { runWhoseZoo, shouldAskWhoseZoo, type WhoseZooChoice, type WhoseZooView } from '../src/ui/account/whosezoo';
import { menuInputOf } from '../src/ui/screens';

const MIA: Avatar = { animal: 'zebra', color: 4 };
const META: SaveMeta = { day: 12, minute: 860, money: 48_210, rating: 61, animals: 18, species: 5, visitors: 900, playSeconds: 4200 };

function input(o: Partial<MenuInput> = {}): MenuInput {
  return { cloud: 'guest', player: 'guest', name: null, avatar: null, hasZoo: false, activeSlot: 'main', hasPractice: false, activeMatch: null, ...o };
}

const labels = (m: MenuModel) => [m.primary.label, ...m.row2.map((b) => b.label)];
const resultOf = (b: MenuModel['primary']) => (b.action.kind === 'result' ? b.action.result : null);

function profile(id: string, name: string, o: { meta?: SaveMeta | null; state?: CachedProfile['local']['state']; cloudMeta?: SaveMeta | null } = {}): CachedProfile {
  return {
    id,
    name,
    avatar: MIA,
    prefs: {},
    createdAt: 1,
    updatedAt: 1,
    main: o.cloudMeta ? { epoch: 'e', rev: 1, meta: o.cloudMeta, savedAt: 1, deviceName: 'Tablet', lease: null } : null,
    local: { hasMain: !!o.meta, meta: o.meta ?? null, state: o.state ?? 'synced' },
  };
}

describe('menuModel (spec §7.1)', () => {
  it('guest without a zoo: New Zoo is the primary, no second row, the Sign in chip', () => {
    const m = menuModel(input());
    expect(m.primary.id).toBe('new');
    expect(m.primary.style).toBe('primary');
    expect(resultOf(m.primary)).toEqual({ kind: 'new', player: 'guest', slot: 'main' });
    expect(m.primary.action.kind === 'result' && m.primary.action.confirm).toBeFalsy();
    expect(m.row2).toEqual([]);
    expect(m.chip).toEqual({ kind: 'signin', label: 'Sign in' });
    expect(resultOf(m.learn)).toEqual({ kind: 'new', player: 'guest', slot: 'main', startTutorial: true });
  });

  it('guest with a zoo: Continue, New Zoo behind the plain confirm, Learn to play opens the practice zoo', () => {
    const m = menuModel(input({ hasZoo: true }));
    expect(labels(m)).toEqual(['Continue', 'New Zoo']);
    expect(resultOf(m.primary)).toEqual({ kind: 'continue', player: 'guest', slot: 'main' });
    const nz = m.row2[0];
    expect(nz.action.kind === 'result' && nz.action.confirm?.text).toBe(NEW_ZOO_TEXT);
    expect(nz.action.kind === 'result' && nz.action.result).toEqual({ kind: 'new', player: 'guest', slot: 'main' });
    expect(resultOf(m.learn)).toEqual({ kind: 'tutorial', player: 'guest', slot: 'practice' });
    expect(m.row2.some((b) => b.id === 'versus')).toBe(false);
  });

  it('cloud disabled: no chip and no Versus, only Continue / New Zoo, Learn to play (and Graphics)', () => {
    for (const hasZoo of [false, true]) {
      const m = menuModel(input({ cloud: 'disabled', hasZoo }));
      expect(m.chip).toBeNull();
      expect(m.signinAgain).toBe(false);
      const ids = [m.primary.id, ...m.row2.map((b) => b.id)];
      expect(ids).not.toContain('versus');
      expect(ids).toEqual(hasZoo ? ['continue', 'new'] : ['new']);
      expect(m.learn.label).toBe('Learn to play');
    }
    // a profile ref can never show up in a disabled build
    const m = menuModel(input({ cloud: 'disabled', player: 'p1', name: 'Mia', hasZoo: true }));
    expect(m.chip).toBeNull();
    expect(m.primary.label).toBe('Continue');
  });

  it('signed in with one player: player chip, "Continue as Mia", New Zoo + Versus, cloud confirm text', () => {
    const m = menuModel(input({ cloud: 'signed-in', player: 'p1', name: 'Mia', avatar: MIA, hasZoo: true }));
    expect(m.chip).toEqual({ kind: 'player', name: 'Mia', avatar: MIA, needsSignin: false });
    expect(labels(m)).toEqual(['Continue as Mia', 'New Zoo', 'Versus']);
    expect(resultOf(m.primary)).toEqual({ kind: 'continue', player: 'p1', slot: 'main' });
    const nz = m.row2[0];
    expect(nz.action.kind === 'result' && nz.action.confirm?.text).toBe(NEW_ZOO_TEXT_CLOUD);
    expect(m.row2[1].action).toEqual({ kind: 'versus' });
  });

  it('signed in, player without a zoo: New Zoo primary, Versus beside nothing else', () => {
    const m = menuModel(input({ cloud: 'signed-in', player: 'p1', name: 'Mia', hasZoo: false, versusDot: true }));
    expect(labels(m)).toEqual(['New Zoo', 'Versus']);
    expect(m.row2[0].dot).toBe(true);
  });

  it('signed in but playing as Guest: Guest chip, no Versus', () => {
    const m = menuModel(input({ cloud: 'signed-in', player: 'guest', hasZoo: true }));
    expect(m.chip).toEqual({ kind: 'guest', label: 'Guest' });
    expect(labels(m)).toEqual(['Continue', 'New Zoo']);
    expect(newZooConfirm('signed-in', 'guest').text).toBe(NEW_ZOO_TEXT);
  });

  it('signed in with 3 players: the picker opens first, then the last player is the one the menu plays as', () => {
    const profiles = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(openPickerFirst({ mode: 'signed-in', profiles: 3, forced: false })).toBe(true);
    expect(openPickerFirst({ mode: 'needs-signin', profiles: 3, forced: false })).toBe(true);
    expect(openPickerFirst({ mode: 'signed-in', profiles: 3, preselect: 'b', forced: false })).toBe(false);
    expect(openPickerFirst({ mode: 'signed-in', profiles: 1, forced: false })).toBe(false);
    expect(openPickerFirst({ mode: 'signed-in', profiles: 1, forced: true })).toBe(true);
    expect(openPickerFirst({ mode: 'guest', profiles: 3, forced: true })).toBe(false);
    expect(startPlayer({ mode: 'signed-in', profiles, last: 'c' })).toBe('c');
    expect(startPlayer({ mode: 'signed-in', profiles, preselect: 'b', last: 'c' })).toBe('b');
    expect(startPlayer({ mode: 'signed-in', profiles, preselect: 'gone', last: 'zz' })).toBe('guest');
    expect(startPlayer({ mode: 'signed-in', profiles: [{ id: 'a' }], last: 'guest' })).toBe('a');
    expect(startPlayer({ mode: 'signed-in', profiles: [{ id: 'a' }], preselect: 'guest', last: 'a' })).toBe('guest');
    expect(startPlayer({ mode: 'guest', profiles, preselect: 'a', last: 'a' })).toBe('guest');
    const m = menuModel(input({ cloud: 'signed-in', player: 'c', name: 'Ben', hasZoo: true }));
    expect(m.primary.label).toBe('Continue as Ben');
  });

  it('first player setup only for a signed-in account with no players', () => {
    expect(needsFirstPlayer('signed-in', 0)).toBe(true);
    expect(needsFirstPlayer('signed-in', 1)).toBe(false);
    expect(needsFirstPlayer('needs-signin', 0)).toBe(false);
    expect(needsFirstPlayer('guest', 0)).toBe(false);
  });

  it('practice active: Continue tutorial and Back to my zoo (discard practice)', () => {
    for (const cloud of ['disabled', 'guest'] as const) {
      const m = menuModel(input({ cloud, hasZoo: true, activeSlot: 'practice', hasPractice: true }));
      expect(m.primary.label).toBe('Continue tutorial');
      expect(resultOf(m.primary)).toEqual({ kind: 'continue', player: 'guest', slot: 'practice' });
      expect(m.row2.map((b) => b.label)).toEqual(['Back to my zoo']);
      expect(resultOf(m.row2[0])).toEqual({ kind: 'continue', player: 'guest', slot: 'main', discard: 'practice' });
    }
    // signed in: Versus stays beside it
    const s = menuModel(input({ cloud: 'signed-in', player: 'p1', name: 'Mia', hasZoo: true, activeSlot: 'practice', hasPractice: true }));
    expect(labels(s)).toEqual(['Continue tutorial', 'Back to my zoo', 'Versus']);
    // practice slot gone (deleted): back to the normal menu
    expect(menuModel(input({ hasZoo: true, activeSlot: 'practice', hasPractice: false })).primary.id).toBe('continue');
    // practice without a main zoo: the second button starts the main zoo and drops the practice one
    const n = menuModel(input({ activeSlot: 'practice', hasPractice: true }));
    expect(resultOf(n.row2[0])).toEqual({ kind: 'new', player: 'guest', slot: 'main', discard: 'practice' });
  });

  it('an unfinished versus match: Back to your match, then My zoo and Versus', () => {
    const m = menuModel(input({ cloud: 'signed-in', player: 'p1', name: 'Mia', hasZoo: true, activeSlot: 'vs-m123', activeMatch: { matchId: 'm123' } }));
    expect(labels(m)).toEqual(['Back to your match', 'My zoo', 'Versus']);
    expect(resultOf(m.primary)).toEqual({ kind: 'versus', player: 'p1', slot: 'vs-m123', matchId: 'm123' });
    expect(resultOf(m.row2[0])).toEqual({ kind: 'continue', player: 'p1', slot: 'main' });
    // offline / needs-signin still lets the child go back to the match (local slot), without Versus
    const o = menuModel(input({ cloud: 'needs-signin', player: 'p1', name: 'Mia', hasZoo: false, activeMatch: { matchId: 'm123' } }));
    expect(labels(o)).toEqual(['Back to your match', 'New Zoo']);
    // the guest never has a match
    expect(menuModel(input({ activeMatch: { matchId: 'x' } })).primary.id).toBe('new');
  });

  it('needs-signin: player chip with the warning, no Versus, "Sign in again" in the foot', () => {
    const m = menuModel(input({ cloud: 'needs-signin', player: 'p1', name: 'Mia', avatar: MIA, hasZoo: true }));
    expect(m.chip).toEqual({ kind: 'player', name: 'Mia', avatar: MIA, needsSignin: true });
    expect(labels(m)).toEqual(['Continue as Mia', 'New Zoo']);
    expect(m.signinAgain).toBe(true);
    expect(cloudModeOf({ kind: 'needs-signin', accountId: 'a', email: null })).toBe('needs-signin');
    expect(cloudModeOf({ kind: 'signing-in' })).toBe('guest');
    expect(cloudModeOf({ kind: 'disabled' })).toBe('disabled');
  });

  it('activeMatchFrom reads the versus record (spec §5.6)', () => {
    const rec = (o: Record<string, unknown> = {}, match: Record<string, unknown> = {}) =>
      JSON.stringify({ v: 1, ended: null, finishQueued: false, ...o, match: { id: 'm1', status: 'active', mySeat: 0, players: [{ seat: 0, state: 'playing', doneAt: null }], ...match } });
    expect(activeMatchFrom(rec(), 'm1')).toEqual({ matchId: 'm1' });
    expect(activeMatchFrom(rec({ ended: 'budget' }), 'm1')).toBeNull();
    expect(activeMatchFrom(rec({ lost: true }), 'm1')).toBeNull();
    expect(activeMatchFrom(rec({}, { status: 'finished' }), 'm1')).toBeNull();
    expect(activeMatchFrom(rec({}, { players: [{ seat: 0, state: 'done', doneAt: 5 }] }), 'm1')).toBeNull();
    expect(activeMatchFrom(rec({}, { id: 'other' }), 'm1')).toBeNull();
    expect(activeMatchFrom('not json', 'm1')).toBeNull();
    expect(activeMatchFrom(null, 'm1')).toBeNull();
    expect(activeMatchFrom(rec(), null)).toBeNull();
  });
});

describe("Who's playing? tiles", () => {
  it('one tile per player then Guest; last highlighted; conflict "!" and update "⛔"; cloud meta when the phone has none', () => {
    const list = [
      profile('a', 'Mia', { meta: { ...META, day: 15, rating: 61 } }),
      profile('b', 'Ben', { state: 'conflict', meta: META }),
      profile('c', 'Leo', { state: 'blocked', cloudMeta: { ...META, day: 3, rating: 0 } }),
      profile('d', 'Ana'),
    ];
    const t = pickerTiles(list, 'b', { ...META, day: 9, rating: 20 });
    expect(t.map((x) => x.ref)).toEqual(['a', 'b', 'c', 'd', 'guest']);
    expect(t.map((x) => x.last)).toEqual([false, true, false, false, false]);
    expect(t[0].line).toBe('Day 15 · ★★★');
    expect(t[1].mark).toBe('!');
    expect(t[2].mark).toBe('⛔');
    expect(t[2].line).toBe('Day 3');
    expect(t[3].line).toBe('No zoo yet');
    expect(t[4]).toMatchObject({ name: 'Guest', line: 'Day 9 · ★', avatar: null, state: null });
    expect(pickerTiles(list, 'guest', null)[4]).toMatchObject({ last: true, line: 'Play on this phone' });
  });

  it('"+ Add player" is online only and stops at 8', () => {
    expect(addTileState({ online: true, signedIn: true, players: 3 })).toEqual({ enabled: true, note: 'Make a new player' });
    expect(addTileState({ online: false, signedIn: true, players: 3 }).enabled).toBe(false);
    expect(addTileState({ online: true, signedIn: false, players: 3 }).enabled).toBe(false);
    expect(addTileState({ online: true, signedIn: true, players: 8 })).toEqual({ enabled: false, note: '8 is the most' });
  });
});

// ------------------------------------------------------------------ whose zoo is this?

function fakeCloud(o: { guestZoo: SaveMeta | null; asked?: boolean; players?: CachedProfile[]; adopt?: 'ok' | 'no-guest' | 'failed' }) {
  let asked = o.asked ?? false;
  const players = o.players ?? [profile('p1', 'Mia'), profile('p2', 'Ben', { meta: META })];
  const adoptGuestInto = vi.fn((_acc: string, _pid: string) => o.adopt ?? 'ok');
  const setGuestAsked = vi.fn(() => {
    asked = true;
  });
  const cloud = {
    auth: { accountId: 'acc1', state: { get: () => ({ kind: 'signed-in', accountId: 'acc1', email: 'parent@example.com' }), subscribe: () => () => {} } },
    profiles: { guestZoo: () => o.guestZoo, guestAsked: () => asked, setGuestAsked, list: () => players },
    local: { adoptGuestInto },
  } as unknown as Pick<CloudHandle, 'profiles' | 'local' | 'auth'>;
  return { cloud, adoptGuestInto, setGuestAsked };
}

describe('Whose zoo is this? (spec §3.5)', () => {
  it('choosing a player calls adoptGuestInto exactly once with that profile', async () => {
    const f = fakeCloud({ guestZoo: META });
    const views: WhoseZooView[] = [];
    const got = await runWhoseZoo({
      cloud: f.cloud,
      ask: async (v) => {
        views.push(v);
        return { kind: 'player', pid: 'p2' };
      },
      createPlayer: async () => 'never',
    });
    expect(got).toBe('p2');
    expect(f.adoptGuestInto).toHaveBeenCalledTimes(1);
    expect(f.adoptGuestInto).toHaveBeenCalledWith('acc1', 'p2');
    expect(views).toHaveLength(1);
    expect(views[0].meta).toEqual(META);
    expect(views[0].players.map((p) => [p.name, p.hasZoo])).toEqual([['Mia', false], ['Ben', true]]);
    expect(views[0].canAdd).toBe(true);
  });

  it('Keep as Guest remembers the answer and adopts nothing', async () => {
    const f = fakeCloud({ guestZoo: META });
    expect(await runWhoseZoo({ cloud: f.cloud, ask: async () => ({ kind: 'guest' }), createPlayer: async () => null })).toBeNull();
    expect(f.adoptGuestInto).not.toHaveBeenCalled();
    expect(f.setGuestAsked).toHaveBeenCalledTimes(1);
    // asked once: never again
    const ask = vi.fn(async (): Promise<WhoseZooChoice> => ({ kind: 'player', pid: 'p1' }));
    expect(await runWhoseZoo({ cloud: f.cloud, ask, createPlayer: async () => null })).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it('+ New player: setup first, then the new player gets the zoo; a cancelled setup asks again', async () => {
    const f = fakeCloud({ guestZoo: META });
    const answers: WhoseZooChoice[] = [{ kind: 'new' }, { kind: 'new' }];
    const made = ['', 'p9'];
    let n = 0;
    const got = await runWhoseZoo({ cloud: f.cloud, ask: async () => answers.shift()!, createPlayer: async () => made[n++] || null });
    expect(got).toBe('p9');
    expect(f.adoptGuestInto).toHaveBeenCalledTimes(1);
    expect(f.adoptGuestInto).toHaveBeenCalledWith('acc1', 'p9');
  });

  it('no guest zoo or not signed in: nothing is asked; a failed copy keeps the guest zoo and says so', async () => {
    const none = fakeCloud({ guestZoo: null });
    const ask = vi.fn(async (): Promise<WhoseZooChoice> => ({ kind: 'guest' }));
    expect(await runWhoseZoo({ cloud: none.cloud, ask, createPlayer: async () => null })).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(shouldAskWhoseZoo(none.cloud)).toBe(false);

    const bad = fakeCloud({ guestZoo: META, adopt: 'failed' });
    const failed = vi.fn();
    expect(await runWhoseZoo({ cloud: bad.cloud, ask: async () => ({ kind: 'player', pid: 'p1' }), createPlayer: async () => null, failed })).toBeNull();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(bad.setGuestAsked).not.toHaveBeenCalled();
  });

  it('on a real FakeCloud phone: the guest zoo moves to the chosen player (legacy key → -moved, tutorial copied)', async () => {
    const fake = new FakeCloud();
    const phone = makePhone(fake, { name: 'Phone' });
    phone.storage.setItem(KEYS.guestMain, zooJson('guest-zoo'));
    phone.storage.setItem(KEYS.guestTutorial, JSON.stringify({ v: 1, status: 'done', readAloud: false, updatedAt: 5 }));
    await phone.cloud.init();
    expect((await phone.cloud.auth.signIn()).kind).toBe('ok');
    const mia = await phone.cloud.profiles.create('Mia', MIA);
    await phone.cloud.profiles.create('Ben', { animal: 'lion', color: 1 });
    const spy = vi.spyOn(phone.cloud.local, 'adoptGuestInto');
    expect(shouldAskWhoseZoo(phone.cloud)).toBe(true);
    const got = await runWhoseZoo({ cloud: phone.cloud, ask: async () => ({ kind: 'player', pid: mia.id }), createPlayer: async () => null });
    expect(got).toBe(mia.id);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(phone.cloud.auth.accountId, mia.id);
    expect(phone.storage.getItem(KEYS.guestMain)).toBeNull();
    expect(phone.storage.getItem(KEYS.guestMainMoved)).toContain(mia.id);
    expect(phone.cloud.local.read(slotKey(mia.id, 'main'))?.json).toContain('guest-zoo');
    expect(readTutorialState(phone.storage, mia.id).status).toBe('done');
    expect(shouldAskWhoseZoo(phone.cloud)).toBe(false);
    phone.cloud.dispose();
  });
});

describe('menuInputOf (real cloud handle)', () => {
  it('reads the player, zoo, practice slot and an active match from storage', async () => {
    const fake = new FakeCloud();
    const phone = await bootPhone(fake, { name: 'Phone' });
    const mia = await phone.cloud.profiles.create('Mia', MIA);
    const s = phone.storage;
    let i = menuInputOf(phone.cloud, mia.id, s);
    expect(i).toMatchObject({ cloud: 'signed-in', player: mia.id, name: 'Mia', hasZoo: false, hasPractice: false, activeSlot: 'main', activeMatch: null });
    expect(phone.cloud.local.write(slotKey(mia.id, 'main'), zooJson('m'), metaOf(30))).toBe('saved');
    expect(phone.cloud.local.write(slotKey(mia.id, 'practice'), zooJson('p'), metaOf(5))).toBe('saved');
    writeActiveSlot(s, mia.id, 'vs-m42');
    s.setItem(KEYS.vs(mia.id, 'm42'), JSON.stringify({ v: 1, ended: null, match: { id: 'm42', status: 'active', mySeat: 0, players: [{ seat: 0, state: 'playing', doneAt: null }] } }));
    i = menuInputOf(phone.cloud, mia.id, s);
    expect(i).toMatchObject({ hasZoo: true, hasPractice: true, activeSlot: 'vs-m42', activeMatch: { matchId: 'm42' } });
    expect(menuModel(i).primary.label).toBe('Back to your match');
    // an unknown player falls back to the guest
    const g = menuInputOf(phone.cloud, 'nobody' as PlayerRef, s);
    expect(g.player).toBe('guest');
    phone.cloud.dispose();
  });

  it('a cloud-disabled handle: guest only, zoo from wildhaven-save-v1', async () => {
    const fake = new FakeCloud();
    const phone = makePhone(fake, { name: 'Phone' });
    // a disabled handle: same storage, no api
    const { createCloud } = await import('../src/net/index');
    const cloud = createCloud({
      storage: phone.storage,
      fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
      google: phone.google,
      device: { info: async () => ({ name: 'Phone', platform: 'web', hwId: null }) },
      appVersion: '0.15.0',
      apiBase: '',
    });
    await cloud.init();
    phone.storage.setItem(KEYS.guestMain, zooJson('g'));
    const i = menuInputOf(cloud, 'guest', phone.storage);
    expect(i).toMatchObject({ cloud: 'disabled', player: 'guest', hasZoo: true });
    const m = menuModel(i);
    expect(m.chip).toBeNull();
    expect(labels(m)).toEqual(['Continue', 'New Zoo']);
    cloud.dispose?.();
  });
});

describe('sign-in words and the name check', () => {
  it('maps every failure to the spec words; cancel and success are silent', () => {
    const err = (reason: Extract<SignInOutcome, { kind: 'error' }>['reason'], message = ''): SignInOutcome => ({ kind: 'error', reason, message });
    expect(signInErrorText(err('offline'))).toBe('Connect to the internet to sign in');
    expect(signInErrorText(err('no_google'))).toBe("Add a Google account in your phone's Settings to sign in");
    expect(signInErrorText(err('server'))).toBe("Can't reach the Wildhaven server right now. You can keep playing.");
    expect(signInErrorText(err('not_allowed'))).toBe("This Google account can't use Wildhaven online yet. Ask the grown-up who set it up.");
    expect(signInErrorText(err('unknown', 'Update Wildhaven to sign in.'))).toBe('Update Wildhaven to sign in.');
    expect(signInErrorText(err('unknown'))).toBe(SIGNIN_ERRORS.unknown);
    expect(signInErrorText({ kind: 'cancelled' })).toBeNull();
    expect(signInErrorText({ kind: 'ok', isNew: true })).toBeNull();
  });

  it('live name check uses the shared filter', () => {
    expect(nameFeedback('')).toEqual({ ok: false, text: '' });
    expect(nameFeedback('Mia')).toEqual({ ok: true, text: 'Nice name!' });
    expect(nameFeedback('mia@example.com')).toEqual({ ok: false, text: 'Use a nickname, not an email or website.' });
    expect(nameFeedback('A really very long name here')).toEqual({ ok: false, text: 'That name is a bit long. Try a shorter one.' });
    expect(nameFeedback('Mia 12345').ok).toBe(false);
    expect(NAME_HINT).toBe('Use a nickname. Friends you play Versus with will see it.');
  });

  it('a new player starts with an animal nobody uses yet', () => {
    const taken: Avatar[] = [{ animal: 'lion', color: 0 }, { animal: 'giraffe', color: 1 }];
    for (let seed = 0; seed < 40; seed++) {
      const a = freshAvatar(taken, seed);
      expect(['lion', 'giraffe']).not.toContain(a.animal);
      expect(a.color).toBeGreaterThanOrEqual(0);
      expect(a.color).toBeLessThan(8);
    }
  });
});
