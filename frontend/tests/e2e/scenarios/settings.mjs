import { Account } from "../harness.mjs";

export async function settingsScenarios(env) {
  const { server, browser, step, openPage, assert, assertEq, assertNoProblems, until, flags } = env;
  if (flags.only && !"settings".includes(flags.only)) return;
  server.manage("create-user", "settings-user", "settings-pw");
  const user = await new Account(server, "settings-user", "settings-pw").login();
  // A dummy connection supplies model choices. These tests never send AI jobs.
  await user.api("/api/ai/providers", { method: "POST", body: {
    protocol: "openai", name: "Test connection", api_key: "test-settings-only",
    base_url: server.base, models: "test-model-a, test-model-b",
  } });
  async function setup(viewport) {
    const ctx = await user.context(browser, viewport ? { viewport } : {});
    await ctx.addInitScript(() => localStorage.setItem("gamma-ai-login-check", "off"));
    const page = await openPage(ctx, server.base);
    await page.waitForSelector(".folderNewBtn");
    return { ctx, page };
  }
  async function openSettings(page) {
    await page.getByRole("button", { name: "Account & settings", exact: true }).click();
    await page.getByRole("button", { name: "Settings…", exact: true }).click();
    await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
  }
  const nav = (page, name) => page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name, exact: true });
  const row = (page, name) => page.locator(`.settingsPane [data-setting="${name}"]`).first();
  async function search(page, query, label) {
    await page.getByRole("searchbox", { name: "Search settings" }).fill(query);
    await page.locator(".settingsSearchResult").filter({ has: page.getByText(label, { exact: true }) }).click();
    await row(page, label).waitFor({ state: "visible" });
  }

  await step("settings: navigation, search, scoped management, and preferences survive reload", async () => {
    const { ctx, page } = await setup();
    try {
      await openSettings(page);
      assertEq(await nav(page, "Appearance").getAttribute("aria-current"), "page");
      await page.getByRole("button", { name: "Sepia", exact: true }).click();
      await until(() => page.locator("html").getAttribute("data-theme").then((v) => v === "sepia"));
      assertEq(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--text-primary").trim()), "#073642");
      await page.getByRole("button", { name: "Solarized Light", exact: true }).click();
      await until(() => page.locator("html").getAttribute("data-theme").then((v) => v === "solarized"));
      assertEq(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--text-primary").trim()), "#657b83");
      await until(async () => (await user.api("/api/prefs/appearance")).value?.theme === "solarized");
      await page.reload();
      await page.waitForSelector(".folderNewBtn");
      await until(() => page.locator("html").getAttribute("data-theme").then((v) => v === "solarized"));
      await openSettings(page);
      const themes = page.getByRole("group", { name: "Theme", exact: true });
      assertEq(await themes.getByRole("button").count(), 6);
      assertEq(await themes.locator('[aria-pressed="true"]').count(), 1);
      await page.getByRole("checkbox", { name: "Dark PDF pages", exact: true }).check();
      await until(() => user.api("/api/prefs/appearance").then((v) => v.value?.pdfDark === true));
      assert(await page.locator(".appearancePdfPreview.isDark").isVisible());
      await page.getByRole("checkbox", { name: "Dark PDF pages", exact: true }).uncheck();
      await until(() => user.api("/api/prefs/appearance").then((v) => v.value?.pdfDark === false));
      await row(page, "Control size").getByRole("button", { name: "Larger", exact: true }).click();
      assert((await row(page, "Control size").innerText()).includes("110%"));
      await row(page, "Control size").getByRole("button", { name: "Reset", exact: true }).click();
      if (flags.keep) await page.screenshot({ path: `${server.dir}/settings-appearance.png`, animations: "disabled" });
      await nav(page, "Diagnostics").click();
      assertEq(await nav(page, "Back to settings").count(), 0, "short pages keep the main settings navigation");
      await nav(page, "Library").click();
      if (flags.keep) await page.screenshot({ path: `${server.dir}/settings-library.png`, animations: "disabled" });
      await page.getByRole("checkbox", { name: "Labels", exact: true }).uncheck();
      await page.getByRole("checkbox", { name: "Thumbnails", exact: true }).uncheck();
      assertEq(await page.locator(".libraryDisplayCard img").count(), 0);
      assertEq(await page.locator(".libraryDisplayCard .labelTagBadge").count(), 0);
      assertEq(await page.locator(".libraryDisplayCard .folderTagBadge").count(), 1);
      await search(page, "translation concurrency", "Parallel requests");
      await row(page, "Parallel requests").locator("input").fill("7");
      await row(page, "Parallel requests").locator("input").press("Tab");
      await until(() => page.evaluate(() => localStorage.getItem("gamma-translate-parallel")).then((v) => v === "7"));
      await nav(page, "Back to settings").click();
      await nav(page, "Manage workspaces").click();
      await page.getByRole("dialog", { name: "Workspace manager" }).waitFor();
      await page.getByRole("button", { name: "Manage", exact: true }).first().click();
      await page.getByRole("button", { name: "Back to workspaces", exact: true }).waitFor();
      assertEq(await page.getByRole("dialog").count(), 1, "workspace details stay in the manager instead of stacking a dialog");
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      const rename = page.getByRole("dialog", { name: "Rename workspace", exact: true });
      await rename.getByRole("textbox").fill("Unsaved workspace name");
      await rename.press("Escape");
      await rename.getByRole("button", { name: "Discard changes", exact: true }).click();
      await page.getByRole("button", { name: "Back to workspaces", exact: true }).click();
      await nav(page, "Backups").click();
      await row(page, "Backups").waitFor();
      await nav(page, "Back to settings").click();
      assertEq(await nav(page, "Administration").count(), 0, "non-admin has no administration navigation");
      await page.getByRole("searchbox", { name: "Search settings" }).fill("administration");
      assertEq(await page.locator(".settingsSearchResult").count(), 0);
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await page.reload();
      await page.getByRole("button", { name: "Account & settings", exact: true }).waitFor();
      await openSettings(page);
      assertEq(await page.getByRole("button", { name: "Solarized Light", exact: true }).getAttribute("aria-pressed"), "true");
      await nav(page, "Library").click();
      assertEq(await page.getByRole("checkbox", { name: "Folders", exact: true }).isChecked(), true);
      assertEq(await page.getByRole("checkbox", { name: "Labels", exact: true }).isChecked(), false);
      assertEq(await page.getByRole("checkbox", { name: "Thumbnails", exact: true }).isChecked(), false);
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("settings: prompt and connection drafts have save, cancel, and dismissal protection", async () => {
    const { ctx, page } = await setup();
    try {
      await openSettings(page);
      await search(page, "custom prompts", "Custom prompts");
      await page.getByRole("button", { name: /Chat system prompt/ }).click();
      const input = page.locator(".promptTextarea").first();
      const original = await input.inputValue();
      await input.fill("Temporary unsaved prompt");
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await page.getByRole("alertdialog", { name: "Unsaved changes" }).waitFor();
      await page.getByRole("button", { name: "Keep editing", exact: true }).click();
      assertEq(await input.inputValue(), "Temporary unsaved prompt");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      assertEq(await input.inputValue(), original);
      await input.fill("Saved test prompt");
      await page.getByRole("button", { name: "Save prompts", exact: true }).click();
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await openSettings(page);
      await search(page, "custom prompts", "Custom prompts");
      await page.getByRole("button", { name: /Chat system prompt/ }).click();
      assertEq(await page.locator(".promptTextarea").first().inputValue(), "Saved test prompt");
      await nav(page, "Back to settings").click();
      await nav(page, "AI").click();
      await page.getByRole("button", { name: "+ Add provider", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Add key", exact: true });
      await dialog.getByRole("button", { name: "AI service", exact: true }).click();
      await page.getByText("Custom endpoint", { exact: true }).click();
      await dialog.getByRole("button", { name: "API protocol", exact: true }).waitFor();
      await dialog.getByRole("textbox", { name: /Base URL/ }).fill("https://example.invalid");
      await dialog.getByRole("button", { name: "AI service", exact: true }).click();
      await page.getByText("OpenAI API", { exact: true }).click();
      assertEq(await dialog.getByRole("textbox", { name: /Base URL/ }).count(), 0);
      await dialog.getByRole("textbox", { name: /Name/ }).fill("Unsaved connection");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
      await dialog.press("Escape");
      await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
      assertEq(await dialog.count(), 0);
      assertEq(await page.getByRole("dialog", { name: "AI settings", exact: true }).count(), 1);
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("settings: chat shortcuts update global model, context, and tool preferences", async () => {
    const { ctx, page } = await setup();
    try {
      await openSettings(page);
      await nav(page, "AI").click();
      await row(page, "Default chat model").waitFor();
      await row(page, "Default chat model").getByRole("button").first().click();
      await page.getByText("test-model-b", { exact: true }).last().click();
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await page.locator('[title^="Chat settings"]').click();
      const popover = page.locator(".chatSettingsPop");
      assert((await popover.innerText()).includes("test-model-b"));
      await popover.getByRole("button", { name: "Switch model" }).click();
      await page.getByText("test-model-a", { exact: true }).last().click();
      await popover.locator('input[type="number"]').fill("42000");
      await popover.locator('input[type="number"]').press("Tab");
      await popover.getByRole("checkbox", { name: "Allow tools in all chats" }).uncheck();
      await page.locator('[title^="Chat settings"]').click();
      await openSettings(page);
      await nav(page, "AI").click();
      assert((await row(page, "Default chat model").innerText()).includes("test-model-a"));
      await nav(page, "Assistant").click();
      assertEq(await page.getByRole("checkbox", { name: "Allow assistant tools" }).isChecked(), false);
      await nav(page, "Advanced").click();
      assertEq(await row(page, "Single paper").locator('input[type="number"]').inputValue(), "42000");
      await nav(page, "Assistant").click();
      await page.getByRole("checkbox", { name: "Allow assistant tools" }).check();
      await row(page, "Folder chat").getByRole("button").click();
      await page.getByText("Read & search", { exact: true }).last().click();
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await page.locator('[title^="Chat settings"]').click();
      assertEq(await popover.getByRole("checkbox", { name: "Allow tools in all chats" }).isChecked(), true);
      assertEq(await popover.getByRole("button", { name: "Rename", exact: true }).getAttribute("aria-pressed"), "false");
      assertEq(await popover.getByRole("button", { name: "Read", exact: true }).getAttribute("aria-pressed"), "true");
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("settings: mobile uses labeled navigation and fits a narrow viewport", async () => {
    const { ctx, page } = await setup({ width: 390, height: 844 });
    try {
      await openSettings(page);
      await page.getByRole("button", { name: "Gray", exact: true }).click();
      assertEq(await page.getByRole("button", { name: "Gray", exact: true }).getAttribute("aria-pressed"), "true");
      assert(!(await page.locator(".settingsPane").evaluate((el) => el.scrollWidth > el.clientWidth + 1)), "appearance fits the phone without horizontal scrolling");
      if (flags.keep) await page.screenshot({ path: `${server.dir}/settings-appearance-mobile.png`, animations: "disabled" });
      await page.setViewportSize({ width: 320, height: 844 });
      for (let i = 0; i < 6; i++) await row(page, "Control size").getByRole("button", { name: "Larger", exact: true }).click();
      assert(!(await page.locator(".settingsPane").evaluate((el) => el.scrollWidth > el.clientWidth + 1)), "appearance fits a small phone at maximum control size");
      await row(page, "Control size").getByRole("button", { name: "Reset", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await nav(page, "Reading & editing").click();
      assertEq(await page.getByRole("checkbox", { name: "Snap vertical scrolling", exact: true }).count(), 0);
      assertEq(await page.getByRole("checkbox", { name: "Note badges on highlights", exact: true }).count(), 0);
      await row(page, "Enter key").waitFor();
      await row(page, "Enter key").getByRole("button", { name: "New note", exact: true }).click();
      assert((await row(page, "Enter key").innerText()).includes("Shift+Enter inserts a new line"));
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await nav(page, "Library").click();
      for (const [folders, labels, mode] of [[false, false, "off"], [false, true, "labels"], [true, false, "folders"], [true, true, "both"]]) {
        await page.getByRole("checkbox", { name: "Folders", exact: true }).setChecked(folders);
        await page.getByRole("checkbox", { name: "Labels", exact: true }).setChecked(labels);
        assertEq(await page.locator(".libraryDisplayCard .folderTagBadge").count(), Number(folders));
        assertEq(await page.locator(".libraryDisplayCard .labelTagBadge").count(), Number(labels));
        assertEq(await page.evaluate(() => localStorage.getItem("gamma-home-file-labels")), mode);
      }
      await page.getByRole("checkbox", { name: "Thumbnails", exact: true }).check();
      assertEq(await page.locator(".libraryDisplayCard img").count(), 1);
      assert(!(await page.locator(".settingsPane").evaluate((el) => el.scrollWidth > el.clientWidth + 1)), "library display fits the phone");
      if (flags.keep) await page.screenshot({ path: `${server.dir}/settings-library-mobile.png`, animations: "disabled" });
      await search(page, "translation model", "Translation model");
      assert(await row(page, "Translation model").isVisible());
      const overflow = await page.locator(".settingsPane").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      assert(!overflow, "settings content fits the phone without horizontal scrolling");
      if (flags.keep) await page.screenshot({ path: `${server.dir}/settings-mobile.png`, animations: "disabled" });
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("settings: administrators see their own account separately from all users", async () => {
    server.manage("set-admin", "settings-user", "on");
    const { ctx, page } = await setup();
    try {
      await openSettings(page);
      await nav(page, "Account").click();
      await page.locator(".settingsPane .aiProvRow").waitFor();
      assertEq(await page.locator(".settingsPane .aiProvRow").count(), 1);
      await nav(page, "Administration").click();
      const limit = row(page, "Default max upload").locator("input");
      await limit.waitFor();
      const originalLimit = await limit.inputValue();
      await limit.fill("77");
      await nav(page, "Users").click();
      await page.getByRole("button", { name: "Keep editing", exact: true }).click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      assertEq(await limit.inputValue(), originalLimit);
      await limit.fill("77");
      await row(page, "Default quota").locator("input").fill("1200");
      await page.getByRole("button", { name: "Save limits", exact: true }).click();
      await until(() => user.api("/api/admin/settings").then((v) => v.max_upload_mb === 77 && v.quota_mb === 1200));
      await nav(page, "Users").click();
      await until(() => page.locator(".settingsPane .aiProvRow").count().then((n) => n > 1));
      // Each account row nests its personal workspaces; Manage opens the
      // workspace dialog in admin mode. The Server pane lists shared ones only.
      await until(() => page.locator(".settingsPane .aiProvSubRow").count().then((n) => n > 1));
      await page.locator(".settingsPane .aiProvSubRow").first().getByRole("button", { name: "Manage" }).click();
      await page.locator(".subDialog").getByRole("button", { name: "Rename", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.locator(".subDialog").waitFor({ state: "detached" });
      await nav(page, "Server").click();
      await page.getByText("Shared workspaces", { exact: true }).waitFor();
      assertEq(await page.getByText("Personal workspaces", { exact: true }).count(), 0);
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });
}
