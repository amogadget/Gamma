// Records the agent source for demo-annotate-and-ask.webp: ask the chat to organize
// the library into folders, tool chips stream, folders appear in the list.
import { chromium, configureContext } from './runtime.mjs';
import fs from 'fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:9002';
const SESSION = fs.readFileSync('session.txt', 'utf8').trim();
const CURSOR = () => addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;z-index:99999;width:14px;height:14px;'
    + 'border-radius:50%;background:rgba(0,0,0,.45);border:2px solid #fff;'
    + 'pointer-events:none;margin:-8px 0 0 -8px;transition:transform .05s';
  document.body.appendChild(c);
  addEventListener('mousemove', e => c.style.transform =
    `translate(${e.clientX}px,${e.clientY}px)`, true);
});

const browser = await chromium.launch({ slowMo: 0 });
const context = await browser.newContext({
  colorScheme: 'light',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  recordVideo: { dir: 'video-agent', size: { width: 1440, height: 900 } },
});
await configureContext(context);
await context.addCookies([{ name: 'session', value: SESSION, url: BASE }]);
const page = await context.newPage();
await page.addInitScript(CURSOR);
const tPage = Date.now();
await page.goto(BASE + '/');
await page.click('[aria-label="Home"]');
await page.waitForSelector('.chatInput', { timeout: 30000 });
await page.waitForTimeout(2500);

// --- action starts here ---
const m0 = (Date.now() - tPage) / 1000;
const input = page.locator('.chatInput');
const box = await input.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 35 });
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(500);
await input.fill('Organize my papers into Quantum computing and Machine learning folders. Move each paper, then summarize in one sentence.');
await page.waitForTimeout(900);
await page.keyboard.press('Enter');

// wait for the agent: tool chips appear, then the answer settles
await page.waitForSelector('.chatToolAction', { timeout: 120000 });
let stable = 0, last = -1;
for (let i = 0; i < 240 && stable < 4; i++) {
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => ({
    len: [...document.querySelectorAll('.chatBubbleRow.ai')].map(e => e.innerText.length).reduce((a, b) => a + b, 0),
    typing: !!document.querySelector('.chatTyping'),
  }));
  if (!st.typing && st.len === last && st.len > 0) stable++; else stable = 0;
  last = st.len;
}
await page.waitForTimeout(1500);
// glide over the library so the new folders get a moment of attention
const folder = page.locator('.homeList, main').first();
try {
  const fb = await page.locator('text=New folder').first().boundingBox();
  if (fb) await page.mouse.move(fb.x + 40, fb.y + 120, { steps: 40 });
} catch {}
await page.waitForTimeout(2500);
const mEnd = (Date.now() - tPage) / 1000;

if (await page.locator('.chatBubble.ai.error').count()) throw new Error('Agent failed');
await page.screenshot({ path: 'agent-final.png' });
await context.close();
const video = page.video();
const vpath = await video.path();
fs.writeFileSync('video_agent.txt', vpath);
fs.writeFileSync('agent_marks.json', JSON.stringify({ m0, mEnd }));
await browser.close();
console.log('video:', vpath, 'm0:', m0, 'mEnd:', mEnd);
