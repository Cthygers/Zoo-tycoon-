// Wildhaven Zoo — entry point. Boots the title menu, builds every subsystem,
// and runs the main loop (simulate → animate → render), with autosave and
// Android lifecycle handling (pause when the app is backgrounded).

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { createAudio } from './audio';
import { CLOSE_HOUR, OPEN_HOUR, QUALITY_KEY, SAVE_KEY, SOUND_KEY } from './core/constants';
import type { QualityLevel } from './core/contracts';
import { EventBus } from './core/events';
import { SPECIES } from './data/species';
import { createCreatureFactory } from './models';
import { createPropsLayer } from './props';
import { createRenderContext, detectQuality } from './render';
import { createSimulation } from './sim';
import { createGameUI, showLoadingScreen, showMainMenu } from './ui';
import { createEntityViews } from './views';
import { buildDemoZoo } from './demo';

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

async function boot() {
  const gameRoot = document.getElementById('game')!;
  const uiRoot = document.getElementById('ui')!;

  const params = new URLSearchParams(location.search);
  const demo = params.has('demo');
  const qParam = params.get('q') as QualityLevel | null;
  let quality = qParam ?? (storageGet(QUALITY_KEY) as QualityLevel | null) ?? detectQuality();
  const saveText = demo ? null : storageGet(SAVE_KEY);
  const choice = demo ? 'new' : await showMainMenu(uiRoot, {
    hasSave: !!saveText,
    quality,
    onQuality: (q) => {
      quality = q;
      storageSet(QUALITY_KEY, q);
    },
  });

  const loader = showLoadingScreen(uiRoot);
  const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  loader.setProgress(0.03, 'Surveying the land…');
  await nextFrame();

  const events = new EventBus();
  const sim = createSimulation(events);
  let loaded = false;
  if (choice === 'continue' && saveText) {
    try {
      sim.load(JSON.parse(saveText));
      loaded = true;
    } catch (err) {
      console.error('[save] failed to load save, starting a new zoo', err);
    }
  }
  if (!loaded) sim.newGame();
  const timeParam = params.get('time');
  const paramMinute = timeParam
    ? (() => {
        const [hh, mm] = timeParam.split(':').map(Number);
        return (hh || 0) * 60 + (mm || 0);
      })()
    : null;
  if (demo) {
    const report = buildDemoZoo(sim);
    console.log('[demo]', JSON.stringify(report));
    // Warm up from opening time so guests arrive (and get hungry) naturally and
    // are spread around the zoo by the time the camera shows up.
    const target = Math.min(paramMinute ?? 11 * 60, (CLOSE_HOUR - 1) * 60);
    sim.minuteOfDay = OPEN_HOUR * 60 - 10;
    sim.setSpeed(3);
    let guard = 0;
    while (sim.minuteOfDay < target && guard++ < 4000) sim.update(0.1);
    sim.setSpeed(1);
  }
  if (paramMinute !== null) sim.minuteOfDay = paramMinute;
  if (params.has('paused')) sim.setSpeed(0);

  loader.setProgress(0.12, 'Shaping terrain and sky…');
  await nextFrame();
  const ctx = await createRenderContext(gameRoot, sim.world, events, quality);

  loader.setProgress(0.25, 'Planting trees…');
  await nextFrame();
  const props = createPropsLayer(sim.world, events, ctx.scene, ctx.quality);
  await props.prewarm((f) => loader.setProgress(0.25 + 0.15 * f, 'Planting trees…'));

  loader.setProgress(0.4, 'Welcoming the animals…');
  await nextFrame();
  const creatures = createCreatureFactory(ctx.quality);
  ctx.scene.add(creatures.root);
  const present = new Set<string>();
  for (const a of sim.animals.values()) present.add(a.speciesId);
  // Build the species already in the zoo first, then a few popular ones so the shop is snappy.
  const preloadList = [...present, ...SPECIES.map((s) => s.id).filter((id) => !present.has(id))].slice(
    0,
    Math.max(present.size, ctx.quality.level === 'low' ? 3 : 6),
  );
  await creatures.preload(preloadList, (f) => loader.setProgress(0.4 + 0.45 * f, 'Welcoming the animals…'));

  loader.setProgress(0.88, 'Opening the gates…');
  await nextFrame();
  const views = createEntityViews(sim, ctx, creatures, props);

  const save = () => {
    if (demo) return; // never overwrite the player's save with the showcase zoo
    try {
      const ok = storageSet(SAVE_KEY, JSON.stringify(sim.serialize()));
      if (!ok) events.emit('notify', { text: 'Could not save the game (storage full?)', kind: 'bad' });
    } catch (err) {
      console.error('[save] serialize failed', err);
    }
  };
  const newGame = () => {
    sim.newGame();
    events.emit('worldReset', {});
    save();
  };

  const audio = createAudio(sim, events);
  audio.setEnabled(storageGet(SOUND_KEY) !== '0');
  // Mobile browsers only start audio from a user gesture.
  const unlockAudio = () => audio.resume();
  window.addEventListener('pointerdown', unlockAudio, { passive: true });

  const ui = createGameUI(uiRoot, { sim, ctx, props, creatures, views, audio, save, newGame });

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

  loader.setProgress(1, 'Welcome to Wildhaven!');
  await nextFrame();
  loader.hide();

  // ------------------------------------------------------------ main loop
  let last = performance.now();
  let running = true;
  let autosaveTimer = 0;
  const AUTOSAVE_SECONDS = 90;

  const frame = (now: number) => {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    try {
      sim.update(dt);
      ctx.setTimeOfDay(sim.minuteOfDay, sim.day);
      ui.update(dt);
      views.update(dt);
      creatures.update(ctx.camera);
      syncQuality();
      if (litterDirty) {
        litterDirty = false;
        props.setLitter(sim.litter.values());
      }
      props.update(dt, ctx.nightFactor, ctx.camera);
      audio.update(dt, ctx.camera, ui.focus);
      ctx.update(dt);
      ctx.render();
    } catch (err) {
      console.error('[loop]', err);
    }
    autosaveTimer += dt;
    if (autosaveTimer > AUTOSAVE_SECONDS) {
      autosaveTimer = 0;
      save();
    }
  };
  requestAnimationFrame(frame);

  // Pause when the app goes to the background (Android home button / screen off) and save.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      save();
      audio.suspend();
      running = false;
    } else if (!running) {
      running = true;
      audio.resume();
      last = performance.now();
      requestAnimationFrame(frame);
    }
  });
  window.addEventListener('pagehide', save);

  // Android back button: close panels / cancel tools first; at the top level,
  // save and send the app to the background instead of killing the zoo.
  if (Capacitor.isNativePlatform()) {
    void App.addListener('backButton', () => {
      if (ui.handleBack()) return;
      save();
      void App.minimizeApp();
    });
    void App.addListener('pause', () => save());
  }

  const resize = () => ctx.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  resize();

  // Expose for debugging / automated screenshots.
  (window as unknown as Record<string, unknown>).__game = { sim, ctx, props, creatures, views, events, save, ui, audio };
  (window as unknown as Record<string, unknown>).__ready = true;
}

boot().catch(fatal);
