// `$$…$$` means display math.
//
// That is what the editor does — blockCmEditor's scanMathSpans keys `display`
// off the delimiter length, so a `$$` span renders centred while you are
// typing it — and it is what people mean by writing two dollars.
//
// remark-math disagrees when the span is on one line. micromark's `mathFlow`
// treats the rest of the opening line as "meta", and meta may not contain a
// `$`, so `$$ E = mc^2 $$` fails the block rule and falls back to *inline*
// math. The visible result: a centred equation that snapped inline the moment
// the block stopped being edited, and only that block, which looks like a
// rendering bug rather than a parsing rule.
//
// The fix is to hand the parser the multi-line form it does recognise, in the
// case where the intent is unambiguous.

// A whole line that is nothing but one `$$…$$` span. An escaped `\$` may
// appear inside — the editor's tokenizer (scanMathSpans) skips those too — but
// a bare one may not, so `$$a$$ $$b$$` (two spans) is left alone.
const WHOLE_LINE_DISPLAY = /^(\s*)\$\$((?:\\\$|[^$\n])+)\$\$\s*$/;

// Fences whose contents are not markdown and must not be touched.
const CODE_FENCE = /^\s*(?:```|~~~)/;
const MATH_FENCE = /^\s*\$\$\s*$/;

/**
 * Expand one-line `$$…$$` into the block form remark-math renders as display
 * math. Text inside code fences is untouched, and so is a span that shares a
 * line with other text: turning that into a block would split the paragraph,
 * and inside a table cell it would destroy the table.
 *
 * @param {string} text markdown as the user typed it
 * @returns {string} markdown with whole-line display math in block form
 */
export function normalizeDisplayMath(text) {
  if (!text || !text.includes("$$")) return text || "";

  const lines = text.split("\n");
  let inCode = false;
  let inMath = false;
  let changed = false;

  const out = lines.map((line) => {
    if (CODE_FENCE.test(line)) {
      inCode = !inCode;
      return line;
    }
    if (inCode) return line;

    // A bare `$$` opens or closes math that is already in block form; leave
    // everything between them exactly as written.
    if (MATH_FENCE.test(line)) {
      inMath = !inMath;
      return line;
    }
    if (inMath) return line;

    const match = WHOLE_LINE_DISPLAY.exec(line);
    if (!match) return line;
    const inner = match[2].trim();
    if (!inner) return line;
    changed = true;
    // The indent is dropped deliberately: four spaces before `$$` would make
    // the block an indented code block instead.
    return `$$\n${inner}\n$$`;
  });

  return changed ? out.join("\n") : text;
}
