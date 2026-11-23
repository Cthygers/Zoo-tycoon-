// UI harness: runs the full Wildhaven UI against mock subsystems (default) or
// the real ones (?real=1).
//
//   ?screen=loading | menu | game | drawer | panel-animal | panel-habitat | panel-guest | panel-object |
//           build-fence | build-path | build-terrain | build-object | build-animal |
//           bulldoze-fence | bulldoze-area | finance | goals | settings | thumbs
//   &cat=animals            (drawer category)
//   &real=1                 use the real sim / renderer / props / models / views
//   &q=low|medium|high

import * as THREE from 'three';
import type { QualityLevel, UIDeps } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { TILE } from '../src/core/constants';
import type { Tool } from '../src/core/types';
import { createGameUI, showLoadingScreen, showMainMenu, type CategoryId, type GameUIHandle } from '../src/ui';
import { buildCatalog } from '../src/ui/catalog';
import { ThumbnailService } from '../src/ui/thumbs';
import { MockAudio, MockCreatures, MockProps, MockRenderContext, MockSim, MockViews } from './ui-mock';

/** The harness keeps nothing, but answers like the game's save (UIDeps.save) so Save now can be tried. */
const harnessSave = () => {
  console.log('[harness] save');
  return 'saved' as const;
};

const params = new URLSearchParams(location.search);
const screen = params.get('screen') ?? 'game';
const real = params.get('real') === '1';
const q = (params.get('q') ?? 'medium') as QualityLevel;
const gameEl = document.getElementById('game')!;
const uiEl = document.getElementById('ui')!;
const w = window as unknown as Record<string, unknown>;

async function makeDeps(): Promise<UIDeps> {
  const events = new EventBus();
  if (real) {
    const [{ createSimulation }, { createRenderContext }, { createPropsLayer }, { createCreatureFactory }, { createEntityViews }, { buildDemoZoo }, { createAudio }] = await Promise.all([
      import('../src/sim'),
      import('../src/render'),
      import('../src/props'),
      import('../src/models'),
      import('../src/views'),
      import('../src/demo'),
      import('../src/audio'),
    ]);
    const sim = createSimulation(events, 42);
    sim.newGame();
    buildDemoZoo(sim);
    sim.setSpeed(3);
    for (let i = 0; i < 200; i++) {
      sim.minuteOfDay = 11 * 60;
      sim.update(0.1);
    }
    sim.setSpeed(1);
    const ctx = await createRenderContext(gameEl, sim.world, events, q);
    const props = createPropsLayer(sim.world, events, ctx.scene, ctx.quality);
    const creatures = createCreatureFactory(ctx.quality);
    ctx.scene.add(creatures.root);
    await creatures.preload(['zebra', 'giraffe', 'lion']);
    const views = createEntityViews(sim, ctx, creatures, props);
    const audio = createAudio(sim, events);
    events.emit('worldReset', {});
    return { sim, ctx, props, creatures, views, audio, save: harnessSave, newGame: () => sim.newGame() };
  }
  const sim = new MockSim(events);
  const ctx = new MockRenderContext(gameEl, sim.world, events, q);
  const props = new MockProps(sim.world, events, ctx.scene);
  const creatures = new MockCreatures();
  const views = new MockViews(sim, ctx, creatures);
  const audio = new MockAudio();
  w.__cues = audio.cues;
  return { sim, ctx, props, creatures, views, audio, save: harnessSave, newGame: () => sim.newGame() };
}

function ndcOf(deps: UIDeps, x: number, z: number): { x: number; y: number } {
  const v = new THREE.Vector3(x, deps.sim.world.heightAt(x, z), z).project(deps.ctx.camera);
  return { x: v.x, y: v.y };
}

function drag(ui: GameUIHandle, deps: UIDeps, a: { x: number; z: number }, b: { x: number; z: number }): void {
  const p = ndcOf(deps, a.x, a.z);
  const r = ndcOf(deps, b.x, b.z);
  ui.tools.down(p.x, p.y);
  ui.tools.move(r.x, r.y);
  ui.tools.update(0);
  ui.tools.up(r.x, r.y, false);
}

async function boot() {
  if (screen === 'loading') {
    const l = showLoadingScreen(uiEl);
    l.setProgress(0.62, 'Welcoming the animals…');
    return;
  }
  if (screen === 'menu') {
    const choice = await showMainMenu(uiEl, { hasSave: params.get('save') !== '0', quality: q, onQuality: (x) => console.log('[harness] quality', x) });
    console.log('[harness] menu choice', choice);
    return;
  }

  const deps = await makeDeps();
  if (screen === 'thumbs') {
    // contact sheet of every build-menu thumbnail
    const thumbs = new ThumbnailService(deps.ctx.renderer, deps.props, deps.creatures, deps.ctx.scene);
    const grid = document.createElement('div');
    grid.style.cssText = 'position:fixed;inset:0;background:#18211b;display:grid;grid-template-columns:repeat(auto-fill,minmax(116px,1fr));gap:6px;padding:8px;overflow:auto;pointer-events:auto;font:11px system-ui;color:#eee;z-index:5';
    document.body.append(grid);
    let pending = 0;
    for (const cat of buildCatalog(deps.sim))
      for (const item of cat.items) {
        const cell = document.createElement('div');
        cell.style.cssText = 'background:radial-gradient(120% 90% at 50% 30%,rgba(255,250,235,.14),rgba(255,250,235,.02) 70%);border-radius:10px;padding:4px;text-align:center';
        cell.innerHTML = `<div style="height:92px;display:flex;align-items:center;justify-content:center;opacity:.4">…</div><div>${item.name}</div>`;
        grid.append(cell);
        pending++;
        thumbs.request(item.thumb, (url) => {
          pending--;
          cell.firstElementChild!.outerHTML = `<img src="${url}" style="width:100%;height:92px;object-fit:contain">`;
          w.__pending = pending;
        });
      }
    const tick = () => {
      requestAnimationFrame(tick);
      thumbs.update();
    };
    tick();
    return;
  }
  const ui = createGameUI(uiEl, deps);
  w.__ui = ui;
  w.__deps = deps;
  const resize = () => deps.ctx.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', resize);
  resize();

  let last = performance.now();
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    deps.sim.update(dt);
    deps.ctx.setTimeOfDay(deps.sim.minuteOfDay, deps.sim.day);
    ui.update(dt);
    deps.views.update(dt);
    deps.creatures.update(deps.ctx.camera);
    deps.props.update(dt, deps.ctx.nightFactor, deps.ctx.camera);
    deps.ctx.update(dt);
    deps.ctx.render();
  };
  ui.update(0);

  const sim = deps.sim;
  const anyAnimal = (sp?: string) => Array.from(sim.animals.values()).find((a) => !sp || a.speciesId === sp);
  const habitatNamed = (n: string) => Array.from(sim.world.habitats.values()).find((h) => h.name === n) ?? Array.from(sim.world.habitats.values())[0];
  const tool = (t: Tool) => ui.setTool(t);

  switch (screen) {
    case 'game':
      setTimeout(() => {
        sim.events.emit('notify', { text: 'A guest says the zebras are wonderful!', kind: 'good', focus: { x: 56, z: 100 } });
        sim.events.emit('moneyPopup', { x: 73, z: 116, amount: 20 });
        sim.events.emit('moneyPopup', { x: 66, z: 112, amount: 6 });
      }, 300);
      break;
    case 'toasts':
      setTimeout(() => {
        sim.events.emit('notify', { text: 'Grace Mwangi joined as a keeper ($90/day).', kind: 'good', focus: { x: 73, z: 116 } });
        sim.events.emit('notify', { text: 'Guests are complaining there is nowhere to sit.', kind: 'warn' });
        sim.events.emit('notify', { text: 'Not enough money (needs $14,000, you have $9,250)', kind: 'bad' });
        sim.events.emit('notify', { text: 'Not enough money (needs $14,000, you have $9,250)', kind: 'bad' });
        sim.events.emit('objectiveCompleted', { id: 'o3', text: 'Welcome 100 visitors', reward: 3000 });
        for (let i = 0; i < 5; i++) sim.events.emit('moneyPopup', { x: 66 + i * 3, z: 114 - i * 2, amount: i % 2 ? 6 : 20 });
      }, 1200);
      break;
    case 'drawer':
      ui.openCategory((params.get('cat') ?? 'animals') as CategoryId);
      break;
    case 'panel-animal': {
      const a = anyAnimal('giraffe') ?? anyAnimal();
      if (a) {
        ui.camera.setView(a.x - 4, a.z, 26, 0.5, 0.62);
        ui.select({ kind: 'animal', id: a.id });
      }
      break;
    }
    case 'panel-guest': {
      const g = Array.from(sim.guests.values())[3];
      if (g) {
        ui.camera.setView(g.x, g.z, 18, 0.3, 0.6);
        ui.select({ kind: 'guest', id: g.id });
      }
      break;
    }
    case 'panel-staff': {
      const st = Array.from(sim.staff.values())[0];
      if (st) {
        ui.camera.setView(st.x, st.z, 18, 0.3, 0.6);
        ui.select({ kind: 'staff', id: st.id });
      }
      break;
    }
    case 'panel-object': {
      const o = Array.from(sim.world.objects.values()).find((x) => x.defId === (params.get('def') ?? 'shop_drinks')) ?? Array.from(sim.world.objects.values())[1];
      if (o) {
        const c = sim.world.objectCenter(o);
        ui.camera.setView(c.x, c.z, 16, 0.4, 0.6);
        ui.select({ kind: 'object', id: o.id });
      }
      break;
    }
    case 'panel-habitat': {
      const h = habitatNamed('Savanna Plains');
      if (h) {
        ui.camera.setView(((h.minX + h.maxX + 1) / 2) * TILE + 6, ((h.minZ + h.maxZ + 1) / 2) * TILE + 4, 46, 0.3, 0.85);
        ui.select({ kind: 'habitat', id: h.id });
      }
      break;
    }
    case 'build-fence': {
      ui.camera.setView(108, 98, 44, -0.25, 0.8);
      ui.update(0);
      tool({ kind: 'fence', fenceId: 2 });
      drag(ui, deps, { x: 49 * TILE, z: 42 * TILE }, { x: 58 * TILE, z: 50 * TILE });
      break;
    }
    case 'build-path': {
      ui.camera.setView(108, 98, 40, -0.25, 0.85);
      ui.update(0);
      tool({ kind: 'path', pathType: 2 });
      drag(ui, deps, { x: 49.5 * TILE, z: 44.5 * TILE }, { x: 58.5 * TILE, z: 51.5 * TILE });
      break;
    }
    case 'build-terrain': {
      ui.camera.setView(108, 98, 40, -0.25, 0.85);
      ui.update(0);
      tool({ kind: 'terrain', terrain: 3, brush: 1 });
      drag(ui, deps, { x: 50.5 * TILE, z: 44.5 * TILE }, { x: 56.5 * TILE, z: 49.5 * TILE });
      break;
    }
    case 'build-object':
    case 'build-animal': {
      const h = habitatNamed('Savanna Plains');
      const isObj = screen === 'build-object';
      const cx = (h.minX + h.maxX) / 2,
        cz = (h.minZ + h.maxZ) / 2;
      // a valid spot near the habitat centre, preferring tiles with open space around them
      const tiles = h.tiles
        .map((i) => ({ x: i % sim.world.w, z: Math.floor(i / sim.world.w) }))
        .sort((p1, p2) => Math.hypot(p1.x - cx, p1.z - cz) - Math.hypot(p2.x - cx, p2.z - cz));
      const spot =
        tiles.find((t) =>
          isObj
            ? sim.placeObject('shelter_wood', t.x, t.z, 0, true).ok
            : sim.buyAnimal('elephant', (t.x + 0.5) * TILE, (t.z + 0.5) * TILE, true).ok &&
              [-1, 0, 1].every((d) => !sim.world.objectAt(t.x + d, t.z) && !sim.world.objectAt(t.x, t.z + d)),
        ) ?? tiles[0];
      const sx = (spot.x + (isObj ? 1 : 0.5)) * TILE,
        sz = (spot.z + (isObj ? 1 : 0.5)) * TILE;
      ui.camera.setView(sx, sz, isObj ? 20 : 24, 0.35, 0.62);
      ui.update(0);
      tool(isObj ? { kind: 'object', defId: 'shelter_wood', rot: 0 } : { kind: 'animal', speciesId: 'elephant' });
      const p = ndcOf(deps, sx, sz);
      ui.tools.down(p.x, p.y);
      ui.tools.up(p.x, p.y, true);
      break;
    }
    case 'bulldoze-fence':
    case 'bulldoze-area': {
      // the east side of the first habitat: tap it (fence mode) or sweep a rectangle over it (area mode)
      const h = habitatNamed('Savanna Plains');
      const ex = (h.maxX + 1) * TILE,
        ez = ((h.minZ + h.maxZ + 1) / 2) * TILE;
      ui.camera.setView(ex, ez, 34, 0.9, 0.75);
      ui.update(0);
      tool({ kind: 'bulldoze' });
      if (screen === 'bulldoze-fence') {
        ui.tools.setBulldozeMode('fence');
        const p = ndcOf(deps, ex + 0.3, ez);
        ui.tools.down(p.x, p.y);
        ui.tools.up(p.x, p.y, true);
      } else drag(ui, deps, { x: ex - 3 * TILE, z: ez - 2 * TILE }, { x: ex + 1 * TILE, z: ez + 2 * TILE });
      break;
    }
    case 'finance':
      ui.openZooPanel('finance');
      break;
    case 'goals':
      ui.openZooPanel('goals');
      break;
    case 'settings':
      ui.openZooPanel('settings');
      break;
    default:
      break;
  }
  requestAnimationFrame(frame);
  w.__ready = true;
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;left:8px;top:8px;color:#f88;z-index:999">${String(err?.stack ?? err)}</pre>`);
});
