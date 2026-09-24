// The web → native handoff (docs/dev/handwriting.md "Native handoff"): one
// narrow message, not a second library. The native side independently
// re-checks the main-frame origin, the live cookies/session and the document's
// server-side identity, so this payload is a claim to verify, never a grant.
//
// `workspace` is part of the identity: a BARE library id (the `?ws=` /
// `X-Gamma-Workspace` value, never a URL or a query string) is what every
// native route (`/api/assets/...`, the per-block ink/audio/replay writers) is
// scoped by, and the iPad app loads its own `/…?ws=<workspace>` root to reach
// the SAME library it was handed from. It is sent alongside pageID/docID/
// title/user and bounded the same way.

// Identity fields are opaque identifiers with a hard ceiling in BOTH units the
// native side checks: ≤200 characters and ≤512 UTF-8 bytes (a workspace id is
// `secrets.token_urlsafe(9)`; page/doc ids are server-minted). No CR, LF or NUL
// anywhere in them — a newline would let a caller forge a second field.
const ID_MAX_CHARS = 200;
const ID_MAX_BYTES = 512;
const TITLE_MAX_POINTS = 120;

// UTF-8 length without TextEncoder, so this module stays dependency-free and
// runs unchanged under `node --test`.
function utf8Length(value) {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function handoffID(value) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= ID_MAX_CHARS && utf8Length(value) <= ID_MAX_BYTES &&
    !/[\r\n\0]/.test(value);
}

// Displayed (rotation-applied crop box) page-local coordinates, zero-based page.
export function nativeViewport(value) {
  if (!value || !Number.isInteger(value.pageIndex) || value.pageIndex < 0 || value.pageIndex > 999999 ||
      ![value.anchorX, value.anchorY].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) return null;
  return { pageIndex: value.pageIndex, anchorX: value.anchorX, anchorY: value.anchorY };
}

// Read actual laid-out boxes, never the last debounced page-number preference.
export function captureNativeViewport(scroller) {
  if (!scroller || !scroller.clientWidth || !scroller.clientHeight) return null;
  const viewport = scroller.getBoundingClientRect();
  const top = viewport.top + (scroller.clientTop || 0);
  const left = viewport.left + (scroller.clientLeft || 0);
  for (const el of scroller.querySelectorAll(".pdfPageWrap[data-page]")) {
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0 || box.bottom <= top || box.top >= top + scroller.clientHeight) continue;
    return nativeViewport({ pageIndex: Number(el.dataset.page) - 1,
      anchorX: Math.max(0, Math.min(1, (left - box.left) / box.width)),
      anchorY: Math.max(0, Math.min(1, (top - box.top) / box.height)) });
  }
  return null;
}

// Restore a page-local anchor at the scroller's visible top/left. Browser
// clamping at document edges is intentional; never use document-height ratios.
export function applyNativeViewport(scroller, value) {
  const position = nativeViewport(value);
  if (!position || !scroller?.clientWidth || !scroller?.clientHeight) return false;
  const page = scroller.querySelector(`.pdfPageWrap[data-page="${position.pageIndex + 1}"]`);
  if (!page) return false;
  const box = page.getBoundingClientRect(), view = scroller.getBoundingClientRect();
  if (!box.width || !box.height) return false;
  scroller.scrollTo({
    top: scroller.scrollTop + box.top + box.height * position.anchorY - view.top - (scroller.clientTop || 0),
    left: scroller.scrollLeft + box.left + box.width * position.anchorX - view.left - (scroller.clientLeft || 0),
    behavior: "instant",
  });
  return true;
}

export function nativeReturnRequest(value, origin) {
  if (!value || ![value.pageID, value.docID, value.user, value.workspace].every(handoffID)) return null;
  if (typeof value.server !== "string" || value.server.replace(/\/$/, "") !== origin.replace(/\/$/, "")) return null;
  const viewport = nativeViewport(value.viewport);
  return viewport ? { ...value, viewport } : null;
}

// Dependency-injected so dirty/no-PDF/signed-out and failure cases can be pinned
// without React. A failed save never consumes a draft or claims success.
export async function prepareNativeDisconnect({ settle, flush, flushInk, hasPending, dirtyInk, recovery, timeoutMs = 10000 }) {
  let timer;
  const work = (async () => {
  try {
    await settle();
    await flush(); // new ink blocks must exist before their upload/PATCH
    await flushInk();
    await flush();
    if (hasPending() || dirtyInk().length) return { ok: false, reason: "unsaved-edits", recovery: recovery() };
    return { ok: true, reason: "flushed" };
  } catch (error) {
    return { ok: false, reason: "flush-failed", detail: String(error?.message || error), recovery: recovery() };
  }
  })();
  try {
    return await Promise.race([work, new Promise(resolve => {
      timer = setTimeout(() => resolve({ ok: false, reason: "flush-timeout", recovery: recovery() }), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function nativePDFRequest({ pageID, docID, title, user, workspace, viewport }) {
  if (![pageID, docID, user, workspace].every(handoffID)) return null;
  const position = viewport == null ? null : nativeViewport(viewport);
  if (viewport != null && !position) return null;
  return {
    ...(position ? { viewport: position } : {}),
    type: "openPDF",
    pageID,
    docID,
    workspace,
    user,
    // A title is a label, not identity: collapse whitespace, then bound by
    // Unicode code points so a title of emoji can never split a surrogate pair.
    title: Array.from(String(title || "PDF").replace(/\s+/g, " ").trim()).slice(0, TITLE_MAX_POINTS).join("") || "PDF",
  };
}
