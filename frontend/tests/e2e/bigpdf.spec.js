import { test } from "@playwright/test";

const USER = process.env.ADMIN_USER || "admin";
const PASS = process.env.ADMIN_PASS || "smoke-pass-123";
const BIG_BLOCK = process.env.BIG_BLOCK;

// Performance probe, not a regression gate: log how long a large paper takes
// from navigation to its first painted page. Skipped when no big PDF is seeded.
test("big PDF first-paint timing", async ({ page }) => {
  test.skip(!BIG_BLOCK, "BIG_BLOCK not seeded — no big PDF available");

  await page.goto("/");
  await page.locator(".loginInput").nth(0).fill(USER);
  await page.locator(".loginInput").nth(1).fill(PASS);
  await page.click(".loginBtn");
  await page.waitForSelector(".loginPage", { state: "detached", timeout: 20_000 });

  const t0 = Date.now();
  await page.goto(`/?page=${BIG_BLOCK}`);
  await page.waitForSelector(".pdfViewer canvas", { timeout: 180_000 });
  const elapsed = Date.now() - t0;
  console.log(`[bigpdf] first canvas: ${elapsed}ms`);
});
