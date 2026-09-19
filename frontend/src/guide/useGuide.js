// The guide engine: which tour is running and at which step, how a step
// advances (Next, or the step's event firing), and where progress is kept.
// The overlay only renders what this hook says; anchors are resolved there.
// docs/dev/onboarding.md.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { guideEvents, eventMatches } from "./events.js";
import { TOURS } from "./tours/index.js";

const STORAGE_PREFIX = "gamma-guide:";

function readProgress(id) {
  try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + id) || "null"); } catch { return null; }
}
function writeProgress(id, value) {
  try { localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(value)); } catch { /* private mode */ }
}

// Strip ?guide= from the address once consumed, keeping every other param.
function consumeGuideParam() {
  const url = new URL(window.location.href);
  const id = url.searchParams.get("guide");
  if (!id) return null;
  url.searchParams.delete("guide");
  window.history.replaceState(window.history.state, "", url.toString());
  return id;
}

export function useGuide({ enabled = true, facts = {}, onStepChange } = {}) {
  // done: the current step's event fired; the card shows a check and waits
  // for Next, so what the user just opened stays open until they move on.
  const [run, setRun] = useState(null); // { tour, index, done } | null
  const factsRef = useRef(facts);
  factsRef.current = facts;

  // Steps whose `requires` don't hold are dropped from this run.
  const steps = useMemo(() => {
    if (!run) return [];
    return run.tour.steps.filter((s) => !s.requires || Object.entries(s.requires).every(([k, v]) => factsRef.current[k] === v));
  }, [run?.tour]);

  const start = useCallback((tourId, at = 0) => {
    const tour = TOURS[tourId];
    if (!tour) { console.warn(`guide: no tour "${tourId}"`); return false; }
    setRun({ tour, index: at, done: false });
    return true;
  }, []);

  const stop = useCallback((state) => {
    setRun((r) => {
      if (r) writeProgress(r.tour.id, { version: r.tour.version, state, step: r.index });
      return null;
    });
  }, []);

  const next = useCallback(() => {
    setRun((r) => {
      if (!r) return r;
      if (r.index + 1 >= steps.length) {
        writeProgress(r.tour.id, { version: r.tour.version, state: "done" });
        return null;
      }
      return { ...r, index: r.index + 1, done: false };
    });
  }, [steps.length]);

  const back = useCallback(() => {
    setRun((r) => (r && r.index > 0 ? { ...r, index: r.index - 1, done: false } : r));
  }, []);

  const dismiss = useCallback(() => stop("dismissed"), [stop]);

  // ?guide=<id> starts a tour once the app is ready for it.
  const consumed = useRef(false);
  useEffect(() => {
    if (!enabled || consumed.current) return;
    const id = consumeGuideParam();
    consumed.current = true;
    if (id) start(id);
  }, [enabled, start]);

  // Task-driven completion: the current step's event fires → the step is done.
  const step = run ? steps[run.index] : null;
  useEffect(() => {
    if (!step?.advanceOn) return undefined;
    return guideEvents.subscribe((name, payload) => {
      if (eventMatches(step.advanceOn, name, payload)) setRun((r) => (r ? { ...r, done: true } : r));
    });
  }, [step]);

  // The app tidies up between steps (closes the popover a step had opened).
  const onStepRef = useRef(onStepChange);
  onStepRef.current = onStepChange;
  useEffect(() => { if (run) onStepRef.current?.(run.index); }, [run?.index, run?.tour]);

  // Keys: Esc leaves, → / Enter advance, ← goes back — never inside an editor.
  useEffect(() => {
    if (!run) return undefined;
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "Escape") { e.preventDefault(); dismiss(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [run, next, back, dismiss]);

  // The overlay unmounts with the share view or a lost session.
  useEffect(() => { if (!enabled && run) setRun(null); }, [enabled, run]);

  return {
    running: !!run,
    tour: run?.tour || null,
    step,
    index: run?.index ?? 0,
    done: !!run?.done,
    count: steps.length,
    start, next, back, dismiss,
    progressOf: readProgress,
  };
}
