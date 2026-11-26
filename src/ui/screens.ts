// Full-screen loading screen and title menu, plus the Wildhaven emblem.
// Everything is drawn with inline SVG/CSS (no image assets).
//
// The title menu (spec §7.1): a landscape card (brand left, actions right) with the player chip
// top-right in cloud builds. What the buttons say and return comes from the pure menuModel
// (src/ui/account/menuModel.ts); the sign-in sheet, "Who's playing?", first-player setup and
// "Whose zoo is this?" are pages from src/ui/account.

import type { CloudHandle, SyncPrompts } from '../core/cloud-types';
import type { MenuResult, PlayerInfo, PlayerRef, QualityLevel } from '../core/contracts';
import { readActiveSlot, type KV, type TutorialProfileState } from '../core/player-state';
import { GUEST, KEYS, matchIdOf, slotKey } from '../core/storage-keys';
import { versusNeedsAttention } from '../versus/record';
import { avatarEl, closeTopModal, closeTopPage, confirmBox, modalOpen } from './account/dialog';
import { activeMatchFrom, cloudModeOf, menuModel, needsFirstPlayer, openPickerFirst, startPlayer, type MenuButton, type MenuInput, type MenuModel } from './account/menuModel';
import { showPicker } from './account/picker';
import { PICKER_FLAG_KEY } from './account/settings';
import { addPlayer } from './account/setup';
import { signInSheet } from './account/signin';
import { ensureAccountStyles } from './account/styles';
import { whoseZooFlow } from './account/whosezoo';
import { button, el, setText, swallowPointer, toggleClass } from './dom';
import { icon } from './icons';
import { ensureStyles } from './styles';

let uid = 0;

/** The Wildhaven emblem: an acacia and a giraffe against a low savanna sun. */
export function logoSvg(cls = 'wh-logo'): string {
  const id = `whl${uid++}`;
  return `<svg class="${cls}" viewBox="0 0 120 120" aria-hidden="true">
  <defs>
    <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a4c45"/><stop offset=".5" stop-color="#8e9a63"/><stop offset=".78" stop-color="#e8c47e"/><stop offset="1" stop-color="#f4dca0"/>
    </linearGradient>
    <radialGradient id="${id}g" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff1c6" stop-opacity=".95"/><stop offset=".45" stop-color="#f7dc98" stop-opacity=".6"/><stop offset="1" stop-color="#f7dc98" stop-opacity="0"/></radialGradient>
    <clipPath id="${id}c"><circle cx="60" cy="60" r="50"/></clipPath>
  </defs>
  <circle cx="60" cy="60" r="56.5" fill="#0f1a13" fill-opacity=".55" stroke="#e4d0a0" stroke-width="2"/>
  <g clip-path="url(#${id}c)">
    <rect width="120" height="120" fill="url(#${id}s)"/>
    <circle cx="82" cy="72" r="24" fill="url(#${id}g)"/>
    <circle cx="82" cy="72" r="10.5" fill="#fbe9b8"/>
    <path d="M0 86 C22 78 40 79 62 83 C82 86 100 80 120 78 V120 H0Z" fill="#3c5330"/>
    <path d="M0 95 C30 88 58 92 80 95 C96 97 108 94 120 92 V120 H0Z" fill="#1c2c1c"/>
    <g fill="#16241a" stroke="#16241a" stroke-linecap="round">
      <path d="M39.5 92 C40.2 84 41 78 42.6 71.5" stroke-width="2.4" fill="none"/>
      <path d="M42.6 71.5 C40.5 67.5 36.5 65.4 31 64.6 M42.6 71.5 C45.5 67.4 50.5 65.6 56.5 65" stroke-width="1.6" fill="none"/>
      <path d="M20.5 63.4 C25 57.6 34 55.6 42 56.4 C50.5 55.4 60.5 57.2 65.5 62.4 C57 65.6 29.5 66.4 20.5 63.4Z" stroke="none"/>
      <ellipse cx="86" cy="80" rx="7.4" ry="3.7" stroke="none"/>
      <path d="M90.6 79 L96.8 61.2 L99.4 62 L94 80.4Z" stroke="none"/>
      <ellipse cx="99.4" cy="60.6" rx="3.3" ry="1.7" transform="rotate(18 99.4 60.6)" stroke="none"/>
      <path d="M97.6 59.6 L97 57.4 M99.4 59.4 L99.2 57.2" stroke-width=".9" fill="none"/>
      <path d="M80.8 81.5 L80 93 M83.4 82 L83.4 93 M89.2 82 L89.4 93 M91.6 81.4 L92.6 93" stroke-width="1.35" fill="none"/>
      <path d="M78.8 79 L77.2 85" stroke-width=".8" fill="none"/>
    </g>
  </g>
  <circle cx="60" cy="60" r="50" fill="none" stroke="#e4d0a0" stroke-opacity=".35" stroke-width=".8"/>
</svg>`;
}

function contourBackdrop(): string {
  const lines: string[] = [];
  for (let i = 0; i < 14; i++) {
    const y0 = 40 + i * 62;
    let d = `M-20 ${y0}`;
    for (let x = 0; x <= 1640; x += 80) {
      const y = y0 + Math.sin(x * 0.004 + i * 0.9) * 26 + Math.sin(x * 0.011 + i * 2.1) * 9;
      d += ` L${x} ${y.toFixed(1)}`;
    }
    lines.push(`<path d="${d}" fill="none" stroke="rgba(151,196,108,${(0.05 + (i % 3) * 0.02).toFixed(2)})" stroke-width="1.2"/>`);
  }
  return `<svg class="wh-load-bg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${lines.join('')}</svg>`;
}

const TIPS = [
  'Guests only walk on paths — connect every habitat to the entrance.',
  'While building, one finger uses the tool and two fingers move the camera.',
  'Every species has favourite terrain. Paint the ground to match before adopting.',
  'Shallow water lets animals drink and bathe; deep water is for swimmers.',
  'Keepers feed the animals and clean habitats — hire one for every few enclosures.',
  'Benches, bins and restrooms keep guests happy and the paths tidy.',
  'Glass viewing walls give guests a perfect view of the animals.',
  'Tap a habitat to see how well it suits each species living there.',
  'Powerful animals need strong fences — check the fence rating before adopting.',
  'Raise the admission price as your zoo’s rating grows.',
];

// ---------------------------------------------------------------------------

export function showLoadingScreen(root: HTMLElement): { setProgress(fraction: number, label: string): void; hide(): void } {
  ensureStyles();
  const fill = el('div', 'wh-bar-fill');
  const label = el('span');
  const pct = el('span', 'wh-load-pct', ['0%']);
  const tipText = el('span');
  const tip = el('div', 'wh-tip', [el('span', { html: icon('leaf') }), tipText]);
  const screen = el('div', 'wh-screen wh-load', [
    el('div', { html: contourBackdrop() }),
    el('div', 'wh-load-col', [
      el('div', { html: logoSvg() }),
      el('h1', { class: 'wh-title', html: 'Wildhaven <em>Zoo</em>' }),
      el('div', { class: 'wh-tagline', text: 'Build · Care · Explore' }),
      el('div', 'wh-bar', [fill]),
      el('div', 'wh-load-row', [label, pct]),
    ]),
    tip,
  ]);
  swallowPointer(screen);
  root.append(screen);
  let tipIdx = Math.floor(Math.random() * TIPS.length);
  tipText.textContent = TIPS[tipIdx];
  const tipTimer = window.setInterval(() => {
    tip.classList.add('fade');
    window.setTimeout(() => {
      tipIdx = (tipIdx + 1) % TIPS.length;
      tipText.textContent = TIPS[tipIdx];
      tip.classList.remove('fade');
    }, 500);
  }, 4800);
  let shown = 0;
  return {
    setProgress(fraction: number, text: string) {
      const f = Math.max(shown, Math.min(1, Math.max(0, fraction)));
      shown = f;
      fill.style.transform = `scaleX(${f.toFixed(3)})`;
      setText(label, text);
      setText(pct, `${Math.round(f * 100)}%`);
    },
    hide() {
      window.clearInterval(tipTimer);
      screen.classList.add('fade');
      window.setTimeout(() => screen.remove(), 650);
    },
  };
}

// ---------------------------------------------------------------------------

function savannaBackdrop(): string {
  const acacia = (x: number, y: number, s: number, o = 1) =>
    `<g transform="translate(${x} ${y}) scale(${s})" opacity="${o}"><path d="M-2 0 C-1 -18 0 -30 3 -44 M3 -44 C-2 -52 -12 -56 -24 -58 M3 -44 C9 -52 20 -56 32 -57" stroke="currentColor" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M-48 -58 C-38 -72 -14 -77 4 -75 C24 -78 46 -73 56 -61 C36 -54 -26 -52 -48 -58Z" fill="currentColor"/></g>`;
  const giraffe = (x: number, y: number, s: number) =>
    `<g transform="translate(${x} ${y}) scale(${s})" fill="currentColor" stroke="currentColor" stroke-linecap="round"><ellipse cx="0" cy="-30" rx="15" ry="7.5" stroke="none"/><path d="M9 -32 L22 -70 L28 -68 L17 -28Z" stroke="none"/><ellipse cx="28" cy="-71" rx="7" ry="3.4" transform="rotate(18 28 -71)" stroke="none"/><path d="M-10 -26 L-12 0 M-5 -25 L-5 0 M7 -25 L7 0 M12 -26 L14 0" stroke-width="2.8" fill="none"/><path d="M-14 -32 L-18 -18" stroke-width="1.4" fill="none"/></g>`;
  const elephant = (x: number, y: number, s: number) =>
    `<g transform="translate(${x} ${y}) scale(${s})" fill="currentColor"><path d="M-30 -8 C-34 -30 -22 -46 0 -46 C18 -46 30 -38 34 -26 C40 -30 46 -24 44 -12 C42 -2 40 8 44 16 L38 16 C34 8 34 -2 34 -8 L30 -8 L30 0 L22 0 L22 -10 C10 -8 -6 -8 -16 -10 L-16 0 L-24 0 L-24 -8 C-26 -6 -28 -4 -30 -8Z"/><path d="M14 -40 C22 -38 26 -30 24 -22 C18 -24 14 -30 14 -40Z" fill-opacity=".55"/></g>`;
  return `<svg class="wh-menu-bg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
  <defs>
    <linearGradient id="whm-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f6272"/><stop offset=".45" stop-color="#9fb8b6"/><stop offset=".68" stop-color="#e8cf98"/><stop offset=".8" stop-color="#f3d7a0"/></linearGradient>
    <radialGradient id="whm-sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff4d2"/><stop offset=".25" stop-color="#ffe6ae" stop-opacity=".85"/><stop offset="1" stop-color="#ffe0a0" stop-opacity="0"/></radialGradient>
    <linearGradient id="whm-plain" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b39a5c"/><stop offset="1" stop-color="#6d6234"/></linearGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#whm-sky)"/>
  <circle cx="900" cy="560" r="280" fill="url(#whm-sun)"/>
  <circle cx="900" cy="560" r="60" fill="#fff0c8"/>
  <path d="M0 590 C160 548 260 562 380 540 C520 514 620 556 760 548 C900 540 1010 520 1160 548 C1300 572 1440 540 1600 556 V900 H0Z" fill="#8d9f94" opacity=".75"/>
  <path d="M0 640 C200 610 380 628 560 614 C760 598 920 630 1120 620 C1300 610 1460 622 1600 612 V900 H0Z" fill="url(#whm-plain)"/>
  <g color="#5c5a3c" opacity=".7">${acacia(240, 628, 0.8)}${acacia(1400, 624, 0.65)}${acacia(700, 612, 0.5)}${acacia(1150, 618, 0.42)}</g>
  <g color="#2e3322">${giraffe(960, 662, 1.55)}${giraffe(1040, 670, 1.25)}${elephant(560, 690, 1.6)}${giraffe(1330, 660, 0.9)}</g>
  <path d="M0 720 C240 690 420 708 640 700 C900 690 1120 716 1340 704 C1460 698 1540 702 1600 700 V900 H0Z" fill="#4b4a2c"/>
  <g color="#1e2416">${acacia(1460, 780, 2.2)}${acacia(120, 800, 1.7)}</g>
  <path d="M0 800 C300 780 600 800 900 790 C1200 780 1400 796 1600 786 V900 H0Z" fill="#2a2c1c"/>
</svg>`;
}

export interface MainMenuOptions {
  cloud: CloudHandle;
  prompts: SyncPrompts;
  quality: QualityLevel;
  onQuality(q: QualityLevel): void;
  /** The player to start with (BootIntent.player, e.g. back from a match); skips "Who's playing?". */
  preselect?: PlayerRef;
  /** The Versus hub (signed-in profiles only); resolves with what to boot, or null for Back. */
  openVersus?(root: HTMLElement, player: PlayerInfo): Promise<MenuResult | null>;
  tutorialState(p: PlayerRef): TutorialProfileState;
  /** Storage for the active slot and versus records (default: localStorage). */
  storage?: KV;
}

/** The pre-round-14 options (no cloud): Continue / New Zoo only. */
export interface LegacyMenuOptions {
  hasSave: boolean;
  quality: QualityLevel;
  onQuality(q: QualityLevel): void;
}

function defaultStorage(): KV {
  try {
    return localStorage;
  } catch {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
  }
}

function consumePickerFlag(): boolean {
  try {
    const v = sessionStorage.getItem(PICKER_FLAG_KEY);
    if (v !== null) sessionStorage.removeItem(PICKER_FLAG_KEY);
    return v === '1';
  } catch {
    return false;
  }
}

/** Everything menuModel needs, read from the cloud handle and local storage. */
export function menuInputOf(cloud: CloudHandle, player: PlayerRef, store: KV): MenuInput {
  const mode = cloudModeOf(cloud.auth.state.get());
  const signed = mode === 'signed-in' || mode === 'needs-signin';
  const p = signed && player !== GUEST ? (cloud.profiles.list().find((x) => x.id === player) ?? null) : null;
  const ref = p ? p.id : GUEST;
  const activeSlot = readActiveSlot(store, ref);
  let activeMatch: { matchId: string } | null = null;
  let versusDot = false;
  if (p) {
    const mid = matchIdOf(activeSlot);
    try {
      activeMatch = mid ? activeMatchFrom(store.getItem(KEYS.vs(p.id, mid)), mid) : null;
    } catch {
      activeMatch = null;
    }
    try {
      versusDot = versusNeedsAttention(store, p.id);
    } catch {
      versusDot = false;
    }
  }
  return {
    cloud: mode,
    player: ref,
    name: p?.name ?? null,
    avatar: p?.avatar ?? null,
    hasZoo: cloud.local.has(slotKey(ref, 'main')) || !!p?.main,
    activeSlot,
    hasPractice: cloud.local.has(slotKey(ref, 'practice')),
    activeMatch,
    versusDot,
  };
}

/** Android back for the title menu's pages and dialogs (main.ts may call it before the game UI exists). */
export function menuHandleBack(): boolean {
  return closeTopModal() || closeTopPage();
}

interface MenuView {
  screen: HTMLElement;
  card: HTMLElement;
  btns: HTMLElement;
  q: HTMLElement;
  foot: HTMLElement;
  chipSlot: HTMLElement;
  seg: HTMLElement;
}

function buildMenu(root: HTMLElement, quality: QualityLevel, onQuality: (q: QualityLevel) => void): MenuView {
  let current = quality;
  const levels: QualityLevel[] = ['low', 'medium', 'high'];
  const seg = el('div', { class: 'wh-segtext', attrs: { role: 'radiogroup', 'aria-label': 'Graphics' } });
  const qBtns = levels.map((q) =>
    button(q === current ? 'on' : '', null, q[0].toUpperCase() + q.slice(1), () => {
      current = q;
      qBtns.forEach((b, i) => toggleClass(b, 'on', levels[i] === q));
      onQuality(q);
    }, `Graphics: ${q}`),
  );
  seg.append(...qBtns);
  const btns = el('div', 'wh-menu-btns');
  const q = el('div', 'wh-menu-q wh-ac-q');
  const foot = el('div', { class: 'wh-menu-foot', text: 'An original zoo-building game' });
  const card = el('div', 'wh-menu-card wh-glass-2', [
    el('div', 'wh-menu-brand', [
      el('div', { html: logoSvg() }),
      el('h1', { class: 'wh-title', html: 'Wildhaven <em>Zoo</em>' }),
      el('div', { class: 'wh-tagline', text: 'Build · Care · Explore' }),
    ]),
    el('div', 'wh-menu-actions', [btns, q, foot]),
  ]);
  const chipSlot = el('div', { class: 'wh-ac-chipslot' });
  const screen = el('div', 'wh-screen wh-menu', [el('div', { html: savannaBackdrop() }), el('div', 'wh-menu-shade'), card, chipSlot]);
  swallowPointer(screen);
  root.append(screen);
  return { screen, card, btns, q, foot, chipSlot, seg };
}

function menuButton(b: MenuButton, cls: string, onClick: () => void): HTMLButtonElement {
  const ico = b.id === 'versus' ? 'swords' : b.id === 'new' ? 'plus' : b.id === 'learn' ? 'info' : b.id === 'backToMain' || b.id === 'myZoo' ? 'home' : 'play1';
  const el2 = button(`${b.style === 'primary' ? 'wh-btn-primary' : 'wh-btn-ghost'} ${cls}`, ico, b.label, onClick);
  el2.dataset.menu = b.id;
  if (b.dot) el2.append(el('span', { class: 'wh-ac-dot', attrs: { 'aria-label': 'Something new' } }));
  return el2;
}

/** Draw the menu rows for a model; `act` runs a button. */
function drawRows(v: MenuView, m: MenuModel, act: (b: MenuButton) => void, opts: { learn: boolean; signinAgain?: () => void }): void {
  const primary = menuButton(m.primary, 'wh-ac-primary', () => act(m.primary));
  const rows: HTMLElement[] = [primary];
  if (m.row2.length) rows.push(el('div', 'wh-menu-row2', m.row2.map((b) => menuButton(b, '', () => act(b)))));
  v.btns.replaceChildren(...rows);
  const learn = opts.learn ? el('button', { class: 'wh-btn wh-ac-learn', attrs: { type: 'button', 'data-menu': 'learn' }, onClick: () => act(m.learn) }, [el('span', { class: 'wh-btn-label', text: m.learn.label })]) : el('span');
  v.q.replaceChildren(learn, el('div', 'wh-ac-gfx', [el('span', { text: 'Graphics' }), v.seg]));
  if (m.signinAgain && opts.signinAgain) {
    const again = el('button', { class: 'wh-btn wh-ac-foot-btn', attrs: { type: 'button', 'data-menu': 'signinAgain' }, onClick: () => opts.signinAgain?.() }, [
      el('span', { html: icon('cloudOff') }),
      el('span', { class: 'wh-btn-label', text: 'Sign in again to keep your zoos safe online' }),
    ]);
    v.foot.replaceChildren(again);
    v.foot.className = '';
  } else {
    v.foot.className = 'wh-menu-foot';
    v.foot.textContent = 'An original zoo-building game';
  }
}

function drawChip(v: MenuView, m: MenuModel, onTap: () => void): void {
  const c = m.chip;
  toggleClass(v.screen, 'wh-ac-has-chip', !!c);
  if (!c) {
    v.chipSlot.replaceChildren();
    return;
  }
  let chip: HTMLElement;
  if (c.kind === 'signin') {
    chip = el('button', { class: 'wh-btn wh-glass-2 wh-ac-chip signin', attrs: { type: 'button', 'data-chip': 'signin', 'aria-label': 'Sign in' }, onClick: onTap }, [
      el('span', { html: icon('cloud') }),
      el('span', { class: 'wh-ac-chip-name', text: c.label }),
    ]);
  } else {
    const name = c.kind === 'player' ? c.name : c.label;
    chip = el('button', { class: 'wh-btn wh-glass-2 wh-ac-chip', attrs: { type: 'button', 'data-chip': c.kind, 'aria-label': `Playing as ${name}. Change player` }, onClick: onTap }, [
      avatarEl(c.kind === 'player' ? c.avatar : null, 36),
      el('span', { class: 'wh-ac-chip-name', text: name }),
      c.kind === 'player' && c.needsSignin ? el('span', { class: 'wh-ac-chip-warn', html: icon('cloudOff') }) : null,
      el('span', { html: icon('chevronDown') }),
    ]);
  }
  v.chipSlot.replaceChildren(chip);
}

/** The title menu; resolves with what to boot. */
export function showMainMenu(root: HTMLElement, opts: MainMenuOptions): Promise<MenuResult>;
/** @deprecated pre-round-14 call (no cloud): resolves 'continue' or 'new'. */
export function showMainMenu(root: HTMLElement, opts: LegacyMenuOptions): Promise<'continue' | 'new'>;
export function showMainMenu(root: HTMLElement, opts: MainMenuOptions | LegacyMenuOptions): Promise<MenuResult | 'continue' | 'new'> {
  ensureStyles();
  ensureAccountStyles();
  if (!('cloud' in opts)) return legacyMenu(root, opts);
  const { cloud } = opts;
  const store = opts.storage ?? defaultStorage();
  return new Promise((resolve) => {
    const v = buildMenu(root, opts.quality, opts.onQuality);
    let current: PlayerRef = GUEST;
    let ready = false;
    let busy = false;
    let done = false;
    let model: MenuModel | null = null;

    const finish = (r: MenuResult) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey);
      v.screen.classList.add('fade');
      window.setTimeout(() => v.screen.remove(), 700);
      resolve(r);
    };
    const withBusy = async <T>(fn: () => Promise<T>): Promise<T> => {
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
      }
    };
    const signedIn = () => {
      const k = cloud.auth.state.get().kind;
      return k === 'signed-in' || k === 'needs-signin';
    };
    const render = () => {
      if (done || !ready) return;
      // the current player may have gone (removed on another device, signed out)
      if (current !== GUEST && !(signedIn() && cloud.profiles.list().some((p) => p.id === current))) {
        current = startPlayer({ mode: cloudModeOf(cloud.auth.state.get()), profiles: cloud.profiles.list(), last: cloud.profiles.last() });
      }
      model = menuModel(menuInputOf(cloud, current, store));
      drawRows(v, model, (b) => void act(b), { learn: true, signinAgain: () => void signInAgain() });
      drawChip(v, model, () => void chipTap());
    };
    const signInAgain = () =>
      withBusy(async () => {
        await signInSheet(root, cloud, { text: 'Sign in again with the same Google account to keep your zoos safe online.' });
        render();
      });
    const newPlayer = async (first: boolean) => (await addPlayer(v.screen, cloud, { first }))?.id ?? null;
    /** After a sign-in (or at start when signed in): first player, whose zoo, who's playing. */
    const playersFlow = async (o: { preselect?: PlayerRef; forced: boolean }): Promise<PlayerRef> => {
      const mode = cloudModeOf(cloud.auth.state.get());
      if (mode === 'disabled' || mode === 'guest') return GUEST;
      let first: string | null = null;
      if (needsFirstPlayer(mode, cloud.profiles.list().length)) first = await newPlayer(true);
      const adopted = await whoseZooFlow(v.screen, cloud, () => newPlayer(false));
      if (adopted) return adopted;
      if (first) return first;
      const list = cloud.profiles.list();
      if (openPickerFirst({ mode, profiles: list.length, preselect: o.preselect, forced: o.forced })) {
        const r = await showPicker({ cloud, container: v.screen, dialogRoot: root, highlight: cloud.profiles.last(), closable: false, signInAgain: () => signInAgain() });
        if (r) return r;
      }
      return startPlayer({ mode, profiles: list, preselect: o.preselect, last: cloud.profiles.last() });
    };
    const chipTap = () =>
      withBusy(async () => {
        if (!model?.chip) return;
        if (model.chip.kind === 'signin') {
          const out = await signInSheet(root, cloud);
          if (out?.kind === 'ok') current = await playersFlow({ forced: false });
        } else {
          const r = await showPicker({ cloud, container: v.screen, dialogRoot: root, highlight: current, closable: true, signInAgain: () => signInAgain() });
          if (r) current = r;
        }
        render();
      });
    const act = (b: MenuButton) =>
      withBusy(async () => {
        if (b.action.kind === 'versus') {
          if (!opts.openVersus) return;
          const r = await opts.openVersus(root, cloud.profiles.player(current));
          if (r) finish(r);
          else render();
          return;
        }
        const a = b.action;
        if (a.confirm && !(await confirmBox(root, { title: a.confirm.title, text: a.confirm.text, ok: a.confirm.ok, danger: true }))) return;
        finish(a.result);
      });
    const onKey = (e: KeyboardEvent) => {
      if (done || busy || !model || modalOpen() || v.screen.querySelector('.wh-ac-page')) return;
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        void act(model.primary);
      }
    };
    window.addEventListener('keydown', onKey);

    void (async () => {
      const mode = cloudModeOf(cloud.auth.state.get());
      if (mode === 'signed-in') {
        // fresh names, removed players and summaries; also pushes dirty zoos and stashes (spec §3.10)
        void cloud.profiles
          .refresh()
          .then(() => render())
          .catch(() => undefined);
      }
      try {
        current = await withBusy(() => playersFlow({ preselect: opts.preselect, forced: consumePickerFlag() }));
      } catch (e) {
        console.warn('[menu] players', e);
        current = GUEST;
      }
      ready = true;
      render();
    })();
  });
}

/** The old two-button menu for callers without a cloud handle. */
function legacyMenu(root: HTMLElement, opts: LegacyMenuOptions): Promise<'continue' | 'new'> {
  return new Promise((resolve) => {
    const v = buildMenu(root, opts.quality, opts.onQuality);
    let done = false;
    const m = menuModel({ cloud: 'disabled', player: GUEST, name: null, avatar: null, hasZoo: opts.hasSave, activeSlot: 'main', hasPractice: false, activeMatch: null });
    const finish = (r: 'continue' | 'new') => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey);
      v.screen.classList.add('fade');
      window.setTimeout(() => v.screen.remove(), 700);
      resolve(r);
    };
    const act = async (b: MenuButton) => {
      if (b.action.kind !== 'result') return;
      const a = b.action;
      if (a.confirm && !(await confirmBox(root, { title: a.confirm.title, text: a.confirm.text, ok: a.confirm.ok, danger: true }))) return;
      finish(a.result.kind === 'continue' ? 'continue' : 'new');
    };
    drawRows(v, m, (b) => void act(b), { learn: false });
    drawChip(v, m, () => {});
    const onKey = (e: KeyboardEvent) => {
      if (done || modalOpen()) return;
      if (e.code === 'Enter') void act(m.primary);
    };
    window.addEventListener('keydown', onKey);
  });
}
