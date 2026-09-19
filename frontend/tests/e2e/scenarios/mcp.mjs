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
        await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Administration", exact: true }).click();
        await page.getByRole("textbox", { name: "Public server URL", exact: true }).waitFor();
      };
      await openServer();
      const address = page.getByRole("textbox", { name: "Public server URL", exact: true });
      await until(() => address.inputValue().then((v) => v === server.base));
      assertEq((await admin.api("/api/admin/settings")).public_url, "", "suggestion is not implicitly trusted");
      await page.getByRole("button", { name: "Confirm address", exact: true }).click();
      await until(() => admin.api("/api/admin/settings").then((v) => v.public_url === server.base));
      await address.fill("https://draft.example");
      await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Users", exact: true }).click();
      await page.getByRole("button", { name: "Keep editing", exact: true }).click();
      await page.getByRole("button", { name: "Cancel address changes", exact: true }).click();
      assertEq(await address.inputValue(), server.base);
      await page.reload();
      await openServer();
      await until(() => address.inputValue().then((v) => v === server.base));
      assert(await page.getByRole("button", { name: "Save address", exact: true }).isDisabled());
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

  await step("mcp: sandboxed paper picker searches, paginates and hands off an exact selection", async () => {
    const ctx = await alice.context(browser);
    const credential = await alice.api("/api/integrations/tokens", { method: "POST", body: { name: "Picker browser test" } });
    const rpc = async (method, params) => {
      const response = await fetch(`${server.base}/mcp`, { method: "POST", headers: {
        Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      assertEq(response.status, 200);
      const body = await response.json();
      assert(!body.error, JSON.stringify(body.error));
      return body.result;
    };
    try {
      for (let i = 0; i < 22; i++) await alice.api("/api/blocks", { method: "POST", body: { parent_id: "root", content: `Picker browser ${i}` } });
      const title = '<img src=x onerror="alert(1)"> Picker chosen paper';
      const paper = await alice.api("/api/blocks", { method: "POST", body: { parent_id: "root", content: title } });
      const initial = await rpc("tools/call", { name: "show_paper_picker", arguments: { query: "Picker" } });
      const html = (await rpc("resources/read", { uri: "ui://gamma/paper-picker-v1.html" })).contents[0].text;
      // Simulate only the host bridge; every tool call goes through the real
      // authenticated MCP endpoint. No credential is passed into the iframe.
      await ctx.exposeBinding("pickerCall", (_, params) => rpc("tools/call", params));
      await ctx.route("**/picker-test-host", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Picker test host</title><style>body{margin:0}iframe{width:100%;height:650px;border:0}</style>' }));
      const page = await openPage(ctx, `${server.base}/picker-test-host`);
      await page.evaluate(({ html, initial }) => {
        window.messages = [];
        const frame = document.createElement("iframe"); frame.title = "Gamma paper picker";
        frame.setAttribute("sandbox", "allow-scripts");
        window.addEventListener("message", async (event) => {
          if (event.source !== frame.contentWindow) return;
          const { id, method, params } = event.data;
          let result = {};
          if (method === "ui/initialize") result = { protocolVersion: "2026-01-26", hostCapabilities: { serverTools: {} }, hostContext: { theme: "light" } };
          else if (method === "ui/notifications/initialized") {
            frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: initial }, "*"); return;
          } else if (method === "tools/call") result = await window.pickerCall(params);
          else if (method === "ui/message") {
            // Enforce the real host's content-array contract. An object here
            // caused the validation failure reported from ChatGPT desktop.
            if (!Array.isArray(params.content) || params.content.length !== 1 || params.content[0].type !== "text") {
              frame.contentWindow.postMessage({ jsonrpc: "2.0", id, error: { code: -32602, message: 'Expected array at params.content' } }, "*"); return;
            }
            if (window.denyMessage) {
              frame.contentWindow.postMessage({ jsonrpc: "2.0", id, error: { code: -32000, message: '[{"code":"invalid_type","path":["params","content"]}]' } }, "*"); return;
            }
            if (window.messageResultError) result = { isError: true };
            else
            window.messages.push(params);
          }
          if (id !== undefined) frame.contentWindow.postMessage({ jsonrpc: "2.0", id, result }, "*");
        });
        frame.srcdoc = html; document.body.append(frame);
      }, { html, initial });
      const picker = page.frameLocator('iframe[title="Gamma paper picker"]');
      await picker.getByText("1–20 of 23 papers and notes", { exact: true }).waitFor();
      assertEq(await picker.locator("#results img").count(), 0, "paper titles cannot inject HTML");
      assert(await picker.getByRole("img", { name: "Gamma", exact: true }).evaluate((img) => img.complete && img.naturalWidth === 512), "Gamma icon loads without a network request");
      await picker.getByRole("button", { name: "Next", exact: true }).click();
      await picker.getByText("21–23 of 23 papers and notes", { exact: true }).waitFor();
      await picker.getByRole("searchbox").fill("absent title");
      await picker.getByRole("button", { name: "Search", exact: true }).click();
      await picker.getByText("No matching titles. Try fewer words.").waitFor();
      await picker.getByRole("searchbox").fill("chosen");
      await picker.getByRole("button", { name: "Search", exact: true }).click();
      await picker.getByRole("button", { name: title, exact: false }).click();
      assert(!(await picker.locator("#pagination").isVisible()), "no pagination for a single result");
      assert(!(await picker.locator("#results").innerText()).includes(paper.id), "unique titles do not show opaque IDs");
      await page.evaluate(() => { window.denyMessage = true; });
      await picker.getByRole("button", { name: "Use this paper" }).click();
      const fallback = picker.getByRole("textbox", { name: "Selected paper reference" });
      await fallback.waitFor();
      assert((await fallback.inputValue()).includes(paper.id));
      assert(!(await picker.locator("body").innerText()).includes("invalid_type"), "raw host errors stay out of the UI");
      await page.evaluate(() => { window.denyMessage = false; });
      await page.evaluate(() => { window.messageResultError = true; });
      await picker.getByRole("button", { name: "Use this paper" }).click();
      await picker.getByText("Could not add the paper to chat. Try again, or copy the reference below.").waitFor();
      assertEq(await page.evaluate(() => window.messages.length), 0, "result-level errors do not confirm a selection");
      await page.evaluate(() => { window.messageResultError = false; });
      await picker.getByRole("textbox", { name: "Question about the selected paper" }).fill("What are its main findings?");
      await picker.getByRole("button", { name: "Ask about this paper", exact: true }).click();
      await until(() => page.evaluate(() => window.messages.length === 1));
      const message = await page.evaluate(() => window.messages[0]);
      assertEq(message.role, "user"); assertEq(message.content[0].type, "text");
      const text = message.content[0].text;
      const selection = new URL(text.split("\n")[1]);
      assertEq(selection.searchParams.get("page"), paper.id); assertEq(selection.searchParams.get("ws"), alice.ws);
      assert(text.includes(JSON.stringify(title)));
      assert(text.endsWith("What are its main findings?"));
      assert(!text.includes(credential.token));
      await picker.getByRole("button", { name: "Choose another paper" }).waitFor();
      assert(!(await picker.locator("#chooser").isVisible()), "sent selection collapses the picker");
      await picker.getByRole("button", { name: "Choose another paper" }).click();
      assert(await picker.getByRole("searchbox").isVisible(), "picker can reopen after selection");
      assertEq(await picker.getByRole("textbox", { name: "Question about the selected paper" }).inputValue(), "");
      if (process.env.GAMMA_MCP_SCREENSHOTS) {
        fs.mkdirSync(process.env.GAMMA_MCP_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.GAMMA_MCP_SCREENSHOTS, "picker-desktop.png") });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(process.env.GAMMA_MCP_SCREENSHOTS, "picker-mobile.png") });
        assert(await picker.locator("body").evaluate(() => document.documentElement.scrollWidth <= innerWidth), "picker fits mobile width");
      }
      assertNoProblems(page);
    } finally {
      await ctx.close();
      await alice.api(`/api/integrations/tokens/${credential.id}`, { method: "DELETE" });
    }
  });
}
