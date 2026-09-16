import React, { useLayoutEffect, useRef, useState } from "react";
import { citationRects } from "./pdfCitation.js";

export function PdfCitationOverlay({ citation, textRef, wrapRef, ready }) {
  const [result, setResult] = useState(null);
  const scrolled = useRef(null);
  useLayoutEffect(() => {
    setResult(null);
    if (!citation || !ready || !textRef.current || !wrapRef.current) return;
    const frame = requestAnimationFrame(() => {
      const found = citationRects(ready.runs, wrapRef.current, citation.quote);
      setResult(found);
      if (found.rects.length && scrolled.current !== citation) {
        scrolled.current = citation;
        const viewer = wrapRef.current.closest(".pdfViewer");
        const box = wrapRef.current.getBoundingClientRect();
        if (viewer) {
          const view = viewer.getBoundingClientRect();
          const left = box.left + Math.min(...found.rects.map(r => r.left)) / 100 * box.width;
          const right = box.left + Math.max(...found.rects.map(r => r.left + r.width)) / 100 * box.width;
          const shift = left < view.left + 20 || right - left > viewer.clientWidth - 40
            ? left - view.left - 20 : Math.max(0, right - view.left - viewer.clientWidth + 20);
          viewer.scrollTo({ top: viewer.scrollTop + box.top
            + found.rects[0].top / 100 * box.height - view.top - 80,
            left: viewer.scrollLeft + shift, behavior: "auto" });
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [citation, ready, textRef, wrapRef]);
  if (!citation || !result) return null;
  return <>
    {result.rects.map((r, i) => <div key={i} className="pdfCitationMark" aria-hidden="true"
      style={{ position: "absolute", zIndex: 4, pointerEvents: "none",
        left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%`,
        background: "rgba(255, 200, 30, .4)", outline: "1px solid rgba(220, 140, 0, .8)", borderRadius: 2 }} />)}
    {result.status !== "matched" && <div role="status" className="pdfCitationNotice"
      style={{ position: "absolute", top: 8, left: 8, right: 8, zIndex: 5,
        padding: "8px 12px", background: "var(--bg, white)", color: "var(--text, #333)", borderRadius: 6 }}>
      {result.status === "ambiguous" ? "This quote appears more than once on this page."
        : "Opened the cited page; the exact quote could not be located in its text layer."}
    </div>}
  </>;
}
