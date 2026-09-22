// Tours are manual, compact, and never submit a message or activate the mic.
export async function contextualGuideScenarios(env) {
  const { server, browser, alice, step, until, assert, assertEq, assertNoProblems, openPage, makePdf } = env;
  const models = { enabled: true, models: [{ id: "demo:model", provider: "demo", provider_name: "Demo", model: "model" }], default: "demo:model" };
  for (const mode of ["library", "pdf", "hidden-pdf", "phone"]) {
    await step(`guide: manual chat tour ${mode}`, async () => {
      const mobile = mode === "phone";
      let paperId;
      if (mode.includes("pdf")) {
        const up = await alice.upload("/api/uploads", makePdf([["A figure can become chat context."]]), "context.pdf", "application/pdf");
        const paper = await alice.api(`/api/blocks/by-doc/${up.doc_id}`, { method: "POST", body: { default_title: "Context paper", source_url: up.source_url } });
        paperId = paper.id;
      }
      const ctx = await alice.context(browser, mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {});
      await ctx.addInitScript(() => localStorage.setItem("gamma-ai-login-check", "off"));
      await ctx.route("**/api/ai/models*", (route) => route.fulfill({ json: models }));
      let sends = 0;
      await ctx.route("**/api/ai/chat", (route) => { sends++; return route.fulfill({ body: "" }); });
      const page = await openPage(ctx, `${server.base}/?ws=${alice.ws}${paperId ? `&block=${paperId}` : ""}&guide=ai-chat`);
      try {
        await page.waitForLoadState("networkidle");
        if (mobile) await page.getByRole("button", { name: "AI chat", exact: true }).click();
        const input = page.getByRole("combobox", { name: "Message AI" });
        await input.waitFor();
        await input.click();
        await input.fill("Keep this draft");
        assertEq(await page.locator('[data-guide-overlay], [data-guide-offer]').count(), 0, "chat focus and URL never start a tour");
        assertEq(await page.getByRole("button", { name: "Chat guide", exact: true }).count(), 0, "chat has no tour button");
        if (paperId) await page.waitForSelector('[data-guide="pdf.textLayer"] span');
        if (mode === "hidden-pdf") await page.getByRole("button", { name: "Close PDF", exact: true }).click();
        // The page's chat mounts after the initial library shell.
        await input.fill("Keep this draft");
        const start = async () => {
          await page.click('[data-guide="header.account"]');
          await page.click('[data-guide="account.tour"]');
          assertEq(await page.getByRole("menu", { name: "Tours" }).getByRole("menuitem").count(), 2, "submenu lists both tours");
          await page.click('[data-guide="account.aiChat"]');
        };
        await start();
        await page.waitForSelector('[data-guide-overlay="chat-question"]');
        assertEq(await page.locator('.guideBody').count(), 0, "no paragraph copy");
        await until(async () => await input.inputValue() === "summarize the paper for me", { what: "example is typed into the composer" });
        await page.screenshot({ path: `${server.dir}/chat-${mode}-input.png` });
        await page.waitForSelector('[data-guide-overlay="chat-voice"]');
        await until(async () => await input.inputValue() === "Keep this draft", { what: "existing draft is restored" });
        assertEq(await page.getByRole("button", { name: "Cancel recording", exact: true }).count(), 0, "tour never records");
        if (mode === "pdf") {
          await page.locator('.guideCard .primary').click();
          await page.waitForSelector('[data-guide-overlay="chat-box"] .guideCursor.dragging');
          await page.waitForSelector('[data-guide-overlay="chat-box-context"]');
          await page.waitForSelector('[data-guide="chat.imageContext"] img');
          assertEq(await page.locator('[data-hl-id]').count(), 0, "context creates no saved annotation");
          await page.screenshot({ path: `${server.dir}/chat-pdf-context.png` });
        } else {
          assertEq(await page.locator('.guideCard .primary').textContent(), "Done", "box step is absent without a visible PDF");
        }
        await page.locator('.guideCard .primary').click();
        await until(async () => await page.locator('.guideCard').count() === 0);
        assertEq(sends, 0, "tour sends no AI request");
        await start();
        await page.waitForSelector('[data-guide-overlay="chat-question"]');
        await page.keyboard.press("Escape");
        await until(async () => await page.locator('.guideCard').count() === 0);
        assertEq(await input.inputValue(), "Keep this draft", "cancelling preserves the draft");
        assertNoProblems(page);
      } finally { await ctx.close(); }
    });
  }
}
