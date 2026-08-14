import { test, expect } from "@playwright/test";

const USER = process.env.ADMIN_USER || "admin";
const PASS = process.env.ADMIN_PASS || "smoke-pass-123";
const BLOCK_A = process.env.BLOCK_A;
const BLOCK_B = process.env.BLOCK_B;

async function login(page) {
  await page.goto("/");
  const inputs = page.locator(".loginInput");
  await inputs.nth(0).fill(USER);
  await inputs.nth(1).fill(PASS);
  await page.click(".loginBtn");
  await page.waitForSelector(".loginPage", { state: "detached", timeout: 20_000 });
}

async function openPdf(page, blockId) {
  await page.goto(`/?page=${blockId}`);
  await page.waitForSelector(".pdfViewer canvas", { timeout: 30_000 });
}

async function logout(page) {
  await page.click('[data-popover="user"] .iconBtn');
  await page.getByText("Log out", { exact: true }).click();
  await page.waitForSelector(".loginPage", { timeout: 20_000 });
}

test("login → open PDF → scroll → refresh restores position → logout", async ({ page }) => {
  await login(page);
  await openPdf(page, BLOCK_A);

  const scroller = page.locator(".pdfViewer");
  await scroller.evaluate((el) => {
    el.scrollTo({ top: 400, behavior: "instant" });
    el.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(1500);
  const beforeReload = await scroller.evaluate((el) => el.scrollTop);

  await page.reload();
  await page.waitForSelector(".pdfViewer canvas", { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const top = await scroller.evaluate((el) => el.scrollTop);
  expect(Math.abs(top - beforeReload)).toBeLessThan(300);

  await logout(page);
});

test("tab switch A→B→A restores each PDF's scroll position", async ({ page }) => {
  await login(page);

  await openPdf(page, BLOCK_A);
  const scroller = page.locator(".pdfViewer");
  await scroller.evaluate((el) => {
    el.scrollTo({ top: 500, behavior: "instant" });
    el.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(1500);
  const aPos = await scroller.evaluate((el) => el.scrollTop);

  // Open paper B (a new tab), scroll it too.
  await openPdf(page, BLOCK_B);
  await scroller.evaluate((el) => {
    el.scrollTo({ top: 300, behavior: "instant" });
    el.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(1500);

  // Switch back to paper A by clicking its tab.
  await page.getByRole("tab", { name: "Paper A" }).click();
  await page.waitForSelector(".pdfViewer canvas", { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const restored = await scroller.evaluate((el) => el.scrollTop);
  expect(Math.abs(restored - aPos)).toBeLessThan(300);
});
