// Workspace search (Ctrl+F / Ctrl+Shift+F): one popover covering paper
// titles, notes/highlights, reference links, the open PDF's text, and the
// server-side FTS index over every paper's PDF. Extracted from App.jsx.
//
// Matching is separator-tolerant everywhere ("3000" finds "3,000-qubit"):
// buildSearchRegex mirrors the backend's gamma/textnorm.py rules, and the
// PDF viewer searches through the same normalized view of the page text
// (see pdfViewer.jsx) — keep the three in sync.
//
// Results are grouped by how directly they answer the query: matching paper
// titles first (relevance-ranked via scoreTitle — the filter-chip listing
// sorts through the same scorer), then the open paper (its notes, then its
// PDF text with
// highlighted, navigable matches), then other notes, reference links, and
// finally content hits across the rest of the library. Opening a library hit
// keeps the search "pinned": once the paper renders, the query is re-found
// with pdf.js and the match is highlighted and scrolled into view — positions
// come from the same engine that draws the page, so they are always exact.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { API, apiJson } from "./utils";
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, FolderIcon, LabelIcon, SearchIcon } from "./icons";

const DASH_CLASS = "\\-\\u2010-\\u2015";
const DIGIT_SEP_CLASS = ",\\u00A0\\u202F\\u2009";

// Query text → canonical searchable form (mirror of textnorm.normalize_text
// minus the line-break rule, which can't occur in a query box).
export function normalizeQuery(s) {
  return (s || "")
    .normalize("NFKC")
    .replace(/­/g, "")
    .replace(new RegExp(`(\\d)[${DIGIT_SEP_CLASS}](?=\\d)`, "g"), "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Query → RegExp (null = empty/invalid). Non-regex queries are fuzzy: digits
// tolerate grouping separators, spaces and hyphens are interchangeable.
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
        parts.push(c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
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
// ties. Titles are scanned linearly per keystroke — no index; `prep` caches
// the per-title lowering/tokenizing across keystrokes, and plain alphabetic
// terms match via indexOf instead of the regex, which keeps a scan of
// several thousand titles at a few ms (the heavy corpus, PDF text, is
// already indexed server-side in FTS5).
function scoreTitle(prep, phraseRe, terms, caseSensitive) {
  const title = prep.title;
  if (!title) return 0;
  const hay = caseSensitive ? title : prep.lower;
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
    if (!words) {
      const key = caseSensitive ? "wordsRaw" : "wordsLower";
      words = prep[key] || (prep[key] = [...hay.matchAll(/[\p{L}\p{N}]+/gu)]);
    }
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

export default function SearchPanel({
  open, onOpenChange,
  focusedBlockId, homeBlocks, allFolderPaths,
  openBlock, pendingBlockScrollRef,
  pdfSearchRef, scrollToRef, setPdfHidden, docNonce,
  onFindMarks, detailsDefault,
}) {
  const [query, setQuery] = useState("");
  const [labels, setLabels] = useState([]); // confirmed filter chips
  const [sugIdx, setSugIdx] = useState(0);
  const [noteHits, setNoteHits] = useState([]); // /api/block-search
  const [libHits, setLibHits] = useState([]);   // /api/pdf-search (FTS over all papers)
  const [libIndexing, setLibIndexing] = useState(0);
  const [pdfMatches, setPdfMatches] = useState([]); // pdf.js matches in the open document
  const [findIndex, setFindIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  // "Pinned" keeps the search live (and its PDF highlights visible) after the
  // popover closed because the user opened a library hit — so the match can
  // be highlighted in the paper it navigated to.
  const [pinned, setPinned] = useState(false);
  const pendingFindRef = useRef(null); // {page, sinceNonce} — jump here once the target doc renders

  const q = query.trim();

  useEffect(() => { if (open) setPinned(false); }, [open]);
  useEffect(() => { setSugIdx(0); }, [query]);
  useEffect(() => { setFindIndex(0); }, [pdfMatches]);

  // ---- filter chips (standard labels = exact match, folder labels = prefix)
  const chipOptions = useMemo(() => {
    const seen = new Map(); // kind:lowercase → option
    for (const b of homeBlocks) {
      for (const t of (b.properties?.category || "").split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!seen.has(`l:${t.toLowerCase()}`)) seen.set(`l:${t.toLowerCase()}`, { name: t, kind: "label" });
      }
    }
    for (const f of allFolderPaths) {
      if (!seen.has(`f:${f.toLowerCase()}`)) seen.set(`f:${f.toLowerCase()}`, { name: f, kind: "folder" });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [homeBlocks, allFolderPaths]);
  const suggestions = useMemo(() => {
    const qq = q.toLowerCase();
    if (!qq) return [];
    const picked = new Set(labels.map((l) => `${l.kind}:${l.name.toLowerCase()}`));
    return chipOptions.filter((o) => !picked.has(`${o.kind}:${o.name.toLowerCase()}`) && o.name.toLowerCase().includes(qq)).slice(0, 6);
  }, [q, chipOptions, labels]);
  function confirmLabel(opt) {
    setLabels((prev) => (prev.some((l) => l.kind === opt.kind && l.name.toLowerCase() === opt.name.toLowerCase()) ? prev : [...prev, opt]));
    setQuery("");
  }
  // Per-title preprocessing (lowered copy, lazily tokenized words), kept
  // across keystrokes — only a changed library invalidates it.
  const titlePrep = useMemo(() => {
    const cache = new Map();
    return (b) => {
      let p = cache.get(b.id);
      if (!p) {
        const t = b.content || "";
        p = { title: t, lower: t.toLowerCase() };
        cache.set(b.id, p);
      }
      return p;
    };
  }, [homeBlocks]);
  // Per-query title scorer, cached by block id (null when the query box is
  // empty or the regex is invalid). All title lists sort through this.
  const titleScoreOf = useMemo(() => {
    if (!q) return null;
    const phrase = buildSearchRegex(q, { caseSensitive, wholeWord });
    if (!phrase) return null;
    const dashRe = new RegExp(`[${DASH_CLASS}]`);
    const terms = normalizeQuery(q).split(/\s+/).filter(Boolean)
      .map((t) => ({
        re: buildSearchRegex(t, { caseSensitive, wholeWord }),
        text: caseSensitive ? t : t.toLowerCase(),
        // A term whose regex is just its literal chars can match via indexOf;
        // dashes, digit pairs, and the whole-word toggle need the regex.
        plain: !wholeWord && !dashRe.test(t) && !/\d\d/.test(t),
      }))
      .filter((t) => t.re);
    const cache = new Map();
    return (b) => {
      let s = cache.get(b.id);
      if (s === undefined) { s = scoreTitle(titlePrep(b), phrase, terms, caseSensitive); cache.set(b.id, s); }
      return s;
    };
  }, [q, caseSensitive, wholeWord, titlePrep]);
  const labelMatches = useMemo(() => {
    if (!labels.length) return [];
    const members = homeBlocks.filter((b) => {
      const cats = (b.properties?.category || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
      const folders = (b.properties?.folder || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
      return labels.every((c) => {
        const n = c.name.toLowerCase();
        return c.kind === "folder" ? folders.some((t) => t === n || t.startsWith(n + "/")) : cats.includes(n);
      });
    });
    // With a query typed, float its matches to the top of the folder/label
    // listing; ties (and everything at score 0) keep library order.
    if (titleScoreOf) members.sort((a, b) => titleScoreOf(b) - titleScoreOf(a));
    return members;
  }, [labels, homeBlocks, titleScoreOf]);
  // With chips active, text results only count inside the matching pages.
  const labelPageIds = useMemo(() => (
    labels.length ? new Set(labelMatches.map((b) => b.id)) : null
  ), [labels.length, labelMatches]);

  // ---- find navigation in the open PDF
  function gotoFind(i, list = pdfMatches) {
    if (!list.length) return;
    const idx = ((i % list.length) + list.length) % list.length;
    setFindIndex(idx);
    const m = list[idx];
    setPdfHidden(false);
    scrollToRef.current?.({
      position: {
        pageNumber: m.page,
        boundingRect: { ...m.rects[0], width: m.pageW, height: m.pageH, pageNumber: m.page },
        rects: [],
      },
    });
  }

  // Match highlights for the PDF viewer (multi-rect: a match spanning text
  // runs paints one box per run).
  const marks = useMemo(() => (
    q && (open || pinned)
      ? pdfMatches.flatMap((m, i) => m.rects.map((rect) => ({ page: m.page, rect, active: i === findIndex })))
      : []
  ), [pdfMatches, findIndex, open, pinned, q]);
  useEffect(() => { onFindMarks(marks); }, [marks, onFindMarks]);

  // ---- the search itself (debounced; re-runs when a new document renders so
  // pinned searches follow navigation)
  useEffect(() => {
    if (!q || !(open || pinned)) {
      setNoteHits([]); setLibHits([]); setLibIndexing(0); setPdfMatches([]); setBusy(false);
      return;
    }
    const timer = setTimeout(() => {
      setBusy(true);
      const flags = `&case=${caseSensitive ? 1 : 0}&whole=${wholeWord ? 1 : 0}`;
      const notesReq = apiJson(`${API}/block-search?q=${encodeURIComponent(q)}&limit=20${flags}`)
        .then((d) => setNoteHits(d.blocks || []))
        .catch(() => setNoteHits([]));
      // Full-text over every paper's PDF (server-side FTS index; normalized
      // word matching — the Aa/ab toggles only apply to notes and the
      // open document)
      const libReq = apiJson(`${API}/pdf-search?q=${encodeURIComponent(q)}&limit=15`)
        .then((d) => { setLibHits(d.results || []); setLibIndexing(d.indexing || 0); })
        .catch(() => { setLibHits([]); setLibIndexing(0); });
      let pdfReq = Promise.resolve();
      const re = pdfSearchRef.current ? buildSearchRegex(q, { caseSensitive, wholeWord }) : null;
      if (re) {
        pdfReq = pdfSearchRef.current(re).then(async (matches) => {
          // A library hit was opened: jump to its page's first match now that
          // the document is rendered and re-searched.
          const pending = pendingFindRef.current;
          if (pending && docNonce > pending.sinceNonce) {
            if (!matches.length) {
              // The library index matches words scattered across a page (AND
              // of terms), so the exact phrase may not exist anywhere — fall
              // back to highlighting the longest word of the query.
              const terms = q.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
              const re2 = terms.length > 1 && pdfSearchRef.current
                ? buildSearchRegex(terms[0], { caseSensitive, wholeWord, regex: false }) : null;
              if (re2) matches = (await pdfSearchRef.current(re2).catch(() => [])) || [];
            }
            if (matches.length) {
              pendingFindRef.current = null;
              const idx = matches.findIndex((m) => m.page === pending.page);
              gotoFind(idx >= 0 ? idx : 0, matches);
            }
          }
          setPdfMatches(matches);
        }).catch(() => setPdfMatches([]));
      } else {
        setPdfMatches([]);
      }
      Promise.allSettled([notesReq, libReq, pdfReq]).then(() => setBusy(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [q, open, pinned, caseSensitive, wholeWord, docNonce]);

  // Open a library content hit: pin the search, load the paper, and let the
  // re-run above land on the exact match (page-top scroll as a fallback while
  // the document is still loading or if the text can't be re-found).
  function openLibHit(r) {
    onOpenChange(false);
    setPinned(true);
    if (r.block_id === focusedBlockId) {
      const idx = pdfMatches.findIndex((m) => m.page === r.page);
      if (idx >= 0) gotoFind(idx);
      else scrollToRef.current?.({
        position: {
          pageNumber: r.page,
          boundingRect: { x1: 0, y1: 0, x2: 1, y2: 1, width: 1, height: 1, pageNumber: r.page },
          rects: [],
        },
      });
      return;
    }
    pendingFindRef.current = { page: r.page, sinceNonce: docNonce };
    openBlock(r.block_id).then(() => {
      let tries = 0;
      const go = () => {
        if (!pendingFindRef.current) return; // the exact-match jump already happened
        if (scrollToRef.current && document.querySelector("[data-page]")) {
          scrollToRef.current({
            position: {
              pageNumber: r.page,
              boundingRect: { x1: 0, y1: 0, x2: 1, y2: 1, width: 1, height: 1, pageNumber: r.page },
              rects: [],
            },
          });
        } else if (tries++ < 40) setTimeout(go, 200);
      };
      setTimeout(go, 600); // let the session-restore scroll settle first
    });
  }

  function openNoteHit(r) {
    onOpenChange(false);
    if (r.page_root_id && r.page_root_id !== r.id) pendingBlockScrollRef.current = r.id;
    openBlock(r.page_root_id || r.id);
  }

  // ---- result grouping: titles → this paper (notes, then PDF text) →
  // other notes → reference links → other papers' PDF content
  const inScope = (pageId) => !labelPageIds || labelPageIds.has(pageId);
  const titleMatches = titleScoreOf
    ? homeBlocks
      .filter((b) => inScope(b.id) && titleScoreOf(b) > 0)
      .sort((a, b) => titleScoreOf(b) - titleScoreOf(a))
      .slice(0, 8)
    : [];
  const titleIds = new Set(titleMatches.map((b) => b.id));
  const scopedNotes = noteHits.filter((r) => inScope(r.page_root_id || r.id) && !(r.kind === "page" && titleIds.has(r.id)));
  const inPage = (r) => focusedBlockId && (r.page_root_id === focusedBlockId || r.id === focusedBlockId);
  const titlesExtra = scopedNotes.filter((r) => r.kind === "page"); // regex-mode / non-home pages
  const notesHere = scopedNotes.filter((r) => r.kind !== "page" && inPage(r));
  const notesElsewhere = scopedNotes.filter((r) => r.kind === "note" || r.kind === "highlight").filter((r) => !inPage(r));
  const linkHits = scopedNotes.filter((r) => r.kind === "link" && !inPage(r));
  const libElsewhere = libHits.filter((r) => r.block_id !== focusedBlockId && inScope(r.block_id));
  const showPdfMatches = inScope(focusedBlockId);
  const anything = titleMatches.length || titlesExtra.length || notesHere.length || notesElsewhere.length
    || linkHits.length || labelMatches.length || (showPdfMatches && pdfMatches.length) || libElsewhere.length;

  // One switch for the whole detail area (all the result lists). Its default
  // comes from Settings → Search via the detailsDefault prop (App owns the
  // per-place preference: home expanded unless turned off — with no open PDF
  // a compact find bar shows nothing — paper view compact unless turned on).
  // Re-applied each time the panel opens; the toggle button then only affects
  // the current panel session.
  const [showDetails, setShowDetails] = useState(detailsDefault);
  useEffect(() => { if (open) setShowDetails(detailsDefault); }, [open]);

  const kindBadge = (r) => (
    r.kind === "highlight" ? <span className="searchKindBadge">highlight</span>
      : r.kind === "link" ? <span className="searchKindBadge">link</span> : null
  );
  const noteRow = (r) => (
    <button key={r.id} className="searchResult" onClick={() => openNoteHit(r)}>
      <span className="searchResultPage">{r.page_title || "Untitled"}{kindBadge(r)}</span>
      <span className="searchResultText">{r.content}</span>
    </button>
  );
  const titleRow = (b, subtitle) => (
    <button
      key={`title-${b.id}`}
      className="searchResult"
      onClick={() => { onOpenChange(false); openBlock(b.id, { restoreScroll: true }); }}
    >
      <span className="searchResultPage">{b.content || "Untitled"}</span>
      <span className="searchResultText">{subtitle || ""}</span>
    </button>
  );

  return (
    <span data-popover="search" style={{ position: "relative", display: "inline-flex" }}>
      <button
        className={`iconBtn ${open ? "activeIcon" : ""}`}
        onClick={() => onOpenChange(!open)}
        title="Search everything (Ctrl+F)"
        aria-label="Search"
      >
        <SearchIcon size={16} />
      </button>
      {open ? (
        <div className="popover searchPopover">
          <div className="searchRow">
            <button
              className={`searchToggle ${showDetails ? "on" : ""}`}
              onClick={() => setShowDetails((v) => !v)}
              title={showDetails
                ? "Collapse result details (compact find — the default is in Settings → Search)"
                : "Expand result details: titles, notes, and other papers"}
              aria-label="Toggle result details"
            >
              {showDetails
                ? <ChevronDownIcon size={12} strokeWidth={2.4} />
                : <ChevronRightIcon size={12} strokeWidth={2.4} />}
            </button>
            <div className="searchInputWrap">
              {labels.map((l) => (
                <span key={`${l.kind}:${l.name}`} className="categoryBadge searchChip">
                  {l.kind === "folder" ? <FolderIcon size={11} /> : <LabelIcon size={11} />}
                  {l.name}
                  <button
                    className="uiClose uiCloseSm searchChipX"
                    title={`Remove ${l.kind === "folder" ? "folder" : "label"} filter "${l.name}"`}
                    onClick={() => setLabels((prev) => prev.filter((x) => x !== l))}
                  >×</button>
                </span>
              ))}
              <input
                autoFocus
                className="searchInput"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPinned(false); pendingFindRef.current = null; }}
                onKeyDown={(e) => {
                  if ((e.key === "Tab" || e.key === "Enter") && suggestions.length) {
                    e.preventDefault();
                    confirmLabel(suggestions[sugIdx] || suggestions[0]);
                  } else if (e.key === "Enter" && pdfMatches.length) {
                    e.preventDefault();
                    gotoFind(findIndex + (e.shiftKey ? -1 : 1));
                  } else if (e.key === "ArrowDown" && suggestions.length) {
                    e.preventDefault();
                    setSugIdx((i) => (i + 1) % suggestions.length);
                  } else if (e.key === "ArrowUp" && suggestions.length) {
                    e.preventDefault();
                    setSugIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
                  } else if (e.key === "Backspace" && !query && labels.length) {
                    setLabels((prev) => prev.slice(0, -1));
                  }
                }}
                placeholder={labels.length ? "Search within labeled pages…" : "Search titles, notes, and PDF text — Tab adds a label filter"}
              />
              {suggestions.length ? (
                <div className="categorySuggestions searchLabelSuggest">
                  {suggestions.map((s, i) => (
                    <button
                      key={`${s.kind}:${s.name}`}
                      className={`categorySuggestionItem${i === sugIdx ? " selected" : ""}`}
                      onMouseDown={(e) => { e.preventDefault(); confirmLabel(s); }}
                      onMouseEnter={() => setSugIdx(i)}
                    >
                      <span className="searchSuggestName">
                        {s.kind === "folder" ? <FolderIcon size={12} /> : <LabelIcon size={12} />}
                        {s.name}
                      </span>
                      <span className="searchSuggestHint">Tab</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {showPdfMatches && pdfMatches.length ? (
              <span className="searchNavGroup">
                <span className="searchFindCount" title="Matches in the open PDF">{findIndex + 1}/{pdfMatches.length}</span>
                <button className="searchToggle searchNavBtn" onClick={() => gotoFind(findIndex - 1)} title="Previous match (matches are highlighted in the PDF)">
                  <ChevronUpIcon size={14} />
                </button>
                <button className="searchToggle searchNavBtn" onClick={() => gotoFind(findIndex + 1)} title="Next match (Enter)">
                  <ChevronDownIcon size={14} />
                </button>
              </span>
            ) : null}
            <button className={`searchToggle ${caseSensitive ? "on" : ""}`} onClick={() => setCaseSensitive((v) => !v)} title="Match case">Aa</button>
            <button className={`searchToggle ${wholeWord ? "on" : ""}`} onClick={() => setWholeWord((v) => !v)} title="Match whole word"><u>ab</u></button>
          </div>
          <div className="searchResults">
            {busy ? <div className="searchHint">Searching…</div> : null}
            {!busy && q && !anything ? <div className="searchHint">No matches.</div> : null}
            {showDetails ? (
              <>
                {labels.length ? (
                  <>
                    <div className="searchSection">Filters: {labels.map((c) => c.name).join(" + ")}</div>
                    {labelMatches.length === 0 ? (
                      <div className="searchHint">No pages carry {labels.length === 1 ? "this label" : "all these labels"}.</div>
                    ) : labelMatches.map((b) => titleRow(b, b.properties?.category || b.properties?.folder || ""))}
                  </>
                ) : null}
                {titleMatches.length || titlesExtra.length ? <div className="searchSection">Titles</div> : null}
                {titleMatches.map((b) => titleRow(b, [b.properties?.category, b.properties?.folder].filter(Boolean).join(", ")))}
                {titlesExtra.map(noteRow)}
                {notesHere.length ? <div className="searchSection">Notes in this paper</div> : null}
                {notesHere.map(noteRow)}
                {showPdfMatches && pdfMatches.length ? <div className="searchSection">This PDF</div> : null}
                {(showPdfMatches ? pdfMatches : []).map((m, i) => (
                  <button
                    key={`pdf-${i}`}
                    className={`searchResult ${i === findIndex ? "active" : ""}`}
                    onClick={() => gotoFind(i)}
                  >
                    <span className="searchResultPage">p. {m.page}</span>
                    <span className="searchResultText">…{m.snippet}…</span>
                  </button>
                ))}
                {notesElsewhere.length ? <div className="searchSection">{focusedBlockId ? "Other notes" : "Notes"}</div> : null}
                {notesElsewhere.map(noteRow)}
                {linkHits.length ? <div className="searchSection">Reference links</div> : null}
                {linkHits.map(noteRow)}
                {libElsewhere.length || libIndexing ? (
                  <div className="searchSection">{focusedBlockId ? "Other papers" : "Library PDFs"}</div>
                ) : null}
                {libIndexing ? (
                  <div className="searchHint">Indexing {libIndexing} paper{libIndexing === 1 ? "" : "s"} in the background — results will fill in shortly.</div>
                ) : null}
                {libElsewhere.map((r, i) => (
                  <button
                    key={`lib-${i}`}
                    className="searchResult"
                    onClick={() => openLibHit(r)}
                    title={`Open "${r.title}" at page ${r.page} — the match will be highlighted`}
                  >
                    <span className="searchResultPage">{r.title.slice(0, 60)} · p. {r.page}</span>
                    <span className="searchResultText">…{r.snippet}…</span>
                  </button>
                ))}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </span>
  );
}
