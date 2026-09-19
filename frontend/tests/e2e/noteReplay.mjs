// Isolated Note Replay / native-handwriting E2E (no backend, no fixtures to
// prepare): every /api/** response is mocked in-script, so this runs anywhere
// the app builds. Adapted from the original `note-replay-app.mjs`, which needed
// an iPad export in /tmp/gamma-browser-replay-fixtures; the fixtures here are
// generated in-process instead.
//
//   npm run build && node tests/e2e/noteReplay.mjs
//   npm run build && node tests/e2e/noteReplay.mjs --require-aac   # CI where a codec-capable engine is expected
//   GAMMA_BROWSER=webkit node tests/e2e/noteReplay.mjs             # Playwright WebKit (needs its browser installed)
//   GAMMA_CHROME_PATH=/path/to/chrome node tests/e2e/noteReplay.mjs # real Chrome/Chromium with proprietary codecs
//
// WHAT THIS PROVES (browser-independent):
//   • the per-stroke derivative draws the SAME high-resolution images in the
//     notes card and over the PDF, before and after a Replay;
//   • the timeline is driven by state, not by playback: seeking to a time
//     reveals exactly the strokes the recording clock has reached;
//   • clicking a visible timed stroke seeks with its lead-in;
//   • a STALE derivative (its source_sha256 no longer matches the block's
//     drawing) is never presented as synchronized playback — the whole-block
//     PNG comes back and Replay blocks until the user opts into static notes.
//
// WHAT IT CANNOT PROVE: that audio actually plays. An <audio> element only
// decodes what the ENGINE ships; Playwright's Linux Chromium has no AAC, so
// that path is probed and reported, not asserted, unless a codec-capable engine
// is selected (see --require-aac). Media/OS/iPad behaviour stays a device check.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { makePdf } from "./harness.mjs";
import { PIXEL_PNG, renderedInkPixels, audioFixture, engineLaunchOptions, engineLabel, serveBytes } from "./nativeFixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.GAMMA_E2E_DIST || path.resolve(HERE, "..", "..", "dist");
const REQUIRE_AAC = process.argv.includes("--require-aac") || process.env.GAMMA_E2E_REQUIRE_AAC === "1";
// The recording this script drives declares ONE six-second segment: the fixture
// is made for that length (ffmpeg), not borrowed from elsewhere.
const AUDIO = await audioFixture(6);
const ENGINE = process.env.GAMMA_BROWSER === "webkit" ? webkit : process.env.GAMMA_BROWSER === "firefox" ? firefox : chromium;
const LAUNCH = engineLaunchOptions({ headless: true });

const WS = "personal-7Qk2";
const USER = "replay-owner";
const hash = (c) => c.repeat(64);
const INK_HASH = hash("a"), REPLAY_HASH = hash("b"), PREVIEW_HASH = hash("c"), AUDIO_HASH = hash("d"), STALE_HASH = hash("e");

// 612x792 page, two strokes on one line: the first recorded at 0.4–1.0 s, the
// second at 4.0–4.6 s of a 6 s recording.
const strokePng = PIXEL_PNG.toString("base64");
const replayInk = (sourceHash) => ({
  format: "gamma-ink-replay-v1",
  source_sha256: sourceHash,
  width: 612, height: 792,
  strokes: [
    { id: "s1", bounds: { x: 18, y: 37, width: 80, height: 6 }, png: strokePng,
      points: [{ x: 20, y: 40, t: 0, radius: 2 }, { x: 98, y: 40, t: 10, radius: 2 }] },
    { id: "s2", bounds: { x: 100, y: 37, width: 80, height: 6 }, png: strokePng,
      points: [{ x: 100, y: 40, t: 20, radius: 2 }, { x: 178, y: 40, t: 30, radius: 2 }] },
  ],
});

// `blockInkHash` is the drawing the block points at; `derivativeSourceHash` is
// the drawing the .inkjson claims to describe. They differ in the stale case.
function page(blockInkHash) {
  return {
    id: "paper-replay", parent_id: "root", position: "a0", content: "Replay integration paper",
    properties: { doc_id: "fixture", source_url: "/api/uploads/fixture.pdf" },
    children: [
      {
        id: "ink-replay", parent_id: "paper-replay", position: "a0", content: "Timed ink",
        properties: {
          type: "pdf_ink", pdf_page: 1,
          ink_asset: `/api/assets/${blockInkHash}.pkdrawing`,
          preview_asset: `/api/assets/${PREVIEW_HASH}.png`,
          replay_asset: `/api/assets/${REPLAY_HASH}.inkjson`,
          bounds: { x: 18, y: 37, width: 164, height: 6 },
          crop_box: { width: 612, height: 792 },
          coordinate_space: "pdf-crop-top-left-v1", ink_revision: 1,
        },
      },
      {
        id: "rec-replay", parent_id: "paper-replay", position: "a1", content: "Recorded explanation",
        properties: {
          type: "audio", audio_revision: 1, audio_state: "stopped", duration: 6,
          segments: [{ id: "seg1", asset: `/api/assets/${AUDIO_HASH}.m4a`, duration: 6, start_time: 0 }],
          replay_events: [
            { id: "e0", kind: "page", segment_id: "seg1", start: 0, end: 0, pdf_page: 1 },
            { id: "e1", kind: "stroke", segment_id: "seg1", start: 0.4, end: 1.0, pdf_page: 1, block_id: "ink-replay", stroke_id: "s1" },
            { id: "e2", kind: "stroke", segment_id: "seg1", start: 4.0, end: 4.6, pdf_page: 1, block_id: "ink-replay", stroke_id: "s2" },
          ],
        },
      },
    ],
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm",
};

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let file = path.join(DIST, url.pathname);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

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
const browser = await ENGINE.launch(LAUNCH);
let aacVerdict = "not probed";
try {
  console.log(`engine: ${engineLabel(browser)}`);
  console.log(`audio fixture: ${AUDIO.note}`);

  const mockedPage = async (context, { blockInkHash, derivativeSourceHash }) => {
    const p = await context.newPage();
    p.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
    await p.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      if (pathname === "/api/uploads/fixture.pdf") return serveBytes(route, makePdf([["Replay integration paper"]]), "application/pdf");
      if (pathname.endsWith(".png")) return serveBytes(route, PIXEL_PNG, "image/png");
      if (pathname.endsWith(".pkdrawing")) return route.fulfill({ contentType: "application/octet-stream", body: "pkdrawing" });
      // Range-aware: an <audio> element's MP4 load fails with
      // MEDIA_ERR_SRC_NOT_SUPPORTED against a mock that ignores its Range request.
      if (pathname.endsWith(".m4a")) return serveBytes(route, AUDIO.bytes, "audio/mp4");
      if (pathname.endsWith(".inkjson")) return route.fulfill({ contentType: "application/json", body: JSON.stringify(replayInk(derivativeSourceHash)) });
      let body = {};
      if (pathname === "/api/session") {
        body = { user: USER, is_admin: false, is_guest: false, default_workspace: WS,
          workspaces: [{ id: WS, name: "Personal", role: "owner", kind: "personal", access: "private" }] };
      } else if (pathname.startsWith("/api/workspaces/find-page/")) body = { workspace_id: WS };
      else if (pathname.endsWith("/subtree")) body = { block: page(blockInkHash), seq: 1 };
      else if (pathname.includes("recent") || pathname.includes("snapshot")) body = { items: [] };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await p.goto(`${base}/?block=paper-replay&ws=${WS}`);
    await p.waitForSelector(".nativeInkCard", { timeout: 20000 });
    return p;
  };
  const seekTo = (p, value) => p.locator('[aria-label="Replay timeline"]').evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  const revealed = (p, id) => p.evaluate((x) => [...document.querySelectorAll(`[data-replay-ink-id="${x}"] g[data-replay-stroke-id]`)]
    .map((g) => `${g.dataset.replayStrokeId}:${g.dataset.replayProgress}`), id);

  // ---- pass 1: a current, freshly exported derivative -----------------------
  const codecCapable = await (async () => {
    const probeCtx = await browser.newContext();
    const probe = await probeCtx.newPage();
    const verdict = await probe.evaluate(() => document.createElement("audio").canPlayType('audio/mp4; codecs="mp4a.40.2"'));
    await probeCtx.close();
    return verdict;
  })();
  console.log(`engine AAC: canPlayType('audio/mp4; codecs="mp4a.40.2"') = ${JSON.stringify(codecCapable)}`);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await mockedPage(ctx, { blockInkHash: INK_HASH, derivativeSourceHash: INK_HASH });
  const staticImages = () => p.locator('[data-static-ink-id="ink-replay"] image').evaluateAll((n) => n.map((i) => i.getAttribute("href")));

  await check("static high-resolution ink is the same in the notes and on the PDF", async () => {
    await p.waitForFunction(() => document.querySelectorAll('[data-static-ink-id="ink-replay"] image').length === 2);
    await p.waitForFunction(() => document.querySelectorAll("[data-static-note-ink] image").length === 2);
    assert.deepEqual(await p.locator("[data-static-note-ink] image").evaluateAll((n) => n.map((i) => i.getAttribute("href"))), await staticImages());
    assert.equal(await p.locator(`img[data-ink-block-id="ink-replay"]`).count(), 0, "the derivative replaced the whole-block PNG");
    const pdf = await renderedInkPixels(p.locator('[data-static-ink-id="ink-replay"]'));
    const note = await renderedInkPixels(p.locator('[data-static-note-ink]'));
    assert(pdf.count > 300, `static PDF ink must paint blue pixels: ${JSON.stringify(pdf)}`);
    assert(note.count > 300, `static notes ink must paint blue pixels: ${JSON.stringify(note)}`);
  });

  await check("Note Replay reveals exactly the strokes the clock has reached", async () => {
    await p.getByRole("button", { name: "Open Note Replay" }).click();
    await p.waitForSelector(".noteReplayBar");
    await p.waitForFunction(() => !document.querySelector('[aria-label="Play replay"]').disabled, null, { timeout: 20000 });
    await p.waitForFunction(() => document.querySelectorAll('[data-replay-ink-id="ink-replay"] g[data-replay-stroke-id]').length === 0, null, { timeout: 10000 });
    await seekTo(p, 1.5);
    await p.waitForFunction(() => { const g = document.querySelectorAll('[data-replay-ink-id="ink-replay"] g[data-replay-stroke-id]'); return g.length === 1; }, null, { timeout: 10000 });
    assert.deepEqual(await revealed(p, "ink-replay"), ["s1:1.000"], "at 1.5 s only the first stroke, complete");
    const full = await renderedInkPixels(p.locator('[data-replay-ink-id="ink-replay"]'));
    assert(full.count > 150, `complete stroke must paint blue pixels: ${JSON.stringify(full)}`);
    await seekTo(p, 0.7);
    assert.deepEqual(await revealed(p, "ink-replay"), ["s1:0.500"], "mid-stroke at 0.7 s is half revealed");
    const half = await renderedInkPixels(p.locator('[data-replay-ink-id="ink-replay"]'));
    assert(half.count > full.count * 0.2 && half.count < full.count * 0.65,
      `half-stroke mask must paint only its prefix, not zero/full ink: ${JSON.stringify({ half, full })}`);
    const extent = (half.maxX - full.minX) / (full.maxX - full.minX);
    assert(extent > 0.4 && extent < 0.65, `half-stroke painted extent must end near midpoint, got ${extent}`);
    await p.screenshot({ path: "/tmp/gamma-note-replay-half.png" });
    await seekTo(p, 5);
    await p.waitForFunction(() => document.querySelectorAll('[data-replay-ink-id="ink-replay"] g[data-replay-stroke-id]').length === 2, null, { timeout: 10000 });
    assert.deepEqual(await revealed(p, "ink-replay"), ["s1:1.000", "s2:1.000"], "past 4.6 s both strokes are complete");
    const both = await renderedInkPixels(p.locator('[data-replay-ink-id="ink-replay"]'));
    assert(both.count > full.count * 1.8, "both finished strokes must visibly paint, not merely exist in the DOM");
    await p.screenshot({ path: "/tmp/gamma-note-replay-seek.png" });
  });

  await check("clicking a visible timed stroke seeks with its lead-in", async () => {
    // Nothing is drawn at 0 s — a stroke exists only once the clock reaches it.
    await seekTo(p, 5);
    await p.waitForFunction(() => document.querySelectorAll('[data-replay-ink-id="ink-replay"] image').length === 2, null, { timeout: 10000 });
    await p.locator('[data-replay-ink-id="ink-replay"] image').nth(1).click({ force: true, position: { x: 20, y: 3 } });
    await p.waitForFunction(() => Number(document.querySelector('[aria-label="Replay timeline"]').value) > 0, null, { timeout: 10000 });
    const value = Number(await p.locator('[aria-label="Replay timeline"]').inputValue());
    // s2 starts at 4.0 s; the click lands two seconds before it.
    assert(value >= 1.5 && value <= 2.5, `a stroke click should seek to ~2 s, got ${value}`);
  });

  await check("playback is driven by the audio element, or reported as unavailable — never faked", async () => {
    await seekTo(p, 0);
    // Confirm the clock really is at zero before probing: a stale slider value
    // would read as "already playing" and fake the result in either direction.
    await p.waitForFunction((sel) => Number(document.querySelector(sel).value) < 0.05, '[aria-label="Replay timeline"]', { timeout: 10000 });
    await p.getByRole("button", { name: "Play replay", exact: true }).click();
    const outcome = await Promise.race([
      p.waitForFunction(() => Number(document.querySelector('[aria-label="Replay timeline"]').value) > 0.25, null, { timeout: 12000 }).then(() => "playing").catch(() => "timeout"),
      p.waitForFunction(() => !!document.querySelector(".noteReplayMessage[role=alert]"), null, { timeout: 12000 }).then(() => "refused").catch(() => "timeout"),
    ]);
    if (outcome === "refused") {
      const msg = await p.locator(".noteReplayMessage[role=alert]").innerText();
      aacVerdict = `UNAVAILABLE in ${engineLabel(browser)}: ${msg.trim()}`;
      console.log(`NOTE: AAC playback ${aacVerdict}`);
      console.log("NOTE: playback assertions SKIPPED — the timeline was still driven by seeks above; "
        + "run with a codec-capable engine (CHROME_PATH=/path/to/chrome, or GAMMA_BROWSER=webkit) to assert real playback.");
      if (REQUIRE_AAC) throw new Error(`--require-aac was requested but ${aacVerdict}`);
      return;
    }
    assert.equal(outcome, "playing", "the timeline never advanced and no error was reported");
    aacVerdict = `available in ${engineLabel(browser)} — real playback asserted`;
    // The AUDIO CLOCK (not a timer, not a frame counter) decides what is drawn:
    // soon after playback passes 1.0 s the first stroke is complete while the
    // second (recorded at 4.0 s) is still absent — and once playback passes
    // 4.6 s BOTH are complete, without any seek.
    await seekTo(p, 0);
    await p.waitForFunction((sel) => Number(document.querySelector(sel).value) < 0.05, '[aria-label="Replay timeline"]', { timeout: 10000 });
    await p.getByRole("button", { name: "Play replay", exact: true }).click();
    await p.waitForFunction(() => Number(document.querySelector('[aria-label="Replay timeline"]').value) > 1.2, null, { timeout: 15000 });
    const midPlay = await revealed(p, "ink-replay");
    assert.deepEqual(midPlay, ["s1:1.000"], `during playback just past 1.2 s the reveal was ${JSON.stringify(midPlay)}`);
    await p.waitForFunction(() => Number(document.querySelector('[aria-label="Replay timeline"]').value) > 4.8, null, { timeout: 20000 });
    const latePlay = await revealed(p, "ink-replay");
    assert.deepEqual(latePlay, ["s1:1.000", "s2:1.000"], `past 4.8 s of playback the reveal was ${JSON.stringify(latePlay)}`);
    await p.getByRole("button", { name: "Pause replay", exact: true }).click();
    const atPause = Number(await p.locator('[aria-label="Replay timeline"]').inputValue());
    await new Promise((r) => setTimeout(r, 600));
    const afterPause = Number(await p.locator('[aria-label="Replay timeline"]').inputValue());
    assert(Math.abs(afterPause - atPause) < 0.15, `paused playback advanced ${atPause} -> ${afterPause}`);
  });

  await check("Done drops the replay layer and restores the same complete static ink", async () => {
    await p.getByRole("button", { name: "Done", exact: true }).click();
    assert.equal(await p.locator(".noteReplayBar").count(), 0);
    assert.equal(await p.locator(".pdfReplayInk").count(), 0);
    await p.waitForFunction(() => document.querySelectorAll('[data-static-ink-id="ink-replay"] image').length === 2);
    assert.deepEqual(await staticImages(), await p.locator("[data-static-note-ink] image").evaluateAll((n) => n.map((i) => i.getAttribute("href"))),
      "leaving Replay does not fall back to a lower-resolution picture");
    await p.screenshot({ path: "/tmp/gamma-static-hd-ink.png" });
  });
  await ctx.close();

  // ---- pass 2: a stale derivative (the drawing was re-edited on the iPad) ----
  const staleCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // The block's drawing was re-edited on the iPad; the stored .inkjson still
  // describes the previous one.
  const stale = await mockedPage(staleCtx, { blockInkHash: STALE_HASH, derivativeSourceHash: INK_HASH });
  await check("a stale derivative is refused instead of masquerading as synchronized playback", async () => {
    assert.equal(await stale.locator('[data-static-ink-id="ink-replay"]').count(), 0, "no per-stroke layer from a stale file");
    await stale.waitForSelector('img[data-ink-block-id="ink-replay"]', { timeout: 20000 });
    assert.equal(await stale.locator('[data-static-note-ink]').count(), 0, "the notes card falls back to the whole-block PNG");
    await stale.getByRole("button", { name: "Open Note Replay" }).click();
    await stale.waitForSelector(".noteReplayBar");
    await stale.getByText("Some timed notes need stroke previews").waitFor();
    assert.equal(await stale.getByRole("button", { name: "Play replay", exact: true }).isDisabled(), true,
      "synchronized playback stays blocked until the user opts into static notes");
    await stale.getByRole("checkbox", { name: "Play audio with static fallback notes" }).check();
    await stale.waitForFunction(() => !document.querySelector('[aria-label="Play replay"]').disabled, null, { timeout: 10000 });
    assert.equal(await stale.locator(".pdfReplayInk").count(), 0, "even then no replay layer is drawn from a stale file");
  });
  await staleCtx.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`\naudio: ${aacVerdict}`);
if (failures.length) {
  console.error(`${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("All Note Replay checks passed.");
