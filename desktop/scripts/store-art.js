// Renders, from the logo mark in ../../docs/assets/branding:
//  - the Microsoft Store listing art (Partner Center → Store listings →
//    Store logos / Store display images) into assets/store/*.png;
//  - the MSIX package assets (tiles, taskbar icon, splash) into assets/appx/,
//    which electron-builder's appx target picks up by directory name. Without
//    that folder it ships its own SampleAppx placeholders, and Store
//    certification rejects the package (policy 10.1.1.11, "tile icons
//    include a default image").
// Run with `npm run store-art` on Windows (it needs Playwright's Chromium,
// the same one the e2e suite uses, and the poster's wordmark font comes from
// Google Fonts, so it needs the network).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '..', 'assets', 'store');
const APPX_OUT = path.join(__dirname, '..', 'assets', 'appx');
// playwright-core pins a headless-shell build; use the newest full Chromium
// Playwright has installed instead.
function chromiumPath() {
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(root)) return undefined;
  const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}
const BG = '#1e1e1c';

// The icon group of docs/assets/branding/gamma-logo-dark.svg (48×48 box at 12..60),
// without the tile clip so it can sit on a full-bleed background.
const MARK = `
  <defs>
    <radialGradient id="glow" cx="36" cy="36" r="26" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#e8a020" stop-opacity="0.3"/>
      <stop offset="60%" stop-color="#e8a020" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#e8a020" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <path d="M 16 36 C 22 27 30 27 36 36 C 42 45 50 45 56 36" stroke="#e8a020" stroke-width="1.2" fill="none" opacity="0.6" stroke-linecap="round"/>
  <path d="M 16 36 C 22 45 30 45 36 36 C 42 27 50 27 56 36" stroke="#e8a020" stroke-width="1.2" fill="none" opacity="0.6" stroke-linecap="round"/>
  <path d="M 16 13 Q 9 36 16 59" stroke="#e8a020" stroke-width="4.5" fill="none" stroke-linecap="round" opacity="0.88"/>
  <path d="M 56 13 Q 63 36 56 59" stroke="#e8a020" stroke-width="4.5" fill="none" stroke-linecap="round" opacity="0.88"/>
  <rect x="21" y="20" width="26" height="5" rx="1.2" fill="#eeebe4"/>
  <rect x="21" y="20" width="5" height="28" rx="1.2" fill="#eeebe4"/>`;

// App tile icon: the same rounded tile as assets/icon.png — the favicon
// geometry (frontend/public/media/icons/favicon.svg) with the icon's heavier mirrors —
// so the Store tile matches the installed app's icon. Transparent corners.
function tileSvg(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 32 32">
    <defs>
      <radialGradient id="tglow" cx="16" cy="14" r="13" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#e8a020" stop-opacity="0.3"/>
        <stop offset="60%" stop-color="#e8a020" stop-opacity="0.08"/>
        <stop offset="100%" stop-color="#e8a020" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="32" height="32" rx="7" fill="${BG}"/>
    <rect width="32" height="32" rx="7" fill="url(#tglow)"/>
    <path d="M 6 16 C 9 10.5 13 10.5 16 16 C 19 21.5 23 21.5 26 16" stroke="#e8a020" stroke-width="1.2" fill="none" opacity="0.6" stroke-linecap="round"/>
    <path d="M 6 16 C 9 21.5 13 21.5 16 16 C 19 10.5 23 10.5 26 16" stroke="#e8a020" stroke-width="1.2" fill="none" opacity="0.6" stroke-linecap="round"/>
    <path d="M 6 4  Q 2 16 6 28" stroke="#e8a020" stroke-width="2.8" fill="none" stroke-linecap="round" opacity="0.9"/>
    <path d="M 26 4 Q 30 16 26 28" stroke="#e8a020" stroke-width="2.8" fill="none" stroke-linecap="round" opacity="0.9"/>
    <rect x="9" y="8" width="13" height="3" rx="0.8" fill="#eeebe4"/>
    <rect x="9" y="8" width="3" height="15" rx="0.8" fill="#eeebe4"/>
  </svg>`;
}

// 1:1 box art: full-bleed dark background, the mark at ~74% of the width.
function boxSvg(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="4 4 64 64">
    <rect x="4" y="4" width="64" height="64" fill="${BG}"/>
    <rect x="4" y="4" width="64" height="64" fill="url(#glow)"/>
    ${MARK}
  </svg>`;
}

// 9:16 poster: the mark in the upper half, the wordmark below it.
function posterSvg(w, h) {
  // viewBox 72 wide × 128 tall (9:16), mark centred at y=44.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 72 128">
    <rect width="72" height="128" fill="${BG}"/>
    <g transform="translate(0 8)">
      <rect x="4" y="4" width="64" height="64" fill="url(#glow)"/>
      ${MARK}
    </g>
    <text x="36" y="93" text-anchor="middle" font-family="Space Grotesk, Segoe UI, sans-serif" font-weight="600" font-size="12.5" fill="#eeebe4" letter-spacing="-0.2">Gamma</text>
    <text x="36" y="102" text-anchor="middle" font-family="Space Grotesk, Segoe UI, sans-serif" font-weight="400" font-size="5" fill="#7a7870" letter-spacing="0.04em">PDF Annotator</text>
  </svg>`;
}

// Start-menu tile / splash: the bare mark on a TRANSPARENT canvas, so the
// manifest's BackgroundColor (electron-builder.cjs appx.backgroundColor, = BG)
// paints the plate and Windows can overlay the app name (ShowNameOnTiles).
// `frac` is the mark's box as a fraction of the shorter side — Windows'
// tile guidance keeps the glyph well inside the plate.
function plateSvg(w, h, frac) {
  const u = 64 / (frac * Math.min(w, h)); // viewBox units per pixel
  const vw = w * u;
  const vh = h * u;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${36 - vw / 2} ${36 - vh / 2} ${vw} ${vh}">
    ${MARK}
  </svg>`;
}

// MSIX assets. Names are the ones electron-builder's manifest references
// (Square44x44Logo / Square150x150Logo / Wide310x150Logo / StoreLogo are
// mandatory; SmallTile / LargeTile / SplashScreen are optional and only
// declared when present). `.scale-N` / `.targetsize-N` variants make
// electron-builder run makepri so Windows picks the sharp one per DPI; the
// unqualified file is the scale-100 fallback. The 44px logo and its
// targetsize variants are the icon Windows shows in the taskbar, Start list
// and Alt+Tab, so they are the same rounded tile as assets/icon.png;
// `_altform-unplated` is that icon without the colored plate.
const APPX_JOBS = [];
const scaled = (name, w, h, make) => {
  APPX_JOBS.push([`${name}.png`, w, h, make(w, h)]);
  for (const pct of [125, 150, 200, 400]) {
    const sw = Math.round((w * pct) / 100);
    const sh = Math.round((h * pct) / 100);
    APPX_JOBS.push([`${name}.scale-${pct}.png`, sw, sh, make(sw, sh)]);
  }
};
scaled('Square44x44Logo', 44, 44, (w) => tileSvg(w));
scaled('StoreLogo', 50, 50, (w) => tileSvg(w));
scaled('SmallTile', 71, 71, (w, h) => plateSvg(w, h, 0.62));
scaled('Square150x150Logo', 150, 150, (w, h) => plateSvg(w, h, 0.5));
scaled('Wide310x150Logo', 310, 150, (w, h) => plateSvg(w, h, 0.5));
scaled('LargeTile', 310, 310, (w, h) => plateSvg(w, h, 0.45));
scaled('SplashScreen', 620, 300, (w, h) => plateSvg(w, h, 0.5));
for (const px of [16, 20, 24, 30, 32, 36, 40, 48, 64, 256]) {
  APPX_JOBS.push([`Square44x44Logo.targetsize-${px}.png`, px, px, tileSvg(px)]);
  APPX_JOBS.push([`Square44x44Logo.targetsize-${px}_altform-unplated.png`, px, px, tileSvg(px)]);
}

const JOBS = [
  ['poster-720x1080.png', 720, 1080, posterSvg(720, 1080), false],
  ['poster-1440x2160.png', 1440, 2160, posterSvg(1440, 2160), false],
  ['boxart-1080x1080.png', 1080, 1080, boxSvg(1080), false],
  ['boxart-2160x2160.png', 2160, 2160, boxSvg(2160), false],
  ['tile-300x300.png', 300, 300, tileSvg(300), true],
  ['tile-150x150.png', 150, 150, tileSvg(150), true],
  ['tile-71x71.png', 71, 71, tileSvg(71), true],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(APPX_OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const render = async (dir, name, w, h, svg, transparent) => {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head>
      <link rel="preconnect" href="https://fonts.gstatic.com">
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600&display=swap" rel="stylesheet">
      <style>html,body{margin:0;background:transparent}svg{display:block}</style>
      </head><body>${svg}</body></html>`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(dir, name), omitBackground: transparent });
    await page.close();
    console.log(`${path.basename(dir)}/${name}  ${w}×${h}`);
  };
  try {
    for (const [name, w, h, svg, transparent] of JOBS) await render(OUT, name, w, h, svg, transparent);
    for (const [name, w, h, svg] of APPX_JOBS) await render(APPX_OUT, name, w, h, svg, true);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
