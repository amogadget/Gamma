// Shared presentational widgets: workspace chrome, dockable windows, chat
// markdown, and the auto-growing textarea.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  FileTextIcon,
  HighlightIcon,
  ImportIcon,
  PaperclipIcon,
  PenIcon,
  PinIcon,
  ScissorsIcon,
} from "./icons";
import { MenuSelect } from "./menus";

// Shared chrome for every dockable window: one grip (drag to move/reorder,
// double-click to collapse), the close button right beside it, then the
// window's own controls. Notes and chat both use this so their behavior
// can't drift apart.
function DockWindow({
  title,
  onGrip,
  onGripDoubleClick,
  onClose,
  headerContent,
  collapsed,
  children,
}) {
  return (
    <div className={`dockWindow ${collapsed ? "collapsed" : ""}`}>
      <div className="dockWindowHeader">
        <span
          className="dockGrip"
          onPointerDown={onGrip}
          onDoubleClick={onGripDoubleClick}
          title="Drag to move this window · double-click to collapse/expand"
        >
          ⠿ {title}
        </span>
        {onClose ? (
          <button
            className="uiClose"
            onClick={onClose}
            title="Close window (reopen from the ⋮ menu)"
            aria-label={`Close ${title}`}
          >
            ×
          </button>
        ) : null}
        <span className="dockHeaderSpacer" />
        {collapsed ? null : headerContent}
      </div>
      {collapsed ? null : <div className="dockWindowBody">{children}</div>}
    </div>
  );
}

// Markdown + KaTeX rendering for AI chat messages. Unlike block rendering this
// deliberately omits rehypeRaw: model output is untrusted, so raw HTML stays inert.
// Models often emit \( \) / \[ \] LaTeX delimiters, which remark-math doesn't
// recognize — normalize them to $ / $$ so math always renders.
// Memoized: the chat input re-renders all of ChatDock on every keystroke,
// and without the memo each keypress re-ran ReactMarkdown + KaTeX over every
// AI message in the conversation — visible typing lag on long chats.
// Selecting rendered chat/note text and hitting Ctrl+C would copy the plain
// rendered characters — **bold**, *italics*, `code`, links, and list markers
// all vanish, and KaTeX's double DOM (hidden MathML + visual layer) duplicates
// every symbol. Instead, serialize the copied selection back to markdown
// source for text/plain (paste into a note or any editor keeps the
// formatting), and keep the formatted fragment as text/html for rich targets
// like Word. Formulas become their LaTeX source (KaTeX keeps it in an
// <annotation encoding="application/x-tex">).
function fragmentToMarkdown(node, ctx = {}) {
  if (node.nodeType === Node.TEXT_NODE) {
    return ctx.pre ? node.textContent : node.textContent.replace(/\s+/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node;
  if (el.classList.contains("katex-display")) {
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    return tex != null ? `\n\n$$\n${tex.trim()}\n$$\n\n` : el.textContent;
  }
  if (el.classList.contains("katex")) {
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    return tex != null ? `$${tex.trim()}$` : el.textContent;
  }
  const kids = (c = ctx) => Array.from(el.childNodes).map((n) => fragmentToMarkdown(n, c)).join("");
  // Inline markers hug the text: whitespace at the edges of <strong>bold </strong>
  // must stay outside the ** or the markdown doesn't parse back.
  const wrap = (marker) => {
    const raw = kids();
    const inner = raw.trim();
    return inner ? `${raw.match(/^\s*/)[0]}${marker}${inner}${marker}${raw.match(/\s*$/)[0]}` : raw;
  };
  switch (el.tagName) {
    case "STRONG": case "B": return wrap("**");
    case "EM": case "I": return wrap("*");
    case "DEL": case "S": return wrap("~~");
    case "CODE": return ctx.pre ? el.textContent : `\`${el.textContent}\``;
    case "PRE": return `\n\n\`\`\`\n${el.textContent.replace(/\n$/, "")}\n\`\`\`\n\n`;
    case "A": {
      const href = el.getAttribute("href") || "";
      if (href.startsWith("blockref:")) return `[[${href.slice(9)}]]`; // note ref chips round-trip
      const inner = kids().trim();
      return href ? `[${inner || href}](${href})` : inner;
    }
    case "IMG": return `![${el.getAttribute("alt") || ""}](${el.getAttribute("src") || ""})`;
    case "BR": return "\n";
    case "HR": return "\n\n---\n\n";
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
      return `\n\n${"#".repeat(Number(el.tagName[1]))} ${kids().trim()}\n\n`;
    case "UL": case "OL": {
      const indent = "  ".repeat(ctx.listDepth || 0);
      const items = Array.from(el.children).filter((c) => c.tagName === "LI").map((li, i) => {
        const marker = el.tagName === "OL" ? `${(Number(el.getAttribute("start")) || 1) + i}. ` : "- ";
        const inner = Array.from(li.childNodes)
          .map((n) => fragmentToMarkdown(n, { ...ctx, listDepth: (ctx.listDepth || 0) + 1 }))
          .join("").replace(/^\n+|\n+$/g, "");
        return `${indent}${marker}${inner.replace(/\n+/g, "\n").replace(/\n/g, `\n${indent}  `)}`;
      });
      return `\n\n${items.join("\n")}\n\n`;
    }
    case "BLOCKQUOTE":
      return `\n\n${kids().trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
    case "TABLE": {
      const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
        `| ${Array.from(tr.children).map((td) => kidsOf(td).trim().replace(/\|/g, "\\|") || " ").join(" | ")} |`);
      function kidsOf(td) { return Array.from(td.childNodes).map((n) => fragmentToMarkdown(n, ctx)).join(""); }
      if (!rows.length) return "";
      const cols = el.querySelector("tr")?.children.length || 1;
      rows.splice(1, 0, `| ${Array(cols).fill("---").join(" | ")} |`);
      return `\n\n${rows.join("\n")}\n\n`;
    }
    case "P": case "DIV": case "LI": return `\n\n${kids().trim()}\n\n`;
    default: return kids();
  }
}

function handleMarkdownCopy(e) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !e.clipboardData) return;
  const holder = document.createElement("div");
  for (let i = 0; i < sel.rangeCount; i++) holder.appendChild(sel.getRangeAt(i).cloneContents());
  const md = Array.from(holder.childNodes).map((n) => fragmentToMarkdown(n))
    .join("").replace(/\n{3,}/g, "\n\n").trim();
  if (!md) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", md);
  e.clipboardData.setData("text/html", holder.innerHTML);
}

const ChatMarkdown = React.memo(function ChatMarkdown({ text }) {
  const normalized = useMemo(
    () =>
      (text || "")
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `\n$$\n${m}\n$$\n`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m}$`),
    [text],
  );
  return (
    <div onCopy={handleMarkdownCopy}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});

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

// Copy-confirmation flash: `copied` holds whatever key was passed to `flash`
// (true, a message index, "bibtex", …) and reverts to null after `ms`.
// One definition for chat messages, the citation buttons, and the share
// dialog, so the confirm timing can't drift apart.
function useCopied(ms = 1500) {
  const [copied, setCopied] = useState(null);
  const flash = useCallback(
    (key = true) => {
      setCopied(key);
      setTimeout(() => setCopied((cur) => (cur === key ? null : cur)), ms);
    },
    [ms],
  );
  const reset = useCallback(() => setCopied(null), []);
  return [copied, flash, reset];
}

function PopoverAnchor({ name, children, className = "" }) {
  return (
    <span data-popover={name} className={`popoverAnchor ${className}`.trim()}>
      {children}
    </span>
  );
}

function OpenTabs({ tabs, activeId, tabElements, onReorder, onOpen, onClose, onContext }) {
  // Drag-reorder bookkeeping is private to the strip: the dragged tab id as a
  // ref (read during dragover) with a state twin for the .dragging style.
  const dragTab = useRef(null);
  const [draggingId, setDraggingId] = useState(null);
  return (
    <div className="tabStrip" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          ref={(element) => {
            if (element) tabElements.current.set(tab.id, element);
            else tabElements.current.delete(tab.id);
          }}
          className={`tab ${tab.id === activeId ? "active" : ""} ${draggingId === tab.id ? "dragging" : ""} ${tab.pinned ? "pinned" : ""}`}
          title={tab.title}
          draggable
          onDragStart={(event) => {
            dragTab.current = tab.id;
            setDraggingId(tab.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            dragTab.current = null;
            setDraggingId(null);
          }}
          onDragOver={(event) => {
            const draggedId = dragTab.current;
            if (!draggedId || draggedId === tab.id) return;
            event.preventDefault();
            onReorder(draggedId, tab.id);
          }}
          onDrop={(event) => event.preventDefault()}
          onClick={() => {
            if (tab.id !== activeId) onOpen(tab.id);
          }}
          onAuxClick={(event) => {
            // Middle-click close skips pinned tabs — pinning is a guard
            // against exactly this kind of accidental close.
            if (event.button === 1 && !tab.pinned) {
              event.preventDefault();
              onClose(tab.id);
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            onContext(tab, event.clientX, event.clientY);
          }}
        >
          {tab.pinned ? (
            <span className="tabPin">
              <PinIcon filled size={11} />
            </span>
          ) : null}
          <span className="tabTitle">{tab.title}</span>
          {tab.pinned ? null : (
            <button
              className="uiClose tabClose"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
              title="Close tab"
              aria-label={`Close ${tab.title}`}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// The one export dialog behind the ⋮ menu's "Export…" — a format picker plus
// switches, instead of one menu item per combination. What each switch means
// depends on the format (annotations vs. blockquotes), so the descriptions and
// the one-line summary above the buttons are written per format; a switch that
// the format can't honour is shown disabled rather than hidden, so the choice
// on offer never changes shape between formats.
const EXPORT_FORMATS = [
  ["pdf", "PDF (the paper, annotated)"],
  ["notespdf", "Notes as PDF"],
  ["markdown", "Markdown (.md)"],
  ["logseq", "Logseq graph (.zip)"],
  ["zotero", "Zotero RDF (.zip)"],
  ["gamma", "Gamma (.zip)"],
];

// What the Highlights / Notes / Bundle switches mean per format: a short hint
// under the label, the long explanation on hover. Formats missing a key fall
// back to nothing (the switch is hidden or pinned there).
const EXPORT_SWITCH_TEXT = {
  highlights: {
    pdf: ["Standard PDF annotations",
      "Burned in as standard PDF annotations — they survive in Acrobat, SumatraPDF, browsers."],
    notespdf: ["Quoted passages with page numbers",
      "Each highlighted passage as a quote with its page number, in the colour you highlighted it."],
    markdown: ["Blockquotes with page numbers",
      "Each highlighted passage as a blockquote with its page number."],
    logseq: ["Always in a graph (hls page + .edn)",
      "Always included: a graph's highlights are its hls page and .edn."],
    zotero: ["Embedded into the exported PDF copies",
      "Written into the exported PDF copies as standard annotations — Zotero's own “Include Annotations” convention, its reader picks them up on import."],
    gamma: ["Always — a Gamma export is a 1:1 copy",
      "A Gamma export carries the pages exactly as they are, highlights included."],
  },
  notes: {
    pdf: ["Printed onto the page in free space",
      "Printed onto the page in nearby free space, with a line back to the highlight. Off: they stay in the annotation popups."],
    notespdf: ["Typeset under their highlights",
      "Your own writing, typeset under the highlight it belongs to — headings, lists, code, math and pasted images included."],
    markdown: ["Nested under their highlights",
      "Your own writing, nested under the highlight it belongs to."],
    logseq: ["Always in a graph",
      "Always included: the graph's notes page."],
    zotero: ["Zotero notes on each item",
      "Top-level notes become Zotero notes attached to the item; writing under a highlight travels in its annotation popup."],
    gamma: ["Always — a Gamma export is a 1:1 copy",
      "A Gamma export carries the pages exactly as they are, notes included."],
  },
  bundle: {
    markdown: ["Pack the PDF and images into the .zip",
      "Pack the PDF and any pasted images into the .zip. Off: they stay as links back to this server."],
    logseq: ["Pack the PDF and images into the .zip",
      "Pack the PDF and any pasted images into the .zip. Off: they stay as links back to this server."],
    zotero: ["Include the PDF files (Zotero's “Export Files”)",
      "Pack each paper's PDF into the .zip so Zotero imports the files too. Off: metadata, collections and notes only."],
    gamma: ["Every referenced file is included",
      "A Gamma export always bundles the PDFs and images the pages reference — the other Gamma needs them."],
  },
};

// Same row dialect as the settings panes (settings.jsx Row/Toggle): icon tile ·
// label · one short hint · control, with the long explanation on hover only.
function DialogRow({ icon: Icon, label, hint, title, off, children }) {
  return (
    <div className={`settingRow setRow ${off ? "settingRowOff" : ""}`} title={title}>
      <span className="setIcon">{Icon ? <Icon size={15} /> : null}</span>
      <span className="settingText">
        <span className="settingLabel">{label}</span>
        {hint ? <span className="settingDesc">{hint}</span> : null}
      </span>
      {children}
    </div>
  );
}

function SwitchRow({ checked, onChange, disabled, label, ...row }) {
  return (
    <DialogRow label={label} off={disabled} {...row}>
      <span className="switch">
        <input
          type="checkbox" checked={checked} disabled={disabled} aria-label={label}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="switchTrack" />
      </span>
    </DialogRow>
  );
}

function ExportDialog({ opts, setOpts, hasPdf, pdfStored, folder, allowGamma, onCancel, onExport }) {
  // A note page has no PDF to annotate; a PDF opened from a URL and not saved
  // here has no server copy either; a folder (`folder` = its path) is many
  // papers, so the annotated-paper format doesn't apply — those fall back to
  // "Notes as PDF", which needs no paper (it typesets the notes themselves).
  // An unavailable remembered choice never overwrites the standing preference.
  const allowPdf = hasPdf && !folder;
  const format = (opts.format !== "pdf" || allowPdf) ? (
    (opts.format !== "gamma" || allowGamma) ? opts.format : "markdown"
  ) : "notespdf";
  const isPdf = format === "pdf";
  const isDoc = format === "notespdf";
  const isGraph = format === "logseq";
  const isZotero = format === "zotero";
  const isGamma = format === "gamma";
  const set = (patch) => setOpts((o) => ({ ...o, ...patch }));

  // Graph and Gamma exports are lossless within their scope, so switches pin on.
  const pinned = isGraph || isGamma;
  const highlights = pinned ? true : opts.highlights;
  const notes = pinned ? true : opts.notes;
  const rawPdf = isPdf && !highlights && !notes;
  const noPdfCopy = isPdf && !pdfStored;
  // [hint, hover title] for one switch in the current format.
  const switchText = (name) => EXPORT_SWITCH_TEXT[name][format] || [];

  const summary = isGraph
    ? "A Logseq graph: the notes page plus native PDF highlights (hls page + .edn)."
    : isGamma
      ? `A 1:1 scoped copy${folder ? " of this folder" : " of this page"}: blocks, metadata, referenced files and matching AI chats. Importing in another Gamma merges missing data and never overwrites existing data.`
    : isZotero
      ? `A Zotero RDF library with metadata, tags${folder ? " and subfolders as collections" : ""}${opts.bundle ? `, PDF${folder ? "s" : ""}${highlights ? " with highlights embedded" : ""}` : ""}${notes ? ", and notes" : ""}. Unzip it before importing the .rdf.`
      : isPdf
        ? noPdfCopy
          ? "This PDF isn't stored on the server, so only the file itself can be exported."
          : rawPdf
            ? "The PDF file exactly as stored, with nothing added."
            : `The PDF with ${highlights ? "highlight annotations" : "no annotations"}${notes ? " and every note printed onto the page" : ""}.`
        : isDoc
          ? highlights || notes
            ? `A new PDF of ${folder ? "every page in the folder" : "this page"} — title, ${highlights ? "quoted highlights" : "no quotes"}${notes ? " and your notes, typeset" : ""}.`
            : "A new PDF with the title and metadata only — both switches are off."
          : highlights || notes
          ? `Markdown with ${highlights ? "quoted highlights" : "no quotes"}${notes ? " and your notes" : ""}.`
          : "Markdown with the title and metadata only — both switches are off.";

  return (
    <div className="reportOverlay" onClick={onCancel}>
      <div className="reportModal exportModal" onClick={(event) => event.stopPropagation()}>
        <div className="reportModalTitle">{folder ? `Export “${folder}”` : "Export"}</div>
        <DialogRow icon={FileTextIcon} label="Format">
          <MenuSelect
            label="Export format" value={format}
            onChange={(format) => set({ format })}
            options={EXPORT_FORMATS.filter(
              ([id]) => (id !== "pdf" || allowPdf) && (id !== "gamma" || allowGamma),
            )}
          />
        </DialogRow>
        <SwitchRow
          icon={HighlightIcon}
          label="Highlights"
          hint={switchText("highlights")[0]}
          title={switchText("highlights")[1]}
          checked={highlights}
          disabled={pinned || noPdfCopy}
          onChange={(v) => set({ highlights: v })}
        />
        <SwitchRow
          icon={PenIcon}
          label="Notes"
          hint={switchText("notes")[0]}
          title={switchText("notes")[1]}
          checked={notes}
          disabled={pinned || noPdfCopy}
          onChange={(v) => set({ notes: v })}
        />
        {isPdf || isDoc ? null : (
          <SwitchRow
            icon={PaperclipIcon}
            label="Bundle the files"
            hint={switchText("bundle")[0]}
            title={switchText("bundle")[1]}
            checked={isGamma ? true : opts.bundle}
            disabled={isGamma}
            onChange={(v) => set({ bundle: v })}
          />
        )}
        {isZotero ? (
          <div className="reportModalHint">
            <div><strong>1.</strong> Download the .zip.</div>
            <div><strong>2.</strong> Unzip it, keeping the .rdf and files/ folder together.</div>
            <div><strong>3.</strong> In Zotero choose File → Import… → A file, then select the .rdf—not the .zip.</div>
          </div>
        ) : (
          <div className="reportModalHint">{summary}</div>
        )}
        <div className="reportModalBtns">
          <button className="uiBtn" onClick={onCancel}>Cancel</button>
          <button
            className="uiBtn primary"
            onClick={() => onExport({
              format,
              highlights,
              notes,
              bundle: isGamma ? true : opts.bundle,
            })}
          >
            Export
          </button>
        </div>
      </div>
    </div>
  );
}

// The import counterpart of ExportDialog, same shape: pick a source, flip the
// switch that source understands, confirm. Nothing here is remembered — the
// strip switch starts from the Settings preference every time, so the setting
// stays the standing policy and the dialog is only ever a one-off override.
function ImportDialog({ hasPdf, stripDefault, busy, allowGamma, onCancel, onImport }) {
  const [source, setSource] = React.useState(hasPdf ? "annots" : "logseq");
  const [strip, setStrip] = React.useState(stripDefault);
  const src = !hasPdf && source === "annots" ? "logseq" : source;
  // Zotero's reader annotations arrive embedded in the exported PDF copies,
  // so the strip switch applies to that source exactly like to "this PDF".
  const stripApplies = src === "annots" || src === "zotero";

  const hints = {
    annots: "Highlights, notes and boxes saved inside this PDF (a Gamma export, SumatraPDF, Acrobat…) become regular blocks. Importing twice adds nothing — each annotation is matched to the block it already made.",
    logseq: "Pick a Logseq .pdf and its .edn (a .md of notes is optional). The paper and its highlights land in your library as a new page.",
    zotero: "Zip your Zotero File → Export Library → “Zotero RDF” export (check “Export Files” and “Export Notes”) and pick the .zip. Papers with metadata, collections as folders, tags, notes, and the annotations inside the PDFs land in your library; importing again updates instead of duplicating.",
    gamma: "Choose a scoped Gamma export .zip. Its missing pages, referenced files, and matching chats merge into your library; existing data is never replaced, and importing the same zip again adds nothing.",
  };

  return (
    <div className="reportOverlay" onClick={onCancel}>
      <div className="reportModal exportModal" onClick={(event) => event.stopPropagation()}>
        <div className="reportModalTitle">Import</div>
        <DialogRow icon={ImportIcon} label="Import from">
          <MenuSelect
            label="Import from" value={src}
            onChange={setSource}
            options={[
              ...(hasPdf ? [["annots", "Annotations in this PDF"]] : []),
              ["logseq", "Logseq highlights (.pdf + .edn)"],
              ["zotero", "Zotero library (.zip)"],
              ...(allowGamma ? [["gamma", "Gamma export (.zip)"]] : []),
            ]}
          />
        </DialogRow>
        <SwitchRow
          icon={ScissorsIcon}
          label="Strip the originals"
          hint={stripApplies
            ? src === "annots" ? "Rewrite the stored PDF without them" : "Rewrite the imported PDFs without them"
            : "Only for annotations inside a PDF"}
          title="Rewrite the stored file without the annotations you're importing, so only Gamma's copies remain. Off: they stay in the file and the viewer hides them."
          checked={stripApplies ? strip : false}
          disabled={!stripApplies}
          onChange={setStrip}
        />
        <div className="reportModalHint">{hints[src]}</div>
        <div className="reportModalBtns">
          <button className="uiBtn" onClick={onCancel}>Cancel</button>
          <button
            className="uiBtn primary" disabled={busy}
            onClick={() => onImport(
              stripApplies ? { source: src, strip } : { source: src },
            )}
          >
            {src === "annots"
              ? "Import"
              : src === "logseq" ? "Choose files…" : "Choose .zip…"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BlockDropIndicator({ target }) {
  if (!target) return null;
  const indentStep = 14;
  const baseOffset = 28;
  const left = target.rect.left + baseOffset + target.depth * indentStep;
  return (
    <div
      className="dropIndicator"
      style={{
        top: target.above ? target.rect.top : target.rect.bottom,
        left,
        width: Math.max(40, target.rect.width - (baseOffset + target.depth * indentStep)),
      }}
    />
  );
}

export {
  AutoGrowTextarea,
  BlockDropIndicator,
  ExportDialog,
  ImportDialog,
  ChatMarkdown,
  DockWindow,
  handleMarkdownCopy,
  OpenTabs,
  PopoverAnchor,
  useCopied,
};
