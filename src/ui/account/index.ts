// The account feature's UI (spec §3, §7.1, §8.7): the sync prompts main.ts hands to the sync
// engine, and the in-game account extension: the cloud badge in the HUD, Settings › Account,
// and the mid-play conflict badge → dialog → resolveConflict → reload. The title menu itself
// (showMainMenu) lives in src/ui/screens.ts and uses the pages in this folder.
import type { CloudHandle, ConflictInfo, CloudStatus, SyncPrompts } from '../../core/cloud-types';
import type { PlayerInfo, SlotKey } from '../../core/contracts';
import { slotKey } from '../../core/storage-keys';
import type { UIExtension, UIExtensionHost } from '../../core/ui-ext';
import { el, toggleClass } from '../dom';
import { icon } from '../icons';
import { badgeModel, statusText, type BadgeModel } from './badge';
import { closeTopModal, closeTopPage, modalOpen } from './dialog';
import { AccountSettings } from './settings';
import { ensureAccountStyles } from './styles';

export { createSyncPrompts } from './prompts';
export { badgeModel, statusText } from './badge';
export { PICKER_FLAG_KEY } from './settings';

/** Seconds a "synced" tick stays bright before it fades. */
export const BADGE_FADE_S = 3;

export interface AccountExtension extends UIExtension {
  /** The current badge model (tests / e2e). */
  badge(): BadgeModel | null;
  /** Open the conflict dialog for the active zoo (what a badge tap does). */
  openConflict(): Promise<void>;
}

class AccountExt implements AccountExtension {
  readonly id = 'account';
  private host: UIExtensionHost | null = null;
  private btn: HTMLButtonElement | null = null;
  private model: BadgeModel | null = null;
  private status: CloudStatus;
  private conflict: ConflictInfo | null = null;
  private wantConflict = false;
  private resolving = false;
  private shownFor = 0;
  private versus = false;
  private offs: (() => void)[] = [];
  private settings: AccountSettings | null = null;
  private readonly key: SlotKey | null;

  constructor(
    private readonly cloud: CloudHandle,
    private readonly opts: { player: PlayerInfo; prompts: SyncPrompts },
  ) {
    this.status = cloud.status.get();
    this.key = opts.player.profileId ? slotKey(opts.player.profileId, 'main') : null;
  }

  mount(host: UIExtensionHost): void {
    this.host = host;
    if (!this.cloud.enabled) return;
    ensureAccountStyles();
    this.versus = !!host.sim.versus;
    this.settings = new AccountSettings({ host, cloud: this.cloud, player: this.opts.player, openConflict: () => void this.openConflict() });
    this.offs.push(host.addSettingsSection({ id: 'account', order: 10, render: () => this.settings!.render() }));
    const btn = el('button', { class: 'wh-btn wh-btn-ghost wh-glass wh-ac-badge', attrs: { type: 'button', 'aria-label': 'Online saves' }, onClick: () => this.tap() }) as HTMLButtonElement;
    this.btn = btn;
    host.hudSlot('badge').append(btn);
    this.offs.push(
      this.cloud.status.subscribe((s) => {
        if (s.kind === 'synced' && this.status.kind !== 'synced') this.shownFor = 0;
        this.status = s;
        this.settings?.setStatus(s);
        this.draw();
      }),
    );
    this.offs.push(
      this.cloud.sync.on('conflict', ({ key, info }) => {
        if (key !== this.key) return;
        this.conflict = info;
        if (this.wantConflict) {
          this.wantConflict = false;
          void this.openConflict();
        } else if (!this.versus) {
          host.notify(`Two different zoos for ${info.profileName}. Tap the cloud to pick one.`, 'warn');
        }
        this.draw();
      }),
    );
    this.draw();
  }

  badge(): BadgeModel | null {
    return this.model;
  }

  private hasConflict(): boolean {
    return !!this.conflict || (this.status.kind === 'conflict' && !!this.key && this.status.keys.includes(this.key));
  }

  private draw(): void {
    const b = this.btn;
    if (!b) return;
    const st: CloudStatus = this.conflict && this.status.kind !== 'conflict' ? { kind: 'conflict', keys: this.key ? [this.key] : [] } : this.status;
    const m = badgeModel(st, { guest: !this.opts.player.profileId, versus: this.versus });
    this.model = m;
    toggleClass(b, 'hidden', m.hidden);
    b.style.display = m.hidden ? 'none' : '';
    b.className = `wh-btn wh-btn-ghost wh-glass wh-ac-badge ${m.cls}${m.fades && this.shownFor >= BADGE_FADE_S ? ' faded' : ''}`;
    b.setAttribute('aria-label', m.label || 'Online saves');
    b.title = m.label;
    b.innerHTML = (m.spin ? '<span class="wh-spin"></span>' : m.icon ? icon(m.icon) : '') + (m.bang ? '<span class="wh-ac-bang">!</span>' : '');
  }

  private tap(): void {
    const host = this.host;
    if (!host) return;
    if (this.hasConflict()) {
      void this.openConflict();
      return;
    }
    if (this.status.kind === 'needs-signin') {
      host.openMenu('settings');
      return;
    }
    const t = statusText(this.status, Date.now());
    host.notify(t.text, t.tone === 'good' ? 'good' : t.tone === 'warn' ? 'warn' : 'info');
  }

  async openConflict(): Promise<void> {
    const host = this.host;
    if (!host || !this.key || this.resolving) return;
    const info = this.conflict;
    if (!info) {
      // the event came before this extension mounted: let a sync find it again
      this.wantConflict = true;
      host.notify('Looking at both zoos…', 'info');
      void this.cloud.sync.syncNow().catch(() => undefined);
      return;
    }
    this.resolving = true;
    try {
      const keep = await this.opts.prompts.chooseConflict(info);
      const r = await this.cloud.sync.resolveConflict(this.key, keep);
      this.conflict = null;
      this.draw();
      if (r === 'reload') await host.switchSlot({ kind: 'continue', player: this.opts.player.ref, slot: 'main' });
    } catch (e) {
      console.warn('[account] conflict', e);
    } finally {
      this.resolving = false;
    }
  }

  update(dt: number): void {
    const host = this.host;
    if (!host || !this.btn) return;
    const vs = !!host.sim.versus;
    if (vs !== this.versus) {
      this.versus = vs;
      this.draw();
    }
    if (this.model?.fades && this.shownFor < BADGE_FADE_S) {
      this.shownFor += dt;
      if (this.shownFor >= BADGE_FADE_S) this.draw();
    }
  }

  handleBack(): boolean {
    return closeTopModal() || closeTopPage();
  }

  onKey(_code: string): boolean {
    // keys go to the open account dialog / page, not to the game
    return modalOpen() || !!document.querySelector('.wh-ac-page');
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.btn?.remove();
    this.btn = null;
  }
}

/** The in-game account extension (mounted by createGameUI when the cloud is enabled). */
export function createAccountExtension(cloud: CloudHandle, opts: { player: PlayerInfo; prompts: SyncPrompts }): AccountExtension {
  return new AccountExt(cloud, opts);
}
