// A diagram's display width lives in the fence's info string, after the
// language: "```mermaid width=420". Other Markdown renderers ignore the
// info string past the first word, so the source stays portable — the same
// idea as the Obsidian `![alt|420]` image size. Absent = natural size.
const WIDTH_TOKEN = /(^|\s)width=(\d+)(?=\s|$)/;
export function mermaidWidth(meta) {
  const m = WIDTH_TOKEN.exec(meta || "");
  return m ? Number(m[2]) : null;
}

// Mark incomplete Mermaid fences before mdast becomes HTML. A streaming reply
// can contain valid diagram syntax before its closing fence has arrived.
// The fence's width (see mermaidWidth) rides along as data-mermaid-width.
export function remarkMermaid() {
  return (tree, file) => {
    const source = String(file);
    function visit(node) {
      if (node.type === "code" && node.lang?.toLowerCase() === "mermaid") {
        const raw = source.slice(node.position.start.offset, node.position.end.offset);
        const lines = raw.split(/\r?\n/);
        const opener = /^(`{3,}|~{3,})/.exec(lines[0]);
        const closed = opener && lines.length > 1 && new RegExp(
          `^[ \\t>]*${opener[1][0]}{${opener[1].length},}[ \\t]*$`,
        ).test(lines.at(-1));
        const width = mermaidWidth(node.meta);
        node.data = { ...node.data, hProperties: {
          ...node.data?.hProperties, "data-mermaid-pending": closed ? "false" : "true",
          ...(width ? { "data-mermaid-width": String(width) } : {}),
        } };
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}

// A fence's opening line, with the quote/list prefix Markdown allows in front.
const FENCE_LINE = /^((?:[ \t]*>[ \t]?)*(?:[ \t]*(?:[-+*]|\d+[.)])[ \t]+)?[ \t]*)(`{3,}|~{3,})([^\r\n]*)$/;

// The Mermaid fences of a note in source order — the same order the
// rendered view shows them, so the nth diagram is the nth entry (quotes and
// list items included, like mapOutsideCodeFences). Each: the opener line's
// range and its info string split into {lang, meta, width}.
export function scanMermaidFences(text) {
  const out = [];
  let fence = null, pos = 0;
  for (const line of (text || "").split("\n")) {
    const end = pos + line.length;
    const m = FENCE_LINE.exec(line);
    if (fence) {
      if (m && m[2][0] === fence[0] && m[2].length >= fence.length && !m[3].trim()) fence = null;
    } else if (m && !(m[2][0] === "`" && m[3].includes("`"))) {
      fence = m[2];
      const info = m[3].trim();
      const lang = info.split(/\s+/)[0] || "";
      if (/^mermaid$/i.test(lang)) {
        const meta = info.slice(lang.length).trim();
        out.push({ from: pos, to: end, prefix: m[1], ticks: m[2], lang, meta, width: mermaidWidth(meta) });
      }
    }
    pos = end + 1;
  }
  return out;
}

// The note with its nth diagram's width set (0 clears it) — a rewrite of
// that fence's opening line only. null when there is no such diagram, so a
// stale index never edits the wrong fence.
export function setMermaidWidth(text, idx, width) {
  const f = scanMermaidFences(text)[idx];
  if (!f) return null;
  const rest = f.meta.replace(WIDTH_TOKEN, "$1").trim();
  const meta = [rest, width ? `width=${Math.round(width)}` : ""].filter(Boolean).join(" ");
  const line = `${f.prefix}${f.ticks}${f.lang}${meta ? " " + meta : ""}`;
  return text.slice(0, f.from) + line + text.slice(f.to);
}

function normalizeMath(text) {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `\n$$\n${m}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m}$`)
    // Escape math pipes so GFM doesn't interpret them as table cell boundaries.
    .replace(/\$\$[\s\S]*?\$\$|\$([^$\n]+)\$/g, (m, inner) =>
      inner == null || !inner.includes("|") ? m
        : `$${inner.replace(/\\\|/g, "\\Vert ").replace(/\|/g, "\\vert ")}$`);
}

// Preserve fenced source (including unfinished fences, tildes, and fences in
// lists/quotes). Math normalization must never rewrite diagram labels or code.
export function mapOutsideCodeFences(text, transform) {
  let fence = null, prose = "", result = "";
  for (const line of (text || "").match(/[^\n]*\n|[^\n]+$/g) || []) {
    const marker = /^(?:[ \t]*>[ \t]?)*(?:[ \t]*(?:[-+*]|\d+[.)])[ \t]+)?[ \t]*(`{3,}|~{3,})([^\r\n]*)/.exec(line);
    if (fence) {
      result += line;
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      result += transform(prose) + line;
      prose = "";
      fence = marker[1];
    } else prose += line;
  }
  return result + transform(prose);
}

export const normalizeChatMarkdown = (text) => mapOutsideCodeFences(text, normalizeMath);

export function mermaidFence(source) {
  const ticks = "`".repeat(Math.max(3, ...Array.from(source.matchAll(/`+/g), (m) => m[0].length + 1)));
  return `${ticks}mermaid\n${source}\n${ticks}`;
}

// Mermaid typesets only `$$…$$` labels (its katexRegex), while notes write
// math as `$…$`. Upgrade a note-style span to the form Mermaid reads: a
// same-line pair whose content hugs both dollars and is not followed by a
// digit, so prices ("$5 and $6") and escaped `\$` stay text; existing
// `$$…$$` spans pass through untouched.
export function mermaidMath(source) {
  return (source || "").replace(/\$\$[^$\n]*\$\$|\\\$|\$([^$\s][^$\n]*?[^$\s]|[^$\s])\$(?!\d)/g,
    (m, inner) => inner == null ? m : `$$${inner}$$`);
}
