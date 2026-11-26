#!/usr/bin/env node
// End-to-end tests of the wired game (spec §10.2): the real API server, the fake Google issuer and the
// game in Playwright Chromium, with two (or three) browser contexts as separate phones.
//
//   node scripts/e2e/run.mjs [--only=E2E-1,E2E-3] [--out=<dir>] [--attach]
//
// E2E-6 runs first against a production build made without any VITE_* variable (served statically on
// :5199); then the cloud stack starts (fake Google :8799, the built server :8787 on a temp DB, Vite
// :5199 with VITE_API_BASE) for E2E-1 … E2E-7. Screenshots go to --out (default the round's
// e2e-shots folder). Exits non-zero on any failed check; every process it started is stopped.
// --attach uses a stack that is already running (development) and skips E2E-6.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as st from './stack.mjs';
import * as G from './game.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const SP = '/tmp/claude-0/-home-user-Zoo-tycoon-/bae1d340-b232-5104-9d01-507adc8e661c/scratchpad';
const OUT = opt('out', join(SP, 'features14/e2e-shots'));
const CACHE = opt('cache', join(SP, 'vitecache-p2-integrator'));
const only = opt('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const attach = args.includes('--attach');
const want = (id) => !only.length || only.includes(id);
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(0);
const results = [];
let current = '';
function check(name, ok, detail) {
  results.push({ scenario: current, name, ok: !!ok, detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${current}] ${name}${ok ? '' : ` — ${JSON.stringify(detail)?.slice(0, 600)}`}`);
  return !!ok;
}
const must = (name, ok, detail) => {
  if (!check(name, ok, detail)) throw new Error(`required check failed: ${name}`);
};
const shots = [];
async function shot(p, name) {
  const path = await G.shot(p, OUT, name);
  shots.push(path);
  return path;
}
async function until(fn, label, ms = 60_000, every = 500) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
    await G.sleep(every);
  }
}

// ------------------------------------------------------------------ server-side helpers
let dbPath = null;
async function api(p, method, path, body) {
  const auth = await p.page.evaluate(() => JSON.parse(localStorage.getItem('wh2:auth') || 'null'));
  const r = await fetch(`${st.API}${path}`, {
    method,
    headers: { authorization: `Bearer ${auth?.token}`, 'content-type': 'application/json', 'x-app-version': '0.15.0', 'x-client': 'web' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return { status: r.status, body: json };
}
function db() {
  return new DatabaseSync(dbPath);
}
function revisions(pid) {
  const d = db();
  try {
    return d
      .prepare('SELECT r.epoch, r.rev, r.device_id AS device, r.pinned_until AS pinned, r.meta FROM save_revisions r JOIN saves s ON s.id = r.save_id WHERE s.profile_id = ? ORDER BY r.rev')
      .all(pid)
      .map((r) => ({ ...r, meta: JSON.parse(r.meta) }));
  } finally {
    d.close();
  }
}
function headOf(pid) {
  const d = db();
  try {
    return d.prepare('SELECT head_rev AS rev, head_epoch AS epoch, lease_device_id AS leaseDevice, lease_until AS leaseUntil FROM saves WHERE profile_id = ?').get(pid) ?? null;
  } finally {
    d.close();
  }
}
const deviceIdOf = (p) => p.page.evaluate(() => JSON.parse(localStorage.getItem('wh2:device') || 'null')?.id ?? null);

// ------------------------------------------------------------------ in-game helpers
const g = {
  speed: (p, s) => p.page.evaluate((s) => window.__game.ui.ext.setSpeed(s, 'ext'), s),
  save: (p) => p.page.evaluate(() => window.__game.save()),
  syncNow: (p) => p.page.evaluate(async () => {
    window.__game.save();
    await window.__cloud.sync.syncNow();
    return window.__cloud.status.get();
  }),
  play: (p) => p.page.evaluate(() => window.__game.playSeconds()),
  state: (p) => p.page.evaluate(() => ({ key: window.__game?.activeKey ?? null, day: window.__game?.sim.day, time: window.__game?.sim.time, speed: window.__game?.sim.speed, play: window.__game?.playSeconds() })),
  /** switchSlot({kind:'menu'}) in the game (the page reloads; the call is not awaited inside the page). */
  toMenu: async (p) => {
    await p.page.evaluate(() => {
      void window.__game.switchSlot({ kind: 'menu', player: window.__game.menu.player });
    });
    await G.waitReload(p);
  },
  pidOf: (p, name) => p.page.evaluate((name) => window.__cloud.profiles.list().find((x) => x.name === name)?.id ?? null, name),
  setTutorial: (p, ref, status) =>
    p.page.evaluate(
      ({ ref, status }) => {
        const key = ref === 'guest' ? 'wildhaven-tutorial' : `wh2:p:${ref}:tutorial`;
        localStorage.setItem(key, JSON.stringify({ v: 1, status, readAloud: false, updatedAt: Date.now() }));
      },
      { ref, status },
    ),
};
/** Tap the visible button with this accessible name (regex or string). */
async function tapButton(p, name, opts = {}) {
  const loc = p.page.getByRole('button', { name, exact: opts.exact ?? false }).filter({ visible: true }).first();
  await loc.waitFor({ timeout: opts.timeout ?? 60_000 });
  await loc.tap({ timeout: opts.timeout ?? 60_000 });
}
async function visibleText(p) {
  return p.page.evaluate(() => document.body.innerText);
}
/** Menu sign-in from the player chip ("Sign in"). */
async function menuSignIn(p) {
  await G.tap(p, '[data-chip="signin"]');
  await G.tap(p, '.wh-ac-signin .wh-btn-primary');
}
async function firstPlayer(p, name, animal = 'Giraffe', colour = 'Colour 5') {
  await p.page.locator('.wh-ac-setup-page .wh-ac-name').first().waitFor({ timeout: 60_000 });
  await p.page.fill('.wh-ac-setup-page .wh-ac-name', name);
  await G.tap(p, `.wh-ac-animal[aria-label="${animal}"]`);
  await G.tap(p, `.wh-ac-color[aria-label="${colour}"]`);
  await G.tap(p, '.wh-ac-setup-page .wh-ac-actions .wh-btn-primary');
}
/** From the menu: the primary button (Continue as …), then wait for the game. */
async function continueGame(p, expect = /Continue/) {
  const m = await G.menu(p);
  must(`${p.name}: menu primary is ${expect}`, expect.test(m.label), m);
  await G.tap(p, '.wh-menu .wh-ac-primary');
}
async function closeDialogs(p) {
  await p.page.keyboard.press('Escape').catch(() => {});
}

// ------------------------------------------------------------------ E2E-6: cloud-disabled build
async function e2e6(browser) {
  current = 'E2E-6';
  const out = join(SP, 'features14/p2/integrator/e2e-dist-nocloud');
  console.log(`[${secs()}s] E2E-6: building without VITE_* …`);
  st.buildNoCloud(out, join(CACHE, 'build-nocloud'));
  await st.serveStatic(out);
  const P = await G.phone(browser, 'nocloud');
  try {
    await G.open(P);
    const m = await G.menu(P);
    check('menu shows New Zoo first (no zoo yet)', m.id === 'new', m);
    const menuDom = await P.page.evaluate(() => ({
      chip: !!document.querySelector('[data-chip]'),
      versus: !!document.querySelector('[data-menu="versus"]'),
      learn: !!document.querySelector('[data-menu="learn"]'),
    }));
    check('no player chip and no Versus in the menu', !menuDom.chip && !menuDom.versus, menuDom);
    check('"Learn to play" is shown in every build', menuDom.learn, menuDom);
    await shot(P, 'e2e6-menu-nocloud');
    await g.setTutorial(P, 'guest', 'done');
    await G.tap(P, '.wh-menu .wh-ac-primary');
    await G.ready(P);
    await g.speed(P, 3);
    // the 90 s autosave writes the guest key by itself (nothing calls save() here)
    const first = await P.page.evaluate(() => localStorage.getItem('wildhaven-save-v1'));
    console.log(`[${secs()}s] E2E-6: waiting for the autosave …`);
    await until(() => P.page.evaluate((f) => {
      const now = localStorage.getItem('wildhaven-save-v1');
      return now !== null && now !== f;
    }, first), 'the autosave', 420_000, 2000);
    check('the autosave writes wildhaven-save-v1', true);
    await G.hideShow(P, 400);
    await G.sleep(1500);
    const ls = await P.page.evaluate(() => {
      const raw = localStorage.getItem('wildhaven-save-v1');
      let plain = false;
      try {
        plain = !!raw && typeof JSON.parse(raw).version === 'number';
      } catch {
        plain = false;
      }
      return { plain, keys: Object.keys(localStorage), badge: !!document.querySelector('.wh-ac-badge'), cloudEnabled: window.__cloud.enabled };
    });
    check('wildhaven-save-v1 is plain JSON', ls.plain, ls);
    check('no wh2:* key is written', !ls.keys.some((k) => k.startsWith('wh2:')), ls.keys);
    check('cloud disabled and no badge in game', ls.cloudEnabled === false && !ls.badge, ls);
    const foreign = P.requests.filter((r) => !r.url.startsWith(st.ORIGIN) && !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
    const apiLike = P.requests.filter((r) => /\/v1\//.test(r.url) || r.url.includes(':8787') || r.url.includes(':8799'));
    check('zero requests to any non-asset URL (menu, New Zoo, saves, hide/show)', foreign.length === 0 && apiLike.length === 0, { foreign: foreign.slice(0, 5), apiLike: apiLike.slice(0, 5) });
    await shot(P, 'e2e6-game-nocloud');
    check('no page errors', P.errors.length === 0, P.errors.slice(0, 5));
  } finally {
    await P.context.close();
    await st.stopAll();
  }
}

// ------------------------------------------------------------------ the cloud scenarios
const S = {}; // shared between scenarios: phones and ids

async function e2e1(browser) {
  current = 'E2E-1';
  const A = (S.A = await G.phone(browser, 'A'));
  await G.open(A);
  await G.menu(A);
  // a guest zoo with a distinctive tutorial state
  await A.page.evaluate(() => localStorage.setItem('wildhaven-tutorial', JSON.stringify({ v: 1, status: 'skipped', readAloud: false, updatedAt: 1_700_000_000_000 })));
  await G.tap(A, '.wh-menu .wh-ac-primary');
  await G.ready(A);
  await g.speed(A, 3);
  await G.sleep(3000);
  await g.save(A);
  const guestMeta = await A.page.evaluate(() => {
    const s = window.__game.sim;
    return { day: s.day, money: Math.round(s.money), animals: s.animals.size };
  });
  // Settings › Sign in with Google → reload → first player → whose zoo
  await A.page.evaluate(() => window.__game.ui.openZooPanel('settings'));
  await tapButton(A, 'Sign in with Google');
  await G.tap(A, '.wh-ac-signin .wh-btn-primary');
  await G.waitReload(A);
  await firstPlayer(A, 'Mia');
  await A.page.locator('.wh-ac-whose').first().waitFor({ timeout: 60_000 });
  await shot(A, 'e2e1-whose-zoo');
  await G.tap(A, '.wh-ac-whose .wh-ac-tile[data-pid]');
  const m = await G.menu(A);
  check('menu: Continue as Mia', /Continue as Mia/.test(m.label), m);
  S.mia = await g.pidOf(A, 'Mia');
  const ls = await A.page.evaluate((pid) => ({
    legacy: localStorage.getItem('wildhaven-save-v1'),
    moved: JSON.parse(localStorage.getItem('wildhaven-save-v1-moved') || 'null'),
    tut: JSON.parse(localStorage.getItem(`wh2:p:${pid}:tutorial`) || 'null'),
  }), S.mia);
  check('wildhaven-save-v1 gone after adoption', ls.legacy === null);
  check('wildhaven-save-v1-moved present (movedTo Mia)', ls.moved?.movedTo?.profileId === S.mia, ls.moved?.movedTo);
  check("Mia's tutorial state copied from the guest", ls.tut?.status === 'skipped' && ls.tut?.readAloud === false, ls.tut);
  await shot(A, 'e2e1-menu-continue-as-mia');
  await continueGame(A, /Continue as Mia/);
  await G.ready(A);
  const head = await until(async () => {
    const r = await api(A, 'GET', `/v1/profiles/${S.mia}/saves/main`);
    return r.status === 200 && r.body?.head ? r.body.head : null;
  }, "Mia's cloud head", 60_000);
  check('cloud head meta = the guest zoo (day, money)', head.meta.day === guestMeta.day && Math.abs(head.meta.money - guestMeta.money) <= 2, { head: head.meta, guestMeta });
  await shot(A, 'e2e1-mia-in-game');
}

async function e2e3(browser) {
  current = 'E2E-3';
  const A = S.A;
  const B = (S.B = await G.phone(browser, 'B'));
  await G.open(B);
  await G.menu(B);
  await menuSignIn(B);
  await until(async () => /Continue as Mia/.test((await G.menu(B)).label), 'B: Continue as Mia', 60_000);
  // A is playing Mia: hold the lease right now (A's device), so B's open meets it
  await g.syncNow(A);
  const lease = await api(A, 'POST', `/v1/profiles/${S.mia}/saves/main/lease`, { action: 'acquire' });
  must('A holds the lease', lease.status === 200 && lease.body?.lease?.mine === true, lease);
  await G.tap(B, '.wh-menu .wh-ac-primary');
  const take = await until(() => G.dialogText(B), 'the takeover prompt on B', 30_000, 200);
  check('B: takeover prompt "Mia is playing on …"', /Mia is playing on/i.test(take), take);
  await shot(B, 'e2e3-takeover-prompt');
  await tapButton(B, 'Play here');
  // A notices at its next push, which meets B's fresh lease (LEASE_SECONDS=20 in the e2e server;
  // otherwise at the 60 s renew)
  await until(() => headOf(S.mia)?.leaseDevice && deviceIdOf(B).then((id) => headOf(S.mia).leaseDevice === id), "B's lease", 15_000, 200);
  await g.syncNow(A).catch(() => {});
  await G.ready(B);
  check('B opened Mia', (await g.state(B)).key === `${S.mia}/main`);
  const moved = await until(() => G.dialogText(A), 'the moved notice on A', 90_000, 300);
  check("A: notice \"Mia's zoo is open on …\" (the other device, never \"This phone\")", /open on/i.test(moved) && !/open on This phone/i.test(moved) && /backup/i.test(moved), moved);
  check('A: a notice (≤ 120 s), not the two-card choice', !(await A.page.locator('.wh-ac-choice').count()), moved);
  await shot(A, 'e2e3-moved-notice');
  await tapButton(A, /^OK$/);
  await G.waitReload(A);
  const m = await G.menu(A);
  check('A is back in the menu', /Continue as Mia/.test(m.label), m);
}

async function e2e2(browser) {
  current = 'E2E-2';
  const A = S.A;
  const B = S.B;
  // B is in Mia's zoo: push, then go offline; A opens Mia once B's lease has run out
  await g.syncNow(B);
  await G.setOffline(B, true);
  await G.sleep(21_000);
  await continueGame(A, /Continue as Mia/);
  await G.ready(A);
  await G.setOffline(A, true);
  await g.speed(A, 3);
  await g.speed(B, 2);
  const a0 = await g.play(A);
  const b0 = await g.play(B);
  console.log(`[${secs()}s] E2E-2: both phones offline, playing ≥ 2.5 min …`);
  // play time counts foreground frames with the clock running (two SwiftShader pages run slower than real time)
  await until(async () => (await g.play(A)) - a0 >= 155, 'A: 155 s of play', 480_000, 2000);
  await g.save(A);
  const aPlay = (await g.play(A)) - a0;
  // B plays on a little longer: its zoo has more unique play (the Newest card)
  await until(async () => (await g.play(B)) - b0 >= aPlay + 25, 'B: more play than A', 300_000, 2000);
  await g.save(B);
  const bPlay = (await g.play(B)) - b0;
  check('both phones played ≥ 150 s offline', aPlay >= 150 && bPlay >= 150, { aPlay, bPlay });
  // A comes online first: its push lands; it leaves the zoo (push + lease release)
  await G.setOffline(A, false);
  await g.syncNow(A);
  const aDevice = await deviceIdOf(A);
  const bDevice = await deviceIdOf(B);
  await until(() => headOf(S.mia)?.rev && revisions(S.mia).at(-1)?.device === aDevice, "A's push on the server", 30_000);
  const aRev = headOf(S.mia).rev;
  await g.toMenu(A);
  await G.menu(A);
  // B comes online: two zoos with ≥ 2 min unique play each → the conflict (badge → dialog)
  await G.setOffline(B, false);
  await g.syncNow(B).catch(() => {});
  await until(() => B.page.evaluate(() => window.__cloud.status.get().kind === 'conflict'), 'the conflict on B', 60_000);
  await G.sleep(800);
  await shot(B, 'e2e2-conflict-badge');
  await G.tap(B, '.wh-ac-badge');
  await B.page.locator('.wh-ac-choice').first().waitFor({ timeout: 30_000 });
  const cards = await B.page.evaluate(() =>
    [...document.querySelectorAll('.wh-ac-choice .wh-ac-card')].map((c) => ({ side: c.getAttribute('data-side'), newest: c.classList.contains('newest'), text: c.innerText })),
  );
  check('B: conflict dialog with two cards', cards.length === 2, cards);
  check('B: "Newest" is on the card with more play (this phone)', cards.find((c) => c.newest)?.side === 'here', cards);
  await shot(B, 'e2e2-conflict-dialog');
  await G.tap(B, '.wh-ac-choice .wh-ac-card[data-side="here"] .wh-btn');
  const head = await until(() => {
    const revs = revisions(S.mia);
    const last = revs.at(-1);
    return last && last.device === bDevice && last.rev > aRev ? { revs, last } : null;
  }, "B's zoo as the head", 30_000);
  check('server head = B\'s content', head.last.device === bDevice, head.last);
  // the head B's keep replaced (A's last push, rev = B's − 1) is pinned for 30 days
  const replaced = head.revs.find((r) => r.rev === head.last.rev - 1 && r.epoch === head.last.epoch);
  check("A's copy is pinned (keep_local)", replaced?.device === aDevice && !!replaced?.pinned && replaced.pinned > Date.now() + 20 * 86_400_000, replaced);
  await G.sleep(1000);
  await shot(B, 'e2e2-after-keep');
}

async function e2e3b(browser) {
  current = 'E2E-3b';
  const A = S.A;
  const B = S.B;
  // B pauses (its zoo gains no more unique play: the next zoo B saves is the one it "takes"), then A
  // opens Mia (gets B's zoo), goes offline and plays > 2 min after its lease ran out
  await g.speed(B, 0);
  await g.syncNow(B).catch(() => {});
  await G.sleep(21_000);
  await continueGame(A, /Continue as Mia/);
  await G.ready(A);
  await G.setOffline(A, true);
  await g.speed(A, 3);
  const a0 = await g.play(A);
  console.log(`[${secs()}s] E2E-3b: A offline, playing > 2 min …`);
  await until(async () => (await g.play(A)) - a0 >= 25, 'A: 25 s of play', 120_000, 1000);
  // B takes Mia (A's lease has run out) and keeps playing and saving
  await g.syncNow(B);
  const bl = await api(B, 'POST', `/v1/profiles/${S.mia}/saves/main/lease`, { action: 'acquire', takeover: true });
  must('B holds the lease', bl.status === 200 && bl.body?.lease?.mine === true, bl);
  await until(async () => (await g.play(A)) - a0 >= 135, 'A: 135 s of play', 420_000, 2000);
  await g.save(A);
  const aPlay = (await g.play(A)) - a0;
  check('A played > 120 s offline', aPlay > 120, { aPlay });
  // B pushes now (its lease is live) → its head is the one A will replace
  await g.syncNow(B);
  const bl2 = await api(B, 'POST', `/v1/profiles/${S.mia}/saves/main/lease`, { action: 'acquire' });
  const tBl2 = Date.now();
  must('B still holds the lease', bl2.status === 200 && bl2.body?.lease?.mine === true, bl2);
  const bDevice = await deviceIdOf(B);
  const aDevice = await deviceIdOf(A);
  const bRev = headOf(S.mia).rev;
  check("B's push is the head", revisions(S.mia).at(-1)?.device === bDevice, revisions(S.mia).at(-1));
  const tOnline = Date.now();
  await G.setOffline(A, false);
  await g.syncNow(A).catch(() => {});
  await A.page.locator('.wh-ac-choice').first().waitFor({ timeout: 90_000 });
  const cards = await A.page.evaluate(() =>
    [...document.querySelectorAll('.wh-ac-choice .wh-ac-card')].map((c) => ({ side: c.getAttribute('data-side'), newest: c.classList.contains('newest'), text: c.innerText })),
  );
  check('A: the two-card lease-lost choice', cards.length === 2 && /This (phone|device)/i.test(cards.find((c) => c.side === 'here')?.text ?? ''), cards);
  check('A: the clock is held while the choice is open', await A.page.evaluate(async () => {
    const t = window.__game.sim.time;
    await new Promise((r) => setTimeout(r, 1200));
    return window.__game.sim.time === t;
  }));
  await shot(A, 'e2e3b-lease-lost-choice');
  await G.tap(A, '.wh-ac-choice .wh-ac-card[data-side="here"] .wh-btn');
  const after = await until(() => {
    const revs = revisions(S.mia);
    const last = revs.at(-1);
    return last && last.device === aDevice && last.rev > bRev ? { revs, last } : null;
  }, "A's zoo as the head", 30_000);
  check('"this phone" keeps A\'s zoo (server head from A)', after.last.device === aDevice, after.last);
  const bCopy = after.revs.find((r) => r.rev === after.last.rev - 1 && r.epoch === after.last.epoch);
  if (!check("B's head is pinned", bCopy?.device === bDevice && !!bCopy?.pinned && bCopy.pinned > Date.now() + 20 * 86_400_000, bCopy)) {
    console.log('debug revisions', JSON.stringify(after.revs.map((r) => [r.rev, r.device.slice(0, 8), r.pinned, r.meta.playSeconds])));
    console.log('debug A api', JSON.stringify(A.api.filter((x) => x.url.includes('/saves/main') && x.t > tOnline - 5000).map((x) => [x.t - tOnline, x.method, x.url.split('/').pop(), x.status, x.body?.error?.code ?? x.body?.head?.rev ?? null])));
    console.log('debug B api', JSON.stringify(B.api.filter((x) => x.url.includes('/saves/main') && x.t > tOnline - 60000).map((x) => [x.t - tOnline, x.method, x.url.split('/').pop(), x.status, x.body?.error?.code ?? x.body?.head?.rev ?? null])), 'bl2 at', tBl2 - tOnline);
  }
  check('A keeps playing (no reload)', (await g.state(A)).key === `${S.mia}/main`);
  // leave both zoos for the next scenarios
  await g.toMenu(A);
  await G.menu(A);
  await g.toMenu(B).catch(() => {});
  await G.sleep(2000);
}

async function e2e4(browser) {
  current = 'E2E-4';
  const D = await G.phone(browser, 'D', { fakeSub: 'parent4' });
  try {
    await G.open(D);
    await G.menu(D);
    await menuSignIn(D);
    // the first player: a filtered name is refused, a nickname is fine
    await D.page.locator('.wh-ac-setup-page .wh-ac-name').first().waitFor({ timeout: 60_000 });
    await D.page.fill('.wh-ac-setup-page .wh-ac-name', 'mia@zoo.com');
    await G.sleep(400);
    const refused = await D.page.evaluate(() => ({
      msg: document.querySelector('.wh-ac-namemsg')?.textContent ?? '',
      disabled: document.querySelector('.wh-ac-setup-page .wh-ac-actions .wh-btn-primary')?.disabled ?? null,
    }));
    check('a filtered name is refused on the setup page', refused.msg.length > 0 && refused.disabled === true, refused);
    await shot(D, 'e2e4-filtered-name');
    const server = await D.page.evaluate(() => window.__cloud.profiles.create('mia@zoo.com', { animal: 'lion', color: 0 }).then(() => 'created', (e) => e.code));
    check('the server refuses the filtered name too', server === 'bad_name' || server === 'name_rejected' || (typeof server === 'string' && server !== 'created'), server);
    await firstPlayer(D, 'Ava', 'Lion', 'Colour 2');
    await G.menu(D);
    // 7 more players (8 in all)
    const made = await D.page.evaluate(async () => {
      const names = ['Ben', 'Cal', 'Dot', 'Eli', 'Fay', 'Gus', 'Hal'];
      const out = [];
      for (const [i, n] of names.entries()) out.push(await window.__cloud.profiles.create(n, { animal: 'zebra', color: i % 8 }).then((p) => p.name, (e) => e.code));
      return out;
    });
    check('players 2–8 created', made.every((x) => /^[A-Z]/.test(x)), made);
    const ninth = await D.page.evaluate(() => window.__cloud.profiles.create('Ivy', { animal: 'bear', color: 1 }).then(() => 'created', (e) => e.code));
    check('the 9th player is refused (profile_limit)', ninth === 'profile_limit', ninth);
    // Who's playing? shows 8 players and a disabled "+ Add player"
    await G.tap(D, '[data-chip]');
    await D.page.locator('.wh-ac-picker').first().waitFor();
    await G.sleep(1200);
    const picker = await D.page.evaluate(() => ({
      tiles: document.querySelectorAll('.wh-ac-picker .wh-ac-tile:not(.add)').length,
      add: document.querySelector('.wh-ac-picker [data-tile="add"]')?.disabled ?? null,
      note: document.querySelector('.wh-ac-picker [data-tile="add"]')?.innerText ?? '',
    }));
    check("Who's playing? shows 8 players (+ Guest) and a disabled Add player", picker.tiles >= 8 && picker.add === true, picker);
    await shot(D, 'e2e4-whos-playing-8');
    // Manage players → remove Hal behind the grown-up check → Undo
    await G.tap(D, '.wh-ac-picker .wh-ac-headbtn[aria-label="Manage players"]');
    await D.page.locator('.wh-ac-manage').first().waitFor();
    await tapButton(D, 'Remove Hal');
    await D.page.locator('.wh-ac-gate-q').first().waitFor({ timeout: 30_000 });
    await shot(D, 'e2e4-grownup-check');
    await G.solveGrownup(D);
    // then "Remove Hal?" (Keep is the primary button)
    await tapButton(D, 'Remove', { exact: true });
    await until(() => D.page.evaluate(() => !!document.querySelector('.wh-ac-manage [data-removed]')), 'Hal in Recently removed', 30_000);
    const removed = await D.page.evaluate(() => window.__cloud.profiles.removed().map((r) => r.name));
    check('Hal is soft-deleted (Recently removed)', removed.includes('Hal'), removed);
    await shot(D, 'e2e4-recently-removed');
    await tapButton(D, 'Bring back Hal');
    await until(() => D.page.evaluate(() => window.__cloud.profiles.list().some((p) => p.name === 'Hal') && !window.__cloud.profiles.removed().some((r) => r.name === 'Hal')), 'Hal restored', 30_000);
    check('Undo brings Hal back', true);
    const errs = D.errors.filter((e) => !/Failed to load resource: the server responded with a status of 4(09|22)/.test(e));
    check('no page errors (the refused 9th player and name answer 409/422)', errs.length === 0, errs.slice(0, 5));
  } finally {
    await D.context.close();
  }
}

// ------------------------------------------------------------------ E2E-7: tutorial smoke on the real wiring
async function touchDrag(p, from, to, steps = 12) {
  const cdp = await p.context.newCDPSession(p.page);
  const pt = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from.x, from.y) });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t) });
    await G.sleep(30);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
async function twoFinger(p, c, { d0, d1, a0 = 0, a1 = 0 }, steps = 14) {
  const cdp = await p.context.newCDPSession(p.page);
  const pts = (d, a) => [
    { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d, id: 1, radiusX: 4, radiusY: 4, force: 1 },
    { x: c.x - Math.cos(a) * d, y: c.y - Math.sin(a) * d, id: 2, radiusX: 4, radiusY: 4, force: 1 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(d0, a0) });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d0 + (d1 - d0) * t, a0 + (a1 - a0) * t) });
    await G.sleep(30);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function e2e7(browser) {
  current = 'E2E-7';
  const A = S.A;
  // a new player on A's account; New Zoo starts the first-run tutorial
  await A.page.evaluate(() => window.__cloud.profiles.create('Tia', { animal: 'penguin', color: 6 }));
  const tia = await g.pidOf(A, 'Tia');
  await A.page.evaluate(() => sessionStorage.setItem('wildhaven-boot', JSON.stringify({ kind: 'menu', player: window.__cloud.profiles.list().find((p) => p.name === 'Tia').id })));
  await A.page.reload({ waitUntil: 'load' });
  const m = await G.menu(A);
  check('menu preselects Tia (no zoo yet → New Zoo)', m.id === 'new', m);
  await G.tap(A, '.wh-menu .wh-ac-primary');
  await G.ready(A);
  await until(() => A.page.evaluate(() => !!window.__tutorial), 'window.__tutorial', 30_000);
  const v0 = await A.page.evaluate(() => window.__tutorial.view());
  check('the welcome card shows', v0?.status === 'welcome', v0?.status);
  await shot(A, 'e2e7-tutorial-welcome');
  await tapButton(A, "Let's go");
  const step = () => A.page.evaluate(() => window.__tutorial.view()?.step ?? null);
  const W = G.SIZE.width;
  const H = G.SIZE.height;
  const c = { x: W / 2, y: H / 2 + 20 };
  // 1a pan, 1b zoom, 1c turn — real touch input
  await until(async () => (await step()) === 'look-pan', 'step pan', 20_000);
  await shot(A, 'e2e7-tutorial-pan');
  for (let i = 0; i < 4 && (await step()) === 'look-pan'; i++) await touchDrag(A, { x: c.x - 120, y: c.y }, { x: c.x + 120, y: c.y - 20 });
  await until(async () => (await step()) !== 'look-pan', 'pan done', 20_000);
  check('step 1a (pan) done by touch', true);
  for (let i = 0; i < 4 && (await step()) === 'look-zoom'; i++) await twoFinger(A, c, { d0: 40, d1: 140 });
  await until(async () => (await step()) !== 'look-zoom', 'zoom done', 20_000);
  check('step 1b (zoom) done by touch', true);
  for (let i = 0; i < 4 && (await step()) === 'look-turn'; i++) await twoFinger(A, c, { d0: 80, d1: 80, a0: 0, a1: 1.2 });
  await until(async () => (await step()) !== 'look-turn', 'turn done', 20_000);
  const s2 = await step();
  check('step 1c (turn) done by touch; the next step is chapter 2', !!s2 && !['look-pan', 'look-zoom', 'look-turn'].includes(s2), s2);
  await shot(A, 'e2e7-tutorial-step2');
  await A.page.evaluate(() => window.__tutorial.debugJump('play'));
  await G.sleep(500);
  await A.page.evaluate(() => window.__tutorial.debugFinish());
  const st2 = await until(() => A.page.evaluate((pid) => JSON.parse(localStorage.getItem(`wh2:p:${pid}:tutorial`) || 'null'), tia), "Tia's tutorial state", 20_000);
  await until(async () => (await A.page.evaluate((pid) => JSON.parse(localStorage.getItem(`wh2:p:${pid}:tutorial`) || 'null')?.status, tia)) === 'done', 'local status done', 20_000);
  check('local tutorial state done', true, st2);
  const prefs = await until(async () => {
    const r = await api(A, 'GET', '/v1/profiles');
    const p = r.body?.profiles?.find((x) => x.id === tia);
    return p?.prefs?.tutorial?.status === 'done' ? p.prefs.tutorial : null;
  }, 'prefs.tutorial done on the server', 30_000);
  check('profile state done mirrored to prefs.tutorial on the server', prefs.status === 'done', prefs);
  await shot(A, 'e2e7-tutorial-finished');
  await g.toMenu(A);
  await G.menu(A);
}

// ------------------------------------------------------------------ E2E-5 / 5b: versus
const FORBIDDEN_KEYS = new Set(['profileId', 'accountId', 'account_id', 'profile_id', 'email', 'deviceId', 'deviceName', 'invited_profile_id', 'google_sub']);
function deepScan(v, keys = new Set(), strings = new Set()) {
  if (Array.isArray(v)) for (const x of v) deepScan(x, keys, strings);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      keys.add(k);
      deepScan(x, keys, strings);
    }
  } else if (typeof v === 'string') strings.add(v);
  return { keys, strings };
}
/** The hub asks "Learn the basics first?" when the player's tutorial is not done: Play anyway. */
async function playAnyway(p) {
  await p.page.locator('.wh-vs-page, .wh-vs-head').first().waitFor({ timeout: 30_000 });
  await G.sleep(700);
  if (await p.page.getByRole('button', { name: 'Play anyway' }).count()) {
    await shot(p, `e2e5-learn-first-${p.name}`);
    await tapButton(p, 'Play anyway');
  }
}
/** Run the match clock to `hour` (or its end) through __versusDebug.skipHours, which may stop short. */
async function skipTo(p, hour) {
  for (let i = 0; i < 12; i++) {
    const st = await p.page.evaluate(() => window.__versusDebug.state());
    if (st.ended || st.hour >= hour) return st.hour;
    await p.page.evaluate((n) => window.__versusDebug.skipHours(n), hour - st.hour);
  }
  return (await p.page.evaluate(() => window.__versusDebug.state())).hour;
}
async function seatsOf(p) {
  return p.page.evaluate(() => window.__versusDebug.state());
}

async function e2e5(browser) {
  current = 'E2E-5';
  const A = S.A;
  // B: a friend on another account (parent2), on a small phone (800×360)
  const B = (S.B2 = await G.phone(browser, 'B2', { fakeSub: 'parent2', viewport: G.SMALL }));
  await G.open(B);
  await G.menu(B);
  await menuSignIn(B);
  await firstPlayer(B, 'Ben', 'Bear', 'Colour 3');
  await G.menu(B);
  S.ben = await g.pidOf(B, 'Ben');
  // A (Mia): Versus → Challenge a friend → the test length → the code
  await A.page.evaluate((pid) => sessionStorage.setItem('wildhaven-boot', JSON.stringify({ kind: 'menu', player: pid })), S.mia);
  await A.page.reload({ waitUntil: 'load' });
  await G.menu(A);
  await G.tap(A, '[data-menu="versus"]');
  await playAnyway(A);
  await tapButton(A, /Challenge a friend/);
  await G.tap(A, '[data-len="4"]');
  await shot(A, 'e2e5-challenge-lengths');
  await tapButton(A, 'Make my challenge!');
  const code = await A.page.locator('.wh-vs-code[data-code]').first().getAttribute('data-code', { timeout: 30_000 });
  check('a six-letter code', /^[A-Z0-9]{6}$/.test(code ?? ''), code);
  await shot(A, 'e2e5-code');
  // B: Versus → Join with a code → Accept! → Play!
  await G.tap(B, '[data-menu="versus"]');
  await playAnyway(B);
  await tapButton(B, /Join with a code/);
  const boxes = B.page.locator('.wh-vs-boxes input');
  await boxes.first().waitFor();
  for (let i = 0; i < 6; i++) await boxes.nth(i).fill(code[i]);
  await tapButton(B, 'Accept!');
  await shot(B, 'e2e5-joined-lobby');
  // watch for the 3-2-1 countdown from now on (the match boots in this page, no reload)
  await B.page.evaluate(() => {
    window.__sawCountdown = null;
    const t = setInterval(() => {
      const el = document.querySelector('.wh-vs-count');
      if (el && el.getBoundingClientRect().width > 0) {
        window.__sawCountdown = { text: el.innerText, speed: window.__game?.sim.speed ?? null, time: window.__game?.sim.time ?? null };
        clearInterval(t);
      }
    }, 50);
  });
  await tapButton(B, 'Play!');
  await tapButton(A, 'Start playing now');
  await Promise.all([G.ready(A), G.ready(B)]);
  S.match = await A.page.evaluate(() => window.__game.versus.matchId);
  // the countdown, then the locked clock
  const cd = await until(() => B.page.evaluate(() => window.__sawCountdown), 'the start countdown', 15_000, 200);
  check('B: 3-2-1 countdown at the start', !!cd, cd);
  await until(() => B.page.evaluate(() => !window.__game.versus.holding), 'B: Go!', 15_000, 200);
  await until(() => A.page.evaluate(() => !window.__game.versus.holding), 'A: Go!', 15_000, 200);
  const lock = await B.page.evaluate(async () => {
    const s = window.__game.sim;
    const before = s.speed;
    for (const code of ['Space', 'Digit0', 'Digit1', 'Digit2', 'Digit3']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code === 'Space' ? ' ' : code.slice(-1), bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { code, key: code === 'Space' ? ' ' : code.slice(-1), bubbles: true }));
    }
    const hud = window.__game.ui.ext.setSpeed(0, 'hud');
    const key = window.__game.ui.ext.setSpeed(1, 'key');
    await new Promise((r) => setTimeout(r, 300));
    return { before, after: s.speed, hud, key, speedGroup: !!document.querySelector('.wh-top-speed'), chip: (() => { const r = document.querySelector('.wh-vs-chip')?.getBoundingClientRect(); return r ? { w: r.width, h: r.height, x: r.x, y: r.y } : null; })() };
  });
  for (const k of ['Space', 'Digit0', 'Digit3']) await B.page.keyboard.press(k);
  const speedAfterKeys = await B.page.evaluate(() => window.__game.sim.speed);
  check('locked speed: Space and 0–3 do nothing (speed stays 3)', lock.before === 3 && lock.after === 3 && speedAfterKeys === 3, { lock, speedAfterKeys });
  check('locked speed: HUD/key speed changes refused', lock.hud === false && lock.key === false, lock);
  check('.wh-top-speed absent in versus', lock.speedGroup === false, lock);
  check('versus chip present, ≤ 150×46 at 800×360', !!lock.chip && lock.chip.w <= 150 && lock.chip.h <= 46, lock.chip);
  await shot(B, 'e2e5-versus-chip-800x360');
  // Settings in a match: Give up, no New zoo
  await B.page.evaluate(() => window.__game.ui.openZooPanel('settings'));
  await G.sleep(600);
  const settings = await B.page.evaluate(() => {
    const panel = [...document.querySelectorAll('.wh-zoo, .wh-panel, .wh-zoopanel, [class*="zoo"]')].find((e) => /Give up this match|Settings/.test(e.innerText ?? '') && e.getBoundingClientRect().width > 0);
    const txt = panel?.innerText ?? document.body.innerText;
    const newZoo = [...document.querySelectorAll('button, .wh-setting')].filter((e) => /New zoo/i.test(e.innerText ?? '') && e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none');
    return { giveUp: /Give up this match/.test(txt), newZoo: newZoo.length };
  });
  check('Settings in a match: "Give up this match" and no New zoo', settings.giveUp && settings.newZoo === 0, settings);
  await shot(B, 'e2e5-settings-in-match');
  await B.page.evaluate(() => window.__game.ui.handleBack());
  await G.sleep(300);
  // both play: skip match hours
  await skipTo(A, 12);
  await skipTo(B, 6);
  // hidden → visible: the countdown, and the clock frozen for 3 s
  // (hide, show and sample in one evaluate, so the 3 s are measured from the moment the app is back)
  const frozen = await B.page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const set = (h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const s = window.__game.sim;
    set(true);
    await wait(800);
    const t0 = s.time;
    set(false);
    const back = performance.now();
    await wait(100);
    const count = !!document.querySelector('.wh-vs-count');
    const t1 = s.time;
    await wait(2900 - (performance.now() - back));
    const t2 = s.time;
    const at = performance.now() - back;
    // then the clock runs again (a few slow SwiftShader frames may pass first)
    const until = performance.now() + 20_000;
    while (s.time === t2 && performance.now() < until) await wait(100);
    return { count, t0, t1, t2, t2At: Math.round(at), t3: s.time, runsAfterMs: Math.round(performance.now() - back) };
  });
  check('after hidden → visible the countdown shows', frozen.count, frozen);
  check('sim.time stays frozen for 3 s, then runs', frozen.t0 === frozen.t1 && frozen.t1 === frozen.t2 && frozen.t3 > frozen.t2, frozen);
  // B offline mid-match, then back: the outbox catches up
  await G.setOffline(B, true);
  await skipTo(B, 24);
  await G.sleep(1500);
  const pendingOff = await B.page.evaluate(() => window.__versusDebug.state().outbox.pending);
  check('B offline: snapshots wait in the outbox', pendingOff > 0, pendingOff);
  await G.setOffline(B, false);
  await B.page.evaluate(() => window.__cloud.versus.flush(window.__game.versus.matchId));
  await until(async () => (await B.page.evaluate(() => window.__versusDebug.state().outbox.pending)) === 0, 'B outbox empty', 60_000);
  check('B back online: the outbox catches up', true);
  // device binding: a third device of Ben's account cannot post for Ben's seat
  const C = (S.C = await G.phone(browser, 'C', { fakeSub: 'parent2' }));
  await G.open(C);
  await G.menu(C);
  await menuSignIn(C);
  await G.menu(C);
  const snap = { h: 30, day: 2, min: 510, parts: { v: 1, a: 1, s: 1, b: 0, m: 0, l: 0 }, total: 3, run: 0, cash: 100, guests: 0, visitors: 0, animals: 0, species: 0, habitats: 0, stars: 0 };
  const bound = await api(C, 'POST', `/v1/versus/matches/${S.match}/snapshots`, { profileId: S.ben, snapshots: [snap] });
  check('device binding: another device of the seat gets 409 other_device', bound.status === 409 && bound.body?.error?.code === 'other_device' || bound.body?.code === 'other_device', bound);
  // to the end on both: results with a crown
  await skipTo(A, 48);
  await skipTo(B, 48);
  await until(async () => (await seatsOf(A)).ended && (await seatsOf(B)).ended, 'both ended', 30_000);
  await G.sleep(1000);
  await shot(B, 'e2e5-times-up');
  for (const p of [A, B]) {
    await until(async () => {
      await p.page.evaluate(() => {
        window.__cloud.versus.flush(window.__game.versus.matchId);
        window.__game.versus.refresh();
      });
      return (await seatsOf(p)).result;
    }, `${p.name}: the result`, 90_000, 2000);
  }
  await G.sleep(1500);
  const crowns = await Promise.all([A, B].map((p) => p.page.evaluate(() => ({ crown: !!document.querySelector('.wh-vs-end .wh-vs-crown'), end: !!document.querySelector('.wh-vs-end'), text: document.querySelector('.wh-vs-end')?.innerText ?? '' }))));
  check('results with a crown on both phones', crowns.every((c) => c.end && c.crown), crowns);
  await shot(A, 'e2e5-results-crown-A');
  await shot(B, 'e2e5-results-crown-B-800x360');
  // deep scan of every captured versus response (api §8)
  const ids = new Set([S.mia, S.ben]);
  const accts = await Promise.all([A, B].map((p) => p.page.evaluate(() => JSON.parse(localStorage.getItem('wh2:auth') || 'null'))));
  for (const a of accts) {
    if (a?.accountId) ids.add(a.accountId);
    if (a?.email) ids.add(a.email);
  }
  let bad = [];
  let n = 0;
  for (const p of [A, B, C]) {
    for (const r of p.api.filter((x) => x.url.startsWith('/v1/versus') && x.body)) {
      n++;
      const { keys, strings } = deepScan(r.body);
      const k = [...keys].filter((x) => FORBIDDEN_KEYS.has(x));
      const s = [...strings].filter((x) => ids.has(x));
      if (k.length || s.length) bad.push({ phone: p.name, url: r.url, k, s });
    }
  }
  check(`deep scan of ${n} versus responses: no ids, emails or device names of anyone`, n > 5 && bad.length === 0, { n, bad: bad.slice(0, 5) });
}

async function e2e5b(browser) {
  current = 'E2E-5b';
  const A = S.A;
  // a family match for Mia vs Lea, played until the real-time budget runs out
  await g.toMenu(A);
  await G.menu(A);
  const m = await A.page.evaluate(async (mia) => {
    const lea = await window.__cloud.profiles.create('Lea', { animal: 'zebra', color: 3 });
    return window.__cloud.versus.create({ profileId: mia, lengthMin: 4, opponentProfileId: lea.id, rulesVersion: 1 });
  }, S.mia);
  check('family match created already joined', m.status === 'active' && m.kind === 'family', { status: m.status, kind: m.kind });
  await A.page.evaluate(({ mia, id }) => {
    sessionStorage.setItem('wildhaven-boot', JSON.stringify({ kind: 'versus', player: mia, slot: `vs-${id}`, matchId: id }));
  }, { mia: S.mia, id: m.id });
  await A.page.reload({ waitUntil: 'load' });
  await G.ready(A);
  await until(() => A.page.evaluate(() => !window.__game.versus.holding), 'Go!', 15_000, 200);
  const hour = await skipTo(A, 10);
  // record "Time's up!" as it shows (the end overlay turns into the score card a moment later)
  await A.page.evaluate(() => {
    window.__timesUp = null;
    const t = setInterval(() => {
      const txt = [...document.querySelectorAll('.wh-vs-end, .wh-vs-chip')].map((e) => e.innerText).join(' | ');
      if (/Time's up/i.test(txt)) {
        window.__timesUp = txt;
        clearInterval(t);
      }
    }, 50);
  });
  await A.page.evaluate((ms) => window.__versusDebug.addWallMs(ms), m.budgetMin * 60_000 + 1000);
  await until(async () => (await seatsOf(A)).ended, 'the budget end', 10_000, 200);
  const txt = await until(() => A.page.evaluate(() => window.__timesUp), '"Time\'s up!"', 10_000, 200).catch(() => null);
  await G.sleep(1200);
  const s = await seatsOf(A);
  check('"Time\'s up!" when the budget runs out', !!txt, txt);
  check('frozen at the last completed hour, endReason budget', s.endReason === 'budget' && s.hour === hour, { s, hour });
  await shot(A, 'e2e5b-budget-times-up');
  const seat = await until(async () => {
    await A.page.evaluate(() => window.__cloud.versus.flush(window.__game.versus.matchId));
    const r = await api(A, 'GET', `/v1/versus/matches/${m.id}?profileId=${S.mia}`);
    const me = r.body?.match?.players?.find((p) => p.isMe);
    return me?.endReason ? me : null;
  }, 'the finish on the server', 60_000, 1500);
  check("finish sent with endReason 'budget' at that hour", seat.endReason === 'budget' && seat.endHour === hour, seat);
}

// ------------------------------------------------------------------ main
async function main() {
  const browser = await G.launch();
  let failed = false;
  const run = async (id, fn) => {
    if (!want(id)) return;
    current = id;
    console.log(`[${secs()}s] ${id} …`);
    try {
      await fn(browser);
    } catch (e) {
      failed = true;
      check(`${id} ran to the end`, false, String(e?.stack ?? e).slice(0, 1500));
      for (const p of [S.A, S.B, S.B2, S.C].filter(Boolean)) await shot(p, `fail-${id}-${p.name}`).catch(() => {});
    }
  };
  try {
    if (!attach && want('E2E-6')) await run('E2E-6', e2e6);
    if (!attach) {
      st.buildServer();
      const google = await st.startFakeGoogle();
      const apiProc = await st.startApi(google);
      dbPath = apiProc.dbPath;
      await st.startVite({ cloud: true, cacheDir: CACHE });
    } else {
      dbPath = opt('db', null);
    }
    await run('E2E-1', e2e1);
    await run('E2E-3', e2e3);
    await run('E2E-2', e2e2);
    await run('E2E-3b', e2e3b);
    await run('E2E-4', e2e4);
    await run('E2E-7', e2e7);
    await run('E2E-5', e2e5);
    await run('E2E-5b', e2e5b);
    for (const p of [S.A, S.B, S.B2, S.C].filter(Boolean)) {
      const errs = p.errors.filter((e) => !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|status of 40[19]|status of 41[02]/.test(e));
      current = 'all';
      check(`${p.name}: no page errors`, errs.length === 0, errs.slice(0, 8));
    }
  } finally {
    await browser.close().catch(() => {});
    if (!attach) await st.stopAll();
  }
  const fails = results.filter((r) => !r.ok);
  writeFileSync(join(OUT, 'e2e-report.json'), JSON.stringify({ at: new Date().toISOString(), seconds: Number(secs()), results, shots }, null, 1));
  console.log(`\n${fails.length || failed ? 'FAILED' : 'OK'}: ${results.length - fails.length}/${results.length} checks passed in ${secs()}s`);
  for (const id of ['E2E-1', 'E2E-2', 'E2E-3', 'E2E-3b', 'E2E-4', 'E2E-5', 'E2E-5b', 'E2E-6', 'E2E-7']) {
    const rs = results.filter((r) => r.scenario === id);
    if (rs.length) console.log(`  ${id}: ${rs.every((r) => r.ok) ? 'PASS' : 'FAIL'} (${rs.filter((r) => r.ok).length}/${rs.length})`);
  }
  process.exitCode = fails.length || failed ? 1 : 0;
}

process.on('SIGINT', () => void st.stopAll().then(() => process.exit(130)));
process.on('SIGTERM', () => void st.stopAll().then(() => process.exit(143)));
main().catch(async (e) => {
  console.error(e);
  await st.stopAll();
  process.exit(1);
});
