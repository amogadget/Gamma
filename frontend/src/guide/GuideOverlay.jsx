// The guide's visible part: a dimmed sheet with a cut-out around the current
// step's anchor (clicks pass through the hole, so the user acts on the real
// control) and a card beside it. A step without an anchor is a centred card.
// Anchors are found by data-guide id, retried briefly while the UI mounts;
// a step whose anchor never appears is skipped with a warning, never shown
// pointing at nothing. docs/dev/onboarding.md.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { anchorElement } from "./anchors.js";
import "./guide.css";

const PAD = 6;          // spotlight padding around the anchor
const GAP = 12;         // card distance from the spotlight
const MARGIN = 12;      // card distance from the viewport edge
const CARD_W = 300;
const WAIT_MS = 3000;   // how long a missing anchor may take to mount

// **bold**, `code`, blank-line paragraphs — enough for tour copy without
// pulling in the block markdown renderer.
function renderBody(text) {
  return String(text || "").split(/\n\s*\n/).map((para, i) => (
    <p key={i}>
      {para.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, j) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={j}>{part.slice(2, -2)}</strong>;
        if (/^`[^`]+`$/.test(part)) return <code key={j}>{part.slice(1, -1)}</code>;
        return part;
      })}
    </p>
  ));
}

// Where the card goes relative to the spotlight: below, else above, else
// beside; clamped to the viewport.
function placeCard(rect, cardH, vw, vh) {
  const r = rect;
  const fitsBelow = r.bottom + GAP + cardH + MARGIN <= vh;
  const fitsAbove = r.top - GAP - cardH - MARGIN >= 0;
  let top, left, side;
  if (fitsBelow) { side = "bottom"; top = r.bottom + GAP; left = r.left + r.width / 2 - CARD_W / 2; }
  else if (fitsAbove) { side = "top"; top = r.top - GAP - cardH; left = r.left + r.width / 2 - CARD_W / 2; }
  else if (r.right + GAP + CARD_W + MARGIN <= vw) { side = "right"; left = r.right + GAP; top = r.top + r.height / 2 - cardH / 2; }
  else { side = "left"; left = r.left - GAP - CARD_W; top = r.top + r.height / 2 - cardH / 2; }
  left = Math.max(MARGIN, Math.min(left, vw - CARD_W - MARGIN));
  top = Math.max(MARGIN, Math.min(top, vh - cardH - MARGIN));
  return { top, left, side };
}

export default function GuideOverlay({ guide }) {
  const { running, step, index, count, done, next, back, dismiss } = guide;
  const [rect, setRect] = useState(null);   // spotlight rect (padded) or null
  const [missing, setMissing] = useState(false);
  const cardRef = useRef(null);
  const [cardPos, setCardPos] = useState(null);

  // Track the anchor's box: on step change, resize, scroll and DOM mutations.
  useEffect(() => {
    if (!running || !step) return undefined;
    if (!step.anchor) { setRect(null); setMissing(false); return undefined; }
    let raf = 0;
    let gone = false;
    const started = performance.now();
    const measure = () => {
      raf = 0;
      const el = anchorElement(step.anchor);
      if (!el) {
        setRect(null);
        if (performance.now() - started > WAIT_MS && !gone) {
          gone = true;
          console.warn(`guide: anchor "${step.anchor}" not found, skipping step "${step.id}"`);
          setMissing(true);
        }
        return;
      }
      const b = el.getBoundingClientRect();
      setRect({ top: b.top - PAD, left: b.left - PAD, width: b.width + PAD * 2, height: b.height + PAD * 2,
        right: b.right + PAD, bottom: b.bottom + PAD });
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    anchorElement(step.anchor)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
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
  }, [running, step]);

  // A missing anchor skips the step.
  useEffect(() => {
    if (missing) { setMissing(false); next(); }
  }, [missing, next]);

  // Card placement follows the spotlight; measured after render.
  useLayoutEffect(() => {
    if (!running) return;
    const card = cardRef.current;
    if (!card) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!rect) { setCardPos(null); return; }
    setCardPos(placeCard(rect, card.offsetHeight, vw, vh));
  }, [running, rect, step]);

  if (!running || !step) return null;
  const waiting = step.anchor && !rect;
  const centered = !step.anchor;
  const vw = window.innerWidth, vh = window.innerHeight;
  const hole = rect
    ? `M${rect.left},${rect.top} h${rect.width} a8,8 0 0 1 8,8 v${rect.height - 16} a8,8 0 0 1 -8,8 h${-rect.width} a8,8 0 0 1 -8,-8 v${-(rect.height - 16)} a8,8 0 0 1 8,-8 z`
    : "";

  return (
    <div className={`guideRoot ${done ? "done" : ""}`} data-guide-overlay={step.id}>
      <svg className="guideDim" width={vw} height={vh} viewBox={`0 0 ${vw} ${vh}`} aria-hidden="true">
        <path
          d={`M0,0 H${vw} V${vh} H0 Z ${hole}`}
          fillRule="evenodd"
          className="guideDimFill"
          style={{ pointerEvents: centered ? "auto" : "visiblePainted" }}
        />
        {rect ? <path d={hole} className="guideRing" /> : null}
      </svg>
      {!waiting ? (
        <div
          ref={cardRef}
          className={`guideCard ${centered ? "guideCardCentered" : ""} ${cardPos ? `side-${cardPos.side}` : ""}`}
          style={cardPos ? { top: cardPos.top, left: cardPos.left, width: CARD_W } : undefined}
          role="dialog"
          aria-live="polite"
          aria-label={step.title}
        >
          <div className="guideHead">
            <span className="guideStep">{index + 1} / {count}{done ? <span className="guideDone">✓ Done</span> : null}</span>
            <button className="uiClose uiCloseSm guideClose" onClick={dismiss} title="Leave the tour (Esc)" aria-label="Leave the tour">×</button>
          </div>
          <div className="guideTitle">{step.title}</div>
          <div className="guideBody">{renderBody(step.body)}</div>
          <div className="guideFoot">
            <span className="guideDots" aria-hidden="true">
              {Array.from({ length: count }, (_, i) => <i key={i} className={i === index ? "on" : i < index ? "done" : ""} />)}
            </span>
            <span className="guideBtns">
              {index > 0 ? <button className="uiBtn" onClick={back}>Back</button> : null}
              <button className="uiBtn primary" onClick={next}>
                {step.next || (index + 1 >= count ? "Done" : step.advanceOn && !done ? "Skip" : "Next")}
              </button>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
