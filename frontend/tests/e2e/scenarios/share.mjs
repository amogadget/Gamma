// Share links: creating one from the dialog, the anonymous share view (title,
// PDF, highlight overlay, an image served through the share token, no
// editing), and an edit share letting another account type into the page.
import { tree, same, editRow, closeEditor, PNG_1PX } from "./notes.mjs";
import { waitForPdf } from "./pdf.mjs";

export async function shareScenarios({ server, browser, alice, bob, step, until, sleep, assert, assertEq, assertNoProblems, openPage }, { alice2, pdfPageId }) {
  await step("share chat: saved conversation is read-only on desktop and phone", async () => {
    const shared = await alice.api("/api/blocks", { method: "POST", body: { parent_id: "root", content: "Shared chat notes" } });
    const saved = { messages: [{ role: "user", text: "Explain this shared page" }, { role: "assistant", text: "A **saved answer** for visitors." }] };
    await alice.api(`/api/chats/${shared.id}`, { method: "PUT", body: saved });
    const { token: chatToken } = await alice.api(`/api/share/${shared.id}`, { method: "POST" });
    for (const phone of [false, true]) {
      const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 860 } });
      const page = await openPage(ctx, `${server.base}/?share=${chatToken}`);
      const writes = [];
      page.on("request", (r) => { if (/\/api\/(chats|chat-history|ai)\b/.test(r.url()) && r.method() !== "GET") writes.push(r.url()); });
      await page.waitForSelector(".readOnlyTitle");
      if (phone) await page.getByRole("button", { name: "AI chat", exact: true }).click();
      await page.locator(".chatMessages strong", { hasText: "saved answer" }).waitFor();
      assertEq(await page.locator(".chatInputRow, .chatMsgActionBtn[title^='Edit']").count(), 0, "no chat editing controls");
      assertEq(await page.getByRole("button", { name: "New chat", exact: true }).count(), 0, "no new chat action");
      await page.getByRole("button", { name: "Find in this conversation" }).click();
      await page.getByPlaceholder("Find in chat…").fill("saved answer");
      await until(async () => (await page.textContent(".chatFindCount")) === "1/1", { what: "searching saved chat" });
      await page.getByRole("button", { name: "Close Chat", exact: true }).click();
      if (phone) {
        await page.getByRole("button", { name: "AI chat", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "View", exact: true }).click();
        await page.locator(".popoverItem", { hasText: "AI Chat" }).click();
      }
      await page.locator(".chatMessages strong", { hasText: "saved answer" }).waitFor();
      await sleep(650); // wait beyond the autosave debounce
      assertEq(writes.length, 0, "shared chat never writes");
      assertNoProblems(page);
      await ctx.close();
    }
    await alice.api(`/api/share-settings/${shared.id}`, { method: "PUT", body: { audience: "users", role: "edit" } });
    const ctx = await bob.context(browser);
    const page = await openPage(ctx, `${server.base}/?share=${chatToken}`);
    await page.locator(".chatMessages strong", { hasText: "saved answer" }).waitFor();
    assertEq(await page.locator(".chatInputRow").count(), 0, "page editors also get read-only chat");
    assertNoProblems(page);
    await ctx.close();
    assertEq(JSON.stringify((await alice.api(`/api/chats/${shared.id}`)).messages), JSON.stringify(saved.messages), "owner's conversation is unchanged");
  });

  const account = alice2;
  let token;
  if (!pdfPageId) { console.log("  skip  share: needs the pdf steps (drop --only)"); return; }

  // An image block on the paper's page, so the share view has an upload to fetch.
  const up = await account.upload("/api/upload-image", PNG_1PX, "dot.png", "image/png");
  await account.api("/api/blocks", { method: "POST", body: { parent_id: pdfPageId, content: `figure ![](${up.url})` } });

  await step("share: the popover creates a link and shows it on the copy button", async () => {
    const ctx = await account.context(browser);
    const page = await openPage(ctx, `${server.base}/?page=${pdfPageId}&ws=${account.ws}`);
    await waitForPdf(page, 1);
    await page.click("button[aria-label='Share']");
    await page.waitForSelector(".sharePopover");
    await page.locator(".sharePopover button", { hasText: "Create link" }).click();
    const copyBtn = page.locator(".sharePopover button", { hasText: /Copy link|Copied/ }).first();
    await copyBtn.waitFor({ timeout: 10000 });
    token = new URL(await copyBtn.getAttribute("title")).searchParams.get("share");
    await page.keyboard.press("Escape");
    await page.locator(".sharePopover").waitFor({ state: "detached" });
    if (!token) token = (await account.api(`/api/share-settings/${pdfPageId}`)).token;
    assert(token, "share token");
    assertNoProblems(page);
    await ctx.close();
    return `?share=${token.slice(0, 8)}…`;
  });

  await step("share: an anonymous visitor sees the paper, the highlight and the image, read-only", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await openPage(ctx, `${server.base}/?share=${token}`);
    await page.waitForSelector(".readOnlyTitle", { timeout: 15000 });
    assert((await page.textContent(".readOnlyTitle")).includes("Rydberg paper"), "title in the share view");
    await waitForPdf(page, 1);
    await page.waitForSelector('[data-page="1"] [data-hl-id]', { timeout: 10000 });
    await until(async () => {
      const imgs = await page.$$eval("img.mdImg", (els) => els.map((e) => [e.getAttribute("src"), e.naturalWidth]));
      return imgs.length === 1 && imgs[0][0].includes("share=") && imgs[0][1] === 1;
    }, { what: "image served through the share token" });
    await page.locator(".blockRow", { hasText: "figure" }).locator(".blockBody").click();
    await sleep(400); // a negative check: nothing to wait for, so give an editor time to (not) appear
    assert((await page.$(".blockEditorCm")) == null, "no editor opens on a view-only share");
    assertNoProblems(page);
    await ctx.close();
  });

  await step("share: an edit share lets bob type into alice's page", async () => {
    await account.api(`/api/share-settings/${pdfPageId}`, { method: "PUT", body: { audience: "users", role: "edit" } });
    const ctx = await bob.context(browser);
    const page = await openPage(ctx, `${server.base}/?share=${token}`);
    await page.waitForSelector(".readOnlyTitle", { timeout: 15000 });
    await until(async () => (await page.textContent("body")).includes("Can edit"), { what: "edit badge" });
    await editRow(page, "figure");
    await page.keyboard.type(" edited by bob");
    await closeEditor(page);
    await until(async () => JSON.stringify(await tree(account, pdfPageId)).includes("edited by bob"), { what: "bob's edit saved to alice's page" });
    assertNoProblems(page);
    await ctx.close();
  });

  await step("share: an anyone-with-the-link edit share lets a stranger type under a display name", async () => {
    await account.api(`/api/share-settings/${pdfPageId}`, { method: "PUT", body: { audience: "anyone", role: "edit" } });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } }); // no session at all
    const page = await openPage(ctx, `${server.base}/?share=${token}`);
    await page.waitForSelector(".readOnlyTitle", { timeout: 15000 });
    await until(async () => (await page.textContent("body")).includes("Can edit"), { what: "edit badge" });
    // a generated name, changeable from the tag
    assert(/^as \S+ \S+$/.test((await page.locator(".linkNameTag").textContent()).trim()), "a generated two-word name");
    await page.locator(".linkNameTag").click();
    await page.locator(".linkNameInput").fill("Otter");
    await page.keyboard.press("Enter");
    await until(async () => (await page.locator(".linkNameTag").textContent()).trim() === "as Otter", { what: "renamed" });
    await editRow(page, "figure");
    await page.keyboard.type(" edited by a stranger");
    await closeEditor(page);
    await until(async () => JSON.stringify(await tree(account, pdfPageId)).includes("edited by a stranger"), { what: "stranger's edit saved" });
    const { batches } = await account.api(`/api/pages/${pdfPageId}/ops`);
    assertEq(batches[batches.length - 1].actor, "link:Otter", "the edit is attributed to the display name");
    assertNoProblems(page);
    await ctx.close();
  });
}
