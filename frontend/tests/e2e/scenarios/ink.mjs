// Handwriting (docs/dev/handwriting.md): the tool strip, mouse strokes
// becoming an ink block with an .ink upload, persistence across a reload,
// the eraser, the notes card's jump + flash, and /Ink in the annotated PDF.
import { waitForPdf } from "./pdf.mjs";

async function drawLine(page, from, to) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 12 });
  await page.mouse.up();
}

export async function inkScenarios({ server, browser, alice, makePdf, step, until, sleep, assert, assertEq, assertNoProblems, openPage, flags }) {
  let ctx, page, pageId, box, inkBlock;
  const account = alice;
  const inkBlockOnServer = async () => {
    const d = await account.api(`/api/blocks/${pageId}/subtree`);
    return (d.block.children || []).find((b) => b.properties?.ink_url) || null;
  };

  await step("ink: the pen strip opens and two mouse strokes make a handwriting block with an .ink upload", async () => {
    const pdf = makePdf([["A page to write on", "with some text"]]);
    const up = await account.upload("/api/uploads", pdf, "ink.pdf", "application/pdf");
    const created = await account.api(`/api/blocks/by-doc/${up.doc_id}`, { method: "POST", body: { default_title: "Ink paper", source_url: up.source_url } });
    pageId = created.id;
    ctx = await account.context(browser);
    page = await openPage(ctx, `${server.base}/?page=${pageId}&ws=${account.ws}`);
    await waitForPdf(page, 1);
    await page.click("button[aria-label='Handwriting tools']");
    await page.waitForSelector(".pdfInkBar");
    assert(await page.$(".pdfInkBar .modeActive"), "the pen is armed when the strip opens");
    box = await page.locator('[data-page="1"]').boundingBox();
    await drawLine(page, [box.x + 100, box.y + 150], [box.x + 250, box.y + 170]);
    await drawLine(page, [box.x + 100, box.y + 250], [box.x + 250, box.y + 280]);
    await until(async () => (await page.$$('[data-page="1"] .inkLayer path')).length === 2, { what: "two stroke paths" });
    await page.waitForSelector(".blockRow .inkMarker", { timeout: 5000 });
    await page.waitForSelector(".blockInkCard", { timeout: 5000 });
    inkBlock = await until(async () => {
      const b = await inkBlockOnServer();
      return b && b.properties.ink_url.endsWith(".ink") && b.properties.ink_strokes === 2 ? b : null;
    }, { what: "ink block with two uploaded strokes" });
    assertEq(inkBlock.properties.pdf_page, 1, "pdf_page");
    assertEq(inkBlock.properties.pdf_position.pageNumber, 1, "pdf_position page");
    const ink = await account.api(inkBlock.properties.ink_url);
    assertEq(ink.format, "gamma-ink", "file format");
    assertEq(ink.strokes.length, 2, "strokes in the file");
    assert(ink.strokes.every((s) => s.pen === false && s.ch === "xyt"), "mouse strokes carry no pressure channel");
    if (flags.keep) await page.screenshot({ path: `${server.dir}/ink-drawn.png` });
    assertNoProblems(page);
  });

  await step("ink: strokes survive a reload; the eraser removes one and the file follows", async () => {
    await page.reload();
    await waitForPdf(page, 1);
    await until(async () => (await page.$$('[data-page="1"] .inkLayer path')).length === 2, { what: "two paths after reload", timeout: 15000 });
    await page.click("button[aria-label='Handwriting tools']");
    await page.waitForSelector(".pdfInkBar");
    await page.keyboard.press("e");
    await until(async () => (await page.$$(".pdfInkBar .modeActive")).length === 1
      && (await page.getAttribute(".pdfInkBar .modeActive", "title")).startsWith("Eraser"), { what: "eraser armed by its key" });
    box = await page.locator('[data-page="1"]').boundingBox();
    await drawLine(page, [box.x + 175, box.y + 140], [box.x + 178, box.y + 185]);
    await until(async () => (await page.$$('[data-page="1"] .inkLayer path')).length === 1, { what: "one path left" });
    await until(async () => (await inkBlockOnServer())?.properties.ink_strokes === 1, { what: "one stroke on the server" });
    await page.keyboard.press("Escape");
    await until(async () => !(await page.$(".pdfInkBar")), { what: "strip closed by Escape" });
    assertNoProblems(page);
  });

  await step("ink: the notes card jumps to the group and outlines it; the annotated PDF carries /Ink", async () => {
    await page.click(".blockInkCard");
    await page.waitForSelector('[data-page="1"] .inkFlash', { timeout: 5000 });
    const r = await account.api(`/api/pages/${pageId}/export-pdf`, { raw: true });
    assert(r.ok, `export-pdf ${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert(bytes.includes("/Ink"), "the exported PDF has an /Ink annotation");
    assert(bytes.includes("/GammaInk"), "…carrying the gamma-ink strokes for a round trip");
    if (flags.keep) await page.screenshot({ path: `${server.dir}/ink-notes.png` });
    assertNoProblems(page);
  });

  if (ctx) await ctx.close();
  return { inkPageId: pageId };
}
