import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import PdfViewer, { COLORS } from "./pdfViewer";
import { API, apiJson, makeId, fmtBytes, getDocIdForUrl, resolvePdfUrl } from "./utils";
import { DockWindow, ChatMarkdown, PinIcon } from "./widgets";
import { BlockTree, _dragState } from "./blockTree";
import { ViewToggle, FolderGlyph, FileGlyph } from "./fileBrowser";
import ChatDock from "./chatDock";
import SearchPanel from "./search";
import { ContextMenu } from "./menus";


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

  async function doLogout() {
    // Close the workspace while the session is still valid (flushes pending
    // edits, clears the ?block= URL and the cached session) so nothing of this
    // account's view leaks into whoever logs in next.
    goHome();
    await fetch(`${API}/logout`, { method: "POST", credentials: "include" });
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
  const [homeSort, setHomeSort] = useState(() => {
    try { return localStorage.getItem("gamma-home-sort") || "updated"; } catch { return "updated"; }
  });
  function changeHomeSort(v) {
    setHomeSort(v);
    try { localStorage.setItem("gamma-home-sort", v); } catch {}
  }
  // Home layout: "list" (block-style rows) or "grid" (icon tiles).
  const [homeView, setHomeView] = useState(() => {
    try { return localStorage.getItem("gamma-home-view") || "list"; } catch { return "list"; }
  });
  function changeHomeView(v) {
    setHomeView(v);
    try { localStorage.setItem("gamma-home-view", v); } catch {}
  }
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
        goHome();
        setNavStack([]);
      }
      prefsUserRef.current = "";
      setOpenTabs([]);
      setExtraFolders([]);
      setRecentViews([]);
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
    // …then the server copy, which wins (tabs sync across browsers). An
    // account that has never synced seeds the server with this browser's tabs.
    apiJson(`${API}/prefs/open-tabs`).then((d) => {
      if (prefsUserRef.current !== u) return;
      if (d.updated_at) applyServerTabs(u, d.value, d.updated_at);
      else if (Array.isArray(localTabs) && localTabs.length) pushTabsToServer(localTabs);
    }).catch(() => {});
  }, [authUser?.user, readOnly]);

  // Folder-tag helpers: parse/serialize the comma-separated path list.
  const parseFolderTags = (raw) => (raw || "").split(",").map((s) => s.trim()).filter(Boolean);
  // "/" nests and "," separates tags, so neither may appear in a segment name.
  const cleanFolderSegment = (name) => (name || "").replace(/[,/]/g, " ").replace(/\s+/g, " ").trim();
  async function writePageFolders(pageId, tags) {
    await apiJson(`${API}/blocks/${pageId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { folder: tags.join(", ") } }),
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
  const [movePicker, setMovePicker] = useState(false);

  function clearSelection() { setSelectedPages(new Set()); setSelectedFolders(new Set()); setMovePicker(false); }

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
    setMovePicker(false);
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
    setMovePicker(false);
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
  const [pdfPageNumber, setPdfPageNumber] = useState(() => loadSession().pdfPageNumber || 1);
  const [pdfEffScale, setPdfEffScale] = useState(1); // actual render scale (incl. fit-width)
  const [zoomDraft, setZoomDraft] = useState(null);  // while typing a custom zoom %
  const restoredPdfUrlRef = useRef(null);
  const [blocks, setBlocks] = useState([]);
  const [homeBlocks, setHomeBlocks] = useState([]);
  const [refCache, setRefCache] = useState({}); // { [blockId]: { content, page_title } }
  const [backlinks, setBacklinks] = useState([]);
  const [chatHidden, setChatHidden] = useState(false);
  const [homeEditingId, setHomeEditingId] = useState(null);
  const [status, setStatus] = useState("Ready.");
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
      let tabs = Array.isArray(value) ? value : [];
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
  function updateTabs(updater) {
    setOpenTabs((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      const u = prefsUserRef.current;
      if (u) {
        try { localStorage.setItem(`gamma-tabs:${u}`, JSON.stringify(next)); } catch {}
        pushTabsToServer(next);
      }
      return next;
    });
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
    window.addEventListener("focus", pullTabs);
    document.addEventListener("visibilitychange", pullTabs);
    return () => {
      window.removeEventListener("focus", pullTabs);
      document.removeEventListener("visibilitychange", pullTabs);
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
  const dragTabRef = useRef(null); // tab id being drag-reordered
  const [draggingTabId, setDraggingTabId] = useState(null);
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
    if (st.phase === "rendered") {
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
        }
      }
      return;
    }
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
    } else {
      const id = transferByUrlRef.current[url];
      if (!id) return;
      if (st.phase === "cancelled") {
        delete transferByUrlRef.current[url];
        setTransfers((prev) => prev.filter((t) => t.id !== id)); // aborted navigation — drop the entry
      } else {
        updateTransfer(id, st.phase === "done"
          ? { status: "done", info: fmtBytes(st.bytes) }
          : { status: "error", info: "failed" });
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
  const [shareCopied, setShareCopied] = useState(false);
  // Workspace search lives in search.jsx (SearchPanel); App only holds what
  // the PDF viewer needs from it: the match highlights and the search hook.
  const [findMarks, setFindMarks] = useState([]); // [{page, rect, active}] painted by PdfViewer
  const [pdfDocNonce, setPdfDocNonce] = useState(0); // bumped when a document finishes rendering
  const pdfSearchRef = useRef(null); // set by PdfViewer: async (RegExp) => [{page, snippet, rects, pageW, pageH}]

  // Poll server-side task progress: slow heartbeat while logged in (so the
  // button appears even if the work was kicked off elsewhere), fast while
  // the popover is open or indexing is known to run.
  useEffect(() => {
    if (!authUser?.user || readOnly) return;
    let cancelled = false;
    const refresh = () => apiJson(`${API}/tasks`)
      .then((d) => { if (!cancelled) setIndexTask(d.indexing || null); })
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
  const [pdfSaveLocal, setPdfSaveLocal] = useState(() => {
    try { return localStorage.getItem("gamma-pdf-save") !== "0"; } catch { return true; }
  });
  // User preferences (Settings in the account popover)
  const [oaFallback, setOaFallback] = useState(() => {
    try { return localStorage.getItem("gamma-oa-fallback") !== "0"; } catch { return true; }
  });
  const [metaAutoFetch, setMetaAutoFetch] = useState(() => {
    try { return localStorage.getItem("gamma-meta-auto") !== "0"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("gamma-pdf-save", pdfSaveLocal ? "1" : "0"); } catch {}
  }, [pdfSaveLocal]);
  useEffect(() => {
    try { localStorage.setItem("gamma-oa-fallback", oaFallback ? "1" : "0"); } catch {}
  }, [oaFallback]);
  useEffect(() => {
    try { localStorage.setItem("gamma-meta-auto", metaAutoFetch ? "1" : "0"); } catch {}
  }, [metaAutoFetch]);
  const pageTitleSaveTimerRef = useRef(null);
  const viewerWrapRef = useRef(null);
  const appRef = useRef(null);

  // --- AI chat: model switcher, PDF attachment, selection focus, report ---
  const [aiInfo, setAiInfo] = useState(null); // {enabled, provider, models, default}
  const [chatModel, setChatModel] = useState(() => {
    try { return localStorage.getItem("gamma-chat-model") || ""; } catch { return ""; }
  });
  const [chatEffort, setChatEffort] = useState(() => {
    try { return localStorage.getItem("gamma-chat-effort") || ""; } catch { return ""; }
  });
  const [chatSystem, setChatSystem] = useState(() => {
    try { return localStorage.getItem("gamma-chat-system") || ""; } catch { return ""; }
  });
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  // AI providers (Settings → AI providers): a user-managed list of API keys,
  // OpenAI-platform style. Keys are stored server-side per user; the server
  // only ever returns a masked hint, so key fields here start empty and an
  // empty key on edit means "keep the stored one".
  const [aiKeysOpen, setAiKeysOpen] = useState(false);
  const [aiKeysInfo, setAiKeysInfo] = useState(null); // masked GET /ai/settings: {providers: [], protocols: []}
  const [aiKeysForm, setAiKeysForm] = useState(null); // null | {id: ""=add, protocol, name, api_key, base_url, models}
  const [aiKeysBusy, setAiKeysBusy] = useState(false);
  const [aiKeysError, setAiKeysError] = useState("");

  async function openAiKeysEditor() {
    setAiKeysError("");
    setAiKeysInfo(null);
    setAiKeysForm(null);
    setAiKeysOpen(true);
    try {
      setAiKeysInfo(await apiJson(`${API}/ai/settings`));
    } catch (err) {
      setAiKeysError(err.message);
    }
  }

  const aiProtocolOf = (id) => aiKeysInfo?.protocols?.find((p) => p.id === id);

  function startAddAiProvider() {
    setAiKeysError("");
    setAiKeysForm({ id: "", protocol: aiKeysInfo?.protocols?.[0]?.id || "anthropic", name: "", api_key: "", base_url: "", models: "" });
  }

  function startEditAiProvider(p) {
    setAiKeysError("");
    setAiKeysForm({ id: p.id, protocol: p.protocol, name: p.name || "", api_key: "", base_url: p.base_url || "", models: p.models || "" });
  }

  async function submitAiProvider() {
    const f = aiKeysForm;
    if (!f) return;
    if (!f.id && !f.api_key.trim()) { setAiKeysError("An API key is required."); return; }
    setAiKeysBusy(true);
    setAiKeysError("");
    try {
      const body = { protocol: f.protocol, name: f.name.trim(), base_url: f.base_url.trim(), models: f.models.trim() };
      if (f.api_key.trim()) body.api_key = f.api_key.trim();
      const d = await apiJson(`${API}/ai/providers${f.id ? `/${f.id}` : ""}`, {
        method: f.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setAiKeysInfo(d);
      setAiKeysForm(null);
      // The model switchers everywhere feed off /ai/models — refresh them.
      apiJson(`${API}/ai/models`).then(setAiInfo).catch(() => {});
    } catch (err) {
      setAiKeysError(err.message);
    } finally {
      setAiKeysBusy(false);
    }
  }

  async function deleteAiProvider(id) {
    setAiKeysBusy(true);
    setAiKeysError("");
    try {
      const d = await apiJson(`${API}/ai/providers/${id}`, { method: "DELETE" });
      setAiKeysInfo(d);
      apiJson(`${API}/ai/models`).then(setAiInfo).catch(() => {});
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
  const [citeCopied, setCiteCopied] = useState(""); // "bibtex" | "ppt"
  // Editable prompts for metadata extraction and PPT citations (empty = server default)
  const [metaPrompt, setMetaPrompt] = useState(() => {
    try { return localStorage.getItem("gamma-meta-prompt") || ""; } catch { return ""; }
  });
  const [citePrompt, setCitePrompt] = useState(() => {
    try { return localStorage.getItem("gamma-cite-prompt") || ""; } catch { return ""; }
  });
  const [metaPromptDraft, setMetaPromptDraft] = useState("");
  const [citePromptDraft, setCitePromptDraft] = useState("");
  useEffect(() => {
    try { localStorage.setItem("gamma-meta-prompt", metaPrompt); } catch {}
  }, [metaPrompt]);
  useEffect(() => {
    try { localStorage.setItem("gamma-cite-prompt", citePrompt); } catch {}
  }, [citePrompt]);

  const focusedBlockIdRef = useRef("");
  useEffect(() => { focusedBlockIdRef.current = focusedBlockId || ""; }, [focusedBlockId]);
  const attemptedMetaRef = useRef(new Set()); // pages we already tried this session

  async function fetchMetadata(block, force) {
    if (!block?.id) return;
    setMetaBusy(true);
    if (force) setStatus("Refreshing paper metadata…");
    const taskId = addTransfer({ name: `Metadata — ${(block.content || "paper").slice(0, 48)}`, kind: "ai", info: "fetching…" });
    try {
      const data = await apiJson(`${API}/metadata/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block_id: block.id, prompt: metaPrompt || "", model: chatModel || "", force: !!force }),
      });
      updateTransfer(taskId, { status: "done", info: data.cached ? "cached" : data.source === "ai" ? "AI-extracted" : data.source || "" });
      if (focusedBlockIdRef.current !== block.id) return;
      setPageMeta(data.meta || null);
      setPageBibtex(data.bibtex || "");
      setPptCite(""); // fresh metadata invalidates the cached slide citation
      setFocusedBlock((prev) => prev && prev.id === block.id
        ? { ...prev, properties: { ...prev.properties, meta: data.meta, bibtex: data.bibtex } }
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
    } finally {
      setMetaBusy(false);
    }
  }

  // When a paper is opened/uploaded, fetch its metadata in the background
  // (arXiv → DOI → AI on the server). Cached in the page's properties.
  useEffect(() => {
    setPptCite("");
    setCiteCopied("");
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
        body: JSON.stringify({ block_id: blockId, doc_id: targetDocId }),
      });
      updateTransfer(taskId, {
        status: "done",
        info: res.imported > 0 ? `${res.imported} imported` : res.found > 0 ? "already imported" : "none found",
      });
      if (res.imported > 0) {
        if (focusedBlockIdRef.current === blockId) await loadBlocksForBlock(blockId);
        setStatus(`Imported ${res.imported} annotation${res.imported === 1 ? "" : "s"} embedded in the PDF.`);
      } else if (!silent) {
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
        body: JSON.stringify({ block_id: targetId, prompt: citePrompt || "", model: chatModel || "", force }),
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

  // Opening the metadata or share popover generates the slide citation
  // automatically (cached on the page afterwards — one AI call per paper).
  useEffect(() => {
    if ((openPopover === "meta" || openPopover === "share") && (pageMeta || pageBibtex) && !pptCite && !pptCiteBusy) {
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
      setCiteCopied(kind);
      setTimeout(() => setCiteCopied(""), 1500);
    } catch {
      setStatus("Copy failed — copy manually.");
    }
  }

  useEffect(() => {
    if (!authUser?.user || readOnly) return;
    apiJson(`${API}/ai/models`).then(setAiInfo).catch(() => {});
  }, [authUser]);

  useEffect(() => {
    try { localStorage.setItem("gamma-chat-model", chatModel); } catch {}
  }, [chatModel]);
  useEffect(() => {
    try { localStorage.setItem("gamma-chat-effort", chatEffort); } catch {}
  }, [chatEffort]);
  useEffect(() => {
    try { localStorage.setItem("gamma-chat-system", chatSystem); } catch {}
  }, [chatSystem]);

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
          if (!additive && !e.target.closest?.("[data-hl-id]")) setPdfSelections([]);
          return;
        }
        const node = sel.anchorNode;
        const el = node?.nodeType === 3 ? node.parentElement : node;
        if (!(viewerWrapRef.current && el && viewerWrapRef.current.contains(el))) return;
        addPdfSelection(text, additive);
      }, 10);
    }
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
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

  function formatRelativeTime(iso) {
  if (!iso) return "";
  // Backend sends naive ISO (no tz suffix), but the values are UTC. Append Z so JS parses them as UTC.
  const then = new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z").getTime();
  const now = Date.now();
  const secs = Math.max(1, Math.floor((now - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function getPdfPageTitle(targetDocId, targetInputUrl) {
    const tail = (targetInputUrl || "").split("/").pop() || "";
    const cleaned = decodeURIComponent(tail).trim();
    return cleaned ? `PDF Notes - ${cleaned}` : `PDF Notes - ${targetDocId}`;
  }

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
      pageLayoutsRef.current[focusedBlockId] = { layout, collapsed: collapsedWins, pdfHidden, chatHidden, notesVisible, sizes };
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
      if (restoreTokenRef.current !== token) return; // superseded by a newer navigation
      if (pdfRenderedUrlRef.current === targetUrl) {
        const scroller = viewerWrapRef.current?.querySelector(".pdfViewer");
        const h = scroller ? scroller.scrollHeight : 0;
        const targetTop = entry.top * ((pdfEffScaleRef.current || entry.scale || 1) / (entry.scale || 1));
        if (scroller && h > targetTop && h === lastH) {
          scroller.scrollTo({ top: targetTop, behavior: "instant" });
          pendingRestoreRef.current = null;
          finish();
          return;
        }
        lastH = h;
      }
      if (tries++ < 80) setTimeout(tryScroll, 120);
      else finish();
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

  function goHome() {
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
    fetchHomeBlocks();
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
      setShareCopied(false);
    } catch (err) {
      setStatus(`Share failed: ${err.message}`);
    }
  }

  async function copyShareLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
    } catch {
      setStatus("Copy failed — copy the link manually.");
    }
  }

  // Download the current page as Markdown. The server returns a bare .md, or a
  // .zip (page + assets/) when the page references uploaded files — we save
  // whichever comes back, taking the filename from Content-Disposition. Using
  // fetch+blob (not a plain navigation) so a 404/401 surfaces as a message
  // instead of silently swapping the SPA for an error page.
  async function exportPage(mode = "readable") {
    const id = focusedBlock?.id;
    if (!id) { setStatus("Open a page first to export it."); return; }
    setOpenPopover(null);
    setStatus("Exporting page…");
    try {
      const res = await fetch(`${API}/pages/${id}/export?mode=${mode}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ctype = res.headers.get("Content-Type") || "";
      // If the SPA fallback served index.html, the export route isn't live yet.
      if (ctype.includes("text/html")) throw new Error("export route not found — restart the backend");
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const plain = /filename="?([^";]+)"?/i.exec(cd);
      const filename = star ? decodeURIComponent(star[1])
        : plain ? plain[1]
        : `page.${blob.type.includes("zip") ? "zip" : "md"}`;
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
          model: chatModel || "",
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

  function openPromptEditor() {
    setPromptDraft(chatSystem || aiInfo?.default_prompt || "");
    setMetaPromptDraft(metaPrompt || aiInfo?.metadata_prompt || "");
    setCitePromptDraft(citePrompt || aiInfo?.cite_prompt || "");
    setPromptOpen(true);
  }


  // --- reference links: PDF text regions manually linked to papers ----------

  // Match a URL against the library: DOI or arXiv id already known → that page.
  function findPageForUrl(url) {
    const doiM = (url || "").match(/10\.\d{4,9}\/[^\s?#]+/);
    const doi = doiM ? decodeURIComponent(doiM[0]).replace(/[.,;)\]]+$/, "").toLowerCase() : "";
    const arxM = (url || "").match(/arxiv(?:\.org\/(?:abs|pdf)\/|[:.])(\d{4}\.\d{4,5})/i);
    const arx = arxM ? arxM[1] : "";
    if (!doi && !arx) return null;
    for (const b of homeBlocks) {
      const p = b.properties || {};
      const m = p.meta || {};
      if (doi && (m.doi || "").toLowerCase() === doi) return b.id;
      if (arx && (m.arxiv_id === arx || (p.source_url || "").includes(arx))) return b.id;
      if (doi && (p.source_url || "").toLowerCase().includes(doi)) return b.id;
    }
    return null;
  }

  // Any document link (PDF annotation or manual reference link): if the target
  // paper is already in the library, open it; otherwise ask fetch-vs-browser.
  function handleDocLink(url) {
    const pid = findPageForUrl(url);
    if (pid) {
      setStatus("Already in your library — opening.");
      openBlock(pid, { pushNav: true });
      return;
    }
    setLinkPrompt(url);
  }

  // Rank a library paper against the selected reference text: author surnames
  // and identifiers weigh most, then title words, year, volume, venue.
  function scorePaperMatch(text, b) {
    const t = (text || "").toLowerCase();
    if (!t) return 0;
    const words = new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 3));
    const p = b.properties || {};
    const m = p.meta || {};
    let score = 0;
    if (m.doi && t.includes(String(m.doi).toLowerCase())) score += 20;
    if (m.arxiv_id && t.includes(m.arxiv_id)) score += 20;
    for (const a of (m.authors || [])) {
      const last = String(a).trim().split(/\s+/).pop().toLowerCase();
      if (last.length > 2 && t.includes(last)) score += 4;
    }
    for (const w of String(m.title || b.content || "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length > 3 && words.has(w)) score += 2;
    }
    if (m.year && t.includes(String(m.year))) score += 2;
    if (m.volume && new RegExp(`\\b${m.volume}\\b`).test(t)) score += 2;
    for (const w of String(m.venue || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)) {
      if (w.length > 2 && t.includes(w)) score += 1;
    }
    return score;
  }

  // Bare DOIs / arXiv ids typed into the link dialog become proper URLs.
  function normalizeLinkInput(s) {
    s = (s || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (/^arxiv:/i.test(s)) return `https://arxiv.org/abs/${s.slice(6).trim()}`;
    if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(s)) return `https://arxiv.org/abs/${s}`;
    return `https://doi.org/${s.replace(/^doi:\s*/i, "")}`;
  }

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
    setPdfScale(String(Math.max(0.2, Math.min(4, next / 100))));
  }

  function jumpToHighlightId(highlightId) {
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
  useEffect(() => { setSelectedPages(new Set()); setSelectedFolders(new Set()); setMovePicker(false); setHomeMenu(null); }, [folderFilter, homeMode]);
  const pageOnly = !pdfUrl && !!focusedBlockId && !readOnly;
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
  const highlights = useMemo(() => {
    const byHlId = new Map();
    for (const b of flattenBlocks(blocks)) {
      if (b.properties?.highlight_id) byHlId.set(b.properties.highlight_id, b);
    }
    return blocksToHighlights(blocks).map((h) => {
      const p = byHlId.get(h.id)?.properties || {};
      const url = p.link_url || "";
      const pageId = p.link_page_id || "";
      return (url || pageId) ? { ...h, linkTarget: { url, pageId, highlightId: p.link_highlight_id || "" } } : h;
    });
  }, [blocks]);
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

  // Restore PDF scroll position from session.
  // Polls until the viewer is mounted and the doc is ready (scrollToRef is set
  // and a page element exists), so it works on PDFs with no highlights and on
  // slow loads. Doesn't depend on highlights.
  useEffect(() => {
    if (pdfHidden) return;
    if (restoredPdfUrlRef.current === pdfUrl) return;
    // Tab switches restore an exact per-page position (tabScrollRef) — the
    // coarse session page number is only for reopening the app.
    if (tabScrollRef.current[focusedBlockIdRef.current]) return;
    const saved = loadSession().pdfPageNumber;
    if (!saved || saved <= 1) return;
    let cancelled = false;
    let tries = 0;
    const tryRestore = () => {
      if (cancelled) return;
      if (tries++ > 50) return; // give up after ~5s
      if (!scrollToRef.current || !document.querySelector('[data-page]')) {
        setTimeout(tryRestore, 100);
        return;
      }
      restoredPdfUrlRef.current = pdfUrl;
      scrollToRef.current({
        position: {
          pageNumber: saved,
          boundingRect: { x1: 0, y1: 0, x2: 1, y2: 1, width: 1, height: 1, pageNumber: saved },
          rects: [],
        },
      });
    };
    tryRestore();
    return () => { cancelled = true; };
  }, [pdfUrl, pdfHidden]);

  // Track PDF scroll position — poll via scrollable container
  useEffect(() => {
    if (!pdfUrl || pdfHidden) return;
    let container = null;
    let ticking = false;
    function findContainer() {
      const p = document.querySelector('[data-page]');
      if (!p) return null;
      let el = p.parentElement;
      while (el && el !== document.body) {
        if (el.scrollHeight > el.clientHeight) return el;
        el = el.parentElement;
      }
      return null;
    }
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (!container) return;
        const pages = container.querySelectorAll('[data-page]');
        if (pages.length === 0) return;
        const cr = container.getBoundingClientRect();
        const midY = cr.top + cr.height / 2;
        for (const el of pages) {
          const r = el.getBoundingClientRect();
          if (r.top <= midY && r.bottom >= midY) {
            const n = parseInt(el.dataset.page);
            if (n) setPdfPageNumber(n);
            break;
          }
        }
      });
    }
    // Retry finding container until pages render
    let tries = 0;
    const retry = setInterval(() => {
      container = findContainer();
      if (container) {
        clearInterval(retry);
        container.addEventListener('scroll', onScroll, { passive: true });
      }
      if (++tries > 30) clearInterval(retry);
    }, 300);
    return () => {
      clearInterval(retry);
      if (container) container.removeEventListener('scroll', onScroll);
    };
  }, [pdfUrl, pdfHidden]);

  // Login page state
  if (authUser === null) {
    return <div className="app"><div className="loginPage"><div className="loginCard"><div className="loginTitle">Gamma</div><p style={{color:"var(--text-muted)",textAlign:"center",marginBottom:24}}>Loading...</p></div></div></div>;
  }

  if (authUser === false) {
    return (
      <div className="app">
        <div className="loginPage">
          <div className="loginCard">
            <div className="loginTitle">Gamma</div>
            <p className="loginSubtitle">Annotate PDFs, Share Your Thinking</p>
            <form onSubmit={doLogin}>
              <input
                type="text"
                value={loginUser}
                onChange={(e) => setLoginUser(e.target.value)}
                placeholder="Username"
                className="loginInput"
                autoFocus
              />
              <input
                type="password"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
                placeholder="Password"
                className="loginInput"
              />
              {loginError ? <div className="loginError">{loginError}</div> : null}
              <button type="submit" className="loginBtn" disabled={!loginUser.trim() || !loginPass.trim()}>
                Log in
              </button>
              <button type="button" className="loginGuestBtn" onClick={doGuestLogin}>
                Continue as guest
              </button>
            </form>
          </div>
        </div>
      </div>
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
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" /></svg>
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
                        category.split(",").map((t, i) => t.trim() ? <span key={i} className="categoryBadge">{t.trim()}</span> : null)
                      ) : "Add labels..."}
                    </span>
                  )}
              </div>
            ) : null}
            </div>
            {!readOnly && focusedBlockId ? (
              <div className="pageActionCol">
                {docId ? (
                  <button
                    className="pageActionBtn aiTitleBtn"
                    title="AI: read the PDF and fill in the paper's title"
                    aria-label="Fill in title with AI"
                    onClick={aiFillTitle}
                    disabled={aiTitleBusy}
                  >
                    {aiTitleBusy ? (
                      <span className="chatTyping"><span /><span /><span /></span>
                    ) : (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.7 5.6 1.8-5.6 1.8L12 17l-1.9-5.7L4.5 9.5l5.6-1.8L12 2z" /><path d="M19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14z" /></svg>
                    )}
                  </button>
                ) : null}
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
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-5" /><path d="M12 8h.01" /></svg>
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
                        {pageMeta ? (
                          <div className="metaTable">
                            <div className="metaRow"><span className="metaKey">Title</span><span className="metaVal">{pageMeta.title}</span></div>
                            <div className="metaRow"><span className="metaKey">Authors</span><span className="metaVal">{(pageMeta.authors || []).join(", ") || "—"}</span></div>
                            <div className="metaRow"><span className="metaKey">Venue</span><span className="metaVal">{pageMeta.venue || "—"}</span></div>
                            <div className="metaRow"><span className="metaKey">Year</span><span className="metaVal">{pageMeta.year || "—"}{pageMeta.volume ? ` · vol. ${pageMeta.volume}` : ""}{pageMeta.pages ? `, pp. ${pageMeta.pages}` : ""}</span></div>
                            {pageMeta.doi ? (
                              <div className="metaRow"><span className="metaKey">DOI</span><span className="metaVal"><a href={`https://doi.org/${pageMeta.doi}`} target="_blank" rel="noreferrer">{pageMeta.doi}</a></span></div>
                            ) : null}
                            {pageMeta.arxiv_id ? (
                              <div className="metaRow"><span className="metaKey">arXiv</span><span className="metaVal"><a href={`https://arxiv.org/abs/${pageMeta.arxiv_id}`} target="_blank" rel="noreferrer">{pageMeta.arxiv_id}</a></span></div>
                            ) : null}
                            <div className="metaRow"><span className="metaKey">Source</span><span className="metaVal">{pageMeta.source === "ai" ? "AI-extracted" : pageMeta.source}</span></div>
                          </div>
                        ) : (
                          <div className="popoverHint">{metaBusy ? "Fetching metadata…" : "No metadata yet — hit ↻ to fetch."}</div>
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
                                    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                                    : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>}
                                </button>
                              </div>
                            ) : (
                              <div className="popoverHint">{pptCiteBusy ? "Generating…" : "Citation will generate when metadata is ready."}</div>
                            )}
                          </>
                        ) : null}
                        {pageBibtex ? (
                          <div className="reportModalBtns">
                            <button className="chatClearBtn" onClick={() => copyCitation("bibtex", pageBibtex)} title="Copy the BibTeX entry">
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4, verticalAlign: "-1px" }}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
                              {citeCopied === "bibtex" ? "Copied ✓" : "BibTeX"}
                            </button>
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
                        {sourceDraft && !sourceDraft.startsWith("/api/") ? (
                          <label className="popoverItem attachItem">
                            <input type="checkbox" checked={pdfSaveLocal} onChange={(e) => setPdfSaveLocal(e.target.checked)} />
                            <span className="attachName">Save a copy on the server</span>
                          </label>
                        ) : null}
                        {sourceDraft.trim() && sourceDraft.trim() !== inputUrl ? (
                          <div className="reportModalBtns">
                            <button
                              className="chatSendBtn"
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
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
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
                    <div className="categoryFilterHeading">{categoryFilter}</div>
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
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
                      <span className="folderName">{folderFilter.includes("/") ? folderFilter.slice(0, folderFilter.lastIndexOf("/")) : "All files"}</span>
                      <span className="folderHint">drop here to remove from this folder</span>
                    </div>
                    <div className="folderCurrent">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></svg>
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
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
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
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /><path d="M12 10v6" /><path d="M9 13h6" /></svg>
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
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /><path d="M12 10v6" /><path d="M9 13h6" /></svg>
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
                        <svg className="tileGlyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /><path d="M12 10v6" /><path d="M9 13h6" /></svg>
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
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
                                  {f}
                                </span>
                              ))}
                              {b._labels?.map((l) => (
                                <span key={`l:${l}`} className="labelTagBadge" title={`Label: ${l}`}>
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" /></svg>
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
                  allBlocks: flattenBlocks(blocks),
                  highlightColors: Object.fromEntries(highlights.map(h => [h.id, h.color])),
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
                    {dropTarget && (() => {
                      const indentStep = 14;
                      const baseOffset = 28;
                      const lineLeft = dropTarget.rect.left + baseOffset + dropTarget.depth * indentStep;
                      return (
                        <div
                          className="dropIndicator"
                          style={{
                            position: "fixed",
                            top: dropTarget.above ? dropTarget.rect.top : dropTarget.rect.bottom,
                            left: lineLeft,
                            width: Math.max(40, dropTarget.rect.width - (baseOffset + dropTarget.depth * indentStep)),
                            height: 2,
                            background: "#4a9eff",
                            pointerEvents: "none",
                            zIndex: 1000,
                            transform: "translateY(-1px)",
                            transition: "left 25ms ease-out",
                          }}
                        />
                      );
                    })()}
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
    const common = {
      onGrip: (e) => startWindowDock(e, id),
      onGripDoubleClick: () => setCollapsedWins((prev) => ({ ...prev, [id]: !prev[id] })),
      collapsed: !!collapsedWins[id],
    };
    if (id === "notes") {
      return (
        <DockWindow title="Notes" {...common} onClose={() => setNotesVisible(false)}>
          {notesWindow}
        </DockWindow>
      );
    }
    if (id === "chat") {
      return (
        <ChatDock
          {...common}
          onClose={() => setChatHidden(true)}
          docId={docId} focusedBlockId={focusedBlockId} homeBlocks={homeBlocks} pdfTitle={pdfTitle}
          pdfSelections={pdfSelections} setPdfSelections={setPdfSelections}
          chatModel={chatModel} setChatModel={setChatModel}
          chatEffort={chatEffort} setChatEffort={setChatEffort}
          chatSystem={chatSystem} aiInfo={aiInfo}
          openPromptEditor={openPromptEditor} openAiKeysEditor={openAiKeysEditor}
          openPopover={openPopover} setOpenPopover={setOpenPopover}
          setStatus={setStatus}
        />
      );
    }
    return null;
  }
  // Windows per slot, in stored order, visibility-filtered.
  const slotWins = (side) => layout[side].filter((w) => winVisible[w]);
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
    <span data-popover="menu" style={{ position: "relative", display: "inline-flex" }}>
      <button
        className={`iconBtn ${openPopover === "menu" ? "activeIcon" : ""}`}
        onClick={() => setOpenPopover((p) => (p === "menu" ? null : "menu"))}
        title="Settings"
        aria-label="Settings"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" /></svg>
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
          {!menuReadOnly && focusedBlock && !homeMode ? (
            <>
              <div className="popoverDivider" />
              <button
                className="popoverItem"
                onClick={() => { exportPage("readable"); setOpenPopover(null); }}
                title="Download this page as Markdown — nested notes, highlights as quotes, metadata front-matter. Bundles the PDF & images into a .zip when the page references them."
              >
                <svg className="popoverItemIcon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
                Export this page (.md)
              </button>
              <button
                className="popoverItem"
                onClick={() => { exportPage("logseq"); setOpenPopover(null); }}
                title="Download this page as Logseq-flavoured Markdown — re-importable via the Logseq importer."
              >
                <svg className="popoverItemIcon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
                Export this page (Logseq)
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </span>
  );

  return (
    <div
      ref={appRef}
      className={`app layout-horizontal ${readOnly ? "readOnlyMode" : ""}`}
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
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            </button>
            {navStackLen > 0 ? (
              <button
                className="iconBtn navBackBtn"
                onClick={goBackNav}
                onContextMenu={(e) => { e.preventDefault(); setNavStack([]); }}
                title={`Back to where you were${navStackLen > 1 ? ` (${navStackLen} steps)` : ""} — Alt+← · right-click to clear`}
                aria-label="Back"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
                <span className="navBackBadge">{Math.min(navStackLen, 30)}</span>
              </button>
            ) : null}
            <div className="tabStrip" role="tablist">
              {openTabs.map((t) => (
                <div
                  key={t.id}
                  role="tab"
                  ref={(el) => {
                    if (el) tabElsRef.current.set(t.id, el);
                    else tabElsRef.current.delete(t.id);
                  }}
                  className={`tab ${t.id === focusedBlockId ? "active" : ""} ${draggingTabId === t.id ? "dragging" : ""}`}
                  title={t.title}
                  draggable
                  onDragStart={(e) => {
                    dragTabRef.current = t.id;
                    setDraggingTabId(t.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => { dragTabRef.current = null; setDraggingTabId(null); }}
                  onDragOver={(e) => {
                    // Chrome-style live reorder: hovering another tab swaps places
                    const dragged = dragTabRef.current;
                    if (!dragged || dragged === t.id) return;
                    e.preventDefault();
                    updateTabs((prev) => {
                      const from = prev.findIndex((x) => x.id === dragged);
                      const to = prev.findIndex((x) => x.id === t.id);
                      if (from < 0 || to < 0 || from === to) return prev;
                      const next = [...prev];
                      const [moved] = next.splice(from, 1);
                      next.splice(to, 0, moved);
                      return next;
                    });
                  }}
                  onDrop={(e) => e.preventDefault()}
                  onClick={() => { if (t.id !== focusedBlockId) openBlock(t.id, { restoreScroll: true }); }}
                  onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}
                >
                  <span className="tabTitle">{t.title}</span>
                  <button
                    className="uiClose tabClose"
                    onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                    title="Close tab"
                    aria-label={`Close ${t.title}`}
                  >×</button>
                </div>
              ))}
            </div>
            <span data-popover="add" style={{ position: "relative", display: "inline-flex" }}>
              <button
                className={`iconBtn addBtn ${openPopover === "add" ? "activeIcon" : ""}`}
                onClick={() => setOpenPopover((p) => (p === "add" ? null : "add"))}
                title="Add — open a PDF by URL, upload a file, or start a note page"
                aria-label="Add"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
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
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" /></svg>
                  {(transfers.some((t) => t.status === "active") || indexTask?.active) ? <span className="transferSpin" /> : null}
                </button>
                {openPopover === "downloads" ? (
                  <div className="popover downloadsPopover">
                    <div className="popoverTitle citeSectionRow">
                      <span>Background tasks</span>
                      <button
                        className="searchToggle transferClearBtn"
                        title="Clear finished"
                        onClick={() => setTransfers((prev) => {
                          const kept = prev.filter((t) => t.status === "active");
                          const ids = new Set(kept.map((t) => t.id));
                          for (const [u, id] of Object.entries(transferByUrlRef.current)) {
                            if (!ids.has(id)) delete transferByUrlRef.current[u]; // cleared rows can be re-created later
                          }
                          return kept;
                        })}
                      >Clear</button>
                    </div>
                    {!transfers.length && !(indexTask && (indexTask.active || indexTask.total > 0)) ? (
                      <div className="popoverHint">No background tasks — downloads, uploads, indexing, metadata and AI jobs show up here.</div>
                    ) : null}
                    {indexTask && (indexTask.active || indexTask.total > 0) ? (
                      <div className="transferRow">
                        <span className={`transferStatus ${indexTask.active ? "active" : "done"}`}>
                          {indexTask.active
                            ? <span className="transferSpin inline" />
                            : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
                        </span>
                        <span className="transferKind">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
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
                              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                              : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 8v5" /><path d="M12 16.5h.01" /><circle cx="12" cy="12" r="9" /></svg>}
                        </span>
                        <span className="transferKind">
                          {t.kind === "upload"
                            ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M21 17v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2" /></svg>
                            : t.kind === "ai"
                              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.7 5.6 1.8-5.6 1.8L12 17l-1.9-5.7L4.5 9.5l5.6-1.8L12 2z" /><path d="M19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14z" /></svg>
                              : t.kind === "import"
                                ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                                : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M21 17v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2" /></svg>}
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
              confirm={setConfirmBox}
              setStatus={setStatus}
              onReplaced={async () => { if (focusedBlockId) await loadBlocksForBlock(focusedBlockId); }}
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
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                </button>
                {openPopover === "share" ? (
                  <div className="popover sharePopover">
                    <div className="popoverTitle">Share this page</div>
                    <div className="popoverHint">Anyone with the link can view the PDF, highlights, and notes — read-only, no login.</div>
                    {shareUrl ? (
                      <div className="shareRow">
                        <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
                        <button className="chatSendBtn" onClick={copyShareLink}>{shareCopied ? "Copied ✓" : "Copy"}</button>
                      </div>
                    ) : (
                      <div className="popoverHint">Creating link…</div>
                    )}
                    {(pageMeta || pageBibtex) ? (
                      <>
                        <div className="popoverDivider" />
                        <div className="popoverSection">Slide citation</div>
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
                                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>}
                            </button>
                          </div>
                        ) : (
                          <div className="popoverHint">{pptCiteBusy ? "Generating…" : "Citation will generate when metadata is ready."}</div>
                        )}
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
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                </button>
                {openPopover === "user" ? (
                  <div className="popover userPopover">
                    <div className="userCard">
                      <span className="userAvatar" aria-hidden="true">
                        {authUser.is_guest
                          ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
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

                    <div className="popoverSection">Papers &amp; PDFs</div>
                    <label className="settingRow" title="When a publisher PDF is paywalled or blocks server fetching, load a legal open-access copy (often the arXiv version) instead">
                      <span className="settingText">
                        <span className="settingLabel">Open-access fallback</span>
                        <span className="settingDesc">Load a legal arXiv / OA copy when a publisher PDF is blocked</span>
                      </span>
                      <span className="switch">
                        <input type="checkbox" checked={oaFallback} onChange={(e) => setOaFallback(e.target.checked)} />
                        <span className="switchTrack" />
                      </span>
                    </label>
                    <label className="settingRow" title="Look up title, authors, venue, and BibTeX (arXiv → DOI → AI) automatically when a paper is opened">
                      <span className="settingText">
                        <span className="settingLabel">Auto-fetch metadata</span>
                        <span className="settingDesc">Resolve title, authors, venue &amp; BibTeX when a paper opens</span>
                      </span>
                      <span className="switch">
                        <input type="checkbox" checked={metaAutoFetch} onChange={(e) => setMetaAutoFetch(e.target.checked)} />
                        <span className="switchTrack" />
                      </span>
                    </label>
                    <label className="settingRow" title="Keep a copy of PDFs opened by URL on the server, so they load fast and survive dead links">
                      <span className="settingText">
                        <span className="settingLabel">Save external PDFs</span>
                        <span className="settingDesc">Cache URL-opened PDFs on the server so they survive dead links</span>
                      </span>
                      <span className="switch">
                        <input type="checkbox" checked={pdfSaveLocal} onChange={(e) => setPdfSaveLocal(e.target.checked)} />
                        <span className="switchTrack" />
                      </span>
                    </label>
                    <div className="settingRow" title="Re-extract the text of every paper for full-text search. Runs in the background — progress shows in the tasks popover.">
                      <span className="settingText">
                        <span className="settingLabel">Search index</span>
                        <span className="settingDesc">Re-extract all PDF text if search results look stale</span>
                      </span>
                      <button
                        className="searchToggle replaceBtn"
                        disabled={indexTask?.active}
                        onClick={async () => {
                          try {
                            const d = await apiJson(`${API}/search-reindex`, { method: "POST" });
                            setStatus(d.busy
                              ? "Indexing is already running — see the tasks popover."
                              : d.scheduled
                                ? `Re-indexing ${d.scheduled} paper${d.scheduled === 1 ? "" : "s"} in the background.`
                                : "No papers with PDFs to index.");
                          } catch (err) {
                            setStatus(`Reindex failed: ${err.message}`);
                          }
                        }}
                      >{indexTask?.active ? "Indexing…" : "Rebuild"}</button>
                    </div>

                    <div className="popoverDivider" />
                    <button className="popoverItem" onClick={() => { openPromptEditor(); setOpenPopover(null); }}>
                      <svg className="popoverItemIcon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>
                      AI prompts…
                    </button>
                    <button
                      className="popoverItem"
                      onClick={() => { setOpenPopover(null); window.location.href = `${API}/export`; }}
                      title="Download a zip backup: your notes databases + every uploaded PDF. Restore by unpacking into users/<name>/ on the server."
                    >
                      <svg className="popoverItemIcon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                      Export my data (.zip)
                    </button>
                    {!authUser.is_guest ? (
                      <button className="popoverItem" onClick={() => { openAiKeysEditor(); setOpenPopover(null); }}>
                        <svg className="popoverItemIcon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>
                        AI providers &amp; keys…
                      </button>
                    ) : null}
                    {authUser.is_admin ? (
                      <button className="popoverItem" onClick={() => { openUsersManager(); setOpenPopover(null); }}>
                        <svg className="popoverItemIcon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                        Manage users…
                      </button>
                    ) : null}
                    <div className="popoverHint">
                      {authUser.is_guest
                        ? "AI keys & models are configured on the server."
                        : "API keys are stored on the server for your account and never shown again. Open tabs sync across browsers; other preferences stay in this browser."}
                    </div>
                    <div className="popoverDivider" />
                    <button className="popoverItem popoverItemDanger" onClick={doLogout}>
                      <svg className="popoverItemIcon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
                      Log out
                    </button>
                  </div>
                ) : null}
              </span>
            )}
            {renderOverflowMenu(false)}
          </div>
          <div className="status">{status}</div>
        </>
      ) : (
        <div className="topbar">
          <button className="iconBtn homeBtn" disabled title="Home" aria-label="Home">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
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
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /><path d="M8 11h6" /></svg>
              </button>
              <span className="pdfZoomLevel">
                <input
                  className="pdfZoomInput"
                  value={zoomDraft !== null ? zoomDraft : String(Math.round(pdfEffScale * 100))}
                  onFocus={(e) => { setZoomDraft(String(Math.round(pdfEffScale * 100))); e.target.select(); }}
                  onChange={(e) => setZoomDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
                  onBlur={() => {
                    const n = parseInt(zoomDraft, 10);
                    if (!isNaN(n) && n > 0) setPdfScale(String(Math.max(0.4, Math.min(4, n / 100))));
                    setZoomDraft(null);
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  title="Type a zoom percentage"
                />%
              </span>
              <button onClick={() => zoomStep(1)} title="Zoom in" aria-label="Zoom in">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /><path d="M8 11h6" /><path d="M11 8v6" /></svg>
              </button>
              <button className="pdfFitWidthBtn" onClick={() => setPdfScale("page-width")} title="Fit to width" aria-label="Fit to width">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5v14" /><path d="M21 5v14" /><path d="M7 12h10" /><path d="m9 9-3 3 3 3" /><path d="m15 9 3 3-3 3" /></svg>
              </button>
            </div>
          ) : null}
          {pdfUrl ? (
            <PdfViewer url={pdfUrl} highlights={highlights}
              pdfScaleValue={pdfScale} scrollRef={scrollToRef}
              searchRef={pdfSearchRef}
              findMarks={findMarks}
              onEffectiveScale={setPdfEffScale}
              onBeforeLinkJump={pushNav}
              onLoadState={handlePdfLoadState}
              onExternalLink={handleDocLink}
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
                // Clicking a highlight also makes its quote the chat selection
                // (Ctrl+click appends, like text selections)
                addPdfSelection(highlights.find(h => h.id === hlId)?.content?.text, additive);
              }}
              onHighlightContext={setHighlightMenu}
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
      </div>
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
                className={`chatSendBtn ${confirmBox.danger ? "dangerBtn" : ""}`}
                onClick={() => { const fn = confirmBox.onConfirm; setConfirmBox(null); fn?.(); }}
              >{confirmBox.confirmLabel || "OK"}</button>
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
              <button
                className="chatClearBtn"
                onClick={() => { const url = linkPrompt; setLinkPrompt(null); pushNav(); openPdf(url); }}
                title="Resolve this link as a PDF and open it as a new paper in Gamma"
              >Fetch into Gamma</button>
              <button
                className="chatSendBtn"
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
                className="chatSendBtn"
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
      {promptOpen ? (
        <div className="reportOverlay" onClick={() => setPromptOpen(false)}>
          <div className="reportModal promptModal" onClick={(e) => e.stopPropagation()}>
            <div className="reportModalTitle">AI prompts</div>
            <div className="reportModalHint">
              Custom prompts are saved in this browser. Saving a prompt unchanged from its default keeps the built-in behavior.
            </div>
            <div className="promptSectionHead">
              <span>Chat system prompt{chatSystem ? " · custom" : ""}</span>
              <button className="uiBtn sm" onClick={() => setPromptDraft(aiInfo?.default_prompt || "")}>Reset</button>
            </div>
            <textarea
              className="promptTextarea"
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              rows={5}
              placeholder="You are a research assistant…"
            />
            <div className="promptSectionHead">
              <span>Metadata extraction{metaPrompt ? " · custom" : ""}</span>
              <button className="uiBtn sm" onClick={() => setMetaPromptDraft(aiInfo?.metadata_prompt || "")}>Reset</button>
            </div>
            <div className="reportModalHint">Used when a paper has no arXiv id or DOI and the AI reads the first pages instead.</div>
            <textarea
              className="promptTextarea"
              value={metaPromptDraft}
              onChange={(e) => setMetaPromptDraft(e.target.value)}
              rows={4}
            />
            <div className="promptSectionHead">
              <span>PPT citation{citePrompt ? " · custom" : ""}</span>
              <button className="uiBtn sm" onClick={() => setCitePromptDraft(aiInfo?.cite_prompt || "")}>Reset</button>
            </div>
            <div className="reportModalHint">Turns the paper's BibTeX into a minimal slide-ready citation (Share → PPT citation).</div>
            <textarea
              className="promptTextarea"
              value={citePromptDraft}
              onChange={(e) => setCitePromptDraft(e.target.value)}
              rows={4}
            />
            <div className="reportModalBtns">
              <button className="uiBtn" onClick={() => setPromptOpen(false)}>Cancel</button>
              <button className="uiBtn primary"
                onClick={() => {
                  // Saving the unmodified default = no custom prompt
                  const norm = (draft, def) => {
                    const d = (draft || "").trim();
                    return d === (def || "").trim() ? "" : d;
                  };
                  setChatSystem(norm(promptDraft, aiInfo?.default_prompt));
                  setMetaPrompt(norm(metaPromptDraft, aiInfo?.metadata_prompt));
                  setCitePrompt(norm(citePromptDraft, aiInfo?.cite_prompt));
                  setPromptOpen(false);
                }}>Save</button>
            </div>
          </div>
        </div>
      ) : null}
      {aiKeysOpen ? (
        <div className="reportOverlay" onClick={() => setAiKeysOpen(false)}>
          <div className="reportModal promptModal" onClick={(e) => e.stopPropagation()}>
            <div className="reportModalTitle">AI providers</div>
            <div className="reportModalHint">
              Bring your own API keys. Keys are stored on the server for your account only and are
              never sent back to the browser — after saving, only the last 4 characters are shown.
            </div>
            {!aiKeysInfo && !aiKeysError ? <div className="reportModalHint">Loading…</div> : null}
            {aiKeysInfo ? (
              <>
                {aiKeysInfo.providers.length === 0 && !aiKeysForm ? (
                  <div className="reportModalHint">
                    {aiKeysInfo.can_edit
                      ? "No providers yet — add one to enable AI chat, metadata extraction and citations."
                      : "Guest accounts can't store API keys. Ask the admin for an account to use AI features."}
                  </div>
                ) : null}
                {aiKeysInfo.providers.map((p) => {
                  const proto = aiProtocolOf(p.protocol);
                  return (
                    <div key={p.id} className="aiProvRow">
                      <span className="aiProvMeta">
                        <span className="aiProvName">{p.name || proto?.label || p.protocol}</span>
                        <span className="aiProvDesc">
                          {`key ${p.key_hint || "set"} · ${proto?.label || p.protocol}`}
                          {p.base_url ? ` · ${p.base_url}` : ""}
                          {p.created_at ? ` · added ${new Date(p.created_at).toLocaleDateString()}` : ""}
                        </span>
                        <span className="aiProvDesc">
                          models: {p.models || `${proto?.default_model || "provider default"} (default)`}
                        </span>
                      </span>
                      <span className="aiProvActions">
                        {aiKeysInfo.can_edit ? (
                          <>
                            <button className="uiBtn sm" disabled={aiKeysBusy} onClick={() => startEditAiProvider(p)}>Edit</button>
                            <button className="uiBtn sm danger" disabled={aiKeysBusy} onClick={() => deleteAiProvider(p.id)}>Remove</button>
                          </>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
                {aiKeysForm ? (
                  <div className="aiProvForm">
                    <div className="promptSectionHead"><span>{aiKeysForm.id ? "Edit provider" : "Add provider"}</span></div>
                    <select
                      className="aiKeyInput"
                      value={aiKeysForm.protocol}
                      onChange={(e) => setAiKeysForm((f) => ({ ...f, protocol: e.target.value }))}
                    >
                      {aiKeysInfo.protocols.map((x) => (
                        <option key={x.id} value={x.id}>{x.label}</option>
                      ))}
                    </select>
                    <div className="reportModalHint">
                      The API format, not the vendor — many services speak one of these (DeepSeek,
                      Kimi, GLM via Anthropic format; most others via OpenAI format).
                    </div>
                    <input
                      className="aiKeyInput" type="text" spellCheck={false}
                      placeholder='Name (optional — e.g. "DeepSeek", "work key")'
                      value={aiKeysForm.name}
                      onChange={(e) => setAiKeysForm((f) => ({ ...f, name: e.target.value }))}
                    />
                    <input
                      className="aiKeyInput" type="password" autoComplete="new-password" spellCheck={false}
                      placeholder={aiKeysForm.id ? "API key (leave empty to keep the current one)" : "API key"}
                      value={aiKeysForm.api_key}
                      onChange={(e) => setAiKeysForm((f) => ({ ...f, api_key: e.target.value }))}
                    />
                    <input
                      className="aiKeyInput" type="text" spellCheck={false}
                      placeholder={`Base URL (optional — default ${aiProtocolOf(aiKeysForm.protocol)?.default_base_url || ""})`}
                      value={aiKeysForm.base_url}
                      onChange={(e) => setAiKeysForm((f) => ({ ...f, base_url: e.target.value }))}
                    />
                    <input
                      className="aiKeyInput" type="text" spellCheck={false}
                      placeholder={`Models, comma-separated — first is the default (optional — default ${aiProtocolOf(aiKeysForm.protocol)?.default_model || ""})`}
                      value={aiKeysForm.models}
                      onChange={(e) => setAiKeysForm((f) => ({ ...f, models: e.target.value }))}
                    />
                    <div className="reportModalBtns">
                      <button className="uiBtn" onClick={() => { setAiKeysForm(null); setAiKeysError(""); }}>Cancel</button>
                      <button className="uiBtn primary" disabled={aiKeysBusy} onClick={submitAiProvider}>
                        {aiKeysBusy ? "Saving…" : aiKeysForm.id ? "Save changes" : "Add provider"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="reportModalBtns">
                    <button className="uiBtn" onClick={() => setAiKeysOpen(false)}>Close</button>
                    {aiKeysInfo.can_edit ? (
                      <button className="uiBtn primary" onClick={startAddAiProvider}>+ Add provider</button>
                    ) : null}
                  </div>
                )}
              </>
            ) : null}
            {aiKeysError ? <div className="reportModalHint aiKeysError">{aiKeysError}</div> : null}
          </div>
        </div>
      ) : null}
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
                        <button className="uiBtn sm" disabled={usersBusy}
                          title="Rename the account — sessions and share links keep working"
                          onClick={() => { setUsersError(""); setUserPwEdit(null); setUserRenameEdit({ username: u.username, value: u.username }); }}>
                          Rename…
                        </button>
                        <button className="uiBtn sm" disabled={usersBusy}
                          onClick={() => { setUsersError(""); setUserRenameEdit(null); setUserPwEdit({ username: u.username, password: "" }); }}>
                          Password…
                        </button>
                        <button className="uiBtn sm" disabled={usersBusy || lastAdmin}
                          title={lastAdmin ? "The last admin can't be demoted"
                            : u.is_admin ? "Revoke the admin privilege" : "Grant the admin privilege"}
                          onClick={() => usersCall(`/users/${encodeURIComponent(u.username)}`, "PUT", { is_admin: !u.is_admin })}>
                          {u.is_admin ? "Revoke admin" : "Make admin"}
                        </button>
                        {u.username !== usersInfo.me ? (
                          <button className="uiBtn sm danger" disabled={usersBusy} onClick={() => deleteUserAccount(u)}>Delete</button>
                        ) : null}
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
            })() : (
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
