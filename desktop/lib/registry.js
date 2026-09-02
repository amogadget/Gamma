// The workspace registry: the shell's only persistent state.
//
// A *workspace* is a Gamma server. Two kinds:
//
//   local  — a library directory on this machine, served by a backend the
//            shell starts for it
//   remote — a Gamma someone already runs, reached by URL, with its own login
//
// They are independent servers with no synchronisation between them; moving
// notes across is Gamma's own export/import. Several local workspaces means
// several libraries and one server process each.
//
// Everything lives in one JSON file in Electron's userData directory. It is
// written rename-over-tmp, and anything unreadable is treated as "no
// workspaces yet" rather than a reason to refuse to start.
//
// Deliberately *not* stored here: passwords. A local workspace needs none —
// the backend signs the user in when the request comes from this machine (see
// gamma/auth.py, desktop_auto_user), which is three checks in code rather than
// an admin credential sitting in plaintext next to the library.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FILE = "workspaces.json";
const LOCAL = "local";
const REMOTE = "remote";

const DEFAULT_SETTINGS = {
  // Reopen the workspace that was open last, instead of the launcher.
  openLastOnLaunch: true,
  // The last data-theme the Gamma page reported, so the chrome is already
  // right before any page has loaded. "" means never seen → dark.
  lastTheme: "",
};

let root = null;

function init(userDataDir) {
  root = userDataDir;
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function dir() {
  if (!root) throw new Error("registry.init() has not been called");
  return root;
}

function file() {
  return path.join(dir(), FILE);
}

/** Where a new local workspace's library goes. */
function workspacesDir() {
  return path.join(dir(), "workspaces");
}

function logPath(id) {
  return path.join(dir(), "logs", `${id}.log`);
}

function blank() {
  return { settings: { ...DEFAULT_SETTINGS }, workspaces: [], lastOpened: null, windowBounds: null };
}

function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return blank();
  }
  if (!raw || typeof raw !== "object") return blank();
  return {
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    workspaces: (Array.isArray(raw.workspaces) ? raw.workspaces : []).filter(valid),
    lastOpened: raw.lastOpened || null,
    windowBounds: raw.windowBounds || null,
  };
}

/** A workspace we can actually act on. Anything else is dropped on read. */
function valid(ws) {
  if (!ws || typeof ws !== "object" || !ws.id || !ws.name) return false;
  if (ws.type === LOCAL) return typeof ws.dataDir === "string" && ws.dataDir.length > 0;
  if (ws.type === REMOTE) return typeof ws.url === "string" && ws.url.length > 0;
  return false;
}

function save(state) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  // Rename over: a power cut leaves the old file, not a truncated one.
  fs.renameSync(tmp, file());
  return state;
}

function newId() {
  return crypto.randomBytes(6).toString("hex");
}

/** Trim, add a scheme if the user typed a bare host, drop trailing slashes. */
function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (scheme) {
    // Reject any other scheme rather than prefixing https:// onto it — that
    // turns "file:///etc/passwd" into parseable nonsense.
    if (!/^https?$/i.test(scheme[1])) return "";
  } else {
    s = `https://${s}`;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return "";
  }
  if (!u.hostname) return "";
  // A path prefix is kept (Gamma may be hosted under a subpath); a query or
  // fragment is not part of an address to point a window at.
  return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "");
}

function addLocal(name, { dataDir } = {}) {
  const state = load();
  const id = newId();
  const ws = {
    id,
    type: LOCAL,
    name: String(name || "").trim() || "My library",
    dataDir: dataDir || path.join(workspacesDir(), id),
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(ws.dataDir, { recursive: true });
  state.workspaces.push(ws);
  save(state);
  return ws;
}

function addRemote(name, url) {
  const clean = normalizeUrl(url);
  if (!clean) throw new Error("That doesn't look like a web address.");
  const state = load();
  if (state.workspaces.some((w) => w.type === REMOTE && w.url === clean)) {
    throw new Error(`${clean} is already a workspace.`);
  }
  const ws = {
    id: newId(),
    type: REMOTE,
    name: String(name || "").trim() || new URL(clean).host,
    url: clean,
    createdAt: new Date().toISOString(),
  };
  state.workspaces.push(ws);
  save(state);
  return ws;
}

function get(id) {
  return load().workspaces.find((w) => w.id === id) || null;
}

function rename(id, name) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("A workspace needs a name.");
  const state = load();
  const ws = state.workspaces.find((w) => w.id === id);
  if (!ws) throw new Error("That workspace is gone.");
  ws.name = clean;
  save(state);
  return ws;
}

/**
 * Forget a workspace, and optionally delete its library.
 *
 * `deleteData` only ever removes a directory the shell itself created under
 * userData/workspaces. A workspace adopted from elsewhere — the library the
 * pre-workspaces app used, say — is forgotten but never deleted, because the
 * user did not put it there and may well have it in a backup set.
 */
function remove(id, { deleteData = false } = {}) {
  const state = load();
  const ws = state.workspaces.find((w) => w.id === id);
  if (!ws) return { removed: false, deleted: false };
  state.workspaces = state.workspaces.filter((w) => w.id !== id);
  if (state.lastOpened === id) state.lastOpened = null;
  save(state);

  let deleted = false;
  if (deleteData && ws.type === LOCAL) {
    const owned = path.resolve(workspacesDir()) + path.sep;
    const target = path.resolve(ws.dataDir);
    if (target.startsWith(owned)) {
      fs.rmSync(target, { recursive: true, force: true });
      deleted = true;
    }
  }
  try {
    fs.unlinkSync(logPath(id));
  } catch {
    /* no log yet */
  }
  return { removed: true, deleted };
}

function markOpened(id) {
  const state = load();
  const ws = state.workspaces.find((w) => w.id === id);
  if (!ws) return null;
  ws.lastOpenedAt = new Date().toISOString();
  state.lastOpened = id;
  save(state);
  return ws;
}

function lastOpened() {
  const state = load();
  return state.workspaces.find((w) => w.id === state.lastOpened) || null;
}

function settings() {
  return load().settings;
}

function setSettings(patch) {
  const state = load();
  state.settings = { ...state.settings, ...(patch || {}) };
  save(state);
  return state.settings;
}

function windowBounds() {
  return load().windowBounds;
}

function setWindowBounds(bounds) {
  const state = load();
  state.windowBounds = bounds;
  save(state);
}

/** Bytes under a library directory. Synchronous; libraries are small trees. */
function dirSize(target) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  walk(target);
  return total;
}

/**
 * Carry over the single-mode configuration the shell used before workspaces
 * existed (`settings.json`: `{mode, serverUrl, recentServers}`).
 *
 * The important part is the local library. That version kept it in the
 * platform's application-support directory, *not* under userData/workspaces —
 * so the migrated workspace points at the old path and is never a candidate
 * for "delete everything". Losing someone's notes to a refactor is not a
 * recoverable mistake.
 *
 * Returns the id to open, or null when there was nothing to migrate.
 */
function migrateFromSingleMode({ defaultDataDir }) {
  const legacyFile = path.join(dir(), "settings.json");
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
  } catch {
    return null;
  }
  const state = load();
  if (state.workspaces.length) return null; // already migrated

  let openId = null;
  if (legacy.mode === LOCAL && defaultDataDir) {
    const ws = addLocal("My library", { dataDir: defaultDataDir });
    openId = ws.id;
  }
  const urls = [legacy.serverUrl, ...(legacy.recentServers || [])]
    .map(normalizeUrl)
    .filter(Boolean);
  for (const url of [...new Set(urls)]) {
    try {
      const ws = addRemote("", url);
      if (legacy.mode === REMOTE && normalizeUrl(legacy.serverUrl) === url) openId = ws.id;
    } catch {
      /* duplicate or unusable — skip it */
    }
  }
  if (openId) markOpened(openId);
  // Keep the old file: it costs nothing and makes the migration reversible by
  // hand if it got something wrong.
  fs.renameSync(legacyFile, `${legacyFile}.migrated`);
  return openId;
}

module.exports = {
  init, load, save, get, addLocal, addRemote, rename, remove,
  markOpened, lastOpened, settings, setSettings, windowBounds, setWindowBounds,
  dirSize, normalizeUrl, migrateFromSingleMode,
  workspacesDir, logPath, LOCAL, REMOTE, FILE, DEFAULT_SETTINGS,
};
