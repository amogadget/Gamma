// Sign in with Gamma Cloud (docs/dev/cloud_accounts.md): the admin turns it
// on under Settings → Server → Sign-in, the login page grows the button, and
// an account sees its link row. The round trip through a real account server
// is covered by backend/tests/test_cloud_auth.py; here the browser is never
// sent there (the button's target is asserted, not followed).
import { Account } from "../harness.mjs";

export async function cloudSignInScenarios(env) {
  const { server, browser, step, openPage, assert, assertEq, assertNoProblems, until, flags } = env;
  if (flags.only && !"cloud".includes(flags.only)) return;
  server.manage("create-user", "cloud-admin", "cloud-admin-pw");
  server.manage("set-admin", "cloud-admin", "on");
  const admin = await new Account(server, "cloud-admin", "cloud-admin-pw").login();
  const settingsNav = (page, name) => page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name, exact: true });
  async function openSettings(page, pane) {
    await page.getByRole("button", { name: "Account & settings", exact: true }).click();
    await page.getByRole("button", { name: "Settings…", exact: true }).click();
    await settingsNav(page, pane).click();
  }

  await step("cloud sign-in: the admin turns it on and the login page offers it", async () => {
    const ctx = await admin.context(browser);
    try {
      const page = await openPage(ctx, server.base);
      await openSettings(page, "Server");
      const issuer = page.getByRole("textbox", { name: "Account server", exact: true });
      await issuer.waitFor();
      assertEq((await admin.api("/api/admin/settings")).cloud.enabled, false, "off until an admin sets it");
      const chip = (text) => page.locator(".settingsPane .uiTag").filter({ hasText: new RegExp(`^${text}$`) }).first();
      await chip("off").waitFor();
      await issuer.fill("https://account.example");
      await page.getByRole("button", { name: "Claim", exact: true }).click();
      await page.getByRole("button", { name: "Save sign-in", exact: true }).click();
      await until(() => admin.api("/api/admin/settings").then((v) => v.cloud.enabled && v.cloud.policy === "claim"));
      await chip("on").waitFor();
      // the account pane offers the link
      await settingsNav(page, "Account").click();
      await page.getByRole("button", { name: "Link Gamma Cloud account", exact: true }).waitFor();
      await assertNoProblems(page);
      // a signed-out visitor sees the button, aimed at this server's start endpoint
      const anon = await browser.newContext();
      try {
        const login = await openPage(anon, server.base);
        const button = login.getByRole("link", { name: "Sign in with Gamma Cloud", exact: true });
        await button.waitFor();
        const href = await button.getAttribute("href");
        assert(href.startsWith("/api/auth/cloud/start?next="), `the button starts the flow here (${href})`);
        // a refused sign-in comes back as a message on this page
        await login.goto(`${server.base}/?cloud_error=${encodeURIComponent("Sign-in cancelled.")}`);
        await login.getByRole("alert").filter({ hasText: "Sign-in cancelled." }).waitFor();
        assert(!login.url().includes("cloud_error"), "the message is dropped from the address bar");
        await assertNoProblems(login);
      } finally { await anon.close(); }
      // turning it off removes the button
      await admin.api("/api/admin/settings", { method: "PUT", body: { cloud_issuer: "" } });
      const anon2 = await browser.newContext();
      try {
        const login = await openPage(anon2, server.base);
        await login.getByPlaceholder("Username").waitFor();
        assertEq(await login.getByRole("link", { name: "Sign in with Gamma Cloud", exact: true }).count(), 0, "no button when off");
      } finally { await anon2.close(); }
    } finally { await ctx.close(); }
  });
}
