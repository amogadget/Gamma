// The first-run guide (docs/dev/onboarding.md): the account menu starts a tour, every
// registered anchor for the home view is in the DOM, the demo step adds a
// paper by itself (click Add, type the link, Enter — against an uploaded PDF
// so no network is needed), the user's highlight checks the next step off,
// Esc leaves and records the dismissal, and the account menu restarts it.
import { ANCHORS, anchorsForView } from "../../../src/guide/anchors.js";
import { selectPdfText, waitForPdf } from "./pdf.mjs";
import { ABSTRACT_PASSAGE } from "../../../src/guide/previewHighlight.js";
import { readFileSync } from "node:fs";

export async function guideScenarios(env) {
  const { server, browser, alice, step, until, assert, assertEq, assertNoProblems, openPage, makePdf } = env;
  await step("guide: first-run tour — demo adds a paper, the user highlights, menu restarts", async () => {
    const pdf = process.env.GAMMA_GUIDE_PDF ? readFileSync(process.env.GAMMA_GUIDE_PDF) : makePdf([[
      "Attention is all you need, said the transformer.",
      "We propose a new simple network architecture,",
      "the Transformer, based solely on attention",
      "mechanisms, dispensing with recurrence",
      "and convolutions entirely.",
    ], ["Scaled dot-product attention", "Attention(Q, K, V) = softmax(QK / d) V"]]);
    const up = await alice.upload("/api/uploads", pdf, "attention.pdf", "application/pdf");
    const ctx = await alice.context(browser);
    await ctx.addInitScript((url) => localStorage.setItem("gamma-guide-vars", JSON.stringify({ demoUrl: url })), `/api/uploads/${up.doc_id}.pdf`);
    const page = await openPage(ctx, `${server.base}/?ws=${alice.ws}&guide=first-run`);
    try {
      await page.click('[data-guide="header.account"]');
      await page.click('[data-guide="account.tour"]');
      await page.click('[data-guide="account.firstRun"]');
      await page.waitForSelector('[data-guide-overlay="welcome"] .guideCard');
      for (const id of anchorsForView("home").filter((id) => !ANCHORS[id].open)) {
        assertEq(await page.locator(`[data-guide="${id}"]`).count(), 1, `anchor ${id} (${ANCHORS[id].description}) present once`);
      }
      await page.click(".guideCard .uiBtn.primary");
      // The demo: Add opens, the link is typed, Enter opens the paper.
      await page.waitForSelector('[data-guide-overlay="add-demo"][data-guide-busy]');
      assertEq(await page.locator('.guideCard .guideBtns button').count(), 0, "automatic step has no navigation buttons, including during its initial pause");
      await page.keyboard.press("ArrowRight");
      assertEq(await page.locator('[data-guide-overlay="add-demo"]').count(), 1, "keyboard cannot skip the automatic step");
      await page.waitForSelector(".guideCursor");
      await until(async () => (await page.inputValue('[data-guide="add.urlInput"]')).endsWith(".pdf"), { what: "the demo typed the link" });
      await page.waitForSelector('[data-guide-overlay="highlight-demo"] .guideCursor.dragging', { timeout: 30000 });
      const firstPointer = await page.locator(".guideCursor").getAttribute("style");
      await until(async () => (await page.locator(".guideCursor").getAttribute("style")) !== firstPointer, { what: "the example pointer moves across the text" });
      await page.waitForSelector('[data-guide="pdf.highlightColor"]');
      assertEq((await page.evaluate(() => window.getSelection().toString())).replace(/\s/g, ""), ABSTRACT_PASSAGE.replace(/\s/g, ""), "demo selects the requested abstract across lines");
      await page.screenshot({ path: `${server.dir}/highlight-demo.png` });
      await page.waitForSelector('[data-guide-overlay="highlight"] .guideCard', { timeout: 30000 });
      assertEq(await page.evaluate(() => window.getSelection().toString()), "", "example selection clears before handing over");
      assertEq(await page.locator("[data-hl-id]").count(), 0, "the example creates no saved highlight");
      assert(/[?&]block=/.test(page.url()), "the paper opened");
      await waitForPdf(page, 1);
      // User actions show Done, then advance without a Next click.
      await selectPdfText(page, 1, "We propose");
      await page.locator(".plainTip .colorBtn").first().click();
      await page.locator(".guideCard .guideDone").waitFor();
      assertEq(await page.locator('.guideCard .uiBtn.primary').count(), 0, "Done needs no Next button");
      await page.waitForSelector('[data-guide-overlay="area-demo"] .guideCursor.dragging');
      await page.waitForSelector('.pdfAreaMarquee');
      await until(async () => page.evaluate(() => {
        const marquee = document.querySelector('.pdfAreaMarquee');
        const formula = [...(marquee?.parentElement.querySelectorAll('[data-guide="pdf.textLayer"] span') || [])]
          .filter((s) => s.textContent.includes("softmax"))
          .sort((a, b) => a.textContent.length - b.textContent.length)[0];
        if (!formula || !marquee) return false;
        const f = formula.getBoundingClientRect(), m = marquee.getBoundingClientRect();
        return m.left < f.left && m.top < f.top && m.right > f.right && m.bottom > f.bottom;
      }), { what: "rectangle encircles the attention formula" });
      let lastWidth = 0, stableSince = Date.now();
      await until(async () => {
        const box = await page.locator('.pdfAreaMarquee').boundingBox();
        if (!box) return false;
        if (Math.abs(box.width - lastWidth) > 0.5) { lastWidth = box.width; stableSince = Date.now(); }
        return Date.now() - stableSince > 150;
      }, { what: "the formula rectangle finishes growing" });
      assertEq(await page.locator('.guideModifier').textContent(), "Ctrl", "box demonstration shows the modifier");
      await page.screenshot({ path: `${server.dir}/area-demo.png` });
      await page.waitForSelector('[data-guide-overlay="area"] .guideCard');
      assertEq(await page.locator('.pdfAreaMarquee').count(), 0, "example rectangle is cleaned up");
      const pdfBox = await page.locator('[data-guide="pdf.page"]').first().boundingBox();
      const viewerBox = await page.locator('[data-guide="pdf.viewer"]').boundingBox();
      const x = Math.max(pdfBox.x, viewerBox.x) + 70;
      const y = Math.max(pdfBox.y, viewerBox.y) + 90;
      await page.keyboard.down("Control");
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 180, y + 95, { steps: 16 });
      await page.mouse.up();
      await page.keyboard.up("Control");
      await page.locator('.plainTip .colorBtn').first().click();
      await page.locator('.guideCard .guideDone').waitFor();
      await page.waitForSelector('[data-guide-overlay="notes"] .guideCard');
      assertEq(await page.locator('[data-guide="dock.notes"]').count(), 1, "the notes window is anchored");
      await page.waitForSelector('[data-guide="notes.editor"]');
      await until(async () => (await page.locator('[data-guide="notes.editor"]').allTextContents()).some((t) => t.includes("Attention compares queries")), { what: "notes demo types real text" });
      const paperId = new URL(page.url()).searchParams.get("block");
      await page.waitForSelector('[data-guide-overlay="label"] .guideCard');
      await page.waitForSelector('[data-guide-overlay="home"] .guideCard');
      const saved = await until(async () => {
        const { block } = await alice.api(`/api/blocks/${paperId}/subtree`);
        return block.properties.category?.split(",").includes("llm") && block.children.some((b) => b.content.includes("Scaling keeps the scores stable.")) ? block : null;
      }, { what: "demo note and llm label persist" });
      assertEq(saved.properties.category.split(",").filter((t) => t === "llm").length, 1, "llm is added once");
      await page.click('[data-guide="header.home"]');
      await page.locator('.guideCard .guideDone').waitFor();
      assert(!new URL(page.url()).searchParams.has("block"), "final step returns to the homepage");
      await until(async () => await page.locator(".guideCard").count() === 0);
      assertEq(await page.evaluate(() => JSON.parse(localStorage.getItem("gamma-guide:first-run")).state), "done");
      await page.goto(`${server.base}/?ws=${alice.ws}&block=${paperId}`);
      await page.waitForSelector('[data-guide="pdf.textLayer"] span:visible');
      // Manual re-entry through the Tours submenu.
      await page.click('[data-guide="header.account"]');
      await page.click('[data-guide="account.tour"]');
      await page.click('[data-guide="account.firstRun"]');
      await page.waitForSelector('[data-guide-overlay="welcome"] .guideCard');
      await until(async () => await page.locator(".userPopover").count() === 0);
      // Replaying with the same PDF already open must still complete.
      await page.click(".guideCard .uiBtn.primary");
      await page.waitForSelector('[data-guide-overlay="highlight-demo"] .guideCursor.dragging', { timeout: 30000 });
      assertEq(new URL(page.url()).searchParams.get("block"), paperId, "replay reuses the open paper");
      await page.keyboard.press("Escape");
      await until(async () => await page.locator(".guideCard").count() === 0);
      assertEq(await page.evaluate(() => window.getSelection().toString()), "", "dismissing a drag clears its temporary selection");
      await until(async () => await page.locator(".plainTip").count() === 0);
      // A known arXiv paper should open its local copy without contacting
      // the resolver or creating a second page, even from the library.
      const { block } = await alice.api(`/api/blocks/${paperId}/subtree`);
      await alice.api(`/api/blocks/${paperId}`, { method: "PUT", body: {
        properties: { ...block.properties, meta: { ...block.properties.meta, arxiv_id: "1706.03762" } },
      } });
      await page.goto(`${server.base}/?ws=${alice.ws}`);
      await page.click('[data-guide="header.account"]');
      await page.click('[data-guide="account.tour"]');
      await page.click('[data-guide="account.firstRun"]');
      await page.waitForSelector('[data-guide-overlay="welcome"] .guideCard');
      await page.evaluate(() => localStorage.removeItem("gamma-guide-vars"));
      const unexpected = [];
      const track = (request) => {
        if (request.url().includes("/api/resolve") || (request.method() === "POST" && /\/api\/(pages(?:\?|$)|blocks\/by-doc\/)/.test(request.url()))) unexpected.push(request.url());
      };
      page.on("request", track);
      await page.click(".guideCard .uiBtn.primary");
      await page.waitForSelector('[data-guide-overlay="highlight"] .guideCard', { timeout: 30000 });
      assertEq(new URL(page.url()).searchParams.get("block"), paperId, "arXiv demo opens the saved library copy");
      assertEq(unexpected.length, 0, "known paper needs no resolver or page creation");
      await page.waitForSelector('[data-guide="pdf.textLayer"] span:visible');
      page.off("request", track);
      await page.keyboard.press("Escape");
      await page.click('[data-guide="header.account"]');
      await page.click('[data-guide="account.tour"]');
      await page.click('[data-guide="account.firstRun"]');
      await page.click(".guideCard .uiBtn.primary");
      await page.waitForSelector('[data-guide="add.urlInput"]:focus');
      await page.keyboard.press("Escape");
      await until(async () => await page.locator(".guideCard").count() === 0);
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });
}
