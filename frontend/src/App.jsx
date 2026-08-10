import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import PdfViewer, { COLORS, clampZoom } from "./pdfViewer";
import { API, apiJson, makeId, fmtBytes, getDocIdForUrl, resolvePdfUrl, setExpectedUser, getExpectedUser, usePersistedState, usePersistedFlag } from "./utils";
import {
  BlockDropIndicator,
  ChatMarkdown,
  DockWindow,
  OpenTabs,
  PopoverAnchor,
  useCopied,
} from "./widgets";
import { BlockTree, _dragState } from "./blockTree";
import { ViewToggle } from "./fileBrowser";
import ChatDock from "./chatDock";
import SearchPanel from "./search";
import { ContextMenu } from "./menus";
import {
  ActivityIcon, AlertCircleIcon, ArrowLeftIcon, CheckIcon, CopyIcon, DownloadIcon, ExportIcon,
  ExternalLinkIcon, EyeIcon, FileGlyph, FileHighlightIcon, FileIcon, FileTextIcon, FitWidthIcon, FolderGlyph,
  FolderIcon, FolderOpenIcon, FolderPlusIcon, HomeIcon, ImportIcon, InfoIcon, LabelIcon,
  LinkIcon, LogOutIcon, MaximizeIcon, MenuIcon, MinimizeIcon, PinIcon, PlusIcon,
  RectSelectIcon, SearchIcon, SettingsIcon, SparklesIcon, TextCursorIcon, Trash2Icon, TrashIcon, UploadIcon,
  UserIcon, UsersIcon, XIcon, ZoomInIcon, ZoomOutIcon,
} from "./icons";


import {
  blocksToPageMarkdown,
  setBlockText,
  setBlockEditMode,
  addSiblingBlock,
  addChildBlock,
  indentBlock,
  outdentBlock,
  toggleCollapsed,
  expandToBlock,
  updateBlockTree,
  removeBlockTree,
  flattenBlocks,
  withLegacyAccessors,
  isDescendant,
  findBlockContext,
  extractBlock,
  insertSibling,
  insertChild,
  addHighlightAsBlock,
  blocksToHighlights,
  normalizeBlocks
} from "./logseqPdfModel";
import { loadSession, saveSession, clearSession } from "./sessionState";
import { AuthLoading, LoginPage, SessionConflictPage } from "./LoginPage";
import SettingsDialog from "./settings";
import {
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

// Codec for the AI context-size preferences (chars of extracted PDF text):
// clamp stored values to a sane range, fall back to the default otherwise.
const CONTEXT_CHARS_CODEC = {
  parse: (raw) => {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 100 && value <= 1000000 ? value : undefined;
  },
};

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
const UA_MOBILE = navigator.userAgentData?.mobile
  ?? /iPhone|iPod|Android.+Mobile|Mobile.+Android/i.test(navigator.userAgent);
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

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const initialUrl = params.get("src") || params.get("url") || "";
  const initialShare = params.get("share") || "";
  const initialBlockId = params.get("block") || params.get("page") || "";
  const initialCategory = params.get("category") || "";
  const initialFolder = params.get("folder") || "";
  const readOnly = Boolean(initialShare);

  // Auth state: null=loading, false=logged out, {user, is_guest}=logged in
  const [authUser, setAuthUser] = useState(readOnly ? {user:"_public"} : null);
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginError, setLoginError] = useState("");
  // Username that now owns the browser session when it's no longer this tab's
  // user (someone logged into another account from a second tab) — freezes the
  // tab behind SessionConflictPage until reload.
  const [sessionConflict, setSessionConflict] = useState(null);

  // This tab's real signed-in user — null while loading, logged out, or in a
  // public share view.
  const sessionUser = authUser && authUser.user && authUser.user !== "_public" ? authUser.user : null;

  // Publish this tab's identity: the X-Gamma-User guard header on API calls
  // (utils.js fetch wrapper) plus a localStorage beacon other tabs listen to.
  useEffect(() => {
    setExpectedUser(sessionUser);
    if (sessionUser) {
      try { localStorage.setItem("gamma-active-user", sessionUser); } catch {}
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
    function onMismatch(e) { conflict(e.detail?.user || ""); }
    function onStorage(e) {
      if (e.key === "gamma-active-user" && e.newValue !== null) conflict(e.newValue);
    }
    let lastCheck = 0;
    function onFocus() {
      const now = Date.now();
      if (now - lastCheck < 15000) return;
      lastCheck = now;
      apiJson(`${API}/session`).then((d) => conflict(d.user || "")).catch(() => {});
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
      if (!res.ok) { setLoginError("Invalid credentials"); return; }
      // Re-read the session rather than hand-building the auth state — it
      // carries flags login doesn't return (is_admin).
      await checkSession();
    } catch { setLoginError("Login failed"); }
  }

  async function doGuestLogin() {
    try {
      const res = await fetch(`${API}/login-guest`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) { setLoginError("Guest login failed"); return; }
      const data = await res.json();
      setAuthUser({ user: data.username, is_guest: true });
    } catch { setLoginError("Guest login failed"); }
  }

  // Download an /api/export backup zip. Fetched by hand (not a plain link
  // navigation) so the user sees the two slow parts: the server zipping a big
  // library ("preparing", no byte counter) and the download itself (percent
  // from content-length). Shows in the pill + a background-tasks row.
  async function exportUserData(withUploads) {
    const label = withUploads ? "Export my data" : "Export database";
    const tid = addTransfer({ name: label, kind: "download", info: "preparing…" });
    postPill("backup", { msg: "Preparing export — the server is zipping your data…", spinner: true });
    // The response only starts once the server finished zipping; until then,
    // poll the zipping percent from the export-progress side-channel.
    const zipPoll = setInterval(async () => {
      try {
        const p = await apiJson(`${API}/export-progress`);
        if (p.active && p.total) {
          const pct = Math.min(99, Math.floor((p.done / p.total) * 100));
          postPill("backup", { msg: `Preparing export — zipping… ${pct}% (${fmtBytes(p.done)} of ${fmtBytes(p.total)})`, spinner: true });
          updateTransfer(tid, { info: `zipping… ${pct}%` });
        }
      } catch {}
    }, 500);
    try {
      const res = await fetch(`${API}/export${withUploads ? "" : "?uploads=0"}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      clearInterval(zipPoll);
      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      // Progress lands per ~64 KB network chunk and each pill/transfer update
      // re-renders the whole app — coalesce to visible changes (1% / 200 ms).
      let lastPct = -1, lastUiAt = 0;
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
        updateTransfer(tid, { info: total ? `${fmtBytes(loaded)} / ${fmtBytes(total)}` : fmtBytes(loaded) });
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

  // Restore an "Export my data" zip into this account. mode "replace": notes +
  // settings are replaced by the backup, uploaded files are merged in. mode
  // "merge": only pages/chats missing here are added, existing data wins.
  // Full reload afterwards — every piece of in-memory state (home feed, tabs,
  // chats) is stale after a restore.
  function importUserData(mode = "replace") {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".zip,application/zip";
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) return;
      setConfirmBox(mode === "merge" ? {
        title: "Merge backup",
        message: (
          <>Merge "{f.name}" ({fmtBytes(f.size)}) into the account "{authUser.user}"?
          {" "}Pages and chats from the backup that don't exist here yet will be <b>added</b>.
          {" "}Everything already in this account (including settings) is <b>kept unchanged</b>.</>
        ),
        confirmLabel: "Merge",
        onConfirm: () => runBackupImport(f, mode),
      } : {
        title: "Replace all data",
        message: (
          <>Restore "{f.name}" ({fmtBytes(f.size)}) into the account "{authUser.user}"?
          {" "}<b>ALL current notes, chats, and settings will be REPLACED</b> by the backup.
          {" "}Uploaded PDFs are merged in (nothing is deleted). <b>This cannot be undone.</b></>
        ),
        confirmLabel: "Replace",
        danger: true,
        onConfirm: () => runBackupImport(f, mode),
      });
    };
    inp.click();
  }

  // XMLHttpRequest instead of fetch: it reports upload progress, so a large
  // zip shows a percent while the bytes go up, then an indeterminate
  // "restoring/merging" hint while the server unzips and swaps the databases.
  function runBackupImport(f, mode) {
    const merging = mode === "merge";
    const tid = addTransfer({ name: `${merging ? "Merge" : "Restore"} ${f.name}`.slice(0, 60), kind: "upload", info: "uploading…" });
    const fd = new FormData();
    fd.append("file", f);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/import-data?mode=${mode}`);
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
      postPill("backup", { msg: pct == null ? "Uploading backup…" : `Uploading backup… ${pct}%`, spinner: true });
      if (e.total) updateTransfer(tid, { info: `${fmtBytes(e.loaded)} / ${fmtBytes(e.total)}` });
    };
    xhr.upload.onload = () => {
      postPill("backup", { msg: merging ? "Merging backup into your library…" : "Restoring backup…", spinner: true });
      updateTransfer(tid, { info: merging ? "merging…" : "restoring…" });
    };
    xhr.onload = () => {
      let d = {};
      try { d = JSON.parse(xhr.responseText); } catch {}
      postPill("backup", null);
      if (xhr.status >= 200 && xhr.status < 300) {
        updateTransfer(tid, { status: "done", info: merging ? `${d.pages_added ?? 0} pages added` : "restored" });
        window.location.href = window.location.pathname; // fresh state, no stale ?block=
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
    try { localStorage.setItem("gamma-active-user", ""); } catch {}
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
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState("");
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
  // Home feed: sort criterion + how many rows are rendered (grows on scroll).
  const [homeSort, changeHomeSort] = usePersistedState("gamma-home-sort", "updated");
  // Home layout: "list" (block-style rows) or "grid" (icon tiles).
  const [homeView, changeHomeView] = usePersistedState("gamma-home-view", "list");
  const HOME_PAGE_CHUNK = 30;
  const [homeShowCount, setHomeShowCount] = useState(HOME_PAGE_CHUNK);
  useEffect(() => { setHomeShowCount(HOME_PAGE_CHUNK); }, [folderFilter, homeSort]);
  const loadMoreRef = useRef(null);
  function updateExtraFolders(updater) {
    setExtraFolders((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      const u = prefsUserRef.current;
      if (u) { try { localStorage.setItem(`gamma-extra-folders:${u}`, JSON.stringify(next)); } catch {} }
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
      readPosRef.current = {};
      readPosLoadedRef.current = false;
      return;
    }
    prefsUserRef.current = u;
    tabsSyncRef.current = "";
    // Local cache first for instant paint…
    let localTabs = [];
    try { localTabs = JSON.parse(localStorage.getItem(`gamma-tabs:${u}`) || "[]"); } catch {}
    setOpenTabs(Array.isArray(localTabs) ? localTabs : []);
    try { setExtraFolders(JSON.parse(localStorage.getItem(`gamma-extra-folders:${u}`) || "[]")); } catch { setExtraFolders([]); }
    try { setRecentViews(JSON.parse(localStorage.getItem(`gamma-recent-views:${u}`) || "[]")); } catch { setRecentViews([]); }
    readPosLoadedRef.current = false;
    try { readPosRef.current = JSON.parse(localStorage.getItem(`gamma-read-pos:${u}`) || "{}"); } catch { readPosRef.current = {}; }
    // …then the server copy, which wins (tabs sync across browsers). An
    // account that has never synced seeds the server with this browser's tabs.
    apiJson(`${API}/prefs/open-tabs`).then((d) => {
      if (prefsUserRef.current !== u) return;
      if (d.updated_at) applyServerTabs(u, d.value, d.updated_at);
      else if (Array.isArray(localTabs) && localTabs.length) pushTabsToServer(localTabs);
    }).catch(() => {});
    apiJson(`${API}/prefs/read-pos`).then((d) => {
      if (prefsUserRef.current !== u) return;
      readPosLoadedRef.current = true;
      if (mergeReadPos(u, d.value)) pushReadPosSoon(u);
    }).catch(() => { if (prefsUserRef.current === u) readPosLoadedRef.current = true; });
  }, [authUser?.user, readOnly]);

  // Folder-tag helpers: parse/serialize the comma-separated path list.
  // "/" nests and "," separates tags, so neither may appear in a segment name.
  async function writePageFolders(pageId, tags) {
    await apiJson(`${API}/blocks/${pageId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { folder: tags.join(", ") } }),
    });
  }

  async function writePageLabels(pageId, tags) {
    await apiJson(`${API}/blocks/${pageId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { category: tags.join(", ") } }),
    });
  }

  function commitNewFolder() {
    const name = cleanFolderSegment(newFolderName);
    setNewFolderOpen(false);
    setNewFolderName("");
    if (!name) return;
    const path = folderFilter ? `${folderFilter}/${name}` : name;
    updateExtraFolders((prev) => prev.includes(path) ? prev : [...prev, path]);
  }

  // --- Home file-manager: multi-select + copy/move/delete, folder rename ---
  const [selectedPages, setSelectedPages] = useState(() => new Set());
  const [selectedFolders, setSelectedFolders] = useState(() => new Set());
  const lastPageClickRef = useRef(null); // anchor for shift-range selection
  const [homeMenu, setHomeMenu] = useState(null); // {kind:"page"|"folder", id?, name, x, y}
  const [folderRenaming, setFolderRenaming] = useState(null); // {name, draft}
  const [labelRenaming, setLabelRenaming] = useState(null); // {name, draft}

  function clearSelection() { setSelectedPages(new Set()); setSelectedFolders(new Set()); }

  // Modern file-manager semantics: plain click SELECTS, double-click opens.
  // Ctrl/Cmd toggles a single item; Shift extends a range from the last click.
  function handlePageClick(pageBlock, e) {
    const id = pageBlock._pageId;
    if (!id) return;
    if (e && (e.ctrlKey || e.metaKey)) {
      setSelectedFolders(new Set());
      setSelectedPages((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
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
        setSelectedFolders(new Set());
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
    setSelectedFolders(new Set());
    setSelectedPages(new Set([id]));
  }

  // Double-click / Enter / context-menu "Open": the old single-click behavior.
  function openPage(id) {
    if (!id) return;
    clearSelection();
    openBlock(id, { restoreScroll: true });
  }

  // Folder single-click selects (Ctrl toggles); double-click navigates in.
  function handleFolderClick(path, e) {
    if (folderRenaming?.name === path) return;
    if (e && (e.ctrlKey || e.metaKey)) {
      setSelectedPages(new Set());
      setSelectedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
      });
      return;
    }
    setSelectedPages(new Set());
    setSelectedFolders(new Set([path]));
  }
  function openFolder(path) {
    clearSelection();
    setFolderFilter(path);
    window.history.replaceState(null, "", `/?folder=${encodeURIComponent(path)}`);
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
      body: JSON.stringify({ parent_id: "root", content: `${src.content || "Untitled"} (copy)`, properties: src.properties || {} }),
    });
    const hlMap = new Map();
    const clone = (list) => (list || []).map((b) => {
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
        if (p.linked_highlight_id && hlMap.has(p.linked_highlight_id)) p.linked_highlight_id = hlMap.get(p.linked_highlight_id);
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
          try { await apiJson(`${API}/blocks/${id}`, { method: "DELETE" }); } catch {}
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

  // Add pages to a folder (soft link — other folder tags are kept). The only
  // tag removed is an ancestor of the target: dragging a "readout" paper into
  // readout/nondestructive refines it, it shouldn't stay in both levels.
  async function addPagesToFolder(ids, path) {
    let changed = 0;
    for (const id of ids) {
      const b = homeBlocks.find((x) => x.id === id);
      if (!b) continue;
      const tags = parseFolderTags(b.properties?.folder);
      if (tags.includes(path)) continue;
      const next = tags.filter((t) => !path.startsWith(t + "/"));
      next.push(path);
      try { await writePageFolders(id, next); changed++; } catch {}
    }
    updateExtraFolders((prev) => prev.filter((f) => f !== path));
    clearSelection();
    await fetchHomeBlocks();
    setStatus(changed ? `Added ${changed} page${changed === 1 ? "" : "s"} to “${path}”.` : `Already in “${path}”.`);
  }

  // Remove one folder tag (exact path). With path = "" strips ALL folder tags.
  async function removePagesFromFolder(ids, path) {
    for (const id of ids) {
      const b = homeBlocks.find((x) => x.id === id);
      if (!b) continue;
      const tags = parseFolderTags(b.properties?.folder);
      const next = path ? tags.filter((t) => t !== path) : [];
      if (next.length === tags.length) continue;
      try { await writePageFolders(id, next); } catch {}
    }
    clearSelection();
    await fetchHomeBlocks();
    setStatus(path ? `Removed ${ids.length} page${ids.length === 1 ? "" : "s"} from “${path}”.` : "Cleared folder tags.");
  }

  // Rename one path segment: rewrites the prefix on every page's folder tags,
  // so renaming a parent folder carries all its subfolders along.
  async function renameFolder(oldPath, newNameRaw) {
    const newName = cleanFolderSegment(newNameRaw);
    setFolderRenaming(null);
    const parent = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : "";
    const newPath = parent ? `${parent}/${newName}` : newName;
    if (!newName || newPath === oldPath) return;
    const mapTag = (t) => (t === oldPath ? newPath : t.startsWith(oldPath + "/") ? newPath + t.slice(oldPath.length) : t);
    for (const b of homeBlocks) {
      const tags = parseFolderTags(b.properties?.folder);
      const next = [...new Set(tags.map(mapTag))];
      if (next.join(",") === tags.join(",")) continue;
      try { await writePageFolders(b.id, next); } catch {}
    }
    updateExtraFolders((prev) => [...new Set(prev.map(mapTag))]);
    if (folderFilter === oldPath || folderFilter.startsWith(oldPath + "/")) {
      const next = mapTag(folderFilter);
      setFolderFilter(next);
      window.history.replaceState(null, "", `/?folder=${encodeURIComponent(next)}`);
    }
    await fetchHomeBlocks();
    setStatus(`Folder renamed to “${newPath}”.`);
  }

  function deleteFolderByName(path) {
    const inPath = (t) => t === path || t.startsWith(path + "/");
    const members = homeBlocks.filter((b) => parseFolderTags(b.properties?.folder).some(inPath));
    setConfirmBox({
      title: "Delete folder",
      message: members.length
        ? `Delete “${path}”? The folder tag is removed from its ${members.length} paper${members.length === 1 ? "" : "s"} — no papers are deleted.`
        : `Delete the empty folder “${path}”?`,
      confirmLabel: "Delete folder",
      onConfirm: async () => {
        for (const b of members) {
          try { await writePageFolders(b.id, parseFolderTags(b.properties?.folder).filter((t) => !inPath(t))); } catch {}
        }
        updateExtraFolders((prev) => prev.filter((f) => !inPath(f)));
        if (folderFilter === path || folderFilter.startsWith(path + "/")) {
          const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
          setFolderFilter(parent);
          window.history.replaceState(null, "", parent ? `/?folder=${encodeURIComponent(parent)}` : "/");
        }
        await fetchHomeBlocks();
        setStatus(`Folder “${path}” deleted.`);
      },
    });
  }

  // Rename a label everywhere: rewrites properties.category on every page
  // that carries it (labels are flat — no prefix logic, unlike folders).
  async function renameLabel(oldName, newNameRaw) {
    const newName = (newNameRaw || "").replace(/,/g, " ").replace(/\s+/g, " ").trim();
    setLabelRenaming(null);
    if (!newName || newName === oldName) return;
    let changed = 0;
    for (const b of homeBlocks) {
      const tags = parseFolderTags(b.properties?.category);
      if (!tags.includes(oldName)) continue;
      const next = [...new Set(tags.map((t) => (t === oldName ? newName : t)))];
      try { await writePageLabels(b.id, next); changed++; } catch {}
    }
    if (categoryFilter === oldName) {
      setCategoryFilter(newName);
      window.history.replaceState(null, "", `/?category=${encodeURIComponent(newName)}`);
    }
    // Keep the open page's frontmatter chips in sync (server already updated by the sweep)
    setCategory((prev) => {
      const tags = parseFolderTags(prev);
      return tags.includes(oldName) ? [...new Set(tags.map((t) => (t === oldName ? newName : t)))].join(", ") : prev;
    });
    await fetchHomeBlocks();
    setStatus(`Label renamed to “${newName}” on ${changed} page${changed === 1 ? "" : "s"}.`);
  }

  function deleteLabelByName(name) {
    const members = homeBlocks.filter((b) => parseFolderTags(b.properties?.category).includes(name));
    setConfirmBox({
      title: "Delete label",
      message: members.length
        ? `Delete “${name}”? The label is removed from its ${members.length} page${members.length === 1 ? "" : "s"} — no pages are deleted.`
        : `Delete the label “${name}”?`,
      confirmLabel: "Delete label",
      onConfirm: async () => {
        for (const b of members) {
          try { await writePageLabels(b.id, parseFolderTags(b.properties?.category).filter((t) => t !== name)); } catch {}
        }
        if (categoryFilter === name) { setCategoryFilter(""); window.history.replaceState(null, "", "/"); }
        setCategory((prev) => {
          const tags = parseFolderTags(prev);
          return tags.includes(name) ? tags.filter((t) => t !== name).join(", ") : prev;
        });
        await fetchHomeBlocks();
        setStatus(`Label “${name}” deleted.`);
      },
    });
  }
  const [pdfPageNumber, setPdfPageNumber] = useState(() => loadSession().pdfPageNumber || 1);
  const [pdfEffScale, setPdfEffScale] = useState(1); // actual render scale (incl. fit-width)
  // Browser fullscreen (whole app, like F11). webkit-prefixed fallbacks are
  // for iPadOS Safari, which never shipped the unprefixed API.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement));
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
    const onErr = (e) => logSys(`error: ${e.message || "unknown"}${e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : ""}`);
    const onRej = (e) => logSys(`unhandled rejection: ${e.reason?.message || e.reason || "unknown"}`);
    const onApi = (e) => { if (e.detail?.message) logSys(e.detail.message); };
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
  useEffect(() => { debugLogRef.current = debugLog; }, [debugLog]);
  const dbg = useCallback((...args) => {
    if (!debugLogRef.current) return;
    const msg = "dbg: " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    console.log(msg);
    logSys(msg);
  }, [logSys]);
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
    const ifMine = (fn) => setPillChannels((prev) => (prev[channel]?.seq === seq ? fn(prev) : prev));
    if (entry.final) {
      timers[channel] = [
        setTimeout(() => ifMine((prev) => ({ ...prev, [channel]: { ...prev[channel], fading: true } })), 600),
        setTimeout(() => ifMine((prev) => { const next = { ...prev }; delete next[channel]; return next; }), 1000),
      ];
    }
    if (opts?.after) {
      const [ms, patch] = opts.after;
      (timers[channel] ||= []).push(setTimeout(() => ifMine((prev) => {
        const next = { ...prev };
        if (patch === null) delete next[channel];
        else next[channel] = { ...next[channel], ...patch };
        return next;
      }), ms));
    }
  }, []);
  useEffect(() => () => Object.values(pillTimersRef.current).forEach((ts) => ts.forEach(clearTimeout)), []);
  const pillShown = useMemo(() => {
    const rank = (e) => (e.error ? 3 : e.final ? 2 : 1);
    return Object.values(pillChannels).sort((a, b) => rank(b) - rank(a) || b.seq - a.seq)[0] || null;
  }, [pillChannels]);
  // Status messages: logged (Settings → Diagnostics), mirrored into the
  // optional debug status bar, and posted to the pill. Messages ending in
  // "…"/"..." are in-progress; anything else is final.
  const setStatus = useCallback((msg) => {
    const text = String(msg);
    setStatusRaw(text);
    logSys(text);
    const ongoing = /(\.\.\.|…)\s*$/.test(text);
    postPill("status", { msg: text, spinner: ongoing, final: !ongoing });
  }, [postPill, logSys]);
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
    try { localStorage.setItem("gamma-layout", JSON.stringify(layout)); } catch {}
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
  // Open tabs (Chrome-style): [{id, title}], stored PER USER. localStorage is
  // only a cache for instant paint — the server (/api/prefs/open-tabs) is the
  // source of truth, so tabs follow the account across browsers. Local changes
  // are debounce-pushed; regaining focus pulls the latest stored state.
  // Persistence happens inside the updater (not an effect) so a user switch
  // can't race an in-flight save into the wrong key.
  const [openTabs, setOpenTabs] = useState([]);
  const prefsUserRef = useRef(""); // whose tabs/folders are currently loaded
  const tabsSyncRef = useRef("");  // updated_at of the last server state we applied/wrote
  const tabsPushTimerRef = useRef(null);
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
      try { localStorage.setItem(`gamma-tabs:${user}`, JSON.stringify(tabs)); } catch {}
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
        try { localStorage.setItem(`gamma-tabs:${u}`, JSON.stringify(next)); } catch {}
        pushTabsToServer(next);
      }
      return next;
    });
  }
  // pinned: true | undefined (undefined keys drop out of the synced JSON).
  function toggleTabPinned(id) {
    updateTabs((prev) => prev.map((t) => (t.id === id ? { ...t, pinned: t.pinned ? undefined : true } : t)));
  }
  // Last-read positions, synced like tabs so "jump to last read" follows the
  // account across browsers: blockId -> {page, at}. Per-paper entries merged
  // newest-wins, so two open windows only conflict when reading the SAME
  // paper (last writer wins) — unlike the old single global session slot,
  // which any window (or goHome's clearSession) could clobber.
  const readPosRef = useRef({});
  const readPosLoadedRef = useRef(false); // first server response arrived
  const readPosPushTimerRef = useRef(null);
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
    try { localStorage.setItem(`gamma-read-pos:${user}`, JSON.stringify(merged)); } catch {}
    const newer = Object.entries(merged).filter(([id, e]) => !s[id] || (e.at || "") > (s[id].at || ""));
    dbg("read-pos merged;", Object.keys(s).length, "server entries;",
      newer.length ? `local newer: ${newer.map(([id, e]) => `${id}=p${e.page}`).join(",")}` : "in sync");
    // In sync means the server is confirmed to hold exactly this copy.
    if (!newer.length) readPosSentRef.current = JSON.stringify({ value: merged });
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
      if (body === readPosSentRef.current) { dbg("read-pos push skipped (server current)"); return; }
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
    try { localStorage.setItem(`gamma-read-pos:${u}`, JSON.stringify(next)); } catch {}
    dbg("read-pos record", blockId, "→ page", page);
    pushReadPosSoon(u);
  }
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
      if (body === readPosSentRef.current) { dbg("read-pos flush skipped (server current)"); return; }
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
    };
    const onVisibility = () => { if (document.hidden) flushReadPos(); else onWake(); };
    window.addEventListener("focus", onWake);
    window.addEventListener("blur", flushReadPos);
    window.addEventListener("pagehide", flushReadPos);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onWake);
      window.removeEventListener("blur", flushReadPos);
      window.removeEventListener("pagehide", flushReadPos);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  // Recently-viewed pages — a device-local history for the library's top
  // shortcut bar ([{id, at}], most recent first). Not page data, so it lives
  // in localStorage like tabs.
  const [recentViews, setRecentViews] = useState([]);
  function pushRecentView(id) {
    if (!id) return;
    setRecentViews((prev) => {
      const next = [{ id, at: new Date().toISOString() }, ...prev.filter((r) => r.id !== id)].slice(0, 24);
      const u = prefsUserRef.current;
      if (u) { try { localStorage.setItem(`gamma-recent-views:${u}`, JSON.stringify(next)); } catch {} }
      return next;
    });
  }
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
  // server-side work (library indexing), shown in one popover.
  const [transfers, setTransfers] = useState([]); // [{id, name, kind, status, info}]
  const [indexTask, setIndexTask] = useState(null); // {total, done, active} from /api/tasks
  // The server remembers the last run's progress forever; this hides the
  // finished row after "Clear" until a new indexing run starts.
  const [indexTaskCleared, setIndexTaskCleared] = useState(false);
  const transferByUrlRef = useRef({});
  function addTransfer(t) {
    const id = makeId();
    setTransfers((prev) => [{ id, status: "active", ...t }, ...prev].slice(0, 20));
    return id;
  }
  function updateTransfer(id, patch) {
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }
  // Byte-level download state reported by the PDF viewer (skips local uploads).
  // One row per URL: a re-download (LRU eviction, retry) reactivates the
  // existing entry instead of stacking duplicates.
  function handlePdfLoadState(url, st) {
    // System log: lifecycle transitions only — byte/page progress would spam it.
    if (st.phase !== "progress" && st.phase !== "measuring") {
      const shortUrl = url.length > 100 ? url.slice(0, 100) + "…" : url;
      logSys(`pdf ${st.phase}${st.bytes ? ` (${fmtBytes(st.bytes)})` : ""}${st.detail ? ` — ${st.detail}` : ""}: ${shortUrl}`);
    }
    // Feed the shared status pill — one channel for the whole load lifecycle,
    // so load progress and status messages can never stack.
    if (st.phase === "start") {
      // Escalates if the server keeps us waiting with no bytes.
      postPill("pdf-load", { msg: "Requesting PDF…", spinner: true },
        { after: [6000, { msg: "Still waiting — the server may be fetching the PDF from its source…" }] });
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
      postPill("pdf-load", { msg: `Preparing document — measuring page ${st.done + 1} of ${st.total}…`, spinner: true });
    } else if (st.phase === "error") {
      postPill("pdf-load", { msg: `PDF load failed — ${st.detail || "unknown error"}`, error: true, retry: true });
    } else if (st.phase === "cancelled" || st.phase === "painted") {
      postPill("pdf-load", null);
    }
    if (st.phase === "rendered") {
      // Pages are in the DOM but the first canvas paint is still in flight —
      // keep the pill up until the viewer reports "painted". Safety-capped so
      // a paint that errors out can't leave the spinner stuck forever.
      postPill("pdf-load", { msg: "Rendering page…", spinner: true }, { after: [20000, null] });
      pdfRenderedUrlRef.current = url; // this document's pages are now in the DOM
      setPdfDocNonce((n) => n + 1);    // lets a pinned search re-find its matches here
      // Called from the viewer's layout effect — before paint. Applying a
      // pending restore HERE means the document appears already scrolled to
      // its position: no flash of the top, no visible jump.
      const p = pendingRestoreRef.current;
      if (p && p.url === url && restoreTokenRef.current === p.token) {
        const scroller = viewerWrapRef.current?.querySelector(".pdfViewer");
        const targetTop = p.entry.top * ((pdfEffScaleRef.current || p.entry.scale || 1) / (p.entry.scale || 1));
        if (scroller && scroller.scrollHeight > targetTop) {
          scroller.scrollTo({ top: targetTop, behavior: "instant" });
          pendingRestoreRef.current = null;
          restoreTokenRef.current++; // the fallback loop is no longer needed
          if (restoringForRef.current === p.blockId) restoringForRef.current = null;
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
      const name = (pdfTitle || decodeURIComponent((url.split("source_url=")[1] || url).split("/").pop() || "PDF")).slice(0, 60);
      transferByUrlRef.current[url] = addTransfer({ name, kind: "download", info: "downloading…" });
    } else if (st.phase === "progress") {
      const id = transferByUrlRef.current[url];
      if (id) updateTransfer(id, {
        status: "active",
        info: st.total ? `${fmtBytes(st.loaded)} / ${fmtBytes(st.total)}` : `${fmtBytes(st.loaded)}…`,
      });
    } else {
      const id = transferByUrlRef.current[url];
      if (!id) return;
      if (st.phase === "cancelled") {
        delete transferByUrlRef.current[url];
        setTransfers((prev) => prev.filter((t) => t.id !== id)); // aborted navigation — drop the entry
      } else {
        updateTransfer(id, st.phase === "done"
          ? { status: "done", info: fmtBytes(st.bytes) }
          : { status: "error", info: (st.detail || "failed").slice(0, 60) });
      }
    }
  }
  const [dockPreview, setDockPreview] = useState(null); // {left, top, width, height} of the drop target while dragging a window
  const [collapsedWins, setCollapsedWins] = useState({}); // window id -> collapsed to header bar
  // One popover open at a time; any click outside a [data-popover] container closes it.
  const [openPopover, setOpenPopover] = useState(null); // "menu" | "share" | "user" | "search"
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
    (b) => pdfCaptureRef.current ? pdfCaptureRef.current({ position: b.position }) : Promise.resolve(null),
    [],
  );

  // Poll server-side task progress: slow heartbeat while logged in (so the
  // button appears even if the work was kicked off elsewhere), fast while
  // the popover is open or indexing is known to run.
  useEffect(() => {
    if (!authUser?.user || readOnly) return;
    let cancelled = false;
    const refresh = () => apiJson(`${API}/tasks`)
      .then((d) => {
        if (cancelled) return;
        setIndexTask(d.indexing || null);
        if (d.indexing?.active) setIndexTaskCleared(false);
      })
      .catch(() => {});
    refresh();
    const fast = openPopover === "downloads" || indexTask?.active;
    const t = setInterval(refresh, fast ? 2000 : 8000);
    return () => { cancelled = true; clearInterval(t); };
  }, [openPopover, authUser?.user, readOnly, indexTask?.active]);

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
      for (const t of (b.properties?.folder || "").split(",").map((s) => s.trim()).filter(Boolean)) addWithPrefixes(t);
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
  const [pdfSaveLocal, setPdfSaveLocal] = usePersistedFlag("gamma-pdf-save", true);
  // Speech-bubble badge on PDF highlights that carry a typed note.
  const [hlNoteBadges, setHlNoteBadges] = usePersistedFlag("gamma-hl-note-badge", true);
  // Embedded PDF annotations (burned in by a Gamma export or another viewer)
  // would render twice once imported as blocks — canvas + overlay. "hide"
  // keeps them out of the canvas; "strip" removes them from the stored file
  // at import time.
  const [embAnnots, setEmbAnnots] = usePersistedState("gamma-embedded-annots", "hide", {
    parse: (raw) => (raw === "hide" || raw === "strip" ? raw : undefined),
  });
  // User preferences (Settings in the account popover)
  const [oaFallback, setOaFallback] = usePersistedFlag("gamma-oa-fallback", true);
  const [metaAutoFetch, setMetaAutoFetch] = usePersistedFlag("gamma-meta-auto", true);
  // Search popover: whether the result-detail lists start expanded, one
  // default per place (SearchPanel receives them each time it opens).
  // Home page: expanded unless turned off — with no open PDF the compact
  // find bar shows nothing. Paper view: compact find unless turned on.
  const [searchDetailsHome, setSearchDetailsHome] = usePersistedFlag("gamma-search-details-home", true);
  const [searchDetailsPaper, setSearchDetailsPaper] = usePersistedFlag("gamma-search-details", false);
  // The always-on status bar under the tabs — off by default, the floating
  // pill carries user-facing messages; the bar is a debugging aid.
  const [statusBarVisible, setStatusBarVisible] = usePersistedFlag("gamma-status-bar", false);
  const pageTitleSaveTimerRef = useRef(null);
  const viewerWrapRef = useRef(null);
  const pdfRetryRef = useRef(null); // set by PdfViewer: re-runs a failed load (pill's Retry button)
  const appRef = useRef(null);

  // --- AI chat: model switcher, PDF attachment, selection focus, report ---
  const [aiInfo, setAiInfo] = useState(null); // {enabled, provider, models, default}
  const [chatModel, setChatModel] = useState(() => {
    try { return localStorage.getItem("gamma-chat-model") || ""; } catch { return ""; }
  });
  const [chatEffort, setChatEffort] = usePersistedState("gamma-chat-effort", "");
  // Model for AI metadata extraction (Settings → Paper metadata). "" = follow
  // the chat model; a stale pick (provider/model removed) also falls back.
  const [metaModel, setMetaModel] = usePersistedState("gamma-meta-model", "");
  // Voice dictation (mic button): transcription model + spoken language
  // ("" = auto-detect), configured in Settings → AI chat.
  const [dictationModel, setDictationModel] = usePersistedState("gamma-dictation-model", "gpt-4o-transcribe");
  const [dictationLang, setDictationLang] = usePersistedState("gamma-dictation-lang", "");
  const [chatSystem, setChatSystem] = usePersistedState("gamma-chat-system", "");
  const [chatContextChars, setChatContextChars] = usePersistedState("gamma-chat-context-chars", 8000, CONTEXT_CHARS_CODEC);
  const [metaContextChars, setMetaContextChars] = usePersistedState("gamma-meta-context-chars", 6000, CONTEXT_CHARS_CODEC);
  const [multiContextChars, setMultiContextChars] = usePersistedState("gamma-multi-context-chars", 18000, CONTEXT_CHARS_CODEC);
  const [promptDraft, setPromptDraft] = useState("");
  // AI providers (Settings → AI providers): a user-managed list of API keys,
  // OpenAI-platform style. Keys are stored server-side per user; the server
  // only ever returns a masked hint, so key fields here start empty and an
  // empty key on edit means "keep the stored one".
  const [aiKeysInfo, setAiKeysInfo] = useState(null); // masked GET /ai/settings: {providers: [], protocols: []}
  const [aiKeysForm, setAiKeysForm] = useState(null); // null | {id: ""=add, protocol, name, api_key, base_url, models}
  const [aiKeysBusy, setAiKeysBusy] = useState(false);
  const [aiKeysError, setAiKeysError] = useState("");

  // The settings page (account popover → Settings…): two-column modal,
  // categories on the left, the selected pane on the right.
  const [settingsOpen, setSettingsOpen] = useState(null); // null | "papers" | "library" | "ai" | "prompts" | "search" | "account"
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
    apiJson(`${API}/prefs/ai-provider`).then((d) => {
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
    }).catch(() => {});
  }, [authUser?.user, readOnly]);
  useEffect(() => {
    if (aiProviderSyncRef.current === null || aiProviderSyncRef.current === aiProvider || readOnly) return;
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
    try { chatModelMemRef.current = JSON.parse(localStorage.getItem("gamma-chat-model-by-key") || "{}") || {}; }
    catch { chatModelMemRef.current = {}; }
  }
  // Keep the selected model inside the active key's model list: switching to
  // a key restores its remembered model, or falls back to its first one.
  useEffect(() => {
    const all = aiInfo?.models || [];
    if (!all.length) return;
    const scoped = aiProvider && all.some((m) => m.provider === aiProvider)
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
  const scopedAiModels = aiProvider && (aiInfo?.models || []).some((m) => m.provider === aiProvider)
    ? aiInfo.models.filter((m) => m.provider === aiProvider)
    : aiInfo?.models || [];
  // The model AI calls (chat, citations, titles) actually send: chatModel
  // snapped into scope at render time — the effect above fixes the state, but
  // a request fired in the same render (or before /ai/models loads after a
  // key switch elsewhere) must not trust it. Empty list = registry not loaded
  // yet; nothing to validate against, so the stored pick passes through.
  const chatSendModel = scopedAiModels.length && !scopedAiModels.some((m) => m.id === chatModel)
    ? scopedAiModels[0].id
    : chatModel;

  async function loadAiKeys() {
    setAiKeysError("");
    setAiKeysInfo(null);
    setAiKeysForm(null);
    try {
      setAiKeysInfo(await apiJson(`${API}/ai/settings`));
    } catch (err) {
      setAiKeysError(err.message);
    }
  }
  // Entering the AI pane always refetches the masked key list.
  useEffect(() => {
    if (settingsOpen === "ai" && authUser?.user && !readOnly) loadAiKeys();
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
  const refreshAiModels = () => apiJson(`${API}/ai/models`).then(setAiInfo).catch(() => {});

  function startAddAiProvider() {
    setAiKeysError("");
    setAiKeysForm({ id: "", protocol: aiKeysInfo?.protocols?.[0]?.id || "anthropic", name: "", api_key: "", base_url: "", models: "" });
  }

  function startEditAiProvider(p) {
    setAiKeysError("");
    setAiKeysForm({ id: p.id, protocol: p.protocol, name: p.name || "", api_key: "", base_url: p.base_url || "", models: p.models || "" });
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
          provider_id: f.id || "", protocol: f.protocol,
          api_key: f.api_key.trim(), base_url: f.base_url.trim(),
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
    setAiKeysForm((f) => f ? { ...f, models: parseFolderTags(f.models).filter((x) => x !== m).join(", ") } : f);
  }
  const [customModel, setCustomModel] = useState(""); // free-form entry next to the picker
  const formModels = parseFolderTags(aiKeysForm?.models);
  const availModels = (aiModelCatalog?.models || []).filter((m) => !formModels.includes(m));
  // A ChatGPT entry that isn't signed in yet can't list models — its list
  // comes from the connected account, so the fetch waits for Connect.
  const formStoredEntry = aiKeysForm?.id ? aiKeysInfo?.providers?.find((p) => p.id === aiKeysForm.id) : null;
  const formOauthPending = !!aiKeysForm && isOauthProto(aiKeysForm.protocol) && !formStoredEntry?.oauth_connected;

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
  }, [aiKeysForm?.id, aiKeysForm?.protocol]);

  // "Sign in with ChatGPT": opens the OAuth page in a new tab. Its redirect
  // (localhost:1455) fails to load — the user pastes that URL back into the
  // form and submit completes the exchange server-side.
  async function startChatGPTAuth() {
    setAiKeysError("");
    try {
      const d = await apiJson(`${API}/ai/oauth/chatgpt/start`, { method: "POST" });
      setAiKeysForm((f) => (f ? { ...f, oauthState: d.state } : f));
      window.open(d.auth_url, "_blank", "noopener");
    } catch (err) {
      setAiKeysError(err.message);
    }
  }

  async function submitAiProvider() {
    const f = aiKeysForm;
    if (!f) return;
    const oauth = isOauthProto(f.protocol);
    const oauthCb = oauth ? (f.oauthCallback || "").trim() : "";
    if (oauth && !oauthCb && !f.id) { setAiKeysError("Sign in with ChatGPT and paste the callback URL to connect."); return; }
    if (oauthCb && !f.oauthState) { setAiKeysError('Hit "Open ChatGPT sign-in" first, then paste the URL it ends on.'); return; }
    if (!oauth && !f.id && !f.api_key.trim()) { setAiKeysError("An API key is required."); return; }
    // Complete the OAuth exchange when a callback was pasted; otherwise a
    // plain field edit (name/models — plus key/base URL for key entries).
    const req = oauthCb
      ? { url: `${API}/ai/oauth/chatgpt/complete`, method: "POST",
          body: { state: f.oauthState, callback: oauthCb, provider_id: f.id || "",
                  name: f.name.trim(), models: f.models.trim() } }
      : { url: `${API}/ai/providers${f.id ? `/${f.id}` : ""}`, method: f.id ? "PUT" : "POST",
          body: { protocol: f.protocol, name: f.name.trim(), base_url: f.base_url.trim(), models: f.models.trim(),
                  ...(f.api_key.trim() ? { api_key: f.api_key.trim() } : {}) } };
    await runAiKeysRequest(() => apiJson(req.url, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    }), true);
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
        await runAiKeysRequest(() => apiJson(`${API}/ai/providers/${p.id}`, { method: "DELETE" }), aiKeysForm?.id === p.id);
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
    } catch (err) {
      setAiKeysError(err.message);
    } finally {
      setAiKeysBusy(false);
    }
  }

  // User management (admins only — admin is a privilege flag, not a name).
  const [usersOpen, setUsersOpen] = useState(false);
  const [usersInfo, setUsersInfo] = useState(null); // {users: [{username, is_guest, is_admin, created_at}], me}
  const [usersForm, setUsersForm] = useState(null); // {username, password, is_admin} — the add-user form
  const [userPwEdit, setUserPwEdit] = useState(null); // {username, password} — inline set-password form
  const [userRenameEdit, setUserRenameEdit] = useState(null); // {username, value} — inline rename form
  const [usersBusy, setUsersBusy] = useState(false);
  const [usersError, setUsersError] = useState("");

  async function openUsersManager() {
    setUsersError("");
    setUsersInfo(null);
    setUsersForm(null);
    setUserPwEdit(null);
    setUserRenameEdit(null);
    setUsersOpen(true);
    try {
      setUsersInfo(await apiJson(`${API}/admin/users`));
    } catch (err) {
      setUsersError(err.message);
    }
  }

  async function usersCall(path, method, body) {
    setUsersBusy(true);
    setUsersError("");
    try {
      const d = await apiJson(`${API}/admin${path}`, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      setUsersInfo((prev) => ({ ...prev, users: d.users }));
      if (d.warning) setStatus(d.warning);
      return true;
    } catch (err) {
      setUsersError(err.message);
      return false;
    } finally {
      setUsersBusy(false);
    }
  }

  async function submitNewUser() {
    const f = usersForm;
    if (!f?.username.trim() || !f?.password) { setUsersError("Username and password are required."); return; }
    if (await usersCall("/users", "POST", { username: f.username.trim(), password: f.password, is_admin: !!f.is_admin })) {
      setUsersForm(null);
    }
  }

  async function submitUserPassword() {
    const f = userPwEdit;
    if (!f?.password) { setUsersError("Password cannot be empty."); return; }
    if (await usersCall(`/users/${encodeURIComponent(f.username)}`, "PUT", { password: f.password })) {
      setUserPwEdit(null);
      setStatus(`Password updated for ${f.username}.`);
    }
  }

  async function submitUserRename() {
    const f = userRenameEdit;
    if (!f?.value.trim()) { setUsersError("New username required."); return; }
    setUsersBusy(true);
    setUsersError("");
    try {
      const d = await apiJson(`${API}/admin/users/${encodeURIComponent(f.username)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_username: f.value.trim() }),
      });
      setUsersInfo((prev) => ({
        ...prev,
        users: d.users,
        me: d.renamed?.from === prev.me ? d.renamed.to : prev.me,
      }));
      setUserRenameEdit(null);
      if (d.renamed) setStatus(`Renamed ${d.renamed.from} → ${d.renamed.to}. Sessions keep working.`);
      // Renamed yourself? Re-read the session so the whole app re-keys
      // (avatar, per-user prefs, synced tabs all follow the new name).
      if (d.renamed && d.renamed.from === authUser?.user) await checkSession();
    } catch (err) {
      setUsersError(err.message);
    } finally {
      setUsersBusy(false);
    }
  }

  function deleteUserAccount(u) {
    setConfirmBox({
      title: "Delete user",
      message: `Delete "${u.username}" and ALL their data (notes, PDFs, settings)? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => usersCall(`/users/${encodeURIComponent(u.username)}`, "DELETE"),
    });
  }
  // PDF passages the next chat question focuses on. Ctrl (additive) appends
  // — whether from text selection or highlight clicks; plain replaces.
  const [pdfSelections, setPdfSelections] = useState([]);
  function addPdfSelection(text, additive) {
    const part = (text || "").trim().slice(0, 4000);
    if (!part) return;
    setPdfSelections((prev) => additive
      ? (prev.includes(part) || prev.length >= 6 ? prev : [...prev, part])
      : [part]);
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
    setChatImages((prev) => prev.length >= 4 || prev.includes(dataUrl) ? prev : [...prev, dataUrl]);
  }
  // Off by default: snapshots stay attached until removed or sent. On, a
  // plain click elsewhere in the PDF drops them — the same gesture that
  // clears quoted text selections. Ref-mirrored for the mouseup listener.
  const [chatImgAutoClear, setChatImgAutoClear] = usePersistedFlag("gamma-chat-img-autoclear", false);
  const chatImgAutoClearRef = useRef(chatImgAutoClear);
  useEffect(() => { chatImgAutoClearRef.current = chatImgAutoClear; }, [chatImgAutoClear]);
  // Clicking a highlight — on the PDF or its card in the notes — feeds the
  // chat: text highlights set their quote as the selection, area rectangles
  // re-crop their region into an image attachment (the snapshot is never
  // stored; the viewer renders it fresh from the document each time).
  function addHighlightToChat(h, additive) {
    if (!h) return;
    if (h.position?.area) {
      pdfCaptureRef.current?.(h).then((img) => { if (img) addChatImage(img); });
    } else {
      addPdfSelection(h.content?.text, additive);
    }
  }
  // Styled in-app dialogs replacing window.confirm / link decisions.
  const [confirmBox, setConfirmBox] = useState(null); // {title, message, confirmLabel, danger, onConfirm}
  const [linkPrompt, setLinkPrompt] = useState(null); // external URL clicked inside the PDF
  const [linkDialog, setLinkDialog] = useState(null); // {position, content} — creating a manual reference link
  const [linkDialogInput, setLinkDialogInput] = useState("");
  // A highlight copied via "Copy as reference point" — link dialogs in other
  // papers offer it as a target, so links can point at an exact passage.
  const [refPoint, setRefPoint] = useState(null); // {pageId, pageTitle, highlightId, quote}

  // --- Paper metadata (arXiv / DOI / AI) and citation export -----------------
  const [pageMeta, setPageMeta] = useState(null);   // properties.meta of the open page
  const [pageBibtex, setPageBibtex] = useState("");
  const [metaBusy, setMetaBusy] = useState(false);
  const [pptCite, setPptCite] = useState("");
  const [pptCiteBusy, setPptCiteBusy] = useState(false);
  const [metaPopPos, setMetaPopPos] = useState({ top: 0, right: 0 }); // fixed-position anchor for the metadata popover
  const [citeCopied, flashCiteCopied, resetCiteCopied] = useCopied(); // "bibtex" | "ppt"
  // Editable copy of the metadata fields shown in the popover. Kept as flat
  // strings (authors comma-joined); rebuilt whenever the popover opens or a
  // fetch lands, so a refresh replaces any half-typed edits with the result.
  const [metaDraft, setMetaDraft] = useState(null);
  useEffect(() => {
    if (openPopover === "meta") setMetaDraft(metadataToDraft(pageMeta));
  }, [openPopover, pageMeta]);
  // Unsaved edits in the popover — gates the Save button and Enter-to-save.
  const metaDirty = metaDraft && JSON.stringify(metaDraft) !== JSON.stringify(metadataToDraft(pageMeta));

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
    if (openPopover !== "meta" || !docId || readOnly) { setPdfTextInfo(null); return; }
    checkPdfText();
  }, [openPopover, docId]);

  // Modal preview of what the AI actually gets to read.
  const [pdfTextPreview, setPdfTextPreview] = useState(null); // null | {loading} | {text}
  async function openPdfTextPreview() {
    if (!docId) return;
    setPdfTextPreview({ loading: true });
    try {
      const d = await apiJson(`${API}/pdf-text-status?doc_id=${encodeURIComponent(docId)}&preview=12000`);
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
      setFocusedBlock((prev) => prev && prev.id === blockId
        ? { ...prev, properties: { ...prev.properties, meta: data.meta, bibtex: data.bibtex, ppt_cite: "", meta_error: undefined } }
        : prev);
      if (data.meta?.title && /^PDF Notes - /.test(focusedBlock?.content || "")) {
        await renameTitle(data.meta.title);
      }
      fetchHomeBlocks(); // keep the library's meta fresh for DOI-link matching
      setStatus("Metadata saved.");
    } catch (err) {
      setStatus(`Metadata save failed: ${err.message}`);
    }
  }
  // Editable prompts for metadata extraction and PPT citations (empty = server default)
  const [metaPrompt, setMetaPrompt] = usePersistedState("gamma-meta-prompt", "");
  const [citePrompt, setCitePrompt] = usePersistedState("gamma-cite-prompt", "");
  const [metaPromptDraft, setMetaPromptDraft] = useState("");
  const [citePromptDraft, setCitePromptDraft] = useState("");

  const focusedBlockIdRef = useRef("");
  useEffect(() => { focusedBlockIdRef.current = focusedBlockId || ""; }, [focusedBlockId]);
  const attemptedMetaRef = useRef(new Set()); // pages we already tried this session

  // Model actually sent with metadata lookups (per-paper fetch AND the
  // Settings batch retry): the dedicated pick while it's inside the active
  // key's scope, else the (already-scoped) chat model.
  const metaFetchModel = metaModel && scopedAiModels.some((m) => m.id === metaModel)
    ? metaModel
    : chatSendModel;

  async function fetchMetadata(block, force) {
    if (!block?.id) return;
    setMetaBusy(true);
    if (force) setStatus("Refreshing paper metadata…");
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
      if (focusedBlockIdRef.current !== block.id) return;
      setPageMeta(data.meta || null);
      setPageBibtex(data.bibtex || "");
      setPptCite(""); // fresh metadata invalidates the cached slide citation
      setFocusedBlock((prev) => prev && prev.id === block.id
        ? { ...prev, properties: { ...prev.properties, meta: data.meta, bibtex: data.bibtex, meta_error: undefined } }
        : prev);
      // Auto-fill the page title from metadata when it's still the default filename
      // title — awaited so the library refetch below can't win the race and
      // resurrect the stale name in the link dialog / home list.
      if (data.meta?.title && /^PDF Notes - /.test(block.content || "") && focusedBlockIdRef.current === block.id) {
        await renameTitle(data.meta.title);
      }
      if (!data.cached) {
        setStatus(`Paper metadata found (${data.source === "ai" ? "AI-extracted" : data.source}).`);
        fetchHomeBlocks(); // keep the library's meta fresh for DOI-link matching
      }
      // The slide citation rides along with metadata — by the time the
      // popover is opened it's already cached on the page.
      if (data.meta || data.bibtex) makePptCitation(false, block);
    } catch (err) {
      updateTransfer(taskId, { status: "error", info: (err.message || "failed").slice(0, 60) });
      if (focusedBlockIdRef.current === block.id) setStatus(`Metadata: ${err.message}`);
      // Mirror the server's negative-cache marker into the client copy —
      // otherwise the next autosave PUTs the stale properties and resurrects
      // the auto-retry on every open.
      setFocusedBlock((prev) => prev && prev.id === block.id
        ? { ...prev, properties: { ...prev.properties, meta_error: { at: new Date().toISOString(), detail: (err.message || "failed").slice(0, 200) } } }
        : prev);
    } finally {
      setMetaBusy(false);
    }
  }

  // When a paper is opened/uploaded, fetch its metadata in the background
  // (arXiv → DOI → AI on the server). Cached in the page's properties.
  useEffect(() => {
    setPptCite("");
    resetCiteCopied();
    const b = focusedBlock;
    if (readOnly || !b?.id || !b.properties?.doc_id) { setPageMeta(null); setPageBibtex(""); return; }
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
  }, [focusedBlock?.id]);

  // Import annotations embedded in the PDF file itself (SumatraPDF, Acrobat…).
  // Idempotent server-side, so calling it on every upload is safe.
  async function importEmbeddedAnnots(blockId, targetDocId, silent) {
    const taskId = addTransfer({ name: "Importing embedded PDF annotations", kind: "import", info: "scanning…" });
    try {
      const res = await apiJson(`${API}/import/pdf-annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block_id: blockId, doc_id: targetDocId, strip: embAnnots === "strip" }),
      });
      updateTransfer(taskId, {
        status: "done",
        info: res.imported > 0 ? `${res.imported} imported` : res.found > 0 ? "already imported" : "none found",
      });
      if (res.imported > 0) {
        if (focusedBlockIdRef.current === blockId) await loadBlocksForBlock(blockId);
        setStatus(`Imported ${res.imported} annotation${res.imported === 1 ? "" : "s"} embedded in the PDF.`);
      }
      if (res.stripped > 0 && focusedBlockIdRef.current === blockId) {
        // The stored file changed — cache-bust so the open viewer re-renders
        // the page without the now-stripped annotations baked in.
        setPdfUrl((u) => (u ? u + (u.includes("?") ? "&" : "?") + "annots=" + Date.now() : u));
      }
      if (res.imported === 0 && !silent) {
        setStatus(res.found > 0
          ? "All embedded annotations were already imported."
          : "No annotations embedded in this PDF.");
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
    const taskId = addTransfer({ name: `Slide citation — ${(blockArg?.content || pdfTitle || "paper").slice(0, 48)}`, kind: "ai", info: "generating…" });
    try {
      const data = await apiJson(`${API}/metadata/cite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block_id: targetId, prompt: citePrompt || "", model: chatSendModel || "", force }),
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
  }, [openPopover, pageMeta]);

  async function copyCitation(kind, text) {
    try {
      if (kind === "ppt" && navigator.clipboard?.write && window.ClipboardItem) {
        // Rich copy: PowerPoint/Word get real italics & bold, plain-text
        // targets get the clean string without markdown markers.
        const esc = (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const html = esc
          .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
          .replace(/_([^_]+)_/g, "<i>$1</i>")
          .replace(/\*([^*]+)\*/g, "<i>$1</i>");
        const plain = (text || "")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/_([^_]+)_/g, "$1")
          .replace(/\*([^*]+)\*/g, "$1");
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        })]);
      } else {
        await navigator.clipboard.writeText(text || "");
      }
      flashCiteCopied(kind);
    } catch {
      setStatus("Copy failed — copy manually.");
    }
  }

  useEffect(() => {
    if (!authUser?.user || readOnly) return;
    refreshAiModels();
  }, [authUser]);

  useEffect(() => {
    if (!chatModel) return;
    try {
      localStorage.setItem("gamma-chat-model", chatModel);
      // Also file it under its key (registry ids are "<entryId>:<model>").
      const key = (aiInfo?.models || []).find((m) => m.id === chatModel)?.provider || chatModel.split(":")[0];
      if (key) {
        chatModelMemRef.current = { ...chatModelMemRef.current, [key]: chatModel };
        localStorage.setItem("gamma-chat-model-by-key", JSON.stringify(chatModelMemRef.current));
      }
    } catch {}
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
    function onTouchStart() { touchSeen = true; }
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
  useEffect(() => { setPdfSelections([]); }, [focusedBlockId]);

  function fetchHomeBlocks() {
    return apiJson(`${API}/blocks/root/children`)
      .then((data) => setHomeBlocks(Array.isArray(data.children) ? data.children : []))
      .catch(() => setHomeBlocks([]));
  }

  useEffect(() => {
    if (authUser?.user && !readOnly) fetchHomeBlocks();
  }, [authUser]);

  useEffect(() => {
    function onExpired() { setAuthUser(false); }
    window.addEventListener("gamma-auth-expired", onExpired);
    return () => window.removeEventListener("gamma-auth-expired", onExpired);
  }, []);
  const pendingJumpRef = useRef(null);
  // Phase B2a: drop indicator state
  const [dropTarget, setDropTarget] = useState(null); // { targetId, above, rect }

  useEffect(() => {
    window._gammaSetDropTarget = setDropTarget;
    return () => { window._gammaSetDropTarget = null; };
  }, []);



  const [notesVisible, setNotesVisible] = useState(true);
  // Phone layout: which overlay panel covers the center ('notes' | 'chat' |
  // null = the main view). Reset on navigation so a new page opens on its content.
  const isPhone = useIsPhone();
  const [phonePanel, setPhonePanel] = useState(null);
  // Phone: drag-on-PDF mode — text selection (default) or rectangle drawing.
  // Desktop expresses this by holding Ctrl; a phone has no Ctrl, so it gets a
  // sticky toggle button in the viewer's zoom column instead.
  const [areaSelectMode, setAreaSelectMode] = useState(false);
  const [flashingId, setFlashingId] = useState(null);
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
    if (!focusedBlockId) { setBacklinks([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiJson(`${API}/blocks/${focusedBlockId}/backlinks`);
        if (!cancelled) setBacklinks(data.backlinks || []);
      } catch { if (!cancelled) setBacklinks([]); }
    })();
    return () => { cancelled = true; };
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
    if (autosaveTimerRef.current) { clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null; }
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
      properties: { ...b.properties, color: newColor }
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
          data.blocks.forEach((b) => { next[b.id] = b; });
          return next;
        });
      }
    } catch (_) {}
  }

  function onCacheRef(id, blockData) {
    setRefCache((prev) => prev[id] ? prev : { ...prev, [id]: blockData });
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
          const data = await apiJson(`${API}/block-search?ids=${encodeURIComponent(initialBlockId)}`);
          const block = data.blocks?.[0];
          const rootId = block?.page_root_id;
          if (rootId && rootId !== initialBlockId) {
            pendingBlockScrollRef.current = initialBlockId;
            pendingJumpRef.current = initialBlockId; // highlight blocks also jump the PDF
            openBlock(rootId);
          } else {
            openBlock(initialBlockId);
          }
        } catch {
          openBlock(initialBlockId);
        }
      })();
    }
    else if (initialUrl) openPdf(initialUrl);
    else if (initialCategory || initialFolder) {
      // Stay on home page with the category/folder filter — don't restore session
    }
    else {
      // Bare `/` — try restore last session
      const session = loadSession();
      if (session.focusedBlockId) {
        openBlock(session.focusedBlockId).catch(() => {
          clearSession();
          setFocusedBlockId("");
        });
      }
    }
  }, []);

  // Restore viewer/layout prefs from session on mount
  useEffect(() => {
    const session = loadSession();
    if (session.pdfScale != null) setPdfScale(session.pdfScale);
    if (session.pdfHidden != null) setPdfHidden(session.pdfHidden);
    if (session.notesVisible != null) setNotesVisible(session.notesVisible);
  }, []);

  // Theme follows the OS preference — no in-app toggle.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Record a "recently viewed" entry whenever a page is opened.
  useEffect(() => {
    if (!focusedBlockId || readOnly || !prefsUserRef.current) return;
    pushRecentView(focusedBlockId);
  }, [focusedBlockId, readOnly]);

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
      const reason = readOnly ? "readonly"
        : !focusedBlockId ? "no-focused-block"
        : !pdfUrl ? "no-pdf-url"
        : pdfRenderedUrlRef.current !== pdfUrl ? "doc-not-rendered"
        : restoringForRef.current === focusedBlockId ? "exact-restore-inflight"
        : coarseRestorePendingRef.current ? "coarse-restore-pending"
        : "";
      if (reason !== trackPauseReasonRef.current) {
        trackPauseReasonRef.current = reason;
        dbg(reason ? `tracker paused (${reason}) at page ${n}` : `tracker recording from page ${n}`);
      }
      if (reason) return;
      recordReadPos(focusedBlockId, n);
    };
  });

  async function loadBlocksForBlock(blockId) {
    try {
      const data = await apiJson(`${API}/blocks/${blockId}/subtree`);
      const children = normalizeBlocks((data.block?.children) || []);
      suppressAutosaveRef.current = true;
      setBlocks(children);
      return children;
    } catch {
      suppressAutosaveRef.current = true;
      setBlocks([]);
      return [];
    }
  }

  async function getOrCreateBlockForDoc(targetDocId, defaultTitle, sourceUrl) {
    if (!targetDocId) throw new Error("docId required");
    return await apiJson(`${API}/blocks/by-doc/${targetDocId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_title: defaultTitle || `PDF Notes - ${targetDocId}`, source_url: sourceUrl || null })
    });
  }

  async function renameTitle(newTitle) {
    if (readOnly || !focusedBlockId) return;
    const trimmed = (newTitle || "").trim();
    const finalTitle = trimmed || getPdfPageTitle(docId, inputUrl);
    setPdfTitle(finalTitle);
    setFocusedBlock((b) => b ? { ...b, content: finalTitle } : b);
    try {
      await apiJson(`${API}/blocks/${focusedBlockId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: finalTitle })
      });
      setHomeBlocks((prev) => prev.map((b) => b.id === focusedBlockId ? { ...b, content: finalTitle } : b));
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
      body: JSON.stringify({ blocks: nextBlocks })
    });
  }

  async function uploadPdf(file) {
    if (readOnly) return;
    if (!file || file.type !== "application/pdf") {
      setStatus("Not a PDF file.");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setStatus("File too large (max 50 MB).");
      return;
    }
    setLoading(true);
    setStatus(`Uploading ${file.name}...`);
    const transferId = addTransfer({ name: file.name, kind: "upload", info: fmtBytes(file.size) });
    try {
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch(`${API}/uploads`, { method: "POST", body: form, credentials: "include" });
      if (!resp.ok) {
        const msg = await resp.text();
        updateTransfer(transferId, { status: "error", info: "failed" });
        throw new Error(msg || `upload failed (${resp.status})`);
      }
      const data = await resp.json();
      updateTransfer(transferId, { status: "done", info: fmtBytes(file.size) });
      // Open the uploaded PDF directly (bypass openPdf's URL-resolution path)
      const sourceUrl = data.source_url;
      const defaultTitle = getPdfPageTitle(data.doc_id, sourceUrl);
      const block = await getOrCreateBlockForDoc(data.doc_id, defaultTitle, sourceUrl);
      const nextBlocks = await loadBlocksForBlock(block.id);
      setDocId(data.doc_id);
      setInputUrl(sourceUrl);
      setFocusedBlockId(block.id);
      setFocusedBlock(block);
      setPdfTitle(block.content || defaultTitle);
      setSummary(block.properties?.summary || "");
      setCategory(block.properties?.category || "");
      setPdfUrl(sourceUrl);
      const newUrl = `${window.location.pathname}?block=${encodeURIComponent(block.id)}`;
      window.history.replaceState({}, "", newUrl);
      setStatus(`Uploaded ${file.name} (${data.doc_id})`);
      // If the file carries embedded annotations (SumatraPDF etc.), pull them in
      importEmbeddedAnnots(block.id, data.doc_id, true);
    } catch (err) {
      setStatus(`Upload failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function importLogseq(files) {
    if (readOnly) return;
    const all = Array.from(files);
    const pdfFile = all.find((f) => f.name.endsWith('.pdf'));
    const ednFile = all.find((f) => f.name.endsWith('.edn'));
    const mdFile  = all.find((f) => f.name.endsWith('.md'));
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
      const resp = await fetch(`${API}/import/logseq`, { method: "POST", body: form, credentials: "include" });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      // Block was already created by the import endpoint; just load it.
      const block = await getOrCreateBlockForDoc(data.doc_id, pdfFile.name.replace('.pdf', ''), data.source_url);
      await loadBlocksForBlock(block.id);
      setDocId(data.doc_id);
      setInputUrl(data.source_url);
      setFocusedBlockId(block.id);
      setFocusedBlock(block);
      setPdfTitle(block.content || pdfFile.name.replace('.pdf', ''));
      setSummary(block.properties?.summary || "");
      setCategory(block.properties?.category || "");
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

  async function openPdf(sourceUrl) {
    if (!sourceUrl || readOnly) return;
    leaveCurrentPage();
    setLoading(true);
    setStatus("Opening PDF...");
    // Visible from the moment Enter is pressed — resolve can take seconds.
    const taskId = addTransfer({ name: sourceUrl.slice(0, 60), kind: "download", info: "resolving…" });
    try {
      // Uploaded PDFs are already hosted locally — skip external resolve and proxy.
      const isUpload = sourceUrl.startsWith("/api/uploads/") || sourceUrl.startsWith(`${API}/uploads/`);
      let finalUrl, resolvedDocId, proxiedUrl, pdfNote = "";
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
        proxiedUrl = `${API}/pdf?source_url=${encodeURIComponent(finalUrl)}${pdfSaveLocal ? "&save=1" : ""}`;
        transferByUrlRef.current[proxiedUrl] = taskId; // viewer's byte-level reporting takes over this row
      }
      // Resolve block + load children FIRST, before setPdfUrl, to avoid mid-render highlight race
      const defaultTitle = getPdfPageTitle(resolvedDocId, finalUrl);
      const block = await getOrCreateBlockForDoc(resolvedDocId, defaultTitle, finalUrl);
      updateTransfer(taskId, {
        name: (block.content || defaultTitle).slice(0, 60),
        ...(isUpload ? { status: "done", info: "local file" } : { info: "downloading…" }),
      });
      const nextBlocks = await loadBlocksForBlock(block.id);
      setDocId(resolvedDocId);
      setInputUrl(finalUrl);
      setFocusedBlockId(block.id);
      setFocusedBlock(block);
      setPdfTitle(block.content || defaultTitle);
      setSummary(block.properties?.summary || "");
      setCategory(block.properties?.category || "");
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
        body: JSON.stringify({ parent_id: "root", content: "New note", ...(folderFilter ? { properties: { folder: folderFilter } } : {}) }),
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
      const userParam = data.username ? `?user=${encodeURIComponent(data.username)}` : "";

      let block = null;
      try { block = await apiJson(`${API}/blocks/by-doc/${data.doc_id}${userParam}`); } catch {}

      let childBlocks = [];
      if (block) {
        try {
          const subtreeData = await apiJson(`${API}/blocks/${block.id}/subtree${userParam}`);
          childBlocks = normalizeBlocks(subtreeData.block?.children || []);
        } catch {}
      }

      const props = block?.properties || {};
      const src = props.source_url || props.sourceUrl || "";
      const isLocal = src.startsWith("/api/");
      const proxiedUrl = isLocal ? src : src ? `${API}/pdf?source_url=${encodeURIComponent(src)}${userParam ? "&" + userParam.slice(1) : ""}` : "";

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
      const childBlocks = normalizeBlocks(block.children || []);

      suppressAutosaveRef.current = true;
      setFocusedBlockId(blockId);
      setFocusedBlock(block);
      setPdfTitle(block.content || "Untitled");
      setSummary(props.summary || "");
      setCategory(props.category || "");
      setDocId(props.doc_id || "");

      let openedPdfUrl = "";
      if (props.source_url) {
        const src = props.source_url;
        const isLocal = src.startsWith("/api/");
        openedPdfUrl = isLocal ? src : `${API}/pdf?source_url=${encodeURIComponent(src)}`;
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
          setBlocks([{ id: seedId, content: "", children: [], collapsed: false, editMode: true, properties: {} }]);
        } else {
          setBlocks(childBlocks);
        }
      }

      // Scroll notes panel to the most recently updated block, unless a
      // specific target was already queued (e.g. ?block=... deep link).
      if (!pendingBlockScrollRef.current && childBlocks.length > 0) {
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
                if (cur.length !== arr.length) { pending = true; continue; }
                if (cur.some((v, i) => Math.abs(v - arr[i]) > 0.5)) h.setLayout(arr);
              } catch { pending = true; }
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
      if (opts?.restoreScroll) restorePdfScroll(tabScrollRef.current[blockId], blockId, openedPdfUrl);
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
  useEffect(() => { pdfEffScaleRef.current = pdfEffScale; }, [pdfEffScale]);

  // Exact per-page reading positions so switching tabs returns to where you
  // were, not just to the same page. blockId -> {top, scale}.
  const tabScrollRef = useRef({});
  // Per-page window layout (dock slots, collapsed bars, hidden windows, and
  // panel size ratios) — captured when leaving a page, restored on reopen.
  const pageLayoutsRef = useRef({});
  const panelGroupRefs = useRef({}); // group key -> react-resizable-panels imperative handle
  useEffect(() => {
    if (!authUser?.user || readOnly) return;
    try { pageLayoutsRef.current = JSON.parse(localStorage.getItem(`gamma-page-layouts:${authUser.user}`) || "{}"); }
    catch { pageLayoutsRef.current = {}; }
  }, [authUser?.user, readOnly]);
  const restoreTokenRef = useRef(0);   // bumped on navigation — kills in-flight restore loops
  const restoringForRef = useRef(null); // block whose restore hasn't landed yet
  const pdfRenderedUrlRef = useRef(""); // url of the document whose pages are in the DOM
  const pendingRestoreRef = useRef(null); // {url, entry, blockId, token} applied pre-paint on "rendered"
  function captureScrollPos() {
    // The page's window layout travels with it — including panel size ratios.
    if (focusedBlockId && !readOnly && prefsUserRef.current) {
      const sizes = {};
      for (const [k, h] of Object.entries(panelGroupRefs.current)) {
        try { if (h) sizes[k] = h.getLayout(); } catch {}
      }
      pageLayoutsRef.current[focusedBlockId] = { layout, collapsed: collapsedWins, pdfHidden, chatHidden, notesVisible, sizes, pdfScale };
      try {
        const keys = Object.keys(pageLayoutsRef.current);
        while (keys.length > 80) delete pageLayoutsRef.current[keys.shift()];
        localStorage.setItem(`gamma-page-layouts:${prefsUserRef.current}`, JSON.stringify(pageLayoutsRef.current));
      } catch {}
    }
    // Only record a position when the viewer is actually showing THIS page's
    // document: mid-load the scroller still holds the previous document (or a
    // clamped 0), and a pending restore means the real position hasn't been
    // applied yet — in both cases keep the previously saved value.
    if (restoringForRef.current && restoringForRef.current === focusedBlockId) return;
    if (!pdfUrl || pdfRenderedUrlRef.current !== pdfUrl) return;
    const scroller = viewerWrapRef.current?.querySelector(".pdfViewer");
    if (focusedBlockId && scroller) {
      tabScrollRef.current[focusedBlockId] = { top: scroller.scrollTop, scale: pdfEffScale };
    }
  }
  function cancelPdfRestore() {
    restoreTokenRef.current++;
    restoringForRef.current = null;
    pendingRestoreRef.current = null;
  }
  // Everything owed to the page being navigated away from: persist queued
  // edits, remember its scroll position + window layout, and kill any
  // in-flight scroll restore so it can't touch the next document.
  function leaveCurrentPage() {
    flushPendingSave();
    captureScrollPos();
    cancelPdfRestore();
  }
  // Scroll the viewer back to an exact position. Two gates, both required:
  // the TARGET document must be the one rendered (the old document stays in
  // the DOM until the new one loads — scrolling it is what made restores land
  // wrong and visibly slide before the switch), and its layout height must be
  // stable for two ticks (pages get real heights asynchronously). The jump
  // itself is instant, after the new document is visible.
  function restorePdfScroll(entry, blockId, targetUrl) {
    if (entry?.top == null || !targetUrl) return;
    dbg("exact restore: pending for", blockId, "top", Math.round(entry.top));
    const token = ++restoreTokenRef.current;
    restoringForRef.current = blockId || null;
    // Preferred path: the "rendered" callback applies this pre-paint the
    // moment the target document mounts. The polling loop below is the
    // fallback (already-rendered documents, layout not tall enough yet).
    pendingRestoreRef.current = { url: targetUrl, entry, blockId, token };
    let tries = 0;
    let lastH = -1;
    const finish = () => { if (restoringForRef.current === blockId) restoringForRef.current = null; };
    const tryScroll = () => {
      if (restoreTokenRef.current !== token) { dbg("exact restore: superseded by navigation"); return; }
      if (pdfRenderedUrlRef.current === targetUrl) {
        const scroller = viewerWrapRef.current?.querySelector(".pdfViewer");
        const h = scroller ? scroller.scrollHeight : 0;
        const targetTop = entry.top * ((pdfEffScaleRef.current || entry.scale || 1) / (entry.scale || 1));
        if (scroller && h > targetTop && h === lastH) {
          scroller.scrollTo({ top: targetTop, behavior: "instant" });
          pendingRestoreRef.current = null;
          dbg("exact restore: applied, top", Math.round(targetTop));
          finish();
          return;
        }
        lastH = h;
        // Only the settle-after-render window is budgeted; waiting for the
        // document itself is uncounted (same reasoning as the coarse
        // restore: a big PDF on a slow load outlives any fixed budget, and
        // giving up unfreezes the tracker at the top of the document, which
        // then records page 1 over the real reading position).
        if (tries++ >= 80) {
          dbg("exact restore: gave up settling; height", h, "target", Math.round(targetTop));
          finish();
          return;
        }
      }
      setTimeout(tryScroll, 120);
    };
    tryScroll();
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
      if (entry.folder) {
        setFolderFilter(entry.folder);
        window.history.replaceState(null, "", `/?folder=${encodeURIComponent(entry.folder)}`);
      }
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
    setBacklinks([]);
    setPdfHidden(false);
    setFolderFilter("");
    setCategoryFilter("");
    if (refreshHome) fetchHomeBlocks();
    window.history.replaceState({}, "", window.location.pathname);
  }

  function closeTab(id) {
    const idx = openTabs.findIndex((t) => t.id === id);
    const next = openTabs.filter((t) => t.id !== id);
    updateTabs(next);
    if (id === focusedBlockId) {
      const neighbor = next[Math.min(idx, next.length - 1)];
      if (neighbor) openBlock(neighbor.id, { restoreScroll: true });
      else goHome();
    }
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
    try { target.setPointerCapture(pointerId); } catch (_) {}

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
        r = { left: wa.left, top: wa.top + wa.height * 0.68, width: wa.width, height: wa.height * 0.32 };
      } else if (zone.side === "left") {
        r = { left: wa.left, top: wa.top, width: wa.width * 0.26, height: wa.height };
      } else {
        r = { left: wa.left + wa.width * 0.72, top: wa.top, width: wa.width * 0.28, height: wa.height };
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
      try { target.releasePointerCapture(pointerId); } catch (_) {}
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  function addCategoryTag(tag) {
    if (!tag.trim()) return;
    setCategory(prev => {
      const tags = prev ? prev.split(",").map(t => t.trim()).filter(Boolean) : [];
      if (!tags.includes(tag.trim())) tags.push(tag.trim());
      return tags.join(",");
    });
  }

  function removeCategoryTag(index) {
    setCategory(prev => {
      const tags = prev ? prev.split(",").map(t => t.trim()).filter(Boolean) : [];
      if (index < 0) tags.pop();
      else tags.splice(index, 1);
      return tags.join(",");
    });
  }

  function commitAndCloseCategory() {
    const finalCategory = (() => {
      const tags = category ? category.split(",").map(t => t.trim()).filter(Boolean) : [];
      const input = categoryInput.trim();
      if (input && !tags.includes(input)) tags.push(input);
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
    try {
      await navigator.clipboard.writeText(shareUrl);
      flashShareCopied();
    } catch {
      setStatus("Copy failed — copy the link manually.");
    }
  }

  // Download the current page as Markdown. The server returns a bare .md, or a
  // .zip (page + assets/) when the page references uploaded files — we save
  // whichever comes back, taking the filename from Content-Disposition. Using
  // fetch+blob (not a plain navigation) so a 404/401 surfaces as a message
  // instead of silently swapping the SPA for an error page.
  async function downloadExport(path, fallbackName) {
    setStatus("Exporting page…");
    // Shared (read-only) views: every export resolves the owner's data from
    // ?user= (auth.resolve_user) — applied here so no call site can forget it.
    const userQ = shareUserQuery();
    if (userQ && !path.includes("user=")) path += (path.includes("?") ? "&" : "?") + userQ;
    try {
      const res = await fetch(`${API}${path}`, { credentials: "include" });
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.json()).detail || ""; } catch { /* not JSON */ }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      const ctype = res.headers.get("Content-Type") || "";
      // If the SPA fallback served index.html, the export route isn't live yet.
      if (ctype.includes("text/html")) throw new Error("export route not found — restart the backend");
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
      setStatus(`Exported ${filename}`);
    } catch (err) {
      setStatus(`Export failed: ${err.message}`);
    }
  }

  // Owner of a shared (read-only) view — downloadExport appends it as ?user=.
  const shareOwnerRef = useRef("");
  const shareUserQuery = () =>
    readOnly && shareOwnerRef.current ? `user=${encodeURIComponent(shareOwnerRef.current)}` : "";

  async function exportPage(mode = "readable") {
    const id = focusedBlock?.id;
    if (!id) { setStatus("Open a page first to export it."); return; }
    setOpenPopover(null);
    await downloadExport(`/pages/${id}/export?mode=${mode}`, "page.md");
  }

  // Download the PDF with the page's highlights burned in as standard PDF
  // annotations (notes become annotation popups) — viewable anywhere.
  async function exportAnnotatedPdf() {
    const id = focusedBlock?.id;
    if (!id) { setStatus("Open a page first to export it."); return; }
    setOpenPopover(null);
    await downloadExport(`/pages/${id}/export-pdf`, "annotated.pdf");
  }

  // Download the PDF exactly as stored — no highlight annotations. Reuses the
  // viewer's own URL (uploads route or /pdf proxy), so it works in share views.
  async function exportRawPdf() {
    if (!pdfUrl) { setStatus("No PDF open."); return; }
    setOpenPopover(null);
    const path = pdfUrl.startsWith(API) ? pdfUrl.slice(API.length) : pdfUrl;
    const name = `${(pdfTitle || docId || "paper").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.pdf`;
    await downloadExport(path, name);
  }

  // Ask the AI for the document's title and fill it into the page name.
  const [aiTitleBusy, setAiTitleBusy] = useState(false);
  const [sourceDraft, setSourceDraft] = useState(""); // edit buffer for the source-PDF popover
  async function aiFillTitle() {
    if (!docId || readOnly || aiTitleBusy) return;
    setAiTitleBusy(true);
    setStatus("Asking AI for the title…");
    const taskId = addTransfer({ name: `AI title — ${(pdfTitle || "paper").slice(0, 48)}`, kind: "ai", info: "asking…" });
    try {
      const data = await apiJson(`${API}/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Extract the exact title of this document. Reply with ONLY the title text — no quotes, no authors, no extra words.",
          doc_id: docId,
          history: [],
          model: chatSendModel || "",
        }),
      });
      const title = (data.response || "").trim().replace(/^["'\s]+|["'\s]+$/g, "").split("\n")[0].slice(0, 200);
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
    nextBlocks = nextBlocks.map((b) => b.id === withId.id ? { ...b, editMode: true } : b);
    pendingFocusRef.current = withId.id;
    pendingBlockScrollRef.current = withId.id;
    setBlocks(nextBlocks);
    // autosave effect will persist
    setStatus("Highlight saved.");
  }

  useEffect(() => { attachModeBlockIdRef.current = attachModeBlockId; }, [attachModeBlockId]);

  // Escape cancels attach mode
  useEffect(() => {
    if (!attachModeBlockId) return;
    const onKey = (e) => { if (e.key === 'Escape') { setAttachModeBlockId(null); setAttachContextMenu(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [attachModeBlockId]);

  async function linkHighlightToBlock(blockId, highlight) {
    // Store a pointer to the existing highlight's id, NOT a copy of its position.
    // Copying the position would create a duplicate visual highlight on the PDF at the same spot.
    // The jump logic resolves linked_highlight_id → scrolls to the real highlight.
    await fetch(`/api/blocks/${blockId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
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
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: {
          linked_highlight_id: null,
        },
      }),
    });
    await loadBlocksForBlock(focusedBlockId);
  }

  // (Re)entering the Prompts pane rebuilds the drafts from the saved values —
  // switching away without saving is the cancel path.
  useEffect(() => {
    if (settingsOpen !== "prompts") return;
    setPromptDraft(chatSystem || aiInfo?.default_prompt || "");
    setMetaPromptDraft(metaPrompt || aiInfo?.metadata_prompt || "");
    setCitePromptDraft(citePrompt || aiInfo?.cite_prompt || "");
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
      setBlocks(updateBlockTree(blocks, ld.editBlockId, (b) => ({
        ...b,
        properties: { ...b.properties, link_url: target.url || "", link_page_id: target.pageId || "", link_highlight_id: target.highlightId || "" },
      })));
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
      properties: { ...b.properties, link_url: target.url || "", link_page_id: target.pageId || "", link_highlight_id: target.highlightId || "" },
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
  useEffect(() => { setSelectedPages(new Set()); setSelectedFolders(new Set()); setHomeMenu(null); }, [folderFilter, homeMode]);
  const pageOnly = !pdfUrl && !!focusedBlockId && !readOnly;
  // Phone: navigating to another page (or home) closes any overlay panel.
  useEffect(() => { setPhonePanel(null); }, [focusedBlockId, homeMode]);
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
  const folderCounts = useMemo(() => {
    const m = {};
    for (const f of childFolders) {
      m[f] = pageBlocks.filter((b) => b._folders.some((t) => t === f || t.startsWith(f + "/"))).length;
    }
    return m;
  }, [childFolders, pageBlocks]);
  // What the home list shows: inside a folder → pages tagged exactly that
  // path (deeper ones live in the subfolder rows); at root → EVERY page as a
  // sortable recents feed, loaded incrementally.
  const homeSortedPages = useMemo(() => {
    const arr = folderFilter ? pageBlocks.filter((b) => b._folders.includes(folderFilter)) : [...pageBlocks];
    const cmp = homeSort === "title" ? (a, b) => a.content.localeCompare(b.content)
      : homeSort === "created" ? (a, b) => (b._createdAt || "").localeCompare(a._createdAt || "")
      : (a, b) => (b._updatedAt || "").localeCompare(a._updatedAt || "");
    return arr.sort(cmp);
  }, [pageBlocks, folderFilter, homeSort]);
  const homeVisiblePages = useMemo(() => homeSortedPages.slice(0, homeShowCount), [homeSortedPages, homeShowCount]);
  // Pinned papers — shown as a favorites strip at the library root. Most
  // recently pinned first.
  const pinnedPages = useMemo(
    () => pageBlocks.filter((b) => b._pinned).sort((a, b) => (b._pinned || "").localeCompare(a._pinned || "")),
    [pageBlocks]
  );
  // Recently-viewed pages that still exist, most recent first (top shortcut bar).
  const recentViewedPages = useMemo(() => {
    const byId = new Map(pageBlocks.map((b) => [b._pageId, b]));
    return recentViews
      .map((r) => { const b = byId.get(r.id); return b ? { ...b, _viewedAt: r.at } : null; })
      .filter(Boolean)
      .slice(0, 12);
  }, [recentViews, pageBlocks]);
  // Home keyboard: Esc clears the selection, Enter opens the single selected
  // item — the standard file-manager shortcuts.
  useEffect(() => {
    if (!homeMode) return;
    function onKey(e) {
      if (e.target.closest && e.target.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape" && (selectedPages.size || selectedFolders.size)) {
        clearSelection();
      } else if (e.key === "Enter") {
        if (selectedFolders.size === 1) openFolder([...selectedFolders][0]);
        else if (selectedPages.size === 1) openPage([...selectedPages][0]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [homeMode, selectedPages, selectedFolders]);
  // Scrolling the "load more" sentinel into view grows the feed.
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setHomeShowCount((c) => c + HOME_PAGE_CHUNK);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [homeVisiblePages.length, homeSortedPages.length, homeMode]);
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
      return (url || pageId) ? { ...h, linkTarget: { url, pageId, highlightId: p.link_highlight_id || "" } } : h;
    });
    const json = JSON.stringify(next);
    if (json === prevHighlightsRef.current.json) return prevHighlightsRef.current.value;
    prevHighlightsRef.current = { json, value: next };
    return next;
  }, [blocks, visibleBlocks]);
  const highlightColors = useMemo(
    () => Object.fromEntries(highlights.map((h) => [h.id, h.color])),
    [highlights]
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
        const b = flattenBlocks(blocks).find((b) => b.properties?.highlight_id === id || b.id === id);
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
    if (restoredPdfUrlRef.current === pdfUrl) { dbg("restore: already done for this doc"); return; }
    const fid = focusedBlockIdRef.current;
    // Tab switches restore an exact per-page position (tabScrollRef) — the
    // coarse last-read page is only for (re)opening a paper cold.
    if (tabScrollRef.current[fid]) { dbg("restore: exact tab position exists for", fid); return; }
    dbg("restore: waiting for doc;", fid, "entry:", readPosRef.current[fid] || null);
    const sess = loadSession();
    const sessSaved = fid && sess.focusedBlockId === fid ? sess.pdfPageNumber : 0;
    coarseRestorePendingRef.current = true;
    let cancelled = false;
    let tries = 0;
    const done = () => { coarseRestorePendingRef.current = false; };
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
      if (!saved || saved <= 1) { dbg("restore: nothing to restore (saved page", saved, ")"); done(); return; }
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
      let stable = 0, settleTries = 0, userTookOver = false, inputEl = null;
      const INPUT_EVS = ["wheel", "touchstart", "mousedown"];
      const onUserInput = () => { userTookOver = true; };
      const unhookInput = () => {
        if (inputEl) for (const ev of INPUT_EVS) inputEl.removeEventListener(ev, onUserInput);
        inputEl = null;
      };
      const settle = () => {
        if (cancelled) { unhookInput(); return; }
        const scroller = viewerWrapRef.current?.querySelector(".pdfViewer");
        if (!scroller || settleTries++ > 60) { unhookInput(); done(); return; }
        if (userTookOver) { dbg("restore: user took over during settle"); unhookInput(); done(); return; }
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
          if (++stable >= 2) { dbg("restore: settled at page", saved); unhookInput(); done(); return; }
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
    return () => { cancelled = true; done(); };
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
        const pages = target.querySelectorAll('[data-page]');
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
            if (n) { setPdfPageNumber(n); recordScrollPageRef.current?.(n); }
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
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
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
        onReload={() => { window.location.href = window.location.pathname; }}
      />
    );
  }

  // The notes window - docked via notesDock, or filling the center when no PDF is shown.
  const notesWindow = notesVisible ? (
    <div className="sidebar">
          {!homeMode && <div className="pageTitleRow">
            <div className="pageTitleMain">
            {titleEditing && !readOnly && focusedBlockId ? (
              <input
                className="titleEdit"
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => { renameTitle(titleDraft); setTitleEditing(false); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.currentTarget.blur(); }
                  else if (e.key === "Escape") { setTitleDraft(pdfTitle); setTitleEditing(false); }
                }}
              />
            ) : (
              <h3
                className={!readOnly && focusedBlockId ? "titleText editable" : "titleText"}
                title={!readOnly && focusedBlockId ? "Click to rename" : undefined}
                onClick={() => {
                  if (readOnly || !focusedBlockId) return;
                  setTitleDraft(pdfTitle || (docId ? getPdfPageTitle(docId, inputUrl) : "Untitled"));
                  setTitleEditing(true);
                }}
              >{focusedBlockId ? (pdfTitle || (docId ? getPdfPageTitle(docId, inputUrl) : "Untitled")) : "PDF Notes"}</h3>
            )}
            {focusedBlockId && !readOnly ? (
              <div className="categoryFrontmatter">
                <span className="categoryIcon" title="Labels">
                  <LabelIcon size={13} />
                </span>
                {categoryEditing ? (() => {
                    const currentTags = category.split(",").map(t => t.trim()).filter(Boolean);
                    const q = categoryInput.trim();
                    const suggestions = q ? [...new Set(homeBlocks.flatMap(b =>
                      (b.properties?.category || "").split(",").map(t => t.trim()).filter(Boolean)
                    ))].filter(t =>
                      t.toLowerCase().includes(q.toLowerCase()) &&
                      !currentTags.includes(t)
                    ).sort().slice(0, 8) : [];
                    return (
                    <div className="categoryTagInputContainer">
                      <div className="categoryTagInputWrap">
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
                                if (tag) addCategoryTag(tag);
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
                            } else if (e.key === "Enter" && categorySuggestionIdx >= 0 && categorySuggestionIdx < suggestions.length) {
                              e.preventDefault();
                              addCategoryTag(suggestions[categorySuggestionIdx]);
                              setCategoryInput("");
                              setCategorySuggestionIdx(-1);
                            } else if (e.key === "Enter") {
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
                          placeholder="type to add..."
                        />
                      </div>
                      {suggestions.length > 0 ? (
                        <div className="categorySuggestions">
                          {suggestions.map((s, i) => (
                            <button key={s} className={`categorySuggestionItem${i === categorySuggestionIdx ? " selected" : ""}`}
                              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); addCategoryTag(s); setCategoryInput(""); setCategorySuggestionIdx(-1); }}
                              onMouseEnter={() => setCategorySuggestionIdx(i)}
                            >{s}</button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    );
                  })() : (
                    <span
                      className={`categoryFrontmatterValue ${category ? "" : "empty"}`}
                      onClick={() => { setCategoryInput(""); setCategorySuggestionIdx(-1); setCategoryEditing(true); }}
                      title="Click to edit"
                    >
                      {category ? (
                        category.split(",").map((t, i) => t.trim() ? (
                          <span
                            key={i}
                            className="categoryBadge"
                            title={`Label: ${t.trim()} — right-click to rename or delete`}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setHomeMenu({ kind: "label", name: t.trim(), x: e.clientX, y: e.clientY });
                            }}
                          >{t.trim()}</span>
                        ) : null)
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
                      title="Paper metadata (authors, venue, DOI, source file…)"
                      aria-label="Paper metadata"
                      onClick={(e) => {
                        const opening = openPopover !== "meta";
                        if (opening) {
                          // Fixed positioning so the popover floats above the
                          // window stack instead of being clipped by the
                          // notes window / drawn under the chat below it.
                          const r = e.currentTarget.getBoundingClientRect();
                          setMetaPopPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
                          setSourceDraft(inputUrl);
                        }
                        setOpenPopover(opening ? "meta" : null);
                      }}
                    >
                      <InfoIcon size={15} />
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
                          >{metaBusy ? "…" : "↻"}</button>
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
                                  onChange={(e) => setMetaDraft((d) => ({ ...(d || metadataToDraft(null)), [key]: e.target.value }))}
                                  onKeyDown={(e) => {
                                    if (e.key !== "Enter") return;
                                    e.preventDefault();
                                    // Enter = Save (only when something actually changed)
                                    if (metaDirty) saveMetaEdits();
                                  }}
                                  placeholder="—"
                                />
                                {key === "doi" && metaDraft?.doi?.trim() ? (
                                  <a className="metaLink" href={`https://doi.org/${metaDraft.doi.trim()}`} target="_blank" rel="noreferrer" title="Open on doi.org">
                                    <ExternalLinkIcon size={11} />
                                  </a>
                                ) : null}
                                {key === "arxiv_id" && metaDraft?.arxiv_id?.trim() ? (
                                  <a className="metaLink" href={`https://arxiv.org/abs/${metaDraft.arxiv_id.trim()}`} target="_blank" rel="noreferrer" title="Open on arXiv">
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
                                  >{aiTitleBusy ? "…" : <SparklesIcon size={13} />}</button>
                                ) : null}
                              </span>
                            </div>
                          ))}
                          {pageMeta?.source ? (
                            <div className="metaRow"><span className="metaKey">Source</span><span className="metaVal">{pageMeta.source === "ai" ? "AI-extracted" : pageMeta.source === "manual" ? "edited by hand" : pageMeta.source}</span></div>
                          ) : null}
                          <div className="metaRow">
                            <span className="metaKey">PDF text</span>
                            <span className="metaVal" style={{ flex: 1, display: "flex", alignItems: "center", gap: 6 }}>
                              {!pdfTextInfo || pdfTextInfo.checking ? "checking…"
                                : pdfTextInfo.error ? `check failed — ${pdfTextInfo.error}`
                                : !pdfTextInfo.found ? "file not on server"
                                : pdfTextInfo.ok ? "✓ extracted"
                                : "✗ none — scanned or image-only? AI can't read it"}
                              {pdfTextInfo?.ok ? (
                                <button className="searchToggle metaRowBtn" style={{ marginLeft: "auto" }}
                                  title="Preview the extracted text (what the AI reads)"
                                  onClick={openPdfTextPreview}><EyeIcon size={13} /></button>
                              ) : null}
                              {pdfTextInfo && !pdfTextInfo.checking && !pdfTextInfo.ok ? (
                                <button
                                  className="searchToggle metaRowBtn"
                                  style={{ marginLeft: "auto" }}
                                  title="Re-check text extraction (e.g. after replacing the source file) — retries the metadata lookup if text appears"
                                  onClick={() => checkPdfText(true)}
                                >↻</button>
                              ) : null}
                            </span>
                          </div>
                          <div className="metaRow">
                            <span className="metaKey">Index</span>
                            <span className="metaVal" title="Whether library-wide search can find text in this paper. Papers index automatically in the background; Settings → Search → Rebuild forces a full re-index.">
                              {!pdfTextInfo || pdfTextInfo.checking ? "checking…"
                                : pdfTextInfo.error || pdfTextInfo.indexed === undefined ? "—"
                                : pdfTextInfo.indexed ? "✓ indexed for search"
                                : pdfTextInfo.index_stale ? "stale — re-indexes automatically"
                                : "not yet indexed"}
                            </span>
                          </div>
                          {pdfTextPreview ? (
                            <div className="reportOverlay" onClick={() => setPdfTextPreview(null)}>
                              <div className="reportModal" style={{ width: "min(640px, calc(100vw - 32px))" }} onClick={(e) => e.stopPropagation()}>
                                <div className="reportModalTitle">Extracted PDF text</div>
                                <div className="reportPageList" style={{ maxHeight: "60vh", whiteSpace: "pre-wrap", fontSize: 12, color: "var(--text-secondary)", padding: 10 }}>
                                  {pdfTextPreview.loading ? "Extracting…" : pdfTextPreview.text}
                                </div>
                                {!pdfTextPreview.loading ? <div className="reportModalHint">First 12,000 characters — the AI context is drawn from this.</div> : null}
                                <div className="reportModalBtns">
                                  <button className="uiBtn" onClick={() => setPdfTextPreview(null)}>Close</button>
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                        {!pageMeta ? (
                          <div className="popoverHint">{metaBusy
                            ? "Fetching metadata…"
                            : focusedBlock?.properties?.meta_error
                              ? "A previous lookup found nothing — it won't retry automatically. Fill the fields in by hand, or hit ↻ to retry."
                              : "No metadata found — fill the fields in by hand, or hit ↻ to retry."}</div>
                        ) : null}
                        {metaDirty ? (
                          <div className="reportModalBtns">
                            <button className="uiBtn primary" onClick={saveMetaEdits}>Save metadata</button>
                          </div>
                        ) : null}
                        <div className="popoverDivider" />
                        <div className="popoverSection">Source file</div>
                        <input
                          className="searchInput"
                          value={sourceDraft}
                          onChange={(e) => setSourceDraft(e.target.value)}
                          placeholder="PDF URL or /api/uploads/…"
                        />
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
                            >Replace source</button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </span>
                ) : null}
                <button
                  className="pageActionBtn pageDeleteBtn"
                  title="Delete this page"
                  onClick={() => setConfirmBox({
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
                          localStorage.setItem(`gamma-tabs:${prefsUserRef.current}`, JSON.stringify(nextTabs));
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
                  })}
                >
                  <TrashIcon size={15} />
                </button>
              </div>
            ) : null}

          </div>}

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
            {homeMode ? (() => {
              // Group blocks by category (comma-separated — a page can be in multiple)
              const categories = {};
              const seenInCategory = new Set();
              for (const b of homeBlocks) {
                const raw = (b.properties?.category || "").trim();
                if (raw) {
                  const tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
                  for (const t of tags) {
                    if (!categories[t]) categories[t] = [];
                    categories[t].push(b);
                  }
                  seenInCategory.add(b.id);
                }
              }
              const uncategorized = homeBlocks.filter((b) => !seenInCategory.has(b.id));
              for (const cat of Object.keys(categories)) {
                categories[cat].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
              }
              const catNames = Object.keys(categories).sort();

              if (categoryFilter) {
                // Filtered view — show pages in this category only
                const filtered = categories[categoryFilter] || [];
                return (
                  <>
                    <button className="categoryBackBtn" onClick={() => { setCategoryFilter(""); window.history.replaceState(null, "", "/"); }}>
                      ← All pages
                    </button>
                    <div
                      className="categoryFilterHeading"
                      title="Right-click to rename or delete this label"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setHomeMenu({ kind: "label", name: categoryFilter, x: e.clientX, y: e.clientY });
                      }}
                    >{categoryFilter}</div>
                    <div className="carouselRow">
                      <div className="carouselTrackWrap">
                        <div className="carouselTrack">
                          {filtered.map((b) => (
                            <button key={b.id} className="recentCard" onClick={() => openBlock(b.id)} title={b.content}>
                              <div className="recentCardTitle">{b.content || "Untitled"}</div>
                              <div className="recentCardMeta">
                                {b.properties?.summary && <span className="recentCardSummary">{b.properties.summary}</span>}
                                <span className="recentCardTime">{formatRelativeTime(b.updated_at)}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                );
              }

              // Labels are surfaced as chips on each file row now — the top
              // carousel is a "recently viewed" shortcut bar instead. Category
              // filtering still works via ?category= URLs and search chips
              // (handled by the categoryFilter branch above).
              return recentViewedPages.length > 0 ? (
                <div className="carouselRow">
                  <div className="carouselLabel">Recently viewed</div>
                  <div className="carouselTrackWrap">
                    <button className="carouselArrow carouselArrowLeft" onClick={(e) => { const t = e.currentTarget.parentElement.querySelector('.carouselTrack'); if (t) t.scrollBy({ left: -220, behavior: 'smooth' }); }}>‹</button>
                    <div className="carouselTrack">
                      {recentViewedPages.map((b) => (
                        <button key={b._pageId} className="recentCard" onClick={() => openPage(b._pageId)} title={b.content}>
                          <div className="recentCardTitle">{b.content || "Untitled"}</div>
                          <div className="recentCardMeta">
                            <span className="recentCardKind">{b._sourceUrl ? "PDF" : "Note"}</span>
                            <span className="recentCardTime">{formatRelativeTime(b._viewedAt)}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                    <button className="carouselArrow carouselArrowRight" onClick={(e) => { const t = e.currentTarget.parentElement.querySelector('.carouselTrack'); if (t) t.scrollBy({ left: 220, behavior: 'smooth' }); }}>›</button>
                  </div>
                </div>
              ) : null;
            })() : null}
            {homeMode && !categoryFilter && !folderFilter && pinnedPages.length > 0 ? (
              <div className="pinnedSection">
                <div className="pinnedLabel"><PinIcon filled size={12} /> Pinned</div>
                <div className="pinnedStrip">
                  {pinnedPages.map((b) => (
                    <div
                      key={b._pageId}
                      className={`pinnedTile ${selectedPages.has(b._pageId) ? "selected" : ""}`}
                      onClick={(e) => handlePageClick(b, e)}
                      onDoubleClick={() => openPage(b._pageId)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelectedPages((prev) => (prev.has(b._pageId) ? prev : new Set([b._pageId])));
                        lastPageClickRef.current = b._pageId;
                        setHomeMenu({ kind: "page", id: b._pageId, name: b.content, x: e.clientX, y: e.clientY });
                      }}
                      title={`${b.content}\nClick to select · double-click to open`}
                    >
                      <FileGlyph isPdf={!!b._sourceUrl} />
                      <span className="pinnedTileName">{b.content || "Untitled"}</span>
                      <button
                        className="pinBtn pinned"
                        title="Unpin"
                        onClick={(e) => { e.stopPropagation(); setPagesPinned([b._pageId], false); }}
                      ><PinIcon filled size={12} /></button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {homeMode && !categoryFilter ? (
              <div className="folderBrowser">
                {folderFilter ? (
                  <>
                    <div
                      className={`folderRow folderBackRow ${folderDragOver === "__up__" ? "dragOver" : ""}`}
                      onClick={() => {
                        const parent = folderFilter.includes("/") ? folderFilter.slice(0, folderFilter.lastIndexOf("/")) : "";
                        setFolderFilter(parent);
                        window.history.replaceState(null, "", parent ? `/?folder=${encodeURIComponent(parent)}` : "/");
                      }}
                      onDragOver={(e) => { e.preventDefault(); setFolderDragOver("__up__"); }}
                      onDragLeave={() => setFolderDragOver(null)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setFolderDragOver(null);
                        const id = e.dataTransfer.getData("text/plain");
                        if (!id) return;
                        const ids = selectedPages.has(id) && selectedPages.size > 1 ? [...selectedPages] : [id];
                        removePagesFromFolder(ids, folderFilter);
                      }}
                      title="Back — or drop a paper here to remove it from this folder"
                    >
                      <ArrowLeftIcon size={14} />
                      <span className="folderName">{folderFilter.includes("/") ? folderFilter.slice(0, folderFilter.lastIndexOf("/")) : "All files"}</span>
                      <span className="folderHint">drop here to remove from this folder</span>
                    </div>
                    <div className="folderCurrent">
                      <FolderOpenIcon size={15} />
                      {/* Breadcrumb: every path segment navigates to its level */}
                      {folderFilter.split("/").map((seg, i, segs) => {
                        const prefix = segs.slice(0, i + 1).join("/");
                        return (
                          <span key={prefix}>
                            {i > 0 ? <span className="crumbSep">/</span> : null}
                            <button
                              className="crumbBtn"
                              onClick={() => { setFolderFilter(prefix); window.history.replaceState(null, "", `/?folder=${encodeURIComponent(prefix)}`); }}
                            >{seg}</button>
                          </span>
                        );
                      })}
                    </div>
                  </>
                ) : null}
                {homeView === "list" ? (<>
                {childFolders.map((f) => (
                  <div
                    key={f}
                    className={`folderRow ${folderDragOver === f ? "dragOver" : ""} ${selectedFolders.has(f) ? "selected" : ""}`}
                    onClick={(e) => handleFolderClick(f, e)}
                    onDoubleClick={() => { if (folderRenaming?.name !== f) openFolder(f); }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setHomeMenu({ kind: "folder", name: f, x: e.clientX, y: e.clientY });
                    }}
                    onDragOver={(e) => { e.preventDefault(); setFolderDragOver(f); }}
                    onDragLeave={() => setFolderDragOver(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setFolderDragOver(null);
                      const id = e.dataTransfer.getData("text/plain");
                      if (!id) return;
                      // A selected card drags its whole selection along
                      const ids = selectedPages.has(id) && selectedPages.size > 1 ? [...selectedPages] : [id];
                      addPagesToFolder(ids, f);
                    }}
                    title="Click to select · double-click to open · right-click to rename or delete · drop a paper to add it"
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
                          if (e.key === "Enter") renameFolder(f, folderRenaming.draft);
                          else if (e.key === "Escape") setFolderRenaming(null);
                        }}
                        onBlur={() => renameFolder(f, folderRenaming.draft)}
                      />
                    ) : (
                      <span className="folderName">{f.slice(f.lastIndexOf("/") + 1)}</span>
                    )}
                    <span className="folderCount">{folderCounts[f] || 0}</span>
                  </div>
                ))}
                {newFolderOpen ? (
                  <div className="folderRow folderNewRow">
                    <FolderPlusIcon size={15} />
                    <input
                      autoFocus
                      className="folderNewInput"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      placeholder="Folder name…"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitNewFolder(); }
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
                </>) : null}
              </div>
            ) : null}
            {homeMode && !categoryFilter ? (
              <div className="homeListBar">
                <span className="homeListLabel">{folderFilter ? "Files" : "All files"}</span>
                <span className="homeListSpacer" />
                <select className="homeSortSelect" value={homeSort} onChange={(e) => changeHomeSort(e.target.value)} title="Sort files">
                  <option value="updated">Recently modified</option>
                  <option value="created">Recently added</option>
                  <option value="title">Title A–Z</option>
                </select>
                <ViewToggle view={homeView} onChange={changeHomeView} />
              </div>
            ) : null}
            {homeMode && !categoryFilter && homeView === "grid" ? (
              (childFolders.length === 0 && homeVisiblePages.length === 0 && !newFolderOpen) ? (
                <div className="empty">{folderFilter ? "This folder is empty — drag papers onto it from the library." : "No pages yet — use the + button above to open a PDF or start a note page."}</div>
              ) : (
                <>
                  <div className="fileGrid" onClick={(e) => { if (e.target.classList.contains("fileGrid")) clearSelection(); }}>
                    {childFolders.map((f) => (
                      <div
                        key={f}
                        className={`folderTile ${folderDragOver === f ? "dragOver" : ""} ${selectedFolders.has(f) ? "selected" : ""}`}
                        onClick={(e) => handleFolderClick(f, e)}
                        onDoubleClick={() => { if (folderRenaming?.name !== f) openFolder(f); }}
                        onContextMenu={(e) => { e.preventDefault(); setHomeMenu({ kind: "folder", name: f, x: e.clientX, y: e.clientY }); }}
                        onDragOver={(e) => { e.preventDefault(); setFolderDragOver(f); }}
                        onDragLeave={() => setFolderDragOver(null)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setFolderDragOver(null);
                          const id = e.dataTransfer.getData("text/plain");
                          if (!id) return;
                          const ids = selectedPages.has(id) && selectedPages.size > 1 ? [...selectedPages] : [id];
                          addPagesToFolder(ids, f);
                        }}
                        title="Click to select · double-click to open · drop a paper to add it"
                      >
                        <FolderGlyph />
                        {folderRenaming?.name === f ? (
                          <input
                            autoFocus
                            className="tileRenameInput"
                            defaultValue={f.slice(f.lastIndexOf("/") + 1)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") renameFolder(f, e.currentTarget.value);
                              else if (e.key === "Escape") setFolderRenaming(null);
                            }}
                            onBlur={(e) => renameFolder(f, e.currentTarget.value)}
                          />
                        ) : (
                          <span className="tileName">{f.slice(f.lastIndexOf("/") + 1)}</span>
                        )}
                        <span className="tileFolderCount">{folderCounts[f] || 0}</span>
                      </div>
                    ))}
                    {homeVisiblePages.map((b) => {
                      const id = b._pageId;
                      const isPinned = !!b._pinned;
                      const isEditing = homeEditingId === id;
                      return (
                        <div
                          key={id}
                          className={`fileTile ${selectedPages.has(id) ? "selected" : ""}`}
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
                          <button
                            className={`pinBtn tilePinBtn ${isPinned ? "pinned" : ""}`}
                            title={isPinned ? "Unpin" : "Pin to top"}
                            onClick={(e) => { e.stopPropagation(); setPagesPinned([id], !isPinned); }}
                          ><PinIcon filled={isPinned} size={12} /></button>
                          <FileGlyph isPdf={!!b._sourceUrl} />
                          {isEditing ? (
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
                          ) : (
                            <span className="tileName">{b.content || "Untitled"}</span>
                          )}
                          <span className="tileKind">{b._sourceUrl ? "PDF" : "Note"}</span>
                        </div>
                      );
                    })}
                    {newFolderOpen ? (
                      <div className="folderTile folderTileNew">
                        <FolderGlyph />
                        <input
                          autoFocus
                          className="tileRenameInput"
                          value={newFolderName}
                          placeholder="Folder name…"
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setNewFolderName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); commitNewFolder(); }
                            else if (e.key === "Escape") { setNewFolderOpen(false); setNewFolderName(""); }
                          }}
                          onBlur={commitNewFolder}
                        />
                      </div>
                    ) : (
                      <button className="folderTile folderTileAdd" onClick={() => { setNewFolderName(""); setNewFolderOpen(true); }} title="New folder">
                        <FolderPlusIcon className="tileGlyph" size={null} strokeWidth={1.5} />
                        <span className="tileName">New folder</span>
                      </button>
                    )}
                  </div>
                  {homeSortedPages.length > homeVisiblePages.length ? (
                    <button ref={loadMoreRef} className="loadMoreBtn" onClick={() => setHomeShowCount((c) => c + HOME_PAGE_CHUNK)}>
                      Showing {homeVisiblePages.length} of {homeSortedPages.length} — load more
                    </button>
                  ) : null}
                </>
              )
            ) : homeMode && !categoryFilter && homeView === "list" ? (
              homeVisiblePages.length === 0 ? (
                <div className="empty">{folderFilter ? "This folder is empty — drag papers onto it from the library." : "No pages yet — use the + button above to open a PDF or start a note page."}</div>
              ) : (
                <>
                  <div className="fileList" onClick={(e) => { if (e.target.classList.contains("fileList")) clearSelection(); }}>
                    {homeVisiblePages.map((b) => {
                      const id = b._pageId;
                      const isPinned = !!b._pinned;
                      const isEditing = homeEditingId === id;
                      return (
                        <div
                          key={id}
                          className={`fileRow ${selectedPages.has(id) ? "selected" : ""}`}
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
                                if (e.key === "Enter") commitPageRename(id, e.currentTarget.value);
                                else if (e.key === "Escape") setHomeEditingId(null);
                              }}
                              onBlur={(e) => commitPageRename(id, e.currentTarget.value)}
                            />
                          ) : (
                            <span className="fileRowName">{b.content || "Untitled"}</span>
                          )}
                          {(b._folders?.length || b._labels?.length) ? (
                            <span className="fileRowLabels">
                              {b._folders?.map((f) => (
                                <span key={`f:${f}`} className="folderTagBadge" title={`In folder ${f}`}>
                                  <FolderIcon size={10} />
                                  {f}
                                </span>
                              ))}
                              {b._labels?.map((l) => (
                                <span
                                  key={`l:${l}`}
                                  className="labelTagBadge"
                                  title={`Label: ${l} — right-click to rename or delete`}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setHomeMenu({ kind: "label", name: l, x: e.clientX, y: e.clientY });
                                  }}
                                >
                                  <LabelIcon size={10} />
                                  {l}
                                </span>
                              ))}
                            </span>
                          ) : null}
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
                  {homeSortedPages.length > homeVisiblePages.length ? (
                    <button ref={loadMoreRef} className="loadMoreBtn" onClick={() => setHomeShowCount((c) => c + HOME_PAGE_CHUNK)}>
                      Showing {homeVisiblePages.length} of {homeSortedPages.length} — load more
                    </button>
                  ) : null}
                </>
              )
            ) : homeMode && categoryFilter ? null : (
            (homeMode ? homeVisiblePages : visibleBlocks).length === 0 ? (
              <div className="empty">{homeMode
                ? (folderFilter ? "This folder is empty — drag papers onto it from the library." : "No pages yet — use the + button above to open a PDF or start a note page.")
                : "No blocks yet."}</div>
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
                    setHomeMenu({ kind: "page", id, name: pageBlock.content, x: e.clientX, y: e.clientY });
                  },
                  selectedPageIds: selectedPages,
                  onChangeText: (id, text) => {
                    if (readOnly) return;
                    if (homeMode) {
                      setHomeBlocks((prev) => prev.map((b) => b.id === id ? { ...b, content: text } : b));
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
                        .then((created) => fetchHomeBlocks().then(() => {
                          pendingFocusRef.current = created.id;
                          setHomeEditingId(created.id);
                          setFocusedId(created.id);
                        }))
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
                    apiJson(`${API}/blocks/${id}`, { method: "DELETE" })
                      .catch((err) => setStatus(`Delete failed: ${err}`));
                    setBlocks(removeBlockTree(blocks, id));
                  },
                  onBlockDragOver: (e, block) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const wrap = e.currentTarget.closest(".sortableBlockWrap");
                    const r = wrap ? wrap.getBoundingClientRect() : e.currentTarget.getBoundingClientRect();
                    const px = e.clientX;
                    const py = e.clientY;
                    const above = (py - r.top) <= 16;
                    const td = parseInt((wrap || e.currentTarget).getAttribute("data-depth") || "0", 10);
                    const nested = (px - r.left) > 50;
                    const dt = { targetId: block.id, above, depth: nested ? td + 1 : td, rect: { top: r.top, left: r.left, width: r.width, bottom: r.bottom } };
                    _dragState.dropTarget = dt;
                    setDropTarget(dt);
                  },
                  onBlockDragLeave: () => {
                    setDropTarget(null);
                    _dragState.dropTarget = null;
                  },
                  onBlockDrop: (e, block) => {
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
                      }).then(() => fetchHomeBlocks()).catch((err) => setStatus(`Reorder failed: ${err}`));
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
                    } else { return; }
                    if (next) setBlocks(next);
                    _dragState.draggingId = null;
                  },
                };
                return (
                  <>
                    <BlockTree blocks={homeMode ? homeVisiblePages : blocks} readOnly={readOnly} rowProps={rowProps} />
                    {homeMode && homeSortedPages.length > homeVisiblePages.length ? (
                      <button
                        ref={loadMoreRef}
                        className="loadMoreBtn"
                        onClick={() => setHomeShowCount((c) => c + HOME_PAGE_CHUNK)}
                      >
                        Showing {homeVisiblePages.length} of {homeSortedPages.length} — load more
                      </button>
                    ) : null}
                    <BlockDropIndicator target={dropTarget} />
                  </>
                );
              })()
            ))}
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
      onGripDoubleClick: isPhone ? undefined : () => setCollapsedWins((prev) => ({ ...prev, [id]: !prev[id] })),
      collapsed: isPhone ? false : !!collapsedWins[id],
    };
    if (id === "notes") {
      return (
        <DockWindow title="Notes" {...common} onClose={() => (isPhone ? setPhonePanel(null) : setNotesVisible(false))}>
          {notesWindow}
        </DockWindow>
      );
    }
    if (id === "chat") {
      return (
        <ChatDock
          {...common}
          onClose={() => (isPhone ? setPhonePanel(null) : setChatHidden(true))}
          docId={docId} focusedBlockId={focusedBlockId} homeBlocks={homeBlocks} pdfTitle={pdfTitle}
          openTabs={openTabs}
          pdfSelections={pdfSelections} setPdfSelections={setPdfSelections}
          chatImages={chatImages} setChatImages={setChatImages}
          chatModel={chatSendModel} setChatModel={setChatModel}
          chatEffort={chatEffort} setChatEffort={setChatEffort}
          dictationModel={dictationModel} dictationLang={dictationLang}
          chatSystem={chatSystem} aiInfo={aiInfo} aiProvider={aiProvider}
          chatContextChars={chatContextChars} multiContextChars={multiContextChars}
          openAiKeysEditor={openAiKeysEditor}
          openPopover={openPopover} setOpenPopover={setOpenPopover}
          setStatus={setStatus}
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
    const bar = (w) => <div key={w} className="collapsedBar">{renderWindow(w)}</div>;
    const before = wins.filter((w, i) => collapsedWins[w] && (firstExpanded === -1 || i < firstExpanded));
    const after = wins.filter((w, i) => collapsedWins[w] && firstExpanded !== -1 && i > firstExpanded);
    return (
      <div className={`slotStack slotStack-${direction}`}>
        {before.map(bar)}
        {expanded.length ? (
          <div className="slotStackGroup">
            <PanelGroup direction={direction} autoSaveId={`gamma-slot-${side}`} ref={(h) => { panelGroupRefs.current[`slot-${side}`] = h; }}>
              {expanded.map((w, i) => (
                <React.Fragment key={w}>
                  {i > 0 ? <PanelResizeHandle className={`sash sash-${direction}`} /> : null}
                  <Panel id={w} order={i + 1} minSize={15}>{renderWindow(w)}</Panel>
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
              <span className="check">{!pdfHidden ? "✓" : ""}</span> PDF
            </button>
          ) : null}
          {!homeMode ? (
            <button className="popoverItem" onClick={() => setNotesVisible((v) => !v)}>
              <span className="check">{notesVisible ? "✓" : ""}</span> Notes
            </button>
          ) : null}
          {!menuReadOnly ? (
            <button className="popoverItem" onClick={() => setChatHidden((v) => !v)}>
              <span className="check">{!chatHidden ? "✓" : ""}</span> AI Chat
            </button>
          ) : null}
          {!menuReadOnly ? <div className="popoverDivider" /> : null}
          {!menuReadOnly && docId && focusedBlockId ? (
            <button
              className="popoverItem"
              title="Import highlights/notes saved inside the PDF file (SumatraPDF, Acrobat…)"
              onClick={() => { importEmbeddedAnnots(focusedBlockId, docId, false); setOpenPopover(null); }}
            >
              Import PDF annotations
            </button>
          ) : null}
          {!menuReadOnly ? (
            <label
              className="popoverItem importLogseqBtn"
              title="Import Logseq PDF highlights (.pdf + .edn)"
              style={{ cursor: loading ? "not-allowed" : "pointer" }}
            >
              Import Logseq…
              <input
                type="file"
                multiple
                accept=".pdf,.edn,.md"
                style={{ display: "none" }}
                disabled={loading}
                onChange={(e) => { importLogseq(e.target.files); e.target.value = ""; setOpenPopover(null); }}
              />
            </label>
          ) : null}
          {focusedBlock && !homeMode ? (
            <>
              <div className="popoverDivider" />
              <button
                className="popoverItem"
                onClick={() => { exportPage("readable"); setOpenPopover(null); }}
                title="Download this page as Markdown — nested notes, highlights as quotes, metadata front-matter. Bundles the PDF & images into a .zip when the page references them."
              >
                <FileTextIcon className="popoverItemIcon" size={15} />
                Export this page (.md)
              </button>
              <button
                className="popoverItem"
                onClick={() => { exportPage("logseq-graph"); setOpenPopover(null); }}
                title="Download a complete Logseq graph (.zip): notes page + native PDF highlights (hls page + .edn). Unzip and open the folder in file-based Logseq, or use the DB version's 'File to DB graph' import."
              >
                <FileTextIcon className="popoverItemIcon" size={15} />
                Export as Logseq graph (.zip)
              </button>
              {docId ? (
                <button
                  className="popoverItem"
                  onClick={() => { exportAnnotatedPdf(); setOpenPopover(null); }}
                  title="Download this paper's PDF with your highlights embedded as standard PDF annotations — notes appear as annotation popups in Acrobat, SumatraPDF, browsers, etc."
                >
                  <FileHighlightIcon className="popoverItemIcon" size={15} />
                  Export PDF with highlights
                </button>
              ) : null}
              {pdfUrl ? (
                <button
                  className="popoverItem"
                  onClick={() => { exportRawPdf(); setOpenPopover(null); }}
                  title="Download the PDF file as stored — no highlights or notes."
                >
                  <FileIcon className="popoverItemIcon" size={15} />
                  Export raw PDF
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </PopoverAnchor>
  );

  return (
    <div
      ref={appRef}
      className={`app layout-horizontal ${readOnly ? "readOnlyMode" : ""} ${pseudoFullscreen ? "pseudoFullscreen" : ""}`}
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
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        if (file.type === "application/pdf") {
          e.preventDefault();
          uploadPdf(file);
        }
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
                onContextMenu={(e) => { e.preventDefault(); setNavStack([]); }}
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
              onReorder={(dragged, target) => updateTabs((prev) => {
                const from = prev.findIndex((tab) => tab.id === dragged);
                const to = prev.findIndex((tab) => tab.id === target);
                if (from < 0 || to < 0 || from === to) return prev;
                // Dragging never crosses the pinned/unpinned boundary.
                if (!!prev[from].pinned !== !!prev[to].pinned) return prev;
                const next = [...prev];
                const [moved] = next.splice(from, 1);
                next.splice(to, 0, moved);
                return next;
              })}
              onOpen={(id) => openBlock(id, { restoreScroll: true })}
              onClose={closeTab}
              onContext={(tab, x, y) => setTabMenu({ id: tab.id, pinned: !!tab.pinned, x, y })}
            />
            <span data-popover="add" style={{ position: "relative", display: "inline-flex" }}>
              <button
                className={`iconBtn addBtn ${openPopover === "add" ? "activeIcon" : ""}`}
                onClick={() => setOpenPopover((p) => (p === "add" ? null : "add"))}
                title="Add — open a PDF by URL, upload a file, or start a note page"
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
                    placeholder="Open a PDF by URL — press Enter"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && addUrl.trim() && !loading) {
                        setOpenPopover(null);
                        openPdf(addUrl.trim());
                        setAddUrl("");
                      }
                    }}
                  />
                  <label className="popoverItem" style={{ cursor: loading ? "not-allowed" : "pointer" }}>
                    Upload PDF…
                    <input
                      type="file"
                      accept=".pdf"
                      style={{ display: "none" }}
                      disabled={loading}
                      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; setOpenPopover(null); if (f) uploadPdf(f); }}
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
                  {(transfers.some((t) => t.status === "active") || indexTask?.active) ? <span className="transferSpin" /> : null}
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
                              onClick={() => copyCitation("ppt", pptCite)}
                              title="Copy — pastes with real italics/bold into PowerPoint"
                              aria-label="Copy slide citation"
                            >
                              {citeCopied === "ppt"
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
                                onClick={() => copyCitation("bibtex", pageBibtex)}
                                title="Copy the BibTeX entry"
                                aria-label="Copy BibTeX"
                              >
                                {citeCopied === "bibtex"
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
                  onClick={() => setOpenPopover((p) => (p === "user" ? null : "user"))}
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
                    </div>
                    {authUser.is_guest ? (
                      <div className="popoverHint">Guest data resets daily. Ask the admin for an account to keep your work.</div>
                    ) : null}
                    <div className="popoverDivider" />
                    <button className="popoverItem" onClick={() => { setSettingsOpen("papers"); setOpenPopover(null); }}>
                      <SettingsIcon className="popoverItemIcon" size={15} />
                      Settings…
                    </button>
                    <button
                      className="popoverItem"
                      onClick={() => { setOpenPopover(null); exportUserData(true); }}
                      title="Download a zip backup: your notes databases + every uploaded PDF"
                    >
                      <ExportIcon className="popoverItemIcon" size={15} />
                      Export my data (.zip)
                    </button>
                    <button
                      className="popoverItem"
                      onClick={() => { setOpenPopover(null); exportUserData(false); }}
                      title="Download a small zip with just the databases (notes, chats, settings) — no uploaded PDFs"
                    >
                      <ExportIcon className="popoverItemIcon" size={15} />
                      Export database only (.zip)
                    </button>
                    {!authUser.is_guest ? (
                      <>
                        <button
                          className="popoverItem"
                          onClick={() => { setOpenPopover(null); importUserData("replace"); }}
                          title="Restore an exported zip: notes and settings are replaced by the backup, uploaded files are merged in"
                        >
                          <ImportIcon className="popoverItemIcon" size={15} />
                          Import data (.zip)…
                        </button>
                        <button
                          className="popoverItem"
                          onClick={() => { setOpenPopover(null); importUserData("merge"); }}
                          title="Add pages from an exported zip that are missing here; everything already in this account is kept unchanged"
                        >
                          <ImportIcon className="popoverItemIcon" size={15} />
                          Import &amp; merge (.zip)…
                        </button>
                      </>
                    ) : null}
                    {authUser.is_admin ? (
                      <button className="popoverItem" onClick={() => { openUsersManager(); setOpenPopover(null); }}>
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
          <button onClick={() => { setAttachModeBlockId(null); setAttachContextMenu(null); }}>Cancel</button>
        </div>
      )}
      {attachContextMenu && (
        <ContextMenu x={attachContextMenu.x} y={attachContextMenu.y} onClose={() => setAttachContextMenu(null)}>
          <button className="ctxMenuItem" onClick={() => linkHighlightToBlock(attachModeBlockId, attachContextMenu.highlight)}>
            Link highlight here
          </button>
        </ContextMenu>
      )}

      <div className="workArea">
      <PanelGroup direction="horizontal" autoSaveId="gamma-work-h" ref={(h) => { panelGroupRefs.current["work-h"] = h; }}>
      {slotWins("left").length ? (
        <>
          <Panel id="slot-left" order={1} defaultSize={26} minSize={15} className="dockSlot">
            {renderSlotGroup("left", "vertical")}
          </Panel>
          <PanelResizeHandle className="sash sash-horizontal" />
        </>
      ) : null}
      <Panel id="slot-center" order={2} minSize={30} className="dockSlot">
      <PanelGroup direction="vertical" autoSaveId="gamma-work-v" ref={(h) => { panelGroupRefs.current["work-v"] = h; }}>
      <Panel id="slot-main" order={1} minSize={20} className="dockSlot">
      <div className={`main ${(pdfHidden || homeMode || pageOnly) ? "pdfHidden" : ""}`}>
        {pillShown ? (
          <div
            className={"statusPill" + (pillShown.fading ? " fading" : "") + (pillShown.error ? " error" : "") + (pillShown.retry ? " interactive" : "")}
            role="status"
          >
            {pillShown.spinner ? <span className="pillSpin" aria-hidden="true" /> : null}
            <span className="pillText">{pillShown.msg}</span>
            {pillShown.retry ? (
              <button type="button" className="pillRetryBtn" onClick={() => pdfRetryRef.current?.()}>Retry</button>
            ) : null}
          </div>
        ) : null}
        <div className={`viewerWrap ${(pdfHidden || homeMode || pageOnly) ? "pdfHidden" : ""}`} ref={viewerWrapRef}>
          {pdfUrl && !pdfHidden ? (
            <button
              className="uiClose uiCloseLg pdfCloseBtn"
              onClick={() => setPdfHidden(true)}
              title="Close PDF"
              aria-label="Close PDF"
            >×</button>
          ) : null}
          {pdfUrl && !pdfHidden ? (
            <div className="pdfZoomOverlay">
              <button onClick={() => zoomStep(-1)} title="Zoom out" aria-label="Zoom out">
                <ZoomOutIcon size={15} />
              </button>
              <button onClick={() => zoomStep(1)} title="Zoom in" aria-label="Zoom in">
                <ZoomInIcon size={15} />
              </button>
              <button className="pdfFitWidthBtn" onClick={() => zoomTo("page-width")} title="Fit to width" aria-label="Fit to width">
                <FitWidthIcon size={15} />
              </button>
              {isPhone && !readOnly ? (
                <button
                  className={areaSelectMode ? "modeActive" : ""}
                  onClick={() => setAreaSelectMode((v) => !v)}
                  title={areaSelectMode ? "Rectangle mode — drag draws an area note (tap to switch to text selection)" : "Text mode — drag selects text (tap to switch to rectangle drawing)"}
                  aria-label="Toggle selection mode"
                >
                  {areaSelectMode ? <RectSelectIcon size={15} /> : <TextCursorIcon size={15} />}
                </button>
              ) : null}
            </div>
          ) : null}
          {pdfUrl && !pdfHidden ? (
            <button
              className="pdfFullscreenBtn"
              onClick={toggleFullscreen}
              title={isFullscreen || pseudoFullscreen ? "Exit full screen" : "Full screen"}
              aria-label={isFullscreen || pseudoFullscreen ? "Exit full screen" : "Full screen"}
            >
              {isFullscreen || pseudoFullscreen ? (
                <MinimizeIcon size={15} />
              ) : (
                <MaximizeIcon size={15} />
              )}
            </button>
          ) : null}
          {pdfUrl ? (
            <PdfViewer url={pdfUrl} highlights={highlights}
              noteBadges={hlNoteBadges}
              hideEmbeddedAnnots={embAnnots === "hide"}
              areaMode={areaSelectMode && isPhone && !readOnly}
              pdfScaleValue={pdfScale} scrollRef={scrollToRef}
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
                  if (h.linkTarget.highlightId) pendingJumpRef.current = h.linkTarget.highlightId;
                  openBlock(h.linkTarget.pageId, { pushNav: true });
                } else if (h.linkTarget?.url) handleDocLink(h.linkTarget.url);
              }}
              onJump={jumpToHighlightId}
              onHighlightJump={(hlId, additive) => {
                const b = flattenBlocks(blocks).find(b => b.properties?.highlight_id === hlId);
                if (b) { pendingBlockScrollRef.current = b.id; setBlocks(prev => expandToBlock(prev, b.id)); }
                // Clicking a highlight also feeds the chat: quote as the
                // selection (Ctrl+click appends), area rects as an image.
                addHighlightToChat(highlights.find(h => h.id === hlId), additive);
              }}
              onHighlightContext={setHighlightMenu}
              onAreaSelection={addChatImage}
              onSelectionFinished={readOnly ? undefined : (position, content, hideTip, extras) => {
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
              }}
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
          <Panel id="slot-bottom" order={2} defaultSize={32} minSize={12} className="dockSlot">
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
      {isPhone && phonePanel === "notes" && winVisible.notes ? (
        <div className="phonePanel">{renderWindow("notes")}</div>
      ) : null}
      {isPhone && phonePanel === "chat" && !readOnly ? (
        <div className="phonePanel">{renderWindow("chat")}</div>
      ) : null}
      </div>
      {isPhone && (!centerNotes || !readOnly) ? (
        <div className="phoneTabBar">
          <button
            className={`phoneTab ${phonePanel === null || (phonePanel === "notes" && centerNotes) ? "active" : ""}`}
            onClick={() => setPhonePanel(null)}
          >
            {homeMode ? <HomeIcon size={16} /> : centerNotes ? <FileTextIcon size={16} /> : <FileIcon size={16} />}
            <span>{homeMode ? "Library" : centerNotes ? "Notes" : "PDF"}</span>
          </button>
          {!centerNotes ? (
            <button
              className={`phoneTab ${phonePanel === "notes" ? "active" : ""}`}
              onClick={() => { setNotesVisible(true); setPhonePanel((p) => (p === "notes" ? null : "notes")); }}
            >
              <FileTextIcon size={16} />
              <span>Notes</span>
            </button>
          ) : null}
          {!readOnly ? (
            <button
              className={`phoneTab ${phonePanel === "chat" ? "active" : ""}`}
              onClick={() => setPhonePanel((p) => (p === "chat" ? null : "chat"))}
            >
              <SparklesIcon size={16} />
              <span>Chat</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {dockPreview ? (
        <div className="dockPreview" style={dockPreview} />
      ) : null}
      {confirmBox ? (
        // data-popover keeps an open popover (e.g. search) alive while the dialog is up
        <div className="reportOverlay" data-popover="confirm" onClick={() => setConfirmBox(null)}>
          <div className="reportModal confirmModal" onClick={(e) => e.stopPropagation()}>
            <div className="reportModalTitle">{confirmBox.title}</div>
            <div className="reportModalHint confirmMessage">{confirmBox.message}</div>
            <div className="reportModalBtns">
              <button className="chatClearBtn" onClick={() => setConfirmBox(null)} autoFocus>Cancel</button>
              <button
                className={`uiBtn primary ${confirmBox.danger ? "dangerBtn" : ""}`}
                onClick={() => { const fn = confirmBox.onConfirm; setConfirmBox(null); fn?.(); }}
              >{confirmBox.confirmLabel || "OK"}</button>
            </div>
          </div>
        </div>
      ) : null}
      {labelRenaming ? (
        <div className="reportOverlay" onClick={() => setLabelRenaming(null)}>
          <div className="reportModal confirmModal" onClick={(e) => e.stopPropagation()}>
            <div className="reportModalTitle">Rename label</div>
            <div className="reportModalHint confirmMessage">Renames “{labelRenaming.name}” on every page that carries it.</div>
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
              >Rename</button>
            </div>
          </div>
        </div>
      ) : null}
      {linkPrompt ? (
        <div className="reportOverlay" onClick={() => setLinkPrompt(null)}>
          <div className="reportModal confirmModal" onClick={(e) => e.stopPropagation()}>
            <div className="reportModalTitle">External link</div>
            <div className="reportModalHint confirmMessage linkPromptUrl">{linkPrompt}</div>
            <div className="reportModalBtns">
              <button className="chatClearBtn" onClick={() => setLinkPrompt(null)}>Cancel</button>
              {(() => {
                // Right-click always lands here, even for links whose paper is
                // already in the library — offer that copy instead of a re-fetch.
                const pid = findPageForUrl(linkPrompt, homeBlocks);
                return pid ? (
                  <button
                    className="chatClearBtn"
                    onClick={() => { setLinkPrompt(null); openBlock(pid, { pushNav: true }); }}
                    title="This paper is already in your library"
                  >Open in Gamma</button>
                ) : (
                  <button
                    className="chatClearBtn"
                    onClick={() => { const url = linkPrompt; setLinkPrompt(null); pushNav(); openPdf(url); }}
                    title="Resolve this link as a PDF and open it as a new paper in Gamma"
                  >Fetch into Gamma</button>
                );
              })()}
              <button
                className="uiBtn primary"
                onClick={() => { window.open(linkPrompt, "_blank", "noopener"); setLinkPrompt(null); }}
              >Open in browser</button>
            </div>
          </div>
        </div>
      ) : null}
      {linkDialog ? (
        <div className="reportOverlay" onClick={() => setLinkDialog(null)}>
          <div className="reportModal confirmModal" onClick={(e) => e.stopPropagation()}>
            <div className="reportModalTitle">{linkDialog.editBlockId ? "Change reference link" : "Link reference to a paper"}</div>
            {linkDialog.content?.text ? (
              <div className="reportModalHint linkRefQuote">“{linkDialog.content.text.slice(0, 160)}{linkDialog.content.text.length > 160 ? "…" : ""}”</div>
            ) : null}
            <div className="reportModalHint">Paste a DOI, arXiv id, or URL — or pick one of your papers. The selection becomes a clickable link on the PDF.</div>
            <div className="shareRow">
              <input
                autoFocus
                placeholder="10.1103/…  ·  1810.11086  ·  https://…"
                value={linkDialogInput}
                onChange={(e) => setLinkDialogInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && linkDialogInput.trim()) {
                    e.preventDefault();
                    createLinkHighlight({ url: normalizeLinkInput(linkDialogInput) });
                  } else if (e.key === "Escape") { setLinkDialog(null); }
                }}
              />
              <button
                className="uiBtn primary"
                disabled={!linkDialogInput.trim()}
                onClick={() => createLinkHighlight({ url: normalizeLinkInput(linkDialogInput) })}
              >Link</button>
            </div>
            {refPoint && refPoint.pageId !== focusedBlockId ? (
              <>
                <div className="popoverSection">Copied reference point</div>
                <button
                  className="reportPageItem linkPageItem"
                  onClick={() => createLinkHighlight({ pageId: refPoint.pageId, highlightId: refPoint.highlightId })}
                  title="Link to this exact highlight — clicking the link opens the paper and jumps to it"
                >
                  <span className="reportPageName">{refPoint.pageTitle} — “{refPoint.quote.slice(0, 60)}{refPoint.quote.length > 60 ? "…" : ""}”</span>
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
                  .sort((x, y) => y.score - x.score
                    || (y.b.updated_at || "").localeCompare(x.b.updated_at || ""));
                if (!cands.length) return <div className="popoverHint">No other PDFs in your library yet.</div>;
                return cands.map(({ b, score }) => (
                  <button key={b.id} className="reportPageItem linkPageItem" onClick={() => createLinkHighlight({ pageId: b.id })}>
                    <span className="reportPageName">{b.content || "Untitled"}</span>
                    {score >= 6 ? <span className="linkLikelyBadge">likely</span> : null}
                  </button>
                ));
              })()}
            </div>
            <div className="reportModalBtns">
              {linkDialog.editBlockId ? (
                <button className="chatClearBtn" onClick={() => createLinkHighlight({})} title="Turn this back into a plain highlight">Remove link</button>
              ) : null}
              <button className="chatClearBtn" onClick={() => setLinkDialog(null)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
      <SettingsDialog
        activePane={settingsOpen}
        onPaneChange={setSettingsOpen}
        onClose={() => setSettingsOpen(null)}
        papers={{
          oaFallback,
          setOaFallback,
          metaAutoFetch,
          setMetaAutoFetch,
          pdfSaveLocal,
          setPdfSaveLocal,
          hlNoteBadges,
          setHlNoteBadges,
          embAnnots,
          setEmbAnnots,
          metaModel,
          setMetaModel,
          aiModels: scopedAiModels,
        }}
        library={{
          // batch metadata retry uses the same prompt/model/context prefs as
          // the per-paper fetch in the metadata popover
          metaPrompt,
          metaFetchModel,
          metaContextChars,
          setStatus,
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
          savePrompts: () => {
            const normalizePrompt = (draft, defaultValue) => {
              const value = (draft || "").trim();
              return value === (defaultValue || "").trim() ? "" : value;
            };
            setChatSystem(normalizePrompt(promptDraft, aiInfo?.default_prompt));
            setMetaPrompt(normalizePrompt(metaPromptDraft, aiInfo?.metadata_prompt));
            setCitePrompt(normalizePrompt(citePromptDraft, aiInfo?.cite_prompt));
            setStatus("Prompts saved.");
          },
        }}
        context={{
          chatImgAutoClear,
          setChatImgAutoClear,
          dictationModel,
          setDictationModel,
          dictationLang,
          setDictationLang,
          chatContextChars,
          setChatContextChars,
          metaContextChars,
          setMetaContextChars,
          multiContextChars,
          setMultiContextChars,
          reset: () => {
            setChatContextChars(8000);
            setMetaContextChars(6000);
            setMultiContextChars(18000);
            setStatus("AI context limits reset.");
          },
        }}
        search={{ searchDetailsHome, setSearchDetailsHome, searchDetailsPaper, setSearchDetailsPaper, indexTask, setStatus }}
        diagnostics={{ statusBarVisible, setStatusBarVisible, sysLog, setStatus, isAdmin: !!authUser?.is_admin, debugLog, setDebugLog }}
      />
      {usersOpen ? (
        <div className="reportOverlay" onClick={() => setUsersOpen(false)}>
          <div className="reportModal promptModal" onClick={(e) => e.stopPropagation()}>
            <div className="reportModalTitle">Users</div>
            <div className="reportModalHint">
              Admin is a privilege, not a name — any account can be granted it. Admins can create
              and delete accounts, reset passwords, and grant or revoke the privilege. The last
              admin can never be demoted or deleted.
            </div>
            {!usersInfo && !usersError ? <div className="reportModalHint">Loading…</div> : null}
            {usersInfo ? (
              <>
                {usersInfo.users.map((u) => {
                  // Mirrors the backend rail (admin.py counts non-guest admins):
                  // the last admin can't be demoted, so don't offer the button.
                  const lastAdmin = u.is_admin &&
                    usersInfo.users.filter((x) => x.is_admin && !x.is_guest).length <= 1;
                  return (
                  <div key={u.username} className="aiProvRow">
                    <span className="aiProvMeta">
                      <span className="aiProvName">
                        {u.username}
                        {u.username === usersInfo.me ? <span className="uiTag">you</span> : null}
                        {u.is_admin ? <span className="uiTag admin">admin</span> : null}
                        {u.is_guest ? <span className="uiTag">guest</span> : null}
                      </span>
                      <span className="aiProvDesc">
                        {u.is_guest ? "shared demo workspace, resets daily" : `created ${new Date(u.created_at).toLocaleDateString()}`}
                      </span>
                      {userPwEdit?.username === u.username ? (
                        <span className="aiProvPwForm">
                          <input
                            className="aiKeyInput" type="password" autoComplete="new-password" autoFocus
                            placeholder="New password"
                            value={userPwEdit.password}
                            onChange={(e) => setUserPwEdit((f) => ({ ...f, password: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") submitUserPassword(); }}
                          />
                          <button className="uiBtn sm" onClick={() => setUserPwEdit(null)}>Cancel</button>
                          <button className="uiBtn sm primary" disabled={usersBusy} onClick={submitUserPassword}>Set</button>
                        </span>
                      ) : null}
                      {userRenameEdit?.username === u.username ? (
                        <span className="aiProvPwForm">
                          <input
                            className="aiKeyInput" type="text" spellCheck={false} autoFocus
                            placeholder="New username"
                            value={userRenameEdit.value}
                            onChange={(e) => setUserRenameEdit((f) => ({ ...f, value: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") submitUserRename(); }}
                          />
                          <button className="uiBtn sm" onClick={() => setUserRenameEdit(null)}>Cancel</button>
                          <button className="uiBtn sm primary" disabled={usersBusy} onClick={submitUserRename}>Rename</button>
                        </span>
                      ) : null}
                    </span>
                    {!u.is_guest ? (
                      <span className="aiProvActions">
                        <button className="uiBtn sm uMgrBtn" disabled={usersBusy}
                          title="Rename the account — sessions and share links keep working"
                          onClick={() => { setUsersError(""); setUserPwEdit(null); setUserRenameEdit({ username: u.username, value: u.username }); }}>
                          Rename…
                        </button>
                        <button className="uiBtn sm uMgrBtn" disabled={usersBusy}
                          onClick={() => { setUsersError(""); setUserRenameEdit(null); setUserPwEdit({ username: u.username, password: "" }); }}>
                          Password…
                        </button>
                        <button className="uiBtn sm uMgrBtnWide" disabled={usersBusy || lastAdmin}
                          title={lastAdmin ? "The last admin can't be demoted"
                            : u.is_admin ? "Revoke the admin privilege" : "Grant the admin privilege"}
                          onClick={() => usersCall(`/users/${encodeURIComponent(u.username)}`, "PUT", { is_admin: !u.is_admin })}>
                          {u.is_admin ? "Revoke admin" : "Make admin"}
                        </button>
                        {u.username !== usersInfo.me ? (
                          <button className="uiBtn sm iconSq danger" disabled={usersBusy}
                            title="Delete this account and all its data"
                            aria-label={`Delete ${u.username}`}
                            onClick={() => deleteUserAccount(u)}>
                            <Trash2Icon size={13} />
                          </button>
                        ) : (
                          <span className="iconSqSlot" aria-hidden="true" />
                        )}
                      </span>
                    ) : null}
                  </div>
                  );
                })}
                {usersForm ? (
                  <div className="aiProvForm">
                    <div className="promptSectionHead"><span>Add user</span></div>
                    <input
                      className="aiKeyInput" type="text" spellCheck={false} autoFocus
                      placeholder="Username (letters, digits, _ . -)"
                      value={usersForm.username}
                      onChange={(e) => setUsersForm((f) => ({ ...f, username: e.target.value }))}
                    />
                    <input
                      className="aiKeyInput" type="password" autoComplete="new-password"
                      placeholder="Password"
                      value={usersForm.password}
                      onChange={(e) => setUsersForm((f) => ({ ...f, password: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") submitNewUser(); }}
                    />
                    <label className="uiCheckRow">
                      <input type="checkbox" checked={!!usersForm.is_admin}
                        onChange={(e) => setUsersForm((f) => ({ ...f, is_admin: e.target.checked }))} />
                      Grant the admin privilege
                    </label>
                    <div className="reportModalBtns">
                      <button className="uiBtn" onClick={() => { setUsersForm(null); setUsersError(""); }}>Cancel</button>
                      <button className="uiBtn primary" disabled={usersBusy} onClick={submitNewUser}>
                        {usersBusy ? "Creating…" : "Create user"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="reportModalBtns">
                    <button className="uiBtn" onClick={() => setUsersOpen(false)}>Close</button>
                    <button className="uiBtn primary" onClick={() => { setUsersError(""); setUserPwEdit(null); setUsersForm({ username: "", password: "", is_admin: false }); }}>
                      + Add user
                    </button>
                  </div>
                )}
              </>
            ) : null}
            {usersError ? <div className="reportModalHint aiKeysError">{usersError}</div> : null}
          </div>
        </div>
      ) : null}
      {tabMenu ? (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} onClose={() => setTabMenu(null)}>
          <button className="ctxMenuItem ctxMenuItemIconed" onClick={() => { setTabMenu(null); toggleTabPinned(tabMenu.id); }}>
            <span className="ctxMenuIcon"><PinIcon filled={!tabMenu.pinned} size={13} /></span>
            {tabMenu.pinned ? "Unpin tab" : "Pin tab"}
          </button>
          <button className="ctxMenuItem ctxMenuItemIconed" onClick={() => { setTabMenu(null); closeTab(tabMenu.id); }}>
            <span className="ctxMenuIcon"><XIcon size={13} /></span>
            Close tab
          </button>
        </ContextMenu>
      ) : null}
      {homeMenu ? (
        <ContextMenu x={homeMenu.x} y={homeMenu.y} onClose={() => setHomeMenu(null)}>
            {homeMenu.kind === "page" ? (() => {
              // Acting on a selected card acts on the whole selection
              const ids = selectedPages.size > 1 && selectedPages.has(homeMenu.id) ? [...selectedPages] : [homeMenu.id];
              const many = ids.length > 1;
              return (
                <>
                  {!many ? (
                    <button className="ctxMenuItem" onClick={() => { setHomeMenu(null); clearSelection(); openBlock(homeMenu.id, { restoreScroll: true }); }}>Open</button>
                  ) : null}
                  {!many ? (
                    <button className="ctxMenuItem" onClick={() => { setHomeMenu(null); clearSelection(); setHomeEditingId(homeMenu.id); }}>Rename</button>
                  ) : null}
                  {ids.every((id) => pageBlocks.find((b) => b._pageId === id)?._pinned) ? (
                    <button className="ctxMenuItem" onClick={() => { setHomeMenu(null); setPagesPinned(ids, false); }}>{many ? "Unpin" : "Unpin"}</button>
                  ) : (
                    <button className="ctxMenuItem" onClick={() => { setHomeMenu(null); setPagesPinned(ids, true); }}>{many ? `Pin ${ids.length} pages` : "Pin"}</button>
                  )}
                  <button className="ctxMenuItem" onClick={() => { setHomeMenu(null); duplicatePages(ids); }}>{many ? `Duplicate ${ids.length} pages` : "Duplicate"}</button>
                  <button className="ctxMenuItem" onClick={() => { setHomeMenu(null); deletePages(ids); }}>{many ? `Delete ${ids.length} pages` : "Delete"}</button>
                  <div className="ctxMenuLabel">Add to folder</div>
                  {allFolderPaths.map((f) => (
                    <button key={f} className="ctxMenuItem" onClick={() => { setHomeMenu(null); addPagesToFolder(ids, f); }}>{f}</button>
                  ))}
                  {folderFilter ? (
                    <button className="ctxMenuItem" onClick={() => { setHomeMenu(null); removePagesFromFolder(ids, folderFilter); }}>Remove from “{folderFilter}”</button>
                  ) : null}
                  <button className="ctxMenuItem" onClick={() => { setHomeMenu(null); removePagesFromFolder(ids, ""); }}>Clear folder tags</button>
                </>
              );
            })() : homeMenu.kind === "label" ? (
              <>
                <button className="ctxMenuItem" onClick={() => { const name = homeMenu.name; setHomeMenu(null); if (!homeMode) goHome(); setCategoryFilter(name); window.history.replaceState(null, "", `/?category=${encodeURIComponent(name)}`); }}>Open</button>
                <button className="ctxMenuItem" onClick={() => { setHomeMenu(null); setLabelRenaming({ name: homeMenu.name, draft: homeMenu.name }); }}>Rename</button>
                <button className="ctxMenuItem" onClick={() => { setHomeMenu(null); deleteLabelByName(homeMenu.name); }}>Delete</button>
              </>
            ) : (
              <>
                <button className="ctxMenuItem" onClick={() => { setHomeMenu(null); setFolderFilter(homeMenu.name); window.history.replaceState(null, "", `/?folder=${encodeURIComponent(homeMenu.name)}`); }}>Open</button>
                <button className="ctxMenuItem" onClick={() => { setHomeMenu(null); setFolderRenaming({ name: homeMenu.name, draft: homeMenu.name }); }}>Rename</button>
                <button className="ctxMenuItem" onClick={() => { setHomeMenu(null); deleteFolderByName(homeMenu.name); }}>Delete</button>
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
                const blk = flattenBlocks(blocks).find((b) => b.properties?.highlight_id === highlightMenu.id);
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
              {highlights.find((x) => x.id === highlightMenu.id)?.linkTarget ? "Change link…" : "Link to paper…"}
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
                const blk = flattenBlocks(blocks).find((b) => b.properties?.highlight_id === highlightMenu.id);
                setRefPoint({
                  pageId: focusedBlockId,
                  pageTitle: pdfTitle || "Untitled",
                  highlightId: highlightMenu.id,
                  quote: (h?.content?.text || "").slice(0, 200),
                });
                // Also a paste-able deep link: opening it jumps straight to
                // this highlight (in the browser, chat notes, anywhere).
                if (blk) {
                  navigator.clipboard?.writeText(`${window.location.origin}/?block=${encodeURIComponent(blk.id)}`).catch(() => {});
                }
                setHighlightMenu(null);
                setStatus("Reference point copied — paste the link, or pick it in another paper's link dialog.");
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
