// Persisted desktop settings: which mode the app runs in, and which server it
// talks to when that mode is "remote".
//
// One small JSON file in Electron's userData directory. Not the library — the
// library lives wherever the backend puts it, and a corrupt settings file must
// never be able to lose notes. Anything unreadable is treated as "no choice
// made yet", which lands the user back on the chooser.

const fs = require("node:fs");
const path = require("node:path");

const FILE = "settings.json";
const MAX_RECENT = 5;

const LOCAL = "local";
const REMOTE = "remote";

function file(userDataDir) {
  return path.join(userDataDir, FILE);
}

/** Trim, add a scheme if the user typed a bare host, and drop a trailing slash. */
function normalizeServerUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (scheme) {
    // Reject any other scheme outright. Prefixing https:// onto e.g.
    // "file:///etc/passwd" would produce a URL that parses but is nonsense.
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
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  if (!u.hostname) return "";
  // Keep any path prefix (someone may host Gamma under /gamma) but no query or
  // fragment, and no trailing slash so `${url}/api/health` is well formed.
  const base = `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "");
  return base;
}

function read(userDataDir) {
  let raw;
  try {
    raw = fs.readFileSync(file(userDataDir), "utf8");
  } catch {
    return null; // no file yet — first launch
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null; // corrupt — ask again rather than guessing
  }
  if (!data || typeof data !== "object") return null;

  const mode = data.mode === REMOTE ? REMOTE : data.mode === LOCAL ? LOCAL : null;
  if (!mode) return null;
  const serverUrl = normalizeServerUrl(data.serverUrl);
  // "Remote" with no usable address is not a choice we can act on.
  if (mode === REMOTE && !serverUrl) return null;

  const recent = Array.isArray(data.recentServers)
    ? data.recentServers.map(normalizeServerUrl).filter(Boolean).slice(0, MAX_RECENT)
    : [];
  return { mode, serverUrl, recentServers: recent };
}

function write(userDataDir, settings) {
  const mode = settings.mode === REMOTE ? REMOTE : LOCAL;
  const serverUrl = normalizeServerUrl(settings.serverUrl);
  const prev = read(userDataDir);
  const recent = [
    ...(mode === REMOTE && serverUrl ? [serverUrl] : []),
    ...((prev && prev.recentServers) || []),
  ];
  const out = {
    mode,
    serverUrl,
    recentServers: [...new Set(recent)].slice(0, MAX_RECENT),
  };
  fs.mkdirSync(userDataDir, { recursive: true });
  // Write-then-rename: a power cut mid-write leaves the old file, not a
  // truncated one that would silently reset the user's choice.
  const tmp = `${file(userDataDir)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
  fs.renameSync(tmp, file(userDataDir));
  return out;
}

/**
 * Environment overrides, for tests and for anyone scripting the app. These
 * bypass the chooser without touching the saved settings, so a test run cannot
 * clobber a real configuration.
 */
function fromEnv(env = process.env) {
  const mode = (env.GAMMA_DESKTOP_MODE || "").trim().toLowerCase();
  if (mode === LOCAL) return { mode: LOCAL, serverUrl: "", recentServers: [] };
  if (mode === REMOTE) {
    const serverUrl = normalizeServerUrl(env.GAMMA_DESKTOP_SERVER);
    if (serverUrl) return { mode: REMOTE, serverUrl, recentServers: [serverUrl] };
  }
  return null;
}

module.exports = { read, write, fromEnv, normalizeServerUrl, LOCAL, REMOTE, FILE };
