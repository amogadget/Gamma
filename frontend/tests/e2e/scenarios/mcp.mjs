import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { newPageViaUi } from "./notes.mjs";
import { Account } from "../harness.mjs";

export async function mcpScenarios(env) {
  const { server, browser, alice, step, openPage, assert, assertEq, assertNoProblems, flags, sleep, until } = env;
  if (flags.only && !"mcp".includes(flags.only)) return;
  await step("mcp: administrator confirms the suggested server URL and it persists", async () => {
    server.manage("create-user", "mcp-admin", "mcp-admin-pw");
    server.manage("set-admin", "mcp-admin", "on");
    const admin = await new Account(server, "mcp-admin", "mcp-admin-pw").login();
    const ctx = await admin.context(browser);
    try {
      const page = await openPage(ctx, server.base);
      const openServer = async () => {
        await page.getByRole("button", { name: "Account & settings", exact: true }).click();
        await page.getByRole("button", { name: "Settings…", exact: true }).click();
        await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Server", exact: true }).click();
        await page.getByRole("textbox", { name: "Public server URL", exact: true }).waitFor();
      };
      await openServer();
      const address = page.getByRole("textbox", { name: "Public server URL", exact: true });
      await until(() => address.inputValue().then((v) => v === server.base));
      assertEq((await admin.api("/api/admin/settings")).public_url, "", "suggestion is not implicitly trusted");
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await until(() => admin.api("/api/admin/settings").then((v) => v.public_url === server.base));
      await address.fill("https://draft.example");
      // an unconfirmed edit is a draft: leaving the pane asks, discarding restores the stored address
      await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Users", exact: true }).click();
      await page.getByRole("button", { name: "Keep editing", exact: true }).click();
      assertEq(await address.inputValue(), "https://draft.example");
      await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Users", exact: true }).click();
      await page.getByRole("button", { name: "Discard changes", exact: true }).click();
      await page.reload();
      await openServer();
      await until(() => address.inputValue().then((v) => v === server.base));
      assertEq(await page.getByRole("button", { name: "Confirm", exact: true }).count(), 0, "a confirmed, unchanged address needs no button");
      assert((await page.locator(".settingsPane .uiTag", { hasText: "confirmed" }).count()) >= 1, "the confirmed chip shows");
      if (process.env.GAMMA_MCP_SCREENSHOTS) {
        fs.mkdirSync(process.env.GAMMA_MCP_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.GAMMA_MCP_SCREENSHOTS, "public-url-desktop.png") });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(process.env.GAMMA_MCP_SCREENSHOTS, "public-url-mobile.png") });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "server settings fit mobile width");
      }
      assertNoProblems(page);
    } finally {
      await admin.api("/api/admin/settings", { method: "PUT", body: { public_url: "" } });
      await ctx.close();
    }
  });
  async function request() {
    const redirect = "https://client.example/callback";
    const verifier = randomBytes(32).toString("base64url");
    const registered = await fetch(`${server.base}/oauth/register`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Codex browser test", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
    assertEq(registered.status, 201);
    const client = await registered.json();
    const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect,
      resource: `${server.base}/mcp`, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256", state: "browser-test", scope: "gamma:read" });
    return { url: `${server.base}/oauth/authorize?${params}`, client, redirect, verifier };
  }

  await step("mcp: browser login, workspace approval, token exchange and revocation", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    try {
      await ctx.route("https://client.example/callback**", (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "Connection approved. Return to your assistant." }));
      const flow = await request();
      const page = await openPage(ctx, flow.url);
      await page.getByText("Sign in to connect your assistant").waitFor();
      await page.locator('input[type="text"]').fill("alice");
      await page.locator('input[type="password"]').fill("alice-pw");
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      await page.getByRole("button", { name: "Allow read-only access" }).waitFor();
      const workspaces = (await alice.api("/api/session")).workspaces || [];
      const chosen = page.getByRole("button", { name: "Workspace", exact: true });
      assertEq((await chosen.textContent()).trim(), workspaces.find((w) => w.id === alice.ws)?.name || "");
      if (process.env.GAMMA_MCP_SCREENSHOTS) {
        fs.mkdirSync(process.env.GAMMA_MCP_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.GAMMA_MCP_SCREENSHOTS, "consent-desktop.png") });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(process.env.GAMMA_MCP_SCREENSHOTS, "consent-mobile.png"), fullPage: true });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
      }
      await page.getByRole("button", { name: "Allow read-only access" }).click();
      await page.waitForURL("https://client.example/callback**");
      const callback = new URL(page.url());
      assertEq(callback.searchParams.get("state"), "browser-test");
      const response = await fetch(`${server.base}/oauth/token`, { method: "POST", body: new URLSearchParams({
        grant_type: "authorization_code", client_id: flow.client.client_id, code: callback.searchParams.get("code"),
        code_verifier: flow.verifier, redirect_uri: flow.redirect, resource: `${server.base}/mcp`,
      }) });
      assertEq(response.status, 200);
      const token = (await response.json()).access_token;
      const rpc = () => fetch(`${server.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`,
        "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_pages", arguments: {} } }) });
      const read = await rpc();
      assertEq(read.status, 200);
      assert(!(await read.json()).result.isError, "MCP read succeeds");
      const connection = (await alice.api("/api/integrations/tokens")).tokens.find((t) => t.name === "Codex browser test (OAuth)");
      assert(connection, "OAuth connection appears in settings");
      await alice.api(`/api/integrations/tokens/${connection.id}`, { method: "DELETE" });
      assertEq((await rpc()).status, 401);
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("mcp: a saved library page cannot dismiss authorization", async () => {
    const ctx = await alice.context(browser);
    try {
      const page = await openPage(ctx, server.base);
      const pageId = await newPageViaUi(page, "Page open before authorization");
      assert(pageId, "saved session names a real page");
      const key = `gamma-session:alice@${alice.ws}`;
      await page.evaluate(({ key, pageId }) => localStorage.setItem(key, JSON.stringify({ focusedBlockId: pageId })), { key, pageId });
      const saved = await page.evaluate((key) => localStorage.getItem(key), key);
      const before = (await alice.api("/api/integrations/tokens")).tokens.length;
      await page.goto((await request()).url);
      await page.getByRole("button", { name: "Allow read-only access" }).waitFor();
      // The asynchronous saved-page restore must leave ?gamma_oauth in the
      // URL and the consent screen mounted; give it time to run.
      await sleep(1500);
      assert(new URL(page.url()).searchParams.has("gamma_oauth"), "authorization URL is preserved");
      assert(await page.getByRole("button", { name: "Allow read-only access" }).isVisible());
      assertEq(await page.evaluate((key) => localStorage.getItem(key), key), saved, "saved library session is untouched");
      await page.reload();
      await page.getByRole("button", { name: "Allow read-only access" }).waitFor();
      assertEq((await alice.api("/api/integrations/tokens")).tokens.length, before);
      await page.getByRole("button", { name: "Use another account" }).click();
      await page.getByText("Sign in to connect your assistant").waitFor();
      assert(new URL(page.url()).searchParams.has("gamma_oauth"), "switching accounts keeps the request");
      await alice.login();
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("mcp: cancel returns access_denied without granting a connection", async () => {
    const ctx = await alice.context(browser);
    try {
      await ctx.route("https://client.example/callback**", (route) => route.fulfill({ status: 200, body: "Cancelled" }));
      const before = (await alice.api("/api/integrations/tokens")).tokens.length;
      const page = await openPage(ctx, (await request()).url);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.waitForURL("https://client.example/callback**");
      assertEq(new URL(page.url()).searchParams.get("error"), "access_denied");
      assertEq((await alice.api("/api/integrations/tokens")).tokens.length, before);
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("mcp: resolve browser page URLs, block links and share links", async () => {
    const ctx = await alice.context(browser, { permissions: ["clipboard-read", "clipboard-write"] });
    const credential = await alice.api("/api/integrations/tokens", { method: "POST", body: { name: "Link browser test" } });
    const readLink = async (url) => {
      const response = await fetch(`${server.base}/mcp`, { method: "POST", headers: {
        Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_gamma_link", arguments: { url } } }) });
      assertEq(response.status, 200);
      const result = (await response.json()).result;
      assert(!result.isError, JSON.stringify(result));
      return result;
    };
    try {
      const page = await openPage(ctx, server.base);
      const pageId = await newPageViaUi(page, "Assistant context page");
      const note = await alice.api("/api/blocks", { method: "POST", body: { parent_id: pageId, content: "The exact note to discuss" } });
      await page.reload();
      await until(() => new URL(page.url()).searchParams.get("block") === pageId);
      const url = new URL(page.url());
      assertEq(url.searchParams.get("block"), pageId);
      assertEq(url.searchParams.get("ws"), alice.ws);
      assert(!url.searchParams.has("share"));
      assertEq((await alice.api(`/api/share-settings/${pageId}`)).token, null, "reading a browser URL needs no share");
      const result = await readLink(url.href);
      assertEq(result.structuredContent.page_id, pageId);
      assert(result.content[0].text.includes("The exact note to discuss"));
      await page.locator(`.sortableBlockWrap[data-block-id="${note.id}"] .dragHandle`).first().click();
      await page.getByText("Copy link to block", { exact: true }).click();
      const noteUrl = new URL(await page.evaluate(() => navigator.clipboard.readText()));
      assertEq(noteUrl.searchParams.get("block"), note.id);
      assertEq((await readLink(noteUrl.href)).structuredContent.block_id, note.id);
      const share = await alice.api(`/api/share/${pageId}`, { method: "POST" });
      assertEq((await readLink(`${server.base}/?share=${share.token}`)).structuredContent.page_id, pageId);
      assertNoProblems(page);
    } finally {
      await ctx.close();
      await alice.api(`/api/integrations/tokens/${credential.id}`, { method: "DELETE" });
    }
  });

}
