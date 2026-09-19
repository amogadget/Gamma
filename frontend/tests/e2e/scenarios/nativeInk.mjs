// The native (iPad) path over the REAL routes: /api/assets plus the per-block
// ink / audio writers (gamma/routers/native_ink.py), and the web's rendering of
// what they store — static high-resolution strokes, an audio block, and Note
// Replay's clock-driven reveal — with every asset request scoped to the library.
import crypto from "node:crypto";
import { waitForPdf } from "./pdf.mjs";
import { PIXEL_PNG, renderedInkPixels, audioFixture, secondSegment } from "../nativeFixtures.mjs";

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// The per-stroke display derivative for one drawing: 612x792, two strokes.
const replayInkJson = (sourceHash, strokePng) => Buffer.from(JSON.stringify({
  format: "gamma-ink-replay-v1",
  source_sha256: sourceHash,
  width: 612, height: 792,
  strokes: [
    { id: "s1", bounds: { x: 18, y: 37, width: 80, height: 6 }, png: strokePng,
      points: [{ x: 20, y: 40, t: 0, radius: 2 }, { x: 98, y: 40, t: 10, radius: 2 }] },
    { id: "s2", bounds: { x: 100, y: 37, width: 80, height: 6 }, png: strokePng,
      points: [{ x: 100, y: 40, t: 20, radius: 2 }, { x: 178, y: 40, t: 30, radius: 2 }] },
  ],
}));

export async function nativeScenarios({ server, browser, alice, bob, makePdf, step, until, assert, assertEq, assertNoProblems, openPage }) {
  const account = alice;
  let ctx, page, pageId, docId, inkId, audioId, outerId, holderId, assetRequests = [];
  let segmentUrls = [];

  await step("native: the iPad's assets upload content-addressed and the ink/audio writers store the blocks", async () => {
    const pdf = makePdf([["Native handwriting", "written on an iPad"]]);
    const up = await account.upload("/api/uploads", pdf, "native.pdf", "application/pdf");
    const created = await account.api(`/api/blocks/by-doc/${up.doc_id}`, { method: "POST", body: { default_title: "Native paper", source_url: up.source_url } });
    pageId = created.id;
    docId = up.doc_id;
    // Preceding ordinary siblings give Tab real same-page destinations.
    outerId = (await account.api("/api/blocks", { method: "POST",
      body: { parent_id: pageId, content: "Outer native group" } })).id;
    holderId = (await account.api("/api/blocks", { method: "POST",
      body: { parent_id: pageId, content: "Native annotation group" } })).id;

    // The four assets one export carries: the editable drawing, its preview,
    // the per-stroke display derivative and a finalized audio segment.
    const drawing = Buffer.from("gamma-pkdrawing-fixture-bytes");
    const replayBody = replayInkJson(sha(drawing), PIXEL_PNG.toString("base64"));
    const replayAsset = await account.upload("/api/assets", replayBody, `${sha(replayBody)}.inkjson`, "application/json");
    const inkAsset = await account.upload("/api/assets", drawing, `${sha(drawing)}.pkdrawing`, "application/octet-stream");
    const previewAsset = await account.upload("/api/assets", PIXEL_PNG, `${sha(PIXEL_PNG)}.png`, "image/png");
    // TWO finalized segments — a paused-and-resumed recording, which is what the
    // player's segment machinery exists for. Each segment declares 3 s, and the
    // fixture is made at exactly that length (ffmpeg), so the media and the
    // declared timeline agree.
    const audio = await audioFixture(3);
    const second = secondSegment(audio.bytes);
    const audioAsset = await account.upload("/api/assets", audio.bytes, `${sha(audio.bytes)}.m4a`, "audio/mp4");
    const secondAsset = await account.upload("/api/assets", second, `${sha(second)}.m4a`, "audio/mp4");
    segmentUrls = [audioAsset.url, secondAsset.url];

    inkId = crypto.randomUUID();
    const inkBlock = await account.api(`/api/blocks/${inkId}/ink`, {
      method: "PUT",
      body: {
        parent_id: pageId, pdf_page: 1,
        ink_asset: inkAsset.url, preview_asset: previewAsset.url, replay_asset: replayAsset.url,
        bounds: { x: 18, y: 37, width: 164, height: 6 },
        crop_box: { width: 612, height: 792 },
      },
    });
    assertEq(inkBlock.properties.type, "pdf_ink", "ink block type");
    assertEq(inkBlock.properties.pdf_page, 1, "ink block page");
    assertEq(inkBlock.properties.ink_revision, 1, "first revision");
    assertEq(inkBlock.properties.preview_asset, previewAsset.url, "the preview reference is stored as sent");
    assertEq(inkBlock.properties.replay_asset, replayAsset.url, "the derivative reference is stored as sent");

    // One recording session: two finalized segments and the timeline that binds
    // the strokes to the AUDIO clock (segment 2 starts at 3 s, so the second
    // stroke's absolute time is 3.4 s).
    const segmentIds = [crypto.randomUUID(), crypto.randomUUID()];
    audioId = crypto.randomUUID();
    const audioBlock = await account.api(`/api/blocks/${audioId}/audio`, {
      method: "PUT",
      body: {
        parent_id: pageId, audio_state: "stopped",
        segments: [
          { id: segmentIds[0], asset: audioAsset.url, duration: 3 },
          { id: segmentIds[1], asset: secondAsset.url, duration: 3 },
        ],
        replay_events: [
          { id: crypto.randomUUID(), kind: "page", segment_id: segmentIds[0], start: 0, end: 0, pdf_page: 1 },
          { id: crypto.randomUUID(), kind: "stroke", segment_id: segmentIds[0], start: 0.4, end: 1.0, pdf_page: 1, block_id: inkId, stroke_id: "s1" },
          { id: crypto.randomUUID(), kind: "stroke", segment_id: segmentIds[1], start: 0.4, end: 1.0, pdf_page: 1, block_id: inkId, stroke_id: "s2" },
        ],
      },
    });
    assertEq(audioBlock.properties.type, "audio", "audio block type");
    assertEq(audioBlock.properties.segments[0].start_time, 0, "the server derives the first offset");
    assertEq(audioBlock.properties.segments[1].start_time, 3, "and the second segment's offset");
    assertEq(audioBlock.properties.duration, 6, "the server derives the duration");
    assertEq(audioBlock.properties.replay_events.length, 3, "the timeline is stored");

    // A native asset is library-scoped: the SAME file asked for in another
    // library is refused, and in its own library it is served. That is what
    // makes the ?ws= the web adds to every <img>/<audio>/loader URL
    // load-bearing (the fetch wrapper's header covers API calls; those are not
    // API calls, and neither is pdf.js's own fetch of the document).
    const foreign = await account.api(`${previewAsset.url}?ws=certainly-not-a-library`, { raw: true });
    assert(foreign.status === 403 || foreign.status === 404,
      `an asset read in another library answered ${foreign.status}, not a refusal`);
    const own = await account.api(previewAsset.url, { raw: true });
    assertEq(own.status, 200, "the same asset in its own library");
    const anonymous = await fetch(`${server.base}${previewAsset.url}?ws=${account.ws}`);
    assertEq(anonymous.status, 401, "an asset read without a session");

    // The same bytes are also served under the /api/uploads alias (the block
    // stores the canonical /api/assets form; both are references the orphan
    // sweep must recognise).
    const viaAssets = Buffer.from(await (await account.api(previewAsset.url, { raw: true })).arrayBuffer());
    const viaUploads = Buffer.from(await (await account.api(previewAsset.url.replace("/api/assets/", "/api/uploads/"), { raw: true })).arrayBuffer());
    assertEq(sha(viaUploads), sha(viaAssets), "the alias serves identical bytes");

    // Range support on a media asset: this is what an <audio> element asks for,
    // and real playback (Chrome for Testing) goes through it.
    const ranged = await fetch(`${server.base}${secondAsset.url}`, {
      headers: { Cookie: `session=${account.session}`, "X-Gamma-Workspace": account.ws, Range: "bytes=0-99" },
    });
    assertEq(ranged.status, 206, "a Range request on the m4a");
    assertEq(ranged.headers.get("content-range"), `bytes 0-99/${second.length}`, "the advertised range");
    assertEq((await ranged.arrayBuffer()).byteLength, 100, "exactly the requested slice");
  });

  await step("native: the notes show the strokes and the audio, and the PDF draws the same high-resolution ink", async () => {
    ctx = await account.context(browser);
    page = await openPage(ctx, `${server.base}/?page=${pageId}&ws=${account.ws}`);
    assetRequests = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/assets/")) assetRequests.push(u);
    });
    await waitForPdf(page, 1);
    await page.waitForSelector(".nativeInkCard", { timeout: 20000 });
    await page.waitForSelector(".nativeAudio audio", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll("[data-static-note-ink] image").length === 2, null, { timeout: 20000 });
    await page.waitForFunction((id) => document.querySelectorAll(`[data-static-ink-id="${id}"] image`).length === 2, inkId, { timeout: 20000 });
    const onPdf = await page.locator(`[data-static-ink-id="${inkId}"] image`).evaluateAll((n) => n.map((i) => i.getAttribute("href")));
    const inNotes = await page.locator("[data-static-note-ink] image").evaluateAll((n) => n.map((i) => i.getAttribute("href")));
    assertEq(inNotes.length, 2, "both strokes in the notes");
    assertEq(onPdf.length, 2, "both strokes on the PDF");
    assert(onPdf[0] === inNotes[0] && onPdf[1] === inNotes[1], "the notes and the PDF share the same stroke images");
    for (const selector of [`[data-static-ink-id="${inkId}"]`, "[data-static-note-ink]"]) {
      const pixels = await renderedInkPixels(page.locator(selector));
      assert(pixels.count > 300, `static ink must visibly paint: ${selector} ${JSON.stringify(pixels)}`);
    }
    // The whole-block PNG layer is not used while a derivative is loaded.
    assertEq(await page.locator(`img[data-ink-block-id="${inkId}"]`).count(), 0, "no fallback PNG layer");
    // Native routes are workspace-scoped and an <img>/<audio> src bypasses the
    // fetch wrapper, so the library has to be named in the URL.
    assert(assetRequests.length > 0, "assets were requested");
    const unscoped = assetRequests.filter((u) => u.searchParams.get("ws") !== account.ws).map((u) => u.pathname);
    assertEq(unscoped.length, 0, `asset requests without ws: ${unscoped.join(", ")}`);
    assert(assetRequests.some((u) => u.pathname.endsWith(".inkjson")), "the per-stroke derivative was loaded");
    assert(assetRequests.some((u) => u.pathname.endsWith(".png")), "the preview was loaded");

    // Tab/Shift+Tab are real browser edits, saved through the page's op queue.
    // The native writers anchor ink/audio to the PDF page, not the immediate
    // outliner parent. Revisions, geometry, assets and replay manifests survive.
    const beforeNesting = await Promise.all([inkId, audioId].map((id) => account.api(`/api/blocks/${id}`)));
    const rowFor = (id) => page.locator(`.sortableBlockWrap[data-block-id="${id}"]`);
    const moveByKey = async (id, key, parentId, depth) => {
      await rowFor(id).locator(".blockRendered").click();
      await page.keyboard.press(key);
      await until(async () => (await account.api(`/api/blocks/${id}`)).parent_id === parentId,
        { what: `${key} on ${id} to persist under ${parentId}` });
      await page.keyboard.press("Escape");
      await page.waitForFunction(({ id, depth }) =>
        document.querySelector(`.sortableBlockWrap[data-block-id="${id}"]`)?.dataset.depth === String(depth),
      { id, depth }, { timeout: 10000 });
    };
    const assertPayloads = async () => {
      for (const before of beforeNesting) {
        const after = await account.api(`/api/blocks/${before.id}`);
        assertEq(after.content, before.content, "nesting leaves the caption unchanged");
        assertEq(JSON.stringify(after.properties), JSON.stringify(before.properties),
          "nesting leaves the entire native payload and revision unchanged");
      }
    };
    await moveByKey(inkId, "Tab", holderId, 1);
    await moveByKey(audioId, "Tab", holderId, 1);
    // An ordinary ancestor carrying both native blocks can itself nest.
    await moveByKey(holderId, "Tab", outerId, 1);
    await assertPayloads();
    await page.reload();
    await waitForPdf(page, 1);
    await page.waitForSelector(`.sortableBlockWrap[data-block-id="${inkId}"][data-depth="2"]`);
    await page.waitForSelector(`.sortableBlockWrap[data-block-id="${audioId}"][data-depth="2"]`);
    assertEq((await account.api(`/api/blocks/${holderId}`)).parent_id, outerId, "ancestor nesting persisted across reload");
    // A native descendant must disable the ancestor's copy/cross-page controls.
    await rowFor(holderId).locator(".dragHandle").click();
    for (const label of ["Duplicate", "Move to page…"]) {
      assert(await page.locator(".ctxMenuItem", { hasText: label }).isDisabled(), `${label} is disabled for a native subtree`);
    }
    await page.keyboard.press("Escape");
    await moveByKey(holderId, "Shift+Tab", pageId, 0);
    await moveByKey(audioId, "Shift+Tab", pageId, 0);
    await moveByKey(inkId, "Shift+Tab", pageId, 0);
    await page.reload();
    await waitForPdf(page, 1);
    for (const id of [inkId, audioId]) {
      await page.waitForSelector(`.sortableBlockWrap[data-block-id="${id}"][data-depth="0"]`);
      assertEq((await account.api(`/api/blocks/${id}`)).parent_id, pageId, "outdent persisted across reload");
    }
    await assertPayloads();

    // A native note under the annotation (PUT /blocks/{id}/note): writing its
    // text from the web is allowed and moves `note_revision`, so an iPad holding
    // a queued offline save conflicts instead of overwriting the edit.
    const noteId = crypto.randomUUID();
    const note = await account.api(`/api/blocks/${noteId}/note`, {
      method: "PUT",
      body: { parent_id: inkId, content: "the iPad's own note" },
    });
    assertEq(note.properties.native_note, true, "the note is marked native");
    assertEq(note.properties.note_revision, 1, "first note revision");
    const noteRow = page.locator(`.sortableBlockWrap[data-block-id="${noteId}"]`);
    await noteRow.waitFor({ timeout: 20000 }); // the page's room delivers it live
    await noteRow.locator(".blockRendered").click();
    await page.keyboard.press("Shift+Tab");
    await page.getByText("Native notes keep their parent — this block cannot be re-parented here.", { exact: true }).waitFor();
    assertEq((await account.api(`/api/blocks/${noteId}`)).parent_id, inkId, "native note keeps its exact parent");
    await page.keyboard.press("End");
    await page.keyboard.type(" — edited on the web");
    await page.keyboard.press("Escape");
    const edited = await until(async () => {
      const b = await account.api(`/api/blocks/${noteId}`);
      return (b.content || "").includes("edited on the web") ? b : null;
    }, { what: "the web edit of a native note to save" });
    assert(edited.properties.note_revision > 1, `note_revision moved (${edited.properties.note_revision})`);
    assertNoProblems(page);
  });

  await step("native: Note Replay masks the strokes by the recording's own clock", async () => {
    await page.getByRole("button", { name: "Open Note Replay" }).click();
    await page.waitForSelector(".noteReplayBar");
    // Nothing yet: the first stroke is recorded from 0.4 s.
    await page.waitForFunction((id) => document.querySelectorAll(`[data-replay-ink-id="${id}"] g[data-replay-stroke-id]`).length === 0, inkId, { timeout: 15000 });
    const seekTo = (value) => page.locator('[aria-label="Replay timeline"]').evaluate((el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    await seekTo(1.5);
    await page.waitForFunction((id) => {
      const g = document.querySelectorAll(`[data-replay-ink-id="${id}"] g[data-replay-stroke-id]`);
      return g.length === 1 && g[0].dataset.replayStrokeId === "s1" && g[0].dataset.replayProgress === "1.000";
    }, inkId, { timeout: 15000 });
    // The <audio> element follows the clock's segment: this is the second one.
    const audioSrc = () => page.locator(".noteReplayBar audio").evaluate((a) => a.getAttribute("src") || a.src || "");
    assert((await audioSrc()).includes(segmentUrls[0]), "segment 1 is loaded at 1.5 s");
    const inkLayer = page.locator(`[data-replay-ink-id="${inkId}"]`);
    const full = await renderedInkPixels(inkLayer);
    assert(full.count > 150, `complete stroke paints visible pixels: ${JSON.stringify(full)}`);
    await seekTo(0.7);
    await page.waitForFunction((id) => document.querySelector(`[data-replay-ink-id="${id}"] g[data-replay-stroke-id]`)?.dataset.replayProgress === "0.500", inkId);
    const half = await renderedInkPixels(inkLayer);
    const extent = (half.maxX - full.minX) / (full.maxX - full.minX);
    assert(half.count > full.count * 0.2 && half.count < full.count * 0.65 && extent > 0.4 && extent < 0.65,
      `half-stroke must render only the leading half: ${JSON.stringify({ full, half, extent })}`);
    // Between the two strokes (1.0 s .. 3.4 s) nothing is revealed.
    await seekTo(2);
    await page.waitForFunction((id) => document.querySelectorAll(`[data-replay-ink-id="${id}"] g[data-replay-stroke-id]`).length === 1, inkId, { timeout: 15000 });
    // Crossing the segment boundary (segment 2 starts at 3 s, its stroke at 3.4 s)
    // not only reveals the stroke: the player has switched its source.
    await seekTo(4.5);
    await page.waitForFunction((id) => document.querySelectorAll(`[data-replay-ink-id="${id}"] g[data-replay-stroke-id]`).length === 2, inkId, { timeout: 15000 });
    assert((await audioSrc()).includes(segmentUrls[1]), "the second segment is playing after the seek");

    // Real playback of the .m4a the iPad actually exports. An engine without an
    // AAC decoder (Playwright's stock Chromium) cannot do this, so it is probed
    // and reported; GAMMA_E2E_REQUIRE_AAC=1 makes a missing decoder a failure
    // where one is expected (Chrome for Testing: CHROME_PATH=/…/chrome).
    await seekTo(0);
    // Make sure the UI agrees the clock is at zero BEFORE probing: a stale
    // slider value reads as "already playing" and would fake the probe.
    await page.waitForFunction((sel) => Number(document.querySelector(sel).value) < 0.05, '[aria-label="Replay timeline"]', { timeout: 10000 });
    await page.getByRole("button", { name: "Play replay", exact: true }).click();
    const outcome = await Promise.race([
      page.waitForFunction(() => Number(document.querySelector('[aria-label="Replay timeline"]').value) > 0.25, null, { timeout: 12000 }).then(() => "playing").catch(() => "timeout"),
      page.waitForFunction(() => !!document.querySelector(".noteReplayMessage[role=alert]"), null, { timeout: 12000 }).then(() => "refused").catch(() => "timeout"),
    ]);
    const revealedNow = () => page.evaluate(() => [...document.querySelectorAll(`[data-replay-ink-id="${window.__inkId}"] g[data-replay-stroke-id]`)]
      .map((g) => `${g.dataset.replayStrokeId}:${g.dataset.replayProgress}`));
    await page.evaluate((id) => { window.__inkId = id; }, inkId);
    if (outcome === "playing") {
      await page.waitForFunction(() => Number(document.querySelector('[aria-label="Replay timeline"]').value) > 1.2, null, { timeout: 15000 });
      assert(JSON.stringify(await revealedNow()) === JSON.stringify(["s1:1.000"]),
        "during playback only the stroke the audio clock has reached is drawn");
      await page.waitForFunction(() => Number(document.querySelector('[aria-label="Replay timeline"]').value) > 4.8, null, { timeout: 25000 });
      assert(JSON.stringify(await revealedNow()) === JSON.stringify(["s1:1.000", "s2:1.000"]),
        "and past the second segment's stroke both are complete, without a seek");
      assert((await audioSrc()).includes(segmentUrls[1]), "the clock crossed into the second segment on its own");
      await page.getByRole("button", { name: "Pause replay", exact: true }).click();
      const atPause = Number(await page.locator('[aria-label="Replay timeline"]').inputValue());
      await page.waitForTimeout(600);
      const afterPause = Number(await page.locator('[aria-label="Replay timeline"]').inputValue());
      assert(Math.abs(afterPause - atPause) < 0.15, `paused playback advanced ${atPause} -> ${afterPause}`);
      return `real .m4a playback asserted (t=${afterPause.toFixed(2)}s)`;
    }
    assertEq(outcome, "refused", "playback neither advanced nor reported why");
    if (process.env.GAMMA_E2E_REQUIRE_AAC === "1") {
      throw new Error("GAMMA_E2E_REQUIRE_AAC=1 but this engine has no AAC decoder");
    }
    return "audio undecodable in this engine — playback skipped, timeline asserted from seeks";
    // Done drops the replay layer, and the static strokes come back complete.
    await page.getByRole("button", { name: "Done", exact: true }).click();
    assertEq(await page.locator(".pdfReplayInk").count(), 0, "the replay layer is gone");
    await page.waitForFunction((id) => document.querySelectorAll(`[data-static-ink-id="${id}"] image`).length === 2, inkId, { timeout: 20000 });
    assertNoProblems(page);
    await ctx.close();
  });

  await step("native: an older annotation gains its per-stroke preview later, and the open page upgrades live", async () => {
    // An annotation from an iPad build that exported no derivative: the drawing
    // and its whole-block PNG only. It renders from the PNG; the backfill below
    // (PUT /blocks/{id}/replay-preview, metadata-only) must upgrade it in place,
    // without minting a revision and without a manual reload.
    const drawing = Buffer.from("gamma-pkdrawing-fixture-older");
    const olderInk = await account.upload("/api/assets", drawing, `${sha(drawing)}.pkdrawing`, "application/octet-stream");
    const olderPng = await account.upload("/api/assets", PIXEL_PNG, `${sha(PIXEL_PNG)}.png`, "image/png");
    const olderId = crypto.randomUUID();
    const stored = await account.api(`/api/blocks/${olderId}/ink`, {
      method: "PUT",
      body: {
        parent_id: pageId, pdf_page: 1,
        ink_asset: olderInk.url, preview_asset: olderPng.url,
        bounds: { x: 60, y: 120, width: 120, height: 40 },
        crop_box: { width: 612, height: 792 },
      },
    });
    assert(!stored.properties.replay_asset, "no derivative at first");
    const revision = stored.properties.ink_revision;

    const oldCtx = await account.context(browser);
    const older = await openPage(oldCtx, `${server.base}/?page=${pageId}&ws=${account.ws}`);
    await waitForPdf(older, 1);
    await older.waitForSelector(`img[data-ink-block-id="${olderId}"]`, { timeout: 20000 });
    assertEq(await older.locator(`[data-static-ink-id="${olderId}"]`).count(), 0, "no per-stroke layer yet");
    assertEq(await older.locator("figure.nativeInkCard img").count() > 0, true, "the notes show the whole-block PNG");

    const replayBody = replayInkJson(sha(drawing), PIXEL_PNG.toString("base64"));
    const replayAsset = await account.upload("/api/assets", replayBody, `${sha(replayBody)}.inkjson`, "application/json");
    const backfilled = await account.api(`/api/blocks/${olderId}/replay-preview`, {
      method: "PUT",
      body: { ink_asset: olderInk.url, replay_asset: replayAsset.url },
    });
    assertEq(backfilled.properties.replay_asset, replayAsset.url, "the derivative is attached");
    assertEq(backfilled.properties.ink_revision, revision, "and no revision was minted");

    // The page was OPEN: the op arrives over its room, so the static layer and
    // the notes thumbnail switch to the per-stroke images on their own.
    await older.waitForFunction((id) => document.querySelectorAll(`[data-static-ink-id="${id}"] image`).length === 2, olderId, { timeout: 20000 });
    assertEq(await older.locator(`img[data-ink-block-id="${olderId}"]`).count(), 0, "the PNG fallback is replaced");
    await older.waitForFunction(() => document.querySelectorAll("figure.nativeInkCard [data-static-note-ink]").length === 2, null, { timeout: 20000 });
    assertNoProblems(older);
    await oldCtx.close();
  });

  await step("native: a highlight written by the iPad is an ordinary highlight in the web", async () => {
    // PUT /blocks/{id}/highlight is the iPad's text-selection path: a normal
    // highlight block with a client-minted id, so the web's overlay, notes row
    // and comment editing all apply unchanged.
    const hlId = crypto.randomUUID();
    const created = await account.api(`/api/blocks/${hlId}/highlight`, {
      method: "PUT",
      body: {
        parent_id: pageId,
        quote: "a passage the iPad selected",
        color: "#ffd400",
        pdf_position: {
          pageNumber: 1,
          boundingRect: { x1: 72, y1: 96, x2: 300, y2: 112, width: 612, height: 792, pageNumber: 1 },
          rects: [{ x1: 72, y1: 96, x2: 300, y2: 112, width: 612, height: 792, pageNumber: 1 }],
        },
      },
    });
    assertEq(created.properties.highlight_id, hlId, "the client-minted id IS the highlight id");
    assertEq(created.properties.pdf_page, 1, "its page");

    const hlCtx = await account.context(browser);
    const hlPage = await openPage(hlCtx, `${server.base}/?page=${pageId}&ws=${account.ws}`);
    await waitForPdf(hlPage, 1);
    await hlPage.waitForSelector(`[data-hl-id="${hlId}"]`, { timeout: 20000 });
    const row = hlPage.locator(`.sortableBlockWrap[data-block-id="${hlId}"]`);
    await row.waitFor({ timeout: 20000 });
    assert((await row.innerText()).includes("the iPad selected"), "the quote is the notes card");

    // A web comment on it is an ordinary block update.
    await account.api(`/api/blocks/${hlId}`, { method: "PUT", body: { content: "a web comment on the iPad's highlight" } });
    await hlPage.waitForFunction(() => document.body.innerText.includes("a web comment on the iPad's highlight"), null, { timeout: 20000 });
    assertEq(await hlPage.locator(`[data-hl-id="${hlId}"]`).count() > 0, true, "the overlay survives the edit");
    assertNoProblems(hlPage);
    await hlCtx.close();
  });

  await step("native: deleting an annotation from the web is undoable, and a forged generic copy is refused", async () => {
    const ownCtx = await account.context(browser);
    const own = await openPage(ownCtx, `${server.base}/?page=${pageId}&ws=${account.ws}`);
    await waitForPdf(own, 1);
    const wrap = own.locator(`.sortableBlockWrap[data-block-id="${inkId}"]`);
    await wrap.waitFor({ timeout: 20000 });
    const before = await account.api(`/api/blocks/${inkId}`);
    const annotationsBefore = (await account.api(`/api/blocks/${pageId}/subtree`)).block.children
      .filter((b) => b.properties?.type === "pdf_ink").map((b) => b.id).sort();

    // A generic insert carrying the same manifest is exactly what the server
    // refuses — the reason the row's Duplicate control is disabled rather than
    // left to fail. A generic patch may not touch a reserved key either.
    const forged = await account.api("/api/blocks", { method: "POST", raw: true,
      body: { parent_id: pageId, content: "", properties: { ...before.properties } } });
    assertEq(forged.status, 409, "a generic insert carrying a native manifest");
    const patch = await account.api(`/api/blocks/${inkId}`, { method: "PUT", raw: true,
      body: { properties: { replay_asset: null } } });
    assertEq(patch.status, 409, "a generic patch touching a reserved key");

    // Deleting is allowed, and Ctrl+Z restores it: the server records what the
    // delete removed and accepts an insert that reproduces it exactly, so this
    // is a supported path rather than a bypass.
    await wrap.hover();
    await wrap.locator(".blockDeleteBtn").click();
    // The undo path needs the BYTES to still be there after the delete: the
    // restored block references the same drawing and derivative. (Orphan
    // retention is the server's; this asserts what the web depends on.)
    const surviving = await account.api(before.properties.ink_asset, { raw: true });
    assertEq(surviving.status, 200, "the drawing is still served right after the block was deleted");
    await until(async () => {
      const tree = await account.api(`/api/blocks/${pageId}/subtree`);
      return (tree.block.children || []).every((b) => b.id !== inkId);
    }, { what: "the delete to commit" });
    await own.keyboard.press("Control+z");
    const restored = await until(async () => {
      const tree = await account.api(`/api/blocks/${pageId}/subtree`);
      return (tree.block.children || []).find((b) => b.id === inkId) || null;
    }, { what: "the undo to restore the annotation" });
    assertEq(restored.properties.ink_revision, before.properties.ink_revision, "the RECORDED revision, not a re-mint");
    assertEq(restored.properties.replay_asset, before.properties.replay_asset, "the derivative reference came back");
    assert(JSON.stringify(restored.properties.bounds) === JSON.stringify(before.properties.bounds), "the geometry came back");
    const annotations = (await account.api(`/api/blocks/${pageId}/subtree`)).block.children
      .filter((b) => b.properties?.type === "pdf_ink").map((b) => b.id).sort();
    assertEq(annotations.length, annotationsBefore.length, "a restore is not a copy");
    assert(annotations.includes(inkId), "and the annotation that was deleted is the one that came back");
    assertNoProblems(own);
    await ownCtx.close();
  });

  await step("native: copying a page that carries iPad annotations is refused up front, not half-done", async () => {
    // A page copy clones its children through the bulk children writer — a
    // generic insert, which the server refuses for native manifests. The guard
    // runs BEFORE the copy page is created, so a user never gets an empty
    // "(copy)" page plus an error.
    const homeCtx = await account.context(browser, { viewport: { width: 1400, height: 950 } });
    const home = await openPage(homeCtx, `${server.base}/?ws=${account.ws}`);
    const card = home.locator(".pageCard", { hasText: "Native paper" }).first();
    await card.waitFor({ timeout: 20000 });
    await card.click({ button: "right" });
    await home.locator(".ctxMenuItem", { hasText: "Duplicate" }).first().click();
    await home.waitForFunction(() => document.querySelector(".statusPill")?.textContent.includes("iPad annotations"), null, { timeout: 15000 });
    const root = await account.api("/api/blocks/root/children");
    assertEq(root.children.filter((b) => /Native paper/.test(b.content || "")).length, 1, "no copy page was created");
    assertNoProblems(home);
    await homeCtx.close();
  });

  await step("native: an edit made just before the handoff is flushed into the collab session, not left behind", async () => {
    // The source flow flushed a debounced whole-tree autosave; upstream's page
    // is a live collab session, so the handoff must settle the op queue instead
    // (collab.flush() + hasPending()) before it freezes anything. Typing and
    // clicking the button inside the debounce window is exactly that race.
    const handoffCtx = await account.context(browser);
    await handoffCtx.addInitScript(() => {
      window.__GAMMA_IPAD__ = true;
      window.__nativeCalls = [];
      window.webkit = { messageHandlers: { gammaNative: { postMessage: (m) => window.__nativeCalls.push(m) } } };
    });
    const handoffPage = await openPage(handoffCtx, `${server.base}/?page=${pageId}&ws=${account.ws}`);
    await waitForPdf(handoffPage, 1);
    const row = handoffPage.locator(".blockRow", { has: handoffPage.locator("figure.nativeAudio") }).first();
    await row.locator(".blockRendered").click();
    await handoffPage.keyboard.type("recorded note");
    // No waiting: the click has to land while the keystrokes are still queued.
    await handoffPage.getByRole("button", { name: "Open Pencil, recording and Replay" }).click();
    await handoffPage.waitForFunction(() => window.__nativeCalls.length > 0, null, { timeout: 20000 });
    const [call] = await handoffPage.evaluate(() => window.__nativeCalls);
    assertEq(call.type, "openPDF", "message type");
    assertEq(call.pageID, pageId, "pageID");
    assertEq(call.docID, docId, "docID");
    assertEq(call.workspace, account.ws, "the BARE workspace id");
    assert(!call.workspace.includes("=") && !call.workspace.includes("/"), `workspace must be a bare id, got ${call.workspace}`);
    assertEq(call.user, account.name, "user");
    assertEq(call.title, "Native paper", "title");
    assertEq(Object.keys(call).sort().join(","), "docID,pageID,title,type,user,viewport,workspace", "exactly the position-aware handoff fields");
    assertEq(call.viewport.pageIndex, 0, "the fixture's visible PDF page is carried to native");
    for (const key of ["anchorX", "anchorY"]) {
      assert(Number.isFinite(call.viewport[key]) && call.viewport[key] >= 0 && call.viewport[key] <= 1,
        `viewport ${key} must be a bounded page-local anchor`);
    }
    assertEq(await handoffPage.evaluate(() => document.getElementById("root").inert), true, "the tree is frozen for native");
    // The typed edit reached the server BEFORE the handoff was posted.
    const tree = await account.api(`/api/blocks/${pageId}/subtree`);
    assert(JSON.stringify(tree).includes("recorded note"), "the queued edit was flushed before the handoff");
    await handoffCtx.close();
  });

  await step("native: the handoff rechecks the library role, so a demoted editor is refused before the freeze", async () => {
    // A shared library where bob is an EDITOR — the role whose tab may hand a
    // document to the iPad. Built with the CLI so the test needs no admin
    // session of its own.
    const created = server.manage("create-workspace", "Handoff roles", "alice", "shared");
    const shared = /workspace (\S+)/.exec(created)?.[1];
    assert(!!shared, `could not read the new workspace id from: ${created.trim()}`);
    server.manage("set-member", shared, "bob", "editor");

    const pdf = makePdf([["Shared handoff"]]);
    const up = await bob.upload(`/api/uploads?ws=${shared}`, pdf, "shared-handoff.pdf", "application/pdf");
    const sharedPage = await bob.api(`/api/blocks/by-doc/${up.doc_id}?ws=${shared}`, {
      method: "POST", body: { default_title: "Shared handoff", source_url: up.source_url },
    });

    const ctx2 = await bob.context(browser);
    await ctx2.addInitScript(() => {
      window.__GAMMA_IPAD__ = true;
      window.__nativeCalls = [];
      window.webkit = { messageHandlers: { gammaNative: { postMessage: (m) => window.__nativeCalls.push(m) } } };
    });
    const viewer = await openPage(ctx2, `${server.base}/?page=${sharedPage.id}&ws=${shared}`);
    await waitForPdf(viewer, 1);
    const button = viewer.getByRole("button", { name: "Open Pencil, recording and Replay" });
    await button.waitFor({ timeout: 20000 }); // editor: the handoff is offered

    // Demoted WHILE the tab is open: the button is still on screen, and the
    // click must recheck the library role before anything is frozen or sent.
    server.manage("set-member", shared, "bob", "viewer");
    await button.click();
    await viewer.waitForFunction(() => document.querySelector(".statusPill")?.textContent.includes("Pencil needs editing access"), null, { timeout: 15000 });
    assertEq(await viewer.evaluate(() => window.__nativeCalls.length), 0, "nothing was posted to native");
    assertEq(await viewer.evaluate(() => document.getElementById("root").inert === true), false, "the page was never frozen");
    assertEq(await viewer.evaluate(() => window.__GAMMA_NATIVE_ACTIVE__ === true), false, "and stays usable");
    assertNoProblems(viewer, [/403/]);
    await ctx2.close();
  });
}
