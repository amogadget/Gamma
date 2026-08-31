// The Logseq-style outliner: block rows (markdown rendering, inline
// editing, [[refs]], link chips, image drop/paste), drag handles, and the tree.
import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import { withLegacyAccessors } from "./logseqPdfModel";
import { COLORS } from "./pdfViewer";
import { handleMarkdownCopy } from "./widgets";
import { isEnterCommit } from "./utils";
import { FolderIcon, LinkIcon } from "./icons";
import {
  findMathAtCursor,
  insertionFor,
  latexCompletions,
  LatexAcPopup,
  MathLivePreview,
} from "./latexEditor";
import { BlockCmEditor } from "./blockCmEditor";
import { remarkCallouts } from "./callouts";
import { filterSlashCommands } from "./slashCommands";
import { SlashMenuPopup } from "./slashMenu";

// Module-level ref for native HTML5 drag-and-drop (shared with App's drop handlers)
const _dragState = { draggingId: null, dropTarget: null };

function rehypeTaskIndexes() {
  return function indexTasks(tree) {
    let idx = 0;
    function walk(node) {
      if (node.type === "element" && node.tagName === "input" && node.properties?.type === "checkbox") {
        node.properties["data-task-index"] = String(idx++);
      }
      for (const child of node.children || []) walk(child);
    }
    walk(tree);
  };
}

// A block's rendered markdown, memoized: any edit re-renders the whole tree
// (setBlocks replaces it), and without the memo one keystroke re-ran
// ReactMarkdown + KaTeX for every rendered block on the page. Re-parses only
// when the content or a resolved [[ref]] chip label actually changes; ref
// labels are resolved by the caller so the comparison here stays a string
// check. onBlockRefClick is deliberately excluded from the comparison — the
// caller passes an identity-stable wrapper.
const BlockMarkdown = React.memo(
  function BlockMarkdown({ content, refLabels, onBlockRefClick, onTaskToggle }) {
    return (
      <ReactMarkdown
        // remark-breaks: a single Enter inside a note renders as a real line
        // break (the editor lets you type them), not markdown's soft-break space.
        remarkPlugins={[remarkGfm, remarkMath, remarkCallouts, remarkBreaks]}
        rehypePlugins={[rehypeTaskIndexes, rehypeRaw, rehypeKatex]}
        urlTransform={(url) => (url.startsWith("blockref:") ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith("blockref:")) {
              const refId = href.slice(9);
              const ref = refLabels?.[refId];
              return (
                <a
                  href={`?block=${refId}`}
                  className="blockRefChip"
                  title={ref?.page_title ? `From: ${ref.page_title}` : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onBlockRefClick?.(refId);
                  }}
                >
                  {ref?.content || String(children)}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          input: ({ type, checked, ...props }) => {
            if (type !== "checkbox") return <input type={type} {...props} />;
            const idx = Number(props["data-task-index"] ?? props.dataTaskIndex);
            return (
              <input
                type="checkbox"
                className="mdTaskCheckbox"
                checked={!!checked}
                disabled={!onTaskToggle}
                onChange={() => {}}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (Number.isInteger(idx)) onTaskToggle?.(idx, !checked);
                }}
              />
            );
          },
        }}
      >
        {content
          .replace(
            /!\[([^\]]*)\]\(([^)]+)\)\{:width\s+(\d+)\}/g,
            '<img src="$2" alt="$1" width="$3" />',
          )
          .replace(/\[\[([a-zA-Z0-9_-]+)\]\]/g, "[$1](blockref:$1)")}
      </ReactMarkdown>
    );
  },
  (prev, next) =>
    prev.content === next.content &&
    !!prev.onTaskToggle === !!next.onTaskToggle &&
    Object.keys(prev.refLabels).length === Object.keys(next.refLabels).length &&
    Object.entries(next.refLabels).every(
      ([id, r]) =>
        prev.refLabels[id]?.content === r.content &&
        prev.refLabels[id]?.page_title === r.page_title,
    ),
);

// Area-highlight crops shown on note cards. Nothing is stored with the block —
// the region is re-cropped from the loaded document (App's pdfCaptureRef) and
// cached here per session, keyed by the rect, so scrolling the notes doesn't
// re-render the same crop and an edited rect gets a fresh one.
const _areaSnapCache = new Map();
function AreaSnapshot({ block, captureArea, docNonce }) {
  const r = block.position?.boundingRect;
  const key = `${block.highlightId}:${r?.pageNumber}:${r?.x1},${r?.y1},${r?.x2},${r?.y2}`;
  const [src, setSrc] = useState(() => _areaSnapCache.get(key) || null);
  useEffect(() => {
    const cached = _areaSnapCache.get(key);
    if (cached) {
      setSrc(cached);
      return;
    }
    setSrc(null);
    let cancelled = false;
    // docNonce re-runs this once the PDF finishes loading — the first attempt
    // can land before the viewer has a document and resolve to null.
    Promise.resolve(captureArea?.(block))
      .then((img) => {
        if (cancelled || !img) return;
        _areaSnapCache.set(key, img);
        while (_areaSnapCache.size > 60) _areaSnapCache.delete(_areaSnapCache.keys().next().value);
        setSrc(img);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // `block` is captured via `key` (id+position), not object identity — the
    // block object changes every render, but the crop only changes with key/doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, captureArea, docNonce]);
  // Reserve the crop's aspect ratio while it renders so the card doesn't jump.
  const ratio = r && r.y2 > r.y1 ? (r.x2 - r.x1) / (r.y2 - r.y1) : null;
  return src ? (
    <img
      className="blockAreaSnap"
      src={src}
      alt="Area selection"
      draggable={false}
      style={{ borderLeftColor: block.color || undefined }}
    />
  ) : (
    <div
      className="blockAreaSnap blockAreaSnapPending"
      style={{ aspectRatio: ratio || undefined, borderLeftColor: block.color || undefined }}
    />
  );
}

function BlockRow({
  block,
  _depth,
  focusedId,
  setFocusedId,
  onJump,
  onEnterAttachMode,
  onUnlinkHighlight,
  onOpenLinkTarget,
  onPageOpen,
  onPageContext,
  selectedPageIds,
  onChangeText,
  onEnterSibling,
  enterNewNote,
  _onAddChild,
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
  captureArea,
  docNonce,
}) {
  const ref = useRef(null);
  const clickPosRef = useRef(null);
  // Identity-stable wrapper so the memoized BlockMarkdown never sees a fresh
  // callback (rowProps closures are rebuilt every App render) yet always
  // calls the latest one — same idiom as pdfViewer's stableCbs.
  const refClickRef = useRef(null);
  refClickRef.current = onBlockRefClick;
  const stableRefClick = useRef((id) => refClickRef.current?.(id)).current;
  // Flip the nth GFM task marker. The boundary after `]` mirrors GFM so a
  // malformed `- [x]no-space` cannot shift every later checkbox's index.
  const taskToggleRef = useRef(null);
  taskToggleRef.current = (idx, checked) => {
    let current = -1;
    const newValue = (block.content || "").replace(
      /(^|\n)([ \t]*(?:[-*+]|\d+\.)[ \t]+\[)([ xX])(\])(?=\s|$)/g,
      (match, lineStart, prefix, _mark, suffix) => {
        current += 1;
        return current === idx
          ? lineStart + prefix + (checked ? "x" : " ") + suffix
          : match;
      },
    );
    if (newValue !== block.content) onChangeText(block.id, newValue);
  };
  const stableTaskToggle = useRef(
    (idx, checked) => taskToggleRef.current?.(idx, checked),
  ).current;
  // Resolve [[ref]] chip labels here (cheap per render) so BlockMarkdown's
  // memo can compare them as strings instead of depending on allBlocks,
  // whose identity changes on every edit.
  const refLabels = useMemo(() => {
    const out = {};
    for (const [, id] of (block.content || "").matchAll(/\[\[([a-zA-Z0-9_-]+)\]\]/g)) {
      const rb = allBlocks?.find((b) => b.id === id) || refCache?.[id];
      if (rb) out[id] = { content: rb.content, page_title: rb.page_title };
    }
    return out;
  }, [block.content, allBlocks, refCache]);
  const [refPopup, setRefPopup] = useState(null); // { query, rect }
  const [refSelectedIdx, setRefSelectedIdx] = useState(0);
  // Live LaTeX aids while the caret sits inside $...$ / $$...$$:
  // { tex, display, anchor, ac: { start, items } | null }. Recomputed on every
  // edit AND caret move (onSelect) — the preview must track the caret.
  const [mathUi, setMathUi] = useState(null);
  const [mathAcIdx, setMathAcIdx] = useState(0);
  const [slashMenu, setSlashMenu] = useState(null); // {start, items, anchor}
  const [slashIdx, setSlashIdx] = useState(0);
  const [searchResults, setSearchResults] = useState([]);
  const [imageDragOver, setImageDragOver] = useState(false);
  const uploadingRef = useRef(false);

  useEffect(() => {
    if (!refPopup) {
      setSearchResults([]);
      return;
    }
    const q = refPopup.query;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/block-search?q=${encodeURIComponent(q)}&limit=8`);
        const data = await res.json();
        setSearchResults((data.blocks || []).filter((b) => b.id !== block.id));
      } catch (_) {
        setSearchResults([]);
      }
    }, 120);
    return () => clearTimeout(timer);
    // refPopup is a prop object; query text + block id are the intended trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refPopup?.query, block.id]);

  // Resolve cross-note refs found in content
  useEffect(() => {
    if (!block.content || !onFetchRefs) return;
    const ids = [...block.content.matchAll(/\[\[([a-zA-Z0-9_-]+)\]\]/g)].map((m) => m[1]);
    const unknown = ids.filter((id) => !allBlocks?.find((b) => b.id === id) && !refCache?.[id]);
    if (unknown.length > 0) onFetchRefs(unknown);
    // allBlocks/refCache are read as caches and onFetchRefs is an unstable
    // prop; block.content is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  function updateMathUi(ta, typing) {
    const cursor = ta.selectionStart;
    if (cursor !== ta.selectionEnd) {
      setMathUi(null);
      return;
    }
    const seg = findMathAtCursor(ta.value, cursor);
    if (!seg) {
      setMathUi(null);
      return;
    }
    // \command autocomplete: a backslash-word ending at the caret, only
    // inside math (a bare "\" in prose — file paths — must not trigger it),
    // and only opened by TYPING — clicking into an existing formula must not
    // pop the menu. Caret moves (typing=false) keep an already-open popup
    // only while the caret stays on the same trigger; React fires onSelect
    // right after onChange for a keystroke, so this must not wipe it.
    const m = ta.value.slice(seg.start, cursor).match(/\\([a-zA-Z]+)$/);
    const next = {
      tex: ta.value.slice(seg.start, seg.end),
      display: seg.display,
      anchor: ta.caretCoords(cursor),
      ac: null,
    };
    setMathUi((prev) => {
      const start = m ? cursor - m[0].length : -1;
      if (m && (typing || prev?.ac?.start === start)) {
        const items = latexCompletions(m[1]);
        if (items.length) next.ac = { start, items };
      }
      return next;
    });
    if (typing) setMathAcIdx(0);
  }

  function acceptLatexAc(c) {
    const ta = ref.current;
    if (!ta || !mathUi?.ac) return;
    const { start } = mathUi.ac;
    const { text, caret } = insertionFor(c);
    const newVal = ta.value.slice(0, start) + text + ta.value.slice(ta.selectionStart);
    onChangeText(block.id, newVal);
    setMathUi(null);
    requestAnimationFrame(() => {
      try {
        ta.setSelectionRange(start + caret, start + caret);
      } catch (_) {}
      ta.focus();
      updateMathUi(ta);
    });
  }

  function updateSlashMenu(ta, typing) {
    const cursor = ta.selectionStart;
    if (cursor !== ta.selectionEnd) {
      setSlashMenu(null);
      return;
    }
    const match = ta.value.slice(0, cursor).match(/(?:^|\s)\/([a-zA-Z0-9-]*)$/);
    if (!match || findMathAtCursor(ta.value, cursor)) {
      setSlashMenu(null);
      return;
    }
    const start = cursor - match[1].length - 1;
    const items = filterSlashCommands(match[1]);
    if (!items.length) {
      setSlashMenu(null);
      return;
    }
    const anchor = ta.caretCoords(start);
    setSlashMenu((previous) => {
      if (!typing && previous?.start !== start) return null;
      return { start, items, anchor };
    });
    if (typing) setSlashIdx(0);
  }

  function runSlashCommand(command) {
    const ta = ref.current;
    if (!ta || !slashMenu) return;
    const start = slashMenu.start;
    const value = ta.value;
    const cursor = ta.selectionStart;
    setSlashMenu(null);
    command.run({
      value,
      start,
      cursor,
      setText: (newValue, selectionStart, selectionEnd) => {
        onChangeText(block.id, newValue);
        requestAnimationFrame(() => {
          try {
            ta.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
          } catch (_) {}
          ta.focus();
          updateMathUi(ta, false);
        });
      },
      openRefPopup: () => {
        requestAnimationFrame(() => {
          setRefPopup({ query: "", rect: ta.getBoundingClientRect() });
          setRefSelectedIdx(0);
        });
      },
      pickImage: () => {
        // The native file dialog may blur/unmount this editor. Capture source
        // now and apply the eventual URL without consulting a stale CM view.
        const base = value.slice(0, start) + value.slice(cursor);
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = async () => {
          const url = await uploadImage(input.files?.[0]);
          if (url) onChangeText(block.id, (base ? `${base}\n` : "") + `![](${url})`);
        };
        input.click();
      },
    });
  }

  useEffect(() => {
    registerRef(block.id, ref);
  }, [block.id, registerRef]);

  // CodeMirror maps the captured row click to a document position on mount.
  // Clear it after edit mode commits so later renders cannot reuse stale coordinates.
  useEffect(() => {
    if (block.editMode) clickPosRef.current = null;
  }, [block.editMode]);

  const isHighlight = !!block.highlightId;
  const hasChildren = (block.children?.length || 0) > 0;

  function handleImageDragOver(e) {
    if (readOnly) return;
    if (!e.dataTransfer?.types || !Array.from(e.dataTransfer.types).includes("Files")) return;
    if (!e.dataTransfer?.items) return;
    const hasImage = Array.from(e.dataTransfer.items).some((item) =>
      item.type?.startsWith("image/"),
    );
    if (!hasImage) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setImageDragOver(true);
  }

  function handleImageDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) setImageDragOver(false);
  }

  async function uploadImage(file) {
    if (!file || !file.type.startsWith("image/")) return null;
    if (uploadingRef.current) return null;
    uploadingRef.current = true;
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload-image", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) return null;
      return (await res.json()).url;
    } catch (_) {
      return null;
    } finally {
      uploadingRef.current = false;
    }
  }

  async function handleImageDrop(e) {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    setImageDragOver(false);
    const url = await uploadImage(e.dataTransfer.files?.[0]);
    if (url) onChangeText(block.id, (block.content || "") + "\n" + `![](${url})`);
  }

  // Paste an image (screenshot) while editing → upload it and insert the
  // markdown at the cursor. Text pastes fall through to the browser default.
  async function handleEditorPaste(e) {
    if (readOnly) return;
    const file = Array.from(e.clipboardData?.items || [])
      .find((it) => it.type?.startsWith("image/"))
      ?.getAsFile();
    if (!file) return;
    e.preventDefault();
    const ta = ref.current;
    // Capture the cursor now — the upload takes a beat and focus may move.
    const start = ta ? ta.selectionStart : null;
    const end = ta ? ta.selectionEnd : null;
    const url = await uploadImage(file);
    if (!url) return;
    const md = `![](${url})`;
    const val = (ta ? ta.value : block.content) || "";
    if (start != null) {
      onChangeText(block.id, val.slice(0, start) + md + val.slice(end));
      requestAnimationFrame(() => {
        try {
          ta.setSelectionRange(start + md.length, start + md.length);
        } catch (_) {}
      });
    } else {
      onChangeText(block.id, val + "\n" + md);
    }
  }

  return (
    <div
      className={`blockRowWrap${imageDragOver ? " imageDragOver" : ""}`}
      data-block-id={block.id}
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
        className={`blockRow ${focusedId === block.id ? "focused" : ""} ${homeMode && selectedPageIds?.has(block._pageId) ? "pageSelected" : ""}`}
        onContextMenu={
          homeMode && block._pageId && onPageContext
            ? (e) => {
                e.preventDefault();
                onPageContext(block, e);
              }
            : undefined
        }
        onMouseDown={(e) => {
          if (e.button !== 0) return; // right-click is the context menu's
          if (e.target.closest("button, textarea, input, a, .cm-editor")) return;
          setFocusedId(block.id);
          // Clicking anywhere on a highlight's card jumps the PDF to it —
          // not just the little colored dot. Ctrl+click appends the quote to
          // the chat selection, same as clicking the highlight on the PDF.
          if (block.highlightId) onJump?.(block.highlightId, e.ctrlKey || e.metaKey);
          // Home page cards open on CLICK, not mousedown — mousedown may be
          // the start of a drag onto a folder, and navigating away mid-drag
          // would unmount the drop target.
          if (homeMode && block._pageId) {
            e.preventDefault();
            return;
          }
          if (!readOnly && !block.editMode) {
            clickPosRef.current = { x: e.clientX, y: e.clientY };
            e.preventDefault();
            onStartEdit(block.id, true);
          }
        }}
        onClick={
          homeMode && block._pageId && typeof onPageOpen === "function"
            ? (e) => {
                if (e.target.closest("button, textarea, input, a, .cm-editor")) return;
                if (!block.editMode) onPageOpen(block, e);
              }
            : undefined
        }
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
              onClick={(e) => {
                e.stopPropagation();
                onJump(block.highlightId, e.ctrlKey || e.metaKey);
              }}
              title={
                block.position
                  ? "Jump to highlight"
                  : block.properties?.linked_highlight_id
                    ? "Jump to linked highlight"
                    : "Jump to page (no exact position)"
              }
            >
              <span
                className="highlightDot"
                style={{
                  background: block.position
                    ? block.color || COLORS[0]
                    : block.properties?.linked_highlight_id
                      ? highlightColors?.[block.properties.linked_highlight_id] || COLORS[0]
                      : "rgba(140,140,140,0.5)",
                }}
              />
            </button>
            {!block.position && block.properties?.linked_highlight_id && onUnlinkHighlight ? (
              <button
                className="collapseBtn attachModeBtn"
                title="Unlink highlight"
                onClick={(e) => {
                  e.stopPropagation();
                  onUnlinkHighlight(block.id);
                }}
              >
                ⊘
              </button>
            ) : null}
            {!block.position && !block.properties?.linked_highlight_id && onEnterAttachMode ? (
              <button
                className="collapseBtn attachModeBtn"
                title="Attach to a PDF highlight"
                onClick={(e) => {
                  e.stopPropagation();
                  onEnterAttachMode(block.id);
                }}
              >
                ⊕
              </button>
            ) : null}
          </>
        ) : block._pageId && typeof onPageOpen === "function" ? (
          <button
            className="collapseBtn dotSlot pageBulletBtn"
            onClick={(e) => {
              e.stopPropagation();
              onPageOpen(block);
            }}
            title="Open page"
          >
            <span className="pageBulletDot" />
          </button>
        ) : (
          <span className="dotSlot dotSlotEmpty"><span className="noteBulletDot" /></span>
        )}

        <div className="blockBody">
          <div className="blockMeta">
            {block._pageId
              ? block._sourceUrl
                ? "PDF annotation"
                : "regular note"
              : block.page
                ? `p.${block.page}`
                : "note"}
            {block._folders?.map((f) => (
              <span key={f} className="folderTagBadge" title={`In folder ${f}`}>
                <FolderIcon size={10} />
                {f}
              </span>
            ))}
          </div>

          {!readOnly && block.editMode ? (
            <BlockCmEditor
              ref={ref}
              autoFocus
              className="blockEditor blockEditorCm"
              dataBlockId={block.id}
              clickPos={clickPosRef.current}
              refLabels={refLabels}
              livePreview
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
                updateMathUi(e.target, true);
                updateSlashMenu(e.target, true);
              }}
              onSelect={(e) => {
                updateMathUi(e.target, false);
                updateSlashMenu(e.target, false);
              }}
              onBlur={() => {
                onStartEdit(block.id, false);
                setMathUi(null);
                setSlashMenu(null);
                setTimeout(() => setRefPopup(null), 120);
              }}
              onPaste={handleEditorPaste}
              onKeyDown={(e) => {
                if (refPopup && searchResults.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setRefSelectedIdx((i) => Math.min(i + 1, searchResults.length - 1));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setRefSelectedIdx((i) => Math.max(i - 1, 0));
                    return;
                  }
                  if (isEnterCommit(e)) {
                    e.preventDefault();
                    insertRef(searchResults[refSelectedIdx]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setRefPopup(null);
                    return;
                  }
                }
                if (slashMenu) {
                  const count = slashMenu.items.length;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashIdx((idx) => Math.min(idx + 1, count - 1));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashIdx((idx) => Math.max(idx - 1, 0));
                    return;
                  }
                  if (isEnterCommit(e) || e.key === "Tab") {
                    e.preventDefault();
                    runSlashCommand(slashMenu.items[slashIdx]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSlashMenu(null);
                    return;
                  }
                }
                if (mathUi?.ac) {
                  const n = mathUi.ac.items.length;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMathAcIdx((i) => Math.min(i + 1, n - 1));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMathAcIdx((i) => Math.max(i - 1, 0));
                    return;
                  }
                  if (e.key === "Tab" || isEnterCommit(e)) {
                    e.preventDefault();
                    acceptLatexAc(mathUi.ac.items[mathAcIdx]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMathUi((u) => (u ? { ...u, ac: null } : null));
                    return;
                  }
                }
                // Which Enter starts a new note is a preference (Settings →
                // Notes); the other one falls through to a plain line break.
                // Page-title rows on the home library always create on Enter —
                // a line break inside a title makes no sense.
                const newNoteKey = block._pageId || enterNewNote ? !e.shiftKey : e.shiftKey;
                if (isEnterCommit(e) && newNoteKey) {
                  e.preventDefault();
                  onEnterSibling(block.id);
                } else if (isEnterCommit(e)) {
                  // Plain line-break Enter continues Markdown markers. The same
                  // IME guard as sibling creation is mandatory: composition
                  // confirmation must never create/remove a list marker.
                  const ta = ref.current;
                  const cursor = ta?.selectionStart;
                  if (ta && cursor === ta.selectionEnd) {
                    const value = ta.value;
                    const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
                    const lineText = value.slice(lineStart, cursor);
                    const markerMatch = lineText.match(
                      /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+\. |> )/,
                    );
                    if (markerMatch) {
                      e.preventDefault();
                      if (lineText.length === markerMatch[0].length) {
                        ta.view?.dispatch({
                          changes: { from: lineStart, to: cursor, insert: "" },
                          selection: { anchor: lineStart },
                          userEvent: "delete",
                        });
                      } else {
                        let marker = markerMatch[0].replace(/\[[xX]\]/, "[ ]");
                        const numbered = marker.match(/^(\s*)(\d+)\. $/);
                        if (numbered) {
                          marker = `${numbered[1]}${Number(numbered[2]) + 1}. `;
                        }
                        ta.view?.dispatch({
                          changes: { from: cursor, to: cursor, insert: `\n${marker}` },
                          selection: { anchor: cursor + 1 + marker.length },
                          userEvent: "input",
                        });
                      }
                    }
                  }
                } else if (e.key === "Tab" && !e.shiftKey) {
                  e.preventDefault();
                  onIndent(block.id);
                } else if (e.key === "Tab" && e.shiftKey) {
                  e.preventDefault();
                  onOutdent(block.id);
                } else if (
                  e.key === "ArrowRight" &&
                  (block.children?.length || 0) > 0 &&
                  block.collapsed
                ) {
                  e.preventDefault();
                  onToggle(block.id);
                } else if (
                  e.key === "ArrowLeft" &&
                  (block.children?.length || 0) > 0 &&
                  !block.collapsed
                ) {
                  e.preventDefault();
                  onToggle(block.id);
                } else if (
                  e.key === "Backspace" &&
                  (block._isEmpty || !(block.content || "").trim()) &&
                  !(block.quote || "").trim()
                ) {
                  e.preventDefault();
                  onDelete(block.id);
                }
              }}
              placeholder="Type — '/' for commands"
            />
          ) : (
            <div className="blockRendered" onCopy={handleMarkdownCopy}>
              {(block.content || "").trim() ? (
                <BlockMarkdown
                  content={block.content || ""}
                  refLabels={refLabels}
                  onBlockRefClick={stableRefClick}
                  onTaskToggle={readOnly ? undefined : stableTaskToggle}
                />
              ) : (
                <div className="blockPlaceholder">(empty)</div>
              )}
            </div>
          )}

          {block.quote?.trim() ? <div className="blockQuote">{block.quote}</div> : null}
          {block.position?.area && captureArea ? (
            <AreaSnapshot block={block} captureArea={captureArea} docNonce={docNonce} />
          ) : null}
          {block.properties?.link_url || block.properties?.link_page_id ? (
            <button
              type="button"
              className="blockLinkChip"
              title={block.properties.link_url || "Open linked paper"}
              onClick={(e) => {
                e.stopPropagation();
                onOpenLinkTarget?.(block);
              }}
            >
              <LinkIcon size={11} strokeWidth={2.4} />
              {block.properties.link_page_id
                ? "linked paper"
                : (block.properties.link_url || "").replace(/^https?:\/\//i, "").slice(0, 48)}
            </button>
          ) : null}
        </div>
        {!readOnly && block.id !== "root" ? (
          <button
            className="uiClose uiCloseSm uiCloseDanger blockDeleteBtn"
            title="Delete block"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(block.id);
            }}
          >
            ×
          </button>
        ) : null}
      </div>
      {!readOnly && block.editMode && mathUi ? (
        <>
          <MathLivePreview tex={mathUi.tex} display={mathUi.display} anchor={mathUi.anchor} />
          {mathUi.ac ? (
            <LatexAcPopup
              items={mathUi.ac.items}
              selected={mathAcIdx}
              anchor={mathUi.anchor}
              onPick={acceptLatexAc}
            />
          ) : null}
        </>
      ) : null}
      {!readOnly && block.editMode && slashMenu ? (
        <SlashMenuPopup
          items={slashMenu.items}
          selected={slashIdx}
          anchor={slashMenu.anchor}
          onPick={runSlashCommand}
        />
      ) : null}
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
      >
        ⋮⋮
      </span>
      <BlockRow block={block} {...rowProps} />
    </div>
  );
}

function BlockTree({ blocks, readOnly, rowProps, depth = 0 }) {
  if (!blocks || blocks.length === 0) return null;
  return (
    <>
      {blocks.map((rawBlock) => {
        const block = withLegacyAccessors(rawBlock);
        return (
          <React.Fragment key={block.id}>
            {!readOnly ? (
              <SortableBlockRow block={block} depth={depth} {...rowProps} />
            ) : (
              <BlockRow block={block} depth={depth} {...rowProps} />
            )}
            {!block.collapsed && block.children && block.children.length > 0 ? (
              <div className="blockChildren">
                <BlockTree
                  blocks={block.children}
                  readOnly={readOnly}
                  rowProps={rowProps}
                  depth={depth + 1}
                />
              </div>
            ) : null}
          </React.Fragment>
        );
      })}
    </>
  );
}

export { BlockTree, _dragState };
