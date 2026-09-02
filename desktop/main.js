// Gamma Desktop — Electron main process.
//
// Two modes, chosen on first launch and changeable from the menu:
//
//   local   — start the bundled Python backend and show that. No account, no
//             network; the library sits in the platform's app-support dir.
//   remote  — point the window at a Gamma the user already runs somewhere,
//             and let them sign in as usual. Nothing is spawned locally.
//
// In both cases the window is the app's own window: no browser is ever opened,
// except for genuinely outbound links the user clicks inside a note.
//
// Startup order matters. A window is only shown once there is something real to
// load — showing one first and letting it fail is how you get a white rectangle
// with no explanation.

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");

// macOS reads the icon from the bundle; Linux and Windows want it on the window
// itself, or the taskbar shows Electron's default.
const ICON = path.join(__dirname, "assets", "icon.png");

const config = require("./config");
const { Supervisor } = require("./supervisor");
const { buildMenu } = require("./menu");

// One instance per machine. The backend has its own lock on the library, but
// catching it here is nicer: focus the window that already exists instead of
// starting a doomed second copy.
const gotLock = app.requestSingleInstanceLock();

let win = null;
let chooser = null;
let supervisor = null;
let settings = null;
/** The URL the content window should be showing — the reload target. */
let baseUrl = "";
let fatalShown = false;
/** Set when settings came from the environment, so we don't persist over them. */
let settingsFromEnv = false;
/**
 * True while the app deliberately has no window on screen — during startup and
 * while switching modes. Without it, `window-all-closed` fires the moment the
 * chooser closes and quits the app before its window exists.
 */
let starting = true;

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 150;
const PROBE_TIMEOUT_MS = 8000;

// --- readiness ---------------------------------------------------------------

/** Resolve once the backend answers /api/health, or reject after a timeout. */
async function waitForHealth(origin, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("the backend did not become ready");
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
}

/**
 * Is there a Gamma at this address? Runs in the main process, so it is not
 * subject to page CORS, and it tells the user *which* way it failed.
 */
async function probeServer(raw) {
  const url = config.normalizeServerUrl(raw);
  if (!url) return { ok: false, error: "That doesn't look like a web address." };
  let res;
  try {
    res = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (e) {
    const msg = e && e.name === "TimeoutError"
      ? "No answer from that address."
      : `Couldn't reach that address (${(e && e.message) || "network error"}).`;
    return { ok: false, error: msg };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: `That address answered with ${res.status}. Is it a Gamma server?`,
    };
  }
  try {
    const body = await res.json();
    if (!body || body.ok !== true) throw new Error("unexpected body");
  } catch {
    return { ok: false, error: "Something answered there, but it isn't Gamma." };
  }
  return { ok: true, url };
}

// --- windows -----------------------------------------------------------------

function isAppUrl(target) {
  if (!baseUrl) return false;
  try {
    return new URL(target).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function createWindow(url) {
  baseUrl = url;
  starting = false;
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "Gamma",
    icon: ICON,
    backgroundColor: "#111", // the app's own page colour; avoids a white flash
    webPreferences: {
      // No preload here on purpose: this window loads Gamma's UI, remote pages
      // in remote mode, and AI output. Nothing in it needs Node or IPC.
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    win = null;
  });

  // In remote mode, say where you are — otherwise two Gammas look identical.
  win.on("page-title-updated", (event, title) => {
    event.preventDefault();
    const suffix = settings && settings.mode === config.REMOTE
      ? ` — ${new URL(settings.serverUrl).host}`
      : "";
    win.setTitle(`${title || "Gamma"}${suffix}`);
  });

  // Notes carry outbound links (DOIs, arXiv, link chips, a paper's source URL).
  // In a browser those open a tab; here they must go to the real browser rather
  // than navigating the app away from itself.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isAppUrl(target)) return { action: "allow" };
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (isAppUrl(target)) return;
    event.preventDefault();
    if (/^https?:/i.test(target)) shell.openExternal(target);
  });

  win.loadURL(url);
  return win;
}

function openChooser({ canCancel }) {
  if (chooser) {
    chooser.focus();
    return chooser;
  }
  chooser = new BrowserWindow({
    width: 620,
    height: 520,
    resizable: false,
    show: false,
    title: "Gamma",
    icon: ICON,
    backgroundColor: "#111",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "chooser", "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  chooser.chooserCanCancel = !!canCancel;
  chooser.once("ready-to-show", () => chooser.show());
  chooser.on("closed", () => {
    chooser = null;
    // Closing the chooser on a first run means the user never chose; there is
    // nothing to show, so quit rather than sit as an invisible process.
    if (!win && !settings) app.quit();
  });
  chooser.loadFile(path.join(__dirname, "chooser", "index.html"));
  return chooser;
}

function showFatal(message, detail) {
  if (fatalShown) return;
  fatalShown = true;
  dialog.showMessageBoxSync({
    type: "error",
    title: "Gamma",
    message,
    detail: (detail || "").slice(-4000),
    buttons: ["Quit"],
  });
  app.exit(1);
}

// --- modes -------------------------------------------------------------------

function startLocal() {
  supervisor = new Supervisor({
    onReady: async (info) => {
      try {
        await waitForHealth(`http://127.0.0.1:${info.port}`);
      } catch {
        showFatal("Gamma's backend started but never answered.", supervisor.tail());
        return;
      }
      closeChooser();
      if (win) {
        // A restart after a crash: the window exists, just reload it.
        baseUrl = info.url;
        win.loadURL(info.url);
      } else {
        createWindow(info.url);
      }
    },
    onBusy: (info) => {
      // The library is owned by another process — most likely a copy of this
      // app started from a different location. Show that one rather than
      // refusing to do anything.
      if (!info.port) {
        showFatal(
          "Another copy of Gamma is already using your library.",
          "Quit it and try again.",
        );
        return;
      }
      waitForHealth(`http://127.0.0.1:${info.port}`, 10_000)
        .then(() => {
          closeChooser();
          createWindow(`http://127.0.0.1:${info.port}/`);
        })
        .catch(() =>
          showFatal(
            "Another copy of Gamma is already using your library.",
            `It reported port ${info.port} but is not answering. Quit it and try again.`,
          ),
        );
    },
    onFatal: showFatal,
    onLog: (line) => {
      if (process.env.GAMMA_DESKTOP_VERBOSE) console.log(`[backend] ${line}`);
    },
  });
  supervisor.start();
}

function startRemote(url) {
  closeChooser();
  createWindow(`${url}/`);
}

function start(next) {
  settings = next;
  if (next.mode === config.REMOTE) startRemote(next.serverUrl);
  else startLocal();
}

function closeChooser() {
  if (!chooser) return;
  const c = chooser;
  chooser = null;
  c.destroy();
}

/** Tear down whatever mode is running, so the other one can start clean. */
async function teardown() {
  if (supervisor) {
    const s = supervisor;
    supervisor = null;
    await s.stop();
  }
  baseUrl = "";
  if (win) {
    const w = win;
    win = null;
    w.destroy();
  }
}

async function switchTo(choice) {
  starting = true; // the old window goes before the new one arrives
  await teardown();
  const next = {
    mode: choice.mode === config.REMOTE ? config.REMOTE : config.LOCAL,
    serverUrl: choice.serverUrl || "",
    recentServers: (settings && settings.recentServers) || [],
  };
  if (!settingsFromEnv) {
    const saved = config.write(app.getPath("userData"), next);
    next.recentServers = saved.recentServers;
  }
  fatalShown = false;
  start(next);
}

// --- ipc ---------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle("chooser:state", (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    const saved = settings || config.read(app.getPath("userData")) || {};
    return {
      mode: saved.mode || config.LOCAL,
      serverUrl: saved.serverUrl || "",
      recentServers: saved.recentServers || [],
      canCancel: !!(w && w.chooserCanCancel),
    };
  });

  ipcMain.handle("chooser:probe", (_event, url) => probeServer(url));

  ipcMain.handle("chooser:choose", async (_event, choice) => {
    try {
      await switchTo(choice || {});
      return { ok: true };
    } catch (e) {
      return { error: (e && e.message) || "Couldn't start." };
    }
  });

  ipcMain.handle("chooser:cancel", () => {
    // Only meaningful when there is something to go back to; the chooser only
    // offers Cancel in that case.
    closeChooser();
    if (!win && baseUrl) createWindow(baseUrl);
    return { ok: true };
  });
}

// --- lifecycle ---------------------------------------------------------------

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const target = win || chooser;
    if (target) {
      if (target.isMinimized()) target.restore();
      target.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    buildMenu({
      getWindow: () => win,
      getSupervisor: () => supervisor,
      getSettings: () => settings,
      reload: () => win && baseUrl && win.loadURL(baseUrl),
      openChooser: () => openChooser({ canCancel: true }),
    });

    const fromEnv = config.fromEnv();
    if (fromEnv) {
      settingsFromEnv = true;
      start(fromEnv);
      return;
    }
    const saved = config.read(app.getPath("userData"));
    if (saved) start(saved);
    else openChooser({ canCancel: false }); // first run: ask before doing anything
  });

  // macOS convention: closing the window does not quit. The Dock icon reopens
  // it, and in local mode the backend keeps running in the meantime.
  app.on("activate", () => {
    if (win || chooser) return;
    if (baseUrl) createWindow(baseUrl);
    else openChooser({ canCancel: false });
  });

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return;
    // Fires when the chooser closes too, so check both that no window is left
    // and that none is on its way.
    if (starting || BrowserWindow.getAllWindows().length > 0) return;
    app.quit();
  });

  // Quit means quit: the backend must be dead before the process exits, or it
  // keeps the library's single-instance lock and the next launch refuses.
  let cleanupDone = false;
  app.on("before-quit", (event) => {
    if (cleanupDone || !supervisor) return;
    event.preventDefault();
    supervisor.stop().then(() => {
      cleanupDone = true;
      app.quit();
    });
  });
}

module.exports = { isAppUrl, waitForHealth, probeServer };
