// Optional regression against a public paper (defaults to arXiv:1904.06560).
// node tests/e2e/pdfCitationPaper.mjs /path/to/paper.pdf [screenshot-dir] [fixture-json]
// Uses an isolated backend; never opens or writes the user's library.
import fs from "node:fs";
import path from "node:path";
import { Account, Server, assert, assertEq, assertNoProblems, launchBrowser, openPage, until } from "./harness.mjs";
import { citationRuns, matchCitation } from "../../src/pdf/pdfCitation.js";

const input = process.argv[2];
if (!input) throw new Error("Pass the path to the PDF matching the fixtures");
const screenshots = process.argv[3] && path.resolve(process.argv[3]);
if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
const cases = JSON.parse(fs.readFileSync(process.argv[4] || new URL("../fixtures/pdfCitationPaper.json", import.meta.url)));
assert(cases.length > 0, "at least one citation fixture");
const server = new Server();
let browser;
try {
  await server.start();
  server.manage("create-user", "citation-test", "test-password");
  const account = await new Account(server, "citation-test", "test-password").login();
  const up = await account.upload("/api/uploads", fs.readFileSync(input), path.basename(input), "application/pdf");
  const created = await account.api(`/api/blocks/by-doc/${up.doc_id}`, { method: "POST", body: {
    default_title: cases[0].title || "A quantum engineer's guide to superconducting qubits", source_url: up.source_url,
  } });
  const links = cases.map(c => `[p. ${c.page}](/?page=${created.id}&pdf_page=${c.page}&quote=${encodeURIComponent(c.quote)})`);
  await account.api(`/api/chats/${created.id}`, { method: "PUT", body: { messages: [
    { role: "ai", text: links.join("\n\n") },
  ] } });
  browser = await launchBrowser();
  const ctx = await account.context(browser, { viewport: { width: 1600, height: 1000 } });
  const page = await openPage(ctx, `${server.base}/?page=${created.id}&ws=${account.ws}`);
  const before = await account.api(`/api/blocks/${created.id}/subtree`);
  for (const c of cases) {
    const expected = matchCitation(citationRuns(c.items), c.quote).spans.map(s => c.items[s.run].str.slice(s.start, s.end));
    await page.getByRole("link", { name: `p. ${c.page}`, exact: true }).click();
    const mark = page.locator(`[data-page="${c.page}"] .pdfCitationMark`);
    await mark.first().waitFor();
    if (c.approximate) await page.locator('.pdfCitationNotice', { hasText: "approximate text match" }).waitFor();
    else assertEq(await page.locator(".pdfCitationNotice").count(), 0, `p.${c.page}: resolves without a warning`);
    const aligned = () => page.evaluate(({ number, expected }) => {
      const root = document.querySelector(`[data-page="${number}"]`);
      const marks = [...root.querySelectorAll('.pdfCitationMark')];
      const spans = [...root.querySelectorAll('.textLayer span')].filter(s => s.firstChild?.nodeType === 3);
      if (marks.length !== expected.length) return false;
      return marks.every((mark, i) => {
        const box = mark.getBoundingClientRect();
        return spans.some(span => {
          const start = span.textContent.indexOf(expected[i]);
          if (start < 0) return false;
          const range = document.createRange();
          range.setStart(span.firstChild, start); range.setEnd(span.firstChild, start + expected[i].length);
          const text = range.getBoundingClientRect();
          return ['left', 'top', 'width', 'height'].every(k => Math.abs(box[k] - text[k]) < 3);
        });
      });
    }, { number: c.page, expected });
    await until(aligned, { what: `p.${c.page}: every highlight covers its source glyphs` });
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await until(async () => await mark.count() === 0, { what: `p.${c.page}: zoom control dismisses the citation` });
    // A zoomed reader may have panned horizontally. Reopening the citation
    // must reveal the whole column, not just scroll to the correct height.
    await page.getByRole("link", { name: `p. ${c.page}`, exact: true }).click();
    await mark.first().waitFor();
    await until(aligned, { what: `p.${c.page}: reopening after zoom` });
    await until(() => page.evaluate(number => {
      const viewer = document.querySelector('.pdfViewer').getBoundingClientRect();
      return [...document.querySelectorAll(`[data-page="${number}"] .pdfCitationMark`)].every(el => {
        const r = el.getBoundingClientRect();
        return r.left >= viewer.left && r.right <= viewer.right && r.top >= viewer.top && r.bottom <= viewer.bottom;
      });
    }, c.page), { what: `p.${c.page}: entire passage visible` });
    if (screenshots) await page.locator('.pdfViewer').screenshot({ path: path.join(screenshots, `citation-p${c.page}.png`) });
    await page.keyboard.press('Escape');
    await until(async () => await page.locator('.pdfCitationMark').count() === 0, { what: 'dismissed' });
    assertNoProblems(page);
    console.log(`PASS real paper p.${c.page}: saved link, full passage, glyph alignment, zoom, dismissal`);
  }
  const after = await account.api(`/api/blocks/${created.id}/subtree`);
  assertEq(JSON.stringify(after.block.children), JSON.stringify(before.block.children), "no annotation or note was created");
} finally {
  if (browser) await browser.close();
  await server.stop();
}
console.log(`${cases.length}/${cases.length} real-paper citation scenarios passed`);
process.exit(0);
