import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { copyText } from "../lib/utils";
import { renderMermaid } from "../lib/mermaidRenderer.js";
import { CheckIcon, CodeIcon, CopyIcon, DownloadIcon } from "./Icons";
import { ResizeGrip, useDragResize } from "./ResizeGrip";
import "./mermaid.css";

export function mermaidCodeProps(children) {
  const code = React.Children.toArray(children).find((child) =>
    (child?.props?.className || "").split(/\s+/).some((name) => /^language-mermaid$/i.test(name)));
  if (!code) return null;
  const width = Number(code.props["data-mermaid-width"]) || null;
  return {
    source: String(code.props.children || "").replace(/\n$/, ""),
    pending: code.props["data-mermaid-pending"] === "true",
    width,
  };
}

// color-scheme also covers Gamma Light, sepia, solarized and gray themes.
const currentTheme = () => getComputedStyle(document.documentElement).colorScheme === "light" ? "default" : "dark";

// A rendered ```mermaid fence. The hover toolbar (the image toolbar's flat
// icon buttons) shows the source, copies it and downloads the SVG; with
// onResize (an editable note) the same right-edge grip as an image drags the
// diagram's width, written back into the fence's info string (`width=420`,
// see lib/mermaidMarkdown.js) — double-click restores the natural size.
export function MermaidDiagram({ source, pending = false, width = null, idx, onResize }) {
  const [theme, setTheme] = useState(currentTheme);
  const [result, setResult] = useState(null);
  const [showSource, setShowSource] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const figureRef = useRef(null);
  const { dragW, gripProps } = useDragResize({
    measure: () => figureRef.current?.getBoundingClientRect().width,
    onCommit: (w) => onResize?.(idx, w),
  });
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
  // Mermaid sizes its SVG to 100% of the container capped by an inline
  // max-width (the diagram's natural width). Reading that cap gives the
  // figure an explicit width even when the note stores none, so the frame
  // (and its grip) hugs the drawing instead of spanning the note.
  const [natural, setNatural] = useState(null);
  useLayoutEffect(() => {
    const svg = figureRef.current?.querySelector("svg");
    setNatural(svg ? parseFloat(svg.style.maxWidth) || null : null);
  }, [active?.svg]);
  const w = dragW != null ? dragW : (width || natural);
  function download() {
    if (!active?.svg) return;
    const url = URL.createObjectURL(new Blob([active.svg], { type: "image/svg+xml;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "diagram.svg";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const stop = (event) => event.stopPropagation();
  return (
    <div className={`mermaidDiagram${showSource ? " showingSource" : ""}`} data-mermaid-source={source} data-mermaid-theme={theme}>
      <div className="mermaidTools" data-markdown-copy-ignore="" onMouseDown={stop} onClick={stop}>
        <button type="button" className={`ctlBtn${showSource ? " modeActive" : ""}`}
          aria-label="Source" title={showSource ? "Show diagram" : "Show source"}
          aria-pressed={showSource} onClick={() => setShowSource(!showSource)}><CodeIcon /></button>
        <button type="button" className="ctlBtn" aria-label="Copy source"
          title={copyStatus || "Copy source"} onClick={async () =>
            setCopyStatus(await copyText(source) ? "Copied" : "Copy failed")}>
          {copyStatus === "Copied" ? <CheckIcon /> : <CopyIcon />}
        </button>
        <button type="button" className="ctlBtn" aria-label="Download SVG" title="Download SVG"
          disabled={!active?.svg} onClick={download}><DownloadIcon /></button>
      </div>
      {!active && <div className="mermaidStatus" role="status">{pending ? "Waiting for the diagram to finish…" : "Rendering diagram…"}</div>}
      {active?.error && <div className="mermaidError" role="status">Could not render diagram.<pre>{active.error}</pre></div>}
      {active?.svg && !showSource && (
        <div className="mermaidPreview">
          <div ref={figureRef} className={`mermaidFigure${w ? " sized" : ""}`} style={w ? { width: w } : undefined}>
            <div className="mermaidSvg" role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: active.svg }} />
            {onResize ? <ResizeGrip as="div" {...gripProps} /> : null}
          </div>
        </div>
      )}
      {(showSource || pending || active?.error) && <pre className="mermaidSource"><code>{source}</code></pre>}
    </div>
  );
}
