// README "Take notes" demo: a bare note page typed into, Obsidian-style live
// preview — markdown marks, a [[ref]] chip, then a display equation typed
// char by char ($ auto-pairing, \command autocomplete, Tab through {} args,
// live math preview), then a callout, picture paste and drag resize.
//
// Run from a dir holding session.txt (the `session` cookie for BASE). Expects
// an EMPTY page PAGE_ID (reset: PUT /api/blocks/{id}/children {"blocks":[]}).
// Writes the webm path to video_path.txt and the pre-roll trim mark to
// notes_marks.json (m0 = video-time of the first click).
import { chromium, configureContext } from './runtime.mjs';
import fs from 'fs';

const SCRATCH = process.cwd();
const SESSION = fs.readFileSync(SCRATCH + '/session.txt', 'utf8').trim();
const BASE = process.env.BASE_URL || 'http://127.0.0.1:9002';
const PAGE_ID = process.env.PAGE_ID || 'QDz3vbdoRlFJ';
const VW = 1440, VH = 900;
const CHROME = process.env.CHROME_PATH;
const beat = (ms) => page.waitForTimeout(ms * 0.7);

// typing: prose ~55 ms/key, math a touch slower so the reader can follow
const PROSE = 28, MATH = 38;
const T = (text, delay = PROSE) => page.keyboard.type(text, { delay });
const K = (key) => page.keyboard.press(key);
const value = () => page.evaluate(() => document.querySelector('.cm-content')?.textContent ?? null);

// Tab / Shift+Tab re-parent the block, which remounts its row and closes the
// editor (headless quirk). Re-open it in place with a synthetic mousedown on
// the still-focused row — no pointer movement, the caret simply comes back.
async function reopenFocused() {
  await page.waitForSelector('.blockRow.focused');
  await page.evaluate(() => {
    const row = document.querySelector('.blockRow.focused');
    const body = row.querySelector('.blockBody') || row;
    const r = body.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + 40, clientY: r.top + r.height / 2 }));
  });
  await page.waitForSelector('.blockEditorCm .cm-content');
}

let cx = VW / 2, cy = VH / 2;
async function glide(x, y, steps = 28) {
  await page.mouse.move(x, y, { steps });
  cx = x; cy = y;
  await beat(120);
}

const browser = await chromium.launch({ headless: true, slowMo: 0, executablePath: CHROME });
const ctx = await browser.newContext({
  colorScheme: 'light',
  viewport: { width: VW, height: VH },
  deviceScaleFactor: 2,
  recordVideo: { dir: SCRATCH + '/video', size: { width: VW, height: VH } },
});
await configureContext(ctx);
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
await ctx.addCookies([{ name: 'session', value: SESSION, url: BASE }]);

// UI scale: the note text is the whole story, so render it like a 125%-zoomed
// window (standard CSS zoom on <html>; layout + rects follow, popups too).
const ZOOM = process.env.ZOOM || '1.25';
await ctx.addInitScript((zoom) => {
  // Enter = new block (Settings → Notes); the default is Shift+Enter.
  try { localStorage.setItem('gamma-enter-new-note', '1'); } catch {}
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.style.zoom = zoom;
    const c = document.createElement('div');
    c.id = '__fakecur';
    c.style.cssText = 'position:fixed;z-index:2147483647;width:16px;height:16px;'
      + 'border-radius:50%;background:rgba(20,20,20,.35);border:2px solid #fff;'
      + 'box-shadow:0 1px 4px rgba(0,0,0,.4);pointer-events:none;left:0;top:0;'
      + 'margin:-9px 0 0 -9px;transition:transform .05s linear';
    document.body.appendChild(c);
    // the dot lives inside the zoomed <html>, so its CSS px are zoom× bigger
    // than the pointer's viewport px — divide to land it under the pointer
    const z = Number(zoom) || 1;
    document.addEventListener('mousemove', e => {
      c.style.transform = `translate(${e.clientX / z}px,${e.clientY / z}px)`;
    }, true);
    const rest = () => { c.style.background = 'rgba(20,20,20,.35)'; };
    // flash blue on click; the editor swallows some mouseups, so also time out
    document.addEventListener('mousedown', () => { c.style.background = 'rgba(60,120,255,.6)'; setTimeout(rest, 300); }, true);
    document.addEventListener('mouseup', rest, true);
  });
}, ZOOM);

const page = await ctx.newPage();
try {
const t0 = Date.now();
page.on('console', m => { const t = m.text(); if (t.startsWith('SCRIPT:')) console.log(t); });

// 0. open the empty page; close the chat dock so the notes take the width ---
await page.goto(BASE + '/?page=' + PAGE_ID, { waitUntil: 'networkidle' });
await page.mouse.move(cx, cy);
await beat(600);
if (await page.locator('[aria-label="Close Chat"]').count()) {
  await page.click('[aria-label="Close Chat"]');
  await beat(700);
}
await page.waitForSelector('.blockRow');
await beat(800);

// 1. click the empty first block ---------------------------------------------
const row = await page.locator('.blockRow').first().boundingBox();
await glide(row.x + 120, row.y + row.height / 2 + 6, 30);
await beat(250);
const m0 = (Date.now() - t0) / 1000;
await page.mouse.click(cx, cy);
await page.waitForSelector('.blockEditorCm .cm-content');
await glide(row.x + 120, row.y + 420, 24);   // park the pointer well below the text
await beat(400);

// 2. markdown that renders as the caret leaves each construct ----------------
await T('A **two-level atom** driven on resonance undergoes ==Rabi oscillations==, cf. [[quantum processor');
await page.waitForSelector('.refPopup .refPopupEntry', { timeout: 5000 });
await beat(900);
await K('Enter');                                  // [[ref]] chip
await beat(250);
await T('.');
console.log('SCRIPT: block 1 =', await value());
await beat(700);

// 3. new block, nested, the equation -----------------------------------------
await K('Enter');
await beat(450);
await K('Tab');
await beat(350);
await reopenFocused();
await beat(500);
await T('$', 220); await beat(350);                // $|$
await T('$', 220); await beat(500);                // $$|$$
console.log('SCRIPT: after $$ =', await value());
await T('H = \\fr', MATH);
await page.waitForSelector('.latexAcPopup', { timeout: 4000 });
await beat(1000);                                  // let the popup be seen
await K('Tab');                                    // accept → \frac{|}{}
await beat(500);
await T('\\hbar\\Omega', MATH);
await beat(500);                                   // popup: Ω \Omega
await T(' ', MATH);                                // a space dismisses it
await beat(300);
await K('Tab');                                    // hop to the 2nd {}
await beat(350);
await T('2', MATH);
await beat(350);
await K('Tab');                                    // out past the closer
await beat(400);
await T(' \\left(', MATH);                         // ( auto-pairs → \left(|)
await beat(500);
await T('|e\\rangle\\langle g| + |g\\rangle\\langle e|', MATH);
await beat(900);                                   // live preview moment
await K('Tab');                                    // hop over the auto-paired \right)
await beat(300);
await T(' - \\hbar\\Delta\\,|e\\rangle\\langle e|', MATH);
console.log('SCRIPT: equation =', await value());
await beat(1200);

// 4. leave the equation, one callout below -----------------------------------
await K('End');                                    // past the closing $$
await beat(300);
await K('Enter');
await beat(400);
await K('Shift+Tab');
await beat(350);
await reopenFocused();
await beat(500);
await T('> [!note] Resonant driving');
await beat(300);
await K('Shift+Enter');                            // line break; "> " continues
await beat(300);
await T('Population oscillates as $P_e(t) = \\sin^2(\\Omega t/2)$.');
console.log('SCRIPT: callout =', await value());
await beat(900);

// 5. Paste a PNG plot through the real clipboard and editor upload handler.
// Plot the same analytic function as the note; no external image is needed.
await K('Enter');
await beat(400);
await page.evaluate(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 680; canvas.height = 280;
  const g = canvas.getContext('2d');
  g.fillStyle = '#f8fafc'; g.fillRect(0, 0, 680, 280);
  g.fillStyle = '#0f172a'; g.font = '600 19px Arial';
  g.fillText('Resonant Rabi oscillations', 58, 32);
  const x = t => 58 + t / (4 * Math.PI) * 590;
  const y = p => 222 - p * 164;
  g.font = '14px Arial';
  for (const p of [0, 0.5, 1]) {
    g.strokeStyle = '#dbe3ee'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(58, y(p)); g.lineTo(648, y(p)); g.stroke();
    g.fillStyle = '#475569'; g.fillText(String(p), 25, y(p) + 5);
  }
  for (let n = 0; n <= 4; n++) {
    g.fillText(n === 0 ? '0' : `${n === 1 ? '' : n}π`, x(n * Math.PI) - 8, 246);
  }
  g.fillText('Ωt', 340, 271); g.fillText('Pₑ', 20, 55);
  g.strokeStyle = '#2563eb'; g.lineWidth = 3; g.beginPath();
  for (let i = 0; i <= 600; i++) {
    const t = i / 600 * 4 * Math.PI;
    if (i === 0) g.moveTo(x(t), y(0));
    else g.lineTo(x(t), y(Math.sin(t / 2) ** 2));
  }
  g.stroke();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
});
const paste = (Date.now() - t0) / 1000;
await K('Control+v');
await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('/api/uploads/'));
await beat(500);
// Click away to render the pasted image and expose its hover resize grip.
await glide(1320, 800, 30);
await beat(200);
await page.mouse.click(cx, cy);
await page.waitForSelector('.blockEditorCm', { state: 'detached', timeout: 5000 });
const picture = page.locator('.mdImg').last();
await picture.waitFor();
await picture.evaluate(img => img.decode());
await picture.scrollIntoViewIfNeeded();
await beat(1200);
const before = await picture.boundingBox();
await glide(before.x + before.width - 4, before.y + before.height / 2, 30);
const grip = await page.locator('.mdImgResize').last().boundingBox();
await glide(grip.x + grip.width / 2, grip.y + grip.height / 2, 20);
await beat(600);
const resize = (Date.now() - t0) / 1000;
await page.mouse.down();
const startX = cx;
for (let i = 1; i <= 45; i++) {
  await page.mouse.move(startX - 400 * i / 45, cy);
  await page.waitForTimeout(24);
}
await page.mouse.up();
await beat(600);
await glide(1320, 170, 25);
const after = await picture.boundingBox();
if (after.width >= before.width - 100) throw new Error('Picture did not visibly shrink');
await beat(2200);
const m1 = (Date.now() - t0) / 1000;
await page.screenshot({ path: SCRATCH + '/notes-final.png' });
const savedWidth = await picture.getAttribute('width');
const savedSrc = await picture.getAttribute('src');
await page.reload({ waitUntil: 'networkidle' });
await picture.waitFor();
await picture.evaluate(img => img.decode());
if (await picture.getAttribute('width') !== savedWidth || await picture.getAttribute('src') !== savedSrc) {
  throw new Error('Pasted picture or resized width did not persist after reload');
}
await page.screenshot({ path: SCRATCH + '/notes-reloaded.png' });
fs.writeFileSync(SCRATCH + '/notes-verified.json', JSON.stringify({ savedWidth, savedSrc, before, after, persisted: true }, null, 2));

const video = page.video();
await ctx.close();
const vpath = await video.path();
fs.writeFileSync(SCRATCH + '/video_path.txt', vpath);
fs.writeFileSync(SCRATCH + '/notes_marks.json', JSON.stringify({ m0, paste, resize, m1, cropHeight: 820 }));
console.log('SCRIPT: video saved', vpath, 'm0', m0.toFixed(2), 'm1', m1.toFixed(2));
} catch (error) {
  await page.screenshot({ path: SCRATCH + '/notes-error.png' });
  throw error;
} finally {
  await ctx.close();
  await browser.close();
}
