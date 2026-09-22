// The guide's visible part: a dimmed sheet with a cut-out around the current
// step's anchor (clicks pass through the hole, so the user acts on the real
// control) and a card beside it. A step without an anchor is a centred card.
// A demo step moves the spotlight to whatever it acts on and shows a pointer
// gliding there. Anchors are found by data-guide id, retried briefly while
// the UI mounts; a step whose anchor never appears is skipped with a warning,
// never shown pointing at nothing. docs/dev/onboarding.md.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { anchorElement } from "./anchors.js";
import "./guide.css";

const PAD = 6;          // spotlight padding around the anchor
const GAP = 12;         // card distance from the spotlight
const MARGIN = 12;      // card distance from the viewport edge
const CARD_W = 300;
const WAIT_MS = 3000;   // how long a missing anchor may take to mount

// **bold**, *italic*, `code`, blank-line paragraphs — enough for tour copy
// without pulling in the block markdown renderer.
function renderBody(text) {
  return String(text || "").split(/\n\s*\n/).map((para, i) => (
    <p key={i}>
      {para.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).map((part, j) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={j}>{part.slice(2, -2)}</strong>;
        if (/^\*[^*]+\*$/.test(part)) return <em key={j}>{part.slice(1, -1)}</em>;
        if (/^`[^`]+`$/.test(part)) return <code key={j}>{part.slice(1, -1)}</code>;
        return part;
      })}
    </p>
  ));
}

// Where the card goes relative to the spotlight: the step's preferred side
// when it fits, else below, above, right, left; clamped to the viewport.
// "inside" tucks the card into the target's bottom-right corner, for large
// targets such as the whole viewer.
function placeCard(rect, cardH, vw, vh, prefer) {
  const r = rect;
  if (prefer === "inside") {
    return {
      side: "inside",
      top: Math.max(MARGIN, r.bottom - GAP - cardH),
      left: Math.max(MARGIN, Math.min(r.right - GAP - CARD_W, vw - CARD_W - MARGIN)),
    };
  }
  const fits = {
    bottom: r.bottom + GAP + cardH + MARGIN <= vh,
    top: r.top - GAP - cardH - MARGIN >= 0,
    right: r.right + GAP + CARD_W + MARGIN <= vw,
    left: r.left - GAP - CARD_W - MARGIN >= 0,
  };
  const order = [prefer, "bottom", "top", "right", "left"].filter(Boolean);
  const side = order.find((s) => fits[s]) || "bottom";
  let top, left;
  if (side === "bottom") { top = r.bottom + GAP; left = r.left + r.width / 2 - CARD_W / 2; }
  else if (side === "top") { top = r.top - GAP - cardH; left = r.left + r.width / 2 - CARD_W / 2; }
  else if (side === "right") { left = r.right + GAP; top = r.top + r.height / 2 - cardH / 2; }
  else { left = r.left - GAP - CARD_W; top = r.top + r.height / 2 - cardH / 2; }
  left = Math.max(MARGIN, Math.min(left, vw - CARD_W - MARGIN));
  top = Math.max(MARGIN, Math.min(top, vh - cardH - MARGIN));
  return { top, left, side };
}

export default function GuideOverlay({ guide }) {
  const { running, offer, index, count, done, live, back } = guide;
  const inviting = !running && !!offer;
  const visible = running || inviting;
  const step = inviting ? offer.invitation : guide.step;
  const next = inviting ? guide.acceptOffer : guide.next;
  const dismiss = inviting ? guide.dismissOffer : guide.dismiss;
  const [rect, setRect] = useState(null);   // spotlight rect (padded) or null
  const [missing, setMissing] = useState(false);
  const cardRef = useRef(null);
  const [cardPos, setCardPos] = useState(null);
  // A demo step's spotlight follows what it acts on; otherwise the step's anchor.
  const anchor = (!inviting && live?.anchor) || step?.anchor || null;

  // Track the anchor's box: on change, resize, scroll and DOM mutations.
  useEffect(() => {
    if (!visible || !step) return undefined;
    if (!anchor) { setRect(null); setMissing(false); return undefined; }
    let raf = 0;
    let gone = false;
    const started = performance.now();
    const measure = () => {
      raf = 0;
      const el = anchorElement(anchor);
      const b = el?.getBoundingClientRect();
      if (!b?.width || !b?.height) {
        setRect(null);
        if (performance.now() - started > WAIT_MS && !gone && !step.do) {
          gone = true;
          if (!inviting) console.warn(`guide: anchor "${anchor}" not found, skipping step "${step.id}"`);
          setMissing(true);
        }
        return;
      }
      setRect({ top: b.top - PAD, left: b.left - PAD, width: b.width + PAD * 2, height: b.height + PAD * 2,
        right: b.right + PAD, bottom: b.bottom + PAD });
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    if (!inviting) anchorElement(anchor)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const retry = setInterval(schedule, 250); // covers the wait for a late mount
    return () => {
      mo.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      clearInterval(retry);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [visible, inviting, step, anchor]);

  // A missing anchor skips the step.
  useEffect(() => {
    if (missing) { setMissing(false); if (inviting) dismiss(); else next(); }
  }, [missing, inviting, dismiss, next]);

  // Card placement follows the spotlight; measured after render.
  useLayoutEffect(() => {
    if (!visible) return;
    const card = cardRef.current;
    if (!card) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!rect) { setCardPos(null); return; }
    setCardPos(placeCard(rect, card.offsetHeight, vw, vh, step?.placement));
  }, [visible, rect, step]);

  if (!visible || !step) return null;
  const waiting = anchor && !rect;
  const centered = !anchor;
  const busy = !inviting && !!live?.busy;
  const vw = window.innerWidth, vh = window.innerHeight;
  const hole = rect
    ? `M${rect.left},${rect.top} h${rect.width} a8,8 0 0 1 8,8 v${rect.height - 16} a8,8 0 0 1 -8,8 h${-rect.width} a8,8 0 0 1 -8,-8 v${-(rect.height - 16)} a8,8 0 0 1 8,-8 z`
    : "";
  const primaryLabel = step.next
    || (index + 1 >= count ? "Done" : live?.failed || (step.advanceOn && !done) ? "Skip" : "Next");

  return (
    <div className={`guideRoot ${inviting ? "guideInvitation" : ""} ${done ? "done" : ""} ${busy ? "busy" : ""}`} data-guide-overlay={inviting ? undefined : step.id} data-guide-offer={inviting ? offer.id : undefined} data-guide-busy={busy ? "1" : undefined}>
      {!inviting ? <svg className="guideDim" width={vw} height={vh} viewBox={`0 0 ${vw} ${vh}`} aria-hidden="true">
        <path
          d={`M0,0 H${vw} V${vh} H0 Z ${hole}`}
          fillRule="evenodd"
          className="guideDimFill"
          style={{ pointerEvents: centered || busy ? "auto" : "visiblePainted" }}
        />
        {rect ? <path d={hole} className="guideRing" /> : null}
      </svg> : null}
      {busy && rect ? <div className="guideShield" aria-hidden="true" /> : null}
      {!inviting && live?.cursor ? (
        <div
          className={`guideCursor ${live.cursor.pressed ? "pressed" : ""} ${live.cursor.dragging ? "dragging" : ""}`}
          style={{ transform: `translate(${live.cursor.x}px, ${live.cursor.y}px)` }}
          aria-hidden="true"
        >
          <svg width="22" height="26" viewBox="0 0 22 26">
            <path d="M2 2 L2 20 L7 15.5 L10.5 23 L14 21.5 L10.5 14 L17 14 Z" fill="#fff" stroke="#111" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          {live.cursor.modifier ? <kbd className="guideModifier">{live.cursor.modifier}</kbd> : null}
        </div>
      ) : null}
      {!waiting || busy ? (
        <div
          ref={cardRef}
          className={`guideCard ${rect && rect.top > vh / 2 ? "guideCardAbove" : ""} ${centered && !busy ? "guideCardCentered" : ""} ${cardPos ? `side-${cardPos.side}` : ""} ${busy && !cardPos ? "guideCardCorner" : ""}`}
          style={cardPos ? { top: cardPos.top, left: cardPos.left, width: CARD_W } : undefined}
          role="dialog"
          aria-live="polite"
          aria-label={step.title}
        >
          <div className="guideHead">
            <span className="guideStep">
              {inviting ? `Quick guide · ${offer.estimate}` : `${index + 1} / ${count}`}
              {!inviting && done ? <span className="guideDone">✓ Done</span> : null}
              {busy ? <span className="guideBusy">watch</span> : null}
              {live?.failed ? <span className="guideFailed">couldn't finish</span> : null}
            </span>
            <button className="uiClose uiCloseSm guideClose" onClick={dismiss} title={inviting ? "Dismiss guide (Esc)" : "Leave the tour (Esc)"} aria-label={inviting ? "Dismiss guide" : "Leave the tour"}>×</button>
          </div>
          <div className="guideTitle">{step.title}</div>
          {step.body ? <div className="guideBody">{renderBody(step.body)}</div> : null}
          <div className="guideFoot">
            {!inviting ? <span className="guideDots" aria-hidden="true">
              {Array.from({ length: count }, (_, i) => <i key={i} className={i === index ? "on" : i < index ? "done" : ""} />)}
            </span> : <button className="uiBtn sm" onClick={dismiss}>Not now</button>}
            <span className="guideBtns">
              {!inviting && index > 0 && !busy && !done ? <button className="uiBtn" onClick={back}>Back</button> : null}
              {!busy && (!done || inviting) ? <button className="uiBtn primary" onClick={next}>{inviting ? "Show me" : primaryLabel}</button> : null}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
