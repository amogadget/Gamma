// The guide engine: which tour is running and at which step, how a step
// advances (Next, or the step's event firing), demo steps that act on the
// UI themselves (`do: [...]`), and where progress is kept. The overlay only
// renders what this hook says; anchors are resolved by id. docs/dev/onboarding.md.
import { useCallback, useEffect, useRef, useState } from "react";
import { anchorElement } from "./anchors.js";
import { guideEvents, eventMatches } from "./events.js";
import { TOURS } from "./tours/index.js";
import { previewHighlight } from "./previewHighlight.js";
import { previewArea } from "./previewArea.js";
import { typeDemoNote } from "./typeDemoNote.js";
import { createGuideProgress, factsMatch } from "./triggers.js";

const VARS_KEY = "gamma-guide-vars"; // {name: value} overriding a tour's vars (tests, demos)
const ANCHOR_WAIT_MS = 4000;
const EVENT_WAIT_MS = 90000;         // a paper download can take a while

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readVars() {
  try { return JSON.parse(localStorage.getItem(VARS_KEY) || "{}") || {}; } catch { return {}; }
}
const fill = (text, vars) => String(text ?? "").replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

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
async function runAction(action, vars, live, cancelled, seen, onCleanup, services) {
  const check = () => { if (cancelled()) throw new Error("cancelled"); };
  if (action.previewHighlight) return previewHighlight(live, cancelled, onCleanup);
  if (action.previewArea) return previewArea(live, cancelled, onCleanup, action.context ? null : services.findEquation, action.context);
  if (action.note) return typeDemoNote(action.note, services.prepareNote, live, cancelled);
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
    const original = el.value;
    if (action.preserveDraft) onCleanup(() => {
      if (el.isConnected && text.startsWith(el.value) && (original || el.value !== text)) setInputValue(el, original);
    });
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

export function useGuide({ enabled = true, scope = "", facts = {}, services = {}, onStepChange } = {}) {
  const servicesRef = useRef(services);
  servicesRef.current = services;
  // done: acknowledge the user's action before automatically advancing.
  const [run, setRun] = useState(null); // { tour, index, done } | null
  const progress = useRef(null);
  if (!progress.current) progress.current = createGuideProgress();
  // live: what a demo step is doing right now — the anchor it acts on, the
  // pointer's position, whether actions are still running.
  const [live, setLive] = useState({ anchor: null, cursor: null, busy: false });
  const factsRef = useRef(facts);
  factsRef.current = facts;

  // Steps whose `requires` don't hold are dropped from this run.
  const steps = run?.steps || [];

  const start = useCallback((tourId, at = 0) => {
    const tour = TOURS[tourId];
    if (!tour) { console.warn(`guide: no tour "${tourId}"`); return false; }
    if (!enabled) return false;
    const steps = tour.steps.filter((s) => factsMatch(s.requires, factsRef.current));
    if (!steps.length || at < 0 || at >= steps.length) return false;
    setRun({ tour, scope, steps, index: at, done: false });
    progress.current.write(tour, scope, { state: "running", step: at });
    return true;
  }, [enabled, scope]);

  const stop = useCallback((state) => {
    setRun((r) => {
      if (r) progress.current.write(r.tour, r.scope, { state, step: r.index });
      return null;
    });
  }, []);

  const next = useCallback(() => {
    setRun((r) => {
      if (!r) return r;
      if (r.index + 1 >= steps.length) {
        progress.current.write(r.tour, r.scope, { state: "done" });
            return null;
      }
      return { ...r, index: r.index + 1, done: false };
    });
  }, [steps.length]);

  const back = useCallback(() => {
    setRun((r) => (r && r.index > 0 ? { ...r, index: r.index - 1, done: false } : r));
  }, []);

  const dismiss = useCallback(() => stop("dismissed"), [stop]);

  // Tours are started exclusively from the account menu.
  const runAvailable = enabled && run?.scope === scope;
  useEffect(() => {
    if (run && !runAvailable) setRun(null);
  }, [run, runAvailable]);

  // Task-driven completion: the current step's event fires → the step is done.
  const step = run ? steps[run.index] : null;
  // Include the introductory pause: the demo owns navigation from its very
  // first frame, before its first action has started.
  const busy = !!step?.do && (live.stepId !== step.id || (!live.failed && !live.finished));
  useEffect(() => {
    if (!step?.advanceOn) return undefined;
    return guideEvents.subscribe((name, payload) => {
      if (eventMatches(step.advanceOn, name, payload)) setRun((r) => (r ? { ...r, done: true } : r));
    });
  }, [step]);

  // Demo steps: run the actions, then hand over (advanceOn) or move on.
  const nextRef = useRef(next);
  nextRef.current = next;
  // Let the acknowledgement register before moving on; cancelling or manually
  // navigating clears the timer so an old completion cannot skip a new step.
  useEffect(() => {
    if (!run?.done || !step?.advanceOn) return undefined;
    const timer = setTimeout(() => nextRef.current(), 1100);
    return () => clearTimeout(timer);
  }, [run?.done, step]);
  useEffect(() => {
    if (!step?.do) return undefined;
    let cancelled = false;
    const cleanups = [];
    const vars = { ...(run.tour.vars || {}), ...readVars() };
    const seen = [];
    const unsubscribe = guideEvents.subscribe((name, payload) => { seen.push([name, payload]); });
    (async () => {
      await sleep(step.delay ?? 900);
      if (cancelled) return;
      setLive({ anchor: null, cursor: null, busy: true, stepId: step.id });
      try {
        for (const action of step.do) {
          if (cancelled) return;
          await runAction(action, vars, (l) => { if (!cancelled) setLive({ ...l, busy: true, stepId: step.id }); }, () => cancelled, seen, (cleanup) => cleanups.push(cleanup), servicesRef.current);
        }
        if (cancelled) return;
        setLive({ anchor: null, cursor: null, busy: false, finished: true, stepId: step.id });
        if (!step.advanceOn) nextRef.current();
      } catch (err) {
        if (cancelled) return;
        console.warn(`guide: demo step "${step.id}" stopped: ${err.message}`);
        setLive({ anchor: null, cursor: null, busy: false, failed: true, stepId: step.id });
      }
    })();
    return () => { cancelled = true; cleanups.forEach((cleanup) => cleanup()); unsubscribe(); setLive({ anchor: null, cursor: null, busy: false }); };
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
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismiss(); return; }
      if (busy) {
        if (["Escape", "ArrowRight", "ArrowLeft", "Enter"].includes(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") dismiss();
        }
        return;
      }
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      // Let Enter activate the focused Back/Close/Next button normally.
      if (e.key === "Enter" && t?.closest?.("button, a, [role=button]")) return;
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [run, busy, next, back, dismiss]);

  return {
    running: !!run && runAvailable,
    tour: run?.tour || null,
    step,
    index: run?.index ?? 0,
    done: !!run?.done,
    count: steps.length,
    live: { ...live, busy },
    start, next, back, dismiss,
    progressOf: (id) => TOURS[id] ? progress.current.read(TOURS[id], scope) : null,
  };
}
