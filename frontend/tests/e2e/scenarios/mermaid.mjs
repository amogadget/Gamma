import { readFile } from "node:fs/promises";
import { closeEditor, newPageViaUi } from "./notes.mjs";

const flow = 'flowchart LR\n  A["Start $a|b$ \\(x\\)"] --> B[Finish]';
const sequence = "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi";
// Note-style `$…$` next to Mermaid's own `$$…$$`: both typeset.
const quantum = String.raw`flowchart LR
  S(("$S_z$")) -. "$\chi$" .- A(("$$a_1$$"))
  A <-->|"$J$"| B(("$$a_2: |\alpha\rangle$$"))`;
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
      const ids = await page.locator(".mermaidPreview svg").evaluateAll((els) => els.map((el) => el.id));
      assertEq(new Set(ids).size, 2, "SVG IDs are unique");
      await first.hover(); // the toolbar is a hover strip, like an image's
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
        const oldId = await first.locator(".mermaidSvg svg").getAttribute("id");
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await until(async () => {
          const id = await first.locator(".mermaidSvg svg").getAttribute("id").catch(() => null);
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
      const starter = await newPageViaUi(page, "Mermaid starter");
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

      // Resize: the image grip's drag writes `width=N` into the fence's info
      // string, the figure follows it, double-click clears it again.
      const figure = page.locator(".mermaidFigure");
      const grip = figure.locator(".mdResizeGrip");
      await figure.hover();
      const startW = (await figure.boundingBox()).width;
      const box = await grip.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      const stored = async () => {
        const tree = await alice.api(`/api/blocks/${starter}/subtree`);
        return (tree.block.children || []).map((b) => b.content).find((c) => c.includes("mermaid")) || "";
      };
      await until(async () => /```mermaid width=\d+/.test(await stored()));
      const width = Number(/width=(\d+)/.exec(await stored())[1]);
      assert(width < startW && width >= 60, `dragged width ${width} is narrower than ${startW}`);
      await until(async () => Math.abs((await figure.boundingBox()).width - width) < 2, "figure takes the stored width");
      await page.reload();
      await page.locator(".mermaidPreview").filter({ hasText: "Edited" }).waitFor();
      await until(async () => Math.abs((await figure.boundingBox()).width - width) < 2, "stored width survives a reload");
      await figure.hover();
      await grip.dblclick();
      await until(async () => !/width=/.test(await stored()));
      assertEq(await page.locator(".blockEditorCm").count(), 0, "resizing never opens the editor");
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
      const untrusted = '%%{init: {"securityLevel":"loose","htmlLabels":false}}%%\nflowchart LR\nA["<img src=x onerror=alert(1)>"] --> B[Safe]\nclick A href "https://example.com"';
      await page.evaluate((text) => { window.mermaidStream.push(text); window.mermaidStream.finish(); },
        [fence("invalid diagram"), fence(sequence), fence(untrusted)].join("\n\n"));
      await until(async () => await page.locator(".mermaidPreview svg").count() === 3);
      await page.locator(".mermaidError").waitFor();
      assertEq(await page.locator(".mermaidPreview").last().locator("a, script, [onerror], [onclick]").count(), 0,
        "diagram directives cannot enable links or unsafe HTML");
      assertEq(await page.locator(".mermaidPreview svg").first().getAttribute("id"), firstId, "streaming leaves completed SVG mounted");
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });

  await step("mermaid: LaTeX in node and edge labels survives SVG download", async () => {
    const imported = await alice.upload("/api/import/markdown", Buffer.from(fence(quantum)), "Quantum diagram.md", "text/markdown");
    const ctx = await alice.context(browser);
    const page = await openPage(ctx, `${server.base}/?ws=${alice.ws}&block=${imported.block_id}`);
    try {
      const diagram = page.locator(".mermaidDiagram");
      await until(async () => await diagram.locator("math").count() === 5);
      assertEq(await diagram.locator(".node math").count(), 3, "node labels contain typeset math");
      assertEq(await diagram.locator(".edgeLabel math").count(), 2, "edge labels contain typeset math");
      assertEq(await diagram.getAttribute("data-mermaid-source"), quantum, "math source is preserved");
      const labels = (await diagram.locator("math").allTextContents()).join(" ");
      assert(labels.includes("χ") && labels.includes("α") && labels.includes("J"), "LaTeX commands become math symbols");
      assertEq(await diagram.locator("math msub").count(), 3, "subscripts are typeset");
      assert(await diagram.locator("math").evaluateAll((els) => els.every((el) => {
        const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0;
      })), "math labels have visible dimensions");
      const downloadEvent = page.waitForEvent("download");
      await diagram.hover();
      await diagram.getByRole("button", { name: "Download SVG", exact: true }).click();
      const svg = await readFile(await (await downloadEvent).path(), "utf8");
      assertEq(await page.evaluate((source) => new DOMParser().parseFromString(source, "image/svg+xml").querySelectorAll("math").length, svg), 5);
      if (process.env.GAMMA_MERMAID_SCREENSHOT) await diagram.screenshot({ path: process.env.GAMMA_MERMAID_SCREENSHOT });
      assertNoProblems(page);
    } finally { await ctx.close(); }
  });
}
