// "Who's playing?" (spec §3.3, §7.1): big 132×120 tiles (5 per row at 800 px) for every player,
// then Guest and "+ Add player" (online only), and a gear for Manage players. The last player on
// this phone is highlighted. The tiles come from the pure pickerTiles (menuModel.ts).
import { MAX_PROFILES_DEFAULT } from '../../../shared/limits';
import type { CloudHandle, SlotUiState } from '../../core/cloud-types';
import type { PlayerRef } from '../../core/contracts';
import { button, el } from '../dom';
import { icon, type IconName } from '../icons';
import { avatarEl, openPage } from './dialog';
import { pickerTiles, type PickerTile } from './menuModel';
import { showManage } from './manage';
import { addPlayer } from './setup';

export const OFFLINE_ADD = 'Connect to the internet to add a player';

const STATE_ICON: Partial<Record<SlotUiState, IconName>> = {
  synced: 'cloudCheck',
  pending: 'cloud',
  offline: 'cloudOff',
  waiting: 'cloud',
  conflict: 'cloudAlert',
  blocked: 'cloudAlert',
};

/** What the "+ Add player" tile says, and whether it can be used. */
export function addTileState(o: { online: boolean; signedIn: boolean; players: number }): { enabled: boolean; note: string } {
  if (o.players >= MAX_PROFILES_DEFAULT) return { enabled: false, note: `${MAX_PROFILES_DEFAULT} is the most` };
  if (!o.signedIn) return { enabled: false, note: 'Sign in again first' };
  if (!o.online) return { enabled: false, note: 'Needs the internet' };
  return { enabled: true, note: 'Make a new player' };
}

export interface PickerDeps {
  cloud: CloudHandle;
  /** Where the page goes (the menu screen). */
  container: HTMLElement;
  /** Where dialogs go. */
  dialogRoot: HTMLElement;
  /** Highlighted tile (the current / last player). */
  highlight: PlayerRef;
  /** A back button (opened from the player chip); a cold start needs a pick. */
  closable: boolean;
  /** "Sign in again" for a dead session (needs-signin); resolves when done. */
  signInAgain?(): Promise<void>;
}

function tileEl(t: PickerTile, pick: (ref: PlayerRef) => void): HTMLElement {
  const st = t.state ? STATE_ICON[t.state] : undefined;
  return el('button', { class: `wh-ac-tile${t.last ? ' last' : ''}`, attrs: { type: 'button', 'data-ref': t.ref, 'aria-label': `${t.name}. ${t.line}` }, onClick: () => pick(t.ref) }, [
    st ? el('span', { class: `wh-ac-state ${t.state}`, html: icon(st), attrs: { 'aria-hidden': 'true' } }) : null,
    t.mark ? el('span', { class: `wh-ac-mark${t.mark === '⛔' ? ' blocked' : ''}`, text: t.mark === '⛔' ? 'Update' : '!', attrs: { title: t.mark === '!' ? 'Two different zoos: pick one' : 'Update the game to open this zoo' } }) : null,
    avatarEl(t.avatar, 56),
    el('b', { text: t.name }),
    el('small', { text: t.line }),
  ]);
}

/** Show the picker; resolves with the chosen player, or null for Back. */
export function showPicker(d: PickerDeps): Promise<PlayerRef | null> {
  return new Promise((resolve) => {
    const { cloud } = d;
    let online = typeof navigator === 'undefined' || navigator.onLine !== false;
    let closed = false;
    const finish = (r: PlayerRef | null) => {
      if (closed) return;
      closed = true;
      page.close();
      resolve(r);
    };
    const gear = button('wh-btn-ghost wh-ac-headbtn', 'sliders', 'Players', () => void manage(), 'Manage players');
    const again = button('wh-btn-ghost wh-ac-headbtn', 'cloudOff', 'Sign in again', async () => {
      await d.signInAgain?.();
      void refresh();
      draw();
    });
    const page = openPage(d.container, {
      title: "Who's playing?",
      cls: 'wh-ac-picker',
      onBack: d.closable ? () => finish(null) : undefined,
      headExtra: [again, gear],
    });
    const manage = async () => {
      await showManage({ cloud, container: d.container, dialogRoot: d.dialogRoot, online: () => online && cloud.auth.state.get().kind === 'signed-in' });
      draw();
    };
    const add = async () => {
      const p = await addPlayer(d.container, cloud, { first: false });
      if (p) finish(p.id);
      else draw();
    };
    const draw = () => {
      if (closed) return;
      const list = cloud.profiles.list();
      const signedIn = cloud.auth.state.get().kind === 'signed-in';
      again.style.display = signedIn ? 'none' : '';
      const tiles = pickerTiles(list, d.highlight, cloud.profiles.guestZoo()).map((t) => tileEl(t, finish));
      const st = addTileState({ online, signedIn, players: list.length });
      const addTile = el('button', { class: 'wh-ac-tile add', attrs: { type: 'button', 'data-tile': 'add', 'aria-label': st.enabled ? 'Add player' : `Add player: ${st.note}` }, onClick: () => void add() }, [
        el('span', { class: 'wh-ac-plus', html: icon('plus') }),
        el('b', { text: 'Add player' }),
        el('small', { text: st.enabled ? 'New player' : st.note }),
      ]);
      addTile.disabled = !st.enabled;
      if (!st.enabled && st.note === 'Needs the internet') addTile.title = OFFLINE_ADD;
      page.body.replaceChildren(el('div', 'wh-ac-grid', [...tiles, addTile]));
    };
    const refresh = async () => {
      try {
        const ok = await cloud.profiles.refresh();
        online = ok || (typeof navigator !== 'undefined' && navigator.onLine !== false && cloud.auth.state.get().kind !== 'signed-in');
      } catch {
        online = false;
      }
      draw();
    };
    draw();
    void refresh();
  });
}
