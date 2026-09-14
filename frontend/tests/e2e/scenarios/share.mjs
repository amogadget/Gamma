// Share links: creating one from the dialog, the anonymous share view (title,
// PDF, highlight overlay, an image served through the share token, no
// editing), and an edit share letting another account type into the page.
import { tree, same, editRow, closeEditor, PNG_1PX } from "./notes.mjs";
import { waitForPdf } from "./pdf.mjs";

export async function shareScenarios({ server, browser, alice, bob, step, until, sleep, assert, assertEq, assertNoProblems, openPage }, { alice2, pdfPageId }) {
  const account = alice2;
  let token;
  if (!pdfPageId) { console.log("  skip  share: needs the pdf steps (drop --only)"); return; }

  // An image block on the paper's page, so the share view has an upload to fetch.
  const up = await account.upload("/api/upload-image", PNG_1PX, "dot.png", "image/png");
  await account.api("/api/blocks", { method: "POST", body: { parent_id: pdfPageId, content: `figure ![](${up.url})` } });

  await step("share: the dialog creates a link and shows it on the copy button", async () => {
    const ctx = await account.context(browser);
    const page = await openPage(ctx, `${server.base}/?page=${pdfPageId}&ws=${account.ws}`);
    await waitForPdf(page, 1);
    await page.click("button[aria-label='Share']");
    await page.waitForSelector(".sharePopover");
    await page.locator(".sharePopover button", { hasText: "Create link" }).click();
    const copyBtn = page.locator(".sharePopover button", { hasText: /Copy link|Copied/ }).first();
    await copyBtn.waitFor({ timeout: 10000 });
    const url = await copyBtn.getAttribute("title");
    token = url && new URL(url).searchParams.get("share");
    if (!token) token = (await account.api(`/api/share-settings/${pdfPageId}`)).token;
    assert(token, "share token");
    assertNoProblems(page);
    await ctx.close();
    return `?share=${token.slice(0, 8)}…`;
  });

  await step("share: an anonymous visitor sees the paper, the highlight and the image, read-only", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await openPage(ctx, `${server.base}/?share=${token}`);
    await page.waitForSelector(".readOnlyTitle", { timeout: 15000 });
    assert((await page.textContent(".readOnlyTitle")).includes("Rydberg paper"), "title in the share view");
    await waitForPdf(page, 1);
    await page.waitForSelector('[data-page="1"] [data-hl-id]', { timeout: 10000 });
    await until(async () => {
      const imgs = await page.$$eval("img.mdImg", (els) => els.map((e) => [e.getAttribute("src"), e.naturalWidth]));
      return imgs.length === 1 && imgs[0][0].includes("share=") && imgs[0][1] === 1;
    }, { what: "image served through the share token" });
    await page.locator(".blockRow", { hasText: "figure" }).locator(".blockBody").click();
    await sleep(400);
    assert((await page.$(".blockEditorCm")) == null, "no editor opens on a view-only share");
    assertNoProblems(page);
    await ctx.close();
  });

  await step("share: an edit share lets bob type into alice's page", async () => {
    await account.api(`/api/share-settings/${pdfPageId}`, { method: "PUT", body: { audience: "users", role: "edit" } });
    const ctx = await bob.context(browser);
    const page = await openPage(ctx, `${server.base}/?share=${token}`);
    await page.waitForSelector(".readOnlyTitle", { timeout: 15000 });
    await until(async () => (await page.textContent("body")).includes("Can edit"), { what: "edit badge" });
    await editRow(page, "figure");
    await page.keyboard.type(" edited by bob");
    await closeEditor(page);
    await until(async () => JSON.stringify(await tree(account, pdfPageId)).includes("edited by bob"), { what: "bob's edit saved to alice's page" });
    assertNoProblems(page);
    await ctx.close();
  });
}
