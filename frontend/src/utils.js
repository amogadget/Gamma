// Small shared helpers: API base, fetch wrapper, ids, hashing, formatting.

const API = "/api";

// ---- Session identity guard -------------------------------------------------
// The session cookie is shared by every tab of the browser, so logging in from
// a second tab silently switches this tab's identity — and its autosaves would
// write into the other account. Each tab declares who it believes is signed in
// via an X-Gamma-User header on every API call; the backend answers 409 when
// the cookie no longer matches. The header is injected in a window.fetch
// wrapper so all call sites (autosave, keepalive unload flushes, uploads,
// chat streams) are covered without touching each one.

let expectedUser = null;

function setExpectedUser(user) {
  expectedUser = user || null;
}

// Auth endpoints legitimately inspect or change the session — never guard them.
const AUTH_PATHS = new Set([`${API}/login`, `${API}/login-guest`, `${API}/logout`, `${API}/session`]);

const rawFetch = window.fetch.bind(window);
window.fetch = function (input, options) {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  const path = url.startsWith("/") ? url.split("?")[0] : "";
  if (!expectedUser || !path.startsWith(`${API}/`) || AUTH_PATHS.has(path)) {
    return rawFetch(input, options);
  }
  options = { ...(options || {}) };
  if (options.headers instanceof Headers) {
    options.headers = new Headers(options.headers);
    options.headers.set("X-Gamma-User", expectedUser);
  } else {
    options.headers = { ...(options.headers || {}), "X-Gamma-User": expectedUser };
  }
  const promise = rawFetch(input, options);
  promise.then((r) => {
    if (r.status === 409 && r.headers.has("X-Gamma-Session-User")) {
      const who = r.headers.get("X-Gamma-Session-User");
      window.dispatchEvent(new CustomEvent(
        who ? "gamma-user-mismatch" : "gamma-auth-expired",
        { detail: { user: who } },
      ));
    }
  }).catch(() => {});
  return promise;
};
// -----------------------------------------------------------------------------

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getDocIdForUrl(sourceUrl) {
  return (await sha256(sourceUrl)).slice(0, 24);
}

async function apiJson(url, options = {}) {
  const r = await fetch(url, { ...options, credentials: "include" });
  if (r.status === 401) {
    const isShareView = new URLSearchParams(window.location.search).get("share");
    if (!isShareView) {
      window.dispatchEvent(new CustomEvent("gamma-auth-expired"));
    }
    throw new Error("401 Unauthorized");
  }
  if (!r.ok) {
    const text = await r.text();
    // FastAPI errors come as {"detail": "..."} — show the human message, not raw JSON
    let msg = text;
    try {
      const j = JSON.parse(text);
      if (j && typeof j.detail === "string") msg = j.detail;
    } catch {}
    throw new Error(msg || `HTTP ${r.status}`);
  }
  return r.json();
}

async function resolvePdfUrl(rawUrl, allowOa = true) {
  // {source_url, note} — note explains e.g. that an open-access preprint was
  // substituted because the published PDF is paywalled.
  return apiJson(`${API}/resolve-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_url: rawUrl, allow_oa: allowOa })
  });
}

export { API, makeId, fmtBytes, sha256, getDocIdForUrl, apiJson, resolvePdfUrl, setExpectedUser };
