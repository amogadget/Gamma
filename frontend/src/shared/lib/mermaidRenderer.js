let library;
let queue = Promise.resolve();
let nextId = 0;

// Mermaid holds global configuration: serialize initialization and rendering so
// simultaneous diagrams/theme changes cannot borrow another render's settings.
export function renderMermaid(source, theme, cancelled = () => false) {
  const task = queue.then(async () => {
    if (cancelled()) return null;
    if (source.length > 50000) throw new Error("Diagram exceeds the 50,000 character limit.");
    library ||= import("mermaid").then((m) => m.default).catch((error) => {
      library = null;
      throw error;
    });
    const mermaid = await library;
    if (cancelled()) return null;
    mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", theme,
      htmlLabels: false, suppressErrorRendering: true,
      maxTextSize: 50000, maxEdges: 500,
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels"],
    });
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none";
    host.setAttribute("aria-hidden", "true");
    document.body.appendChild(host);
    try {
      const { svg } = await mermaid.render(`gamma-mermaid-${++nextId}`, source, host);
      if (cancelled()) return null;
      // Strict mode disables callbacks, but Mermaid still emits URL anchors.
      // Keep previews and downloads inert, including diagrams from AI replies.
      const svgDoc = new DOMParser().parseFromString(svg, "image/svg+xml");
      for (const link of svgDoc.querySelectorAll("a")) link.replaceWith(...link.childNodes);
      return new XMLSerializer().serializeToString(svgDoc.documentElement);
    } finally {
      host.remove();
    }
  });
  queue = task.catch(() => {});
  return task;
}
