// Playwright helpers for driving the real game (menu, loading, in-game UI) in the e2e scenarios.
import { createRequire } from 'node:module';
import { ORIGIN } from './stack.mjs';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const id of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try {
      return require(id);
    } catch {
      /* next */
    }
  }
  throw new Error('playwright not found (npm i -g playwright, or /opt/node-tools)');
}
export const { chromium } = loadPlaywright();

export const SIZE = { width: 915, height: 412 };
export const SMALL = { width: 800, height: 360 };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SwiftShader-safe Chromium (as scripts/gameshots.cjs). */
export function launch() {
  return chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
}

/** One phone: its own context (storage), a page, and a log of console errors and API calls. */
export async function phone(browser, name, opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport ?? SIZE, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  const p = { name, context, page, errors: [], api: [], requests: [], fakeSub: opts.fakeSub ?? 'parent1' };
  page.on('pageerror', (e) => p.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') p.errors.push(`console: ${m.text()}`);
  });
  page.on('request', (r) => p.requests.push({ url: r.url(), type: r.resourceType(), method: r.method() }));
  page.on('response', async (r) => {
    const u = r.url();
    if (!u.includes(':8787/v1/')) return;
    let body = null;
    try {
      const ct = r.headers()['content-type'] ?? '';
      if (ct.includes('json')) body = await r.json();
    } catch {
      body = null;
    }
    p.api.push({ t: Date.now(), method: r.request().method(), url: u.replace(/^https?:\/\/[^/]+/, ''), status: r.status(), body });
  });
  return p;
}

/** Open the game (q=low); `query` adds parameters. */
export async function open(p, query = '') {
  const q = new URLSearchParams(query);
  if (!q.has('q')) q.set('q', 'low');
  if (p.fakeSub && !q.has('fakeSub')) q.set('fakeSub', p.fakeSub);
  await p.page.goto(`${ORIGIN}/index.html?${q}`, { waitUntil: 'load', timeout: 180_000 });
}

/** Wait for the title menu's primary button; returns its data-menu id and label. */
export async function menu(p, timeout = 120_000) {
  const el = p.page.locator('.wh-menu .wh-ac-primary, .wh-menu [data-menu].wh-btn-primary').first();
  await el.waitFor({ timeout });
  await sleep(300);
  return { id: await el.getAttribute('data-menu'), label: (await el.innerText()).trim() };
}

export async function tap(p, selector, opts = {}) {
  const el = p.page.locator(selector).first();
  await el.waitFor({ timeout: opts.timeout ?? 60_000 });
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.tap({ timeout: opts.timeout ?? 60_000, force: opts.force ?? false });
}

/** Wait until the game has booted (__ready) and the loading screen is gone. */
export async function ready(p, timeout = 600_000) {
  await p.page.waitForFunction(() => window.__ready === true && !document.querySelector('.wh-load'), null, { timeout, polling: 500 });
  await sleep(500);
}

/** Wait until the page reloads (switchSlot) and boots again or stops at the menu. */
export async function waitReload(p, timeout = 60_000) {
  await p.page.waitForFunction(() => window.__ready !== true, null, { timeout, polling: 200 });
}

export async function shot(p, dir, name) {
  const path = `${dir}/${name}.png`;
  await p.page.screenshot({ path });
  return path;
}

export function evalG(p, fn, arg) {
  return p.page.evaluate(fn, arg);
}

/** The visible account dialog (sync prompts / menu dialogs) text, or null. */
export async function dialogText(p) {
  return p.page.evaluate(() => {
    const d = [...document.querySelectorAll('.wh-ac-layer .wh-ac-modal, .wh-ac-modal, [role="dialog"], [role="alertdialog"]')].filter((x) => x.getBoundingClientRect().width > 0).pop();
    return d ? d.innerText : null;
  });
}

/** Solve the grown-up check (a 2-digit × 1-digit multiplication) on the keypad. */
export async function solveGrownup(p) {
  const q = await p.page.locator('.wh-ac-gate-q').first().innerText();
  const m = /(\d+)\s*×\s*(\d+)/.exec(q);
  if (!m) throw new Error(`no grown-up question in ${q}`);
  for (const d of String(Number(m[1]) * Number(m[2]))) await p.page.locator(`.wh-ac-keys .wh-btn[aria-label="${d}"]`).first().tap();
  await p.page.locator('.wh-ac-keys .ok').first().tap();
}

export async function setOffline(p, off) {
  await p.context.setOffline(off);
  await p.page.evaluate((off) => window.dispatchEvent(new Event(off ? 'offline' : 'online')), off);
}

/** Simulate the app going to the background and back (visibilitychange), with the real time gap. */
export async function hideShow(p, hiddenMs = 300) {
  await p.page.evaluate(async (ms) => {
    const set = (h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    set(true);
    await new Promise((r) => setTimeout(r, ms));
    set(false);
  }, hiddenMs);
}
