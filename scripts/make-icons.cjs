// Renders the original Wildhaven Zoo icon + splash screens (SVG → PNG via Playwright)
// into the Capacitor Android resource folders. Run: node scripts/make-icons.cjs
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

// Original artwork: savanna sunset disc, umbrella acacia and a giraffe silhouette.
function art({ bg = true, scale = 1 } = {}) {
  return `
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#14361f"/><stop offset="0.55" stop-color="#2d6a3a"/><stop offset="1" stop-color="#c98b3c"/>
    </linearGradient>
    <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffe6a8"/><stop offset="0.7" stop-color="#f6b354"/><stop offset="1" stop-color="#e48a2e"/>
    </radialGradient>
  </defs>
  ${bg ? '<rect width="512" height="512" fill="url(#sky)"/>' : ''}
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <circle cx="300" cy="250" r="120" fill="url(#sun)"/>
    <path d="M-20 372 Q140 340 256 356 T532 346 L532 532 L-20 532 Z" fill="#0d2414"/>
    <!-- acacia -->
    <path d="M150 372 Q156 330 158 300 Q150 280 118 262 M158 300 Q172 280 206 262 M158 300 L163 255" stroke="#0d2414" stroke-width="9" fill="none" stroke-linecap="round"/>
    <path d="M66 262 Q100 224 160 228 Q228 220 266 252 Q234 270 160 267 Q98 273 66 262 Z" fill="#0d2414"/>
    <!-- giraffe (original silhouette) -->
    <g fill="#0d2414" stroke="#0d2414" stroke-linejoin="round" stroke-linecap="round">
      <path d="M318 318 Q322 296 346 290 Q368 284 384 280 Q394 282 394 296 Q392 312 378 318 Q350 324 318 318 Z"/>
      <path d="M380 290 Q386 246 398 200 L410 203 Q400 248 394 294 Z"/>
      <path d="M396 204 Q398 190 412 188 Q424 189 432 197 Q430 203 420 204 L406 210 Z"/>
      <path d="M402 190 L399 177 M410 189 L411 176" stroke-width="4" fill="none"/>
      <path d="M324 316 L322 360 M334 318 L336 362 M372 316 L374 360 M382 314 L386 358" stroke-width="7" fill="none"/>
      <path d="M318 304 Q308 312 306 326" stroke-width="3" fill="none"/>
    </g>
  </g>`;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  async function render(svgInner, w, h, out, viewBox = '0 0 512 512', round = false) {
    const clip = round ? `<clipPath id="c"><circle cx="256" cy="256" r="256"/></clipPath>` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${viewBox}" preserveAspectRatio="xMidYMid slice">${clip}<g ${round ? 'clip-path="url(#c)"' : ''}>${svgInner}</g></svg>`;
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
    await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  }
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, f] of Object.entries(dens)) {
    const dir = path.join(RES, `mipmap-${d}`);
    fs.mkdirSync(dir, { recursive: true });
    await render(art(), 48 * f, 48 * f, path.join(dir, 'ic_launcher.png'));
    await render(art(), 48 * f, 48 * f, path.join(dir, 'ic_launcher_round.png'), '0 0 512 512', true);
    await render(art({ bg: false, scale: 0.62 }), 108 * f, 108 * f, path.join(dir, 'ic_launcher_foreground.png'));
  }
  // splash screens (landscape + portrait)
  const splashSizes = { mdpi: [480, 320], hdpi: [800, 480], xhdpi: [1280, 720], xxhdpi: [1600, 960], xxxhdpi: [1920, 1280] };
  for (const [d, [w, h]] of Object.entries(splashSizes)) {
    const inner = `<rect x="-2000" y="-2000" width="5000" height="5000" fill="#0b1a10"/>${art({ bg: false, scale: 0.55 })}`;
    for (const [orient, W, H] of [['land', w, h], ['port', h, w]]) {
      const dir = path.join(RES, `drawable-${orient}-${d}`);
      fs.mkdirSync(dir, { recursive: true });
      const s = Math.min(W, H);
      const vb = `${256 - (256 * W) / s} ${256 - (256 * H) / s} ${(512 * W) / s} ${(512 * H) / s}`;
      await render(inner, W, H, path.join(dir, 'splash.png'), vb);
    }
  }
  await render(`<rect width="512" height="512" fill="#0b1a10"/>${art({ bg: false, scale: 0.55 })}`, 480, 480, path.join(RES, 'drawable', 'splash.png'));
  await render(art(), 512, 512, path.join(__dirname, '..', 'public', 'icon-512.png'));
  await browser.close();
  console.log('icons written');
})();
