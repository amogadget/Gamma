// Link identifiers in older replies too, without rewriting saved Markdown or
// touching existing links, code, or math. The normal chat link renderer handles them.
export function remarkPaperLinks() {
  return (tree) => {
    function walk(node) {
      if (["link", "linkReference", "code", "inlineCode", "math", "inlineMath", "html"].includes(node.type)) return;
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text") { walk(child); return [child]; }
        const text = child.value;
        const pattern = /\b10\.\d{4,9}\/[-a-z0-9._;()/:+]+|\barxiv:\s*(?:\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?\b/gi;
        const parts = [];
        let end = 0;
        for (const match of text.matchAll(pattern)) {
          // Do not turn fragments of URLs or other identifiers into links.
          if (match.index && /[\w/]/.test(text[match.index - 1])) continue;
          let label = match[0].replace(/[.,;:]+$/, "");
          while (label.endsWith(")") && (label.match(/\)/g) || []).length > (label.match(/\(/g) || []).length) {
            label = label.slice(0, -1).replace(/[.,;:]+$/, "");
          }
          const arxiv = /^arxiv:\s*/i.test(label);
          const id = arxiv ? label.replace(/^arxiv:\s*/i, "") : label;
          if (match.index > end) parts.push({ type: "text", value: text.slice(end, match.index) });
          parts.push({ type: "link", url: `${arxiv ? "https://arxiv.org/abs/" : "https://doi.org/"}${id}`,
            children: [{ type: "text", value: label }] });
          end = match.index + label.length;
        }
        if (!parts.length) return [child];
        if (end < text.length) parts.push({ type: "text", value: text.slice(end) });
        return parts;
      });
    }
    walk(tree);
  };
}
