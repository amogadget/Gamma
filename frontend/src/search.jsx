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
// titles first, then the open paper (its notes, then its PDF text with
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

export default function SearchPanel({
  open, onOpenChange,
  focusedBlockId, homeBlocks, allFolderPaths,
  openBlock, pendingBlockScrollRef,
  pdfSearchRef, scrollToRef, setPdfHidden, docNonce,
  onFindMarks,
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
  const opts = { caseSensitive, wholeWord };

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
  const labelMatches = useMemo(() => {
    if (!labels.length) return [];
    return homeBlocks.filter((b) => {
      const cats = (b.properties?.category || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
      const folders = (b.properties?.folder || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
      return labels.every((c) => {
        const n = c.name.toLowerCase();
        return c.kind === "folder" ? folders.some((t) => t === n || t.startsWith(n + "/")) : cats.includes(n);
      });
    });
  }, [labels, homeBlocks]);
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
  const titleRe = q ? buildSearchRegex(q, { ...opts }) : null;
  const titleTest = titleRe ? new RegExp(titleRe.source, caseSensitive ? "" : "i") : null;
  const titleMatches = titleTest
    ? homeBlocks.filter((b) => inScope(b.id) && titleTest.test(b.content || "")).slice(0, 8)
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
  // comes from Settings → Search (localStorage "gamma-search-details",
  // collapsed unless set) and is re-read each time the panel opens; the
  // toggle button then only affects the current panel session.
  const detailsDefault = () => {
    try { return localStorage.getItem("gamma-search-details") === "1"; } catch { return false; }
  };
  const [showDetails, setShowDetails] = useState(detailsDefault);
  useEffect(() => { if (open) setShowDetails(detailsDefault()); }, [open]);

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
