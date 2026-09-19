// The guide engine: which tour is running and at which step, how a step
// advances (Next, or the step's event firing), demo steps that act on the
// UI themselves (`do: [...]`), and where progress is kept. The overlay only
// renders what this hook says; anchors are resolved by id. docs/dev/onboarding.md.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { anchorElement } from "./anchors.js";
import { guideEvents, eventMatches } from "./events.js";
import { TOURS } from "./tours/index.js";

const STORAGE_PREFIX = "gamma-guide:";
const VARS_KEY = "gamma-guide-vars"; // {name: value} overriding a tour's vars (tests, demos)
const ANCHOR_WAIT_MS = 4000;
const EVENT_WAIT_MS = 90000;         // a paper download can take a while

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readProgress(id) {
  try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + id) || "null"); } catch { return null; }
}
function writeProgress(id, value) {
  try { localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(value)); } catch { /* private mode */ }
}
function readVars() {
  try { return JSON.parse(localStorage.getItem(VARS_KEY) || "{}") || {}; } catch { return {}; }
}
const fill = (text, vars) => String(text ?? "").replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

// Strip ?guide= from the address once consumed, keeping every other param.
function consumeGuideParam() {
  const url = new URL(window.location.href);
  const id = url.searchParams.get("guide");
  if (!id) return null;
  url.searchParams.delete("guide");
  window.history.replaceState(window.history.state, "", url.toString());
  return id;
}

async function waitAnchor(id, timeout = ANCHOR_WAIT_MS) {
  const started = performance.now();
  for (;;) {
    const el = anchorElement(id);
    if (el) return el;
    if (performance.now() - started > timeout) throw new Error(`anchor "${id}" not found`);
    await sleep(50);
  }
}

// Resolves on a matching event — including one already in `seen`, the
// events that fired since the demo step began (the thing an action triggers
// can finish before the next action starts waiting for it).
function waitEvent(spec, seen, timeout = EVENT_WAIT_MS) {
  const early = seen.find(([name, payload]) => eventMatches(spec, name, payload));
  if (early) return Promise.resolve(early[1]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${spec.event}`)); }, timeout);
    const off = guideEvents.subscribe((name, payload) => {
      if (eventMatches(spec, name, payload)) { clearTimeout(timer); off(); resolve(payload); }
    });
  });
}

// React-controlled inputs only notice a value set through the native setter
// followed by an input event.
function setInputValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const centerOf = (el) => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; };

// The demo vocabulary. Each action moves the spotlight (and the pointer) to
// the element it acts on, waits a beat so the eye can follow, then acts.
async function runAction(action, vars, live, cancelled, seen) {
  const check = () => { if (cancelled()) throw new Error("cancelled"); };
  if (action.wait) { await sleep(action.wait); return; }
  if (action.waitFor) { await waitEvent(action.waitFor, seen, action.timeout); return; }
  if (action.click) {
    const el = await waitAnchor(action.click);
    live({ anchor: action.click, cursor: centerOf(el) });
    await sleep(550); check();
    live({ anchor: action.click, cursor: { ...centerOf(el), pressed: true } });
    el.click();
    await sleep(350);
    return;
  }
  if (action.type) {
    const el = await waitAnchor(action.type);
    const text = fill(action.text, vars);
    live({ anchor: action.type, cursor: centerOf(el) });
    await sleep(450); check();
    el.focus();
    let value = "";
    for (const ch of text) {
      check();
      value += ch;
      setInputValue(el, value);
      await sleep(action.speed ?? 28);
    }
    await sleep(300);
    return;
  }
  if (action.press) {
    const el = action.on ? await waitAnchor(action.on) : document.activeElement;
    const init = { key: action.press, code: action.press, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    await sleep(200);
    return;
  }
  throw new Error(`unknown action ${JSON.stringify(action)}`);
}

export function useGuide({ enabled = true, facts = {}, onStepChange } = {}) {
  // done: the current step's event fired; the card shows a check and waits
  // for Next, so what the user just opened stays open until they move on.
  const [run, setRun] = useState(null); // { tour, index, done } | null
  // live: what a demo step is doing right now — the anchor it acts on, the
  // pointer's position, whether actions are still running.
  const [live, setLive] = useState({ anchor: null, cursor: null, busy: false });
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

  // Demo steps: run the actions, then hand over (advanceOn) or move on.
  const nextRef = useRef(next);
  nextRef.current = next;
  useEffect(() => {
    if (!step?.do) return undefined;
    let cancelled = false;
    const vars = { ...(run.tour.vars || {}), ...readVars() };
    const seen = [];
    const unsubscribe = guideEvents.subscribe((name, payload) => { seen.push([name, payload]); });
    (async () => {
      await sleep(step.delay ?? 900);
      if (cancelled) return;
      setLive({ anchor: null, cursor: null, busy: true });
      try {
        for (const action of step.do) {
          if (cancelled) return;
          await runAction(action, vars, (l) => { if (!cancelled) setLive({ ...l, busy: true }); }, () => cancelled, seen);
        }
        if (cancelled) return;
        setLive({ anchor: null, cursor: null, busy: false });
        if (!step.advanceOn) nextRef.current();
      } catch (err) {
        if (cancelled) return;
        console.warn(`guide: demo step "${step.id}" stopped: ${err.message}`);
        setLive({ anchor: null, cursor: null, busy: false, failed: true });
      }
    })();
    return () => { cancelled = true; unsubscribe(); setLive({ anchor: null, cursor: null, busy: false }); };
  }, [step]);

  // The app tidies up between steps (closes the popover a step had opened).
  const onStepRef = useRef(onStepChange);
  onStepRef.current = onStepChange;
  useEffect(() => { if (run) onStepRef.current?.(run.index); }, [run?.index, run?.tour]);

  // Keys: Esc leaves, → / Enter advance, ← goes back — never inside an editor.
  useEffect(() => {
    if (!run) return undefined;
    const onKey = (e) => {
      if (!e.isTrusted) return; // the demo's own synthetic keys
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
    live,
    start, next, back, dismiss,
    progressOf: readProgress,
  };
}
