// Store layout recipes. Geometry and palette live in design/brand/.
import fs from 'node:fs';
import { ROOT } from './runtime.mjs';
import path from 'node:path';
import { markSvg } from './mark.mjs';
import { logoSvg } from './logo.mjs';
const read = name => fs.readFileSync(path.join(ROOT, 'design/brand', name), 'utf8');
const BG = JSON.parse(read('tokens.json')).colors.background;
const MARK = `<g transform="translate(4 4)">${markSvg(64, { bare: true })}</g>`;
function tileSvg(px) {
  return markSvg(px);
}
// 1:1 box art: full-bleed dark background, the mark at ~74% of the width.
function boxSvg(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="4 4 64 64">
    <rect x="4" y="4" width="64" height="64" fill="${BG}"/>
    ${MARK}
  </svg>`;
}

// 9:16 poster: the mark in the upper half, the wordmark below it.
function posterSvg(w, h) {
  // viewBox 72 wide × 128 tall (9:16), mark centred at y=44.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 72 128">
    <rect width="72" height="128" fill="${BG}"/>
    <g transform="translate(0 8)">
      ${MARK}
    </g>
    <g transform="translate(6 88)">${logoSvg({ dark: true, width: 60 })}</g>
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
// and Alt+Tab, so they are the same rounded tile as assets/icon.png.
// `_altform-unplated` is the variant Windows 11 actually picks there, and it
// gets the SAME rounded tile rather than a bare mark: without the plate the
// cream glyph is invisible on a light Start menu, and Windows paints no
// BackgroundColor behind an unplated asset.
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


export const storeJobs = [...JOBS.map(j => ['desktop/assets/store/' + j[0], ...j.slice(1)]), ...APPX_JOBS.map(j => ['desktop/assets/appx/' + j[0], ...j.slice(1), true])];
