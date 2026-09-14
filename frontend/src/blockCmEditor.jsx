// The block editor: a single CodeMirror 6 instance (only the block being
// edited mounts one) that mimics the old textarea's API so blockTree keeps
// its key handling, [[ref]] popup and LaTeX autocomplete untouched, and adds
// Notion/Obsidian-style live rendering: a closed $...$ / $$...$$ span (or a
// [[block-ref]]) whose text the caret is NOT touching renders in place;
// moving the caret into it (arrow keys, or clicking the rendered chip)
// expands it back to source.
import React, { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { Annotation, Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration, EditorView, WidgetType, keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { escapedAt, findMathAtCursor, renderKatex } from "./latexEditor";
import { calloutType } from "./callouts";
import { fenceInnerAt, highlightCode, makeCopyButton, scanFences } from "./codeHighlight";
import { insertLink, isUrl, scanMarks, toggleMark } from "./mdMarks";

// All CLOSED math spans in the text: [{from, to, display}] with from/to
// including the delimiters. Same tokenizer as latexEditor's findMathAtCursor
// (escaped \$ skipped), but only complete pairs — an unclosed opener stays
// raw text while it's being typed. Inline spans must sit on one line and be
// non-empty; "$5 and $3" across prose otherwise pairs into a bogus formula.
function scanMathSpans(text) {
  const re = /\$\$?/g;
  const spans = [];
  let m, open = null;
  while ((m = re.exec(text))) {
    if (escapedAt(text, m.index)) continue;
    const tok = { i: m.index, len: m[0].length };
    if (!open) {
      open = tok;
    } else if (tok.len === open.len) {
      const inner = text.slice(open.i + open.len, tok.i);
      const ok = inner.trim() && (open.len === 2 || !inner.includes("\n"));
      if (ok) spans.push({ from: open.i, to: tok.i + tok.len, display: open.len === 2 });
      open = null;
    } else {
      // Mismatched pair ($ ... $$): treat the later token as a fresh opener.
      open = tok;
    }
  }
  return spans;
}

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
    const html = renderKatex(this.tex, this.display);
    if (html) span.innerHTML = html;
    else span.textContent = this.tex;
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
function buildInlineDecos(state, labelsRef) {
  const text = state.doc.toString();
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
      ranges.push(Decoration.mark({ class: "cmMathRaw" }).range(s.from, s.to));
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
      ranges.push(Decoration.mark({ class: "cmMathRaw" })
        .range(um.start - (um.display ? 2 : 1), um.end));
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
    // The \command the caret sits on lights up, like the active bracket pair.
    if (sel.empty) {
      for (const m of text.slice(r.from, r.to).matchAll(/\\[a-zA-Z]+/g)) {
        const from = r.from + m.index, to = from + m[0].length;
        if (sel.head >= from && sel.head <= to) {
          ranges.push(Decoration.mark({ class: "cmMathCmdActive" }).range(from, to));
          break;
        }
      }
    }
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

  // Inline marks (**bold** etc., table in mdMarks.js — shared with the
  // formatting hotkeys): delimiters hidden, inner text gets the mark class.
  for (const { marker, cls, from, to } of scanMarks(text, claimed)) {
    if (touched(from, to)) continue;
    const dlen = marker.length;
    ranges.push(Decoration.replace({}).range(from, from + dlen));
    ranges.push(Decoration.mark({ class: cls }).range(from + dlen, to - dlen));
    ranges.push(Decoration.replace({}).range(to - dlen, to));
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

// --- other people's carets ------------------------------------------------
// The peers editing THIS block (collab.js presence: {client, rev, anchor,
// head, color, name}) render as a coloured caret with a name tag plus a
// tinted selection. A StateField keyed by peer: a peer whose `rev` changed
// (a new caret report — standalone, or riding on its batch) is placed fresh
// from its offsets, in the text of the transaction that carries the effect
// (the batch's text change comes in the same render, and runs first); the
// others keep their carets mapped through every change, so a remote caret
// stays put while we type and someone else's edit shifts it correctly.
const setRemoteCursors = StateEffect.define();

class RemoteCaretWidget extends WidgetType {
  constructor(name, color) {
    super();
    this.name = name;
    this.color = color;
  }
  eq(other) { return other.name === this.name && other.color === this.color; }
  toDOM() {
    const span = document.createElement("span");
    span.className = `cmRemoteCaret peer-${this.color}`;
    span.setAttribute("data-name", this.name);
    return span;
  }
  ignoreEvent() { return true; }
}

function buildRemoteDecos(peers) {
  const ranges = [];
  for (const c of peers.values()) {
    const from = Math.min(c.anchor, c.head), to = Math.max(c.anchor, c.head);
    if (from < to) ranges.push(Decoration.mark({ class: `cmRemoteSel peer-${c.color}` }).range(from, to));
    ranges.push(Decoration.widget({ widget: new RemoteCaretWidget(c.name || "", c.color || 0), side: 1 }).range(c.head));
  }
  return Decoration.set(ranges, true);
}

// state: { peers: Map<client, {rev, anchor, head, color, name}> (positions
// kept current in this editor's text), deco: the decorations built from it }
const remoteCursorField = StateField.define({
  create: () => ({ peers: new Map(), deco: Decoration.none }),
  update(st, tr) {
    let peers = st.peers;
    let changed = false;
    if (tr.docChanged && peers.size) {
      // Like a caret: an insertion at the position lands before it.
      peers = new Map([...peers].map(([k, c]) => [k, {
        ...c, anchor: tr.changes.mapPos(c.anchor, 1), head: tr.changes.mapPos(c.head, 1),
      }]));
      changed = true;
    }
    for (const e of tr.effects) {
      if (!e.is(setRemoteCursors)) continue;
      const len = tr.state.doc.length;
      const clamp = (n) => Math.max(0, Math.min(Number(n) || 0, len));
      const next = new Map();
      for (const c of e.value || []) {
        const key = c.client || `${c.color}:${c.name}`;
        const prev = peers.get(key);
        next.set(key, prev && prev.rev === c.rev && prev.color === c.color && prev.name === c.name
          ? prev
          : { rev: c.rev, anchor: clamp(c.anchor), head: clamp(c.head), color: c.color || 0, name: c.name || "" });
      }
      peers = next;
      changed = true;
    }
    return changed ? { peers, deco: buildRemoteDecos(peers) } : st;
  },
  provide: (f) => EditorView.decorations.from(f, (st) => st.deco),
});

// A value change that came from outside the editor (a remote edit, an undo
// restore): applied as the smallest replacement so the caret and the remote
// carets map through, and never reported back as a local change.
const externalSync = Annotation.define();

// Textarea-compatible facade + component. blockTree talks to ref.current
// exactly like it talked to the textarea (value / selectionStart / focus /
// setSelectionRange / getBoundingClientRect), plus caretCoords(index) which
// replaces the hidden-mirror caret measurement.
// --- "$" auto-pairing --------------------------------------------------------
// Typing "$" closes the pair ("$|$"); typing "$" again inside the fresh empty
// pair upgrades it to display math ("$$|$$"); with text selected "$" wraps it;
// a "$" typed right before an existing "$" types over instead of doubling the
// closer. Inside ``` code a "$" is a shell variable and an escaped "\$" a
// literal dollar — both stay plain.
// A caret between two dollars is textually ambiguous: "$|$" could be the
// fresh pair the previous keystroke auto-closed (where another "$" should
// upgrade to "$$|$$") or the two CLOSERS of "$$…$$" being typed over (where
// doubling them would corrupt the formula). Only the auto-close itself knows,
// so it leaves a marker that the very next "$" at the same spot consumes.
const _freshPair = new WeakMap(); // view → {pos, len}

const dollarPairing = EditorView.inputHandler.of((view, from, to, insert) => {
  if (insert !== "$") return false;
  const doc = view.state.doc.toString();
  if (fenceInnerAt(doc, from) || doc[from - 1] === "\\") return false;
  const sel = view.state.selection.main;
  if (!sel.empty) {
    view.dispatch({
      changes: [{ from: sel.from, insert: "$" }, { from: sel.to, insert: "$" }],
      selection: { anchor: sel.from + 1, head: sel.to + 1 },
      userEvent: "input.type",
    });
    return true;
  }
  const next = doc[from];
  const fp = _freshPair.get(view);
  if (doc[from - 1] === "$" && next === "$"
    && fp && fp.pos === from && fp.len === doc.length) {
    _freshPair.delete(view);
    view.dispatch({                          // fresh "$|$" → "$$|$$"
      changes: [{ from, insert: "$" }, { from: from + 1, insert: "$" }],
      selection: { anchor: from + 1 },
      userEvent: "input.type",
    });
    return true;
  }
  if (next === "$") {                        // type over an existing closer
    view.dispatch({ selection: { anchor: from + 1 }, userEvent: "select" });
    return true;
  }
  view.dispatch({
    changes: { from, to, insert: "$$" },
    selection: { anchor: from + 1 },
    userEvent: "input.type",
  });
  _freshPair.set(view, { pos: from + 1, len: view.state.doc.length });
  return true;
});

// Backspace between the dollars of an empty pair deletes both — "$$|$$"
// steps down to "$|$" first, then to nothing.
const dollarBackspace = keymap.of([{
  key: "Backspace",
  run: (view) => {
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    if (view.state.doc.sliceString(sel.head - 1, sel.head + 1) !== "$$") return false;
    view.dispatch({
      changes: { from: sel.head - 1, to: sel.head + 1 },
      userEvent: "delete.backward",
    });
    return true;
  },
}]);

// --- bracket auto-pairing inside math ----------------------------------------
// VSCode-like, scoped to $...$/$$...$$ spans (prose and code-fence brackets
// stay plain characters): typing ( [ { closes the pair with the caret
// between — "\{" pairs LaTeX-style with "\}" — typing a closer over an
// existing one steps past it instead of doubling, a selection gets wrapped
// (and stays selected, ready for the next wrap), and Backspace between an
// empty pair deletes both.
const BRACKET_PAIRS = { "(": ")", "[": "]", "{": "}" };
const BRACKET_CLOSERS = new Set([")", "]", "}"]);

const mathBracketPairing = EditorView.inputHandler.of((view, from, to, insert) => {
  const close = BRACKET_PAIRS[insert];
  if (!close && !BRACKET_CLOSERS.has(insert)) return false;
  const doc = view.state.doc.toString();
  if (fenceInnerAt(doc, from)) return false;
  const seg = findMathAtCursor(doc, from);
  if (!seg) return false;
  const sel = view.state.selection.main;
  if (!sel.empty) {
    if (!close || sel.to > seg.end) return false;
    view.dispatch({
      changes: [{ from: sel.from, insert }, { from: sel.to, insert: close }],
      selection: { anchor: sel.from + 1, head: sel.to + 1 },
      userEvent: "input.type",
    });
    return true;
  }
  if (escapedAt(doc, from)) {
    if (insert !== "{") return false;          // literal \) \] \} etc.
    view.dispatch({
      changes: { from, insert: "{\\}" },
      selection: { anchor: from + 1 },
      userEvent: "input.type",
    });
    return true;
  }
  if (!close) {                                // a closer: type over
    if (doc[from] !== insert) return false;
    view.dispatch({ selection: { anchor: from + 1 }, userEvent: "select" });
    return true;
  }
  view.dispatch({
    changes: { from, to, insert: insert + close },
    selection: { anchor: from + 1 },
    userEvent: "input.type",
  });
  return true;
});

const mathBracketBackspace = keymap.of([{
  key: "Backspace",
  run: (view) => {
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    const doc = view.state.doc.toString();
    if (fenceInnerAt(doc, sel.head) || !findMathAtCursor(doc, sel.head)) return false;
    const esc = doc.slice(sel.head - 2, sel.head + 2) === "\\{\\}";
    if (!esc && BRACKET_PAIRS[doc[sel.head - 1]] !== doc[sel.head]) return false;
    view.dispatch({
      changes: { from: sel.head - (esc ? 2 : 1), to: sel.head + (esc ? 2 : 1) },
      userEvent: "delete.backward",
    });
    return true;
  },
}]);

// --- formatting hotkeys -------------------------------------------------------
// Obsidian's bindings (Ctrl/Cmd+B bold, +I italic, +K link) plus the marks it
// leaves unbound: Ctrl+E inline code (Notion's key), Ctrl+Shift+X strike,
// Ctrl+Shift+H highlight. Toggle semantics live in mdMarks.toggleMark. Inside
// math, a code fence or inline code the key is swallowed and does nothing —
// letting it through would hand Ctrl+B to the browser (Firefox: bookmarks).
const MARK_KEYS = [
  ["Mod-b", "**"], ["Mod-i", "*"], ["Mod-e", "`"],
  ["Mod-Shift-x", "~~"], ["Mod-Shift-h", "=="],
];

function markBlockedAt(doc, from, to, marker) {
  if (fenceInnerAt(doc, from) || fenceInnerAt(doc, to)) return true;
  if (scanMathSpans(doc).some((s) => s.from < to && from < s.to)) return true;
  if (marker === "`") return false;
  return scanMarks(doc).some((s) => s.marker === "`" && s.from < from && to < s.to);
}

function runToggleMark(view, marker) {
  const doc = view.state.doc.toString();
  const { from, to } = view.state.selection.main;
  if (markBlockedAt(doc, from, to, marker)) return true;
  const r = toggleMark(doc, from, to, marker);
  if (r) view.dispatch({ changes: r.changes, selection: r.selection, userEvent: "input" });
  return true;
}

function runInsertLink(view) {
  const doc = view.state.doc.toString();
  const { from, to } = view.state.selection.main;
  if (markBlockedAt(doc, from, to, "")) return true;
  const r = insertLink(doc, from, to);
  view.dispatch({ changes: r.changes, selection: r.selection, userEvent: "input" });
  // A URL on the clipboard fills the empty (…) slot — read asynchronously
  // (and not at all on plain-HTTP origins, where navigator.clipboard is
  // missing); only applied if the doc hasn't moved on meanwhile.
  const slot = from + 1 + (to - from) + 2;
  const expect = view.state.doc.toString();
  navigator.clipboard?.readText?.().then((clip) => {
    if (!isUrl(clip) || view.state.doc.toString() !== expect) return;
    const url = clip.trim();
    const label = to - from;
    view.dispatch({
      changes: { from: slot, insert: url },
      selection: { anchor: label ? slot + url.length + 1 : from + 1 },
      userEvent: "input",
    });
  }).catch(() => {});
  return true;
}

const markHotkeys = keymap.of([
  ...MARK_KEYS.map(([key, marker]) => ({
    key, preventDefault: true, run: (view) => runToggleMark(view, marker),
  })),
  { key: "Mod-k", preventDefault: true, run: runInsertLink },
]);

const BlockCmEditor = React.forwardRef(function BlockCmEditor({
  value, onChange, onSelect, onKeyDown, onBlur, onPaste,
  placeholder, autoFocus, clickPos, dataBlockId, className, refLabels, remoteCursors,
}, forwardedRef) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
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
    focus() { viewRef.current?.focus(); },
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
    const state = EditorState.create({
      doc: value || "",
      extensions: [
        EditorView.lineWrapping,
        // No history() here: undo is the page's one block history
        // (blockHistory.js) — Ctrl+Z bubbles to the window listener, which
        // restores the block's text and hands the caret back.
        // Our keydown runs before CM's keymaps so Enter/Tab/etc. keep the
        // outliner semantics from blockTree; anything not preventDefault-ed
        // falls through to the default editing keymap.
        Prec.highest(EditorView.domEventHandlers({
          keydown: (e) => { cbRef.current.onKeyDown?.(e); return e.defaultPrevented; },
          paste: (e) => { cbRef.current.onPaste?.(e); return e.defaultPrevented; },
          // Alt+Tab / app switch blurs the element too, but it stays
          // document.activeElement and the browser refocuses it on return —
          // only a blur while the window itself has focus (clicking away)
          // closes the editing session. Content is safe either way: every
          // keystroke already went through onChange → debounced autosave.
          blur: () => { if (document.hasFocus()) cbRef.current.onBlur?.(); },
        })),
        dollarPairing,
        dollarBackspace,
        mathBracketPairing,
        mathBracketBackspace,
        markHotkeys,
        keymap.of(defaultKeymap),
        cmPlaceholder(placeholder || ""),
        chipCompartment.of(inlineRenderField(labelsRef)),
        remoteCursorField,
        EditorView.updateListener.of((u) => {
          if (u.transactions.some((tr) => tr.annotation(externalSync))) return;
          if (u.docChanged) {
            // The selection the change started from — the history stores it
            // with the entry so undo can put the cursor back there.
            const s = u.startState.selection.main;
            cbRef.current.onChange?.({ target: api, selectionBefore: { from: s.from, to: s.to } });
          }
          else if (u.selectionSet) cbRef.current.onSelect?.({ target: api });
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    if (autoFocus) view.focus();
    // Caret placement on entering edit mode: at the clicked spot when we have
    // coords (the rendered text and the raw source don't line up exactly —
    // rendered math is shorter — but posAtCoords gets close), else at the end.
    let pos = view.state.doc.length;
    if (clickPos) {
      const p = view.posAtCoords({ x: clickPos.x, y: clickPos.y });
      if (p != null) pos = p;
    }
    view.dispatch({ selection: { anchor: pos } });
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (a remote edit, an undo restore, programmatic
  // inserts) sync in as the minimal prefix/suffix replacement — the caret
  // maps through instead of jumping; self-originated edits arrive equal.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    const next = value || "";
    if (next === cur) return;
    const max = Math.min(cur.length, next.length);
    let head = 0;
    while (head < max && cur.charCodeAt(head) === next.charCodeAt(head)) head++;
    let tail = 0;
    while (tail < max - head && cur.charCodeAt(cur.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)) tail++;
    view.dispatch({
      changes: { from: head, to: cur.length - tail, insert: next.slice(head, next.length - tail) },
      annotations: externalSync.of(true),
    });
  }, [value]);

  // Peers' carets in this block.
  const cursorsKey = (remoteCursors || []).map((c) => `${c.client}:${c.rev}:${c.color}:${c.anchor}:${c.head}:${c.name}`).join("|");
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setRemoteCursors.of(remoteCursors || []) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorsKey]);

  // Ref labels resolve asynchronously (onFetchRefs); refresh the chip
  // decorations when their text actually changes, not on every render.
  const labelsKey = Object.entries(refLabels || {})
    .map(([id, r]) => `${id}:${r?.content}`).join(" ");
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: chipCompartment.reconfigure(inlineRenderField(labelsRef)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelsKey]);

  return (
    <div
      ref={hostRef}
      className={className}
      data-block-id={dataBlockId}
    />
  );
});

export { BlockCmEditor, scanMathSpans };
