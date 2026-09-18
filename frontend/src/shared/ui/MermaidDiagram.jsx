import React, { useEffect, useState } from "react";
import { copyText } from "../lib/utils";
import { renderMermaid } from "../lib/mermaidRenderer.js";
import "./mermaid.css";

export function mermaidCodeProps(children) {
  const code = React.Children.toArray(children).find((child) =>
    (child?.props?.className || "").split(/\s+/).some((name) => /^language-mermaid$/i.test(name)));
  if (!code) return null;
  return {
    source: String(code.props.children || "").replace(/\n$/, ""),
    pending: code.props["data-mermaid-pending"] === "true",
  };
}

// color-scheme also covers Gamma Light, sepia, solarized and gray themes.
const currentTheme = () => getComputedStyle(document.documentElement).colorScheme === "light" ? "default" : "dark";

export function MermaidDiagram({ source, pending = false }) {
  const [theme, setTheme] = useState(currentTheme);
  const [result, setResult] = useState(null);
  const [showSource, setShowSource] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (pending) return;
    let cancelled = false;
    renderMermaid(source, theme, () => cancelled).then((svg) => {
      if (!cancelled) setResult({ source, theme, svg });
    }, (error) => {
      if (!cancelled) setResult({ source, theme, error: String(error.message || error).slice(0, 800) });
    });
    return () => { cancelled = true; };
  }, [source, theme, pending]);
  useEffect(() => { setCopyStatus(""); }, [source]);
  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(""), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  const active = !pending && result?.source === source && result?.theme === theme ? result : null;
  function download() {
    if (!active?.svg) return;
    const url = URL.createObjectURL(new Blob([active.svg], { type: "image/svg+xml;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "diagram.svg";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="mermaidDiagram" data-mermaid-source={source} data-mermaid-theme={theme}>
      <div className="mermaidTools" data-markdown-copy-ignore=""
        onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        <span className="mermaidLabel">Mermaid</span>
        <button type="button" className={`uiBtn sm${showSource ? " on" : ""}`}
          aria-pressed={showSource} onClick={() => setShowSource(!showSource)}>Source</button>
        <button type="button" className="uiBtn sm" onClick={async () =>
          setCopyStatus(await copyText(source) ? "Copied" : "Copy failed")}>{copyStatus || "Copy source"}</button>
        <button type="button" className="uiBtn sm" disabled={!active?.svg} onClick={download}>Download SVG</button>
      </div>
      {!active && <div className="mermaidStatus" role="status">{pending ? "Waiting for the diagram to finish…" : "Rendering diagram…"}</div>}
      {active?.error && <div className="mermaidError" role="status">Could not render diagram.<pre>{active.error}</pre></div>}
      {active?.svg && !showSource && <div className="mermaidPreview" role="img" aria-label="Mermaid diagram"
        dangerouslySetInnerHTML={{ __html: active.svg }} />}
      {(showSource || pending || active?.error) && <pre className="mermaidSource"><code>{source}</code></pre>}
    </div>
  );
}
