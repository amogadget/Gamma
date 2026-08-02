import { chromium } from 'playwright';
import fs from 'fs';

const SCRATCH = process.cwd();
const SESSION = fs.readFileSync(SCRATCH + '/session.txt', 'utf8').trim();
const BASE = 'http://127.0.0.1:9001';
const PDF_URL = 'https://proceedings.neurips.cc/paper_files/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf';
const VW = 1440, VH = 900;
const beat = (ms) => page.waitForTimeout(ms);

// fake cursor helpers ---------------------------------------------------------
let cx = VW / 2, cy = VH / 2;
async function glide(x, y, steps = 28) {
  await page.mouse.move(x, y, { steps });
  cx = x; cy = y;
  await beat(120);
}
async function typeSlow(sel, text, delay = 55) {
  await page.click(sel);
  await page.type(sel, text, { delay });
}

const browser = await chromium.launch({ headless: true, slowMo: 60 });
const ctx = await browser.newContext({
  colorScheme: 'light',
  viewport: { width: VW, height: VH },
  deviceScaleFactor: 2,
  recordVideo: { dir: SCRATCH + '/video', size: { width: VW, height: VH } },
});
await ctx.addCookies([{ name: 'session', value: SESSION, url: BASE }]);

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

// 1. home ---------------------------------------------------------------------
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.mouse.move(cx, cy);
await beat(900);

// 2. open the paper by URL ----------------------------------------------------
const addBtn = await page.locator('[aria-label="Add"]').boundingBox();
await glide(addBtn.x + addBtn.width / 2, addBtn.y + addBtn.height / 2);
await page.click('[aria-label="Add"]');
await beat(500);
const inp = await page.locator('.addPopover input.searchInput').boundingBox();
await glide(inp.x + 40, inp.y + inp.height / 2);
await page.click('.addPopover input.searchInput');
await beat(300);
await page.fill('.addPopover input.searchInput', PDF_URL);   // pasted in one go, like a human
await beat(650);
await page.press('.addPopover input.searchInput', 'Enter');
console.log('SCRIPT: submitted URL');

// 3. wait for the PDF to render ----------------------------------------------
await page.waitForSelector('[data-page="1"] .textLayer span', { timeout: 60000 });
await beat(3500);

// 4. gentle scroll to settle on the abstract ---------------------------------
await page.evaluate(() => {
  const v = document.querySelector('.pdfViewer');
  if (v) v.scrollTo({ top: 260, behavior: 'smooth' });
});
await beat(1400);

// 5. locate the target sentence & glide the cursor across it ------------------
const sel = await page.evaluate(() => {
  const spans = Array.from(document.querySelectorAll('[data-page="1"] .textLayer span'));
  const startSpan = spans.find(s => s.textContent.includes('We propose a new simple'));
  const endSpan = spans.find(s => s.textContent.trim().startsWith('entirely'));
  if (!startSpan || !endSpan) return null;
  const startNode = startSpan.firstChild;
  const startOff = startSpan.textContent.indexOf('We propose');
  const endNode = endSpan.firstChild;
  const endOff = endSpan.textContent.indexOf('entirely') + 'entirely.'.length;
  const r0 = document.createRange(); r0.setStart(startNode, startOff); r0.setEnd(startNode, startOff + 2);
  const r1 = document.createRange(); r1.setStart(endNode, Math.max(0, endOff - 2)); r1.setEnd(endNode, endOff);
  const a = r0.getBoundingClientRect(), b = r1.getBoundingClientRect();
  return { sx: a.left, sy: a.top + a.height / 2, ex: b.right, ey: b.top + b.height / 2 };
});
if (!sel) { console.log('SCRIPT: SELECTION ANCHORS NOT FOUND'); await browser.close(); process.exit(1); }

// real click-drag across the sentence (human-like: down at the start,
// glide through the lines, release past the end). Native selection follows
// text order, so start→end spans exactly the sentence across the 3 lines.
await glide(sel.sx - 3, sel.sy, 24);
await beat(220);
await page.mouse.down();
await page.mouse.move(sel.sx + (sel.ex - sel.sx) * 0.45, (sel.sy + sel.ey) / 2, { steps: 20 });
await page.mouse.move(sel.ex + 3, sel.ey, { steps: 20 });
await beat(160);
await page.mouse.up();
await beat(220);

// safety net: if the drag missed, set the exact range and re-fire mouseup
const okSel = await page.evaluate(() => {
  const t = window.getSelection()?.toString() || '';
  return t.includes('Transformer') && t.includes('entirely');
});
if (!okSel) {
  console.log('SCRIPT: drag imprecise, correcting selection');
  await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('[data-page="1"] .textLayer span'));
    const startSpan = spans.find(s => s.textContent.includes('We propose a new simple'));
    const endSpan = spans.find(s => s.textContent.trim().startsWith('entirely'));
    const range = document.createRange();
    range.setStart(startSpan.firstChild, startSpan.textContent.indexOf('We propose'));
    range.setEnd(endSpan.firstChild, endSpan.textContent.indexOf('entirely') + 'entirely.'.length);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}
await page.waitForSelector('.plainTip', { timeout: 5000 });
console.log('SCRIPT: color tooltip shown');
await beat(700);

// 7. pick a highlight color (yellow = first swatch) --------------------------
const swatch = await page.locator('.plainTip .colorBtn').first().boundingBox();
await glide(swatch.x + swatch.width / 2, swatch.y + swatch.height / 2, 16);
await page.locator('.plainTip .colorBtn').first().click();
await beat(1600); // highlight paints + note appears in the tree
console.log('SCRIPT: highlight created');

// 8. ask the AI ---------------------------------------------------------------
const chat = await page.locator('.chatInput').boundingBox();
await glide(chat.x + 60, chat.y + chat.height / 2, 30);
await typeSlow('.chatInput', 'explain briefly how attention works', 52);
await beat(500);
await page.press('.chatInput', 'Enter');
console.log('SCRIPT: question sent');

// 9. wait for the answer to stream in ----------------------------------------
await page.waitForSelector('.chatBubbleRow.ai', { timeout: 30000 });
let lastLen = 0, stable = 0;
for (let i = 0; i < 40; i++) {          // up to ~20s
  await beat(500);
  const len = await page.evaluate(() => {
    const el = document.querySelector('.chatBubbleRow.ai:last-of-type');
    return el ? el.innerText.length : 0;
  });
  if (len > 120 && len === lastLen) { stable++; if (stable >= 3) break; } else { stable = 0; }
  lastLen = len;
}
console.log('SCRIPT: answer length', lastLen);
await beat(2200); // let the reader see the answer

const video = page.video();
await ctx.close();               // finalizes the video file
const vpath = await video.path();
fs.writeFileSync(SCRATCH + '/video_path.txt', vpath);
console.log('SCRIPT: video saved', vpath);
await browser.close();
