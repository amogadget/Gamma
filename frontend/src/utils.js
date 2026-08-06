// Small shared helpers: API base, fetch wrapper, ids, hashing, formatting.

import { useEffect, useState } from "react";

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

// For the rare non-fetch transport (the backup-import XHR) that must carry
// the same identity guard the fetch wrapper injects.
function getExpectedUser() {
  return expectedUser;
}

// Auth endpoints legitimately inspect or change the session — never guard them.
const AUTH_PATHS = new Set([`${API}/login`, `${API}/login-guest`, `${API}/logout`, `${API}/session`]);

const rawFetch = window.fetch.bind(window);
window.fetch = function (input, options) {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  const path = url.startsWith("/") ? url.split("?")[0] : "";
  const isApi = path.startsWith(`${API}/`);
  const method = String(options?.method || input?.method || "GET").toUpperCase();
  const expectedAtStart = expectedUser;
  const started = performance.now();
  if (expectedUser && isApi && !AUTH_PATHS.has(path)) {
    options = { ...(options || {}) };
    if (options.headers instanceof Headers) {
      options.headers = new Headers(options.headers);
      options.headers.set("X-Gamma-User", expectedUser);
    } else {
      options.headers = { ...(options.headers || {}), "X-Gamma-User": expectedUser };
    }
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
    if (!isApi) return;
    const elapsed = Math.round(performance.now() - started);
    if (r.ok && !AUTH_PATHS.has(path) && elapsed < 2000) return;
    const requestId = r.headers.get("X-Gamma-Request-ID") || "";
    const timing = `${elapsed} ms${requestId ? `, request ${requestId}` : ""}`;
    const emit = (detail = "") => {
      let explanation = detail;
      if (r.status === 409 && r.headers.has("X-Gamma-Session-User")) {
        const actual = r.headers.get("X-Gamma-Session-User") || "signed out";
        explanation = `session changed from ${expectedAtStart || "unknown"} to ${actual}`;
      } else if (r.status === 401 && !explanation) {
        explanation = "authentication required or session expired";
      }
      window.dispatchEvent(new CustomEvent("gamma-api-log", {
        detail: {
          message: `API ${method} ${path} → ${r.status} in ${timing}${explanation ? ` — ${explanation}` : ""}`,
        },
      }));
    };
    if (r.ok) {
      emit("");
    } else {
      r.clone().json()
        .then((body) => emit(typeof body?.detail === "string" ? body.detail : ""))
        .catch(() => emit(""));
    }
  }).catch((error) => {
    if (!isApi) return;
    const elapsed = Math.round(performance.now() - started);
    window.dispatchEvent(new CustomEvent("gamma-api-log", {
      detail: {
        message: `API ${method} ${path} failed after ${elapsed} ms — ${error?.message || "network error"}`,
      },
    }));
  });
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

// A localStorage-persisted preference: reads the key once, writes on change.
// `parse` maps the stored string to the state value (return undefined to fall
// back to `initial`); `serialize` maps state back to a string. Plain strings
// need neither.
function usePersistedState(key, initial, { parse, serialize } = {}) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initial;
      const parsed = parse ? parse(raw) : raw;
      return parsed === undefined ? initial : parsed;
    } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, serialize ? serialize(value) : String(value)); } catch {}
  }, [key, value]);
  return [value, setValue];
}

const FLAG_CODEC = { parse: (raw) => raw === "1", serialize: (v) => (v ? "1" : "0") };

// Boolean variant, stored as "1"/"0".
function usePersistedFlag(key, initial) {
  return usePersistedState(key, initial, FLAG_CODEC);
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

export { API, makeId, fmtBytes, sha256, getDocIdForUrl, apiJson, resolvePdfUrl, setExpectedUser, getExpectedUser, usePersistedState, usePersistedFlag };
