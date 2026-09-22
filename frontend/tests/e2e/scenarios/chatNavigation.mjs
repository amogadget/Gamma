export async function chatNavigationScenarios(env) {
  const { server, browser, alice, makePdf, step, until, assert, assertEq, assertNoProblems, openPage, flags } = env;
  if (flags.only && !"chat navigation".includes(flags.only)) return;
  const target = await alice.api("/api/pages", { method: "POST", body: { title: "Linked paper" } });
  const upload = await alice.upload("/api/uploads", makePdf([["Chat navigation paper"]]), "chat-navigation.pdf", "application/pdf");
  const pdf = await alice.api(`/api/blocks/by-doc/${upload.doc_id}`, { method: "POST", body: {
    default_title: "Chat navigation paper", source_url: upload.source_url,
  } });

  for (const source of [{ name: "library", key: "home" }, { name: "PDF", key: pdf.id }]) {
    for (const finishAway of [false, true]) {
      await step(`chat navigation: ${source.name} reply survives returning ${finishAway ? "after" : "before"} completion`, async () => {
        await alice.api(`/api/chats/${source.key}`, { method: "PUT", body: { messages: [] } });
        const ctx = await alice.context(browser);
        await ctx.addInitScript(() => {
          localStorage.setItem("gamma-ai-login-check", "off");
          const fetch = window.fetch.bind(window);
          window.fetch = (input, init) => {
            if (String(input).endsWith("/api/ai/chat")) {
              return Promise.resolve(new Response(new ReadableStream({
                start(controller) {
                  window.chatStream = {
                    push: (event) => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n")),
                    finish: () => controller.close(),
                  };
                  init.signal.addEventListener("abort", () => controller.error(new DOMException("Stopped", "AbortError")));
                },
              }), { headers: { "Content-Type": "application/x-ndjson" } }));
            }
            return fetch(input, init);
          };
        });
        const page = await openPage(ctx, `${server.base}/?ws=${alice.ws}${source.key === "home" ? "" : `&page=${source.key}`}`);
        try {
          const input = page.getByRole("combobox", { name: "Message AI" });
          await input.waitFor();
          await page.waitForLoadState("networkidle");
          await input.fill("Find a related paper");
          await input.press("Enter");
          await page.waitForFunction(() => !!window.chatStream);
          await page.evaluate((id) => window.chatStream.push({ delta: `Read [Linked paper](/?page=${id}).` }), target.id);
          const reply = page.locator(".chatBubble.ai");
          await page.locator(".chatPanel").getByRole("link", { name: "Linked paper" }).click();
          await until(() => new URL(page.url()).searchParams.get("block") === target.id);
          assertEq(await reply.count(), 0, "the other page does not display the source reply");
          await page.evaluate(() => window.chatStream.push({ delta: " This text arrived while away." }));
          // The provider's token report (one {"usage"} line per turn) sums onto the reply
          // and shows under it once the stream ends: "↑ 1.2k ↓ 34 · 50% cached".
          await page.evaluate(() => window.chatStream.push({ usage: { input: 1000, output: 30, cache_read: 600, cache_write: 0 } }));
          await page.evaluate(() => window.chatStream.push({ usage: { input: 200, output: 4, cache_read: 0, cache_write: 0 } }));
          if (finishAway) await page.evaluate(() => window.chatStream.finish());
          await page.getByRole("button", { name: "Back", exact: true }).click();
          await until(async () => (await page.locator(".chatPanel").innerText()).includes("This text arrived while away."));
          if (!finishAway) {
            await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor();
            await page.getByRole("button", { name: "Close Chat", exact: true }).click();
            await until(async () => !(await page.locator(".chatPanel").count()));
            await page.evaluate(() => window.chatStream.push({ delta: " Continued with the panel closed." }));
            await page.getByRole("button", { name: "View", exact: true }).click();
            await page.locator(".menuPopover").getByRole("button", { name: "AI Chat" }).click();
            await page.getByRole("button", { name: "View", exact: true }).click();
            await until(async () => (await page.locator(".chatPanel").innerText()).includes("Continued with the panel closed."));
            await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor();
            // Text after the last report counts as a "~" estimate next to the Responding pill.
            const live = page.locator(".chatThinking .chatMsgUsage");
            await live.waitFor();
            assert((await live.innerText()).includes("~"), "the streaming round shows an estimate");
            assert((await live.innerText()).includes("1.2k"), "reported rounds stay exact while streaming");
            await page.evaluate(() => { window.chatStream.push({ delta: " Finished after returning." }); window.chatStream.finish(); });
          }
          await until(async () => !(await page.getByRole("button", { name: "Stop generating", exact: true }).count()));
          let saved;
          await until(async () => {
            saved = await alice.api(`/api/chats/${source.key}`);
            return saved.messages?.at(-1)?.text?.includes("This text arrived while away.") && !saved.messages.at(-1).partial;
          });
          assertEq(saved.messages.length, 2);
          assertEq(saved.messages.at(-1).usage.input, 1200, "the reply keeps the summed token report");
          const usageLine = page.locator(".chatBubbleRow.ai .chatMsgUsage");
          await usageLine.waitFor();
          assert((await usageLine.innerText()).replace(/\s+/g, " ").includes("1.2k"), "input tokens shown under the reply");
          assert((await usageLine.innerText()).includes("50% cached"), "cached share shown under the reply");
          assertEq((await alice.api(`/api/chats/${target.id}`)).messages.length, 0);
          await page.getByRole("button", { name: "New chat", exact: true }).click();
          await until(async () => !(await reply.count()));
          await page.getByRole("button", { name: "Chat history", exact: true }).click();
          await page.locator(".chatHistRow:not(.active)").filter({ hasText: "Find a related paper" }).first().click();
          await until(async () => (await page.locator(".chatPanel").innerText()).includes("This text arrived while away."));
          await page.reload();
          await until(async () => (await page.locator(".chatPanel").innerText()).includes("This text arrived while away."));
          assertNoProblems(page);
          assert(finishAway || saved.messages.at(-1).text.includes("Finished after returning."));
        } finally { await ctx.close(); }
      });
    }
  }

  await step("chat navigation: two papers answer at once, each with its own Stop", async () => {
    await alice.api(`/api/chats/${pdf.id}`, { method: "PUT", body: { messages: [] } });
    await alice.api(`/api/chats/${target.id}`, { method: "PUT", body: { messages: [] } });
    const ctx = await alice.context(browser);
    await ctx.addInitScript(() => {
      localStorage.setItem("gamma-ai-login-check", "off");
      window.chatStreams = []; // one fake stream per /api/ai/chat call, in send order
      const fetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (String(input).endsWith("/api/ai/chat")) {
          return Promise.resolve(new Response(new ReadableStream({
            start(controller) {
              window.chatStreams.push({
                pageId: JSON.parse(init.body).page_id,
                push: (event) => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n")),
                finish: () => controller.close(),
              });
              init.signal.addEventListener("abort", () => controller.error(new DOMException("Stopped", "AbortError")));
            },
          }), { headers: { "Content-Type": "application/x-ndjson" } }));
        }
        return fetch(input, init);
      };
    });
    const page = await openPage(ctx, `${server.base}/?ws=${alice.ws}&page=${pdf.id}`);
    try {
      const input = page.getByRole("combobox", { name: "Message AI" });
      const stop = page.getByRole("button", { name: "Stop generating", exact: true });
      await input.waitFor();
      await page.waitForLoadState("networkidle");
      await input.fill("Summarize the first paper");
      await input.press("Enter");
      await page.waitForFunction(() => window.chatStreams.length === 1);
      await page.evaluate((id) => window.chatStreams[0].push({ delta: `First paper: see [Linked paper](/?page=${id}), ` }), target.id);
      await stop.waitFor();
      // Walk to the other page while the first reply streams: its composer is
      // free — the first paper's Stop is not this conversation's.
      await page.locator(".chatPanel").getByRole("link", { name: "Linked paper" }).click();
      await until(() => new URL(page.url()).searchParams.get("block") === target.id);
      await input.waitFor();
      assertEq(await stop.count(), 0, "the other page's composer is not blocked by the first reply");
      await input.fill("Summarize the second paper");
      await input.press("Enter");
      await page.waitForFunction(() => window.chatStreams.length === 2);
      assertEq((await page.evaluate(() => window.chatStreams.map((s) => s.pageId))).join(), `${pdf.id},${target.id}`);
      await page.evaluate(() => { window.chatStreams[0].push({ delta: "still going." }); window.chatStreams[1].push({ delta: "Second paper: " }); });
      await until(async () => (await page.locator(".chatPanel").innerText()).includes("Second paper:"));
      assert(!(await page.locator(".chatPanel").innerText()).includes("First paper"), "the first reply stays in its own conversation");
      // Stop here aborts only the second paper's reply.
      await stop.click();
      await until(async () => !(await stop.count()));
      await page.evaluate(() => { window.chatStreams[0].push({ delta: " Done." }); window.chatStreams[0].finish(); });
      let first, second;
      await until(async () => {
        first = await alice.api(`/api/chats/${pdf.id}`);
        second = await alice.api(`/api/chats/${target.id}`);
        return first.messages?.at(-1)?.text?.includes("Done.") && !first.messages.at(-1).partial
          && second.messages?.at(-1)?.text?.includes("(stopped)") && !second.messages.at(-1).partial;
      });
      assert(first.messages.at(-1).text.endsWith(", still going. Done."), "the first reply streamed to its end");
      assertEq(second.messages.at(-1).text, "Second paper: \n\n*(stopped)*");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await until(async () => (await page.locator(".chatPanel").innerText()).includes("still going. Done."));
      assertEq(await stop.count(), 0);
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });
}
