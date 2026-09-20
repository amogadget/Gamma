// Clones (docs/dev/mirror.md): Settings → Workspaces → Clones. The server
// clones one of its own workspaces over its real HTTP API with a write
// token made through the API: the dialog, the row and its status, Pull &
// push, the (empty) conflicts list, opening the clone, the sync pill with
// its settings (cadence, detach, reattach), a merge conflict resolved on its
// block, removing the origin.
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

  await step("mirror: clone a workspace from Settings, sync it, open it, resolve a conflict, remove its origin", async () => {
    const ctx = await user.context(browser);
    try {
      const page = await openPage(ctx, server.base);
      await page.waitForSelector(".folderNewBtn");
      await page.getByRole("button", { name: "Account & settings", exact: true }).click();
      await page.getByRole("button", { name: "Settings…", exact: true }).click();
      await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
      await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Workspaces", exact: true }).click();
      await page.getByText("No clones yet.", { exact: true }).waitFor();

      await page.getByRole("button", { name: "Clone a remote workspace", exact: true }).click();
      const dlg = page.getByRole("dialog", { name: "Clone a remote workspace", exact: true });
      await dlg.waitFor();
      await dlg.locator("input").nth(0).fill(server.base);
      await dlg.locator("input").nth(1).fill(token.token);
      await dlg.locator("input").nth(2).fill("My clone");
      await dlg.getByRole("button", { name: "Clone", exact: true }).click();
      const row = page.locator(".aiProvRow", { hasText: "clone of" });
      await row.waitFor();
      assert((await row.textContent()).includes("My clone"), "the row carries the chosen name");

      // Sync runs a round inline; the status line then says when.
      await row.getByRole("button", { name: "Sync", exact: true }).click();
      await until(() => row.locator(".aiProvDesc").last().textContent().then((t) => /up to date \d/.test(t)),
        { timeout: 20000, what: "the row reports a sync" });
      const mirrors = await user.api("/api/mirrors");
      assertEq(mirrors.mirrors.length, 1);
      const copy = mirrors.mirrors[0];
      assert(!copy.status.last_error, `no sync error: ${copy.status.last_error}`);
      const r = await fetch(`${server.base}/api/blocks/${paper.id}/subtree`, { headers: user.headers({ "X-Gamma-Workspace": copy.workspace_id }) });
      assertEq(r.status, 200, "the clone holds the page under the same id");
      const tree = await r.json();
      assertEq(tree.block.children[0]?.content, "a note to copy");

      await row.getByRole("button", { name: /^Conflicts/ }).click();
      await page.getByText("No conflicts", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await row.waitFor();

      // Open moves the tab to the clone: the library shows the cloned page.
      await row.getByRole("button", { name: "Open", exact: true }).click();
      await until(() => Promise.resolve(new URL(page.url()).searchParams.get("ws") === copy.workspace_id), { what: "the clone is open" });
      await page.waitForSelector(".folderNewBtn", { timeout: 15000 });
      await page.getByText("Mirrored paper", { exact: true }).first().waitFor();
      // the header's sync pill: the state drawn on the icon, the log in the popover
      const pill = page.getByRole("button", { name: "Sync status", exact: true });
      await until(() => pill.getAttribute("data-state").then((t) => t === "ok"), { what: "the pill reports the sync" });
      assertEq(await pill.locator(".mirrorPillDot.ok").count(), 1, "a green dot: up to date");
      await pill.click();
      const pop = page.getByRole("dialog", { name: "Sync status", exact: true });
      await pop.getByText("Log", { exact: true }).waitFor();
      await pop.getByText("Mirrored paper", { exact: true }).waitFor();
      // the row carries its git-style counts: the page came whole with one block
      assertEq(await pop.locator(".mirrorDiff .add").first().textContent(), "+1", "the log row shows +1 block");
      // and opens to the changes themselves: the block that was added
      await pop.getByText("Mirrored paper", { exact: true }).click();
      await pop.locator(".mirrorChange.add", { hasText: "a note to copy" }).waitFor();
      await pop.getByRole("button", { name: "Sync", exact: true }).click();
      await until(() => pop.textContent().then((t) => /Up to date/.test(t) && !/Syncing/.test(t)), { timeout: 20000, what: "the popover settles after Sync" });
      // the sync settings live in the popover: cadence, detach, reattach
      await pop.getByRole("button", { name: "Sync settings", exact: true }).click();
      await pop.getByText("Sync settings", { exact: true }).waitFor();
      await pop.getByRole("button", { name: "Manual", exact: true }).click();
      await until(() => user.api(`/api/mirrors/${copy.workspace_id}`).then((m) => m.poll_s === 0), { what: "the cadence is saved" });
      await pop.getByRole("button", { name: "Detach", exact: true }).click();
      await until(() => pill.getAttribute("data-state").then((t) => t === "detached"), { what: "the pill reads detached" });
      assertEq((await user.api(`/api/mirrors/${copy.workspace_id}`)).mode, "off");
      await pop.getByRole("button", { name: "Reattach", exact: true }).click();
      await until(() => pill.getAttribute("data-state").then((t) => t === "ok"), { timeout: 20000, what: "reattached and synced" });
      await pop.getByRole("button", { name: "Back", exact: true }).click();
      await pop.getByRole("button", { name: "Open the page", exact: true }).first().click();
      await page.getByRole("paragraph").filter({ hasText: "a note to copy" }).first().waitFor();
      assertNoProblems(page);
      // a same-block edit on both sides: the conflict chip on the row resolves it in place
      await user.api(`/api/pages/${paper.id}/ops`, { method: "POST", body: { client: "e2e", ops: [
        { op: "set", id: "mirrorblk1", content: "a note to copy (original)" }] } });
      const r2 = await fetch(`${server.base}/api/pages/${paper.id}/ops`, { method: "POST",
        headers: user.headers({ "X-Gamma-Workspace": copy.workspace_id, "Content-Type": "application/json" }),
        body: JSON.stringify({ client: "e2e", ops: [{ op: "set", id: "mirrorblk1", content: "(copy) a note to copy" }] }) });
      assertEq(r2.status, 200, "the clone's edit");
      await user.api(`/api/mirrors/${copy.workspace_id}/sync?wait=1`, { method: "POST" });
      // the round ran outside the page (as the loop's would): the chip shows up on the pill's next glance
      await until(() => page.locator(".mergeChip").count().then((n) => n === 1), { timeout: 40000, what: "the merged block carries a chip" });
      await page.locator(".mergeChip").click();
      const merge = page.getByRole("dialog", { name: "Merge", exact: true });
      await merge.getByText("Auto-merged", { exact: true }).waitFor();
      // local and remote side by side as what each changed against the base, the merged text under them, Keep on the current one
      assert((await merge.locator("mark.merge-mine").count()) >= 1 && (await merge.locator("mark.merge-theirs").count()) >= 1, "both sides coloured");
      assertEq(await merge.locator(".mergeVersion").count(), 3, "local, remote and the merged text");
      assertEq((await merge.locator(".mergeVersion.mine mark.merge-mine").first().textContent()).trim(), "(copy)", "local added '(copy)' at the front");
      assertEq((await merge.locator(".mergeVersion.theirs mark.merge-theirs").first().textContent()).trim(), "(original)", "remote added '(original)' at the end");
      assert(await merge.getByRole("radio", { name: "Merged", exact: true }).isChecked(), "the merged text, being in the block, is preselected");
      assertEq(await merge.locator(".mergeNav").count(), 0, "one conflict: nothing to step through");
      await merge.getByRole("radio", { name: "Remote", exact: true }).check();
      await merge.getByRole("button", { name: "Apply", exact: true }).click();
      await until(() => page.locator(".mergeChip").count().then((n) => n === 0), { what: "the chip goes once resolved" });
      await page.getByRole("paragraph").filter({ hasText: "a note to copy (original)" }).first().waitFor();
      assertEq((await user.api(`/api/mirrors/${copy.workspace_id}`)).conflicts_open, 0);
      assertNoProblems(page);

      // Remove origin (the row's "more" menu, then the confirm) keeps the workspace, drops the mirror.
      await page.getByRole("button", { name: "Account & settings", exact: true }).click();
      await page.getByRole("button", { name: "Settings…", exact: true }).click();
      await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
      await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Workspaces", exact: true }).click();
      await page.locator(".aiProvRow", { hasText: "clone of" }).getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("button", { name: "Remove origin", exact: true }).click(); // the menu row
      await page.getByRole("button", { name: "Remove origin", exact: true }).click(); // the confirm
      await page.getByText("No clones yet.", { exact: true }).waitFor();
      assertEq((await user.api("/api/mirrors")).mirrors.length, 0);
      assert((await user.api("/api/workspaces/mine")).workspaces.some((w) => w.id === copy.workspace_id), "the workspace stays");
      assertNoProblems(page);
    } finally {
      await ctx.close();
    }
  });
}
