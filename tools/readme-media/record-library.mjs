// Records docs/assets/demos/demo-library.webp source: from the HOME page, open the search
// panel (the topbar magnifier — plain Ctrl+F on home focuses the listing's own
// find box; Ctrl+Shift+F would also open this panel), type a query that hits
// titles, notes, a highlight and PDF text across the library at once, add a
// folder chip that narrows the results, then open a library PDF hit: the paper
// opens with every match marked and the active one outlined.
//
// Expects `session.txt` (the demo session cookie) in the cwd and writes the
// webm path to `video_library.txt` plus time marks to `library_marks.json`
// (m0 = first action, for trimming the loading pre-roll; mChip / mOpen / mMark
// for an optional post-process camera zoom).
//
// Delivery: render-suite.py library (25 fps animated WebP).
//
// Content prerequisites on the target instance (an isolated clone of the demo
// workspace): the atom-arrays paper carries notes + a highlight mentioning
// "error correction", the QEC paper carries notes too, and they sit in
// folders "Quantum/Neutral atoms" / "Quantum/Error correction" (the folder
// name containing the query is what surfaces the "Tab adds a filter"
// suggestion). Each paper should have been opened once so the recents strip
// is populated. (The match jump cancels the paper's last-read restore, so a
// stored read position can't scroll the match away.)
// Search details are forced on (`gamma-search-details*` = "1"; the paper
// view's default is the compact find bar).
import { chromium, ROOT, configureContext } from './runtime.mjs';
import fs from 'fs';

const SCRATCH = process.cwd();
const SESSION = fs.readFileSync(SCRATCH + '/session.txt', 'utf8').trim();
const BASE = process.env.BASE_URL || 'http://127.0.0.1:9002';
const QEC = process.env.QEC_ID || 'BHuT16WnxdQb';
const QUERY = 'error correction';
const VW = 1440, VH = 900;
const EXE = process.env.CHROME_PATH;
const beat = (ms) => page.waitForTimeout(ms);

let cx = VW / 2, cy = VH / 2;
async function glide(x, y, steps = 28) {
  await page.mouse.move(x, y, { steps });
  cx = x; cy = y;
  await beat(120);
}
async function glideTo(locator, dx = 0.5, dy = 0.5, steps = 28) {
  const b = await locator.boundingBox();
  await glide(b.x + b.width * dx, b.y + b.height * dy, steps);
  return b;
}
// the "Searching…" hint stays until the slowest of the lookups has finished
async function settled() {
  await page.waitForFunction(() => ![...document.querySelectorAll('.searchPopover .searchHint')].some(h => h.textContent.startsWith('Searching')), null, { timeout: 15000 }).catch(() => {});
}
// "Library PDFs" is the last group to arrive (server FTS); the "Filters:"
// header renders instantly with a chip, so never wait for the first header
async function resultsIn() {
  await page.waitForSelector('.searchPopover .searchSection:has-text("Library PDFs")', { timeout: 10000 });
  await settled();
}

const browser = await chromium.launch({ headless: true, slowMo: 0, executablePath: EXE });
const ctx = await browser.newContext({
  colorScheme: 'light',
  viewport: { width: VW, height: VH },
  deviceScaleFactor: 2,
  recordVideo: { dir: SCRATCH + '/video', size: { width: VW, height: VH } },
});
await configureContext(ctx);
await ctx.addCookies([{ name: 'session', value: SESSION, url: BASE }]);
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('gamma-search-details', '1');
    localStorage.setItem('gamma-search-details-home', '1');
  } catch (e) {}
});

// inject a visible cursor dot (Playwright videos have none)
await ctx.addInitScript(() => {
  window.addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.id = '__fakecur';
    c.style.cssText = 'position:fixed;z-index:2147483647;width:16px;height:16px;'
      + 'border-radius:50%;background:rgba(20,20,20,.35);border:2px solid #fff;'
      + 'box-shadow:0 1px 4px rgba(0,0,0,.4);pointer-events:none;left:0;top:0;'
      + 'margin:-9px 0 0 -9px;transition:transform .05s linear';
    document.body.appendChild(c);
    const move = e => { c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mousedown', () => { c.style.background = 'rgba(60,120,255,.6)'; }, true);
    document.addEventListener('mouseup', () => { c.style.background = 'rgba(20,20,20,.35)'; }, true);
  });
});

const page = await ctx.newPage();
page.on('console', m => { const t = m.text(); if (t.startsWith('SCRIPT:')) console.log(t); });
const t0 = Date.now();
const mark = () => (Date.now() - t0) / 1000;

// Populate recents and PDF covers through real navigation, before the first shot.
for (const id of ['fy0-h_BqOHcH', QEC]) {
  await page.goto(`${BASE}/?page=${id}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.textLayer span', { timeout: 60000 });
  const closeChat = page.getByRole('button', { name: 'Close Chat', exact: true });
  if (await closeChat.isVisible()) await closeChat.click();
  await page.locator('.pdfViewer').evaluate(e => e.scrollTo(0, 0));
  await beat(1500);
}

// 1. home (a bare `/` restores the last open paper — click Home) -------------
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForSelector('[aria-label="Home"]', { timeout: 30000 });
await beat(800);
await page.click('[aria-label="Home"]');
await page.waitForSelector('.recentsCarousel', { timeout: 30000 });
await page.mouse.move(cx, cy);
await beat(2500);

// 2. open the search panel from the topbar, type the query ------------------
const m0 = mark();
await glideTo(page.locator('[aria-label="Search"]'), 0.5, 0.5, 30);
await beat(200);
await page.click('[aria-label="Search"]');
await page.waitForSelector('.searchPopover .searchInput', { timeout: 5000 });
await beat(400);
await page.keyboard.press('Control+a');           // the box keeps its previous query
await page.keyboard.type(QUERY, { delay: 60 });
await resultsIn();
await beat(1400);
console.log('SCRIPT: results', await page.evaluate(() => [...document.querySelectorAll('.searchSection')].map(e => e.textContent).join(' | ')));

// 3. hover down the grouped results ------------------------------------------
const rows = page.locator('.searchPopover .searchResult');
const nRows = await rows.count();
await glideTo(rows.nth(0), 0.25, 0.5, 22);
await beat(350);
await glideTo(rows.nth(Math.min(2, nRows - 1)), 0.25, 0.5, 18);
await beat(350);
await glideTo(rows.nth(Math.min(5, nRows - 1)), 0.25, 0.5, 18);
await beat(600);

// 4. add the folder chip (click the suggestion the query surfaced) ----------
const mChip = mark();
const sug = page.locator('.searchPopover .categorySuggestionItem').first();
await glideTo(sug, 0.12, 0.5, 26);
await beat(300);
await sug.dispatchEvent('mousedown');            // confirmLabel runs on mousedown
await page.waitForSelector('.searchPopover .searchChip', { timeout: 5000 });
console.log('SCRIPT: chip', await page.locator('.searchPopover .searchChip').first().textContent());
await beat(700);
// the chip replaced the query text — type it again, scoped to the folder now
await page.keyboard.type(QUERY, { delay: 60 });
await resultsIn();
await beat(1600);
console.log('SCRIPT: narrowed', await page.evaluate(() => [...document.querySelectorAll('.searchSection')].map(e => e.textContent).join(' | ')));

// 5. open the library PDF hit on page 1 ---------------------------------------
const hit = page.locator('.searchPopover .searchResult[title^="Open"]', {
  has: page.locator('.searchResultPage', { hasText: /· p\. 1$/ }),
}).first();
await hit.waitFor({ timeout: 5000 });
const mOpen = mark();
await glideTo(hit, 0.2, 0.5, 30);
await beat(450);
await hit.click();
// the paper opens (URL becomes ?block=<id>) and the pinned search re-finds the
// phrase with pdf.js — wait for a mark ON PAGE 1 inside the viewport (a
// previous paper's marks would stay in the DOM until the new one renders),
// then for the page canvas to paint
await page.waitForFunction((id) => location.search.includes(id), QEC, { timeout: 30000 });
await page.waitForFunction(() => {
  const p1 = document.querySelector('[data-page="1"]');
  if (!p1 || !p1.querySelector('canvas')) return false;
  return [...p1.querySelectorAll('.pdfFindMark')].some(m => { const r = m.getBoundingClientRect(); return r.top > 60 && r.bottom < 880; });
}, null, { timeout: 30000 });
const mMark = mark();
console.log('SCRIPT: marks visible at', mMark.toFixed(2));
await beat(1500);
// settle the cursor just right of the first mark
const firstMark = await page.locator('[data-page="1"] .pdfFindMark').first().boundingBox();
if (firstMark) await glide(firstMark.x + firstMark.width + 30, firstMark.y + firstMark.height / 2, 24);
await beat(3000);
const tEnd = mark();

await page.screenshot({ path: SCRATCH + '/library-final.png' });
const video = page.video();
await ctx.close();
const vpath = await video.path();
fs.writeFileSync(SCRATCH + '/video_library.txt', vpath);
fs.writeFileSync(SCRATCH + '/library_marks.json', JSON.stringify({ m0, mChip, mOpen, mMark, tEnd, cssW: VW, cssH: VH }));
console.log('SCRIPT: video', vpath, JSON.stringify({ m0, mChip, mOpen, mMark, tEnd }));
await browser.close();
