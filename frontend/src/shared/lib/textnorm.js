// Search text normalization: the frontend mirror of gamma/textnorm.py, so a
// query matches the same way in the notes DB, the PDF FTS index and the
// live pdf.js viewer. Pure strings, no DOM — the cases in
// tests/shared/textnorm.json (repository root) pin both sides.
//
//   normalizeQuery(s)      — a query box's text → canonical form
//   normalizeChars(chars)  — a page's characters → the same form, each
//                            output character remembering its source index
//                            (the viewer maps matches back to exact rects)
//   buildSearchRegex(q)    — query → separator-tolerant RegExp
//
// The rules, in this order: digit-group separators removed ("3,000" →
// "3000"; before NFKC, which would fold the no-break and thin spaces into
// plain ones), NFKC (folds ligatures like ﬁ), soft hyphens dropped, words
// re-joined across hyphenated line breaks, whitespace collapsed. Case is
// left alone.

export const DASH_CLASS = "\\-\\u2010-\\u2015";
export const DIGIT_SEP_CLASS = ",\\u00A0\\u202F\\u2009";

const DIGIT_SEP_RE = new RegExp(`(\\d)[${DIGIT_SEP_CLASS}](?=\\d)`, "g");
const isDash = (c) => c === "-" || (c >= "‐" && c <= "―");
const isDigit = (c) => !!c && c >= "0" && c <= "9";
const isDigitSep = (c) => c === "," || c === "\u00A0" || c === "\u202F" || c === "\u2009";
const isWord = (c) => !!c && /[\p{L}\p{N}_]/u.test(c); // Python's \w
const isSpace = (c) => !!c && /\s/.test(c);

// Query text → canonical searchable form (normalize_text minus the
// line-break rule, which can't occur in a query box).
export function normalizeQuery(s) {
  return (s || "")
    .replace(DIGIT_SEP_RE, "$1")
    .normalize("NFKC")
    .replace(/\u00AD/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Page text as [{ch}] (one entry per source character; "\n" for a line
// break) → {norm, src}: the normalized characters and, for each, the index
// of the source entry it came from. norm.join("") equals normalize_text of
// the same text.
export function normalizeChars(chars) {
  const norm = [];
  const src = [];
  const push = (c, i) => { norm.push(c); src.push(i); };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i].ch;
    if (ch === "\u00AD") continue; // soft hyphen
    if (isDigitSep(ch) && isDigit(chars[i - 1]?.ch) && isDigit(chars[i + 1]?.ch)) continue;
    if (isDash(ch) && isWord(chars[i - 1]?.ch)) {
      // Hyphenated line break: "sys-⏎tem" → "system"
      let j = i + 1, brk = false;
      while (j < chars.length && isSpace(chars[j].ch)) { if (chars[j].ch === "\n") brk = true; j++; }
      if (brk && isWord(chars[j]?.ch)) { i = j - 1; continue; }
    }
    for (const c of ch.normalize("NFKC")) {
      if (isSpace(c)) { if (norm.length && norm[norm.length - 1] !== " ") push(" ", i); }
      else push(c, i);
    }
  }
  if (norm.length && norm[norm.length - 1] === " ") { norm.pop(); src.pop(); }
  return { norm, src };
}

// Query → RegExp (null = empty/invalid). Non-regex queries are fuzzy: digits
// tolerate grouping separators, spaces and hyphens are interchangeable.

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function buildSearchRegex(q, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  let body;
  if (regex) {
    body = q;
  } else {
    q = normalizeQuery(q);
    const sep = new RegExp(`[\\s${DASH_CLASS}]`);
    const parts = [];
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      if (sep.test(c)) {
        parts.push(`[\\s${DASH_CLASS}]+`);
        while (i + 1 < q.length && sep.test(q[i + 1])) i++;
      } else {
        parts.push(escapeRegex(c));
        if (/\d/.test(c) && /\d/.test(q[i + 1] || "")) parts.push(`[${DIGIT_SEP_CLASS}\\s]?`);
      }
    }
    if (!parts.length) return null;
    body = parts.join("");
  }
  if (wholeWord) body = `\\b(?:${body})\\b`;
  try {
    return new RegExp(body, caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}
