// Full-game screenshot driver (waits for window.__ready, moves the camera, logs draw calls).
// Usage: node scripts/gameshots.cjs "<url>" <outPrefix> '[{"name":"v1","x":72,"z":90,"d":60,"yaw":180,"pitch":45,"wait":4000},{"name":"z","species":"zebra","d":12},{"name":"n","time":"21:30"}]' [--size=WxH] [--mobile]
// node gameshots.cjs <url> <outprefix> <views-json> [--size=WxH] [--mobile]
// views: [{name, x, z, d, yaw, pitch, wait}] — degrees for yaw/pitch
// URL parameters of the game: demo (showcase zoo), q=low|medium|high, time=HH:MM,
// paused, and seed=<n>: the same seed loads the same zoo (layout, animals,
// guests), so before/after shots and draw-call numbers are comparable (add paused
// to keep it still while shooting); without it every load is a different zoo.
// E.g. "http://localhost:5525/?demo=1&q=low&seed=7&paused".
const { chromium } = require('playwright');
(async () => {
  const [url, prefix, viewsJson] = process.argv.slice(2);
  const args = process.argv.slice(2);
  const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const [w, h] = opt('size', '1280x720').split('x').map(Number);
  const mobile = args.includes('--mobile');
  const views = JSON.parse(viewsJson);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000); // SwiftShader frames at medium/high can take tens of seconds
  const errors = [];
  const logs = [];
  page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; if (m.type() === 'error' || m.type() === 'warning') errors.push(t); else logs.push(t); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e && e.stack || e)));
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 600000, polling: 500 });
  console.log('ready after', ((Date.now() - t0) / 1000).toFixed(1), 's');
  for (const v of views) {
    if (v.x !== undefined) {
      await page.evaluate((v) => {
        const g = window.__game; const D = Math.PI / 180;
        g.ui.camera.setView(v.x, v.z, v.d, v.yaw !== undefined ? v.yaw * D : undefined, v.pitch !== undefined ? v.pitch * D : undefined);
      }, v);
    }
    if (v.species) {
      await page.evaluate((v) => {
        const g = window.__game; const D = Math.PI / 180;
        const list = [...g.sim.animals.values()].filter((a) => a.speciesId === v.species);
        const a = list[v.idx ?? 0];
        if (a) g.ui.camera.setView(a.x, a.z, v.d ?? 14, (v.yaw ?? 30) * D, (v.pitch ?? 25) * D);
      }, v);
    }
    if (v.time) { await page.evaluate((t) => { const [h, m] = t.split(':').map(Number); const g = window.__game; g.sim.minuteOfDay = h * 60 + m; g.ctx.setTimeOfDay(g.sim.minuteOfDay, g.sim.day); g.ctx.settle(); }, v.time); }
    if (v.eval) { const r = await page.evaluate(v.eval); if (r !== undefined) console.log(v.name, 'eval:', JSON.stringify(r).slice(0, 2000)); }
    await page.waitForTimeout(v.wait ?? 4000);
    const info = await page.evaluate(() => { const r = window.__game.ctx.renderer.info; return { calls: r.render.calls, tris: r.render.triangles, geos: r.memory.geometries, tex: r.memory.textures }; });
    await page.screenshot({ path: `${prefix}-${v.name}.png` });
    console.log('shot', v.name, JSON.stringify(info));
  }
  console.log('ERRORS (' + errors.length + '):\n' + [...new Set(errors)].slice(0, 30).join('\n'));
  console.log('LOGS:\n' + logs.slice(0, 15).join('\n'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
