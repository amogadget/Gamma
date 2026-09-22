// Note editing: page creation, the block editor's keys (Shift+Enter /
// Enter-as-new-block pref / Tab / Shift+Tab / Backspace), the op save path +
// reload, undo, the handle menu, markdown rendering (todos, images) and the
// workspace on browser-fetched upload URLs. Runs in a NON-default workspace:
// every request must name it explicitly, which is where plumbing bugs show.

export const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// The page's block tree as [{content, children}] from the API: what the
// server holds, i.e. what a reload would show.
export async function tree(account, pageId) {
  const data = await account.api(`/api/blocks/${pageId}/subtree`);
  const strip = (b) => ({ content: b.content, children: (b.children || []).map(strip) });
  return (data.block.children || []).map(strip);
}

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function row(page, text) {
  return page.locator(".blockRow", { hasText: text }).first();
}

// Click a rendered block to open its editor, caret at the end.
export async function editRow(page, text) {
  await row(page, text).locator(".blockBody").click();
  await page.waitForSelector(".blockEditorCm .cm-content", { timeout: 5000 });
  await page.keyboard.press("End");
}

// Tab / Shift+Tab re-parent the block, which remounts its row and closes the
// editor; reopen it in place (same trick as the readme-media drivers).
export async function reopenFocused(page) {
  await page.waitForSelector(".blockRow.focused", { timeout: 5000 });
  await page.evaluate(() => {
    const r = document.querySelector(".blockRow.focused");
    const body = r.querySelector(".blockBody") || r;
    const b = body.getBoundingClientRect();
    r.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: b.left + 40, clientY: b.top + b.height / 2 }));
  });
  await page.waitForSelector(".blockEditorCm .cm-content", { timeout: 5000 });
  await page.keyboard.press("End");
}

// Escape never closes the editor (it only dismisses popups); an in-page blur does.
export async function closeEditor(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForSelector(".blockEditorCm", { state: "detached", timeout: 5000 });
}

export async function newPageViaUi(page, title) {
  await page.waitForSelector(".folderNewBtn", { timeout: 15000 });
  await page.click(".folderNewBtn");
  await page.waitForSelector(".titleEdit");
  await page.keyboard.type(title);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".blockEditorCm .cm-content", { timeout: 5000 });
  return new URL(page.url()).searchParams.get("block");
}

export async function noteScenarios({ server, browser, alice, step, until, sleep, assert, assertEq, assertNoProblems, openPage }) {
  const second = await alice.api("/api/workspaces", { method: "POST", body: { name: "Second" } });
  const alice2 = Object.assign(Object.create(Object.getPrototypeOf(alice)), alice, { ws: second.id });
  let ctx, page, pageId;
  const saved = (want, what) => until(async () => same(await tree(alice2, pageId), want), { what: what || `tree ${JSON.stringify(want)}` });

  await step("notes: New page, title, first block, reload persists (non-default workspace)", async () => {
    ctx = await alice2.context(browser);
    page = await openPage(ctx, `${server.base}/?ws=${second.id}`);
    pageId = await newPageViaUi(page, "Reading list");
    assert(pageId, "URL names the page");
    await page.keyboard.type("first");
    await saved([{ content: "first", children: [] }], "the first block saved as an insert");
    assertNoProblems(page);
    await page.reload();
    await page.waitForSelector(".blockRow", { timeout: 15000 });
    await until(async () => (await page.textContent("body")).includes("first"), { what: "content after reload" });
    assert((await page.textContent("body")).includes("Reading list"), "title after reload");
    assertNoProblems(page);
  });

  await step("notes: Shift+Enter / Tab / Shift+Tab / Backspace shape the tree", async () => {
    await editRow(page, "first");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second");
    await page.keyboard.press("Tab");
    await reopenFocused(page);
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("third");
    await page.keyboard.press("Shift+Tab");
    await reopenFocused(page);
    await page.keyboard.press("Shift+Enter");
    // The new (empty) block's editor has the focus before Backspace removes it
    // (an empty CodeMirror doc shows its placeholder widget, so test for that).
    await page.waitForFunction(() => {
      const ed = document.activeElement?.closest(".cm-content");
      return !!ed && (ed.querySelector(".cm-placeholder") != null || ed.textContent === "");
    }, null, { timeout: 5000 });
    await page.keyboard.press("Backspace");
    await closeEditor(page);
    await saved([{ content: "first", children: [{ content: "second", children: [] }] }, { content: "third", children: [] }]);
    assertNoProblems(page);
  });

  await step("notes: plain Enter is a line break; Ctrl+Z inside the editor restores the text", async () => {
    await editRow(page, "third");
    await page.keyboard.press("Enter");
    await page.keyboard.type("line two");
    await until(async () => JSON.stringify(await tree(alice2, pageId)).includes("third\\nline two"), { what: "line break saved" });
    await page.keyboard.press("Control+z");
    await page.getByText(/^Undone: note text edit:/).waitFor();
    await closeEditor(page);
    await saved([{ content: "first", children: [{ content: "second", children: [] }] }, { content: "third", children: [] }], "undo saved");
    assertNoProblems(page);
  });

  await step("notes: the handle menu duplicates and deletes a block", async () => {
    const wrap = page.locator(".sortableBlockWrap", { hasText: "third" }).first();
    await wrap.hover();
    await wrap.locator(".dragHandle").click();
    await page.locator(".ctxMenuItem", { hasText: "Duplicate" }).click();
    await saved([{ content: "first", children: [{ content: "second", children: [] }] }, { content: "third", children: [] }, { content: "third", children: [] }], "duplicate saved");
    const dup = page.locator(".sortableBlockWrap", { hasText: "third" }).nth(1);
    await dup.hover();
    await dup.locator(".dragHandle").click();
    await page.locator(".ctxMenuItem", { hasText: "Delete" }).click();
    await saved([{ content: "first", children: [{ content: "second", children: [] }] }, { content: "third", children: [] }], "delete saved");
    assertNoProblems(page);
  });

  await step("notes: a todo renders as a checkbox and clicking it writes [x]", async () => {
    await editRow(page, "third");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("- [ ] buy milk");
    await closeEditor(page);
    const box = row(page, "buy milk").locator("input.mdTaskCheckbox").first();
    await box.waitFor({ timeout: 5000 });
    await box.click();
    await until(async () => JSON.stringify(await tree(alice2, pageId)).includes("- [x] buy milk"), { what: "checkbox toggled in the source" });
    assertNoProblems(page);
  });

  await step("notes: an uploaded image renders (URL carries the workspace) and survives reload", async () => {
    const up = await alice2.upload("/api/upload-image", PNG_1PX, "dot.png", "image/png");
    await editRow(page, "buy milk");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(`![](${up.url})`);
    await closeEditor(page);
    const check = async () => {
      const imgs = await page.$$eval("img.mdImg", (els) => els.map((e) => [e.getAttribute("src"), e.naturalWidth]));
      return imgs.length === 1 && imgs[0][0].includes(`ws=${second.id}`) && imgs[0][1] === 1 ? imgs[0][0] : null;
    };
    await until(check, { what: "rendered image with ?ws=" });
    await page.reload();
    await page.waitForSelector(".blockRow", { timeout: 15000 });
    const src = await until(check, { what: "rendered image after reload" });
    assertNoProblems(page);
    return src;
  });

  await step("notes: in the editor an untouched image shows the picture, the caret on it shows the source", async () => {
    const up = await alice2.upload("/api/upload-image", PNG_1PX, "dot2.png", "image/png");
    await editRow(page, "buy milk");
    await page.keyboard.press("Enter"); // a line break; list continuation makes line 2 a new todo item
    await page.keyboard.type(`![](${up.url})`);
    const widgets = () => page.$$eval(".blockEditorCm .cmImgWidget img", (els) => els.map((e) => [e.getAttribute("src"), e.naturalWidth]));
    // The caret sits at the end of the image it just typed: raw source.
    assertEq((await widgets()).length, 0, "typed image stays raw under the caret");
    await page.keyboard.press("Control+Home"); // line 1: the image is untouched now
    await until(async () => {
      const imgs = await widgets();
      return imgs.length === 1 && imgs[0][0].includes(`ws=${second.id}`) && imgs[0][1] === 1;
    }, { what: "image widget in the editor" });
    await page.keyboard.press("Control+End"); // back onto the image: raw again
    await until(async () => {
      const raw = await page.$eval(".blockEditorCm .cm-content", (el) => el.textContent);
      return (await widgets()).length === 0 && raw.includes("![](");
    }, { what: "raw image source under the caret" });
    await closeEditor(page);
    await until(async () => JSON.stringify(await tree(alice2, pageId)).includes(`- [ ] ![](${up.url})`), { what: "image line saved" });
    assertNoProblems(page);
  });

  await step("notes: one blank line is a paragraph break, a second one renders as an empty line", async () => {
    await editRow(page, "third");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("after gap");
    await closeEditor(page);
    await until(async () => JSON.stringify(await tree(alice2, pageId)).includes("third\\n\\n\\nafter gap"), { what: "blank lines saved" });
    const paras = await row(page, "after gap").locator(".blockRendered p").allTextContents();
    assertEq(JSON.stringify(paras), JSON.stringify(["third", "\u00a0", "after gap"]), "an empty paragraph between the two");
    assertNoProblems(page);
  });

  await step("notes: colored text via the / menu and a foldable [!note]- callout", async () => {
    await editRow(page, "after gap");
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/red");
    await page.getByRole("button", { name: /Red text/ }).click();
    // The command lands through a React round trip that sets the content
    // first and the caret a beat later; type once the caret sits inside the
    // span (the mermaid step waits for its selection the same way).
    await page.waitForFunction(() => {
      const sel = document.getSelection();
      const ed = document.activeElement?.closest(".cm-content");
      if (!ed || !sel?.anchorNode || !ed.contains(sel.anchorNode)) return false;
      const r = document.createRange(); r.setStart(ed, 0); r.setEnd(sel.anchorNode, sel.anchorOffset);
      return r.toString().endsWith('#e5484d">');
    }, null, { timeout: 5000 });
    await page.keyboard.type("hot");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("> [!note]- Proof");
    await page.keyboard.press("Enter");
    await page.keyboard.type("hidden body");
    await closeEditor(page);
    await until(async () => JSON.stringify(await tree(alice2, pageId)).includes('<span style=\\"color:#e5484d\\">hot</span>'), { what: "the color span saved as inline HTML" });
    const colored = row(page, "hot").locator('.blockRendered span[style*="color"]');
    assertEq(await colored.innerText(), "hot", "the rendered view colors the run");
    const details = row(page, "Proof").locator("details.callout");
    assertEq(await details.count(), 1, "the fold flag renders a <details>");
    assertEq(await details.evaluate((el) => el.open), false, "'-' starts collapsed");
    await details.locator("summary").click();
    assertEq(await details.evaluate((el) => el.open), true, "the title toggles it");
    assertEq(await page.locator(".blockEditorCm").count(), 0, "toggling never opens the editor");
    assertNoProblems(page);
  });

  await step("notes: Export… as an Obsidian vault downloads a zip", async () => {
    await page.click("button[aria-label='View']");
    await page.locator(".popoverItem", { hasText: "Export…" }).click();
    const dialog = page.getByRole("dialog", { name: "Export", exact: true });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Obsidian", exact: true }).click();
    await dialog.getByRole("button", { name: "Next", exact: true }).click();
    const download = page.waitForEvent("download", { timeout: 15000 });
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    const file = await download;
    assert(/-obsidian\.zip$/.test(file.suggestedFilename()), `vault zip name: ${file.suggestedFilename()}`);
    await until(async () => (await page.textContent("body")).includes("Obsidian vault saved"), { what: "export status" });
    assertNoProblems(page);
  });

  await step("notes: the account menu lists both workspaces and switches", async () => {
    await page.click("button[aria-label='Account & settings']");
    await page.waitForSelector(".userPopover .wsItem");
    const names = await page.$$eval(".userPopover .wsItem .wsItemName", (els) => els.map((e) => e.textContent.trim()));
    assert(names.includes("Second") && names.includes("alice"), `workspaces listed: ${names.join(", ")}`);
    await page.locator(".userPopover .wsItem", { hasText: "alice" }).click();
    await page.waitForURL((u) => u.searchParams.get("ws") === alice.defaultWs, { timeout: 15000 });
    await page.waitForSelector(".folderNewBtn, .blockRow", { timeout: 15000 });
    assertNoProblems(page);
  });
  if (ctx) await ctx.close();

  await step("notes: Enter-as-new-block preference, in the default workspace", async () => {
    const ctxD = await alice.context(browser);
    await ctxD.addInitScript(() => { try { localStorage.setItem("gamma-enter-new-note", "1"); } catch {} });
    const p = await openPage(ctxD, `${server.base}/?ws=${alice.defaultWs}`);
    const id = await newPageViaUi(p, "Default ws page");
    await p.keyboard.type("hello");
    await p.keyboard.press("Enter");
    await p.keyboard.type("world");
    await closeEditor(p);
    await until(async () => same(await tree(alice, id), [{ content: "hello", children: [] }, { content: "world", children: [] }]), { what: "two blocks saved" });
    assertNoProblems(p);
    await ctxD.close();
  });

  return { second, alice2, pageId };
}
