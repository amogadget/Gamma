import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
export const { chromium } = require('playwright');

export async function renderPng(browser, svg, width, height, transparent = true) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    // Rendering is offline: no Google Fonts or other network dependencies.
    await page.route('**/*', route => route.abort());
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
    await page.evaluate(() => document.fonts.ready);
    return await page.screenshot({ omitBackground: transparent });
  } finally {
    await page.close();
  }
}
