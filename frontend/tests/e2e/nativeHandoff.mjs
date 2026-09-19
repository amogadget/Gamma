// Standalone browser check for the NATIVE (iPad) path. No backend required:
// every /api/** response is mocked, so this verifies the FRONTEND contract of
// the native integration while the native REST routes (/api/assets, the
// per-block ink/audio/replay writers) are still being ported into this tree.
//
//   npm run build && node tests/e2e/nativeHandoff.mjs
//
// What it pins:
//   • the handoff payload — type/pageID/docID/workspace/user/title, with the
//     WORKSPACE present (native routes are library-scoped) — and the freeze
//     that follows it (inert root, __GAMMA_NATIVE_ACTIVE__);
//   • browser-issued native asset URLs carrying ?ws= (an <img>, an <audio>,
//     the .inkjson loader), which bypass the fetch wrapper;
//   • static high-resolution ink: the SAME per-stroke images in the notes and
//     over the PDF, before and after a Replay;
//   • timed Reveal: only strokes the audio clock has reached are drawn, and
//     clicking a timed stroke seeks.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { makePdf } from "./harness.mjs";
import { audioFixture, engineLabel, engineLaunchOptions, serveBytes } from "./nativeFixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.GAMMA_E2E_DIST || path.resolve(HERE, "..", "..", "dist");
const WS = "personal-7Qk2";
const WS2 = "shared-9Qz4";
const USER = "replay-owner";
const HASH_INK = "a".repeat(64);      // the editable PKDrawing
const HASH_REPLAY = "b".repeat(64);   // the .inkjson derivative
const HASH_PREVIEW = "c".repeat(64);  // the whole-block PNG
const HASH_AUDIO = "d".repeat(64);    // the finalized .m4a segment
const HASH_INK2 = "e".repeat(64);     // a second PKDrawing with no derivative

// A real (tiny) PNG: validateReplayInk reads the IHDR header out of the base64.
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PIXEL_PNG, "base64");

const REPLAY_INK = {
  format: "gamma-ink-replay-v1",
  source_sha256: HASH_INK,
  width: 612,
  height: 792,
  strokes: [
    { id: "s1", bounds: { x: 18, y: 37, width: 80, height: 6 }, png: PIXEL_PNG,
      points: [{ x: 20, y: 40, t: 0, radius: 2 }, { x: 98, y: 40, t: 10, radius: 2 }] },
    { id: "s2", bounds: { x: 100, y: 37, width: 80, height: 6 }, png: PIXEL_PNG,
      points: [{ x: 100, y: 40, t: 20, radius: 2 }, { x: 178, y: 40, t: 30, radius: 2 }] },
  ],
};

const PAPER = {
  id: "paper-native", parent_id: "root", position: "a0", content: "Native paper",
  properties: { doc_id: "fixture", source_url: "/api/uploads/fixture.pdf" },
  children: [
    {
      id: "ink-native", parent_id: "paper-native", position: "a0", content: "Timed handwriting",
      properties: {
        type: "pdf_ink", pdf_page: 1,
        ink_asset: `/api/assets/${HASH_INK}.pkdrawing`,
        replay_asset: `/api/assets/${HASH_REPLAY}.inkjson`,
        preview_asset: `/api/assets/${HASH_PREVIEW}.png`,
        bounds: { x: 18, y: 37, width: 164, height: 6 },
        crop_box: { width: 612, height: 792 },
        coordinate_space: "pdf-crop-top-left-v1",
        ink_revision: 1,
      },
    },
    {
      id: "ink-plain", parent_id: "paper-native", position: "a1", content: "Older handwriting",
      properties: {
        // No per-stroke derivative (an older iPad export): the whole-block PNG
        // is the documented fallback, and it must still be high enough to read
        // and still be scoped to the library.
        type: "pdf_ink", pdf_page: 1,
        ink_asset: `/api/assets/${HASH_INK2}.pkdrawing`,
        preview_asset: `/api/assets/${HASH_PREVIEW}.png`,
        bounds: { x: 60, y: 120, width: 120, height: 40 },
        crop_box: { width: 612, height: 792 },
        coordinate_space: "pdf-crop-top-left-v1",
        ink_revision: 1,
      },
    },
    {
      id: "note-native", parent_id: "paper-native", position: "a2", content: "An ordinary note",
      properties: {}, children: [],
    },
    {
      id: "rec-native", parent_id: "paper-native", position: "a3", content: "Recorded explanation",
      properties: {
        type: "audio", audio_revision: 1, audio_state: "stopped", duration: 6,
        segments: [{ id: "seg1", asset: `/api/assets/${HASH_AUDIO}.m4a`, duration: 6, start_time: 0 }],
        replay_events: [
          { id: "e0", kind: "page", segment_id: "seg1", start: 0, end: 0, pdf_page: 1 },
          { id: "e1", kind: "stroke", segment_id: "seg1", start: 0.4, end: 1.0, pdf_page: 1, block_id: "ink-native", stroke_id: "s1" },
          { id: "e2", kind: "stroke", segment_id: "seg1", start: 4.0, end: 4.6, pdf_page: 1, block_id: "ink-native", stroke_id: "s2" },
        ],
      },
    },
  ],
};

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

const browserName = () => engineLabel(browser);

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`FAIL: ${name} — ${error.message}`);
  }
}

const { server, base } = await serveDist();
const browser = await chromium.launch(engineLaunchOptions({ headless: true }));
// This check's recording declares one six-second segment.
const AUDIO = await audioFixture(6);
const assetRequests = [];
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

  // The iPad host: sets the flag the app looks for and stands in for the
  // WKScriptMessageHandler, recording what the web side posts.
  await page.addInitScript(() => {
    window.__GAMMA_IPAD__ = true;
    window.__nativeCalls = [];
    window.webkit = { messageHandlers: { gammaNative: { postMessage: (m) => window.__nativeCalls.push(m) } } };
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p.startsWith("/api/assets/")) assetRequests.push({ path: p, search: url.search });
    if (p === "/api/uploads/fixture.pdf") return serveBytes(route, makePdf([["Native paper"], ["Second page"], ["Third page"], ["Fourth page"]]), "application/pdf");
    if (p === "/api/assets/fixture.png" || p.endsWith(".png")) return serveBytes(route, PNG_BYTES, "image/png");
    // The real audio the iPad exports, served the way a file server would
    // (Range + Content-Length) — not a WAV standing in for an .m4a.
    if (p.endsWith(".m4a")) return serveBytes(route, AUDIO.bytes, "audio/mp4");
    if (p.endsWith(".inkjson")) return route.fulfill({ contentType: "application/json", body: JSON.stringify(REPLAY_INK) });
    if (p.endsWith(".pkdrawing")) return route.fulfill({ contentType: "application/octet-stream", body: "pkdrawing" });
    let body = {};
    if (p === "/api/session") {
      body = {
        user: USER, is_admin: false, is_guest: false, default_workspace: WS,
        workspaces: [{ id: WS, name: "Personal", role: "owner", kind: "personal", access: "private" }],
      };
    } else if (p.startsWith("/api/workspaces/find-page/")) body = { workspace_id: WS };
    else if (p.endsWith("/subtree")) body = { block: PAPER, seq: 1 };
    else if (p.includes("recent") || p.includes("snapshot")) body = { items: [] };
    else if (p.endsWith("/backlinks")) body = { backlinks: [] };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(`${base}/?block=paper-native&ws=${WS}`);

  await check("the page opens with its native blocks in the notes", async () => {
    await page.waitForSelector("figure.nativeInkCard", { timeout: 20000 });
    await page.waitForSelector("figure.nativeAudio audio");
    assert.equal(await page.locator("figure.nativeAudio audio").getAttribute("src").then((s) => s.includes(`ws=${WS}`)), true,
      "the audio element's src carries the workspace");
  });

  await check("static high-resolution ink draws on the PDF and in the notes", async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-static-ink-id="ink-native"] image').length === 2);
    await page.waitForFunction(() => document.querySelectorAll("[data-static-note-ink] image").length === 2);
    const onPdf = await page.locator('[data-static-ink-id="ink-native"] image').evaluateAll((n) => n.map((i) => i.getAttribute("href")));
    const inNotes = await page.locator("[data-static-note-ink] image").evaluateAll((n) => n.map((i) => i.getAttribute("href")));
    assert.deepEqual(inNotes, onPdf, "the notes picture is the same stroke images as the PDF layer");
    const progress = await page.locator('[data-static-ink-id="ink-native"] g[data-replay-progress]').evaluateAll((n) => n.map((g) => g.dataset.replayProgress));
    assert.deepEqual(progress, ["1.000", "1.000"], "every stroke is complete outside Replay");
    // The block with no derivative falls back to its whole-block PNG — the
    // replay layer must not have replaced it with nothing.
    assert.equal(await page.locator('img[data-ink-block-id="ink-native"]').count(), 0);
    assert.equal(await page.locator('img[data-ink-block-id="ink-plain"]').count(), 1);
  });

  await check("the whole-block PNG fallback is still library-scoped", async () => {
    const src = await page.locator('img[data-ink-block-id="ink-plain"]').getAttribute("src");
    assert(src.includes(HASH_PREVIEW) && src.includes(`ws=${WS}`), `unexpected fallback src: ${src}`);
    // Its notes card shows the PNG, not a per-stroke preview.
    const cards = page.locator("figure.nativeInkCard");
    assert.equal(await cards.count(), 2, "both native ink blocks have a notes card");
    assert.equal(await page.locator("figure.nativeInkCard [data-static-note-ink]").count(), 1);
  });

  await check("the native ink marker jumps to the strokes and outlines them", async () => {
    const marker = page.getByRole("button", { name: "Jump to handwriting" });
    assert.equal(await marker.count(), 2, "each native ink block has its own marker");
    await marker.first().click();
    await page.waitForSelector('[data-ink-jump-target="ink-native"]');
    const top = await page.locator('[data-ink-jump-target="ink-native"]').evaluate((el) => el.getBoundingClientRect().top);
    assert(top >= 0 && top < 300, `the jump landed at top=${top}`);
  });

  await check("native asset requests carry ?ws=", async () => {
    assert(assetRequests.length > 0, "no native asset was requested");
    for (const r of assetRequests) assert(r.search.includes(`ws=${WS}`), `${r.path} was requested without the workspace (${r.search})`);
    assert(assetRequests.some((r) => r.path.endsWith(".inkjson")), "the per-stroke derivative was not loaded");
  });

  await check("Note Replay masks the strokes by the recording's own clock", async () => {
    await page.getByRole("button", { name: "Open Note Replay" }).click();
    await page.waitForSelector(".noteReplayBar");
    await page.waitForFunction(() => !document.querySelector('[aria-label="Play replay"]').disabled);
    const seekTo = (value) => page.locator('[aria-label="Replay timeline"]').evaluate((el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    const revealed = () => page.evaluate(() => [...document.querySelectorAll('[data-replay-ink-id="ink-native"] g[data-replay-stroke-id]')]
      .map((g) => `${g.dataset.replayStrokeId}:${g.dataset.replayProgress}`));

    // Nothing yet: the first stroke is recorded from 0.4 s.
    await page.waitForFunction(() => document.querySelectorAll('[data-replay-ink-id="ink-native"] g[data-replay-stroke-id]').length === 0);
    await seekTo(1.5);
    await page.waitForFunction(() => { const g = document.querySelectorAll('[data-replay-ink-id="ink-native"] g[data-replay-stroke-id]'); return g.length === 1; });
    assert.deepEqual(await revealed(), ["s1:1.000"], "at 1.5 s only the first stroke, complete");
    await seekTo(0.7);
    assert.deepEqual(await revealed(), ["s1:0.500"], "mid-stroke at 0.7 s is half revealed");
    await seekTo(5);
    await page.waitForFunction(() => document.querySelectorAll('[data-replay-ink-id="ink-native"] g[data-replay-stroke-id]').length === 2);
    assert.deepEqual(await revealed(), ["s1:1.000", "s2:1.000"], "past 4.6 s both strokes are complete");
    await page.screenshot({ path: "/tmp/native-handoff-replay.png" });

    // Playback itself is a property of the ENGINE: the real .m4a the iPad
    // exports decodes in a codec-capable build (Chrome for Testing) and not in
    // Playwright's stock Chromium. Probe it, report it, and never pretend.
    // (`npm run e2e:notereplay` is the script that asserts real playback,
    // including that the reveal follows the audio element's own clock.)
    await seekTo(0);
    await page.getByRole("button", { name: "Play replay", exact: true }).click();
    const outcome = await Promise.race([
      page.waitForFunction(() => Number(document.querySelector('[aria-label="Replay timeline"]').value) > 0.25, null, { timeout: 10000 }).then(() => "playing").catch(() => "timeout"),
      page.waitForFunction(() => !!document.querySelector(".noteReplayMessage[role=alert]"), null, { timeout: 10000 }).then(() => "refused").catch(() => "timeout"),
    ]);
    console.log(`NOTE: real .m4a playback in ${browserName()}: ${outcome === "playing" ? "available (timeline advanced from the audio clock)" : "unavailable (no AAC decoder in this engine)"}`);
    if (outcome === "playing") {
      await page.waitForFunction(() => Number(document.querySelector('[aria-label="Replay timeline"]').value) > 1.2, null, { timeout: 15000 });
      assert.deepEqual(await revealed(), ["s1:1.000"], "during playback the reveal follows the audio clock");
    } else {
      assert.equal(outcome, "refused", "playback neither advanced nor reported why");
    }

    await page.getByRole("button", { name: "Done", exact: true }).click();
    assert.equal(await page.locator(".noteReplayBar").count(), 0);
    assert.equal(await page.locator(".pdfReplayInk").count(), 0, "leaving Replay drops the replay layer");
    // Leaving Replay must not drop back to a low-resolution picture.
    await page.waitForFunction(() => document.querySelectorAll('[data-static-ink-id="ink-native"] image').length === 2);
    assert.equal(await page.locator('img[data-ink-block-id="ink-native"]').count(), 0);
  });

  await check("a native block offers no web copy or cross-page move", async () => {
    // Its own page (the checks below freeze the main one) so nothing left over
    // from a previous check can sit over the row.
    const { context, page: held } = await handoffPage({ session: { ids: [WS], role: "owner" } });
    await held.waitForSelector("figure.nativeInkCard", { timeout: 20000 });
    // The upstream idiom (tests/e2e/scenarios/notes.mjs): hover the row so the
    // handle gutter is live, then click the handle.
    const openMenu = async (blockId) => {
      const wrap = held.locator(`.sortableBlockWrap[data-block-id="${blockId}"]`);
      await wrap.hover();
      await wrap.locator(".dragHandle").click();
      await held.waitForSelector(".ctxMenuItem", { timeout: 10000 });
    };
    const itemState = () => held.evaluate(() => {
      const find = (label) => [...document.querySelectorAll(".ctxMenuItem")]
        .find((b) => b.textContent.trim().startsWith(label));
      const dup = find("Duplicate"), move = find("Move to page");
      return {
        duplicate: dup ? { disabled: dup.disabled, title: dup.title } : null,
        move: move ? { disabled: move.disabled } : null,
      };
    });

    await openMenu("ink-native");
    let state = await itemState();
    assert.equal(state.duplicate.disabled, true, "Duplicate is disabled for native handwriting");
    assert(state.duplicate.title.length > 20, "and says why");
    assert.equal(state.move.disabled, true, "Move to page is disabled for native handwriting");
    await held.keyboard.press("Escape");

    await openMenu("rec-native");
    state = await itemState();
    assert.equal(state.duplicate.disabled, true, "Duplicate is disabled for a native recording");
    await held.keyboard.press("Escape");

    // The controls are only withdrawn where the server would refuse the write.
    await openMenu("note-native");
    state = await itemState();
    assert.equal(state.duplicate.disabled, false, "an ordinary note still duplicates");
    assert.equal(state.move.disabled, false, "and still moves");
    await context.close();
  });

  await check("the handoff payload names the page, the document, the account AND the workspace", async () => {
    // The button's visible text is "Pencil & Audio"; its accessible name is the
    // aria-label that describes the workspace it opens.
    await page.waitForSelector('.pdfPageWrap[data-page="3"]');
    const expectedViewport = await page.evaluate(() => {
      const scroller = document.querySelector('.pdfViewer');
      const box = document.querySelector('.pdfPageWrap[data-page="3"]');
      const rect = box.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
      scroller.scrollTop += rect.top - bounds.top + rect.height * 0.375;
      const actual = box.getBoundingClientRect();
      return {pageIndex:2, anchorX:Math.max(0,(bounds.left-actual.left)/actual.width), anchorY:(bounds.top-actual.top)/actual.height};
    });
    assert(Math.abs(expectedViewport.anchorY - 0.375) < 0.01, 'fixture reaches interior of page three');
    await page.getByRole("button", { name: "Open Pencil, recording and Replay" }).click();
    await page.waitForFunction(() => window.__nativeCalls.length > 0);
    const [call] = await page.evaluate(() => window.__nativeCalls);
    assert.equal(call.viewport.pageIndex, 2);
    assert(Math.abs(call.viewport.anchorY - expectedViewport.anchorY) < 0.01, 'same page-local top-visible offset');
    assert.deepEqual(call, {
      viewport: call.viewport,
      type: "openPDF", pageID: "paper-native", docID: "fixture", workspace: WS, user: USER, title: "Native paper",
    });
    // The tree is frozen afterwards: the native workspace owns the document
    // until it returns through a reload.
    assert.equal(await page.evaluate(() => document.getElementById("root").inert), true);
    assert.equal(await page.evaluate(() => window.__GAMMA_NATIVE_ACTIVE__), true);
  });

  // A page in its own context, with the iPad host stub and a mocked API whose
  // session the test can change between clicks (a role demoted, a library
  // removed, a different library switched to).
  async function handoffPage({ session, url = `?block=paper-native&ws=${WS}` }) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      window.__GAMMA_IPAD__ = true;
      window.__nativeCalls = [];
      window.webkit = { messageHandlers: { gammaNative: { postMessage: (m) => window.__nativeCalls.push(m) } } };
    });
    const page = await context.newPage();
    const assetUrls = [];
    await page.route("**/api/**", async (route) => {
      const request = new URL(route.request().url());
      if (request.pathname.startsWith("/api/assets/")) assetUrls.push(request);
      if (request.pathname === "/api/uploads/fixture.pdf") return serveBytes(route, makePdf([["Native paper"], ["Second page"], ["Third page"], ["Fourth page"]]), "application/pdf");
      if (request.pathname.endsWith(".png")) return serveBytes(route, PNG_BYTES, "image/png");
      if (request.pathname.endsWith(".pkdrawing")) return route.fulfill({ contentType: "application/octet-stream", body: "pkdrawing" });
      if (request.pathname.endsWith(".m4a")) return serveBytes(route, AUDIO.bytes, "audio/mp4");
      if (request.pathname.endsWith(".inkjson")) return route.fulfill({ contentType: "application/json", body: JSON.stringify(REPLAY_INK) });
      let body = {};
      if (request.pathname === "/api/session") {
        await session.handoffGate?.();
        body = { user: USER, is_admin: false, is_guest: false, default_workspace: session.ids[0],
          workspaces: session.ids.map((id) => ({ id, name: id, role: session.role, kind: "personal", access: "private" })) };
      } else if (request.pathname.startsWith("/api/workspaces/find-page/")) body = { workspace_id: request.searchParams.get("ws") || session.ids[0] };
      else if (request.pathname.endsWith("/subtree")) body = { block: PAPER, seq: 1 };
      else if (request.pathname.includes("recent") || request.pathname.includes("snapshot")) body = { items: [] };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(`${base}/${url}`);
    const button = page.getByRole("button", { name: "Open Pencil, recording and Replay" });
    await button.waitFor({ timeout: 20000 });
    await page.waitForSelector('.pdfPageCanvas');
    await page.waitForFunction(() => performance.getEntriesByName('pdf-rendered').length > 0);
    return { context, page, button, assetUrls };
  }
  const handoffState = (page) => page.evaluate(() => ({
    calls: window.__nativeCalls.length,
    inert: document.getElementById("root").inert === true,
    frozen: window.__GAMMA_NATIVE_ACTIVE__ === true,
  }));

  await check("handoff retains click-time page-local position across asynchronous session verification", async () => {
    const session = { ids: [WS], role: "owner" };
    const { context, page: held, button } = await handoffPage({ session });
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { entered = resolve; });
    const scroll = fraction => held.evaluate(fraction => {
      const scroller = document.querySelector('.pdfViewer');
      const box = document.querySelector('.pdfPageWrap[data-page="2"]');
      const rect = box.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
      scroller.scrollTop += rect.top - bounds.top + rect.height * fraction;
      return (bounds.top - box.getBoundingClientRect().top) / rect.height;
    }, fraction);
    try {
      const expected = await scroll(0.625);
      session.handoffGate = () => { entered(); return gate; };
      await button.click();
      await reached;
      // Simulate scroll/momentum while the authenticated session round trip is
      // pending: the user's click-time anchor, not a later sample, must travel.
      await scroll(0.125);
      release();
      await held.waitForFunction(() => window.__nativeCalls.length === 1);
      const position = await held.evaluate(() => window.__nativeCalls[0].viewport);
      assert.equal(position.pageIndex, 1);
      assert(Math.abs(position.anchorY - expected) < 0.01);
      assert(Math.abs(position.anchorY - 0.625) < 0.01);
    } finally {
      release();
      await context.close();
    }
  });

  await check("a role or membership the server no longer grants refuses the handoff", async () => {
    // The tab booted as owner; the server's answer CHANGED since (an admin
    // demoted them, or the library was removed, in another tab).
    const session = { ids: [WS], role: "owner" };
    const { context, page: page3, button } = await handoffPage({ session });

    session.role = "viewer";
    await button.click();
    // The status pill is the app's own report of why it refused (it holds the
    // "Saving notes…" line first, so wait for the refusal itself).
    await page3.waitForFunction(() => document.querySelector(".statusPill")?.textContent.includes("Pencil needs editing access"), null, { timeout: 15000 });
    let state = await handoffState(page3);
    assert.equal(state.calls, 0, "a demoted role sends nothing to native");
    assert.equal(state.inert || state.frozen, false, "and leaves a usable page behind");

    session.ids = [];
    await button.click();
    await page3.waitForFunction(() => document.querySelector(".statusPill")?.textContent.includes("no longer available to this account"), null, { timeout: 15000 });
    state = await handoffState(page3);
    assert.equal(state.calls, 0, "a lost membership sends nothing to native");
    assert.equal(state.inert || state.frozen, false, "and leaves a usable page behind");

    // Restore BOTH, and the handoff goes through again.
    session.ids = [WS];
    session.role = "owner";
    await button.click();
    await page3.waitForFunction(() => window.__nativeCalls.length > 0, null, { timeout: 15000 });
    const [call] = await page3.evaluate(() => window.__nativeCalls);
    assert.equal(call.workspace, WS, "the payload carries the bare workspace id");
    assert.deepEqual(Object.keys(call).sort(), ["docID", "pageID", "title", "type", "user", "viewport", "workspace"]);
    await context.close();
  });

  await check("the handoff names the PAGE'S library, not the first one in the account", async () => {
    // Two libraries, the page opened in the second: the payload and every
    // native asset URL must name THAT one — the iPad loads /?ws=<workspace> and
    // reads the document from that library's subtree.
    const session = { ids: [WS, WS2], role: "editor" };
    const { context, page: page4, button, assetUrls } = await handoffPage({ session, url: `?block=paper-native&ws=${WS2}` });
    await page4.waitForFunction(() => document.querySelectorAll("[data-static-note-ink] image").length === 2, null, { timeout: 20000 });
    await button.click();
    await page4.waitForFunction(() => window.__nativeCalls.length > 0, null, { timeout: 15000 });
    const [call] = await page4.evaluate(() => window.__nativeCalls);
    assert.equal(call.workspace, WS2, "the payload carries the page's library");
    assert(assetUrls.length > 0, "the page's native assets were requested");
    const wrong = assetUrls.filter((u) => u.searchParams.get("ws") !== WS2).map((u) => u.pathname + u.search);
    assert.equal(wrong.length, 0, `asset URLs in the wrong library: ${wrong.join(", ")}`);
    await context.close();
  });

  await check("the iPad control row wraps instead of overlapping the page widget", async () => {
    // Do not type into the intentionally inert, handed-off main page. Use a
    // still-active reader to exercise responsive navigation independently.
    const { context, page } = await handoffPage({ session: { ids: [WS], role: "owner" } });
    try {
    for (const viewport of [{ width: 1194, height: 834 }, { width: 834, height: 1194 }, { width: 600, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(() => {
        const a = document.querySelector(".pdfNativeAction")?.getBoundingClientRect();
        const b = document.querySelector(".pdfPageWidget")?.getBoundingClientRect();
        return a && b && (a.right + 4 <= b.left || b.right + 4 <= a.left || a.bottom + 4 <= b.top || b.bottom + 4 <= a.top);
      });
      const input = page.getByRole("textbox", { name: "Current page", exact: true });
      await input.fill("1");
      await input.press("Enter");
      await page.waitForFunction(() => document.querySelector('[aria-label="Current page"]').value === "1");
    }
    } finally { await context.close(); }
  });

  await check("a plain browser is offered no native handoff", async () => {
    const plain = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const p2 = await plain.newPage();
    await p2.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/uploads/fixture.pdf") return route.fulfill({ contentType: "application/pdf", body: makePdf([["Native paper"], ["Second page"], ["Third page"], ["Fourth page"]]) });
      let body = {};
      if (url.pathname === "/api/session") {
        body = { user: USER, is_admin: false, is_guest: false, default_workspace: WS,
          workspaces: [{ id: WS, name: "Personal", role: "owner", kind: "personal", access: "private" }] };
      } else if (url.pathname.startsWith("/api/workspaces/find-page/")) body = { workspace_id: WS };
      else if (url.pathname.endsWith("/subtree")) body = { block: PAPER, seq: 1 };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await p2.goto(`${base}/?block=paper-native&ws=${WS}`);
    await p2.waitForSelector(".pdfPageWidget", { timeout: 20000 });
    assert.equal(await p2.locator(".pdfNativeAction").count(), 0);
    await plain.close();
  });
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll native handoff checks passed.");
