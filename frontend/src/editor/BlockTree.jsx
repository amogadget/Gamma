// The Logseq-style outliner: block rows (markdown rendering, inline
// editing, [[refs]], link chips, image drop/paste), drag handles, and the tree.
import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import { withLegacyAccessors } from "../shared/model/blockModel";
import { COLORS } from "../shared/model/highlightColors.js";
import { InkCard } from "../ink/InkLayer";
import { handleMarkdownCopy } from "../shared/ui/Widgets";
import { MermaidDiagram, mermaidCodeProps } from "../shared/ui/MermaidDiagram";
import { mapOutsideCodeFences, remarkMermaid } from "../shared/lib/mermaidMarkdown.js";
import { LinkIcon, PenIcon } from "../shared/ui/Icons";
import { FileChip, parseUploadUrl, postFile, uploadFilesAsLines } from "../transfers/FileChip";
import {
  envCompletions, findMathAtCursor, latexCompletionEdit, latexCompletions,
  LatexAcPopup, MathLivePreview, mathTabJump,
} from "./LatexEditor";
import { BlockCmEditor, scanMathSpans } from "./BlockCmEditor";
import { expandBlankLines } from "./mdMarks";
import { fenceInnerAt, highlightCode, makeCopyButton, scanFences } from "./codeHighlight";
import { filterSlashCommands, SlashMenuPopup } from "./SlashMenu";
import { remarkCallouts } from "./callouts";
import { PeerChips } from "../collaboration/Presence";
import { ContextMenu, MenuItem } from "../shared/ui/Menus";
import { API, apiJson, assetUrl, copyText, withWorkspace } from "../shared/lib/utils";
import { CopyIcon, ExportIcon, MessageSquareIcon, PlusIcon, Trash2Icon } from "../shared/ui/Icons";
import { inkBlockPreview } from "../native/inkBlock.js";
import { audioSegments, formatAudioDuration } from "../native/audioBlock.js";
import { StaticInkPreview } from "../native/ReplayInkLayer.jsx";
import { NATIVE_CONTROL_REASON, isNativeClaim } from "../native/nativeClaim.js";
import {
  applyImageEdit, applyTableEdit, formatTables, htmlTableToMarkdown,
  MdImage, MdTableWrap, parseTable, scanTables, tsvToMarkdown,
} from "./MdTools";

// Module-level ref for native HTML5 drag-and-drop (shared with App's drop handlers)
const _dragState = { draggingId: null, dropTarget: null };

// Native audio block: one recording session, its finalized segments in order,
// plus the way into Note Replay. The player itself lives in App (it drives the
// PDF layers), so this asks for it with the same event the notes pane uses.
function NativeAudioPreview({ block, readOnly }) {
  const segments = audioSegments(block);
  if (!segments.length) return null;
  return (
    <figure className="nativeAudio" aria-label="Audio recording">
      {segments.map((s) => (
        <div key={s.id} className="nativeAudioRow">
          <audio controls preload="metadata" src={assetUrl(s.url)} />
          <span>{formatAudioDuration(s.duration)}</span>
        </div>
      ))}
      <figcaption>
        Audio · {formatAudioDuration(block.properties.duration)}
        {!readOnly ? (
          <button className="uiBtn sm" style={{ marginLeft: 8 }}
            onClick={() => window.dispatchEvent(new CustomEvent("gamma-start-replay", { detail: { blockID: block.id } }))}>
            Open Note Replay
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}

// Native handwriting block: the high-resolution per-stroke preview when its
// `.inkjson` derivative is loaded (the SAME images Replay masks and the PDF
// layer draws, so sharpness does not change when replay ends), else the
// whole-block PNG the iPad also uploads. The editable PKDrawing stays on iPad.
function NativeInkPreview({ block, data }) {
  const preview = inkBlockPreview(block);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => setUnavailable(false), [preview?.url]);
  if (!preview) return null;
  return (
    <figure className="nativeInkCard">
      {data ? <StaticInkPreview data={data} /> : unavailable ? (
        <span className="nativeInkMissing">Handwriting preview unavailable. Sign in to the owning Gamma account.</span>
      ) : (
        <img
          src={assetUrl(preview.url)}
          alt={`Handwriting${preview.page ? ` on PDF page ${preview.page}` : ""}`}
          loading="lazy"
          onError={() => setUnavailable(true)}
          style={{ display: "block", maxWidth: "100%", maxHeight: 360, objectFit: "contain" }}
        />
      )}
      <figcaption>
        Handwriting{preview.page ? ` · Page ${preview.page}` : ""} · Edit ink on iPad
      </figcaption>
    </figure>
  );
}

// Source → markdown the renderer understands: sized images (Obsidian
// ![alt|300] and legacy Logseq {:width}), ![[embeds]],
// [[refs]] and ==highlights== rewritten OUTSIDE math and inline-code spans
// (a "==" inside $...$ must stay LaTeX). `nested` is the inside-an-embed
// render: embeds degrade to ref chips so transclusion can't recurse.
function applyOutsideSpans(text, spans, fn) {
  if (!spans.length) return fn(text);
  spans.sort((a, b) => a.from - b.from);
  let out = "", pos = 0;
  for (const s of spans) {
    if (s.from < pos) continue;
    out += fn(text.slice(pos, s.from)) + text.slice(s.from, s.to);
    pos = s.to;
  }
  return out + fn(text.slice(pos));
}

function mdPreprocess(content, nested) {
  return mapOutsideCodeFences(content, (prose) => mdPreprocessProse(prose, nested));
}

function mdPreprocessProse(content, nested) {
  // The editor centres every $$…$$ on its own row (cmMathDisplay); remark-math
  // only does that when the fences sit alone on their lines (same-line content
  // becomes "meta" and is dropped — raw source in the rendered view). So a
  // display span standing alone on its line(s) is reshaped to that block form
  // (blank-line separated, KaTeX display mode → centred like the editor); one
  // embedded mid-sentence collapses onto one line instead, which remark-math
  // reads as inline math and the sentence stays intact.
  // Two or more blank lines stay visible (expandBlankLines): markdown would
  // fold them into the one paragraph break. Done first and outside math, so
  // a blank line the display-math reshape below adds is never counted.
  content = applyOutsideSpans(content, scanMathSpans(content).map((s) => ({ from: s.from, to: s.to })), expandBlankLines);
  const displays = scanMathSpans(content).filter((s) => s.display);
  for (let i = displays.length - 1; i >= 0; i--) {
    const s = displays[i];
    const before = content.slice(0, s.from);
    const after = content.slice(s.to);
    const tex = content.slice(s.from + 2, s.to - 2).trim();
    if (/(^|\n)[ \t]*$/.test(before) && /^[ \t]*(\n|$)/.test(after)) {
      content = `${before.replace(/[ \t]+$/, "")}\n\n$$\n${tex}\n$$\n\n${after.replace(/^[ \t]+/, "")}`;
    } else if (content.slice(s.from, s.to).includes("\n")) {
      content = `${before}$$ ${tex.replace(/\s*\n\s*/g, " ")} $$${after}`;
    }
  }
  const spans = scanMathSpans(content).map((s) => ({ from: s.from, to: s.to }));
  // ``` fences claim first (sorted by from, earlier span wins in
  // applyOutsideSpans) — a [[ref]] or == inside code must stay literal.
  for (const f of scanFences(content)) spans.push({ from: f.from, to: f.to });
  for (const m of content.matchAll(/`[^`\n]+`/g)) {
    spans.push({ from: m.index, to: m.index + m[0].length });
  }
  return applyOutsideSpans(content, spans, (seg) => seg
    // Sized images: legacy Logseq {:width N} first, then Obsidian ![alt|300].
    .replace(/!\[([^\]]*)\]\(([^)]+)\)\{:width\s+(\d+)\}/g, '<img src="$2" alt="$1" width="$3" />')
    .replace(/!\[([^\]|]*)\|(\d+)(?:x\d+)?\]\(([^)]+)\)/g, '<img src="$3" alt="$1" width="$2" />')
    .replace(/!\[\[([a-zA-Z0-9_-]+)\]\]/g, nested ? "[$1](blockref:$1)" : "[$1](blockembed:$1)")
    .replace(/\[\[([a-zA-Z0-9_-]+)\]\]/g, "[$1](blockref:$1)")
    .replace(/==([^=\n]+?)==/g, "<mark>$1</mark>"));
}

// Plain text of a rendered element tree (link labels arrive as React children).
function textOf(children) {
  if (children == null) return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (children.props?.children != null) return textOf(children.props.children);
  return "";
}

// GitHub URLs get a readable label without any fetch: owner/repo, #issue/PR,
// or the file a blob/tree link points at.
function githubLabel(href) {
  try {
    const u = new URL(href);
    if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
    const p = u.pathname.split("/").filter(Boolean);
    if (p.length === 0) return "GitHub";
    if (p.length === 1) return p[0];
    const repo = `${p[0]}/${p[1]}`;
    if (["issues", "pull", "discussions"].includes(p[2]) && p[3]) return `${repo} #${p[3]}`;
    if (["blob", "tree"].includes(p[2]) && p.length > 3) return `${repo} · ${p[p.length - 1]}`;
    if (p[2] === "releases") return `${repo} · releases`;
    if (p[2] === "commit" && p[3]) return `${repo} @ ${p[3].slice(0, 7)}`;
    return repo;
  } catch { return null; }
}

// Notion-style link chip: favicon + label. Bare URLs (autolinked, or link
// text that is itself a URL) get a fetched page title via /api/link-preview
// (host shown until it arrives, or forever when the fetch fails/401s in the
// shared view); user-written link text is kept as the label.
const _linkPreviewCache = new Map();
function LinkChip({ href, text }) {
  const bare = /^(https?:\/\/|www\.)/i.test((text || "").trim());
  const gh = githubLabel(href);
  let host = "";
  try { host = new URL(href).hostname.replace(/^www\./, ""); } catch (_) {}
  const wantFetch = bare && !gh;
  const [fetched, setFetched] = useState(() => _linkPreviewCache.get(href) || null);
  const [iconBroken, setIconBroken] = useState(false);
  useEffect(() => {
    if (!wantFetch || _linkPreviewCache.has(href)) return;
    let dead = false;
    fetch(`/api/link-preview?url=${encodeURIComponent(href)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        _linkPreviewCache.set(href, d?.title || "");
        if (!dead && d?.title) setFetched(d.title);
      })
      .catch(() => {});
    return () => { dead = true; };
  }, [href, wantFetch]);
  const label = bare ? (gh || fetched || host || text) : (text || host);
  return (
    <a
      className="linkChip"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={href}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {host && !iconBroken ? (
        <img
          className="linkChipIcon"
          src={`https://icons.duckduckgo.com/ip3/${host}.ico`}
          alt=""
          loading="lazy"
          onError={() => setIconBroken(true)}
        />
      ) : (
        <LinkIcon size={12} strokeWidth={2.2} />
      )}
      <span className="linkChipText">{label}</span>
    </a>
  );
}

// Flip the nth task checkbox marker in markdown source (list task items only —
// the regex mirrors what remark-gfm turns into checkboxes). Shared by the
// block row and the embed card.
function toggleTaskMarker(content, idx, checked) {
  let i = -1;
  return (content || "").replace(
    /(^|\n)([ \t]*(?:[-*+]|\d+\.)[ \t]+\[)([ xX])(\])/g,
    (m, p1, p2, p3, p4) => {
      i += 1;
      return i === idx ? p1 + p2 + (checked ? "x" : " ") + p4 : m;
    },
  );
}

// The file chip (`[name](/api/uploads/<hash>.ext)`, what a dropped file
// becomes) and the upload helpers live in transfers/FileChip.jsx.

// The files on a clipboard (a screenshot, files copied in the file manager):
// what a paste uploads instead of inserting text.
function clipboardFiles(e) {
  return Array.from(e.clipboardData?.items || [])
    .filter((it) => it.kind === "file")
    .map((it) => it.getAsFile())
    .filter(Boolean);
}

// POST /api/upload-image → url | null; shared by the block row (drop, paste,
// /image) and the embed card's paste handler.
async function uploadImageFile(file) {
  if (!file?.type?.startsWith("image/")) return null;
  return (await postFile("/api/upload-image", file))?.url || null;
}

// Live LaTeX aids while the caret sits inside $...$ / $$...$$: the floating
// preview plus \command autocomplete state — shared by the block editor and
// the embed card's in-place editor. Recomputed on every edit AND caret move
// (the preview must track the caret); the autocomplete only OPENS on typing.
function useMathUi() {
  const [mathUi, setMathUi] = useState(null);
  const [mathAcIdx, setMathAcIdx] = useState(0);

  function updateMathUi(ta, typing) {
    const cursor = ta.selectionStart;
    if (cursor !== ta.selectionEnd) { setMathUi(null); return; }
    // A "$" inside a ``` fence is code (shell vars), never math.
    const seg = fenceInnerAt(ta.value, cursor) ? null : findMathAtCursor(ta.value, cursor);
    if (!seg) { setMathUi(null); return; }
    // \command autocomplete: a backslash-word ending at the caret, only
    // inside math (a bare "\" in prose — file paths — must not trigger it),
    // and only opened by TYPING — clicking into an existing formula must not
    // pop the menu. Caret moves (typing=false) keep an already-open popup
    // only while the caret stays on the same trigger; React fires onSelect
    // right after onChange for a keystroke, so this must not wipe it.
    // "\begin{name" (even with the } already typed) completes environment
    // names instead — accepting replaces the whole \begin{… with the snippet.
    const before = ta.value.slice(seg.start, cursor);
    const mEnv = before.match(/\\begin\{([a-zA-Z*]*)\}?$/);
    const m = mEnv ? null : before.match(/\\([a-zA-Z]+)$/);
    const next = {
      tex: ta.value.slice(seg.start, seg.end),
      display: seg.display,
      anchor: { ...ta.caretCoords(cursor), getRect: () => ta.caretCoords(cursor) },
      ac: null,
    };
    setMathUi((prev) => {
      const trig = mEnv || m;
      const start = trig ? cursor - trig[0].length : -1;
      if (trig && (typing || prev?.ac?.start === start)) {
        const items = mEnv ? envCompletions(mEnv[1]) : latexCompletions(m[1]);
        if (items.length) next.ac = { start, items };
      }
      return next;
    });
    if (typing) setMathAcIdx(0);
  }

  // Accept an autocomplete entry into the editor `ta` and close the popup.
  function acceptCompletion(ta, c) {
    if (!ta || !mathUi?.ac) return;
    const { start } = mathUi.ac;
    const edit = latexCompletionEdit(ta.value, start, ta.selectionStart, c, mathUi.display);
    ta.view?.dispatch({ ...edit, userEvent: "input.complete" });
    setMathUi(null);
    ta.focus();
    updateMathUi(ta, false);
  }

  return { mathUi, setMathUi, mathAcIdx, setMathAcIdx, updateMathUi, acceptCompletion };
}

// ![[id]] transclusion: the referenced block's content rendered in a card.
// With onEmbedEdit (not read-only), the synced position is a full editing
// surface for the SOURCE block, Notion-synced-block style: checkboxes, image
// hover tools and table editing on the rendered card write straight through,
// and clicking the text edits the raw source in place — with the same live
// math preview + \command autocomplete and image/table paste as a normal
// block editor. Every edit lands on the source, so all copies re-render.
// The page-title footer jumps to the source; in read-only views the whole
// card is the jump link.
function BlockEmbedCard({ refId, refBlock, refLabels, onBlockRefClick, onEmbedEdit }) {
  const [draft, setDraft] = useState(null); // non-null while editing in place
  const { mathUi, setMathUi, mathAcIdx, setMathAcIdx, updateMathUi, acceptCompletion } = useMathUi();
  const editorRef = useRef(null);
  const editable = !!onEmbedEdit && refBlock?.content != null;

  const save = () => {
    setMathUi(null);
    setDraft((d) => {
      if (d != null) {
        // Same pretty-print-on-close as leaving a normal raw editor.
        const pretty = formatTables(d) ?? d;
        if (pretty !== refBlock.content) onEmbedEdit(refId, pretty);
      }
      return null;
    });
  };

  function acceptLatexAc(c) { acceptCompletion(editorRef.current, c); }

  // Paste while editing: files upload and insert at the caret (images
  // inline, anything else — a PDF copied from the file manager — as a file
  // chip), a clipboard that IS one html table becomes a markdown table;
  // plain text stays CM's native paste.
  async function handlePaste(e) {
    const ta = editorRef.current;
    if (!ta) return;
    const files = clipboardFiles(e);
    if (files.length) {
      e.preventDefault();
      const start = ta.selectionStart, end = ta.selectionEnd;
      const md = (await uploadFilesAsLines(files)).join("\n");
      if (!md) return;
      ta.view?.dispatch({
        changes: { from: start, to: end, insert: md },
        selection: { anchor: start + md.length },
        userEvent: "input",
      });
      return;
    }
    const html = e.clipboardData?.getData("text/html") || "";
    if (/<table[\s>]/i.test(html)) {
      const md = htmlTableToMarkdown(html);
      if (md) {
        e.preventDefault();
        const start = ta.selectionStart, end = ta.selectionEnd;
        const val = ta.value || "";
        const lead = start > 0 && val[start - 1] !== "\n" ? "\n" : "";
        const trail = end < val.length && val[end] !== "\n" ? "\n" : "";
        ta.view?.dispatch({
          changes: { from: start, to: end, insert: lead + md + trail },
          selection: { anchor: start + lead.length + md.length },
          userEvent: "input",
        });
      }
    }
  }

  // In-place tools on the rendered card write through to the source — same
  // source transforms as a normal block, identity-stable for the memo.
  const toolsRef = useRef({});
  toolsRef.current = {
    task: (idx, checked) => {
      const v = toggleTaskMarker(refBlock?.content || "", idx, checked);
      if (v !== refBlock?.content) onEmbedEdit?.(refId, v);
    },
    img: (idx, action, payload) => {
      const v = applyImageEdit(refBlock?.content || "", idx, action, payload);
      if (v != null && v !== refBlock?.content) onEmbedEdit?.(refId, v);
    },
    tbl: (idx, op) => {
      const v = applyTableEdit(refBlock?.content || "", idx, op);
      if (v != null && v !== refBlock?.content) onEmbedEdit?.(refId, v);
    },
  };
  const stableTask = useRef((i, c) => toolsRef.current.task(i, c)).current;
  const stableImg = useRef((i, a, p) => toolsRef.current.img(i, a, p)).current;
  const stableTbl = useRef((i, o) => toolsRef.current.tbl(i, o)).current;

  return (
    <span
      className={`blockEmbedCard${draft != null ? " editing" : ""}`}
      role={editable ? undefined : "link"}
      title={draft != null ? undefined
        : refBlock?.page_title ? `From: ${refBlock.page_title}` : "Embedded note"}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (draft != null) return;
        // A click an inner tool already handled (checkbox, table cell or
        // handle, image toolbar, a link) must not ALSO open the raw editor.
        if (editable && e.target.closest?.(".mdTableWrap, .mdImgWrap, .mdTaskCheckbox, a, button, input")) return;
        if (editable) setDraft(refBlock.content);
        else onBlockRefClick?.(refId);
      }}
    >
      <span className="blockEmbedBody">
        {draft != null ? (
          <BlockCmEditor
            ref={editorRef}
            autoFocus
            className="blockEditor blockEditorCm"
            value={draft}
            refLabels={refLabels}
            onChange={(e) => { setDraft(e.target.value); updateMathUi(e.target, true); }}
            onSelect={(e) => updateMathUi(e.target, false)}
            onBlur={save}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (mathUi?.ac) {
                const n = mathUi.ac.items.length;
                if (e.key === "ArrowDown") { e.preventDefault(); setMathAcIdx((i) => Math.min(i + 1, n - 1)); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setMathAcIdx((i) => Math.max(i - 1, 0)); return; }
                if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); acceptLatexAc(mathUi.ac.items[mathAcIdx]); return; }
                if (e.key === "Escape") { e.preventDefault(); setMathUi((u) => (u ? { ...u, ac: null } : null)); return; }
              }
              // Same math Tab-hop as the block editor (no indent to fall
              // through to here — an unhandled Tab just moves focus).
              if (e.key === "Tab" && editorRef.current) {
                const ta = editorRef.current;
                const origin = e.shiftKey ? ta.selectionStart : ta.selectionEnd;
                const jump = !fenceInnerAt(ta.value, origin)
                  && mathTabJump(ta.value, origin, e.shiftKey ? -1 : 1);
                if (jump) {
                  e.preventDefault();
                  ta.setSelectionRange(jump.anchor, jump.head);
                  updateMathUi(ta, false);
                  return;
                }
              }
              // Escape saves and exits, same as blurring a normal block.
              if (e.key === "Escape") { e.preventDefault(); save(); }
            }}
            placeholder="Edit the source note…"
          />
        ) : refBlock?.content ? (
          <BlockMarkdown content={refBlock.content} blockId={`embed:${refId}`} refLabels={refLabels}
            onBlockRefClick={onBlockRefClick} nested
            onTaskToggle={editable ? stableTask : undefined}
            onImageEdit={editable ? stableImg : undefined}
            onTableEdit={editable ? stableTbl : undefined} />
        ) : (
          <span className="blockPlaceholder">embedded note…</span>
        )}
      </span>
      {draft != null && mathUi ? (
        <>
          <MathLivePreview tex={mathUi.tex} display={mathUi.display} anchor={mathUi.anchor} />
          {mathUi.ac ? (
            <LatexAcPopup items={mathUi.ac.items} selected={mathAcIdx} anchor={mathUi.anchor} onPick={acceptLatexAc} />
          ) : null}
        </>
      ) : null}
      {refBlock?.page_title ? (
        <span
          className="blockEmbedSrc"
          role="link"
          title="Open the source block"
          onClick={(e) => { e.stopPropagation(); onBlockRefClick?.(refId); }}
        >{refBlock.page_title}</span>
      ) : null}
    </span>
  );
}

// Fenced code in the rendered view: react-markdown hands us
// <pre><code class="language-x">text</code></pre>; re-render it through
// highlight.js with a small language badge. Inline `code` is untouched.
// The copy button is the shared DOM one (makeCopyButton — same behavior as
// the editor's code card), mounted once outside React's reconciliation.
function CodePre({ children }) {
  const diagram = mermaidCodeProps(children);
  return diagram ? <MermaidDiagram {...diagram} /> : <HighlightedCodePre>{children}</HighlightedCodePre>;
}

function HighlightedCodePre({ children }) {
  const codeProps = React.Children.toArray(children).find((c) => c?.props)?.props || {};
  const lang = /language-([\w+#-]+)/.exec(codeProps.className || "")?.[1] || "";
  const raw = textOf(codeProps.children).replace(/\n$/, "");
  const html = useMemo(() => highlightCode(raw, lang), [raw, lang]);
  const rawRef = useRef(raw);
  rawRef.current = raw;
  const preRef = useRef(null);
  useEffect(() => {
    const btn = makeCopyButton(() => rawRef.current);
    preRef.current?.appendChild(btn);
    return () => btn.remove();
  }, []);
  return (
    <pre className="codeBlock" ref={preRef}>
      {lang ? <span className="codeLangBadge">{lang}</span> : null}
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

// A block's rendered markdown, memoized: any edit re-renders the whole tree
// (setBlocks replaces it), and without the memo one keystroke re-ran
// ReactMarkdown + KaTeX for every rendered block on the page. Re-parses only
// when the content or a resolved [[ref]] chip label actually changes; ref
// labels are resolved by the caller so the comparison here stays a string
// check. onBlockRefClick/onTaskToggle are deliberately excluded from the
// comparison — the caller passes identity-stable wrappers.
const BlockMarkdown = React.memo(function BlockMarkdown({ content, blockId, refLabels, onBlockRefClick, onTaskToggle, onEmbedEdit, onImageEdit, onTableEdit, nested }) {
  // GFM task-list checkboxes render in document order; this counter maps the
  // nth rendered checkbox back to the nth `[ ]`/`[x]` marker in the source so
  // clicking one toggles the right marker. Reset per render — the whole
  // element tree is rebuilt whenever this component re-renders.
  // imgIdx/tableIdx do the same for images and tables (mdTools scans the
  // source with matching rules, so the nth rendered one is the nth scanned).
  let taskIdx = -1, imgIdx = -1, tableIdx = -1;
  // Source-order table list; entries inside blockquotes are editable:false
  // (they still consume an index so the mapping stays aligned).
  const tableInfo = useMemo(() => scanTables(content || ""), [content]);
  return (
    <ReactMarkdown
      // remark-breaks: a single Enter inside a note renders as a real line
      // break (the editor lets you type them), not markdown's soft-break space.
      // remarkCallouts must run before it (it eats the marker line's "\n").
      remarkPlugins={[remarkGfm, remarkMath, remarkCallouts, remarkBreaks, remarkMermaid]}
      rehypePlugins={[rehypeRaw, rehypeKatex]}
      // Upload URLs get the workspace / share token here (assetUrl): the
      // browser fetches <img> src and link hrefs without the API header.
      urlTransform={(url) => url.startsWith("blockref:") || url.startsWith("blockembed:") ? url : assetUrl(defaultUrlTransform(url))}
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
          if (href?.startsWith("blockembed:")) {
            const refId = href.slice(11);
            return (
              <BlockEmbedCard
                refId={refId}
                refBlock={refLabels?.[refId]}
                refLabels={refLabels}
                onBlockRefClick={onBlockRefClick}
                onEmbedEdit={onEmbedEdit}
              />
            );
          }
          if (/^https?:\/\//i.test(href || "")) {
            return <LinkChip href={href} text={textOf(children)} />;
          }
          if (parseUploadUrl(href) && !/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(href)) {
            return <FileChip href={href} text={textOf(children)} />;
          }
          return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
        pre: CodePre,
        img: ({ node, src, alt, width }) => {
          imgIdx += 1;
          return <MdImage src={src} alt={alt} width={width} idx={imgIdx} onEdit={onImageEdit} />;
        },
        table: ({ node, children }) => {
          tableIdx += 1;
          const info = tableInfo[tableIdx];
          const editable = !!(info?.editable && onTableEdit);
          return (
            <MdTableWrap
              idx={tableIdx}
              onEdit={editable ? onTableEdit : undefined}
              model={editable ? parseTable(content.slice(info.from, info.to)) : null}
              editKey={editable ? `${blockId}:${tableIdx}` : null}
            >
              {children}
            </MdTableWrap>
          );
        },
        input: ({ node, type, checked, disabled, ...props }) => {
          if (type !== "checkbox") return <input type={type} {...props} />;
          taskIdx += 1;
          const idx = taskIdx;
          return (
            <input
              type="checkbox"
              className="mdTaskCheckbox"
              checked={!!checked}
              disabled={!onTaskToggle}
              onChange={(e) => onTaskToggle?.(idx, e.target.checked)}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
          );
        },
      }}
    >
      {mdPreprocess(content, nested)}
    </ReactMarkdown>
  );
}, (prev, next) =>
  prev.content === next.content
  && prev.nested === next.nested
  && Object.keys(prev.refLabels).length === Object.keys(next.refLabels).length
  && Object.entries(next.refLabels).every(([id, r]) =>
    prev.refLabels[id]?.content === r.content && prev.refLabels[id]?.page_title === r.page_title)
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
    if (cached) { setSrc(cached); return; }
    setSrc(null);
    let cancelled = false;
    // docNonce re-runs this once the PDF finishes loading — the first attempt
    // can land before the viewer has a document and resolve to null.
    Promise.resolve(captureArea?.(block)).then((img) => {
      if (cancelled || !img) return;
      _areaSnapCache.set(key, img);
      while (_areaSnapCache.size > 60) _areaSnapCache.delete(_areaSnapCache.keys().next().value);
      setSrc(img);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [key, captureArea, docNonce]);
  // Reserve the crop's aspect ratio while it renders so the card doesn't jump.
  const ratio = r && r.y2 > r.y1 ? (r.x2 - r.x1) / (r.y2 - r.y1) : null;
  return src ? (
    <img className="blockAreaSnap" src={src} alt="Area selection" draggable={false}
      style={{ borderLeftColor: block.color || undefined }} />
  ) : (
    <div className="blockAreaSnap blockAreaSnapPending"
      style={{ aspectRatio: ratio || undefined, borderLeftColor: block.color || undefined }} />
  );
}

function BlockRow({
  block,
  depth,
  focusedId,
  setFocusedId,
  onJump,
  onInkJump,
  onNativeInkJump,
  nativeInkPreviews,
  onEnterAttachMode,
  onUnlinkHighlight,
  onOpenLinkTarget,
  onChangeText,
  onCaret,
  onEnterSibling,
  enterNewNote,
  onAddChild,
  onPasteBlocks,
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
  onBlockDragOver,
  onBlockDragLeave,
  onBlockDrop,
  captureArea,
  docNonce,
  aiMarks,
  aiLive,
  aiScan,
  onAddToChat,
  peers,
}) {
  const ref = useRef(null);
  const clickPosRef = useRef(null);
  // Other people on this block (collab presence): avatar chips on the row,
  // a coloured edge while one of them has its editor open, and their
  // carets inside our editor when we have it open too.
  const rowPeers = peers?.length ? peers.filter((p) => p.block === block.id) : null;
  const peerEditing = rowPeers?.find((p) => p.anchor >= 0) || null;
  const remoteCursors = rowPeers?.length
    ? rowPeers.filter((p) => p.anchor >= 0).map((p) => ({
      client: p.client, rev: p.rev || 0, anchor: p.anchor, head: p.head, color: p.color, name: p.name,
    }))
    : null;
  // The AI agent's live footprint on this row (App.handleAgentEvent): a
  // read/edit mark that lights the row up, and — while the agent is still
  // writing an edit_block call for THIS block — the streamed text so far.
  // A block the user is editing keeps its editor; the mark still shows.
  const aiMark = aiMarks?.get(block.id) || null;
  const aiText = aiLive?.tool === "edit_block" && aiLive.blockId === block.id && !block.editMode
    ? joinBlockText(block.content || "", aiLive.content, aiLive.mode) : null;
  // Whole-page read: every row rings once, staggered by its position, so
  // the read visibly sweeps down the outline. A row with its own mark keeps
  // that instead.
  const scanIdx = !aiMark && aiScan ? aiScan.order.get(block.id) : undefined;
  // Identity-stable wrapper so the memoized BlockMarkdown never sees a fresh
  // callback (rowProps closures are rebuilt every App render) yet always
  // calls the latest one — same idiom as pdfViewer's stableCbs.
  const refClickRef = useRef(null);
  refClickRef.current = onBlockRefClick;
  const stableRefClick = useRef((id) => refClickRef.current?.(id)).current;
  // Same identity-stable idiom for task-checkbox toggles: flip the nth
  // `[ ]`/`[x]` marker in the source (list task items only — the regex mirrors
  // what remark-gfm turns into checkboxes).
  const taskToggleRef = useRef(null);
  taskToggleRef.current = (idx, checked) => {
    const newVal = toggleTaskMarker(block.content || "", idx, checked);
    if (newVal !== block.content) onChangeText(block.id, newVal);
  };
  const stableTaskToggle = useRef((idx, checked) => taskToggleRef.current?.(idx, checked)).current;
  // In-place edits on ![[embed]] cards write to the SOURCE block. A source on
  // the current page goes through onChangeText (state + debounced autosave —
  // a direct PUT would be reverted by the page's own autosave); a cross-page
  // source is PUT directly and the ref cache updated so every copy re-renders.
  const embedEditRef = useRef(null);
  embedEditRef.current = (refId, newContent) => {
    if (allBlocks?.find((b) => b.id === refId)) {
      onChangeText(refId, newContent);
    } else {
      apiJson(`${API}/blocks/${refId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent }),
      }).catch(() => {});
      onCacheRef?.(refId, { content: newContent }); // merge-write keeps page_title etc.
    }
  };
  const stableEmbedEdit = useRef((id, c) => embedEditRef.current?.(id, c)).current;
  // Hover tools on rendered images/tables (mdTools): edits are text
  // transforms on the nth construct in this block's source. A null result
  // means the scan couldn't locate it — no-op rather than corrupt.
  const imageEditRef = useRef(null);
  imageEditRef.current = (idx, action, payload) => {
    const newVal = applyImageEdit(block.content || "", idx, action, payload);
    if (newVal != null && newVal !== block.content) {
      onChangeText(block.id, newVal);
    }
  };
  const stableImageEdit = useRef((i, a, p) => imageEditRef.current?.(i, a, p)).current;
  const tableEditRef = useRef(null);
  tableEditRef.current = (idx, op) => {
    const newVal = applyTableEdit(block.content || "", idx, op);
    if (newVal != null && newVal !== block.content) {
      onChangeText(block.id, newVal);
    }
  };
  const stableTableEdit = useRef((i, o) => tableEditRef.current?.(i, o)).current;
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
  // Live LaTeX aids (preview + \command autocomplete) — the shared hook.
  const { mathUi, setMathUi, mathAcIdx, setMathAcIdx, updateMathUi, acceptCompletion } = useMathUi();
  // "/" command menu: { start, query, items, anchor }. Opened only by TYPING
  // the slash (caret moves just keep or close it), suppressed inside math.
  const [slashMenu, setSlashMenu] = useState(null);
  const [slashIdx, setSlashIdx] = useState(0);
  // Notion-style "Paste as" chooser after pasting a URL: the URL text is
  // already inserted; { start, end, url, items, anchor }. Any further edit,
  // caret move or blur keeps the URL and dismisses the menu.
  const [pasteMenu, setPasteMenu] = useState(null);
  const [pasteIdx, setPasteIdx] = useState(0);
  const [searchResults, setSearchResults] = useState([]);
  const [fileDragOver, setFileDragOver] = useState(false);
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

  function acceptLatexAc(c) { acceptCompletion(ref.current, c); }

  // "/" trigger: a slash starting a word, with the query typed so far after
  // it. Recomputed on edits (typing=true, may open) and caret moves
  // (typing=false, only keeps an already-open menu on the same trigger).
  function updateSlashMenu(ta, typing) {
    const cursor = ta.selectionStart;
    if (cursor !== ta.selectionEnd) { setSlashMenu(null); return; }
    const m = ta.value.slice(0, cursor).match(/(?:^|\s)\/([a-zA-Z0-9-]*)$/);
    if (!m || findMathAtCursor(ta.value, cursor) || fenceInnerAt(ta.value, cursor)) { setSlashMenu(null); return; }
    const start = cursor - m[1].length - 1;
    const items = filterSlashCommands(m[1]);
    if (!items.length) { setSlashMenu(null); return; }
    const anchor = ta.caretCoords(start);
    setSlashMenu((prev) => {
      if (!typing && prev?.start !== start) return null;
      return { start, query: m[1], items, anchor };
    });
    if (typing) setSlashIdx(0);
  }

  function runSlashCommand(c) {
    const ta = ref.current;
    if (!ta || !slashMenu) return;
    const start = slashMenu.start;
    const value = ta.value;
    const cursor = ta.selectionStart;
    setSlashMenu(null);
    c.run({
      value,
      start,
      cursor,
      setText: (newVal, selStart, selEnd) => {
        onChangeText(block.id, newVal);
        requestAnimationFrame(() => {
          try { ta.setSelectionRange(selStart, selEnd ?? selStart); } catch (_) {}
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
      // The file dialog blurs the editor (which exits edit mode), so the
      // upload appends to the value captured here, with "/image" removed.
      pickImage: () => {
        const base = value.slice(0, start) + value.slice(cursor);
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "image/*";
        inp.onchange = async () => {
          const url = await uploadImage(inp.files?.[0]);
          if (url) onChangeText(block.id, (base ? base + "\n" : "") + `![](${url})`);
        };
        inp.click();
      },
    });
  }

  useEffect(() => {
    registerRef(block.id, ref);
  }, [block.id, registerRef]);

  // Caret-at-click placement now happens inside BlockCmEditor (posAtCoords on
  // mount); just drop the captured coords once edit mode is entered so later
  // re-renders don't reuse them.
  useEffect(() => {
    if (block.editMode) clickPosRef.current = null;
  }, [block.editMode]);
  // Leaving raw editing pretty-prints any tables in the block. Watched on the
  // editMode transition (not the editor's onBlur — switching blocks
  // preventDefaults the mousedown, so the editor unmounts without a blur).
  const wasEditingRef = useRef(false);
  useEffect(() => {
    if (wasEditingRef.current && !block.editMode && !readOnly) {
      const formatted = formatTables(block.content || "");
      if (formatted != null) onChangeText(block.id, formatted);
    }
    wasEditingRef.current = !!block.editMode;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.editMode]);

  const isHighlight = !!block.highlightId;
  // A handwriting group (docs/dev/handwriting.md): pen marker + the strokes
  // as a card; its content is the caption.
  const isInk = block.properties?.ink_url !== undefined;
  // Native (iPad) handwriting: a `pdf_ink` block whose strokes were drawn and
  // are editable on the iPad only. Same pen marker idea, its own glyph (a
  // rounded square) so the two kinds stay distinguishable, and its own jump —
  // native blocks carry canonical crop-space bounds rather than a
  // pdf_position.
  const isNativeInk = block.properties?.type === "pdf_ink";
  const hasChildren = (block.children?.length || 0) > 0;

  function handleFileDragOver(e) {
    if (!e.dataTransfer?.types || !Array.from(e.dataTransfer.types).includes("Files")) return;
    if (!e.dataTransfer?.items) return;
    // Any file lands in the block: images inline, everything else — PDFs too;
    // a page's DOCUMENT is attached from the header, never by a drop — as a
    // file chip.
    const hasFile = Array.from(e.dataTransfer.items).some((item) => item.kind === "file");
    if (!hasFile) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setFileDragOver(true);
  }

  function handleFileDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) setFileDragOver(false);
  }

  async function uploadImage(file) {
    if (uploadingRef.current) return null;
    uploadingRef.current = true;
    try {
      return await uploadImageFile(file);
    } finally { uploadingRef.current = false; }
  }

  // Every dropped file lands in this block, one line each: images inline,
  // the rest as file chips (uploaded in order; a refused one is skipped).
  async function handleFileDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setFileDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length || uploadingRef.current) return;
    uploadingRef.current = true;
    try {
      const lines = await uploadFilesAsLines(files);
      if (lines.length) onChangeText(block.id, [block.content || "", ...lines].join("\n").replace(/^\n/, ""));
    } finally { uploadingRef.current = false; }
  }

  // A gamma block link pastes as mention chip / synced embed / plain URL;
  // any other URL pastes as-is (the link chip) or as a titled markdown link.
  function pasteAsItems(blockId) {
    if (blockId) {
      return [
        { name: "mention", glyph: "@", label: "Mention", hint: "inline chip", make: () => `[[${blockId}]]` },
        { name: "synced", glyph: "⧉", label: "Synced block", hint: "live embed", make: () => `![[${blockId}]]` },
        { name: "url", glyph: "🔗", label: "URL", hint: "keep the link" },
      ];
    }
    return [
      { name: "url", glyph: "🔗", label: "URL", hint: "link chip" },
      { name: "titled", glyph: "🔖", label: "Titled link", hint: "fetch the page title" },
    ];
  }

  function applyPasteAs(item) {
    const pm = pasteMenu;
    setPasteMenu(null);
    const ta = ref.current;
    if (!pm || !ta) return;
    const doReplace = (text) => {
      // The pasted URL must still be where we left it (typing dismisses the
      // menu, but an async titled-link fetch can land late).
      if (ta.value.slice(pm.start, pm.end) !== pm.url) return;
      ta.view?.dispatch({
        changes: { from: pm.start, to: pm.end, insert: text },
        selection: { anchor: pm.start + text.length },
        userEvent: "input",
      });
      ta.focus();
    };
    if (item.make) {
      let text = item.make();
      if (item.block) {
        // A block-level construct (a table) must start and end on its own
        // line — pad like the direct html-table paste does.
        const val = ta.value || "";
        if (pm.start > 0 && val[pm.start - 1] !== "\n") text = "\n" + text;
        if (pm.end < val.length && val[pm.end] !== "\n") text += "\n";
      }
      doReplace(text);
    } else if (item.name === "blocks") {
      // Parse server-side (same parser as the .md file import), remove the
      // pasted text from this block, then hand the tree to App to insert.
      apiJson(`${API}/markdown-blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: pm.url }),
      }).then((d) => {
        const nodes = d?.blocks || [];
        if (!nodes.length) return;
        if (ta.value.slice(pm.start, pm.end) !== pm.url) return; // edited since
        ta.view?.dispatch({
          changes: { from: pm.start, to: pm.end, insert: "" },
          selection: { anchor: pm.start },
          userEvent: "input",
        });
        onPasteBlocks?.(block.id, nodes);
      }).catch(() => {});
    } else if (item.name === "titled") {
      fetch(`/api/link-preview?url=${encodeURIComponent(pm.url)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          let label = (d?.title || "").replace(/[[\]\n]/g, " ").trim();
          if (!label) {
            try { label = new URL(pm.url).hostname.replace(/^www\./, ""); } catch (_) { label = pm.url; }
          }
          doReplace(`[${label}](${pm.url})`);
        })
        .catch(() => {});
    }
    // "url" / "text": keep the pasted text as-is
  }

  // Paste files while editing (a screenshot, a PDF or any file copied from
  // the file manager) → upload and insert the markdown at the cursor: images
  // inline, the rest as file chips. A single-URL text paste inserts the URL
  // and opens the "Paste as" chooser. Other text falls through to the
  // browser default.
  async function handleEditorPaste(e) {
    const files = clipboardFiles(e);
    if (!files.length) {
      const ta = ref.current;
      // A clipboard that IS one html table (Excel / Sheets / a copied
      // rendered table) pastes as a markdown table.
      const html = e.clipboardData?.getData("text/html") || "";
      if (ta && /<table[\s>]/i.test(html)) {
        const md = htmlTableToMarkdown(html);
        if (md) {
          e.preventDefault();
          const start = ta.selectionStart, end = ta.selectionEnd;
          const val = ta.value || "";
          const lead = start > 0 && val[start - 1] !== "\n" ? "\n" : "";
          const trail = end < val.length && val[end] !== "\n" ? "\n" : "";
          const insert = lead + md + trail;
          ta.view?.dispatch({
            changes: { from: start, to: end, insert },
            selection: { anchor: start + lead.length + md.length },
            userEvent: "input",
          });
          return;
        }
      }
      // CRLF must not reach a CodeMirror dispatch — the state rejects "\r",
      // which would swallow the paste after preventDefault already fired.
      const text = (e.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n").trim();
      if (ta && /^https?:\/\/\S+$/i.test(text)) {
        e.preventDefault();
        const start = ta.selectionStart;
        ta.view?.dispatch({
          changes: { from: start, to: ta.selectionEnd, insert: text },
          selection: { anchor: start + text.length },
          userEvent: "input",
        });
        let blockId = null;
        try {
          const b = new URL(text).searchParams.get("block");
          if (b && /^[a-zA-Z0-9_-]+$/.test(b)) blockId = b;
        } catch (_) {}
        const anchor = ta.caretCoords(start);
        // After the onChange the dispatch just fired (it clears pasteMenu).
        requestAnimationFrame(() => {
          setPasteMenu({ start, end: start + text.length, url: text, items: pasteAsItems(blockId), anchor });
          setPasteIdx(0);
        });
        return;
      }
      // Structured text — spreadsheet cells (strict TSV) or a multi-line
      // outline — pastes as-is and offers the chooser, same pattern as URLs.
      const tsvMd = ta ? tsvToMarkdown(text) : null;
      const multiline = text.split("\n").filter((l) => l.trim()).length >= 2;
      if (ta && ta.view && onPasteBlocks && (tsvMd || multiline)) {
        e.preventDefault();
        const start = ta.selectionStart;
        ta.view?.dispatch({
          changes: { from: start, to: ta.selectionEnd, insert: text },
          selection: { anchor: start + text.length },
          userEvent: "input",
        });
        const items = [
          ...(tsvMd ? [{ name: "table", glyph: "▦", label: "Table", hint: "markdown table", block: true, make: () => tsvMd }] : []),
          { name: "text", glyph: "¶", label: "Text", hint: "keep in this block" },
          { name: "blocks", glyph: "≡", label: "Blocks", hint: "split into nested blocks" },
        ];
        const anchor = ta.caretCoords(start);
        requestAnimationFrame(() => {
          setPasteMenu({ start, end: start + text.length, url: text, items, anchor });
          setPasteIdx(0);
        });
      }
      return;
    }
    e.preventDefault();
    const ta = ref.current;
    // Capture the cursor now — the upload takes a beat and focus may move.
    const start = ta ? ta.selectionStart : null;
    const end = ta ? ta.selectionEnd : null;
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    let md;
    try { md = (await uploadFilesAsLines(files)).join("\n"); } finally { uploadingRef.current = false; }
    if (!md) return;
    const val = (ta ? ta.value : block.content) || "";
    if (start != null) {
      onChangeText(block.id, val.slice(0, start) + md + val.slice(end));
      requestAnimationFrame(() => {
        try { ta.setSelectionRange(start + md.length, start + md.length); } catch (_) {}
      });
    } else {
      onChangeText(block.id, val + "\n" + md);
    }
  }

  return (
    <div className={`blockRowWrap${fileDragOver ? " fileDragOver" : ""}`} data-block-id={block.id}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer?.types || []).includes("Files")) {
          handleFileDragOver(e);
          return;
        }
        onBlockDragOver?.(e, block);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        handleFileDragLeave(e);
        onBlockDragLeave?.();
      }}
      onDrop={(e) => {
        if (Array.from(e.dataTransfer?.types || []).includes("Files")) {
          handleFileDrop(e);
          return;
        }
        onBlockDrop?.(e, block);
      }}
    >
      {rowPeers?.length ? <PeerChips peers={rowPeers} /> : null}
      <div
        className={`blockRow ${focusedId === block.id ? "focused" : ""}${aiMark ? ` ai-${aiMark.kind} aiMark${aiMark.n % 2}` : ""}${scanIdx != null ? ` ai-scan aiMark${aiScan.n % 2}` : ""}${peerEditing ? ` peerOn peer-${peerEditing.color}` : ""}`}
        style={scanIdx != null ? { animationDelay: `${Math.min(scanIdx * 45, 1600)}ms` } : undefined}
        onMouseDown={(e) => {
          if (e.button !== 0) return; // right-click is the context menu's
          if (e.target.closest("button, textarea, input, a")) return;
          setFocusedId(block.id);
          // Clicking anywhere on a highlight's card jumps the PDF to it —
          // not just the little colored dot. Ctrl+click appends the quote to
          // the chat selection, same as clicking the highlight on the PDF.
          if (block.highlightId) onJump?.(block.highlightId, e.ctrlKey || e.metaKey);
          // A native handwriting block: clicking its row or picture asks the
          // viewer for the strokes themselves. The caption still opens for
          // editing, but a click ON the picture only jumps — the picture is
          // not text to place a caret in.
          else if (isNativeInk) {
            onNativeInkJump?.(block.id);
            if (e.target.closest("figure")) return;
          }
          // Ctrl on any other block: decided on click (below) — a Ctrl+drag
          // selects note text for a chip instead, so the editor must not open
          // and the selection must be allowed to start.
          else if ((e.ctrlKey || e.metaKey) && onAddToChat && !block.editMode) return;
          if (!readOnly && !block.editMode) {
            clickPosRef.current = { x: e.clientX, y: e.clientY };
            e.preventDefault();
            onStartEdit(block.id, true);
          }
        }}
        onClick={(e) => {
          // Ctrl+click attaches the block to the next chat message (a chip
          // with its id, so the agent can edit it) — unless the gesture
          // selected text, which App's mouseup turned into a note chip.
          if (!(e.ctrlKey || e.metaKey) || !onAddToChat || block.highlightId || block.editMode) return;
          if (e.target.closest("button, textarea, input, a")) return;
          if (window.getSelection()?.toString().trim()) return;
          e.preventDefault();
          onAddToChat(block);
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
              onClick={(e) => { e.stopPropagation(); onJump(block.highlightId, e.ctrlKey || e.metaKey); }}
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
        ) : isNativeInk && !block.editMode ? (
          <button
            className="collapseBtn dotSlot inkDotBtn"
            title="Jump to handwriting"
            aria-label="Jump to handwriting"
            onClick={(e) => { e.stopPropagation(); onNativeInkJump?.(block.id); }}
          >
            <span className="inkDot" aria-hidden="true">✎</span>
          </button>
        ) : isInk && !block.editMode ? (
          <button
            className="collapseBtn highlightDotBtn dotSlot"
            onClick={(e) => { e.stopPropagation(); onInkJump?.(block.id); }}
            title={block.page ? `Handwriting on page ${block.page} — click to show it` : "Handwriting"}
          >
            <span className="inkMarker"><PenIcon size={9} strokeWidth={2.4} /></span>
          </button>
        ) : (
          <span className="dotSlot dotSlotEmpty"><span className="noteBulletDot" /></span>
        )}

        <div className="blockBody">
          <div className="blockMeta">
            {block.page ? `p.${block.page}` : "note"}
          </div>

          {!readOnly && block.editMode ? (
            <BlockCmEditor
              ref={ref}
              autoFocus
              className="blockEditor blockEditorCm"
              dataBlockId={block.id}
              clickPos={clickPosRef.current}
              refLabels={refLabels}
              remoteCursors={remoteCursors}
              value={block.content || ""}
              onChange={(e) => {
                onChangeText(block.id, e.target.value, e.selectionBefore);
                onCaret?.(block.id, e.target.selectionStart, e.target.selectionEnd);
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
                setPasteMenu(null);
              }}
              onSelect={(e) => {
                onCaret?.(block.id, e.target.selectionStart, e.target.selectionEnd);
                updateMathUi(e.target, false); updateSlashMenu(e.target, false); setPasteMenu(null);
              }}
              onBlur={() => {
                onStartEdit(block.id, false);
                setMathUi(null);
                setSlashMenu(null);
                setPasteMenu(null);
                setTimeout(() => setRefPopup(null), 120);
              }}
              onPaste={handleEditorPaste}
              onKeyDown={(e) => {
                if (pasteMenu) {
                  const n = pasteMenu.items.length;
                  if (e.key === "ArrowDown") { e.preventDefault(); setPasteIdx((i) => Math.min(i + 1, n - 1)); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setPasteIdx((i) => Math.max(i - 1, 0)); return; }
                  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyPasteAs(pasteMenu.items[pasteIdx]); return; }
                  if (e.key === "Escape") { e.preventDefault(); setPasteMenu(null); return; }
                }
                if (refPopup && searchResults.length > 0) {
                  if (e.key === "ArrowDown") { e.preventDefault(); setRefSelectedIdx((i) => Math.min(i + 1, searchResults.length - 1)); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setRefSelectedIdx((i) => Math.max(i - 1, 0)); return; }
                  if (e.key === "Enter") { e.preventDefault(); insertRef(searchResults[refSelectedIdx]); return; }
                  if (e.key === "Escape") { e.preventDefault(); setRefPopup(null); return; }
                }
                if (slashMenu) {
                  const n = slashMenu.items.length;
                  if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => Math.min(i + 1, n - 1)); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => Math.max(i - 1, 0)); return; }
                  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); runSlashCommand(slashMenu.items[slashIdx]); return; }
                  if (e.key === "Escape") { e.preventDefault(); setSlashMenu(null); return; }
                }
                if (mathUi?.ac) {
                  const n = mathUi.ac.items.length;
                  if (e.key === "ArrowDown") { e.preventDefault(); setMathAcIdx((i) => Math.min(i + 1, n - 1)); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setMathAcIdx((i) => Math.max(i - 1, 0)); return; }
                  if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); acceptLatexAc(mathUi.ac.items[mathAcIdx]); return; }
                  if (e.key === "Escape") { e.preventDefault(); setMathUi((u) => u ? { ...u, ac: null } : null); return; }
                }
                // Tab inside raw math (popup closed) hops between argument
                // groups snippet-style — \frac{1|}{} lands in the second {} —
                // Shift+Tab hops back. Only when there's somewhere to go;
                // otherwise Tab falls through to the outliner's indent.
                if (e.key === "Tab" && ref.current) {
                  const ta = ref.current;
                  const origin = e.shiftKey ? ta.selectionStart : ta.selectionEnd;
                  const jump = !fenceInnerAt(ta.value, origin)
                    && mathTabJump(ta.value, origin, e.shiftKey ? -1 : 1);
                  if (jump) {
                    e.preventDefault();
                    ta.setSelectionRange(jump.anchor, jump.head);
                    updateMathUi(ta, false);
                    return;
                  }
                }
                // Inside a ``` fence the outliner keys turn code-editor:
                // any Enter is a line break (never a new note) and Tab
                // indents with spaces instead of nesting the block. Enter
                // inside $$ display math (closed, or still open while being
                // typed) is a line break too — a multi-line \begin{array}
                // would otherwise split into a new note on every row.
                const inFence = (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey))
                  && ref.current && fenceInnerAt(ref.current.value, ref.current.selectionStart);
                const inDisplayMath = !inFence && e.key === "Enter" && ref.current
                  && !!findMathAtCursor(ref.current.value, ref.current.selectionStart)?.display;
                if (inFence || inDisplayMath) {
                  const ta = ref.current;
                  const selStart = ta.selectionStart, selEnd = ta.selectionEnd;
                  e.preventDefault();
                  const ins = e.key === "Enter" ? "\n" : "  ";
                  ta.view?.dispatch({
                    changes: { from: selStart, to: selEnd, insert: ins },
                    selection: { anchor: selStart + ins.length },
                    userEvent: "input",
                  });
                  return;
                }
                // Which Enter starts a new note is a preference (Settings →
                // Notes); the other one falls through to a plain line break.
                const newNoteKey = enterNewNote ? !e.shiftKey : e.shiftKey;
                if (e.key === "Enter" && newNoteKey) {
                  e.preventDefault();
                  onEnterSibling(block.id);
                } else if (e.key === "Enter") {
                  // The line-break Enter continues markdown lists/quotes
                  // (Obsidian-style): "- [ ] foo⏎" starts the next line with
                  // "- [ ] "; Enter on an empty marker line removes the
                  // marker (ends the list). No marker → plain newline.
                  const ta = ref.current;
                  const cursor = ta?.selectionStart;
                  if (ta && cursor === ta.selectionEnd) {
                    const val = ta.value;
                    const lineStart = val.lastIndexOf("\n", cursor - 1) + 1;
                    const lineText = val.slice(lineStart, cursor);
                    const m = lineText.match(/^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+\. |> )/);
                    if (m) {
                      e.preventDefault();
                      // Atomic CM dispatch (change + caret together) — the
                      // onChangeText round-trip with a deferred caret would
                      // race with the next keystrokes.
                      if (lineText.length === m[0].length) {
                        ta.view?.dispatch({
                          changes: { from: lineStart, to: cursor, insert: "" },
                          selection: { anchor: lineStart },
                          userEvent: "delete",
                        });
                      } else {
                        let marker = m[0].replace(/\[[xX]\]/, "[ ]");
                        const num = marker.match(/^(\s*)(\d+)\. $/);
                        if (num) marker = `${num[1]}${Number(num[2]) + 1}. `;
                        ta.view?.dispatch({
                          changes: { from: cursor, to: cursor, insert: "\n" + marker },
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
                } else if (e.key === "ArrowRight" && (block.children?.length || 0) > 0 && block.collapsed) {
                  e.preventDefault();
                  onToggle(block.id);
                } else if (e.key === "ArrowLeft" && (block.children?.length || 0) > 0 && !block.collapsed) {
                  e.preventDefault();
                  onToggle(block.id);
                } else if (e.key === "Backspace" && (block._isEmpty || !(block.content || "").trim()) && !(block.quote || "").trim()
                  // A native handwriting block is not just its caption: an
                  // empty caption must not turn one Backspace into "delete the
                  // strokes' block" (the iPad owns that source).
                  && block.properties?.type !== "pdf_ink") {
                  e.preventDefault();
                  onDelete(block.id);
                }
              }}
              placeholder="Type — '/' for commands"
            />
          ) : aiText != null ? (
            // The AI agent is writing this block's new text right now: show
            // what it has streamed so far, with a caret, in place of the
            // stored content (the tree reloads once the edit is applied).
            <div className="blockRendered aiStreaming">
              {aiText.trim() ? <BlockMarkdown content={aiText} blockId={block.id} refLabels={refLabels} /> : null}
            </div>
          ) : (
            <div className="blockRendered" onCopy={handleMarkdownCopy}>
              {(block.content || "").trim() ? (
                <BlockMarkdown content={block.content || ""} blockId={block.id} refLabels={refLabels} onBlockRefClick={stableRefClick}
                  onTaskToggle={readOnly ? undefined : stableTaskToggle}
                  onEmbedEdit={readOnly ? undefined : stableEmbedEdit}
                  onImageEdit={readOnly ? undefined : stableImageEdit}
                  onTableEdit={readOnly ? undefined : stableTableEdit} />
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
          {block.position?.area && captureArea ? (
            <AreaSnapshot block={block} captureArea={captureArea} docNonce={docNonce} />
          ) : null}
          {isInk ? <InkCard block={block} onJump={onInkJump} /> : null}
          {isNativeInk ? <NativeInkPreview block={block} data={nativeInkPreviews?.[block.id]?.data} /> : null}
          <NativeAudioPreview block={block} readOnly={readOnly} />
          {(block.properties?.link_url || block.properties?.link_page_id) ? (
            <button
              type="button"
              className="blockLinkChip"
              title={block.properties.link_url || "Open linked page"}
              onClick={(e) => { e.stopPropagation(); onOpenLinkTarget?.(block); }}
            >
              <LinkIcon size={11} strokeWidth={2.4} />
              {block.properties.link_page_id
                ? "linked page"
                : (block.properties.link_url || "").replace(/^https?:\/\//i, "").slice(0, 48)}
            </button>
          ) : null}
        </div>
        {!readOnly && block.id !== "root" ? (
          <button
            className="uiClose uiCloseSm uiCloseDanger blockDeleteBtn"
            title="Delete block"
            onClick={(e) => { e.stopPropagation(); onDelete(block.id); }}
          >×</button>
        ) : null}
      </div>
      {!readOnly && block.editMode && mathUi ? (
        <>
          <MathLivePreview tex={mathUi.tex} display={mathUi.display} anchor={mathUi.anchor} />
          {mathUi.ac ? (
            <LatexAcPopup items={mathUi.ac.items} selected={mathAcIdx} anchor={mathUi.anchor} onPick={acceptLatexAc} />
          ) : null}
        </>
      ) : null}
      {!readOnly && block.editMode && slashMenu ? (
        <SlashMenuPopup items={slashMenu.items} selected={slashIdx} anchor={slashMenu.anchor} onPick={runSlashCommand} />
      ) : null}
      {!readOnly && block.editMode && pasteMenu ? (
        <SlashMenuPopup title="Paste as" items={pasteMenu.items} selected={pasteIdx} anchor={pasteMenu.anchor} onPick={applyPasteAs} />
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

// Block subtree → a markdown outline: each block one "- " bullet (extra
// content lines hang under it), children indented two spaces deeper.
function subtreeMarkdown(b, depth) {
  const indent = "  ".repeat(depth);
  const own = (b.content || "").split("\n")
    .map((l, i) => (i === 0 ? `${indent}- ` : `${indent}  `) + l)
    .join("\n");
  return [own, ...(b.children || []).map((c) => subtreeMarkdown(c, depth + 1))].join("\n");
}

// Copying or moving an ordinary ancestor also carries every native manifest
// beneath it. Same-page nesting is separate: it changes no payload or page scope.
function subtreeClaimsNative(block) {
  return isNativeClaim(block.properties) || (block.children || []).some(subtreeClaimsNative);
}

function SortableBlockRow({ block, ...rowProps }) {
  const depth = rowProps.depth || 0;
  // Notion-style handle: drag moves the block, a plain click opens the block
  // menu (copy link / reference / embed, delete).
  const [handleMenu, setHandleMenu] = useState(null); // {x, y}
  const draggedRef = useRef(false);
  // A block carrying a native payload (a `pdf_ink`/`audio` annotation, or a note
  // beneath one) is owned by the iPad endpoints: the server refuses a generic
  // copy (`guard_generic_insert`), and moving an annotation to another page would
  // detach it from the document its writer validates. Those two rows are
  // disabled HERE, with the reason, rather than offered and then dropped by the
  // resync that follows a rejected batch.
  const nativeClaim = subtreeClaimsNative(block);

  function onDragStart(e) {
    e.dataTransfer.setData("text/plain", block.id);
    e.dataTransfer.effectAllowed = "move";
    _dragState.draggingId = block.id;
    draggedRef.current = true;
  }

  function onDragEnd() {
    _dragState.draggingId = null;
    _dragState.dropTarget = null;
    window._gammaSetDropTarget?.(null);
    // Clear AFTER any click the drop gesture might synthesize.
    setTimeout(() => { draggedRef.current = false; }, 0);
  }

  function onHandleClick(e) {
    if (draggedRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    setHandleMenu({ x: e.clientX, y: e.clientY });
  }

  const copy = (text, msg) => {
    setHandleMenu(null);
    copyText(text);
    rowProps.onStatus?.(msg);
  };

  // Notion's "+": a new empty block below this one (Alt+click: above) — the
  // same path as Enter.
  function onAddClick(e) {
    e.preventDefault();
    e.stopPropagation();
    rowProps.onEnterSibling?.(block.id, { above: e.altKey });
  }

  return (
    <div className="sortableBlockWrap" data-block-id={block.id} data-depth={depth}>
      {/* One narrow gutter column: ⋮⋮ (drag / menu) with the "+" (add a
          block) sitting right under it, shown only while the row is hovered. */}
      <span className="rowHandles">
        <span
          className="dragHandle"
          draggable="true"
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onClick={onHandleClick}
          aria-label="Drag to move, click for menu"
          title="Drag to move · click for menu"
        >⋮⋮</span>
        {block.id !== "root" && rowProps.onEnterSibling && !rowProps.readOnly ? (
          <button
            type="button"
            className="addHandle"
            onClick={onAddClick}
            onMouseDown={(e) => e.preventDefault()}
            aria-label="Add a block below (Alt+click: above)"
            title={"Click to add a block below\nAlt+click to add above"}
          ><PlusIcon size={15} strokeWidth={2} /></button>
        ) : null}
      </span>
      {handleMenu ? (
        <ContextMenu x={handleMenu.x} y={handleMenu.y} onClose={() => setHandleMenu(null)}>
          <MenuItem
            icon={LinkIcon}
            title="Paste it in a note to choose mention / synced block, or open it anywhere"
            onClick={() => copy(
              withWorkspace(`${window.location.origin}/?block=${encodeURIComponent(block.id)}`),
              "Block link copied — paste into a note for mention / synced block",
            )}
          >Copy link to block</MenuItem>
          <MenuItem
            icon={CopyIcon}
            title="Copy this block's markdown source (sub-blocks become an indented list)"
            onClick={() => copy(
              block.children?.length ? subtreeMarkdown(block, 0) : block.content || "",
              "Copied block as markdown",
            )}
          >Copy as markdown</MenuItem>
          {block.id !== "root" && rowProps.onAddToChat ? (
            <MenuItem
              icon={MessageSquareIcon}
              title="Attach this block (with its sub-blocks) to your next chat message — Ctrl+click a block does the same"
              onClick={() => { setHandleMenu(null); rowProps.onAddToChat(block); }}
            >Add to chat</MenuItem>
          ) : null}
          {block.id !== "root" ? (
            <MenuItem
              icon={CopyIcon}
              disabled={nativeClaim}
              title={nativeClaim ? NATIVE_CONTROL_REASON : "Insert a copy below (sub-blocks included; highlight anchors are not copied)"}
              onClick={() => { setHandleMenu(null); rowProps.onDuplicate?.(block.id); }}
            >Duplicate</MenuItem>
          ) : null}
          {block.id !== "root" ? (
            <MenuItem
              icon={ExportIcon}
              disabled={nativeClaim}
              title={nativeClaim
                ? "An iPad annotation belongs to its page and its document — moving it elsewhere is not supported"
                : "Move this block and its sub-blocks to the end of another page"}
              onClick={() => { setHandleMenu(null); rowProps.onMoveToPage?.(block.id); }}
            >Move to page…</MenuItem>
          ) : null}
          {block.id !== "root" ? (
            <MenuItem
              icon={Trash2Icon}
              danger
              onClick={() => { setHandleMenu(null); rowProps.onDelete?.(block.id); }}
            >Delete</MenuItem>
          ) : null}
        </ContextMenu>
      ) : null}
      <BlockRow block={block} {...rowProps} />
    </div>
  );
}

// The stored text plus an addition the agent is appending/prepending (an
// edit_block call with mode "append"/"prepend", previewed while it streams):
// mirrors backend ai_tools.join_block_text — own line, blank line when either
// side is a paragraph-level construct. Mode "replace" is just the new text.
const BLOCKY_LINE = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|\$\$|---)/;
function joinBlockText(existing, addition, mode) {
  if (mode !== "append" && mode !== "prepend") return addition;
  const cur = (existing || "").replace(/\n+$/, "");
  const add = (addition || "").replace(/^\n+|\n+$/g, "");
  if (!cur) return add;
  const [head, tail] = mode === "prepend" ? [add, cur] : [cur, add];
  const sep = head.includes("\n") || tail.includes("\n") || BLOCKY_LINE.test(tail) || BLOCKY_LINE.test(head) ? "\n\n" : "\n";
  return head + sep + tail;
}

// A block the AI agent is creating right now (a create_block call still
// streaming): a read-only row at the position the block will take, typing
// in the markdown as it arrives. Replaced by the real block when the call
// lands and the tree reloads.
function AiGhostRow({ content, depth }) {
  return (
    <div className="sortableBlockWrap aiGhostWrap" data-depth={depth}>
      {/* Inert stand-in for the handle column (hidden in CSS). */}
      <span className="rowHandles" aria-hidden="true"><span className="dragHandle" /></span>
      <div className="blockRowWrap">
        <div className="blockRow ai-create aiMark0">
          <span className="collapseSpacer" />
          <span className="dotSlot dotSlotEmpty"><span className="noteBulletDot" /></span>
          <div className="blockBody">
            <div className="blockMeta">note</div>
            <div className="blockRendered aiStreaming">
              {content.trim() ? <BlockMarkdown content={content} blockId="ai-ghost" refLabels={{}} /> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// `parentId` is the block whose children these are (the page root when
// omitted: rowProps.rootId) — it places the agent's ghost row (rowProps.aiLive
// for a create_block still streaming) under the right parent, after the
// sibling the call names (at the end when it names none or an unknown one).
function BlockTree({ blocks, readOnly, rowProps, depth = 0, parentId }) {
  const live = rowProps.aiLive;
  const ghost = live?.tool === "create_block" && live.parentId === (parentId ?? rowProps.rootId) ? live : null;
  if ((!blocks || blocks.length === 0) && !ghost) return null;
  const list = blocks || [];
  let ghostAt = ghost ? list.length : -1;
  if (ghost && ghost.afterId) {
    const i = list.findIndex((b) => b.id === ghost.afterId);
    if (i >= 0) ghostAt = i + 1;
  }
  const ghostRow = ghost ? <AiGhostRow key="ai-ghost" content={ghost.content || ""} depth={depth} /> : null;
  return (
    <>
      {ghostAt === 0 ? ghostRow : null}
      {list.map((rawBlock, idx) => { const block = withLegacyAccessors(rawBlock); return (
        <React.Fragment key={block.id}>
          {!readOnly ? (
            <SortableBlockRow block={block} depth={depth} {...rowProps} />
          ) : (
            <BlockRow block={block} depth={depth} {...rowProps} />
          )}
          {!block.collapsed && (block.children?.length > 0 || live?.parentId === block.id) ? (
            <div className="blockChildren">
              <BlockTree blocks={block.children} readOnly={readOnly} rowProps={rowProps} depth={depth + 1} parentId={block.id} />
            </div>
          ) : null}
          {ghostAt === idx + 1 ? ghostRow : null}
        </React.Fragment>
      );})}
    </>
  );
}

export { BlockTree, _dragState };
