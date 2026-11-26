// "Whose zoo is this?" (spec §3.5, S3/S8): after sign-in, a zoo played as Guest on this phone
// is given to a player only in the title menu (no sim running), through
// LocalStore.adoptGuestInto. "Keep as Guest" remembers the answer (guestAsked). The flow is a
// pure function over injected steps (tests/account-menu.test.ts); askWhoseZoo draws the page.
import type { Avatar, SaveMeta } from '../../../shared/api-types';
import { MAX_PROFILES_DEFAULT } from '../../../shared/limits';
import type { CloudHandle } from '../../core/cloud-types';
import { el } from '../dom';
import { icon } from '../icons';
import { avatarEl, notice, openPage } from './dialog';
import { animalsText, fmtStars, zooLine } from './format';

export type WhoseZooChoice = { kind: 'player'; pid: string } | { kind: 'new' } | { kind: 'guest' };

export interface WhoseZooView {
  meta: SaveMeta;
  players: { id: string; name: string; avatar: Avatar; hasZoo: boolean }[];
  canAdd: boolean;
}

export interface WhoseZooDeps {
  cloud: Pick<CloudHandle, 'profiles' | 'local' | 'auth'>;
  /** Show the question; resolves with the choice. */
  ask(view: WhoseZooView): Promise<WhoseZooChoice>;
  /** "+ New player": the setup page; resolves with the new profile id, or null when cancelled. */
  createPlayer(): Promise<string | null>;
  /** Tell the player something went wrong (the guest zoo stays as it is). */
  failed?(): Promise<void> | void;
}

/** Whether to ask at all: a guest zoo on this phone, a signed-in account, and the question not answered yet. */
export function shouldAskWhoseZoo(cloud: Pick<CloudHandle, 'profiles' | 'auth'>): boolean {
  if (!cloud.auth.accountId) return false;
  const s = cloud.auth.state.get().kind;
  if (s !== 'signed-in' && s !== 'needs-signin') return false;
  return !!cloud.profiles.guestZoo() && !cloud.profiles.guestAsked();
}

/**
 * Ask until there is an answer. Returns the profile that got the guest zoo, or null (kept as
 * Guest, nothing to ask, or the copy failed and the guest zoo stayed where it was).
 */
export async function runWhoseZoo(d: WhoseZooDeps): Promise<string | null> {
  const { cloud } = d;
  if (!shouldAskWhoseZoo(cloud)) return null;
  const accountId = cloud.auth.accountId!;
  for (;;) {
    const meta = cloud.profiles.guestZoo();
    if (!meta) return null;
    const list = cloud.profiles.list();
    const view: WhoseZooView = {
      meta,
      players: list.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, hasZoo: p.local.hasMain || !!p.main })),
      canAdd: list.length < MAX_PROFILES_DEFAULT,
    };
    const choice = await d.ask(view);
    let pid: string | null = null;
    if (choice.kind === 'guest') {
      cloud.profiles.setGuestAsked();
      return null;
    }
    if (choice.kind === 'new') {
      pid = await d.createPlayer();
      if (!pid) continue; // back to the question
    } else {
      pid = choice.pid;
    }
    const r = cloud.local.adoptGuestInto(accountId, pid);
    if (r === 'ok') {
      cloud.profiles.setGuestAsked();
      return pid;
    }
    if (r === 'no-guest') return null;
    await d.failed?.();
    return null;
  }
}

/** The page: the zoo card, one tile per player, "+ New player" and "Keep as Guest". */
export function askWhoseZoo(container: HTMLElement, view: WhoseZooView): Promise<WhoseZooChoice> {
  return new Promise((resolve) => {
    const page = openPage(container, { title: 'Whose zoo is this?', cls: 'wh-ac-whose' });
    const done = (c: WhoseZooChoice) => {
      page.close();
      resolve(c);
    };
    const m = view.meta;
    const card = el('div', 'wh-ac-zoocard', [
      el('div', { class: 'wh-ac-zooic', html: icon('paw') }),
      el('div', {}, [
        el('b', { text: zooLine(m) }),
        el('span', { text: [fmtStars(m.rating), animalsText(m.animals)].filter(Boolean).join(' · ') }),
      ]),
      el('div', { class: 'wh-ac-note', text: 'This zoo was played on this phone without a player. Who does it belong to?' }),
    ]);
    const tiles = view.players.map((p) =>
      el('button', { class: 'wh-ac-tile', attrs: { type: 'button', 'data-pid': p.id, 'aria-label': `Give the zoo to ${p.name}` }, onClick: () => done({ kind: 'player', pid: p.id }) }, [
        avatarEl(p.avatar, 56),
        el('b', { text: p.name }),
        el('small', { text: p.hasZoo ? 'Has a zoo too' : 'Give it to me' }),
      ]),
    );
    const add = el('button', { class: 'wh-ac-tile add', attrs: { type: 'button', 'data-tile': 'new' }, onClick: () => done({ kind: 'new' }) }, [
      el('span', { class: 'wh-ac-plus', html: icon('plus') }),
      el('b', { text: 'New player' }),
    ]);
    add.disabled = !view.canAdd;
    const guest = el('button', { class: 'wh-ac-tile', attrs: { type: 'button', 'data-tile': 'guest' }, onClick: () => done({ kind: 'guest' }) }, [
      avatarEl(null, 56),
      el('b', { text: 'Keep as Guest' }),
      el('small', { text: 'Stays on this phone' }),
    ]);
    page.body.append(card, el('div', 'wh-ac-grid', [...tiles, add, guest]));
  });
}

/** runWhoseZoo with the real pages. */
export function whoseZooFlow(container: HTMLElement, cloud: Pick<CloudHandle, 'profiles' | 'local' | 'auth'>, createPlayer: () => Promise<string | null>): Promise<string | null> {
  return runWhoseZoo({
    cloud,
    ask: (view) => askWhoseZoo(container, view),
    createPlayer,
    failed: () => notice(container, "We couldn't move the zoo", 'It is still here as the Guest zoo. Try again later.'),
  });
}
