// Browser end-to-end suite: drives the built app (frontend/dist) served by an
// ISOLATED backend over a throwaway data dir, through Playwright's Chromium.
//
//   npm run e2e                 # everything (build first: npm run build)
//   npm run e2e -- --only pdf   # steps whose name contains "pdf"
//   npm run e2e -- --continue   # keep going after a failure
//   npm run e2e -- --headed     # watch it
//   npm run e2e -- --keep       # leave the temp data dir + server.log behind
//
// One line per step and a summary; exit 1 on any failure. Each step asserts
// both the visible outcome AND that no API call failed, no console error and
// no page error happened meanwhile (harness.openPage records them).
import {
  Account, Server, assert, assertEq, assertNoProblems, flags, launchBrowser, makePdf,
  openPage, results, sleep, step, until,
} from "./harness.mjs";
import { noteScenarios } from "./scenarios/notes.mjs";
import { mermaidScenarios } from "./scenarios/mermaid.mjs";
import { pdfScenarios } from "./scenarios/pdf.mjs";
import { fileScenarios } from "./scenarios/files.mjs";
import { collabScenarios } from "./scenarios/collab.mjs";
import { shareScenarios } from "./scenarios/share.mjs";
import { settingsScenarios } from "./scenarios/settings.mjs";
import { mcpScenarios } from "./scenarios/mcp.mjs";
import { mirrorScenarios } from "./scenarios/mirror.mjs";
import { mentionScenarios } from "./scenarios/mentions.mjs";
import { chatNavigationScenarios } from "./scenarios/chatNavigation.mjs";
import { transferScenarios } from "./scenarios/transfers.mjs";
import { inkScenarios } from "./scenarios/ink.mjs";
import { guideScenarios } from "./scenarios/guide.mjs";
import { contextualGuideScenarios } from "./scenarios/contextualGuide.mjs";
import { inkEditingScenarios } from "./scenarios/inkEditing.mjs";
import { pdfLoadScenarios } from "./scenarios/pdfload.mjs";
import { pdfTouchScenarios } from "./scenarios/pdfTouch.mjs";
import { nativeScenarios } from "./scenarios/nativeInk.mjs";
import { blankPdfScenarios } from "./scenarios/blankPdf.mjs";
import { ipadScenarios } from "./scenarios/ipad.mjs";
import { quickOpenScenarios } from "./scenarios/quickOpen.mjs";
import { cloudSignInScenarios } from "./scenarios/cloudSignIn.mjs";

const server = new Server();
let browser;
try {
  console.log("starting isolated backend...");
  await server.start();
  console.log(`  ${server.base}  data: ${server.dataDir}`);
  server.manage("create-user", "alice", "alice-pw");
  server.manage("create-user", "bob", "bob-pw");
  const alice = await new Account(server, "alice", "alice-pw").login();
  const bob = await new Account(server, "bob", "bob-pw").login();
  browser = await launchBrowser();

  const env = { server, browser, alice, bob, makePdf, step, until, sleep, assert, assertEq, assertNoProblems, openPage, flags };

  await step("workspaces: an unavailable explicit workspace never falls back to another library", async () => {
    const ctx = await alice.context(browser);
    const page = await openPage(ctx, `${server.base}/?ws=unavailable-workspace`);
    await page.getByText("This workspace is unavailable", { exact: true }).waitFor();
    assert(new URL(page.url()).searchParams.get("ws") === "unavailable-workspace", "the requested workspace stays in the URL");
    assert((await page.$$(".folderNewBtn")).length === 0, "no fallback library is opened");
    assertNoProblems(page);
    await page.getByRole("button", { name: "Open my workspaces" }).click();
    await page.waitForSelector(".folderNewBtn", { timeout: 15000 });
    assertNoProblems(page);
    await ctx.close();
  });

  await step("auth: login page, wrong password, then sign in", async () => {
    const ctx = await browser.newContext();
    const page = await openPage(ctx, `${server.base}/`);
    await page.waitForSelector(".loginInput");
    await page.fill(".loginInput >> nth=0", "alice");
    await page.fill("input[type=password]", "nope");
    await page.click(".loginBtn");
    await page.waitForSelector(".loginError");
    await page.fill("input[type=password]", "alice-pw");
    await page.click(".loginBtn");
    await page.waitForSelector(".folderNewBtn", { timeout: 15000 });
    assertNoProblems(page, [/401/]);
    await ctx.close();
  });

  await step("auth: guest login lands on the welcome page", async () => {
    const ctx = await browser.newContext();
    const page = await openPage(ctx, `${server.base}/`);
    await page.waitForSelector(".loginGuestBtn");
    await page.click(".loginGuestBtn");
    await page.waitForSelector(".folderNewBtn, .cm-content, .blockRow", { timeout: 15000 });
    assertNoProblems(page);
    await ctx.close();
  });

  await settingsScenarios(env);
  await mcpScenarios(env);
  await cloudSignInScenarios(env);
  await mirrorScenarios(env);
  await mentionScenarios(env);
  await quickOpenScenarios(env);
  await chatNavigationScenarios(env);
  await transferScenarios(env);
  await mermaidScenarios(env);
  const notes = await noteScenarios(env);
  const pdf = await pdfScenarios(env, notes);
  await inkScenarios(env);
  await guideScenarios(env);
  await contextualGuideScenarios(env);
  await inkEditingScenarios(env);
  await pdfLoadScenarios(env);
  await pdfTouchScenarios(env);
  await ipadScenarios(env);
  await fileScenarios(env);
  await collabScenarios(env);
  await shareScenarios(env, { ...notes, ...pdf });
  await nativeScenarios(env);
  await blankPdfScenarios(env);
} catch (e) {
  if (!results.length || results[results.length - 1].ok) console.log(`\nsetup failed: ${e.stack || e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed${failed.length ? `; failed: ${failed.map((f) => f.name).join(", ")}` : ""}`);
process.exit(failed.length || !results.length ? 1 : 0);
