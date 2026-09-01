import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import PdfViewer, { COLORS, clampZoom } from "./pdfViewer";
import {
  API,
  apiJson,
  makeId,
  fmtBytes,
  getDocIdForUrl,
  ALT_LABEL,
  isPdfFile,
  isMarkdownFile,
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
} from "./utils";
import {
  BlockDropIndicator,
  ChatMarkdown,
  ExportDialog,
  ImportDialog,
  DockWindow,
  OpenTabs,
  PopoverAnchor,
  useCopied,
} from "./widgets";
import { BlockTree, _dragState } from "./blockTree";
import { CardLabels, KindToggle, ListFindBox, PageCard, ViewToggle } from "./fileBrowser";
import ChatDock from "./chatDock";
import SearchPanel from "./search";
import { ContextMenu, MenuItem, MenuLabel, MenuSelect, SubMenuItem } from "./menus";
import {
  ActivityIcon, AlertCircleIcon, ArrowLeftIcon, ArrowUpDownIcon, BookIcon, CheckIcon, CopyIcon, DatabaseIcon, DownloadIcon, ExportIcon,
  ExternalLinkIcon, EyeIcon, EyeOffIcon, FileGlyph, FileIcon, FileTextIcon, FitWidthIcon, FolderGlyph,
  FolderIcon, FolderOpenIcon, FolderPlusIcon, HomeIcon, ImportIcon, InfoIcon, LabelGlyph, LabelIcon,
  LanguagesIcon, LanguagesOffIcon, LinkIcon, LogOutIcon, MaximizeIcon, MenuIcon, MinimizeIcon, PenIcon, PinIcon, PlusIcon,
  RectSelectIcon, SearchIcon, SettingsIcon, SparklesIcon, TextCursorIcon, TrashIcon, TypeIcon, UploadIcon,
  UserIcon, UsersIcon, XIcon, ZoomInIcon, ZoomOutIcon,
} from "./icons";

import {
  setBlockText,
  setBlockEditMode,
  addSiblingBlock,
  addChildBlock,
  addRootBlock,
  indentBlock,
  outdentBlock,
  toggleCollapsed,
  expandToBlock,
  updateBlockTree,
  removeBlockTree,
  flattenBlocks,
  isDescendant,
  findBlockContext,
  extractBlock,
  insertSibling,
  insertChild,
  addHighlightAsBlock,
  blocksToHighlights,
  normalizeBlocks,
} from "./logseqPdfModel";
import { loadSession, saveSession, clearSession } from "./sessionState";
import { AuthLoading, LoginPage, SessionConflictPage } from "./LoginPage";
import { THEMES, TRANSLATE_LANGS, useAppPrefs } from "./prefs";
import { useTransfers } from "./useTransfers";
import { usePdfScrollRestore } from "./usePdfScrollRestore";
import SettingsDialog from "./settings";
import { QuotaMeter } from "./settingsKit";
import {
  addFolderTag,
  cleanFolderPath,
  cleanFolderSegment,
  findPageForUrl,
  formatRelativeTime,
  friendlyApiError,
  getPdfPageTitle,
  metadataToDraft,
  normalizeLinkInput,
  parseFolderTags,
  scorePaperMatch,
} from "./libraryUtils";

// PDF load phases that own a row in the background-transfers popover; every
// other phase is viewer-local. Allowlist on purpose — the transfer handling's
// catch-all marks unrecognized phases as failed, so a new local phase must
// fail closed (ignored) rather than show a spurious error row.
const TRANSFER_PHASES = new Set(["start", "progress", "done", "cached", "error", "cancelled"]);

// Phone detection: below 700px the desktop dock system is unusable, so the
// workspace switches to a single full-width panel with a bottom tab bar. The
// second clause keeps a rotated (landscape) phone in the phone layout — the
// width crosses 700px but a touch device that short is still a phone, and
// flipping to the desktop docks mid-rotation is jarring.
const PHONE_MQ = "(max-width: 700px), (pointer: coarse) and (max-height: 500px)";
// A browser that declares itself mobile gets the phone layout regardless of
// the viewport numbers. "Request desktop site" flips this flag along with the
// UA, so it stays the escape hatch back to the desktop docks. Android tablets
// ("Android" without "Mobile") and iPads (desktop-class UA) are not phones.
const UA_MOBILE =
  navigator.userAgentData?.mobile ??
  /iPhone|iPod|Android.+Mobile|Mobile.+Android/i.test(navigator.userAgent);
function useIsPhone() {
  const [mqPhone, setMqPhone] = useState(() => window.matchMedia(PHONE_MQ).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_MQ);
    const apply = () => setMqPhone(mq.matches);
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return UA_MOBILE || mqPhone;
}

// Drag payload prefix marking a folder drag (page cards drag their bare id).
const FOLDER_DRAG = "gamma-folder:";

// Home sort and kind filter are per-view choices: {"": "updated", "readout":
// "title", "#label": …} — a view without an entry inherits from its nearest
// ancestor folder (root = ""). Each map is seeded from its old global key
// (gamma-home-sort / gamma-home-kinds) so an existing choice sticks.
const HOME_MAP_CODEC = {
  parse: (raw) => { try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : undefined; } catch { return undefined; } },
  serialize: JSON.stringify,
};
let HOME_SORT_DEFAULT = {};
try { const old = localStorage.getItem("gamma-home-sort"); if (old) HOME_SORT_DEFAULT = { "": old }; } catch {}
let HOME_KINDS_DEFAULT = {};
try { const old = localStorage.getItem("gamma-home-kinds"); if (old && old !== "all") HOME_KINDS_DEFAULT = { "": old }; } catch {}

// Home URL for the two browse filters — a folder scope and a label filter can
// be active at once (a label view opened inside a folder).
function homeUrlFor(folder, label) {
  const q = [];
  if (folder) q.push(`folder=${encodeURIComponent(folder)}`);
  if (label) q.push(`category=${encodeURIComponent(label)}`);
  return q.length ? `/?${q.join("&")}` : "/";
}

// The listing search box: every whitespace-separated term must appear in the
// item's text (its title plus, for a page, its folder/label chips), case and
// diacritics folded. Deliberately much simpler than the workspace search — it
// only reorders what is already on screen.
const normalizeFind = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
function makeFindMatcher(query) {
  const terms = normalizeFind(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  return (hay) => { const h = normalizeFind(hay); return terms.every((t) => h.includes(t)); };
}

// Folder uploads tag each PDF with its directory path as a folder label:
// "papers/readout/x.pdf" → "papers/readout" (the picked/dropped root included).
function folderFromRelPath(relPath) {
  const idx = (relPath || "").lastIndexOf("/");
  return idx > 0 ? cleanFolderPath(relPath.slice(0, idx)) : "";
}

// Directory uploads occasionally expose a relative path as File.name (and
// some browsers also transmit it as the multipart filename). Folder placement
// is tracked separately; titles and original_filename must always be one leaf.
function uploadLeafName(file, fallback = "") {
  const raw = String(file?.name || file?.webkitRelativePath || "").replace(/\\/g, "/");
  return raw.slice(raw.lastIndexOf("/") + 1).trim() || fallback;
}

// Recursively walk directory entries from a drop into {file, folder} pairs.
// The entries themselves must be captured synchronously in the drop handler
// (webkitGetAsEntry) — the DataTransfer is neutered once the event returns.
async function collectEntryFiles(entries) {
  const out = [];
  async function walk(entry, folder) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
      if (file) out.push({ file, folder });
    } else if (entry.isDirectory) {
      const seg = cleanFolderSegment(entry.name);
      const sub = folder && seg ? `${folder}/${seg}` : folder || seg;
      const reader = entry.createReader();
      for (;;) { // readEntries returns ≤100 entries per call — drain until empty
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => null);
        if (!batch || !batch.length) break;
        for (const e of batch) await walk(e, sub);
      }
    }
  }
  for (const entry of entries) await walk(entry, "");
  return out;
}

// --- Recently-viewed snapshots -------------------------------------------
// Composite the PDF viewer's visible area into a small JPEG data URL — the
// "last viewed place" cover for the recents cards. Reads the canvases pdf.js
// already painted, so it costs one drawImage per visible page. Returns null
// while the visible pages aren't painted yet (caller retries later).
const SNAP_WIDTH = 320;   // thumbnail backing width (px)
const SNAP_MAX_HEIGHT = 480;
function captureViewerSnapshot() {
  const scroller = document.querySelector(".pdfViewer");
  if (!scroller) return null;
  const vr = scroller.getBoundingClientRect();
  if (vr.width < 60 || vr.height < 60) return null;
  const k = SNAP_WIDTH / vr.width;
  const outH = Math.min(Math.round(vr.height * k), SNAP_MAX_HEIGHT);
  const capH = outH / k; // captured strip height in CSS px
  const out = document.createElement("canvas");
  out.width = SNAP_WIDTH; out.height = outH;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  let covered = 0;
  for (const wrap of scroller.querySelectorAll(".pdfPageWrap")) {
    const r = wrap.getBoundingClientRect();
    if (r.bottom <= vr.top || r.top >= vr.top + capH) continue;
    const canvas = wrap.querySelector("canvas");
    if (!canvas || !canvas.width || !canvas.height) continue;
    // Visible slice of this page in CSS px, mapped to the canvas backing
    // resolution on the source side and to the thumbnail on the dest side.
    const x0 = Math.max(vr.left, r.left), x1 = Math.min(vr.right, r.right);
    const y0 = Math.max(vr.top, r.top), y1 = Math.min(vr.top + capH, r.bottom);
    if (x1 <= x0 || y1 <= y0) continue;
    const kx = canvas.width / r.width, ky = canvas.height / r.height;
    try {
      ctx.drawImage(canvas,
        (x0 - r.left) * kx, (y0 - r.top) * ky, (x1 - x0) * kx, (y1 - y0) * ky,
        (x0 - vr.left) * k, (y0 - vr.top) * k, (x1 - x0) * k, (y1 - y0) * k);
    } catch { continue; }
    covered += (x1 - x0) * (y1 - y0);
  }
  // Mostly-blank captures (pages still rendering) are worse than keeping the
  // previous snapshot — require the strip to be at least 40% real page.
  if (covered < vr.width * capH * 0.4) return null;
  try { return out.toDataURL("image/jpeg", 0.55); } catch { return null; }
}

// Horizontal card strip. No arrow chrome: a mouse wheel scrolls it sideways
// (native non-passive listener — React's synthetic onWheel can't
// preventDefault), touch swipes pan natively via overflow-x.
function CardCarousel({ label, children }) {
  const trackRef = useRef(null);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    function onWheel(e) {
      // Real horizontal input (trackpads, tilt wheels) already works; pinch
      // gestures (ctrlKey) belong to the browser zoom.
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      if (el.scrollWidth <= el.clientWidth) return; // nothing to pan → page scrolls
      el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // LINE mode (Firefox) → ~px
      e.preventDefault();
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <div className="carouselRow">
      {label ? <div className="carouselLabel">{label}</div> : null}
      <div className="carouselTrack" ref={trackRef}>{children}</div>
    </div>
  );
}

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const initialUrl = params.get("src") || params.get("url") || "";
  const initialShare = params.get("share") || "";
  const initialBlockId = params.get("block") || params.get("page") || "";
  const initialCategory = params.get("category") || "";
  const initialFolder = params.get("folder") || "";
  const readOnly = Boolean(initialShare);

  // Auth state: null=loading, false=logged out, {user, is_guest}=logged in
  const [authUser, setAuthUser] = useState(readOnly ? { user: "_public" } : null);
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginError, setLoginError] = useState("");
  // Username that now owns the browser session when it's no longer this tab's
  // user (someone logged into another account from a second tab) — freezes the
  // tab behind SessionConflictPage until reload.
  const [sessionConflict, setSessionConflict] = useState(null);
  // App-level UI state used across many domains — declared early so domain
  // hooks can read it regardless of their position in this file.
  const [openPopover, setOpenPopover] = useState(null); // "menu" | "share" | "user" | "search"
  const [searchRestoreContext, setSearchRestoreContext] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(null); // null | "papers" | "library" | "ai" | "prompts" | "search" | "account"

  // This tab's real signed-in user — null while loading, logged out, or in a
  // public share view.
  const sessionUser =
    authUser && authUser.user && authUser.user !== "_public" ? authUser.user : null;

  // Publish this tab's identity: the X-Gamma-User guard header on API calls
  // (utils.js fetch wrapper) plus a localStorage beacon other tabs listen to.
  useEffect(() => {
    setExpectedUser(sessionUser);
    if (sessionUser) {
      try {
        localStorage.setItem("gamma-active-user", sessionUser);
      } catch {}
    }
  }, [sessionUser]);

  // Detect the session being taken over by another account. Three signals:
  // the backend's 409 on a guarded API call, the localStorage beacon from the
  // tab that logged in, and a session re-check when this tab regains focus
  // (throttled — alt-tab flapping must not hammer the server).
  useEffect(() => {
    if (readOnly || !sessionUser) return;
    function conflict(who) {
      if (who && who !== sessionUser) setSessionConflict(who);
      else if (!who) setAuthUser(false); // logged out elsewhere → login page
    }
    function onMismatch(e) {
      conflict(e.detail?.user || "");
    }
    function onStorage(e) {
      if (e.key === "gamma-active-user" && e.newValue !== null) conflict(e.newValue);
    }
    let lastCheck = 0;
    function onFocus() {
      const now = Date.now();
      if (now - lastCheck < 15000) return;
      lastCheck = now;
      apiJson(`${API}/session`)
        .then((d) => conflict(d.user || ""))
        .catch(() => {});
    }
    window.addEventListener("gamma-user-mismatch", onMismatch);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("gamma-user-mismatch", onMismatch);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, [sessionUser, readOnly]);

  async function checkSession() {
    try {
      const data = await apiJson(`${API}/session`);
      if (data.user) {
        setAuthUser({ user: data.user, is_guest: data.is_guest, is_admin: data.is_admin });
      } else {
        setAuthUser(false);
      }
    } catch {
      setAuthUser(false);
    }
  }

  // Effective storage limits + usage for the session user (GET /api/quota):
  // feeds the client-side pre-upload size check. Refreshed on login and after
  // uploads; the Settings displays fetch their own fresh copy.
  const [quotaInfo, setQuotaInfo] = useState(null); // {max_upload_mb, quota_mb, used_bytes}
  const refreshQuota = useCallback(() => {
    if (readOnly) return;
    apiJson(`${API}/quota`)
      .then(setQuotaInfo)
      .catch(() => {});
  }, [readOnly]);
  useEffect(() => {
    if (authUser?.user && !readOnly) refreshQuota();
    else setQuotaInfo(null);
  }, [authUser?.user, readOnly, refreshQuota]);

  async function doLogin(e) {
    e?.preventDefault();
    setLoginError("");
    try {
      const res = await fetch(`${API}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginUser, password: loginPass }),
        credentials: "include",
      });
      if (!res.ok) {
        setLoginError("Invalid credentials");
        return;
      }
      // Re-read the session rather than hand-building the auth state — it
      // carries flags login doesn't return (is_admin).
      await checkSession();
    } catch {
      setLoginError("Login failed");
    }
  }

  async function doGuestLogin() {
    try {
      const res = await fetch(`${API}/login-guest`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        setLoginError("Guest login failed");
        return;
      }
      const data = await res.json();
      setAuthUser({ user: data.username, is_guest: true });
    } catch {
      setLoginError("Guest login failed");
    }
  }

  // Download an /api/export backup zip. Fetched by hand (not a plain link
  // navigation) so the user sees the two slow parts: the server zipping a big
  // library ("preparing", no byte counter) and the download itself (percent
  // from content-length). Shows in the pill + a background-tasks row.
  // `target` names another account (admins only, from Settings → Users);
  // omitted it means your own data.
  async function exportUserData(withUploads, target) {
    const other = target && target !== authUser?.user ? target : null;
    const qs = (extra) => `${extra}${other ? `${extra ? "&" : "?"}user=${encodeURIComponent(other)}` : ""}`;
    const label = (withUploads ? "Export data" : "Export database") + (other ? ` — ${other}` : "");
    const tid = addTransfer({ name: label, kind: "download", info: "preparing…" });
    postPill("backup", {
      msg: "Preparing export — the server is zipping your data…",
      spinner: true,
    });
    // The response only starts once the server finished zipping; until then,
    // poll the zipping percent from the export-progress side-channel.
    const zipPoll = setInterval(async () => {
      try {
        const p = await apiJson(`${API}/export-progress${qs("")}`);
        if (p.active && p.total) {
          const pct = Math.min(99, Math.floor((p.done / p.total) * 100));
          postPill("backup", {
            msg: `Preparing export — zipping… ${pct}% (${fmtBytes(p.done)} of ${fmtBytes(p.total)})`,
            spinner: true,
          });
          updateTransfer(tid, { info: `zipping… ${pct}%` });
        }
      } catch {}
    }, 500);
    try {
      const res = await fetch(`${API}/export${qs(withUploads ? "" : "?uploads=0")}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      clearInterval(zipPoll);
      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      // Progress lands per ~64 KB network chunk and each pill/transfer update
      // re-renders the whole app — coalesce to visible changes (1% / 200 ms).
      let lastPct = -1,
        lastUiAt = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        const pct = total ? Math.min(99, Math.floor((loaded / total) * 100)) : null;
        const now = performance.now();
        if (pct === lastPct && now - lastUiAt < 200) continue;
        lastPct = pct;
        lastUiAt = now;
        postPill("backup", {
          msg: total
            ? `Downloading backup… ${pct}% (${fmtBytes(loaded)} of ${fmtBytes(total)})`
            : `Downloading backup… ${fmtBytes(loaded)}`,
          spinner: true,
        });
        updateTransfer(tid, {
          info: total ? `${fmtBytes(loaded)} / ${fmtBytes(total)}` : fmtBytes(loaded),
        });
      }
      const blob = new Blob(chunks, { type: "application/zip" });
      const m = /filename="?([^";]+)/.exec(res.headers.get("content-disposition") || "");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = m ? m[1] : "gamma-export.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      updateTransfer(tid, { status: "done", info: fmtBytes(blob.size) });
      postPill("backup", null);
      setStatus(`Backup downloaded (${fmtBytes(blob.size)}).`);
    } catch (err) {
      clearInterval(zipPoll);
      updateTransfer(tid, { status: "error", info: String(err.message || err).slice(0, 60) });
      postPill("backup", null);
      setStatus(`Export failed: ${err.message}`);
    }
  }

  // Restore an exported zip into an account. mode "replace": notes + settings
  // are replaced by the backup, uploaded files are merged in. mode "merge":
  // only pages/chats missing here are added, existing data wins. `target` is
  // another account (admins only); restoring into your own account reloads
  // afterwards — every piece of in-memory state (home feed, tabs, chats) is
  // stale — while another account's restore leaves this workspace alone.
  function importUserData(mode = "replace", target) {
    const who = target || authUser.user;
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".zip,application/zip";
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) return;
      setConfirmBox(mode === "merge" ? {
        title: "Merge backup",
        message: (
          <>Merge "{f.name}" ({fmtBytes(f.size)}) into the account "{who}"?
          {" "}Pages and chats from the backup that don't exist there yet will be <b>added</b>.
          {" "}Everything already in that account (including settings) is <b>kept unchanged</b>.</>
        ),
        confirmLabel: "Merge",
        onConfirm: () => runBackupImport(f, mode, who),
      } : {
        title: "Replace all data",
        message: (
          <>Restore "{f.name}" ({fmtBytes(f.size)}) into the account "{who}"?
          {" "}<b>ALL of that account's notes, chats, and settings will be REPLACED</b> by the backup.
          {" "}Uploaded PDFs are merged in (nothing is deleted). <b>This cannot be undone.</b></>
        ),
        confirmLabel: "Replace",
        danger: true,
        onConfirm: () => runBackupImport(f, mode, who),
      });
    };
    inp.click();
  }

  // XMLHttpRequest instead of fetch: it reports upload progress, so a large
  // zip shows a percent while the bytes go up, then an indeterminate
  // "restoring/merging" hint while the server unzips and swaps the databases.
  function runBackupImport(f, mode, target) {
    const merging = mode === "merge";
    const other = target && target !== authUser?.user ? target : null;
    const tid = addTransfer({ name: `${merging ? "Merge" : "Restore"} ${f.name}`.slice(0, 60), kind: "upload", info: "uploading…" });
    const fd = new FormData();
    fd.append("file", f);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/import-data?mode=${mode}${other ? `&user=${encodeURIComponent(other)}` : ""}`);
    xhr.withCredentials = true;
    // XHR bypasses the window.fetch wrapper, so the tab-identity guard header
    // must be set by hand — this is the most destructive endpoint in the app.
    const expected = getExpectedUser();
    if (expected) xhr.setRequestHeader("X-Gamma-User", expected);
    let lastPct = -1;
    xhr.upload.onprogress = (e) => {
      const pct = e.total ? Math.min(99, Math.floor((e.loaded / e.total) * 100)) : null;
      if (pct === lastPct) return; // only re-render on a visible change
      lastPct = pct;
      postPill("backup", {
        msg: pct == null ? "Uploading backup…" : `Uploading backup… ${pct}%`,
        spinner: true,
      });
      if (e.total) updateTransfer(tid, { info: `${fmtBytes(e.loaded)} / ${fmtBytes(e.total)}` });
    };
    xhr.upload.onload = () => {
      postPill("backup", {
        msg: merging ? "Merging backup into your library…" : "Restoring backup…",
        spinner: true,
      });
      updateTransfer(tid, { info: merging ? "merging…" : "restoring…" });
    };
    xhr.onload = () => {
      let d = {};
      try {
        d = JSON.parse(xhr.responseText);
      } catch {}
      postPill("backup", null);
      if (xhr.status >= 200 && xhr.status < 300) {
        updateTransfer(tid, { status: "done", info: merging ? `${d.pages_added ?? 0} pages added` : "restored" });
        // Another account's data changed, not this workspace's — nothing here
        // is stale, so stay put instead of throwing the session away.
        if (other) setStatus(`${merging ? "Merged into" : "Restored"} ${other}.`);
        else window.location.href = window.location.pathname; // fresh state, no stale ?block=
      } else {
        const msg = d.detail || xhr.statusText || "failed";
        updateTransfer(tid, { status: "error", info: String(msg).slice(0, 60) });
        setStatus(`Import failed: ${msg}`);
      }
    };
    xhr.onerror = () => {
      postPill("backup", null);
      updateTransfer(tid, { status: "error", info: "network error" });
      setStatus("Import failed: network error");
    };
    xhr.send(fd);
  }

  async function doLogout() {
    // Flush pending edits while the session is still valid. Setting authUser
    // false after the cookie is removed performs a local-only workspace
    // teardown, without starting reads that race logout.
    leaveCurrentPage();
    await fetch(`${API}/logout`, { method: "POST", credentials: "include" });
    // Logout kills the browser-wide session: tell other tabs of this account
    // so they drop to the login page instead of failing on their next save.
    try {
      localStorage.setItem("gamma-active-user", "");
    } catch {}
    setAuthUser(false);
  }

  useEffect(() => {
    if (!readOnly) checkSession();
  }, [readOnly]);

  const [inputUrl, setInputUrl] = useState(initialUrl); // current page's source URL (shown in page properties)
  const [addUrl, setAddUrl] = useState(""); // "+" popover: URL to open
  const [pdfUrl, setPdfUrl] = useState("");
  const [docId, setDocId] = useState("");
  const [focusedBlockId, setFocusedBlockId] = useState("");
  const [focusedBlock, setFocusedBlock] = useState(null);
  const [, setSummary] = useState("");
  const [category, setCategory] = useState("");
  const [pageFolders, setPageFolders] = useState([]); // focused page's folder labels (paths)
  const [categoryEditing, setCategoryEditing] = useState(false);
  const [categoryInput, setCategoryInput] = useState("");
  const [categorySuggestionIdx, setCategorySuggestionIdx] = useState(-1);
  const [categoryFilter, setCategoryFilter] = useState(initialCategory);
  // File-browser home: folders are "folder labels" — `properties.folder` is a
  // comma-separated list of paths ("readout/nondestructive, benchmarks"), so a
  // page can live in several folders at once (soft links) and `/` nests.
  // Folders themselves are derived from the paths in use; storage stays flat
  // at root. Empty (manually created) folders live in localStorage until a
  // paper lands in them. No folder tags → the page sits at the library root.
  const [folderFilter, setFolderFilter] = useState(initialFolder);
  const [folderDragOver, setFolderDragOver] = useState(null);
  const [extraFolders, setExtraFolders] = useState([]);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  // Home feed: per-folder sort criterion + how many rows are rendered (grows
  // on scroll). Changing the sort only pins it for the folder being viewed;
  // folders without an explicit choice inherit from their nearest ancestor.
  // Sort and kind are per-VIEW: the key is the folder path, or "#<label>" in a
  // label view. A view with no entry of its own inherits from its nearest
  // ancestor folder ("" = library root); labels are flat, so they inherit the
  // root's choice.
  const homeScope = categoryFilter ? `#${categoryFilter}` : folderFilter;
  const scopedPref = useCallback((map, dflt) => {
    let p = homeScope;
    if (p.startsWith("#")) return map[p] || map[""] || dflt;
    for (;;) {
      if (map[p]) return map[p];
      if (!p) return dflt;
      p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    }
  }, [homeScope]);
  const [homeSortMap, setHomeSortMap] = usePersistedState("gamma-home-sort-map", HOME_SORT_DEFAULT, HOME_MAP_CODEC);
  const homeSort = useMemo(() => scopedPref(homeSortMap, "updated"), [homeSortMap, scopedPref]);
  function changeHomeSort(v) { setHomeSortMap((m) => ({ ...m, [homeScope]: v })); }
  // Home layout: "list" (block-style rows) or "grid" (icon tiles).
  const [homeView, changeHomeView] = usePersistedState("gamma-home-view", "list");
  // Kind filter: "all" (folders + files), "folders", "files", or "labels" (the
  // labels used in this view, browsable like folders) — same per-view keying
  // and inheritance as the sort above.
  const [homeKindsMap, setHomeKindsMap] = usePersistedState("gamma-home-kinds-map", HOME_KINDS_DEFAULT, HOME_MAP_CODEC);
  const homeKinds = useMemo(() => scopedPref(homeKindsMap, "all"), [homeKindsMap, scopedPref]);
  function changeHomeKinds(v) { setHomeKindsMap((m) => ({ ...m, [homeScope]: v })); }
  // Listing search box (left of the sort pill): live, per-view, not persisted —
  // matches float to the top of the current sort, the rest dim in place.
  const [homeQuery, setHomeQuery] = useState("");
  useEffect(() => { setHomeQuery(""); }, [homeScope]);
  const HOME_PAGE_CHUNK = 30;
  const [homeShowCount, setHomeShowCount] = useState(HOME_PAGE_CHUNK);
  useEffect(() => { setHomeShowCount(HOME_PAGE_CHUNK); }, [folderFilter, categoryFilter, homeSort, homeKinds, homeQuery]);
  const loadMoreRef = useRef(null);
  function updateExtraFolders(updater) {
    setExtraFolders((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      const u = prefsUserRef.current;
      if (u) {
        try {
          localStorage.setItem(`gamma-extra-folders:${u}`, JSON.stringify(next));
        } catch {}
      }
      return next;
    });
  }

  // Load per-user browser prefs (tabs, manually created folders) on login /
  // account switch.
  useEffect(() => {
    const u = authUser?.user;
    if (!u || readOnly) {
      // Losing the session (logout button, expiry in another tab) must fully
      // close the workspace: a stale focusedBlockId would get merged into the
      // NEXT account's tab strip (applyServerTabs keeps the on-screen page) and
      // pushed to their server prefs, and the nav-back stack would reopen this
      // account's pages. Guarded on a previous user so the initial
      // session-loading render doesn't wipe the deep link / saved session.
      if (prefsUserRef.current && !readOnly) {
        // Local teardown only: there is no authenticated account to refresh.
        goHome(false);
        setNavStack([]);
      }
      prefsUserRef.current = "";
      setOpenTabs([]);
      setExtraFolders([]);
      setRecentViews([]);
      pageSnapsRef.current = {};
      setPageSnaps({});
      snapsSyncedRef.current = false;
      recentsSyncRef.current = "";
      readPosRef.current = {};
      readPosLoadedRef.current = false;
      appearanceSyncRef.current = "";
      appearanceLoadedRef.current = false;
      return;
    }
    prefsUserRef.current = u;
    tabsSyncRef.current = "";
    recentsSyncRef.current = "";
    snapsSyncedRef.current = false;
    appearanceSyncRef.current = "";
    appearanceLoadedRef.current = false;
    // Local cache first for instant paint…
    let localTabs = [];
    try {
      localTabs = JSON.parse(localStorage.getItem(`gamma-tabs:${u}`) || "[]");
    } catch {}
    setOpenTabs(Array.isArray(localTabs) ? localTabs : []);
    try { setExtraFolders(JSON.parse(localStorage.getItem(`gamma-extra-folders:${u}`) || "[]")); } catch { setExtraFolders([]); }
    let localRecents = [];
    try { localRecents = JSON.parse(localStorage.getItem(`gamma-recent-views:${u}`) || "[]"); } catch {}
    if (!Array.isArray(localRecents)) localRecents = [];
    setRecentViews(localRecents);
    let localSnaps = {};
    try { localSnaps = JSON.parse(localStorage.getItem(`gamma-page-snaps:${u}`) || "{}"); } catch {}
    pageSnapsRef.current = localSnaps && typeof localSnaps === "object" ? localSnaps : {};
    setPageSnaps(pageSnapsRef.current);
    readPosLoadedRef.current = false;
    try {
      readPosRef.current = JSON.parse(localStorage.getItem(`gamma-read-pos:${u}`) || "{}");
    } catch {
      readPosRef.current = {};
    }
    notesPosLoadedRef.current = false;
    try {
      notesPosRef.current = JSON.parse(localStorage.getItem(`gamma-notes-pos:${u}`) || "{}");
    } catch {
      notesPosRef.current = {};
    }
    // …then the server copy, which wins (tabs sync across browsers). An
    // account that has never synced seeds the server with this browser's tabs.
    apiJson(`${API}/prefs/open-tabs`)
      .then((d) => {
        if (prefsUserRef.current !== u) return;
        if (d.updated_at) applyServerTabs(u, d.value, d.updated_at);
        else if (Array.isArray(localTabs) && localTabs.length) pushTabsToServer(localTabs);
      })
      .catch(() => {});
    Promise.allSettled([
      apiJson(`${API}/prefs/recent-views`),
      apiJson(`${API}/page-snaps`),
    ]).then(([recentResult, snapResult]) => {
      if (prefsUserRef.current !== u) return;
      if (recentResult.status === "fulfilled") {
        if (recentResult.value.updated_at) {
          applyServerRecents(u, recentResult.value.value, recentResult.value.updated_at);
        } else if (localRecents.length) pushRecentsToServer(localRecents);
      }
      if (snapResult.status === "fulfilled") {
        mergePageSnaps(snapResult.value.snaps, { heal: true });
        snapsSyncedRef.current = true;
      }
    });
    apiJson(`${API}/prefs/read-pos`)
      .then((d) => {
        if (prefsUserRef.current !== u) return;
        readPosLoadedRef.current = true;
        if (mergeReadPos(u, d.value)) pushReadPosSoon(u);
      })
      .catch(() => {
        if (prefsUserRef.current === u) readPosLoadedRef.current = true;
      });
    // Appearance: apply the account's copy; a validation miss (stale value
    // shape) leaves the local state, and the push effect then normalizes the
    // server copy. A GET failure keeps the gate closed so this session can't
    // clobber a copy it never saw.
    apiJson(`${API}/prefs/appearance`)
      .then((d) => {
        if (prefsUserRef.current !== u) return;
        if (d.updated_at && d.value && typeof d.value === "object") {
          const t = THEMES.includes(d.value.theme) ? d.value.theme : undefined;
          const pd = typeof d.value.pdfDark === "boolean" ? d.value.pdfDark : undefined;
          if (t !== undefined && pd !== undefined) {
            appearanceSyncRef.current = JSON.stringify({ theme: t, pdfDark: pd });
          }
          if (t !== undefined) setTheme(t);
          if (pd !== undefined) setPdfDarkPage(pd);
        }
        appearanceLoadedRef.current = true;
      })
      .catch(() => {});
    apiJson(`${API}/prefs/notes-pos`)
      .then((d) => {
        if (prefsUserRef.current !== u) return;
        notesPosLoadedRef.current = true;
        if (mergeNotesPos(u, d.value)) pushNotesPosSoon(u);
      })
      .catch(() => {
        if (prefsUserRef.current === u) notesPosLoadedRef.current = true;
      });
    // Which model answers is an account-level choice, not a per-browser one:
    // localStorage alone means a new browser (or cleared site data) silently
    // drops the user onto whichever provider happens to be first.
    aiSelLoadedRef.current = false;
    apiJson(`${API}/prefs/ai-selection`)
      .then((d) => {
        if (prefsUserRef.current !== u) return;
        const v = d.value || {};
        if (d.updated_at && v.model) {
          // Set the provider first: the effect that keeps the model inside the
          // active key's list would otherwise see the new model against the old
          // key and snap it back.
          setAiProvider(v.provider || "");
          setChatModel(v.model);
          if (typeof v.effort === "string") setChatEffort(v.effort);
        }
        aiSelLoadedRef.current = true; // pushes are armed only after this
      })
      .catch(() => {
        if (prefsUserRef.current === u) aiSelLoadedRef.current = true;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the four helpers are unstable; load on user/readOnly change only
  }, [authUser?.user, readOnly]);

  // Write a page's tag-list property ("folder" nests on "/", "category" is
  // flat) — both serialize as a comma-separated list, so neither character
  // may appear in a segment name.
  async function writePageTags(pageId, property, tags) {
    await apiJson(`${API}/blocks/${pageId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { [property]: tags.join(", ") } }),
    });
  }
  const writePageFolders = (pageId, tags) => writePageTags(pageId, "folder", tags);

  function commitNewFolder() {
    const name = cleanFolderSegment(newFolderName);
    setNewFolderOpen(false);
    setNewFolderName("");
    if (!name) return;
    const path = folderFilter ? `${folderFilter}/${name}` : name;
    updateExtraFolders((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }

  // --- Home file-manager: multi-select + copy/move/delete, folder rename ---
  const [selectedPages, setSelectedPages] = useState(() => new Set());
  const [selectedFolders, setSelectedFolders] = useState(() => new Set());
  const [selectedLabels, setSelectedLabels] = useState(() => new Set());
  const lastPageClickRef = useRef(null); // anchor for shift-range selection
  const [homeMenu, setHomeMenu] = useState(null); // {kind:"page"|"folder", id?, name, x, y}
  const [folderRenaming, setFolderRenaming] = useState(null); // {name, draft}
  const [labelRenaming, setLabelRenaming] = useState(null); // {name, draft}

  function clearSelection() {
    setSelectedPages(new Set());
    setSelectedFolders(new Set());
    setSelectedLabels(new Set());
  }

  // Modern file-manager semantics: plain click SELECTS, double-click opens.
  // Ctrl/Cmd toggles a single item; Shift extends a range from the last click.
  function handlePageClick(pageBlock, e) {
    const id = pageBlock._pageId;
    if (!id) return;
    setSelectedFolders(new Set());
    setSelectedLabels(new Set());
    if (e && (e.ctrlKey || e.metaKey)) {
      setSelectedPages((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      lastPageClickRef.current = id;
      return;
    }
    if (e && e.shiftKey && lastPageClickRef.current) {
      const order = homeVisiblePages.map((b) => b._pageId);
      const a = order.indexOf(lastPageClickRef.current);
      const b = order.indexOf(id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelectedPages((prev) => {
          const next = new Set(prev);
          for (let i = lo; i <= hi; i++) next.add(order[i]);
          return next;
        });
        return;
      }
    }
    // Plain click: select just this page (replacing any prior selection).
    lastPageClickRef.current = id;
    setSelectedPages(new Set([id]));
  }

  function currentHomeOrigin(kind = "home") {
    if (kind === "search") {
      return {
        kind: "search",
        folder: categoryFilter ? undefined : folderFilter || undefined,
        label: categoryFilter || undefined,
      };
    }
    if (categoryFilter) return { kind: "label", label: categoryFilter };
    if (folderFilter) return { kind: "folder", folder: folderFilter };
    return { kind: "root" };
  }

  // Double-click / Enter / context-menu "Open": remember which library view
  // launched the page. Tab switches omit origin, so they never overwrite it.
  function openPage(id) {
    if (!id) return;
    clearSelection();
    openBlock(id, { restoreScroll: true, origin: currentHomeOrigin() });
  }

  // Container (folder or label) single-click selects, Ctrl/Cmd toggles within
  // its own kind; either way the other kinds' selections clear. Double-click
  // navigates in. Labels are the flat mirror of folders — same semantics,
  // same cards and rows, no nesting.
  function handleContainerClick(kind, name, e) {
    if (kind === "folder" && folderRenaming?.name === name) return;
    const setOwn = kind === "folder" ? setSelectedFolders : setSelectedLabels;
    setSelectedPages(new Set());
    (kind === "folder" ? setSelectedLabels : setSelectedFolders)(new Set());
    if (e && (e.ctrlKey || e.metaKey)) {
      setOwn((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
    } else {
      setOwn(new Set([name]));
    }
  }
  const handleFolderClick = (path, e) => handleContainerClick("folder", path, e);
  const handleLabelClick = (name, e) => handleContainerClick("label", name, e);
  function openFolder(path) {
    clearSelection();
    setFolderFilter(path);
    setCategoryFilter("");
    window.history.replaceState(null, "", homeUrlFor(path, ""));
  }
  // Opening a label KEEPS the folder scope, so a label opened inside a folder
  // reads as "this folder, narrowed to that label".
  function openLabel(name, folder = folderFilter) {
    clearSelection();
    setCategoryFilter(name);
    if (folder !== folderFilter) setFolderFilter(folder);
    window.history.replaceState(null, "", homeUrlFor(folder, name));
  }
  function closeLabel() {
    clearSelection();
    setCategoryFilter("");
    window.history.replaceState(null, "", homeUrlFor(folderFilter, ""));
  }
  // Commit a grid-tile rename (list rows rename inline via the block editor).
  function commitPageRename(id, text) {
    setHomeEditingId(null);
    const t = (text || "").trim();
    const cur = homeBlocks.find((b) => b.id === id)?.content || "";
    if (!t || t === cur) return;
    setHomeBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, content: t } : b)));
    apiJson(`${API}/blocks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: t }),
    }).catch((err) => setStatus(`Rename failed: ${err}`));
  }

  // Deep-copy a page: new root block + a subtree clone with fresh block ids
  // (highlight ids regenerated and same-page references remapped).
  async function duplicatePage(pageId) {
    const data = await apiJson(`${API}/blocks/${pageId}/subtree`);
    const src = data.block || {};
    const created = await apiJson(`${API}/blocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parent_id: "root",
        content: `${src.content || "Untitled"} (copy)`,
        properties: src.properties || {},
      }),
    });
    const hlMap = new Map();
    const clone = (list) =>
      (list || []).map((b) => {
        const props = { ...(b.properties || {}) };
        if (props.highlight_id) {
          const nid = makeId();
          hlMap.set(props.highlight_id, nid);
          props.highlight_id = nid;
        }
        return { ...b, id: makeId(), properties: props, children: clone(b.children) };
      });
    const remap = (list) => {
      for (const b of list || []) {
        const p = b.properties;
        if (p.linked_highlight_id && hlMap.has(p.linked_highlight_id))
          p.linked_highlight_id = hlMap.get(p.linked_highlight_id);
        remap(b.children);
      }
    };
    const cloned = clone(normalizeBlocks(src.children || []));
    remap(cloned);
    await apiJson(`${API}/blocks/${created.id}/children`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks: cloned }),
    });
    return created.id;
  }
  async function duplicatePages(ids) {
    setStatus(`Copying ${ids.length} page${ids.length === 1 ? "" : "s"}…`);
    try {
      for (const id of ids) await duplicatePage(id);
      clearSelection();
      await fetchHomeBlocks();
      setStatus(`Copied ${ids.length} page${ids.length === 1 ? "" : "s"}.`);
    } catch (err) {
      setStatus(`Copy failed: ${err.message}`);
    }
  }

  function deletePages(ids) {
    setConfirmBox({
      title: ids.length === 1 ? "Delete page" : `Delete ${ids.length} pages`,
      message: `Delete ${ids.length === 1 ? "this page" : `these ${ids.length} pages`} and all their notes? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        for (const id of ids) {
          try {
            await apiJson(`${API}/blocks/${id}`, { method: "DELETE" });
          } catch {}
        }
        updateTabs((prev) => prev.filter((t) => !ids.includes(t.id)));
        clearSelection();
        await fetchHomeBlocks();
        setStatus(`Deleted ${ids.length} page${ids.length === 1 ? "" : "s"}.`);
      },
    });
  }

  // Pin/unpin pages. Stored on the page (properties.pinned = ISO timestamp),
  // so it syncs across devices like folder tags. "" unpins.
  async function setPagesPinned(ids, pinned) {
    const stamp = pinned ? new Date().toISOString() : "";
    try {
      for (const id of ids) {
        await apiJson(`${API}/blocks/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ properties: { pinned: stamp } }),
        });
      }
      await fetchHomeBlocks();
    } catch (err) {
      setStatus(`Pin failed: ${err.message || err}`);
    }
  }

  // Rewrite one tag list ("folder" or "category") on each page: `rewrite`
  // maps the current tags to the new list, or null to leave the page alone.
  // Returns how many pages changed; the selection and listing are refreshed.
  async function retagPages(ids, property, rewrite) {
    let changed = 0;
    for (const id of ids) {
      const b = homeBlocks.find((x) => x.id === id);
      if (!b) continue;
      const next = rewrite(parseFolderTags(b.properties?.[property]));
      if (!next) continue;
      try { await writePageTags(id, property, next); changed++; } catch {}
    }
    clearSelection();
    await fetchHomeBlocks();
    return changed;
  }
  const plural = (n) => `${n} page${n === 1 ? "" : "s"}`;

  // Add pages to a folder (soft link — other folder tags are kept). The only
  // tag removed is an ancestor of the target: dragging a "readout" paper into
  // readout/nondestructive refines it, it shouldn't stay in both levels.
  async function addPagesToFolder(ids, path) {
    updateExtraFolders((prev) => prev.filter((f) => f !== path));
    const changed = await retagPages(ids, "folder", (tags) =>
      tags.includes(path) ? null : addFolderTag(tags, path),
    );
    setStatus(changed ? `Added ${plural(changed)} to “${path}”.` : `Already in “${path}”.`);
  }

  // Label mirror — labels are flat, so a soft add with no ancestor
  // refinement. Dropping a paper on a label tile lands here.
  async function addPagesToLabel(ids, name) {
    const changed = await retagPages(ids, "category",
      (tags) => (tags.includes(name) ? null : [...tags, name]));
    setStatus(changed ? `Labelled ${plural(changed)} “${name}”.` : `Already labelled “${name}”.`);
  }

  // Remove one label from pages (the label view's back-row drop target).
  async function removePagesFromLabel(ids, name) {
    await retagPages(ids, "category",
      (tags) => (tags.includes(name) ? tags.filter((t) => t !== name) : null));
    setStatus(`Removed ${plural(ids.length)} from “${name}”.`);
  }

  // Remove one folder tag (exact path). With path = "" strips ALL folder tags.
  async function removePagesFromFolder(ids, path) {
    await retagPages(ids, "folder", (tags) => {
      const next = path ? tags.filter((t) => t !== path) : [];
      return next.length === tags.length ? null : next;
    });
    setStatus(path ? `Removed ${plural(ids.length)} from “${path}”.` : "Cleared folder tags.");
  }

  // Apply a path-rewriting map to every folder tag in the library: pages, the
  // localStorage-only empties, the open page's chips, and the active folder
  // filter all follow. Shared by folder rename and folder move.
  async function applyFolderMap(mapTag) {
    for (const b of homeBlocks) {
      const tags = parseFolderTags(b.properties?.folder);
      const next = [...new Set(tags.map(mapTag))];
      if (next.join(",") === tags.join(",")) continue;
      try {
        await writePageFolders(b.id, next);
      } catch {}
    }
    updateExtraFolders((prev) => [...new Set(prev.map(mapTag))]);
    setPageFolders((prev) => [...new Set(prev.map(mapTag))]);
    const nextFilter = mapTag(folderFilter);
    if (nextFilter !== folderFilter) {
      setFolderFilter(nextFilter);
      window.history.replaceState(null, "", homeUrlFor(nextFilter, categoryFilter));
    }
    await fetchHomeBlocks();
  }

  const prefixMapTag = (oldPath, newPath) => (t) =>
    t === oldPath ? newPath : t.startsWith(oldPath + "/") ? newPath + t.slice(oldPath.length) : t;

  // Rename one path segment: rewrites the prefix on every page's folder tags,
  // so renaming a parent folder carries all its subfolders along.
  async function renameFolder(oldPath, newNameRaw) {
    const newName = cleanFolderSegment(newNameRaw);
    setFolderRenaming(null);
    const parent = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : "";
    const newPath = parent ? `${parent}/${newName}` : newName;
    if (!newName || newPath === oldPath) return;
    await applyFolderMap(prefixMapTag(oldPath, newPath));
    setStatus(`Folder renamed to “${newPath}”.`);
  }

  // Move folders (with their subtrees) under a new parent path ("" = top
  // level). One combined rewrite pass so a page tagged with several of the
  // moved folders isn't clobbered by sequential sweeps.
  async function moveFolders(paths, newParent) {
    const moves = [];
    for (const oldPath of paths) {
      if (newParent === oldPath || newParent.startsWith(oldPath + "/")) continue; // into itself
      const name = oldPath.slice(oldPath.lastIndexOf("/") + 1);
      const newPath = newParent ? `${newParent}/${name}` : name;
      if (newPath !== oldPath) moves.push([oldPath, newPath]);
    }
    if (!moves.length) return;
    await applyFolderMap((t) => {
      for (const [oldPath, newPath] of moves) {
        if (t === oldPath) return newPath;
        if (t.startsWith(oldPath + "/")) return newPath + t.slice(oldPath.length);
      }
      return t;
    });
    clearSelection();
    setStatus(`Moved ${moves.length === 1 ? `“${moves[0][0]}”` : `${moves.length} folders`} to “${newParent || "All files"}”.`);
  }

  // Folders share the "text/plain" drag channel with page cards — prefixed so
  // drop targets can tell them apart. Returns null for a page drag.
  function droppedFolderPaths(e) {
    const raw = e.dataTransfer.getData("text/plain");
    if (!raw.startsWith(FOLDER_DRAG)) return null;
    const path = raw.slice(FOLDER_DRAG.length);
    return selectedFolders.has(path) && selectedFolders.size > 1 ? [...selectedFolders] : [path];
  }

  // Shared drop dispatch for folder rows/tiles: a folder drag moves folders,
  // a page-card drag moves the dragged (or whole selected) pages. The back-row
  // overrides onPages to remove from the open folder instead.
  function dropOnFolder(e, target, onPages = (ids) => addPagesToFolder(ids, target)) {
    e.preventDefault();
    setFolderDragOver(null);
    const folders = droppedFolderPaths(e);
    if (folders) {
      moveFolders(folders, target);
      return;
    }
    const ids = droppedPageIds(e);
    if (ids) onPages(ids);
  }

  // Drop dispatch for label rows/tiles: pages get the label, folder drags are
  // ignored (a folder can't be "labelled" — its papers each carry their own).
  function dropOnLabel(e, name, onPages = (ids) => addPagesToLabel(ids, name)) {
    e.preventDefault();
    setFolderDragOver(null);
    if (droppedFolderPaths(e)) { setStatus("Folders can’t carry labels — drop papers instead."); return; }
    const ids = droppedPageIds(e);
    if (ids) onPages(ids);
  }
  // The pages a card drag carries: the whole selection when the dragged card
  // is part of a multi-select, else just that card.
  function droppedPageIds(e) {
    const id = e.dataTransfer.getData("text/plain");
    if (!id) return null;
    return selectedPages.has(id) && selectedPages.size > 1 ? [...selectedPages] : [id];
  }

  function deleteFolderByName(path) {
    const inPath = (t) => t === path || t.startsWith(path + "/");
    const members = homeBlocks.filter((b) => parseFolderTags(b.properties?.folder).some(inPath));
    const cleanupAfter = async (statusMsg) => {
      updateExtraFolders((prev) => prev.filter((f) => !inPath(f)));
      setPageFolders((prev) => prev.filter((t) => !inPath(t)));
      if (folderFilter === path || folderFilter.startsWith(path + "/")) {
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        setFolderFilter(parent);
        window.history.replaceState(null, "", homeUrlFor(parent, categoryFilter));
      }
      clearSelection();
      await fetchHomeBlocks();
      setStatus(statusMsg);
    };
    if (!members.length) {
      setConfirmBox({
        title: "Delete folder",
        message: `Delete the empty folder “${path}”?`,
        confirmLabel: "Delete folder",
        onConfirm: () => cleanupAfter(`Folder “${path}” deleted.`),
      });
      return;
    }
    const n = members.length;
    const papers = `${n} paper${n === 1 ? "" : "s"}`;
    setConfirmBox({
      title: "Delete folder",
      message: `Delete “${path}”? It contains ${papers}. Keep ${n === 1 ? "it" : "them"} in the library (only the folder goes away), or delete ${n === 1 ? "it and its" : "them and their"} notes too — papers linked into other folders are deleted as well.`,
      confirmLabel: "Keep papers",
      onConfirm: async () => {
        for (const b of members) {
          try {
            await writePageFolders(
              b.id,
              parseFolderTags(b.properties?.folder).filter((t) => !inPath(t)),
            );
          } catch {}
        }
        await cleanupAfter(`Folder “${path}” deleted — its ${papers} stay in the library.`);
      },
      altLabel: `Delete ${papers} too`,
      altDanger: true,
      onAlt: async () => {
        const ids = members.map((b) => b.id);
        for (const id of ids) {
          try { await apiJson(`${API}/blocks/${id}`, { method: "DELETE" }); } catch {}
        }
        updateTabs((prev) => prev.filter((t) => !ids.includes(t.id)));
        await cleanupAfter(`Folder “${path}” and its ${papers} deleted.`);
      },
    });
  }

  // The label mirror of applyFolderMap (labels are flat — no prefix logic):
  // rewrite properties.category on every page, then re-sync the active label
  // filter, the open page's chips, and the home list. mapTag returns the new
  // tag, or null to drop it. Returns the number of pages rewritten.
  async function applyLabelMap(mapTag) {
    let changed = 0;
    for (const b of homeBlocks) {
      const tags = parseFolderTags(b.properties?.category);
      const next = [...new Set(tags.map(mapTag).filter(Boolean))];
      if (next.join(",") === tags.join(",")) continue;
      try { await writePageTags(b.id, "category", next); changed++; } catch {}
    }
    const nextFilter = categoryFilter ? mapTag(categoryFilter) || "" : "";
    if (nextFilter !== categoryFilter) {
      setCategoryFilter(nextFilter);
      window.history.replaceState(null, "", homeUrlFor(folderFilter, nextFilter));
    }
    setCategory((prev) => {
      const tags = parseFolderTags(prev);
      const next = [...new Set(tags.map(mapTag).filter(Boolean))];
      return next.join(",") === tags.join(",") ? prev : next.join(", ");
    });
    await fetchHomeBlocks();
    return changed;
  }

  async function renameLabel(oldName, newNameRaw) {
    // cleanFolderSegment strips "/" too — a renamed label must stay a flat
    // label, not turn into a folder path.
    const newName = cleanFolderSegment(newNameRaw);
    setLabelRenaming(null);
    if (!newName || newName === oldName) return;
    const changed = await applyLabelMap((t) => (t === oldName ? newName : t));
    setStatus(`Label renamed to “${newName}” on ${changed} page${changed === 1 ? "" : "s"}.`);
  }

  function deleteLabelByName(name) {
    const members = homeBlocks.filter((b) =>
      parseFolderTags(b.properties?.category).includes(name),
    );
    setConfirmBox({
      title: "Delete label",
      message: members.length
        ? `Delete “${name}”? The label is removed from its ${members.length} page${members.length === 1 ? "" : "s"} — no pages are deleted.`
        : `Delete the label “${name}”?`,
      confirmLabel: "Delete label",
      onConfirm: async () => {
        await applyLabelMap((t) => (t === name ? null : t));
        setStatus(`Label “${name}” deleted.`);
      },
    });
  }

  // Right-click on a folder or label chip anywhere opens the shared home
  // context menu (rename/delete) for it.
  const openTagMenu = (kind, name) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    setHomeMenu({ kind, name, x: e.clientX, y: e.clientY });
  };
  // Right-click on a page card or row: select it if it isn't already part of
  // the selection, then open the shared home context menu for it.
  const openPageMenu = (id, name) => (e) => {
    e.preventDefault();
    setSelectedPages((prev) => (prev.has(id) ? prev : new Set([id])));
    lastPageClickRef.current = id;
    setHomeMenu({ kind: "page", id, name, x: e.clientX, y: e.clientY });
  };
  const [pdfPageNumber, setPdfPageNumber] = useState(() => loadSession().pdfPageNumber || 1);
  const [pdfEffScale, setPdfEffScale] = useState(1); // actual render scale (incl. fit-width)
  // Browser fullscreen (whole app, like F11). webkit-prefixed fallbacks are
  // for iPadOS Safari, which never shipped the unprefixed API.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFs = () =>
      setIsFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
    };
  }, []);
  // iPhone Safari (and thus every iOS browser) has no element Fullscreen API
  // at all — fall back to a CSS pseudo-fullscreen that hides the app chrome.
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  function toggleFullscreen() {
    if (!(document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
      setPseudoFullscreen((v) => !v);
      return;
    }
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      const el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
    }
  }
  const restoredPdfUrlRef = useRef(null);
  const coarseRestorePendingRef = useRef(false); // last-read jump not yet applied
  const [blocks, setBlocks] = useState([]);
  const [homeBlocks, setHomeBlocks] = useState([]);
  const [refCache, setRefCache] = useState({}); // { [blockId]: { content, page_title } }
  const [backlinks, setBacklinks] = useState([]);
  const [chatHidden, setChatHidden] = useState(false);
  const [homeEditingId, setHomeEditingId] = useState(null);
  // ---- Unified floating message pill ---------------------------------------
  // ONE pill, many sources. Each source posts into its own named channel
  // (status messages, the PDF load lifecycle, …) via postPill(channel, entry);
  // the pill renders a single winner, so messages can never overlap.
  //   entry: { msg, spinner?, error?, retry?, final? }
  // Ongoing entries (spinner) hold their channel until the source posts again
  // or clears it (entry = null). Final entries linger ~0.6s, then fade out.
  // When several channels are active: error > lingering final > ongoing,
  // ties broken by recency.
  const [status, setStatusRaw] = useState("Ready.");
  // System log (Settings → Diagnostics): status messages, PDF load activity,
  // and uncaught errors from this session. In-memory only.
  const [sysLog, setSysLog] = useState([]); // [{t, msg}], capped
  const logSys = useCallback((msg) => {
    setSysLog((prev) => [...prev.slice(-499), { t: Date.now(), msg: String(msg) }]);
  }, []);
  useEffect(() => {
    const onErr = (e) =>
      logSys(
        `error: ${e.message || "unknown"}${e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : ""}`,
      );
    const onRej = (e) =>
      logSys(`unhandled rejection: ${e.reason?.message || e.reason || "unknown"}`);
    const onApi = (e) => {
      if (e.detail?.message) logSys(e.detail.message);
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    window.addEventListener("gamma-api-log", onApi);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
      window.removeEventListener("gamma-api-log", onApi);
    };
  }, [logSys]);
  // Debug log level (Settings → Diagnostics): when on, position-tracking and
  // sync events go to the system log (and the console), so a lost reading
  // position can be traced from any device — the log pane has a Copy button.
  const [debugLog, setDebugLog] = usePersistedFlag("gamma-debug-log", false);
  const debugLogRef = useRef(debugLog);
  useEffect(() => {
    debugLogRef.current = debugLog;
  }, [debugLog]);
  const dbg = useCallback(
    (...args) => {
      if (!debugLogRef.current) return;
      const msg =
        "dbg: " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      console.log(msg);
      logSys(msg);
    },
    [logSys],
  );
  const [pillChannels, setPillChannels] = useState({}); // channel -> entry (+ seq, fading)
  const pillSeqRef = useRef(0);
  const pillTimersRef = useRef({}); // channel -> pending linger/fade timers
  // opts.after = [ms, patch]: once ms elapse — if this entry still owns the
  // channel — merge patch into it, or clear the channel when patch is null.
  // Callers use it for escalations and stuck-spinner caps without touching
  // the timer bookkeeping themselves.
  const postPill = useCallback((channel, entry, opts) => {
    const timers = pillTimersRef.current;
    (timers[channel] || []).forEach(clearTimeout);
    delete timers[channel];
    if (!entry) {
      setPillChannels((prev) => {
        if (!(channel in prev)) return prev;
        const next = { ...prev };
        delete next[channel];
        return next;
      });
      return;
    }
    const seq = ++pillSeqRef.current;
    setPillChannels((prev) => ({ ...prev, [channel]: { ...entry, seq, fading: false } }));
    // Only touch the entry we posted — a newer post owns the channel.
    const ifMine = (fn) =>
      setPillChannels((prev) => (prev[channel]?.seq === seq ? fn(prev) : prev));
    if (entry.final) {
      timers[channel] = [
        setTimeout(
          () => ifMine((prev) => ({ ...prev, [channel]: { ...prev[channel], fading: true } })),
          600,
        ),
        setTimeout(
          () =>
            ifMine((prev) => {
              const next = { ...prev };
              delete next[channel];
              return next;
            }),
          1000,
        ),
      ];
    }
    if (opts?.after) {
      const [ms, patch] = opts.after;
      (timers[channel] ||= []).push(
        setTimeout(
          () =>
            ifMine((prev) => {
              const next = { ...prev };
              if (patch === null) delete next[channel];
              else next[channel] = { ...next[channel], ...patch };
              return next;
            }),
          ms,
        ),
      );
    }
  }, []);
  useEffect(
    () => () => Object.values(pillTimersRef.current).forEach((ts) => ts.forEach(clearTimeout)),
    [],
  );
  const pillShown = useMemo(() => {
    const rank = (e) => (e.error ? 3 : e.final ? 2 : 1);
    return (
      Object.values(pillChannels).sort((a, b) => rank(b) - rank(a) || b.seq - a.seq)[0] || null
    );
  }, [pillChannels]);
  // Status messages: logged (Settings → Diagnostics), mirrored into the
  // optional debug status bar, and posted to the pill. Messages ending in
  // "…"/"..." are in-progress; anything else is final.
  const setStatus = useCallback(
    (msg) => {
      const text = String(msg);
      setStatusRaw(text);
      logSys(text);
      const ongoing = /(\.\.\.|…)\s*$/.test(text);
      postPill("status", { msg: text, spinner: ongoing, final: !ongoing });
    },
    [postPill, logSys],
  );
  const [loading, setLoading] = useState(false);
  // Window layout: ordered window ids per dock slot. Sizes are handled by
  // react-resizable-panels (persisted via autoSaveId), so this only stores
  // which window lives where and in what order.
  const [layout, setLayout] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("gamma-layout") || "null");
      if (saved && saved.left && saved.right && saved.bottom) return saved;
    } catch {}
    return { left: [], right: ["notes", "chat"], bottom: [] };
  });
  useEffect(() => {
    try {
      localStorage.setItem("gamma-layout", JSON.stringify(layout));
    } catch {}
  }, [layout]);

  // Move a window to a slot at an index (drag-to-dock and drag-to-reorder).
  function moveWindow(id, side, index) {
    setLayout((prev) => {
      const next = {
        left: prev.left.filter((w) => w !== id),
        right: prev.right.filter((w) => w !== id),
        bottom: prev.bottom.filter((w) => w !== id),
      };
      const arr = [...next[side]];
      arr.splice(Math.max(0, Math.min(index, arr.length)), 0, id);
      next[side] = arr;
      return next;
    });
  }
  // Open tabs (Chrome-style): [{id, title, origin?}], stored PER USER. origin
  // is the library/search context that explicitly opened this tab; switching
  // tabs never rewrites it. localStorage is
  // only a cache for instant paint — the server (/api/prefs/open-tabs) is the
  // source of truth, so tabs follow the account across browsers. Local changes
  // are debounce-pushed; regaining focus pulls the latest stored state.
  // Persistence happens inside the updater (not an effect) so a user switch
  // can't race an in-flight save into the wrong key.
  const [openTabs, setOpenTabs] = useState([]);
  const prefsUserRef = useRef(""); // whose tabs/folders are currently loaded
  const tabsSyncRef = useRef(""); // updated_at of the last server state we applied/wrote
  const tabsPushTimerRef = useRef(null);
  // Appearance (theme + flipped PDF colors) follows the account through
  // /api/prefs/appearance: the server copy wins on login, a browser that
  // syncs first seeds it, later changes push back. localStorage stays the
  // instant-paint cache — the index.html pre-paint script keeps reading it.
  const appearanceSyncRef = useRef("");      // JSON of the last state applied/pushed
  const appearanceLoadedRef = useRef(false); // gate: no pushes before a successful pull
  function pushTabsToServer(tabs) {
    if (tabsPushTimerRef.current) clearTimeout(tabsPushTimerRef.current);
    tabsPushTimerRef.current = setTimeout(async () => {
      tabsPushTimerRef.current = null;
      if (!prefsUserRef.current) return;
      try {
        const d = await apiJson(`${API}/prefs/open-tabs`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: tabs }),
        });
        tabsSyncRef.current = d.updated_at || "";
      } catch {}
    }, 600);
  }
  // Apply a server-side tabs state locally without echoing it back. A pending
  // local push is cancelled — the server copy applied here supersedes it (the
  // merge below re-pushes when this window still holds a tab the server lost).
  function applyServerTabs(user, value, updatedAt) {
    tabsSyncRef.current = updatedAt || "";
    if (tabsPushTimerRef.current) {
      clearTimeout(tabsPushTimerRef.current);
      tabsPushTimerRef.current = null;
    }
    setOpenTabs((prev) => {
      let tabs = orderTabs(Array.isArray(value) ? value : []);
      // The page open in THIS window keeps its tab even when the stored state
      // lacks it (just opened here and not pushed yet, or closed elsewhere
      // while it's still on screen here) — merged and pushed back.
      const fid = focusedBlockIdRef.current;
      if (fid && !tabs.some((t) => t.id === fid)) {
        tabs = [...tabs, prev.find((t) => t.id === fid) || { id: fid, title: "Untitled" }];
        pushTabsToServer(tabs);
      }
      try {
        localStorage.setItem(`gamma-tabs:${user}`, JSON.stringify(tabs));
      } catch {}
      return tabs;
    });
  }
  // Pinned tabs always sit left of unpinned ones; the partition is stable, so
  // pinning a tab lands it right after the existing pinned group and unpinning
  // drops it at the front of the unpinned group — no explicit move needed.
  const orderTabs = (tabs) => [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
  function updateTabs(updater) {
    setOpenTabs((prev) => {
      const next = orderTabs(typeof updater === "function" ? updater(prev) : updater);
      const u = prefsUserRef.current;
      if (u) {
        try {
          localStorage.setItem(`gamma-tabs:${u}`, JSON.stringify(next));
        } catch {}
        pushTabsToServer(next);
      }
      return next;
    });
  }
  // pinned: true | undefined (undefined keys drop out of the synced JSON).
  function toggleTabPinned(id) {
    updateTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, pinned: t.pinned ? undefined : true } : t)),
    );
  }
  // Last-read positions, synced like tabs so "jump to last read" follows the
  // account across browsers: blockId -> {page, at}. Per-paper entries merged
  // newest-wins, so two open windows only conflict when reading the SAME
  // paper (last writer wins) — unlike the old single global session slot,
  // which any window (or goHome's clearSession) could clobber.
  const readPosRef = useRef({});
  const readPosLoadedRef = useRef(false); // first server response arrived
  const readPosPushTimerRef = useRef(null);
  // Notes-panel positions, synced across browsers like read-pos: blockId ->
  // {block, frac, at}. The anchor (which block sits at the viewport top and
  // how far into it) is layout-independent — a phone window restores the same
  // content position as the desktop even though row wrapping differs.
  const notesPosRef = useRef({});
  const notesPosLoadedRef = useRef(false);
  const notesPosPushTimerRef = useRef(null);
  const notesPosSentRef = useRef("");
  const [notesPosTick, setNotesPosTick] = useState(0); // re-run notes restore after a server merge
  const notesScrollTimerRef = useRef(null);
  const aiSelLoadedRef = useRef(false); // server copy of the AI choice has been read
  const aiSelPushTimerRef = useRef(null);
  // Serialization of the copy the server is CONFIRMED to hold (successful
  // PUT, or a pull that showed both sides equal) — lets pushes no-op when
  // there is nothing new to say.
  const readPosSentRef = useRef("");
  // Merge the server copy in (per-entry newest-wins) and report whether the
  // merged map holds anything the server doesn't — i.e. a local entry the
  // server never received because a push was dropped while it was down or
  // restarting. Callers push the merged map back when so: pushing a superset
  // of what was just pulled can only add entries, never regress one, and it
  // doubles as the retry for those silently-dropped pushes.
  function mergeReadPos(user, server) {
    const merged = { ...readPosRef.current };
    const s = server && typeof server === "object" ? server : {};
    for (const [id, e] of Object.entries(s)) {
      if (!e || typeof e.page !== "number") continue;
      if (!merged[id] || (e.at || "") > (merged[id].at || "")) merged[id] = e;
    }
    readPosRef.current = merged;
    try {
      localStorage.setItem(`gamma-read-pos:${user}`, JSON.stringify(merged));
    } catch {}
    const newer = Object.entries(merged).filter(
      ([id, e]) => !s[id] || (e.at || "") > (s[id].at || ""),
    );
    dbg(
      "read-pos merged;",
      Object.keys(s).length,
      "server entries;",
      newer.length
        ? `local newer: ${newer.map(([id, e]) => `${id}=p${e.page}`).join(",")}`
        : "in sync",
    );
    // In sync means the server is confirmed to hold exactly this copy.
    if (!newer.length) readPosSentRef.current = JSON.stringify({ value: merged });
    return newer.length > 0;
  }
  // Server copy of the notes anchors, newest-wins per page. Merged anchors
  // are also written into tabScrollRef so the notes-restore effect (which
  // reads that ref) lands on the same content the other device was viewing.
  function mergeNotesPos(user, server) {
    const merged = { ...notesPosRef.current };
    const s = server && typeof server === "object" ? server : {};
    let applied = false;
    for (const [id, e] of Object.entries(s)) {
      if (!e || typeof e.block !== "string" || !e.block) continue;
      if (!merged[id] || (e.at || "") > (merged[id].at || "")) {
        merged[id] = e;
        const prev = tabScrollRef.current[id] || {};
        tabScrollRef.current[id] = { ...prev, notesBlock: e.block, notesFrac: e.frac ?? 0 };
        applied = true;
      }
    }
    notesPosRef.current = merged;
    try {
      localStorage.setItem(`gamma-notes-pos:${user}`, JSON.stringify(merged));
    } catch {}
    const newer = Object.entries(merged).filter(
      ([id, e]) => !s[id] || (e.at || "") > (s[id].at || ""),
    );
    if (!newer.length) notesPosSentRef.current = JSON.stringify({ value: merged });
    if (applied) setNotesPosTick((t) => t + 1);
    return newer.length > 0;
  }
  // Server writes are throttled hard: the first change arms one 15s timer
  // and every later change rides it, so steady reading costs at most four
  // PUTs a minute instead of one per page turn. This never risks the
  // position — localStorage gets the instant copy, and blur/pagehide flush
  // the armed timer, so the long window only delays what OTHER devices see
  // while this window still has focus.
  const READ_POS_PUSH_MS = 15000;
  function pushReadPosSoon(u) {
    if (readPosPushTimerRef.current) return; // armed — this change rides it
    dbg("read-pos push armed (15s)");
    readPosPushTimerRef.current = setTimeout(async () => {
      readPosPushTimerRef.current = null;
      if (prefsUserRef.current !== u) return;
      const body = JSON.stringify({ value: readPosRef.current });
      if (body === readPosSentRef.current) {
        dbg("read-pos push skipped (server current)");
        return;
      }
      try {
        await apiJson(`${API}/prefs/read-pos`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
        });
        readPosSentRef.current = body;
        dbg("read-pos pushed OK");
      } catch (err) {
        dbg("read-pos push FAILED:", err?.message || String(err));
      }
    }, READ_POS_PUSH_MS);
  }
  const NOTES_POS_PUSH_MS = 15000;
  function pushNotesPosSoon(u) {
    if (notesPosPushTimerRef.current) return; // armed — this change rides it
    notesPosPushTimerRef.current = setTimeout(async () => {
      notesPosPushTimerRef.current = null;
      if (prefsUserRef.current !== u) return;
      const body = JSON.stringify({ value: notesPosRef.current });
      if (body === notesPosSentRef.current) {
        dbg("notes-pos push skipped (server current)");
        return;
      }
      try {
        await apiJson(`${API}/prefs/notes-pos`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
        });
        notesPosSentRef.current = body;
        dbg("notes-pos pushed OK");
      } catch (err) {
        dbg("notes-pos push FAILED:", err?.message || String(err));
      }
    }, NOTES_POS_PUSH_MS);
  }
  function recordReadPos(blockId, page) {
    const u = prefsUserRef.current;
    if (!u || !blockId || !(page > 0)) return;
    const prev = readPosRef.current[blockId];
    if (prev?.page === page) return;
    // A new local action must supersede the entry it replaces even when that
    // entry came from a machine with a fast clock — bump 1ms past it.
    let at = new Date().toISOString();
    if (prev?.at && prev.at >= at) at = new Date(new Date(prev.at).getTime() + 1).toISOString();
    const next = { ...readPosRef.current, [blockId]: { page, at } };
    const ids = Object.keys(next);
    if (ids.length > 200) {
      ids.sort((a, b) => (next[a].at || "").localeCompare(next[b].at || ""));
      for (const id of ids.slice(0, ids.length - 200)) delete next[id];
    }
    readPosRef.current = next;
    try {
      localStorage.setItem(`gamma-read-pos:${u}`, JSON.stringify(next));
    } catch {}
    dbg("read-pos record", blockId, "→ page", page);
    pushReadPosSoon(u);
  }
  function recordNotesPos(blockId, block, frac) {
    const u = prefsUserRef.current;
    if (!u || !blockId || !block) return;
    const prev = notesPosRef.current[blockId];
    if (prev?.block === block && Math.abs((prev.frac ?? 0) - frac) < 0.01) return;
    let at = new Date().toISOString();
    if (prev?.at && prev.at >= at) at = new Date(new Date(prev.at).getTime() + 1).toISOString();
    const next = { ...notesPosRef.current, [blockId]: { block, frac, at } };
    const ids = Object.keys(next);
    if (ids.length > 200) {
      ids.sort((a, b) => (next[a].at || "").localeCompare(next[b].at || ""));
      for (const id of ids.slice(0, ids.length - 200)) delete next[id];
    }
    notesPosRef.current = next;
    try {
      localStorage.setItem(`gamma-notes-pos:${u}`, JSON.stringify(next));
    } catch {}
    dbg("notes-pos record", blockId, "→ block", block, "@", frac);
    pushNotesPosSoon(u);
  }
  // Scroll-end capture: the anchor is normally recorded on page switches /
  // unload, but a user who scrolls notes and just keeps the window open would
  // never trigger one — the other device then never sees the position. When
  // the notes list stops scrolling for a beat, record the anchor now (the
  // 15s push throttle still applies). Scroll doesn't bubble, so capture at
  // the document level with capture:true.
  useEffect(() => {
    const onScroll = (e) => {
      const el = e.target && e.target.closest ? e.target.closest(".blockList") : null;
      if (!el) return;
      clearTimeout(notesScrollTimerRef.current);
      notesScrollTimerRef.current = setTimeout(() => {
        notesScrollTimerRef.current = null;
        const id = focusedBlockIdRef.current;
        if (!id || !prefsUserRef.current) return;
        const nRect = el.getBoundingClientRect();
        const st = el.scrollTop;
        for (const row of el.querySelectorAll(".blockRowWrap")) {
          const r = row.getBoundingClientRect();
          const rowTop = r.top - nRect.top + st;
          if (rowTop + r.height > st) {
            recordNotesPos(
              id,
              row.getAttribute("data-block-id") || "",
              Math.max(0, Math.min(1, (st - rowTop) / Math.max(1, r.height))),
            );
            break;
          }
        }
      }, 600);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      clearTimeout(notesScrollTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only scroll capture; recordNotesPos is an unstable closure
  }, []);
  // Multi-browser convergence: whenever this window regains focus, pull the
  // latest stored tabs. Skipped while a local push is pending (ours is newer).
  useEffect(() => {
    async function pullTabs() {
      const u = prefsUserRef.current;
      if (!u || document.hidden || tabsPushTimerRef.current) return;
      try {
        const d = await apiJson(`${API}/prefs/open-tabs`);
        if (prefsUserRef.current !== u || !d.updated_at) return;
        if (d.updated_at !== tabsSyncRef.current) applyServerTabs(u, d.value, d.updated_at);
      } catch {}
    }
    async function pullReadPos() {
      const u = prefsUserRef.current;
      if (!u || document.hidden || readPosPushTimerRef.current) return;
      try {
        const d = await apiJson(`${API}/prefs/read-pos`);
        if (prefsUserRef.current !== u) return;
        readPosLoadedRef.current = true;
        if (mergeReadPos(u, d.value)) pushReadPosSoon(u);
      } catch {}
    }
    async function pullNotesPos() {
      const u = prefsUserRef.current;
      if (!u || document.hidden || notesPosPushTimerRef.current) return;
      try {
        const d = await apiJson(`${API}/prefs/notes-pos`);
        if (prefsUserRef.current !== u) return;
        notesPosLoadedRef.current = true;
        if (mergeNotesPos(u, d.value)) pushNotesPosSoon(u);
      } catch {}
    }
    async function pullAppearance() {
      const u = prefsUserRef.current;
      if (!u) return;
      try {
        const d = await apiJson(`${API}/prefs/appearance`);
        if (prefsUserRef.current !== u || !d.updated_at || !d.value || typeof d.value !== "object") return;
        const t = THEMES.includes(d.value.theme) ? d.value.theme : undefined;
        const pd = typeof d.value.pdfDark === "boolean" ? d.value.pdfDark : undefined;
        if (t === undefined || pd === undefined) return;
        appearanceLoadedRef.current = true;
        const snap = JSON.stringify({ theme: t, pdfDark: pd });
        if (appearanceSyncRef.current === snap) return;
        appearanceSyncRef.current = snap;
        setTheme(t);
        setPdfDarkPage(pd);
      } catch {}
    }
    async function pullRecents() {
      const u = prefsUserRef.current;
      if (!u || document.hidden || recentsPushTimerRef.current) return;
      try {
        const d = await apiJson(`${API}/prefs/recent-views`);
        if (prefsUserRef.current !== u || !d.updated_at) return;
        if (d.updated_at !== recentsSyncRef.current) applyServerRecents(u, d.value, d.updated_at);
      } catch {}
    }
    async function pullSnaps() {
      const u = prefsUserRef.current;
      if (!u || document.hidden || !snapsSyncedRef.current) return;
      const newest = Object.values(pageSnapsRef.current)
        .reduce((latest, entry) => ((entry?.at || "") > latest ? entry.at : latest), "");
      try {
        const data = await apiJson(`${API}/page-snaps?after=${encodeURIComponent(newest)}`);
        if (prefsUserRef.current !== u) return;
        if (data.snaps && Object.keys(data.snaps).length) mergePageSnaps(data.snaps);
      } catch {}
    }
    // Losing focus flushes the armed read-pos push right away, so the window
    // being switched TO (or a refresh moments later) pulls the fresh value —
    // the 15s throttle would otherwise delay a quick scroll-then-switch.
    // Deliberately not marked confirmed: keepalive can't report success, and
    // the pull-merge heal covers a flush the server never got.
    function flushReadPos() {
      if (!readPosPushTimerRef.current || !prefsUserRef.current) return;
      clearTimeout(readPosPushTimerRef.current);
      readPosPushTimerRef.current = null;
      const body = JSON.stringify({ value: readPosRef.current });
      if (body === readPosSentRef.current) {
        dbg("read-pos flush skipped (server current)");
        return;
      }
      dbg("read-pos flushed (blur/pagehide)");
      try {
        fetch(`${API}/prefs/read-pos`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
          credentials: "same-origin",
        }).catch(() => {});
      } catch {}
    }
    function flushNotesPos() {
      if (!notesPosPushTimerRef.current || !prefsUserRef.current) return;
      clearTimeout(notesPosPushTimerRef.current);
      notesPosPushTimerRef.current = null;
      const body = JSON.stringify({ value: notesPosRef.current });
      if (body === notesPosSentRef.current) return;
      try {
        fetch(`${API}/prefs/notes-pos`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
          credentials: "same-origin",
        }).catch(() => {});
      } catch {}
    }
    // Focus flaps (alt-tabbing through windows) must not hammer the server:
    // wake pulls run at most once per 15s. Cross-window handoff still
    // converges promptly — the leaving window's blur flush lands first, and
    // the arriving window usually last pulled more than 15s ago.
    let lastWakeAt = 0;
    const onWake = () => {
      if (Date.now() - lastWakeAt < 15000) return;
      lastWakeAt = Date.now();
      pullTabs();
      pullReadPos();
      pullNotesPos();
      pullRecents();
      pullSnaps();
      pullAppearance();
    };
    const onVisibility = () => {
      if (document.hidden) {
        flushReadPos();
        flushNotesPos();
      } else onWake();
    };
    window.addEventListener("focus", onWake);
    window.addEventListener("blur", flushReadPos);
    window.addEventListener("pagehide", flushReadPos);
    window.addEventListener("blur", flushNotesPos);
    window.addEventListener("pagehide", flushNotesPos);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onWake);
      window.removeEventListener("blur", flushReadPos);
      window.removeEventListener("pagehide", flushReadPos);
      window.removeEventListener("blur", flushNotesPos);
      window.removeEventListener("pagehide", flushNotesPos);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only listeners; the helpers are unstable closures
  }, []);
  // Recently-viewed pages — the library's top shortcut bar ([{id, at}], most
  // recent first, capped 24). Synced across devices like the tab strip:
  // whole-list last-write-wins on /api/prefs/recent-views (localStorage is
  // the instant-paint cache), so a × removal sticks everywhere instead of
  // being resurrected by a union merge. Also drives the "viewed" home sort,
  // which therefore ranks account-wide.
  const [recentViews, setRecentViews] = useState([]);
  const recentsSyncRef = useRef("");  // updated_at of the last server state we applied/wrote
  const recentsPushTimerRef = useRef(null);
  function pushRecentsToServer(list) {
    if (recentsPushTimerRef.current) clearTimeout(recentsPushTimerRef.current);
    recentsPushTimerRef.current = setTimeout(async () => {
      recentsPushTimerRef.current = null;
      if (!prefsUserRef.current) return;
      try {
        const d = await apiJson(`${API}/prefs/recent-views`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: list }),
        });
        recentsSyncRef.current = d.updated_at || "";
      } catch {}
    }, 600);
  }
  function applyServerRecents(user, value, updatedAt) {
    recentsSyncRef.current = updatedAt || "";
    if (recentsPushTimerRef.current) {
      clearTimeout(recentsPushTimerRef.current);
      recentsPushTimerRef.current = null;
    }
    let list = (Array.isArray(value) ? value : []).filter((r) => r && r.id).slice(0, 24);
    // The page open in THIS window stays the freshest entry even when the
    // stored queue predates it (just opened here, push not flushed yet) —
    // merged and pushed back, tabs-style.
    const fid = focusedBlockIdRef.current;
    if (fid && list[0]?.id !== fid) {
      list = [{ id: fid, at: new Date().toISOString() }, ...list.filter((r) => r.id !== fid)].slice(0, 24);
      pushRecentsToServer(list);
    }
    setRecentViews(list);
    try { localStorage.setItem(`gamma-recent-views:${user}`, JSON.stringify(list)); } catch {}
  }
  function pushRecentView(id) {
    if (!id) return;
    setRecentViews((prev) => {
      const next = [{ id, at: new Date().toISOString() }, ...prev.filter((r) => r.id !== id)].slice(
        0,
        24,
      );
      const u = prefsUserRef.current;
      if (u) { try { localStorage.setItem(`gamma-recent-views:${u}`, JSON.stringify(next)); } catch {} }
      pushRecentsToServer(next);
      return next;
    });
  }
  // The × on a recents card: drop the entry and its snapshot, on every device.
  function removeRecentView(id) {
    const u = prefsUserRef.current;
    setRecentViews((prev) => {
      const next = prev.filter((r) => r.id !== id);
      if (u) { try { localStorage.setItem(`gamma-recent-views:${u}`, JSON.stringify(next)); } catch {} }
      pushRecentsToServer(next);
      return next;
    });
    dropPageSnap(id);
  }
  // Page snapshots — a small JPEG of the viewer at the last-read spot,
  // captured from the already-rendered pdf.js canvases and shown as the
  // recents-card cover ({pageId: {img, at}}). Stored server-side per account
  // (/api/page-snaps, per-page newest-`at` wins) so covers follow the synced
  // recents strip across devices; localStorage is the instant-paint cache,
  // capped so its footprint stays bounded. All writes go through
  // setSnapsState so the ref, the state and the cache never diverge.
  const [pageSnaps, setPageSnaps] = useState({});
  const pageSnapsRef = useRef({});
  const snapsSyncedRef = useRef(false); // first server copy merged (gates the prune)
  const snapPendingRef = useRef({});    // {id: {img, at}} awaiting push
  const snapPushTimerRef = useRef(null);
  function setSnapsState(next) {
    pageSnapsRef.current = next;
    setPageSnaps(next);
    const u = prefsUserRef.current;
    if (u) { try { localStorage.setItem(`gamma-page-snaps:${u}`, JSON.stringify(next)); } catch {} }
  }
  // Scroll-settle captures can fire every second or two while reading; batch
  // the uploads so steady reading costs one small PUT burst per 5s, always
  // sending the newest capture per page.
  function pushSnapSoon(id, img, at) {
    snapPendingRef.current[id] = { img, at };
    if (snapPushTimerRef.current) return; // armed — this capture rides it
    snapPushTimerRef.current = setTimeout(() => {
      snapPushTimerRef.current = null;
      const pending = snapPendingRef.current;
      snapPendingRef.current = {};
      if (!prefsUserRef.current) return;
      for (const [pid, snap] of Object.entries(pending)) {
        apiJson(`${API}/page-snaps/${encodeURIComponent(pid)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snap),
        }).catch(() => {});
      }
    }, 5000);
  }
  function savePageSnap(id, img) {
    if (!id || !img) return;
    const at = new Date().toISOString();
    const next = { ...pageSnapsRef.current, [id]: { img, at } };
    const ids = Object.keys(next);
    if (ids.length > 24) {
      ids.sort((a, b) => (next[a].at || "").localeCompare(next[b].at || ""));
      for (const drop of ids.slice(0, ids.length - 24)) delete next[drop];
    }
    setSnapsState(next);
    pushSnapSoon(id, img, at);
  }
  function dropPageSnap(id) {
    if (pageSnapsRef.current[id]) {
      const next = { ...pageSnapsRef.current };
      delete next[id];
      setSnapsState(next);
    }
    delete snapPendingRef.current[id];
    apiJson(`${API}/page-snaps/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }
  // Merge a server copy in (per-page newest-`at` wins). With `heal` (the full
  // login pull only — delta pulls would re-push everything), local entries
  // the server lacks or holds older are uploaded: that retries dropped pushes
  // and doubles as the one-time migration of pre-sync localStorage snapshots.
  function mergePageSnaps(server, { heal = false } = {}) {
    const s = server && typeof server === "object" ? server : {};
    const merged = { ...pageSnapsRef.current };
    for (const [id, e] of Object.entries(s)) {
      if (!e?.img) continue;
      if (!merged[id] || (e.at || "") > (merged[id].at || "")) merged[id] = e;
    }
    if (heal) {
      for (const [id, e] of Object.entries(pageSnapsRef.current)) {
        if (e?.img && (!s[id] || (e.at || "") > (s[id].at || ""))) pushSnapSoon(id, e.img, e.at || "");
      }
    }
    setSnapsState(merged);
  }
  // A snapshot only exists to cover a recents card — when a page falls out of
  // the (capped) queue, its local copy goes too (the server prunes itself by
  // a count cap, so no DELETE here: another device's queue may still want
  // it). Gated until the login pull has applied the server queue + covers, so
  // a pre-sync local queue can't sweep covers synced from another device.
  useEffect(() => {
    if (!snapsSyncedRef.current) return;
    const keep = new Set(recentViews.map((r) => r.id));
    const stale = Object.keys(pageSnaps).filter((id) => !keep.has(id));
    if (!stale.length) return;
    const next = { ...pageSnapsRef.current };
    for (const id of stale) delete next[id];
    setSnapsState(next);
  }, [recentViews, pageSnaps]);
  const [tabMenu, setTabMenu] = useState(null); // {id, pinned, x, y} — tab right-click menu
  // FLIP animation: when tab order changes, slide each tab from its old
  // position to the new one (Chrome-style), instead of snapping.
  const tabElsRef = useRef(new Map());
  const tabLeftsRef = useRef(new Map());
  useLayoutEffect(() => {
    const prev = tabLeftsRef.current;
    const next = new Map();
    for (const [id, el] of tabElsRef.current) {
      if (!el) continue;
      const left = el.getBoundingClientRect().left;
      next.set(id, left);
      const old = prev.get(id);
      if (old != null && Math.abs(old - left) > 2) {
        el.style.transition = "none";
        el.style.transform = `translateX(${old - left}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 0.16s ease";
          el.style.transform = "";
        });
      }
    }
    tabLeftsRef.current = next;
  }, [openTabs]);

  // Background tasks: client-side transfers (downloads/uploads) plus
  // server-side work (library indexing), shown in one popover. The rows live
  // in useTransfers; the PDF-load handler that feeds them stays here (it is
  // tangled with the scroll-restore machinery below).
  const { transfers, setTransfers, indexTask, setIndexTask, indexTaskCleared, setIndexTaskCleared, transferByUrlRef, addTransfer, updateTransfer } =
    useTransfers();
  // Byte-level download state reported by the PDF viewer (skips local uploads).
  // One row per URL: a re-download (LRU eviction, retry) reactivates the
  // existing entry instead of stacking duplicates.
  function handlePdfLoadState(url, st) {
    // System log: lifecycle transitions only — byte/page progress would spam it.
    if (st.phase !== "progress" && st.phase !== "measuring") {
      const shortUrl = url.length > 100 ? url.slice(0, 100) + "…" : url;
      logSys(
        `pdf ${st.phase}${st.bytes ? ` (${fmtBytes(st.bytes)})` : ""}${st.detail ? ` — ${st.detail}` : ""}: ${shortUrl}`,
      );
    }
    // Feed the shared status pill — one channel for the whole load lifecycle,
    // so load progress and status messages can never stack.
    if (st.phase === "start") {
      // Escalates if the server keeps us waiting with no bytes.
      postPill(
        "pdf-load",
        { msg: "Requesting PDF…", spinner: true },
        {
          after: [
            6000,
            { msg: "Still waiting — the server may be fetching the PDF from its source…" },
          ],
        },
      );
    } else if (st.phase === "progress") {
      postPill("pdf-load", {
        msg: st.total
          ? `Downloading… ${fmtBytes(st.loaded)} of ${fmtBytes(st.total)} (${Math.min(99, Math.floor((st.loaded / st.total) * 100))}%)`
          : `Downloading… ${fmtBytes(st.loaded)}`,
        spinner: true,
      });
    } else if (st.phase === "done" || st.phase === "cached") {
      postPill("pdf-load", { msg: "Preparing document…", spinner: true });
    } else if (st.phase === "parsing") {
      postPill("pdf-load", { msg: "Preparing document — parsing…", spinner: true });
    } else if (st.phase === "measuring") {
      postPill("pdf-load", {
        msg: `Preparing document — measuring page ${st.done + 1} of ${st.total}…`,
        spinner: true,
      });
    } else if (st.phase === "error") {
      postPill("pdf-load", {
        msg: `PDF load failed — ${st.detail || "unknown error"}`,
        error: true,
        retry: true,
      });
    } else if (st.phase === "cancelled" || st.phase === "painted") {
      postPill("pdf-load", null);
    }
    if (st.phase === "rendered") {
      // Pages are in the DOM but the first canvas paint is still in flight —
      // keep the pill up until the viewer reports "painted". Safety-capped so
      // a paint that errors out can't leave the spinner stuck forever.
      postPill("pdf-load", { msg: "Rendering page…", spinner: true }, { after: [20000, null] });
      pdfRenderedUrlRef.current = url; // this document's pages are now in the DOM
      setPdfDocNonce((n) => n + 1); // lets a pinned search re-find its matches here
      // Called from the viewer's layout effect — before paint. Applying a
      // pending restore HERE means the document appears already scrolled to
      // its position: no flash of the top, no visible jump.
      const p = pendingRestoreRef.current;
      if (p && p.url === url && restoreTokenRef.current === p.token) {
        const scroller = viewerWrapRef.current?.querySelector(".pdfViewer");
        if (scroller) {
          const targetTop = Math.min(
            pdfRestoreTargetTop(p.entry, scroller),
            Math.max(0, scroller.scrollHeight - scroller.clientHeight),
          );
          scroller.scrollTo({ top: targetTop, behavior: "instant" });
          // Deliberately NOT final: fit-width and page-height refinement keep
          // moving the layout for a while after first paint. restorePdfScroll's
          // loop re-asserts the anchor once the layout settles and only then
          // clears the restoring state — capturing (or trusting) the scroll
          // position mid-settle is what corrupted saved entries when the user
          // flipped tabs quickly.
          dbg("exact restore: applied pre-paint, top", Math.round(targetTop));
        }
      }
      return;
    }
    // Only phases that own a transfer row from here on — the catch-all branch
    // below marks anything unrecognized as a failed download.
    if (!TRANSFER_PHASES.has(st.phase)) return;
    if (url.startsWith("/api/uploads/")) return;
    if (st.phase === "cached") {
      const id = transferByUrlRef.current[url];
      if (id) updateTransfer(id, { status: "done", info: "cached" });
      return;
    }
    if (st.phase === "start") {
      const prevId = transferByUrlRef.current[url];
      if (prevId) {
        updateTransfer(prevId, { status: "active", info: "downloading…" });
        return;
      }
      const name = (
        pdfTitle ||
        decodeURIComponent((url.split("source_url=")[1] || url).split("/").pop() || "PDF")
      ).slice(0, 60);
      transferByUrlRef.current[url] = addTransfer({ name, kind: "download", info: "downloading…" });
    } else if (st.phase === "progress") {
      const id = transferByUrlRef.current[url];
      if (id)
        updateTransfer(id, {
          status: "active",
          info: st.total
            ? `${fmtBytes(st.loaded)} / ${fmtBytes(st.total)}`
            : `${fmtBytes(st.loaded)}…`,
        });
    } else {
      const id = transferByUrlRef.current[url];
      if (!id) return;
      if (st.phase === "cancelled") {
        delete transferByUrlRef.current[url];
        setTransfers((prev) => prev.filter((t) => t.id !== id)); // aborted navigation — drop the entry
      } else {
        updateTransfer(
          id,
          st.phase === "done"
            ? { status: "done", info: fmtBytes(st.bytes) }
            : { status: "error", info: (st.detail || "failed").slice(0, 60) },
        );
      }
    }
  }
  const [dockPreview, setDockPreview] = useState(null); // {left, top, width, height} of the drop target while dragging a window
  const [collapsedWins, setCollapsedWins] = useState({}); // window id -> collapsed to header bar
  // One popover open at a time; any click outside a [data-popover] container closes it.
  useEffect(() => {
    if (!openPopover) return;
    function onDown(e) {
      if (!(e.target.closest && e.target.closest("[data-popover]"))) setOpenPopover(null);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [openPopover]);
  const [shareUrl, setShareUrl] = useState("");
  const [shareCopied, flashShareCopied, resetShareCopied] = useCopied();
  // Workspace search lives in search.jsx (SearchPanel); App only holds what
  // the PDF viewer needs from it: the match highlights and the search hook.
  const [findMarks, setFindMarks] = useState([]); // [{page, rect, active}] painted by PdfViewer
  const [pdfDocNonce, setPdfDocNonce] = useState(0); // bumped when a document finishes rendering
  const pdfSearchRef = useRef(null); // set by PdfViewer: async (RegExp) => [{page, snippet, rects, pageW, pageH}]
  const pdfCaptureRef = useRef(null); // set by PdfViewer: async (areaHighlight) => PNG data URL (re-crops the rect from the document)
  // Stable wrapper for the notes tree's area-snapshot cards (a fresh function
  // every render would re-fire each card's crop effect). Resolves null until
  // the viewer has a document.
  const capturePdfArea = useCallback(
    (b) =>
      pdfCaptureRef.current
        ? pdfCaptureRef.current({ position: b.position })
        : Promise.resolve(null),
    [],
  );

  // Poll server-side task progress: slow heartbeat while logged in (so the
  // button appears even if the work was kicked off elsewhere), fast while
  // the popover is open or indexing is known to run.
  useEffect(() => {
    if (!authUser?.user || readOnly) return;
    let cancelled = false;
    const refresh = () =>
      apiJson(`${API}/tasks`)
        .then((d) => {
          if (cancelled) return;
          setIndexTask(d.indexing || null);
          if (d.indexing?.active) setIndexTaskCleared(false);
        })
        .catch(() => {});
    refresh();
    const fast = openPopover === "downloads" || indexTask?.active;
    const t = setInterval(refresh, fast ? 2000 : 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [openPopover, authUser?.user, readOnly, indexTask?.active, setIndexTask, setIndexTaskCleared]);

  // Every folder path in use (from page tags + manually created empties),
  // plus all ancestor prefixes — "readout" exists once "readout/destructive"
  // does, so it can be browsed, targeted, and searched by prefix.
  const allFolderPaths = useMemo(() => {
    const set = new Set();
    const addWithPrefixes = (path) => {
      const segs = path.split("/");
      for (let i = 1; i <= segs.length; i++) set.add(segs.slice(0, i).join("/"));
    };
    for (const f of extraFolders) addWithPrefixes(f);
    for (const b of homeBlocks) {
      for (const t of (b.properties?.folder || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean))
        addWithPrefixes(t);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [homeBlocks, extraFolders]);
  useEffect(() => {
    function onKey(e) {
      // Ctrl+F (and Ctrl+Shift+F) open the built-in search instead of the
      // browser find — it covers notes, highlights, AND the PDF text.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        // Focus in the chat window → ChatDock's own listener opens find-in-chat
        if (document.activeElement?.closest?.(".chatPanel")) return;
        e.preventDefault();
        setOpenPopover((p) => (p === "search" && !e.shiftKey ? null : "search"));
      } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        goBackNavRef.current?.();
      } else if (e.key === "Escape") {
        setOpenPopover(null);
        setHomeMenu(null);
        setSelectedPages((prev) => (prev.size ? new Set() : prev));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [pdfHidden, setPdfHidden] = useState(false);
  const [pdfScale, setPdfScale] = useState("page-width");
  // All localStorage-backed settings live in one hook so keys, defaults and
  // codecs stay centralized in prefs.js.
  const {
    theme, setTheme, pdfDarkPage, setPdfDarkPage, recentThumbs, setRecentThumbs,
    fileLabels, setFileLabels,
    oaFallback, setOaFallback, metaAutoFetch, setMetaAutoFetch, pdfSaveLocal, setPdfSaveLocal,
    snapVertical, setSnapVertical, embAnnots, setEmbAnnots,
    translateEnabled, setTranslateEnabled,
    translateLang, setTranslateLang, translateModel, setTranslateModel,
    translateEffort, setTranslateEffort, translateParallel, setTranslateParallel,
    searchDetailsHome, setSearchDetailsHome, searchDetailsPaper, setSearchDetailsPaper,
    enterNewNote, setEnterNewNote, hlNoteBadges, setHlNoteBadges,
    statusBarVisible, setStatusBarVisible,
    chatEffort, setChatEffort, aiLoginCheck, setAiLoginCheck, metaModel, setMetaModel,
    dictationModel, setDictationModel, dictationLang, setDictationLang,
    chatSystem, setChatSystem, agentSystem, setAgentSystem,
    metaPrompt, setMetaPrompt, citePrompt, setCitePrompt,
    chatContextChars, setChatContextChars, metaContextChars, setMetaContextChars,
    multiContextChars, setMultiContextChars,
    toolRounds, setToolRounds, agentReadChars, setAgentReadChars, agentPerms, setAgentPerms,
    agentEnabled, setAgentEnabled, folderToolsDefault, setFolderToolsDefault,
    pdfToolsDefault, setPdfToolsDefault,
    chatImgAutoClear, setChatImgAutoClear,
  } = useAppPrefs();

  // Appearance changes push to the account (the value is tiny — no debounce).
  // The loaded gate keeps a session that hasn't pulled yet from overwriting
  // the server copy with its stale local cache.
  useEffect(() => {
    if (!prefsUserRef.current || readOnly || !appearanceLoadedRef.current) return;
    const payload = { theme, pdfDark: pdfDarkPage };
    const snap = JSON.stringify(payload);
    if (appearanceSyncRef.current === snap) return;
    appearanceSyncRef.current = snap;
    apiJson(`${API}/prefs/appearance`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: payload }),
    }).catch(() => {});
  }, [theme, pdfDarkPage, authUser?.user, readOnly]);
  const pageTitleSaveTimerRef = useRef(null);
  const viewerWrapRef = useRef(null);
  const pdfRetryRef = useRef(null); // set by PdfViewer: re-runs a failed load (pill's Retry button)
  const appRef = useRef(null);

  // --- AI chat: model switcher, PDF attachment, selection focus, report ---
  const [aiInfo, setAiInfo] = useState(null); // {enabled, provider, models, default}
  const [chatModel, setChatModel] = useState(() => {
    try {
      return localStorage.getItem("gamma-chat-model") || "";
    } catch {
      return "";
    }
  });
  const [agentPromptDraft, setAgentPromptDraft] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  // AI providers (Settings → AI providers): a user-managed list of API keys,
  // OpenAI-platform style. Keys are stored server-side per user; the server
  // only ever returns a masked hint, so key fields here start empty and an
  // empty key on edit means "keep the stored one".
  const [aiKeysInfo, setAiKeysInfo] = useState(null); // masked GET /ai/settings: {providers: [], protocols: []}
  const [aiKeysForm, setAiKeysForm] = useState(null); // null | {id: ""=add, protocol, name, api_key, base_url, models}
  const [aiKeysBusy, setAiKeysBusy] = useState(false);
  const [aiKeysError, setAiKeysError] = useState("");
  // Per-entry results of the list's Test button (a tiny live completion):
  // id -> {busy} | {ok, model, latency_ms} | {ok: false, error}
  const [aiKeyTests, setAiKeyTests] = useState({});
  // id -> {busy} | normalized subscription allowance. API-key providers
  // return an explicit unavailable reason because their billing APIs differ.
  const [aiKeyUsage, setAiKeyUsage] = useState({});
  // Login connection check (POST /ai/health, Settings → Provider and models):
  // null = nothing to report; a failed result renders the chat panel's
  // warning strip ("sign-in expired — reconnect") until fixed or dismissed.
  const [aiHealth, setAiHealth] = useState(null);

  const [importOpen, setImportOpen] = useState(false);
  // Export dialog: one "Export…" menu entry, the shape of the export chosen
  // here. Remembered across sessions — most people export the same way twice.
  const [exportOpen, setExportOpen] = useState(false);
  // null exports the focused page; a folder path exports that whole subtree.
  const [exportFolder, setExportFolder] = useState(null);
  const [exportOpts, setExportOpts] = usePersistedState(
    "gamma-export-opts",
    { format: "pdf", highlights: true, notes: true, bundle: true },
    {
      parse: (raw) => ({ format: "pdf", highlights: true, notes: true, bundle: true, ...JSON.parse(raw) }),
      serialize: JSON.stringify,
    },
  );
  // Which provider entry (API key) AI requests use. Only the key is chosen
  // here — the model itself is picked in the chat panel, scoped to this key.
  const [aiProvider, setAiProvider] = usePersistedState("gamma-ai-provider", "");
  // The pick follows the account (/api/prefs/ai-provider): the server copy
  // wins on login, so it survives restarts and other browsers/origins;
  // localStorage is just the instant-paint cache. Without this, each origin
  // (localhost / LAN / Tailscale) silently reverted to the first key.
  const aiProviderSyncRef = useRef(null); // last server-synced value; null = not loaded yet
  useEffect(() => {
    aiProviderSyncRef.current = null;
    const u = authUser?.user;
    if (!u || readOnly) return;
    const local = aiProvider;
    apiJson(`${API}/prefs/ai-provider`)
      .then((d) => {
        if (prefsUserRef.current !== u) return;
        if (d.updated_at) {
          const server = typeof d.value === "string" ? d.value : "";
          aiProviderSyncRef.current = server;
          setAiProvider(server);
        } else if (local) {
          // Account has never synced: seed the server with this browser's pick.
          aiProviderSyncRef.current = local;
          apiJson(`${API}/prefs/ai-provider`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: local }),
          }).catch(() => {});
        } else {
          aiProviderSyncRef.current = "";
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync on user change only; adding aiProvider would re-trigger the load loop
  }, [authUser?.user, readOnly]);
  useEffect(() => {
    if (aiProviderSyncRef.current === null || aiProviderSyncRef.current === aiProvider || readOnly)
      return;
    aiProviderSyncRef.current = aiProvider;
    apiJson(`${API}/prefs/ai-provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: aiProvider }),
    }).catch(() => {});
  }, [aiProvider, readOnly]);
  // Last model picked per key, so switching keys and back restores the pick
  // (a workspace-wide memory — the chat model is never per-PDF).
  const chatModelMemRef = useRef(null);
  if (chatModelMemRef.current === null) {
    try {
      chatModelMemRef.current =
        JSON.parse(localStorage.getItem("gamma-chat-model-by-key") || "{}") || {};
    } catch {
      chatModelMemRef.current = {};
    }
  }
  // Keep the selected model inside the active key's model list: switching to
  // a key restores its remembered model, or falls back to its first one.
  useEffect(() => {
    const all = aiInfo?.models || [];
    if (!all.length) return;
    const scoped =
      aiProvider && all.some((m) => m.provider === aiProvider)
        ? all.filter((m) => m.provider === aiProvider)
        : all;
    if (!scoped.some((m) => m.id === chatModel)) {
      const remembered = chatModelMemRef.current[scoped[0].provider];
      setChatModel(scoped.some((m) => m.id === remembered) ? remembered : scoped[0].id);
    }
  }, [aiProvider, aiInfo, chatModel]);
  // Models the active key (Settings → AI & API keys) offers — all models only
  // when no key is selected or the selected one is gone. Model registry ids
  // are "<entryId>:<model>", so the id ROUTES the request to a key server-side;
  // every model this client sends must come from this list or an unselected
  // key would serve the call.
  const scopedAiModels =
    aiProvider && (aiInfo?.models || []).some((m) => m.provider === aiProvider)
      ? aiInfo.models.filter((m) => m.provider === aiProvider)
      : aiInfo?.models || [];
  // The model AI calls (chat, citations, titles) actually send: chatModel
  // snapped into scope at render time — the effect above fixes the state, but
  // a request fired in the same render (or before /ai/models loads after a
  // key switch elsewhere) must not trust it. Empty list = registry not loaded
  // yet; nothing to validate against, so the stored pick passes through.
  const chatSendModel =
    scopedAiModels.length && !scopedAiModels.some((m) => m.id === chatModel)
      ? scopedAiModels[0].id
      : chatModel;

  async function loadAiKeys() {
    setAiKeysError("");
    setAiKeysInfo(null);
    setAiKeysForm(null);
    setAiKeyTests({});
    setAiKeyUsage({});
    try {
      const info = await apiJson(`${API}/ai/settings`);
      setAiKeysInfo(info);
      // Usage is account status, not an edit action: fetch it as soon as the
      // pane opens. Only OAuth protocols have a portable percentage endpoint;
      // generic API-key providers would merely return "unavailable".
      const oauthProtocols = new Set((info.protocols || [])
        .filter((protocol) => protocol.auth === "oauth")
        .map((protocol) => protocol.id));
      (info.providers || [])
        .filter((provider) => oauthProtocols.has(provider.protocol))
        .forEach((provider) => queryAiProviderUsage(provider));
    } catch (err) {
      setAiKeysError(err.message);
    }
  }

  // Probe one entry with a tiny real completion — the honest answer to "will
  // my chats work", surfacing an expired ChatGPT sign-in as a readable error
  // here instead of a 502 mid-conversation.
  async function testAiProvider(p) {
    setAiKeyTests((t) => ({ ...t, [p.id]: { busy: true } }));
    let result;
    try {
      result = await apiJson(`${API}/ai/providers/${p.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: probeModelFor(p.id) }),
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    setAiKeyTests((t) => ({ ...t, [p.id]: result }));
    // A passing test clears this provider's login-check warning strip.
    if (result.ok) setAiHealth((h) => (h?.provider_id === p.id ? null : h));
  }
  // Remaining subscription allowance. Best-effort: the provider API is
  // undocumented, so a failure renders as a reason next to the entry rather
  // than an error state for the pane.
  async function queryAiProviderUsage(p) {
    setAiKeyUsage((u) => ({ ...u, [p.id]: { busy: true } }));
    let result;
    try {
      result = await apiJson(`${API}/ai/providers/${p.id}/usage`, { method: "POST" });
    } catch (err) {
      result = { available: false, reason: err.message };
    }
    setAiKeyUsage((u) => ({ ...u, [p.id]: result }));
  }
  // Connection check of the active provider (Settings → Provider and models →
  // "Check connection at login"): a broken credential surfaces as the chat
  // panel's warning strip at login instead of as a failed chat later. The
  // default "ping" mode spends no tokens; network failures reaching our own
  // server stay silent — every other request would be failing too.
  const aiHealthArgsRef = useRef({});
  aiHealthArgsRef.current = { mode: aiLoginCheck, provider: aiProvider };
  async function checkAiHealth() {
    const { mode, provider } = aiHealthArgsRef.current;
    if (mode === "off") {
      setAiHealth(null);
      return;
    }
    try {
      const r = await apiJson(`${API}/ai/health`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider_id: provider || "", mode, model: probeModelFor(provider) }),
      });
      setAiHealth(r.configured && !r.ok ? r : null);
    } catch {}
  }
  useEffect(() => {
    if (!authUser?.user || authUser.is_guest || readOnly) return;
    // Delayed so the server-synced active-provider pick can land first.
    const timer = setTimeout(checkAiHealth, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- login-time check; mode/provider are read from the ref
  }, [authUser?.user, readOnly]);
  // Entering the AI pane always refetches the masked key list.
  useEffect(() => {
    if (settingsOpen === "ai" && authUser?.user && !readOnly) loadAiKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated on pane open; user/readOnly are read as guards
  }, [settingsOpen]);

  function openAiKeysEditor() {
    setSettingsOpen("ai");
    setOpenPopover(null);
  }

  const aiProtocolOf = (id) => aiKeysInfo?.protocols?.find((p) => p.id === id);
  // Sign-in protocols (ChatGPT OAuth) have no key/base-URL fields — the
  // backend marks them with auth: "oauth" in the protocols payload.
  const isOauthProto = (id) => aiProtocolOf(id)?.auth === "oauth";
  // The model switchers everywhere feed off /ai/models — refresh after edits.
  const refreshAiModels = () =>
    apiJson(`${API}/ai/models`)
      .then(setAiInfo)
      .catch(() => {});

  function startAddAiProvider() {
    setAiKeysError("");
    setAiKeysForm({
      id: "",
      protocol: aiKeysInfo?.protocols?.[0]?.id || "anthropic",
      name: "",
      api_key: "",
      base_url: "",
      models: "",
      test_model: "",
    });
  }

  function startEditAiProvider(p) {
    setAiKeysError("");
    setAiKeysForm({
      id: p.id,
      protocol: p.protocol,
      name: p.name || "",
      api_key: "",
      base_url: p.base_url || "",
      models: p.models || "",
      test_model: p.test_model || "",
    });
  }

  // Model picker for the form: API protocols are listed live from the
  // provider's /v1/models (typed key, or the stored one when editing);
  // ChatGPT (OAuth) is listed live from the codex backend via the entry's
  // sign-in token (known-good fallback list before connecting).
  const [aiModelCatalog, setAiModelCatalog] = useState(null); // null | {loading} | {models} | {error}
  async function loadModelCatalog() {
    const f = aiKeysForm;
    if (!f) return;
    setAiModelCatalog({ loading: true });
    try {
      const d = await apiJson(`${API}/ai/model-catalog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_id: f.id || "",
          protocol: f.protocol,
          api_key: f.api_key.trim(),
          base_url: f.base_url.trim(),
        }),
      });
      setAiModelCatalog({ models: d.models || [] });
    } catch (err) {
      setAiModelCatalog({ error: friendlyApiError(err) });
    }
  }
  function addCatalogModel(m) {
    if (!m) return;
    setAiKeysForm((f) => {
      if (!f) return f;
      const cur = parseFolderTags(f.models);
      return cur.includes(m) ? f : { ...f, models: [...cur, m].join(", ") };
    });
  }
  function removeModel(m) {
    setAiKeysForm((f) =>
      f
        ? {
            ...f,
            models: parseFolderTags(f.models)
              .filter((x) => x !== m)
              .join(", "),
          }
        : f,
    );
  }
  const [customModel, setCustomModel] = useState(""); // free-form entry next to the picker
  const formModels = parseFolderTags(aiKeysForm?.models);
  const availModels = (aiModelCatalog?.models || []).filter((m) => !formModels.includes(m));
  // A ChatGPT entry that isn't signed in yet can't list models — its list
  // comes from the connected account, so the fetch waits for Connect.
  const formStoredEntry = aiKeysForm?.id
    ? aiKeysInfo?.providers?.find((p) => p.id === aiKeysForm.id)
    : null;
  const formOauthPending =
    !!aiKeysForm && isOauthProto(aiKeysForm.protocol) && !formStoredEntry?.oauth_connected;

  // Reset the picker whenever the form target changes, then load the catalog
  // as soon as it's possible without extra typing: entries with a stored
  // credential (API key or completed sign-in). A freshly typed key triggers
  // the load on blur instead; a fresh OAuth entry after Connect.
  useEffect(() => {
    setAiModelCatalog(null);
    setCustomModel("");
    const f = aiKeysForm;
    if (!f) return;
    const stored = f.id ? aiKeysInfo?.providers?.find((p) => p.id === f.id) : null;
    if (stored?.oauth_connected || stored?.key_hint) loadModelCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated on form id/protocol; the rest are read as guards
  }, [aiKeysForm?.id, aiKeysForm?.protocol]);

  // "Sign in with ChatGPT": opens the OAuth page in a centered popup, tracks
  // when the popup closes, and — when the user has copied the failed-callback
  // URL from the address bar — tries to auto-paste it via the Clipboard API
  // and finish the exchange without any manual input.
  // "Sign in with ChatGPT": popup opens auth.openai.com. The user signs in,
  // OpenAI redirects to localhost:1455/auth/callback (nothing listens there —
  // the URL just fails to load). We watch popup.closed; when it closes we try
  // to read the callback URL from the clipboard and auto-submit. If clipboard
  // access is blocked, the paste input is focused so Cmd+V finishes the job.
  // (Cross-origin blocks popup.location for the whole flow, so no polling of
  // the popup's URL — clipboard is the only handle we have.)
  const oauthWatchRef = useRef(null);
  async function startChatGPTAuth() {
    setAiKeysError("");
    try {
      const d = await apiJson(`${API}/ai/oauth/chatgpt/start`, { method: "POST" });
      setAiKeysForm((f) => (f ? { ...f, oauthState: d.state, oauthWaiting: true } : f));
      const w = 520,
        h = 720;
      const y = Math.max(0, (window.screen?.height || 800) - h) / 2;
      const x = Math.max(0, (window.screen?.width || 1200) - w) / 2;
      const popup = window.open(
        d.auth_url,
        "chatgpt-oauth",
        `width=${w},height=${h},left=${x},top=${y}`,
      );
      if (oauthWatchRef.current) clearInterval(oauthWatchRef.current);
      oauthWatchRef.current = setInterval(async () => {
        if (!popup || popup.closed) {
          clearInterval(oauthWatchRef.current);
          oauthWatchRef.current = null;
          setAiKeysForm((f) => (f ? { ...f, oauthWaiting: false } : f));
          try {
            const m = ((await navigator.clipboard.readText()) || "")
              .trim()
              .match(/https?:\/\/localhost:1455\/auth\/callback[^\s]*/);
            if (m) {
              setAiKeysForm((f) => (f ? { ...f, oauthCallback: m[0] } : f));
              setTimeout(() => submitAiProvider(), 0);
              return;
            }
          } catch {}
          setTimeout(() => document.getElementById("chatgpt-oauth-cb-input")?.focus(), 50);
        }
      }, 500);
    } catch (err) {
      setAiKeysError(err.message);
    }
  }
  useEffect(
    () => () => {
      if (oauthWatchRef.current) clearInterval(oauthWatchRef.current);
    },
    [],
  );

  async function submitAiProvider() {
    const f = aiKeysForm;
    if (!f) return;
    const oauth = isOauthProto(f.protocol);
    const oauthCb = oauth ? (f.oauthCallback || "").trim() : "";
    if (oauth && !oauthCb && !f.id) {
      setAiKeysError("Sign in with ChatGPT and paste the callback URL to connect.");
      return;
    }
    if (oauthCb && !f.oauthState) {
      setAiKeysError('Hit "Open ChatGPT sign-in" first, then paste the URL it ends on.');
      return;
    }
    if (!oauth && !f.id && !f.api_key.trim()) {
      setAiKeysError("An API key is required.");
      return;
    }
    // Complete the OAuth exchange when a callback was pasted; otherwise a
    // plain field edit (name/models — plus key/base URL for key entries).
    const req = oauthCb
      ? {
          url: `${API}/ai/oauth/chatgpt/complete`,
          method: "POST",
          body: {
            state: f.oauthState,
            callback: oauthCb,
            provider_id: f.id || "",
            name: f.name.trim(),
            models: f.models.trim(),
          },
        }
      : {
          url: `${API}/ai/providers${f.id ? `/${f.id}` : ""}`,
          method: f.id ? "PUT" : "POST",
          body: {
            protocol: f.protocol,
            name: f.name.trim(),
            base_url: f.base_url.trim(),
            models: f.models.trim(),
            test_model: (f.test_model || "").trim(),
            ...(f.api_key.trim() ? { api_key: f.api_key.trim() } : {}),
          },
        };
    await runAiKeysRequest(
      () =>
        apiJson(req.url, {
          method: req.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
        }),
      true,
    );
  }

  function deleteAiProvider(p) {
    const label = p.name || aiProtocolOf(p.protocol)?.label || p.protocol;
    setConfirmBox({
      title: "Remove AI key",
      message: `Remove the "${label}" key? AI requests through it will stop working. This cannot be undone.`,
      confirmLabel: "Remove",
      danger: true,
      onConfirm: async () => {
        // Close a form that edits this entry — saving it would 404 ("provider
        // not found") — and forget it as the active key.
        await runAiKeysRequest(
          () => apiJson(`${API}/ai/providers/${p.id}`, { method: "DELETE" }),
          aiKeysForm?.id === p.id,
        );
        if (aiProvider === p.id) setAiProvider("");
      },
    });
  }

  // Shared busy/error/refresh protocol for provider-list mutations.
  async function runAiKeysRequest(call, closeForm = false) {
    setAiKeysBusy(true);
    setAiKeysError("");
    try {
      setAiKeysInfo(await call());
      if (closeForm) setAiKeysForm(null);
      refreshAiModels();
      // A provider edit may have fixed (or removed) the credential behind the
      // chat panel's warning strip — re-run the check while one is showing.
      if (aiHealth) checkAiHealth();
    } catch (err) {
      setAiKeysError(err.message);
    } finally {
      setAiKeysBusy(false);
    }
  }

  // User management moved into Settings → Users (settings.jsx UsersSettings,
  // admins only) — App just opens that pane and lends it the shared pieces
  // (confirm dialog, status pill, session re-key after a self-rename).
  // PDF passages the next chat question focuses on. Ctrl (additive) appends
  // — whether from text selection or highlight clicks; plain replaces.
  const [pdfSelections, setPdfSelections] = useState([]);
  function addPdfSelection(text, additive) {
    const part = (text || "").trim().slice(0, 4000);
    if (!part) return;
    setPdfSelections((prev) =>
      additive ? (prev.includes(part) || prev.length >= 6 ? prev : [...prev, part]) : [part],
    );
  }
  // Figures pending send in the chat (data URLs) — pasted into the chat input
  // or captured by a Ctrl+drag area selection on the PDF. Lives here (not in
  // ChatDock) so the viewer can attach even while the chat window is closed.
  const [chatImages, setChatImages] = useState([]);
  // Data URLs that came from the PDF (area drags / rect-highlight clicks), as
  // opposed to images pasted into the chat input. The auto-clear preference
  // below only ever drops these — a pasted figure must survive PDF clicks.
  const pdfImagesRef = useRef(new Set());
  function addChatImage(dataUrl) {
    const seen = pdfImagesRef.current;
    seen.add(dataUrl);
    while (seen.size > 16) seen.delete(seen.values().next().value);
    setChatImages((prev) =>
      prev.length >= 4 || prev.includes(dataUrl) ? prev : [...prev, dataUrl],
    );
  }
  // Ref-mirror the snapshot auto-clear preference for the mouseup listener.
  const chatImgAutoClearRef = useRef(chatImgAutoClear);
  useEffect(() => {
    chatImgAutoClearRef.current = chatImgAutoClear;
  }, [chatImgAutoClear]);
  // Clicking a highlight — on the PDF or its card in the notes — feeds the
  // chat: text highlights set their quote as the selection, area rectangles
  // re-crop their region into an image attachment (the snapshot is never
  // stored; the viewer renders it fresh from the document each time).
  function addHighlightToChat(h, additive) {
    if (!h) return;
    if (h.position?.area) {
      pdfCaptureRef.current?.(h).then((img) => {
        if (img) addChatImage(img);
      });
    } else {
      addPdfSelection(h.content?.text, additive);
    }
  }
  // Styled in-app dialogs replacing window.confirm / link decisions.
  const [confirmBox, setConfirmBox] = useState(null); // {title, message, confirmLabel, danger, onConfirm, altLabel, altDanger, onAlt}
  const [linkPrompt, setLinkPrompt] = useState(null); // external URL clicked inside the PDF
  const [linkDialog, setLinkDialog] = useState(null); // {position, content} — creating a manual reference link
  const [linkDialogInput, setLinkDialogInput] = useState("");
  // A highlight copied via "Copy as reference point" — link dialogs in other
  // papers offer it as a target, so links can point at an exact passage.
  const [refPoint, setRefPoint] = useState(null); // {pageId, pageTitle, highlightId, quote}

  // --- Paper metadata (arXiv / DOI / AI) and citation export -----------------
  const [pageMeta, setPageMeta] = useState(null); // properties.meta of the open page
  const [pageBibtex, setPageBibtex] = useState("");
  const [metaBusy, setMetaBusy] = useState(false);
  const [pptCite, setPptCite] = useState("");
  const [pptCiteBusy, setPptCiteBusy] = useState(false);
  const [metaPopPos, setMetaPopPos] = useState({ top: 0, right: 0 }); // fixed-position anchor for the metadata popover
  const [copiedKey, flashCopied, resetCopied] = useCopied(); // "bibtex" | "ppt" | "source"
  // Editable copy of the metadata fields shown in the popover. Kept as flat
  // strings (authors comma-joined); rebuilt whenever the popover opens or a
  // fetch lands, so a refresh replaces any half-typed edits with the result.
  const [metaDraft, setMetaDraft] = useState(null);
  useEffect(() => {
    if (openPopover === "meta") setMetaDraft(metadataToDraft(pageMeta));
  }, [openPopover, pageMeta]);
  // Unsaved edits in the popover — gates the Save button and Enter-to-save.
  const metaDirty =
    metaDraft && JSON.stringify(metaDraft) !== JSON.stringify(metadataToDraft(pageMeta));

  // PDF-text health shown in the metadata popover: a scanned/image-only PDF is
  // why metadata lookups fail and AI chat answers blind — surface it. One
  // fetch serves both the popover-open effect and the ↻ recheck button.
  const [pdfTextInfo, setPdfTextInfo] = useState(null); // null | {checking} | {error} | {found, ok, chars}
  async function checkPdfText(retryMeta = false) {
    setPdfTextInfo({ checking: true });
    try {
      const d = await apiJson(`${API}/pdf-text-status?doc_id=${encodeURIComponent(docId)}`);
      setPdfTextInfo(d);
      // Text became available (e.g. the source file was replaced) and there's
      // still no metadata — retry the lookup right away.
      if (retryMeta && d.ok && !pageMeta && focusedBlock) fetchMetadata(focusedBlock, true);
    } catch (err) {
      setPdfTextInfo({ error: friendlyApiError(err) });
      if (retryMeta) setStatus(`Text check failed: ${err.message}`);
    }
  }
  useEffect(() => {
    if (openPopover !== "meta" || !docId || readOnly) {
      setPdfTextInfo(null);
      return;
    }
    checkPdfText();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated on popover/docId; readOnly/checkPdfText are read as guards
  }, [openPopover, docId]);

  // Modal preview of what the AI actually gets to read.
  const [pdfTextPreview, setPdfTextPreview] = useState(null); // null | {loading} | {text}
  async function openPdfTextPreview() {
    if (!docId) return;
    setPdfTextPreview({ loading: true });
    try {
      const d = await apiJson(
        `${API}/pdf-text-status?doc_id=${encodeURIComponent(docId)}&preview=12000`,
      );
      setPdfTextPreview({ text: d.text || "(no text)" });
    } catch (err) {
      setPdfTextPreview({ text: `Preview failed: ${friendlyApiError(err)}` });
    }
  }

  async function saveMetaEdits() {
    const blockId = focusedBlockIdRef.current;
    if (!blockId || !metaDraft) return;
    try {
      const data = await apiJson(`${API}/metadata/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block_id: blockId, meta: metaDraft }),
      });
      if (focusedBlockIdRef.current !== blockId) return;
      setPageMeta(data.meta || null);
      setPageBibtex(data.bibtex || "");
      setPptCite(""); // edited metadata invalidates the cached slide citation
      setFocusedBlock((prev) =>
        prev && prev.id === blockId
          ? {
              ...prev,
              properties: {
                ...prev.properties,
                meta: data.meta,
                bibtex: data.bibtex,
                ppt_cite: "",
                meta_error: undefined,
              },
            }
          : prev,
      );
      // Rename only while the title is still the automatic one — the same
      // compare-and-swap the server applies (auto_title marker, with the
      // legacy prefix kept eligible for pages created before it existed).
      if (data.meta?.title && (focusedBlock?.properties?.auto_title === focusedBlock?.content
          || /^PDF Notes - /.test(focusedBlock?.content || ""))) {
        await renameTitle(data.meta.title);
      }
      fetchHomeBlocks(); // keep the library's meta fresh for DOI-link matching
      setStatus("Metadata saved.");
    } catch (err) {
      setStatus(`Metadata save failed: ${err.message}`);
    }
  }
  // Draft copies of editable prompts; saved values live in useAppPrefs().
  const [metaPromptDraft, setMetaPromptDraft] = useState("");
  const [citePromptDraft, setCitePromptDraft] = useState("");

  const focusedBlockIdRef = useRef("");
  useEffect(() => {
    focusedBlockIdRef.current = focusedBlockId || "";
  }, [focusedBlockId]);
  const attemptedMetaRef = useRef(new Set()); // pages we already tried this session

  // Model actually sent with metadata lookups (per-paper fetch AND the
  // Settings batch retry): the dedicated pick while it's inside the active
  // key's scope, else the (already-scoped) chat model.
  const metaFetchModel =
    metaModel && scopedAiModels.some((m) => m.id === metaModel) ? metaModel : chatSendModel;

  // Model name the credential probes (Test button / login check "test" mode)
  // prefer: the effective metadata model when it belongs to the probed entry —
  // metadata fetches already trust it as the cheap utility model. The entry's
  // own "Test model" setting still wins server-side; registry ids are
  // "<entryId>:<model>", so a model from another entry is not sent.
  const probeModelFor = (providerId) => {
    const rid = metaModel || chatSendModel || "";
    return providerId && rid.startsWith(`${providerId}:`) ? rid.slice(providerId.length + 1) : "";
  };

  // --- PDF translation (the languages button in the viewer's zoom column) ---
  // The button prompts "this page or whole document"; the queue itself lives
  // in PdfViewer (translateCtl), which calls back into translateChunk below
  // for each chunk. Language, model, effort and parallelism live in
  // Settings → Reading → PDF viewer. Read-only/share views never mount any of
  // it (see the button's `!readOnly` gate and onTranslate below).
  const translateSendModel = translateModel && scopedAiModels.some((m) => m.id === translateModel)
    ? translateModel
    : chatSendModel;
  const translateLangLabel = (TRANSLATE_LANGS.find(([code]) => code === translateLang) || ["", ""])[1];
  const pdfTranslateCtl = useRef(null); // imperative surface set by PdfViewer
  const [pdfTransState, setPdfTransState] = useState({ running: false, progress: 0, shown: true, pages: 0 });
  const [transMenu, setTransMenu] = useState(null); // {x, y} while the button's option menu is open
  const transTaskRef = useRef(null); // background-tasks row for the running job
  const transLongRef = useRef(0); // long-press timer (touch): opens the menu like right-click does
  const transLongFiredRef = useRef(false); // swallow the click that follows a fired long-press
  function openTransMenu(el) {
    const r = el.getBoundingClientRect();
    setTransMenu({ x: r.right + 8, y: r.top - 4 });
  }
  function handleTranslateState(st) {
    setPdfTransState(st);
    if (st.running && !transTaskRef.current) {
      transTaskRef.current = addTransfer({ name: `Translate ${st.label} → ${translateLangLabel}`, kind: "ai", info: "0%" });
    }
    if (transTaskRef.current) {
      if (st.running) {
        updateTransfer(transTaskRef.current, { info: `${Math.round(st.progress * 100)}%` });
      } else {
        const full = st.progress >= 0.999;
        updateTransfer(transTaskRef.current, { status: "done", info: full ? "100%" : `stopped at ${Math.round(st.progress * 100)}%` });
        transTaskRef.current = null;
      }
    }
  }
  // One chunk of paragraphs → translations, a single provider call. All the
  // chunking, queueing and parallelism live in the viewer's engine; this is
  // just the HTTP wrapper carrying the language/model/effort settings.
  // Returns null on failure (already surfaced on the status pill) — the
  // engine retries a chunk once before failing the job. `signal` is the job's
  // AbortController: halting cancels the requests still in flight.
  async function translateChunk(texts, signal) {
    try {
      const data = await apiJson(`${API}/ai/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          texts, lang: translateLang,
          model: translateSendModel || "", effort: translateEffort || "",
        }),
      });
      return data.translations || null;
    } catch (err) {
      // An aborted request is the user pressing stop, not a failure.
      if (err.name !== "AbortError") setStatus(`Translation failed: ${err.message}`);
      return null;
    }
  }

  // POST /metadata/fetch for one page, tracked as a transfer-panel task.
  // Shared by the open-page fetch and the bulk-upload follow-up; throws on
  // failure (with the task already marked).
  async function fetchMetadataRequest(block, force = false) {
    const taskId = addTransfer({ name: `Metadata — ${(block.content || "paper").slice(0, 48)}`, kind: "ai", info: "fetching…" });
    try {
      const data = await apiJson(`${API}/metadata/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          block_id: block.id,
          prompt: metaPrompt || "",
          model: metaFetchModel || "",
          force: !!force,
          context_char_limit: metaContextChars,
        }),
      });
      updateTransfer(taskId, { status: "done", info: data.cached ? "cached" : data.source === "ai" ? "AI-extracted" : data.source || "" });
      return data;
    } catch (err) {
      updateTransfer(taskId, { status: "error", info: (err.message || "failed").slice(0, 60) });
      throw err;
    }
  }

  async function fetchMetadata(block, force) {
    if (!block?.id) return;
    setMetaBusy(true);
    if (force) setStatus("Refreshing paper metadata…");
    try {
      const data = await fetchMetadataRequest(block, force);
      if (focusedBlockIdRef.current !== block.id) return;
      setPageMeta(data.meta || null);
      setPageBibtex(data.bibtex || "");
      setPptCite(""); // fresh metadata invalidates the cached slide citation
      setFocusedBlock((prev) =>
        prev && prev.id === block.id
          ? {
              ...prev,
              ...(data.page_title ? { content: data.page_title } : {}),
              properties: {
                ...prev.properties,
                meta: data.meta,
                bibtex: data.bibtex,
                meta_error: undefined,
                ...(data.title_updated ? { auto_title: undefined } : {}),
              },
            }
          : prev,
      );
      // The server already performed the title compare-and-swap inside its
      // write transaction and reports the outcome, so there is no second
      // rename request to race a user edit against.
      if (data.page_title && focusedBlockIdRef.current === block.id) setPdfTitle(data.page_title);
      if (!data.cached) {
        setStatus(`Paper metadata found (${data.source === "ai" ? "AI-extracted" : data.source}).`);
        fetchHomeBlocks(); // keep the library's meta fresh for DOI-link matching
      }
      // The slide citation rides along with metadata — by the time the
      // popover is opened it's already cached on the page.
      if (data.meta || data.bibtex) makePptCitation(false, block);
    } catch (err) {
      if (focusedBlockIdRef.current === block.id) setStatus(`Metadata: ${err.message}`);
      // Mirror the server's negative-cache marker into the client copy —
      // otherwise the next autosave PUTs the stale properties and resurrects
      // the auto-retry on every open.
      setFocusedBlock((prev) =>
        prev && prev.id === block.id
          ? {
              ...prev,
              properties: {
                ...prev.properties,
                meta_error: {
                  at: new Date().toISOString(),
                  detail: (err.message || "failed").slice(0, 200),
                },
              },
            }
          : prev,
      );
    } finally {
      setMetaBusy(false);
    }
  }

  // Bulk-upload follow-up: fetch metadata for each new page (sequentially, like
  // the Settings batch retry) and replace still-default "PDF Notes - <sha>.pdf"
  // titles with the paper title. The single-upload path doesn't need this — it
  // opens the page, and the open-time effect below handles it.
  // Every uploaded PDF enters the same lazy, sequential metadata queue. The
  // server may replace its original-filename title only while the automatic
  // title marker still matches, so an in-flight lookup cannot undo a rename.
  function queueMetadataForUploads(uploaded) {
    if (readOnly || !metaAutoFetch) return;
    const pending = (uploaded || []).filter(({ block }) => block?.id
      && !block.properties?.meta && !block.properties?.meta_error
      && !attemptedMetaRef.current.has(block.id));
    pending.forEach(({ block }) => attemptedMetaRef.current.add(block.id));
    if (pending.length) setTimeout(() => fetchMetadataForUploads(pending), 0);
  }

  async function fetchMetadataForUploads(uploaded) {
    if (readOnly || !metaAutoFetch) return;
    let completed = 0;
    for (const { block } of uploaded) {
      if (!block?.id || block.properties?.meta) continue;
      try {
        const data = await fetchMetadataRequest(block);
        completed++;
        if (data.page_title) block.content = data.page_title;
        block.properties = {
          ...block.properties,
          meta: data.meta,
          bibtex: data.bibtex,
          meta_error: undefined,
          ...(data.title_updated ? { auto_title: undefined } : {}),
        };
        if (focusedBlockIdRef.current === block.id) {
          setPageMeta(data.meta || null);
          setPageBibtex(data.bibtex || "");
          setFocusedBlock({ ...block });
          if (data.page_title) setPdfTitle(data.page_title);
        }
      } catch {} // task already marked failed by fetchMetadataRequest
    }
    if (completed) fetchHomeBlocks();
  }

  // When a paper is opened/uploaded, fetch its metadata in the background
  // (arXiv → DOI → AI on the server). Cached in the page's properties.
  useEffect(() => {
    setPptCite("");
    resetCopied();
    const b = focusedBlock;
    if (readOnly || !b?.id || !b.properties?.doc_id) {
      setPageMeta(null);
      setPageBibtex("");
      return;
    }
    if (b.properties.meta) {
      setPageMeta(b.properties.meta);
      setPageBibtex(b.properties.bibtex || "");
      setPptCite(b.properties.ppt_cite || "");
      return;
    }
    setPageMeta(null);
    setPageBibtex("");
    if (!metaAutoFetch) return; // manual via ↻ only
    if (b.properties.meta_error) return; // a past lookup failed — retry only via ↻
    if (attemptedMetaRef.current.has(b.id)) return;
    attemptedMetaRef.current.add(b.id);
    fetchMetadata(b, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated on focused block; metadata fetch + guards must not retrigger
  }, [focusedBlock?.id]);

  // Import annotations embedded in the PDF file itself (SumatraPDF, Acrobat…).
  // Idempotent server-side, so calling it on every upload is safe.
  // strip: rewrite the stored PDF without the annotations being imported.
  // Defaults to the Settings preference; the import dialog can override it for
  // one run (auto-import on open always follows the preference).
  async function importEmbeddedAnnots(blockId, targetDocId, silent, strip = embAnnots === "strip") {
    const taskId = addTransfer({ name: "Importing embedded PDF annotations", kind: "import", info: "scanning…" });
    try {
      const res = await apiJson(`${API}/import/pdf-annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block_id: blockId, doc_id: targetDocId, strip }),
      });
      updateTransfer(taskId, {
        status: "done",
        info:
          res.imported > 0
            ? `${res.imported} imported`
            : res.found > 0
              ? "already imported"
              : "none found",
      });
      if (res.imported > 0) {
        if (focusedBlockIdRef.current === blockId) await loadBlocksForBlock(blockId);
        setStatus(
          `Imported ${res.imported} annotation${res.imported === 1 ? "" : "s"} embedded in the PDF.`,
        );
      }
      if (res.stripped > 0 && focusedBlockIdRef.current === blockId) {
        // The stored file changed — cache-bust so the open viewer re-renders
        // the page without the now-stripped annotations baked in.
        setPdfUrl((u) => (u ? u + (u.includes("?") ? "&" : "?") + "annots=" + Date.now() : u));
      }
      if (res.imported === 0 && !silent) {
        setStatus(
          res.found > 0
            ? "All embedded annotations were already imported."
            : "No annotations embedded in this PDF.",
        );
      }
      return res;
    } catch (err) {
      updateTransfer(taskId, { status: "error", info: (err.message || "failed").slice(0, 60) });
      if (!silent) setStatus(`Annotation import failed: ${err.message}`);
    }
  }

  async function makePptCitation(force = false, blockArg = null) {
    const targetId = blockArg?.id || focusedBlockId;
    if (!targetId || pptCiteBusy) return;
    setPptCiteBusy(true);
    const taskId = addTransfer({
      name: `Slide citation — ${(blockArg?.content || pdfTitle || "paper").slice(0, 48)}`,
      kind: "ai",
      info: "generating…",
    });
    try {
      const data = await apiJson(`${API}/metadata/cite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          block_id: targetId,
          prompt: citePrompt || "",
          model: chatSendModel || "",
          force,
        }),
      });
      updateTransfer(taskId, { status: "done", info: "" });
      if (focusedBlockIdRef.current === targetId) setPptCite(data.citation || "");
    } catch (err) {
      updateTransfer(taskId, { status: "error", info: (err.message || "failed").slice(0, 60) });
      setStatus(`Citation failed: ${err.message}`);
    } finally {
      setPptCiteBusy(false);
    }
  }

  // Opening the share popover generates the slide citation automatically
  // (cached on the page afterwards — one AI call per paper).
  useEffect(() => {
    if (openPopover === "share" && (pageMeta || pageBibtex) && !pptCite && !pptCiteBusy) {
      makePptCitation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated on share popover; makePptCitation/bibtex are read as inputs
  }, [openPopover, pageMeta]);

  // Copy + tick feedback for the page popovers, keyed by which row was hit.
  async function copyFlash(kind, text) {
    let ok;
    if (kind === "ppt") {
      // Rich copy: PowerPoint/Word get real italics & bold via text/html;
      // plain-text targets keep the markdown source so **bold** survives a
      // paste into notes or any markdown editor.
      const esc = (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const html = esc
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/_([^_]+)_/g, "<i>$1</i>")
        .replace(/\*([^*]+)\*/g, "<i>$1</i>");
      ok = await copyRich(html, text || "");
    } else {
      ok = await copyText(text || "");
    }
    if (ok) flashCopied(kind);
    else setStatus("Copy failed — copy manually.");
  }

  useEffect(() => {
    if (!authUser?.user || readOnly) return;
    refreshAiModels();
  }, [authUser, readOnly]);

  // …and pushed back so it follows the account to the next browser. Armed only
  // once the server's copy has been read, or the first render would overwrite
  // the stored choice with whatever localStorage happened to hold.
  useEffect(() => {
    if (!authUser?.user || readOnly || !aiSelLoadedRef.current || !chatModel) return;
    const u = authUser.user;
    if (aiSelPushTimerRef.current) clearTimeout(aiSelPushTimerRef.current);
    aiSelPushTimerRef.current = setTimeout(async () => {
      aiSelPushTimerRef.current = null;
      if (prefsUserRef.current !== u) return;
      try {
        await apiJson(`${API}/prefs/ai-selection`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            value: { model: chatModel, provider: aiProvider, effort: chatEffort },
          }),
        });
      } catch {}
    }, 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readOnly is read as a guard, not a push trigger
  }, [chatModel, aiProvider, chatEffort, authUser]);

  useEffect(() => {
    if (!chatModel) return;
    try {
      localStorage.setItem("gamma-chat-model", chatModel);
      // Also file it under its key (registry ids are "<entryId>:<model>").
      const key =
        (aiInfo?.models || []).find((m) => m.id === chatModel)?.provider || chatModel.split(":")[0];
      if (key) {
        chatModelMemRef.current = { ...chatModelMemRef.current, [key]: chatModel };
        localStorage.setItem("gamma-chat-model-by-key", JSON.stringify(chatModelMemRef.current));
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps -- aiInfo?.models maps model→key; chatModel is the trigger
  }, [chatModel]);

  // Capture text selected inside the PDF viewer so chat can focus on it.
  // Committed on mouseup (not selectionchange) so the modifier key is known:
  // Ctrl+select APPENDS another passage, plain select replaces the set, and
  // a plain click in the PDF clears it. Clicking into the chat keeps it.
  useEffect(() => {
    function onMouseUp(e) {
      if (!viewerWrapRef.current?.contains(e.target)) return;
      const additive = e.ctrlKey || e.metaKey;
      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel ? sel.toString().trim() : "";
        if (!text) {
          // Highlight clicks set the quote as the selection (in their own
          // click handler) — don't clear it from here.
          if (!additive && !e.target.closest?.("[data-hl-id]")) {
            setPdfSelections([]);
            // Optionally the same gesture drops PDF snapshots pending in the
            // chat (Settings → AI chat). Pasted images are never touched.
            if (chatImgAutoClearRef.current && pdfImagesRef.current.size) {
              setChatImages((prev) => prev.filter((s) => !pdfImagesRef.current.has(s)));
            }
          }
          return;
        }
        const node = sel.anchorNode;
        const el = node?.nodeType === 3 ? node.parentElement : node;
        if (!(viewerWrapRef.current && el && viewerWrapRef.current.contains(el))) return;
        addPdfSelection(text, additive);
      }, 10);
    }
    // Touch has no mouseup after a long-press/handle selection, so iPad picks
    // the passage up from selectionchange instead. No modifier exists there,
    // so it always replaces; and an emptied selection is left alone rather
    // than cleared, since a tap into the chat is indistinguishable from a tap
    // that dismissed the selection — and that tap must keep it.
    let touchSeen = false;
    let selTimer = null;
    function onTouchStart() {
      touchSeen = true;
    }
    function onSelectionChange() {
      if (!touchSeen) return;
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        const sel = window.getSelection();
        const text = sel ? sel.toString().trim() : "";
        if (!text) return;
        const node = sel.anchorNode;
        const el = node?.nodeType === 3 ? node.parentElement : node;
        if (!(viewerWrapRef.current && el && viewerWrapRef.current.contains(el))) return;
        addPdfSelection(text, false);
      }, 350);
    }
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      clearTimeout(selTimer);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []);

  // Selection is page-scoped: drop it when switching documents.
  useEffect(() => {
    setPdfSelections([]);
  }, [focusedBlockId]);

  function fetchHomeBlocks() {
    return apiJson(`${API}/blocks/root/children`)
      .then((data) => setHomeBlocks(Array.isArray(data.children) ? data.children : []))
      .catch(() => setHomeBlocks([]));
  }

  useEffect(() => {
    if (authUser?.user && !readOnly) fetchHomeBlocks();
  }, [authUser, readOnly]);

  useEffect(() => {
    function onExpired() {
      setAuthUser(false);
    }
    window.addEventListener("gamma-auth-expired", onExpired);
    return () => window.removeEventListener("gamma-auth-expired", onExpired);
  }, []);
  const pendingJumpRef = useRef(null);
  // Phase B2a: drop indicator state
  const [dropTarget, setDropTarget] = useState(null); // { targetId, above, rect }

  useEffect(() => {
    window._gammaSetDropTarget = setDropTarget;
    return () => {
      window._gammaSetDropTarget = null;
    };
  }, []);

  const [notesVisible, setNotesVisible] = useState(true);
  // Phone layout: which overlay panel covers the center ('notes' | 'chat' |
  // null = the main view). Reset on navigation so a new page opens on its content.
  const isPhone = useIsPhone();
  const [phonePanel, setPhonePanel] = useState(null);
  // A phone overlay stays MOUNTED once it has been opened, hidden rather than
  // unmounted while another tab is up: unmounting threw away the notes scroll
  // position (and the chat's draft) on every flip to the PDF and back. Panels
  // the user never opened are still not mounted, so chat history isn't loaded
  // on a phone that only reads.
  const phoneSeen = useRef({});
  if (isPhone && phonePanel) phoneSeen.current[phonePanel] = true;
  // Phone: kill the browser's own zoom. The viewport meta covers Android and
  // `touch-action: manipulation` (on .app.phoneUI) the double-tap, but iOS
  // Safari honours neither — only refusing its gesture events stops a pinch
  // from scaling the whole app until the toolbars sit off-screen. The PDF's
  // own pinch-zoom is unaffected: it runs off touchstart/touchmove.
  useEffect(() => {
    if (!isPhone) return;
    const block = (e) => e.preventDefault();
    for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
      document.addEventListener(ev, block, { passive: false });
    }
    return () => {
      for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
        document.removeEventListener(ev, block);
      }
    };
  }, [isPhone]);
  // Phone: drag-on-PDF mode — text selection (default) or rectangle drawing.
  // Desktop expresses this by holding Ctrl; a phone has no Ctrl, so it gets a
  // sticky toggle button in the viewer's zoom column instead.
  const [areaSelectMode, setAreaSelectMode] = useState(false);
  const [, setFlashingId] = useState(null);
  const [highlightMenu, setHighlightMenu] = useState(null); // { id, x, y } or null
  const [focusedId, setFocusedId] = useState(null);
  const [pdfTitle, setPdfTitle] = useState("");
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  useEffect(() => {
    document.title = pdfTitle
      ? `${pdfTitle} — Gamma`
      : "Gamma — Annotate PDFs, Share Your Thinking";
  }, [pdfTitle]);

  const scrollToRef = useRef(() => {});
  const flashTimerRef = useRef(null);
  const [attachModeBlockId, setAttachModeBlockId] = useState(null);
  const attachModeBlockIdRef = useRef(null);
  const [attachContextMenu, setAttachContextMenu] = useState(null); // {x, y, highlight}
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const blockRefs = useRef({});
  const pendingFocusRef = useRef(null);
  const pendingBlockScrollRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const suppressAutosaveRef = useRef(true); // skip initial mount + doc loads

  function registerRef(id, ref) {
    blockRefs.current[id] = ref;
  }

  useEffect(() => {
    if (!pendingFocusRef.current || readOnly) return;
    const id = pendingFocusRef.current;
    const ref = blockRefs.current[id];
    if (ref?.current) {
      ref.current.focus();
      pendingFocusRef.current = null;
    }
  }, [blocks, readOnly]);

  // The notes panel (.sidebar .blockList) is one DOM element reused across
  // page switches, so its scrollTop leaks from the previous page. On page
  // switch, land on this page's remembered position or at the top for first
  // visits. A queued block target (deep link, search hit, jump-to-latest)
  // takes priority — its scrollIntoView defines the position instead. On tab
  // switches the panel's rows are committed in the same render that set
  // focusedBlockId and the first attempt applies synchronously; on cold
  // loads the sidebar mounts a beat later (auth still resolving), hence the
  // short retry loop.
  useEffect(() => {
    if (pendingBlockScrollRef.current) return;
    let cancelled = false;
    let tries = 0;
    let lastH = -1;
    const apply = () => {
      if (cancelled) return;
      const el = document.querySelector(".sidebar .blockList");
      if (el) {
        const h = el.scrollHeight;
        // Re-read the saved entry on every attempt: a server-side notes-pos
        // merge from another device can land after this effect started, and
        // it must win over a stale local position.
        const saved = focusedBlockId ? tabScrollRef.current[focusedBlockId] : null;
        const anchorId = saved?.notesBlock || "";
        const anchorFrac = saved?.notesFrac ?? 0;
        const pxTarget = saved?.notesTop != null ? saved.notesTop : 0;
        // Preferred: put the anchored block back at the same fraction of the
        // viewport (width-independent — a phone window restores the same
        // content position as the desktop). Fall back to the raw saved px
        // when the anchor block isn't (yet) in the tree.
        let target = pxTarget;
        if (anchorId) {
          const row = el.querySelector(`[data-block-id="${CSS.escape(anchorId)}"]`);
          if (row) {
            const r = row.getBoundingClientRect();
            const er = el.getBoundingClientRect();
            // Capture stored "frac into the anchored row"; restore the top to
            // that same fraction INTO the row (sign is +, not -).
            target = r.top - er.top + el.scrollTop + r.height * anchorFrac;
          }
        }
        if (h === lastH) {
          // Row heights settled (fonts and markdown rendered) — without this
          // gate, scroll anchoring drags an early-applied position along as
          // rows above it grow during a cold load. Final assert, then done.
          if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
          return;
        }
        lastH = h;
        el.scrollTop = target;
      }
      if (tries++ < 40) setTimeout(apply, 100);
    };
    apply();
    return () => {
      cancelled = true;
    };
  }, [focusedBlockId, notesPosTick]);

  useEffect(() => {
    if (!pendingBlockScrollRef.current) return;
    const id = pendingBlockScrollRef.current;
    const row = document.querySelector(`[data-block-id="${id}"]`);
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      setFocusedId(id);
      pendingBlockScrollRef.current = null;
    } else if (flattenBlocks(blocks).some((b) => b.id === id)) {
      // Block exists but is inside a collapsed parent — expand and try again
      if (!readOnly) suppressAutosaveRef.current = true;
      setBlocks((prev) => expandToBlock(prev, id));
    } else {
      // Block not in tree yet — keep ref and wait for next blocks change
    }
  }, [blocks, readOnly]);

  // Fetch backlinks for the focused block
  useEffect(() => {
    if (!focusedBlockId) {
      setBacklinks([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiJson(`${API}/blocks/${focusedBlockId}/backlinks`);
        if (!cancelled) setBacklinks(data.backlinks || []);
      } catch {
        if (!cancelled) setBacklinks([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [focusedBlockId, readOnly]);

  // Queued autosave. The debounce timer used to be silently cancelled when
  // navigation replaced the block tree — a highlight made within 500 ms of
  // switching tabs was lost. Edits are now queued in pendingSaveRef (with the
  // page id they belong to) and flushed on navigation; failures retry so a
  // briefly unreachable server doesn't eat them either.
  const pendingSaveRef = useRef(null); // {pageId, blocks, attempts}
  function savePending() {
    const p = pendingSaveRef.current;
    if (!p) return;
    pendingSaveRef.current = null;
    apiJson(`${API}/blocks/${p.pageId}/children`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks: p.blocks }),
    }).catch((err) => {
      const attempts = (p.attempts || 0) + 1;
      if (pendingSaveRef.current) return; // a newer edit supersedes this one
      if (attempts < 6) {
        setStatus(`Save failed: ${err.message} — retrying…`);
        pendingSaveRef.current = { ...p, attempts };
        setTimeout(savePending, 3000);
      } else {
        setStatus(`Save failed: ${err.message}`);
      }
    });
  }
  // Persist queued edits NOW — called before anything replaces the block tree.
  function flushPendingSave() {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    savePending();
  }
  useEffect(() => {
    if (readOnly || !focusedBlockId) return;
    if (suppressAutosaveRef.current) {
      suppressAutosaveRef.current = false;
      return;
    }
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    pendingSaveRef.current = { pageId: focusedBlockId, blocks };
    autosaveTimerRef.current = setTimeout(savePending, 500);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- savePending/focusedBlockId are read via refs; blocks is the trigger
  }, [blocks, readOnly]);
  // Closing/reloading the tab: best-effort keepalive save of queued edits.
  useEffect(() => {
    const flush = () => {
      const p = pendingSaveRef.current;
      if (!p) return;
      pendingSaveRef.current = null;
      try {
        fetch(`${API}/blocks/${p.pageId}/children`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blocks: p.blocks }),
          keepalive: true,
          credentials: "include",
        }).catch(() => {});
      } catch {}
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  function deleteHighlight(highlightId) {
    if (readOnly) return;
    // Find the block whose properties.highlight_id matches, remove it (and descendants).
    function findHighlightBlockId(list) {
      for (const b of list || []) {
        if (b.properties?.highlight_id === highlightId) return b.id;
        const found = findHighlightBlockId(b.children || []);
        if (found) return found;
      }
      return null;
    }
    const blockId = findHighlightBlockId(blocks);
    if (!blockId) return;
    const nextBlocks = removeBlockTree(blocks, blockId);
    setBlocks(nextBlocks);
    // persistBlocks will fire via autosave; no need to duplicate.
  }

  function changeHighlightColor(highlightId, newColor) {
    if (readOnly) return;
    function findHighlightBlockId(list) {
      for (const b of list || []) {
        if (b.properties?.highlight_id === highlightId) return b.id;
        const found = findHighlightBlockId(b.children || []);
        if (found) return found;
      }
      return null;
    }
    const blockId = findHighlightBlockId(blocks);
    if (!blockId) return;
    const next = updateBlockTree(blocks, blockId, (b) => ({
      ...b,
      properties: { ...b.properties, color: newColor },
    }));
    setBlocks(next);
  }

  async function onFetchRefs(ids) {
    try {
      const res = await fetch(`/api/block-search?ids=${ids.join(",")}`);
      const data = await res.json();
      if (data.blocks?.length) {
        setRefCache((prev) => {
          const next = { ...prev };
          data.blocks.forEach((b) => {
            next[b.id] = b;
          });
          return next;
        });
      }
    } catch (_) {}
  }

  function onCacheRef(id, blockData) {
    setRefCache((prev) => (prev[id] ? prev : { ...prev, [id]: blockData }));
  }

  function triggerFlash(highlightId) {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashingId(null);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setFlashingId(highlightId);
        flashTimerRef.current = setTimeout(() => setFlashingId(null), 1000);
      });
    });
  }

  useEffect(() => {
    if (initialShare) resolveShare(initialShare);
    else if (initialBlockId) {
      (async () => {
        try {
          const data = await apiJson(
            `${API}/block-search?ids=${encodeURIComponent(initialBlockId)}`,
          );
          const block = data.blocks?.[0];
          const rootId = block?.page_root_id;
          if (rootId && rootId !== initialBlockId) {
            pendingBlockScrollRef.current = initialBlockId;
            pendingJumpRef.current = initialBlockId; // highlight blocks also jump the PDF
            openBlock(rootId, { restoreScroll: true });
          } else {
            openBlock(initialBlockId, { restoreScroll: true });
          }
        } catch {
          openBlock(initialBlockId, { restoreScroll: true });
        }
      })();
    } else if (initialUrl) openPdf(initialUrl);
    else if (initialCategory || initialFolder) {
      // Stay on home page with the category/folder filter — don't restore session
    } else {
      // Bare `/` — try restore last session
      const session = loadSession();
      if (session.focusedBlockId) {
        openBlock(session.focusedBlockId, { restoreScroll: true }).catch(() => {
          clearSession();
          setFocusedBlockId("");
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only session restore; initial* are read once
  }, []);

  // Restore viewer/layout prefs from session on mount
  useEffect(() => {
    const session = loadSession();
    if (session.pdfScale != null) setPdfScale(session.pdfScale);
    if (session.pdfHidden != null) setPdfHidden(session.pdfHidden);
    if (session.notesVisible != null) setNotesVisible(session.notesVisible);
  }, []);

  // Theme: System tracks the OS preference live; Light/Dark pin it.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.setAttribute(
      "data-theme", theme === "system" ? (mq.matches ? "dark" : "light") : theme);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  // Record a "recently viewed" entry whenever a page is opened. sessionUser
  // in the deps re-fires it once login resolves — a page opened by direct URL
  // shows before the session check finishes, and the first run skips.
  useEffect(() => {
    if (!focusedBlockId || readOnly || !prefsUserRef.current) return;
    pushRecentView(focusedBlockId);
  }, [focusedBlockId, readOnly, sessionUser]);

  // Keep the tab strip in sync with the open page.
  useEffect(() => {
    if (!focusedBlockId || readOnly || !prefsUserRef.current) return;
    const title = (pdfTitle || "Untitled").slice(0, 60);
    updateTabs((prev) => {
      const existing = prev.find((t) => t.id === focusedBlockId);
      if (existing && existing.title === title) return prev;
      if (existing) return prev.map((t) => (t.id === focusedBlockId ? { ...t, title } : t));
      return [...prev, { id: focusedBlockId, title }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- updateTabs is an unstable updater; title/id are the triggers
  }, [focusedBlockId, pdfTitle, readOnly]);

  // Persist session state on relevant changes (skip initial mount)
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    saveSession({
      focusedBlockId: focusedBlockId || undefined,
      pdfScale,
      pdfHidden,
      notesVisible,
      pdfPageNumber,
    });
  }, [focusedBlockId, pdfScale, pdfHidden, notesVisible, pdfPageNumber]);

  // Synced per-paper read position, fed by the scroll tracker on every scroll
  // (a ref so the tracker effect needn't re-register). Guarded: only while
  // the viewer is really showing this page's document and no scroll restore
  // is in flight (the tracker reports page 1 mid-load, which must not
  // overwrite the entry).
  const recordScrollPageRef = useRef(null);
  const trackPauseReasonRef = useRef(""); // last logged pause reason (debug log)
  useEffect(() => {
    recordScrollPageRef.current = (n) => {
      const reason = readOnly
        ? "readonly"
        : !focusedBlockId
          ? "no-focused-block"
          : !pdfUrl
            ? "no-pdf-url"
            : pdfRenderedUrlRef.current !== pdfUrl
              ? "doc-not-rendered"
              : restoringForRef.current === focusedBlockId
                ? "exact-restore-inflight"
                : coarseRestorePendingRef.current
                  ? "coarse-restore-pending"
                  : "";
      if (reason !== trackPauseReasonRef.current) {
        trackPauseReasonRef.current = reason;
        dbg(
          reason ? `tracker paused (${reason}) at page ${n}` : `tracker recording from page ${n}`,
        );
      }
      if (reason) return;
      recordReadPos(focusedBlockId, n);
      // Refresh this page's recents-card snapshot once the scroll settles.
      if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
      const id = focusedBlockId;
      snapTimerRef.current = setTimeout(() => {
        snapTimerRef.current = null;
        captureSnapRef.current?.(id);
      }, 1200);
    };
  });

  // Snapshot capture for the recents cards — same guards as the tracker, but
  // re-checked at fire time via the ref (the timers outlive this closure).
  // Returns true only when a real capture was stored.
  const snapTimerRef = useRef(null);
  const captureSnapRef = useRef(null);
  useEffect(() => {
    captureSnapRef.current = (id) => {
      if (!recentThumbs) return false;
      if (readOnly || !id || id !== focusedBlockId || !pdfUrl || pdfHidden) return false;
      if (pdfRenderedUrlRef.current !== pdfUrl) return false;
      if (restoringForRef.current === focusedBlockId || coarseRestorePendingRef.current) return false;
      const img = captureViewerSnapshot();
      if (img) savePageSnap(id, img);
      return !!img;
    };
  });
  // A page opened and left without scrolling still gets a cover: the restore
  // scrolls with the tracker paused, so poll a few times after the document
  // (re)renders until a capture sticks. The scroll-settle path above keeps it
  // fresh afterwards.
  useEffect(() => {
    if (!recentThumbs || !pdfUrl || pdfHidden || readOnly || !focusedBlockId) return;
    const id = focusedBlockId;
    let tries = 0, timer = null;
    const attempt = () => {
      timer = null;
      if (!captureSnapRef.current?.(id) && tries++ < 10) timer = setTimeout(attempt, 1500);
    };
    timer = setTimeout(attempt, 1500);
    return () => { if (timer) clearTimeout(timer); };
  }, [pdfUrl, pdfHidden, focusedBlockId, readOnly, recentThumbs]);

  async function loadBlocksForBlock(blockId) {
    try {
      const data = await apiJson(`${API}/blocks/${blockId}/subtree`);
      const children = normalizeBlocks(data.block?.children || []);
      suppressAutosaveRef.current = true;
      setBlocks(children);
      return children;
    } catch {
      suppressAutosaveRef.current = true;
      setBlocks([]);
      return [];
    }
  }

  async function getOrCreateBlockForDoc(targetDocId, defaultTitle, sourceUrl, originalFilename = "") {
    if (!targetDocId) throw new Error("docId required");
    return await apiJson(`${API}/blocks/by-doc/${targetDocId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        original_filename: originalFilename || null,
        default_title: defaultTitle || `PDF Notes - ${targetDocId}`,
        source_url: sourceUrl || null,
      }),
    });
  }

  async function renameTitle(newTitle) {
    if (readOnly || !focusedBlockId) return;
    const trimmed = (newTitle || "").trim();
    const finalTitle = trimmed || getPdfPageTitle(docId, inputUrl);
    setPdfTitle(finalTitle);
    setFocusedBlock((b) => (b ? { ...b, content: finalTitle } : b));
    try {
      await apiJson(`${API}/blocks/${focusedBlockId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: finalTitle }),
      });
      setHomeBlocks((prev) =>
        prev.map((b) => (b.id === focusedBlockId ? { ...b, content: finalTitle } : b)),
      );
      setStatus(`Renamed to "${finalTitle}"`);
    } catch (err) {
      setStatus(`Rename failed: ${err.message}`);
    }
  }

  async function persistBlocks(nextBlocks) {
    if (readOnly || !focusedBlockId) return;
    await apiJson(`${API}/blocks/${focusedBlockId}/children`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks: nextBlocks }),
    });
  }

  async function uploadOnePdf(file, folder = "") {
    const filename = uploadLeafName(file, "upload.pdf");
    const transferId = addTransfer({ name: filename, kind: "upload", info: fmtBytes(file.size) });
    const form = new FormData();
    form.append("file", file, filename);
    let data;
    try {
      data = await apiJson(`${API}/uploads`, { method: "POST", body: form });
    } catch (err) {
      updateTransfer(transferId, { status: "error", info: "failed" });
      throw err;
    }
    updateTransfer(transferId, { status: "done", info: fmtBytes(file.size) });
    // The uploaded file's own name is the best automatic title; the server
    // marks it auto_title so a metadata lookup may still replace it.
    const defaultTitle = filename || getPdfPageTitle(data.doc_id, data.source_url);
    const block = await getOrCreateBlockForDoc(
      data.doc_id, defaultTitle, data.source_url, filename || defaultTitle,
    );
    if (folder) {
      const tags = parseFolderTags(block.properties?.folder);
      if (!tags.includes(folder)) {
        const next = addFolderTag(tags, folder);
        try {
          await writePageFolders(block.id, next);
          block.properties = { ...block.properties, folder: next.join(", ") };
        } catch {}
      }
    }
    // If the file carries embedded annotations (SumatraPDF etc.), pull them in
    importEmbeddedAnnots(block.id, data.doc_id, true);
    return { data, block, defaultTitle };
  }

  async function importOneMarkdown(file, folder = "") {
    const filename = uploadLeafName(file, "note.md");
    const transferId = addTransfer({ name: filename, kind: "import", info: fmtBytes(file.size) });
    const form = new FormData();
    form.append("file", file, filename);
    form.append("folder", folder);
    try {
      const data = await apiJson(`${API}/import/markdown`, { method: "POST", body: form });
      updateTransfer(transferId, {
        status: "done",
        info: data.duplicate ? "already imported" : `${data.imported || 0} notes`,
      });
      return { data, kind: "markdown" };
    } catch (err) {
      updateTransfer(transferId, { status: "error", info: "failed" });
      throw err;
    }
  }

  async function uploadFiles(fileList) {
    if (readOnly) return;
    // Accepts Files (picker/drop) or {file, folder} pairs (dropped-folder walk);
    // the directory picker's Files carry the path in webkitRelativePath instead.
    // With a folder open in the library view, uploads land inside it.
    const base = homeMode && folderFilter ? folderFilter : "";
    const items = Array.from(fileList || [])
      .map((it) => (it instanceof File ? { file: it, folder: folderFromRelPath(it.webkitRelativePath) } : it))
      .filter((it) => it?.file && (isPdfFile(it.file) || isMarkdownFile(it.file)))
      .map(({ file, folder }) => ({
        file,
        filename: uploadLeafName(file),
        folder: [base, folder].filter(Boolean).join("/"),
      }));
    if (!items.length) {
      setStatus("No PDF or Markdown files found.");
      return;
    }
    setLoading(true);
    const done = [];
    const failed = [];
    try {
      for (const { file, filename, folder } of items) {
        // Pre-check only with the quota info loaded — otherwise let the
        // server's check_upload_allowed decide (its 413 detail is surfaced
        // per file below). Markdown is parsed into blocks, not stored as an
        // upload, so the uploads quota does not apply to it.
        if (isPdfFile(file) && quotaInfo && file.size > quotaInfo.max_upload_mb * 1024 * 1024) {
          failed.push(`${filename} (max ${quotaInfo.max_upload_mb} MB)`);
          continue;
        }
        setStatus(`${isPdfFile(file) ? "Uploading" : "Importing"} ${filename}...`);
        try {
          done.push(isPdfFile(file)
            ? { ...(await uploadOnePdf(file, folder)), kind: "pdf" }
            : await importOneMarkdown(file, folder));
        } catch (err) {
          failed.push(`${filename} (${err.message})`);
        }
      }
      const pdfDone = done.filter((item) => item.kind === "pdf");
      if (pdfDone.length) refreshQuota();
      if (items.length === 1 && done.length && done[0].kind === "pdf") {
        // Single upload keeps the old behavior: open the paper directly
        // (bypass openPdf's URL-resolution path).
        const { data, block, defaultTitle } = done[0];
        await loadBlocksForBlock(block.id);
        setDocId(data.doc_id);
        setInputUrl(data.source_url);
        setFocusedBlockId(block.id);
        setFocusedBlock(block);
        setPdfTitle(block.content || defaultTitle);
        setSummary(block.properties?.summary || "");
        setCategory(block.properties?.category || "");
        setPageFolders(parseFolderTags(block.properties?.folder));
        setPdfUrl(data.source_url);
        const newUrl = `${window.location.pathname}?block=${encodeURIComponent(block.id)}`;
        window.history.replaceState({}, "", newUrl);
        setStatus(`Uploaded ${items[0].filename} (${data.doc_id})`);
      } else if (items.length === 1 && done.length) {
        // A single Markdown file: open the note page it became.
        await fetchHomeBlocks();
        await openBlock(done[0].data.block_id, { pushNav: true });
        setStatus(done[0].data.duplicate
          ? `${items[0].filename} was already imported — opened the existing note.`
          : `Imported ${items[0].filename} as a note.`);
      } else if (done.length) {
        fetchHomeBlocks();
        setStatus(failed.length
          ? `Imported ${done.length} of ${items.length} files — failed: ${failed.join(", ")}`
          : `Imported ${done.length} files.`);
      } else {
        setStatus(`Upload failed: ${failed.join(", ")}`);
      }
      // Runs after the upload/import UI work and never delays its completion.
      queueMetadataForUploads(pdfDone);
    } finally {
      setLoading(false);
    }
  }

  async function importLogseq(files) {
    if (readOnly) return;
    const all = Array.from(files);
    const pdfFile = all.find((f) => f.name.endsWith(".pdf"));
    const ednFile = all.find((f) => f.name.endsWith(".edn"));
    const mdFile = all.find((f) => f.name.endsWith(".md"));
    if (!pdfFile || !ednFile) {
      setStatus("Select at least a .pdf and .edn file.");
      return;
    }
    setLoading(true);
    setStatus(`Importing ${pdfFile.name}...`);
    try {
      const form = new FormData();
      form.append("pdf", pdfFile);
      form.append("edn", ednFile);
      if (mdFile) form.append("md", mdFile);
      const resp = await fetch(`${API}/import/logseq`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      // Block was already created by the import endpoint; just load it.
      const block = await getOrCreateBlockForDoc(
        data.doc_id,
        pdfFile.name.replace(".pdf", ""),
        data.source_url,
      );
      await loadBlocksForBlock(block.id);
      setDocId(data.doc_id);
      setInputUrl(data.source_url);
      setFocusedBlockId(block.id);
      setFocusedBlock(block);
      setPdfTitle(block.content || pdfFile.name.replace(".pdf", ""));
      setSummary(block.properties?.summary || "");
      setCategory(block.properties?.category || "");
      setPageFolders(parseFolderTags(block.properties?.folder));
      setPdfUrl(data.source_url);
      await fetchHomeBlocks();
      const newUrl = `${window.location.pathname}?block=${encodeURIComponent(block.id)}`;
      window.history.replaceState({}, "", newUrl);
      setStatus(`Imported ${data.imported} highlights from ${pdfFile.name}`);
    } catch (err) {
      setStatus(`Import failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  // Whole-library import from a zipped Zotero RDF export (the import dialog's
  // third source; also reachable from Settings → Library). Collections become
  // folders, tags labels, notes child blocks; the reader annotations ride
  // inside the exported PDFs, so strip works exactly like for "this PDF".
  async function importZotero(file, strip = embAnnots === "strip") {
    if (readOnly) return;
    const taskId = addTransfer({ name: `Zotero import — ${file.name.slice(0, 48)}`, kind: "import", info: "importing…" });
    setStatus("Importing Zotero library — this can take a while for big exports…");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("strip", strip ? "true" : "false");
      const data = await apiJson(`${API}/import/zotero`, { method: "POST", body: form });
      const problems = (data.skipped?.length || 0) + (data.warnings?.length || 0);
      [...(data.skipped || []), ...(data.warnings || [])].forEach((s) =>
        console.warn(`Zotero import: ${s.title} — ${s.reason}`));
      updateTransfer(taskId, { status: "done", info: `${data.pages_created + data.pages_merged} pages` });
      const bits = [
        `${data.pages_created} new page${data.pages_created === 1 ? "" : "s"}`,
        data.pages_merged ? `${data.pages_merged} updated` : "",
        data.annotations_imported ? `${data.annotations_imported} annotations` : "",
        data.notes_imported ? `${data.notes_imported} notes` : "",
        problems ? `${problems} issue${problems === 1 ? "" : "s"} (details in the browser console)` : "",
      ].filter(Boolean).join(" · ");
      setStatus(`Zotero import: ${bits}.`);
      refreshQuota?.();
      await fetchHomeBlocks();
    } catch (err) {
      updateTransfer(taskId, { status: "error", info: (err.message || "failed").slice(0, 60) });
      setStatus(`Zotero import failed: ${err.message}`);
    }
  }

  async function openPdf(sourceUrl) {
    if (!sourceUrl || readOnly) return;
    leaveCurrentPage();
    setLoading(true);
    setStatus("Opening PDF...");
    // Visible from the moment Enter is pressed — resolve can take seconds.
    const taskId = addTransfer({
      name: sourceUrl.slice(0, 60),
      kind: "download",
      info: "resolving…",
    });
    try {
      // Uploaded PDFs are already hosted locally — skip external resolve and proxy.
      const isUpload =
        sourceUrl.startsWith("/api/uploads/") || sourceUrl.startsWith(`${API}/uploads/`);
      let finalUrl,
        resolvedDocId,
        proxiedUrl,
        pdfNote = "";
      if (isUpload) {
        finalUrl = sourceUrl;
        // filename is "<doc_id>.pdf" — serve straight from the uploads route
        const m = sourceUrl.match(/\/([0-9a-f]+)\.pdf$/);
        resolvedDocId = m ? m[1] : await getDocIdForUrl(sourceUrl);
        proxiedUrl = `${API}/uploads/${resolvedDocId}.pdf`;
      } else {
        const resolved = await resolvePdfUrl(sourceUrl, oaFallback);
        finalUrl = resolved.source_url;
        pdfNote = resolved.note || "";
        resolvedDocId = await getDocIdForUrl(finalUrl);
        proxiedUrl = pdfProxyUrl(finalUrl, { save: pdfSaveLocal });
        // A new paper must download before it gets a page — otherwise a dead
        // link leaves behind an empty page that only ever repeats the error.
        // Papers already in the library skip the check: an existing page stays
        // openable even once its source has gone away.
        const known = await apiJson(`${API}/blocks/by-doc/${resolvedDocId}`).catch(() => null);
        if (!known) {
          updateTransfer(taskId, { info: "checking link…" });
          await probePdfUrl(finalUrl);
        }
        transferByUrlRef.current[proxiedUrl] = taskId; // viewer's byte-level reporting takes over this row
      }
      // Resolve block + load children FIRST, before setPdfUrl, to avoid mid-render highlight race
      const defaultTitle = getPdfPageTitle(resolvedDocId, finalUrl);
      const block = await getOrCreateBlockForDoc(resolvedDocId, defaultTitle, finalUrl);
      updateTransfer(taskId, {
        name: (block.content || defaultTitle).slice(0, 60),
        ...(isUpload ? { status: "done", info: "local file" } : { info: "downloading…" }),
      });
      await loadBlocksForBlock(block.id);
      setDocId(resolvedDocId);
      setInputUrl(finalUrl);
      setFocusedBlockId(block.id);
      setFocusedBlock(block);
      setPdfTitle(block.content || defaultTitle);
      setSummary(block.properties?.summary || "");
      setCategory(block.properties?.category || "");
      setPageFolders(parseFolderTags(block.properties?.folder));
      setPdfUrl(proxiedUrl);
      const newUrl = `${window.location.pathname}?block=${encodeURIComponent(block.id)}`;
      window.history.replaceState({}, "", newUrl);
      setStatus(pdfNote || `Loaded ${resolvedDocId}`);
    } catch (err) {
      updateTransfer(taskId, { status: "error", info: (err.message || "failed").slice(0, 60) });
      setStatus(`Open failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  // "+" popover: a blank note page (no PDF) — created in the open folder, if any.
  async function createNotePage() {
    if (readOnly) return;
    setOpenPopover(null);
    try {
      const created = await apiJson(`${API}/blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parent_id: "root",
          content: "New note",
          ...(folderFilter ? { properties: { folder: folderFilter } } : {}),
        }),
      });
      await fetchHomeBlocks();
      await openBlock(created.id, { pushNav: true });
    } catch (err) {
      setStatus(`Create failed: ${err.message || err}`);
    }
  }

  async function resolveShare(token) {
    setLoading(true);
    setStatus("Resolving share link...");
    try {
      const data = await apiJson(`${API}/share/${token}`);
      shareOwnerRef.current = data.username || "";
      shareTokenRef.current = token;
      // Read access rides on the share token itself (scoped to this one
      // document), never a bare ?user= (which used to grant whole-account reads).
      const shareParam = `?share=${encodeURIComponent(token)}`;

      let block = null;
      try { block = await apiJson(`${API}/blocks/by-doc/${data.doc_id}${shareParam}`); } catch {}

      let childBlocks = [];
      if (block) {
        try {
          const subtreeData = await apiJson(`${API}/blocks/${block.id}/subtree${shareParam}`);
          childBlocks = normalizeBlocks(subtreeData.block?.children || []);
        } catch {}
      }

      const props = block?.properties || {};
      const src = props.source_url || props.sourceUrl || "";
      const isLocal = src.startsWith("/api/");
      const proxiedUrl = isLocal
        ? `${src}${src.includes("?") ? "&" : "?"}share=${encodeURIComponent(token)}`
        : src ? pdfProxyUrl(src, { share: token }) : "";

      suppressAutosaveRef.current = true;
      setFocusedBlockId(block?.id || "");
      setFocusedBlock(block || null);
      setPdfTitle(block?.content || getPdfPageTitle(data.doc_id, src));
      setBlocks(childBlocks);
      setDocId(data.doc_id);
      setInputUrl(src);
      setPdfUrl(proxiedUrl);
      setStatus("Loaded shared doc.");
    } catch (err) {
      setStatus(`Share open failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function openBlock(blockId, opts) {
    if (!blockId || readOnly) return;
    // Back records LINK jumps only — callers opt in via {pushNav: true}.
    // Plain navigation (library, search, tabs, home) never pushes.
    if (opts?.pushNav && blockId !== focusedBlockId) pushNav();
    leaveCurrentPage();
    setLoading(true);
    setStatus("Opening...");
    try {
      const subtreeData = await apiJson(`${API}/blocks/${blockId}/subtree`);
      const block = subtreeData.block;
      if (!block) throw new Error("Block not found");
      const props = block.properties || {};
      if (opts?.origin) {
        updateTabs((prev) => {
          const existing = prev.find((tab) => tab.id === blockId);
          if (existing) {
            return prev.map((tab) => (
              tab.id === blockId
                ? { ...tab, title: (block.content || "Untitled").slice(0, 60), origin: opts.origin }
                : tab
            ));
          }
          return [...prev, {
            id: blockId,
            title: (block.content || "Untitled").slice(0, 60),
            origin: opts.origin,
          }];
        });
      }
      const childBlocks = normalizeBlocks(block.children || []);

      suppressAutosaveRef.current = true;
      setFocusedBlockId(blockId);
      setFocusedBlock(block);
      setPdfTitle(block.content || "Untitled");
      setSummary(props.summary || "");
      setCategory(props.category || "");
      setPageFolders(parseFolderTags(props.folder));
      setDocId(props.doc_id || "");

      let openedPdfUrl = "";
      if (props.source_url) {
        const src = props.source_url;
        const isLocal = src.startsWith("/api/");
        openedPdfUrl = isLocal ? src : pdfProxyUrl(src);
        setInputUrl(src);
        setPdfUrl(openedPdfUrl);
        setBlocks(childBlocks);
      } else {
        setInputUrl("");
        setPdfUrl("");
        if (childBlocks.length === 0 && !readOnly) {
          const seedId = makeId();
          suppressAutosaveRef.current = true;
          pendingFocusRef.current = seedId;
          setBlocks([
            {
              id: seedId,
              content: "",
              children: [],
              collapsed: false,
              editMode: true,
              properties: {},
            },
          ]);
        } else {
          setBlocks(childBlocks);
        }
      }

      // Scroll notes panel to the most recently updated block, unless a
      // specific target was already queued (e.g. ?block=... deep link) or
      // the caller is restoring a saved scroll position (tab switch,
      // session restore) — that position wins over "jump to latest edit".
      if (!pendingBlockScrollRef.current && !opts?.restoreScroll && childBlocks.length > 0) {
        let latest = null;
        for (const b of flattenBlocks(childBlocks)) {
          if (!latest || (b.updated_at || "") > (latest.updated_at || "")) latest = b;
        }
        if (latest) pendingBlockScrollRef.current = latest.id;
      }

      const newUrl = `${window.location.pathname}?block=${encodeURIComponent(blockId)}`;
      window.history.replaceState({}, "", newUrl);
      // Pages remember their own window arrangement; pages without one
      // inherit whatever layout is currently on screen.
      const savedUi = pageLayoutsRef.current[blockId];
      if (savedUi?.layout) {
        setLayout(savedUi.layout);
        setCollapsedWins(savedUi.collapsed || {});
        setPdfHidden(!!savedUi.pdfHidden);
        setChatHidden(!!savedUi.chatHidden);
        if (savedUi.notesVisible != null) setNotesVisible(savedUi.notesVisible);
        // Panel ratios apply once the restored window structure has
        // committed (a group's panel count must match its saved sizes).
        if (savedUi.sizes) {
          let tries = 0;
          const applySizes = () => {
            let pending = false;
            for (const [k, arr] of Object.entries(savedUi.sizes)) {
              const h = panelGroupRefs.current[k];
              if (!h || !Array.isArray(arr) || !arr.length) continue;
              try {
                const cur = h.getLayout();
                if (cur.length !== arr.length) {
                  pending = true;
                  continue;
                }
                if (cur.some((v, i) => Math.abs(v - arr[i]) > 0.5)) h.setLayout(arr);
              } catch {
                pending = true;
              }
            }
            if (pending && tries++ < 20) setTimeout(applySizes, 60);
          };
          requestAnimationFrame(applySizes);
        }
      }
      // Zoom travels with the page too. Applied before the PDF mounts, so a
      // numeric zoom is already in effect when the scroll restore runs — its
      // scale ratio is then exactly 1 and the position lands exactly.
      if (savedUi?.pdfScale) setPdfScale(savedUi.pdfScale);
      if (opts?.restoreScroll)
        restorePdfScroll(tabScrollRef.current[blockId], blockId, openedPdfUrl);
      setStatus("Ready.");
      return openedPdfUrl;
    } catch (err) {
      setStatus(`Open failed: ${err.message}`);
      // If this was a session restore attempt that failed, clear it
      if (!window.location.search.includes("block=")) clearSession();
    } finally {
      setLoading(false);
    }
  }

  // --- Global back: one history for every navigation ------------------------
  // Entries capture the full "view": which page (or home + folder) and, for
  // PDFs, the exact scroll position (scale-aware). In-PDF link jumps, opening
  // other papers, search results, and going home all push here.
  const [navStack, setNavStack] = useState([]);
  const pdfEffScaleRef = useRef(1);
  useEffect(() => {
    pdfEffScaleRef.current = pdfEffScale;
  }, [pdfEffScale]);
  // PDF scroll restore: exact-position anchor + settle loop. The hook owns its
  // refs; the DOM refs it reads (viewer scroller, effective scale) and the
  // debug logger stay in App and are passed in. Declared before the pdfUrl
  // reset effect below (which reads pendingRestoreRef in its deps).
  const { restoreTokenRef, restoringForRef, pdfRenderedUrlRef, pendingRestoreRef, cancelPdfRestore, pdfRestoreTargetTop, restorePdfScroll } =
    usePdfScrollRestore({ dbg, viewerWrapRef, pdfEffScaleRef });
  // .pdfViewer is one persistent DOM element that pdf.js just swaps content
  // in, so its scrollTop carries over across doc swaps — B ends up at A's
  // pixel position when there is no saved position for B to restore to.
  // Reset here, but skip if a pending restore is already queued: child
  // effects fire before parent effects, so rendered's scrollTo(target) has
  // already been applied by the time this parent effect runs; without the
  // guard we'd overwrite the restore with 0.
  useEffect(() => {
    if (pendingRestoreRef.current) return;
    const scroller = viewerWrapRef.current?.querySelector(".pdfViewer");
    if (scroller) scroller.scrollTop = 0;
  }, [pdfUrl, pendingRestoreRef]);

  // Exact per-page reading positions so switching tabs returns to where you
  // were, not just to the same page. blockId -> {top, scale, notesTop}.
  // Loaded synchronously (not in an effect): the session-restore openBlock
  // fires from a mount effect before auth resolves, so an [authUser]-gated
  // load would always lose that race and refresh restores would see {}.
  // Global key on purpose, same as gamma-session (which picks the page to
  // reopen) — entries are keyed by block id, so accounts can't collide.
  const tabScrollRef = useRef(null);
  if (tabScrollRef.current == null) {
    try {
      tabScrollRef.current = JSON.parse(localStorage.getItem("gamma-tab-scroll") || "{}") || {};
    } catch {
      tabScrollRef.current = {};
    }
  }
  if (typeof window !== "undefined") window._tabScroll = tabScrollRef.current;
  function persistTabScroll() {
    try {
      const keys = Object.keys(tabScrollRef.current);
      if (keys.length > 200) {
        const out = {};
        for (const k of keys.slice(-200)) out[k] = tabScrollRef.current[k];
        tabScrollRef.current = out;
      }
      localStorage.setItem("gamma-tab-scroll", JSON.stringify(tabScrollRef.current));
    } catch {}
  }
  // Per-page window layout (dock slots, collapsed bars, hidden windows, and
  // panel size ratios) — captured when leaving a page, restored on reopen.
  const pageLayoutsRef = useRef({});
  const panelGroupRefs = useRef({}); // group key -> react-resizable-panels imperative handle
  useEffect(() => {
    if (!authUser?.user || readOnly) return;
    try {
      pageLayoutsRef.current = JSON.parse(
        localStorage.getItem(`gamma-page-layouts:${authUser.user}`) || "{}",
      );
    } catch {
      pageLayoutsRef.current = {};
    }
  }, [authUser?.user, readOnly]);
  function captureScrollPos() {
    // The page's window layout travels with it — including panel size ratios.
    if (focusedBlockId && !readOnly && prefsUserRef.current) {
      const sizes = {};
      for (const [k, h] of Object.entries(panelGroupRefs.current)) {
        try {
          if (h) sizes[k] = h.getLayout();
        } catch {}
      }
      pageLayoutsRef.current[focusedBlockId] = {
        layout,
        collapsed: collapsedWins,
        pdfHidden,
        chatHidden,
        notesVisible,
        sizes,
        pdfScale,
      };
      try {
        const keys = Object.keys(pageLayoutsRef.current);
        while (keys.length > 80) delete pageLayoutsRef.current[keys.shift()];
        localStorage.setItem(
          `gamma-page-layouts:${prefsUserRef.current}`,
          JSON.stringify(pageLayoutsRef.current),
        );
      } catch {}
    }
    // Notes-panel scroll — ahead of the PDF gates so note-only pages (and
    // pages whose PDF is still loading) still remember their position.
    const notesScroller = document.querySelector(".sidebar .blockList");
    if (focusedBlockId && notesScroller) {
      const prev = tabScrollRef.current[focusedBlockId] || {};
      const entry = { ...prev, notesTop: notesScroller.scrollTop };
      // Layout-independent anchor, same idea as the PDF's page+frac: which
      // block sits under the viewport top and how far into it. Raw scrollTop
      // is pixels — a narrower window (phone) wraps rows differently, so the
      // same saved px lands on different content. The anchor restores the
      // same block at the same screen position on any width.
      const nRect = notesScroller.getBoundingClientRect();
      const st = notesScroller.scrollTop;
      for (const row of notesScroller.querySelectorAll(".blockRowWrap")) {
        const r = row.getBoundingClientRect();
        const rowTop = r.top - nRect.top + st;
        if (rowTop + r.height > st) {
          entry.notesBlock = row.getAttribute("data-block-id") || "";
          entry.notesFrac = Math.max(0, Math.min(1, (st - rowTop) / Math.max(1, r.height)));
          break;
        }
      }
      tabScrollRef.current[focusedBlockId] = entry;
      // Cross-browser sync: the anchor (block + fraction) follows the account,
      // so a phone lands on the same content position as the desktop.
      if (entry.notesBlock) recordNotesPos(focusedBlockId, entry.notesBlock, entry.notesFrac);
    }
    // Only record a PDF position when the viewer is actually showing THIS
    // page's document: mid-load the scroller still holds the previous document
    // (or a clamped 0), and a pending restore means the real position hasn't
    // been applied yet — in both cases keep the previously saved value.
    const restoring = restoringForRef.current && restoringForRef.current === focusedBlockId;
    if (!restoring && pdfUrl && pdfRenderedUrlRef.current === pdfUrl) {
      const scroller = viewerWrapRef.current?.querySelector(".pdfViewer");
      if (focusedBlockId && scroller) {
        const prev = tabScrollRef.current[focusedBlockId] || {};
        const entry = { ...prev, top: scroller.scrollTop, scale: pdfEffScale };
        // Scale-invariant anchor: the page under the viewport top plus the
        // fraction into it, measured off the live DOM. Restoring from raw
        // top × (scale ratio) mis-scales the fixed 8px inter-page margins,
        // and every capture bakes the previous restore's error back in — the
        // position crept a few px further on each refresh / A→B→A cycle.
        const sRect = scroller.getBoundingClientRect();
        for (const p of scroller.querySelectorAll("[data-page]")) {
          const r = p.getBoundingClientRect();
          const pageTop = r.top - sRect.top + scroller.scrollTop;
          if (pageTop + r.height > scroller.scrollTop) {
            entry.page = Number(p.getAttribute("data-page"));
            entry.frac = Math.max(0, (scroller.scrollTop - pageTop) / Math.max(1, r.height));
            break;
          }
        }
        tabScrollRef.current[focusedBlockId] = entry;
      }
    }
    persistTabScroll();
  }
  // Refresh/close never goes through leaveCurrentPage — capture on the way
  // out (and when the browser tab is hidden) so reload lands back on the
  // exact pixel. The ref keeps the listeners on the freshest closure.
  const captureScrollPosRef = useRef(() => {});
  captureScrollPosRef.current = captureScrollPos;
  useEffect(() => {
    const onHidden = () => captureScrollPosRef.current();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHidden();
    };
    window.addEventListener("beforeunload", onHidden);
    window.addEventListener("pagehide", onHidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onHidden);
      window.removeEventListener("pagehide", onHidden);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  // Everything owed to the page being navigated away from: persist queued
  // edits, remember its scroll position + window layout, and kill any
  // in-flight scroll restore so it can't touch the next document.
  function leaveCurrentPage() {
    flushPendingSave();
    captureScrollPos();
    cancelPdfRestore();
  }
  function pushNav() {
    const scroller = viewerWrapRef.current?.querySelector(".pdfViewer");
    const entry = {
      blockId: focusedBlockId || null,
      folder: folderFilter,
      top: scroller ? scroller.scrollTop : null,
      scale: pdfEffScale,
    };
    setNavStack((prev) => [...prev.slice(-29), entry]);
  }

  async function goBackNav() {
    const entry = navStack[navStack.length - 1];
    if (!entry) return;
    setNavStack((prev) => prev.slice(0, -1));
    if (entry.blockId && entry.blockId === focusedBlockId) {
      restorePdfScroll(entry, entry.blockId, pdfUrl); // same document — just return to the reading position
    } else if (entry.blockId) {
      const openedUrl = await openBlock(entry.blockId);
      restorePdfScroll(entry, entry.blockId, openedUrl);
    } else {
      goHome();
      if (entry.folder) openFolder(entry.folder);
    }
  }
  const goBackNavRef = useRef(null);
  goBackNavRef.current = goBackNav;
  const navStackLen = navStack.length;

  function goHome(refreshHome = true) {
    leaveCurrentPage();
    clearSession();
    suppressAutosaveRef.current = true;
    setFocusedBlockId(null);
    setFocusedBlock(null);
    setBlocks([]);
    setPdfUrl("");
    setDocId("");
    setInputUrl("");
    setPdfTitle("");
    setSummary("");
    setCategory("");
    setPageFolders([]);
    setBacklinks([]);
    setPdfHidden(false);
    setFolderFilter("");
    setCategoryFilter("");
    if (refreshHome) fetchHomeBlocks();
    window.history.replaceState({}, "", window.location.pathname);
  }

  function restoreTabOrigin(origin) {
    goHome();
    if (!origin || origin.kind === "root") return;
    const labelExists = origin.label && homeBlocks.some((block) =>
      parseFolderTags(block.properties?.category).includes(origin.label),
    );
    const folderExists = origin.folder && allFolderPaths.includes(origin.folder);
    // A label view now lives INSIDE a folder scope, so the two are restored
    // together rather than one instead of the other.
    const folder = folderExists ? origin.folder : "";
    const label = labelExists ? origin.label : "";
    if (folder) setFolderFilter(folder);
    if (label) setCategoryFilter(label);
    if (folder || label) window.history.replaceState(null, "", homeUrlFor(folder, label));
    if (origin.kind === "search") {
      setSearchRestoreContext(origin);
      setOpenPopover("search");
    }
  }

  function closeTab(id) {
    const closed = openTabs.find((tab) => tab.id === id);
    updateTabs((prev) => prev.filter((tab) => tab.id !== id));
    if (id === focusedBlockId) restoreTabOrigin(closed?.origin);
  }

  // Drag any window by its grip; drop zones dock it left, right, or bottom.
  // Within a slot the drop half decides the order (top/left half = first),
  // which is how windows swap places. One implementation for every window.
  function startWindowDock(e, winId) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    let dragging = false;
    try {
      target.setPointerCapture(pointerId);
    } catch (_) {}

    function zoneFor(ev) {
      if (ev.clientY > window.innerHeight * 0.65) {
        return { side: "bottom", index: ev.clientX < window.innerWidth / 2 ? 0 : 99 };
      }
      const side = ev.clientX < window.innerWidth / 2 ? "left" : "right";
      return { side, index: ev.clientY < window.innerHeight * 0.35 ? 0 : 99 };
    }
    // Preview shows the REAL landing geometry: the existing slot's rect (or
    // the default size a new slot would open with), halved to the drop
    // position when other windows already live there.
    function previewRect(zone) {
      const wa = document.querySelector(".workArea")?.getBoundingClientRect();
      if (!wa) return null;
      const slotEl = document.querySelector(`[data-panel-id="slot-${zone.side}"]`);
      let r;
      if (slotEl) {
        const b = slotEl.getBoundingClientRect();
        r = { left: b.left, top: b.top, width: b.width, height: b.height };
      } else if (zone.side === "bottom") {
        r = {
          left: wa.left,
          top: wa.top + wa.height * 0.68,
          width: wa.width,
          height: wa.height * 0.32,
        };
      } else if (zone.side === "left") {
        r = { left: wa.left, top: wa.top, width: wa.width * 0.26, height: wa.height };
      } else {
        r = {
          left: wa.left + wa.width * 0.72,
          top: wa.top,
          width: wa.width * 0.28,
          height: wa.height,
        };
      }
      const others = layout[zone.side].filter((w) => w !== winId && winVisible[w]).length;
      if (others > 0) {
        if (zone.side === "bottom") {
          r = { ...r, width: r.width / 2, left: zone.index === 0 ? r.left : r.left + r.width / 2 };
        } else {
          r = { ...r, height: r.height / 2, top: zone.index === 0 ? r.top : r.top + r.height / 2 };
        }
      }
      return r;
    }
    function onMove(ev) {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
      dragging = true;
      setDockPreview(previewRect(zoneFor(ev)));
    }
    function onUp(ev) {
      if (dragging) {
        const zone = zoneFor(ev);
        moveWindow(winId, zone.side, zone.index);
      }
      setDockPreview(null);
      try {
        target.releasePointerCapture(pointerId);
      } catch (_) {}
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  // Folder labels typed in the label frontmatter: anything containing "/" is a
  // folder path ("cs229/" → folder cs229, "cs229/hw" → its subfolder). Unlike
  // category labels there is no draft/commit cycle — writes go straight to
  // properties.folder with the same refinement rule as addPagesToFolder.
  function addPageFolderTag(raw) {
    const path = cleanFolderPath(raw);
    if (!path || !focusedBlockId || readOnly || pageFolders.includes(path)) return;
    const next = addFolderTag(pageFolders, path);
    setPageFolders(next);
    updateExtraFolders((prev) => prev.filter((f) => f !== path));
    writePageFolders(focusedBlockId, next).then(() => fetchHomeBlocks()).catch(() => {});
  }

  function removePageFolderTag(path) {
    if (!focusedBlockId || readOnly) return;
    const next = pageFolders.filter((t) => t !== path);
    if (next.length === pageFolders.length) return;
    setPageFolders(next);
    writePageFolders(focusedBlockId, next).then(() => fetchHomeBlocks()).catch(() => {});
  }

  function addCategoryTag(tag) {
    if (!tag.trim()) return;
    setCategory((prev) => {
      const tags = prev
        ? prev
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
      if (!tags.includes(tag.trim())) tags.push(tag.trim());
      return tags.join(",");
    });
  }

  function removeCategoryTag(index) {
    setCategory((prev) => {
      const tags = prev
        ? prev
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
      if (index < 0) tags.pop();
      else tags.splice(index, 1);
      return tags.join(",");
    });
  }

  function commitAndCloseCategory() {
    const input = categoryInput.trim();
    if (input.includes("/")) addPageFolderTag(input);
    const finalCategory = (() => {
      const tags = category ? category.split(",").map(t => t.trim()).filter(Boolean) : [];
      if (input && !input.includes("/") && !tags.includes(input)) tags.push(input);
      return tags.join(",");
    })();
    setCategory(finalCategory);
    setCategoryInput("");
    setCategoryEditing(false);
    saveCategory(finalCategory);
  }

  async function saveCategory(newValue) {
    if (!focusedBlockId || readOnly) return;
    try {
      await apiJson(`${API}/blocks/${focusedBlockId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { category: newValue || "" } }),
      });
      // Refresh home blocks so the category carousel updates
      fetchHomeBlocks();
    } catch (err) {
      setStatus(`Category save failed: ${err.message}`);
    }
  }

  async function fetchShareLink() {
    if (!pdfUrl || readOnly) return;
    try {
      const data = await apiJson(`${API}/share/${docId}`, {
        method: "POST",
        credentials: "include",
      });
      setShareUrl(`${window.location.origin}${window.location.pathname}?share=${data.token}`);
      resetShareCopied();
    } catch (err) {
      setStatus(`Share failed: ${err.message}`);
    }
  }

  async function copyShareLink() {
    if (await copyText(shareUrl)) flashShareCopied();
    else setStatus("Copy failed — copy the link manually.");
  }

  // Download the current page as Markdown. The server returns a bare .md, or a
  // .zip (page + assets/) when the page references uploaded files — we save
  // whichever comes back, taking the filename from Content-Disposition. Using
  // fetch+blob (not a plain navigation) so a 404/401 surfaces as a message
  // instead of silently swapping the SPA for an error page.
  async function downloadExport(path, fallbackName, options = {}) {
    const { transferId = null, status = "Exporting page…" } = options;
    setStatus(status);
    // Shared (read-only) views: every export carries the scoped share token, so
    // the backend confines it to this document — applied here so no call site
    // can forget it.
    const shareQ = shareTokenQuery();
    if (shareQ && !path.includes("share=")) path += (path.includes("?") ? "&" : "?") + shareQ;
    try {
      const res = await fetch(`${API}${path}`, { credentials: "include" });
      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.json()).detail || "";
        } catch {
          /* not JSON */
        }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      const ctype = res.headers.get("Content-Type") || "";
      // If the SPA fallback served index.html, the export route isn't live yet.
      if (ctype.includes("text/html"))
        throw new Error("export route not found — restart the backend");
      if (transferId) updateTransfer(transferId, { info: "downloading…" });
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const plain = /filename="?([^";]+)"?/i.exec(cd);
      const filename = star ? decodeURIComponent(star[1]) : plain ? plain[1] : fallbackName;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      if (transferId) updateTransfer(transferId, { status: "done", info: fmtBytes(blob.size) });
      setStatus(`Exported ${filename}`);
      return filename;
    } catch (err) {
      if (transferId) {
        updateTransfer(transferId, {
          status: "error",
          info: String(err.message || err).slice(0, 60),
        });
      }
      setStatus(`Export failed: ${err.message}`);
      return null;
    }
  }

  async function downloadFolderExport(path, fallbackName, folderName) {
    const operation = makeId();
    const transferId = addTransfer({
      name: `Export folder — ${folderName}`.slice(0, 60),
      kind: "download",
      info: "preparing…",
    });
    path += `${path.includes("?") ? "&" : "?"}op=${encodeURIComponent(operation)}`;
    let finished = false;
    const poll = setInterval(async () => {
      try {
        const progress = await apiJson(
          `${API}/folders/export-progress?op=${encodeURIComponent(operation)}`,
        );
        if (!finished && progress.active && progress.total) {
          const percent = Math.min(99, Math.floor((progress.done / progress.total) * 100));
          const info = `${progress.done}/${progress.total} papers · ${percent}%`;
          updateTransfer(transferId, { info });
          setStatus(`Exporting “${folderName}” — ${info}…`);
        }
      } catch {
        // Progress is best-effort; the download request remains authoritative.
      }
    }, 500);
    try {
      return await downloadExport(path, fallbackName, {
        transferId,
        status: `Preparing “${folderName}” export…`,
      });
    } finally {
      finished = true;
      clearInterval(poll);
    }
  }

  // Shared (read-only) view — exports and asset fetches carry the scoped share
  // token (?share=), which the backend validates and confines to this document.
  const shareOwnerRef = useRef("");
  const shareTokenRef = useRef("");
  const shareTokenQuery = () =>
    readOnly && shareTokenRef.current ? `share=${encodeURIComponent(shareTokenRef.current)}` : "";

  // Run what the import dialog was configured to do. Logseq needs files, so
  // its button opens the picker and the import starts once they're chosen.
  function runImport(o) {
    setImportOpen(false);
    if (o.source === "annots") {
      if (!docId || !focusedBlockId) { setStatus("Open a PDF first."); return; }
      importEmbeddedAnnots(focusedBlockId, docId, false, o.strip);
      return;
    }
    if (o.source === "gamma") {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".zip,application/zip";
      inp.onchange = () => {
        if (inp.files?.[0]) runBackupImport(inp.files[0], "merge");
      };
      inp.click();
      return;
    }
    if (o.source === "zotero") {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".zip,application/zip";
      inp.onchange = () => { if (inp.files?.[0]) importZotero(inp.files[0], o.strip); };
      inp.click();
      return;
    }
    const inp = document.createElement("input");
    inp.type = "file";
    inp.multiple = true;
    inp.accept = ".pdf,.edn,.md";
    inp.onchange = () => { if (inp.files?.length) importLogseq(inp.files); };
    inp.click();
  }

  // Run what the export dialog was configured to do. Every format is one
  // endpoint with flags, except a PDF with both switches off — that is the
  // stored file itself, which the raw path serves without a round trip (and
  // works for PDFs that only exist behind the proxy).
  async function runExport(o) {
    setExportOpen(false);
    const flags = `highlights=${o.highlights ? 1 : 0}&notes=${o.notes ? 1 : 0}`;
    const bundle = `pdf=${o.bundle ? 1 : 0}`;
    if (exportFolder) {
      const base = `/folders/export?name=${encodeURIComponent(exportFolder)}`;
      if (o.format === "logseq") {
        await downloadFolderExport(
          `${base}&mode=logseq-graph&${bundle}`,
          "graph.zip",
          exportFolder,
        );
      } else if (o.format === "gamma") {
        const saved = await downloadFolderExport(
          `${base}&mode=gamma`,
          "gamma.zip",
          exportFolder,
        );
        if (saved) setStatus("Gamma export saved — import it into another Gamma to merge missing data.");
      } else if (o.format === "zotero") {
        const saved = await downloadFolderExport(
          `${base}&mode=zotero-rdf&${flags}&${bundle}`,
          "zotero.zip",
          exportFolder,
        );
        if (saved) setStatus("Zotero library saved — unzip it, then import the .rdf file in Zotero.");
      } else if (o.format === "notespdf") {
        await downloadFolderExport(
          `${base}&mode=notes-pdf&${flags}`,
          "notes.pdf",
          exportFolder,
        );
      } else {
        await downloadFolderExport(
          `${base}&mode=readable&${flags}&${bundle}`,
          "folder.zip",
          exportFolder,
        );
      }
      return;
    }
    const id = focusedBlock?.id;
    if (!id) { setStatus("Open a page first to export it."); return; }
    if (o.format === "pdf") {
      if (!o.highlights && !o.notes) { await exportRawPdf(); return; }
      await downloadExport(`/pages/${id}/export-pdf?${flags}`, "export.pdf");
      return;
    }
    if (o.format === "notespdf") {
      // The notes as their own PDF — no paper needed, so this works on note
      // pages too (where the annotated-PDF format isn't offered).
      await downloadExport(`/pages/${id}/export?mode=notes-pdf&${flags}`, "notes.pdf");
      return;
    }
    if (o.format === "logseq") {
      await downloadExport(`/pages/${id}/export?mode=logseq-graph&${bundle}`, "graph.zip");
      return;
    }
    if (o.format === "gamma") {
      const saved = await downloadExport(
        `/pages/${id}/export?mode=gamma`,
        "gamma.zip",
      );
      if (saved) setStatus("Gamma export saved — import it into another Gamma to merge missing data.");
      return;
    }
    if (o.format === "zotero") {
      const saved = await downloadExport(
        `/pages/${id}/export?mode=zotero-rdf&${flags}&${bundle}`,
        "zotero.zip",
      );
      if (saved) setStatus("Zotero export saved — unzip it, then import the .rdf file in Zotero.");
      return;
    }
    await downloadExport(`/pages/${id}/export?mode=readable&${flags}&${bundle}`, "page.md");
  }

  // Download the PDF exactly as stored — no highlight annotations. Reuses the
  // viewer's own URL (uploads route or /pdf proxy), so it works in share views.
  async function exportRawPdf() {
    if (!pdfUrl) {
      setStatus("No PDF open.");
      return;
    }
    setOpenPopover(null);
    const path = pdfUrl.startsWith(API) ? pdfUrl.slice(API.length) : pdfUrl;
    const name = `${(pdfTitle || docId || "paper").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.pdf`;
    await downloadExport(path, name);
  }

  // Preserve the folder menu's one-click Markdown export alongside Export as….
  async function quickExportFolder(name) {
    if (!name) return;
    setHomeMenu(null);
    await downloadFolderExport(
      `/folders/export?name=${encodeURIComponent(name)}`,
      "folder.zip",
      name,
    );
  }

  // Ask the AI for the document's title and fill it into the page name.
  const [aiTitleBusy, setAiTitleBusy] = useState(false);
  const [sourceDraft, setSourceDraft] = useState(""); // edit buffer for the source-PDF popover
  async function aiFillTitle() {
    if (!docId || readOnly || aiTitleBusy) return;
    setAiTitleBusy(true);
    setStatus("Asking AI for the title…");
    const taskId = addTransfer({
      name: `AI title — ${(pdfTitle || "paper").slice(0, 48)}`,
      kind: "ai",
      info: "asking…",
    });
    try {
      const data = await apiJson(`${API}/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt:
            "Extract the exact title of this document. Reply with ONLY the title text — no quotes, no authors, no extra words.",
          doc_id: docId,
          history: [],
          model: chatSendModel || "",
        }),
      });
      const title = (data.response || "")
        .trim()
        .replace(/^["'\s]+|["'\s]+$/g, "")
        .split("\n")[0]
        .slice(0, 200);
      updateTransfer(taskId, { status: title ? "done" : "error", info: title ? "" : "no title" });
      if (title) {
        await renameTitle(title);
        setStatus("Title filled in by AI.");
      } else {
        setStatus("AI returned no title.");
      }
    } catch (err) {
      updateTransfer(taskId, { status: "error", info: (err.message || "failed").slice(0, 60) });
      setStatus(`AI title failed: ${err.message}`);
    } finally {
      setAiTitleBusy(false);
    }
  }

  function addHighlight(highlight) {
    if (readOnly) return;
    const withId = { ...highlight, id: highlight.id || makeId() };
    let nextBlocks = addHighlightAsBlock(blocks, withId);
    // Open the new block immediately so the user can type the note without
    // an extra click. addHighlightAsBlock appends at the top level.
    nextBlocks = nextBlocks.map((b) => (b.id === withId.id ? { ...b, editMode: true } : b));
    pendingFocusRef.current = withId.id;
    pendingBlockScrollRef.current = withId.id;
    setBlocks(nextBlocks);
    // autosave effect will persist
    setStatus("Highlight saved.");
  }

  useEffect(() => {
    attachModeBlockIdRef.current = attachModeBlockId;
  }, [attachModeBlockId]);

  // Escape cancels attach mode
  useEffect(() => {
    if (!attachModeBlockId) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        setAttachModeBlockId(null);
        setAttachContextMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [attachModeBlockId]);

  async function linkHighlightToBlock(blockId, highlight) {
    // Store a pointer to the existing highlight's id, NOT a copy of its position.
    // Copying the position would create a duplicate visual highlight on the PDF at the same spot.
    // The jump logic resolves linked_highlight_id → scrolls to the real highlight.
    await fetch(`/api/blocks/${blockId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: {
          linked_highlight_id: highlight.id,
          pdf_page: highlight.position.pageNumber,
        },
      }),
    });
    await loadBlocksForBlock(focusedBlockId);
    setAttachModeBlockId(null);
    setAttachContextMenu(null);
  }

  async function unlinkHighlightFromBlock(blockId) {
    await fetch(`/api/blocks/${blockId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: {
          linked_highlight_id: null,
        },
      }),
    });
    await loadBlocksForBlock(focusedBlockId);
  }

  // (Re)entering the Assistant pane rebuilds the prompt drafts from the saved
  // values — switching away without saving is the cancel path.
  useEffect(() => {
    if (settingsOpen !== "prompts" && settingsOpen !== "assistant") return;
    setPromptDraft(chatSystem || aiInfo?.default_prompt || "");
    setMetaPromptDraft(metaPrompt || aiInfo?.metadata_prompt || "");
    setCitePromptDraft(citePrompt || aiInfo?.cite_prompt || "");
    setAgentPromptDraft(agentSystem || aiInfo?.agent_prompt || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated on pane open; prompts are read as initial values
  }, [settingsOpen]);

  // --- reference links: PDF text regions manually linked to papers ----------

  // Match a URL against the library: DOI or arXiv id already known → that page.
  // Any document link (PDF annotation or manual reference link): if the target
  // paper is already in the library, open it; otherwise ask fetch-vs-browser.
  function handleDocLink(url) {
    const pid = findPageForUrl(url, homeBlocks);
    if (pid) {
      setStatus("Already in your library — opening.");
      openBlock(pid, { pushNav: true });
      return;
    }
    setLinkPrompt(url);
  }

  // Rank a library paper against the selected reference text: author surnames
  // and identifiers weigh most, then title words, year, volume, venue.
  function createLinkHighlight(target) {
    const ld = linkDialog;
    if (!ld) return;
    setLinkDialog(null);
    setLinkDialogInput("");
    if (ld.editBlockId) {
      // Re-pointing (or clearing) the link on an existing highlight block
      setBlocks(
        updateBlockTree(blocks, ld.editBlockId, (b) => ({
          ...b,
          properties: {
            ...b.properties,
            link_url: target.url || "",
            link_page_id: target.pageId || "",
            link_highlight_id: target.highlightId || "",
          },
        })),
      );
      setStatus(target.url || target.pageId ? "Link updated." : "Link removed.");
      return;
    }
    const id = makeId();
    let next = addHighlightAsBlock(blocks, {
      id,
      content: ld.content || { text: "" },
      position: ld.position,
      comment: { text: "" },
      color: "rgba(140, 180, 255, 0.35)",
    });
    next = updateBlockTree(next, id, (b) => ({
      ...b,
      properties: {
        ...b.properties,
        link_url: target.url || "",
        link_page_id: target.pageId || "",
        link_highlight_id: target.highlightId || "",
      },
    }));
    setBlocks(next); // autosave persists
    setStatus("Reference linked.");
  }

  // Zoom in/out steps to the next multiple of 20%, anchored on the current
  // effective scale (so it also works from fit-width, e.g. 87% → 100%).
  function zoomStep(dir) {
    const cur = Math.round(pdfEffScale * 100);
    const next = dir > 0 ? (Math.floor(cur / 20) + 1) * 20 : (Math.ceil(cur / 20) - 1) * 20;
    zoomTo(next / 100);
  }
  // Every zoom change goes through here — buttons, Ctrl+scroll, fit-width —
  // so applying the scale and announcing it can't come apart.
  function zoomTo(next) {
    if (next === "page-width") {
      setPdfScale("page-width");
      postPill("pdf-zoom", { msg: "Fit to width", final: true });
      return;
    }
    const s = clampZoom(next);
    setPdfScale(String(Math.round(s * 10000) / 10000));
    postPill("pdf-zoom", { msg: `Zoom ${Math.round(s * 100)}%`, final: true });
  }

  function jumpToHighlightId(highlightId, additive) {
    if (pdfHidden) {
      pendingJumpRef.current = highlightId;
      setPdfHidden(false);
      return;
    }
    // Try own highlight first
    const target = highlights.find((h) => h.id === highlightId);
    if (target) {
      // Pass {position} directly rather than the full highlight object so
      // react-pdf-highlighter always uses the position data, not a potentially
      // stale internal id lookup.
      scrollToRef.current({ position: target.position });
      triggerFlash(highlightId);
      // Same chat effect as clicking the highlight on the PDF itself.
      addHighlightToChat(target, additive);
      return;
    }
    const block = flattenBlocks(blocks).find((b) => b.properties?.highlight_id === highlightId);
    // Block was linked to an existing highlight via attach mode
    const linkedId = block?.properties?.linked_highlight_id;
    if (linkedId) {
      const linkedTarget = highlights.find((h) => h.id === linkedId);
      if (linkedTarget) {
        scrollToRef.current({ position: linkedTarget.position });
        triggerFlash(linkedId);
        addHighlightToChat(linkedTarget, additive);
        return;
      }
    }
    // Fallback: page-level jump
    const page = block?.properties?.pdf_page;
    if (page) {
      scrollToRef.current({
        position: {
          pageNumber: page,
          boundingRect: { x1: 0, y1: 0, x2: 0, y2: 0, width: 1, height: 1, pageNumber: page },
          rects: [],
        },
      });
    }
  }

  const visibleBlocks = useMemo(() => flattenBlocks(blocks), [blocks]);
  const homeMode = !pdfUrl && !focusedBlockId && !readOnly;
  // Leaving home or changing folders drops the file-manager selection.
  useEffect(() => {
    clearSelection();
    setHomeMenu(null);
  }, [folderFilter, categoryFilter, homeMode]);
  const pageOnly = !pdfUrl && !!focusedBlockId && !readOnly;
  // Phone: navigating to another page (or home) closes any overlay panel.
  useEffect(() => {
    setPhonePanel(null);
  }, [focusedBlockId, homeMode]);
  // Phone: leaving the notes overlay records the panel position right away
  // (the panel stays mounted, so the scroll values are still readable), so
  // the cross-device sync push starts immediately instead of waiting for the
  // next page switch or unload.
  useEffect(() => {
    if (isPhone && phonePanel !== "notes") captureScrollPosRef.current();
  }, [isPhone, phonePanel]);
  const pageBlocks = useMemo(() => {
    return homeBlocks.map((b) => ({
      id: b.id,
      content: b.content || "Untitled",
      children: [],
      collapsed: false,
      properties: { quote: b.properties?.summary || "" },
      _pageId: b.id,
      _position: b.position,
      _sourceUrl: b.properties?.source_url,
      _folders: parseFolderTags(b.properties?.folder),
      _labels: parseFolderTags(b.properties?.category),
      _createdAt: b.created_at || "",
      _updatedAt: b.updated_at || "",
      _pinned: b.properties?.pinned || "",
      _isEmpty: !b.content,
      editMode: homeEditingId === b.id,
    }));
  }, [homeBlocks, homeEditingId]);
  // Folders shown at the current level: the next path segment of every known
  // path under folderFilter ("" = root → top-level segments).
  const childFolders = useMemo(() => {
    const set = new Set();
    for (const fp of allFolderPaths) {
      if (folderFilter) {
        if (!fp.startsWith(folderFilter + "/")) continue;
        set.add(`${folderFilter}/${fp.slice(folderFilter.length + 1).split("/")[0]}`);
      } else {
        set.add(fp.split("/")[0]);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [allFolderPaths, folderFilter]);
  // Device-local view history as a lookup ({pageId → ISO time}, capped at 24
  // entries) — feeds the "Recently viewed" sort; unviewed pages have no entry.
  const viewedAtById = useMemo(() => new Map(recentViews.map((r) => [r.id, r.at])), [recentViews]);
  // Per-folder rollup: page count + latest contained-page timestamps, so
  // folders can sort on the same criteria as files. Computed for EVERY known
  // path, not just the level on screen — the context menu's folder flyout
  // sorts the whole library by the same clock.
  const folderMeta = useMemo(() => {
    const m = {};
    for (const f of allFolderPaths) {
      let count = 0, updated = "", created = "", viewed = "";
      for (const b of pageBlocks) {
        if (!b._folders.some((t) => t === f || t.startsWith(f + "/"))) continue;
        count++;
        if (b._updatedAt > updated) updated = b._updatedAt;
        if (b._createdAt > created) created = b._createdAt;
        const v = viewedAtById.get(b._pageId) || "";
        if (v > viewed) viewed = v;
      }
      m[f] = { count, updated, created, viewed };
    }
    return m;
  }, [allFolderPaths, pageBlocks, viewedAtById]);
  // Folder order for the context menu's "Move to folder" flyout: every known
  // path, ranked by the same clock the library listing is sorted by, so the
  // folder you were last working in sits right under the cursor. Title A–Z
  // keeps the alphabetical order allFolderPaths already has.
  const folderMenuPaths = useMemo(() => {
    if (homeSort === "title") return allFolderPaths;
    const key = homeSort === "created" ? "created" : homeSort === "viewed" ? "viewed" : "updated";
    const stamp = (f) => (key === "viewed" ? (folderMeta[f]?.viewed || folderMeta[f]?.updated) : folderMeta[f]?.[key]) || "";
    return [...allFolderPaths].sort((a, b) => stamp(b).localeCompare(stamp(a)) || a.localeCompare(b));
  }, [allFolderPaths, folderMeta, homeSort]);
  // The pages this view is about: inside a folder its members, at root every
  // page (the library-wide recents feed). Both the label rollup and the
  // listing below start from this set.
  const scopePages = useMemo(
    () => (folderFilter ? pageBlocks.filter((b) => b._folders.includes(folderFilter)) : pageBlocks),
    [pageBlocks, folderFilter]
  );
  // Per-label rollup over the pages in scope — the flat mirror of folderMeta,
  // so label tiles sort and count exactly like folder tiles.
  const labelMeta = useMemo(() => {
    const m = {};
    for (const b of scopePages) {
      const v = viewedAtById.get(b._pageId) || "";
      for (const l of new Set(b._labels)) {
        const meta = (m[l] ||= { count: 0, updated: "", created: "", viewed: "" });
        meta.count++;
        if (b._updatedAt > meta.updated) meta.updated = b._updatedAt;
        if (b._createdAt > meta.created) meta.created = b._createdAt;
        if (v > meta.viewed) meta.viewed = v;
      }
    }
    return m;
  }, [scopePages, viewedAtById]);
  const scopeLabels = useMemo(() => Object.keys(labelMeta).sort((a, b) => a.localeCompare(b)), [labelMeta]);
  // What the home list shows: containers and files as ONE sorted listing —
  // inside a folder → its subfolders + pages tagged exactly that path; at
  // root → top-level folders + EVERY page as a recents feed, loaded
  // incrementally; in "labels" mode → the labels in scope instead of folders
  // and files; inside a label → that label's pages only. Date sorts rank a
  // container by its most recent content; an empty folder has no timestamps
  // and sinks to the bottom. The search box doesn't drop anything: matches are
  // floated to the top of the sort and the rest are flagged for dimming.
  const homeItems = useMemo(() => {
    const labelMode = !categoryFilter && homeKinds === "labels";
    const items = categoryFilter || homeKinds === "files" || labelMode ? [] : childFolders.map((f) => ({
      kind: "folder", key: `folder:${f}`, folder: f,
      _title: f.slice(f.lastIndexOf("/") + 1),
      _updatedAt: folderMeta[f]?.updated || "", _createdAt: folderMeta[f]?.created || "",
      _viewedAt: folderMeta[f]?.viewed || "",
    }));
    if (labelMode) {
      for (const l of scopeLabels) {
        items.push({
          kind: "label", key: `label:${l}`, label: l, _title: l,
          _updatedAt: labelMeta[l].updated, _createdAt: labelMeta[l].created,
          _viewedAt: labelMeta[l].viewed,
        });
      }
    }
    const pages = categoryFilter ? scopePages.filter((b) => b._labels.includes(categoryFilter))
      : homeKinds === "folders" || labelMode ? []
      : scopePages;
    for (const b of pages) {
      items.push({
        kind: "page", key: b._pageId, block: b, _title: b.content,
        _updatedAt: b._updatedAt, _createdAt: b._createdAt,
        _viewedAt: viewedAtById.get(b._pageId) || "",
      });
    }
    // "viewed" falls back to modified time so the never-viewed tail (the view
    // history keeps only the last 24 opens) still has a sensible order.
    const cmp = homeSort === "title" ? (a, b) => a._title.localeCompare(b._title)
      : homeSort === "created" ? (a, b) => (b._createdAt || "").localeCompare(a._createdAt || "")
      : homeSort === "viewed" ? (a, b) => ((b._viewedAt || "").localeCompare(a._viewedAt || "") || (b._updatedAt || "").localeCompare(a._updatedAt || ""))
      : (a, b) => (b._updatedAt || "").localeCompare(a._updatedAt || "");
    items.sort(cmp);
    const match = makeFindMatcher(homeQuery);
    if (!match) return items;
    // A page also matches on its chips, so "cs229" surfaces its papers.
    for (const it of items) {
      it._match = match(it.kind === "page"
        ? [it._title, ...(it.block._folders || []), ...(it.block._labels || [])].join(" ")
        : it._title);
    }
    return [...items.filter((it) => it._match), ...items.filter((it) => !it._match)];
  }, [scopePages, categoryFilter, childFolders, folderMeta, scopeLabels, labelMeta, viewedAtById, homeSort, homeKinds, homeQuery]);
  const homeVisibleItems = useMemo(() => homeItems.slice(0, homeShowCount), [homeItems, homeShowCount]);
  // "New folder" leads the listing wherever folders are listed — not inside a
  // label view or with the listing filtered to files or labels.
  const newFolderAllowed = !categoryFilter && homeKinds !== "files" && homeKinds !== "labels";
  // What an empty listing says — the view it is empty for, not the library.
  const homeEmptyText = categoryFilter
    ? `Nothing is labelled “${categoryFilter}” here — drop a paper on a label to add it.`
    : homeKinds === "labels"
      ? (folderFilter ? "No labels on the papers in this folder yet." : "No labels yet — add one from a paper’s label field.")
      : folderFilter ? "This folder is empty — drag papers onto it from the library."
        : "No pages yet — use the + button above to open a PDF or start a note page.";
  // Timestamp shown on a library card follows the active sort: sorted by view
  // time → viewed (falling back to modified, same as the sort), by added →
  // created; modified otherwise (incl. Title A–Z).
  const cardTime = (item) => formatRelativeTime(
    homeSort === "viewed" ? (item._viewedAt || item._updatedAt)
      : homeSort === "created" ? item._createdAt
      : item._updatedAt
  );
  // Page-shaped view of the visible slice (shift-range selection, BlockTree).
  const homeVisiblePages = useMemo(
    () => homeVisibleItems.filter((it) => it.kind === "page").map((it) => it.block),
    [homeVisibleItems]
  );
  // Pinned papers — shown as a favorites strip at the library root. Most
  // recently pinned first.
  const pinnedPages = useMemo(
    () =>
      pageBlocks
        .filter((b) => b._pinned)
        .sort((a, b) => (b._pinned || "").localeCompare(a._pinned || "")),
    [pageBlocks],
  );
  // Recently-viewed pages that still exist, most recent first (top shortcut bar).
  const recentViewedPages = useMemo(() => {
    const byId = new Map(pageBlocks.map((b) => [b._pageId, b]));
    return recentViews
      .map((r) => {
        const b = byId.get(r.id);
        return b ? { ...b, _viewedAt: r.at } : null;
      })
      .filter(Boolean)
      .slice(0, 12);
  }, [recentViews, pageBlocks]);
  // Home keyboard: Esc clears the selection, Enter opens the single selected
  // item — the standard file-manager shortcuts.
  useEffect(() => {
    if (!homeMode) return;
    function onKey(e) {
      if (e.target.closest && e.target.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape" && (selectedPages.size || selectedFolders.size || selectedLabels.size)) {
        clearSelection();
      } else if (isEnterCommit(e)) {
        if (selectedLabels.size === 1) openLabel([...selectedLabels][0]);
        else if (selectedFolders.size === 1) openFolder([...selectedFolders][0]);
        else if (selectedPages.size === 1) openPage([...selectedPages][0]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- openFolder/openLabel/openPage are unstable handlers; keys on mode/selection
  }, [homeMode, selectedPages, selectedFolders, selectedLabels]);
  // Scrolling the "load more" sentinel into view grows the feed.
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setHomeShowCount((c) => c + HOME_PAGE_CHUNK);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [homeVisibleItems.length, homeItems.length, homeMode]);
  // Identity-stable: every keystroke in a note replaces `blocks`, but the
  // derived highlights rarely change — returning the previous array when the
  // content is identical keeps the viewer's per-page memo effective (otherwise
  // each keystroke re-rendered every PdfPage's overlays).
  const prevHighlightsRef = useRef({ json: "", value: [] });
  const highlights = useMemo(() => {
    const byHlId = new Map();
    for (const b of visibleBlocks) {
      if (b.properties?.highlight_id) byHlId.set(b.properties.highlight_id, b);
    }
    const next = blocksToHighlights(blocks).map((h) => {
      const p = byHlId.get(h.id)?.properties || {};
      const url = p.link_url || "";
      const pageId = p.link_page_id || "";
      return url || pageId
        ? { ...h, linkTarget: { url, pageId, highlightId: p.link_highlight_id || "" } }
        : h;
    });
    const json = JSON.stringify(next);
    if (json === prevHighlightsRef.current.json) return prevHighlightsRef.current.value;
    prevHighlightsRef.current = { json, value: next };
    return next;
  }, [blocks, visibleBlocks]);
  const highlightColors = useMemo(
    () => Object.fromEntries(highlights.map((h) => [h.id, h.color])),
    [highlights],
  );
  useEffect(() => {
    if (pdfHidden) return;
    const id = pendingJumpRef.current;
    if (!id) return;
    let tries = 0;
    const attempt = () => {
      if (pendingJumpRef.current !== id) return; // superseded
      // Cross-paper jumps: the target page's blocks (and thus highlights)
      // load before its document swaps in — wait for the right document so
      // the jump isn't applied to the outgoing one.
      if (pdfUrl && pdfRenderedUrlRef.current !== pdfUrl && tries++ < 80) {
        setTimeout(attempt, 100);
        return;
      }
      let scrollTarget = (highlights || []).find((x) => x.id === id);
      if (!scrollTarget) {
        // Accept a block id too (reference-point deep links use them)
        const b = flattenBlocks(blocks).find(
          (b) => b.properties?.highlight_id === id || b.id === id,
        );
        const hlId = b?.properties?.linked_highlight_id || b?.properties?.highlight_id;
        if (hlId) scrollTarget = (highlights || []).find((x) => x.id === hlId);
      }
      if (scrollTarget && scrollToRef.current) {
        scrollToRef.current({ position: scrollTarget.position });
        triggerFlash(scrollTarget.id);
      }
      pendingJumpRef.current = null;
    };
    setTimeout(attempt, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- blocks/pdfUrl are read for the jump target; pdfHidden/highlights trigger
  }, [pdfHidden, highlights]);

  // Jump to the last-read page when a document opens.
  // Position comes from the account-synced per-paper map (read-pos pref),
  // falling back to the legacy per-browser session slot only when it belongs
  // to this page. Waits until this document's pages are rendered (however
  // long that takes), then scrolls and holds the target until the layout
  // stops shifting under it.
  useEffect(() => {
    coarseRestorePendingRef.current = false;
    if (pdfHidden || !pdfUrl) return;
    if (restoredPdfUrlRef.current === pdfUrl) {
      dbg("restore: already done for this doc");
      return;
    }
    const fid = focusedBlockIdRef.current;
    // Tab switches restore an exact per-page position (tabScrollRef) — the
    // coarse last-read page is only for (re)opening a paper cold.
    if (tabScrollRef.current[fid]) {
      dbg("restore: exact tab position exists for", fid);
      return;
    }
    dbg("restore: waiting for doc;", fid, "entry:", readPosRef.current[fid] || null);
    const sess = loadSession();
    const sessSaved = fid && sess.focusedBlockId === fid ? sess.pdfPageNumber : 0;
    coarseRestorePendingRef.current = true;
    let cancelled = false;
    let tries = 0;
    const done = () => {
      coarseRestorePendingRef.current = false;
    };
    const tryRestore = () => {
      if (cancelled) return;
      // Wait — uncounted — until THIS document's pages are in the DOM. No
      // fixed budget: a big PDF on a slow load outlives any, and giving up
      // would unfreeze the scroll tracker at the top of the document, which
      // then records page 1 over the saved entry. Waiting is safe:
      // navigation cancels the loop (effect cleanup), an old document's
      // pages never match pdfUrl, and the tracker can't record anything
      // while coarseRestorePendingRef holds it paused.
      if (!scrollToRef.current || pdfRenderedUrlRef.current !== pdfUrl) {
        setTimeout(tryRestore, 100);
        return;
      }
      // The synced map may still be in flight (fresh browser, or a cache
      // holding this browser's OLDER position) — give the first server
      // response a bounded settle window (its catch sets the flag, so this
      // only rides out a slow response, not a dead server).
      if (!readPosLoadedRef.current && tries++ < 30) {
        setTimeout(tryRestore, 100);
        return;
      }
      const entry = fid ? readPosRef.current[fid] : null;
      const saved = entry?.page || sessSaved;
      if (!saved || saved <= 1) {
        dbg("restore: nothing to restore (saved page", saved, ")");
        done();
        return;
      }
      dbg("restore: doc rendered, scrolling to page", saved);
      restoredPdfUrlRef.current = pdfUrl;
      const pos = {
        pageNumber: saved,
        boundingRect: { x1: 0, y1: 0, x2: 1, y2: 1, width: 1, height: 1, pageNumber: saved },
        rects: [],
      };
      // A single scrollTo cannot be trusted on a cold load — it may be
      // computed before the fit-width scale applies, and late page-height
      // measurements shift the layout under the set scrollTop, either of
      // which leaves the viewport a page off. So verify against the live
      // DOM: the target page's top must sit at the viewport top (+80px, the
      // viewer's own jump offset), re-asserting until that holds for two
      // ticks. Real user input (wheel/touch/scrollbar grab) hands control
      // over instead of being fought, and the tracker stays paused until
      // done(), so no transient position is ever recorded.
      let stable = 0,
        settleTries = 0,
        userTookOver = false,
        inputEl = null;
      const INPUT_EVS = ["wheel", "touchstart", "mousedown"];
      const onUserInput = () => {
        userTookOver = true;
      };
      const unhookInput = () => {
        if (inputEl) for (const ev of INPUT_EVS) inputEl.removeEventListener(ev, onUserInput);
        inputEl = null;
      };
      const settle = () => {
        if (cancelled) {
          unhookInput();
          return;
        }
        const scroller = viewerWrapRef.current?.querySelector(".pdfViewer");
        if (!scroller || settleTries++ > 60) {
          unhookInput();
          done();
          return;
        }
        if (userTookOver) {
          dbg("restore: user took over during settle");
          unhookInput();
          done();
          return;
        }
        if (inputEl !== scroller) {
          unhookInput();
          inputEl = scroller;
          for (const ev of INPUT_EVS) inputEl.addEventListener(ev, onUserInput, { passive: true });
        }
        const pageEl = scroller.querySelector(`[data-page="${saved}"]`);
        const off = pageEl
          ? pageEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top
          : null;
        // A page near the end of the document can't reach the viewport top —
        // the clamped bottom-of-document position is as good as it gets.
        const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
        const aligned = off != null && (Math.abs(off - 80) <= 150 || (atEnd && off <= 80));
        if (aligned) {
          if (++stable >= 2) {
            dbg("restore: settled at page", saved);
            unhookInput();
            done();
            return;
          }
        } else {
          stable = 0;
          // "auto" = instant. The default smooth animation for short jumps
          // is interruptible by cold-load render work, which would strand
          // the viewport short of the target.
          scrollToRef.current({ position: pos, behavior: "auto" });
        }
        setTimeout(settle, 150);
      };
      settle();
    };
    tryRestore();
    return () => {
      cancelled = true;
      done();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dbg is an unstable helper; restore keys on pdfUrl/pdfHidden
  }, [pdfUrl, pdfHidden]);

  // Track PDF scroll position — feeds the page indicator and the synced
  // per-paper reading position.
  useEffect(() => {
    if (!pdfUrl || pdfHidden) return;
    let ticking = false;
    function onScroll(e) {
      // Fast bail without any DOM query: the notes/chat panes pass through
      // here too, but only the PDF scroller itself matters.
      const target = e.target;
      if (!(target instanceof Element) || !target.classList.contains("pdfViewer")) return;
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (!target.isConnected) return;
        const pages = target.querySelectorAll("[data-page]");
        if (pages.length === 0) return;
        const cr = target.getBoundingClientRect();
        const midY = cr.top + cr.height / 2;
        for (const el of pages) {
          const r = el.getBoundingClientRect();
          if (r.top <= midY && r.bottom >= midY) {
            const n = parseInt(el.dataset.page);
            // Record via the tracker, not a pdfPageNumber effect: scrolling
            // within a page (or back to a page the state already shows) fires
            // no state change, but must still re-assert this window's
            // position over one pulled from another window.
            if (n) {
              setPdfPageNumber(n);
              recordScrollPageRef.current?.(n);
            }
            break;
          }
        }
      });
    }
    // Capture-phase listener on the document: element scroll events don't
    // bubble, but they do pass document in the capture phase, so this hears
    // the viewer no matter how late its pages mount or how often layout
    // changes remount the scroller. Never attach to the scroller element
    // itself — a slow-loading document outlives any attach-retry budget,
    // and a remount silently drops a per-element listener, ending position
    // tracking for the rest of the session.
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, [pdfUrl, pdfHidden]);

  // Login page state
  if (authUser === null) return <AuthLoading />;

  if (authUser === false) {
    return (
      <LoginPage
        username={loginUser}
        password={loginPass}
        error={loginError}
        onUsernameChange={setLoginUser}
        onPasswordChange={setLoginPass}
        onSubmit={doLogin}
        onGuestLogin={doGuestLogin}
      />
    );
  }

  if (sessionConflict) {
    return (
      <SessionConflictPage
        tabUser={authUser.user}
        activeUser={sessionConflict}
        // Plain pathname: this tab's ?block= belongs to the old account.
        onReload={() => {
          window.location.href = window.location.pathname;
        }}
      />
    );
  }

  // "+ New note" under the block tree (also the whole empty state's action):
  // append an empty top-level note and start editing it.
  function addRootNote() {
    if (readOnly) return;
    const { blocks: next, newId } = addRootBlock(blocks);
    pendingFocusRef.current = newId;
    setBlocks(next);
    setFocusedId(newId);
  }
  const addNoteButton = !homeMode && !readOnly && focusedBlockId ? (
    <button className="addNoteBtn" title="Add a note at the end" onClick={addRootNote}>+ New note</button>
  ) : null;

  // The notes window - docked via notesDock, or filling the center when no PDF is shown.
  const notesWindow = notesVisible ? (
    <div className="sidebar">
      {!homeMode && (
        <div className="pageTitleRow">
          <div className="pageTitleMain">
            {titleEditing && !readOnly && focusedBlockId ? (
              <input
                className="titleEdit"
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => {
                  renameTitle(titleDraft);
                  setTitleEditing(false);
                }}
                onKeyDown={(e) => {
                  if (isEnterCommit(e)) {
                    e.currentTarget.blur();
                  } else if (e.key === "Escape") {
                    setTitleDraft(pdfTitle);
                    setTitleEditing(false);
                  }
                }}
              />
            ) : (
              <h3
                className={!readOnly && focusedBlockId ? "titleText editable" : "titleText"}
                title={!readOnly && focusedBlockId ? "Click to rename" : undefined}
                onClick={() => {
                  if (readOnly || !focusedBlockId) return;
                  setTitleDraft(
                    pdfTitle || (docId ? getPdfPageTitle(docId, inputUrl) : "Untitled"),
                  );
                  setTitleEditing(true);
                }}
              >
                {focusedBlockId
                  ? pdfTitle || (docId ? getPdfPageTitle(docId, inputUrl) : "Untitled")
                  : "PDF Notes"}
              </h3>
            )}
            {focusedBlockId && !readOnly ? (
              <div className="categoryFrontmatter">
                <span className="categoryIcon" title="Labels">
                  <LabelIcon size={13} />
                </span>
                {categoryEditing ? (
                  (() => {
                    const currentTags = category
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean);
                    const q = categoryInput.trim();
                    const ql = q.toLowerCase();
                    const labelSugs = q ? [...new Set(homeBlocks.flatMap(b =>
                      (b.properties?.category || "").split(",").map(t => t.trim()).filter(Boolean)
                    ))].filter(t =>
                      t.toLowerCase().includes(ql) &&
                      !currentTags.includes(t)
                    ).sort() : [];
                    const folderSugs = q ? allFolderPaths.filter(f =>
                      f.toLowerCase().includes(ql) && !pageFolders.includes(f)
                    ).sort() : [];
                    const suggestions = [
                      ...folderSugs.map(v => ({ kind: "folder", value: v })),
                      ...labelSugs.map(v => ({ kind: "label", value: v })),
                    ].slice(0, 8);
                    const pickSuggestion = (s) => {
                      if (s.kind === "folder") addPageFolderTag(s.value); else addCategoryTag(s.value);
                      setCategoryInput("");
                      setCategorySuggestionIdx(-1);
                    };
                    return (
                    <div className="categoryTagInputContainer">
                      <div className="categoryTagInputWrap">
                        {pageFolders.map((f) => (
                          <span key={`f:${f}`} className="categoryTag folderChip" title={`Folder: ${f}`}>
                            <FolderIcon size={10} />
                            {f}
                            <button className="uiClose uiCloseSm categoryTagRemove" tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); removePageFolderTag(f); }}>×</button>
                          </span>
                        ))}
                        {category.split(",").map((t, i) => t.trim() ? (
                          <span key={i} className="categoryTag">
                            {t.trim()}
                            <button className="uiClose uiCloseSm categoryTagRemove" tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); removeCategoryTag(i); }}>×</button>
                          </span>
                        ) : null)}
                        <input
                          className="categoryFrontmatterInput"
                          value={categoryInput}
                          onChange={(e) => {
                            const val = e.target.value;
                            setCategorySuggestionIdx(-1);
                            if (val.includes(",")) {
                              const parts = val.split(",");
                              for (let i = 0; i < parts.length - 1; i++) {
                                const tag = parts[i].trim();
                                if (tag) { if (tag.includes("/")) addPageFolderTag(tag); else addCategoryTag(tag); }
                              }
                              setCategoryInput(parts[parts.length - 1].trimStart());
                            } else {
                              setCategoryInput(val);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "ArrowDown") {
                              e.preventDefault();
                              if (suggestions.length > 0) {
                                setCategorySuggestionIdx(i => Math.min(i + 1, suggestions.length - 1));
                              }
                            } else if (e.key === "ArrowUp") {
                              e.preventDefault();
                              setCategorySuggestionIdx(i => Math.max(i - 1, -1));
                            } else if (isEnterCommit(e) && categorySuggestionIdx >= 0 && categorySuggestionIdx < suggestions.length) {
                              e.preventDefault();
                              pickSuggestion(suggestions[categorySuggestionIdx]);
                            } else if (isEnterCommit(e)) {
                              e.preventDefault();
                              commitAndCloseCategory();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              commitAndCloseCategory();
                            } else if (e.key === "Backspace" && !categoryInput) {
                              removeCategoryTag(-1);
                            }
                          }}
                          onBlur={commitAndCloseCategory}
                          autoFocus
                          placeholder="type to add… (/ = folder)"
                        />
                      </div>
                      {suggestions.length > 0 ? (
                        <div className="categorySuggestions">
                          {suggestions.map((s, i) => (
                            <button key={`${s.kind}:${s.value}`} className={`categorySuggestionItem${s.kind === "folder" ? " categorySuggestionFolder" : ""}${i === categorySuggestionIdx ? " selected" : ""}`}
                              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); pickSuggestion(s); }}
                              onMouseEnter={() => setCategorySuggestionIdx(i)}
                            >{s.kind === "folder" ? <><FolderIcon size={11} />{s.value}/</> : s.value}</button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    );
                  })()) : (
                    <span
                      className={`categoryFrontmatterValue ${category ? "" : "empty"}`}
                      onClick={() => { setCategoryInput(""); setCategorySuggestionIdx(-1); setCategoryEditing(true); }}
                      title="Click to edit"
                    >
                      {category || pageFolders.length ? (
                        <>
                          {pageFolders.map((f) => (
                            <span
                              key={`f:${f}`}
                              className="categoryBadge folderChip"
                              title={`Folder: ${f} — right-click to rename or delete`}
                              onContextMenu={openTagMenu("folder", f)}
                            ><FolderIcon size={10} />{f}</span>
                          ))}
                          {category.split(",").map((t, i) => t.trim() ? (
                            <span
                              key={i}
                              className="categoryBadge"
                              title={`Label: ${t.trim()} — right-click to rename or delete`}
                              onContextMenu={openTagMenu("label", t.trim())}
                            >{t.trim()}</span>
                          ) : null)}
                        </>
                      ) : "Add labels..."}
                    </span>
                  )}
              </div>
            ) : null}
          </div>
          {!readOnly && focusedBlockId ? (
            <div className="pageActionCol">
              {docId ? (
                <span data-popover="meta" style={{ position: "relative", display: "inline-flex" }}>
                  <button
                    className="pageActionBtn"
                    title={
                      metaBusy
                        ? "Fetching paper metadata…"
                        : "Paper metadata (authors, venue, DOI, source file…)"
                    }
                    aria-label="Paper metadata"
                    onClick={(e) => {
                      const opening = openPopover !== "meta";
                      if (opening) {
                        // Fixed positioning so the popover floats above the
                        // window stack instead of being clipped by the
                        // notes window / drawn under the chat below it.
                        const r = e.currentTarget.getBoundingClientRect();
                        setMetaPopPos({
                          top: r.bottom + 6,
                          right: Math.max(8, window.innerWidth - r.right),
                        });
                        setSourceDraft(inputUrl);
                      }
                      setOpenPopover(opening ? "meta" : null);
                    }}
                  >
                    {/* Same busy affordance as the translate button: the icon
                        becomes a spinner while a fetch is running. */}
                    {metaBusy ? <span className="pillSpin" aria-hidden="true" /> : <InfoIcon size={15} />}
                  </button>
                  {openPopover === "meta" ? (
                    <div
                      className="popover sourcePopover metaPopover"
                      style={{
                        position: "fixed",
                        top: metaPopPos.top,
                        right: metaPopPos.right,
                        left: "auto",
                        zIndex: 1400,
                        maxHeight: `calc(100vh - ${metaPopPos.top + 12}px)`,
                        overflowY: "auto",
                      }}
                    >
                      <div className="popoverTitle citeSectionRow">
                        <span>Paper metadata</span>
                        <button
                          className="searchToggle"
                          title="Refresh metadata (arXiv → DOI → AI)"
                          disabled={metaBusy}
                          onClick={() => focusedBlock && fetchMetadata(focusedBlock, true)}
                        >
                          {metaBusy ? "…" : "↻"}
                        </button>
                      </div>
                      <div className="metaTable">
                        {[
                          ["Title", "title"],
                          ["Authors", "authors"],
                          ["Venue", "venue"],
                          ["Year", "year"],
                          ["Volume", "volume"],
                          ["Pages", "pages"],
                          ["DOI", "doi"],
                          ["arXiv", "arxiv_id"],
                        ].map(([label, key]) => (
                          <div className="metaRow" key={key}>
                            <span className="metaKey">{label}</span>
                            <span className="metaVal metaValEdit">
                              <input
                                className="metaInput"
                                value={metaDraft?.[key] ?? ""}
                                onChange={(e) =>
                                  setMetaDraft((d) => ({
                                    ...(d || metadataToDraft(null)),
                                    [key]: e.target.value,
                                  }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key !== "Enter") return;
                                  e.preventDefault();
                                  // Enter = Save (only when something actually changed)
                                  if (metaDirty) saveMetaEdits();
                                }}
                                placeholder="—"
                              />
                              {key === "doi" && metaDraft?.doi?.trim() ? (
                                <a
                                  className="metaLink"
                                  href={`https://doi.org/${metaDraft.doi.trim()}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  title="Open on doi.org"
                                >
                                  <ExternalLinkIcon size={11} />
                                </a>
                              ) : null}
                              {key === "arxiv_id" && metaDraft?.arxiv_id?.trim() ? (
                                <a
                                  className="metaLink"
                                  href={`https://arxiv.org/abs/${metaDraft.arxiv_id.trim()}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  title="Open on arXiv"
                                >
                                  <ExternalLinkIcon size={11} />
                                </a>
                              ) : null}
                              {key === "title" ? (
                                <button
                                  className="searchToggle metaRowBtn"
                                  title="AI: read the PDF and fill in the paper's title"
                                  aria-label="Fill in title with AI"
                                  disabled={aiTitleBusy}
                                  onClick={aiFillTitle}
                                >
                                  {aiTitleBusy ? "…" : <SparklesIcon size={13} />}
                                </button>
                              ) : null}
                            </span>
                          </div>
                        ))}
                        {pageMeta?.source ? (
                          <div className="metaRow">
                            <span className="metaKey">Source</span>
                            <span className="metaVal">
                              {pageMeta.source === "ai"
                                ? "AI-extracted"
                                : pageMeta.source === "manual"
                                  ? "edited by hand"
                                  : pageMeta.source}
                            </span>
                          </div>
                        ) : null}
                        <div className="metaRow">
                          <span className="metaKey">PDF text</span>
                          <span
                            className="metaVal"
                            style={{ flex: 1, display: "flex", alignItems: "center", gap: 6 }}
                          >
                            {!pdfTextInfo || pdfTextInfo.checking
                              ? "checking…"
                              : pdfTextInfo.error
                                ? `check failed — ${pdfTextInfo.error}`
                                : !pdfTextInfo.found
                                  ? "file not on server"
                                  : pdfTextInfo.ok
                                    ? "✓ extracted"
                                    : "✗ none — scanned or image-only? AI can't read it"}
                            {pdfTextInfo?.ok ? (
                              <button
                                className="searchToggle metaRowBtn"
                                style={{ marginLeft: "auto" }}
                                title="Preview the extracted text (what the AI reads)"
                                onClick={openPdfTextPreview}
                              >
                                <EyeIcon size={13} />
                              </button>
                            ) : null}
                            {pdfTextInfo && !pdfTextInfo.checking && !pdfTextInfo.ok ? (
                              <button
                                className="searchToggle metaRowBtn"
                                style={{ marginLeft: "auto" }}
                                title="Re-check text extraction (e.g. after replacing the source file) — retries the metadata lookup if text appears"
                                onClick={() => checkPdfText(true)}
                              >
                                ↻
                              </button>
                            ) : null}
                          </span>
                        </div>
                        <div className="metaRow">
                          <span className="metaKey">Index</span>
                          <span
                            className="metaVal"
                            title="Whether library-wide search can find text in this paper. Papers index automatically in the background; Settings → Search → Rebuild forces a full re-index."
                          >
                            {!pdfTextInfo || pdfTextInfo.checking
                              ? "checking…"
                              : pdfTextInfo.error || pdfTextInfo.indexed === undefined
                                ? "—"
                                : pdfTextInfo.indexed
                                  ? "✓ indexed for search"
                                  : pdfTextInfo.index_stale
                                    ? "stale — re-indexes automatically"
                                    : "not yet indexed"}
                          </span>
                        </div>
                        {pdfTextPreview ? (
                          <div className="reportOverlay" onClick={() => setPdfTextPreview(null)}>
                            <div
                              className="reportModal"
                              style={{ width: "min(640px, calc(100vw - 32px))" }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="reportModalTitle">Extracted PDF text</div>
                              <div
                                className="reportPageList"
                                style={{
                                  maxHeight: "60vh",
                                  whiteSpace: "pre-wrap",
                                  fontSize: 12,
                                  color: "var(--text-secondary)",
                                  padding: 10,
                                }}
                              >
                                {pdfTextPreview.loading ? "Extracting…" : pdfTextPreview.text}
                              </div>
                              {!pdfTextPreview.loading ? (
                                <div className="reportModalHint">
                                  First 12,000 characters — the AI context is drawn from this.
                                </div>
                              ) : null}
                              <div className="reportModalBtns">
                                <button className="uiBtn" onClick={() => setPdfTextPreview(null)}>
                                  Close
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      {!pageMeta ? (
                        <div className="popoverHint">
                          {metaBusy
                            ? "Fetching metadata…"
                            : focusedBlock?.properties?.meta_error
                              ? "A previous lookup found nothing — it won't retry automatically. Fill the fields in by hand, or hit ↻ to retry."
                              : "No metadata found — fill the fields in by hand, or hit ↻ to retry."}
                        </div>
                      ) : null}
                      {metaDirty ? (
                        <div className="reportModalBtns">
                          <button className="uiBtn primary" onClick={saveMetaEdits}>
                            Save metadata
                          </button>
                        </div>
                      ) : null}
                      <div className="popoverDivider" />
                      <div className="popoverSection">Source file</div>
                      <div className="shareRow">
                        <input
                          value={sourceDraft}
                          onChange={(e) => setSourceDraft(e.target.value)}
                          placeholder="PDF URL or /api/uploads/…"
                        />
                        <button
                          className="chatMsgActionBtn"
                          title="Copy the source URL"
                          aria-label="Copy source URL"
                          disabled={!sourceDraft.trim()}
                          onClick={() => copyFlash("source", sourceDraft.trim())}
                        >
                          {copiedKey === "source" ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                        </button>
                      </div>
                      {sourceDraft.trim() && sourceDraft.trim() !== inputUrl ? (
                        <div className="reportModalBtns">
                          <button
                            className="uiBtn primary"
                            onClick={async () => {
                              const url = sourceDraft.trim();
                              setOpenPopover(null);
                              try {
                                await apiJson(`${API}/blocks/${focusedBlockId}`, {
                                  method: "PUT",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ properties: { source_url: url } }),
                                });
                                await openBlock(focusedBlockId);
                                setStatus("Source PDF replaced.");
                              } catch (err) {
                                setStatus(`Replace failed: ${err.message}`);
                              }
                            }}
                          >
                            Replace source
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </span>
              ) : null}
              <button
                className="pageActionBtn pageDeleteBtn"
                title="Delete this page"
                onClick={() =>
                  setConfirmBox({
                    title: "Delete page",
                    message: `Delete "${pdfTitle || "this page"}" and all its notes? This can't be undone.`,
                    confirmLabel: "Delete",
                    danger: true,
                    onConfirm: async () => {
                      try {
                        await apiJson(`${API}/blocks/${focusedBlockId}`, { method: "DELETE" });
                      } catch {}
                      // Close the page's tab too (write straight to storage +
                      // server — we reload right after, so state updates and
                      // debounced pushes wouldn't stick).
                      try {
                        if (prefsUserRef.current) {
                          const nextTabs = openTabs.filter((t) => t.id !== focusedBlockId);
                          localStorage.setItem(
                            `gamma-tabs:${prefsUserRef.current}`,
                            JSON.stringify(nextTabs),
                          );
                          await apiJson(`${API}/prefs/open-tabs`, {
                            method: "PUT",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ value: nextTabs }),
                          });
                        }
                      } catch {}
                      clearSession();
                      window.location.href = "/";
                    },
                  })
                }
              >
                <TrashIcon size={15} />
              </button>
            </div>
          ) : null}
        </div>
      )}

      <div className="blockList">
        {!homeMode && backlinks.length > 0 ? (
          <div className="backlinksPanel">
            <div className="backlinksLabel">Backlinks ({backlinks.length})</div>
            <div className="backlinksList">
              {backlinks.map((bl) => {
                const isPrivate = bl.page_root_id && bl.page_root_id !== focusedBlockId;
                return isPrivate ? (
                  <div key={bl.id} className="backlinkItem private">
                    <div className="backlinkContent private">private block</div>
                  </div>
                ) : (
                  <button
                    key={bl.id}
                    className="backlinkItem"
                    title={bl.page_title ? `From: ${bl.page_title}` : undefined}
                    onClick={() => {
                      const row = document.querySelector(`[data-block-id="${bl.id}"]`);
                      if (row) {
                        row.scrollIntoView({ block: "center", behavior: "smooth" });
                        setFocusedId(bl.id);
                      } else if (bl.page_root_id && bl.page_root_id !== focusedBlockId) {
                        pendingBlockScrollRef.current = bl.id;
                        openBlock(bl.page_root_id);
                      } else {
                        pendingBlockScrollRef.current = bl.id;
                        setBlocks((prev) => expandToBlock(prev, bl.id));
                      }
                    }}
                  >
                    <div className="backlinkContent">{bl.content || "(empty)"}</div>
                    {bl.page_title && bl.page_title !== bl.content ? (
                      <div className="backlinkPage">{bl.page_title}</div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        {/* Recently-viewed shortcut strip. Labels are browsed like folders
            (the kind toggle's Labels mode) and shown as chips on each row, so
            this is the only carousel left. */}
        {homeMode && recentViewedPages.length > 0 ? (
          <CardCarousel label="Recently viewed" className="recentsCarousel">
            {recentViewedPages.map((b) => (
              <PageCard
                key={b._pageId}
                title={b.content}
                glyph={<FileGlyph isPdf={!!b._sourceUrl} />}
                snap={recentThumbs ? pageSnaps[b._pageId]?.img : null}
                kind={b._sourceUrl ? "PDF" : "Note"}
                time={formatRelativeTime(b._viewedAt)}
                folders={b._folders}
                labels={b._labels}
                labelMode={fileLabels}
                className={selectedPages.has(b._pageId) ? "selected" : ""}
                onClick={() => openPage(b._pageId)}
                onContextMenu={openPageMenu(b._pageId, b.content)}
              >
                <button
                  className="uiClose uiCloseSm pageCardClose"
                  title="Remove from Recently viewed"
                  aria-label="Remove from Recently viewed"
                  onClick={(e) => { e.stopPropagation(); removeRecentView(b._pageId); }}
                >×</button>
              </PageCard>
            ))}
          </CardCarousel>
        ) : null}
            {homeMode && !categoryFilter && !folderFilter && pinnedPages.length > 0 ? (
              <div className="pinnedSection">
                <div className="pinnedLabel"><PinIcon filled size={12} /> Pinned</div>
                <div className="pinnedStrip">
                  {pinnedPages.map((b) => (
                    <PageCard
                      key={b._pageId}
                      className={selectedPages.has(b._pageId) ? "selected" : ""}
                      glyph={<FileGlyph isPdf={!!b._sourceUrl} />}
                      title={b.content}
                      tip={`${b.content}\nClick to select · double-click to open`}
                      kind={b._sourceUrl ? "PDF" : "Note"}
                      time={formatRelativeTime(b._updatedAt)}
                      folders={b._folders} labels={b._labels} labelMode={fileLabels}
                     
                      draggable
                      onDragStart={(e) => { e.dataTransfer.setData("text/plain", b._pageId); e.dataTransfer.effectAllowed = "move"; }}
                      onClick={(e) => handlePageClick(b, e)}
                      onDoubleClick={() => openPage(b._pageId)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelectedPages((prev) => (prev.has(b._pageId) ? prev : new Set([b._pageId])));
                        lastPageClickRef.current = b._pageId;
                        setHomeMenu({ kind: "page", id: b._pageId, name: b.content, x: e.clientX, y: e.clientY });
                      }}
                    >
                      <button
                        className="pinBtn tilePinBtn pinned"
                        title="Unpin"
                        onClick={(e) => { e.stopPropagation(); setPagesPinned([b._pageId], false); }}
                      ><PinIcon filled size={12} /></button>
                    </PageCard>
                  ))}
                </div>
              </div>
            ) : null}
            {homeMode && (folderFilter || categoryFilter) ? (
              <div className="folderBrowser">
                    {folderFilter && !categoryFilter ? (
                    <div
                      className={`folderRow folderBackRow ${folderDragOver === "__up__" ? "dragOver" : ""}`}
                      onClick={() => {
                        const parent = folderFilter.includes("/") ? folderFilter.slice(0, folderFilter.lastIndexOf("/")) : "";
                        openFolder(parent);
                      }}
                      onDragOver={(e) => { e.preventDefault(); setFolderDragOver("__up__"); }}
                      onDragLeave={() => setFolderDragOver(null)}
                      onDrop={(e) => {
                        const parent = folderFilter.includes("/") ? folderFilter.slice(0, folderFilter.lastIndexOf("/")) : "";
                        dropOnFolder(e, parent, (ids) => removePagesFromFolder(ids, folderFilter));
                      }}
                      title="Back — or drop a paper or folder here to move it out of this folder"
                    >
                      <ArrowLeftIcon size={14} />
                      <span className="folderName">{folderFilter.includes("/") ? folderFilter.slice(0, folderFilter.lastIndexOf("/")) : "All files"}</span>
                      <span className="folderHint">drop here to move out of this folder</span>
                    </div>
                    ) : null}
                    {/* The label view gets the same back row: it drops the
                        label and returns to the folder scope the label was
                        opened from, and a paper dropped on it loses the label. */}
                    {categoryFilter ? (
                    <div
                      className={`folderRow folderBackRow ${folderDragOver === "__label_up__" ? "dragOver" : ""}`}
                      onClick={closeLabel}
                      onDragOver={(e) => { e.preventDefault(); setFolderDragOver("__label_up__"); }}
                      onDragLeave={() => setFolderDragOver(null)}
                      onDrop={(e) => dropOnLabel(e, categoryFilter, (ids) => removePagesFromLabel(ids, categoryFilter))}
                      title="Back — or drop a paper here to take this label off it"
                    >
                      <ArrowLeftIcon size={14} />
                      <span className="folderName">{folderFilter || "All files"}</span>
                      <span className="folderHint">drop here to remove this label</span>
                    </div>
                    ) : null}
                    <div className="folderCurrent">
                      {categoryFilter ? <LabelIcon size={15} /> : <FolderOpenIcon size={15} />}
                      {/* Breadcrumb: every path segment navigates to its level */}
                      {(folderFilter ? folderFilter.split("/") : []).map((seg, i, segs) => {
                        const prefix = segs.slice(0, i + 1).join("/");
                        return (
                          <span key={prefix}>
                            {i > 0 ? <span className="crumbSep">/</span> : null}
                            <button className="crumbBtn" onClick={() => openFolder(prefix)}>{seg}</button>
                          </span>
                        );
                      })}
                      {categoryFilter ? (
                        <span>
                          {folderFilter ? <span className="crumbSep">/</span> : null}
                          <button
                            className="crumbBtn"
                            title="Right-click to rename or delete this label"
                            onContextMenu={openTagMenu("label", categoryFilter)}
                          >{categoryFilter}</button>
                        </span>
                      ) : null}
                    </div>
              </div>
            ) : null}
            {homeMode ? (
              <div className="homeListBar">
                <span className="homeListLabel">{categoryFilter ? "Labelled" : folderFilter ? "Contents" : "Library"}</span>
                <span className="homeListSpacer" />
                <ListFindBox value={homeQuery} onChange={setHomeQuery} />
                <MenuSelect
                  icon={ArrowUpDownIcon}
                  label={categoryFilter ? "Sort this label" : folderFilter ? "Sort this folder — subfolders inherit it" : "Sort the library — folders inherit it"}
                  value={homeSort}
                  onChange={changeHomeSort}
                  options={[
                    ["updated", "Recently modified", PenIcon],
                    ["created", "Recently added", PlusIcon],
                    ["viewed", "Recently viewed", EyeIcon],
                    ["title", "Title A–Z", TypeIcon],
                  ]}
                />
                {/* A label holds papers only — nothing to filter by kind there. */}
                {categoryFilter ? null : (
                  <KindToggle
                    value={homeKinds}
                    onChange={changeHomeKinds}
                    scopeLabel={folderFilter ? "Shown in this folder — subfolders inherit it" : "Shown in the library — folders inherit it"}
                  />
                )}
                <ViewToggle view={homeView} onChange={changeHomeView} />
              </div>
            ) : null}
            {homeMode && homeView === "grid" ? (
                <>
                  {homeItems.length === 0 && !newFolderOpen ? (
                    <div className="empty">{homeEmptyText}</div>
                  ) : null}
                  <div className="fileGrid" onClick={(e) => { if (e.target.classList.contains("fileGrid")) clearSelection(); }}>
                    {!newFolderAllowed ? null : newFolderOpen ? (
                      <PageCard
                        className="pageCardAdd"
                        glyph={<FolderGlyph />}
                        kind="Folder"
                        labelMode={fileLabels}
                        renameNode={
                          <input
                            autoFocus
                            className="tileRenameInput"
                            value={newFolderName}
                            placeholder="Folder name…"
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => {
                              if (isEnterCommit(e)) { e.preventDefault(); commitNewFolder(); }
                              else if (e.key === "Escape") { setNewFolderOpen(false); setNewFolderName(""); }
                            }}
                            onBlur={commitNewFolder}
                          />
                        }
                      />
                    ) : (
                      <PageCard
                        className="pageCardAdd"
                        glyph={<FolderPlusIcon className="tileGlyph" size={null} strokeWidth={1.5} />}
                        title="New folder"
                        labelMode={fileLabels}
                        onClick={() => { setNewFolderName(""); setNewFolderOpen(true); }}
                      />
                    )}
                    {homeVisibleItems.map((item) => {
                      const dim = homeQuery && !item._match ? "homeDim" : "";
                      if (item.kind === "label") { const l = item.label; return (
                      <PageCard
                        key={item.key}
                        className={`${dim} ${folderDragOver === l ? "dragOver" : ""} ${selectedLabels.has(l) ? "selected" : ""}`}
                        glyph={<LabelGlyph />}
                        title={l}
                        tip="Click to select · double-click to open · drop a paper to label it"
                        kind="Label"
                        count={labelMeta[l]?.count || 0}
                        time={cardTime(item)}
                        labelMode={fileLabels}
                        onClick={(e) => handleLabelClick(l, e)}
                        onDoubleClick={() => openLabel(l)}
                        onContextMenu={openTagMenu("label", l)}
                        onDragOver={(e) => { e.preventDefault(); setFolderDragOver(l); }}
                        onDragLeave={() => setFolderDragOver(null)}
                        onDrop={(e) => dropOnLabel(e, l)}
                      />
                      ); }
                      if (item.kind === "folder") { const f = item.folder; return (
                      <PageCard
                        key={item.key}
                        className={`${dim} ${folderDragOver === f ? "dragOver" : ""} ${selectedFolders.has(f) ? "selected" : ""}`}
                        glyph={<FolderGlyph />}
                        title={f.slice(f.lastIndexOf("/") + 1)}
                        tip="Click to select · double-click to open · drop a paper or folder to move it in"
                        kind="Folder"
                        count={folderMeta[f]?.count || 0}
                        time={cardTime(item)}
                        labelMode={fileLabels}
                       
                        renameNode={folderRenaming?.name === f ? (
                          <input
                            autoFocus
                            className="tileRenameInput"
                            defaultValue={f.slice(f.lastIndexOf("/") + 1)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (isEnterCommit(e)) renameFolder(f, e.currentTarget.value);
                              else if (e.key === "Escape") setFolderRenaming(null);
                            }}
                            onBlur={(e) => renameFolder(f, e.currentTarget.value)}
                          />
                        ) : null}
                        draggable={folderRenaming?.name !== f}
                        onDragStart={(e) => { e.dataTransfer.setData("text/plain", FOLDER_DRAG + f); e.dataTransfer.effectAllowed = "move"; }}
                        onClick={(e) => handleFolderClick(f, e)}
                        onDoubleClick={() => { if (folderRenaming?.name !== f) openFolder(f); }}
                        onContextMenu={openTagMenu("folder", f)}
                        onDragOver={(e) => { e.preventDefault(); setFolderDragOver(f); }}
                        onDragLeave={() => setFolderDragOver(null)}
                        onDrop={(e) => dropOnFolder(e, f)}
                      />
                      ); }
                      const b = item.block;
                      const id = b._pageId;
                      const isPinned = !!b._pinned;
                      const isEditing = homeEditingId === id;
                      return (
                        <PageCard
                          key={id}
                          className={`${dim} ${selectedPages.has(id) ? "selected" : ""}`}
                          glyph={<FileGlyph isPdf={!!b._sourceUrl} />}
                          title={b.content}
                          tip={`${b.content}\nClick to select · double-click to open`}
                          kind={b._sourceUrl ? "PDF" : "Note"}
                          time={cardTime(item)}
                          folders={b._folders} labels={b._labels} labelMode={fileLabels}
                         
                          renameNode={isEditing ? (
                            <input
                              autoFocus
                              className="tileRenameInput"
                              defaultValue={b.content}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitPageRename(id, e.currentTarget.value);
                                else if (e.key === "Escape") setHomeEditingId(null);
                              }}
                              onBlur={(e) => commitPageRename(id, e.currentTarget.value)}
                            />
                          ) : null}
                          draggable={!isEditing}
                          onDragStart={(e) => { e.dataTransfer.setData("text/plain", id); e.dataTransfer.effectAllowed = "move"; }}
                          onClick={(e) => handlePageClick(b, e)}
                          onDoubleClick={() => { if (!isEditing) openPage(id); }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setSelectedPages((prev) => (prev.has(id) ? prev : new Set([id])));
                            lastPageClickRef.current = id;
                            setHomeMenu({ kind: "page", id, name: b.content, x: e.clientX, y: e.clientY });
                          }}
                        >
                          <button
                            className={`pinBtn tilePinBtn ${isPinned ? "pinned" : ""}`}
                            title={isPinned ? "Unpin" : "Pin to top"}
                            onClick={(e) => { e.stopPropagation(); setPagesPinned([id], !isPinned); }}
                          ><PinIcon filled={isPinned} size={12} /></button>
                        </PageCard>
                      );
                    })}
                  </div>
                  {homeItems.length > homeVisibleItems.length ? (
                    <button ref={loadMoreRef} className="loadMoreBtn" onClick={() => setHomeShowCount((c) => c + HOME_PAGE_CHUNK)}>
                      Showing {homeVisibleItems.length} of {homeItems.length} — load more
                    </button>
                  ) : null}
                </>
            ) : homeMode && homeView === "list" ? (
                <>
                  {homeItems.length === 0 && !newFolderOpen ? (
                    <div className="empty">{homeEmptyText}</div>
                  ) : null}
                  <div className="fileList" onClick={(e) => { if (e.target.classList.contains("fileList")) clearSelection(); }}>
                    {!newFolderAllowed ? null : newFolderOpen ? (
                      <div className="folderRow folderNewRow">
                        <FolderPlusIcon size={15} />
                        <input
                          autoFocus
                          className="folderNewInput"
                          value={newFolderName}
                          onChange={(e) => setNewFolderName(e.target.value)}
                          placeholder="Folder name…"
                          onKeyDown={(e) => {
                            if (isEnterCommit(e)) { e.preventDefault(); commitNewFolder(); }
                            else if (e.key === "Escape") { setNewFolderOpen(false); setNewFolderName(""); }
                          }}
                          onBlur={commitNewFolder}
                        />
                      </div>
                    ) : (
                      <button className="folderRow folderNewBtn" onClick={() => { setNewFolderName(""); setNewFolderOpen(true); }}>
                        <FolderPlusIcon size={15} />
                        <span className="folderName">New folder</span>
                      </button>
                    )}
                    {homeVisibleItems.map((item) => {
                      const dim = homeQuery && !item._match ? "homeDim" : "";
                      if (item.kind === "label") { const l = item.label; return (
                      <div
                        key={item.key}
                        className={`folderRow labelRow ${dim} ${folderDragOver === l ? "dragOver" : ""} ${selectedLabels.has(l) ? "selected" : ""}`}
                        onClick={(e) => handleLabelClick(l, e)}
                        onDoubleClick={() => openLabel(l)}
                        onContextMenu={openTagMenu("label", l)}
                        onDragOver={(e) => { e.preventDefault(); setFolderDragOver(l); }}
                        onDragLeave={() => setFolderDragOver(null)}
                        onDrop={(e) => dropOnLabel(e, l)}
                        title="Click to select · double-click to open · right-click to rename or delete · drop a paper to label it"
                      >
                        <LabelIcon size={15} />
                        <span className="folderName">{l}</span>
                        <span className="folderCount">{labelMeta[l]?.count || 0}</span>
                      </div>
                      ); }
                      if (item.kind === "folder") { const f = item.folder; return (
                      <div
                        key={item.key}
                        className={`folderRow ${dim} ${folderDragOver === f ? "dragOver" : ""} ${selectedFolders.has(f) ? "selected" : ""}`}
                        draggable={folderRenaming?.name !== f}
                        onDragStart={(e) => { e.dataTransfer.setData("text/plain", FOLDER_DRAG + f); e.dataTransfer.effectAllowed = "move"; }}
                        onClick={(e) => handleFolderClick(f, e)}
                        onDoubleClick={() => { if (folderRenaming?.name !== f) openFolder(f); }}
                        onContextMenu={openTagMenu("folder", f)}
                        onDragOver={(e) => { e.preventDefault(); setFolderDragOver(f); }}
                        onDragLeave={() => setFolderDragOver(null)}
                        onDrop={(e) => dropOnFolder(e, f)}
                        title="Click to select · double-click to open · right-click to rename or delete · drop a paper or folder to move it in"
                      >
                        <FolderIcon size={15} />
                        {folderRenaming?.name === f ? (
                          <input
                            autoFocus
                            className="folderNewInput"
                            value={folderRenaming.draft}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setFolderRenaming({ name: f, draft: e.target.value })}
                            onKeyDown={(e) => {
                              if (isEnterCommit(e)) renameFolder(f, folderRenaming.draft);
                              else if (e.key === "Escape") setFolderRenaming(null);
                            }}
                            onBlur={() => renameFolder(f, folderRenaming.draft)}
                          />
                        ) : (
                          <span className="folderName">{f.slice(f.lastIndexOf("/") + 1)}</span>
                        )}
                        <span className="folderCount">{folderMeta[f]?.count || 0}</span>
                      </div>
                      ); }
                      const b = item.block;
                      const id = b._pageId;
                      const isPinned = !!b._pinned;
                      const isEditing = homeEditingId === id;
                      return (
                        <div
                          key={id}
                          className={`fileRow ${dim} ${selectedPages.has(id) ? "selected" : ""}`}
                          draggable={!isEditing}
                          onDragStart={(e) => { e.dataTransfer.setData("text/plain", id); e.dataTransfer.effectAllowed = "move"; }}
                          onClick={(e) => handlePageClick(b, e)}
                          onDoubleClick={() => { if (!isEditing) openPage(id); }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setSelectedPages((prev) => (prev.has(id) ? prev : new Set([id])));
                            lastPageClickRef.current = id;
                            setHomeMenu({ kind: "page", id, name: b.content, x: e.clientX, y: e.clientY });
                          }}
                          title={`${b.content}\nClick to select · double-click to open`}
                        >
                          <span className="fileRowIcon"><FileGlyph isPdf={!!b._sourceUrl} /></span>
                          {isEditing ? (
                            <input
                              autoFocus
                              className="fileRowRename"
                              defaultValue={b.content}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (isEnterCommit(e)) commitPageRename(id, e.currentTarget.value);
                                else if (e.key === "Escape") setHomeEditingId(null);
                              }}
                              onBlur={(e) => commitPageRename(id, e.currentTarget.value)}
                            />
                          ) : (
                            <span className="fileRowName">{b.content || "Untitled"}</span>
                          )}
                          <CardLabels className="fileRowLabels" folders={b._folders} labels={b._labels}
                            mode={fileLabels} onLabelMenu={(l) => openTagMenu("label", l)} />
                          <span className="fileRowKind">{b._sourceUrl ? "PDF" : "Note"}</span>
                          <button
                            className={`pinBtn fileRowPin ${isPinned ? "pinned" : ""}`}
                            title={isPinned ? "Unpin" : "Pin to top"}
                            onClick={(e) => { e.stopPropagation(); setPagesPinned([id], !isPinned); }}
                          ><PinIcon filled={isPinned} size={12} /></button>
                        </div>
                      );
                    })}
                  </div>
                  {homeItems.length > homeVisibleItems.length ? (
                    <button ref={loadMoreRef} className="loadMoreBtn" onClick={() => setHomeShowCount((c) => c + HOME_PAGE_CHUNK)}>
                      Showing {homeVisibleItems.length} of {homeItems.length} — load more
                    </button>
                  ) : null}
                </>
        ) : (homeMode ? homeVisiblePages : visibleBlocks).length === 0 ? (
          <>
            <div className="empty">
              {homeMode
                ? folderFilter
                  ? "This folder is empty — drag papers onto it from the library."
                  : "No pages yet — use the + button above to open a PDF or start a note page."
                : "No blocks yet."}
            </div>
            {addNoteButton}
          </>
        ) : (
          (() => {
            const rowProps = {
              homeMode,
              focusedId,
              setFocusedId,
              onJump: jumpToHighlightId,
              onEnterAttachMode: readOnly ? null : setAttachModeBlockId,
              onUnlinkHighlight: readOnly ? null : unlinkHighlightFromBlock,
              onOpenLinkTarget: (b) => {
                const p = b.properties || {};
                if (p.link_page_id) {
                  if (p.link_highlight_id) pendingJumpRef.current = p.link_highlight_id;
                  openBlock(p.link_page_id, { pushNav: true });
                } else if (p.link_url) handleDocLink(p.link_url);
              },
              registerRef,
              readOnly,
              // Area-highlight cards show their crop, re-rendered from the
              // loaded document each session (never stored, same as the
              // chat attach); docNonce retries crops once the PDF is up.
              captureArea: capturePdfArea,
              docNonce: pdfDocNonce,
              allBlocks: visibleBlocks,
              highlightColors,
              refCache,
              onFetchRefs,
              onCacheRef,
              onBlockRefClick: async (id) => {
                function findBlock(list) {
                  for (const b of list || []) {
                    if (b.id === id) return b;
                    const found = findBlock(b.children || []);
                    if (found) return found;
                  }
                  return null;
                }
                if (findBlock(blocks)) {
                  suppressAutosaveRef.current = true;
                  pendingBlockScrollRef.current = id;
                  setBlocks((prev) => expandToBlock(prev, id));
                } else {
                  pushNav(); // block-ref click = link jump to another page
                  pendingBlockScrollRef.current = id;
                  const cached = refCache[id];
                  const rootId = cached?.page_root_id;
                  if (rootId && rootId !== id) {
                    await openBlock(rootId);
                  } else {
                    await openBlock(id);
                  }
                }
              },
              onPageOpen: handlePageClick,
              onPageContext: (pageBlock, e) => {
                const id = pageBlock._pageId;
                // Right-click keeps an existing multi-selection; otherwise selects the card
                setSelectedPages((prev) => (prev.has(id) ? prev : new Set([id])));
                lastPageClickRef.current = id;
                setHomeMenu({
                  kind: "page",
                  id,
                  name: pageBlock.content,
                  x: e.clientX,
                  y: e.clientY,
                });
              },
              selectedPageIds: selectedPages,
              onChangeText: (id, text) => {
                if (readOnly) return;
                if (homeMode) {
                  setHomeBlocks((prev) =>
                    prev.map((b) => (b.id === id ? { ...b, content: text } : b)),
                  );
                  if (pageTitleSaveTimerRef.current) clearTimeout(pageTitleSaveTimerRef.current);
                  pageTitleSaveTimerRef.current = setTimeout(() => {
                    apiJson(`${API}/blocks/${id}`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ content: text }),
                    }).catch((err) => setStatus(`Rename failed: ${err}`));
                  }, 500);
                  return;
                }
                setBlocks(setBlockText(blocks, id, text));
              },
              onStartEdit: (id, editMode) => {
                if (readOnly) return;
                if (homeMode) {
                  if (editMode) pendingFocusRef.current = id;
                  setHomeEditingId(editMode ? id : null);
                  return;
                }
                if (editMode) pendingFocusRef.current = id;
                const next = setBlockEditMode(blocks, id, editMode);
                setBlocks(next);
                if (!editMode) {
                  persistBlocks(next).catch((err) => setStatus(`Save failed: ${err.message}`));
                }
              },
              enterNewNote,
              onEnterSibling: (id) => {
                if (readOnly) return;
                if (homeMode) {
                  const idx = pageBlocks.findIndex((b) => b.id === id);
                  if (idx < 0) return;
                  const before = pageBlocks[idx]._position || null;
                  const after = pageBlocks[idx + 1]?._position || null;
                  apiJson(`${API}/blocks`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ parent_id: "root", content: "", before, after }),
                  })
                    .then((created) =>
                      fetchHomeBlocks().then(() => {
                        pendingFocusRef.current = created.id;
                        setHomeEditingId(created.id);
                        setFocusedId(created.id);
                      }),
                    )
                    .catch((err) => setStatus(`Create failed: ${err}`));
                  return;
                }
                const { blocks: next, newId } = addSiblingBlock(blocks, id);
                pendingFocusRef.current = newId;
                setBlocks(next);
                setFocusedId(newId);
              },
              onAddChild: (id) => {
                if (readOnly) return;
                const { blocks: next, newId } = addChildBlock(blocks, id);
                pendingFocusRef.current = newId;
                setBlocks(next);
                setFocusedId(newId);
              },
              onIndent: (id) => {
                if (readOnly || homeMode) return;
                const next = indentBlock(blocks, id);
                setBlocks(next);
                setFocusedId(id);
              },
              onOutdent: (id) => {
                if (readOnly || homeMode) return;
                const next = outdentBlock(blocks, id);
                setBlocks(next);
                setFocusedId(id);
              },
              onToggle: (id) => {
                const next = toggleCollapsed(blocks, id);
                setBlocks(next);
              },
              onDelete: (id) => {
                if (readOnly) return;
                if (homeMode) {
                  // Deleting a page also removes its stored PDF (if no
                  // other page references it) — always confirm.
                  const pg = homeBlocks.find((b) => b.id === id);
                  setConfirmBox({
                    title: "Delete page",
                    message: `Delete "${(pg?.content || "this page").slice(0, 80)}" with all its notes${pg?.properties?.doc_id ? " and its stored PDF file" : ""}? This can't be undone.`,
                    confirmLabel: "Delete",
                    danger: true,
                    onConfirm: () => {
                      apiJson(`${API}/blocks/${id}`, { method: "DELETE" })
                        .then(() => {
                          updateTabs((prev) => prev.filter((t) => t.id !== id));
                          fetchHomeBlocks();
                        })
                        .catch((err) => setStatus(`Delete failed: ${err.message}`));
                    },
                  });
                  return;
                }
                apiJson(`${API}/blocks/${id}`, { method: "DELETE" }).catch((err) =>
                  setStatus(`Delete failed: ${err}`),
                );
                setBlocks(removeBlockTree(blocks, id));
              },
              onBlockDragOver: (e, block) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const wrap = e.currentTarget.closest(".sortableBlockWrap");
                const r = wrap
                  ? wrap.getBoundingClientRect()
                  : e.currentTarget.getBoundingClientRect();
                const px = e.clientX;
                const py = e.clientY;
                const above = py - r.top <= 16;
                const td = parseInt(
                  (wrap || e.currentTarget).getAttribute("data-depth") || "0",
                  10,
                );
                const nested = px - r.left > 50;
                const dt = {
                  targetId: block.id,
                  above,
                  depth: nested ? td + 1 : td,
                  rect: { top: r.top, left: r.left, width: r.width, bottom: r.bottom },
                };
                _dragState.dropTarget = dt;
                setDropTarget(dt);
              },
              onBlockDragLeave: () => {
                setDropTarget(null);
                _dragState.dropTarget = null;
              },
              onBlockDrop: (e, _block) => {
                e.preventDefault();
                const dt = _dragState.dropTarget;
                setDropTarget(null);
                _dragState.dropTarget = null;
                const sourceId = e.dataTransfer.getData("text/plain");
                if (!sourceId || !dt || sourceId === dt.targetId || readOnly) return;
                if (homeMode) {
                  const pages = [...pageBlocks];
                  const srcIdx = pages.findIndex((b) => b.id === sourceId);
                  const tgtIdx = pages.findIndex((b) => b.id === dt.targetId);
                  if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return;
                  const remaining = pages.filter((_, i) => i !== srcIdx);
                  const adjTgt = tgtIdx > srcIdx ? tgtIdx - 1 : tgtIdx;
                  const dropIdx = dt.above ? adjTgt : adjTgt + 1;
                  const before = remaining[dropIdx - 1]?._position ?? null;
                  const after = remaining[dropIdx]?._position ?? null;
                  const pageId = pages[srcIdx]._pageId;
                  if (!pageId) return;
                  apiJson(`${API}/blocks/${pageId}/reorder`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ before, after }),
                  })
                    .then(() => fetchHomeBlocks())
                    .catch((err) => setStatus(`Reorder failed: ${err}`));
                  return;
                }
                if (isDescendant(blocks, sourceId, dt.targetId)) return;
                const extracted = extractBlock(blocks, sourceId);
                if (!extracted) return;
                const { extracted: sourceBlock, remaining } = extracted;
                const targetCtx = findBlockContext(remaining, dt.targetId);
                if (!targetCtx) return;
                const targetDepth = targetCtx.depth;
                let next;
                if (dt.depth === targetDepth + 1) {
                  next = insertChild(remaining, dt.targetId, sourceBlock, false);
                } else if (dt.depth === targetDepth) {
                  next = insertSibling(remaining, dt.targetId, sourceBlock, !dt.above);
                } else if (dt.depth < targetDepth) {
                  const ancestorId = targetCtx.ancestors[dt.depth];
                  if (!ancestorId) return;
                  next = insertSibling(remaining, ancestorId, sourceBlock, !dt.above);
                } else {
                  return;
                }
                if (next) setBlocks(next);
                _dragState.draggingId = null;
              },
            };
            return (
              <>
                <BlockTree
                  blocks={homeMode ? homeVisiblePages : blocks}
                  readOnly={readOnly}
                  rowProps={rowProps}
                />
                {addNoteButton}
                {homeMode && homeItems.length > homeVisibleItems.length ? (
                  <button
                    ref={loadMoreRef}
                    className="loadMoreBtn"
                    onClick={() => setHomeShowCount((c) => c + HOME_PAGE_CHUNK)}
                  >
                    Showing {homeVisibleItems.length} of {homeItems.length} — load more
                  </button>
                ) : null}
                <BlockDropIndicator target={dropTarget} />
              </>
            );
          })()
        )}
      </div>
    </div>
  ) : null;

  // Slot the windows into dock columns / the bottom row. When no PDF is shown
  // (home, page-only, or PDF closed) the notes window takes the center instead.
  const centerNotes = pdfHidden || homeMode || pageOnly;
  const winVisible = {
    notes: Boolean(notesWindow) && !centerNotes,
    chat: !readOnly && !chatHidden,
  };
  function renderWindow(id) {
    // Phone: windows are full-screen overlays — no dock dragging or collapsing,
    // and closing just returns to the main view.
    const common = {
      onGrip: isPhone ? undefined : (e) => startWindowDock(e, id),
      onGripDoubleClick: isPhone
        ? undefined
        : () => setCollapsedWins((prev) => ({ ...prev, [id]: !prev[id] })),
      collapsed: isPhone ? false : !!collapsedWins[id],
    };
    if (id === "notes") {
      return (
        <DockWindow
          title="Notes"
          {...common}
          onClose={() => (isPhone ? setPhonePanel(null) : setNotesVisible(false))}
        >
          {notesWindow}
        </DockWindow>
      );
    }
    if (id === "chat") {
      return (
        <ChatDock
          {...common}
          onClose={() => (isPhone ? setPhonePanel(null) : setChatHidden(true))}
          docId={docId}
          focusedBlockId={focusedBlockId}
          homeBlocks={homeBlocks}
          pdfTitle={pdfTitle}
          openTabs={openTabs}
          pdfSelections={pdfSelections}
          setPdfSelections={setPdfSelections}
          chatImages={chatImages}
          setChatImages={setChatImages}
          chatModel={chatSendModel}
          setChatModel={setChatModel}
          chatEffort={chatEffort}
          setChatEffort={setChatEffort}
          dictationModel={dictationModel}
          dictationLang={dictationLang}
          chatSystem={chatSystem}
          aiInfo={aiInfo}
          aiProvider={aiProvider}
          setAiProvider={setAiProvider}
          refreshAiModels={refreshAiModels}
          chatContextChars={chatContextChars}
          multiContextChars={multiContextChars}
          openAiKeysEditor={openAiKeysEditor}
          aiHealth={aiHealth}
          dismissAiHealth={() => setAiHealth(null)}
          openPopover={openPopover}
          setOpenPopover={setOpenPopover}
          setStatus={setStatus}
          organizeFolder={!focusedBlockId && !readOnly ? folderFilter : null}
          toolRounds={toolRounds} agentReadChars={agentReadChars} agentPerms={agentPerms} agentSystem={agentSystem}
          agentEnabled={agentEnabled} folderToolsDefault={folderToolsDefault} pdfToolsDefault={pdfToolsDefault}
          onLibraryChange={fetchHomeBlocks}
        />
      );
    }
    return null;
  }
  // Windows per slot, in stored order, visibility-filtered. On a phone the
  // dock slots are empty — windows render as full-screen overlays instead.
  const slotWins = (side) => (isPhone ? [] : layout[side].filter((w) => winVisible[w]));
  function renderSlotGroup(side, direction) {
    const wins = slotWins(side);
    // Collapsed windows live OUTSIDE the panel group as fixed header bars —
    // panel sizes are percentage-based, so a collapsed panel could never
    // shrink to exactly one header height. Bars keep their side of the
    // expanded group so collapsing doesn't reorder the column.
    const expanded = wins.filter((w) => !collapsedWins[w]);
    const firstExpanded = wins.findIndex((w) => !collapsedWins[w]);
    const bar = (w) => (
      <div key={w} className="collapsedBar">
        {renderWindow(w)}
      </div>
    );
    const before = wins.filter(
      (w, i) => collapsedWins[w] && (firstExpanded === -1 || i < firstExpanded),
    );
    const after = wins.filter(
      (w, i) => collapsedWins[w] && firstExpanded !== -1 && i > firstExpanded,
    );
    return (
      <div className={`slotStack slotStack-${direction}`}>
        {before.map(bar)}
        {expanded.length ? (
          <div className="slotStackGroup">
            <PanelGroup
              direction={direction}
              autoSaveId={`gamma-slot-${side}`}
              ref={(h) => {
                panelGroupRefs.current[`slot-${side}`] = h;
              }}
            >
              {expanded.map((w, i) => (
                <React.Fragment key={w}>
                  {i > 0 ? <PanelResizeHandle className={`sash sash-${direction}`} /> : null}
                  <Panel id={w} order={i + 1} minSize={15}>
                    {renderWindow(w)}
                  </Panel>
                </React.Fragment>
              ))}
            </PanelGroup>
          </div>
        ) : null}
        {after.map(bar)}
      </div>
    );
  }

  // The "⋮" overflow menu, shared by the editing and read-only topbars.
  // Read-only share views omit AI chat and the import actions.
  const renderOverflowMenu = (menuReadOnly) => (
    <PopoverAnchor name="menu">
      <button
        className={`iconBtn ${openPopover === "menu" ? "activeIcon" : ""}`}
        onClick={() => setOpenPopover((p) => (p === "menu" ? null : "menu"))}
        title="Settings"
        aria-label="Settings"
      >
        <MenuIcon size={17} />
      </button>
      {openPopover === "menu" ? (
        <div className="popover menuPopover">
          <div className="popoverSection">Windows</div>
          {!homeMode && pdfUrl ? (
            <button className="popoverItem" onClick={() => setPdfHidden((v) => !v)}>
              <span className="check">{!pdfHidden ? "✓" : ""}</span>
              <FileIcon className="popoverItemIcon" size={15} /> PDF
            </button>
          ) : null}
          {!homeMode ? (
            <button className="popoverItem" onClick={() => setNotesVisible((v) => !v)}>
              <span className="check">{notesVisible ? "✓" : ""}</span>
              <FileTextIcon className="popoverItemIcon" size={15} /> Notes
            </button>
          ) : null}
          {!menuReadOnly ? (
            <button className="popoverItem" onClick={() => setChatHidden((v) => !v)}>
              <span className="check">{!chatHidden ? "✓" : ""}</span>
              <SparklesIcon className="popoverItemIcon" size={15} /> AI Chat
            </button>
          ) : null}
          {!menuReadOnly ? <div className="popoverDivider" /> : null}
          {!menuReadOnly ? (
            <button
              className="popoverItem"
              onClick={() => { setOpenPopover(null); setImportOpen(true); }}
              title="Bring in highlights — the ones saved inside this PDF file, a Logseq export, or a whole Zotero library"
            >
              <ImportIcon className="popoverItemIcon" size={15} />
              Import…
            </button>
          ) : null}
          {(focusedBlock && !homeMode) || (homeMode && folderFilter) ? (
            <>
              <div className="popoverDivider" />
              <button
                className="popoverItem"
                onClick={() => {
                  setOpenPopover(null);
                  setExportFolder(homeMode ? folderFilter : null);
                  setExportOpen(true);
                }}
                title={homeMode
                  ? `Download the “${folderFilter}” folder as Markdown, a Logseq graph, or a Zotero library`
                  : "Download this page as PDF, Markdown, a Logseq graph, or a Zotero library"}
              >
                <ExportIcon className="popoverItemIcon" size={15} />
                Export…
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </PopoverAnchor>
  );

  // The topbar action buttons. On a phone these move to the bottom bar:
  // the tab row is too narrow to hold both, and thumbs reach the bottom.
  const topbarActions = (
    <>
      <span data-popover="add" style={{ position: "relative", display: "inline-flex" }}>
        <button
          className={`iconBtn addBtn ${openPopover === "add" ? "activeIcon" : ""}`}
          onClick={() => setOpenPopover((p) => (p === "add" ? null : "add"))}
          title="Add — open a PDF by URL, arXiv id or DOI, upload a file, or start a note page"
          aria-label="Add"
        >
          <PlusIcon size={17} strokeWidth={2.2} />
        </button>
        {openPopover === "add" ? (
          <div className="popover addPopover">
            <input
              autoFocus
              className="searchInput"
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              placeholder="PDF URL, arXiv id, or DOI — press Enter"
              onKeyDown={(e) => {
                if (e.key === "Enter" && addUrl.trim() && !loading) {
                  setOpenPopover(null);
                  openPdf(addUrl.trim());
                  setAddUrl("");
                }
              }}
            />
            <label className="popoverItem" style={{ cursor: loading ? "not-allowed" : "pointer" }}>
              Upload files…
              <input
                type="file"
                accept=".pdf,.md,.markdown,application/pdf,text/markdown"
                multiple
                style={{ display: "none" }}
                disabled={loading}
                onChange={(e) => { const files = Array.from(e.target.files || []); e.target.value = ""; setOpenPopover(null); if (files.length) uploadFiles(files); }}
              />
            </label>
            <label
              className="popoverItem"
              style={{ cursor: loading ? "not-allowed" : "pointer" }}
              title="Import every PDF and Markdown note in a folder — subfolders become folder labels"
            >
              Upload folder…
              <input
                type="file"
                webkitdirectory=""
                style={{ display: "none" }}
                disabled={loading}
                onChange={(e) => { const files = Array.from(e.target.files || []); e.target.value = ""; setOpenPopover(null); if (files.length) uploadFiles(files); }}
              />
            </label>
            <button className="popoverItem" onClick={createNotePage}>New note page</button>
          </div>
        ) : null}
      </span>
      <span data-popover="downloads" style={{ position: "relative", display: "inline-flex" }}>
          <button
            className={`iconBtn transferBtn ${openPopover === "downloads" ? "activeIcon" : ""}`}
            onClick={() => setOpenPopover((p) => (p === "downloads" ? null : "downloads"))}
            title="Background tasks — downloads, uploads, indexing, metadata/AI jobs"
            aria-label="Background tasks"
          >
            <ActivityIcon size={16} />
            {/* Spinner while anything runs, otherwise a red dot for a failed
                transfer — a refused download no longer leaves a broken page
                behind, so this is the only sign it happened. "ai" jobs are
                excluded: a paper with no findable metadata is routine, and
                the metadata popover says so itself. */}
            {(transfers.some((t) => t.status === "active") || indexTask?.active)
              ? <span className="transferSpin" />
              : transfers.some((t) => t.status === "error" && t.kind !== "ai") ? <span className="transferDot" /> : null}
          </button>
          {openPopover === "downloads" ? (
            <div className="popover downloadsPopover">
              <div className="popoverTitle citeSectionRow">
                <span>Background tasks</span>
                <button
                  className="searchToggle transferClearBtn"
                  title="Clear finished"
                  onClick={() => {
                    if (!indexTask?.active) setIndexTaskCleared(true);
                    setTransfers((prev) => {
                      const kept = prev.filter((t) => t.status === "active");
                      const ids = new Set(kept.map((t) => t.id));
                      for (const [u, id] of Object.entries(transferByUrlRef.current)) {
                        if (!ids.has(id)) delete transferByUrlRef.current[u]; // cleared rows can be re-created later
                      }
                      return kept;
                    });
                  }}
                >Clear</button>
              </div>
              {!transfers.length && !(indexTask && (indexTask.active || (!indexTaskCleared && indexTask.total > 0))) ? (
                <div className="popoverHint">No background tasks — downloads, uploads, indexing, metadata and AI jobs show up here.</div>
              ) : null}
              {indexTask && (indexTask.active || (!indexTaskCleared && indexTask.total > 0)) ? (
                <div className="transferRow">
                  <span className={`transferStatus ${indexTask.active ? "active" : "done"}`}>
                    {indexTask.active
                      ? <span className="transferSpin inline" />
                      : <CheckIcon size={12} strokeWidth={2.6} />}
                  </span>
                  <span className="transferKind">
                    <SearchIcon size={12} />
                  </span>
                  <span className="transferName">Indexing PDF library for search</span>
                  <span className="transferInfo">{indexTask.done}/{indexTask.total}</span>
                </div>
              ) : null}
              {transfers.map((t) => (
                <div key={t.id} className="transferRow">
                  <span className={`transferStatus ${t.status}`}>
                    {t.status === "active" ? <span className="transferSpin inline" />
                      : t.status === "done"
                        ? <CheckIcon size={12} strokeWidth={2.6} />
                        : <AlertCircleIcon size={12} strokeWidth={2.4} />}
                  </span>
                  <span className="transferKind">
                    {t.kind === "upload"
                      ? <UploadIcon size={12} />
                      : t.kind === "ai"
                        ? <SparklesIcon size={12} />
                        : t.kind === "import"
                          ? <FileIcon size={12} />
                          : <DownloadIcon size={12} />}
                  </span>
                  <span className="transferName" title={t.name}>{t.name}</span>
                  <span className="transferInfo">{t.info || ""}</span>
                </div>
              ))}
            </div>
          ) : null}
        </span>
      <SearchPanel
        open={openPopover === "search"}
        onOpenChange={(v) => setOpenPopover(v ? "search" : null)}
        detailsDefault={focusedBlockId ? searchDetailsPaper : searchDetailsHome}
        focusedBlockId={focusedBlockId}
        homeBlocks={homeBlocks}
        allFolderPaths={allFolderPaths}
        openBlock={openBlock}
        originBase={currentHomeOrigin("search")}
        restoreContext={searchRestoreContext}
        onRestoreContext={setSearchRestoreContext}
        pendingBlockScrollRef={pendingBlockScrollRef}
        pdfSearchRef={pdfSearchRef}
        scrollToRef={scrollToRef}
        setPdfHidden={setPdfHidden}
        docNonce={pdfDocNonce}
        onFindMarks={setFindMarks}
      />
      {pdfUrl && !homeMode ? (
        <span data-popover="share" style={{ position: "relative", display: "inline-flex" }}>
          <button
            className={`iconBtn ${openPopover === "share" ? "activeIcon" : ""}`}
            onClick={() => {
              const opening = openPopover !== "share";
              setOpenPopover(opening ? "share" : null);
              if (opening) fetchShareLink();
            }}
            disabled={loading}
            title="Share"
            aria-label="Share"
          >
            <LinkIcon size={16} />
          </button>
          {openPopover === "share" ? (
            <div className="popover sharePopover">
              <div className="popoverTitle">Share this page</div>
              <div className="popoverHint">Anyone with the link can view the PDF, highlights, and notes — read-only, no login.</div>
              {shareUrl ? (
                <div className="shareRow">
                  <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
                  <button
                    className="chatMsgActionBtn"
                    onClick={copyShareLink}
                    title="Copy link"
                    aria-label="Copy share link"
                  >
                    {shareCopied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                  </button>
                </div>
              ) : (
                <div className="popoverHint">Creating link…</div>
              )}
              {(pageMeta || pageBibtex) ? (
                <>
                  <div className="popoverDivider" />
                  <div className="popoverSection citeSectionRow">
                    <span>Slide citation</span>
                    <button
                      className="searchToggle"
                      title="Regenerate the citation"
                      disabled={pptCiteBusy}
                      onClick={() => makePptCitation(true)}
                    >{pptCiteBusy ? "…" : "↻"}</button>
                  </div>
                  {pptCite ? (
                    <div className="pptCiteBox">
                      <div className="pptCitePreview"><ChatMarkdown text={pptCite} /></div>
                      <button
                        className="chatMsgActionBtn"
                        onClick={() => copyFlash("ppt", pptCite)}
                        title="Copy — pastes with real italics/bold into PowerPoint"
                        aria-label="Copy slide citation"
                      >
                        {copiedKey === "ppt"
                          ? <CheckIcon size={13} />
                          : <CopyIcon size={13} />}
                      </button>
                    </div>
                  ) : (
                    <div className="popoverHint">{pptCiteBusy ? "Generating…" : "Citation will generate when metadata is ready."}</div>
                  )}
                  {pageBibtex ? (
                    <>
                      <div className="popoverSection">BibTeX</div>
                      <div className="pptCiteBox">
                        <pre className="bibtexPre">{pageBibtex}</pre>
                        <button
                          className="chatMsgActionBtn"
                          onClick={() => copyFlash("bibtex", pageBibtex)}
                          title="Copy the BibTeX entry"
                          aria-label="Copy BibTeX"
                        >
                          {copiedKey === "bibtex"
                            ? <CheckIcon size={13} />
                            : <CopyIcon size={13} />}
                        </button>
                      </div>
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </span>
      ) : null}
      {authUser?.user && (
        <span data-popover="user" style={{ position: "relative", display: "inline-flex" }}>
          <button
            className={`iconBtn ${openPopover === "user" ? "activeIcon" : ""}`}
            onClick={() => {
              const opening = openPopover !== "user";
              if (opening) refreshQuota(); // fresh storage meter on open
              setOpenPopover(opening ? "user" : null);
            }}
            title="Account & settings"
            aria-label="Account & settings"
          >
            <UserIcon size={18} />
          </button>
          {openPopover === "user" ? (
            <div className="popover userPopover">
              <div className="userCard">
                <span className="userAvatar" aria-hidden="true">
                  {authUser.is_guest
                    ? <UserIcon size={20} />
                    : <span className="userAvatarInitial">{authUser.user.charAt(0).toUpperCase()}</span>}
                </span>
                <span className="userCardMeta">
                  <span className="userCardName">{authUser.is_guest ? "Guest" : authUser.user}</span>
                  <span className="userCardRole">{authUser.is_guest ? "Temporary workspace" : "Signed in"}</span>
                </span>
                {quotaInfo ? (
                  <span className="userCardQuota" title="Storage used by your uploaded PDFs and images">
                    {fmtBytes(quotaInfo.used_bytes)}
                    {quotaInfo.quota_mb ? ` / ${fmtBytes(quotaInfo.quota_mb * 1024 * 1024)}` : ""}
                  </span>
                ) : null}
              </div>
              {authUser.is_guest ? (
                <div className="popoverHint">Guest data resets daily. Ask the admin for an account to keep your work.</div>
              ) : null}
              {quotaInfo?.quota_mb ? (
                <div className="popoverQuota">
                  <QuotaMeter usedBytes={quotaInfo.used_bytes} quotaMb={quotaInfo.quota_mb} barOnly />
                </div>
              ) : null}
              <div className="popoverDivider" />
              <button className="popoverItem" onClick={() => { setSettingsOpen("general"); setOpenPopover(null); }}>
                <SettingsIcon className="popoverItemIcon" size={15} />
                Settings…
              </button>
              {/* Both land in Settings → Users: your row carries the
                  Export/Import menus, admins see every account. */}
              <button
                className="popoverItem"
                onClick={() => { setSettingsOpen("users"); setOpenPopover(null); }}
                title="Download a backup of this account, or restore one"
              >
                <DatabaseIcon className="popoverItemIcon" size={15} />
                Backup &amp; restore…
              </button>
              {authUser.is_admin ? (
                <button
                  className="popoverItem"
                  onClick={() => { setSettingsOpen("users"); setOpenPopover(null); }}
                  title="Accounts, storage limits, and backup/restore for any of them"
                >
                  <UsersIcon className="popoverItemIcon" size={15} />
                  Manage users…
                </button>
              ) : null}
              <div className="popoverDivider" />
              <button className="popoverItem popoverItemDanger" onClick={doLogout}>
                <LogOutIcon className="popoverItemIcon" size={15} />
                Log out
              </button>
            </div>
          ) : null}
        </span>
      )}
      {renderOverflowMenu(false)}
    </>
  );

  return (
    <div
      ref={appRef}
      className={`app layout-horizontal ${readOnly ? "readOnlyMode" : ""} ${pseudoFullscreen ? "pseudoFullscreen" : ""} ${isPhone ? "phoneUI" : ""}`}
      onDragOver={readOnly ? undefined : (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
        e.preventDefault();
        if (e.target.closest(".blockRowWrap")) {
          appRef.current?.classList.remove("dragOver");
        } else {
          appRef.current?.classList.add("dragOver");
        }
      }}
      onDragLeave={readOnly ? undefined : (e) => {
        if (e.currentTarget === e.target) appRef.current?.classList.remove("dragOver");
      }}
      onDrop={readOnly ? undefined : (e) => {
        appRef.current?.classList.remove("dragOver");
        if (!e.dataTransfer) return;
        // Grab entries synchronously — the DataTransfer is neutered once the
        // handler returns. Folders only arrive via the entry API.
        const entries = Array.from(e.dataTransfer.items || [])
          .map((it) => it.webkitGetAsEntry?.())
          .filter(Boolean);
        if (entries.some((en) => en.isDirectory)) {
          e.preventDefault();
          collectEntryFiles(entries).then((found) => uploadFiles(found));
          return;
        }
        const files = Array.from(e.dataTransfer.files || [])
          .filter((file) => isPdfFile(file) || isMarkdownFile(file));
        if (!files.length) return;
        e.preventDefault();
        uploadFiles(files);
      }}
    >
      {!readOnly ? (
        <>
          <div className="topbar">
            <button
              className={`iconBtn homeBtn ${homeMode ? "activeIcon" : ""}`}
              onClick={goHome}
              title="Home"
              aria-label="Home"
            >
              <HomeIcon size={17} />
            </button>
            {navStackLen > 0 ? (
              <button
                className="iconBtn navBackBtn"
                onClick={goBackNav}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setNavStack([]);
                }}
                title={`Back to where you were${navStackLen > 1 ? ` (${navStackLen} steps)` : ""} — Alt+← · right-click to clear`}
                aria-label="Back"
              >
                <ArrowLeftIcon size={17} strokeWidth={2.2} />
                <span className="navBackBadge">{Math.min(navStackLen, 30)}</span>
              </button>
            ) : null}
            <OpenTabs
              tabs={openTabs}
              activeId={focusedBlockId}
              tabElements={tabElsRef}
              onReorder={(dragged, target) =>
                updateTabs((prev) => {
                  const from = prev.findIndex((tab) => tab.id === dragged);
                  const to = prev.findIndex((tab) => tab.id === target);
                  if (from < 0 || to < 0 || from === to) return prev;
                  // Dragging never crosses the pinned/unpinned boundary.
                  if (!!prev[from].pinned !== !!prev[to].pinned) return prev;
                  const next = [...prev];
                  const [moved] = next.splice(from, 1);
                  next.splice(to, 0, moved);
                  return next;
                })
              }
              onOpen={(id) => openBlock(id, { restoreScroll: true })}
              onClose={closeTab}
              onContext={(tab, x, y) => setTabMenu({ id: tab.id, pinned: !!tab.pinned, x, y })}
            />
            {isPhone ? null : topbarActions}
          </div>
          {statusBarVisible ? <div className="status">{status}</div> : null}
        </>
      ) : (
        <div className="topbar">
          <button className="iconBtn homeBtn" disabled title="Home" aria-label="Home">
            <HomeIcon size={17} />
          </button>
          <span className="readOnlyTitle">{pdfTitle}</span>
          {renderOverflowMenu(true)}
        </div>
      )}

      {attachModeBlockId && (
        <div className="attachModeBanner">
          Click a PDF highlight to link it
          <button
            onClick={() => {
              setAttachModeBlockId(null);
              setAttachContextMenu(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {attachContextMenu && (
        <ContextMenu
          x={attachContextMenu.x}
          y={attachContextMenu.y}
          onClose={() => setAttachContextMenu(null)}
        >
          <button
            className="ctxMenuItem"
            onClick={() => linkHighlightToBlock(attachModeBlockId, attachContextMenu.highlight)}
          >
            Link highlight here
          </button>
        </ContextMenu>
      )}
      {transMenu && (
        <ContextMenu x={transMenu.x} y={transMenu.y} onClose={() => setTransMenu(null)}>
          {pdfTransState.running ? (
            <MenuItem icon={XIcon} onClick={() => { setTransMenu(null); pdfTranslateCtl.current?.halt(); }}>
              Stop translating
            </MenuItem>
          ) : (
            <>
              <MenuItem icon={FileIcon} onClick={() => { setTransMenu(null); pdfTranslateCtl.current?.translatePage(); }}>
                Translate this page
              </MenuItem>
              <MenuItem icon={BookIcon} onClick={() => { setTransMenu(null); pdfTranslateCtl.current?.translateDoc(); }}>
                Translate whole document
              </MenuItem>
            </>
          )}
          {pdfTransState.pages > 0 ? (
            <MenuItem icon={pdfTransState.shown ? EyeOffIcon : EyeIcon}
              onClick={() => { setTransMenu(null); pdfTranslateCtl.current?.setShown(!pdfTransState.shown); }}>
              {pdfTransState.shown ? "Show original" : "Show translation"}
            </MenuItem>
          ) : null}
        </ContextMenu>
      )}

      <div className="workArea">
        <PanelGroup
          direction="horizontal"
          autoSaveId="gamma-work-h"
          ref={(h) => {
            panelGroupRefs.current["work-h"] = h;
          }}
        >
          {slotWins("left").length ? (
            <>
              <Panel id="slot-left" order={1} defaultSize={26} minSize={15} className="dockSlot">
                {renderSlotGroup("left", "vertical")}
              </Panel>
              <PanelResizeHandle className="sash sash-horizontal" />
            </>
          ) : null}
          <Panel id="slot-center" order={2} minSize={30} className="dockSlot">
            <PanelGroup
              direction="vertical"
              autoSaveId="gamma-work-v"
              ref={(h) => {
                panelGroupRefs.current["work-v"] = h;
              }}
            >
              <Panel id="slot-main" order={1} minSize={20} className="dockSlot">
                <div className={`main ${pdfHidden || homeMode || pageOnly ? "pdfHidden" : ""}`}>
                  {pillShown ? (
                    <div
                      className={
                        "statusPill" +
                        (pillShown.fading ? " fading" : "") +
                        (pillShown.error ? " error" : "") +
                        (pillShown.retry ? " interactive" : "")
                      }
                      role="status"
                    >
                      {pillShown.spinner ? <span className="pillSpin" aria-hidden="true" /> : null}
                      <span className="pillText">{pillShown.msg}</span>
                      {pillShown.retry ? (
                        <button
                          type="button"
                          className="pillRetryBtn"
                          onClick={() => pdfRetryRef.current?.()}
                        >
                          Retry
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  <div
                    className={`viewerWrap ${pdfHidden || homeMode || pageOnly ? "pdfHidden" : ""}`}
                    ref={viewerWrapRef}
                  >
                    {pdfUrl && !pdfHidden ? (
                      <button
                        className="uiClose uiCloseLg pdfCloseBtn"
                        onClick={() => setPdfHidden(true)}
                        title="Close PDF"
                        aria-label="Close PDF"
                      >
                        ×
                      </button>
                    ) : null}
                    {pdfUrl && !pdfHidden ? (
                      <div className="pdfCtlBox pdfZoomOverlay">
                        <button onClick={() => zoomStep(-1)} title="Zoom out" aria-label="Zoom out">
                          <ZoomOutIcon size={15} />
                        </button>
                        <button onClick={() => zoomStep(1)} title="Zoom in" aria-label="Zoom in">
                          <ZoomInIcon size={15} />
                        </button>
                        <button
                          className="pdfFitWidthBtn"
                          onClick={() => zoomTo("page-width")}
                          title="Fit to width"
                          aria-label="Fit to width"
                        >
                          <FitWidthIcon size={15} />
                        </button>
                        {translateEnabled && !readOnly ? (
                          <button
                            className={pdfTransState.running || (pdfTransState.pages > 0 && pdfTransState.shown) ? "modeActive" : ""}
                            onClick={() => {
                              if (transLongFiredRef.current) { transLongFiredRef.current = false; return; }
                              if (pdfTransState.running) { pdfTranslateCtl.current?.halt(); return; }
                              if (pdfTransState.pages > 0) { pdfTranslateCtl.current?.setShown(!pdfTransState.shown); return; }
                              pdfTranslateCtl.current?.translatePage();
                            }}
                            onContextMenu={(e) => { e.preventDefault(); openTransMenu(e.currentTarget); }}
                            onPointerDown={(e) => {
                              if (e.pointerType === "mouse") return;
                              const el = e.currentTarget;
                              clearTimeout(transLongRef.current);
                              transLongRef.current = setTimeout(() => { transLongFiredRef.current = true; openTransMenu(el); }, 500);
                            }}
                            onPointerUp={() => clearTimeout(transLongRef.current)}
                            onPointerCancel={() => clearTimeout(transLongRef.current)}
                            title={pdfTransState.running
                              ? `Translating… ${Math.round(pdfTransState.progress * 100)}% — click to stop (right-click for options)`
                              : pdfTransState.pages > 0
                                ? (pdfTransState.shown
                                    ? `Hide the translation (all pages; hold ${ALT_LABEL} to peek at the original) — right-click for options`
                                    : "Show the translation — right-click for options")
                                : `Translate this page into ${translateLangLabel} — right-click: whole document & options`}
                            aria-label={pdfTransState.running ? "Stop translating"
                              : pdfTransState.pages > 0 ? (pdfTransState.shown ? "Hide translation" : "Show translation")
                              : "Translate"}
                          >
                            {pdfTransState.running
                              ? <span className="pillSpin" aria-hidden="true" />
                              : pdfTransState.pages > 0 && !pdfTransState.shown
                                ? <LanguagesOffIcon size={15} />
                                : <LanguagesIcon size={15} />}
                          </button>
                        ) : null}
                        {translateEnabled && !readOnly && pdfTransState.running ? (
                          <div className="pdfTransPct">{Math.round(pdfTransState.progress * 100)}%</div>
                        ) : null}
                        {!readOnly ? (
                          <button
                            className={areaSelectMode ? "modeActive" : ""}
                            onClick={() => setAreaSelectMode((v) => !v)}
                            title={
                              areaSelectMode
                                ? "Rectangle mode — drag draws an area screenshot (click to switch to text selection)"
                                : "Text mode — drag selects text (click to switch to rectangle drawing)"
                            }
                            aria-label="Toggle selection mode"
                          >
                            {areaSelectMode ? (
                              <RectSelectIcon size={15} />
                            ) : (
                              <TextCursorIcon size={15} />
                            )}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {pdfUrl && !pdfHidden ? (
                      <div className="pdfCtlBox pdfFullscreenBox">
                        <button
                          onClick={toggleFullscreen}
                          title={
                            isFullscreen || pseudoFullscreen ? "Exit full screen" : "Full screen"
                          }
                          aria-label={
                            isFullscreen || pseudoFullscreen ? "Exit full screen" : "Full screen"
                          }
                        >
                          {isFullscreen || pseudoFullscreen ? (
                            <MinimizeIcon size={15} />
                          ) : (
                            <MaximizeIcon size={15} />
                          )}
                        </button>
                      </div>
                    ) : null}
                    {pdfUrl ? (
                      <PdfViewer
                        url={pdfUrl}
                        highlights={highlights}
                        noteBadges={hlNoteBadges}
                        hideEmbeddedAnnots={embAnnots === "hide"}
                        snapVertical={snapVertical}
                        darkPage={pdfDarkPage}
                        translateKey={`${translateLang}|${translateSendModel}`}
                        translateParallel={translateParallel}
                        onTranslate={readOnly ? undefined : translateChunk}
                        translateCtlRef={pdfTranslateCtl}
                        onTranslateState={readOnly ? undefined : handleTranslateState}
                        areaMode={areaSelectMode && !readOnly}
                        pdfScaleValue={pdfScale}
                        scrollRef={scrollToRef}
                        searchRef={pdfSearchRef}
                        captureRef={pdfCaptureRef}
                        findMarks={findMarks}
                        onEffectiveScale={setPdfEffScale}
                        onZoomTo={zoomTo}
                        onBeforeLinkJump={pushNav}
                        onLoadState={handlePdfLoadState}
                        retryRef={pdfRetryRef}
                        onExternalLink={handleDocLink}
                        onLinkContext={setLinkPrompt}
                        onLinkHighlight={(h) => {
                          if (h.linkTarget?.pageId) {
                            if (h.linkTarget.highlightId)
                              pendingJumpRef.current = h.linkTarget.highlightId;
                            openBlock(h.linkTarget.pageId, { pushNav: true });
                          } else if (h.linkTarget?.url) handleDocLink(h.linkTarget.url);
                        }}
                        onJump={jumpToHighlightId}
                        onHighlightJump={(hlId, additive) => {
                          const b = flattenBlocks(blocks).find(
                            (b) => b.properties?.highlight_id === hlId,
                          );
                          if (b) {
                            pendingBlockScrollRef.current = b.id;
                            setBlocks((prev) => expandToBlock(prev, b.id));
                          }
                          // Clicking a highlight also feeds the chat: quote as the
                          // selection (Ctrl+click appends), area rects as an image.
                          addHighlightToChat(
                            highlights.find((h) => h.id === hlId),
                            additive,
                          );
                        }}
                        onHighlightContext={setHighlightMenu}
                        onAreaSelection={addChatImage}
                        onSelectionFinished={
                          readOnly
                            ? undefined
                            : (position, content, hideTip, extras) => {
                                if (extras?.link) {
                                  setLinkDialog({ position, content });
                                  setLinkDialogInput("");
                                  hideTip?.();
                                  return;
                                }
                                addHighlight({
                                  content: content || { text: "" },
                                  position,
                                  comment: { text: extras?.commentText || "" },
                                  color: extras?.color || COLORS[0],
                                });
                                hideTip?.();
                              }
                        }
                      />
                    ) : (
                      <div className="status">No PDF open.</div>
                    )}
                  </div>

                  {centerNotes ? notesWindow : null}
                </div>
              </Panel>
              {slotWins("bottom").length ? (
                <>
                  <PanelResizeHandle className="sash sash-vertical" />
                  <Panel
                    id="slot-bottom"
                    order={2}
                    defaultSize={32}
                    minSize={12}
                    className="dockSlot"
                  >
                    {renderSlotGroup("bottom", "horizontal")}
                  </Panel>
                </>
              ) : null}
            </PanelGroup>
          </Panel>
          {slotWins("right").length ? (
            <>
              <PanelResizeHandle className="sash sash-horizontal" />
              <Panel id="slot-right" order={3} defaultSize={28} minSize={15} className="dockSlot">
                {renderSlotGroup("right", "vertical")}
              </Panel>
            </>
          ) : null}
        </PanelGroup>
        {/* Phone: the notes overlay stays mounted like the desktop sidebar —
          hidden via visibility (not display) so the blockList keeps real
          layout and scrollTop, and the shared capture/restore logic works
          unchanged. */}
        {isPhone && winVisible.notes ? (
          <div
            className="phonePanel"
            style={{
              visibility: phonePanel === "notes" ? "visible" : "hidden",
              pointerEvents: phonePanel === "notes" ? "auto" : "none",
            }}
          >
            {renderWindow("notes")}
          </div>
        ) : null}
        {isPhone && !readOnly && (phonePanel === "chat" || phoneSeen.current.chat) ? (
          <div className={`phonePanel ${phonePanel === "chat" ? "" : "phonePanelHidden"}`}>
            {renderWindow("chat")}
          </div>
        ) : null}
      </div>
      {isPhone && (!centerNotes || !readOnly) ? (
        // Phone: one bottom bar — view tabs on the left, the topbar's action
        // buttons on the right. Icon-only, because both groups share the row.
        <div className="phoneBottomBar">
          <div className={`phoneTabBar ${readOnly ? "" : "hasActions"}`}>
            <button
              className={`phoneTab ${phonePanel === null || (phonePanel === "notes" && centerNotes) ? "active" : ""}`}
              onClick={() => setPhonePanel(null)}
              title={homeMode ? "Library" : centerNotes ? "Notes" : "PDF"}
              aria-label={homeMode ? "Library" : centerNotes ? "Notes" : "PDF"}
            >
              {homeMode ? <HomeIcon size={16} /> : centerNotes ? <FileTextIcon size={16} /> : <FileIcon size={16} />}
              <span>{homeMode ? "Library" : centerNotes ? "Notes" : "PDF"}</span>
            </button>
            {!centerNotes ? (
              <button
                className={`phoneTab ${phonePanel === "notes" ? "active" : ""}`}
                onClick={() => { setNotesVisible(true); setPhonePanel((p) => (p === "notes" ? null : "notes")); }}
                title="Notes"
                aria-label="Notes"
              >
                <FileTextIcon size={16} />
                <span>Notes</span>
              </button>
            ) : null}
            {!readOnly ? (
              <button
                className={`phoneTab ${phonePanel === "chat" ? "active" : ""}`}
                onClick={() => setPhonePanel((p) => (p === "chat" ? null : "chat"))}
                title="AI chat"
                aria-label="AI chat"
              >
                <SparklesIcon size={16} />
                <span>Chat</span>
              </button>
            ) : null}
          </div>
          {/* keeps the .topbar class so every ".topbar X" style still applies */}
          {!readOnly ? <div className="topbar phoneActions">{topbarActions}</div> : null}
        </div>
      ) : null}
      {dockPreview ? (
        <div className="dockPreview" style={dockPreview} />
      ) : null}
      {importOpen ? (
        <ImportDialog
          hasPdf={!!docId && !!focusedBlockId}
          stripDefault={embAnnots === "strip"}
          busy={loading}
          allowGamma={!authUser?.is_guest}
          onCancel={() => setImportOpen(false)}
          onImport={runImport}
        />
      ) : null}
      {exportOpen ? (
        <ExportDialog
          opts={exportOpts}
          setOpts={setExportOpts}
          hasPdf={!!pdfUrl && !exportFolder}
          pdfStored={!!docId}
          folder={exportFolder}
          allowGamma={!readOnly}
          onCancel={() => setExportOpen(false)}
          onExport={runExport}
        />
      ) : null}
      {confirmBox ? (
        // data-popover keeps an open popover (e.g. search) alive while the dialog is up
        <div className="reportOverlay" data-popover="confirm" onClick={() => setConfirmBox(null)}>
          <div
            className="reportModal confirmModal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setConfirmBox(null); } }}
          >
            <div className="confirmHead">
              <span className={`confirmIcon ${confirmBox.danger ? "danger" : ""}`}>
                {confirmBox.danger ? <AlertCircleIcon size={16} /> : <InfoIcon size={16} />}
              </span>
              <span className="settingText">
                <span className="reportModalTitle">{confirmBox.title}</span>
                <span className="confirmMessage">{confirmBox.message}</span>
              </span>
            </div>
            <div className="reportModalBtns">
              <button className="uiBtn" onClick={() => setConfirmBox(null)} autoFocus>Cancel</button>
              {confirmBox.altLabel ? (
                <button
                  className={`uiBtn ${confirmBox.altDanger ? "dangerBtn" : ""}`}
                  onClick={() => { const fn = confirmBox.onAlt; setConfirmBox(null); fn?.(); }}
                >{confirmBox.altLabel}</button>
              ) : null}
              <button
                className={`uiBtn primary ${confirmBox.danger ? "dangerBtn" : ""}`}
                onClick={() => {
                  const fn = confirmBox.onConfirm;
                  setConfirmBox(null);
                  fn?.();
                }}
              >
                {confirmBox.confirmLabel || "OK"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {labelRenaming ? (
        <div className="reportOverlay" onClick={() => setLabelRenaming(null)}>
          <div className="reportModal confirmModal" onClick={(e) => e.stopPropagation()}>
            <div className="reportModalTitle">Rename label</div>
            <div className="reportModalHint confirmMessage">
              Renames “{labelRenaming.name}” on every page that carries it.
            </div>
            <div className="shareRow">
              <input
                autoFocus
                value={labelRenaming.draft}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setLabelRenaming((s) => ({ ...s, draft: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") renameLabel(labelRenaming.name, labelRenaming.draft);
                  else if (e.key === "Escape") setLabelRenaming(null);
                }}
              />
              <button
                className="uiBtn primary"
                disabled={!labelRenaming.draft.trim()}
                onClick={() => renameLabel(labelRenaming.name, labelRenaming.draft)}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {linkPrompt ? (
        <div className="reportOverlay" onClick={() => setLinkPrompt(null)}>
          <div className="reportModal confirmModal linkPromptModal" onClick={(e) => e.stopPropagation()}>
            <div className="confirmHead">
              <span className="confirmIcon"><LinkIcon size={16} /></span>
              <span className="settingText">
                <span className="reportModalTitle">External link</span>
                <span className="confirmMessage">Open this link in a new browser tab, or pull the paper into your library.</span>
              </span>
            </div>
            <div className="linkPromptUrl">{linkPrompt}</div>
            <div className="reportModalBtns">
              <button className="uiBtn" onClick={() => setLinkPrompt(null)}>Cancel</button>
              {(() => {
                // Right-click always lands here, even for links whose paper is
                // already in the library — offer that copy instead of a re-fetch.
                const pid = findPageForUrl(linkPrompt, homeBlocks);
                return pid ? (
                  <button
                    className="uiBtn"
                    onClick={() => { setLinkPrompt(null); openBlock(pid, { pushNav: true }); }}
                    title="This paper is already in your library"
                  ><FileTextIcon size={13} />Open in Gamma</button>
                ) : (
                  <button
                    className="uiBtn"
                    onClick={() => { const url = linkPrompt; setLinkPrompt(null); pushNav(); openPdf(url); }}
                    title="Resolve this link as a PDF and open it as a new paper in Gamma"
                  ><DownloadIcon size={13} />Fetch into Gamma</button>
                );
              })()}
              <button
                className="uiBtn primary"
                onClick={() => { window.open(linkPrompt, "_blank", "noopener"); setLinkPrompt(null); }}
              ><ExternalLinkIcon size={13} />Open in browser</button>
            </div>
          </div>
        </div>
      ) : null}
      {linkDialog ? (
        <div className="reportOverlay" onClick={() => setLinkDialog(null)}>
          <div className="reportModal confirmModal" onClick={(e) => e.stopPropagation()}>
            <div className="reportModalTitle">
              {linkDialog.editBlockId ? "Change reference link" : "Link reference to a paper"}
            </div>
            {linkDialog.content?.text ? (
              <div className="reportModalHint linkRefQuote">
                “{linkDialog.content.text.slice(0, 160)}
                {linkDialog.content.text.length > 160 ? "…" : ""}”
              </div>
            ) : null}
            <div className="reportModalHint">
              Paste a DOI, arXiv id, or URL — or pick one of your papers. The selection becomes a
              clickable link on the PDF.
            </div>
            <div className="shareRow">
              <input
                autoFocus
                placeholder="10.1103/…  ·  1810.11086  ·  https://…"
                value={linkDialogInput}
                onChange={(e) => setLinkDialogInput(e.target.value)}
                onKeyDown={(e) => {
                  if (isEnterCommit(e) && linkDialogInput.trim()) {
                    e.preventDefault();
                    createLinkHighlight({ url: normalizeLinkInput(linkDialogInput) });
                  } else if (e.key === "Escape") {
                    setLinkDialog(null);
                  }
                }}
              />
              <button
                className="uiBtn primary"
                disabled={!linkDialogInput.trim()}
                onClick={() => createLinkHighlight({ url: normalizeLinkInput(linkDialogInput) })}
              >
                Link
              </button>
            </div>
            {refPoint && refPoint.pageId !== focusedBlockId ? (
              <>
                <div className="popoverSection">Copied reference point</div>
                <button
                  className="reportPageItem linkPageItem"
                  onClick={() =>
                    createLinkHighlight({
                      pageId: refPoint.pageId,
                      highlightId: refPoint.highlightId,
                    })
                  }
                  title="Link to this exact highlight — clicking the link opens the paper and jumps to it"
                >
                  <span className="reportPageName">
                    {refPoint.pageTitle} — “{refPoint.quote.slice(0, 60)}
                    {refPoint.quote.length > 60 ? "…" : ""}”
                  </span>
                  <span className="linkLikelyBadge">highlight</span>
                </button>
              </>
            ) : null}
            <div className="popoverSection">Your papers (best match first)</div>
            <div className="reportPageList">
              {(() => {
                const cands = homeBlocks
                  .filter((b) => b.properties?.doc_id && b.id !== focusedBlockId)
                  .map((b) => ({ b, score: scorePaperMatch(linkDialog.content?.text || "", b) }))
                  .sort(
                    (x, y) =>
                      y.score - x.score ||
                      (y.b.updated_at || "").localeCompare(x.b.updated_at || ""),
                  );
                if (!cands.length)
                  return <div className="popoverHint">No other PDFs in your library yet.</div>;
                return cands.map(({ b, score }) => (
                  <button
                    key={b.id}
                    className="reportPageItem linkPageItem"
                    onClick={() => createLinkHighlight({ pageId: b.id })}
                  >
                    <span className="reportPageName">{b.content || "Untitled"}</span>
                    {score >= 6 ? <span className="linkLikelyBadge">likely</span> : null}
                  </button>
                ));
              })()}
            </div>
            <div className="reportModalBtns">
              {linkDialog.editBlockId ? (
                <button className="uiBtn" onClick={() => createLinkHighlight({})} title="Turn this back into a plain highlight">Remove link</button>
              ) : null}
              <button className="uiBtn" onClick={() => setLinkDialog(null)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
      <SettingsDialog
        activePane={settingsOpen}
        onPaneChange={setSettingsOpen}
        onClose={() => setSettingsOpen(null)}
        papers={{
          theme,
          setTheme,
          oaFallback,
          setOaFallback,
          metaAutoFetch,
          setMetaAutoFetch,
          pdfSaveLocal,
          setPdfSaveLocal,
          embAnnots,
          setEmbAnnots,
          snapVertical,
          setSnapVertical,
          translateEnabled,
          setTranslateEnabled,
          translateLang,
          setTranslateLang,
          translateModel,
          setTranslateModel,
          translateEffort,
          setTranslateEffort,
          translateParallel,
          setTranslateParallel,
          aiModels: scopedAiModels, // the Translation-model picker's registry
          pdfDarkPage,
          setPdfDarkPage,
          recentThumbs,
          setRecentThumbs,
          fileLabels,
          setFileLabels,
          isAdmin: !!authUser?.is_admin,
          setStatus,
          refreshQuota, // keep the client-side pre-upload size check in sync without a re-login
        }}
        notes={{
          enterNewNote,
          setEnterNewNote,
          hlNoteBadges,
          setHlNoteBadges,
        }}
        library={{
          // batch metadata retry uses the same prompt/model/context prefs as
          // the per-paper fetch in the metadata popover
          metaPrompt,
          metaFetchModel,
          metaContextChars,
          indexTask,
          setStatus,
          // Zotero library import: annotations embedded in the exported PDFs
          // follow the standing strip-vs-hide viewer preference
          stripAnnots: embAnnots === "strip",
          onLibraryChange: fetchHomeBlocks,
        }}
        ai={{
          aiKeysInfo,
          aiKeysError,
          setAiKeysError,
          aiKeysBusy,
          aiKeysForm,
          setAiKeysForm,
          aiProvider,
          setAiProvider,
          aiModelCatalog,
          formOauthPending,
          formModels,
          availModels,
          customModel,
          setCustomModel,
          aiProtocolOf,
          isOauthProto,
          startAddAiProvider,
          startEditAiProvider,
          deleteAiProvider,
          aiKeyTests,
          testAiProvider,
          aiKeyUsage,
          queryAiProviderUsage,
          aiLoginCheck,
          setAiLoginCheck,
          metaModel,
          setMetaModel,
          aiModels: scopedAiModels,
          dictationModel,
          setDictationModel,
          dictationLang,
          setDictationLang,
          startChatGPTAuth,
          loadModelCatalog,
          addCatalogModel,
          removeModel,
          submitAiProvider,
        }}
        prompts={{
          aiInfo,
          chatSystem,
          metaPrompt,
          citePrompt,
          promptDraft,
          setPromptDraft,
          metaPromptDraft,
          setMetaPromptDraft,
          citePromptDraft,
          setCitePromptDraft,
          agentSystem,
          agentPromptDraft,
          setAgentPromptDraft,
          savePrompts: () => {
            const normalizePrompt = (draft, defaultValue) => {
              const value = (draft || "").trim();
              return value === (defaultValue || "").trim() ? "" : value;
            };
            setChatSystem(normalizePrompt(promptDraft, aiInfo?.default_prompt));
            setMetaPrompt(normalizePrompt(metaPromptDraft, aiInfo?.metadata_prompt));
            setCitePrompt(normalizePrompt(citePromptDraft, aiInfo?.cite_prompt));
            setAgentSystem(normalizePrompt(agentPromptDraft, aiInfo?.agent_prompt));
            setStatus("Prompts saved.");
          },
        }}
        context={{
          chatImgAutoClear,
          setChatImgAutoClear,
          chatContextChars,
          setChatContextChars,
          metaContextChars,
          setMetaContextChars,
          multiContextChars,
          setMultiContextChars,
          toolRounds,
          setToolRounds,
          agentReadChars,
          setAgentReadChars,
          agentPerms,
          setAgentPerms,
          agentEnabled,
          setAgentEnabled,
          folderToolsDefault,
          setFolderToolsDefault,
          pdfToolsDefault,
          setPdfToolsDefault,
          reset: () => {
            setChatContextChars(8000);
            setMetaContextChars(6000);
            setMultiContextChars(18000);
            setStatus("AI context limits reset.");
          },
        }}
        search={{ searchDetailsHome, setSearchDetailsHome, searchDetailsPaper, setSearchDetailsPaper, indexTask, setStatus }}
        users={authUser?.user ? {
          // Everyone gets this pane for their own backups; only admins see
          // the other accounts and the account editor.
          isAdmin: !!authUser?.is_admin,
          me: authUser.user,
          isGuest: !!authUser?.is_guest,
          quotaInfo,
          exportUserData,
          importUserData,
          setStatus,
          confirm: setConfirmBox,
          closeSettings: () => setSettingsOpen(null),
          onSelfRenamed: checkSession, // self-rename re-keys the whole app
          refreshQuota,
        } : null}
        diagnostics={{ statusBarVisible, setStatusBarVisible, sysLog, setStatus, isAdmin: !!authUser?.is_admin, debugLog, setDebugLog }}
      />
      {tabMenu ? (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} onClose={() => setTabMenu(null)}>
          <button
            className="ctxMenuItem ctxMenuItemIconed"
            onClick={() => {
              setTabMenu(null);
              toggleTabPinned(tabMenu.id);
            }}
          >
            <span className="ctxMenuIcon">
              <PinIcon filled={!tabMenu.pinned} size={13} />
            </span>
            {tabMenu.pinned ? "Unpin tab" : "Pin tab"}
          </button>
          <button
            className="ctxMenuItem ctxMenuItemIconed"
            onClick={() => {
              setTabMenu(null);
              closeTab(tabMenu.id);
            }}
          >
            <span className="ctxMenuIcon">
              <XIcon size={13} />
            </span>
            Close tab
          </button>
        </ContextMenu>
      ) : null}
      {homeMenu ? (
        <ContextMenu x={homeMenu.x} y={homeMenu.y} onClose={() => setHomeMenu(null)}>
          {homeMenu.kind === "page" ? (
            (() => {
              // Acting on a selected card acts on the whole selection
              const ids =
                selectedPages.size > 1 && selectedPages.has(homeMenu.id)
                  ? [...selectedPages]
                  : [homeMenu.id];
              const many = ids.length > 1;
              const allPinned = ids.every((id) => pageBlocks.find((b) => b._pageId === id)?._pinned);
              // Folder tags the acted-on pages already carry — offered for
              // removal alongside the current folder view.
              const ownTags = [...new Set(ids.flatMap((id) => pageBlocks.find((b) => b._pageId === id)?._folders || []))];
              return (
                <>
                  {!many ? (
                    <MenuItem icon={ExternalLinkIcon} onClick={() => { setHomeMenu(null); openPage(homeMenu.id); }}>Open</MenuItem>
                  ) : null}
                  {!many ? (
                    <MenuItem icon={PenIcon} onClick={() => { setHomeMenu(null); clearSelection(); setHomeEditingId(homeMenu.id); }}>Rename</MenuItem>
                  ) : null}
                  <MenuItem icon={PinIcon} onClick={() => { setHomeMenu(null); setPagesPinned(ids, !allPinned); }}>
                    {allPinned ? "Unpin" : many ? `Pin ${ids.length} pages` : "Pin"}
                  </MenuItem>
                  <MenuItem icon={CopyIcon} onClick={() => { setHomeMenu(null); duplicatePages(ids); }}>{many ? `Duplicate ${ids.length} pages` : "Duplicate"}</MenuItem>
                  <SubMenuItem
                    id="folders"
                    icon={FolderIcon}
                    label="Move to folder"
                    title="A paper can sit in several folders — this adds it to the one you pick (same as dragging it onto the folder)."
                  >
                    {folderMenuPaths.length ? folderMenuPaths.map((f) => (
                      <MenuItem
                        key={f}
                        icon={FolderIcon}
                        title={ownTags.includes(f) ? `Already in ${f}` : f}
                        trailing={ownTags.includes(f) ? <CheckIcon size={14} className="ctxMenuCheck" /> : null}
                        onClick={() => { setHomeMenu(null); addPagesToFolder(ids, f); }}
                      >{f}</MenuItem>
                    )) : (
                      <MenuItem disabled>No folders yet</MenuItem>
                    )}
                    {folderFilter || ownTags.length ? <MenuLabel>Remove from</MenuLabel> : null}
                    {folderFilter ? (
                      <MenuItem icon={FolderOpenIcon} onClick={() => { setHomeMenu(null); removePagesFromFolder(ids, folderFilter); }}>{`“${folderFilter}”`}</MenuItem>
                    ) : null}
                    {ownTags.filter((f) => f !== folderFilter).map((f) => (
                      <MenuItem key={`rm:${f}`} icon={FolderOpenIcon} title={f} onClick={() => { setHomeMenu(null); removePagesFromFolder(ids, f); }}>{`“${f}”`}</MenuItem>
                    ))}
                    {folderFilter || ownTags.length ? (
                      <MenuItem icon={XIcon} onClick={() => { setHomeMenu(null); removePagesFromFolder(ids, ""); }}>All folders</MenuItem>
                    ) : null}
                  </SubMenuItem>
                  <MenuItem icon={TrashIcon} danger onClick={() => { setHomeMenu(null); deletePages(ids); }}>{many ? `Delete ${ids.length} pages` : "Delete"}</MenuItem>
                </>
              );
            })()) : homeMenu.kind === "label" ? (
              <>
                <MenuItem icon={LabelIcon} onClick={() => { const name = homeMenu.name; setHomeMenu(null); if (!homeMode) goHome(); openLabel(name, homeMode ? folderFilter : ""); }}>Open</MenuItem>
                <MenuItem icon={PenIcon} onClick={() => { setHomeMenu(null); setLabelRenaming({ name: homeMenu.name, draft: homeMenu.name }); }}>Rename</MenuItem>
                <MenuItem icon={TrashIcon} danger onClick={() => { setHomeMenu(null); deleteLabelByName(homeMenu.name); }}>Delete</MenuItem>
              </>
            ) : (
              <>
                <MenuItem icon={FolderOpenIcon} onClick={() => { const name = homeMenu.name; setHomeMenu(null); if (!homeMode) goHome(); openFolder(name); }}>Open</MenuItem>
                <MenuItem icon={PenIcon} onClick={() => { setHomeMenu(null); setFolderRenaming({ name: homeMenu.name, draft: homeMenu.name }); }}>Rename</MenuItem>
                <MenuItem icon={ExportIcon} onClick={() => quickExportFolder(homeMenu.name)}>Export</MenuItem>
                <MenuItem
                  icon={ExportIcon}
                  title="Choose Markdown, Logseq, or Zotero RDF options"
                  onClick={() => {
                    const name = homeMenu.name;
                    setHomeMenu(null);
                    setExportFolder(name);
                    setExportOpen(true);
                  }}
                >Export as…</MenuItem>
                <MenuItem icon={TrashIcon} danger onClick={() => { setHomeMenu(null); deleteFolderByName(homeMenu.name); }}>Delete</MenuItem>
              </>
            )}
        </ContextMenu>
      ) : null}
      {highlightMenu ? (
        <ContextMenu x={highlightMenu.x} y={highlightMenu.y} onClose={() => setHighlightMenu(null)}>
          <div className="colorRow ctxMenuColors">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="colorBtn"
                style={{ background: c }}
                onClick={() => {
                  changeHighlightColor(highlightMenu.id, c);
                  setHighlightMenu(null);
                }}
                title="Change color"
              />
            ))}
          </div>
          <button
            className="ctxMenuItem"
            onClick={() => {
              const blk = flattenBlocks(blocks).find(
                (b) => b.properties?.highlight_id === highlightMenu.id,
              );
              const h = highlights.find((x) => x.id === highlightMenu.id);
              setLinkDialog({
                position: null,
                content: { text: h?.content?.text || "" },
                editBlockId: blk?.id || highlightMenu.id,
              });
              setLinkDialogInput(h?.linkTarget?.url || "");
              setHighlightMenu(null);
            }}
          >
            {highlights.find((x) => x.id === highlightMenu.id)?.linkTarget
              ? "Change link…"
              : "Link to paper…"}
          </button>
          {highlights.find((x) => x.id === highlightMenu.id)?.linkTarget?.url ? (
            <button
              className="ctxMenuItem"
              onClick={() => {
                setLinkPrompt(highlights.find((x) => x.id === highlightMenu.id).linkTarget.url);
                setHighlightMenu(null);
              }}
            >
              Open link in browser…
            </button>
          ) : null}
          <button
            className="ctxMenuItem"
            onClick={() => {
              const h = highlights.find((x) => x.id === highlightMenu.id);
              const blk = flattenBlocks(blocks).find(
                (b) => b.properties?.highlight_id === highlightMenu.id,
              );
              setRefPoint({
                pageId: focusedBlockId,
                pageTitle: pdfTitle || "Untitled",
                highlightId: highlightMenu.id,
                quote: (h?.content?.text || "").slice(0, 200),
              });
              // Also a paste-able deep link: opening it jumps straight to
              // this highlight (in the browser, chat notes, anywhere).
              if (blk) {
                copyText(`${window.location.origin}/?block=${encodeURIComponent(blk.id)}`);
              }
              setHighlightMenu(null);
              setStatus(
                "Reference point copied — paste the link, or pick it in another paper's link dialog.",
              );
            }}
          >
            Copy as reference point
          </button>
          <button
            className="ctxMenuItem"
            onClick={() => {
              deleteHighlight(highlightMenu.id);
              setHighlightMenu(null);
            }}
          >
            Delete
          </button>
        </ContextMenu>
      ) : null}
    </div>
  );
}
