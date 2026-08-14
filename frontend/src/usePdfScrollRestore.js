// PDF scroll restore: the exact-position machinery that puts a reader back on
// their page after a navigation, refresh, or tab switch. Extracted from App so
// the delicate anchor logic lives in one place. The DOM refs it reads (viewer
// scroller, effective scale) and the debug logger are passed in — they still
// belong to App.
import { useRef } from "react";

export function usePdfScrollRestore({ dbg, viewerWrapRef, pdfEffScaleRef }) {
  const restoreTokenRef = useRef(0); // bumped on navigation — kills in-flight restore loops
  const restoringForRef = useRef(null); // block whose restore hasn't landed yet
  const pdfRenderedUrlRef = useRef(""); // url of the document whose pages are in the DOM
  const pendingRestoreRef = useRef(null); // {url, entry, blockId, token} applied pre-paint on "rendered"

  function cancelPdfRestore() {
    restoreTokenRef.current++;
    restoringForRef.current = null;
    pendingRestoreRef.current = null;
  }

  // Where a saved entry lands in the CURRENT layout. Prefer the page+frac
  // anchor (scale-invariant, immune to the fixed inter-page margins); fall
  // back to top × scale-ratio for entries saved before anchors existed and
  // for nav-stack entries. Reads the live DOM, so callers should re-invoke
  // it per attempt rather than caching the result.
  function pdfRestoreTargetTop(entry, scroller) {
    if (entry.page != null && scroller) {
      const p = scroller.querySelector(`[data-page="${entry.page}"]`);
      if (p) {
        const sRect = scroller.getBoundingClientRect();
        const r = p.getBoundingClientRect();
        const pageTop = r.top - sRect.top + scroller.scrollTop;
        return pageTop + (entry.frac || 0) * r.height;
      }
    }
    return entry.top * ((pdfEffScaleRef.current || entry.scale || 1) / (entry.scale || 1));
  }

  // Scroll the viewer back to an exact position. Two gates, both required:
  // the TARGET document must be the one rendered (the old document stays in
  // the DOM until the new one loads — scrolling it is what made restores land
  // wrong and visibly slide before the switch), and its layout height must be
  // stable for two ticks (pages get real heights asynchronously). The jump
  // itself is instant, after the new document is visible.
  function restorePdfScroll(entry, blockId, targetUrl) {
    if ((entry?.top == null && entry?.page == null) || !targetUrl) return;
    dbg(
      "exact restore: pending for",
      blockId,
      entry.page != null
        ? `page ${entry.page}+${(entry.frac || 0).toFixed(3)}`
        : `top ${Math.round(entry.top)}`,
    );
    const token = ++restoreTokenRef.current;
    restoringForRef.current = blockId || null;
    // The "rendered" callback applies a first placement pre-paint the moment
    // the target document mounts (no flash of the wrong offset). This loop
    // owns the END of the restore: it tracks the anchor while fit-width and
    // page-height refinement keep reshaping the layout, re-asserts once the
    // layout has been stable for two ticks, and only then clears the
    // restoring state (which is what un-gates captureScrollPos). Finishing
    // at first paint instead let quick tab flips capture mid-settle
    // positions and permanently corrupt the saved entry.
    pendingRestoreRef.current = { url: targetUrl, entry, blockId, token };
    let tries = 0;
    let lastH = -1;
    let lastScale = -1;
    let userMoved = false;
    let listenersOn = null;
    const onUserInput = () => {
      userMoved = true;
    };
    const userEvents = ["wheel", "touchstart", "pointerdown"];
    const finish = () => {
      if (listenersOn)
        for (const ev of userEvents) listenersOn.removeEventListener(ev, onUserInput);
      if (pendingRestoreRef.current?.token === token) pendingRestoreRef.current = null;
      if (restoringForRef.current === blockId) restoringForRef.current = null;
    };
    const tick = () => {
      if (restoreTokenRef.current !== token) {
        dbg("exact restore: superseded by navigation");
        finish();
        return;
      }
      if (userMoved) {
        dbg("exact restore: user took over");
        finish();
        return;
      } // their position wins
      if (pdfRenderedUrlRef.current === targetUrl) {
        const scroller = viewerWrapRef.current?.querySelector(".pdfViewer");
        if (scroller) {
          if (listenersOn !== scroller) {
            if (listenersOn)
              for (const ev of userEvents) listenersOn.removeEventListener(ev, onUserInput);
            for (const ev of userEvents)
              scroller.addEventListener(ev, onUserInput, { passive: true });
            listenersOn = scroller;
          }
          const h = scroller.scrollHeight;
          const scale = pdfEffScaleRef.current;
          const targetTop = Math.min(
            pdfRestoreTargetTop(entry, scroller),
            Math.max(0, h - scroller.clientHeight),
          );
          scroller.scrollTo({ top: targetTop, behavior: "instant" });
          if (h === lastH && scale === lastScale) {
            // settled — this placement is final
            dbg("exact restore: applied, top", Math.round(targetTop));
            finish();
            return;
          }
          lastH = h;
          lastScale = scale;
          // Only the settle-after-render window is budgeted; waiting for the
          // document itself is uncounted (same reasoning as the coarse
          // restore: a big PDF on a slow load outlives any fixed budget, and
          // giving up unfreezes the tracker at the top of the document, which
          // then records page 1 over the real reading position). Range-request
          // opens made this load-bearing — a cold open now spends seconds
          // before the first paint, which under a shared budget ate most of it.
          if (tries++ >= 80) {
            dbg("exact restore: gave up settling; height", h, "target", Math.round(targetTop));
            finish();
            return;
          }
        }
      }
      setTimeout(tick, 120);
    };
    tick();
  }

  return {
    restoreTokenRef,
    restoringForRef,
    pdfRenderedUrlRef,
    pendingRestoreRef,
    cancelPdfRestore,
    pdfRestoreTargetTop,
    restorePdfScroll,
  };
}
