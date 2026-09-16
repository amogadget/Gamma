// Resolve the existing frontend toolchain without a second node_modules tree.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
export const { chromium } = require('playwright');

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
