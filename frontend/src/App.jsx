import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import PdfViewer, { COLORS } from "./pdfViewer";
import { API, apiJson, makeId, fmtBytes, getDocIdForUrl, resolvePdfUrl } from "./utils";
import { DockWindow, ChatMarkdown } from "./widgets";
import { BlockTree, _dragState } from "./blockTree";
import ChatDock from "./chatDock";


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
        setAuthUser({ user: data.user, is_guest: data.is_guest });
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
      const data = await res.json();
      setAuthUser({ user: data.username, is_guest: false });
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
    await fetch(`${API}/logout`, { method: "POST", credentials: "include" });
    setAuthUser(false);
    clearSession();
    setBlocks([]);
    setPdfUrl("");
    setDocId("");
  }

  useEffect(() => {
    if (!readOnly) checkSession();
  }, [readOnly]);

  const [inputUrl, setInputUrl] = useState(initialUrl);
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
  // File-browser home: folders are virtual — each page block stores a single
  // `properties.folder` string; storage stays flat at root. Empty (manually
  // created) folders live in localStorage until a paper lands in them.
  const [folderFilter, setFolderFilter] = useState(initialFolder);
  const [folderDragOver, setFolderDragOver] = useState(null);
  const [extraFolders, setExtraFolders] = useState([]);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
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
      prefsUserRef.current = "";
      setOpenTabs([]);
      setExtraFolders([]);
      return;
    }
    prefsUserRef.current = u;
    try { setOpenTabs(JSON.parse(localStorage.getItem(`gamma-tabs:${u}`) || "[]")); } catch { setOpenTabs([]); }
    try { setExtraFolders(JSON.parse(localStorage.getItem(`gamma-extra-folders:${u}`) || "[]")); } catch { setExtraFolders([]); }
  }, [authUser?.user, readOnly]);

  async function setPageFolder(pageId, folderName) {
    try {
      await apiJson(`${API}/blocks/${pageId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { folder: folderName || "" } }),
      });
      if (folderName) updateExtraFolders((prev) => prev.filter((f) => f !== folderName));
      await fetchHomeBlocks();
      setStatus(folderName ? `Moved to “${folderName}”.` : "Moved out of the folder.");
    } catch (err) {
      setStatus(`Move failed: ${err.message}`);
    }
  }

  function commitNewFolder() {
    const name = newFolderName.trim();
    setNewFolderOpen(false);
    setNewFolderName("");
    if (!name) return;
    updateExtraFolders((prev) => prev.includes(name) ? prev : [...prev, name]);
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
  // Open tabs (Chrome-style): [{id, title}], stored PER USER (and per browser)
  // so switching accounts in the same browser never surfaces someone else's
  // tabs. Persistence happens inside the updater (not an effect) so a user
  // switch can't race an in-flight save into the wrong key.
  const [openTabs, setOpenTabs] = useState([]);
  const prefsUserRef = useRef(""); // whose tabs/folders are currently loaded
  function updateTabs(updater) {
    setOpenTabs((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      const u = prefsUserRef.current;
      if (u) { try { localStorage.setItem(`gamma-tabs:${u}`, JSON.stringify(next)); } catch {} }
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
  // Workspace search (Ctrl+Shift+F) with VSCode-style options:
  // Aa = match case, ab = whole word, .* = regex, plus replace-in-notes.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchCase, setSearchCase] = useState(false);
  const [searchWhole, setSearchWhole] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchReplaceOpen, setSearchReplaceOpen] = useState(false);
  const [searchReplace, setSearchReplace] = useState("");
  const [pdfMatches, setPdfMatches] = useState([]);
  const [libMatches, setLibMatches] = useState([]); // FTS hits across ALL papers' PDF text
  const [libIndexing, setLibIndexing] = useState(0); // papers still being indexed server-side
  const [findIndex, setFindIndex] = useState(0); // active PDF match for find next/prev

  // Open a library search hit: load the paper, then scroll to the hit's page.
  function openLibMatch(r) {
    setOpenPopover(null);
    openBlock(r.block_id).then(() => {
      let tries = 0;
      const go = () => {
        if (scrollToRef.current && document.querySelector("[data-page]")) {
          scrollToRef.current({
            position: {
              pageNumber: r.page,
              boundingRect: { x1: 0, y1: 0, x2: 1, y2: 1, width: 1, height: 1, pageNumber: r.page },
              rects: [],
            },
          });
        } else if (tries++ < 40) setTimeout(go, 200);
      };
      setTimeout(go, 600); // let the session-restore scroll settle first
    });
  }
  const [searchNonce, setSearchNonce] = useState(0); // bump to re-run the search
  const pdfSearchRef = useRef(null); // set by PdfViewer: async (RegExp) => [{page, snippet, rect, pageW, pageH}]
  useEffect(() => { setFindIndex(0); }, [pdfMatches]);

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
    const fast = openPopover === "downloads" || libIndexing > 0 || indexTask?.active;
    const t = setInterval(refresh, fast ? 2000 : 8000);
    return () => { cancelled = true; clearInterval(t); };
  }, [openPopover, libIndexing, authUser?.user, readOnly, indexTask?.active]);

  const findMarksMemo = useMemo(() => (
    openPopover === "search" && searchQuery.trim()
      ? pdfMatches.map((m, i) => ({ page: m.page, rect: m.rect, active: i === findIndex }))
      : []
  ), [pdfMatches, findIndex, openPopover, searchQuery]);

  // Jump the viewer to a specific PDF match and mark it active.
  function gotoFind(i) {
    if (!pdfMatches.length) return;
    const idx = ((i % pdfMatches.length) + pdfMatches.length) % pdfMatches.length;
    setFindIndex(idx);
    const m = pdfMatches[idx];
    setPdfHidden(false);
    scrollToRef.current?.({
      position: {
        pageNumber: m.page,
        boundingRect: { ...m.rect, width: m.pageW, height: m.pageH, pageNumber: m.page },
        rects: [],
      },
    });
  }
  // ":label" tokens in the search box filter pages by their labels (the
  // colored badges under each paper title); the remaining text searches
  // notes/PDFs as usual. ":quantum :review" requires both labels.
  const searchLabelTokens = useMemo(() => (
    (searchQuery.match(/(^|\s):([\w-]+):?/g) || []).map((t) => t.replace(/[:\s]/g, "").toLowerCase()).filter(Boolean)
  ), [searchQuery]);
  const searchTextQuery = useMemo(() => searchQuery.replace(/(^|\s):[\w-]+:?/g, " ").trim(), [searchQuery]);
  const labelMatches = useMemo(() => {
    if (!searchLabelTokens.length) return [];
    return homeBlocks.filter((b) => {
      const labels = (b.properties?.category || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
      return searchLabelTokens.every((t) => labels.some((l) => l.includes(t)));
    });
  }, [searchLabelTokens, homeBlocks]);
  useEffect(() => {
    if (openPopover !== "search" || !searchTextQuery) {
      setSearchResults([]); setPdfMatches([]); setLibMatches([]); setLibIndexing(0);
      return;
    }
    const timer = setTimeout(() => {
      setSearchBusy(true);
      const q = searchTextQuery;
      const flags = `&case=${searchCase ? 1 : 0}&whole=${searchWhole ? 1 : 0}&regex=${searchRegex ? 1 : 0}`;
      const notesReq = apiJson(`${API}/block-search?q=${encodeURIComponent(q)}&limit=20${flags}`)
        .then((d) => setSearchResults(d.blocks || []))
        .catch(() => setSearchResults([]));
      // Full-text over every paper's PDF (server-side FTS index; the toggles
      // don't apply here — it's plain word matching)
      const libReq = apiJson(`${API}/pdf-search?q=${encodeURIComponent(q)}&limit=15`)
        .then((d) => { setLibMatches(d.results || []); setLibIndexing(d.indexing || 0); })
        .catch(() => { setLibMatches([]); setLibIndexing(0); });
      let pdfReq = Promise.resolve();
      if (pdfSearchRef.current) {
        try {
          let body = searchRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          if (searchWhole) body = `\\b(?:${body})\\b`;
          const re = new RegExp(body, searchCase ? "g" : "gi");
          pdfReq = pdfSearchRef.current(re).then(setPdfMatches).catch(() => setPdfMatches([]));
        } catch { setPdfMatches([]); }
      } else {
        setPdfMatches([]);
      }
      Promise.allSettled([notesReq, pdfReq, libReq]).then(() => setSearchBusy(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [searchTextQuery, openPopover, searchCase, searchWhole, searchRegex, searchNonce]);

  function replaceAllInNotes() {
    const q = searchTextQuery;
    if (!q) return;
    setConfirmBox({
      title: "Replace all",
      message: `Replace all occurrences of "${q}" with "${searchReplace}" across ALL your notes?`,
      confirmLabel: "Replace all",
      onConfirm: async () => {
        try {
          const data = await apiJson(`${API}/blocks-replace`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: q, replacement: searchReplace, case: searchCase, whole: searchWhole, regex: searchRegex }),
          });
          setStatus(`Replaced in ${data.changed} block${data.changed === 1 ? "" : "s"}.`);
          if (focusedBlockId) await loadBlocksForBlock(focusedBlockId);
          setSearchNonce((n) => n + 1);
        } catch (err) {
          setStatus(`Replace failed: ${err.message}`);
        }
      },
    });
  }
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

  useEffect(() => {
    if (readOnly || !focusedBlockId) return;
    if (suppressAutosaveRef.current) {
      suppressAutosaveRef.current = false;
      return;
    }
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      persistBlocks(blocks).catch((err) => setStatus(`Save failed: ${err.message}`));
    }, 500);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [blocks, readOnly]);


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
    captureScrollPos(); // remember the reading position of the page we're leaving
    cancelPdfRestore(); // a stale restore loop must not scroll the next document
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
  // Per-page window layout (dock slots, collapsed bars, hidden windows) —
  // captured when leaving a page, restored when it's opened again.
  const pageLayoutsRef = useRef({});
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
    // The page's window layout travels with it.
    if (focusedBlockId && !readOnly && prefsUserRef.current) {
      pageLayoutsRef.current[focusedBlockId] = { layout, collapsed: collapsedWins, pdfHidden, chatHidden, notesVisible };
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
    captureScrollPos(); // tabbing back later returns to this position
    cancelPdfRestore();
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
  const pageOnly = !pdfUrl && !!focusedBlockId && !readOnly;
  const recentPages = useMemo(() => {
    return [...homeBlocks]
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
      .slice(0, 4);
  }, [homeBlocks]);
  const recentIds = useMemo(() => new Set(recentPages.map((b) => b.id)), [recentPages]);
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
      _folder: (b.properties?.folder || "").trim(),
      _isRecent: recentIds.has(b.id),
      _isEmpty: !b.content,
      editMode: homeEditingId === b.id,
    }));
  }, [homeBlocks, recentIds, homeEditingId]);
  // Folder names: everything referenced by a page, plus manually created empties
  const folderNames = useMemo(() => {
    const set = new Set(extraFolders);
    for (const b of pageBlocks) if (b._folder) set.add(b._folder);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [pageBlocks, extraFolders]);
  const folderCounts = useMemo(() => {
    const m = {};
    for (const b of pageBlocks) if (b._folder) m[b._folder] = (m[b._folder] || 0) + 1;
    return m;
  }, [pageBlocks]);
  // What the home list shows: inside a folder → its papers; at root → unfiled papers
  const homeVisiblePages = useMemo(() => (
    folderFilter ? pageBlocks.filter((b) => b._folder === folderFilter)
                 : pageBlocks.filter((b) => !b._folder)
  ), [pageBlocks, folderFilter]);
  const highlights = useMemo(() => {
    const flat = flattenBlocks(blocks);
    return blocksToHighlights(blocks).map((h) => {
      const b = flat.find((x) => x.properties?.highlight_id === h.id);
      const url = b?.properties?.link_url || "";
      const pageId = b?.properties?.link_page_id || "";
      const highlightId = b?.properties?.link_highlight_id || "";
      return (url || pageId) ? { ...h, linkTarget: { url, pageId, highlightId } } : h;
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
        const b = flattenBlocks(blocks).find((b) => b.properties?.highlight_id === id);
        const linkedId = b?.properties?.linked_highlight_id;
        if (linkedId) scrollTarget = (highlights || []).find((x) => x.id === linkedId);
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
                            <button className="categoryTagRemove" tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); removeCategoryTag(i); }}>×</button>
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
                      onClick={() => {
                        const opening = openPopover !== "meta";
                        setOpenPopover(opening ? "meta" : null);
                        if (opening) setSourceDraft(inputUrl);
                      }}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-5" /><path d="M12 8h.01" /></svg>
                    </button>
                    {openPopover === "meta" ? (
                      <div className="popover sourcePopover metaPopover">
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
                      // Close the page's tab too (write straight to storage —
                      // we reload right after, so state updates wouldn't stick).
                      try {
                        if (prefsUserRef.current) {
                          localStorage.setItem(`gamma-tabs:${prefsUserRef.current}`,
                            JSON.stringify(openTabs.filter((t) => t.id !== focusedBlockId)));
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
              const sorted = [...homeBlocks].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
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

              return (
                <>
                  {/* Recent — all pages, scrollable carousel */}
                  <div className="carouselRow">
                    <div className="carouselLabel">Recent</div>
                    <div className="carouselTrackWrap">
                      <button className="carouselArrow carouselArrowLeft" onClick={(e) => { const t = e.currentTarget.parentElement.querySelector('.carouselTrack'); if (t) t.scrollBy({ left: -220, behavior: 'smooth' }); }}>‹</button>
                      <div className="carouselTrack" ref={(el) => { if (el) { el._scroll = el; } }}>
                        {sorted.map((b) => (
                          <button key={b.id} className="recentCard" onClick={() => openBlock(b.id)} title={b.content}>
                            <div className="recentCardTitle">{b.content || "Untitled"}</div>
                            <div className="recentCardMeta">
                              {b.properties?.summary && <span className="recentCardSummary">{b.properties.summary}</span>}
                              <span className="recentCardTime">{formatRelativeTime(b.updated_at)}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                      <button className="carouselArrow carouselArrowRight" onClick={(e) => { const t = e.currentTarget.parentElement.querySelector('.carouselTrack'); if (t) t.scrollBy({ left: 220, behavior: 'smooth' }); }}>›</button>
                    </div>
                  </div>
                  {/* Labels — one card per label */}
                  {catNames.length > 0 ? (
                    <div className="carouselRow">
                      <div className="carouselLabel">Labels</div>
                      <div className="carouselTrackWrap">
                        <button className="carouselArrow carouselArrowLeft" onClick={(e) => { const t = e.currentTarget.parentElement.querySelector('.carouselTrack'); if (t) t.scrollBy({ left: -220, behavior: 'smooth' }); }}>‹</button>
                        <div className="carouselTrack">
                          {catNames.map((cat) => (
                            <button key={cat} className="categoryCard" onClick={() => { setCategoryFilter(cat); window.history.replaceState(null, "", `/?category=${encodeURIComponent(cat)}`); }}>
                              <div className="categoryCardName">{cat}</div>
                              <div className="categoryCardCount">{categories[cat].length} {categories[cat].length === 1 ? "paper" : "papers"}</div>
                            </button>
                          ))}
                        </div>
                        <button className="carouselArrow carouselArrowRight" onClick={(e) => { const t = e.currentTarget.parentElement.querySelector('.carouselTrack'); if (t) t.scrollBy({ left: 220, behavior: 'smooth' }); }}>›</button>
                      </div>
                    </div>
                  ) : null}
                </>
              );
            })() : null}
            {homeMode && !categoryFilter ? (
              <div className="folderBrowser">
                {folderFilter ? (
                  <>
                    <div
                      className={`folderRow folderBackRow ${folderDragOver === "__root__" ? "dragOver" : ""}`}
                      onClick={() => { setFolderFilter(""); window.history.replaceState(null, "", "/"); }}
                      onDragOver={(e) => { e.preventDefault(); setFolderDragOver("__root__"); }}
                      onDragLeave={() => setFolderDragOver(null)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setFolderDragOver(null);
                        const id = e.dataTransfer.getData("text/plain");
                        if (id) setPageFolder(id, "");
                      }}
                      title="Back — or drop a paper here to move it out of the folder"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
                      <span className="folderName">All papers</span>
                      <span className="folderHint">drop here to move out</span>
                    </div>
                    <div className="folderCurrent">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></svg>
                      {folderFilter}
                    </div>
                  </>
                ) : (
                  <>
                    {folderNames.map((f) => (
                      <div
                        key={f}
                        className={`folderRow ${folderDragOver === f ? "dragOver" : ""}`}
                        onClick={() => { setFolderFilter(f); window.history.replaceState(null, "", `/?folder=${encodeURIComponent(f)}`); }}
                        onDragOver={(e) => { e.preventDefault(); setFolderDragOver(f); }}
                        onDragLeave={() => setFolderDragOver(null)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setFolderDragOver(null);
                          const id = e.dataTransfer.getData("text/plain");
                          if (id) setPageFolder(id, f);
                        }}
                        title="Open folder — or drop a paper on it to file it"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
                        <span className="folderName">{f}</span>
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
                  </>
                )}
              </div>
            ) : null}
            {homeMode && categoryFilter ? null : (
            (homeMode ? homeVisiblePages : visibleBlocks).length === 0 ? (
              <div className="empty">{homeMode
                ? (folderFilter ? "This folder is empty — drag papers onto it from the library." : (pageBlocks.length ? "All papers are filed in folders." : "No pages yet — open a PDF above to get started."))
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
                  onPageOpen: (pageBlock) => {
                    if (pageBlock._pageId) openBlock(pageBlock._pageId);
                  },
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
          openPromptEditor={openPromptEditor}
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
            <PanelGroup direction={direction} autoSaveId={`gamma-slot-${side}`}>
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
                    className="tabClose"
                    onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                    title="Close tab"
                    aria-label={`Close ${t.title}`}
                  >×</button>
                </div>
              ))}
            </div>
            {homeMode ? (
              <div className="urlBox">
                <input
                  value={inputUrl}
                  onChange={(e) => setInputUrl(e.target.value)}
                  placeholder="Open a PDF by URL — press Enter"
                  onKeyDown={(e) => { if (e.key === "Enter" && !loading) openPdf(inputUrl); }}
                />
              </div>
            ) : null}
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
            <span data-popover="search" style={{ position: "relative", display: "inline-flex" }}>
              <button
                className={`iconBtn ${openPopover === "search" ? "activeIcon" : ""}`}
                onClick={() => setOpenPopover((p) => (p === "search" ? null : "search"))}
                title="Search all notes (Ctrl+Shift+F)"
                aria-label="Search"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              </button>
              {openPopover === "search" ? (
                <div className="popover searchPopover">
                  <div className="searchRow">
                    <button
                      className={`searchToggle ${searchReplaceOpen ? "on" : ""}`}
                      onClick={() => setSearchReplaceOpen((v) => !v)}
                      title="Toggle replace"
                    >{searchReplaceOpen ? "⌄" : "›"}</button>
                    <input
                      autoFocus
                      className="searchInput"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search notes, highlights, and PDFs — :label filters by label"
                    />
                    <button className={`searchToggle ${searchCase ? "on" : ""}`} onClick={() => setSearchCase((v) => !v)} title="Match case">Aa</button>
                    <button className={`searchToggle ${searchWhole ? "on" : ""}`} onClick={() => setSearchWhole((v) => !v)} title="Match whole word"><u>ab</u></button>
                    <button className={`searchToggle ${searchRegex ? "on" : ""}`} onClick={() => setSearchRegex((v) => !v)} title="Use regular expression">.*</button>
                  </div>
                  {searchReplaceOpen ? (
                    <div className="searchRow">
                      <span className="searchToggle spacer" />
                      <input
                        className="searchInput"
                        value={searchReplace}
                        onChange={(e) => setSearchReplace(e.target.value)}
                        placeholder="Replace in notes…"
                      />
                      <button
                        className="searchToggle replaceBtn"
                        onClick={replaceAllInNotes}
                        disabled={!searchQuery.trim()}
                        title="Replace all matches across your notes (PDF text can't be edited)"
                      >Replace all</button>
                    </div>
                  ) : null}
                  <div className="searchResults">
                    {searchBusy ? <div className="searchHint">Searching…</div> : null}
                    {!searchBusy && searchQuery.trim() && searchResults.length === 0 && pdfMatches.length === 0 && libMatches.length === 0 && labelMatches.length === 0 ? (
                      <div className="searchHint">No matches.</div>
                    ) : null}
                    {searchLabelTokens.length ? (
                      <>
                        <div className="searchSection">Labels: {searchLabelTokens.map((t) => `:${t}`).join(" ")}</div>
                        {labelMatches.length === 0 ? (
                          <div className="searchHint">No pages carry {searchLabelTokens.length === 1 ? "this label" : "all these labels"}.</div>
                        ) : labelMatches.map((b) => (
                          <button
                            key={`lbl-${b.id}`}
                            className="searchResult"
                            onClick={() => { setOpenPopover(null); openBlock(b.id, { restoreScroll: true }); }}
                          >
                            <span className="searchResultPage">{b.content || "Untitled"}</span>
                            <span className="searchResultText">{b.properties?.category || ""}</span>
                          </button>
                        ))}
                      </>
                    ) : null}
                    {(() => {
                      // Priority: this paper's notes → this PDF's text → the
                      // rest of the workspace (other notes, other papers).
                      const inPage = (r) => focusedBlockId && (r.page_root_id === focusedBlockId || r.id === focusedBlockId);
                      const notesHere = searchResults.filter(inPage);
                      const notesElsewhere = searchResults.filter((r) => !inPage(r));
                      const libElsewhere = libMatches.filter((r) => r.block_id !== focusedBlockId);
                      const noteRow = (r) => (
                        <button
                          key={r.id}
                          className="searchResult"
                          onClick={() => {
                            setOpenPopover(null);
                            if (r.page_root_id && r.page_root_id !== r.id) pendingBlockScrollRef.current = r.id;
                            openBlock(r.page_root_id || r.id);
                          }}
                        >
                          <span className="searchResultPage">{r.page_title || "Untitled"}</span>
                          <span className="searchResultText">{r.content}</span>
                        </button>
                      );
                      return (
                        <>
                          {notesHere.length ? <div className="searchSection">Notes in this paper</div> : null}
                          {notesHere.map(noteRow)}
                          {pdfMatches.length ? (
                            <div className="searchSection searchSectionRow">
                              <span>This PDF · {findIndex + 1}/{pdfMatches.length}</span>
                              <span className="findNav">
                                <button className="searchToggle" onClick={() => gotoFind(findIndex - 1)} title="Previous match (matches are highlighted in the PDF)">▲</button>
                                <button className="searchToggle" onClick={() => gotoFind(findIndex + 1)} title="Next match">▼</button>
                              </span>
                            </div>
                          ) : null}
                          {pdfMatches.map((m, i) => (
                            <button
                              key={`pdf-${i}`}
                              className={`searchResult ${i === findIndex ? "active" : ""}`}
                              onClick={() => gotoFind(i)}
                            >
                              <span className="searchResultPage">p. {m.page}</span>
                              <span className="searchResultText">…{m.snippet}…</span>
                            </button>
                          ))}
                          {notesElsewhere.length ? <div className="searchSection">{focusedBlockId ? "Other notes" : "Notes"}</div> : null}
                          {notesElsewhere.map(noteRow)}
                          {libElsewhere.length || libIndexing ? (
                            <div className="searchSection">{focusedBlockId ? "Other papers" : "Library PDFs"}</div>
                          ) : null}
                          {libIndexing ? (
                            <div className="searchHint">Indexing {libIndexing} paper{libIndexing === 1 ? "" : "s"} in the background — results will fill in shortly.</div>
                          ) : null}
                          {libElsewhere.map((r, i) => (
                            <button
                              key={`lib-${i}`}
                              className="searchResult"
                              onClick={() => openLibMatch(r)}
                              title={`Open "${r.title}" at page ${r.page}`}
                            >
                              <span className="searchResultPage">{r.title.slice(0, 60)} · p. {r.page}</span>
                              <span className="searchResultText">…{r.snippet}…</span>
                            </button>
                          ))}
                        </>
                      );
                    })()}
                  </div>
                </div>
              ) : null}
            </span>
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
                  className="userBadge"
                  onClick={() => setOpenPopover((p) => (p === "user" ? null : "user"))}
                  title="Account & settings"
                >
                  {authUser.is_guest ? "guest" : authUser.user}
                </button>
                {openPopover === "user" ? (
                  <div className="popover userPopover">
                    <div className="popoverTitle">{authUser.is_guest ? "Guest" : authUser.user}</div>
                    {authUser.is_guest ? (
                      <div className="popoverHint">Guest workspace resets daily. Ask the admin for an account to keep your work.</div>
                    ) : null}
                    <div className="popoverSection">Settings</div>
                    <label className="popoverItem attachItem" title="When a publisher PDF is paywalled or blocks server fetching, load a legal open-access copy (often the arXiv version) instead">
                      <input type="checkbox" checked={oaFallback} onChange={(e) => setOaFallback(e.target.checked)} />
                      <span className="attachName">Fall back to open-access / arXiv copies</span>
                    </label>
                    <label className="popoverItem attachItem" title="Look up title, authors, venue, and BibTeX (arXiv → DOI → AI) automatically when a paper is opened">
                      <input type="checkbox" checked={metaAutoFetch} onChange={(e) => setMetaAutoFetch(e.target.checked)} />
                      <span className="attachName">Auto-fetch paper metadata</span>
                    </label>
                    <label className="popoverItem attachItem" title="Keep a copy of PDFs opened by URL on the server, so they load fast and survive dead links">
                      <input type="checkbox" checked={pdfSaveLocal} onChange={(e) => setPdfSaveLocal(e.target.checked)} />
                      <span className="attachName">Save external PDFs on the server</span>
                    </label>
                    <button className="popoverItem" onClick={() => { openPromptEditor(); setOpenPopover(null); }}>
                      AI prompts…
                    </button>
                    <button
                      className="popoverItem"
                      onClick={() => { setOpenPopover(null); window.location.href = `${API}/export`; }}
                      title="Download a zip backup: your notes databases + every uploaded PDF. Restore by unpacking into users/<name>/ on the server."
                    >
                      Export my data (.zip)
                    </button>
                    <div className="popoverHint">AI provider keys and models are configured on the server (.env: GAMMA_AI_*). Everything above is saved in this browser.</div>
                    <div className="popoverDivider" />
                    <button className="popoverItem" onClick={doLogout}>Log out</button>
                  </div>
                ) : null}
              </span>
            )}
            <span data-popover="menu" style={{ position: "relative", display: "inline-flex" }}>
              <button
                className={`iconBtn menuToggleBtn ${openPopover === "menu" ? "activeIcon" : ""}`}
                onClick={() => setOpenPopover((p) => (p === "menu" ? null : "menu"))}
                title="Menu"
                aria-label="Menu"
              >
                ⋮
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
                  <button className="popoverItem" onClick={() => setChatHidden((v) => !v)}>
                    <span className="check">{!chatHidden ? "✓" : ""}</span> AI Chat
                  </button>
                  <div className="popoverDivider" />
                  {docId && focusedBlockId ? (
                    <button
                      className="popoverItem"
                      title="Import highlights/notes saved inside the PDF file (SumatraPDF, Acrobat…)"
                      onClick={() => { importEmbeddedAnnots(focusedBlockId, docId, false); setOpenPopover(null); }}
                    >
                      Import PDF annotations
                    </button>
                  ) : null}
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
                </div>
              ) : null}
            </span>
          </div>
          <div className="status">{status}</div>
        </>
      ) : (
        <div className="topbar">
          <button className="iconBtn homeBtn" disabled title="Home" aria-label="Home">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
          </button>
          <span className="readOnlyTitle">{pdfTitle}</span>
          <span data-popover="menu" style={{ position: "relative", display: "inline-flex" }}>
            <button
              className="iconBtn menuToggleBtn"
              onClick={() => setOpenPopover((p) => (p === "menu" ? null : "menu"))}
              title="Menu"
              aria-label="Menu"
            >
              ⋮
            </button>
            {openPopover === "menu" ? (
              <div className="popover menuPopover">
                <div className="popoverSection">Windows</div>
                {pdfUrl ? (
                  <button className="popoverItem" onClick={() => setPdfHidden((v) => !v)}>
                    <span className="check">{!pdfHidden ? "✓" : ""}</span> PDF
                  </button>
                ) : null}
                <button className="popoverItem" onClick={() => setNotesVisible((v) => !v)}>
                  <span className="check">{notesVisible ? "✓" : ""}</span> Notes
                </button>
              </div>
            ) : null}
          </span>
        </div>
      )}

      {attachModeBlockId && (
        <div className="attachModeBanner">
          Click a PDF highlight to link it
          <button onClick={() => { setAttachModeBlockId(null); setAttachContextMenu(null); }}>Cancel</button>
        </div>
      )}
      {attachContextMenu && (
        <div
          className="attachContextMenu"
          style={{ left: attachContextMenu.x, top: attachContextMenu.y }}
          onMouseLeave={() => setAttachContextMenu(null)}
        >
          <button onClick={() => linkHighlightToBlock(attachModeBlockId, attachContextMenu.highlight)}>
            Link highlight here
          </button>
        </div>
      )}

      <div className="workArea">
      <PanelGroup direction="horizontal" autoSaveId="gamma-work-h">
      {slotWins("left").length ? (
        <>
          <Panel id="slot-left" order={1} defaultSize={26} minSize={15} className="dockSlot">
            {renderSlotGroup("left", "vertical")}
          </Panel>
          <PanelResizeHandle className="sash sash-horizontal" />
        </>
      ) : null}
      <Panel id="slot-center" order={2} minSize={30} className="dockSlot">
      <PanelGroup direction="vertical" autoSaveId="gamma-work-v">
      <Panel id="slot-main" order={1} minSize={20} className="dockSlot">
      <div className={`main ${(pdfHidden || homeMode || pageOnly) ? "pdfHidden" : ""}`}>
        <div className={`viewerWrap ${(pdfHidden || homeMode || pageOnly) ? "pdfHidden" : ""}`} ref={viewerWrapRef}>
          {pdfUrl && !pdfHidden ? (
            <button
              className="pdfCloseBtn"
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
              findMarks={findMarksMemo}
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
              <button className="chatClearBtn" onClick={() => setPromptDraft(aiInfo?.default_prompt || "")}>Reset</button>
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
              <button className="chatClearBtn" onClick={() => setMetaPromptDraft(aiInfo?.metadata_prompt || "")}>Reset</button>
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
              <button className="chatClearBtn" onClick={() => setCitePromptDraft(aiInfo?.cite_prompt || "")}>Reset</button>
            </div>
            <div className="reportModalHint">Turns the paper's BibTeX into a minimal slide-ready citation (Share → PPT citation).</div>
            <textarea
              className="promptTextarea"
              value={citePromptDraft}
              onChange={(e) => setCitePromptDraft(e.target.value)}
              rows={4}
            />
            <div className="reportModalBtns">
              <button className="chatClearBtn" onClick={() => setPromptOpen(false)}>Cancel</button>
              <button className="chatSendBtn"
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
      {highlightMenu ? (
        <>
          <div
            className="ctxMenuBackdrop"
            onClick={() => setHighlightMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setHighlightMenu(null); }}
          />
          <div className="ctxMenu" style={{ left: highlightMenu.x, top: highlightMenu.y }}>
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
                setRefPoint({
                  pageId: focusedBlockId,
                  pageTitle: pdfTitle || "Untitled",
                  highlightId: highlightMenu.id,
                  quote: (h?.content?.text || "").slice(0, 200),
                });
                setHighlightMenu(null);
                setStatus("Reference point copied — pick it in another paper's link dialog.");
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
          </div>
        </>
      ) : null}
    </div>
  );
}
