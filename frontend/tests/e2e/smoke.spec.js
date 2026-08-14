import { test, expect } from "@playwright/test";

const USER = process.env.ADMIN_USER || "admin";
const PASS = process.env.ADMIN_PASS || "smoke-pass-123";
const BLOCK_ID = process.env.BLOCK_ID;

async function login(page) {
  await page.goto("/");
  const inputs = page.locator(".loginInput");
  await inputs.nth(0).fill(USER);
  await inputs.nth(1).fill(PASS);
  await page.click(".loginBtn");
  await page.waitForSelector(".loginPage", { state: "detached", timeout: 20_000 });
}

async function openPdf(page) {
  await page.goto(`/?page=${BLOCK_ID}`);
  await page.waitForSelector(".pdfViewer canvas", { timeout: 30_000 });
}

async function logout(page) {
  await page.click('[data-popover="user"] .iconBtn');
  await page.getByText("Log out", { exact: true }).click();
  await page.waitForSelector(".loginPage", { timeout: 20_000 });
}

test("login → open PDF → scroll → refresh restores position → logout", async ({ page }) => {
  await login(page);
  await openPdf(page);

  // Scroll the viewer down, let the capture-on-unload logic record it.
  const scroller = page.locator(".pdfViewer");
  await scroller.evaluate((el) => {
    el.scrollTo({ top: 400, behavior: "instant" });
    el.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(1500);
  const beforeReload = await scroller.evaluate((el) => el.scrollTop);
  console.log("scrollTop before reload:", beforeReload);

  await page.reload();
  await page.waitForSelector(".pdfViewer canvas", { timeout: 30_000 });
  // The restore loop re-asserts the anchor until the layout settles.
  await page.waitForTimeout(2500);

  const top = await scroller.evaluate((el) => el.scrollTop);
  console.log("scrollTop after reload:", top);
  expect(Math.abs(top - beforeReload)).toBeLessThan(300);

  await logout(page);
});
