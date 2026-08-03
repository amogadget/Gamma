import { chromium } from 'playwright';
import fs from 'fs';

const SCRATCH = process.cwd();
const SESSION = fs.readFileSync(SCRATCH + '/session.txt', 'utf8').trim();
const BASE = 'http://127.0.0.1:9001';
const BLOCK = 'fy0-h_BqOHcH';        // "A quantum processor based on coherent transport of entangled atom arrays"
const VW = 1440, VH = 900;
const beat = (ms) => page.waitForTimeout(ms);

// NOTE: the page is NEVER zoomed in-app. A smooth "camera" zoom is applied to
// the GIF afterwards (gen-zoom.py) using the marks + ROIs captured below.

let cx = VW / 2, cy = VH / 2;
async function glide(x, y, steps = 26) { await page.mouse.move(x, y, { steps }); cx = x; cy = y; await beat(120); }

async function citationAnchor() {
  return await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('[data-page="3"] .textLayer span')).find(x => x.textContent.includes('36,37'));
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}
async function centerCitation() {
  await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('[data-page="3"] .textLayer span')).find(x => x.textContent.includes('36,37'));
    s?.scrollIntoView({ block: 'center' });
  });
  await beat(600);
}
async function findCiteBox() {
  return await page.evaluate(() => {
    const span = Array.from(document.querySelectorAll('[data-page="3"] .textLayer span')).find(x => x.textContent.includes('36,37'));
    if (!span) return null;
    const sr = span.getBoundingClientRect();
    const boxes = Array.from(document.querySelectorAll('[data-page="3"] .pdfLinkBox'))
      .filter(b => (b.getAttribute('title') || '') === 'Jump to reference')
      .map(b => ({ r: b.getBoundingClientRect() }))
      .filter(o => o.r.top < sr.bottom && o.r.bottom > sr.top && o.r.left >= sr.left - 4 && o.r.left <= sr.right + 4)
      .sort((a, z) => a.r.left - z.r.left);
    if (!boxes.length) return null;
    const r = boxes[0].r;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}
async function centerRef() {
  await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('.textLayer span')).find(x => x.textContent.includes('Gottesman'));
    s?.scrollIntoView({ block: 'center' });
  });
  await beat(800);
}
async function refNumberBox() {
  return await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('.textLayer span'));
    const g = spans.find(s => s.textContent.includes('Gottesman'));
    if (!g) return null;
    const gr = g.getBoundingClientRect();
    const cand = spans.filter(s => /^36\.?\s*$/.test(s.textContent.trim()))
      .map(s => ({ r: s.getBoundingClientRect() }))
      .filter(o => o.r.left < gr.left && Math.abs(o.r.top - gr.top) < gr.height * 1.3)
      .sort((a, z) => Math.abs(a.r.top - gr.top) - Math.abs(z.r.top - gr.top));
    if (!cand.length) return null;
    const r = cand[0].r;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}
async function selectNumberProg() {
  return await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('.textLayer span'));
    const g = spans.find(s => s.textContent.includes('Gottesman'));
    if (!g) return false;
    const gr = g.getBoundingClientRect();
    const num = spans.filter(s => /^36\.?\s*$/.test(s.textContent.trim()))
      .filter(s => Math.abs(s.getBoundingClientRect().top - gr.top) < gr.height * 1.3)[0];
    if (!num || !num.firstChild) return false;
    const range = document.createRange();
    range.setStart(num.firstChild, 0);
    range.setEnd(num.firstChild, num.textContent.replace(/\s+$/, '').length);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  });
}
async function getArxiv() {
  return await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.pdfLinkBox')).find(b => (b.getAttribute('title') || '').includes('0904.2557'));
    if (!el) return null;
    const t = el.getBoundingClientRect();
    if (!(t.top > 40 && t.top < window.innerHeight - 40)) el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}
async function clickArxiv() {
  return await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.pdfLinkBox')).find(b => (b.getAttribute('title') || '').includes('0904.2557'));
    if (!el) return false; el.click(); return true;
  });
}

const browser = await chromium.launch({ headless: true, slowMo: 60 });
const ctx = await browser.newContext({
  colorScheme: 'light', viewport: { width: VW, height: VH }, deviceScaleFactor: 2,
  recordVideo: { dir: SCRATCH + '/video-links', size: { width: VW, height: VH } }, // CSS = video 1:1 (2x size mis-maps the frame)
});
await ctx.addCookies([{ name: 'session', value: SESSION, url: BASE }]);
await ctx.addInitScript(() => {
  window.addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.style.cssText = 'position:fixed;z-index:2147483647;width:16px;height:16px;border-radius:50%;'
      + 'background:rgba(20,20,20,.35);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);'
      + 'pointer-events:none;left:0;top:0;margin:-9px 0 0 -9px;transition:transform .05s linear';
    document.body.appendChild(c);
    addEventListener('mousemove', e => c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`, true);
    addEventListener('mousedown', () => c.style.background = 'rgba(60,120,255,.6)', true);
    addEventListener('mouseup', () => c.style.background = 'rgba(20,20,20,.35)', true);
  });
});

const page = await ctx.newPage();
const T0 = Date.now();
const mark = () => (Date.now() - T0) / 1000;
const M = {};
page.on('console', m => { const t = m.text(); if (t.startsWith('SCRIPT:')) console.log(t); });

// --- open the paper & settle on the page-3 citation (NORMAL scale) -----------
await page.goto(`${BASE}/?block=${BLOCK}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-page="1"] .textLayer span', { timeout: 60000 });
await beat(1000);
await page.evaluate(() => document.querySelector('[data-page="3"]')?.scrollIntoView());
await page.waitForSelector('[data-page="3"] .textLayer span', { timeout: 20000 });
await beat(600);
await centerCitation();
const R1 = await citationAnchor();
await glide(R1.x, R1.y, 22);
M.m0 = mark();                    // camera zoom-in begins here (≈ show citation)
await beat(1400);                 // let the GIF zoom-in animation play over the citation
console.log('SCRIPT: citation ready');

// --- click "36" once → jumps to the reference -------------------------------
let box = await findCiteBox();
if (!box) { console.log('SCRIPT: 36 box not found'); await browser.close(); process.exit(1); }
await glide(box.x, box.y, 16);
await beat(300);
await page.mouse.click(box.x, box.y);
await beat(1600);
await centerRef();
await beat(400);
console.log('SCRIPT: jumped to reference');

// --- select just the "36." reference number ---------------------------------
const R2 = await refNumberBox();
if (!R2) { console.log('SCRIPT: "36" number not found'); await browser.close(); process.exit(1); }
await glide(R2.x, R2.y, 22);
await beat(300);
await selectNumberProg();
await beat(1600);
console.log('SCRIPT: "36" selected');

// --- click the arXiv link → External link modal → Fetch into Gamma ----------
const ax = await getArxiv();
if (!ax) { console.log('SCRIPT: arxiv not found'); await browser.close(); process.exit(1); }
await glide(ax.x, ax.y, 24);
await beat(300);
await clickArxiv();
await page.waitForSelector('.confirmModal', { timeout: 6000 });
await beat(1100);
console.log('SCRIPT: external-link modal shown');
const fetchBtn = await page.locator('button:has-text("Fetch into Gamma")').boundingBox();
await glide(fetchBtn.x + fetchBtn.width / 2, fetchBtn.y + fetchBtn.height / 2, 22);
await beat(300);
await page.locator('button:has-text("Fetch into Gamma")').click();
console.log('SCRIPT: fetch clicked, resolving…');

let loaded = false;
for (let i = 0; i < 30; i++) {
  await beat(400);
  const b = await page.evaluate(() => new URL(location.href).searchParams.get('block'));
  if (b && b !== BLOCK) { loaded = true; break; }
}
await page.waitForSelector('[data-page="1"] .textLayer span', { timeout: 20000 }).catch(() => {});
await beat(400);
M.mFetch = mark();               // camera zoom-out begins here (reveal the fetched paper)
await beat(1700);
M.tEnd = mark();
console.log('SCRIPT: new paper loaded =', loaded);

// persist marks + ROIs for the post zoom
fs.writeFileSync(SCRATCH + '/links_zoom.json', JSON.stringify({
  cssW: VW, cssH: VH, vidW: VW, vidH: VH,
  m0: M.m0, mFetch: M.mFetch, tEnd: M.tEnd,
  R1, R2,
}, null, 2));

const video = page.video();
await ctx.close();
const vpath = await video.path();
fs.writeFileSync(SCRATCH + '/video_links_path.txt', vpath);
console.log('SCRIPT: video saved', vpath);
await browser.close();
