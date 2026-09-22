// Resolve the existing frontend toolchain without a second node_modules tree.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
export const { chromium } = require('playwright');

// The Gamma server a recorder talks to; run-case.mjs sets it per case.
export const BASE = process.env.BASE_URL || 'http://127.0.0.1:9001';
// Curated demo pages the shots are written against.
export const CURATED = { atoms: 'fy0-h_BqOHcH', qec: 'BHuT16WnxdQb' };

// The `session` cookie value the suite runner writes next to a recording.
export function readSession(dir = process.cwd()) {
  return fs.readFileSync(path.join(dir, 'session.txt'), 'utf8').trim();
}

// Playwright videos have no pointer: draw a dot that follows the mouse and
// darkens while a button is down. `zoom` is the CSS zoom the page applies to
// <html> (the dot lives inside it, so its CSS px are zoom× the pointer's).
export function addCursor(context, { zoom = 1 } = {}) {
  return context.addInitScript((zoom) => {
    window.addEventListener('DOMContentLoaded', () => {
      const c = document.createElement('div');
      c.id = '__fakecur';
      c.style.cssText = 'position:fixed;z-index:2147483647;width:16px;height:16px;'
        + 'border-radius:50%;background:rgba(20,20,20,.35);border:2px solid #fff;'
        + 'box-shadow:0 1px 4px rgba(0,0,0,.4);pointer-events:none;left:0;top:0;'
        + 'margin:-9px 0 0 -9px;transition:transform .05s linear';
      document.body.appendChild(c);
      const z = Number(zoom) || 1;
      document.addEventListener('mousemove', e => { c.style.transform = `translate(${e.clientX / z}px,${e.clientY / z}px)`; }, true);
      const rest = () => { c.style.background = 'rgba(20,20,20,.35)'; };
      // flash blue on click; an editor may swallow the mouseup, so also time out
      document.addEventListener('mousedown', () => { c.style.background = 'rgba(60,120,255,.6)'; setTimeout(rest, 300); }, true);
      document.addEventListener('mouseup', rest, true);
    });
  }, zoom);
}

// Eased pointer travel that remembers where the pointer is (`at()`), for the
// recorders that click or drag from the last glided-to spot.
export function pointer(page, x = 0, y = 0) {
  const glide = async (tx, ty, steps = 28) => {
    await page.mouse.move(tx, ty, { steps });
    x = tx; y = ty;
    await page.waitForTimeout(120);
  };
  const glideTo = async (target, fx = 0.5, fy = 0.5, steps = 28) => {
    const locator = typeof target === 'string' ? page.locator(target).first() : target;
    const b = await locator.boundingBox();
    if (!b) throw new Error('no box for ' + (typeof target === 'string' ? target : 'locator'));
    await glide(b.x + b.width * fx, b.y + b.height * fy, steps);
    return b;
  };
  return { glide, glideTo, at: () => ({ x, y }) };
}

// Optional recording workspace; applied before Gamma reads the initial URL.
export async function configureContext(context) {
  const workspace = process.env.MEDIA_WORKSPACE;
  if (workspace) await context.addInitScript(({ workspace, base }) => {
    if (location.origin !== new URL(base).origin) return;
    const url = new URL(location.href);
    url.searchParams.set('ws', workspace);
    history.replaceState(null, '', url);
  }, { workspace, base: process.env.BASE_URL });
  context.on('page', page => {
    page.setDefaultTimeout(20000);
    const move = page.mouse.move.bind(page.mouse);
    let px = 0, py = 0;
    page.mouse.move = async (x, y, options = {}) => {
      if (options.steps > 1) {
        const frames = 20, duration = 320, start = performance.now();
        const ox = px, oy = py;
        for (let i = 1; i <= frames; i++) {
          const u = i / frames, e = u*u*(3-2*u);
          await move(ox + (x-ox)*e, oy + (y-oy)*e);
          const wait = start + duration*i/frames - performance.now();
          if (wait > 0) await page.waitForTimeout(wait);
        }
      } else await move(x, y);
      px = x; py = y;
    };
  });
}
