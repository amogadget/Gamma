// Server registry: the shell's only persistent state, a JSON file in the
// Electron userData dir. A server is a name plus either a URL (remote) or a
// data directory the shell runs a local Gamma over (local). Gamma's own
// workspaces (the libraries inside a server, with members and roles) live in
// that server's data — the shell only lists them in its switcher.
//
// Local servers also remember the admin credentials the shell generated on
// first run — the server's one-time password print would otherwise be lost
// in the hidden sidecar console.
//
// Besides the list the file keeps a little shell UX state: the server opened
// last (reopened at launch when `openLastOnLaunch`), the theme the Gamma
// page last reported (so the launcher/shell bar paint in it before any page
// is loaded), and the window bounds.
//
// `mirrors` is the map of offline copies (docs/dev/mirror.md): which local
// server + workspace mirrors which remote workspace (`remoteUrl` origin +
// `remoteWs`). Written when the shell makes a copy and replaced from a
// local server's own `/api/mirrors` whenever that server is open, so copies
// made or stopped from Gamma's Settings show up too. The shell keeps no
// sync state and no token — only this map, for the switcher's cross-links
// and for starting the servers that hold copies at launch.
//
// Local server data dirs live under ONE root, `<root>/<server id>`:
// `settings.dataRoot` when set, else `<userData>/workspaces` (the folder
// name predates the rename and stays so existing installs need no move).
// `setDataRoot` switches the root and, on request, moves the existing dirs
// there (copy, verify, re-point the registry, then delete the originals —
// safe across drives; callers stop the sidecars first).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'servers.json';
const LEGACY_FILE = 'workspaces.json'; // the registry's name before servers had that name

const DEFAULTS = {
  settings: {
    // Overrides for dev mode; empty strings mean "auto-detect the repo layout".
    pythonPath: '',
    backendDir: '',
    staticDir: '',
    // Reopen the last server at launch instead of showing the launcher.
    openLastOnLaunch: true,
    // Last data-theme the Gamma page reported ('' = never seen → dark).
    lastTheme: '',
    // Folder new local servers are created in ('' = <userData>/workspaces).
    dataRoot: '',
  },
  servers: [],
  mirrors: [],
  lastOpened: null,
  windowBounds: null,
};

let userDataDir = null;

function init(dir) {
  userDataDir = dir;
  fs.mkdirSync(dir, { recursive: true });
  // One-time rename of the registry file; the old copy stays for a rollback.
  const legacy = path.join(dir, LEGACY_FILE);
  if (!fs.existsSync(filePath()) && fs.existsSync(legacy)) {
    try {
      const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      save({ ...raw, servers: raw.servers || raw.workspaces || [] });
    } catch {}
  }
}

function filePath() {
  return path.join(userDataDir, FILE);
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    const list = Array.isArray(raw.servers) ? raw.servers : Array.isArray(raw.workspaces) ? raw.workspaces : [];
    return {
      settings: { ...DEFAULTS.settings, ...(raw.settings || {}) },
      servers: list,
      mirrors: Array.isArray(raw.mirrors) ? raw.mirrors : [],
      lastOpened: raw.lastOpened || null,
      windowBounds: raw.windowBounds || null,
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function save(state) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const { workspaces, ...rest } = state; // never write the old key back
  fs.writeFileSync(filePath(), JSON.stringify(rest, null, 2));
}

function defaultDataRoot() {
  return path.join(userDataDir, 'workspaces');
}

// Where local servers are created now.
function dataRoot(state = load()) {
  return path.resolve(state.settings.dataRoot || defaultDataRoot());
}

function isUnder(dir, root) {
  const norm = (s) => (process.platform === 'win32' ? path.resolve(s).toLowerCase() : path.resolve(s));
  return norm(dir).startsWith(norm(root) + path.sep);
}

// The local servers whose data dir sits under the current root — the ones a
// root change moves.
function localsUnderRoot(state = load()) {
  const root = dataRoot(state);
  return state.servers.filter((s) => s.type === 'local' && s.dataDir && isUnder(s.dataDir, root));
}

// Change the storage root. `newRoot` '' resets to the default. With `move`
// every local server under the old root is copied to `<newRoot>/<id>`; only
// after ALL copies succeed does the registry switch over and the old copies
// get deleted, so a failure (disk full, permissions) leaves everything as it
// was. Returns { root, moved: [names] }.
function setDataRoot(newRoot, { move = true } = {}) {
  const state = load();
  const oldRoot = dataRoot(state);
  const target = newRoot ? path.resolve(newRoot) : '';
  const targetRoot = target || path.resolve(defaultDataRoot());
  if (targetRoot === oldRoot) return { root: targetRoot, moved: [] };
  if (isUnder(targetRoot, oldRoot) || isUnder(oldRoot, targetRoot)) {
    throw new Error('The new folder must not be inside the current one (or contain it).');
  }
  fs.mkdirSync(targetRoot, { recursive: true });
  const moved = [];
  if (move) {
    for (const srv of localsUnderRoot(state)) {
      const dest = path.join(targetRoot, path.basename(srv.dataDir));
      try {
        if (fs.existsSync(dest)) throw new Error('already exists');
        fs.cpSync(srv.dataDir, dest, { recursive: true }); // throws on any failed file
      } catch (e) {
        for (const m of moved) fs.rmSync(m.dest, { recursive: true, force: true });
        fs.rmSync(dest, { recursive: true, force: true });
        throw new Error(`Could not move "${srv.name}" to ${dest}: ${e.message}`);
      }
      moved.push({ srv, from: srv.dataDir, dest });
    }
    for (const m of moved) m.srv.dataDir = m.dest;
  }
  state.settings.dataRoot = target;
  save(state);
  for (const m of moved) {
    try {
      fs.rmSync(m.from, { recursive: true, force: true });
    } catch {}
  }
  return { root: targetRoot, moved: moved.map((m) => m.srv.name) };
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function newPassword() {
  return crypto.randomBytes(9).toString('base64url'); // 12 chars, like the server's own seed
}

function addLocal(name) {
  const state = load();
  const id = newId();
  const srv = {
    id,
    name: (name || '').trim() || 'Local',
    type: 'local',
    dataDir: path.join(dataRoot(state), id),
    adminUser: 'admin',
    adminPassword: newPassword(),
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(srv.dataDir, { recursive: true });
  state.servers.push(srv);
  save(state);
  return srv;
}

function addRemote(name, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Server URL must be http:// or https://');
  }
  const state = load();
  if (state.servers.some((s) => s.type === 'remote' && s.url === parsed.origin)) {
    throw new Error(`${parsed.origin} is already listed`);
  }
  const srv = {
    id: newId(),
    name: (name || '').trim() || parsed.host,
    type: 'remote',
    url: parsed.origin,
    createdAt: new Date().toISOString(),
  };
  state.servers.push(srv);
  save(state);
  return srv;
}

function get(id) {
  return load().servers.find((s) => s.id === id) || null;
}

function rename(id, name) {
  const state = load();
  const srv = state.servers.find((s) => s.id === id);
  if (!srv) throw new Error('Unknown server');
  const clean = (name || '').trim();
  if (!clean) throw new Error('Name cannot be empty');
  srv.name = clean;
  save(state);
  return srv;
}

function remove(id, { deleteData = false } = {}) {
  const state = load();
  const srv = state.servers.find((s) => s.id === id);
  if (!srv) return;
  state.servers = state.servers.filter((s) => s.id !== id);
  state.mirrors = state.mirrors.filter((m) => m.server !== id);
  if (state.lastOpened === id) state.lastOpened = null;
  save(state);
  if (deleteData && srv.type === 'local' && srv.dataDir) {
    // Guard: only ever delete directories we created — under the default
    // root or the configured one — never an arbitrary folder.
    const resolved = path.resolve(srv.dataDir);
    if (isUnder(resolved, defaultDataRoot()) || isUnder(resolved, dataRoot(state))) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

// Remember which server is open (reopened at next launch).
function markOpened(id) {
  const state = load();
  const srv = state.servers.find((s) => s.id === id);
  if (!srv) return;
  srv.lastOpenedAt = new Date().toISOString();
  state.lastOpened = id;
  save(state);
}

function getLastOpened() {
  const state = load();
  return state.servers.find((s) => s.id === state.lastOpened) || null;
}

function getSettings() {
  return load().settings;
}

function setSettings(patch) {
  const state = load();
  state.settings = { ...state.settings, ...patch };
  save(state);
  return state.settings;
}

function getWindowBounds() {
  return load().windowBounds;
}

function setWindowBounds(bounds) {
  const state = load();
  state.windowBounds = bounds;
  save(state);
}

// --- offline copies -------------------------------------------------------

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return String(url || '');
  }
}

// The copy of a remote workspace, if the shell knows one: { server, workspace, name, remoteUrl, remoteWs, remoteName }.
function findMirror(remoteUrl, remoteWs) {
  const origin = originOf(remoteUrl);
  return load().mirrors.find((m) => m.remoteUrl === origin && m.remoteWs === remoteWs) || null;
}

// The entry of a local server's workspace when that workspace is a copy.
function mirrorOf(serverId, workspaceId) {
  return load().mirrors.find((m) => m.server === serverId && m.workspace === workspaceId) || null;
}

function addMirror(entry) {
  const state = load();
  const clean = { ...entry, remoteUrl: originOf(entry.remoteUrl) };
  state.mirrors = state.mirrors.filter((m) => !(m.server === clean.server && m.workspace === clean.workspace));
  state.mirrors.push(clean);
  save(state);
  return clean;
}

// Replace everything known about one local server's copies with its own list.
function setServerMirrors(serverId, entries) {
  const state = load();
  state.mirrors = state.mirrors
    .filter((m) => m.server !== serverId)
    .concat(entries.map((e) => ({ ...e, server: serverId, remoteUrl: originOf(e.remoteUrl) })));
  save(state);
}

// Bytes on disk under a local server's data dir (SQLite files + uploads).
// Synchronous walk; libraries are at most a few thousand files.
function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

module.exports = {
  init, load, get, addLocal, addRemote, rename, remove, markOpened, getLastOpened,
  getSettings, setSettings, getWindowBounds, setWindowBounds, dirSize,
  defaultDataRoot, dataRoot, localsUnderRoot, setDataRoot,
  originOf, findMirror, mirrorOf, addMirror, setServerMirrors,
};
