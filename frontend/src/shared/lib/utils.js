// Small shared helpers: API base, fetch wrapper, ids, hashing, formatting.

import { useEffect, useState } from "react";
import { makeBlockId } from "../model/blockModel";
import { assetUrlInScope } from "./assetUrl";

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

// ---- Workspace -------------------------------------------------------------
// Which library this tab works in (docs/dev/workspaces.md). App.jsx picks it
// once the session resolves (the URL's ?ws=, the page a deep link names, the
// last one used, else the account's personal workspace) and every API call
// then carries it as X-Gamma-Workspace — again injected here so no call site
// can forget it. The websocket and copied links carry it as ?ws= instead.
let currentWorkspace = "";

function setCurrentWorkspace(ws) {
  currentWorkspace = ws || "";
}

function getCurrentWorkspace() {
  return currentWorkspace;
}

// ---- Link visitors -----------------------------------------------------------
// In a share view opened without an account, the visitor's display name
// (collaboration/linkName.js) goes out as X-Gamma-Name on every API call —
// percent-encoded, since header values cannot carry non-Latin-1 text — and
// as ?name= on the page socket. The server records writes as `link:<name>`.
let linkName = "";

function setLinkName(name) {
  linkName = name || "";
}

function getLinkName() {
  return linkName;
}

// Append the workspace to an in-app URL (links, history entries) so a reload
// or a copied link lands in the same library. Share URLs never carry it.
function withWorkspace(url) {
  if (!currentWorkspace || typeof url !== "string" || /[?&]ws=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}ws=${encodeURIComponent(currentWorkspace)}`;
}

// A same-origin asset URL — an upload (`/api/uploads/<hash>.ext`) or a native
// asset (`/api/assets/<sha256>.<ext>`, the iPad's drawings, previews, audio
// segments and replay derivatives) — for a browser-issued request: an <img>
// src, an <audio> src, a download link, the replay loader. Those bypass the
// fetch wrapper and so carry neither the workspace header nor the share token.
// Block content stores the bare URL; every RENDER site passes it through here
// so the server looks in the right library (a non-default workspace's image
// would otherwise 404) and a share viewer is admitted. The rule itself lives in
// assetUrl.js (pure, unit-tested); this is the window-aware call.
function assetUrl(url) {
  return assetUrlInScope(url, { workspace: currentWorkspace, share: SHARE_TOKEN });
}

// For the rare non-fetch transport (the backup-import XHR) that must carry
// the same identity guard the fetch wrapper injects.
function getExpectedUser() {
  return expectedUser;
}

// Auth endpoints legitimately inspect or change the session — never guard them.
const AUTH_PATHS = new Set([`${API}/login`, `${API}/login-guest`, `${API}/logout`, `${API}/session`]);

const rawFetch = window.fetch.bind(window);
// A same-origin API path, whether the caller wrote it relative or absolute —
// pdf.js resolves the URL it is given against the document before fetching,
// so "/api/uploads/x.pdf" arrives here as "http://host/api/uploads/x.pdf".
// Any other origin is left alone: not ours to tag.
function apiPathOf(url) {
  try {
    const u = new URL(url, window.location.href);
    return u.origin === window.location.origin ? u.pathname : "";
  } catch {
    return "";
  }
}

window.fetch = function (input, options) {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  const path = apiPathOf(url);
  const isApi = path.startsWith(`${API}/`);
  const method = String(options?.method || input?.method || "GET").toUpperCase();
  const expectedAtStart = expectedUser;
  const started = performance.now();
  if ((expectedUser || currentWorkspace || linkName) && isApi && !AUTH_PATHS.has(path)) {
    options = { ...(options || {}) };
    const extra = {};
    if (expectedUser) extra["X-Gamma-User"] = expectedUser;
    if (currentWorkspace) extra["X-Gamma-Workspace"] = currentWorkspace;
    if (linkName) extra["X-Gamma-Name"] = encodeURIComponent(linkName);
    if (options.headers instanceof Headers) {
      options.headers = new Headers(options.headers);
      for (const [k, v] of Object.entries(extra)) options.headers.set(k, v);
    } else {
      options.headers = { ...(options.headers || {}), ...extra };
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
          tone: r.status >= 500 ? "error" : r.status >= 400 ? "warn" : "",
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
        tone: "error",
      },
    }));
  });
  return promise;
};
// -----------------------------------------------------------------------------

// One id generator for blocks, uploads and tasks alike (blockModel owns it
// so the pure model stays import-free).
const makeId = makeBlockId;

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

// Metadata that nothing tied to THIS document — the UI flags it (red "!" on
// the metadata button and beside the slide citation, red cell in the
// Settings → Library table) so nobody cites it unchecked. The server stores
// `meta.unverified` (AI paper records; DOIs/ISBNs printed in the text whose
// registry title isn't); records from before the flag existed fall back to
// the old rule: AI-extracted and claiming to be a paper (non-paper kinds have
// no registry to verify against; a missing kind counts as paper, the safe
// default).
const isUnverifiedPaperMeta = (source, kind, unverified = null) =>
  unverified == null ? source === "ai" && (kind || "paper") === "paper" : !!unverified;

// Where a page's metadata came from, worded once for every surface that
// shows it: the metadata popover's Source row, the share popover's citation
// header, the Settings → Library table (`short`). `warn` = cite with care.
const META_SOURCE_NAMES = {
  arxiv: "arXiv", doi: "doi.org", crossref: "Crossref search", isbn: "ISBN lookup",
  openlibrary: "Open Library", googlebooks: "Google Books", manual: "edited by hand",
};
function metaSourceInfo(meta) {
  if (!meta?.source) return null;
  const kind = meta.kind || "paper";
  const unverified = isUnverifiedPaperMeta(meta.source, kind, meta.unverified);
  if (meta.source === "ai") {
    return unverified
      ? { label: "AI-extracted — unverified", short: "AI", warn: true,
          hint: "Read by AI from the PDF text and not confirmed by any registry (arXiv, Crossref, Open Library) — fields may be wrong, verify before citing" }
      : { label: `AI-extracted (${kind})`, short: `AI (${kind})`, warn: false,
          hint: "Not a published paper, so there is no registry record to verify against" };
  }
  const name = META_SOURCE_NAMES[meta.source] || meta.source;
  if (unverified) {
    return { label: `${name} — unconfirmed`, short: `${name} ?`, warn: true,
             hint: "Resolved from an identifier printed in the PDF, but the record's title isn't in the text — it may belong to a work this document cites. Verify before citing" };
  }
  return { label: name, short: name, warn: false,
           hint: meta.source === "manual" ? "Fields edited by hand" : `Registry record via ${name}` };
}

const isPdfFile = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
const isMarkdownFile = (f) => /\.(?:md|markdown)$/i.test(f.name || "")
  || /^(?:text\/markdown|text\/x-markdown)$/i.test(f.type || "");

// FastAPI errors come as {"detail": "..."} — show the human message, not raw JSON.
// The thrown Error carries `status` and the parsed JSON body as `data`, so
// callers can act on structured conflicts (e.g. a 409 naming another page).
async function apiError(r) {
  const text = await r.text().catch(() => "");
  let err;
  try {
    const j = JSON.parse(text);
    err = new Error(typeof j?.detail === "string" ? j.detail : text || `HTTP ${r.status}`);
    err.data = j;
  } catch {
    err = new Error(text || `HTTP ${r.status}`);
  }
  err.status = r.status;
  return err;
}

// The share view (/?share=<token>): every same-origin API call carries the
// token, so reads — and, when the link grants editing, writes — resolve to
// the sharing owner's page rather than the visitor's own account. Callers
// that already put a share= on the URL are left alone.
const SHARE_TOKEN = new URLSearchParams(window.location.search).get("share") || "";
function withShare(url) {
  if (!SHARE_TOKEN || typeof url !== "string" || !url.startsWith(`${API}/`)) return url;
  if (/[?&]share=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}share=${encodeURIComponent(SHARE_TOKEN)}`;
}

async function apiJson(url, options = {}) {
  const r = await fetch(withShare(url), { ...options, credentials: "include" });
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
    body: JSON.stringify({ source_url: rawUrl, allow_oa: allowOa })
  });
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

// Read an NDJSON response as it arrives: `onBatch(events)` once per network
// chunk with the JSON objects of the lines it completed (a trailing partial
// line waits for its rest). Throwing from onBatch ends the read.
async function readNdjson(res, onBatch) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    const events = lines.filter((l) => l.trim()).map((l) => JSON.parse(l));
    if (events.length) onBatch(events);
  }
}

export { API, makeId, fmtBytes, sha256, getDocIdForUrl, isPdfFile, isMarkdownFile, isUnverifiedPaperMeta, metaSourceInfo, apiJson, withShare, withWorkspace, assetUrl, setCurrentWorkspace, getCurrentWorkspace, setLinkName, getLinkName, resolvePdfUrl, pdfProxyUrl, probePdfUrl, setExpectedUser, getExpectedUser, usePersistedState, usePersistedFlag, copyText, copyRich, readNdjson };
