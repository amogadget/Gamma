import { Account } from "../harness.mjs";
import fs from "node:fs";
import path from "node:path";

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

  await step("settings: model discovery updates automatically and long lists scroll", async () => {
    const { ctx, page } = await setup({ width: 800, height: 650 });
    try {
      const calls = [];
      let oldResponseSent = false;
      const models = Array.from({ length: 100 }, (_, i) => `gpt-test-${String(i).padStart(3, "0")}`);
      await page.route("**/api/ai/model-catalog", async (route) => {
        const body = route.request().postDataJSON();
        calls.push(body);
        if (body.api_key === "old-key") await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.fulfill({ json: { models: body.api_key === "old-key" ? ["stale-model"] : models } });
        if (body.api_key === "old-key") oldResponseSent = true;
      });
      await openSettings(page);
      await nav(page, "AI").click();
      await page.getByRole("button", { name: "+ Add provider", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Add key", exact: true });
      await dialog.getByRole("button", { name: "AI service", exact: true }).click();
      await page.getByText("OpenAI API", { exact: true }).click();
      const key = dialog.locator('input[autocomplete="new-password"]');
      await key.fill("old-key");
      await until(() => calls.length === 1);
      await key.fill("new-key");
      await until(() => calls.length === 2);
      await dialog.getByRole("button", { name: "100 usable" }).waitFor();
      const input = dialog.getByRole("combobox", { name: "Add a model" });
      await input.click();
      const list = page.getByRole("listbox", { name: "Available models" });
      assertEq(await list.getByRole("option").count(), 100);
      const bounds = await list.boundingBox();
      assert(bounds.y >= 0 && bounds.y + bounds.height <= 650, "model list fits the viewport");
      assert(await list.evaluate((el) => el.scrollHeight > el.clientHeight), "long list is scrollable");
      await list.hover();
      await page.mouse.wheel(0, 1600);
      await until(() => list.evaluate((el) => el.scrollTop > 0));
      await input.fill("099");
      await list.getByRole("option", { name: "gpt-test-099", exact: true }).click();
      await dialog.getByRole("button", { name: "Remove gpt-test-099", exact: true }).waitFor();
      await input.click();
      await input.press("ArrowUp");
      await input.press("Enter");
      await dialog.getByRole("button", { name: "Remove gpt-test-098", exact: true }).waitFor();
      await input.fill("my-custom-model");
      await input.press("Enter");
      await dialog.getByRole("button", { name: "Remove my-custom-model", exact: true }).waitFor();
      // Let the older response land; it must not replace the new catalog.
      await until(() => oldResponseSent);
      await until(() => page.getByRole("button", { name: "100 usable" }).isVisible());
      await input.click();
      await input.press("Escape");
      assertEq(await list.count(), 0);
      assert(await dialog.isVisible(), "Escape dismisses the list without closing the dialog");
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("settings: manual OAuth connection automatically fetches models", async () => {
    const { ctx, page } = await setup();
    try {
      await page.evaluate(() => {
        window.open = (url) => { window.testSignInUrl = url; return null; };
      });
      await page.route("**/api/ai/oauth/chatgpt/complete", async (route) => {
        const info = await user.api("/api/ai/settings");
        info.providers.push({ id: "oauth-test", protocol: "chatgpt", name: "Test sign-in", models: "gpt-test", oauth_connected: true });
        await route.fulfill({ json: info });
      });
      let catalogCalls = 0;
      await page.route("**/api/ai/model-catalog", async (route) => {
        catalogCalls++;
        await route.fulfill({ json: { models: ["gpt-test", "gpt-new-model"] } });
      });
      await openSettings(page);
      await nav(page, "AI").click();
      await page.getByRole("button", { name: "+ Add provider", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Add key", exact: true });
      await dialog.getByRole("button", { name: "AI service", exact: true }).click();
      await page.getByText("ChatGPT subscription", { exact: true }).click();
      await dialog.getByRole("button", { name: "Open ChatGPT sign-in", exact: true }).click();
      await until(() => page.evaluate(() => !!window.testSignInUrl));
      const state = await page.evaluate(() => new URL(window.testSignInUrl).searchParams.get("state"));
      const callback = dialog.getByRole("textbox", { name: /Callback URL/ });
      assertEq(await callback.inputValue(), "", "callback remains a manual input");
      await callback.fill(`http://localhost:1455/auth/callback?code=test&state=${state}`);
      await dialog.getByRole("button", { name: "Connect", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "Edit key", exact: true });
      await edit.getByRole("button", { name: "2 usable" }).waitFor();
      assertEq(catalogCalls, 1);
      await edit.getByRole("combobox", { name: "Add a model" }).click();
      await page.getByRole("option", { name: "gpt-new-model", exact: true }).waitFor();
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("settings: external assistant token creation, hiding, and revocation", async () => {
    const { ctx, page } = await setup();
    try {
      await openSettings(page);
      await nav(page, "AI").click();
      await nav(page, "External assistants").click();
      const serverUrl = page.getByRole("textbox", { name: "Gamma MCP server URL" });
      await serverUrl.waitFor();
      assertEq(await serverUrl.inputValue(), `${server.base}/mcp`);
      assert(!await page.getByRole("textbox", { name: "Codex MCP configuration" }).isVisible(), "manual setup starts collapsed");
      assert(!await page.getByRole("textbox", { name: "Codex setup command", exact: true }).isVisible(), "only the selected method is shown");
      await page.getByRole("button", { name: "Copy server URL", exact: true }).click();
      await page.getByText("Copied. You can paste it now.", { exact: true }).waitFor();
      if (process.env.GAMMA_MCP_SCREENSHOTS) {
        fs.mkdirSync(process.env.GAMMA_MCP_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.GAMMA_MCP_SCREENSHOTS, "settings-desktop.png") });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(process.env.GAMMA_MCP_SCREENSHOTS, "settings-mobile.png"), fullPage: true });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
        await page.setViewportSize({ width: 1280, height: 860 });
      }
      await page.getByRole("button", { name: "Codex CLI", exact: true }).click();
      await page.getByRole("button", { name: "Windows PowerShell", exact: true }).click();
      const commandField = page.getByRole("textbox", { name: "Codex setup command", exact: true });
      const commands = await commandField.inputValue();
      assert(commands.includes("install-gamma-codex.ps1"));
      assert(commands.includes(`-ServerUrl '${server.base}/mcp'`));
      assert(!commands.includes("GAMMA_TOKEN"));
      await page.getByRole("button", { name: "macOS / Linux", exact: true }).click();
      assert((await commandField.inputValue()).includes("install-gamma-codex.sh"));
      assert((await commandField.inputValue()).endsWith(`'${server.base}/mcp')`), "Unix setup passes the server URL inside its cleanup subshell");
      await page.getByRole("button", { name: "Copy setup command", exact: true }).click();
      await page.getByText("Copied. You can paste it now.", { exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await commandField.scrollIntoViewIfNeeded();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "setup command fits a narrow viewport");
      if (process.env.GAMMA_MCP_SCREENSHOTS) {
        await page.screenshot({ path: path.join(process.env.GAMMA_MCP_SCREENSHOTS, "codex-setup-mobile.png"), fullPage: true });
      }
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.getByText("Manual setup (advanced)", { exact: true }).click();
      const config = page.getByRole("textbox", { name: "Codex MCP configuration" });
      await config.waitFor();
      assert((await config.inputValue()).includes(`${server.base}/mcp`));
      await page.getByRole("textbox", { name: "Connection name" }).fill("Codex test");
      await page.getByRole("button", { name: "Create token", exact: true }).click();
      const secret = page.getByRole("textbox", { name: "New integration token" });
      await secret.waitFor();
      assert((await secret.inputValue()).startsWith("gamma_"));
      const connections = await user.api("/api/integrations/tokens");
      assertEq(connections.tokens.length, 1);
      assert(!JSON.stringify(connections).includes(await secret.inputValue()), "token is never returned in listings");
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await secret.waitFor({ state: "detached" });
      // Separate authorizations can have the same name. Revoking one must
      // leave the other visible, without claiming the assistant lost access.
      const duplicate = await user.api("/api/integrations/tokens", { method: "POST", body: { name: "Codex test" } });
      await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
      await until(() => page.getByRole("button", { name: "Disconnect", exact: true }).count().then((n) => n === 2));
      let releaseStale, captured;
      const staleReady = new Promise((resolve) => { captured = resolve; });
      const staleGate = new Promise((resolve) => { releaseStale = resolve; });
      let holdNext = true;
      const routePattern = "**/api/integrations/tokens";
      await page.route(routePattern, async (route) => {
        if (!holdNext || route.request().method() !== "GET") return route.continue();
        holdNext = false;
        const response = await route.fetch();
        captured();
        await staleGate;
        await route.fulfill({ response });
      });
      await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
      await staleReady;
      await page.getByRole("button", { name: "Disconnect", exact: true }).first().click();
      const revoked = page.getByText("Access revoked for the selected “Codex test” connection.", { exact: true });
      await revoked.waitFor();
      await until(() => page.getByRole("button", { name: "Disconnect", exact: true }).count().then((n) => n === 1));
      const staleResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/api/integrations/tokens") && response.request().method() === "GET");
      releaseStale();
      await (await staleResponse).finished();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assertEq(await page.getByRole("button", { name: "Disconnect", exact: true }).count(), 1, "late refresh cannot restore a revoked connection");
      await page.unroute(routePattern);
      const remaining = (await user.api("/api/integrations/tokens")).tokens;
      assertEq(remaining.length, 1);
      assert(remaining[0].id !== duplicate.id, "only the selected connection was revoked");
      // Reconnecting in another tab clears the old notice on window focus.
      const reconnected = await user.api("/api/integrations/tokens", { method: "POST", body: { name: "Codex reconnected" } });
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.getByText("Codex reconnected", { exact: true }).waitFor();
      await revoked.waitFor({ state: "detached" });
      await user.api(`/api/integrations/tokens/${reconnected.id}`, { method: "DELETE" });
      await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
      await until(() => page.getByRole("button", { name: "Disconnect", exact: true }).count().then((n) => n === 1));
      await page.getByRole("button", { name: "Disconnect", exact: true }).click();
      await page.getByText("No assistants have access to this workspace yet.", { exact: true }).waitFor();
      assertEq((await user.api("/api/integrations/tokens")).tokens.length, 0);
      const second = await user.api("/api/workspaces", { method: "POST", body: { name: "Other assistant workspace" } });
      const elsewhere = await user.api(`/api/integrations/tokens?ws=${second.id}`, { method: "POST", body: { name: "Codex elsewhere" } });
      const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/api/integrations/tokens") && response.request().method() === "GET");
      await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
      assertEq((await (await refreshed).json()).tokens.length, 0);
      await revoked.waitFor({ state: "detached" });
      assertEq(await page.getByText("Codex elsewhere", { exact: true }).count(), 0, "other workspace connections stay out of this panel");
      assert(await page.getByText("No assistants have access to this workspace yet.", { exact: true }).isVisible());
      assertEq(await page.getByRole("button", { name: "Disconnect", exact: true }).count(), 0, "other workspace connections are not managed as current workspace access");
      await user.api(`/api/integrations/tokens/${elsewhere.id}?ws=${second.id}`, { method: "DELETE" });
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("settings: navigation, search, scoped management, and preferences survive reload", async () => {
    const { ctx, page } = await setup();
    try {
      await openSettings(page);
      assertEq(await nav(page, "Appearance").getAttribute("aria-current"), "page");
      for (const [label, theme, scheme] of [["Gamma Light", "gamma-light", "light"], ["Gamma Dark", "gamma-dark", "dark"]]) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await until(() => page.locator("html").getAttribute("data-theme").then((v) => v === theme));
        assertEq(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), scheme);
        await until(async () => (await user.api("/api/prefs/appearance")).value?.theme === theme);
        await page.reload();
        await page.waitForSelector(".folderNewBtn");
        assertEq(await page.locator("html").getAttribute("data-theme"), theme);
        await openSettings(page);
        assertEq(await page.getByRole("button", { name: label, exact: true }).getAttribute("aria-pressed"), "true");
        if (flags.keep) await page.screenshot({ path: `${server.dir}/settings-${theme}.png`, animations: "disabled" });
      }
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
      assertEq(await themes.getByRole("button").count(), 8);
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

  await step("settings: token usage section lists the account's AI calls", async () => {
    const { ctx, page } = await setup();
    try {
      await openSettings(page);
      await search(page, "token", "Token usage");
      const section = page.locator(".settingsPane");
      await row(page, "All time").waitFor();
      assert((await row(page, "All time").innerText()).includes("No AI calls recorded yet"));
      assertEq(await row(page, "All time").getByRole("button", { name: "Reset" }).isDisabled(), true);
      const usage = await user.api("/api/ai/usage");
      assertEq(usage.windows.all.calls, 0);
      assertEq((await user.api("/api/ai/usage", { method: "DELETE" })).deleted, 0);
      assert((await section.innerText()).includes("no calls"), "the window tiles say no calls");
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
      // the dashboard: three tiles and the update row (the release check is
      // disabled for the isolated backend, so the row says so)
      await until(() => page.locator(".settingsPane .setStatText").count().then((n) => n === 3));
      await page.getByText("could not check", { exact: false }).waitFor();
      await page.locator(".settingsPane .segGroup button", { hasText: "Warnings" }).click();
      await page.getByText("Shared workspaces", { exact: true }).waitFor();
      assertEq(await page.getByText("Personal workspaces", { exact: true }).count(), 0);
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });
}
