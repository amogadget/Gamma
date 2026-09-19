// Blank PDF notebooks (library/BlankPDFDialog.jsx + gamma/routers/blank_pdf.py):
// the entry point, the creation options, the idempotent retry, and the created
// notebook behaving like any other PDF page.
export async function blankPdfScenarios({ server, browser, alice, step, assert, assertEq, assertNoProblems, openPage }) {
  const account = alice;
  let ctx, page, pageId, metadataCalls;

  await step("blank pdf: the dialog creates a letter, landscape, three-page notebook that opens as a PDF", async () => {
    ctx = await account.context(browser);
    page = await openPage(ctx, `${server.base}/?ws=${account.ws}`);
    // A blank notebook must not be looked up as a paper: watch for the request.
    metadataCalls = [];
    page.on("request", (r) => { if (r.url().includes("/api/metadata/")) metadataCalls.push(r.url()); });
    await page.waitForSelector(".folderNewBtn", { timeout: 20000 });

    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: "New blank PDF", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New blank PDF" });
    await dialog.getByLabel("Title", { exact: true }).fill("Physics scratchpad");
    await dialog.getByLabel("Paper size", { exact: true }).selectOption("letter");
    await dialog.getByLabel("Orientation", { exact: true }).selectOption("landscape");
    await dialog.getByLabel("Pages", { exact: true }).fill("3");
    await dialog.getByRole("button", { name: "Create PDF", exact: true }).click();

    await page.waitForFunction(() => document.querySelectorAll(".pdfPageWrap").length === 3, null, { timeout: 30000 });
    assertEq(await dialog.count(), 0, "the dialog closes once the notebook exists");
    pageId = new URL(page.url()).searchParams.get("block");
    assert(!!pageId, "the new notebook is the open page");

    const block = await account.api(`/api/blocks/${pageId}`);
    assertEq(block.properties.pdf_kind, "blank", "pdf_kind");
    assertEq(block.content, "Physics scratchpad", "title");
    assert(!!block.properties.doc_id, "the notebook has its own document");
    assertEq(block.properties.blank_pdf.page_size, "letter", "paper size");
    assertEq(block.properties.blank_pdf.orientation, "landscape", "orientation");
    assertEq(block.properties.blank_pdf.initial_page_count, 3, "page count");

    // Landscape really is wider than tall on screen, and every page got the document.
    const shape = await page.locator('[data-page="1"]').boundingBox();
    assert(shape.width > shape.height, `landscape page box ${shape.width}x${shape.height}`);
    assertEq(metadataCalls.length, 0, "a blank notebook triggers no scholarly lookup");
    assertNoProblems(page);
  });

  await step("blank pdf: a retry of the same creation is the same notebook, a different one is refused", async () => {
    const body = { title: "Physics scratchpad", page_size: "letter", orientation: "landscape", page_count: 3, folder: "" };
    const again = await account.api(`/api/blank-pdfs/${pageId}`, { method: "PUT", body });
    assertEq(again.id, pageId, "the same creation id returns the same page");
    // A rename in between survives the retry (it is not an overwrite).
    await account.api(`/api/blocks/${pageId}`, { method: "PUT", body: { content: "Renamed scratchpad" } });
    const renamed = await account.api(`/api/blank-pdfs/${pageId}`, { method: "PUT", body });
    assertEq(renamed.content, "Renamed scratchpad", "a retry never undoes a later rename");
    // The same id with a different payload is a conflict, not a second notebook.
    const clash = await account.api(`/api/blank-pdfs/${pageId}`, { method: "PUT", body: { ...body, page_count: 5 }, raw: true });
    assertEq(clash.status, 409, "a different payload on a used id");
    // And the library holds exactly one notebook.
    const root = await account.api("/api/blocks/root/children");
    assertEq(root.children.filter((b) => b.properties?.pdf_kind === "blank").length, 1, "one notebook");
    await ctx.close();
  });
}
