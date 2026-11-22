// Wildhaven UI module — public API:
//   createGameUI(root, deps)      → IGameUI (HUD, build dock, tools, panels, camera, input)
//   showLoadingScreen(root)       → { setProgress, hide }
//   showMainMenu(root, opts)      → Promise<'continue' | 'new'>

import { ENTRANCE_TILE, TILE } from '../core/constants';
import type { IGameUI, QualityLevel, SimSpeed, UIDeps } from '../core/contracts';
import type { SelectionRef, Tool } from '../core/types';
import { CameraController } from './camera';
import { buildCatalog, type CatalogItem, type Category, type CategoryId } from './catalog';
import { Dock } from './dock';
import { el, toggleClass } from './dom';
import { Hud } from './hud';
import { InputController } from './input';
import { CostLabel, Celebration, MoneyPopups, Toasts } from './notify';
import { InfoPanel, SpeciesCard } from './panels';
import { ensureStyles } from './styles';
import { ThumbnailService } from './thumbs';
import { ToolManager, type PendingAction } from './tools';
import { ZooPanel, type ZooTab } from './zoopanel';

export { showLoadingScreen, showMainMenu } from './screens';
export { CameraController } from './camera';

/** IGameUI plus a few hooks used by the harness / main for automation. */
export interface GameUIHandle extends IGameUI {
  readonly camera: CameraController;
  readonly tools: ToolManager;
  select(sel: SelectionRef | null): void;
  setTool(tool: Tool): void;
  openCategory(id: CategoryId | null): void;
  openZooPanel(tab?: ZooTab): void;
}

const DEG = Math.PI / 180;

class GameUI implements GameUIHandle {
  readonly camera: CameraController;
  readonly tools: ToolManager;
  private root: HTMLElement;
  private thumbs: ThumbnailService;
  private catalog: Category[];
  private hud: Hud;
  private dock: Dock;
  private info: InfoPanel;
  private species: SpeciesCard;
  private zoo: ZooPanel;
  private toasts: Toasts;
  private popups: MoneyPopups;
  private costLabel: CostLabel;
  private cele: Celebration;
  private input: InputController;
  private offs: (() => void)[] = [];
  private selection: SelectionRef | null = null;
  private followSel: SelectionRef | null = null;
  private followPos = { x: 0, z: 0 };
  private vw = window.innerWidth;
  private vh = window.innerHeight;
  private affordAcc = 0;
  private disposed = false;
  private backArmed = false;

  constructor(
    host: HTMLElement,
    private deps: UIDeps,
  ) {
    ensureStyles();
    const { sim, ctx, props, creatures } = deps;
    this.root = el('div', 'wh-ui');
    if (ctx.quality.level === 'low') this.root.classList.add('wh-noblur');
    host.append(this.root);

    // ---- camera
    this.camera = new CameraController(ctx.camera, sim.world, (x, z, r) => ctx.setFocus(x, z, r));
    this.resetView();
    this.camera.onFollowEnd = () => {
      this.followSel = null;
      this.info.syncFollow();
    };

    // ---- services
    this.thumbs = new ThumbnailService(ctx.renderer, props, creatures, ctx.scene);
    this.catalog = buildCatalog(sim);
    this.tools = new ToolManager({
      sim,
      ctx,
      props,
      creatures,
      onPending: (p) => this.onPending(p),
      onLabel: (pos, text, sub, ok) => this.costLabel.set(pos, text, sub, ok),
      onAnimalPreview: (info) => {
        if (!info) {
          this.species.hide();
          return;
        }
        const hab = info.habitatId ? sim.world.habitats.get(info.habitatId) : undefined;
        this.species.setSuitability(info.suitability, hab?.name ?? null, info.result && !info.result.ok ? info.result.reason ?? null : null);
      },
      onCommitted: () => this.hud.refresh(),
    });

    // ---- DOM widgets
    this.popups = new MoneyPopups(ctx.camera, (x, z) => sim.world.heightAt(x, z));
    this.costLabel = new CostLabel(ctx.camera);
    this.hud = new Hud({ sim, openMenu: (tab) => this.openZooPanel(tab), setSpeed: (s) => this.setSpeed(s) });
    this.dock = new Dock({
      sim,
      thumbs: this.thumbs,
      catalog: this.catalog,
      selectItem: (item) => this.selectItem(item),
      exitTool: () => this.setTool({ kind: 'select' }),
      drawerOpened: () => this.select(null),
      rotate: () => this.tools.rotate(),
      setFenceMode: (m) => this.tools.setFenceMode(m),
      setPathStraight: (on) => this.tools.setPathStraight(on),
      setBrush: (n) => {
        const t = this.tools.tool;
        if (t.kind === 'terrain') this.setTool({ ...t, brush: n });
      },
      confirm: () => this.confirm(),
      cancelPending: () => this.tools.cancelPending(),
    });
    this.info = new InfoPanel({
      sim,
      thumbs: this.thumbs,
      uiRoot: this.root,
      select: (s) => this.select(s),
      focusOn: (x, z, d) => this.camera.focusOn(x, z, d),
      toggleFollow: (s) => this.toggleFollow(s),
      isFollowing: (s) => !!this.followSel && this.followSel.kind === s.kind && this.followSel.id === s.id,
      openAnimals: () => this.openCategory('animals'),
    });
    this.species = new SpeciesCard(this.thumbs, () => this.species.hide());
    this.zoo = new ZooPanel({
      sim,
      ctx,
      uiRoot: this.root,
      save: () => deps.save(),
      newGame: () => deps.newGame(),
      toast: (t, k) => this.toasts.show(t, k),
      qualityChanged: (q) => this.qualityChanged(q),
    });
    this.toasts = new Toasts((x, z) => this.camera.focusOn(x, z, Math.min(this.camera.distance, 34)));
    this.cele = new Celebration(this.toasts.root);

    this.root.append(
      this.popups.root,
      this.costLabel.root,
      this.hud.root,
      this.species.sheet.root,
      this.info.sheet.root,
      this.dock.root,
      this.toasts.root,
      this.zoo.root,
    );

    // ---- input
    this.input = new InputController(ctx.renderer.domElement, this.camera, {
      tool: this.tools,
      select: (x, y) => this.pickAt(x, y),
      touchedView: () => this.dock.closeDrawer(),
      key: (code) => this.onKey(code),
    });

    // ---- events
    const ev = sim.events;
    this.offs.push(
      ev.on('notify', (n) => this.toasts.show(n.text, n.kind, n.focus)),
      ev.on('objectiveCompleted', (o) => this.cele.show(o.text, o.reward)),
      ev.on('moneyPopup', (m) => this.popups.spawn(m.x, m.z, m.amount)),
      ev.on('commandResult', (r) => {
        if (!r.ok && this.dock.confirmVisible) this.dock.shake();
      }),
      ev.on('worldReset', () => {
        this.select(null);
        this.setTool({ kind: 'select' });
        this.resetView();
      }),
      ev.on('animalRemoved', (e) => this.dropIfSelected('animal', e.id)),
      ev.on('guestRemoved', (e) => this.dropIfSelected('guest', e.id)),
      ev.on('staffRemoved', (e) => this.dropIfSelected('staff', e.id)),
      ev.on('objectRemoved', (e) => this.dropIfSelected('object', e.id)),
      ev.on('habitatsChanged', () => {
        const s = this.selection;
        if (s && s.kind === 'habitat' && !sim.world.habitats.has(s.id)) this.select(null);
      }),
    );
    // Android back button (WebView history): close the top-most layer instead of leaving the app
    const onPop = () => {
      this.backArmed = false;
      this.onKey('Escape');
    };
    window.addEventListener('popstate', onPop);
    this.offs.push(() => window.removeEventListener('popstate', onPop));
    const onResize = () => {
      this.vw = window.innerWidth;
      this.vh = window.innerHeight;
    };
    window.addEventListener('resize', onResize);
    this.offs.push(() => window.removeEventListener('resize', onResize));
  }

  private resetView(): void {
    const x = (ENTRANCE_TILE.x + 0.5) * TILE;
    const z = (ENTRANCE_TILE.z - 9) * TILE;
    this.camera.setView(x, z, 52, 12 * DEG, 42 * DEG);
  }

  // ------------------------------------------------------------ selection
  private pickAt(ndcX: number, ndcY: number): void {
    let sel: SelectionRef | null = null;
    try {
      sel = this.deps.views.pick(ndcX, ndcY);
    } catch (err) {
      console.warn('[ui] pick failed', err);
    }
    if (!sel) {
      // fall back to the habitat under the finger
      const p = this.deps.ctx.pickGround(ndcX, ndcY);
      if (p) {
        const t = this.deps.sim.world.tileOfWorld(p.x, p.z);
        const hab = this.deps.sim.world.habitatAt(t.x, t.z);
        if (hab) sel = { kind: 'habitat', id: hab.id };
      }
    }
    this.select(sel);
  }

  select(sel: SelectionRef | null): void {
    const prev = this.selection;
    const same = prev && sel && prev.kind === sel.kind && prev.id === sel.id;
    if (same) return;
    if (sel && this.tools.active) this.setTool({ kind: 'select' });
    if (sel) this.dock.closeDrawer();
    this.selection = sel;
    try {
      this.deps.views.setSelected(sel);
    } catch (err) {
      console.warn('[ui] setSelected failed', err);
    }
    if (prev?.kind === 'object' && sel?.kind !== 'object') this.deps.props.setHighlight(null);
    if (sel?.kind === 'object') this.deps.props.setHighlight(sel.id);
    this.tools.showHabitatOutline(sel?.kind === 'habitat' ? sel.id : null);
    if (this.followSel && (!sel || sel.kind !== this.followSel.kind || sel.id !== this.followSel.id)) this.camera.stopFollow();
    this.info.show(sel);
    this.deps.sim.events.emit('selectionChanged', { selection: sel });
  }

  private dropIfSelected(kind: SelectionRef['kind'], id: number): void {
    const s = this.selection;
    if (s && s.kind === kind && s.id === id) this.select(null);
  }

  private toggleFollow(sel: SelectionRef): void {
    if (this.followSel && this.followSel.kind === sel.kind && this.followSel.id === sel.id) {
      this.camera.stopFollow();
      return;
    }
    const sim = this.deps.sim;
    const pos = this.followPos;
    const get = (): { x: number; z: number } | null => {
      const e = sel.kind === 'animal' ? sim.animals.get(sel.id) : sel.kind === 'guest' ? sim.guests.get(sel.id) : sel.kind === 'staff' ? sim.staff.get(sel.id) : undefined;
      if (!e) return null;
      pos.x = e.x;
      pos.z = e.z;
      return pos;
    };
    if (!get()) return;
    this.camera.stopFollow();
    this.followSel = sel;
    this.camera.follow(get, 20);
  }

  // ------------------------------------------------------------ tools
  private selectItem(item: CatalogItem): void {
    // keep the brush size when switching terrain types
    let tool = item.tool;
    const cur = this.tools.tool;
    if (tool.kind === 'terrain' && cur.kind === 'terrain') tool = { ...tool, brush: cur.brush };
    if (tool.kind === 'object' && cur.kind === 'object') tool = { ...tool, rot: cur.rot };
    this.applyTool(tool, item);
    this.dock.closeDrawer();
  }

  setTool(tool: Tool): void {
    const key = (t: Tool) => JSON.stringify(t);
    const item = this.catalog.flatMap((c) => c.items).find((i) => {
      if (i.tool.kind !== tool.kind) return false;
      if (tool.kind === 'terrain' && i.tool.kind === 'terrain') return i.tool.terrain === tool.terrain;
      if (tool.kind === 'object' && i.tool.kind === 'object') return i.tool.defId === tool.defId;
      return key(i.tool) === key(tool);
    });
    this.applyTool(tool, item ?? null);
  }

  private applyTool(tool: Tool, item: CatalogItem | null): void {
    if (tool.kind !== 'select') this.select(null);
    this.input.reset();
    this.tools.setTool(tool);
    this.dock.setTool(tool, item);
    if (tool.kind === 'animal') this.species.show(tool.speciesId);
    else this.species.hide();
    this.deps.sim.events.emit('toolChanged', { tool });
  }

  openCategory(id: CategoryId | null): void {
    if (id) this.dock.openCategory(id);
    else this.dock.closeDrawer();
  }

  private onPending(p: PendingAction | null): void {
    this.dock.showPending(p);
  }

  private confirm(): void {
    const r = this.tools.confirm();
    if (r && !r.ok) this.dock.shake();
  }

  // ------------------------------------------------------------ misc
  openZooPanel(tab?: ZooTab): void {
    this.dock.closeDrawer();
    this.zoo.open(tab);
  }

  private setSpeed(s: SimSpeed): void {
    this.deps.sim.setSpeed(s);
    this.hud.refresh();
  }

  private qualityChanged(q: QualityLevel): void {
    this.root.classList.toggle('wh-noblur', q === 'low');
  }

  private onKey(code: string): boolean {
    switch (code) {
      case 'Escape':
        if (this.zoo.isOpen) this.zoo.close();
        else if (this.tools.hasPending) this.tools.cancelPending();
        else if (this.dock.drawerOpen) this.dock.closeDrawer();
        else if (this.tools.active) this.setTool({ kind: 'select' });
        else if (this.selection) this.select(null);
        else return false;
        return true;
      case 'Enter':
      case 'NumpadEnter':
        if (!this.tools.hasPending) return false;
        this.confirm();
        return true;
      case 'KeyR':
        if (this.tools.tool.kind !== 'object') return false;
        this.tools.rotate();
        return true;
      case 'Space': {
        const sim = this.deps.sim;
        this.setSpeed(sim.speed === 0 ? 1 : 0);
        return true;
      }
      case 'Digit1':
      case 'Digit2':
      case 'Digit3':
        this.setSpeed(Number(code.slice(5)) as SimSpeed);
        return true;
      case 'Digit0':
        this.setSpeed(0);
        return true;
      case 'KeyF': {
        const s = this.selection;
        if (s && (s.kind === 'animal' || s.kind === 'guest' || s.kind === 'staff')) {
          this.toggleFollow(s);
          this.info.syncFollow();
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  // ------------------------------------------------------------ frame
  update(dt: number): void {
    if (this.disposed) return;
    toggleClass(this.root, 'sheet-open', this.info.sheet.open);
    toggleClass(this.root, 'card-open', this.species.visible);
    if (!this.backArmed && (this.zoo.isOpen || this.dock.drawerOpen || this.tools.active || this.selection)) {
      try {
        history.pushState({ wildhaven: 1 }, '');
        this.backArmed = true;
      } catch {
        /* history unavailable */
      }
    }
    this.camera.update(dt);
    this.tools.update(dt);
    this.thumbs.update();
    this.hud.update(dt);
    this.info.update(dt);
    this.zoo.update(dt);
    this.popups.update(dt, this.vw, this.vh);
    this.costLabel.update(this.vw, this.vh);
    this.affordAcc += dt;
    if (this.affordAcc > 0.5) {
      this.affordAcc = 0;
      this.dock.refreshAffordability();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs = [];
    this.input.dispose();
    this.camera.stopFollow();
    this.tools.dispose();
    this.thumbs.dispose();
    this.toasts.dispose();
    this.cele.dispose();
    this.root.remove();
  }
}

export function createGameUI(root: HTMLElement, deps: UIDeps): GameUIHandle {
  return new GameUI(root, deps);
}

export type { ZooTab } from './zoopanel';
export type { CategoryId } from './catalog';
