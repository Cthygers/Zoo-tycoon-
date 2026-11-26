// Settings › Account (spec §3.1, §3.9, platform §10.4 item 6): who is signed in and playing,
// the cloud status, Sync now, Backups, Sign out and Delete account (both behind the grown-up
// check), or "Sign in with Google" for the guest. The texts are pure functions (tested).
import type { CachedProfile, CloudHandle, CloudStatus } from '../../core/cloud-types';
import type { PlayerInfo } from '../../core/contracts';
import type { UIExtensionHost } from '../../core/ui-ext';
import { button, el, escapeHtml } from '../dom';
import { icon } from '../icons';
import { statusText } from './badge';
import { showBackups } from './backups';
import { avatarEl, busyBox, confirmBox, notice } from './dialog';
import { askGrownup } from './grownup';
import { profileMeta } from './menuModel';
import { signInSheet } from './signin';

/** sessionStorage flag: "Switch player" wants "Who's playing?" in the menu even with one player. */
export const PICKER_FLAG_KEY = 'wildhaven-open-picker';

export const MATCH_CLOCK_NOTE = 'The match clock keeps running while you are away.';
export const SIGNIN_PITCH = 'Sign in with Google to keep your zoos safe online and play Versus with friends.';
export const REAUTH_MISMATCH = "That's a different Google account. Use the one you signed in with.";

/** Players whose zoo is not online yet ("Mia: Day 14, Ben: Day 3"). */
export function unsyncedPlayers(list: readonly CachedProfile[]): string[] {
  const waiting = new Set(['pending', 'offline', 'conflict', 'waiting', 'blocked']);
  return list.filter((p) => p.local.hasMain && waiting.has(p.local.state)).map((p) => {
    const m = profileMeta(p);
    return m ? `${p.name}: Day ${m.day}` : p.name;
  });
}

/** The sign-out warning (spec §3.1). */
export function unsyncedText(players: readonly string[]): string {
  const who = players.length ? ` (${players.join(', ')})` : '';
  return `Some progress isn't saved online yet${who}. It stays on this phone and uploads next time you sign in with this account.`;
}

/** What "Delete account" removes. */
export function deleteAccountText(email: string | null, names: readonly string[]): string {
  const acc = email ? `the online account ${email}` : 'the online account';
  const who = names.length ? `the players ${names.join(', ')}` : 'its players';
  return `This deletes ${acc}: ${who}, their online zoos and their Versus results. Their zoos on this phone are deleted too. The Guest zoo stays. Then a grown-up confirms with Google.`;
}

/** Kid words for deleteAccount's answer (null = say nothing). */
export function deleteResultText(r: 'ok' | 'cancelled' | 'mismatch' | 'offline' | 'error'): string | null {
  switch (r) {
    case 'ok':
      return 'The account and its online zoos are deleted.';
    case 'mismatch':
      return REAUTH_MISMATCH;
    case 'offline':
      return 'Connect to the internet to do this.';
    case 'cancelled':
      return null;
    default:
      return 'Something went wrong. Try again.';
  }
}

export interface SettingsDeps {
  host: UIExtensionHost;
  cloud: CloudHandle;
  player: PlayerInfo;
  /** Badge / status tap for a conflict. */
  openConflict(): void;
}

function setFlag(): void {
  try {
    sessionStorage.setItem(PICKER_FLAG_KEY, '1');
  } catch {
    /* the menu then opens without the picker */
  }
}

export class AccountSettings {
  private statusEl: HTMLElement | null = null;
  private busy = false;

  constructor(private readonly d: SettingsDeps) {}

  private get dialogRoot(): HTMLElement {
    return this.d.host.root;
  }

  /** Update the live status line (cloud.status subscription). */
  setStatus(s: CloudStatus): void {
    const e = this.statusEl;
    if (!e) return;
    const t = statusText(s, Date.now());
    e.className = `wh-ac-status ${t.tone}`;
    e.innerHTML = `${s.kind === 'pending' && s.offline ? icon('cloudOff') : s.kind === 'conflict' ? icon('cloudAlert') : ''}<span>${escapeHtml(t.text)}</span>`;
    if (s.kind === 'conflict') {
      e.style.cursor = 'pointer';
      e.onclick = () => this.d.openConflict();
    } else {
      e.onclick = null;
    }
  }

  render(): HTMLElement {
    const { cloud, player, host } = this.d;
    const auth = cloud.auth.state.get();
    const row = (title: string, sub: string | HTMLElement, ctrl: HTMLElement | null) =>
      el('div', 'wh-setting', [el('div', 'wh-setting-t', [el('b', { text: title }), typeof sub === 'string' ? el('span', { text: sub }) : sub]), ctrl]);
    const sect = el('div', { class: 'wh-ac-sect', attrs: { 'data-wh-ac': 'settings' } });
    if (auth.kind === 'guest' || auth.kind === 'signing-in' || auth.kind === 'disabled') {
      sect.append(row('Save online', SIGNIN_PITCH, button('wh-btn-primary', 'cloud', 'Sign in with Google', () => void this.signIn())));
      return sect;
    }
    const email = auth.email ?? 'your Google account';
    const who = el('span', {}, [
      player.profileId ? avatarEl(player.avatar, 28, 'wh-ac-inline-av') : null,
      document.createTextNode(`Player: ${player.name ?? 'Guest'}`),
      host.sim.versus ? el('span', { text: ` · ${MATCH_CLOCK_NOTE}`, attrs: { style: 'display:block;color:var(--wh-amber)' } }) : null,
    ]);
    sect.append(row(`Signed in as ${email}`, who, button('wh-btn-ghost', 'users', 'Switch player', () => void this.switchPlayer())));
    this.statusEl = el('span', 'wh-ac-status');
    const statusCtrl =
      auth.kind === 'needs-signin'
        ? button('wh-btn-primary', 'cloud', 'Sign in again', () => void this.signInAgain())
        : button('wh-btn-ghost', 'refresh', 'Sync now', () => void this.syncNow());
    sect.append(row('Online saves', this.statusEl, statusCtrl));
    this.setStatus(cloud.status.get());
    if (player.profileId) {
      const n = cloud.local.backups(player.profileId).length;
      sect.append(
        row('Backups', n ? `${n} ${n === 1 ? 'zoo' : 'zoos'} kept on this phone` : 'Zoos kept when two zoos meet', button('wh-btn-ghost', 'layers', 'Backups', () => void this.backups())),
      );
    }
    sect.append(
      el('div', 'wh-ac-btnrow', [
        button('wh-btn-ghost', 'lock', 'Sign out', () => void this.signOut()),
        button('wh-btn-danger', 'trash', 'Delete account', () => void this.deleteAccount()),
      ]),
    );
    return sect;
  }

  private async signIn(): Promise<void> {
    const out = await signInSheet(this.dialogRoot, this.d.cloud);
    if (out?.kind !== 'ok') return;
    this.d.host.save();
    await this.d.host.switchSlot({ kind: 'menu' });
  }

  private async signInAgain(): Promise<void> {
    const out = await signInSheet(this.dialogRoot, this.d.cloud, { text: 'Sign in again with the same Google account to keep your zoos safe online.' });
    if (out?.kind === 'ok') this.d.host.notify('Signed in again. Your zoos save online.', 'good');
  }

  private async syncNow(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.d.host.save();
      await this.d.cloud.sync.syncNow();
    } catch {
      /* the status line tells */
    } finally {
      this.busy = false;
    }
  }

  private async switchPlayer(): Promise<void> {
    if (this.d.host.sim.versus) {
      const ok = await confirmBox(this.dialogRoot, { title: 'Switch player?', text: MATCH_CLOCK_NOTE, ok: 'Switch player', cancel: 'Stay' });
      if (!ok) return;
    }
    setFlag();
    await this.d.host.switchSlot({ kind: 'menu' });
  }

  private async backups(): Promise<void> {
    const { cloud, player, host } = this.d;
    await showBackups({
      cloud,
      player,
      root: host.root,
      reload: () => host.switchSlot({ kind: 'continue', player: player.ref, slot: 'main' }),
    });
  }

  private async signOut(): Promise<void> {
    const { cloud, host } = this.d;
    if (!(await askGrownup(this.dialogRoot, 'to sign out'))) return;
    host.save();
    const stop = busyBox(this.dialogRoot, 'Signing out', 'Saving your zoos online…');
    let r: 'ok' | 'unsynced';
    try {
      r = await cloud.auth.signOut();
    } catch {
      r = 'unsynced';
    }
    stop();
    if (r === 'unsynced') {
      const anyway = await confirmBox(this.dialogRoot, {
        title: 'Sign out now?',
        text: unsyncedText(unsyncedPlayers(cloud.profiles.list())),
        ok: 'Sign out anyway',
        cancel: 'Stay signed in',
        primary: 'cancel',
      });
      if (!anyway) return;
      await cloud.auth.signOut({ force: true });
    }
    await host.switchSlot({ kind: 'menu' });
  }

  private async deleteAccount(): Promise<void> {
    const { cloud, host } = this.d;
    if (!(await askGrownup(this.dialogRoot, 'to delete the account'))) return;
    const st = cloud.auth.state.get();
    const email = st.kind === 'signed-in' || st.kind === 'needs-signin' ? st.email : null;
    const ok = await confirmBox(this.dialogRoot, {
      title: 'Delete the account?',
      text: deleteAccountText(email, cloud.profiles.list().map((p) => p.name)),
      ok: 'Delete everything',
      cancel: 'Keep it',
      danger: true,
      primary: 'cancel',
    });
    if (!ok) return;
    const stop = busyBox(this.dialogRoot, 'Deleting the account');
    let r: 'ok' | 'cancelled' | 'mismatch' | 'offline' | 'error';
    try {
      r = await cloud.auth.deleteAccount();
    } catch {
      r = 'error';
    }
    stop();
    const text = deleteResultText(r);
    if (text) await notice(this.dialogRoot, r === 'ok' ? 'Account deleted' : "The account wasn't deleted", text);
    if (r === 'ok') await host.switchSlot({ kind: 'menu' });
  }
}
