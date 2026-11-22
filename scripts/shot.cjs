// Headless screenshot helper for visual checks (uses the pre-installed Playwright Chromium).
// Usage: node scripts/shot.cjs <url> <out.png> [--wait=ms] [--size=WxH] [--mobile] [--eval="js"] [--console]
const { chromium } = require('playwright');
(async () => {
  const args = process.argv.slice(2);
  const url = args[0];
  const out = args[1] || 'shot.png';
  const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const wait = Number(opt('wait', '4000'));
  const [w, h] = opt('size', '1280x720').split('x').map(Number);
  const mobile = args.includes('--mobile');
  const logConsole = args.includes('--console');
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (logConsole) console.log(`[console.${m.type()}]`, m.text()); });
  page.on('pageerror', (e) => errors.push(String(e && e.stack || e)));
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(wait);
  const ev = opt('eval', '');
  if (ev) { const r = await page.evaluate(ev); console.log('eval result:', JSON.stringify(r)); await page.waitForTimeout(Number(opt('after', '1500'))); }
  await page.screenshot({ path: out });
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.slice(0, 20).join('\n'));
  console.log('saved', out);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
