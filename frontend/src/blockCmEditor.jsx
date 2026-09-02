// The block editor: a single CodeMirror 6 instance (only the block being
// edited mounts one) that mimics the old textarea's API so blockTree keeps
// its key handling, [[ref]] popup and LaTeX autocomplete untouched, and adds
// Notion/Obsidian-style live rendering: a closed $...$ / $$...$$ span (or a
// [[block-ref]]) whose text the caret is NOT touching renders in place;
// moving the caret into it (arrow keys, or clicking the rendered chip)
// expands it back to source.
import React, { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { Compartment, EditorState, Prec, StateField, Transaction } from "@codemirror/state";
import {
  Decoration, EditorView, WidgetType, keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { findMathAtCursor, renderKatexInto } from "./latexEditor";
// The editor and the renderers must agree on where math is and whether it is
// centred, so the tokenizer lives in one place — see mathMarkdown.js.
import { scanMathSpans } from "./mathMarkdown";
import { calloutType } from "./callouts";
import { highlightCode, makeCopyButton, scanFences } from "./codeHighlight";

// All CLOSED math spans in the text: [{from, to, display}] with from/to
// Clicking a rendered widget drops the caret just inside it, which un-renders
// the span (the caret now touches it) so the source is editable in place.
function placeCaretInside(view, node, offsetFromStart) {
  const pos = view.posAtDOM(node);
  view.dispatch({ selection: { anchor: pos + offsetFromStart } });
  view.focus();
}

class MathWidget extends WidgetType {
  constructor(tex, display) {
    super();
    this.tex = tex;
    this.display = display;
  }
  eq(other) { return other.tex === this.tex && other.display === this.display; }
  toDOM(view) {
    const span = document.createElement("span");
    span.className = "cmMathWidget" + (this.display ? " cmMathDisplay" : "");
    renderKatexInto(span, this.tex, this.display);
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      placeCaretInside(view, span, this.display ? 2 : 1);
    });
    return span;
  }
  // Default ignoreEvent() → true: CM leaves the mousedown to our listener.
}

class RefChipWidget extends WidgetType {
  constructor(label, embed) {
    super();
    this.label = label;
    this.embed = embed; // ![[id]] transclusion — chip in the editor, card when rendered
  }
  eq(other) { return other.label === this.label && other.embed === this.embed; }
  toDOM(view) {
    const span = document.createElement("span");
    span.className = "blockRefChip cmRefChip" + (this.embed ? " cmEmbedChip" : "");
    span.textContent = (this.embed ? "⧉ " : "") + this.label;
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      placeCaretInside(view, span, this.embed ? 3 : 2);
    });
    return span;
  }
}

// "- [ ] " task marker → a real checkbox; clicking it flips the char in the
// source (which autosaves through the normal onChange path).
class TaskCheckboxWidget extends WidgetType {
  constructor(checked, checkOffset) {
    super();
    this.checked = checked;
    this.checkOffset = checkOffset;
  }
  eq(other) { return other.checked === this.checked && other.checkOffset === this.checkOffset; }
  toDOM(view) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "mdTaskCheckbox";
    input.checked = this.checked;
    input.addEventListener("mousedown", (e) => e.preventDefault());
    input.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(input) + this.checkOffset;
      view.dispatch({ changes: { from: pos, to: pos + 1, insert: this.checked ? " " : "x" } });
    });
    return input;
  }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM(view) {
    const span = document.createElement("span");
    span.className = "cmBulletDot";
    span.textContent = "•";
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      placeCaretInside(view, span, 1);
    });
    return span;
  }
}

// A closed ``` fence the caret isn't touching renders as a highlighted code
// card (same in-place idiom as math). Clicking drops the caret at the start
// of the code so the fence expands back to source.
class CodeBlockWidget extends WidgetType {
  constructor(code, lang, caretOffset) {
    super();
    this.code = code;
    this.lang = lang;
    this.caretOffset = caretOffset;
  }
  eq(other) { return other.code === this.code && other.lang === this.lang; }
  toDOM(view) {
    const span = document.createElement("span");
    span.className = "cmCodeWidget";
    const pre = document.createElement("pre");
    const codeEl = document.createElement("code");
    codeEl.className = "hljs";
    codeEl.innerHTML = highlightCode(this.code, this.lang);
    pre.appendChild(codeEl);
    if (this.lang) {
      const badge = document.createElement("span");
      badge.className = "codeLangBadge";
      badge.textContent = this.lang;
      span.appendChild(badge);
    }
    span.appendChild(makeCopyButton(() => this.code));
    span.appendChild(pre);
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      placeCaretInside(view, span, this.caretOffset);
    });
    return span;
  }
}

class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM(view) {
    const span = document.createElement("span");
    span.className = "cmHrLine";
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      placeCaretInside(view, span, 0);
    });
    return span;
  }
}

// Live inline rendering (Obsidian-style): math as KaTeX, [[id]] refs as
// chips, and markdown constructs — heading/quote prefixes hidden with the
// line styled, **bold** / *italic* / `code` / ~~strike~~ / [text](url) shown
// formatted with their delimiters hidden. Any construct the selection
// touches stays raw source (boundaries inclusive, so stepping the caret onto
// it expands it). labelsRef is read lazily so freshly resolved ref labels
// show up on the next rebuild.
const LIVE_PREVIEW_MAX_CHARS = 20_000;

function buildInlineDecos(state, labelsRef) {
  const text = state.doc.toString();
  // A pathological single block should remain fully editable. Decorations are
  // optional presentation, so fall back to plain CM rather than running every
  // regex and overlap check on each caret move in a very large block.
  if (text.length > LIVE_PREVIEW_MAX_CHARS) return Decoration.none;
  const sel = state.selection.main;
  const ranges = [];
  // Recognized spans claim their range even while shown raw, so e.g. a `**`
  // inside a math span or inline code never doubles as bold.
  const claimed = [];
  const overlapsClaimed = (from, to) => claimed.some(([a, b]) => from < b && to > a);
  const touched = (from, to) => sel.from <= to && sel.to >= from;

  // ``` fences claim their range FIRST — a "$" or "**" inside code is code.
  // A closed, untouched fence renders as a highlighted card; a touched or
  // still-open one stays raw and gets mono/tinted line styling below.
  const fences = text.includes("```") ? scanFences(text) : [];
  const rawFences = [];
  for (const f of fences) {
    claimed.push([f.from, f.to]);
    if (f.closed && !touched(f.from, f.to)) {
      const code = f.innerTo > f.innerFrom ? text.slice(f.innerFrom, f.innerTo - 1) : "";
      ranges.push(Decoration.replace({
        widget: new CodeBlockWidget(code, f.lang, f.innerFrom - f.from),
      }).range(f.from, f.to));
    } else {
      rawFences.push(f);
    }
  }

  // Raw (caret-touched) math spans collect here for the bracket rainbow pass.
  const rawMath = [];
  const mathSpans = text.includes("$") ? scanMathSpans(text) : [];
  for (const s of mathSpans) {
    if (overlapsClaimed(s.from, s.to)) continue;
    claimed.push([s.from, s.to]);
    const dlen = s.display ? 2 : 1;
    if (touched(s.from, s.to)) {
      rawMath.push({ from: s.from + dlen, to: s.to - dlen });
      continue;
    }
    const tex = text.slice(s.from + dlen, s.to - dlen);
    ranges.push(Decoration.replace({ widget: new MathWidget(tex, s.display) }).range(s.from, s.to));
  }
  // An UNCLOSED math span being typed at the caret is raw too — its brackets
  // should light up while the formula is only half-written.
  if (sel.empty) {
    const um = findMathAtCursor(text, sel.head);
    if (um
      && !mathSpans.some((s) => um.start >= s.from && um.end <= s.to)
      && !fences.some((f) => um.start >= f.from && um.start < f.to)) {
      rawMath.push({ from: um.start, to: um.end });
    }
  }

  // VSCode-style bracket pair colorization inside raw math: ( [ { colored by
  // nesting depth (3-color cycle), the innermost pair enclosing the caret
  // lifted, unmatched brackets flagged.
  const OPENERS = "([{", CLOSERS = ")]}";
  for (const r of rawMath) {
    const stack = [], pairs = [], loose = [];
    for (let p = r.from; p < r.to; p++) {
      const oi = OPENERS.indexOf(text[p]);
      if (oi >= 0) { stack.push({ p, t: oi }); continue; }
      const ci = CLOSERS.indexOf(text[p]);
      if (ci < 0) continue;
      const top = stack[stack.length - 1];
      if (top && top.t === ci) {
        stack.pop();
        pairs.push({ open: top.p, close: p, depth: stack.length });
      } else loose.push(p);
    }
    for (const s of stack) loose.push(s.p);
    let active = null;
    if (sel.empty) {
      for (const pr of pairs) {
        if (pr.open < sel.head && sel.head <= pr.close
          && (!active || pr.open > active.open)) active = pr;
      }
    }
    for (const pr of pairs) {
      const cls = `cmBk${pr.depth % 3}${pr === active ? " cmBkActive" : ""}`;
      ranges.push(Decoration.mark({ class: cls }).range(pr.open, pr.open + 1));
      ranges.push(Decoration.mark({ class: cls }).range(pr.close, pr.close + 1));
    }
    for (const p of loose) ranges.push(Decoration.mark({ class: "cmBkErr" }).range(p, p + 1));
  }

  for (const m of text.matchAll(/!?\[\[([a-zA-Z0-9_-]+)\]\]/g)) {
    const from = m.index, to = m.index + m[0].length;
    if (overlapsClaimed(from, to)) continue;
    claimed.push([from, to]);
    if (touched(from, to)) continue;
    const label = labelsRef.current?.[m[1]]?.content || m[1];
    ranges.push(Decoration.replace({
      widget: new RefChipWidget(label, m[0].startsWith("!")),
    }).range(from, to));
  }

  // Inline marks: [regex, delimiter length, class]. Matched in this order —
  // code first (its content is literal), italic last (most false-positive
  // prone). Delimiters are hidden and the inner text gets the mark class.
  const INLINE = [
    [/`([^`\n]+)`/g, 1, "cmInlineCode"],
    [/==(?!\s)([^=\n]+?)(?<!\s)==/g, 2, "cmHighlight"],
    [/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, 2, "cmStrong"],
    [/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, 2, "cmStrike"],
    [/(?<!\*)\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?!\*)/g, 1, "cmEm"],
  ];
  for (const [re, dlen, cls] of INLINE) {
    for (const m of text.matchAll(re)) {
      const from = m.index, to = m.index + m[0].length;
      if (overlapsClaimed(from, to)) continue;
      claimed.push([from, to]);
      if (touched(from, to)) continue;
      ranges.push(Decoration.replace({}).range(from, from + dlen));
      ranges.push(Decoration.mark({ class: cls }).range(from + dlen, to - dlen));
      ranges.push(Decoration.replace({}).range(to - dlen, to));
    }
  }

  // [text](url): show just the text, link-styled. Images (![...]) stay raw —
  // the rendered view shows the actual picture.
  for (const m of text.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
    const from = m.index, to = m.index + m[0].length;
    if (text[from - 1] === "!" || text[from + 1] === "[") continue;
    if (overlapsClaimed(from, to)) continue;
    claimed.push([from, to]);
    if (touched(from, to)) continue;
    ranges.push(Decoration.replace({}).range(from, from + 1));
    ranges.push(Decoration.mark({ class: "cmLinkText" }).range(from + 1, from + 1 + m[1].length));
    ranges.push(Decoration.replace({}).range(from + 1 + m[1].length, to));
  }

  // Bare URLs: just link-styled (never hidden — the rendered view shows the
  // title chip). Claimed so emphasis regexes can't chew on URL punctuation.
  for (const m of text.matchAll(/https?:\/\/[^\s<>()"\]]+/g)) {
    const from = m.index, to = m.index + m[0].length;
    if (overlapsClaimed(from, to)) continue;
    claimed.push([from, to]);
    ranges.push(Decoration.mark({ class: "cmLinkText" }).range(from, to));
  }

  // Line constructs: headings, quotes/callouts, task and bullet markers,
  // horizontal rules. Heading/quote prefixes un-hide while the caret is
  // anywhere on their line; task/bullet markers only when the caret is
  // strictly INSIDE the marker (so editing a todo's text keeps its checkbox).
  const inside = (from, to) => sel.from < to && sel.to > from;
  const doc = state.doc;
  // Contiguous "> " lines form one quote run; a run opening with "[!type]"
  // renders as a callout: tinted lines, colored bold title, marker hidden.
  const quoteRun = [];
  const flushQuoteRun = () => {
    if (!quoteRun.length) return;
    const co = quoteRun[0].line.text.match(/^> ?\[!(\w+)\][ \t]*/);
    const type = co ? calloutType(co[1]) : null;
    quoteRun.forEach(({ line, prefixLen, lineTouched }, i) => {
      let cls = "cmQuoteLine";
      if (type) {
        cls += ` cmCalloutLine cmCallout-${type}`;
        if (i === 0) cls += " cmCalloutFirst";
        if (i === quoteRun.length - 1) cls += " cmCalloutLast";
      }
      ranges.push(Decoration.line({ class: cls }).range(line.from));
      const hideLen = i === 0 && type ? co[0].length : prefixLen;
      if (!lineTouched && hideLen && !overlapsClaimed(line.from, line.from + hideLen)) {
        ranges.push(Decoration.replace({}).range(line.from, line.from + hideLen));
        if (i === 0 && type && line.text.length > hideLen
          && !overlapsClaimed(line.from + hideLen, line.to)) {
          ranges.push(Decoration.mark({ class: "cmCalloutTitle" }).range(line.from + hideLen, line.to));
        }
      }
    });
    quoteRun.length = 0;
  };
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    // Lines inside a ``` fence are code, not markdown: no headings, bullets
    // or rules. Raw (caret-touched / unclosed) fences get mono styling with
    // dimmed marker lines; widget-replaced ones need no line decorations.
    const cf = fences.length
      ? fences.find((f) => line.from >= f.from && line.to <= f.to)
      : null;
    if (cf) {
      flushQuoteRun();
      if (rawFences.includes(cf)) {
        let cls = "cmCodeLine";
        if (line.from === cf.from) cls += " cmCodeFenceLine cmCodeTop";
        else if (cf.closed && line.from === cf.innerTo) cls += " cmCodeFenceLine cmCodeBot";
        ranges.push(Decoration.line({ class: cls }).range(line.from));
      }
      continue;
    }
    const lineTouched = touched(line.from, line.to);
    const q = /^> ?/.exec(line.text);
    if (q) {
      quoteRun.push({ line, prefixLen: q[0].length, lineTouched });
      continue;
    }
    flushQuoteRun();
    const h = /^(#{1,6}) /.exec(line.text);
    if (h) {
      ranges.push(Decoration.line({ class: `cmHeadLine cmH${h[1].length}` }).range(line.from));
      if (!lineTouched && !overlapsClaimed(line.from, line.from + h[0].length)) {
        ranges.push(Decoration.replace({}).range(line.from, line.from + h[0].length));
      }
      continue;
    }
    const task = /^(\s*)([-*+] \[)( |x|X)\] /.exec(line.text);
    if (task) {
      const mFrom = line.from + task[1].length;
      const mTo = line.from + task[0].length;
      const checked = task[3] !== " ";
      if (checked) ranges.push(Decoration.line({ class: "cmTaskDone" }).range(line.from));
      if (!inside(mFrom, mTo) && !overlapsClaimed(mFrom, mTo)) {
        ranges.push(Decoration.replace({
          widget: new TaskCheckboxWidget(checked, task[2].length),
        }).range(mFrom, mTo));
      }
      continue;
    }
    const bullet = /^(\s*)[-*+] (?!\[)\S/.exec(line.text);
    if (bullet) {
      const bFrom = line.from + bullet[1].length;
      if (!inside(bFrom, bFrom + 2) && !overlapsClaimed(bFrom, bFrom + 1)) {
        ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(bFrom, bFrom + 1));
      }
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.text.trim()) && line.text.trim()
      && !lineTouched && !overlapsClaimed(line.from, line.to)) {
      ranges.push(Decoration.replace({ widget: new HrWidget() }).range(line.from, line.to));
    }
  }
  flushQuoteRun();

  return Decoration.set(ranges, true);
}

// A StateField, not a ViewPlugin: replace decorations that hide line breaks
// (multi-line $$math$$, ``` fences) are only allowed from state-level
// decoration sources — a plugin throws "Decorations that replace line breaks
// may not be specified via plugins".
function inlineRenderField(labelsRef) {
  return StateField.define({
    create: (state) => buildInlineDecos(state, labelsRef),
    update: (deco, tr) =>
      tr.docChanged || tr.selection ? buildInlineDecos(tr.state, labelsRef) : deco,
    provide: (f) => EditorView.decorations.from(f),
  });
}

// Textarea-compatible facade + component. blockTree talks to ref.current
// exactly like it talked to the textarea (value / selectionStart / focus /
// setSelectionRange / getBoundingClientRect), plus caretCoords(index) which
// replaces the hidden-mirror caret measurement.
const BlockCmEditor = React.forwardRef(function BlockCmEditor({
  value, onChange, onSelect, onKeyDown, onBlur, onPaste,
  placeholder, autoFocus, clickPos, dataBlockId, className, refLabels,
  livePreview = false,
}, forwardedRef) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const destroyingRef = useRef(false);
  const cbRef = useRef({});
  cbRef.current = { onChange, onSelect, onKeyDown, onBlur, onPaste };
  const labelsRef = useRef(refLabels);
  labelsRef.current = refLabels;
  const chipCompartment = useRef(new Compartment()).current;

  const api = useMemo(() => ({
    get value() { return viewRef.current ? viewRef.current.state.doc.toString() : ""; },
    get selectionStart() { return viewRef.current ? viewRef.current.state.selection.main.from : 0; },
    get selectionEnd() { return viewRef.current ? viewRef.current.state.selection.main.to : 0; },
    setSelectionRange(anchor, head) {
      const view = viewRef.current;
      if (!view) return;
      const len = view.state.doc.length;
      view.dispatch({
        selection: {
          anchor: Math.max(0, Math.min(anchor, len)),
          head: Math.max(0, Math.min(head ?? anchor, len)),
        },
      });
    },
    focus() {
      requestAnimationFrame(() => viewRef.current?.focus());
    },
    getBoundingClientRect() {
      return hostRef.current?.getBoundingClientRect() || { left: 0, top: 0, right: 0, bottom: 0 };
    },
    caretCoords(index) {
      const view = viewRef.current;
      if (!view) return { left: 0, top: 0, bottom: 0 };
      const c = view.coordsAtPos(Math.max(0, Math.min(index, view.state.doc.length)));
      if (c) return { left: c.left, top: c.top, bottom: c.bottom };
      const r = this.getBoundingClientRect();
      return { left: r.left, top: r.top, bottom: r.bottom };
    },
    get view() { return viewRef.current; },
  }), []);
  useImperativeHandle(forwardedRef, () => api, [api]);

  useLayoutEffect(() => {
    // React StrictMode replays setup/cleanup in development. Each fresh setup
    // must re-enable real blur delivery after the replayed teardown marked it.
    destroyingRef.current = false;
    const state = EditorState.create({
      doc: value || "",
      extensions: [
        EditorView.lineWrapping,
        history(),
        // Our keydown runs before CM's keymaps so Enter/Tab/etc. keep the
        // outliner semantics from blockTree; anything not preventDefault-ed
        // falls through to the default editing keymap.
        Prec.highest(EditorView.domEventHandlers({
          keydown: (e) => { cbRef.current.onKeyDown?.(e); return e.defaultPrevented; },
          paste: (e) => { cbRef.current.onPaste?.(e); return e.defaultPrevented; },
          blur: () => {
            if (!destroyingRef.current) cbRef.current.onBlur?.();
          },
        })),
        keymap.of([...historyKeymap, ...defaultKeymap]),
        cmPlaceholder(placeholder || ""),
        chipCompartment.of(livePreview ? inlineRenderField(labelsRef) : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cbRef.current.onChange?.({ target: api });
          else if (u.selectionSet) cbRef.current.onSelect?.({ target: api });
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    // This outliner already assigns Tab/Shift+Tab to indent/outdent. Disable
    // CodeMirror's tab-focus escape mode so those DOM key handlers actually run.
    view.setTabFocusMode(false);
    viewRef.current = view;
    // Caret placement on entering edit mode: at the clicked spot when we have
    // coords (the rendered text and the raw source don't line up exactly —
    // rendered math is shorter — but posAtCoords gets close), else at the end.
    let pos = view.state.doc.length;
    if (clickPos) {
      const p = view.posAtCoords({ x: clickPos.x, y: clickPos.y });
      if (p != null) pos = p;
    }
    view.dispatch({ selection: { anchor: pos } });
    // The editor mounts during the rendered row's mousedown. Focusing it in
    // that same event is undone by the original mouseup/click, which moves
    // focus to body and immediately fires blur. Focus after that click cycle.
    const focusFrame = autoFocus ? requestAnimationFrame(() => view.focus()) : null;
    return () => {
      destroyingRef.current = true;
      if (focusFrame != null) cancelAnimationFrame(focusFrame);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (programmatic inserts, autocomplete accepts) sync
  // in; self-originated edits arrive equal and no-op.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if ((value || "") !== cur) {
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: value || "" },
        annotations: Transaction.addToHistory.of(false),
      });
    }
  }, [value]);

  // Ref labels resolve asynchronously (onFetchRefs); refresh the chip
  // decorations when their text actually changes, not on every render.
  const labelsKey = Object.entries(refLabels || {})
    .map(([id, r]) => `${id}:${r?.content}`).join("\u0000");
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: chipCompartment.reconfigure(livePreview ? inlineRenderField(labelsRef) : []),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelsKey, livePreview]);

  return (
    <div
      ref={hostRef}
      className={className}
      data-block-id={dataBlockId}
    />
  );
});

export { BlockCmEditor, scanMathSpans };
