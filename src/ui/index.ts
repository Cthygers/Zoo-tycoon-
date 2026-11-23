import type * as THREE from 'three';
// Wildhaven UI module — public API:
//   createGameUI(root, deps)      → IGameUI (HUD, build dock, tools, panels, camera, input)
//   showLoadingScreen(root)       → { setProgress, hide }
//   showMainMenu(root, opts)      → Promise<'continue' | 'new'>

import { ENTRANCE_TILE, TILE } from '../core/constants';
import type { IGameUI, QualityLevel, SimSpeed, UIDeps } from '../core/contracts';
import type { SelectionRef, Tool } from '../core/types';
import { OBJECTS_BY_ID } from '../data/objects';
import { CameraController } from './camera';
import { buildCatalog, type CatalogItem, type Category, type CategoryId } from './catalog';
import { Coach } from './coach';
import { Dock } from './dock';
import { el, toggleClass } from './dom';
import { Hud } from './hud';
import { InputController } from './input';
import { CostLabel, Celebration, MoneyPopups, Toasts } from './notify';
import { InfoPanel, SpeciesCard, closeTopDialog, dialogOpen } from './panels';
import { bindAudio, cue } from './sound';
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
  startMove(sel: SelectionRef): void;
  openCategory(id: CategoryId | null): void;
  openZooPanel(tab?: ZooTab): void;
}

const DEG = Math.PI / 180;
/** The "Applying graphics settings…" line stays up at least this long (ms), so it never just flickers. */
const APPLYING_MIN_MS = 1200;
/** …and at most this long (ms), whatever happens to the creature rebuild. */
const APPLYING_MAX_MS = 30000;
/** Without a completion signal from the creature factory: rough rebuild time per species on a phone (ms). */
const REBUILD_MS_PER_SPECIES = 700;

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
  private coach: Coach;
  private input: InputController;
  private offs: (() => void)[] = [];
  private selection: SelectionRef | null = null;
  private followSel: SelectionRef | null = null;
  private followPos = { x: 0, z: 0 };
  private vw = window.innerWidth;
  private vh = window.innerHeight;
  private affordAcc = 0;
  private bottomTop = window.innerHeight;
  private disposed = false;
  private backArmed = false;
  private selectNextFrame: SelectionRef | null = null;
  /** Which bottom / side panels were up when the toast column was last laid out. */
  private panelsKey = -1;
  /** Frames left before asking the creature factory about a quality change (0 = not waiting). */
  private qualityFrames = 0;
  /** Bumped per quality change, so only the latest one clears the "Applying…" line. */
  private qualityRun = 0;
  private qualityShownAt = 0;
  private applyingQuality = false;

  constructor(
    host: HTMLElement,
    private deps: UIDeps,
  ) {
    ensureStyles();
    bindAudio(deps.audio);
    const { sim, ctx, props, creatures } = deps;
    this.root = el('div', 'wh-ui');
    if (ctx.quality.level === 'low') this.root.classList.add('wh-noblur');
    host.append(this.root);
    // The HUD layer must never scroll (it would shift every chip and button sideways). overflow: clip
    // prevents it; this guard covers WebViews without clip support.
    this.root.addEventListener('scroll', () => {
      this.root.scrollLeft = 0;
      this.root.scrollTop = 0;
    });

    // ---- camera
    this.camera = new CameraController(ctx.camera, sim.world, (x, z, r) => ctx.setFocus(x, z, r));
    this.resetView();
    this.camera.onFollowEnd = () => {
      this.followSel = null;
      this.info.syncFollow();
    };

    // ---- services
    this.thumbs = new ThumbnailService(ctx.renderer, props, creatures, ctx.scene, `q-${ctx.quality.level}`);
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
    const focusEvent = (x: number, z: number) => this.focusClear(x, z, Math.min(this.camera.distance, 34));
    this.toasts = new Toasts(focusEvent, () => ({ day: sim.day, minute: sim.minuteOfDay }));
    this.hud = new Hud({ sim, log: this.toasts.log, openMenu: (tab) => this.openZooPanel(tab), setSpeed: (s) => this.setSpeed(s) });
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
      setBulldozeMode: (m) => this.tools.setBulldozeMode(m),
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
      focusOn: (x, z, d) => this.focusClear(x, z, d),
      toggleFollow: (s) => this.toggleFollow(s),
      isFollowing: (s) => !!this.followSel && this.followSel.kind === s.kind && this.followSel.id === s.id,
      openAnimals: () => this.openCategory('animals'),
      startMove: (s) => this.startMove(s),
    });
    this.species = new SpeciesCard(this.thumbs, () => this.species.hide());
    this.zoo = new ZooPanel({
      sim,
      ctx,
      audio: deps.audio,
      uiRoot: this.root,
      save: () => deps.save(),
      newGame: () => deps.newGame(),
      toast: (t, k) => this.toasts.show(t, k),
      qualityChanged: (q) => this.qualityChanged(q),
      qualityApplying: () => this.applyingQuality,
      log: this.toasts.log,
      focus: focusEvent,
    });
    this.cele = new Celebration(this.toasts.root);
    const dock = this.dock;
    this.coach = new Coach({
      sim,
      tool: () => ({ tool: this.tools.tool, moving: !!this.tools.moving }),
      openCategory: () => dock.openCategoryId,
      categoryButton: (id) => dock.categoryButton(id),
      card: (match) => dock.cardFor(match),
      drawer: () => dock.drawerEl,
      toolBar: () => dock.toolbarEl,
      confirmBar: () => dock.confirmBarEl,
      hudBottom: () => this.hud.root.offsetTop + this.hud.root.offsetHeight,
      busy: () => this.zoo.isOpen || dialogOpen() || this.info.sheet.open,
      openBuildCategory: (id) => this.openCategory(id),
      openGoals: () => this.openZooPanel('goals'),
      toast: (text, kind) => this.toasts.show(text, kind),
    });

    this.root.append(
      this.popups.root,
      this.costLabel.root,
      this.hud.root,
      this.coach.pill,
      this.species.sheet.root,
      this.info.sheet.root,
      this.dock.root,
      this.coach.bubble,
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
      ev.on('objectiveCompleted', (o) => {
        this.cele.show(o.text, o.reward);
        this.layoutToasts(); // toasts under the new card make way at once
      }),
      ev.on('moneyPopup', (m) => this.popups.spawn(m.x, m.z, m.amount)),
      ev.on('commandResult', (r) => {
        if (!r.ok && this.dock.confirmVisible) this.dock.shake();
      }),
      ev.on('worldReset', () => {
        this.select(null);
        this.setTool({ kind: 'select' });
        this.resetView();
        this.coach.reset();
      }),
      ev.on('terrainChanged', (r) => this.coach.terrainPainted(r)),
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
      this.handleBack();
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
    if (sel) cue('select');
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
    if (sel && this.info.sheet.open) this.keepInView(sel);
    this.deps.sim.events.emit('selectionChanged', { selection: sel });
  }

  /**
   * Screen rect (px) of the 3D view that no HUD element covers: below the top bar, above the
   * dock, and beside the info sheet (landscape) or above it (portrait).
   */
  private clearArea(): { x0: number; y0: number; x1: number; y1: number } {
    const hud = this.hud.root;
    const a = { x0: 0, y0: hud.offsetTop + hud.offsetHeight, x1: this.vw, y1: this.dock.root.offsetTop || this.vh };
    if (this.info.sheet.open) {
      // layout box, not getBoundingClientRect: the sheet may still be sliding in
      const s = this.info.sheet.root;
      if (s.offsetWidth < this.vw * 0.7) a.x1 = Math.min(a.x1, s.offsetLeft);
      else a.y1 = Math.min(a.y1, s.offsetTop);
    }
    return a;
  }

  /**
   * Keep the toast column clear of the next-goal pill (it drops below the pill where the two
   * would meet) and of the dock, drawer, tool bar and confirm bar under it (Toasts.setRoom:
   * only what fits is shown, the rest waits).
   */
  private layoutToasts(): void {
    const col = this.toasts.root;
    const pill = this.coach.pill;
    let top = '';
    if (getComputedStyle(pill).visibility !== 'hidden') {
      const p = pill.getBoundingClientRect();
      const c = col.getBoundingClientRect();
      if (c.left < p.right + 8 && c.right > p.left - 8) top = `${Math.round(p.bottom + 8)}px`;
    }
    if (col.style.top !== top) col.style.top = top;
    const room = this.clearArea().y1 - col.offsetTop - 6;
    this.cele.setRoom(room);
    this.toasts.setRoom(room);
  }

  /** Fly the camera to a ground point, centring it in the part of the view that panels leave clear. */
  private focusClear(x: number, z: number, distance?: number): void {
    const a = this.clearArea();
    this.camera.focusAt(x, z, (a.x0 + a.x1) / this.vw - 1, 1 - (a.y0 + a.y1) / this.vh, distance);
  }

  /** A new selection under the info sheet that opened for it (or off-screen) is brought into the clear area. */
  private keepInView(sel: SelectionRef): void {
    let p: THREE.Vector3 | null = null;
    try {
      p = this.deps.views.positionOf(sel);
    } catch (err) {
      console.warn('[ui] positionOf failed', err);
    }
    if (!p) return;
    const { x, z } = p;
    p.project(this.deps.ctx.camera);
    const sx = (p.x * 0.5 + 0.5) * this.vw;
    const sy = (0.5 - p.y * 0.5) * this.vh;
    const a = this.clearArea();
    const m = 36; // room for the selection ring around the thing's ground point
    if (p.z < 1 && sx > a.x0 + m && sx < a.x1 - m && sy > a.y0 + m && sy < a.y1 - m) return;
    this.focusClear(x, z);
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
    this.applyTool(tool, this.itemFor(tool));
  }

  /** The catalogue card a tool belongs to (null for tools with no card). */
  private itemFor(tool: Tool): CatalogItem | null {
    const key = (t: Tool) => JSON.stringify(t);
    const item = this.catalog.flatMap((c) => c.items).find((i) => {
      if (i.tool.kind !== tool.kind) return false;
      if (tool.kind === 'terrain' && i.tool.kind === 'terrain') return i.tool.terrain === tool.terrain;
      if (tool.kind === 'object' && i.tool.kind === 'object') return i.tool.defId === tool.defId;
      return key(i.tool) === key(tool);
    });
    return item ?? null;
  }

  /** Pick up the selected animal or object; the placement tool's ghost and confirm bar put it down elsewhere, free. */
  startMove(sel: SelectionRef): void {
    if (sel.kind !== 'animal' && sel.kind !== 'object') return;
    const sim = this.deps.sim;
    const name = sel.kind === 'animal' ? sim.animals.get(sel.id)?.name : OBJECTS_BY_ID[sim.world.objects.get(sel.id)?.defId ?? '']?.name;
    if (!name) return;
    this.select(null);
    this.dock.closeDrawer();
    this.input.reset();
    const entering = !this.tools.active;
    const tool = this.tools.startMove({ kind: sel.kind, id: sel.id });
    if (!tool) return;
    if (entering) this.enteredBuildMode();
    const hint = sel.kind === 'animal' ? 'Tap a spot inside a habitat' : 'Drag it to its new spot';
    this.dock.setTool(tool, this.itemFor(tool), { name: `Move ${name}`, hint });
    if (tool.kind === 'animal') this.species.show(tool.speciesId);
    else this.species.hide();
    sim.events.emit('toolChanged', { tool });
  }

  private applyTool(tool: Tool, item: CatalogItem | null): void {
    if (tool.kind !== 'select') this.select(null);
    this.input.reset();
    const entering = tool.kind !== 'select' && !this.tools.active;
    this.tools.setTool(tool);
    if (entering) this.enteredBuildMode();
    this.dock.setTool(tool, item);
    if (tool.kind === 'animal') this.species.show(tool.speciesId);
    else this.species.hide();
    this.deps.sim.events.emit('toolChanged', { tool });
  }

  /** Build mode entered from Inspect: the first few times, the tool bar says how to move the camera. */
  private enteredBuildMode(): void {
    this.dock.setCameraTip(this.coach.buildModeEntered());
  }

  openCategory(id: CategoryId | null): void {
    if (id) this.dock.openCategory(id);
    else this.dock.closeDrawer();
  }

  private onPending(p: PendingAction | null): void {
    this.dock.showPending(p);
  }

  private confirm(): void {
    const world = this.deps.sim.world;
    const log = this.toasts.log;
    const before = new Set(world.habitats.keys());
    const logged = log.version;
    const moved = this.tools.moving;
    const r = this.tools.confirm();
    if (!r || !r.ok) {
      this.dock.shake();
      return;
    }
    if (moved) {
      // a move is one action: back to Inspect, with the thing selected at its new spot once
      // the views have caught up (positionOf still reports the old spot this frame)
      this.setTool({ kind: 'select' });
      this.selectNextFrame = moved;
      return;
    }
    // building feedback: the sim's warning (e.g. the fence won't make a habitat) — it normally
    // announces it itself while committing — or a note that a new habitat was closed
    const warning = r.warning;
    if (warning && !(log.version !== logged && log.entries[0]?.text.includes(warning))) this.toasts.show(warning, 'warn');
    const created = [...world.habitats.values()].filter((h) => !before.has(h.id));
    if (!created.length) return;
    const h = created[0];
    const text = created.length > 1 ? `${created.length} new habitats created` : `New habitat created: ${h.name}`;
    this.toasts.show(text, 'good', { x: ((h.minX + h.maxX + 1) / 2) * TILE, z: ((h.minZ + h.maxZ + 1) / 2) * TILE });
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

  /**
   * A new graphics quality: every species' creature mesh is rebuilt over the next few seconds
   * (a hitch each on a phone), so say so until it is done. main.ts hands the tier to the
   * creature factory after ui.update, hence the wait of two frames before asking it.
   */
  private qualityChanged(q: QualityLevel): void {
    this.root.classList.toggle('wh-noblur', q === 'low');
    this.qualityRun++;
    this.qualityFrames = 2;
    this.qualityShownAt = performance.now();
    this.applyingQuality = true;
    this.toasts.setStatus('Applying graphics settings…');
  }

  private awaitQualityApplied(): void {
    const run = this.qualityRun;
    const { creatures, sim } = this.deps;
    const applied =
      creatures.whenQualityApplied?.() ??
      new Promise<void>((resolve) => {
        const species = new Set(Array.from(sim.animals.values(), (a) => a.speciesId));
        window.setTimeout(resolve, species.size * REBUILD_MS_PER_SPECIES);
      });
    const giveUp = new Promise<void>((resolve) => window.setTimeout(resolve, APPLYING_MAX_MS));
    void Promise.race([applied, giveUp]).then(() => {
      const left = Math.max(0, this.qualityShownAt + APPLYING_MIN_MS - performance.now());
      window.setTimeout(() => {
        if (run !== this.qualityRun || this.disposed) return;
        this.applyingQuality = false;
        this.toasts.setStatus(null);
      }, left);
    });
  }

  private onKey(code: string): boolean {
    switch (code) {
      case 'Escape':
        return this.handleBack();
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
    if (this.qualityFrames > 0 && --this.qualityFrames === 0) this.awaitQualityApplied();
    if (this.selectNextFrame) {
      const s = this.selectNextFrame;
      this.selectNextFrame = null;
      this.select(s);
    }
    toggleClass(this.root, 'sheet-open', this.info.sheet.open);
    toggleClass(this.root, 'card-open', this.species.visible);
    toggleClass(this.root, 'drawer-open', this.dock.drawerOpen);
    // a panel opened or closed: re-fit the toast column right away (else a few times a second)
    const panels =
      (this.info.sheet.open ? 1 : 0) | (this.species.visible ? 2 : 0) | (this.dock.drawerOpen ? 4 : 0) | (this.tools.active ? 8 : 0) | (this.dock.confirmVisible ? 16 : 0);
    if (panels !== this.panelsKey) {
      this.panelsKey = panels;
      this.layoutToasts();
    }
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
    this.coach.update(dt);
    this.popups.update(dt, this.vw, this.vh);
    this.costLabel.update(this.vw, this.vh, this.bottomTop - 6);
    this.affordAcc += dt;
    if (this.affordAcc > 0.25) {
      this.affordAcc = 0;
      this.dock.refreshAffordability();
      // the animal / object being moved was sold, removed or died meanwhile
      const m = this.tools.moving;
      const sim = this.deps.sim;
      if (m && !(m.kind === 'animal' ? sim.animals.has(m.id) : sim.world.objects.has(m.id))) this.setTool({ kind: 'select' });
      // top edge of the bottom dock (+ confirm bar / tool bar): a cheap 4 Hz layout read
      this.bottomTop = this.dock.root.offsetTop || this.vh;
      this.layoutToasts();
    }
  }

  get focus(): THREE.Vector3 {
    return this.camera.target;
  }

  /**
   * Android back / Escape: close the top-most layer, one per press —
   * dialog → text field → zoo menu → info panel → build drawer →
   * pending build (confirm bar + ghost) → active tool (back to Inspect).
   * Returns false at the top level so main can minimise the app.
   */
  handleBack(): boolean {
    if (this.disposed) return false;
    if (closeTopDialog()) return true;
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body && this.root.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
      a.blur();
      return true;
    }
    if (this.zoo.isOpen) {
      this.zoo.close();
      return true;
    }
    if (this.selection) {
      this.select(null);
      return true;
    }
    if (this.dock.drawerOpen) {
      this.dock.closeDrawer();
      return true;
    }
    if (this.tools.hasPending) {
      this.tools.cancelPending();
      return true;
    }
    if (this.tools.active) {
      cue('close');
      this.setTool({ kind: 'select' });
      return true;
    }
    if (this.camera.following) {
      this.camera.stopFollow();
      return true;
    }
    return false;
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
    bindAudio(null);
  }
}

export function createGameUI(root: HTMLElement, deps: UIDeps): GameUIHandle {
  return new GameUI(root, deps);
}

export type { ZooTab } from './zoopanel';
export type { CategoryId } from './catalog';
