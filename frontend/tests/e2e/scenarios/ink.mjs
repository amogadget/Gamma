// Handwriting (docs/dev/handwriting.md): the tool strip and its presets,
// mouse strokes becoming an ink block with an .ink upload, persistence
// across a reload, the eraser, the lasso, the notes card's jump + flash,
// and /Ink in the annotated PDF.
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
    assert(await page.$(".pdfInkBar .inkToolBtn.modeActive .inkToolInk"), "a pen preset is armed when the strip opens");
    assertEq((await page.$$(".pdfInkBar .inkToolInk")).length, 7, "the default presets: four pens, three highlighters");
    const buttons = await page.locator(".pdfInkRow button").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    assertEq(JSON.stringify(buttons.slice(-2)), JSON.stringify(["Undo ink", "Redo ink"]), "history controls are last");
    assertEq(await page.locator(".pdfInkBar button[title^='Start a new']").count(), 0, "new-note plus button removed");
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
    await page.getByRole("button", { name: "Undo ink", exact: true }).click();
    await page.getByRole("button", { name: "Redo ink", exact: true }).click();
    await page.waitForSelector(".statusPill");
    const toolbar = await page.locator(".pdfInkBar").boundingBox();
    const message = await page.locator(".statusPill").boundingBox();
    assert(message.y >= toolbar.y + toolbar.height, "undo/redo feedback stays below the toolbar");
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
    await page.waitForSelector(".pdfInkBar button[title^='Eraser'].modeActive", { timeout: 5000 });
    box = await page.locator('[data-page="1"]').boundingBox();
    await drawLine(page, [box.x + 175, box.y + 140], [box.x + 178, box.y + 185]);
    await until(async () => (await page.$$('[data-page="1"] .inkLayer path')).length === 1, { what: "one path left" });
    await until(async () => (await inkBlockOnServer())?.properties.ink_strokes === 1, { what: "one stroke on the server" });
    await page.keyboard.press("Escape");
    await until(async () => !(await page.$(".pdfInkBar")), { what: "strip closed by Escape" });
    assertNoProblems(page);
  });

  await step("ink: Ctrl+Z undoes the erasure and a stroke; Ctrl+Shift+Z redoes", async () => {
    await page.click("button[aria-label='Handwriting tools']");
    await page.waitForSelector(".pdfInkBar");
    // The history is per visit: after the reload only the erasure is on it.
    await page.keyboard.press("Control+z");
    await until(async () => (await page.$$('[data-page="1"] .inkLayer path')).length === 2, { what: "erased stroke back" });
    await page.keyboard.press("p");
    box = await page.locator('[data-page="1"]').boundingBox();
    await drawLine(page, [box.x + 100, box.y + 400], [box.x + 250, box.y + 420]);
    await until(async () => (await page.$$('[data-page="1"] .inkLayer path')).length === 3, { what: "a third stroke" });
    await page.keyboard.press("Control+z");
    await until(async () => (await page.$$('[data-page="1"] .inkLayer path')).length === 2, { what: "third stroke undone" });
    await page.keyboard.press("Control+Shift+z");
    await until(async () => (await page.$$('[data-page="1"] .inkLayer path')).length === 3, { what: "redone" });
    await page.keyboard.press("Control+z");
    await until(async () => (await page.$$('[data-page="1"] .inkLayer path')).length === 2, { what: "undone again" });
    await until(async () => (await inkBlockOnServer())?.properties.ink_strokes === 2, { what: "two strokes on the server" });
    assert((await page.$$(".blockRow")).length >= 1, "the block is still there");
    assertNoProblems(page);
  });

  await step("ink: the partial eraser cuts a stroke in two; the lasso selects and moves them", async () => {
    await page.keyboard.press("e");
    await page.click(".pdfInkBar button[title^='Eraser']");          // the armed tool again: its options row
    await page.waitForSelector(".pdfInkSub[data-ink-options='eraser']");
    await page.click(".pdfInkBar button[aria-label='Partial']");
    if (flags.keep) await page.screenshot({ path: `${server.dir}/ink-eraser.png` });
    box = await page.locator('[data-page="1"]').boundingBox();
    // straight down through the middle of the first stroke (y ≈ 160 at x = 175)
    await drawLine(page, [box.x + 175, box.y + 140], [box.x + 175, box.y + 185]);
    await until(async () => (await page.$$('[data-page="1"] .inkLayer path')).length === 3, { what: "three pieces" });
    await until(async () => (await inkBlockOnServer())?.properties.ink_strokes === 3, { what: "three strokes on the server" });
    // lasso around the whole second stroke (100..250 × 250..280)
    await page.keyboard.press("l");
    await page.mouse.move(box.x + 80, box.y + 235);
    await page.mouse.down();
    for (const [x, y] of [[270, 235], [270, 300], [80, 300], [80, 235]]) await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
    await page.mouse.up();
    await page.waitForSelector('[data-page="1"] .inkSelRect', { timeout: 5000 });
    const before = (await inkBlockOnServer()).properties.pdf_position.boundingRect;
    await drawLine(page, [box.x + 170, box.y + 265], [box.x + 170, box.y + 365]);   // drag the box 100 px down
    await until(async () => {
      const b = await inkBlockOnServer();
      return b && b.properties.pdf_position.boundingRect.y2 > before.y2 + 50 ? b : null;
    }, { what: "the group's box moved down" });
    await page.keyboard.press("Delete");
    await until(async () => (await page.$$('[data-page="1"] .inkLayer path')).length === 2, { what: "selection deleted" });
    assertNoProblems(page);
  });

  await step("ink: a preset's options row sets its colour and width, duplicates and removes it; presets persist; the box lasso", async () => {
    await page.keyboard.press("1");
    await page.click(".pdfInkBar .inkToolBtn.modeActive");             // tap the armed preset again
    await page.waitForSelector(".pdfInkSub[data-ink-options='tool']");
    await page.click(".pdfInkSub button[aria-label='Colour #dc2626']");
    await page.click(".pdfInkSub button[aria-label='Width 4 pt']");
    await page.click(".pdfInkSub button[aria-label='Duplicate tool']");
    await until(async () => (await page.$$(".pdfInkBar .inkToolInk")).length === 8, { what: "a duplicated preset" });
    assert(await page.$(".pdfInkSub[data-ink-options='tool']"), "the copy stays open for editing");
    if (flags.keep) await page.screenshot({ path: `${server.dir}/ink-presets.png` });
    box = await page.locator('[data-page="1"]').boundingBox();
    await drawLine(page, [box.x + 100, box.y + 400], [box.x + 250, box.y + 420]);
    // The reload in an earlier step ended the group: this stroke is a new
    // block. Its file carries the copy's look.
    const red = await until(async () => {
      const d = await account.api(`/api/blocks/${pageId}/subtree`);
      for (const b of d.block.children || []) {
        if (!b.properties?.ink_url?.endsWith(".ink")) continue;
        const ink = await account.api(b.properties.ink_url);
        const hit = ink.strokes.find((st) => st.color === "#dc2626");
        if (hit) return hit;
      }
      return null;
    }, { what: "a stroke in the copy's colour on the server" });
    assertEq(red.size, 4, "the copy drew with its width");
    assertEq(red.tool, "pen", "…as a pen");
    await page.click(".pdfInkSub button[aria-label='Remove tool']");
    await until(async () => (await page.$$(".pdfInkBar .inkToolInk")).length === 7, { what: "the copy removed" });
    assert(await page.$(".pdfInkBar .inkToolBtn.modeActive"), "a neighbour is armed after the removal");
    // The edited first preset survives a reload (localStorage).
    await page.reload();
    await waitForPdf(page, 1);
    await page.click("button[aria-label='Handwriting tools']");
    await page.waitForSelector(".pdfInkBar");
    assertEq(await page.$eval(".pdfInkBar .inkToolInk", (el) => getComputedStyle(el).backgroundColor), "rgb(220, 38, 38)",
      "the first preset kept its colour");
    // The lasso's box mode: a dragged rectangle selects what it covers.
    await page.keyboard.press("l");
    await page.click(".pdfInkBar button[title^='Lasso']");
    await page.waitForSelector(".pdfInkSub[data-ink-options='select']");
    await page.click(".pdfInkSub button[aria-label='Box']");
    box = await page.locator('[data-page="1"]').boundingBox();
    await drawLine(page, [box.x + 80, box.y + 380], [box.x + 270, box.y + 440]);
    await page.waitForSelector('[data-page="1"] .inkSelRect', { timeout: 5000 });
    await page.keyboard.press("Escape");                               // drops the selection
    await until(async () => !(await page.$('[data-page="1"] .inkSelRect')), { what: "selection dropped" });
    await page.keyboard.press("Escape");                               // closes the strip
    await until(async () => !(await page.$(".pdfInkBar")), { what: "strip closed" });
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

  await step("ink: erasing the last stroke stays erased while block deletion is pending", async () => {
    // Reopening the page starts a fresh handwriting group.
    await page.reload();
    await waitForPdf(page, 1);
    await page.click("button[aria-label='Handwriting tools']");
    await page.keyboard.press("p");
    const paths = '[data-page="1"] .inkLayer path';
    const count = await page.locator(paths).count();
    const before = await account.api(`/api/blocks/${pageId}/subtree`);
    const ids = new Set(before.block.children.map((b) => b.id));
    box = await page.locator('[data-page="1"]').boundingBox();
    await drawLine(page, [box.x + 100, box.y + 320], [box.x + 250, box.y + 320]);
    const group = await until(async () => {
      const d = await account.api(`/api/blocks/${pageId}/subtree`);
      return d.block.children.find((b) => !ids.has(b.id) && b.properties?.ink_url);
    }, { what: "new group saved before erasure" });
    await until(async () => await page.locator(paths).count() === count + 1);
    let release, deleting = false;
    const held = new Promise((resolve) => { release = resolve; });
    const url = `**/api/blocks/${group.id}`;
    await page.route(url, async (route) => {
      if (route.request().method() === "DELETE") { deleting = true; await held; }
      await route.continue();
    });
    try {
      await page.keyboard.press("e");
      await page.click(".pdfInkBar button[title^='Eraser']");
      await page.click(".pdfInkSub button[aria-label='Whole strokes']");
      box = await page.locator('[data-page="1"]').boundingBox();
      await drawLine(page, [box.x + 175, box.y + 310], [box.x + 175, box.y + 330]);
      await until(async () => await page.locator(paths).count() === count);
      await until(() => deleting, { what: "delete request held in flight" });
      const stayedErased = await page.evaluate(async ({ paths, count }) => {
        const end = performance.now() + 300;
        do {
          await new Promise(requestAnimationFrame);
          if (document.querySelectorAll(paths).length !== count) return false;
        } while (performance.now() < end);
        return true;
      }, { paths, count });
      assert(stayedErased, "saved strokes must not reappear while deletion is pending");
    } finally { release(); }
    await until(async () => {
      const d = await account.api(`/api/blocks/${pageId}/subtree`);
      return !d.block.children.some((b) => b.id === group.id);
    }, { what: "empty group deleted" });
    await page.unroute(url);
    assertEq(await page.locator(paths).count(), count);
    assertNoProblems(page);
  });

  await step("ink: Pencil touch gestures are claimed and finger gestures remain available", async () => {
    // Synthetic Safari event ordering exercises the handlers; a physical
    // iPad is still needed to verify native Pencil/scroll arbitration.
    await page.keyboard.press("Escape");
    if (await page.locator(".pdfInkBar").count()) await page.keyboard.press("Escape");
    const paths = '[data-page="1"] .inkLayer path';
    const count = await page.locator(paths).count();
    const result = await page.locator('[data-page="1"]').evaluate((el) => {
      const box = el.getBoundingClientRect();
      const pointer = (type, pointerType, pointerId, x) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType, pointerId, button: 0,
        buttons: type === "pointerup" ? 0 : 1, pressure: 0.7,
        clientX: box.left + x, clientY: box.top + 350,
      }));
      const touch = (type, touchType) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        const contact = { identifier: 1, touchType, clientX: box.left + 100, clientY: box.top + 350 };
        Object.defineProperties(event, {
          changedTouches: { value: [contact] }, touches: { value: [contact] },
        });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const fingerBefore = touch("touchstart", "direct");
      const pencilBefore = touch("touchstart", "stylus");
      pointer("pointerdown", "pen", 71, 100);
      const pencilStart = touch("touchstart", "stylus");
      const pencilMove = touch("touchmove", "stylus");
      const untypedPencil = touch("touchmove", undefined);
      const fingerDuring = touch("touchstart", "direct");
      pointer("pointerdown", "touch", 72, 120);
      pointer("pointerup", "touch", 72, 120);
      pointer("pointermove", "pen", 71, 220);
      pointer("pointerup", "pen", 71, 220);
      const fingerAfter = touch("touchstart", "direct");
      return { fingerBefore, pencilBefore, pencilStart, pencilMove, untypedPencil, fingerDuring, fingerAfter };
    });
    assert(result.pencilBefore && result.pencilStart && result.pencilMove && result.untypedPencil,
      "Pencil touch events prevent native panning, including before pointerdown");
    assert(!result.fingerBefore && result.fingerDuring && !result.fingerAfter,
      "palms are blocked during writing; fingers navigate before and after");
    await until(async () => await page.locator(paths).count() === count + 1, { what: "pen stroke survived a second contact" });
    assertNoProblems(page);
  });

  await step("ink: coalesced pen samples, prediction preview, lift endpoint and pressure persist accurately", async () => {
    const visibleCount = await page.locator('[data-page="1"] .inkLayer path').count();
    await until(async () => {
      const d = await account.api(`/api/blocks/${pageId}/subtree`);
      return d.block.children.reduce((n, b) => n + (b.properties?.ink_strokes || 0), 0) === visibleCount;
    }, { what: "previous Pencil stroke persisted before starting a separate group" });
    await page.reload();
    await waitForPdf(page, 1);
    await page.click("button[aria-label='Handwriting tools']");
    await page.keyboard.press("p");
    const before = await account.api(`/api/blocks/${pageId}/subtree`);
    const ids = new Set(before.block.children.map((b) => b.id));
    const result = await page.locator('[data-page="1"]').evaluate(async (el) => {
      const box = el.getBoundingClientRect();
      const make = (type, x, time, pressure) => {
        const ev = new PointerEvent(type, { bubbles: true, cancelable: true,
          pointerType: "pen", pointerId: 81, button: 0, buttons: type === "pointerup" ? 0 : 1,
          clientX: box.left + x, clientY: box.top + 300, pressure });
        Object.defineProperty(ev, "timeStamp", { value: 1000 + time });
        return ev;
      };
      el.dispatchEvent(make("pointerdown", 100, 0, 0.2));
      const move = make("pointermove", 130, 12, 0.8);
      Object.defineProperties(move, {
        getCoalescedEvents: { value: () => [make("pointermove", 110, 4, 0.4),
          make("pointermove", 120, 8, 0.6), make("pointermove", 130, 12, 0.8)] },
        getPredictedEvents: { value: () => [make("pointermove", 138, 20, 0.8)] },
      });
      el.dispatchEvent(move);
      await new Promise(requestAnimationFrame);
      const canvas = el.querySelector(".inkCanvas");
      const painted = canvas.style.display === "block" && canvas.getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 === 3 && v > 0);
      el.dispatchEvent(make("pointerup", 140, 24, 0));
      return { painted, hidden: canvas.style.display === "none",
        k: box.width / el.querySelector(".inkLayer").viewBox.baseVal.width };
    });
    assert(result.painted && result.hidden, "live canvas paints before lift and hands off to SVG");
    const block = await until(async () => {
      const d = await account.api(`/api/blocks/${pageId}/subtree`);
      return d.block.children.find((b) => !ids.has(b.id) && b.properties?.ink_url);
    }, { what: "sampled pen stroke saved" });
    const ink = await account.api(block.properties.ink_url);
    const st = ink.strokes[0];
    assertEq(st.ch, "xypt");
    assertEq(st.pts.length, 20, "five real samples, no prediction saved");
    assertEq(JSON.stringify(st.pts.filter((_, i) => i % 4 === 2)), "[200,400,600,800,800]", "pressure including lift");
    assertEq(JSON.stringify(st.pts.filter((_, i) => i % 4 === 3)), "[0,4,4,4,12]", "hardware time deltas");
    const endpoint = st.pts.filter((_, i) => i % 4 === 0).reduce((a, b) => a + b, 0) / 100;
    assert(Math.abs(endpoint - 140 / result.k) < 0.02, "the final pointer-up position is saved");
    await page.reload();
    await waitForPdf(page, 1);
    await page.waitForSelector(`[data-page="1"] [data-ink-id="${block.id}"] path`);
    assertNoProblems(page);
  });

  await step("ink: interrupted strokes clean up and a pen can take over a palm contact", async () => {
    // Enable finger writing to exercise the harder palm-first ordering.
    await page.evaluate(() => localStorage.setItem("gamma-ink-pen-only", "0"));
    await page.reload();
    await waitForPdf(page, 1);
    await page.click("button[aria-label='Handwriting tools']");
    const paths = '[data-page="1"] .inkLayer path';
    const count = await page.locator(paths).count();
    const clean = await page.locator('[data-page="1"]').evaluate((el) => {
      const box = el.getBoundingClientRect();
      const send = (type, id, pointerType = "pen", x = 100) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType, pointerId: id, button: 0,
        buttons: type === "pointerup" ? 0 : 1, pressure: 0.6,
        clientX: box.left + x, clientY: box.top + 330,
      }));
      send("pointerdown", 90);
      send("pointermove", 90, "pen", 150);
      send("pointercancel", 90);
      const cancelled = el.querySelector(".inkCanvas").style.display === "none";
      send("pointerdown", 91);
      send("lostpointercapture", 91);
      const lost = el.querySelector(".inkCanvas").style.display === "none";
      send("pointerdown", 92, "touch");
      send("pointermove", 92, "touch", 150);
      send("pointerdown", 93);
      send("pointerup", 92, "touch", 160);
      send("pointermove", 93, "pen", 180);
      send("pointerup", 93, "pen", 190);
      return cancelled && lost;
    });
    assert(clean, "cancellation and lost capture clear the live preview");
    await until(async () => await page.locator(paths).count() === count + 1,
      { what: "only the pen stroke survives palm takeover and interruptions" });
    if (flags.keep) await page.screenshot({ path: `${server.dir}/ink-touch-writing.png` });
    assertNoProblems(page);
  });

  await step("ink: native Chromium touch writes without scrolling and native pen pressure is saved", async () => {
    const paths = '[data-page="1"] .inkLayer path';
    const count = await page.locator(paths).count();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    box = await page.locator('[data-page="1"]').boundingBox();
    const x = Math.round(box.x + 100), y = Math.round(box.y + 220);
    const scrollBefore = await page.locator(".pdfViewer").evaluate((el) => el.scrollTop);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + i * 8, y: y + i * 3 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until(async () => await page.locator(paths).count() === count + 1, { what: "native touch stroke" });
    assertEq(await page.locator(".pdfViewer").evaluate((el) => el.scrollTop), scrollBefore, "finger drawing does not pan");
    await page.getByRole("button", { name: "Hand", exact: true }).click();
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y: y + 80,
      pointerType: "pen", button: "left", buttons: 1, clickCount: 1, force: 0.2 });
    for (let i = 1; i <= 12; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + i * 8, y: y + 80 + Math.sin(i / 2) * 15,
        pointerType: "pen", button: "left", buttons: 1, force: 0.2 + i * 0.05 });
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 100, y: y + 76,
      pointerType: "pen", button: "left", buttons: 0, clickCount: 1 });
    await until(async () => await page.locator(paths).count() === count + 2, { what: "native pen stroke in Hand mode" });
    await until(async () => {
      const d = await account.api(`/api/blocks/${pageId}/subtree`);
      for (const b of d.block.children) {
        if (!b.properties?.ink_url) continue;
        const ink = await account.api(b.properties.ink_url);
        if (ink.strokes.some((s) => s.pen && s.ch === "xypt" && s.pts.length >= 48 && s.pts[2] === 200
          && s.pts.filter((_, i) => i % 4 === 2).includes(800))) return true;
      }
      return false;
    }, { what: "native pen pressure uploaded" });
    if (flags.keep) await page.screenshot({ path: `${server.dir}/ink-native-touch-pen.png` });
    await page.evaluate(() => localStorage.setItem("gamma-ink-pen-only", "1"));
    await page.reload();
    await waitForPdf(page, 1);
    await until(async () => await page.locator(paths).count() === count + 2, { what: "native strokes restored" });
    await page.click("button[aria-label='Handwriting tools']");
    const scrollStart = await page.locator(".pdfViewer").evaluate((el) => el.scrollTop);
    box = await page.locator('[data-page="1"]').boundingBox();
    const fingerX = Math.round(box.x + 300);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fingerX, y: 500 }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: fingerX, y: 500 - i * 12 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until(async () => await page.locator(".pdfViewer").evaluate((el) => el.scrollTop) > scrollStart + 20,
      { what: "fingers scroll with a pen armed in pen-only mode" });
    assertEq(await page.locator(paths).count(), count + 2, "finger navigation adds no ink");
    await cdp.detach();
    assertNoProblems(page);
  });

  if (ctx) await ctx.close();
  return { inkPageId: pageId };
}
