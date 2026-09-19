// Offline copies (docs/dev/mirror.md): Settings → Workspaces → Offline
// copies. The server mirrors one of its own workspaces over its real HTTP
// API with a write token made through the API: the dialog, the row and its
// status, Sync now, the (empty) merges list, opening the copy, stopping it.
import { Account } from "../harness.mjs";

export async function mirrorScenarios(env) {
  const { server, browser, step, openPage, assert, assertEq, assertNoProblems, until, flags } = env;
  if (flags.only && !"mirror".includes(flags.only)) return;
  server.manage("create-user", "mirror-user", "mirror-pw");
  const user = await new Account(server, "mirror-user", "mirror-pw").login();
  const paper = await user.api("/api/pages", { method: "POST", body: { title: "Mirrored paper" } });
  await user.api(`/api/pages/${paper.id}/ops`, { method: "POST", body: { client: "e2e", ops: [
    { op: "insert", id: "mirrorblk1", parent: paper.id, position: "a0", content: "a note to copy" }] } });
  const token = await user.api("/api/integrations/tokens", { method: "POST", body: { name: "e2e mirror", scope: "write" } });

  await step("mirror: make an offline copy from Settings, sync it, open it, stop it", async () => {
    const ctx = await user.context(browser);
    try {
      const page = await openPage(ctx, server.base);
      await page.waitForSelector(".folderNewBtn");
      await page.getByRole("button", { name: "Account & settings", exact: true }).click();
      await page.getByRole("button", { name: "Settings…", exact: true }).click();
      await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
      await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Workspaces", exact: true }).click();
      await page.getByText("No offline copies yet.", { exact: true }).waitFor();

      await page.getByRole("button", { name: "Mirror a remote workspace", exact: true }).click();
      const dlg = page.getByRole("dialog", { name: "Mirror a remote workspace", exact: true });
      await dlg.waitFor();
      await dlg.locator("input").nth(0).fill(server.base);
      await dlg.locator("input").nth(1).fill(token.token);
      await dlg.locator("input").nth(2).fill("My offline copy");
      await dlg.getByRole("button", { name: "Start mirroring", exact: true }).click();
      const row = page.locator(".aiProvRow", { hasText: "copy of" });
      await row.waitFor();
      assert((await row.textContent()).includes("My offline copy"), "the row carries the chosen name");

      // Sync now runs a round inline; the status line then says when.
      await row.getByRole("button", { name: "Sync now", exact: true }).click();
      await until(() => row.locator(".aiProvDesc").last().textContent().then((t) => /up to date \d/.test(t)),
        { timeout: 20000, what: "the row reports a sync" });
      const mirrors = await user.api("/api/mirrors");
      assertEq(mirrors.mirrors.length, 1);
      const copy = mirrors.mirrors[0];
      assert(!copy.status.last_error, `no sync error: ${copy.status.last_error}`);
      const r = await fetch(`${server.base}/api/blocks/${paper.id}/subtree`, { headers: user.headers({ "X-Gamma-Workspace": copy.workspace_id }) });
      assertEq(r.status, 200, "the copy holds the page under the same id");
      const tree = await r.json();
      assertEq(tree.block.children[0]?.content, "a note to copy");

      await row.getByRole("button", { name: /^Merges/ }).click();
      await page.getByText("Nothing to decide", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await row.waitFor();

      // Open moves the tab to the copy: the library shows the mirrored page.
      await row.getByRole("button", { name: "Open", exact: true }).click();
      await until(() => Promise.resolve(new URL(page.url()).searchParams.get("ws") === copy.workspace_id), { what: "the copy is open" });
      await page.waitForSelector(".folderNewBtn", { timeout: 15000 });
      await page.getByText("Mirrored paper", { exact: true }).first().waitFor();
      // the header's sync pill: state at a glance, recent changes in the popover
      const pill = page.getByRole("button", { name: "Sync status", exact: true });
      await until(() => pill.textContent().then((t) => /up to date/.test(t)), { what: "the pill reports the sync" });
      await pill.click();
      const pop = page.getByRole("dialog", { name: "Sync status", exact: true });
      await pop.getByText("Recent changes", { exact: true }).waitFor();
      await pop.getByText("Mirrored paper", { exact: true }).waitFor();
      await pop.getByRole("button", { name: "Sync now", exact: true }).click();
      await until(() => pop.textContent().then((t) => /Up to date/.test(t) && !/Syncing/.test(t)), { timeout: 20000, what: "the popover settles after Sync now" });
      assert((await pop.textContent()).includes("Checks again every"), "the popover says how often it checks");
      await pop.getByText("Mirrored paper", { exact: true }).click();
      await page.getByText("a note to copy", { exact: true }).waitFor();
      assertNoProblems(page);

      // Stop keeps the workspace, drops the mirror.
      await page.getByRole("button", { name: "Account & settings", exact: true }).click();
      await page.getByRole("button", { name: "Settings…", exact: true }).click();
      await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
      await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Workspaces", exact: true }).click();
      await page.locator(".aiProvRow", { hasText: "copy of" }).getByRole("button", { name: "Stop", exact: true }).click();
      await page.getByRole("button", { name: "Stop mirroring", exact: true }).click();
      await page.getByText("No offline copies yet.", { exact: true }).waitFor();
      assertEq((await user.api("/api/mirrors")).mirrors.length, 0);
      assert((await user.api("/api/workspaces/mine")).workspaces.some((w) => w.id === copy.workspace_id), "the workspace stays");
      assertNoProblems(page);
    } finally {
      await ctx.close();
    }
  });
}
