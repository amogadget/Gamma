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
          if (finishAway) await page.evaluate(() => window.chatStream.finish());
          await page.getByRole("button", { name: "Back", exact: true }).click();
          await until(async () => (await page.locator(".chatPanel").innerText()).includes("This text arrived while away."));
          if (!finishAway) {
            await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor();
            await page.getByRole("button", { name: "Close Chat", exact: true }).click();
            await until(async () => !(await page.locator(".chatPanel").count()));
            await page.evaluate(() => window.chatStream.push({ delta: " Continued with the panel closed." }));
            await page.getByRole("button", { name: "Settings", exact: true }).click();
            await page.locator(".menuPopover").getByRole("button", { name: "AI Chat" }).click();
            await page.getByRole("button", { name: "Settings", exact: true }).click();
            await until(async () => (await page.locator(".chatPanel").innerText()).includes("Continued with the panel closed."));
            await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor();
            await page.evaluate(() => { window.chatStream.push({ delta: " Finished after returning." }); window.chatStream.finish(); });
          }
          await until(async () => !(await page.getByRole("button", { name: "Stop generating", exact: true }).count()));
          let saved;
          await until(async () => {
            saved = await alice.api(`/api/chats/${source.key}`);
            return saved.messages?.at(-1)?.text?.includes("This text arrived while away.") && !saved.messages.at(-1).partial;
          });
          assertEq(saved.messages.length, 2);
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
}
