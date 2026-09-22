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

  await step("pdf: interface scale keeps note badges anchored and Tours consistent", async () => {
    for (const scale of [0.7, 1, 1.6]) {
      await page.evaluate((value) => localStorage.setItem("gamma-ui-scale", String(value)), scale);
      await page.reload();
      await waitForPdf(page);
      const badge = page.getByRole("button", { name: "Show highlight note", exact: true }).first();
      await badge.waitFor();
      const measure = async () => badge.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const marks = [...el.closest("[data-page]").querySelectorAll("div[data-hl-id]")]
          .filter((mark) => mark.dataset.hlId === el.dataset.hlId)
          .map((mark) => mark.getBoundingClientRect());
        const end = marks.sort((a, b) => b.top - a.top || b.right - a.right)[0];
        return { width: box.width, dx: box.left - end.right, dy: box.top - end.top };
      });
      for (const zoom of [false, true]) {
        if (zoom) await page.getByRole("button", { name: "Zoom in", exact: true }).click();
        await until(async () => {
          const { width, dx, dy } = await measure();
          return Math.abs(width - 15 * scale) < 1 && Math.abs(dx - 2) < 1 && Math.abs(dy + 8) < 1;
        }, { what: `badge stays at passage end with interface scale ${scale}` });
      }
      await page.getByRole("button", { name: "Account & settings", exact: true }).click();
      const settings = page.getByRole("button", { name: "Settings…", exact: true });
      const tours = page.locator('summary[data-guide="account.tour"]');
      const settingsBox = await settings.boundingBox();
      const toursBox = await tours.boundingBox();
      assert(Math.abs(settingsBox.height - toursBox.height) < 1, "Tours matches adjacent menu controls");
      await tours.click();
      const tour = page.getByRole("menuitem", { name: "Your first paper", exact: true });
      assert(Math.abs((await tour.boundingBox()).height - toursBox.height) < 1, "submenu scales once");
      await settings.click();
      const font = await page.getByText("Interface size", { exact: true }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      assert(Math.abs(font - 13 * scale) < 0.1, "ordinary settings text follows interface size");
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      assertNoProblems(page);
    }
    await page.evaluate(() => localStorage.removeItem("gamma-ui-scale"));
    await page.reload();
    await waitForPdf(page);
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

  await step("pdf: a citation stays clickable when a stream update arrives during a click", async () => {
    await page.reload();
    await waitForPdf(page);
    // Deliver chunks on demand so the regression cannot depend on timing or an AI provider.
    await page.evaluate(() => {
      const originalFetch = window.fetch;
      window.fetch = (input, init) => {
        if (!String(input).endsWith("/api/ai/chat")) return originalFetch(input, init);
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            window.citationStream = {
              delta(text) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ delta: text }) + "\n")); },
              finish() { controller.close(); window.fetch = originalFetch; },
            };
          },
        }), { headers: { "Content-Type": "application/x-ndjson" } }));
      };
    });
    await page.locator("textarea.chatInputArea").fill("Show a citation while streaming");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => !!window.citationStream);
    const href = `/?page=${pageId}&pdf_page=2&quote=${encodeURIComponent("Page two says hello world")}`;
    await page.evaluate(href => window.citationStream.delta(`See [streamed passage](${href}).\n\nContinuing`), href);
    const link = page.locator("a.chatPageLink", { hasText: "streamed passage" });
    await link.waitFor();
    await link.scrollIntoViewIfNeeded();
    const box = await link.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.evaluate(() => window.citationStream.delta(" the answer while the mouse is held."));
    await page.getByText("Continuing the answer while the mouse is held.", { exact: true }).waitFor();
    await page.mouse.up();
    await page.locator('[data-page="2"] .pdfCitationMark').first().waitFor({ timeout: 5000 });
    assertEq(await page.getByRole("button", { name: "Stop generating", exact: true }).count(), 1, "citation opens before the stream finishes");
    await page.evaluate(() => window.citationStream.delta(" More text after opening the citation."));
    await page.getByText(/More text after opening the citation\./).waitFor();
    assert(await page.locator('[data-page="2"] .pdfCitationMark').count() > 0, "further chunks keep the passage highlighted");
    await page.evaluate(() => window.citationStream.finish());
    await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor({ state: "detached" });
    assertNoProblems(page);
  });

  await step("pdf: chat paper recommendations and bare identifiers open clickable source links", async () => {
    const doi = "https://doi.org/10.1103/PhysRevA.69.062320";
    await account.api(`/api/chats/${pageId}`, { method: "PUT", body: { messages: [
      { role: "ai", text: `[Cavity quantum electrodynamics](${doi})\n\nDOI: **10.1103/PhysRevA.69.062320**\n\narXiv:cond-mat/0402216` },
    ] } });
    await page.reload();
    const title = page.locator("a.chatLinkCard", { hasText: "Cavity quantum electrodynamics" });
    await title.waitFor();
    assertEq(await title.getAttribute("href"), doi, "paper title links to the search result's DOI");
    const identifier = page.locator("strong a.chatLinkCard", { hasText: "10.1103/PhysRevA.69.062320" });
    assertEq(await identifier.getAttribute("href"), doi, "saved bare DOI is clickable");
    assertEq(await page.locator("a.chatLinkCard", { hasText: "arXiv:cond-mat/0402216" }).getAttribute("href"),
      "https://arxiv.org/abs/cond-mat/0402216", "legacy arXiv identifier is clickable");
    // Verify actual navigation without contacting the publisher.
    const chatUrl = page.url();
    await ctx.route(doi, route => route.fulfill({ contentType: "text/html", body: "<p>Paper source</p>" }));
    try {
      const [source] = await Promise.all([page.waitForEvent("popup"), identifier.click()]);
      await source.waitForLoadState();
      assertEq(source.url(), doi, "source opens in a new tab");
      assertEq(page.url(), chatUrl, "chat remains on the library page");
      await source.close();
    } finally {
      await ctx.unroute(doi);
    }
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
    for (const [text, message] of [["This passage does not exist.", "could not be located"], ["Repeated source passage.", "More than one passage"]]) {
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

  await step("pdf: fuzzy citations align with source glyphs and reject changed numbers or competing passages", async () => {
    const text = "We carefully measured 53 atoms under stable experimental conditions";
    const quote = text.replace("carefully", "carefuly");
    const pdf = makePdf([{ lines: [text], box: [900, 792] }, { lines: [text, text], box: [900, 792] }]);
    const up = await account.upload("/api/uploads", pdf, "fuzzy-citation.pdf", "application/pdf");
    const target = await account.api(`/api/blocks/by-doc/${up.doc_id}`, { method: "POST", body: { default_title: "Fuzzy citation source", source_url: up.source_url } });
    const before = await account.api(`/api/blocks/${target.id}/subtree`);
    const href = (number, value) => `${server.base}/?page=${target.id}&pdf_page=${number}&quote=${encodeURIComponent(value)}&ws=${account.ws}`;
    await page.goto(href(1, quote));
    await page.locator('.pdfCitationNotice', { hasText: "approximate text match" }).waitFor();
    const aligned = () => page.evaluate(text => {
      const mark = document.querySelector('[data-page="1"] .pdfCitationMark')?.getBoundingClientRect();
      const span = [...document.querySelectorAll('[data-page="1"] .textLayer span')].find(s => s.textContent === text);
      if (!mark || !span) return false;
      const range = document.createRange(); range.selectNodeContents(span);
      const box = range.getBoundingClientRect();
      return ['left', 'top', 'width', 'height'].every(k => Math.abs(mark[k] - box[k]) < 3);
    }, text);
    await until(aligned, { what: "approximate citation covers the actual source glyphs" });
    await page.keyboard.press("Escape");
    await until(async () => await page.locator('.pdfCitationMark, .pdfCitationNotice').count() === 0, { what: "fuzzy citation and notice dismiss together" });
    for (const [number, value, message] of [[1, quote.replace("53", "54"), "could not be located"], [2, quote, "More than one passage"]]) {
      await page.goto(href(number, value));
      await page.locator('.pdfCitationNotice', { hasText: message }).waitFor();
      assertEq(await page.locator('.pdfCitationMark').count(), 0, "unsafe or ambiguous approximate citation has no highlight");
    }
    const after = await account.api(`/api/blocks/${target.id}/subtree`);
    assertEq(JSON.stringify(after.block.children), JSON.stringify(before.block.children), "fuzzy citation creates no annotations or notes");
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
