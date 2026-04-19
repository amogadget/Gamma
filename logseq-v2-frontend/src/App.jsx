import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  PdfLoader,
  PdfHighlighter,
  Highlight
} from "react-pdf-highlighter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  blocksToPageMarkdown,
  setBlockText,
  setBlockEditMode,
  addSiblingBlock,
  addChildBlock,
  indentBlock,
  outdentBlock,
  toggleCollapsed,
  updateBlockTree,
  removeBlockTree,
  flattenBlocks,
  addHighlightAsBlock,
  blocksToHighlights,
  normalizeBlocks
} from "./logseqPdfModel";

const API = "/api";

function makeId() {
  return Math.random().toString(36).slice(2, 10);
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

function oldRectToNewRect(r, pageNumber) {
  const x1 = r.leftPct;
  const y1 = r.topPct;
  const width = r.widthPct;
  const height = r.heightPct;
  return {
    x1,
    y1,
    x2: x1 + width,
    y2: y1 + height,
    width,
    height,
    pageNumber
  };
}

function convertOldAnnotation(a) {
  if (a && a.position && a.position.pageNumber) return a;

  const pageNumber = a.pageNumber;
  const rects = Array.isArray(a.rects) ? a.rects.map((r) => oldRectToNewRect(r, pageNumber)) : [];

  if (!pageNumber || rects.length === 0) {
    return {
      id: a.id || makeId(),
      content: { text: a.quote || "" },
      position: {
        pageNumber: 1,
        boundingRect: { x1: 0, y1: 0, x2: 0, y2: 0, width: 0, height: 0, pageNumber: 1 },
        rects: []
      },
      comment: { text: a.note || "", emoji: "🟡" },
      color: a.color || "rgba(255, 226, 143, 0.65)"
    };
  }

  const boundingRect = {
    x1: Math.min(...rects.map((r) => r.x1)),
    y1: Math.min(...rects.map((r) => r.y1)),
    x2: Math.max(...rects.map((r) => r.x2)),
    y2: Math.max(...rects.map((r) => r.y2)),
    pageNumber
  };
  boundingRect.width = boundingRect.x2 - boundingRect.x1;
  boundingRect.height = boundingRect.y2 - boundingRect.y1;

  return {
    id: a.id || makeId(),
    content: { text: a.quote || "" },
    position: {
      pageNumber,
      boundingRect,
      rects
    },
    comment: { text: a.note || "", emoji: "🟡" },
    color: a.color || "rgba(255, 226, 143, 0.65)"
  };
}

function parseStored(payload) {
  if (!payload || !payload.data) return { version: 1, annotations: [] };
  try {
    const obj = JSON.parse(payload.data);
    const raw = Array.isArray(obj.annotations) ? obj.annotations : [];
    return {
      version: 1,
      annotations: raw.map(convertOldAnnotation)
    };
  } catch {
    return { version: 1, annotations: [] };
  }
}

async function apiJson(url, options = {}) {
  const r = await fetch(url, options);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${r.status} ${text}`);
  }
  return r.json();
}

async function resolvePdfUrl(rawUrl) {
  const data = await apiJson(`${API}/resolve-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_url: rawUrl })
  });
  return data.source_url;
}

const COLORS = [
  "rgba(255, 226, 143, 0.65)",
  "rgba(170, 235, 170, 0.65)",
  "rgba(155, 205, 255, 0.65)",
  "rgba(230, 180, 255, 0.65)"
];

function PlainTip({ onConfirm, onCancel }) {
  const [text, setText] = useState("");
  const [color, setColor] = useState(COLORS[0]);

  return (
    <div className="plainTip">
      <div className="colorRow">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`colorBtn ${color === c ? "selected" : ""}`}
            style={{ background: c }}
            onClick={() => setColor(c)}
            type="button"
          />
        ))}
      </div>
      <textarea
        className="plainTipInput"
        placeholder="Note"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="plainTipActions">
        <button onClick={() => onConfirm(text, color)}>Save</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const AutoGrowTextarea = React.forwardRef(function AutoGrowTextarea(props, forwardedRef) {
  const innerRef = useRef(null);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);

  return (
    <textarea
      {...props}
      ref={(el) => {
        innerRef.current = el;
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      }}
    />
  );
});

function BlockRow({
  block,
  depth,
  focusedId,
  setFocusedId,
  onJump,
  onChangeText,
  onEnterSibling,
  onAddChild,
  onIndent,
  onOutdent,
  onToggle,
  onDelete,
  onStartEdit,
  registerRef,
  readOnly
}) {
  const ref = useRef(null);
  const clickPosRef = useRef(null);

  useEffect(() => {
    registerRef(block.id, ref);
  }, [block.id, registerRef]);

  useEffect(() => {
    if (!block.editMode) return;
    const el = ref.current;
    if (!el) return;
    const pos = clickPosRef.current;
    clickPosRef.current = null;
    if (!pos) {
      // No click coords (e.g., entered edit via Enter/Tab) — default cursor to end
      return;
    }
    // Ask the browser which character offset in the textarea corresponds to (x, y).
    // Different browsers: caretPositionFromPoint (Firefox), caretRangeFromPoint (WebKit/Chromium).
    let offset = null;
    try {
      if (document.caretPositionFromPoint) {
        const cp = document.caretPositionFromPoint(pos.x, pos.y);
        if (cp && cp.offsetNode === el) offset = cp.offset;
      } else if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(pos.x, pos.y);
        if (range && range.startContainer === el) offset = range.startOffset;
      }
    } catch (_) {
      // ignore
    }
    if (offset == null) {
      // Fallback: estimate from vertical line + horizontal fraction using the textarea's metrics
      const rect = el.getBoundingClientRect();
      const relY = Math.max(0, pos.y - rect.top - parseFloat(getComputedStyle(el).paddingTop || "0"));
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const lineIndex = Math.floor(relY / lineHeight);
      const lines = (el.value || "").split("\n");
      const targetLine = Math.min(lines.length - 1, Math.max(0, lineIndex));
      const lineStart = lines.slice(0, targetLine).reduce((n, l) => n + l.length + 1, 0);
      const relX = Math.max(0, pos.x - rect.left - parseFloat(getComputedStyle(el).paddingLeft || "0"));
      // Approximate char width from font size
      const fontSize = parseFloat(getComputedStyle(el).fontSize) || 14;
      const charW = fontSize * 0.55;
      const col = Math.min(lines[targetLine]?.length || 0, Math.round(relX / charW));
      offset = lineStart + col;
    }
    try {
      el.setSelectionRange(offset, offset);
    } catch (_) {}
  }, [block.editMode]);

  const isHighlight = !!block.highlightId;
  const hasChildren = (block.children?.length || 0) > 0;

  return (
    <div className="blockRowWrap">
      <div
        className={`blockRow ${focusedId === block.id ? "focused" : ""}`}
        style={{ marginLeft: `${depth * 22}px` }}
        onMouseDown={(e) => {
          // Don't hijack clicks on interactive children (buttons, textarea, inputs, links)
          const tag = e.target.tagName;
          if (tag === "BUTTON" || tag === "TEXTAREA" || tag === "INPUT" || tag === "A") return;
          setFocusedId(block.id);
          if (!readOnly && !block.editMode) {
            // Stash click coordinates so the textarea-mount effect can place the cursor here.
            clickPosRef.current = { x: e.clientX, y: e.clientY };
            e.preventDefault();
            onStartEdit(block.id, true);
          }
        }}
      >
        {hasChildren ? (
          <button
            className="collapseBtn"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(block.id);
            }}
          >
            {block.collapsed ? "▸" : "▾"}
          </button>
        ) : isHighlight ? (
          <button
            className="collapseBtn highlightDotBtn"
            onClick={(e) => {
              e.stopPropagation();
              onJump(block.highlightId);
            }}
            title="Jump to highlight"
          >
            <span
              className="highlightDot"
              style={{ background: block.color || COLORS[0] }}
            />
          </button>
        ) : (
          <span className="collapseSpacer" />
        )}

        <div className="blockBody">
          <div className="blockMeta">
            {block.page ? `page ${block.page}` : "note"}
          </div>

          {!readOnly && block.editMode ? (
            <AutoGrowTextarea
              ref={ref}
              autoFocus
              className="blockEditor"
              data-block-id={block.id}
              value={block.content || ""}
              onChange={(e) => onChangeText(block.id, e.target.value)}
              onBlur={() => onStartEdit(block.id, false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onEnterSibling(block.id);
                } else if (e.key === "Tab" && !e.shiftKey) {
                  e.preventDefault();
                  onIndent(block.id);
                } else if (e.key === "Tab" && e.shiftKey) {
                  e.preventDefault();
                  onOutdent(block.id);
                } else if (e.key === "ArrowRight" && (block.children?.length || 0) > 0 && block.collapsed) {
                  e.preventDefault();
                  onToggle(block.id);
                } else if (e.key === "ArrowLeft" && (block.children?.length || 0) > 0 && !block.collapsed) {
                  e.preventDefault();
                  onToggle(block.id);
                } else if (e.key === "Backspace" && !(block.content || "").trim() && !(block.quote || "").trim()) {
                  e.preventDefault();
                  onDelete(block.id);
                }
              }}
              placeholder="Type..."
            />
          ) : (
            <div className="blockRendered">
              {(block.content || "").trim() ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                >
                  {block.content}
                </ReactMarkdown>
              ) : (
                <div className="blockPlaceholder">(empty)</div>
              )}
            </div>
          )}

          {block.quote?.trim() ? (
            <div className="blockQuote">
              {block.quote}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SortableBlockRow({ block, ...rowProps }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: block.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} className="sortableBlockWrap">
      <button
        className="dragHandle"
        ref={setActivatorNodeRef}
        {...listeners}
        aria-label="Drag to reorder"
        title="Drag to reorder"
        type="button"
      >⋮⋮</button>
      <BlockRow block={block} {...rowProps} />
    </div>
  );
}

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const initialUrl = params.get("src") || params.get("url") || "";
  const initialShare = params.get("share") || "";
  const readOnly = Boolean(initialShare);

  const [inputUrl, setInputUrl] = useState(initialUrl);
  const [pdfUrl, setPdfUrl] = useState("");
  const [docId, setDocId] = useState("");
  const [pdfPageId, setPdfPageId] = useState("");
  const [blocks, setBlocks] = useState([]);
  const [status, setStatus] = useState("Ready.");
  const [loading, setLoading] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(420);
  const [sidebarHeight, setSidebarHeight] = useState(280);
  const [orientation, setOrientation] = useState("horizontal");
  const dndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    })
  );
  const [notesVisible, setNotesVisible] = useState(true);
  const [flashingId, setFlashingId] = useState(null);
  const [highlightMenu, setHighlightMenu] = useState(null); // { id, x, y } or null
  const [dragOver, setDragOver] = useState(false);
  const [focusedId, setFocusedId] = useState(null);
  const [pdfTitle, setPdfTitle] = useState("");
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const scrollToRef = useRef(() => {});
  const flashTimerRef = useRef(null);
  const blockRefs = useRef({});
  const pendingFocusRef = useRef(null);
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
    if (readOnly) return;
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

  useEffect(() => {
    if (readOnly) return;
    function onContext(e) {
      // PDF.js's textLayer sits above highlights, so e.target is usually the textLayer.
      // Use elementsFromPoint to get everything stacked at the click coordinate.
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      for (const el of stack) {
        let cur = el;
        while (cur && cur !== document.body) {
          if (cur.dataset && cur.dataset.highlightId) {
            e.preventDefault();
            setHighlightMenu({ id: cur.dataset.highlightId, x: e.clientX, y: e.clientY });
            return;
          }
          cur = cur.parentElement;
        }
      }
    }
    document.addEventListener("contextmenu", onContext, true); // capture phase
    return () => document.removeEventListener("contextmenu", onContext, true);
  }, [readOnly]);

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

  function startResize(e) {
    e.preventDefault();
    e.stopPropagation();

    const isVertical = orientation === "vertical";
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = sidebarWidth;
    const startHeight = sidebarHeight;
    const target = e.currentTarget;
    const pointerId = e.pointerId;

    try { target.setPointerCapture(pointerId); } catch (_) {}

    document.body.style.cursor = isVertical ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";

    function onMove(ev) {
      ev.preventDefault();
      if (isVertical) {
        const next = Math.max(160, Math.min(window.innerHeight * 0.75, startHeight + (startY - ev.clientY)));
        setSidebarHeight(next);
      } else {
        const next = Math.max(280, Math.min(window.innerWidth * 0.75, startWidth + (startX - ev.clientX)));
        setSidebarWidth(next);
      }
    }

    function onUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { target.releasePointerCapture(pointerId); } catch (_) {}
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    }

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  useEffect(() => {
    if (initialShare) resolveShare(initialShare);
    else if (initialUrl) openPdf(initialUrl);
  }, []);

  function getPdfPageTitle(targetDocId, targetInputUrl) {
    const tail = (targetInputUrl || "").split("/").pop() || "";
    const cleaned = decodeURIComponent(tail).trim();
    return cleaned ? `PDF Notes - ${cleaned}` : `PDF Notes - ${targetDocId}`;
  }

  async function loadBlocks(pageId) {
    try {
      const payload = await apiJson(`${API}/pages/${pageId}/blocks`);
      suppressAutosaveRef.current = true;
      const tree = normalizeBlocks(payload.blocks || []);
      setBlocks(tree);
      return tree;
    } catch {
      suppressAutosaveRef.current = true;
      setBlocks([]);
      return [];
    }
  }

  async function getOrCreatePageForDoc(targetDocId, defaultTitle, legacyTitles) {
    if (!targetDocId) throw new Error("docId required");
    return await apiJson(`${API}/pages/by-doc/${targetDocId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        default_title: defaultTitle || `PDF Notes - ${targetDocId}`,
        legacy_title: (legacyTitles && legacyTitles[0]) || null
      })
    });
  }

  async function getPageForDocReadOnly(targetDocId) {
    if (!targetDocId) return null;
    try {
      return await apiJson(`${API}/pages/by-doc/${targetDocId}`);
    } catch {
      return null;
    }
  }

  async function syncPdfPage(nextBlocks, targetDocId = docId, targetInputUrl = inputUrl, titleOverride) {
    if (!targetDocId || readOnly) return;

    const defaultTitle = getPdfPageTitle(targetDocId, targetInputUrl);
    // legacy titles to try if doc_id has never been seen: URL-based, then bare-docId fallback
    const legacyTitles = [defaultTitle, `PDF Notes - ${targetDocId}`];
    const page = await getOrCreatePageForDoc(targetDocId, defaultTitle, legacyTitles);

    const title = ((titleOverride ?? pdfTitle ?? page.title ?? defaultTitle) || "").trim() || defaultTitle;
    const content = blocksToPageMarkdown(title, targetInputUrl, targetDocId, nextBlocks);

    await apiJson(`${API}/pages/${page.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content })
    });

    setPdfPageId(page.id);
    if (pdfTitle !== title) setPdfTitle(title);
    return page;
  }

  async function renameTitle(newTitle) {
    if (readOnly || !pdfPageId || !docId) return;
    const trimmed = (newTitle || "").trim();
    const finalTitle = trimmed || getPdfPageTitle(docId, inputUrl);
    setPdfTitle(finalTitle);
    try {
      await syncPdfPage(blocks, docId, inputUrl, finalTitle);
      setStatus(`Renamed to "${finalTitle}"`);
    } catch (err) {
      setStatus(`Rename failed: ${err.message}`);
    }
  }

  async function persistBlocks(nextBlocks) {
    if (readOnly || !pdfPageId) return;
    await apiJson(`${API}/pages/${pdfPageId}/blocks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks: nextBlocks })
    });
    // Also keep the page's markdown content in sync for pages.html viewer
    await syncPdfPage(nextBlocks, docId, inputUrl);
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
    try {
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch(`${API}/uploads`, { method: "POST", body: form });
      if (!resp.ok) {
        const msg = await resp.text();
        throw new Error(msg || `upload failed (${resp.status})`);
      }
      const data = await resp.json();
      // Open the uploaded PDF directly (bypass openPdf's URL-resolution path)
      const sourceUrl = data.source_url;
      const defaultTitle = getPdfPageTitle(data.doc_id, sourceUrl);
      const page = await getOrCreatePageForDoc(data.doc_id, defaultTitle, [defaultTitle, `PDF Notes - ${data.doc_id}`]);
      const nextBlocks = await loadBlocks(page.id);
      setDocId(data.doc_id);
      setInputUrl(sourceUrl);
      setPdfPageId(page.id);
      setPdfTitle(page.title || defaultTitle);
      setPdfUrl(sourceUrl);
      const newUrl = `${window.location.pathname}?src=${encodeURIComponent(sourceUrl)}`;
      window.history.replaceState({}, "", newUrl);
      syncPdfPage(nextBlocks, data.doc_id, sourceUrl, page.title || defaultTitle).catch(() => {});
      setStatus(`Uploaded ${file.name} (${data.doc_id})`);
    } catch (err) {
      setStatus(`Upload failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function openPdf(sourceUrl) {
    if (!sourceUrl || readOnly) return;
    setLoading(true);
    setStatus("Opening PDF...");
    try {
      // Uploaded PDFs are already hosted locally — skip external resolve and proxy.
      const isUpload = sourceUrl.startsWith("/api/uploads/") || sourceUrl.startsWith(`${API}/uploads/`);
      let finalUrl, resolvedDocId, proxiedUrl;
      if (isUpload) {
        finalUrl = sourceUrl;
        // filename is "<doc_id>.pdf"
        const m = sourceUrl.match(/\/uploads\/([0-9a-f]+)\.pdf$/);
        resolvedDocId = m ? m[1] : await getDocIdForUrl(sourceUrl);
        proxiedUrl = sourceUrl;
      } else {
        finalUrl = await resolvePdfUrl(sourceUrl);
        resolvedDocId = await getDocIdForUrl(finalUrl);
        proxiedUrl = `${API}/pdf?source_url=${encodeURIComponent(finalUrl)}`;
      }
      // Resolve page + load blocks FIRST, before setPdfUrl, to avoid mid-render highlight race
      const defaultTitle = getPdfPageTitle(resolvedDocId, finalUrl);
      const page = await getOrCreatePageForDoc(resolvedDocId, defaultTitle, [defaultTitle, `PDF Notes - ${resolvedDocId}`]);
      const nextBlocks = await loadBlocks(page.id);
      setDocId(resolvedDocId);
      setInputUrl(finalUrl);
      setPdfPageId(page.id);
      setPdfTitle(page.title || defaultTitle);
      setPdfUrl(proxiedUrl);
      const newUrl = `${window.location.pathname}?src=${encodeURIComponent(finalUrl)}`;
      window.history.replaceState({}, "", newUrl);
      // Sync markdown content (non-critical; fire-and-forget-ish)
      syncPdfPage(nextBlocks, resolvedDocId, finalUrl, page.title || defaultTitle).catch(() => {});
      setStatus(`Loaded ${resolvedDocId}`);
    } catch (err) {
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
      // Resolve page + load blocks BEFORE setPdfUrl (avoid getPageView race)
      const existingPage = await getPageForDocReadOnly(data.doc_id);
      if (existingPage) {
        await loadBlocks(existingPage.id);
        setPdfPageId(existingPage.id);
        setPdfTitle(existingPage.title || getPdfPageTitle(data.doc_id, data.source_url));
      } else {
        setBlocks([]);
        setPdfTitle(getPdfPageTitle(data.doc_id, data.source_url));
      }
      setDocId(data.doc_id);
      setInputUrl(data.source_url);
      setPdfUrl(data.source_url);
      setStatus(`Loaded shared doc ${data.doc_id}`);
    } catch (err) {
      setStatus(`Share open failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function createShareLink() {
    if (!pdfUrl || readOnly) return;
    try {
      const data = await apiJson(`${API}/share/${docId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_url: pdfUrl })
      });
      const link = `${window.location.origin}${window.location.pathname}?share=${data.token}`;
      await navigator.clipboard.writeText(link);
      setStatus(`Share link copied: ${link}`);
    } catch (err) {
      setStatus(`Share failed: ${err.message}`);
    }
  }

  function addHighlight(highlight) {
    if (readOnly) return;
    const withId = { ...highlight, id: highlight.id || makeId() };
    const nextBlocks = addHighlightAsBlock(blocks, withId);
    setBlocks(nextBlocks);
    // autosave effect will persist
    setStatus("Highlight saved.");
  }

  function jumpToHighlightId(highlightId) {
    const target = highlights.find((h) => h.id === highlightId);
    if (!target) return;
    scrollToRef.current(target);
    triggerFlash(highlightId);
  }

  const visibleBlocks = useMemo(() => flattenBlocks(blocks), [blocks]);
  const highlights = useMemo(() => blocksToHighlights(blocks), [blocks]);

  return (
    <div
      className={`app layout-${orientation} ${readOnly ? "readOnlyMode" : ""} ${dragOver ? "dragOver" : ""}`}
      onDragOver={readOnly ? undefined : (e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={readOnly ? undefined : (e) => {
        // Only clear when leaving the whole app, not child elements
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={readOnly ? undefined : (e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer?.files?.[0];
        if (file) uploadPdf(file);
      }}
    >
      {!readOnly ? (
        <>
          <div className="topbar">
            <button
              className="homeBtn"
              onClick={() => { window.location.href = "/"; }}
              title="Home"
              aria-label="Home"
            >
              Γ
            </button>
            <input
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              placeholder="Enter PDF URL"
            />
            <button onClick={() => openPdf(inputUrl)} disabled={loading}>
              Open
            </button>
            <button onClick={createShareLink} disabled={!pdfUrl || loading}>
              Create share link
            </button>
            <button
              className="pagesBtn"
              onClick={() => window.open("/pages.html", "_blank")}
              title="Open pages index"
            >
              Pages
            </button>
            <button
              className="orientationBtn"
              onClick={() => setOrientation((o) => (o === "horizontal" ? "vertical" : "horizontal"))}
              title={orientation === "horizontal" ? "Switch to stacked layout" : "Switch to side-by-side layout"}
            >
              {orientation === "horizontal" ? "⬍ Stack" : "⬌ Side-by-side"}
            </button>
            <button
              className="notesBtn"
              onClick={() => setNotesVisible((v) => !v)}
              title={notesVisible ? "Hide notes" : "Show notes"}
            >
              {notesVisible ? "Hide notes" : "Show notes"}
            </button>
          </div>
          <div className="status">{status}</div>
        </>
      ) : (
        <div className="topbar">
          <button
            className="homeBtn"
            disabled
            title="Home"
            aria-label="Home"
          >
            Γ
          </button>
          <button
            className="orientationBtn"
            onClick={() => setOrientation((o) => (o === "horizontal" ? "vertical" : "horizontal"))}
            title={orientation === "horizontal" ? "Switch to stacked layout" : "Switch to side-by-side layout"}
          >
            {orientation === "horizontal" ? "⬍ Stack" : "⬌ Side-by-side"}
          </button>
          <button
            className="notesBtn"
            onClick={() => setNotesVisible((v) => !v)}
            title={notesVisible ? "Hide notes" : "Show notes"}
          >
            {notesVisible ? "Hide notes" : "Show notes"}
          </button>
        </div>
      )}

      <div className="main">
        <div className="viewerWrap">
          {pdfUrl ? (
            <PdfLoader
              url={pdfUrl}
              workerSrc="/pdf.worker.min.mjs"
              beforeLoad={<div className="status">Loading PDF...</div>}
              errorMessage={<div className="status">PDF load failed.</div>}
              onError={(err) => setStatus(`PDF load failed: ${err.message}`)}
            >
              {(pdfDocument) => (
                <PdfHighlighter
                  pdfDocument={pdfDocument}
                  enableAreaSelection={() => false}
                  onScrollChange={() => {}}
                  scrollRef={(scrollTo) => {
                    scrollToRef.current = scrollTo;
                  }}
                  highlights={highlights}
                  onSelectionFinished={
                    readOnly
                      ? undefined
                      : (position, content, hideTipAndSelection) => (
                          <PlainTip
                            onConfirm={(commentText, color) => {
                              addHighlight({
                                content,
                                position,
                                comment: { text: commentText || "" },
                                color
                              });
                              hideTipAndSelection();
                            }}
                            onCancel={hideTipAndSelection}
                          />
                        )
                  }
                  highlightTransform={(highlight) => (
                    <div
                      key={`${highlight.id}-${flashingId === highlight.id ? "flash" : "base"}`}
                      data-highlight-id={highlight.id}
                      className={flashingId === highlight.id ? "colorWrap flashWrap" : "colorWrap"}
                      style={{ "--highlight-color": highlight.color || COLORS[0] }}
                    >
                      <Highlight
                        isScrolledTo={false}
                        position={highlight.position}
                      />
                    </div>
                  )}
                />
              )}
            </PdfLoader>
          ) : (
            <div className="status">No PDF open.</div>
          )}
        </div>

        {notesVisible && (<div className={`splitter splitter-${orientation}`}><div className="splitterGrab" onPointerDown={startResize} aria-label="Drag to resize" role="separator"><span className="splitterGrabDot" /></div></div>)}

        {notesVisible && (<div className="sidebar" style={{ "--sidebar-width": `${sidebarWidth}px`, "--sidebar-height": `${sidebarHeight}px` }}>
          <div className="pageTitleRow">
            {titleEditing && !readOnly && docId ? (
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
                className={!readOnly && docId ? "titleText editable" : "titleText"}
                title={!readOnly && docId ? "Click to rename" : undefined}
                onClick={() => {
                  if (readOnly || !docId) return;
                  setTitleDraft(pdfTitle || getPdfPageTitle(docId, inputUrl));
                  setTitleEditing(true);
                }}
              >{docId ? (pdfTitle || getPdfPageTitle(docId, inputUrl)) : "PDF Notes"}</h3>
            )}

          </div>

          {inputUrl ? (
            <div className="pageHeaderMeta">
              <div className="pageHeaderLabel">Source PDF</div>
              <div className="pageHeaderUrl">{inputUrl}</div>
            </div>
          ) : null}

          <div className="blockList">
            {visibleBlocks.length === 0 ? (
              <div className="empty">No blocks yet.</div>
            ) : (
              (() => {
                const rowProps = {
                  focusedId,
                  setFocusedId,
                  onJump: jumpToHighlightId,
                  registerRef,
                  readOnly,
                  onChangeText: (id, text) => {
                    if (readOnly) return;
                    const next = setBlockText(blocks, id, text);
                    setBlocks(next);
                  },
                  onStartEdit: (id, editMode) => {
                    if (readOnly) return;
                    if (editMode) pendingFocusRef.current = id;
                    const next = setBlockEditMode(blocks, id, editMode);
                    setBlocks(next);
                    if (!editMode) {
                      persistBlocks(next).catch((err) => setStatus(`Save failed: ${err.message}`));
                    }
                  },
                  onEnterSibling: (id) => {
                    if (readOnly) return;
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
                    if (readOnly) return;
                    const next = indentBlock(blocks, id);
                    setBlocks(next);
                    setFocusedId(id);
                  },
                  onOutdent: (id) => {
                    if (readOnly) return;
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
                    setBlocks(removeBlockTree(blocks, id));
                  },
                };
                const rootIds = (blocks || []).map((b) => b.id);
                return (
                  <DndContext
                    sensors={dndSensors}
                    collisionDetection={closestCenter}
                    onDragEnd={(e) => {
                      if (readOnly) return;
                      const { active, over } = e;
                      if (!over || active.id === over.id) return;
                      const oldIdx = rootIds.indexOf(active.id);
                      const newIdx = rootIds.indexOf(over.id);
                      if (oldIdx < 0 || newIdx < 0) return;
                      const nextBlocks = arrayMove(blocks, oldIdx, newIdx);
                      setBlocks(nextBlocks);
                    }}
                  >
                    <SortableContext items={rootIds} strategy={verticalListSortingStrategy}>
                      {visibleBlocks.map((block) =>
                        block.depth === 0 && !readOnly ? (
                          <SortableBlockRow
                            key={block.id}
                            block={block}
                            depth={block.depth}
                            {...rowProps}
                          />
                        ) : (
                          <BlockRow
                            key={block.id}
                            block={block}
                            depth={block.depth}
                            {...rowProps}
                          />
                        )
                      )}
                    </SortableContext>
                  </DndContext>
                );
              })()
            )}
          </div>

        </div>)}
      </div>
      {highlightMenu ? (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
            onClick={() => setHighlightMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setHighlightMenu(null); }}
          />
          <div
            style={{
              position: "fixed",
              left: highlightMenu.x,
              top: highlightMenu.y,
              zIndex: 1000,
              background: "#222",
              border: "1px solid #444",
              borderRadius: 6,
              padding: "4px 0",
              minWidth: 120,
              boxShadow: "0 4px 12px rgba(0,0,0,0.5)"
            }}
          >
            <button
              onClick={() => {
                deleteHighlight(highlightMenu.id);
                setHighlightMenu(null);
              }}
              style={{
                display: "block",
                width: "100%",
                padding: "8px 14px",
                background: "transparent",
                color: "#eee",
                border: "none",
                textAlign: "left",
                cursor: "pointer",
                fontSize: 14
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
