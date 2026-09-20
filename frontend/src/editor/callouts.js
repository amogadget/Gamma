// Obsidian/GitHub-style callouts in note markdown:
//
//   > [!note] Optional title
//   > body...
//
// A tiny remark plugin: a blockquote whose first paragraph starts with
// "[!type]" becomes <blockquote class="callout callout-<type>"> with the
// marker stripped and a styled title line prepended. Must run BEFORE
// remark-breaks (the marker line's trailing newline is still a plain "\n"
// inside the first text node at that point).

// Canonical types (each has a color in app.css); everything else aliases in —
// the alias list covers every callout type Obsidian names.
const CANON = {
  note: "note", info: "note", abstract: "note", summary: "note", tldr: "note", todo: "note",
  tip: "tip", hint: "tip", success: "tip", check: "tip", done: "tip",
  warning: "warning", caution: "warning", attention: "warning",
  danger: "danger", error: "danger", bug: "danger", fail: "danger", failure: "danger", missing: "danger",
  important: "important", example: "important", question: "important", help: "important", faq: "important",
  quote: "quote", cite: "quote",
};

export const CALLOUT_TYPES = [...new Set(Object.values(CANON))];

// Canonical type for a marker name ("info" → "note"); used by the editor's
// live callout rendering too.
export function calloutType(name) {
  return CANON[(name || "").toLowerCase()] || "note";
}

// The marker line: "[!type]" plus Obsidian's fold flag — "-" starts
// collapsed, "+" starts open, none = a plain callout. Shared with the
// editor's live callout rendering (BlockCmEditor), which hides it.
export const CALLOUT_MARKER_RE = /^\[!(\w+)\]([-+]?)[ \t]*/;

function transformBlockquote(bq) {
  const p = bq.children?.[0];
  if (!p || p.type !== "paragraph") return;
  const t = p.children?.[0];
  if (!t || t.type !== "text") return;
  const m = t.value.match(/^\[!(\w+)\]([-+]?)[ \t]*([^\n]*)(?:\n|$)/);
  if (!m) return;
  const type = CANON[m[1].toLowerCase()] || "note";
  const fold = m[2];
  const title = m[3].trim();
  t.value = t.value.slice(m[0].length);
  if (!t.value) {
    p.children.shift();
    if (p.children.length === 0) bq.children.shift();
  }
  // A foldable callout is a native <details>/<summary>: the toggle needs no
  // script, works in read-only views, and survives export as HTML Obsidian
  // and browsers both understand.
  bq.data = {
    ...bq.data,
    ...(fold ? { hName: "details" } : {}),
    hProperties: {
      className: ["callout", `callout-${type}`, ...(fold ? ["calloutFold"] : [])],
      ...(fold === "+" ? { open: true } : {}),
    },
  };
  bq.children.unshift({
    type: "paragraph",
    data: { ...(fold ? { hName: "summary" } : {}), hProperties: { className: ["calloutTitle"] } },
    children: [{ type: "text", value: title || type[0].toUpperCase() + type.slice(1) }],
  });
}

export function remarkCallouts() {
  return function walk(node) {
    if (!node.children) return;
    for (const child of node.children) walk(child);
    if (node.type === "blockquote") transformBlockquote(node);
  };
}
