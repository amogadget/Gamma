// The first-run guide (docs/dev/onboarding.md): ?guide= starts a tour, every
// registered anchor for the home view is in the DOM, the demo step adds a
// paper by itself (click Add, type the link, Enter — against an uploaded PDF
// so no network is needed), the user's highlight checks the next step off,
// Esc leaves and records the dismissal, and the account menu restarts it.
import { ANCHORS, anchorsForView } from "../../../src/guide/anchors.js";
import { selectPdfText, waitForPdf } from "./pdf.mjs";

export async function guideScenarios(env) {
  const { server, browser, alice, step, until, assert, assertEq, assertNoProblems, openPage, makePdf } = env;
  await step("guide: first-run tour — demo adds a paper, the user highlights, menu restarts", async () => {
    const up = await alice.upload("/api/uploads", makePdf([["Attention is all you need, said the transformer."]]), "attention.pdf", "application/pdf");
    const ctx = await alice.context(browser);
    await ctx.addInitScript((url) => localStorage.setItem("gamma-guide-vars", JSON.stringify({ demoUrl: url })), `/api/uploads/${up.doc_id}.pdf`);
    const page = await openPage(ctx, `${server.base}/?ws=${alice.ws}&guide=first-run`);
    try {
      await page.waitForSelector('[data-guide-overlay="welcome"] .guideCard');
      assert(!page.url().includes("guide="), "the guide param is consumed");
      for (const id of anchorsForView("home").filter((id) => !ANCHORS[id].open)) {
        assertEq(await page.locator(`[data-guide="${id}"]`).count(), 1, `anchor ${id} (${ANCHORS[id].description}) present once`);
      }
      await page.click(".guideCard .uiBtn.primary");
      // The demo: Add opens, the link is typed, Enter opens the paper.
      await page.waitForSelector('[data-guide-overlay="add-demo"][data-guide-busy]');
      await page.waitForSelector(".guideCursor");
      await until(async () => (await page.inputValue('[data-guide="add.urlInput"]')).endsWith(".pdf"), { what: "the demo typed the link" });
      await page.waitForSelector('[data-guide-overlay="highlight"] .guideCard', { timeout: 30000 });
      assert(/[?&]block=/.test(page.url()), "the paper opened");
      await waitForPdf(page, 1);
      // The user's turn: a highlight checks the step off; Next moves on.
      await selectPdfText(page, 1, "Attention is all");
      await page.locator(".plainTip .colorBtn").first().click();
      await page.locator(".guideCard .guideDone").waitFor();
      await page.click(".guideCard .uiBtn.primary");
      await page.waitForSelector('[data-guide-overlay="notes"] .guideCard');
      assertEq(await page.locator('[data-guide="dock.notes"]').count(), 1, "the notes window is anchored");
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
