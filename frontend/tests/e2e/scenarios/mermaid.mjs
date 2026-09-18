import { readFile } from "node:fs/promises";
import { closeEditor, newPageViaUi } from "./notes.mjs";

const flow = 'flowchart LR\n  A["Start $a|b$ \\(x\\)"] --> B[Finish]';
const sequence = "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi";
const fence = (source) => "```mermaid\n" + source + "\n```";

export async function mermaidScenarios(env) {
  const { server, browser, alice, step, until, assert, assertEq, assertNoProblems, openPage } = env;
  await step("mermaid: notes, slash command, source, SVG, themes and Markdown round trip", async () => {
    const imported = await alice.upload("/api/import/markdown", Buffer.from(
      [fence(flow), fence(sequence), fence("this is not a diagram"), "```js\nconst normal = 1;\n```"].join("\n\n"),
    ), "Mermaid.md", "text/markdown");
    const ctx = await alice.context(browser, { permissions: ["clipboard-read", "clipboard-write"] });
    const page = await openPage(ctx, `${server.base}/?ws=${alice.ws}&block=${imported.block_id}`);
    try {
      await until(async () => await page.locator(".mermaidPreview svg").count() === 2);
      await page.locator(".mermaidError").waitFor();
      assert((await page.locator(".mermaidError").innerText()).includes("Could not render diagram"));
      assertEq(await page.locator(".codeBlock code").innerText(), "const normal = 1;");
      const diagrams = page.locator(".mermaidDiagram");
      const first = diagrams.first();
      assertEq(await first.getAttribute("data-mermaid-source"), flow);
      const ids = await page.locator(".mermaidPreview > svg").evaluateAll((els) => els.map((el) => el.id));
      assertEq(new Set(ids).size, 2, "SVG IDs are unique");
      await first.getByRole("button", { name: "Copy source", exact: true }).click();
      assertEq((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), flow);
      assertEq(await page.locator(".blockEditorCm").count(), 0, "toolbar does not start editing");
      await first.getByRole("button", { name: "Source", exact: true }).click();
      assertEq(await first.locator(".mermaidSource").innerText(), flow);
      await first.getByRole("button", { name: "Source", exact: true }).click();
      const downloadEvent = page.waitForEvent("download");
      await first.getByRole("button", { name: "Download SVG", exact: true }).click();
      const download = await downloadEvent;
      const svg = await readFile(await download.path(), "utf8");
      assert(svg.includes("<svg") && svg.includes("Finish"), "SVG download contains the diagram");

      const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme);
      for (const theme of initialTheme === "light" ? ["dark", "light"] : ["light", "dark"]) {
        const oldId = await first.locator("svg").getAttribute("id");
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await until(async () => {
          const id = await first.locator("svg").getAttribute("id").catch(() => null);
          return id && id !== oldId;
        });
        assertEq(await first.getAttribute("data-mermaid-theme"), theme === "light" ? "default" : "dark");
      }
      const copied = await first.evaluate((el) => {
        const range = document.createRange(); range.selectNode(el);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        const clipboardData = new DataTransfer();
        el.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, clipboardData }));
        selection.removeAllRanges();
        return clipboardData.getData("text/plain");
      });
      assertEq(copied, fence(flow), "selection copy recovers the Markdown fence");
      const exported = await alice.api(`/api/pages/${imported.block_id}/export?mode=readable`, { raw: true });
      const again = await alice.upload("/api/import/markdown", Buffer.from(await exported.text()), "Roundtrip.md", "text/markdown");
      const tree = await alice.api(`/api/blocks/${again.block_id}/subtree`);
      const contents = (block) => [block.content, ...(block.children || []).flatMap(contents)];
      assert(contents(tree.block).includes(fence(flow)), "Markdown export/import preserves source");

      if (process.env.GAMMA_MERMAID_SCREENSHOT) await page.screenshot({ path: process.env.GAMMA_MERMAID_SCREENSHOT });
      await page.goto(`${server.base}/?ws=${alice.ws}`);
      await newPageViaUi(page, "Mermaid starter");
      await page.keyboard.type("/mermaid");
      await page.getByRole("button", { name: /Mermaid diagram/ }).click();
      await page.waitForFunction(() => window.getSelection()?.toString() === "Start", null, { timeout: 5000 });
      await page.keyboard.insertText("Begin");
      await closeEditor(page);
      await page.locator(".mermaidPreview").filter({ hasText: "Begin" }).waitFor();
      await page.locator(".mermaidPreview").click();
      await page.locator(".blockEditorCm .cm-content").waitFor();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.insertText(fence("flowchart LR\n  A[Edited] --> B[Saved]"));
      await closeEditor(page);
      await page.locator(".mermaidPreview").filter({ hasText: "Edited" }).waitFor();
      await page.reload();
      await page.locator(".mermaidPreview").filter({ hasText: "Edited" }).waitFor();
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("mermaid: chat waits for closing fence and recovers from invalid diagrams", async () => {
    const ctx = await alice.context(browser);
    await alice.api("/api/chats/home", { method: "PUT", body: { messages: [] } });
    await ctx.addInitScript(() => {
      localStorage.setItem("gamma-ai-login-check", "off");
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (String(input).endsWith("/api/ai/chat")) return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            window.mermaidStream = {
              push: (delta) => controller.enqueue(new TextEncoder().encode(JSON.stringify({ delta }) + "\n")),
              finish: () => controller.close(),
            };
          },
        }), { headers: { "Content-Type": "application/x-ndjson" } }));
        return original(input, init);
      };
    });
    const page = await openPage(ctx, `${server.base}/?ws=${alice.ws}`);
    try {
      const input = page.getByRole("combobox", { name: "Message AI" });
      await input.fill("Draw a diagram"); await input.press("Enter");
      await page.waitForFunction(() => !!window.mermaidStream);
      await page.evaluate((source) => window.mermaidStream.push("```mermaid\n" + source), flow);
      await page.getByText("Waiting for the diagram to finish…", { exact: true }).waitFor();
      assertEq(await page.locator(".mermaidPreview svg").count(), 0);
      assertEq(await page.locator(".mermaidSource").innerText(), flow);
      await page.evaluate(() => window.mermaidStream.push("\n```\n\n"));
      await page.locator(".mermaidPreview svg").waitFor();
      const firstId = await page.locator(".mermaidPreview svg").getAttribute("id");
      const untrusted = '%%{init: {"securityLevel":"loose","htmlLabels":true}}%%\nflowchart LR\nA[Start] --> B[Safe]\nclick A href "https://example.com"';
      await page.evaluate((text) => { window.mermaidStream.push(text); window.mermaidStream.finish(); },
        [fence("invalid diagram"), fence(sequence), fence(untrusted)].join("\n\n"));
      await until(async () => await page.locator(".mermaidPreview svg").count() === 3);
      await page.locator(".mermaidError").waitFor();
      assertEq(await page.locator(".mermaidPreview").last().locator("a, foreignObject, script").count(), 0,
        "diagram directives cannot enable links or HTML labels");
      assertEq(await page.locator(".mermaidPreview svg").first().getAttribute("id"), firstId, "streaming leaves completed SVG mounted");
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });
}
