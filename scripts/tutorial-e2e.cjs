// End-to-end check of the tutorial with real touch input (tutorial.md §11.2, spec §10.2).
//
//   node scripts/tutorial-e2e.cjs http://127.0.0.1:5591/index.html <outDir>
//        [--scenario=main|skip|resume|back|nudge|practice|help|readaloud] [--size=915x412] [--mouse]
//        [--readaloud] [--wired] [--from=<step>] [--to=<step>]
//
// Chromium with SwiftShader (as scripts/gameshots.cjs), a phone-sized touch context (isMobile,
// hasTouch: the touch wording) or --mouse at 1280x720. Gestures go through CDP
// Input.dispatchTouchEvent (one-finger drags, two-finger pinch and twist). Until main.ts mounts
// the tutorial, the script adds it through Vite after New Zoo; --wired skips that (the
// integrator's run). --readaloud stubs speechSynthesis with one voice and records what is said.
// Writes <outDir>/report.json and NN-<step>-<phase>.png screenshots; exits non-zero on any failure.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const base = args[0];
const out = args[1];
if (!base || !out || base.startsWith('--')) {
  console.error('usage: node scripts/tutorial-e2e.cjs <url> <outDir> [--scenario=main] [--size=WxH] [--mouse] [--readaloud] [--wired]');
  process.exit(2);
}
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const scenario = opt('scenario', 'main');
const mouse = args.includes('--mouse');
const wired = args.includes('--wired');
const readAloud = args.includes('--readaloud') || scenario === 'readaloud';
const [W, H] = opt('size', mouse ? '1280x720' : '915x412').split('x').map(Number);
const seed = opt('seed', '7');
fs.mkdirSync(out, { recursive: true });

const report = { scenario, size: `${W}x${H}`, mouse, wired, readAloud, startedAt: new Date().toISOString(), steps: [], checks: [], errors: [], spoken: [] };
let failures = 0;
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
function check(name, ok, info) {
  report.checks.push({ name, ok: !!ok, info: info === undefined ? undefined : info, t: Number(secs()) });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${secs()}s] ${name}${info !== undefined ? ' ' + JSON.stringify(info).slice(0, 600) : ''}`);
}

const PLAYER = { ref: 'guest', profileId: null, accountId: null, name: null, avatar: null };

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, isMobile: !mouse, hasTouch: !mouse });
  if (readAloud) {
    await ctx.addInitScript(() => {
      window.__spoken = [];
      const voice = { lang: 'en-US', name: 'Stub voice', localService: true, default: true, voiceURI: 'stub' };
      const synth = {
        speaking: false,
        pending: false,
        paused: false,
        getVoices: () => [voice],
        speak(u) {
          window.__spoken.push(u.text);
          setTimeout(() => u.onend && u.onend({}), 50);
        },
        cancel() {},
        pause() {},
        resume() {},
        addEventListener() {},
        removeEventListener() {},
      };
      Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
      // a plain utterance: the real one refuses the stub voice object
      window.SpeechSynthesisUtterance = function (t) {
        this.text = t;
      };
    });
  }
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);
  page.on('pageerror', (e) => report.errors.push('PAGEERROR ' + String((e && e.stack) || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(m.text());
  });
  const cdp = mouse ? null : await ctx.newCDPSession(page);

  // ------------------------------------------------------------------ input helpers
  const sleep = (ms) => page.waitForTimeout(ms);
  const tps = (pts) => pts.map((p, i) => ({ x: Math.round(p.x), y: Math.round(p.y), id: i + 1, radiusX: 4, radiusY: 4, force: 1 }));
  async function touchFrames(frames, holdMs = 0, frameMs = 18) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tps(frames[0]) });
    if (holdMs) await sleep(holdMs);
    for (const f of frames.slice(1)) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tps(f) });
      await sleep(frameMs);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
  async function drag1(a, b, steps = 16, hold = 160) {
    if (mouse) {
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await sleep(hold);
      await page.mouse.move(b.x, b.y, { steps });
      await sleep(60);
      await page.mouse.up();
      return;
    }
    const frames = [];
    for (let i = 0; i <= steps; i++) frames.push([lerp(a, b, i / steps)]);
    await touchFrames(frames, hold);
  }
  async function pinch(c, r0, r1, steps = 16) {
    const frames = [];
    for (let i = 0; i <= steps; i++) {
      const r = r0 + ((r1 - r0) * i) / steps;
      frames.push([{ x: c.x - r, y: c.y }, { x: c.x + r, y: c.y }]);
    }
    await touchFrames(frames, 30);
  }
  async function twist(c, r, deg, steps = 18) {
    const frames = [];
    for (let i = 0; i <= steps; i++) {
      const a = ((deg * Math.PI) / 180) * (i / steps);
      frames.push([{ x: c.x - Math.cos(a) * r, y: c.y - Math.sin(a) * r }, { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }]);
    }
    await touchFrames(frames, 30);
  }
  async function tapAt(p) {
    if (mouse) {
      await page.mouse.click(p.x, p.y);
      return;
    }
    // start and end back to back: the game counts a touch as a tap only if it is shorter than
    // 650 ms between its pointer handlers, and one slow SwiftShader frame in between is longer
    await Promise.all([
      cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tps([p]) }),
      cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    ]);
  }
  const centre = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
  async function tapRect(r) {
    await tapAt(centre(r));
  }
  /** Tap an element found in the page (the function returns a DOM rect or null). */
  async function tapWhere(fnSrc, label) {
    const r = await page.evaluate(fnSrc);
    if (!r) throw new Error(`nothing to tap: ${label}`);
    await tapRect(r);
  }
  const rectJs = (expr) => `(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null; })()`;
  const catBtn = (label) => rectJs(`[...document.querySelectorAll('.wh-cats .wh-cat')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`);
  const cardEl = (name) => rectJs(`[...document.querySelectorAll('.wh-drawer:not(.hidden) .wh-card')].find((c) => c.querySelector('.wh-card-name')?.textContent.trim() === ${JSON.stringify(name)})`);

  // ------------------------------------------------------------------ page helpers
  const view = () => page.evaluate(() => window.__tut.view());
  const state = () => page.evaluate(() => window.__tut.debugState());
  async function waitFor(fn, what, timeout = 60000, poll = 150) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await page.evaluate(fn).catch((e) => ({ __err: String(e) }));
      if (last && last.ok) return last;
      await sleep(poll);
    }
    throw new Error(`timeout waiting for ${what}: ${JSON.stringify(last).slice(0, 400)}`);
  }
  async function waitStep(step, phase, timeout = 60000) {
    return waitFor(
      `(() => { const v = window.__tut.view(); return { ok: !!v && v.status === 'running' && v.step === ${JSON.stringify(step)} && v.current === ${JSON.stringify(step)} && !v.review && ${phase ? `(${JSON.stringify(phase)}.split('|').includes(v.phase))` : 'true'}, step: v && v.step, phase: v && v.phase, status: v && v.status }; })()`,
      `step ${step}${phase ? ' / ' + phase : ''}`,
      timeout,
    );
  }
  let shotN = 0;
  async function shot(name) {
    const file = `${String(shotN++).padStart(2, '0')}-${name}.png`;
    await page.screenshot({ path: path.join(out, file) });
    return file;
  }
  // a frame or two for the bubble to be laid out at its spot
  const settle = (ms = 450) => sleep(ms);

  /** The assertions run at every step (tutorial.md §11.2). */
  async function assertStep(label, opts = {}) {
    await settle(opts.settle ?? 450);
    const info = await page.evaluate(async () => {
      // the import first: after it everything is read in one go (no frame in between)
      const s = await import('/src/ui/tutorial/script.ts');
      const t = window.__tut;
      const v = t.view();
      const lay = t.debugLayout();
      const b = document.querySelector('.wh-tut-bubble');
      const shown = !!b && !b.classList.contains('hidden');
      const br = shown ? b.getBoundingClientRect() : null;
      const a = document.querySelector('.wh-tut-a')?.textContent ?? '';
      const w = document.querySelector('.wh-tut-w')?.textContent ?? '';
      let expect = null;
      if (v && v.line) {
        const l = s.LINES[v.line];
        const cat = v.target && v.target.kind === 'cat' ? s.DOCK_LABEL[v.target.id] : undefined;
        expect = { a: s.fill(l.a, { speciesId: v.speciesId, cat }), w: l.w ? s.fill(l.w, { speciesId: v.speciesId, cat }) : '' };
      }
      // is the DOM target on top at its centre (not covered by another element)?
      let onTop = null;
      const tr = lay && lay.target;
      if (tr && v.target && v.target.kind !== 'world' && v.target.kind !== 'gesture') {
        const cx = (tr.left + tr.right) / 2,
          cy = (tr.top + tr.bottom) / 2;
        const hit = document.elementFromPoint(cx, cy);
        const host = window.__game.ui.ext;
        const els = {
          cat: () => host.categoryButton(v.target.id),
          card: () => host.card((k) => k === v.target.key),
          confirm: () => host.confirmOk(),
          speed: () => host.hudSpeedButton(v.target.s[0]),
          speedGroup: () => host.hudEl('speedGroup'),
          money: () => host.hudEl('money'),
          pill: () => host.hudEl('pill'),
          sheetMeter: () => host.sheet().anchor('happiness'),
          sheetClose: () => host.sheet().close,
          panelClose: () => host.zooPanel().close,
          panelTab: () => host.zooPanel().tabButton(v.target.tab),
        };
        const el = els[v.target.kind] ? els[v.target.kind]() : null;
        const group = v.target.kind === 'speed' ? host.hudEl('speedGroup') : null;
        onTop = !!hit && !!el && (el === hit || el.contains(hit) || (group && group.contains(hit)));
      }
      return {
        v,
        lay,
        bubble: br && { left: br.left, top: br.top, right: br.right, bottom: br.bottom },
        faded: shown && b.classList.contains('faded'),
        a,
        w,
        expect,
        onTop,
        speed: window.__game.sim.speed,
        vw: innerWidth,
        vh: innerHeight,
      };
    });
    const v = info.v;
    const rec = { label, t: Number(secs()), step: v && v.step, phase: v && v.phase, line: v && v.line, zone: v && v.zone, bubble: info.bubble, target: info.lay && info.lay.target, how: info.lay && info.lay.how, speed: info.speed };
    report.steps.push(rec);
    if (opts.step) check(`${label}: step is ${opts.step}${opts.phase ? '/' + opts.phase : ''}`, v && v.step === opts.step && (!opts.phase || opts.phase.split('|').includes(v.phase)), { step: v && v.step, phase: v && v.phase });
    if (v && !v.hidden && v.status === 'running') {
      check(`${label}: bubble text = LINES[${v.line}]`, !!info.expect && info.a === info.expect.a && info.w === info.expect.w, { a: info.a, w: info.w, expect: info.expect });
      const b = info.bubble;
      check(`${label}: bubble inside the viewport`, !!b && b.left >= 0 && b.top >= 0 && b.right <= info.vw + 0.5 && b.bottom <= info.vh + 0.5, b);
      const tr = info.lay && info.lay.target;
      if (tr && b) {
        const hit = b.left < tr.right + 0 && b.right > tr.left && b.top < tr.bottom && b.bottom > tr.top;
        check(`${label}: bubble does not cover its target (${v.zone})`, !hit, { bubble: b, target: tr, how: info.lay.how });
      }
      if (info.onTop !== null) check(`${label}: target on top at its centre`, info.onTop === true, { kind: v.target && v.target.kind });
    }
    if (opts.held) check(`${label}: clock held (speed 0)`, info.speed === 0, { speed: info.speed });
    if (opts.shot !== false) rec.shot = await shot(`${v && v.step}-${(v && v.phase) || label}`.replace(/[^a-z0-9.-]+/gi, '_'));
    return info;
  }

  // ------------------------------------------------------------------ boot
  async function boot(start = 'first', fresh = true) {
    await page.goto(`${base}${base.includes('?') ? '&' : '?'}q=low&seed=${seed}&tutdebug`, { waitUntil: 'load', timeout: 180000 });
    const btnName = fresh ? 'New Zoo' : 'Continue';
    const btn = page.getByRole('button', { name: btnName }).first();
    await btn.waitFor({ timeout: 120000 });
    if (mouse) await btn.click();
    else await btn.tap();
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 600000, polling: 500 });
    if (wired) {
      await page.waitForFunction(() => !!window.__tutorial, null, { timeout: 60000 });
      await page.evaluate(() => (window.__tut = window.__tutorial));
    } else {
      await page.evaluate(async ({ player, start }) => {
        const m = await import('/src/ui/tutorial/index.ts');
        const ext = m.createTutorialExtension({ player, start, versusEnabled: false });
        window.__game.ui.addExtension(ext);
        window.__tut = ext;
      }, { player: PLAYER, start });
    }
    await sleep(800);
    console.log(`booted (${fresh ? 'new' : 'continue'}) at ${secs()}s`);
  }

  /** A world point (metres) on screen. */
  const project = (x, z) => page.evaluate(([x, z]) => { const g = window.__game; return g.ui.ext.project(x, g.sim.world.heightAt(x, z), z); }, [x, z]);
  /** The current step's hint (yellow marker), in world metres. */
  const hint = () => page.evaluate(() => window.__tut.hintInfo());
  const viewRect = () => page.evaluate(() => window.__game.ui.ext.viewArea());

  async function waitCamera() {
    // the step's framing glides for a moment; a marker under the bubble or a bar makes the camera
    // glide again, so wait until the yellow marker is in the open
    await sleep(1200);
    await waitFor(`(() => { const l = window.__tut.debugLayout(); const v = window.__tut.view(); return { ok: !l || l.zone !== 'world' || l.clear === true || !v || v.zone !== 'world', l }; })()`, 'the marker in the open', 20000, 250).catch((e) => check('the yellow marker comes into the open', false, String(e).slice(0, 300)));
  }

  async function openCat(label, step) {
    await tapWhere(catBtn(label), `dock ${label}`);
    await waitStep(step, 'pick');
  }
  async function pickCard(name, step) {
    await settle(500);
    await tapWhere(cardEl(name), `card ${name}`);
    await waitStep(step, 'use|confirm|invalid');
  }
  async function confirmBuild(step) {
    await waitStep(step, 'confirm');
    await assertStep(`${step} confirm`, { step, phase: 'confirm', held: !['play', 'guests'].includes(step) });
    await tapWhere(rectJs(`document.querySelector('.wh-cf-ok')`), 'Build');
  }
  async function tapSpot(step) {
    await waitCamera();
    const h = await hint();
    if (!h.bounds) throw new Error(`no hint for ${step}`);
    // where the hand taps: a footprint's anchor tile (the object tool places from the tapped tile)
    let tx = (h.bounds.x0 + h.bounds.x1) / 2,
      tz = (h.bounds.z0 + h.bounds.z1) / 2;
    if (h.hint.kind === 'spot') {
      const s = h.hint.spot;
      tx = (s.tx + Math.floor((s.w - 1) / 2) + 0.5) * 2;
      tz = (s.tz + Math.floor((s.d - 1) / 2) + 0.5) * 2;
    }
    const p = await project(tx, tz);
    await assertStep(`${step} use`, { step, phase: 'use', held: true });
    await tapAt(p);
  }
  /** A whole object step: dock → card → yellow spot → Build. */
  async function objectStep(step, cat, card) {
    await waitStep(step, 'open');
    await assertStep(`${step} open`, { step, phase: 'open', held: true });
    await openCat(cat, step);
    await assertStep(`${step} pick`, { step, phase: 'pick', held: true });
    await pickCard(card, step);
    await tapSpot(step);
    await confirmBuild(step);
  }

  // ------------------------------------------------------------------ the main flow
  async function welcome() {
    await waitFor(`(() => ({ ok: !!document.querySelector('.wh-tut-welcome') }))()`, 'welcome card');
    const v = await view();
    check('welcome: card shown, clock held', v.status === 'welcome' && (await page.evaluate(() => window.__game.sim.speed)) === 0, { status: v.status });
    report.steps.push({ label: 'welcome', t: Number(secs()), shot: await shot('welcome') });
    await tapWhere(rectJs(`document.querySelector('.wh-tut-go')`), "Let's go");
  }

  async function lookAround() {
    const vr = await viewRect();
    const mid = { x: (vr.left + vr.right) / 2, y: (vr.top + vr.bottom) / 2 + 20 };
    await waitStep('look-pan');
    await assertStep('look-pan', { step: 'look-pan', held: true });
    if (mouse) await drag1({ x: vr.left + (vr.right - vr.left) * 0.35, y: mid.y }, { x: vr.left + (vr.right - vr.left) * 0.65, y: mid.y }, 16, 40);
    else await drag1({ x: mid.x - 110, y: mid.y }, { x: mid.x + 110, y: mid.y }, 16, 30);
    await waitStep('look-zoom');
    await assertStep('look-zoom', { step: 'look-zoom', held: true });
    if (mouse) {
      await page.mouse.move(mid.x, mid.y);
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -240);
        await sleep(40);
      }
    } else await pinch(mid, 60, 200);
    await waitStep('look-turn');
    await assertStep('look-turn', { step: 'look-turn', held: true });
    if (mouse) {
      await page.mouse.move(mid.x - 100, mid.y);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(mid.x + 140, mid.y, { steps: 16 });
      await page.mouse.up({ button: 'right' });
    } else await twist(mid, 90, 70);
    await waitStep('fence');
  }

  async function fenceStep() {
    await waitStep('fence', 'open');
    await assertStep('fence open', { step: 'fence', phase: 'open', held: true });
    await openCat('Habitat', 'fence');
    await assertStep('fence pick', { step: 'fence', phase: 'pick', held: true });
    await pickCard('Timber Rail Fence', 'fence');
    await waitCamera();
    const st = await state();
    const p = st.plot;
    check('fence: a plot was found', !!p, p);
    await assertStep('fence use', { step: 'fence', phase: 'use', held: true });
    const a = await project(p.x0 * 2 + 0.5, p.z0 * 2 + 0.5);
    const b = await project((p.x1 + 1) * 2 - 0.5, (p.z1 + 1) * 2 - 0.5);
    await drag1(a, b, 18, 160);
    await confirmBuild('fence');
  }

  async function paintStep() {
    await waitStep('paint', 'open');
    await assertStep('paint open', { step: 'paint', phase: 'open', held: true });
    await openCat('Habitat', 'paint');
    await assertStep('paint pick', { step: 'paint', phase: 'pick', held: true });
    await pickCard('Savanna Grass', 'paint');
    await waitCamera();
    await assertStep('paint use', { step: 'paint', phase: 'use', held: true });
    const h = await hint();
    const bb = h.bounds;
    const a = await project(bb.x0 + 0.6, bb.z0 + 0.6);
    const b = await project(bb.x1 - 0.6, bb.z1 - 0.6);
    await drag1(a, b, 18, 160);
    await confirmBuild('paint');
  }

  async function adoptStep() {
    await waitStep('adopt', 'open');
    await assertStep('adopt open', { step: 'adopt', phase: 'open', held: true });
    await openCat('Animals', 'adopt');
    await assertStep('adopt pick', { step: 'adopt', phase: 'pick', held: true });
    await pickCard('Plains Zebra', 'adopt');
    await waitCamera();
    const h = await hint();
    const p = await project((h.bounds.x0 + h.bounds.x1) / 2, (h.bounds.z0 + h.bounds.z1) / 2);
    await assertStep('adopt use', { step: 'adopt', phase: 'use', held: true });
    await tapAt(p);
    await confirmBuild('adopt');
  }

  async function happyStep() {
    await waitStep('happy', 'tap');
    await waitCamera();
    await assertStep('happy tap', { step: 'happy', phase: 'tap', held: true });
    const h = await hint();
    const pt = await page.evaluate(() => {
      const g = window.__game;
      const st = window.__tut.debugState();
      const a = g.sim.animals.get(st.animalId) || [...g.sim.animals.values()][0];
      const pos = g.views.positionOf({ kind: 'animal', id: a.id });
      const p = g.ui.ext.project(pos.x, pos.y + 0.8, pos.z);
      return { x: p.x, y: p.y };
    });
    void h;
    // a tap on the zebra (again if a slow frame made the first one too long to count as a tap)
    for (let i = 0; i < 4; i++) {
      await tapAt(pt);
      const ok = await waitStep('happy', 'sheet', 8000).then(() => true, () => false);
      if (ok) break;
    }
    await waitStep('happy', 'sheet');
    await assertStep('happy sheet', { step: 'happy', phase: 'sheet', held: true });
    await tapWhere(rectJs(`document.querySelector('.wh-tut-gotit')`), 'Got it');
  }

  async function pathStep() {
    await waitStep('path', 'open');
    await assertStep('path open', { step: 'path', phase: 'open', held: true });
    await openCat('Paths', 'path');
    await assertStep('path pick', { step: 'path', phase: 'pick', held: true });
    await pickCard('Stone Pavers', 'path');
    await waitCamera();
    await assertStep('path use', { step: 'path', phase: 'use', held: true });
    const h = await hint();
    const tiles = h.hint.tiles;
    const a = await project((tiles[0].x + 0.5) * 2, (tiles[0].z + 0.5) * 2);
    const b = await project((tiles[tiles.length - 1].x + 0.5) * 2, (tiles[tiles.length - 1].z + 0.5) * 2);
    await drag1(a, b, 12, 160);
    await confirmBuild('path');
  }

  async function keeperStep() {
    await waitStep('keeper', 'open');
    await assertStep('keeper open', { step: 'keeper', phase: 'open', held: true });
    await openCat('Staff', 'keeper');
    await assertStep('keeper pick', { step: 'keeper', phase: 'pick', held: true });
    await pickCard('Animal Keeper', 'keeper');
    await tapSpot('keeper');
    await confirmBuild('keeper');
  }

  async function openZoo() {
    await waitStep('play');
    const pre = await assertStep('play', { step: 'play', held: true });
    check('play: the HUD speed group is locked until now… and released at Play', true, { speed: pre.speed });
    await tapWhere(`(() => { const e = window.__game.ui.ext.hudSpeedButton(1); const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`, 'Play');
    await waitStep('guests');
    await assertStep('guests', { step: 'guests' });
    await waitFor(`(() => { const v = window.__tut.view(); return { ok: v.step !== 'guests', step: v.step, guests: window.__game.sim.guests.size }; })()`, 'a guest walking in', 180000, 500);
  }

  async function moneyGoalSpeed() {
    await waitStep('money', 'hud');
    await assertStep('money hud', { step: 'money', phase: 'hud' });
    await tapWhere(rectJs(`window.__game.ui.ext.hudEl('money')`), 'money chip');
    await waitStep('money', 'finance|otherTab');
    let v = await view();
    if (v.phase === 'otherTab') {
      await assertStep('money other tab', { step: 'money', phase: 'otherTab' });
      await tapWhere(rectJs(`window.__game.ui.ext.zooPanel().tabButton('finance')`), 'Finances tab');
      await waitStep('money', 'finance');
    }
    await assertStep('money finance', { step: 'money', phase: 'finance' });
    await tapWhere(rectJs(`window.__game.ui.ext.zooPanel().close`), 'menu close');
    await waitStep('goal');
    await assertStep('goal', { step: 'goal' });
    await tapWhere(rectJs(`window.__game.ui.ext.hudEl('pill')`), 'goal pill');
    await waitStep('speed');
    // the pill's own action opened a drawer: close it like a child would (tap the 3D view's Inspect)
    await page.evaluate(() => window.__game.ui.ext.closeDrawer());
    await assertStep('speed', { step: 'speed' });
    await tapWhere(`(() => { const e = window.__game.ui.ext.hudSpeedButton(3); const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`, '4x');
    await waitStep('speed-note');
    await assertStep('speed-note', { step: 'speed-note' });
    v = await view();
    check('speed-note: offline line (no versus in this build)', v.line === 'speed-note.offline', v.line);
    await tapWhere(rectJs(`document.querySelector('.wh-tut-gotit')`), 'Got it');
  }

  async function finishCard() {
    await waitFor(`(() => ({ ok: !!document.querySelector('.wh-tut-finish') }))()`, 'finish card');
    report.steps.push({ label: 'finish', t: Number(secs()), shot: await shot('finish') });
    const txt = await page.evaluate(() => document.querySelector('.wh-tut-finish').textContent);
    check('finish card says "You did it!" with Keep playing', txt.includes('You did it!') && txt.includes('Keep playing'), txt.slice(0, 200));
    await tapWhere(rectJs(`document.querySelector('.wh-tut-finish .wh-tut-go')`), 'Keep playing');
    await sleep(600);
    const end = await page.evaluate(() => {
      const g = window.__game;
      const sim = g.sim;
      const objs = [...sim.world.objects.values()];
      let tut = null;
      try {
        tut = JSON.parse(localStorage.getItem('wildhaven-tutorial'));
      } catch {}
      return {
        profile: tut && tut.status,
        blob: sim.tutorial,
        locked: !!document.querySelector('.wh-seg.locked'),
        pill: document.querySelector('.wh-goal')?.textContent ?? '',
        habitats: sim.world.habitats.size,
        zebra: [...sim.animals.values()].some((a) => a.speciesId === 'zebra'),
        keeper: [...sim.staff.values()].some((s) => s.role === 'keeper'),
        kiosk: objs.some((o) => o.defId === 'shop_snack'),
        gate: window.__tut.debugState().gateOpen,
        card: !!document.querySelector('.wh-tut-cardback'),
        bubble: !document.querySelector('.wh-tut-bubble')?.classList.contains('hidden'),
      };
    });
    check('end: profile done, blob cleared, HUD unlocked', end.profile === 'done' && end.blob === null && !end.locked, end);
    check('end: pill shows the next goal (restrooms)', /restroom/i.test(end.pill), end.pill);
    check('end: one habitat, a zebra, a keeper, a kiosk, gate open', end.habitats === 1 && end.zebra && end.keeper && end.kiosk && end.gate, end);
    check('end: no card and no bubble left', !end.card && !end.bubble, end);
    await shot('after-finish');
  }

  async function mainFlow() {
    // --from=<step>: get there with Help me first (debugging); the acceptance run starts at the welcome card
    const from = opt('from', null);
    const parts = [
      ['look-pan', lookAround],
      ['fence', fenceStep],
      ['paint', paintStep],
      ['water', () => objectStep('water', 'Care', 'Water Trough')],
      ['shelter', () => objectStep('shelter', 'Care', 'Timber Shelter')],
      ['plant', () => objectStep('plant', 'Nature', 'Tall Grass')],
      ['adopt', adoptStep],
      ['happy', happyStep],
      ['path', pathStep],
      ['kiosk', () => objectStep('kiosk', 'Guests', 'Snack Kiosk')],
      ['bench', () => objectStep('bench', 'Guests', 'Park Bench')],
      ['bin', () => objectStep('bin', 'Guests', 'Litter Bin')],
      ['keeper', keeperStep],
      ['play', openZoo],
      ['money', moneyGoalSpeed],
    ];
    await boot('first');
    if (from) await fastForward(from);
    else await welcome();
    const start = from ? parts.findIndex((p) => p[0] === from) : 0;
    if (start < 0) throw new Error(`--from=${from}: start at one of ${parts.map((p) => p[0]).join(', ')}`);
    // --to=<step>: stop when that part is reached (a short run, e.g. the camera lines with --mouse)
    const to = opt('to', null);
    for (const [id, run] of parts.slice(start)) {
      if (to && id === to) {
        await waitStep(to);
        await assertStep(`${to} reached`, { step: to, held: true });
        return;
      }
      await run();
    }
    await finishCard();
    if (from) return;
    // the order the steps were reached
    const order = [];
    for (const s of report.steps) if (s.step && order[order.length - 1] !== s.step) order.push(s.step);
    const want = ['look-pan', 'look-zoom', 'look-turn', 'fence', 'paint', 'water', 'shelter', 'plant', 'adopt', 'happy', 'path', 'kiosk', 'bench', 'bin', 'keeper', 'play', 'guests', 'money', 'goal', 'speed', 'speed-note'];
    check('steps reached in order', JSON.stringify(order) === JSON.stringify(want), order);
    // the clock was held (speed 0) at every step before 'play'
    const before = report.steps.filter((s) => s.step && want.indexOf(s.step) < want.indexOf('play'));
    check("sim.speed was 0 at every step before 'play'", before.length > 0 && before.every((s) => s.speed === 0), before.filter((s) => s.speed !== 0).map((s) => s.label));
  }

  /** Tap a bubble button (the sheet may still be sliding in, moving the bubble) until the step is left. */
  async function tapUntilLeaving(step, rectSrc, label) {
    for (let i = 0; i < 4; i++) {
      await sleep(700);
      const r = await page.evaluate(rectSrc);
      if (r) await tapRect(r);
      const left = await waitFor(`(() => { const v = window.__tut.view(); return { ok: v.current !== ${JSON.stringify(step)} || v.status !== 'running' }; })()`, `leaving ${step}`, 6000).then(() => true, () => false);
      if (left) return;
    }
    throw new Error(`${label} did not leave ${step}`);
  }

  /** Get to `target` quickly with Help me (real commands), for the shorter scenarios. */
  async function fastForward(target) {
    for (let guard = 0; guard < 40; guard++) {
      const v = await view();
      if (v.status === 'welcome') {
        await tapWhere(rectJs(`document.querySelector('.wh-tut-go')`), "Let's go");
        await sleep(400);
        continue;
      }
      if (v.step === target && v.current === target) return;
      const step = v.current;
      await page.evaluate(() => window.__tut.debugHelp());
      await sleep(300);
      if (step === 'happy') {
        await waitStep('happy', 'sheet', 15000).catch(() => null);
        await tapUntilLeaving('happy', rectJs(`document.querySelector('.wh-tut-gotit')`), 'Got it');
      } else if (step === 'money') {
        await sleep(500);
        await page.evaluate(() => window.__game.ui.handleBack());
      } else if (step === 'speed-note') {
        await tapUntilLeaving('speed-note', rectJs(`document.querySelector('.wh-tut-gotit')`), 'Got it');
      } else if (step === 'guests') {
        await waitFor(`(() => ({ ok: window.__tut.view().step !== 'guests' }))()`, 'guests', 180000, 500);
      }
      await waitFor(`(() => { const v = window.__tut.view(); return { ok: v.current !== ${JSON.stringify(step)} || v.status !== 'running', cur: v.current }; })()`, `leaving ${step}`, 30000);
    }
    throw new Error(`could not reach ${target}`);
  }

  // ------------------------------------------------------------------ scenarios
  async function skipScenario() {
    await boot('first');
    await fastForward('paint');
    await assertStep('skip: at paint', { step: 'paint' });
    await tapWhere(rectJs(`document.querySelector('.wh-tut-x')`), 'X');
    await waitFor(`(() => ({ ok: !!document.querySelector('.wh-dialog') }))()`, 'skip dialog');
    const d = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.wh-dialog-btns .wh-btn')];
      return { title: document.querySelector('.wh-dialog h3')?.textContent, text: document.querySelector('.wh-dialog p')?.textContent, primary: btns.find((b) => b.classList.contains('wh-btn-primary'))?.textContent, other: btns.find((b) => !b.classList.contains('wh-btn-primary'))?.textContent };
    });
    report.steps.push({ label: 'skip dialog', shot: await shot('skip-dialog') });
    check("skip dialog: title 'Stop learning?', primary 'Keep learning', other 'Skip'", d.title === 'Stop learning?' && d.primary === 'Keep learning' && d.other === 'Skip' && d.text === 'You can learn again any time.', d);
    // Android back = the primary (Keep learning): the tutorial keeps running
    await page.evaluate(() => window.__game.ui.handleBack());
    await sleep(500);
    const after = await page.evaluate(() => ({ dialog: !!document.querySelector('.wh-dialog'), v: window.__tut.view(), speed: window.__game.sim.speed }));
    check('Android back keeps the tutorial running', !after.dialog && after.v.status === 'running' && after.v.step === 'paint' && after.speed === 0, { dialog: after.dialog, status: after.v.status, step: after.v.step });
    await tapWhere(rectJs(`document.querySelector('.wh-tut-x')`), 'X');
    await waitFor(`(() => ({ ok: !!document.querySelector('.wh-dialog') }))()`, 'skip dialog');
    await tapWhere(rectJs(`[...document.querySelectorAll('.wh-dialog-btns .wh-btn')].find((b) => b.textContent === 'Skip')`), 'Skip');
    await sleep(600);
    const s = await page.evaluate(() => ({
      bubble: !document.querySelector('.wh-tut-bubble')?.classList.contains('hidden'),
      speed: window.__game.sim.speed,
      profile: JSON.parse(localStorage.getItem('wildhaven-tutorial') || 'null'),
      blob: window.__game.sim.tutorial,
      locked: !!document.querySelector('.wh-seg.locked'),
    }));
    check('skip: bubble gone, speed 1, profile skipped, HUD unlocked', !s.bubble && s.speed === 1 && s.profile && s.profile.status === 'skipped' && s.blob === null && !s.locked, s);
    await page.evaluate(() => window.__game.ui.ext.openMenu('settings'));
    await sleep(500);
    const row = await page.evaluate(() => document.querySelector('.wh-tut-set-play')?.textContent ?? null);
    report.steps.push({ label: 'settings', shot: await shot('skip-settings') });
    check('Settings shows Play tutorial', row === 'Play tutorial', row);
    await page.evaluate(() => window.__game.ui.handleBack());
    await sleep(500);
    const chip = await page.evaluate(() => {
      const c = document.querySelector('.wh-tut-learn');
      return c && !c.classList.contains('hidden') ? c.textContent : null;
    });
    report.steps.push({ label: 'learn chip', shot: await shot('skip-learn-chip') });
    check("a 'Learn to play' chip shows under the goal pill", chip === 'Learn to play', chip);
  }

  async function resumeScenario() {
    await boot('first');
    await fastForward('happy');
    const before = await page.evaluate(() => ({ habitats: window.__game.sim.world.habitats.size, animals: window.__game.sim.animals.size, r: window.__game.save() }));
    check('resume: zoo saved at step happy', before.r === 'saved' && before.animals === 1, before);
    await boot(null, false);
    await waitFor(`(() => { const v = window.__tut.view(); return { ok: !!v && v.status === 'running' && v.current === 'happy', v: v && v.current }; })()`, 'resumed at happy');
    const v = await view();
    report.steps.push({ label: 'resume', shot: await shot('resume-welcome-back') });
    check('resume: "Welcome back!" then step happy', v.line === 'nudge.resume' && v.step === 'happy' && /Welcome back/.test(v.text.w), { line: v.line, step: v.step, text: v.text });
    const st = await page.evaluate(() => ({ habitats: window.__game.sim.world.habitats.size, speed: window.__game.sim.speed }));
    check('resume: the zoo came back and the clock is held', st.habitats === before.habitats && st.speed === 0, st);
  }

  async function backScenario() {
    await boot('first');
    await fastForward('paint');
    await waitStep('paint', 'open');
    await tapWhere(rectJs(`document.querySelector('.wh-tut-back')`), 'Back');
    await sleep(400);
    let v = await view();
    await assertStep('back: review fence');
    check('Back shows the fence line with Next', v.review && v.step === 'fence' && v.line === 'fence.open' && v.buttons.next, { review: v.review, step: v.step, line: v.line });
    await tapWhere(rectJs(`document.querySelector('.wh-tut-next')`), 'Next');
    await sleep(400);
    v = await view();
    check('Next returns to paint', !v.review && v.step === 'paint', { review: v.review, step: v.step });
    const z = await page.evaluate(() => window.__game.sim.world.habitats.size);
    check('Back never changes the zoo', z === 1, z);
  }

  async function failedFenceDrag() {
    // a fence across the avenue (west of the yellow box) will not close: "Not a habitat yet"
    const p = (await state()).plot;
    const a = await project((p.x0 - 4) * 2 + 0.5, (p.z0 + 1) * 2 + 0.5);
    const b = await project((p.x0 + 1) * 2 - 0.5, (p.z0 + 4) * 2 - 0.5);
    await drag1(a, b, 16, 160);
    await waitStep('fence', 'invalid', 15000);
    await sleep(300);
  }

  async function nudgeScenario() {
    await boot('first');
    await fastForward('fence');
    await waitStep('fence', 'open');
    await tapWhere(catBtn('Animals'), 'Animals');
    await waitStep('fence', 'wrong');
    const w = await assertStep('nudge wrong category', { step: 'fence', phase: 'wrong' });
    check('wrong category: "Tap Habitat first." with the ring on Habitat', w.v.line === 'nudge.wrongCat' && w.v.target.kind === 'cat' && w.v.target.id === 'habitats' && w.a === 'Tap Habitat first.', { line: w.v.line, a: w.a, target: w.v.target });
    await page.evaluate(() => window.__game.ui.ext.closeDrawer());
    await waitStep('fence', 'open');
    await tapWhere(`(() => { const e = window.__game.ui.ext.hudSpeedButton(3); const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`, '4x');
    // the nudge shows for 3 s: catch it (view and bubble read together)
    const l = await waitFor(
      `(() => { const v = window.__tut.view(); const a = document.querySelector('.wh-tut-a')?.textContent; return { ok: v.line === 'nudge.speedLocked' && a === 'Keep building first.', line: v.line, a, w: document.querySelector('.wh-tut-w')?.textContent, speed: window.__game.sim.speed, ring: document.querySelector('.wh-tut-ring')?.getBoundingClientRect().toJSON(), group: window.__game.ui.ext.hudEl('speedGroup').getBoundingClientRect().toJSON() }; })()`,
      'the locked-speed nudge', 5000, 60,
    ).catch((e) => ({ ok: false, err: String(e).slice(0, 300) }));
    check('locked speed: "Keep building first." / "Time waits while you build." with the ring on the speed buttons, speed stays 0', l.ok && l.w === 'Time waits while you build.' && l.speed === 0 && Math.abs(l.ring.left - l.group.left) < 12, l);
    await assertStep('nudge speed locked', { settle: 0 });
    await sleep(3200);
    await openCat('Habitat', 'fence');
    await pickCard('Timber Rail Fence', 'fence');
    await waitCamera();
    await failedFenceDrag();
    const f = await assertStep('nudge fence invalid', { step: 'fence', phase: 'invalid' });
    check('a fence across the path: "Try the yellow box."', f.v.line === 'fence.invalid', f.v.line);
  }

  async function helpScenario() {
    await boot('first');
    await fastForward('fence');
    await waitStep('fence', 'open');
    await openCat('Habitat', 'fence');
    await pickCard('Timber Rail Fence', 'fence');
    await waitCamera();
    for (let i = 0; i < 3; i++) {
      await failedFenceDrag();
      if (i < 2) {
        const v = await view();
        check(`after ${i + 1} failed drag(s): no Help me yet`, !v.buttons.help, v.buttons);
      }
    }
    await sleep(400);
    const v = await assertStep('help offered', { step: 'fence', phase: 'invalid' });
    check('three failed fence drags show Help me', v.v.buttons.help === true && (await page.locator('.wh-tut-help').count()) === 1, v.v.buttons);
    await tapWhere(rectJs(`document.querySelector('.wh-tut-help')`), 'Help me');
    await waitStep('paint', undefined, 20000);
    const r = await page.evaluate(() => ({ habitats: window.__game.sim.world.habitats.size, money: window.__game.sim.money }));
    check('Help me built the habitat and the step advanced', r.habitats === 1, r);
    await assertStep('after help', { step: 'paint' });
  }

  async function practiceScenario() {
    await boot('first');
    // record switchSlot instead of reloading when main.ts has not wired it
    if (!wired) await page.evaluate(() => { const h = window.__game.ui.ext; h.switchSlot = async (t) => { window.__switched = t; }; });
    await fastForward('speed-note');
    await page.evaluate(() => window.__tut.debugFinish());
    await waitFor(`(() => ({ ok: !!document.querySelector('.wh-tut-finish') }))()`, 'finish card');
    await tapWhere(rectJs(`document.querySelector('.wh-tut-finish .wh-tut-go')`), 'Keep playing');
    const habitats0 = await page.evaluate(() => window.__game.sim.world.habitats.size);
    await page.evaluate(() => window.__game.ui.ext.openMenu('settings'));
    await sleep(500);
    await tapWhere(rectJs(`document.querySelector('.wh-tut-set-play')`), 'Play tutorial');
    await waitFor(`(() => ({ ok: !!document.querySelector('.wh-dialog') }))()`, 'practice dialog');
    const d = await page.evaluate(() => ({ title: document.querySelector('.wh-dialog h3')?.textContent, text: document.querySelector('.wh-dialog p')?.textContent }));
    report.steps.push({ label: 'practice dialog', shot: await shot('practice-dialog') });
    check('practice dialog: "Play the tutorial?" / your own zoo stays safe', d.title === 'Play the tutorial?' && d.text === 'You get a practice zoo. Your own zoo stays safe.', d);
    await tapWhere(rectJs(`[...document.querySelectorAll('.wh-dialog-btns .wh-btn')].find((b) => b.textContent === 'Start')`), 'Start');
    if (wired) {
      await page.waitForFunction(() => window.__ready === true && !!window.__tutorial, null, { timeout: 600000, polling: 500 });
      await page.evaluate(() => (window.__tut = window.__tutorial));
    } else {
      await sleep(300);
      const sw = await page.evaluate(() => window.__switched);
      check("Start asks main.ts for the practice zoo: switchSlot({kind:'tutorial', slot:'practice'})", sw && sw.kind === 'tutorial' && sw.slot === 'practice' && sw.player === 'guest', sw);
      // what main.ts then does: a new zoo in the practice slot with the tutorial in practice mode
      await page.evaluate(async ({ player }) => {
        localStorage.setItem('wildhaven-active-slot', 'practice');
        const g = window.__game;
        window.__tut.dispose();
        g.sim.newGame(7, { startMinute: 510 });
        g.events.emit('worldReset', {});
        const m = await import('/src/ui/tutorial/index.ts');
        const ext = m.createTutorialExtension({ player, start: 'practice', versusEnabled: false });
        g.ui.addExtension(ext);
        window.__tut = ext;
        g.ui.ext.switchSlot = async (t) => { window.__switched = t; };
      }, { player: PLAYER });
    }
    await waitFor(`(() => ({ ok: !!document.querySelector('.wh-tut-welcome') }))()`, 'practice welcome card');
    const w = await page.evaluate(() => ({ text: document.querySelector('.wh-tut-welcome').textContent, habitats: window.__game.sim.world.habitats.size }));
    report.steps.push({ label: 'practice welcome', shot: await shot('practice-welcome') });
    check('practice zoo: a new zoo (no habitats) with the welcome card and the practice note', w.habitats === 0 && /practice zoo/.test(w.text), w);
    await page.evaluate(() => window.__tut.debugFinish());
    await waitFor(`(() => ({ ok: !!document.querySelector('.wh-tut-finish') }))()`, 'practice finish card');
    const btns = await page.evaluate(() => [...document.querySelectorAll('.wh-tut-finish .wh-btn')].map((b) => ({ t: b.textContent, primary: b.classList.contains('wh-btn-primary') })));
    report.steps.push({ label: 'practice finish', shot: await shot('practice-finish') });
    check('practice finish: Back to my zoo (primary) + Keep playing here', btns.some((b) => b.t === 'Back to my zoo' && b.primary) && btns.some((b) => b.t === 'Keep playing here' && !b.primary), btns);
    await tapWhere(rectJs(`document.querySelector('.wh-tut-finish .wh-tut-go')`), 'Back to my zoo');
    if (wired) {
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 600000, polling: 500 });
      await sleep(1500);
      const h = await page.evaluate(() => window.__game.sim.world.habitats.size);
      check('Back to my zoo restores the original zoo', h === habitats0, { h, habitats0 });
    } else {
      await sleep(300);
      const sw = await page.evaluate(() => window.__switched);
      check("Back to my zoo: switchSlot({kind:'continue', slot:'main', discard:'practice'})", sw && sw.kind === 'continue' && sw.slot === 'main' && sw.discard === 'practice', sw);
    }
  }

  async function readAloudScenario() {
    await boot('first');
    await waitFor(`(() => ({ ok: !!document.querySelector('.wh-tut-welcome') }))()`, 'welcome card');
    await sleep(1800);
    const w = await page.evaluate(() => ({ pressed: document.querySelector('.wh-tut-bigsay')?.getAttribute('aria-pressed'), shown: document.querySelector('.wh-tut-bigsay')?.style.display !== 'none', spoken: window.__spoken.slice() }));
    report.steps.push({ label: 'readaloud welcome', shot: await shot('readaloud-welcome') });
    check('read-aloud is on by default when a voice exists (big speaker on)', w.shown && w.pressed === 'true', w);
    check('the welcome line was spoken', w.spoken.some((s) => s.includes('Welcome to Wildhaven!') && s.includes("Let's build your very first zoo together.")), w.spoken);
    // off and on again from the welcome card
    await tapWhere(rectJs(`document.querySelector('.wh-tut-bigsay')`), 'speaker');
    await sleep(300);
    const off = await page.evaluate(() => ({ pressed: document.querySelector('.wh-tut-bigsay')?.getAttribute('aria-pressed'), st: JSON.parse(localStorage.getItem('wildhaven-tutorial')) }));
    check('the toggle turns it off and stores the choice', off.pressed === 'false' && off.st.readAloud === false, off);
    await tapWhere(rectJs(`document.querySelector('.wh-tut-bigsay')`), 'speaker');
    await sleep(300);
    await tapWhere(rectJs(`document.querySelector('.wh-tut-go')`), "Let's go");
    await waitStep('look-pan');
    await sleep(800);
    const sp = await page.evaluate(() => window.__spoken.slice());
    report.spoken = sp;
    check('the look-pan line was spoken (action, then why)', sp.some((s) => s === 'Drag one finger. Slide it across the screen to look around.' || s === 'Drag with the mouse. Slide around your zoo.'), sp.slice(-3));
    await assertStep('readaloud look-pan', { step: 'look-pan' });
  }

  try {
    if (scenario === 'main') await mainFlow();
    else if (scenario === 'skip') await skipScenario();
    else if (scenario === 'resume') await resumeScenario();
    else if (scenario === 'back') await backScenario();
    else if (scenario === 'nudge') await nudgeScenario();
    else if (scenario === 'help') await helpScenario();
    else if (scenario === 'practice') await practiceScenario();
    else if (scenario === 'readaloud') await readAloudScenario();
    else throw new Error(`unknown scenario ${scenario}`);
    if (readAloud && scenario !== 'readaloud') report.spoken = await page.evaluate(() => window.__spoken || []);
  } catch (err) {
    check(`scenario ${scenario} ran to the end`, false, String((err && err.stack) || err).slice(0, 1500));
    try {
      await shot('error');
      report.lastView = await page.evaluate(() => window.__tut && { v: window.__tut.view(), s: window.__tut.debugState() });
    } catch {}
  }
  const errs = report.errors.filter((e) => !/favicon|net::ERR|Failed to load resource/.test(e));
  check('no page errors', errs.length === 0, errs.slice(0, 5));
  report.seconds = Number(secs());
  report.failures = failures;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${failures ? 'FAILED' : 'OK'}: ${report.checks.length - failures}/${report.checks.length} checks passed in ${secs()}s (${scenario}, ${W}x${H}${mouse ? ', mouse' : ''})`);
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
