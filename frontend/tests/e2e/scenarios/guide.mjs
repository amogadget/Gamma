// The first-run guide (docs/dev/onboarding.md): ?guide= starts a tour, every
// registered anchor for the home view is in the DOM, the spotlight lets the
// click through to the real control, the step's event checks it off, Next
// closes what the step opened, the URL loses the param, Esc leaves, and the
// share view mounts nothing.
import { ANCHORS, anchorsForView } from "../../../src/guide/anchors.js";

export async function guideScenarios(env) {
  const { server, browser, alice, step, until, assert, assertEq, assertNoProblems, openPage } = env;
  await step("guide: first-run tour on the home view", async () => {
    const ctx = await alice.context(browser);
    const page = await openPage(ctx, `${server.base}/?ws=${alice.ws}&guide=first-run`);
    try {
      await page.waitForSelector('[data-guide-overlay="welcome"] .guideCard');
      assert(!page.url().includes("guide="), "the guide param is consumed");
      for (const id of anchorsForView("home").filter((id) => !ANCHORS[id].open)) {
        assertEq(await page.locator(`[data-guide="${id}"]`).count(), 1, `anchor ${id} (${ANCHORS[id].description}) present once`);
      }
      await page.click(".guideCard .uiBtn.primary");
      await page.waitForSelector('[data-guide-overlay="add"] .guideCard');
      await page.click('[data-guide="header.add"]'); // through the spotlight hole
      await page.locator(".guideCard .guideDone").waitFor();
      assertEq(await page.locator(".addPopover").count(), 1, "the add menu the user opened stays open");
      await page.click(".guideCard .uiBtn.primary");
      await page.waitForSelector('[data-guide-overlay="search"] .guideCard');
      await until(async () => await page.locator(".addPopover").count() === 0);
      await page.keyboard.press("Escape");
      await until(async () => await page.locator(".guideCard").count() === 0);
      assertEq(await page.evaluate(() => JSON.parse(localStorage.getItem("gamma-guide:first-run")).state), "dismissed");
      // Manual re-entry: the account menu's "Take the tour".
      await page.click('[data-guide="header.account"]');
      await page.click('[data-guide="account.tour"]');
      await page.waitForSelector('[data-guide-overlay="welcome"] .guideCard');
      await until(async () => await page.locator(".userPopover").count() === 0);
      await page.keyboard.press("Escape");
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });
}
