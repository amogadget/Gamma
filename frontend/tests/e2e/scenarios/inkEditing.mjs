import { encodeStroke, newInk, decodeStroke } from "../../../src/ink/ink.js";
import { waitForPdf } from "./pdf.mjs";

export async function inkEditingScenarios({ server, browser, alice, bob, makePdf, step, until, assert, assertEq, assertNoProblems, openPage, flags }) {
  let ctx, page, cdp, pageId, noteId, secondId;
  const paths = '[data-page="1"] .inkLayer path';
  const menu = () => page.getByRole("toolbar", { name: "Edit handwriting", exact: true });
  const stored = async (id = noteId) => {
    const d = await alice.api(`/api/blocks/${pageId}/subtree`);
    const block = d.block.children.find((b) => b.id === id);
    return block?.properties?.ink_url ? alice.api(block.properties.ink_url) : null;
  };
  const point = async (x, y) => page.locator('[data-page="1"]').evaluate((el, [x, y]) => {
    const rect = el.getBoundingClientRect(), k = rect.width / 612;
    return { x: Math.round(rect.left + x * k), y: Math.round(rect.top + y * k) };
  }, [x, y]);
  const tapInk = async (x = 130, y = 220) => {
    const p = await point(x, y);
    await page.touchscreen.tap(p.x, p.y);
    await menu().waitFor();
  };
  const assertHandlesFollowSelection = async () => {
    await until(async () => page.locator('[data-page="1"]').evaluate((el) => {
      const selection = el.querySelector(".inkSelRect"), matrix = selection?.getScreenCTM();
      if (!matrix) return false;
      return ["resize", "rotate"].every((mode) => {
        const widget = el.querySelector(`.inkTransform-${mode}`).getBoundingClientRect();
        const x = selection.x.baseVal.value + selection.width.baseVal.value - 4;
        const y = mode === "resize" ? selection.y.baseVal.value + selection.height.baseVal.value - 4 : selection.y.baseVal.value + 4;
        const corner = new DOMPoint(x, y).matrixTransform(matrix);
        return Math.abs(widget.x - corner.x) < 2 && Math.abs((mode === "resize" ? widget.y : widget.y + widget.height) - corner.y) < 2
          && Math.abs(widget.width - 28) < 1 && Math.abs(widget.height - 28) < 1;
      });
    }), { what: "widgets follow preview corners at a constant screen size" });
  };
  const dragTouch = async (from, to, beforeLift) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
    for (let i = 1; i <= 12; i++) await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ x: from.x + (to.x - from.x) * i / 12, y: from.y + (to.y - from.y) * i / 12 }],
    });
    await beforeLift?.();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };

  await step("ink edit: finger tap selects thin ink and exposes edits without changing the pen", async () => {
    const up = await alice.upload("/api/uploads", makePdf([["Touch editing"]]), "touch-edit.pdf", "application/pdf");
    const created = await alice.api(`/api/blocks/by-doc/${up.doc_id}`, { method: "POST", body: { default_title: "Touch ink", source_url: up.source_url } });
    pageId = created.id;
    const addInk = async (id, y, color, size) => {
      const ink = { ...newInk(1, 612, 792), strokes: [encodeStroke({ id, color, size, ch: "xypt", t0: 1000,
        samples: Array.from({ length: 13 }, (_, i) => ({ x: 80 + i * 10, y, p: 0.2 + i * 0.05, t: i * 8 })) })] };
      const file = await alice.api("/api/upload-ink", { method: "POST", body: ink });
      return (await alice.api("/api/blocks", { method: "POST", body: { parent_id: pageId, content: `Ink ${id}`,
        properties: { ink_url: file.url, pdf_page: 1, pdf_position: file.pdf_position, ink_strokes: 1 } } })).id;
    };
    noteId = await addInk("thin", 220, "#1f1f1f", 0.6);
    secondId = await addInk("other", 270, "#1d4ed8", 2);
    ctx = await alice.context(browser, { hasTouch: true });
    await ctx.addInitScript(() => localStorage.setItem("gamma-ink-pen-only", "1"));
    page = await openPage(ctx, `${server.base}/?page=${pageId}&ws=${alice.ws}`);
    cdp = await ctx.newCDPSession(page);
    await waitForPdf(page, 1);
    await until(async () => await page.locator(paths).count() === 2);
    await page.getByRole("button", { name: "Handwriting tools", exact: true }).tap();
    const pen = await page.locator(".pdfInkBar .inkToolBtn.modeActive").getAttribute("aria-label");
    await tapInk(130, 223); // Near a sub-pixel line: hit tolerance is in screen pixels.
    assertEq(await page.locator(".pdfInkBar .inkToolBtn.modeActive").getAttribute("aria-label"), pen);
    assertEq(await page.locator(paths).count(), 2);
    assert(await page.locator('[aria-label="Undo ink"]').isDisabled(), "selection is not an edit");
    await page.keyboard.press("Control+z");
    await page.getByText("Nothing to undo in handwriting.", { exact: true }).waitFor();
    assertEq(await page.locator(paths).count(), 2, "empty ink history does not fall through to note undo");
    for (const name of ["Color", "Width", "Duplicate", "Select note", "Show note", "Delete"]) {
      const button = menu().getByRole("button", { name, exact: true });
      assertEq(await button.locator("svg").count(), 1, `${name} has an icon`);
      assert(await button.getAttribute("title"), `${name} has a tooltip`);
      const box = await button.boundingBox();
      assert(box.width >= 36 && box.height >= 36, `${name} retains a touch target`);
    }
    assertEq(await menu().getByRole("button", { name: "Done", exact: true }).count(), 0);
    assertEq(await menu().locator(".inkEditRow button").last().getAttribute("aria-label"), "Delete");
    await menu().getByRole("button", { name: "Duplicate", exact: true }).hover();
    await page.getByRole("tooltip").filter({ hasText: "Duplicate" }).waitFor();
    assertNoProblems(page);
  });

  await step("ink edit: color and width affect only selected ink, persist samples, and use visible undo/redo", async () => {
    const before = await stored();
    await menu().getByRole("button", { name: "Color", exact: true }).tap();
    await menu().getByRole("button", { name: "Ink color #dc2626", exact: true }).tap();
    await menu().getByRole("button", { name: "Width", exact: true }).tap();
    await menu().getByRole("button", { name: "pen width 4 pt", exact: true }).tap();
    await until(async () => (await stored())?.strokes[0].size === 4 && (await stored()).strokes[0].color === "#dc2626");
    assertEq(JSON.stringify((await stored()).strokes[0].pts), JSON.stringify(before.strokes[0].pts), "pressure/time unchanged");
    assertEq((await stored(secondId)).strokes[0].color, "#1d4ed8");
    assertEq(await page.locator(paths).count(), 2, "menu touches add no ink");
    await page.getByRole("button", { name: "Undo ink", exact: true }).tap();
    await page.getByText("Undone: ink width change (page 1).", { exact: true }).waitFor();
    await until(async () => (await stored()).strokes[0].size === 0.6);
    assertEq((await stored()).strokes[0].color, "#dc2626", "one edit per undo");
    await page.getByRole("button", { name: "Redo ink", exact: true }).tap();
    await page.getByText("Redone: ink width change (page 1).", { exact: true }).waitFor();
    await until(async () => (await stored()).strokes[0].size === 4);
    await page.reload();
    await waitForPdf(page, 1);
    await until(async () => await page.locator(paths).count() === 2);
    await tapInk();
    if (flags.keep) await page.screenshot({ path: `${server.dir}/ink-edit-menu.png` });
    assertNoProblems(page);
  });

  await step("ink edit: duplicate selects its new IDs; delete and undo restore the right strokes", async () => {
    await menu().getByRole("button", { name: "Duplicate", exact: true }).tap();
    await until(async () => (await stored())?.strokes.length === 2);
    const copies = (await stored()).strokes;
    assertEq(copies[0].id, "thin");
    assert(copies[1].id !== "thin", "fresh copy id");
    assert(decodeStroke(copies[1])[0].x > decodeStroke(copies[0])[0].x, "copy offset");
    await menu().getByRole("button", { name: "Delete", exact: true }).tap();
    await until(async () => (await stored())?.strokes.length === 1);
    assertEq((await stored()).strokes[0].id, "thin", "delete removes the copy");
    await page.getByRole("button", { name: "Undo ink", exact: true }).tap();
    await until(async () => (await stored())?.strokes.length === 2);
    await page.getByRole("button", { name: "Undo ink", exact: true }).tap();
    await until(async () => (await stored())?.strokes.length === 1);
    assertEq(await page.locator(paths).count(), 2);
    assertNoProblems(page);
  });

  await step("ink edit: lasso spans notes, finger drag moves both, and one undo restores both", async () => {
    await page.getByRole("button", { name: /^Lasso \(L\)/ }).tap();
    const from = await point(65, 205);
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    for (const [x, y] of [[215, 205], [215, 285], [65, 285], [65, 205]]) {
      const p = await point(x, y); await page.mouse.move(p.x, p.y, { steps: 5 });
    }
    await page.mouse.up();
    await menu().waitFor();
    const beforeA = decodeStroke((await stored()).strokes[0])[0];
    const beforeB = decodeStroke((await stored(secondId)).strokes[0])[0];
    await dragTouch(await point(140, 245), await point(170, 280), assertHandlesFollowSelection);
    // The two groups are separate blocks, so their saves land one after the
    // other (two uploads + two PATCHes). Await the pair instead of asserting the
    // second one immediately — the requirement is unchanged: BOTH must move, so
    // a dropped save still fails here.
    await until(async () => decodeStroke((await stored()).strokes[0])[0].y > beforeA.y + 30
      && decodeStroke((await stored(secondId)).strokes[0])[0].y > beforeB.y + 30,
      { what: "both ink groups to move" });
    await page.getByRole("button", { name: "Undo ink", exact: true }).tap();
    await until(async () => decodeStroke((await stored()).strokes[0])[0].y === beforeA.y
      && decodeStroke((await stored(secondId)).strokes[0])[0].y === beforeB.y);
    assertNoProblems(page);
  });

  await step("ink edit: selection handles resize and rotate across notes, preview, cancel and undo", async () => {
    const selectBoth = async () => {
      const start = await point(65, 205);
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      for (const [x, y] of [[215, 205], [215, 285], [65, 285], [65, 205]]) {
        const p = await point(x, y); await page.mouse.move(p.x, p.y, { steps: 3 });
      }
      await page.mouse.up(); await menu().waitFor();
    };
    await selectBoth();
    const beforeA = await stored(), beforeB = await stored(secondId);
    const resize = page.getByRole("button", { name: "Resize selected handwriting", exact: true });
    const rotate = page.getByRole("button", { name: "Rotate selected handwriting", exact: true });
    await resize.waitFor();
    const b = await resize.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 45, b.y + b.height / 2 + 25, { steps: 6 });
    assertEq(await menu().count(), 0, "menu hides during transform preview");
    await assertHandlesFollowSelection();
    await page.mouse.up();
    await until(async () => (await stored()).strokes[0].size > beforeA.strokes[0].size);
    assert((await stored(secondId)).strokes[0].size > beforeB.strokes[0].size, "both notes resized");
    assertEq(decodeStroke((await stored()).strokes[0])[4].p, decodeStroke(beforeA.strokes[0])[4].p);
    await page.getByRole("button", { name: "Undo ink", exact: true }).tap();
    await until(async () => JSON.stringify((await stored()).strokes) === JSON.stringify(beforeA.strokes));
    assertEq(JSON.stringify((await stored(secondId)).strokes), JSON.stringify(beforeB.strokes));
    // Toolbar undo dismisses selection; select both notes again.
    await selectBoth();
    await rotate.focus(); await page.keyboard.press("ArrowRight");
    await until(async () => decodeStroke((await stored()).strokes[0])[0].y !== decodeStroke(beforeA.strokes[0])[0].y);
    const rotated = await stored();
    assertEq(rotated.strokes[0].size, beforeA.strokes[0].size, "rotation preserves width");
    const r = await rotate.boundingBox();
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x + 14, y: r.y + 14, pointerType: "pen", button: "left", buttons: 1, force: 0.5 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + 40, y: r.y + 55, pointerType: "pen", button: "left", buttons: 1, force: 0.5 });
    await assertHandlesFollowSelection();
    await page.keyboard.press("Escape");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x + 40, y: r.y + 55, pointerType: "pen", button: "left", buttons: 0 });
    assertEq(JSON.stringify((await stored()).strokes), JSON.stringify(rotated.strokes), "cancel discards preview");
    assertEq(await page.locator('[data-page="1"] .inkLayer > g[transform]').count(), 0, "Escape clears the transform preview");
    await page.getByRole("button", { name: "Undo ink", exact: true }).tap();
    await until(async () => JSON.stringify((await stored()).strokes) === JSON.stringify(beforeA.strokes));
    assertNoProblems(page);
  });

  await step("ink edit: mouse and pen hover show tool footprint without drawing", async () => {
    await page.getByRole("button", { name: /^Pen .*\(1\)/ }).tap();
    const p = await point(300, 330), cursor = page.locator('[data-page="1"] .inkCursor');
    await page.mouse.move(p.x, p.y); await cursor.waitFor({ state: "visible" });
    const penSize = await cursor.evaluate((el) => el.getBoundingClientRect().width);
    assert(penSize > 0, "pen footprint visible");
    await page.getByRole("button", { name: /^Eraser \(E\)/ }).tap();
    await page.mouse.move(p.x, p.y);
    assertEq(await cursor.getAttribute("data-tool"), "eraser");
    assertEq(Math.round((await cursor.boundingBox()).width), 18, "medium eraser diameter in CSS pixels");
    await page.getByRole("button", { name: "Hand", exact: true }).tap();
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...p, pointerType: "pen", buttons: 0 });
    await cursor.waitFor({ state: "visible" });
    assertEq(await cursor.getAttribute("data-tool"), "pen", "stylus still previews in hand mode");
    assertEq(await page.locator(paths).count(), 2, "hover adds no ink");
    await page.mouse.move(5, 5); await cursor.waitFor({ state: "hidden" });
    assertNoProblems(page);
  });

  await step("ink edit: swipes over ink scroll, blank taps dismiss, and holds cancel on a second contact", async () => {
    await page.getByRole("button", { name: "Hand", exact: true }).tap();
    const scrollBefore = await page.locator(".pdfViewer").evaluate((el) => el.scrollTop);
    const from = await point(130, 220);
    await dragTouch(from, { x: from.x, y: from.y - 110 });
    const scrollTop = () => page.locator(".pdfViewer").evaluate((el) => el.scrollTop);
    await until(async () => await scrollTop() > scrollBefore + 20);
    assertEq(await menu().count(), 0, "swipe did not select");
    // Let the fling's momentum finish before resetting: a still-moving scroller
    // would carry the ink out of view and the menu hides off-screen selections.
    await until(async () => { const a = await scrollTop(); await page.waitForTimeout(250); return a === await scrollTop(); }, { what: "swipe momentum settled" });
    await page.locator(".pdfViewer").evaluate((el) => { el.scrollTop = 0; });
    await until(async () => await scrollTop() === 0, { what: "scrolled back to the top" });
    await tapInk();
    const blank = await point(300, 330);
    await page.touchscreen.tap(blank.x, blank.y);
    await until(async () => await menu().count() === 0);
    const hold = await point(130, 220);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [hold] });
    await menu().waitFor(); // The hold timer must open it before touchEnd.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
      { ...hold, id: 0 }, { x: hold.x + 60, y: hold.y + 40, id: 1 },
    ] });
    await until(async () => await menu().count() === 0, { what: "second contact cancels held selection" });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assertEq(await page.locator(paths).count(), 2);
    assertNoProblems(page);
  });

  await step("ink edit: pen resumes writing after selection and menu stays inside a small viewport", async () => {
    await tapInk();
    const p = await point(140, 220);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...p, pointerType: "pen", button: "left", buttons: 1, force: 0.5 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x + 50, y: p.y + 30, pointerType: "pen", button: "left", buttons: 1, force: 0.7 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x + 50, y: p.y + 30, pointerType: "pen", button: "left", buttons: 0 });
    await until(async () => await page.locator(paths).count() === 3);
    assertEq(await menu().count(), 0, "pen writes instead of moving selected ink");
    await page.getByRole("button", { name: "Undo ink", exact: true }).tap();
    await until(async () => await page.locator(paths).count() === 2);
    await page.setViewportSize({ width: 740, height: 620 });
    await page.locator(".pdfViewer").evaluate((el) => { el.scrollTop = 0; });
    await tapInk();
    await menu().getByRole("button", { name: "Width", exact: true }).tap();
    await until(async () => {
      const m = await page.locator(".inkEditMenu").boundingBox();
      const s = await page.locator(".inkSelectionHit").boundingBox();
      return m && s && (m.y + m.height <= s.y || m.y >= s.y + s.height);
    }, { what: "expanded menu avoids covering selected ink" });
    const bounds = await page.locator(".inkEditMenu").boundingBox();
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 740 && bounds.y + bounds.height <= 620,
      "expanded menu fits the viewport");
    if (flags.keep) await page.screenshot({ path: `${server.dir}/ink-edit-small.png` });
    await menu().getByRole("button", { name: "Show note", exact: true }).tap();
    await until(async () => await menu().count() === 0);
    assertNoProblems(page);
  });

  await step("ink edit: view shares hide editing; an edit share can restyle saved ink", async () => {
    await alice.api(`/api/share/${pageId}`, { method: "POST" });
    await alice.api(`/api/share-settings/${pageId}`, { method: "PUT", body: { audience: "anyone", role: "view" } });
    const { token } = await alice.api(`/api/share-settings/${pageId}`);
    assert(token, "share token");
    const viewCtx = await browser.newContext({ hasTouch: true, viewport: { width: 1280, height: 860 } });
    const view = await openPage(viewCtx, `${server.base}/?share=${token}`);
    await waitForPdf(view, 1);
    await view.waitForSelector(paths);
    await view.locator(paths).first().tap();
    assertEq(await view.locator(".inkEditMenu").count(), 0);
    assertEq(await view.getByRole("button", { name: "Handwriting tools", exact: true }).count(), 0);
    assertNoProblems(view);
    await viewCtx.close();
    await alice.api(`/api/share-settings/${pageId}`, { method: "PUT", body: { audience: "users", role: "edit" } });
    const editCtx = await bob.context(browser, { hasTouch: true });
    await editCtx.addInitScript(() => localStorage.setItem("gamma-ink-pen-only", "1"));
    const edit = await openPage(editCtx, `${server.base}/?share=${token}`);
    await waitForPdf(edit, 1);
    await edit.waitForSelector(paths);
    await edit.locator(paths).first().tap();
    const editMenu = edit.getByRole("toolbar", { name: "Edit handwriting", exact: true });
    await editMenu.waitFor();
    await editMenu.getByRole("button", { name: "Color", exact: true }).tap();
    await editMenu.getByRole("button", { name: "Ink color #15803d", exact: true }).tap();
    await until(async () => (await stored()).strokes[0].color === "#15803d");
    assertNoProblems(edit);
    await editCtx.close();
  });

  await step("ink edit: Chrome double taps do not zoom on tablet; PDF pinch still zooms", async () => {
    const tabletCtx = await alice.context(browser, { hasTouch: true, isMobile: true, viewport: { width: 1280, height: 860 } });
    const tablet = await openPage(tabletCtx, `${server.base}/?page=${pageId}&ws=${alice.ws}`);
    await waitForPdf(tablet, 1);
    assertEq(await tablet.locator(".app.phoneUI").count(), 0, "covers layouts beyond phone");
    assertEq(await tablet.evaluate(() => getComputedStyle(document.documentElement).touchAction), "manipulation");
    const session = await tabletCtx.newCDPSession(tablet);
    const pdf = tablet.locator('[data-page="1"]');
    const before = await pdf.boundingBox();
    const scale = await tablet.evaluate(() => visualViewport.scale);
    const x = Math.round(before.x + before.width * 0.65), y = Math.round(before.y + 280);
    await session.send("Input.synthesizeTapGesture", { x, y, tapCount: 2, gestureSourceType: "touch" });
    // Sample through Chrome's double-tap animation window, rather than checking
    // only before a delayed zoom could start.
    const scales = await tablet.evaluate(() => new Promise((resolve) => {
      const values = [], start = performance.now();
      const tick = () => { values.push(visualViewport.scale); if (performance.now() - start < 600) requestAnimationFrame(tick); else resolve(values); };
      requestAnimationFrame(tick);
    }));
    assert(scales.every((s) => Math.abs(s - scale) < 0.01), "native double tap keeps browser scale");
    assertEq((await pdf.boundingBox()).width, before.width, "double tap keeps PDF scale");
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x - 40, y, id: 0 }, { x: x + 40, y, id: 1 }] });
    for (let i = 1; i <= 8; i++) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [
      { x: x - 40 - i * 5, y, id: 0 }, { x: x + 40 + i * 5, y, id: 1 },
    ] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until(async () => (await pdf.boundingBox()).width > before.width * 1.5, { what: "PDF pinch increases page size" });
    assert(Math.abs(await tablet.evaluate(() => visualViewport.scale) - scale) < 0.01, "PDF pinch leaves browser chrome at its original scale");
    assertNoProblems(tablet);
    await tabletCtx.close();
  });

  if (ctx) await ctx.close();
}
