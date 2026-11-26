// Manage players (spec §3.3): rename, change animal, remove behind the grown-up check (a 30-day
// soft delete), and "Recently removed players" with Undo. Every change is online only.
import type { RemovedProfileDto } from '../../../shared/api-types';
import type { CachedProfile, CloudHandle } from '../../core/cloud-types';
import { button, el } from '../dom';
import { avatarEl, busyBox, confirmBox, errorText, notice, openPage } from './dialog';
import { animalsText, fmtAgo, metaLine } from './format';
import { askGrownup } from './grownup';
import { profileMeta } from './menuModel';
import { editPlayer } from './setup';

export const OFFLINE_CHANGE = 'Connect to the internet to change players';

/** "Mia and Mia's zoo (Day 34, 21 animals) are removed. You can undo this for 30 days." */
export function removeText(p: CachedProfile): string {
  const m = profileMeta(p);
  const zoo = m ? ` and ${p.name}'s zoo (Day ${m.day}, ${animalsText(m.animals).toLowerCase()})` : '';
  return `${p.name}${zoo} will be removed. A grown-up can undo this for 30 days.`;
}

/** "Removed 2 days ago" for the removed list. */
export function removedLine(r: RemovedProfileDto, now: number): string {
  return `Removed ${fmtAgo(r.removedAt, now)}`;
}

export interface ManageDeps {
  cloud: Pick<CloudHandle, 'profiles'>;
  /** Where the page goes (the menu screen). */
  container: HTMLElement;
  /** Where dialogs go. */
  dialogRoot: HTMLElement;
  online(): boolean;
}

/** The page; resolves when the player goes back. */
export function showManage(d: ManageDeps): Promise<void> {
  return new Promise((resolve) => {
    const page = openPage(d.container, {
      title: 'Manage players',
      cls: 'wh-ac-manage',
      onBack: () => {
        page.close();
        resolve();
      },
    });
    let busy = false;
    const run = async (title: string, fn: () => Promise<unknown>) => {
      if (busy) return;
      busy = true;
      const stop = busyBox(d.dialogRoot, title);
      try {
        await fn();
      } catch (e) {
        stop();
        busy = false;
        await notice(d.dialogRoot, "That didn't work", errorText(e));
        draw();
        return;
      }
      stop();
      busy = false;
      draw();
    };
    const remove = async (p: CachedProfile) => {
      if (!(await askGrownup(d.dialogRoot, `to remove ${p.name}`))) return;
      const ok = await confirmBox(d.dialogRoot, { title: `Remove ${p.name}?`, text: removeText(p), ok: 'Remove', cancel: 'Keep', danger: true, primary: 'cancel' });
      if (ok) await run(`Removing ${p.name}`, () => d.cloud.profiles.remove(p.id));
    };
    const draw = () => {
      const online = d.online();
      const now = Date.now();
      const list = d.cloud.profiles.list();
      const removed = d.cloud.profiles.removed();
      const rows = list.map((p) => {
        const b = [
          button('wh-btn-ghost', 'pencil', 'Rename', async () => {
            if (await editPlayer(d.container, d.cloud, p, 'name')) draw();
          }, `Rename ${p.name}`),
          button('wh-btn-ghost', 'paw', 'Animal', async () => {
            if (await editPlayer(d.container, d.cloud, p, 'animal')) draw();
          }, `Change ${p.name}'s animal`),
          button('wh-btn-danger', 'trash', 'Remove', () => void remove(p), `Remove ${p.name}`),
        ];
        b.forEach((x) => (x.disabled = !online));
        return el('div', { class: 'wh-ac-row', attrs: { 'data-pid': p.id } }, [
          avatarEl(p.avatar, 44),
          el('div', 'wh-ac-row-t', [el('b', { text: p.name }), el('small', { text: metaLine(profileMeta(p)) })]),
          ...b,
        ]);
      });
      const gone = removed.map((r) => {
        const undo = button('wh-btn-primary', 'undo', 'Undo', () => void run(`Bringing back ${r.name}`, () => d.cloud.profiles.restore(r.id)), `Bring back ${r.name}`);
        undo.disabled = !online;
        return el('div', { class: 'wh-ac-row removed', attrs: { 'data-removed': r.id } }, [
          avatarEl(r.avatar, 44),
          el('div', 'wh-ac-row-t', [el('b', { text: r.name }), el('small', { text: removedLine(r, now) })]),
          undo,
        ]);
      });
      page.body.replaceChildren(
        ...(online ? [] : [el('div', { class: 'wh-ac-note warn', text: OFFLINE_CHANGE })]),
        list.length ? el('div', 'wh-ac-list', rows) : el('div', { class: 'wh-ac-note', text: 'No players yet.' }),
        ...(gone.length ? [el('div', { class: 'wh-ac-h3', text: 'Recently removed players' }), el('div', 'wh-ac-list', gone)] : []),
      );
    };
    draw();
  });
}
