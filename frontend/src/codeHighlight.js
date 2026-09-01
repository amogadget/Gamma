// Fenced ``` code blocks: the fence scanner shared by the editor's live
// decorations, blockTree's markdown preprocessing and key handling, plus a
// highlight.js wrapper (lib/common — the ~37 mainstream languages) that
// falls back to escaped plain text for unknown or missing languages, and the
// code card's copy button (shared by the editor widget and the rendered view).
import hljs from "highlight.js/lib/common";
import { copyText } from "./utils";

// All ``` fenced regions in the text, in order:
//   [{from, to, innerFrom, innerTo, lang, closed}]
// from/to include the fence marker lines (to = end of the closing line, or
// text end while the fence is still open); innerFrom = start of the first
// code line, innerTo = start of the closing line (== code end + "\n").
export function scanFences(text) {
  const fences = [];
  let open = null;
  let pos = 0;
  for (const line of text.split("\n")) {
    const end = pos + line.length;
    const m = /^(`{3,})(.*)$/.exec(line);
    if (m) {
      if (!open) {
        open = {
          from: pos,
          ticks: m[1].length,
          lang: m[2].trim(),
          innerFrom: Math.min(end + 1, text.length),
        };
      } else if (m[1].length >= open.ticks && !m[2].trim()) {
        fences.push({
          from: open.from, to: end,
          innerFrom: open.innerFrom, innerTo: pos,
          lang: open.lang, closed: true,
        });
        open = null;
      }
    }
    pos = end + 1;
  }
  if (open) {
    fences.push({
      from: open.from, to: text.length,
      innerFrom: open.innerFrom, innerTo: text.length,
      lang: open.lang, closed: false,
    });
  }
  return fences;
}

// The fence whose CODE the caret sits in (from the end of the opening ```
// line through the start of the closing line) — where Enter must insert a
// line break instead of a new note, and math/slash popups stay quiet.
export function fenceInnerAt(text, pos) {
  if (!text || !text.includes("```")) return null;
  return scanFences(text).find((f) => pos >= f.innerFrom - 1 && pos <= f.innerTo) || null;
}

const escapeHtml = (s) => s
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// HTML for a code string: hljs token spans when the language is known,
// escaped plain text otherwise (no auto-detection — wrong guesses look
// worse than no colors, and Obsidian/GitHub behave the same way).
export function highlightCode(code, lang) {
  const language = (lang || "").split(/\s/)[0].toLowerCase();
  if (language && hljs.getLanguage(language)) {
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } catch (_) { /* fall through to plain */ }
  }
  return escapeHtml(code);
}

// Inline SVGs (the CodeMirror widget is vanilla DOM — React icons can't be
// used there, so both consumers share these).
const COPY_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

// The code card's copy button: copies getText(), flashes a check for a beat.
// stopPropagation on mousedown/click — in the editor widget the card's own
// mousedown places the caret inside, and copying must not enter edit mode.
export function makeCopyButton(getText) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "uiClose codeCopyBtn";
  btn.title = "Copy code";
  btn.innerHTML = COPY_SVG;
  btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    copyText(getText());
    btn.innerHTML = CHECK_SVG;
    setTimeout(() => { btn.innerHTML = COPY_SVG; }, 1200);
  });
  return btn;
}
