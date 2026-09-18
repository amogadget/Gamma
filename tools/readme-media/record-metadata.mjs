import { chromium, configureContext, addCursor, pointer, readSession, BASE } from './runtime.mjs';
import fs from 'fs';

// README "Metadata & citations" demo: open a paper by URL, open the metadata
// popover the moment the paper paints — while the arXiv fetch is still
// running — so the viewer watches Title / Authors / Venue / Year / DOI fill
// in, then copy BibTeX + the slide citation from the share popover. Recorded
// at NORMAL scale; render-suite.py trims the download pre-roll and applies a
// fixed detail crop of the right column (both popovers live there).

const SCRATCH = process.cwd();
const SESSION = readSession(SCRATCH);
// Bluvstein et al., "Logical quantum processor based on reconfigurable atom
// arrays" (Nature 2024). `run-case.mjs metadata` removes it from the library
// first, or no fetch runs on camera.
const PAPER_URL = 'https://arxiv.org/abs/2312.03982';
const VW = 1440, VH = 900;
const INFO_XY = { x: 1387, y: 97 };     // where the info button lands once the page opens (Notes header)
const beat = (ms) => page.waitForTimeout(ms);

const browser = await chromium.launch({ headless: true, slowMo: 0 });
const ctx = await browser.newContext({
  colorScheme: 'light', viewport: { width: VW, height: VH }, deviceScaleFactor: 2,
  recordVideo: { dir: SCRATCH + '/video-meta', size: { width: VW, height: VH } }, // CSS = video 1:1
});
await configureContext(ctx);
await ctx.addCookies([{ name: 'session', value: SESSION, url: BASE }]);
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
await addCursor(ctx);

const page = await ctx.newPage();
const { glide, glideTo, at } = pointer(page, VW / 2, VH / 2);
const T0 = Date.now();
const mark = () => (Date.now() - T0) / 1000;
const M = {};
page.on('console', m => { const t = m.text(); if (t.startsWith('SCRIPT:')) console.log(t); });

// --- home -> paste the arXiv URL into "+" -----------------------------------
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.mouse.move(at().x, at().y);
await beat(600);
await glideTo('[aria-label="Add"]', 0.5, 0.5, 26);
await page.click('[aria-label="Add"]');
await beat(400);
await glideTo('.addPopover input.searchInput', 0.1, 0.5, 20);
await page.click('.addPopover input.searchInput');
await beat(250);
await page.fill('.addPopover input.searchInput', PAPER_URL);
await beat(500);
await page.press('.addPopover input.searchInput', 'Enter');
console.log('SCRIPT: submitted URL');
// park the cursor where the info button will appear, during the download (trimmed away)
await glide(INFO_XY.x, INFO_XY.y, 30);

// --- the paper renders (real download) -> open the popover at once, fetch still running --
await page.waitForSelector('[data-page="1"] .textLayer span', { timeout: 60000 });
const tPaint = mark();
M.m0 = tPaint + 0.2;                     // demo start: the canvas paints ~0.4 s after the text layer
await beat(350);
const infoBtn = await glideTo('[aria-label="Paper metadata"]', 0.5, 0.5, 6);
await page.click('[aria-label="Paper metadata"]');
await page.waitForSelector('.metaPopover', { timeout: 5000 });
M.mMeta = mark();
const pageId = await page.evaluate(() => { const u = new URL(location.href); return u.searchParams.get('page') || u.searchParams.get('block'); });
const titleSel = '.metaPopover .metaRow:has(.metaKey:text-is("Title")) input';
const already = (await page.locator(titleSel).inputValue().catch(() => '')).length > 10;
console.log('SCRIPT: popover open', (M.mMeta - tPaint).toFixed(2), 's after paint; already filled =', already, '; page', pageId);
if (already) {
  // fast network: the record landed before we got here -- re-fetch on camera
  await beat(900);
  await glideTo('.metaPopover .popoverTitle button.searchToggle', 0.5, 0.5, 16);
  await page.click('.metaPopover .popoverTitle button.searchToggle');
  M.mRefetch = mark();
  await page.waitForFunction(() => document.querySelector('[aria-label="Paper metadata"] .pillSpin'), null, { timeout: 4000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-label="Paper metadata"] .pillSpin'), null, { timeout: 60000 }).catch(() => {});
  console.log('SCRIPT: re-fetched on camera');
} else {
  // watch the fields fill in (arXiv -> the record + BibTeX + slide cite)
  let filled = false;
  for (let i = 0; i < 200; i++) {        // up to ~60 s
    const v = await page.locator(titleSel).inputValue().catch(() => '');
    if (v && v.length > 10) { filled = true; break; }
    await beat(300);
  }
  if (!filled) { console.log('SCRIPT: fields never filled'); await browser.close(); process.exit(1); }
}
M.mFilled = mark();
console.log('SCRIPT: fields filled', (M.mFilled - M.mMeta).toFixed(1), 's after opening');
await beat(2200);                        // read the auto-filled record
const metaPop = await page.locator('.metaPopover').boundingBox();

// the slide citation is generated in the same fetch; make sure it is cached
// before opening the share popover (else it reads "Generating...")
for (let i = 0; i < 100; i++) {
  const cite = await page.evaluate(async (id) => {
    const res = await fetch('/api/blocks/' + id); if (!res.ok) return '';
    return ((await res.json()).properties || {}).ppt_cite || '';
  }, pageId);
  if (cite) { console.log('SCRIPT: cite', cite); break; }
  await beat(300);
}

// --- share popover: Copy BibTeX, then the slide-ready citation ----------------
await glideTo('[aria-label="Share"]', 0.5, 0.5, 30);
await beat(200);
await page.click('[aria-label="Share"]');
await page.waitForSelector('.sharePopover', { timeout: 5000 });
await page.waitForSelector('.sharePopover .pptCitePreview', { timeout: 30000 }).catch(() => console.log('SCRIPT: cite preview missing'));
await page.waitForSelector('[aria-label="Copy BibTeX"]', { timeout: 10000 });
M.mShare = mark();
const sharePop = await page.locator('.sharePopover').boundingBox();
console.log('SCRIPT: share popover open');
await beat(1100);

await glideTo('[aria-label="Copy BibTeX"]', 0.5, 0.5, 24);
await beat(200);
await page.click('[aria-label="Copy BibTeX"]');
console.log('SCRIPT: bibtex copied');
await beat(1300);                        // tick shows for 1.5 s

await glideTo('[aria-label="Copy slide citation"]', 0.5, 0.5, 18);
await beat(200);
await page.click('[aria-label="Copy slide citation"]');
console.log('SCRIPT: slide citation copied');
await beat(1300);
M.mOut = mark();                          // camera zoom-out begins
await beat(1500);
M.tEnd = mark();

fs.writeFileSync(SCRATCH + '/meta_zoom.json', JSON.stringify({
  cssW: VW, cssH: VH, vidW: VW, vidH: VH,
  ...M, pageId,
  metaPop, sharePop, infoBtn,
}, null, 2));

const video = page.video();
await ctx.close();
const vpath = await video.path();
fs.writeFileSync(SCRATCH + '/video_meta_path.txt', vpath);
console.log('SCRIPT: video saved', vpath);
await browser.close();
