// Full-screen loading screen and title menu, plus the Wildhaven emblem.
// Everything is drawn with inline SVG/CSS (no image assets).

import type { QualityLevel } from '../core/contracts';
import { button, el, setText, swallowPointer, toggleClass } from './dom';
import { icon } from './icons';
import { showDialog } from './panels';
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

export function showMainMenu(
  root: HTMLElement,
  opts: { hasSave: boolean; quality: QualityLevel; onQuality(q: QualityLevel): void },
): Promise<'continue' | 'new'> {
  ensureStyles();
  return new Promise((resolve) => {
    let quality = opts.quality;
    const levels: QualityLevel[] = ['low', 'medium', 'high'];
    const seg = el('div', 'wh-segtext');
    const qBtns = levels.map((q) =>
      button(q === quality ? 'on' : '', null, q[0].toUpperCase() + q.slice(1), () => {
        quality = q;
        qBtns.forEach((b, i) => toggleClass(b, 'on', levels[i] === q));
        opts.onQuality(q);
      }),
    );
    seg.append(...qBtns);
    let done = false;
    const finish = (choice: 'continue' | 'new') => {
      if (done) return;
      done = true;
      screen.classList.add('fade');
      window.setTimeout(() => screen.remove(), 700);
      resolve(choice);
    };
    const btns = el('div', 'wh-menu-btns');
    if (opts.hasSave) btns.append(button('wh-btn-primary', 'play1', 'Continue', () => finish('continue')));
    btns.append(
      button(opts.hasSave ? 'wh-btn-ghost' : 'wh-btn-primary', 'plus', 'New Zoo', async () => {
        if (opts.hasSave) {
          const ok = await showDialog(screen, {
            title: 'Start a new zoo?',
            text: 'Your saved zoo will be replaced the next time the game saves.',
            ok: 'New zoo',
            danger: true,
          });
          if (!ok) return;
        }
        finish('new');
      }),
    );
    const card = el('div', 'wh-menu-card wh-glass-2', [
      el('div', 'wh-menu-brand', [
        el('div', { html: logoSvg() }),
        el('h1', { class: 'wh-title', html: 'Wildhaven <em>Zoo</em>' }),
        el('div', { class: 'wh-tagline', text: 'Build · Care · Explore' }),
      ]),
      el('div', 'wh-menu-actions', [btns, el('div', 'wh-menu-q', [el('span', { text: 'Graphics' }), seg]), el('div', { class: 'wh-menu-foot', text: 'An original zoo-building game' })]),
    ]);
    const screen = el('div', 'wh-screen wh-menu', [el('div', { html: savannaBackdrop() }), el('div', 'wh-menu-shade'), card]);
    swallowPointer(screen);
    root.append(screen);
    const onKey = (e: KeyboardEvent) => {
      if (done) {
        window.removeEventListener('keydown', onKey);
        return;
      }
      if (e.code === 'Enter' && !screen.querySelector('.wh-dialog')) {
        window.removeEventListener('keydown', onKey);
        finish(opts.hasSave ? 'continue' : 'new');
      }
    };
    window.addEventListener('keydown', onKey);
  });
}
