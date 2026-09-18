// Render the canonical SVGs; no generated HTML wrappers or browser profiles.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, ROOT } from './runtime.mjs';

if (process.argv.includes('--publish-hero')) {
  throw new Error('Publish through node tools/branding/build.mjs so the provenance check stays in sync.');
}

const output = path.join(ROOT, 'artifacts/branding');
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  for (const name of ['hero', 'connections', 'workspaces', 'library']) {
    for (const theme of ['light', 'dark']) {
      const stem = `gamma-${name}-${theme}`;
      await page.goto(pathToFileURL(path.join(ROOT, `docs/assets/branding/${stem}.svg`)).href);
      await page.evaluate(() => document.fonts.ready);
      const destination = path.join(output, `${stem}.png`);
      await page.screenshot({ path: destination });
      console.log(path.relative(ROOT, destination));
    }
  }
} finally {
  await browser.close();
}
