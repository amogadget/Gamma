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
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
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
  onEnterAttachMode,
  onUnlinkHighlight,
  onPageOpen,
  onChangeText,
  onEnterSibling,
  onAddChild,
  onIndent,
  onOutdent,
  onToggle,
  onDelete,
  onStartEdit,
  registerRef,
  readOnly,
  allBlocks,
  onBlockRefClick,
  refCache,
  onFetchRefs,
  onCacheRef,
  highlightColors,
}) {
  const ref = useRef(null);
  const clickPosRef = useRef(null);
  const [refPopup, setRefPopup] = useState(null); // { query, rect }
  const [refSelectedIdx, setRefSelectedIdx] = useState(0);
  const [searchResults, setSearchResults] = useState([]);

  useEffect(() => {
    if (!refPopup) { setSearchResults([]); return; }
    const q = refPopup.query;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/block-search?q=${encodeURIComponent(q)}&limit=8`);
        const data = await res.json();
        setSearchResults((data.blocks || []).filter((b) => b.id !== block.id));
      } catch (_) { setSearchResults([]); }
    }, 120);
    return () => clearTimeout(timer);
  }, [refPopup?.query, block.id]);

  // Resolve cross-note refs found in content
  useEffect(() => {
    if (!block.content || !onFetchRefs) return;
    const ids = [...block.content.matchAll(/\[\[([a-zA-Z0-9_-]+)\]\]/g)].map((m) => m[1]);
    const unknown = ids.filter((id) => !allBlocks?.find((b) => b.id === id) && !refCache?.[id]);
    if (unknown.length > 0) onFetchRefs(unknown);
  }, [block.content]);

  function insertRef(b) {
    const ta = ref.current;
    if (!ta) return;
    const val = ta.value;
    const cursor = ta.selectionStart;
    const before = val.slice(0, cursor);
    const match = before.match(/\[\[([^\]\n]*)$/);
    if (!match) return;
    const triggerStart = cursor - match[0].length;
    const newVal = val.slice(0, triggerStart) + `[[${b.id}]]` + val.slice(cursor);
    onChangeText(block.id, newVal);
    if (b.content && onCacheRef) onCacheRef(b.id, b);
    setRefPopup(null);
    requestAnimationFrame(() => {
      const newCursor = triggerStart + `[[${b.id}]]`.length;
      ta.setSelectionRange(newCursor, newCursor);
      ta.focus();
    });
  }

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
        onMouseDown={(e) => {
          if (e.target.closest("button, textarea, input, a")) return;
          setFocusedId(block.id);
          if (!readOnly && !block.editMode) {
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
        ) : (
          <span className="collapseSpacer" />
        )}
        {isHighlight && !block.editMode ? (
          <>
            <button
              className="collapseBtn highlightDotBtn dotSlot"
              onClick={(e) => { e.stopPropagation(); onJump(block.highlightId); }}
              title={
                block.position
                  ? "Jump to highlight"
                  : block.properties?.linked_highlight_id
                    ? "Jump to linked highlight"
                    : "Jump to page (no exact position)"
              }
            >
              <span className="highlightDot" style={{
                background: block.position
                  ? (block.color || COLORS[0])
                  : block.properties?.linked_highlight_id
                    ? (highlightColors?.[block.properties.linked_highlight_id] || COLORS[0])
                    : 'rgba(140,140,140,0.5)'
              }} />
            </button>
            {!block.position && block.properties?.linked_highlight_id && onUnlinkHighlight ? (
              <button
                className="collapseBtn attachModeBtn"
                title="Unlink highlight"
                onClick={(e) => { e.stopPropagation(); onUnlinkHighlight(block.id); }}
              >⊘</button>
            ) : null}
            {!block.position && !block.properties?.linked_highlight_id && onEnterAttachMode ? (
              <button
                className="collapseBtn attachModeBtn"
                title="Attach to a PDF highlight"
                onClick={(e) => { e.stopPropagation(); onEnterAttachMode(block.id); }}
              >⊕</button>
            ) : null}
          </>
        ) : block._pageId && typeof onPageOpen === "function" ? (
          <button
            className="collapseBtn dotSlot pageBulletBtn"
            onClick={(e) => { e.stopPropagation(); onPageOpen(block); }}
            title="Open page"
          ><span className="pageBulletDot" /></button>
        ) : (
          <span className="dotSlot dotSlotEmpty" />
        )}

        <div className="blockBody">
          {block._isRecent ? <span className="recentIndicator" title="In recent">★</span> : null}
          <div className="blockMeta">
            {block._pageId ? (block._sourceUrl ? "PDF annotation" : "regular note") : block.page ? `p.${block.page}` : "note"}
          </div>

          {!readOnly && block.editMode ? (
            <AutoGrowTextarea
              ref={ref}
              autoFocus
              className="blockEditor"
              data-block-id={block.id}
              value={block.content || ""}
              onChange={(e) => {
                onChangeText(block.id, e.target.value);
                const cursor = e.target.selectionStart;
                const before = e.target.value.slice(0, cursor);
                const match = before.match(/\[\[([^\]\n]*)$/);
                if (match) {
                  setRefPopup({ query: match[1], rect: e.target.getBoundingClientRect() });
                  setRefSelectedIdx(0);
                } else {
                  setRefPopup(null);
                }
              }}
              onBlur={() => {
                onStartEdit(block.id, false);
                setTimeout(() => setRefPopup(null), 120);
              }}
              onKeyDown={(e) => {
                if (refPopup && searchResults.length > 0) {
                  if (e.key === "ArrowDown") { e.preventDefault(); setRefSelectedIdx((i) => Math.min(i + 1, searchResults.length - 1)); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setRefSelectedIdx((i) => Math.max(i - 1, 0)); return; }
                  if (e.key === "Enter") { e.preventDefault(); insertRef(searchResults[refSelectedIdx]); return; }
                  if (e.key === "Escape") { e.preventDefault(); setRefPopup(null); return; }
                }
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
                } else if (e.key === "Backspace" && (block._isEmpty || !(block.content || "").trim()) && !(block.quote || "").trim()) {
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
                  urlTransform={(url) => url.startsWith("blockref:") ? url : defaultUrlTransform(url)}
                  components={{
                    a: ({ href, children }) => {
                      if (href?.startsWith("blockref:")) {
                        const refId = href.slice(9);
                        const refBlock = allBlocks?.find((b) => b.id === refId) || refCache?.[refId];
                        return (
                          <a
                            href={`?block=${refId}`}
                            className="blockRefChip"
                            title={refBlock?.page_title ? `From: ${refBlock.page_title}` : undefined}
                            onClick={(e) => {
                              if (e.metaKey || e.ctrlKey) return;
                              e.preventDefault();
                              e.stopPropagation();
                              onBlockRefClick?.(refId);
                            }}
                          >
                            {refBlock?.content || String(children)}
                          </a>
                        );
                      }
                      return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
                    }
                  }}
                >
                  {(block.content || "").replace(/\[\[([a-zA-Z0-9_-]+)\]\]/g, "[$1](blockref:$1)")}
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
        {block._pageId && !block._sourceUrl && !readOnly ? (
          <button
            className="blockDeleteBtn"
            title="Delete note"
            onClick={(e) => { e.stopPropagation(); onDelete(block.id); }}
          >×</button>
        ) : null}
      </div>
      {refPopup && searchResults.length > 0 && (
        <div
          className="refPopup"
          style={{
            position: "fixed",
            top: refPopup.rect.bottom + 4,
            left: refPopup.rect.left,
            zIndex: 2000,
            background: "#1e1e1e",
            border: "1px solid #444",
            borderRadius: 6,
            minWidth: 280,
            maxHeight: 320,
            overflowY: "auto",
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
          }}
        >
          {searchResults.map((b, i) => (
            <div key={b.id} style={{ borderBottom: i < searchResults.length - 1 ? "1px solid #333" : "none" }}>
              {b.ancestors && b.ancestors.length > 0 && (
                <div style={{ padding: "3px 12px 0", fontSize: 11, color: "#777", lineHeight: 1.4 }}>
                  {b.ancestors.map((a, j) => (
                    <span key={a.id}>
                      {j > 0 && <span style={{ color: "#555", margin: "0 3px" }}>&rsaquo;</span>}
                      <span>{a.content || "(untitled)"}</span>
                    </span>
                  ))}
                </div>
              )}
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertRef(b)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "6px 12px",
                  background: i === refSelectedIdx ? "#2a3a4a" : "transparent",
                  color: "#ddd",
                  border: "none",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {b.content || "(empty)"}
                </div>
              </button>
            </div>
          ))}
        </div>
      )}
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
    transform: isDragging ? CSS.Transform.toString(transform) : undefined,
    transition: isDragging ? transition : undefined,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} className="sortableBlockWrap" data-block-id={block.id} data-depth={rowProps.depth || 0}>
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

function BlockTree({ blocks, readOnly, rowProps }) {
  if (!blocks || blocks.length === 0) return null;
  return (
    <>
      {blocks.map((rawBlock) => { const block = withLegacyAccessors(rawBlock); return (
        <React.Fragment key={block.id}>
          {!readOnly ? (
            <SortableBlockRow block={block} depth={0} {...rowProps} />
          ) : (
            <BlockRow block={block} depth={0} {...rowProps} />
          )}
          {!block.collapsed && block.children && block.children.length > 0 ? (
            <div className="blockChildren">
              <BlockTree blocks={block.children} readOnly={readOnly} rowProps={rowProps} />
            </div>
          ) : null}
        </React.Fragment>
      );})}
    </>
  );
}

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const initialUrl = params.get("src") || params.get("url") || "";
  const initialShare = params.get("share") || "";
  const initialBlockId = params.get("block") || params.get("page") || "";
  const readOnly = Boolean(initialShare);

  const [inputUrl, setInputUrl] = useState(initialUrl);
  const [pdfUrl, setPdfUrl] = useState("");
  const [docId, setDocId] = useState("");
  const [focusedBlockId, setFocusedBlockId] = useState("");
  const [focusedBlock, setFocusedBlock] = useState(null);
  const [summary, setSummary] = useState("");
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [blocks, setBlocks] = useState([]);
  const [homeBlocks, setHomeBlocks] = useState([]);
  const [refCache, setRefCache] = useState({}); // { [blockId]: { content, page_title } }
  const [homeEditingId, setHomeEditingId] = useState(null);
  const [status, setStatus] = useState("Ready.");
  const [loading, setLoading] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(420);
  const [sidebarHeight, setSidebarHeight] = useState(280);
  const [orientation, setOrientation] = useState("horizontal");
  const [pdfHidden, setPdfHidden] = useState(false);
  const [pdfScale, setPdfScale] = useState("page-width");
  const pageTitleSaveTimerRef = useRef(null);

  function fetchHomeBlocks() {
    return apiJson(`${API}/blocks/root/children`)
      .then((data) => setHomeBlocks(Array.isArray(data.children) ? data.children : []))
      .catch(() => setHomeBlocks([]));
  }

  useEffect(() => {
    fetchHomeBlocks();
  }, []);
  const pendingJumpRef = useRef(null);
  const dndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    })
  );
  // Phase B2a: drop indicator state
  const [dropTarget, setDropTarget] = useState(null); // { targetId, above, rect }
  const draggingIdRef = useRef(null);
  const [notesVisible, setNotesVisible] = useState(true);
  const [flashingId, setFlashingId] = useState(null);
  const [highlightMenu, setHighlightMenu] = useState(null); // { id, x, y } or null
  const [dragOver, setDragOver] = useState(false);
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
    if (!pendingBlockScrollRef.current || readOnly) return;
    const id = pendingBlockScrollRef.current;
    const row = document.querySelector(`[data-block-id="${id}"]`);
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      setFocusedId(id);
      pendingBlockScrollRef.current = null;
    } else if (flattenBlocks(blocks).some((b) => b.id === id)) {
      // Block exists but is inside a collapsed parent — expand and try again
      setBlocks((prev) => expandToBlock(prev, id));
    } else {
      // Block not in tree yet — keep ref and wait for next blocks change
    }
  }, [blocks, readOnly]);

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

  // left-click on a PDF highlight jumps to its block in the sidebar
  useEffect(() => {
    if (readOnly) return;
    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.pointerType !== "mouse") return;
      if (attachModeBlockIdRef.current) return;
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      for (const el of stack) {
        let cur = el;
        while (cur && cur !== document.body) {
          if (cur.dataset && cur.dataset.highlightId) {
            e.stopPropagation();
            const hlId = cur.dataset.highlightId;
            const block = flattenBlocks(blocksRef.current).find(
              (b) => b.properties?.highlight_id === hlId,
            );
            if (block) {
              const row = document.querySelector(`[data-block-id="${block.id}"]`);
              if (row) {
                row.scrollIntoView({ block: "center", behavior: "smooth" });
                setFocusedId(block.id);
              }
            }
            return;
          }
          cur = cur.parentElement;
        }
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
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
  }, []);

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
      const block = await getOrCreateBlockForDoc(data.doc_id, defaultTitle, sourceUrl);
      const nextBlocks = await loadBlocksForBlock(block.id);
      setDocId(data.doc_id);
      setInputUrl(sourceUrl);
      setFocusedBlockId(block.id);
      setFocusedBlock(block);
      setPdfTitle(block.content || defaultTitle);
      setSummary(block.properties?.summary || "");
      setPdfUrl(sourceUrl);
      const newUrl = `${window.location.pathname}?block=${encodeURIComponent(block.id)}`;
      window.history.replaceState({}, "", newUrl);
      setStatus(`Uploaded ${file.name} (${data.doc_id})`);
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
      const resp = await fetch(`${API}/import/logseq`, { method: "POST", body: form });
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
      // Resolve block + load children FIRST, before setPdfUrl, to avoid mid-render highlight race
      const defaultTitle = getPdfPageTitle(resolvedDocId, finalUrl);
      const block = await getOrCreateBlockForDoc(resolvedDocId, defaultTitle, finalUrl);
      const nextBlocks = await loadBlocksForBlock(block.id);
      setDocId(resolvedDocId);
      setInputUrl(finalUrl);
      setFocusedBlockId(block.id);
      setFocusedBlock(block);
      setPdfTitle(block.content || defaultTitle);
      setSummary(block.properties?.summary || "");
      setPdfUrl(proxiedUrl);
      const newUrl = `${window.location.pathname}?block=${encodeURIComponent(block.id)}`;
      window.history.replaceState({}, "", newUrl);
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
      const src = data.source_url || "";
      const isLocal = src.startsWith("/api/");
      const proxiedUrl = isLocal ? src : src ? `${API}/pdf?source_url=${encodeURIComponent(src)}` : "";

      let block = null;
      try { block = await apiJson(`${API}/blocks/by-doc/${data.doc_id}`); } catch {}

      let childBlocks = [];
      if (block) {
        try {
          const subtreeData = await apiJson(`${API}/blocks/${block.id}/subtree`);
          childBlocks = normalizeBlocks(subtreeData.block?.children || []);
        } catch {}
      }

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

  async function openBlock(blockId) {
    if (!blockId || readOnly) return;
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
      setDocId(props.doc_id || "");

      if (props.source_url) {
        const src = props.source_url;
        const isLocal = src.startsWith("/api/");
        const proxiedUrl = isLocal ? src : `${API}/pdf?source_url=${encodeURIComponent(src)}`;
        setInputUrl(src);
        setPdfUrl(proxiedUrl);
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

      const newUrl = `${window.location.pathname}?block=${encodeURIComponent(blockId)}`;
      window.history.replaceState({}, "", newUrl);
      setStatus("Ready.");
    } catch (err) {
      setStatus(`Open failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function saveSummary(newValue) {
    if (!focusedBlockId || readOnly) return;
    try {
      await apiJson(`${API}/blocks/${focusedBlockId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { summary: newValue || "" } }),
      });
    } catch (err) {
      setStatus(`Summary save failed: ${err.message}`);
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
      _isRecent: recentIds.has(b.id),
      _isEmpty: !b.content,
      editMode: homeEditingId === b.id,
    }));
  }, [homeBlocks, recentIds, homeEditingId]);
  const highlights = useMemo(() => blocksToHighlights(blocks), [blocks]);
  useEffect(() => {
    if (pdfHidden) return;
    const id = pendingJumpRef.current;
    if (!id) return;
    setTimeout(() => {
      let scrollTarget = (highlights || []).find((x) => x.id === id);
      if (!scrollTarget) {
        const b = flattenBlocks(blocks).find((b) => b.properties?.highlight_id === id);
        const linkedId = b?.properties?.linked_highlight_id;
        if (linkedId) scrollTarget = (highlights || []).find((x) => x.id === linkedId);
      }
      if (scrollTarget && scrollToRef.current) {
        scrollToRef.current({ position: scrollTarget.position });
      }
      pendingJumpRef.current = null;
    }, 100);
  }, [pdfHidden, highlights]);

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
            {pdfUrl && pdfHidden ? (
              <button
                className="pdfShowBtn"
                onClick={() => setPdfHidden(false)}
                title="Show PDF"
              >Show PDF</button>
            ) : null}
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
            <label
              className="importLogseqBtn"
              title="Import Logseq PDF highlights (.pdf + .edn)"
              style={{ cursor: loading ? "not-allowed" : "pointer" }}
            >
              Import Logseq
              <input
                type="file"
                multiple
                accept=".pdf,.edn,.md"
                style={{ display: "none" }}
                disabled={loading}
                onChange={(e) => { importLogseq(e.target.files); e.target.value = ""; }}
              />
            </label>
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
          {pdfUrl && pdfHidden ? (
            <button
              className="pdfShowBtn"
              onClick={() => setPdfHidden(false)}
              title="Show PDF"
            >Show PDF</button>
          ) : null}
          <button
            className="notesBtn"
            onClick={() => setNotesVisible((v) => !v)}
            title={notesVisible ? "Hide notes" : "Show notes"}
          >
            {notesVisible ? "Hide notes" : "Show notes"}
          </button>
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

      <div className={`main ${(pdfHidden || homeMode || pageOnly) ? "pdfHidden" : ""}`}>
        <div className={`viewerWrap ${(pdfHidden || homeMode || pageOnly) ? "pdfHidden" : ""}`}>
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
              <button onClick={() => setPdfScale((s) => { const n = parseFloat(s); return isNaN(n) ? "0.8" : String(Math.max(0.4, +(n - 0.2).toFixed(1))); })} title="Zoom out">−</button>
              <span className="pdfZoomLevel">{isNaN(parseFloat(pdfScale)) ? "Width" : `${Math.round(parseFloat(pdfScale) * 100)}%`}</span>
              <button onClick={() => setPdfScale((s) => { const n = parseFloat(s); return isNaN(n) ? "1.2" : String(Math.min(4, +(n + 0.2).toFixed(1))); })} title="Zoom in">+</button>
              <button className="pdfFitWidthBtn" onClick={() => setPdfScale("page-width")} title="Fit to width">Width</button>
            </div>
          ) : null}
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
                  pdfScaleValue={pdfScale}
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
                      className={`colorWrap${flashingId === highlight.id ? " flashWrap" : ""}${attachModeBlockId ? " attachModeTarget" : ""}`}
                      style={{ "--highlight-color": highlight.color || COLORS[0] }}
                      onClick={attachModeBlockId ? (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setAttachContextMenu({ x: e.clientX, y: e.clientY, highlight });
                      } : undefined}
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
          {!homeMode && <div className="pageTitleRow">
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

          </div>}

          {inputUrl ? (
            <div className="pageHeaderMeta">
              <div className="pageHeaderLabel">Source PDF</div>
              <div className="pageHeaderUrl">{inputUrl}</div>
            </div>
          ) : null}

          <div className="blockList">
            {focusedBlockId && !readOnly && !homeMode ? (
              <div className="summaryFrontmatter">
                <span className="summaryFrontmatterLabel">summary::</span>
                {summaryEditing ? (
                  <textarea
                    className="summaryFrontmatterInput"
                    value={summary}
                    onChange={(e) => {
                      setSummary(e.target.value);
                      // Auto-grow to fit content
                      e.target.style.height = "auto";
                      e.target.style.height = e.target.scrollHeight + "px";
                    }}
                    onBlur={() => {
                      setSummaryEditing(false);
                      saveSummary(summary);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        setSummaryEditing(false);
                        saveSummary(summary);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setSummaryEditing(false);
                        // Restore last-saved value? For simplicity, commit current value.
                        saveSummary(summary);
                      }
                    }}
                    ref={(el) => {
                      // Autosize when mounted with pre-existing content
                      if (el) {
                        el.style.height = "auto";
                        el.style.height = el.scrollHeight + "px";
                      }
                    }}
                    autoFocus
                    rows={1}
                    placeholder="Add a summary..."
                  />
                ) : (
                  <span
                    className={`summaryFrontmatterValue ${summary ? "" : "empty"}`}
                    onClick={() => setSummaryEditing(true)}
                    title="Click to edit"
                  >
                    {summary || "Add a summary..."}
                  </span>
                )}
              </div>
            ) : null}
            {homeMode && recentPages.length > 0 ? (
              <div className="recentPagesRow">
                <div className="recentPagesLabel">Recent</div>
                <div className="recentPagesGrid">
                  {recentPages.map((b) => (
                    <button
                      key={b.id}
                      className="recentCard"
                      onClick={() => openBlock(b.id)}
                      title={b.content}
                    >
                      <div className="recentCardTitle">{b.content || "Untitled"}</div>
                      <div className="recentCardMeta">
                        {b.properties?.summary && <span className="recentCardSummary">{b.properties.summary}</span>}
                        <span className="recentCardTime">{formatRelativeTime(b.updated_at)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {(homeMode ? pageBlocks : visibleBlocks).length === 0 ? (
              <div className="empty">{homeMode ? "No pages yet — open a PDF above to get started." : "No blocks yet."}</div>
            ) : (
              (() => {
                const rowProps = {
                  focusedId,
                  setFocusedId,
                  onJump: jumpToHighlightId,
                  onEnterAttachMode: readOnly ? null : setAttachModeBlockId,
                  onUnlinkHighlight: readOnly ? null : unlinkHighlightFromBlock,
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
                      setBlocks((prev) => expandToBlock(prev, id));
                      // Wait for React to render expanded ancestors, then scroll
                      await new Promise((r) => setTimeout(r, 0));
                      const row = document.querySelector(`[data-block-id="${id}"]`);
                      if (row) {
                        row.scrollIntoView({ block: "center", behavior: "smooth" });
                      }
                      setFocusedId(id);
                    } else {
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
                      apiJson(`${API}/blocks/${id}`, { method: "DELETE" })
                        .then(() => fetchHomeBlocks())
                        .catch((err) => setStatus(`Delete failed: ${err}`));
                      return;
                    }
                    setBlocks(removeBlockTree(blocks, id));
                  },
                };
                const rootIds = (blocks || []).map((b) => b.id);
                const allIds = homeMode ? pageBlocks.map((b) => b.id) : flattenBlocks(blocks).map((b) => b.id);
                return (
                  <DndContext
                    sensors={dndSensors}
                    collisionDetection={closestCenter}
                    onDragStart={(e) => {
                      draggingIdRef.current = e.active.id;
                    }}
                    onDragMove={(e) => {
                      if (!e.active) return;
                      const activatorRect = e.activatorEvent && typeof e.activatorEvent.clientY === "number"
                        ? { x: e.activatorEvent.clientX, y: e.activatorEvent.clientY }
                        : null;
                      if (!activatorRect) return;
                      const pointerX = activatorRect.x + (e.delta?.x || 0);
                      const pointerY = activatorRect.y + (e.delta?.y || 0);
                      const rows = document.querySelectorAll(".sortableBlockWrap[data-block-id]");
                      let best = null;
                      for (const row of rows) {
                        const id = row.getAttribute("data-block-id");
                        if (!id || id === draggingIdRef.current) continue;
                        const r = row.getBoundingClientRect();
                        if (pointerY >= r.top && pointerY <= r.bottom) {
                          const above = pointerY < r.top + r.height / 2;
                          const targetDepth = parseInt(row.getAttribute("data-depth") || "0", 10);
                          // Valid depth range: 0 to targetDepth + 1 (allow nesting one deeper)
                          // Snap pointer X to nearest valid depth relative to the row's left edge
                          const indentStep = 14;
                          const baseLeft = r.left; // row's left edge in viewport coords
                          const rawDepth = Math.round((pointerX - baseLeft - 28) / indentStep);
                          const depth = Math.max(0, Math.min(targetDepth + 1, targetDepth + rawDepth - targetDepth));
                          // Simpler: clamp rawDepth directly between 0 and targetDepth + 1
                          const clampedDepth = Math.max(0, Math.min(targetDepth + 1, rawDepth));
                          best = {
                            targetId: id,
                            above,
                            depth: clampedDepth,
                            rect: { top: r.top, left: r.left, width: r.width, bottom: r.bottom },
                          };
                          break;
                        }
                      }
                      setDropTarget(best);
                    }}
                    onDragCancel={() => {
                      setDropTarget(null);
                      draggingIdRef.current = null;
                    }}
                    onDragEnd={(e) => {
                      const dt = dropTarget;
                      setDropTarget(null);
                      draggingIdRef.current = null;
                      if (readOnly) return;
                      const { active } = e;
                      if (!active || !dt) return;
                      // Home mode: reorder pages via the API, not the local tree
                      if (homeMode) {
                        const sourceIdx = pageBlocks.findIndex((b) => b.id === active.id);
                        const targetIdx = pageBlocks.findIndex((b) => b.id === dt.targetId);
                        if (sourceIdx < 0 || targetIdx < 0 || sourceIdx === targetIdx) return;
                        const remaining = pageBlocks.filter((_, i) => i !== sourceIdx);
                        const adjustedTargetIdx = targetIdx > sourceIdx ? targetIdx - 1 : targetIdx;
                        const dropIdx = dt.above ? adjustedTargetIdx : adjustedTargetIdx + 1;
                        const before = remaining[dropIdx - 1]?._position ?? null;
                        const after = remaining[dropIdx]?._position ?? null;
                        const sourceBlock = pageBlocks[sourceIdx];
                        const pageId = sourceBlock._pageId;
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
                      const sourceId = active.id;
                      const { targetId, above, depth } = dt;
                      if (sourceId === targetId) return;
                      if (isDescendant(blocks, sourceId, targetId)) return;
                      const extracted = extractBlock(blocks, sourceId);
                      if (!extracted) return;
                      const { extracted: sourceBlock, remaining } = extracted;
                      const targetCtx = findBlockContext(remaining, targetId);
                      if (!targetCtx) return;
                      const targetDepth = targetCtx.depth;
                      let next;
                      if (depth === targetDepth + 1) {
                        next = insertChild(remaining, targetId, sourceBlock, false);
                      } else if (depth === targetDepth) {
                        next = insertSibling(remaining, targetId, sourceBlock, !above);
                      } else if (depth < targetDepth) {
                        const ancestorId = targetCtx.ancestors[depth];
                        if (!ancestorId) return;
                        next = insertSibling(remaining, ancestorId, sourceBlock, !above);
                      } else {
                        return;
                      }
                      if (next) setBlocks(next);
                    }}
                  >
                    <SortableContext items={allIds} strategy={verticalListSortingStrategy}>
                      <BlockTree blocks={homeMode ? pageBlocks : blocks} readOnly={readOnly} rowProps={rowProps} />
                    </SortableContext>
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
            <div style={{ padding: "6px 10px 4px", borderBottom: "1px solid #444", display: "flex", gap: 6 }}>
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    changeHighlightColor(highlightMenu.id, c);
                    setHighlightMenu(null);
                  }}
                  title="Change color"
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    background: c,
                    border: "2px solid #555",
                    cursor: "pointer",
                    padding: 0,
                    flexShrink: 0
                  }}
                />
              ))}
            </div>
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
