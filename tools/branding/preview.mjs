// Capture and check the standalone color study, without starting Gamma.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, ROOT } from '../readme-media/runtime.mjs';

const output = path.join(ROOT, 'artifacts/theme-preview');
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(pathToFileURL(path.join(ROOT, 'docs/design/gamma-theme/index.html')).href);
  await page.evaluate(() => document.fonts.ready);
  for (const palette of ['current', 'hero']) {
    await page.locator(`[data-palette-choice="${palette}"]`).click();
    for (const theme of ['light', 'dark']) {
      await page.locator(`[data-theme-choice="${theme}"]`).click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert.equal(await page.locator('html').getAttribute('data-palette'), palette);
      const contrast = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const get = token => style.getPropertyValue(token).trim();
        const luminance = hex => {
          let digits = hex.slice(1);
          if (digits.length === 3) digits = [...digits].map(x => x + x).join('');
          return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16) / 255)
            .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
            .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
        };
        const ratio = (a, b) => {
          const values = [luminance(get(a)), luminance(get(b))].sort((a, b) => b - a);
          return (values[0] + .05) / (values[1] + .05);
        };
        return {
          body: ratio('--text-primary', '--bg-surface'),
          muted: ratio('--text-muted', '--bg-page'),
          link: ratio('--accent', '--bg-surface'),
          button: ratio('--on-accent', '--accent'),
        };
      });
      if (palette === 'hero') {
        for (const [role, ratio] of Object.entries(contrast)) {
          assert(ratio >= 4.5, `${theme} ${role} contrast is only ${ratio.toFixed(2)}`);
        }
        console.log(`${theme} contrast: ${JSON.stringify(contrast)}`);
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Desktop overflow');
      await page.screenshot({ path: path.join(output, `${palette}-${theme}.png`), fullPage: true });
    }
  }
  await page.locator('#ask-button').click();
  assert(await page.locator('#preview-message').isVisible());
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ['light', 'dark']) {
    await page.locator(`[data-theme-choice="${theme}"]`).click();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile overflow');
    await page.screenshot({ path: path.join(output, `hero-${theme}-mobile.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('Palette controls, contrast, sample action, desktop and mobile layout passed.');
} finally {
  await browser.close();
}
