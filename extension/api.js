// Shared by the worker, popup and options page: settings in chrome.storage.sync
// and a fetch wrapper for the user's Gamma server. Requests carry the browser's
// cookies (credentials: "include") — the same session cookie the app tab uses,
// so signing in from either place signs in both. Chrome exempts requests from
// an extension holding a host permission for the target from SameSite rules,
// which is why the options page asks for that permission when the URL is set.

export const DEFAULTS = {
  server: "",          // e.g. "http://gamma.local:9001"
  folder: "",          // default folder for saves
  labels: [],          // default labels
  allowOa: true,       // open-access fallback behind paywalls
  saveCopy: true,      // store the PDF server-side
  autoRefreshSessions: true,  // re-import a connected publisher's cookies when its page is visited
};

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}

// "gamma.local:9001" → "http://gamma.local:9001"; keeps an explicit scheme.
export function normalizeServer(raw) {
  let s = (raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  try {
    return new URL(s).origin;
  } catch {
    return "";
  }
}

export async function serverOrigin() {
  const { server } = await getSettings();
  return normalizeServer(server);
}

// The permission pattern for an origin ("http://host:9001/*").
export function originPattern(origin) {
  return origin ? origin + "/*" : "";
}

export async function hasServerPermission(origin) {
  if (!origin) return false;
  return chrome.permissions.contains({ origins: [originPattern(origin)] });
}

async function readError(res) {
  let message = `${res.status} ${res.statusText}`;
  try {
    const data = await res.json();
    if (data && data.detail) message = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
  } catch {
    try {
      const text = await res.text();
      if (text) message = text.slice(0, 200);
    } catch {}
  }
  return new ApiError(res.status, message);
}

async function request(path, { method, json, form, params, expectedUser, expectedOrigin } = {}) {
  const origin = await serverOrigin();
  if (expectedOrigin && origin !== expectedOrigin) throw new ApiError(409, "Gamma server changed. Reopen the Connector.");
  if (!origin) throw new ApiError(0, "No Gamma server configured — open the extension options.");
  const url = new URL(origin + "/api" + path);
  for (const [k, v] of Object.entries(params || {})) if (v) url.searchParams.set(k, v);
  const init = { method: method || (json || form ? "POST" : "GET"), credentials: "include", headers: {} };
  if (expectedUser != null) init.headers["X-Gamma-User"] = expectedUser;
  // A session snapshot must never be forwarded to a redirected server.
  if (expectedOrigin) init.redirect = "error";
  if (json) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (form) {
    init.body = form;
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ApiError(0, `Can't reach ${origin} (${err.message})`);
  }
  if (!res.ok) throw await readError(res);
  return { res, origin };
}

function readResponse(res) {
  const ctype = res.headers.get("content-type") || "";
  return ctype.includes("json") ? res.json() : res.text();
}

// api("/session"), api("/clip", {json: {...}}), api("/uploads", {form})
export async function api(path, options) {
  const { res } = await request(path, options);
  return readResponse(res);
}

// Session identity (user is null when signed out) plus the effective origin.
export async function whoAmI() {
  const { res, origin } = await request("/session");
  const data = await readResponse(res);
  let resolvedOrigin = origin;
  // Remember a same-host HTTPS upgrade discovered by this read-only check.
  // Publisher requests still reject redirects, especially cookie uploads.
  const upgraded = new URL(origin + "/api/session");
  if (upgraded.protocol === "http:") {
    upgraded.protocol = "https:";
    if (res.url === upgraded.href && data && typeof data === "object" && "user" in data) {
      resolvedOrigin = upgraded.origin;
    }
  }
  const currentOrigin = await serverOrigin();
  if (currentOrigin !== origin && currentOrigin !== resolvedOrigin) {
    throw new ApiError(409, "Gamma server changed. Reopen the Connector.");
  }
  if (resolvedOrigin !== currentOrigin) await setSettings({ server: resolvedOrigin });
  return { ...(data && data.user ? data : { user: null }), origin: resolvedOrigin };
}

export async function login(username, password) {
  return api("/login", { json: { username, password } });
}

export async function logout() {
  return api("/logout", { method: "POST" });
}
