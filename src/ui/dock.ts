// Bottom build dock: category bar, item drawer with thumbnails, the active
// tool bar (options + exit) and the floating confirm bar (✓ Build $X / ✗).

import type { ISimulation } from '../core/contracts';
import type { Tool } from '../core/types';
import { FENCES_BY_ID, POOR_VIEW } from '../data/fences';
import { BIOME_NAME, fenceStatsText, toolKey, type Category, type CategoryId, type CatalogItem } from './catalog';
import { button, el, fmtMoney, iconEl, setText, swallowPointer, toggleClass } from './dom';
import { icon } from './icons';
import { cue } from './sound';
import type { ThumbnailService } from './thumbs';
import type { BulldozeMode, PendingAction } from './tools';

export interface DockHost {
  sim: ISimulation;
  thumbs: ThumbnailService;
  catalog: Category[];
  selectItem(item: CatalogItem): void;
  exitTool(): void;
  drawerOpened(id: CategoryId): void;
  rotate(): void;
  setFenceMode(m: 'rect' | 'line'): void;
  setPathStraight(on: boolean): void;
  setBulldozeMode(m: BulldozeMode): void;
  setBrush(n: number): void;
  confirm(): void;
  cancelPending(): void;
}

interface CardRef {
  item: CatalogItem;
  root: HTMLElement;
  price: HTMLElement;
  thumb: HTMLElement;
  loaded: boolean;
}

const TOOL_HINT: Record<string, string> = {
  fenceRect: 'Drag to outline an enclosure',
  fenceLine: 'Drag to draw a straight run',
  path: 'Drag to lay a path',
  pathStraight: 'Drag to lay a straight path',
  terrain: 'Drag to paint an area, tap for the brush',
  object: 'Tap to place, drag to move',
  animal: 'Tap inside a habitat to check it',
  staff: 'Tap a path to hire',
  bulldoze: 'Drag over things to clear them',
  bulldozeFence: 'Tap a fence run, or drag along fences',
};

/** Card overlay: strength (shield + 4 bars) and how much of the animals guests see (eye + %). */
function fenceStats(f: { strength: number; visibility: number }): HTMLElement {
  const bars = [1, 2, 3, 4].map((i) => `<i${i <= f.strength ? ' class="on"' : ''}></i>`).join('');
  const view = `${Math.round(f.visibility * 100)}%`;
  return el('span', {
    class: 'wh-fstats',
    attrs: { title: fenceStatsText(f) },
    html: `<span class="wh-fbars" aria-label="Strength ${f.strength} of 4">${icon('shield')}${bars}</span><span class="wh-fview${f.visibility < POOR_VIEW ? ' poor' : ''}" aria-label="${view} view">${icon('eye')}${view}</span>`,
  });
}

export class Dock {
  readonly root: HTMLElement;
  private cats: HTMLElement;
  private catBtns = new Map<CategoryId | 'select', HTMLButtonElement>();
  private drawer: HTMLElement;
  private drawerTitle: HTMLElement;
  private drawerSub: HTMLElement;
  private row: HTMLElement;
  private cards = new Map<string, CardRef>();
  private openCat: CategoryId | null = null;
  private toolbar: HTMLElement;
  private tbThumb: HTMLElement;
  private tbName: HTMLElement;
  private tbHint: HTMLElement;
  private tbTip: HTMLElement;
  private tbOpts: HTMLElement;
  private confirmEl: HTMLElement;
  private cfTitle: HTMLElement;
  private cfSub: HTMLElement;
  private cfOk: HTMLButtonElement;
  private cfRotate: HTMLButtonElement;
  private pendingShown = false;
  private activeKey = '';
  private activeCat: CategoryId | null = null;
  private tool: Tool = { kind: 'select' };
  private fenceMode: 'rect' | 'line' = 'rect';
  private pathStraight = false;
  private bulldozeMode: BulldozeMode = 'area';
  /** Tool bar hint replacing the tool's own (e.g. while moving an animal or object). */
  private hintOverride = '';

  constructor(private host: DockHost) {
    // ---- category bar
    this.cats = el('div', 'wh-cats wh-glass');
    const selBtn = button('wh-cat sel on', 'pointer', 'Inspect', () => {
      this.closeDrawer();
      host.exitTool();
    });
    this.catBtns.set('select', selBtn);
    this.cats.append(selBtn);
    for (const c of host.catalog) {
      const b = button('wh-cat', c.icon, c.short, () => this.toggleCategory(c.id), c.name);
      this.catBtns.set(c.id, b);
      this.cats.append(b);
    }

    // ---- drawer
    this.drawerTitle = el('div', 'wh-drawer-title');
    this.drawerSub = el('div', 'wh-drawer-sub');
    this.row = el('div', 'wh-row');
    this.drawer = el('div', 'wh-drawer wh-glass-2 hidden', [
      el('div', 'wh-drawer-head', [this.drawerTitle, this.drawerSub, button('wh-btn-ghost wh-btn-icon', 'close', null, () => this.closeDrawer(), 'Close')]),
      this.row,
    ]);

    // ---- tool bar
    this.tbThumb = el('div', 'wh-tb-thumb');
    this.tbName = el('div', 'wh-tb-name');
    this.tbHint = el('div', 'wh-tb-hint');
    // first few times in build mode: one finger now builds, so say how the camera moves
    this.tbTip = el('div', {
      class: 'wh-tb-tip hidden',
      html: `${icon('fingers')}<span class="wh-only-touch">Two fingers move the camera</span><span class="wh-only-mouse">Right-drag turns, middle-drag moves the camera</span>`,
    });
    this.tbOpts = el('div', 'wh-tb-opts');
    this.toolbar = el('div', 'wh-toolbar wh-glass hidden', [
      this.tbThumb,
      el('div', 'wh-tb-text', [this.tbName, this.tbHint, this.tbTip]),
      this.tbOpts,
      button('wh-btn-ghost wh-tb-done', null, 'Done', () => host.exitTool(), 'Finish building'),
    ]);

    // ---- confirm bar
    this.cfTitle = el('div', 'wh-cf-title');
    this.cfSub = el('div', 'wh-cf-sub');
    this.cfOk = button('wh-btn-primary wh-cf-ok', 'check', 'Build', () => host.confirm());
    this.cfRotate = button('wh-btn-ghost wh-cf-no', 'rotate', null, () => host.rotate(), 'Rotate (R)');
    this.confirmEl = el('div', 'wh-confirm wh-glass-2 hidden', [
      button('wh-btn-ghost wh-cf-no', 'close', null, () => host.cancelPending(), 'Cancel'),
      el('div', 'wh-cf-text', [this.cfTitle, this.cfSub]),
      this.cfRotate,
      this.cfOk,
    ]);

    this.root = el('div', 'wh-bottom', [el('div', 'wh-actions', [this.toolbar, this.confirmEl]), this.drawer, this.cats]);
    for (const e of [this.cats, this.drawer, this.toolbar, this.confirmEl]) swallowPointer(e);
  }

  // ------------------------------------------------------------ drawer
  get drawerOpen(): boolean {
    return this.openCat !== null;
  }

  get openCategoryId(): CategoryId | null {
    return this.openCat;
  }

  /** Category of the tool in hand (null for Inspect and for moving something). */
  get toolCategory(): CategoryId | null {
    return this.activeCat;
  }

  // elements the first-run tour points at (null when not on screen)
  categoryButton(id: CategoryId): HTMLElement | null {
    return this.catBtns.get(id) ?? null;
  }

  cardFor(match: (key: string) => boolean): HTMLElement | null {
    if (!this.openCat) return null;
    for (const [key, c] of this.cards) if (match(key)) return c.root;
    return null;
  }

  /** Scroll the open drawer's row so `card` is in full view (centred when it was not). */
  revealCard(card: HTMLElement): void {
    const row = this.row;
    const left = card.offsetLeft - row.scrollLeft;
    if (left >= 0 && left + card.offsetWidth <= row.clientWidth) return;
    row.scrollLeft = card.offsetLeft - (row.clientWidth - card.offsetWidth) / 2;
  }

  get drawerEl(): HTMLElement | null {
    return this.openCat ? this.drawer : null;
  }

  get toolbarEl(): HTMLElement | null {
    return this.toolbar.classList.contains('hidden') ? null : this.toolbar;
  }

  get confirmBarEl(): HTMLElement | null {
    return this.confirmVisible ? this.confirmEl : null;
  }

  /** Show or hide the camera-gesture line on the tool bar. */
  setCameraTip(on: boolean): void {
    toggleClass(this.tbTip, 'hidden', !on);
  }

  toggleCategory(id: CategoryId): void {
    if (this.openCat === id) this.closeDrawer();
    else this.openCategory(id);
  }

  openCategory(id: CategoryId): void {
    const cat = this.host.catalog.find((c) => c.id === id);
    if (!cat) return;
    if (this.openCat === null) cue('open');
    else if (this.openCat !== id) cue('tap');
    this.openCat = id;
    this.host.drawerOpened(id);
    setText(this.drawerTitle, cat.name);
    setText(this.drawerSub, cat.hint);
    this.row.textContent = '';
    this.cards.clear();
    let section = '';
    for (const item of cat.items) {
      if (item.section !== section && cat.items.some((i) => i.section !== cat.items[0].section)) {
        section = item.section;
        this.row.append(el('div', { class: 'wh-sec', text: section }));
      }
      this.row.append(this.card(item));
    }
    this.drawer.classList.remove('hidden');
    this.syncActions();
    this.refreshCats();
    this.refreshAffordability();
    // Start at the first item, or centre the active one. Only after un-hiding: a scrollLeft write
    // on a display:none row is dropped and the previous tab's offset comes back. Not scrollIntoView,
    // which would also scroll the HUD layer behind the drawer.
    const active = this.cards.get(this.activeKey);
    this.row.scrollLeft = active ? active.root.offsetLeft - (this.row.clientWidth - active.root.offsetWidth) / 2 : 0;
  }

  closeDrawer(): void {
    if (this.openCat === null) return;
    cue('close');
    this.openCat = null;
    this.drawer.classList.add('hidden');
    this.syncActions();
    this.refreshCats();
  }

  private card(item: CatalogItem): HTMLElement {
    const thumb = el('div', 'wh-thumb');
    thumb.append(iconEl(item.icon));
    if (item.biome && item.thumb.kind === 'animal') thumb.append(el('span', { class: 'wh-thumb-biome', text: BIOME_NAME[item.biome] }));
    if (item.fence) thumb.append(fenceStats(item.fence));
    const price = el('div', 'wh-card-price');
    const p = item.price();
    price.textContent = p > 0 ? `${fmtMoney(p)}${item.priceSuffix}` : item.tool.kind === 'bulldoze' ? 'Refund' : '';
    const wide = item.thumb.kind === 'animal' || item.thumb.kind === 'staff';
    const desc = wide ? el('div', { class: 'wh-card-desc', text: item.description.split(/(?<=\.)\s/)[0] }) : null;
    const root = el('div', { class: `wh-card${wide ? ' wide' : ''}`, title: item.description, attrs: { role: 'button' } }, [
      thumb,
      el('div', { class: 'wh-card-name', text: item.name }),
      desc,
      price,
    ]);
    root.addEventListener('click', (ev) => {
      ev.stopPropagation();
      cue('tap');
      this.host.selectItem(item);
    });
    const ref: CardRef = { item, root, price, thumb, loaded: false };
    this.cards.set(item.key, ref);
    toggleClass(root, 'on', item.key === this.activeKey);
    this.loadThumb(ref);
    return root;
  }

  private loadThumb(ref: CardRef): void {
    this.host.thumbs.request(ref.item.thumb, (url) => {
      if (ref.loaded) return;
      ref.loaded = true;
      const img = el('img', { attrs: { alt: '', draggable: 'false' } });
      if (ref.item.thumb.kind === 'terrain' || ref.item.thumb.kind === 'path') img.className = 'swatch';
      img.src = url;
      const ico = ref.thumb.querySelector('.wh-icon-wrap');
      if (ico) ico.remove();
      ref.thumb.prepend(img);
      if (this.activeKey === ref.item.key) this.setToolbarThumb(ref.item);
    });
  }

  /** Grey out unaffordable items (called a few times a second). */
  refreshAffordability(): void {
    if (!this.openCat) return;
    const money = this.host.sim.money;
    for (const c of this.cards.values()) {
      const p = c.item.price();
      toggleClass(c.root, 'cant', p > money && c.item.priceSuffix !== '/day');
    }
  }

  private refreshCats(): void {
    for (const [id, b] of this.catBtns) {
      const on = id === 'select' ? this.tool.kind === 'select' && !this.openCat : this.openCat === id || (!this.openCat && this.activeCat === id);
      toggleClass(b, 'on', on);
    }
  }

  // ------------------------------------------------------------ tool bar
  /**
   * Show the active tool. `label` renames the tool bar for a tool used for something other
   * than its catalogue item (moving an existing animal or object); no card or category lights up.
   */
  setTool(tool: Tool, item: CatalogItem | null, label?: { name: string; hint: string }): void {
    this.tool = tool;
    this.hintOverride = label?.hint ?? '';
    const key = label ? 'move' : item?.key ?? toolKey(tool);
    if (key !== this.activeKey) {
      const prev = this.cards.get(this.activeKey);
      if (prev) prev.root.classList.remove('on');
      this.activeKey = key;
      const cur = this.cards.get(key);
      if (cur) cur.root.classList.add('on');
    }
    if (tool.kind === 'select') {
      this.activeCat = null;
      this.syncActions();
      this.refreshCats();
      return;
    }
    if (item) {
      this.activeCat = label ? null : this.host.catalog.find((c) => c.items.includes(item))?.id ?? null;
      this.setToolbarThumb(item);
    }
    const name = label?.name ?? item?.name;
    if (name) setText(this.tbName, name);
    this.buildOptions();
    this.syncActions();
    this.refreshCats();
  }

  private setToolbarThumb(item: CatalogItem): void {
    const url = this.host.thumbs.get(item.thumb);
    this.tbThumb.textContent = '';
    if (url) {
      const img = el('img', { attrs: { alt: '', draggable: 'false' } });
      if (item.thumb.kind === 'terrain' || item.thumb.kind === 'path') img.className = 'swatch';
      img.src = url;
      this.tbThumb.append(img);
    } else this.tbThumb.append(iconEl(item.icon));
  }

  private buildOptions(): void {
    const t = this.tool;
    this.tbOpts.textContent = '';
    let hint = '';
    switch (t.kind) {
      case 'fence': {
        const rect = button(`wh-btn-ghost ${this.fenceMode === 'rect' ? 'on' : ''}`, 'rect', null, () => this.setFenceMode('rect'), 'Rectangle');
        const line = button(`wh-btn-ghost ${this.fenceMode === 'line' ? 'on' : ''}`, 'line', null, () => this.setFenceMode('line'), 'Straight line');
        this.tbOpts.append(rect, line);
        hint = this.fenceMode === 'rect' ? TOOL_HINT.fenceRect : TOOL_HINT.fenceLine;
        // the chosen fence's strength and view come first: they are what the choice is about
        const def = FENCES_BY_ID[t.fenceId];
        if (def) hint = `${fenceStatsText(def)} · ${hint}`;
        break;
      }
      case 'path': {
        const b = button(`wh-btn-ghost ${this.pathStraight ? 'on' : ''}`, 'line', null, () => {
          this.pathStraight = !this.pathStraight;
          this.host.setPathStraight(this.pathStraight);
          this.buildOptions();
        }, 'Straight only');
        this.tbOpts.append(b);
        hint = this.pathStraight ? TOOL_HINT.pathStraight : TOOL_HINT.path;
        break;
      }
      case 'terrain': {
        const b = button('wh-btn-ghost', 'brush', null, () => {
          const next = t.brush >= 5 ? 1 : t.brush + 2;
          this.host.setBrush(next);
        }, 'Brush size');
        b.insertAdjacentHTML('beforeend', `<span class="wh-brush-n">${t.brush}</span>`);
        this.tbOpts.append(b);
        hint = TOOL_HINT.terrain;
        break;
      }
      case 'object':
        this.tbOpts.append(button('wh-btn-ghost', 'rotate', null, () => this.host.rotate(), 'Rotate (R)'));
        hint = TOOL_HINT.object;
        break;
      case 'animal':
        hint = TOOL_HINT.animal;
        break;
      case 'staff':
        hint = TOOL_HINT.staff;
        break;
      case 'bulldoze': {
        const area = button(`wh-btn-ghost ${this.bulldozeMode === 'area' ? 'on' : ''}`, 'rect', null, () => this.setBulldozeMode('area'), 'Clear an area');
        const fence = button(`wh-btn-ghost ${this.bulldozeMode === 'fence' ? 'on' : ''}`, 'fence', null, () => this.setBulldozeMode('fence'), 'Fences only');
        this.tbOpts.append(area, fence);
        hint = this.bulldozeMode === 'fence' ? TOOL_HINT.bulldozeFence : TOOL_HINT.bulldoze;
        break;
      }
      default:
        break;
    }
    setText(this.tbHint, this.hintOverride || hint);
  }

  private setBulldozeMode(m: BulldozeMode): void {
    this.bulldozeMode = m;
    this.host.setBulldozeMode(m);
    this.buildOptions();
  }

  private setFenceMode(m: 'rect' | 'line'): void {
    this.fenceMode = m;
    this.host.setFenceMode(m);
    this.buildOptions();
  }

  // ------------------------------------------------------------ confirm bar
  /**
   * One compact row over the dock: the confirm bar replaces the tool bar while a decision is
   * pending, but not while a build drawer is open (a stray tap there must not buy anything).
   */
  private syncActions(): void {
    const confirm = this.pendingShown && this.openCat === null;
    toggleClass(this.confirmEl, 'hidden', !confirm);
    toggleClass(this.toolbar, 'hidden', confirm || this.tool.kind === 'select');
  }

  showPending(p: PendingAction | null): void {
    this.pendingShown = !!p;
    this.syncActions();
    if (!p) return;
    this.cfRotate.style.display = this.tool.kind === 'object' ? '' : 'none';
    setText(this.cfTitle, p.title);
    const refund = p.cost < 0;
    const amount = refund ? `+${fmtMoney(-p.cost)}` : p.cost > 0 ? fmtMoney(p.cost) : '';
    let sub = p.note ?? '';
    let kind: 'bad' | 'warn' | '' = p.noteKind ?? '';
    if (!sub) {
      if (refund) sub = p.refundFraction === 1 ? 'Full refund — just built' : 'Refund on removal';
      else if (this.tool.kind === 'staff') sub = 'Wage paid at day end (first day pro rata)';
      else sub = `Tap ${p.verb} to confirm`;
      kind = '';
    }
    setText(this.cfSub, sub);
    this.cfSub.className = `wh-cf-sub ${kind}`;
    this.cfOk.innerHTML = `${icon('check')}<span class="wh-btn-label">${p.verb}${amount ? ` ${amount}` : ''}${this.tool.kind === 'staff' && p.cost > 0 ? '/day' : ''}</span>`;
    this.cfOk.disabled = !p.ok;
    toggleClass(this.cfOk, 'remove', p.verb === 'Remove');
    toggleClass(this.cfOk, 'risky', !!p.risky);
  }

  shake(): void {
    this.confirmEl.classList.remove('shake');
    void this.confirmEl.offsetWidth;
    this.confirmEl.classList.add('shake');
  }

  get confirmVisible(): boolean {
    return !this.confirmEl.classList.contains('hidden');
  }

  dispose(): void {
    this.root.remove();
  }
}
