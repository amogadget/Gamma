// Bounded, word-level substring alignment. Offsets always refer to the source
// text, not the quote, so edits never turn into estimated highlight geometry.
const negations = new Set(["no", "not", "nor", "neither", "never", "without", "cannot"]);

function tokens(text) {
  const result = [];
  const proseParentheses = new Set();
  for (const match of text.matchAll(/\(([^()]*)\)/g)) {
    // Parentheses around prose may be omitted; mathematical grouping must
    // remain significant, including expressions made only of variables.
    if (/^[\p{L}\s,;:'"-]+$/u.test(match[1]) && !/\p{Script=Greek}|\b[a-z]\b/u.test(match[1])) {
      proseParentheses.add(match.index); proseParentheses.add(match.index + match[0].length - 1);
    }
  }
  // Split letters from digits: PDF subscripts often add a space to 35P1/2.
  for (const match of text.matchAll(/\p{L}[\p{L}\p{M}]*|\p{N}+|[^\s]/gu)) {
    const value = match[0], start = match.index, end = start + value.length;
    // Ignore prose punctuation, but retain decimal points and mathematical
    // signs. A hyphen between words is typography; x-y and 53-70 are not.
    if (proseParentheses.has(start)) continue;
    const previous = result.at(-1);
    const afterVariable = previous?.end === start && (previous.value.length === 1 || /\p{N}/u.test(previous.value));
    if (/^[,;:!?"']$/.test(value) && !afterVariable) continue;
    if (value === "." && !(/\d/.test(text[start - 1] || "") && /\d/.test(text[end] || ""))) continue;
    if (value === "-") {
      const left = text.slice(0, start).match(/\p{L}+$/u)?.[0] || "";
      const right = text.slice(end).match(/^\p{L}+/u)?.[0] || "";
      if (left && right && Math.max(left.length, right.length) > 1) continue;
    }
    const locked = /[\p{N}\p{Script=Greek}]|[^\p{L}\p{M}]/u.test(value)
      || value.length === 1 || negations.has(value);
    result.push({ value, start, end, locked });
  }
  return result;
}

function substitution(a, b) {
  if (a.value === b.value) return 0;
  if (a.locked || b.locked) return Infinity;
  // Small OCR/spelling errors cost less than replacing a whole word. Bound
  // both word lengths and distance so malformed text cannot trigger huge DPs.
  const x = a.value, y = b.value, limit = Math.min(2, Math.floor(Math.min(x.length, y.length) / 5));
  if (!limit || Math.abs(x.length - y.length) > limit || Math.max(x.length, y.length) > 40) return 4;
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    if (Math.min(...row) > limit) return 4;
    previous = row;
  }
  return previous[y.length] <= limit ? previous[y.length] : 4;
}

export function fuzzyCitationRange(text, quote) {
  const source = tokens(text), target = tokens(quote);
  const words = target.filter(t => /\p{L}/u.test(t.value)).length;
  // Short snippets do not provide enough evidence for fuzzy matching. The
  // cell cap bounds synchronous work on unusually dense pages/long quotes.
  if (words < 8 || quote.replace(/\s/g, "").length < 40 || source.length * target.length > 1_000_000) {
    return { status: "missing" };
  }
  const budget = Math.min(32, Math.floor(words / 8) * 4);
  let costs = new Float64Array(source.length + 1);
  let starts = Int32Array.from({ length: source.length + 1 }, (_, i) => i);
  for (let i = 0; i < target.length; i++) {
    const row = new Float64Array(source.length + 1).fill(Infinity);
    const rowStarts = new Int32Array(source.length + 1);
    const word = target[i], cache = new Map();
    // Keep both ends of the quote: fuzzy matching cannot succeed merely by
    // dropping its opening or closing words.
    const deletion = word.locked || i === 0 || i === target.length - 1 ? Infinity : 4;
    for (let j = 1; j <= source.length; j++) {
      const other = source[j - 1];
      let change = cache.get(other.value);
      if (change === undefined) { change = substitution(word, other); cache.set(other.value, change); }
      let cost = costs[j - 1] + change, start = starts[j - 1];
      const insert = row[j - 1] + (other.locked ? Infinity : 4);
      const remove = costs[j] + deletion;
      if (insert < cost || (insert === cost && rowStarts[j - 1] < start)) { cost = insert; start = rowStarts[j - 1]; }
      if (remove < cost || (remove === cost && starts[j] < start)) { cost = remove; start = starts[j]; }
      if (cost <= budget) { row[j] = cost; rowStarts[j] = start; }
    }
    costs = row; starts = rowStarts;
  }
  const candidates = [];
  for (let j = 1; j <= source.length; j++) {
    if (costs[j] <= budget) candidates.push({ start: starts[j], end: j, cost: costs[j] });
  }
  candidates.sort((a, b) => a.cost - b.cost || (a.end - a.start) - (b.end - b.start));
  const best = candidates[0];
  if (!best) return { status: "missing" };
  // Alternate endpoints around one passage are one candidate. A separate
  // passage meeting the same threshold is ambiguous, even if slightly worse.
  if (candidates.some(c => Math.min(c.end, best.end) - Math.max(c.start, best.start)
      < Math.min(c.end - c.start, best.end - best.start) / 2)) return { status: "ambiguous" };
  return { status: "matched", start: source[best.start].start, end: source[best.end - 1].end };
}
