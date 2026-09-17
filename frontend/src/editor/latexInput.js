// Pure edits for scalable LaTeX delimiters. Callers scope these to math, so
// prose, pasted code and IME composition keep their ordinary input behavior.
const DELIMITERS = {
  "(": ")", "[": "]", "\\{": "\\}", "|": "|", "\\|": "\\|",
  "\\langle": "\\rangle", "\\lvert": "\\rvert", "\\lVert": "\\rVert",
  "\\lfloor": "\\rfloor", "\\lceil": "\\rceil",
};
const OPEN = /\\left\s*(\\(?:langle|lvert|lVert|lfloor|lceil|[{|])|[(\[|])$/;
const CLOSE = /^\\right\s*(\\(?:rangle|rvert|rVert|rfloor|rceil|[}|])|[)\]|.])/;
// An odd run of backslashes escapes the character at pos.
export function escapedAt(text, pos) {
  let n = 0;
  while (text[--pos] === "\\") n++;
  return n % 2 === 1;
}

export function rightDelimiterAt(text, pos) {
  return text[pos] === "\\" && !escapedAt(text, pos) ? CLOSE.exec(text.slice(pos))?.[0] || null : null;
}

export function leftDelimiterEdit(value, from, to, insert, start = 0, end = value.length) {
  const before = value.slice(start, from) + insert;
  const match = OPEN.exec(before);
  if (!match || escapedAt(before, match.index)) return null;
  const closer = "\\right" + DELIMITERS[match[1]];
  const after = value.slice(to, end);
  const inner = value.slice(from, to);
  // An existing matching right belongs to this opener only if all lefts
  // can already be closed. A nested left still needs its own closer.
  let balance = 0;
  const whole = before + inner + after;
  for (const token of whole.matchAll(/\\(left|right)\b/g)) {
    if (!escapedAt(whole, token.index)) balance += token[1] === "left" ? 1 : -1;
  }
  const supplied = balance <= 0 && after.startsWith(closer);
  return {
    changes: { from, to, insert: insert + inner + (supplied ? "" : closer) },
    selection: { anchor: from + insert.length, head: from + insert.length + inner.length },
  };
}

export function emptyLeftPair(value, cursor) {
  const match = OPEN.exec(value.slice(0, cursor));
  if (!match || escapedAt(value, match.index)) return null;
  const closer = "\\right" + DELIMITERS[match[1]];
  if (!value.startsWith(closer, cursor)) return null;
  return { from: match.index, to: cursor + closer.length };
}
