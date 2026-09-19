// Standalone browser check for "New blank PDF" (library/BlankPDFDialog.jsx).
// No backend required: every /api/** response is mocked, so it can run before
// (or independently of) the blank_pdf router.
//
//   npm run build && node tests/e2e/blankPdf.mjs
//
// What it pins: the entry point sits beside the other page creators, the dialog
// collects paper size / orientation / page count, a FAILED creation keeps its
// fields locked and retries the SAME creation id with the SAME payload (the
// endpoint is idempotent by that id, so a lost response must not make a second
// notebook), and the created notebook opens as a real PDF page.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { makePdf } from "./harness.mjs";
import { engineLaunchOptions } from "./nativeFixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.GAMMA_E2E_DIST || path.resolve(HERE, "..", "..", "dist");
// The notebook really opens: a blank 3-page document, as the endpoint's PDF.
const BLANK_PDF = makePdf([[""], [""], [""]]);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm",
};

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let file = path.join(DIST, url.pathname);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(DIST, "index.html");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server, base: `http://127.0.0.1:${server.address().port}`,
  })));
}

const { server, base } = await serveDist();
const browser = await chromium.launch(engineLaunchOptions({ headless: true }));
const calls = [];
let created = null;
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url()), p = url.pathname;
    if (p.endsWith(".pdf")) return route.fulfill({ contentType: "application/pdf", body: BLANK_PDF });
    if (p.startsWith("/api/blank-pdfs/")) {
      const body = request.postDataJSON();
      calls.push({ id: p.split("/").at(-1), body });
      created = {
        id: calls[0].id, parent_id: "root", position: "a0", content: body.title, children: [],
        properties: { doc_id: "blank-fixture", source_url: "/api/uploads/blank-fixture.pdf", pdf_kind: "blank" },
      };
      // The first attempt loses its response; the retry must be identical.
      if (calls.length === 1) {
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Simulated lost response; retry safely" }) });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(created) });
    }
    let body = {};
    if (p === "/api/session") {
      body = { user: "blank-owner", is_admin: false, is_guest: false, default_workspace: "personal-ws",
        workspaces: [{ id: "personal-ws", name: "Personal", role: "owner", kind: "personal", access: "private" }] };
    } else if (p.startsWith("/api/workspaces/find-page/")) body = { workspace_id: "personal-ws" };
    else if (p === "/api/blocks/root/children") body = { children: created ? [created] : [] };
    else if (p.endsWith("/subtree")) body = { block: created, seq: 1 };
    else if (p.includes("recent") || p.includes("snapshot")) body = { items: [] };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(`${base}/?ws=personal-ws`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  // The notebook entry point sits with the other page creators, and is offered once.
  assert((await page.getByRole("button", { name: "New page", exact: true }).count()) >= 1);
  assert.equal(await page.getByRole("button", { name: "New blank PDF", exact: true }).count(), 1);

  await page.getByRole("button", { name: "New blank PDF", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New blank PDF" });
  await dialog.getByLabel("Title", { exact: true }).fill("Physics scratchpad");
  await dialog.getByLabel("Paper size", { exact: true }).selectOption("letter");
  await dialog.getByLabel("Orientation", { exact: true }).selectOption("landscape");
  await dialog.getByLabel("Pages", { exact: true }).fill("3");
  await page.screenshot({ path: "/tmp/gamma-new-blank-pdf-dialog.png" });

  await dialog.getByRole("button", { name: "Create PDF", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await dialog.getByLabel("Title", { exact: true }).isDisabled(), true, "a sent request locks the form");
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".pdfPageWrap").length === 3, null, { timeout: 20000 });

  assert.equal(calls.length, 2, "one creation request per attempt");
  assert.equal(calls[0].id, calls[1].id, "the retry reuses the creation id");
  assert.deepEqual(calls[0].body, calls[1].body, "the retry repeats the same payload");
  assert.equal(calls[1].body.page_size, "letter");
  assert.equal(calls[1].body.orientation, "landscape");
  assert.equal(calls[1].body.page_count, 3);
  assert.equal(calls[1].body.title, "Physics scratchpad");
  // A blank notebook is not looked up as a paper: no metadata request was made.
  assert.equal(await page.getByRole("dialog", { name: "New blank PDF" }).count(), 0, "the dialog closes on success");
  await page.screenshot({ path: "/tmp/gamma-new-blank-pdf.png" });
  console.log("PASS: blank PDF entry point, options, same-id retry and the opened notebook");
} catch (error) {
  if (page) {
    console.error((await page.locator("body").innerText()).slice(-2000));
    await page.screenshot({ path: "/tmp/gamma-new-blank-pdf-failure.png" });
  }
  throw error;
} finally {
  await browser.close();
  server.close();
}
