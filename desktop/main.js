// Gamma Desktop — the shell.
//
// A *workspace* is a Gamma server: a library on this machine that the shell
// serves, or a Gamma you already run, reached by URL. Opening one points the
// content view at it, so the frontend always comes from the server it talks
// to — no API-base plumbing and no version skew.
//
//   ┌──────────────────────────────────────────────┐
//   │ ⌈γ⌉ My library ▾   Starting Notes…      ⟳    │  bar view (file://),
//   ├──────────────────────────────────────────────┤  doubles as the title bar
//   │  the launcher (file://), or the workspace's   │
//   │  own Gamma frontend (http://…)               │  content view
//   └──────────────────────────────────────────────┘
//
// The shell owns its chrome, the workspace registry and the servers it starts.
// The only thing it reads out of a Gamma page is `data-theme`, so the chrome
// can paint in the same theme.
//
// Two lifecycle rules, both learned the hard way:
//   * A window appears only once there is something real in it. A window that
//     loads nothing is a white rectangle with no explanation.
//   * Quitting *waits* for every server to be gone. An orphan keeps its
//     library's advisory lock and the next launch refuses to start.

const {
  app, BaseWindow, WebContentsView, Menu, ipcMain, shell,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const registry = require("./lib/registry");
const { Sidecars } = require("./lib/sidecar");

const BAR_H = 38;
const ICON = path.join(__dirname, "assets", "icon.png");

// Tests point the shell at a throwaway profile, so a run can neither read nor
// damage a real installation.
if (process.env.GAMMA_SHELL_USER_DATA) {
  app.setPath("userData", process.env.GAMMA_SHELL_USER_DATA);
}

// Window-chrome colours per Gamma theme, mirroring app.css's --bg-surface and
// --text-secondary. "" = the page never reported one → Gamma's default, dark.
const CHROME = {
  "": { bg: "#1a1a1a", symbol: "#dddddd" },
  dark: { bg: "#1a1a1a", symbol: "#dddddd" },
  light: { bg: "#ffffff", symbol: "#333333" },
  sepia: { bg: "#f4ecd8", symbol: "#433422" },
  gray: { bg: "#e8e8e8", symbol: "#2d2d2d" },
};

let win = null;
let bar = null;
let content = null;
/** The open workspace, or null while the launcher is showing. */
let current = null;
/** Status text while something is starting. */
let busy = null;
let theme = "";
let barExpanded = false;
/** Origins the content view may navigate to. Everything else is outbound. */
const allowedOrigins = new Set();
let sidecars = null;
let quitting = false;

// --- helpers -----------------------------------------------------------------

function chrome() {
  return CHROME[theme || registry.settings().lastTheme || ""] || CHROME[""];
}

function isShellSender(event) {
  const url = event.senderFrame ? event.senderFrame.url : "";
  return url.startsWith("file:");
}

/** Wrap an IPC handler so only the shell's own pages can call it. */
function shellOnly(handler) {
  return (event, ...args) => {
    if (!isShellSender(event)) throw new Error("not available to this page");
    return handler(...args);
  };
}

// --- window ------------------------------------------------------------------

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  // The switcher menu needs room below the strip, and a 38px view cannot show
  // it: while the menu is open the bar view grows over the content. Its page
  // is transparent outside the strip and the menu, and a click there closes.
  const barH = barExpanded ? Math.min(h, BAR_H + 460) : BAR_H;
  bar.setBounds({ x: 0, y: 0, width: w, height: barH });
  content.setBounds({ x: 0, y: BAR_H, width: w, height: Math.max(0, h - BAR_H) });
}

function applyChrome() {
  if (!win) return;
  const c = chrome();
  win.setBackgroundColor(c.bg);
  if (process.platform !== "darwin") {
    try {
      win.setTitleBarOverlay({ color: c.bg, symbolColor: c.symbol, height: BAR_H });
    } catch {
      /* only where an overlay exists */
    }
  }
}

function createWindow() {
  const saved = registry.windowBounds();
  const c = chrome();
  win = new BaseWindow({
    width: 1400,
    height: 900,
    minWidth: 860,
    minHeight: 560,
    ...(saved && saved.width > 500 && saved.height > 360
      ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
      : {}),
    title: "Gamma",
    icon: ICON,
    backgroundColor: c.bg,
    show: false,
    // The bar is the title bar: frameless, with the OS controls overlaid on
    // Windows and Linux and the traffic lights inset on macOS.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 12, y: 11 } }
      : { titleBarOverlay: { color: c.bg, symbolColor: c.symbol, height: BAR_H } }),
    autoHideMenuBar: true,
  });
  if (saved && saved.maximized) win.maximize();

  const webPreferences = {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    spellcheck: true,
  };

  bar = new WebContentsView({ webPreferences });
  bar.setBackgroundColor("#00000000");
  content = new WebContentsView({ webPreferences });
  content.setBackgroundColor(c.bg);
  win.contentView.addChildView(content);
  win.contentView.addChildView(bar); // above, so the open menu overlays
  layout();

  for (const event of ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    win.on(event, layout);
  }

  bar.webContents.loadFile(path.join(__dirname, "ui", "bar.html"));
  bar.webContents.on("did-finish-load", pushState);

  const wc = content.webContents;

  // Notes carry outbound links (DOIs, arXiv, link chips, a paper's source
  // URL). In a browser those open a tab; here they go to the real browser,
  // never navigating the app away from itself.
  const guard = (event, url) => {
    if (url.startsWith("file:")) return;
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {
      /* not a URL we can reason about */
    }
    if (origin && allowedOrigins.has(origin)) return;
    event.preventDefault();
    if (origin && /^https?:$/.test(new URL(url).protocol)) openExternal(url);
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) openExternal(url);
    return { action: "deny" };
  });

  wc.on("page-title-updated", (_event, title) => {
    if (!win) return;
    const suffix = current && current.type === registry.REMOTE ? ` — ${current.name}` : "";
    win.setTitle(`${title || "Gamma"}${suffix}`);
  });
  wc.on("did-navigate", pushState);
  wc.on("did-navigate-in-page", pushState);
  wc.on("focus", () => setBarExpanded(false));

  // Exports and backups download through the normal save dialog; tests take
  // them without one.
  wc.session.on("will-download", (_event, item) => {
    const dir = process.env.GAMMA_SHELL_DOWNLOAD_DIR;
    if (dir) item.setSavePath(path.join(dir, item.getFilename()));
  });

  win.on("close", () => {
    try {
      registry.setWindowBounds({ ...win.getNormalBounds(), maximized: win.isMaximized() });
    } catch {
      /* a close mid-move; the old bounds are fine */
    }
  });
  win.on("closed", () => {
    win = null;
    bar = null;
    content = null;
  });
  return win;
}

function openExternal(url) {
  externalOpens.push(url);
  if (!process.env.GAMMA_SHELL_TEST) shell.openExternal(url);
}
const externalOpens = []; // test hook; see the bottom of this file

function setBarExpanded(on) {
  const next = Boolean(on);
  if (next === barExpanded) return;
  barExpanded = next;
  layout();
}

function showWindow() {
  if (win && !win.isVisible()) win.show();
}

/** Show the launcher, optionally with an error to explain why. */
function loadLauncher(error) {
  if (!win) createWindow();
  current = null;
  busy = null;
  const query = error ? `?error=${encodeURIComponent(String(error))}` : "";
  content.webContents.loadURL(
    pathToFileURL(path.join(__dirname, "ui", "launcher.html")).href + query,
  );
  win.setTitle("Gamma");
  showWindow();
  pushState();
  buildMenu();
}

// --- state pushed to the shell's pages ---------------------------------------

function barState() {
  const state = registry.load();
  return {
    platform: process.platform,
    version: app.getVersion(),
    theme: theme || state.settings.lastTheme || "",
    current,
    busy,
    workspaces: state.workspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,
      type: ws.type,
      running: ws.type === registry.LOCAL ? Boolean(sidecars.status(ws.id)) : undefined,
    })),
  };
}

/** The launcher's fuller view: paths, sizes, settings. */
function detailState() {
  const state = registry.load();
  return {
    ...barState(),
    userDataDir: app.getPath("userData"),
    settings: state.settings,
    lastOpened: state.lastOpened,
    workspaces: state.workspaces.map((ws) => ({
      ...ws,
      running: ws.type === registry.LOCAL ? Boolean(sidecars.status(ws.id)) : undefined,
      url: ws.type === registry.REMOTE ? ws.url : (sidecars.status(ws.id) || {}).url,
      sizeBytes: ws.type === registry.LOCAL ? registry.dirSize(ws.dataDir) : undefined,
      logPath: ws.type === registry.LOCAL ? registry.logPath(ws.id) : undefined,
      // A library the shell did not create is never a candidate for deletion.
      owned:
        ws.type === registry.LOCAL &&
        path.resolve(ws.dataDir).startsWith(path.resolve(registry.workspacesDir()) + path.sep),
    })),
  };
}

function pushState() {
  const state = barState();
  for (const view of [bar, content]) {
    const wc = view && view.webContents;
    if (!wc || wc.isDestroyed()) continue;
    // Only the shell's own pages get shell state.
    if (view === content && !wc.getURL().startsWith("file:")) continue;
    wc.send("shell:state", state);
  }
}

// --- opening a workspace -----------------------------------------------------

let opening = null;

/** Serialised: a second click while one open is in flight waits for it. */
async function openWorkspace(id) {
  if (opening) await opening.catch(() => {});
  opening = openWorkspaceNow(id);
  try {
    return await opening;
  } finally {
    opening = null;
  }
}

async function openWorkspaceNow(id) {
  const ws = registry.get(id);
  if (!ws) throw new Error("That workspace is gone.");
  if (!win) createWindow();
  if (current && current.id === id) {
    showWindow();
    return { url: current.url };
  }

  busy = ws.type === registry.LOCAL ? `Starting ${ws.name}…` : `Connecting to ${ws.name}…`;
  setBarExpanded(false);
  pushState();
  try {
    let url;
    if (ws.type === registry.REMOTE) {
      // Check before pointing a window at it: a browser error page tells the
      // user nothing they can act on.
      const probe = await probeServer(ws.url);
      if (!probe.ok) throw new Error(probe.error);
      url = probe.url;
    } else {
      url = (await sidecars.start(ws)).url;
    }
    allowedOrigins.add(new URL(url).origin);
    await content.webContents.loadURL(url);
    current = { id: ws.id, name: ws.name, type: ws.type, url };
    registry.markOpened(ws.id);
    content.webContents.focus();
    showWindow();
    return { url };
  } catch (err) {
    current = null;
    throw err;
  } finally {
    busy = null;
    pushState();
    buildMenu();
  }
}

/** Is there a Gamma at this address, and if not, which way did it fail? */
async function probeServer(raw) {
  const url = registry.normalizeUrl(raw);
  if (!url) return { ok: false, error: "That doesn't look like a web address." };
  let res;
  try {
    res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    return {
      ok: false,
      error:
        err && err.name === "TimeoutError"
          ? "No answer from that address."
          : `Couldn't reach that address (${(err && err.message) || "network error"}).`,
    };
  }
  if (!res.ok) {
    return { ok: false, error: `That address answered with ${res.status}. Is it a Gamma server?` };
  }
  try {
    const body = await res.json();
    if (!body || body.ok !== true) throw new Error("unexpected body");
  } catch {
    return { ok: false, error: "Something answered there, but it isn't Gamma." };
  }
  return { ok: true, url };
}

// --- menu --------------------------------------------------------------------

function buildMenu() {
  const { workspaces } = registry.load();
  const wc = () => (content ? content.webContents : null);
  const isMac = process.platform === "darwin";

  // Deliberately thin: every accelerator here takes a keystroke away from the
  // page, and Gamma binds a lot of them.
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "Workspace",
      submenu: [
        {
          label: "All Workspaces…",
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => loadLauncher(),
        },
        { type: "separator" },
        ...workspaces.map((ws) => ({
          label: ws.name + (ws.type === registry.REMOTE ? "  (remote)" : ""),
          type: "checkbox",
          checked: Boolean(current && current.id === ws.id),
          click: () => openWorkspace(ws.id).catch((e) => loadLauncher(e.message || e)),
        })),
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          // Not role:"reload" — after a server restart the workspace may be on
          // a different port, so reloading has to go through the shell.
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => reloadContent(),
        },
        { label: "Toggle Developer Tools", accelerator: isMac ? "Alt+Cmd+I" : "Ctrl+Shift+I",
          click: () => wc() && wc().toggleDevTools() },
        { type: "separator" },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => wc() && wc().setZoomLevel(0) },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=",
          click: () => wc() && wc().setZoomLevel(wc().getZoomLevel() + 0.5) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-",
          click: () => wc() && wc().setZoomLevel(wc().getZoomLevel() - 0.5) },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function reloadContent() {
  if (!content) return;
  if (current && current.url) content.webContents.loadURL(current.url);
  else content.webContents.reload();
}

// --- ipc ---------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle("shell:state", shellOnly(() => barState()));
  ipcMain.handle("shell:details", shellOnly(() => detailState()));

  ipcMain.handle("shell:open", shellOnly(async (id) => {
    try {
      return await openWorkspace(id);
    } catch (err) {
      // The launcher shows the reason; the caller gets it too.
      loadLauncher(err.message || err);
      throw err;
    }
  }));

  ipcMain.handle("shell:add-local", shellOnly((name) => {
    const ws = registry.addLocal(name);
    pushState();
    buildMenu();
    return ws;
  }));

  ipcMain.handle("shell:add-remote", shellOnly(async (name, url) => {
    const probe = await probeServer(url);
    if (!probe.ok) throw new Error(probe.error);
    const ws = registry.addRemote(name, probe.url);
    pushState();
    buildMenu();
    return ws;
  }));

  ipcMain.handle("shell:probe", shellOnly((url) => probeServer(url)));

  ipcMain.handle("shell:rename", shellOnly((id, name) => {
    const ws = registry.rename(id, name);
    if (current && current.id === id) current = { ...current, name: ws.name };
    pushState();
    buildMenu();
    return ws;
  }));

  ipcMain.handle("shell:remove", shellOnly(async (id, opts) => {
    const wasCurrent = Boolean(current && current.id === id);
    await sidecars.stop(id);
    const result = registry.remove(id, opts || {});
    if (wasCurrent) loadLauncher();
    else {
      pushState();
      buildMenu();
    }
    return result;
  }));

  ipcMain.handle("shell:launcher", shellOnly(() => loadLauncher()));
  ipcMain.handle("shell:reload", shellOnly(() => reloadContent()));
  ipcMain.handle("shell:bar-expand", shellOnly((on) => setBarExpanded(on)));

  ipcMain.handle("shell:reveal-data", shellOnly((id) => {
    const ws = registry.get(id);
    if (ws && ws.type === registry.LOCAL) shell.openPath(ws.dataDir);
  }));

  ipcMain.handle("shell:reveal-log", shellOnly((id) => {
    const p = registry.logPath(id);
    if (fs.existsSync(p)) shell.showItemInFolder(p);
  }));

  ipcMain.handle("shell:read-log", shellOnly((id) => {
    try {
      const text = fs.readFileSync(registry.logPath(id), "utf8");
      return text.split(/\r?\n/).slice(-400).join("\n");
    } catch {
      return "(nothing logged yet)";
    }
  }));

  ipcMain.handle("shell:set-settings", shellOnly((patch) => registry.setSettings(patch)));

  // The theme mirror is the one channel a Gamma page may use, and all it can
  // do is name a theme.
  ipcMain.on("shell:theme", (event, value) => {
    if (!content || event.sender !== content.webContents) return;
    const clean = typeof value === "string" && CHROME[value] ? value : "";
    if (clean === theme) return;
    theme = clean;
    registry.setSettings({ lastTheme: clean });
    applyChrome();
    pushState();
  });
}

// --- lifecycle ---------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    registry.init(app.getPath("userData"));
    sidecars = new Sidecars({
      logDir: path.join(app.getPath("userData"), "logs"),
      onState: pushState,
      onRespawn: (id, info) => {
        // Back on a (possibly different) port: point the window at it.
        if (!current || current.id !== id) return;
        allowedOrigins.add(new URL(info.url).origin);
        current = { ...current, url: info.url };
        content.webContents.loadURL(info.url);
      },
      onGaveUp: (id, message, tail) => {
        if (current && current.id === id) loadLauncher(`${message}\n\n${tail}`);
        else pushState();
      },
    });

    registerIpc();
    buildMenu();
    createWindow();

    // Carry over the pre-workspaces configuration, pointing at the library it
    // used rather than a fresh one.
    let openId = null;
    try {
      const { defaultDataDir } = require("./lib/legacy");
      openId = registry.migrateFromSingleMode({ defaultDataDir: defaultDataDir() });
    } catch (err) {
      console.error("migration skipped:", err && err.message);
    }

    const settings = registry.settings();
    const last = openId ? registry.get(openId) : settings.openLastOnLaunch ? registry.lastOpened() : null;
    if (last) {
      openWorkspace(last.id).catch((err) => loadLauncher(err.message || err));
    } else {
      loadLauncher();
    }

    app.on("activate", () => {
      if (win) {
        showWindow();
        return;
      }
      createWindow();
      if (current && current.url) content.webContents.loadURL(current.url);
      else loadLauncher();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Quit means quit: every server must be gone before the process exits.
  app.on("before-quit", (event) => {
    if (quitting || !sidecars) return;
    event.preventDefault();
    quitting = true;
    sidecars.stopAll().finally(() => app.quit());
  });
}

// Test hook. Only with GAMMA_SHELL_TEST, and only reachable from the main
// process, so the suite can assert on shell internals instead of scraping the
// UI for them.
if (process.env.GAMMA_SHELL_TEST) {
  global.__gammaShell = {
    registry,
    sidecars: () => sidecars,
    current: () => current,
    theme: () => theme,
    externalOpens,
    barExpanded: () => barExpanded,
    bounds: () => ({ bar: bar && bar.getBounds(), content: content && content.getBounds() }),
    openWorkspace,
    loadLauncher,
  };
}

module.exports = { probeServer };
