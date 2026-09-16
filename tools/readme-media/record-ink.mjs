// Draw through Gamma's real UI in an isolated copy of a curated workspace.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium, ROOT } from './runtime.mjs';
import { Server, Account } from '../../frontend/tests/e2e/harness.mjs';

const scratch = path.resolve(process.env.MEDIA_SCRATCH || path.join(ROOT, 'tmp/readme-media'));
const archive = process.env.DEMO_EXPORT || path.join(scratch, 'demo.zip');
if (!fs.existsSync(archive)) throw new Error('Set DEMO_EXPORT to an API export of the curated demo workspace. See README.md.');
fs.mkdirSync(scratch, { recursive: true });
const server = new Server();
let browser, context, page;
const W = 1440, H = 900;
try {
  await server.start();
  server.manage('create-user', 'media-demo', 'isolated-media-only');
  const account = await new Account(server, 'media-demo', 'isolated-media-only').login();
  await account.upload('/api/import-data', fs.readFileSync(archive), 'demo.zip', 'application/zip');
  browser = await chromium.launch({ headless: true });
  context = await account.context(browser, {
    viewport: { width: W, height: H }, colorScheme: 'light', deviceScaleFactor: 2,
    recordVideo: { dir: path.join(scratch, 'video-ink'), size: { width: W, height: H } },
  });
  await context.addInitScript(() => {
    localStorage.setItem('gamma-ink-tools', '');
    addEventListener('DOMContentLoaded', () => {
      const c = document.createElement('div');
      c.id = 'media-cursor';
      c.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;border:2px solid white;border-radius:50%;background:#2563eb;box-shadow:0 1px 5px #0004;pointer-events:none;z-index:999999;opacity:0;';
      document.body.append(c);
      addEventListener('pointermove', e => { c.style.opacity = '1'; c.style.transform = `translate(${e.clientX - 5}px,${e.clientY - 5}px)`; }, true);
      addEventListener('pointerdown', () => { c.style.background = '#1e40af'; }, true);
      addEventListener('pointerup', () => { c.style.background = '#2563eb'; }, true);
    });
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const start = performance.now();
  const at = () => (performance.now() - start) / 1000;
  const marks = {};
  const pageId = process.env.PAGE_ID || 'fy0-h_BqOHcH';
  await page.goto(`${server.base}/?page=${pageId}&ws=${account.ws}`);
  await page.locator('[data-page="1"] .textLayer span').first().waitFor({ timeout: 60000 });
  const chatClose = page.getByRole('button', { name: 'Close Chat', exact: true });
  if (await chatClose.isVisible()) await chatClose.click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Handwriting tools', exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(scratch, 'ink-setup.png') });
  const spans = await page.locator('[data-page="1"] .textLayer span').evaluateAll(es => es.map(e => { const b = e.getBoundingClientRect(); return { text: e.textContent, x: b.x, y: b.y, w: b.width, h: b.height }; }).filter(e => e.y > 50 && e.y < 900));
  fs.writeFileSync(path.join(scratch, 'ink-layout.json'), JSON.stringify({ spans, buttons: await page.locator('.pdfInkBar button').evaluateAll(es => es.map(e => e.getAttribute('aria-label'))) }, null, 2));
  if (!process.argv.includes('--inspect')) {
    let pointer = [980, 820];
    await page.mouse.move(...pointer);
    // Time-paced samples, not Playwright's unpaced `steps`: retain smooth motion
    // even on a fast machine. Drawing follows its path; transit uses smoothstep.
    async function motion(points, duration, ease = false) {
      const t0 = performance.now();
      const n = Math.ceil(duration / 16);
      for (let i = 1; i <= n; i++) {
        let u = i / n;
        if (ease) u = u * u * (3 - 2 * u);
        const p = u * (points.length - 1), j = Math.min(points.length - 2, Math.floor(p)), f = p - j;
        pointer = points[j].map((v, k) => v + (points[j + 1][k] - v) * f);
        await page.mouse.move(...pointer);
        const remaining = t0 + duration * i / n - performance.now();
        if (remaining > 0) await page.waitForTimeout(remaining);
      }
    }
    const glide = (to, ms = 320) => motion([pointer, to], ms, true);
    async function click(locator) {
      const b = await locator.boundingBox();
      if (!b) throw new Error('Demo target is not visible');
      await glide([b.x + b.width / 2, b.y + b.height / 2]);
      await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up();
      await page.waitForTimeout(100);
    }
    async function stroke(points, ms) {
      await glide(points[0], 220);
      await page.mouse.down(); await motion(points, ms); await page.mouse.up();
      await page.waitForTimeout(100);
    }
    async function count(n) { await page.waitForFunction(n => document.querySelectorAll('[data-page="1"] .inkLayer path').length === n, n); }
    // Hand-plotted gestures, gently interpolated: uneven spacing, an open seam,
    // and a curved arrow instead of a mathematical ellipse and straight segments.
    function freehand(points) {
      const out = [];
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[Math.max(0, i - 1)], b = points[i], c = points[i + 1], d = points[Math.min(points.length - 1, i + 2)];
        for (let j = 0; j < 8; j++) {
          const t = j / 8;
          out.push(b.map((v, k) => 0.5 * ((2*v) + (-a[k]+c[k])*t + (2*a[k]-5*v+4*c[k]-d[k])*t*t + (-a[k]+3*v-3*c[k]+d[k])*t*t*t)));
        }
      }
      return [...out, points.at(-1)];
    }
    marks.start = at();
    await page.waitForTimeout(300);
    await click(page.locator('.pdfInkBar button[aria-label^="Pen #1d4ed8"]'));
    marks.draw = at();
    await stroke(freehand([[755,480],[721,475],[661,474],[596,477],[557,484],[552,493],[587,501],[654,503],[718,500],[760,492],[769,484],[757,479]]), 1050);
    await stroke(freehand([[268,527],[284,511],[312,497],[340,490],[365,491]]), 620);
    await stroke(freehand([[355,482],[368,491],[354,500]]), 270);
    await count(3);
    await page.locator('.blockInkCard').first().waitFor();
    marks.highlight = at();
    await click(page.locator('.pdfInkBar button[aria-label^="Highlighter #fde047"]'));
    await stroke(freehand([[380,561],[444,559],[531,560],[627,561],[730,559],[822,560]]), 950);
    await count(4);
    await click(page.getByRole('button', { name: 'Hand', exact: true }));
    marks.notes = at();
    await glide([1170, 320], 420);
    await page.waitForTimeout(1400);
    marks.end = at();
    await page.screenshot({ path: path.join(scratch, 'ink-final.png') });
    // Verify that the on-screen ink really persisted, then reload off camera.
    await page.waitForFunction(() => document.querySelectorAll('.blockInkCard').length > 0);
    let saved;
    for (let i = 0; i < 40; i++) {
      const tree = await account.api(`/api/blocks/${pageId}/subtree`);
      saved = tree.block.children?.find(b => b.properties?.ink_strokes === 4 && b.properties?.ink_url?.endsWith('.ink'));
      if (saved) break;
      await page.waitForTimeout(150);
    }
    if (!saved) throw new Error('Four strokes were not saved to a real ink block');
    const ink = await account.api(saved.properties.ink_url);
    if (ink.strokes.filter(s => s.tool === 'pen').length !== 3) throw new Error('Three pen strokes were not saved');
    if (!ink.strokes.some(s => s.tool === 'highlighter')) throw new Error('Highlighter was not saved');
    await page.reload();
    await count(4);
    const video = page.video();
    await context.close(); context = null;
    const videoPath = await video.path();
    fs.writeFileSync(path.join(scratch, 'ink-timeline.json'), JSON.stringify({ video: videoPath, width: W, height: H, marks, verified: { strokes: 4, pen: 3, highlighter: true, reload: true } }, null, 2));
    console.log('Recorded ink demo; three pen strokes, highlight and reload verified.');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  if (process.argv.includes('--inspect')) console.log('Inspected curated paper; see ink-setup.png and ink-layout.json.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(scratch, 'ink-failure.png') }).catch(() => {});
  throw error;
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  await server.stop();
}
