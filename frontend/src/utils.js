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
const AUTH_PATHS = new Set([
  `${API}/login`,
  `${API}/login-guest`,
  `${API}/logout`,
  `${API}/session`,
]);

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
  promise
    .then((r) => {
      if (r.status === 409 && r.headers.has("X-Gamma-Session-User")) {
        const who = r.headers.get("X-Gamma-Session-User");
        window.dispatchEvent(
          new CustomEvent(who ? "gamma-user-mismatch" : "gamma-auth-expired", {
            detail: { user: who },
          }),
        );
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
        window.dispatchEvent(
          new CustomEvent("gamma-api-log", {
            detail: {
              message: `API ${method} ${path} → ${r.status} in ${timing}${explanation ? ` — ${explanation}` : ""}`,
            },
          }),
        );
      };
      if (r.ok) {
        emit("");
      } else {
        r.clone()
          .json()
          .then((body) => emit(typeof body?.detail === "string" ? body.detail : ""))
          .catch(() => emit(""));
      }
    })
    .catch((error) => {
      if (!isApi) return;
      const elapsed = Math.round(performance.now() - started);
      window.dispatchEvent(
        new CustomEvent("gamma-api-log", {
          detail: {
            message: `API ${method} ${path} failed after ${elapsed} ms — ${error?.message || "network error"}`,
          },
        }),
      );
    });
  return promise;
};
// -----------------------------------------------------------------------------

// 9 random bytes, base64url — matches the backend's secrets.token_urlsafe(9)
// (12 chars, 72 bits; the old Math.random base36 slice was 8 chars from a
// non-crypto RNG).
function makeId() {
  const bytes = new Uint8Array(9);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_");
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
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, serialize ? serialize(value) : String(value));
    } catch {}
  }, [key, value, serialize]);
  return [value, setValue];
}

const FLAG_CODEC = { parse: (raw) => raw === "1", serialize: (v) => (v ? "1" : "0") };

// Boolean variant, stored as "1"/"0".
function usePersistedFlag(key, initial) {
  return usePersistedState(key, initial, FLAG_CODEC);
}

// ---- Clipboard ----------------------------------------------------------------
// navigator.clipboard exists only in secure contexts (https / localhost); Gamma
// is typically reached over plain-HTTP LAN, so every copy needs the legacy
// hidden-textarea + execCommand fallback. `html` adds a text/html flavor (real
// bold/italics for Word & PowerPoint) alongside the plain string.
function legacyCopy(plain, html) {
  const ta = document.createElement("textarea");
  ta.value = plain;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;width:2em;height:2em;opacity:0";
  const active = document.activeElement;
  document.body.appendChild(ta);
  ta.addEventListener("copy", (e) => {
    e.preventDefault();
    e.clipboardData.setData("text/plain", plain);
    if (html) e.clipboardData.setData("text/html", html);
  });
  ta.select();
  ta.setSelectionRange(0, plain.length); // iOS Safari ignores select()
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  try { active?.focus?.(); } catch {}
  return ok;
}

// Copy plain text; resolves true when the text made it to the clipboard.
async function copyText(text) {
  const plain = text || "";
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(plain); return true; } catch {}
  }
  return legacyCopy(plain);
}

// Copy with a rich HTML flavor plus a plain-text fallback flavor.
async function copyRich(html, plain) {
  if (window.isSecureContext && navigator.clipboard?.write && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      })]);
      return true;
    } catch {}
  }
  return legacyCopy(plain, html);
}

// Apple keyboards label the Alt key "option" (⌥), so a tooltip that says
// "Alt" reads as a key a Mac user does not have. Same DOM event either way
// (e.key === "Alt"); only the wording differs.
// Test BOTH signals rather than `platform || userAgent`: platform is truthy on
// every OS, so the `||` made the userAgent branch dead code (and untestable).
const IS_MAC = typeof navigator !== "undefined"
  && /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform || ""} ${navigator.userAgent || ""}`);
const ALT_LABEL = IS_MAC ? "\u2325 Option" : "Alt";

const isPdfFile = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
const isMarkdownFile = (f) => /\.(?:md|markdown)$/i.test(f.name || "")
  || /^(?:text\/markdown|text\/x-markdown)$/i.test(f.type || "");

// FastAPI errors come as {"detail": "..."} — show the human message, not raw JSON.
async function apiError(r) {
  const text = await r.text().catch(() => "");
  try {
    const j = JSON.parse(text);
    if (typeof j?.detail === "string") return new Error(j.detail);
  } catch {}
  return new Error(text || `HTTP ${r.status}`);
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
  if (!r.ok) throw await apiError(r);
  return r.json();
}

async function resolvePdfUrl(rawUrl, allowOa = true) {
  // {source_url, note} — note explains e.g. that an open-access preprint was
  // substituted because the published PDF is paywalled.
  return apiJson(`${API}/resolve-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_url: rawUrl, allow_oa: allowOa }),
  });
}

// True when the user pressed Enter as an action, not to commit an IME
// composition (Pinyin, Kotoeri, etc.). React's synthetic KeyboardEvent
// exposes `nativeEvent.isComposing`; the 229 keyCode is the legacy signal
// browsers still send for the same case.
function isEnterCommit(e) {
  return (
    e.key === "Enter" &&
    !e.isComposing &&
    !e.nativeEvent?.isComposing &&
    e.keyCode !== 229
  );
}

// Same-origin proxy for an external PDF. `save` caches a copy in uploads;
// `share` carries the read token in the public view.
function pdfProxyUrl(sourceUrl, { save = false, share = "" } = {}) {
  return `${API}/pdf?source_url=${encodeURIComponent(sourceUrl)}`
    + (save ? "&save=1" : "")
    + (share ? `&share=${encodeURIComponent(share)}` : "");
}

// Headers-only check that the proxy can really deliver this PDF: resolution
// only picks a candidate URL, and the download behind it still fails on
// paywalls, blocked server-side fetches, or HTML pretending to be a paper.
// The proxy already rejects all of those with a human-readable 400, so this
// just needs its headers — the body is cancelled the moment they land, which
// costs one upstream connection and no download (and never `save`: a
// cancelled stream is not cached anyway).
async function probePdfUrl(sourceUrl) {
  const r = await fetch(pdfProxyUrl(sourceUrl), { credentials: "include" });
  if (!r.ok) throw await apiError(r); // reads the error body — cancel only the good stream
  try { await r.body?.cancel(); } catch {}
}

export {
  API,
  makeId,
  fmtBytes,
  sha256,
  getDocIdForUrl,
  IS_MAC,
  ALT_LABEL,
  isPdfFile,
  isMarkdownFile,
  apiJson,
  resolvePdfUrl,
  pdfProxyUrl,
  probePdfUrl,
  setExpectedUser,
  getExpectedUser,
  usePersistedState,
  usePersistedFlag,
  isEnterCommit,
  copyText,
  copyRich,
};
