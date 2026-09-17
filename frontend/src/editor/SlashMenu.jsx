// The "/" command menu in the block editor, Notion-style: typing "/" at the
// start of a word opens a filterable list of insertions (link, equations,
// headings, to-do, code, table, ...). Pure catalog + a presentational popup;
// blockTree.jsx owns the trigger detection, keyboard handling and state.
import React, { useEffect } from "react";
import { useCaretAnchored } from "./LatexEditor";

// Every command edits through ctx:
//   { value, start, cursor, setText(newVal, selStart, selEnd),
//     openRefPopup(), pickImage() }
// start = index of the "/", cursor = caret (end of the typed query); commands
// replace that range with their insertion.

function replaceRange(ctx, text, caretRel, selLen = 0) {
  const { value, start, cursor } = ctx;
  const newVal = value.slice(0, start) + text + value.slice(cursor);
  const caret = start + (caretRel != null ? caretRel : text.length);
  ctx.setText(newVal, caret, caret + selLen);
}

// Turn the current line into `prefix` + its text (swapping out an existing
// markdown line prefix, so /h2 on a "# heading" re-levels instead of stacking).
const LINE_PREFIX_RE = /^(#{1,6} |> |[-*+] \[[ xX]\] |[-*+] |\d+\. )/;
function applyLinePrefix(ctx, prefix) {
  const { value, start, cursor } = ctx;
  let v = value.slice(0, start) + value.slice(cursor);
  const lineStart = v.lastIndexOf("\n", start - 1) + 1;
  const rest = v.slice(lineStart);
  const m = rest.match(LINE_PREFIX_RE);
  const stripped = m ? rest.slice(m[0].length) : rest;
  v = v.slice(0, lineStart) + prefix + stripped;
  const caret = Math.max(lineStart + prefix.length, start - (m ? m[0].length : 0) + prefix.length);
  ctx.setText(v, caret, caret);
}

// Insertions that want their own line (divider, code block, table) prepend a
// newline unless the "/" already sat at a line start.
function blockInsert(ctx, body, caretRelInBody, selLen = 0) {
  const atLineStart = ctx.start === 0 || ctx.value[ctx.start - 1] === "\n";
  const lead = atLineStart ? "" : "\n";
  replaceRange(ctx, lead + body, caretRelInBody != null ? lead.length + caretRelInBody : null, selLen);
}

const TABLE_MD = "| Column 1 | Column 2 |\n| --- | --- |\n|   |   |";

export const SLASH_COMMANDS = [
  {
    name: "link", label: "Link to note", glyph: "[[", hint: "reference another block",
    keywords: ["ref", "page", "block", "mention"],
    run: (ctx) => { replaceRange(ctx, "[["); ctx.openRefPopup(); },
  },
  {
    name: "embed", label: "Embed note", glyph: "⧉", hint: "show a block inline",
    keywords: ["transclude", "include", "block"],
    run: (ctx) => { replaceRange(ctx, "![["); ctx.openRefPopup(); },
  },
  {
    name: "highlight", label: "Highlight text", glyph: "==", hint: "==marked==",
    keywords: ["mark", "yellow", "emphasize"],
    run: (ctx) => replaceRange(ctx, "==x==", 2, 1),
  },
  {
    name: "math", label: "Inline equation", glyph: "$x$", hint: "LaTeX, rendered in place",
    keywords: ["equation", "latex", "tex"],
    run: (ctx) => replaceRange(ctx, "$x$", 1, 1),
  },
  {
    name: "equation", label: "Equation block", glyph: "$$", hint: "display math",
    keywords: ["display", "math", "latex"],
    run: (ctx) => replaceRange(ctx, "$$x$$", 2, 1),
  },
  { name: "h1", label: "Heading 1", glyph: "H1", keywords: ["heading", "title"], run: (ctx) => applyLinePrefix(ctx, "# ") },
  { name: "h2", label: "Heading 2", glyph: "H2", keywords: ["heading"], run: (ctx) => applyLinePrefix(ctx, "## ") },
  { name: "h3", label: "Heading 3", glyph: "H3", keywords: ["heading"], run: (ctx) => applyLinePrefix(ctx, "### ") },
  {
    name: "todo", label: "To-do", glyph: "☐", hint: "checkbox item",
    keywords: ["task", "checkbox", "check"],
    run: (ctx) => applyLinePrefix(ctx, "- [ ] "),
  },
  { name: "bullet", label: "Bulleted list", glyph: "•", keywords: ["list", "ul"], run: (ctx) => applyLinePrefix(ctx, "- ") },
  { name: "number", label: "Numbered list", glyph: "1.", keywords: ["list", "ol", "ordered"], run: (ctx) => applyLinePrefix(ctx, "1. ") },
  { name: "quote", label: "Quote", glyph: "❝", keywords: ["blockquote", "cite"], run: (ctx) => applyLinePrefix(ctx, "> ") },
  {
    name: "callout", label: "Callout", glyph: "[!]", hint: "note · tip · warning · danger",
    keywords: ["admonition", "aside", "banner", "note", "tip", "warning"],
    run: (ctx) => applyLinePrefix(ctx, "> [!note] "),
  },
  {
    name: "code", label: "Code block", glyph: "</>", hint: "fenced code",
    keywords: ["fence", "pre", "snippet"],
    run: (ctx) => blockInsert(ctx, "```\n\n```", 4),
  },
  { name: "divider", label: "Divider", glyph: "—", keywords: ["hr", "rule", "separator", "line"], run: (ctx) => blockInsert(ctx, "---\n") },
  {
    name: "table", label: "Table", glyph: "▦", hint: "2×2 markdown table",
    keywords: ["grid"],
    run: (ctx) => blockInsert(ctx, TABLE_MD, 2, 8),
  },
  {
    name: "image", label: "Image", glyph: "▣", hint: "upload from disk",
    keywords: ["picture", "photo", "upload", "figure"],
    run: (ctx) => { replaceRange(ctx, ""); ctx.pickImage(); },
  },
  {
    name: "date", label: "Today's date", glyph: "@", keywords: ["today", "now", "time"],
    run: (ctx) => replaceRange(ctx, new Date().toISOString().slice(0, 10)),
  },
];

export function filterSlashCommands(query) {
  const q = (query || "").toLowerCase();
  if (!q) return SLASH_COMMANDS;
  const scored = [];
  for (const c of SLASH_COMMANDS) {
    const names = [c.name, ...(c.keywords || []), ...c.label.toLowerCase().split(/\s+/)];
    const tier = names.some((n) => n.startsWith(q)) ? 0
      : names.some((n) => n.includes(q)) ? 1 : -1;
    if (tier >= 0) scored.push([tier, scored.length, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.map((x) => x[2]);
}

// Caret-anchored command popup. Also serves the Notion-style "Paste as"
// chooser after a URL paste (same look, plus a quiet `title` line) —
// blockTree owns both triggers and passes the item lists.
export function SlashMenuPopup({ items, selected, anchor, onPick, title }) {
  const [listRef, style] = useCaretAnchored(anchor, false, [items]);
  useEffect(() => {
    listRef.current?.querySelector(".slashMenuItem.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, listRef]);
  return (
    <div ref={listRef} className="slashMenu" style={style}>
      {title ? <div className="slashMenuTitle">{title}</div> : null}
      {items.map((c, i) => (
        <button
          key={c.name}
          type="button"
          className={`slashMenuItem${i === selected ? " selected" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(c)}
        >
          <span className="slashMenuGlyph">{c.glyph}</span>
          <span className="slashMenuLabel">{c.label}</span>
          {c.hint ? <span className="slashMenuHint">{c.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}
