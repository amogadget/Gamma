// Focused real pdf.js rendering check; run against a local Vite dev server.
// Bundled fixture covers mixed page sizes, crop offsets and quarter-turn rotations.
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const base = process.env.GAMMA_TEST_URL || "http://127.0.0.1:5193";
const pdf = await fs.readFile(process.env.GAMMA_TEST_PDF || new URL("./fixtures/ink-coordinates.pdf", import.meta.url));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: {width: 1280, height: 900} });
  await page.route("**/api/**", async route => {
    if (route.request().url().includes("/api/assets/")) {
      // 1x1 transparent PNG; location is asserted using the real PDF viewport.
      await route.fulfill({contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64")});
    } else await route.fulfill({contentType: "application/json", body: JSON.stringify({user: null, children: []})});
  });
  await page.route("**/fixture.pdf", route => route.fulfill({contentType: "application/pdf", body: pdf}));
  await page.goto(base);
  await page.evaluate(async () => {
    const {default: React} = await import("/node_modules/.vite/deps/react.js");
    const {default: ReactDOM} = await import("/node_modules/.vite/deps/react-dom_client.js");
    const {default: PdfViewer} = await import("/src/pdfViewer.jsx");
    document.getElementById("root").style.display = "none";
    const host = document.createElement("div"); host.id = "ink-fixture-host";
    host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;";
    document.body.appendChild(host);
    const inkBlocks = [1, 4].map(page => ({id: `ink-${page}`, properties: {
      type: "pdf_ink", pdf_page: page, preview_asset: `/api/assets/${"a".repeat(64)}.png`,
      bounds: {x: 30,y: 40,width: 80,height: 20},
      crop_box: page === 1 ? {width: 612,height: 792} : {width: 532,height: 672},
      coordinate_space: "pdf-crop-top-left-v1",
    }}));
    window.inkTestRoot = ReactDOM.createRoot(host);
    window.renderInkFixture = scale => window.inkTestRoot.render(React.createElement(PdfViewer, {
      url: "/fixture.pdf", highlights: [], inkBlocks, pdfScaleValue: scale,
    }));
    window.renderInkFixture(1);
  });
  const first = page.locator('[data-ink-block-id="ink-1"]');
  await first.waitFor();
  const unrotated = await first.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).toFloat64Array().join(","));
  assert.ok(unrotated.includes("30,40"), unrotated);
  await page.locator('.pdfPageWrap[data-page="4"]').scrollIntoViewIfNeeded();
  const rotated = page.locator('[data-ink-block-id="ink-4"]');
  await rotated.waitFor();
  const transform = await rotated.evaluate(el => {
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return [m.a,m.b,m.c,m.d,m.e,m.f];
  });
  assert.deepEqual(transform, [0,1,-1,0,632,30]);
  assert.equal(await page.locator('.pdfPageWrap[data-page="2"] [data-ink-block-id]').count(), 0);
  await page.evaluate(() => window.renderInkFixture(2));
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-ink-block-id="ink-4"]');
    return el && new DOMMatrix(getComputedStyle(el).transform).b === 2;
  });
  console.log("PASS: real pdf.js ink overlay, rotated crop box, page isolation and zoom");
} finally { await browser.close(); }
