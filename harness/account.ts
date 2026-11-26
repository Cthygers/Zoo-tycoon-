// Account harness: the title menu, the player pages, the grown-up check, the sync prompts and
// the in-game account extension, driven by a FakeCloud-backed createCloud (src/net) over this
// page's localStorage (cleared on every load). No server, no real sim.
//
//   ?screen=menu-guest | menu-disabled | menu-signed | menu-practice | menu-match | menu-needs
//          | menu-empty | picker | setup | whosezoo | manage | grownup | signin
//          | conflict | leaselost | leasenotice | takeover | notice
//          | settings | settings-guest | backups | badge
//
// window.__acHarness = { cloud, fake, check() } and window.__acReady = true once drawn.
// check() lists every visible element whose rect leaves the viewport (unless a scrolling parent
// clips it) and every visible account / menu button shorter than 44 px.
import type { Avatar, SaveMeta } from '../shared/api-types';
import type { CloudHandle, ConflictInfo, LeaseLostInfo, SaveCard, SyncEvents } from '../src/core/cloud-types';
import type { MenuResult, PlayerInfo, UIDeps } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { readTutorialState, writeActiveSlot } from '../src/core/player-state';
import { KEYS, slotKey } from '../src/core/storage-keys';
import { encodeSave } from '../src/net/codec';
import { FakeCloud } from '../src/net/fakeCloud';
import { createCloud, type CloudHandleImpl } from '../src/net/index';
import { createGameUI, showLoadingScreen } from '../src/ui';
import { createAccountExtension, createSyncPrompts } from '../src/ui/account';
import { askGrownup } from '../src/ui/account/grownup';
import { signInSheet } from '../src/ui/account/signin';
import { showMainMenu } from '../src/ui/screens';
import { MockAudio, MockCreatures, MockProps, MockRenderContext, MockSim, MockViews } from './ui-mock';

const params = new URLSearchParams(location.search);
const screen = params.get('screen') ?? 'menu-signed';
const gameEl = document.getElementById('game')!;
const uiEl = document.getElementById('ui')!;
const NOW = Date.now();
const H = 3600_000;

const av = (animal: Avatar['animal'], color: number): Avatar => ({ animal, color });
const PLAYERS: [string, Avatar][] = [
  ['Mia', av('zebra', 4)],
  ['Ben', av('elephant', 2)],
  ['Leo', av('tiger', 6)],
  ['Ana', av('lion', 1)],
  ['Sam', av('penguin', 3)],
  ['Zoe', av('flamingo', 7)],
  ['Max', av('bear', 0)],
  ['Ivy', av('giraffe', 5)],
];

function meta(day: number, o: Partial<SaveMeta> = {}): SaveMeta {
  return { day, minute: 860, money: 48_210, rating: 61, animals: 18, species: 5, visitors: 900, playSeconds: 4200, ...o };
}

/** A small valid save (enough for LocalStore; the menu never parses it). */
function zoo(tag: string, day = 12): string {
  return JSON.stringify({ version: 1, tag, day, minuteOfDay: 860, money: 48210, rating: 61, animals: { k: ['speciesId'], r: [['zebra']] }, totalVisitors: 900 });
}

for (const k of Object.keys(localStorage)) if (k.startsWith('wh2:') || k.startsWith('wildhaven-')) localStorage.removeItem(k);
sessionStorage.clear();

const fake = new FakeCloud();
const disabled = screen === 'menu-disabled';
const offline = params.has('offline');

function makeCloud(): CloudHandleImpl {
  return createCloud({
    storage: localStorage,
    fetch: (() => Promise.reject(new Error('no network in the harness'))) as unknown as typeof fetch,
    google: fake.google('parent1', { email: 'parent@example.com' }),
    device: { info: async () => ({ name: 'Phone', platform: 'web', hwId: 'hw-harness' }) },
    appVersion: '0.15.0',
    apiBase: disabled ? '' : 'http://fake.invalid',
    api: disabled ? undefined : (token) => {
      const c = fake.api({ token });
      if (offline) (c as unknown as { offline: boolean }).offline = true;
      return c;
    },
    listenOnline: false,
  });
}

async function signedIn(cloud: CloudHandleImpl, names: number): Promise<string[]> {
  const r = await cloud.auth.signIn();
  if (r.kind !== 'ok') throw new Error(`sign-in: ${JSON.stringify(r)}`);
  const ids: string[] = [];
  for (let i = 0; i < names; i++) ids.push((await cloud.profiles.create(PLAYERS[i][0], PLAYERS[i][1])).id);
  return ids;
}

function card(o: Partial<SaveCard>): SaveCard {
  return { deviceName: 'Phone', thisDevice: true, meta: meta(12), savedAt: NOW - 5 * 60_000, uniquePlaySeconds: 600, newest: false, playingNow: false, ...o };
}

const prompts = () => createSyncPrompts(uiEl, cloudRef);
let cloudRef: CloudHandle | null = null;

async function menu(cloud: CloudHandleImpl, preselect?: string): Promise<void> {
  const r = await showMainMenu(uiEl, {
    cloud,
    prompts: prompts(),
    quality: 'medium',
    onQuality: (q) => console.log('[harness] quality', q),
    preselect,
    openVersus: async (_root, player: PlayerInfo): Promise<MenuResult | null> => {
      console.log('[harness] versus for', player.name);
      return null;
    },
    tutorialState: (p) => readTutorialState(localStorage, p),
  });
  console.log('[harness] menu result', JSON.stringify(r));
  (window as unknown as { __menuResult: MenuResult }).__menuResult = r;
}

/** The game UI (mocks) with the account extension mounted. */
function game(cloud: CloudHandleImpl, player: PlayerInfo): { deps: UIDeps; ui: ReturnType<typeof createGameUI>; fire: <E extends keyof SyncEvents>(e: E, p: SyncEvents[E]) => void } {
  // let the harness fire sync events the extension listens to
  const listeners: { [K in keyof SyncEvents]?: ((p: SyncEvents[K]) => void)[] } = {};
  const sync = Object.create(cloud.sync) as CloudHandleImpl['sync'];
  sync.on = <E extends keyof SyncEvents>(e: E, fn: (p: SyncEvents[E]) => void) => {
    (listeners[e] ??= [] as never[]).push(fn as never);
    return cloud.sync.on(e, fn);
  };
  const view = Object.create(cloud) as CloudHandleImpl;
  Object.defineProperty(view, 'sync', { value: sync });
  const events = new EventBus();
  const sim = new MockSim(events);
  const ctx = new MockRenderContext(gameEl, sim.world, events, 'low');
  const props = new MockProps(sim.world, events, ctx.scene);
  const creatures = new MockCreatures();
  const views = new MockViews(sim, ctx, creatures);
  const audio = new MockAudio();
  const deps: UIDeps = {
    sim, ctx, props, creatures, views, audio,
    save: () => 'saved',
    newGame: () => sim.newGame(),
    player,
    switchSlot: async (t) => console.log('[harness] switchSlot', JSON.stringify(t)),
    extensions: [createAccountExtension(view, { player, prompts: prompts() })],
  };
  const ui = createGameUI(uiEl, deps);
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    ui.update(dt);
    ctx.render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const fire = <E extends keyof SyncEvents>(e: E, p: SyncEvents[E]) => (listeners[e] ?? []).forEach((fn) => (fn as (x: SyncEvents[E]) => void)(p));
  return { deps, ui, fire };
}

const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));

async function run(): Promise<void> {
  const cloud = makeCloud();
  cloudRef = cloud;
  (window as unknown as { __acHarness: unknown }).__acHarness = { cloud, fake, check };
  await cloud.init();
  switch (screen) {
    case 'menu-disabled': {
      localStorage.setItem(KEYS.guestMain, zoo('guest'));
      void menu(cloud);
      break;
    }
    case 'menu-guest': {
      localStorage.setItem(KEYS.guestMain, zoo('guest'));
      void menu(cloud);
      break;
    }
    case 'menu-empty': {
      void menu(cloud);
      break;
    }
    case 'menu-signed':
    case 'menu-practice':
    case 'menu-match':
    case 'menu-needs': {
      const [mia] = await signedIn(cloud, 1);
      cloud.local.write(slotKey(mia, 'main'), zoo('mia'), meta(15));
      if (screen === 'menu-practice') {
        cloud.local.write(slotKey(mia, 'practice'), zoo('practice', 1), meta(1, { animals: 0, rating: 0 }));
        writeActiveSlot(localStorage, mia, 'practice');
      }
      if (screen === 'menu-match') {
        writeActiveSlot(localStorage, mia, 'vs-m42');
        localStorage.setItem(KEYS.vs(mia, 'm42'), JSON.stringify({ v: 1, ended: null, finishQueued: false, match: { id: 'm42', status: 'active', mySeat: 0, players: [{ seat: 0, state: 'playing', doneAt: null }] } }));
      }
      localStorage.setItem(KEYS.vsIndex(mia), JSON.stringify({ v: 1, at: NOW, matches: [{ id: 'm42', status: 'active', days: 15, createdAt: NOW - H, mySeat: 0, players: [{ seat: 0, state: 'playing', doneAt: null }], result: null }] }));
      if (screen === 'menu-needs') fake.expireSessions();
      cloud.profiles.setLast(mia);
      if (screen === 'menu-needs') await cloud.profiles.refresh().catch(() => false);
      void menu(cloud);
      break;
    }
    case 'picker':
    case 'manage': {
      const ids = await signedIn(cloud, 8);
      ids.forEach((id, i) => {
        if (i % 3 !== 2) cloud.local.write(slotKey(id, 'main'), zoo(`z${i}`, 4 + i * 3), meta(4 + i * 3, { rating: 20 + i * 10 }));
      });
      if (screen === 'manage') {
        await cloud.profiles.remove(ids[6]);
        await cloud.profiles.remove(ids[7]);
        await cloud.profiles.create('Kai', av('hippo', 2));
        await cloud.profiles.create('Lou', av('gorilla', 3));
      }
      localStorage.setItem(KEYS.guestMain, zoo('guest', 9));
      cloud.profiles.setGuestAsked();
      cloud.profiles.setLast(ids[1]);
      void menu(cloud);
      if (screen === 'manage') {
        await settle(700);
        (document.querySelector('.wh-ac-picker .wh-ac-headbtn[aria-label="Manage players"]') as HTMLElement | null)?.click();
        if (params.has('removed')) {
          await settle(300);
          document.querySelector('.wh-ac-manage .wh-ac-h3')?.scrollIntoView({ block: 'start' });
        }
      }
      break;
    }
    case 'setup': {
      await signedIn(cloud, 0);
      void menu(cloud);
      if (params.has('typed')) {
        await settle(500);
        const inp = document.querySelector('.wh-ac-name') as HTMLInputElement | null;
        if (inp) {
          inp.value = params.get('typed') ?? 'Mia';
          inp.dispatchEvent(new Event('input'));
        }
      }
      break;
    }
    case 'whosezoo': {
      localStorage.setItem(KEYS.guestMain, zoo('guest', 12));
      const ids = await signedIn(cloud, 3);
      cloud.local.write(slotKey(ids[1], 'main'), zoo('ben'), meta(20));
      void menu(cloud);
      break;
    }
    case 'signin': {
      localStorage.setItem(KEYS.guestMain, zoo('guest'));
      void menu(cloud);
      await settle(400);
      if (params.has('err')) fake.failNext('nonce', 'network');
      (document.querySelector('[data-chip="signin"]') as HTMLElement | null)?.click();
      if (params.has('err')) {
        await settle(300);
        (document.querySelector('.wh-ac-dialog .wh-btn-primary') as HTMLElement | null)?.click();
      }
      break;
    }
    case 'grownup': {
      localStorage.setItem(KEYS.guestMain, zoo('guest'));
      void menu(cloud);
      await settle(300);
      void askGrownup(uiEl, 'to remove Mia');
      if (params.has('wrong')) {
        await settle(200);
        for (const k of ['1', '2', '3']) (document.querySelector(`.wh-ac-keys .wh-btn[aria-label="${k}"]`) as HTMLElement | null)?.click();
        (document.querySelector('.wh-ac-keys .ok') as HTMLElement | null)?.click();
      }
      break;
    }
    case 'conflict':
    case 'leaselost':
    case 'leasenotice':
    case 'takeover':
    case 'notice': {
      await signedIn(cloud, 1);
      const loader = showLoadingScreen(uiEl);
      loader.setProgress(0.12, 'Opening Mia’s zoo…');
      const p = prompts();
      const here = card({ thisDevice: true, deviceName: 'Phone', meta: meta(12, { minute: 860, money: 48_210, rating: 55, animals: 18, playSeconds: 11_400 }), uniquePlaySeconds: 3_000, savedAt: NOW - 5 * 60_000 });
      const other = card({ thisDevice: false, deviceName: 'Tablet', meta: meta(15, { minute: 545, money: 51_900, rating: 78, animals: 21, playSeconds: 12_600 }), uniquePlaySeconds: 7_200, savedAt: NOW - 2 * H });
      if (screen === 'conflict') {
        const info: ConflictInfo = { profileName: 'Mia', here: { ...here, newest: false }, other: { ...other, newest: true } };
        void p.chooseConflict(info).then((s) => console.log('[harness] conflict', s));
      } else if (screen === 'leaselost' || screen === 'leasenotice') {
        const delta = screen === 'leaselost' ? 3600 : 90;
        const info: LeaseLostInfo = {
          profileName: 'Mia',
          here: { ...here, uniquePlaySeconds: delta, newest: true },
          other: { ...other, uniquePlaySeconds: 240, playingNow: true },
          localDeltaSeconds: delta,
          since: NOW - delta * 1000 - 6 * 60_000,
        };
        void p.chooseLeaseLost(info).then((s) => console.log('[harness] lease', s));
      } else if (screen === 'takeover') {
        void p.confirmTakeover({ profileName: 'Mia', holderDevice: 'Tablet', lastSeenAt: NOW - 60_000 }).then((s) => console.log('[harness] takeover', s));
      } else {
        p.toast('Got Mia’s newer zoo from Tablet');
        void p.notice('profileGone', { profileName: 'Mia' });
      }
      break;
    }
    case 'settings':
    case 'settings-guest':
    case 'backups':
    case 'badge': {
      let player: PlayerInfo = { ref: 'guest', profileId: null, accountId: null, name: null, avatar: null };
      if (screen !== 'settings-guest') {
        const ids = await signedIn(cloud, 3);
        const mia = ids[0];
        cloud.local.write(slotKey(mia, 'main'), zoo('mia'), meta(15));
        const add = (day: number, reason: 'chose_other' | 'lease_lost' | 'auto_pull', from: string) =>
          cloud.local.addBackup(mia, { gz: encodeSave(zoo(`bak${day}`, day)), meta: meta(day, { playSeconds: day * 400 }), savedAt: NOW - day * H, saveVersion: 1, reason, fromDevice: from, stash: false });
        add(9, 'chose_other', 'Tablet');
        add(11, 'lease_lost', 'Tablet');
        player = cloud.profiles.player(mia);
        await cloud.sync.syncNow().catch(() => undefined);
      }
      const g = game(cloud, player);
      await settle(400);
      if (screen === 'badge') {
        const key = slotKey(player.ref, 'main');
        g.fire('conflict', {
          key,
          info: { profileName: 'Mia', here: card({ uniquePlaySeconds: 3000 }), other: card({ thisDevice: false, deviceName: 'Tablet', uniquePlaySeconds: 7200, newest: true }) },
        });
      } else {
        g.ui.ext.openMenu('settings');
        await settle(300);
        const sect = document.querySelector('[data-wh-ac="settings"]') as HTMLElement | null;
        sect?.scrollIntoView({ block: 'start' });
        if (screen === 'backups') (document.querySelector('[data-wh-ac="settings"] .wh-btn[aria-label="Backups"]') as HTMLElement | null)?.click();
      }
      break;
    }
    default:
      document.body.insertAdjacentHTML('beforeend', `<p style="color:#fff">Unknown screen ${screen}</p>`);
  }
  await settle(900);
  (window as unknown as { __acReady: boolean }).__acReady = true;
}

/** Layout checks for the screenshot script. */
function check(): { outside: string[]; small: string[]; buttons: number } {
  const vw = innerWidth;
  const vh = innerHeight;
  const outside: string[] = [];
  const small: string[] = [];
  const name = (e: Element) => {
    const t = (e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
    return `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className || '').replace(/\s+/g, '.').slice(0, 60)}${t ? ` "${t}"` : ''}`;
  };
  const visible = (e: Element) => {
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const clipped = (e: Element): boolean => {
    for (let p = e.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowY + s.overflowX) && !p.classList.contains('wh-screen') && p !== document.body && p !== document.documentElement && !p.classList.contains('wh-ui')) return true;
    }
    return false;
  };
  // every element on the page (the decorative backdrops are oversized on purpose; the 3D canvas is the window)
  const decor = '.wh-menu-bg, .wh-load-bg, #game, #game *';
  for (const e of Array.from(document.body.querySelectorAll('*'))) {
    if (e.matches(decor) || e.closest('.wh-menu-bg, .wh-load-bg') || !visible(e)) continue;
    if (e.closest('svg') && e.tagName.toLowerCase() !== 'svg') continue;
    const r = e.getBoundingClientRect();
    if ((r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) && !clipped(e)) outside.push(`${name(e)} [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}]`);
  }
  // every button and field of the menu and the account UI (the game HUD belongs to the shell)
  const mine = document.querySelectorAll('.wh-menu button, .wh-ac-layer button, .wh-ac-page button, [data-wh-ac] button, .wh-ac-badge, .wh-ac-chip, .wh-ac-page input, .wh-ac-layer input');
  let buttons = 0;
  for (const e of Array.from(mine)) {
    if (!visible(e)) continue;
    buttons++;
    const r = e.getBoundingClientRect();
    if (r.height < 43.5) small.push(`${name(e)} h=${r.height.toFixed(1)}`);
  }
  return { outside, small, buttons };
}

run().catch((e) => {
  console.error('[harness] failed', e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:fixed;bottom:0;left:0;z-index:999">${String(e?.stack ?? e)}</pre>`);
  (window as unknown as { __acReady: boolean }).__acReady = true;
});
