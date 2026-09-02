// End-to-end: launch the real shell, drive the real launcher, and make sure
// the real servers start — and, just as importantly, die.
//
//   npm test            (needs a display; use `xvfb-run -a npm test` on a
//                        headless Linux box)
//
// Point GAMMA_PACKAGED_APP at a built binary to run the whole suite against
// the real artifact — bundled interpreter, staged dependencies, asar and all:
//
//   GAMMA_PACKAGED_APP=dist/linux-unpacked/gamma-desktop xvfb-run -a npm test
//
// Every launch gets its own shell profile and its own libraries, so a run can
// neither read nor damage a real installation.

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
const packagedApp = process.env.GAMMA_PACKAGED_APP || "";

const LAUNCH_TIMEOUT = 120_000;
const READY_TIMEOUT = 120_000;
const tmpRoots = [];

// Electron and the backend both report real trouble on stderr. Playwright
// reports a dead app as "Target closed", which explains nothing, so keep the
// output and print anything alarming at the end — on CI that tail is the whole
// diagnosis, since it reaches us through scripts/ci-step.sh's annotation.
const recorded = [];
const ALARMING =
  /Traceback|FATAL|Fatal error|error while loading|Segmentation|ImportError|ModuleNotFound|EADDR|Permission denied/;

after(() => {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows will not delete a file another process still holds, and a
      // just-quit Electron can hold one for a moment.
    }
  }
  for (const lines of recorded) {
    const text = lines.join("");
    if (ALARMING.test(text)) console.error(`--- app output ---\n${text.slice(-2500)}`);
  }
});

function profile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gamma-${label}-`));
  tmpRoots.push(dir);
  return dir;
}

async function launch(shellProfile, env = {}) {
  const chromiumProfile = path.join(shellProfile, "chromium");
  const args = packagedApp
    ? // The setuid sandbox helper needs a root-owned binary, which a CI
      // runner's checkout is not.
      [`--user-data-dir=${chromiumProfile}`, "--no-sandbox"]
    : [appDir, `--user-data-dir=${chromiumProfile}`];
  const app = await electron.launch({
    ...(packagedApp ? { executablePath: path.resolve(packagedApp) } : {}),
    args,
    timeout: LAUNCH_TIMEOUT,
    env: {
      ...process.env,
      GAMMA_SHELL_USER_DATA: shellProfile,
      // Records what would have opened in a browser instead of doing it.
      GAMMA_SHELL_TEST: "1",
      ...env,
    },
  });
  const lines = [];
  recorded.push(lines);
  app.process().stdout?.on("data", (d) => lines.push(d.toString()));
  app.process().stderr?.on("data", (d) => lines.push(d.toString()));
  return app;
}

/** The shell's views are separate webContents, so separate Playwright pages. */
async function findPage(app, predicate, what, timeout = READY_TIMEOUT) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = app.windows().find((p) => {
      try {
        return predicate(p.url());
      } catch {
        return false;
      }
    });
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(
        `no ${what}; open pages: ${app.windows().map((p) => p.url()).join(", ")}`,
      );
    }
    await sleep(150);
  }
}

const isBar = (u) => u.endsWith("/ui/bar.html");
const isLauncher = (u) => u.includes("/ui/launcher.html");
const isWorkspace = (u) => /^https?:\/\//.test(u);

const barPage = (app) => findPage(app, isBar, "shell bar");
const launcherPage = (app) => findPage(app, isLauncher, "launcher");
const workspacePage = (app) => findPage(app, isWorkspace, "workspace page");

/** Read shell internals from the main process (the GAMMA_SHELL_TEST hook). */
function inspect(app, fn, arg) {
  return app.evaluate(
    (_electronApi, [source, value]) =>
      new Function("shell", "arg", `return (${source})(shell, arg)`)(global.__gammaShell, value),
    [fn.toString(), arg],
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, what, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      const detail = last && last.message ? last.message : JSON.stringify(last);
      throw new Error(`timed out waiting for ${what} (last: ${detail})`);
    }
    await sleep(250);
  }
}

/** Create a local workspace through the UI and wait for its library to load. */
async function createLocal(app, name) {
  const launcher = await launcherPage(app);
  await launcher.click("#addLocal");
  await launcher.fill("#localName", name);
  await launcher.click("#createLocal");
  const page = await workspacePage(app);
  await page.waitForSelector(".homeFindInput", { timeout: READY_TIMEOUT });
  return page;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// --- the launcher ------------------------------------------------------------

test("first launch shows the launcher and starts nothing", async (t) => {
  const shellProfile = profile("launcher");
  const app = await launch(shellProfile);
  t.after(() => app.close().catch(() => {}));

  const launcher = await launcherPage(app);
  await launcher.waitForSelector("#addLocal");
  assert.match(await launcher.textContent(".empty"), /No workspaces yet/);
  assert.match(await launcher.textContent("#addLocal"), /library on this computer/);
  assert.match(await launcher.textContent("#addRemote"), /Connect to a server/);

  const bar = await barPage(app);
  assert.equal(await bar.textContent("#label"), "Workspaces", "nothing is open yet");

  // Asking is not choosing: no server and no library until something is made.
  assert.equal(await inspect(app, (shell) => shell.registry.load().workspaces.length), 0);
});

test("an unreachable server is refused, and not added", async (t) => {
  const shellProfile = profile("badserver");
  const app = await launch(shellProfile);
  t.after(() => app.close().catch(() => {}));

  const launcher = await launcherPage(app);
  await launcher.click("#addRemote");
  // Port 1 on loopback refuses at once, so this does not wait on a timeout.
  await launcher.fill("#remoteUrl", "http://127.0.0.1:1");
  await launcher.click("#createRemote");

  await launcher.waitForFunction(
    () => document.getElementById("remoteErr").textContent.length > 0,
  );
  assert.match(await launcher.textContent("#remoteErr"), /Couldn't reach|No answer/);
  assert.equal(await inspect(app, (shell) => shell.registry.load().workspaces.length), 0);
});

// --- local workspaces --------------------------------------------------------

test("a local workspace starts its own server and signs you in", async (t) => {
  const shellProfile = profile("local");
  const app = await launch(shellProfile);
  let closed = false;
  t.after(() => (closed ? null : app.close().catch(() => {})));

  const page = await createLocal(app, "Papers");

  // The auto-session means no login screen: the library itself renders.
  const session = await page.evaluate(() => fetch("/api/session").then((r) => r.json()));
  assert.equal(session.user, "local", "the loopback auto-session should sign us in");
  assert.match(page.url(), /^http:\/\/127\.0\.0\.1:\d+\//);

  const bar = await barPage(app);
  await bar.waitForFunction(() => document.getElementById("label").textContent === "Papers");

  const ws = await inspect(app, (shell) => shell.registry.load().workspaces[0]);
  assert.equal(ws.type, "local");
  assert.ok(
    ws.dataDir.startsWith(path.join(shellProfile, "workspaces")),
    "its library is in the shell's own folder",
  );
  assert.ok(fs.existsSync(path.join(ws.dataDir, "users.db")), "with a real library in it");
  assert.ok(
    fs.existsSync(path.join(shellProfile, "logs", `${ws.id}.log`)),
    "and a server log on disk",
  );

  const record = JSON.parse(fs.readFileSync(path.join(ws.dataDir, "desktop.json"), "utf8"));
  assert.ok(pidAlive(record.pid), "the server it recorded is running");

  // Quitting must not leave it behind: it holds the library's lock, and the
  // next launch would refuse to start.
  await app.close();
  closed = true;
  assert.ok(await waitFor(() => !pidAlive(record.pid), "the server to exit"), "server gone");
  assert.equal(
    fs.existsSync(path.join(ws.dataDir, "desktop.json")),
    false,
    "and its running-instance record cleared",
  );
});

test("a PDF uploads and renders in the window", async (t) => {
  const shellProfile = profile("pdf");
  const app = await launch(shellProfile);
  t.after(() => app.close().catch(() => {}));

  const page = await createLocal(app, "Papers");
  const errors = [];
  const warnings = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" && !/^Failed to load resource/.test(text)) errors.push(text);
    else if (msg.type() === "warning" || /^Warning:/.test(text)) warnings.push(text);
  });
  page.on("response", (res) => {
    // A metadata 404 means "this isn't a paper I can identify", which is the
    // truth about a PDF that says "Gamma" in 24pt Helvetica.
    if (res.status() >= 400 && !/\/api\/metadata\/fetch$/.test(res.url())) {
      errors.push(`http ${res.status()} ${new URL(res.url()).pathname}`);
    }
  });

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

  await page.goto(`${new URL(page.url()).origin}/?block=${ids.blockId}`);

  const canvas = await page.waitForSelector("canvas", { timeout: READY_TIMEOUT });
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 50 && box.height > 50, `canvas too small: ${JSON.stringify(box)}`);

  // The text layer is what selection, highlighting and in-PDF search need. It
  // was empty on Windows until .mjs stopped being served as text/plain — pages
  // rendered, so nothing else noticed.
  const gotText = await page
    .waitForFunction(
      () => /Gamma/.test(document.querySelector(".textLayer")?.textContent || ""),
      null,
      { timeout: 90_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!gotText) {
    const dom = await page.evaluate(() => {
      const layer = document.querySelector(".textLayer");
      return {
        canvases: document.querySelectorAll("canvas").length,
        textLayers: document.querySelectorAll(".textLayer").length,
        spans: layer ? layer.children.length : -1,
        markup: layer ? layer.innerHTML.slice(0, 200) : null,
      };
    });
    assert.fail(
      `the text layer never carried the PDF's text: ${JSON.stringify(dom)}` +
        `\n  errors: ${JSON.stringify(errors.slice(0, 8))}` +
        `\n  warnings: ${JSON.stringify(warnings.slice(0, 12))}`,
    );
  }
  assert.deepEqual(errors, [], "opening a PDF should not log errors");
});

test("two local workspaces are two libraries, both served at once", async (t) => {
  const shellProfile = profile("two");
  const app = await launch(shellProfile);
  t.after(() => app.close().catch(() => {}));

  const firstPage = await createLocal(app, "First");
  const firstUrl = firstPage.url();

  // Back to the launcher through the switcher, then make a second library.
  const bar = await barPage(app);
  await bar.click("#switcher");
  await bar.waitForSelector(".menu:not([hidden])");
  assert.deepEqual(
    await bar.$$eval(".menu .item .name", (els) => els.map((e) => e.textContent)),
    ["First", "All workspaces…"],
  );
  await bar.click(".menu .item >> nth=-1");

  const second = await createLocal(app, "Second");
  assert.notEqual(new URL(second.url()).port, new URL(firstUrl).port, "on its own port");

  const workspaces = await inspect(app, (shell) => shell.registry.load().workspaces);
  assert.equal(workspaces.length, 2);
  assert.notEqual(workspaces[0].dataDir, workspaces[1].dataDir, "and its own library");
  for (const ws of workspaces) {
    assert.ok(fs.existsSync(path.join(ws.dataDir, "users.db")), `${ws.name} has a library`);
  }

  // Both servers stay up, which is what makes switching back instant.
  assert.deepEqual(
    await inspect(app, (shell) =>
      shell.registry.load().workspaces.map((w) => Boolean(shell.sidecars().status(w.id))),
    ),
    [true, true],
  );

  await bar.click("#switcher");
  await bar.waitForSelector(".menu:not([hidden])");
  await bar.click(".menu .item >> nth=0");
  await waitFor(
    async () => (await inspect(app, (shell) => shell.current().name)) === "First",
    "the first workspace to be current again",
  );
  const back = await workspacePage(app);
  assert.equal(new URL(back.url()).port, new URL(firstUrl).port, "the same server as before");
});

test("a workspace whose server dies gets it back", async (t) => {
  const shellProfile = profile("restart");
  const app = await launch(shellProfile);
  t.after(() => app.close().catch(() => {}));

  const page = await createLocal(app, "Papers");
  const ws = await inspect(app, (shell) => shell.registry.load().workspaces[0]);
  const recordPath = path.join(ws.dataDir, "desktop.json");
  const first = JSON.parse(fs.readFileSync(recordPath, "utf8"));

  // Simulate a crash: no cleanup, no chance to release anything.
  process.kill(first.pid, "SIGKILL");
  assert.ok(await waitFor(() => !pidAlive(first.pid), "the server to die"), "server dead");

  // The supervisor starts a new one, on whatever port it gets…
  const next = await waitFor(() => {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return record.pid !== first.pid && pidAlive(record.pid) ? record : null;
  }, "a replacement server", 60_000);
  assert.notEqual(next.port, undefined);

  // …and the window comes back on its own. Polled, because the shell reloads
  // it a moment after the new server records itself.
  assert.ok(
    await waitFor(async () => {
      try {
        const session = await page.evaluate(() => fetch("/api/session").then((r) => r.json()));
        return session.user === "local";
      } catch {
        return false; // mid-navigation
      }
    }, "the window to be usable again", 60_000),
    "recovered",
  );
  await page.waitForSelector(".homeFindInput", { timeout: READY_TIMEOUT });
});

test("a server that never comes up is killed, not left behind", async (t) => {
  if (process.platform === "win32") {
    t.skip("needs a POSIX shell for the stand-in interpreter");
    return;
  }
  // A packaged build carries its own interpreter and ignores GAMMA_PYTHON.
  if (packagedApp) {
    t.skip("GAMMA_PYTHON only applies to a source checkout");
    return;
  }

  const shellProfile = profile("wedged");
  // An interpreter that starts, announces nothing, and sits there — the shape
  // of a backend wedged on import or on a locked database.
  const fake = path.join(shellProfile, "wedged-python");
  const pidFile = path.join(shellProfile, "wedged.pid");
  fs.writeFileSync(fake, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 600\n`);
  fs.chmodSync(fake, 0o755);

  const app = await launch(shellProfile, {
    GAMMA_PYTHON: fake,
    GAMMA_READY_TIMEOUT_MS: "3000",
  });
  t.after(() => app.close().catch(() => {}));

  const launcher = await launcherPage(app);
  await launcher.click("#addLocal");
  await launcher.fill("#localName", "Wedged");
  await launcher.click("#createLocal");

  // The launcher comes back with the reason rather than hanging.
  await waitFor(async () => {
    const page = await launcherPage(app);
    const text = await page.textContent(".status").catch(() => "");
    return /did not come up|never answered|stopped/i.test(text) ? text : null;
  }, "the launcher to report the failure", 60_000);

  const stray = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(stray > 0, "the stand-in interpreter recorded its pid");
  assert.ok(
    await waitFor(() => !pidAlive(stray), "the wedged process to be killed", 20_000),
    "a server that never announced itself must not be left holding the library",
  );
  assert.equal(
    // `running` is a Map: Object.keys() on it is always empty, which would
    // make this assertion decorative.
    await inspect(app, (shell) => shell.sidecars().running.size),
    0,
    "and it must not be left in the running map either",
  );
});

// --- remote workspaces -------------------------------------------------------

test("a remote workspace loads the server and starts nothing locally", async (t) => {
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

  const shellProfile = profile("remote");
  const app = await launch(shellProfile);
  t.after(() => app.close().catch(() => {}));

  const launcher = await launcherPage(app);
  await launcher.click("#addRemote");
  await launcher.fill("#remoteUrl", origin);
  await launcher.fill("#remoteName", "Home server");
  await launcher.click("#createRemote");

  const page = await workspacePage(app);
  await page.waitForSelector("#remote");
  assert.ok(page.url().startsWith(origin));

  const ws = await inspect(app, (shell) => shell.registry.load().workspaces[0]);
  assert.equal(ws.type, "remote");
  assert.equal(ws.name, "Home server");
  assert.equal(
    await inspect(app, (shell) => Boolean(shell.sidecars().status(shell.current().id))),
    false,
    "a remote workspace must not start a local server",
  );
  assert.equal(
    fs.existsSync(path.join(shellProfile, "workspaces")),
    false,
    "and must not create a local library",
  );
});

test("links out of the app go to the browser, not the content view", async (t) => {
  const shellProfile = profile("links");
  const app = await launch(shellProfile);
  t.after(() => app.close().catch(() => {}));

  const page = await createLocal(app, "Papers");
  const before = page.url();

  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "https://example.com/paper";
    a.textContent = "outbound";
    document.body.append(a);
    a.click();
  });

  const opened = await waitFor(
    async () => {
      const list = await inspect(app, (shell) => shell.externalOpens);
      return list.length ? list : null;
    },
    "the link to be handed to the browser",
  );
  assert.ok(opened.includes("https://example.com/paper"), JSON.stringify(opened));
  assert.equal(page.url(), before, "and the app stays where it was");
});

test("the chrome follows the app's theme", async (t) => {
  const shellProfile = profile("theme");
  const app = await launch(shellProfile);
  t.after(() => app.close().catch(() => {}));

  const page = await createLocal(app, "Papers");

  // Whatever the app resolved on load — Gamma's default preference is
  // "system", so this is the OS's answer — the shell should already agree.
  const initial = await page.evaluate(
    () => document.documentElement.getAttribute("data-theme") || "",
  );
  await waitFor(
    async () => (await inspect(app, (shell) => shell.theme())) === initial,
    `the shell to agree with the page's initial theme (${initial || "dark"})`,
  );

  // Then change it and watch the chrome follow.
  const next = initial === "sepia" ? "gray" : "sepia";
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), next);
  await waitFor(
    async () => (await inspect(app, (shell) => shell.theme())) === next,
    `the shell to follow the page to ${next}`,
  );

  const bar = await barPage(app);
  await bar.waitForFunction(
    (t) => document.documentElement.getAttribute("data-theme") === t,
    next,
  );
  // Remembered, so the chrome is already right next launch, before any page
  // has loaded.
  assert.equal(await inspect(app, (shell) => shell.registry.settings().lastTheme), next);
});

// --- across restarts ---------------------------------------------------------

test("the last workspace reopens, and quitting reaped the old server", async (t) => {
  const shellProfile = profile("relaunch");
  const first = await launch(shellProfile);
  await createLocal(first, "Papers");
  const workspaces = await inspect(first, (shell) => shell.registry.load().workspaces);
  const dataDir = workspaces[0].dataDir;
  const { pid } = JSON.parse(fs.readFileSync(path.join(dataDir, "desktop.json"), "utf8"));
  await first.close();
  assert.ok(await waitFor(() => !pidAlive(pid), "the first server to exit"), "server reaped");

  const again = await launch(shellProfile);
  t.after(() => again.close().catch(() => {}));
  const page = await workspacePage(again);
  await page.waitForSelector(".homeFindInput", { timeout: READY_TIMEOUT });
  assert.equal(
    await inspect(again, (shell) => shell.current().name),
    "Papers",
    "reopened where we left off, without showing the launcher",
  );
  // The same library, not a fresh one beside it.
  const after = await inspect(again, (shell) => shell.registry.load().workspaces);
  assert.equal(after.length, 1);
  assert.equal(after[0].dataDir, dataDir);
});
