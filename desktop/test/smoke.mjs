// End-to-end smoke test: launch the real app, drive the real chooser, and make
// sure the real Python backend starts — and, just as importantly, dies.
//
//   npm test            (needs a display; use `xvfb-run -a npm test` on a
//                        headless Linux box)
//
// Every launch gets its own userData directory and its own library directory,
// so a test run can neither read nor damage a real installation.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";

import { tinyPdf } from "./tinypdf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");

const LAUNCH_TIMEOUT = 90_000;
const tmpRoots = [];

// Point this at a built binary to run the whole suite against the real
// artifact — bundled interpreter, staged dependencies, asar and all:
//
//   GAMMA_PACKAGED_APP=dist/linux-arm64-unpacked/gamma-desktop xvfb-run -a npm test
//
// Unset, the suite runs from this source tree against backend/venv.
const packagedApp = process.env.GAMMA_PACKAGED_APP || "";

function tmpRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gamma-${label}-`));
  tmpRoots.push(dir);
  const userData = path.join(dir, "userData");
  const library = path.join(dir, "library");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(library, { recursive: true });
  return { dir, userData, library };
}

after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });

  // Printed at the end so it lands in the tail of the output, which is what a
  // CI annotation carries. Silent when every launch was uneventful.
  for (const lines of recorded) {
    const text = lines.join("");
    if (ALARMING.test(text)) {
      console.error(`--- app output ---\n${text.slice(-2500)}`);
    }
  }
});

async function launch({ userData, library, env = {} }) {
  const args = packagedApp
    ? // A packaged build carries its own app; --no-sandbox because the setuid
      // sandbox helper needs a root-owned binary, which a CI runner's checkout
      // is not.
      [`--user-data-dir=${userData}`, "--no-sandbox"]
    : [appDir, `--user-data-dir=${userData}`];
  const app = await electron.launch({
    ...(packagedApp ? { executablePath: path.resolve(packagedApp) } : {}),
    args,
    timeout: LAUNCH_TIMEOUT,
    env: {
      ...process.env,
      GAMMA_DATA_DIR: library,
      // Deterministic: never inherit a developer's own mode choice.
      GAMMA_DESKTOP_MODE: "",
      GAMMA_DESKTOP_SERVER: "",
      // Make the shell echo the backend's output, so a failure here can say
      // what the backend said (see recordOutput).
      GAMMA_DESKTOP_VERBOSE: "1",
      ...env,
    },
  });
  recordOutput(app);
  return app;
}

// Playwright reports a dead app as "Target closed", which explains nothing. The
// app's own stdout/stderr — Electron's, plus the backend's, via
// GAMMA_DESKTOP_VERBOSE — is where the reason actually is. Keep it, and print
// anything alarming once the run is over.
//
// On CI that tail is the whole diagnosis: workflow logs need admin rights on
// the repository, so what reaches us is the annotation from
// scripts/ci-step.sh, which carries the last lines of this output.
const recorded = [];

function recordOutput(app) {
  const lines = [];
  recorded.push(lines);
  const proc = app.process();
  proc.stdout?.on("data", (d) => lines.push(d.toString()));
  proc.stderr?.on("data", (d) => lines.push(d.toString()));
}

const ALARMING = /Traceback|FATAL|Fatal error|error while loading|Segmentation|ImportError|ModuleNotFound|EADDR|Permission denied/;

/**
 * Collect anything that looks like a failure into `sink`: page errors, console
 * errors, and HTTP responses of 400 and up.
 *
 * Chromium's own "Failed to load resource" console line carries no URL, so
 * failed requests are tracked from the response side instead — that way an
 * allowed failure can be named precisely rather than by muting a whole class
 * of message.
 */
function watchForErrors(page, sink, { allowHttp = [] } = {}) {
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" && !/^Failed to load resource/.test(text)) {
      sink.push(`console: ${text}`);
    }
  });
  page.on("pageerror", (err) => sink.push(`pageerror: ${err.message}`));
  page.on("response", (res) => {
    if (res.status() < 400) return;
    if (allowHttp.some((re) => re.test(res.url()))) return;
    sink.push(`http ${res.status()} ${new URL(res.url()).pathname}`);
  });
}

function readState(library) {
  try {
    return JSON.parse(fs.readFileSync(path.join(library, "desktop.json"), "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function waitUntil(fn, { timeoutMs = 15_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * A running app in local mode with the chooser already answered — the state
 * the tests below start from.
 */
async function launchLocal(t, label) {
  const { userData, library } = tmpRoot(label);
  fs.writeFileSync(
    path.join(userData, "settings.json"),
    JSON.stringify({ mode: "local", serverUrl: "" }),
  );
  const app = await launch({ userData, library });
  t.after(() => app.close().catch(() => {}));
  const page = await app.firstWindow();
  await page.waitForSelector(".homeFindInput", { timeout: 60_000 });
  return { app, page, library, userData };
}

/** Wait for a window that is not the chooser. */
async function appWindow(app) {
  for (;;) {
    const win = await app.waitForEvent("window", { timeout: LAUNCH_TIMEOUT });
    if (!(await win.url()).startsWith("file:")) return win;
  }
}

// --- the chooser -------------------------------------------------------------

test("first launch asks where the library should live", async (t) => {
  const { userData, library } = tmpRoot("chooser");
  const app = await launch({ userData, library });
  t.after(() => app.close().catch(() => {}));

  const chooser = await app.firstWindow();
  const errors = [];
  watchForErrors(chooser, errors);
  await chooser.waitForSelector("#opt-local");

  assert.ok((await chooser.url()).startsWith("file:"), "the chooser is part of the app");
  assert.match(await chooser.textContent("#opt-local"), /Run locally/);
  assert.match(await chooser.textContent("#opt-remote"), /Connect to a server/);
  // Local is the default, and the server field stays out of the way until the
  // other option is picked.
  assert.equal(await chooser.getAttribute("#opt-local", "aria-selected"), "true");
  assert.equal(await chooser.isVisible("#server"), false);
  await chooser.click("#opt-remote");
  assert.equal(await chooser.isVisible("#server"), true);
  // First run: there is nothing to go back to, so no Cancel.
  assert.equal(await chooser.isVisible("#cancel"), false);

  // Nothing has been started yet — asking is not choosing.
  assert.equal(readState(library), null, "no backend should run before a choice");
  assert.deepEqual(errors, []);
});

test("an unreachable server is reported instead of a blank window", async (t) => {
  const { userData, library } = tmpRoot("badserver");
  const app = await launch({ userData, library });
  t.after(() => app.close().catch(() => {}));

  const chooser = await app.firstWindow();
  await chooser.waitForSelector("#opt-remote");
  await chooser.click("#opt-remote");
  // Port 1 on loopback: refuses immediately, so this does not wait on a timeout.
  await chooser.fill("#server", "http://127.0.0.1:1");
  await chooser.click("#go");

  await chooser.waitForSelector(".status.error");
  assert.match(await chooser.textContent(".status"), /Couldn't reach|No answer/);
  assert.equal(await chooser.isVisible("#opt-remote"), true, "still on the chooser");
  assert.equal(readState(library), null, "and no local backend was started");
});

// --- local mode --------------------------------------------------------------

test("choosing local starts the backend, shows the library, and cleans up on quit", async (t) => {
  const { userData, library } = tmpRoot("local");
  const app = await launch({ userData, library });
  let closed = false;
  t.after(() => (closed ? null : app.close().catch(() => {})));

  const chooser = await app.firstWindow();
  await chooser.waitForSelector("#opt-local");
  await chooser.click("#opt-local");
  await chooser.click("#go");

  const page = await appWindow(app);
  const errors = [];
  watchForErrors(page, errors);

  assert.match(await page.url(), /^http:\/\/127\.0\.0\.1:\d+\//);

  // The auto-session means no login screen: the library itself must render.
  await page.waitForSelector(".homeFindInput", { timeout: 60_000 });
  const session = await page.evaluate(() =>
    fetch("/api/session").then((r) => r.json()),
  );
  assert.equal(session.user, "local", "the desktop auto-session should sign us in");

  // The library lives where we pointed it, and the running-instance record
  // names a live process.
  const state = readState(library);
  assert.ok(state && state.pid, "the backend should have recorded itself");
  assert.ok(pidAlive(state.pid), "…and be running");
  assert.ok(fs.existsSync(path.join(library, "users.db")), "the library was created here");

  // The choice is remembered.
  const saved = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
  assert.equal(saved.mode, "local");

  assert.deepEqual(errors, [], "the library page should load without console errors");

  // Quitting must not leave the backend behind: it holds the single-instance
  // lock, and the next launch would refuse to start.
  const pid = state.pid;
  await app.close();
  closed = true;
  assert.ok(
    await waitUntil(() => !pidAlive(pid)),
    "the Python backend should be gone after the app quits",
  );
  assert.equal(readState(library), null, "and its running-instance record cleared");
});

test("a remembered choice skips the chooser", async (t) => {
  const { userData, library } = tmpRoot("remembered");
  fs.writeFileSync(
    path.join(userData, "settings.json"),
    JSON.stringify({ mode: "local", serverUrl: "" }),
  );
  const app = await launch({ userData, library });
  t.after(() => app.close().catch(() => {}));

  const page = await app.firstWindow();
  assert.match(await page.url(), /^http:\/\/127\.0\.0\.1:\d+\//, "straight to the app");
  await page.waitForSelector(".homeFindInput", { timeout: 60_000 });
});

// --- the actual product ------------------------------------------------------

test("a PDF uploads and renders in the window", async (t) => {
  const { page } = await launchLocal(t, "pdf");
  const errors = [];
  watchForErrors(page, errors, {
    // Opening a page looks up its paper metadata, and a 404 there means "this
    // isn't a paper I can identify" — which is the truth about a PDF that says
    // "Gamma" in 24pt Helvetica.
    allowHttp: [/\/api\/metadata\/fetch$/],
  });

  // Upload through the app's own API, from inside the app's own page — the
  // same path the UI takes, minus the file picker.
  const b64 = tinyPdf("Gamma").toString("base64");
  const ids = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("file", new File([bytes], "tiny.pdf", { type: "application/pdf" }));
    const up = await fetch("/api/uploads", { method: "POST", body: form });
    if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text()}`);
    const { doc_id, source_url } = await up.json();
    const made = await fetch(`/api/blocks/by-doc/${doc_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_title: "Tiny", source_url }),
    });
    if (!made.ok) throw new Error(`page create failed: ${made.status}`);
    return { docId: doc_id, blockId: (await made.json()).id };
  }, b64);

  assert.ok(ids.blockId, "a page should have been created for the document");

  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/?block=${ids.blockId}`);

  // pdf.js is bundled in the app and the PDF is served by the local backend:
  // a canvas with real pixels means both halves work inside the window.
  const canvas = await page.waitForSelector("canvas", { timeout: 60_000 });
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 50 && box.height > 50, `canvas too small: ${JSON.stringify(box)}`);

  // …and the text layer, which is what selection and highlighting depend on.
  await page.waitForFunction(
    () => /Gamma/.test(document.querySelector(".textLayer")?.textContent || ""),
    null,
    { timeout: 30_000 },
  );

  assert.deepEqual(errors, [], "opening a PDF should not log console errors");
});

test("the backend is restarted if it dies", async (t) => {
  const { page, library } = await launchLocal(t, "restart");
  const first = readState(library);
  assert.ok(first && pidAlive(first.pid));

  // Simulate a crash — no cleanup, no chance to release anything.
  process.kill(first.pid, "SIGKILL");
  assert.ok(await waitUntil(() => !pidAlive(first.pid)), "the backend should be gone");

  assert.ok(
    await waitUntil(() => {
      const st = readState(library);
      return st && st.pid !== first.pid && pidAlive(st.pid);
    }, { timeoutMs: 30_000 }),
    "the supervisor should start a new backend",
  );

  // And the window comes back on its own, on whatever port the new backend
  // got. Polled, because the shell reloads it a moment after the new backend
  // records itself — the stale DOM is still on screen until then.
  assert.ok(
    await waitUntil(
      async () => {
        try {
          const session = await page.evaluate(() =>
            fetch("/api/session").then((r) => r.json()),
          );
          return session.user === "local";
        } catch {
          return false; // mid-navigation
        }
      },
      { timeoutMs: 60_000, everyMs: 500 },
    ),
    "the window should be usable again after the backend restarts",
  );
  await page.waitForSelector(".homeFindInput", { timeout: 60_000 });
});

// --- remote mode -------------------------------------------------------------

test("remote mode loads the server and starts no local backend", async (t) => {
  // A stand-in for a hosted Gamma: answers /api/health and serves a page.
  const server = http.createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Remote Gamma</title><h1 id=remote>remote</h1>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((r) => server.close(r)));

  const { userData, library } = tmpRoot("remote");
  const app = await launch({ userData, library });
  t.after(() => app.close().catch(() => {}));

  const chooser = await app.firstWindow();
  await chooser.waitForSelector("#opt-remote");
  await chooser.click("#opt-remote");
  await chooser.fill("#server", origin);
  await chooser.click("#go");

  const page = await appWindow(app);
  await page.waitForSelector("#remote");
  assert.ok((await page.url()).startsWith(origin));
  assert.equal(readState(library), null, "remote mode must not start Python");

  const saved = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
  assert.equal(saved.mode, "remote");
  assert.equal(saved.serverUrl, origin);
  assert.deepEqual(saved.recentServers, [origin]);
});
