// Pure slash-command catalog and text transformations. Kept DOM-free so the
// insertion rules can be regression-tested independently of the popup/editor.
function replaceRange(ctx, text, caretRel, selLen = 0) {
  const { value, start, cursor } = ctx;
  const newVal = value.slice(0, start) + text + value.slice(cursor);
  const caret = start + (caretRel != null ? caretRel : text.length);
  ctx.setText(newVal, caret, caret + selLen);
}

const LINE_PREFIX_RE = /^(#{1,6} |> |[-*+] \[[ xX]\] |[-*+] |\d+\. )/;
function applyLinePrefix(ctx, prefix) {
  const { value, start, cursor } = ctx;
  let next = value.slice(0, start) + value.slice(cursor);
  const lineStart = next.lastIndexOf("\n", start - 1) + 1;
  const rest = next.slice(lineStart);
  const match = rest.match(LINE_PREFIX_RE);
  const stripped = match ? rest.slice(match[0].length) : rest;
  next = next.slice(0, lineStart) + prefix + stripped;
  const caret = Math.max(
    lineStart + prefix.length,
    start - (match ? match[0].length : 0) + prefix.length,
  );
  ctx.setText(next, caret, caret);
}

function blockInsert(ctx, body, caretRelInBody, selLen = 0) {
  const atLineStart = ctx.start === 0 || ctx.value[ctx.start - 1] === "\n";
  const lead = atLineStart ? "" : "\n";
  replaceRange(
    ctx,
    lead + body,
    caretRelInBody != null ? lead.length + caretRelInBody : null,
    selLen,
  );
}

const TABLE_MD = "| Column 1 | Column 2 |\n| --- | --- |\n|   |   |";

export const SLASH_COMMANDS = [
  { name: "link", label: "Link to note", glyph: "[[", hint: "reference another block", keywords: ["ref", "page", "block", "mention"], run: (ctx) => { replaceRange(ctx, "[["); ctx.openRefPopup(); } },
  { name: "math", label: "Inline equation", glyph: "$x$", hint: "LaTeX, rendered in place", keywords: ["equation", "latex", "tex"], run: (ctx) => replaceRange(ctx, "$x$", 1, 1) },
  { name: "equation", label: "Equation block", glyph: "$$", hint: "display math", keywords: ["display", "math", "latex"], run: (ctx) => replaceRange(ctx, "$$x$$", 2, 1) },
  { name: "h1", label: "Heading 1", glyph: "H1", keywords: ["heading", "title"], run: (ctx) => applyLinePrefix(ctx, "# ") },
  { name: "h2", label: "Heading 2", glyph: "H2", keywords: ["heading"], run: (ctx) => applyLinePrefix(ctx, "## ") },
  { name: "h3", label: "Heading 3", glyph: "H3", keywords: ["heading"], run: (ctx) => applyLinePrefix(ctx, "### ") },
  { name: "todo", label: "To-do", glyph: "☐", hint: "checkbox item", keywords: ["task", "checkbox", "check"], run: (ctx) => applyLinePrefix(ctx, "- [ ] ") },
  { name: "bullet", label: "Bulleted list", glyph: "•", keywords: ["list", "ul"], run: (ctx) => applyLinePrefix(ctx, "- ") },
  { name: "number", label: "Numbered list", glyph: "1.", keywords: ["list", "ol", "ordered"], run: (ctx) => applyLinePrefix(ctx, "1. ") },
  { name: "quote", label: "Quote", glyph: "❝", keywords: ["blockquote", "cite"], run: (ctx) => applyLinePrefix(ctx, "> ") },
  { name: "callout", label: "Callout", glyph: "[!]", hint: "note · tip · warning · danger", keywords: ["admonition", "aside", "banner", "note", "tip", "warning"], run: (ctx) => applyLinePrefix(ctx, "> [!note] ") },
  { name: "code", label: "Code block", glyph: "</>", hint: "fenced code", keywords: ["fence", "pre", "snippet"], run: (ctx) => blockInsert(ctx, "```\n\n```", 4) },
  { name: "divider", label: "Divider", glyph: "—", keywords: ["hr", "rule", "separator", "line"], run: (ctx) => blockInsert(ctx, "---\n") },
  { name: "table", label: "Table", glyph: "▦", hint: "2×2 markdown table", keywords: ["grid"], run: (ctx) => blockInsert(ctx, TABLE_MD, 2, 8) },
  { name: "image", label: "Image", glyph: "▣", hint: "upload from disk", keywords: ["picture", "photo", "upload", "figure"], run: (ctx) => { replaceRange(ctx, ""); ctx.pickImage(); } },
  { name: "date", label: "Today's date", glyph: "@", keywords: ["today", "now", "time"], run: (ctx) => replaceRange(ctx, new Date().toISOString().slice(0, 10)) },
];

export function filterSlashCommands(query) {
  const q = (query || "").toLowerCase();
  if (!q) return SLASH_COMMANDS;
  const scored = [];
  for (const command of SLASH_COMMANDS) {
    const aliases = [
      ...(command.keywords || []),
      ...command.label.toLowerCase().split(/\s+/),
    ];
    const tier = command.name === q
      ? 0
      : command.name.startsWith(q)
        ? 1
        : aliases.some((name) => name.startsWith(q))
          ? 2
          : [command.name, ...aliases].some((name) => name.includes(q))
            ? 3
            : -1;
    if (tier >= 0) scored.push([tier, scored.length, command]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.map((entry) => entry[2]);
}
