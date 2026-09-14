// Files and documents (docs/dev/block_centric.md, stage 4): any file dropped
// on a block row or on the page body becomes a file chip; a PDF chip promotes
// to a DOCUMENT page (right-click → "Open as page" → by-doc, no re-upload)
// filed in the project's folder, and offers "Open page" afterwards; the
// upload endpoint takes lab files and refuses executables.
import { editRow, tree } from "./notes.mjs";
import { waitForPdf } from "./pdf.mjs";

// Drop `files` ([{name, type, bytes}]) on the first element `selector`
// matches, the way the browser would: one DataTransfer carrying real File
// objects, dragover then drop. Synthetic items have no webkitGetAsEntry, so
// the app's folder branch is skipped and the plain-files path runs.
export async function dropFiles(page, selector, files) {
  const payload = files.map((f) => ({ name: f.name, type: f.type, b64: Buffer.from(f.bytes).toString("base64") }));
  const dt = await page.evaluateHandle((items) => {
    const dt = new DataTransfer();
    for (const it of items) {
      const bin = atob(it.b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      dt.items.add(new File([arr], it.name, { type: it.type }));
    }
    return dt;
  }, payload);
  const el = page.locator(selector).first();
  await el.dispatchEvent("dragover", { dataTransfer: dt });
  await el.dispatchEvent("drop", { dataTransfer: dt });
}

export async function fileScenarios({ server, browser, alice, makePdf, step, until, sleep, assert, assertEq, assertNoProblems, openPage }) {
  const account = alice;
  let ctx, page, projectId, docPageId;
  const pdf = makePdf([["Supplementary material for the Rydberg paper"]]);

  await step("files: a drop on a block row makes file chips — a notebook and a PDF", async () => {
    const created = await account.api("/api/pages", { method: "POST", body: { title: "Lab project", folder: "Projects/Rydberg" } });
    projectId = created.id;
    await account.api("/api/blocks", { method: "POST", body: { parent_id: projectId, content: "Data goes here" } });
    ctx = await account.context(browser);
    page = await openPage(ctx, `${server.base}/?page=${projectId}&ws=${account.ws}`);
    await page.waitForSelector(".blockRow", { timeout: 15000 });
    await dropFiles(page, ".blockRowWrap", [
      { name: "sim.nb", type: "", bytes: Buffer.from("Notebook[{Cell[1]}]") },
      { name: "supplement.pdf", type: "application/pdf", bytes: pdf },
    ]);
    await until(async () => (await page.$$(".blockRow .fileChip")).length === 2, { what: "two file chips" });
    // the row's text change saves through the (debounced) op path
    await until(async () => /supplement\.pdf/.test((await tree(account, projectId))[0]?.content || ""), { what: "chips saved" });
    const t = await tree(account, projectId);
    assertEq(t.length, 1, "still one block");
    assert(/\[sim\.nb\]\(\/api\/uploads\/[0-9a-f]+\.nb\)/.test(t[0].content), `notebook chip stored: ${t[0].content}`);
    assert(/\[supplement\.pdf\]\(\/api\/uploads\/[0-9a-f]+\.pdf\)/.test(t[0].content), `pdf chip stored: ${t[0].content}`);
    // every chip looks the same: no inline action anywhere
    assertEq((await page.$$(".fileChip button")).length, 0, "no inline actions");
    // the PDF has no document page yet → its right-click menu offers to make one
    await page.locator(".fileChip", { hasText: "supplement.pdf" }).click({ button: "right" });
    await page.locator(".ctxMenuItem", { hasText: "Open as page" }).waitFor({ timeout: 8000 });
    await page.keyboard.press("Escape");
    await page.locator(".fileChip", { hasText: "sim.nb" }).click({ button: "right" });
    await page.locator(".ctxMenuItem", { hasText: "Download" }).waitFor();
    assertEq((await page.$$(".ctxMenuItem:has-text('Open as page')")).length, 0, "a notebook cannot become a page");
    assertEq((await page.$$(".ctxMenuItem")).length, 1, "download is the whole menu for a notebook");
    await page.keyboard.press("Escape");
    assertEq((await page.$$(".fileChipOpen")).length, 0, "no open-page buttons before any promotion");
    assertNoProblems(page);
  });

  await step("files: a drop on the page body appends blocks at the end", async () => {
    await dropFiles(page, ".app", [
      { name: "fit.mat", type: "", bytes: Buffer.from("MATLAB 5.0 MAT-file") },
      { name: "README", type: "", bytes: Buffer.from("no extension") },
    ]);
    await until(async () => (await tree(account, projectId)).length === 3, { what: "two new blocks saved" });
    const t = await tree(account, projectId);
    assert(/^\[fit\.mat\]\(\/api\/uploads\/[0-9a-f]+\.mat\)$/.test(t[1].content), `mat block: ${t[1].content}`);
    assert(/^\[README\]\(\/api\/uploads\/[0-9a-f]+\.bin\)$/.test(t[2].content), `extension-less block: ${t[2].content}`);
    assertEq((await page.$$(".blockRow .fileChip")).length, 4, "four chips rendered");
    assertNoProblems(page);
  });

  await step("files: 'Open as page' makes the document page in the same folder", async () => {
    await page.locator(".fileChip", { hasText: "supplement.pdf" }).click({ button: "right" });
    await page.click(".ctxMenuItem:has-text('Open as page')");
    await waitForPdf(page, 1);
    await until(async () => (await page.textContent(".titleText")) === "supplement.pdf", { what: "title = file name" });
    docPageId = new URL(page.url()).searchParams.get("block");
    assert(docPageId && docPageId !== projectId, "navigated to a new page");
    const doc = await account.api(`/api/blocks/${docPageId}`);
    assertEq(doc.parent_id, "root", "a root page");
    assertEq(doc.properties.folder, "Projects/Rydberg", "filed with the project");
    assert(doc.properties.doc_id, "carries the PDF as its document");
    // the header paperclip is the document's own popover
    await page.click("button[aria-label='Document']");
    await page.waitForSelector(".attachPopover .popoverTitle:has-text('Document')");
    await page.keyboard.press("Escape");
    // the same hash again is the same page (no duplicate)
    const again = await account.api(`/api/blocks/by-doc/${doc.properties.doc_id}`, { method: "POST", body: { default_title: "" } });
    assertEq(again.id, docPageId, "by-doc finds the page");
    assertNoProblems(page);
  });

  await step("files: back on the project page the PDF chip shows an open-page button that opens it", async () => {
    await page.goto(`${server.base}/?page=${projectId}&ws=${account.ws}`);
    const chip = page.locator(".fileChip", { hasText: "supplement.pdf" });
    await chip.locator(".fileChipOpen").waitFor({ timeout: 15000 });
    assertEq((await page.$$(".fileChipOpen")).length, 1, "only the promoted PDF has the button");
    await chip.click({ button: "right" });
    await page.locator(".ctxMenuItem", { hasText: "Open page" }).waitFor({ timeout: 8000 });
    assertEq((await page.$$(".ctxMenuItem:has-text('Open as page')")).length, 0, "no promotion offered any more");
    await page.keyboard.press("Escape");
    await chip.locator(".fileChipOpen").click();
    await until(async () => new URL(page.url()).searchParams.get("block") === docPageId, { what: "document page opened" });
    await waitForPdf(page, 1);
    assertNoProblems(page);
    await ctx.close();
  });

  await step("files: a markdown chip's 'Open as page' imports it as a note page; the file stays", async () => {
    ctx = await account.context(browser);
    page = await openPage(ctx, `${server.base}/?page=${projectId}&ws=${account.ws}`);
    await page.waitForSelector(".blockRow", { timeout: 15000 });
    const md = Buffer.from("# Setup\n\n- first point\n- second point\n");
    await dropFiles(page, ".app", [{ name: "Squeezing notes.md", type: "text/markdown", bytes: md }]);
    const chip = page.locator(".fileChip", { hasText: "Squeezing notes.md" });
    await chip.waitFor({ timeout: 8000 });
    await until(async () => (await tree(account, projectId)).some((b) => /Squeezing notes\.md/.test(b.content)), { what: "md chip saved" });
    await chip.click({ button: "right" });
    await page.click(".ctxMenuItem:has-text('Open as page')");
    await until(async () => (await page.textContent(".titleText")) === "Squeezing notes", { what: "note page titled after the file" });
    const noteId = new URL(page.url()).searchParams.get("block");
    const note = await account.api(`/api/blocks/${noteId}`);
    assertEq(note.properties.folder, "Projects/Rydberg", "filed with the project");
    assert(!note.properties.doc_id, "a note page, not a document page");
    assert((await page.$$(".pdfViewer")).length === 0, "no viewer for a note page");
    await page.locator(".blockRow", { hasText: "first point" }).waitFor();
    // editing the note leaves the file as it was
    const mdUrl = (await tree(account, projectId)).find((b) => /Squeezing notes\.md/.test(b.content)).content.match(/\((\/api\/uploads\/[^)]+)\)/)[1];
    await account.api(`/api/blocks/${noteId}`, { method: "PUT", body: { content: "Squeezing notes (edited)" } });
    const served = await account.api(mdUrl, { raw: true });
    assertEq(await served.text(), md.toString(), "file untouched");
    // back on the project page: the chip has the open button, and it goes to the note
    await page.goto(`${server.base}/?page=${projectId}&ws=${account.ws}`);
    await chip.locator(".fileChipOpen").waitFor({ timeout: 15000 });
    await chip.locator(".fileChipOpen").click();
    await until(async () => new URL(page.url()).searchParams.get("block") === noteId, { what: "note page opened from the chip" });
    assertNoProblems(page);
    await ctx.close();
  });

  await step("files: a PDF pasted into the editor becomes a file chip at the caret", async () => {
    ctx = await account.context(browser);
    page = await openPage(ctx, `${server.base}/?page=${projectId}&ws=${account.ws}`);
    await page.waitForSelector(".blockRow", { timeout: 15000 });
    await editRow(page, "Data goes here");
    const dt = await page.evaluateHandle((b64) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], "pasted.pdf", { type: "application/pdf" }));
      return dt;
    }, Buffer.from(pdf).toString("base64"));
    // Playwright's dispatchEvent knows no ClipboardEvent — build it in the page.
    await page.evaluate((dt) => {
      document.querySelector(".blockEditorCm .cm-content")
        .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, dt);
    await until(async () => /\[pasted\.pdf\]\(\/api\/uploads\/[0-9a-f]+\.pdf\)/.test((await tree(account, projectId))[0]?.content || ""), { what: "pasted chip saved" });
    await page.evaluate(() => document.activeElement?.blur());
    await until(async () => (await page.$$(".blockRow .fileChip")).length === 6, { what: "six chips rendered" });
    assertNoProblems(page);
    await ctx.close();
  });

  await step("files: the upload endpoint takes lab files and refuses executables", async () => {
    const nb = await account.upload("/api/upload-file", Buffer.from("x"), "model.nb", "application/octet-stream");
    assert(nb.url.endsWith(".nb") && nb.name === "model.nb", `nb stored: ${JSON.stringify(nb)}`);
    const r = await account.api(nb.url, { raw: true });
    assertEq(r.status, 200, "served");
    assert((r.headers.get("content-disposition") || "").startsWith("attachment"), "downloads rather than renders");
    const exe = await account.upload("/api/upload-file", Buffer.from("MZ"), "setup.exe", "application/octet-stream").catch((e) => e);
    assertEq(exe.status, 400, "executables are refused");
    assert(/executable/.test(exe.data?.detail || ""), `refusal names the reason: ${exe.data?.detail}`);
  });
}
