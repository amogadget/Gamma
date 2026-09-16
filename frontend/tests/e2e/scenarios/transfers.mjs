import fs from "node:fs";
import { newPageViaUi } from "./notes.mjs";
import { waitForPdf } from "./pdf.mjs";

export async function transferScenarios({ server, browser, alice, makePdf, step, assert, assertEq, assertNoProblems, openPage, flags }) {
  async function setup(viewport) {
    const ctx = await alice.context(browser, viewport ? { viewport } : {});
    await ctx.addInitScript(() => localStorage.setItem("gamma-ai-login-check", "off"));
    return { ctx, page: await openPage(ctx, server.base) };
  }
  async function openDialog(page, name) {
    await page.locator('[data-popover="menu"] > button').click();
    await page.getByRole("button", { name: `${name}…`, exact: true }).click();
    return page.getByRole("dialog", { name, exact: true });
  }
  const choice = (dialog, name) => dialog.getByRole("button", { name, exact: true });
  const toggle = (dialog, name) => dialog.getByRole("checkbox", { name, exact: true });

  await step("transfer: format selection, live options, back navigation and a real notes PDF", async () => {
    const { ctx, page } = await setup();
    try {
      await newPageViaUi(page, "Export preview example");
      const dialog = await openDialog(page, "Export");
      assert(await choice(dialog, "Close Export").isVisible());
      assertEq(await choice(dialog, "Cancel").count(), 0);
      await page.keyboard.press("Shift+Tab");
      assert(await dialog.evaluate((el) => el.contains(document.activeElement)), "reverse tab from the heading stays in the dialog");
      assertEq(await dialog.getByRole("group", { name: "Export format" }).getByRole("button").count(), 6);
      assertEq(await choice(dialog, "Notes as PDF").getAttribute("aria-pressed"), "true");
      for (const [type, count] of [["PDF", 1], ["MD", 1], ["ZIP", 4]]) {
        assertEq(await dialog.getByRole("group", { name: `${type} choices`, exact: true }).getByRole("button").count(), count);
      }
      await choice(dialog, "Markdown").hover();
      const cardShadow = await choice(dialog, "Markdown").evaluate((el) => getComputedStyle(el).boxShadow);
      assert(cardShadow !== "none", "picture choices retain the shared button shadow");
      assertEq(cardShadow, await choice(dialog, "Next").evaluate((el) => getComputedStyle(el).boxShadow));
      if (flags.keep) await page.screenshot({ animations: "disabled", path: `${server.dir}/export-formats.png` });
      await choice(dialog, "Markdown").dblclick();
      assert(await dialog.getByRole("heading", { name: "Markdown", exact: true }).isVisible());
      assertEq(await choice(dialog, "Back").count(), 0);
      await choice(dialog, "1. Choose a format").click();
      assertEq(await choice(dialog, "Markdown").getAttribute("aria-pressed"), "true");
      await choice(dialog, "Notes as PDF").click();
      await choice(dialog, "Next").click();
      await toggle(dialog, "Highlights").uncheck();
      assertEq(await dialog.locator('[data-preview="highlights"]').count(), 0);
      await toggle(dialog, "Notes").uncheck();
      assertEq(await dialog.locator('[data-preview="notes"]').count(), 0);
      await choice(dialog, "1. Choose a format").focus();
      await page.keyboard.press("Enter");
      await choice(dialog, "Next").click();
      assertEq(await toggle(dialog, "Notes").isChecked(), false);
      await toggle(dialog, "Highlights").check();
      await toggle(dialog, "Notes").check();
      if (flags.keep) await page.screenshot({ animations: "disabled", path: `${server.dir}/export-page-preview.png` });
      const request = page.waitForRequest((r) => r.url().includes("mode=notes-pdf"));
      const download = page.waitForEvent("download");
      await choice(dialog, "Export").click();
      const url = new URL((await request).url());
      assertEq(url.searchParams.get("highlights"), "1");
      assertEq(url.searchParams.get("notes"), "1");
      const file = await download;
      assertEq(fs.readFileSync(await file.path()).subarray(0, 5).toString(), "%PDF-");
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("transfer: required content, bundled files, and mobile keyboard dismissal", async () => {
    const { ctx, page } = await setup({ width: 390, height: 844 });
    try {
      await newPageViaUi(page, "Mobile export example");
      let dialog = await openDialog(page, "Export");
      await choice(dialog, "Gamma").click();
      assertEq(await choice(dialog, "Next").count(), 0);
      assertEq(await dialog.getByRole("checkbox").count(), 0);
      const gammaDownload = page.waitForEvent("download");
      await choice(dialog, "Export").click();
      assertEq(fs.readFileSync(await (await gammaDownload).path()).subarray(0, 2).toString(), "PK");
      await dialog.waitFor({ state: "detached" });
      dialog = await openDialog(page, "Export");
      await choice(dialog, "Logseq").click();
      await choice(dialog, "Next").click();
      assertEq(await dialog.getByRole("checkbox").count(), 1);
      assertEq(await dialog.locator('[data-preview="highlights"]').count(), 1);
      assertEq(await dialog.locator('[data-preview="notes"]').count(), 1);
      assert(!(await toggle(dialog, "Bundle the files").isDisabled()));
      await choice(dialog, "1. Choose a format").click();
      await choice(dialog, "Obsidian").click();
      await choice(dialog, "Next").click();
      await toggle(dialog, "Bundle the files").uncheck();
      assertEq(await dialog.locator('[data-preview="linked-files"]').count(), 1);
      await toggle(dialog, "Bundle the files").check();
      assertEq(await dialog.locator('[data-preview="bundled-files"]').count(), 1);
      assert(!(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1)), "dialog fits mobile");
      await dialog.locator(".transferStep").evaluate((el) => { el.scrollTop = 0; });
      if (flags.keep) await page.screenshot({ animations: "disabled", path: `${server.dir}/export-mobile.png` });
      await choice(dialog, "Export").focus();
      await page.keyboard.press("Tab");
      assert(await dialog.evaluate((el) => el.contains(document.activeElement)), "focus stays in the dialog");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("transfer: PDF export and import previews retain source-specific behavior", async () => {
    const { ctx, page } = await setup();
    try {
      const pdf = makePdf([["Import and export preview"]]);
      const up = await alice.upload("/api/uploads", pdf, "preview.pdf", "application/pdf");
      const created = await alice.api(`/api/blocks/by-doc/${up.doc_id}`, { method: "POST", body: { default_title: "Preview paper", source_url: up.source_url } });
      await page.goto(`${server.base}/?page=${created.id}&ws=${alice.ws}`);
      await waitForPdf(page);
      let dialog = await openDialog(page, "Export");
      await choice(dialog, "Original PDF").click();
      await choice(dialog, "Next").click();
      assertEq(await dialog.locator(".transferOriginalPaper").count(), 1);
      await toggle(dialog, "Notes").uncheck();
      assertEq(await dialog.locator('[data-preview="notes"]').count(), 0);
      await choice(dialog, "Close Export").click();
      dialog = await openDialog(page, "Import");
      assertEq(await dialog.getByRole("group", { name: "Import from" }).getByRole("button").count(), 5);
      assertEq(await choice(dialog, "Annotations in this PDF").getAttribute("aria-pressed"), "true");
      for (const [type, count] of [["PDF", 2], ["MD", 1], ["ZIP", 2]]) {
        assertEq(await dialog.getByRole("group", { name: `${type} choices`, exact: true }).getByRole("button").count(), count);
      }
      if (flags.keep) await page.screenshot({ animations: "disabled", path: `${server.dir}/import-sources.png` });
      await choice(dialog, "Next").click();
      await toggle(dialog, "Strip the originals").check();
      assertEq(await dialog.locator('[data-preview="highlights"]').count(), 0);
      assertEq(await dialog.locator('[data-preview="imported-annotations"]').count(), 1);
      await choice(dialog, "1. Choose a source").click();
      assertEq(await choice(dialog, "Annotations in this PDF").getAttribute("aria-pressed"), "true");
      await choice(dialog, "Next").click();
      assert(await toggle(dialog, "Strip the originals").isChecked(), "breadcrumb preserves the import options");
      await toggle(dialog, "Strip the originals").uncheck();
      assertEq(await dialog.locator('[data-preview="highlights"]').count(), 1);
      if (flags.keep) await page.screenshot({ animations: "disabled", path: `${server.dir}/import-preview.png` });
      await choice(dialog, "1. Choose a source").click();
      const markdownChooser = page.waitForEvent("filechooser");
      await choice(dialog, "Markdown notes").dblclick();
      assertEq(await (await markdownChooser).element().getAttribute("accept"), ".md,.markdown,.zip,text/markdown,application/zip");
      await dialog.waitFor({ state: "detached" });
      dialog = await openDialog(page, "Import");
      await choice(dialog, "Zotero library (.zip)").click();
      await choice(dialog, "Next").click();
      assert(await dialog.getByText("Export from Zotero", { exact: true }).isVisible());
      const chooser = page.waitForEvent("filechooser");
      await choice(dialog, "Choose .zip…").click();
      assertEq(await (await chooser).element().getAttribute("accept"), ".zip,application/zip");
      await dialog.waitFor({ state: "detached" });
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("transfer: direct actions use the activated format and import source", async () => {
    const { ctx, page } = await setup();
    try {
      await newPageViaUi(page, "Direct transfer example");
      let dialog = await openDialog(page, "Export");
      await choice(dialog, "Notes as PDF").click();
      const request = page.waitForRequest((r) => r.url().includes("mode=gamma"));
      const download = page.waitForEvent("download");
      await choice(dialog, "Gamma").dblclick();
      await request;
      assertEq(fs.readFileSync(await (await download).path()).subarray(0, 2).toString(), "PK");
      await dialog.waitFor({ state: "detached" });
      for (const [name, accept, multiple] of [["Gamma export (.zip)", ".zip,application/zip", false], ["Logseq highlights", ".pdf,.edn,.md", true]]) {
        dialog = await openDialog(page, "Import");
        const chooser = page.waitForEvent("filechooser");
        if (multiple) {
          await choice(dialog, name).click();
          assertEq(await choice(dialog, "Next").count(), 0);
          await choice(dialog, "Choose files…").click();
        } else await choice(dialog, name).dblclick();
        const fileChooser = await chooser;
        assertEq(await fileChooser.element().getAttribute("accept"), accept);
        assertEq(fileChooser.isMultiple(), multiple);
        await dialog.waitFor({ state: "detached" });
      }
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });
}
