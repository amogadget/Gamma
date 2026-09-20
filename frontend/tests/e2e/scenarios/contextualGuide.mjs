// Provider responses are local fixtures; the walkthrough must never call AI.
export async function contextualGuideScenarios(env) {
  const { server, browser, alice, step, until, assert, assertEq, assertNoProblems, openPage } = env;
  const key = "gamma-guide:alice:ai-chat";
  const models = { enabled: true, models: [{ id: "demo:model", provider: "demo", provider_name: "Demo", model: "model" }], default: "demo:model" };

  for (const mobile of [false, true]) {
    await step(`guide: contextual chat ${mobile ? "phone" : "desktop"} invitation, walkthrough and replay`, async () => {
      const ctx = await alice.context(browser, mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {});
      await ctx.addInitScript(() => localStorage.setItem("gamma-ai-login-check", "off"));
      await ctx.route("**/api/ai/models*", (route) => route.fulfill({ json: models }));
      let sends = 0;
      await ctx.route("**/api/ai/chat", (route) => {
        sends++;
        return route.fulfill({ contentType: "application/x-ndjson", body: '{"delta":"A test answer."}\n' });
      });
      const page = await openPage(ctx, `${server.base}/?ws=${alice.ws}`);
      try {
        if (mobile) await page.getByRole("button", { name: "AI chat", exact: true }).click();
        const input = page.getByRole("combobox", { name: "Message AI" });
        await input.waitFor();
        await page.getByRole("button", { name: "Chat settings", exact: true }).waitFor();
        assertEq(await page.locator("[data-guide-offer]").count(), 0, "mounting chat does not prompt");
        await input.click();
        const offer = page.locator('[data-guide-offer="ai-chat"] .guideCard');
        await offer.waitFor();
        assertEq(await page.locator(".guideDim").count(), 0, "invitation leaves the app interactive");
        await input.fill("Keep this draft");
        assert(await input.evaluate((el) => document.activeElement === el), "invitation does not steal focus");
        await page.screenshot({ path: `${server.dir}/chat-guide-${mobile ? "phone" : "desktop"}-invite.png`, animations: "disabled" });
        await offer.getByRole("button", { name: "Show me" }).click();
        for (const id of ["chat-context", "chat-settings", "chat-tools", "chat-question"]) {
          const card = page.locator(`[data-guide-overlay="${id}"] .guideCard`);
          await card.waitFor();
          const box = await card.boundingBox();
          const viewport = page.viewportSize();
          assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${id} fits the viewport`);
          assertEq(await input.inputValue(), "Keep this draft", "walkthrough preserves the draft");
          if (id !== "chat-question") await card.getByRole("button", { name: "Next", exact: true }).click();
        }
        assertEq(sends, 0, "tour makes no AI requests");
        const composer = await page.locator('[data-guide="chat.composer"]').boundingBox();
        const card = await page.locator(".guideCard").boundingBox();
        assert(card.y + card.height <= composer.y || card.x + card.width <= composer.x || card.x >= composer.x + composer.width, "practice card leaves composer usable");
        await page.screenshot({ path: `${server.dir}/chat-guide-${mobile ? "phone" : "desktop"}-practice.png`, animations: "disabled" });
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await until(() => sends === 1);
        await until(async () => await page.locator(".guideCard").count() === 0);
        assertEq(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).state, key), "done");
        await page.reload();
        if (mobile) await page.getByRole("button", { name: "AI chat", exact: true }).click();
        await input.click();
        assertEq(await page.locator("[data-guide-offer]").count(), 0, "completed guide stays quiet after reload");
        await page.getByRole("button", { name: "Chat guide", exact: true }).click();
        await page.locator('[data-guide-overlay="chat-context"] .guideCard').waitFor();
        await page.locator(".guideCard").getByRole("button", { name: "Next", exact: true }).click();
        await page.locator(".guideCard").getByRole("button", { name: "Back", exact: true }).press("Enter");
        await page.locator('[data-guide-overlay="chat-context"] .guideCard').waitFor();
        await page.getByRole("button", { name: "Leave the tour", exact: true }).press("Enter");
        assertEq(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).state, key), "dismissed");
        assertNoProblems(page);
      } finally { await ctx.close(); }
    });
  }

  await step("guide: prerequisites, dismissal, versions and first-run coexistence", async () => {
    const ctx = await alice.context(browser);
    await ctx.addInitScript(() => localStorage.setItem("gamma-ai-login-check", "off"));
    let configured = false;
    await ctx.route("**/api/ai/models*", (route) => route.fulfill({ json: configured ? models : { enabled: false, models: [] } }));
    const page = await openPage(ctx, `${server.base}/?ws=${alice.ws}`);
    try {
      const input = page.getByRole("combobox", { name: "Message AI" });
      await input.click();
      assertEq(await page.locator("[data-guide-offer]").count(), 0);
      assertEq(await page.evaluate((k) => localStorage.getItem(k), key), null, "ineligible contact is not consumed");
      configured = true;
      await page.reload();
      await page.getByRole("button", { name: "Chat settings", exact: true }).waitFor();
      await input.click();
      await page.locator('[data-guide-offer="ai-chat"] .guideCard').waitFor();
      await page.getByRole("button", { name: "Not now", exact: true }).click();
      await page.reload();
      await input.click();
      assertEq(await page.locator("[data-guide-offer]").count(), 0, "dismissal survives reload");
      await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ version: 0, state: "done" })), key);
      await page.goto(`${server.base}/?ws=${alice.ws}&guide=first-run`);
      await page.locator('[data-guide-overlay="welcome"] .guideCard').waitFor();
      await input.focus();
      assertEq(await page.locator("[data-guide-offer]").count(), 0, "contextual guide never interrupts a tour");
      await page.keyboard.press("Escape");
      await input.click();
      await page.locator('[data-guide-offer="ai-chat"] .guideCard').waitFor();
      await page.keyboard.press("Escape");
      assertEq(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).version, key), 1, "new version offered on next eligible contact");
      await page.goto(`${server.base}/?ws=${alice.ws}&guide=ai-chat`);
      await page.locator('[data-guide-overlay="chat-context"] .guideCard').waitFor();
      assert(!page.url().includes("guide="), "contextual deep link waits for provider then starts");
      await page.keyboard.press("Escape");
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });
}
