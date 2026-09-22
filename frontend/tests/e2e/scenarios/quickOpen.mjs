import { Account } from "../harness.mjs";

// Ctrl+P: the quick-open page palette (library/QuickOpen.jsx).
export async function quickOpenScenarios(env) {
  const { server, browser, step, openPage, assert, assertEq, assertNoProblems, until, flags } = env;
  if (flags.only && !"quickopen".includes(flags.only)) return;
  server.manage("create-user", "quickopen-user", "quickopen-pw");
  const user = await new Account(server, "quickopen-user", "quickopen-pw").login();
  const titles = ["Cavity readout", "Cavity sensors", "Quantum correction", "Atomic clocks"];
  const papers = {};
  for (const title of titles) {
    papers[title] = await user.api("/api/blocks", { method: "POST", body: { parent_id: "root", content: title } });
  }

  await step("quickopen: Ctrl+P lists pages, filters by title and opens the pick", async () => {
    const ctx = await user.context(browser);
    const page = await openPage(ctx, `${server.base}/?page=${papers["Atomic clocks"].id}&ws=${user.ws}`);
    try {
      await page.locator(".blockList").first().waitFor();
      await page.keyboard.press("Control+p");
      const dialog = page.getByRole("dialog", { name: "Open a page" });
      await dialog.waitFor();
      const input = dialog.getByRole("textbox", { name: "Search pages by title" });
      await until(() => input.evaluate((el) => el === document.activeElement), { what: "the palette's input takes focus" });
      await until(async () => (await dialog.getByRole("option").count()) === titles.length, { what: "every page listed before typing" });
      assert(await dialog.getByRole("option", { name: /Atomic clocks/ }).locator(".quickOpenTag").textContent() === "Current",
        "the open page is tagged Current");

      await input.fill("cavity");
      await until(async () => (await dialog.getByRole("option").count()) === 2);
      await page.keyboard.press("ArrowDown");
      const picked = await dialog.locator('[role="option"][aria-selected="true"] strong').textContent();
      await page.keyboard.press("Enter");
      await until(() => new URL(page.url()).searchParams.get("block") === papers[picked].id);
      assertEq(await page.getByRole("dialog", { name: "Open a page" }).count(), 0, "opening closes the palette");

      await page.keyboard.press("Control+p");
      await dialog.waitFor();
      await page.keyboard.press("Escape");
      assertEq(await page.getByRole("dialog", { name: "Open a page" }).count(), 0, "Escape closes the palette");
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });
}
