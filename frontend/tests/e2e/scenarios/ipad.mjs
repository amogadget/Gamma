// The installed web app (docs/dev/ipad.md): the manifest and its icons, the
// home-screen head tags, theme-color following the theme, and the
// standalone-mode stylesheet. Chromium in a tablet-sized touch context —
// emulation, not an iPad.
export async function ipadScenarios({ server, browser, alice, step, until, assert, assertEq, assertNoProblems, openPage }) {
  await step("ipad: install manifest, icons, status-bar colour and standalone mode", async () => {
    const ctx = await alice.context(browser, { hasTouch: true, deviceScaleFactor: 2, viewport: { width: 834, height: 1194 } });
    try {
      const page = await openPage(ctx, `${server.base}/?ws=${alice.ws}`);
      await page.waitForSelector(".folderNewBtn", { timeout: 15000 });

      const head = await page.evaluate(() => ({
        manifest: document.querySelector('link[rel="manifest"]')?.href,
        touchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.href,
        capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
        statusBar: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content,
      }));
      assertEq(head.capable, "yes");
      assertEq(head.statusBar, "default");

      const r = await ctx.request.get(head.manifest);
      assertEq(r.status(), 200);
      assert((r.headers()["content-type"] || "").startsWith("application/manifest+json"), `manifest media type: ${r.headers()["content-type"]}`);
      const manifest = await r.json();
      assertEq(manifest.display, "standalone");
      assert(manifest.icons.some((i) => i.purpose === "maskable"), "a maskable icon");
      for (const src of [...manifest.icons.map((i) => i.src), head.touchIcon]) {
        const icon = await ctx.request.get(new URL(src, server.base).href);
        assert(icon.status() === 200 && icon.headers()["content-type"] === "image/png", `icon ${src}: ${icon.status()} ${icon.headers()["content-type"]}`);
        assertEq((await icon.body()).subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${src} is a PNG`);
      }

      // theme-color is the topbar's paint, for the current theme and after a change.
      const themeColor = () => page.evaluate(() => {
        const hex = document.querySelector('meta[name="theme-color"]').content;
        const probe = document.createElement("div");
        probe.style.color = hex;
        document.body.append(probe);
        const rgb = getComputedStyle(probe).color;
        probe.remove();
        return { meta: rgb, topbar: getComputedStyle(document.querySelector(".topbar")).backgroundColor };
      });
      let colors = await themeColor();
      assertEq(colors.meta, colors.topbar, "theme-color matches the topbar");
      await page.getByRole("button", { name: "Account & settings", exact: true }).click();
      await page.getByRole("button", { name: "Settings…", exact: true }).click();
      await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
      const before = await page.locator("html").getAttribute("data-theme");
      const next = before === "sepia" ? "Gamma Dark" : "Sepia";
      await page.getByRole("button", { name: next, exact: true }).click();
      await until(() => page.locator("html").getAttribute("data-theme").then((v) => v !== before));
      // .topbar transitions its background over 150 ms; the meta switches at
      // once, so wait for the paint to settle on it.
      await until(async () => {
        const c = await themeColor();
        return c.topbar !== colors.topbar && c.meta === c.topbar;
      }, { what: "theme-color follows the theme and the topbar settles on it" });
      await page.keyboard.press("Escape");

      // Installed: the document does not rubber-band and the bottom edge keeps
      // clear of the home indicator. Chromium cannot emulate display-mode
      // (CDP accepts the feature, matchMedia ignores it), so this reads the
      // bundled stylesheet's standalone block.
      const standalone = await page.evaluate(() => {
        const out = [];
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch { continue; }
          for (const rule of rules) {
            if (rule instanceof CSSMediaRule && /display-mode:\s*standalone/.test(rule.conditionText)) {
              for (const inner of rule.cssRules) out.push(`${inner.selectorText} { ${inner.style.cssText} }`);
            }
          }
        }
        return out;
      });
      assert(standalone.some((r) => /^html,\s*body/.test(r) && /overscroll-behavior:\s*none/.test(r)), `document overscroll rule: ${standalone.join(" | ")}`);
      assert(standalone.some((r) => /^\.app\b/.test(r) && /safe-area-inset-bottom/.test(r)), `home indicator inset: ${standalone.join(" | ")}`);
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });
}
