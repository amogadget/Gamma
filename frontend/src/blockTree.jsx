// The Logseq-style outliner: block rows (markdown rendering, inline
// editing, [[refs]], link chips, image drop), drag handles, and the tree.
import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import { withLegacyAccessors } from "./logseqPdfModel";
import { COLORS } from "./pdfViewer";
import { AutoGrowTextarea } from "./widgets";

// Module-level ref for native HTML5 drag-and-drop (shared with App's drop handlers)
const _dragState = { draggingId: null, dropTarget: null };

function BlockRow({
  block,
  depth,
  focusedId,
  setFocusedId,
  onJump,
  onEnterAttachMode,
  onUnlinkHighlight,
  onOpenLinkTarget,
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
  homeMode,
  onBlockDragOver,
  onBlockDragLeave,
  onBlockDrop,
}) {
  const ref = useRef(null);
  const clickPosRef = useRef(null);
  const [refPopup, setRefPopup] = useState(null); // { query, rect }
  const [refSelectedIdx, setRefSelectedIdx] = useState(0);
  const [searchResults, setSearchResults] = useState([]);
  const [imageDragOver, setImageDragOver] = useState(false);
  const uploadingRef = useRef(false);

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

  function handleImageDragOver(e) {
    if (!e.dataTransfer?.types || !Array.from(e.dataTransfer.types).includes("Files")) return;
    if (!e.dataTransfer?.items) return;
    const hasImage = Array.from(e.dataTransfer.items).some((item) => item.type?.startsWith("image/"));
    if (!hasImage) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setImageDragOver(true);
  }

  function handleImageDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) setImageDragOver(false);
  }

  async function handleImageDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setImageDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload-image", { method: "POST", body: form, credentials: "include" });
      if (!res.ok) { uploadingRef.current = false; return; }
      const data = await res.json();
      onChangeText(block.id, (block.content || "") + "\n" + `![](${data.url})`);
    } finally { uploadingRef.current = false; }
  }

  return (
    <div className={`blockRowWrap${imageDragOver ? " imageDragOver" : ""}`} data-block-id={block.id}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer?.types || []).includes("Files")) {
          handleImageDragOver(e);
          return;
        }
        onBlockDragOver?.(e, block);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        handleImageDragLeave(e);
        onBlockDragLeave?.();
      }}
      onDrop={(e) => {
        if (Array.from(e.dataTransfer?.types || []).includes("Files")) {
          handleImageDrop(e);
          return;
        }
        onBlockDrop?.(e, block);
      }}
    >
      <div
        className={`blockRow ${focusedId === block.id ? "focused" : ""}`}
        onMouseDown={(e) => {
          if (e.target.closest("button, textarea, input, a")) return;
          setFocusedId(block.id);
          // Clicking anywhere on a highlight's card jumps the PDF to it —
          // not just the little colored dot.
          if (block.highlightId) onJump?.(block.highlightId);
          // Home page cards work the same way: click anywhere opens the page
          // (rename from inside the page instead).
          if (homeMode && block._pageId && typeof onPageOpen === "function" && !block.editMode) {
            e.preventDefault();
            onPageOpen(block);
            return;
          }
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
                  rehypePlugins={[rehypeRaw, rehypeKatex]}
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
                  {(block.content || "")
                    .replace(/!\[([^\]]*)\]\(([^)]+)\)\{:width\s+(\d+)\}/g, '<img src="$2" alt="$1" width="$3" />')
                    .replace(/\[\[([a-zA-Z0-9_-]+)\]\]/g, "[$1](blockref:$1)")}
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
          {(block.properties?.link_url || block.properties?.link_page_id) ? (
            <button
              type="button"
              className="blockLinkChip"
              title={block.properties.link_url || "Open linked paper"}
              onClick={(e) => { e.stopPropagation(); onOpenLinkTarget?.(block); }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
              {block.properties.link_page_id
                ? "linked paper"
                : (block.properties.link_url || "").replace(/^https?:\/\//i, "").slice(0, 48)}
            </button>
          ) : null}
        </div>
        {!readOnly && block.id !== "root" ? (
          <button
            className="blockDeleteBtn"
            title="Delete block"
            onClick={(e) => { e.stopPropagation(); onDelete(block.id); }}
          >×</button>
        ) : null}
      </div>
      {refPopup && searchResults.length > 0 && (
        <div
          className="refPopup"
          style={{ top: refPopup.rect.bottom + 4, left: refPopup.rect.left }}
        >
          {searchResults.map((b, i) => (
            <div key={b.id} className="refPopupEntry">
              {b.ancestors && b.ancestors.length > 0 && (
                <div className="refPopupPath">
                  {b.ancestors.map((a, j) => (
                    <span key={a.id}>
                      {j > 0 && <span className="refPopupSep">&rsaquo;</span>}
                      <span>{a.content || "(untitled)"}</span>
                    </span>
                  ))}
                </div>
              )}
              <button
                className={`refPopupItem${i === refSelectedIdx ? " selected" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertRef(b)}
              >
                <div className="refPopupText">{b.content || "(empty)"}</div>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SortableBlockRow({ block, ...rowProps }) {
  const depth = rowProps.depth || 0;

  function onDragStart(e) {
    e.dataTransfer.setData("text/plain", block.id);
    e.dataTransfer.effectAllowed = "move";
    _dragState.draggingId = block.id;
  }

  function onDragEnd() {
    _dragState.draggingId = null;
    _dragState.dropTarget = null;
    window._gammaSetDropTarget?.(null);
  }

  return (
    <div className="sortableBlockWrap" data-block-id={block.id} data-depth={depth}>
      <span
        className="dragHandle"
        draggable="true"
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        aria-label="Drag to reorder"
        title="Drag to reorder"
      >⋮⋮</span>
      <BlockRow block={block} {...rowProps} />
    </div>
  );
}

function BlockTree({ blocks, readOnly, rowProps, depth = 0 }) {
  if (!blocks || blocks.length === 0) return null;
  return (
    <>
      {blocks.map((rawBlock) => { const block = withLegacyAccessors(rawBlock); return (
        <React.Fragment key={block.id}>
          {!readOnly ? (
            <SortableBlockRow block={block} depth={depth} {...rowProps} />
          ) : (
            <BlockRow block={block} depth={depth} {...rowProps} />
          )}
          {!block.collapsed && block.children && block.children.length > 0 ? (
            <div className="blockChildren">
              <BlockTree blocks={block.children} readOnly={readOnly} rowProps={rowProps} depth={depth + 1} />
            </div>
          ) : null}
        </React.Fragment>
      );})}
    </>
  );
}

export { BlockTree, _dragState };
