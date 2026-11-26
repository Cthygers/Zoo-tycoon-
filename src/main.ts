// Wildhaven Zoo — entry point. Reads the boot intent (a zoo switch reloads the page), shows the
// title menu, opens the chosen zoo slot through the cloud layer (offline first; sync, lease and
// conflict prompts when signed in), builds every subsystem and runs the main loop (simulate →
// animate → render) with autosave and one hide/show lifecycle (Android pause, tab hidden).
// Spec: feature round 14 §7.2 boot, §7.3 switchSlot, §7.4 frame loop, §7.5 lifecycle.

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { createAudio } from './audio';
import { AUDIO_PREFS_KEY, applyPrefs, parsePrefs } from './audio/prefs';
import { CLOSE_HOUR, OPEN_HOUR, QUALITY_KEY, SOUND_KEY } from './core/constants';
import type { LeaseLostInfo, OpenedSlot, ResumeResult } from './core/cloud-types';
import type { BootIntent, MenuResult, QualityLevel, SlotKey, UIDeps } from './core/contracts';
import { EventBus } from './core/events';
import { readTutorialState, writeActiveSlot } from './core/player-state';
import { BOOT_INTENT_KEY, GUEST, matchIdOf, slotKey } from './core/storage-keys';
import type { UIExtension } from './core/ui-ext';
import { Vector3 } from 'three';
import { createCreatureFactory, setCreatureFollowCut, setFigureNightGround } from './models';
import { createCloud, createDeviceProvider, createGoogleSignIn, metaFromSim } from './net';
import { createPropsLayer, followBlockers, paintAtlasesOffThread, setFollowCut, setNatureNightGround } from './props';
import { createRenderContext, detectQuality, nightGroundLevel, type Swimmer } from './render';
import { SPECIES_BY_ID } from './data/species';
import { NEW_ZOO_START_MINUTE, createSimulation } from './sim';
import { createGameUI, showLoadingScreen, showMainMenu, type GameUIHandle } from './ui';
import { createAccountExtension, createSyncPrompts } from './ui/account';
import { menuHandleBack } from './ui/screens';
import { createTutorialExtension, type TutorialExtension } from './ui/tutorial';
import { wantsFirstRun } from './ui/tutorial/profile';
import { createVersusExtension, openVersusHub } from './ui/versus';
import { createVersusController, VersusBootError, type VersusController } from './versus/controller';
import { createSoakRecorder } from './versus/soak';
import { createEntityViews } from './views';
import { buildDemoZoo } from './demo';
import { renderEmptyFrame, warmUpShaders } from './loader';

/** Chromium's total in-flight keepalive body cap (bytes), shared by every page-hide request (spec §7.5). */
const KEEPALIVE_BUDGET = 65536;
/** After this long in the background, a signed-in zoo holds the clock ≤ 2 s for the lease/head check (spec §3.10). */
const RESUME_CHECK_AFTER_MS = 60_000;
const RESUME_HOLD_MS = 2000;
/** switchSlot waits this long at most for the final push and lease release before reloading. */
const LEAVE_WAIT_MS = 3000;

function storageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function storageSet(k: string, v: string): boolean {
  try {
    localStorage.setItem(k, v);
    return true;
  } catch (err) {
    console.warn('[save] storage unavailable', err);
    return false;
  }
}

/** localStorage, or an in-memory stand-in where storage is blocked (private mode); every caller tolerates loss. */
function safeLocalStorage(): Storage {
  try {
    const s = window.localStorage;
    if (s) return s;
  } catch {
    /* blocked */
  }
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  } as Storage;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The pending zoo switch (sessionStorage 'wildhaven-boot'), removed when read. */
function consumeBootIntent(): BootIntent | null {
  let text: string | null = null;
  try {
    text = sessionStorage.getItem(BOOT_INTENT_KEY);
    if (text !== null) sessionStorage.removeItem(BOOT_INTENT_KEY);
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    const t = JSON.parse(text) as Omit<Partial<MenuResult>, 'kind'> & { kind?: string; player?: unknown };
    if (!t || typeof t !== 'object') return null;
    const player = typeof t.player === 'string' && t.player ? t.player : undefined;
    if (t.kind === 'menu') return { kind: 'menu', player };
    if (t.kind !== 'continue' && t.kind !== 'new' && t.kind !== 'tutorial' && t.kind !== 'versus') return null;
    if (!player || typeof t.slot !== 'string') return null;
    const slot = t.slot as MenuResult['slot'];
    if (slot !== 'main' && slot !== 'practice' && !matchIdOf(slot)) return null;
    if (t.kind === 'versus' && !(t.matchId ?? matchIdOf(slot))) return null;
    return t as MenuResult;
  } catch {
    return null;
  }
}

function fatal(err: unknown) {
  console.error(err);
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:#0b1a10;color:#f3ead7;font:16px system-ui;text-align:center;z-index:9999;pointer-events:auto';
  el.innerHTML = `<div><h2 style="margin:0 0 12px">Wildhaven Zoo couldn't start</h2><p style="opacity:.8;max-width:520px">${
    String((err as Error)?.message ?? err).replace(/</g, '&lt;')
  }</p><p style="opacity:.6">This game needs WebGL 2. Try restarting the app or lowering graphics quality.</p><button style="margin-top:12px;padding:12px 20px;border-radius:12px;border:0;background:#7fb069;color:#10200f;font-weight:600" onclick="location.reload()">Reload</button></div>`;
  document.body.appendChild(el);
}

/** A kid-friendly message over the loading screen with one big Back button (a match that cannot start). */
function showBootMessage(root: HTMLElement, text: string): Promise<void> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'wh-boot-msg';
    wrap.setAttribute('role', 'alertdialog');
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:140;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(8,16,11,.55);pointer-events:auto';
    const card = document.createElement('div');
    card.className = 'wh-glass-2';
    card.style.cssText =
      'max-width:420px;width:100%;padding:22px 22px 18px;border-radius:20px;text-align:center;color:#f3ead7;font:600 19px/1.35 system-ui,sans-serif';
    const p = document.createElement('p');
    p.style.cssText = 'margin:0 0 18px';
    p.textContent = text;
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'wh-btn wh-btn-primary';
    back.dataset.boot = 'back';
    back.style.cssText = 'min-height:52px;min-width:160px;font-size:18px;justify-content:center';
    back.textContent = 'Back';
    back.addEventListener('click', () => resolve());
    card.append(p, back);
    wrap.append(card);
    root.append(wrap);
    back.focus();
  });
}

async function boot() {
  const gameRoot = document.getElementById('game')!;
  const uiRoot = document.getElementById('ui')!;

  const params = new URLSearchParams(location.search);
  // ?soak=<minutes>: the device soak test (spec §5.8) — the showcase zoo under the versus render policy
  const soak = params.has('soak');
  const demo = params.has('demo') || soak;
  const qParam = params.get('q') as QualityLevel | null;
  let quality = qParam ?? (storageGet(QUALITY_KEY) as QualityLevel | null) ?? detectQuality();

  // The game UI (null while the title menu and the loading screen are up).
  let ui: GameUIHandle | null = null;
  // Android back: close the title menu's pages and dialogs first; in game, panels and tools first;
  // at the top level, save and send the app to the background instead of killing the zoo.
  let saveForBack: () => void = () => {};
  if (Capacitor.isNativePlatform()) {
    void App.addListener('backButton', () => {
      if (ui ? ui.handleBack() : menuHandleBack()) return;
      saveForBack();
      void App.minimizeApp();
    });
  }

  const intent = consumeBootIntent();
  const storage = safeLocalStorage();
  const cloud = createCloud({
    storage,
    fetch: fetch.bind(window),
    google: createGoogleSignIn(),
    device: createDeviceProvider(),
    appVersion: __APP_VERSION__,
  });
  await cloud.init(); // local only (device binding, session restore, housekeeping): no network
  const prompts = createSyncPrompts(uiRoot, cloud);

  // Paint the foliage atlases in a worker from the start (behind the menu, the
  // sim and the terrain build), so props.prewarm() only has to compose them.
  let onFoliageProgress = (_fraction: number) => {};
  const foliage = paintAtlasesOffThread((f) => onFoliageProgress(f));

  let menu: MenuResult;
  if (demo) menu = { kind: 'new', player: GUEST, slot: 'main' }; // the showcase zoo is never saved
  else if (intent && intent.kind !== 'menu') menu = intent;
  else {
    menu = await showMainMenu(uiRoot, {
      cloud,
      prompts,
      quality,
      onQuality: (q) => {
        quality = q;
        storageSet(QUALITY_KEY, q);
      },
      preselect: intent?.player,
      openVersus: (root, player) =>
        openVersusHub(root, { cloud, player, tutorialDone: readTutorialState(storage, player.ref).status === 'done' }),
      tutorialState: (p) => readTutorialState(storage, p),
      storage,
    });
  }
  const versusMatchId = menu.kind === 'versus' ? (menu.matchId ?? matchIdOf(menu.slot)) : null;
  const inVersus = !!versusMatchId;

  if (menu.discard) cloud.local.remove(slotKey(menu.player, menu.discard));
  const player = cloud.profiles.player(menu.player);
  if (!demo) {
    cloud.profiles.setLast(menu.player);
    writeActiveSlot(storage, menu.player, menu.slot);
  }
  const activeKey: SlotKey = slotKey(menu.player, menu.slot);

  // ------------------------------------------------------------ zoo switching (spec §7.3)
  let switching = false;
  let saveImpl: () => 'saved' | 'showcase' | 'kept' | 'failed' = () => 'kept';
  let versusCtrl: VersusController | null = null;
  const switchSlot = async (t: BootIntent): Promise<void> => {
    if (switching) return;
    switching = true;
    try {
      saveImpl();
      if (!versusCtrl) await Promise.race([cloud.sync.onLeave(activeKey), sleep(LEAVE_WAIT_MS)]);
      else versusCtrl.onHidden(KEEPALIVE_BUDGET - 2048);
    } catch (err) {
      console.warn('[switch] leaving the zoo failed', err);
    }
    try {
      sessionStorage.setItem(BOOT_INTENT_KEY, JSON.stringify(t));
    } catch {
      /* no session storage: the menu opens instead */
    }
    location.reload();
    // keep callers waiting: the page is going away
    await new Promise<never>(() => {});
  };
  const toMenu = () => switchSlot({ kind: 'menu', player: menu.player });

  const loader = showLoadingScreen(uiRoot);
  const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  loader.setProgress(0.03, 'Surveying the land…');
  await nextFrame();

  // Open the slot: lease, head check, pull or a prompt before loading (signed in, main slot);
  // offline or a guest: the local copy at once.
  let opened: OpenedSlot | null = null;
  const opensMain = menu.kind === 'continue' || (menu.kind === 'new' && menu.slot === 'main' && !!player.profileId);
  if (!demo && !inVersus && opensMain) {
    opened = await cloud.sync.openSlot(activeKey, prompts);
    if (opened.kind === 'cancelled') return toMenu();
    if (opened.kind === 'blocked') {
      await prompts.notice(opened.reason === 'newer_version' ? 'newerVersion' : 'profileGone', { profileName: player.name ?? 'This player' });
      return toMenu();
    }
  }
  const saveText = menu.kind === 'continue' && opened?.kind === 'ok' ? opened.json : null;

  // ?seed=<n> makes a new zoo (and the demo layout) reproducible, so screenshots
  // and draw-call numbers can be compared between builds; otherwise it is random.
  // Debug parameters are ignored in a versus match (the match fixes the zoo and the clock).
  const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
  const seed = Number.isFinite(seedParam) && !inVersus ? seedParam : undefined;

  const events = new EventBus();
  const sim = createSimulation(events, seed);
  let loaded = false;
  // Message shown once the UI exists, when Continue could not load the save.
  let loadFailure: string | null = null;
  // False while an unreadable save could not be backed up: autosave must not overwrite it.
  let mayWriteSave = true;
  // Cumulative unpaused foreground play of this slot (spec §3.6), never reset, not even by New zoo.
  let playSeconds = 0;

  if (versusMatchId) {
    versusCtrl = createVersusController({ cloud, events, player, matchId: versusMatchId, save: () => void saveImpl(), switchSlot });
    try {
      await versusCtrl.boot(sim);
    } catch (err) {
      const text = err instanceof VersusBootError ? err.message : "This match couldn't start. Try again in a moment.";
      if (!(err instanceof VersusBootError)) console.error('[versus] boot failed', err);
      versusCtrl.dispose();
      versusCtrl = null;
      await showBootMessage(uiRoot, text);
      return toMenu();
    }
    loaded = true;
    playSeconds = cloud.local.meta(versusCtrl.slotKey)?.playSeconds ?? 0;
  } else {
    playSeconds = (opened?.kind === 'ok' ? opened.meta?.playSeconds : null) ?? (demo ? 0 : (cloud.local.meta(activeKey)?.playSeconds ?? 0));
    if (menu.kind === 'continue' && saveText) {
      try {
        sim.load(JSON.parse(saveText));
        loaded = true;
      } catch (err) {
        console.error('[save] failed to load save, starting a new zoo', err);
        // Keep the player's zoo: copy it to a backup slot before anything can overwrite it
        // (guest: '-unreadable' keys as before; a profile slot: wh2:bad, and the cloud copy is pinned).
        mayWriteSave = cloud.local.markUnreadable(activeKey, saveText);
        loadFailure = mayWriteSave
          ? 'Your saved zoo could not be loaded, so a new zoo was started. The old save was kept as a backup.'
          : 'Your saved zoo could not be loaded. This new zoo will not be saved, so the old save is kept.';
      }
    }
  }
  if (!loaded) sim.newGame(undefined, demo ? undefined : { startMinute: NEW_ZOO_START_MINUTE });
  const timeParam = inVersus ? null : params.get('time');
  const paramMinute = timeParam
    ? (() => {
        const [hh, mm] = timeParam.split(':').map(Number);
        return (hh || 0) * 60 + (mm || 0);
      })()
    : null;
  if (demo) {
    const report = buildDemoZoo(sim, seed);
    console.log('[demo]', JSON.stringify(report));
    // Warm up from opening time so guests arrive (and get hungry) naturally and
    // are spread around the zoo by the time the camera shows up.
    const target = Math.min(paramMinute ?? 11 * 60, (CLOSE_HOUR - 1) * 60);
    sim.minuteOfDay = OPEN_HOUR * 60 - 10;
    sim.setSpeed(3);
    let guard = 0;
    while (sim.minuteOfDay < target && guard++ < 4000) sim.update(0.1);
    sim.setSpeed(soak ? 3 : 1);
  }
  if (paramMinute !== null) sim.minuteOfDay = paramMinute;
  if (params.has('paused') && !inVersus) sim.setSpeed(0);

  loader.setProgress(0.12, 'Shaping terrain and sky…');
  await nextFrame();
  const ctx = await createRenderContext(gameRoot, sim.world, events, quality);
  // versus and the soak test: re-capture the sky at most every 20 s, no sun-jump bypass (spec §5.8)
  if (inVersus || soak) ctx.setEnvCaptureFloor?.(20, false);

  loader.setProgress(0.25, 'Planting trees…');
  await nextFrame();
  const props = createPropsLayer(sim.world, events, ctx.scene, ctx.quality);
  // Usually done by now; waiting keeps prewarm from painting the rest again.
  onFoliageProgress = (f) => loader.setProgress(0.25 + 0.075 * f, 'Planting trees…');
  await foliage;
  await props.prewarm((f) => loader.setProgress(0.25 + 0.15 * f, 'Planting trees…'));

  loader.setProgress(0.4, 'Welcoming the animals…');
  await nextFrame();
  const creatures = createCreatureFactory(ctx.quality);
  ctx.scene.add(creatures.root);
  // Build only the species already in the zoo; others are built when first bought.
  const present = new Set<string>();
  for (const a of sim.animals.values()) present.add(a.speciesId);
  await creatures.preload([...present], (f) => loader.setProgress(0.4 + 0.35 * f, 'Welcoming the animals…'));

  loader.setProgress(0.75, 'Opening the gates…');
  const gates = (from: number, to: number) => (f: number) => loader.setProgress(from + (to - from) * f, 'Opening the gates…');
  await nextFrame();
  const views = createEntityViews(sim, ctx, creatures, props);
  // Create every creature model now and build their distance LODs while the
  // loading screen is up, so the first frames don't draw full meshes everywhere.
  await views.prepare(gates(0.75, 0.79));
  views.update(0);
  if (creatures.warmLods) await creatures.warmLods(gates(0.79, 0.83));

  // ------------------------------------------------------------ saving (spec §3.6, §7.2)
  // Every save goes through the LocalStore: the guest's plain-JSON key exactly as before, a profile
  // slot as a compressed record that the sync engine pushes (a versus slot is local-only).
  const saveKey: SlotKey = versusCtrl ? versusCtrl.slotKey : activeKey;
  const save = (): 'saved' | 'showcase' | 'kept' | 'failed' => {
    if (demo) return 'showcase'; // never overwrite the player's save with the showcase zoo
    if (!mayWriteSave) return 'kept'; // the unreadable save could not be backed up: keep it
    try {
      const r = cloud.local.write(saveKey, JSON.stringify(sim.serialize()), metaFromSim(sim, playSeconds));
      if (r === 'failed') {
        events.emit('notify', { text: 'Could not save the game (storage full?)', kind: 'bad' });
        return 'failed';
      }
      if (!versusCtrl) cloud.sync.noteSaved(saveKey);
      return 'saved';
    } catch (err) {
      console.error('[save] serialize failed', err);
      return 'failed';
    }
  };
  saveImpl = save;
  saveForBack = () => void save();
  const newGame = () => {
    sim.newGame(undefined, { startMinute: NEW_ZOO_START_MINUTE });
    events.emit('worldReset', {});
    save();
  };

  const audio = createAudio(sim, events, { lowSpec: ctx.quality.level === 'low' });
  audio.setEnabled(storageGet(SOUND_KEY) !== '0');
  applyPrefs(audio, parsePrefs(storageGet(AUDIO_PREFS_KEY)));
  // Mobile browsers only start audio from a user gesture.
  const unlockAudio = () => audio.resume();
  window.addEventListener('pointerdown', unlockAudio, { passive: true });

  // ------------------------------------------------------------ UI extensions (spec §7.2)
  const extensions: UIExtension[] = [];
  let tutorial: TutorialExtension | null = null;
  if (!demo) {
    // the showcase/soak zoo never runs the tutorial (it would also record the guest's tutorial state)
    const start: 'first' | 'practice' | null =
      menu.kind === 'tutorial' ? 'practice' : menu.kind === 'new' && (menu.startTutorial || wantsFirstRun(storage, menu.player)) ? 'first' : null;
    tutorial = createTutorialExtension({ player, start, versusEnabled: cloud.enabled });
    extensions.push(tutorial);
  }
  if (cloud.enabled && !demo) extensions.push(createAccountExtension(cloud, { player, prompts }));
  if (versusCtrl) extensions.push(createVersusExtension(versusCtrl));
  // the player's tutorial state follows them to their other devices
  events.on('tutorial', () => {
    if (player.profileId) cloud.profiles.syncTutorialState(player.profileId);
  });

  const deps: UIDeps = { sim, ctx, props, creatures, views, audio, save, newGame, player, switchSlot, extensions };
  const gameUI = createGameUI(uiRoot, deps);
  ui = gameUI;
  // the follow camera swings around outcrops (kept, unlike smaller rocks) that hide its subject
  gameUI.camera.blockerQuery = followBlockers;

  // Keep every layer on the same quality tier when the player changes it in Settings.
  let appliedQuality = ctx.quality.level;
  const syncQuality = () => {
    if (ctx.quality.level === appliedQuality) return;
    appliedQuality = ctx.quality.level;
    props.setQuality(ctx.quality);
    creatures.setQuality(ctx.quality);
  };

  // Make sure every layer has drawn the initial world (some layers may have been
  // created after the world was generated/loaded).
  events.emit('worldReset', {});
  props.setLitter(sim.litter.values());

  // Litter is redrawn at most once per frame when it changes.
  let litterDirty = false;
  events.on('litterAdded', () => (litterDirty = true));
  events.on('litterRemoved', () => (litterDirty = true));
  events.on('worldReset', () => (litterDirty = true));

  // moonlit ground plants (grass clumps, ferns, reeds, bushes), animals and people take the moonlit ground's look
  const setNightGround = () => {
    const level = nightGroundLevel(Math.asin(ctx.sunDirection.y) * (180 / Math.PI));
    setNatureNightGround(level);
    setFigureNightGround(level);
  };

  // Compile and first-draw every shader program behind the loading screen, a
  // few materials per frame (see loader.ts): props, creatures, night lights and
  // the selection ring all exist now. Warming up at night also draws the
  // night-only objects, so the first minutes of play and the first dusk don't stall.
  const updateLayers = (minute: number) => {
    ctx.setTimeOfDay(minute, sim.day);
    ctx.settle();
    creatures.update(ctx.camera);
    setNightGround();
    props.update(0, ctx.nightFactor, ctx.camera);
    ctx.update(0);
  };
  await nextFrame();
  // Capture the sky environment for the loaded time in a frame of its own (a
  // long GPU job) and keep it through the warm-up at night: one capture per
  // load, never stacked on a full frame.
  updateLayers(sim.minuteOfDay);
  renderEmptyFrame(ctx);
  await nextFrame();
  const releaseEnvironment = ctx.holdEnvironment();
  try {
    updateLayers(22 * 60);
    await warmUpShaders(ctx, nextFrame, gates(0.83, 0.99));
  } catch (err) {
    console.warn('[boot] shader warm-up failed', err);
  }
  // Start with exposure and sky lighting already adapted to the loaded time.
  updateLayers(sim.minuteOfDay);
  releaseEnvironment();
  // the first game frame, with its own shadow map (low refreshes it every other frame)
  ctx.renderer.shadowMap.needsUpdate = true;
  ctx.render();

  loader.setProgress(1, 'Welcome to Wildhaven!');
  await nextFrame();
  loader.hide();
  // the match clock waits for 3-2-1 "Go!"
  versusCtrl?.startCountdown();
  if (loadFailure) events.emit('notify', { text: loadFailure, kind: 'bad' });

  // ------------------------------------------------------------ sync events (spec §3.8, §7.4)
  // The clock is held (sim.update(0)) until this time (performance.now ms): the resume check and
  // an open lease-lost choice.
  let holdUntil = 0;
  let leaseBusy = false;
  const handleLeaseLost = async (info: LeaseLostInfo) => {
    if (leaseBusy || switching) return;
    leaseBusy = true;
    holdUntil = Number.POSITIVE_INFINITY;
    try {
      // ≤ 120 s of play here: a notice (this copy becomes a backup); more: the two-card choice
      const keep = await prompts.chooseLeaseLost(info);
      const r = await cloud.sync.resolveLeaseLost(activeKey, keep);
      if (r === 'reload') {
        await toMenu();
        return;
      }
    } catch (err) {
      console.warn('[sync] lease-lost handling failed', err);
    } finally {
      leaseBusy = false;
      if (!switching) holdUntil = 0;
    }
  };
  const pulledNewer = (fromDevice: string) => {
    if (switching) return;
    prompts.toast(`Got ${player.name ?? 'your'}${player.name ? "'s" : ''} newer zoo from ${fromDevice}`);
    void switchSlot({ kind: 'continue', player: menu.player, slot: 'main' });
  };
  const onResume = (r: ResumeResult) => {
    if (r.kind === 'reload') pulledNewer(r.fromDevice);
    else if (r.kind === 'leaseLost') void handleLeaseLost(r.info);
  };
  if (!versusCtrl) {
    cloud.sync.on('leaseLost', (e) => {
      if (e.key === activeKey) void handleLeaseLost(e.info);
    });
    cloud.sync.on('pulledNewer', (e) => {
      if (e.key === activeKey) pulledNewer(e.fromDevice);
    });
  }
  cloud.sync.on('profileGone', (e) => {
    if (e.profileId !== player.profileId || switching) return;
    holdUntil = Number.POSITIVE_INFINITY;
    void prompts.notice('profileGone', { profileName: player.name ?? 'This player' }).then(() => toMenu());
  });

  // ------------------------------------------------------------ main loop
  let last = performance.now();
  let running = true;
  let rafId = 0; // the one pending animation frame (0 = none); never start a second loop
  let autosaveTimer = 0;
  const AUTOSAVE_SECONDS = 90;
  const soakRecorder = soak ? createSoakRecorder() : null;

  // Frame-rate governor: a slow-paced management game doesn't need 90/120 Hz,
  // and low-tier phones keep steadier pacing (and cooler) at 30 fps. While the
  // game is paused and nobody touches the screen, a few frames a second suffice.
  // Every versus match (and the soak test) runs at ≤ 30 fps on every tier (spec §5.8).
  let lastInput = performance.now();
  const noteInput = () => (lastInput = performance.now());
  for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const) {
    window.addEventListener(type, noteInput, { passive: true, capture: true });
  }
  const IDLE_MS = 2000;
  const frameInterval = (now: number): number => {
    if (sim.versus || soak) return 1000 / 30;
    if (sim.speed === 0 && now - lastInput > IDLE_MS) return 1000 / 10;
    return 1000 / (ctx.quality.level === 'low' ? 30 : 60);
  };
  let nextRender = 0;
  // this frame's swimming animals, for their ripples on the water (one list of reused records, refilled per frame)
  const swimmers: Swimmer[] = [];
  const collectSwimmers = () => {
    let n = 0;
    for (const a of sim.animals.values()) {
      if (a.action !== 'swim') continue;
      const s = swimmers[n] ?? (swimmers[n] = { x: 0, z: 0, heading: 0, speed: 0, length: 0 });
      s.x = a.x;
      s.z = a.z;
      s.heading = a.heading;
      s.speed = a.speed;
      // juveniles are drawn at 0.4 → 1 of the adult size as they grow
      s.length = (SPECIES_BY_ID[a.speciesId]?.length ?? 1) * (0.4 + 0.6 * a.growth);
      n++;
    }
    swimmers.length = n;
  };

  // the followed subject as drawn, refreshed each frame without allocating
  const followPos = new Vector3();
  const frame = (now: number) => {
    rafId = 0;
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    const interval = frameInterval(now);
    // 3 ms slack so a 60 Hz display isn't skipping frames at a 60 fps target.
    if (now < nextRender - 3) return;
    // Keep the cadence (a 90 Hz display renders 2 of 3 frames for 60 fps), but
    // after a stall start over from now instead of rendering a burst to catch up.
    nextRender = Math.max(nextRender + interval, now + interval / 2);
    const raw = Math.max(0, (now - last) / 1000);
    last = now;
    // the UI, the views and the camera always move with real time; the sim's step is held at 0
    // through the versus countdown, the resume check and an open lease-lost choice
    const dt = Math.min(0.1, raw);
    let simDt = versusCtrl ? versusCtrl.frameDt(raw) : dt;
    if (holdUntil > now) simDt = 0;
    try {
      sim.update(simDt);
      ctx.setTimeOfDay(sim.minuteOfDay, sim.day);
      gameUI.update(dt);
      views.update(dt);
      // the follow cuts of crowns and near occluders (props/lod/fade.ts) aim at the followed subject as drawn
      const followed = gameUI.followed;
      const followedAt = followed && views.positionInto(followed, followPos) ? followPos : null;
      setFollowCut(followedAt, dt);
      // other animals between the camera and a followed animal or person are left out of the view (models/crowd/batch.ts)
      setCreatureFollowCut(followed && followed.kind !== 'object' && followed.kind !== 'habitat' ? followedAt : null);
      creatures.update(ctx.camera);
      syncQuality();
      if (litterDirty) {
        litterDirty = false;
        props.setLitter(sim.litter.values());
      }
      setNightGround();
      props.update(dt, ctx.nightFactor, ctx.camera);
      collectSwimmers();
      ctx.setWakes(swimmers);
      audio.update(dt, ctx.camera, gameUI.focus);
      ctx.update(dt);
      ctx.render();
    } catch (err) {
      console.error('[loop]', err);
    }
    try {
      versusCtrl?.update(raw);
    } catch (err) {
      console.error('[versus]', err);
    }
    soakRecorder?.update(raw);
    // unique play of this slot: real foreground seconds while the clock runs
    if (simDt > 0 && sim.speed > 0) playSeconds += Math.min(raw, 1);
    if (versusCtrl) {
      if (versusCtrl.wantsSave()) save();
    } else {
      autosaveTimer += dt;
      if (autosaveTimer > AUTOSAVE_SECONDS) {
        autosaveTimer = 0;
        save();
      }
    }
  };
  rafId = requestAnimationFrame(frame);

  // ------------------------------------------------------------ lifecycle (spec §7.5)
  // One onHidden per hide cycle (visibilitychange → hidden, pagehide, Capacitor pause) and one
  // onVisible (visibilitychange → visible, Capacitor resume). The browser holds the frame queued
  // before hiding and runs it on resume, so it is cancelled here; otherwise every
  // background/foreground cycle adds a loop.
  let hidden = false;
  let hiddenAt = 0;
  const onHidden = () => {
    if (hidden) return;
    hidden = true;
    save();
    let used = 0;
    try {
      used = versusCtrl?.onHidden(KEEPALIVE_BUDGET - 2048) ?? 0;
    } catch (err) {
      console.warn('[versus] onHidden failed', err);
    }
    try {
      used += cloud.sync.onHidden(versusCtrl ? null : activeKey, Math.max(0, KEEPALIVE_BUDGET - 2048 - used));
    } catch (err) {
      console.warn('[sync] onHidden failed', err);
    }
    tutorial?.stopSpeech();
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    audio.suspend();
    hiddenAt = Date.now();
  };
  const onVisible = () => {
    if (!hidden) return;
    hidden = false;
    const hiddenMs = Math.max(0, Date.now() - hiddenAt);
    running = true;
    audio.resume();
    last = performance.now();
    nextRender = 0;
    if (!rafId) rafId = requestAnimationFrame(frame);
    if (switching) return;
    if (versusCtrl) {
      versusCtrl.onVisible(); // budget check + 3-2-1 countdown
      void cloud.sync.onVisible(null, hiddenMs).catch(() => undefined);
      return;
    }
    if (player.profileId && menu.slot === 'main' && hiddenMs > RESUME_CHECK_AFTER_MS) {
      // the resume hold: the clock waits ≤ 2 s for the lease and head check
      holdUntil = performance.now() + RESUME_HOLD_MS + 500;
      void cloud.sync
        .onVisible(activeKey, hiddenMs)
        .then((r) => {
          if (holdUntil !== Number.POSITIVE_INFINITY) holdUntil = 0;
          onResume(r);
        })
        .catch(() => {
          if (holdUntil !== Number.POSITIVE_INFINITY) holdUntil = 0;
        });
    } else {
      void cloud.sync.onVisible(activeKey, hiddenMs).then(onResume).catch(() => undefined);
    }
  };
  document.addEventListener('visibilitychange', () => (document.hidden ? onHidden() : onVisible()));
  window.addEventListener('pagehide', onHidden);
  if (Capacitor.isNativePlatform()) {
    // also covers interruptions that leave the page visible (Capacitor never pauses the WebView)
    void App.addListener('pause', onHidden);
    void App.addListener('resume', onVisible);
  }

  const resize = () => ctx.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  resize();

  // Expose for debugging / automated screenshots and the end-to-end tests.
  (window as unknown as Record<string, unknown>).__game = {
    sim, ctx, props, creatures, views, events, save, ui: gameUI, audio,
    cloud, versus: versusCtrl, switchSlot, menu, player, activeKey,
    playSeconds: () => playSeconds,
  };
  (window as unknown as Record<string, unknown>).__ready = true;
}

boot().catch(fatal);
