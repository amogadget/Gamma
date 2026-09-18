// Shoots the docs/assets/screenshots/ stills (not referenced by the README; kept for
// docs/marketing): 01 an annotated paper with the note tree and an answered
// chat question, 02 the home page (folders, recents strip, listing), 03 the
// home search panel with grouped library results.
//
// Expects `session.txt` (the demo session cookie) in the cwd. Writes the PNGs
// into OUT. House style: light, 1680x1000, DPR 1. The three papers are opened
// first so the recents strip is populated (most recent = the annotated paper).
// Needs a working AI provider on the instance for the chat answer; without
// one, 01 is shot with the question sent but unanswered (the script says so).
import { chromium, ROOT, readSession, BASE, CURATED } from './runtime.mjs';
import fs from 'fs';

const SESSION = readSession();
const OUT = process.env.STILLS_OUT || ROOT + 'docs/assets/screenshots';
const ATOMS = CURATED.atoms;         // the paper with the real highlight (page 2)
const OTHERS = ['p8oNV3s3XNhC', CURATED.qec];
const QUESTION = 'What is the key idea of this paper in one sentence?';
const QUERY = 'error correction';

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ colorScheme: 'light', viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
await ctx.addCookies([{ name: 'session', value: SESSION, url: BASE }]);
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('gamma-search-details', '1');
    localStorage.setItem('gamma-search-details-home', '1');
  } catch (e) {}
});
const page = await ctx.newPage();
const beat = (ms) => page.waitForTimeout(ms);

async function openPaper(id) {
  await page.goto(BASE + '/?page=' + id, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-page="1"] .textLayer span', { timeout: 60000 });
  await beat(5000); // pdf.js render + highlight overlay placement
}

// warm the recents strip (oldest first; the annotated paper comes last)
for (const id of OTHERS) await openPaper(id);

// 01 — annotated paper: highlight on page 2 in view, note tree, answered chat.
// The page chat is persisted server-side — clear it so only this Q&A shows.
await fetch(BASE + '/api/chats/' + ATOMS, { method: 'DELETE', headers: { Cookie: 'session=' + SESSION } })
  .catch((e) => console.log('SCRIPT: chat reset failed', e.message));
await openPaper(ATOMS);
// drop the "Cursor" context chip the restored block focus puts in the chat box
await page.click('.chatSelChip.isCursor .chatSelChipClose').catch(() => {});
// pages are lazy: mount page 2 first, then centre the highlight overlay on it
await page.evaluate(() => document.querySelector('[data-page="2"]')?.scrollIntoView({ block: 'start' }));
await page.waitForSelector('[data-page="2"] [data-hl-id]', { timeout: 20000 }).catch(() => {});
await beat(1500);
await page.evaluate(() => {
  const hl = document.querySelector('[data-page="2"] [data-hl-id]');
  (hl || document.querySelector('[data-page="2"]'))?.scrollIntoView({ block: 'center' });
});
await beat(2500);
let answered = false;
for (let attempt = 0; attempt < 2 && !answered; attempt++) {   // one retry: the provider can time out upstream
  await page.click('.chatInput');
  await page.type('.chatInput', QUESTION, { delay: 20 });
  await page.press('.chatInput', 'Enter');
  try {
    await page.waitForSelector('.chatBubbleRow.ai', { timeout: 40000 });
    let lastLen = 0, stable = 0;
    for (let i = 0; i < 120; i++) {         // up to ~60 s of streaming
      await beat(500);
      const st = await page.evaluate(() => {
        const el = document.querySelector('.chatBubbleRow.ai:last-of-type');
        const t = el ? el.innerText : '';
        return { len: t.length, err: !!el?.querySelector('.chatBubble.error') };
      });
      if (st.err) break;
      if (st.len > 40 && st.len === lastLen) { stable++; if (stable >= 4) { answered = true; break; } } else { stable = 0; }
      lastLen = st.len;
    }
  } catch (e) { console.log('SCRIPT: no AI answer (' + e.message.split('\n')[0] + ')'); }
  if (!answered) {
    console.log('SCRIPT: AI attempt ' + (attempt + 1) + ' failed (error bubble / timeout)');
    if (attempt === 0) await beat(3000);
  }
}
await beat(1200);
await page.mouse.move(600, 980);           // park the pointer off the note tree
await page.screenshot({ path: OUT + '/01-annotated-pdf.png' });
console.log('SCRIPT: 01 shot, answered =', answered);

// 02 — home: click Home (a bare `/` restores the last open paper)
await page.click('[aria-label="Home"]');
await page.waitForSelector('.recentsCarousel', { timeout: 30000 });
await beat(3000);
await page.screenshot({ path: OUT + '/02-home.png' });
console.log('SCRIPT: 02 shot');

// 03 — home search panel with grouped results
await page.click('[aria-label="Search"]');
await page.waitForSelector('.searchPopover .searchInput', { timeout: 5000 });
await page.keyboard.press('Control+a');
await page.keyboard.type(QUERY, { delay: 30 });
await page.waitForSelector('.searchPopover .searchSection:has-text("Library PDFs")', { timeout: 10000 });
await page.waitForFunction(() => ![...document.querySelectorAll('.searchPopover .searchHint')].some(h => h.textContent.startsWith('Searching')), null, { timeout: 15000 }).catch(() => {});
await beat(1000);
await page.screenshot({ path: OUT + '/03-library-search.png' });
console.log('SCRIPT: 03 shot,', await page.evaluate(() => [...document.querySelectorAll('.searchSection')].map(e => e.textContent).join(' | ')));

await browser.close();
