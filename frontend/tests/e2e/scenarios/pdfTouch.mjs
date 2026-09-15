import { waitForPdf } from "./pdf.mjs";

export async function pdfTouchScenarios({ server, browser, alice, makePdf, step, until, sleep, assert, assertEq, assertNoProblems, openPage, flags }) {
  let ctx, page, pageId;
  const bitmap = (pn) => page.locator(`[data-page="${pn}"] > canvas`).first();
  const painted = async (pn) => bitmap(pn).evaluate((canvas) => {
    if (!canvas.width || !canvas.height) return false;
    const sample = document.createElement("canvas"); sample.width = sample.height = 128;
    const c = sample.getContext("2d"); c.drawImage(canvas, 0, 0, 128, 128);
    const data = c.getImageData(0, 0, 128, 128).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && data[i] < 180) dark++;
    sample.width = sample.height = 0;
    return dark > 80;
  });
  await step("pdf touch: 400% paints within iPad canvas limits and releases distant pages", async () => {
    const pdf = makePdf(Array.from({ length: 8 }, (_, p) => Array.from({ length: 24 }, (_, n) => `Page ${p + 1}, line ${n + 1}: high zoom reading`)));
    const up = await alice.upload("/api/uploads", pdf, "high-zoom.pdf", "application/pdf");
    const created = await alice.api(`/api/blocks/by-doc/${up.doc_id}`, { method: "POST", body: { default_title: "iPad zoom", source_url: up.source_url } });
    pageId = created.id;
    ctx = await alice.context(browser, { hasTouch: true, isMobile: true, deviceScaleFactor: 2, viewport: { width: 1024, height: 768 } });
    await ctx.addInitScript(() => {
      // Snap is always on, including for browsers with an old disabled value.
      localStorage.setItem("gamma-snap-vertical", "0");
      localStorage.setItem("gamma-ink-pen-only", "1");
      // Reproduce allocation refusal on constrained WebKit devices. Without
      // the cap, 400% Letter at DPR 2 requests over 30 million pixels.
      window.oversizedCanvases = [];
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...args) {
        if (this.width * this.height > 16777216) {
          window.oversizedCanvases.push([this.width, this.height]);
          return null;
        }
        return getContext.apply(this, args);
      };
    });
    page = await openPage(ctx, `${server.base}/?page=${created.id}&ws=${alice.ws}`);
    await waitForPdf(page);
    for (let i = 0; i < 18; i++) await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await until(async () => Math.abs((await page.locator('[data-page="1"]').boundingBox()).width - 2448) < 1);
    await page.locator(".pdfViewer").evaluate((el) => el.scrollTo({ left: 0, top: 0 }));
    await until(() => painted(1), { what: "400% bitmap contains PDF text" });
    const dimensions = await bitmap(1).evaluate((c) => [c.width, c.height]);
    assert(dimensions[0] * dimensions[1] <= 8 * 1024 * 1024 && Math.max(...dimensions) <= 4096, "bounded backing size");
    assertEq(await page.evaluate(() => oversizedCanvases.length), 0);
    for (const pn of [4, 8, 1]) {
      await page.locator(`[data-page="${pn}"]`).evaluate((el) => {
        const viewer = el.closest(".pdfViewer");
        viewer.scrollTop += el.getBoundingClientRect().top - viewer.getBoundingClientRect().top;
      });
      await until(() => painted(pn), { what: `page ${pn} paints after navigation` });
      await until(async () => page.locator(".pdfPageWrap > canvas:not(.inkCanvas)").evaluateAll((cs) => cs.filter((c) => c.width > 0).length <= 3), { what: "offscreen canvases released" });
    }
    if (flags.keep) await page.screenshot({ path: `${server.dir}/pdf-touch-400.png` });
    assertNoProblems(page);
  });

  await step("pdf touch: live handwriting paints at 400% and releases its backing on lift", async () => {
    await page.getByRole("button", { name: "Handwriting tools", exact: true }).click();
    const box = await page.locator(".pdfViewer").boundingBox();
    const x = box.x + 180, y = box.y + 300;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 130, y + 40, { steps: 10 });
    await until(async () => page.locator('[data-page="1"] .inkCanvas').evaluate((c) => {
      if (!c.width || !c.height) return false;
      return c.getContext("2d").getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0);
    }), { what: "live ink visible at high zoom" });
    await page.mouse.up();
    await page.waitForSelector('[data-page="1"] .inkLayer path');
    assertEq(await page.locator('[data-page="1"] .inkCanvas').evaluate((c) => c.width * c.height), 0);
    assertEq(await page.evaluate(() => oversizedCanvases.length), 0);
    await page.getByRole("button", { name: "Hand", exact: true }).click();
    assertNoProblems(page);
  });

  // CDP supplies native Chromium touch gestures. The raster scenarios above
  // also run against WebKit via GAMMA_E2E_BROWSER=webkit.
  if (browser.browserType().name() === "chromium") await step("pdf touch: high-zoom swipes avoid scroll corrections during touch and allow diagonal panning", async () => {
    const cdp = await ctx.newCDPSession(page);
    await page.locator(".pdfViewer").evaluate((el) => {
      el.scrollTo({ left: 350, top: 300 });
      window.scrollCorrections = [];
      let touching = false;
      el.addEventListener("touchstart", () => { touching = true; }, { passive: true, capture: true });
      el.addEventListener("touchend", () => { touching = false; }, { passive: true, capture: true });
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft");
      Object.defineProperty(el, "scrollLeft", { get() { return desc.get.call(this); }, set(value) {
        window.scrollCorrections.push({ touching, method: "scrollLeft" }); desc.set.call(this, value);
      } });
      const scrollTo = el.scrollTo;
      el.scrollTo = function (...args) { window.scrollCorrections.push({ touching, method: "scrollTo" }); return scrollTo.apply(this, args); };
    });
    const box = await page.locator(".pdfViewer").boundingBox();
    const x = Math.round(box.x + box.width * 0.6), y = Math.round(box.y + box.height * 0.75);
    const drag = async (dx, dy) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let i = 1; i <= 10; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * i / 10, y: y + dy * i / 10 }] });
        await sleep(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    await drag(-20, -220);
    await until(async () => await page.locator(".pdfViewer").evaluate((el) => el.scrollTop) > 400, { what: "native vertical swipe scrolls" });
    await sleep(900);
    let writes = await page.evaluate(() => scrollCorrections);
    assert(writes.every((w) => !w.touching) && writes.length <= 1, "no offset writes during touch; at most one correction after settling");
    const before = await page.locator(".pdfViewer").evaluate((el) => el.scrollLeft);
    await page.evaluate(() => { window.scrollCorrections = []; });
    await drag(-160, -90);
    await until(async () => await page.locator(".pdfViewer").evaluate((el) => el.scrollLeft) > before + 70);
    await sleep(700);
    assertEq(await page.evaluate(() => scrollCorrections.length), 0, "diagonal pan is not pulled back");
    assertNoProblems(page);
  });
  await step("pdf touch: app fullscreen survives downward swipes and exits explicitly", async () => {
    await until(async () => (await alice.api(`/api/blocks/${pageId}/subtree`)).block.children.some((b) => b.properties?.ink_url), { what: "ink saved before navigation" });
    await page.reload(); // Start independently of the previous fling and its instrumentation.
    await waitForPdf(page);
    await page.getByRole("button", { name: "Full screen", exact: true }).tap();
    await page.locator(".app.pseudoFullscreen").waitFor();
    assert(await page.evaluate(() => !document.fullscreenElement && !document.webkitFullscreenElement), "touch fullscreen avoids browser-owned dismissal");
    if (await page.evaluate(() => CSS.supports("overscroll-behavior-y", "none"))) {
      assertEq(await page.locator(".pdfViewer").evaluate((el) => getComputedStyle(el).getPropertyValue("overscroll-behavior-y")), "none");
    }
    await page.locator(".pdfViewer").evaluate((el) => el.scrollTo({ left: 0, top: 600 }));
    if (browser.browserType().name() === "chromium") {
      const session = await ctx.newCDPSession(page);
      const box = await page.locator(".pdfViewer").boundingBox();
      const x = Math.round(box.x + box.width * 0.6), y = Math.round(box.y + 150);
      const swipe = async () => {
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for (let i = 1; i <= 10; i++) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + i * 20 }] });
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      await swipe();
      await until(async () => await page.locator(".pdfViewer").evaluate((el) => el.scrollTop) < 500, { what: "downward swipe scrolls in fullscreen" });
      await page.locator(".pdfViewer").evaluate((el) => { el.scrollTop = 0; });
      await swipe(); // Also test downward overscroll at the start of the document.
      await sleep(1000); // Let the browser finish the gesture before tapping a control.
    } else {
      await page.locator(".pdfViewer").evaluate((el) => el.scrollBy({ top: -200 }));
    }
    assertEq(await page.locator(".app.pseudoFullscreen").count(), 1);
    await page.getByRole("button", { name: "Exit full screen", exact: true }).tap();
    await until(async () => await page.locator(".app.pseudoFullscreen").count() === 0);
    assertEq(await page.locator("html.appFocusFullscreen").count(), 0);
    await page.getByRole("button", { name: "Full screen", exact: true }).tap();
    await page.keyboard.press("Escape");
    await until(async () => await page.locator(".app.pseudoFullscreen").count() === 0);
    assertNoProblems(page);
  });
  await step("pdf touch: paper color survives large zoom cycles and live ink keeps its own theme", async () => {
    // Decode the screenshot in the browser to check the composited output,
    // rather than only checking CSS declarations or the raw white bitmap.
    const paperPixel = async () => {
      const rect = await page.locator('[data-page="1"]').boundingBox();
      const x = Math.round(rect.x + 20), y = Math.round(rect.y + 150);
      const png = await page.screenshot({ clip: { x, y, width: 2, height: 2 } });
      return page.evaluate(async (data) => {
        const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
        const c = document.createElement("canvas"); c.width = c.height = 1;
        const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
      }, png.toString("base64"));
    };
    for (const [theme, flip, expected] of [["sepia", false, [253, 246, 227]], ["solarized", false, [253, 246, 227]],
      ["gray", false, [244, 244, 244]], ["dark", true, [15, 15, 15]]]) {
      await page.evaluate(([theme, flip]) => {
        document.documentElement.setAttribute("data-theme", theme);
        document.querySelector(".pdfViewer").classList.toggle("pdfDark", flip);
      }, [theme, flip]);
      for (const direction of ["in", "out"]) {
        for (let i = 0; i < 12; i++) await page.getByRole("button", { name: `Zoom ${direction}`, exact: true }).click();
        await page.locator(".pdfViewer").evaluate((el) => el.scrollTo(0, 0));
        await until(() => painted(1));
        const rgb = await paperPixel();
        assert(rgb.every((v, i) => Math.abs(v - expected[i]) <= 2), `${theme}, zoom ${direction}: paper ${rgb} matches ${expected}`);
      }
      const style = await page.locator('[data-page="1"] .inkCanvas').evaluate((el) => {
        const s = getComputedStyle(el); return { opacity: s.opacity, blend: s.mixBlendMode, filter: s.filter };
      });
      assertEq(style.opacity, "1", "live ink does not inherit PDF soft-ink opacity");
      assertEq(style.blend, "normal", "live ink does not inherit PDF paper blending");
      assertEq(style.filter, flip ? "invert(1) hue-rotate(180deg)" : "none");
    }
    if (flags.keep) await page.screenshot({ path: `${server.dir}/pdf-zoom-theme.png` });
    assertNoProblems(page);
  });
  if (ctx) await ctx.close();
}
