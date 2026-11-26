// Player avatars: ten animal heads in the game's emblem style (a cream silhouette with dark
// details on a coloured disc), drawn as inline SVG so they stay crisp at any size and need
// no image files. Used by the player picker, the player chip and the versus screens.

import type { Avatar, AvatarAnimal } from '../../shared/api-types';

/** Disc colours, indexed by `Avatar.color` (0..7): saturated mid tones the cream heads stand out on. */
export const AVATAR_COLOR_HEX: readonly string[] = ['#c8553d', '#d4801f', '#5d9b3f', '#23897f', '#3474b8', '#6b56b8', '#b8487f', '#566b78'];

/** Names for screen readers and tooltips. */
export const AVATAR_NAMES: Readonly<Record<AvatarAnimal, string>> = {
  lion: 'Lion',
  giraffe: 'Giraffe',
  elephant: 'Elephant',
  zebra: 'Zebra',
  penguin: 'Penguin',
  hippo: 'Hippo',
  tiger: 'Tiger',
  bear: 'Bear',
  gorilla: 'Gorilla',
  flamingo: 'Flamingo',
};

// palette of the heads (the same on every disc)
const F = '#fbf1d9'; // cream face
const S = '#e2c18c'; // tan: muzzles, inner ears, manes, spots
const I = '#2b2216'; // ink: eyes, noses, stripes
const BR = '#c08552'; // bear brown
const TG = '#f3a548'; // tiger orange

const circle = (cx: number, cy: number, r: number, fill: string) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
const ell = (cx: number, cy: number, rx: number, ry: number, fill: string, rot = 0) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"${rot ? ` transform="rotate(${rot} ${cx} ${cy})"` : ''}/>`;
const path = (d: string, fill: string) => `<path d="${d}" fill="${fill}"/>`;
const line = (d: string, color: string, w: number) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

/** A ring of rounded bumps (the lion's mane): `n` bumps between radius r0 and r1 around (cx, cy). */
function scallop(cx: number, cy: number, r0: number, r1: number, n: number): string {
  const pt = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  let d = `M${pt(r0, 0)}`;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    d += `Q${pt(r1 * 1.12, am)} ${pt(r0, a1)}`;
  }
  return `${d}Z`;
}

const HEADS: Record<AvatarAnimal, string> = {
  lion:
    path(scallop(50, 53, 30, 38, 13), S) +
    circle(32, 33, 7.5, F) +
    circle(68, 33, 7.5, F) +
    circle(32, 33, 3.6, S) +
    circle(68, 33, 3.6, S) +
    circle(50, 56, 21, F) +
    ell(50, 65, 9.5, 6.5, S) +
    circle(42, 51, 2.8, I) +
    circle(58, 51, 2.8, I) +
    path('M44.5 59.5h11l-5.5 6z', I) +
    line('M50 65.5v3.2M50 68.7c-2 2.6-5.6 2.6-7.4.4M50 68.7c2 2.6 5.6 2.6 7.4.4', I, 2),
  tiger:
    line('M25 41L27 19l17 11zM75 41L73 19 56 30z', TG, 5) +
    path('M25 41L27 19l17 11zM75 41L73 19 56 30z', TG) +
    path('M29 33l1-8 7 5zM71 33l-1-8-7 5z', I) +
    ell(50, 56, 29, 25, TG) +
    ell(36, 60, 11, 9, F) +
    ell(64, 60, 11, 9, F) +
    path('M50 31.5l-3.4 9.5h6.8zM40.5 33.5l1.8 8.6 3.6-1.6zM59.5 33.5l-1.8 8.6-3.6-1.6z', I) +
    path('M21.4 51l11.6 2.8-11.4 2.6zM22.6 60.6l10 .8-8.8 4.2zM78.6 51L67 53.8l11.4 2.6zM77.4 60.6l-10 .8 8.8 4.2z', I) +
    ell(44, 65.5, 7.5, 5.5, F) +
    ell(56, 65.5, 7.5, 5.5, F) +
    ell(40, 50, 3.4, 2.5, I, 12) +
    ell(60, 50, 3.4, 2.5, I, -12) +
    path('M45 58.5h10l-5 5.5z', I) +
    line('M50 64v3', I, 2),
  bear:
    circle(28, 31, 10.5, BR) +
    circle(72, 31, 10.5, BR) +
    circle(28, 31, 5.2, '#8f5c34') +
    circle(72, 31, 5.2, '#8f5c34') +
    circle(50, 55, 28, BR) +
    ell(50, 66, 13, 10, F) +
    ell(50, 61.5, 5.8, 4.2, I) +
    circle(40, 50, 3, I) +
    circle(60, 50, 3, I) +
    line('M50 65.5v3.8M50 69.3c-2 2.2-4.8 2.2-6.4.2M50 69.3c2 2.2 4.8 2.2 6.4.2', I, 2),
  gorilla:
    path('M50 17c15 0 25 10 26 24 6 2 9 8 7 14-2 5-6 7-9 7-2 12-12 21-24 21S28 74 26 62c-3 0-7-2-9-7-2-6 1-12 7-14C25 27 35 17 50 17z', '#4d4741') +
    path('M50 37c9 0 16 3.5 17 10.5.6 4.5-1.4 8-1.4 12 0 9.5-7 16.5-15.6 16.5S34.4 69 34.4 59.5c0-4-2-7.5-1.4-12C34 40.5 41 37 50 37z', S) +
    line('M32.5 45.5c5.5-5 12-5 17.5-2 5.5-3 12-3 17.5 2', '#4d4741', 5) +
    circle(42, 49.5, 2.5, I) +
    circle(58, 49.5, 2.5, I) +
    line('M44.5 56.5c2.5-2.4 8.5-2.4 11 0', I, 2) +
    ell(46, 59.5, 2.7, 2, I) +
    ell(54, 59.5, 2.7, 2, I) +
    line('M42.5 67.5c5 2.6 10 2.6 15 0', I, 2),
  hippo:
    ell(31, 27, 5, 7, '#d9cde0', -22) +
    ell(69, 27, 5, 7, '#d9cde0', 22) +
    ell(31, 27, 2.4, 3.8, '#b8a6c4', -22) +
    ell(69, 27, 2.4, 3.8, '#b8a6c4', 22) +
    ell(50, 41, 21, 16, '#d9cde0') +
    circle(38, 30, 7, '#d9cde0') +
    circle(62, 30, 7, '#d9cde0') +
    circle(38, 30, 2.8, I) +
    circle(62, 30, 2.8, I) +
    ell(50, 64, 31, 21, '#d9cde0') +
    ell(39, 57, 3.6, 2.6, I, -20) +
    ell(61, 57, 3.6, 2.6, I, 20) +
    line('M27 70c11 6.5 35 6.5 46 0', I, 2.2) +
    path('M37.5 72.6l1.6 5.2 2.4-4.4zM62.5 72.6l-1.6 5.2-2.4-4.4z', F),
  elephant:
    path('M36 33c-13-9-29-2-29 15 0 13 9 23 20 23 7 0 11-4 13-9z', '#bcc4cc') +
    path('M64 33c13-9 29-2 29 15 0 13-9 23-20 23-7 0-11-4-13-9z', '#bcc4cc') +
    path('M31 41c-6-3-13 1-13 9 0 7 5 12 10 12z', '#a9b2bb') +
    path('M69 41c6-3 13 1 13 9 0 7-5 12-10 12z', '#a9b2bb') +
    ell(50, 42, 20, 21, '#d7dce1') +
    line('M50 52c0 12 0 20-3 26-2 4-6 5-8.5 3', '#d7dce1', 11) +
    line('M42 57c-1 5-3 8-6.5 9.5M58 57c1 5 3 8 6.5 9.5', F, 3.6) +
    circle(41.5, 42, 2.7, I) +
    circle(58.5, 42, 2.7, I) +
    line('M46 70.5h-2.5M46 76h-2', '#a9b2bb', 1.6),
  zebra:
    line('M33 31L30 11l13 11zM67 31L70 11 57 22z', F, 4) +
    path('M33 31L30 11l13 11zM67 31L70 11 57 22z', F) +
    path('M33.5 25l-1.4-8 6 5zM66.5 25l1.4-8-6 5z', I) +
    path('M43 21l3.6-9 3.4 7 3.4-7 3.6 9z', I) +
    path('M50 18c13 0 20 9 20 22 0 10-4 18-6 28-1.5 8-6 14-14 14S37.5 76 36 68c-2-10-6-18-6-28 0-13 7-22 20-22z', F) +
    line('M42.5 26.5l7.5 5 7.5-5M41.5 36l8.5 6 8.5-6M42.5 47.5l7.5 5.5 7.5-5.5', I, 3.2) +
    path('M30.6 33c5.4.6 9.4 3.2 12.4 7.4L31 38.6zM69.4 33c-5.4.6-9.4 3.2-12.4 7.4L69 38.6zM32.4 46.4c4.8.2 8.4 2.8 11 6.6l-9.8-.6zM67.6 46.4c-4.8.2-8.4 2.8-11 6.6l9.8-.6z', I) +
    ell(50, 75, 12.5, 9, I) +
    ell(45, 75.5, 2, 3, '#6b5d48') +
    ell(55, 75.5, 2, 3, '#6b5d48') +
    circle(36.5, 45, 2.6, I) +
    circle(63.5, 45, 2.6, I),
  giraffe:
    path('M22 100C28 74 38 54 50 39l12.5 8.5C53 59 46 76 44 100z', F) +
    line('M49.5 40.5C40 53 31.5 72 26.5 96', S, 3.2) +
    path('M40 58l7 2-2 7-7-1zM33 75l7 1.5-1 7.5-7-1zM45 75l2.5-1 .5 9-4 .5zM46.5 48l5.5 3-3.5 5-4.5-2.5zM36.5 90l6 .5v6l-7-.5z', '#c98d4a') +
    line('M57.5 29l-2.5-10.5M64 27.5l.5-11', F, 3.6) +
    circle(55, 18, 3, I) +
    circle(64.5, 16, 3, I) +
    path('M50 39C51 27.5 59 22 70.5 25.5L84 31c4.5 2 4.5 8.5 0 10.5L70 45c-5 1.5-9 1-12-1.5z', F) +
    ell(53.5, 30.5, 7, 2.8, F, -32) +
    ell(53.5, 30.5, 3.6, 1.4, S, -32) +
    path('M66 37c3-3 7-3.5 10-2l-1 6-7 1z', '#c98d4a') +
    circle(66.5, 31.5, 2.5, I) +
    circle(84.5, 35.5, 1.3, I) +
    line('M77 41.5c2.5 1 5 1 7.5-.5', I, 1.6),
  penguin:
    path('M28 55c-7 8-9 16-7 23 4-2 8-8 9.5-14zM72 55c7 8 9 16 7 23-4-2-8-8-9.5-14z', '#2c3038') +
    ell(50, 57, 22, 30, '#2c3038') +
    ell(50, 63, 15, 23, F) +
    path('M38 33c3-5 8-7 12-7s9 2 12 7c-3 4-8 6-12 6s-9-2-12-6z', '#2c3038') +
    circle(43, 40, 3.6, F) +
    circle(57, 40, 3.6, F) +
    circle(43.6, 40.4, 1.8, I) +
    circle(56.4, 40.4, 1.8, I) +
    path('M44.5 46h11L50 54z', '#f2a43a') +
    ell(42, 88, 6.5, 2.8, '#f2a43a') +
    ell(58, 88, 6.5, 2.8, '#f2a43a'),
  flamingo:
    line('M60 66l-.5 26M64.5 66l4 10.5-8 1.5', '#e98aa5', 2.6) +
    path('M80 52c6-1 10 2 11 5-4 1-8 1-11-1z', '#f6a9bf') +
    ell(64, 58, 19, 11, '#f6a9bf', -14) +
    path('M58 56c6-6 15-7 22-3-5 5-13 7-22 5z', '#e98aa5') +
    line('M47.5 56C35 52 30 42 37.5 33.5 43.5 26.5 46 19 38.5 16', '#f6a9bf', 6.5) +
    circle(37.5, 17.5, 7, '#f6a9bf') +
    path('M32 14.5L21.5 19.5l3 6.5 8.5-6z', F) +
    path('M21.5 19.5l3 6.5 3-2.2-2.2-5.8z', I) +
    circle(39.5, 15.5, 1.7, I),
};

let uid = 0;

/**
 * The avatar as an inline SVG string, `sizePx` square. Unknown animals fall back to the lion
 * and colours wrap into 0..7, so a stored avatar from a newer build still draws something.
 */
export function avatarSvg(a: Avatar, sizePx: number): string {
  const animal: AvatarAnimal = a && a.animal in HEADS ? a.animal : 'lion';
  const n = AVATAR_COLOR_HEX.length;
  const c = Number.isFinite(a?.color) ? ((Math.round(a.color) % n) + n) % n : 0;
  const s = Math.max(1, Math.round(sizePx));
  // the giraffe's neck and the like are cut at the disc's edge (an id per drawing: a shared one
  // would break when the first avatar on the page is hidden or removed)
  const clip = `wh-av${uid++}`;
  return (
    `<svg class="wh-avatar" width="${s}" height="${s}" viewBox="0 0 100 100" role="img" aria-label="${AVATAR_NAMES[animal]}">` +
    `<circle cx="50" cy="50" r="50" fill="${AVATAR_COLOR_HEX[c]}"/>` +
    `<circle cx="50" cy="50" r="47" fill="none" stroke="#ffffff" stroke-opacity=".18" stroke-width="2"/>` +
    `<clipPath id="${clip}"><circle cx="50" cy="50" r="50"/></clipPath>` +
    `<g clip-path="url(#${clip})">${HEADS[animal]}</g></svg>`
  );
}
