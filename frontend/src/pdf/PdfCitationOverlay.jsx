import React, { useLayoutEffect, useRef, useState } from "react";
import { citationRects } from "./pdfCitation.js";

export function PdfCitationOverlay({ citation, wrapRef, ready }) {
  const [result, setResult] = useState(null);
  const scrolled = useRef(null);
  useLayoutEffect(() => {
    setResult(null);
    if (!citation || !ready || !wrapRef.current) return;
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
  }, [citation, ready, wrapRef]);
  if (!citation || !result) return null;
  return <>
    {result.rects.map((r, i) => <div key={i} className="pdfCitationMark" aria-hidden="true"
      style={{ left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%` }} />)}
    {(result.status !== "matched" || result.approximate) && <div role="status" className="pdfCitationNotice">
      {result.approximate ? "Highlighted an approximate text match."
        : result.status === "ambiguous" ? "More than one passage on this page matches this quote."
        : "Opened the cited page; the quote could not be located in its text layer."}
    </div>}
  </>;
}
