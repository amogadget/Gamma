// Standalone browser regression: real block editor, no backend or saved data.
// Run from frontend: npm run e2e:latex
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundle = await build({
  stdin: { resolveDir: root, loader: "jsx", contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {BlockTree} from './src/editor/BlockTree.jsx';
    import {MathLivePreview, LatexAcPopup, latexCompletions, mathTabJump} from './src/editor/LatexEditor.jsx';
    const noop = () => {};
    const registerRef = (_, ref) => { window.editorRef = ref; };
    function Fixture() {
      const [text, setText] = useState('');
      const block = {id:'test',content:text,editMode:true,children:[]};
      return <BlockTree blocks={[block]} rowProps={{focusedId:'test',setFocusedId:noop,
        onChangeText:(_,value)=>setText(value),onStartEdit:noop,registerRef,
        onEnterSibling:noop,onIndent:noop,onOutdent:noop,onToggle:noop,onDelete:noop,
        allBlocks:[block],refCache:{},highlightColors:[]}} />;
    }
    createRoot(document.getElementById('editor')).render(<Fixture />);
    const previewRoot = createRoot(document.getElementById('preview'));
    window.preview = (tex, anchor, ac=false) => previewRoot.render(ac
      ? <LatexAcPopup items={latexCompletions('left',12)} selected={0} anchor={anchor} onPick={noop}/>
      : <MathLivePreview tex={tex} display anchor={anchor}/>);
    window.mathTabJump = mathTabJump;
    window.setDoc = (text, cursor=text.length, end=cursor) => {
      const api=window.editorRef.current;
      api.view.dispatch({changes:{from:0,to:api.value.length,insert:text},selection:{anchor:cursor,head:end}});
      api.focus();
    };
  ` },
  bundle: true, write: false, format: "iife",
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
  plugins: [{ name: "unused-worker-url", setup(b) {
    b.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "fixture-url" }));
    b.onLoad({ filter: /.*/, namespace: "fixture-url" }, () => ({ contents: 'export default "";' }));
  } }],
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://localhost/**", async (route) => {
    const file = new URL(route.request().url()).pathname;
    if (file.startsWith("/fonts/")) {
      await route.fulfill({ body: readFileSync(path.join(root, "node_modules/katex/dist/fonts", path.basename(file))) });
    } else {
      await route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="editor" style="margin:120px 30px;width:600px"></div><div id="preview" style="transform:translateX(30px);overflow:hidden"></div>' });
    }
  });
  await page.goto("http://localhost/");
  await page.addStyleTag({ content: readFileSync(path.join(root, "node_modules/katex/dist/katex.min.css"), "utf8") });
  await page.addStyleTag({ content: readFileSync(path.join(root, "src/shared/styles/app.css"), "utf8").replace(/^@import[^;]+;/, "") });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => window.editorRef?.current?.view);
  const reset = (value = "$$", cursor = 1, end = cursor) => page.evaluate(([v, c, e]) => window.setDoc(v, c, e), [value, cursor, end]);
  const value = () => page.evaluate(() => window.editorRef.current.value);
  const cursor = () => page.evaluate(() => window.editorRef.current.selectionStart);

  for (const [open, close] of [["(", ")"], ["[", "]"], ["\\{", "\\}"], ["|", "|"],
    ["\\langle", "\\rangle"], ["\\lVert", "\\rVert"], ["\\lfloor", "\\rfloor"], ["\\lceil", "\\rceil"]]) {
    await reset();
    await page.keyboard.type("\\left" + open);
    assert.equal(await value(), "$\\left" + open + "\\right" + close + "$");
    await page.keyboard.press("Escape"); // dismiss any completed command suggestion
    await page.keyboard.press("Backspace");
    assert.equal(await value(), "$$", "Backspace removes the empty scalable pair");
  }
  await reset();
  await page.keyboard.type("\\left(\\left[x");
  assert.equal(await value(), "$\\left(\\left[x\\right]\\right)$");
  await page.keyboard.type("]");
  assert.equal(await cursor(), (await value()).indexOf("\\right)"));
  await page.keyboard.press("Tab");
  assert.equal(await cursor(), (await value()).length - 1);
  await page.keyboard.press("Tab");
  assert.equal(await cursor(), (await value()).length);

  await reset();
  await page.keyboard.type("\\left\\lang");
  await page.keyboard.press("Tab");
  assert.equal(await value(), "$\\left\\langle\\right\\rangle$");
  await page.keyboard.type("x");
  await page.keyboard.press("Tab");
  assert.equal(await cursor(), (await value()).length - 1);

  for (const name of ["sum", "int", "prod", "oint"]) {
    await reset();
    await page.keyboard.type("\\" + name);
    await page.keyboard.press("Tab");
    await page.keyboard.type("0");
    await page.keyboard.press("Tab");
    await page.keyboard.type("n");
    await page.keyboard.press("Tab");
    assert.equal(await value(), "$\\" + name + "_{0}^{n}$");
  }
  for (const [name, expected] of [["abs", "\\left| x \\right|"], ["norm", "\\left\\lVert x \\right\\rVert"], ["lim", "\\lim_{x}"]]) {
    await reset();
    await page.keyboard.type("\\" + name);
    await page.keyboard.press("Tab");
    await page.keyboard.type("x");
    assert.equal(await value(), "$" + expected + "$");
  }
  await reset();
  await page.keyboard.type("\\frac");
  await page.keyboard.press("Tab");
  await page.keyboard.type("a");
  await page.keyboard.press("Tab");
  await page.keyboard.type("b");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type("c");
  assert.equal(await value(), "$\\frac{c}{b}$");
  await reset("$$$$", 2);
  await page.keyboard.type("\\begin{aligned");
  await page.keyboard.press("Tab");
  assert.equal(await value(), "$$\\begin{aligned}\n\n\\end{aligned}$$");
  await page.keyboard.type("a&=b");
  await page.keyboard.press("Enter");
  assert((await value()).includes("a&=b\n"), "Enter in display math stays in the equation");
  await reset();
  await page.keyboard.type("\\sq");
  await page.locator(".latexAcItem").filter({ hasText: "\\sqrt" }).click();
  await page.keyboard.type("x");
  assert.equal(await value(), "$\\sqrt{x}$", "mouse completion retains the editor/caret");
  for (const [text, pos] of [["", 0], ["```tex\n$$\n```", 8]]) {
    await reset(text, pos);
    await page.keyboard.type("\\left(");
    assert(!(await value()).includes("\\right"), "prose and code fences stay untouched");
  }
  console.log("PASS: direct typing, nested pairs, deletion, overtyping, Tab/Shift+Tab, snippets, autocomplete, prose/code isolation");

  await reset("", 0);
  const long = Array.from({ length: 100 }, (_, i) => `\\frac{x_${i}}{1+x_${i}^2}`).join("+");
  const tall = "\\begin{aligned}" + Array.from({ length: 45 }, (_, i) => `x_${i}&=y_${i}`).join("\\\\") + "\\end{aligned}";
  const contained = async (selector) => {
    await page.waitForFunction((sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r && r.left >= 7 && r.top >= 7 && r.right <= innerWidth - 7 && r.bottom <= innerHeight - 7;
    }, selector);
  };
  const live = "$$\n" + long + "\n$$";
  await reset(live, live.length - 3);
  const typingStart = performance.now();
  await page.keyboard.type("+\\left(x+y");
  assert((await value()).endsWith("+\\left(x+y\\right)\n$$"));
  assert(performance.now() - typingStart < 5000, "typing a long equation remains responsive");
  await contained(".mathPreviewTip");
  await page.locator(".mathPreviewTip").evaluate((el) => { el.scrollLeft = 100; });
  assert(await page.locator(".mathPreviewTip").evaluate((el) => el.scrollLeft > 0));
  await page.locator(".mathPreviewTip").click({ position: { x: 20, y: 15 } });
  assert(await page.locator(".cm-content").evaluate((el) => el === document.activeElement), "preview interaction retains editor focus");
  await page.evaluate(() => window.editorRef.current.view.scrollDOM.scrollIntoView());
  await contained(".mathPreviewTip");
  if (process.env.GAMMA_LATEX_SCREENSHOT) await page.screenshot({ path: process.env.GAMMA_LATEX_SCREENSHOT });
  await reset("", 0);
  for (const viewport of [{ width: 900, height: 650 }, { width: 360, height: 240 }]) {
    await page.setViewportSize(viewport);
    for (const tex of [long, tall]) {
      for (const top of [0, viewport.height / 2, viewport.height - 15]) {
        await page.evaluate(([tex, top, left]) => window.preview(tex, { left, top, bottom: top + 18 }), [tex, top, viewport.width - 12]);
        await contained(".mathPreviewTip");
        const overflow = await page.locator(".mathPreviewTip").evaluate((el) => ({ x: el.scrollWidth > el.clientWidth, y: el.scrollHeight > el.clientHeight, portal: el.parentNode === document.body }));
        assert(overflow.portal);
        assert(tex === long ? overflow.x : overflow.y, "oversized equations can scroll");
      }
    }
    await page.evaluate(() => window.preview("", { left: innerWidth - 12, top: innerHeight - 18, bottom: innerHeight }, true));
    await contained(".latexAcPopup");
  }
  await page.evaluate((tex) => window.preview(tex, { left: 880, top: 600, bottom: 618 }), long);
  await page.setViewportSize({ width: 320, height: 200 });
  await contained(".mathPreviewTip");
  assert.deepEqual(errors, []);
  console.log("PASS: live long-equation typing, scrollable preview without focus loss, window edges, narrow screens and resize");
} finally {
  await browser.close();
}
