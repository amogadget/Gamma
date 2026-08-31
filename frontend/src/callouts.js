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

// Canonical types (each has a color in app.css); everything else aliases in.
const CANON = {
  note: "note", info: "note", abstract: "note", summary: "note",
  tip: "tip", hint: "tip", success: "tip", check: "tip",
  warning: "warning", caution: "warning", attention: "warning",
  danger: "danger", error: "danger", bug: "danger", fail: "danger", failure: "danger",
  important: "important", example: "important",
  quote: "quote", cite: "quote",
};

export const CALLOUT_TYPES = [...new Set(Object.values(CANON))];

// Canonical type for a marker name ("info" → "note"); used by the editor's
// live callout rendering too.
export function calloutType(name) {
  return CANON[(name || "").toLowerCase()] || "note";
}

function transformBlockquote(bq) {
  const p = bq.children?.[0];
  if (!p || p.type !== "paragraph") return;
  const t = p.children?.[0];
  if (!t || t.type !== "text") return;
  const m = t.value.match(/^\[!(\w+)\][ \t]*([^\n]*)(?:\n|$)/);
  if (!m) return;
  const type = CANON[m[1].toLowerCase()] || "note";
  const title = m[2].trim();
  t.value = t.value.slice(m[0].length);
  if (!t.value) {
    p.children.shift();
    if (p.children.length === 0) bq.children.shift();
  }
  bq.data = { ...bq.data, hProperties: { className: ["callout", `callout-${type}`] } };
  bq.children.unshift({
    type: "paragraph",
    data: { hProperties: { className: ["calloutTitle"] } },
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
