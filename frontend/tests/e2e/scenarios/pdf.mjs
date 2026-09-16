// PDF pages: upload + page creation by attachment, the viewer's render and
// text layer, creating a highlight from a text selection (overlay + block
// row + persisted position), the library card, and the search panel hitting
// PDF text on another page.
import { tree, same } from "./notes.mjs";

// Select `needle` inside one text-layer span of `pageNo` and release the
// mouse the way the viewer listens for it (document-level mouseup).
export async function selectPdfText(page, pageNo, needle) {
  const ok = await page.evaluate(([pageNo, needle]) => {
    const spans = Array.from(document.querySelectorAll(`[data-page="${pageNo}"] .textLayer span`));
    const span = spans.find((s) => s.textContent.includes(needle));
    if (!span || !span.firstChild) return false;
    const off = span.textContent.indexOf(needle);
    const range = document.createRange();
    range.setStart(span.firstChild, off);
    range.setEnd(span.firstChild, off + needle.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return true;
  }, [pageNo, needle]);
  if (!ok) throw new Error(`text "${needle}" not found on page ${pageNo}'s text layer`);
}

export async function waitForPdf(page, pageNo = 1) {
  await page.waitForSelector(`[data-page="${pageNo}"] .textLayer span`, { timeout: 30000 });
}

export async function pdfScenarios({ server, browser, alice, makePdf, step, until, sleep, assert, assertEq, assertNoProblems, openPage }, { alice2, second }) {
  let ctx, page, pageId, docId;
  const account = alice2;

  await step("pdf: upload, create the page by attachment, the viewer renders both pages", async () => {
    const pdf = makePdf([["Quantum entanglement in Rydberg arrays", "Second line of page one"], ["Page two says hello world"]]);
    const up = await account.upload("/api/uploads", pdf, "rydberg.pdf", "application/pdf");
    docId = up.doc_id;
    const created = await account.api(`/api/blocks/by-doc/${docId}`, { method: "POST", body: { default_title: "Rydberg paper", source_url: up.source_url } });
    pageId = created.id;
    ctx = await account.context(browser);
    await ctx.addInitScript(() => localStorage.setItem("gamma-hl-note-badge", "0"));
    page = await openPage(ctx, `${server.base}/?page=${pageId}&ws=${account.ws}`);
    await waitForPdf(page, 1);
    await until(async () => (await page.$$("[data-page]")).length >= 2, { what: "two page wrappers" });
    const text = await page.textContent(`[data-page="1"] .textLayer`);
    assert(text.includes("Rydberg"), `text layer: ${text.slice(0, 80)}`);
    assertNoProblems(page);
  });

  await step("pdf: a text selection makes a highlight (overlay + note row), persisted with its position", async () => {
    await selectPdfText(page, 1, "entanglement in Rydberg");
    await page.waitForSelector(".plainTip .colorBtn", { timeout: 5000 });
    await page.locator(".plainTip .colorBtn").first().click();
    await page.waitForSelector('[data-page="1"] [data-hl-id]', { timeout: 5000 });
    await page.waitForSelector(".blockRow .blockQuote", { timeout: 5000 });
    const quote = await page.textContent(".blockRow .blockQuote");
    assert(quote.includes("entanglement in Rydberg"), `quote: ${quote}`);
    const saved = await until(async () => {
      const d = await account.api(`/api/blocks/${pageId}/subtree`);
      const h = (d.block.children || []).find((b) => b.properties?.highlight_id);
      return h && h.properties.pdf_position ? h : null;
    }, { what: "highlight block with pdf_position" });
    assertEq(saved.properties.pdf_position.pageNumber ?? saved.properties.pdf_position.page, 1, "highlight page");
    assertNoProblems(page);
    await page.reload();
    await waitForPdf(page, 1);
    await page.waitForSelector('[data-page="1"] [data-hl-id]', { timeout: 10000 });
    assertNoProblems(page);
  });

  await step("pdf: clicking the overlay focuses its note row", async () => {
    await page.click('[data-page="1"] [data-hl-id]');
    await until(async () => (await page.$(".blockRow.focused .blockQuote")) != null, { what: "focused highlight row" });
    assertNoProblems(page);
  });

  await step("pdf: note badges stay on even with an old disabled preference", async () => {
    const data = await account.api(`/api/blocks/${pageId}/subtree`);
    const highlight = data.block.children.find((block) => block.properties?.highlight_id);
    await account.api(`/api/blocks/${highlight.id}`, { method: "PUT", body: { content: "A note on this passage" } });
    await page.reload();
    await waitForPdf(page);
    const badge = page.locator(".pdfNoteBadge").first();
    await badge.waitFor();
    await badge.click();
    await until(async () => (await page.$(".blockRow.focused .blockQuote")) != null, { what: "badge focuses its note" });
    assertNoProblems(page);
  });

  await step("pdf: search finds PDF text on page 2, the details list it, clicking marks it", async () => {
    await page.click("button[aria-label='Search']");
    await page.waitForSelector(".searchPopover .searchInput");
    await page.fill(".searchPopover .searchInput", "hello world");
    // The paper view opens the compact find bar: a match count, no rows.
    await until(async () => (await page.textContent(".searchPopover .searchFindCount").catch(() => "")) === "1/1", { what: "find count 1/1" });
    await page.click("button[aria-label='Toggle result details']");
    const hit = page.locator("button.searchResult", { hasText: "p. 2" }).first();
    try { await hit.waitFor({ timeout: 10000 }); }
    catch (e) { throw new Error(`no "p. 2" hit; popover showed: ${JSON.stringify(await page.textContent(".searchPopover"))}`); }
    await hit.click();
    await page.waitForSelector('[data-page="2"] .pdfFindMark', { timeout: 15000 });
    await page.keyboard.press("Escape");
    assertNoProblems(page);
  });

  await step("pdf: AI citation aligns with text and dismisses on outside clicks without creating a note", async () => {
    const before = await account.api(`/api/blocks/${pageId}/subtree`);
    const quote = "Page two says hello world";
    const href = `/?page=${pageId}&pdf_page=2&quote=${encodeURIComponent(quote)}`;
    await account.api(`/api/chats/${pageId}`, { method: "PUT", body: {
      messages: [{ role: "user", text: "Where is the greeting?" },
        { role: "ai", text: `The greeting is here [p. 2](${href}).` }],
    } });
    await page.reload();
    const link = page.locator('a.chatPageLink', { hasText: "p. 2" });
    await link.waitFor();
    assert((await link.getAttribute("href")).includes("quote="), "saved citation retains its quote");
    await link.click();
    const mark = page.locator('[data-page="2"] .pdfCitationMark').first();
    await mark.waitFor();
    assertEq(await mark.evaluate(el => getComputedStyle(el).animationName), "pdfTransShimmer", "citation reuses the in-progress translation shimmer");
    assertEq(await page.getByRole("button", { name: "Clear reference highlight", exact: true }).count(), 0);
    const aligned = () => page.evaluate(() => {
      const mark = document.querySelector('[data-page="2"] .pdfCitationMark').getBoundingClientRect();
      const span = [...document.querySelectorAll('[data-page="2"] .textLayer span')]
        .find(s => s.textContent.includes("Page two says hello world"));
      const range = document.createRange(); range.selectNodeContents(span);
      const text = range.getBoundingClientRect();
      return Math.abs(mark.left - text.left) < 3 && Math.abs(mark.top - text.top) < 3
        && Math.abs(mark.width - text.width) < 3 && mark.top >= 0 && mark.top < innerHeight;
    });
    await until(aligned, { what: "citation rectangles align with the rendered text" });
    const box = await mark.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assertEq(await mark.count(), 1, "clicking the highlighted passage keeps it visible");
    const paper = await page.locator('[data-page="2"]').boundingBox();
    await page.mouse.click(paper.x + 8, box.y + box.height / 2);
    await until(async () => await mark.count() === 0, { what: "clicking elsewhere on the PDF dismisses the citation" });
    await link.click();
    await mark.waitFor();
    await page.locator(".chatInputArea").click();
    await until(async () => await mark.count() === 0, { what: "clicking in chat dismisses the citation" });
    await link.click();
    await mark.waitFor();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await until(async () => await mark.count() === 0, { what: "clicking a viewer control dismisses the citation" });
    await link.click();
    await mark.waitFor();
    await until(aligned, { what: "citation aligns after zoom and reopening" });
    await page.keyboard.press("Escape");
    await until(async () => await page.locator('.pdfCitationMark').count() === 0, { what: "citation dismissed" });
    await link.click();
    await mark.waitFor();
    const after = await account.api(`/api/blocks/${pageId}/subtree`);
    assertEq(JSON.stringify(after.block.children), JSON.stringify(before.block.children), "citation creates no annotations or notes");
    // Direct links (including Ctrl/Cmd-click) restore the passage on load.
    await page.goto(`${server.base}${href}&ws=${account.ws}`);
    await mark.waitFor();
    await until(aligned, { what: "direct citation link resolves on initial load" });
    assertNoProblems(page);
  });

  await step("pdf: citations open another document and report missing or ambiguous quotes", async () => {
    const quote = "A distinct source sentence in another document.";
    const uploaded = await account.upload("/api/uploads", makePdf([["Repeated source passage.", quote, "Repeated source passage."]]), "citation.pdf", "application/pdf");
    const target = await account.api(`/api/blocks/by-doc/${uploaded.doc_id}`, { method: "POST", body: { default_title: "Citation source", source_url: uploaded.source_url } });
    const href = `/?page=${target.id}&pdf_page=1&quote=${encodeURIComponent(quote)}`;
    await account.api(`/api/chats/${pageId}`, { method: "PUT", body: { messages: [
      { role: "ai", text: `[other source](${href})` },
    ] } });
    await page.reload();
    await page.locator("a.chatPageLink", { hasText: "other source" }).click();
    await page.waitForSelector('[data-page="1"] .pdfCitationMark');
    assert((await page.textContent('[data-page="1"] .textLayer')).includes(quote), "citation resolved against the requested document");
    for (const [text, message] of [["This passage does not exist.", "could not be located"], ["Repeated source passage.", "more than once"]]) {
      await page.goto(`${server.base}/?page=${target.id}&pdf_page=1&quote=${encodeURIComponent(text)}&ws=${account.ws}`);
      await page.locator('.pdfCitationNotice', { hasText: message }).waitFor();
      assertEq(await page.locator('.pdfCitationMark').count(), 0, "unresolved reference does not highlight guessed text");
      await page.locator(".chatInputArea").click();
      await until(async () => await page.locator('.pdfCitationNotice').count() === 0, { what: "clicking elsewhere dismisses an unresolved reference" });
    }
    assertNoProblems(page);
    await page.goto(`${server.base}/?page=${pageId}&ws=${account.ws}`);
    await waitForPdf(page);
  });

  await step("pdf: the home library lists the paper and double-click opens it", async () => {
    await page.click("button[aria-label='Home']");
    const card = page.locator(".pageCard", { hasText: "Rydberg paper" }).first();
    await card.waitFor({ timeout: 15000 });
    await card.dblclick();
    await waitForPdf(page, 1);
    assert(new URL(page.url()).searchParams.get("block") === pageId || new URL(page.url()).searchParams.get("page") === pageId, `url ${page.url()}`);
    assertNoProblems(page);
  });

  if (ctx) await ctx.close();
  return { pdfPageId: pageId, docId };
}
