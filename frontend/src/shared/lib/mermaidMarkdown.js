// Mark incomplete Mermaid fences before mdast becomes HTML. A streaming reply
// can contain valid diagram syntax before its closing fence has arrived.
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
        node.data = { ...node.data, hProperties: {
          ...node.data?.hProperties, "data-mermaid-pending": closed ? "false" : "true",
        } };
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
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
