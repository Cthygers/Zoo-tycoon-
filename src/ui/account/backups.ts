// Settings › Account › Backups (spec §3.9): the zoos a sync decision put aside on this phone.
// Play this one (the current zoo becomes a backup, then the game reloads into it), Give this zoo
// to… another player whose main slot is empty (§3.5), and Delete (confirm).
import type { Avatar, StashReason } from '../../../shared/api-types';
import type { CloudHandle, LocalBackup } from '../../core/cloud-types';
import type { PlayerInfo } from '../../core/contracts';
import { slotKey } from '../../core/storage-keys';
import { button, el } from '../dom';
import { avatarEl, confirmBox, notice, openModal, openPage } from './dialog';
import { animalsText, fmtAgo, fmtDuration, fmtStars, zooLine } from './format';

/** Why the backup exists, in kid words. */
export function reasonText(r: StashReason | string, fromDevice: string): string {
  const dev = fromDevice || 'another device';
  switch (r) {
    case 'lease_lost':
      return `Kept when ${dev} took over`;
    case 'chose_other':
      return 'Kept when you picked the other zoo';
    case 'auto_pull':
      return `Kept when a newer zoo came from ${dev}`;
    case 'replaced':
      return 'Kept when another zoo replaced it';
    default:
      return `From ${dev}`;
  }
}

/** The card lines of one backup. */
export function backupLines(b: LocalBackup, now: number): { title: string; sub: string; why: string } {
  const m = b.meta;
  return {
    title: zooLine(m),
    sub: [fmtStars(m.rating), animalsText(m.animals), `played ${fmtDuration(m.playSeconds)}`].filter(Boolean).join(' · '),
    why: `${reasonText(b.reason, b.fromDevice)} · ${fmtAgo(b.createdAt, now)}`,
  };
}

/** Players who can receive a zoo: no zoo on this phone and none in the cloud. */
export function giveTargets(cloud: Pick<CloudHandle, 'profiles' | 'local'>, fromPid: string | null): { id: string; name: string; empty: boolean; avatar: Avatar }[] {
  return cloud.profiles
    .list()
    .filter((p) => p.id !== fromPid)
    .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, empty: !cloud.local.has(slotKey(p.id, 'main')) && !p.main }));
}

export interface BackupsDeps {
  cloud: Pick<CloudHandle, 'profiles' | 'local'>;
  player: PlayerInfo;
  /** Page container and dialog root (the game UI layer). */
  root: HTMLElement;
  /** Reload into the player's main zoo after "Play this one". */
  reload(): Promise<void> | void;
}

async function chooseTarget(root: HTMLElement, list: ReturnType<typeof giveTargets>): Promise<string | null> {
  const grid = el('div', 'wh-ac-grid');
  const m = openModal<string | null>(root, {
    title: 'Give this zoo to…',
    text: list.some((p) => p.empty) ? 'Pick a player who has no zoo yet.' : 'Every other player already has a zoo.',
    body: grid,
    buttons: [{ label: 'Cancel', value: null }],
    dismiss: { value: null },
    wide: true,
  });
  for (const p of list) {
    const t = el('button', { class: 'wh-ac-tile', attrs: { type: 'button', 'data-pid': p.id }, onClick: () => m.close(p.id) }, [
      avatarEl(p.avatar, 56),
      el('b', { text: p.name }),
      el('small', { text: p.empty ? 'No zoo yet' : 'Has a zoo' }),
    ]);
    t.disabled = !p.empty;
    grid.append(t);
  }
  return m.done;
}

/** The page; resolves when closed. */
export function showBackups(d: BackupsDeps): Promise<void> {
  return new Promise((resolve) => {
    const pid = d.player.profileId;
    const page = openPage(d.root, {
      title: 'Backups',
      cls: 'wh-ac-backups',
      onBack: () => {
        page.close();
        resolve();
      },
    });
    const draw = () => {
      const now = Date.now();
      const list = pid ? d.cloud.local.backups(pid) : [];
      if (!list.length) {
        page.body.replaceChildren(el('div', { class: 'wh-ac-note', text: 'No backups. When two zoos meet, the one you did not pick is kept here for 30 days.' }));
        return;
      }
      page.body.replaceChildren(
        el('div', { class: 'wh-ac-note', text: 'Zoos kept when two zoos met. They stay for 30 days.' }),
        el(
          'div',
          'wh-ac-list',
          list.map((b) => {
            const l = backupLines(b, now);
            return el('div', { class: 'wh-ac-row', attrs: { 'data-backup': b.id } }, [
              el('div', 'wh-ac-row-t', [el('b', { text: l.title }), el('small', { text: l.sub }), el('small', { text: l.why })]),
              button('wh-btn-primary', 'play1', 'Play this one', () => void play(b)),
              button('wh-btn-ghost', 'users', 'Give…', () => void give(b), 'Give this zoo to…'),
              button('wh-btn-danger', 'trash', null, () => void del(b), 'Delete'),
            ]);
          }),
        ),
      );
    };
    const play = async (b: LocalBackup) => {
      if (!pid) return;
      const ok = await confirmBox(d.root, { title: 'Play this zoo?', text: 'The zoo you are playing now is kept as a backup.', ok: 'Play this one' });
      if (!ok) return;
      if (d.cloud.local.playBackup(pid, b.id) !== 'ok') {
        await notice(d.root, "That didn't work", 'This backup could not be opened.');
        draw();
        return;
      }
      page.close();
      resolve();
      await d.reload();
    };
    const give = async (b: LocalBackup) => {
      if (!pid) return;
      const to = await chooseTarget(d.root, giveTargets(d.cloud, pid));
      if (!to) return;
      const r = d.cloud.local.giveTo({ profileId: pid, backupId: b.id }, to);
      const name = d.cloud.profiles.list().find((p) => p.id === to)?.name ?? 'that player';
      if (r === 'ok') await notice(d.root, `${name} has the zoo now`, `It saves online the next time ${name} plays.`);
      else if (r === 'not-empty') await notice(d.root, `${name} already has a zoo`, 'Pick a player who has no zoo yet.');
      else await notice(d.root, "That didn't work", 'The zoo could not be copied.');
      draw();
    };
    const del = async (b: LocalBackup) => {
      if (!pid) return;
      const ok = await confirmBox(d.root, { title: 'Delete this backup?', text: `${zooLine(b.meta)}. It cannot come back.`, ok: 'Delete', danger: true, primary: 'cancel', cancel: 'Keep' });
      if (!ok) return;
      d.cloud.local.deleteBackup(pid, b.id);
      draw();
    };
    draw();
  });
}
