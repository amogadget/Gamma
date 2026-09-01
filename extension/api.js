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

// api("/session"), api("/clip", {json: {...}}), api("/uploads", {form})
export async function api(path, { method, json, form, params } = {}) {
  const origin = await serverOrigin();
  if (!origin) throw new ApiError(0, "No Gamma server configured — open the extension options.");
  const url = new URL(origin + "/api" + path);
  for (const [k, v] of Object.entries(params || {})) if (v) url.searchParams.set(k, v);
  const init = { method: method || (json || form ? "POST" : "GET"), credentials: "include", headers: {} };
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
  const ctype = res.headers.get("content-type") || "";
  return ctype.includes("json") ? res.json() : res.text();
}

// {user: "tim"} or {user: null}; throws only when the server is unreachable.
export async function whoAmI() {
  const data = await api("/session");
  return data && data.user ? data : { user: null };
}

export async function login(username, password) {
  return api("/login", { json: { username, password } });
}

export async function logout() {
  return api("/logout", { method: "POST" });
}
