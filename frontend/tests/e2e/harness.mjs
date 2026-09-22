// Harness for the browser end-to-end suite (run.mjs): an ISOLATED backend
// over a throwaway data dir serving frontend/dist, accounts + API helpers,
// browser contexts logged in as those accounts, a real-PDF generator, and the
// step runner. Nothing here touches the developer's own data directory.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BACKEND = path.join(ROOT, "backend");
// A private build keeps concurrent development builds from replacing assets
// while a browser scenario is reloading the application.
const DIST = process.env.GAMMA_E2E_DIST || path.join(ROOT, "frontend", "dist");
// The backend interpreter: the project venv, or whatever GAMMA_E2E_PYTHON
// names (CI installs the requirements into the runner's python).
const PYTHON = process.env.GAMMA_E2E_PYTHON || (process.platform === "win32"
  ? path.join(BACKEND, "venv", "Scripts", "python.exe")
  : path.join(BACKEND, "venv", "bin", "python"));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const flags = {
  keep: process.argv.includes("--keep"),
  headed: process.argv.includes("--headed"),
  continueOnFail: process.argv.includes("--continue"),
  only: (() => { const i = process.argv.indexOf("--only"); return i > 0 ? process.argv[i + 1] : ""; })(),
};

// ---------------------------------------------------------------------------
// Server

let current = null; // the running server, for failure artifacts

export class Server {
  constructor() {
    current = this;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "gamma-e2e-"));
    this.dataDir = path.join(this.dir, "data");
    this.logPath = path.join(this.dir, "server.log");
    this.port = 0;
    this.proc = null;
  }
  get base() { return `http://127.0.0.1:${this.port}`; }
  manage(...args) {
    return execFileSync(PYTHON, ["manage.py", ...args], {
      cwd: BACKEND, env: { ...process.env, GAMMA_DATA_DIR: this.dataDir }, encoding: "utf8",
    });
  }
  async start() {
    if (!fs.existsSync(path.join(DIST, "index.html"))) throw new Error("frontend/dist is missing: run `npm run build` first");
    if (path.isAbsolute(PYTHON) && !fs.existsSync(PYTHON)) throw new Error(`backend venv python not found at ${PYTHON}`);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.manage("setup");
    this.port = await freePort();
    const log = fs.openSync(this.logPath, "a");
    this.proc = spawn(PYTHON, ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(this.port)], {
      cwd: BACKEND, stdio: ["ignore", log, log],
      env: { ...process.env, GAMMA_DATA_DIR: this.dataDir, GAMMA_STATIC_DIR: DIST, PYTHONIOENCODING: "utf-8", GAMMA_UPDATE_CHECK: "off" },
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      try { const r = await fetch(`${this.base}/api/session`); if (r.status < 500) return; } catch {}
      if (this.proc.exitCode != null) break;
      await sleep(200);
    }
    throw new Error(`backend did not come up:\n${this.log().slice(-2000)}`);
  }
  log() { try { return fs.readFileSync(this.logPath, "utf8"); } catch { return ""; } }
  async stop() {
    if (this.proc && this.proc.exitCode == null) {
      if (process.platform === "win32") { try { execFileSync("taskkill", ["/pid", String(this.proc.pid), "/t", "/f"], { stdio: "ignore" }); } catch {} }
      else this.proc.kill("SIGTERM");
      await sleep(300);
    }
    // The temp dir survives on --keep and after any failure (its
    // failures/ folder holds the screenshots and log tails).
    if (flags.keep || results.some((r) => !r.ok)) console.log(`kept: ${this.dir}`);
    else { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch {} }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Accounts + API

// A signed-in account bound to one workspace: `api()` for JSON calls (the same
// header the app's fetch wrapper adds), `context()` for a browser context that
// carries its session cookie.
export class Account {
  constructor(server, name, password) {
    this.server = server; this.name = name; this.password = password;
    this.session = ""; this.ws = ""; this.defaultWs = "";
  }
  async login() {
    const r = await fetch(`${this.server.base}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.name, password: this.password }),
    });
    if (!r.ok) throw new Error(`login ${this.name}: ${r.status} ${await r.text()}`);
    this.session = r.headers.getSetCookie().find((c) => c.startsWith("session=")).split(";")[0].slice("session=".length);
    const s = await (await fetch(`${this.server.base}/api/session`, { headers: { Cookie: `session=${this.session}` } })).json();
    this.defaultWs = s.default_workspace;
    if (!this.ws) this.ws = this.defaultWs;
    return this;
  }
  headers(extra = {}) {
    return { Cookie: `session=${this.session}`, "X-Gamma-Workspace": this.ws, ...extra };
  }
  async api(pathname, { method = "GET", body, form, raw = false } = {}) {
    const init = { method, headers: this.headers() };
    if (form) init.body = form;
    else if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    const r = await fetch(`${this.server.base}${pathname}`, init);
    if (raw) return r;
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) { const e = new Error(`${method} ${pathname} -> ${r.status}: ${text.slice(0, 300)}`); e.status = r.status; e.data = data; throw e; }
    return data;
  }
  async upload(pathname, bytes, filename, type) {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type }), filename);
    return this.api(pathname, { method: "POST", form: fd });
  }
  async context(browser, opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts });
    if (this.session) await ctx.addCookies([{ name: "session", value: this.session, url: this.server.base }]);
    return ctx;
  }
}

// ---------------------------------------------------------------------------
// Browser

export async function launchBrowser() {
  const opts = { headless: !flags.headed };
  // An explicitly named engine wins: CHROME_PATH / GAMMA_E2E_CHROME_PATH points
  // at a build with proprietary codecs (Chrome for Testing), which is what the
  // AAC/Note-Replay media assertions need — Playwright's stock Chromium cannot
  // decode AAC at all.
  const explicit = process.env.GAMMA_E2E_CHROME_PATH || process.env.CHROME_PATH || "";
  if (explicit && process.env.GAMMA_E2E_BROWSER !== "webkit") {
    if (!fs.existsSync(explicit)) throw new Error(`CHROME_PATH does not exist: ${explicit}`);
    return await chromium.launch({ ...opts, executablePath: explicit });
  }
  if (process.env.GAMMA_E2E_BROWSER === "webkit") return webkit.launch(opts);
  try {
    return await chromium.launch(opts);
  } catch (e) {
    if (!/Executable doesn't exist/.test(String(e.message))) throw e;
    console.log("  (downloading Playwright's Chromium once)");
    execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "install", "chromium-headless-shell"],
      { cwd: path.join(ROOT, "frontend"), stdio: "inherit", shell: process.platform === "win32" });
    return await chromium.launch(opts);
  }
}

// API answers that are a designed "no" rather than a failure.
const EXPECTED_FAILURES = [
  /POST \/api\/metadata\/fetch -> 404/, // a PDF without an arXiv id / DOI: nothing to fetch
];

// A page that records every API failure, console error and page error so a
// step can assert "nothing went wrong" instead of only "the thing appeared".
// (The browser's own "Failed to load resource" console line is skipped: the
// response listener already records the same failure with its URL.)
const openPages = new Set();

export async function openPage(ctx, url) {
  const page = await ctx.newPage();
  page.problems = [];
  openPages.add(page);
  page.on("close", () => openPages.delete(page));
  page.on("response", (r) => {
    const u = r.url();
    if (!u.includes("/api/") || r.status() < 400) return;
    const line = `${r.request().method()} ${u.replace(/^https?:\/\/[^/]+/, "")} -> ${r.status()}`;
    if (!EXPECTED_FAILURES.some((re) => re.test(line))) page.problems.push(line);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) page.problems.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => page.problems.push(`pageerror: ${String(e).slice(0, 200)}`));
  if (url) await page.goto(url);
  return page;
}

export function assertNoProblems(page, allow = []) {
  const bad = page.problems.filter((p) => !allow.some((a) => (a instanceof RegExp ? a.test(p) : p.includes(a))));
  page.problems = [];
  if (bad.length) throw new Error(`problems on the page:\n  ${bad.join("\n  ")}`);
}

// ---------------------------------------------------------------------------
// PDFs: a small but real PDF (Helvetica text, one content stream per page)
// that pdf.js renders with a selectable text layer.

// `padBytes` appends one unreferenced stream of that many bytes, so a small
// text document can weigh as much as a scanned book (the timing probe's
// transport case) while every page stays tiny to parse and render. A page is
// its lines, or `{lines, box: [w, h]}` for a MediaBox other than US Letter.
export function makePdf(pages, { padBytes = 0 } = {}) {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add("");
  const pagesObj = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids = [];
  for (const pg of pages) {
    const lines = Array.isArray(pg) ? pg : pg.lines;
    const [w, h] = (Array.isArray(pg) ? null : pg.box) || [612, 792];
    const content = ["BT", "/F1 20 Tf", `72 ${h - 72} Td`, "26 TL", ...lines.map((l) => `(${esc(l)}) Tj T*`), "ET"].join("\n");
    const stream = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  if (padBytes > 0) add(`<< /Length ${padBytes} >>
stream
${"x".repeat(padBytes)}
endstream`);
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// ---------------------------------------------------------------------------
// Steps

export const results = [];

export async function step(name, fn) {
  if (flags.only && !name.includes(flags.only)) return;
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note || "", ms: Date.now() - t0 });
    console.log(`  ok    ${name}${note ? "  - " + note : ""}  (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, note: String((e && e.message) || e), ms: Date.now() - t0 });
    console.log(`  FAIL  ${name}\n        ${String((e && e.stack) || e).split("\n").join("\n        ")}`);
    await saveFailureArtifacts(name, e).catch(() => {});
    if (!flags.continueOnFail) throw e;
  }
}

// On a failed step: a screenshot of every open page, the pages' recorded
// problems and the tail of the server log, under <temp dir>/failures/ (the
// temp dir is then kept) — what a CI log alone can't tell you.
async function saveFailureArtifacts(name, err) {
  if (!current) return;
  const dir = path.join(current.dir, "failures");
  fs.mkdirSync(dir, { recursive: true });
  const slug = `${String(results.length).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60)}`;
  const pages = [...openPages].filter((p) => !p.isClosed());
  for (const [i, page] of pages.entries()) {
    try { await page.screenshot({ path: path.join(dir, `${slug}${pages.length > 1 ? `-${i + 1}` : ""}.png`) }); } catch {}
  }
  const problems = pages.flatMap((p) => p.problems || []);
  fs.writeFileSync(path.join(dir, `${slug}.log`), [
    `# ${name}`, "", String((err && err.stack) || err), "", "## page problems", ...(problems.length ? problems : ["(none)"]),
    "", "## server log (tail)", current.log().slice(-8000),
  ].join("\n"));
  console.log(`        artifacts: ${dir}`);
}

export function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
export function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg || "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// Poll until `fn` returns truthy (state that lands after a debounce or a
// websocket round trip).
export async function until(fn, { timeout = 8000, every = 100, what = "condition" } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}
