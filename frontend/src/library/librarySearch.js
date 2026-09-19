import { DASH_CLASS, buildSearchRegex, normalizeQuery } from "../shared/lib/textnorm.js";

// Damerau-Levenshtein distance (adjacent transpositions count as one edit),
// capped: returns max+1 as soon as the budget is provably blown. Both inputs
// are short (a query term vs. one title word). Rows are module-level scratch
// reused across calls — this runs for every word of every non-matching title
// on each keystroke, so per-call allocations would dominate.
const EDIT_SCRATCH = [new Array(48), new Array(48), new Array(48)];
function editDistanceWithin(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length + 1;
  if (EDIT_SCRATCH[0].length < n) for (let k = 0; k < 3; k++) EDIT_SCRATCH[k] = new Array(n);
  let [prev2, prev, cur] = EDIT_SCRATCH;
  for (let j = 0; j < n; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j < n; j++) {
      let v = Math.min(
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        prev[j] + 1,
        cur[j - 1] + 1,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev2; prev2 = prev; prev = cur; cur = t;
  }
  return prev[n - 1];
}

// One title against one prepared query → relevance score (0 = no hit).
// Quick-open-style tiered heuristic: every term must hit somewhere — as an
// exact (separator-tolerant) substring, or failing that as a typo against a
// title word (Meilisearch's budgets: 1 edit from 5 chars, 2 from 9; shorter
// terms stay exact so "ion" can't blur into "in"). The exact phrase (terms
// adjacent, in order) dominates, word-boundary hits beat mid-word ones,
// typo hits score below both, and dense, early matches in short titles win
// ties. Titles are scanned per query, with scores cached by page id.
// Plain alphabetic terms use indexOf; words are tokenized only for typo matching.
function scoreTitle(title, phraseRe, terms, caseSensitive) {
  if (!title) return 0;
  const hay = caseSensitive ? title : title.toLowerCase();
  let score = 0, matched = 0, first = Infinity;
  let words = null; // lazily tokenized, only when some term needs the typo pass
  for (const { re, text, plain } of terms) {
    let idx = -1, len = 0;
    if (plain) {
      idx = hay.indexOf(text);
      len = text.length;
    } else {
      re.lastIndex = 0;
      const m = re.exec(title);
      if (m) { idx = m.index; len = m[0].length; }
    }
    if (idx >= 0) {
      first = Math.min(first, idx);
      matched += len;
      score += idx === 0 || /[^\p{L}\p{N}]/u.test(title[idx - 1]) ? 12 : 4;
      continue;
    }
    const budget = text.length >= 9 ? 2 : text.length >= 5 ? 1 : 0;
    if (!budget) return 0;
    if (!words) words = [...hay.matchAll(/[\p{L}\p{N}]+/gu)];
    let best = null;
    const t0 = text[0];
    for (const w of words) {
      // Meilisearch's other typo rule: a first-letter typo counts double.
      // Besides matching real typo patterns, this one-char comparison skips
      // the DP for most words, which is what keeps big libraries fast.
      const eff = w[0][0] === t0 ? budget : budget - 1;
      if (eff < 1) continue;
      const d = editDistanceWithin(text, w[0], eff);
      if (d <= eff && (!best || d < best.d)) best = { d, w };
      if (best?.d === 1) break; // d=0 is impossible (the substring pass would have hit)
    }
    if (!best) return 0;
    first = Math.min(first, best.w.index);
    matched += Math.max(1, best.w[0].length - best.d);
    score += best.d === 1 ? 8 : 5;
  }
  phraseRe.lastIndex = 0;
  const pm = phraseRe.exec(title);
  if (pm) score += pm.index === 0 ? 90 : 60;
  score += 20 * (matched / title.length); // coverage: tight titles beat incidental mentions
  return score - Math.min(10, first / 10); // earlier first hit nudges up
}

// Shared by workspace search and chat's library picker.
export function createTitleScorer(query, { caseSensitive = false, wholeWord = false } = {}) {
  const phrase = buildSearchRegex(query, { caseSensitive, wholeWord });
  if (!query.trim() || !phrase) return null;
  const dashRe = new RegExp(`[${DASH_CLASS}]`);
  const terms = normalizeQuery(query).split(/\s+/).filter(Boolean).map((t) => ({
    re: buildSearchRegex(t, { caseSensitive, wholeWord }),
    text: caseSensitive ? t : t.toLowerCase(),
    plain: !wholeWord && !dashRe.test(t) && !/\d\d/.test(t),
  })).filter((t) => t.re);
  const cache = new Map();
  return (page) => {
    if (!cache.has(page.id)) {
      const title = page.content || "";
      cache.set(page.id, scoreTitle(title, phrase, terms, caseSensitive));
    }
    return cache.get(page.id);
  };
}
