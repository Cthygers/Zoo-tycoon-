import type * as THREE from 'three';
// Wildhaven UI module — public API:
//   createGameUI(root, deps)      → IGameUI (HUD, build dock, tools, panels, camera, input)
//   showLoadingScreen(root)       → { setProgress, hide }
//   showMainMenu(root, opts)      → the title menu's choice (screens.ts)
//
// The game UI is also the host for UI extensions (core/ui-ext.ts): the tutorial, account and
// versus features plug in through UIDeps.extensions (mounted in order once the UI is built) or
// addExtension() at runtime, and reach the shell only through the UIExtensionHost methods.

import { Vector3 } from 'three';
import { ENTRANCE_TILE, TILE } from '../core/constants';
import type { BootIntent, IAudio, IEntityViews, IGameUI, IRenderContext, ISimulation, PlayerInfo, QualityLevel, SimSpeed, UIDeps } from '../core/contracts';
import type { EventBus, NotifyKind } from '../core/events';
import type { CommandResult, Habitat, SelectionRef, Tool } from '../core/types';
import type { GestureSummary, PendingInfo, PillStepView, SettingsSection, SpeedLock, UIExtension, UIExtensionHost, UIRect, ZooPanelEvent } from '../core/ui-ext';
import { OBJECTS_BY_ID } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import { CameraController, followFraming } from './camera';
import { buildCatalog, type CatalogItem, type Category, type CategoryId } from './catalog';
import { Coach } from './coach';
import { Dock } from './dock';
import { avoidRect, el, setStyle, toggleClass, type ScreenBox, type ScreenRect } from './dom';
import { Hud, SpeedControl, speedForKey, type SpeedSource } from './hud';
import { InputController } from './input';
import { CostLabel, Celebration, MoneyPopups, Toasts, popupCell, throttlePopup, type PopupCellState } from './notify';
import { InfoPanel, SpeciesCard, closeTopDialog, dialogOpen, habitatCentre, showDialog } from './panels';
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
  /** The animal or person the camera follows (null for the free camera). */
  readonly followed: SelectionRef | null;
  select(sel: SelectionRef | null): void;
  setTool(tool: Tool): void;
  startMove(sel: SelectionRef): void;
  openCategory(id: CategoryId | null): void;
  openZooPanel(tab?: ZooTab): void;
  /** The extension host (the game UI itself) that UI extensions are mounted with. */
  readonly ext: UIExtensionHost;
  /** Mount a UI extension now (after the ones from UIDeps.extensions); e2e scripts use it through Vite dev imports. */
  addExtension(ext: UIExtension): void;
}

const ZOO_TABS: readonly ZooTab[] = ['finance', 'goals', 'stats', 'messages', 'settings'];
const isZooTab = (t: string | undefined): t is ZooTab => !!t && (ZOO_TABS as readonly string[]).includes(t);

const toUIRect = (b: ScreenBox): UIRect => ({ left: b.x0, top: b.y0, right: b.x1, bottom: b.y1 });

const DEG = Math.PI / 180;
/** The "Applying graphics settings…" line stays up at least this long (ms), so it never just flickers. */
const APPLYING_MIN_MS = 1200;
/** …and at most this long (ms), whatever happens to the creature rebuild. */
const APPLYING_MAX_MS = 30000;
/** Without a completion signal from the creature factory: rough rebuild time per species on a phone (ms). */
const REBUILD_MS_PER_SPECIES = 700;
/** Gap (px) between the clear view and an open side sheet or card. */
const SIDE_GAP = 10;
/** The toast column is at most this wide (px), and moves beside the goal pill / tour bubble only if it keeps this much. */
const TOAST_COL_MAX = 460;
const TOAST_COL_MIN = 300;
/** Gap (px) between the toast column and the goal pill / tour bubble. */
const TOAST_GAP = 8;
/** Height (px) the toasts may fill over the zoo menu's title row: one toast of up to two lines. */
const MENU_TOAST_ROOM = 76;

const _corner = new Vector3();
const _proj = new Vector3();

class GameUI implements GameUIHandle, UIExtensionHost {
  readonly camera: CameraController;
  readonly tools: ToolManager;
  /** The .wh-ui layer: every HUD element, and the overlays extensions add. */
  readonly root: HTMLElement;
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
  private sel: SelectionRef | null = null;
  /** HUD buttons, keys and extensions all change the speed through this. */
  private speedCtl: SpeedControl;
  /** Mounted UI extensions, in mount order (and those whose update / back / key failed once). */
  private exts: UIExtension[] = [];
  private extFailed = new Set<string>();
  /** Screen rects extensions keep clear of toasts, popups and the camera's clear area (e.g. the tutorial's bubble). */
  private reserved = new Map<string, ScreenRect>();
  private zooFns: ((e: ZooPanelEvent) => void)[] = [];
  private gestureFns: ((g: GestureSummary) => void)[] = [];
  /** Versus feedback density: the last money popup per screen cell. */
  private popupCells = new Map<number, PopupCellState>();
  private followSel: SelectionRef | null = null;
  private followPos = { x: 0, z: 0, lookHeight: 0, minDistance: 0 };
  private vw = window.innerWidth;
  private vh = window.innerHeight;
  private affordAcc = 0;
  private bottomTop = window.innerHeight;
  /** Bottom edge of the top bar (refreshed with bottomTop): money popups fade out before it. */
  private topBottom = 0;
  /** The goal pill and tour bubble over the view (refreshed with bottomTop): money popups fade out before them too. */
  private popupCovers: ScreenRect[] = [];
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
      deps.audio?.follow?.(null);
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
    // feedback toasts show over the zoo menu too: one tapped there closes the menu to show its place
    const toastFocus = (x: number, z: number) => {
      this.zoo.close();
      focusEvent(x, z);
    };
    this.toasts = new Toasts(toastFocus, () => ({ day: sim.day, minute: sim.minuteOfDay }));
    this.speedCtl = new SpeedControl(sim, () => this.hud.refresh());
    this.hud = new Hud({ sim, log: this.toasts.log, openMenu: (tab) => this.openZooPanel(tab), setSpeed: (s) => this.setSpeed(s, 'hud') });
    this.dock = new Dock({
      sim,
      thumbs: this.thumbs,
      catalog: this.catalog,
      selectItem: (item) => this.selectItem(item),
      exitTool: () => this.setTool({ kind: 'select' }),
      drawerOpened: (id) => this.categoryOpened(id),
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
      player: deps.player ?? null,
      onShown: (tab) => this.zooEvent({ kind: 'shown', tab }),
      onClosed: () => this.zooEvent({ kind: 'closed' }),
    });
    this.cele = new Celebration(this.toasts.root);
    this.coach = new Coach({
      sim,
      openBuildCategory: (id) => this.openCategory(id),
      openGoals: () => this.openZooPanel('goals'),
    });

    this.root.append(
      this.popups.root,
      this.costLabel.root,
      this.hud.root,
      this.coach.pill,
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
      gesture: (g) => {
        for (const fn of [...this.gestureFns]) {
          try {
            fn(g);
          } catch (err) {
            console.error('[ui] gesture handler failed', err);
          }
        }
      },
    });

    // ---- events
    const ev = sim.events;
    this.offs.push(
      // news waits while the zoo menu is open, and only goes to the list the player is reading on its Messages tab
      ev.on('notify', (n) => (n.logOnly || this.zoo.readingMessages ? this.toasts.logOnly(n.text, n.kind, n.focus) : this.toasts.show(n.text, n.kind, n.focus, true))),
      ev.on('objectiveCompleted', (o) => {
        this.cele.show(o.text, o.reward);
        this.layoutToasts(); // toasts under the new card make way at once
      }),
      ev.on('moneyPopup', (m) => this.moneyPopup(m.x, m.z, m.amount)),
      ev.on('commandResult', (r) => {
        if (!r.ok && this.dock.confirmVisible) this.dock.shake();
      }),
      ev.on('worldReset', () => {
        // a loaded zoo brings its messages along (a new one starts with none)
        this.toasts.log.restore(sim.messages());
        this.select(null);
        this.setTool({ kind: 'select' });
        this.resetView();
        this.popupCells.clear();
      }),
      ev.on('animalRemoved', (e) => this.dropIfSelected('animal', e.id)),
      ev.on('guestRemoved', (e) => this.dropIfSelected('guest', e.id)),
      ev.on('staffRemoved', (e) => this.dropIfSelected('staff', e.id)),
      ev.on('objectRemoved', (e) => this.dropIfSelected('object', e.id)),
      ev.on('habitatsChanged', () => {
        const s = this.sel;
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
    const prev = this.sel;
    const same = prev && sel && prev.kind === sel.kind && prev.id === sel.id;
    if (same) return;
    if (sel) cue('select');
    if (sel && this.tools.active) this.setTool({ kind: 'select' });
    if (sel) this.dock.closeDrawer();
    this.sel = sel;
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
   * Screen rect (px) of the 3D view the fixed HUD leaves free: below the top bar, inside its
   * side margins, above the dock, and beside the info sheet / species card (landscape) or
   * above / below them (portrait).
   */
  private viewBox(): ScreenBox {
    const hud = this.hud.root;
    const a = { x0: hud.offsetLeft, y0: hud.offsetTop + hud.offsetHeight, x1: hud.offsetLeft + hud.offsetWidth, y1: this.dock.root.offsetTop || this.vh };
    for (const sheet of [this.info.sheet, this.species.sheet]) {
      if (!sheet.open) continue;
      // layout box, not getBoundingClientRect: the sheet may still be sliding in
      const s = sheet.root;
      if (s.offsetWidth >= this.vw * 0.7) {
        if (s.offsetTop > this.vh / 2) a.y1 = Math.min(a.y1, s.offsetTop);
        else a.y0 = Math.max(a.y0, s.offsetTop + s.offsetHeight);
      } else if (s.offsetLeft > this.vw / 2) a.x1 = Math.min(a.x1, s.offsetLeft - SIDE_GAP);
      else a.x0 = Math.max(a.x0, s.offsetLeft + s.offsetWidth + SIDE_GAP);
    }
    return a;
  }

  /** The view area clear of the rects extensions reserve (e.g. beside or below the tutorial's bubble): where the camera centres things. */
  private clearBox(): ScreenBox {
    let a = this.viewBox();
    for (const r of this.reserved.values()) a = avoidRect(a, r);
    return a;
  }

  /**
   * Lay the toast column out over the free part of the view, around the next-goal pill and
   * the rects extensions reserve (beside them where there is room, else below one under the
   * top bar and above one low in the view), and above the dock, drawer, tool bar and confirm
   * bar (Toasts.setRoom: only what fits is shown, the rest waits).
   */
  private layoutToasts(): void {
    const col = this.toasts.root;
    this.toasts.hold(this.zoo.isOpen);
    if (this.zoo.isOpen) {
      // feedback over the menu's title row: one toast at a time, the rest wait until it closes
      const g = this.zoo.headGap();
      setStyle(col, 'left', `${Math.round((g.x0 + g.x1) / 2)}px`);
      setStyle(col, 'width', `${Math.round(Math.max(0, Math.min(TOAST_COL_MAX, g.x1 - g.x0)))}px`);
      setStyle(col, 'top', `${Math.round(g.top)}px`);
      this.cele.setRoom(MENU_TOAST_ROOM);
      this.toasts.setRoom(MENU_TOAST_ROOM);
      return;
    }
    const a = this.viewBox();
    let { x0, x1 } = a;
    let top = a.y0 + 4;
    let bottom = a.y1;
    for (const r of this.viewOverlays()) {
      const half = Math.min(TOAST_COL_MAX, x1 - x0) / 2;
      const mid = (x0 + x1) / 2;
      if (r.right + TOAST_GAP <= mid - half || r.left - TOAST_GAP >= mid + half) continue;
      const leftRoom = r.left - TOAST_GAP - x0;
      const rightRoom = x1 - r.right - TOAST_GAP;
      if (r.top > (a.y0 + a.y1) / 2) bottom = Math.min(bottom, r.top);
      else if (Math.max(leftRoom, rightRoom) >= TOAST_COL_MIN) {
        if (rightRoom >= leftRoom) x0 = r.right + TOAST_GAP;
        else x1 = r.left - TOAST_GAP;
      } else top = Math.max(top, r.bottom + TOAST_GAP);
    }
    setStyle(col, 'left', `${Math.round((x0 + x1) / 2)}px`);
    setStyle(col, 'width', `${Math.round(Math.min(TOAST_COL_MAX, x1 - x0))}px`);
    setStyle(col, 'top', `${Math.round(top)}px`);
    const room = bottom - top - 6;
    this.cele.setRoom(room);
    this.toasts.setRoom(room);
  }

  /** The next-goal pill and the rects extensions reserve (the tutorial's bubble) where they float over the view. */
  private viewOverlays(): ScreenRect[] {
    const out: ScreenRect[] = [];
    const pill = this.coach.pill;
    if (getComputedStyle(pill).visibility !== 'hidden') out.push(pill.getBoundingClientRect());
    for (const r of this.reserved.values()) out.push(r);
    return out;
  }

  /** Screen rect (px) of what is being built right now: the tool's preview and its cost label. */
  workRect(): UIRect | null {
    const r = this.tools.previewScreenRect(this.vw, this.vh);
    const l = this.costLabel.shown ? this.costLabel.root.getBoundingClientRect() : null;
    if (!r || !l) return r ?? l;
    return { left: Math.min(r.left, l.left), top: Math.min(r.top, l.top), right: Math.max(r.right, l.right), bottom: Math.max(r.bottom, l.bottom) };
  }

  /** Fly the camera to a ground point, centring it in the part of the view that panels leave clear. */
  focusClear(x: number, z: number, distance?: number): void {
    const a = this.clearBox();
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
    const a = this.clearBox();
    const m = 36; // room for the selection ring around the thing's ground point
    if (p.z < 1 && sx > a.x0 + m && sx < a.x1 - m && sy > a.y0 + m && sy < a.y1 - m) return;
    this.focusClear(x, z);
  }

  /**
   * The species card covers one side of the view: bring the habitat an animal of this species
   * would most likely go to (the best suited, the nearest among equals) into the clear part.
   */
  private showHabitatFor(speciesId: string): void {
    const sim = this.deps.sim;
    const t = this.camera.target;
    let best: Habitat | null = null;
    let bestKey = -Infinity;
    // an animal being moved is not a newcomer in its own habitat
    const mv = this.tools.moving;
    const opts = mv?.kind === 'animal' ? { animalId: mv.id } : undefined;
    for (const h of sim.world.habitats.values()) {
      const c = habitatCentre(h);
      const key = sim.suitability(speciesId, h.id, opts).score - Math.hypot(c.x - t.x, c.z - t.z) / 1e4;
      if (key > bestKey) {
        bestKey = key;
        best = h;
      }
    }
    if (!best) return;
    const a = this.clearBox();
    const cam = this.deps.ctx.camera;
    const w = sim.world;
    const inView = [best.minX, best.maxX + 1].every((tx) =>
      [best.minZ, best.maxZ + 1].every((tz) => {
        const p = _corner.set(tx * TILE, w.heightAt(tx * TILE, tz * TILE), tz * TILE).project(cam);
        const sx = (p.x * 0.5 + 0.5) * this.vw;
        const sy = (0.5 - p.y * 0.5) * this.vh;
        return p.z < 1 && sx > a.x0 && sx < a.x1 && sy > a.y0 && sy < a.y1;
      }),
    );
    if (!inView) {
      const c = habitatCentre(best);
      this.focusClear(c.x, c.z);
    }
  }

  /** A followed animal or person stays in the middle of the part of the view the info sheet leaves clear. */
  private keepFollowClear(): void {
    const a = this.clearBox();
    this.camera.followScreenX = (a.x0 + a.x1) / this.vw - 1;
  }

  private dropIfSelected(kind: SelectionRef['kind'], id: number): void {
    const s = this.sel;
    if (s && s.kind === kind && s.id === id) this.select(null);
  }

  private toggleFollow(sel: SelectionRef): void {
    if (this.followSel && this.followSel.kind === sel.kind && this.followSel.id === sel.id) {
      this.camera.stopFollow();
      return;
    }
    const sim = this.deps.sim;
    const pos = this.followPos;
    const get = (): typeof pos | null => {
      const a = sel.kind === 'animal' ? sim.animals.get(sel.id) : undefined;
      const p = sel.kind === 'guest' ? sim.guests.get(sel.id) : sel.kind === 'staff' ? sim.staff.get(sel.id) : undefined;
      const e = a ?? p;
      if (!e) return null;
      pos.x = e.x;
      pos.z = e.z;
      if (a) {
        // close up the camera looks at an animal's middle (a tall one's upper body), not its feet,
        // from far enough to frame it (juveniles are drawn at 0.4 → 1 of the adult size as they grow)
        const sp = SPECIES_BY_ID[a.speciesId];
        const size = 0.4 + 0.6 * a.growth;
        const f = followFraming((sp?.height ?? 1) * size, (sp?.length ?? 1) * size);
        pos.lookHeight = f.lookHeight;
        pos.minDistance = f.minDistance;
      } else if (p) {
        // a person's chest, at the camera's closest follow zoom
        pos.lookHeight = 0.6 * p.appearance.height;
        pos.minDistance = 0;
      }
      return pos;
    };
    if (!get()) return;
    this.camera.stopFollow();
    this.followSel = sel;
    this.keepFollowClear();
    this.camera.follow(get, 20);
    // the followed animal sounds closer and more alive (fauna module)
    this.deps.audio?.follow?.(sel.kind === 'animal' ? sel.id : null);
  }

  // ------------------------------------------------------------ tools
  private selectItem(item: CatalogItem): void {
    // keep the brush size when switching terrain types
    let tool = item.tool;
    const cur = this.tools.tool;
    if (tool.kind === 'terrain' && cur.kind === 'terrain') tool = { ...tool, brush: cur.brush };
    if (tool.kind === 'object' && cur.kind === 'object') tool = { ...tool, rot: cur.rot };
    // drawer first: the species card then measures the view the drawer no longer covers
    this.dock.closeDrawer();
    this.applyTool(tool, item);
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
    this.showSpeciesCard(tool);
    sim.events.emit('toolChanged', { tool });
  }

  private applyTool(tool: Tool, item: CatalogItem | null): void {
    if (tool.kind !== 'select') this.select(null);
    this.input.reset();
    const entering = tool.kind !== 'select' && !this.tools.active;
    this.tools.setTool(tool);
    if (entering) this.enteredBuildMode();
    this.dock.setTool(tool, item);
    this.showSpeciesCard(tool);
    this.deps.sim.events.emit('toolChanged', { tool });
  }

  /** The animal tool shows the species card, with a habitat to tap in the clear part of the view. */
  private showSpeciesCard(tool: Tool): void {
    if (tool.kind === 'animal') this.species.show(tool.speciesId);
    else this.species.hide();
    if (tool.kind === 'animal') this.showHabitatFor(tool.speciesId);
  }

  /** A build category opened: browsing another category than the tool's puts the tool (and its pending action) away. */
  private categoryOpened(id: CategoryId): void {
    this.select(null);
    if (this.tools.active && this.dock.toolCategory !== id) this.setTool({ kind: 'select' });
  }

  /** Build mode entered from Inspect: the first few times, the tool bar says how to move the camera. */
  private enteredBuildMode(): void {
    this.dock.setCameraTip(this.coach.buildModeEntered());
  }

  openCategory(id: string | null): void {
    if (!id) this.dock.closeDrawer();
    else if (this.catalog.some((c) => c.id === id)) this.dock.openCategory(id as CategoryId);
  }

  private onPending(p: PendingAction | null): void {
    this.dock.showPending(p);
  }

  /** The confirm bar's button: a serious outcome asks first (a dialog), then it is committed. */
  private confirm(): void {
    const ask = this.tools.pendingQuestion;
    if (!ask) {
      this.commitPending();
      return;
    }
    void showDialog(this.root, { ...ask, danger: true }).then((ok) => {
      if (ok && !this.disposed) this.commitPending();
    });
  }

  private commitPending(): void {
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

  /**
   * The one path for speed changes: HUD buttons, keys and extensions. Refused (false, nothing
   * changes) during a versus match, and while a SpeedLock is set unless an extension asks.
   */
  setSpeed(s: SimSpeed, source: SpeedSource = 'hud'): boolean {
    const ok = this.speedCtl.set(s, source);
    // a locked button or key says no (its lock's owner explains why); a versus match just ignores them
    if (!ok && source !== 'ext' && !this.deps.sim.versus) cue('deny');
    return ok;
  }

  setSpeedLock(lock: SpeedLock | null): void {
    this.speedCtl.setLock(lock);
    this.hud.setSpeedLock(lock);
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
    // extensions first (e.g. the tutorial's Enter = Got it)
    for (const e of this.exts) {
      if (!e.onKey) continue;
      try {
        if (e.onKey(code)) return true;
      } catch (err) {
        this.extError(e, 'onKey', err);
      }
    }
    const speed = speedForKey(code, this.deps.sim.speed);
    if (speed !== null) {
      // refused during a versus match or under a lock, but the key is still used up
      this.setSpeed(speed, 'key');
      return true;
    }
    switch (code) {
      case 'Escape':
        return this.handleBack();
      case 'Enter':
      case 'NumpadEnter':
        if (!this.dock.confirmVisible) return false;
        this.confirm();
        return true;
      case 'KeyR':
        if (this.tools.tool.kind !== 'object') return false;
        this.tools.rotate();
        return true;
      case 'KeyF': {
        const s = this.sel;
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
    toggleClass(this.root, 'menu-open', this.zoo.isOpen);
    // a panel opened or closed: re-fit the toast column right away (else a few times a second)
    const panels =
      (this.info.sheet.open ? 1 : 0) |
      (this.species.visible ? 2 : 0) |
      (this.dock.drawerOpen ? 4 : 0) |
      (this.tools.active ? 8 : 0) |
      (this.dock.confirmVisible ? 16 : 0) |
      (this.zoo.isOpen ? 32 : 0);
    if (panels !== this.panelsKey) {
      this.panelsKey = panels;
      this.layoutToasts();
      if (this.followSel) this.keepFollowClear();
    }
    if (!this.backArmed && (this.zoo.isOpen || this.dock.drawerOpen || this.tools.active || this.sel)) {
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
    this.popups.update(dt, this.vw, this.vh, this.topBottom, this.popupCovers);
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
      this.topBottom = this.hud.root.offsetTop + this.hud.root.offsetHeight;
      this.popupCovers = this.viewOverlays();
      this.layoutToasts();
      if (this.followSel) this.keepFollowClear();
    }
    // extensions after the shell's own update
    for (const e of this.exts) {
      if (!e.update) continue;
      try {
        e.update(dt);
      } catch (err) {
        this.extError(e, 'update', err);
      }
    }
  }

  get followed(): SelectionRef | null {
    return this.camera.following ? this.followSel : null;
  }

  // ------------------------------------------------------------ money popups
  /** A money popup; in a versus match (4× pace) at most one per 0.5 s per screen cell, the dropped amounts summed into the next. */
  private moneyPopup(x: number, z: number, amount: number): void {
    if (this.deps.sim.versus) {
      const p = this.project(x, this.deps.sim.world.heightAt(x, z) + 2.2, z);
      const shown = throttlePopup(this.popupCells, popupCell(p.x, p.y, this.vw, this.vh), performance.now() / 1000, amount);
      if (shown === null) return;
      amount = shown;
    }
    this.popups.spawn(x, z, amount);
  }

  // ------------------------------------------------------------ UI extensions (UIExtensionHost)
  get ext(): UIExtensionHost {
    return this;
  }

  /** Mount an extension; one that fails to mount is left out (the game goes on without it). */
  addExtension(ext: UIExtension): void {
    if (this.disposed || this.exts.includes(ext)) return;
    try {
      ext.mount(this);
      this.exts.push(ext);
    } catch (err) {
      console.error(`[ui] extension ${ext.id} failed to mount`, err);
    }
  }

  /** An extension threw: logged once per extension and hook, the game goes on. */
  private extError(e: UIExtension, hook: string, err: unknown): void {
    const key = `${e.id}:${hook}`;
    if (this.extFailed.has(key)) return;
    this.extFailed.add(key);
    console.error(`[ui] extension ${e.id} ${hook} failed`, err);
  }

  get sim(): ISimulation {
    return this.deps.sim;
  }

  get ctx(): IRenderContext {
    return this.deps.ctx;
  }

  get views(): IEntityViews {
    return this.deps.views;
  }

  get audio(): IAudio {
    return this.deps.audio;
  }

  get events(): EventBus {
    return this.deps.sim.events;
  }

  get player(): PlayerInfo | null {
    return this.deps.player ?? null;
  }

  save(): 'saved' | 'showcase' | 'kept' | 'failed' {
    return this.deps.save();
  }

  switchSlot(target: BootIntent): Promise<void> {
    const fn = this.deps.switchSlot;
    return fn ? fn(target) : Promise.reject(new Error('switchSlot is not available in this build'));
  }

  // HUD
  hudSlot(name: 'speed' | 'badge'): HTMLElement {
    return name === 'speed' ? this.hud.speedSlot : this.hud.badgeSlot;
  }

  hudEl(name: 'money' | 'speedGroup' | 'menu' | 'pill'): HTMLElement | null {
    switch (name) {
      case 'money':
        return this.hud.moneyEl;
      case 'speedGroup':
        return this.hud.speedGroupEl;
      case 'menu':
        return this.hud.menuEl;
      case 'pill':
        return this.coach.pill;
      default:
        return null;
    }
  }

  hudSpeedButton(s: SimSpeed): HTMLElement | null {
    return this.hud.speedButton(s);
  }

  setPillStep(view: PillStepView | null): void {
    this.coach.setStep(view);
  }

  onPillTapped(fn: () => void): () => void {
    return this.coach.onPillTapped(fn);
  }

  // build UI
  tool(): { tool: Tool; moving: boolean } {
    return { tool: this.tools.tool, moving: !!this.tools.moving };
  }

  pending(): PendingInfo | null {
    return this.tools.pendingInfo;
  }

  openedCategory(): string | null {
    return this.dock.openCategoryId;
  }

  categoryButton(id: string): HTMLElement | null {
    return this.dock.categoryButton(id as CategoryId);
  }

  card(match: (key: string) => boolean): HTMLElement | null {
    return this.dock.cardFor(match);
  }

  revealCard(card: HTMLElement): void {
    this.dock.revealCard(card);
  }

  drawer(): HTMLElement | null {
    return this.dock.drawerEl;
  }

  toolBar(): HTMLElement | null {
    return this.dock.toolbarEl;
  }

  confirmBar(): HTMLElement | null {
    return this.dock.confirmBarEl;
  }

  confirmOk(): HTMLElement | null {
    return this.dock.confirmOkEl;
  }

  endTool(): void {
    if (this.tools.active) this.setTool({ kind: 'select' });
  }

  closeDrawer(): void {
    this.dock.closeDrawer();
  }

  selection(): SelectionRef | null {
    return this.sel;
  }

  sheet(): { root: HTMLElement | null; close: HTMLElement | null; anchor(name: 'happiness'): HTMLElement | null } {
    const open = this.info.sheet.open;
    return {
      root: open ? this.info.sheet.root : null,
      close: open ? this.info.sheet.closeEl : null,
      anchor: (name) => this.info.anchor(name),
    };
  }

  // zoo menu and dialogs
  openMenu(tab?: string): void {
    this.openZooPanel(isZooTab(tab) ? tab : undefined);
  }

  zooPanel(): { tab: string | null; close: HTMLElement | null; tabButton(t: string): HTMLElement | null; headGap(): { x0: number; x1: number; top: number } | null } {
    const zoo = this.zoo;
    return {
      tab: zoo.currentTab,
      close: zoo.isOpen ? zoo.closeEl : null,
      tabButton: (t) => (zoo.isOpen && isZooTab(t) ? zoo.tabButton(t) : null),
      headGap: () => (zoo.isOpen ? zoo.headGap() : null),
    };
  }

  onZooPanel(fn: (e: ZooPanelEvent) => void): () => void {
    this.zooFns.push(fn);
    return () => {
      const i = this.zooFns.indexOf(fn);
      if (i >= 0) this.zooFns.splice(i, 1);
    };
  }

  private zooEvent(e: ZooPanelEvent): void {
    for (const fn of [...this.zooFns]) {
      try {
        fn(e);
      } catch (err) {
        console.error('[ui] zoo menu handler failed', err);
      }
    }
  }

  addSettingsSection(sec: SettingsSection): () => void {
    return this.zoo.addSettingsSection(sec);
  }

  hideSettingsRow(row: 'newZoo', hidden: boolean): void {
    this.zoo.hideSettingsRow(row, hidden);
  }

  dialogOpen(): boolean {
    return dialogOpen();
  }

  showDialog(o: { title: string; text: string; ok: string; cancel?: string; danger?: boolean; primary?: 'ok' | 'cancel' }): Promise<boolean> {
    return showDialog(this.root, o);
  }

  notify(text: string, kind: NotifyKind = 'info'): void {
    this.toasts.show(text, kind);
  }

  // view, camera, input
  viewArea(): UIRect {
    return toUIRect(this.viewBox());
  }

  clearArea(): UIRect {
    return toUIRect(this.clearBox());
  }

  cameraDemo(kind: 'pan' | 'zoom' | 'turn'): Promise<void> {
    return this.camera.demo(kind);
  }

  /** Screen position (px) of a world point, and whether it is in front of the camera and on screen. */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const v = _proj.set(x, y, z).project(this.deps.ctx.camera);
    return {
      x: (v.x * 0.5 + 0.5) * this.vw,
      y: (0.5 - v.y * 0.5) * this.vh,
      visible: v.z > -1 && v.z < 1 && v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1,
    };
  }

  pointersDown(): number {
    return this.input.pointers;
  }

  onGesture(fn: (g: GestureSummary) => void): () => void {
    this.gestureFns.push(fn);
    return () => {
      const i = this.gestureFns.indexOf(fn);
      if (i >= 0) this.gestureFns.splice(i, 1);
    };
  }

  /**
   * Run a sim command with the feedback a confirmed tool action gets: exactly one commandResult
   * event (the sim's own, else one with `at`), the build / bulldoze / error cue and a HUD refresh.
   */
  runCommand(fn: () => CommandResult, at?: { x: number; z: number }): CommandResult {
    const ev = this.deps.sim.events;
    let emitted = false;
    const off = ev.on('commandResult', () => {
      emitted = true;
    });
    let r: CommandResult;
    try {
      r = fn();
    } finally {
      off();
    }
    if (!emitted) ev.emit('commandResult', at ? { ...r, x: at.x, z: at.z } : { ...r });
    cue(r.ok ? (r.cost < 0 ? 'bulldoze' : 'build') : 'error');
    if (r.ok) this.hud.refresh();
    return r;
  }

  /** Keep `r` clear of toasts, money popups and the camera's clear area (null drops it). */
  setReservedRect(id: string, r: UIRect | null): void {
    const prev = this.reserved.get(id);
    if (!r) {
      if (!prev) return;
      this.reserved.delete(id);
    } else {
      if (prev && Math.abs(prev.left - r.left) + Math.abs(prev.top - r.top) + Math.abs(prev.right - r.right) + Math.abs(prev.bottom - r.bottom) < 1) return;
      this.reserved.set(id, { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    if (this.disposed) return;
    this.popupCovers = this.viewOverlays();
    this.layoutToasts();
    if (this.followSel) this.keepFollowClear();
  }

  get focus(): THREE.Vector3 {
    return this.camera.target;
  }

  /**
   * Android back / Escape: close the top-most layer, one per press —
   * dialog → text field → UI extensions (last mounted first) → zoo menu → info panel →
   * build drawer → pending build (confirm bar + ghost) → active tool (back to Inspect).
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
    for (let i = this.exts.length - 1; i >= 0; i--) {
      const e = this.exts[i];
      if (!e.handleBack) continue;
      try {
        if (e.handleBack()) return true;
      } catch (err) {
        this.extError(e, 'handleBack', err);
      }
    }
    if (this.zoo.isOpen) {
      this.zoo.close();
      return true;
    }
    if (this.sel) {
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
    for (const e of [...this.exts].reverse()) {
      try {
        e.dispose?.();
      } catch (err) {
        this.extError(e, 'dispose', err);
      }
    }
    this.exts = [];
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
  const ui = new GameUI(root, deps);
  // extensions plug in once the whole UI is built, in the order main.ts gives them
  for (const e of deps.extensions ?? []) ui.addExtension(e);
  return ui;
}

export type { ZooTab } from './zoopanel';
export type { CategoryId } from './catalog';
